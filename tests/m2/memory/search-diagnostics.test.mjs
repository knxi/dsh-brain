// @ts-check
/**
 * M2 门槛「检索不足不胡答」：`diagnostics.status` 必须能区分四种不足。
 *
 * 这四条不是靠相似度阈值凑出来的观感，而是**代码里显式判定**的分支：
 *   no_related           → 三路索引 + LIKE 兜底都没有候选
 *   insufficient_evidence → 有候选，但最佳候选对查询的覆盖度 < 阈值
 *   source_missing       → 候选在，但来源记录缺失 / 来源事件已删
 *   source_conflict      → 同一记忆挂了两条内容指纹不同的来源
 *   ok                   → 候选、来源、覆盖度都过线
 *
 * 为什么重要：上层（context2）拿到非 ok 必须如实降级弃答，不许拿相似结果硬凑
 * （CONTRACTS §7 / M2-INTERFACES §2）。
 */

import test from 'node:test';
import { assert, SCOPE_A, createBrain, draft, seedCorpus } from './helpers.mjs';

test('ok：候选齐全、来源完整、覆盖度达标', async (t) => {
  const { brain } = createBrain(t);
  await seedCorpus(brain);
  const result = brain.memories.search({ query: '哑粉', scopeId: SCOPE_A });
  assert.equal(result.diagnostics.status, 'ok');
  assert.ok(result.hits.length > 0);
  assert.ok(result.diagnostics.bestCoverage >= 0.34);
});

test('no_related：库里根本没有相关记忆（不许拿别的凑）', async (t) => {
  const { brain } = createBrain(t);
  await seedCorpus(brain);
  const result = brain.memories.search({ query: '量子纠缠退相干', scopeId: SCOPE_A });
  assert.equal(result.diagnostics.status, 'no_related');
  assert.equal(result.hits.length, 0);
  assert.ok(
    result.diagnostics.notes.some((note) => note.includes('没有候选')),
    `notes 应说明三路都没有候选，实际：${JSON.stringify(result.diagnostics.notes)}`,
  );
});

test('insufficient_evidence：有沾边候选但覆盖度不够，明说不确定', async (t) => {
  const { brain } = createBrain(t);
  // 库里只有「铜版纸名片报价」，查询却混进大量库里没有的词。
  await brain.memories.create(
    draft({ content: '铜版纸名片报价 0.45 元', summary: '名片报价', sourceIds: ['evt-lowcov-1'] }),
  );
  const result = brain.memories.search({
    query: '铜版纸名片报价脚手架塔吊混凝土钢筋模板抹灰验收',
    scopeId: SCOPE_A,
  });
  assert.ok(result.hits.length > 0, '至少要捞到沾边的那一条（否则这条测试测的是 no_related）');
  assert.equal(result.diagnostics.status, 'insufficient_evidence');
  assert.ok(result.diagnostics.bestCoverage < 0.34);
  assert.ok(
    result.diagnostics.notes.some((note) => note.includes('覆盖度')),
    `notes 应给出覆盖度与阈值，实际：${JSON.stringify(result.diagnostics.notes)}`,
  );
});

test('source_missing：候选在索引里，但一条来源都没有', async (t) => {
  const { brain } = createBrain(t);
  // 故意不传 sourceIds：没有 source_refs 行
  await brain.memories.create(
    draft({ content: '铜版纸名片 300g 报价 0.45 元', sourceIds: [] }),
  );
  const result = brain.memories.search({ query: '铜版纸名片', scopeId: SCOPE_A });
  assert.ok(result.hits.length > 0);
  assert.equal(result.diagnostics.status, 'source_missing');
  assert.ok(result.diagnostics.notes.some((note) => note.includes('来源')));
});

test('source_missing：来源事件已被删除，不能当成还有来源', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({ content: '哑粉纸画册封面 210×285mm', sourceIds: ['evt-will-vanish'] }),
  );
  // 模拟「来源事件已被删除屏障清掉」：把 source_refs 指向一个不存在的事件。
  // 外键会拦住这种写入，所以临时关掉（这是白盒构造已损坏状态，不是正常写入路径）。
  brain.db.exec('PRAGMA foreign_keys = OFF');
  try {
    brain.db.prepare("UPDATE source_refs SET event_id = 'evt_does_not_exist' WHERE memory_id = ?").run(created.id);
  } finally {
    brain.db.exec('PRAGMA foreign_keys = ON');
  }

  const result = brain.memories.search({ query: '哑粉纸画册', scopeId: SCOPE_A });
  assert.equal(result.diagnostics.status, 'source_missing');
  assert.ok(result.diagnostics.notes.some((note) => note.includes('来源事件')));
});

test('source_conflict：同一记忆挂了两条内容指纹不同的来源', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({ content: '脚手架租赁报价按天算', sourceIds: [] }),
  );
  await brain.sources.link(created.id, {
    sourceSystem: 'dsh',
    sourceEventId: 'evt-conflict-a',
    contentHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  });
  await brain.sources.link(created.id, {
    sourceSystem: 'dsh',
    sourceEventId: 'evt-conflict-b',
    contentHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  });

  const result = brain.memories.search({ query: '脚手架租赁报价', scopeId: SCOPE_A });
  assert.ok(result.hits.length > 0);
  assert.equal(result.diagnostics.status, 'source_conflict');
  assert.ok(result.diagnostics.notes.some((note) => note.includes('冲突')));
});

test('冲突优先于丢失：两种问题同时存在时报 source_conflict（更严重）', async (t) => {
  const { brain } = createBrain(t);
  const conflicted = await brain.memories.create(draft({ content: '梁的截面是 2400×600', sourceIds: [] }));
  await brain.sources.link(conflicted.id, {
    sourceEventId: 'evt-c1',
    contentHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
  });
  await brain.sources.link(conflicted.id, {
    sourceEventId: 'evt-c2',
    contentHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
  });
  // 另一条完全没来源，也会命中同一个查询
  await brain.memories.create(draft({ content: '梁的配筋说明缺失', sourceIds: [] }));

  const result = brain.memories.search({ query: '梁的', scopeId: SCOPE_A, minCoverage: 0.1 });
  assert.equal(result.diagnostics.status, 'source_conflict');
});

test('minCoverage 可调：同一查询放宽阈值就从「证据不够」变 ok', async (t) => {
  const { brain } = createBrain(t);
  await brain.memories.create(
    draft({ content: '铜版纸名片报价 0.45 元', summary: '名片报价', sourceIds: ['evt-x'] }),
  );
  const query = '铜版纸名片报价脚手架塔吊混凝土';
  const strict = brain.memories.search({ query, scopeId: SCOPE_A, minCoverage: 0.9 });
  assert.equal(strict.diagnostics.status, 'insufficient_evidence');
  const loose = brain.memories.search({ query, scopeId: SCOPE_A, minCoverage: 0.01 });
  assert.equal(loose.diagnostics.status, 'ok');
});
