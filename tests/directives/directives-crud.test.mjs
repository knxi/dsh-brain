// @ts-check
/**
 * 指令对象 CRUD 与"谁该跑"的判定。
 *
 * 重点盯四件事：**幂等键必填**、**新指令一律 proposed**、**反扩权**、**跨 scope 不泄漏**。
 */

import test from 'node:test';
import {
  assert,
  buildSystem,
  countAudit,
  countRows,
  createSystem,
  execRaw,
  readRows,
} from './helpers.mjs';
import {
  PermissionEscalationError,
  DirectivesArgumentError,
  InvalidTransitionError,
  canExecute,
} from '../../packages/directives/src/index.js';

/** 一条最小可用的指令入参。 */
function input(key, extra = {}) {
  return { title: `指令 ${key}`, idempotencyKey: key, createdBy: 'test', ...extra };
}

test('create：正常路径，字段往返，新指令一律 proposed', async (t) => {
  const { system, brain } = createSystem(t);
  const result = await system.create(
    input('c1', {
      reason: '因为要整理索引',
      trigger: 'idle',
      priority: 70,
      permissionScope: 'L1',
      allowedTools: ['index_rebuild', 'memory_maintenance'],
      stepBudget: 4,
      timeBudgetSeconds: 120,
      tokenBudget: 1000,
      maxRetries: 1,
      preconditions: [{ kind: 'always' }],
      stopConditions: ['goal_completed'],
    }),
  );
  assert.equal(result.created, true);
  assert.equal(result.directive.status, 'proposed', '新指令必须是 proposed（要进队列得再走一次显式转移）');
  assert.equal(result.directive.permissionScope, 'L1');
  assert.equal(result.directive.source, 'owner');
  assert.equal(result.directive.trigger, 'idle');
  assert.equal(result.directive.priority, 70);
  assert.deepEqual(result.directive.allowedTools, ['index_rebuild', 'memory_maintenance']);
  assert.deepEqual(result.directive.preconditions, [{ kind: 'always' }]);
  assert.deepEqual(result.directive.budgets, { step: 4, timeSeconds: 120, token: 1000 });
  assert.deepEqual(result.directive.remaining, { steps: 4, tokens: 1000 });
  assert.equal(result.directive.maxRetries, 1);
  assert.equal(result.directive.stepsUsed, 0);
  assert.equal(result.directive.version, 1);
  assert.match(result.directive.id, /^dir_[0-9a-f]{24}$/);

  // 落库的行也要能读回来（不只是内存对象）
  const row = readRows(brain.db, 'directives', 'id = ?', [result.id])[0];
  assert.equal(row.status, 'proposed');
  assert.equal(row.permission_scope, 'L1');
  assert.equal(countAudit(brain.db, 'directive.created'), 1);

  const fetched = system.get(result.id);
  assert.deepEqual(fetched, result.directive, 'get 必须原样往返');
});

test('idempotencyKey 必填：没有它就拒绝创建', async (t) => {
  const { system, brain } = createSystem(t);
  await assert.rejects(
    () => system.create({ title: '没有幂等键' }),
    (error) => {
      assert.ok(error instanceof DirectivesArgumentError);
      assert.equal(error.code, 'INVALID_ARGUMENT');
      assert.equal(/** @type {any} */ (error).reason, 'idempotency_key_required');
      return true;
    },
  );
  assert.equal(countRows(brain.db, 'directives'), 0, '被拒的创建不许落库');
});

test('同 idempotencyKey 重复创建 → 返回既有那条，不新建、不覆盖', async (t) => {
  const { system, brain } = createSystem(t);
  const first = await system.create(input('same-key', { title: '第一次的标题' }));
  const second = await system.create(input('same-key', { title: '第二次的标题（不该覆盖）' }));
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(second.directive.title, '第一次的标题', '幂等重放不许改写既有内容');
  assert.equal(countRows(brain.db, 'directives'), 1);
  assert.equal(countAudit(brain.db, 'directive.create_reused'), 1, '重复创建要留一条审计（可解释为什么没有第二条）');
});

