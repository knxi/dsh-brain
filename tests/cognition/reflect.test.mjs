// @ts-check
/**
 * 系统 3 · `reflect` 空闲反思（默认模式网络）。
 *
 * 每条测试名就是一句验收需求：
 *  1. 开关为 0 时 runOnce 零副作用（一张业务表都不写）      → test 1
 *  2. paused 时同样零副作用                                  → test 2
 *  3. workspace 未接线时优雅降级（不崩、不开工、留 warning）  → test 3
 *  4. 未完成承诺 → commitment 候选（evidence 指向真实 id）   → test 4
 *  5. 知识缺口 + 后续补充 → 不再产出（补充覆盖了缺口）        → test 5
 *  6. 同类记忆 ≥3 条且跨度 >3 天 → pattern；否则不产出        → test 6
 *  7. contradicts 边 → contradiction 候选（两端都活着才算）  → test 7
 *  8. 证据不足（主题词为空）不落库                            → test 8
 *  9. promote：layer=fragment / source_type=inference / ≤0.6 → test 9
 * 10. promote 幂等（重复不产生第二条记忆）                    → test 10
 * 11. 空证据反思 promote 被拒（不得凭空造记忆）               → test 11
 * 12. 重复 runOnce 不重复产出（幂等）                         → test 12
 * 13. 跨 scope 不泄漏（别人 scope 的反思读不到/推不了）        → test 13
 * 14. 反思不存正文（text 不含原句）                           → test 14
 * 15. 没接 memories 门面时的晋升兜底路径（direct）            → test 15
 */

import test from 'node:test';
import {
  assert,
  assertNoBusinessWrites,
  countRows,
  createBrain,
  DEFAULT_SCOPE_ID,
  insertEvent,
  MIGRATIONS_DIR,
  OTHER_SCOPE_ID,
  setSwitch,
} from './helpers.mjs';

// 静默未使用告警：MIGRATIONS_DIR 由 helpers 统一导出，供别的测试按需使用。
void MIGRATIONS_DIR;

/** 造一条记忆（走真实门面，拿得到索引与版本链）。 */
async function remember(brain, draft) {
  return brain.memories.create({
    scopeId: DEFAULT_SCOPE_ID,
    personId: 'owner',
    layer: 'long',
    type: 'semantic',
    sourceType: 'owner_words',
    originSystem: 'dsh',
    producer: 'test',
    confidence: 0.9,
    importance: 0.6,
    ...draft,
  });
}

test('开关为 0：runOnce 返回 skipped 且一张业务表都不写', async (t) => {
  const { brain, fc, cognition } = createBrain(t);
  // 迁移默认值就是 reflection.enabled='0'（默认安全姿态）
  const before = brain.db.prepare("SELECT value FROM brain_switches WHERE name = 'reflection.enabled'").get();
  assert.equal(String(before.value), '0', '默认必须是关闭');

  // 先造一堆「如果跑起来就会产出反思」的数据
  await remember(brain, { type: 'commitment', content: '下次记得把报价单发给张总' });
  insertEvent(brain.db, { payloadText: '以后再说这个事，还没定', occurredAt: fc.nowIso() });
  const memoriesBefore = countRows(brain.db, 'memories');

  const result = await cognition.reflect.runOnce({ trigger: 'manual' });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'reflection_disabled');
  assert.equal(result.zeroSideEffects, true, '必须明确声明零副作用');
  assertNoBusinessWrites(brain.db, '开关关闭时：', { memories: memoriesBefore });
});

test('paused=1：runOnce 同样零副作用（全局暂停覆盖模块开关）', async (t) => {
  const { brain, workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  await setSwitch(workspace, 'paused', '1');

  const result = await cognition.reflect.runOnce();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'paused');
  assertNoBusinessWrites(brain.db, 'paused 时：');
});

