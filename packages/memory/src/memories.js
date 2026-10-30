// @ts-check
/**
 * `memories` 门面 —— 记忆条目的读写与检索（M2-INTERFACES §1.1 / §1.2）。
 *
 * 三条硬要求，逐条对应实现位置：
 *
 * 1. **检索本体不重写**：`search()` 内部调 `@dsh-brain/search` 的
 *    `SearchIndex.search()` 走三路融合（char 1 : trigram 0.6 : ngram 0），
 *    用户输入一律由 search 包的 `buildFtsMatch()` / `buildTrigramMatch()` 转 phrase。
 *    本文件只做「检索之后」的边界判定：删除屏障、范围、有效期、来源。
 *
 * 2. **删除屏障压过检索**：命中必须同时过两道——`deletion_tombstones`
 *    （按 memory 目标）+ `memories.deletion_epoch` / `status='deleted'`。
 *    关键场景是「索引还在、原文还在，但逻辑上已删」：这类残留候选必须被剔除，
 *    而且**剔除后不能报 ok**，否则等于拿已删内容作答。LIKE 兜底也已经固定为
 *    查 search 自己的索引副本（`search-bridge.js`），避免从 `memories` 原文表兜出已删行。
 *
 * 3. **`asOf` 时点回看在 SQL 层过滤**：`valid_from <= ? AND valid_until > ?`
 *    直接进 WHERE，不是把行查回来再在 JS 里筛。语义是半开区间 `[validFrom, validUntil)`。
 *
 * 写操作返回 Promise（必须等事务 COMMIT 才算数，CONTRACTS §3）；读操作同步返回。
 */

import { BrainError, contentHash, formatLocalIso, structureHash } from '@dsh-brain/core';
import { buildFtsMatch, coverageOf, ngramTerms, querySegments, rrfFuse } from '@dsh-brain/search';
import { createTxApi } from './write-queue.js';
import {
  CasConflictError,
  ORIGIN_SYSTEMS,
  LAYERS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  PRIVACY_LEVELS,
  SOURCE_TYPES,
  clampInt,
  newId,
  normalizeInstant,
  parseJsonArray,
  requireEnum,
  requireString,
  requireUnit,
  rowToMemory,
  stringifyJsonArray,
} from './memory-util.js';
import { DEFAULT_SEARCH_WEIGHTS, toMatchedBy } from './search-bridge.js';

/**
 * 会被裸丢进 FTS5 `MATCH` 就报错的字符（search 报告 §3.3 实测：
 * `建施-03` → no such column、`1.2m` → syntax error、`build:web` → no such column）。
 * 用它判定 `queryWasEscaped`：为 true 表示「这条查询原样进 MATCH 会炸，已被转义」。
 */
