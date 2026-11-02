// @ts-check
/**
 * M1 门槛：乱序到达保留原事件、按序修复投影。
 *
 * 语义约定（写进 docs/m1-notes.md）：
 * - 会话内 `source_seq` 从 1 开始连续；
 * - `consumer_offsets.last_source_seq` 是「连续已处理水位」；
 * - 缺口未补齐时消费停在缺口前，由 `repairGap` 显式放弃并留审计。
 */

import test from 'node:test';
import { assert, countRows, createBrain, createEvent } from './helpers.mjs';

const CONSUMER = 'projector';
const SCOPE = 'owner-default';
const SESSION = 'sess-1';

/**
 * @param {ReturnType<typeof createBrain>} ctx
 * @param {{ handler?: (event: import('../../packages/memory/src/ledger.js').EventRecord) => unknown, limit?: number }} [opts]
 */
function consume(ctx, opts = {}) {
  /** @type {number[]} */
  const seen = [];
  return ctx.brain.consumers
    .consume({
      consumer: CONSUMER,
      scope_id: SCOPE,
      session_id: SESSION,
      limit: opts.limit ?? 50,
      handler: (event) => {
        seen.push(event.source_seq);
        if (opts.handler) return opts.handler(event);
        return undefined;
      },
    })
    .then((result) => ({ result, seen }));
}

test('乱序到达：事件先保留，消费停在缺口前不越过', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-3', source_seq: 3 }));
  assert.equal(countRows(ctx.brain.db, 'events'), 1, '乱序事件必须保留');

  const { result, seen } = await consume(ctx);
  assert.equal(result.status, 'blocked_by_gap');
  assert.equal(result.expected_seq, 1);
  assert.equal(result.candidate_seq, 3);
  assert.deepEqual(seen, [], '缺口未补齐前不得处理更大的 seq');

  const offset = ctx.brain.consumers.getOffset({ consumer: CONSUMER, scope_id: SCOPE, session_id: SESSION });
  assert.equal(offset?.last_source_seq, 0, '水位不得越过缺口');
  assert.equal(offset?.status, 'blocked_by_gap');
  assert.equal(ctx.alerts.filter((item) => item.kind === 'consumer_gap').length, 1, '缺口必须告警');
});

test('补齐缺口后按 seq 顺序修复投影', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-3', source_seq: 3 }));
  await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-1', source_seq: 1 }));
  await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-2', source_seq: 2 }));

  const { result, seen } = await consume(ctx);
  assert.equal(result.status, 'processed');
  assert.deepEqual(seen, [1, 2, 3], '必须按 source_seq 升序处理');
  assert.equal(result.last_source_seq, 3);
  const offset = ctx.brain.consumers.getOffset({ consumer: CONSUMER, scope_id: SCOPE, session_id: SESSION });
  assert.equal(offset?.last_source_seq, 3);
  assert.equal(offset?.consumed_count, 3);
});

test('时钟时间不参与排序：occurred_at 与 seq 相反仍按 seq', async (t) => {
  const ctx = createBrain(t);
  // seq 2 的 occurred_at 最晚，seq 3 的最早 —— 排序必须看 seq
  await ctx.brain.ledger.ingestEvent(
    createEvent({ source_event_id: 'host-1', source_seq: 1, occurred_at: '2026-10-28T10:05:00.000Z' }),
  );
  await ctx.brain.ledger.ingestEvent(
    createEvent({ source_event_id: 'host-2', source_seq: 2, occurred_at: '2026-10-28T10:09:00.000Z' }),
  );
  await ctx.brain.ledger.ingestEvent(
    createEvent({ source_event_id: 'host-3', source_seq: 3, occurred_at: '2026-10-28T10:01:00.000Z' }),
  );
  const { seen } = await consume(ctx);
  assert.deepEqual(seen, [1, 2, 3]);
});

