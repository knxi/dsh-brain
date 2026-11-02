// @ts-check
/**
 * 删除四层报告：字段齐全、四层不许合并、三种清理状态各自如实呈现。
 */

import test from 'node:test';
import {
  assert,
  createTempBrain,
  seedBackupRow,
  seedDeletion,
  setDeletionEpoch,
  startUiServer,
} from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof startUiServer>>} */
let server;
/** @type {Awaited<ReturnType<typeof createTempBrain>>} */
let tmp;

test.before(async () => {
  tmp = await createTempBrain();
  // 三种清理状态：已完成 / 还没开始 / 失败。
  // 删除走真实路径（账本会同步追加），时间再改成「几天前」以便和备份顺序对上。
  await seedDeletion(tmp.brain, {
    memoryId: 'mem-m3-ceiling',
    requestedAt: '2026-10-20T10:00:00.000Z',
    jobs: [
      { status: 'done', finishedAt: '2026-10-20T10:00:05.000Z' },
      { kind: 'scrub_index', status: 'done', finishedAt: '2026-10-20T10:00:06.000Z' },
    ],
  });
  await seedDeletion(tmp.brain, {
    memoryId: 'mem-m3-partition',
    requestedAt: '2026-10-27T10:00:00.000Z',
    jobs: [],
  });
  await seedDeletion(tmp.brain, {
    memoryId: 'mem-m3-drawing',
    requestedAt: '2026-10-28T09:00:00.000Z',
    jobs: [
      { status: 'done', finishedAt: '2026-10-28T09:00:01.000Z' },
      { kind: 'purge_blobs', status: 'failed', lastError: 'EBUSY: 文件被占用' },
    ],
  });

  // 一份「删除之前」的备份（含风险）+ 一份「删除之后」的备份（无风险）
  seedBackupRow(tmp.brain, {
    backupId: 'bk_before_delete',
    createdAt: '2026-10-19T03:00:00.000Z',
    retentionUntil: '2026-11-19T03:00:00.000Z',
  });
  seedBackupRow(tmp.brain, {
    backupId: 'bk_after_delete',
    createdAt: '2026-10-25T03:00:00.000Z',
    retentionUntil: '2026-11-25T03:00:00.000Z',
  });
  setDeletionEpoch(tmp.brain, 3);

  server = await startUiServer({
    dbPath: tmp.dbPath,
    backupDir: tmp.backupsDir,
    stateDir: tmp.stateDir,
  });
});

test.after(async () => {
  await server?.close();
  await tmp?.close();
});

// ---------------------------------------------------------------------------
// 四层结构
// ---------------------------------------------------------------------------

test('GET /api/deletions/:id：四层都在，且每层有自己的时间与状态', async () => {
  const { status, json } = await server.request('/api/deletions/mem-m3-ceiling');
  assert.equal(status, 200);
  assert.equal(json.deleted, true);
  assert.equal(json.layers.shielded.done, true);

  for (const key of ['shielded', 'onlineCleanup', 'backupExpiry', 'external']) {
    assert.ok(json.layers[key], `缺少第 ${key} 层`);
    assert.equal(typeof json.layers[key].title, 'string');
    assert.equal(typeof json.layers[key].basis, 'string');
    assert.equal(typeof json.layers[key].index, 'number');
  }

  // 四层不是同一件事：屏蔽必然完成，其余三层各自表达
  assert.equal(json.layers.shielded.status, 'done');
  assert.notEqual(json.layers.external.status, 'done');
  assert.equal(json.layers.external.done, false);
});

test('第 2 层：清理完成时给完成时间；没任务时是「还没开始」，不是「已完成」', async () => {
  const done = await server.request('/api/deletions/mem-m3-ceiling');
  assert.equal(done.json.layers.onlineCleanup.status, 'done');
  assert.equal(done.json.layers.onlineCleanup.done, true);
  assert.equal(typeof done.json.layers.onlineCleanup.at, 'string');
  assert.deepEqual(done.json.layers.onlineCleanup.jobs.done, 2);

  const notStarted = await server.request('/api/deletions/mem-m3-partition');
  assert.equal(notStarted.json.layers.onlineCleanup.status, 'not_started');
  assert.equal(notStarted.json.layers.onlineCleanup.done, false);
  // 关键：没有任务 ≠ 已清理完。at 必须是 null。
  assert.equal(notStarted.json.layers.onlineCleanup.at, null);
});

test('第 2 层：失败要能看见失败，不许显示成完成', async () => {
  const { json } = await server.request('/api/deletions/mem-m3-drawing');
  assert.equal(json.layers.onlineCleanup.status, 'partial');
  assert.equal(json.layers.onlineCleanup.done, false);
  assert.equal(json.layers.onlineCleanup.at, null, '有失败任务时不能给「完成时间」');
  assert.equal(json.layers.onlineCleanup.jobs.failed, 1);
  assert.ok(
    json.layers.onlineCleanup.errors.some((e) => e.includes('EBUSY')),
    '失败原因要透出来',
  );
});

