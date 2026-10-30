// @ts-check
/**
 * 系统 3 · `skill` 技能校准（小脑）。
 *
 * 每条测试名就是一句验收需求：
 *  1. 威尔逊下界：手算值对得上（小样本不给高置信）          → test 1
 *  2. 成功一次：attempts/successes/confidence 正确          → test 2
 *  3. 失败一次：failures/连续失败 + failure_reason 教训      → test 3
 *  4. 同一错误码重复失败：教训 occurrences 累加不新建行      → test 4
 *  5. 成功会重置 consecutive_failures                       → test 5
 *  6. **沙箱拒绝：降低置信度但不标成技能失败**                → test 6
 *  7. 弱技能清单：低置信度（样本≥3）或连续失败≥3             → test 7
 *  8. 未知不算弱：样本 <3 次不进弱清单                        → test 8
 *  9. 跨 scope 不泄漏                                        → test 9
 * 10. 参数校验：ok 必填布尔、成功不得带 errorCode            → test 10
 * 11. skillKey 规则：tool / tool:action / 显式 skillKey       → test 11
 * 12. classifyError：sandbox / transient / failure 三类       → test 12
 * 13. 教训里只存 evidence id，不存工具返回正文                → test 13
 */

import test from 'node:test';
import { classifyError, createSkill, skillKeyOf, wilsonLowerBound } from '../../packages/cognition/src/skill.js';
import { assert, countRows, createBrain, DEFAULT_SCOPE_ID, OTHER_SCOPE_ID } from './helpers.mjs';

/** 手算的威尔逊下界（z=1.96），容差 5e-4。 */
const WILSON_CASES = Object.freeze([
  { successes: 0, attempts: 0, expected: 0 },
  { successes: 0, attempts: 1, expected: 0 },
  { successes: 1, attempts: 1, expected: 0.2065 },
  { successes: 2, attempts: 2, expected: 0.3424 },
  { successes: 3, attempts: 3, expected: 0.4385 },
  { successes: 5, attempts: 5, expected: 0.5655 },
  { successes: 8, attempts: 10, expected: 0.4902 },
]);

test('威尔逊下界：手算值对得上（小样本不给高置信度）', () => {
  for (const item of WILSON_CASES) {
    const actual = wilsonLowerBound(item.successes, item.attempts);
    assert.ok(
      Math.abs(actual - item.expected) <= 5e-4,
      `${item.successes}/${item.attempts} 期望 ${item.expected}，实际 ${actual}`,
    );
  }
  // 单调性：同样 100% 成功率，样本越多下界越高（但永远 < 1）
  assert.ok(wilsonLowerBound(1, 1) < wilsonLowerBound(5, 5));
  assert.ok(wilsonLowerBound(5, 5) < wilsonLowerBound(50, 50));
  assert.ok(wilsonLowerBound(50, 50) < 1);
});

test('成功一次：attempts/successes/confidence 正确', async (t) => {
  const { cognition, brain } = createBrain(t);
  const result = await cognition.skill.recordResult({
    tool: 'read_file',
    action: 'read',
    ok: true,
    durationMs: 12,
    evidence: ['tool_call:tc_1'],
  });
  assert.equal(result.skillKey, 'read_file:read');
  assert.equal(result.attempts, 1);
  assert.equal(result.successes, 1);
  assert.equal(result.failures, 0);
  assert.equal(result.consecutiveFailures, 0);
  assert.equal(result.confidence, 0.2065, '一次成功只说明「还没证明」');

  const skill = cognition.skill.getSkill('read_file:read');
  assert.equal(skill.successes, 1);
  assert.match(skill.lastSuccessAt, /^2026-10-28T10:00:00\.000Z$/);
  assert.equal(countRows(brain.db, 'skill_stats'), 1);
});

test('失败一次：failures + 连续失败 + 生成 failure_reason 教训', async (t) => {
  const { cognition, brain } = createBrain(t);
  const result = await cognition.skill.recordResult({
    tool: 'send_mail',
    action: 'send',
    ok: false,
    errorCode: 'SMTP_AUTH_FAILED',
    evidence: ['tool_call:tc_2'],
  });
  assert.equal(result.failures, 1);
  assert.equal(result.consecutiveFailures, 1);
  assert.equal(result.confidence, 0, '0 次成功 = 下界 0');
  assert.equal(result.lesson.kind, 'failure_reason');
  assert.match(result.lesson.text, /SMTP_AUTH_FAILED/);

  const lessons = cognition.skill.listLessons({ skillKey: 'send_mail:send' }).items;
  assert.equal(lessons.length, 1);
  assert.equal(lessons[0].occurrences, 1);
  assert.deepEqual(lessons[0].evidence, ['tool_call:tc_2']);
  assert.equal(countRows(brain.db, 'skill_lessons'), 1);
});

