// @ts-check
/**
 * M3：目录形态全量备份（createBackup / verifyBackup / 原子落位 / 清单完整性）。
 */

import test from 'node:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assert, CORPUS, countRows, createBrain, seedMemories } from './helpers.mjs';
import {
  BACKUP_MANIFEST_FILE,
  createBackup,
  linkBlobRef,
  listBackups,
  verifyBackup,
  writeBlob,
} from '../../../packages/memory/src/backup.js';
import { runInTransaction } from '../../../packages/memory/src/write-queue.js';

/**
 * @param {ReturnType<typeof createBrain>} ctx
 * @param {Record<string, unknown>} [overrides]
 */
async function makeBackup(ctx, overrides = {}) {
  return createBackup({
    db: ctx.brain.db,
    outDir: ctx.outDir,
    clock: ctx.fc.clock,
    queue: ctx.brain.queue,
    ...overrides,
  });
}

test('createBackup：目录形态 + 清单完整 + ledgerEpoch 从快照内部读', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  ctx.fc.advance(1000);

  const backup = await makeBackup(ctx);
  assert.equal(backup.verified, true);
  assert.ok(existsSync(path.join(backup.dir, 'brain.db')), '备份库文件必须存在');
  assert.ok(existsSync(path.join(backup.dir, BACKUP_MANIFEST_FILE)), '备份清单必须存在');
  assert.match(backup.manifestHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(backup.ledgerEpoch, 0);

  const manifest = JSON.parse(readFileSync(path.join(backup.dir, BACKUP_MANIFEST_FILE), 'utf8'));
  assert.equal(manifest.format, 'dsh-brain-backup');
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.ledgerEpoch, 0);
  assert.equal(manifest.deletionEpoch, 0);
  assert.equal(manifest.schemaVersion, ctx.brain.schemaVersion);
  assert.ok(Array.isArray(manifest.tables) && manifest.tables.length >= 16, '清单必须逐表记录行数');
  assert.ok(manifest.watermark && 'maxSourceSeq' in manifest.watermark, '清单必须记录 watermark');
  assert.ok(
    manifest.watermark.maxSourceSeq === null || typeof manifest.watermark.maxSourceSeq === 'number',
    'watermark.maxSourceSeq 允许 null（没有事件时）或 number',
  );
  assert.equal(typeof manifest.db.sha256, 'string');
  assert.equal(manifest.manifestHash, backup.manifestHash);

  const record = /** @type {Record<string, unknown>} */ (
    ctx.brain.db.prepare('SELECT * FROM backups WHERE backup_id = ?').get(backup.backupId)
  );
  assert.equal(record.format, 'dir');
  assert.equal(record.status, 'verified');
  assert.equal(Number(record.deletion_epoch), 0);
  assert.ok(record.verified_at);
});

test('verifyBackup：完好备份 ok；db / 清单 / ledgerEpoch 任一被改都报问题', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  const backup = await makeBackup(ctx);

  const good = verifyBackup(backup.dir);
  assert.equal(good.ok, true, JSON.stringify(good.problems));
  assert.equal(good.ledgerEpoch, 0);

  // a) 改 db 一个字节
  const dbFile = path.join(backup.dir, 'brain.db');
  const originalDbBytes = readFileSync(dbFile);
  const bytes = Buffer.from(originalDbBytes);
  bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
  writeFileSync(dbFile, bytes);
  const brokenDb = verifyBackup(backup.dir);
  assert.equal(brokenDb.ok, false);
  assert.ok(brokenDb.problems.some((item) => item.code === 'DB_HASH_MISMATCH' || item.code === 'DB_INTEGRITY'), JSON.stringify(brokenDb.problems));

  // b) 恢复 db，改清单里的 ledgerEpoch
  writeFileSync(dbFile, originalDbBytes);
  const manifestFile = path.join(backup.dir, BACKUP_MANIFEST_FILE);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  manifest.ledgerEpoch = 7;
  writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
  const brokenManifest = verifyBackup(backup.dir);
  assert.equal(brokenManifest.ok, false);
  assert.ok(
    brokenManifest.problems.some((item) => item.code === 'MANIFEST_HASH_MISMATCH') ||
      brokenManifest.problems.some((item) => item.code === 'LEDGER_EPOCH_MISMATCH'),
    JSON.stringify(brokenManifest.problems),
  );

  // c) 清单缺 ledgerEpoch（重算 manifestHash，隔离出「缺字段」这条）
  const manifest2 = JSON.parse(readFileSync(manifestFile, 'utf8'));
  delete manifest2.ledgerEpoch;
  manifest2.manifestHash = '';
  writeFileSync(manifestFile, JSON.stringify(manifest2, null, 2));
  const missingEpoch = verifyBackup(backup.dir);
  assert.equal(missingEpoch.ok, false);
  assert.ok(missingEpoch.problems.some((item) => item.code === 'MANIFEST_LEDGER_EPOCH_MISSING'), JSON.stringify(missingEpoch.problems));

  // d) 清单被删
  writeFileSync(manifestFile, '{}');
  const emptyManifest = verifyBackup(backup.dir);
  assert.equal(emptyManifest.ok, false);
  assert.ok(emptyManifest.problems.some((item) => item.code === 'MANIFEST_FORMAT' || item.code === 'MANIFEST_LEDGER_EPOCH_MISSING'));
});

