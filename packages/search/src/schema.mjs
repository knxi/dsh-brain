// @ts-check
/**
 * 检索层用到的表结构（SQL 片段，不直接执行）。
 *
 * 边界：契约 §1 规定 `@dsh-brain/search` 只读 memory 提供的连接、不自己建表。
 * 因此这里只**导出** SQL 语句数组，由 `@dsh-brain/memory` 的迁移在
 * `migrations/` 里执行；检索层自身只做读写，不调 CREATE。
 * 实验脚本为了可复现，会显式调用 `createSearchSchemaStatements()` 在 :memory: 库上建表。
 *
 * 三套索引分工（全部由实测决定，见 docs/search-capability-report.md）：
 * - `search_fts_char`：unicode61 + char-space 检索文本 → 主力，中文单字/两字/词、
 *   中英混排、编号都能查（phrase 查询）。
 * - `search_fts_trigram`：trigram + 原文 → 长中文短语、英文标识符子串的补充召回；
 *   两字以下只有静默 0 命中，不能单独用。
 * - `search_ngram`：自维护倒排（单字 + bigram + ASCII token/3-gram）→
 *   不依赖 FTS5 的兜底与对照基准，可按覆盖度判断「证据不够」。
 */

/** @typedef {{ name: string, sql: string }} SchemaStatement */

/**
 * @param {{ prefix?: string }} [opts]
 * @returns {SchemaStatement[]}
 */
export function createSearchSchemaStatements(opts = {}) {
  const p = opts.prefix ?? 'search';
  const ftsChar = `${p}_fts_char`;
  const ftsTri = `${p}_fts_trigram`;
  const ngram = `${p}_ngram`;
  return [
    {
      name: 'fts_char',
      sql: `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsChar} USING fts5(
  doc_id UNINDEXED,
  body,
  tokenize = 'unicode61'
)`,
    },
    {
      name: 'fts_trigram',
      sql: `CREATE VIRTUAL TABLE IF NOT EXISTS ${ftsTri} USING fts5(
  doc_id UNINDEXED,
  body,
  tokenize = 'trigram'
)`,
    },
    {
      name: 'ngram',
      sql: `CREATE TABLE IF NOT EXISTS ${ngram} (
  term    TEXT    NOT NULL,
  doc_id  TEXT    NOT NULL,
  tf      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (term, doc_id)
) WITHOUT ROWID`,
    },
    {
      // 按 doc_id 查存在性/删除必须有这条索引。实测教训：不加时 1 万条文档的批量
      // 索引会退化成「每篇文档全表扫百万行」，基准脚本直接跑不完。
      name: 'ngram_doc_id_index',
      sql: `CREATE INDEX IF NOT EXISTS ${ngram}_doc_id ON ${ngram}(doc_id)`,
    },
  ];
}

/**
 * 表名约定（memory 迁移与 search 查询共用）。
 * @param {{ prefix?: string }} [opts]
 */
export function searchTableNames(opts = {}) {
  const p = opts.prefix ?? 'search';
  return {
    ftsChar: `${p}_fts_char`,
    ftsTrigram: `${p}_fts_trigram`,
    ngram: `${p}_ngram`,
  };
}

/**
 * 删除屏障：删除时三套索引必须一起清，且必须先于「返回 202」完成
 * （契约 §8：目标与全部派生物不可检索）。
 * @param {{ prefix?: string }} [opts]
 */
export function createSearchIndexDropStatements(opts = {}) {
  const t = searchTableNames(opts);
  return [
    `DELETE FROM ${t.ftsChar} WHERE doc_id = :doc_id`,
    `DELETE FROM ${t.ftsTrigram} WHERE doc_id = :doc_id`,
    `DELETE FROM ${t.ngram} WHERE doc_id = :doc_id`,
  ];
}
