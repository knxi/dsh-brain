// @ts-check
/**
 * 指令状态机。
 *
 * 验收口径：**不在表里的边一律拒**，且每一次合法转移都留下一条可读的审计。
 */

import test from 'node:test';
import { assert, countAudit, createFakeWorkspace, createSystem, readRows, SCOPE, buildSystem, createBrain } from './helpers.mjs';
import {
  STATUSES,
  TERMINAL_STATUSES,
  TRANSITIONS,
  InvalidTransitionError,
  canTransition,
  isTerminal,
} from '../../packages/directives/src/index.js';

/** 建一条 proposed 状态的指令，返回 id。 */
async function seed(system, key = 'k1') {
  const created = await system.create({ title: '测试指令', idempotencyKey: key, createdBy: 'test' });
  return created.id;
}

test('合法转移表就是这 16 条边（写死，改表必须改这条测试）', () => {
  const expected = {
    proposed: ['awaiting_approval', 'queued', 'cancelled'],
    awaiting_approval: ['queued', 'blocked', 'cancelled'],
    queued: ['running', 'cancelled', 'paused'],
    running: ['paused', 'blocked', 'completed', 'failed', 'cancelled'],
    paused: ['queued', 'cancelled'],
    blocked: ['queued', 'awaiting_approval', 'cancelled'],
    completed: [],
    failed: [],
    cancelled: [],
  };
  assert.deepEqual(Object.keys(TRANSITIONS).sort(), Object.keys(expected).sort());
  for (const [from, tos] of Object.entries(expected)) {
    assert.deepEqual([...TRANSITIONS[from]].sort(), [...tos].sort(), `${from} 的出边必须精确匹配`);
  }
  assert.deepEqual([...STATUSES].sort(), Object.keys(expected).sort());
  assert.deepEqual([...TERMINAL_STATUSES], ['completed', 'failed', 'cancelled']);
  for (const status of TERMINAL_STATUSES) {
    assert.equal(isTerminal(status), true);
    assert.deepEqual([...TRANSITIONS[status]], [], `${status} 是终态，出边必须为空`);
  }
});

test('running 没有到 queued 的直边（重试必须先经过 blocked，留审计）', () => {
  assert.equal(canTransition('running', 'queued'), false);
  assert.equal(canTransition('running', 'blocked'), true);
  assert.equal(canTransition('blocked', 'queued'), true);
});

test('非法转移抛 InvalidTransitionError 并带上合法去向清单', async (t) => {
  const { system } = createSystem(t);
  const id = await seed(system);
  let error = null;
  try {
    await system.stateMachine.transition({ id, to: 'completed' });
  } catch (err) {
    error = /** @type {any} */ (err);
  }
  assert.ok(error instanceof InvalidTransitionError);
  assert.equal(error.code, 'INVALID_TRANSITION');
  assert.equal(error.info.from, 'proposed');
  assert.equal(error.info.to, 'completed');
  assert.deepEqual([...error.info.allowed].sort(), ['awaiting_approval', 'cancelled', 'queued']);
});

test('原地转移被拒（否则重复调用会看起来"成功但没变"）', async (t) => {
  const { system } = createSystem(t);
  const id = await seed(system);
  let error = null;
  try {
    await system.stateMachine.transition({ id, to: 'proposed' });
  } catch (err) {
    error = /** @type {any} */ (err);
  }
  assert.ok(error instanceof InvalidTransitionError);
  assert.equal(error.info.reason, 'same_status');
});

test('未知状态名一律拒（不猜它想去哪）', async (t) => {
  const { system } = createSystem(t);
  const id = await seed(system);
  await assert.rejects(
    () => system.stateMachine.transition({ id, to: 'exploded' }),
    (error) => {
      assert.ok(error instanceof InvalidTransitionError);
      return true;
    },
  );
});

test('合法转移落库：status / version / updated_at 都前进，并写一条审计', async (t) => {
  const { system, brain, fc } = createSystem(t);
  const id = await seed(system);
  const before = readRows(brain.db, 'directives', 'id = ?', [id])[0];
  assert.equal(before.status, 'proposed');
  assert.equal(Number(before.version), 1);

  fc.advance(1000);
  const moved = await system.stateMachine.transition({
    id,
    to: 'awaiting_approval',
    reason: '需要人批',
    by: 'owner',
  });
  assert.equal(moved.from, 'proposed');
  assert.equal(moved.to, 'awaiting_approval');

  const after = readRows(brain.db, 'directives', 'id = ?', [id])[0];
  assert.equal(after.status, 'awaiting_approval');
  assert.equal(Number(after.version), 2, 'version 每次转移 +1（乐观并发用）');
  assert.ok(String(after.updated_at) > String(before.updated_at));

  const audits = readRows(brain.db, 'audit_logs', "action = 'directive.transition' AND target_id = ?", [id]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actor, 'owner');
  assert.equal(audits[0].target_kind, 'directive');
  assert.equal(audits[0].scope_id, SCOPE);
  const detail = JSON.parse(String(audits[0].detail));
  assert.deepEqual(detail.to, 'awaiting_approval');
  assert.deepEqual(detail.from, 'proposed');
  assert.equal(detail.reason, '需要人批');
  assert.equal(countAudit(brain.db, 'directive.transition'), 1);
});