test('第 3 层：只把「删除之前」的备份算作风险，并给出最晚到期时间', async () => {
  const { json } = await server.request('/api/deletions/mem-m3-ceiling');
  const layer = json.layers.backupExpiry;
  assert.equal(layer.status, 'computed');
  // 到期时间可能是本地按保留策略算的，也可能来自 del3 的官方报告；两种都必须落在删除之后
  assert.equal(typeof layer.at, 'string');
  assert.ok(
    new Date(String(layer.at)).getTime() > new Date('2026-10-20T10:00:00.000Z').getTime(),
    `到期时间应当晚于删除时刻，实际 ${String(layer.at)}`,
  );
  assert.ok(Array.isArray(layer.riskyBackups));
  // 风险列表由本地精确计算：只有删除之前那份备份才算
  assert.equal(layer.riskyBackups.length, 1);
  assert.equal(layer.riskyBackups[0].backupId, 'bk_before_delete');
  assert.equal(
    layer.riskyBackups.some((b) => b.backupId === 'bk_after_delete'),
    false,
  );
});

test('第 3 层：没有删除前备份时明确说「不存在」，不编一个时间', async () => {
  // 这条删除发生在所有备份之前（2026-10-01），而最早的备份是 10-19
  await seedDeletion(tmp.brain, {
    memoryId: 'mem-m3-early',
    requestedAt: '2026-10-01T00:00:00.000Z',
    jobs: [{ status: 'done', finishedAt: '2026-10-01T00:00:02.000Z' }],
  });
  const { json } = await server.request('/api/deletions/mem-m3-early');
  assert.equal(json.layers.backupExpiry.status, 'no_risky_backup');
  assert.equal(json.layers.backupExpiry.at, null);
  assert.deepEqual(json.layers.backupExpiry.riskyBackups, []);
});

test('第 4 层：默认就是「未核实 / 未处理」，不许显示成已清干净', async () => {
  const { json } = await server.request('/api/deletions/mem-m3-ceiling');
  const layer = json.layers.external;
  assert.equal(layer.done, false);
  assert.equal(layer.status, 'unverified');
  assert.ok(layer.externalCopies.length > 0);
  assert.ok(layer.externalCopies.every((c) => c.verified === false), '没有登记表时一律标未核实');
  assert.equal(layer.hostCopies.length, 3);
  assert.ok(layer.hostCopies.every((c) => c.handled === false));
  assert.deepEqual(
    layer.hostCopies.map((c) => c.system).sort(),
    ['dsh', 'engram', 'lingshu'],
  );
  assert.ok(layer.unverifiedCount > 0);
  assert.ok(layer.unhandledCount > 0);
});

test('独立账本：真实删除路径下 ledgerSynced 必须为 true（不是 null 也不是 false）', async () => {
  const { json } = await server.request('/api/deletions/mem-m3-ceiling');
  // 只有三种取值有意义：true=已记账、false=DB 删了账本没记（危险）、null=账本不可用（未知）
  assert.ok([true, false, null].includes(json.ledgerSynced), `意外值 ${String(json.ledgerSynced)}`);
  assert.equal(typeof json.ledgerDetail, 'string');
  // del3 的门面已接入；走真实删除路径时账本一定同步
  assert.equal(json.ledgerSynced, true, '走 requestDeletion 的删除应当已记入独立账本');
  // 门面的「三不」声明也要透出来（物理擦除 / 备份过期 / 外部撤回）
  if (json.claims !== null) {
    assert.equal(typeof json.claims, 'object');
    assert.ok('physicallyErased' in json.claims);
    assert.ok('backupsExpired' in json.claims);
    assert.ok('externalRetracted' in json.claims);
  }
});

test('顶层结论必须带前提：caveats 里写明「屏蔽/清理/备份不是同一刻」', async () => {
  const { json } = await server.request('/api/deletions/mem-m3-ceiling');
  assert.ok(Array.isArray(json.caveats) && json.caveats.length >= 2);
  const joined = json.caveats.join(' ');
  assert.match(joined, /屏蔽是立即的/);
  assert.match(joined, /无法追溯撤回/);
  assert.equal(typeof json.summary, 'string');
});

test('未删除的记忆：明确说没有墓碑，而不是四层全绿', async () => {
  const { status, json } = await server.request('/api/deletions/mem-not-deleted');
  assert.equal(status, 200);
  assert.equal(json.deleted, false);
  assert.equal(json.layers, null);
});

// ---------------------------------------------------------------------------
// 待清理列表
// ---------------------------------------------------------------------------

test('GET /api/deletions?status=pending：只列没清完的，带进度', async () => {
  const { status, json } = await server.request('/api/deletions', { query: { status: 'pending' } });
  assert.equal(status, 200);
  assert.equal(json.available, true);
  const ids = json.items.map((i) => i.memoryId);
  assert.ok(ids.includes('mem-m3-partition'), '没开始的应出现在待清理里');
  assert.ok(ids.includes('mem-m3-drawing'), '有失败的应出现在待清理里');
  assert.equal(ids.includes('mem-m3-ceiling'), false, '已清完的不该出现在待清理里');
  for (const item of json.items) {
    assert.equal(typeof item.progress.total, 'number');
    assert.equal(typeof item.progress.done, 'number');
    assert.ok(item.status !== 'done');
  }
});

test('GET /api/deletions?status=completed：只列清完的', async () => {
  const { json } = await server.request('/api/deletions', { query: { status: 'completed' } });
  assert.ok(json.items.length >= 1);
  assert.ok(json.items.every((i) => i.status === 'done'));
});

test('GET /api/deletions?status=非法 → 400', async () => {
  const { status, json } = await server.request('/api/deletions', { query: { status: 'whatever' } });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'INVALID_ARGUMENT');
});

test('删除 worker 已接入时如实标 available 并说明它会推进清理', async () => {
  const { json } = await server.request('/api/deletions', { query: { status: 'pending' } });
  assert.equal(json.facade, 'available');
  assert.match(String(json.note), /已接入/);
});
