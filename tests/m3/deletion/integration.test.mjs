// @ts-check
/**
 * M3 删除线集成（M3-INTERFACES §1.3 / §2.3 / §7 的门槛项）。
 *
 * 这里测的是四件"错了就整条线白做"的事：
 *  1. **旧备份恢复不复活**：真库、真删、真快照、真恢复。先证明"不重放账本就会复活"，
 *     再用账本重放证明"不复活"——正反面对照，不然无法说明账本到底救了什么。
 *  2. **账本缺失 / corrupt / 水位落后于备份 epoch** → `checkForRestore` 必须给 blocker。
 *  3. **账本追加失败 → 删除请求必须失败**，且 DB 里不留墓碑（事务回滚，不许虚报删除成功）。
 *  4. **并发删除**：多条删除交错，清理完都不复活。
 *
 * 数据全部合成（尺寸 / 材质 / 图号 / 报价 / 英文标识符），不碰真实私密历史。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { backup as sqliteBackup } from 'node:sqlite';
import { createClock } from '../../../packages/core/src/index.js';
import {
  LEDGER_ENTRIES_FILE,
  createDeletionLedger,
  defaultDeletionLedgerDir,
} from '../../../packages/memory/src/deletion-ledger.js';
import { openBrain } from '../../../packages/memory/src/index.js';
import { replayLedgerDeletions } from '../../../packages/memory/src/deletion.js';
import { SCOPE_A, CORPUS, copyDbTo, createBrain, fixedClock, seed } from './helpers.mjs';

/** @param {import('node:test').TestContext} t */
function newTempDir(t, prefix = 'dsh-m3-mig-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟释放不影响断言 */
    }
  });
  return dir;
}

/**
 * 触发删除 + 跑完 M3 五步清理。
 * @param {ReturnType<typeof createBrain>} ctx
 * @param {string} memoryId
 * @param {string} [reason]
 */
async function deleteAndPurge(ctx, memoryId, reason = '主人要求删除') {
  const deletion = await ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: memoryId,
    scope_id: SCOPE_A,
    reason,
    actor: 'owner',
  });
  const run = await ctx.brain.deletionWorker.runOnce({ maxJobs: 40 });
  return { deletion, run };
}