test('同一错误码重复失败：教训 occurrences 累加，不新建行', async (t) => {
  const { cognition, brain } = createBrain(t);
  const input = { tool: 'send_mail', action: 'send', ok: false, errorCode: 'SMTP_AUTH_FAILED' };
  await cognition.skill.recordResult(input);
  await cognition.skill.recordResult(input);
  await cognition.skill.recordResult(input);

  const lessons = cognition.skill.listLessons({ skillKey: 'send_mail:send' }).items;
  assert.equal(lessons.length, 1, '同一 (skill_key, kind, text) 只留一行');
  assert.equal(lessons[0].occurrences, 3);
  assert.ok(lessons[0].confidence > 0.5, '反复出现的教训更可信');
  assert.equal(countRows(brain.db, 'skill_lessons'), 1);
  const skill = cognition.skill.getSkill('send_mail:send');
  assert.equal(skill.consecutiveFailures, 3);
  assert.equal(skill.failures, 3);
});

test('成功会重置 consecutive_failures', async (t) => {
  const { cognition } = createBrain(t);
  await cognition.skill.recordResult({ tool: 'x', ok: false, errorCode: 'E_TOOL' });
  await cognition.skill.recordResult({ tool: 'x', ok: false, errorCode: 'E_TOOL' });
  let skill = cognition.skill.getSkill('x');
  assert.equal(skill.consecutiveFailures, 2);
  await cognition.skill.recordResult({ tool: 'x', ok: true });
  skill = cognition.skill.getSkill('x');
  assert.equal(skill.consecutiveFailures, 0);
  assert.equal(skill.successes, 1);
  assert.equal(skill.failures, 2, '历史失败计数不清零（那是发生过的事）');
});

test('沙箱拒绝：降低置信度，但不标成技能失败（不记 failures、不生成 failure_reason）', async (t) => {
  const { cognition, brain } = createBrain(t);
  // 先跑成功 5 次，建立「这技能其实能用」的底子
  for (let index = 0; index < 5; index += 1) {
    await cognition.skill.recordResult({ tool: 'shell', action: 'run', ok: true });
  }
  const before = cognition.skill.getSkill('shell:run');
  assert.equal(before.confidence, 0.5655);

  // 连续 3 次被沙箱拒绝（EPERM）
  for (let index = 0; index < 3; index += 1) {
    await cognition.skill.recordResult({
      tool: 'shell',
      action: 'run',
      ok: false,
      errorCode: 'EPERM',
      evidence: [`tool_call:denied_${index}`],
    });
  }
  const after = cognition.skill.getSkill('shell:run');
  assert.equal(after.attempts, 8, '尝试次数要如实增加');
  assert.equal(after.failures, 0, '沙箱拒绝不是技能失败 → failures 不涨');
  assert.equal(after.consecutiveFailures, 0, '也不打断连续成功记录');
  assert.equal(after.sandboxBlocks, 3, '被挡次数单独记在 notes 里');
  assert.equal(after.lastErrorCode, 'EPERM');
  assert.ok(after.confidence < before.confidence, `置信度要下降（${before.confidence} → ${after.confidence}）`);
  assert.equal(after.confidence, 0.3057, '威尔逊下界按 5/8 算');

  const lessons = cognition.skill.listLessons({ skillKey: 'shell:run' }).items;
  assert.equal(lessons.length, 1, '只生成一条教训');
  assert.equal(lessons[0].kind, 'precondition', '环境权限问题归 precondition（需要放行），不是 failure_reason');
  assert.equal(countRows(brain.db, 'skill_lessons'), 1, '不许混进 failure_reason 行');
});

test('弱技能清单：低置信度（样本≥3）或连续失败≥3', async (t) => {
  const { cognition } = createBrain(t);
  // A：成功 5 次 → 不弱
  for (let index = 0; index < 5; index += 1) await cognition.skill.recordResult({ tool: 'a', ok: true });
  // B：连续失败 3 次 → 弱（连续失败）
  for (let index = 0; index < 3; index += 1) await cognition.skill.recordResult({ tool: 'b', ok: false, errorCode: 'E_B' });
  // C：成功 1 次 → 置信度低但样本不足 → 不算弱（未知 ≠ 弱）
  await cognition.skill.recordResult({ tool: 'c', ok: true });
  // D：3 次里只成功 1 次 → 低置信度 → 弱
  await cognition.skill.recordResult({ tool: 'd', ok: true });
  await cognition.skill.recordResult({ tool: 'd', ok: false, errorCode: 'E_D' });
  await cognition.skill.recordResult({ tool: 'd', ok: false, errorCode: 'E_D' });

  const weak = cognition.skill.listWeakSkills();
  const keys = weak.items.map((item) => item.skillKey);
  assert.ok(keys.includes('b'), '连续失败 3 次必须进弱清单');
  assert.ok(keys.includes('d'), '样本够但置信度低必须进弱清单');
  assert.equal(keys.includes('a'), false, '稳定成功的技能不该进弱清单');
  assert.equal(keys.includes('c'), false, '样本不足的「未知」不算「弱」');

  const b = weak.items.find((item) => item.skillKey === 'b');
  assert.ok(b.reasons.includes('连续失败'));
  const d = weak.items.find((item) => item.skillKey === 'd');
  assert.ok(d.reasons.includes('低置信度'));
});

