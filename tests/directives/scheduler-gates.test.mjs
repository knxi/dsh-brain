// @ts-check
/**
 * 调度器闸门 —— **零写入**验收。
 *
 * 这一组是整套系统里最不能退化的一组：任何一条变红，都意味着"主人叫停之后
 * 它还在动"。每一条测试都比较跑之前与跑之后的四张表行数：
 * `directives` / `directive_runs` / `directive_steps` / `audit_logs`。
 */

import test from 'node:test';
import { assert, buildSystem, countRows, createFakeWorkspace, createSystem } from './helpers.mjs';

/**
 * 四张表的行数快照。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function snapshot(db) {
  return {
    directives: countRows(db, 'directives'),
    runs: countRows(db, 'directive_runs'),
    steps: countRows(db, 'directive_steps'),
    audits: countRows(db, 'audit_logs'),
  };
}

/**
 * 造一条"已经排好队、只等开关"的指令。
 * @param {Record<string, any>} system
 */
async function seedQueued(system, extra = {}) {
  const created = await system.create({
    title: '排队中的维护指令',
    idempotencyKey: 'queued-1',
    permissionScope: 'L1',
    allowedTools: ['memory_maintenance'],
    ...extra,
  });
  await system.stateMachine.transition({ id: created.id, to: 'queued' });
  return created.id;
}

test('默认姿态：autonomy.enabled=0 → skipped=autonomy_disabled，且四张表一行没动', async (t) => {
  const { system, brain } = createSystem(t);
  await seedQueued(system);
  const before = snapshot(brain.db);

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'autonomy_disabled');
  assert.deepEqual(snapshot(brain.db), before, '开关为 0 时必须零写入（连审计都不许写）');
  const only = system.list().items[0];
  assert.equal(only.status, 'queued', '指令仍在队列里，没被认领');
});

test('全局暂停优先于一切：paused=1 时哪怕自主开关开着，也 skips global_paused 且零写入', async (t) => {
  const { system, brain, workspace, calls } = createSystem(t, {
    workspaceOptions: { switches: { 'autonomy.enabled': '1', 'autonomy.max_level': 'L3' } },
  });
  await seedQueued(system, { permissionScope: 'L2', allowedTools: ['reflection_run'], stepBudget: 5, timeBudgetSeconds: 60, tokenBudget: 1000 });
  workspace.set('paused', '1');
  const before = snapshot(brain.db);

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'global_paused');
  assert.deepEqual(snapshot(brain.db), before, '暂停期间必须零写入');
  assert.equal(calls.length, 0, '暂停期间一个 hook 都不许被调用');
});

test('暂停解除后才开工（同一条指令，前后对比）', async (t) => {
  const { system, brain, workspace, calls } = createSystem(t, {
    workspaceOptions: { switches: { 'autonomy.enabled': '1', 'autonomy.max_level': 'L1' } },
  });
  const id = await seedQueued(system);
  workspace.set('paused', '1');
  assert.equal((await system.scheduler.runOnce()).reason, 'global_paused');
  assert.equal(countRows(brain.db, 'directive_runs'), 0);

  workspace.set('paused', '0');
  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.skipped, false);
  assert.equal(system.get(id).status, 'completed');
  assert.equal(calls.length, 1, '放行之后 hook 才被调用一次');
});

test('autonomy.max_level=L0：只允许回复，调度器没有任何可执行动作 → 零写入', async (t) => {
  const { system, brain } = createSystem(t, {
    workspaceOptions: { switches: { 'autonomy.enabled': '1', 'autonomy.max_level': 'L0' } },
  });
  await seedQueued(system);
  const before = snapshot(brain.db);
  const result = await system.scheduler.runOnce();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'max_level_too_low');
  assert.deepEqual(snapshot(brain.db), before);
});

test('autonomy.max_level 是坏字符串（L9）→ 失败关：拒绝放行，不猜', async (t) => {
  const { system, brain } = createSystem(t, {
    workspaceOptions: { switches: { 'autonomy.enabled': '1', 'autonomy.max_level': 'L9' } },
  });
  await seedQueued(system);
  const before = snapshot(brain.db);
  const result = await system.scheduler.runOnce();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'max_level_invalid');
  assert.deepEqual(snapshot(brain.db), before);
});

