// @ts-check
/**
 * 备份与恢复（M1 最小骨架 + M3 全量增强）。
 *
 * M1 兼容层（不动，`tests/contract/backup.test.mjs` 依赖其文件形态）：
 * - `createSnapshot` / `verifySnapshot` / `restoreSnapshot` / `listSnapshots`
 * - 落点 `<backupDir>/<id>.db` 单文件，`backups.format='file'`
 *
 * M3 增强层（本文件后半部分）：
 * - `createBackup`：每日独立全量，落点 `<outDir>/<id>/`（`brain.db` + `manifest.json` + `blobs/`），
 *   `backups.format='dir'`；`ledgerEpoch` **从一致性快照内部读**，保证与快照同一时刻。
 * - `verifyBackup`：清单哈希、db 完整性、表计数、`ledgerEpoch` 与快照一致、blob hash 逐项校验。
 * - `pruneBackups`：按**绝对时间**（`createdAt + retentionDays`）判断到期；份数只做保底 floor。
 * - blob 内容寻址：`<blobsDir>/<hex 前两位>/<hex>`，写入不可变；`blob_refs` 是 GC 引用集的权威依据；
 *   备份清单引用的 blob 永远算被引用；活跃备份读者（reader guard）未完成时 GC 拒绝执行。
 *
 * 仍然明确不做（不虚报）：
 * - 进程级恢复编排（停摄取、排他锁、切换、健康检查）由 `restore.js` 的调用方负责；
 *   `restore.js` 只产出隔离副本并给出 `promoted` 判定。
 * - 物理残留清理 / 加密擦除（设计方案 21.7 明说不能过度承诺）。
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { BackupError, structureHash } from '@dsh-brain/core';
import { readPragmas } from './db.js';
import { getCurrentVersion } from './migrator.js';
import { readDeletionEpoch, readMeta, writeMeta, META_KEYS } from './meta.js';
import { createTxApi, runInTransaction } from './write-queue.js';

/** @typedef {import('./write-queue.js').TxApi} TxApi */

/** 备份清单里逐表核对的表（即 CONTRACTS 第 4 节的全部必需表 + brain_meta）。 */
export const BACKUP_TABLES = Object.freeze([
  'events',
  'sessions',
  'memories',
  'memory_versions',
  'source_refs',
  'summaries',
  'summary_sources',
  'task_snapshots',
  'context_packages',
  'outbox',
  'consumer_offsets',
  'deletion_tombstones',
  'deletion_jobs',
  'backups',
  'audit_logs',
  'schema_migrations',
  'brain_meta',
]);

/**
 * @param {string} prefix
 * @returns {string}
 */
function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Record<string, number>}
 */
export function countTables(db) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const table of BACKUP_TABLES) {
    const row = /** @type {{ n?: number }} */ (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
    counts[table] = Number(row?.n ?? 0);
  }
  return counts;
}

/**
 * 只读检查一个快照文件（不依赖 backups 表记录）。
 * @param {string} filePath
 * @returns {{
 *   integrity_check: string,
 *   table_counts: Record<string, number>,
 *   schema_version: string | null,
 *   deletion_epoch: number,
 *   source_watermark: number | null,
 *   last_received_at: string | null,
 *   event_count: number,
 *   sqlite_version: string,
 * }}
 */
