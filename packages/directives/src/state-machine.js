// @ts-check
/**
 * 指令状态机。
 *
 * ## 为什么状态机要单独一个文件、而且这么死板
 *
 * 指令系统的伤害几乎都发生在"状态乱掉了"之后：一条已经 `completed` 的指令又被
 * 拉去跑一遍、一条 `cancelled` 的指令在重启后被回收成 `queued`。这类 bug 的特点是
 * **当场不报错**，过几天以"怎么又做了一遍"的形式出现。所以：
 *
 * 1. **合法边写死在常量表里**，代码里没有 `UPDATE directives SET status = ?` 的自由写法；
 * 2. **非法转移抛错**，不静默忽略（静默忽略会让调用方以为成功）；
 * 3. **每次转移写一条审计**（`action='directive.transition'`），带 from/to/reason/by。
 *
 * ## 状态图
 *
 * ```
 *                        ┌──────────────────┐
 *   （创建）─────────────► │ proposed          │
 *                        └───┬───────┬───────┘
 *              awaiting_approval│      │queued / cancelled
 *                        ┌───▼───────────▼──┐
 *                        │ awaiting_approval │──► queued / blocked / cancelled
 *                        └───────┬──────────┘
 *                                │
 *        ┌───────────────────────▼─────────────────────────┐
 *        │                     queued                       │──► cancelled / paused
 *        └───────────────────────┬─────────────────────────┘
 *                                │running
 *                        ┌───────▼─────────────────────────┐
 *                        │            running               │──► paused / blocked / completed
 *                        └───────┬─────┬─────┬─────┬───────┘     / failed / cancelled
 *                                │     │     │
 *                        paused◄─┘     │     └─► failed / completed（终态）
 *                                      └─► blocked
 *        paused  ──► queued / cancelled
 *        blocked ──► queued / awaiting_approval / cancelled
 * ```
 *
 * ## 终态不可再转
 *
 * `completed` / `failed` / `cancelled` 的合法出边为空。要"再来一次"，正确做法是
 * **新建一条指令**（新的 idempotencyKey），而不是复活旧的——复活会把"这条指令
 * 曾经完成过"这段历史抹掉，而预算与次数正是按历史算的。
 *
 * ## 为什么"原地转成自己"也非法
 *
 * 因为它会掩盖重复调用：`run()` 被两个定时器同时触发时，第二次的 `queued→running`
 * 应该失败（说明有人抢到了），而不是"成功但什么也没变"。
 * 上层的宽容（重复 cancel / 重复 pause）由 API 层先判状态再返回 `{ changed: false }`。
 */

import { randomBytes } from 'node:crypto';
import { DirectivesArgumentError, DirectivesNotFoundError, InvalidTransitionError } from './errors.js';
import { createSimpleTxApi, newId, safePublish, writeThrough } from './util.js';

/** 全部状态。 */
export const STATUSES = Object.freeze([
  'proposed',
  'awaiting_approval',
  'queued',
  'running',
  'paused',
  'blocked',
  'completed',
  'failed',
  'cancelled',
]);

/** 终态：不可再转出。 */
export const TERMINAL_STATUSES = Object.freeze(['completed', 'failed', 'cancelled']);

/**
 * 合法转移表。**唯一的真相来源**：`applyTransition` 只认这张表。
 *
 * 每条边的理由（为什么这条边必须有 / 为什么别的边没有）写在这里，改表要连注释一起改。
 */