test('M3 门槛：旧备份恢复**不复活**——不重放账本会复活，重放后不复活', async (t) => {
  const ctx = createBrain(t);
  const { brain, dbPath, dir } = ctx;

  const keep = await seed(brain, CORPUS.card);
  const secret = await seed(brain, CORPUS.quote);
  const keep2 = await seed(brain, CORPUS.drawing);

  // 备份时刻的删除纪元（backup3 要把这个数落进备份清单）
  const backupEpoch = Number(
    /** @type {{ n: number }} */ (brain.db.prepare("SELECT CAST(value AS INTEGER) AS n FROM brain_meta WHERE key = 'deletion_epoch'").get())
      ?.n ?? 0,
  );
  assert.equal(backupEpoch, 0);

  // 真快照：node:sqlite 的顶层 backup()（一致性快照，不是文件复制）
  const backupDir = newTempDir(t, 'dsh-m3-snap-');
  const snapshotPath = path.join(backupDir, 'brain.db');
  await sqliteBackup(brain.db, snapshotPath);

  // 备份之后才删除（这是账本要覆盖的窗口）
  ctx.fc.advance(60_000);
  const { deletion, run } = await deleteAndPurge(ctx, secret.id, '隐私内容，不再保留');
  assert.equal(run.failed, 0, `清理不该失败：${JSON.stringify(run.jobs)}`);
  assert.equal(brain.memories.get(secret.id), null);

  // 账本水位 >= 备份 epoch，且明确告知"备份之后有删除要重放"
  const check = brain.deletionLedger.checkForRestore({ backupEpoch, backupCreatedAt: ctx.fc.nowIso(), dbPath });
  assert.equal(check.ok, true, `账本应通过闸门：${JSON.stringify(check.blockers)}`);
  assert.ok(check.warnings.includes('LEDGER_HAS_DELETIONS_AFTER_BACKUP'));
  assert.equal(check.deletionsAfterBackup, 1);
  const pending = brain.deletionLedger.readAfterEpoch(backupEpoch);
  assert.deepEqual(
    pending.map((entry) => entry.memoryId),
    [secret.id],
    '账本里应有这条删除（且只存 id 元数据）',
  );

  // ---------- 恢复 A：直接上架（不重放账本）→ 复活 ----------
  const restoreADir = newTempDir(t, 'dsh-m3-restore-a-');
  const restoredPathA = copyDbTo(snapshotPath, restoreADir);
  const fcA = fixedClock(ctx.fc.nowIso());
  const brainA = openBrain({ dbPath: restoredPathA, clock: fcA.clock });
  try {
    // 这就是 M3 门槛要防住的场景：备份里的 content 还在，静默复活
    assert.ok(brainA.memories.get(secret.id), '对照：不重放账本时，被删内容会从旧备份里复活');
    assert.ok(
      brainA.memories.search({ query: '脚手架租赁报价', scopeId: SCOPE_A }).hits.some((hit) => hit.memoryId === secret.id),
      '对照：不重放账本时，被删内容会从旧备份的索引里被召回',
    );
  } finally {
    await brainA.close();
  }

  // ---------- 恢复 B：按恢复编排强制合并账本 → 不复活 ----------
  const restoreBDir = newTempDir(t, 'dsh-m3-restore-b-');
  const restoredPathB = copyDbTo(snapshotPath, restoreBDir);
  const fcB = fixedClock(ctx.fc.nowIso());
  const brainB = openBrain({ dbPath: restoredPathB, clock: fcB.clock });
  try {
    const before = brainB.memories.get(secret.id);
    assert.ok(before, '导入主表后、合并账本前，行还在（正因为如此才必须重放）');

    const replay = await replayLedgerDeletions({ db: brainB.db, queue: brainB.queue, clock: fcB.clock }, pending);
    assert.equal(replay.applied, 1, `账本条目必须被重放：${JSON.stringify(replay.results)}`);
    assert.equal(replay.skipped, 0);

    // 删除已生效：读不到、搜不到
    assert.equal(brainB.memories.get(secret.id), null, '重放后旧备份不许让已删内容复活');
    assert.equal(
      brainB.memories.search({ query: '脚手架租赁报价', scopeId: SCOPE_A }).hits.some((hit) => hit.memoryId === secret.id),
      false,
      '重放后检索也不许召回',
    );
    assert.equal(brainB.memories.get(secret.id, { asOf: ctx.fc.nowIso() }), null, 'asOf 也不许复活');

    // 其它记忆不受影响（不是把整库删了）
    assert.ok(brainB.memories.get(keep.id));
    assert.ok(brainB.memories.get(keep2.id));
    assert.equal(brainB.memories.list({ scopeId: SCOPE_A }).items.length, 2);

    // 重放是幂等的：再放一次不会重复抬高 epoch / 重复排 job
    const epochAfterFirst = Number(
      /** @type {{ n: number }} */ (brainB.db.prepare("SELECT CAST(value AS INTEGER) AS n FROM brain_meta WHERE key = 'deletion_epoch'").get())
        ?.n ?? 0,
    );
    const again = await replayLedgerDeletions({ db: brainB.db, queue: brainB.queue, clock: fcB.clock }, pending);
    assert.equal(again.applied, 0);
    assert.equal(again.skipped, 1);
    assert.equal(again.results[0].reason, 'already_tombstoned');
    const epochAfterSecond = Number(
      /** @type {{ n: number }} */ (brainB.db.prepare("SELECT CAST(value AS INTEGER) AS n FROM brain_meta WHERE key = 'deletion_epoch'").get())
        ?.n ?? 0,
    );
    assert.equal(epochAfterSecond, epochAfterFirst, '幂等重放不许再抬 epoch');

    // 恢复库还要把派生数据重建/清理干净：跑一遍 M3 worker
    const cleanup = await brainB.deletionWorker.runOnce({ maxJobs: 20 });
    assert.equal(cleanup.failed, 0);
    assert.equal(
      brainB.memories.search({ query: '脚手架租赁报价', scopeId: SCOPE_A }).hits.some((hit) => hit.memoryId === secret.id),
      false,
      '重放后检索也不许召回',
    );
  } finally {
    await brainB.close();
  }

  // 原库的删除记录与账本记录仍然自洽
  assert.ok(deletion.ledger);
});


