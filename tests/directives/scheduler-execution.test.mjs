// @ts-check
/**
 * 调度器执行路径 —— 每一步都必须留痕，每一条停止理由都必须能对上。
 *
 * 断言口径：**看库里的真实行**（directive_runs / directive_steps / directives），
 * 不只看 `runOnce()` 的返回值。
 */

import test from 'node:test';
import { assert, countAudit, countRows, createSystem, execRaw, readRows } from './helpers.mjs';

/** 打开闸门（autonomy.enabled=1 + max_level）。 */
function gateOpen(extra = {}) {
  return { workspaceOptions: { switches: { 'autonomy.enabled': '1', 'autonomy.max_level': 'L1', ...extra } } };
}

/**
 * 建一条 queued 指令。
 * @param {Record<string, any>} system
 */
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

/** 取一条 run 的全部步骤（按 seq 升序）。 */
function stepsOf(db, runId) {
  return readRows(db, 'directive_steps', 'run_id = ?', [runId]).sort((a, b) => Number(a.seq) - Number(b.seq));
}

test('正常跑完：plan → tool → stop 三步，指令完成，预算如实累计', async (t) => {
  const { system, brain, calls, workspace } = createSystem(t, gateOpen());
  const id = await queueDirective(system, 'happy');

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.skipped, false);
  assert.equal(result.stopReason, 'goal_completed');
  assert.equal(result.runStatus, 'completed');
  assert.equal(result.directiveStatus, 'completed');

  const steps = stepsOf(brain.db, result.runId);
  assert.deepEqual(
    steps.map((step) => step.kind),
    ['plan', 'tool', 'stop'],
    '每一步都要有流水：计划一步、执行一步、停止一步',
  );
  assert.equal(steps[0].ok, null, 'plan 步骤的 ok 是 null（没执行任何东西，不能算成功）');
  assert.equal(Number(steps[1].ok), 1);
  assert.equal(Number(steps[2].ok), 1);
  assert.match(String(steps[1].summary), /memoryMaintenance 完成/);
  assert.match(String(steps[2].summary), /goal_completed/);

  const directive = system.get(id);
  assert.equal(directive.status, 'completed');
  assert.equal(directive.stepsUsed, 1, '只有 tool/error 步骤扣预算，plan/stop 不扣');
  assert.ok(directive.finishedAt !== null, '终态必须写 finished_at');

  const run = readRows(brain.db, 'directive_runs', 'id = ?', [result.runId])[0];
  assert.equal(run.status, 'completed');
  assert.equal(run.stop_reason, 'goal_completed');
  assert.equal(String(run.lease_owner), 't1');
  assert.equal(calls.length, 1, 'hook 只被调用一次');

  // 状态迁移链留痕
  assert.equal(countAudit(brain.db, 'directive.run.claimed'), 1);
  assert.equal(countAudit(brain.db, 'directive.run.finished'), 1);
  assert.equal(countAudit(brain.db, 'directive.transition'), 3, 'queued→running→completed 共 2 次 + 结算时……');
  assert.ok(workspace.published.some((event) => event.kind === 'directive.completed'), '完成后要发一条结果事件');
});

test('多动作按声明顺序执行（顺序就是 allowedTools 的顺序）', async (t) => {
  const { system, brain, calls } = createSystem(t, gateOpen());
  const id = await queueDirective(system, 'multi', { allowedTools: ['index_rebuild', 'memory_maintenance', 'alert_sweep'] });

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.stopReason, 'goal_completed');
  assert.deepEqual(
    calls.map((call) => call.hook),
    ['indexRebuild', 'memoryMaintenance', 'alertSweep'],
    '必须严格按声明的顺序执行',
  );
  const tools = stepsOf(brain.db, result.runId).filter((step) => step.kind === 'tool');
  assert.equal(tools.length, 3);
  assert.deepEqual(
    tools.map((step) => JSON.parse(String(step.evidence_json)).action),
    ['index_rebuild', 'memory_maintenance', 'alert_sweep'],
  );
  assert.equal(system.get(id).stepsUsed, 3);
});

test('步数预算：超了立刻停（第二个动作根本不执行）', async (t) => {
  const { system, brain, calls } = createSystem(t, gateOpen());
  const id = await queueDirective(system, 'step-budget', {
    allowedTools: ['memory_maintenance', 'index_rebuild'],
    stepBudget: 1,
  });

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.stopReason, 'budget_exhausted');
  assert.equal(result.directiveStatus, 'blocked');
  assert.equal(result.runStatus, 'blocked');
  assert.equal(calls.length, 1, '预算只有 1 步，第二个 hook 不许被调用');

  const directive = system.get(id);
  assert.equal(directive.stepsUsed, 1);
  assert.equal(directive.status, 'blocked');
  assert.equal(directive.lastError, 'budget_exhausted');
  const run = readRows(brain.db, 'directive_runs', 'id = ?', [result.runId])[0];
  assert.equal(run.stop_reason, 'budget_exhausted');
});

