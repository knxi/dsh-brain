// @ts-check
/**
 * memory → search 的桥接层。
 *
 * 边界（CONTRACTS §1）：
 * - `@dsh-brain/search` 只读本包给的连接，**不自己建表**；DDL 由
 *   `migrations/0002_m2_memory.sql` 执行，两边靠 `tests/m2/memory/search-schema-sync.test.mjs`
 *   逐表逐列对齐，不靠人眼维护。
 * - 检索本体的三路融合、phrase 转义、覆盖度计算全部复用 search 包，
 *   这里**不重写**任何检索算法，只负责：
 *   1) 按本包的 schema 配置好 `SearchIndex`；
 *   2) 探测三套索引表是否齐（缺表时给 `degraded: 'index_missing'` 而不是崩）；
 *   3) 把 search 的 route 名映射成本包对外契约的 `matchedBy` 取值。
 *
 * 一个实测过的坑（search 报告 §4.4）：LIKE 兜底如果查 `memories` 原文表，
 * 「删了索引、没删原文」时已删内容还能被捞出来。所以这里**固定**
 * `likeSource: 'index'`（只查 search 自己的原文副本，随 removeDoc 一起清）。
 * 设置项故意不对外开放，避免被顺手改成 docSource。
 */

import { createSearchIndex, createSearchSchemaStatements, searchTableNames } from '@dsh-brain/search';

/** 表名前缀。改这里要同步改 0002 迁移。 */
export const SEARCH_PREFIX = 'search';

/** 0002 迁移应当建出的三套索引（逐字来自 search 包导出）。 */
export function expectedSearchSchema() {
  return createSearchSchemaStatements({ prefix: SEARCH_PREFIX });
}

/** 三套索引的表名约定。 */
export function searchNames() {
  return searchTableNames({ prefix: SEARCH_PREFIX });
}

/** search 包的 route 名 → 对外契约的 matchedBy 取值（M2-INTERFACES §1.2）。 */
export const ROUTE_TO_MATCHED_BY = Object.freeze({
  fts_char: 'char',
  fts_trigram: 'trigram',
  ngram: 'ngram',
  like: 'like',
});

/**
 * @param {string[]} routes
 * @returns {('char'|'trigram'|'ngram'|'like')[]}
 */
export function toMatchedBy(routes) {
  /** @type {Set<'char'|'trigram'|'ngram'|'like'>} */
  const out = new Set();
  for (const route of routes ?? []) {
    const mapped = ROUTE_TO_MATCHED_BY[/** @type {keyof typeof ROUTE_TO_MATCHED_BY} */ (route)];
    if (mapped) out.add(mapped);
  }
  return [...out];
}

/** 默认权重：char 1 : trigram 0.6 : ngram 0（由实测确定，见 search 报告 §3.7）。 */
export const DEFAULT_SEARCH_WEIGHTS = Object.freeze({ fts_char: 1, fts_trigram: 0.6, ngram: 0 });

/**
 * @typedef {Object} SearchBridgeOptions
 * @property {import('node:sqlite').DatabaseSync} db
 */

/**
 * @param {SearchBridgeOptions} options
 */
export function createSearchBridge(options) {
  const db = options.db;
  const names = searchNames();

  /** @type {import('@dsh-brain/search').SearchIndex | null} */
  let index = null;

  /**
   * @param {string} name
   * @returns {boolean}
   */
  function tableExists(name) {
    const row = db
      .prepare("SELECT 1 AS ok FROM sqlite_master WHERE (type = 'table' OR type = 'view') AND name = ?")
      .get(name);
    return row !== undefined;
  }

  /**
   * 三套索引的表齐不齐。
   *
   * 故意分开报告而不是一个布尔：FTS 表在、ngram 表不在时，主路仍然可用，
   * 不该整条检索判死（反之亦然）。
   * @returns {{ ftsChar: boolean, ftsTrigram: boolean, ngram: boolean, missing: string[], allPresent: boolean, anyPresent: boolean }}
   */
  function probe() {
    const ftsChar = tableExists(names.ftsChar);
    const ftsTrigram = tableExists(names.ftsTrigram);
    const ngram = tableExists(names.ngram);
    /** @type {string[]} */
    const missing = [];
    if (!ftsChar) missing.push(names.ftsChar);
    if (!ftsTrigram) missing.push(names.ftsTrigram);
    if (!ngram) missing.push(names.ngram);
    return {
      ftsChar,
      ftsTrigram,
      ngram,
      missing,
      allPresent: missing.length === 0,
      anyPresent: ftsChar || ftsTrigram || ngram,
    };
  }

  /**
   * 取（懒构造的）检索索引。
   *
   * sourceRefs 配置按 0001 的 `source_refs` 真实列名给齐，保证别的调用方直接拿
   * 这个实例做 `sourceBackRefs()` 时不会因列名不符报错。但**记忆层的来源判定
   * 不走它**：它的「同一 ref 挂到多个记忆也算冲突」规则不适合 memory 的
   * 「一句话可以含有多个事实」场景，会用出误报。详见 memories.js 的
   * `#judgeSources`。
   */
  function getIndex() {
    if (index === null) {
      index = createSearchIndex(db, {
        prefix: SEARCH_PREFIX,
        docSource: { table: 'memories', idColumn: 'id', textColumn: 'content' },
        sourceRefs: {
          table: 'source_refs',
          memoryIdColumn: 'memory_id',
          refColumn: 'independent_source_key',
          hashColumn: 'content_hash',
          typeColumn: 'source_kind',
        },
        // 固定查本包索引副本：删除屏障才不漏（search 报告 §4.4 实测）。
        likeSource: 'index',
      });
    }
    return index;
  }

  /**
   * 幂等补建缺失的索引表。
   *
   * 正常路径是 0002 迁移建表；这个函数只给两种场景用：
   * 1) 测试里想单独验证 schema 对齐；
   * 2) 老库升级后做修复（openBrain **不**自动调用，避免绕开迁移纪律）。
   * @returns {{ created: string[], missing: string[] }}
   */
  function ensureSchema() {
    const before = probe();
    if (before.allPresent) return { created: [], missing: [] };
    /** @type {string[]} */
    const created = [];
    for (const stmt of expectedSearchSchema()) {
      db.exec(stmt.sql);
      created.push(stmt.name);
    }
    index = null; // 表结构变了，缓存的 docCount 与语句句柄都作废
    return { created, missing: before.missing };
  }

  /** 外部直接改过索引表后，让缓存的文档数失效。 */
  function invalidate() {
    index = null;
  }

  return { getIndex, probe, ensureSchema, invalidate, names };
}
