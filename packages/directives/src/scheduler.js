// @ts-check
/**
 * 调度器 —— 自主指令的执行侧。**这个文件是整套系统里最危险的一块。**
 *
 * ## 一轮 `runOnce()` 的完整链路（顺序不能换）
 *
 * ```
 *   ① 读闸门（零写入）
 *      workspace.isPaused()                 → 暂停中？  → { skipped:'global_paused' }
 *      workspace.isEnabled('autonomy.enabled') → 没开？    → { skipped:'autonomy_disabled' }
 *      autonomy.max_level                     → 解析不出/只有 L0 → { skipped:... }
 *        │  任何一项不满足：**不写一行、不写 step、不写审计、不发事件**
 *        ▼
 *   ② 回收僵尸 run（租约已过期的 running）→ 标 timeout，指令回 queued / blocked
 *   ③ 认领一条 eligible 指令（同一个事务里）
 *      queued→running 的 CAS 更新 + 建 directive_runs（带 lease_until）+ 审计
 *        │  抢不到（status 已经不是 queued）→ 放弃，不重试
 *        ▼
 *   ④ 逐动作执行（每个动作前**重新**读闸门与预算）
 *      写 directive_steps（plan / tool / error / stop 四类）+ 扣步数与 token 预算
 *        │  hook 在事务**外**跑：事务里做 IO 会拉长写锁，而且回滚救不了已发生的副作用
 *        ▼
 *   ⑤ 收尾（同一个事务）
 *      run 终态 + 指令状态迁移（+ 审计）+ 结果摘要
 * ```
 *
 * ## 四道停止闸门（每一道都必须能单独拦住）
 *
 * | 闸门 | 判据 | 触发后的指令状态 |
 * |---|---|---|
 * | 全局暂停 / 自主关闭 | `paused='1'` 或 `autonomy.enabled!='1'` | `paused` |
 * | 等级不足 | 指令 `permission_scope` > `autonomy.max_level` | `blocked` |
 * | 预算/时间 | 步数、token、秒数任一用尽 | `blocked` |
 * | 过期 | `valid_until <= now` | `failed` |
 *
 * 除此之外还有一层**执行前复检**：每个动作执行前用 `canExecute()` 再过一遍
 * 「等级 + 动作是否在白名单 + 指令是否声明了它」。即使数据库行被人手工改坏
 * （比如直接 UPDATE 把 `allowed_tools_json` 写成 `["shell"]`），动作也跑不起来。
 *
 * ## 重启安全（为什么必须有租约）
 *
 * 进程在 `running` 中途死掉时，库里会留下一条 `status='running'` 的 run 和一条
 * `status='running'` 的指令。没有租约的话，重启后有两种坏结局：要么永远卡住，
 * 要么被第二个人"接着跑"——而第一轮的副作用可能已经发生了一半。
 *
 * 租约的处理是：
 * 1. 认领时写 `lease_until = now + leaseMs`（毫秒 REAL 列，做算术不用转 ISO）；
 * 2. 每写一步都续租（心跳）；
 * 3. 回收时只收**租约已过期**的：`status='running' AND lease_until < now`；
 * 4. 每次写库前都复检 `lease_owner = 我 AND lease_until > now`，不满足就**放弃写入**
 *    （宁可少写一条流水，也不许两个 owner 同时往同一条 run 上写）。
 *
 * ## 刻意不做的事
 *
 * - **不 sleep、不轮询、不自己起定时器**：一轮就是一轮，谁调它由宿主决定
 *   （否则"停止"就变成了"等它自己停"）。
 * - **不在事务里调用 hook**：hook 可能写文件/读库，包在事务里会拉长写锁。
 * - **不自动提高等级、不自动批准、不自动放宽预算**：卡住就卡住，等人改。
 */

import {
  SKIP_REASONS,
  STOP_REASONS,
  STOP_OUTCOMES,
} from './scheduler-constants.js';
import { DirectivesArgumentError } from './errors.js';
import { clampInt, createSimpleTxApi, isoOf, newId, nowMsOf, safePublish, writeThrough } from './util.js';
import { DEFAULT_MAX_LEVEL, LEVELS, canExecute, levelRank } from './permissions.js';

export { SKIP_REASONS, STOP_REASONS, STOP_OUTCOMES };

/** 默认租约 60 秒：够一轮正常执行，又不至于让崩溃后的僵尸 run 卡太久。 */
export const DEFAULT_LEASE_MS = 60_000;

/** 一轮最多跑多少个动作步骤（硬上限，防"计划写得太长"把一轮拖成马拉松）。 */
export const MAX_STEPS_PER_RUN = 20;
export const DEFAULT_STEPS_PER_RUN = 10;

/**
 * 造调度器。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   workspace?: Record<string, any> | null,
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   scopeId: string,
 *   store: Record<string, any>,
 *   stateMachine: Record<string, any>,
 *   actions: Record<string, any>,
 *   leaseMs?: number,
 * }} options
 */
