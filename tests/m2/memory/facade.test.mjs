// @ts-check
/**
 * M2 写读一致性 / CAS / supersede 链 / list 分页。
 *
 * 这些是「其他三条线能联调」的地基：写进去的必须原样读得出来，
 * 版本必须能被 CAS 保护，纠错必须留痕而不是覆盖。
 */

import test from 'node:test';
import { assert, CORPUS, SCOPE_A, SCOPE_B, countRows, createBrain, draft, seedCorpus } from './helpers.mjs';
import { CasConflictError } from '../../../packages/memory/src/memory-util.js';

test('创建后立即能按 id 读回，原文字段逐一保真', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({
      content: '铜版纸名片 300g，成品尺寸 90×54mm，报价 0.45 元一张',
      summary: '名片：铜版纸 300g / 90×54mm / 0.45 元',
      layer: 'long',
      type: 'semantic',
      sourceType: 'owner_words',
      sourceIds: ['evt-card-1'],
      confidence: 0.95,
      importance: 0.8,
      privacy: 'private',
      originSystem: 'dsh',
      producer: 'connector@0.1.0',
      derivedFrom: ['evt-card-1'],
      causationId: 'turn-1',
      pinned: true,
    }),
  );

  assert.match(created.id, /^mem_[0-9a-f]{24}$/);
  assert.equal(created.version, 1);

  const memory = brain.memories.get(created.id);
  assert.ok(memory);
  // 原文一字不改（CONTRACTS §7：数字/单位/符号不被不可逆清洗）
  assert.equal(memory.content, '铜版纸名片 300g，成品尺寸 90×54mm，报价 0.45 元一张');
  assert.equal(memory.layer, 'long');
  assert.equal(memory.type, 'semantic');
  assert.equal(memory.confidence, 0.95);
  assert.equal(memory.importance, 0.8);
  assert.equal(memory.pinned, true);
  assert.equal(memory.status, 'active');
  assert.equal(memory.originSystem, 'dsh');
  assert.equal(memory.producer, 'connector@0.1.0');
  assert.deepEqual(memory.derivedFrom, ['evt-card-1']);
  assert.equal(memory.causationId, 'turn-1');
  assert.deepEqual(memory.sourceIds, ['evt-card-1']);
  assert.equal(memory.scopeId, SCOPE_A);
  assert.equal(memory.personId, 'owner');
  // 版本留痕：create 必须写 memory_versions
  assert.equal(countRows(brain.db, 'memory_versions'), 1);
});

test('推断不得伪装成确定事实：inference + confidence=1 直接拒', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(
    () =>
      brain.memories.create(
        draft({ content: '甲方下周一定付款', sourceType: 'inference', confidence: 1 }),
      ),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /inference/);
      return true;
    },
  );
  // confidence < 1 就允许
  const ok = await brain.memories.create(draft({ content: '甲方大概率下周付款', sourceType: 'inference', confidence: 0.4 }));
  assert.ok(ok.id);
});

test('update 是 CAS：版本不符抛 CasConflictError，details.cas 标记来源', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '名片 300g' }));

  const updated = await brain.memories.update(created.id, { content: '名片改成 250g 哑粉' }, { expectedVersion: 1 });
  assert.equal(updated.version, 2);

  const reread = brain.memories.get(created.id);
  assert.equal(reread.content, '名片改成 250g 哑粉');
  assert.equal(reread.version, 2);

  // 拿旧版本再写 → 必须被拒（慢任务不得覆盖较新的用户纠错）
  await assert.rejects(
    () => brain.memories.update(created.id, { content: '又改回 300g' }, { expectedVersion: 1 }),
    (err) => {
      assert.ok(err instanceof CasConflictError);
      assert.equal(err.details.cas, true);
      assert.equal(err.details.expectedVersion, 1);
      assert.equal(err.details.actualVersion, 2);
      return true;
    },
  );
  // 被拒的写入不得留痕
  assert.equal(brain.memories.get(created.id).content, '名片改成 250g 哑粉');
  assert.equal(brain.memories.get(created.id).version, 2);
});

test('update 必须显式给 expectedVersion；身份字段不许改', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '画册 210×285mm' }));

  await assert.rejects(() => brain.memories.update(created.id, { content: 'x' }, {}), (err) => {
    assert.equal(err.code, 'INVALID_ARGUMENT');
    assert.match(err.message, /expectedVersion/);
    return true;
  });
  await assert.rejects(
    () => brain.memories.update(created.id, { scopeId: SCOPE_B }, { expectedVersion: 1 }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /scopeId/);
      return true;
    },
  );
  await assert.rejects(
    () => brain.memories.update('mem_not_exist', { content: 'x' }, { expectedVersion: 1 }),
    (err) => {
      assert.equal(err.code, 'NOT_FOUND');
      return true;
    },
  );
});

