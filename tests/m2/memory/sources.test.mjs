// @ts-check
/**
 * M2 来源门面 + 防循环（CONTRACTS §10.6）。
 *
 * 这一组测的不是「能挂来源」，而是两件更容易出事的：
 * 1. **注入内容不许沉淀成人类证据**：`origin_system` 是 brain 的、或内容派生自
 *    其它片段的，都不能标成 `owner_words`。这是实测事故的根因（注入 → 被当用户话语
 *    摄入 → 无注入的会话里再被召回）。
 * 2. **独立来源计数**：`independent_source_key` 必须带来源系统前缀，
 *    同一句话被两个引擎重复转述不算两条独立证据。
 */

import test from 'node:test';
import { assert, SCOPE_A, createBrain, draft } from './helpers.mjs';

test('link / forMemory：挂来源并能读回', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '铜版纸名片 300g', sourceIds: [] }));

  const linked = await brain.sources.link(created.id, {
    sourceSystem: 'dsh',
    sourceEventId: 'host-42',
    locator: 'session/abc#turn-3',
    contentHash: 'sha256:deadbeef',
  });
  assert.match(linked.id, /^ref_[0-9a-f]{32}$/);

  const refs = brain.sources.forMemory(created.id);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].sourceSystem, 'dsh');
  assert.equal(refs[0].sourceEventId, 'host-42');
  assert.equal(refs[0].locator, 'session/abc#turn-3');
  assert.equal(refs[0].contentHash, 'sha256:deadbeef');
  assert.match(refs[0].independentSourceKey, /^dsh:/);
});

test('重复 link 幂等：同一来源只留一行', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '哑粉纸画册', sourceIds: [] }));

  const a = await brain.sources.link(created.id, { sourceSystem: 'dsh', sourceEventId: 'host-1' });
  const b = await brain.sources.link(created.id, { sourceSystem: 'dsh', sourceEventId: 'host-1' });
  assert.equal(a.id, b.id, '同 (记忆, 来源) 必须返回同一个 ref_id');
  assert.equal(brain.sources.forMemory(created.id).length, 1);
});

test('独立来源计数：不同引擎的同一来源不合并（防循环转述）', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '梁截面 2400×600', sourceIds: [] }));

  await brain.sources.link(created.id, { sourceSystem: 'dsh', sourceEventId: 'same-host-id' });
  await brain.sources.link(created.id, { sourceSystem: 'engram', sourceEventId: 'same-host-id' });
  const refs = brain.sources.forMemory(created.id);
  assert.equal(refs.length, 2);
  const keys = new Set(refs.map((ref) => ref.independentSourceKey));
  assert.equal(keys.size, 2, 'independent_source_key 必须带来源系统前缀，否则会被算成一条独立证据');
});

test('verify：正常来源返回 ok', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '喷绘布 1.2m', sourceIds: [] }));
  const linked = await brain.sources.link(created.id, {
    sourceSystem: 'dsh',
    sourceEventId: 'host-ok',
    contentHash: 'sha256:aaa',
  });
  const result = brain.sources.verify(linked.id);
  assert.deepEqual(result, { ok: true, refId: linked.id });
});

test('verify：来源记录不存在 → source_missing', async (t) => {
  const { brain } = createBrain(t);
  const result = brain.sources.verify('ref_00000000000000000000000000000000');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'source_missing');
});

test('verify：内容指纹对不上 → hash_mismatch', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '名片报价 0.45', sourceIds: [] }));
  const linked = await brain.sources.link(created.id, {
    sourceSystem: 'dsh',
    sourceEventId: 'host-hash',
    contentHash: 'sha256:original',
  });

  const mismatch = brain.sources.verify({ id: linked.id, expectedContentHash: 'sha256:tampered' });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'hash_mismatch');

  const same = brain.sources.verify({ id: linked.id, contentHash: 'sha256:original' });
  assert.equal(same.ok, true);
});

