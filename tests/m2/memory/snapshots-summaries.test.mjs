// @ts-check
/**
 * M2 任务快照 + 摘要。
 *
 * 快照的重点是 CAS：**不让慢任务覆盖较新的用户纠错**（CONTRACTS §21.3）。
 * 摘要的重点是来源留痕，否则删除记忆时无法连带抑制派生摘要。
 */

import test from 'node:test';
import { assert, SCOPE_A, createBrain, draft } from './helpers.mjs';
import { CasConflictError } from '../../../packages/memory/src/memory-util.js';

test('快照 save / load：版本从 1 开始，load 拿最新版', async (t) => {
  const { brain } = createBrain(t);
  const saved = await brain.snapshots.save({
    scopeId: SCOPE_A,
    sessionId: 'sess-1',
    turnId: 'turn-1',
    goal: '把名片改成 250g 哑粉并出三个版式',
    doneSteps: ['确认材质', '改尺寸'],
    pendingSteps: ['出稿', '发甲方'],
    artifactHashes: ['sha256:aaa'],
    sourceEventWatermark: 12,
    pendingEffects: [],
  });
  assert.equal(saved.version, 1);
  assert.match(saved.id, /^snap_[0-9a-f]{24}$/);

  const loaded = brain.snapshots.load({ scopeId: SCOPE_A, sessionId: 'sess-1', turnId: 'turn-1' });
  assert.ok(loaded);
  assert.equal(loaded.id, saved.id);
  assert.equal(loaded.version, 1);
  assert.equal(loaded.goal, '把名片改成 250g 哑粉并出三个版式');
  assert.deepEqual(loaded.doneSteps, ['确认材质', '改尺寸']);
  assert.deepEqual(loaded.pendingSteps, ['出稿', '发甲方']);
  assert.deepEqual(loaded.artifactHashes, ['sha256:aaa']);
  assert.equal(loaded.sourceEventWatermark, 12);
});

test('快照版本递增：第二次 save 是第 2 版，load 拿第 2 版', async (t) => {
  const { brain } = createBrain(t);
  await brain.snapshots.save({ scopeId: SCOPE_A, sessionId: 's', turnId: 't', goal: 'v1', doneSteps: [] });
  const second = await brain.snapshots.save({ scopeId: SCOPE_A, sessionId: 's', turnId: 't', goal: 'v2', doneSteps: ['a'] });
  assert.equal(second.version, 2);

  const loaded = brain.snapshots.load({ scopeId: SCOPE_A, sessionId: 's', turnId: 't' });
  assert.equal(loaded.version, 2);
  assert.equal(loaded.goal, 'v2');
});

test('快照 CAS：慢任务拿旧版本写回被拒（不许覆盖较新的用户纠错）', async (t) => {
  const { brain } = createBrain(t);
  await brain.snapshots.save({ scopeId: SCOPE_A, sessionId: 's', turnId: 't', goal: 'v1' });
  await brain.snapshots.save({ scopeId: SCOPE_A, sessionId: 's', turnId: 't', goal: 'v2' });

  // 慢任务以为自己还在第 1 版，想写第 2 版 → 冲突
  await assert.rejects(
    () => brain.snapshots.save({ scopeId: SCOPE_A, sessionId: 's', turnId: 't', goal: 'stale', version: 2 }),
    (err) => {
      assert.ok(err instanceof CasConflictError);
      assert.equal(err.details.cas, true);
      assert.equal(err.details.taskId, `${SCOPE_A}::s::t`);
      return true;
    },
  );
  // 被拒的写入不得落库
  assert.equal(brain.snapshots.load({ scopeId: SCOPE_A, sessionId: 's', turnId: 't' }).goal, 'v2');

  // 正确的下一版可以写
  const third = await brain.snapshots.save({ scopeId: SCOPE_A, sessionId: 's', turnId: 't', goal: 'v3', version: 3 });
  assert.equal(third.version, 3);
});

