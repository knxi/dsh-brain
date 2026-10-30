// @ts-check
/**
 * 系统 4 · 回复 / 沉默五态仲裁（`response.js`）。
 *
 * 验收清单：
 *  1. 五态都能落到 `response_decisions`（reply / brief_reply / delay / decline / silent）
 *  2. **保护类输入禁止 silent**：六种保护类全部强制改 reply，并写 `reason_category`
 *  3. `strict:true` 时直接抛 `PROTECTED_SILENT_FORBIDDEN`，且不写行
 *  4. 默认安全性：能从文本/标志里嗅出保护类（只收紧，不放宽）
 *  5. 沉默也留痕（不伪造「已读」）；`listDecisions({days})` 与控制台口径一致
 *  6. 开关全关时照样留痕，但绝不写任何 `social_*` 表
 *  7. 跨 scope 隔离
 */

import test from 'node:test';
import {
  SCOPE_B,
  allRows,
  assert,
  countRows,
  createRig,
  getRow,
} from './helpers.mjs';

/** 六种保护类都要测到（缺一个就等于漏一种「装没听见」）。 */
const PROTECTED = ['formal_task', 'correction', 'forget', 'permission', 'stop', 'commitment'];

test('五态：owner_message 默认 reply，system_event / maintenance 可以沉默', async (t) => {
  const rig = createRig(t);
  const reply = await rig.persona.response.decide({
    personId: rig.personId,
    sessionId: 'sess-1',
    inputKind: 'owner_message',
    context: {},
  });
  assert.equal(reply.decision, 'reply');
  assert.equal(reply.reasonCategory, 'answered');

  const brief = await rig.persona.response.decide({ personId: rig.personId, inputKind: 'owner_message', context: { brief: true } });
  assert.equal(brief.decision, 'brief_reply');
  assert.equal(brief.reasonCategory, 'brief_by_style');

  const sys = await rig.persona.response.decide({ personId: rig.personId, inputKind: 'system_event', context: {} });
  assert.equal(sys.decision, 'silent');
  assert.equal(sys.protectedKind, null);

  const maintenance = await rig.persona.response.decide({ personId: rig.personId, inputKind: 'maintenance', context: {} });
  assert.equal(maintenance.decision, 'silent');

  assert.equal(countRows(rig.brain.db, 'response_decisions'), 4, '沉默也是一条决策，必须留痕');
});

test('social_input：忙 → delay，最近被拒 → decline，否则 brief_reply', async (t) => {
  const rig = createRig(t);
  const delayed = await rig.persona.response.decide({
    personId: rig.personId,
    inputKind: 'social_input',
    context: { busy: true },
  });
  assert.equal(delayed.decision, 'delay');
  assert.equal(delayed.reasonCategory, 'busy_or_quiet_hours');

  const declined = await rig.persona.response.decide({
    personId: rig.personId,
    inputKind: 'social_input',
    context: { declinedRecently: true },
  });
  assert.equal(declined.decision, 'decline');

  const ack = await rig.persona.response.decide({ personId: rig.personId, inputKind: 'social_input', context: {} });
  assert.equal(ack.decision, 'brief_reply');
  assert.equal(ack.reasonCategory, 'social_short_ack');
});

test('保护类六种：判 silent 一律强制改 reply，落库的必须是 reply', async (t) => {
  const rig = createRig(t);
  for (const kind of PROTECTED) {
    const decided = await rig.persona.response.decide({
      personId: rig.personId,
      inputKind: 'owner_message',
      protectedKind: kind,
      decision: 'silent', // 调用方硬要沉默，也必须被拦住
      context: {},
    });
    assert.equal(decided.decision, 'reply', `${kind}：保护类输入不许沉默`);
    assert.equal(decided.forced, true);
    assert.equal(decided.reasonCategory, 'protected_input_forced_reply');
    assert.equal(decided.protectedKind, kind);

    const row = getRow(rig.brain.db, 'SELECT * FROM response_decisions WHERE id = ?', [decided.id]);
    assert.equal(row.decision, 'reply', `${kind}：库里的决策也必须是 reply`);
    assert.equal(row.protected_kind, kind);
    const notes = JSON.parse(String(row.notes));
    assert.equal(notes.originalDecision, 'silent', '原始判定要留痕（不然没法查「谁想沉默」）');
  }
  const silentRows = allRows(rig.brain.db, "SELECT * FROM response_decisions WHERE decision = 'silent' AND protected_kind IS NOT NULL");
  assert.equal(silentRows.length, 0, '库里一条「保护类被沉默」都不许有');

  const stats = rig.persona.response.stats({ days: 7 });
  assert.equal(stats.protectedSilent, 0);
  assert.equal(stats.byDecision.reply, PROTECTED.length);
});

test('strict：保护类被判定 silent 时直接抛 PROTECTED_SILENT_FORBIDDEN，不写行', async (t) => {
  const rig = createRig(t);
  await assert.rejects(
    () =>
      rig.persona.response.decide({
        personId: rig.personId,
        inputKind: 'owner_message',
        protectedKind: 'formal_task',
        decision: 'silent',
        strict: true,
        context: {},
      }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.equal(err.details.code, 'PROTECTED_SILENT_FORBIDDEN');
      return true;
    },
  );
  assert.equal(countRows(rig.brain.db, 'response_decisions'), 0, '抛错就不该留半条记录');

  // 工厂级 strict 也一样
  const strictRig = createRig(t, { strictProtected: true });
  await assert.rejects(
    () =>
      strictRig.persona.response.decide({
        personId: strictRig.personId,
        inputKind: 'owner_message',
        protectedKind: 'stop',
        decision: 'silent',
        context: {},
      }),
    (err) => err.details?.code === 'PROTECTED_SILENT_FORBIDDEN',
  );
});