test('verify：locator 含控制字符 → locator_invalid', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '画册封面', sourceIds: [] }));
  const linked = await brain.sources.link(created.id, {
    sourceSystem: 'dsh',
    locator: 'file:///reports/a.pdf',
  });
  // 白盒污染 locator（正常写入路径已经拒绝了空串，这里测的是存量脏数据）
  brain.db.prepare('UPDATE source_refs SET locator = ? WHERE ref_id = ?').run('bad\nlocator', linked.id);

  const result = brain.sources.verify(linked.id);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'locator_invalid');
});

test('verify：来源事件已删除 → source_missing', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '首层标高 0.00', sourceIds: ['evt-vanish'] }));
  const refId = brain.sources.forMemory(created.id)[0].id;
  // 外键会拦，临时关掉来构造「事件已被清、refs 还指向它」的存量脏状态
  brain.db.exec('PRAGMA foreign_keys = OFF');
  try {
    brain.db.prepare("UPDATE source_refs SET event_id = 'evt_ghost' WHERE ref_id = ?").run(refId);
  } finally {
    brain.db.exec('PRAGMA foreign_keys = ON');
  }
  const result = brain.sources.verify(refId);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'source_missing');
});

test('link 拒绝不存在的记忆（不留孤儿来源）', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(
    () => brain.sources.link('mem_does_not_exist', { sourceSystem: 'dsh', sourceEventId: 'x' }),
    (err) => {
      assert.equal(err.code, 'NOT_FOUND');
      return true;
    },
  );
});

test('link 拒绝既无 sourceEventId 又无 locator 的来源', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '随便一条', sourceIds: [] }));
  await assert.rejects(
    () => brain.sources.link(created.id, { sourceSystem: 'dsh' }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /sourceEventId 或 locator/);
      return true;
    },
  );
});

test('防循环：Brain 自己注入的内容不许标成 owner_words', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(
    () =>
      brain.memories.create(
        draft({
          content: '<!-- brain:ctx_123 --> 上次那个铜版纸名片的报价是 0.45',
          sourceType: 'owner_words',
          originSystem: 'brain',
        }),
      ),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /owner_words/);
      assert.match(err.message, /10\.6/);
      return true;
    },
  );

  // 换成 summary/inference 就允许写（注入内容可以存，但不能冒充人类话语）
  const ok = await brain.memories.create(
    draft({
      content: '<!-- brain:ctx_123 --> 上次那个铜版纸名片的报价是 0.45',
      sourceType: 'summary',
      originSystem: 'brain',
      producer: 'context-builder@0.1.0',
      derivedFrom: ['ctx_123'],
    }),
  );
  const memory = brain.memories.get(ok.id);
  assert.equal(memory.originSystem, 'brain');
  assert.equal(memory.sourceType, 'summary');
  assert.deepEqual(memory.derivedFrom, ['ctx_123']);

  // 检索命中时 evidenceKind 必须是 summary 而不是 owner_words
  const hit = brain.memories.search({ query: '铜版纸名片的报价', scopeId: SCOPE_A }).hits[0];
  assert.ok(hit);
  assert.notEqual(hit.evidenceKind, 'owner_words', '注入来源的记忆不得以「主人原话」的身份出现');
});

test('防循环：派生自 ContextPackage 的内容不许标成 owner_words', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(
    () =>
      brain.memories.create(
        draft({
          content: '这是从上一轮注入的上下文包里转述出来的内容',
          sourceType: 'owner_words',
          originSystem: 'engram',
          derivedFrom: ['ctx_abc123'],
        }),
      ),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /ctx_/);
      return true;
    },
  );

  // derivedFrom 里放**原始事件 id** 是正常用法，不该被误杀
  const ok = await brain.memories.create(
    draft({
      content: '名片报价 0.45 元一张',
      sourceType: 'owner_words',
      originSystem: 'dsh',
      derivedFrom: ['evt-host-1'],
    }),
  );
  assert.deepEqual(brain.memories.get(ok.id).derivedFrom, ['evt-host-1']);
});

test('originSystem 必须在已知系统里（不许编一个来源系统绕过剔除）', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(
    () => brain.memories.create(draft({ content: 'x', originSystem: 'some-other-agent' })),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /originSystem/);
      return true;
    },
  );
});
