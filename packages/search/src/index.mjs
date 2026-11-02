// @ts-check
/**
 * `@dsh-brain/search` 主入口：三路索引 + RRF 融合 + 来源回查 + 四种「检索不足」区分。
 *
 * 实测依据（详见 docs/search-capability-report.md）：
 * - FTS5 在本机可用（SQLite 3.53.3，ENABLE_FTS5=1），trigram tokenizer 可用。
 * - unicode61 原样索引中文无效：连续中文（甚至中文 + 相邻数字）会整体成一个 token。
 *   → 主路改用 char-space 检索文本（CJK 逐字加空格）喂 unicode61。
 * - trigram 对 <3 字符查询静默 0 命中（不报错），只能当补充路，不能当主力。
 * - 自维护 n-gram 倒排与参数化 LIKE 都要保留：前者是覆盖率/证据判定的依据，后者是
 *   FTS5 索引万一不可用时的最后兜底。
 *
 * 边界（契约 §1）：本模块只读 memory 提供的连接，不自己建表。
 * 建表语句由 `createSearchSchemaStatements()` 导出，交给 memory 的迁移执行。
 */

import { createSearchIndexDropStatements, searchTableNames } from './schema.mjs';
import { rrfFuse } from './rrf.mjs';
import {
  buildFtsMatch,
  coverageOf,
  ngramTerms,
  normalizeForSearch,
  querySegments,
  toSearchableText,
} from './tokenize.mjs';

/** @typedef {{ id: string, score: number, matchedBy?: string[], coverage?: number }} Hit */
/** @typedef {'ok'|'no_relevant'|'insufficient_evidence'|'source_missing'|'source_conflict'} SearchState */

/**
 * trigram 查询串：只保留字符数 >= 3 的段（<3 字符 trigram 静默 0 命中，实测）。
 * @param {unknown} raw
 * @returns {{ ok: boolean, query: string, skippedShort: number, reason?: string }}
 */
export function buildTrigramMatch(raw) {
  const segs = querySegments(raw);
  /** @type {string[]} */
  const parts = [];
  let skippedShort = 0;
  for (const seg of segs) {
    const chars = [...seg];
    if (chars.length < 3) {
      skippedShort += 1;
      continue;
    }
    parts.push(`"${seg.replaceAll('"', '""')}"`);
  }
  if (!parts.length) {
    return { ok: false, query: '', skippedShort, reason: skippedShort ? 'query_too_short' : 'no_tokens' };
  }
  // 段间同样统一写显式 `AND`（与 buildFtsMatch 口径一致）。
  // 这里 parts 全是纯 phrase、本来用空格也合法，但两处口径必须一致：
  // 哪天 trigram 路加了 OR 分支，混用空格就会重演 buildFtsMatch 那个 FTS5 语法错。
  return { ok: true, query: parts.join(' AND '), skippedShort };
}