test('快照按 (scope, session, turn) 分槽，互不覆盖', async (t) => {
  const { brain } = createBrain(t);
  await brain.snapshots.save({ scopeId: SCOPE_A, sessionId: 's1', turnId: 't1', goal: 'A' });
  await brain.snapshots.save({ scopeId: SCOPE_A, sessionId: 's1', turnId: 't2', goal: 'B' });
  assert.equal(brain.snapshots.load({ scopeId: SCOPE_A, sessionId: 's1', turnId: 't1' }).goal, 'A');
  assert.equal(brain.snapshots.load({ scopeId: SCOPE_A, sessionId: 's1', turnId: 't2' }).goal, 'B');
  assert.equal(brain.snapshots.load({ scopeId: SCOPE_A, sessionId: 's2', turnId: 't1' }), null);
});

test('快照删除后 load 返回 null', async (t) => {
  const { brain } = createBrain(t);
  const saved = await brain.snapshots.save({ scopeId: SCOPE_A, sessionId: 's', turnId: 't', goal: '待删' });
  await brain.deletion.requestDeletion({
    target_kind: 'task_snapshot',
    target_id: saved.id,
    scope_id: SCOPE_A,
    reason: '删除快照',
  });
  assert.equal(brain.snapshots.load({ scopeId: SCOPE_A, sessionId: 's', turnId: 't' }), null);
});

test('摘要 create / get：来源事件与水位都留痕', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.summaries.create({
    scopeId: SCOPE_A,
    layer: 'window',
    text: '本轮确认：名片改 250g 哑粉，尺寸 90×54mm',
    sourceEventIds: ['evt-1', 'evt-2'],
    sourceWatermark: 7,
  });
  assert.match(created.id, /^sum_[0-9a-f]{24}$/);

  const summary = brain.summaries.get(created.id);
  assert.ok(summary);
  assert.equal(summary.kind, 'window', 'layer=window 应映射成 summary_kind=window');
  assert.equal(summary.layer, 'window');
  assert.equal(summary.text, '本轮确认：名片改 250g 哑粉，尺寸 90×54mm');
  assert.equal(summary.sourceWatermark, 7);
  assert.equal(summary.status, 'active');
  assert.deepEqual(summary.sources.map((s) => s.id).sort(), ['evt-1', 'evt-2']);
  assert.ok(summary.contentHash.startsWith('sha256:'));
});

test('摘要 layer 不是 summary_kind 的合法值时落 canonical，但 layer 原值保留', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.summaries.create({
    scopeId: SCOPE_A,
    layer: 'long',
    text: '长期记忆层的摘要',
    sourceEventIds: [],
  });
  const summary = brain.summaries.get(created.id);
  assert.equal(summary.kind, 'canonical', 'long 不是 summary_kind 合法值 → 落 canonical');
  assert.equal(summary.layer, 'long', 'layer 原值不能丢');
});

test('摘要拒绝倒挂的有效期与非法水位', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(
    () =>
      brain.summaries.create({
        scopeId: SCOPE_A,
        text: '倒挂',
        validFrom: '2026-10-28T12:00:00.000Z',
        validUntil: '2026-10-28T10:00:00.000Z',
      }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /validUntil/);
      return true;
    },
  );
  await assert.rejects(
    () => brain.summaries.create({ scopeId: SCOPE_A, text: '坏水位', sourceWatermark: -1 }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      return true;
    },
  );
});

test('摘要正文可为空但 text 必填（摘要不是记忆，不参与检索）', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(
    () => brain.summaries.create({ scopeId: SCOPE_A, text: '   ' }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      return true;
    },
  );
  // 摘要是派生数据，不写检索索引：搜摘要正文不该命中记忆
  const summary = await brain.summaries.create({
    scopeId: SCOPE_A,
    text: '这段摘要文字不该出现在记忆检索结果里',
  });
  assert.ok(summary.id);
  const search = brain.memories.search({ query: '不该出现在记忆检索结果里', scopeId: SCOPE_A });
  assert.equal(search.hits.length, 0, 'summary 表不是记忆，不能被 memories.search 命中');
  assert.equal(brain.db.prepare('SELECT count(*) AS n FROM search_ngram WHERE doc_id = ?').get(summary.id).n, 0);
});
