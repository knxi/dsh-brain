// @ts-check
/**
 * M8 · 主动社交新增来源：`shared_memory`（共同记忆）/ `verification`（求证）。
 *
 * 每条用例都在回答同一个问题：**这一类是靠什么机器可读的依据产候选的，
 * 没有依据时它会不会硬编一句**。所以每个「有依据」用例都写死要看的内容片段，
 * 每个「没有依据」用例都断言 `skipped` 里那句理由说的是什么——
 * 「为什么没产」必须和「产了什么」一样可验证。
 *
 * `curiosity`（好奇）的用例反过来：它**没有**实现，测试要守住的是
 * 「不许冒充有依据」——就算真塞了 knowledge_gap 反思进去，它也只能如实报缺数据。
 */

import test from 'node:test';
import {
  PERSON_A,
  SCOPE_A,
  assert,
  insertCandidateRow,
  insertEntityRow,
  insertMemoryRow,
  insertReflectionRow,
  insertSourceRefRow,
  readyRig,
} from './helpers.mjs';
import {
  SHARED_MEMORY_MIN_AGE_DAYS,
  SOCIAL_SOURCE_STATE,
  SOCIAL_SOURCES_IMPLEMENTED,
  SOCIAL_SOURCES_PENDING,
  VERIFICATION_MAX_CONFIDENCE,
  concreteAnchorOf,
} from '../../../packages/persona/src/social.js';

/** 固定时钟是 2026-10-30 10:00（本地），「20 天前」= 2026-10-10。 */
const TWENTY_DAYS_AGO = '2026-10-10T02:00:00.000Z';
/** 昨天（1 天前）——所有「太新」的用例都用它。 */
const YESTERDAY = '2026-10-29T02:00:00.000Z';

/** 取某一类这一轮的候选（不产就是空数组）。 */
function candidatesOf(generated, source) {
  return generated.candidates.filter((item) => item.source === source);
}

/** 取某一类这一轮被跳过的理由。 */
function skipReason(generated, source) {
  const hit = generated.skipped.find((item) => item.source === source);
  return hit ? String(hit.reason) : '';
}

// ─────────────────────────── shared_memory ───────────────────────────

test('shared_memory：20 天前、够重要、带数字锚点的记忆 → 产候选且引用真实片段', async (t) => {
  const rig = await readyRig(t);
  const memoryId = insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    importance: 0.9,
    content: '画布插件 dsh-grsai-canvas 的缩略图统一 320×180，留白 12px',
    summary: '画布缩略图统一 320×180，留白 12px',
    createdAt: TWENTY_DAYS_AGO,
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  const hits = candidatesOf(generated, 'shared_memory');
  assert.equal(hits.length, 1, '有依据就必须产，且这一类每天只产 1 条');
  const candidate = hits[0];
  assert.equal(candidate.topic, `shared_memory:${memoryId}`, 'topic 必须能指回那一条记忆');
  assert.deepEqual(candidate.evidence, [memoryId], 'evidence 只放真实 memory id，不放正文');
  assert.match(candidate.text, /320×180/, '正文必须带出记忆里的真实细节，不许写成「我们之前聊过一件事」');
  assert.match(candidate.text, /10月10日/, '日期按本地时区从 created_at 算，不能编');
  assert.match(candidate.text, /还照这个来吗/, '共同记忆的语气是回顾，不是提问式盘问');
  assert.ok(candidate.score > 0);
  // 记忆是 20 天前的，但候选是今天产生的：freshness 不能拿记忆年龄算，
  // 否则 14 天门槛下这一类永远拿 0 分、永远过不了门槛。
  assert.equal(candidate.scoreBreakdown.components.freshness, 12, 'freshness 记的是「今天为什么想起」，不是记忆有多老');
});

test('shared_memory：记忆太新（1 天前）→ 不产，理由说清是「太新」而不是「没做」', async (t) => {
  const rig = await readyRig(t);
  insertMemoryRow(rig.brain.db, {
    type: 'episode',
    importance: 0.9,
    content: '昨天定的：缩略图改成 320×180',
    createdAt: YESTERDAY,
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  assert.equal(candidatesOf(generated, 'shared_memory').length, 0, '刚聊过的事不许当「共同记忆」回顾');
  const reason = skipReason(generated, 'shared_memory');
  assert.match(reason, /no_shared_memory_evidence/);
  assert.match(reason, new RegExp(String(SHARED_MEMORY_MIN_AGE_DAYS)), '理由里要给出具体门槛');
  assert.doesNotMatch(reason, /not_implemented/, '这一类已经实现了，不许再报「没做」');
});

test('shared_memory：够老但没有具体锚点 → 不产（没细节的回顾就是复读）', async (t) => {
  const rig = await readyRig(t);
  insertMemoryRow(rig.brain.db, {
    type: 'episode',
    importance: 0.8,
    content: '那阵子状态还行，事情推得挺顺',
    createdAt: TWENTY_DAYS_AGO,
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  assert.equal(candidatesOf(generated, 'shared_memory').length, 0);
  assert.match(skipReason(generated, 'shared_memory'), /没有具体锚点/);
});

test('shared_memory：正文没数字，但挂着实体 → 实体也算锚点，照样产', async (t) => {
  const rig = await readyRig(t);
  const memoryId = insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    importance: 0.85,
    content: '心海的交互框架只借交互不借素材',
    summary: '心海交互框架只借交互不借素材',
    createdAt: TWENTY_DAYS_AGO,
  });
  insertEntityRow(rig.brain.db, { name: '心海', kind: 'project', memoryIds: [memoryId] });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  const hits = candidatesOf(generated, 'shared_memory');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].evidence, [memoryId]);
  assert.match(hits[0].text, /心海/);
});

