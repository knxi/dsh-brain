// @ts-check
/**
 * 系统 4 · 关系四维与人物模型（`relationship.js` + `person-model.js`）。
 *
 * 验收清单：
 *  1. 冷启动：`person_models(cold_start=1)` + 四维各 **0.1** + 默认策略（daily_cap=2 等）
 *  2. `ensurePerson` 幂等：重复调用不覆盖已经被推上去的值
 *  3. **新用户不继承任何人的关系值**（A 推到 0.3，B 还是 0.1）
 *  4. `applyEvent`：单次每维上限 **0.08**、每次变化必写 `relationship_events`
 *  5. 冷却：同 kind 10 分钟窗口内累计不超过 **0.12**
 *  6. 幂等：同 `idempotencyKey` 不重复应用
 *  7. `getState` / `updateStyle` / `updatePolicy`
 *  8. 跨 scope：读不到、写不进（NOT_FOUND，不是「写到别人身上」）
 */

import test from 'node:test';
import {
  SCOPE_B,
  assert,
  countRows,
  createRig,
  getRow,
} from './helpers.mjs';

test('ensurePerson：冷启动四维各 0.1、cold_start=1、默认策略保守', async (t) => {
  const rig = createRig(t);
  const ensured = await rig.persona.persons.ensurePerson({ personId: 'owner', displayName: '主人' });

  assert.equal(ensured.created, true);
  assert.equal(ensured.relationship.familiarity, 0.1);
  assert.equal(ensured.relationship.trust, 0.1);
  assert.equal(ensured.relationship.intimacy, 0.1);
  assert.equal(ensured.relationship.rapport, 0.1);
  assert.equal(ensured.person.coldStart, true, '系统按默认建的要标冷启动');
  assert.equal(ensured.policy.enabled, true);
  assert.equal(ensured.policy.dailyCap, 2, '默认一天最多两句');
  assert.equal(ensured.policy.cooldownMinutes, 180);
  assert.equal(ensured.policy.maxPending, 1);
  assert.deepEqual(ensured.policy.quietHours, [{ from: '00:00', to: '07:30' }]);
  assert.deepEqual(ensured.policy.channels, ['console'], '默认只进控制台，不外发');

  const relRow = getRow(rig.brain.db, 'SELECT * FROM relationship_states WHERE scope_id = ? AND person_id = ?', [rig.scopeId, 'owner']);
  assert.equal(Number(relRow.familiarity), 0.1);
  const policyRow = getRow(rig.brain.db, 'SELECT * FROM proactive_policies WHERE scope_id = ? AND person_id = ?', [rig.scopeId, 'owner']);
  assert.equal(Number(policyRow.daily_cap), 2);
});

test('ensurePerson 幂等：重复调用不重置关系值', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: 'owner' });
  await rig.persona.relationships.applyEvent({
    personId: 'owner',
    kind: 'praise',
    deltas: { trust: 0.08 },
    idempotencyKey: 'seed-1',
  });
  const before = rig.persona.relationships.getState({ personId: 'owner' });
  assert.equal(before.trust, 0.18);

  const again = await rig.persona.persons.ensurePerson({ personId: 'owner' });
  assert.equal(again.created, false);
  assert.equal(again.relationship.trust, 0.18, '重复 ensure 不许把关系打回 0.1（那是「重置」不是「确保」）');
  assert.equal(countRows(rig.brain.db, 'person_models'), 1);
  assert.equal(countRows(rig.brain.db, 'relationship_states'), 1);
  assert.equal(countRows(rig.brain.db, 'proactive_policies'), 1);
});

test('新用户不继承任何人的关系值（A 推到 0.4，B 仍然 0.1）', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: 'owner', displayName: '主人' });
  await rig.persona.persons.ensurePerson({ personId: 'someone', displayName: '另一个人' });

  for (let index = 0; index < 4; index += 1) {
    rig.fc.advance(11 * 60_000);
    await rig.persona.relationships.applyEvent({
      personId: 'owner',
      kind: 'deep_talk',
      deltas: { familiarity: 0.08 },
      idempotencyKey: `a-${index}`,
    });
  }
  const a = rig.persona.relationships.getState({ personId: 'owner' });
  const b = rig.persona.relationships.getState({ personId: 'someone' });
  assert.equal(a.familiarity, 0.42);
  assert.equal(b.familiarity, 0.1, '新用户必须从 0.1 起步：关系值不共享、不继承');
  assert.equal(b.trust, 0.1);
});

