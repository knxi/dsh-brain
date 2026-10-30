// @ts-check
/**
 * M6：实体（entities / memory_entities）与记忆关系（memory_edges）。
 *
 * 覆盖任务书里的 14 类必测项，每条一个 test，期望值**手算写死**：
 *  1. 迁移版本 0006 / 三张表 / 可回滚               → test 1、1b、1c
 *  2. upsert 幂等（created/id/单行）                → test 2
 *  3. 合并规则四条（kind/aliases/importance/出处）   → test 3
 *  4. 名字规范化                                   → test 4
 *  5. 非法输入（name/kind/importance）              → test 5a、5b
 *  6. linkMemory 全分支                            → test 6
 *  7. unlinkMemory                                → test 7
 *  8. forMemory / memoriesFor                      → test 8
 *  9. resolve 四条路径                             → test 9
 * 10. list 过滤/搜索/merged/limit/排序             → test 10
 * 11. memoryEdges.link 全分支                     → test 11
 * 12. memoryEdges.forMemory 出边/入边/删对端       → test 12
 * 13. conflicts 只含 contradicts + remove         → test 13
 * 14. 删除过滤（重点）                             → test 14
 * 附加边界：跨 scope 隔离、别名上限/脏别名、role 落库 → test 15、16
 * 跨 scope 写入被拒（2026-10-28 修复的 B/C）         → test 17
 *
 * 2026-10-28 收紧（实现改完后的新口径，下面都已锁住）：
 * - `entities.stats()` 删掉 `unlinked`（它与 `orphan` 恒等），只返回 total/byKind/linked/orphan；
 * - `memoryEdges.forMemory(已删或不存在 id)` 返回 `{ out: [], in: [] }`（已删记忆没有关系视图）；
 * - `linkMemory` / `memoryEdges.link` 跨 scope 一律抛 CONFLICT，且不许半写。
 * 除这三处外，其余断言与 2026-10-28 首版一致，没有放宽。
 *
 * 纪律：
 * - 只用 node:test + node:assert/strict，全部在 mkdtemp 临时主账里跑，不碰 data/brain.db。
 * - 不 import apps/ 下任何东西（host 插件要 DSH 环境）。
 * - 失败先怀疑测试自己的期望值；确认是实现问题时只写报告，不改 packages/ 与 migrations/。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../../packages/core/src/index.js';
import {
  applyMigrations,
  getCurrentVersion,
  listMigrations,
  openBrain,
  openDatabase,
  rollbackLastMigration,
} from '../../../packages/memory/src/index.js';
import { loadMigrations } from '../../../packages/memory/src/migrator.js';

/** 仓库内 migrations 目录（<repo>/migrations/）。 */
const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

/** 与 openBrain 的默认 bindings 对齐（CONTRACTS §2）。 */
const SCOPE_A = 'owner-default';
const SCOPE_B = 'owner-other';

/** M6 的三张表。 */
const ENTITY_TABLES = Object.freeze(['entities', 'memory_entities', 'memory_edges']);

/**
 * 可推进的固定时钟：断言 created_at 排序时才有确定性。
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
function createBrain(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m6-'));
  const dbPath = path.join(dir, 'brain.db');
  const fc = fixedClock();
  const brain = openBrain({ dbPath, migrationsDir: MIGRATIONS_DIR, clock: fc.clock });
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
 * 一条带默认值的记忆 draft（测试里只写关心的字段）。
 * @param {Record<string, unknown>} overrides
 */
function draft(overrides) {
  return {
    layer: 'long',
    type: 'semantic',
    content: '占位内容',
    summary: '占位摘要',
    sourceType: 'owner_words',
    sourceIds: [],
    privacy: 'private',
    originSystem: 'dsh',
    producer: 'test-harness',
    ...overrides,
  };
}

/** @param {import('node:sqlite').DatabaseSync} db */
function tableNames(db) {
  return /** @type {Array<{ name: string }>} */ (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
  ).map((row) => row.name);
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} table */
function countRows(db, table) {
  return Number(/** @type {{ n: number }} */ (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n);
}

/**
 * 断言以指定错误码被拒（可选再断言 message 片段）。
 * 用 `async () => { await fn(); }` 包一层：门面里有同步校验（如 requireString），
 * 直接传 `() => 同步调用()` 给 assert.rejects 会在参数求值时就抛出、不被捕获。
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

// ===========================================================================
// 1. 迁移
// ===========================================================================

test('1. 迁移 0006：schemaVersion 跟随磁盘最后一版、三张表与唯一索引都在，门面挂到 openBrain', async (t) => {
  const { brain } = createBrain(t);

  // 动态契约：schemaVersion 必须等于磁盘最后一版。
  // **不再写死 '0006'**（2026-10-31 加 0007_m7_fox_mood 之后那行就是错的）：
  // M6 真正要守的是「这三张表在最新 schema 下存在」，版本号本身由迁移目录决定
  // ——照 CONTRACTS 13.4 第 3 条（任何写死 schemaVersion 的地方都是下一版迁移的债）。
  const diskVersions = loadMigrations(MIGRATIONS_DIR).map((file) => file.version);
  assert.equal(brain.schemaVersion, diskVersions[diskVersions.length - 1], 'schemaVersion 必须等于磁盘上最后一版迁移');
  assert.ok(diskVersions.includes('0006'), '磁盘上必须有 0006_m6_entities.sql');

  const tables = tableNames(brain.db);
  assert.deepEqual(
    ENTITY_TABLES.filter((name) => tables.includes(name)).sort(),
    ['entities', 'memory_edges', 'memory_entities'],
    'M6 三张表必须都建出来',
  );

  // 幂等靠这两条 UNIQUE 索引兜底，不能只靠门面逻辑。
  const indexes = /** @type {Array<{ name: string }>} */ (
    brain.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('ux_entities_scope_name', 'ux_memory_edges_triple') ORDER BY name",
      )
      .all()
  ).map((row) => row.name);
  assert.deepEqual(indexes, ['ux_entities_scope_name', 'ux_memory_edges_triple']);

  assert.equal(typeof brain.entities.upsert, 'function');
  assert.equal(typeof brain.entities.resolve, 'function');
  assert.equal(typeof brain.memoryEdges.link, 'function');
  assert.equal(typeof brain.memoryEdges.conflicts, 'function');
});

