// @ts-check
/**
 * 规范化序列化与哈希。
 *
 * 为什么要自己写 canonical JSON：
 * - `payload_hash` 必须对「内容」稳定，不能因为对象键顺序不同就算成两个不同正文；
 * - 同键不同正文的冲突判定依赖这个稳定性。
 *
 * 规则（显式、可测）：
 * - 对象键按 Unicode 码点排序；
 * - `undefined` 在对象里被跳过、在数组里变 `null`（与 JSON.stringify 一致）；
 * - `Date` → ISO 字符串；`bigint` → 十进制字符串（避免精度丢失）；
 * - `NaN` / `Infinity` / 函数 / symbol → 抛 `INVALID_ARGUMENT`（不静默变 null）；
 * - 循环引用 → 抛 `INVALID_ARGUMENT`。
 */

import { createHash } from 'node:crypto';
import { BrainError } from './errors.js';

/**
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalJson(value) {
  /** @type {Set<object>} */
  const seen = new Set();

  /**
   * @param {unknown} node
   * @returns {string | undefined}
   */
  const encode = (node) => {
    if (node === null) return 'null';
    if (node === undefined) return undefined;
    switch (typeof node) {
      case 'boolean':
        return node ? 'true' : 'false';
      case 'number':
        if (!Number.isFinite(node)) {
          throw new BrainError('INVALID_ARGUMENT', 'canonicalJson 不接受 NaN/Infinity');
        }
        // -0 与 0 视为同一值，避免 `Object.is` 差异造成哈希漂移。
        return Object.is(node, -0) ? '0' : String(node);
      case 'bigint':
        return JSON.stringify(node.toString());
      case 'string':
        return JSON.stringify(node);
      case 'object':
        break;
      default:
        throw new BrainError('INVALID_ARGUMENT', `canonicalJson 不接受类型 ${typeof node}`);
    }

    const asObject = /** @type {object} */ (node);
    if (seen.has(asObject)) {
      throw new BrainError('INVALID_ARGUMENT', 'canonicalJson 遇到循环引用');
    }
    seen.add(asObject);
    try {
      if (Array.isArray(asObject)) {
        const items = asObject.map((item) => {
          const encoded = encode(item);
          return encoded === undefined ? 'null' : encoded;
        });
        return `[${items.join(',')}]`;
      }
      if (asObject instanceof Date) {
        if (Number.isNaN(asObject.getTime())) {
          throw new BrainError('INVALID_ARGUMENT', 'canonicalJson 遇到无效 Date');
        }
        return JSON.stringify(asObject.toISOString());
      }
      const record = /** @type {Record<string, unknown>} */ (asObject);
      const keys = Object.keys(record).sort();
      /** @type {string[]} */
      const pairs = [];
      for (const key of keys) {
        const encoded = encode(record[key]);
        if (encoded === undefined) continue;
        pairs.push(`${JSON.stringify(key)}:${encoded}`);
      }
      return `{${pairs.join(',')}}`;
    } finally {
      seen.delete(asObject);
    }
  };

  const encoded = encode(value);
  if (encoded === undefined) throw new BrainError('INVALID_ARGUMENT', 'canonicalJson 顶层值不能是 undefined');
  return encoded;
}

/**
 * @param {string | Buffer | Uint8Array} input
 * @returns {string} 小写十六进制 sha256
 */
export function sha256Hex(input) {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * 带算法前缀的内容哈希（`sha256:<64 hex>`）。
 * @param {string | Buffer | Uint8Array} input
 * @returns {string}
 */
export function contentHash(input) {
  return `sha256:${sha256Hex(input)}`;
}

/**
 * 结构体内容哈希：规范化后再哈希。
 * @param {unknown} value
 * @returns {string}
 */
export function structureHash(value) {
  return contentHash(canonicalJson(value));
}
