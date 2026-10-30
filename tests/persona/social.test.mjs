// @ts-check
/**
 * 系统 4 · 主动社交（`social.js`）。
 *
 * 验收清单（每条都是一句需求）：
 *  1. 三个开关全关 → **零写入**（候选、发送一条都没有）；`preview` 只读也能回答「本来会说什么」
 *  2. `paused=1` 优先级最高：`social.enabled=1` 也一样零写入
 *  3. 候选四类来源能从真实数据长出来；未实现的三类如实列在 `skipped`
 *  4. `discovery` 没有真实 evidence → **rejected**（不许编造「我查到了」）
 *  5. 评分：白天 + 有依据 = 85 分（手算写死），`score_breakdown` 八项齐全可复算
 *  6. 硬闸：深夜 0–6 点 / 30 分钟内已发 / 精力<25 / 心情<30 → rejected
 *  7. `arbitrate`：策略闸（enabled / 免打扰 / 每日上限 / 冷却 / 待批准上限）
 *  8. `send` 默认 dry_run：只写 dry_run 记录、候选状态不变、不占每日上限
 *  9. 真发（approved）必须 `social.allow_external=1`；没通道 → `no_channel_configured`
 * 10. 每日上限按**本地自然日**统计（跨午夜归零）
 * 11. 过期/取消/跨 scope
 */

import test from 'node:test';
import { careStrengthOf, isResolvedCareText } from '../../packages/persona/src/care.js';
import {
  SCOPE_B,
  allRows,
  assert,
  countRows,
  createRig,
  getRow,
  insertDirective,
  insertMemory,
  insertReflection,
  insertRelationshipEvent,
  insertResultEvent,
  insertSendRow,
  setFoxState,
  setSwitches,
} from './helpers.mjs';

/** 一个「刚查完一件事」的真实发现（discovery 的正规来源）。 */
const DISCOVERY_SIGNALS = {
  discovery: [{ topic: 'fix-index', text: '刚把检索索引重建完了', evidence: ['evt_real_1'], ageHours: 0 }],
};

/**
 * 备好一个「冷启动 + 已开主动社交」的装置。
 * @param {import('node:test').TestContext} t
 * @param {{ startIso?: string, channel?: any }} [opts]
 */
async function readyRig(t, opts = {}) {
  const rig = createRig(t, { startIso: opts.startIso, channel: opts.channel });
  await rig.persona.persons.ensurePerson({ personId: rig.personId, displayName: '主人' });
  setFoxState(rig.brain.db, { mood: 70, energy: 70 });
  return rig;
}

test('开关全关：候选零写入，preview 只读也能说「本来会说什么」', async (t) => {
  const rig = await readyRig(t);
  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });

  assert.equal(generated.persisted, 0, 'social.enabled=0 时一条候选都不许落表');
  assert.equal(generated.blocked, 'social_disabled');
  assert.equal(generated.preview, true);
  assert.equal(countRows(rig.brain.db, 'social_candidates'), 0);
  assert.equal(countRows(rig.brain.db, 'social_sends'), 0);

  const preview = rig.persona.social.preview({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  assert.equal(preview.switches.denied, 'social_disabled');
  assert.equal(preview.switches.wouldBlockRealSend, true);
  assert.equal(preview.fresh.length, 1);
  assert.equal(preview.fresh[0].score, 85, '预演要给出真实分数（手算 85）');
  assert.equal(preview.fresh[0].wouldSend, true, '「如果开着」它本来该说这句');
  assert.equal(countRows(rig.brain.db, 'social_candidates'), 0, 'preview 必须只读');
  assert.equal(countRows(rig.brain.db, 'social_sends'), 0);
});

test('paused=1 优先级最高：social.enabled=1 也零写入', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true, paused: true });

  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  assert.equal(generated.persisted, 0);
  assert.equal(generated.blocked, 'global_paused');
  assert.equal(countRows(rig.brain.db, 'social_candidates'), 0);
});

