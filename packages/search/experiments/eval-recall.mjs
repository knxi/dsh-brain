// @ts-check
/**
 * 实验 2：召回对比 + 四种「检索不足」状态验证。
 *
 * 对比六路：
 *   1. fts_unicode61_raw     —— 纯 FTS5 默认（原文入库 unicode61，用户输入转义 phrase）
 *   2. fts_unicode61_char    —— 主路：FTS5 unicode61 + char-space 检索文本
 *   3. fts_trigram           —— 补充路：FTS5 trigram + 原文
 *   4. ngram                 —— 兜底路：自维护 n-gram 倒排
 *   5. like                  —— 基线：参数化 LIKE 全表扫
 *   6. fused                 —— 主路 + trigram + ngram 的 RRF 融合（+ 空结果时 LIKE 兜底）
 *
 * 指标：hit@10（top10 含任一 gold）、recall@10、MRR。
 * 语料与查询见 experiments/corpus.mjs（合成，53 条 / 46 个查询 / 8 类）。
 *
 * 运行：cd E:\ds-h\dsh-brain && node packages/search/experiments/eval-recall.mjs
 * 产物：experiments/results/recall.json、experiments/results/recall-tables.md
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CATEGORIES, DOCS, QUERIES, validateCorpus } from './corpus.mjs';
import { SearchIndex, buildFtsMatch, createSearchSchemaStatements } from '../src/index.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');
const TOP_K = 10;

/** 建一个装满合成语料的 :memory: 库。 */
function buildDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode=WAL');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
  db.exec(
    'CREATE TABLE source_refs (memory_id TEXT NOT NULL, source_type TEXT NOT NULL, source_ref TEXT NOT NULL, content_hash TEXT NOT NULL)',
  );
  for (const s of createSearchSchemaStatements()) db.exec(s.sql);

  const insMem = db.prepare('INSERT INTO memories(id, content) VALUES (?, ?)');
  const insSrc = db.prepare('INSERT INTO source_refs(memory_id, source_type, source_ref, content_hash) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const d of DOCS) {
    insMem.run(d.id, d.content);
    insSrc.run(d.id, d.sourceType ?? 'owner_words', d.sourceRef ?? `ref-${d.id}`, d.sourceHash ?? `h-${d.id}`);
  }
  db.exec('COMMIT');

  // 纯 FTS5 默认基线：原文入库，不 char-space
  db.exec("CREATE VIRTUAL TABLE base_raw USING fts5(doc_id UNINDEXED, body, tokenize='unicode61')");
  const insRaw = db.prepare('INSERT INTO base_raw(doc_id, body) VALUES (?, ?)');
  db.exec('BEGIN');
  for (const d of DOCS) insRaw.run(d.id, d.content);
  db.exec('COMMIT');

  const idx = new SearchIndex(db);
  idx.indexDocs(DOCS.map((d) => ({ id: d.id, content: d.content })));
  return { db, idx };
}

/** 纯 FTS5 原样基线：用户输入整体当一个 phrase，转义后 MATCH。 */
function queryRawBaseline(db, raw) {
  const phrase = `"${String(raw).replaceAll('"', '""')}"`;
  try {
    const rows = db
      .prepare('SELECT doc_id AS id FROM base_raw WHERE base_raw MATCH ? ORDER BY bm25(base_raw) LIMIT 50')
      .all(phrase);
    return rows.map((r) => String(r.id));
  } catch {
    return [];
  }
}

/** @param {string[]} rankedIds @param {string[]} gold */
function scoreOne(rankedIds, gold) {
  const top = rankedIds.slice(0, TOP_K);
  const goldSet = new Set(gold);
  const firstHit = top.findIndex((id) => goldSet.has(id));
  const hits = top.filter((id) => goldSet.has(id)).length;
  return {
    hit: firstHit >= 0 ? 1 : 0,
    recall: gold.length ? hits / gold.length : 0,
    precision: top.length ? hits / top.length : 0,
    mrr: firstHit >= 0 ? 1 / (firstHit + 1) : 0,
    firstRank: firstHit >= 0 ? firstHit + 1 : null,
    returned: top.length,
  };
}

