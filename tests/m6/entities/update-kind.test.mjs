// @ts-check
/**
 * M6.1：实体 kind 修正（`entities.updateKind`）。
 *
 * 为什么单独一个文件：`entities.test.mjs` 锁的是 M6 首版 14 类必测项，别去改它的断言；
 * 这条能力是后补的（`upsert` 的「kind 不降级」规则让 person→other 改不动），
 * 集中放这里，读的人一眼知道「修 kind 的口径」都在这一份里。
 *
 * 覆盖（每条一个 test）：
 *  1. 正常改：kind 真的变了、updated_at 前进、返回字段完整、其余字段不动
 *  2. 幂等：同 kind 再传一次 changed=false，且**不写 updated_at、不落审计**
 *  3. 非法 kind：INVALID_ARGUMENT，不落库、不落审计
 *  4. 实体不存在：NOT_FOUND（含空 id / 非字符串）
 *  5. 已删实体：CONFLICT，kind 不变
 *  6. 跨 scope：默认按 caller scope 收口（越界 NOT_FOUND，不确认存在性）；
 *     显式 scopeId / allowCrossScope 才动得了别的 scope
 *  7. 审计落痕：action/actor/target/scope/detail 全字段核对
 *
 * 纪律：只用 node:test + node:assert/strict，全部在 mkdtemp 临时主账里跑，不碰 data/brain.db。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../../packages/core/src/index.js';
import { openBrain } from '../../../packages/memory/src/index.js';

/** 仓库内 migrations 目录（<repo>/migrations/）。 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

/** 与 openBrain 的默认 bindings 对齐（CONTRACTS §2）。 */
const SCOPE_A = 'owner-default';
const SCOPE_B = 'owner-other';

/**
 * 可推进的固定时钟：断言 updated_at 是否被动过必须靠它。
 * @param {string} [startIso]
 */
function fixedClock(startIso = '2026-10-28T10:00:00.000Z') {
  let current = Date.parse(startIso);
  const clock = createClock({ timeZone: 'Asia/Shanghai', now: () => new Date(current) });
  return {
    clock,
    advance(ms = 1000) {
      current += ms;
      return new Date(current).toISOString();
    },
    nowIso: () => new Date(current).toISOString(),
  };
}

/**
 * 打开一个临时主账（已跑完 0001…0006），测试结束关闭并删目录。
 * @param {import('node:test').TestContext} t
 */
function createBrain(t, bindings) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m6-kind-'));
  const dbPath = path.join(dir, 'brain.db');
  const fc = fixedClock();
  const brain = openBrain({
    dbPath,
    migrationsDir: MIGRATIONS_DIR,
    clock: fc.clock,
    ...(bindings === undefined ? {} : { bindings }),
  });
  let closed = false;
  t.after(async () => {
    if (!closed) {
      closed = true;
      try {
        await brain.close();
      } catch {
        /* 已关闭：不掩盖测试失败 */
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟释放不影响断言 */
    }
  });
  return { brain, dir, dbPath, fc };
}

/**
 * 断言以指定错误码被拒（可选再断言 message 片段）。
 * 门面里有同步校验（requireString/requireEnum），必须用 async 包一层才捕得到。
 * @param {() => unknown} fn
 * @param {string} code
 * @param {RegExp} [pattern]
 */
async function rejectsAs(fn, code, pattern) {
  await assert.rejects(
    async () => {
      await fn();
    },
    (err) => {
      assert.equal(err.code, code, `错误码应为 ${code}，实际 ${err.code}：${err.message}`);
      if (pattern) assert.match(String(err.message), pattern);
      return true;
    },
  );
}

/**
 * 本库里所有 kind 修正审计（按 ts 正序）。
 * @param {import('node:sqlite').DatabaseSync} db
 */