test('候选落表：discovery 没有真实 evidence 一律 rejected', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });

  const generated = await rig.persona.social.generate({
    personId: rig.personId,
    signals: {
      discovery: [
        { topic: 'with-evidence', text: '刚跑完一遍全量测试', evidence: ['evt_1'], ageHours: 0 },
        { topic: 'no-evidence', text: '我今天好像发现了点什么', evidence: [], ageHours: 0 },
      ],
    },
  });

  assert.equal(generated.persisted, 2);
  assert.equal(generated.rejected, 1);
  const withEvidence = generated.candidates.find((item) => item.topic === 'with-evidence');
  const withoutEvidence = generated.candidates.find((item) => item.topic === 'no-evidence');
  assert.equal(withEvidence.status, 'scored');
  assert.equal(withoutEvidence.status, 'rejected');
  assert.equal(withoutEvidence.reason, 'missing_evidence');
  assert.deepEqual(withoutEvidence.evidence, [], '没有依据就是没有，不许补一个假的');
});

test('四类来源都能从真实数据里长出来；未实现的三类如实列出', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  // schedule：近几天有互动（作息 8–12 点），但今天没互动
  for (let index = 0; index < 6; index += 1) {
    insertRelationshipEvent(rig.brain.db, {
      atMs: Date.parse(`2026-10-${27 + Math.floor(index / 3)}T02:0${index}:00.000Z`),
      kind: 'chat',
    });
  }
  // unfinished_care：昨天提到感冒
  const memoryId = insertMemory(rig.brain.db, {
    content: '主人昨天说感冒了，头有点疼',
    createdAt: '2026-10-29T02:00:00.000Z',
  });
  // commitment：一条未完成承诺 + 一条挂着的事
  const reflectionId = insertReflection(rig.brain.db, { text: '答应把画布插件的文档补齐' });
  const directiveId = insertDirective(rig.brain.db, { title: '整理 M8 迁移的验收报告' });
  // discovery：一条真实结果
  const eventId = insertResultEvent(rig.brain.db, { payload: { summary: '把 0008 迁移回滚演练跑通' } });

  const generated = await rig.persona.social.generate({ personId: rig.personId });
  const sources = new Set(generated.candidates.map((item) => item.source));
  assert.deepEqual([...sources].sort(), ['commitment', 'discovery', 'schedule', 'unfinished_care']);

  const care = generated.candidates.find((item) => item.source === 'unfinished_care');
  assert.deepEqual(care.evidence, [memoryId], 'evidence 只放 id，不放正文');
  assert.match(care.text, /后来怎么样了/);
  const commit = generated.candidates.filter((item) => item.source === 'commitment');
  assert.equal(commit.length, 2);
  assert.ok(commit.some((item) => item.evidence.includes(reflectionId)));
  assert.ok(commit.some((item) => item.evidence.includes(directiveId)));
  const discovery = generated.candidates.find((item) => item.source === 'discovery');
  assert.deepEqual(discovery.evidence, [eventId]);

  const skippedSources = generated.skipped.map((item) => item.source);
  for (const pending of ['shared_memory', 'verification', 'curiosity']) {
    assert.ok(skippedSources.includes(pending), `${pending} 必须如实说「没做」，不许假装有`);
    assert.match(generated.skipped.find((item) => item.source === pending).reason, /not_implemented/);
  }
});

test('schedule：今天已互动就不打招呼；历史太少就跳过', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const notToday = Date.parse('2026-10-29T02:00:00.000Z');
  for (let index = 0; index < 6; index += 1) insertRelationshipEvent(rig.brain.db, { atMs: notToday + index * 60_000 });

  const first = await rig.persona.social.generate({ personId: rig.personId });
  assert.ok(first.candidates.some((item) => item.source === 'schedule'), '作息点到了 + 今天没聊过 → 该打招呼');

  // 再把「今天已经聊过」写进去
  insertRelationshipEvent(rig.brain.db, { atMs: rig.fc.nowMs() - 60_000, kind: 'chat' });
  const second = await rig.persona.social.generate({ personId: rig.personId });
  const skipped = second.skipped.find((item) => item.source === 'schedule');
  assert.ok(skipped, '今天已经聊过 → 不重复打招呼');
  assert.match(skipped.reason, /already_interacted_today/);

  // 全新用户只有 2 条记录 → 不知道作息，不猜
  const fresh = createRig(t);
  await fresh.persona.persons.ensurePerson({ personId: fresh.personId });
  await setSwitches(fresh.workspace, { social: true });
  insertRelationshipEvent(fresh.brain.db, { atMs: Date.parse('2026-10-29T02:00:00.000Z') });
  insertRelationshipEvent(fresh.brain.db, { atMs: Date.parse('2026-10-29T03:00:00.000Z') });
  const third = await fresh.persona.social.generate({ personId: fresh.personId });
  assert.match(third.skipped.find((item) => item.source === 'schedule')?.reason ?? '', /insufficient_history/);
});

