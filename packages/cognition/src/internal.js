// @ts-check
/**
 * cognition 包的内部共享工具（不对外导出）。
 *
 * 为什么单列一个文件：五个模块都要做同样的六件小事——解析 scope、读时钟、
 * 规范化时间、读写 JSON 列、读开关、把降级记成告警。抄五份的结果是
 * 「口径一致」变成一句口号：某天某个模块漏了 scope 过滤，谁也发现不了。
 *
 * 纪律（照 CONTRACTS §3 与 0008 迁移）：
 * - 所有查询必须带 `scope_id`；这里只提供「解析 scope」而不提供跨 scope 的逃生门
 *   ——需要跨 scope 的维护路径不应该长在 cognition 包里。
 * - 时间列一律 TEXT ISO（UTC，`Z` 结尾）；毫秒只用于需要算术的列（at_ms/last_seen）。
 * - 不存正文：本文件的 JSON 工具只负责结构，内容纪律由各模块守。
 */

import { createHash, randomBytes } from 'node:crypto';
import { BrainError, DEFAULT_TIME_ZONE } from '@dsh-brain/core';

/** 与主账其它表一致的时区缺省值。 */
export { DEFAULT_TIME_ZONE };

/** 24 位十六进制 id：与 memory 包 `newId()` 同一形态，便于人工辨认来源。 */
export function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/**
 * 幂等键用的稳定摘要。**不存原文**：dedupe_key 里只有哈希，
 * 隔离区/反思表的键不该反过来成为第二个泄露面。
 * @param {string} prefix
 * @param {string[]} parts
 * @returns {string}
 */
export function hashKey(prefix, parts) {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
  return `${prefix}_${digest}`;
}

/**
 * scope 解析：显式参数优先，其次注入绑定（`openBrain({ bindings })` 的同一份值）。
 *
 * 没有默认值兜底是刻意的：给一个猜的 scope 比报错危险得多——那是**跨 scope 泄漏**的
 * 最常见来源（流程测试全绿，生产上把 A 项目的记忆写进了 B 项目）。
 * @param {unknown} explicit
 * @param {{ scope_id?: string } | null | undefined} bindings
 * @param {string} [field]
 * @returns {string}
 */
export function resolveScopeId(explicit, bindings, field = 'scopeId') {
  const value = explicit ?? bindings?.scope_id ?? null;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必填（cognition 的所有查询必须带 scope）`);
  }
  return value.trim();
}

/**
 * 时间入口规范化：任意可解析输入 → UTC ISO（毫秒、`Z` 结尾）；空值 → null。
 * 为什么不复用 memory 包里的同名函数：cognition 只依赖 core，跨包拽内部工具
 * 会把两个包的发布节奏绑死（memory 改一个校验，cognition 跟着红）。
 * @param {unknown} value
 * @param {string} field
 * @returns {string | null}
 */
export function normalizeInstant(value, field) {
  if (value === undefined || value === null || value === '') return null;
  /** @type {number} */
  let ms;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string') ms = Date.parse(value);
  else ms = Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 不是合法时间（收到 ${String(value)}）`);
  }
  return new Date(ms).toISOString();
}

/**
 * 时间入口规范化（必填版）。
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function requireInstant(value, field) {
  const iso = normalizeInstant(value, field);
  if (iso === null) throw new BrainError('INVALID_ARGUMENT', `${field} 必填`);
  return iso;
}

/** @param {unknown} value @returns {number | null} */
export function finiteNumberOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * 必填有限数。非有限数一律拒（NaN 不是「一个显著性分数」，写进去就没法排序）。
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
export function requireFiniteNumber(value, field) {
  const n = finiteNumberOrNull(value);
  if (n === null) throw new BrainError('INVALID_ARGUMENT', `${field} 必须是有限数（收到 ${String(value)}）`);
  return n;
}

/**
 * 夹到 [0,1]。越界夹取而不是拒：这些值是**打分量**，上游用浮点算出 1.0000001
 * 是正常现象；为它拒掉整条写入等于让标记永远落不了库。
 * @param {number} value
 * @returns {number}
 */
export function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * 必填字符串（可配长度上限）。
 * @param {unknown} value
 * @param {string} field
 * @param {{ maxLength?: number, allowEmpty?: boolean }} [opts]
 * @returns {string}
 */