test('三项预算必须 > 0（0 等于创建一条永远做不了事的指令）', async (t) => {
  const { system, brain } = createSystem(t);
  for (const field of ['stepBudget', 'timeBudgetSeconds', 'tokenBudget']) {
    await assert.rejects(
      () => system.create(input(`zero-${field}`, { [field]: 0 })),
      (error) => {
        assert.equal(/** @type {any} */ (error).reason, 'budget_not_positive', `${field}=0 必须拒`);
        assert.equal(/** @type {any} */ (error).details.field, field);
        return true;
      },
    );
    await assert.rejects(
      () => system.create(input(`neg-${field}`, { [field]: -1 })),
      (error) => /** @type {any} */ (error).reason === 'budget_not_positive',
    );
  }
  assert.equal(countRows(brain.db, 'directives'), 0);
});

test('预算超过硬上限 / 等级/触发/优先级非法 → 一律拒', async (t) => {
  const { system } = createSystem(t);
  await assert.rejects(
    () => system.create(input('over', { tokenBudget: 10_000_000 })),
    (error) => /** @type {any} */ (error).reason === 'budget_out_of_range',
  );
  await assert.rejects(
    () => system.create(input('scope', { permissionScope: 'L9' })),
    (error) => /** @type {any} */ (error).reason === 'invalid_permission_scope',
  );
  await assert.rejects(
    () => system.create(input('trigger', { trigger: 'whenever' })),
    (error) => /** @type {any} */ (error).reason === 'invalid_trigger',
  );
  await assert.rejects(
    () => system.create(input('priority', { priority: 101 })),
    (error) => /** @type {any} */ (error).reason === 'invalid_priority',
  );
});

test('allowedTools 里写 shell → 拒（任意命令执行到不了数据库）', async (t) => {
  const { system, brain } = createSystem(t);
  await assert.rejects(
    () => system.create(input('cmd', { permissionScope: 'L3', allowedTools: ['shell'] })),
    (error) => {
      assert.ok(error instanceof DirectivesArgumentError);
      assert.equal(/** @type {any} */ (error).reason, 'action_not_in_whitelist');
      assert.equal(/** @type {any} */ (error).details.action, 'shell');
      assert.equal(/** @type {any} */ (error).details.hazard, 'arbitrary_command_execution');
      return true;
    },
  );
  assert.equal(countRows(brain.db, 'directives'), 0);
});

test('allowedTools 越级（L1 指令声明 L2 动作）→ 拒', async (t) => {
  const { system } = createSystem(t);
  await assert.rejects(
    () => system.create(input('lvl', { permissionScope: 'L1', allowedTools: ['reflection_run'] })),
    (error) => {
      assert.equal(/** @type {any} */ (error).reason, 'action_requires_higher_level');
      assert.equal(/** @type {any} */ (error).details.required, 'L2');
      return true;
    },
  );
});

test('反扩权（真实库路径）：子指令等级高于父指令 → PermissionEscalationError，且不留半条子指令', async (t) => {
  const { system, brain } = createSystem(t);
  const parent = await system.create(
    input('parent', { permissionScope: 'L2', stepBudget: 8, timeBudgetSeconds: 200, tokenBudget: 8000 }),
  );
  await assert.rejects(
    () =>
      system.create(
        input('child-esc', {
          permissionScope: 'L3',
          parentGoalId: parent.id,
          stepBudget: 2,
          timeBudgetSeconds: 60,
          tokenBudget: 1000,
        }),
      ),
    (error) => {
      assert.ok(error instanceof PermissionEscalationError, '必须是 PermissionEscalationError');
      assert.equal(/** @type {any} */ (error).code, 'PERMISSION_ESCALATION');
      assert.equal(/** @type {any} */ (error).info.kind, 'permission_scope');
      return true;
    },
  );
  assert.equal(countRows(brain.db, 'directives'), 1, '越权子指令不许留下半行');
});