test('评分：白天 + 有依据 = 85 分，breakdown 九项齐全且能复算', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  const candidate = generated.candidates[0];

  assert.equal(candidate.score, 85, '手算：50 + 14(相关性) + 12(帮助) + 0(来源质量) − 3(关系) + 12(新鲜) = 85');
  const breakdown = candidate.scoreBreakdown;
  assert.deepEqual(breakdown.components, {
    relevance: 14,
    actualHelp: 12,
    sourceQuality: 0,
    relationshipFit: -3,
    freshness: 12,
    interruptionCost: 0,
    repetitionPenalty: 0,
    busyPenalty: 0,
    resourcePressure: 0,
  });
  assert.equal(breakdown.threshold, 55);
  assert.equal(breakdown.should, true);
  assert.equal(breakdown.gates.length, 7, '七个硬闸都要留痕（开关 / 策略 / 依据 / 深夜 / 太近 / 精力 / 心情）');
  assert.deepEqual(
    breakdown.gates.map((gate) => gate.code),
    ['switches', 'policy_disabled', 'missing_evidence', 'night_hours', 'too_soon', 'low_energy', 'low_mood'],
  );
  assert.ok(breakdown.gates.every((gate) => gate.passed));

  const sum = Object.values(breakdown.components).reduce((acc, value) => acc + Number(value), 0);
  assert.equal(candidate.score, Math.max(0, Math.min(100, Math.round(50 + sum))), '分数必须等于公式结果');
  const row = getRow(rig.brain.db, 'SELECT score_breakdown_json FROM social_candidates WHERE id = ?', [candidate.id]);
  assert.ok(JSON.parse(String(row.score_breakdown_json)).components, 'score_breakdown 必须落库');
});

test('care 信号判定：强 / 弱 / 已收尾三种（纯函数，可对拍）', () => {
  assert.equal(careStrengthOf('主人说这两天感冒了，头有点疼'), 'strong', '身体类 → 强信号');
  assert.equal(careStrengthOf('明天要去医院复查'), 'strong', '具体安排 + 身体 → 强信号');
  assert.equal(careStrengthOf('昨天开会讨论项目排期'), 'weak', '「开会/项目」这类泛词只是弱信号');
  assert.equal(careStrengthOf('是本项目的 Team Lead，需向其汇报'), 'weak', '「汇报」不是 care');
  assert.equal(careStrengthOf('编号 #42 已归档'), null, '一个 care 词都没有 → null');
  assert.equal(isResolvedCareText('备份体检踩到两个坑并已修复'), true, '「已修复」= 已经收尾');
  assert.equal(isResolvedCareText('主人说这两天感冒了'), false);
});

test('unfinished_care 不生成：稳定事实（semantic/profile/boundary/relationship）没有「后来怎么样了」', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  // 这几条都含 care 词或工作词，但类型是稳定事实 —— 一条候选都不许生成
  insertMemory(rig.brain.db, { type: 'semantic', content: '主人最近感冒了，这是长期健康状态' });
  insertMemory(rig.brain.db, { type: 'profile', content: '是本项目的 Team Lead，console2 收尾时需向其汇报。' });
  insertMemory(rig.brain.db, { type: 'boundary', content: '沟通：讨厌反复请示，要结果不要流程汇报' });
  insertMemory(rig.brain.db, { type: 'relationship', content: '跟主人关系：给权限爽快、最烦扭捏' });

  const generated = await rig.persona.social.generate({ personId: rig.personId });
  const careCandidates = generated.candidates.filter((candidate) => candidate.source === 'unfinished_care');
  assert.deepEqual(careCandidates, [], '稳定事实不配问「后来怎么样了」');
  assert.match(generated.skipped.find((item) => item.source === 'unfinished_care').reason, /no_care_evidence/);
});