function kindAudits(db) {
  return /** @type {any[]} */ (
    db.prepare("SELECT * FROM audit_logs WHERE action = 'entities.updateKind' ORDER BY ts ASC, rowid ASC").all()
  );
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} table */
function countRows(db, table) {
  return Number(/** @type {{ n: number }} */ (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n);
}

// ===========================================================================
// 1. 正常改
// ===========================================================================

test('1. updateKind 正常改：person → other，返回字段完整，updated_at 前进，其余字段不动', async (t) => {
  const { brain, fc } = createBrain(t);
  const created = await brain.entities.upsert({
    name: 'context2',
    kind: 'person',
    aliases: ['ctx2'],
    importance: 0.7,
    sourceSystem: 'engram',
    sourceRef: 'engram:user.db:entity:12',
  });
  const before = brain.entities.get(created.id);
  assert.equal(before.kind, 'person');

  const at = fc.advance(1000);
  const result = await brain.entities.updateKind(created.id, 'other', {
    changedBy: 'test-harness',
    reason: 'teammate 代号不是人',
  });

  assert.deepEqual(result, {
    id: created.id,
    name: 'context2',
    kind: 'other',
    previousKind: 'person',
    changed: true,
  });

  const after = brain.entities.get(created.id);
  assert.equal(after.kind, 'other', 'kind 必须真的落库');
  assert.equal(after.updatedAt, at, 'updated_at 必须被推进到本次写的时间');
  // 只改 kind：别的一律不动（一次修一个维度，审计才读得懂改了什么）
  assert.deepEqual(after.aliases, ['ctx2']);
  assert.equal(after.importance, 0.7);
  assert.equal(after.sourceSystem, 'engram');
  assert.equal(after.sourceRef, 'engram:user.db:entity:12');
  assert.equal(after.status, 'active');
  assert.equal(countRows(brain.db, 'entities'), 1, '不许产生第二行');
});

// ===========================================================================
// 2. 幂等（不产噪声）
// ===========================================================================

test('2. updateKind 幂等：同 kind 再传一次 changed=false，不写 updated_at、不落审计', async (t) => {
  const { brain, fc } = createBrain(t);
  const created = await brain.entities.upsert({ name: 'lead', kind: 'person' });

  const first = await brain.entities.updateKind(created.id, 'other');
  assert.equal(first.changed, true);
  const afterFirst = brain.entities.get(created.id);
  assert.equal(afterFirst.kind, 'other');
  assert.equal(kindAudits(brain.db).length, 1);

  fc.advance(5000);
  const second = await brain.entities.updateKind(created.id, 'other');
  assert.deepEqual(second, {
    id: created.id,
    name: 'lead',
    kind: 'other',
    previousKind: 'other',
    changed: false,
  });
  const afterSecond = brain.entities.get(created.id);
  // 幂等成功但从语义上「什么都没发生」：时间戳是被动过的证据，审计是第二条证据。
  assert.equal(afterSecond.updatedAt, afterFirst.updatedAt, 'changed=false 时不许碰 updated_at');
  assert.equal(kindAudits(brain.db).length, 1, 'changed=false 时不许落第二条审计（噪声审计比没审计更糟）');

  // 第三次也一样，连 updated_at 都不再动
  fc.advance(5000);
  const third = await brain.entities.updateKind(created.id, 'other');
  assert.equal(third.changed, false);
  assert.equal(brain.entities.get(created.id).updatedAt, afterFirst.updatedAt);
  assert.equal(kindAudits(brain.db).length, 1);
  assert.equal(countRows(brain.db, 'entities'), 1);
});

// ===========================================================================
// 3. 非法 kind
// ===========================================================================

test('3. 非法 kind / 空 kind / 缺 kind：INVALID_ARGUMENT，kind 不变、不落审计', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.entities.upsert({ name: 'console2', kind: 'person' });

  await rejectsAs(() => brain.entities.updateKind(created.id, 'language'), 'INVALID_ARGUMENT', /kind/);
  await rejectsAs(() => brain.entities.updateKind(created.id, ''), 'INVALID_ARGUMENT', /kind/);
  await rejectsAs(() => brain.entities.updateKind(created.id, null), 'INVALID_ARGUMENT', /kind/);
  await rejectsAs(() => brain.entities.updateKind(created.id, 'PERSON'), 'INVALID_ARGUMENT', /kind/);

  assert.equal(brain.entities.get(created.id).kind, 'person', '被拒的写入不许改库');
  assert.equal(kindAudits(brain.db).length, 0, '被拒的写入不许留审计');
});