export const TRANSITIONS = Object.freeze({
  // proposed：刚被创建，还没经过任何人批准。它可以：
  // - 去 awaiting_approval：需要人批的指令（内部自主生成的一定走这条）；
  // - 去 queued：主人自己建的指令，等价于"我自己批了"；
  // - 去 cancelled：创建完就反悔。
  proposed: Object.freeze(['awaiting_approval', 'queued', 'cancelled']),

  // awaiting_approval：等主人点头。可以批准进队、被条件卡住（blocked）、被撤回。
  // 注意它**不能直接进 running**：批准与执行必须分两步，否则"人批过"这件事没法证明。
  awaiting_approval: Object.freeze(['queued', 'blocked', 'cancelled']),

  // queued：排队中。可被调度器认领（running），也可被主人暂停或撤回。
  // 不能从 queued 直接 completed：没有执行记录就不许说做完了。
  queued: Object.freeze(['running', 'cancelled', 'paused']),

  // running：执行中。可暂停、可被卡住、可正常完成、可失败、可被撤回。
  // **没有 running→queued 这条边**：重试必须先经过 blocked（"现在做不了"），
  // 这样每一次"再试一次"都留在审计里，而不是看起来像"从没开始过"。
  running: Object.freeze(['paused', 'blocked', 'completed', 'failed', 'cancelled']),

  // paused：被主人或全局暂停停下。恢复 = 回 queued（而不是直接回 running）：
  // 回 running 就等于"暂停期间被谁抢跑了，我们还不知道"。
  paused: Object.freeze(['queued', 'cancelled']),

  // blocked：现在做不了（权限不足 / hook 未接线 / 预算用尽 / 租约回收后重试用尽）。
  // 可回 queued（条件变了再试）、可回 awaiting_approval（改法需要人重新批）、可撤回。
  blocked: Object.freeze(['queued', 'awaiting_approval', 'cancelled']),

  // 终态：出边为空。
  completed: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

/**
 * @param {unknown} status
 * @returns {boolean}
 */
export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(String(status));
}

/**
 * @param {unknown} from
 * @param {unknown} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  const fromKey = String(from ?? '');
  const toKey = String(to ?? '');
  if (!Object.hasOwn(TRANSITIONS, fromKey)) return false;
  return /** @type {readonly string[]} */ (TRANSITIONS[fromKey]).includes(toKey);
}

/**
 * 取某个状态下所有合法去向。
 * @param {unknown} status
 * @returns {string[]}
 */
export function allowedNext(status) {
  const key = String(status ?? '');
  return Object.hasOwn(TRANSITIONS, key) ? [.../** @type {readonly string[]} */ (TRANSITIONS[key])] : [];
}

/**
 * 非法转移一律抛 `InvalidTransitionError`（含合法去向清单，便于上层提示）。
 * @param {unknown} from
 * @param {unknown} to
 * @returns {void}
 */
export function assertTransition(from, to) {
  const fromKey = String(from ?? '');
  const toKey = String(to ?? '');
  if (!Object.hasOwn(TRANSITIONS, fromKey)) {
    throw new InvalidTransitionError(`未知的指令状态：${fromKey}`, { from: fromKey, to: toKey, allowed: [] });
  }
  if (fromKey === toKey) {
    throw new InvalidTransitionError(`状态已经是 ${fromKey}，拒绝原地转移（原地转移会掩盖重复调用）`, {
      from: fromKey,
      to: toKey,
      allowed: allowedNext(fromKey),
      reason: 'same_status',
    });
  }
  if (isTerminal(fromKey)) {
    throw new InvalidTransitionError(`指令已处于终态 ${fromKey}，不可再转（要重做请新建指令）`, {
      from: fromKey,
      to: toKey,
      allowed: [],
      terminal: true,
    });
  }
  if (!canTransition(fromKey, toKey)) {
    throw new InvalidTransitionError(`非法状态转移：${fromKey} → ${toKey}`, {
      from: fromKey,
      to: toKey,
      allowed: allowedNext(fromKey),
    });
  }
}

/**
 * 事务内执行一次状态迁移。**同步**——只在已经开着的 `queue.write` 事务里调用。
 *
 * 它做三件事（同一个事务，缺一不可）：
 * 1. 校验转移合法（含 scope 归属）；
 * 2. 更新 `directives` 行（status / updated_at / finished_at / last_error / version+1）；
 * 3. 写 `audit_logs`（action='directive.transition'）。
 *
 * 为什么参数是 `row` 而不是 `id`：调度器在同一个事务里要连续走两三步
 * （例如 running→blocked→queued 的重试路径），传对象可以就地更新内存态，
 * 避免"写完再查一遍"这种多余往返，也避免读到自己的旧值。
 *
 * @param {{ run: Function, get: Function, all: Function, exec?: Function }} tx
 * @param {{
 *   row: Record<string, any>,
 *   to: string,
 *   reason?: string | null,
 *   by?: string | null,
 *   clock: { stamp: () => { utc: string, local: string } },
 *   scopeId: string,
 *   nowIso?: string,
 * }} input
 * @returns {{ from: string, to: string, auditId: string }}
 */
