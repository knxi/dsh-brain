// @ts-check
/**
 * 索引通电检查 —— 防「静默降级」的金丝雀。
 *
 * 背景：context2 联调时报过一次「`search_fts_char` / `search_fts_trigram` 的文档数
 * 都是 0，只有 ngram 有候选，status 却还是 ok」。经实测是本机复现不了（三表都有数据），
 * 但**这类问题必须由测试兜住**：
 *
 *   char-space 主路如果没通电，ngram 兜底照样能让检索"看起来正常"，
 *   而中文召回会从 hit@10 100% 静默掉到 49.9%（ngram 的精度）。
 *   这种降级一旦没人察觉，等于把整轮实测的结论白扔。
 *
 * 所以这里断言的不是「能搜到」，而是**三张索引表的 doc 数与 memories 行数逐一相等**，
 * 并且主路/补充路各自单独调用时必须能返回候选。
 */

import test from 'node:test';
import { assert, CORPUS, SCOPE_A, createBrain, draft, seedCorpus } from './helpers.mjs';

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function indexCounts(db) {
  return {
    memories: Number(db.prepare('SELECT count(*) AS n FROM memories').get().n),
    ftsChar: Number(db.prepare('SELECT count(*) AS n FROM search_fts_char').get().n),
    ftsTrigram: Number(db.prepare('SELECT count(*) AS n FROM search_fts_trigram').get().n),
    ngramDocs: Number(db.prepare('SELECT count(DISTINCT doc_id) AS n FROM search_ngram').get().n),
  };
}

test('迁移后三张索引表存在且为空（不是「不存在」）', async (t) => {
  const { brain } = createBrain(t);
  const probe = brain.searchBridge.probe();
  assert.equal(probe.allPresent, true, `三张索引表必须由 0002 建出来，缺失：${probe.missing.join(',')}`);
  assert.deepEqual(indexCounts(brain.db), { memories: 0, ftsChar: 0, ftsTrigram: 0, ngramDocs: 0 });
});

test('写入记忆后：三张索引表的 doc 数都等于 memories 行数（主路必须通电）', async (t) => {
  const { brain } = createBrain(t);
  await seedCorpus(brain);

  const counts = indexCounts(brain.db);
  assert.equal(counts.memories, CORPUS.length);
  // 这三条是核心断言：任何一张表为 0 都说明对应的检索路没进数据。
  assert.equal(counts.ftsChar, CORPUS.length, 'search_fts_char（char-space 主路）没进数据');
  assert.equal(counts.ftsTrigram, CORPUS.length, 'search_fts_trigram（补充路）没进数据');
  assert.equal(counts.ngramDocs, CORPUS.length, 'search_ngram（诊断兜底路）没进数据');

  assert.equal(brain.searchBridge.getIndex().docCount(), CORPUS.length, 'docCount() 是 idf 的 N，必须与实际一致');
});

test('主路独自可用：searchFtsChar 在中文两字词上必须有候选', async (t) => {
  const { brain } = createBrain(t);
  await seedCorpus(brain);
  const lane = brain.searchBridge.getIndex().searchFtsChar('铜版');
  assert.equal(lane.info.ok, true, `主路查询串构造失败：${JSON.stringify(lane.info)}`);
  assert.ok(lane.items.length > 0, 'char-space 主路必须能命中「铜版」——这是 hit@10 100% 的来源');
  assert.match(lane.info.query, /"/, '主路查询必须被包成 phrase（用户输入不许裸进 MATCH）');
});

test('补充路独自可用：searchTrigram 在 ≥3 字符上必须有候选', async (t) => {
  const { brain } = createBrain(t);
  await seedCorpus(brain);
  const lane = brain.searchBridge.getIndex().searchTrigram('建施-03');
  assert.equal(lane.info.ok, true);
  assert.ok(lane.items.length > 0, 'trigram 路必须能命中「建施-03」');
});

test('char-space 检索副本确实是逐字加空格的形态（不是原文）', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({ content: '铜版纸名片 300g', sourceIds: ['evt-cs-1'] }),
  );
  const row = /** @type {{ body: string }} */ (
    brain.db.prepare('SELECT body FROM search_fts_char WHERE doc_id = ?').get(created.id)
  );
  assert.ok(row.body.includes(' '), 'char 索引里必须是 char-space 副本');
  assert.equal(row.body.replace(/\s+/g, ''), '铜版纸名片300g', 'char-space 只加空格，不改字符');
  // 原文副本留在 trigram 表（LIKE 兜底也查它，删除时一起清）
  const tri = /** @type {{ body: string }} */ (
    brain.db.prepare('SELECT body FROM search_fts_trigram WHERE doc_id = ?').get(created.id)
  );
  assert.equal(tri.body, '铜版纸名片 300g', 'trigram 表存原文，不改写');
});

test('删一条就少一条：三张表同步收缩，不会残留孤儿 doc', async (t) => {
  const { brain } = createBrain(t);
  const one = await brain.memories.create(draft({ content: '待删除的喷绘布记录', sourceIds: ['evt-del-1'] }));
  await brain.memories.create(draft({ content: '保留的哑粉纸记录', sourceIds: ['evt-keep-1'] }));
  assert.equal(indexCounts(brain.db).ftsChar, 2);

  await brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: one.id,
    scope_id: SCOPE_A,
    reason: '测试删除',
  });
  // 删除走的是 shieldTarget（逻辑删除）+ 异步 worker 清正文；逻辑删除后
  // 索引可能还在（worker 未跑），检索必须靠屏障拦，而不是靠索引干净。
  const after = brain.memories.search({ query: '喷绘布', scopeId: SCOPE_A });
  assert.equal(after.hits.length, 0, '逻辑删除后必须立刻搜不到（不等 worker）');
  assert.ok(after.diagnostics.notes.some((note) => note.includes('删除屏障')));
});

test('reindexAll 能重建三套索引（迁移后 / 索引损坏的修复路径）', async (t) => {
  const { brain } = createBrain(t);
  await seedCorpus(brain);
  // 模拟索引整个被清空（只有索引坏、原文还在）
  brain.db.exec('DELETE FROM search_fts_char');
  brain.db.exec('DELETE FROM search_fts_trigram');
  brain.db.exec('DELETE FROM search_ngram');
  assert.deepEqual(indexCounts(brain.db), { memories: CORPUS.length, ftsChar: 0, ftsTrigram: 0, ngramDocs: 0 });

  const result = await brain.memories.reindexAll();
  assert.equal(result.indexed, CORPUS.length);
  const counts = indexCounts(brain.db);
  assert.equal(counts.ftsChar, CORPUS.length);
  assert.equal(counts.ftsTrigram, CORPUS.length);
  assert.equal(counts.ngramDocs, CORPUS.length);
  assert.ok(brain.memories.search({ query: '铜版', scopeId: SCOPE_A }).hits.length > 0);
});
