// @ts-check
/**
 * 系统 3 · `salience` 显著性标记器（杏仁核）。
 *
 * 每条测试名就是一句验收需求：
 *  1. markMemory：写入并读回（signals/valence/arousal 全保真）       → test 1
 *  2. 同一条记忆重复标记：覆盖且 version+1                           → test 2
 *  3. **显著性不得改 memories**（source_type / importance / 正文都不动）→ test 3
 *  4. listBySalience：按显著性降序，已删除记忆不出现                  → test 4
 *  5. 跨 scope：标记/读取/列表都不串                                  → test 5
 *  6. 不存在的记忆 / 已删除记忆：拒（不造孤儿行）                     → test 6
 *  7. computeSalienceFromSignals：权重手算值                          → test 7
 *  8. salienceBoost：0..1 映射到 0..0.15（不许盖过相关性）            → test 8
 *  9. 校验：非数拒、越界夹取、signals 必须数组                        → test 9
 * 10. 空库不炸 + stats                                              → test 10
 */

import test from 'node:test';
import {
  computeSalienceFromSignals,
  createSalience,
  MAX_SALIENCE_BOOST,
  salienceBoost,
  SALIENCE_WEIGHTS,
} from '../../packages/cognition/src/salience.js';
import { assert, countRows, createBrain, DEFAULT_SCOPE_ID, OTHER_SCOPE_ID } from './helpers.mjs';

/** 造一条记忆（走真实门面）。 */
async function remember(brain, draft = {}) {
  return brain.memories.create({
    scopeId: DEFAULT_SCOPE_ID,
    personId: 'owner',
    layer: 'long',
    type: 'semantic',
    content: '测试用记忆：铜版纸名片 300g / 90×54mm',
    sourceType: 'owner_words',
    originSystem: 'dsh',
    producer: 'test',
    confidence: 0.9,
    importance: 0.7,
    ...draft,
  });
}

test('markMemory：写入并读回（signals / valence / arousal 全保真）', async (t) => {
  const { brain, cognition } = createBrain(t);
  const memory = await remember(brain, { content: '名片报价 0.45 元一张' });

  const marked = await cognition.salience.markMemory({
    memoryId: memory.id,
    salience: 0.72,
    valence: -0.4,
    arousal: 0.6,
    signals: [`memory:${memory.id}`, 'owner_reaction:强调'],
    markedBy: 'amygdala',
  });
  assert.equal(marked.created, true);
  assert.equal(marked.version, 1);
  assert.equal(marked.salience, 0.72);

  const read = cognition.salience.getSalience(memory.id);
  assert.equal(read.salience, 0.72);
  assert.equal(read.valence, -0.4);
  assert.equal(read.arousal, 0.6);
  assert.deepEqual(read.signals, [`memory:${memory.id}`, 'owner_reaction:强调']);
  assert.equal(read.markedBy, 'amygdala');

  // 没标过的记忆 → null（「没评估」不等于「不重要」）
  const other = await remember(brain, { content: '另一条普通记录' });
  assert.equal(cognition.salience.getSalience(other.id), null);
});

test('同一条记忆重复标记：覆盖且 version+1', async (t) => {
  const { brain, cognition } = createBrain(t);
  const memory = await remember(brain);
  await cognition.salience.markMemory({ memoryId: memory.id, salience: 0.3 });
  const second = await cognition.salience.markMemory({ memoryId: memory.id, salience: 0.9, markedBy: 'owner_reinforce' });
  assert.equal(second.created, false);
  assert.equal(second.version, 2);
  const read = cognition.salience.getSalience(memory.id);
  assert.equal(read.salience, 0.9, '同 memory_id 覆盖，不新增行');
  assert.equal(read.version, 2);
  assert.equal(read.markedBy, 'owner_reinforce');
  assert.equal(countRows(brain.db, 'memory_salience'), 1);
});

