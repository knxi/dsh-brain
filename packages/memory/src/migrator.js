// @ts-check
/**
 * 迁移器：`schema_migrations` 表驱动，可重复执行、可回滚记录。
 *
 * 纪律（设计 21.8）：
 * - 迁移文件执行后记录 `checksum`；文件被改过 → 报 `MIGRATION_CHECKSUM_MISMATCH`，
 *   不允许悄悄改历史迁移（要改就新增 0002）。
 * - 回滚只在有 `.down.sql` 时允许，且**不承诺无损**；生产降级用升级前备份。
 * - 回滚把 `direction` 置为 `down` 而不是删除记录 —— 回滚这件事本身要留痕。
 * - 每个迁移在单个事务里执行；迁移 SQL 不得含 BEGIN/COMMIT。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '@dsh-brain/core';
import { MigrationError } from '@dsh-brain/core';
import { runInTransaction, wrapWriteError } from './write-queue.js';

/** `schema_migrations` 的权威 DDL（与 0001_init.sql 保持一致）。 */
export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version          TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  checksum         TEXT NOT NULL,
  applied_at       TEXT NOT NULL,
  applied_at_local TEXT NOT NULL,
  duration_ms      INTEGER,
  direction        TEXT NOT NULL DEFAULT 'up' CHECK (direction IN ('up', 'down'))
);`;

/**
 * 迁移文件名：`<4+ 位数字>_<name>.sql`。
 *
 * M2 修正：name 允许下划线。原正则只允许 `[a-z0-9-]`，而 M2-INTERFACES §1.6
 * 明确要求文件名是 `0002_m2_memory.sql`——加了文件却被**静默跳过**（不报错、
 * 不 applied），比报错更危险。放宽字符集而不是改契约里的文件名。
 */
const MIGRATION_FILE_RE = /^(\d{4,})_([a-z0-9][a-z0-9_-]*)\.sql$/;

/**
 * 项目自带 migrations 目录：`<repo>/migrations`。
 * @returns {string}
 */
export function defaultMigrationsDir() {
  return fileURLToPath(new URL('../../../migrations/', import.meta.url));
}

/**
 * 规范化文本后再哈希：`\\r\\n` → `\\n`，避免跨平台换行把校验值弄脏。
 * @param {string} text
 * @returns {string}
 */
export function checksumOf(text) {
  return `sha256:${createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')}`;
}

/**
 * @typedef {Object} MigrationFile
 * @property {string} version 例如 '0001'
 * @property {string} name    例如 'init'
 * @property {string} upFile
 * @property {string | null} downFile
 * @property {string} checksum
 */

/**
 * 扫描迁移目录。
 * @param {string} [dir]
 * @returns {MigrationFile[]}
 */
export function loadMigrations(dir = defaultMigrationsDir()) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    throw new MigrationError('MIGRATION_ERROR', `迁移目录不存在：${dir}`);
  }
  /** @type {MigrationFile[]} */
  const migrations = [];
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const fileName of readdirSync(dir).sort()) {
    if (fileName.endsWith('.down.sql')) continue;
    const match = MIGRATION_FILE_RE.exec(fileName);
    if (!match) continue;
    const version = match[1];
    if (seen.has(version)) {
      throw new MigrationError(
        'MIGRATION_ERROR',
        `迁移版本重复：${version}（${seen.get(version)} 与 ${fileName}）`,
        { details: { version } },
      );
    }
    seen.set(version, fileName);
    const upFile = path.join(dir, fileName);
    const downFile = path.join(dir, fileName.replace(/\.sql$/, '.down.sql'));
    const checksum = checksumOf(readFileSync(upFile, 'utf8'));
    migrations.push({
      version,
      name: match[2],
      upFile,
      downFile: existsSync(downFile) ? downFile : null,
      checksum,
    });
  }
  migrations.sort((a, b) => Number(a.version) - Number(b.version));
  return migrations;
}

/**
 * 确保迁移账本存在。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function ensureSchemaMigrationsTable(db) {
  try {
    db.exec(SCHEMA_MIGRATIONS_DDL);
  } catch (err) {
    throw wrapWriteError(err, 'ensureSchemaMigrationsTable');
  }
}

/**
 * @typedef {Object} AppliedMigration
 * @property {string} version
 * @property {string} name
 * @property {string} checksum
 * @property {string} direction
 * @property {string} applied_at
 */

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {AppliedMigration[]}
 */
export function listMigrations(db) {
  ensureSchemaMigrationsTable(db);
  return /** @type {AppliedMigration[]} */ (
    db.prepare('SELECT version, name, checksum, direction, applied_at FROM schema_migrations ORDER BY version').all()
  );
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string | null}
 */
export function getCurrentVersion(db) {
  ensureSchemaMigrationsTable(db);
  const row = /** @type {{ version?: string } | undefined} */ (
    db.prepare("SELECT version FROM schema_migrations WHERE direction = 'up' ORDER BY version DESC LIMIT 1").get()
  );
  return row?.version ?? null;
}

