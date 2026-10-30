// @ts-check
/**
 * M3 删除 worker（M3-INTERFACES §2）：五步清理、每步屏障重查、四层状态报告。
 *
 * 这里测的是「真删得净、删了不写回、报告不撒谎」：
 *  1. 五步按序执行：正文 → FTS 三表 → context_packages → 导出 → blob 引用；
 *  2. **每步重查屏障**：目标被改回非删除态时一步都不做，而且不把内容写回去；
 *  3. 别的目标发生删除不误伤本目标（M1 实测过的坑，见 m1-notes §4.11）；
 *  4. `deletionStatus` 四层齐全，且**没有任何「已彻底删除」式的过度承诺**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  SCOPE_A,
  CORPUS,
  countRows,
  createBrain,
  docIds,
  readExportJsonl,
  seed,
  writeExportJsonl,
} from './helpers.mjs';

/** 五步的预期顺序（worker 必须按这个顺序跑）。 */
const STEP_ORDER = ['purge_text', 'scrub_index', 'drop_context_packages', 'purge_exports', 'purge_blobs'];

/**
 * 造一个「删了之后要被清理」的完整现场：记忆 + 索引 + 上下文包引用 + 导出文件 + blob 文件。
 * @param {ReturnType<typeof createBrain>} ctx
 * @param {typeof CORPUS.card} item
 */
async function makeScene(ctx, item) {
  const { brain, dir } = ctx;
  const created = await seed(brain, item);

  // 上下文包引用这条记忆（构包片段里可能带正文摘要）
  await brain.contextPackages.save({
    contextId: `ctx_${created.id}`,
    scopeId: SCOPE_A,
    policyVersion: 'v1',
    canonicalHash: `sha256:${'a'.repeat(64)}`,
    segments: [{ memoryId: created.id, version: created.version, text: item.content }],
    builtAt: ctx.fc.nowIso(),
  });

  // 导出文件（带水位的异步导出已落盘）
  const exportsDir = path.join(dir, 'exports');
  const exportFile = writeExportJsonl(exportsDir, 'memories-2026-10-28.jsonl', [
    { id: created.id, memoryId: created.id, content: item.content },
    { id: 'mem_other', memoryId: 'mem_other', content: '别的记忆，不该被动' },
  ]);

  // blob（内容寻址文件名 = content_hash 去掉 sha256:）
  const row = /** @type {{ content_hash: string }} */ (
    brain.db.prepare('SELECT content_hash FROM memories WHERE id = ?').get(created.id)
  );
  const blobsDir = path.join(dir, 'blobs');
  mkdirSync(blobsDir, { recursive: true });
  const blobFile = path.join(blobsDir, row.content_hash.replace(/^sha256:/, ''));
  writeFileSync(blobFile, item.content, 'utf8');

  return { created, exportsDir, exportFile, blobsDir, blobFile, contentHash: row.content_hash };
}

/**
 * 触发删除（只排 M1 默认的 purge_text，M3 完整链由 worker 补齐——这正是要验的）。
 * @param {ReturnType<typeof createBrain>} ctx
 * @param {string} memoryId
 */
async function requestDelete(ctx, memoryId) {
  return ctx.brain.deletion.requestDeletion({
    target_kind: 'memory',
    target_id: memoryId,
    scope_id: SCOPE_A,
    reason: '主人要求删除（合成用例）',
    actor: 'owner',
  });
}