test('checkForRestore 的三个 blocker：缺失 / corrupt / 水位落后于备份 epoch', async (t) => {
  const root = newTempDir(t, 'dsh-m3-ledger-gate-');
  const clock = createClock({ timeZone: 'Asia/Shanghai', now: () => new Date('2026-10-28T10:00:00.000Z') });

  // 1) 缺失
  const missingDir = path.join(root, 'missing');
  const missing = createDeletionLedger({ dir: missingDir, clock });
  const checkMissing = missing.checkForRestore({ backupEpoch: 0, dbPath: path.join(root, 'brain.db') });
  assert.equal(checkMissing.ok, false);
  assert.ok(checkMissing.blockers.includes('LEDGER_MISSING'), `缺失必须拦：${JSON.stringify(checkMissing.blockers)}`);

  // 2) corrupt（手工改一行）
  const corruptDir = path.join(root, 'corrupt');
  const corrupt = createDeletionLedger({ dir: corruptDir, clock });
  corrupt.append({
    tombstoneId: 'tmb_1',
    memoryId: 'mem_1',
    epoch: 1,
    requestedAt: '2026-10-28T10:00:00.000Z',
    scopeId: SCOPE_A,
    reason: '合成用例',
    actor: 'owner',
  });
  const file = path.join(corruptDir, LEDGER_ENTRIES_FILE);
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  const tampered = JSON.parse(lines[0]);
  tampered.memoryId = 'mem_tampered';
  writeFileSync(file, `${JSON.stringify(tampered)}\n`, 'utf8');
  const checkCorrupt = corrupt.checkForRestore({ backupEpoch: 0 });
  assert.equal(checkCorrupt.ok, false);
  assert.ok(checkCorrupt.blockers.includes('LEDGER_CORRUPT'));

  // 3) 水位落后于备份 epoch
  const staleDir = path.join(root, 'stale');
  const stale = createDeletionLedger({ dir: staleDir, clock });
  stale.append({
    tombstoneId: 'tmb_2',
    memoryId: 'mem_2',
    epoch: 2,
    requestedAt: '2026-10-28T10:00:00.000Z',
    scopeId: SCOPE_A,
    reason: '合成用例',
    actor: 'owner',
  });
  const checkStale = stale.checkForRestore({ backupEpoch: 7, dbPath: path.join(root, 'brain.db') });
  assert.equal(checkStale.ok, false);
  assert.ok(checkStale.blockers.includes('LEDGER_STALE_BEHIND_BACKUP'));
  assert.equal(checkStale.ledgerEpoch, 2);
  assert.equal(checkStale.backupEpoch, 7);
  // 恢复工具据此必须 isolationRequired=true（backup3 的判定输入）
  assert.ok(checkStale.blockers.length > 0);
});

test('账本追加失败 → 删除请求必须失败，且 DB 里不留墓碑（事务回滚）', async (t) => {
  const root = newTempDir(t, 'dsh-m3-noledger-');
  const dbPath = path.join(root, 'brain.db');
  const fc = fixedClock();
  const alerts = [];
  // 用「普通文件当目录」制造账本不可用（跨平台稳定，不依赖权限位）
  const blockerFile = path.join(root, 'not-a-dir');
  writeFileSync(blockerFile, 'x', 'utf8');
  const ledgerDir = path.join(blockerFile, 'deletion-ledger');

  const brain = openBrain({
    dbPath,
    clock: fc.clock,
    deletionLedgerDir: ledgerDir,
    alert: (info) => alerts.push(info),
  });
  t.after(async () => {
    try {
      await brain.close();
    } catch {
      /* ignore */
    }
  });

  // 大脑照常起来（账本目录坏了不该拖死整个库）
  assert.equal(brain.deletionLedger.available, false);
  assert.ok(alerts.some((alert) => alert.kind === 'deletion_ledger_unavailable'));

  const created = await brain.memories.create({
    layer: 'long',
    type: 'semantic',
    content: CORPUS.negative.content,
    summary: CORPUS.negative.summary,
    sourceType: 'owner_words',
    sourceIds: CORPUS.negative.sourceIds,
    privacy: 'private',
    originSystem: 'dsh',
    producer: 'm3-test-harness',
  });

  await assert.rejects(
    () =>
      brain.deletion.requestDeletion({
        target_kind: 'memory',
        target_id: created.id,
        scope_id: SCOPE_A,
        reason: '账本写不进去就不许说删了',
        actor: 'owner',
      }),
    (err) => err.code === 'STORAGE_ERROR' && /账本/.test(err.message),
    '账本追加失败 → 整个删除请求必须失败（M3-INTERFACES §1.3）',
  );

  // 事务回滚：没有墓碑、内容还在、还能搜到
  const tomb = /** @type {{ n: number }} */ (
    brain.db.prepare('SELECT COUNT(*) AS n FROM deletion_tombstones WHERE target_id = ?').get(created.id)
  );
  assert.equal(Number(tomb.n), 0, '不允许出现「DB 认为删了、账本没记」的状态');
  assert.ok(brain.memories.get(created.id), '删除失败后内容必须还在');
  assert.equal(brain.memories.search({ query: '总墨量 320%', scopeId: SCOPE_A }).hits.length, 1);
  // epoch 也不能被悄悄抬高（否则检索层会误判）
  const epochRow = /** @type {{ n?: number } | undefined} */ (
    brain.db.prepare("SELECT CAST(value AS INTEGER) AS n FROM brain_meta WHERE key = 'deletion_epoch'").get()
  );
  assert.equal(Number(epochRow?.n ?? 0), 0, '删除失败后 epoch 不许被悄悄抬高');
});

