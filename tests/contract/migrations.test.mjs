// @ts-check
/**
 * 契约：schema DDL 与迁移器。
 *
 * 覆盖：必需表齐全、可重复执行、校验值保护、可回滚记录、dry-run。
 *
 * **2026-10-28 修订（M2 加 0002 迁移时）** —— 说明为什么改、改前断言什么、改后断言什么：
 *
 * 改前：断言把「只有 0001」写死了（`applied === ['0001']`、`currentVersion === '0001'`、
 * 表清单精确等于 16 张 + brain_meta、`rollbackLastMigration` 回滚的是 0001）。
 * 这类断言把测试变成了设计的水泥：任何 schema 演进都会撞它，而它保护的并不是真契约。
 *
 * 改后：
 * 1. **版本号动态推导**：`expectedVersions = loadMigrations(dir).map(version)`。
 *    断言从「版本号等于某个字面量」变成「迁移器报的版本 == 磁盘上有的版本」——
 *    这才是真契约（漏跑、多跑、顺序错都会红）。
 * 2. **表清单不放松成 includes**：必需表仍逐个断言存在；新增表走显式白名单
 *    `EXTRA_TABLES`（出现白名单外的表仍然报错）；FTS5 虚表自动生成的影子表
 *    （`_data/_idx/_content/_docsize/_config`）用正则显式放行，不让它成为白名单的噪声口子。
 * 3. **回滚测试保留并加强**：不再断言「回滚的是 0001」，而是断言
 *    「回滚最后一版 → 版本号前移 → 该版对象消失 → 记录留痕 → 再 apply 能重建」。
 *    没有 down 文件时拒绝回滚的护栏另有一条测试，不合并。
 */

import test from 'node:test';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  INTERNAL_TABLES,
  MIGRATIONS_DIR,
  REQUIRED_TABLES,
  assert,
  countRows,
  fixedClock,
} from './helpers.mjs';
import { openDatabase } from '../../packages/memory/src/db.js';
import {
  applyMigrations,
  getCurrentVersion,
  listMigrations,
  loadMigrations,
  rollbackLastMigration,
} from '../../packages/memory/src/migrator.js';
import { MigrationError } from '../../packages/core/src/index.js';

/**
 * 0001 之后新迁移建出的表（M2）。**显式白名单**：新增表必须登记在这里，
 * 否则下面的「未登记的表」断言会红。目的是让 schema 变更留痕，不是放宽管控。
 */
const EXTRA_TABLES = Object.freeze([
  'brain_meta',
  // 0002_m2_memory：三套检索索引（DDL 由 @dsh-brain/search 导出、memory 迁移执行）
  'search_fts_char',
  'search_fts_trigram',
  'search_ngram',
  // 0005_m3_restore：内容寻址 blob 元数据与显式引用（GC 的权威依据）
  'blobs',
  'blob_refs',
  // 0006_m6_entities：实体、记忆↔实体、记忆↔记忆关系
  'entities',
  'memory_entities',
  'memory_edges',
  // 0007_m7_fox_mood：情感状态（单行快照 + 事件流水）。**专用表，不进检索**
  'fox_state',
  'fox_events',
  // 0008_m8_workspace_persona_directives：系统 3/4/5/6 的数据地基（26 张）。
  // 一、全局工作空间（模块之间唯一的通信面）
  'ws_events',
  'ws_consumers',
  'ws_candidates',
  'attention_focus',
  'memory_salience',
  'affect_observations',
  // 二、反思 / 技能校准（默认模式网络与小脑）
  'reflection_runs',
  'reflections',
  'skill_stats',
  'skill_lessons',
  // 三、免疫与脑干
  'immune_quarantine',
  'health_alerts',
  // 四、人格（导入 / 分层 / 版本 / 冲突）
  'persona_profiles',
  'persona_versions',
  'persona_conflicts',
  // 五、人物模型 / 关系 / 主动社交
  'person_models',
  'relationship_states',
  'relationship_events',
  'proactive_policies',
  'social_candidates',
  'social_sends',
  'response_decisions',
  // 六、自主指令
  'directives',
  'directive_runs',
  'directive_steps',
  'brain_switches',
]);

/** FTS5 虚表自动生成的影子表（不算「未登记的表」）。 */
const FTS_SHADOW_RE = /^search_fts_(char|trigram)_(data|idx|content|docsize|config)$/;

/** 磁盘上的迁移版本序列（唯一的真来源）。 */
function expectedVersions() {
  return loadMigrations(MIGRATIONS_DIR).map((file) => file.version);
}

/** @param {import('node:sqlite').DatabaseSync} db */
function tableNames(db) {
  return /** @type {Array<{ name: string }>} */ (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
  ).map((row) => row.name);
}

/** @param {import('node:sqlite').DatabaseSync} db @param {string} table */
function columnNames(db, table) {
  return /** @type {Array<{ name: string }>} */ (db.prepare(`PRAGMA table_info(${table})`).all()).map((row) => row.name);
}

