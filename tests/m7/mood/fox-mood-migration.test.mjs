// @ts-check
/**
 * M7.2：0007 迁移本身。
 *
 * 为什么单独一条：`mood` 门面能跑通不代表**迁移**对。
 * 迁移还要能重复执行（幂等）、能回滚（有 `.down.sql`）、
 * 而且回滚不许伤到 0006 的表。这三条是 CONTRACTS §13.4 / §3.7 的硬要求。
 */

import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, MIGRATIONS_DIR, columnNames, countRows, fixedClock } from './helpers.mjs';
import { openDatabase } from '../../../packages/memory/src/db.js';
import {
  applyMigrations,
  getCurrentVersion,
  loadMigrations,
  rollbackLastMigration,
} from '../../../packages/memory/src/migrator.js';

/** 0007 建出来的两张表。 */
const MOOD_TABLES = Object.freeze(['fox_state', 'fox_events']);

/**
 * @param {import('node:test').TestContext} t
 */
function tempDatabase(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m7-mig-'));
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
  return { opened, dir, fc: fixedClock() };
}

test('0007 建出 fox_state / fox_events，列与索引齐全', (t) => {
  const { opened, fc } = tempDatabase(t);
  const versions = loadMigrations(MIGRATIONS_DIR).map((migration) => migration.version);
  assert.ok(versions.includes('0007'), '磁盘上必须有 0007_m7_fox_mood.sql');

  const result = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.deepEqual(result.applied, versions);
  // 断「停在磁盘上最后一版」而不是写死 0007：写死版本号是下一版迁移的债，
  // 每次加迁移都要回来改这条（CONTRACTS 已踩过两次）。
  assert.equal(getCurrentVersion(opened.db), versions[versions.length - 1], '当前版本必须停在磁盘最后一版');

  for (const table of MOOD_TABLES) {
    assert.ok(
      opened.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      `缺少表 ${table}`,
    );
  }

  // 列名逐条核对：少一列门面就会在运行时炸（而且是最难查的那种「写入后读不回」）
  assert.deepEqual(columnNames(opened.db, 'fox_state'), [
    'id',
    'version',
    'mood',
    'energy',
    'bond',
    'created_at',
    'created_at_local',
    'updated_at',
    'updated_at_local',
    'last_interact_at',
    'last_proactive_at',
    'deletion_epoch',
    // 0008 补的两列（方案 §7.3：压力单独建模；initiative 供主动性决策）
    'stress',
    'initiative',
  ]);
  assert.deepEqual(columnNames(opened.db, 'fox_events'), [
    'id',
    'at',
    'kind',
    'note',
    'delta_json',
    'source_system',
    'created_at',
    'created_at_local',
    'deletion_epoch',
  ]);

  // 两张表都不许有 scope_id（CONTRACTS §19：情感状态不按 scope 分）
  assert.ok(!columnNames(opened.db, 'fox_state').includes('scope_id'));
  assert.ok(!columnNames(opened.db, 'fox_events').includes('scope_id'));

  // 「最近 N 条」是唯一读取形态，索引必须是倒序
  const indexSql = /** @type {{ sql?: string } | undefined} */ (
    opened.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_fox_events_at'").get()
  );
  assert.ok(indexSql, '缺 idx_fox_events_at');
  assert.match(String(indexSql.sql), /at DESC/i, '索引必须是 at DESC（唯一的读取形态是「最近 N 条」）');
});

test('0007 可重复执行：第二次跳过，表还在', (t) => {
  const { opened, fc } = tempDatabase(t);
  const first = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  const second = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.ok(first.applied.includes('0007'));
  assert.deepEqual(second.applied, []);
  assert.ok(second.skipped.includes('0007'));
  for (const table of MOOD_TABLES) {
    assert.ok(opened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), `${table} 不许被删`);
  }
});