test('并发删除：多条删除交错后各自清理干净，谁都不复活', async (t) => {
  const ctx = createBrain(t);
  const { brain } = ctx;
  const ids = [];
  for (const key of /** @type {const} */ (['card', 'drawing', 'quote', 'identifiers'])) {
    const created = await seed(brain, CORPUS[key]);
    ids.push(created.id);
  }

  // 同一 tick 发起三条删除（真并发：Promise.all，靠单写队列串行）
  const deletions = await Promise.all([
    brain.deletion.requestDeletion({ target_kind: 'memory', target_id: ids[0], scope_id: SCOPE_A, reason: '并发删除 1' }),
    brain.deletion.requestDeletion({ target_kind: 'memory', target_id: ids[2], scope_id: SCOPE_A, reason: '并发删除 2' }),
    brain.deletion.requestDeletion({ target_kind: 'memory', target_id: ids[3], scope_id: SCOPE_A, reason: '并发删除 3' }),
  ]);
  // epoch 严格递增，不重复
  const epochs = deletions.map((entry) => entry.deletion_epoch);
  assert.deepEqual(epochs, [...new Set(epochs)], `并发删除不能拿到同一个 epoch：${JSON.stringify(epochs)}`);

  const run = await brain.deletionWorker.runOnce({ maxJobs: 60 });
  assert.equal(run.failed, 0, `并发清理不该失败：${JSON.stringify(run.jobs.filter((job) => !job.ok))}`);

  for (const id of [ids[0], ids[2], ids[3]]) {
    assert.equal(brain.memories.get(id), null);
  }
  // 没被删的那条还在（并发不许误伤）
  assert.ok(brain.memories.get(ids[1]));

  // 账本记了 3 条，链完整
  const verdict = brain.deletionLedger.verify();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.entryCount, 3);
  const entries = brain.deletionLedger.read().entries;
  assert.deepEqual(
    entries.map((entry) => entry.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    entries.map((entry) => entry.epoch),
    [...epochs],
    '账本里的 epoch 顺序必须与删除顺序一致（单调）',
  );
});

test('账本物理落点在活跃 DB 之外，且只含元数据', async (t) => {
  const ctx = createBrain(t);
  const { brain, dir, dbPath } = ctx;
  const created = await seed(brain, CORPUS.steel);
  await deleteAndPurge(ctx, created.id, '主人要求删除：结施图号弄错了');

  const expectedDir = defaultDeletionLedgerDir({ dbPath });
  assert.equal(brain.deletionLedger.dir, expectedDir);
  assert.equal(expectedDir, path.join(dir, 'deletion-ledger'), '默认落点必须跟着主账目录走');
  assert.notEqual(expectedDir, dbPath);

  const files = readdirSync(expectedDir).sort();
  assert.ok(files.includes(LEDGER_ENTRIES_FILE));
  assert.ok(files.includes('tail.json'));

  // 账本文件里不许出现被删正文
  const raw = readFileSync(path.join(expectedDir, LEDGER_ENTRIES_FILE), 'utf8');
  for (const key of /** @type {const} */ (['card', 'negative', 'drawing', 'steel', 'quote', 'identifiers'])) {
    assert.equal(raw.includes(CORPUS[key].content), false, `账本里不该出现正文：${CORPUS[key].content}`);
  }
  // 但元数据要齐全
  const entry = JSON.parse(raw.split('\n')[0]);
  assert.equal(entry.memoryId, created.id);
  assert.equal(entry.tombstoneId.length > 0, true);
  assert.equal(entry.scopeId, SCOPE_A);
  assert.equal(entry.reason.includes('结施图号弄错了'), true);
  assert.equal(typeof entry.epoch, 'number');
  assert.equal(typeof entry.entryHash, 'string');
});
