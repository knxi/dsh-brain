// @ts-check
/**
 * 内部意图 → 指令（自主候选的落地口）。
 *
 * ## 这一段为什么必须"手很紧"
 *
 * 系统 3 的反思/默认模式网络会不断提出"我想做点什么"的候选。候选本身是**建议**，
 * 不是权限。这个文件的职责，就是把建议翻译成一条**权限最小、必须人批**的指令：
 *
 * 1. `autonomy.enabled=0` → **一条都不转**（零写入，连审计都不写）。
 * 2. 内部指令的权限范围**硬上限 L1**，永远不跟着 `autonomy.max_level` 涨。
 *    理由：`max_level` 是主人对"我允许到什么级别"的意思表示，不能被内部候选
 *    读成"我可以自己升到那级"。候选里写 `permissionScope:'L3'` 也照样被压到 L1。
 * 3. 内部指令的动作只能是 L1 动作；越级的（`reflection_run` 等 L2）一律丢弃。
 * 4. 预算用内部小额度（3 步 / 60 秒 / 2000 token），比主人手建的要紧。
 * 5. 转出来的指令状态是 **`awaiting_approval`**，绝不 `queued`：
 *    自动排队等于"自己批自己"，那整套审批就变成了装饰。
 * 6. **不写候选表、不改候选状态**。候选的仲裁归 lead 的 workspace，
 *    我只读 `listCandidates`，连 `claim` 都不调——避免两套仲裁互相踩。
 */

import { TRIGGERS, SOURCES } from './directives.js';
import { newId, writeThrough } from './util.js';
import { ACTION_TABLE, EXECUTABLE_ACTION_NAMES, levelRank } from './permissions.js';

/** 内部生成的指令，权限等级硬上限。**不要把它做成可配置的**。 */
export const INTERNAL_MAX_LEVEL = 'L1';

/** 内部指令的预算上限（比主人手建的默认值更紧）。 */
export const INTERNAL_BUDGET_CAPS = Object.freeze({
  stepBudget: 5,
  timeBudgetSeconds: 120,
  tokenBudget: 5_000,
});

/** 内部指令的预算默认值。 */
export const INTERNAL_BUDGET_DEFAULTS = Object.freeze({
  stepBudget: 3,
  timeBudgetSeconds: 60,
  tokenBudget: 2_000,
});

/**
 * 造自主候选落地器。
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
 * }} options
 */