test('token 预算：超了立刻停，用量如实记账', async (t) => {
  const { system, brain, calls } = createSystem(t, {
    ...gateOpen(),
    hookImpls: { memoryMaintenance: async () => ({ ok: true, tokens: 25, summary: '用了 25 token' }) },
  });
  const id = await queueDirective(system, 'token-budget', {
    allowedTools: ['memory_maintenance', 'index_rebuild'],
    tokenBudget: 20,
  });

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.stopReason, 'budget_exhausted');
  assert.equal(result.detail.budget, 'tokens');
  assert.equal(calls.length, 1, 'token 已经超了，第二个动作不许执行');
  assert.equal(system.get(id).tokensUsed, 25, '用量要如实记（不能"因为超了就当没花"）');
  assert.equal(system.get(id).status, 'blocked');
});

test('时间预算：跑过 time_budget 就停（time_exhausted）', async (t) => {
  const { system, brain, calls, fc } = createSystem(t, {
    ...gateOpen(),
    hookImpls: {
      memoryMaintenance: async () => {
        fc.advance(2000); // 假时钟推进 2 秒，模拟这一步跑了很久
        return { ok: true, summary: '慢动作完成' };
      },
    },
  });
  const id = await queueDirective(system, 'time-budget', {
    allowedTools: ['memory_maintenance', 'index_rebuild'],
    timeBudgetSeconds: 1,
  });

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.stopReason, 'time_exhausted');
  assert.equal(result.runStatus, 'timeout');
  assert.equal(calls.length, 1, '时间已经超了，第二个动作不许执行');
  assert.equal(system.get(id).status, 'blocked');
});

test('hook 没接线：停下并进 blocked，绝不假装完成', async (t) => {
  const { system, brain, calls, alerts } = createSystem(t, { ...gateOpen(), hooks: {} });
  const id = await queueDirective(system, 'no-hook');

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.stopReason, 'hook_missing');
  assert.equal(result.directiveStatus, 'blocked');
  assert.equal(calls.length, 0);
  const steps = stepsOf(brain.db, result.runId);
  assert.deepEqual(steps.map((step) => step.kind), ['plan', 'error', 'stop']);
  assert.equal(Number(steps[1].ok), 0);
  assert.match(String(steps[1].summary), /未接线/);
  assert.ok(alerts.some((info) => info.kind === 'directive_hook_missing'), '缺 hook 要进告警');
  assert.equal(system.get(id).stepsUsed, 1, '失败的那一步也扣预算（跑了就是跑了）');
});

test('动作失败 → 有重试额度就回队列，重试用尽才是终态 failed', async (t) => {
  const { system, brain, calls } = createSystem(t, {
    ...gateOpen(),
    hookImpls: {
      memoryMaintenance: async () => {
        throw new Error('索引文件被占用');
      },
    },
  });
  const id = await queueDirective(system, 'fail-retry', { maxRetries: 1 });

  const first = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(first.stopReason, 'action_failed');
  assert.equal(first.runStatus, 'failed');
  assert.equal(first.directiveStatus, 'queued', '还有重试额度 → 回队列');
  assert.equal(system.get(id).status, 'queued');
  assert.equal(calls.length, 1);

  const second = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(second.stopReason, 'action_failed');
  assert.equal(second.directiveStatus, 'failed', '失败次数超过 max_retries → 终态 failed');
  assert.equal(system.get(id).status, 'failed');
  assert.equal(countRows(brain.db, 'directive_runs'), 2, '两次尝试 = 两条 run');
  // running → blocked → queued / failed 都要留审计
  assert.ok(countAudit(brain.db, 'directive.transition') >= 5);
});

test('hook 报 ok:false（不是抛错）也走失败路径，不吞', async (t) => {
  const { system } = createSystem(t, {
    ...gateOpen(),
    hookImpls: { memoryMaintenance: async () => ({ ok: false, reason: 'index_locked', summary: '索引被占用' }) },
  });
  const id = await queueDirective(system, 'fail-soft', { maxRetries: 0 });
  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.stopReason, 'action_failed');
  assert.equal(result.detail.reason, 'index_locked');
  assert.equal(system.get(id).status, 'failed');
});

test('任意命令执行：手改库塞进 shell，执行前也被拦下（blocked，hook 没被调）', async (t) => {
  // 这里把 max_level 开到 L3，是为了让"等级检查"放行、单看""动作白名单"这一道能不能拦住。
  const { system, brain, calls } = createSystem(t, {
    workspaceOptions: { switches: { 'autonomy.enabled': '1', 'autonomy.max_level': 'L3' } },
  });
  const id = await queueDirective(system, 'tamper-shell', { permissionScope: 'L3' });
  // 模拟有人直接改库：把动作换成 shell（等级 L3 让它能通过等级检查）
  execRaw(brain.db, "UPDATE directives SET allowed_tools_json = '[\"shell\"]', permission_scope = 'L3' WHERE id = ?", [id]);

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.stopReason, 'missing_required_permission');
  assert.equal(result.detail.verdict, 'action_not_in_whitelist');
  assert.equal(result.directiveStatus, 'blocked');
  assert.equal(calls.length, 0, 'shell 不可能被调用任何 hook');
  const steps = stepsOf(brain.db, result.runId);
  assert.deepEqual(steps.map((step) => step.kind), ['plan', 'stop'], '只有计划与停止两步：一个动作都没执行');
  assert.equal(Number(steps[1].ok), 0);
});

