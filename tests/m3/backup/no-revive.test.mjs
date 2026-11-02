// @ts-check
/**
 * M3 门槛核心：旧备份恢复**不许复活**已删内容。
 *
 * 覆盖：
 * 1. 备份 → 删除 → 用旧备份恢复：被删内容仍然不可读（真实删除 API + 真实备份/恢复）。
 * 2. 恢复过程中又发生删除：execute 重新预演后合并新账本，仍然不复活。
 * 3. 账本水位回退（stale）：promoted=false，拒绝上线，不谎称删除已跨备份生效。
 * 4. 真实 del3 账本联调（存在才跑）。
 */

import test from 'node:test';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  assert,
  CORPUS,
  createBrain,
  fakeLedger,
  ledgerEntry,
  loadRealLedgerFactory,
  seedMemories,
} from './helpers.mjs';
import { createBackup } from '../../../packages/memory/src/backup.js';
import { executeRestore, planRestore } from '../../../packages/memory/src/restore.js';

/**
 * @param {ReturnType<typeof createBrain>} ctx
 * @param {string} memoryId
 * @param {import('./helpers.mjs').fakeLedger extends never ? never : any} ledger
 */
async function deleteAndRecord(ctx, memoryId, ledger) {
  const deletion = await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: memoryId,
    scope_id: 'owner-default',
    reason: 'm3 门槛：备份之后的删除',
  });
  ledger.append(ledgerEntry({ tombstoneId: deletion.tombstone_id, memoryId, epoch: deletion.deletion_epoch }));
  return deletion;
}

/**
 * @param {ReturnType<typeof createBrain>} ctx
 * @param {string} targetDir
 * @param {any} ledger
 * @param {string} backupDir
 */
async function restoreInto(ctx, targetDir, ledger, backupDir) {
  const plan = planRestore({ backupDir, ledger, targetDir, dbPath: ctx.dbPath });
  const result = await executeRestore(plan, {
    db: ctx.brain.db,
    queue: ctx.brain.queue,
    clock: ctx.fc.clock,
    targetDir,
    ledger,
    dbPath: ctx.dbPath,
    backupDir,
  });
  return { plan, result };
}

test('M3 门槛：备份之后删除的记忆，用旧备份恢复后仍然没有', async (t) => {
  const ctx = createBrain(t);
  const ids = await seedMemories(ctx.brain, [...CORPUS]);
  const deletedIds = [ids[0], ids[2]];
  const survivorIds = [ids[1], ids[3]];

  // 1) 备份（删除之前）
  const backup = await createBackup({ db: ctx.brain.db, outDir: ctx.outDir, clock: ctx.fc.clock, queue: ctx.brain.queue });
  assert.equal(backup.ledgerEpoch, 0);

  // 2) 备份之后删除两条，并记进独立账本
  const ledger = fakeLedger();
  for (const memoryId of deletedIds) {
    await deleteAndRecord(ctx, memoryId, ledger);
  }
  assert.equal(ledger.watermark().epoch, 2);

  // 3) 用旧备份恢复
  const targetDir = path.join(ctx.dir, 'restore-no-revive');
  const { plan, result } = await restoreInto(ctx, targetDir, ledger, backup.dir);
  assert.equal(plan.ok, true);
  assert.equal(plan.isolationRequired, false);
  assert.equal(result.promoted, true, result.reason);
  assert.equal(result.merged.applied, 2, `账本里的 2 条删除必须被重放，实际 ${JSON.stringify(result.merged)}`);
  assert.equal(result.ledger.entries, 2);

  // 4) 真比对
  const restored = new DatabaseSync(result.targetDbPath, { readOnly: true });
  try {
    for (const memoryId of deletedIds) {
      const row = /** @type {Record<string, any> | undefined} */ (
        restored.prepare('SELECT status, content, summary FROM memories WHERE id = ?').get(memoryId)
      );
      assert.ok(row !== undefined, '记忆行存在（元数据保留）');
      assert.equal(row.status, 'deleted', '被删记忆恢复后仍必须是 deleted（未复活）');
      assert.equal(row.content, null, '被删正文必须为 NULL');
      assert.equal(row.summary, null, '被删摘要必须为 NULL');
      const ngramRows = /** @type {{ n?: number }} */ (
        restored.prepare('SELECT COUNT(*) AS n FROM search_ngram WHERE doc_id = ?').get(memoryId)
      );
      assert.equal(Number(ngramRows.n), 0, '被删内容不得残留在检索索引里');
      const versions = /** @type {Array<{ content: string | null }>} */ (
        restored.prepare('SELECT content FROM memory_versions WHERE memory_id = ?').all(memoryId)
      );
      assert.ok(versions.every((version) => version.content === null), '历史版本正文也必须清空');
    }
    for (const memoryId of survivorIds) {
      const row = /** @type {Record<string, any> | undefined} */ (
        restored.prepare('SELECT status, content FROM memories WHERE id = ?').get(memoryId)
      );
      assert.equal(row?.status, 'active');
      assert.ok(typeof row?.content === 'string' && row.content.length > 0, '未删记忆必须完整');
    }
    const epoch = /** @type {{ value?: string }} */ (
      restored.prepare("SELECT value FROM brain_meta WHERE key = 'deletion_epoch'").get()
    );
    assert.ok(Number(epoch?.value) >= 2, `恢复库 deletion_epoch 必须跟上账本（实际 ${String(epoch?.value)}）`);
    const tombstones = /** @type {{ n?: number }} */ (
      restored.prepare("SELECT COUNT(*) AS n FROM deletion_tombstones WHERE status <> 'failed'").get()
    );
    assert.equal(Number(tombstones.n), 2, '账本条目的 tombstone 必须在恢复库里重建');
  } finally {
    restored.close();
  }
});

