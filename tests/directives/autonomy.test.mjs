// @ts-check
/**
 * 内部候选 → 指令。
 *
 * 这一组盯的是"自主不要自己给自己授权"：
 * 开关关着一律不转、转出来一律 L1、一律 awaiting_approval（必须人批）。
 */

import test from 'node:test';
import { assert, countRows, createSystem, readRows, SCOPE } from './helpers.mjs';
import { INTERNAL_MAX_LEVEL } from '../../packages/directives/src/index.js';

/**
 * 造一条候选（结构照 workspace 的 ws_candidates 门面输出）。
 * @param {Record<string, any>} [extra]
 */
function candidate(extra = {}) {
  return {
    id: 'cand_1',
    scopeId: SCOPE,
    kind: 'directive',
    originModule: 'dmn',
    title: '整理一下最近的记忆索引',
    payload: { action: 'index_rebuild', reason: '索引落后' },
    priority: 60,
    score: 70,
    status: 'proposed',
    expiresAt: '2026-12-31T00:00:00.000Z',
    ...extra,
  };
}

/** 打开自主开关的 workspace 选项。 */
function enabled(extra = {}) {
  return { switches: { 'autonomy.enabled': '1', 'autonomy.max_level': 'L1', ...extra } };
}

test('autonomy.enabled=0：一条都不转，且零写入', async (t) => {
  const { system, brain } = createSystem(t, {
    workspaceOptions: { switches: { 'autonomy.enabled': '0' }, candidates: [candidate(), candidate({ id: 'cand_2' })] },
  });
  const before = {
    directives: countRows(brain.db, 'directives'),
    audits: countRows(brain.db, 'audit_logs'),
  };
  const result = await system.autonomy.drainCandidates({ limit: 10 });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'autonomy_disabled');
  assert.equal(result.drained, 0);
  assert.deepEqual(
    { directives: countRows(brain.db, 'directives'), audits: countRows(brain.db, 'audit_logs') },
    before,
    '开关关着必须零写入',
  );
});

test('全局暂停时也不转（连候选都不读）', async (t) => {
  const { system, brain, workspace } = createSystem(t, {
    workspaceOptions: { ...enabled({ paused: '1' }), candidates: [candidate()] },
  });
  const result = await system.autonomy.drainCandidates();
  assert.equal(result.reason, 'global_paused');
  assert.equal(countRows(brain.db, 'directives'), 0);
  assert.equal(workspace.readCalls.listCandidates, 0, '暂停时连候选列表都不该去读');
});

test('正常转：source=internal、permission_scope=L1、状态=awaiting_approval（必须人批）', async (t) => {
  const { system, brain } = createSystem(t, {
    workspaceOptions: { ...enabled(), candidates: [candidate()] },
  });
  const result = await system.autonomy.drainCandidates({ limit: 10 });
  assert.equal(result.ok, true);
  assert.equal(result.created, 1);
  assert.equal(result.drained, 1);

  const directive = system.list().items[0];
  assert.equal(directive.source, 'internal');
  assert.equal(directive.permissionScope, 'L1', '内部指令的等级硬上限就是 L1');
  assert.equal(directive.status, 'awaiting_approval', '内部生成的指令必须人批，绝不自动 queued');
  assert.deepEqual(directive.allowedTools, ['index_rebuild']);
  assert.equal(directive.idempotencyKey, 'internal:directive:cand_1');
  assert.equal(directive.trigger, 'idle', '候选没给 trigger 时按 idle');
  assert.ok(directive.validUntil !== null, '候选的 expiresAt 会变成指令的 valid_until');

  // 审计：既有一条"建了指令"，也有一条"从哪个候选来的"
  const drainAudits = readRows(brain.db, 'audit_logs', "action = 'directive.drained_from_candidate'");
  assert.equal(drainAudits.length, 1);
  const detail = JSON.parse(String(drainAudits[0].detail));
  assert.equal(detail.candidate_id, 'cand_1');
  assert.equal(detail.permission_scope, INTERNAL_MAX_LEVEL);
});

test('候选想要 L3：被硬压到 L1（候选不能自己给自己升权）', async (t) => {
  const { system } = createSystem(t, {
    workspaceOptions: {
      ...enabled({ 'autonomy.max_level': 'L3' }),
      candidates: [candidate({ payload: { action: 'memory_maintenance', permissionScope: 'L3', trigger: 'commitment' } })],
    },
  });
  await system.autonomy.drainCandidates();
  const directive = system.list().items[0];
  assert.equal(directive.permissionScope, 'L1', '哪怕 max_level 是 L3，内部指令也只到 L1');
  assert.equal(directive.trigger, 'commitment');
});

