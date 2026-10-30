// @ts-check
/**
 * 迁移 DDL ↔ `@dsh-brain/search` 导出的 DDL 一致性。
 *
 * 契约 §1 规定：search 只**导出** SQL，由 memory 的迁移执行（search 自己不建表）。
 * 这就产生一个真实的漂移风险——0002 里内联的 DDL 与 `createSearchSchemaStatements()`
 * 各改一半，谁都不会报错，直到某天中文召回悄悄变差。
 *
 * 所以这里不靠人眼对：**用 search 包的 DDL 在一个内存库里建一套参照，然后逐表、
 * 逐列、逐索引、逐归一化 DDL 文本比较**。任何一侧漂移都会红。
 */

import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { assert, createBrain, MIGRATIONS_DIR } from './helpers.mjs';
import { loadMigrations } from '../../../packages/memory/src/migrator.js';
import {
  DEFAULT_SEARCH_WEIGHTS,
  expectedSearchSchema,
  searchNames,
} from '../../../packages/memory/src/search-bridge.js';

/** @param {string} sql */
function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 */
function columnsOf(db, table) {
  return /** @type {Array<{ name: string, type: string, notnull: number, pk: number }>} */ (
    db.prepare(`PRAGMA table_info(${table})`).all()
  ).map((row) => ({ name: String(row.name), type: String(row.type), notnull: Number(row.notnull), pk: Number(row.pk) }));
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 */
function ddlOf(db, name) {
  const row = /** @type {{ sql?: string } | undefined} */ (
    db.prepare("SELECT sql FROM sqlite_master WHERE name = ? AND type IN ('table', 'index')").get(name)
  );
  return row?.sql === undefined ? null : normalizeSql(row.sql);
}

test('默认权重是实测定下的 char 1 : trigram 0.6 : ngram 0', () => {
  assert.deepEqual({ ...DEFAULT_SEARCH_WEIGHTS }, { fts_char: 1, fts_trigram: 0.6, ngram: 0 });
});

test('0002 建出的三套索引表名与 search 导出的表名一致', async (t) => {
  const { brain } = createBrain(t);
  const names = searchNames();
  assert.equal(names.ftsChar, 'search_fts_char');
  assert.equal(names.ftsTrigram, 'search_fts_trigram');
  assert.equal(names.ngram, 'search_ngram');

  const expected = expectedSearchSchema().map((statement) => statement.name);
  assert.deepEqual(expected, ['fts_char', 'fts_trigram', 'ngram', 'ngram_doc_id_index']);

  for (const table of [names.ftsChar, names.ftsTrigram, names.ngram]) {
    assert.ok(
      brain.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      `0002 必须建出 ${table}`,
    );
  }
  // 性能坑：ngram 表没有 doc_id 索引时，按文档查存在性/删除会全表扫（实测 1 万条跑不完）
  assert.ok(
    brain.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(`${names.ngram}_doc_id`),
    'search_ngram 必须有 doc_id 索引',
  );
});

test('0002 内联 DDL 与 search 导出的 DDL 逐字一致（归一化空白后）', async (t) => {
  const { brain } = createBrain(t);
  const reference = new DatabaseSync(':memory:');
  try {
    for (const statement of expectedSearchSchema()) reference.exec(statement.sql);

    // 表 + 索引的 DDL 都要比
    const artifacts = [
      searchNames().ftsChar,
      searchNames().ftsTrigram,
      searchNames().ngram,
      `${searchNames().ngram}_doc_id`,
    ];
    for (const name of artifacts) {
      const fromMigration = ddlOf(brain.db, name);
      const fromSearch = ddlOf(reference, name);
      assert.ok(fromMigration !== null, `迁移没有建出 ${name}`);
      assert.equal(
        fromMigration,
        fromSearch,
        `${name} 的 DDL 在 migrations/0002_m2_memory.sql 与 packages/search/src/schema.mjs 之间漂移了`,
      );
    }
  } finally {
    reference.close();
  }
});

test('三套索引的列结构（名称/类型/非空/主键）与 search 导出的完全一致', async (t) => {
  const { brain } = createBrain(t);
  const reference = new DatabaseSync(':memory:');
  try {
    for (const statement of expectedSearchSchema()) reference.exec(statement.sql);
    for (const table of Object.values(searchNames())) {
      assert.deepEqual(
        columnsOf(brain.db, table),
        columnsOf(reference, table),
        `${table} 的列结构与 search 包导出的不一致`,
      );
    }
  } finally {
    reference.close();
  }
});

test('search 包里 trigram 表存原文、char 表存 char-space 副本（两套文本分工没被合并）', async (t) => {
  const { brain } = createBrain(t);
  await brain.memories.create({
    scopeId: 'owner-default',
    layer: 'long',
    type: 'semantic',
    content: '喷绘精度 1440dpi，幅宽 1.2m',
    sourceType: 'owner_words',
    sourceIds: ['evt-two-text'],
    originSystem: 'dsh',
    producer: 'test',
  });
  const charRow = brain.db.prepare('SELECT body FROM search_fts_char LIMIT 1').get();
  const trigramRow = brain.db.prepare('SELECT body FROM search_fts_trigram LIMIT 1').get();
  assert.notEqual(charRow.body, trigramRow.body, '两套文本必须真的不同（否则等于只有一套）');
  assert.match(String(charRow.body), /1\.2|1 \. 2|1\. 2/, 'char 表里数字/字母要被切开');
  assert.equal(String(trigramRow.body), '喷绘精度 1440dpi，幅宽 1.2m', 'trigram 表存原文');
});

test('0002 的新增列都在（记忆防循环 + 快照扩展 + 摘要 layer）', async (t) => {
  const { brain } = createBrain(t);
  const memoryCols = columnsOf(brain.db, 'memories').map((column) => column.name);
  for (const column of ['origin_system', 'producer', 'derived_from', 'causation_id']) {
    assert.ok(memoryCols.includes(column), `memories 缺少 0002 新增列 ${column}`);
  }
  const snapshotCols = columnsOf(brain.db, 'task_snapshots').map((column) => column.name);
  for (const column of ['goal', 'done_steps', 'pending_steps']) {
    assert.ok(snapshotCols.includes(column), `task_snapshots 缺少 0002 新增列 ${column}`);
  }
  const summaryCols = columnsOf(brain.db, 'summaries').map((column) => column.name);
  assert.ok(summaryCols.includes('layer'), 'summaries 缺少 0002 新增列 layer');
});

test('schemaVersion 与磁盘上的迁移一致，且记录里全是 direction=up', async (t) => {
  const { brain } = createBrain(t);
  // 版本号不写死：断言的是「库里的版本 == 磁盘上最后一版」这个真契约（同 contract 的口径）。
  const expected = loadMigrations(MIGRATIONS_DIR).map((file) => file.version);
  assert.equal(brain.schemaVersion, expected[expected.length - 1]);
  const rows = /** @type {Array<{ version: string, direction: string }>} */ (
    brain.db.prepare('SELECT version, direction FROM schema_migrations ORDER BY version').all()
  );
  assert.deepEqual(rows.map((row) => row.version), expected);
  assert.ok(rows.every((row) => row.direction === 'up'));
});