export function requireText(value, field, opts = {}) {
  if (typeof value !== 'string') {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必须是字符串（收到 ${typeof value}）`);
  }
  const text = value.trim();
  if (opts.allowEmpty !== true && text.length === 0) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 不能为空`);
  }
  const maxLength = opts.maxLength ?? 0;
  if (maxLength > 0 && text.length > maxLength) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 太长（${text.length} > ${maxLength}）`);
  }
  return text;
}

/**
 * 截断到 `max` 个字符（按码点，不按 UTF-16 单元，避免把 emoji 切成半个）。
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
export function truncate(value, max) {
  const text = value === undefined || value === null ? '' : String(value);
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max).join('');
}

/**
 * JSON 值序列化（必须可序列化；循环引用报清楚而不是静默写 `{}`）。
 * @param {unknown} value
 * @param {string} field
 * @param {string} [fallback]
 * @returns {string}
 */
export function stringifyJson(value, field, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    return '{}';
  }
  try {
    return JSON.stringify(value);
  } catch {
    throw new BrainError('INVALID_ARGUMENT', `${field} 无法序列化成 JSON（可能有循环引用）`);
  }
}

/**
 * 字符串数组列（evidence / signals）：脏数据当 `[]`。
 * 为什么宽容：这些是**读历史数据**的路径，一条坏行不该让整次列表面板 500。
 * @param {unknown} text
 * @returns {string[]}
 */
export function parseStringArray(text) {
  if (text === null || text === undefined || text === '') return [];
  if (Array.isArray(text)) return text.map((item) => String(item));
  try {
    const parsed = JSON.parse(String(text));
    if (!Array.isArray(parsed)) return [];
    return parsed.map((item) => String(item));
  } catch {
    return [];
  }
}

/**
 * JSON 对象列：脏数据当 `{}`。
 * @param {unknown} text
 * @returns {Record<string, unknown>}
 */
export function parseObjectJson(text) {
  if (text === null || text === undefined || text === '') return {};
  if (typeof text === 'object' && !Array.isArray(text)) return /** @type {Record<string, unknown>} */ (text);
  try {
    const parsed = JSON.parse(String(text));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? /** @type {Record<string, unknown>} */ (parsed)
      : {};
  } catch {
    return {};
  }
}

/**
 * 证据数组校验：每项是非空字符串，长度受限，去重保序。
 * 空数组返回 `[]` —— 调用方必须自己决定「空证据怎么办」
 * （反思：丢弃不落库；其它：可以没有证据）。
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
export function normalizeStringArray(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必须是数组（收到 ${typeof value}）`);
  }
  /** @type {string[]} */
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new BrainError('INVALID_ARGUMENT', `${field} 的元素必须是非空字符串`);
    }
    const text = item.trim();
    if (text.length > 200) {
      throw new BrainError('INVALID_ARGUMENT', `${field} 的元素太长（>200）：${text.slice(0, 40)}…`);
    }
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/**
 * 整数夹取（limit 这类参数）。非法值由 `clampInt` 拒，缺省落 fallback。
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @param {string} field
 * @returns {number}
 */