/**
 * @param {import('node:test').TestContext} t
 */
function tempDb(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-mig-'));
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

test('迁移建出全部必需表 + 已登记的白名单表，且不出现未登记的表', (t) => {
  const { opened, fc } = tempDb(t);
  const versions = expectedVersions();
  const result = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });

  // 版本断言：磁盘上有几版就应用几版，currentVersion 是最新一版。
  assert.deepEqual(result.applied, versions, '首次执行必须把磁盘上的迁移按序全部应用');
  assert.equal(result.currentVersion, versions[versions.length - 1], 'currentVersion 必须等于磁盘上最后一版');

  const tables = tableNames(opened.db);

  // 必需表：逐个断言存在，一条都不能少（不放宽成「差不多」）。
  for (const required of REQUIRED_TABLES) {
    assert.ok(tables.includes(required), `缺少必需表 ${required}`);
  }
  // 白名单表：也逐个断言存在（登记了却没建出来同样是 bug）。
  for (const extra of EXTRA_TABLES) {
    assert.ok(tables.includes(extra), `缺少白名单内应存在的表 ${extra}`);
  }

  // 未登记的表：除必需表、白名单表、FTS 影子表以外，一个都不许有。
  const unexpected = tables
    .filter((name) => !name.startsWith('sqlite_'))
    .filter((name) => !FTS_SHADOW_RE.test(name))
    .filter((name) => !REQUIRED_TABLES.includes(name) && !EXTRA_TABLES.includes(name));
  assert.deepEqual(unexpected, [], '不允许出现未在契约里登记的表');

  // 目录里的迁移文件必须被完整登记，checksum 与账本一致。
  const files = loadMigrations(MIGRATIONS_DIR);
  assert.deepEqual(files.map((file) => file.version), versions);
  for (const file of files) assert.match(file.checksum, /^sha256:[0-9a-f]{64}$/);

  const applied = listMigrations(opened.db);
  assert.equal(applied.length, versions.length);
  for (const [index, row] of applied.entries()) {
    assert.equal(row.version, versions[index]);
    assert.equal(row.direction, 'up');
    assert.equal(row.checksum, files[index].checksum);
  }
});

test('迁移可重复执行：第二次全部跳过，不重复建表', (t) => {
  const { opened, fc } = tempDb(t);
  const versions = expectedVersions();
  const first = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  const second = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.deepEqual(first.applied, versions);
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, versions);
  assert.equal(listMigrations(opened.db).length, versions.length);
  // 重复执行后表还在（幂等不等于「跑第二遍把表删了」）
  assert.ok(tableNames(opened.db).includes('memories'));
});

test('dry-run 只报告待执行，不写库', (t) => {
  const { opened, fc } = tempDb(t);
  const versions = expectedVersions();
  const dry = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock, dryRun: true });
  assert.deepEqual(dry.applied, versions);
  assert.equal(dry.pending?.length, versions.length);
  assert.equal(getCurrentVersion(opened.db), null);
  assert.equal(countRows(opened.db, 'schema_migrations'), 0);
  assert.equal(
    /** @type {{ n?: number }} */ (
      opened.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'events'").get()
    ).n,
    0,
  );
});

test('历史迁移文件被改动 → MIGRATION_CHECKSUM_MISMATCH（不允许悄悄改历史）', (t) => {
  const { opened, dir, fc } = tempDb(t);
  applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });

  const tamperedDir = path.join(dir, 'tampered-migrations');
  cpSync(MIGRATIONS_DIR, tamperedDir, { recursive: true });
  const file = path.join(tamperedDir, '0001_init.sql');
  writeFileSync(file, `${readFileSync(file, 'utf8')}\n-- tampered\n`, 'utf8');

  assert.throws(
    () => applyMigrations(opened.db, { dir: tamperedDir, clock: fc.clock }),
    (err) => {
      assert.ok(err instanceof MigrationError);
      assert.equal(err.code, 'MIGRATION_CHECKSUM_MISMATCH');
      return true;
    },
  );
});

