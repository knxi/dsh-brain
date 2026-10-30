// @ts-check
/**
 * 系统 3 · `brainstem` 健康监控与告警（脑干）。
 *
 * 每条测试名就是一句验收需求：
 *  1. 健康的库：跑完 6 项检查，零告警，备份目录缺失只跳过不报错   → test 1
 *  2. error 事件激增 → 一条 medium 告警（重复触发累加 occurrences）→ test 2
 *  3. 故障消失 → 自动 resolve（resolution=auto_recovered）         → test 3
 *  4. 备份过期 → medium 告警；备份新鲜 → 不报                      → test 4
 *  5. outbox 积压超阈值 → low 告警                                 → test 5
 *  6. ack / resolve 状态机（重复调用幂等，已收口不能再 ack）        → test 6
 *  7. 跨 scope：告警列表不串                                       → test 7
 *  8. paused=1 时照常体检（脑干不是自主行为，不该被闸门关掉）      → test 8
 *  9. 严重度映射是常量表（可审、可回滚）                            → test 9
 * 10. createBrainstem 可单独构造                                    → test 10
 * 11. 告警详情只存数字/状态，不存正文                              → test 11
 */

import test from 'node:test';
import {
  CHECK_CODES,
  CHECK_SEVERITY,
  createBrainstem,
  OUTBOX_WARN_COUNT,
  WAL_WARN_BYTES,
} from '../../packages/cognition/src/brainstem.js';
import { writeFileSync } from 'node:fs';
import {
  assert,
  countRows,
  createBrain,
  DEFAULT_SCOPE_ID,
  insertOutboxItems,
  insertPendingDeletionJob,
  insertWsEvent,
  OTHER_SCOPE_ID,
  setSwitch,
  touchBackup,
} from './helpers.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

test('健康的库：6 项检查都跑，零告警；备份目录缺失只跳过不报错', async (t) => {
  const { cognition, brain, dbPath } = createBrain(t);
  const result = await cognition.brainstem.checkOnce();

  assert.equal(result.checks.length, 6, '六项检查都要有结果');
  const codes = result.checks.map((check) => check.code);
  assert.deepEqual(
    codes.sort(),
    [
      'backup.stale',
      'db.quick_check',
      'db.wal_size',
      'deletion.pending',
      'error.event_rate',
      'outbox.backlog',
    ].sort(),
  );

  const quickCheck = result.checks.find((check) => check.code === CHECK_CODES.DB_QUICK_CHECK);
  assert.equal(quickCheck.ok, true);
  assert.equal(quickCheck.detail.verdict, 'ok');

  const backup = result.checks.find((check) => check.code === CHECK_CODES.BACKUP_STALE);
  assert.equal(backup.skipped, true, '备份目录不存在 → 跳过（不报错）');
  assert.equal(backup.detail.reason, 'backup_dir_missing');

  assert.equal(result.failed, 0);
  assert.equal(result.alertsRaised, 0);
  assert.equal(countRows(brain.db, 'health_alerts'), 0);
  assert.ok(dbPath.endsWith('brain.db'));
});

test('error 事件激增 → medium 告警；重复触发累加 occurrences 不刷屏', async (t) => {
  const { brain, cognition, fc } = createBrain(t);
  for (let index = 0; index < 25; index += 1) {
    insertWsEvent(brain.db, { channel: 'error', atMs: fc.nowMs() - 10 * 60 * 1000 });
  }

  const first = await cognition.brainstem.checkOnce();
  assert.equal(first.alertsRaised, 1, '只有一个检查项处于故障状态');
  assert.equal(first.alertsCreated, 1);
  const alert = cognition.brainstem.listAlerts({ status: 'open' }).items[0];
  assert.equal(alert.code, CHECK_CODES.ERROR_EVENT_RATE);
  assert.equal(alert.severity, 'medium', '错误激增是 medium（要看，但不该半夜叫醒人）');
  assert.equal(alert.occurrences, 1);
  assert.equal(alert.detail.errors, 25);

  const second = await cognition.brainstem.checkOnce();
  assert.equal(second.alertsRaised, 1);
  assert.equal(second.alertsUpdated, 1);
  assert.equal(second.alertsCreated, 0);
  assert.equal(countRows(brain.db, 'health_alerts'), 1, '同一 code 同时只有一条 open');
  const updated = cognition.brainstem.listAlerts({ status: 'open' }).items[0];
  assert.equal(updated.occurrences, 2, '重复触发累加次数');
  assert.ok(updated.lastSeenAt >= updated.at, 'last_seen_at 要更新');
});

