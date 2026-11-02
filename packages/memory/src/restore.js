// @ts-check
/**
 * 恢复编排（M3-INTERFACES §5 / 设计方案 21.7、21.8）。
 *
 * 顺序**固定**，不许乱：
 * ```
 * 1. 校验备份完整性（verifyBackup）—— 失败直接拒绝，不许"先恢复再说"
 * 2. 读独立删除账本 —— 缺失 / corrupt / 陈旧 → isolationRequired = true
 * 3. 导入主表（备份快照为基底）
 * 4. 强制合并账本 —— 把备份之后所有删除的 tombstone 重新应用（旧备份不许复活已删内容）
 * 5. 重建派生数据 —— FTS 三表 / ngram（**强制 DROP 重建**，不假设删除 worker 清过）
 * 6. 判定 promoted —— isolationRequired 或 blockers 非空 → false，只能只读检修
 * ```
 *
 * 两个核心不变量：
 * - `planRestore` **只读**：不写库、不建文件、不改账本。UI 预演可以反复调。
 * - `executeRestore` 先**重新预演**（re-check），不信调用方拿来的旧 plan（防 TOCTOU）。
 *
 * `ledger` 按 M3-INTERFACES §1.2 的接口使用：`append / watermark / read / verify / checkForRestore`。
 * 实现可以晚到（del3 并行写 deletion-ledger.js）；本模块只依赖接口，测试注入 fake ledger。
 */

import { randomBytes } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { BackupError } from '@dsh-brain/core';
import {
  BACKUP_BLOBS_DIR,
  BACKUP_DB_FILE,
  BACKUP_MANIFEST_FILE,
  createBackup,
  verifyBackup,
} from './backup.js';
import { openDatabase } from './db.js';
import { defaultMigrationsDir, loadMigrations } from './migrator.js';
import { readDeletionEpoch } from './meta.js';
import { replayLedgerDeletions } from './deletion.js';
import { createDeletionWorker } from './deletion-worker.js';
import { createTxApi, runInTransaction } from './write-queue.js';
import { createSearchIndex, createSearchSchemaStatements, searchTableNames } from '@dsh-brain/search';

/**
 * 隔离原因码：这些**不是**「阻止执行」，而是「可以恢复但必须隔离上架、promoted=false」。
 * 与之相对，`hardBlockers` 里的码才是真阻断（备份损坏 / schema 不兼容 / 目标是活跃库）。
 */
export const ISOLATION_CODES = Object.freeze([
  'LEDGER_MISSING',
  'LEDGER_CORRUPT',
  'LEDGER_STALE_BEHIND_BACKUP',
]);

/** 恢复步骤的固定顺序（ui3 直接展示这份清单）。 */
export const RESTORE_STEP_SEQUENCE = Object.freeze([
  { order: 1, id: 'verify_backup', title: '校验备份完整性（清单哈希 / db 完整性 / ledgerEpoch / 附件 hash）', kind: 'verify', destructive: false },
  { order: 2, id: 'snapshot_current', title: '当前状态另存 _pre-restore-<时间戳>（恢复错了能退）', kind: 'write', destructive: false },
  { order: 3, id: 'read_ledger', title: '读独立删除账本并核对水位', kind: 'read', destructive: false },
  { order: 4, id: 'import_tables', title: '导入主表（备份快照为基底）', kind: 'write', destructive: true },
  { order: 5, id: 'merge_ledger', title: '强制合并账本（重放备份之后的删除）', kind: 'write', destructive: true },
  { order: 6, id: 'rebuild_derived', title: '重建派生数据（FTS 三表 / ngram）', kind: 'write', destructive: true },
  { order: 7, id: 'decide_promotion', title: '判定 promoted（隔离实例不得上线）', kind: 'decide', destructive: false },
]);

/** 错误码 → 人话。 */
const CODE_MESSAGES = Object.freeze({
  LEDGER_MISSING: '独立删除账本不存在：无法证明备份之后的删除已生效，恢复实例必须隔离',
  LEDGER_CORRUPT: '独立删除账本校验失败（链断裂 / checksum 不符）：恢复实例必须隔离',
  LEDGER_STALE_BEHIND_BACKUP: '账本水位早于备份的 deletion_epoch：备份之后有删除没记到账本，恢复会复活已删内容',
  LEDGER_NOT_EXTERNAL: '删除账本与主账在同一块盘：整机损坏会一起丢失，不能抵御同盘故障',
  BACKUP_VERIFY_FAILED: '备份校验未通过，拒绝恢复',
  BACKUP_MISSING: '备份不存在或不是有效备份目录',
  SCHEMA_INCOMPATIBLE: '备份 schema 与当前代码不兼容，跨版本恢复需先走维护流程',
  TARGET_IS_ACTIVE_DB: '目标路径是当前活跃数据库：拒绝原地覆盖，先在隔离路径恢复',
  TARGET_EXISTS: '目标路径已存在，需要显式 allowOverwrite',
  HOST_COPIES_UNHANDLED: '宿主 / 其它插件源记录未处理：Brain 的删除不等于它们也停了',
  BACKUP_OLD: '备份早于保留期：可用但请确认这是想要的时间点',
  LEDGER_EPOCH_CONFLICT: '账本条目 epoch 与备份内 tombstone 冲突：已屏蔽目标但 tombstone 记录不完整',
});

/**
 * @param {string} code
 * @returns {string}
 */
function describeCode(code) {
  return CODE_MESSAGES[code] ?? String(code);
}

/**
 * 把 ledger 返回的 blockers/warnings（字符串或对象）规整成统一形状。
 * @param {unknown} list
 * @param {'blocker' | 'warning'} kind
 * @returns {Array<{ code: string, message: string, kind: string, detail?: unknown }>}
 */
