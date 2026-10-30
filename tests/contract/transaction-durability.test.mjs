// @ts-check
/**
 * M1 门槛：事务原子性、单写入队列、写失败不虚报、已 ACK 不丢。
 */

import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { assert, countRows, createBrain, createEvent } from './helpers.mjs';
import { openDatabase } from '../../packages/memory/src/db.js';
import { BrainError, QueueClosedError, deriveEventId } from '../../packages/core/src/index.js';

test('事件 + 会话 + outbox 同事务：中途抛错三表全无', async (t) => {
  const { brain } = createBrain(t);
  const eventId = deriveEventId({ source_system: 'dsh', scope_id: 'owner-default', source_event_id: 'host-x' });

  await assert.rejects(
    () =>
      brain.queue.write(
        (tx) => {
          tx.run(
            `INSERT INTO events (
               event_id, source_system, source_event_id, scope_id, person_id, session_id,
               source_seq, event_type, origin_system, payload_ref, payload_hash, privacy,
               occurred_at, occurred_at_local, received_at, received_at_local, time_zone,
               content_fingerprint, created_at, created_at_local
             ) VALUES (?, 'dsh', 'host-x', 'owner-default', 'owner', 'sess-x', 1, 'user/message', 'human',
               'inline:x', 'sha256:x', 'private',
               '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00',
               '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00', 'Asia/Shanghai',
               'sha256:y', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00')`,
            [eventId],
          );
          tx.run(
            `INSERT INTO sessions (session_id, scope_id, person_id, source_system, created_at, created_at_local, updated_at, updated_at_local)
             VALUES ('sess-x', 'owner-default', 'owner', 'dsh', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00')`,
          );
          tx.run(
            `INSERT INTO outbox (outbox_id, kind, dedupe_key, created_at, created_at_local, updated_at, updated_at_local)
             VALUES ('obx_x', 'project_event', 'event:x:project', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00')`,
          );
          throw new Error('第三步之后失败');
        },
        { label: 'test.atomic' },
      ),
    /第三步之后失败/,
  );

  assert.equal(countRows(brain.db, 'events'), 0);
  assert.equal(countRows(brain.db, 'sessions'), 0);
  assert.equal(countRows(brain.db, 'outbox'), 0);
  assert.equal(brain.queue.stats().failed, 1);
});

test('ingest 的 outbox 步骤失败 → 整个事务回滚，不虚报「已记住」', async (t) => {
  const { brain } = createBrain(t);

  // 用 trigger 让 outbox 插入失败，模拟「写 outbox 时数据库出问题」
  brain.db.exec(
    `CREATE TRIGGER simulate_outbox_failure BEFORE INSERT ON outbox
     BEGIN SELECT RAISE(ABORT, 'simulated outbox failure'); END;`,
  );

  let error = null;
  try {
    await brain.ledger.ingestEvent(createEvent());
  } catch (err) {
    error = err;
  }
  assert.ok(error !== null, '写入失败必须 reject');
  assert.equal(error.code, 'STORAGE_ERROR', '约束失败映射成存储错误，不得伪装成功');
  assert.equal('persisted' in error, false, '失败结果上不能有任何已持久化标记');

  assert.equal(countRows(brain.db, 'events'), 0, '事件必须随事务一起回滚');
  assert.equal(countRows(brain.db, 'sessions'), 0, '会话投影必须回滚');
  assert.equal(countRows(brain.db, 'outbox'), 0, 'outbox 不得留下孤儿工作项');
  assert.equal(brain.queue.stats().failed, 1);

  // 故障消失后，同一事件可以正常写入（不是永久坏掉）
  brain.db.exec('DROP TRIGGER simulate_outbox_failure');
  const recovered = await brain.ledger.ingestEvent(createEvent());
  assert.equal(recovered.status, 'accepted');
  assert.equal(recovered.persisted, true);
  assert.equal(countRows(brain.db, 'events'), 1);
  assert.equal(countRows(brain.db, 'outbox'), 1);
});