test('候选想要 L2 动作（reflection_run）：动作被丢弃，指令不声明任何动作', async (t) => {
  const { system } = createSystem(t, {
    workspaceOptions: {
      ...enabled(),
      candidates: [candidate({ payload: { allowedTools: ['reflection_run', 'shell', 'memory_maintenance'] } })],
    },
  });
  const result = await system.autonomy.drainCandidates();
  const entry = result.directives[0];
  assert.deepEqual(entry.allowedTools, ['memory_maintenance'], '只留下 L1 白名单动作');
  assert.deepEqual([...entry.droppedTools].sort(), ['reflection_run', 'shell'], 'L2 动作与白名单外动作都丢弃');
  const directive = system.list().items[0];
  assert.deepEqual(directive.allowedTools, ['memory_maintenance']);
});

test('预算按内部小额度封顶（不信任候选给的数）', async (t) => {
  const { system } = createSystem(t, {
    workspaceOptions: {
      ...enabled(),
      candidates: [candidate({ payload: { action: 'memory_maintenance', budgets: { stepBudget: 999, tokenBudget: 999999, timeBudgetSeconds: 99999 } } })],
    },
  });
  await system.autonomy.drainCandidates();
  const directive = system.list().items[0];
  assert.deepEqual(directive.budgets, { step: 5, timeSeconds: 120, token: 5000 }, '内部预算上限 5 步 / 120 秒 / 5000 token');
});

test('幂等：同一个候选转两次只有一条指令（幂等键 candidate:id）', async (t) => {
  const { system, brain } = createSystem(t, {
    workspaceOptions: { ...enabled(), candidates: [candidate()] },
  });
  const first = await system.autonomy.drainCandidates();
  assert.equal(first.created, 1);
  const second = await system.autonomy.drainCandidates();
  assert.equal(second.created, 0);
  assert.equal(second.reused, 1);
  assert.equal(countRows(brain.db, 'directives'), 1, '重复 drain 不许造第二条');
});

test('标题空的候选跳过；跨 scope 的候选不转', async (t) => {
  const { system, brain } = createSystem(t, {
    workspaceOptions: {
      ...enabled(),
      candidates: [
        candidate({ id: 'cand_empty', title: '   ' }),
        candidate({ id: 'cand_other', scopeId: 'someone-else' }),
        candidate({ id: 'cand_ok' }),
      ],
    },
  });
  const result = await system.autonomy.drainCandidates();
  assert.equal(result.created, 1);
  const reasons = Object.fromEntries(result.directives.map((entry) => [entry.candidateId, entry.skipped ?? 'drained']));
  assert.equal(reasons.cand_empty, 'candidate_title_missing');
  assert.equal(reasons.cand_other, 'cross_scope');
  assert.equal(reasons.cand_ok, 'drained');
  assert.equal(countRows(brain.db, 'directives'), 1);
});

test('转出来的指令不会自动排队：runOnce 也跑不动它（还是 awaiting_approval）', async (t) => {
  const { system, brain } = createSystem(t, {
    workspaceOptions: { ...enabled(), candidates: [candidate()] },
  });
  await system.autonomy.drainCandidates();
  const id = system.list().items[0].id;

  const result = await system.scheduler.runOnce({ owner: 't1' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'queue_empty', 'awaiting_approval 不参与排队');
  assert.equal(system.get(id).status, 'awaiting_approval');
  assert.equal(countRows(brain.db, 'directive_runs'), 0);

  // 人批之后才进队列
  await system.approve(id, { by: 'owner' });
  assert.equal(system.get(id).status, 'queued');
});

test('previewCandidates：零写入，并说清会转成什么', async (t) => {
  const { system, brain } = createSystem(t, {
    workspaceOptions: {
      ...enabled(),
      candidates: [candidate(), candidate({ id: 'cand_l2', title: '反思一下', payload: { action: 'reflection_run' } })],
    },
  });
  const before = countRows(brain.db, 'directives');
  const preview = system.autonomy.previewCandidates({ limit: 10 });
  assert.equal(preview.zeroWrite, true);
  assert.equal(preview.candidates, 2);
  assert.equal(preview.convertible.length, 2);
  assert.equal(preview.convertible[0].statusAfterDrain, 'awaiting_approval');
  assert.equal(preview.convertible[0].permissionScope, 'L1');
  assert.deepEqual(preview.convertible[1].allowedTools, [], 'L2 动作不给，留下空集合（失败关）');
  assert.ok(preview.convertible[1].droppedTools.includes('reflection_run'));
  assert.equal(countRows(brain.db, 'directives'), before, '预览绝不能写库');
});

test('没有注入 workspace：不转、不抛，明确说原因', async (t) => {
  const { brain, fc } = createSystem(t);
  const { createDirectives } = await import('../../packages/directives/src/index.js');
  const system = createDirectives({
    db: brain.db,
    queue: brain.queue,
    clock: fc.clock,
    bindings: { scope_id: SCOPE },
    hooks: {},
  });
  const result = await system.autonomy.drainCandidates();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'workspace_missing');
  assert.equal(result.drained, 0);
});