test('workspace 未接线：优雅降级（按关处理 + 一次 warning，不崩）', async (t) => {
  const { brain, cognition, alerts } = createBrain(t, { workspace: false });
  const result = await cognition.reflect.runOnce();
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'workspace_unavailable');
  assertNoBusinessWrites(brain.db, 'workspace 缺失时：');
  assert.ok(
    alerts.some((info) => info.kind === 'cognition.reflection_workspace_missing'),
    '降级必须留 warning，不能静默',
  );
  // 再跑一次不重复刷 warning
  await cognition.reflect.runOnce();
  const warnings = alerts.filter((info) => info.kind === 'cognition.reflection_workspace_missing');
  assert.equal(warnings.length, 1, '同样的 warning 只记一次（告警噪音也是故障）');
});

test('未完成的承诺 → commitment 候选，证据指向真实 memory id', async (t) => {
  const { brain, workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  const created = await remember(brain, { type: 'commitment', content: '下次记得把报价单发给张总' });

  const result = await cognition.reflect.runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(result.produced, 1);
  const [reflection] = cognition.reflect.list({ status: 'candidate' }).items;
  assert.equal(reflection.kind, 'commitment');
  assert.deepEqual(reflection.evidence, [`memory:${created.id}`], '证据必须指回真实记忆 id');
  assert.equal(reflection.status, 'candidate', '默认只能是候选，不能直接当事实');

  // 已完成的承诺不再产出（写了一条带完成标记的承诺）
  await remember(brain, { type: 'commitment', content: '名片的事已完成，不用再跟' });
  const second = await cognition.reflect.runOnce({ windowFrom: '2026-10-01T00:00:00.000Z' });
  const kinds = cognition.reflect.list({ status: 'candidate' }).items.map((item) => item.kind);
  assert.equal(kinds.filter((kind) => kind === 'commitment').length, 1, '已完成的不该再提醒');
  void second;
});

test('知识缺口：后续有补充就不产出，没有补充才产出', async (t) => {
  const { brain, workspace, cognition, fc } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');

  // 缺口 A：之后补充了（同主题词）
  await remember(brain, { content: '铜版纸的报价还没确认，待查' });
  fc.advance(60_000);
  await remember(brain, { content: '铜版纸的报价确认了，0.45 元一张' });

  const first = await cognition.reflect.runOnce();
  assert.equal(first.produced, 0, '缺口被同一主题的补充记录覆盖了，不该再报');

  // 缺口 B：之后没有补充
  fc.advance(60_000);
  await remember(brain, { content: '那批画册的出血尺寸不确定，要查一下' });
  const second = await cognition.reflect.runOnce();
  assert.equal(second.produced, 1);
  const [reflection] = cognition.reflect.list({ status: 'candidate' }).items;
  assert.equal(reflection.kind, 'knowledge_gap');
  assert.match(reflection.text, /memory:mem_/);
});

test('模式归纳：同类 ≥3 条且跨度 >3 天才产出', async (t) => {
  const { brain, workspace, cognition, fc } = createBrain(t, { startIso: '2026-10-01T10:00:00.000Z' });
  await setSwitch(workspace, 'reflection.enabled', '1');

  // 3 条同 type 但跨度只有 2 小时 → 不算模式
  for (let index = 0; index < 3; index += 1) {
    await remember(brain, { type: 'profile', content: `偏好记录 ${index}` });
    fc.advance(40 * 60 * 1000);
  }
  const shortSpan = await cognition.reflect.runOnce({ windowFrom: '2026-10-01T00:00:00.000Z', windowTo: '2026-10-02T00:00:00.000Z' });
  assert.equal(shortSpan.produced, 0, '两小时里三条同类不算模式（可能只是同一件事的记录）');

  // 跨度 5 天 → 算模式
  fc.advance(5 * 24 * 60 * 60 * 1000);
  await remember(brain, { type: 'profile', content: '偏好记录 4' });
  const longSpan = await cognition.reflect.runOnce({ windowFrom: '2026-10-01T00:00:00.000Z', windowTo: '2026-10-08T00:00:00.000Z' });
  assert.equal(longSpan.produced, 1);
  const items = cognition.reflect.list({ status: 'candidate' }).items;
  const pattern = items.find((item) => item.kind === 'pattern');
  assert.ok(pattern, '跨度 >3 天的同类记忆必须归纳成模式');
  assert.ok(pattern.evidence.length >= 3, '模式至少要有 3 条证据');
});

test('矛盾检测：contradicts 边两端都活着才算未处理', async (t) => {
  const { brain, workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');

  const a = await remember(brain, { content: '铜版纸名片报价 0.45 元一张' });
  const b = await remember(brain, { content: '铜版纸名片报价 0.62 元一张' });
  const link = await brain.memoryEdges.link({
    scopeId: DEFAULT_SCOPE_ID,
    fromMemoryId: a.id,
    toMemoryId: b.id,
    kind: 'contradicts',
    reason: '两处报价不一致',
  });

  const result = await cognition.reflect.runOnce();
  assert.equal(result.produced, 1);
  const [reflection] = cognition.reflect.list({ status: 'candidate', kind: 'contradiction' }).items;
  assert.ok(reflection, '显式的矛盾边必须被反思到');
  assert.ok(reflection.evidence.includes(`edge:${link.id}`), '必须引用边 id，而不是复述两段正文');
  assert.equal(reflection.confidence, 0.85, '显式边可信度高，但仍是候选');

  // 一端被 supersede 后，矛盾自然消解 → 不再产出
  const c = await remember(brain, { content: '铜版纸名片报价 0.45 元一张（修正后）' });
  await brain.memories.supersede(b.id, c.id, { scopeId: DEFAULT_SCOPE_ID, changedBy: 'test', reason: '纠正报价' });
  const second = await cognition.reflect.runOnce({ windowFrom: '2026-10-01T00:00:00.000Z' });
  assert.equal(second.produced, 0, '一端被取代后矛盾已消解，不该继续报');
});

test('证据不足：没有主题词的事件不产出（空证据不落库）', async (t) => {
  const { brain, workspace, cognition, fc } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  // 「待」只有触发词、没有任何主题词：不能判断它是哪件事 → 证据不足，丢弃
  insertEvent(brain.db, { payloadText: '待', occurredAt: fc.nowIso() });

  const result = await cognition.reflect.runOnce();
  assert.equal(result.produced, 0);
  assert.equal(countRows(brain.db, 'reflections'), 0, '证据不足的候选一条都不许落库');
  // 但批次记录要在：得能回答「这次反思跑过」
  assert.equal(countRows(brain.db, 'reflection_runs'), 1);
});

test('promote：写 fragment/inference/≤0.6，且记录 promoted_memory_id', async (t) => {
  const { brain, workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  await remember(brain, { type: 'commitment', content: '下次记得把报价单发给张总' });
  const run = await cognition.reflect.runOnce();
  const [reflection] = cognition.reflect.list({ status: 'candidate' }).items;

  const promoted = await cognition.reflect.promote(reflection.id);
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.via, 'facade', '接线后应走记忆门面（拿到索引与来源链）');

  const row = brain.db.prepare('SELECT * FROM memories WHERE id = ?').get(promoted.memoryId);
  assert.equal(String(row.layer), 'fragment');
  assert.equal(String(row.source_type), 'inference', '推断不得伪装成事实');
  assert.ok(Number(row.confidence) <= 0.6, `置信度必须 ≤0.6（实际 ${row.confidence}）`);
  assert.equal(String(row.type), 'commitment', 'kind=commitment 映射到 type=commitment');
  assert.equal(String(row.causation_id), reflection.id, '记忆必须能指回产生它的反思');

  const after = cognition.reflect.get(reflection.id);
  assert.equal(after.status, 'promoted');
  assert.equal(after.promotedMemoryId, promoted.memoryId);
  const runRow = cognition.reflect.getRun(run.runId);
  assert.equal(runRow.promotedCount, 1, '批次的晋升计数要更新');
});

test('promote 幂等：重复调用不产生第二条记忆', async (t) => {
  const { brain, workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  await remember(brain, { type: 'commitment', content: '下次记得把报价单发给张总' });
  await cognition.reflect.runOnce();
  const [reflection] = cognition.reflect.list({ status: 'candidate' }).items;

  const first = await cognition.reflect.promote(reflection.id);
  const memoriesAfterFirst = countRows(brain.db, 'memories');
  const second = await cognition.reflect.promote(reflection.id);
  const third = await cognition.reflect.promote(reflection.id);

  assert.equal(second.alreadyPromoted, true);
  assert.equal(second.memoryId, first.memoryId, '幂等重放必须返回同一记忆 id');
  assert.equal(third.memoryId, first.memoryId);
  assert.equal(countRows(brain.db, 'memories'), memoriesAfterFirst, '重复 promote 不许写第二条记忆');
});

test('promote 拒绝空证据的反思（不得凭空造记忆）', async (t) => {
  const { brain, workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  await remember(brain, { type: 'commitment', content: '下次记得把报价单发给张总' });
  await cognition.reflect.runOnce();
  const [reflection] = cognition.reflect.list({ status: 'candidate' }).items;

  // 白盒把证据抹空，模拟「历史脏数据 / 规则 bug」
  brain.db.prepare('UPDATE reflections SET evidence_json = ? WHERE id = ?').run('[]', reflection.id);
  await assert.rejects(
    () => cognition.reflect.promote(reflection.id),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      return true;
    },
    '空证据不得晋升',
  );
  assert.equal(countRows(brain.db, 'memories'), 1, '只该有最初那条承诺记忆');
});

test('重复 runOnce 幂等：同一批证据不重复产出', async (t) => {
  const { brain, workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  await remember(brain, { type: 'commitment', content: '下次记得把报价单发给张总' });

  const first = await cognition.reflect.runOnce();
  assert.equal(first.produced, 1);
  const second = await cognition.reflect.runOnce();
  assert.equal(second.produced, 0, '第二次同一批证据不该再产出一条');
  assert.equal(second.duplicates, 1);
  assert.equal(countRows(brain.db, 'reflections'), 1);
});

test('跨 scope：读不到、推不了别的 scope 的反思', async (t) => {
  const { brain, workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  await remember(brain, { type: 'commitment', content: '下次记得把报价单发给张总' });
  await cognition.reflect.runOnce();
  const [reflection] = cognition.reflect.list({ status: 'candidate' }).items;

  assert.deepEqual(
    cognition.reflect.list({ scopeId: OTHER_SCOPE_ID }).items,
    [],
    '别的 scope 看不到这条反思',
  );
  assert.equal(cognition.reflect.get(reflection.id, { scopeId: OTHER_SCOPE_ID }), null);
  await assert.rejects(
    () => cognition.reflect.promote(reflection.id, { scopeId: OTHER_SCOPE_ID }),
    (err) => err.code === 'NOT_FOUND',
    '跨 scope 晋升必须报 NOT_FOUND（连存在性都不承认）',
  );

  // 别的 scope 里同样的数据不该混进来（统计隔离）
  assert.equal(cognition.reflect.stats().byStatus.candidate, 1);
  assert.equal(cognition.reflect.stats({ scopeId: OTHER_SCOPE_ID }).byStatus.candidate ?? 0, 0);
});

test('反思不存正文：text 只写结构化描述与 id，不复述原句', async (t) => {
  const { brain, workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  const secret = '报价单里那个不能外传的客户底价是 0.31 元';
  await remember(brain, { type: 'commitment', content: `下次记得处理：${secret}` });

  await cognition.reflect.runOnce();
  const [reflection] = cognition.reflect.list({ status: 'candidate' }).items;
  assert.ok(!reflection.text.includes('客户底价'), '反思正文不许复述记忆原文（隐私 + 体积）');
  assert.ok(!reflection.text.includes('0.31'), '数字片段也不许带出来');
  assert.match(reflection.text, /memory:mem_/, '但必须能指回来源 id');
  assert.ok(reflection.text.length <= 300, '反思正文有上限');
});

test('没接 memories 门面时的晋升兜底路径（direct）：同样幂等', async (t) => {
  const { brain, workspace, cognition } = createBrain(t, { promoteViaFacade: false });
  await setSwitch(workspace, 'reflection.enabled', '1');
  await remember(brain, { type: 'commitment', content: '下次记得把报价单发给张总' });
  await cognition.reflect.runOnce();
  const [reflection] = cognition.reflect.list({ status: 'candidate' }).items;

  const promoted = await cognition.reflect.promote(reflection.id);
  assert.equal(promoted.via, 'direct');
  const row = brain.db.prepare('SELECT * FROM memories WHERE id = ?').get(promoted.memoryId);
  assert.equal(String(row.source_type), 'inference');
  assert.equal(String(row.layer), 'fragment');
  // 版本留痕也要补上（直接 INSERT 绕过了门面，这一步不能省）
  const versions = brain.db.prepare('SELECT * FROM memory_versions WHERE memory_id = ?').all(promoted.memoryId);
  assert.equal(versions.length, 1, '直接写也要留版本行');

  const again = await cognition.reflect.promote(reflection.id);
  assert.equal(again.alreadyPromoted, true);
  assert.equal(countRows(brain.db, 'memories'), 2, '只有承诺 + 晋升各一条');
});

test('dismiss：垃圾候选能扔掉，但已晋升的不能否决', async (t) => {
  const { brain, workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  await remember(brain, { type: 'commitment', content: '下次记得把报价单发给张总' });
  await cognition.reflect.runOnce();
  const [reflection] = cognition.reflect.list({ status: 'candidate' }).items;

  const dismissed = await cognition.reflect.dismiss(reflection.id, { by: 'test' });
  assert.equal(dismissed.dismissed, true);
  const again = await cognition.reflect.dismiss(reflection.id, { by: 'test' });
  assert.equal(again.alreadyDismissed, true, '重复否决是幂等的');
  await assert.rejects(
    () => cognition.reflect.promote(reflection.id),
    (err) => err.code === 'INVALID_ARGUMENT',
    '已否决的反思不得晋升',
  );
});

test('规则执行失败：批次标 failed 并留 error（可追查为什么没产出）', async (t) => {
  const { brain, workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  await remember(brain, { type: 'commitment', content: '下次记得把报价单发给张总' });
  // 白盒触发器：让写 reflections 必然失败，模拟「规则/存储出问题」的那条路径
  brain.db.exec(
    "CREATE TRIGGER force_reflection_fail BEFORE INSERT ON reflections BEGIN SELECT RAISE(ABORT, 'forced_failure'); END;",
  );

  const result = await cognition.reflect.runOnce();
  assert.equal(result.status, 'failed', 'runOnce 不抛，而是如实返回 failed');
  // node:sqlite 会把 RAISE(ABORT, '自定义文案') 归一成 "constraint failed"：
  // 断言只要求「有错误摘要」，不苛求底层文案原样透出。
  assert.match(String(result.error), /失败|constraint/i);
  assert.equal(result.produced, 0);

  const run = cognition.reflect.getRun(result.runId);
  assert.equal(run.status, 'failed', '批次记录必须留痕（否则永远查不出为什么没产出）');
  assert.match(String(run.error), /失败|constraint/i);
  assert.ok(run.finishedAt !== null);
  assert.equal(countRows(brain.db, 'reflections'), 0, '失败的批次不许留下半条反思');
});

test('参数校验：trigger 只能是四个枚举值之一，窗口必须 from<to', async (t) => {
  const { workspace, cognition } = createBrain(t);
  await setSwitch(workspace, 'reflection.enabled', '1');
  await assert.rejects(
    () => cognition.reflect.runOnce({ trigger: 'cron' }),
    (err) => err.code === 'INVALID_ARGUMENT',
    'trigger 必须落 0008 的 CHECK 枚举',
  );
  await assert.rejects(
    () => cognition.reflect.runOnce({ windowFrom: '2026-10-28T10:00:00.000Z', windowTo: '2026-10-28T09:00:00.000Z' }),
    (err) => err.code === 'INVALID_ARGUMENT',
    '窗口起点必须早于终点',
  );
});