function normalizeIssues(list, kind) {
  /** @type {Array<{ code: string, message: string, kind: string, detail?: unknown }>} */
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (typeof item === 'string') {
      out.push({ code: item, message: describeCode(item), kind });
    } else if (item && typeof item === 'object' && typeof (/** @type {Record<string, unknown>} */ (item).code) === 'string') {
      const record = /** @type {Record<string, unknown>} */ (item);
      out.push({
        code: String(record.code),
        message: typeof record.message === 'string' ? record.message : describeCode(String(record.code)),
        kind,
        detail: record,
      });
    }
  }
  return out;
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `2026-10-28T10:00:00.000Z` → `20261028T100000`
 * @param {string} utcIso
 * @returns {string}
 */
function compactStamp(utcIso) {
  return utcIso.slice(0, 19).replace(/[-:]/g, '');
}

/**
 * @typedef {Object} LedgerCheck
 * @property {boolean} ok
 * @property {number} backupEpoch
 * @property {number | null} ledgerEpoch
 * @property {boolean} stale
 * @property {string | null} reason
 * @property {{ epoch: number, lastSeq: number, updatedAt: string | null } | null} watermark
 * @property {{ ok: boolean, entryCount?: number, lastSeq?: number, corruptAt?: number | null, error?: string } | null} verify
 * @property {boolean} entriesReadable
 * @property {Array<{ code: string, message: string }>} blockers
 * @property {Array<{ code: string, message: string }>} warnings
 */

/**
 * 判定独立删除账本是否支持"恢复后上线"。
 *
 * 判据（del3 契约级接线）：`ledger.watermark().epoch >= backupEpoch` 才 ok；
 * 否则 `LEDGER_STALE_BEHIND_BACKUP`。`checkForRestore` 是强制输入，若账本提供则一并采用。
 *
 * @param {{
 *   ledger: Record<string, any> | null,
 *   backupEpoch: number,
 *   backupCreatedAt: string,
 * }} input
 * @returns {LedgerCheck}
 */
export function evaluateLedger(input) {
  const { ledger, backupEpoch, backupCreatedAt } = input;
  /** @type {LedgerCheck} */
  const check = {
    ok: false,
    backupEpoch,
    ledgerEpoch: null,
    stale: false,
    reason: null,
    watermark: null,
    verify: null,
    entriesReadable: false,
    blockers: [],
    warnings: [],
  };

  if (!ledger || typeof ledger !== 'object') {
    check.reason = 'LEDGER_MISSING';
    check.blockers.push({ code: 'LEDGER_MISSING', message: describeCode('LEDGER_MISSING') });
    return check;
  }

  try {
    const verified = typeof ledger.verify === 'function' ? ledger.verify() : null;
    check.verify = verified ?? null;
    if (!verified || verified.ok !== true) {
      check.reason = 'LEDGER_CORRUPT';
      check.blockers.push({
        code: 'LEDGER_CORRUPT',
        message:
          verified && verified.corruptAt !== undefined && verified.corruptAt !== null
            ? `删除账本校验失败（断点 seq=${String(verified.corruptAt)}）`
            : describeCode('LEDGER_CORRUPT'),
      });
    }
  } catch (err) {
    check.reason = 'LEDGER_CORRUPT';
    check.verify = { ok: false, error: messageOf(err) };
    check.blockers.push({ code: 'LEDGER_CORRUPT', message: `删除账本校验抛错：${messageOf(err)}` });
  }

  try {
    const watermark = typeof ledger.watermark === 'function' ? ledger.watermark() : null;
    const epoch = watermark === null || watermark === undefined ? Number.NaN : Number(watermark.epoch);
    if (!Number.isInteger(epoch) || epoch < 0) {
      if (!check.blockers.some((item) => item.code === 'LEDGER_CORRUPT')) {
        check.reason = 'LEDGER_CORRUPT';
        check.blockers.push({ code: 'LEDGER_CORRUPT', message: '删除账本水位不可读（epoch 非法）' });
      }
    } else {
      check.watermark = {
        epoch,
        lastSeq: Number(watermark.lastSeq ?? 0),
        updatedAt: typeof watermark.updatedAt === 'string' ? watermark.updatedAt : null,
      };
      check.ledgerEpoch = epoch;
      check.entriesReadable = true;
      if (epoch < backupEpoch) {
        check.stale = true;
        check.reason = 'LEDGER_STALE_BEHIND_BACKUP';
        check.blockers.push({
          code: 'LEDGER_STALE_BEHIND_BACKUP',
          message: `账本水位 epoch=${epoch} 早于备份 ledgerEpoch=${backupEpoch}：备份之后的删除没记到账本，恢复会复活`,
        });
      }
    }
  } catch (err) {
    if (!check.blockers.some((item) => item.code === 'LEDGER_CORRUPT')) {
      check.reason = 'LEDGER_CORRUPT';
      check.blockers.push({ code: 'LEDGER_CORRUPT', message: `删除账本水位读取抛错：${messageOf(err)}` });
    }
  }

  // 强制输入：账本自己给出的判定（M3-INTERFACES §1.2）。
  if (typeof ledger.checkForRestore === 'function') {
    try {
      const result = ledger.checkForRestore({ backupEpoch, backupCreatedAt });
      for (const issue of normalizeIssues(result?.blockers, 'blocker')) {
        if (!check.blockers.some((item) => item.code === issue.code)) {
          check.blockers.push({ code: issue.code, message: issue.message });
        }
      }
      for (const issue of normalizeIssues(result?.warnings, 'warning')) {
        check.warnings.push({ code: issue.code, message: issue.message });
      }
    } catch (err) {
      check.blockers.push({ code: 'LEDGER_CORRUPT', message: `checkForRestore 抛错：${messageOf(err)}` });
    }
  }

  // 归一化：账本目录都不存在时，我的通用 verify 只能看到「不可用」，
  // 权威输入 `checkForRestore` 会给出更准确的 LEDGER_MISSING。两者同时出现时保留 MISSING。
  if (check.blockers.some((item) => item.code === 'LEDGER_MISSING')) {
    check.blockers = check.blockers.filter((item) => item.code !== 'LEDGER_CORRUPT');
    if (check.reason === 'LEDGER_CORRUPT') check.reason = 'LEDGER_MISSING';
  }

  check.ok = check.blockers.length === 0;
  return check;
}