test('unfinished_care 不生成：正文含「已修复」的线索不问（对方早就收尾了）', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  insertMemory(rig.brain.db, {
    type: 'episode',
    content: '2026-10-21 凌晨备份体检踩到两个坑并已修复，写进交接文档了',
    createdAt: '2026-10-21T18:00:00.000Z',
  });
  insertMemory(rig.brain.db, {
    type: 'episode',
    content: '昨天熬夜修索引，搞定了',
    createdAt: '2026-10-29T02:00:00.000Z',
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId });
  const careCandidates = generated.candidates.filter((candidate) => candidate.source === 'unfinished_care');
  assert.deepEqual(careCandidates, [], '已经收尾的事再问「后来怎么样了」等于没读');
  assert.match(generated.skipped.find((item) => item.source === 'unfinished_care').reason, /no_open_care/);
});

test('unfinished_care 弱信号：候选照常生成，但被 source_quality 硬闸挡掉（不是靠调权重）', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const memoryId = insertMemory(rig.brain.db, {
    type: 'episode',
    content: '昨天开会讨论项目排期，还需要再对一版',
    createdAt: '2026-10-29T02:00:00.000Z',
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId });
  const care = generated.candidates.find((candidate) => candidate.source === 'unfinished_care');
  assert.ok(care, '弱信号也要生成候选（否则 dry-run 的「被挡下的」列表解释不了原因）');
  assert.deepEqual(care.evidence, [memoryId]);
  assert.equal(care.status, 'rejected');
  assert.equal(care.reason, 'source_quality');
  const gate = care.scoreBreakdown.gates.find((entry) => entry.code === 'source_quality');
  assert.equal(gate.passed, false);
  assert.equal(care.scoreBreakdown.inputs.sourceQuality, 'weak');
  assert.equal(care.scoreBreakdown.components.sourceQuality, 0, '弱信号不拿质量分');
});

test('unfinished_care 强信号：episode + 身体关键词 → 生成、拿来源质量分、过门槛', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const memoryId = insertMemory(rig.brain.db, {
    type: 'episode',
    content: '主人说这两天感冒了，头昏，没去上班',
    createdAt: '2026-10-29T02:00:00.000Z',
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId });
  const care = generated.candidates.find((candidate) => candidate.source === 'unfinished_care');
  assert.ok(care);
  assert.equal(care.status, 'scored');
  // 手算：50 + 相关性18(16+evidence2) + 帮助10 + 质量6 − 关系3 + 新鲜6(24h) = 87
  assert.equal(care.score, 87);
  assert.equal(care.scoreBreakdown.components.sourceQuality, 6);
  assert.equal(care.scoreBreakdown.inputs.sourceQuality, 'strong');
  assert.match(care.text, /后来怎么样了/);
  assert.deepEqual(care.evidence, [memoryId]);
});

test('生产库那三条误报（Lead 汇报 / 备份体检 / 沟通偏好）一条 care 候选都不生成', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  // 原样复现主人第一屏里看到的三条正文（类型按主账里的实际语义给）
  insertMemory(rig.brain.db, {
    type: 'relationship',
    content: '是本项目的 Team Lead，console2 收尾时需向其汇报。',
    createdAt: '2026-10-29T02:00:00.000Z',
  });
  insertMemory(rig.brain.db, {
    type: 'episode',
    content: '2026-10-21 凌晨备份体检踩到两个坑并已修复，写进交接文档了',
    createdAt: '2026-10-25T02:00:00.000Z',
  });
  insertMemory(rig.brain.db, {
    type: 'profile',
    content: '沟通：给权限爽快、讨厌扭捏和反复请示，要结果不要流程汇报',
    createdAt: '2026-10-28T02:00:00.000Z',
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId });
  assert.deepEqual(
    generated.candidates.filter((candidate) => candidate.source === 'unfinished_care'),
    [],
    '主人会直接看到的第一屏：宁可 0 条，也不要凑三条傻问题',
  );
  // 其余来源也不该被这三条影响（discovery 没有真实结果就该说没有）
  assert.match(generated.skipped.find((item) => item.source === 'discovery').reason, /no_recent_result/);
});

