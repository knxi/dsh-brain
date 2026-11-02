// @ts-check
/**
 * 指令对象（`directives`）的 CRUD 与"谁该跑"的判定。
 *
 * ## 一条指令是什么
 *
 * 一个**有人批过 / 或主人亲手建**的长期意图，带上：
 * - 权限范围（`permission_scope`，L0~L3）；
 * - 动作白名单（`allowed_tools_json`，只能是 permissions.js 里那六个内置动作）；
 * - 三项预算（步数 / 秒数 / token）与重试上限；
 * - 生效前置条件、失效时间、停止条件；
 * - **幂等键**（`idempotency_key`，必填）。
 *
 * ## 三条纪律
 *
 * 1. **幂等键必填**。没有它，重启后重复创建同一件事是最经典的伤害
 *    （"怎么又做了一遍"）。同 key 重复创建返回已存在那条，**不新建、不覆盖**。
 * 2. **创建是惰性的**。`create()` 只写库不做任何调度：新指令一律从 `proposed`
 *    开始，要进 `queued` 必须再走一次显式转移（人批 / 主人自己批）。这条让
 *    "这条指令是谁放行的"永远能回答。
 * 3. **反扩权**。带 `parentGoalId` 时，子指令的等级 / 预算 / 动作集合都必须 ⊆ 父，
 *    违规抛 `PermissionEscalationError`，整事务回滚（不留半条子指令）。
 *
 * ## `allowed_tools_json` 为什么装的是"动作"
 *
 * 迁移 0008 已固定列名，不能加列。在本系统里"允许这个指令用的能力"与
 * "允许这个指令做的动作"本来就是同一个集合（本模块不调外部工具），所以这一列
 * 就是**指令的动作白名单**，顺序即执行顺序。好处是权限收口只有一处：
 * `assertAllowedTools` 校验完之后，调度器只需要照单执行。
 */

import {
  DirectivesArgumentError,
  DirectivesNotFoundError,
  InvalidTransitionError,
  assertArgument,
} from './errors.js';
import { createSimpleTxApi, newId, nowMsOf, safeJson, writeThrough } from './util.js';
import {
  ACTION_TABLE,
  EXECUTABLE_ACTION_NAMES,
  assertAllowedTools,
  assertNoEscalation,
  levelRank,
} from './permissions.js';

/** 触发来源（与迁移 CHECK 一致）。 */
export const TRIGGERS = Object.freeze(['manual', 'schedule', 'event', 'idle', 'commitment']);

/** 指令来源（与迁移 CHECK 一致）。 */
export const SOURCES = Object.freeze(['owner', 'internal', 'maintenance']);

/** 预算默认值（与迁移默认值一致，改这里要同步迁移与文档）。 */
export const BUDGET_DEFAULTS = Object.freeze({ stepBudget: 10, timeBudgetSeconds: 300, tokenBudget: 20000 });

/** 预算硬上限：防止一条指令把机器锁死（不是安全边界，是钝器保护）。 */
export const BUDGET_LIMITS = Object.freeze({ stepBudget: 1000, timeBudgetSeconds: 86400, tokenBudget: 1_000_000 });

/** 重试上限（数据库允许更大，但这里不允许无限重试）。 */
export const MAX_RETRIES_LIMIT = 10;

/**
 * 停止条件里**永远生效**的那几条。
 *
 * 迁移里的 `stop_conditions_json` 是一个列表，看起来像"可以关掉某些停止条件"。
 * 这是**故意的误解陷阱**：允许"关掉预算停止"就等于允许无限跑。
 * 所以这里的口径是——**这张表只能加严，不能放松**：
 * 下面这几条无论 JSON 里写了什么都会生效，JSON 里写它们只是为了可读性。
 */
export const MANDATORY_STOP_CONDITIONS = Object.freeze([
  'owner_interrupted', // 全局暂停 / 自主关闭 —— 主人说停就停
  'missing_required_permission', // 等级不够 / 动作不在白名单
  'budget_exhausted', // 步数 / token 用尽
  'time_exhausted', // 时间用尽
  'valid_until_passed', // 过期
]);

/** 认识的停止条件名（未知名字只记录不生效，因为强制集已经覆盖了所有危险面）。 */
export const KNOWN_STOP_CONDITIONS = Object.freeze([
  ...MANDATORY_STOP_CONDITIONS,
  'goal_completed',
  'hook_missing',
  'action_failed',
  'step_cap_reached',
  'lease_expired',
]);

