// @ts-check
/**
 * 实验 3：规模与耗时实测。
 *
 * 回答报告里必须写清的两件事：
 *   1. 三套索引各要多少存储放大（ngram 倒排行数 / 文档数）；
 *   2. 参数化 LIKE 全表扫在 1k / 5k / 10k 条时单次查询要多久，能不能当兜底。
 *
 * 用临时文件库（不是 :memory:），因为要读真实文件大小；文件建在系统临时目录，
 * 跑完删除，不碰项目 data/ 也不碰任何生产数据。
 *
 * 运行：cd E:\ds-h\dsh-brain && node packages/search/experiments/bench-scale.mjs
 * 产物：experiments/results/bench.json、experiments/results/bench-tables.md
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DOCS, QUERIES } from './corpus.mjs';
import { SearchIndex, createSearchSchemaStatements } from '../src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');
const SIZES = [1000, 5000, 10000];
const ITERS = 3;

/** 把 55 条真实口味语料循环放大成 N 条合成文档（加序号，避免完全重复）。 */
function expandDocs(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const base = DOCS[i % DOCS.length];
    out.push({ id: `${base.id}-x${i}`, content: `${base.content}#${i}` });
  }
  return out;
}

function buildDb(n, file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
  db.exec(
    'CREATE TABLE source_refs (memory_id TEXT NOT NULL, source_type TEXT NOT NULL, source_ref TEXT NOT NULL, content_hash TEXT NOT NULL)',
  );
  for (const s of createSearchSchemaStatements()) db.exec(s.sql);
  const docs = expandDocs(n);
  const ins = db.prepare('INSERT INTO memories(id, content) VALUES (?, ?)');
  db.exec('BEGIN');
  for (const d of docs) ins.run(d.id, d.content);
  db.exec('COMMIT');
  return { db, docs };
}

function avgLatency(fn, queries, iters = ITERS) {
  for (const q of queries) fn(q); // 预热，排除首次编译/缓存影响
  const t0 = performance.now();
  let n = 0;
  for (let k = 0; k < iters; k += 1) {
    for (const q of queries) {
      fn(q);
      n += 1;
    }
  }
  return (performance.now() - t0) / n;
}

function dbSizeBytes(db) {
  const pageCount = db.prepare('PRAGMA page_count').get().page_count;
  const pageSize = db.prepare('PRAGMA page_size').get().page_size;
  return Number(pageCount) * Number(pageSize);
}

function runOne(n) {
  const file = join(tmpdir(), `dsh-brain-bench-${n}-${process.pid}.db`);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(file + suffix, { force: true });
    } catch {
      /* 清理失败不影响测量 */
    }
  }
  const { db, docs } = buildDb(n, file);
  const idx = new SearchIndex(db);

  const t0 = performance.now();
  idx.indexDocs(docs);
  const indexMs = performance.now() - t0;

  const queries = QUERIES.map((q) => q.q);
  const lat = {
    fts_char: avgLatency((q) => idx.searchFtsChar(q, { limit: 10, mode: 'adaptive' }), queries),
    fts_trigram: avgLatency((q) => idx.searchTrigram(q, { limit: 10 }), queries),
    ngram: avgLatency((q) => idx.searchNgram(q, { limit: 10 }), queries),
    like: avgLatency((q) => idx.searchLike(q, { limit: 10 }), queries),
  };

  const rows = {
    n,
    index_ms: Math.round(indexMs),
    ms_per_doc: +(indexMs / n).toFixed(3),
    db_bytes: dbSizeBytes(db),
    file_bytes: statSync(file).size,
    ngram_rows: Number(db.prepare('SELECT count(*) AS c FROM search_ngram').get().c),
    latency_ms: Object.fromEntries(Object.entries(lat).map(([k, v]) => [k, +v.toFixed(3)])),
  };
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      rmSync(file + suffix, { force: true });
    } catch {
      /* 临时文件清理失败无所谓 */
    }
  }
  return rows;
}

function main() {
  mkdirSync(RESULTS, { recursive: true });
  const out = { generated_at: new Date().toISOString(), iters: ITERS, sizes: SIZES, rows: [] };
  for (const n of SIZES) {
    process.stderr.write(`bench ${n} ...\n`);
    out.rows.push(runOne(n));
  }
  writeFileSync(join(RESULTS, 'bench.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

  const L = [];
  L.push('## 索引规模与查询耗时（合成放大语料，Windows 本机 node:sqlite）');
  L.push('');
  L.push('| 文档数 | 建三套索引 | 每篇耗时 | 库文件 | ngram 行数 | 存储放大 | FTS char | FTS trigram | ngram | LIKE 全扫 |');
  L.push('|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of out.rows) {
    const amp = (r.ngram_rows / r.n).toFixed(1);
    L.push(
      `| ${r.n} | ${r.index_ms} ms | ${r.ms_per_doc} ms | ${(r.db_bytes / 1024 / 1024).toFixed(2)} MB | ${r.ngram_rows} | ${amp}× | ${r.latency_ms.fts_char} ms | ${r.latency_ms.fts_trigram} ms | ${r.latency_ms.ngram} ms | ${r.latency_ms.like} ms |`,
    );
  }
  L.push('');
  L.push('> 单次查询是 54 个查询重复 3 轮的平均值，已预热。LIKE 一列是全表扫。');
  const md = L.join('\n') + '\n';
  writeFileSync(join(RESULTS, 'bench-tables.md'), md, 'utf8');
  console.log(md);
  console.log(`原始数据: ${join(RESULTS, 'bench.json')}`);
}

main();
