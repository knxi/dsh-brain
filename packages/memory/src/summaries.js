// @ts-check
/**
 * `summaries` 门面 —— 层级摘要的最小版（M2-INTERFACES §1.5）。
 *
 * 两条纪律：
 * 1. **摘要是派生数据**：正文可被删除屏障清空（0001 的 `summaries.content` 允许 NULL），
 *    所以摘要永远不能当成独立事实来源回灌成记忆（CONTRACTS §10.6）。
 * 2. **来源必须留痕**：`summary_sources` 记到具体事件 id，删除记忆时
 *    `deletion.js` 的 `shieldTarget` 才能顺着 `summary_sources` 把摘要一起抑制
 *    （0001 已实现该路径，这里只负责写对行）。
 */

import { BrainError, formatLocalIso, structureHash } from '@dsh-brain/core';
import { createTxApi } from './write-queue.js';
import { clampInt, newId, normalizeInstant, requireString } from './memory-util.js';

/** 0001 的 summaries.summary_kind CHECK 允许值。 */
export const SUMMARY_KINDS = Object.freeze(['canonical', 'window', 'task']);

/**
 * `layer` → `summary_kind` 的映射。
 *
 * M2-INTERFACES 用 `layer` 表达摘要层级；0001 的 `summary_kind` 带 CHECK 约束，
 * 只有 canonical/window/task 三个值。两者同值时直接沿用，其它（fragment/long/permanent
 * 这类记忆分层）落 canonical，原值写进 0002 新增的 `layer` 列，不丢信息。
 * @param {string|null} layer
 * @returns {string}
 */
export function layerToKind(layer) {
  if (layer !== null && SUMMARY_KINDS.includes(layer)) return layer;
  return 'canonical';
}

/**
 * @typedef {Object} SummaryInput
 * @property {string} [scopeId]
 * @property {string} [personId]
 * @property {string} [layer]
 * @property {string} text
 * @property {string[]} [sourceEventIds]
 * @property {number|string|null} [sourceWatermark]
 * @property {string} [kind]
 * @property {number} [level]
 * @property {string|null} [parentSummaryId]
 * @property {number|null} [tokenEstimate]
 * @property {string|null} [validFrom]
 * @property {string|null} [validUntil]
 */

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string }, timeZone: string },
 *   bindings?: { scope_id?: string, person_id?: string },
 * }} options
 */
