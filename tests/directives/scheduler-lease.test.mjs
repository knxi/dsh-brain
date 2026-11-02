// @ts-check
/**
 * 租约与重启安全。
 *
 * 两条必须钉住的危险路径：
 * 1. **同一条指令在租约期内不得被第二个 owner 抢**；
 * 2. **进程在 running 中途死掉后，遗留的 run 必须能被回收**（否则队列就死了）。
 */

import test from 'node:test';
import {
  assert,
  buildSystem,
  countRows,
  createBrain,
  createFakeWorkspace,
  createGateHook,
  createSystem,
  readRows,
  waitUntil,
} from './helpers.mjs';

/** 打开闸门（max_level 可指定，默认 L1）。 */
function openSwitches(maxLevel = 'L1') {
  return { switches: { 'autonomy.enabled': '1', 'autonomy.max_level': maxLevel } };
}

/** 建一条 queued 的 L1 维护指令。 */
async function queueDirective(system, key, extra = {}) {
  const created = await system.create({
    title: `指令 ${key}`,
    idempotencyKey: key,
    permissionScope: 'L1',
    allowedTools: ['memory_maintenance'],
    ...extra,
  });
  await system.stateMachine.transition({ id: created.id, to: 'queued' });
  return created.id;
}

test('双 owner：租约期内第二个 owner 抢不到，一条 run 只有一个主人', async (t) => {
  const { brain, fc } = createBrain(t);
  const workspace = createFakeWorkspace(openSwitches());
  const gateHook = createGateHook();
  /** @type {any[]} */
  const callsA = [];
  const systemA = buildSystem({
    brain,
    fc,
    workspace,
    hooks: {
      memoryMaintenance: async (ctx) => {
        callsA.push(ctx);
        return gateHook.hook(ctx);
      },
    },
  });
  const systemB = buildSystem({ brain, fc, workspace, hooks: { memoryMaintenance: async () => ({ ok: true, summary: 'B 完成' }) } });

  const id = await queueDirective(systemA, 'double-owner');

  // A 认领并卡在 hook 里（模拟"正在执行、还没结束"）
  const promiseA = systemA.scheduler.runOnce({ owner: 'owner-A' });
  await waitUntil(() => callsA.length === 1, { label: 'A 应该已经进入 hook' });
  assert.equal(countRows(brain.db, 'directive_runs'), 1);

  // B 此刻来抢：指令在 running，租约还有效 → 它抢不到，而且什么都不写
  const resultB = await systemB.scheduler.runOnce({ owner: 'owner-B' });
  assert.equal(resultB.skipped, true);
  assert.equal(resultB.reason, 'queue_empty', 'B 没得跑（指令已被 A 认领）');
  assert.equal(countRows(brain.db, 'directive_runs'), 1, '第二条 run 都不该出现');
  assert.equal(countRows(brain.db, 'directive_steps'), 1, 'B 不许往 A 的 run 里写步骤');

  gateHook.release();
  const resultA = await promiseA;
  assert.equal(resultA.stopReason, 'goal_completed');
  assert.equal(resultA.directiveStatus, 'completed');
  assert.equal(readRows(brain.db, 'directive_runs', 'directive_id = ?', [id]).length, 1);
});