export function applyTransition(tx, input) {
  const row = input.row;
  const scopeId = String(input.scopeId);
  if (row === null || row === undefined || typeof row !== 'object') {
    throw new DirectivesArgumentError('applyTransition 需要指令行对象', { reason: 'invalid_row' });
  }
  if (String(row.scope_id) !== scopeId) {
    // 跨 scope 一律当"不存在"（区分了就等于给出探测别的 scope 的接口）
    throw new DirectivesNotFoundError('指令不存在（或不属于当前 scope）', {
      targetKind: 'directive',
      targetId: String(row.id ?? ''),
      scopeId,
    });
  }
  const from = String(row.status);
  const to = String(input.to);
  assertTransition(from, to);

  const stamp = input.clock.stamp();
  const nowIso = input.nowIso ?? stamp.utc;
  const terminal = isTerminal(to);
  // finished_at：只写一次（终态那次）。blocked→queued 重试时**不清空**它，
  // 因为 blocked 不是终态，本来就没有写过；真正写过 finished_at 的一定是终态，出不来。
  const finishedAt = terminal ? nowIso : null;
  // last_error：失败/卡住时留原因；回到队列/执行中时清空（"已经重新来过了"）。
  const lastError = to === 'failed' || to === 'blocked' ? (input.reason ?? null) : null;

  const result = tx.run(
    `UPDATE directives
        SET status = ?, updated_at = ?, updated_at_local = ?, finished_at = COALESCE(?, finished_at),
            last_error = ?, version = version + 1
      WHERE id = ? AND scope_id = ? AND status = ?`,
    [to, nowIso, stamp.local, finishedAt, lastError, String(row.id), scopeId, from],
  );
  const changes = Number(result?.changes ?? 0);
  if (changes !== 1) {
    // `AND status = ?` 让这次更新变成真正的 CAS：如果行的状态在事务内已经变了
    // （另一个 owner 抢先、或人工刚改过），这里必须失败，而不是把错误的状态覆盖掉。
    throw new InvalidTransitionError(`状态迁移失败：${from} → ${to} 的前置状态已不存在（并发写入）`, {
      from,
      to,
      allowed: allowedNext(from),
      reason: 'concurrent_change',
    });
  }

  // 就地更新内存态：调用方可能还要接着走下一步转移。
  row.status = to;
  row.updated_at = nowIso;
  row.updated_at_local = stamp.local;
  row.version = Number(row.version ?? 1) + 1;
  row.last_error = lastError;
  if (finishedAt !== null) row.finished_at = finishedAt;

  const auditId = `aud_${randomBytes(12).toString('hex')}`;
  tx.run(
    `INSERT INTO audit_logs (
       audit_id, ts, ts_local, actor, action, target_kind, target_id, scope_id,
       result, detail, trace_id, deletion_epoch
     ) VALUES (?, ?, ?, ?, 'directive.transition', 'directive', ?, ?, ?, ?, NULL, NULL)`,
    [
      auditId,
      stamp.utc,
      stamp.local,
      input.by ?? 'scheduler',
      String(row.id),
      scopeId,
      // 转移本身永远算"成功执行"（哪怕目标是 failed）：result 记的是这次动作有没有做成，
      // 不是业务结果。业务结果在 detail.to 里。
      'ok',
      JSON.stringify({ from, to, reason: input.reason ?? null, version: row.version }),
    ],
  );

  return { from, to, auditId, version: row.version };
}

/**
 * 造状态机门面。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   workspace?: { publish?: (event: Record<string, unknown>) => unknown } | null,
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   scopeId: string,
 * }} options
 */