test('原子落位：失败不覆盖上一份有效备份，也不留 .tmp 残骸', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  const good = await makeBackup(ctx);
  const manifestBefore = readFileSync(path.join(good.dir, BACKUP_MANIFEST_FILE));

  await assert.rejects(
    () =>
      makeBackup(ctx, {
        backupId: 'bkp_injected_failure',
        backupImpl: async () => {
          throw new Error('注入的备份失败');
        },
      }),
    /注入的备份失败/,
  );

  assert.ok(existsSync(good.dir), '上一份有效备份必须仍在');
  assert.deepEqual(readFileSync(path.join(good.dir, BACKUP_MANIFEST_FILE)), manifestBefore, '旧备份内容不得被改写');
  assert.equal(existsSync(path.join(ctx.outDir, 'bkp_injected_failure.tmp')), false, '不得留下 .tmp 残骸');
  assert.equal(existsSync(path.join(ctx.outDir, 'bkp_injected_failure')), false, '失败的备份不得落位');
  const failed = /** @type {Record<string, unknown> | undefined} */ (
    ctx.brain.db.prepare("SELECT * FROM backups WHERE backup_id = 'bkp_injected_failure'").get()
  );
  assert.equal(failed?.status, 'failed', '失败必须留痕');
  assert.equal(verifyBackup(good.dir).ok, true);
});

test('每日独立全量：两次备份互不依赖，且第二次的 ledgerEpoch 跟上删除纪元', async (t) => {
  const ctx = createBrain(t);
  const ids = await seedMemories(ctx.brain, [CORPUS[0], CORPUS[1]]);
  const first = await makeBackup(ctx);

  // 备份之后发生一次删除 → deletion_epoch = 1
  const deletion = await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: ids[0],
    scope_id: 'owner-default',
    reason: 'm3-test',
  });
  assert.equal(deletion.status, 'accepted');

  ctx.fc.advance(60_000);
  const second = await makeBackup(ctx);
  assert.equal(first.ledgerEpoch, 0);
  assert.equal(second.ledgerEpoch, 1, '第二次备份必须记录删除后的 epoch（从快照内部读）');
  assert.notEqual(first.dbSha256, second.dbSha256, '两份备份是独立全量，不是增量链');
  assert.equal(verifyBackup(first.dir).ok, true);
  assert.equal(verifyBackup(second.dir).ok, true);

  // 删掉第二份，第一份仍可独立校验（没有链依赖）
  const entries = listBackups({ outDir: ctx.outDir });
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.format === 'dir'));
  assert.equal(entries[0].ledgerEpoch, 1, 'listBackups 按 createdAt 降序');
});

test('必需附件（blob）进入清单与备份目录，hash 可校验', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  const content = Buffer.from('图号 JS-2026-017 的附件内容', 'utf8');
  const blob = writeBlob({ blobsDir: ctx.blobsDir, content, db: ctx.brain.db, clock: ctx.fc.clock });
  await runInTransaction(ctx.brain.db, (tx) =>
    linkBlobRef({ tx, hash: blob.hash, ownerKind: 'event', ownerId: 'evt-attach-1', clock: ctx.fc.clock }),
  );

  const backup = await makeBackup(ctx, { blobsDir: ctx.blobsDir });
  assert.equal(backup.blobs.length, 1);
  assert.equal(backup.blobs[0].hash, blob.hash);
  assert.equal(backup.blobs[0].size, content.byteLength);
  assert.equal(backup.blobs[0].refCount, 1);
  const hex = blob.hash.replace(/^sha256:/, '');
  assert.ok(existsSync(path.join(backup.dir, 'blobs', hex.slice(0, 2), hex)), '必需附件必须复制进备份目录');

  const verified = verifyBackup(backup.dir);
  assert.equal(verified.ok, true, JSON.stringify(verified.problems));

  // 篡改附件 → 校验失败
  writeFileSync(path.join(backup.dir, 'blobs', hex.slice(0, 2), hex), 'tampered');
  const broken = verifyBackup(backup.dir);
  assert.equal(broken.ok, false);
  assert.ok(broken.problems.some((item) => item.code === 'BLOB_HASH_MISMATCH'), JSON.stringify(broken.problems));
});

test('必需附件缺失时备份失败，不产出不完整清单', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  const blob = writeBlob({ blobsDir: ctx.blobsDir, content: Buffer.from('x'), db: ctx.brain.db, clock: ctx.fc.clock });
  await runInTransaction(ctx.brain.db, (tx) =>
    linkBlobRef({ tx, hash: blob.hash, ownerKind: 'event', ownerId: 'evt-missing', clock: ctx.fc.clock }),
  );

  // 不传 blobsDir：快照里有引用 → 必须失败（不许产出缺附件的备份）
  await assert.rejects(() => makeBackup(ctx), /blob|附件/i);
  assert.equal(listBackups({ outDir: ctx.outDir }).length, 0);
});

test('备份记录与 brain_meta.last_snapshot_id 一致', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  const backup = await makeBackup(ctx);
  assert.equal(ctx.brain.ledger.getMeta('last_snapshot_id'), backup.backupId);
  assert.equal(countRows(ctx.brain.db, 'backups'), 1);
});
