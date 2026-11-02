// @ts-check
/**
 * M1 门槛：双写/导出故障可恢复。
 * 主账提交成功后，JSONL 导出（或任何 outbox 工作）失败**不回滚主账**，
 * outbox 保持未完成并告警；重试成功后回到 done。
 */

import test from 'node:test';
import { assert, countRows, createBrain, createEvent } from './helpers.mjs';
import { BrainError } from '../../packages/core/src/index.js';

test('导出失败：主账不回滚，outbox 保持未完成并告警', async (t) => {
  const { brain, alerts } = createBrain(t);
  const accepted = await brain.ledger.ingestEvent(createEvent({ payload_text: '私密内容-A' }));

  const claimed = await brain.outbox.claim({ limit: 10 });
  assert.equal(claimed.length, 1);
  const job = claimed[0];
  assert.equal(job.kind, 'project_event');
  assert.equal(job.attempts, 1);

  // 模拟外部导出（JSONL 写盘 / 网络）失败
  const failure = await brain.outbox.fail(job.outbox_id, new Error('导出失败: disk quota exceeded'));
  assert.equal(failure.status, 'pending', '未达上限应回到 pending 等待重试');
  assert.equal(failure.attempts, 1);

  // 主账绝不因为导出失败而回滚
  assert.equal(countRows(brain.db, 'events'), 1);
  assert.equal(brain.ledger.readEvent(accepted.event_id)?.payload_text, '私密内容-A');
  assert.equal(countRows(brain.db, 'sessions'), 1);

  const row = /** @type {Record<string, unknown>} */ (
    brain.db.prepare('SELECT status, attempts, last_error, next_attempt_at FROM outbox WHERE outbox_id = ?').get(job.outbox_id)
  );
  assert.equal(row.status, 'pending');
  assert.equal(Number(row.attempts), 1);
  assert.match(String(row.last_error), /disk quota exceeded/);
  assert.ok(row.next_attempt_at, '失败必须安排退避重试时间');

  const failureAlerts = alerts.filter((item) => item.kind === 'outbox_failed');
  assert.equal(failureAlerts.length, 1, '失败必须告警');
  assert.doesNotMatch(JSON.stringify(failureAlerts[0]), /私密内容-A/, '告警不得带正文');
});

test('退避之后重试成功：outbox → done，主账数据不变', async (t) => {
  const { brain, fc } = createBrain(t);
  await brain.ledger.ingestEvent(createEvent());
  const first = (await brain.outbox.claim({ limit: 1 }))[0];
  await brain.outbox.fail(first.outbox_id, new Error('第一次失败'));

  // 还没到 next_attempt_at：claim 不该拿到
  assert.equal((await brain.outbox.claim({ limit: 1 })).length, 0);
  fc.advance(10_000);

  const second = await brain.outbox.claim({ limit: 1 });
  assert.equal(second.length, 1);
  assert.equal(second[0].attempts, 2);
  const done = await brain.outbox.complete(second[0].outbox_id);
  assert.equal(done.status, 'done');

  // 幂等：重复 complete 不报错
  const again = await brain.outbox.complete(second[0].outbox_id);
  assert.equal(again.status, 'already_done');

  const stats = brain.outbox.stats();
  assert.deepEqual(stats, [{ status: 'done', count: 1 }]);
  assert.equal(countRows(brain.db, 'events'), 1);
});

test('达到尝试上限 → dead + 告警，不再被 claim', async (t) => {
  const { brain, fc, alerts } = createBrain(t);
  await brain.ledger.ingestEvent(createEvent());
  const outboxId = (await brain.outbox.claim({ limit: 1 }))[0].outbox_id;
  brain.db.prepare('UPDATE outbox SET max_attempts = 2 WHERE outbox_id = ?').run(outboxId);

  await brain.outbox.fail(outboxId, new Error('失败一次'));
  fc.advance(10_000);
  const second = (await brain.outbox.claim({ limit: 1 }))[0];
  const dead = await brain.outbox.fail(second.outbox_id, new Error('失败两次'));

  assert.equal(dead.status, 'dead');
  assert.equal(brain.outbox.stats().find((item) => item.status === 'dead')?.count, 1);
  assert.equal(alerts.filter((item) => item.kind === 'outbox_dead').length, 1);
  assert.equal((await brain.outbox.claim({ limit: 1 })).length, 0, 'dead 不得被自动认领');

  const retried = await brain.outbox.retryDead(outboxId);
  assert.equal(retried.status, 'pending');
  assert.equal((await brain.outbox.claim({ limit: 1 })).length, 1, '人工重试后可再被认领');
});

test('崩溃恢复：in_progress 超时退回 pending', async (t) => {
  const { brain, fc } = createBrain(t);
  await brain.ledger.ingestEvent(createEvent());
  const claimed = (await brain.outbox.claim({ limit: 1 }))[0];
  assert.equal(claimed.attempts, 1);

  // 模拟进程在 claim 之后死掉：既不 complete 也不 fail。时间前进来判定超时。
  fc.advance(60_000);
  const recovered = await brain.outbox.recoverStale({ olderThanMs: 30_000 });
  assert.equal(recovered, 1);
  const row = /** @type {{ status?: string, last_error?: string }} */ (
    brain.db.prepare('SELECT status, last_error FROM outbox WHERE outbox_id = ?').get(claimed.outbox_id)
  );
  assert.equal(row.status, 'pending');
  assert.match(String(row.last_error), /stale/);

  fc.advance(1000);
  const again = await brain.outbox.claim({ limit: 1 });
  assert.equal(again.length, 1);
  assert.equal(again[0].attempts, 2, '崩溃恢复不重置尝试次数');
});

test('outbox 与事件同事务：重放不重复入队，也不丢工作项', async (t) => {
  const { brain } = createBrain(t);
  const first = await brain.ledger.ingestEvent(createEvent());
  const replay = await brain.ledger.ingestEvent(createEvent({ received_at: '2026-10-28T11:00:00.000Z' }));
  assert.equal(countRows(brain.db, 'outbox'), 1, '重放不得重复入队');
  assert.equal(replay.outbox_id, first.outbox_id);

  // 人为删掉 outbox（模拟旧版本/部分故障），重放应当把它补回来
  brain.db.prepare('DELETE FROM outbox').run();
  const replay2 = await brain.ledger.ingestEvent(createEvent({ received_at: '2026-10-28T12:00:00.000Z' }));
  assert.equal(countRows(brain.db, 'outbox'), 1, '重放必须补齐缺失的工作项');
  assert.equal(replay2.status, 'duplicate');
});

test('outbox 不存在的工作项：完成/失败都报 NOT_FOUND，不静默', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(() => brain.outbox.complete('obx_missing'), BrainError);
  await assert.rejects(() => brain.outbox.fail('obx_missing', new Error('x')), BrainError);
});