/**
 * @typedef {Object} PlanRestoreInput
 * @property {string} backupDir 目录形态备份
 * @property {Record<string, any> | null} [ledger]
 * @property {Array<{ system: string, handled: boolean }>} [hostCopies]
 * @property {string | null} [targetDir] 预演目标路径（只做检查，不写）
 * @property {string | null} [dbPath] 当前活跃库路径（用于拒绝 TARGET_IS_ACTIVE_DB）
 * @property {string} [migrationsDir]
 * @property {Date} [now]
 */

/**
 * 只读预演一次恢复。**不写任何东西**。
 *
 * `ok` 只表示「允许执行恢复」；是否允许上线看 `promoted`（execute 返回）与 `isolationRequired`。
 * 也就是说：`ok === true && isolationRequired === true` → 可以恢复到隔离实例，promoted 必为 false。
 *
 * @param {PlanRestoreInput} input
 * @returns {{
 *   ok: boolean,
 *   blockers: Array<{ code: string, message: string }>,
 *   hardBlockers: Array<{ code: string, message: string }>,
 *   warnings: Array<{ code: string, message: string }>,
 *   backup: Record<string, any> | null,
 *   ledgerCheck: LedgerCheck,
 *   isolationRequired: boolean,
 *   isolationReasons: Array<{ code: string, message: string }>,
 *   steps: Array<{ order: number, id: string, title: string, kind: string, destructive: boolean, willDo: boolean }>,
 *   target: { dir: string | null, exists: boolean },
 *   at: string,
 *   hostCopies: Array<{ system: string, handled: boolean }>,
 * }}
 */
export function planRestore(input) {
  const {
    backupDir,
    ledger = null,
    hostCopies = [],
    targetDir = null,
    dbPath = null,
    migrationsDir = defaultMigrationsDir(),
    now = new Date(),
  } = input ?? {};
  const at = (now instanceof Date ? now : new Date(now)).toISOString();
  /** @type {Array<{ code: string, message: string }>} */
  const blockers = [];
  /** @type {Array<{ code: string, message: string }>} */
  const hardBlockers = [];
  /** @type {Array<{ code: string, message: string }>} */
  const warnings = [];

  // 1) 校验备份（硬阻断）
  const verification = verifyBackup(String(backupDir ?? ''));
  if (!verification.ok) {
    for (const problem of verification.problems) {
      hardBlockers.push({
        code: problem.code === 'BACKUP_MISSING' ? 'BACKUP_MISSING' : 'BACKUP_VERIFY_FAILED',
        message: problem.message,
      });
    }
  }
  const manifest = verification.manifest;
  /** @type {Record<string, any> | null} */
  const backup = manifest === null
    ? null
    : {
        dir: backupDir,
        backupId: String(manifest.backupId ?? ''),
        label: typeof manifest.label === 'string' ? manifest.label : null,
        kind: typeof manifest.kind === 'string' ? manifest.kind : null,
        createdAt: typeof manifest.createdAt === 'string' ? manifest.createdAt : '',
        createdAtLocal: typeof manifest.createdAtLocal === 'string' ? manifest.createdAtLocal : '',
        formatVersion: Number(manifest.formatVersion ?? 0),
        schemaVersion: verification.schemaVersion,
        watermark: verification.watermark ?? { maxSourceSeq: null, lastReceivedAt: null, eventCount: 0 },
        ledgerEpoch: verification.ledgerEpoch,
        deletionEpoch: verification.ledgerEpoch,
        tables: verification.tables,
        blobs: verification.blobs,
        manifestHash: verification.manifestHash,
        dbSha256: typeof manifest.db?.sha256 === 'string' ? manifest.db.sha256 : null,
        dbByteSize: typeof manifest.db?.byteSize === 'number' ? manifest.db.byteSize : null,
        verified: verification.ok,
        retentionDays: Number(manifest.retentionDays ?? 7),
      };

  // 2) schema 兼容（硬阻断）：M3 不做跨版本自动迁移，避免在恢复路径里引入新的不确定性。
  /** @type {string | null} */
  let latestMigration = null;
  try {
    const migrations = loadMigrations(migrationsDir);
    latestMigration = migrations.length > 0 ? migrations[migrations.length - 1].version : null;
  } catch {
    latestMigration = null;
  }
  if (backup !== null && latestMigration !== null && backup.schemaVersion !== latestMigration) {
    hardBlockers.push({
      code: 'SCHEMA_INCOMPATIBLE',
      message: `备份 schema=${String(backup.schemaVersion)}，当前代码最新 migration=${latestMigration}：跨版本恢复需先走维护流程`,
    });
  }

  // 3) 目标路径（活跃库硬阻断；已存在只告警，由 execute 决定 allowOverwrite）
  const resolvedTarget = typeof targetDir === 'string' && targetDir.length > 0 ? path.resolve(targetDir) : null;
  if (resolvedTarget !== null && typeof dbPath === 'string' && path.resolve(dbPath) === resolvedTarget) {
    hardBlockers.push({ code: 'TARGET_IS_ACTIVE_DB', message: describeCode('TARGET_IS_ACTIVE_DB') });
  }
  if (resolvedTarget !== null && existsSync(resolvedTarget)) {
    warnings.push({ code: 'TARGET_EXISTS', message: describeCode('TARGET_EXISTS') });
  }

  // 4) 独立删除账本（隔离原因，不是硬阻断）
  const ledgerCheck = evaluateLedger({
    ledger,
    backupEpoch: backup?.ledgerEpoch ?? 0,
    backupCreatedAt: backup?.createdAt ?? '',
  });
  blockers.push(...ledgerCheck.blockers);
  warnings.push(...ledgerCheck.warnings);

  // 5) 其它如实告警
  const copies = Array.isArray(hostCopies) ? hostCopies : [];
  const unhandledHost = copies.filter((copy) => !copy?.handled);
  if (unhandledHost.length > 0) {
    warnings.push({
      code: 'HOST_COPIES_UNHANDLED',
      message: `${unhandledHost.length} 个宿主 / 其它插件源记录未处理：只屏蔽 Brain 不等于它们也删了`,
    });
  }
  if (backup !== null) {
    const createdMs = Date.parse(backup.createdAt);
    if (Number.isFinite(createdMs)) {
      const ageDays = (Date.parse(at) - createdMs) / 86_400_000;
      if (ageDays > Number(backup.retentionDays ?? 7)) {
        warnings.push({
          code: 'BACKUP_OLD',
          message: `备份已 ${ageDays.toFixed(1)} 天前（保留期 ${String(backup.retentionDays ?? 7)} 天），请确认这就是想要的时间点`,
        });
      }
    }
  }

  const isolationReasons = blockers.filter((item) => ISOLATION_CODES.includes(item.code));
  const isolationRequired = isolationReasons.length > 0;
  const allHard = [...hardBlockers, ...blockers.filter((item) => !ISOLATION_CODES.includes(item.code))];
  const ok = allHard.length === 0;

  const steps = RESTORE_STEP_SEQUENCE.map((step) => ({
    ...step,
    willDo:
      step.id === 'import_tables' || step.id === 'rebuild_derived' || step.id === 'decide_promotion'
        ? ok
        : step.id === 'merge_ledger'
          ? ok && ledgerCheck.entriesReadable
          : step.id === 'verify_backup'
            ? true
            : step.id === 'snapshot_current'
              ? true
              : ok,
  }));

  return {
    ok,
    blockers,
    hardBlockers: allHard,
    warnings,
    backup,
    ledgerCheck,
    isolationRequired,
    isolationReasons,
    steps,
    target: { dir: resolvedTarget, exists: resolvedTarget !== null ? existsSync(resolvedTarget) : false },
    at,
    hostCopies: copies,
  };
}