test('反扩权（真实库路径）：预算超父 / 动作超父 也拒', async (t) => {
  const { system } = createSystem(t);
  const parent = await system.create(
    input('parent2', {
      permissionScope: 'L2',
      allowedTools: ['memory_maintenance'],
      stepBudget: 5,
      timeBudgetSeconds: 60,
      tokenBudget: 4000,
    }),
  );

  await assert.rejects(
    () =>
      system.create(
        input('child-budget', {
          permissionScope: 'L2',
          allowedTools: ['memory_maintenance'],
          parentGoalId: parent.id,
          stepBudget: 6,
          timeBudgetSeconds: 60,
          tokenBudget: 4000,
        }),
      ),
    (error) => /** @type {any} */ (error).info.kind === 'step_budget',
  );
  await assert.rejects(
    () =>
      system.create(
        input('child-tools', {
          permissionScope: 'L2',
          allowedTools: ['memory_maintenance', 'index_rebuild'],
          parentGoalId: parent.id,
          stepBudget: 3,
          timeBudgetSeconds: 30,
          tokenBudget: 1000,
        }),
      ),
    (error) => /** @type {any} */ (error).info.kind === 'allowed_tools',
  );

  // 同集合、同预算的子指令是合法的（保守派生允许）
  const okChild = await system.create(
    input('child-ok', {
      permissionScope: 'L2',
      allowedTools: ['memory_maintenance'],
      parentGoalId: parent.id,
      stepBudget: 5,
      timeBudgetSeconds: 60,
      tokenBudget: 4000,
    }),
  );
  assert.equal(okChild.created, true);
  assert.equal(okChild.directive.parentGoalId, parent.id);
});

test('父指令不存在 / 父指令已是终态 → 不许派生', async (t) => {
  const { system } = createSystem(t);
  await assert.rejects(
    () => system.create(input('orphan', { parentGoalId: 'dir_does_not_exist' })),
    (error) => /** @type {any} */ (error).code === 'NOT_FOUND',
  );

  const parent = await system.create(input('parent3'));
  await system.stateMachine.transition({ id: parent.id, to: 'cancelled' });
  await assert.rejects(
    () => system.create(input('child-of-dead', { parentGoalId: parent.id })),
    (error) => /** @type {any} */ (error).reason === 'parent_terminal',
  );
});

test('approve：只把 awaiting_approval 变成 queued，其它状态一律抛', async (t) => {
  const { system, brain } = createSystem(t);
  const id = (await system.create(input('appr'))).id;

  await assert.rejects(
    () => system.approve(id),
    (error) => {
      assert.ok(error instanceof InvalidTransitionError, 'proposed 不能直接 approve');
      return true;
    },
  );

  await system.stateMachine.transition({ id, to: 'awaiting_approval' });
  const approved = await system.approve(id, { by: 'owner' });
  assert.equal(approved.from, 'awaiting_approval');
  assert.equal(approved.to, 'queued');
  assert.equal(system.get(id).status, 'queued');
  assert.equal(countAudit(brain.db, 'directive.transition'), 2);
});

test('pause / resume / cancel：重复调用宽容，终态抛错', async (t) => {
  const { system } = createSystem(t);
  const id = (await system.create(input('ops'))).id;

  // queued 才能 pause；proposed 直接 pause 是非法的
  await assert.rejects(() => system.pause(id), (error) => error instanceof InvalidTransitionError);
  await system.stateMachine.transition({ id, to: 'queued' });

  const paused = await system.pause(id);
  assert.equal(paused.changed, true);
  const pausedAgain = await system.pause(id);
  assert.equal(pausedAgain.changed, false, '重复 pause 不抛，返回 changed:false');
  assert.equal(system.get(id).status, 'paused');

  const resumed = await system.resume(id);
  assert.equal(resumed.to, 'queued');
  const resumedAgain = await system.resume(id);
  assert.equal(resumedAgain.changed, false, '已经是 queued 时 resume 宽容返回');

  const cancelled = await system.cancel(id);
  assert.equal(cancelled.to, 'cancelled');
  const cancelledAgain = await system.cancel(id);
  assert.equal(cancelledAgain.changed, false);
  // 终态后不许再 pause
  await assert.rejects(() => system.pause(id), (error) => error instanceof InvalidTransitionError);
  await assert.rejects(() => system.cancel('dir_missing'), (error) => /** @type {any} */ (error).code === 'NOT_FOUND');
});

