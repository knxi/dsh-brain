// @ts-check
/**
 * dry-run：预演报告必须"看得懂"而且"一个字都不写"。
 *
 * `writeAttempts` 这一项是核心：dry-run 注入的写队列是**拒绝器**（写入即抛）。
 * 所以"零写入"不是靠约定，而是每次写都会被抓住并计数。
 */

import test from 'node:test';
import { assert, countRows, createSystem, execRaw } from './helpers.mjs';
import {
  buildDryRunReport,
  createReadOnlyWorkspace,
  renderDryRunReport,
  runDryRunCli,
} from '../../packages/directives/src/index.js';

/** 四表行数快照。 */
function snapshot(db) {
  return {
    directives: countRows(db, 'directives'),
    runs: countRows(db, 'directive_runs'),
    steps: countRows(db, 'directive_steps'),
    audits: countRows(db, 'audit_logs'),
  };
}

/**
 * 造一个"开自主 + 有 hook"的系统，并塞几条不同状态的指令。
 * @param {import('node:test').TestContext} t
 */
async function fixture(t) {
  const created = createSystem(t, {
    workspaceOptions: { switches: { 'autonomy.enabled': '1', 'autonomy.max_level': 'L2' } },
  });
  const { system, brain, fc } = created;
  // 只读 workspace 适配器是直接读 brain_switches 的，所以库里的开关要跟着改
  execRaw(brain.db, "UPDATE brain_switches SET value = '1' WHERE name = 'autonomy.enabled'");
  execRaw(brain.db, "UPDATE brain_switches SET value = 'L2' WHERE name = 'autonomy.max_level'");

  /** @param {string} key @param {Record<string, any>} extra */
  const make = async (key, extra) => {
    const row = await system.create({ title: `指令 ${key}`, idempotencyKey: key, ...extra });
    await system.stateMachine.transition({ id: row.id, to: 'queued' });
    return row.id;
  };

  const runnable = await make('runnable', {
    permissionScope: 'L1',
    allowedTools: ['memory_maintenance', 'index_rebuild'],
    priority: 80,
  });
  const noHook = await make('nohook', { permissionScope: 'L1', allowedTools: ['backup_verify'], priority: 70 });
  const tooHigh = await make('toohigh', { permissionScope: 'L3', priority: 90 });
  return { ...created, runnable, noHook, tooHigh };
}

test('dry-run 零写入：writeAttempts=0，四张表一行不变', async (t) => {
  const { brain, fc, system } = await fixture(t);
  const workspace = createReadOnlyWorkspace({ db: brain.db });
  const before = snapshot(brain.db);

  const report = buildDryRunReport({
    db: brain.db,
    clock: fc.clock,
    workspace,
    bindings: { scope_id: system.scopeId },
    hooks: { memoryMaintenance: async () => ({ ok: true }), indexRebuild: async () => ({ ok: true }) },
    limit: 10,
  });

  assert.equal(report.writeAttempts, 0, '一次写都不许尝试');
  assert.deepEqual(snapshot(brain.db), before, '四张表必须原样');
});

test('报告结构：闸门 / 队列 / 排除项 / 僵尸 run / hook 状态 / 结论', async (t) => {
  const { brain, fc, system, runnable, tooHigh } = await fixture(t);
  const workspace = createReadOnlyWorkspace({ db: brain.db });
  const report = buildDryRunReport({
    db: brain.db,
    clock: fc.clock,
    workspace,
    bindings: { scope_id: system.scopeId },
    hooks: { memoryMaintenance: async () => ({ ok: true }), indexRebuild: async () => ({ ok: true }) },
    limit: 10,
  });

  assert.equal(report.kind, 'directives.dry_run');
  assert.equal(report.gate.ok, true);
  assert.equal(report.gate.maxLevel, 'L2');
  assert.ok(report.counters.queued >= 2);
  assert.equal(report.hooks.length, 6);

  const item = report.items.find((entry) => entry.id === runnable);
  assert.ok(item, '可跑的指令必须出现在预演列表里');
  assert.equal(item.wouldRun, true);
  // 每一步都能看到会不会过
  assert.deepEqual(
    item.executionPlan.map((step) => [step.action, step.willRun]),
    [
      ['memory_maintenance', true],
      ['index_rebuild', true],
    ],
  );

  // L3 指令在 max_level=L2 下必须被列入"排除"并说明原因
  const rejected = report.rejected.find((entry) => entry.id === tooHigh);
  assert.ok(rejected, 'L3 指令必须出现在排除列表');
  assert.equal(rejected.reason, 'missing_required_permission');

  // 没接线的动作要能提前看出来
  const noHook = report.items.find((entry) => entry.actions.some((action) => action.name === 'backup_verify'));
  if (noHook !== undefined) {
    assert.ok(noHook.blockers.includes('hook_missing:backup_verify'));
  }
  assert.equal(report.verdict.wouldRun, true);
  assert.match(report.verdict.sentence, /会跑/);
});

test('渲染文本：主人能读到"排队什么、怎么跑、在哪一步被拦"', async (t) => {
  const { brain, fc, system } = await fixture(t);
  const workspace = createReadOnlyWorkspace({ db: brain.db });
  const report = buildDryRunReport({
    db: brain.db,
    clock: fc.clock,
    workspace,
    bindings: { scope_id: system.scopeId },
    hooks: {},
    limit: 10,
  });
  const text = renderDryRunReport(report);
  assert.match(text, /自主指令 dry-run/);
  assert.match(text, /① 全局闸门/);
  assert.match(text, /② 指令队列/);
  assert.match(text, /执行顺序/);
  assert.match(text, /plan/);
  assert.match(text, /hook_missing/, '没接线的动作要显式标出来');
  assert.match(text, /⑥ 结论/);
  assert.match(text, /没有写任何一行/);
  assert.match(text, /autonomy\.enabled/, '要告诉主人怎么真开');
});