const RAW_FTS_UNSAFE = /["*():^.\-/\\]/;

/** 覆盖度阈值：低于它就是「可能相关但证据不够」，不当作确定答案（search 报告 §3.9）。 */
/**
 * 最佳候选的查询覆盖率低于此值 → 判 `insufficient_evidence`（相关但不当作确定答案）。
 *
 * **2026-10-29 从 0.34 提到 0.75**，依据是 §22.3 的 120 用例评测集：
 *
 * | 阈值 | Recall@10 | 无答案用例误答 |
 * |---|---|---|
 * | 0.34 | 0.990 | 7 / 15 |
 * | 0.55 | 0.990 | 3 / 15 |
 * | 0.65 | 0.990 | 2 / 15 |
 * | 0.75 | 0.990 | **0 / 15** |
 * | 0.85 | 0.990 | 0 / 15 |
 *
 * 也就是说提高门槛**只砍误答、不伤召回**——0.34 松到「踢脚线**不锈钢**报价」
 * 缺了「不锈钢」也算找到。选 0.75 不选 0.85：结果相同，留一点余量。
 *
 * 代价与监控：更严意味着更多查询会变成「证据不够」。生产观察期要看
 * `/dsh-brain/usage` 上 `insufficient_evidence` 的占比——如果高得不正常，
 * 说明真实问句的冗余词比评测集多，阈值该回调。**别凭感觉调，看数据。**
 */
export const DEFAULT_MIN_COVERAGE = 0.75;

/**
 * 多段查询分段召回的上限段数。
 *
 * 每段要跑一次完整的三路融合，段数直接乘以查询成本。真实打字最多三四个词块
 * （"展板尺寸 铝板报价 含税" 已经很长），6 段足够且把爆炸面按住。
 */
export const MAX_SEGMENTS = 6;

/**
 * `summary` 缺失时用 content 截断兜底的字数上限。
 *
 * 为什么在检索层兜底而不是让每个调用方各兜各的：context2 的构包逻辑会把
 * `summary === null` 的命中当 `empty_summary` 丢掉并记账（不注入空气，这个判断是对的），
 * 但如果检索层不兜底，**真实命中会被成片丢掉**，等于白检索。
 * 按**字符**不按字节（`[...text]` 拆码点），中文不会被切一半。
 */
export const SUMMARY_FALLBACK_CHARS = 40;

/**
 * 命中的可注入短摘要：有就原样给，没有就从正文截。
 * @param {unknown} summary
 * @param {unknown} content
 * @returns {string|null}
 */
export function deriveSummary(summary, content) {
  if (summary !== null && summary !== undefined && String(summary).trim() !== '') return String(summary);
  if (content === null || content === undefined) return null;
  const text = String(content).replace(/\s+/g, ' ').trim();
  if (!text) return null;
  const chars = [...text];
  return chars.length <= SUMMARY_FALLBACK_CHARS ? text : `${chars.slice(0, SUMMARY_FALLBACK_CHARS).join('')}…`;
}

/**
 * @typedef {Object} MemoriesOptions
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {{ write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> }} queue
 * @property {{ stamp: () => { utc: string, local: string }, timeZone: string }} clock
 * @property {ReturnType<import('./search-bridge.js').createSearchBridge>} bridge
 * @property {{ scope_id?: string, person_id?: string }} [bindings]
 * @property {number} [minCoverage]
 * @property {(info: { kind: string, message: string, detail?: Record<string, unknown> }) => void} [alert]
 */

/**
 * @typedef {Object} MemoryDraft
 * @property {string} [scopeId]
 * @property {string} [personId]
 * @property {string} layer
 * @property {string} type
 * @property {string} content
 * @property {string} [summary]
 * @property {string} sourceType
 * @property {string[]} [sourceIds]
 * @property {number} [confidence]
 * @property {number} [importance]
 * @property {string} [privacy]
 * @property {string} [status]
 * @property {string|null} [validFrom]
 * @property {string|null} [validUntil]
 * @property {boolean} [pinned]
 * @property {string} originSystem
 * @property {string} producer
 * @property {string[]} [derivedFrom]
 * @property {string|null} [causationId]
 */

/**
 * @typedef {Object} SearchOptions
 * @property {unknown} query
 * @property {string} [scopeId]
 * @property {string} [personId]
 * @property {string|null} [asOf]
 * @property {number} [limit]
 * @property {boolean} [includeExpired]
 * @property {boolean} [includeSecret]
 * @property {Record<string, number>} [weights]
 * @property {number} [minCoverage]
 */

/**
 * @param {MemoriesOptions} options
 */
export function createMemories(options) {
  const { db, queue, clock, bridge } = options;
  const alert = options.alert ?? (() => {});
  const defaultScopeId = options.bindings?.scope_id ?? null;
  const defaultPersonId = options.bindings?.person_id ?? 'owner';
  const defaultMinCoverage = options.minCoverage ?? DEFAULT_MIN_COVERAGE;

  /** 读路径用的轻量句柄（只读，不开事务）。 */
  const tx = createTxApi(db);

  /**
   * 索引表是否可用；不可用时写路径降级（不索引）并告警，读路径报 degraded。
   * @returns {boolean}
   */
  function indexWritable() {
    return bridge.probe().allPresent;
  }

  /**
   * 写三套索引。索引是检索的必需派生物，所以失败就让整个事务回滚
   * （不虚报「已记住」——CONTRACTS §3 的 ACK 纪律）；只有「迁移没跑、表都不在」
   * 这种运维故障才降级为可写 + 告警。
   * @param {string} memoryId
   * @param {string|null} content
   */
  function indexMemory(memoryId, content) {
    if (!indexWritable()) {
      alert({
        kind: 'search_index_missing',
        message: '三套检索索引表不存在，记忆写入降级为「可写但不可检索」',
        detail: { memoryId, hint: '执行 migrations/0002_m2_memory.sql' },
      });
      return;
    }
    bridge.getIndex().indexDoc({ id: memoryId, content: content ?? '' });
  }

  /**
   * @param {string} eventId
   * @returns {{ event_id: string|null, source_system: string|null, source_event_id: string|null }}
   */
  function resolveEventIdentity(eventId) {
    const row = tx.get('SELECT event_id, source_system, source_event_id FROM events WHERE event_id = ?', [eventId]);
    if (row === undefined) {
      // 外部来源 id（合成语料、导入数据、别的引擎的事件）：不当成孤儿，
      // 只记 source_event_id，event_id 留 NULL —— 这样 sources.verify 不会
      // 因为「events 表里没有」而误报 source_missing。
      return { event_id: null, source_system: null, source_event_id: eventId };
    }
    return {
      event_id: String(row.event_id),
      source_system: row.source_system == null ? null : String(row.source_system),
      source_event_id: row.source_event_id == null ? null : String(row.source_event_id),
    };
  }

  /**
   * 写一条来源引用。ref_id 由内容派生 → 重复 link 幂等（不重复插入）。
   * @param {any} txh 事务句柄
   * @param {string} memoryId
   * @param {{ sourceSystem?: string, sourceEventId?: string, locator?: string, contentHash?: string, sourceKind?: string, docRef?: string }} ref
   * @param {{ utc: string, local: string }} stamp
   * @param {string} originSystem 记忆自身的来源系统（外部 id 的兜底 source_system）
   * @returns {string} ref_id
   */
  function insertSourceRef(txh, memoryId, ref, stamp, originSystem) {
    const sourceKind = ref.sourceKind ?? 'event';
    const sourceSystem = ref.sourceSystem ?? originSystem;
    const sourceEventId = ref.sourceEventId ?? null;
    if (sourceEventId === null && !ref.locator) {
      throw new BrainError('INVALID_ARGUMENT', '来源必须给 sourceEventId 或 locator 之一');
    }
    const identity = sourceEventId ? resolveEventIdentity(sourceEventId) : { event_id: null, source_system: null, source_event_id: null };
    const independentKey = `${sourceSystem}:${sourceEventId ?? ref.locator ?? 'unknown'}`;
    const refId = `ref_${structureHash([memoryId, sourceKind, sourceSystem, sourceEventId, ref.locator ?? null])
      .replace(/^sha256:/, '')
      .slice(0, 32)}`;
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
        identity.event_id,
        sourceSystem,
        identity.source_event_id ?? sourceEventId,
        ref.docRef ?? null,
        ref.locator ?? null,
        ref.contentHash ?? null,
        independentKey,
        stamp.utc,
        stamp.local,
      ],
    );
    return refId;
  }

  /**
   * 写一条 memory_versions 留痕（纠错保留被取代链，CONTRACTS §5）。
   * @param {any} txh
   * @param {Record<string, unknown>} row 当前 memories 行
   * @param {{ utc: string, local: string }} stamp
   * @param {{ changedBy: string, reason?: string }} meta
   */
  function recordVersion(txh, row, stamp, meta) {
    txh.run(
      `INSERT INTO memory_versions (
         memory_id, version, content, summary, status, source_type, source_ids,
         confidence, importance, privacy, supersedes, changed_by, change_reason,
         content_hash, created_at, created_at_local
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(row.id),
        Number(row.version),
        row.content ?? null,
        row.summary ?? null,
        String(row.status),
        String(row.source_type),
        String(row.source_ids ?? '[]'),
        Number(row.confidence ?? 0),
        Number(row.importance ?? 0),
        String(row.privacy),
        row.supersedes ?? null,
        meta.changedBy,
        meta.reason ?? null,
        row.content_hash ?? null,
        stamp.utc,
        stamp.local,
      ],
    );
  }

  /**
   * 校验并规整 draft。
   * @param {MemoryDraft} draft
   */
  function normalizeDraft(draft) {
    if (!draft || typeof draft !== 'object') {
      throw new BrainError('INVALID_ARGUMENT', 'memories.create 需要 draft 对象');
    }
    const scopeId = requireString(draft.scopeId ?? defaultScopeId, 'scopeId');
    const personId = requireString(draft.personId ?? defaultPersonId, 'personId');
    const content = requireString(draft.content, 'content', { allowEmpty: false });
    const layer = requireEnum(draft.layer, LAYERS, 'layer');
    const type = requireEnum(draft.type, MEMORY_TYPES, 'type');
    const sourceType = requireEnum(draft.sourceType, SOURCE_TYPES, 'sourceType');
    const privacy = requireEnum(draft.privacy, PRIVACY_LEVELS, 'privacy', { fallback: 'private' });
    const status = requireEnum(draft.status, MEMORY_STATUSES, 'status', { fallback: 'active' });
    const confidence = requireUnit(draft.confidence, 'confidence', sourceType === 'inference' ? 0.6 : 1);
    // 契约 §5：推断不得伪装成确定事实。
    if (sourceType === 'inference' && confidence >= 1) {
      throw new BrainError('INVALID_ARGUMENT', 'sourceType=inference 时 confidence 必须 < 1（不得伪装成确定事实）');
    }
    const originSystem = requireEnum(draft.originSystem, ORIGIN_SYSTEMS, 'originSystem');
    const producer = requireString(draft.producer, 'producer');
    const derivedFrom =
      draft.derivedFrom === undefined || draft.derivedFrom === null ? [] : parseJsonArray(draft.derivedFrom, 'derivedFrom');

    // 防循环（CONTRACTS §10.6）：注入内容绝不能被当成主人的话来沉淀。
    // 实测过的闭环是「Brain 注入的片段 → 被别的引擎当用户话语摄入 → 无注入的会话里再被召回」。
    //
    // 拦两条，都要求可判定、不误杀：
    // 1) originSystem=brain 的内容是 Brain 自己的产出，不能以「主人原话」的身份存。
    // 2) 任何系统里派生自 ContextPackage（id 前缀 `ctx_`）的内容，也不能标 owner_words
    //    —— 那是注入载体，不是人类话语。
    // 注意：derivedFrom 里放**原始事件 id** 是正常用法（"这条记忆来自那个事件"），
    // 早期版本把它一刀切成违规，等于让所有带来源追溯的写入失败——已经改掉了。
    if (sourceType === 'owner_words' && originSystem === 'brain') {
      throw new BrainError(
        'INVALID_ARGUMENT',
        'originSystem=brain 的内容不得标为 owner_words（注入不得二次沉淀成人类证据，CONTRACTS §10.6）；请用 summary/inference/observation',
      );
    }
    if (sourceType === 'owner_words' && derivedFrom.some((ref) => String(ref).startsWith('ctx_'))) {
      throw new BrainError(
        'INVALID_ARGUMENT',
        '派生自 ContextPackage（derivedFrom 含 ctx_*）的内容不得标为 owner_words（注入载体不是人类话语，CONTRACTS §10.6）',
      );
    }

    return {
      scopeId,
      personId,
      content,
      summary: draft.summary === undefined || draft.summary === null ? null : String(draft.summary),
      layer,
      type,
      sourceType,
      sourceIds: draft.sourceIds === undefined || draft.sourceIds === null ? [] : parseJsonArray(draft.sourceIds, 'sourceIds'),
      confidence,
      importance: requireUnit(draft.importance, 'importance', 0.5),
      privacy,
      status,
      validFrom: normalizeInstant(draft.validFrom, 'validFrom'),
      validUntil: normalizeInstant(draft.validUntil, 'validUntil'),
      pinned: draft.pinned === true,
      originSystem,
      producer,
      derivedFrom,
      causationId: draft.causationId === undefined || draft.causationId === null ? null : String(draft.causationId),
      contentHash: contentHash(content),
    };
  }

  /**
   * 建记忆。事务内一次写完：memories + memory_versions + source_refs + 三套索引。
   * @param {MemoryDraft} draft
   * @returns {Promise<{ id: string, version: number, createdAt: string }>}
   */
  async function create(draft) {
    const d = normalizeDraft(draft);
    return queue.write(
      (txh) => {
        const stamp = clock.stamp();
        const id = newId('mem');
        txh.run(
          `INSERT INTO memories (
             id, person_id, scope_id, layer, type, content, summary, source_type, source_ids,
             confidence, importance, privacy, status,
             created_at, created_at_local, updated_at, updated_at_local,
             valid_from, valid_from_local, valid_until, valid_until_local,
             pinned, version, content_hash, origin_system, producer, derived_from, causation_id
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
          [
            id,
            d.personId,
            d.scopeId,
            d.layer,
            d.type,
            d.content,
            d.summary,
            d.sourceType,
            JSON.stringify(d.sourceIds),
            d.confidence,
            d.importance,
            d.privacy,
            d.status,
            stamp.utc,
            stamp.local,
            stamp.utc,
            stamp.local,
            d.validFrom,
            d.validFrom === null ? null : formatLocalIso(new Date(d.validFrom), clock.timeZone),
            d.validUntil,
            d.validUntil === null ? null : formatLocalIso(new Date(d.validUntil), clock.timeZone),
            d.pinned,
            d.contentHash,
            d.originSystem,
            d.producer,
            JSON.stringify(d.derivedFrom),
            d.causationId,
          ],
        );
        recordVersion(txh, { ...d, id, version: 1, source_ids: JSON.stringify(d.sourceIds), content_hash: d.contentHash }, stamp, {
          changedBy: d.producer,
          reason: 'create',
        });
        for (const sourceEventId of d.sourceIds) {
          insertSourceRef(txh, id, { sourceEventId, sourceSystem: d.originSystem, sourceKind: 'event' }, stamp, d.originSystem);
        }
        indexMemory(id, d.content);
        return { id, version: 1, createdAt: stamp.utc };
      },
      { label: 'memories.create' },
    );
  }

  /** update 可改的字段（身份字段 scopeId/personId 来自连接器绑定，不允许改）。 */
  const PATCHABLE = Object.freeze([
    'content',
    'summary',
    'layer',
    'type',
    'sourceType',
    'sourceIds',
    'confidence',
    'importance',
    'privacy',
    'status',
    'validFrom',
    'validUntil',
    'pinned',
  ]);

  /**
   * CAS 更新。版本不符抛 `CasConflictError`（`details.cas === true`）。
   *
   * **写路径 scope 收口**：目标必须属于调用方 scope（缺省 `bindings.scope_id`），
   * 跨 scope 一律 `NOT_FOUND`（不确认存在性）。`opts.allowCrossScope === true`
   * 是唯一内部越权通道，**不许**从 HTTP 暴露。
   *
   * @param {string} id
   * @param {Record<string, unknown>} patch
   * @param {{ expectedVersion: number, changedBy?: string, reason?: string, scopeId?: string, allowCrossScope?: boolean }} opts
   * @returns {Promise<{ id: string, version: number }>}
   */
  async function update(id, patch, opts) {
    requireString(id, 'id');
    if (!opts || !Number.isInteger(opts.expectedVersion) || opts.expectedVersion < 1) {
      throw new BrainError('INVALID_ARGUMENT', 'memories.update 需要整数 expectedVersion（CAS 必须显式给基线版本）');
    }
    const expectedVersion = opts.expectedVersion;
    const scopeId = opts.allowCrossScope === true ? null : requireString(opts.scopeId ?? defaultScopeId, 'scopeId');
    if (!patch || typeof patch !== 'object') {
      throw new BrainError('INVALID_ARGUMENT', 'memories.update 需要 patch 对象');
    }
    for (const key of Object.keys(patch)) {
      if (key === 'scopeId' || key === 'personId') {
        throw new BrainError('INVALID_ARGUMENT', `${key} 来自连接器绑定，不允许在 update 里改`);
      }
      if (!PATCHABLE.includes(key)) {
        throw new BrainError('INVALID_ARGUMENT', `memories.update 不支持修改字段：${key}`);
      }
    }
    return queue.write(
      (txh) => {
        const current = txh.get('SELECT * FROM memories WHERE id = ? AND (? IS NULL OR scope_id = ?)', [
          id,
          scopeId,
          scopeId,
        ]);
        if (current === undefined) {
          // 跨 scope 与「真不存在」同形：不确认存在性
          throw new BrainError('NOT_FOUND', `记忆不存在：${id}`);
        }
        const actual = Number(current.version);
        if (actual !== expectedVersion) {
          throw new CasConflictError(`记忆 ${id} 版本已变化（期望 ${expectedVersion}，实际 ${actual}）`, {
            id,
            expectedVersion,
            actualVersion: actual,
          });
        }

        const stamp = clock.stamp();
        /** @type {string[]} */
        const sets = [];
        /** @type {unknown[]} */
        const params = [];
        const set = (column, value) => {
          sets.push(`${column} = ?`);
          params.push(value);
        };

        let contentChanged = false;
        let nextContent = current.content === null || current.content === undefined ? null : String(current.content);
        if (patch.content !== undefined) {
          const content = requireString(patch.content, 'content');
          if (content !== nextContent) {
            contentChanged = true;
            nextContent = content;
            set('content', content);
            set('content_hash', contentHash(content));
          }
        }
        if (patch.summary !== undefined) set('summary', patch.summary === null ? null : String(patch.summary));
        if (patch.layer !== undefined) set('layer', requireEnum(patch.layer, LAYERS, 'layer'));
        if (patch.type !== undefined) set('type', requireEnum(patch.type, MEMORY_TYPES, 'type'));
        if (patch.sourceType !== undefined) set('source_type', requireEnum(patch.sourceType, SOURCE_TYPES, 'sourceType'));
        if (patch.sourceIds !== undefined) set('source_ids', stringifyJsonArray(patch.sourceIds, 'sourceIds'));
        if (patch.confidence !== undefined) set('confidence', requireUnit(patch.confidence, 'confidence', 0));
        if (patch.importance !== undefined) set('importance', requireUnit(patch.importance, 'importance', 0));
        if (patch.privacy !== undefined) set('privacy', requireEnum(patch.privacy, PRIVACY_LEVELS, 'privacy'));
        if (patch.status !== undefined) set('status', requireEnum(patch.status, MEMORY_STATUSES, 'status'));
        if (patch.pinned !== undefined) set('pinned', patch.pinned === true ? 1 : 0);
        if (patch.validFrom !== undefined) {
          const iso = normalizeInstant(patch.validFrom, 'validFrom');
          set('valid_from', iso);
          set('valid_from_local', iso === null ? null : formatLocalIso(new Date(iso), clock.timeZone));
        }
        if (patch.validUntil !== undefined) {
          const iso = normalizeInstant(patch.validUntil, 'validUntil');
          set('valid_until', iso);
          set('valid_until_local', iso === null ? null : formatLocalIso(new Date(iso), clock.timeZone));
        }
        if (!sets.length) {
          throw new BrainError('INVALID_ARGUMENT', 'memories.update 的 patch 没有任何可改字段');
        }

        set('updated_at', stamp.utc);
        set('updated_at_local', stamp.local);
        params.push(id, expectedVersion);
        const result = txh.run(
          `UPDATE memories SET ${sets.join(', ')}, version = version + 1 WHERE id = ? AND version = ?`,
          params,
        );
        if (Number(result.changes) === 0) {
          throw new CasConflictError(`记忆 ${id} 更新时版本已被并发改动`, { id, expectedVersion });
        }

        const updated = txh.get('SELECT * FROM memories WHERE id = ?', [id]);
        recordVersion(txh, /** @type {Record<string, unknown>} */ (updated), stamp, {
          changedBy: opts.changedBy ?? 'memories.update',
          reason: opts.reason ?? 'update',
        });
        if (contentChanged) indexMemory(id, nextContent);
        return { id, version: expectedVersion + 1 };
      },
      { label: 'memories.update' },
    );
  }

  /**
   * 标记取代：旧的转 `superseded` 并封口 `valid_until`，新的记 `supersedes`。
   *
   * 为什么封口而不是删：契约 §5「过期事实靠 valid_from + valid_until 表达，不删」。
   * 封口后 `asOf` 回看历史时刻仍然命中旧值（那正是它当时的样子），当前检索只命中新值。
   *
   * **写路径 scope 收口**：两条都必须在调用方 scope 内，任一越界一律 `NOT_FOUND`
   * （先按 caller scope 过滤再查，所以不会用「同一 scope」报错去确认对方存在）。
   * `opts.allowCrossScope === true` 只给内部维护用。
   *
   * @param {string} oldId
   * @param {string} newId
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {Promise<void>}
   */
  async function supersede(oldId, newId, opts = {}) {
    requireString(oldId, 'oldId');
    requireString(newId, 'newId');
    if (oldId === newId) {
      throw new BrainError('INVALID_ARGUMENT', 'supersede 的 oldId 与 newId 不能相同');
    }
    const scopeId = opts.allowCrossScope === true ? null : requireString(opts.scopeId ?? defaultScopeId, 'scopeId');
    return queue.write(
      (txh) => {
        const oldRow = txh.get('SELECT * FROM memories WHERE id = ? AND (? IS NULL OR scope_id = ?)', [
          oldId,
          scopeId,
          scopeId,
        ]);
        const newRow = txh.get('SELECT * FROM memories WHERE id = ? AND (? IS NULL OR scope_id = ?)', [
          newId,
          scopeId,
          scopeId,
        ]);
        // 跨 scope 与「真不存在」同形：都不确认存在性
        if (oldRow === undefined) throw new BrainError('NOT_FOUND', `记忆不存在：${oldId}`);
        if (newRow === undefined) throw new BrainError('NOT_FOUND', `记忆不存在：${newId}`);
        if (String(oldRow.scope_id) !== String(newRow.scope_id)) {
          throw new BrainError('INVALID_ARGUMENT', 'supersede 的两条记忆必须在同一 scope');
        }
        if (String(oldRow.status) === 'deleted') {
          throw new BrainError('INVALID_ARGUMENT', '已删除的记忆不能作为被取代目标');
        }
        const stamp = clock.stamp();
        txh.run(
          `UPDATE memories
              SET status = 'superseded',
                  valid_until = COALESCE(valid_until, ?),
                  valid_until_local = COALESCE(valid_until_local, ?),
                  updated_at = ?, updated_at_local = ?, version = version + 1
            WHERE id = ?`,
          [stamp.utc, stamp.local, stamp.utc, stamp.local, oldId],
        );
        txh.run(
          `UPDATE memories SET supersedes = ?, updated_at = ?, updated_at_local = ?, version = version + 1 WHERE id = ?`,
          [oldId, stamp.utc, stamp.local, newId],
        );
        const oldAfter = txh.get('SELECT * FROM memories WHERE id = ?', [oldId]);
        recordVersion(txh, /** @type {Record<string, unknown>} */ (oldAfter), stamp, {
          changedBy: 'memories.supersede',
          reason: `superseded_by:${newId}`,
        });
        return undefined;
      },
      { label: 'memories.supersede' },
    );
  }

  /**
   * 目标是否处于删除态（字节级墓碑 + 行级 epoch 双查）。
   * @param {any} txh
   * @param {string} memoryId
   * @returns {boolean}
   */
  function isTombstoned(txh, memoryId) {
    const row = txh.get("SELECT 1 AS hit FROM deletion_tombstones WHERE target_kind = 'memory' AND target_id = ? AND status <> 'failed'", [
      memoryId,
    ]);
    return row !== undefined;
  }

  /**
   * 单条读取。`asOf` 时点回看在 SQL 层过滤有效期。
   *
   * **scope 收口（默认安全）**：不传 `scopeId` 时按绑定（`bindings.scope_id`）过滤，
   * 拿到别的 scope 的 id 返回 `null`——与「这条不存在」同形，不确认存在性。
   * 显式 `opts.scopeId` 是「声明读取上下文」（HTTP 的 `?scopeId=` 走这条）；
   * 进程内确需跨 scope 读（维护/修正路径）才用 `opts.allowCrossScope === true`，
   * 该开关**不许**从 HTTP 暴露。
   *
   * @param {string} id
   * @param {{ asOf?: string|null, scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {ReturnType<typeof rowToMemory> | null}
   */
  function get(id, opts = {}) {
    requireString(id, 'id');
    const at = normalizeInstant(opts.asOf, 'asOf');
    const scopeId = opts.allowCrossScope === true ? null : requireString(opts.scopeId ?? defaultScopeId, 'scopeId');
    const row = tx.get(
      `SELECT * FROM memories
        WHERE id = ?
          AND (? IS NULL OR scope_id = ?)
          AND deletion_epoch = 0
          AND status <> 'deleted'
          AND (? IS NULL OR valid_from IS NULL OR valid_from <= ?)
          AND (? IS NULL OR valid_until IS NULL OR valid_until > ?)`,
      [id, scopeId, scopeId, at, at, at, at],
    );
    if (row === undefined) return null;
    if (isTombstoned(tx, id)) return null;
    return rowToMemory(/** @type {Record<string, unknown>} */ (row));
  }

  /**
   * 分页列表。游标是 `(created_at, id)` 键集，不用 offset（避免深翻页漂移）。
   *
   * 2026-10-30 追加 `offset` + `total`：控制台列表页要显示「第 N / M 页 · 共 X 条」，
   * 键集游标给不出页码和总数。两种模式**互斥**（同时传 cursor 与 offset 抛 INVALID_ARGUMENT）：
   * - `cursor`：适合连续翻页/后台遍历，深翻不漂移；
   * - `offset`：适合人点页码，会多一条 COUNT，并在数据变动时可能轻微漂移（页面上可接受）。
   * 不传 offset 时行为与以前逐字节一致（`total` 字段是新增的，旧调用方不读它）。
   *
   * @param {{
   *   scopeId?: string, personId?: string,
   *   status?: string|string[], layer?: string, type?: string,
   *   limit?: number, cursor?: string|null, offset?: number,
   * }} [opts]
   * @returns {{ items: ReturnType<typeof rowToMemory>[], nextCursor: string|null,
   *   total: number|null, limit: number, offset: number, hasMore: boolean }}
   */
  function list(opts = {}) {
    const scopeId = requireString(opts.scopeId ?? defaultScopeId, 'scopeId');
    const limit = clampInt(opts.limit, 1, 200, 50, 'limit');
    const hasCursor = opts.cursor !== undefined && opts.cursor !== null && opts.cursor !== '';
    const hasOffset = opts.offset !== undefined && opts.offset !== null;
    if (hasCursor && hasOffset) {
      throw new BrainError('INVALID_ARGUMENT', 'list 的 cursor 与 offset 不能同时使用（两种分页模式互斥）');
    }
    const offset = hasOffset ? clampInt(opts.offset, 0, 1_000_000_000, 0, 'offset') : 0;
    /** @type {string[]} */
    const where = ['scope_id = ?', 'deletion_epoch = 0', "status <> 'deleted'"];
    /** @type {unknown[]} */
    const params = [scopeId];
    if (opts.personId !== undefined && opts.personId !== null) {
      where.push('person_id = ?');
      params.push(requireString(opts.personId, 'personId'));
    }
    if (opts.status !== undefined && opts.status !== null && opts.status !== 'all') {
      const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
      for (const s of statuses) requireEnum(s, MEMORY_STATUSES, 'status');
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
    if (opts.layer !== undefined && opts.layer !== null) {
      where.push('layer = ?');
      params.push(requireEnum(opts.layer, LAYERS, 'layer'));
    }
    if (opts.type !== undefined && opts.type !== null) {
      where.push('type = ?');
      params.push(requireEnum(opts.type, MEMORY_TYPES, 'type'));
    }
    where.push("id NOT IN (SELECT target_id FROM deletion_tombstones WHERE target_kind = 'memory' AND status <> 'failed')");

    // total 只在 offset 模式下算：cursor 模式给 total 会诱使调用方拿它算页码，
    // 而键集分页的页码本来就是不稳定的东西。
    const totalRow = hasOffset
      ? tx.get(`SELECT count(*) AS c FROM memories WHERE ${where.join(' AND ')}`, params)
      : undefined;
    const total = totalRow === undefined ? null : Number(/** @type {any} */ (totalRow).c ?? 0);

    const tail = hasOffset ? 'LIMIT ? OFFSET ?' : 'LIMIT ?';
    const tailParams = hasOffset ? [limit + 1, offset] : [limit + 1];

    // cursor 模式保留原来的键集条件（放在 count 之后，免得把 total 也算成「游标之后」的条数）
    if (hasCursor) {
      const cursor = decodeCursor(opts.cursor);
      where.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.createdAt, cursor.createdAt, cursor.id);
    }

    const rows = tx.all(
      `SELECT * FROM memories WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC ${tail}`,
      [...params, ...tailParams],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => rowToMemory(/** @type {Record<string, unknown>} */ (row))),
      nextCursor: hasMore && last ? encodeCursor(String(last.created_at), String(last.id)) : null,
      total,
      limit,
      offset,
      hasMore,
    };
  }

  /**
   * 命中候选的行级回查：scope / 有效期 / 状态 / 隐私**都在 SQL 层过滤**。
   *
   * 早期版本把 scope 判定放在 JS 的「行没查到时」分支里，结果「查到了行」的候选
   * 完全没过 scope 校验，跨 scope 泄漏（被 scopeId 隔离单测抓到）。现在 scope 进
   * WHERE，过滤不掉的候选根本进不了 accepted。
   *
   * @param {any} txh
   * @param {string[]} ids
   * @param {{ scopeId: string, personId: string|null, asOf: string|null, includeExpired: boolean, includeSecret: boolean }} scope
   * @returns {Map<string, Record<string, unknown>>}
   */
  function fetchRecallRows(txh, ids, scope) {
    if (!ids.length) return new Map();
    const placeholders = ids.map(() => '?').join(',');
    /** @type {string[]} */
    const where = [`id IN (${placeholders})`, 'scope_id = ?', 'deletion_epoch = 0', "status <> 'deleted'"];
    /** @type {unknown[]} */
    const params = [...ids, scope.scopeId];
    if (scope.personId !== null) {
      where.push('person_id = ?');
      params.push(scope.personId);
    }
    if (scope.asOf !== null) {
      // 时点回看：允许历史状态（当时有效就行），有效期在 SQL 里判。
      where.push("status IN ('active', 'superseded', 'expired')");
      where.push('(valid_from IS NULL OR valid_from <= ?)');
      params.push(scope.asOf);
      where.push('(valid_until IS NULL OR valid_until > ?)');
      params.push(scope.asOf);
    } else if (scope.includeExpired) {
      where.push("status IN ('active', 'expired')");
    } else {
      where.push("status = 'active'");
    }
    if (!scope.includeSecret) where.push("privacy <> 'secret'");
    const rows = txh.all(`SELECT * FROM memories WHERE ${where.join(' AND ')}`, params);
    /** @type {Map<string, Record<string, unknown>>} */
    const out = new Map();
    for (const row of rows) out.set(String(/** @type {Record<string, unknown>} */ (row).id), /** @type {Record<string, unknown>} */ (row));
    return out;
  }

  /**
   * @param {any} txh
   * @param {string[]} ids
   * @returns {Set<string>}
   */
  function tombstonedIds(txh, ids) {
    if (!ids.length) return new Set();
    const placeholders = ids.map(() => '?').join(',');
    const rows = txh.all(
      `SELECT target_id FROM deletion_tombstones
        WHERE target_kind = 'memory' AND status <> 'failed' AND target_id IN (${placeholders})`,
      ids,
    );
    return new Set(rows.map((row) => String(/** @type {Record<string, unknown>} */ (row).target_id)));
  }

  /**
   * 来源判定（`source_missing` / `source_conflict`）。
   *
   * 为什么不用 `SearchIndex.sourceBackRefs()`：它的「同一 ref 挂到多个记忆也算冲突」
   * 规则对 memory 表会误报——一个事件里说两件事是常态，两条记忆共享同一来源不该叫冲突。
   * 这里只判定真正的语义冲突：
   *   - 无任何来源记录 → source_missing；
   *   - 有来源但指向的事件已被删除 / 不存在 → source_missing；
   *   - 同一记忆有 ≥2 个不同的来源内容指纹 → source_conflict。
   * 另外 `source_refs` 表本身不存在时返回 `available:false`，调用方不得当成「没问题」。
   *
   * @param {any} txh
   * @param {string[]} ids
   * @returns {{ available: boolean, missing: string[], conflicts: string[], byMemory: Map<string, Record<string, unknown>[]> }}
   */
  function judgeSources(txh, ids) {
    /** @type {{ available: boolean, missing: string[], conflicts: string[], byMemory: Map<string, Record<string, unknown>[]> }} */
    const out = { available: false, missing: [], conflicts: [], byMemory: new Map() };
    const hasTable = txh.get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'source_refs'") !== undefined;
    if (!hasTable) return out;
    out.available = true;
    if (!ids.length) return out;

    const placeholders = ids.map(() => '?').join(',');
    const rows = txh.all(`SELECT * FROM source_refs WHERE memory_id IN (${placeholders})`, ids);
    /** @type {Map<string, Record<string, unknown>[]>} */
    const byMemory = new Map();
    for (const row of rows) {
      const mid = String(/** @type {Record<string, unknown>} */ (row).memory_id);
      const list = byMemory.get(mid) ?? [];
      list.push(/** @type {Record<string, unknown>} */ (row));
      byMemory.set(mid, list);
    }

    // 一次查清「这些来源指向的事件还活着吗」
    const eventIds = [...new Set(rows.map((row) => /** @type {Record<string, unknown>} */ (row).event_id).filter((v) => v !== null && v !== undefined).map(String))];
    /** @type {Set<string>} */
    const aliveEvents = new Set();
    if (eventIds.length) {
      const alive = txh.all(
        `SELECT event_id FROM events WHERE deletion_epoch = 0 AND event_id IN (${eventIds.map(() => '?').join(',')})`,
        eventIds,
      );
      for (const row of alive) aliveEvents.add(String(/** @type {Record<string, unknown>} */ (row).event_id));
    }

    for (const id of ids) {
      const refs = byMemory.get(id) ?? [];
      out.byMemory.set(id, refs);
      if (!refs.length) {
        out.missing.push(`${id}: 无来源记录`);
        continue;
      }
      const hashes = new Set(refs.map((row) => row.content_hash).filter((h) => h !== null && h !== undefined && h !== '').map(String));
      if (hashes.size > 1) out.conflicts.push(`${id}: ${hashes.size} 个不同来源内容指纹`);
      const linked = refs.filter((row) => row.event_id !== null && row.event_id !== undefined);
      if (linked.length && linked.every((row) => !aliveEvents.has(String(row.event_id)))) {
        out.missing.push(`${id}: 来源事件已删除或不存在`);
      }
    }
    return out;
  }

  /**
   * 对指定候选按查询 n-gram 算覆盖度（口径与 search 包的 `#docCoverage` 一致，
   * 复用 search 导出的 `ngramTerms` / `coverageOf`，不另造一套判定）。
   * @param {any} txh
   * @param {string[]} ids
   * @param {unknown} query
   * @returns {Map<string, number>}
   */
  function coverageByDoc(txh, ids, query) {
    /** @type {Map<string, number>} */
    const out = new Map();
    const qterms = ngramTerms(query);
    if (!ids.length || !qterms.size) return out;
    const hasNgram = txh.get("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'search_ngram'") !== undefined;
    if (!hasNgram) return out;
    for (const id of ids) {
      const rows = txh.all('SELECT term FROM search_ngram WHERE doc_id = ?', [id]);
      out.set(id, coverageOf(qterms, new Set(rows.map((row) => String(/** @type {Record<string, unknown>} */ (row).term)))));
    }
    return out;
  }

  /**
   * 检索（M2 核心）。
   *
   * @param {SearchOptions} opts
   * @returns {{
   *   hits: Array<Record<string, unknown>>,
   *   diagnostics: {
   *     status: 'ok'|'no_related'|'insufficient_evidence'|'source_missing'|'source_conflict',
   *     queryWasEscaped: boolean,
   *     degraded: 'fts_unavailable'|'index_missing'|null,
   *     notes: string[],
   *     candidateCount: number,
   *     bestCoverage: number|null,
   *     routes: Record<string, unknown>,
   *   },
   * }}
   */
  function search(opts = {}) {
    const scopeId = requireString(opts.scopeId ?? defaultScopeId, 'scopeId');
    const personId = opts.personId === undefined || opts.personId === null ? null : requireString(opts.personId, 'personId');
    const asOf = normalizeInstant(opts.asOf, 'asOf');
    const limit = clampInt(opts.limit, 1, 50, 10, 'limit');
    const includeExpired = opts.includeExpired === true;
    const includeSecret = opts.includeSecret === true;
    const minCoverage = opts.minCoverage ?? defaultMinCoverage;

    /** @type {string[]} */
    const notes = [];
    /** @type {'fts_unavailable'|'index_missing'|null} */
    let degraded = null;

    const rawQuery = opts.query === undefined || opts.query === null ? '' : String(opts.query);
    const queryWasEscaped = RAW_FTS_UNSAFE.test(rawQuery);
    // 用户输入绝不直进 MATCH：一律由 search 包的 buildFtsMatch 转 phrase。
    const ftsPlan = buildFtsMatch(rawQuery);
    if (!ftsPlan.ok) {
      notes.push(`查询没有可检索 token（${ftsPlan.reason ?? 'no_tokens'}）：按「没有相关记忆」处理，不做兜底猜测`);
    }

    // ---- 1) 检索本体：完全交给 search 包（三路融合 + RRF + LIKE 兜底）----
    const probe = bridge.probe();
    /** @type {any[]} */
    let results = [];
    /** @type {{ segments: number, hits: number, recoveredFrom: string|null } | null} 多段查询是否走了分段召回补偿（见 1b） */
    let segmentedFallback = null;
    /** @type {string|null} 主查询 FTS 失败原文（分段补偿成功时要把原因说清，别静默吞掉） */
    let ftsFailure = null;
    /** @type {Record<string, unknown>} */
    let routes = {};
    let searchBestCoverage = /** @type {number|null} */ (null);

    if (!ftsPlan.ok) {
      // 空查询：不查索引，直接按 no_related 返回（notes 已说明原因）。
    } else if (!probe.anyPresent) {
      degraded = 'index_missing';
      notes.push('三套检索索引表都不存在：检索不可用（执行 migrations/0002_m2_memory.sql）');
    } else {
      const pool = Math.max(limit * 5, 50);
      try {
        const res = bridge.getIndex().search(rawQuery, {
          limit: pool,
          checkSources: false, // 来源判定在记忆层做（见 judgeSources 的注释）
          likeFallback: true,
          weights: opts.weights ?? DEFAULT_SEARCH_WEIGHTS,
        });
        results = res.results;
        routes = res.diagnostics.routes ?? {};
        searchBestCoverage = res.diagnostics.bestCoverage ?? null;
      } catch (err) {
        // FTS5 不可用（未编译 / 索引损坏）时降级到自维护 n-gram，并显式标记，
        // 绝不把「检索不可用」伪装成「没有相关记忆」（CONTRACTS §10.8 的精神）。
        degraded = 'fts_unavailable';
        const message = err instanceof Error ? err.message : String(err);
        ftsFailure = message;
        notes.push(`FTS5 查询失败，降级到自维护 n-gram：${message}`);
        try {
          const fallback = bridge.getIndex().search(rawQuery, { route: 'ngram', limit: pool, checkSources: false });
          results = fallback.results;
          routes = { ngram: fallback.diagnostics.routes?.ngram ?? { count: fallback.results.length } };
        } catch (fallbackErr) {
          notes.push(`n-gram 兜底也失败：${fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)}`);
        }
      }

      // ---- 1b) 多段查询的分段召回补偿 ----
      //
      // 实测出来的语义边界（不是猜测，`buildFtsMatch` 的实际输出）：
      //   `铜版纸名片`（无空格）  -> ("铜" OR "版" OR "纸" OR "名" OR "片")     ← 单段、5 token > 4 → OR
      //   `铜版纸 名片`（有空格） -> "铜 版 纸" "名 片"                        ← 两段 phrase，段间隐式 AND
      // 也就是说：用户**加了空格本意是分开找，结果反而更严格**——要求同一文档里两个短语
      // 都连续相邻出现。`展板尺寸 铝板报价` 就是这条路上掉到 char 0 候选的。
      // 段间 AND 是 search 包 adaptive 模式的既有边界（它只按「段内 token 数」决定 phrase/OR）。
      //
      // 还有更糟的一种（context2 发现、我复现确认的 search 包 bug）：
      //   `展板成品尺寸 铝板厚度` -> ("展" OR "板" OR …) "铝 板 厚 度"
      // FTS5 **不接受「括号组后面直接跟 phrase」**（隐式 AND），直接抛
      // `fts5: syntax error near ""铝 板 厚 度""`。也就是「前一段 > 4 token 走 OR、后面还有段」
      // 这一整类输入会让主路整个崩掉。根因在 `buildFtsMatch` 的 `parts.join(' ')`，
      // 该改成 `parts.join(' AND ')`（已报给 lead，属 packages/search 的改动，不在本包范围）。
      //
      // 这里补的正是缺的那一层「段间 OR」：**按段分头检索（仍然走 search 包的三路融合），
      // 再用 search 包导出的 `rrfFuse` 合并** —— 不重写任何一路检索，只在集成层编排。
      // 触发条件下限定为「主路没拿到东西」，所以正常查询的路径与排序完全不变。
      // 注意 `degraded === 'fts_unavailable'` **也要救**：那时不是「主路 0 命中」而是
      // 「主路崩了」，更该走分段（段级查询只有单段、不会触发括号组 bug）。
      // `index_missing` 时跳过——索引表都没有，段级检索也一样查不到。
      const laneCountOf = (source, name) => {
        const lane = /** @type {{ count?: unknown } | undefined} */ (/** @type {unknown} */ (source)?.[name]);
        const count = Number(lane?.count ?? 0);
        return Number.isFinite(count) && count > 0 ? count : 0;
      };
      if (degraded !== 'index_missing' && laneCountOf(routes, 'fts_char') === 0 && laneCountOf(routes, 'fts_trigram') === 0) {
        const segments = querySegments(rawQuery);
        if (segments.length > 1) {
          /** @type {{ route: string, items: { id: string, score: number }[] }[]} */
          const lists = [];
          for (const segment of segments.slice(0, MAX_SEGMENTS)) {
            const segRes = bridge.getIndex().search(segment, {
              limit: pool,
              checkSources: false,
              likeFallback: false, // 段级的 LIKE 兜底只会引噪声，不要
              weights: opts.weights ?? DEFAULT_SEARCH_WEIGHTS,
            });
            // 只有该段自己也是主路命中才算数（否则等于把弱路结果抬成主路）
            const segMain =
              laneCountOf(segRes.diagnostics.routes, 'fts_char') > 0 || laneCountOf(segRes.diagnostics.routes, 'fts_trigram') > 0;
            if (!segMain || !segRes.results.length) continue;
            lists.push({
              route: 'fts_char',
              items: segRes.results.map((item) => ({ id: String(item.id), score: Number(item.score ?? 0) })),
            });
          }
          if (lists.length) {
            const fused = rrfFuse(lists, { weights: { fts_char: 1 }, limit: pool });
            if (fused.length) {
              results = fused;
              const recoveredFrom = degraded;
              segmentedFallback = { segments: lists.length, hits: fused.length, recoveredFrom };
              routes = {
                ...routes,
                segmented: { count: fused.length, ok: true, segments: lists.length, recoveredFrom },
              };
              if (recoveredFrom === 'fts_unavailable') {
                // 原查询的 FTS 串非法（search 包 buildFtsMatch 段间连接 bug），
                // 但分段已把主路走通了 → 最终检索能力**没有**降级，把 degraded 清掉，
                // 免得上游（context2）按 ngram_fallback 给这批结果错标弱证据。
                // 「原查询崩过」这个事实保留在 notes 里，不掩盖。
                notes.push(
                  `原查询构造出的 FTS5 串非法（${ftsFailure ?? 'syntax error'}），已用分段检索绕过并命中主路；` +
                    '根因在 search 包 buildFtsMatch 的段间连接（需显式 AND），已上报待修',
                );
                degraded = null;
              }
            }
          }
        }
      }
    }

    // ---- 2) 删除屏障 + 范围 + 有效期（全部 SQL 侧）----
    const rawIds = results.map((r) => String(r.id));
    const recalled = fetchRecallRows(dbTx(), rawIds, { scopeId, personId, asOf, includeExpired, includeSecret });
    const tombstones = tombstonedIds(dbTx(), rawIds);
    const accepted = [];
    let barrierDropped = 0;
    let scopeDropped = 0;
    let validityDropped = 0;
    for (const hit of results) {
      const id = String(hit.id);
      if (tombstones.has(id)) {
        barrierDropped += 1;
        continue;
      }
      const row = recalled.get(id);
      if (row === undefined) {
        // 没拿到行有三种原因：删除态/epoch>0（屏障）、scope/person 不符、有效期不符。
        // 这里只为把诊断说清楚，真正的过滤已经在 SQL 里做完了。
        const stateRow = tx.get('SELECT status, deletion_epoch, scope_id, person_id FROM memories WHERE id = ?', [id]);
        if (stateRow === undefined) {
          barrierDropped += 1;
        } else if (Number(stateRow.deletion_epoch) > 0 || String(stateRow.status) === 'deleted') {
          barrierDropped += 1;
        } else if (String(stateRow.scope_id) !== scopeId) {
          scopeDropped += 1;
        } else if (personId !== null && String(stateRow.person_id ?? '') !== personId) {
          scopeDropped += 1;
        } else {
          validityDropped += 1;
        }
        continue;
      }
      accepted.push({ hit, row });
    }

    // ---- 3) 只对最终要返回的命中做来源与证据判定 ----
    const page = accepted.slice(0, limit);
    const pageIds = page.map((item) => String(item.row.id));
    const sources = judgeSources(dbTx(), pageIds);
    const coverage = coverageByDoc(dbTx(), pageIds.slice(0, 3), rawQuery);
    const bestCoverage = coverage.size ? Math.max(...[...coverage.values()]) : null;

    const hits = page.map((item) => {
      const row = item.row;
      const refs = sources.byMemory.get(String(row.id)) ?? [];
      return {
        memoryId: String(row.id),
        version: Number(row.version ?? 1),
        score: Number(item.hit.score ?? 0),
        matchedBy: toMatchedBy(item.hit.matchedBy ?? []),
        sourceRefs: refs.map((ref) => ({
          id: String(ref.ref_id),
          sourceKind: String(ref.source_kind),
          sourceSystem: ref.source_system == null ? null : String(ref.source_system),
          sourceEventId: ref.source_event_id == null ? null : String(ref.source_event_id),
          eventId: ref.event_id == null ? null : String(ref.event_id),
          locator: ref.locator == null ? null : String(ref.locator),
          contentHash: ref.content_hash == null ? null : String(ref.content_hash),
        })),
        evidenceKind: String(row.source_type),
        validFrom: row.valid_from == null ? null : String(row.valid_from),
        validUntil: row.valid_until == null ? null : String(row.valid_until),
        layer: String(row.layer),
        type: String(row.type),
        summary: deriveSummary(row.summary, row.content),
        contentHash: row.content_hash == null ? null : String(row.content_hash),
      };
    });

    // ---- 4) 四种「检索不足」的判定顺序 ----
    // 删除屏障 > 来源冲突 > 来源丢失 > 证据不够 > ok
    /** @type {'ok'|'no_related'|'insufficient_evidence'|'source_missing'|'source_conflict'} */
    let status = 'ok';
    if (!hits.length) {
      status = 'no_related';
      if (barrierDropped > 0) {
        notes.push(`${barrierDropped} 条候选被删除屏障剔除（索引残留也不许捞出）`);
      }
      if (scopeDropped > 0) notes.push(`${scopeDropped} 条候选不在请求的 scopeId/personId 内`);
      if (validityDropped > 0) notes.push(`${validityDropped} 条候选在 ${asOf ?? '当前时刻'} 不在有效期内`);
      if (!rawIds.length && ftsPlan.ok) notes.push('三路索引与 LIKE 兜底都没有候选');
    } else {
      if (barrierDropped > 0) notes.push(`${barrierDropped} 条候选被删除屏障剔除`);
      if (scopeDropped > 0) notes.push(`${scopeDropped} 条候选不在请求的 scopeId/personId 内`);
      if (!sources.available) {
        notes.push('source_refs 表不可用：来源完整性无法判定（不得当成「没问题」）');
      }
      if (sources.conflicts.length) {
        status = 'source_conflict';
        notes.push(`来源互相冲突：${sources.conflicts.slice(0, 3).join('; ')}`);
      } else if (sources.missing.length) {
        status = 'source_missing';
        notes.push(`来源丢失：${sources.missing.slice(0, 3).join('; ')}`);
      } else if (bestCoverage !== null && bestCoverage < minCoverage) {
        status = 'insufficient_evidence';
        notes.push(`最佳候选覆盖度 ${bestCoverage.toFixed(2)} < 阈值 ${minCoverage}：相关但不当作确定答案`);
      }
    }

    // 主路是否真的命中过。多段长查询在 search 包的语义下会这样：每段内 token ≤4
    // 走 phrase、段间隐式 AND，于是「展板尺寸 铝板报价」要求同一文档里两段精确相邻 ——
    // 主路 0 命中，最后全靠 n-gram 兜底（P@10 49.9%，明显弱于主路 83.6%）。
    // 这时候 status 可能仍是 ok（覆盖度过线），但上层有权知道「这轮没走主路」。
    // 不改 status 的阈值判定（那是 search 包的既定口径），只把弱证据这件事说出来。
    /** @param {string} name */
    const laneCount = (name) => {
      const lane = /** @type {{ count?: unknown } | undefined} */ (/** @type {unknown} */ (routes)?.[name]);
      const count = Number(lane?.count ?? 0);
      return Number.isFinite(count) ? count : 0;
    };
    const primaryLaneHit = segmentedFallback !== null || laneCount('fts_char') > 0 || laneCount('fts_trigram') > 0;
    if (segmentedFallback !== null) {
      notes.push(
        `多段查询：原查询主路 0 命中（段间 AND 卡死），已按 ${segmentedFallback.segments} 段分头检索并 RRF 合并（段内 phrase、段间 OR）`,
      );
    }
    // `primaryLaneHit === false` 有两种语义，必须分开说，否则上层看不出区别：
    //   a) 主路正常但 0 命中（长词被段间 AND 卡死）
    //   b) 主路查询本身崩了（FTS5 语法错），只能走 n-gram
    if (hits.length && !primaryLaneHit) {
      notes.push(
        degraded === 'fts_unavailable'
          ? '主路（char / trigram）本轮查询异常失败并降级，结果来自 n-gram 兜底：P@10 约 49.9%，按「弱证据」对待（主路崩了，不是没命中）'
          : '主路（char / trigram）本轮 0 命中，结果来自 n-gram 兜底：ngram 的 P@10 约 49.9%，' +
            '主路约 83.6%，请按「弱证据」对待（多段长查询容易被段间 AND 卡死）',
      );
    }

    return {
      hits,
      diagnostics: {
        status,
        queryWasEscaped,
        degraded,
        notes,
        candidateCount: hits.length,
        // 沿用 search 包的覆盖度口径；重算过的值优先（它对应最终 hits）。
        bestCoverage: bestCoverage ?? searchBestCoverage,
        routes,
        // 额外诊断字段（契约字段之外，只增不改）：本轮是否有主路命中。
        primaryLaneHit,
      },
    };
  }

  /** 读路径的句柄（同一个连接，只读封装）。 */
  function dbTx() {
    return tx;
  }

  /**
   * 全量重建索引（迁移后 / 索引损坏后修用）。
   *
   * 不自动在 openBrain 跑：迁移是唯一建表路径，重建是显式运维动作。
   * @param {{ batchSize?: number }} [opts]
   * @returns {Promise<{ indexed: number, skipped: number }>}
   */
  async function reindexAll(opts = {}) {
    const batchSize = clampInt(opts.batchSize, 1, 5000, 500, 'batchSize');
    return queue.write(
      (txh) => {
        const index = bridge.getIndex();
        const rows = txh.all(
          "SELECT id, content FROM memories WHERE status <> 'deleted' AND deletion_epoch = 0 ORDER BY created_at ASC",
        );
        let indexed = 0;
        let skipped = 0;
        for (const row of rows) {
          const record = /** @type {Record<string, unknown>} */ (row);
          const content = record.content == null ? '' : String(record.content);
          if (!content) {
            skipped += 1;
            continue;
          }
          index.indexDoc({ id: String(record.id), content });
          indexed += 1;
          if (indexed % batchSize === 0) {
            // 单事务内分批只是让慢写告警有意义，不做中途提交（原子重建）。
          }
        }
        return { indexed, skipped };
      },
      { label: 'memories.reindexAll' },
    );
  }

  return { create, update, supersede, get, list, search, reindexAll };
}

/**
 * @param {string} createdAt
 * @param {string} id
 * @returns {string}
 */
function encodeCursor(createdAt, id) {
  return Buffer.from(JSON.stringify({ c: createdAt, i: id }), 'utf8').toString('base64url');
}

/**
 * @param {string} cursor
 * @returns {{ createdAt: string, id: string }}
 */
function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof parsed?.c !== 'string' || typeof parsed?.i !== 'string') throw new Error('bad shape');
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    throw new BrainError('INVALID_ARGUMENT', `list 的 cursor 非法：${String(cursor).slice(0, 40)}`);
  }
}
