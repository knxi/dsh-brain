// @ts-check
/**
 * 系统 4「人格与主动社交」的公共工具层。
 *
 * ── 为什么本包只依赖 `@dsh-brain/core` ──
 *
 * 集成波次里 `packages/memory/src/index.js` 会把本包的 `createPersona` 组装进去
 * （lead 负责）。如果本包反过来 import `@dsh-brain/memory`（哪怕只是 `write-queue`
 * 这个子路径），包依赖就成环了：memory → persona → memory。
 * 事务/绑定工具因此**本地重写一份**（30 行，逻辑与 `memory/src/write-queue.js`
 * 的 `createTxApi` / `toBindable` 等价）。宁可重复 30 行，也不要一个成环的包图。
 *
 * ── 四条纪律 ──
 *
 * 1. **所有查询带 scope_id**。scope 在工厂构造时从 `bindings.scope_id` 绑定，
 *    调用方若显式传一个不同的 `scopeId`，一律 `FORBIDDEN_SCOPE` 拒绝——不做
 *    「按传进来的 scope 查」，那等于把越权读做成了 API。
 * 2. **时间列两种形态不混**：`at`/`created_at` 一律 UTC ISO TEXT（跟主账同口径），
 *    需要毫秒算术的锚点（`at_ms`、`last_change_at` 的算术）用 REAL 毫秒。
 * 3. **开关缺失 = 关**。`workspace` 没注入、或注入的对象没有 `isEnabled` 方法时，
 *    一律按「开着会出事」的方向判成关闭（契约 §6 的默认安全姿态）。
 * 4. **脏数据不炸查询**：JSON 列解析失败当空对象/空数组（读的是历史行，
 *    一条坏行不该让整次注入 500）。
 */

import { BrainError, formatLocalIso, localParts, sha256Hex } from './core.js';
import { randomBytes } from 'node:crypto';

/** 与 `packages/memory` 的 `DEFAULT_SCOPE_ID` / `DEFAULT_PERSON_ID` 同值（MVP 单用户）。 */
export const DEFAULT_SCOPE_ID = 'owner-default';
export const DEFAULT_PERSON_ID = 'owner';
/** 未指定名字时的人格档案名（一个 scope 下可以有多个档案，名字是幂等键）。 */
export const DEFAULT_PERSONA_NAME = 'default';
/** 默认时区与 `openBrain` 缺省一致。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/**
 * 人格五层（0008 的 `persona_versions.layers_json` 键名）。
 * 注意：**JSON 里是 camelCase，`persona_conflicts.layer` 的 CHECK 是 snake_case**，
 * 两边的映射由 `LAYER_TO_CONFLICT` 负责，写冲突时不能直接把键名塞进 layer 列。
 */
export const PERSONA_LAYERS = Object.freeze(['locked', 'base', 'learned', 'userOverride', 'transient']);
/** 五层 → persona_conflicts.layer 的 CHECK 枚举值。 */
export const LAYER_TO_CONFLICT = Object.freeze({
  locked: 'locked',
  base: 'base',
  learned: 'learned',
  userOverride: 'user_override',
  transient: 'transient',
});

/** 关系四维（不合并成一个数：很熟但不信任是真实存在的关系）。 */
export const RELATIONSHIP_DIMENSIONS = Object.freeze(['familiarity', 'trust', 'intimacy', 'rapport']);

/** 主动社交候选来源（0008 的 CHECK 枚举，七类）。 */
export const SOCIAL_SOURCES = Object.freeze([
  'schedule',
  'unfinished_care',
  'commitment',
  'discovery',
  'shared_memory',
  'verification',
  'curiosity',
]);
/**
 * 本轮真正实现的四类来源。剩下三类（shared_memory / verification / curiosity）
 * **刻意留空**而不是糊一个假生成器：没有真实依据的「共同记忆」就是编造，
 * 而编造出来的主动消息正是这个系统最该避免的伤害（方案 §7.5 内容真实性）。
 */
export const IMPLEMENTED_SOCIAL_SOURCES = Object.freeze(['schedule', 'unfinished_care', 'commitment', 'discovery']);
export const PENDING_SOCIAL_SOURCES = Object.freeze(['shared_memory', 'verification', 'curiosity']);