export function createStateMachine(options) {
  const { db, queue, clock } = options;
  const scopeId = String(options.scopeId);
  const workspace = options.workspace ?? null;
  const alert = options.alert ?? (() => {});
  const reader = createSimpleTxApi(db);

  /**
   * 读一条指令行（scope 收口）。跨 scope 返回 undefined（上层当不存在）。
   * @param {string} id
   * @param {{ tx?: any }} [opts]
   * @returns {Record<string, any> | undefined}
   */
  function readRow(id, opts = {}) {
    const handle = opts.tx ?? reader;
    return /** @type {Record<string, any> | undefined} */ (
      handle.get('SELECT * FROM directives WHERE id = ? AND scope_id = ?', [String(id), scopeId])
    );
  }

  /**
   * 公开的迁移入口（异步，自带事务）。
   *
   * @param {{ id: string, to: string, reason?: string | null, by?: string | null }} input
   * @returns {Promise<{ id: string, from: string, to: string, changed: true }>}
   */
  async function transition(input) {
    const id = typeof input?.id === 'string' ? input.id : '';
    if (id.length === 0) throw new DirectivesArgumentError('transition 需要指令 id', { reason: 'id_required', field: 'id' });
    const to = typeof input.to === 'string' ? input.to : '';
    if (to.length === 0) throw new DirectivesArgumentError('transition 需要目标状态 to', { reason: 'to_required', field: 'to' });

    const outcome = await writeThrough(
      queue,
      (tx) => {
        const row = readRow(id, { tx });
        if (row === undefined) {
          throw new DirectivesNotFoundError('指令不存在（或不属于当前 scope）', {
            targetKind: 'directive',
            targetId: id,
            scopeId,
          });
        }
        const applied = applyTransition(tx, { row, to, reason: input.reason ?? null, by: input.by ?? 'owner', clock, scopeId });
        return { id, from: applied.from, to: applied.to, version: applied.version, changed: /** @type {const} */ (true) };
      },
      'directives.transition',
    );

    // 事件在事务提交**之后**发：事务里发事件会在回滚后留下"没发生过的通知"。
    safePublish(
      workspace,
      {
        channel: 'action',
        sourceModule: 'directives',
        kind: 'directive.transition',
        subjectType: 'directive',
        subjectId: outcome.id,
        payload: { from: outcome.from, to: outcome.to, reason: input.reason ?? null, by: input.by ?? 'owner' },
        dedupeKey: `directive.transition:${outcome.id}:${outcome.version}`,
      },
      alert,
    );
    return outcome;
  }

  /**
   * 一条指令的状态变更历史（读审计，按时间正序）。
   * @param {{ id: string, limit?: number }} query
   * @returns {Array<{ at: string, from: string | null, to: string | null, reason: string | null, by: string }>}
   */
  function history(query) {
    const limit = Math.min(Math.max(Number(query?.limit) || 50, 1), 500);
    const rows = reader.all(
      `SELECT ts, actor, detail FROM audit_logs
        WHERE action = 'directive.transition' AND target_kind = 'directive' AND target_id = ? AND scope_id = ?
        ORDER BY ts ASC LIMIT ?`,
      [String(query?.id ?? ''), scopeId, limit],
    );
    return rows.map((row) => {
      /** @type {Record<string, any>} */
      let detail = {};
      try {
        detail = JSON.parse(String(row.detail ?? '{}')) ?? {};
      } catch {
        detail = {};
      }
      return {
        at: String(row.ts),
        from: detail.from ?? null,
        to: detail.to ?? null,
        reason: detail.reason ?? null,
        by: String(row.actor ?? 'system'),
      };
    });
  }

  return {
    scopeId,
    statuses: STATUSES,
    terminalStatuses: TERMINAL_STATUSES,
    transitions: TRANSITIONS,
    transition,
    history,
    readRow,
    canTransition,
    allowedNext,
    assertTransition,
    // 事务内版本，供调度器 / 指令 CRUD 复用（它们自己已经在事务里了）
    applyTransition: (tx, params) => applyTransition(tx, { ...params, clock, scopeId }),
  };
}
