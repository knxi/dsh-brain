// @ts-check
/**
 * M1 契约：删除屏障基础（tombstone + deletion_epoch + 派生任务重查）。
 *
 * 覆盖：立即屏蔽、异步清正文、重复删除幂等、epoch 单调、
 * 派生任务旧 epoch 拒绝写回、清理 job 不被其它目标误伤。
 */

import test from 'node:test';
import { assert, countRows, createBrain, createEvent, insertMemory } from './helpers.mjs';
import { DeletionBarrierError } from '../../packages/core/src/index.js';

test('删除请求：立即屏蔽 + 返回 accepted（202 语义），正文留给 worker', async (t) => {
  const ctx = createBrain(t);
  insertMemory(ctx.brain.db, { id: 'mem_1', content: '要被忘记的内容' });

  const result = await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_1',
    scope_id: 'owner-default',
    reason: '测试删除',
  });

  assert.equal(result.status, 'accepted');
  assert.equal(result.deletion_epoch, 1);
  assert.equal(result.jobs, 1);
  assert.ok(result.affected?.some((item) => item.table === 'memories' && item.changes === 1));

  const memory = /** @type {Record<string, unknown>} */ (
    ctx.brain.db.prepare('SELECT status, content, deletion_epoch FROM memories WHERE id = ?').get('mem_1')
  );
  assert.equal(memory.status, 'deleted', '删除请求必须立即让目标不可检索');
  assert.equal(Number(memory.deletion_epoch), 1);
  assert.equal(memory.content, '要被忘记的内容', '正文由异步 worker 清，不在请求事务里做重活');

  assert.equal(ctx.brain.deletion.isDeleted({ target_kind: 'memory', target_id: 'mem_1' }), true);
  assert.equal(ctx.brain.deletion.getDeletionEpoch(), 1);
  const audits = ctx.brain.ledger.listAudit({ action: 'deletion.requested' });
  assert.equal(audits.length, 1);
});

test('异步 worker：清正文、job done、tombstone verified', async (t) => {
  const ctx = createBrain(t);
  insertMemory(ctx.brain.db, { id: 'mem_1', content: '会遗忘的内容' });
  await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_1',
    scope_id: 'owner-default',
    reason: '测试清理',
  });

  const purged = await ctx.brain.deletion.runPurgeWorker({ limit: 10 });
  assert.equal(purged.claimed, 1);
  assert.equal(purged.results[0].status, 'done');

  const memory = /** @type {Record<string, unknown>} */ (
    ctx.brain.db.prepare('SELECT status, content, summary FROM memories WHERE id = ?').get('mem_1')
  );
  assert.equal(memory.content, null);
  assert.equal(memory.summary, null);
  assert.equal(memory.status, 'deleted');

  const version = /** @type {Record<string, unknown>} */ (
    ctx.brain.db.prepare('SELECT content FROM memory_versions WHERE memory_id = ?').get('mem_1')
  );
  assert.equal(version.content, null, '历史版本正文也必须清');

  const tombstone = ctx.brain.deletion.listTombstones()[0];
  assert.equal(tombstone.status, 'verified');
  assert.equal(countRows(ctx.brain.db, 'deletion_jobs'), 1);
  assert.equal(ctx.brain.ledger.listAudit({ action: 'deletion.purged' }).length, 1);
});

test('重复删除同一目标幂等：不重复抬高 epoch、不重复排队', async (t) => {
  const ctx = createBrain(t);
  insertMemory(ctx.brain.db, { id: 'mem_1' });
  const first = await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_1',
    scope_id: 'owner-default',
    reason: '第一次',
  });
  const second = await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_1',
    scope_id: 'owner-default',
    reason: '第二次',
  });
  assert.equal(second.status, 'already_tombstoned');
  assert.equal(second.idempotent, true);
  assert.equal(second.deletion_epoch, first.deletion_epoch);
  assert.equal(ctx.brain.deletion.getDeletionEpoch(), 1);
  assert.equal(countRows(ctx.brain.db, 'deletion_jobs'), 1);
  assert.equal(countRows(ctx.brain.db, 'deletion_tombstones'), 1);
});

test('每次删除递增 deletion_epoch（全局单调）', async (t) => {
  const ctx = createBrain(t);
  insertMemory(ctx.brain.db, { id: 'mem_1' });
  insertMemory(ctx.brain.db, { id: 'mem_2' });
  const a = await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_1',
    scope_id: 'owner-default',
    reason: 'a',
  });
  const b = await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_2',
    scope_id: 'owner-default',
    reason: 'b',
  });
  assert.equal(a.deletion_epoch, 1);
  assert.equal(b.deletion_epoch, 2);
  assert.equal(ctx.brain.deletion.getDeletionEpoch(), 2);
});

