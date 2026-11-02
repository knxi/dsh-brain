// @ts-check
/** 检索层主流程测试：索引、四路查询、融合、删除屏障、四种「检索不足」区分。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { SearchIndex, createSearchSchemaStatements, rrfFuse } from '../../packages/search/src/index.mjs';

/**
 * @param {{ id: string, content: string }[]} docs
 * @param {{ memory_id: string, source_type: string, source_ref: string, content_hash: string }[]} srcs
 */
function makeDb(docs, srcs) {
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
}

const DOCS = [
  { id: 'm1', content: '名片报价：250g 铜版纸双面印，500 张报价 180 元。' },
  { id: 'm2', content: '建施-03 图里首层平面标高是 0.000，层高 3.6m。' },
  { id: 'm3', content: '用readSurface读取画布像素前要先等重绘完成。' },
  { id: 'm4', content: 'deletion_epoch 每次删除都要加一。' },
];
const SRCS = DOCS.map((d, i) => ({
  memory_id: d.id,
  source_type: 'owner_words',
  source_ref: `evt-${i + 1}`,
  content_hash: `hash-${i + 1}`,
}));

test('中文两字、单字、编号、中英粘连都能查到', () => {
  const { db, idx } = makeDb(DOCS, SRCS);
  const ids = (r) => r.results.map((x) => x.id);

  assert.ok(ids(idx.search('铜版')).includes('m1'), '两字中文应命中');
  assert.ok(ids(idx.search('铜')).includes('m1'), '单字中文应命中');
  assert.ok(ids(idx.search('报价')).includes('m1'), '两字中文应命中');
  assert.ok(ids(idx.search('建施-03')).includes('m2'), '带连字符的图号应命中');
  assert.ok(ids(idx.search('readSurface')).includes('m3'), '中英无空格粘连时应命中英文词');
  assert.ok(ids(idx.search('deletion_epoch')).includes('m4'), '下划线标识符应命中');
  assert.ok(ids(idx.search('3.6m')).includes('m2'), '带小数点的尺寸应命中');
  db.close();
});

test('trigram 短查询静默 0 命中不会把结果搞错（只当补充路）', () => {
  const { db, idx } = makeDb(DOCS, SRCS);
  const tri = idx.searchTrigram('铜版');
  assert.equal(tri.items.length, 0, 'trigram 对两字查询应静默空，不报错');
  assert.equal(tri.info.ok, false);
  assert.equal(tri.info.reason, 'query_too_short');
  const long = idx.searchTrigram('铜版纸双面印');
  assert.ok(long.items.length >= 1, 'trigram 对长中文短语应有命中');
  db.close();
});

test('删除后三套索引都查不到（删除屏障）', () => {
  const { db, idx } = makeDb(DOCS, SRCS);
  assert.ok(idx.search('铜版').results.length > 0);
  idx.removeDoc('m1');
  assert.equal(idx.search('铜版').results.length, 0, '删除后仍能检索到');
  assert.equal(idx.searchNgram('铜版').items.length, 0, 'ngram 索引没清干净');
  assert.equal(idx.searchTrigram('铜版纸双面印').items.length, 0, 'trigram 索引没清干净');
  assert.equal(idx.searchFtsChar('铜版').items.length, 0, 'char 索引没清干净');
  db.close();
});

test('重复索引同一 id 是幂等的，不产生重复结果', () => {
  const { db, idx } = makeDb(DOCS, SRCS);
  idx.indexDoc(DOCS[0]);
  const ids = idx.search('铜版').results.map((r) => r.id);
  assert.deepEqual(ids, [...new Set(ids)], '出现了重复文档');
  assert.equal(idx.docCount(), DOCS.length);
  db.close();
});