/** 前置条件的种类（未知种类一律判不满足 = 失败关）。 */
export const PRECONDITION_KINDS = Object.freeze([
  'always', // 恒真。只用于演示与测试：生产指令应写具体条件
  'not_paused', // 全局未暂停
  'autonomy_enabled', // autonomy.enabled = '1'
  'switch', // 指定开关等于指定值：{ kind:'switch', name:'x', equals:'1' }
  'time_window', // 本地时间在窗口内：{ kind:'time_window', from:'09:00', to:'18:00' }
  'after', // now >= at
  'budget_left', // 剩余步数 >= steps
]);

/**
 * 数据库行 → 对外对象（camelCase + 解析好的 JSON）。
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function rowToDirective(row) {
  const preconditions = safeJson(row.preconditions_json, []);
  const allowedTools = safeJson(row.allowed_tools_json, []);
  const stopConditions = safeJson(row.stop_conditions_json, []);
  const stepBudget = Number(row.step_budget ?? 0);
  const tokenBudget = Number(row.token_budget ?? 0);
  const stepsUsed = Number(row.steps_used ?? 0);
  const tokensUsed = Number(row.tokens_used ?? 0);
  return {
    id: String(row.id),
    scopeId: String(row.scope_id),
    source: String(row.source),
    parentGoalId: row.parent_goal_id === null || row.parent_goal_id === undefined ? null : String(row.parent_goal_id),
    title: String(row.title),
    reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
    trigger: String(row.trigger),
    priority: Number(row.priority ?? 0),
    preconditions: Array.isArray(preconditions) ? preconditions : [],
    allowedTools: Array.isArray(allowedTools) ? allowedTools.map(String) : [],
    permissionScope: String(row.permission_scope),
    budgets: { step: stepBudget, timeSeconds: Number(row.time_budget_seconds ?? 0), token: tokenBudget },
    usage: { stepsUsed, tokensUsed, attempts: Number(row.attempts ?? 0) },
    remaining: {
      steps: Math.max(0, stepBudget - stepsUsed),
      tokens: Math.max(0, tokenBudget - tokensUsed),
    },
    maxRetries: Number(row.max_retries ?? 0),
    validUntil: row.valid_until === null || row.valid_until === undefined ? null : String(row.valid_until),
    stopConditions: Array.isArray(stopConditions) ? stopConditions.map(String) : [],
    status: String(row.status),
    stepsUsed,
    tokensUsed,
    attempts: Number(row.attempts ?? 0),
    lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    idempotencyKey: String(row.idempotency_key),
    version: Number(row.version ?? 1),
    createdBy: row.created_by === null || row.created_by === undefined ? null : String(row.created_by),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
  };
}

/**
 * 校验创建入参（纯函数，进事务之前跑，不合法连事务都不开）。
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
function validateCreateInput(input) {
  assertArgument(input !== null && typeof input === 'object', 'create 需要参数对象', { reason: 'invalid_input' });

  const title = typeof input.title === 'string' ? input.title.trim() : '';
  assertArgument(title.length > 0, 'title 必填', { reason: 'title_required', field: 'title' });
  assertArgument(title.length <= 200, 'title 太长（>200）', { reason: 'title_too_long', field: 'title' });

  // ---- 幂等键必填（最要紧的一条）----
  const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
  assertArgument(idempotencyKey.length > 0, 'idempotencyKey 必填：没有幂等键就无法防重启重复创建', {
    reason: 'idempotency_key_required',
    field: 'idempotencyKey',
  });
  assertArgument(idempotencyKey.length <= 200, 'idempotencyKey 太长（>200）', {
    reason: 'idempotency_key_too_long',
    field: 'idempotencyKey',
  });

  const reason = input.reason === undefined || input.reason === null ? null : String(input.reason).slice(0, 1000);
  const trigger = input.trigger === undefined || input.trigger === null ? 'manual' : String(input.trigger);
  assertArgument(TRIGGERS.includes(trigger), `trigger 必须是 ${TRIGGERS.join('/')} 之一`, {
    reason: 'invalid_trigger',
    field: 'trigger',
    value: trigger,
  });
  const source = input.source === undefined || input.source === null ? 'owner' : String(input.source);
  assertArgument(SOURCES.includes(source), `source 必须是 ${SOURCES.join('/')} 之一`, {
    reason: 'invalid_source',
    field: 'source',
    value: source,
  });

  const priorityRaw = input.priority === undefined || input.priority === null ? 40 : Number(input.priority);
  assertArgument(Number.isFinite(priorityRaw) && priorityRaw >= 0 && priorityRaw <= 100, 'priority 必须是 0~100 的整数', {
    reason: 'invalid_priority',
    field: 'priority',
  });
  const priority = Math.trunc(priorityRaw);

  const scopeRaw = input.permissionScope === undefined || input.permissionScope === null ? 'L0' : String(input.permissionScope).toUpperCase();
  assertArgument(levelRank(scopeRaw) >= 0, `permissionScope 必须是 L0~L3 之一（收到 ${scopeRaw}）`, {
    reason: 'invalid_permission_scope',
    field: 'permissionScope',
    value: scopeRaw,
  });

  // ---- 三项预算必须 > 0（0 等于"创建了一条永远做不了一件事的指令"）----
  /** @type {Array<['stepBudget' | 'timeBudgetSeconds' | 'tokenBudget', string]>} */
  const budgetFields = [
    ['stepBudget', 'step'],
    ['timeBudgetSeconds', 'time'],
    ['tokenBudget', 'token'],
  ];
  const budgets = {};
  for (const [field, short] of budgetFields) {
    const raw = input[field] === undefined || input[field] === null ? BUDGET_DEFAULTS[field] : Number(input[field]);
    assertArgument(Number.isFinite(raw) && raw > 0, `${field} 必须 > 0（收到 ${String(input[field])}）`, {
      reason: 'budget_not_positive',
      field,
      value: input[field] ?? null,
    });
    const limit = BUDGET_LIMITS[field];
    assertArgument(raw <= limit, `${field} 超过硬上限 ${limit}`, {
      reason: 'budget_out_of_range',
      field,
      value: raw,
      limit,
    });
    budgets[field] = Math.trunc(raw);
    budgets[`${short}Budget`] = Math.trunc(raw);
  }
  // 上面的双写只是为了让 validate 返回值里三种叫法都能取到；实际只用 field 名。

  const maxRetriesRaw = input.maxRetries === undefined || input.maxRetries === null ? 2 : Number(input.maxRetries);
  assertArgument(
    Number.isFinite(maxRetriesRaw) && maxRetriesRaw >= 0 && maxRetriesRaw <= MAX_RETRIES_LIMIT,
    `maxRetries 必须是 0~${MAX_RETRIES_LIMIT} 的整数`,
    { reason: 'invalid_max_retries', field: 'maxRetries' },
  );

  let validUntil = null;
  if (input.validUntil !== undefined && input.validUntil !== null && input.validUntil !== '') {
    const ms = Date.parse(String(input.validUntil));
    assertArgument(Number.isFinite(ms), 'validUntil 不是合法时刻', {
      reason: 'invalid_valid_until',
      field: 'validUntil',
      value: input.validUntil,
    });
    validUntil = new Date(ms).toISOString();
  }

  // ---- 前置条件：只校验形状，语义在执行期判定（未知种类=不满足）----
  const preconditionsRaw = input.preconditions === undefined || input.preconditions === null ? [] : input.preconditions;
  assertArgument(Array.isArray(preconditionsRaw), 'preconditions 必须是数组', {
    reason: 'invalid_preconditions',
    field: 'preconditions',
  });
  for (const item of preconditionsRaw) {
    assertArgument(item !== null && typeof item === 'object' && !Array.isArray(item), 'preconditions 的每一项都必须是对象', {
      reason: 'invalid_preconditions',
      field: 'preconditions',
    });
    assertArgument(typeof item.kind === 'string' && item.kind.length > 0, 'preconditions 的每一项都必须有 kind', {
      reason: 'invalid_preconditions',
      field: 'preconditions',
    });
  }

  // ---- 动作白名单：不在白名单 / 越级的动作，连"声明"都不允许 ----
  const allowedTools = assertAllowedTools(input.allowedTools, { level: scopeRaw });

  const stopConditionsRaw =
    input.stopConditions === undefined || input.stopConditions === null
      ? ['goal_completed', 'owner_interrupted', 'missing_required_permission']
      : input.stopConditions;
  assertArgument(Array.isArray(stopConditionsRaw), 'stopConditions 必须是数组', {
    reason: 'invalid_stop_conditions',
    field: 'stopConditions',
  });
  const stopConditions = stopConditionsRaw.map(String);

  const parentGoalId =
    input.parentGoalId === undefined || input.parentGoalId === null || input.parentGoalId === ''
      ? null
      : String(input.parentGoalId);
  const createdBy = input.createdBy === undefined || input.createdBy === null ? null : String(input.createdBy);

  return {
    title,
    reason,
    trigger,
    source,
    priority,
    permissionScope: scopeRaw,
    stepBudget: budgets.stepBudget,
    timeBudgetSeconds: budgets.timeBudgetSeconds,
    tokenBudget: budgets.tokenBudget,
    maxRetries: Math.trunc(maxRetriesRaw),
    validUntil,
    preconditions: preconditionsRaw,
    allowedTools,
    stopConditions,
    parentGoalId,
    idempotencyKey,
    createdBy,
  };
}