test('派生任务带旧 epoch 写回 → DELETION_BARRIER 拒绝', async (t) => {
  const ctx = createBrain(t);
  insertMemory(ctx.brain.db, { id: 'mem_1' });
  insertMemory(ctx.brain.db, { id: 'mem_2' });
  await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_1',
    scope_id: 'owner-default',
    reason: 'a',
  });
  // 模拟摘要任务在删除前记下 epoch=1，删除后回来写回
  const staleEpoch = 1;
  await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_2',
    scope_id: 'owner-default',
    reason: 'b',
  });

  assert.throws(
    () => ctx.brain.deletion.assertEpochFresh(staleEpoch, { target_kind: 'summary', target_id: 'sum_1' }),
    (err) => {
      assert.ok(err instanceof DeletionBarrierError);
      assert.equal(err.code, 'DELETION_BARRIER');
      assert.equal(err.info.worker_epoch, 1);
      assert.equal(err.info.current_epoch, 2);
      return true;
    },
  );
  assert.equal(ctx.brain.deletion.assertEpochFresh(2), 2, '当前 epoch 允许');
});

test('清理 job 不被其它目标的删除误伤（按目标判断，不按全局 epoch）', async (t) => {
  const ctx = createBrain(t);
  insertMemory(ctx.brain.db, { id: 'mem_1', content: '甲' });
  insertMemory(ctx.brain.db, { id: 'mem_2', content: '乙' });
  await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_1',
    scope_id: 'owner-default',
    reason: '先删甲',
  });
  // 甲还没清理，乙又被删 → 全局 epoch 变成 2
  await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_2',
    scope_id: 'owner-default',
    reason: '再删乙',
  });

  const purged = await ctx.brain.deletion.runPurgeWorker({ limit: 10 });
  assert.equal(purged.claimed, 2);
  assert.deepEqual(
    purged.results.map((item) => item.status).sort(),
    ['done', 'done'],
    '两个 job 都必须成功，甲不能被乙的删除拖累',
  );
  const rows = /** @type {Array<Record<string, unknown>>} */ (
    ctx.brain.db.prepare('SELECT id, content FROM memories ORDER BY id').all()
  ).map((row) => ({ id: String(row.id), content: row.content === null ? null : String(row.content) }));
  assert.deepEqual(rows, [
    { id: 'mem_1', content: null },
    { id: 'mem_2', content: null },
  ]);
});

test('删除事件：payload_text 立即清空，事件行仍保留', async (t) => {
  const ctx = createBrain(t);
  const accepted = await ctx.brain.ledger.ingestEvent(createEvent({ payload_text: '私密原话' }));
  await ctx.brain.deletion.requestDeletion({
    target_kind: 'event',
    target_id: accepted.event_id,
    scope_id: 'owner-default',
    reason: '隐私删除',
  });
  const event = ctx.brain.ledger.readEvent(accepted.event_id);
  assert.ok(event, '事件行（元数据）保留，用于删除账本');
  assert.equal(event.payload_text, null, '正文必须立即不可读');
  assert.equal(event.deletion_epoch, 1);
});

test('context_packages 在删除时保守失效（旧 epoch 的包不可再注入）', async (t) => {
  const ctx = createBrain(t);
  insertMemory(ctx.brain.db, { id: 'mem_1' });
  ctx.brain.db
    .prepare(
      `INSERT INTO context_packages (context_id, scope_id, policy_version, payload_hash, status, built_at, built_at_local, created_at, created_at_local, deletion_epoch)
       VALUES ('ctx_1', 'owner-default', 'v1', 'sha256:x', 'attached', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00', 0)`,
    )
    .run();
  await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_1',
    scope_id: 'owner-default',
    reason: 'x',
  });
  const pkg = /** @type {{ status?: string }} */ (
    ctx.brain.db.prepare('SELECT status FROM context_packages WHERE context_id = ?').get('ctx_1')
  );
  assert.equal(pkg.status, 'discarded');
});

test('未实现的能力不虚报：未知清理 job 类型直接拒绝入队', async (t) => {
  const ctx = createBrain(t);
  insertMemory(ctx.brain.db, { id: 'mem_1' });
  await assert.rejects(
    () =>
      ctx.brain.deletion.requestDeletion({
        target_kind: 'memory',
        target_id: 'mem_1',
        scope_id: 'owner-default',
        reason: 'x',
        jobs: ['scrub_index_bogus'],
      }),
    /不支持/,
  );
});