/**
 * 读账本全部条目（分页循环，有硬上限防死循环）。
 * @param {Record<string, any> | null} ledger
 * @returns {{ ok: boolean, entries: Array<Record<string, any>>, error: string | null }}
 */
export function readLedgerEntries(ledger) {
  if (!ledger || typeof ledger.read !== 'function') {
    return { ok: false, entries: [], error: 'ledger 不可读' };
  }
  /** @type {Array<Record<string, any>>} */
  const entries = [];
  let sinceSeq = 0;
  try {
    for (let guard = 0; guard < 10_000; guard += 1) {
      const page = ledger.read({ sinceSeq, limit: 500 });
      const list = Array.isArray(page?.entries) ? page.entries : [];
      entries.push(...list);
      const nextSeq = Number(page?.nextSeq ?? 0);
      if (list.length === 0 || !Number.isFinite(nextSeq) || nextSeq <= sinceSeq) break;
      sinceSeq = nextSeq;
    }
    return { ok: true, entries, error: null };
  } catch (err) {
    return { ok: false, entries, error: messageOf(err) };
  }
}

/**
 * 从账本读「备份之后」的删除条目（M3-INTERFACES §5.1 第 4 步的输入）。
 *
 * 优先用 del3 的 `readAfterEpoch(backupEpoch)`；没有该方法时退化为「读全量 + 按 epoch 过滤」，
 * 接口替身（测试 fake）走这条。
 *
 * @param {Record<string, any> | null} ledger
 * @param {number} backupEpoch
 * @returns {{ ok: boolean, entries: Array<Record<string, any>>, error: string | null }}
 */
export function readEntriesAfterEpoch(ledger, backupEpoch) {
  if (!ledger) return { ok: false, entries: [], error: 'ledger 不可用' };
  if (typeof ledger.readAfterEpoch === 'function') {
    try {
      const entries = ledger.readAfterEpoch(Number(backupEpoch));
      return { ok: true, entries: Array.isArray(entries) ? entries : [], error: null };
    } catch (err) {
      return { ok: false, entries: [], error: messageOf(err) };
    }
  }
  const read = readLedgerEntries(ledger);
  if (!read.ok) return read;
  return {
    ok: true,
    entries: read.entries.filter((entry) => Number(entry?.epoch ?? 0) > Number(backupEpoch)),
    error: null,
  };
}

/**
 * 强制重放：把备份之后的删除重新应用到**刚恢复的库**（M3-INTERFACES §5.1 第 4 步）。
 *
 * 用 del3 的 `replayLedgerDeletions`，不自己写一遍，也**不走** `requestDeletion`：
 * - 后者会 bump epoch 并回写账本，而恢复过程不该写账本；
 * - 恢复库的 epoch 起点低于账本水位时，账本单调约束会直接拒绝（del3 踩过）。
 *
 * 恢复库是独立连接，这里给它包一个同步 queue：`replayLedgerDeletions` 只要求
 * `queue.write(tx => ...)`，用 `runInTransaction` 实现就是单库串行事务。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   clock: { stamp: () => { utc: string, local: string } },
 *   entries: Array<Record<string, any>>,
 *   ledgerEpoch?: number | null,
 * }} input
 * @returns {Promise<{
 *   ok: boolean, applied: number, skipped: number, epoch: number,
 *   results: Array<Record<string, any>>, problems: string[],
 * }>}
 */
