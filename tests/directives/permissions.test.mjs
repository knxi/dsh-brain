// @ts-check
/**
 * 权限矩阵（系统 5 的底线）。
 *
 * 这一组测试是**安全验收清单**：每一条都对应一句"什么绝不允许发生"。
 */

import test from 'node:test';
import { assert } from './helpers.mjs';
import {
  ACTION_TABLE,
  DEFAULT_MAX_LEVEL,
  EXECUTABLE_ACTION_NAMES,
  LEVELS,
  LEVEL_ORDER,
  PermissionEscalationError,
  assertAllowedTools,
  assertNoEscalation,
  canExecute,
  classifyAction,
  describePermissionMatrix,
  effectiveLevel,
  levelRank,
  minLevel,
} from '../../packages/directives/src/index.js';

test('等级表：L0~L3 升序，每个等级都写清了"为什么允许这些"', () => {
  assert.deepEqual([...LEVEL_ORDER], ['L0', 'L1', 'L2', 'L3']);
  assert.deepEqual(
    LEVEL_ORDER.map((level) => LEVELS[level].rank),
    [0, 1, 2, 3],
  );
  for (const level of LEVEL_ORDER) {
    assert.ok(LEVELS[level].label.length > 0, `${level} 要有中文名`);
    assert.ok(LEVELS[level].why.length > 20, `${level} 的 why 必须是一句真正的理由，不是占位`);
  }
  assert.equal(DEFAULT_MAX_LEVEL, 'L1', '默认最高等级必须是 L1（契约 §6）');
});

test('内置动作白名单：只有六个，每个都写了等级/回滚/理由', () => {
  assert.deepEqual(
    [...EXECUTABLE_ACTION_NAMES].sort(),
    ['alert_sweep', 'backup_verify', 'index_rebuild', 'memory_maintenance', 'reflection_run', 'skill_rebuild'],
  );
  for (const name of EXECUTABLE_ACTION_NAMES) {
    const entry = ACTION_TABLE[name];
    assert.ok(['L1', 'L2'].includes(entry.minLevel), `${name} 的等级只能是 L1/L2（等级提升不增加动作）`);
    assert.equal(entry.reversible, true, `${name} 必须是可回滚的，否则不许进白名单`);
    assert.ok(entry.rollback.length > 5, `${name} 必须写清怎么回滚`);
    assert.ok(entry.why.length > 10, `${name} 必须写清为什么在这个等级`);
    assert.ok(entry.hook.length > 0, `${name} 必须声明注入的 hook 名`);
  }
});

test('白名单外动作一律拒绝：任意命令执行在这里就没有入口', () => {
  const forbidden = [
    'shell', 'exec', 'spawn', 'run_command', 'bash', 'powershell', 'eval',
    'write_file', 'delete_file', 'rm', 'http_request', 'fetch', 'send_message', 'upload',
    'sudo', 'install', 'set_switch', 'totally_made_up_action',
  ];
  for (const action of forbidden) {
    const verdict = canExecute({ level: 'L3', action });
    assert.equal(verdict.allowed, false, `${action} 在 L3 也不许执行`);
    assert.equal(verdict.reason, 'action_not_in_whitelist', `${action} 的理由必须是 action_not_in_whitelist`);
  }
  // 危险类别只是给"为什么拒"补一句人看得懂的话，不参与放行判断
  assert.equal(classifyAction('shell').hazard, 'arbitrary_command_execution');
  assert.equal(classifyAction('write_file').hazard, 'filesystem_write');
  assert.equal(classifyAction('send_message').hazard, 'external_message');
  assert.equal(classifyAction('shell').known, true);
});

test('等级不足要拦：L1 跑不了 L2 动作，且给出 required', () => {
  const verdict = canExecute({ level: 'L1', action: 'reflection_run' });
  assert.equal(verdict.allowed, false);
  assert.equal(verdict.reason, 'level_too_low');
  assert.equal(verdict.required, 'L2');

  assert.equal(canExecute({ level: 'L2', action: 'reflection_run' }).allowed, true);
  assert.equal(canExecute({ level: 'L1', action: 'memory_maintenance' }).allowed, true);
  // L0 只能回复：没有任何内置动作可执行
  for (const action of EXECUTABLE_ACTION_NAMES) {
    assert.equal(canExecute({ level: 'L0', action }).allowed, false, `L0 不许执行 ${action}`);
  }
});

