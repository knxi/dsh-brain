// @ts-check
/**
 * M2 删除屏障：删除必须压过检索（契约 §8）。
 *
 * 最关键的一条不是「删完搜不到」（那太容易满足），而是：
 * **索引里还有残留、原文也还在时，依然搜不到。**
 * 这正是 search 报告 §4.4 踩过的坑——LIKE 兜底查 `memories` 原文表时，
 * 「删了索引、没删原文」的内容会被捞出来。
 *
 * 所以这里刻意构造三种「脏」状态，每一种都必须被屏障拦住：
 *  1. 只写了墓碑 + 标了 deleted，索引没清（真实删除流程的中间态）；
 *  2. 索引被手工塞回去（模拟删索引失败 / 从备份恢复回来的旧索引）；
 *  3. `deletion_epoch` 抬高了但 status 被人改回 active（模拟脏写）。
 */

import test from 'node:test';
import { assert, SCOPE_A, createBrain, draft, indexDocIds } from './helpers.mjs';

test('删除后立刻搜不到（不等异步 worker 清正文）', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({ content: '铜版纸名片 300g 报价 0.45', sourceIds: ['evt-del-1'] }),
  );
  assert.equal(brain.memories.search({ query: '铜版纸名片', scopeId: SCOPE_A }).hits.length, 1);

  const deletion = await brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: created.id,
    scope_id: SCOPE_A,
    reason: '用户要求删除',
  });
  assert.equal(deletion.status, 'accepted');
  assert.ok(deletion.deletion_epoch >= 1);

  const result = brain.memories.search({ query: '铜版纸名片', scopeId: SCOPE_A });
  assert.equal(result.hits.length, 0, '删除后必须立刻搜不到');
  assert.equal(result.diagnostics.status, 'no_related');
  assert.ok(
    result.diagnostics.notes.some((note) => note.includes('删除屏障')),
    `notes 必须说明是被删除屏障剔除，实际：${JSON.stringify(result.diagnostics.notes)}`,
  );

  // get 也必须返回 null（不可检索包含不可读）
  assert.equal(brain.memories.get(created.id), null);
  // 列表里也不能出现
  assert.equal(brain.memories.list({ scopeId: SCOPE_A }).items.length, 0);
});

test('索引残留也捞不出来：手工把索引塞回去后仍然搜不到', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({ content: '哑粉纸画册 210×285mm 覆哑膜', sourceIds: ['evt-del-2'] }),
  );
  await brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: created.id,
    scope_id: SCOPE_A,
    reason: '测试：仅写墓碑未清索引',
  });

  // 关键构造：把索引重新喂回去（等价于「删了索引没删原文 / 旧备份的索引被恢复」）
  brain.searchBridge.getIndex().indexDoc({ id: created.id, content: '哑粉纸画册 210×285mm 覆哑膜' });
  assert.equal(indexDocIds(brain.db, 'search_fts_char').includes(created.id), true, '前提：索引里确实有这条残留');

  // 三路都必须拦：主路
  const byChar = brain.memories.search({ query: '哑粉纸画册', scopeId: SCOPE_A });
  assert.equal(byChar.hits.length, 0, 'char 主路命中必须被屏障拦下');
  // 补充路（≥3 字符短语走 trigram）
  const byTrigram = brain.memories.search({ query: '210×285mm', scopeId: SCOPE_A });
  assert.equal(byTrigram.hits.length, 0, 'trigram 命中必须被屏障拦下');
  // LIKE 兜底路径（精确子串）
  const byLike = brain.memories.search({ query: '覆哑膜', scopeId: SCOPE_A });
  assert.equal(byLike.hits.length, 0, 'LIKE 兜底命中必须被屏障拦下');
});

