// @ts-check
/**
 * `@dsh-brain/directives` —— 系统 5：自主指令与运行控制。
 *
 * ```
 *   permissions.js   权限矩阵（等级、动作白名单、反扩权）     ← 底线，纯函数
 *        │
 *   state-machine.js 状态机（合法转移表 + 审计）
 *        │
 *   directives.js    指令对象 CRUD + 资格判定（谁该跑）
 *        │
 *   scheduler.js     调度与执行（闸门 / 租约 / 预算 / 停止 / 回收）
 *        │
 *   actions.js       内置动作执行器（只有白名单，只有注入 hook）
 *        │
 *   autonomy.js      内部候选 → 指令（L1 上限，必须人批）
 * ```
 *
 * ## 工厂签名（契约 §2）
 *
 * ```js
 * createDirectives({ db, queue, clock, alert, workspace, bindings })
 * ```
 *
 * `hooks` 是**额外**的可选项（不在契约签名里，但少了它所有动作都会 `hook_missing`）：
 *
 * ```js
 * createDirectives({
 *   db, queue, clock, workspace, bindings,
 *   hooks: {
 *     memoryMaintenance, indexRebuild, alertSweep, backupVerify, reflectionRun, skillRebuild,
 *   },
 * })
 * ```
 *
 * ## 为什么这个包零运行时依赖
 *
 * 它不 import `@dsh-brain/core`、不 import memory、不 import workspace：
 *
 * 1. **它必须能在依赖图没装好时被加载**——权限与停止的执行侧不能因为一个
 *    workspace 链接缺失就起不来（起不来的安全模块等于没有）。
 * 2. **依赖越少，能"变成命令"的路越少。** 这个包里没有 `child_process`、
 *    没有 `fs.write`、没有网络、没有动态 `import()`。
 * 3. 所有依赖（db / queue / clock / workspace / hooks）都是**注入**的，
 *    测试因此可以给假时钟、假 workspace、假 hook，把每一条危险路径钉住。
 *
 * ## 默认姿态（三者任一不满足就零动作）
 *
 * | 条件 | 默认 | 不满足时 |
 * |---|---|---|
 * | `autonomy.enabled` | `'0'` | `runOnce` 返回 `{skipped:true, reason:'autonomy_disabled'}`，零写入 |
 * | `autonomy.max_level` | `'L1'` | 高于 L1 的指令进 `blocked`，不执行 |
 * | 白名单外动作 | 不存在 | `{allowed:false, reason:'action_not_in_whitelist'}`，永不执行 |
 */

import { createStateMachine } from './state-machine.js';
import { createDirectiveStore } from './directives.js';
import { createScheduler } from './scheduler.js';
import { createActionRegistry } from './actions.js';
import { createAutonomy } from './autonomy.js';
import { DirectivesArgumentError } from './errors.js';
import { createSimpleTxApi } from './util.js';
import {
  ACTION_TABLE,
  DEFAULT_MAX_LEVEL,
  EXECUTABLE_ACTION_NAMES,
  LEVELS,
  LEVEL_ORDER,
  assertAllowedTools,
  assertNoEscalation,
  canExecute,
  describePermissionMatrix,
  effectiveLevel,
  levelRank,
  minLevel,
  normalizeScopeSpec,
} from './permissions.js';

/** 单用户 MVP 的默认绑定（与主账 / workspace 同口径）。 */
export const DEFAULT_SCOPE_ID = 'owner-default';
export const DEFAULT_PERSON_ID = 'owner';

/**
 * 归一 bindings。缺省回落到 MVP 固定值（与 `openBrain` 一致）。
 * @param {{ scope_id?: string, scopeId?: string, person_id?: string } | undefined | null} bindings
 * @returns {{ scope_id: string, person_id: string }}
 */
export function normalizeBindings(bindings) {
  const scopeId = bindings?.scope_id ?? bindings?.scopeId ?? DEFAULT_SCOPE_ID;
  return {
    scope_id: String(scopeId),
    person_id: String(bindings?.person_id ?? DEFAULT_PERSON_ID),
  };
}

/**
 * 组装系统 5 的全部门面。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   workspace?: Record<string, any> | null,
 *   bindings?: { scope_id?: string, scopeId?: string, person_id?: string } | null,
 *   hooks?: Record<string, Function> | null,
 *   leaseMs?: number,
 * }} options
 */