test('纪律：显著性只影响权重，绝不改 memories 的 source_type / importance / 正文', async (t) => {
  const { brain, cognition } = createBrain(t);
  const memory = await remember(brain, { content: '听君一席话', importance: 0.2 });
  const before = brain.db.prepare('SELECT * FROM memories WHERE id = ?').get(memory.id);
  const versionsBefore = countRows(brain.db, 'memory_versions');

  // 打一个极高的显著性：如果模块错误地用它改 importance/source_type，这里就会露馅
  await cognition.salience.markMemory({ memoryId: memory.id, salience: 1, valence: 1, arousal: 1 });

  const after = brain.db.prepare('SELECT * FROM memories WHERE id = ?').get(memory.id);
  assert.deepEqual(after, before, 'memories 的每一列都必须原样（显著性不是证据，不能升格事实）');
  assert.equal(String(after.source_type), 'owner_words');
  assert.equal(Number(after.importance), 0.2, 'importance 是主人的权重判断，标记器不许动');
  assert.equal(String(after.content), '听君一席话');
  assert.equal(countRows(brain.db, 'memory_versions'), versionsBefore, '也不许写版本链');
});

test('listBySalience：按显著性降序，已删除记忆不出现', async (t) => {
  const { brain, cognition } = createBrain(t);
  const low = await remember(brain, { content: '低显著' });
  const high = await remember(brain, { content: '高显著' });
  const deleted = await remember(brain, { content: '会被删掉' });
  await cognition.salience.markMemory({ memoryId: low.id, salience: 0.2 });
  await cognition.salience.markMemory({ memoryId: high.id, salience: 0.95 });
  await cognition.salience.markMemory({ memoryId: deleted.id, salience: 0.5 });

  let listed = cognition.salience.listBySalience();
  assert.deepEqual(
    listed.items.map((item) => item.memoryId),
    [high.id, deleted.id, low.id],
    '必须按显著性降序（0.95 → 0.5 → 0.2）',
  );

  // 软删除后，显著性行还在，但列表不该再出现（查询侧负责过滤 status）
  brain.db.prepare("UPDATE memories SET status = 'deleted' WHERE id = ?").run(deleted.id);
  listed = cognition.salience.listBySalience();
  assert.deepEqual(listed.items.map((item) => item.memoryId), [high.id, low.id]);
  assert.equal(cognition.salience.listBySalience({ limit: 1 }).items.length, 1);
});

test('跨 scope：标记/读取/列表都不串', async (t) => {
  const { brain, cognition } = createBrain(t);
  const memory = await remember(brain);
  await cognition.salience.markMemory({ memoryId: memory.id, salience: 0.8 });

  assert.equal(cognition.salience.getSalience(memory.id, { scopeId: OTHER_SCOPE_ID }), null);
  assert.deepEqual(cognition.salience.listBySalience({ scopeId: OTHER_SCOPE_ID }).items, []);
  await assert.rejects(
    () => cognition.salience.markMemory({ memoryId: memory.id, salience: 0.5, scopeId: OTHER_SCOPE_ID }),
    (err) => err.code === 'NOT_FOUND',
    '不能从别的 scope 标记这条记忆（连存在性都不承认）',
  );

  // 别的 scope 的记忆也不能被本 scope 标
  const otherMemory = await remember(brain, { scopeId: OTHER_SCOPE_ID, content: '别人的记忆' });
  await assert.rejects(
    () => cognition.salience.markMemory({ memoryId: otherMemory.id, salience: 0.5 }),
    (err) => err.code === 'NOT_FOUND',
  );
});

test('不存在的记忆 / 已删除的记忆：拒（不造孤儿行）', async (t) => {
  const { brain, cognition } = createBrain(t);
  await assert.rejects(
    () => cognition.salience.markMemory({ memoryId: 'mem_not_exist', salience: 0.5 }),
    (err) => err.code === 'NOT_FOUND',
  );

  const memory = await remember(brain);
  brain.db.prepare("UPDATE memories SET status = 'deleted' WHERE id = ?").run(memory.id);
  await assert.rejects(
    () => cognition.salience.markMemory({ memoryId: memory.id, salience: 0.5 }),
    (err) => err.code === 'INVALID_ARGUMENT',
    '已删除的记忆不该被标记',
  );
  assert.equal(countRows(brain.db, 'memory_salience'), 0, '没有任何孤儿行');
});