test('显式 repairGap：跳过缺口、推进水位、留审计，之后按序继续', async (t) => {
  const ctx = createBrain(t);
  for (const seq of [1, 2, 3, 5]) {
    await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: `host-${seq}`, source_seq: seq }));
  }
  const first = await consume(ctx);
  assert.deepEqual(first.seen, [1, 2, 3]);
  assert.equal(first.result.last_source_seq, 3);

  const blocked = await consume(ctx);
  assert.equal(blocked.result.status, 'blocked_by_gap');
  assert.equal(blocked.result.expected_seq, 4);

  const repaired = await ctx.brain.consumers.repairGap({
    consumer: CONSUMER,
    scope_id: SCOPE,
    session_id: SESSION,
    reason: '宿主确认 seq=4 丢失（连接器崩溃）',
    actor: 'tester',
  });
  assert.equal(repaired.status, 'repaired');
  assert.equal(repaired.from, 3);
  assert.equal(repaired.to, 4);
  assert.equal(repaired.skipped, 1);

  const audits = ctx.brain.ledger.listAudit({ action: 'consumer.gap_repaired' });
  assert.equal(audits.length, 1, '跳过缺口必须留审计');
  assert.match(String(audits[0].detail), /seq=4/);

  const resumed = await consume(ctx);
  assert.deepEqual(resumed.seen, [5]);
  assert.equal(resumed.result.last_source_seq, 5);
});

test('repairGap 必须给理由；没有缺口时是 no_gap', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-1', source_seq: 1 }));
  await assert.rejects(
    () => ctx.brain.consumers.repairGap({ consumer: CONSUMER, scope_id: SCOPE, session_id: SESSION, reason: '  ' }),
    /reason/,
  );

  const result = await ctx.brain.consumers.repairGap({
    consumer: CONSUMER,
    scope_id: SCOPE,
    session_id: SESSION,
    reason: '没有缺口的演练',
  });
  assert.equal(result.status, 'no_gap');
});

test('handler 失败不推进水位，重试后仍交付同一条', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-1', source_seq: 1 }));

  const failed = await consume(ctx, {
    handler: () => {
      throw new Error('投影失败');
    },
  });
  assert.equal(failed.result.status, 'failed');
  assert.equal(failed.result.attempts, 1);
  const offset = ctx.brain.consumers.getOffset({ consumer: CONSUMER, scope_id: SCOPE, session_id: SESSION });
  assert.equal(offset?.last_source_seq, 0, 'handler 失败不得推进水位');

  const retried = await consume(ctx);
  assert.equal(retried.result.status, 'processed');
  assert.deepEqual(retried.seen, [1]);
  assert.equal(
    ctx.brain.consumers.getOffset({ consumer: CONSUMER, scope_id: SCOPE, session_id: SESSION })?.attempts,
    0,
    '成功后尝试计数清零',
  );
});

test('handler 失败达上限 → consumer dead，不静默跳过', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-1', source_seq: 1 }));
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    last = await ctx.brain.consumers.consume({
      consumer: CONSUMER,
      scope_id: SCOPE,
      session_id: SESSION,
      maxAttempts: 3,
      handler: () => {
        throw new Error('永远失败');
      },
    });
  }
  assert.equal(last.status, 'dead');
  assert.equal(
    ctx.brain.consumers.getOffset({ consumer: CONSUMER, scope_id: SCOPE, session_id: SESSION })?.status,
    'dead',
  );
  assert.equal(ctx.alerts.filter((item) => item.kind === 'consumer_dead').length, 1);
  assert.equal(ctx.brain.ledger.listAudit({ action: 'consumer.dead_letter' }).length, 1);
});

test('at-least-once：重置水位后同一事件会再次交付（handler 必须幂等）', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-1', source_seq: 1 }));

  /** @type {string[]} */
  const handled = [];
  const run = () =>
    ctx.brain.consumers.consume({
      consumer: CONSUMER,
      scope_id: SCOPE,
      session_id: SESSION,
      handler: (event) => handled.push(event.event_id),
    });
  await run();
  assert.equal(handled.length, 1);

  // 不推进水位的情况（模拟 offset 提交丢失）：重置后重放
  await ctx.brain.consumers.resetOffset({ consumer: CONSUMER, scope_id: SCOPE, session_id: SESSION });
  await run();
  assert.equal(handled.length, 2, 'at-least-once：同一事件可能再次交付');
  assert.equal(handled[0], handled[1], '重放的是同一条事件');
});
