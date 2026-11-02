// @ts-check
/**
 * M1 契约：备份/恢复骨架（一致性快照 + 校验清单 + 隔离恢复 + 不覆盖有效备份）。
 */

import test from 'node:test';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assert, countRows, createBrain, createEvent, insertMemory } from './helpers.mjs';
import { DatabaseSync } from 'node:sqlite';
import { BackupError } from '../../packages/core/src/index.js';
import { createBackupService, inspectSnapshotFile, lastSnapshotId } from '../../packages/memory/src/backup.js';

test('一致性快照：文件落位、校验清单完整、verify 通过', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-1', source_seq: 1 }));
  await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-2', source_seq: 2 }));

  const snapshot = await ctx.brain.backup.createSnapshot({ kind: 'manual' });
  assert.equal(snapshot.status, 'verified');
  assert.ok(existsSync(snapshot.path));
  assert.match(snapshot.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(snapshot.byte_size, statSync(snapshot.path).size);
  assert.equal(snapshot.checklist.table_counts.events, 2);
  assert.equal(snapshot.checklist.integrity_check, 'ok');
  // schema_version 动态取当前库版本（M2 加 0002 后不再是字面量 '0001'）。
  // 这里要断言的是「备份清单记录的版本 == 备份时库的版本」，不是某个具体版本号。
  assert.equal(snapshot.checklist.schema_version, ctx.brain.schemaVersion);
  assert.equal(snapshot.checklist.source_watermark, 2);
  assert.equal(snapshot.checklist.deletion_epoch, 0);
  assert.match(snapshot.checklist.created_at_local, /\+08:00$/);

  const record = /** @type {Record<string, unknown>} */ (
    ctx.brain.db.prepare('SELECT * FROM backups WHERE backup_id = ?').get(snapshot.backup_id)
  );
  assert.equal(record.status, 'verified');
  assert.equal(record.sha256, snapshot.sha256);
  assert.ok(record.checklist_hash);
  assert.ok(record.verified_at);

  const verification = await ctx.brain.backup.verifySnapshot({ backup_id: snapshot.backup_id });
  assert.equal(verification.ok, true, JSON.stringify(verification.checks));
  assert.deepEqual(
    verification.checks.map((check) => check.name).sort(),
    ['deletion_epoch', 'file_exists', 'integrity_check', 'sha256', 'table_counts'],
  );
  assert.equal(lastSnapshotId(ctx.brain.db), snapshot.backup_id);
});

test('快照是独立可打开的一致性副本（表计数与主账一致）', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent({ source_event_id: 'host-1', source_seq: 1 }));
  const snapshot = await ctx.brain.backup.createSnapshot();
  const inspected = inspectSnapshotFile(snapshot.path);
  assert.equal(inspected.table_counts.events, countRows(ctx.brain.db, 'events'));
  assert.equal(inspected.table_counts.sessions, countRows(ctx.brain.db, 'sessions'));
  assert.equal(inspected.table_counts.outbox, countRows(ctx.brain.db, 'outbox'));
  // 快照由运行时 node:sqlite 写出，SQLite 版本随 node 版本变（本机 v22.22.2 → 3.51.2），
  // 不能写死字面量。断言「快照里读到的版本 == 当前运行时的 SQLite 版本」：
  // 跨 node 版本都稳定，且仍能证明快照是当前引擎写出、可被当前引擎读出。
  const runtimeDb = new DatabaseSync(':memory:');
  let runtimeSqliteVersion;
  try {
    const versionRow = /** @type {{ v?: string } | undefined} */ (
      runtimeDb.prepare('SELECT sqlite_version() AS v').get()
    );
    runtimeSqliteVersion = String(versionRow?.v ?? '');
  } finally {
    runtimeDb.close();
  }
  assert.match(runtimeSqliteVersion, /^\d+\.\d+\.\d+$/, '必须能读到运行时 SQLite 版本');
  assert.equal(inspected.sqlite_version, runtimeSqliteVersion);

  // 快照里的事件正文可读
  const copy = new DatabaseSync(snapshot.path, { readOnly: true });
  try {
    const row = /** @type {{ payload_text?: string } | undefined} */ (
      copy.prepare("SELECT payload_text FROM events WHERE source_event_id = 'host-1'").get()
    );
    assert.equal(row?.payload_text, '第 1 条消息');
  } finally {
    copy.close();
  }
});

test('篡改快照字节 → verify 失败（哈希与清单比对）', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent());
  const snapshot = await ctx.brain.backup.createSnapshot();

  const original = readFileSync(snapshot.path);
  writeFileSync(snapshot.path, Buffer.concat([original, Buffer.from('tampered')]));

  const verification = await ctx.brain.backup.verifySnapshot({ backup_id: snapshot.backup_id });
  assert.equal(verification.ok, false);
  const shaCheck = verification.checks.find((check) => check.name === 'sha256');
  assert.equal(shaCheck?.ok, false);
});