/**
 * @typedef {Object} ApplyResult
 * @property {string[]} applied
 * @property {string[]} skipped
 * @property {string | null} currentVersion
 * @property {MigrationFile[]} [pending] dryRun 时的待执行列表
 */

/**
 * 应用所有未执行迁移（幂等）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ dir?: string, clock?: ReturnType<typeof createClock>, dryRun?: boolean }} [options]
 * @returns {ApplyResult}
 */
export function applyMigrations(db, options = {}) {
  const dir = options.dir ?? defaultMigrationsDir();
  const clock = options.clock ?? createClock();
  const migrations = loadMigrations(dir);
  ensureSchemaMigrationsTable(db);

  /** @type {Map<string, AppliedMigration>} */
  const existing = new Map();
  for (const row of listMigrations(db)) existing.set(row.version, row);

  /** @type {string[]} */
  const applied = [];
  /** @type {string[]} */
  const skipped = [];

  for (const migration of migrations) {
    const row = existing.get(migration.version);
    if (row && row.direction === 'up') {
      if (row.checksum !== migration.checksum) {
        throw new MigrationError(
          'MIGRATION_CHECKSUM_MISMATCH',
          `迁移 ${migration.version} 的校验值变了：已应用 ${row.checksum}，当前文件 ${migration.checksum}。` +
            '不允许改历史迁移，请新增迁移文件。',
          { details: { version: migration.version } },
        );
      }
      skipped.push(migration.version);
      continue;
    }
    if (options.dryRun === true) {
      applied.push(migration.version);
      continue;
    }
    const sql = readFileSync(migration.upFile, 'utf8');
    const startedAt = Date.now();
    const stamp = clock.stamp();
    runInTransaction(
      db,
      (tx) => {
        tx.exec(sql);
        if (row) {
          tx.run(
            `UPDATE schema_migrations
               SET name = ?, checksum = ?, applied_at = ?, applied_at_local = ?, duration_ms = ?, direction = 'up'
             WHERE version = ?`,
            [migration.name, migration.checksum, stamp.utc, stamp.local, Date.now() - startedAt, migration.version],
          );
        } else {
          tx.run(
            `INSERT INTO schema_migrations
               (version, name, checksum, applied_at, applied_at_local, duration_ms, direction)
             VALUES (?, ?, ?, ?, ?, ?, 'up')`,
            [migration.version, migration.name, migration.checksum, stamp.utc, stamp.local, Date.now() - startedAt],
          );
        }
      },
      `migration:${migration.version}`,
    );
    applied.push(migration.version);
  }

  return {
    applied,
    skipped,
    currentVersion: getCurrentVersion(db),
    ...(options.dryRun === true ? { pending: migrations.filter((m) => !existing.has(m.version) || existing.get(m.version)?.direction !== 'up') } : {}),
  };
}

/**
 * 回滚最后一个已应用迁移。
 *
 * 只在存在 `.down.sql` 时执行；回滚后 `direction` 记为 `down`（留痕，不删行）。
 * 不承诺无损：本函数只负责 schema，数据是否可恢复由迁移内容决定。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ dir?: string, clock?: ReturnType<typeof createClock>, version?: string }} [options]
 * @returns {{ rolledBack: string, currentVersion: string | null }}
 */
export function rollbackLastMigration(db, options = {}) {
  const dir = options.dir ?? defaultMigrationsDir();
  const clock = options.clock ?? createClock();
  const migrations = loadMigrations(dir);
  ensureSchemaMigrationsTable(db);

  const targetVersion = options.version ?? getCurrentVersion(db);
  if (!targetVersion) {
    throw new MigrationError('MIGRATION_ERROR', '没有可回滚的迁移：schema_migrations 中没有 direction=up 的记录');
  }
  const migration = migrations.find((m) => m.version === targetVersion);
  if (!migration) {
    throw new MigrationError('MIGRATION_ERROR', `找不到迁移文件：${targetVersion}（目录 ${dir}）`, {
      details: { version: targetVersion },
    });
  }
  if (!migration.downFile) {
    throw new MigrationError(
      'MIGRATION_NO_DOWN',
      `迁移 ${migration.version} 没有 down 文件，拒绝回滚（降级请用升级前备份）`,
      { details: { version: migration.version } },
    );
  }
  const sql = readFileSync(migration.downFile, 'utf8');
  const stamp = clock.stamp();
  runInTransaction(
    db,
    (tx) => {
      tx.exec(sql);
      tx.run(
        `UPDATE schema_migrations
            SET direction = 'down', applied_at = ?, applied_at_local = ?
          WHERE version = ?`,
        [stamp.utc, stamp.local, migration.version],
      );
    },
    `rollback:${migration.version}`,
  );
  return { rolledBack: migration.version, currentVersion: getCurrentVersion(db) };
}
