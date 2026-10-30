// @ts-check
/**
 * 隔离实例：`promoted=false` 时必须**拒绝提供正常服务**，只能只读检修。
 *
 * 横幅只是让人看见，闸门才是拦得住。两个都要测。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assert, createTempBrain, startUiServer } from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof createTempBrain>>} */
let tmp;

test.before(async () => {
  tmp = await createTempBrain();
});

test.after(async () => {
  await tmp?.close();
});

/** @param {string} dbPath @param {Record<string, unknown>} [extra] */
function boot(dbPath, extra = {}) {
  return startUiServer({
    dbPath,
    backupDir: tmp.backupsDir,
    stateDir: tmp.stateDir,
    ...extra,
  });
}

// ---------------------------------------------------------------------------
// 正常实例：不该有横幅
// ---------------------------------------------------------------------------

test('普通实例：isolation.active=false，canServe=true，health.ok=true', async () => {
  const server = await boot(tmp.dbPath);
  try {
    const { json } = await server.request('/api/health');
    assert.equal(json.isolation.active, false);
    assert.equal(json.isolation.canServe, true);
    assert.equal(json.isolation.banner, null);
    assert.equal(json.ok, true);
    assert.deepEqual(json.isolation.reasons, []);
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 显式隔离：配置置位
// ---------------------------------------------------------------------------

test('显式隔离：health 报 active，横幅文案明确说「不能上线」', async () => {
  const server = await boot(tmp.dbPath, { isolationReason: '恢复演练：故意隔离' });
  try {
    const { json } = await server.request('/api/health');
    assert.equal(json.isolation.active, true);
    assert.equal(json.isolation.canServe, false);
    assert.equal(json.isolation.source, 'config');
    assert.equal(json.isolation.banner, '这个实例不能上线，只能只读检修');
    assert.ok(json.isolation.reasons.some((r) => r.code === 'EXPLICIT_ISOLATION'));
    assert.ok(json.isolation.reasons.every((r) => r.severity === 'blocker'));
    // 隔离实例不该说自己 ok
    assert.equal(json.ok, false);
  } finally {
    await server.close();
  }
});

test('隔离实例：写操作被 403 挡住（横幅看得见，闸门拦得住）', async () => {
  const server = await boot(tmp.dbPath, { isolationReason: '测试隔离闸门' });
  try {
    const create = await server.request('/api/memories', {
      method: 'POST',
      body: { content: '隔离期间不该写进去的内容' },
    });
    assert.equal(create.status, 403);
    assert.equal(create.json.error.code, 'ISOLATED_INSTANCE');
    assert.equal(create.json.error.details.isolation.active, true);
    assert.match(String(create.json.error.details.isolation.howToRecover), /restore/);

    const remove = await server.request('/api/memories/mem-m3-ceiling', { method: 'DELETE' });
    assert.equal(remove.status, 403);
    assert.equal(remove.json.error.code, 'ISOLATED_INSTANCE');
  } finally {
    await server.close();
  }
});

test('隔离实例：只读诊断照常可用', async () => {
  const server = await boot(tmp.dbPath, { isolationReason: '测试只读诊断' });
  try {
    for (const pathname of ['/api/health', '/api/memories', '/api/deletions', '/api/backups', '/api/contexts']) {
      const res = await server.request(pathname);
      assert.equal(res.status, 200, `${pathname} 在隔离实例上应当仍可读`);
    }
    // 检索也该能跑
    const search = await server.request('/api/search', { query: { q: '吊顶' } });
    assert.equal(search.status, 200);
  } finally {
    await server.close();
  }
});

test('隔离实例：修复路径（restore / backup）不被闸门误伤', async () => {
  const server = await boot(tmp.dbPath, { isolationReason: '测试修复路径放行' });
  try {
    // 缺 backupDir 是 400（参数问题），不是 403（隔离拒绝）——证明闸门放行了这条路径
    const plan = await server.request('/api/restore/plan', { method: 'POST', body: {} });
    assert.equal(plan.status, 400);
    assert.equal(plan.json.error.code, 'INVALID_ARGUMENT');

    // 备份能力没开 → 403 但错因是 CAPABILITY_REQUIRED，不是 ISOLATED_INSTANCE
    const backup = await server.request('/api/backups', { method: 'POST', body: {} });
    assert.equal(backup.status, 403);
    assert.equal(backup.json.error.code, 'CAPABILITY_REQUIRED');
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 恢复状态文件：promoted=false
// ---------------------------------------------------------------------------

test('restore-state.json 里 promoted=false → 新实例被判隔离', async () => {
  const stateDir = path.join(tmp.stateDir, 'state-blocked');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'restore-state.json'),
    JSON.stringify(
      {
        promoted: false,
        reason: 'LEDGER_STALE_BEHIND_BACKUP',
        backupDir: 'bk_stale',
        restoredAt: '2026-10-28T12:00:00.000Z',
      },
      null,
      2,
    ),
  );

  const server = await boot(tmp.dbPath, { stateDir });
  try {
    const { json } = await server.request('/api/health');
    assert.equal(json.isolation.active, true);
    assert.equal(json.isolation.source, 'restore-state');
    assert.ok(json.isolation.reasons.some((r) => r.code === 'LEDGER_STALE_BEHIND_BACKUP'));
    assert.match(String(json.isolation.reasons[0].detail), /未通过校验上架/);
  } finally {
    await server.close();
  }
});

test('restore-state.json 里 promoted=true → 不隔离', async () => {
  const stateDir = path.join(tmp.stateDir, 'state-ok');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    path.join(stateDir, 'restore-state.json'),
    JSON.stringify({ promoted: true, reason: 'RESTORE_PROMOTED', backupDir: 'bk_ok' }),
  );

  const server = await boot(tmp.dbPath, { stateDir });
  try {
    const { json } = await server.request('/api/health');
    assert.equal(json.isolation.active, false);
    assert.equal(json.isolation.canServe, true);
  } finally {
    await server.close();
  }
});

test('restore-state.json 坏掉 → 必须隔离（读不懂的保险丝不能当没装）', async () => {
  const stateDir = path.join(tmp.stateDir, 'state-corrupt');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(path.join(stateDir, 'restore-state.json'), '{ 这不是 JSON');

  const server = await boot(tmp.dbPath, { stateDir });
  try {
    const { json } = await server.request('/api/health');
    assert.equal(json.isolation.active, true);
    assert.ok(json.isolation.reasons.some((r) => r.code === 'RESTORE_STATE_UNREADABLE'));
  } finally {
    await server.close();
  }
});

// ---------------------------------------------------------------------------
// 恢复实例：账本检查
// ---------------------------------------------------------------------------

test('恢复实例 + 账本已工作过 → 允许服务', async () => {
  // 先真删一条：账本被真正写入，才谈得上「可信」。
  // （全新库的账本是空的，verify 会报 corruptAt='missing'——那时候确实证明不了任何事。）
  const fresh = await createTempBrain();
  try {
    await fresh.brain.deletion.requestDeletion({
      target_kind: 'memory',
      target_id: 'mem-m3-ceiling',
      scope_id: 'owner-default',
      reason: '恢复演练前的删除',
    });

    const server = await startUiServer({
      dbPath: fresh.dbPath,
      backupDir: fresh.backupsDir,
      stateDir: fresh.stateDir,
      restoredFrom: fresh.backupsDir,
    });
    try {
      const { json } = await server.request('/api/health');
      assert.equal(json.capabilities.facades.deletionLedger, true);
      assert.equal(json.isolation.active, false, JSON.stringify(json.isolation.reasons));
      assert.equal(json.isolation.canServe, true);
    } finally {
      await server.close();
    }
  } finally {
    await fresh.close();
  }
});

test('恢复实例 + 空账本 → 必须隔离（证明不了备份之后没删过东西）', async () => {
  const fresh = await createTempBrain();
  try {
    const server = await startUiServer({
      dbPath: fresh.dbPath,
      backupDir: fresh.backupsDir,
      stateDir: fresh.stateDir,
      restoredFrom: fresh.backupsDir,
    });
    try {
      const { json } = await server.request('/api/health');
      assert.equal(json.isolation.active, true);
      assert.equal(json.isolation.canServe, false);
      assert.ok(
        json.isolation.reasons.some((r) => r.code === 'LEDGER_MISSING'),
        JSON.stringify(json.isolation.reasons),
      );
    } finally {
      await server.close();
    }
  } finally {
    await fresh.close();
  }
});

test('隔离实例的 POST /api/restore/execute 仍然默认 dry-run（两层闸门叠加）', async () => {
  const server = await boot(tmp.dbPath, { isolationReason: '隔离 + 恢复' });
  try {
    const res = await server.request('/api/restore/execute', {
      method: 'POST',
      body: { backupDir: 'bk_whatever' },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.dryRun, true);
    assert.equal(res.json.executed, false);
  } finally {
    await server.close();
  }
});