test('autonomy.max_level 键不存在（null）→ 按默认 L1 处理（不是按"无限制"）', async (t) => {
  const { brain, fc } = createSystem(t);
  /** @type {Map<string, string>} */
  const switches = new Map([['autonomy.enabled', '1']]);
  const workspace = {
    isPaused: () => false,
    isEnabled: (name) => name === 'autonomy.enabled',
    getSwitch: (name) => (switches.has(name) ? switches.get(name) : null),
    listCandidates: () => [],
    publish: () => ({ id: 'x', at: '2026-10-30T08:00:00.000Z' }),
  };
  const system = buildSystem({ brain, fc, workspace, hooks: { memoryMaintenance: async () => ({ ok: true }) } });
  const created = await system.create({
    title: '默认等级下可跑',
    idempotencyKey: 'null-level',
    permissionScope: 'L1',
    allowedTools: ['memory_maintenance'],
  });
  await system.stateMachine.transition({ id: created.id, to: 'queued' });

  const gate = system.scheduler.readGate();
  assert.equal(gate.ok, true);
  assert.equal(gate.maxLevel, 'L1', '读不到 max_level 就按默认 L1（与迁移默认一致）');

  // L2 指令在这个默认等级下依然跑不动
  const high = await system.create({
    title: 'L2 指令',
    idempotencyKey: 'null-level-l2',
    permissionScope: 'L2',
    allowedTools: ['reflection_run'],
  });
  await system.stateMachine.transition({ id: high.id, to: 'queued' });
  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.skipped, false);
  assert.equal(system.get(created.id).status, 'completed');
  assert.equal(system.get(high.id).status, 'queued', 'L2 指令在默认 L1 下不许被执行');
});

test('没有注入 workspace → 失败关：workspace_missing，零写入', async (t) => {
  const { brain, fc } = createSystem(t);
  const system = buildSystem({ brain, fc, workspace: null, hooks: {} });
  const created = await system.create({ title: 'x', idempotencyKey: 'no-ws', permissionScope: 'L1', allowedTools: ['memory_maintenance'] });
  await system.stateMachine.transition({ id: created.id, to: 'queued' });
  const before = snapshot(brain.db);
  const result = await system.scheduler.runOnce();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'workspace_missing');
  assert.deepEqual(snapshot(brain.db), before);
});

test('workspace 缺方法（只有 isPaused）→ workspace_incomplete，零写入', async (t) => {
  const { brain, fc } = createSystem(t);
  const workspace = { isPaused: () => false };
  const system = buildSystem({ brain, fc, workspace, hooks: {} });
  const created = await system.create({ title: 'x', idempotencyKey: 'half-ws', permissionScope: 'L1', allowedTools: ['memory_maintenance'] });
  await system.stateMachine.transition({ id: created.id, to: 'queued' });
  const before = snapshot(brain.db);
  const result = await system.scheduler.runOnce();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'workspace_incomplete');
  assert.deepEqual(snapshot(brain.db), before);
});

test('队列为空 → queue_empty（放行但没活干），零写入', async (t) => {
  const { system, brain } = createSystem(t, {
    workspaceOptions: { switches: { 'autonomy.enabled': '1' } },
  });
  const before = snapshot(brain.db);
  const result = await system.scheduler.runOnce();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'queue_empty');
  assert.deepEqual(
    { runs: snapshot(brain.db).runs, steps: snapshot(brain.db).steps },
    { runs: before.runs, steps: before.steps },
  );
});

test('闸门只读：跑 5 次被拦下的 runOnce，开关的 updated_at 都不变', async (t) => {
  const { system, brain } = createSystem(t, {
    workspaceOptions: { switches: { 'autonomy.enabled': '1', paused: '1' } },
  });
  const before = brain.db.prepare("SELECT updated_at FROM brain_switches WHERE name = 'paused'").get();
  for (let index = 0; index < 5; index += 1) {
    const result = await system.scheduler.runOnce({ owner: `t${index}` });
    assert.equal(result.reason, 'global_paused');
  }
  const after = brain.db.prepare("SELECT updated_at FROM brain_switches WHERE name = 'paused'").get();
  assert.equal(after.updated_at, before.updated_at, '调度器只读开关，绝不改写');
  assert.equal(countRows(brain.db, 'audit_logs'), 0, '被拦下的调用连一条审计都不许写');
});

test('readGate 的返回形状就是宿主能直接判定的（ok / reason / maxLevel）', async (t) => {
  const { system, workspace } = createSystem(t, { workspaceOptions: { switches: { 'autonomy.enabled': '1' } } });
  assert.deepEqual(system.scheduler.readGate(), { ok: true, reason: 'ok', maxLevel: 'L1' });
  workspace.set('autonomy.max_level', 'L2');
  assert.deepEqual(system.scheduler.readGate(), { ok: true, reason: 'ok', maxLevel: 'L2' });
  workspace.set('autonomy.max_level', 'l3');
  assert.equal(system.scheduler.readGate().maxLevel, 'L3', '大小写不敏感');
});

test('默认姿态的三个默认值必须与契约一致（写死在测试里防漂移）', async (t) => {
  const { workspace } = createSystem(t);
  const fake = workspace ?? createFakeWorkspace();
  assert.equal(fake.getSwitch('autonomy.enabled'), '0');
  assert.equal(fake.getSwitch('autonomy.max_level'), 'L1');
  assert.equal(fake.getSwitch('paused'), '0');
});