test('故障消失 → 自动 resolve（告警列表永远反映「现在」）', async (t) => {
  const { brain, cognition, fc } = createBrain(t);
  for (let index = 0; index < 25; index += 1) {
    insertWsEvent(brain.db, { channel: 'error', atMs: fc.nowMs() - 10 * 60 * 1000 });
  }
  await cognition.brainstem.checkOnce();
  assert.equal(cognition.brainstem.listAlerts({ status: 'open' }).items.length, 1);

  // 故障消失（错误事件被清理 / 窗口滑过去）
  brain.db.prepare("DELETE FROM ws_events WHERE channel = 'error'").run();
  const recovered = await cognition.brainstem.checkOnce();
  assert.equal(recovered.alertsRaised, 0);
  assert.equal(recovered.alertsResolved, 1);
  const resolved = cognition.brainstem.listAlerts({ status: 'resolved' }).items;
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].resolution, 'auto_recovered', '自动恢复必须留原因');
  assert.ok(resolved[0].resolvedAt !== null);
  assert.equal(cognition.brainstem.listAlerts({ status: 'open' }).items.length, 0);
});

test('备份过期 → medium 告警；备份新鲜 → 不报；空目录 → 告警', async (t) => {
  const { cognition, fc, dir } = createBrain(t);
  const backupsDir = `${dir}/backups`;
  const stale = createBrain(t, { backupsDir });
  touchBackup(backupsDir, 'brain-8d.db', fc.nowMs() - 8 * DAY_MS);
  const staleResult = await stale.cognition.brainstem.checkOnce();
  assert.equal(staleResult.alertsRaised, 1);
  const alert = stale.cognition.brainstem.listAlerts({ status: 'open' }).items[0];
  assert.equal(alert.code, 'backup.stale');
  assert.equal(alert.severity, 'medium', '备份过期是 medium：少一个回滚点，不是当前故障');
  assert.equal(alert.detail.newestBackup, 'brain-8d.db');

  // 新鲜的备份不报
  const fresh = createBrain(t, { backupsDir: `${dir}/backups-fresh` });
  touchBackup(`${dir}/backups-fresh`, 'brain-now.db', fc.nowMs() - 60 * 60 * 1000);
  const freshResult = await fresh.cognition.brainstem.checkOnce();
  assert.equal(freshResult.alertsRaised, 0);

  // 目录存在但一条备份都没有 → 告警（有目录却没备份不是正常状态）
  const empty = createBrain(t, { backupsDir: `${dir}/backups-empty` });
  const { mkdirSync } = await import('node:fs');
  mkdirSync(`${dir}/backups-empty`, { recursive: true });
  const emptyResult = await empty.cognition.brainstem.checkOnce();
  assert.equal(emptyResult.alertsRaised, 1);
  assert.equal(empty.cognition.brainstem.listAlerts({ status: 'open' }).items[0].detail.reason, 'no_backup_files');
  assert.ok(cognition.brainstem);
});

test('outbox 积压超阈值 → low 告警', async (t) => {
  const { brain, cognition } = createBrain(t);
  insertOutboxItems(brain.db, OUTBOX_WARN_COUNT + 1);
  const result = await cognition.brainstem.checkOnce();
  const backlog = result.checks.find((check) => check.code === CHECK_CODES.OUTBOX_BACKLOG);
  assert.equal(backlog.ok, false);
  assert.equal(backlog.detail.backlog, OUTBOX_WARN_COUNT + 1);
  const alert = cognition.brainstem.listAlerts({ status: 'open' }).items[0];
  assert.equal(alert.code, CHECK_CODES.OUTBOX_BACKLOG);
  assert.equal(alert.severity, 'low', '事件积压是延迟不是错误 → low');
});