/** 候选状态机（与 0008 的 CHECK 一致）。 */
export const SOCIAL_STATUSES = Object.freeze([
  'proposed',
  'scored',
  'awaiting_approval',
  'scheduled',
  'sent',
  'answered',
  'rejected',
  'expired',
  'cancelled',
]);
/** 还能被推进的「活」状态；`sent` 之前都算 pending。 */
export const SOCIAL_LIVE_STATUSES = Object.freeze(['proposed', 'scored', 'awaiting_approval', 'scheduled']);

/** 回复五态（与 0008 的 CHECK 一致）。 */
export const RESPONSE_DECISIONS = Object.freeze(['reply', 'brief_reply', 'delay', 'decline', 'silent']);
/**
 * 保护类输入（`response_decisions.protected_kind`）。
 * 这些输入**永远不能被判成 silent**：任务、纠错、遗忘、授权、停止、承诺
 * 任何一条沉默都等于「主人说了话，系统装没听见」——这是最不可接受的一类失败。
 */
export const PROTECTED_KINDS = Object.freeze(['formal_task', 'correction', 'forget', 'permission', 'stop', 'commitment']);
/** 输入种类（0008 的 CHECK）。 */
export const INPUT_KINDS = Object.freeze(['owner_message', 'social_input', 'system_event', 'maintenance']);

/**
 * SQLite 绑定值规整：`node:sqlite` 不接受 JS 布尔 / undefined / NaN。
 * 与 `memory/src/write-queue.js` 的 `toBindable` 同语义（本地重写，理由见文件头）。
 * @param {unknown} value
 * @returns {null | number | bigint | string | Uint8Array}
 */
export function toBindable(value) {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value ? 1 : 0;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new BrainError('INVALID_ARGUMENT', '不能绑定 NaN/Infinity 到 SQLite 参数');
      }
      return value;
    case 'bigint':
      return value;
    case 'string':
      return value;
    default:
      break;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  throw new BrainError('INVALID_ARGUMENT', `不能绑定 ${Object.prototype.toString.call(value)} 到 SQLite 参数`);
}

/**
 * @typedef {Object} TxApi
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {(sql: string, params?: unknown[] | Record<string, unknown>) => { changes: number | bigint, lastInsertRowid: number | bigint }} run
 * @property {(sql: string, params?: unknown[] | Record<string, unknown>) => Record<string, unknown> | undefined} get
 * @property {(sql: string, params?: unknown[] | Record<string, unknown>) => Record<string, unknown>[]} all
 */

/**
 * 事务内/外的统一读写口（本地版，等价于 memory 的 `createTxApi`）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {TxApi}
 */
export function createTxApi(db) {
  /**
   * @param {string} sql
   * @param {unknown[] | Record<string, unknown>} [params]
   */
  const bind = (sql, params) => {
    const stmt = db.prepare(sql);
    if (params === undefined) return { stmt, args: /** @type {unknown[]} */ ([]) };
    if (Array.isArray(params)) return { stmt, args: params.map(toBindable) };
    /** @type {Record<string, null | number | bigint | string | Uint8Array>} */
    const named = {};
    for (const [key, value] of Object.entries(params)) named[key] = toBindable(value);
    return { stmt, args: [named] };
  };
  return {
    db,
    run: (sql, params) => {
      const { stmt, args } = bind(sql, params);
      return /** @type {{ changes: number | bigint, lastInsertRowid: number | bigint }} */ (stmt.run(...args));
    },
    get: (sql, params) => {
      const { stmt, args } = bind(sql, params);
      return /** @type {Record<string, unknown> | undefined} */ (stmt.get(...args));
    },
    all: (sql, params) => {
      const { stmt, args } = bind(sql, params);
      return /** @type {Record<string, unknown>[]} */ (stmt.all(...args));
    },
  };
}

/** @param {string} prefix */
export function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @param {{ allowEmpty?: boolean, fallback?: string }} [opts]
 * @returns {string}
 */