export function createSummaries(options) {
  const { db, queue, clock } = options;
  const defaultScopeId = options.bindings?.scope_id ?? null;
  const defaultPersonId = options.bindings?.person_id ?? 'owner';
  const tx = createTxApi(db);

  /**
   * 建摘要。
   * @param {SummaryInput} input
   * @returns {Promise<{ id: string }>}
   */
  async function create(input) {
    if (!input || typeof input !== 'object') {
      throw new BrainError('INVALID_ARGUMENT', 'summaries.create 需要 input 对象');
    }
    const scopeId = requireString(input.scopeId ?? defaultScopeId, 'scopeId');
    const personId = requireString(input.personId ?? defaultPersonId, 'personId');
    const text = requireString(input.text, 'text', { allowEmpty: false });
    const layer = input.layer === undefined || input.layer === null ? null : String(input.layer);
    const kind = input.kind ?? layerToKind(layer);
    if (!SUMMARY_KINDS.includes(String(kind))) {
      throw new BrainError('INVALID_ARGUMENT', `summary_kind 取值非法：${String(kind)}（可选 ${SUMMARY_KINDS.join(' | ')}）`);
    }
    const level = clampInt(input.level, 0, 99, 0, 'level');
    const watermark =
      input.sourceWatermark === undefined || input.sourceWatermark === null ? null : Number(input.sourceWatermark);
    if (watermark !== null && (!Number.isFinite(watermark) || watermark < 0)) {
      throw new BrainError('INVALID_ARGUMENT', 'sourceWatermark 必须是非负整数');
    }
    const sourceEventIds = Array.isArray(input.sourceEventIds) ? input.sourceEventIds.map((v) => String(v)) : [];
    const validFrom = normalizeInstant(input.validFrom, 'validFrom');
    const validUntil = normalizeInstant(input.validUntil, 'validUntil');
    if (validFrom !== null && validUntil !== null && validUntil <= validFrom) {
      throw new BrainError('INVALID_ARGUMENT', `validUntil 必须晚于 validFrom（${validFrom} → ${validUntil}）`);
    }

    return queue.write(
      (txh) => {
        const stamp = clock.stamp();
        const summaryId = newId('sum');
        const contentDigest = structureHash([scopeId, kind, level, text]);
        txh.run(
          `INSERT INTO summaries (
             summary_id, scope_id, person_id, summary_kind, level, parent_summary_id,
             content, token_estimate, status, source_watermark,
             valid_from, valid_from_local, valid_until, valid_until_local,
             content_hash, layer, created_at, created_at_local, updated_at, updated_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            summaryId,
            scopeId,
            personId,
            kind,
            level,
            input.parentSummaryId ?? null,
            text,
            input.tokenEstimate === undefined || input.tokenEstimate === null ? null : clampInt(input.tokenEstimate, 0, Number.MAX_SAFE_INTEGER, 0, 'tokenEstimate'),
            watermark,
            validFrom,
            validFrom === null ? null : formatLocalIso(new Date(validFrom), clock.timeZone),
            validUntil,
            validUntil === null ? null : formatLocalIso(new Date(validUntil), clock.timeZone),
            contentDigest,
            layer,
            stamp.utc,
            stamp.local,
            stamp.utc,
            stamp.local,
          ],
        );
        for (const [ordinal, sourceId] of sourceEventIds.entries()) {
          txh.run(
            `INSERT INTO summary_sources (summary_id, source_kind, source_id, ordinal, created_at, created_at_local)
             VALUES (?, 'event', ?, ?, ?, ?)
             ON CONFLICT(summary_id, source_kind, source_id) DO NOTHING`,
            [summaryId, sourceId, ordinal, stamp.utc, stamp.local],
          );
        }
        return { id: summaryId };
      },
      { label: 'summaries.create' },
    );
  }


  /**
   * 读一条摘要（含来源）。
   *
   * **scope 收口（默认安全）**：与 `memories.get` 同口径——不传 `scopeId` 时按绑定
   * （`bindings.scope_id`）过滤，读到别的 scope 的摘要返回 `null`（不确认存在性）；
   * 显式 `opts.scopeId` 是声明上下文，`opts.allowCrossScope === true` 只给进程内用。
   *
   * @param {string} summaryId
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {Record<string, unknown> | null}
   */
  function get(summaryId, opts = {}) {
    requireString(summaryId, 'summaryId');
    const scopeId = opts.allowCrossScope === true ? null : requireString(opts.scopeId ?? defaultScopeId, 'scopeId');
    const row = tx.get(
      'SELECT * FROM summaries WHERE summary_id = ? AND (? IS NULL OR scope_id = ?)',
      [summaryId, scopeId, scopeId],
    );
    if (row === undefined) return null;
    const sources = tx.all('SELECT source_kind, source_id FROM summary_sources WHERE summary_id = ? ORDER BY ordinal ASC', [summaryId]);
    return {
      id: String(row.summary_id),
      scopeId: String(row.scope_id),
      personId: row.person_id == null ? null : String(row.person_id),
      kind: String(row.summary_kind),
      layer: row.layer == null ? null : String(row.layer),
      level: Number(row.level ?? 0),
      text: row.content == null ? null : String(row.content),
      status: String(row.status),
      sourceWatermark: row.source_watermark == null ? null : Number(row.source_watermark),
      validFrom: row.valid_from == null ? null : String(row.valid_from),
      validUntil: row.valid_until == null ? null : String(row.valid_until),
      contentHash: row.content_hash == null ? null : String(row.content_hash),
      sources: sources.map((s) => ({ kind: String(s.source_kind), id: String(s.source_id) })),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  return { create, get, SUMMARY_KINDS };
}

