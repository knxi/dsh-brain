// @ts-check
/**
 * M3：pruneBackups 的**绝对时间**语义（份数只做保底 floor，不决定删除）。
 */

import test from 'node:test';
import { existsSync } from 'node:fs';
import { assert, CORPUS, createBrain, countRows, seedMemories } from './helpers.mjs';
import { createBackup, listBackups, pruneBackups } from '../../../packages/memory/src/backup.js';

/**
 * 造 N 份备份，每份间隔 1 天。
 * @param {ReturnType<typeof createBrain>} ctx
 * @param {number} count
 * @param {{ retentionDays?: number }} [opts]
 */
async function makeSeries(ctx, count, opts = {}) {
  /** @type {Array<Record<string, any>>} */
  const made = [];
  await seedMemories(ctx.brain, [CORPUS[0]]);
  for (let index = 0; index < count; index += 1) {
    const backup = await createBackup({
      db: ctx.brain.db,
      outDir: ctx.outDir,
      clock: ctx.fc.clock,
      queue: ctx.brain.queue,
      kind: 'daily',
      retentionDays: opts.retentionDays ?? 2,
    });
    made.push(backup);
    ctx.fc.advance(86_400_000);
  }
  return made;
}

test('绝对时间：未到期一份都不删（份数不决定删除）', async (t) => {
  const ctx = createBrain(t);
  const made = await makeSeries(ctx, 3, { retentionDays: 30 });
  const result = pruneBackups({
    outDir: ctx.outDir,
    db: ctx.brain.db,
    clock: ctx.fc.clock,
    keep: 1,
    now: new Date(ctx.fc.nowIso()),
  });
  assert.equal(result.removed.length, 0, '未到绝对到期时间就不能删，哪怕份数超过 keep');
  assert.equal(result.kept.length, 3);
  assert.ok(result.kept.every((item) => item.reason === 'not_expired'));
  assert.ok(made.every((backup) => existsSync(backup.dir)));
  assert.equal(countRows(ctx.brain.db, 'backups'), 3);
});

test('绝对时间：到期的被删；最近 keep 份即使到期也保底保留', async (t) => {
  const ctx = createBrain(t);
  // 3 份，retention=2 天：T0 / T0+1d / T0+2d
  const made = await makeSeries(ctx, 3, { retentionDays: 2 });
  // now = T0 + 2d + 1h：只有第 1 份（T0+2d）到期
  const now = new Date(Date.parse(made[2].createdAt) + 3_600_000);

  const dryRun = pruneBackups({ outDir: ctx.outDir, db: ctx.brain.db, clock: ctx.fc.clock, keep: 2, now, dryRun: true });
  assert.equal(dryRun.dryRun, true);
  assert.equal(dryRun.removed.length, 1);
  assert.equal(dryRun.removed[0].backupId, made[0].backupId);
  assert.equal(dryRun.removed[0].reason, 'expired');
  assert.ok(existsSync(made[0].dir), 'dryRun 不真删');

  const real = pruneBackups({ outDir: ctx.outDir, db: ctx.brain.db, clock: ctx.fc.clock, keep: 2, now });
  assert.equal(real.removed.length, 1);
  assert.equal(existsSync(made[0].dir), false);
  assert.equal(countRows(ctx.brain.db, 'backups'), 2, '删除的文件对应的备份记录也要清掉');
  assert.equal(listBackups({ outDir: ctx.outDir }).length, 2);

  // 审计留痕
  const audit = /** @type {Array<{ action: string, detail: string }>} */ (
    ctx.brain.db.prepare("SELECT action, detail FROM audit_logs WHERE action = 'backup.pruned'").all()
  );
  assert.equal(audit.length, 1);
  assert.match(audit[0].detail, /expired/);

  // 保底 floor：让全部到期，keep=2 → 最近 2 份保留（reason=retained_by_floor）
  const later = new Date(Date.parse(made[2].createdAt) + 30 * 86_400_000);
  const floored = pruneBackups({ outDir: ctx.outDir, db: ctx.brain.db, clock: ctx.fc.clock, keep: 2, now: later });
  assert.equal(floored.removed.length, 0, '已到期但属于最近 keep 份 → 保底保留');
  assert.ok(floored.kept.every((item) => item.reason === 'retained_by_floor'));
  assert.equal(listBackups({ outDir: ctx.outDir }).length, 2);
});

test('keep=0 时按绝对时间全删已到期的（不保底）', async (t) => {
  const ctx = createBrain(t);
  const made = await makeSeries(ctx, 2, { retentionDays: 1 });
  const now = new Date(Date.parse(made[1].createdAt) + 5 * 86_400_000);
  const result = pruneBackups({ outDir: ctx.outDir, db: ctx.brain.db, clock: ctx.fc.clock, keep: 0, now });
  assert.equal(result.removed.length, 2);
  assert.equal(listBackups({ outDir: ctx.outDir }).length, 0);
  assert.equal(countRows(ctx.brain.db, 'backups'), 0);
});

test('不存在备份目录时 prune 是空操作', async (t) => {
  const ctx = createBrain(t);
  const result = pruneBackups({ outDir: `${ctx.outDir}-nope`, db: ctx.brain.db, clock: ctx.fc.clock, now: new Date() });
  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.kept, []);
});