test('跨 scope：看不到、统计不串', async (t) => {
  const { cognition } = createBrain(t);
  await cognition.skill.recordResult({ tool: 'a', ok: true, scopeId: DEFAULT_SCOPE_ID });
  await cognition.skill.recordResult({ tool: 'b', ok: true, scopeId: OTHER_SCOPE_ID });

  assert.equal(cognition.skill.getSkill('a')?.skillKey, 'a');
  assert.equal(cognition.skill.getSkill('a', { scopeId: OTHER_SCOPE_ID }), null);
  assert.equal(cognition.skill.getSkill('b'), null);
  assert.equal(cognition.skill.stats().skills, 1);
  assert.equal(cognition.skill.stats({ scopeId: OTHER_SCOPE_ID }).skills, 1);
  assert.deepEqual(cognition.skill.listLessons({ scopeId: OTHER_SCOPE_ID }).items, []);
});

test('参数校验：ok 必填布尔；成功不得带 errorCode；非对象证据拒', async (t) => {
  const { cognition } = createBrain(t);
  await assert.rejects(
    () => cognition.skill.recordResult({ tool: 'x' }),
    (err) => err.code === 'INVALID_ARGUMENT',
    'ok 缺失必须拒（成功/失败不能靠猜）',
  );
  await assert.rejects(
    () => cognition.skill.recordResult({ tool: 'x', ok: true, errorCode: 'E_X' }),
    (err) => err.code === 'INVALID_ARGUMENT',
    '成功和失败不能同时成立',
  );
  await assert.rejects(
    () => cognition.skill.recordResult({ ok: true }),
    (err) => err.code === 'INVALID_ARGUMENT',
    'tool 或 skillKey 至少要给一个',
  );
  await assert.rejects(
    () => cognition.skill.recordResult({ tool: 'x', ok: true, evidence: 'tool_call:1' }),
    (err) => err.code === 'INVALID_ARGUMENT',
    'evidence 必须是数组',
  );
});

test('skillKey 规则：tool / tool:action / 显式 skillKey', () => {
  assert.equal(skillKeyOf({ tool: 'read_file' }), 'read_file');
  assert.equal(skillKeyOf({ tool: 'read_file', action: 'read' }), 'read_file:read');
  assert.equal(skillKeyOf({ skillKey: 'custom:key' }), 'custom:key');
  assert.equal(skillKeyOf({ skillKey: 'custom:key', tool: 'ignored' }), 'custom:key', '显式 skillKey 优先');
});

test('classifyError：sandbox / transient / failure 三类分得清', () => {
  for (const code of ['EPERM', 'EACCES', 'EROFS', 'SANDBOX_DENIED', 'SANDBOX_EPERM']) {
    assert.equal(classifyError(code), 'sandbox', `${code} 应归 sandbox`);
  }
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'RATE_LIMITED', 'EAGAIN']) {
    assert.equal(classifyError(code), 'transient', `${code} 应归 transient`);
  }
  assert.equal(classifyError('SMTP_AUTH_FAILED'), 'failure');
  assert.equal(classifyError(null), 'unknown');
});

test('教训只存 evidence id，不存工具返回正文', async (t) => {
  const { cognition } = createBrain(t);
  await cognition.skill.recordResult({
    tool: 'http',
    ok: false,
    errorCode: 'HTTP_500',
    evidence: ['tool_call:tc_9'],
  });
  const [lesson] = cognition.skill.listLessons({ skillKey: 'http' }).items;
  assert.deepEqual(lesson.evidence, ['tool_call:tc_9']);
  assert.ok(lesson.text.length < 120, '教训文案是固定短语，不搬运原文');
  assert.ok(!lesson.text.includes('tool_call'), '证据 id 只在 evidence 列，不拼进正文');
});

test('createSkill 可脱离 cognition 单独构造（面板/CLI 复用）', async (t) => {
  const { brain, fc } = createBrain(t);
  const standalone = createSkill({
    db: brain.db,
    queue: brain.queue,
    clock: fc.clock,
    bindings: { scope_id: DEFAULT_SCOPE_ID, person_id: 'owner' },
  });
  const result = await standalone.recordResult({ tool: 'solo', ok: true });
  assert.equal(result.successes, 1);
  assert.equal(standalone.getSkill('solo').attempts, 1);
});