// ===========================================================================
// 4. 实体不存在
// ===========================================================================

test('4. 实体不存在 / id 非法：NOT_FOUND 与 INVALID_ARGUMENT 分清，不落审计', async (t) => {
  const { brain } = createBrain(t);
  await brain.entities.upsert({ name: '某实体', kind: 'other' });

  // 存在性判断：NOT_FOUND（查询语义）
  await rejectsAs(
    () => brain.entities.updateKind('ent_000000000000000000000000', 'tool'),
    'NOT_FOUND',
    /实体不存在/,
  );
  // 参数本身非法：INVALID_ARGUMENT（不是「不存在」）
  await rejectsAs(() => brain.entities.updateKind('', 'tool'), 'INVALID_ARGUMENT', /entityId/);
  await rejectsAs(() => brain.entities.updateKind('   ', 'tool'), 'INVALID_ARGUMENT', /entityId/);
  await rejectsAs(() => brain.entities.updateKind(123, 'tool'), 'INVALID_ARGUMENT', /entityId/);

  assert.equal(countRows(brain.db, 'entities'), 1);
  assert.equal(kindAudits(brain.db).length, 0);
});

// ===========================================================================
// 5. 已删实体
// ===========================================================================

test('5. 已删实体（status=deleted）：CONFLICT，kind 不变、不落审计', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.entities.upsert({ name: 'connector2', kind: 'person' });
  // 门面暂无实体删除接口：直接改状态模拟合并/删除（与 entities.test.mjs 的 6 号测试同口径）
  brain.db.prepare("UPDATE entities SET status = 'deleted' WHERE id = ?").run(created.id);

  await rejectsAs(
    () => brain.entities.updateKind(created.id, 'other'),
    'CONFLICT',
    /实体已删除/,
  );
  // 行里的 kind 一个字都没动
  const row = /** @type {{ kind: string }} */ (brain.db.prepare('SELECT kind FROM entities WHERE id = ?').get(created.id));
  assert.equal(row.kind, 'person');
  assert.equal(kindAudits(brain.db).length, 0);
});

// ===========================================================================
// 6. 跨 scope
// ===========================================================================