test('硬闸：深夜 0–6 点 × 精力 <25 × 心情 <30 × 30 分钟内已发过', async (t) => {
  // 深夜（本地 02:00）
  const night = await readyRig(t, { startIso: '2026-10-30T18:00:00.000Z' });
  await setSwitches(night.workspace, { social: true });
  const nightResult = await night.persona.social.generate({ personId: night.personId, signals: DISCOVERY_SIGNALS });
  assert.equal(nightResult.candidates[0].status, 'rejected');
  assert.equal(nightResult.candidates[0].reason, 'night_hours');

  // 精力太低
  const tired = await readyRig(t);
  await setSwitches(tired.workspace, { social: true });
  setFoxState(tired.brain.db, { mood: 70, energy: 12 });
  const tiredResult = await tired.persona.social.generate({ personId: tired.personId, signals: DISCOVERY_SIGNALS });
  assert.equal(tiredResult.candidates[0].status, 'rejected');
  assert.equal(tiredResult.candidates[0].reason, 'low_energy');

  // 心情太差
  const sad = await readyRig(t);
  await setSwitches(sad.workspace, { social: true });
  setFoxState(sad.brain.db, { mood: 10, energy: 70 });
  const sadResult = await sad.persona.social.generate({ personId: sad.personId, signals: DISCOVERY_SIGNALS });
  assert.equal(sadResult.candidates[0].status, 'rejected');
  assert.equal(sadResult.candidates[0].reason, 'low_mood');

  // 30 分钟内已经真发过
  const recent = await readyRig(t, { channel: async () => ({ ok: true, externalId: 'x1' }) });
  await setSwitches(recent.workspace, { social: true, external: true });
  insertSendRow(recent.brain.db, { atMs: recent.fc.nowMs() - 5 * 60_000, topic: 'recent.topic' });
  const recentResult = await recent.persona.social.generate({ personId: recent.personId, signals: DISCOVERY_SIGNALS });
  assert.equal(recentResult.candidates[0].status, 'rejected');
  assert.equal(recentResult.candidates[0].reason, 'too_soon');
});

test('arbitrate：过策略闸才推进到 awaiting_approval，否则 rejected 带原因', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  const candidate = generated.candidates[0];
  assert.equal(candidate.status, 'scored');

  const advanced = await rig.persona.social.arbitrate(candidate.id);
  assert.equal(advanced.advanced, true);
  assert.equal(advanced.status, 'awaiting_approval');
  assert.ok(advanced.gates.every((gate) => gate.passed));
  assert.equal(rig.persona.social.getCandidate(candidate.id).status, 'awaiting_approval');

  // 每日上限 0：另一条候选过不去
  await rig.persona.persons.updatePolicy({ personId: rig.personId, dailyCap: 0 });
  const second = await rig.persona.social.generate({
    personId: rig.personId,
    signals: { discovery: [{ topic: 'another', text: '另一件事也弄完了', evidence: ['evt_2'], ageHours: 0 }] },
  });
  const blocked = await rig.persona.social.arbitrate(second.candidates[0].id);
  assert.equal(blocked.advanced, false);
  assert.equal(blocked.reason, 'daily_cap');
  assert.equal(rig.persona.social.getCandidate(second.candidates[0].id).status, 'rejected');

  // 免打扰时段覆盖现在（10:00）→ quiet_hours
  await rig.persona.persons.updatePolicy({ personId: rig.personId, dailyCap: 5, quietHours: [{ from: '09:00', to: '11:00' }] });
  const third = await rig.persona.social.generate({
    personId: rig.personId,
    signals: { discovery: [{ topic: 'third', text: '第三件事做完了', evidence: ['evt_3'], ageHours: 0 }] },
  });
  const quiet = await rig.persona.social.arbitrate(third.candidates[0].id);
  assert.equal(quiet.reason, 'quiet_hours');

  // 待批准上限 0 → max_pending
  await rig.persona.persons.updatePolicy({ personId: rig.personId, quietHours: [], maxPending: 0 });
  const fourth = await rig.persona.social.generate({
    personId: rig.personId,
    signals: { discovery: [{ topic: 'fourth', text: '第四件事也完了', evidence: ['evt_4'], ageHours: 0 }] },
  });
  const pending = await rig.persona.social.arbitrate(fourth.candidates[0].id);
  assert.equal(pending.reason, 'max_pending');
});