test('备份失败不覆盖上一份有效文件，并留下 failed 记录', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent());
  const good = await ctx.brain.backup.createSnapshot({ kind: 'manual' });
  const goodContent = readFileSync(good.path);
  const beforeRows = countRows(ctx.brain.db, 'backups');

  const failing = createBackupService({
    db: ctx.brain.db,
    dbPath: ctx.brain.dbPath,
    queue: ctx.brain.queue,
    clock: ctx.brain.clock,
    backupDir: ctx.backupDir,
    backupImpl: async () => {
      throw new Error('注入的备份失败');
    },
  });

  await assert.rejects(() => failing.createSnapshot({ kind: 'manual' }), (err) => {
    assert.ok(err instanceof BackupError);
    return true;
  });

  assert.ok(existsSync(good.path), '上一份有效备份必须仍在');
  assert.deepEqual(readFileSync(good.path), goodContent, '上一份有效备份内容不得被改写');
  assert.equal(countRows(ctx.brain.db, 'backups'), beforeRows + 1);
  const failedRow = /** @type {{ status?: string } | undefined} */ (
    ctx.brain.db.prepare("SELECT status FROM backups WHERE status = 'failed'").get()
  );
  assert.equal(failedRow?.status, 'failed');
  const verified = await ctx.brain.backup.verifySnapshot({ backup_id: good.backup_id });
  assert.equal(verified.ok, true, '失败的新备份不得影响旧备份的可恢复性');
});

test('恢复拒绝覆盖当前活跃数据库', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent());
  const snapshot = await ctx.brain.backup.createSnapshot();
  await assert.rejects(
    () => ctx.brain.backup.restoreSnapshot({ backup_id: snapshot.backup_id, targetPath: ctx.dbPath }),
    (err) => {
      assert.ok(err instanceof BackupError);
      assert.equal(err.code, 'RESTORE_REFUSED');
      return true;
    },
  );
});

test('恢复到隔离路径：副本可用，并如实报告删除账本限制', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent({ payload_text: '备份前的内容' }));
  const snapshot = await ctx.brain.backup.createSnapshot();

  // 备份之后又发生删除 → 快照的 deletion_epoch 落后于当前主账
  insertMemory(ctx.brain.db, { id: 'mem_1' });
  await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: 'mem_1',
    scope_id: 'owner-default',
    reason: '备份后删除',
  });

  const target = path.join(ctx.dir, 'restored', 'brain-restored.db');
  const restored = await ctx.brain.backup.restoreSnapshot({ backup_id: snapshot.backup_id, targetPath: target });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.requires_restart, true);
  assert.equal(restored.safe_to_promote, false, 'M1 没有独立删除账本，恢复实例不得自动上线');
  const codes = restored.warnings.map((warning) => warning.code);
  assert.ok(codes.includes('STALE_DELETION_LEDGER'), '必须报告删除纪元落后');
  assert.ok(codes.includes('DELETE_LEDGER_NOT_EXTERNAL'));

  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    const row = /** @type {{ integrity_check?: string }} */ (copy.prepare('PRAGMA integrity_check').get());
    assert.equal(row.integrity_check, 'ok');
    const count = /** @type {{ n?: number }} */ (copy.prepare('SELECT COUNT(*) AS n FROM events').get());
    assert.equal(Number(count.n), 1);
  } finally {
    copy.close();
  }
});

test('快照 epoch 不低于当前时没有 STALE 警告（但仍有账本限制声明）', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent());
  const snapshot = await ctx.brain.backup.createSnapshot();
  const target = path.join(ctx.dir, 'restored2', 'brain.db');
  const restored = await ctx.brain.backup.restoreSnapshot({ backup_id: snapshot.backup_id, targetPath: target });
  assert.equal(restored.warnings.some((warning) => warning.code === 'STALE_DELETION_LEDGER'), false);
  assert.equal(restored.safe_to_promote, false);
});

test('目标已存在时必须显式 allowOverwrite 才覆盖', async (t) => {
  const ctx = createBrain(t);
  await ctx.brain.ledger.ingestEvent(createEvent());
  const snapshot = await ctx.brain.backup.createSnapshot();
  const target = path.join(ctx.dir, 'restored3', 'brain.db');
  await ctx.brain.backup.restoreSnapshot({ backup_id: snapshot.backup_id, targetPath: target });
  await assert.rejects(
    () => ctx.brain.backup.restoreSnapshot({ backup_id: snapshot.backup_id, targetPath: target }),
    (err) => {
      assert.ok(err instanceof BackupError);
      assert.equal(err.code, 'RESTORE_REFUSED');
      return true;
    },
  );
  const again = await ctx.brain.backup.restoreSnapshot({
    backup_id: snapshot.backup_id,
    targetPath: target,
    allowOverwrite: true,
  });
  assert.equal(again.status, 'restored');
});