test('6. 跨 scope 收口：默认只改 caller scope；越界 NOT_FOUND（不确认存在性）；显式 scope 才动得了', async (t) => {
  const { brain } = createBrain(t);
  const mine = await brain.entities.upsert({ name: '共享名', kind: 'person', scopeId: SCOPE_A });
  const others = await brain.entities.upsert({ name: '共享名', kind: 'person', scopeId: SCOPE_B });

  // 默认 scope = owner-default：拿 owner-other 的 id 去改 → NOT_FOUND（与「不存在」同形）
  await rejectsAs(() => brain.entities.updateKind(others.id, 'other'), 'NOT_FOUND', /实体不存在/);
  // 不确认存在性：错误文案里不许出现「scope 不一致」这类泄底信息
  await assert.rejects(
    async () => {
      await brain.entities.updateKind(others.id, 'other');
    },
    (err) => {
      assert.doesNotMatch(String(err.message), /scope/i, '越界必须与「不存在」同形，文案不许泄底');
      return true;
    },
  );
  // 别的 scope 那一行确实没被改（不是「改了又回滚」这类巧合）。
  // 注意：M6.2 收口后 `entities.get` 也按 caller scope 过滤（CONTRACTS §16），
  // 所以这里必须显式声明 B 的上下文才读得到——测试意图（核对那一行没被动过）不变，
  // 只是读取方式跟着新口径走，不是放宽断言。
  assert.equal(brain.entities.get(others.id, { scopeId: SCOPE_B }).kind, 'person');

  // 显式 scopeId → 改得动自己 scope 的
  const okOwn = await brain.entities.updateKind(mine.id, 'other', { scopeId: SCOPE_A });
  assert.equal(okOwn.changed, true);
  assert.equal(brain.entities.get(mine.id).kind, 'other');

  // 显式 scopeId 指向别的 scope → 也能改（维护路径的正当用法）
  const okOther = await brain.entities.updateKind(others.id, 'tool', { scopeId: SCOPE_B });
  assert.equal(okOther.changed, true);
  assert.equal(brain.entities.get(others.id, { scopeId: SCOPE_B }).kind, 'tool');

  // allowCrossScope 只给内部维护路径：不给 scopeId 也能改任意 scope
  const okCross = await brain.entities.updateKind(others.id, 'concept', { allowCrossScope: true });
  assert.equal(okCross.changed, true);
  assert.equal(brain.entities.get(others.id, { scopeId: SCOPE_B }).kind, 'concept');

  // 两条审计分别记在自己的 scope 上
  const audits = kindAudits(brain.db);
  assert.equal(audits.length, 3);
  assert.deepEqual(audits.map((a) => String(a.scope_id)), [SCOPE_A, SCOPE_B, SCOPE_B]);
});

// ===========================================================================
// 7. 审计落痕
// ===========================================================================

test('7. 审计落痕：action/actor/target/scope/result/detail 全字段可反查', async (t) => {
  const { brain, fc } = createBrain(t);
  const created = await brain.entities.upsert({ name: 'lead', kind: 'person' });
  const at = fc.advance(1000);

  const result = await brain.entities.updateKind(created.id, 'other', {
    changedBy: 'tools/fix-entity-kinds.mjs',
    reason: 'teammate 代号不是人',
  });
  assert.equal(result.changed, true);

  const audits = kindAudits(brain.db);
  assert.equal(audits.length, 1, '一次真改落一条审计（不多不少）');
  const audit = audits[0];
  assert.match(String(audit.audit_id), /^aud_[0-9a-f]{24}$/);
  assert.equal(audit.action, 'entities.updateKind');
  assert.equal(audit.actor, 'tools/fix-entity-kinds.mjs', 'actor 必须记谁改的');
  assert.equal(audit.target_kind, 'entity');
  assert.equal(audit.target_id, created.id);
  assert.equal(audit.scope_id, SCOPE_A);
  assert.equal(audit.result, 'ok');
  assert.equal(audit.ts, at, '审计时间与本次写一致');
  assert.equal(audit.deletion_epoch, 0);

  const detail = JSON.parse(String(audit.detail));
  assert.deepEqual(detail, {
    entity_id: created.id,
    name: 'lead',
    previous_kind: 'person',
    kind: 'other',
    reason: 'teammate 代号不是人',
  });

  // detail 只放标识/原因，绝不放正文类内容（CONTRACTS：审计禁止放正文）——
  // 这条实体没有正文，用「没有意外字段」来守：字段集合必须正好是这五个。
  assert.deepEqual(Object.keys(detail).sort(), ['entity_id', 'kind', 'name', 'previous_kind', 'reason']);

  // 默认 actor / reason 也必须有值（不许留 null 的悬空审计）
  const second = await brain.entities.upsert({ name: 'context2', kind: 'person' });
  await brain.entities.updateKind(second.id, 'other');
  const defaulted = kindAudits(brain.db)[1];
  assert.equal(JSON.parse(String(defaulted.detail)).reason, 'update_kind', '缺省 reason 要写明，别留空');
  assert.equal(defaulted.actor, 'entities.updateKind', '缺省 actor 要能看出是门面默认路径');
});