export async function replayLedgerIntoRestoredDb(input) {
  const { db, clock, entries, ledgerEpoch = null } = input;
  const queue = {
    /**
     * @template T
     * @param {(tx: import('./write-queue.js').TxApi) => T} fn
     * @returns {Promise<T>}
     */
    write: async (fn) => runInTransaction(db, fn, 'restore.replay'),
  };
  /** @type {{ applied: number, skipped: number, results: Array<Record<string, any>> }} */
  let result = { applied: 0, skipped: 0, results: [] };
  try {
    const replayed = await replayLedgerDeletions({ db, queue, clock }, entries ?? []);
    result = {
      applied: Number(replayed?.applied ?? 0),
      skipped: Number(replayed?.skipped ?? 0),
      results: Array.isArray(replayed?.results) ? replayed.results : [],
    };
  } catch (err) {
    return {
      ok: false,
      applied: 0,
      skipped: 0,
      epoch: readDeletionEpoch(createTxApi(db)),
      results: [],
      problems: [`REPLAY_FAILED:${messageOf(err)}`],
    };
  }

  // 重放之后把恢复库 deletion_epoch 抬到 max(当前, 账本水位)：只抬不降。
  const current = readDeletionEpoch(createTxApi(db));
  const targetEpoch = Math.max(current, Number(ledgerEpoch ?? 0));
  if (targetEpoch > current) {
    runInTransaction(
      db,
      (tx) => {
        const stamp = clock.stamp();
        tx.run(
          `INSERT INTO brain_meta (key, value, updated_at, updated_at_local)
           VALUES ('deletion_epoch', ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at,
             updated_at_local = excluded.updated_at_local`,
          [String(targetEpoch), stamp.utc, stamp.local],
        );
      },
      'restore.replayEpoch',
    );
  }
  return {
    ok: true,
    applied: result.applied,
    skipped: result.skipped,
    epoch: targetEpoch,
    results: result.results,
    problems: [],
  };
}

/**
 * 重放后校验：确认被删内容在**主表 / FTS 三表 / context_packages** 里都读不到。
 *
 * 硬约束：允许恢复，但不许「恢复完发现删的东西回来了还让它上线」。
 * 必须在派生数据重建之后调用（重建后索引只含存活记忆）。
 *
 * @param {{ db: import('node:sqlite').DatabaseSync, entries: Array<Record<string, any>> }} input
 * @returns {{
 *   ok: boolean,
 *   checked: number,
 *   problems: Array<{ code: string, target_id: string, table?: string }>,
 * }}
 */
export function verifyDeletionsEffective(input) {
  const { db, entries } = input;
  /** @type {Array<{ code: string, target_id: string, table?: string }>} */
  const problems = [];
  /** @param {string} name */
  const tableExists = (name) =>
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE (type = 'table' OR type = 'view') AND name = ?").get(name) !== undefined;
  /** @type {Set<string>} */
  const targets = new Set();
  for (const entry of entries ?? []) {
    const targetId = String(entry?.targetId ?? entry?.memoryId ?? '');
    if (targetId.length > 0) targets.add(targetId);
  }
  // 备份内已经删掉（tombstone 已在快照里）的记忆也必须一起校验：
  // 「删了的东西恢复后仍然没有」不分它是在备份前删还是备份后删。
  for (const row of /** @type {Array<{ id: string }>} */ (
    db.prepare("SELECT id FROM memories WHERE status = 'deleted'").all()
  )) {
    targets.add(String(row.id));
  }
  for (const targetId of targets) {
    const memory = /** @type {Record<string, any> | undefined} */ (
      db.prepare('SELECT status, content, summary FROM memories WHERE id = ?').get(targetId)
    );
    if (
      memory !== undefined &&
      (String(memory.status) !== 'deleted' || memory.content !== null || memory.summary !== null)
    ) {
      problems.push({ code: 'MEMORY_STILL_READABLE', target_id: targetId });
    }
    for (const table of ['search_fts_char', 'search_fts_trigram', 'search_ngram']) {
      if (!tableExists(table)) continue;
      const hit = db.prepare(`SELECT 1 AS hit FROM ${table} WHERE doc_id = ? LIMIT 1`).get(targetId);
      if (hit !== undefined) problems.push({ code: 'INDEX_STILL_READABLE', target_id: targetId, table });
    }
    if (tableExists('context_packages')) {
      const packageHit = db
        .prepare(
          `SELECT 1 AS hit FROM context_packages
            WHERE status IN ('built', 'attached') AND memory_versions LIKE ? LIMIT 1`,
        )
        .get(`%${targetId}%`);
      if (packageHit !== undefined) problems.push({ code: 'CONTEXT_PACKAGE_STILL_READABLE', target_id: targetId });
    }
  }
  return { ok: problems.length === 0, checked: targets.size, problems };
}
/**
 * 强制重建派生数据（FTS 三表 + ngram）。
 *
 * **不假设删除 worker 已经清过索引**：先 DROP 再按 search 包的权威 DDL 重建，
 * 然后只索引「未被删除且正文仍在」的记忆。这样即使备份里的 FTS 与 memories 已经不一致，
 * 恢复后也是自洽的。
 *
 * @param {{ db: import('node:sqlite').DatabaseSync }} input
 * @returns {{ ok: boolean, derived: string[], indexed: number, docCount: number | null }}
 */
