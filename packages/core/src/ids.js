// @ts-check
/**
 * 稳定 ID 与内容哈希。
 *
 * 关键语义（CONTRACTS 第 2 节）：
 * - 幂等的**权威依据**是唯一键 `(source_system, scope_id, source_event_id)`，不是正文哈希。
 *   两次相同的人类消息可能是两个真事件，**禁止按正文去重**。
 * - `event_id` 由唯一键确定性派生；宿主无稳定 ID 时连接器首次入队生成并复用。
 */

import { randomBytes } from 'node:crypto';
import { BrainError } from './errors.js';
import { canonicalJson, contentHash, sha256Hex, structureHash } from './canonical.js';

/** 生成 ID 的默认哈希长度（hex 字符数）。 */
export const DEFAULT_ID_HEX_LENGTH = 32;

/**
 * 从命名空间 + 结构化输入派生确定性 ID。
 * 同一输入永远得到同一 ID；不同输入（含键序不同的等价对象）得到同一 ID。
 *
 * @param {string} namespace
 * @param {unknown} parts
 * @param {{ hexLength?: number, prefix?: string }} [options]
 * @returns {string}
 */
export function deriveStableId(namespace, parts, options = {}) {
  if (typeof namespace !== 'string' || namespace.length === 0) {
    throw new BrainError('INVALID_ARGUMENT', 'deriveStableId 需要非空 namespace');
  }
  const hexLength = options.hexLength ?? DEFAULT_ID_HEX_LENGTH;
  if (!Number.isInteger(hexLength) || hexLength < 8 || hexLength > 64) {
    throw new BrainError('INVALID_ARGUMENT', `hexLength 必须在 8..64，收到 ${String(hexLength)}`);
  }
  const prefix = options.prefix ?? '';
  const digest = sha256Hex(`${namespace}\u0000${canonicalJson(parts)}`);
  return `${prefix}${digest.slice(0, hexLength)}`;
}

/**
 * 事件身份三元组。缺字段直接抛错，不做兜底。
 * @param {{ source_system: string, scope_id: string, source_event_id: string }} identity
 * @returns {{ source_system: string, scope_id: string, source_event_id: string }}
 */
export function normalizeEventIdentity(identity) {
  const fields = /** @type {const} */ (['source_system', 'scope_id', 'source_event_id']);
  /** @type {Record<string, string>} */
  const bag = {};
  for (const field of fields) {
    const value = /** @type {Record<string, unknown>} */ (identity)?.[field];
    if (typeof value !== 'string' || value.length === 0) {
      throw new BrainError('INVALID_ARGUMENT', `事件身份缺少 ${field}`);
    }
    bag[field] = value;
  }
  return /** @type {{ source_system: string, scope_id: string, source_event_id: string }} */ (bag);
}

/**
 * 由唯一键派生稳定 event_id（重试/重放复用同一个）。
 * @param {{ source_system: string, scope_id: string, source_event_id: string }} identity
 * @returns {string}
 */
export function deriveEventId(identity) {
  const normalized = normalizeEventIdentity(identity);
  return deriveStableId('dsh-brain/event', normalized, { prefix: 'evt_', hexLength: 32 });
}

/**
 * 宿主一直没有稳定 ID 时，由连接器首次持久入队时生成，随后必须复用。
 * 这是随机 ID，**不是**内容哈希。
 * @returns {string}
 */
export function newEventId() {
  return `evt_${randomBytes(16).toString('hex')}`;
}

/**
 * payload 哈希（`sha256:<64 hex>`）。
 * @param {string | Buffer | Uint8Array | unknown} payload 字符串按原字节哈希；其它值按 canonical JSON
 * @returns {string}
 */
export function payloadHashOf(payload) {
  if (typeof payload === 'string' || Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    return contentHash(payload);
  }
  return structureHash(payload);
}

/** event_id 形状：`evt_` + 32 hex，或宿主给的合法 ID 形状。 */
export const EVENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{1,127}$/;
/** payload_hash 形状。 */
export const PAYLOAD_HASH_RE = /^sha256:[0-9a-f]{64}$/;

export { contentHash, sha256Hex, structureHash, canonicalJson };
