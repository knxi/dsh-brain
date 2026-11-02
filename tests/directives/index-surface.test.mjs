// @ts-check
/**
 * 工厂与组装面 —— 给接线的 lead 一份"公开 API 契约"。
 *
 * 这一组不测业务分支（那些在各模块自己的测试里），只测：
 * 工厂签名、缺依赖时的失败方式、默认绑定、能力自述、以及"没 workspace 时整体是惰性的"。
 */

import test from 'node:test';
import { assert, buildSystem, countRows, createBrain, createFakeWorkspace, readRows, SCOPE } from './helpers.mjs';
import { createDirectives, DEFAULT_MAX_LEVEL, DEFAULT_SCOPE_ID } from '../../packages/directives/src/index.js';

test('工厂签名：只传契约里的四项也能构造（没有 workspace / hooks 时是惰性的）', (t) => {
  const { brain, fc } = createBrain(t);
  const system = createDirectives({ db: brain.db, queue: brain.queue, clock: fc.clock });
  assert.equal(system.scopeId, DEFAULT_SCOPE_ID, '缺省绑定 owner-default');
  const described = system.describe();
  assert.equal(described.package, '@dsh-brain/directives');
  assert.equal(described.hasWorkspace, false);
  assert.equal(described.tableExists, true);
  // 默认姿态写在自述里，面板可以直接显示
  assert.equal(described.defaultPosture.autonomyEnabled, '0');
  assert.equal(described.defaultPosture.maxLevel, DEFAULT_MAX_LEVEL);
  assert.equal(described.defaultPosture.arbitraryCommandExecution, 'not implemented (by design)');
  // 六个动作都还没接线
  assert.deepEqual(described.hooksBound, []);
  assert.equal(described.actions.every((action) => action.available === false), true);
});

test('缺 db / queue / clock → 立刻抛（不静默降级成一个假的空实现）', () => {
  assert.throws(() => createDirectives(), (error) => /** @type {any} */ (error).reason === 'invalid_options');
  assert.throws(
    () => createDirectives({ db: {}, queue: { write() {} }, clock: { stamp() {} } }),
    (error) => /** @type {any} */ (error).reason === 'db_required',
  );
  assert.throws(
    () => createDirectives({ db: { prepare() {} }, queue: {}, clock: { stamp() {} } }),
    (error) => /** @type {any} */ (error).reason === 'queue_required',
  );
  assert.throws(
    () => createDirectives({ db: { prepare() {} }, queue: { write() {} } }),
    (error) => /** @type {any} */ (error).reason === 'clock_required',
  );
});

test('bindings：scope_id 决定一切查询的收口范围', async (t) => {
  const { brain, fc } = createBrain(t);
  const workspace = createFakeWorkspace({ scopeId: 'board-42' });
  const system = createDirectives({
    db: brain.db,
    queue: brain.queue,
    clock: fc.clock,
    workspace,
    bindings: { scope_id: 'board-42', person_id: 'someone' },
  });
  assert.equal(system.scopeId, 'board-42');
  assert.equal(system.personId, 'someone');
  assert.deepEqual(system.bindings, { scope_id: 'board-42', person_id: 'someone' });
  const created = await system.create({ title: 'x', idempotencyKey: 'k' });
  assert.equal(readRows(brain.db, 'directives', 'id = ?', [created.id])[0].scope_id, 'board-42');
});

test('默认绑定与主账一致（owner-default / L1）', () => {
  assert.equal(DEFAULT_SCOPE_ID, 'owner-default');
  assert.equal(DEFAULT_MAX_LEVEL, 'L1');
});

test('公开 API 表面齐全（缺一个就是接线漏了）', (t) => {
  const { brain, fc } = createBrain(t);
  const system = buildSystem({ brain, fc, hooks: {} });
  for (const name of [
    'create',
    'get',
    'list',
    'stats',
    'approve',
    'pause',
    'resume',
    'cancel',
    'nextEligible',
    'plan',
    'readGate',
    'describe',
  ]) {
    assert.equal(typeof system[name], 'function', `缺少 ${name}()`);
  }
  assert.equal(typeof system.scheduler.runOnce, 'function');
  assert.equal(typeof system.scheduler.recoverStaleRuns, 'function');
  assert.equal(typeof system.scheduler.recoverOrphans, 'function');
  assert.equal(typeof system.scheduler.heartbeat, 'function');
  assert.equal(typeof system.scheduler.expireStaleDirectives, 'function');
  assert.equal(typeof system.stateMachine.transition, 'function');
  assert.equal(typeof system.stateMachine.history, 'function');
  assert.equal(typeof system.actions.run, 'function');
  assert.equal(typeof system.autonomy.drainCandidates, 'function');
  assert.equal(typeof system.autonomy.previewCandidates, 'function');
  assert.equal(typeof system.permissions.canExecute, 'function');
  assert.equal(typeof system.permissions.assertNoEscalation, 'function');
  assert.equal(typeof system.permissions.describe, 'function');
  assert.equal(typeof system.store.evaluatePreconditions, 'function');
});

test('plan() 是纯读：跑之前与跑之后四张表行数完全一致', async (t) => {
  const { brain, fc } = createBrain(t);
  const workspace = createFakeWorkspace({ switches: { 'autonomy.enabled': '1' } });
  const system = buildSystem({ brain, fc, workspace, hooks: {} });
  const created = await system.create({
    title: '预演用指令',
    idempotencyKey: 'plan-1',
    permissionScope: 'L1',
    allowedTools: ['memory_maintenance'],
  });
  await system.stateMachine.transition({ id: created.id, to: 'queued' });

  const snapshot = () => ({
    directives: countRows(brain.db, 'directives'),
    runs: countRows(brain.db, 'directive_runs'),
    steps: countRows(brain.db, 'directive_steps'),
    audits: countRows(brain.db, 'audit_logs'),
  });
  const before = snapshot();
  const report = system.plan({ limit: 10 });
  assert.deepEqual(snapshot(), before, 'plan 不许写任何东西');
  assert.equal(report.gate.ok, true);
  assert.equal(report.items.length, 1);
  assert.equal(report.items[0].wouldRun, false, '没接 hook 时预演会如实说"跑不动"');
  assert.ok(report.items[0].blockers.includes('hook_missing:memory_maintenance'));
});

test('describe() 的 scheduler 段能当运维摘要读', (t) => {
  const { brain, fc } = createBrain(t);
  const system = buildSystem({ brain, fc, hooks: {} });
  const described = system.describe();
  assert.equal(described.scheduler.zeroWriteWhenSkipped, true);
  assert.equal(described.scheduler.leaseMs > 0, true);
  assert.deepEqual([...described.scheduler.actions].sort(), [
    'alert_sweep',
    'backup_verify',
    'index_rebuild',
    'memory_maintenance',
    'reflection_run',
    'skill_rebuild',
  ]);
  assert.ok(described.scheduler.stopReasons.includes('owner_interrupted'));
  assert.ok(described.scheduler.stopReasons.includes('budget_exhausted'));
  assert.equal(described.scopeId, SCOPE);
});