test('终态不可再转（要重做请新建指令）', async (t) => {
  const { system } = createSystem(t);
  const id = await seed(system);
  await system.stateMachine.transition({ id, to: 'queued' });
  await system.stateMachine.transition({ id, to: 'running' });
  await system.stateMachine.transition({ id, to: 'completed' });
  await assert.rejects(
    () => system.stateMachine.transition({ id, to: 'cancelled' }),
    (error) => {
      assert.ok(error instanceof InvalidTransitionError);
      assert.equal(/** @type {any} */ (error).info.terminal, true);
      return true;
    },
  );
});

test('history：按时间正序返回 from/to/reason/by', async (t) => {
  const { system, fc } = createSystem(t);
  const id = await seed(system);
  await system.stateMachine.transition({ id, to: 'awaiting_approval', by: 'owner', reason: '提交审批' });
  fc.advance(1000);
  await system.stateMachine.transition({ id, to: 'queued', by: 'owner', reason: '批准' });
  const history = system.stateMachine.history({ id });
  assert.equal(history.length, 2);
  assert.deepEqual(
    history.map((entry) => [entry.from, entry.to]),
    [
      ['proposed', 'awaiting_approval'],
      ['awaiting_approval', 'queued'],
    ],
  );
  assert.deepEqual(history.map((entry) => entry.by), ['owner', 'owner']);
  assert.equal(history[1].reason, '批准');
});

test('不存在的 id / 跨 scope 的 id → 一律 NOT_FOUND（不泄露别的 scope 有没有）', async (t) => {
  const { brain, fc } = createSystem(t);
  const scopeA = buildSystem({ brain, fc, hooks: {}, scopeId: 'scope-a' });
  const scopeB = buildSystem({ brain, fc, hooks: {}, scopeId: 'scope-b' });
  const created = await scopeA.create({ title: 'A 的指令', idempotencyKey: 'a-1' });

  await assert.rejects(
    () => scopeB.stateMachine.transition({ id: created.id, to: 'awaiting_approval' }),
    (error) => {
      assert.equal(/** @type {any} */ (error).code, 'NOT_FOUND');
      return true;
    },
  );
  await assert.rejects(
    () => scopeB.stateMachine.transition({ id: 'dir_missing', to: 'awaiting_approval' }),
    (error) => /** @type {any} */ (error).code === 'NOT_FOUND',
  );
  // A 自己仍然能转
  await scopeA.stateMachine.transition({ id: created.id, to: 'awaiting_approval' });
});

test('事件发布失败不影响转移结果（事件是通知，不是事实来源）', async (t) => {
  const { brain, fc } = createSystem(t);
  const workspace = createFakeWorkspace({ failPublish: true });
  const alerts = [];
  const system = buildSystem({ brain, fc, workspace, hooks: {}, alert: (info) => alerts.push(info) });
  const id = await seed(system);
  const moved = await system.stateMachine.transition({ id, to: 'queued' });
  assert.equal(moved.to, 'queued');
  assert.equal(readRows(brain.db, 'directives', 'id = ?', [id])[0].status, 'queued');
  assert.ok(alerts.some((info) => info.kind === 'directive_publish_failed'), '发布失败要进告警，不能静默');
});

test('非法转移不改变库内容（整事务回滚，不留半条状态）', async (t) => {
  const { system, brain } = createSystem(t);
  const id = await seed(system);
  const before = readRows(brain.db, 'directives', 'id = ?', [id])[0];
  const auditsBefore = countAudit(brain.db, 'directive.transition');
  await assert.rejects(() => system.stateMachine.transition({ id, to: 'completed' }));
  const after = readRows(brain.db, 'directives', 'id = ?', [id])[0];
  assert.equal(after.status, before.status);
  assert.equal(Number(after.version), Number(before.version));
  assert.equal(countAudit(brain.db, 'directive.transition'), auditsBefore, '被拒的转移不许写审计');
});