/**
 * 造指令对象门面（纯 CRUD + 资格判定，**不执行任何动作**）。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   workspace?: Record<string, any> | null,
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   scopeId: string,
 *   stateMachine?: ReturnType<typeof import('./state-machine.js').createStateMachine> | null,
 * }} options
 */
export function createDirectiveStore(options) {
  const { db, queue, clock } = options;
  const scopeId = String(options.scopeId);
  const workspace = options.workspace ?? null;
  const alert = options.alert ?? (() => {});
  const reader = createSimpleTxApi(db);

  if (stateMachineMissing(options.stateMachine)) {
    alert({
      kind: 'directives_state_machine_missing',
      message: '指令门面没有注入 stateMachine：pause/resume/cancel/approve 会明确失败（不静默跳过）',
      detail: { scopeId },
    });
  }

  /**
   * @param {unknown} value
   * @returns {boolean}
   */
  function stateMachineMissing(value) {
    return value === null || value === undefined || typeof value !== 'object' || typeof (/** @type {any} */ (value).transition) !== 'function';
  }

  /**
   * 取状态机；缺失就抛（**不静默跳过**：状态变更没做成却返回成功，是这里最不能犯的错）。
   * @param {string} action
   */
  function requireStateMachine(action) {
    const sm = options.stateMachine;
    if (sm === null || sm === undefined || typeof sm.transition !== 'function') {
      throw new DirectivesArgumentError(`${action} 需要 stateMachine：门面没有注入它`, {
        reason: 'state_machine_missing',
        action,
      });
    }
    return sm;
  }

  /**
   * 读一行（scope 收口）。
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
   * 取一条指令。跨 scope 返回 `null`（当不存在，不泄露其它 scope 有没有）。
   * @param {string} id
   * @returns {Record<string, any> | null}
   */
  function get(id) {
    const row = readRow(id);
    return row === undefined ? null : rowToDirective(row);
  }

  /**
   * 列表。默认**包含**终态（UI 要历史），`status` 可传字符串或数组。
   * @param {{ status?: string | string[], source?: string, limit?: number, includeTerminal?: boolean, parentGoalId?: string }} [query]
   * @returns {{ items: Array<Record<string, any>>, limit: number }}
   */
  function list(query = {}) {
    const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
    /** @type {string[]} */
    const where = ['scope_id = ?'];
    /** @type {any[]} */
    const params = [scopeId];
    if (query.status !== undefined && query.status !== null && query.status !== '') {
      const statuses = Array.isArray(query.status) ? query.status.map(String) : [String(query.status)];
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    } else if (query.includeTerminal === false) {
      where.push("status NOT IN ('completed', 'failed', 'cancelled')");
    }
    if (query.source !== undefined && query.source !== null && query.source !== '') {
      where.push('source = ?');
      params.push(String(query.source));
    }
    if (query.parentGoalId !== undefined && query.parentGoalId !== null && query.parentGoalId !== '') {
      where.push('parent_goal_id = ?');
      params.push(String(query.parentGoalId));
    }
    const rows = reader.all(
      `SELECT * FROM directives WHERE ${where.join(' AND ')}
        ORDER BY priority DESC, created_at ASC, id ASC LIMIT ?`,
      [...params, limit],
    );
    return { items: rows.map(rowToDirective), limit };
  }

  /**
   * 创建一条指令（幂等）。
   *
   * 返回 `{ created, id, directive, parentGoalId }`：
   * - `created: true` → 新建成功；
   * - `created: false` → 同 scope 同 `idempotencyKey` 已存在，返回既有那条（**不覆盖**）。
   *
   * @param {Record<string, any>} input
   * @returns {Promise<{ created: boolean, id: string, directive: Record<string, any>, reusedReason?: string }>}
   */
  async function create(input) {
    const spec = validateCreateInput(input);
    return writeThrough(queue, (tx) => {
      const stamp = clock.stamp();

      // ---- 幂等：同 key 已存在 → 返回既有的，不新建 ----
      const existing = /** @type {Record<string, any> | undefined} */ (
        tx.get('SELECT * FROM directives WHERE scope_id = ? AND idempotency_key = ?', [scopeId, spec.idempotencyKey])
      );
      if (existing !== undefined) {
        tx.run(
          `INSERT INTO audit_logs (
             audit_id, ts, ts_local, actor, action, target_kind, target_id, scope_id,
             result, detail, trace_id, deletion_epoch
           ) VALUES (?, ?, ?, ?, 'directive.create_reused', 'directive', ?, ?, 'ok', ?, NULL, NULL)`,
          [
            newId('aud'),
            stamp.utc,
            stamp.local,
            spec.createdBy ?? 'owner',
            String(existing.id),
            scopeId,
            JSON.stringify({
              idempotency_key: spec.idempotencyKey,
              mismatch: String(existing.title) !== spec.title,
              requested_title: spec.title.slice(0, 120),
            }),
          ],
        );
        return {
          created: /** @type {const} */ (false),
          id: String(existing.id),
          directive: rowToDirective(existing),
          reusedReason: 'idempotency_key_exists',
        };
      }

      // ---- 反扩权：有父就逐项比 ----
      if (spec.parentGoalId !== null) {
        const parent = readRow(spec.parentGoalId, { tx });
        if (parent === undefined) {
          throw new DirectivesNotFoundError('父指令不存在（或不属于当前 scope）：拒绝建立子指令', {
            targetKind: 'directive',
            targetId: spec.parentGoalId,
            scopeId,
          });
        }
        if (String(parent.status) === 'cancelled' || String(parent.status) === 'failed') {
          throw new DirectivesArgumentError(`父指令处于 ${String(parent.status)}，不允许再派生新的子指令`, {
            reason: 'parent_terminal',
            field: 'parentGoalId',
            parentStatus: String(parent.status),
          });
        }
        // 违规会抛 PermissionEscalationError，整个事务回滚（不留半条子指令）。
        assertNoEscalation({ parent, child: spec });
      }

      const id = newId('dir');
      tx.run(
        `INSERT INTO directives (
           id, scope_id, source, parent_goal_id, title, reason, trigger, priority,
           preconditions_json, allowed_tools_json, permission_scope,
           step_budget, time_budget_seconds, token_budget, max_retries,
           valid_until, stop_conditions_json, status,
           steps_used, tokens_used, attempts, last_error,
           idempotency_key, version, created_by,
           created_at, created_at_local, updated_at, updated_at_local, finished_at
         ) VALUES (
           ?, ?, ?, ?, ?, ?, ?, ?,
           ?, ?, ?,
           ?, ?, ?, ?,
           ?, ?, 'proposed',
           0, 0, 0, NULL,
           ?, 1, ?,
           ?, ?, ?, ?, NULL
         )`,
        [
          id,
          scopeId,
          spec.source,
          spec.parentGoalId,
          spec.title,
          spec.reason,
          spec.trigger,
          spec.priority,
          JSON.stringify(spec.preconditions),
          JSON.stringify(spec.allowedTools),
          spec.permissionScope,
          spec.stepBudget,
          spec.timeBudgetSeconds,
          spec.tokenBudget,
          spec.maxRetries,
          spec.validUntil,
          JSON.stringify(spec.stopConditions),
          spec.idempotencyKey,
          spec.createdBy,
          stamp.utc,
          stamp.local,
          stamp.utc,
          stamp.local,
        ],
      );

      tx.run(
        `INSERT INTO audit_logs (
           audit_id, ts, ts_local, actor, action, target_kind, target_id, scope_id,
           result, detail, trace_id, deletion_epoch
         ) VALUES (?, ?, ?, ?, 'directive.created', 'directive', ?, ?, 'ok', ?, NULL, NULL)`,
        [
          newId('aud'),
          stamp.utc,
          stamp.local,
          spec.createdBy ?? (spec.source === 'internal' ? 'autonomy' : 'owner'),
          id,
          scopeId,
          JSON.stringify({
            source: spec.source,
            trigger: spec.trigger,
            priority: spec.priority,
            permission_scope: spec.permissionScope,
            allowed_tools: spec.allowedTools,
            parent_goal_id: spec.parentGoalId,
            budgets: {
              step: spec.stepBudget,
              time_seconds: spec.timeBudgetSeconds,
              token: spec.tokenBudget,
            },
          }),
        ],
      );

      const row = readRow(id, { tx });
      return { created: /** @type {const} */ (true), id, directive: rowToDirective(/** @type {any} */ (row)) };
    },
    { label: 'directives.create' },
  );
}

  /**
   * 批准：`awaiting_approval → queued`。
   *
   * 严格（不幂等）：状态不是 `awaiting_approval` 就抛 `InvalidTransitionError`。
   * 理由——批准是一次**有后果的人工动作**，对错误状态说"批准成功"会让人以为批过了。
   *
   * @param {string} id
   * @param {{ by?: string, reason?: string }} [opts]
   * @returns {Promise<{ id: string, from: string, to: string, changed: true }>}
   */
  async function approve(id, opts = {}) {
    const sm = requireStateMachine('approve');
    const row = readRow(id);
    if (row === undefined) {
      throw new DirectivesNotFoundError('指令不存在（或不属于当前 scope）', { targetKind: 'directive', targetId: id, scopeId });
    }
    if (String(row.status) !== 'awaiting_approval') {
      // 注意：这里不能复用 `assertTransition(status, 'queued')`——`proposed → queued`
      // 在合法表里，那样 approve 就变成"任何状态都能批准"。批准的语义是
      // **只对等待批准的那一条生效**，所以这里显式要求状态精确匹配。
      throw new InvalidTransitionError(`只有 awaiting_approval 的指令才能批准（当前 ${String(row.status)}）`, {
        from: String(row.status),
        to: 'queued',
        allowed: ['awaiting_approval'],
        reason: 'not_awaiting_approval',
      });
    }
    return sm.transition({ id: String(id), to: 'queued', reason: opts.reason ?? 'approved', by: opts.by ?? 'owner' });
  }

  /**
   * 暂停。宽容：已经 paused → `{ changed: false }`；终态 → 抛错。
   * @param {string} id
   * @param {{ by?: string, reason?: string }} [opts]
   */
  async function pause(id, opts = {}) {
    const sm = requireStateMachine('pause');
    const row = readRow(id);
    if (row === undefined) {
      throw new DirectivesNotFoundError('指令不存在（或不属于当前 scope）', { targetKind: 'directive', targetId: id, scopeId });
    }
    const status = String(row.status);
    if (status === 'paused') return { id: String(id), from: status, to: status, changed: /** @type {const} */ (false) };
    sm.assertTransition(status, 'paused');
    return sm.transition({ id: String(id), to: 'paused', reason: opts.reason ?? 'paused_by_owner', by: opts.by ?? 'owner' });
  }

  /**
   * 恢复：`paused → queued`（**不直接回 running**：那等于绕过"谁认领"这件事）。
   * @param {string} id
   * @param {{ by?: string, reason?: string }} [opts]
   */
  async function resume(id, opts = {}) {
    const sm = requireStateMachine('resume');
    const row = readRow(id);
    if (row === undefined) {
      throw new DirectivesNotFoundError('指令不存在（或不属于当前 scope）', { targetKind: 'directive', targetId: id, scopeId });
    }
    const status = String(row.status);
    if (status === 'queued') return { id: String(id), from: status, to: status, changed: /** @type {const} */ (false) };
    sm.assertTransition(status, 'queued');
    return sm.transition({ id: String(id), to: 'queued', reason: opts.reason ?? 'resumed_by_owner', by: opts.by ?? 'owner' });
  }

  /**
   * 取消。宽容：已经 cancelled → `{ changed: false }`；completed/failed → 抛错
   * （"取消一条已经完成的指令"是荒谬的，静默成功会让审计说谎）。
   * @param {string} id
   * @param {{ by?: string, reason?: string }} [opts]
   */
  async function cancel(id, opts = {}) {
    const sm = requireStateMachine('cancel');
    const row = readRow(id);
    if (row === undefined) {
      throw new DirectivesNotFoundError('指令不存在（或不属于当前 scope）', { targetKind: 'directive', targetId: id, scopeId });
    }
    const status = String(row.status);
    if (status === 'cancelled') return { id: String(id), from: status, to: status, changed: /** @type {const} */ (false) };
    sm.assertTransition(status, 'cancelled');
    return sm.transition({ id: String(id), to: 'cancelled', reason: opts.reason ?? 'cancelled_by_owner', by: opts.by ?? 'owner' });
  }

  /**
   * 判定前置条件是否满足。**未知种类一律判不满足**（失败关）：
   * 与其假设"没见过的条件应该没事"，不如让它停下来等人看清楚。
   *
   * @param {Record<string, any>} directive
   * @param {{ nowMs: number }} opts
   * @returns {{ ok: boolean, failedKind?: string, reason?: string, checked: Array<{ kind: string, ok: boolean, detail?: string }> }}
   */
  function evaluatePreconditions(directive, opts) {
    const nowMs = Number(opts.nowMs);
    /** @type {Array<{ kind: string, ok: boolean, detail?: string }>} */
    const checked = [];
    for (const item of directive.preconditions ?? []) {
      const kind = String(item?.kind ?? '');
      if (kind === 'always') {
        checked.push({ kind, ok: true });
        continue;
      }
      if (workspace === null || workspace === undefined) {
        checked.push({ kind, ok: false, detail: 'workspace_missing' });
        return { ok: false, failedKind: kind, reason: 'workspace_missing', checked };
      }
      switch (kind) {
        case 'not_paused': {
          const ok = !workspace.isPaused();
          checked.push({ kind, ok });
          if (!ok) return { ok: false, failedKind: kind, reason: 'global_paused', checked };
          break;
        }
        case 'autonomy_enabled': {
          const ok = workspace.isEnabled('autonomy.enabled');
          checked.push({ kind, ok });
          if (!ok) return { ok: false, failedKind: kind, reason: 'autonomy_disabled', checked };
          break;
        }
        case 'switch': {
          const name = String(item?.name ?? '');
          const equals = String(item?.equals ?? '1');
          const actual = workspace.getSwitch(name);
          const ok = String(actual) === equals;
          checked.push({ kind, ok, detail: `${name}=${String(actual)} (期望 ${equals})` });
          if (!ok) return { ok: false, failedKind: kind, reason: 'switch_mismatch', checked };
          break;
        }
        case 'time_window': {
          const from = parseHhMm(item?.from);
          const to = parseHhMm(item?.to);
          if (from === null || to === null) {
            checked.push({ kind, ok: false, detail: 'invalid_window' });
            return { ok: false, failedKind: kind, reason: 'invalid_window', checked };
          }
          const local = clock.stamp().local;
          const minute = Number(local.slice(11, 13)) * 60 + Number(local.slice(14, 16));
          const ok = from <= to ? minute >= from && minute < to : minute >= from || minute < to;
          checked.push({ kind, ok, detail: `${local.slice(11, 16)} in [${item.from},${item.to})` });
          if (!ok) return { ok: false, failedKind: kind, reason: 'outside_time_window', checked };
          break;
        }
        case 'after': {
          const at = Date.parse(String(item?.at ?? ''));
          const ok = Number.isFinite(at) ? nowMs >= at : false;
          checked.push({ kind, ok, detail: String(item?.at ?? '') });
          if (!ok) return { ok: false, failedKind: kind, reason: 'not_yet', checked };
          break;
        }
        case 'budget_left': {
          const wanted = Number(item?.steps ?? 1);
          const ok = directive.remaining.steps >= (Number.isFinite(wanted) ? wanted : 1);
          checked.push({ kind, ok, detail: `remaining=${directive.remaining.steps}` });
          if (!ok) return { ok: false, failedKind: kind, reason: 'budget_exhausted', checked };
          break;
        }
        default: {
          // 未知前置条件：不认识就不放行。
          checked.push({ kind, ok: false, detail: 'unknown_precondition' });
          return { ok: false, failedKind: kind, reason: 'unknown_precondition', checked };
        }
      }
    }
    return { ok: true, checked };
  }

  /**
   * 事务内版本：挑出"现在可以跑"的指令。
   *
   * 判定顺序（顺序即优先级）：
   * 1. `status = 'queued'`（终态/运行中/待批的都不算）
   * 2. `valid_until` 未过期
   * 3. 前置条件满足
   * 4. 需要的等级 ≤ 当前允许的最高等级
   *
   * 排序 `priority DESC, created_at ASC, id ASC`——`id` 是稳定的兜底键，
   * 同一毫秒创建的两条指令不会因为 SQLite 不保证稳定排序而抖动。
   *
   * @param {any} tx
   * @param {{ limit?: number, nowMs: number, maxLevel?: string | null }} opts
   * @returns {{ items: Array<Record<string, any>>, rejected: Array<Record<string, any>>, scanned: number }}
   */
  function nextEligibleIn(tx, opts) {
    const limit = Math.min(Math.max(Number(opts.limit) || 1, 1), 50);
    const maxLevel = opts.maxLevel === undefined || opts.maxLevel === null ? null : String(opts.maxLevel);
    const scan = Math.min(500, Math.max(limit * 10, 20));
    const rows = tx.all(
      `SELECT * FROM directives WHERE scope_id = ? AND status = 'queued'
        ORDER BY priority DESC, created_at ASC, id ASC LIMIT ?`,
      [scopeId, scan],
    );
    /** @type {Array<Record<string, any>>} */
    const items = [];
    /** @type {Array<Record<string, any>>} */
    const rejected = [];
    for (const row of rows) {
      const directive = rowToDirective(row);
      if (directive.validUntil !== null && Date.parse(directive.validUntil) <= opts.nowMs) {
        rejected.push({ id: directive.id, title: directive.title, reason: 'valid_until_passed', detail: directive.validUntil });
        continue;
      }
      const pre = evaluatePreconditions(directive, { nowMs: opts.nowMs });
      if (!pre.ok) {
        rejected.push({
          id: directive.id,
          title: directive.title,
          reason: `precondition_failed:${pre.failedKind}`,
          detail: pre.reason ?? null,
        });
        continue;
      }
      if (maxLevel !== null && levelRank(maxLevel) < levelRank(directive.permissionScope)) {
        rejected.push({
          id: directive.id,
          title: directive.title,
          reason: 'missing_required_permission',
          detail: { required: directive.permissionScope, maxLevel },
        });
        continue;
      }
      if (items.length < limit) items.push(directive);
    }
    return { items, rejected, scanned: rows.length };
  }

  /**
   * 只读版本（不开事务）：`nextEligible({ limit })`。
   * @param {{ limit?: number, now?: any, maxLevel?: string | null }} [query]
   */
  function nextEligible(query = {}) {
    const nowMs = nowMsOf(query.now, clock);
    return nextEligibleIn(reader, { limit: query.limit ?? 10, nowMs, maxLevel: query.maxLevel ?? null });
  }

  /**
   * 预算快照（给调度器与 dry-run 共用）。
   * @param {Record<string, any>} directive
   */
  function budgetOf(directive) {
    return {
      steps: { used: directive.stepsUsed, budget: directive.budgets.step, remaining: directive.remaining.steps },
      tokens: { used: directive.tokensUsed, budget: directive.budgets.token, remaining: directive.remaining.tokens },
      timeSeconds: directive.budgets.timeSeconds,
    };
  }

  /**
   * 统计（给面板 / dry-run 用）。
   * @returns {Record<string, number>}
   */
  function stats() {
    /** @type {Record<string, number>} */
    const out = {};
    for (const status of ['proposed', 'awaiting_approval', 'queued', 'running', 'paused', 'blocked', 'completed', 'failed', 'cancelled']) {
      out[status] = 0;
    }
    for (const row of reader.all('SELECT status, COUNT(*) AS n FROM directives WHERE scope_id = ? GROUP BY status', [scopeId])) {
      out[String(row.status)] = Number(row.n ?? 0);
    }
    out.total = Object.values(out).reduce((sum, value) => sum + value, 0);
    return out;
  }

return {
  scopeId,
  create,
  get,
  list,
  stats,
  approve,
  pause,
  resume,
  cancel,
  nextEligible,
  nextEligibleIn,
  evaluatePreconditions,
  budgetOf,
  readRow,
  rowToDirective,
  constants: {
    TRIGGERS,
    SOURCES,
    BUDGET_DEFAULTS,
    BUDGET_LIMITS,
    MAX_RETRIES_LIMIT,
    MANDATORY_STOP_CONDITIONS,
    KNOWN_STOP_CONDITIONS,
    PRECONDITION_KINDS,
    EXECUTABLE_ACTION_NAMES,
    ACTION_TABLE,
    },
  };
}

/**
 * `'09:00'` → 540。非法返回 null（不猜）。
 * @param {unknown} value
 * @returns {number | null}
 */
function parseHhMm(value) {
  const text = String(value ?? '');
  const match = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (match === null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}