test('arbitrate：开关关着时什么都不写', async (t) => {
  const rig = await readyRig(t);
  // 先在开着的时候造一条 scored 候选
  await setSwitches(rig.workspace, { social: true });
  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  const id = generated.candidates[0].id;
  await setSwitches(rig.workspace, { social: false });

  const result = await rig.persona.social.arbitrate(id);
  assert.equal(result.advanced, false);
  assert.equal(result.reason, 'social_disabled');
  assert.equal(result.written, false);
  assert.equal(rig.persona.social.getCandidate(id).status, 'scored', '暂停时状态不许推进');
});

test('send 默认 dry_run：只写 dry_run 记录，候选状态不变、不占每日上限', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  const id = generated.candidates[0].id;
  await rig.persona.social.arbitrate(id);

  const sent = await rig.persona.social.send(id);
  assert.equal(sent.deliveryMode, 'dry_run');
  assert.equal(sent.ok, true);
  assert.equal(sent.sent, false, 'dry_run 就是没真发');
  assert.equal(sent.reason, 'dry_run_only');
  assert.equal(rig.persona.social.getCandidate(id).status, 'awaiting_approval', 'dry_run 不推进状态');

  const row = getRow(rig.brain.db, 'SELECT * FROM social_sends WHERE id = ?', [sent.sendId]);
  assert.equal(row.delivery_mode, 'dry_run');
  assert.equal(Number(row.ok), 1);
  assert.equal(rig.persona.social.countApprovedToday({ personId: rig.personId }), 0, 'dry_run 不占每日上限');
});

test('send approved：allow_external=0 直接拒，且零写入', async (t) => {
  const rig = await readyRig(t, { channel: async () => ({ ok: true, externalId: 'unused' }) });
  await setSwitches(rig.workspace, { social: true, external: false });
  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  const id = generated.candidates[0].id;
  await rig.persona.social.arbitrate(id);

  const before = countRows(rig.brain.db, 'social_sends');
  const result = await rig.persona.social.send(id, { mode: 'approved' });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'external_disabled');
  assert.equal(countRows(rig.brain.db, 'social_sends'), before, '没允许外发就不许留发送记录');
  assert.equal(rig.persona.social.getCandidate(id).status, 'awaiting_approval');
});

test('send approved + allow_external=1 但没有通道：no_channel_configured（留一条失败账）', async (t) => {
  const rig = await readyRig(t); // 不注入 channel
  await setSwitches(rig.workspace, { social: true, external: true });
  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  const id = generated.candidates[0].id;
  await rig.persona.social.arbitrate(id);

  const result = await rig.persona.social.send(id, { mode: 'approved' });
  assert.equal(result.queued, false);
  assert.equal(result.reason, 'no_channel_configured');
  assert.equal(result.sent, false);
  const row = getRow(rig.brain.db, 'SELECT * FROM social_sends WHERE id = ?', [result.sendId]);
  assert.equal(row.delivery_mode, 'approved');
  assert.equal(Number(row.ok), 0, '尝试过但没发出去，要如实记 ok=0');
  assert.equal(rig.persona.social.getCandidate(id).status, 'awaiting_approval');
});

test('send approved + 通道钩子：sent，候选进 sent，占每日上限', async (t) => {
  const calls = [];
  const rig = await readyRig(t, {
    channel: async (input) => {
      calls.push(input);
      return { ok: true, externalId: 'im_msg_1' };
    },
  });
  await setSwitches(rig.workspace, { social: true, external: true });
  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  const id = generated.candidates[0].id;
  await rig.persona.social.arbitrate(id);

  const result = await rig.persona.social.send(id, { mode: 'approved', channel: 'im' });
  assert.equal(result.sent, true);
  assert.equal(result.queued, true);
  assert.equal(result.externalId, 'im_msg_1');
  assert.equal(calls.length, 1, '通道钩子只调用一次');
  assert.equal(calls[0].channel, 'im');
  assert.match(calls[0].text, /刚把检索索引重建完了/);
  assert.equal(rig.persona.social.getCandidate(id).status, 'sent');
  assert.equal(rig.persona.social.countApprovedToday({ personId: rig.personId }), 1);
});