export function requireString(value, field, opts = {}) {
  if (value === undefined || value === null) {
    if (opts.fallback !== undefined) return opts.fallback;
    throw new BrainError('INVALID_ARGUMENT', `${field} 必填`);
  }
  if (typeof value !== 'string') {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必须是字符串（收到 ${typeof value}）`);
  }
  if (opts.allowEmpty !== true && value.trim().length === 0) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 不能是空字符串`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string | null}
 */
export function optionalString(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BrainError('INVALID_ARGUMENT', `${field} 必须是字符串（收到 ${typeof value}）`);
  return value;
}

/**
 * @template T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {string} field
 * @param {{ fallback?: T }} [opts]
 * @returns {T}
 */
export function requireEnum(value, allowed, field, opts = {}) {
  if ((value === undefined || value === null) && opts.fallback !== undefined) return opts.fallback;
  if (value === undefined || value === null) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必填，可选值：${allowed.join(' | ')}`);
  }
  if (!allowed.includes(/** @type {T} */ (value))) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 取值非法：${String(value)}（可选 ${allowed.join(' | ')}）`);
  }
  return /** @type {T} */ (value);
}

/**
 * 夹到 [0,1] 的实数。非有限数直接拒——NaN 不是「关系值」。
 * @param {unknown} value
 * @param {string} field
 * @param {number} fallback
 * @returns {number}
 */
export function requireUnit(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) throw new BrainError('INVALID_ARGUMENT', `${field} 必须是有限数（收到 ${String(value)}）`);
  return Math.min(1, Math.max(0, n));
}

/**
 * @param {number} n
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
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

/**
 * 时间入口规范化：任意可解析输入 → UTC ISO（毫秒、`Z` 结尾）；空值 → null。
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
  if (!Number.isFinite(ms)) throw new BrainError('INVALID_ARGUMENT', `${field} 不是合法时间（收到 ${String(value)}）`);
  return new Date(ms).toISOString();
}

/**
 * 毫秒时刻：`null`/`undefined`/`''` → null（0 是有意义的值，不与「没传」混）。
 * @param {unknown} value
 * @param {string} field
 * @returns {number | null}
 */
export function requireEpochMs(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const iso = normalizeInstant(value, field);
  return iso === null ? null : Date.parse(iso);
}

/**
 * JSON 对象列安全解析：脏数据当 `{}`。
 * @param {unknown} text
 * @returns {Record<string, any>}
 */
export function safeJsonObject(text) {
  if (text === null || text === undefined) return {};
  if (typeof text === 'object' && !Array.isArray(text)) return /** @type {Record<string, any>} */ (text);
  try {
    const parsed = JSON.parse(String(text));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * JSON 数组列安全解析：脏数据当 `[]`。
 * @param {unknown} text
 * @returns {any[]}
 */
export function safeJsonArray(text) {
  if (text === null || text === undefined) return [];
  if (Array.isArray(text)) return text;
  try {
    const parsed = JSON.parse(String(text));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 序列化 JSON（写库前）。循环引用/really 不支持的值 → `INVALID_ARGUMENT`，
 * 不静默写一个空对象进去（那会让「凭什么给这个分」变成一片空白）。
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function stringifyJson(value, field) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    throw new BrainError('INVALID_ARGUMENT', `${field} 无法序列化成 JSON（可能有循环引用）`);
  }
}

/**
 * 文本 → 估算 token 数。
 *
 * 口径（显式、可测）：CJK 字符按 **1 字 ≈ 1 token**（保守高估），
 * 其余字符按 **4 字符 ≈ 1 token**。宁可高估——低估会让注入超预算被模型截断，
 * 而那正好会把「锁定层」截掉，是最坏的一种截断。
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = /** @type {number} */ (ch.codePointAt(0));
    const isCjk =
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef);
    if (isCjk) cjk += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(cjk + other / 4));
}