test('单写入队列：并发 30 个写事务，同一时刻最多 1 个在跑', async (t) => {
  const { brain } = createBrain(t);
  /** @type {number[]} */
  const tick = [];
  let inFlight = 0;
  let maxInFlight = 0;

  await Promise.all(
    Array.from({ length: 30 }, (_item, index) =>
      brain.queue.write(
        (tx) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          tick.push(index);
          tx.run(
            `INSERT INTO audit_logs (audit_id, ts, ts_local, actor, action, detail)
             VALUES (?, '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00', 'test', 'queue.check', ?)`,
            [`aud_q_${index}`, JSON.stringify({ index })],
          );
          inFlight -= 1;
        },
        { label: `test.queue.${index}` },
      ),
    ),
  );

  assert.equal(maxInFlight, 1, '写入必须串行');
  assert.equal(countRows(brain.db, 'audit_logs'), 30);
  assert.equal(brain.queue.stats().maxActiveWrites, 1, '同时执行的事务数必须恒为 1');
  assert.equal(brain.queue.stats().maxPending, 30, '30 个写请求确实同时排进了队列（这正说明需要串行化）');
  assert.equal(brain.queue.stats().pending, 0);
  assert.equal(brain.queue.stats().completed, 30);
});

test('事务回调返回 Promise → WRITE_ASYNC_FORBIDDEN，且半成品被回滚', async (t) => {
  const { brain } = createBrain(t);
  let captured = null;
  try {
    await brain.queue.write(
      // @ts-expect-error 故意在事务里返回 async 函数
      async (tx) => {
        tx.run(
          `INSERT INTO audit_logs (audit_id, ts, ts_local, actor, action)
           VALUES ('aud_async', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00', 'test', 'async')`,
        );
      },
      { label: 'test.async' },
    );
  } catch (err) {
    captured = err;
  }
  assert.ok(captured instanceof BrainError);
  assert.equal(captured.code, 'WRITE_ASYNC_FORBIDDEN');
  assert.equal(countRows(brain.db, 'audit_logs'), 0, '异步回调里的写入必须被回滚');
});

test('已 ACK 的写入在重新打开后仍在（崩溃重启不丢）', async (t) => {
  const { brain, dbPath } = createBrain(t);
  const result = await brain.ledger.ingestEvent(createEvent());
  await brain.queue.drain();
  brain.db.close();

  const reopened = openDatabase({ path: dbPath });
  try {
    const row = /** @type {{ payload_text?: string } | undefined} */ (
      reopened.db.prepare('SELECT payload_text FROM events WHERE event_id = ?').get(result.event_id)
    );
    assert.equal(row?.payload_text, '第 1 条消息');
    assert.equal(reopened.pragmas.journal_mode, 'wal', 'WAL 标志必须持久化');
  } finally {
    reopened.db.close();
  }
});

test('写失败后队列继续可用；关闭后拒绝新写入', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(() =>
    brain.queue.write(() => {
      throw new Error('故意失败');
    }),
  );
  const ok = await brain.queue.write((tx) => {
    tx.run(
      `INSERT INTO audit_logs (audit_id, ts, ts_local, actor, action)
       VALUES ('aud_after_fail', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00', 'test', 'recover')`,
    );
    return 'recovered';
  });
  assert.equal(ok, 'recovered');

  await brain.queue.close({ timeoutMs: 5000 });
  await assert.rejects(
    () => brain.queue.write(() => 'nope'),
    (err) => {
      assert.ok(err instanceof QueueClosedError);
      assert.equal(err.code, 'QUEUE_CLOSED');
      return true;
    },
  );
});

test('固定时钟不影响提交语义：ack_at 不早于 received_at', async (t) => {
  const { brain, fc } = createBrain(t);
  const result = await brain.ledger.ingestEvent(
    createEvent({ received_at: fc.nowIso() }),
  );
  assert.ok(Date.parse(result.ack_at) >= Date.parse(fc.nowIso()));
});