test('1b. 0006 可回滚：三张表消失、0001/0002 的表还在、再 apply 能重建', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m6-mig-'));
  const opened = openDatabase({ path: path.join(dir, 'brain.db') });
  t.after(() => {
    try {
      opened.db.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  const fc = fixedClock();
  const versions = loadMigrations(MIGRATIONS_DIR).map((file) => file.version);
  assert.ok(versions.includes('0006'), '磁盘上必须有 0006_m6_entities.sql');
  // 0006 之后可能还有更新的迁移（0007 是 M7.2 的情感状态）。这条测试要问的是
  // 「0006 这一版能不能干净回滚」，所以先把更新的版本逐版回滚掉，再回滚 0006。
  // 不写死「最后一版就是 0006」——那是下一版迁移的债（CONTRACTS 13.4 第 2 条同一处理）。
  const newerVersions = versions.filter((version) => Number(version) > Number('0006')).reverse();
  const previous = versions[versions.indexOf('0006') - 1];
  assert.equal(previous, '0005');

  const first = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.equal(first.currentVersion, versions[versions.length - 1]);

  for (const version of newerVersions) {
    const rolledNewer = rollbackLastMigration(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
    assert.equal(rolledNewer.rolledBack, version, '先把 0006 之后的版本逐版回滚掉');
  }
  const rolled = rollbackLastMigration(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.equal(rolled.rolledBack, '0006');
  assert.equal(rolled.currentVersion, previous);
  assert.equal(getCurrentVersion(opened.db), '0005');

  const afterRollback = tableNames(opened.db);
  for (const name of ENTITY_TABLES) {
    assert.ok(!afterRollback.includes(name), `回滚 0006 后 ${name} 必须消失`);
  }
  // 0001/0002/0003/0005 的表必须还在（回滚 0006 不许连带更早的）。
  for (const name of ['events', 'memories', 'source_refs', 'search_fts_char', 'search_ngram', 'blobs', 'context_packages']) {
    assert.ok(afterRollback.includes(name), `回滚 0006 不该动到 ${name}`);
  }
  // 回滚留痕：direction 记 down，不删行。
  const rows = listMigrations(opened.db);
  assert.equal(rows.find((row) => row.version === '0006')?.direction, 'down');
  assert.equal(rows.find((row) => row.version === '0005')?.direction, 'up');

  const again = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.deepEqual(again.applied, ['0006', ...newerVersions.slice().reverse()], '重建 0006 及其后的版本');
  assert.equal(again.currentVersion, versions[versions.length - 1]);
  const rebuilt = tableNames(opened.db);
  for (const name of ENTITY_TABLES) {
    assert.ok(rebuilt.includes(name), `重新 apply 后 ${name} 必须回来`);
  }
});

test('1c. SQL 层护栏：唯一约束与自环 CHECK 不靠门面把关', async (t) => {
  const { brain } = createBrain(t);
  const m1 = await brain.memories.create(draft({ content: '记忆一' }));
  const m2 = await brain.memories.create(draft({ content: '记忆二' }));
  const e1 = await brain.entities.upsert({ name: 'React', kind: 'tool' });

  // entities：(scope_id, name) 唯一 —— 同名第二行插不进去。
  assert.throws(
    () =>
      brain.db
        .prepare(
          `INSERT INTO entities (id, scope_id, name, created_at, created_at_local, updated_at, updated_at_local)
           VALUES ('ent_dup_000000000000000000', ?, 'React', 'x', 'x', 'x', 'x')`,
        )
        .run(SCOPE_A),
    /UNIQUE constraint failed: entities/,
  );

  // memory_entities：主键 (memory_id, entity_id)
  assert.deepEqual(await brain.entities.linkMemory(m1.id, e1.id), { linked: true });
  assert.throws(
    () =>
      brain.db
        .prepare(
          `INSERT INTO memory_entities (memory_id, entity_id, role, created_at, created_at_local)
           VALUES (?, ?, NULL, 'x', 'x')`,
        )
        .run(m1.id, e1.id),
    /UNIQUE constraint failed: memory_entities/,
  );

  // memory_edges：唯一三元组
  await brain.memoryEdges.link({ fromMemoryId: m1.id, toMemoryId: m2.id, kind: 'supports' });
  assert.throws(
    () =>
      brain.db
        .prepare(
          `INSERT INTO memory_edges (id, scope_id, from_memory_id, to_memory_id, kind, created_at, created_at_local)
           VALUES ('edge_dup_00000000000000000', ?, ?, ?, 'supports', 'x', 'x')`,
        )
        .run(SCOPE_A, m1.id, m2.id),
    /UNIQUE constraint failed: memory_edges/,
  );

  // memory_edges：自环 CHECK（门面也拦，但约束必须自己兜底）
  assert.throws(
    () =>
      brain.db
        .prepare(
          `INSERT INTO memory_edges (id, scope_id, from_memory_id, to_memory_id, kind, created_at, created_at_local)
           VALUES ('edge_self_0000000000000000', ?, ?, ?, 'contradicts', 'x', 'x')`,
        )
        .run(SCOPE_A, m1.id, m1.id),
    /CHECK constraint failed: from_memory_id <> to_memory_id/,
  );
});

// ===========================================================================
// 2. upsert：新建 / 幂等
// ===========================================================================

test('2. upsert 幂等：首次 created=true；同名再写 created=false、id 相同、不产生第二行', async (t) => {
  const { brain } = createBrain(t);

  const first = await brain.entities.upsert({ name: 'Cloudflare Workers', kind: 'tool' });
  assert.match(first.id, /^ent_[0-9a-f]{24}$/);
  assert.equal(first.created, true);
  assert.equal(first.updated, false);
  assert.equal(first.name, 'Cloudflare Workers');
  assert.equal(first.kind, 'tool');

  const second = await brain.entities.upsert({ name: 'Cloudflare Workers', kind: 'tool' });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(second.updated, false, '完全相同的第二次写入不该标 updated');
  assert.equal(countRows(brain.db, 'entities'), 1, '同名同 scope 只许一行');

  const reread = brain.entities.get(first.id);
  assert.equal(reread.name, 'Cloudflare Workers');
  assert.equal(reread.status, 'active');
  assert.equal(reread.memoryCount, 0);
});

// ===========================================================================
// 3. 合并规则四条
// ===========================================================================

test('3. 合并规则：kind 不降级、aliases 并集去重、importance 取大、出处保留首次', async (t) => {
  const { brain } = createBrain(t);

  const first = await brain.entities.upsert({
    name: 'Cloudflare Workers',
    kind: 'tool',
    aliases: ['Workers'],
    importance: 0.6,
    sourceSystem: 'engram',
    sourceRef: 'engram:user.db:entity:7',
  });
  assert.equal(first.created, true);

  // 第二次带更低的 kind（other）、更低的重要度、不同的出处、新别名。
  const second = await brain.entities.upsert({
    name: 'Cloudflare Workers',
    kind: 'other',
    aliases: ['CF Workers', 'Workers'],
    importance: 0.3,
    sourceSystem: 'dsh',
    sourceRef: 'dsh:manual:1',
  });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.equal(second.updated, true, '别名/重要度有变化时必须标 updated');

  const merged = brain.entities.get(first.id);
  // 规则 1：kind 不降级 —— 已有 tool，遇到 other 保持 tool。
  assert.equal(merged.kind, 'tool');
  // 规则 2：aliases 取并集并去重（旧顺序在前，'Workers' 重复被折叠）。
  assert.deepEqual(merged.aliases, ['Workers', 'CF Workers']);
  // 规则 3：importance 取较大值。
  assert.equal(merged.importance, 0.6);
  // 规则 4：sourceSystem/sourceRef 保留首次出处，不被后来的 dsh 覆盖。
  assert.equal(merged.sourceSystem, 'engram');
  assert.equal(merged.sourceRef, 'engram:user.db:entity:7');

  // importance 可以往上升（0.9 > 0.6）。
  const third = await brain.entities.upsert({ name: 'Cloudflare Workers', importance: 0.9 });
  assert.equal(third.updated, true);
  assert.equal(brain.entities.get(first.id).importance, 0.9);
  // kind 仍不被默认的 other 打回。
  assert.equal(brain.entities.get(first.id).kind, 'tool');

  // kind 从 other 可以升级为具体类型（另一条方向）。
  const up = await brain.entities.upsert({ name: 'Remotion', kind: 'other' });
  assert.equal(up.kind, 'other');
  await brain.entities.upsert({ name: 'Remotion', kind: 'tool' });
  assert.equal(brain.entities.get(up.id).kind, 'tool');

  // 两个具体类型冲突时保留首次的（没有优先级表，不擅自改判）。
  const person = await brain.entities.upsert({ name: '主人', kind: 'person' });
  await brain.entities.upsert({ name: '主人', kind: 'tool' });
  assert.equal(brain.entities.get(person.id).kind, 'person');

  // 出处为空时可补；补上后不再被别的来源覆盖。
  const noSource = await brain.entities.upsert({ name: 'DSH', kind: 'project' });
  assert.equal(brain.entities.get(noSource.id).sourceSystem, null);
  await brain.entities.upsert({ name: 'DSH', sourceSystem: 'engram', sourceRef: 'engram:x:1' });
  assert.equal(brain.entities.get(noSource.id).sourceSystem, 'engram');
  assert.equal(brain.entities.get(noSource.id).sourceRef, 'engram:x:1');
  await brain.entities.upsert({ name: 'DSH', sourceSystem: 'dsh', sourceRef: 'dsh:y' });
  assert.equal(brain.entities.get(noSource.id).sourceSystem, 'engram', '首次出处不许被后来的覆盖');
});

// ===========================================================================
// 4. 名字规范化
// ===========================================================================

test('4. 名字规范化：首尾与连续空白被压掉，大小写不折叠', async (t) => {
  const { brain } = createBrain(t);

  const spaced = await brain.entities.upsert({ name: '  a  b  ' });
  assert.equal(spaced.name, 'a b', '返回的规范化名字应为 a b');
  assert.equal(spaced.created, true);

  // 'a b' 与 '  a  b  ' 必须是同一实体。
  const plain = await brain.entities.upsert({ name: 'a b' });
  assert.equal(plain.created, false);
  assert.equal(plain.id, spaced.id);

  // tab / 换行也一起压成单空格。
  const tabbed = await brain.entities.upsert({ name: 'a\t\n b' });
  assert.equal(tabbed.id, spaced.id);
  assert.equal(countRows(brain.db, 'entities'), 1, '规范化后同名的只许一行');

  // 不做大小写折叠：'A b' 是另一个实体（注释里说清了这是刻意为之）。
  const upper = await brain.entities.upsert({ name: 'A b' });
  assert.equal(upper.created, true);
  assert.notEqual(upper.id, spaced.id);
  assert.equal(countRows(brain.db, 'entities'), 2);
});

// ===========================================================================
// 5. 非法输入
// ===========================================================================

test('5a. 非法 name：空串 / 纯空白 / 缺省 / 非字符串 / 超 80 字都被拒且不落库', async (t) => {
  const { brain } = createBrain(t);

  await rejectsAs(() => brain.entities.upsert({ name: '' }), 'INVALID_ARGUMENT');
  await rejectsAs(() => brain.entities.upsert({ name: '   ' }), 'INVALID_ARGUMENT');
  await rejectsAs(() => brain.entities.upsert({ name: '\t\n' }), 'INVALID_ARGUMENT');
  await rejectsAs(() => brain.entities.upsert({}), 'INVALID_ARGUMENT');
  await rejectsAs(() => brain.entities.upsert({ name: 123 }), 'INVALID_ARGUMENT');
  await rejectsAs(() => brain.entities.upsert({ name: 'x'.repeat(81) }), 'INVALID_ARGUMENT', /太长/);
  assert.equal(countRows(brain.db, 'entities'), 0, '被拒的写入不许落库');

  // 边界：正好 80 字合法。
  const boundary = await brain.entities.upsert({ name: 'x'.repeat(80) });
  assert.equal(boundary.created, true);
  assert.equal(boundary.name.length, 80);
});

test('5b. 非法 kind / 越界 importance 被拒；0 与 1 是合法边界，缺省 importance=0.5', async (t) => {
  const { brain } = createBrain(t);

  await rejectsAs(() => brain.entities.upsert({ name: 'Q', kind: 'language' }), 'INVALID_ARGUMENT', /kind/);
  await rejectsAs(() => brain.entities.upsert({ name: 'Q', kind: '' }), 'INVALID_ARGUMENT', /kind/);
  await rejectsAs(() => brain.entities.upsert({ name: 'Q', importance: 1.5 }), 'INVALID_ARGUMENT', /importance/);
  await rejectsAs(() => brain.entities.upsert({ name: 'Q', importance: -0.1 }), 'INVALID_ARGUMENT', /importance/);
  assert.equal(countRows(brain.db, 'entities'), 0);

  // 边界合法：0 与 1
  const low = await brain.entities.upsert({ name: '低重要度', importance: 0 });
  assert.equal(brain.entities.get(low.id).importance, 0);
  const high = await brain.entities.upsert({ name: '高重要度', importance: 1 });
  assert.equal(brain.entities.get(high.id).importance, 1);
  // 缺省值 0.5
  const def = await brain.entities.upsert({ name: '默认重要度' });
  assert.equal(brain.entities.get(def.id).importance, 0.5);
  // 缺省 kind = other
  assert.equal(brain.entities.get(def.id).kind, 'other');
});

// ===========================================================================
// 6. linkMemory
// ===========================================================================

test('6. linkMemory：首次 true / 重复 false / 记忆不存在 NOT_FOUND / 已删记忆 CONFLICT / 实体不存在 NOT_FOUND', async (t) => {
  const { brain } = createBrain(t);
  const m1 = await brain.memories.create(draft({ content: '记忆一' }));
  const m2 = await brain.memories.create(draft({ content: '记忆二' }));
  const e1 = await brain.entities.upsert({ name: 'DSH', kind: 'tool' });

  assert.deepEqual(await brain.entities.linkMemory(m1.id, e1.id), { linked: true });
  assert.deepEqual(await brain.entities.linkMemory(m1.id, e1.id), { linked: false }, '重复挂同一对必须幂等');
  assert.equal(countRows(brain.db, 'memory_entities'), 1);

  // 记忆不存在
  await rejectsAs(
    () => brain.entities.linkMemory('mem_000000000000000000000000', e1.id),
    'NOT_FOUND',
    /记忆不存在/,
  );
  // 实体不存在
  await rejectsAs(
    () => brain.entities.linkMemory(m2.id, 'ent_000000000000000000000000'),
    'NOT_FOUND',
    /实体不存在/,
  );

  // 已删记忆 → CONFLICT（不许让删掉的东西从旁边漏回来）
  await brain.memories.update(m2.id, { status: 'deleted' }, { expectedVersion: 1 });
  await rejectsAs(() => brain.entities.linkMemory(m2.id, e1.id), 'CONFLICT', /已删除/);

  // 已删实体 → CONFLICT（门面暂无实体删除接口，直接改状态模拟后期合并/删除）
  brain.db.prepare("UPDATE entities SET status = 'deleted' WHERE id = ?").run(e1.id);
  await rejectsAs(() => brain.entities.linkMemory(m1.id, e1.id), 'CONFLICT', /实体已删除/);
  assert.equal(countRows(brain.db, 'memory_entities'), 1, '被拒的关联不许落库');
});

// ===========================================================================
// 7. unlinkMemory
// ===========================================================================

test('7. unlinkMemory：有则 removed=true，再删 removed=false；不存在的对返回 false 不抛', async (t) => {
  const { brain } = createBrain(t);
  const m1 = await brain.memories.create(draft({ content: '记忆一' }));
  const e1 = await brain.entities.upsert({ name: 'DSH', kind: 'tool' });
  const e2 = await brain.entities.upsert({ name: 'Remotion', kind: 'tool' });

  await brain.entities.linkMemory(m1.id, e1.id);
  assert.deepEqual(await brain.entities.unlinkMemory(m1.id, e1.id), { removed: true });
  assert.equal(countRows(brain.db, 'memory_entities'), 0);
  assert.deepEqual(await brain.entities.unlinkMemory(m1.id, e1.id), { removed: false });
  // 从未挂过的对：false 而不是抛
  assert.deepEqual(await brain.entities.unlinkMemory(m1.id, e2.id), { removed: false });
});

// ===========================================================================
// 8. forMemory / memoriesFor
// ===========================================================================

test('8. forMemory：记忆→实体按 importance DESC；memoriesFor：实体→未删记忆', async (t) => {
  const { brain } = createBrain(t);
  const m1 = await brain.memories.create(draft({ content: '记忆一', summary: '记忆一', importance: 0.9 }));
  const m2 = await brain.memories.create(draft({ content: '记忆二', summary: '记忆二', importance: 0.3 }));
  const m3 = await brain.memories.create(draft({ content: '记忆三', summary: '记忆三', importance: 0.5 }));

  const eTool = await brain.entities.upsert({ name: 'DSH', kind: 'tool', importance: 0.9 });
  const eProj = await brain.entities.upsert({ name: 'Remotion', kind: 'project', importance: 0.5 });
  const ePerson = await brain.entities.upsert({ name: '主人', kind: 'person', importance: 0.7 });
  const eOrphan = await brain.entities.upsert({ name: '孤立概念', kind: 'concept', importance: 0.3 });

  await brain.entities.linkMemory(m1.id, eTool.id);
  await brain.entities.linkMemory(m1.id, eProj.id);
  await brain.entities.linkMemory(m2.id, ePerson.id);
  await brain.entities.linkMemory(m3.id, eTool.id);

  // 手算：m1 挂 DSH(0.9) + Remotion(0.5) → importance DESC
  assert.deepEqual(brain.entities.forMemory(m1.id).map((e) => e.name), ['DSH', 'Remotion']);
  assert.deepEqual(brain.entities.forMemory(m2.id).map((e) => e.name), ['主人']);
  assert.deepEqual(brain.entities.forMemory(m3.id).map((e) => e.name), ['DSH']);
  // 只想拿字段时也保真
  assert.equal(brain.entities.forMemory(m1.id)[0].kind, 'tool');
  assert.equal(brain.entities.forMemory(m1.id)[0].importance, 0.9);
  assert.deepEqual(brain.entities.forMemory(m1.id)[0].aliases, []);

  // memoriesFor：DSH 名下 m1(0.9) 与 m3(0.5) → importance DESC
  const forTool = brain.entities.memoriesFor(eTool.id);
  assert.deepEqual(forTool.map((row) => row.memoryId), [m1.id, m3.id]);
  assert.equal(forTool[0].summary, '记忆一');
  assert.equal(forTool[0].importance, 0.9);
  assert.equal(forTool[0].status, 'active');
  assert.equal(forTool[0].type, 'semantic');
  assert.equal(forTool[0].layer, 'long');
  // 没有记忆的实体 → 空数组（不是 null）
  assert.deepEqual(brain.entities.memoriesFor(eOrphan.id), []);
  // limit 生效：只要第一条
  assert.deepEqual(brain.entities.memoriesFor(eTool.id, { limit: 1 }).map((row) => row.memoryId), [m1.id]);

  // stats 手算：4 个实体里 3 个挂着未删记忆（DSH / Remotion / 主人），孤立概念没人挂。
  const entityStats = brain.entities.stats();
  assert.deepEqual(entityStats, {
    total: 4,
    byKind: { tool: 1, project: 1, person: 1, concept: 1 },
    linked: 3,
    orphan: 1,
  });
  // 2026-10-28 收紧：unlinked 与 orphan 恒等，已从接口删掉，别再加回来。
  assert.equal('unlinked' in entityStats, false, 'stats 不该再有 unlinked（与 orphan 是同一件事）');
});

// ===========================================================================
// 9. resolve
// ===========================================================================

test('9. resolve：精确名 → 别名 → 模糊；候选不唯一时 ambiguous=true 且 entity=null', async (t) => {
  const { brain } = createBrain(t);
  const cfw = await brain.entities.upsert({ name: 'Cloudflare Workers', kind: 'tool', aliases: ['CF Workers', 'Workers'] });
  await brain.entities.upsert({ name: 'Cloudflare Pages', kind: 'tool' });
  const rmx = await brain.entities.upsert({ name: 'Remotion', kind: 'tool', aliases: ['Remotion 视频'] });
  const underscore = await brain.entities.upsert({ name: 'a_b', kind: 'other' });

  // 精确名
  const exact = brain.entities.resolve('Remotion');
  assert.equal(exact.entity?.id, rmx.id);
  assert.equal(exact.ambiguous, false);
  assert.equal(exact.candidates.length, 1);

  // 别名命中（精确层之后的第一层）
  const byAlias = brain.entities.resolve('CF Workers');
  assert.equal(byAlias.entity?.id, cfw.id);
  assert.equal(byAlias.ambiguous, false);

  // 模糊候选不唯一：两个 Cloudflare 实体 → 不替人挑
  const fuzzy = brain.entities.resolve('Cloudflare');
  assert.equal(fuzzy.ambiguous, true);
  assert.equal(fuzzy.entity, null, '模糊候选不唯一时必须返回 null，不许替人挑一个最像的');
  assert.deepEqual(fuzzy.candidates.map((e) => e.name).sort(), ['Cloudflare Pages', 'Cloudflare Workers']);

  // 完全没命中：entity=null 且 ambiguous=false（这是「没有」，不是「有歧义」）
  const none = brain.entities.resolve('Vue');
  assert.equal(none.entity, null);
  assert.equal(none.ambiguous, false);
  assert.deepEqual(none.candidates, []);

  // 转义：名字里的 _ 不许被当成 LIKE 通配（'a%b' 不该命中 'a_b'）
  assert.equal(brain.entities.resolve('a_b').entity?.id, underscore.id);
  assert.equal(brain.entities.resolve('a%b').entity, null);

  // 口径记录：精确名层大小写敏感，模糊 LIKE 层对 ASCII 大小写不敏感，
  // 所以全小写也能靠模糊层命中（见报告「口径可疑点」）。
  assert.equal(brain.entities.resolve('cloudflare workers').entity?.id, cfw.id);

  // 口径记录：纯空白在 requireString 就被拒；源码里那个「不可能走到」的分支已删。
  await rejectsAs(
    () => {
      brain.entities.resolve('   ');
    },
    'INVALID_ARGUMENT',
  );
});

// ===========================================================================
// 10. list
// ===========================================================================

test('10. list：kind 过滤 / query 搜名字与别名 / includeMerged 默认排除 / limit / 排序', async (t) => {
  const { brain } = createBrain(t);
  const m1 = await brain.memories.create(draft({ content: '记忆一', summary: '记忆一' }));
  const m2 = await brain.memories.create(draft({ content: '记忆二', summary: '记忆二' }));

  const dsh = await brain.entities.upsert({ name: 'DSH', kind: 'project', importance: 0.9, aliases: ['deepseek harness'] });
  const cfw = await brain.entities.upsert({ name: 'Cloudflare Workers', kind: 'tool', importance: 0.8, aliases: ['Workers'] });
  await brain.entities.upsert({ name: 'Cloudflare Pages', kind: 'project', importance: 0.6 });
  await brain.entities.upsert({ name: 'Remotion', kind: 'tool', importance: 0.4, aliases: ['Remotion 视频', 'remotion-cli'] });
  const merged = await brain.entities.upsert({ name: '已合并实体', kind: 'concept', importance: 0.2 });

  await brain.entities.linkMemory(m1.id, dsh.id);
  await brain.entities.linkMemory(m2.id, dsh.id);
  await brain.entities.linkMemory(m1.id, cfw.id);

  // 门面暂无 merge 接口：直接改状态模拟「同义实体后期收敛」。
  brain.db
    .prepare("UPDATE entities SET status = 'merged', merged_into = ? WHERE id = ?")
    .run(dsh.id, merged.id);

  // 默认：排除 merged；排序 memory_count DESC → importance DESC → name ASC
  const byDefault = brain.entities.list();
  assert.deepEqual(byDefault.items.map((e) => e.name), ['DSH', 'Cloudflare Workers', 'Cloudflare Pages', 'Remotion']);
  assert.deepEqual(byDefault.items.map((e) => e.memoryCount), [2, 1, 0, 0]);
  assert.equal(byDefault.limit, 200, '默认 limit 应为 200');

  // kind 过滤
  assert.deepEqual(brain.entities.list({ kind: 'tool' }).items.map((e) => e.name), ['Cloudflare Workers', 'Remotion']);
  assert.deepEqual(brain.entities.list({ kind: 'project' }).items.map((e) => e.name), ['DSH', 'Cloudflare Pages']);
  // 非法 kind 拒绝（不是静默返回空）
  await rejectsAs(
    () => {
      brain.entities.list({ kind: 'bogus' });
    },
    'INVALID_ARGUMENT',
    /kind/,
  );

  // query：名字 / 别名都搜
  assert.deepEqual(brain.entities.list({ query: '视频' }).items.map((e) => e.name), ['Remotion'], '别名必须能搜到');
  assert.deepEqual(brain.entities.list({ query: 'Workers' }).items.map((e) => e.name), ['Cloudflare Workers']);
  assert.deepEqual(brain.entities.list({ query: 'deepseek' }).items.map((e) => e.name), ['DSH'], '别名（英文）必须能搜到');

  // includeMerged 默认排除，显式 true 才带出来
  assert.equal(brain.entities.list({ includeMerged: true }).items.length, 5);
  assert.deepEqual(
    brain.entities.list({ includeMerged: true }).items.map((e) => e.name).sort(),
    ['Cloudflare Pages', 'Cloudflare Workers', 'DSH', 'Remotion', '已合并实体'].sort(),
  );

  // limit 生效
  const limited = brain.entities.list({ limit: 2 });
  assert.equal(limited.items.length, 2);
  assert.equal(limited.limit, 2);
  assert.deepEqual(limited.items.map((e) => e.name), ['DSH', 'Cloudflare Workers']);
});

// ===========================================================================
// 11. memoryEdges.link
// ===========================================================================

test('11. memoryEdges.link：首次 created / 重复同 id / 自环拒 / kind 非法拒 / 不存在 NOT_FOUND / 已删 CONFLICT', async (t) => {
  const { brain } = createBrain(t);
  const m1 = await brain.memories.create(draft({ content: '甲', summary: '甲' }));
  const m2 = await brain.memories.create(draft({ content: '乙', summary: '乙' }));
  const m3 = await brain.memories.create(draft({ content: '丙', summary: '丙' }));

  const first = await brain.memoryEdges.link({
    fromMemoryId: m1.id,
    toMemoryId: m2.id,
    kind: 'supersedes',
    reason: '新结论顶替旧结论',
  });
  assert.match(first.id, /^edge_[0-9a-f]{24}$/);
  assert.equal(first.created, true);

  const dup = await brain.memoryEdges.link({ fromMemoryId: m1.id, toMemoryId: m2.id, kind: 'supersedes' });
  assert.equal(dup.created, false);
  assert.equal(dup.id, first.id, '重复建边必须返回既有 id');

  // 同一对、不同 kind → 另一条边（contradicts 与 supersedes 语义不同）
  const contradiction = await brain.memoryEdges.link({ fromMemoryId: m1.id, toMemoryId: m2.id, kind: 'contradicts' });
  assert.equal(contradiction.created, true);
  assert.notEqual(contradiction.id, first.id);

  // 自环
  await rejectsAs(
    () => brain.memoryEdges.link({ fromMemoryId: m1.id, toMemoryId: m1.id, kind: 'supports' }),
    'INVALID_ARGUMENT',
    /自环/,
  );
  // kind 非法
  await rejectsAs(
    () => brain.memoryEdges.link({ fromMemoryId: m1.id, toMemoryId: m2.id, kind: 'likes' }),
    'INVALID_ARGUMENT',
    /kind/,
  );
  // 缺一端
  await rejectsAs(() => brain.memoryEdges.link({ fromMemoryId: m1.id, kind: 'supports' }), 'INVALID_ARGUMENT', /toMemoryId/);
  // 任一端记忆不存在
  await rejectsAs(
    () => brain.memoryEdges.link({ fromMemoryId: 'mem_000000000000000000000000', toMemoryId: m2.id, kind: 'supports' }),
    'NOT_FOUND',
    /fromMemoryId/,
  );
  await rejectsAs(
    () => brain.memoryEdges.link({ fromMemoryId: m1.id, toMemoryId: 'mem_000000000000000000000000', kind: 'supports' }),
    'NOT_FOUND',
    /toMemoryId/,
  );

  // reason 截断到 500 字（防脏数据把边表撑爆）
  const long = await brain.memoryEdges.link({
    fromMemoryId: m2.id,
    toMemoryId: m3.id,
    kind: 'supports',
    reason: 'r'.repeat(600),
  });
  const reasonRow = /** @type {{ reason: string }} */ (
    brain.db.prepare('SELECT reason FROM memory_edges WHERE id = ?').get(long.id)
  );
  assert.equal(reasonRow.reason.length, 500);

  assert.equal(countRows(brain.db, 'memory_edges'), 3);

  // 任一端已删 → CONFLICT
  await brain.memories.update(m2.id, { status: 'deleted' }, { expectedVersion: 1 });
  await rejectsAs(
    () => brain.memoryEdges.link({ fromMemoryId: m3.id, toMemoryId: m2.id, kind: 'refines' }),
    'CONFLICT',
    /已删除/,
  );
});

// ===========================================================================
// 12. memoryEdges.forMemory
// ===========================================================================

test('12. memoryEdges.forMemory：出边/入边分别正确，且只含未删对端', async (t) => {
  const { brain, fc } = createBrain(t);
  const m1 = await brain.memories.create(draft({ content: '甲', summary: '记忆一' }));
  const m2 = await brain.memories.create(draft({ content: '乙', summary: '记忆二' }));
  const m3 = await brain.memories.create(draft({ content: '丙', summary: '记忆三' }));
  const m4 = await brain.memories.create(draft({ content: '丁', summary: '记忆四', type: 'episode' }));

  // 甲 → 丁（出边，t0）
  await brain.memoryEdges.link({ fromMemoryId: m1.id, toMemoryId: m4.id, kind: 'refines' });
  fc.advance(1000);
  // 乙 → 甲（入边，t1）
  await brain.memoryEdges.link({ fromMemoryId: m2.id, toMemoryId: m1.id, kind: 'supersedes' });
  fc.advance(1000);
  // 丙 → 甲（入边，t2）
  await brain.memoryEdges.link({ fromMemoryId: m3.id, toMemoryId: m1.id, kind: 'supports' });

  const fm = brain.memoryEdges.forMemory(m1.id);
  assert.equal(fm.out.length, 1, '出边只有 甲→丁');
  assert.equal(fm.out[0].toMemoryId, m4.id);
  assert.equal(fm.out[0].peerSummary, '记忆四');
  assert.equal(fm.out[0].peerType, 'episode');
  assert.equal(fm.in.length, 2, '入边有 乙→甲 与 丙→甲');
  // created_at DESC：后建的 丙→甲 在前
  assert.deepEqual(fm.in.map((edge) => edge.fromMemoryId), [m3.id, m2.id]);
  assert.deepEqual(fm.in.map((edge) => edge.peerSummary), ['记忆三', '记忆二']);
  assert.deepEqual(fm.in.map((edge) => edge.kind), ['supports', 'supersedes']);

  // 对端 丁 被删 → 出边不再出现
  await brain.memories.update(m4.id, { status: 'deleted' }, { expectedVersion: 1 });
  const afterM4 = brain.memoryEdges.forMemory(m1.id);
  assert.equal(afterM4.out.length, 0, '已删对端的边不许出现在 forMemory.out');
  assert.equal(afterM4.in.length, 2);

  // 对端 丙 被删 → 入边只剩 乙→甲
  await brain.memories.update(m3.id, { status: 'deleted' }, { expectedVersion: 1 });
  const afterM3 = brain.memoryEdges.forMemory(m1.id);
  assert.equal(afterM3.in.length, 1);
  assert.equal(afterM3.in[0].fromMemoryId, m2.id);
  // 边行本身还在（软删不删派生结构，靠查询侧过滤）
  assert.equal(countRows(brain.db, 'memory_edges'), 3);
});

// ===========================================================================
// 13. conflicts / remove
// ===========================================================================

test('13. conflicts 只返回 contradicts；remove 后消失，重复 remove 返回 false', async (t) => {
  const { brain } = createBrain(t);
  const m1 = await brain.memories.create(draft({ content: '甲', summary: '甲' }));
  const m2 = await brain.memories.create(draft({ content: '乙', summary: '乙' }));
  const m3 = await brain.memories.create(draft({ content: '丙', summary: '丙' }));
  const m4 = await brain.memories.create(draft({ content: '丁', summary: '丁' }));

  const conflict = await brain.memoryEdges.link({ fromMemoryId: m1.id, toMemoryId: m2.id, kind: 'contradicts' });
  await brain.memoryEdges.link({ fromMemoryId: m2.id, toMemoryId: m3.id, kind: 'supersedes' });
  await brain.memoryEdges.link({ fromMemoryId: m3.id, toMemoryId: m4.id, kind: 'supports' });
  await brain.memoryEdges.link({ fromMemoryId: m4.id, toMemoryId: m1.id, kind: 'refines' });

  const conflicts = brain.memoryEdges.conflicts();
  assert.equal(conflicts.length, 1, '四类边里只有 contradicts 算冲突');
  assert.equal(conflicts[0].id, conflict.id);
  assert.equal(conflicts[0].kind, 'contradicts');
  assert.equal(conflicts[0].fromMemoryId, m1.id);
  assert.equal(conflicts[0].toMemoryId, m2.id);
  // conflicts 只是 list({kind:'contradicts'})，两条口径必须一致
  assert.deepEqual(brain.memoryEdges.list({ kind: 'contradicts' }).map((edge) => edge.id), [conflict.id]);

  const stats = brain.memoryEdges.stats();
  assert.equal(stats.total, 4);
  assert.deepEqual(stats.byKind, { contradicts: 1, supersedes: 1, supports: 1, refines: 1 });

  assert.deepEqual(await brain.memoryEdges.remove(conflict.id), { removed: true });
  assert.equal(brain.memoryEdges.conflicts().length, 0);
  assert.deepEqual(await brain.memoryEdges.remove(conflict.id), { removed: false });
  assert.equal(brain.memoryEdges.stats().total, 3);
});

// ===========================================================================
// 14. 删除过滤（重点）
// ===========================================================================

test('14. 删除过滤：status=deleted 的记忆不再出现在 conflicts/list/forMemory/memoriesFor/memoryCount/stats', async (t) => {
  const { brain } = createBrain(t);
  const m1 = await brain.memories.create(draft({ content: '甲', summary: '甲', importance: 0.6 }));
  const m2 = await brain.memories.create(draft({ content: '乙', summary: '乙', importance: 0.5 }));
  const m3 = await brain.memories.create(draft({ content: '丙', summary: '丙', importance: 0.8 }));

  const ex = await brain.entities.upsert({ name: '实体X', kind: 'tool', importance: 0.7 });
  const ey = await brain.entities.upsert({ name: '实体Y', kind: 'concept', importance: 0.4 });

  await brain.entities.linkMemory(m1.id, ex.id);
  await brain.entities.linkMemory(m3.id, ex.id);
  await brain.entities.linkMemory(m1.id, ey.id);
  // 甲参与三条边：甲→乙 contradicts、甲→丙 refines；丙→乙 supports 与甲无关
  await brain.memoryEdges.link({ fromMemoryId: m1.id, toMemoryId: m2.id, kind: 'contradicts' });
  await brain.memoryEdges.link({ fromMemoryId: m3.id, toMemoryId: m2.id, kind: 'supports' });
  await brain.memoryEdges.link({ fromMemoryId: m1.id, toMemoryId: m3.id, kind: 'refines' });

  // ---- 删之前的手算基线 ----
  assert.equal(brain.memoryEdges.conflicts().length, 1);
  assert.equal(brain.memoryEdges.list().length, 3);
  assert.deepEqual(brain.entities.memoriesFor(ex.id).map((row) => row.memoryId), [m3.id, m1.id], '0.8 > 0.6');
  assert.equal(brain.entities.get(ex.id).memoryCount, 2);
  assert.deepEqual(brain.entities.forMemory(m1.id).map((e) => e.name), ['实体X', '实体Y']);
  const baselineStats = brain.entities.stats();
  assert.deepEqual(baselineStats, { total: 2, byKind: { tool: 1, concept: 1 }, linked: 2, orphan: 0 });
  assert.equal('unlinked' in baselineStats, false, 'stats 不该再有 unlinked');

  // ---- 把「甲」改成 deleted（软删除：行还在，status 变） ----
  await brain.memories.update(m1.id, { status: 'deleted' }, { expectedVersion: 1 });

  // 1) conflicts：甲→乙 那条不在了（这是唯一一条 contradicts）
  assert.equal(brain.memoryEdges.conflicts().length, 0);

  // 2) edges.list：只剩 丙→乙 supports
  const edgesLeft = brain.memoryEdges.list();
  assert.equal(edgesLeft.length, 1);
  assert.equal(edgesLeft[0].fromMemoryId, m3.id);
  assert.equal(edgesLeft[0].toMemoryId, m2.id);
  assert.equal(edgesLeft[0].kind, 'supports');

  // 3) forMemory(乙)：入边只剩 丙→乙
  const fmB = brain.memoryEdges.forMemory(m2.id);
  assert.equal(fmB.out.length, 0);
  assert.deepEqual(fmB.in.map((edge) => edge.fromMemoryId), [m3.id]);
  assert.deepEqual(fmB.in.map((edge) => edge.peerSummary), ['丙']);

  // 4) forMemory(丙)：出边还在，入边（甲→丙）不该出现
  const fmC = brain.memoryEdges.forMemory(m3.id);
  assert.equal(fmC.out.length, 1);
  assert.equal(fmC.in.length, 0, '已删的甲→丙 不许出现在丙的入边里');

  // 4b) 已删记忆自己没有关系视图（2026-10-28 口径）：入参已删 → 空视图，不是报错。
  //     它已经不在任何搜索结果里，再返回它的边会让人以为它还活着。
  assert.deepEqual(
    brain.memoryEdges.forMemory(m1.id),
    { out: [], in: [] },
    '已删记忆的 forMemory 必须返回空视图',
  );
  // 完全不存在的 id 同样空视图（查询语义，不抛 NOT_FOUND）
  assert.deepEqual(brain.memoryEdges.forMemory('mem_000000000000000000000000'), { out: [], in: [] });
  // 但边本身还在：对端未删时仍能按自己的视角看到它（3 与 4 已断言：乙.in 有 丙→乙、丙.in 无 甲→丙）

  // 5) memoriesFor：实体X 只剩丙；实体Y 变空
  assert.deepEqual(brain.entities.memoriesFor(ex.id).map((row) => row.memoryId), [m3.id]);
  assert.equal(brain.entities.memoriesFor(ex.id).length, 1);
  assert.deepEqual(brain.entities.memoriesFor(ey.id), []);

  // 6) memoryCount：X 2→1、Y 1→0；list 里的数字同步（排序也跟着变）
  assert.equal(brain.entities.get(ex.id).memoryCount, 1);
  assert.equal(brain.entities.get(ey.id).memoryCount, 0);
  assert.deepEqual(
    brain.entities.list().items.map((e) => [e.name, e.memoryCount]),
    [['实体X', 1], ['实体Y', 0]],
  );

  // 7) 实体 stats：Y 变成孤儿
  const afterStats = brain.entities.stats();
  assert.deepEqual(afterStats, { total: 2, byKind: { tool: 1, concept: 1 }, linked: 1, orphan: 1 });
  assert.equal('unlinked' in afterStats, false, 'stats 不该再有 unlinked');

  // 8) 边 stats 只算两端都未删的那条
  assert.deepEqual(brain.memoryEdges.stats(), { total: 1, byKind: { supports: 1 } });

  // 9) 物理行还在：本系统是软删除，过滤靠查询侧，不靠 ON DELETE CASCADE
  assert.equal(countRows(brain.db, 'memory_entities'), 3);
  assert.equal(countRows(brain.db, 'memory_edges'), 3);
});

// ===========================================================================
// 15. 跨 scope 隔离
// ===========================================================================

test('15. 跨 scope 隔离：同名实体在另一个 scope 是另一行，统计/列表/resolve 都分开', async (t) => {
  const { brain } = createBrain(t);

  const mine = await brain.entities.upsert({ name: '共享名', kind: 'tool', scopeId: SCOPE_A });
  const other = await brain.entities.upsert({ name: '共享名', kind: 'tool', scopeId: SCOPE_B });
  assert.equal(other.created, true, '同 scope 才按名合并，跨 scope 不许合并');
  assert.notEqual(other.id, mine.id);
  assert.equal(countRows(brain.db, 'entities'), 2, '唯一索引是 (scope_id, name)，跨 scope 允许同名两行');

  assert.deepEqual(brain.entities.list({ scopeId: SCOPE_A }).items.map((e) => e.id), [mine.id]);
  assert.deepEqual(brain.entities.list({ scopeId: SCOPE_B }).items.map((e) => e.id), [other.id]);
  assert.equal(brain.entities.stats({ scopeId: SCOPE_A }).total, 1);
  assert.equal(brain.entities.stats({ scopeId: SCOPE_B }).total, 1);

  // resolve 只在本 scope 内找
  assert.equal(brain.entities.resolve('共享名', { scopeId: SCOPE_B }).entity?.id, other.id);
  assert.equal(brain.entities.resolve('共享名', { scopeId: SCOPE_A }).entity?.id, mine.id);

  // get 按 id 全局取（不按 scope 过滤，这是查询语义）
  assert.equal(brain.entities.get(mine.id).id, mine.id);
});

// ===========================================================================
// 16. 边界：别名上限/脏别名、role 落库
// ===========================================================================

test('16. 边界：aliases 上限 20、脏别名被跳过、aliases 非数组当空、role 落库', async (t) => {
  const { brain } = createBrain(t);

  // 上限 20：给 25 个别名，只留前 20。
  const many = Array.from({ length: 25 }, (_, i) => `a${i}`);
  const capped = await brain.entities.upsert({ name: '多别名', aliases: many });
  assert.equal(brain.entities.get(capped.id).aliases.length, 20);
  assert.deepEqual(brain.entities.get(capped.id).aliases, many.slice(0, 20));

  // 脏别名：非字符串、空串、纯空白、超 80 字都跳过；重复（大小写不敏感）只留一个。
  const dirty = await brain.entities.upsert({ name: '脏别名', aliases: [123, '', '   ', 'y'.repeat(81), 'ok', 'OK'] });
  assert.deepEqual(brain.entities.get(dirty.id).aliases, ['ok']);

  // aliases 不是数组 → 当空数组（不抛，避免迁移脏数据卡死）
  const notArray = await brain.entities.upsert({ name: '别名不是数组', aliases: 'nope' });
  assert.deepEqual(brain.entities.get(notArray.id).aliases, []);

  // linkMemory 的 role 落库（表里有列，门面不读，直接查库核对）
  const m1 = await brain.memories.create(draft({ content: '记忆一' }));
  await brain.entities.linkMemory(m1.id, capped.id, { role: 'subject' });
  const row = /** @type {{ role: string | null }} */ (
    brain.db.prepare('SELECT role FROM memory_entities WHERE memory_id = ? AND entity_id = ?').get(m1.id, capped.id)
  );
  assert.equal(row.role, 'subject');
});

// ===========================================================================
// 17. 跨 scope 写入被拒（2026-10-28 修复的 B/C）
// ===========================================================================

test('17. 跨 scope 写入被拒：linkMemory / memoryEdges.link 抛 CONFLICT 且一条都不半写', async (t) => {
  const { brain } = createBrain(t);
  const mA = await brain.memories.create(draft({ content: 'A 的记忆', scopeId: SCOPE_A }));
  const mC = await brain.memories.create(draft({ content: 'A 的另一条', scopeId: SCOPE_A }));
  const mB = await brain.memories.create(draft({ content: 'B 的记忆', scopeId: SCOPE_B }));
  const eDefault = await brain.entities.upsert({ name: '默认实体', kind: 'tool', scopeId: SCOPE_A });
  const eOther = await brain.entities.upsert({ name: '别的 scope 实体', kind: 'tool', scopeId: SCOPE_B });

  // ---- C：记忆与实体跨 scope → CONFLICT ----
  await rejectsAs(() => brain.entities.linkMemory(mA.id, eOther.id), 'CONFLICT', /scope/);
  // 不能半写：目标 scope 的实体 memoryCount 仍为 0，关联表仍是 0 行
  assert.equal(
    brain.entities.list({ scopeId: SCOPE_B }).items.find((e) => e.id === eOther.id)?.memoryCount,
    0,
    '被拒的跨 scope 关联不许把 memoryCount 算进去',
  );
  assert.equal(countRows(brain.db, 'memory_entities'), 0);
  // 对照组：同 scope 能挂上（证明拒绝是因为 scope 不匹配，不是全拒）
  assert.deepEqual(await brain.entities.linkMemory(mA.id, eDefault.id), { linked: true });
  assert.equal(brain.entities.list({ scopeId: SCOPE_A }).items.find((e) => e.id === eDefault.id)?.memoryCount, 1);

  // ---- B：两端记忆都不属于传入 scope → CONFLICT ----
  await rejectsAs(
    () => brain.memoryEdges.link({ scopeId: SCOPE_B, fromMemoryId: mA.id, toMemoryId: mC.id, kind: 'supports' }),
    'CONFLICT',
    /scope/,
  );
  // 一条都没建：两个 scope 的 list 都为空
  assert.deepEqual(brain.memoryEdges.list({ scopeId: SCOPE_B }), [], 'owner-other 下不该出现错位关系');
  assert.deepEqual(brain.memoryEdges.list({ scopeId: SCOPE_A }), [], 'owner-default 下也不该被写入');
  assert.equal(countRows(brain.db, 'memory_edges'), 0);

  // ---- B：一端属于传入 scope、一端属于别的 scope → 也拒 ----
  await rejectsAs(
    () => brain.memoryEdges.link({ scopeId: SCOPE_A, fromMemoryId: mA.id, toMemoryId: mB.id, kind: 'refines' }),
    'CONFLICT',
    /scope/,
  );
  assert.equal(countRows(brain.db, 'memory_edges'), 0);

  // 对照组：两端同 scope 且 scope 一致 → 能建，并且只出现在该 scope
  const ok = await brain.memoryEdges.link({ fromMemoryId: mA.id, toMemoryId: mC.id, kind: 'supports' });
  assert.equal(ok.created, true);
  assert.equal(brain.memoryEdges.list({ scopeId: SCOPE_A }).length, 1);
  assert.deepEqual(brain.memoryEdges.list({ scopeId: SCOPE_B }), []);
  assert.equal(countRows(brain.db, 'memory_edges'), 1);
});