/**
 * 本地时区分量（时/分/日）。
 * @param {number} epochMs
 * @param {string} timeZone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
export function localPartsOf(epochMs, timeZone) {
  return localParts(new Date(epochMs), timeZone);
}

/**
 * 本地自然日（`YYYY-MM-DD`）。每日上限/当日去重都按**本地自然日**算，
 * 按 UTC 算会让东八区的主人在早上 8 点看到「今天已经说过 2 次了」这种错账。
 * @param {number} epochMs
 * @param {string} timeZone
 * @returns {string}
 */
export function localDayOf(epochMs, timeZone) {
  const p = localPartsOf(epochMs, timeZone);
  const pad = (/** @type {number} */ n, /** @type {number} */ w = 2) => String(n).padStart(w, '0');
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/**
 * 本地小时（0..23）。
 * @param {number} epochMs
 * @param {string} timeZone
 * @returns {number}
 */
export function localHourOf(epochMs, timeZone) {
  return localPartsOf(epochMs, timeZone).hour;
}

/**
 * 本地 `HH:mm`（免打扰时段比较用）。
 * @param {number} epochMs
 * @param {string} timeZone
 * @returns {string}
 */
export function localHmOf(epochMs, timeZone) {
  const p = localPartsOf(epochMs, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/**
 * 本地 ISO（`+08:00` 形态）。对应各表的 `*_local` 列。
 * @param {string} utcIso
 * @param {string} timeZone
 * @returns {string}
 */
export function localOf(utcIso, timeZone) {
  return formatLocalIso(new Date(utcIso), timeZone);
}

/**
 * 内容哈希（64 hex）。人格文件用它的 sha256 判断「文件改了才需要重新导入」。
 * @param {string | Buffer | Uint8Array} input
 * @returns {string}
 */
export function hashOf(input) {
  return sha256Hex(input);
}

/**
 * 截断（超长加省略号）。冲突表 old/new、候选 evidence 摘要都用它防撑爆列。
 * @param {unknown} text
 * @param {number} max
 * @returns {string | null}
 */
export function truncate(text, max = 500) {
  if (text === undefined || text === null) return null;
  const s = String(text);
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * 读开关（双保险：自己读 + 与 workspace 门面交叉核对）。
 *
 * **缺失即关闭**：没注入 workspace 时 `socialEnabled=false`、`allowExternal=false`，
 * 于是整条外发链路自然走不动（契约 §6「默认安全姿态」，不许商量）。
 *
 * 为什么还要调 `workspace.assertAllowed({ module: 'social' })`：
 * 那是 lead 那边**唯一的权威判定**（暂停 → 模块开关 → 等级）。本包自己也读一遍是为了
 * 能给出细粒度原因（paused / social_disabled / allow_external），两边口径漂移时
 * **取严不取宽**：任一边说不行就是不行。dry_run 也走这个门——「没真发出去」
 * 不等于「可以不受开关约束」。
 *
 * @param {{ isEnabled?: (name: string) => boolean, isPaused?: () => boolean, assertAllowed?: (input: any) => any } | null | undefined} workspace
 * @returns {{
 *   paused: boolean,
 *   socialEnabled: boolean,
 *   allowExternal: boolean,
 *   denied: string | null,
 *   canWrite: boolean,
 *   canExternal: boolean,
 *   source: string,
 * }}
 */
export function readGate(workspace) {
  const enabled = (/** @type {string} */ name) => {
    if (!workspace || typeof workspace.isEnabled !== 'function') return false;
    try {
      return workspace.isEnabled(name) === true;
    } catch {
      // 开关读不出来按「关」处理：这一类错误绝不能按「开」兜底。
      return false;
    }
  };
  let paused = false;
  if (workspace && typeof workspace.isPaused === 'function') {
    try {
      paused = workspace.isPaused() === true;
    } catch {
      paused = true;
    }
  }
  const socialEnabled = enabled('social.enabled');
  let allowExternal = enabled('social.allow_external');
  /** @type {string | null} */
  let denied = paused ? 'global_paused' : socialEnabled ? null : 'social_disabled';

  let source = workspace && typeof workspace.isEnabled === 'function' ? 'switches' : 'absent';
  if (workspace && typeof workspace.assertAllowed === 'function') {
    source = 'assertAllowed+switches';
    try {
      const verdict = workspace.assertAllowed({ module: 'social' });
      if (!verdict || verdict.allowed !== true) {
        denied = denied ?? String(verdict?.reason ?? 'denied');
      } else {
        // 门面说开，但它的 allowExternal 与 isEnabled 不一致时取严（false 更安全）
        if (typeof verdict.allowExternal === 'boolean') allowExternal = allowExternal && verdict.allowExternal;
      }
    } catch {
      denied = denied ?? 'gate_error';
    }
  }
  const canWrite = denied === null;
  return {
    paused,
    socialEnabled,
    allowExternal: canWrite && allowExternal,
    denied,
    canWrite,
    canExternal: canWrite && allowExternal,
    source,
  };
}

/**
 * 作用域收口：把绑定的 scope 固化成闭包，并拒绝任何显式传入的别的 scope。
 *
 * 为什么不是「按传进来的 scope 查」：那等于把越权读做成 API。
 * 本系统的语义是「一个已认证连接器 = 一个 scope」，多 scope 就多建一个实例。
 * @param {{ scopeId?: string, bindings?: { scope_id?: string } }} options
 * @returns {string}
 */
export function resolveScopeId(options) {
  const scopeId = options.scopeId ?? options.bindings?.scope_id ?? DEFAULT_SCOPE_ID;
  if (typeof scopeId !== 'string' || scopeId.trim().length === 0) {
    throw new BrainError('INVALID_ARGUMENT', 'scopeId 必须是非空字符串');
  }
  return scopeId;
}

/**
 * 调用方显式传的 scopeId 必须与绑定的一致，否则拒绝（跨 scope 一律拒，不静默降级）。
 * @param {string} boundScopeId
 * @param {unknown} requested
 * @param {string} field
 */
export function assertScope(boundScopeId, requested, field = 'scopeId') {
  if (requested === undefined || requested === null) return;
  if (String(requested) !== boundScopeId) {
    throw new BrainError(
      'FORBIDDEN_SCOPE',
      `${field} 与绑定的 scope 不一致（${String(requested)} ≠ ${boundScopeId}）：本系统不接受跨 scope 访问`,
      { details: { boundScopeId, requested: String(requested) } },
    );
  }
}

/**
 * `person_models` 行 → 对外对象。
 * @param {Record<string, any>} row
 */
export function rowToPerson(row) {
  return {
    personId: String(row.person_id),
    scopeId: String(row.scope_id),
    displayName: row.display_name == null ? null : String(row.display_name),
    aliases: safeJsonArray(row.aliases_json).map((v) => String(v)),
    style: safeJsonObject(row.style_json),
    coldStart: Number(row.cold_start ?? 1) === 1,
    personModelVersion: Number(row.person_model_version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * `relationship_states` 行 → 对外对象。
 * @param {Record<string, any>} row
 */
export function rowToRelationship(row) {
  return {
    personId: String(row.person_id),
    scopeId: String(row.scope_id),
    familiarity: Number(row.familiarity),
    trust: Number(row.trust),
    intimacy: Number(row.intimacy),
    rapport: Number(row.rapport),
    basis: safeJsonArray(row.basis_json).map((v) => String(v)),
    version: Number(row.version ?? 1),
    lastChangeAt: row.last_change_at == null ? null : String(row.last_change_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * `proactive_policies` 行 → 对外对象。
 * @param {Record<string, any>} row
 */
export function rowToPolicy(row) {
  return {
    personId: String(row.person_id),
    scopeId: String(row.scope_id),
    enabled: Number(row.enabled) === 1,
    quietHours: safeJsonArray(row.quiet_hours_json)
      .filter((entry) => entry && typeof entry === 'object')
      .map((entry) => ({ from: String(entry.from ?? '00:00'), to: String(entry.to ?? '00:00') })),
    dailyCap: Number(row.daily_cap),
    cooldownMinutes: Number(row.cooldown_minutes),
    topicCooldowns: safeJsonObject(row.topic_cooldowns_json),
    maxPending: Number(row.max_pending),
    channels: safeJsonArray(row.channels_json).map((v) => String(v)),
    policyVersion: Number(row.policy_version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
