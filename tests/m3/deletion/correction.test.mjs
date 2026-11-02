// @ts-check
/**
 * M3 纠错 vs 遗忘（M3-INTERFACES §3）。
 *
 * 这张表就是验收标准，逐条都有用例：
 *
 * | 维度 | 纠错 supersede | 遗忘 delete |
 * |---|---|---|
 * | 当前查询 | 不再使用旧值 | 不可读 |
 * | 历史查询 asOf | **可显式回看旧值** | **任何查询均不可读，历史模式不能绕过** |
 * | 链 | 保留 supersedes 链 | tombstone 元数据保留在独立账本 |
 *
 * 最容易做错的是第二行右格：很多实现会让 `asOf` 走一条"历史视图"捷径，顺手把删除
 * 屏障绕过去。这里专门用正反两面对照证明没有绕。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SCOPE_A, CORPUS, createBrain, seed } from './helpers.mjs';
import { createCorrections } from '../../../packages/memory/src/correction.js';

const T = (h, m = 0) => `2026-10-28T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

/** @param {import('node:test').TestContext} t */
function setup(t) {
  const ctx = createBrain(t, { startIso: T(9) });
  const corrections = createCorrections({
    db: ctx.brain.db,
    queue: ctx.brain.queue,
    clock: ctx.brain.clock,
    memories: ctx.brain.memories,
    bindings: { scope_id: SCOPE_A },
  });
  return { ...ctx, corrections };
}

test('纠错：旧值标 superseded、链保留、当前视图不可用、asOf 能回看旧值', async (t) => {
  const { brain, corrections, fc } = setup(t);
  const old = await seed(brain, CORPUS.steel, { validFrom: T(9) });
  fc.set(T(10));
  const revised = await seed(brain, CORPUS.steelRevised, { validFrom: T(10) });

  const result = await corrections.supersede(old.id, revised.id, {
    reason: '梁截面按修订版图纸更正',
    effectiveAt: T(10),
  });
  assert.equal(result.effectiveAt, T(10));
  assert.equal(result.effectiveInFuture, false);
  assert.equal(result.oldVersion, 2);
  assert.equal(result.newVersion, 2);

  // 链：新值 supersedes 指向旧值
  const newRow = /** @type {Record<string, unknown>} */ (
    brain.db.prepare('SELECT supersedes, status FROM memories WHERE id = ?').get(revised.id)
  );
  assert.equal(newRow.supersedes, old.id);
  assert.equal(newRow.status, 'active');
  const oldRow = /** @type {Record<string, unknown>} */ (
    brain.db.prepare('SELECT status, valid_until FROM memories WHERE id = ?').get(old.id)
  );
  assert.equal(oldRow.status, 'superseded');
  assert.equal(oldRow.valid_until, T(10));

  // 当前视图：旧值不可用（不再使用旧值）
  const nowView = corrections.currentView(old.id);
  assert.equal(nowView.readable, false);
  assert.equal(nowView.reason, 'superseded');
  assert.equal(nowView.value, null);
  // 当前检索：只有新值
  const hits = brain.memories.search({ query: '梁截面 2400×600', scopeId: SCOPE_A });
  assert.equal(
    hits.hits.some((hit) => hit.memoryId === old.id),
    false,
    '当前检索不该再给旧值',
  );

  // asOf 回看：纠错生效之前（09:30）读到旧值
  const before = corrections.asOfView(old.id, T(9, 30));
  assert.equal(before.readable, true, `asOf 应能回看旧值：${JSON.stringify(before.reason)}`);
  assert.equal(before.value?.content, CORPUS.steel.content);
  // 生效之后（10:30）读到的是"当时无效"
  const after = corrections.asOfView(old.id, T(10, 30));
  assert.equal(after.readable, false);
  assert.equal(after.reason, 'not_valid_at_time');

  // 链：一条链两个节点，旧→新
  const chain = corrections.chainOf(revised.id);
  assert.deepEqual(
    chain.map((node) => node.id),
    [old.id, revised.id],
  );
  assert.deepEqual(
    chain.map((node) => node.status),
    ['superseded', 'active'],
  );

  // 版本留痕带得动 reason（纠错理由要能审计）
  const versions = /** @type {Array<{ change_reason: string|null, changed_by: string }>} */ (
    brain.db.prepare('SELECT change_reason, changed_by FROM memory_versions WHERE memory_id = ? ORDER BY version ASC').all(old.id)
  );
  const correctionVersions = versions.filter((row) => row.changed_by === 'corrections.supersede');
  assert.equal(correctionVersions.length, 1, `恰好一条纠错版本留痕，实际：${JSON.stringify(versions)}`);
  assert.ok(String(correctionVersions[0].change_reason ?? '').includes('梁截面按修订版图纸更正'));
});