test('nextEligible：priority DESC + created_at ASC，只挑 queued', async (t) => {
  const { system, fc } = createSystem(t);
  const low = await system.create(input('low', { priority: 10 }));
  fc.advance(1000);
  const high = await system.create(input('high', { priority: 90 }));
  fc.advance(1000);
  const sameHigh = await system.create(input('high2', { priority: 90 }));
  const pending = await system.create(input('not-queued', { priority: 100 }));

  for (const id of [low.id, high.id, sameHigh.id]) {
    await system.stateMachine.transition({ id, to: 'queued' });
  }

  const picked = system.nextEligible({ limit: 10 });
  assert.deepEqual(
    picked.items.map((item) => item.id),
    [high.id, sameHigh.id, low.id],
    '优先级高的先，同优先级按创建时间早的先',
  );
  assert.ok(!picked.items.some((item) => item.id === pending.id), 'proposed 不参与排队');
});

test('nextEligible：过期 / 前置条件不满足 / 未知前置条件 / 等级不足 都会被排除且给出原因', async (t) => {
  const { system, workspace } = createSystem(t);
  // 默认 paused='0'，这里先真正暂停，才能测“not_paused 不满足”
  workspace.set('paused', '1');
  const expired = await system.create(input('expired', { validUntil: '2026-10-30T07:00:00.000Z' }));
  const pausedReq = await system.create(input('need-not-paused', { preconditions: [{ kind: 'not_paused' }] }));
  const unknown = await system.create(input('unknown-pre', { preconditions: [{ kind: 'moon_phase' }] }));
  const tooHigh = await system.create(input('l3', { permissionScope: 'L3' }));
  for (const id of [expired.id, pausedReq.id, unknown.id, tooHigh.id]) {
    await system.stateMachine.transition({ id, to: 'queued' });
  }

  const strict = system.nextEligible({ limit: 10, maxLevel: 'L1' });
  assert.equal(strict.items.length, 0);
  const reasons = Object.fromEntries(strict.rejected.map((entry) => [entry.id, entry.reason]));
  assert.equal(reasons[expired.id], 'valid_until_passed');
  assert.equal(reasons[pausedReq.id], 'precondition_failed:not_paused');
  assert.equal(reasons[unknown.id], 'precondition_failed:moon_phase', '未知前置条件 = 不满足（失败关）');
  assert.equal(reasons[tooHigh.id], 'missing_required_permission');

  // 暂停被解除后，只有那一条变成可执行
  workspace.set('paused', '0');
  const loose = system.nextEligible({ limit: 10, maxLevel: 'L1' });
  assert.deepEqual(loose.items.map((item) => item.id), [pausedReq.id]);
});

test('跨 scope：看不到、取不到、改不了（一律 NOT_FOUND，不泄露存在性）', async (t) => {
  const { brain, fc } = createSystem(t);
  const scopeA = buildSystem({ brain, fc, hooks: {}, scopeId: 'scope-a' });
  const scopeB = buildSystem({ brain, fc, hooks: {}, scopeId: 'scope-b' });
  const created = await scopeA.create(input('a-only'));

  assert.equal(scopeB.get(created.id), null);
  assert.deepEqual(scopeB.list(), { items: [], limit: 50 });
  assert.equal(scopeB.nextEligible({ limit: 10 }).items.length, 0);
  await assert.rejects(() => scopeB.cancel(created.id), (error) => /** @type {any} */ (error).code === 'NOT_FOUND');
  // 表的 scope_id 必须写对
  assert.equal(readRows(brain.db, 'directives', 'id = ?', [created.id])[0].scope_id, 'scope-a');
});

test('list 过滤与 stats', async (t) => {
  const { system } = createSystem(t);
  const a = await system.create(input('s1', { source: 'owner' }));
  const b = await system.create(input('s2', { source: 'maintenance' }));
  await system.stateMachine.transition({ id: a.id, to: 'queued' });

  assert.equal(system.list({ status: 'queued' }).items.length, 1);
  assert.equal(system.list({ status: ['proposed', 'queued'] }).items.length, 2);
  assert.equal(system.list({ source: 'owner' }).items.length, 1);
  assert.equal(system.list({ source: 'maintenance' }).items[0].id, b.id);
  assert.equal(system.list({ limit: 1 }).items.length, 1);

  const stats = system.stats();
  assert.equal(stats.proposed, 1);
  assert.equal(stats.queued, 1);
  assert.equal(stats.total, 2);
});