export function rebuildDerivedIndexes(input) {
  const { db } = input;
  const names = searchTableNames();
  db.exec(`DROP TABLE IF EXISTS ${names.ngram}`);
  db.exec(`DROP TABLE IF EXISTS ${names.ftsTrigram}`);
  db.exec(`DROP TABLE IF EXISTS ${names.ftsChar}`);
  for (const statement of createSearchSchemaStatements()) {
    db.exec(statement.sql);
  }
  const index = createSearchIndex(db, {
    prefix: 'search',
    docSource: { table: 'memories', idColumn: 'id', textColumn: 'content' },
    likeSource: 'index',
  });
  const rows = /** @type {Array<{ id: string, content: string }>} */ (
    db
      .prepare(
        `SELECT id, content FROM memories
          WHERE status <> 'deleted' AND deletion_epoch = 0
            AND content IS NOT NULL AND content <> ''
          ORDER BY created_at ASC`,
      )
      .all()
  );
  index.indexDocs(rows.map((row) => ({ id: String(row.id), content: String(row.content) })));
  const docCount = typeof index.refreshDocCount === 'function' ? index.refreshDocCount() : null;
  return {
    ok: true,
    derived: ['fts_char', 'fts_trigram', 'ngram'],
    indexed: rows.length,
    docCount,
  };
}

/**
 * 在恢复库写一条审计（不记正文）。
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   clock: { stamp: () => { utc: string, local: string } },
 *   detail: Record<string, unknown>,
 *   result?: 'ok' | 'error',
 * }} input
 */
function writeRestoreAudit(input) {
  const { db, clock, detail, result = 'ok' } = input;
  try {
    runInTransaction(
      db,
      (tx) => {
        const stamp = clock.stamp();
        tx.run(
          `INSERT INTO audit_logs (audit_id, ts, ts_local, actor, action, target_kind, result, detail)
           VALUES (?, ?, ?, 'restore', 'restore.executed', 'backup', ?, ?)`,
          [
            `aud_${randomBytes(12).toString('hex')}`,
            stamp.utc,
            stamp.local,
            result,
            JSON.stringify(detail).slice(0, 8000),
          ],
        );
      },
      'restore.audit',
    );
  } catch {
    /* 审计失败不改变恢复结论；结论已经在返回值里 */
  }
}

/**
 * @typedef {Object} ExecuteRestoreOptions
 * @property {import('node:sqlite').DatabaseSync | null} [db] 当前活跃库（用于另存 _pre-restore）
 * @property {{ write: Function, drain: Function } | null} [queue]
 * @property {{ stamp: () => { utc: string, local: string } }} clock
 * @property {string} [targetDir]
 * @property {string} [backupDir]
 * @property {Record<string, any> | null} [ledger]
 * @property {Array<{ system: string, handled: boolean }>} [hostCopies]
 * @property {string | null} [blobsDir]
 * @property {{ begin: Function, end: Function } | null} [blobGuard]
 * @property {string} [preRestoreRoot]
 * @property {string} [migrationsDir]
 * @property {string | null} [dbPath]
 * @property {boolean} [allowOverwrite]
 * @property {Date} [now]
 */

/**
 * 执行恢复（顺序固定）。
 *
 * 返回 `promoted`：**true 仅表示"可以交给进程编排切换上线"**，本函数不做进程切换。
 * `promoted=false` 时调用方必须拒绝提供正常服务（只允许只读检修）。
 *
 * @param {ReturnType<typeof planRestore> | null} plan
 * @param {ExecuteRestoreOptions} options
 */