export function createDirectives(options) {
  if (!options || typeof options !== 'object') {
    throw new DirectivesArgumentError('createDirectives 需要 db / queue / clock', { reason: 'invalid_options' });
  }
  const { db, queue, clock } = options;
  if (!db || typeof db.prepare !== 'function') {
    throw new DirectivesArgumentError('createDirectives 需要 db（node:sqlite DatabaseSync）', { reason: 'db_required' });
  }
  if (!queue || typeof queue.write !== 'function') {
    throw new DirectivesArgumentError('createDirectives 需要 queue.write（单写队列）', { reason: 'queue_required' });
  }
  if (!clock || typeof clock.stamp !== 'function') {
    throw new DirectivesArgumentError('createDirectives 需要 clock.stamp()', { reason: 'clock_required' });
  }

  const alert = options.alert ?? (() => {});
  const workspace = options.workspace ?? null;
  const bindings = normalizeBindings(options.bindings);
  const scopeId = bindings.scope_id;
  const hooks = options.hooks ?? {};

  const stateMachine = createStateMachine({ db, queue, clock, workspace, alert, scopeId });
  const actions = createActionRegistry({ hooks, alert });
  const store = createDirectiveStore({ db, queue, clock, workspace, alert, scopeId, stateMachine });
  const scheduler = createScheduler({
    db,
    queue,
    clock,
    workspace,
    alert,
    scopeId,
    store,
    stateMachine,
    actions,
    leaseMs: options.leaseMs,
  });
  const autonomy = createAutonomy({ db, queue, clock, workspace, alert, scopeId, store, stateMachine });
  const reader = createSimpleTxApi(db);

  return {
    scopeId,
    personId: bindings.person_id,
    bindings,

    // ── 指令对象（最常用的入口直接铺平，省得写 store.xxx）──
    /** 建指令（幂等，`idempotencyKey` 必填）。 */
    create: store.create,
    /** 取指令（跨 scope 返回 null）。 */
    get: store.get,
    /** 列表（默认含终态）。 */
    list: store.list,
    /** 状态分布。 */
    stats: store.stats,
    /** 批准（awaiting_approval → queued）。 */
    approve: store.approve,
    pause: store.pause,
    resume: store.resume,
    cancel: store.cancel,
    /** 挑出"现在可以跑"的指令（只读）。 */
    nextEligible: store.nextEligible,

    // ── 子门面 ──
    /** 指令对象门面（含 nextEligibleIn / evaluatePreconditions / budgetOf）。 */
    store,
    directives: store,
    /** 状态机（transition / history / 合法表）。 */
    stateMachine,
    /** 调度器（runOnce / plan / reclaim / heartbeat）。 */
    scheduler,
    /** 动作执行器（run / list / available）。 */
    actions,
    /** 内部候选落地（drainCandidates / previewCandidates）。 */
    autonomy,

    /** 权限矩阵：**纯函数**，不碰 db。上层可以只拿这一段做校验。 */
    permissions: {
      DEFAULT_MAX_LEVEL,
      LEVELS,
      LEVEL_ORDER,
      ACTION_TABLE,
      EXECUTABLE_ACTION_NAMES,
      canExecute,
      assertNoEscalation,
      assertAllowedTools,
      effectiveLevel,
      levelRank,
      minLevel,
      normalizeScopeSpec,
      describe: describePermissionMatrix,
    },

    /** 只读：如果现在开自主会发生什么（dry-run 的引擎）。 */
    plan: scheduler.plan,
    /** 闸门读数（宿主可以在定时器里先问一句再决定要不要调 runOnce）。 */
    readGate: scheduler.readGate,

    /** 能力自述（给面板与诊断用）。 */
    describe() {
      return {
        package: '@dsh-brain/directives',
        scopeId,
        version: 1,
        surface: [
          'create', 'get', 'list', 'stats', 'approve', 'pause', 'resume', 'cancel', 'nextEligible',
          'scheduler.runOnce', 'scheduler.plan', 'scheduler.recoverStaleRuns', 'scheduler.heartbeat',
          'stateMachine.transition', 'stateMachine.history',
          'actions.run', 'actions.list',
          'autonomy.drainCandidates', 'autonomy.previewCandidates',
        ],
        scheduler: scheduler.describe(),
        actions: actions.list(),
        bindings,
        hooksBound: actions.hooksBound,
        hasWorkspace: workspace !== null && workspace !== undefined,
        defaultPosture: {
          autonomyEnabled: '0',
          maxLevel: 'L1',
          externalActions: 'none',
          arbitraryCommandExecution: 'not implemented (by design)',
        },
        tableExists: (() => {
          try {
            return reader.get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'directives'") !== undefined;
          } catch {
            return false;
          }
        })(),
      };
    },
  };
}

// ── 纯函数与常量（上层可以只 import 权限矩阵，不带 db 依赖）──
export {
  ACTION_TABLE,
  DEFAULT_MAX_LEVEL,
  EXECUTABLE_ACTION_NAMES,
  LEVELS,
  LEVEL_ORDER,
  assertAllowedTools,
  assertNoEscalation,
  canExecute,
  classifyAction,
  describePermissionMatrix,
  effectiveLevel,
  levelRank,
  minLevel,
  normalizeScopeSpec,
} from './permissions.js';

export {
  STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  allowedNext,
  applyTransition,
  assertTransition,
  canTransition,
  isTerminal,
} from './state-machine.js';

export {
  BUDGET_DEFAULTS,
  BUDGET_LIMITS,
  KNOWN_STOP_CONDITIONS,
  MANDATORY_STOP_CONDITIONS,
  PRECONDITION_KINDS,
  SOURCES,
  TRIGGERS,
  createDirectiveStore,
  rowToDirective,
} from './directives.js';

export { DEFAULT_LEASE_MS, SKIP_REASONS, STOP_OUTCOMES, STOP_REASONS, createScheduler } from './scheduler.js';

export { ACTION_FAILURE_REASONS, ACTION_LABELS, createActionRegistry } from './actions.js';

export {
  INTERNAL_BUDGET_CAPS,
  INTERNAL_BUDGET_DEFAULTS,
  INTERNAL_MAX_LEVEL,
  createAutonomy,
} from './autonomy.js';

export {
  DirectivesArgumentError,
  DirectivesError,
  DirectivesNotFoundError,
  InvalidTransitionError,
  PermissionEscalationError,
} from './errors.js';

export { buildDryRunReport, renderDryRunReport, createReadOnlyWorkspace, runDryRunCli } from './dry-run.js';