test('保护类只对 owner_message 成立：其它输入带 protectedKind 一律拒', async (t) => {
  const rig = createRig(t);
  await assert.rejects(
    () =>
      rig.persona.response.decide({
        personId: rig.personId,
        inputKind: 'social_input',
        protectedKind: 'formal_task',
        decision: 'silent',
        context: {},
      }),
    (err) => err.code === 'INVALID_ARGUMENT' && /只对 owner_message/.test(err.message),
    '保护类是「主人的话」的属性，不能挂在系统噪音上',
  );
});

test('inferProtectedKind：从 flags / 文本嗅探（只收紧，不放宽）', async (t) => {
  const rig = createRig(t);
  const byFlag = await rig.persona.response.decide({
    personId: rig.personId,
    inputKind: 'owner_message',
    decision: 'silent',
    context: { flags: ['forget'] },
  });
  assert.equal(byFlag.protectedKind, 'forget');
  assert.equal(byFlag.decision, 'reply', '嗅出来就不许沉默');

  const byText = await rig.persona.response.decide({
    personId: rig.personId,
    inputKind: 'owner_message',
    decision: 'silent',
    context: { text: '帮我整理一下这份报告的格式' },
  });
  assert.equal(byText.protectedKind, 'formal_task');
  assert.equal(byText.decision, 'reply');

  const notProtected = await rig.persona.response.decide({
    personId: rig.personId,
    inputKind: 'owner_message',
    decision: 'silent',
    context: { text: '嗯' },
  });
  assert.equal(notProtected.protectedKind, null);
  assert.equal(notProtected.decision, 'silent', '嗅不出保护类时才允许沉默');

  const stopText = await rig.persona.response.decide({
    personId: rig.personId,
    inputKind: 'owner_message',
    decision: 'silent',
    context: { text: '停下，别再做了' },
  });
  assert.equal(stopText.protectedKind, 'stop');
  assert.equal(stopText.decision, 'reply');
});

test('listDecisions / stats：按本地自然日回溯过滤', async (t) => {
  const rig = createRig(t);
  await rig.persona.response.decide({ personId: rig.personId, inputKind: 'owner_message', context: {} });
  rig.fc.advance(3 * 24 * 3600_000);
  await rig.persona.response.decide({ personId: rig.personId, inputKind: 'maintenance', context: {} });

  const recent = rig.persona.response.listDecisions({ days: 1 });
  assert.equal(recent.items.length, 1, 'days=1 只看到最近这条');
  assert.equal(recent.items[0].decision, 'silent');
  const week = rig.persona.response.listDecisions({ days: 7 });
  assert.equal(week.items.length, 2);
  assert.deepEqual(week.items.map((item) => item.decision), ['silent', 'reply'], '新→旧');
  assert.equal(rig.persona.response.listDecisions({ days: 7, decision: 'reply' }).items.length, 1);

  const stats = rig.persona.response.stats({ days: 7 });
  assert.equal(stats.total, 2);
  assert.equal(stats.byDecision.reply, 1);
  assert.equal(stats.byDecision.silent, 1);
  assert.equal(stats.protectedSilent, 0);
});

test('开关全关：响应决策照样留痕，但绝不写 social_* 表', async (t) => {
  const rig = createRig(t); // 三个开关默认全关
  assert.equal(rig.persona.gate().canWrite, false);
  await rig.persona.response.decide({
    personId: rig.personId,
    inputKind: 'owner_message',
    protectedKind: 'permission',
    context: {},
  });
  assert.equal(countRows(rig.brain.db, 'response_decisions'), 1, '回复决策不是外发动作，必须留痕');
  assert.equal(countRows(rig.brain.db, 'social_candidates'), 0);
  assert.equal(countRows(rig.brain.db, 'social_sends'), 0);
});

test('跨 scope：另一个 scope 看不到别人的决策记录', async (t) => {
  const rig = createRig(t);
  await rig.persona.response.decide({ personId: rig.personId, inputKind: 'owner_message', context: {} });

  const { createPersona } = await import('../../packages/persona/src/index.js');
  const personaB = createPersona({
    db: rig.brain.db,
    queue: rig.brain.queue,
    clock: rig.brain.clock,
    workspace: null,
    bindings: { scope_id: SCOPE_B, person_id: 'owner' },
  });
  assert.deepEqual(personaB.response.listDecisions({ days: 7 }).items, []);
  assert.equal(personaB.response.stats({ days: 7 }).total, 0);
});

test('决策记录里带 policy_version（事后能回答「按哪版策略判的」）', async (t) => {
  const rig = createRig(t);
  await rig.persona.persons.ensurePerson({ personId: rig.personId });
  await rig.persona.persons.updatePolicy({ personId: rig.personId, dailyCap: 1 }); // policy_version → 2
  const decided = await rig.persona.response.decide({
    personId: rig.personId,
    inputKind: 'social_input',
    context: {},
  });
  assert.equal(decided.policyVersion, 2);
  const row = getRow(rig.brain.db, 'SELECT policy_version FROM response_decisions WHERE id = ?', [decided.id]);
  assert.equal(Number(row.policy_version), 2);
});