test('0007 可回滚：两表消失，0006 的三表与 0001 的主表都不受牵连，再 apply 能重建', (t) => {
  const { opened, fc } = tempDatabase(t);
  applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });

  // 磁盘上 0007 之后还有更新的迁移时，先把它们回滚掉，回到「0007 是最新一版」的状态。
  // 否则 rollbackLastMigration 撤的是最后一版（0008），测不到 0007 的 .down.sql。
  const versions = loadMigrations(MIGRATIONS_DIR).map((m) => m.version);
  const seventh = versions.indexOf('0007');
  const later = versions.slice(seventh + 1);
  for (let i = 0; i < later.length; i += 1) {
    rollbackLastMigration(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  }
  assert.equal(getCurrentVersion(opened.db), '0007', '前置：必须先把 0007 之后的版本撤干净');

  // 造一行状态 + 一条事件，确认回滚是真删表而不是只改版本号
  opened.db
    .prepare(
      `INSERT INTO fox_state (id, version, mood, energy, bond, created_at, created_at_local, updated_at, updated_at_local, deletion_epoch)
       VALUES (1, 1, 86.55, 94.26, 93.3, '2026-10-30T10:00:00.000Z', '2026-10-30T18:00:00.000+08:00', '2026-10-30T10:00:00.000Z', '2026-10-30T18:00:00.000+08:00', 0)`,
    )
    .run();
  assert.equal(countRows(opened.db, 'fox_state'), 1);

  const rolled = rollbackLastMigration(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.equal(rolled.rolledBack, '0007');
  assert.equal(rolled.currentVersion, versions[seventh - 1]);

  for (const table of MOOD_TABLES) {
    assert.equal(
      /** @type {{ n?: number }} */ (opened.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = ?").get(table)).n,
      0,
      `回滚后 ${table} 必须消失`,
    );
  }
  // 不伤 0006：三张表都还在（down 文件只 drop 自己的）
  for (const table of ['entities', 'memory_entities', 'memory_edges']) {
    assert.ok(opened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table), `回滚 0007 不许伤到 ${table}`);
  }
  assert.ok(opened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memories'").get(), '不许伤 0001 的主表');

  // 再 apply 能重建（回滚不是单向破坏）：从 0007 起全部重放
  const again = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.deepEqual(again.applied, versions.slice(seventh));
  assert.equal(getCurrentVersion(opened.db), versions[versions.length - 1]);
  assert.equal(countRows(opened.db, 'fox_state'), 0, 'down 撤的是数据+schema，重建出来是空表（降级用备份）');
});

test('fox_state 单行 CHECK、fox_events 的 at 可索引排序（schema 级不变量）', (t) => {
  const { opened, fc } = tempDatabase(t);
  applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });

  // id = 1 只允许一次；门面用 upsert，绕开它直插第二行必须被拒
  const insert = opened.db.prepare(
    `INSERT INTO fox_state (id, version, mood, energy, bond, created_at, created_at_local, updated_at, updated_at_local, deletion_epoch)
     VALUES (?, 1, 50, 50, 50, '2026-10-30T00:00:00.000Z', '2026-10-30T08:00:00.000+08:00', '2026-10-30T00:00:00.000Z', '2026-10-30T08:00:00.000+08:00', 0)`,
  );
  insert.run(1);
  assert.throws(() => insert.run(2), /CHECK constraint failed/);

  // at REAL 排序：小数也能排对（毫秒是整数，但列类型是 REAL，顺手锁住）
  opened.db
    .prepare(
      `INSERT INTO fox_events (id, at, kind, delta_json, created_at, created_at_local, deletion_epoch)
       VALUES (?, ?, ?, '{}', '2026-10-30T10:00:00.000Z', '2026-10-30T18:00:00.000+08:00', 0)`,
    )
    .run('fev_a', 1793355000000.5, 'chat');
  opened.db
    .prepare(
      `INSERT INTO fox_events (id, at, kind, delta_json, created_at, created_at_local, deletion_epoch)
       VALUES (?, ?, ?, '{}', '2026-10-30T10:00:00.000Z', '2026-10-30T18:00:00.000+08:00', 0)`,
    )
    .run('fev_b', 1793355000001.5, 'praise');
  const ordered = /** @type {Array<{ id: string }>} */ (
    opened.db.prepare('SELECT id FROM fox_events ORDER BY at DESC').all()
  ).map((row) => row.id);
  assert.deepEqual(ordered, ['fev_b', 'fev_a']);
});
