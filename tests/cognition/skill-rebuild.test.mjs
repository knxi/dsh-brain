// @ts-check
/**
 * 重算技能置信度（2026-11-03 新增）。
 *
 * 这东西是「治理」页里最后一个 hook 缺口（`skill_rebuild`）。它会被写操作调用，
 * 所以每条测试名就是一句验收要求：
 *  1. 数据自洽时重算不该改动任何行（幂等的第一步）
 *  2. confidence 被写坏时，重算能按 successes/attempts 修回来
 *  3. 连跑两次，第二次 changed 必为 0（真幂等）
 *  4. dryRun 只报告不写库
 *  5. 不碰 attempts / successes / failures 这些事实列（只动派生列）
 *  6. 跨 scope 不串（只修自己 scope 的行）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrain, DEFAULT_SCOPE_ID, OTHER_SCOPE_ID } from './helpers.mjs';
import { wilsonLowerBound } from '../../packages/cognition/src/skill.js';

/** skillKey 是 tool:action 拼出来的，别拿 action 当 key */
const KEY = 'bash:test/skill-rebuild';

/** 跑一次 recordResult，把一条技能记录出来 */
async function record(cognition, scopeId, ok) {
  return cognition.skill.recordResult({
    scopeId,
    tool: 'bash',
    action: 'test/skill-rebuild',
    ok,
    errorCode: ok ? null : 'E_TEST',
  });
}

/** 读某条技能的原始行 */
function readRow(db, scopeId, skillKey) {
  return db.prepare('SELECT * FROM skill_stats WHERE scope_id = ? AND skill_key = ?').get(scopeId, skillKey);
}

test('数据自洽时：重算 unchanged（幂等第一步）', async (t) => {
  const { cognition, brain } = createBrain(t);
  await record(cognition, DEFAULT_SCOPE_ID, true);
  await record(cognition, DEFAULT_SCOPE_ID, false);
  await record(cognition, DEFAULT_SCOPE_ID, true);

  const out = await cognition.skill.rebuildConfidence({});
  assert.equal(out.scanned, 1, '应该扫到 1 条技能');
  assert.equal(out.changed, 0, '刚 record 出来的数据是自洽的，不该有任何改动');
});

test('confidence 被写坏时：按 successes/attempts 修回来', async (t) => {
  const { cognition, brain } = createBrain(t);
  await record(cognition, DEFAULT_SCOPE_ID, true);
  await record(cognition, DEFAULT_SCOPE_ID, true);
  await record(cognition, DEFAULT_SCOPE_ID, false);

  const before = readRow(brain.db, DEFAULT_SCOPE_ID, KEY);
  const truth = wilsonLowerBound(Number(before.successes), Number(before.attempts));

  // 把它写坏（模拟外部脚本改错 / 旧公式留下的值）
  brain.db.prepare('UPDATE skill_stats SET confidence = 0.999 WHERE id = ?').run(before.id);
  assert.equal(Number(readRow(brain.db, DEFAULT_SCOPE_ID, KEY).confidence), 0.999);

  const out = await cognition.skill.rebuildConfidence({});
  assert.equal(out.changed, 1, '坏掉的那一行应被修');
  assert.equal(out.samples[0].skillKey, KEY);
  assert.ok(Math.abs(out.samples[0].after - truth) < 1e-9);

  const after = readRow(brain.db, DEFAULT_SCOPE_ID, KEY);
  assert.ok(Math.abs(Number(after.confidence) - truth) < 1e-9, '应修回 wilson 真值');
});

test('连跑两次：第二次 changed 必为 0（真幂等）', async (t) => {
  const { cognition, brain } = createBrain(t);
  await record(cognition, DEFAULT_SCOPE_ID, true);
  const row = readRow(brain.db, DEFAULT_SCOPE_ID, KEY);
  brain.db.prepare('UPDATE skill_stats SET confidence = 0.01 WHERE id = ?').run(row.id);

  const first = await cognition.skill.rebuildConfidence({});
  assert.equal(first.changed, 1);

  const second = await cognition.skill.rebuildConfidence({});
  assert.equal(second.changed, 0, '第二次不该再有任何改动');
});

test('dryRun：只报告，不写库', async (t) => {
  const { cognition, brain } = createBrain(t);
  await record(cognition, DEFAULT_SCOPE_ID, true);
  const row = readRow(brain.db, DEFAULT_SCOPE_ID, KEY);
  brain.db.prepare('UPDATE skill_stats SET confidence = 0.02 WHERE id = ?').run(row.id);

  const out = await cognition.skill.rebuildConfidence({ dryRun: true });
  assert.equal(out.changed, 1, 'dryRun 也要如实报告「有 1 行需要修」');
  assert.equal(out.dryRun, true);
  // 但库里必须还是坏的
  assert.equal(Number(readRow(brain.db, DEFAULT_SCOPE_ID, KEY).confidence), 0.02);
});

test('只动派生列：attempts / successes / failures 一个都不许变', async (t) => {
  const { cognition, brain } = createBrain(t);
  await record(cognition, DEFAULT_SCOPE_ID, true);
  await record(cognition, DEFAULT_SCOPE_ID, false);
  const before = readRow(brain.db, DEFAULT_SCOPE_ID, KEY);
  brain.db.prepare('UPDATE skill_stats SET confidence = 0.5 WHERE id = ?').run(before.id);

  await cognition.skill.rebuildConfidence({});
  const after = readRow(brain.db, DEFAULT_SCOPE_ID, KEY);
  for (const key of ['attempts', 'successes', 'failures', 'consecutive_failures']) {
    assert.equal(Number(after[key]), Number(before[key]), `${key} 是事实列，不该被重算动到`);
  }
});

test('跨 scope 不串：只修自己 scope 的行', async (t) => {
  const { cognition, brain } = createBrain(t);
  await record(cognition, DEFAULT_SCOPE_ID, true);
  await record(cognition, OTHER_SCOPE_ID, true);

  // 两个 scope 各写坏一行
  for (const scope of [DEFAULT_SCOPE_ID, OTHER_SCOPE_ID]) {
    const row = readRow(brain.db, scope, KEY);
    brain.db.prepare('UPDATE skill_stats SET confidence = 0.3 WHERE id = ?').run(row.id);
  }

  const out = await cognition.skill.rebuildConfidence({ scopeId: DEFAULT_SCOPE_ID });
  assert.equal(out.scanned, 1, '只该扫到自己 scope 的 1 行');
  assert.equal(out.changed, 1);

  assert.equal(Number(readRow(brain.db, DEFAULT_SCOPE_ID, KEY).confidence) !== 0.3, true);
  assert.equal(
    Number(readRow(brain.db, OTHER_SCOPE_ID, KEY).confidence),
    0.3,
    '别的 scope 不该被碰',
  );
});
