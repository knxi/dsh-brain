// @ts-check
/**
 * 备份中心 + 恢复编排：列表、复校、能力闸门、**默认 dry-run**。
 *
 * 最重要的一条：`POST /api/restore/execute` 漏传参数时**什么都没发生**。
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  assert,
  createTempBrain,
  seedBackupRow,
  setDeletionEpoch,
  startUiServer,
} from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof startUiServer>>} */
let server;
/** @type {Awaited<ReturnType<typeof createTempBrain>>} */
let tmp;

test.before(async () => {
  tmp = await createTempBrain();
  seedBackupRow(tmp.brain, {
    backupId: 'bk_seed_a',
    createdAt: '2026-10-20T03:00:00.000Z',
    retentionUntil: '2026-11-20T03:00:00.000Z',
  });
  setDeletionEpoch(tmp.brain, 5);
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
// 备份列表
// ---------------------------------------------------------------------------

test('GET /api/backups：列表带校验状态、水位与能力矩阵', async () => {
  const { status, json } = await server.request('/api/backups');
  assert.equal(status, 200);
  assert.equal(json.available, true);
  assert.ok(Array.isArray(json.items));
  assert.ok(json.items.length >= 1);
  assert.equal(typeof json.dir, 'string');
  assert.equal(typeof json.keepDays, 'number');
  // 当前删除水位要能跟每份备份的水位对比（判断「恢复会不会让内容复活」）
  assert.equal(json.currentDeletionEpoch, 5);
  assert.deepEqual(json.capability, { backup: false, verify: true });

  const one = json.items[0];
  for (const field of ['backupId', 'kind', 'fileName', 'byteSize', 'schemaVersion', 'watermark', 'deletionEpoch', 'integrity', 'exists']) {
    assert.ok(field in one, `备份条目缺字段 ${field}`);
  }
});

test('文件不存在的备份要标 missing_file，不能显示成健康', async () => {
  const { json } = await server.request('/api/backups');
  const seeded = json.items.find((b) => b.backupId === 'bk_seed_a');
  assert.ok(seeded);
  assert.equal(seeded.exists, false);
  assert.equal(seeded.integrity, 'missing_file');
});

// ---------------------------------------------------------------------------
// 触发备份：需 capability
// ---------------------------------------------------------------------------

test('POST /api/backups：能力未开 → 403 CAPABILITY_REQUIRED（不是 500）', async () => {
  const { status, json } = await server.request('/api/backups', { method: 'POST', body: {} });
  assert.equal(status, 403);
  assert.equal(json.error.code, 'CAPABILITY_REQUIRED');
  assert.equal(json.error.details.capability, 'backup');
  assert.match(String(json.error.details.howToEnable), /allow-backup/);
});

test('POST /api/backups：开了能力能真跑，并落出可校验的文件', async () => {
  const enabled = await startUiServer({
    dbPath: tmp.dbPath,
    backupDir: tmp.backupsDir,
    stateDir: tmp.stateDir,
    allowBackup: true,
  });
  try {
    const created = await enabled.request('/api/backups', { method: 'POST', body: {} });
    assert.equal(created.status, 201, created.text);
    assert.equal(created.json.available, true);
    assert.equal(created.json.implementation, 'm1Backup');
    assert.ok(typeof created.json.dir === 'string' && created.json.dir.length > 0);
    assert.ok(existsSync(created.json.dir), '备份文件应当真的落盘了');

    const list = await enabled.request('/api/backups');
    const fresh = list.json.items.find((b) => b.path === created.json.dir);
    assert.ok(fresh, '备份记录应当出现在列表里');
    assert.equal(fresh.integrity, 'ok');
    assert.equal(fresh.verified, true);

    // 复校：目录名 → verify
    const dirName = path.basename(String(created.json.dir));
    const verified = await enabled.request(`/api/backups/${encodeURIComponent(dirName)}/verify`);
    assert.equal(verified.status, 200, verified.text);
    assert.equal(verified.json.ok, true);
  } finally {
    await enabled.close();
  }
});

test('GET /api/backups/:dir/verify：目录名非法 → 400（防路径穿越）', async () => {
  // 注意：`..` 本身测不到——fetch 会在发出前把 `/api/backups/../verify` 规范化成 `/api/verify`。
  // 真正要挡的是「段内编码的分隔符 / 首字符非字母数字 / 越过 backupDir」。
  for (const dir of ['a%2Fb', '..%2Fetc', '.hidden', '-dash', 'x'.repeat(200)]) {
    const { status } = await server.request(`/api/backups/${dir}/verify`);
    assert.equal(status, 400, `${dir} 应被拒`);
  }
  // 合法但不存在 → 交给校验逻辑（不是 400）
  const missing = await server.request('/api/backups/does-not-exist/verify');
  assert.ok([200, 500].includes(missing.status), `合法目录名不该 400，实际 ${missing.status}`);
});

// ---------------------------------------------------------------------------
// 恢复预演
// ---------------------------------------------------------------------------

test('POST /api/restore/plan：缺 backupDir → 400', async () => {
  const { status, json } = await server.request('/api/restore/plan', { method: 'POST', body: {} });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'INVALID_ARGUMENT');
});

test('POST /api/restore/plan：账本缺失时必须报 blocker，并要求隔离上架', async () => {
  const { status, json } = await server.request('/api/restore/plan', {
    method: 'POST',
    body: { backupDir: 'bk_seed_a' },
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.ok, false);
  assert.equal(json.isolationRequired, true);
  assert.ok(
    json.blockers.some((b) => b.includes('LEDGER_MISSING')),
    `blockers 里应有 LEDGER_MISSING，实际 ${JSON.stringify(json.blockers)}`,
  );
  assert.ok(Array.isArray(json.steps) && json.steps.length >= 5, '要给出可读的恢复步骤');
  // 预演就是预演：不能顺手改了库
  assert.equal(existsSync(path.join(tmp.stateDir, 'restore-state.json')), false);
});

test('POST /api/restore/plan：不存在的备份目录 → BACKUP_NOT_FOUND', async () => {
  const { json } = await server.request('/api/restore/plan', {
    method: 'POST',
    body: { backupDir: 'no-such-backup' },
  });
  assert.equal(json.ok, false);
  assert.ok(json.blockers.some((b) => b.includes('BACKUP_NOT_FOUND')));
});

// ---------------------------------------------------------------------------
// 恢复执行：默认 dry-run
// ---------------------------------------------------------------------------

test('POST /api/restore/execute：漏传 dryRun 时**只预演**，什么都不发生', async () => {
  const { status, json } = await server.request('/api/restore/execute', {
    method: 'POST',
    body: { backupDir: 'bk_seed_a' },
  });
  assert.equal(status, 200);
  assert.equal(json.dryRun, true);
  assert.equal(json.executed, false);
  assert.equal(json.promoted, null);
  assert.equal(json.confirmationRequired, true);
  assert.ok(json.plan, '预演结果要带回来');
  assert.match(String(json.note), /库没有被改动/);
  // 关键断言：没有留下任何执行痕迹
  assert.equal(existsSync(path.join(tmp.stateDir, 'restore-state.json')), false);
});

test('POST /api/restore/execute：dryRun:true 显式预演，同样不执行', async () => {
  const { json } = await server.request('/api/restore/execute', {
    method: 'POST',
    body: { backupDir: 'bk_seed_a', dryRun: true, confirm: 'RESTORE' },
  });
  assert.equal(json.dryRun, true);
  assert.equal(json.executed, false);
  assert.equal(existsSync(path.join(tmp.stateDir, 'restore-state.json')), false);
});

test('POST /api/restore/execute：dryRun:false 但没 confirm → 400，且不执行', async () => {
  const { status, json } = await server.request('/api/restore/execute', {
    method: 'POST',
    body: { backupDir: 'bk_seed_a', dryRun: false },
  });
  assert.equal(status, 400);
  assert.equal(json.error.code, 'CONFIRMATION_REQUIRED');
  assert.equal(existsSync(path.join(tmp.stateDir, 'restore-state.json')), false);
});

test('POST /api/restore/execute：confirm 写错（小写/近似）同样拒绝', async () => {
  for (const confirm of ['restore', 'RESTORE ', 'YES', 'RESTOREX']) {
    const { status, json } = await server.request('/api/restore/execute', {
      method: 'POST',
      body: { backupDir: 'bk_seed_a', dryRun: false, confirm },
    });
    assert.equal(status, 400, `confirm=${JSON.stringify(confirm)} 应被拒`);
    assert.equal(json.error.code, 'CONFIRMATION_REQUIRED');
  }
});

test('POST /api/restore/execute：三重都满足但能力没开 → 403，仍不执行', async () => {
  const { status, json } = await server.request('/api/restore/execute', {
    method: 'POST',
    body: { backupDir: 'bk_seed_a', dryRun: false, confirm: 'RESTORE' },
  });
  assert.equal(status, 403);
  assert.equal(json.error.code, 'CAPABILITY_REQUIRED');
  assert.equal(json.error.details.capability, 'restore');
  assert.equal(existsSync(path.join(tmp.stateDir, 'restore-state.json')), false);
});

test('POST /api/restore/execute：能力开了但恢复门面缺失 → 501 NOT_AVAILABLE，不假装成功', async () => {
  const enabled = await startUiServer({
    dbPath: tmp.dbPath,
    backupDir: tmp.backupsDir,
    stateDir: tmp.stateDir,
    allowRestore: true,
  });
  try {
    const { status, json } = await enabled.request('/api/restore/execute', {
      method: 'POST',
      body: { backupDir: 'bk_seed_a', dryRun: false, confirm: 'RESTORE' },
    });
    assert.equal(status, 501, JSON.stringify(json));
    assert.equal(json.error.code, 'NOT_AVAILABLE');
    assert.equal(json.error.details.capability, 'restore.executeRestore');
    assert.equal(existsSync(path.join(tmp.stateDir, 'restore-state.json')), false);

    // 同一个实例上预演仍然可用
    const plan = await enabled.request('/api/restore/plan', {
      method: 'POST',
      body: { backupDir: 'bk_seed_a' },
    });
    assert.equal(plan.status, 200);
    assert.equal(plan.json.implementation, 'local-fallback');
  } finally {
    await enabled.close();
  }
});

test('健康页能看到能力矩阵与门面接入情况', async () => {
  const { json } = await server.request('/api/health');
  assert.equal(typeof json.capabilities, 'object');
  assert.equal(json.capabilities.backup, false);
  assert.equal(json.capabilities.restore, false);
  assert.equal(json.capabilities.diagnose, true);
  assert.equal(typeof json.capabilities.facades, 'object');
  // M3 的 del3 门面已接入；恢复编排还在并行线上，缺失时必须如实报 false
  assert.equal(json.capabilities.facades.deletionLedger, true);
  assert.equal(json.capabilities.facades.deletionWorker, true);
  assert.equal(json.capabilities.facades.m1Backup, true, 'M1 备份服务应当可用');
  assert.equal(typeof json.governance.backupDir, 'string');
  assert.equal(json.isolation.active, false);
  assert.equal(json.isolation.canServe, true);
});
