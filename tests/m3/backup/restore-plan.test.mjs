// @ts-check
/**
 * M3：planRestore 只读预演的结构与隔离判定（ui3 依赖这份返回结构）。
 */

import test from 'node:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  MIGRATIONS_DIR,
  assert,
  CORPUS,
  countRows,
  createBrain,
  fakeLedger,
  seedMemories,
} from './helpers.mjs';
import { createBackup } from '../../../packages/memory/src/backup.js';
import { planRestore, RESTORE_STEP_SEQUENCE } from '../../../packages/memory/src/restore.js';

/**
 * @param {ReturnType<typeof createBrain>} ctx
 * @param {string} [label]
 */
async function backupNow(ctx, label = 'plan-test') {
  await seedMemories(ctx.brain, [CORPUS[0], CORPUS[1]]);
  return createBackup({
    db: ctx.brain.db,
    outDir: ctx.outDir,
    clock: ctx.fc.clock,
    queue: ctx.brain.queue,
    label,
  });
}

test('planRestore：返回结构完整，且完全不写库/不建目录', async (t) => {
  const ctx = createBrain(t);
  const backup = await backupNow(ctx);
  const before = {
    events: countRows(ctx.brain.db, 'events'),
    memories: countRows(ctx.brain.db, 'memories'),
    dbSize: statSync(ctx.dbPath).size,
    backups: countRows(ctx.brain.db, 'backups'),
  };
  const targetDir = path.join(ctx.dir, 'restore-plan-target');

  const plan = planRestore({
    backupDir: backup.dir,
    ledger: fakeLedger(),
    targetDir,
    dbPath: ctx.dbPath,
  });

  // ---- ui3 直接依赖的字段 ----
  assert.equal(typeof plan.ok, 'boolean');
  assert.ok(Array.isArray(plan.blockers));
  assert.ok(Array.isArray(plan.hardBlockers));
  assert.ok(Array.isArray(plan.warnings));
  assert.ok(Array.isArray(plan.isolationReasons));
  assert.equal(typeof plan.isolationRequired, 'boolean');
  assert.ok(Array.isArray(plan.steps));
  assert.ok(plan.backup, 'plan.backup 必须存在');
  assert.ok(plan.ledgerCheck, 'plan.ledgerCheck 必须存在');
  assert.equal(plan.target.dir, path.resolve(targetDir));
  assert.equal(plan.target.exists, false);
  assert.match(plan.at, /Z$/);

  // ---- 备份摘要 ----
  assert.equal(plan.backup.backupId, backup.backupId);
  assert.equal(plan.backup.verified, true);
  assert.equal(plan.backup.ledgerEpoch, backup.ledgerEpoch);
  assert.equal(plan.backup.schemaVersion, ctx.brain.schemaVersion);
  assert.ok(plan.backup.watermark);
  assert.ok(Array.isArray(plan.backup.tables) && plan.backup.tables.length >= 16);
  assert.ok(Array.isArray(plan.backup.blobs));

  // ---- 账本检查 ----
  assert.equal(plan.ledgerCheck.ok, true);
  assert.equal(plan.ledgerCheck.stale, false);
  assert.equal(plan.ledgerCheck.backupEpoch, backup.ledgerEpoch);
  assert.equal(plan.ledgerCheck.ledgerEpoch, 0);

  // ---- 步骤固定顺序 ----
  assert.deepEqual(
    plan.steps.map((step) => step.id),
    RESTORE_STEP_SEQUENCE.map((step) => step.id),
  );
  assert.equal(plan.steps.length, 7);
  assert.ok(plan.steps.every((step) => typeof step.willDo === 'boolean'));

  // ---- 只读：库与文件系统都没动 ----
  assert.equal(countRows(ctx.brain.db, 'events'), before.events);
  assert.equal(countRows(ctx.brain.db, 'memories'), before.memories);
  assert.equal(countRows(ctx.brain.db, 'backups'), before.backups);
  assert.equal(statSync(ctx.dbPath).size, before.dbSize);
  assert.equal(existsSync(targetDir), false, '预演不许创建目标目录');
  assert.equal(plan.ok, true);
  assert.equal(plan.isolationRequired, false);
});

test('隔离路径 1：账本缺失 → LEDGER_MISSING，isolationRequired', async (t) => {
  const ctx = createBrain(t);
  const backup = await backupNow(ctx);
  const plan = planRestore({ backupDir: backup.dir, ledger: null, targetDir: path.join(ctx.dir, 'iso-missing') });
  assert.equal(plan.isolationRequired, true);
  assert.ok(plan.isolationReasons.some((item) => item.code === 'LEDGER_MISSING'));
  assert.equal(plan.ledgerCheck.reason, 'LEDGER_MISSING');
  // 隔离不是硬阻断：允许执行到隔离实例
  assert.equal(plan.ok, true);
  assert.equal(plan.hardBlockers.length, 0);
});

test('隔离路径 2：账本 corrupt → LEDGER_CORRUPT', async (t) => {
  const ctx = createBrain(t);
  const backup = await backupNow(ctx);
  const plan = planRestore({
    backupDir: backup.dir,
    ledger: fakeLedger({ corrupt: true }),
    targetDir: path.join(ctx.dir, 'iso-corrupt'),
  });
  assert.equal(plan.isolationRequired, true);
  assert.deepEqual(plan.isolationReasons.map((item) => item.code), ['LEDGER_CORRUPT']);
  assert.equal(plan.ledgerCheck.verify?.ok, false);
});

