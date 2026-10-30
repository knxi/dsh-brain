// @ts-check
/**
 * `sources` 门面 —— 记忆 → 原始来源（M2-INTERFACES §1.3）。
 *
 * 为什么来源是硬要求：
 * - M2 门槛第一条就是「检索结果必有来源、必有版本」（M2-INTERFACES §5）。
 * - CONTRACTS §10.6 的闭环事故是「注入内容没有可识别来源，被当成人话二次沉淀」。
 *   来源引用是打破这个闭环的唯一依据。
 *
 * 两个判定细节（都会影响 `memories.search()` 的 diagnostics，别随手改）：
 * 1. **外部来源 id 不当孤儿**：`source_event_id` 指向不在 `events` 表里的 id 时，
 *    行的 `event_id` 留 NULL 而不是编一个。否则 `verify()` 会把「合成语料 / 导入数据」
 *    误报成 `source_missing`。
 * 2. **重复 link 幂等**：`ref_id` 由 `(memoryId, sourceKind, sourceSystem,
 *    sourceEventId, locator)` 结构哈希派生，同一来源重复登记只留一行。
 */

import { BrainError, structureHash } from '@dsh-brain/core';
import { createTxApi } from './write-queue.js';
import { newId, requireEnum, requireString, rowToSourceRef } from './memory-util.js';

/** 0001 的 source_refs.source_kind CHECK 允许值。 */
export const SOURCE_KINDS = Object.freeze(['event', 'summary', 'document', 'url', 'tool_call']);

/**
 * @typedef {Object} SourceLinkInput
 * @property {string} [sourceSystem]
 * @property {string} [sourceEventId]
 * @property {string} [locator]
 * @property {string} [contentHash]
 * @property {string} [sourceKind]
 * @property {string} [docRef]
 */

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 * }} options
 */
