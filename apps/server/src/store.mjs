// @ts-check
/**
 * 数据访问层。
 *
 * 契约位置：`apps/server` 是「本地 HTTP API」，**不直接写库，走 memory API**（CONTRACTS 第 1 节）。
 * 现实情况：M2 的 `memories` 门面（M2-INTERFACES §1）由 memory2 并行实现，本线不能等。
 *
 * 因此这里做成**门面优先 + 垫片兜底**：
 * - 运行时探测 `openBrain()` 返回值上有没有 `memories` / `sources` 门面；
 * - 有 → 直接用（`implementation: 'facade'`）；
 * - 没有 → 用本文件的**只读 SQL 垫片**（`implementation: 'shim'`），
 *   写入走 `brain.queue.write()`（M1 的单一写入队列，不绕过事务、不绕过 PRAGMA）。
 *
 * 纪律（不因为兜底就破）：
 * - 所有 SQL 参数绑定，无字符串拼接；LIKE 走 `ESCAPE`；
 * - 布尔/undefined 一律过 `toBindable()`（`node:sqlite` 不接受 JS 布尔，见 m1-notes §3.1）；
 * - 查询长度/分页有硬上限；
 * - 拿不到的信息（预算明细、sent 载体、来源可验证性）**如实标 null/unknown**，不编。
 */

import { createHash, randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SCOPE_ID, openBrain, toBindable } from '../../../packages/memory/src/index.js';

/** 与契约一致的枚举（用于入参校验，不信任客户端）。 */
export const LAYERS = Object.freeze(['fragment', 'long', 'permanent']);
export const TYPES = Object.freeze([
  'profile', 'episode', 'semantic', 'commitment', 'skill', 'self', 'relationship', 'boundary',
]);
export const SOURCE_TYPES = Object.freeze(['owner_words', 'observation', 'inference', 'web', 'tool', 'summary']);
export const STATUSES = Object.freeze([
  'candidate', 'active', 'superseded', 'expired', 'suppressed', 'archived', 'deleted',
]);
export const PRIVACY = Object.freeze(['public', 'private', 'secret']);

/**
 * 检索诊断四态（M2-INTERFACES §1.2 / CONTRACTS §7）。
 * 顺序即「可信度影响优先序」：冲突 > 来源丢失 > 证据不够 > 正常。
 */
export const DIAG_STATUSES = Object.freeze([
  'ok', 'no_related', 'insufficient_evidence', 'source_missing', 'source_conflict',
]);

/** 每页最多回多少条。 */
const PAGE_HARD_CAP = 200;

/** 单条记忆正文上限（字符）。 */
const MAX_CONTENT_CHARS = 20_000;

/** 单条摘要上限。 */
const MAX_SUMMARY_CHARS = 2_000;

/** 检索词上限。 */
const MAX_QUERY_CHARS = 200;

/** LIKE 转义子句（SQL 文本为 `ESCAPE '\'`）。 */
const LIKE_ESCAPE = "ESCAPE '\\'";

/**
 * LIKE 模式转义：把 `%` `_` `\` 变成字面量。
 * @param {string} input
 */
function escapeLike(input) {
  return input.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * JSON 列安全解析。坏数据不能把整个接口打挂。
 * @param {unknown} text
 * @param {any} fallback
 */
function parseJson(text, fallback) {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  try {
    const value = JSON.parse(text);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * 游标编码：keyset 分页的排序键放进 base64url，客户端不解析、不伪造。
 * @param {{ k: string, id: string }} payload
 */
export function encodeCursor(payload) {
  return Buffer.from(JSON.stringify({ v: 1, k: payload.k, id: payload.id }), 'utf8').toString('base64url');
}

/**
 * 游标解码。任何不规范形态 → null（调用方回 400，不静默当成第一页）。
 * @param {string | null} cursor
 * @returns {{ k: string, id: string } | null}
 */
export function decodeCursor(cursor) {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 512) return { k: '', id: '' };
  try {
    const json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!json || json.v !== 1 || typeof json.k !== 'string' || typeof json.id !== 'string') {
      return { k: '', id: '' }; // 形态非法：用哨兵让调用方拒绝
    }
    return { k: json.k, id: json.id };
  } catch {
    return { k: '', id: '' };
  }
}

/**
 * 把 limit 夹到 [1, PAGE_HARD_CAP]。非法值不静默变成默认值——NaN 直接拒。
 * @param {unknown} raw
 * @param {{ name?: string }} [opts]
 */
export function normalizeLimit(raw, opts = {}) {
  if (raw === null || raw === undefined || raw === '') return 50;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n)) {
    throw invalid(`limit 必须是整数（收到 ${String(raw)}）`);
  }
  const int = Math.trunc(n);
  if (int < 1) throw invalid('limit 必须 ≥ 1');
  return Math.min(int, PAGE_HARD_CAP);
}

/** `limit` 被夹过时要在响应里说明，不能让调用方以为拿到了想要的数量。 */
export function clampNote(raw, normalized) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n)) return null;
  const int = Math.trunc(n);
  if (int > PAGE_HARD_CAP) return `limit=${int} 超过上限，已夹到 ${PAGE_HARD_CAP}`;
  return null;
}

/**
 * 造一个带 code 的错误（HTTP 层按 code 映射状态）。
 * @param {string} message
 * @param {string} [code]
 */
function invalid(message, code = 'INVALID_ARGUMENT') {
  const err = /** @type {Error & {code?: string}} */ (new Error(message));
  err.code = code;
  return err;
}

/** @param {string} message */
function notFound(message) {
  return invalid(message, 'NOT_FOUND');
}

/**
 * 校验枚举入参。
 * @param {unknown} value
 * @param {readonly string[]} allowed
 * @param {string} field
 */
function pickEnum(value, allowed, field) {
  if (value === null || value === undefined || value === '') return undefined;
  const str = String(value);
  if (!allowed.includes(str)) {
    throw invalid(`${field} 非法：'${str}'（允许 ${allowed.join(' | ')}）`);
  }
  return str;
}

/**
 * 简单 ISO 时间校验（只接受可被 Date 解析且带时区的形态；不静默吞坏值）。
 * @param {unknown} value
 * @param {string} field
 */
function pickIso(value, field) {
  if (value === null || value === undefined || value === '') return null;
  const str = String(value);
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) throw invalid(`${field} 不是合法时间：'${str}'`);
  return d.toISOString();
}