test('隔离路径 3：账本水位落后于备份 epoch → LEDGER_STALE_BEHIND_BACKUP', async (t) => {
  const ctx = createBrain(t);
  const ids = await seedMemories(ctx.brain, [CORPUS[0], CORPUS[2]]);
  const deletion = await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: ids[0],
    scope_id: 'owner-default',
    reason: 'stale-test',
  });
  assert.equal(deletion.deletion_epoch, 1);
  const backup = await createBackup({ db: ctx.brain.db, outDir: ctx.outDir, clock: ctx.fc.clock, queue: ctx.brain.queue });
  assert.equal(backup.ledgerEpoch, 1);

  // 账本水位只有 0（旧账本副本）
  const plan = planRestore({
    backupDir: backup.dir,
    ledger: fakeLedger(),
    targetDir: path.join(ctx.dir, 'iso-stale'),
  });
  assert.equal(plan.isolationRequired, true);
  assert.ok(plan.isolationReasons.some((item) => item.code === 'LEDGER_STALE_BEHIND_BACKUP'));
  assert.equal(plan.ledgerCheck.stale, true);
  assert.equal(plan.ledgerCheck.backupEpoch, 1);
  assert.equal(plan.ledgerCheck.ledgerEpoch, 0);
});

test('硬阻断：备份不存在 / 备份损坏', async (t) => {
  const ctx = createBrain(t);
  const missing = planRestore({ backupDir: path.join(ctx.dir, 'no-such-backup'), ledger: fakeLedger() });
  assert.equal(missing.ok, false);
  assert.equal(missing.isolationRequired, false);
  assert.ok(missing.hardBlockers.some((item) => item.code === 'BACKUP_MISSING'));

  const backup = await backupNow(ctx);
  writeFileSync(path.join(backup.dir, 'brain.db'), 'not a database anymore');
  const broken = planRestore({ backupDir: backup.dir, ledger: fakeLedger() });
  assert.equal(broken.ok, false);
  assert.ok(
    broken.hardBlockers.some((item) => item.code === 'BACKUP_VERIFY_FAILED'),
    JSON.stringify(broken.hardBlockers),
  );
  assert.ok(broken.backup !== null, '仍应返回备份摘要，供 UI 展示损坏原因');
});

test('硬阻断：备份 schema 与当前代码不兼容', async (t) => {
  const ctx = createBrain(t);
  const backup = await backupNow(ctx);
  // 只保留 0001 的迁移目录 → 最新版本 = 0001 ≠ 备份的 0005
  const oldMigrations = mkdtempSync(path.join(tmpdir(), 'm3-old-migrations-'));
  t.after(() => {
    try {
      rmSync(oldMigrations, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  cpSync(MIGRATIONS_DIR, oldMigrations, { recursive: true });
  for (const file of readdirSync(oldMigrations)) {
    if (!file.startsWith('0001')) rmSync(path.join(oldMigrations, file), { force: true });
  }

  const plan = planRestore({ backupDir: backup.dir, ledger: fakeLedger(), migrationsDir: oldMigrations });
  assert.equal(plan.ok, false);
  assert.ok(plan.hardBlockers.some((item) => item.code === 'SCHEMA_INCOMPATIBLE'), JSON.stringify(plan.hardBlockers));
});

test('硬阻断：目标路径是当前活跃数据库', async (t) => {
  const ctx = createBrain(t);
  const backup = await backupNow(ctx);
  const plan = planRestore({ backupDir: backup.dir, ledger: fakeLedger(), targetDir: ctx.dbPath, dbPath: ctx.dbPath });
  assert.equal(plan.ok, false);
  assert.ok(plan.hardBlockers.some((item) => item.code === 'TARGET_IS_ACTIVE_DB'));
});

test('告警：宿主副本未处理、账本非外部、目标已存在', async (t) => {
  const ctx = createBrain(t);
  const backup = await backupNow(ctx);
  const targetDir = path.join(ctx.dir, 'existing-target');
  const plan = planRestore({
    backupDir: backup.dir,
    ledger: fakeLedger({ external: false }),
    targetDir,
    hostCopies: [
      { system: 'dsh', handled: true },
      { system: 'engram', handled: false },
    ],
  });
  const codes = plan.warnings.map((item) => item.code);
  assert.ok(codes.includes('LEDGER_NOT_EXTERNAL'));
  assert.ok(codes.includes('HOST_COPIES_UNHANDLED'));
  assert.equal(codes.includes('TARGET_EXISTS'), false, '目标不存在时不该有 TARGET_EXISTS');
  assert.equal(plan.ok, true, '这些只是告警，不阻断');
  assert.equal(plan.hostCopies.length, 2);

  mkdirSync(targetDir, { recursive: true });
  const again = planRestore({ backupDir: backup.dir, ledger: fakeLedger({ external: false }), targetDir });
  assert.ok(again.warnings.some((item) => item.code === 'TARGET_EXISTS'));
  assert.equal(again.target.exists, true);
});
