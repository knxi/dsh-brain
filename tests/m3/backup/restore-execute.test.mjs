// @ts-check
/**
 * M3：executeRestore 顺序、promoted 判定、隔离上架、_pre-restore 回滚点、TOCTOU 防护。
 */

import test from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { assert, CORPUS, createBrain, fakeLedger, seedMemories } from './helpers.mjs';
import { createBackup, verifyBackup } from '../../../packages/memory/src/backup.js';
import { executeRestore, planRestore } from '../../../packages/memory/src/restore.js';

/**
 * @param {ReturnType<typeof createBrain>} ctx
 * @param {string} targetDir
 * @param {{ ledger?: any }} [opts]
 */
async function planAndRestore(ctx, targetDir, opts = {}) {
  const ledger = opts.ledger ?? fakeLedger();
  const plan = planRestore({ backupDir: opts.backupDir, ledger, targetDir, dbPath: ctx.dbPath });
  const result = await executeRestore(plan, {
    db: ctx.brain.db,
    queue: ctx.brain.queue,
    clock: ctx.fc.clock,
    targetDir,
    ledger,
    dbPath: ctx.dbPath,
    backupDir: opts.backupDir,
  });
  return { plan, result };
}

test('executeRestore：正常恢复 promoted=true，主表/派生/审计/_pre-restore 齐全', async (t) => {
  const ctx = createBrain(t);
  const ids = await seedMemories(ctx.brain, [CORPUS[0], CORPUS[1]]);
  const backup = await createBackup({ db: ctx.brain.db, outDir: ctx.outDir, clock: ctx.fc.clock, queue: ctx.brain.queue });
  const targetDir = path.join(ctx.dir, 'restored-ok');

  const { plan, result } = await planAndRestore(ctx, targetDir, { backupDir: backup.dir });
  assert.equal(plan.ok, true);
  assert.equal(result.promoted, true, result.reason);
  assert.equal(result.requiresRestart, true);
  assert.equal(result.steps.length, 7);
  assert.ok(result.steps.every((step) => step.ok), JSON.stringify(result.steps));
  assert.equal(result.reason, 'all_checks_passed');

  // 回滚点存在且本身是一份可校验备份
  assert.equal(typeof result.preRestoreDir, 'string');
  assert.ok(existsSync(result.preRestoreDir));
  assert.equal(verifyBackup(result.preRestoreDir).ok, true, '恢复前另存必须是有效备份');

  // 目标库：主表 + 派生数据 + 审计
  const restored = new DatabaseSync(result.targetDbPath, { readOnly: true });
  try {
    const counts = restored.prepare('SELECT COUNT(*) AS n FROM memories').get();
    assert.equal(Number(counts.n), ids.length);
    const tables = restored
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('search_fts_char','search_fts_trigram','search_ngram')")
      .all()
      .map((row) => String(row.name));
    assert.deepEqual(tables.sort(), ['search_fts_char', 'search_fts_trigram', 'search_ngram']);
    const ngramCount = restored.prepare('SELECT COUNT(DISTINCT doc_id) AS n FROM search_ngram').get();
    assert.equal(Number(ngramCount.n), ids.length, '派生索引必须重建到全部存活记忆');
    const audit = restored.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'restore.executed'").get();
    assert.equal(Number(audit.n), 1, '恢复必须留审计');
    const meta = /** @type {{ value?: string } | undefined} */ (
      restored.prepare("SELECT value FROM brain_meta WHERE key = 'deletion_epoch'").get()
    );
    assert.ok(Number(meta?.value ?? 0) >= Number(backup.ledgerEpoch ?? 0), '恢复库删除纪元不得低于备份的 ledgerEpoch');
  } finally {
    restored.close();
  }
});