test('applyEvent：单次每维上限 0.08，实际增量写进 relationship_events', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: 'owner' });

  const result = await rig.persona.relationships.applyEvent({
    personId: 'owner',
    kind: 'praise',
    deltas: { trust: 0.5, rapport: -0.2, intimacy: 0.03 },
    evidenceRef: 'evt:123',
    idempotencyKey: 'k-1',
  });

  assert.equal(result.applied, true);
  assert.deepEqual(result.appliedDeltas, { familiarity: 0, trust: 0.08, intimacy: 0.03, rapport: -0.08 });
  assert.equal(result.clamped.trust.from, 0.5);
  assert.equal(result.clamped.trust.to, 0.08);
  assert.match(result.clamped.trust.why, /单次上限 0.08/);
  assert.equal(result.after.trust, 0.18);
  assert.equal(result.after.rapport, 0.02);

  const eventRow = getRow(rig.brain.db, 'SELECT * FROM relationship_events WHERE id = ?', [result.eventId]);
  assert.equal(Number(eventRow.delta_trust), 0.08, '事件里记的是**实际生效**的增量，不是请求值');
  assert.equal(eventRow.evidence_ref, 'evt:123');
  assert.equal(eventRow.kind, 'praise');

  const stateRow = getRow(rig.brain.db, 'SELECT * FROM relationship_states WHERE scope_id = ? AND person_id = ?', [rig.scopeId, 'owner']);
  assert.equal(Number(stateRow.version), 2, '一次变化 version +1');
  assert.ok(stateRow.last_change_at);
  assert.ok(JSON.parse(String(stateRow.basis_json)).includes('evt:123'));
});

test('冷却：同 kind 10 分钟内累计不超过 0.12，超了就不再推', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: 'owner' });

  const first = await rig.persona.relationships.applyEvent({ personId: 'owner', kind: 'praise', deltas: { trust: 0.08 }, idempotencyKey: 'c-1' });
  const second = await rig.persona.relationships.applyEvent({ personId: 'owner', kind: 'praise', deltas: { trust: 0.08 }, idempotencyKey: 'c-2' });
  const third = await rig.persona.relationships.applyEvent({ personId: 'owner', kind: 'praise', deltas: { trust: 0.08 }, idempotencyKey: 'c-3' });

  assert.equal(first.appliedDeltas.trust, 0.08);
  assert.equal(second.appliedDeltas.trust, 0.04, '窗口内只剩 0.04 的额度');
  assert.equal(third.applied, false);
  assert.equal(third.reason, 'cooldown_exhausted');
  assert.equal(rig.persona.relationships.getState({ personId: 'owner' }).trust, 0.22);
  assert.equal(countRows(rig.brain.db, 'relationship_events'), 2, '没生效就不写事件（没有变化就没有依据）');

  // 不同 kind 不受同 kind 冷却限制
  const other = await rig.persona.relationships.applyEvent({ personId: 'owner', kind: 'repair', deltas: { trust: 0.08 }, idempotencyKey: 'c-4' });
  assert.equal(other.appliedDeltas.trust, 0.08);
  assert.equal(rig.persona.relationships.getState({ personId: 'owner' }).trust, 0.3);

  // 走出 10 分钟窗口后恢复
  rig.fc.advance(11 * 60_000);
  const afterWindow = await rig.persona.relationships.applyEvent({ personId: 'owner', kind: 'praise', deltas: { trust: 0.08 }, idempotencyKey: 'c-5' });
  assert.equal(afterWindow.appliedDeltas.trust, 0.08, '窗口外额度恢复');
});

test('applyEvent 幂等：同 idempotencyKey 不重复应用、不写第二条事件', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: 'owner' });
  const first = await rig.persona.relationships.applyEvent({
    personId: 'owner',
    kind: 'praise',
    deltas: { trust: 0.08 },
    idempotencyKey: 'dup-key',
  });
  const second = await rig.persona.relationships.applyEvent({
    personId: 'owner',
    kind: 'praise',
    deltas: { trust: 0.08 },
    idempotencyKey: 'dup-key',
  });
  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.eventId, first.eventId, '幂等重放返回既有事件 id');
  assert.equal(countRows(rig.brain.db, 'relationship_events'), 1);
  assert.equal(rig.persona.relationships.getState({ personId: 'owner' }).trust, 0.18);
});

test('结果夹在 [0,1]：到顶了就是 no_effect，不是刷成 1.2', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: 'owner' });
  rig.brain.db.prepare('UPDATE relationship_states SET trust = 0.96 WHERE scope_id = ? AND person_id = ?').run(rig.scopeId, 'owner');

  const capped = await rig.persona.relationships.applyEvent({ personId: 'owner', kind: 'praise', deltas: { trust: 0.08 }, idempotencyKey: 'top-1' });
  assert.equal(capped.after.trust, 1);
  assert.equal(capped.appliedDeltas.trust, 0.04, '只补到 1.0 的部分算实际生效');

  const again = await rig.persona.relationships.applyEvent({ personId: 'owner', kind: 'repair', deltas: { trust: 0.08 }, idempotencyKey: 'top-2' });
  assert.equal(again.applied, false);
  assert.equal(again.reason, 'no_effect');
  assert.equal(rig.persona.relationships.getState({ personId: 'owner' }).trust, 1);
});