test('computeSalienceFromSignals：权重与手算值一致', () => {
  // 权重合计 1.0 → 输出天然落在 0..1
  const sum = Object.values(SALIENCE_WEIGHTS).reduce((total, weight) => total + weight, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, '权重合计必须是 1');

  const cases = [
    { signals: {}, expected: 0 },
    { signals: { ownerEmphasis: 1 }, expected: 0.35 },
    { signals: { mentionCount: 1 }, expected: 0.0723 },
    { signals: { mentionCount: 10 }, expected: 0.25 },
    { signals: { mentionCount: 100 }, expected: 0.25 },
    { signals: { hasCommitment: true }, expected: 0.25 },
    { signals: { affectIntensity: 0.5 }, expected: 0.075 },
    { signals: { ownerEmphasis: 1, mentionCount: 10, hasCommitment: true, affectIntensity: 1 }, expected: 1 },
    {
      signals: { ownerEmphasis: 0.5, mentionCount: 3, hasCommitment: true, affectIntensity: 0.5 },
      expected: 0.6445,
    },
  ];
  for (const item of cases) {
    const actual = computeSalienceFromSignals(item.signals);
    assert.ok(Math.abs(actual - item.expected) <= 1e-4, `${JSON.stringify(item.signals)} 期望 ${item.expected}，实际 ${actual}`);
  }

  // 单调性：主人强调越多，分数越高
  assert.ok(computeSalienceFromSignals({ ownerEmphasis: 0.2 }) < computeSalienceFromSignals({ ownerEmphasis: 0.8 }));
  // 非法输入不炸：负数/NaN 当 0
  assert.equal(computeSalienceFromSignals({ mentionCount: -5 }), 0);
  assert.equal(computeSalienceFromSignals({ ownerEmphasis: Number.NaN }), 0);
});

test('salienceBoost：0..1 映射到 0..0.15（显著性不许盖过相关性）', () => {
  assert.equal(MAX_SALIENCE_BOOST, 0.15);
  assert.equal(salienceBoost(0), 0);
  assert.equal(salienceBoost(0.5), 0.075);
  assert.equal(salienceBoost(1), MAX_SALIENCE_BOOST);
  assert.equal(salienceBoost(2), MAX_SALIENCE_BOOST, '越界夹取');
  assert.equal(salienceBoost(-1), 0);
  assert.equal(salienceBoost(null), 0);
  assert.equal(salienceBoost('不是数字'), 0, '排序路径不许因为坏分数抛错');

  // 关键性质：加成永远小于「最小相关性差距」的量级（这里是表达上限约束）
  assert.ok(salienceBoost(1) < 0.2, '显著性只是微调，不能重排主序');
});

test('校验：非有限数拒、越界夹取、signals 必须数组', async (t) => {
  const { brain, cognition } = createBrain(t);
  const memory = await remember(brain);
  await assert.rejects(
    () => cognition.salience.markMemory({ memoryId: memory.id, salience: Number.NaN }),
    (err) => err.code === 'INVALID_ARGUMENT',
    'NaN 不是显著性分数',
  );
  await assert.rejects(
    () => cognition.salience.markMemory({ memoryId: memory.id, salience: 0.5, signals: 'event:1' }),
    (err) => err.code === 'INVALID_ARGUMENT',
    'signals 必须是数组',
  );

  // 越界夹取：浮点误差不该让整条标记落不了库
  const clamped = await cognition.salience.markMemory({
    memoryId: memory.id,
    salience: 1.4,
    valence: -3,
    arousal: 7,
  });
  assert.equal(clamped.salience, 1);
  assert.equal(clamped.valence, -1);
  assert.equal(clamped.arousal, 1);
  const read = cognition.salience.getSalience(memory.id);
  assert.equal(read.salience, 1, '夹取后的值才是落库的值');
});

test('空库不炸 + stats', async (t) => {
  const { cognition } = createBrain(t);
  assert.equal(cognition.salience.getSalience('mem_none'), null);
  assert.deepEqual(cognition.salience.listBySalience(), { items: [], limit: 50 });
  assert.deepEqual(cognition.salience.stats(), { marked: 0, avgSalience: 0, maxSalience: 0, newestAt: null });
});

test('createSalience 可脱离 cognition 单独构造', async (t) => {
  const { brain, fc } = createBrain(t);
  const standalone = createSalience({
    db: brain.db,
    queue: brain.queue,
    clock: fc.clock,
    bindings: { scope_id: DEFAULT_SCOPE_ID, person_id: 'owner' },
  });
  const memory = await remember(brain);
  await standalone.markMemory({ memoryId: memory.id, salience: 0.6 });
  assert.equal(standalone.getSalience(memory.id).salience, 0.6);
  assert.equal(standalone.stats().marked, 1);
});