const ENGINES = [
  { key: 'fts_unicode61_raw', label: '纯 FTS5 unicode61（原文，默认分词）' },
  { key: 'fts_char_phrase', label: 'FTS5 unicode61 + char-space，强制 phrase' },
  { key: 'fts_char_and', label: 'FTS5 unicode61 + char-space，强制 AND' },
  { key: 'fts_char_or', label: 'FTS5 unicode61 + char-space，强制 OR' },
  { key: 'fts_char_adaptive', label: 'FTS5 unicode61 + char-space，自适应（≤4 phrase，>4 OR）' },
  { key: 'fts_trigram', label: 'FTS5 trigram（原文）' },
  { key: 'ngram', label: '自维护 n-gram 倒排' },
  { key: 'like', label: '参数化 LIKE 全表扫（基线）' },
  { key: 'fused', label: 'RRF 融合（char 自适应 + trigram + ngram）' },
];

/** 每路返回排好序的 doc id 列表。 */
function runEngine(engine, raw, idx, db) {
  switch (engine) {
    case 'fts_unicode61_raw':
      return queryRawBaseline(db, raw);
    case 'fts_char_phrase':
      return idx.searchFtsChar(raw, { limit: 50, mode: 'phrase' }).items.map((i) => i.id);
    case 'fts_char_and':
      return idx.searchFtsChar(raw, { limit: 50, mode: 'and' }).items.map((i) => i.id);
    case 'fts_char_or':
      return idx.searchFtsChar(raw, { limit: 50, mode: 'or' }).items.map((i) => i.id);
    case 'fts_char_adaptive':
      return idx.searchFtsChar(raw, { limit: 50, mode: 'adaptive' }).items.map((i) => i.id);
    case 'fts_trigram':
      return idx.searchTrigram(raw, { limit: 50 }).items.map((i) => i.id);
    case 'ngram':
      return idx.searchNgram(raw, { limit: 50 }).items.map((i) => i.id);
    case 'like':
      return idx.searchLike(raw, { limit: 50 }).items.map((i) => i.id);
    case 'fused':
      return idx.search(raw, { limit: TOP_K }).results.map((r) => r.id);
    default:
      throw new Error(`未知引擎 ${engine}`);
  }
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function main() {
  const problems = validateCorpus();
  if (problems.length) {
    console.error('语料自检失败：');
    for (const p of problems) console.error(' -', p);
    process.exitCode = 1;
    return;
  }

  mkdirSync(RESULTS, { recursive: true });
  const { db, idx } = buildDb();

  /** @type {Record<string, any[]>} */
  const perEngine = {};
  /** @type {any[]} */
  const detail = [];

  for (const engine of ENGINES) perEngine[engine.key] = [];
  for (const q of QUERIES) {
    for (const e of ENGINES) {
      const ranked = runEngine(e.key, q.q, idx, db);
      const s = scoreOne(ranked, q.gold);
      perEngine[e.key].push({ ...s, qid: q.id, category: q.category, top: ranked.slice(0, TOP_K) });
      detail.push({ qid: q.id, category: q.category, query: q.q, engine: e.key, ...s });
    }
  }

  /** 总体指标 */
  const overall = ENGINES.map((e) => {
    const rows = perEngine[e.key];
    return {
      engine: e.key,
      label: e.label,
      queries: rows.length,
      hitRate: mean(rows.map((r) => r.hit)),
      recall10: mean(rows.map((r) => r.recall)),
      precision10: mean(rows.map((r) => r.precision)),
      mrr: mean(rows.map((r) => r.mrr)),
      avgReturned: mean(rows.map((r) => r.returned)),
    };
  });

  /** 分类指标：hitRate */
  const byCategory = CATEGORIES.map((cat) => {
    const row = { category: cat, queries: QUERIES.filter((q) => q.category === cat).length };
    for (const e of ENGINES) {
      const rows = perEngine[e.key].filter((r) => r.category === cat);
      row[e.key] = mean(rows.map((r) => r.hit));
    }
    return row;
  });

  /** 失败明细（按引擎） */
  const misses = ENGINES.map((e) => ({
    engine: e.key,
    cases: detail.filter((d) => d.engine === e.key && d.hit === 0).map((d) => `${d.qid}(${d.category})「${d.query}」`),
  }));

  /** ---------------- 融合权重扫描：用数据定默认权重，而不是拍脑袋 ---------------- */
  const WEIGHT_SETS = [
    { name: 'char_only', weights: { fts_char: 1, fts_trigram: 0, ngram: 0 } },
    { name: 'char+trigram', weights: { fts_char: 1, fts_trigram: 0.6, ngram: 0 } },
    { name: 'char+trigram+ngram0.2', weights: { fts_char: 1, fts_trigram: 0.6, ngram: 0.2 } },
    { name: 'char+trigram+ngram0.4', weights: { fts_char: 1, fts_trigram: 0.6, ngram: 0.4 } },
    { name: 'char+trigram+ngram0.6', weights: { fts_char: 1, fts_trigram: 0.6, ngram: 0.6 } },
    { name: 'char+trigram+ngram1.0', weights: { fts_char: 1, fts_trigram: 0.6, ngram: 1.0 } },
  ];
  const weightSweep = WEIGHT_SETS.map((s) => {
    const rows = QUERIES.map((q) =>
      scoreOne(
        idx.search(q.q, { limit: TOP_K, weights: s.weights }).results.map((r) => r.id),
        q.gold,
      ),
    );
    return {
      name: s.name,
      weights: s.weights,
      hitRate: mean(rows.map((r) => r.hit)),
      recall10: mean(rows.map((r) => r.recall)),
      precision10: mean(rows.map((r) => r.precision)),
      mrr: mean(rows.map((r) => r.mrr)),
    };
  });

  /** ---------------- 四种「检索不足」状态验证（独立小库，完全可控） ---------------- */
  const scenarios = runStateScenarios();

  const out = {
    generated_at: new Date().toISOString(),
    top_k: TOP_K,
    corpus: { docs: DOCS.length, queries: QUERIES.length, categories: CATEGORIES },
    overall,
    byCategory,
    misses,
    weight_sweep: weightSweep,
    per_query: detail,
    state_scenarios: scenarios,
    config: {
      default_weights: { fts_char: 1, fts_trigram: 0.6, ngram: 0.2 },
      min_coverage: 0.34,
    },
  };

  writeFileSync(join(RESULTS, 'recall.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');

  // 供报告直接引用的 markdown 表格（数字与 JSON 同源，避免手抄）
  const md = renderMarkdown(out);
  writeFileSync(join(RESULTS, 'recall-tables.md'), md, 'utf8');

  console.log(md);
  console.log(`\n原始数据: ${join(RESULTS, 'recall.json')}`);

  db.close();
}

/** 四种状态的构造：每个场景用一个小库，输入与期望都固定。 */
function runStateScenarios() {
  const make = (docs, srcs) => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
    db.exec(
      'CREATE TABLE source_refs (memory_id TEXT NOT NULL, source_type TEXT NOT NULL, source_ref TEXT NOT NULL, content_hash TEXT NOT NULL)',
    );
    for (const s of createSearchSchemaStatements()) db.exec(s.sql);
    const insMem = db.prepare('INSERT INTO memories(id, content) VALUES (?, ?)');
    for (const d of docs) insMem.run(d.id, d.content);
    const insSrc = db.prepare('INSERT INTO source_refs(memory_id, source_type, source_ref, content_hash) VALUES (?, ?, ?, ?)');
    for (const s of srcs) insSrc.run(s.memory_id, s.source_type, s.source_ref, s.content_hash);
    const idx = new SearchIndex(db);
    idx.indexDocs(docs);
    return { db, idx };
  };

  const baseDocs = [
    { id: 's1', content: '铜版纸反光严重，室内展板建议换哑粉。' },
    { id: 's2', content: '报价单里的印刷费按 P 数算。' },
    { id: 's3', content: '脚手架立杆间距 1.2m，步距 1.8m。' },
  ];
  const fullSrcs = baseDocs.map((d, i) => ({
    memory_id: d.id,
    source_type: 'owner_words',
    source_ref: `evt-s${i + 1}`,
    content_hash: `hash-s${i + 1}`,
  }));

  const cases = [];

  // 1) 无相关记忆
  {
    const { db, idx } = make(baseDocs, fullSrcs);
    const r = idx.search('量子纠缠退相干', { limit: 10 });
    cases.push({ expected: 'no_relevant', actual: r.diagnostics.state, reason: r.diagnostics.reason, query: '量子纠缠退相干' });
    db.close();
  }

  // 2) 可能相关但证据不够：只有零散单字命中，覆盖度低于阈值
  {
    const { db, idx } = make(baseDocs, fullSrcs);
    const r = idx.search('铜版报价脚手架量子纠缠', { limit: 10, route: 'ngram', checkSources: false });
    cases.push({
      expected: 'insufficient_evidence',
      actual: r.diagnostics.state,
      reason: r.diagnostics.reason,
      best_coverage: r.diagnostics.bestCoverage,
      query: '铜版报价脚手架量子纠缠',
    });
    db.close();
  }

  // 3) 来源丢失：候选在索引里，但 source_refs 没有记录
  {
    const { db, idx } = make(baseDocs, fullSrcs.filter((s) => s.memory_id !== 's1'));
    const r = idx.search('铜版', { limit: 10 });
    cases.push({ expected: 'source_missing', actual: r.diagnostics.state, reason: r.diagnostics.reason, query: '铜版' });
    db.close();
  }

  // 4) 来源冲突：同一记忆挂了两条内容指纹不同的来源
  {
    const { db, idx } = make(baseDocs, [
      ...fullSrcs,
      { memory_id: 's2', source_type: 'web', source_ref: 'evt-s2', content_hash: 'hash-s2-different' },
    ]);
    const r = idx.search('报价', { limit: 10 });
    cases.push({ expected: 'source_conflict', actual: r.diagnostics.state, reason: r.diagnostics.reason, query: '报价' });
    db.close();
  }

  // 5) 正常命中：四类之外的「证据齐全」
  {
    const { db, idx } = make(baseDocs, fullSrcs);
    const r = idx.search('哑粉', { limit: 10 });
    cases.push({ expected: 'ok', actual: r.diagnostics.state, reason: r.diagnostics.reason, query: '哑粉' });
    db.close();
  }

  return cases;
}

function pct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function renderMarkdown(out) {
  const L = [];
  L.push(`## 召回对比（合成语料，${out.corpus.docs} 条文档 / ${out.corpus.queries} 个查询 / ${out.corpus.categories.length} 类）`);
  L.push('');
  L.push('| 引擎 | hit@10 | recall@10 | P@10 | MRR | 平均返回条数 |');
  L.push('|---|---:|---:|---:|---:|---:|');
  for (const r of out.overall) {
    L.push(
      `| ${r.engine} | ${pct(r.hitRate)} | ${pct(r.recall10)} | ${pct(r.precision10)} | ${r.mrr.toFixed(3)} | ${r.avgReturned.toFixed(1)} |`,
    );
  }
  L.push('');
  L.push('## 按查询类别的 hit@10');
  L.push('');
  L.push(`| 类别 | 查询数 | ${ENGINES.map((e) => e.key).join(' | ')} |`);
  L.push(`|---|---:|${ENGINES.map(() => '---:').join('|')}|`);
  for (const r of out.byCategory) {
    L.push(`| ${r.category} | ${r.queries} | ${ENGINES.map((e) => pct(r[e.key])).join(' | ')} |`);
  }
  L.push('');
  L.push('## 融合权重扫描（同一套语料，只改 RRF 权重）');
  L.push('');
  L.push('| 权重方案 | char | trigram | ngram | hit@10 | recall@10 | P@10 | MRR |');
  L.push('|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const r of out.weight_sweep) {
    L.push(
      `| ${r.name} | ${r.weights.fts_char} | ${r.weights.fts_trigram} | ${r.weights.ngram} | ${pct(r.hitRate)} | ${pct(r.recall10)} | ${pct(r.precision10)} | ${r.mrr.toFixed(3)} |`,
    );
  }
  L.push('');
  L.push('## 漏检明细（hit@10 = 0 的查询）');
  L.push('');
  for (const m of out.misses) {
    L.push(`- **${m.engine}**（${m.cases.length}）: ${m.cases.join('、') || '无'}`);
  }
  L.push('');
  L.push('## 四种「检索不足」状态验证（独立小库，构造明确）');
  L.push('');
  L.push('| 期望状态 | 实际状态 | 查询 | 判定理由 |');
  L.push('|---|---|---|---|');
  for (const c of out.state_scenarios) {
    const ok = c.expected === c.actual ? '✅' : '❌';
    L.push(`| ${c.expected} | ${ok} ${c.actual} | \`${c.query}\` | ${c.reason} |`);
  }
  return L.join('\n') + '\n';
}

main();