test('重启安全：租约过期的 running 被回收成 timeout，指令回 queued 并可被再次执行', async (t) => {
  const { system, brain, fc } = createSystem(t, { workspaceOptions: openSwitches() });
  const id = await queueDirective(system, 'crash-simple');

  // 手动认领，然后**什么都不做**（= 进程在这一刻被 kill）
  const claim = await system.scheduler.claimNext({ owner: 'dead-process' });
  assert.equal(claim.claimed, true);
  const runId = claim.claim.runId;
  assert.equal(system.get(id).status, 'running');

  // 租约还没过期：不许抢
  fc.advance(1000);
  const notYet = await system.scheduler.recoverStaleRuns();
  assert.equal(notYet.recovered, 0, '租约未过期时不许回收（否则就是两个 owner）');
  assert.equal(system.get(id).status, 'running');

  // 租约过期后：回收
  fc.advance(61_000);
  const recovered = await system.scheduler.recoverStaleRuns();
  assert.equal(recovered.recovered, 1);
  assert.equal(recovered.items[0].runId, runId);

  const run = readRows(brain.db, 'directive_runs', 'id = ?', [runId])[0];
  assert.equal(run.status, 'timeout', '僵尸 run 必须标 timeout');
  assert.equal(run.stop_reason, 'lease_expired');
  assert.ok(run.finished_at !== null);
  assert.equal(system.get(id).status, 'queued', '还有重试额度 → 回 queued');
  assert.equal(countRows(brain.db, 'audit_logs') > 0, true);
  assert.ok(
    readRows(brain.db, 'audit_logs', "action = 'directive.run.recovered' AND target_id = ?", [id]).length === 1,
    '回收要留一条审计',
  );

  // 下一次 runOnce 能接着把它跑完
  const result = await system.scheduler.runOnce({ owner: 'restarted' });
  assert.equal(result.skipped, false);
  assert.equal(result.stopReason, 'goal_completed');
  assert.equal(system.get(id).status, 'completed');
  assert.equal(countRows(brain.db, 'directive_runs'), 2, '第二次尝试是独立的一条 run');
});

test('重启安全：重试用尽后回收 → 指令进 blocked（不是 failed：它不是做错了）', async (t) => {
  const { system, fc } = createSystem(t, { workspaceOptions: openSwitches() });
  const id = await queueDirective(system, 'crash-exhausted', { maxRetries: 0 });
  const claim = await system.scheduler.claimNext({ owner: 'dead' });
  assert.equal(claim.claimed, true);
  fc.advance(61_000);
  const recovered = await system.scheduler.recoverStaleRuns();
  assert.equal(recovered.recovered, 1);
  assert.equal(system.get(id).status, 'blocked');
  assert.equal(system.get(id).lastError, 'lease_expired');
});

test('回收只收自己 scope 的僵尸 run', async (t) => {
  const { brain, fc } = createBrain(t);
  const workspaceA = createFakeWorkspace({ ...openSwitches(), scopeId: 'scope-a' });
  const workspaceB = createFakeWorkspace({ ...openSwitches(), scopeId: 'scope-b' });
  const systemA = buildSystem({ brain, fc, workspace: workspaceA, hooks: {}, scopeId: 'scope-a' });
  const systemB = buildSystem({ brain, fc, workspace: workspaceB, hooks: {}, scopeId: 'scope-b' });

  const idA = await queueDirective(systemA, 'a-crash');
  const claim = await systemA.scheduler.claimNext({ owner: 'dead-a' });
  assert.equal(claim.claimed, true);

  fc.advance(61_000);
  const bRecovered = await systemB.scheduler.recoverStaleRuns();
  assert.equal(bRecovered.recovered, 0, 'B 不许回收 A 的 run');
  assert.equal(readRows(brain.db, 'directive_runs', 'id = ?', [claim.claim.runId])[0].status, 'running');

  const aRecovered = await systemA.scheduler.recoverStaleRuns();
  assert.equal(aRecovered.recovered, 1);
  assert.equal(systemA.get(idA).status, 'queued');
});

test('跑过租约的步骤一律不许再写（宁可少一条流水，也不许两个 owner 同时写）', async (t) => {
  const { system, brain, fc, alerts } = createSystem(t, {
    workspaceOptions: openSwitches(),
    leaseMs: 1000,
    hookImpls: {
      memoryMaintenance: async () => {
        fc.advance(5000); // 这一步跑了 5 秒，租约只有 1 秒
        return { ok: true, summary: '慢动作' };
      },
    },
  });
  const id = await queueDirective(system, 'slow');
  const result = await system.scheduler.runOnce({ owner: 'slow-owner' });
  assert.ok(typeof result.aborted === 'string', '必须报 aborted');
  assert.equal(result.aborted, 'lease_expired');
  // 只有 plan 那一步写进去了，tool 步与终态都没写
  const run = readRows(brain.db, 'directive_runs', 'directive_id = ?', [id])[0];
  assert.equal(run.status, 'running', 'run 保持 running，等回收流程处理');
  assert.equal(countRows(brain.db, 'directive_steps'), 1);
  assert.ok(alerts.some((info) => info.kind === 'directive_run_aborted'), '放弃写入要告警');

  // 回收之后才回到可控状态
  fc.advance(10_000);
  await system.scheduler.recoverStaleRuns();
  assert.equal(readRows(brain.db, 'directive_runs', 'id = ?', [run.id])[0].status, 'timeout');
});