test('五步全跑：正文、FTS 三表、context_packages、导出、blob 引用都没有残留', async (t) => {
  const ctx = createBrain(t);
  const scene = await makeScene(ctx, CORPUS.card);
  const { brain } = ctx;

  const deletion = await requestDelete(ctx, scene.created.id);
  assert.equal(deletion.status, 'accepted');
  assert.ok(deletion.ledger, '删除返回值里必须带账本记录');

  // 删除后立即不可检索（不等 worker）
  assert.equal(brain.memories.search({ query: '铜版纸名片', scopeId: SCOPE_A }).hits.length, 0);

  // M3 worker 补齐缺失的 job 并全部执行
  const result = await brain.deletionWorker.runOnce({ maxJobs: 20 });
  assert.equal(result.failed, 0, `不该有失败步骤：${JSON.stringify(result.jobs)}`);
  assert.equal(result.skipped, 0);
  assert.ok(result.backfilled >= 4, `应补齐 M1 没排的步骤，实际 backfilled=${result.backfilled}`);
  assert.deepEqual(
    result.jobs.map((job) => job.step),
    STEP_ORDER,
    '五步必须按 M3 的顺序执行',
  );
  assert.ok(result.jobs.every((job) => job.ok));

  // 1. 正文清空（memory + versions）
  const mem = /** @type {Record<string, unknown>} */ (
    brain.db.prepare('SELECT content, summary, content_hash, status FROM memories WHERE id = ?').get(scene.created.id)
  );
  assert.equal(mem.content, null);
  assert.equal(mem.summary, null);
  assert.equal(mem.content_hash, null);
  assert.equal(mem.status, 'deleted');
  assert.equal(
    countRows(brain.db, 'memory_versions', 'memory_id = ? AND content IS NOT NULL', [scene.created.id]),
    0,
    'memory_versions 里的正文也必须清',
  );

  // 2. FTS 三表清空
  for (const table of ['search_fts_char', 'search_fts_trigram', 'search_ngram']) {
    assert.equal(docIds(brain.db, table).includes(scene.created.id), false, `${table} 里不该再有这条 doc_id`);
  }
  // 删完词条后照样搜不到（不是靠 status 过滤，是真的没索引了）
  assert.equal(brain.memories.search({ query: '铜版纸名片', scopeId: SCOPE_A }).hits.length, 0);

  // 3. context_packages 引用清掉且内容字段抹掉
  const pkg = /** @type {Record<string, unknown>} */ (
    brain.db.prepare('SELECT status, segments_json, diagnostics_json, memory_versions FROM context_packages WHERE context_id = ?').get(
      `ctx_${scene.created.id}`,
    )
  );
  assert.equal(pkg.status, 'discarded');
  assert.equal(pkg.segments_json, null);
  assert.equal(pkg.diagnostics_json, null);
  assert.equal(pkg.memory_versions, '[]');

  // 4. 导出文件里这条记录被剔除，别人的记录保留
  assert.ok(existsSync(scene.exportFile), '导出文件本身要被保留（只剔除记录，不删文件）');
  const remaining = readExportJsonl(scene.exportFile);
  assert.deepEqual(
    remaining.map((record) => record.id),
    ['mem_other'],
  );

  // 5. blob 引用：文件**不物理删**（备份读者可能还引用），报告里如实说"已无引用但文件还在"
  const blobStep = result.jobs.find((job) => job.step === 'purge_blobs');
  assert.ok(blobStep?.detail, 'blob 步骤必须给 detail');
  const released = /** @type {Array<{ hash: string, filePresent: boolean }>} */ (blobStep.detail?.released ?? []);
  assert.ok(released.some((entry) => entry.hash === scene.contentHash), '应报告该 blob 已无引用');
  assert.equal(released.find((entry) => entry.hash === scene.contentHash)?.filePresent, true);
  assert.equal(blobStep.detail?.physicalFilesRemoved, 0);
  assert.ok(existsSync(scene.blobFile), '物理 blob 不许在这一步删掉（GC 是 backup5 的独立能力）');

  // 墓碑状态推进到 verified（只代表在线清理完成）
  const tomb = /** @type {Record<string, unknown>} */ (
    brain.db.prepare('SELECT status, ledger_synced_at FROM deletion_tombstones WHERE tombstone_id = ?').get(deletion.tombstone_id)
  );
  assert.equal(tomb.status, 'verified');
  assert.ok(tomb.ledger_synced_at !== null, '删除事务里必须同步写过账本');
});

