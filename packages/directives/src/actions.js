// @ts-check
/**
 * 内置动作执行器 —— **只有白名单里的六个**，每个都走注入 hook。
 *
 * ## 这个文件为什么这么短
 *
 * 因为它刻意「没什么可做的」。系统 5 不实现任意命令执行：
 * 没有 `child_process`、没有 `fs.write`、没有网络请求、没有动态 `import`。
 * 每个动作只做一件事——调用宿主注入的 hook，并把结果**如实**翻译成
 * `{ ok, reason, tokens, summary }`。
 *
 * 判据只有一条，但它是这套系统的良心：
 *
 * > **没接 hook 就返回 `{ ok: false, reason: 'hook_missing' }`。绝不假装成功。**
 *
 * 假装成功的后果很具体：审计里会出现一条"`index_rebuild` 已完成"，而索引其实
 * 一个字节都没动。等哪天有人靠这条审计说"索引是新的"，就会去查一个不存在的 bug。
 *
 * ## 边界
 *
 * - 白名单外的动作名 → `{ ok: false, reason: 'action_not_in_whitelist' }`（不抛，因为
 *   这属于"输入不对"而不是"内部炸了"，调度器要能把它记录成一步失败）。
 * - hook 抛错 → `{ ok: false, reason: 'hook_failed', error }`，错误已在上层留痕。
 * - hook 返回 `{ ok: false }` → 原样上报，**不吞**。
 * - hook 什么都不返回 → 视为"跑完了但没话说"（`ok: true`），并且摘要里明说没结果。
 */

import { ACTION_TABLE, EXECUTABLE_ACTION_NAMES } from './permissions.js';
import { errorLine } from './util.js';

/** 动作的中文短名（面板 / dry-run 用，不参与逻辑）。 */
export const ACTION_LABELS = Object.freeze({
  memory_maintenance: '整理记忆索引',
  index_rebuild: '重建检索索引',
  alert_sweep: '归并健康告警',
  backup_verify: '校验备份可读',
  reflection_run: '触发一次反思',
  skill_rebuild: '重算技能统计',
});

/** 失败原因码（稳定字符串，测试与审计都按它断言）。 */
export const ACTION_FAILURE_REASONS = Object.freeze({
  NOT_IN_WHITELIST: 'action_not_in_whitelist',
  HOOK_MISSING: 'hook_missing',
  HOOK_FAILED: 'hook_failed',
  HOOK_REPORTED_FAILURE: 'hook_reported_failure',
});

/**
 * 造动作执行器。
 *
 * @param {{
 *   hooks?: Record<string, Function> | null,
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 * }} [options]
 */