test('恢复过程中又发生删除：重新预演后合并新账本，仍然不复活', async (t) => {
  const ctx = createBrain(t);
  const ids = await seedMemories(ctx.brain, [CORPUS[0], CORPUS[1], CORPUS[2]]);
  const backup = await createBackup({ db: ctx.brain.db, outDir: ctx.outDir, clock: ctx.fc.clock, queue: ctx.brain.queue });

  const ledger = fakeLedger();
  await deleteAndRecord(ctx, ids[0], ledger); // 预演时水位 = 1

  const targetDir = path.join(ctx.dir, 'restore-concurrent');
  const plan = planRestore({ backupDir: backup.dir, ledger, targetDir, dbPath: ctx.dbPath });
  assert.equal(plan.ledgerCheck.ledgerEpoch, 1);
  assert.equal(plan.isolationRequired, false);

  // 预演与执行之间又删了一条（并发删除）
  await deleteAndRecord(ctx, ids[2], ledger);
  assert.equal(ledger.watermark().epoch, 2);

  const result = await executeRestore(plan, {
    db: ctx.brain.db,
    queue: ctx.brain.queue,
    clock: ctx.fc.clock,
    targetDir,
    ledger,
    dbPath: ctx.dbPath,
    backupDir: backup.dir,
  });
  assert.equal(result.promoted, true, result.reason);
  assert.equal(result.ledger.entries, 2, 'execute 必须重新预演并读到新增的删除');
  assert.equal(result.merged.applied, 2);

  const restored = new DatabaseSync(result.targetDbPath, { readOnly: true });
  try {
    for (const memoryId of [ids[0], ids[2]]) {
      const row = /** @type {Record<string, any> | undefined} */ (
        restored.prepare('SELECT status, content FROM memories WHERE id = ?').get(memoryId)
      );
      assert.equal(row?.status, 'deleted');
      assert.equal(row?.content, null);
    }
    const survivor = /** @type {Record<string, any> | undefined} */ (
      restored.prepare('SELECT status, content FROM memories WHERE id = ?').get(ids[1])
    );
    assert.equal(survivor?.status, 'active');
  } finally {
    restored.close();
  }
});

test('账本水位回退（stale）：promoted=false，拒绝上线且不谎称删除已生效', async (t) => {
  const ctx = createBrain(t);
  const ids = await seedMemories(ctx.brain, [CORPUS[0], CORPUS[1]]);
  const ledger = fakeLedger();
  await deleteAndRecord(ctx, ids[0], ledger);

  // 删除之后备份：备份本身已经是「删除后」的状态，ledgerEpoch = 1
  const backup = await createBackup({ db: ctx.brain.db, outDir: ctx.outDir, clock: ctx.fc.clock, queue: ctx.brain.queue });
  assert.equal(backup.ledgerEpoch, 1);

  // 用一份"水位 0"的旧账本恢复 → 陈旧
  const staleLedger = fakeLedger();
  const targetDir = path.join(ctx.dir, 'restore-stale');
  const { plan, result } = await restoreInto(ctx, targetDir, staleLedger, backup.dir);
  assert.equal(plan.ok, true, '陈旧账本不是硬阻断');
  assert.equal(plan.isolationRequired, true);
  assert.equal(plan.ledgerCheck.stale, true);
  assert.ok(plan.isolationReasons.some((item) => item.code === 'LEDGER_STALE_BEHIND_BACKUP'));
  assert.equal(result.promoted, false, '陈旧账本恢复必须 promoted=false');
  assert.equal(result.isolationRequired, true);
  assert.match(result.reason, /LEDGER_STALE_BEHIND_BACKUP/);
  assert.equal(result.merged.applied, 0, '旧账本里没有删除条目可重放（这正是危险所在）');
});

test('真实 del3 账本联调：append → 旧备份恢复 → 不复活（未交付则跳过）', async (t) => {
  const ctx = createBrain(t);
  const factory = await loadRealLedgerFactory();
  if (factory === null) {
    t.skip('deletion-ledger.js 尚未交付');
    return;
  }
  const ids = await seedMemories(ctx.brain, [CORPUS[0], CORPUS[1]]);
  const backup = await createBackup({ db: ctx.brain.db, outDir: ctx.outDir, clock: ctx.fc.clock, queue: ctx.brain.queue });

  const ledgerDir = path.join(ctx.dir, 'real-deletion-ledger');
  const ledger = factory({ dir: ledgerDir, clock: ctx.fc.clock });
  const deletion = await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: ids[0],
    scope_id: 'owner-default',
    reason: '真实账本联调',
  });
  ledger.append({
    tombstoneId: deletion.tombstone_id,
    memoryId: ids[0],
    epoch: deletion.deletion_epoch,
    requestedAt: ctx.fc.nowIso(),
    scopeId: 'owner-default',
    reason: '真实账本联调',
    actor: 'owner',
  });
  assert.equal(ledger.verify().ok, true);
  assert.equal(ledger.watermark().epoch, 1);

  const targetDir = path.join(ctx.dir, 'restore-real-ledger');
  const { plan, result } = await restoreInto(ctx, targetDir, ledger, backup.dir);
  assert.equal(plan.isolationRequired, false, JSON.stringify(plan.isolationReasons));
  assert.equal(result.promoted, true, result.reason);

  const restored = new DatabaseSync(result.targetDbPath, { readOnly: true });
  try {
    const row = /** @type {Record<string, any> | undefined} */ (
      restored.prepare('SELECT status, content FROM memories WHERE id = ?').get(ids[0])
    );
    assert.equal(row?.status, 'deleted');
    assert.equal(row?.content, null);
  } finally {
    restored.close();
  }
});