export function clampInt(value, min, max, fallback, field) {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必须是整数（收到 ${String(value)}）`);
  }
  return Math.max(min, Math.min(max, n));
}

/* ============================================================================
 * 开关与会话降级
 * ==========================================================================*/

/**
 * 读一个开关的原始值。workspace 不可用 → null（调用方自己决定降级姿态）。
 * @param {any} workspace
 * @param {string} name
 * @returns {string | null}
 */
export function getSwitchValue(workspace, name) {
  if (!workspace || typeof workspace.getSwitch !== 'function') return null;
  try {
    const value = workspace.getSwitch(name);
    return value === undefined || value === null ? null : String(value);
  } catch {
    return null;
  }
}

/**
 * 开关是否打开。三态是刻意的：
 * - `true`  = 明确开
 * - `false` = 明确关
 * - `null`  = 判不了（workspace 未接线或抛错）
 *
 * 判不了时调用方必须按**关**处理（默认安全姿态，CONTRACTS §6）：
 * 一个不知道该不该说话的模块，沉默永远比乱说安全。
 * @param {any} workspace
 * @param {string} name
 * @returns {boolean | null}
 */
export function isSwitchEnabled(workspace, name) {
  if (!workspace) return null;
  if (typeof workspace.isEnabled === 'function') {
    try {
      const verdict = workspace.isEnabled(name);
      if (verdict === true || verdict === false) return verdict;
    } catch {
      /* 落到 getSwitch 分支 */
    }
  }
  const raw = getSwitchValue(workspace, name);
  if (raw === null) return null;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * 全局暂停位。`workspace.isPaused()` 优先，缺失时退化成读 `paused` 开关。
 * @param {any} workspace
 * @returns {boolean | null}
 */
export function isPausedSwitch(workspace) {
  if (!workspace) return null;
  if (typeof workspace.isPaused === 'function') {
    try {
      const paused = workspace.isPaused();
      if (paused === true || paused === false) return paused;
    } catch {
      /* 落回开关分支 */
    }
  }
  const raw = getSwitchValue(workspace, 'paused');
  if (raw === null) return null;
  return raw === '1' || raw.toLowerCase() === 'true';
}

/**
 * 告警回调：告警本身失败绝不影响业务结果（否则「告警系统」会成为新的故障源）。
 * @param {((info: { kind: string, message: string, detail?: Record<string, unknown> }) => void) | null} alert
 * @param {string} kind
 * @param {string} message
 * @param {Record<string, unknown>} [detail]
 */
export function notify(alert, kind, message, detail) {
  if (typeof alert !== 'function') return;
  try {
    alert({ kind, message, detail });
  } catch {
    /* 吞掉：告警失败不能掩盖真实结果 */
  }
}

/**
 * 读路径的极简包装（只读，不开事务）。
 * 写路径一律走 `queue.write(tx => ...)`，绝不在这里开写口子。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createReader(db) {
  return {
    /**
     * @param {string} sql
     * @param {unknown[]} [params]
     * @returns {Record<string, any> | undefined}
     */
    get(sql, params = []) {
      return /** @type {any} */ (db.prepare(sql).get(...params));
    },
    /**
     * @param {string} sql
     * @param {unknown[]} [params]
     * @returns {Record<string, any>[]}
     */
    all(sql, params = []) {
      return /** @type {any[]} */ (db.prepare(sql).all(...params));
    },
    /**
     * @param {string} sql
     * @param {unknown[]} [params]
     * @returns {number}
     */
    count(sql, params = []) {
      const row = /** @type {any} */ (db.prepare(sql).get(...params));
      return Number(row?.n ?? 0);
    },
  };
}

/**
 * 表存在性探测：健康检查在**没有 0008 迁移**的旧库上也要能跑（不崩）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @returns {boolean}
 */
export function tableExists(db, table) {
  try {
    const row = /** @type {any} */ (
      db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    );
    return row !== undefined && row !== null;
  } catch {
    return false;
  }
}

/**
 * 事务外预检：不存在就抛 NOT_FOUND。
 *
 * **为什么业务错误要尽量在事务外抛**（本仓库一个真实的坑）：
 * 各包的 `@dsh-brain/core` 都通过自己目录下的 junction 解析，Node 在这个环境下
 * 不会把 junction realpath 成同一路径 —— 于是 `packages/cognition/node_modules/@dsh-brain/core`
 * 与 `packages/memory/node_modules/@dsh-brain/core` 是**两个模块实例**，`instanceof BrainError`
 * 跨包不成立。而 `write-queue` 的 `wrapWriteError()` 只认自己那个实例的 BrainError，
 * 认不出来就把错误包装成 `StorageError`，`code` 从 `NOT_FOUND` 变成 `STORAGE_ERROR`。
 * 结论：**在事务回调里抛业务错误，错误码会在跨包边界上丢失**。
 * 所以这里的纪律是：参数/归属/状态这类可预期错误一律在进入 `queue.write` 之前判定。
 * （事务内仍保留一次防御性判断；那只会在极罕见的竞态下触发。）
 * @param {{ get: (sql: string, params?: unknown[]) => Record<string, any> | undefined }} reader
 * @param {string} sql
 * @param {unknown[]} params
 * @param {string} message
 * @returns {Record<string, any>}
 */
export function requireRow(reader, sql, params, message) {
  const row = reader.get(sql, params);
  if (row === undefined) throw new BrainError('NOT_FOUND', message);
  return row;
}