/** LIKE 模式转义：用户输入里的 % 和 _ 是字面量，不能当通配符。 */
export function toLikePattern(raw) {
  return `%${normalizeForSearch(raw).replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export class SearchIndex {
  /**
   * @param {import('node:sqlite').DatabaseSync} db
   * @param {{
   *   prefix?: string,
   *   docSource?: { table: string, idColumn: string, textColumn: string },
   *   sourceRefs?: { table: string, memoryIdColumn: string, refColumn: string, hashColumn: string, typeColumn: string } | null,
   *   minCoverage?: number,
   *   likeSource?: 'index' | 'docSource',
   * }} [opts]
   */
  constructor(db, opts = {}) {
    this.db = db;
    this.prefix = opts.prefix ?? 'search';
    this.t = searchTableNames({ prefix: this.prefix });
    this.docSource = opts.docSource ?? { table: 'memories', idColumn: 'id', textColumn: 'content' };
    this.sourceRefs =
      opts.sourceRefs === null
        ? null
        : opts.sourceRefs ?? {
            table: 'source_refs',
            memoryIdColumn: 'memory_id',
            refColumn: 'source_ref',
            hashColumn: 'content_hash',
            typeColumn: 'source_type',
          };
    this.minCoverage = opts.minCoverage ?? 0.34;
    this.likeSource = opts.likeSource ?? 'index';
    /** @type {number | null} 缓存文档数，避免每次查询全表 count（见 docCount 注释） */
    this._docCount = null;
    this._likeEnabled = this.#tableExists(this.docSource.table);
  }

  /** @param {string} name */
  #tableExists(name) {
    const row = this.db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE (type='table' OR type='view') AND name = ?")
      .get(name);
    return Boolean(row);
  }

  /** 索引导入：所有表存在才认为可用。 */
  ready() {
    return Boolean(
      this.#tableExists(this.t.ftsChar) && this.#tableExists(this.t.ftsTrigram) && this.#tableExists(this.t.ngram),
    );
  }

  /**
   * 建索引（单条）。幂等：先删后插。
   * @param {{ id: string, content: string }} doc
   */
  indexDoc(doc) {
    const existed = this.#docHas(doc.id);
    // 首次导入时全库都没有旧文档，跳过 purge：FTS5 的 UNINDEXED 列过滤是全表扫，
    // 每篇都扫一遍会让批量导入退化成 O(n²)（实测 1 万条时跑不完）。
    if (existed) this.#purgeDoc(doc.id);
    this.db.prepare(`INSERT INTO ${this.t.ftsChar}(doc_id, body) VALUES (?, ?)`).run(doc.id, toSearchableText(doc.content));
    this.db.prepare(`INSERT INTO ${this.t.ftsTrigram}(doc_id, body) VALUES (?, ?)`).run(doc.id, String(doc.content));
    const ins = this.db.prepare(`INSERT INTO ${this.t.ngram}(term, doc_id, tf) VALUES (?, ?, ?)`);
    for (const [term, weight] of ngramTerms(doc.content)) ins.run(term, doc.id, weight);
    if (!existed && this._docCount !== null) this._docCount += 1;
  }

  /**
   * 批量建索引（单事务）。
   * @param {{ id: string, content: string }[]} docs
   */
  indexDocs(docs) {
    this.db.exec('BEGIN');
    try {
      for (const d of docs) this.indexDoc(d);
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* 回滚失败也把原始错误抛出去 */
      }
      this._docCount = null; // 事务失败后计数可能已脏，下次查询重算
      throw err;
    }
  }

  /**
   * 从三套索引里删除（契约 §8：目标与全部派生物不可检索）。
   * @param {string} id
   */
  removeDoc(id) {
    const existed = this.#docHas(id);
    if (!existed) return;
    this.#purgeDoc(id);
    if (this._docCount !== null) this._docCount -= 1;
  }

  /** @param {string} id */
  #docHas(id) {
    return Boolean(this.db.prepare(`SELECT 1 AS ok FROM ${this.t.ngram} WHERE doc_id = ? LIMIT 1`).get(id));
  }

  /** 只清索引，不动计数（计数由调用方处理）。 @param {string} id */
  #purgeDoc(id) {
    for (const sql of createSearchIndexDropStatements({ prefix: this.prefix })) {
      this.db.prepare(sql).run({ doc_id: id });
    }
  }

  /**
   * 索引内的文档数（作为 idf 的 N）。
   * 实测教训：早期版本每次查询都 `count(DISTINCT doc_id)`，1 万条文档时一次查询要扫
   * 100 万行 ngram 表，基准脚本直接跑不动。这里改成一次算好、增删时维护。
   */
  docCount() {
    if (this._docCount === null) {
      this._docCount = Number(this.db.prepare(`SELECT count(DISTINCT doc_id) AS c FROM ${this.t.ngram}`).get().c);
    }
    return this._docCount;
  }

  /** 外部直接改库后强制重算文档数。 */
  refreshDocCount() {
    this._docCount = null;
    return this.docCount();
  }

  /**
   * 主路：FTS5 unicode61 + char-space。中文单字/两字/词、中英混排、编号都靠它。
   * @param {unknown} raw
   * @param {{ limit?: number, mode?: 'phrase'|'and'|'or'|'adaptive' }} [opts]
   * @returns {{ route: string, items: Hit[], info: { query: string, ok: boolean, mode?: string, reason?: string } }}
   */
  searchFtsChar(raw, opts = {}) {
    const limit = opts.limit ?? 50;
    const q = buildFtsMatch(raw, { mode: opts.mode ?? 'adaptive' });
    if (!q.ok) return { route: 'fts_char', items: [], info: { query: '', ok: false, reason: q.reason } };
    const rows = this.db
      .prepare(
        `SELECT doc_id AS id, bm25(${this.t.ftsChar}) AS s FROM ${this.t.ftsChar} WHERE ${this.t.ftsChar} MATCH ? ORDER BY s LIMIT ?`,
      )
      .all(q.query, limit);
    return {
      route: 'fts_char',
      items: rows.map((r) => ({ id: String(r.id), score: -Number(r.s) })),
      info: { query: q.query, ok: true, mode: q.mode },
    };
  }

  /**
   * 补充路：FTS5 trigram + 原文。只对 >=3 字符的段有效；短查询静默 0 命中。
   * @param {unknown} raw
   * @param {{ limit?: number }} [opts]
   */
  searchTrigram(raw, opts = {}) {
    const limit = opts.limit ?? 50;
    const q = buildTrigramMatch(raw);
    if (!q.ok) return { route: 'fts_trigram', items: [], info: { query: '', ok: false, reason: q.reason, skippedShort: q.skippedShort } };
    const rows = this.db
      .prepare(
        `SELECT doc_id AS id, bm25(${this.t.ftsTrigram}) AS s FROM ${this.t.ftsTrigram} WHERE ${this.t.ftsTrigram} MATCH ? ORDER BY s LIMIT ?`,
      )
      .all(q.query, limit);
    return {
      route: 'fts_trigram',
      items: rows.map((r) => ({ id: String(r.id), score: -Number(r.s) })),
      info: { query: q.query, ok: true, skippedShort: q.skippedShort },
    };
  }

  /**
   * 兜底路：自维护 n-gram 倒排。不依赖 FTS5，按 idf 加权 + 覆盖率打分。
   * @param {unknown} raw
   * @param {{ limit?: number }} [opts]
   * @returns {{ route: string, items: Hit[], info: { terms: number, ok: boolean } }}
   */
  searchNgram(raw, opts = {}) {
    const limit = opts.limit ?? 50;
    const qterms = ngramTerms(raw);
    if (!qterms.size) return { route: 'ngram', items: [], info: { terms: 0, ok: false } };
    const terms = [...qterms.keys()];
    const placeholders = terms.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT term, doc_id, tf FROM ${this.t.ngram} WHERE term IN (${placeholders})`)
      .all(...terms);
    const N = this.docCount();
    /** @type {Map<string, number>} */
    const df = new Map();
    /** @type {Map<string, Map<string, number>>} */
    const perDoc = new Map();
    for (const r of rows) {
      const term = String(r.term);
      df.set(term, (df.get(term) ?? 0) + 1);
      const m = perDoc.get(String(r.doc_id)) ?? new Map();
      m.set(term, Number(r.tf));
      perDoc.set(String(r.doc_id), m);
    }
    const items = [];
    for (const [docId, docTerms] of perDoc) {
      let score = 0;
      let hitW = 0;
      let totalW = 0;
      for (const [term, w] of qterms) {
        totalW += w;
        const tf = docTerms.get(term);
        if (tf === undefined) continue;
        const idf = Math.log(1 + N / (1 + (df.get(term) ?? 1)));
        score += w * idf * (1 + Math.log(tf));
        hitW += w;
      }
      if (score > 0) items.push({ id: docId, score, coverage: totalW ? hitW / totalW : 0 });
    }
    items.sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1));
    return { route: 'ngram', items: items.slice(0, limit), info: { terms: qterms.size, ok: true } };
  }

  /**
   * 最后兜底：参数化 LIKE。
   * 默认查**本包自己的 trigram 索引副本**（那里存的原文，随 removeDoc 一起清），
   * 而不是 memories 原文表——早期版本查 memories 时，记忆被删、索引被清，但
   * LIKE 仍能从原文表捞出来已删内容，删除屏障直接漏（单测抓到过）。
   * 需要查外部原文表时把构造参数 likeSource 设为 'docSource'。
   * @param {unknown} raw
   * @param {{ limit?: number }} [opts]
   */
  searchLike(raw, opts = {}) {
    const limit = opts.limit ?? 50;
    const pattern = toLikePattern(raw);
    if (this.likeSource === 'docSource') {
      if (!this._likeEnabled) {
        return { route: 'like', items: [], info: { ok: false, reason: `docSource 表 ${this.docSource.table} 不存在` } };
      }
      const { table, idColumn, textColumn } = this.docSource;
      const rows = this.db
        .prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE ${textColumn} LIKE ? ESCAPE '\\' LIMIT ?`)
        .all(pattern, limit);
      return { route: 'like', items: rows.map((r) => ({ id: String(r.id), score: 1 })), info: { ok: true, pattern, source: 'docSource' } };
    }
    const rows = this.db
      .prepare(`SELECT doc_id AS id FROM ${this.t.ftsTrigram} WHERE body LIKE ? ESCAPE '\\' LIMIT ?`)
      .all(pattern, limit);
    return { route: 'like', items: rows.map((r) => ({ id: String(r.id), score: 1 })), info: { ok: true, pattern, source: 'index' } };
  }

  /**
   * 融合检索 + 四种「检索不足」区分。
   *
   * @param {unknown} raw
   * @param {{
   *   limit?: number,
   *   route?: 'fused'|'fts_char'|'fts_trigram'|'ngram'|'like',
   *   likeFallback?: boolean,
   *   checkSources?: boolean,
   *   minCoverage?: number,
   *   weights?: Record<string, number>,
   * }} [opts] weights 默认 { fts_char: 1, fts_trigram: 0.6, ngram: 0 }；ngram 只在排序结果为空时兜底。
   * @returns {{
   *   query: string,
   *   normalizedQuery: string,
   *   route: string,
   *   results: Hit[],
   *   diagnostics: {
   *     state: SearchState,
   *     reason: string,
   *     candidateCount: number,
   *     bestCoverage: number | null,
   *     routes: Record<string, { count: number, ok: boolean, reason?: string }>,
   *     sources?: { available: boolean, missing: string[], conflicts: string[] },
   *   },
   * }}
   */
  search(raw, opts = {}) {
    const limit = opts.limit ?? 10;
    const route = opts.route ?? 'fused';
    const likeFallback = opts.likeFallback ?? true;
    const checkSources = opts.checkSources ?? true;
    const minCoverage = opts.minCoverage ?? this.minCoverage;
    const qterms = ngramTerms(raw);

    /** @type {Record<string, { route: string, items: Hit[], info: any }>} */
    const lane = {};
    const run = (name, fn) => {
      lane[name] = fn();
    };

    if (route === 'fused' || route === 'fts_char') run('fts_char', () => this.searchFtsChar(raw, { limit: 50 }));
    if (route === 'fused' || route === 'fts_trigram') run('fts_trigram', () => this.searchTrigram(raw, { limit: 50 }));
    if (route === 'fused' || route === 'ngram') run('ngram', () => this.searchNgram(raw, { limit: 50 }));
    if (route === 'like') run('like', () => this.searchLike(raw, { limit: 50 }));

    /** @type {Hit[]} */
    let results;
    let usedFallback = /** @type {null|'ngram'|'like'} */ (null);
    if (route === 'fused') {
      const lists = Object.values(lane)
        .filter((l) => l.items.length)
        .map((l) => ({ route: l.route, items: l.items }));
      // 默认权重由实测确定（见报告 4.4）：ngram 参与排序会把 P@10 从 83.6% 拖到 49.9%，
      // 而召回没有增益，所以 ngram 只做「空结果兜底」与覆盖率诊断，不进正常排序。
      const weights = opts.weights ?? { fts_char: 1, fts_trigram: 0.6, ngram: 0 };
      results = rrfFuse(lists, { weights, limit });
      if (!results.length && lane.ngram?.items.length) {
        usedFallback = 'ngram';
        results = rrfFuse([{ route: 'ngram', items: lane.ngram.items }], { limit });
      }
      if (!results.length && likeFallback) {
        const like = this.searchLike(raw, { limit: 50 });
        lane.like = like;
        if (like.items.length) {
          usedFallback = 'like';
          results = rrfFuse([{ route: 'like', items: like.items }], { limit });
        }
      }
    } else {
      results = (lane[route]?.items ?? []).slice(0, limit).map((i) => ({ ...i }));
    }

    // 覆盖度：对 top 候选按查询 n-gram 比对，判断「证据够不够」
    const top = results.slice(0, Math.min(3, results.length));
    const coverages = top.map((r) => this.#docCoverage(r.id, qterms));
    const bestCoverage = coverages.length ? Math.max(...coverages) : null;

    // 来源回查：只对最终候选做，避免无界查询
    const sourceDiag = checkSources ? this.sourceBackRefs(results.map((r) => r.id)) : undefined;

    let state = /** @type {SearchState} */ ('ok');
    let reason = 'ok';
    if (!results.length) {
      state = 'no_relevant';
      reason = '三路索引与 LIKE 兜底都没有候选';
    } else if (sourceDiag?.conflicts?.length) {
      state = 'source_conflict';
      reason = `候选来源互相冲突：${sourceDiag.conflicts.slice(0, 3).join('; ')}`;
    } else if (sourceDiag?.missing?.length) {
      state = 'source_missing';
      reason = `候选来源丢失：${sourceDiag.missing.slice(0, 3).join('; ')}`;
    } else if (bestCoverage !== null && bestCoverage < minCoverage) {
      state = 'insufficient_evidence';
      reason = `最佳候选覆盖度 ${bestCoverage.toFixed(2)} < 阈值 ${minCoverage}，不当作确定答案`;
    }

    return {
      query: String(raw),
      normalizedQuery: normalizeForSearch(raw),
      route: usedFallback ?? route,
      results,
      diagnostics: {
        state,
        reason,
        candidateCount: results.length,
        bestCoverage,
        routes: Object.fromEntries(
          Object.entries(lane).map(([k, v]) => [k, { count: v.items.length, ok: v.info?.ok ?? true, ...(v.info?.reason ? { reason: v.info.reason } : {}) }]),
        ),
        sources: sourceDiag,
      },
    };
  }

  /**
   * 单文档覆盖度：查询的 n-gram 权重在该文档命中的比例。
   * @param {string} docId
   * @param {Map<string, number>} qterms
   */
  #docCoverage(docId, qterms) {
    if (!qterms.size) return 0;
    const rows = this.db.prepare(`SELECT term FROM ${this.t.ngram} WHERE doc_id = ?`).all(docId);
    const docTerms = new Set(rows.map((r) => String(r.term)));
    return coverageOf(qterms, docTerms);
  }

  /**
   * 按来源回查：候选记忆的来源引用是否存在、是否冲突。
   *
   * 契约 §7 要求「检索不足必须能区分来源丢失 / 来源冲突」，所以这里给出结构化结果，
   * 而不是让上层猜。`source_refs` 表由 memory 建；若表不存在或列名不同，
   * 通过构造参数覆盖，`available=false` 表示无法判断（上层不得当成「没问题」）。
   *
   * @param {string[]} ids
   * @returns {{ available: boolean, missing: string[], conflicts: string[], refs: Record<string, any[]> }}
   */
  sourceBackRefs(ids) {
    /** @type {{ available: boolean, missing: string[], conflicts: string[], refs: Record<string, any[]> }} */
    const out = { available: false, missing: [], conflicts: [], refs: {} };
    if (!ids.length || !this.sourceRefs) return out;
    const cfg = this.sourceRefs;
    if (!this.#tableExists(cfg.table)) return out;

    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT ${cfg.memoryIdColumn} AS mid, ${cfg.refColumn} AS ref, ${cfg.hashColumn} AS hash, ${cfg.typeColumn} AS stype
         FROM ${cfg.table} WHERE ${cfg.memoryIdColumn} IN (${placeholders})`,
      )
      .all(...ids);
    out.available = true;

    /** @type {Map<string, { ref: string, hash: string, stype: string }[]>} */
    const byId = new Map();
    /** @type {Map<string, Set<string>>} ref -> memory_ids */
    const byRef = new Map();
    for (const r of rows) {
      const mid = String(r.mid);
      const item = { ref: r.ref == null ? '' : String(r.ref), hash: r.hash == null ? '' : String(r.hash), stype: r.stype == null ? '' : String(r.stype) };
      const arr = byId.get(mid) ?? [];
      arr.push(item);
      byId.set(mid, arr);
      if (item.ref) {
        const s = byRef.get(item.ref) ?? new Set();
        s.add(mid);
        byRef.set(item.ref, s);
      }
    }

    for (const id of ids) {
      const refs = byId.get(id) ?? [];
      if (!refs.length) {
        // 有候选但查不到任何来源引用 → 来源丢失（不能当成没问题）
        out.missing.push(`${id}: 无 source_refs 记录`);
        out.refs[id] = [];
        continue;
      }
      out.refs[id] = refs;
      const hashes = new Set(refs.map((r) => r.hash).filter(Boolean));
      if (hashes.size > 1) out.conflicts.push(`${id}: 同一记忆有 ${hashes.size} 个不同来源内容指纹`);
    }
    for (const [ref, set] of byRef) {
      if (set.size > 1) out.conflicts.push(`来源 ${ref} 同时挂到 ${set.size} 条记忆`);
    }
    return out;
  }
}

/**
 * 便捷构造。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {ConstructorParameters<typeof SearchIndex>[1]} [opts]
 */
export function createSearchIndex(db, opts) {
  return new SearchIndex(db, opts);
}

export { rrfFuse } from './rrf.mjs';
export { createSearchSchemaStatements, createSearchIndexDropStatements, searchTableNames } from './schema.mjs';
export {
  buildFtsMatch,
  coverageOf,
  ngramTerms,
  normalizeForSearch,
  querySegments,
  segmentTokens,
  toSearchableText,
} from './tokenize.mjs';