test('指令没声明的白名单动作也不给跑（声明是第二道门）', () => {
  const declared = ['memory_maintenance'];
  assert.equal(canExecute({ level: 'L1', action: 'memory_maintenance', allowedTools: declared }).allowed, true);
  const undeclared = canExecute({ level: 'L1', action: 'index_rebuild', allowedTools: declared });
  assert.equal(undeclared.allowed, false);
  assert.equal(undeclared.reason, 'action_not_declared_by_directive');
});

test('canExecute 的入参防线：非法等级 / 空动作 / 非数组 allowedTools', () => {
  assert.equal(canExecute({ level: 'L9', action: 'memory_maintenance' }).reason, 'invalid_level');
  assert.equal(canExecute({ level: '', action: 'memory_maintenance' }).reason, 'invalid_level');
  assert.equal(canExecute({ level: 'L1', action: '' }).reason, 'invalid_action');
  assert.equal(canExecute({ level: 'L1', action: 'memory_maintenance', allowedTools: 'memory_maintenance' }).reason, 'invalid_allowed_tools');
});

test('L3 不新增任何动作：能跑的还是 L2 那批（等级不是空白支票）', () => {
  const actionsAtL2 = EXECUTABLE_ACTION_NAMES.filter((name) => canExecute({ level: 'L2', action: name }).allowed);
  const actionsAtL3 = EXECUTABLE_ACTION_NAMES.filter((name) => canExecute({ level: 'L3', action: name }).allowed);
  assert.deepEqual([...actionsAtL3].sort(), [...actionsAtL2].sort(), 'L3 的动作集合必须与 L2 完全相同');
  assert.equal(
    EXECUTABLE_ACTION_NAMES.filter((name) => ACTION_TABLE[name].minLevel === 'L3').length,
    0,
    '白名单里不许出现 L3 专属动作',
  );
});

test('assertAllowedTools：拒绝任意命令、拒绝越级、去重保序', () => {
  const err = /** @type {any} */ (
    assert.throws === undefined
      ? null
      : (() => {
          try {
            assertAllowedTools(['memory_maintenance', 'shell'], { level: 'L3' });
            return null;
          } catch (error) {
            return error;
          }
        })()
  );
  assert.ok(err, '必须抛错');
  assert.equal(err.code, 'INVALID_ARGUMENT');
  assert.equal(err.reason, 'action_not_in_whitelist');
  assert.equal(err.details.action, 'shell');
  assert.equal(err.details.hazard, 'arbitrary_command_execution');

  // 越级：L1 指令声明 L2 动作
  let escalation = null;
  try {
    assertAllowedTools(['reflection_run'], { level: 'L1' });
  } catch (error) {
    escalation = /** @type {any} */ (error);
  }
  assert.ok(escalation);
  assert.equal(escalation.reason, 'action_requires_higher_level');
  assert.equal(escalation.details.required, 'L2');

  // 去重保序：声明顺序就是执行顺序
  assert.deepEqual(
    assertAllowedTools(['index_rebuild', 'memory_maintenance', 'index_rebuild'], { level: 'L1' }),
    ['index_rebuild', 'memory_maintenance'],
  );
  // 不传 / null → 空集合（不是"全允许"）
  assert.deepEqual(assertAllowedTools(undefined, { level: 'L3' }), []);
  assert.deepEqual(assertAllowedTools(null, { level: 'L3' }), []);
});

test('反扩权：子指令等级高于父指令 → PermissionEscalationError', () => {
  assert.throws(
    () => assertNoEscalation({ parent: { permission_scope: 'L1' }, child: { permissionScope: 'L2' } }),
    (error) => {
      assert.ok(error instanceof PermissionEscalationError);
      assert.equal(error.code, 'PERMISSION_ESCALATION');
      assert.equal(/** @type {any} */ (error).info.kind, 'permission_scope');
      return true;
    },
  );
  // 同级 / 更低都允许（子指令可以比父保守）
  assert.deepEqual(assertNoEscalation({ parent: { permission_scope: 'L2' }, child: { permissionScope: 'L2' } }).ok, true);
  assert.deepEqual(assertNoEscalation({ parent: { permission_scope: 'L3' }, child: { permissionScope: 'L0' } }).ok, true);
});