test('遗忘：删除后 asOf 也读不到，历史模式不能绕过删除', async (t) => {
  const { brain, corrections, fc } = setup(t);
  const created = await seed(brain, CORPUS.drawing, { validFrom: T(9) });
  fc.advance(1000);

  // 删除前：asOf 读得到（同一时点）
  const beforeDelete = corrections.asOfView(created.id, T(9, 30));
  assert.equal(beforeDelete.readable, true);

  const deletion = await brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: created.id,
    scope_id: SCOPE_A,
    reason: '主人要求删除',
    actor: 'owner',
  });
  assert.equal(deletion.status, 'accepted');

  // 删除后：任何查询都读不到
  assert.equal(brain.memories.get(created.id), null);
  assert.equal(brain.memories.get(created.id, { asOf: T(9, 30) }), null, 'asOf 也不许读');
  const view = corrections.asOfView(created.id, T(9, 30));
  assert.equal(view.readable, false);
  assert.equal(view.reason, 'deleted', '必须明确是"已删除"，不是"当时无效"');
  assert.equal(view.value, null);
  assert.equal(corrections.currentView(created.id).reason, 'deleted');

  // 检索带 asOf 也一样搜不到（历史检索不是旁路）
  const historicalSearch = brain.memories.search({ query: '建施-03 层高', scopeId: SCOPE_A, asOf: T(9, 30) });
  assert.equal(historicalSearch.hits.length, 0, 'asOf 检索不许绕过删除屏障');

  // 链里也不回正文（链只给元数据）
  const chain = corrections.chainOf(created.id);
  assert.equal(chain.length, 1);
  assert.equal(chain[0].status, 'deleted');
  assert.equal(chain[0].content, null);
});

test('删除压过纠错：已删的记忆不能作为 supersede 目标', async (t) => {
  const { brain, corrections } = setup(t);
  const old = await seed(brain, CORPUS.card);
  const fresh = await seed(brain, CORPUS.negative);
  await brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: old.id,
    scope_id: SCOPE_A,
    reason: '隐私删除',
    actor: 'owner',
  });
  await assert.rejects(
    () => corrections.supersede(old.id, fresh.id, { reason: '想绕过删除' }),
    (err) => err.code === 'DELETION_BARRIER',
    '已删除的记忆不能被"纠错"复活成 superseded',
  );
  // 状态没变
  const row = /** @type {{ status: string }} */ (brain.db.prepare('SELECT status FROM memories WHERE id = ?').get(old.id));
  assert.equal(row.status, 'deleted');
});

test('effectiveAt 可以补录到过去：生效前后的 asOf 各读一边', async (t) => {
  const { brain, corrections, fc } = setup(t);
  const old = await seed(brain, CORPUS.quote, { validFrom: T(8) });
  fc.set(T(11));
  const fresh = await seed(brain, CORPUS.negative, { validFrom: T(8) });
  // 纠错实际发生在 11:00，但图纸是 09:00 就更正的（补录场景）
  const result = await corrections.supersede(old.id, fresh.id, { reason: '补录更正文', effectiveAt: T(9) });
  assert.equal(result.effectiveAt, T(9));

  assert.equal(corrections.asOfView(old.id, T(8, 30)).readable, true, '09:00 之前旧值有效');
  assert.equal(corrections.asOfView(old.id, T(9, 30)).readable, false, '09:00 之后旧值失效');
  assert.equal(corrections.asOfView(fresh.id, T(9, 30)).readable, true, '09:00 之后新值有效');
});

test('生效时间在未来时：当前旧值仍算可用（预定生效不是立即失效）', async (t) => {
  const { brain, corrections, fc } = setup(t);
  const old = await seed(brain, CORPUS.identifiers, { validFrom: T(9) });
  fc.set(T(10));
  const fresh = await seed(brain, CORPUS.negative, { validFrom: T(9) });
  const result = await corrections.supersede(old.id, fresh.id, { reason: '下版生效', effectiveAt: T(12) });
  assert.equal(result.effectiveInFuture, true);

  const view = corrections.currentView(old.id);
  assert.equal(view.readable, true, '还没到生效时间，旧值当前仍可用');
  assert.equal(view.reason, 'ok');
});

test('链的边界：不存在 / 自纠错 / 跨 scope 都给明确错误', async (t) => {
  const { brain, corrections } = setup(t);
  const a = await seed(brain, CORPUS.card);
  // 不存在的 id：给明确的 not_found，不是抛错也不是编一份
  const missing = corrections.currentView('mem_not_exist');
  assert.equal(missing.reason, 'not_found');
  assert.equal(missing.readable, false);
  assert.equal(missing.value, null);
  // 空 id 才是调用方 bug（抛错）
  assert.throws(() => corrections.currentView(''), (err) => err.code === 'INVALID_ARGUMENT');

  await assert.rejects(() => corrections.supersede(a.id, a.id), (err) => err.code === 'INVALID_ARGUMENT');
  const other = await seed(brain, CORPUS.quote, { scopeId: 'owner-other' });
  // 口径变更（2026-10-29，task-10 写路径 scope 收口）：
  // 旧口径抛 INVALID_ARGUMENT +「不在同一 scope」——那句话等于告诉调用方
  // 「这条记忆存在，只是不归你」，属于确认存在性。新口径统一 NOT_FOUND（不确认存在性）。
  // 测试意图（跨 scope 必须被拒）不变，只是错误码跟着口径改了。
  await assert.rejects(
    () => corrections.supersede(a.id, other.id),
    (err) => err.code === 'NOT_FOUND',
  );
});