test('改 content 会重建三套索引：新内容能搜到，旧内容搜不到', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '户外喷绘布 1.2m 宽' }));

  assert.equal(brain.memories.search({ query: '喷绘布', scopeId: SCOPE_A }).hits.length, 1);

  await brain.memories.update(created.id, { content: '室内写真纸 0.9m 宽' }, { expectedVersion: 1 });

  const old = brain.memories.search({ query: '喷绘布', scopeId: SCOPE_A });
  assert.equal(old.hits.length, 0, '改内容后旧索引必须清干净');
  const fresh = brain.memories.search({ query: '写真纸', scopeId: SCOPE_A });
  assert.equal(fresh.hits.length, 1, '新内容必须可检索');
});

test('supersede：旧条目标 superseded 并封口，链与新值都能查到', async (t) => {
  const { brain, fc } = createBrain(t);
  const oldOne = await brain.memories.create(
    draft({ content: '名片用铜版纸 300g', summary: '名片 300g', sourceIds: ['evt-1'] }),
  );
  fc.advance(60_000);
  const newOne = await brain.memories.create(
    draft({ content: '名片改用 250g 哑粉纸', summary: '名片 250g 哑粉', sourceIds: ['evt-2'] }),
  );

  await brain.memories.supersede(oldOne.id, newOne.id);

  const oldAfter = brain.memories.get(oldOne.id);
  assert.equal(oldAfter.status, 'superseded');
  assert.ok(oldAfter.validUntil, 'supersede 必须给旧条目封口（不删，靠有效期表达过期）');
  assert.equal(oldAfter.validUntil, fc.nowIso());

  const newAfter = brain.memories.get(newOne.id);
  assert.equal(newAfter.supersedes, oldOne.id, '链必须保留');

  // 当前检索只给新值（旧值已过期）
  const now = brain.memories.search({ query: '名片', scopeId: SCOPE_A, minCoverage: 0.1 });
  const ids = now.hits.map((h) => h.memoryId);
  assert.ok(ids.includes(newOne.id), '当前检索必须命中新值');
  assert.ok(!ids.includes(oldOne.id), '当前检索不该命中已被取代的旧值');

  // 时点回看旧时刻，命中的是旧值（见 asof 测试里的细致断言）
  const before = brain.memories.get(oldOne.id, { asOf: '2026-10-28T10:00:30.000Z' });
  assert.equal(before.status, 'superseded');
});

test('list：按 created_at 倒序键集分页，无重复无遗漏', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);

  const page1 = brain.memories.list({ scopeId: SCOPE_A, limit: 3 });
  assert.equal(page1.items.length, 3);
  assert.ok(page1.nextCursor);

  const page2 = brain.memories.list({ scopeId: SCOPE_A, limit: 3, cursor: page1.nextCursor });
  assert.equal(page2.items.length, 3);
  const page3 = brain.memories.list({ scopeId: SCOPE_A, limit: 3, cursor: page2.nextCursor });
  assert.equal(page3.items.length, CORPUS.length - 6);
  assert.equal(page3.nextCursor, null);

  const seen = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
  assert.equal(new Set(seen).size, CORPUS.length, '分页不许重复');
  assert.equal(seen.length, CORPUS.length, '分页不许遗漏');
  for (const id of Object.values(ids)) assert.ok(seen.includes(id));
});

test('list：scope 隔离 + 状态过滤 + 删除态不出现在列表里', async (t) => {
  const { brain } = createBrain(t);
  const mine = await brain.memories.create(draft({ content: '我的报价单', scopeId: SCOPE_A }));
  const other = await brain.memories.create(draft({ content: '别人的报价单', scopeId: SCOPE_B }));

  const listA = brain.memories.list({ scopeId: SCOPE_A });
  assert.deepEqual(listA.items.map((i) => i.id), [mine.id]);

  const listB = brain.memories.list({ scopeId: SCOPE_B });
  assert.deepEqual(listB.items.map((i) => i.id), [other.id]);

  await brain.memories.update(mine.id, { status: 'archived' }, { expectedVersion: 1 });
  // name：未传 status 时 list 是「管理视角」，除 deleted 外都返回（检查器要用）
  const byDefault = brain.memories.list({ scopeId: SCOPE_A });
  assert.equal(byDefault.items.length, 1);
  assert.equal(byDefault.items[0].status, 'archived');
  const archived = brain.memories.list({ scopeId: SCOPE_A, status: 'archived' });
  assert.equal(archived.items.length, 1, '显式过滤能看到归档项');
  const activeOnly = brain.memories.list({ scopeId: SCOPE_A, status: 'active' });
  assert.equal(activeOnly.items.length, 0, '显式 active 过滤排除归档项');
  const all = brain.memories.list({ scopeId: SCOPE_A, status: 'all' });
  assert.equal(all.items.length, 1, 'status=all 等价于不过滤（仍排除 deleted）');
});
