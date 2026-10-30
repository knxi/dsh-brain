// @ts-check
/**
 * 内置动作执行器。
 *
 * 这一组的核心只有一句话：**没接 hook 就返回失败，绝不假装成功。**
 */

import test from 'node:test';
import { assert, createSystem } from './helpers.mjs';
import {
  ACTION_LABELS,
  EXECUTABLE_ACTION_NAMES,
  createActionRegistry,
} from '../../packages/directives/src/index.js';

/** 最小 ctx（调度器会组得比这全，动作不该依赖更多）。 */
function ctx(extra = {}) {
  return { scopeId: 'owner-default', directiveId: 'dir_x', runId: 'run_x', action: 'memory_maintenance', ...extra };
}

test('六个白名单动作逐个跑通，hook 能收到完整 ctx', async (t) => {
  const { system, calls } = createSystem(t);
  const hooks = system.actions.list();
  assert.equal(hooks.length, 6);
  assert.deepEqual(hooks.map((entry) => entry.name).sort(), [...EXECUTABLE_ACTION_NAMES].sort());
  for (const entry of hooks) {
    assert.ok(ACTION_LABELS[entry.name] !== undefined, `${entry.name} 要有中文短名`);
    assert.equal(entry.available, true, 'createSystem 默认把六个 hook 都接上');
  }

  for (const name of EXECUTABLE_ACTION_NAMES) {
    const outcome = await system.actions.run({ name, ctx: ctx({ action: name }) });
    assert.equal(outcome.ok, true, `${name} 应该成功`);
    assert.equal(outcome.action, name);
    assert.equal(outcome.reason, 'ok');
    assert.ok(outcome.summary.length > 0);
  }
  assert.equal(calls.length, 6);
  assert.equal(calls[0].ctx.directiveId, 'dir_x');
  assert.equal(calls[0].ctx.scopeId, 'owner-default');
});

test('白名单外动作：返回 action_not_in_whitelist（不抛，交给调度器记一步失败）', async (t) => {
  const { system } = createSystem(t);
  for (const name of ['shell', 'write_file', 'http_request', 'send_message', 'nonsense']) {
    const outcome = await system.actions.run({ name, ctx: ctx({ action: name }) });
    assert.equal(outcome.ok, false, `${name} 绝不允许执行`);
    assert.equal(outcome.reason, 'action_not_in_whitelist');
    assert.match(outcome.summary, /白名单/);
  }
});

test('没有 hook：hook_missing，摘要明说"没有执行、也不假装完成"，并进告警', async (t) => {
  const { system, alerts, calls } = createSystem(t, { hooks: {} });
  const outcome = await system.actions.run({ name: 'index_rebuild', ctx: ctx({ action: 'index_rebuild' }) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'hook_missing');
  assert.match(outcome.summary, /未接线/);
  assert.match(outcome.summary, /不假装完成/);
  assert.equal(outcome.result.hook, 'indexRebuild');
  assert.equal(calls.length, 0);
  assert.ok(alerts.some((info) => info.kind === 'directive_hook_missing'));
  assert.equal(system.actions.available('index_rebuild'), false);
});

test('hook 抛错：hook_failed + 错误摘要（不吞、不变成成功）', async (t) => {
  const { system } = createSystem(t, {
    hookImpls: {
      backupVerify: async () => {
        throw new Error('备份目录不存在');
      },
    },
  });
  const outcome = await system.actions.run({ name: 'backup_verify', ctx: ctx({ action: 'backup_verify' }) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'hook_failed');
  assert.match(outcome.summary, /备份目录不存在/);
  assert.match(String(outcome.result.error), /备份目录不存在/);
});

test('hook 返回 ok:false：原样上报（reason 保留 hook 给的码）', async (t) => {
  const { system } = createSystem(t, {
    hookImpls: { alertSweep: async () => ({ ok: false, reason: 'sweep_locked', summary: '告警表被锁' }) },
  });
  const outcome = await system.actions.run({ name: 'alert_sweep', ctx: ctx({ action: 'alert_sweep' }) });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, 'sweep_locked');
  assert.equal(outcome.summary, '告警表被锁');
});

test('hook 什么都不返回：按"跑完了但没话说"处理，摘要里明说', async (t) => {
  const { system } = createSystem(t, {
    hookImpls: { skillRebuild: async () => undefined },
  });
  const outcome = await system.actions.run({ name: 'skill_rebuild', ctx: ctx({ action: 'skill_rebuild' }) });
  assert.equal(outcome.ok, true);
  assert.match(outcome.summary, /未返回结果/);
});

test('token 记账：负数/NaN 一律记 0（不许把预算算成负数）', async (t) => {
  const { system } = createSystem(t, {
    hookImpls: {
      memoryMaintenance: async () => ({ ok: true, tokens: -5 }),
      indexRebuild: async () => ({ ok: true, tokens: Number.NaN }),
      alertSweep: async () => ({ ok: true, tokens: 12.7 }),
    },
  });
  assert.equal((await system.actions.run({ name: 'memory_maintenance', ctx: ctx() })).tokens, 0);
  assert.equal((await system.actions.run({ name: 'index_rebuild', ctx: ctx() })).tokens, 0);
  assert.equal((await system.actions.run({ name: 'alert_sweep', ctx: ctx() })).tokens, 12);
});

test('注册表可以脱离数据库单独构造（纯执行器，便于单测）', async () => {
  /** @type {any[]} */
  const calls = [];
  const registry = createActionRegistry({
    hooks: {
      memoryMaintenance: async (input) => {
        calls.push(input);
        return { ok: true, summary: '整理完成' };
      },
    },
  });
  assert.equal(registry.available('memory_maintenance'), true);
  assert.equal(registry.available('index_rebuild'), false);
  assert.deepEqual(registry.hooksBound, ['memoryMaintenance']);

  const outcome = await registry.run({ name: 'memory_maintenance', ctx: { directiveId: 'd1' } });
  assert.equal(outcome.summary, '整理完成');
  assert.deepEqual(calls, [{ directiveId: 'd1' }]);
});

test('动作对象形状：{ name, level, run({ ctx, directive, run }) }（任务书口径）', async (t) => {
  const { system, calls } = createSystem(t);
  const action = system.actions.get('memory_maintenance');
  assert.ok(action !== null);
  assert.equal(action.name, 'memory_maintenance');
  assert.equal(action.level, 'L1');
  assert.equal(action.hook, 'memoryMaintenance');
  assert.equal(action.available, true);

  const outcome = await action.run({
    ctx: { directiveId: 'dir_a', scopeId: 'owner-default' },
    directive: { id: 'dir_a', title: '整理索引' },
    run: { id: 'run_a', attempt: 1 },
  });
  assert.equal(outcome.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].ctx.directive.id, 'dir_a', 'directive 要能透传给 hook');
  assert.equal(calls[0].ctx.run.id, 'run_a', 'run 要能透传给 hook');

  // 白名单外返回 null（而不是一个"永远失败"的假动作）
  assert.equal(system.actions.get('shell'), null);
  assert.equal(system.actions.registry().length, 6);
  assert.deepEqual(
    system.actions.registry().map((entry) => entry.name),
    [...EXECUTABLE_ACTION_NAMES],
  );
});