test('回滚最后一版：版本号前移、该版对象消失、记录留痕、再 apply 可重建', (t) => {
  const { opened, fc } = tempDb(t);
  const versions = expectedVersions();
  const last = versions[versions.length - 1];
  const previous = versions.length > 1 ? versions[versions.length - 2] : null;
  applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });

  const rolled = rollbackLastMigration(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.equal(rolled.rolledBack, last, '必须回滚最后一版');
  assert.equal(rolled.currentVersion, previous, '版本号必须前移到上一版');

  // 回滚记录留痕（不删行，只把 direction 记为 down）。
  const rows = listMigrations(opened.db);
  assert.equal(rows.length, versions.length, '回滚记录必须留痕，不许删行');
  assert.equal(rows.find((row) => row.version === last)?.direction, 'down');
  assert.equal(rows.find((row) => row.version === previous)?.direction, 'up', '更早的迁移不许被连带回滚');

  // 主表必须还在（回滚最后一版不该动到 0001 的表）。
  assert.ok(tableNames(opened.db).includes('events'));
  assert.ok(tableNames(opened.db).includes('memories'));
  assert.ok(tableNames(opened.db).includes('outbox'));

  // 最后一版的对象确实消失了 —— 按当前最后一版的内容断言。
  // 以后再加版本时，这段不会自动覆盖新版本，请在下面补一条同形态的 `if (last === '00xx')`。
  if (last === '0002') {
    assert.equal(
      /** @type {{ n: number }} */ (opened.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'search_fts_char'").get()).n,
      0,
      'down 之后三套检索索引必须消失',
    );
    assert.ok(!columnNames(opened.db, 'memories').includes('origin_system'), 'down 之后 0002 新增列必须消失');
    assert.ok(!columnNames(opened.db, 'task_snapshots').includes('goal'), 'down 之后快照扩展列必须消失');
  }
  if (last === '0003') {
    assert.ok(!columnNames(opened.db, 'context_packages').includes('budget_json'), 'down 之后 0003 的预算列必须消失');
    assert.ok(!columnNames(opened.db, 'context_packages').includes('carrier'), 'down 之后 carrier 列必须消失');
    assert.ok(
      opened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'context_packages'").get(),
      '回滚 0003 不许把 context_packages 整表删掉（它属于 0001）',
    );
    assert.ok(
      opened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_fts_char'").get(),
      '回滚 0003 不许连带 0002 的索引表',
    );
  }

  // 再 apply 能重建（回滚不是单向破坏）。
  const reapplied = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.deepEqual(reapplied.applied, [last]);
  assert.equal(getCurrentVersion(opened.db), last);
  assert.ok(opened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'events'").get());
  if (last === '0002') {
    assert.ok(opened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_fts_char'").get());
    assert.ok(columnNames(opened.db, 'memories').includes('origin_system'));
  }
});

test('连续回滚到底：每版都前移，最后没有可回滚项时报错（护栏）', (t) => {
  const { opened, fc } = tempDb(t);
  const versions = expectedVersions();
  applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });

  for (let index = versions.length - 1; index >= 0; index -= 1) {
    const rolled = rollbackLastMigration(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
    assert.equal(rolled.rolledBack, versions[index]);
    assert.equal(rolled.currentVersion, index > 0 ? versions[index - 1] : null);
  }
  // 到底之后再回滚必须是可理解的错误，而不是静默成功。
  assert.throws(
    () => rollbackLastMigration(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock }),
    (err) => {
      assert.ok(err instanceof MigrationError);
      assert.equal(err.code, 'MIGRATION_ERROR');
      assert.match(err.message, /没有可回滚/);
      return true;
    },
  );
});

test('没有 down 文件的迁移拒绝回滚（不承诺无损降级）', (t) => {
  const { opened, dir, fc } = tempDb(t);
  const customDir = path.join(dir, 'no-down');
  cpSync(MIGRATIONS_DIR, customDir, { recursive: true });
  for (const file of loadMigrations(customDir)) {
    if (file.downFile) rmSync(file.downFile);
  }

  applyMigrations(opened.db, { dir: customDir, clock: fc.clock });
  assert.throws(
    () => rollbackLastMigration(opened.db, { dir: customDir, clock: fc.clock }),
    (err) => {
      assert.ok(err instanceof MigrationError);
      assert.equal(err.code, 'MIGRATION_NO_DOWN');
      return true;
    },
  );
});

test('迁移目录缺失 / 版本重复时报可理解错误', (t) => {
  const { opened, dir, fc } = tempDb(t);
  assert.throws(
    () => applyMigrations(opened.db, { dir: path.join(dir, 'missing'), clock: fc.clock }),
    (err) => {
      assert.ok(err instanceof MigrationError);
      assert.equal(err.code, 'MIGRATION_ERROR');
      return true;
    },
  );

  const dupDir = path.join(dir, 'dup');
  cpSync(MIGRATIONS_DIR, dupDir, { recursive: true });
  cpSync(path.join(dupDir, '0001_init.sql'), path.join(dupDir, '0001_duplicate.sql'));
  assert.throws(() => loadMigrations(dupDir), MigrationError);
});

test('迁移文件名允许下划线（M2-INTERFACES 要求 0002_m2_memory.sql 这种命名）', (t) => {
  const { dir } = tempDb(t);
  const customDir = path.join(dir, 'underscore-name');
  cpSync(MIGRATIONS_DIR, customDir, { recursive: true });
  const files = loadMigrations(customDir);
  assert.ok(
    files.some((file) => file.name.includes('_')),
    '带下划线的迁移文件名必须被识别（早期正则会静默跳过这类文件）',
  );
});