test('每步重查屏障：目标被改回非删除态时一步都不做，也不把内容写回', async (t) => {
  const ctx = createBrain(t);
  const scene = await makeScene(ctx, CORPUS.drawing);
  const { brain } = ctx;
  const deletion = await requestDelete(ctx, scene.created.id);

  // 模拟"删除之后世界变了"：目标被恢复流程/脏写改回 active（内容也回来了）
  brain.db
    .prepare("UPDATE memories SET status = 'active', content = ?, summary = ?, deletion_epoch = 0 WHERE id = ?")
    .run(CORPUS.drawing.content, CORPUS.drawing.summary, scene.created.id);

  const result = await brain.deletionWorker.runOnce({ maxJobs: 20 });
  assert.equal(result.failed, 0, `屏障拒绝不算失败：${JSON.stringify(result.jobs)}`);
  assert.equal(result.skipped, STEP_ORDER.length, `五步都该被屏障拦住，实际：${JSON.stringify(result.jobs)}`);

  // 内容必须还在（worker 不许把已恢复的内容清掉——它不是删除目标了）
  const mem = /** @type {Record<string, unknown>} */ (
    brain.db.prepare('SELECT status, content FROM memories WHERE id = ?').get(scene.created.id)
  );
  assert.equal(mem.status, 'active');
  assert.equal(mem.content, CORPUS.drawing.content);
  // 索引、导出、blob 也都没被动
  assert.ok(docIds(brain.db, 'search_fts_trigram').includes(scene.created.id), '索引不该被清');
  assert.equal(readExportJsonl(scene.exportFile).length, 2, '导出不该被改');
  assert.ok(existsSync(scene.blobFile));

  // 墓碑还在但没被标成 verified（没清理成功就不许说清理好了）
  const tomb = /** @type {{ status: string }} */ (
    brain.db.prepare('SELECT status FROM deletion_tombstones WHERE tombstone_id = ?').get(deletion.tombstone_id)
  );
  assert.notEqual(tomb.status, 'verified');
});

test('旧 worker 不写回：跑完之后没有任何一处内容被重新填上', async (t) => {
  const ctx = createBrain(t);
  const scene = await makeScene(ctx, CORPUS.steel);
  const { brain } = ctx;
  await requestDelete(ctx, scene.created.id);

  // 跑两轮（第二轮应无事可做），中间推进时间模拟"旧 worker 晚到"
  const first = await brain.deletionWorker.runOnce({ maxJobs: 20 });
  assert.equal(first.failed, 0);
  ctx.fc.advance(60_000);
  const second = await brain.deletionWorker.runOnce({ maxJobs: 20 });
  assert.equal(second.processed, 0, '没有新 job 可认领（全部 done）');
  assert.equal(second.failed, 0);

  // 关键断言：正文一直是 NULL，没有被"补写"回来
  const mem = /** @type {Record<string, unknown>} */ (
    brain.db.prepare('SELECT content, summary FROM memories WHERE id = ?').get(scene.created.id)
  );
  assert.equal(mem.content, null);
  assert.equal(mem.summary, null);
  assert.equal(
    countRows(brain.db, 'memory_versions', 'memory_id = ? AND (content IS NOT NULL OR summary IS NOT NULL)', [scene.created.id]),
    0,
  );
  // 索引也没被重建
  for (const table of ['search_fts_char', 'search_fts_trigram', 'search_ngram']) {
    assert.equal(docIds(brain.db, table).includes(scene.created.id), false);
  }
});

test('别的目标发生删除不误伤本目标（先删 A 再删 B，A 的步骤照样能跑完）', async (t) => {
  const ctx = createBrain(t);
  const { brain } = ctx;
  const a = await seed(brain, CORPUS.card);
  const b = await seed(brain, CORPUS.quote);

  const delA = await requestDelete(ctx, a.id);
  const delB = await requestDelete(ctx, b.id);
  assert.ok(delB.deletion_epoch > delA.deletion_epoch);

  const result = await brain.deletionWorker.runOnce({ maxJobs: 40 });
  assert.equal(result.failed, 0, `删除 epoch 前进了不该让 A 的 job 失败：${JSON.stringify(result.jobs)}`);
  assert.equal(result.skipped, 0);

  for (const id of [a.id, b.id]) {
    const mem = /** @type {{ content: string|null, status: string }} */ (
      brain.db.prepare('SELECT content, status FROM memories WHERE id = ?').get(id)
    );
    assert.equal(mem.content, null, `${id} 的正文应被清`);
    assert.equal(mem.status, 'deleted');
    for (const table of ['search_fts_char', 'search_fts_trigram', 'search_ngram']) {
      assert.equal(docIds(brain.db, table).includes(id), false, `${table} 里 ${id} 应已清`);
    }
  }
});