test('deletion_epoch 抬高但 status 被脏改成 active：一样拦住', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({ content: '建施-03 首层标高 0.00', sourceIds: ['evt-del-3'] }),
  );
  await brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: created.id,
    scope_id: SCOPE_A,
    reason: '删除后又脏写回 active',
  });
  // 模拟脏写：把 status 改回 active，但 deletion_epoch 留着（真实世界会这样出错）
  brain.db.prepare("UPDATE memories SET status = 'active' WHERE id = ?").run(created.id);

  const result = brain.memories.search({ query: '首层标高', scopeId: SCOPE_A });
  assert.equal(result.hits.length, 0, 'deletion_epoch > 0 的行不许被检索到（墓碑优先于脏状态）');
  assert.equal(brain.memories.get(created.id), null);
});

test('删除幂等：重复删同一目标不重复抬高 epoch', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '重复删除测试', sourceIds: ['evt-idem'] }));

  const first = await brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: created.id,
    scope_id: SCOPE_A,
    reason: '第一次',
  });
  const second = await brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: created.id,
    scope_id: SCOPE_A,
    reason: '第二次',
  });
  assert.equal(second.status, 'already_tombstoned');
  assert.equal(second.deletion_epoch, first.deletion_epoch);
  assert.equal(brain.deletion.getDeletionEpoch(), first.deletion_epoch);
});

test('删除记忆会连带抑制由它派生的摘要（shieldTarget 的派生路径）', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({ content: '名片报价 0.45 元一张', sourceIds: ['evt-sum-src'] }),
  );
  // 摘要通过 summaries.create 记来源（source_kind='event'）
  const summary = await brain.summaries.create({
    scopeId: SCOPE_A,
    layer: 'window',
    text: '名片报价是 0.45 元',
    sourceEventIds: ['evt-sum-src'],
  });
  // 让 summary_sources 也能顺着 memory 找到：deletion 的 shieldTarget 按 source_kind='memory' 查
  brain.db
    .prepare(
      `INSERT INTO summary_sources (summary_id, source_kind, source_id, ordinal, created_at, created_at_local)
       VALUES (?, 'memory', ?, 1, '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00')`,
    )
    .run(summary.id, created.id);

  await brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: created.id,
    scope_id: SCOPE_A,
    reason: '删除记忆，摘要必须一起抑制',
  });

  const row = /** @type {{ status: string, deletion_epoch: number }} */ (
    brain.db.prepare('SELECT status, deletion_epoch FROM summaries WHERE summary_id = ?').get(summary.id)
  );
  assert.equal(row.status, 'suppressed', '派生摘要必须被抑制（不能留一个还算数的摘要）');
  assert.ok(row.deletion_epoch >= 1);
});

test('asOf 也捞不出已删记忆（屏障优先于时点回看）', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({ content: '历史报价 0.45 元', sourceIds: ['evt-del-asof'], validFrom: '2026-10-28T09:00:00.000Z' }),
  );
  await brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: created.id,
    scope_id: SCOPE_A,
    reason: '删除',
  });

  assert.equal(brain.memories.get(created.id, { asOf: '2026-10-28T10:00:00.000Z' }), null);
  const result = brain.memories.search({
    query: '历史报价',
    scopeId: SCOPE_A,
    asOf: '2026-10-28T10:00:00.000Z',
  });
  assert.equal(result.hits.length, 0, 'asOf 不能把已删内容捞回来');
});

test('删除只影响目标：同 scope 的其它记忆照常可检索', async (t) => {
  const { brain } = createBrain(t);
  const doomed = await brain.memories.create(draft({ content: '铜版纸名片报价', sourceIds: ['evt-a'] }));
  const survivor = await brain.memories.create(draft({ content: '哑粉纸画册报价', sourceIds: ['evt-b'] }));

  await brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: doomed.id,
    scope_id: SCOPE_A,
    reason: '只删一条',
  });

  const result = brain.memories.search({ query: '哑粉纸画册', scopeId: SCOPE_A });
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].memoryId, survivor.id);
  assert.equal(result.diagnostics.status, 'ok');
});
