// @ts-check
/**
 * M1 契约：PRAGMA 部署配置的**实测**行为。
 * 这里的断言就是 `docs/m1-notes.md` 里那张表的代码证据。
 */

import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, createBrain } from './helpers.mjs';
import { DEFAULT_PRAGMAS, integrityCheck, openDatabase, readPragmas } from '../../packages/memory/src/db.js';
import { StorageError } from '../../packages/core/src/index.js';

test('部署 PRAGMA 实测值：WAL / FULL / busy_timeout / foreign_keys', (t) => {
  const { brain } = createBrain(t);
  const pragmas = brain.readPragmas();
  assert.equal(pragmas.journal_mode, 'wal');
  assert.equal(pragmas.synchronous, 2, 'PRAGMA synchronous 读回 2 = FULL');
  assert.equal(pragmas.busy_timeout, 5000, 'node:sqlite 默认 busy_timeout 是 0，必须显式设置');
  assert.equal(pragmas.foreign_keys, 1);
  assert.equal(pragmas.temp_store, 2, '2 = MEMORY');
  assert.equal(pragmas.wal_autocheckpoint, 1000);
  assert.equal(DEFAULT_PRAGMAS.journal_mode, 'WAL');
  assert.equal(DEFAULT_PRAGMAS.synchronous, 'FULL');
  assert.equal(brain.integrityCheck(), 'ok');
  assert.equal(integrityCheck(brain.db), 'ok');
});

test('WAL 标志写入文件头：重新打开仍是 WAL + FULL', (t) => {
  const { brain, dbPath } = createBrain(t);
  brain.db.close();
  const reopened = openDatabase({ path: dbPath });
  try {
    const pragmas = readPragmas(reopened.db);
    assert.equal(pragmas.journal_mode, 'wal');
    assert.equal(pragmas.synchronous, 2);
    assert.equal(pragmas.busy_timeout, 5000);
  } finally {
    reopened.db.close();
  }
});

test('busy_timeout 生效：锁冲突在超时后抛 SQLITE_BUSY，且被分类为可重试', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-busy-'));
  const dbPath = path.join(dir, 'busy.db');
  const writer = openDatabase({ path: dbPath });
  writer.db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');

  const contender = openDatabase({ path: dbPath, pragmas: { busy_timeout: 120 } });
  try {
    writer.db.exec('BEGIN IMMEDIATE');
    writer.db.prepare('INSERT INTO t (id, v) VALUES (1, ?)').run('holder');

    const started = Date.now();
    let error = null;
    try {
      contender.db.prepare('INSERT INTO t (id, v) VALUES (2, ?)').run('contender');
    } catch (err) {
      error = err;
    }
    const waited = Date.now() - started;

    assert.ok(error !== null, '写锁被占时必须抛错，而不是静默成功');
    assert.equal(/** @type {{ errcode?: number }} */ (error).errcode, 5, 'SQLITE_BUSY = 5');
    assert.ok(waited >= 100, `busy_timeout 应至少等待约 120ms，实际 ${waited}ms`);
    const classified = StorageError.classify(error);
    assert.equal(classified.code, 'STORAGE_BUSY');
    assert.equal(classified.retriable, true);

    writer.db.exec('COMMIT');
    contender.db.prepare('INSERT INTO t (id, v) VALUES (3, ?)').run('after-release');
    const row = /** @type {{ n?: number }} */ (contender.db.prepare('SELECT COUNT(*) AS n FROM t').get());
    assert.equal(Number(row.n), 2);
  } finally {
    try {
      writer.db.close();
    } catch {
      /* ignore */
    }
    try {
      contender.db.close();
    } catch {
      /* ignore */
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('内存库允许非 WAL（requireWal 只约束文件库）', () => {
  const opened = openDatabase({ path: ':memory:' });
  try {
    assert.equal(opened.pragmas.journal_mode, 'memory');
    assert.equal(opened.pragmas.synchronous, 2);
  } finally {
    opened.db.close();
  }
});

test('只读打开：可读、不可写、不跑 PRAGMA 写配置', async (t) => {
  const { brain, dbPath } = createBrain(t);
  await brain.ledger.ingestEvent({
    source_event_id: 'host-ro',
    session_id: 'sess-ro',
    source_seq: 1,
    event_type: 'user/message',
    occurred_at: '2026-10-28T10:00:00.000Z',
    payload_text: 'x',
  });
  brain.db.close();

  const readOnly = openDatabase({ path: dbPath, readOnly: true });
  try {
    assert.equal(readOnly.readOnly, true);
    const count = /** @type {{ n?: number }} */ (readOnly.db.prepare('SELECT COUNT(*) AS n FROM events').get());
    assert.equal(Number(count.n), 1);
    let error = null;
    try {
      readOnly.db
        .prepare(
          "INSERT INTO audit_logs (audit_id, ts, ts_local, actor, action) VALUES ('x', 'y', 'z', 'a', 'b')",
        )
        .run();
    } catch (err) {
      error = err;
    }
    assert.ok(error !== null, '只读连接必须拒绝写入');
    const classified = StorageError.classify(error);
    assert.ok(
      ['STORAGE_READONLY', 'STORAGE_PERMISSION', 'STORAGE_ERROR'].includes(classified.code),
      `只读错误分类异常：${classified.code}`,
    );
  } finally {
    readOnly.db.close();
  }
});

test('foreign_keys 生效：跨表引用错误在写入层就失败', (t) => {
  const { brain } = createBrain(t);
  let error = null;
  try {
    brain.db
      .prepare(
        `INSERT INTO memory_versions (memory_id, version, status, privacy, changed_by, created_at, created_at_local)
         VALUES ('mem_missing', 1, 'active', 'private', 'test', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00')`,
      )
      .run();
  } catch (err) {
    error = err;
  }
  assert.ok(error !== null, '外键约束必须阻止孤儿版本行');
  assert.equal(/** @type {{ errcode?: number }} */ (error).errcode, 787, 'FOREIGN KEY constraint failed = 787');
});
