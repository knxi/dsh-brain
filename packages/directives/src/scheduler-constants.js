// @ts-check
/**
 * 调度器的原因码与"停下来之后去哪"的映射表。
 *
 * 单独一个文件的原因很实际：这些字符串是**对外契约**——测试、审计、面板、dry-run
 * 全都按它断言。放在常量文件里，改一个值会让所有引用点一起暴露，而不是散落在
 * 调度器里靠 grep 找。
 */

/**
 * `runOnce()` 返回 `{ skipped: true, reason }` 时的原因码。
 *
 * 注意：**这些原因全部发生在任何写入之前**。看到 `skipped: true` 就意味着
 * directives / directive_runs / directive_steps / audit_logs 四张表一行没动。
 */
export const SKIP_REASONS = Object.freeze({
  /** 全局暂停：`paused='1'`。最高优先级，先于一切判断。 */
  GLOBAL_PAUSED: 'global_paused',
  /** 自主指令总开关没开：`autonomy.enabled != '1'`。 */
  AUTONOMY_DISABLED: 'autonomy_disabled',
  /** `autonomy.max_level` 是个不认识的等级字符串（例如被人写坏成 'L9'）。 */
  MAX_LEVEL_INVALID: 'max_level_invalid',
  /** `autonomy.max_level = 'L0'`：L0 只允许回复，调度器没有任何可执行动作。 */
  MAX_LEVEL_TOO_LOW: 'max_level_too_low',
  /** 没有注入 workspace：失败关，不放行（绝不假设"允许"）。 */
  WORKSPACE_MISSING: 'workspace_missing',
  /** 注入了 workspace 但缺 isPaused/isEnabled/getSwitch 之一。 */
  WORKSPACE_INCOMPLETE: 'workspace_incomplete',
  /** 队列里没有 queued 的指令。 */
  QUEUE_EMPTY: 'queue_empty',
  /** 认领时发现指令已不在 queued（另一个 owner 抢先）。 */
  CLAIM_RACE_LOST: 'claim_race_lost',
});

/**
 * 停止原因。写进 `directive_runs.stop_reason` 与最后一条 `kind='stop'` 的步骤摘要。
 */
export const STOP_REASONS = Object.freeze({
  /** 计划里的动作全跑完了。这是唯一的"正常完成"。 */
  GOAL_COMPLETED: 'goal_completed',
  /** 主人打断了（全局暂停 / 自主开关被关）：指令回 `paused`，可恢复。 */
  OWNER_INTERRUPTED: 'owner_interrupted',
  /** 等级不够、动作不在白名单、或指令没声明任何动作。 */
  MISSING_REQUIRED_PERMISSION: 'missing_required_permission',
  /** 步数或 token 预算用尽。 */
  BUDGET_EXHAUSTED: 'budget_exhausted',
  /** 时间预算用尽。 */
  TIME_EXHAUSTED: 'time_exhausted',
  /** `valid_until` 已过。过期是终态（要重做请新建指令）。 */
  VALID_UNTIL_PASSED: 'valid_until_passed',
  /** 动作没有接线（缺 hook）。**不是失败，是配置缺失**：进 blocked，等人接。 */
  HOOK_MISSING: 'hook_missing',
  /** 动作执行失败（hook 抛错或 hook 报 ok:false）。可重试，重试用尽才进 failed。 */
  ACTION_FAILED: 'action_failed',
  /** 这一轮达到 maxSteps 上限而计划还没跑完。可重试。 */
  STEP_CAP_REACHED: 'step_cap_reached',
  /** 租约过期（进程崩溃 / 重启后被回收）。 */
  LEASE_EXPIRED: 'lease_expired',
  /** 没有 workspace：不放行。 */
  WORKSPACE_MISSING: 'workspace_missing',
});

/**
 * 停止原因 → （run 终态，指令目标状态，是否可重试）。
 *
 * `retryable: true` 时，收尾会去数这个指令历史上失败/超时的 run 次数：
 * - 次数 ≤ max_retries → 指令回 `queued`（通过 blocked 中转，让每次都留审计）；
 * - 次数 > max_retries → 指令进 `exhaustedTarget`。
 *
 * 「running → queued」不在合法转移表里，所以重试路径永远是
 * `running → blocked → queued` 两条审计，而不是偷偷改回队列。
 */
export const STOP_OUTCOMES = Object.freeze({
  goal_completed: Object.freeze({ run: 'completed', directive: 'completed', retryable: false }),
  owner_interrupted: Object.freeze({ run: 'cancelled', directive: 'paused', retryable: false }),
  valid_until_passed: Object.freeze({ run: 'failed', directive: 'failed', retryable: false }),
  budget_exhausted: Object.freeze({ run: 'blocked', directive: 'blocked', retryable: false }),
  time_exhausted: Object.freeze({ run: 'timeout', directive: 'blocked', retryable: false }),
  missing_required_permission: Object.freeze({ run: 'blocked', directive: 'blocked', retryable: false }),
  workspace_missing: Object.freeze({ run: 'blocked', directive: 'blocked', retryable: false }),
  hook_missing: Object.freeze({ run: 'blocked', directive: 'blocked', retryable: false }),
  action_failed: Object.freeze({ run: 'failed', directive: 'failed', retryable: true, exhaustedTarget: 'failed' }),
  step_cap_reached: Object.freeze({ run: 'cancelled', directive: 'queued', retryable: true, exhaustedTarget: 'blocked' }),
  lease_expired: Object.freeze({ run: 'timeout', directive: 'queued', retryable: true, exhaustedTarget: 'blocked' }),
});