test('四种「检索不足」能区分开', () => {
  // 1) 无相关记忆
  {
    const { db, idx } = makeDb(DOCS, SRCS);
    assert.equal(idx.search('量子纠缠退相干').diagnostics.state, 'no_relevant');
    db.close();
  }
  // 2) 证据不够：只零星命中单字，覆盖率低于阈值
  {
    const { db, idx } = makeDb(DOCS, SRCS);
    const r = idx.search('铜版报价量子纠缠光合作用', { route: 'ngram', checkSources: false });
    assert.equal(r.diagnostics.state, 'insufficient_evidence');
    assert.ok(r.diagnostics.bestCoverage < 0.34);
    db.close();
  }
  // 3) 来源丢失
  {
    const { db, idx } = makeDb(DOCS, SRCS.filter((s) => s.memory_id !== 'm1'));
    const r = idx.search('铜版');
    assert.equal(r.diagnostics.state, 'source_missing');
    assert.ok(r.diagnostics.sources?.missing.some((m) => m.startsWith('m1')));
    db.close();
  }
  // 4) 来源冲突：同一记忆两个不同内容指纹
  {
    const { db, idx } = makeDb(DOCS, [...SRCS, { memory_id: 'm1', source_type: 'web', source_ref: 'evt-1', content_hash: 'hash-different' }]);
    const r = idx.search('铜版');
    assert.equal(r.diagnostics.state, 'source_conflict');
    assert.ok(r.diagnostics.sources?.conflicts.length > 0);
    db.close();
  }
  // 5) 证据齐全
  {
    const { db, idx } = makeDb(DOCS, SRCS);
    const r = idx.search('铜版');
    assert.equal(r.diagnostics.state, 'ok');
    assert.equal(r.diagnostics.sources?.available, true);
    db.close();
  }
});

test('source_refs 表不存在时 sourceBackRefs 明确报不可用，不假装没问题', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
  for (const s of createSearchSchemaStatements()) db.exec(s.sql);
  db.prepare('INSERT INTO memories VALUES (?, ?)').run('a', '铜版纸反光');
  const idx = new SearchIndex(db);
  idx.indexDocs([{ id: 'a', content: '铜版纸反光' }]);
  const r = idx.sourceBackRefs(['a']);
  assert.equal(r.available, false, 'source_refs 缺失时必须标 available=false');
  db.close();
});

test('ngram 权重为 0 时只用于兜底，不进正常排序', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
  db.exec('CREATE TABLE source_refs (memory_id TEXT, source_type TEXT, source_ref TEXT, content_hash TEXT)');
  for (const s of createSearchSchemaStatements()) db.exec(s.sql);
  const docs = [
    { id: 'a', content: '铜版纸反光严重' },
    { id: 'b', content: '铜和版这两个字分散出现' },
  ];
  const idx = new SearchIndex(db);
  idx.indexDocs(docs);
  const r = idx.search('铜版', { limit: 10 });
  // 主路 phrase 只应命中 a；b 只有单字散落，不该靠 ngram 混进来
  assert.deepEqual(r.results.map((x) => x.id), ['a']);
  db.close();
});

test('rrfFuse：权重 0 的路不参与，排名按 RRF 公式', () => {
  const fused = rrfFuse(
    [
      { route: 'a', items: [{ id: 'x', score: 10 }, { id: 'y', score: 5 }] },
      { route: 'b', items: [{ id: 'y', score: 99 }] },
    ],
    { k: 60, weights: { a: 1, b: 0 } },
  );
  assert.deepEqual(fused.map((f) => f.id), ['x', 'y']);
  assert.deepEqual(fused[0].matchedBy, ['a']);
});

test('字符级匹配：同音字不精确命中，且被标成证据不够而不是硬凑', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL)');
  db.exec('CREATE TABLE source_refs (memory_id TEXT, source_type TEXT, source_ref TEXT, content_hash TEXT)');
  for (const s of createSearchSchemaStatements()) db.exec(s.sql);
  db.prepare('INSERT INTO memories VALUES (?, ?)').run('p1', '铜版纸反光严重');
  db.prepare('INSERT INTO source_refs VALUES (?, ?, ?, ?)').run('p1', 'owner_words', 'evt-p1', 'h-p1');
  const idx = new SearchIndex(db);
  idx.indexDocs([{ id: 'p1', content: '铜版纸反光严重' }]);

  // 主路是精确 phrase：同音「铜板」不该精确命中「铜版」
  assert.equal(idx.searchFtsChar('铜板').items.length, 0);

  // 库里只有一条沾「铜」的弱相关记忆：应报 insufficient_evidence，不当作确定答案
  const r = idx.search('铜板');
  assert.equal(r.diagnostics.state, 'insufficient_evidence');
  assert.ok(r.diagnostics.bestCoverage < 0.34);
  db.close();
});

test('畸形/超长查询不抛异常', () => {
  const { db, idx } = makeDb(DOCS, SRCS);
  for (const raw of ['', '   ', '"""', '%%%%', '(((', 'a OR b', 'x*', '--', '建施-03 OR *', '啊'.repeat(500)]) {
    assert.doesNotThrow(() => idx.search(raw), `查询 ${JSON.stringify(raw)} 抛异常了`);
  }
  db.close();
});