export async function executeRestore(plan, options) {
  const clock = options?.clock;
  if (!clock || typeof clock.stamp !== 'function') {
    throw new BackupError('BACKUP_ERROR', 'executeRestore 需要 clock');
  }
  const backupDir = options.backupDir ?? plan?.backup?.dir;
  const targetDir = options.targetDir ?? plan?.target?.dir;
  if (typeof backupDir !== 'string' || backupDir.length === 0) {
    throw new BackupError('BACKUP_ERROR', 'executeRestore 需要 backupDir');
  }
  if (typeof targetDir !== 'string' || targetDir.length === 0) {
    throw new BackupError('BACKUP_ERROR', 'executeRestore 需要 targetDir');
  }
  const resolvedTarget = path.resolve(targetDir);
  const ledger = options.ledger ?? null;
  const hostCopies = options.hostCopies ?? plan?.hostCopies ?? [];
  const migrationsDir = options.migrationsDir ?? defaultMigrationsDir();
  const now = options.now ?? new Date();
  const db = options.db ?? null;
  const queue = options.queue ?? null;
  const blobsDir = options.blobsDir ?? null;
  const blobGuard = options.blobGuard ?? null;
  const preRestoreRoot =
    options.preRestoreRoot ?? path.join(path.dirname(resolvedTarget), '_pre-restore');
  const allowOverwrite = options.allowOverwrite === true;

  // 0) 重新预演：不信旧 plan（备份可能在预演之后被改/被删）。
  const recheck = planRestore({
    backupDir,
    ledger,
    hostCopies,
    targetDir: resolvedTarget,
    dbPath: options.dbPath ?? null,
    migrationsDir,
    now,
  });
  if (!recheck.ok) {
    const first = recheck.hardBlockers[0];
    const refusalCodes = new Set(['TARGET_IS_ACTIVE_DB', 'TARGET_EXISTS']);
    const code = first && refusalCodes.has(first.code) ? 'RESTORE_REFUSED' : 'BACKUP_VERIFY_FAILED';
    throw new BackupError(code, '恢复预演未通过（硬阻断），拒绝执行', {
      details: { blockers: recheck.hardBlockers },
    });
  }
  if (recheck.target.exists && !allowOverwrite) {
    throw new BackupError('RESTORE_REFUSED', describeCode('TARGET_EXISTS'), {
      details: { target_path: resolvedTarget },
    });
  }

  /** @type {Array<{ id: string, ok: boolean, detail: string }>} */
  const steps = [];
  /** @param {string} id @param {boolean} ok @param {string} detail */
  const step = (id, ok, detail) => steps.push({ id, ok, detail });

  // 1) 校验备份（recheck 已完成，这里只记录证据）。
  step('verify_backup', true, `manifestHash=${String(recheck.backup?.manifestHash ?? '')}`);

  // 2) 当前状态另存 _pre-restore-<时间戳>
  /** @type {string | null} */
  let preRestoreDir = null;
  if (db !== null) {
    const preId = `_pre-restore-${compactStamp(now.toISOString())}`;
    try {
      const preBackup = await createBackup({
        db,
        outDir: preRestoreRoot,
        clock,
        queue,
        kind: 'pre_restore',
        label: '_pre-restore',
        backupId: preId,
        blobsDir,
        blobGuard,
      });
      preRestoreDir = preBackup.dir;
      step('snapshot_current', true, preRestoreDir);
    } catch (err) {
      // 回滚点做不出来就不能动主表：恢复错了没法退。
      step('snapshot_current', false, messageOf(err));
      throw new BackupError('BACKUP_ERROR', `恢复前另存当前状态失败，拒绝继续：${messageOf(err)}`, { cause: err });
    }
  } else {
    step('snapshot_current', true, 'skipped: 无活跃库（整盘恢复场景，回滚点由调用方负责）');
  }

  // 3) 读账本 + 只取「备份之后」的删除（这是重放的输入；备份内已含的删除不重复应用）
  const ledgerEntries = readLedgerEntries(ledger);
  const backupEpoch = Number(recheck.backup?.ledgerEpoch ?? 0);
  const toReplay = readEntriesAfterEpoch(ledger, backupEpoch);
  step(
    'read_ledger',
    recheck.ledgerCheck.entriesReadable,
    `after_backup=${toReplay.entries.length} total=${ledgerEntries.entries.length} backupEpoch=${backupEpoch} watermark=${String(recheck.ledgerCheck.watermark?.epoch ?? 'null')}`,
  );

  // 4) 导入主表：备份快照为基底，落在隔离临时目录。
  const tmpDir = `${resolvedTarget}.restore-tmp`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const sourceDb = path.join(backupDir, BACKUP_DB_FILE);
  copyFileSync(sourceDb, path.join(tmpDir, BACKUP_DB_FILE));
  const manifestFile = path.join(backupDir, BACKUP_MANIFEST_FILE);
  if (existsSync(manifestFile)) copyFileSync(manifestFile, path.join(tmpDir, BACKUP_MANIFEST_FILE));
  const sourceBlobs = path.join(backupDir, BACKUP_BLOBS_DIR);
  if (existsSync(sourceBlobs)) cpSync(sourceBlobs, path.join(tmpDir, BACKUP_BLOBS_DIR), { recursive: true });
  step('import_tables', true, `来自 ${sourceDb}`);

  /** @type {{ ok: boolean, applied: number, skipped: number, epoch: number, problems: string[], results: Array<Record<string, any>> }} */
  let merged = { ok: false, applied: 0, skipped: 0, epoch: 0, problems: [], results: [] };
  /** @type {{ ok: boolean, checked: number, problems: Array<{ code: string, target_id: string, table?: string }> }} */
  let verification = { ok: false, checked: 0, problems: [] };
  /** @type {{ ok: boolean, derived: string[], indexed: number, docCount: number | null }} */
  let rebuilt = { ok: false, derived: [], indexed: 0, docCount: null };
  let promoted = false;
  let reason = '';

  const opened = openDatabase({ path: path.join(tmpDir, BACKUP_DB_FILE) });
  const targetDb = opened.db;
  try {
    // 5) 强制重放账本（必须在导入主表之后）：用 del3 的 replayLedgerDeletions，幂等、不写账本
    try {
      merged = await replayLedgerIntoRestoredDb({
        db: targetDb,
        clock,
        entries: toReplay.entries,
        ledgerEpoch: recheck.ledgerCheck.watermark?.epoch ?? null,
      });
      // 5.5) 重放只负责「墓碑 + 立即屏蔽 + 排清理 job」。恢复库是独立连接，
      //      这里跑 del3 的删除 worker 把正文物理清掉——备份里已有的 pending 清理 job
      //      （备份前就删掉的记忆）也会在这一步被处理，否则它们恢复后还能直接读到。
      try {
        const restoreQueue = {
          /** @template T @param {(tx: import('./write-queue.js').TxApi) => T} fn @returns {Promise<T>} */
          write: async (fn) => runInTransaction(targetDb, fn, 'restore.purge'),
        };
        const worker = createDeletionWorker({
          db: targetDb,
          queue: restoreQueue,
          clock,
          dbPath: path.join(tmpDir, BACKUP_DB_FILE),
          exportsDir: null,
          blobsDir: null,
        });
        const purged = await worker.runOnce({ maxJobs: 1000 });
        merged = { ...merged, purged, ok: merged.ok && Number(purged?.failed ?? 0) === 0 };
      } catch (err) {
        merged = {
          ...merged,
          ok: false,
          problems: [...merged.problems, `PURGE_FAILED:${messageOf(err)}`],
        };
      }
      step(
        'merge_ledger',
        merged.ok,
        `replayed=${merged.applied} skipped=${merged.skipped} purged=${Number(merged.purged?.processed ?? 0)} failed=${Number(merged.purged?.failed ?? 0)}`,
      );
    } catch (err) {
      step('merge_ledger', false, messageOf(err));
    }

    // 6) 重建派生数据（不假设 worker 清过 FTS）
    try {
      rebuilt = rebuildDerivedIndexes({ db: targetDb });
      step('rebuild_derived', rebuilt.ok, `indexed=${rebuilt.indexed} docCount=${String(rebuilt.docCount)}`);
    } catch (err) {
      rebuilt = { ok: false, derived: [], indexed: 0, docCount: null };
      step('rebuild_derived', false, messageOf(err));
    }

    // 6.5) 重放后校验：被删内容在主表 / FTS 三表 / context_packages 里都必须读不到。
    //      「允许恢复」不等于「允许恢复完发现删的东西回来了还上线」。
    if (merged.ok) {
      try {
        verification = verifyDeletionsEffective({ db: targetDb, entries: toReplay.entries });
      } catch (err) {
        verification = {
          ok: false,
          checked: 0,
          problems: [{ code: `VERIFY_FAILED:${messageOf(err)}`, target_id: '' }],
        };
      }
    }

    // 7) 判定
    const isolationBlocked = recheck.isolationRequired;
    promoted = merged.ok && rebuilt.ok && verification.ok && !isolationBlocked;
    if (isolationBlocked) {
      reason = `isolation_required:${recheck.isolationReasons.map((item) => item.code).join(',')}`;
    } else if (!merged.ok) {
      reason = 'ledger_merge_failed';
    } else if (!rebuilt.ok) {
      reason = 'derived_rebuild_failed';
    } else if (!verification.ok) {
      reason = 'replay_verification_failed';
    } else {
      reason = 'all_checks_passed';
    }
    step('decide_promotion', true, `promoted=${promoted} reason=${reason}`);

    writeRestoreAudit({
      db: targetDb,
      clock,
      result: promoted ? 'ok' : 'error',
      detail: {
        backup_dir: backupDir,
        backup_id: recheck.backup?.backupId ?? null,
        backup_ledger_epoch: recheck.backup?.ledgerEpoch ?? null,
        ledger_epoch: recheck.ledgerCheck.watermark?.epoch ?? null,
        isolation_required: recheck.isolationRequired,
        isolation_reasons: recheck.isolationReasons.map((item) => item.code),
        replay: { applied: merged.applied, skipped: merged.skipped, epoch: merged.epoch },
        rebuilt: { ok: rebuilt.ok, indexed: rebuilt.indexed },
        verification: { ok: verification.ok, checked: verification.checked, problems: verification.problems },
        promoted,
        reason,
        pre_restore_dir: preRestoreDir,
      },
    });
  } finally {
    targetDb.close();
  }

  // 落位：目标已存在时先改名留底（回滚点是 _pre-restore，这里是就地留底）。
  if (existsSync(resolvedTarget)) {
    const replaced = `${resolvedTarget}.replaced-${compactStamp(new Date().toISOString())}`;
    rmSync(replaced, { recursive: true, force: true });
    renameSync(resolvedTarget, replaced);
  }
  mkdirSync(path.dirname(resolvedTarget), { recursive: true });
  renameSync(tmpDir, resolvedTarget);

  return {
    restoredAt: clock.stamp().utc,
    promoted,
    reason,
    blockers: recheck.blockers,
    hardBlockers: recheck.hardBlockers,
    warnings: recheck.warnings,
    isolationRequired: recheck.isolationRequired,
    backup: {
      dir: backupDir,
      backupId: recheck.backup?.backupId ?? null,
      createdAt: recheck.backup?.createdAt ?? null,
      schemaVersion: recheck.backup?.schemaVersion ?? null,
      ledgerEpoch: recheck.backup?.ledgerEpoch ?? null,
      watermark: recheck.backup?.watermark ?? null,
      manifestHash: recheck.backup?.manifestHash ?? null,
    },
    ledger: {
      ok: ledgerEntries.ok,
      verify: recheck.ledgerCheck.verify,
      watermark: recheck.ledgerCheck.watermark,
      stale: recheck.ledgerCheck.stale,
      reason: recheck.ledgerCheck.reason,
      entries: ledgerEntries.entries.length,
      afterBackup: toReplay.entries.length,
      readError: ledgerEntries.error,
    },
    merged,
    replayed: merged,
    verification,
    rebuilt,
    steps,
    targetDir: resolvedTarget,
    targetDbPath: path.join(resolvedTarget, BACKUP_DB_FILE),
    preRestoreDir,
    requiresRestart: true,
  };
}

/**
 * 绑定活跃库的恢复服务，方便 HTTP 层直接调用（ui3 用）。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   dbPath: string,
 *   queue: { write: Function, drain: Function } | null,
 *   clock: { stamp: () => { utc: string, local: string } },
 *   blobsDir?: string | null,
 *   blobGuard?: ReturnType<import('./backup.js').createBlobReaderGuard> | null,
 * }} options
 */
export function createRestoreService(options) {
  const { db, dbPath, queue, clock, blobsDir = null, blobGuard = null } = options;
  return {
    /** 只读预演。 */
    plan(/** @type {PlanRestoreInput} */ input) {
      return planRestore({ ...input, dbPath, blobsDir, migrationsDir: defaultMigrationsDir() });
    },
    /** 执行恢复。 */
    execute(
      /** @type {ReturnType<typeof planRestore> | null} */ plan,
      /** @type {Partial<ExecuteRestoreOptions>} */ opts = {},
    ) {
      return executeRestore(plan, {
        db,
        dbPath,
        queue,
        clock,
        blobsDir,
        blobGuard,
        ...opts,
      });
    },
  };
}