test('heartbeat：本人可续租，别人续不了，过期后也续不了', async (t) => {
  const { system, fc, brain } = createSystem(t, { workspaceOptions: openSwitches(), leaseMs: 60_000 });
  const id = await queueDirective(system, 'hb');
  const claim = await system.scheduler.claimNext({ owner: 'me' });
  const runId = claim.claim.runId;

  fc.advance(10_000);
  const renewed = await system.scheduler.heartbeat({ runId, owner: 'me' });
  assert.equal(renewed.ok, true);
  const leaseAfter = Number(readRows(brain.db, 'directive_runs', 'id = ?', [runId])[0].lease_until);
  assert.ok(leaseAfter > claim.claim.run.leaseUntil, '续租要真的往后推');

  const byOther = await system.scheduler.heartbeat({ runId, owner: 'someone-else' });
  assert.equal(byOther.ok, false);
  assert.equal(byOther.reason, 'lease_owner_mismatch');

  fc.advance(120_000);
  const expired = await system.scheduler.heartbeat({ runId, owner: 'me' });
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'lease_expired', '租约过期后连自己也不许续（那时可能已被别人回收）');
  assert.equal(system.get(id).status, 'running');
});

test('租约参数有下限（不许配置成"几乎不设租约"）', async (t) => {
  const { system } = createSystem(t, { workspaceOptions: openSwitches(), leaseMs: 1 });
  assert.equal(system.scheduler.describe().leaseMs, 1000, 'leaseMs 下限 1 秒');
  const { system: system2 } = createSystem(t, { workspaceOptions: openSwitches(), leaseMs: 999_999_999 });
  assert.equal(system2.scheduler.describe().leaseMs, 24 * 60 * 60 * 1000, 'leaseMs 上限 24 小时');
});

test('回收是幂等的：同一批僵尸 run 回收两次只处理一次', async (t) => {
  const { system, fc, brain } = createSystem(t, { workspaceOptions: openSwitches() });
  await queueDirective(system, 'idem');
  const claim = await system.scheduler.claimNext({ owner: 'dead' });
  fc.advance(61_000);
  const first = await system.scheduler.recoverStaleRuns();
  assert.equal(first.recovered, 1);
  const second = await system.scheduler.recoverStaleRuns();
  assert.equal(second.recovered, 0, '第二次没有可回收的（run 已不是 running）');
  assert.equal(
    readRows(brain.db, 'audit_logs', "action = 'directive.run.recovered'").length,
    1,
    '不许重复写回收审计',
  );
  assert.equal(readRows(brain.db, 'directive_runs', 'id = ?', [claim.claim.runId])[0].status, 'timeout');
});

test('reclaim / recoverOrphans 是同一个实现的别名（宿主怎么叫都行）', async (t) => {
  const { system, fc, brain } = createSystem(t, { workspaceOptions: openSwitches() });
  await queueDirective(system, 'alias');
  const claim = await system.scheduler.claimNext({ owner: 'dead' });
  fc.advance(61_000);
  assert.equal(typeof system.scheduler.reclaim, 'function');
  assert.equal(typeof system.scheduler.recoverOrphans, 'function');
  const result = await system.scheduler.reclaim({ now: fc.nowMs() });
  assert.equal(result.recovered, 1);
  assert.equal(readRows(brain.db, 'directive_runs', 'id = ?', [claim.claim.runId])[0].status, 'timeout');
});
