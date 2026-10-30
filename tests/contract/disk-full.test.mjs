// @ts-check
/**
 * M1 门槛：磁盘满 / 写失败时**不虚报「已记住」**。
 *
 * 做法：用 `PRAGMA max_page_count` 把库限制在只多 2 页，再写入 200KB 内联片段，
 * SQLite 必然返回 `SQLITE_FULL`(13)。实测该错误会让 SQLite **自动回滚整个事务**
 * （`db.isTransaction` 变 false），因此这里同时验证队列的安全回滚与错误分类。
 */

import test from 'node:test';
import { assert, countRows, createBrain, createEvent } from './helpers.mjs';
import { StorageError } from '../../packages/core/src/index.js';

const UNLIMITED_PAGES = 1_073_741_823;
const BIG_TEXT = '满'.repeat(70_000); // UTF-8 下约 210KB

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function currentPageCount(db) {
  const row = /** @type {{ page_count?: number }} */ (db.prepare('PRAGMA page_count').get());
  return Number(row?.page_count ?? 0);
}

test('磁盘满：ingest 抛 STORAGE_FULL，事件/会话/outbox 零残留', async (t) => {
  const { brain } = createBrain(t);
  await brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-seed', source_seq: 1 }));
  const before = {
    events: countRows(brain.db, 'events'),
    sessions: countRows(brain.db, 'sessions'),
    outbox: countRows(brain.db, 'outbox'),
  };

  const limited = currentPageCount(brain.db) + 2;
  brain.db.exec(`PRAGMA max_page_count = ${limited}`);

  let error = null;
  try {
    await brain.ledger.ingestEvent(
      createEvent({ source_event_id: 'host-big', source_seq: 2, payload_text: BIG_TEXT }),
    );
  } catch (err) {
    error = err;
  }

  assert.ok(error instanceof StorageError, `应抛 StorageError，实际 ${String(error)}`);
  assert.equal(error.code, 'STORAGE_FULL', '磁盘满必须映射成 STORAGE_FULL');
  assert.equal(error.retriable, false);
  assert.equal('persisted' in error, false, '失败结果绝不能被当成「已记住」');
  assert.ok(error.cause, '必须保留底层 SQLite 错误作为 cause');
  assert.equal(/** @type {{ errcode?: number }} */ (error.cause).errcode, 13);

  assert.equal(countRows(brain.db, 'events'), before.events, '事件不得残留');
  assert.equal(countRows(brain.db, 'sessions'), before.sessions, '会话投影不得残留');
  assert.equal(countRows(brain.db, 'outbox'), before.outbox, 'outbox 不得残留孤儿工作项');
  assert.equal(brain.queue.stats().failed, 1);

  brain.db.exec(`PRAGMA max_page_count = ${UNLIMITED_PAGES}`);
});

test('磁盘满恢复空间后可以继续写入（不是永久坏掉）', async (t) => {
  const { brain } = createBrain(t);
  const limited = currentPageCount(brain.db) + 2;
  brain.db.exec(`PRAGMA max_page_count = ${limited}`);
  await assert.rejects(() =>
    brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-big', payload_text: BIG_TEXT })),
  );
  assert.equal(countRows(brain.db, 'events'), 0);

  brain.db.exec(`PRAGMA max_page_count = ${UNLIMITED_PAGES}`);
  const ok = await brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-small' }));
  assert.equal(ok.status, 'accepted');
  assert.equal(ok.persisted, true);
  assert.equal(countRows(brain.db, 'events'), 1);
  assert.equal(countRows(brain.db, 'outbox'), 1, 'outbox 必须与事件数一致');
});

test('磁盘满导致的自动回滚不会让队列卡死（后续事务正常提交）', async (t) => {
  const { brain } = createBrain(t);
  const limited = currentPageCount(brain.db) + 2;
  brain.db.exec(`PRAGMA max_page_count = ${limited}`);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await assert.rejects(() =>
      brain.ledger.ingestEvent(
        createEvent({ source_event_id: `host-fail-${attempt}`, payload_text: BIG_TEXT }),
      ),
    );
  }
  brain.db.exec(`PRAGMA max_page_count = ${UNLIMITED_PAGES}`);

  const results = await Promise.all([
    brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-a', source_seq: 1 })),
    brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-b', source_seq: 2 })),
  ]);
  assert.deepEqual(results.map((item) => item.status).sort(), ['accepted', 'accepted']);
  assert.equal(countRows(brain.db, 'events'), 2);
  assert.equal(countRows(brain.db, 'outbox'), 2);
  assert.equal(brain.queue.stats().failed, 3);
  assert.equal(brain.queue.isClosed(), false);
});