test('WAL 过大（>64MB）→ low 告警；WAL 文件不存在按 0 处理', async (t) => {
  const { brain, fc, dir } = createBrain(t);
  const fakeDbPath = `${dir}/fake.db`;
  const walPath = `${fakeDbPath}-wal`;
  // 用一个「只有路径」的库名检测 WAL 体积：checkWalSize 只 stat 文件，不打开库。
  writeFileSync(walPath, Buffer.alloc(WAL_WARN_BYTES + 1));
  const brainstem = createBrainstem({
    db: brain.db,
    queue: brain.queue,
    clock: fc.clock,
    bindings: { scope_id: DEFAULT_SCOPE_ID, person_id: 'owner' },
    dbPath: fakeDbPath,
    backupsDir: `${dir}/backups`,
  });
  const result = await brainstem.checkOnce();
  const check = result.checks.find((item) => item.code === CHECK_CODES.WAL_SIZE);
  assert.equal(check.ok, false);
  assert.equal(check.detail.bytes, WAL_WARN_BYTES + 1);
  const alert = brainstem.listAlerts({ status: 'open' }).items.find((item) => item.code === CHECK_CODES.WAL_SIZE);
  assert.ok(alert, 'WAL 超阈值必须告警');
  assert.equal(alert.severity, 'low', 'WAL 膨胀是性能问题 → low');

  // 没有 WAL 文件（刚 checkpoint 过 / 还没写过）→ 0 字节，不算故障
  const clean = createBrain(t);
  const cleanBrainstem = createBrainstem({
    db: clean.brain.db,
    queue: clean.brain.queue,
    clock: clean.fc.clock,
    bindings: { scope_id: DEFAULT_SCOPE_ID, person_id: 'owner' },
    dbPath: `${clean.dir}/nowal.db`,
    backupsDir: `${clean.dir}/backups`,
  });
  const cleanResult = await cleanBrainstem.checkOnce();
  const cleanCheck = cleanResult.checks.find((item) => item.code === CHECK_CODES.WAL_SIZE);
  assert.equal(cleanCheck.ok, true);
  assert.equal(cleanCheck.detail.bytes, 0);
});

test('删除任务卡在 pending 超过宽限 → medium 告警（隐私承诺没兑现）', async (t) => {
  const { brain, cognition } = createBrain(t);
  insertPendingDeletionJob(brain.db, { createdAt: '2026-10-28T06:00:00.000Z', epoch: 1 });
  const result = await cognition.brainstem.checkOnce();
  const check = result.checks.find((item) => item.code === CHECK_CODES.DELETION_PENDING);
  assert.equal(check.ok, false);
  assert.equal(check.detail.stale, 1);
  const alert = cognition.brainstem.listAlerts({ status: 'open' }).items.find((item) => item.code === CHECK_CODES.DELETION_PENDING);
  assert.ok(alert, '卡住的删除任务必须告警');
  assert.equal(alert.severity, 'medium', '删除没落地=隐私承诺没兑现 → medium');

  // 一小时内刚入队的不算「卡住」（worker 可能刚好没跑）
  const fresh = createBrain(t);
  insertPendingDeletionJob(fresh.brain.db, { createdAt: '2026-10-28T09:30:00.000Z', epoch: 2 });
  const freshResult = await fresh.cognition.brainstem.checkOnce();
  const freshCheck = freshResult.checks.find((item) => item.code === CHECK_CODES.DELETION_PENDING);
  assert.equal(freshCheck.ok, true, '宽限期内的删除任务不该告警（那是噪音）');
});

test('ack / resolve 状态机：重复幂等，已收口不能再确认', async (t) => {
  const { brain, cognition, fc } = createBrain(t);
  for (let index = 0; index < 25; index += 1) {
    insertWsEvent(brain.db, { channel: 'error', atMs: fc.nowMs() - 10 * 60 * 1000 });
  }
  await cognition.brainstem.checkOnce();
  const [alert] = cognition.brainstem.listAlerts({ status: 'open' }).items;

  const acked = await cognition.brainstem.ack(alert.id, { by: 'owner' });
  assert.equal(acked.acked, true);
  const ackedRow = cognition.brainstem.listAlerts({ status: 'acked' }).items[0];
  assert.equal(ackedRow.ackedBy, 'owner');
  assert.ok(ackedRow.ackedAt !== null);
  const ackAgain = await cognition.brainstem.ack(alert.id, { by: 'owner' });
  assert.equal(ackAgain.alreadyAcked, true, '重复确认幂等');

  const resolved = await cognition.brainstem.resolve(alert.id, { by: 'owner', resolution: '已清理错误事件' });
  assert.equal(resolved.resolved, true);
  const resolvedRow = cognition.brainstem.listAlerts({ status: 'resolved' }).items[0];
  assert.equal(resolvedRow.resolution, '已清理错误事件');
  const resolveAgain = await cognition.brainstem.resolve(alert.id, { by: 'owner' });
  assert.equal(resolveAgain.alreadyResolved, true, '重复解决幂等');

  await assert.rejects(
    () => cognition.brainstem.ack(alert.id, { by: 'owner' }),
    (err) => err.code === 'INVALID_ARGUMENT',
    '已收口的告警不能确认',
  );
  await assert.rejects(
    () => cognition.brainstem.resolve('hal_not_exist', { by: 'owner' }),
    (err) => err.code === 'NOT_FOUND',
  );
});