export function createSources(options) {
  const { db, queue, clock } = options;
  const tx = createTxApi(db);
  // 0001 的 source_refs 表没有 scope_id 列（只挂 memory_id 外键），所以 scope 过滤
  // 一律靠 JOIN memories —— 别指望在 source_refs 上加条件（CONTRACTS §16）。
  const defaultScope = options.bindings?.scope_id ?? 'owner-default';

  /**
   * 登记一条来源。幂等：同 (memory, 来源) 重复调用返回同一个 ref_id。
   * @param {string} memoryId
   * @param {SourceLinkInput} ref
   * @returns {Promise<{ id: string }>}
   */
  async function link(memoryId, ref) {
    requireString(memoryId, 'memoryId');
    if (!ref || typeof ref !== 'object') {
      throw new BrainError('INVALID_ARGUMENT', 'sources.link 需要来源对象');
    }
    const sourceKind = requireEnum(ref.sourceKind, SOURCE_KINDS, 'sourceKind', { fallback: 'event' });
    const sourceEventId = ref.sourceEventId === undefined || ref.sourceEventId === null ? null : String(ref.sourceEventId);
    const locator = ref.locator === undefined || ref.locator === null ? null : String(ref.locator);
    if (sourceEventId === null && locator === null) {
      throw new BrainError('INVALID_ARGUMENT', '来源必须给 sourceEventId 或 locator 之一');
    }
    if (locator !== null && locator.trim().length === 0) {
      throw new BrainError('INVALID_ARGUMENT', '来源 locator 不能是空字符串');
    }
    const sourceSystem = requireString(ref.sourceSystem, 'sourceSystem', { fallback: 'dsh' });
    const contentHashValue = ref.contentHash === undefined || ref.contentHash === null ? null : String(ref.contentHash);

    return queue.write(
      (txh) => {
        if (txh.get('SELECT 1 AS ok FROM memories WHERE id = ?', [memoryId]) === undefined) {
          throw new BrainError('NOT_FOUND', `记忆不存在，不能挂来源：${memoryId}`);
        }
        // 外部 id：events 里没有就只记 source_event_id，event_id 留 NULL。
        const eventRow =
          sourceEventId === null
            ? undefined
            : txh.get('SELECT event_id, source_event_id FROM events WHERE event_id = ?', [sourceEventId]);
        const eventId = eventRow === undefined ? null : String(eventRow.event_id);
        const normalizedEventId = eventRow === undefined ? sourceEventId : String(eventRow.source_event_id ?? sourceEventId);
        const independentKey = `${sourceSystem}:${sourceEventId ?? locator}`;
        const refId = `ref_${structureHash([memoryId, sourceKind, sourceSystem, sourceEventId, locator]).replace(/^sha256:/, '').slice(0, 32)}`;
        const stamp = clock.stamp();
        txh.run(
          `INSERT INTO source_refs (
             ref_id, memory_id, source_kind, event_id, source_system, source_event_id,
             doc_ref, locator, content_hash, independent_source_key, created_at, created_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(ref_id) DO NOTHING`,
          [
            refId,
            memoryId,
            sourceKind,
            eventId,
            sourceSystem,
            normalizedEventId,
            ref.docRef ?? null,
            locator,
            contentHashValue,
            independentKey,
            stamp.utc,
            stamp.local,
          ],
        );
        return { id: refId };
      },
      { label: 'sources.link' },
    );
  }

  /**
   * 某条记忆的全部来源。
   *
   * **scope 收口**（CONTRACTS §16）：拿别的 scope 的记忆 id 来查返回空数组——
   * 来源里的 locator / content_hash 也是元数据，§22.4 要求「正文和元数据均不得泄露」。
   * 已删除记忆不算「跨 scope」：这里只按记忆的 scope 过滤，不按 status 过滤，
   * 删除可见性由记忆层自己决定（不在这里替它改口径）。
   *
   * @param {string} memoryId
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {ReturnType<typeof rowToSourceRef>[]}
   */
  function forMemory(memoryId, opts = {}) {
    requireString(memoryId, 'memoryId');
    const scopeId = opts.allowCrossScope === true ? null : (opts.scopeId ?? defaultScope);
    return tx
      .all(
        `SELECT r.* FROM source_refs r
           JOIN memories m ON m.id = r.memory_id
          WHERE r.memory_id = ? AND (? IS NULL OR m.scope_id = ?)
          ORDER BY r.created_at ASC, r.ref_id ASC`,
        [memoryId, scopeId, scopeId],
      )
      .map((row) => rowToSourceRef(/** @type {Record<string, unknown>} */ (row)));
  }

  /**
   * 校验一条来源引用是否还站得住。
   *
   * `reason` 的语义（与 `memories.search()` 的 diagnostics 对齐）：
   * - `source_missing`：记录不存在 / 指向的事件已删除或已不存在
   * - `hash_mismatch`：调用方给的期望指纹与库里的不一致（来源内容被换过）
   * - `locator_invalid`：locator 是空串或含控制字符
   *
   * **scope 收口**（CONTRACTS §16）：跨 scope 的 refId 归到 `source_missing`——
   * 与「这条来源不存在」同形。verify 只回 ok/reason/refId，本身不吐内容，
   * 但「refId 存不存在」也是信息，所以照样按 scope 收口。
   *
   * @param {string | { id?: string, refId?: string, contentHash?: string|null, expectedContentHash?: string|null }} ref
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {{ ok: boolean, reason?: 'source_missing'|'hash_mismatch'|'locator_invalid', refId?: string }}
   */
  function verify(ref, opts = {}) {
    const refId = typeof ref === 'string' ? ref : (ref?.id ?? ref?.refId);
    requireString(refId, 'refId');
    const scopeId = opts.allowCrossScope === true ? null : (opts.scopeId ?? defaultScope);
    const row = tx.get(
      `SELECT r.* FROM source_refs r
         JOIN memories m ON m.id = r.memory_id
        WHERE r.ref_id = ? AND (? IS NULL OR m.scope_id = ?)`,
      [refId, scopeId, scopeId],
    );
    if (row === undefined) return { ok: false, reason: 'source_missing' };

    const locator = row.locator === null || row.locator === undefined ? null : String(row.locator);
    if (locator !== null && (locator.trim().length === 0 || /[\u0000-\u001f]/.test(locator))) {
      return { ok: false, reason: 'locator_invalid', refId };
    }

    const expected =
      typeof ref === 'object' && ref !== null
        ? (ref.expectedContentHash ?? ref.contentHash ?? null)
        : null;
    if (expected !== null && expected !== undefined && row.content_hash !== null && String(row.content_hash) !== String(expected)) {
      return { ok: false, reason: 'hash_mismatch', refId };
    }

    if (row.event_id !== null && row.event_id !== undefined) {
      const event = tx.get('SELECT deletion_epoch, payload_text FROM events WHERE event_id = ?', [String(row.event_id)]);
      if (event === undefined) return { ok: false, reason: 'source_missing', refId };
      if (Number(event.deletion_epoch) > 0) return { ok: false, reason: 'source_missing', refId };
    }
    return { ok: true, refId };
  }

  return { link, forMemory, verify, SOURCE_KINDS };
}
