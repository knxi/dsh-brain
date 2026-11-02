// @ts-check
/**
 * M1 门槛：相同源 ID 重放不重复写入；同键不同正文 = 冲突，禁止静默覆盖。
 */

import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { assert, DEFAULT_BINDINGS, countRows, createBrain, createEvent } from './helpers.mjs';
import { ConflictError, deriveEventId } from '../../packages/core/src/index.js';

test('首次摄取：事件 + 会话投影 + outbox 同一事务落盘', async (t) => {
  const { brain } = createBrain(t);
  const result = await brain.ledger.ingestEvent(createEvent());

  assert.equal(result.status, 'accepted');
  assert.equal(result.persisted, true);
  assert.equal(result.duplicate, false);
  assert.match(result.event_id, /^evt_[0-9a-f]{32}$/);
  assert.equal(
    result.event_id,
    deriveEventId({ source_system: 'dsh', scope_id: 'owner-default', source_event_id: 'host-1' }),
    'event_id 必须由唯一键稳定派生',
  );

  assert.equal(countRows(brain.db, 'events'), 1);
  assert.equal(countRows(brain.db, 'outbox'), 1);
  assert.equal(countRows(brain.db, 'sessions'), 1);

  const session = brain.ledger.getSession('sess-1');
  assert.equal(Number(session?.last_source_seq), 1);
  assert.equal(Number(session?.event_count), 1);
  assert.match(String(session?.created_at), /Z$/);
  assert.match(String(session?.created_at_local), /\+08:00$/, '所有时间必须 UTC + 本地时区双存');

  const event = brain.ledger.readEvent(result.event_id);
  assert.equal(event?.payload_text, '第 1 条消息');
  assert.equal(event?.deletion_epoch, 0);
  assert.match(String(event?.occurred_at_local), /\+08:00$/);
  assert.equal(event?.content_fingerprint, result.content_fingerprint);
});

test('相同源 ID 重放：不重复写入、不新增 outbox，仍返回已持久化', async (t) => {
  const { brain, fc } = createBrain(t);
  const first = await brain.ledger.ingestEvent(createEvent());
  fc.advance(5000);
  const replay = await brain.ledger.ingestEvent(
    createEvent({ received_at: '2026-10-28T10:00:30.000Z' }),
  );

  assert.equal(replay.status, 'duplicate');
  assert.equal(replay.persisted, true);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.event_id, first.event_id);
  assert.equal(countRows(brain.db, 'events'), 1);
  assert.equal(countRows(brain.db, 'outbox'), 1);
  assert.equal(countRows(brain.db, 'sessions'), 1);
  assert.ok(Date.parse(replay.ack_at) >= Date.parse(first.ack_at));
});

test('同键不同正文 → EVENT_CONFLICT，原记录不被覆盖', async (t) => {
  const { brain } = createBrain(t);
  const accepted = await brain.ledger.ingestEvent(createEvent());

  let error = null;
  try {
    await brain.ledger.ingestEvent(createEvent({ payload_text: '改口：周一交图' }));
  } catch (err) {
    error = err;
  }
  assert.ok(error instanceof ConflictError, '必须抛 ConflictError');
  assert.equal(error.code, 'EVENT_CONFLICT');
  assert.equal(error.info.event_id, accepted.event_id);
  assert.notEqual(error.info.stored_payload_hash, error.info.incoming_payload_hash);
  assert.equal('persisted' in error, false, '冲突错误绝不能带 persisted 标记');

  assert.equal(countRows(brain.db, 'events'), 1);
  const stored = brain.ledger.readEvent(accepted.event_id);
  assert.equal(stored?.payload_text, '第 1 条消息', '原正文必须保持不变');

  const audits = brain.ledger.listAudit({ action: 'event.conflict' });
  assert.equal(audits.length, 1, '冲突必须留审计');
  assert.doesNotMatch(String(audits[0].detail), /周一交图/, '审计不得记录正文');
});

test('event_id 撞车（宿主自定义 ID）→ 冲突，不覆盖已有事件', async (t) => {
  const { brain } = createBrain(t);
  const customId = 'host-defined-event-id';
  await brain.ledger.ingestEvent(createEvent({ event_id: customId }));

  await assert.rejects(
    () =>
      brain.ledger.ingestEvent(
        createEvent({ event_id: customId, source_event_id: 'host-different', payload_text: '另一条' }),
      ),
    (err) => {
      assert.ok(err instanceof ConflictError);
      assert.equal(err.info.event_id, customId);
      return true;
    },
  );
  assert.equal(countRows(brain.db, 'events'), 1);
});

test('正文里的 scope/person 伪造被连接器绑定覆盖', async (t) => {
  const { brain } = createBrain(t);
  const result = await brain.ledger.ingestEvent(
    createEvent({ scope_id: 'other-scope', person_id: 'intruder', source_system: 'evil' }),
  );
  const stored = brain.ledger.readEvent(result.event_id);
  assert.equal(stored?.scope_id, DEFAULT_BINDINGS.scope_id);
  assert.equal(stored?.person_id, DEFAULT_BINDINGS.person_id);
  assert.equal(stored?.source_system, DEFAULT_BINDINGS.source_system);
  assert.equal(String(brain.ledger.getSession('sess-1')?.scope_id), DEFAULT_BINDINGS.scope_id);
  assert.equal(countRows(brain.db, 'events'), 1);
});

test('ACK 只在提交后：另一连接看得到已提交事件，看不到未提交写入', async (t) => {
  const { brain, dbPath } = createBrain(t);
  const result = await brain.ledger.ingestEvent(createEvent());

  const observer = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const committed = /** @type {{ n?: number }} */ (
      observer.prepare('SELECT COUNT(*) AS n FROM events WHERE event_id = ?').get(result.event_id)
    );
    assert.equal(Number(committed.n), 1, '已 ACK 的事件必须对其它连接可见');
  } finally {
    observer.close();
  }

  // 未提交的写入对其它连接不可见（WAL 隔离），也不应出现在本连接的事务外
  brain.db.exec('BEGIN IMMEDIATE');
  brain.db.prepare("INSERT INTO audit_logs (audit_id, ts, ts_local, actor, action) VALUES ('aud_pending', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00', 'test', 'pending')").run();
  const observer2 = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const invisible = /** @type {{ n?: number }} */ (
      observer2.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE audit_id = 'aud_pending'").get()
    );
    assert.equal(Number(invisible.n), 0, '未提交数据不能被读连接看到');
  } finally {
    observer2.close();
    brain.db.exec('ROLLBACK');
  }
});

test('会话投影：last_source_seq 只增不减（乱序到达不倒退）', async (t) => {
  const { brain } = createBrain(t);
  await brain.ledger.ingestEvent(createEvent({ source_seq: 5, source_event_id: 'host-5' }));
  await brain.ledger.ingestEvent(createEvent({ source_seq: 2, source_event_id: 'host-2' }));

  const session = brain.ledger.getSession('sess-1');
  assert.equal(Number(session?.last_source_seq), 5);
  assert.equal(Number(session?.event_count), 2);
  assert.equal(countRows(brain.db, 'events'), 2, '乱序到达的事件也必须保留');
});