test('非法输入：未知维度、非有限数、未知 style 键一律拒', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: 'owner' });
  await assert.rejects(
    () => rig.persona.relationships.applyEvent({ personId: 'owner', kind: 'praise', deltas: { 亲密度: 0.1 } }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    () => rig.persona.relationships.applyEvent({ personId: 'owner', kind: 'praise', deltas: { trust: Number.NaN } }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    () => rig.persona.relationships.applyEvent({ personId: 'owner', kind: '', deltas: { trust: 0.01 } }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  await assert.rejects(
    () => rig.persona.persons.updateStyle({ personId: 'owner', style: { 未知键: 1 } }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.equal(countRows(rig.brain.db, 'relationship_events'), 0, '被拒的写入不许落库');
});

test('updateStyle：合并风格、cold_start 置 0、版本 +1', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: 'owner' });
  const before = rig.persona.persons.get({ personId: 'owner' });
  assert.equal(before.coldStart, true);

  const updated = await rig.persona.persons.updateStyle({ personId: 'owner', style: { replyLength: 'short', humor: 0.8 } });
  assert.equal(updated.style.replyLength, 'short');
  assert.equal(updated.style.humor, 0.8);
  assert.equal(updated.style.shareTolerance, 0.3, '没改的字段保持原值（合并而不是覆盖）');
  assert.equal(updated.coldStart, false, '用户显式配置过就不再是冷启动');
  assert.equal(updated.personModelVersion, 2);
});

test('updatePolicy：改上限/免打扰并让 policy_version +1', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: 'owner' });
  const policy = await rig.persona.persons.updatePolicy({
    personId: 'owner',
    dailyCap: 0,
    quietHours: [{ from: '23:00', to: '08:00' }],
    topicCooldowns: { schedule: 60 },
  });
  assert.equal(policy.dailyCap, 0);
  assert.deepEqual(policy.quietHours, [{ from: '23:00', to: '08:00' }]);
  assert.deepEqual(policy.topicCooldowns, { schedule: 60 });
  assert.equal(policy.policyVersion, 2);

  await assert.rejects(
    () => rig.persona.persons.updatePolicy({ personId: 'owner', quietHours: [{ from: '25:00', to: '08:00' }] }),
    (err) => err.code === 'INVALID_ARGUMENT',
    '免打扰时段格式要校验（HH:mm）',
  );
});

test('history / stats：新→旧，给出事件数与最早最新', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: 'owner' });
  await rig.persona.relationships.applyEvent({ personId: 'owner', kind: 'praise', deltas: { trust: 0.02 }, idempotencyKey: 'h-1' });
  rig.fc.advance(60_000);
  await rig.persona.relationships.applyEvent({ personId: 'owner', kind: 'chat', deltas: { familiarity: 0.02 }, idempotencyKey: 'h-2' });

  const history = rig.persona.relationships.history({ personId: 'owner' });
  assert.deepEqual(history.items.map((item) => item.kind), ['chat', 'praise']);
  const stats = rig.persona.relationships.stats({ personId: 'owner' });
  assert.equal(stats.events, 2);
  assert.ok(stats.newestAtMs > stats.oldestAtMs);
  assert.equal(stats.state.trust, 0.12);
});

test('跨 scope：另一个 scope 读不到状态，也写不进去', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: 'owner' });
  const { createPersona } = await import('../../packages/persona/src/index.js');
  const personaB = createPersona({
    db: rig.brain.db,
    queue: rig.brain.queue,
    clock: rig.brain.clock,
    workspace: null,
    bindings: { scope_id: SCOPE_B, person_id: 'owner' },
  });

  assert.equal(personaB.relationships.getState({ personId: 'owner' }), null, '同一个 personId 在别的 scope 不存在');
  assert.equal(personaB.persons.get({ personId: 'owner' }), null);
  await assert.rejects(
    () => personaB.relationships.applyEvent({ personId: 'owner', kind: 'praise', deltas: { trust: 0.02 } }),
    (err) => err.code === 'NOT_FOUND',
    '写别人的关系必须 NOT_FOUND（不是静默改写别人）',
  );
  assert.equal(countRows(rig.brain.db, 'relationship_events'), 0);
});