test('反扩权：三项预算任一超出父指令 → 拒（各自 kind 不同）', () => {
  const parent = { permission_scope: 'L2', step_budget: 10, time_budget_seconds: 300, token_budget: 20_000 };
  const cases = [
    ['step_budget', { stepBudget: 11 }, 'step_budget'],
    ['time_budget_seconds', { timeBudgetSeconds: 301 }, 'time_budget'],
    ['token_budget', { tokenBudget: 20_001 }, 'token_budget'],
  ];
  for (const [, child, kind] of cases) {
    assert.throws(
      () => assertNoEscalation({ parent, child: { permissionScope: 'L2', ...child } }),
      (error) => {
        assert.ok(error instanceof PermissionEscalationError, `${kind} 必须抛 PermissionEscalationError`);
        assert.equal(/** @type {any} */ (error).info.kind, kind);
        return true;
      },
      `${kind} 超父必须被拒`,
    );
  }
  // 恰好等于父上限是允许的（"不得超过"）
  assert.equal(
    assertNoEscalation({
      parent,
      child: { permissionScope: 'L2', stepBudget: 10, timeBudgetSeconds: 300, tokenBudget: 20_000 },
    }).ok,
    true,
  );
});

test('反扩权：动作集合不得超出父集合', () => {
  assert.throws(
    () =>
      assertNoEscalation({
        parent: { permission_scope: 'L2', allowed_tools_json: '["memory_maintenance"]' },
        child: { permissionScope: 'L1', allowedTools: ['memory_maintenance', 'index_rebuild'] },
      }),
    (error) => {
      assert.ok(error instanceof PermissionEscalationError);
      assert.equal(/** @type {any} */ (error).info.kind, 'allowed_tools');
      assert.deepEqual(/** @type {any} */ (error).info.extraTools, ['index_rebuild']);
      return true;
    },
  );
});

test('反扩权失败关：父没声明等级/动作，子就不能自己声明', () => {
  assert.throws(
    () => assertNoEscalation({ parent: {}, child: { permissionScope: 'L2' } }),
    (error) => error instanceof PermissionEscalationError,
    '父没写等级 → 不能证明子没扩权 → 拒',
  );
  assert.throws(
    () =>
      assertNoEscalation({
        parent: { permission_scope: 'L1' },
        child: { permissionScope: 'L1', allowedTools: ['memory_maintenance'] },
      }),
    (error) => /** @type {any} */ (error).info.kind === 'allowed_tools',
    '父没声明动作 → 子不许声明动作',
  );
  // 没有父 = 根指令，不需要反扩权（权限来自创建动作本身）
  assert.deepEqual(assertNoEscalation({ parent: null, child: { permissionScope: 'L3' } }), { ok: true, checks: ['root'] });
});

test('等级工具函数：levelRank / minLevel / effectiveLevel 都是失败关', () => {
  assert.equal(levelRank('L0'), 0);
  assert.equal(levelRank('L3'), 3);
  assert.equal(levelRank('l2'), 2, '大小写不敏感');
  assert.equal(levelRank('L9'), -1, '未知等级返回 -1（比较时天然最低）');
  assert.equal(minLevel('L1', 'L3'), 'L1');
  assert.equal(minLevel('L2', 'L2'), 'L2');
  assert.equal(minLevel('L3', 'nope'), 'L0', '任一未知 → L0（失败关）');
  assert.equal(effectiveLevel('L3', 'L1'), 'L1', '开关收紧后，L3 指令的有效等级就是 L1');
  assert.equal(effectiveLevel('L1', 'L3'), 'L1', '指令自身的等级是上限');
});

test('describePermissionMatrix 是可对外展示的纯数据（不含函数）', () => {
  const matrix = describePermissionMatrix();
  assert.equal(matrix.levels.length, 4);
  assert.equal(matrix.actions.length, 6);
  assert.equal(matrix.maxLevelDefault, 'L1');
  for (const action of matrix.actions) {
    assert.ok(action.why.length > 10);
    assert.equal(action.reversible, true);
  }
  // 不夹带函数（UI 要 JSON 序列化）
  assert.doesNotThrow(() => JSON.stringify(matrix));
});
