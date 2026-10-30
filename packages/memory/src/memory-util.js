// @ts-check
/**
 * 记忆层的内部工具：参数校验、时间规范化、行映射。
 *
 * 纪律（来自 M1 实测，见 CONTRACTS §11）：
 * - 所有时间在**入口**就规范化成 UTC ISO（毫秒、`Z` 结尾）。SQL 里 `valid_from <= ?`
 *   这类比较是字符串比较，只有统一成同一种形态才等价于时间比较；带 `+08:00` 偏移的
 *   串直接比会排错序。
 * - 写库一律走 `toBindable()`（`node:sqlite` 不接受 JS 布尔）。
 */

import { randomBytes } from 'node:crypto';
import { BrainError } from '@dsh-brain/core';

/** 契约枚举（CONTRACTS §5）。 */
export const LAYERS = Object.freeze(['fragment', 'long', 'permanent']);
export const MEMORY_TYPES = Object.freeze([
  'profile',
  'episode',
  'semantic',
  'commitment',
  'skill',
  'self',
  'relationship',
  'boundary',
]);
export const SOURCE_TYPES = Object.freeze(['owner_words', 'observation', 'inference', 'web', 'tool', 'summary']);
export const PRIVACY_LEVELS = Object.freeze(['public', 'private', 'secret']);
export const MEMORY_STATUSES = Object.freeze([
  'candidate',
  'active',
  'superseded',
  'expired',
  'suppressed',
  'archived',
  'deleted',
]);
/** 防循环要求（CONTRACTS §10.6）：每条记忆必须自证来源。 */
export const ORIGIN_SYSTEMS = Object.freeze(['brain', 'dsh', 'engram', 'lingshu']);
/** 允许被检索到的状态（`deleted` 永不返回）。 */
export const RETRIEVABLE_STATUSES = Object.freeze(['active', 'superseded', 'expired']);

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
 * @template T
 * @param {unknown} value
 * @param {readonly T[]} allowed
 * @param {string} field
 * @param {{ fallback?: T, nullable?: boolean }} [opts]
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
 * 0..1 的实数校验。
 * @param {unknown} value
 * @param {string} field
 * @param {number} fallback
 * @returns {number}
 */
export function requireUnit(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必须在 [0, 1] 内（收到 ${String(value)}）`);
  }
  return n;
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
  if (!Number.isFinite(ms)) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 不是合法时间（收到 ${String(value)}）`);
  }
  return new Date(ms).toISOString();
}

/**
 * JSON 数组列的安全解析（不因脏数据炸整条查询）。
 * @param {unknown} text
 * @param {string} field
 * @returns {string[]}
 */
export function parseJsonArray(text, field) {
  if (text === null || text === undefined) return [];
  if (Array.isArray(text)) return text.map((v) => String(v));
  try {
    const parsed = JSON.parse(String(text));
    if (!Array.isArray(parsed)) {
      throw new Error('not an array');
    }
    return parsed.map((v) => String(v));
  } catch {
    throw new BrainError('INVALID_ARGUMENT', `${field} 不是合法 JSON 数组：${String(text).slice(0, 80)}`);
  }
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
export function stringifyJsonArray(value, field) {
  if (value === undefined || value === null) return '[]';
  if (!Array.isArray(value)) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必须是数组`);
  }
  return JSON.stringify(value.map((v) => requireString(v, `${field}[]`)));
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
 * DB 行 → 对外 Memory 对象（camelCase，保留原文 content）。
 * @param {Record<string, unknown>} row
 */
export function rowToMemory(row) {
  return {
    id: String(row.id),
    version: Number(row.version ?? 1),
    scopeId: String(row.scope_id),
    personId: row.person_id === null || row.person_id === undefined ? null : String(row.person_id),
    layer: String(row.layer),
    type: String(row.type),
    content: row.content === null || row.content === undefined ? null : String(row.content),
    summary: row.summary === null || row.summary === undefined ? null : String(row.summary),
    sourceType: String(row.source_type),
    sourceIds: parseJsonArray(row.source_ids, 'source_ids'),
    confidence: Number(row.confidence ?? 0),
    importance: Number(row.importance ?? 0),
    privacy: String(row.privacy),
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastMentionedAt: row.last_mentioned_at == null ? null : String(row.last_mentioned_at),
    lastRecalledAt: row.last_recalled_at == null ? null : String(row.last_recalled_at),
    mentionCount: Number(row.mention_count ?? 0),
    recallCount: Number(row.recall_count ?? 0),
    validFrom: row.valid_from == null ? null : String(row.valid_from),
    validUntil: row.valid_until == null ? null : String(row.valid_until),
    supersedes: row.supersedes == null ? null : String(row.supersedes),
    pinned: Number(row.pinned ?? 0) === 1,
    contentHash: row.content_hash == null ? null : String(row.content_hash),
    originSystem: row.origin_system == null ? null : String(row.origin_system),
    producer: row.producer == null ? null : String(row.producer),
    derivedFrom: parseJsonArray(row.derived_from, 'derived_from'),
    causationId: row.causation_id == null ? null : String(row.causation_id),
    deletionEpoch: Number(row.deletion_epoch ?? 0),
  };
}

/**
 * DB 行 → 对外 SourceRef 对象。
 * @param {Record<string, unknown>} row
 */
export function rowToSourceRef(row) {
  return {
    id: String(row.ref_id),
    memoryId: String(row.memory_id),
    sourceKind: String(row.source_kind),
    eventId: row.event_id == null ? null : String(row.event_id),
    sourceSystem: row.source_system == null ? null : String(row.source_system),
    sourceEventId: row.source_event_id == null ? null : String(row.source_event_id),
    docRef: row.doc_ref == null ? null : String(row.doc_ref),
    locator: row.locator == null ? null : String(row.locator),
    contentHash: row.content_hash == null ? null : String(row.content_hash),
    independentSourceKey: String(row.independent_source_key),
    createdAt: String(row.created_at),
  };
}

/**
 * CAS 冲突。复用 core 的 ConflictError 语义（不改 core 的错误码表），
 * 但 `details.cas === true` 让调用方能和「事件幂等冲突」区分开。
 *
 * 为什么单独一个类：`ConflictError` 的 `code` 是共用的 `EVENT_CONFLICT`，
 * 上层若只看 code 会把「慢任务写回被拒」误当成「同键不同正文」。看 `details.cas` 才准。
 */
export class CasConflictError extends BrainError {

  /**
   * @param {string} message
   * @param {{ id?: string, expectedVersion?: number, actualVersion?: number, [k: string]: unknown }} info
   */
  constructor(message, info) {
    super('EVENT_CONFLICT', message, { details: { cas: true, ...info } });
    this.name = 'CasConflictError';
    this.info = info;
  }
}
