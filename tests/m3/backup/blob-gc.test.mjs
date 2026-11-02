// @ts-check
/**
 * M3：blob 内容寻址存储与 GC（清单引用必须护住、读者未完成不许回收）。
 */

import test from 'node:test';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { assert, CORPUS, createBrain, seedMemories } from './helpers.mjs';
import {
  blobStoragePath,
  collectBackupReferencedBlobs,
  collectReferencedBlobs,
  createBackup,
  createBlobReaderGuard,
  listBlobFiles,
  linkBlobRef,
  planBlobGc,
  readBlob,
  runBlobGc,
  writeBlob,
} from '../../../packages/memory/src/backup.js';
import { runInTransaction } from '../../../packages/memory/src/write-queue.js';

test('writeBlob：文件名就是内容哈希，写入幂等，读回校验', async (t) => {
  const ctx = createBrain(t);
  const first = writeBlob({ blobsDir: ctx.blobsDir, content: '图号 JS-2026-017 的附件', db: ctx.brain.db, clock: ctx.fc.clock });
  const second = writeBlob({ blobsDir: ctx.blobsDir, content: '图号 JS-2026-017 的附件', db: ctx.brain.db, clock: ctx.fc.clock });

  assert.equal(first.hash, second.hash, '同内容必须得到同一 hash');
  assert.equal(first.existed, false);
  assert.equal(second.existed, true, '第二次写入不应重复建文件');
  assert.equal(first.metadataRecorded, true);
  assert.ok(existsSync(blobStoragePath(ctx.blobsDir, first.hash)));
  const roundTrip = readBlob({ blobsDir: ctx.blobsDir, hash: first.hash });
  assert.equal(roundTrip.toString('utf8'), '图号 JS-2026-017 的附件');

  // 内容被改 → 读回必须报错，而不是把错误内容当正确的
  writeFileSync(blobStoragePath(ctx.blobsDir, first.hash), 'evil');
  assert.throws(() => readBlob({ blobsDir: ctx.blobsDir, hash: first.hash }), /hash/);
});

test('引用集：blob_refs / events.payload_ref / source_refs.doc_ref 都算引用', async (t) => {
  const ctx = createBrain(t);
  const blob = writeBlob({ blobsDir: ctx.blobsDir, content: '引用集内容', db: ctx.brain.db, clock: ctx.fc.clock });
  await runInTransaction(ctx.brain.db, (tx) =>
    linkBlobRef({ tx, hash: blob.hash, ownerKind: 'event', ownerId: 'evt-1', clock: ctx.fc.clock }),
  );
  let referenced = collectReferencedBlobs(ctx.brain.db);
  assert.ok(referenced.has(blob.hash), 'blob_refs 必须算进引用集');

  // 删掉显式引用，但事件 payload_ref 还指向它 → 仍算引用
  ctx.brain.db.prepare('DELETE FROM blob_refs').run();
  ctx.brain.db
    .prepare(
      `INSERT INTO events (
         event_id, source_system, source_event_id, scope_id, person_id, session_id,
         source_seq, event_type, origin_system, payload_ref, payload_hash, privacy,
         occurred_at, occurred_at_local, received_at, received_at_local, time_zone,
         content_fingerprint, created_at, created_at_local
       ) VALUES ('evt_blob', 'dsh', 'host-blob', 'owner-default', 'owner', 'sess-blob', 1, 'tool/result', 'tool',
         ?, 'sha256:x', 'private',
         '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00',
         '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00', 'Asia/Shanghai',
         'sha256:y', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00')`,
    )
    .run(`blob:${blob.hash}`);
  referenced = collectReferencedBlobs(ctx.brain.db);
  assert.ok(referenced.has(blob.hash), 'payload_ref 里的 blob: 引用必须算进引用集');
});