test('每日上限按本地自然日：跨本地午夜归零', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true, external: true });
  // 本地 2026-10-30 10:00 一条已真发
  insertSendRow(rig.brain.db, { atMs: Date.parse('2026-10-30T02:00:00.000Z') });
  assert.equal(rig.persona.social.countApprovedToday({ personId: rig.personId }), 1);

  // UTC 2026-10-30T16:10Z = 本地 2026-10-31 00:10 → 新的一天
  rig.fc.set('2026-10-30T16:10:00.000Z');
  assert.equal(rig.persona.social.countApprovedToday({ personId: rig.personId }), 0, '每日上限按本地自然日算，不按 UTC 日');
});

test('cooldown / topic_cooldown：策略闸真的读最近真发记录', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const nowMs = rig.fc.nowMs();
  insertSendRow(rig.brain.db, { atMs: nowMs - 30 * 60_000, topic: 'care.topic' });

  const ctx = rig.persona.social.loadContext({ personId: rig.personId, nowMs });
  const cooldown = rig.persona.social.checkPolicyGates(ctx, { topic: 'care.topic' });
  assert.equal(cooldown.passed, false);
  assert.equal(cooldown.reason, 'cooldown', '30 分钟前发过，默认冷却 180 分钟');

  await rig.persona.persons.updatePolicy({ personId: rig.personId, cooldownMinutes: 10, topicCooldowns: { 'care.topic': 1440 } });
  const ctx2 = rig.persona.social.loadContext({ personId: rig.personId, nowMs });
  const topicGate = rig.persona.social.checkPolicyGates(ctx2, { topic: 'care.topic' });
  assert.equal(topicGate.passed, false);
  assert.equal(topicGate.reason, 'topic_cooldown', '同一话题 24 小时内不再提');
});

test('paused 后：arbitrate / send / cancel / expire 全部零写入', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  const id = generated.candidates[0].id;
  await setSwitches(rig.workspace, { paused: true });

  const before = {
    sends: countRows(rig.brain.db, 'social_sends'),
    status: rig.persona.social.getCandidate(id).status,
  };
  const arbitrated = await rig.persona.social.arbitrate(id);
  const sent = await rig.persona.social.send(id);
  const cancelled = await rig.persona.social.cancel(id);
  const expired = await rig.persona.social.expire();
  assert.equal(arbitrated.reason, 'global_paused');
  assert.equal(sent.reason, 'global_paused');
  assert.equal(cancelled.reason, 'global_paused');
  assert.equal(expired.expired, 0);
  assert.equal(countRows(rig.brain.db, 'social_sends'), before.sends);
  assert.equal(rig.persona.social.getCandidate(id).status, before.status);
});

test('expire / cancel：过期与人工取消都只改状态，不删行', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  const id = generated.candidates[0].id;
  // 把有效期改到过去
  rig.brain.db
    .prepare('UPDATE social_candidates SET expires_at = ? WHERE id = ?')
    .run('2026-10-30T01:00:00.000Z', id);
  const expired = await rig.persona.social.expire();
  assert.equal(expired.expired, 1);
  assert.equal(rig.persona.social.getCandidate(id).status, 'expired');

  // 已过期的不能再取消（终态）
  const cancelTerminal = await rig.persona.social.cancel(id);
  assert.equal(cancelTerminal.cancelled, false);
  assert.equal(cancelTerminal.reason, 'invalid_status');

  const second = await rig.persona.social.generate({
    personId: rig.personId,
    signals: { discovery: [{ topic: 'cancel-me', text: '要取消的事', evidence: ['evt_9'], ageHours: 0 }] },
  });
  const cancelled = await rig.persona.social.cancel(second.candidates[0].id, { reason: '主人说不用了' });
  assert.equal(cancelled.cancelled, true);
  const row = getRow(rig.brain.db, 'SELECT * FROM social_candidates WHERE id = ?', [second.candidates[0].id]);
  assert.equal(row.status, 'cancelled');
  assert.equal(row.reason, '主人说不用了', '取消原因要留痕');
  assert.equal(countRows(rig.brain.db, 'social_candidates'), 2, '软状态，不真删行');
});