export function createActionRegistry(options = {}) {
  const hooks = options.hooks ?? {};
  const alert = options.alert ?? (() => {});

  /**
   * hook 是否已接线。
   * @param {string} actionName
   * @returns {boolean}
   */
  function available(actionName) {
    const entry = /** @type {Record<string, any> | undefined} */ (ACTION_TABLE[actionName]);
    if (entry === undefined) return false;
    return typeof hooks[entry.hook] === 'function';
  }

  /**
   * 执行一个动作。
   *
   * `ctx` 由调度器组装（不含任何可以变成命令字符串的东西）：
   * `{ scopeId, directiveId, runId, action, budgets, directive, run, now, log }`。
   *
   * @param {{ name: string, ctx: Record<string, any> }} input
   * @returns {Promise<{
   *   ok: boolean,
   *   action: string,
   *   reason: string,
   *   summary: string,
   *   tokens: number,
   *   result: Record<string, unknown>,
   * }>}
   */
  async function run(input) {
    const name = String(input?.name ?? '');
    const ctx = input?.ctx ?? {};
    const entry = /** @type {Record<string, any> | undefined} */ (ACTION_TABLE[name]);
    if (entry === undefined) {
      return {
        ok: false,
        action: name,
        reason: ACTION_FAILURE_REASONS.NOT_IN_WHITELIST,
        summary: `动作「${name}」不在内置白名单里：拒绝执行`,
        tokens: 0,
        result: {},
      };
    }
    const hook = hooks[entry.hook];
    if (typeof hook !== 'function') {
      // 这一条是"绝不假装成功"的落地：缺 hook 是配置缺失，不是完成。
      alert({
        kind: 'directive_hook_missing',
        message: `指令动作「${name}」没有接线（缺 hooks.${entry.hook}）`,
        detail: { action: name, hook: entry.hook, directiveId: ctx.directiveId ?? null },
      });
      return {
        ok: false,
        action: name,
        reason: ACTION_FAILURE_REASONS.HOOK_MISSING,
        summary: `动作「${name}」未接线（缺 hooks.${entry.hook}）：没有执行，也不假装完成`,
        tokens: 0,
        result: { hook: entry.hook },
      };
    }

    try {
      const out = await hook(ctx);
      return normalizeHookOutcome(name, out);
    } catch (err) {
      return {
        ok: false,
        action: name,
        reason: ACTION_FAILURE_REASONS.HOOK_FAILED,
        summary: `动作「${name}」抛错：${errorLine(err)}`,
        tokens: 0,
        result: { error: errorLine(err) },
      };
    }
  }

  /**
   * 把 hook 的返回值翻译成统一形状。
   *
   * 只认三件事：`ok === false` 是失败、`tokens` 是数、`summary` 是一句话。
   * 其余字段原样放进 `result`（审计里会截断，但**不记录正文**）。
   *
   * @param {string} name
   * @param {unknown} out
   */
  function normalizeHookOutcome(name, out) {
    /** @param {unknown} value */
    const tokensOf = (value) => {
      const n = Number(value);
      return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
    };
    if (out === undefined || out === null) {
      return {
        ok: true,
        action: name,
        reason: 'ok',
        summary: `动作「${name}」已执行（hook 未返回结果）`,
        tokens: 0,
        result: {},
      };
    }
    if (typeof out === 'string') {
      return { ok: true, action: name, reason: 'ok', summary: out.slice(0, 400), tokens: 0, result: {} };
    }
    if (typeof out === 'object') {
      const record = /** @type {Record<string, any>} */ (out);
      if (record.ok === false) {
        return {
          ok: false,
          action: name,
          reason: String(record.reason ?? ACTION_FAILURE_REASONS.HOOK_REPORTED_FAILURE),
          summary: String(record.summary ?? `动作「${name}」报告失败`).slice(0, 400),
          tokens: tokensOf(record.tokens),
          result: record.result !== null && typeof record.result === 'object' ? record.result : {},
        };
      }
      return {
        ok: true,
        action: name,
        reason: 'ok',
        summary: String(record.summary ?? `动作「${name}」完成`).slice(0, 400),
        tokens: tokensOf(record.tokens),
        result: record.result !== null && typeof record.result === 'object' ? record.result : {},
      };
    }
    return { ok: true, action: name, reason: 'ok', summary: `动作「${name}」完成`, tokens: 0, result: {} };
  }

  /**
   * 白名单清单 + 是否已接线（dry-run 用它提前告诉主人"哪一步会因为没接线而停"）。
   * @returns {Array<Record<string, unknown>>}
   */
  function list() {
    return EXECUTABLE_ACTION_NAMES.map((name) => ({
      name,
      label: ACTION_LABELS[name] ?? name,
      level: ACTION_TABLE[name].minLevel,
      hook: ACTION_TABLE[name].hook,
      available: available(name),
      reversible: ACTION_TABLE[name].reversible,
      rollback: ACTION_TABLE[name].rollback,
      why: ACTION_TABLE[name].why,
    }));
  }

  /**
   * 取单个动作对象：`{ name, level, hook, available, run({ ctx, directive, run }) }`。
   *
   * 任务书要求每个动作是这个形状。`directive` / `run` 也可以只放在 `ctx` 里
   * （调度器就是这么传的），这里两个位置都收，单独调用时更顺手。
   *
   * @param {string} name
   * @returns {Record<string, any> | null} 不在白名单 → `null`（**不是**一个会失败的假动作）
   */
  function get(name) {
    const entry = /** @type {Record<string, any> | undefined} */ (ACTION_TABLE[String(name)]);
    if (entry === undefined) return null;
    const actionName = String(name);
    return {
      name: actionName,
      level: entry.minLevel,
      hook: entry.hook,
      label: ACTION_LABELS[actionName] ?? actionName,
      available: available(actionName),
      reversible: entry.reversible,
      why: entry.why,
      /**
       * @param {{ ctx?: Record<string, any>, directive?: Record<string, any>, run?: Record<string, any> }} [params]
       */
      run: (params = {}) =>
        run({
          name: actionName,
          ctx: {
            ...(params.ctx ?? {}),
            directive: params.directive ?? params.ctx?.directive,
            run: params.run ?? params.ctx?.run,
          },
        }),
    };
  }

  /** 全部动作对象（按白名单顺序）。 */
  function registry() {
    return EXECUTABLE_ACTION_NAMES.map((name) => get(name)).filter((entry) => entry !== null);
  }

  return {
    run,
    list,
    get,
    registry,
    available,
    names: EXECUTABLE_ACTION_NAMES,
    /** 已接线的 hook 名（面板显示用）。 */
    hooksBound: Object.keys(hooks).filter((key) => typeof hooks[key] === 'function'),
  };
}