test('executeRestore：拒绝覆盖活跃数据库；目标已存在需 allowOverwrite', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  const backup = await createBackup({ db: ctx.brain.db, outDir: ctx.outDir, clock: ctx.fc.clock, queue: ctx.brain.queue });
  const ledger = fakeLedger();

  await assert.rejects(
    () =>
      executeRestore(null, {
        db: ctx.brain.db,
        queue: ctx.brain.queue,
        clock: ctx.fc.clock,
        targetDir: ctx.dbPath,
        ledger,
        dbPath: ctx.dbPath,
        backupDir: backup.dir,
      }),
    (err) => {
      assert.equal(/** @type {{code?: string}} */ (err).code, 'RESTORE_REFUSED');
      return true;
    },
  );

  const targetDir = path.join(ctx.dir, 'restored-overwrite');
  await planAndRestore(ctx, targetDir, { backupDir: backup.dir });
  await assert.rejects(
    () => planAndRestore(ctx, targetDir, { backupDir: backup.dir }),
    (err) => {
      assert.equal(/** @type {{code?: string}} */ (err).code, 'RESTORE_REFUSED');
      return true;
    },
  );

  const plan = planRestore({ backupDir: backup.dir, ledger, targetDir, dbPath: ctx.dbPath });
  const result = await executeRestore(plan, {
    db: ctx.brain.db,
    queue: ctx.brain.queue,
    clock: ctx.fc.clock,
    targetDir,
    ledger,
    dbPath: ctx.dbPath,
    backupDir: backup.dir,
    allowOverwrite: true,
  });
  assert.equal(result.promoted, true);
  assert.ok(existsSync(targetDir));
});

test('executeRestore：账本隔离 → 恢复可产出副本但 promoted=false', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  const backup = await createBackup({ db: ctx.brain.db, outDir: ctx.outDir, clock: ctx.fc.clock, queue: ctx.brain.queue });
  const targetDir = path.join(ctx.dir, 'restored-iso');

  const { plan, result } = await planAndRestore(ctx, targetDir, { backupDir: backup.dir, ledger: fakeLedger({ missing: true }) });
  assert.equal(plan.ok, true, '隔离不是硬阻断：可以执行');
  assert.equal(plan.isolationRequired, true);
  assert.equal(result.promoted, false);
  assert.match(result.reason, /isolation_required/);
  assert.equal(result.isolationRequired, true);
  assert.ok(existsSync(result.targetDbPath), '隔离副本仍然产出，供只读检修');
  assert.ok(result.steps.some((step) => step.id === 'decide_promotion' && step.ok));
});

test('executeRestore：plan 之后备份被改 → 重新预演拒绝（TOCTOU 防护）', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  const backup = await createBackup({ db: ctx.brain.db, outDir: ctx.outDir, clock: ctx.fc.clock, queue: ctx.brain.queue });
  const ledger = fakeLedger();
  const targetDir = path.join(ctx.dir, 'restored-toctou');
  const plan = planRestore({ backupDir: backup.dir, ledger, targetDir, dbPath: ctx.dbPath });
  assert.equal(plan.ok, true);

  // 预演之后备份被篡改
  const { writeFileSync, readFileSync } = await import('node:fs');
  const dbFile = path.join(backup.dir, 'brain.db');
  const bytes = Buffer.from(readFileSync(dbFile));
  bytes[bytes.length - 1] = bytes[bytes.length - 1] ^ 0xff;
  writeFileSync(dbFile, bytes);

  await assert.rejects(
    () =>
      executeRestore(plan, {
        db: ctx.brain.db,
        queue: ctx.brain.queue,
        clock: ctx.fc.clock,
        targetDir,
        ledger,
        dbPath: ctx.dbPath,
        backupDir: backup.dir,
      }),
    (err) => {
      assert.equal(/** @type {{code?: string}} */ (err).code, 'BACKUP_VERIFY_FAILED');
      return true;
    },
  );
  assert.equal(existsSync(targetDir), false, '校验失败不许留下恢复产物');
});

test('executeRestore：目标路径父目录不存在时自动创建', async (t) => {
  const ctx = createBrain(t);
  await seedMemories(ctx.brain, [CORPUS[0]]);
  const backup = await createBackup({ db: ctx.brain.db, outDir: ctx.outDir, clock: ctx.fc.clock, queue: ctx.brain.queue });
  const targetDir = path.join(ctx.dir, 'deep', 'nested', 'restored');
  const { result } = await planAndRestore(ctx, targetDir, { backupDir: backup.dir });
  assert.equal(result.promoted, true);
  assert.ok(existsSync(result.targetDbPath));
});