export function createAutonomy(options) {
  const { queue, clock, store, stateMachine } = options;
  const scopeId = String(options.scopeId);
  const workspace = options.workspace ?? null;
  const alert = options.alert ?? (() => {});

  /**
   * 闸门（纯读）。与调度器同口径：暂停优先，然后总开关。
   * 这里**不查 max_level**：转指令不等于执行指令。哪怕 max_level=L0，
   * 转成一条 awaiting_approval 的 L1 指令也不算错——它跑不动而已。
   *
   * @returns {{ ok: boolean, reason: string }}
   */
  function readGate() {
    if (workspace === null || workspace === undefined) return { ok: false, reason: 'workspace_missing' };
    if (typeof workspace.isPaused !== 'function' || typeof workspace.isEnabled !== 'function') {
      return { ok: false, reason: 'workspace_incomplete' };
    }
    if (workspace.isPaused()) return { ok: false, reason: 'global_paused' };
    if (!workspace.isEnabled('autonomy.enabled')) return { ok: false, reason: 'autonomy_disabled' };
    return { ok: true, reason: 'ok' };
  }

  /**
   * 候选 → 指令入参。**纯函数**，preview 与真实 drain 共用同一段映射，
   * 避免"预览看到的"和"真转出来的"不是一回事。
   *
   * @param {Record<string, any>} candidate
   * @returns {{ input: Record<string, any> | null, skipped: string | null, droppedTools: string[], notes: string[] }}
   */
  function candidateToDirectiveInput(candidate) {
    /** @type {string[]} */
    const notes = [];
    /** @type {string[]} */
    const droppedTools = [];
    const title = typeof candidate?.title === 'string' ? candidate.title.trim() : '';
    if (title.length === 0) return { input: null, skipped: 'candidate_title_missing', droppedTools, notes };
    const payload = candidate.payload !== null && typeof candidate.payload === 'object' ? candidate.payload : {};

    // ---- 动作：只收 L1 的白名单动作，其余丢弃（记在 droppedTools 里，可解释）----
    /** @type {unknown[]} */
    const rawTools = Array.isArray(payload.allowedTools)
      ? payload.allowedTools
      : typeof payload.action === 'string'
        ? [payload.action]
        : [];
    /** @type {string[]} */
    const tools = [];
    for (const raw of rawTools) {
      const name = String(raw).trim();
      const entry = /** @type {Record<string, any> | undefined} */ (ACTION_TABLE[name]);
      if (entry === undefined) {
        droppedTools.push(name);
        continue;
      }
      if (levelRank(entry.minLevel) > levelRank(INTERNAL_MAX_LEVEL)) {
        // 例如 reflection_run（L2）：内部候选不许自带 L2 动作。
        droppedTools.push(name);
        notes.push(`动作「${name}」需要 ${entry.minLevel}，内部指令上限 ${INTERNAL_MAX_LEVEL}：已丢弃`);
        continue;
      }
      if (!tools.includes(name)) tools.push(name);
    }

    // ---- 预算：内部小额度，且不信任候选给的数 ----
    const budgets = payload.budgets !== null && typeof payload.budgets === 'object' ? payload.budgets : {};
    /** @param {unknown} value @param {keyof typeof INTERNAL_BUDGET_DEFAULTS} key */
    const budgetOf = (value, key) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return INTERNAL_BUDGET_DEFAULTS[key];
      return Math.min(Math.trunc(n), INTERNAL_BUDGET_CAPS[key]);
    };

    const trigger = typeof payload.trigger === 'string' && TRIGGERS.includes(payload.trigger) ? payload.trigger : 'idle';
    if (typeof payload.trigger === 'string' && !TRIGGERS.includes(payload.trigger)) {
      notes.push(`候选给的 trigger「${payload.trigger}」不合法，按 idle 处理`);
    }
    if (payload.permissionScope !== undefined && payload.permissionScope !== null) {
      const requested = String(payload.permissionScope).toUpperCase();
      if (levelRank(requested) > levelRank(INTERNAL_MAX_LEVEL)) {
        notes.push(`候选请求 ${requested}，内部指令硬上限 ${INTERNAL_MAX_LEVEL}：已压到 ${INTERNAL_MAX_LEVEL}`);
      }
    }

    const expiresAt = candidate.expiresAt ?? payload.expiresAt ?? null;
    const validUntil = expiresAt !== null && expiresAt !== undefined && Number.isFinite(Date.parse(String(expiresAt)))
      ? new Date(Date.parse(String(expiresAt))).toISOString()
      : null;

    const priorityRaw = Number(candidate.priority);
    const priority = Number.isFinite(priorityRaw) ? Math.min(100, Math.max(0, Math.trunc(priorityRaw))) : 40;

    // 预算**写在顶层**（create 的契约字段名），不是嵌套对象——否则会被 create 的
    // 默认值覆盖，等于"内部候选悄悄拿到了全局默认的 10 步 / 300 秒 / 20000 token"。
    const stepBudget = budgetOf(budgets.stepBudget ?? budgets.step, 'stepBudget');
    const timeBudgetSeconds = budgetOf(budgets.timeBudgetSeconds ?? budgets.time, 'timeBudgetSeconds');
    const tokenBudget = budgetOf(budgets.tokenBudget ?? budgets.token, 'tokenBudget');

    return {
      input: {
        title: title.slice(0, 200),
        reason:
          (typeof candidate.reason === 'string' && candidate.reason) ||
          (typeof payload.reason === 'string' && payload.reason) ||
          `内部候选：${candidate.originModule ?? 'unknown'}（${String(candidate.id ?? '')}）`,
        trigger,
        priority,
        // ---- 无条件的三个常量：谁也别想从候选里改掉它们 ----
        source: /** @type {const} */ ('internal'),
        permissionScope: INTERNAL_MAX_LEVEL,
        // 候选的 scopeId 与当前实例不同 → 不转（跨 scope 一律拒绝）
        allowedTools: tools,
        stepBudget,
        timeBudgetSeconds,
        tokenBudget,
        maxRetries: 1,
        validUntil,
        preconditions: Array.isArray(payload.preconditions) ? payload.preconditions : [],
        parentGoalId: null,
        idempotencyKey: `internal:directive:${String(candidate.id)}`,
        createdBy: 'autonomy',
      },
      skipped: null,
      droppedTools,
      notes,
    };
  }

  /**
   * 预览：把"如果现在开自主，会转出哪些指令"列出来。**零写入**。
   *
   * @param {{ limit?: number }} [opts]
   * @returns {Record<string, any>}
   */
  function previewCandidates(opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 100);
    const gate = readGate();
    if (!gate.ok) {
      return { ok: false, reason: gate.reason, candidates: [], convertible: [], skipped: [], zeroWrite: true };
    }
    if (typeof workspace.listCandidates !== 'function') {
      return { ok: false, reason: 'candidates_unavailable', candidates: [], convertible: [], skipped: [], zeroWrite: true };
    }
    const list = workspace.listCandidates({ kind: 'directive', status: 'proposed', limit });
    /** @type {Array<Record<string, any>>} */
    const convertible = [];
    /** @type {Array<Record<string, any>>} */
    const skipped = [];
    for (const candidate of Array.isArray(list) ? list : []) {
      const built = candidateToDirectiveInput(candidate);
      if (built.input === null) {
        skipped.push({ candidateId: String(candidate.id ?? ''), title: String(candidate.title ?? ''), reason: built.skipped });
        continue;
      }
      convertible.push({
        candidateId: String(candidate.id ?? ''),
        title: built.input.title,
        permissionScope: built.input.permissionScope,
        statusAfterDrain: 'awaiting_approval',
        allowedTools: built.input.allowedTools,
        droppedTools: built.droppedTools,
        budgets: {
          step: built.input.stepBudget,
          timeSeconds: built.input.timeBudgetSeconds,
          token: built.input.tokenBudget,
        },
        validUntil: built.input.validUntil,
        notes: built.notes,
      });
    }
    return { ok: true, reason: 'ok', candidates: Array.isArray(list) ? list.length : 0, convertible, skipped, zeroWrite: true };
  }

  /**
   * 把候选转成指令。**转出来的一律是 `awaiting_approval`**（必须人批）。
   *
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<Record<string, any>>}
   */
  async function drainCandidates(opts = {}) {
    const limit = Math.min(Math.max(Number(opts.limit) || 10, 1), 100);
    const gate = readGate();
    if (!gate.ok) {
      // 零写入：不读候选、不建指令、不写审计。
      return { ok: false, reason: gate.reason, drained: 0, created: 0, reused: 0, directives: [], zeroWrite: true };
    }
    if (typeof workspace.listCandidates !== 'function') {
      return { ok: false, reason: 'candidates_unavailable', drained: 0, created: 0, reused: 0, directives: [], zeroWrite: true };
    }
    const list = workspace.listCandidates({ kind: 'directive', status: 'proposed', limit });
    /** @type {Array<Record<string, any>>} */
    const entries = [];
    let created = 0;
    let reused = 0;
    for (const candidate of Array.isArray(list) ? list : []) {
      const built = candidateToDirectiveInput(candidate);
      if (built.input === null) {
        entries.push({ candidateId: String(candidate.id ?? ''), created: false, skipped: built.skipped });
        continue;
      }
      // 跨 scope 候选：当前实例不转，交给拥有它的实例（所有查询都带 scope_id）
      if (candidate.scopeId !== undefined && candidate.scopeId !== null && String(candidate.scopeId) !== scopeId) {
        entries.push({ candidateId: String(candidate.id ?? ''), created: false, skipped: 'cross_scope' });
        continue;
      }
      const result = await store.create(built.input);
      let status = result.directive.status;
      if (result.created === true) {
        created += 1;
        // proposed → awaiting_approval：**必须人批**。绝不自动 queued。
        const moved = await stateMachine.transition({
          id: result.id,
          to: 'awaiting_approval',
          reason: 'awaiting_owner_approval',
          by: 'autonomy',
        });
        status = moved.to;
        await recordDrainAudit({
          candidateId: String(candidate.id ?? ''),
          directiveId: result.id,
          status,
          allowedTools: built.input.allowedTools,
          droppedTools: built.droppedTools,
        });
      } else {
        reused += 1;
      }
      entries.push({
        candidateId: String(candidate.id ?? ''),
        directiveId: result.id,
        created: result.created,
        status,
        allowedTools: built.input.allowedTools,
        droppedTools: built.droppedTools,
        notes: built.notes,
      });
    }
    return {
      ok: true,
      reason: 'ok',
      drained: entries.filter((entry) => entry.directiveId !== undefined).length,
      created,
      reused,
      directives: entries,
      zeroWrite: false,
    };
  }

  /**
   * 记一条"这条指令是从哪个候选转来的"（审计里可追溯）。
   * @param {{ candidateId: string, directiveId: string, status: string, allowedTools: string[], droppedTools: string[] }} input
   */
  async function recordDrainAudit(input) {
    try {
      await writeThrough(queue, (tx) => {
        const stamp = clock.stamp();
        tx.run(
          `INSERT INTO audit_logs (
             audit_id, ts, ts_local, actor, action, target_kind, target_id, scope_id,
             result, detail, trace_id, deletion_epoch
           ) VALUES (?, ?, ?, 'autonomy', 'directive.drained_from_candidate', 'directive', ?, ?, 'ok', ?, NULL, NULL)`,
          [
            newId('aud'),
            stamp.utc,
            stamp.local,
            input.directiveId,
            scopeId,
            JSON.stringify({
              candidate_id: input.candidateId,
              directive_status: input.status,
              permission_scope: INTERNAL_MAX_LEVEL,
              allowed_tools: input.allowedTools,
              dropped_tools: input.droppedTools,
              note: '内部候选只能转成 awaiting_approval，必须人批才能进队列',
            }),
          ],
        );
      },
      { label: 'autonomy.drainAudit' },
    );
  } catch (err) {
    alert({
      kind: 'autonomy_audit_failed',
      message: `候选转指令的审计写入失败：${err instanceof Error ? err.message : String(err)}`,
      detail: { directiveId: input.directiveId, candidateId: input.candidateId },
      });
    }
  }

  return {
    drainCandidates,
    previewCandidates,
    candidateToDirectiveInput,
    readGate,
    constants: { INTERNAL_MAX_LEVEL, INTERNAL_BUDGET_CAPS, INTERNAL_BUDGET_DEFAULTS, TRIGGERS, SOURCES, EXECUTABLE_ACTION_NAMES },
  };
}