test('等级不够：L2 指令在 max_level=L1 下连认领都不会发生（skipped + 零 run）', async (t) => {
  const { system, brain } = createSystem(t, gateOpen());
  const id = await queueDirective(system, 'l2-blocked', { permissionScope: 'L2', allowedTools: ['reflection_run'] });

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'missing_required_permission');
  assert.equal(countRows(brain.db, 'directive_runs'), 0, '被排除的指令不该产生 run');
  assert.equal(system.get(id).status, 'queued', '仍然是 queued（等主人提等级）');
});

test('过期指令：runOnce 会把它作废成 cancelled（不留僵尸）', async (t) => {
  const { system, brain } = createSystem(t, gateOpen());
  const id = await queueDirective(system, 'expired', { validUntil: '2026-10-30T07:00:00.000Z' });
  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.expired, 1);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'queue_empty');
  assert.equal(system.get(id).status, 'cancelled');
  const audits = readRows(brain.db, 'audit_logs', "action = 'directive.transition' AND target_id = ?", [id]);
  const last = JSON.parse(String(audits[audits.length - 1].detail));
  assert.equal(last.reason, 'valid_until_passed');
});

test('执行中途按暂停：下一个动作前立刻停手（owner_interrupted → paused）', async (t) => {
  const { system, brain, calls, workspace } = createSystem(t, {
    ...gateOpen(),
    hookImpls: {
      memoryMaintenance: async () => {
        workspace.set('paused', '1'); // 第一步执行期间主人按了暂停
        return { ok: true, summary: '第一步完成' };
      },
    },
  });
  const id = await queueDirective(system, 'interrupt', { allowedTools: ['memory_maintenance', 'index_rebuild'] });

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.stopReason, 'owner_interrupted');
  assert.equal(result.runStatus, 'cancelled');
  assert.equal(result.directiveStatus, 'paused');
  assert.equal(calls.length, 1, '暂停之后第二个动作不许执行');
  const directive = system.get(id);
  assert.equal(directive.status, 'paused', '被打断的指令是可恢复的 paused（不是终态）');
  assert.equal(directive.stepsUsed, 1);
});

test('执行中途把 autonomy.enabled 关掉：同样立刻停手', async (t) => {
  const { system, calls, workspace } = createSystem(t, {
    ...gateOpen(),
    hookImpls: {
      memoryMaintenance: async () => {
        workspace.set('autonomy.enabled', '0');
        return { ok: true, summary: '第一步完成' };
      },
    },
  });
  await queueDirective(system, 'interrupt2', { allowedTools: ['memory_maintenance', 'index_rebuild'] });
  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.stopReason, 'owner_interrupted');
  assert.equal(calls.length, 1);
});

test('maxSteps 保护：计划比上限长时先停，指令回队列（不吃掉整轮）', async (t) => {
  const { system, calls } = createSystem(t, gateOpen());
  const id = await queueDirective(system, 'cap', {
    allowedTools: ['memory_maintenance', 'index_rebuild', 'alert_sweep'],
    stepBudget: 10,
  });
  const result = await system.scheduler.runOnce({ owner: 't1', maxSteps: 2 });
  assert.equal(result.stopReason, 'step_cap_reached');
  assert.equal(result.runStatus, 'cancelled');
  assert.equal(result.directiveStatus, 'queued', '没跑完 → 回队列');
  assert.equal(calls.length, 2);
  assert.equal(system.get(id).status, 'queued');
});

test('指令没有任何动作：不许"空跑一轮算完成"（blocked）', async (t) => {
  const { system, brain } = createSystem(t, gateOpen());
  const id = await queueDirective(system, 'no-action', { allowedTools: [] });
  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.stopReason, 'missing_required_permission');
  assert.equal(result.directiveStatus, 'blocked');
  assert.equal(system.get(id).stepsUsed, 0);
  const steps = stepsOf(brain.db, result.runId);
  assert.deepEqual(steps.map((step) => step.kind), ['plan', 'stop']);
});

test('优先级：队列里优先级高的先跑', async (t) => {
  const { system, calls, fc } = createSystem(t, gateOpen());
  const low = await queueDirective(system, 'low', { priority: 10 });
  fc.advance(1000);
  const high = await queueDirective(system, 'high', { priority: 90 });

  await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(system.get(high).status, 'completed');
  assert.equal(system.get(low).status, 'queued');
  assert.equal(calls.length, 1);
});