export function createScheduler(options) {
  const { db, queue, clock, store, stateMachine, actions } = options;
  const scopeId = String(options.scopeId);
  const workspace = options.workspace ?? null;
  const alert = options.alert ?? (() => {});
  const leaseMs = clampInt(options.leaseMs, 1_000, 24 * 60 * 60 * 1000, DEFAULT_LEASE_MS);
  const reader = createSimpleTxApi(db);

  /**
   * 读闸门。**纯读、绝不写**（这是"暂停时零副作用"的实现基础）。
   *
   * 每个读取都失败关：
   * - 没有 workspace → 不放行（不是"假设允许"）；
   * - `isEnabled` 返回非 true → 不放行；
   * - `autonomy.max_level` 读不到（null，例如键被删了）→ 按默认 L1（与迁移默认一致，
   *   与 lead 的 workspace 契约一致）；读到不认识的字符串 → 拒绝（不猜）。
   *
   * @returns {{ ok: boolean, reason: string, maxLevel: string | null, detail?: Record<string, unknown> }}
   */
  function readGate() {
    if (workspace === null || workspace === undefined) {
      return { ok: false, reason: SKIP_REASONS.WORKSPACE_MISSING, maxLevel: null };
    }
    if (typeof workspace.isPaused !== 'function' || typeof workspace.isEnabled !== 'function' || typeof workspace.getSwitch !== 'function') {
      return { ok: false, reason: SKIP_REASONS.WORKSPACE_INCOMPLETE, maxLevel: null };
    }
    // 顺序有意义：暂停优先于一切（主人按下停止后，不该再有任何判断发生）。
    if (workspace.isPaused()) {
      return { ok: false, reason: SKIP_REASONS.GLOBAL_PAUSED, maxLevel: null };
    }
    if (!workspace.isEnabled('autonomy.enabled')) {
      return { ok: false, reason: SKIP_REASONS.AUTONOMY_DISABLED, maxLevel: null };
    }
    const raw = workspace.getSwitch('autonomy.max_level');
    const level = raw === null || raw === undefined || String(raw).trim() === ''
      ? DEFAULT_MAX_LEVEL
      : String(raw).trim().toUpperCase();
    if (!Object.hasOwn(LEVELS, level)) {
      return {
        ok: false,
        reason: SKIP_REASONS.MAX_LEVEL_INVALID,
        maxLevel: null,
        detail: { raw: raw === null || raw === undefined ? null : String(raw) },
      };
    }
    if (LEVELS[level].rank <= LEVELS.L0.rank) {
      return { ok: false, reason: SKIP_REASONS.MAX_LEVEL_TOO_LOW, maxLevel: level };
    }
    return { ok: true, reason: 'ok', maxLevel: level };
  }

  /**
   * 回收僵尸 run（租约过期仍处于 running 的）。
   *
   * 为什么先回收再认领：不回收的话，那些 run 对应的指令会一直停在 `running`，
   * 永远不会再被 `nextEligible` 看到——看起来"什么都没发生"，其实队列已经死了。
   *
   * 回收后的去向（与验收口径一致）：
   * - 失败/超时次数还没超 `max_retries` → 指令回 `queued`（可重试）；
   * - 超了 → 指令进 `blocked`（"现在做不了"，需要人看一眼）。
   *
   * @param {{ now?: any, limit?: number }} [opts]
   * @returns {Promise<{ recovered: number, items: Array<Record<string, any>> }>}
   */
  async function recoverStaleRuns(opts = {}) {
    const nowMs = nowMsOf(opts.now, clock);
    const limit = clampInt(opts.limit, 1, 200, 50);

    /** @type {Array<Record<string, any>>} */
    const candidates = reader.all(
      `SELECT * FROM directive_runs
        WHERE scope_id = ? AND status = 'running'
          AND (lease_until IS NULL OR lease_until <= ?)
        ORDER BY COALESCE(lease_until, 0) ASC, started_at ASC LIMIT ?`,
      [scopeId, nowMs, limit],
    );
    if (candidates.length === 0) return { recovered: 0, items: [] };

    /** @type {Array<Record<string, any>>} */
    const items = [];
    for (const candidate of candidates) {
      const outcome = await writeThrough(queue, (tx) => {
        // 事务内重新确认（read 到 write 之间时钟可能前进，也可能被别的 owner 收过了）
        const runRow = /** @type {Record<string, any> | undefined} */ (
          tx.get('SELECT * FROM directive_runs WHERE id = ? AND scope_id = ?', [String(candidate.id), scopeId])
        );
        if (runRow === undefined || String(runRow.status) !== 'running') return null;
        if (runRow.lease_until !== null && runRow.lease_until !== undefined && Number(runRow.lease_until) > nowMs) {
          return null; // 租约还有效：**不许抢**（这就是"同指令在租约期内不得被第二个 owner 抢"）
        }
        const stamp = clock.stamp();
        const previousOwner = runRow.lease_owner === null || runRow.lease_owner === undefined ? null : String(runRow.lease_owner);

        tx.run(
          `UPDATE directive_runs
              SET status = 'timeout', stop_reason = ?, finished_at = ?
            WHERE id = ? AND status = 'running'`,
          [STOP_REASONS.LEASE_EXPIRED, stamp.utc, String(runRow.id)],
        );

        const directiveRow = /** @type {Record<string, any> | undefined} */ (
          tx.get('SELECT * FROM directives WHERE id = ? AND scope_id = ?', [String(runRow.directive_id), scopeId])
        );
        let directiveStatus = null;
        if (directiveRow !== undefined && String(directiveRow.status) === 'running') {
          const failures = Number(
            tx.get(
              `SELECT COUNT(*) AS n FROM directive_runs
                WHERE directive_id = ? AND status IN ('failed', 'timeout')`,
              [String(runRow.directive_id)],
            )?.n ?? 0,
          );
          const maxRetries = Number(directiveRow.max_retries ?? 0);
          try {
            stateMachine.applyTransition(tx, {
              row: directiveRow,
              to: 'blocked',
              reason: STOP_REASONS.LEASE_EXPIRED,
              by: 'recovery',
            });
            if (failures <= maxRetries) {
              stateMachine.applyTransition(tx, {
                row: directiveRow,
                to: 'queued',
                reason: 'requeued_after_lease_expired',
                by: 'recovery',
              });
            }
            directiveStatus = String(directiveRow.status);
          } catch (err) {
            // 指令状态被人手工改过（不在 running）→ 只回收 run，不替人改指令状态。
            directiveStatus = String(directiveRow.status);
            alert({
              kind: 'directive_recovery_transition_skipped',
              message: `回收僵尸 run 时跳过指令状态迁移：${err instanceof Error ? err.message : String(err)}`,
              detail: { runId: String(runRow.id), directiveId: String(runRow.directive_id) },
            });
          }
        }

        tx.run(
          `INSERT INTO audit_logs (
             audit_id, ts, ts_local, actor, action, target_kind, target_id, scope_id,
             result, detail, trace_id, deletion_epoch
           ) VALUES (?, ?, ?, 'recovery', 'directive.run.recovered', 'directive', ?, ?, 'ok', ?, NULL, NULL)`,
          [
            newId('aud'),
            stamp.utc,
            stamp.local,
            String(runRow.directive_id),
            scopeId,
            JSON.stringify({
              run_id: String(runRow.id),
              attempt: Number(runRow.attempt ?? 1),
              previous_owner: previousOwner,
              lease_until: runRow.lease_until === null || runRow.lease_until === undefined ? null : Number(runRow.lease_until),
              directive_status: directiveStatus,
            }),
          ],
        );

        return {
          runId: String(runRow.id),
          directiveId: String(runRow.directive_id),
          previousOwner,
          directiveStatus,
        };
      },
      { label: 'directives.recoverStaleRun' },
    );
    if (outcome !== null) items.push(outcome);
  }

  if (items.length > 0) {
    alert({
      kind: 'directive_runs_recovered',
      message: `回收了 ${items.length} 条租约过期的 running run（进程重启 / 崩溃后的清理）`,
      detail: { count: items.length, runIds: items.map((item) => item.runId).slice(0, 20) },
      });
    }
    return { recovered: items.length, items };
  }

  /**
   * 把**已过期**的指令作废（`valid_until <= now`）。
   *
   * 为什么必须有这一步：`nextEligible` 只挑"没过期"的，所以过期指令会永远停在
   * `queued`——列表上看还在排队，实际永远轮不到，那就是一条僵尸指令。
   *
   * 去向是 `cancelled`（终态）而不是 `failed`：过期不是"做错了"，是"没赶上"；
   * 而且 `queued → failed` 本来也不在合法转移表里。
   *
   * @param {{ now?: any, limit?: number }} [opts]
   * @returns {Promise<{ expired: number, ids: string[] }>}
   */
  async function expireStaleDirectives(opts = {}) {
    const nowMs = nowMsOf(opts.now, clock);
    const limit = clampInt(opts.limit, 1, 200, 50);
    const rows = reader.all(
      `SELECT * FROM directives
        WHERE scope_id = ? AND status IN ('proposed', 'awaiting_approval', 'queued')
          AND valid_until IS NOT NULL AND valid_until <= ?
        ORDER BY valid_until ASC LIMIT ?`,
      [scopeId, isoOf(nowMs), limit],
    );
    /** @type {string[]} */
    const ids = [];
    for (const row of rows) {
      const done = await writeThrough(
        queue,
        (tx) => {
          const fresh = store.readRow(String(row.id), { tx });
          if (fresh === undefined) return null;
          const status = String(fresh.status);
          if (!['proposed', 'awaiting_approval', 'queued'].includes(status)) return null;
          if (fresh.valid_until === null || fresh.valid_until === undefined) return null;
          if (Date.parse(String(fresh.valid_until)) > nowMs) return null;
          stateMachine.applyTransition(tx, {
            row: fresh,
            to: 'cancelled',
            reason: STOP_REASONS.VALID_UNTIL_PASSED,
            by: 'scheduler',
          });
          return { id: String(fresh.id) };
        },
        { label: 'directives.expireStale' },
      );
      if (done !== null && done !== undefined) ids.push(done.id);
    }
    return { expired: ids.length, ids };
  }

  /**
   * 认领下一条可执行指令（一个事务：CAS 改状态 + 建 run + 审计）。
   *
   * @param {{ owner?: string, now?: any, maxLevel?: string | null }} [opts]
   * @returns {Promise<{ claimed: boolean, reason?: string, claim?: Record<string, any>, rejected?: Array<Record<string, any>> }>}
   */
  async function claimNext(opts = {}) {
    const owner = String(opts.owner ?? 'scheduler');
    const nowMs = nowMsOf(opts.now, clock);
    const gate = opts.maxLevel === undefined || opts.maxLevel === null ? readGate() : { ok: true, maxLevel: String(opts.maxLevel) };
    if (!gate.ok) return { claimed: false, reason: gate.reason };

    return writeThrough(queue, (tx) => {
      const picked = store.nextEligibleIn(tx, { limit: 1, nowMs, maxLevel: gate.maxLevel });
      if (picked.items.length === 0) {
        const first = picked.rejected[0];
        return {
          claimed: /** @type {const} */ (false),
          reason: first === undefined ? SKIP_REASONS.QUEUE_EMPTY : String(first.reason),
          rejected: picked.rejected,
        };
      }
      const directiveRow = store.readRow(picked.items[0].id, { tx });
      if (directiveRow === undefined || String(directiveRow.status) !== 'queued') {
        // 极少数情况：读出来之后它已经不在 queued 了（另一个 owner 抢先）。
        return { claimed: /** @type {const} */ (false), reason: SKIP_REASONS.CLAIM_RACE_LOST };
      }

      const stamp = clock.stamp();
      // 状态迁移 + 审计（applyTransition 内部是 CAS：status 必须仍是 queued）
      stateMachine.applyTransition(tx, {
        row: directiveRow,
        to: 'running',
        reason: 'claimed',
        by: owner,
      });

      const attemptRow = tx.get('SELECT COALESCE(MAX(attempt), 0) AS n FROM directive_runs WHERE directive_id = ?', [
        String(directiveRow.id),
      ]);
      const attempt = Number(attemptRow?.n ?? 0) + 1;
      const runId = newId('run');
      tx.run(
        `INSERT INTO directive_runs (
           id, directive_id, scope_id, attempt, status, lease_owner, lease_until, heartbeat_at,
           started_at, started_at_local, finished_at, steps_used, tokens_used, stop_reason, error, result_json
         ) VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, NULL, 0, 0, NULL, NULL, '{}')`,
        [runId, String(directiveRow.id), scopeId, attempt, owner, nowMs + leaseMs, nowMs, stamp.utc, stamp.local],
      );
      tx.run(
        `UPDATE directives
            SET attempts = attempts + 1, last_error = NULL, updated_at = ?, updated_at_local = ?
          WHERE id = ? AND scope_id = ?`,
        [stamp.utc, stamp.local, String(directiveRow.id), scopeId],
      );
      tx.run(
        `INSERT INTO audit_logs (
           audit_id, ts, ts_local, actor, action, target_kind, target_id, scope_id,
           result, detail, trace_id, deletion_epoch
         ) VALUES (?, ?, ?, ?, 'directive.run.claimed', 'directive', ?, ?, 'ok', ?, NULL, NULL)`,
        [
          newId('aud'),
          stamp.utc,
          stamp.local,
          owner,
          String(directiveRow.id),
          scopeId,
          JSON.stringify({
            run_id: runId,
            attempt,
            lease_ms: leaseMs,
            lease_until: nowMs + leaseMs,
            permission_scope: String(directiveRow.permission_scope),
            effective_level: gate.maxLevel,
          }),
        ],
      );

      const freshRow = store.readRow(String(directiveRow.id), { tx });
      return {
        claimed: /** @type {const} */ (true),
        claim: {
          owner,
          runId,
          attempt,
          run: {
            id: runId,
            directiveId: String(directiveRow.id),
            attempt,
            leaseOwner: owner,
            leaseUntil: nowMs + leaseMs,
            startedAt: stamp.utc,
            stepsUsed: 0,
            tokensUsed: 0,
          },
          directive: store.rowToDirective(/** @type {any} */ (freshRow)),
          maxLevel: gate.maxLevel,
        },
      };
    },
    { label: 'directives.claim' },
  );
}

  /**
   * 续租（心跳）。长任务应当在 hook 内部按需调用；调度器每写一步也会自动续。
   *
   * @param {{ runId: string, owner: string, now?: any }} input
   * @returns {Promise<{ ok: boolean, reason?: string, leaseUntil?: number }>}
   */
  async function heartbeat(input) {
    const runId = String(input?.runId ?? '');
    const owner = String(input?.owner ?? '');
    if (runId.length === 0 || owner.length === 0) {
      throw new DirectivesArgumentError('heartbeat 需要 runId 与 owner', { reason: 'invalid_heartbeat_input' });
    }
    const nowMs = nowMsOf(input.now, clock);
    return writeThrough(
      queue,
      (tx) => {
        const row = /** @type {Record<string, any> | undefined} */ (
          tx.get('SELECT * FROM directive_runs WHERE id = ? AND scope_id = ?', [runId, scopeId])
        );
        if (row === undefined) return { ok: /** @type {const} */ (false), reason: 'run_missing' };
        if (String(row.status) !== 'running') return { ok: /** @type {const} */ (false), reason: `run_${String(row.status)}` };
        if (String(row.lease_owner ?? '') !== owner) return { ok: /** @type {const} */ (false), reason: 'lease_owner_mismatch' };
        if (Number(row.lease_until ?? 0) <= nowMs) return { ok: /** @type {const} */ (false), reason: 'lease_expired' };
        const leaseUntil = nowMs + leaseMs;
        tx.run('UPDATE directive_runs SET heartbeat_at = ?, lease_until = ? WHERE id = ?', [nowMs, leaseUntil, runId]);
        return { ok: /** @type {const} */ (true), leaseUntil };
      },
      { label: 'directives.heartbeat' },
    );
  }

  /**
   * 写一条步骤流水（并在同一个事务里扣预算 + 续租）。
   *
   * 复检三类前置条件，任一不满足 → `{ aborted }`，**这一步不写、预算不扣**：
   * run 仍属我 + run 仍是 running + 租约未过期。
   *
   * @param {Record<string, any>} claim
   * @param {{
   *   kind: 'plan' | 'tool' | 'decision' | 'note' | 'error' | 'stop',
   *   summary: string,
   *   ok: 0 | 1 | null,
   *   evidence?: Record<string, unknown>,
   *   tokens?: number,
   *   countBudget?: boolean,
   *   durationMs?: number | null,
   *   now?: any,
   * }} step
   * @returns {Promise<{ ok: boolean, seq?: number, aborted?: string }>}
   */
  async function appendStep(claim, step) {
    const nowMs = nowMsOf(step.now, clock);
    const tokens = clampInt(step.tokens, 0, 10_000_000, 0);
    return writeThrough(
      queue,
      (tx) => {
        const runRow = /** @type {Record<string, any> | undefined} */ (
          tx.get('SELECT * FROM directive_runs WHERE id = ? AND scope_id = ?', [String(claim.runId), scopeId])
        );
        if (runRow === undefined) return { ok: /** @type {const} */ (false), aborted: 'run_missing' };
        if (String(runRow.status) !== 'running') return { ok: /** @type {const} */ (false), aborted: `run_${String(runRow.status)}` };
        if (String(runRow.lease_owner ?? '') !== String(claim.owner)) {
          return { ok: /** @type {const} */ (false), aborted: 'lease_owner_mismatch' };
        }
        if (Number(runRow.lease_until ?? 0) <= nowMs) {
          return { ok: /** @type {const} */ (false), aborted: 'lease_expired' };
        }

        const stamp = clock.stamp();
        const seq = Number(
          tx.get('SELECT COALESCE(MAX(seq), 0) AS n FROM directive_steps WHERE run_id = ?', [String(claim.runId)])?.n ?? 0,
        ) + 1;
        tx.run(
          `INSERT INTO directive_steps (
             id, run_id, scope_id, seq, at, at_local, kind, summary, evidence_json, ok, duration_ms,
             created_at, created_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            newId('stp'),
            String(claim.runId),
            scopeId,
            seq,
            stamp.utc,
            stamp.local,
            String(step.kind),
            String(step.summary).slice(0, 1000),
            JSON.stringify(step.evidence ?? {}),
            step.ok === undefined ? null : step.ok,
            step.durationMs === undefined || step.durationMs === null ? null : Math.trunc(step.durationMs),
            stamp.utc,
            stamp.local,
          ],
        );

        if (step.countBudget === true) {
          tx.run(
            `UPDATE directive_runs
                SET steps_used = steps_used + 1, tokens_used = tokens_used + ?, heartbeat_at = ?, lease_until = ?
              WHERE id = ?`,
            [tokens, nowMs, nowMs + leaseMs, String(claim.runId)],
          );
          tx.run(
            `UPDATE directives
                SET steps_used = steps_used + 1, tokens_used = tokens_used + ?, updated_at = ?, updated_at_local = ?
              WHERE id = ? AND scope_id = ?`,
            [tokens, stamp.utc, stamp.local, String(claim.directive.id), scopeId],
          );
        } else {
          tx.run('UPDATE directive_runs SET heartbeat_at = ?, lease_until = ? WHERE id = ?', [nowMs, nowMs + leaseMs, String(claim.runId)]);
        }

        return { ok: /** @type {const} */ (true), seq };
      },
      { label: 'directives.appendStep' },
    );
  }

  /**
   * 每个动作执行前的复检。**顺序即优先级**：先看主人叫停，再看预算，再看权限。
   *
   * @param {{
   *   directive: Record<string, any>,
   *   nowMs: number,
   *   startedAtMs: number,
   *   timeBudgetMs: number,
   *   actionName: string,
   *   plan: string[],
   * }} input
   * @returns {{ ok: boolean, reason?: string, detail?: Record<string, unknown>, maxLevel?: string | null }}
   */
  function preStepChecks(input) {
    const gate = readGate();
    if (!gate.ok) {
      const mapped =
        gate.reason === SKIP_REASONS.GLOBAL_PAUSED || gate.reason === SKIP_REASONS.AUTONOMY_DISABLED
          ? STOP_REASONS.OWNER_INTERRUPTED
          : gate.reason === SKIP_REASONS.WORKSPACE_MISSING || gate.reason === SKIP_REASONS.WORKSPACE_INCOMPLETE
            ? STOP_REASONS.WORKSPACE_MISSING
            : STOP_REASONS.MISSING_REQUIRED_PERMISSION;
      return { ok: false, reason: mapped, detail: { gate: gate.reason }, maxLevel: null };
    }
    const maxLevel = gate.maxLevel;
    if (maxLevel === null || levelRank(maxLevel) < levelRank(input.directive.permissionScope)) {
      return {
        ok: false,
        reason: STOP_REASONS.MISSING_REQUIRED_PERMISSION,
        detail: { required: input.directive.permissionScope, maxLevel },
        maxLevel,
      };
    }
    if (input.directive.validUntil !== null && Date.parse(input.directive.validUntil) <= input.nowMs) {
      return { ok: false, reason: STOP_REASONS.VALID_UNTIL_PASSED, detail: { validUntil: input.directive.validUntil }, maxLevel };
    }
    if (input.directive.remaining.steps <= 0) {
      return {
        ok: false,
        reason: STOP_REASONS.BUDGET_EXHAUSTED,
        detail: { budget: 'steps', used: input.directive.stepsUsed, budgetSize: input.directive.budgets.step },
        maxLevel,
      };
    }
    if (input.directive.remaining.tokens <= 0) {
      return {
        ok: false,
        reason: STOP_REASONS.BUDGET_EXHAUSTED,
        detail: { budget: 'tokens', used: input.directive.tokensUsed, budgetSize: input.directive.budgets.token },
        maxLevel,
      };
    }
    if (input.nowMs - input.startedAtMs > input.timeBudgetMs) {
      return {
        ok: false,
        reason: STOP_REASONS.TIME_EXHAUSTED,
        detail: { elapsedMs: input.nowMs - input.startedAtMs, timeBudgetMs: input.timeBudgetMs },
        maxLevel,
      };
    }
    // 执行前权限复检：等级 + 白名单 + 指令是否声明了这个动作。
    // 就算有人手工把 allowed_tools_json 改成 '["shell"]'，这里也会拦住。
    const verdict = canExecute({ level: maxLevel, action: input.actionName, allowedTools: input.plan });
    if (!verdict.allowed) {
      return {
        ok: false,
        reason: STOP_REASONS.MISSING_REQUIRED_PERMISSION,
        detail: { action: input.actionName, verdict: verdict.reason, required: verdict.required ?? null },
        maxLevel,
      };
    }
    return { ok: true, maxLevel };
  }

  /**
   * 执行已经认领的那一条。**不认领、不回收**，只跑。
   *
   * @param {Record<string, any>} claim
   * @param {{ maxSteps?: number, now?: any }} opts
   * @returns {Promise<Record<string, any>>}
   */
  async function executeClaimed(claim, opts = {}) {
    const directive = claim.directive;
    const plan = Array.isArray(directive.allowedTools) ? [...directive.allowedTools] : [];
    const maxSteps = clampInt(opts.maxSteps, 1, MAX_STEPS_PER_RUN, DEFAULT_STEPS_PER_RUN);
    const startedAtMs = Date.parse(claim.run.startedAt);
    const timeBudgetMs = directive.budgets.timeSeconds * 1000;

    /** @type {Array<{ action: string, ok: boolean, reason: string }>} */
    const executed = [];
    /** @type {string | null} */
    let stopReason = null;
    /** @type {Record<string, unknown> | null} */
    let stopDetail = null;
    let aborted = null;

    // ---- 第 0 步：把计划写下来（不扣预算）。这一条让"它本来打算做什么"永远可查。----
    const planStep = await appendStep(claim, {
      kind: 'plan',
      summary: `计划：${plan.length > 0 ? plan.join(' → ') : '（未声明任何动作）'}`,
      ok: null,
      evidence: {
        plan,
        permission_scope: directive.permissionScope,
        max_level: claim.maxLevel,
        budgets: { step: directive.budgets.step, timeSeconds: directive.budgets.timeSeconds, token: directive.budgets.token },
        lease_ms: leaseMs,
      },
      now: opts.now,
      });
      if (planStep.aborted !== undefined) {
        // 认领之后立刻丢掉租约（比如另一个 owner 已经回收了）→ 本轮什么都不做。
        alert({
          kind: 'directive_run_aborted',
          message: `认领后立刻失去租约（${planStep.aborted}）：本轮不执行任何动作`,
          detail: { runId: String(claim.runId), directiveId: directive.id },
        });
        return { aborted: planStep.aborted, directiveId: directive.id, runId: claim.runId, executed: [] };
      }

      if (plan.length === 0) {
        // 没有声明任何动作 → 跑不了。这是**失败关**：不许"空跑一轮算完成"。
        stopReason = STOP_REASONS.MISSING_REQUIRED_PERMISSION;
        stopDetail = { reason: 'no_action_declared' };
      } else {
        for (let index = 0; index < plan.length; index += 1) {
          if (index >= maxSteps) {
            stopReason = STOP_REASONS.STEP_CAP_REACHED;
            stopDetail = { maxSteps, planLength: plan.length };
            break;
          }
          const actionName = plan[index];
          const nowMs = nowMsOf(opts.now, clock);
          const pre = preStepChecks({
            directive,
            nowMs,
            startedAtMs,
            timeBudgetMs,
            actionName,
            plan,
          });
          if (!pre.ok) {
            stopReason = /** @type {string} */ (pre.reason);
            stopDetail = pre.detail ?? null;
            break;
          }

          const startedWall = Date.now();
          const outcome = await actions.run({
            name: actionName,
            ctx: {
              scopeId,
              directiveId: directive.id,
              runId: claim.runId,
              action: actionName,
              directive,
              run: claim.run,
              budgets: store.budgetOf(directive),
              heartbeat: () => heartbeat({ runId: claim.runId, owner: claim.owner, now: opts.now }),
            },
          });
          const durationMs = Date.now() - startedWall;

          const recorded = await appendStep(claim, {
            kind: outcome.ok ? 'tool' : 'error',
            summary: outcome.summary,
            ok: outcome.ok ? 1 : 0,
            evidence: {
              action: actionName,
              reason: outcome.reason,
              tokens: outcome.tokens,
              result: outcome.result,
            },
            tokens: outcome.tokens,
            countBudget: true,
            durationMs,
            now: opts.now,
          });
          if (recorded.aborted !== undefined) {
            aborted = recorded.aborted;
            break;
          }

          // 就地更新内存态：下一个动作的预算判定要看到最新的用量。
          directive.stepsUsed += 1;
          directive.tokensUsed += outcome.tokens;
          directive.remaining.steps = Math.max(0, directive.remaining.steps - 1);
          directive.remaining.tokens = Math.max(0, directive.remaining.tokens - outcome.tokens);
          executed.push({ action: actionName, ok: outcome.ok, reason: outcome.reason });

          if (!outcome.ok) {
            stopReason = outcome.reason === 'hook_missing' ? STOP_REASONS.HOOK_MISSING : STOP_REASONS.ACTION_FAILED;
            stopDetail = { action: actionName, reason: outcome.reason };
            break;
          }
        }
        if (stopReason === null && aborted === null) stopReason = STOP_REASONS.GOAL_COMPLETED;
      }

      if (aborted !== null) {
        // 租约在中途丢了（跑过租约 / 被回收 / 换了 owner）→ **不写任何终态**。
        // 沉默丢租约是最难查的一类事故，所以这里必须留痕。
        alert({
          kind: 'directive_run_aborted',
          message: `本轮执行中途放弃（${aborted}）：不写终态，交给回收流程`,
          detail: { runId: String(claim.runId), directiveId: directive.id, executed },
        });
        return { aborted, directiveId: directive.id, runId: claim.runId, executed };
      }
      return finishRun(claim, {
        stopReason: /** @type {string} */ (stopReason),
        stopDetail,
        executed,
        now: opts.now,
      });
    }

    /**
     * 收尾：run 终态 + 指令状态迁移 + 审计。**一个事务**。
     *
     * @param {Record<string, any>} claim
     * @param {{ stopReason: string, stopDetail?: Record<string, unknown> | null, executed: Array<Record<string, any>>, now?: any, error?: string | null }} input
     * @returns {Promise<Record<string, any>>}
     */
  async function finishRun(claim, input) {
    const outcome = STOP_OUTCOMES[input.stopReason] ?? {
      run: 'failed',
      directive: 'failed',
      retryable: false,
    };
    const nowMs = nowMsOf(input.now, clock);

    const result = await writeThrough(queue, (tx) => {
      const runRow = /** @type {Record<string, any> | undefined} */ (
        tx.get('SELECT * FROM directive_runs WHERE id = ? AND scope_id = ?', [String(claim.runId), scopeId])
      );
      if (runRow === undefined) return { aborted: 'run_missing' };
      if (String(runRow.status) !== 'running') return { aborted: `run_${String(runRow.status)}` };
      if (String(runRow.lease_owner ?? '') !== String(claim.owner)) return { aborted: 'lease_owner_mismatch' };
      if (Number(runRow.lease_until ?? 0) <= nowMs) return { aborted: 'lease_expired' };

      const stamp = clock.stamp();
      const directiveRow = /** @type {Record<string, any> | undefined} */ (
        tx.get('SELECT * FROM directives WHERE id = ? AND scope_id = ?', [String(claim.directive.id), scopeId])
      );

      // ---- 1. 停下来的那一步（kind='stop'，不扣预算）----
      const seq = Number(
        tx.get('SELECT COALESCE(MAX(seq), 0) AS n FROM directive_steps WHERE run_id = ?', [String(claim.runId)])?.n ?? 0,
      ) + 1;
      tx.run(
        `INSERT INTO directive_steps (
           id, run_id, scope_id, seq, at, at_local, kind, summary, evidence_json, ok, duration_ms,
           created_at, created_at_local
         ) VALUES (?, ?, ?, ?, ?, ?, 'stop', ?, ?, ?, NULL, ?, ?)`,
        [
          newId('stp'),
          String(claim.runId),
          scopeId,
          seq,
          stamp.utc,
          stamp.local,
          `停止：${input.stopReason}${input.stopDetail === null || input.stopDetail === undefined ? '' : `（${JSON.stringify(input.stopDetail)}）`}`.slice(0, 1000),
          JSON.stringify({ stop_reason: input.stopReason, detail: input.stopDetail ?? null }),
          input.stopReason === STOP_REASONS.GOAL_COMPLETED ? 1 : 0,
          stamp.utc,
          stamp.local,
        ],
      );

      // ---- 2. run 终态 ----
      const runStatus = outcome.run;
      tx.run(
        `UPDATE directive_runs
            SET status = ?, stop_reason = ?, finished_at = ?, error = ?, result_json = ?
          WHERE id = ?`,
        [
          runStatus,
          input.stopReason,
          stamp.utc,
          input.error ?? (input.stopDetail === null || input.stopDetail === undefined ? null : JSON.stringify(input.stopDetail)),
          JSON.stringify({
            stop_reason: input.stopReason,
            executed: input.executed,
            detail: input.stopDetail ?? null,
            steps_used: Number(runRow.steps_used ?? 0),
            tokens_used: Number(runRow.tokens_used ?? 0),
          }),
          String(claim.runId),
        ],
      );

      // ---- 3. 指令状态迁移 ----
      let directiveStatus = directiveRow === undefined ? null : String(directiveRow.status);
      let directiveTarget = outcome.directive;
      let retryCount = null;
      if (directiveRow !== undefined && String(directiveRow.status) === 'running') {
        if (outcome.retryable === true) {
          const failures = Number(
            tx.get(`SELECT COUNT(*) AS n FROM directive_runs WHERE directive_id = ? AND status IN ('failed', 'timeout')`, [
              String(directiveRow.id),
            ])?.n ?? 0,
          );
          retryCount = failures;
          const maxRetries = Number(directiveRow.max_retries ?? 0);
          if (failures > maxRetries) {
            // 重试用尽：动作类失败进 failed（终态），租约类进 blocked（"现在做不了"）。
            directiveTarget = outcome.exhaustedTarget ?? 'failed';
          } else {
            directiveTarget = 'queued';
          }
        }
        try {
          const fromStatus = String(directiveRow.status);
          if (stateMachine.canTransition(fromStatus, directiveTarget)) {
            // 直接从 running 到目标（completed / failed / paused / blocked）——一步到位。
            stateMachine.applyTransition(tx, {
              row: directiveRow,
              to: directiveTarget,
              reason: input.stopReason,
              by: 'scheduler',
            });
          } else {
            // 只有"回到队列"这类不在合法表里的边才走 blocked 中转：
            // running → blocked → queued，留两条审计，而不是把状态偷偷改回去。
            stateMachine.applyTransition(tx, {
              row: directiveRow,
              to: 'blocked',
              reason: 'retry_pending',
              by: 'scheduler',
            });
            stateMachine.applyTransition(tx, {
              row: directiveRow,
              to: directiveTarget,
              reason: input.stopReason,
              by: 'scheduler',
            });
          }
          directiveStatus = String(directiveRow.status);
        } catch (err) {
          // 指令状态已被人工改过（cancel/pause）→ 不替人改，只记一条告警。
          directiveStatus = String(directiveRow.status);
          alert({
            kind: 'directive_finish_transition_skipped',
            message: `收尾时跳过指令状态迁移（状态已被人工改过）：${err instanceof Error ? err.message : String(err)}`,
            detail: { directiveId: String(claim.directive.id), runId: String(claim.runId), stopReason: input.stopReason },
          });
        }
      }

      tx.run(
        `INSERT INTO audit_logs (
           audit_id, ts, ts_local, actor, action, target_kind, target_id, scope_id,
           result, detail, trace_id, deletion_epoch
         ) VALUES (?, ?, ?, 'scheduler', 'directive.run.finished', 'directive', ?, ?, ?, ?, NULL, NULL)`,
        [
          newId('aud'),
          stamp.utc,
          stamp.local,
          String(claim.directive.id),
          scopeId,
          input.stopReason === STOP_REASONS.GOAL_COMPLETED ? 'ok' : 'error',
          JSON.stringify({
            run_id: String(claim.runId),
            attempt: Number(runRow.attempt ?? 1),
            stop_reason: input.stopReason,
            run_status: runStatus,
            directive_status: directiveStatus,
            executed: input.executed,
            retry_count: retryCount,
            detail: input.stopDetail ?? null,
          }),
        ],
      );

      return {
        runId: String(claim.runId),
        runStatus,
        stopReason: input.stopReason,
        detail: input.stopDetail ?? null,
        directiveId: String(claim.directive.id),
        directiveStatus,
        executed: input.executed,
        retryCount,
      };
    },
    { label: 'directives.finishRun' },
  );

  if (result.aborted !== undefined) {
    // 租约在收尾前丢了 → 不写任何终态，交给回收流程。**不假装完成**。
    alert({
      kind: 'directive_run_aborted',
      message: `本轮执行在收尾时放弃（${result.aborted}）：不写终态，等回收`,
      detail: { runId: String(claim.runId), directiveId: String(claim.directive.id) },
    });
    return { aborted: result.aborted, directiveId: String(claim.directive.id), runId: String(claim.runId), executed: input.executed };
  }

    safePublish(
      workspace,
      {
        channel: 'result',
        sourceModule: 'directives',
        kind: result.stopReason === STOP_REASONS.GOAL_COMPLETED ? 'directive.completed' : 'directive.stopped',
        subjectType: 'directive',
        subjectId: String(claim.directive.id),
        payload: {
          run_id: String(claim.runId),
          stop_reason: result.stopReason,
          directive_status: result.directiveStatus,
          executed: input.executed,
        },
        dedupeKey: `directive.run.finished:${String(claim.runId)}`,
      },
      alert,
    );

    return result;
  }

  /**
   * 跑一轮。**这是宿主唯一需要定时调用的入口。**
   *
   * @param {{ owner?: string, maxSteps?: number, now?: any }} [opts]
   * @returns {Promise<Record<string, any>>}
   */
  async function runOnce(opts = {}) {
    const owner = String(opts.owner ?? 'scheduler');
    // ① 闸门：不满足就返回 skipped，**一个字都不写**。
    const gate = readGate();
    if (!gate.ok) {
      return { skipped: true, reason: gate.reason, detail: gate.detail ?? null, recovered: 0, expired: 0 };
    }

    // ② 清理：回收僵尸 run + 作废过期指令。
    //    只有闸门放行后才做——暂停期间连清理都不做，这样"停手 = 零写入"是绝对的。
    let recovered = 0;
    let expired = 0;
    try {
      const rec = await recoverStaleRuns({ now: opts.now });
      recovered = rec.recovered;
      const exp = await expireStaleDirectives({ now: opts.now });
      expired = exp.expired;
    } catch (err) {
      alert({
        kind: 'directive_maintenance_failed',
        message: `回收/作废清理失败：${err instanceof Error ? err.message : String(err)}`,
        detail: {},
      });
    }

    // ③ 认领
    const claimResult = await claimNext({ owner, now: opts.now, maxLevel: gate.maxLevel });
    if (claimResult.claimed !== true || claimResult.claim === undefined) {
      return { skipped: true, reason: claimResult.reason ?? SKIP_REASONS.QUEUE_EMPTY, recovered, expired };
    }

    // ④⑤ 执行 + 收尾
    try {
      const outcome = await executeClaimed(claimResult.claim, { maxSteps: opts.maxSteps, now: opts.now });
      return { skipped: false, recovered, expired, ...outcome };
    } catch (err) {
      // 意外异常：尽量把 run 标成失败（否则它会一直 running 到租约过期）。
      const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      alert({
        kind: 'directive_run_crashed',
        message: `指令执行抛出未预期异常：${message}`,
        detail: { directiveId: String(claimResult.claim.directive.id), runId: String(claimResult.claim.runId) },
      });
      try {
        const finished = await finishRun(claimResult.claim, {
          stopReason: STOP_REASONS.ACTION_FAILED,
          stopDetail: { error: message },
          executed: [],
          now: opts.now,
          error: message,
        });
        return { skipped: false, recovered, error: message, ...finished };
      } catch {
        return { skipped: false, recovered, error: message, runId: String(claimResult.claim.runId), directorNote: '收尾也失败：等租约过期回收' };
      }
    }
  }

  /**
   * 零写入的"预演"：如果现在开自主，会发生什么。
   *
   * 它**只读**，不做 recovery、不改状态、不写步骤——正是 dry-run 命令要的东西。
   *
   * @param {{ now?: any, limit?: number }} [opts]
   * @returns {Record<string, any>}
   */
  function plan(opts = {}) {
    const gate = readGate();
    const nowMs = nowMsOf(opts.now, clock);
    const limit = clampInt(opts.limit, 1, 50, 10);
    const stats = store.stats();
    const picked = store.nextEligible({
      limit,
      now: nowMs,
      maxLevel: gate.ok ? gate.maxLevel : null,
      });

      /** @type {Array<Record<string, any>>} */
      const items = [];
      for (const directive of picked.items) {
        const effective = gate.ok && gate.maxLevel !== null ? gate.maxLevel : directive.permissionScope;
        const actionChecks = (directive.allowedTools ?? []).map((name) => {
          const verdict = canExecute({ level: effective, action: name, allowedTools: directive.allowedTools });
          const entry = /** @type {any} */ (store.constants.ACTION_TABLE[name]);
          return {
            name,
            level: entry?.minLevel ?? null,
            hook: entry?.hook ?? null,
            hookAvailable: entry === undefined ? false : actions.available(name),
            allowed: verdict.allowed,
            reason: verdict.reason,
          };
        });
        /** @type {string[]} */
        const blockers = [];
        if (!gate.ok) blockers.push(gate.reason);
        if ((directive.allowedTools ?? []).length === 0) blockers.push('no_action_declared');
        for (const check of actionChecks) {
          if (!check.allowed) blockers.push(`action_blocked:${check.name}:${check.reason}`);
          else if (!check.hookAvailable) blockers.push(`hook_missing:${check.name}`);
        }
        if (directive.remaining.steps <= 0) blockers.push('budget_exhausted:steps');
        if (directive.remaining.tokens <= 0) blockers.push('budget_exhausted:tokens');
        if (directive.validUntil !== null && Date.parse(directive.validUntil) <= nowMs) blockers.push('valid_until_passed');
        items.push({
          id: directive.id,
          title: directive.title,
          status: directive.status,
          source: directive.source,
          priority: directive.priority,
          permissionScope: directive.permissionScope,
          effectiveLevel: effective,
          trigger: directive.trigger,
          parentGoalId: directive.parentGoalId,
          validUntil: directive.validUntil,
          budgets: directive.budgets,
          remaining: directive.remaining,
          actions: actionChecks,
          blockers,
          wouldRun: gate.ok && blockers.length === 0,
          // 会怎么被执行：顺序就是 allowedTools 的顺序，每一步一个 directive_steps 流水
          executionPlan: actionChecks.map((check, index) => ({
            seq: index + 2, // seq 1 是 plan 步骤本身
            kind: 'tool',
            action: check.name,
            willRun: check.allowed && check.hookAvailable,
            blockedReason: check.allowed ? (check.hookAvailable ? null : 'hook_missing') : check.reason,
          })),
        });
      }

      // 过期租约的 running：预演"回收会做什么"（**不真的回收**）
      const staleRuns = reader
        .all(
          `SELECT * FROM directive_runs
            WHERE scope_id = ? AND status = 'running' AND (lease_until IS NULL OR lease_until <= ?)
            ORDER BY COALESCE(lease_until, 0) ASC LIMIT ?`,
          [scopeId, nowMs, limit],
        )
        .map((row) => ({
          runId: String(row.id),
          directiveId: String(row.directive_id),
          attempt: Number(row.attempt ?? 1),
          leaseOwner: row.lease_owner === null || row.lease_owner === undefined ? null : String(row.lease_owner),
          leaseUntil: row.lease_until === null || row.lease_until === undefined ? null : Number(row.lease_until),
          wouldTimeoutAt: row.lease_until === null || row.lease_until === undefined ? nowMs : Number(row.lease_until),
          action: 'mark_timeout_then_requeue_or_block',
        }));

      // 已过期但还没作废的指令：预演"下次 runOnce 会把它们作废"（**不真作废**）
      const wouldExpire = reader
        .all(
          `SELECT id, title, status, valid_until FROM directives
            WHERE scope_id = ? AND status IN ('proposed', 'awaiting_approval', 'queued')
              AND valid_until IS NOT NULL AND valid_until <= ?
            ORDER BY valid_until ASC LIMIT ?`,
          [scopeId, isoOf(nowMs), limit],
        )
        .map((row) => ({
          id: String(row.id),
          title: String(row.title),
          status: String(row.status),
          validUntil: String(row.valid_until),
          action: 'mark_cancelled_valid_until_passed',
        }));

      return {
        at: isoOf(nowMs),
        gate: { ok: gate.ok, reason: gate.reason, maxLevel: gate.maxLevel, detail: gate.detail ?? null },
        counters: stats,
        queued: stats.queued ?? 0,
        items,
        rejected: picked.rejected,
        staleRuns,
        wouldExpire,
        hooks: actions.list(),
        leaseMs,
      };
    }

    /** 调度器参数与能力声明（面板 / dry-run 用）。 */
  function describe() {
    return {
      scopeId,
      leaseMs,
      maxStepsPerRun: MAX_STEPS_PER_RUN,
      defaultStepsPerRun: DEFAULT_STEPS_PER_RUN,
      actions: actions.names,
      hooksBound: actions.hooksBound,
      gates: ['global_paused', 'autonomy_disabled', 'autonomy.max_level'],
      stopReasons: Object.keys(STOP_OUTCOMES),
      zeroWriteWhenSkipped: true,
    };
  }

  return {
    runOnce,
    claimNext,
    executeClaimed,
    finishRun,
    appendStep,
    recoverStaleRuns,
    /** 别名：宿主 / 文档里习惯叫 reclaim 或 recoverOrphans。 */
    reclaim: recoverStaleRuns,
    recoverOrphans: recoverStaleRuns,
    /** 把过期指令作废（queued/awaiting_approval/proposed → cancelled）。 */
    expireStaleDirectives,
    heartbeat,
    plan,
    readGate,
    describe,
    preStepChecks,
  };
}