test('shared_memory：30 天内回顾过的同一 topic 不再产；今天已开口就整类让位', async (t) => {
  const rig = await readyRig(t);
  const memoryId = insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    importance: 0.9,
    content: '交付口径：报告先给结论，再给 3 条证据',
    createdAt: TWENTY_DAYS_AGO,
  });
  insertCandidateRow(rig.brain.db, { source: 'shared_memory', topic: `shared_memory:${memoryId}` });

  const first = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  assert.equal(candidatesOf(first, 'shared_memory').length, 0, '同一件事 30 天内不重复问');
  assert.match(skipReason(first, 'shared_memory'), /已经回顾过/);

  // 把「回顾过这条」的记录换掉：这次同一段记忆是可用的候选，
  // 但今天已经有别的 shared_memory 候选落过表 → 这一类今天就让位。
  rig.brain.db.prepare('DELETE FROM social_candidates WHERE topic = ?').run(`shared_memory:${memoryId}`);
  insertCandidateRow(rig.brain.db, { source: 'shared_memory', topic: 'shared_memory:some-other' });

  const second = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  assert.equal(candidatesOf(second, 'shared_memory').length, 0, '这一类每天最多开口 1 次');
  assert.match(skipReason(second, 'shared_memory'), /already_asked_today/);
});

test('shared_memory：importance 不够、或类型是 profile/skill/boundary → 不进候选池', async (t) => {
  const rig = await readyRig(t);
  insertMemoryRow(rig.brain.db, { type: 'semantic', importance: 0.5, content: '缩略图 320×180', createdAt: TWENTY_DAYS_AGO });
  insertMemoryRow(rig.brain.db, { type: 'profile', importance: 0.95, content: '称呼用「主人」，尺寸表在 3 号文件夹', createdAt: TWENTY_DAYS_AGO });
  insertMemoryRow(rig.brain.db, { type: 'skill', importance: 0.95, content: '备份脚本每次保留 3 份', createdAt: TWENTY_DAYS_AGO });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  assert.equal(candidatesOf(generated, 'shared_memory').length, 0, '稳定事实（profile/skill）不该被当共同经历回顾');
  assert.match(skipReason(generated, 'shared_memory'), /importance ≥ 0\.6/);
});

test('shared_memory：时间轴用 valid_from（事件时间），不是 created_at（导入时间）', async (t) => {
  const rig = await readyRig(t);
  // 迁移进来的记忆就是这个形状：两条都是「2 天前导入」，但一条真实发生在 20 天前。
  // 如果按 created_at 判年龄，两条都会被当成「刚聊过」而全部丢掉。
  const oldEvent = insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    importance: 0.9,
    content: '画布插件的缩略图统一 320×180，留白 12px',
    createdAt: YESTERDAY,
    validFrom: TWENTY_DAYS_AGO,
  });
  insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    importance: 0.9,
    content: '扩图尺寸 1:1 起拖，最大 3:2',
    createdAt: YESTERDAY,
    validFrom: '2026-10-29T02:00:00.000Z',
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  const hits = candidatesOf(generated, 'shared_memory');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].evidence, [oldEvent], '只有「真实发生在 7 天前」的那条能被回顾');
  assert.match(hits[0].text, /10月10日/, '日期要按事件时间渲染，不能显示成导入那天');
  assert.doesNotMatch(hits[0].text, /10月29日/);
});

test('shared_memory：刚被检索命中过的记忆不回顾（recall_count > 0）', async (t) => {
  const rig = await readyRig(t);
  insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    importance: 0.9,
    content: '画布缩略图统一 320×180',
    createdAt: TWENTY_DAYS_AGO,
    recallCount: 3,
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  assert.equal(candidatesOf(generated, 'shared_memory').length, 0, '已经被翻出来用过的记忆，对方刚在上面聊过');
  const reason = skipReason(generated, 'shared_memory');
  assert.match(reason, /no_shared_memory_evidence/);
  assert.match(reason, /从没被检索命中过/, '理由要点明 recall_count 这个判据，方便日后核对');
});