test('闸门关着时结论直说"开不了工"，且不谎称会执行', async (t) => {
  const { brain, fc } = createSystem(t);
  const workspace = createReadOnlyWorkspace({ db: brain.db }); // 默认 autonomy.enabled='0'
  const report = buildDryRunReport({ db: brain.db, clock: fc.clock, workspace, limit: 5 });
  assert.equal(report.gate.ok, false);
  assert.equal(report.gate.reason, 'autonomy_disabled');
  assert.equal(report.verdict.wouldRun, false);
  assert.equal(report.verdict.reason, 'autonomy_disabled');
  assert.match(report.verdict.sentence, /开不了工/);
});

test('僵尸 run 只"预演"，不真回收（跑完报告后 run 仍是 running）', async (t) => {
  const { system, brain, fc } = await createSystem(t, {
    workspaceOptions: { switches: { 'autonomy.enabled': '1' } },
  });
  const created = await system.create({
    title: '会崩溃的指令',
    idempotencyKey: 'crash',
    permissionScope: 'L1',
    allowedTools: ['memory_maintenance'],
  });
  await system.stateMachine.transition({ id: created.id, to: 'queued' });
  const claim = await system.scheduler.claimNext({ owner: 'dead' });
  assert.equal(claim.claimed, true);
  fc.advance(120_000); // 租约过期

  const workspace = createReadOnlyWorkspace({ db: brain.db });
  const report = buildDryRunReport({ db: brain.db, clock: fc.clock, workspace, limit: 5 });
  assert.equal(report.staleRuns.length, 1);
  assert.equal(report.staleRuns[0].runId, claim.claim.runId);
  assert.equal(report.staleRuns[0].leaseOwner, 'dead');
  assert.equal(
    brain.db.prepare('SELECT status FROM directive_runs WHERE id = ?').get(claim.claim.runId).status,
    'running',
    '预演不许改动真实状态',
  );
});

test('候选也进预演：能看到"会转成什么、几级、要不要人批"', async (t) => {
  const { brain, fc, system } = await createSystem(t, {
    workspaceOptions: {
      switches: { 'autonomy.enabled': '1' },
      candidates: [
        {
          id: 'cand_1',
          scopeId: 'owner-default',
          kind: 'directive',
          status: 'proposed',
          originModule: 'dmn',
          title: '整理索引',
          payload: { action: 'index_rebuild' },
          priority: 50,
        },
      ],
    },
  });
  execRaw(brain.db, "UPDATE brain_switches SET value = '1' WHERE name = 'autonomy.enabled'");
  const workspace = createReadOnlyWorkspace({
    db: brain.db,
    candidates: [
      {
        id: 'cand_1',
        scopeId: 'owner-default',
        kind: 'directive',
        status: 'proposed',
        originModule: 'dmn',
        title: '整理索引',
        payload: { action: 'index_rebuild' },
        priority: 50,
      },
    ],
  });
  const report = buildDryRunReport({ db: brain.db, clock: fc.clock, workspace, bindings: { scope_id: 'owner-default' }, limit: 5 });
  assert.equal(report.candidates.ok, true);
  assert.equal(report.candidates.convertible.length, 1);
  assert.equal(report.candidates.convertible[0].permissionScope, 'L1');
  assert.equal(report.candidates.convertible[0].statusAfterDrain, 'awaiting_approval');
  const text = renderDryRunReport(report);
  assert.match(text, /必须人批/);
  void system;
});

test('只读 workspace 适配器：开关读得到、绝不提供写入口', async (t) => {
  const { brain } = createSystem(t);
  execRaw(brain.db, "UPDATE brain_switches SET value = '1' WHERE name = 'autonomy.enabled'");
  const workspace = createReadOnlyWorkspace({ db: brain.db });
  assert.equal(workspace.getSwitch('autonomy.enabled'), '1');
  assert.equal(workspace.isEnabled('autonomy.enabled'), true);
  assert.equal(workspace.isPaused(), false);
  assert.equal(workspace.getSwitch('不存在的开关'), null);
  assert.equal(typeof workspace.setSwitch, 'undefined', '只读适配器不提供 setSwitch');
  assert.equal(workspace.publish({ kind: 'x' }), null, '发布是空操作（发了就是写）');
});

test('CLI：--json 能跑通并输出可解析的报告', async (t) => {
  const { dbPath, brain } = await createSystem(t, {
    workspaceOptions: { switches: { 'autonomy.enabled': '1' } },
  });
  execRaw(brain.db, "UPDATE brain_switches SET value = '1' WHERE name = 'autonomy.enabled'");
  /** @type {string[]} */
  const chunks = [];
  const result = runDryRunCli(['node', 'dry-run.js', '--db', dbPath, '--json'], {
    out: (text) => chunks.push(text),
    err: (text) => chunks.push(text),
  });
  assert.equal(result.exitCode, 0);
  const parsed = JSON.parse(chunks.join(''));
  assert.equal(parsed.kind, 'directives.dry_run');
  assert.equal(parsed.writeAttempts, 0);
  assert.equal(parsed.gate.ok, true);
});

test('CLI：找不到主账 → exitCode 2 且给出人话提示', async () => {
  /** @type {string[]} */
  const chunks = [];
  const result = runDryRunCli(['node', 'dry-run.js', '--db', 'Z:/definitely-not-here/brain.db'], {
    out: (text) => chunks.push(text),
    err: (text) => chunks.push(text),
  });
  assert.equal(result.exitCode, 2);
  assert.match(chunks.join(''), /找不到主账/);
});