/** @param {string} text */
function sha256(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * @typedef {Object} StoreOptions
 * @property {string} dbPath
 * @property {boolean} [readOnly]
 * @property {string} [migrationsDir]
 * @property {string} [backupDir] 配置后启用 M1 的全量备份服务（M3 备份中心复用）
 * @property {string} [scopeId] 默认读取 scope（缺省 = 契约固定绑定 owner-default）
 * @property {import('./log.mjs').Logger} logger
 */

/**
 * 打开数据访问层。
 * @param {StoreOptions} options
 */
export function openStore(options) {
  const { logger } = options;
  const brain = openBrain({
    dbPath: options.dbPath,
    readOnly: options.readOnly === true,
    migrationsDir: options.migrationsDir,
    // 传了才造出 brain.backup：M3 备份中心直接复用 M1 的快照/校验能力，
    // 不等 backup3 的增强门面（缺失时它会明确说「能用到哪一步」）。
    ...(typeof options.backupDir === 'string' && options.backupDir.length > 0
      ? { backupDir: options.backupDir }
      : {}),
  });
  const db = brain.db;

  /**
   * 服务端的默认读取 scope。
   *
   * `apps/server` 是单用户本机服务，MVP 没有「会话 → 绑定」这一层，所以默认 scope
   * 就是契约里的固定绑定值（`DEFAULT_SCOPE_ID = owner-default`）；宿主可以显式传
   * `scopeId` 改写。**缺省不是「全库」**——列表与详情都按它收口，这是 §22.4 第 4 类
   * 「ID 直读不得泄露别的 scope」的前提。
   */
  const defaultScopeId =
    typeof options.scopeId === 'string' && options.scopeId.trim().length > 0
      ? options.scopeId.trim()
      : DEFAULT_SCOPE_ID;

  // ---- 能力探测：决定「走门面」还是「走垫片」，并把结论暴露给 /api/health。
  //
  // 分工（有意为之，不是凑合）：
  // * 写入 / 检索 / 删除 → 走 memory 门面。这三处是**领域逻辑**（防循环校验、索引维护、
  //   四种检索诊断、「先墓碑后清正文」），不能在这里重写一遍。
  // * 列表 / 详情 → 走本文件的只读 SQL。这一层是**展示形状**（前端要哪些字段、
  //   来源三档怎么分组），属于检查器自己的事，不该反向污染领域模型的返回结构。
  const facade = /** @type {any} */ (brain.memories);
  const hasFacade = Boolean(facade && typeof facade.create === 'function' && typeof facade.search === 'function');
  const hasSearchFacade = Boolean(hasFacade && typeof facade.search === 'function');
  const implementation = hasFacade ? 'facade' : 'shim';

  /** 主账里有没有 memory2 建的检索索引表（FTS / n-gram）。 */
  function searchIndexState() {
    try {
      const rows = /** @type {Array<{name: string}>} */ (
        db
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND (name LIKE 'search_%' OR name LIKE '%_fts%' OR name LIKE 'memory_index%')")
          .all()
      );
      const names = rows.map((r) => String(r.name)).filter(Boolean);
      return { available: names.length > 0, tables: names };
    } catch {
      return { available: false, tables: [] };
    }
  }

  /**
   * 一键探测某个表是否存在。
   * @param {string} name
   */
  function tableExists(name) {
    try {
      return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined;
    } catch {
      return false;
    }
  }

  /** 是否已存在任意 tombstone（删除屏障可用）。 */
  const hasTombstones = tableExists('deletion_tombstones');

  // =========================================================================
  // 记忆：行 → 对外形状
  // =========================================================================

  /**
   * 批量补来源（避免 N+1，但参数个数受分页上限约束，安全）。
   * @param {string[]} memoryIds
   * @returns {Map<string, any[]>}
   */
  function sourcesForMany(memoryIds) {
    /** @type {Map<string, any[]>} */
    const out = new Map();
    if (memoryIds.length === 0) return out;
    const placeholders = memoryIds.map(() => '?').join(', ');
    const rows = /** @type {any[]} */ (
      db
        .prepare(
          `SELECT sr.ref_id, sr.memory_id, sr.source_kind, sr.source_system, sr.source_event_id,
                  sr.event_id, sr.doc_ref, sr.locator, sr.content_hash, sr.independent_source_key,
                  e.event_id AS ev_id, e.payload_hash AS ev_hash, e.occurred_at AS ev_occurred_at,
                  e.deletion_epoch AS ev_epoch
             FROM source_refs sr
             LEFT JOIN events e ON e.event_id = sr.event_id
            WHERE sr.memory_id IN (${placeholders})
            ORDER BY sr.created_at ASC`,
        )
        .all(...memoryIds.map((id) => toBindable(id)))
    );
    for (const row of rows) {
      const list = out.get(String(row.memory_id)) ?? [];
      list.push(normalizeSourceRef(row));
      out.set(String(row.memory_id), list);
    }
    return out;
  }

  /**
   * 来源引用的**验证结论**。三态：ok / 失败原因 / 无法验证（null）。
   * 不许把「无法验证」写成 ok —— 那是假装有证据。
   * @param {any} row
   */
  function normalizeSourceRef(row) {
    /** @type {{ ok: boolean | null, reason?: string }} */
    let verification;
    const kind = String(row.source_kind);
    if (kind === 'event' || row.event_id !== null) {
      if (row.ev_id === null || row.ev_id === undefined) {
        verification = { ok: false, reason: 'source_missing' };
      } else if (Number(row.ev_epoch ?? 0) > 0) {
        // 事件被删除屏障标记过：原文已经不可核对，这条来源等于丢了。
        verification = { ok: false, reason: 'source_missing' };
      } else if (
        typeof row.content_hash === 'string' &&
        typeof row.ev_hash === 'string' &&
        row.content_hash !== row.ev_hash
      ) {
        verification = { ok: false, reason: 'hash_mismatch' };
      } else {
        verification = { ok: true };
      }
    } else if (kind === 'url' || kind === 'document' || kind === 'tool_call') {
      verification =
        typeof row.locator === 'string' && row.locator.length > 0
          ? { ok: null, reason: 'unverifiable_kind' } // 外部资源：本地无法证明它还在
          : { ok: false, reason: 'locator_invalid' };
    } else {
      verification = { ok: null, reason: 'unverifiable_kind' };
    }
    return {
      refId: String(row.ref_id),
      kind,
      sourceSystem: row.source_system === null ? null : String(row.source_system),
      sourceEventId: row.source_event_id === null ? null : String(row.source_event_id),
      eventId: row.event_id === null ? null : String(row.event_id),
      docRef: row.doc_ref === null ? null : String(row.doc_ref),
      locator: row.locator === null ? null : String(row.locator),
      contentHash: row.content_hash === null ? null : String(row.content_hash),
      independentSourceKey:
        row.independent_source_key === null ? null : String(row.independent_source_key),
      occurredAt: row.ev_occurred_at === null || row.ev_occurred_at === undefined ? null : String(row.ev_occurred_at),
      verification,
    };
  }

  /**
   * 记忆行 → 对外形状。正文单独给 `content`，列表页由调用方决定要不要裁剪。
   * @param {any} row
   * @param {{ sources?: any[], versions?: any[], tombstoned?: boolean }} [extra]
   */
  function normalizeMemory(row, extra = {}) {
    const sources = extra.sources ?? [];
    const verified = sources.filter((s) => s.verification?.ok === true).length;
    const unverifiable = sources.filter((s) => s.verification?.ok === null).length;
    return {
      id: String(row.id),
      scopeId: String(row.scope_id),
      personId: row.person_id === null ? null : String(row.person_id),
      layer: String(row.layer),
      type: String(row.type),
      status: String(row.status),
      content: row.content === null ? null : String(row.content),
      summary: row.summary === null ? null : String(row.summary),
      sourceType: String(row.source_type),
      sourceIds: parseJson(row.source_ids, []),
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      privacy: String(row.privacy),
      pinned: Number(row.pinned) === 1,
      version: Number(row.version),
      supersedes: row.supersedes === null ? null : String(row.supersedes),
      validFrom: row.valid_from === null ? null : String(row.valid_from),
      validUntil: row.valid_until === null ? null : String(row.valid_until),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastRecalledAt: row.last_recalled_at === null ? null : String(row.last_recalled_at),
      mentionCount: Number(row.mention_count),
      recallCount: Number(row.recall_count),
      contentHash: row.content_hash === null ? null : String(row.content_hash),
      embeddingVersion: row.embedding_version === null ? null : String(row.embedding_version),
      deletionEpoch: Number(row.deletion_epoch ?? 0),
      tombstoned: extra.tombstoned === true,
      sources,
      // 来源统计：分开算「有证据」「无法验证」「丢了」，让 UI 能一眼看出可信度构成
      sourceStats: {
        total: sources.length,
        verified,
        unverifiable,
        missing: sources.filter((s) => s.verification?.ok === false).length,
        independentKeys: new Set(
          sources.map((s) => s.independentSourceKey).filter((k) => typeof k === 'string' && k.length > 0),
        ).size,
      },
      versions: extra.versions ?? [],
    };
  }

  /**
   * @param {string} memoryId
   */
  function versionsFor(memoryId) {
    try {
      const rows = /** @type {any[]} */ (
        db
          .prepare(
            `SELECT version, status, source_type, confidence, change_reason, changed_by,
                    content_hash, created_at
               FROM memory_versions
              WHERE memory_id = ?
              ORDER BY version DESC
              LIMIT 50`,
          )
          .all(toBindable(memoryId))
      );
      return rows.map((r) => ({
        version: Number(r.version),
        status: String(r.status),
        sourceType: r.source_type === null ? null : String(r.source_type),
        confidence: r.confidence === null ? null : Number(r.confidence),
        changeReason: r.change_reason === null ? null : String(r.change_reason),
        changedBy: String(r.changed_by),
        contentHash: r.content_hash === null ? null : String(r.content_hash),
        createdAt: String(r.created_at),
      }));
    } catch {
      return [];
    }
  }

  /**
   * 目标是否已被删除屏障屏蔽（墓碑存在即屏蔽，不看正文是否清完）。
   * @param {string} targetKind
   * @param {string} targetId
   */
  function isTombstoned(targetKind, targetId) {
    if (!hasTombstones) return false;
    try {
      return (
        db
          .prepare(
            "SELECT 1 AS hit FROM deletion_tombstones WHERE target_kind = ? AND target_id = ? AND status <> 'failed'",
          )
          .get(toBindable(targetKind), toBindable(targetId)) !== undefined
      );
    } catch {
      return false;
    }
  }

  // =========================================================================
  // 记忆列表
  // =========================================================================

  /**
   * 列表。**scope 默认收口**：不传 `scopeId` 时只列服务端默认 scope，不列全库
   * （`allowCrossScope` 只给进程内维护用，HTTP 层不暴露）。
   *
   * @param {{
   *   scopeId?: string, personId?: string, layer?: string, type?: string, status?: string,
   *   limit?: unknown, cursor?: string | null, includeTombstoned?: boolean,
   *   allowCrossScope?: boolean,
   * }} [query]
   */
  async function listMemories(query = {}) {
    const limit = normalizeLimit(query.limit);
    const layer = pickEnum(query.layer, LAYERS, 'layer');
    const type = pickEnum(query.type, TYPES, 'type');
    const status = pickEnum(query.status, STATUSES, 'status');
    const scopeId =
      query.allowCrossScope === true
        ? null
        : (typeof query.scopeId === 'string' && query.scopeId.trim().length > 0 ? query.scopeId.trim() : defaultScopeId);
    const personId = query.personId ?? null;
    const cursor = decodeCursor(query.cursor ?? null);
    if (cursor && (cursor.k === '' || cursor.id === '')) {
      throw invalid('cursor 非法（必须是上一页返回的 nextCursor 原值）');
    }

    const clauses = [];
    /** @type {any[]} */
    const params = [];
    if (scopeId) {
      clauses.push('scope_id = ?');
      params.push(scopeId);
    }
    if (personId) {
      clauses.push('person_id = ?');
      params.push(personId);
    }
    if (layer) {
      clauses.push('layer = ?');
      params.push(layer);
    }
    if (type) {
      clauses.push('type = ?');
      params.push(type);
    }
    if (status) {
      clauses.push('status = ?');
      params.push(status);
    } else {
      // 默认不列已删除的；要看已删除必须显式传 status=deleted
      clauses.push("status <> 'deleted'");
    }
    if (query.includeTombstoned !== true && hasTombstones) {
      clauses.push(
        "NOT EXISTS (SELECT 1 FROM deletion_tombstones t WHERE t.target_kind = 'memory' AND t.target_id = memories.id AND t.status <> 'failed')",
      );
    }
    // 过滤条件到此为止：COUNT 用这一份（不含游标），翻页条件另加。
    const filterWhere = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const filterParams = [...params];

    if (cursor) {
      clauses.push('(created_at < ? OR (created_at = ? AND id < ?))');
      params.push(cursor.k, cursor.k, cursor.id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    // 多取一条判断还有没有下一页。
    const rows = /** @type {any[]} */ (
      db
        .prepare(`SELECT * FROM memories ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
        .all(...params.map((p) => toBindable(p)), toBindable(limit + 1))
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    const sources = sourcesForMany(page.map((r) => String(r.id)));
    const items = page.map((row) =>
      normalizeMemory(row, {
        sources: sources.get(String(row.id)) ?? [],
        tombstoned: false,
      }),
    );

    const last = page[page.length - 1];
    const nextCursor = hasMore && last ? encodeCursor({ k: String(last.created_at), id: String(last.id) }) : null;

    // 总数：同一套过滤条件（不含游标），单独 COUNT。
    let total = null;
    try {
      const row = /** @type {{ n?: number } | undefined} */ (
        db
          .prepare(`SELECT COUNT(*) AS n FROM memories ${filterWhere}`)
          .get(...filterParams.map((p) => toBindable(p)))
      );
      total = Number(row?.n ?? 0);
    } catch {
      total = null; // 统计失败不影响列表本身
    }

    return {
      items,
      nextCursor,
      limit,
      total,
      limitNote: clampNote(query.limit, limit),
      implementation,
    };
  }

  // =========================================================================
  // 记忆详情
  // =========================================================================

  /**
   * 记忆详情。
   *
   * **scope 收口**：主查询带 `scope_id` 条件（缺省 `defaultScopeId`），跨 scope 的 id
   * 直接返回 `null`——上层据此回 404，与「不存在」同形（不确认存在性）。
   * `opts.allowCrossScope` 只给进程内维护路径用，HTTP 层不暴露。
   * 取代链的补查也按同一 scope 过滤，避免从这里漏出别 scope 的摘要。
   *
   * @param {string} id
   * @param {{ asOf?: string, scopeId?: string, allowCrossScope?: boolean }} [opts]
   */
  async function getMemory(id, opts = {}) {
    if (typeof id !== 'string' || id.length === 0) throw invalid('缺少记忆 id');
    const asOf = opts.asOf === undefined || opts.asOf === null || opts.asOf === '' ? null : pickIso(opts.asOf, 'asOf');
    const scopeId =
      opts.allowCrossScope === true
        ? null
        : (typeof opts.scopeId === 'string' && opts.scopeId.trim().length > 0 ? opts.scopeId.trim() : defaultScopeId);

    const row = /** @type {any} */ (
      db
        .prepare('SELECT * FROM memories WHERE id = ? AND (? IS NULL OR scope_id = ?)')
        .get(toBindable(id), toBindable(scopeId), toBindable(scopeId))
    );
    if (row === undefined || row === null) return null;

    const tombstoned = isTombstoned('memory', id);
    const sources = sourcesForMany([id]).get(id) ?? [];
    const memory = normalizeMemory(row, { sources, versions: versionsFor(id), tombstoned });

    // asOf 时点回看：不在有效期内的旧事实要显式标出来，而不是当它不存在。
    if (asOf !== null) {
      const at = new Date(asOf).getTime();
      const from = memory.validFrom === null ? null : new Date(memory.validFrom).getTime();
      const until = memory.validUntil === null ? null : new Date(memory.validUntil).getTime();
      memory.asOf = {
        at: asOf,
        inEffect: (from === null || from <= at) && (until === null || until > at),
        note:
          (from !== null && from > at) ? '该时点这条事实还没生效' : (until !== null && until <= at) ? '该时点这条事实已失效' : '该时点有效',
      };
    }

    // 取代链：往前往后各走一小步，让人能看出「改过什么」。
    /** @type {any[]} */
    const supersedeChain = [];
    if (memory.supersedes) {
      const prev = /** @type {any} */ (
        db
          .prepare('SELECT id, summary, status, version FROM memories WHERE id = ? AND (? IS NULL OR scope_id = ?)')
          .get(toBindable(memory.supersedes), toBindable(scopeId), toBindable(scopeId))
      );
      if (prev) supersedeChain.push({ relation: 'supersedes', id: String(prev.id), summary: prev.summary, status: String(prev.status), version: Number(prev.version) });
    }
    const successors = /** @type {any[]} */ (
      db
        .prepare('SELECT id, summary, status, version FROM memories WHERE supersedes = ? AND (? IS NULL OR scope_id = ?) LIMIT 20')
        .all(toBindable(id), toBindable(scopeId), toBindable(scopeId))
    );
    for (const s of successors) {
      supersedeChain.push({ relation: 'superseded_by', id: String(s.id), summary: s.summary, status: String(s.status), version: Number(s.version) });
    }

    return { ...memory, supersedeChain };
  }

  // =========================================================================
  // 检索（M2 核心：四种「没搜到」必须能区分）
  // =========================================================================

  /**
   * 词法检索垫片。真实三路融合（char/trigram/ngram）由 `@dsh-brain/search` 提供，
   * 门面到位后本函数自动退居备用。这里只保证：参数化、转义、可解释。
   *
   * @param {{ query: string, scopeId?: string|null, personId?: string|null, limit?: unknown, asOf?: string|null }} input
   */
  async function shimSearch(input) {
    let query = input.query;
    const limit = normalizeLimit(input.limit, { name: 'limit' });
    if (typeof query !== 'string' || query.trim().length === 0) {
      throw invalid('检索需要 q（非空字符串）');
    }
    if (query.length > MAX_QUERY_CHARS) {
      throw invalid(`q 超过 ${MAX_QUERY_CHARS} 字符上限`);
    }
    const escapedRaw = query.trim();

    // 切词：空白分隔，最多 4 个，每个 ≤ 40 字。空词丢弃。
    const tokens = [...new Set(escapedRaw.split(/\s+/).map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 40))].slice(0, 4);
    if (tokens.length === 0) throw invalid('q 里没有可检索的词（全为空或过长）');

    const clauses = [];
    /** @type {any[]} */
    const params = [];
    for (const token of tokens) {
      const pattern = `%${escapeLike(token)}%`;
      clauses.push(`(content LIKE ? ${LIKE_ESCAPE} OR summary LIKE ? ${LIKE_ESCAPE})`);
      params.push(pattern, pattern);
    }
    if (input.scopeId) {
      clauses.push('scope_id = ?');
      params.push(input.scopeId);
    }
    if (input.personId) {
      clauses.push('person_id = ?');
      params.push(input.personId);
    }
    clauses.push("status <> 'deleted'");
    if (hasTombstones) {
      clauses.push(
        "NOT EXISTS (SELECT 1 FROM deletion_tombstones t WHERE t.target_kind = 'memory' AND t.target_id = memories.id AND t.status <> 'failed')",
      );
    }
    // asOf：只保留该时点有效的事实
    if (input.asOf) {
      const at = pickIso(input.asOf, 'asOf');
      clauses.push('(valid_from IS NULL OR valid_from <= ?)');
      params.push(at);
      clauses.push('(valid_until IS NULL OR valid_until > ?)');
      params.push(at);
    }

    const rows = /** @type {any[]} */ (
      db
        .prepare(`SELECT * FROM memories WHERE ${clauses.join(' AND ')} ORDER BY importance DESC, confidence DESC, created_at DESC LIMIT ?`)
        .all(...params.map((p) => toBindable(p)), toBindable(limit))
    );

    const sources = sourcesForMany(rows.map((r) => String(r.id)));
    const hits = rows.map((row) => {
      const refs = sources.get(String(row.id)) ?? [];
      return {
        memoryId: String(row.id),
        version: Number(row.version),
        score: Number(row.importance) * 0.5 + Number(row.confidence) * 0.5,
        matchedBy: /** @type {string[]} */ (['like']),
        sourceRefs: refs,
        evidenceKind: String(row.source_type),
        validFrom: row.valid_from === null ? null : String(row.valid_from),
        validUntil: row.valid_until === null ? null : String(row.valid_until),
        layer: String(row.layer),
        type: String(row.type),
        summary: row.summary === null ? null : String(row.summary),
        contentHash: row.content_hash === null ? null : String(row.content_hash),
      };
    });

    return { hits, diagnostics: diagnose(hits, { query: escapedRaw, tokens, degraded: degradedSearchReason() }) };
  }

  /**
   * 降级原因：没有真的检索索引时，必须承认「走的是 LIKE 兜底」。
   * @returns {'index_missing' | 'fts_unavailable' | null}
   */
  function degradedSearchReason() {
    const index = searchIndexState();
    if (!index.available) return 'index_missing';
    return null;
  }

  /** 检索索引表名（白名单常量，绝不拼接外部输入）。 */
  const INDEX_TABLES = Object.freeze(['search_fts_char', 'search_fts_trigram', 'search_ngram']);

  /**
   * 索引与主账是否对不上。
   *
   * 这个状态必须单独说出来：**「索引是空的」和「库里没有这条记忆」是两件完全不同的事**。
   * 前者是故障（该重建索引），后者是事实（该让它知道）。
   *
   * @returns {string | null} 不一致的说明；一致则 null
   */
  function indexLooksStale() {
    try {
      const totalRow = /** @type {{n?: number} | undefined} */ (db.prepare('SELECT COUNT(*) AS n FROM memories').get());
      const total = Number(totalRow?.n ?? 0);
      if (total === 0) return null;
      for (const name of INDEX_TABLES) {
        if (!tableExists(name)) return `缺少索引表 ${name}`;
        const row = /** @type {{n?: number} | undefined} */ (db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get());
        if (Number(row?.n ?? 0) === 0) return `${name} 是空的（主账有 ${total} 条记忆）`;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * 把门面返回的 hits 规整成检查器形状，并补上**来源核验结论**。
   *
   * 门面的 hits 只说「这条命中指向哪些来源」，不说「还找得到吗」。
   * 核验属于展示层的活，但结论只有三种，且**第三种必须存在**：
   *   ok / 失败原因 / 无法验证（外部 URL 这类本地证明不了的）。
   * 把「无法验证」写成 ok，就是假装有证据。
   *
   * @param {any[]} hits
   */
  function annotateHits(hits) {
    /** @type {Map<string, { alive: boolean, hash: string | null }>} */
    const eventState = new Map();
    /** @type {string[]} */
    const eventIds = [];
    for (const hit of hits) {
      for (const ref of hit.sourceRefs ?? []) {
        const eventId = ref?.eventId ?? ref?.event_id ?? null;
        if (typeof eventId === 'string' && eventId.length > 0) eventIds.push(eventId);
      }
    }
    const unique = [...new Set(eventIds)];
    for (let i = 0; i < unique.length; i += 200) {
      const chunk = unique.slice(i, i + 200);
      const rows = /** @type {any[]} */ (
        db
          .prepare(
            `SELECT event_id, payload_hash, deletion_epoch FROM events
              WHERE event_id IN (${chunk.map(() => '?').join(', ')})`,
          )
          .all(...chunk.map((id) => toBindable(id)))
      );
      for (const row of rows) {
        eventState.set(String(row.event_id), {
          alive: Number(row.deletion_epoch ?? 0) === 0,
          hash: row.payload_hash === null ? null : String(row.payload_hash),
        });
      }
    }

    return hits.map((hit) => ({
      ...hit,
      sourceRefs: (hit.sourceRefs ?? []).map((ref) => {
        const eventId = ref.eventId ?? ref.event_id ?? null;
        const kind = String(ref.sourceKind ?? ref.source_kind ?? ref.kind ?? 'event');
        const contentHash = ref.contentHash ?? ref.content_hash ?? null;
        const state = typeof eventId === 'string' && eventId.length > 0 ? eventState.get(eventId) : undefined;
        /** @type {{ ok: boolean | null, reason?: string }} */
        let verification;
        if (kind === 'event' || eventId !== null) {
          if (typeof eventId !== 'string' || eventId.length === 0 || state === undefined || !state.alive) {
            verification = { ok: false, reason: 'source_missing' };
          } else if (contentHash !== null && state.hash !== null && contentHash !== state.hash) {
            verification = { ok: false, reason: 'hash_mismatch' };
          } else {
            verification = { ok: true };
          }
        } else {
          verification = { ok: null, reason: 'unverifiable_kind' };
        }
        return {
          refId: String(ref.id ?? ref.refId ?? ref.ref_id ?? ''),
          kind,
          sourceSystem: ref.sourceSystem ?? ref.source_system ?? null,
          sourceEventId: ref.sourceEventId ?? ref.source_event_id ?? null,
          eventId: typeof eventId === 'string' && eventId.length > 0 ? eventId : null,
          docRef: ref.docRef ?? null,
          locator: ref.locator ?? null,
          contentHash,
          independentSourceKey: ref.independentSourceKey ?? ref.independent_source_key ?? null,
          occurredAt: null,
          verification,
        };
      }),
    }));
  }

  /**
   * 诊断四态判定。**这是整个检查器最要紧的一段**：
   * 「没搜到」和「搜到了但不敢用」是两件完全不同的事，混在一起会让人误以为库里没有。
   *
   * @param {any[]} hits
   * @param {{ query: string, tokens: string[], degraded: string | null }} ctx
   */
  function diagnose(hits, ctx) {
    /** @type {string[]} */
    const notes = [];
    if (hits.length === 0) {
      notes.push(`「${ctx.query}」在库中没有字面匹配（词：${ctx.tokens.join(' / ')}）。`);
      notes.push('这表示没有相关记忆，不表示检索失败。');
      return {
        status: /** @type {const} */ ('no_related'),
        queryWasEscaped: true,
        degraded: ctx.degraded,
        notes,
      };
    }

    /** @type {string[]} */
    const conflictReasons = [];
    /** @type {string[]} */
    const missingReasons = [];
    let noSourceHits = 0;
    let lowConfidenceHits = 0;

    for (const hit of hits) {
      const refs = Array.isArray(hit.sourceRefs) ? hit.sourceRefs : [];
      const independent = new Set(
        refs.map((r) => r?.independentSourceKey).filter((k) => typeof k === 'string' && k.length > 0),
      );
      if (refs.length === 0) noSourceHits += 1;
      if (hit.evidenceKind === 'inference' && Number(hit.score) < 1) lowConfidenceHits += 1;

      const broken = refs.filter((r) => r?.verification?.ok === false);
      if (broken.length > 0) {
        missingReasons.push(
          `${hit.memoryId} 的 ${broken.length} 条来源无法证实（${[...new Set(broken.map((b) => b.verification.reason))].join('/')}）`,
        );
      }
      // 同一独立来源键下有多个互斥版本 = 冲突
      const versionKeys = new Set(refs.map((r) => `${r.independentSourceKey ?? ''}#${r.refId}`));
      if (refs.length >= 2 && independent.size === 1 && versionKeys.size >= 2) {
        conflictReasons.push(`${hit.memoryId} 的 ${refs.length} 条来源指向同一个独立来源，但内容版本不一致`);
      }
    }

    // 跨命中冲突：两条 hit 同 type、同 layer、都是非推断证据、摘要不同且指向同一独立来源。
    // 这是最危险的一类——「同一个来源却说出两种话」，注入哪一条都可能是错的。
    for (let i = 0; i < hits.length; i += 1) {
      for (let j = i + 1; j < hits.length; j += 1) {
        const a = hits[i];
        const b = hits[j];
        if (a.type !== b.type || a.layer !== b.layer) continue;
        if (a.evidenceKind === 'inference' || b.evidenceKind === 'inference') continue;
        if (Number(a.score) < 0.5 || Number(b.score) < 0.5) continue;
        if ((a.summary ?? '') === (b.summary ?? '')) continue;
        const keysA = new Set((a.sourceRefs ?? []).map((r) => r?.independentSourceKey).filter(Boolean));
        const keysB = new Set((b.sourceRefs ?? []).map((r) => r?.independentSourceKey).filter(Boolean));
        const shared = [...keysA].filter((k) => keysB.has(k));
        if (shared.length > 0) {
          conflictReasons.push(`${a.memoryId} 与 ${b.memoryId} 断言不同，却共享同一来源 ${shared[0]}`);
        }
      }
    }

    if (conflictReasons.length > 0) {
      notes.push(...conflictReasons.slice(0, 5));
      notes.push('冲突未消解前，这些内容不能当作可信事实注入。');
      return {
        status: /** @type {const} */ ('source_conflict'),
        queryWasEscaped: true,
        degraded: ctx.degraded,
        notes,
      };
    }
    if (missingReasons.length > 0) {
      notes.push(...missingReasons.slice(0, 5));
      notes.push('来源丢失意味着无法回到原始事件核对，命中结果只能当线索。');
      return {
        status: /** @type {const} */ ('source_missing'),
        queryWasEscaped: true,
        degraded: ctx.degraded,
        notes,
      };
    }
    if (noSourceHits > 0 || lowConfidenceHits > 0) {
      notes.push(
        noSourceHits > 0
          ? `${noSourceHits} / ${hits.length} 条命中没有任何来源引用，不能作为证据。`
          : '',
      );
      notes.push(
        lowConfidenceHits > 0 ? `${lowConfidenceHits} 条命中是推断（source_type=inference），置信度不足。` : '',
      );
      notes.push('命中存在，但证据强度不够支撑回答——应明确说「不确定」而不是硬答。');
      return {
        status: /** @type {const} */ ('insufficient_evidence'),
        queryWasEscaped: true,
        degraded: ctx.degraded,
        notes: notes.filter((n) => n.length > 0),
      };
    }

    notes.push(`命中 ${hits.length} 条，来源与置信度均可核对。`);
    return { status: /** @type {const} */ ('ok'), queryWasEscaped: true, degraded: ctx.degraded, notes };
  }

  /**
   * 检索入口。**门面优先**：四种「检索不足」的判定是 memory 层的领域逻辑，不在这里重写。
   * 垫片只在两种情况下接手，且都会在 diagnostics 里标 degraded，绝不静默替换：
   *   1. 门面不存在（M2 早期）；
   *   2. 门面报 no_related 但索引与主账明显不一致（索引是空的）。
   *
   * @param {{ query: string, scopeId?: string|null, personId?: string|null, limit?: unknown,
   *   asOf?: string|null, minCoverage?: unknown }} input
   */
  async function searchMemories(input) {
    const rawQuery = typeof input.query === 'string' ? input.query : '';
    if (rawQuery.trim().length === 0) throw invalid('检索需要 q（非空字符串）');
    if (rawQuery.length > MAX_QUERY_CHARS) throw invalid(`q 超过 ${MAX_QUERY_CHARS} 字符上限`);
    const limit = normalizeLimit(input.limit);
    const minCoverage =
      input.minCoverage === undefined || input.minCoverage === null || input.minCoverage === ''
        ? undefined
        : Number(input.minCoverage);
    if (minCoverage !== undefined && (!Number.isFinite(minCoverage) || minCoverage < 0 || minCoverage > 1)) {
      throw invalid('minCoverage 必须在 0..1');
    }

    if (hasSearchFacade) {
      try {
        const result = await facade.search({
          query: rawQuery,
          scopeId: input.scopeId ?? undefined,
          personId: input.personId ?? undefined,
          limit,
          asOf: input.asOf ?? undefined,
          minCoverage,
        });
        if (result && Array.isArray(result.hits)) {
          const hits = annotateHits(result.hits);
          const diagnostics = result.diagnostics ?? {
            status: 'ok',
            queryWasEscaped: true,
            degraded: null,
            notes: [],
          };
          // 索引空着的时候，门面会诚实地报 no_related。但那不是「库里没有」。
          // 这里再核一次索引状态，把「索引坏了」和「真没有」区分开。
          if (hits.length === 0 && diagnostics.status === 'no_related') {
            const stale = indexLooksStale();
            if (stale !== null) {
              const fallback = await shimSearch({ ...input, limit });
              return {
                hits: fallback.hits,
                diagnostics: {
                  ...fallback.diagnostics,
                  status: fallback.hits.length > 0 ? 'ok' : 'no_related',
                  degraded: 'index_stale',
                  notes: [
                    `检索索引与主账不一致：${stale}。`,
                    '本次退回参数化 LIKE 兜底——结果偏少，属于降级检索，不能当作「库里没有」。',
                    ...fallback.diagnostics.notes,
                  ],
                },
                implementation: 'shim',
              };
            }
          }
          return { hits, diagnostics, implementation };
        }
      } catch (err) {
        logger.warn(`memories.search 门面失败，本次退回垫片：${/** @type {Error} */ (err).message}`);
        const fallback = await shimSearch({ ...input, limit });
        return {
          ...fallback,
          implementation: 'shim',
          diagnostics: {
            ...fallback.diagnostics,
            degraded: fallback.diagnostics.degraded ?? 'fts_unavailable',
            notes: [
              '门面检索出错，本次用的是垫片结果（可信度下降，结论仅供参考）。',
              ...fallback.diagnostics.notes,
            ],
          },
        };
      }
    }

    const fallback = await shimSearch({ ...input, limit });
    return { ...fallback, implementation };
  }

  // =========================================================================
  // 上下文包
  // =========================================================================

  /**
   * 从 `memory_versions` 列还原 segments。
   * 两种形态都兼容：
   *  1. `[{memoryId, version}]`（M1 表的紧凑形态）→ 反查 memories；
   *  2. `{segments, injectedText, budget}`（context2 的完整快照）→ 直接用。
   *
   * @param {any} columnValue
   */
  function readPackagePayload(columnValue) {
    const parsed = parseJson(columnValue, null);
    if (Array.isArray(parsed)) {
      return { shape: 'memory_ids', refs: parsed, segments: null, injectedText: null, budget: null };
    }
    if (parsed && typeof parsed === 'object') {
      const segments = Array.isArray(parsed.segments) ? parsed.segments : null;
      return {
        shape: segments ? 'snapshot' : 'unknown',
        refs: segments ? null : [],
        segments,
        injectedText: typeof parsed.injectedText === 'string' ? parsed.injectedText : null,
        budget: parsed.budget && typeof parsed.budget === 'object' ? parsed.budget : null,
      };
    }
    return { shape: 'unknown', refs: [], segments: null, injectedText: null, budget: null };
  }

  /**
   * 把紧凑形态的 `[{memoryId, version}]` 补成可读 segment。
   *
   * **scope 收口**：只补同 scope 的记忆；跨 scope 的引用一律按 `missing` 处理
   * （与「这一版记忆已不在主账」同形，不确认存在性）。
   *
   * @param {any[]} refs
   * @param {string|null} [scopeId] 上下文包的 scope（调用方已收口）；null 表示内部跨 scope
   */
  function hydrateSegments(refs, scopeId = null) {
    /** @type {any[]} */
    const segments = [];
    for (const ref of refs.slice(0, PAGE_HARD_CAP)) {
      const memoryId = typeof ref === 'string' ? ref : ref?.memoryId ?? ref?.memory_id ?? null;
      if (typeof memoryId !== 'string' || memoryId.length === 0) continue;
      const row = /** @type {any} */ (
        db
          .prepare('SELECT * FROM memories WHERE id = ? AND (? IS NULL OR scope_id = ?)')
          .get(toBindable(memoryId), toBindable(scopeId), toBindable(scopeId))
      );
      if (row === undefined || row === null) {
        segments.push({
          memoryId,
          version: typeof ref === 'object' && ref !== null ? Number(ref.version ?? 0) : 0,
          missing: true,
          note: '这一版记忆已不在主账（被删除或从未落库），本段无内容可核对',
        });
        continue;
      }
      const sources = sourcesForMany([memoryId]).get(memoryId) ?? [];
      segments.push({
        memoryId,
        version: Number(row.version),
        layer: String(row.layer),
        type: String(row.type),
        summary: row.summary === null ? null : String(row.summary),
        contentHash: row.content_hash === null ? null : String(row.content_hash),
        sourceRefs: sources,
        evidenceKind: String(row.source_type),
        validFrom: row.valid_from === null ? null : String(row.valid_from),
        validUntil: row.valid_until === null ? null : String(row.valid_until),
        deleted: isTombstoned('memory', memoryId),
      });
    }
    return segments;
  }

  /**
   * 载体（`options.system` 与 `options.messages[role=system]` 两级，契约 10.9）的展示文案。
   * @param {string|null} carrier
   */
  function carrierLabel(carrier) {
    if (carrier === 'system') return 'options.system（主请求 system 字段）';
    if (carrier === 'messages[role=system]') return 'options.messages[role=system]（system 角色消息）';
    return null;
  }

  /**
   * 三级证据：built / attached / sent 是三个不同强度的断言，不许折叠成一个「已注入」。
   * sent 的判据按契约 10.4：payload hash 在最终请求对象中命中；10.9：要查
   * `options.system` 与 `options.messages[role=system]` **两级承载**。
   *
   * 载体与 sent 明细由 0003 迁移的 `carrier` / `sent_evidence_json` 承载
   * （M2 早期这两列还不存在，所以下面的「未记录」分支只在真没写时出现）。
   *
   * @param {any} row `context_packages` 原始行
   * @param {{ carrier?: string|null, sentEvidence?: any, evidenceStrength?: string|null }} [normalized]
   */
  function buildEvidence(row, normalized = {}) {
    const status = String(row.status);
    const builtAt = row.built_at === null ? null : String(row.built_at);
    const attachedAt = row.attached_at === null ? null : String(row.attached_at);
    const sentAt = row.sent_at === null ? null : String(row.sent_at);
    const payloadHash = row.payload_hash === null ? null : String(row.payload_hash);

    const carrier = normalized.carrier ?? (row.carrier === null || row.carrier === undefined ? null : String(row.carrier));
    const sentEvidence = normalized.sentEvidence ?? parseJson(row.sent_evidence_json, null);
    const evidenceStrength =
      normalized.evidenceStrength ??
      (row.evidence_strength === null || row.evidence_strength === undefined ? null : String(row.evidence_strength));

    const attachedProven = attachedAt !== null || status === 'attached' || status === 'sent';
    const sentProven = sentAt !== null || status === 'sent';
    /** @type {'none'|'built'|'attached'|'sent'} */
    let ceiling = 'built';
    if (sentProven) ceiling = 'sent';
    else if (attachedProven) ceiling = 'attached';
    if (status === 'discarded' || status === 'expired') ceiling = 'none';

    /** @type {string[]} */
    const caveats = [];
    if (ceiling === 'none') {
      caveats.push(`本包状态为 ${status}：已失效，不能作为注入证据（删除屏障会把旧包标 discarded）。`);
    }
    if (status === 'sent' && sentAt === null) {
      caveats.push('状态标了 sent，但 sent_at 为空：时间戳缺失，证据链不完整。');
    }
    if (attachedProven && attachedAt === null) {
      caveats.push('状态到了 attached，但没有 attached_at：只有状态没有时刻。');
    }
    if (sentProven) {
      caveats.push(
        'sent 只证明「宿主决定把这些内容发出去」（llm/stream 最终请求对象里命中），不证明字节真的出网。',
      );
      const label = carrierLabel(carrier);
      if (label === null) {
        caveats.push(
          '载体（options.system 还是 options.messages[role=system]，契约 10.9 两级）没有记录，无法确认是哪种承载——证据链缺这一环。',
        );
      } else {
        caveats.push(`载体已记录：${label}（契约 10.9 两级已查证是这一级）。`);
      }
      if (sentEvidence !== null && typeof sentEvidence === 'object' && sentEvidence.provesWireDelivery === false) {
        caveats.push('sent 证据自述「不证明字节出网」（provesWireDelivery=false），与上面的边界一致。');
      }
    }
    if (!sentProven) {
      caveats.push('未达 sent：没有请求边界证据，任何「已注入模型」的说法都不成立。');
    }
    if (evidenceStrength !== null && evidenceStrength !== 'primary') {
      caveats.push(
        `检索质量标记为 ${evidenceStrength}：命中的是兜底路径（不是主索引），结论要比对来源再用。`,
      );
    }

    return {
      ceiling,
      steps: [
        {
          level: 'built',
          proven: true,
          at: builtAt,
          basis: payloadHash === null
            ? 'context_packages 行存在，但缺 payload_hash'
            : 'context_packages 行存在 + payload_hash',
        },
        {
          level: 'attached',
          proven: attachedProven,
          at: attachedAt,
          basis: attachedAt !== null
            ? 'attached_at 有记录'
            : attachedProven
              ? '只有状态标记，没有 attached_at'
              : '无 attached 证据',
        },
        {
          level: 'sent',
          proven: sentProven,
          at: sentAt,
          basis: sentAt !== null
            ? 'sent_at 有记录（判据：payload hash 命中最终请求对象）'
            : sentProven
              ? '只有状态标记，没有 sent_at'
              : '无请求边界证据',
        },
      ],
      // 0003 的这两列就是为它加的：有就如实显示，没有就说是缺
      carrier,
      carrierLabel: carrierLabel(carrier),
      carrierNote:
        carrier === null
          ? '主账未记录注入载体；契约 10.9 要求查 system 与 messages[role=system] 两级。'
          : `载体来自 context_packages.carrier（观测到的实际承载位置）。`,
      sentEvidence,
      evidenceStrength,
      payloadHash,
      caveats,
    };
  }

  /**
   * 把 `budget_json` / 门面 budget 统一成界面要的形状。
   * 被丢掉的段只带 memoryId 的话人看不出「丢得对不对」，所以补摘要——查不到就留空，不编。
   *
   * @param {any} raw 预算对象（来自 budget_json 或 memory_versions 快照）
   * @param {string} source 说明来源
   */
  function normalizeBudget(raw, source) {
    const dropped = Array.isArray(raw?.dropped) ? raw.dropped : [];
    const droppedIds = [...new Set(
      dropped
        .map((d) => String(d?.memoryId ?? d?.memory_id ?? ''))
        .filter((id) => id.length > 0),
    )].slice(0, 100);
    /** @type {Map<string, string|null>} */
    const summaryById = new Map();
    if (droppedIds.length > 0) {
      const rows = /** @type {any[]} */ (
        db
          .prepare(
            `SELECT id, summary, content FROM memories
              WHERE id IN (${droppedIds.map(() => '?').join(', ')})`,
          )
          .all(...droppedIds.map((id) => toBindable(id)))
      );
      for (const row of rows) {
        const text = row.summary === null || row.summary === ''
          ? (row.content === null ? null : String(row.content).slice(0, 80))
          : String(row.summary);
        summaryById.set(String(row.id), text);
      }
    }
    return {
      recorded: true,
      allowance:
        raw?.brainAllowance ?? raw?.allowance ?? raw?.brain_allowance ?? null,
      used: raw?.used ?? raw?.usedTokens ?? raw?.used_tokens ?? null,
      dropped: dropped.map((d) => {
        const memoryId = String(d?.memoryId ?? d?.memory_id ?? '');
        return {
          memoryId,
          reason: d?.reason === undefined || d?.reason === null ? null : String(d.reason),
          summary: summaryById.get(memoryId) ?? null,
          // 查不到摘要说明这条记忆已经不在主账（删了/从未落库），得说清楚
          stillExists: summaryById.has(memoryId),
        };
      }),
      source,
    };
  }

  /**
   * 构包详情。
   *
   * 数据来源优先级（0003 之后有正列，别再去 memory_versions 里猜形状）：
   *   预算 → `budget_json` → memory_versions 快照
   *   段   → `segments_json` → memory_versions 快照 → memory_versions 引用补查
   *   载体 → `carrier`（契约 10.9 的实际观测值）
   *
   * **scope 收口**：上下文包按调用方 scope 过滤，跨 scope 的 contextId 与「不存在」同形
   * （返回 null → 404）。包内引用记忆的补全文也按包自己的 scope 再过滤一次。
   *
   * @param {string} contextId
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   */
  async function getContext(contextId, opts = {}) {
    if (typeof contextId !== 'string' || contextId.length === 0) throw invalid('缺少 contextId');
    const scopeId =
      opts.allowCrossScope === true
        ? null
        : (typeof opts.scopeId === 'string' && opts.scopeId.trim().length > 0 ? opts.scopeId.trim() : defaultScopeId);
    const row = /** @type {any} */ (
      db
        .prepare('SELECT * FROM context_packages WHERE context_id = ? AND (? IS NULL OR scope_id = ?)')
        .get(toBindable(contextId), toBindable(scopeId), toBindable(scopeId))
    );
    if (row === undefined || row === null) return null;

    // 门面优先：context2 已把 0003 的 JSON 列规范化过（含枚举校验）
    /** @type {any} */
    let pkg = null;
    try {
      const facade = /** @type {any} */ (brain.contextPackages);
      // scope 必须跟着主查询走：门面默认用「服务端绑定 scope」，而这里是**声明上下文**
      // （`?scopeId=` 或 allowCrossScope）。不传就会在显式切 scope 时静默丢掉门面的
      // 规范化字段（carrier / segments / budget），页面看起来「数据缺一块」却不报错。
      if (facade && typeof facade.get === 'function') {
        pkg = scopeId === null
          ? facade.get(contextId, { allowCrossScope: true })
          : facade.get(contextId, { scopeId });
      }
    } catch (err) {
      logger.warn(`contextPackages.get 失败，退回直接读列：${/** @type {Error} */ (err).message}`);
    }

    const carrier = pkg?.carrier ?? (row.carrier === null || row.carrier === undefined ? null : String(row.carrier));
    const evidenceStrength =
      pkg?.evidenceStrength ??
      (row.evidence_strength === null || row.evidence_strength === undefined
        ? null
        : String(row.evidence_strength));
    const sentEvidence = pkg?.sentEvidence ?? parseJson(row.sent_evidence_json, null);
    const diagnostics = pkg?.diagnostics ?? parseJson(row.diagnostics_json, null);
    const stepId = pkg?.stepId ?? (row.step_id === null || row.step_id === undefined ? null : String(row.step_id));
    const injectedTextHash =
      pkg?.injectedTextHash ??
      (row.injected_text_hash === null || row.injected_text_hash === undefined
        ? null
        : String(row.injected_text_hash));

    const memPayload = readPackagePayload(row.memory_versions);

    // ---- 段：segments_json 优先
    /** @type {any[]} */
    let segments;
    /** @type {string} */
    let segmentSource;
    const segmentsJson = Array.isArray(pkg?.segments) && pkg.segments.length > 0
      ? pkg.segments
      : parseJson(row.segments_json, null);
    if (Array.isArray(segmentsJson) && segmentsJson.length > 0) {
      segments = segmentsJson.map((seg) => ({
        memoryId: String(seg?.memoryId ?? seg?.memory_id ?? ''),
        version: seg?.version === undefined || seg?.version === null ? 0 : Number(seg.version),
        layer: seg?.layer ?? null,
        type: seg?.type ?? null,
        summary: seg?.summary ?? null,
        contentHash: seg?.contentHash ?? seg?.content_hash ?? null,
        sourceRefs: Array.isArray(seg?.sourceRefs) ? seg.sourceRefs : [],
        evidenceKind: seg?.evidenceKind ?? seg?.evidence_kind ?? null,
        validFrom: seg?.validFrom ?? null,
        validUntil: seg?.validUntil ?? null,
        deleted: false,
      }));
      segmentSource = 'segments_json';
    } else if (memPayload.shape === 'snapshot') {
      segments = memPayload.segments ?? [];
      segmentSource = 'memory_versions 快照';
    } else {
      segments = hydrateSegments(memPayload.refs ?? [], String(row.scope_id));
      segmentSource = 'memory_versions 引用（补查主账）';
    }

    // ---- 预算：budget_json 优先，其次 M2 的快照形态
    /** @type {any} */
    let budget;
    const budgetJson = pkg?.budget !== undefined && pkg?.budget !== null
      ? pkg.budget
      : parseJson(row.budget_json, null);
    if (budgetJson !== null && typeof budgetJson === 'object') {
      budget = normalizeBudget(budgetJson, 'context_packages.budget_json');
    } else if (memPayload.budget !== null && typeof memPayload.budget === 'object') {
      budget = normalizeBudget(memPayload.budget, 'context_packages.memory_versions 快照');
    } else {
      budget = {
        recorded: false,
        allowance: null,
        used: null,
        dropped: [],
        source: null,
        note: '本次构包未记录预算明细（budget_json 为空，快照里也没有）。段数与 Token 估算只能看 estimated_tokens 这一项——不能据此说「预算没问题」。',
      };
    }

    const evidence = buildEvidence(row, { carrier, sentEvidence, evidenceStrength });

    return {
      package: {
        contextId: String(row.context_id),
        scopeId: String(row.scope_id),
        personId: row.person_id === null ? null : String(row.person_id),
        sessionId: row.session_id === null ? null : String(row.session_id),
        turnId: row.turn_id === null ? null : String(row.turn_id),
        stepId,
        policyVersion: String(row.policy_version),
        tokenizerId: row.tokenizer_id === null ? null : String(row.tokenizer_id),
        estimatedTokens: row.estimated_tokens === null ? null : Number(row.estimated_tokens),
        payloadHash: row.payload_hash === null ? null : String(row.payload_hash),
        status: String(row.status),
        builtAt: row.built_at === null ? null : String(row.built_at),
        attachedAt: row.attached_at === null ? null : String(row.attached_at),
        sentAt: row.sent_at === null ? null : String(row.sent_at),
        expiresAt: row.expires_at === null ? null : String(row.expires_at),
        deletionEpoch: Number(row.deletion_epoch ?? 0),
        segmentCount: segments.length,
        // 注入文本原文只在快照里；同时给出 hash，便于核对
        injectedText: memPayload.injectedText,
        injectedTextHash,
        carrier,
        evidenceStrength,
      },
      status: String(row.status),
      segments,
      segmentSource,
      budget,
      diagnostics,
      evidence,
      payloadShape: segmentSource,
    };
  }

  /**
   * 构包列表。
   *
   * **scope 收口**：和 `listMemories` 同口径——缺省只看服务端默认 scope，
   * 不再「不传 = 全库」。列表里带 `sessionId` / `payloadHash` 等元数据，
   * 跨 scope 列出来同样是泄露（§22.4 第 4 类：正文和元数据均不得泄露）。
   *
   * @param {{ sessionId?: string, turnId?: string, limit?: unknown, cursor?: string | null,
   *   scopeId?: string, allowCrossScope?: boolean }} [query]
   */
  async function listContexts(query = {}) {
    const limit = normalizeLimit(query.limit);
    const cursor = decodeCursor(query.cursor ?? null);
    if (cursor && (cursor.k === '' || cursor.id === '')) throw invalid('cursor 非法');

    const clauses = [];
    /** @type {any[]} */
    const params = [];
    const scopeId =
      query.allowCrossScope === true
        ? null
        : (typeof query.scopeId === 'string' && query.scopeId.trim().length > 0 ? query.scopeId.trim() : defaultScopeId);
    if (scopeId) {
      clauses.push('scope_id = ?');
      params.push(scopeId);
    }
    if (query.sessionId) {
      clauses.push('session_id = ?');
      params.push(query.sessionId);
    }
    if (query.turnId) {
      clauses.push('turn_id = ?');
      params.push(query.turnId);
    }
    if (cursor) {
      clauses.push('(built_at < ? OR (built_at = ? AND context_id < ?))');
      params.push(cursor.k, cursor.k, cursor.id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = /** @type {any[]} */ (
      db
        .prepare(`SELECT * FROM context_packages ${where} ORDER BY built_at DESC, context_id DESC LIMIT ?`)
        .all(...params.map((p) => toBindable(p)), toBindable(limit + 1))
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];

    return {
      items: page.map((row) => {
        // 段数：segments_json（0003）优先，其次 memory_versions 的两种形态
        const segsJson = parseJson(row.segments_json, null);
        const payload = readPackagePayload(row.memory_versions);
        const segmentCount =
          Array.isArray(segsJson) && segsJson.length > 0
            ? segsJson.length
            : payload.shape === 'snapshot'
              ? (payload.segments ?? []).length
              : (payload.refs ?? []).length;
        const budgetJson = parseJson(row.budget_json, null);
        return {
          contextId: String(row.context_id),
          sessionId: row.session_id === null ? null : String(row.session_id),
          turnId: row.turn_id === null ? null : String(row.turn_id),
          stepId: row.step_id === null || row.step_id === undefined ? null : String(row.step_id),
          status: String(row.status),
          estimatedTokens: row.estimated_tokens === null ? null : Number(row.estimated_tokens),
          tokenizerId: row.tokenizer_id === null ? null : String(row.tokenizer_id),
          segmentCount,
          payloadHash: row.payload_hash === null ? null : String(row.payload_hash),
          builtAt: row.built_at === null ? null : String(row.built_at),
          // 一眼看出「这个包有没有预算说明、载体记没记、检索质量如何」
          hasBudget: budgetJson !== null && typeof budgetJson === 'object',
          carrier: row.carrier === null || row.carrier === undefined ? null : String(row.carrier),
          evidenceStrength:
            row.evidence_strength === null || row.evidence_strength === undefined
              ? null
              : String(row.evidence_strength),
          attachedAt: row.attached_at === null ? null : String(row.attached_at),
          sentAt: row.sent_at === null ? null : String(row.sent_at),
          deletionEpoch: Number(row.deletion_epoch ?? 0),
        };
      }),
      nextCursor: hasMore && last ? encodeCursor({ k: String(last.built_at), id: String(last.context_id) }) : null,
      limit,
      limitNote: clampNote(query.limit, limit),
    };
  }

  // =========================================================================
  // 写入（owner 显式指令）
  // =========================================================================

  /**
   * 归一化 MemoryDraft 并校验。**校验不信任客户端**，也不采信正文里的 scope/person 自述
   * （scopeId 必须由调用方显式给，缺省用 DEFAULT_SCOPE）。
   *
   * @param {any} body
   */
  function normalizeDraft(body) {
    if (body === null || typeof body !== 'object') throw invalid('请求体必须是对象');
    const content = typeof body.content === 'string' ? body.content : '';
    if (content.trim().length === 0) throw invalid('content 必填');
    if (content.length > MAX_CONTENT_CHARS) throw invalid(`content 超过 ${MAX_CONTENT_CHARS} 字符上限`);

    const layer = pickEnum(body.layer, LAYERS, 'layer') ?? 'long';
    const type = pickEnum(body.type, TYPES, 'type') ?? 'semantic';
    const sourceType = pickEnum(body.sourceType ?? body.source_type, SOURCE_TYPES, 'sourceType') ?? 'owner_words';
    const privacy = pickEnum(body.privacy, PRIVACY, 'privacy') ?? 'private';

    let confidence = body.confidence === undefined ? 0.6 : Number(body.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw invalid('confidence 必须在 0..1');
    }
    // CONTRACTS §5：推断必须 confidence < 1，不得伪装成确定事实。
    if (sourceType === 'inference' && confidence >= 1) {
      confidence = 0.99;
    }
    let importance = body.importance === undefined ? 0.5 : Number(body.importance);
    if (!Number.isFinite(importance) || importance < 0 || importance > 1) {
      throw invalid('importance 必须在 0..1');
    }

    const summaryInput = typeof body.summary === 'string' && body.summary.trim().length > 0
      ? body.summary.trim()
      : content.trim().slice(0, 120);
    const summary = summaryInput.slice(0, MAX_SUMMARY_CHARS);

    const scopeId = typeof body.scopeId === 'string' && body.scopeId.trim().length > 0
      ? body.scopeId.trim()
      : 'owner-default';
    if (scopeId.length > 200) throw invalid('scopeId 过长');

    // 防循环来源（CONTRACTS §10.6 / M2-INTERFACES §1.1）：
    // 控制台是主人亲自敲的字，但**不能**标 originSystem='brain'——那等于让 Brain 自己的
    // 产物冒充人类证据，正是 §10.6 那条实测闭环链的起点。'dsh' 表示「经宿主通道进来的人类输入」，
    // 语义最贴近，也正好过 memory 层的防循环校验（brain 不得配 owner_words）。
    const originSystem = pickEnum(body.originSystem, ['brain', 'dsh', 'engram', 'lingshu'], 'originSystem') ?? 'dsh';

    return {
      scopeId,
      personId: typeof body.personId === 'string' && body.personId.trim().length > 0 ? body.personId.trim() : 'owner',
      layer,
      type,
      content,
      summary,
      sourceType,
      sourceIds: Array.isArray(body.sourceIds) ? body.sourceIds.filter((x) => typeof x === 'string').slice(0, 50) : [],
      confidence,
      importance,
      privacy,
      pinned: body.pinned === true,
      validFrom: pickIso(body.validFrom, 'validFrom'),
      validUntil: pickIso(body.validUntil, 'validUntil'),
      originSystem,
      producer: 'apps/server:POST /api/memories',
    };
  }

  /**
   * @param {any} draft
   */
  async function createMemory(draft) {
    if (options.readOnly === true) {
      throw invalid('本服务以 --read-only 启动，拒绝写入', 'STORAGE_READONLY');
    }
    const d = normalizeDraft(draft);

    if (typeof facade?.create === 'function') {
      const created = await facade.create({
        scopeId: d.scopeId,
        personId: d.personId,
        layer: d.layer,
        type: d.type,
        content: d.content,
        summary: d.summary,
        sourceType: d.sourceType,
        sourceIds: d.sourceIds,
        confidence: d.confidence,
        importance: d.importance,
        privacy: d.privacy,
        pinned: d.pinned,
        validFrom: d.validFrom,
        validUntil: d.validUntil,
        originSystem: d.originSystem,
        producer: d.producer,
      });
      return {
        id: String(created.id),
        version: Number(created.version ?? 1),
        createdAt: created.createdAt ?? new Date().toISOString(),
        implementation,
      };
    }

    // ---- 垫片写入：走 M1 的单一写入队列，同一事务写 memories + memory_versions。
    const id = `mem_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    const contentHash = sha256(d.content);
    const stamp = brain.clock.stamp();
    await brain.queue.write(
      (tx) => {
        tx.run(
          `INSERT INTO memories (
             id, person_id, scope_id, layer, type, content, summary, source_type, source_ids,
             confidence, importance, privacy, status, created_at, created_at_local,
             updated_at, updated_at_local, mention_count, recall_count,
             valid_from, valid_from_local, valid_until, valid_until_local, pinned, version,
             content_hash, deletion_epoch
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, 1, ?, 0)`,
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
            stamp.utc,
            stamp.local,
            stamp.utc,
            stamp.local,
            d.validFrom,
            d.validFrom === null ? null : stamp.local,
            d.validUntil,
            d.validUntil === null ? null : stamp.local,
            d.pinned ? 1 : 0,
            contentHash,
          ].map((v) => toBindable(v)),
        );
        tx.run(
          `INSERT INTO memory_versions (
             memory_id, version, content, summary, status, source_type, source_ids,
             confidence, importance, privacy, changed_by, change_reason, content_hash,
             created_at, created_at_local
           ) VALUES (?, 1, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            d.content,
            d.summary,
            d.sourceType,
            JSON.stringify(d.sourceIds),
            d.confidence,
            d.importance,
            d.privacy,
            d.producer,
            'owner 通过控制台显式写入',
            contentHash,
            stamp.utc,
            stamp.local,
          ].map((v) => toBindable(v)),
        );
      },
      { label: 'server.createMemory' },
    );

    return { id, version: 1, createdAt: stamp.utc, implementation: 'shim' };
  }

  // =========================================================================
  // 删除（写墓碑 → 202 → 异步清正文）
  // =========================================================================

  /**
   * 删除请求。
   *
   * **写路径 scope 收口**：目标必须属于调用方 scope（`body.scopeId` 是声明上下文，
   * 缺省 `defaultScopeId`）——跨 scope 的 id 与「不存在」同形，一律 404；
   * 不确认存在性。`allowCrossScope` 是进程内开关，HTTP 不暴露。
   * 删除请求真正用的 scope 永远取目标行自己的 `scope_id`（上面已校验过相等）。
   *
   * @param {string} id
   * @param {{ scopeId?: string, reason?: string, actor?: string }} [body]
   */
  async function requestDelete(id, body = {}) {
    if (typeof id !== 'string' || id.length === 0) throw invalid('缺少记忆 id');
    if (options.readOnly === true) throw invalid('本服务以 --read-only 启动，拒绝删除', 'STORAGE_READONLY');

    const callerScope =
      typeof body.scopeId === 'string' && body.scopeId.trim().length > 0 ? body.scopeId.trim() : defaultScopeId;
    const existing = /** @type {any} */ (
      db
        .prepare('SELECT id, scope_id, status FROM memories WHERE id = ? AND (? IS NULL OR scope_id = ?)')
        .get(toBindable(id), toBindable(callerScope), toBindable(callerScope))
    );
    if (existing === undefined || existing === null) throw notFound(`记忆不存在：${id}`);

    const scopeId = String(existing.scope_id);
    const reason =
      typeof body.reason === 'string' && body.reason.trim().length > 0
        ? body.reason.trim().slice(0, 500)
        : 'owner 通过控制台请求删除';
    const actor = typeof body.actor === 'string' && body.actor.trim().length > 0 ? body.actor.trim().slice(0, 120) : 'owner';

    const result = await brain.deletion.requestDeletion({
      target_kind: 'memory',
      target_id: id,
      scope_id: scopeId,
      reason,
      actor,
    });

    return {
      status: result.status, // 'accepted' | 'already_tombstoned'
      tombstoneId: result.tombstone_id,
      deletionEpoch: result.deletion_epoch,
      idempotent: result.idempotent === true,
      affected: result.affected ?? [],
      jobs: result.jobs ?? 0,
      cleanup: cleanupProgress(result.tombstone_id),
      // 说清楚 202 的含义：现在「已屏蔽但没删干净」，不是「已删除」。
      meaning:
        result.status === 'already_tombstoned'
          ? '这个目标之前已被删除，本次未重复抬 epoch；内容清除由既有任务继续。'
          : '已立即屏蔽（检索不到），正文由后台 worker 异步清除。返回 202 表示「受理」，不表示「已清干净」。',
    };
  }

  /**
   * 清理进度：让人能看出「删到哪一步了」。
   * @param {string} tombstoneId
   */
  function cleanupProgress(tombstoneId) {
    try {
      const rows = /** @type {any[]} */ (
        db
          .prepare('SELECT status, COUNT(*) AS n FROM deletion_jobs WHERE tombstone_id = ? GROUP BY status')
          .all(toBindable(tombstoneId))
      );
      /** @type {Record<string, number>} */
      const counts = { pending: 0, running: 0, done: 0, failed: 0, dead: 0 };
      for (const r of rows) counts[String(r.status)] = Number(r.n);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      return { total, ...counts, finished: total > 0 && counts.done === total };
    } catch {
      return { total: 0, pending: 0, running: 0, done: 0, failed: 0, dead: 0, finished: false };
    }
  }

  // =========================================================================
  // 健康
  // =========================================================================

  /**
   * 健康与降级。`degraded[]` 里每一条都必须是**真实观察到的**，不是猜的。
   */
  function health() {
    /** @type {Array<{ code: string, severity: 'info'|'warn'|'error', detail: string }>} */
    const degraded = [];

    const index = searchIndexState();
    if (!index.available) {
      degraded.push({
        code: 'search_index_missing',
        severity: 'warn',
        detail: '主账里还没有检索索引表（migrations/0002 未落地）。检索走参数化 LIKE 兜底，中文短词可能漏检；diagnostics.degraded 会标 index_missing。',
      });
    } else if (hasSearchFacade) {
      const stale = indexLooksStale();
      if (stale !== null) {
        degraded.push({
          code: 'search_index_stale',
          severity: 'warn',
          detail: `检索索引与主账不一致：${stale}。检索会退回 LIKE 兜底（比正式索引更容易漏），需要重建索引（memories.reindexAll）。`,
        });
      }
    }
    if (implementation === 'shim') {
      degraded.push({
        code: 'memory_facade_absent',
        severity: 'info',
        detail: 'memory 层的 memories 门面尚未就绪，本服务的写入与检索用兼容垫片。写入仍走单一写入队列，行为可替换。',
      });
    }
    if (!tableExists('context_packages')) {
      degraded.push({
        code: 'context_table_missing',
        severity: 'error',
        detail: 'context_packages 表不存在：上下文检查器不可用，M1 迁移可能没跑。',
      });
    }

    let sizeBytes = null;
    let quickCheck = 'unknown';
    try {
      sizeBytes = statSync(options.dbPath).size;
    } catch {
      sizeBytes = null;
    }
    try {
      const row = /** @type {{ quick_check?: string } | undefined} */ (db.prepare('PRAGMA quick_check').get());
      quickCheck = String(row?.quick_check ?? 'unknown');
    } catch {
      quickCheck = 'failed';
    }
    if (quickCheck !== 'ok' && quickCheck !== 'unknown') {
      degraded.push({
        code: 'db_integrity_not_ok',
        severity: 'error',
        detail: `PRAGMA quick_check = ${quickCheck}`,
      });
    }

    /** @type {any} */
    let pragmas = null;
    try {
      pragmas = brain.readPragmas();
    } catch {
      pragmas = null;
    }
    if (pragmas && String(pragmas.journal_mode) !== 'wal') {
      degraded.push({
        code: 'wal_not_confirmed',
        severity: 'warn',
        detail: `journal_mode = ${pragmas.journal_mode}（期望 wal）：并发读写下可能变慢或撞锁。`,
      });
    }

    return {
      ok: degraded.every((d) => d.severity !== 'error'),
      version: '0.2.0-m2',
      db: {
        path: options.dbPath,
        fileName: path.basename(options.dbPath),
        sizeBytes,
        schemaVersion: String(brain.schemaVersion ?? 'unknown'),
        readOnly: brain.readOnly === true,
        pragmas,
        quickCheck,
      },
      store: {
        implementation,
        // 读/写/检索三条路径分开报：检查器的可信度取决于「哪一层在干活」。
        reader: 'sql-readonly（只读 SELECT）',
        writer: implementation === 'facade' ? 'memories.create（门面）' : 'brain.queue.write（垫片）',
        search: hasSearchFacade ? 'memories.search（门面 + 三路索引）' : 'like-fallback（垫片）',
        indexTables: index.tables,
        indexStale: hasSearchFacade ? indexLooksStale() : null,
      },
      degraded,
    };
  }

  return {
    brain,
    db,
    dbPath: options.dbPath,
    implementation,
    listMemories,
    getMemory,
    searchMemories,
    listContexts,
    getContext,
    createMemory,
    requestDelete,
    health,
    /** 供测试/排障：当前能力快照。 */
    capabilities: () => ({ implementation, hasSearchFacade, ...searchIndexState() }),
    async close() {
      await brain.close();
    },
  };
}