// ─────────────────────────── verification ───────────────────────────

test('verification：observation + 置信度 0.8 → 产「现在还准吗」的候选', async (t) => {
  const rig = await readyRig(t);
  const memoryId = insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    sourceType: 'observation',
    confidence: 0.8,
    importance: 0.7,
    content: '心海 3D 星图视觉来自 3d-memory-sea（MIT）',
    summary: '心海 3D 星图视觉来自 3d-memory-sea（MIT）',
    createdAt: '2026-10-29T10:00:00.000Z',
  });
  insertSourceRefRow(rig.brain.db, { memoryId });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  const hits = candidatesOf(generated, 'verification');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].topic, `verification:${memoryId}`);
  assert.deepEqual(hits[0].evidence, [memoryId]);
  assert.match(hits[0].text, /3d-memory-sea/);
  assert.match(hits[0].text, /0\.80/, '要把「我有多确定」摊开给对方看，不能装成确定的事');
  assert.match(hits[0].text, /现在还准吗/);
});

test('verification：主人亲口说的话（owner_words）不进池——他自己说的不用我核', async (t) => {
  const rig = await readyRig(t);
  insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    sourceType: 'owner_words',
    confidence: 0.7,
    importance: 0.9,
    content: '主人说要结果不要流程汇报',
    createdAt: YESTERDAY,
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  assert.equal(candidatesOf(generated, 'verification').length, 0);
  const reason = skipReason(generated, 'verification');
  assert.match(reason, /no_verification_evidence/);
  assert.match(reason, /observation/, '理由要点明缺的是哪一类数据，不是一句「没有」');
});

test('verification：置信度低但有出处 → 照常产；置信度高且找得到出处 → 不产', async (t) => {
  const rig = await readyRig(t);
  const lowId = insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    sourceType: 'observation',
    confidence: 0.6,
    content: '灵枢的认知图接口是 38 个 op',
    summary: '灵枢认知图有 38 个 op',
    createdAt: YESTERDAY,
  });
  insertSourceRefRow(rig.brain.db, { memoryId: lowId });
  const highId = insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    sourceType: 'observation',
    confidence: 0.95,
    content: 'DSH 的版本号是 0.1.0',
    createdAt: YESTERDAY,
  });
  insertSourceRefRow(rig.brain.db, { memoryId: highId });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  const hits = candidatesOf(generated, 'verification');
  assert.equal(hits.length, 1, '这一类每天最多 1 条，且只挑最不确定的那条');
  assert.deepEqual(hits[0].evidence, [lowId], 'conf 0.6 比 0.95 更该被核');
  assert.equal(VERIFICATION_MAX_CONFIDENCE, 0.85);
});

test('verification：一条出处都找不到的 observation → 同样值得核（哪怕置信度不低）', async (t) => {
  const rig = await readyRig(t);
  const memoryId = insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    sourceType: 'observation',
    confidence: 0.9,
    content: '观察期纪律：样本少于 20 次不做判断',
    summary: '观察期纪律：样本少于 20 次不做判断',
    createdAt: YESTERDAY,
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  const hits = candidatesOf(generated, 'verification');
  assert.equal(hits.length, 1);
  assert.deepEqual(hits[0].evidence, [memoryId]);
  assert.match(hits[0].text, /出处/);
});

// ─────────────────────────── curiosity ───────────────────────────

test('curiosity：有 knowledge_gap 反思也不冒充——只看记忆里明确的「未决」标记', async (t) => {
  const rig = await readyRig(t);
  // 反思表里的 knowledge_gap 不是我们的依据（kind 枚举里没有 curiosity，也没有可追问对象）；
  // curiosity 的依据只有一种：记忆正文里明确写着「待定/待确认/待办/TODO…」。
  insertReflectionRow(rig.brain.db, { kind: 'knowledge_gap', text: '不清楚心海的动效参数是怎么定的' });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  assert.equal(candidatesOf(generated, 'curiosity').length, 0, '没有未决标记的记忆时，一条都不许产');
  const reason = skipReason(generated, 'curiosity');
  assert.match(reason, /no_pending_marker/, '理由要说清「记忆里没有明确「未决」的事」');
  // 2026-10-31 凌晨：curiosity 已实现，不再算「待办来源」。
  assert.equal(generated.pendingSources.includes('curiosity'), false);
  assert.equal(generated.implementedSources.includes('curiosity'), true);
});