export function inspectSnapshotFile(filePath) {
  if (!existsSync(filePath)) {
    throw new BackupError('BACKUP_VERIFY_FAILED', `快照文件不存在：${filePath}`, {
      details: { path: filePath },
    });
  }
  /** @type {DatabaseSync} */
  let snapshot;
  try {
    snapshot = new DatabaseSync(filePath, { readOnly: true });
  } catch (err) {
    throw new BackupError('BACKUP_VERIFY_FAILED', `无法只读打开快照：${String(err instanceof Error ? err.message : err)}`, {
      details: { path: filePath },
      cause: err,
    });
  }
  try {
    const integrity = /** @type {{ integrity_check?: string }} */ (snapshot.prepare('PRAGMA integrity_check').get());
    const schemaRow = /** @type {{ version?: string } | undefined} */ (
      snapshot.prepare("SELECT version FROM schema_migrations WHERE direction = 'up' ORDER BY version DESC LIMIT 1").get()
    );
    const epochRow = /** @type {{ v?: number } | undefined} */ (
      snapshot.prepare("SELECT CAST(value AS INTEGER) AS v FROM brain_meta WHERE key = 'deletion_epoch'").get()
    );
    const watermarkRow = /** @type {{ m?: number | null, r?: string | null, n?: number }} */ (
      snapshot.prepare('SELECT MAX(source_seq) AS m, MAX(received_at) AS r, COUNT(*) AS n FROM events').get()
    );
    const versionRow = /** @type {{ v?: string } | undefined} */ (snapshot.prepare('SELECT sqlite_version() AS v').get());
    return {
      integrity_check: String(integrity?.integrity_check ?? 'unknown'),
      table_counts: countTables(snapshot),
      schema_version: schemaRow?.version ?? null,
      deletion_epoch: Number(epochRow?.v ?? 0),
      source_watermark: watermarkRow?.m === null || watermarkRow?.m === undefined ? null : Number(watermarkRow.m),
      last_received_at: watermarkRow?.r === null || watermarkRow?.r === undefined ? null : String(watermarkRow.r),
      event_count: Number(watermarkRow?.n ?? 0),
      sqlite_version: String(versionRow?.v ?? 'unknown'),
    };
  } catch (err) {
    throw new BackupError('BACKUP_VERIFY_FAILED', '快照内容检查失败', { details: { path: filePath }, cause: err });
  } finally {
    try {
      snapshot.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * @typedef {Object} SnapshotChecklist
 * @property {string} backup_id
 * @property {string} kind
 * @property {string} created_at
 * @property {string} created_at_local
 * @property {string} time_zone
 * @property {string} sqlite_version
 * @property {string | null} schema_version
 * @property {number} deletion_epoch
 * @property {number | null} source_watermark
 * @property {string} integrity_check
 * @property {Record<string, number>} table_counts
 * @property {Record<string, number>} source_table_counts
 * @property {Record<string, number | string>} pragmas
 * @property {string} sha256
 * @property {number} byte_size
 */

/**
 * 造备份服务。
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   dbPath: string,
 *   queue: { write: <T>(fn: (tx: TxApi) => T, meta?: { label?: string }) => Promise<T>, drain: () => Promise<void> } | null,
 *   clock: { stamp: () => { utc: string, local: string }, nowUtc: () => string, timeZone?: string },
 *   backupDir: string,
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   backupImpl?: (source: import('node:sqlite').DatabaseSync, destination: string) => Promise<void>,
 * }} options
 */
export function createBackupService(options) {
  const { db, dbPath, queue, clock, backupDir } = options;
  const alert = options.alert ?? (() => {});
  const runBackup = options.backupImpl ?? sqliteBackup;

  if (typeof backupDir !== 'string' || backupDir.length === 0) {
    throw new BackupError('BACKUP_ERROR', '未配置备份目录 backupDir');
  }

  /**
   * 写备份记录（创建/更新）。
   * @param {TxApi} tx
   * @param {{
   *   backupId: string, kind: string, filePath: string, status: string,
   *   sha256?: string | null, byteSize?: number | null, checklist?: unknown,
   *   checklistHash?: string | null, schemaVersion?: string | null, deletionEpoch?: number | null,
   *   sourceWatermark?: number | null, error?: string | null, verified?: boolean,
   *   retentionUntil?: string | null,
   * }} input
   */
  function writeBackupRow(tx, input) {
    const stamp = clock.stamp();
    const existing = tx.get('SELECT backup_id FROM backups WHERE backup_id = ?', [input.backupId]);
    if (existing === undefined) {
      tx.run(
        `INSERT INTO backups (
           backup_id, kind, path, status, created_at, created_at_local
         ) VALUES (?, ?, ?, ?, ?, ?)`,
        [input.backupId, input.kind, input.filePath, input.status, stamp.utc, stamp.local],
      );
    }
    tx.run(
      `UPDATE backups SET
         status = ?, byte_size = ?, sha256 = ?, checklist = ?, checklist_hash = ?,
         schema_version = ?, deletion_epoch = ?, source_watermark = ?, error = ?,
         verified_at = CASE WHEN ? = 1 THEN ? ELSE verified_at END,
         verified_at_local = CASE WHEN ? = 1 THEN ? ELSE verified_at_local END,
         retention_until = ?
       WHERE backup_id = ?`,
      [
        input.status,
        input.byteSize ?? null,
        input.sha256 ?? null,
        input.checklist === undefined ? null : JSON.stringify(input.checklist),
        input.checklistHash ?? null,
        input.schemaVersion ?? null,
        input.deletionEpoch ?? null,
        input.sourceWatermark ?? null,
        input.error ?? null,
        input.verified === true ? 1 : 0,
        stamp.utc,
        input.verified === true ? 1 : 0,
        stamp.local,
        input.retentionUntil ?? null,
        input.backupId,
      ],
    );
  }

  /**
   * 造一份一致性快照。resolve 表示「文件已落位且校验通过」。
   * @param {{ kind?: 'full' | 'daily' | 'manual' | 'pre_migration', retentionDays?: number }} [opts]
   * @returns {Promise<{
   *   status: 'verified', backup_id: string, path: string, sha256: string,
   *   byte_size: number, checklist: SnapshotChecklist,
   * }>}
   */
  async function createSnapshot(opts = {}) {
    const kind = opts.kind ?? 'manual';
    const retentionDays = opts.retentionDays ?? 7;

    // 1) 排空本进程写队列：快照水位才有意义（跨进程写入由 backup 的一致读保证）。
    if (queue) await queue.drain();

    mkdirSync(backupDir, { recursive: true });
    const backupId = newId('bkp');
    const finalPath = path.join(backupDir, `${backupId}.db`);
    const tmpPath = `${finalPath}.tmp`;
    const createdAt = clock.stamp();
    const retentionUntil = new Date(Date.parse(createdAt.utc) + retentionDays * 86_400_000).toISOString();

    // 2) 先登记 creating：失败时也能查到「这次尝试过」。
    await queue?.write(
      (tx) => {
        writeBackupRow(tx, {
          backupId,
          kind,
          filePath: finalPath,
          status: 'creating',
          retentionUntil,
        });
      },
      { label: 'backup.register' },
    );

    try {
      rmSync(tmpPath, { force: true });
      await runBackup(db, tmpPath);
      if (!existsSync(tmpPath)) {
        throw new BackupError('BACKUP_ERROR', '备份 API 没有产出文件');
      }

      const inspected = inspectSnapshotFile(tmpPath);
      if (inspected.integrity_check !== 'ok') {
        throw new BackupError('BACKUP_VERIFY_FAILED', `快照 integrity_check 失败：${inspected.integrity_check}`);
      }

      const sourceCounts = countTables(db);
      for (const [table, snapshotCount] of Object.entries(inspected.table_counts)) {
        const sourceCount = sourceCounts[table] ?? 0;
        if (snapshotCount > sourceCount) {
          throw new BackupError('BACKUP_VERIFY_FAILED', `快照表 ${table} 行数(${snapshotCount}) 多于源库(${sourceCount})`);
        }
      }
      const sourceSchemaVersion = getCurrentVersion(db);
      if (inspected.schema_version !== sourceSchemaVersion) {
        throw new BackupError(
          'BACKUP_VERIFY_FAILED',
          `快照 schema 版本(${String(inspected.schema_version)}) 与源库(${String(sourceSchemaVersion)}) 不一致`,
        );
      }

      const bytes = readFileSync(tmpPath);
      const { createHash } = await import('node:crypto');
      const fileSha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
      const byteSize = statSync(tmpPath).size;

      /** @type {SnapshotChecklist} */
      const checklist = {
        backup_id: backupId,
        kind,
        created_at: createdAt.utc,
        created_at_local: createdAt.local,
        time_zone: clock.timeZone ?? 'Asia/Shanghai',
        sqlite_version: inspected.sqlite_version,
        schema_version: inspected.schema_version,
        deletion_epoch: inspected.deletion_epoch,
        source_watermark: inspected.source_watermark,
        integrity_check: inspected.integrity_check,
        table_counts: inspected.table_counts,
        source_table_counts: sourceCounts,
        pragmas: readPragmas(db),
        sha256: fileSha256,
        byte_size: byteSize,
      };
      const checklistHash = structureHash(checklist);

      // 3) 原子落位（Windows rename 覆盖已存在文件实测可用；此处目标名唯一）。
      renameSync(tmpPath, finalPath);

      // 4) 记录 verified + 最近快照指针。
      await queue?.write(
        (tx) => {
          writeBackupRow(tx, {
            backupId,
            kind,
            filePath: finalPath,
            status: 'verified',
            sha256: fileSha256,
            byteSize,
            checklist,
            checklistHash,
            schemaVersion: inspected.schema_version,
            deletionEpoch: inspected.deletion_epoch,
            sourceWatermark: inspected.source_watermark,
            verified: true,
            retentionUntil,
          });
          writeMeta(tx, META_KEYS.lastSnapshotId, backupId, clock);
        },
        { label: 'backup.verify' },
      );

      return {
        status: /** @type {const} */ ('verified'),
        backup_id: backupId,
        path: finalPath,
        sha256: fileSha256,
        byte_size: byteSize,
        checklist,
      };
    } catch (err) {
      rmSync(tmpPath, { force: true });
      const message = err instanceof Error ? err.message : String(err);
      try {
        await queue?.write(
          (tx) => {
            writeBackupRow(tx, {
              backupId,
              kind,
              filePath: finalPath,
              status: 'failed',
              error: message.slice(0, 2000),
              retentionUntil,
            });
          },
          { label: 'backup.failed' },
        );
      } catch {
        /* 记录失败也不能覆盖上一份有效备份，更不能谎报成功 */
      }
      alert({ kind: 'backup_failed', message: '备份失败，上一份有效备份未被覆盖', detail: { backup_id: backupId } });
      throw err instanceof BackupError ? err : new BackupError('BACKUP_ERROR', `备份失败：${message}`, { cause: err });
    }
  }

  /**
   * 校验快照：文件存在 + sha256 与记录一致 + integrity_check + 清单表计数一致。
   * @param {{ backup_id?: string, path?: string }} [input]
   * @returns {Promise<{ ok: boolean, backup_id: string | null, checks: Array<{ name: string, ok: boolean, detail?: string }> }>}
   */
  async function verifySnapshot(input = {}) {
    /** @type {Array<{ name: string, ok: boolean, detail?: string }>} */
    const checks = [];
    /** @type {Record<string, unknown> | undefined} */
    let record;
    if (input.backup_id) {
      record = /** @type {Record<string, unknown> | undefined} */ (
        db.prepare('SELECT * FROM backups WHERE backup_id = ?').get(input.backup_id)
      );
      if (record === undefined) {
        throw new BackupError('BACKUP_ERROR', `备份记录不存在：${input.backup_id}`, {
          details: { backup_id: input.backup_id },
        });
      }
    }
    const filePath = typeof record?.path === 'string' ? record.path : input.path;
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new BackupError('BACKUP_ERROR', 'verifySnapshot 需要 backup_id 或 path');
    }
    checks.push({ name: 'file_exists', ok: existsSync(filePath), detail: filePath });
    if (!checks[0].ok) return { ok: false, backup_id: input.backup_id ?? null, checks };

    const bytes = readFileSync(filePath);
    const { createHash } = await import('node:crypto');
    const actualSha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    const expectedSha = typeof record?.sha256 === 'string' ? record.sha256 : null;
    checks.push({
      name: 'sha256',
      ok: expectedSha === null ? true : actualSha === expectedSha,
      detail: expectedSha === null ? '记录无哈希，跳过比对' : actualSha === expectedSha ? '匹配' : '文件已变',
    });

    try {
      const inspected = inspectSnapshotFile(filePath);
      checks.push({ name: 'integrity_check', ok: inspected.integrity_check === 'ok', detail: inspected.integrity_check });
      /** @type {SnapshotChecklist | null} */
      let checklist = null;
      if (typeof record?.checklist === 'string') {
        try {
          checklist = JSON.parse(record.checklist);
        } catch {
          checklist = null;
        }
      }
      if (checklist !== null) {
        let countsOk = true;
        /** @type {string[]} */
        const mismatches = [];
        for (const [table, expected] of Object.entries(checklist.table_counts)) {
          const actual = inspected.table_counts[table] ?? 0;
          if (actual !== expected) {
            countsOk = false;
            mismatches.push(`${table}: ${expected}→${actual}`);
          }
        }
        checks.push({
          name: 'table_counts',
          ok: countsOk,
          detail: countsOk ? '一致' : mismatches.join(', '),
        });
        checks.push({
          name: 'deletion_epoch',
          ok: inspected.deletion_epoch === checklist.deletion_epoch,
          detail: `${inspected.deletion_epoch} / ${checklist.deletion_epoch}`,
        });
      }
    } catch (err) {
      checks.push({ name: 'integrity_check', ok: false, detail: err instanceof Error ? err.message : String(err) });
    }

    return { ok: checks.every((check) => check.ok), backup_id: input.backup_id ?? null, checks };
  }

  /**
   * 恢复骨架：校验快照 → 复制到隔离路径 → 再校验 → 报告删除账本限制。
   * **不**自动切换/上线（进程编排属于 M3）。
   * @param {{ backup_id: string, targetPath: string, allowOverwrite?: boolean }} input
   * @returns {Promise<{
   *   status: 'restored', backup_id: string, target_path: string, requires_restart: true,
   *   safe_to_promote: boolean, warnings: Array<Record<string, unknown>>, checks: Array<Record<string, unknown>>,
   * }>}
   */
  async function restoreSnapshot(input) {
    if (typeof input.targetPath !== 'string' || input.targetPath.length === 0) {
      throw new BackupError('RESTORE_REFUSED', 'restoreSnapshot 需要 targetPath');
    }
    const targetResolved = path.resolve(input.targetPath);
    if (path.resolve(dbPath) === targetResolved) {
      throw new BackupError('RESTORE_REFUSED', '拒绝恢复到当前活跃数据库路径（先在隔离路径恢复并验证）', {
        details: { target_path: targetResolved },
      });
    }
    if (existsSync(targetResolved) && input.allowOverwrite !== true) {
      throw new BackupError('RESTORE_REFUSED', '目标路径已存在；显式 allowOverwrite: true 才覆盖', {
        details: { target_path: targetResolved },
      });
    }
    const verification = await verifySnapshot({ backup_id: input.backup_id });
    if (!verification.ok) {
      throw new BackupError('BACKUP_VERIFY_FAILED', '快照校验未通过，拒绝恢复', {
        details: { backup_id: input.backup_id, checks: verification.checks },
      });
    }
    const record = /** @type {Record<string, unknown>} */ (
      db.prepare('SELECT * FROM backups WHERE backup_id = ?').get(input.backup_id)
    );
    const sourcePath = String(record.path);

    if (queue) await queue.drain();
    const tmpPath = `${targetResolved}.restore-tmp`;
    rmSync(tmpPath, { force: true });
    mkdirSync(path.dirname(targetResolved), { recursive: true });
    copyFileSync(sourcePath, tmpPath);
    const inspected = inspectSnapshotFile(tmpPath);
    if (inspected.integrity_check !== 'ok') {
      rmSync(tmpPath, { force: true });
      throw new BackupError('BACKUP_VERIFY_FAILED', `恢复副本 integrity_check 失败：${inspected.integrity_check}`);
    }
    renameSync(tmpPath, targetResolved);

    /** @type {Array<Record<string, unknown>>} */
    const warnings = [];
    const currentEpoch = readDeletionEpoch(db);
    if (inspected.deletion_epoch < currentEpoch) {
      warnings.push({
        code: 'STALE_DELETION_LEDGER',
        message:
          '快照的删除纪元早于当前主账：恢复实例可能包含已删除内容。M1 尚未实现独立删除账本，' +
          '必须先在隔离环境重放最新删除、确认后才能上线。',
        snapshot_deletion_epoch: inspected.deletion_epoch,
        current_deletion_epoch: currentEpoch,
      });
    }
    warnings.push({
      code: 'DELETE_LEDGER_NOT_EXTERNAL',
      message: '删除账本仍在主账内（ledger_synced_at 为空）：整盘丢失场景下无法证明删除已生效（M3 补齐）。',
    });

    return {
      status: /** @type {const} */ ('restored'),
      backup_id: input.backup_id,
      target_path: targetResolved,
      requires_restart: true,
      // M1 尚无独立删除账本：恢复实例一律不自动上线，必须人工/后续流程确认。
      safe_to_promote: false,
      warnings,
      checks: verification.checks,
    };
  }

  /**
   * @param {{ limit?: number }} [opts]
   * @returns {Array<Record<string, unknown>>}
   */
  function listSnapshots(opts = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const rows = /** @type {Record<string, unknown>[]} */ (
      db.prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT ?').all(limit)
    );
    return rows.map((row) => ({
      ...row,
      file_exists: typeof row.path === 'string' ? existsSync(row.path) : false,
    }));
  }

  return { createSnapshot, verifySnapshot, restoreSnapshot, listSnapshots };
}

/**
 * 只读：当前最近一次备份 ID（来自 brain_meta）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string | null}
 */
export function lastSnapshotId(db) {
  return readMeta(createTxApi(db), META_KEYS.lastSnapshotId);
}

// ===========================================================================
// M3 全量备份增强（M3-INTERFACES §4）
//
// 落点：`<outDir>/<backupId>/`
//   brain.db        一致性快照（与 M1 同一个 `backup()` 路径，不同落位形态）
//   manifest.json   清单：版本/水位/ledgerEpoch/表计数/blob 清单/db 哈希/清单哈希
//   blobs/<xx>/<hex> 必需附件副本（内容寻址、不可变）
// `backups` 表记录 format='dir'；M1 的单文件备份 format='file'，两者共存。
// ===========================================================================

/** 清单格式标识。 */
export const BACKUP_FORMAT = 'dsh-brain-backup';
/** 清单格式版本（结构变了要升，不是 schema 版本）。 */
export const BACKUP_FORMAT_VERSION = 1;
/** 备份目录里的主库文件名。 */
export const BACKUP_DB_FILE = 'brain.db';
/** 备份目录里的清单文件名。 */
export const BACKUP_MANIFEST_FILE = 'manifest.json';
/** 备份目录里的 blob 子目录名。 */
export const BACKUP_BLOBS_DIR = 'blobs';
/** 默认保留天数（按绝对时间判断到期）。 */
export const DEFAULT_RETENTION_DAYS = 7;
/** 默认保底份数：即使已到期，最近 N 份也不删（防配置错误把备份删光）。 */
export const DEFAULT_KEEP_FLOOR = 7;

/**
 * @param {string} utcIso
 * @returns {string}
 */
function compactStamp(utcIso) {
  // '2026-10-28T10:00:00.000Z' → '20261028T100000'
  return utcIso.slice(0, 19).replace(/[-:]/g, '');
}

/**
 * @param {string | Buffer | Uint8Array} content
 * @returns {string}
 */
export function blobHashOf(content) {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * blob 在内容寻址存储里的路径：`<blobsDir>/<hex 前两位>/<hex>`。
 * @param {string} blobsDir
 * @param {string} hash
 * @returns {string}
 */
export function blobStoragePath(blobsDir, hash) {
  const hex = String(hash).replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new BackupError('BACKUP_ERROR', `blob hash 形状不合法：${String(hash)}`);
  }
  return path.join(blobsDir, hex.slice(0, 2), hex);
}

/**
 * 解析 `blob:sha256:<hex>` / `blob:<hex>` 形式的引用；不是 blob 引用返回 null。
 * @param {unknown} ref
 * @returns {string | null}
 */
export function parseBlobRef(ref) {
  if (typeof ref !== 'string') return null;
  const match = /^blob:(sha256:)?([0-9a-f]{64})$/.exec(ref);
  return match ? `sha256:${match[2]}` : null;
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} name
 * @returns {boolean}
 */
function tableExists(db, name) {
  return db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE (type = 'table' OR type = 'view') AND name = ?").get(name) !== undefined;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function sha256OfFile(filePath) {
  return blobHashOf(readFileSync(filePath));
}

/**
 * 写入内容寻址 blob（幂等、写入不可变）。
 *
 * 不变式：文件名就是内容哈希；写后立刻回读校验，hash 不符直接报错（不静默接受损坏内容）。
 *
 * @param {{
 *   blobsDir: string,
 *   content: string | Buffer | Uint8Array,
 *   contentType?: string | null,
 *   source?: string | null,
 *   db?: import('node:sqlite').DatabaseSync | null,
 *   clock?: { stamp: () => { utc: string, local: string } } | null,
 * }} options
 * @returns {{ hash: string, size: number, path: string, existed: boolean, metadataRecorded: boolean }}
 */
export function writeBlob(options) {
  const { blobsDir, content, contentType = null, source = null, db = null, clock = null } = options;
  if (typeof blobsDir !== 'string' || blobsDir.length === 0) {
    throw new BackupError('BACKUP_ERROR', 'writeBlob 需要 blobsDir');
  }
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
  const hash = blobHashOf(buffer);
  const filePath = blobStoragePath(blobsDir, hash);
  const existed = existsSync(filePath);
  if (!existed) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.tmp`;
    rmSync(tmpPath, { force: true });
    writeFileSync(tmpPath, buffer);
    renameSync(tmpPath, filePath);
  }
  const size = statSync(filePath).size;
  if (sha256OfFile(filePath) !== hash) {
    throw new BackupError('BACKUP_ERROR', `blob 内容与 hash 不符（写入或磁盘损坏）：${hash}`);
  }

  let metadataRecorded = false;
  if (db !== null && tableExists(db, 'blobs')) {
    const clockRef = clock ?? { stamp: () => ({ utc: new Date().toISOString(), local: new Date().toISOString() }) };
    const stamp = clockRef.stamp();
    createTxApi(db).run(
      `INSERT INTO blobs (hash, size, content_type, storage_path, ref_count, source, created_at, created_at_local, verified_at, verified_at_local)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
       ON CONFLICT(hash) DO UPDATE SET
         size = excluded.size,
         content_type = COALESCE(excluded.content_type, blobs.content_type),
         verified_at = excluded.verified_at,
         verified_at_local = excluded.verified_at_local`,
      [hash, size, contentType, path.relative(blobsDir, filePath), source, stamp.utc, stamp.local, stamp.utc, stamp.local],
    );
    metadataRecorded = true;
  }
  return { hash, size, path: filePath, existed, metadataRecorded };
}

/**
 * 读 blob 并校验内容哈希。
 * @param {{ blobsDir: string, hash: string }} input
 * @returns {Buffer}
 */
export function readBlob(input) {
  const filePath = blobStoragePath(input.blobsDir, input.hash);
  if (!existsSync(filePath)) {
    throw new BackupError('BACKUP_ERROR', `blob 不存在：${input.hash}`, { details: { path: filePath } });
  }
  const buffer = readFileSync(filePath);
  if (blobHashOf(buffer) !== input.hash) {
    throw new BackupError('BACKUP_ERROR', `blob 内容与 hash 不符：${input.hash}`);
  }
  return buffer;
}

/**
 * 登记一条显式引用（GC 的权威依据）。
 * @param {{ tx: TxApi, hash: string, ownerKind: string, ownerId: string, clock: { stamp: () => { utc: string, local: string } } }} input
 * @returns {string} ref_id
 */
export function linkBlobRef(input) {
  const { tx, hash, ownerKind, ownerId, clock } = input;
  const refId = `bref_${structureHash({ hash, ownerKind, ownerId }).replace(/^sha256:/, '').slice(0, 32)}`;
  const stamp = clock.stamp();
  tx.run(
    `INSERT INTO blob_refs (ref_id, hash, owner_kind, owner_id, created_at, created_at_local)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ref_id) DO NOTHING`,
    [refId, hash, ownerKind, ownerId, stamp.utc, stamp.local],
  );
  // 引用计数不是权威（以 blob_refs 行数为准），但保持一个可展示的派生值。
  tx.run('UPDATE blobs SET ref_count = (SELECT COUNT(*) FROM blob_refs WHERE hash = ?) WHERE hash = ?', [hash, hash]);
  return refId;
}

/**
 * 列出内容寻址存储里的 blob 文件（跳过 .tmp 等非内容文件）。
 * @param {string} blobsDir
 * @returns {Array<{ hash: string, path: string, size: number }>}
 */
export function listBlobFiles(blobsDir) {
  /** @type {Array<{ hash: string, path: string, size: number }>} */
  const files = [];
  if (!existsSync(blobsDir) || !statSync(blobsDir).isDirectory()) return files;
  for (const shard of readdirSync(blobsDir, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    for (const entry of readdirSync(path.join(blobsDir, shard.name), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/^[0-9a-f]{64}$/.test(entry.name)) continue;
      const full = path.join(blobsDir, shard.name, entry.name);
      files.push({ hash: `sha256:${entry.name}`, path: full, size: statSync(full).size });
    }
  }
  return files;
}

/**
 * 从库里收集仍在使用的 blob 引用（blob_refs + payload_ref + doc_ref）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Set<string>}
 */
export function collectReferencedBlobs(db) {
  /** @type {Set<string>} */
  const hashes = new Set();
  if (tableExists(db, 'blob_refs')) {
    for (const row of /** @type {Array<{ hash: string }>} */ (db.prepare('SELECT DISTINCT hash FROM blob_refs').all())) {
      if (row.hash) hashes.add(String(row.hash));
    }
  }
  if (tableExists(db, 'events')) {
    for (const row of /** @type {Array<{ payload_ref: string }>} */ (
      db.prepare("SELECT DISTINCT payload_ref FROM events WHERE payload_ref LIKE 'blob:%'").all()
    )) {
      const hash = parseBlobRef(row.payload_ref);
      if (hash) hashes.add(hash);
    }
  }
  if (tableExists(db, 'source_refs')) {
    for (const row of /** @type {Array<{ doc_ref: string }>} */ (
      db.prepare("SELECT DISTINCT doc_ref FROM source_refs WHERE doc_ref LIKE 'blob:%'").all()
    )) {
      const hash = parseBlobRef(row.doc_ref);
      if (hash) hashes.add(hash);
    }
  }
  return hashes;
}

/**
 * 扫描备份目录，收集所有**有效备份清单**里引用的 blob。
 *
 * 备份本身就是"读者"：一个 blob 只要还被任何一份未损坏的备份引用，GC 就不能删它。
 * 清单损坏的备份目录会被报告出来，GC 遇到底层 problem 时保守跳过。
 *
 * @param {string} outDir
 * @returns {{ hashes: Set<string>, backups: Array<{ backupId: string, dir: string, createdAt: string, ledgerEpoch: number | null }>, problems: Array<{ code: string, message: string }> }}
 */
export function collectBackupReferencedBlobs(outDir) {
  /** @type {Set<string>} */
  const hashes = new Set();
  /** @type {Array<{ backupId: string, dir: string, createdAt: string, ledgerEpoch: number | null }>} */
  const backups = [];
  /** @type {Array<{ code: string, message: string }>} */
  const problems = [];
  if (!existsSync(outDir) || !statSync(outDir).isDirectory()) return { hashes, backups, problems };

  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(outDir, entry.name);
    const manifestFile = path.join(dir, BACKUP_MANIFEST_FILE);
    if (!existsSync(manifestFile)) continue;
    try {
      const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
      if (manifest?.format !== BACKUP_FORMAT) {
        problems.push({ code: 'MANIFEST_FORMAT', message: `备份清单格式不是 ${BACKUP_FORMAT}：${dir}` });
        continue;
      }
      for (const blob of manifest.blobs ?? []) {
        if (blob?.hash) hashes.add(String(blob.hash));
      }
      backups.push({
        backupId: String(manifest.backupId ?? entry.name),
        dir,
        createdAt: String(manifest.createdAt ?? ''),
        ledgerEpoch: Number.isInteger(manifest.ledgerEpoch) ? manifest.ledgerEpoch : null,
      });
    } catch (err) {
      problems.push({
        code: 'MANIFEST_UNREADABLE',
        message: `备份清单无法解析：${dir}（${err instanceof Error ? err.message : String(err)}）`,
      });
    }
  }
  return { hashes, backups, problems };
}

/**
 * blob 读者守卫：备份进行中（或任何读者持有 token）时，禁止 GC 删 blob。
 *
 * 这是「备份读者完成前禁止 GC 被引用 blob」的并发窗口保护；
 * 历史备份清单引用则由 `collectBackupReferencedBlobs` 永久兜住。
 * @returns {{
 *   begin: (label?: string) => string,
 *   end: (token: string) => void,
 *   active: () => boolean,
 *   activeCount: () => number,
 *   list: () => Array<{ token: string, label: string, startedAt: string }>,
 *   assertCanGc: () => void,
 * }}
 */
export function createBlobReaderGuard() {
  /** @type {Map<string, { label: string, startedAt: string }>} */
  const active = new Map();
  let seq = 0;
  return {
    begin(label = 'reader') {
      seq += 1;
      const token = `rdr_${seq}_${randomBytes(4).toString('hex')}`;
      active.set(token, { label, startedAt: new Date().toISOString() });
      return token;
    },
    end(token) {
      active.delete(token);
    },
    active() {
      return active.size > 0;
    },
    activeCount() {
      return active.size;
    },
    list() {
      return [...active.entries()].map(([token, value]) => ({ token, ...value }));
    },
    assertCanGc() {
      if (active.size > 0) {
        throw new BackupError('BACKUP_ERROR', `有 ${active.size} 个备份读者未完成，禁止 GC blob`, {
          details: { active: [...active.values()] },
        });
      }
    },
  };
}

/**
 * 只读规划一次 blob GC：返回引用集、孤儿、以及清单损坏等保守跳过原因。
 * @param {{ db: import('node:sqlite').DatabaseSync, blobsDir: string, outDir?: string | null }} input
 * @returns {{
 *   referenced: string[], backupReferenced: string[], orphans: Array<{ hash: string, path: string, size: number }>,
 *   total: number, orphanBytes: number, blocked: boolean, problems: Array<{ code: string, message: string }>,
 * }}
 */
export function planBlobGc(input) {
  const { db, blobsDir, outDir = null } = input;
  const referenced = collectReferencedBlobs(db);
  const backupScan = outDir ? collectBackupReferencedBlobs(outDir) : { hashes: new Set(), backups: [], problems: [] };
  const keep = new Set([...referenced, ...backupScan.hashes]);
  const onDisk = listBlobFiles(blobsDir);
  const orphans = onDisk.filter((file) => !keep.has(file.hash));
  return {
    referenced: [...referenced].sort(),
    backupReferenced: [...backupScan.hashes].sort(),
    orphans,
    total: onDisk.length,
    orphanBytes: orphans.reduce((sum, file) => sum + file.size, 0),
    blocked: backupScan.problems.length > 0,
    problems: backupScan.problems,
  };
}

/**
 * 执行 blob GC（默认只删孤儿，不动被引用 blob）。
 *
 * 安全闸门（任一命中就整体跳过，不删任何东西）：
 * 1. 有活跃备份读者；2. 存在无法解析的备份清单（可能引用未知 blob）。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   blobsDir: string,
 *   outDir?: string | null,
 *   guard?: ReturnType<typeof createBlobReaderGuard> | null,
 *   dryRun?: boolean,
 * }} input
 * @returns {{ skipped: boolean, reason: string | null, removed: number, removedBytes: number, plan: ReturnType<typeof planBlobGc> }}
 */
export function runBlobGc(input) {
  const { db, blobsDir, outDir = null, guard = null, dryRun = false } = input;
  const plan = planBlobGc({ db, blobsDir, outDir });
  if (guard && guard.active()) {
    return { skipped: true, reason: 'BACKUP_READER_ACTIVE', removed: 0, removedBytes: 0, plan };
  }
  if (plan.blocked) {
    return { skipped: true, reason: 'BACKUP_MANIFEST_PROBLEM', removed: 0, removedBytes: 0, plan };
  }
  if (dryRun) {
    return { skipped: false, reason: null, removed: 0, removedBytes: 0, plan };
  }
  let removed = 0;
  let removedBytes = 0;
  for (const orphan of plan.orphans) {
    try {
      unlinkSync(orphan.path);
      removed += 1;
      removedBytes += orphan.size;
    } catch {
      /* 单个文件删不掉不复述，按失败留在 plan 里由调用方复跑 */
    }
  }
  if (tableExists(db, 'blobs')) {
    for (const orphan of plan.orphans) {
      db.prepare('DELETE FROM blobs WHERE hash = ? AND NOT EXISTS (SELECT 1 FROM blob_refs WHERE hash = ?)').run(
        orphan.hash,
        orphan.hash,
      );
    }
  }
  return { skipped: false, reason: null, removed, removedBytes, plan };
}

// ===========================================================================
// M3：目录形态备份（createBackup / verifyBackup / listBackups / pruneBackups）
// ===========================================================================

/**
 * 清单哈希：对除 `manifestHash` 自身之外的全部字段做规范化哈希。
 * @param {Record<string, unknown>} manifest
 * @returns {string}
 */
function computeManifestHash(manifest) {
  const rest = { ...manifest };
  delete rest.manifestHash;
  return structureHash(rest);
}

/**
 * @param {string} dir
 * @returns {Record<string, unknown> | null}
 */
function readManifestSafe(dir) {
  const manifestFile = path.join(dir, BACKUP_MANIFEST_FILE);
  if (!existsSync(manifestFile)) return null;
  try {
    return JSON.parse(readFileSync(manifestFile, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 从快照内部读必需 blob 引用，并把文件复制进备份目录（内容寻址副本）。
 *
 * 引用集从**快照**读而不是从源库读：源库在 `backup()` 之后可能已变，
 * 快照才是这次备份要保真的那一时刻。
 *
 * @param {string} snapshotDbPath
 * @param {string | null} blobsDir
 * @param {string} destBlobsDir
 * @returns {{ blobs: Array<{ hash: string, size: number, refCount: number }>, totalBytes: number }}
 */
function collectSnapshotBlobs(snapshotDbPath, blobsDir, destBlobsDir) {
  const source = new DatabaseSync(snapshotDbPath, { readOnly: true });
  /** @type {Set<string>} */
  let refs;
  /** @type {Map<string, number>} */
  const counts = new Map();
  try {
    refs = collectReferencedBlobs(source);
    if (tableExists(source, 'blob_refs')) {
      for (const row of /** @type {Array<{ hash: string, n: number }>} */ (
        source.prepare('SELECT hash, COUNT(*) AS n FROM blob_refs GROUP BY hash').all()
      )) {
        counts.set(String(row.hash), Number(row.n));
      }
    }
  } finally {
    source.close();
  }
  if (refs.size === 0) return { blobs: [], totalBytes: 0 };
  if (typeof blobsDir !== 'string' || blobsDir.length === 0) {
    throw new BackupError('BACKUP_ERROR', '快照里存在 blob 引用，但未配置 blobsDir，无法产出完整备份', {
      details: { referenced: refs.size },
    });
  }
  /** @type {Array<{ hash: string, size: number, refCount: number }>} */
  const blobs = [];
  let totalBytes = 0;
  for (const hash of [...refs].sort()) {
    const sourceFile = blobStoragePath(blobsDir, hash);
    if (!existsSync(sourceFile)) {
      throw new BackupError('BACKUP_ERROR', `必需 blob 缺失：${hash}（备份不能产出不完整清单）`, {
        details: { hash },
      });
    }
    const buffer = readFileSync(sourceFile);
    if (blobHashOf(buffer) !== hash) {
      throw new BackupError('BACKUP_ERROR', `必需 blob 内容与 hash 不符：${hash}`, { details: { hash } });
    }
    const destFile = blobStoragePath(destBlobsDir, hash);
    mkdirSync(path.dirname(destFile), { recursive: true });
    writeFileSync(destFile, buffer);
    blobs.push({ hash, size: buffer.length, refCount: counts.get(hash) ?? 1 });
    totalBytes += buffer.length;
  }
  return { blobs, totalBytes };
}

/**
 * 写一条目录形态备份记录（creating / verified / failed）。
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: TxApi) => T, meta?: { label?: string }) => Promise<T> } | null,
 *   clock: { stamp: () => { utc: string, local: string } },
 *   backupId: string, kind: string, label: string | null, dirPath: string, status: string,
 *   manifest?: Record<string, unknown> | null, manifestHash?: string | null,
 *   schemaVersion?: string | null, ledgerEpoch?: number | null, watermark?: number | null,
 *   sha256?: string | null, byteSize?: number | null, error?: string | null, verified?: boolean,
 * }} input
 * @returns {Promise<boolean>}
 */
async function writeDirBackupRow(input) {
  const stamp = input.clock.stamp();
  /** @param {TxApi} tx */
  const run = (tx) => {
    const existing = tx.get('SELECT backup_id FROM backups WHERE backup_id = ?', [input.backupId]);
    if (existing === undefined) {
      tx.run(
        `INSERT INTO backups (backup_id, kind, path, format, label, status, created_at, created_at_local)
         VALUES (?, ?, ?, 'dir', ?, ?, ?, ?)`,
        [input.backupId, input.kind, input.dirPath, input.label, input.status, stamp.utc, stamp.local],
      );
    }
    tx.run(
      `UPDATE backups SET
         status = ?, format = 'dir', label = ?, sha256 = ?, byte_size = ?, checklist = ?, checklist_hash = ?,
         schema_version = ?, deletion_epoch = ?, source_watermark = ?, error = ?,
         verified_at = CASE WHEN ? = 1 THEN ? ELSE verified_at END,
         verified_at_local = CASE WHEN ? = 1 THEN ? ELSE verified_at_local END
       WHERE backup_id = ?`,
      [
        input.status,
        input.label,
        input.sha256 ?? null,
        input.byteSize ?? null,
        input.manifest === undefined || input.manifest === null ? null : JSON.stringify(input.manifest),
        input.manifestHash ?? null,
        input.schemaVersion ?? null,
        input.ledgerEpoch ?? null,
        input.watermark ?? null,
        input.error ?? null,
        input.verified === true ? 1 : 0,
        stamp.utc,
        input.verified === true ? 1 : 0,
        stamp.local,
        input.backupId,
      ],
    );
  };
  try {
    if (input.queue) await input.queue.write(run, { label: `backup.dir.${input.status}` });
    else runInTransaction(input.db, run, `backup.dir.${input.status}`);
    return true;
  } catch {
    // 记录失败不阻断备份产物；但也不谎报成功——调用方看返回的 verified 字段。
    return false;
  }
}

/**
 * 造一份目录形态的**独立全量**备份（M3）。
 *
 * 关键保证：
 * 1. `ledgerEpoch` 从**快照内部**读（`brain_meta.deletion_epoch`），与快照同一时刻；
 *    不先读源库再拍快照（中间插进来的删除会让 epoch 与数据错位）。
 * 2. `.tmp` → 自校验 → `renameSync` 原子落位；失败不覆盖上一份有效备份。
 * 3. 清单记录必需附件（blob）hash，并把内容寻址副本放进备份目录。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   outDir: string,
 *   clock: { stamp: () => { utc: string, local: string } },
 *   blobsDir?: string | null,
 *   label?: string | null,
 *   kind?: 'full' | 'daily' | 'manual' | 'pre_migration' | 'pre_restore',
 *   retentionDays?: number,
 *   backupId?: string | null,
 *   backupImpl?: (source: import('node:sqlite').DatabaseSync, destination: string) => Promise<void>,
 *   queue?: { write: <T>(fn: (tx: TxApi) => T, meta?: { label?: string }) => Promise<T>, drain: () => Promise<void> } | null,
 *   blobGuard?: ReturnType<typeof createBlobReaderGuard> | null,
 * }} options
 * @returns {Promise<{
 *   dir: string, backupId: string, createdAt: string, createdAtLocal: string,
 *   schemaVersion: string | null, watermark: { maxSourceSeq: number | null, lastReceivedAt: string | null, eventCount: number },
 *   ledgerEpoch: number, tables: Array<{ name: string, rows: number }>,
 *   blobs: Array<{ hash: string, size: number, refCount: number }>,
 *   manifestHash: string, dbSha256: string, byteSize: number, verified: true,
 *   manifest: Record<string, unknown>,
 * }>}
 */
export async function createBackup(options) {
  const {
    db,
    outDir,
    clock,
    blobsDir = null,
    label = null,
    kind = 'full',
    retentionDays = DEFAULT_RETENTION_DAYS,
    queue = null,
    blobGuard = null,
    backupImpl = undefined,
  } = options ?? {};
  const runBackup = backupImpl ?? sqliteBackup;
  if (!db) throw new BackupError('BACKUP_ERROR', 'createBackup 需要 db');
  if (typeof outDir !== 'string' || outDir.length === 0) {
    throw new BackupError('BACKUP_ERROR', 'createBackup 需要 outDir');
  }
  if (!clock || typeof clock.stamp !== 'function') {
    throw new BackupError('BACKUP_ERROR', 'createBackup 需要 clock');
  }

  const readerToken = blobGuard ? blobGuard.begin(`createBackup:${kind}`) : null;
  mkdirSync(outDir, { recursive: true });
  const createdAt = clock.stamp();
  const backupId = options.backupId
    ? String(options.backupId)
    : `bkp_${compactStamp(createdAt.utc)}_${randomBytes(4).toString('hex')}`;
  if (!/^[A-Za-z0-9_][A-Za-z0-9._:-]{2,127}$/.test(backupId)) {
    throw new BackupError('BACKUP_ERROR', `backupId 形状不合法：${backupId}`);
  }
  const finalDir = path.join(outDir, backupId);
  const tmpDir = `${finalDir}.tmp`;
  const tmpDb = path.join(tmpDir, BACKUP_DB_FILE);

  let rowWritten = false;
  try {
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });

    // 先登记 creating：中途失败也能查到这次尝试过。
    rowWritten = await writeDirBackupRow({
      db,
      queue,
      clock,
      backupId,
      kind,
      label,
      dirPath: finalDir,
      status: 'creating',
    });

    // 1) 排空本进程写队列后做在线一致性快照。
    if (queue) await queue.drain();
    await runBackup(db, tmpDb);
    if (!existsSync(tmpDb)) {
      throw new BackupError('BACKUP_ERROR', '备份 API 没有产出快照文件');
    }

    // 2) 从快照内部读元数据（与快照同一时刻）。
    const inspected = inspectSnapshotFile(tmpDb);
    if (inspected.integrity_check !== 'ok') {
      throw new BackupError('BACKUP_VERIFY_FAILED', `快照 integrity_check 失败：${inspected.integrity_check}`);
    }
    const schemaVersion = getCurrentVersion(db);
    if (inspected.schema_version !== schemaVersion) {
      throw new BackupError(
        'BACKUP_VERIFY_FAILED',
        `快照 schema 版本(${String(inspected.schema_version)}) 与源库(${String(schemaVersion)}) 不一致`,
      );
    }
    const ledgerEpoch = inspected.deletion_epoch;
    if (!Number.isInteger(ledgerEpoch) || ledgerEpoch < 0) {
      throw new BackupError('BACKUP_ERROR', `无法从快照读出合法 ledgerEpoch（读到 ${String(ledgerEpoch)}）`);
    }

    // 3) 必需附件（blob）清单与副本。
    const blobResult = collectSnapshotBlobs(tmpDb, blobsDir, path.join(tmpDir, BACKUP_BLOBS_DIR));

    // 4) 清单。
    const dbSha256 = sha256OfFile(tmpDb);
    const byteSize = statSync(tmpDb).size;
    const watermark = {
      maxSourceSeq: inspected.source_watermark,
      lastReceivedAt: inspected.last_received_at,
      eventCount: inspected.event_count,
    };
    /** @type {Record<string, unknown>} */
    const manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      backupId,
      label,
      kind,
      createdAt: createdAt.utc,
      createdAtLocal: createdAt.local,
      timeZone: clock.timeZone ?? 'Asia/Shanghai',
      schemaVersion,
      watermark,
      ledgerEpoch,
      deletionEpoch: ledgerEpoch,
      tables: BACKUP_TABLES.map((name) => ({ name, rows: inspected.table_counts[name] ?? 0 })),
      tableCounts: inspected.table_counts,
      blobs: blobResult.blobs,
      blobTotalBytes: blobResult.totalBytes,
      db: { file: BACKUP_DB_FILE, sha256: dbSha256, byteSize },
      sqliteVersion: inspected.sqlite_version,
      pragmas: readPragmas(db),
      retentionDays,
      expiresAt: new Date(Date.parse(createdAt.utc) + retentionDays * 86_400_000).toISOString(),
      manifestHash: '',
    };
    manifest.manifestHash = computeManifestHash(manifest);
    writeFileSync(path.join(tmpDir, BACKUP_MANIFEST_FILE), JSON.stringify(manifest, null, 2), 'utf8');

    // 5) 落位前自校验（用与恢复同一个 verifyBackup）。
    const preCheck = verifyBackup(tmpDir);
    if (!preCheck.ok) {
      throw new BackupError(
        'BACKUP_VERIFY_FAILED',
        `备份自校验失败：${preCheck.problems.map((item) => `${item.code}:${item.message}`).join('; ')}`,
        { details: { problems: preCheck.problems } },
      );
    }

    // 6) 原子落位（目录 rename 同卷原子）。
    rmSync(finalDir, { recursive: true, force: true });
    renameSync(tmpDir, finalDir);

    // 7) 登记 verified + 最近快照指针。
    const manifestHash = String(manifest.manifestHash);
    if (rowWritten) {
      await writeDirBackupRow({
        db,
        queue,
        clock,
        backupId,
        kind,
        label,
        dirPath: finalDir,
        status: 'verified',
        manifest,
        manifestHash,
        schemaVersion,
        ledgerEpoch,
        watermark: inspected.source_watermark,
        sha256: dbSha256,
        byteSize,
        verified: true,
      });
    }
    try {
      /** @param {TxApi} tx */
      const writeLastSnapshot = (tx) => writeMeta(tx, META_KEYS.lastSnapshotId, backupId, clock);
      if (queue) await queue.write(writeLastSnapshot, { label: 'backup.meta' });
      else runInTransaction(db, writeLastSnapshot, 'backup.meta');
    } catch {
      /* 指针写入失败不影响已校验落位的备份文件本身 */
    }

    return {
      dir: finalDir,
      backupId,
      createdAt: createdAt.utc,
      createdAtLocal: createdAt.local,
      schemaVersion,
      watermark,
      ledgerEpoch,
      tables: /** @type {Array<{ name: string, rows: number }>} */ (manifest.tables),
      blobs: blobResult.blobs,
      manifestHash,
      dbSha256,
      byteSize,
      verified: /** @type {const} */ (true),
      manifest,
    };
  } catch (err) {
    rmSync(tmpDir, { recursive: true, force: true });
    const message = err instanceof Error ? err.message : String(err);
    if (rowWritten) {
      await writeDirBackupRow({
        db,
        queue,
        clock,
        backupId,
        kind,
        label,
        dirPath: finalDir,
        status: 'failed',
        error: message.slice(0, 2000),
      });
    }
    throw err instanceof BackupError ? err : new BackupError('BACKUP_ERROR', `备份失败：${message}`, { cause: err });
  } finally {
    if (blobGuard && readerToken) blobGuard.end(readerToken);
  }
}

/**
 * 校验一个目录形态备份（不抛错，返回 problems 列表）。
 *
 * 校验项：清单格式/版本/哈希、`ledgerEpoch` 存在性与快照一致性、db 哈希/大小/完整性/
 * schema 版本/表计数/水位、每个必需 blob 的存在与哈希。
 *
 * @param {string} dir
 * @returns {{
 *   ok: boolean,
 *   problems: Array<{ code: string, message: string }>,
 *   dir: string,
 *   manifest: Record<string, unknown> | null,
 *   manifestHash: string | null,
 *   schemaVersion: string | null,
 *   watermark: { maxSourceSeq: number | null, lastReceivedAt: string | null, eventCount: number } | null,
 *   ledgerEpoch: number | null,
 *   tables: Array<{ name: string, rows: number }>,
 *   blobs: Array<{ hash: string, size: number }>,
 * }}
 */
export function verifyBackup(dir) {
  /** @type {Array<{ code: string, message: string }>} */
  const problems = [];
  /** @param {string} code @param {string} message */
  const push = (code, message) => problems.push({ code, message });
  const empty = {
    ok: false,
    problems,
    dir,
    manifest: /** @type {Record<string, unknown> | null} */ (null),
    manifestHash: /** @type {string | null} */ (null),
    schemaVersion: /** @type {string | null} */ (null),
    watermark: /** @type {{ maxSourceSeq: number | null, lastReceivedAt: string | null, eventCount: number } | null} */ (null),
    ledgerEpoch: /** @type {number | null} */ (null),
    tables: /** @type {Array<{ name: string, rows: number }>} */ ([]),
    blobs: /** @type {Array<{ hash: string, size: number }>} */ ([]),
  };

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    push('BACKUP_MISSING', `备份目录不存在：${dir}`);
    return empty;
  }
  const manifest = readManifestSafe(dir);
  if (manifest === null) {
    push('MANIFEST_MISSING', `备份清单缺失或无法解析：${path.join(dir, BACKUP_MANIFEST_FILE)}`);
    return empty;
  }
  if (manifest.format !== BACKUP_FORMAT) {
    push('MANIFEST_FORMAT', `清单格式不是 ${BACKUP_FORMAT}（读到 ${String(manifest.format)}）`);
  }
  if (manifest.formatVersion !== BACKUP_FORMAT_VERSION) {
    push('MANIFEST_VERSION', `清单格式版本不支持：${String(manifest.formatVersion)}（期望 ${BACKUP_FORMAT_VERSION}）`);
  }
  const ledgerEpoch = typeof manifest.ledgerEpoch === 'number' ? manifest.ledgerEpoch : null;
  if (ledgerEpoch === null || !Number.isInteger(ledgerEpoch)) {
    push('MANIFEST_LEDGER_EPOCH_MISSING', '清单缺少合法的 ledgerEpoch：无法判断删除账本水位，视为清单损坏');
  }
  if (typeof manifest.manifestHash === 'string' && manifest.manifestHash !== computeManifestHash(manifest)) {
    push('MANIFEST_HASH_MISMATCH', '清单哈希不符：清单内容被改动');
  }
  const schemaVersion = typeof manifest.schemaVersion === 'string' ? manifest.schemaVersion : null;
  const watermark = /** @type {{ maxSourceSeq: number | null, lastReceivedAt: string | null, eventCount: number } | null} */ (
    manifest.watermark ?? null
  );
  const tables = Array.isArray(manifest.tables)
    ? /** @type {Array<{ name: string, rows: number }>} */ (manifest.tables)
    : [];
  const blobs = Array.isArray(manifest.blobs) ? /** @type {Array<{ hash: string, size: number }>} */ (manifest.blobs) : [];

  // db 文件
  const dbFile = path.join(dir, typeof manifest.db?.file === 'string' ? manifest.db.file : BACKUP_DB_FILE);
  if (!existsSync(dbFile)) {
    push('DB_MISSING', `备份数据库文件缺失：${dbFile}`);
  } else {
    const actualSize = statSync(dbFile).size;
    const expectedSize = typeof manifest.db?.byteSize === 'number' ? manifest.db.byteSize : null;
    if (expectedSize !== null && actualSize !== expectedSize) {
      push('DB_SIZE_MISMATCH', `备份库大小不符：清单 ${expectedSize}，实际 ${actualSize}`);
    }
    const actualHash = sha256OfFile(dbFile);
    const expectedHash = typeof manifest.db?.sha256 === 'string' ? manifest.db.sha256 : null;
    if (expectedHash !== null && actualHash !== expectedHash) {
      push('DB_HASH_MISMATCH', '备份库哈希不符：文件已变或被截断');
    }
    try {
      const inspected = inspectSnapshotFile(dbFile);
      if (inspected.integrity_check !== 'ok') {
        push('DB_INTEGRITY', `备份库 integrity_check 失败：${inspected.integrity_check}`);
      }
      if (schemaVersion !== null && inspected.schema_version !== schemaVersion) {
        push('SCHEMA_MISMATCH', `schema 版本不符：清单 ${schemaVersion}，库内 ${String(inspected.schema_version)}`);
      }
      if (ledgerEpoch !== null && inspected.deletion_epoch !== ledgerEpoch) {
        push(
          'LEDGER_EPOCH_MISMATCH',
          `清单 ledgerEpoch(${ledgerEpoch}) 与快照内 deletion_epoch(${inspected.deletion_epoch}) 不一致：清单与数据不同刻`,
        );
      }
      for (const table of tables) {
        const actualRows = inspected.table_counts[table.name] ?? 0;
        if (Number(table.rows) !== actualRows) {
          push('TABLE_COUNT_MISMATCH', `${table.name} 行数不符：清单 ${table.rows}，实际 ${actualRows}`);
        }
      }
      if (watermark !== null) {
        if (inspected.source_watermark !== watermark.maxSourceSeq) {
          push(
            'WATERMARK_MISMATCH',
            `source watermark 不符：清单 ${String(watermark.maxSourceSeq)}，实际 ${String(inspected.source_watermark)}`,
          );
        }
        if (Number(watermark.eventCount ?? -1) !== inspected.event_count) {
          push('WATERMARK_MISMATCH', `事件计数不符：清单 ${String(watermark.eventCount)}，实际 ${inspected.event_count}`);
        }
      }
    } catch (err) {
      push('DB_UNREADABLE', `备份库无法读取：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 必需附件
  for (const blob of blobs) {
    const hex = String(blob.hash).replace(/^sha256:/, '');
    const blobFile = path.join(dir, BACKUP_BLOBS_DIR, hex.slice(0, 2), hex);
    if (!existsSync(blobFile)) {
      push('BLOB_MISSING', `清单记录的必需附件缺失：${blob.hash}`);
      continue;
    }
    if (sha256OfFile(blobFile) !== blob.hash) {
      push('BLOB_HASH_MISMATCH', `附件内容与 hash 不符：${blob.hash}`);
    }
    if (typeof blob.size === 'number' && statSync(blobFile).size !== blob.size) {
      push('BLOB_SIZE_MISMATCH', `附件大小与清单不符：${blob.hash}`);
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    dir,
    manifest,
    manifestHash: typeof manifest.manifestHash === 'string' ? manifest.manifestHash : null,
    schemaVersion,
    watermark,
    ledgerEpoch,
    tables,
    blobs,
  };
}

/**
 * 列出备份目录下的备份（目录形态 + M1 文件形态），按 createdAt 降序。
 * 轻量：只读清单/表头，不跑 sha256（那用 `verifyBackup`）。
 *
 * @param {{ outDir: string, db?: import('node:sqlite').DatabaseSync | null }} input
 * @returns {Array<{
 *   backupId: string, path: string, format: 'dir' | 'file',
 *   createdAt: string | null, schemaVersion: string | null,
 *   ledgerEpoch: number | null, watermark: number | null,
 *   size: number | null, blobCount: number, label: string | null,
 *   problems: string[],
 * }>}
 */
export function listBackups(input) {
  const { outDir } = input;
  /** @type {Array<ReturnType<typeof listBackups>[number]>} */
  const entries = [];
  if (!existsSync(outDir) || !statSync(outDir).isDirectory()) return entries;

  for (const entry of readdirSync(outDir, { withFileTypes: true })) {
    if (entry.name.endsWith('.tmp')) continue;
    const full = path.join(outDir, entry.name);
    if (entry.isDirectory()) {
      const manifest = readManifestSafe(full);
      if (manifest === null) continue;
      const dbFile = path.join(full, typeof manifest.db?.file === 'string' ? manifest.db.file : BACKUP_DB_FILE);
      entries.push({
        backupId: String(manifest.backupId ?? entry.name),
        path: full,
        format: 'dir',
        createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : null,
        schemaVersion: typeof manifest.schemaVersion === 'string' ? manifest.schemaVersion : null,
        ledgerEpoch: typeof manifest.ledgerEpoch === 'number' ? manifest.ledgerEpoch : null,
        watermark: typeof manifest.watermark?.maxSourceSeq === 'number' ? manifest.watermark.maxSourceSeq : null,
        size: existsSync(dbFile) ? statSync(dbFile).size : null,
        blobCount: Array.isArray(manifest.blobs) ? manifest.blobs.length : 0,
        label: typeof manifest.label === 'string' ? manifest.label : null,
        problems: [],
      });
    } else if (entry.isFile() && entry.name.endsWith('.db')) {
      const problems = [];
      let inspected = null;
      try {
        inspected = inspectSnapshotFile(full);
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
      entries.push({
        backupId: entry.name.replace(/\.db$/, ''),
        path: full,
        format: 'file',
        createdAt: inspected === null ? null : statSync(full).mtime.toISOString(),
        schemaVersion: inspected?.schema_version ?? null,
        ledgerEpoch: inspected?.deletion_epoch ?? null,
        watermark: inspected?.source_watermark ?? null,
        size: statSync(full).size,
        blobCount: 0,
        label: null,
        problems,
      });
    }
  }
  entries.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
  return entries;
}

/**
 * 按**绝对时间**清理到期备份（M3-INTERFACES §4.2）。
 *
 * 删除判定只看时间：`now >= createdAt + retentionDays`。
 * `keep` 是保底份数（最近 N 份即使到期也保留，防配置错误把备份删光），
 * 不用于"保留 N 份就删其余"。
 *
 * @param {{
 *   outDir: string,
 *   db?: import('node:sqlite').DatabaseSync | null,
 *   clock?: { stamp: () => { utc: string, local: string } } | null,
 *   keep?: number,
 *   retentionDays?: number,
 *   now?: Date,
 *   dryRun?: boolean,
 * }} input
 * @returns {{
 *   removed: Array<{ backupId: string, path: string, createdAt: string, expiresAt: string, reason: string }>,
 *   kept: Array<{ backupId: string, path: string, createdAt: string, expiresAt: string, reason: string }>,
 *   dryRun: boolean,
 *   at: string,
 * }}
 */
export function pruneBackups(input) {
  const {
    outDir,
    db = null,
    clock = null,
    keep = DEFAULT_KEEP_FLOOR,
    retentionDays = DEFAULT_RETENTION_DAYS,
    now = new Date(),
    dryRun = false,
  } = input;
  const entries = listBackups({ outDir });
  const sorted = entries
    .filter((entry) => entry.createdAt !== null)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const floorCount = Math.max(0, Math.min(Number(keep) || 0, sorted.length));
  const floorIds = new Set(sorted.slice(sorted.length - floorCount).map((entry) => entry.backupId));

  /** @type {Array<{ backupId: string, path: string, createdAt: string, expiresAt: string, reason: string }>} */
  const removed = [];
  /** @type {Array<{ backupId: string, path: string, createdAt: string, expiresAt: string, reason: string }>} */
  const kept = [];

  for (const entry of entries) {
    if (entry.createdAt === null) {
      kept.push({ backupId: entry.backupId, path: entry.path, createdAt: '', expiresAt: '', reason: 'unparseable_created_at' });
      continue;
    }
    const manifestRetention = (() => {
      const manifest = entry.format === 'dir' ? readManifestSafe(entry.path) : null;
      const value = manifest?.retentionDays;
      return typeof value === 'number' && Number.isFinite(value) ? value : retentionDays;
    })();
    const createdMs = Date.parse(entry.createdAt);
    const expiresMs = createdMs + manifestRetention * 86_400_000;
    const expiresAt = new Date(expiresMs).toISOString();
    const expired = now.getTime() >= expiresMs;
    const floorProtected = floorIds.has(entry.backupId);

    if (!expired) {
      kept.push({ backupId: entry.backupId, path: entry.path, createdAt: entry.createdAt, expiresAt, reason: 'not_expired' });
      continue;
    }
    if (floorProtected) {
      kept.push({ backupId: entry.backupId, path: entry.path, createdAt: entry.createdAt, expiresAt, reason: 'retained_by_floor' });
      continue;
    }
    if (!dryRun) {
      try {
        if (entry.format === 'dir') rmSync(entry.path, { recursive: true, force: true });
        else unlinkSync(entry.path);
      } catch (err) {
        kept.push({
          backupId: entry.backupId,
          path: entry.path,
          createdAt: entry.createdAt,
          expiresAt,
          reason: `delete_failed:${err instanceof Error ? err.message : String(err)}`,
        });
        continue;
      }
      if (db !== null) {
        try {
          const clockRef = clock ?? { stamp: () => ({ utc: new Date().toISOString(), local: new Date().toISOString() }) };
          runInTransaction(
            db,
            (tx) => {
              tx.run('DELETE FROM backups WHERE backup_id = ?', [entry.backupId]);
              const stamp = clockRef.stamp();
              tx.run(
                `INSERT INTO audit_logs (audit_id, ts, ts_local, actor, action, target_kind, target_id, result, detail)
                 VALUES (?, ?, ?, 'backup-prune', 'backup.pruned', 'backup', ?, 'ok', ?)`,
                [
                  `aud_${randomBytes(12).toString('hex')}`,
                  stamp.utc,
                  stamp.local,
                  entry.backupId,
                  JSON.stringify({ path: entry.path, format: entry.format, expiresAt, reason: 'expired' }),
                ],
              );
            },
            'backup.prune',
          );
        } catch {
          /* 记录/审计失败不回滚文件删除：文件已按绝对时间到期 */
        }
      }
    }
    removed.push({ backupId: entry.backupId, path: entry.path, createdAt: entry.createdAt, expiresAt, reason: 'expired' });
  }

  return { removed, kept, dryRun, at: now.toISOString() };
}