test('跨 scope：告警列表不串', async (t) => {
  const { brain, cognition, fc } = createBrain(t);
  for (let index = 0; index < 25; index += 1) {
    insertWsEvent(brain.db, { channel: 'error', atMs: fc.nowMs() - 10 * 60 * 1000 });
  }
  await cognition.brainstem.checkOnce();
  const [alert] = cognition.brainstem.listAlerts().items;
  assert.equal(cognition.brainstem.listAlerts({ scopeId: OTHER_SCOPE_ID }).items.length, 0);
  await assert.rejects(
    () => cognition.brainstem.ack(alert.id, { by: 'other', scopeId: OTHER_SCOPE_ID }),
    (err) => err.code === 'NOT_FOUND',
  );
  assert.equal(cognition.brainstem.stats({ scopeId: OTHER_SCOPE_ID }).open, 0);
});

test('paused=1 时照常体检（脑干不是自主行为，不该被闸门关掉）', async (t) => {
  const { brain, workspace, cognition, fc } = createBrain(t);
  await setSwitch(workspace, 'paused', '1');
  for (let index = 0; index < 25; index += 1) {
    insertWsEvent(brain.db, { channel: 'error', atMs: fc.nowMs() - 10 * 60 * 1000 });
  }
  const result = await cognition.brainstem.checkOnce();
  assert.equal(result.alertsRaised, 1, '全局暂停时更要能看见故障');
  assert.equal(countRows(brain.db, 'health_alerts'), 1);
});

test('严重度映射是常量表（可审、可回滚）', () => {
  assert.equal(CHECK_SEVERITY[CHECK_CODES.DB_QUICK_CHECK], 'high', '库损坏=high');
  assert.equal(CHECK_SEVERITY[CHECK_CODES.BACKUP_STALE], 'medium', '备份过期=medium');
  assert.equal(CHECK_SEVERITY[CHECK_CODES.OUTBOX_BACKLOG], 'low', '事件积压=low');
  assert.equal(CHECK_SEVERITY[CHECK_CODES.WAL_SIZE], 'low');
  assert.equal(CHECK_SEVERITY[CHECK_CODES.DELETION_PENDING], 'medium');
  assert.equal(CHECK_SEVERITY[CHECK_CODES.ERROR_EVENT_RATE], 'medium');
});

test('告警详情只存数字/状态，不存正文', async (t) => {
  const { cognition } = createBrain(t, { backupsDir: '/nonexistent/不应存在' });
  const result = await cognition.brainstem.checkOnce();
  assert.equal(result.alertsRaised, 0, '目录不存在 → 跳过');
  for (const check of result.checks) {
    const serialized = JSON.stringify(check.detail);
    assert.ok(!serialized.includes('content'), '检查详情不含任何记忆正文');
    assert.ok(serialized.length < 500, '详情要足够小');
  }
});

test('createBrainstem 可单独构造（CLI/巡检脚本复用）', async (t) => {
  const { brain, fc, dbPath } = createBrain(t);
  const standalone = createBrainstem({
    db: brain.db,
    queue: brain.queue,
    clock: fc.clock,
    bindings: { scope_id: DEFAULT_SCOPE_ID, person_id: 'owner' },
    dbPath,
  });
  const result = await standalone.checkOnce();
  assert.equal(result.checks.length, 6);
  assert.equal(standalone.listAlerts().items.length, result.alertsRaised);
  assert.ok(standalone.stats() !== undefined);
});