test('陈旧 job（墓碑已 failed）不会把 worker 拖死：标跳过、不重试、不抛错', async (t) => {
  const ctx = createBrain(t);
  const { brain } = ctx;
  const created = await seed(brain, CORPUS.negative);
  const deletion = await requestDelete(ctx, created.id);

  // 模拟"清理已经放弃（墓碑 failed），但遗留了 job"
  brain.db.prepare('DELETE FROM deletion_jobs WHERE tombstone_id = ?').run(deletion.tombstone_id);
  brain.db.prepare("UPDATE deletion_tombstones SET status = 'failed' WHERE tombstone_id = ?").run(deletion.tombstone_id);
  brain.db
    .prepare(
      `INSERT INTO deletion_jobs (job_id, tombstone_id, target_kind, target_id, scope_id, kind, status, attempts, max_attempts, deletion_epoch, created_at, created_at_local)
       VALUES ('job_orphan', ?, 'memory', ?, 'owner-default', 'purge_text', 'pending', 0, 5, ?, ?, ?)`,
    )
    .run(deletion.tombstone_id, created.id, deletion.deletion_epoch, ctx.fc.nowIso(), ctx.fc.nowIso());

  const result = await brain.deletionWorker.runOnce({ maxJobs: 10 });
  assert.equal(result.failed, 0);
  assert.equal(result.skipped, 1);
  const orphan = result.jobs.find((job) => job.jobId === 'job_orphan');
  assert.ok(orphan?.skipped);
  assert.equal(orphan?.detail?.barrier, 'tombstone_failed');
  // 标成 done，避免每轮重试到 dead
  const row = /** @type {{ status: string, attempts: number }} */ (
    brain.db.prepare('SELECT status, attempts FROM deletion_jobs WHERE job_id = ?').get('job_orphan')
  );
  assert.equal(row.status, 'done');
  assert.equal(row.attempts, 1);
});