test('preview 只读：跑完前后业务表行数一模一样', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const before = {
    candidates: countRows(rig.brain.db, 'social_candidates'),
    sends: countRows(rig.brain.db, 'social_sends'),
    events: countRows(rig.brain.db, 'relationship_events'),
  };
  const preview = rig.persona.social.preview({
    personId: rig.personId,
    signals: {
      discovery: [{ topic: 'preview-only', text: '只是一次预演', evidence: ['evt_p'], ageHours: 0 }],
      unfinished_care: [{ topic: 'care-preview', text: '上次你说累了，后来呢？', evidence: ['mem_p'], ageHours: 5 }],
    },
  });
  assert.equal(preview.fresh.length, 2);
  assert.ok(preview.wouldSay.length >= 1);
  assert.equal(countRows(rig.brain.db, 'social_candidates'), before.candidates);
  assert.equal(countRows(rig.brain.db, 'social_sends'), before.sends);
  assert.equal(countRows(rig.brain.db, 'relationship_events'), before.events);
});

test('跨 scope：候选互不可见，send 别人的候选直接 NOT_FOUND', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const generated = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  const id = generated.candidates[0].id;

  const { createPersona } = await import('../../packages/persona/src/index.js');
  const personaB = createPersona({
    db: rig.brain.db,
    queue: rig.brain.queue,
    clock: rig.brain.clock,
    workspace: rig.workspace,
    bindings: { scope_id: SCOPE_B, person_id: 'owner' },
  });
  assert.equal(personaB.social.getCandidate(id), null);
  assert.deepEqual(personaB.social.listCandidates({}).items, []);
  await assert.rejects(
    () => personaB.social.send(id),
    (err) => err.code === 'NOT_FOUND',
    '跨 scope 发送必须失败，不许替别人发消息',
  );
  assert.equal(allRows(rig.brain.db, 'SELECT * FROM social_sends WHERE candidate_id = ?', [id]).length, 0);
});

test('signals 注入优先于库内提取（宿主可以喂现成依据）', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  // 库里也有一条记忆线索——但注入了 signals，就不该从库里再猜一遍
  insertMemory(rig.brain.db, { content: '主人说最近老是加班，很累', createdAt: '2026-10-29T02:00:00.000Z' });
  const generated = await rig.persona.social.generate({
    personId: rig.personId,
    signals: { unfinished_care: [{ topic: 'care:manual', text: '上次你说加班到很晚，缓过来没？', evidence: ['mem_manual'], ageHours: 3 }] },
  });
  assert.equal(generated.candidates.length, 1);
  assert.equal(generated.candidates[0].topic, 'care:manual');
  assert.deepEqual(generated.candidates[0].evidence, ['mem_manual']);
});

test('score(candidate) 可独立调用：不传上下文就现读一次，开关照旧算进硬闸', async (t) => {
  const rig = await readyRig(t);
  const standalone = rig.persona.social.score({
    source: 'discovery',
    evidence: ['evt_standalone'],
    ageHours: 0,
    personId: rig.personId,
  });
  assert.equal(standalone.score, 85, '公式与上下文来源无关，分数还是 85');
  assert.equal(standalone.should, false, '开关关着就不该「该发」——独立调用不假设「开着」');
  const switchGate = standalone.breakdown.gates.find((gate) => gate.code === 'switches');
  assert.equal(switchGate.passed, false);
  assert.equal(standalone.breakdown.gates.find((gate) => gate.code === 'night_hours').passed, true);
});

test('候选幂等：同来源同话题同一天不重复提', async (t) => {
  const rig = await readyRig(t);
  await setSwitches(rig.workspace, { social: true });
  const first = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  const second = await rig.persona.social.generate({ personId: rig.personId, signals: DISCOVERY_SIGNALS });
  assert.equal(first.persisted, 1);
  assert.equal(second.persisted, 0);
  assert.equal(second.duplicates, 1);
  assert.equal(countRows(rig.brain.db, 'social_candidates'), 1, '同一天同一话题只提一次');
});