test('preconditions 求值：switch / time_window / after / budget_left 各有明确语义', async (t) => {
  const { system, workspace, fc } = createSystem(t);
  workspace.set('social.enabled', '1');

  const switchOk = await system.create(
    input('sw', { preconditions: [{ kind: 'switch', name: 'social.enabled', equals: '1' }] }),
  );
  const windowOk = await system.create(
    input('tw', { preconditions: [{ kind: 'time_window', from: '00:00', to: '23:59' }] }),
  );
  const afterOk = await system.create(
    input('after', { preconditions: [{ kind: 'after', at: '2026-01-01T00:00:00.000Z' }] }),
  );
  const afterBad = await system.create(
    input('after-bad', { preconditions: [{ kind: 'after', at: '2030-01-01T00:00:00.000Z' }] }),
  );
  const budgetOk = await system.create(input('budget', { preconditions: [{ kind: 'budget_left', steps: 1 }] }));
  for (const directive of [switchOk, windowOk, afterOk, afterBad, budgetOk]) {
    await system.stateMachine.transition({ id: directive.id, to: 'queued' });
  }
  fc.advance(1000);

  const picked = system.nextEligible({ limit: 10 });
  const ids = picked.items.map((item) => item.id);
  assert.ok(ids.includes(switchOk.id), 'switch 相等 → 满足');
  assert.ok(ids.includes(windowOk.id), '本地时间在窗口内 → 满足');
  assert.ok(ids.includes(afterOk.id), '时间已过 → 满足');
  assert.ok(ids.includes(budgetOk.id), '剩余步数够 → 满足');
  assert.ok(!ids.includes(afterBad.id), '时间未到 → 不满足');
  const bad = picked.rejected.find((entry) => entry.id === afterBad.id);
  assert.equal(bad.reason, 'precondition_failed:after');

  // 开关变了之后，原来满足的那条就不满足了
  workspace.set('social.enabled', '0');
  const again = system.nextEligible({ limit: 10 });
  assert.ok(!again.items.some((item) => item.id === switchOk.id));
  const switched = again.rejected.find((entry) => entry.id === switchOk.id);
  assert.equal(switched.reason, 'precondition_failed:switch');
});

test('停止条件只能加严：写进库里的是调用方的列表，强制集另有其表', async (t) => {
  const { system } = createSystem(t);
  const created = await system.create(input('stops', { stopConditions: ['goal_completed'] }));
  assert.deepEqual(created.directive.stopConditions, ['goal_completed']);
  const mandatory = system.store.constants.MANDATORY_STOP_CONDITIONS;
  for (const name of ['owner_interrupted', 'missing_required_permission', 'budget_exhausted', 'time_exhausted', 'valid_until_passed']) {
    assert.ok(mandatory.includes(name), `${name} 必须在强制停止集里（不能靠 JSON 关掉）`);
  }
});

test('直接手改库把 allowed_tools_json 写成 shell：读取时不会变成"可执行"', async (t) => {
  const { system, brain } = createSystem(t);
  const id = (await system.create(input('tamper', { permissionScope: 'L3' }))).id;
  execRaw(brain.db, "UPDATE directives SET allowed_tools_json = '[\"shell\"]', status = 'queued' WHERE id = ?", [id]);
  const directive = system.get(id);
  assert.deepEqual(directive.allowedTools, ['shell'], '读回来仍是原样（不做静默清洗，但要判定不可执行）');
  // 条件层面它排得上（等级 L3 <= L3、没有过期），
  // 但权限层面永远跑不动：白名单判定发生在执行前。
  const picked = system.nextEligible({ limit: 10, maxLevel: 'L3' });
  assert.ok(picked.items.some((item) => item.id === id), '条件上是 eligible 的');
  for (const tool of directive.allowedTools) {
    const verdict = canExecute({ level: 'L3', action: tool, allowedTools: directive.allowedTools });
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.reason, 'action_not_in_whitelist');
  }
});