test('deletionStatus：四层字段齐全，且没有任何「已彻底删除」式承诺', async (t) => {
  const ctx = createBrain(t);
  const scene = await makeScene(ctx, CORPUS.identifiers);
  const { brain } = ctx;

  // 造一条已完成的备份记录（算「旧备份最晚到期」用）
  const backupCreatedAt = ctx.fc.nowIso();
  brain.db
    .prepare(
      `INSERT INTO backups (backup_id, kind, path, status, created_at, created_at_local)
       VALUES ('bk_test_1', 'daily', 'data/backups/test', 'complete', ?, ?)`,
    )
    .run(backupCreatedAt, backupCreatedAt);

  const before = brain.deletionWorker.deletionStatus(scene.created.id);
  assert.equal(before.found, false, '没删过的记忆应报 found=false 而不是编一份状态');
  assert.ok(Array.isArray(before.notes) && before.notes.length > 0);

  const deletion = await requestDelete(ctx, scene.created.id);
  ctx.fc.advance(5_000);
  await brain.deletionWorker.runOnce({ maxJobs: 20 });

  const status = brain.deletionWorker.deletionStatus(scene.created.id);
  assert.equal(status.found, true);
  assert.equal(status.memoryId, scene.created.id);

  // ---- 四层：一层都不能少 ----
  // 1 立即屏蔽（= 写 tombstone 那一刻，不是 worker 跑完那一刻）
  assert.equal(status.shieldedAt, backupCreatedAt);
  assert.ok(typeof status.shieldedAt === 'string' && status.shieldedAt.endsWith('Z'));
  // 2 在线清理完成
  assert.ok(typeof status.workerDoneAt === 'string', '五步跑完必须有 workerDoneAt');
  assert.equal(status.workerState, 'done');
  // 3 旧备份最晚到期（= 备份时间 + 保留天数，绝对时间算）
  assert.equal(status.backupExpiryBasis, 'retention-policy');
  assert.equal(status.backupRetentionDays, 7);
  assert.equal(status.backupExpiryAt, new Date(Date.parse(backupCreatedAt) + 7 * 86400_000).toISOString());
  // 4 外部副本 + 宿主副本
  assert.ok(Array.isArray(status.externalCopies) && status.externalCopies.length > 0);
  for (const copy of status.externalCopies) {
    assert.equal(copy.verified, false, '没核实的外部副本必须 verified=false');
    assert.ok(typeof copy.kind === 'string');
  }
  assert.ok(Array.isArray(status.hostCopies) && status.hostCopies.length > 0);
  for (const copy of status.hostCopies) {
    assert.equal(copy.handled, false, '其它源记录我们没处理，不许写 handled=true');
    assert.ok(['dsh', 'engram', 'lingshu'].includes(copy.system));
  }
  // 进度与账本
  assert.deepEqual(status.progress, { total: 5, done: 5, failed: 0 });
  assert.equal(status.ledgerSynced, true);
  assert.equal(status.steps.length, 5);

  // ---- 诚实边界：不许出现"已彻底删除"这类话 ----
  const text = JSON.stringify(status);
  for (const forbidden of ['已彻底删除', '彻底删除', '已物理删除', '已完全清除', '无法恢复']) {
    assert.equal(text.includes(forbidden), false, `状态报告里不许出现「${forbidden}」`);
  }
  assert.deepEqual(status.claims, { physicallyErased: false, backupsExpired: false, externalRetracted: false });
  assert.equal(
    status.notes.some((note) => note.includes('物理残留清理') || note.includes('不等于「7 天内物理删净」') || note.includes('单独能力')),
    true,
    `必须说明物理残留是单独能力，实际 notes：${JSON.stringify(status.notes)}`,
  );
  assert.equal(
    status.notes.some((note) => note.includes('无法追溯撤回')),
    true,
    '必须说明已发到外部服务的内容无法撤回',
  );
});

test('deletionStatus 在步骤失败时如实报 failed，不假装 done', async (t) => {
  const ctx = createBrain(t);
  const { brain } = ctx;
  const created = await seed(brain, CORPUS.steel);
  const deletion = await requestDelete(ctx, created.id);

  // 先把五步补齐（M1 只排了 purge_text），再把其中一步弄成 dead（模拟清理失败达上限）
  await brain.deletionWorker.ensureQueued();
  const patched = brain.db
    .prepare("UPDATE deletion_jobs SET status = 'dead', last_error = '模拟失败' WHERE tombstone_id = ? AND kind = 'scrub_index'")
    .run(deletion.tombstone_id);
  assert.equal(Number(patched.changes), 1, '应先补出 scrub_index 这一步再把它弄失败');
  await brain.deletionWorker.runOnce({ maxJobs: 20, includeBackfill: false });

  const status = brain.deletionWorker.deletionStatus(created.id);
  assert.equal(status.workerDoneAt, null, '有失败步骤就不能声称在线清理完成');
  assert.ok(['failed', 'partial', 'pending'].includes(String(status.workerState)));
  assert.ok(Number(status.progress.failed) >= 1);
  assert.ok(
    status.notes.some((note) => note.includes('失败')),
    `失败要写进 notes，实际：${JSON.stringify(status.notes)}`,
  );
});

test('备份记录缺失时说「算不出来」，不伪造到期时间', async (t) => {
  const ctx = createBrain(t);
  const created = await seed(ctx.brain, CORPUS.negative);
  await requestDelete(ctx, created.id);
  const status = ctx.brain.deletionWorker.deletionStatus(created.id);
  assert.equal(status.backupExpiryAt, null);
  assert.equal(status.backupExpiryBasis, 'no-backup-records');
  assert.ok(status.notes.some((note) => note.includes('算不出')));
  assert.equal(status.claims.backupsExpired, false);
});