test('来源状态：七类全部实现，且状态表自己一致', async (t) => {
  const rig = await readyRig(t);
  const preview = rig.persona.social.preview({ personId: rig.personId });
  assert.deepEqual([...preview.implementedSources].sort(), [
    'commitment',
    'curiosity',
    'discovery',
    'schedule',
    'shared_memory',
    'unfinished_care',
    'verification',
  ]);
  assert.deepEqual([...preview.pendingSources], []);
  assert.equal(SOCIAL_SOURCES_IMPLEMENTED.length, 7);
  assert.deepEqual([...SOCIAL_SOURCES_PENDING], []);
  // 2026-10-31 凌晨：curiosity 已实现（依据：记忆里明确写着「当时没定下来」的未决标记）。
  // 断言从「没做 + 说清缺什么」改成「做了 + 说清依据来自哪」。
  assert.equal(SOCIAL_SOURCE_STATE.curiosity.implemented, true);
  assert.ok(String(SOCIAL_SOURCE_STATE.curiosity.evidence ?? '').length > 0, 'curiosity 要说明依据来自哪');
  for (const source of SOCIAL_SOURCES_IMPLEMENTED) {
    assert.equal(SOCIAL_SOURCE_STATE[source].implemented, true);
    assert.ok(String(SOCIAL_SOURCE_STATE[source].evidence ?? '').length > 0, `${source} 要说明它的依据来自哪张表`);
  }
});

test('锚点判定（纯函数）：数字 / 书名号 / 路径 / 实体四种才算具体', () => {
  assert.equal(concreteAnchorOf('缩略图 320×180'), 'number');
  assert.equal(concreteAnchorOf('设计母本《DSH外置大脑-可执行设计方案-v1.2》'), 'number');
  assert.equal(concreteAnchorOf('脚本在 E:\\ds-h\\tools\\backup'), 'path');
  assert.equal(concreteAnchorOf('心海的交互框架抄群星', 1), 'entity');
  assert.equal(concreteAnchorOf('心海的交互框架抄群星'), null);
  assert.equal(concreteAnchorOf(''), null);
});

// ─────────────────────────── 回归 / 纪律 ───────────────────────────

test('新增两类不影响原有四类：同一轮里 care 与 discovery 照旧产出', async (t) => {
  const rig = await readyRig(t);
  insertMemoryRow(rig.brain.db, {
    type: 'episode',
    importance: 0.9,
    content: '昨天说感冒了，头有点疼',
    createdAt: YESTERDAY,
  });
  insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    importance: 0.9,
    content: '画布缩略图统一 320×180',
    createdAt: TWENTY_DAYS_AGO,
  });

  const generated = await rig.persona.social.generate({
    personId: rig.personId,
    persist: false,
    signals: { discovery: [{ topic: 'fix-index', text: '刚把检索索引重建完了', evidence: ['evt_real_1'], ageHours: 0 }] },
  });
  const sources = new Set(generated.candidates.map((item) => item.source));
  assert.equal(sources.has('unfinished_care'), true, 'care 类行为不许被这次改动带跑');
  assert.equal(sources.has('discovery'), true);
  assert.equal(sources.has('shared_memory'), true, '新增类要能在同一轮里和原有四类共存');
});

test('persist:false：新增两类的候选一条都不落表', async (t) => {
  const rig = await readyRig(t);
  insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    importance: 0.9,
    content: '画布缩略图统一 320×180',
    createdAt: TWENTY_DAYS_AGO,
  });
  insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    sourceType: 'observation',
    confidence: 0.7,
    content: '灵枢认知图有 38 个 op',
    createdAt: YESTERDAY,
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId, persist: false });
  assert.ok(generated.candidates.length > 0, '要有候选才能证明「不写库」不是靠没产物蒙过去的');
  assert.equal(generated.persisted, 0);
  const row = /** @type {{ n?: number }} */ (
    rig.brain.db.prepare('SELECT COUNT(*) AS n FROM social_candidates WHERE scope_id = ?').get(SCOPE_A)
  );
  assert.equal(Number(row?.n ?? 0), 0, 'dry-run 不许写库');
  // 候选本身照常有形状：只是 persisted=false
  for (const candidate of generated.candidates) assert.equal(candidate.persisted, false);
});

test('persist:true：有依据的 shared_memory 会真的落表，并用真实 memory id 做 evidence', async (t) => {
  const rig = await readyRig(t);
  const memoryId = insertMemoryRow(rig.brain.db, {
    type: 'semantic',
    importance: 0.9,
    content: '画布缩略图统一 320×180，留白 12px',
    createdAt: TWENTY_DAYS_AGO,
  });

  const generated = await rig.persona.social.generate({ personId: rig.personId });
  assert.ok(generated.persisted >= 1);
  const stored = rig.persona.social.listCandidates({ personId: PERSON_A }).items.find((item) => item.source === 'shared_memory');
  assert.ok(stored, '落表后要能按候选表读回来');
  assert.deepEqual(stored.evidence, [memoryId]);
  assert.equal(stored.topic, `shared_memory:${memoryId}`);
});
