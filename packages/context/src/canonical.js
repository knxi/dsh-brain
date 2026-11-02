// @ts-check
/**
 * 构包摘要：`canonicalHash = sha256(canonicalize({ segments, injectedText, policyVersion }))`。
 *
 * 三个刻意的取舍：
 * 1. **复用 core 的 `canonicalize`**（`canonicalJson`），不自己写一套。对象键序不同但内容等价
 *    必须得到同一摘要，这个稳定性由 core 统一保证。
 * 2. **不含 `contextId` / `builtAt`**：它们是位置与时间，不是内容。带进去会让同一份内容
 *    每次构建都换哈希，sent 判据就没法用来回查。
 * 3. **不重排 `segments`**：段序本身是内容的一部分（检查器要按注入顺序复述）。
 *    顺序的确定性由 `build()` 的稳定排序负责，哈希只负责如实反映。
 *
 * 摘要带 `sha256:` 前缀，与 core 的 `contentHash` / `payloadHashOf` 形状一致，
 * 便于在最终请求对象里直接搜这个串做 sent 判据（CONTRACTS 10.4）。
 */

import { BrainError, canonicalJson, sha256Hex } from '@dsh-brain/core';
import { hashableInjectedText } from './render.js';

/** 摘要前缀。 */
export const CANONICAL_HASH_PREFIX = 'sha256:';

/**
 * 计算构包摘要（纯函数，可复现）。
 *
 * @param {{ segments?: unknown, injectedText?: string, policyVersion?: unknown }} input
 * @returns {string} `sha256:<64 hex>`
 */
export function computeCanonicalHash({ segments, injectedText, policyVersion }) {
  if (!Array.isArray(segments)) {
    throw new BrainError('INVALID_ARGUMENT', 'computeCanonicalHash 需要 segments 数组', {
      details: { field: 'segments' },
    });
  }
  if (typeof injectedText !== 'string') {
    throw new BrainError('INVALID_ARGUMENT', 'computeCanonicalHash 需要 injectedText 字符串', {
      details: { field: 'injectedText' },
    });
  }
  if (typeof policyVersion !== 'string' || policyVersion.length === 0) {
    throw new BrainError('INVALID_ARGUMENT', 'computeCanonicalHash 需要非空 policyVersion', {
      details: { field: 'policyVersion' },
    });
  }
  return `${CANONICAL_HASH_PREFIX}${sha256Hex(canonicalJson({ segments, injectedText, policyVersion }))}`;
}

/**
 * 复核一个包：篡改任何一段、任何一句注入文本、或改 policyVersion，都会复核失败。
 *
 * 注入文本里的 `canonical_hash=` 是自引用回填的值，复算前要还原成占位符（见 render.js）。
 *
 * @param {import('./types.js').ContextPackage} pkg
 * @returns {boolean}
 */
export function verifyCanonicalHash(pkg) {
  if (!pkg || typeof pkg !== 'object') return false;
  const { segments, injectedText, policyVersion, canonicalHash } = pkg;
  if (typeof injectedText !== 'string' || typeof canonicalHash !== 'string') return false;
  if (!Array.isArray(segments) || typeof policyVersion !== 'string') return false;
  try {
    const recomputed = computeCanonicalHash({
      segments,
      injectedText: hashableInjectedText(injectedText, canonicalHash),
      policyVersion,
    });
    return recomputed === canonicalHash;
  } catch {
    return false;
  }
}