test('GC：孤儿被删；被引用 / 被备份清单引用的 blob 保留', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  const orphan = writeBlob({ blobsDir: ctx.blobsDir, content: '没有任何引用的孤儿', db: ctx.brain.db, clock: ctx.fc.clock });
  const referenced = writeBlob({ blobsDir: ctx.blobsDir, content: '被记忆引用的附件', db: ctx.brain.db, clock: ctx.fc.clock });
  await runInTransaction(ctx.brain.db, (tx) =>
    linkBlobRef({ tx, hash: referenced.hash, ownerKind: 'event', ownerId: 'evt-keep', clock: ctx.fc.clock }),
  );

  const backup = await createBackup({
    db: ctx.brain.db,
    outDir: ctx.outDir,
    clock: ctx.fc.clock,
    queue: ctx.brain.queue,
    blobsDir: ctx.blobsDir,
  });
  assert.equal(backup.blobs.length, 1);

  const backupScan = collectBackupReferencedBlobs(ctx.outDir);
  assert.ok(backupScan.hashes.has(referenced.hash), '备份清单里的 blob 必须算引用');
  assert.equal(backupScan.problems.length, 0);

  // 删掉 DB 里的显式引用（模拟记忆被彻底清理）：备份仍引用 → GC 不能删
  await runInTransaction(ctx.brain.db, (tx) => {
    tx.run('DELETE FROM blob_refs WHERE hash = ?', [referenced.hash]);
  });

  const plan = planBlobGc({ db: ctx.brain.db, blobsDir: ctx.blobsDir, outDir: ctx.outDir });
  assert.ok(plan.orphans.some((item) => item.hash === orphan.hash), '无引用 blob 应判为孤儿');
  assert.equal(plan.orphans.some((item) => item.hash === referenced.hash), false, '备份清单引用的 blob 不是孤儿');

  const result = runBlobGc({ db: ctx.brain.db, blobsDir: ctx.blobsDir, outDir: ctx.outDir });
  assert.equal(result.skipped, false);
  assert.equal(result.removed, 1);
  assert.equal(existsSync(blobStoragePath(ctx.blobsDir, orphan.hash)), false);
  assert.equal(existsSync(blobStoragePath(ctx.blobsDir, referenced.hash)), true);
  assert.equal(listBlobFiles(ctx.blobsDir).length, 1);
});

test('备份读者未完成时 GC 拒绝执行；结束后可执行', async (t) => {
  const ctx = createBrain(t);
  const blob = writeBlob({ blobsDir: ctx.blobsDir, content: '读者保护内容', db: ctx.brain.db, clock: ctx.fc.clock });
  const guard = createBlobReaderGuard();
  const token = guard.begin('createBackup');

  const blocked = runBlobGc({ db: ctx.brain.db, blobsDir: ctx.blobsDir, outDir: ctx.outDir, guard });
  assert.equal(blocked.skipped, true);
  assert.equal(blocked.reason, 'BACKUP_READER_ACTIVE');
  assert.equal(blocked.removed, 0);
  assert.ok(existsSync(blobStoragePath(ctx.blobsDir, blob.hash)), '读者未完成时一个都不能删');

  guard.end(token);
  const allowed = runBlobGc({ db: ctx.brain.db, blobsDir: ctx.blobsDir, outDir: ctx.outDir, guard });
  assert.equal(allowed.skipped, false);
  assert.equal(allowed.removed, 1);
  assert.equal(existsSync(blobStoragePath(ctx.blobsDir, blob.hash)), false);
});

test('备份清单损坏时 GC 保守跳过（看不到的引用不冒险删）', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  const blob = writeBlob({ blobsDir: ctx.blobsDir, content: '清单引用保护', db: ctx.brain.db, clock: ctx.fc.clock });
  await runInTransaction(ctx.brain.db, (tx) =>
    linkBlobRef({ tx, hash: blob.hash, ownerKind: 'event', ownerId: 'evt-x', clock: ctx.fc.clock }),
  );
  await createBackup({ db: ctx.brain.db, outDir: ctx.outDir, clock: ctx.fc.clock, queue: ctx.brain.queue, blobsDir: ctx.blobsDir });
  await runInTransaction(ctx.brain.db, (tx) => {
    tx.run('DELETE FROM blob_refs');
  });

  // 把备份清单写坏
  const dir = readdirSync(ctx.outDir, { withFileTypes: true }).find((entry) => entry.isDirectory());
  assert.ok(dir);
  writeFileSync(`${ctx.outDir}/${dir.name}/manifest.json`, '{broken', 'utf8');

  const result = runBlobGc({ db: ctx.brain.db, blobsDir: ctx.blobsDir, outDir: ctx.outDir });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'BACKUP_MANIFEST_PROBLEM');
  assert.equal(readFileSync(blobStoragePath(ctx.blobsDir, blob.hash)).length > 0, true);
});
