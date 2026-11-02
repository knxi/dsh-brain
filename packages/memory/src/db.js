// @ts-check
/**
 * 数据库打开与 PRAGMA 配置。
 *
 * 实测环境：Node v24.19.0 / `node:sqlite` / SQLite 3.53.3。
 * 实际取值与实测行为见 `docs/m1-notes.md`。
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BrainError, StorageError } from '@dsh-brain/core';

/**
 * 默认 PRAGMA。改这里必须同步 `docs/m1-notes.md` 与部署清单。
 *
 * - `journal_mode=WAL`：读写并发不互斥；WAL 标志写入文件头，重开保持。
 * - `synchronous=FULL`：WAL 下每次提交 fsync WAL。选 FULL 而不是 NORMAL，是为了
 *   「已 ACK 的写入在进程崩溃后不丢」（设计 21.8）。代价是每条提交一次 fsync。
 * - `busy_timeout=5000`：node:sqlite 默认 0（一撞锁就 SQLITE_BUSY），必须显式设置。
 * - `foreign_keys=ON`：node:sqlite 默认已开，仍显式设置以免换驱动时静默变化。
 * - `temp_store=MEMORY`：临时表/排序走内存。
 * - `wal_autocheckpoint=1000`：默认值，显式写下来便于以后调。
 */
export const DEFAULT_PRAGMAS = Object.freeze({
  journal_mode: 'WAL',
  synchronous: 'FULL',
  busy_timeout: 5000,
  foreign_keys: 'ON',
  temp_store: 'MEMORY',
  wal_autocheckpoint: 1000,
});

/** `:memory:` / `file::memory:` 之类的内存库。 */
export function isMemoryPath(dbPath) {
  return typeof dbPath === 'string' && (dbPath === ':memory:' || dbPath.startsWith('file::memory:'));
}

/**
 * 确保库文件所在目录存在。内存库跳过。
 * @param {string} dbPath
 */
export function ensureParentDir(dbPath) {
  if (isMemoryPath(dbPath)) return;
  const dir = path.dirname(path.resolve(dbPath));
  if (dir && dir !== path.resolve('.')) mkdirSync(dir, { recursive: true });
}

/**
 * 应用 PRAGMA 并返回**回读**到的实际值（不是「我设置了什么」）。
 * @param {DatabaseSync} db
 * @param {Partial<typeof DEFAULT_PRAGMAS>} [overrides]
 * @returns {{ journal_mode: string, synchronous: number, busy_timeout: number, foreign_keys: number, temp_store: number, wal_autocheckpoint: number }}
 */
export function applyPragmas(db, overrides = {}) {
  const wanted = { ...DEFAULT_PRAGMAS, ...overrides };
  try {
    db.prepare(`PRAGMA journal_mode = ${String(wanted.journal_mode)}`).get();
    db.prepare(`PRAGMA synchronous = ${String(wanted.synchronous)}`).get();
    db.prepare(`PRAGMA busy_timeout = ${Number(wanted.busy_timeout)}`).get();
    db.prepare(`PRAGMA foreign_keys = ${String(wanted.foreign_keys)}`).get();
    db.prepare(`PRAGMA temp_store = ${String(wanted.temp_store)}`).get();
    db.prepare(`PRAGMA wal_autocheckpoint = ${Number(wanted.wal_autocheckpoint)}`).get();
  } catch (err) {
    throw StorageError.from(err, 'applyPragmas');
  }
  return readPragmas(db);
}

/**
 * 回读当前连接的 PRAGMA 实际值。
 * @param {DatabaseSync} db
 * @returns {{ journal_mode: string, synchronous: number, busy_timeout: number, foreign_keys: number, temp_store: number, wal_autocheckpoint: number }}
 */
export function readPragmas(db) {
  /** @param {string} sql */
  const one = (sql) => /** @type {Record<string, unknown>} */ (db.prepare(sql).get());
  return {
    journal_mode: String(one('PRAGMA journal_mode').journal_mode),
    synchronous: Number(one('PRAGMA synchronous').synchronous),
    busy_timeout: Number(one('PRAGMA busy_timeout').timeout),
    foreign_keys: Number(one('PRAGMA foreign_keys').foreign_keys),
    temp_store: Number(one('PRAGMA temp_store').temp_store),
    wal_autocheckpoint: Number(one('PRAGMA wal_autocheckpoint').wal_autocheckpoint),
  };
}

/**
 * @typedef {Object} OpenDatabaseOptions
 * @property {string} path 库路径（`':memory:'` 也支持）
 * @property {boolean} [readOnly]
 * @property {Partial<typeof DEFAULT_PRAGMAS>} [pragmas]
 * @property {boolean} [requireWal] 文件库是否必须成功切到 WAL（默认 true）
 */

/**
 * @typedef {Object} OpenedDatabase
 * @property {DatabaseSync} db
 * @property {string} path
 * @property {boolean} readOnly
 * @property {{ journal_mode: string, synchronous: number, busy_timeout: number, foreign_keys: number, temp_store: number, wal_autocheckpoint: number }} pragmas
 */

/**
 * 打开主账数据库。
 * @param {OpenDatabaseOptions} options
 * @returns {OpenedDatabase}
 */
export function openDatabase(options) {
  if (!options || typeof options.path !== 'string' || options.path.length === 0) {
    throw new BrainError('INVALID_ARGUMENT', 'openDatabase 需要 path');
  }
  const dbPath = options.path;
  const readOnly = options.readOnly === true;
  if (!readOnly) ensureParentDir(dbPath);

  /** @type {DatabaseSync} */
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly });
  } catch (err) {
    throw StorageError.from(err, `openDatabase(${dbPath})`);
  }

  let pragmas;
  try {
    if (readOnly) {
      // 只读连接不写 PRAGMA（除 busy_timeout 这类连接级设置）。
      db.prepare(`PRAGMA busy_timeout = ${Number(options.pragmas?.busy_timeout ?? DEFAULT_PRAGMAS.busy_timeout)}`).get();
      db.prepare('PRAGMA foreign_keys = ON').get();
      pragmas = readPragmas(db);
    } else {
      pragmas = applyPragmas(db, options.pragmas);
    }
  } catch (err) {
    try {
      db.close();
    } catch {
      /* 打开失败时关闭失败不掩盖原错误 */
    }
    throw err;
  }

  const requireWal = options.requireWal ?? true;
  if (requireWal && !readOnly && !isMemoryPath(dbPath) && pragmas.journal_mode !== 'wal') {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw new StorageError('STORAGE_ERROR', `无法把 ${dbPath} 切到 WAL（实际 ${pragmas.journal_mode}）`, {
      details: { operation: 'openDatabase', pragmas },
    });
  }

  return { db, path: dbPath, readOnly, pragmas };
}

/**
 * `PRAGMA integrity_check`，不 ok 抛错。
 * @param {DatabaseSync} db
 * @returns {string}
 */
export function integrityCheck(db) {
  try {
    const row = /** @type {{ integrity_check?: string }} */ (db.prepare('PRAGMA integrity_check').get());
    const result = String(row?.integrity_check ?? 'unknown');
    if (result !== 'ok') {
      throw new StorageError('STORAGE_CORRUPT', `integrity_check 失败：${result}`);
    }
    return result;
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw StorageError.from(err, 'integrityCheck');
  }
}

/**
 * @param {DatabaseSync} db
 */
export function closeDatabase(db) {
  try {
    db.close();
  } catch (err) {
    throw StorageError.from(err, 'closeDatabase');
  }
}
