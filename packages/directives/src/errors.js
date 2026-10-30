// @ts-check
/**
 * 系统 5 的错误类型。
 *
 * ── 为什么不用 `@dsh-brain/core` 的 BrainError ──
 *
 * 这个包刻意**零运行时依赖**（理由见 index.js 文件头）：系统 5 是权限与停止的执行侧，
 * 它需要能在「宿主的依赖图还没装好」的情况下被单独加载。所以错误类型在这里自建，
 * 但形状与 `BrainError` 保持一致（`name` / `code` / `details` / `toJSON()`），
 * 上层统一按 `err.code` 分支处理即可，不需要认类名。
 *
 * ── 边界 ──
 *
 * 错误消息里**只放字段名、等级、动作名与原因码**：不放指令正文、不放记忆内容、
 * 不放凭据。审计与告警会把这些错误序列化落库，消息里带正文等于另开一个泄露面。
 */

/**
 * 所有系统 5 错误的父类。
 *
 * `code` 是稳定的机器可读原因码；`details` 只放 ID / 字段名 / 等级 / 原因码。
 */
export class DirectivesError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{ details?: Record<string, unknown>, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DirectivesError';
    this.code = code;
    /** @type {Record<string, unknown>} */
    this.details = options.details ?? {};
  }

  /** 供日志 / 审计使用的脱敏摘要（不含 stack、不含正文）。 */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/**
 * 反扩权失败：子指令的权限范围 / 预算 / 动作集合超出父指令。
 *
 * **这是本模块最重要的一条守门**：没有它，一个 L1 指令只要"生个孩子"就能拿到 L3。
 * 违规一律抛出，不做自动下调（自动下调会让扩展尝试静默通过，掩盖越界意图）。
 */
export class PermissionEscalationError extends DirectivesError {
  /**
   * @param {string} message
   * @param {{
   *   kind: 'permission_scope' | 'step_budget' | 'time_budget' | 'token_budget' | 'allowed_tools',
   *   field: string,
   *   parent?: unknown,
   *   child?: unknown,
   *   extraTools?: string[],
   * }} info
   */
  constructor(message, info) {
    super('PERMISSION_ESCALATION', message, { details: { ...info } });
    this.name = 'PermissionEscalationError';
    this.info = info;
  }
}

/**
 * 非法状态转移（含「已是终态还要转」「原地转成自己」）。
 *
 * 状态机的纪律是**严格**：不在合法表里的边一律拒。上层需要的宽容
 * （重复 cancel、重复 pause）由 API 层先判断再返回 `{ changed: false }`，
 * 而不是放松状态机——放松之后，「为什么会到 running」就再也说不清了。
 */
export class InvalidTransitionError extends DirectivesError {
  /**
   * @param {string} message
   * @param {{ from: string, to: string, allowed: string[], terminal?: boolean, reason?: string }} info
   */
  constructor(message, info) {
    super('INVALID_TRANSITION', message, { details: { ...info } });
    this.name = 'InvalidTransitionError';
    this.info = info;
  }
}

/**
 * 目标不存在，或存在但属于别的 scope。
 *
 * 跨 scope **故意不区分**「不存在」与「不是你的」：区分了就等于给出一个探测别的
 * scope 有没有某条指令的接口。所以要两个都报 NOT_FOUND。
 */
export class DirectivesNotFoundError extends DirectivesError {
  /**
   * @param {string} message
   * @param {{ targetKind?: string, targetId?: string, scopeId?: string }} [info]
   */
  constructor(message, info = {}) {
    super('NOT_FOUND', message, { details: { ...info } });
    this.name = 'DirectivesNotFoundError';
  }
}

/**
 * 参数不合法。`reason` 是稳定的机器可读码（如 `action_not_in_whitelist`、
 * `idempotency_key_required`），上层与测试都按它断言。
 */
export class DirectivesArgumentError extends DirectivesError {
  /**
   * @param {string} message
   * @param {{ reason: string, field?: string, [key: string]: unknown }} info
   */
  constructor(message, info) {
    super('INVALID_ARGUMENT', message, { details: { ...info } });
    this.name = 'DirectivesArgumentError';
    this.reason = info.reason;
  }
}

/**
 * 断言帮手：不成立就抛参数错误。
 * @param {unknown} condition
 * @param {string} message
 * @param {{ reason: string, field?: string, [key: string]: unknown }} info
 * @returns {asserts condition}
 */
export function assertArgument(condition, message, info) {
  if (!condition) throw new DirectivesArgumentError(message, info);
}
