// @ts-check
/**
 * M3 治理与恢复的适配层：删除四层报告、备份中心、恢复预演、隔离判定。
 *
 * 三个不能糊的地方（写完这篇文件的主要目的就是把它们分开）：
 *
 * 1. **「已删除」不是一件事，是四件事。**
 *    立即屏蔽（写墓碑那一刻，一定完成）/ 在线清理（可能还没跑、可能失败）/
 *    旧备份到期（可能还有一份备份里躺着内容）/ 外部与其它插件源（我们管不到，只能标未核实）。
 *    把它们合成一个绿色「已删除」，就是对本人的误导。
 *
 * 2. **拿不到就写「无法核实」，不写 false 也不写 0。**
 *    账本没接入时 `ledgerSynced=null`（未知），不是 `false`（没记）——这两者含义完全不同。
 *
 * 3. **能力缺失返回 not_available，不返回 500。**
 *    del3 / backup3 的门面在并行开发，缺失是正常状态，不是服务故障。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** 恢复真执行必须携带的确认串。故意不可能被顺手带上。 */
export const RESTORE_CONFIRM_TOKEN = 'RESTORE';

/** 恢复状态文件名（隔离横幅的依据之一）。 */
const RESTORE_STATE_FILE = 'restore-state.json';

/** 独立删除账本的默认位置（M3-INTERFACES §1.1）。 */
const DELETION_LEDGER_DIRNAME = 'deletion-ledger';

/** 备份目录名白名单：只允许单层、无上级引用、无分隔符。 */
const SAFE_DIR_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

/**
 * @param {string} message
 * @param {string} [code]
 */
function fail(message, code = 'INVALID_ARGUMENT') {
  const err = /** @type {Error & {code?: string}} */ (new Error(message));
  err.code = code;
  return err;
}

/** 能力未接入：走 501，跟 500 分开。 */
function notAvailable(what) {
  const err = /** @type {Error & {code?: string, details?: Record<string, unknown>}} */ (
    new Error(`${what} 尚未接入（对应门面不存在）`)
  );
  err.code = 'NOT_AVAILABLE';
  err.details = { capability: what };
  return err;
}

/**
 * 探测一个门面对象上有没有必需的方法。
 * @param {unknown} candidate
 * @param {string[]} required
 */
function hasMethods(candidate, required) {
  if (candidate === null || typeof candidate !== 'object') return false;
  return required.every((m) => typeof (/** @type {any} */ (candidate)[m]) === 'function');
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** @param {number} n */
function asInt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/**
 * @param {string} createdAt ISO
 * @param {number} days
 */
function addDays(createdAt, days) {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return null;
  return new Date(d.getTime() + days * 86400_000).toISOString();
}

/**
 * 创建治理适配层。
 *
 * @param {{
 *   store: ReturnType<typeof import('./store.mjs').openStore>,
 *   config: import('./config.mjs').ServerConfig,
 *   logger: import('./log.mjs').Logger,
 * }} deps
 */
export function createGovernance({ store, config, logger }) {
  const db = store.db;
  const brain = /** @type {any} */ (store.brain);
  const readOnly = config.readOnlyDb === true;
  const stateDir = config.stateDir;
  const backupDir = config.backupDir ?? path.join(process.cwd(), 'data', 'backups');
  const keepDays = config.backupKeepDays ?? 7;

  // ---------------------------------------------------------------------
  // 门面探测：缺失是常态（并行开发），不是故障
  // ---------------------------------------------------------------------

  const facades = {
    /** del3：独立删除账本。 */
    ledger: hasMethods(brain.deletionLedger, ['verify', 'watermark']) ? brain.deletionLedger : null,
    /** del3：删除 worker（`deletionStatus` / `listPending` / `runOnce` 都挂在这儿）。 */
    worker: hasMethods(brain.deletionWorker, ['runOnce']) ? brain.deletionWorker : null,
    /** del3：分层报告的官方实现（挂在哪儿没定，四处都探）。 */
    status:
      (typeof brain.deletionStatus === 'function' ? brain : null)
      || (hasMethods(brain.deletions, ['status']) ? brain.deletions : null)
      || (hasMethods(brain.deletionWorker, ['deletionStatus']) ? brain.deletionWorker : null)
      || (hasMethods(brain.memories, ['deletionStatus']) ? brain.memories : null)
      || (hasMethods(brain.deletionReport, ['forMemory']) ? brain.deletionReport : null),
    /** backup3：恢复编排。 */
    restore:
      hasMethods(brain.restore, ['planRestore', 'executeRestore'])
        ? brain.restore
        : hasMethods(brain.restoreService, ['planRestore', 'executeRestore'])
          ? brain.restoreService
          : null,
    /** backup3：备份增强。 */
    backupOps: hasMethods(brain.backupOps, ['createBackup', 'verifyBackup']) ? brain.backupOps : null,
    /** M1 已有的备份服务（createSnapshot / verifySnapshot / listSnapshots）。 */
    m1Backup: hasMethods(brain.backup, ['createSnapshot', 'verifySnapshot']) ? brain.backup : null,
  };

  /** @param {string} memoryId */
  function statusFacadeFor() {
    if (!facades.status) return null;
    const f = /** @type {any} */ (facades.status);
    if (typeof f.deletionStatus === 'function') return f.deletionStatus.bind(f);
    if (typeof f.status === 'function') return f.status.bind(f);
    return null;
  }

  // ---------------------------------------------------------------------
  // 能力矩阵：默认关，显式开
  // ---------------------------------------------------------------------

  const capabilities = {
    /** 写记忆 / 删除（M2 能力）。 */
    write: !readOnly,
    /** 触发一次备份。默认关：备份会占空间、会写备份记录。 */
    backup: !readOnly && config.allowBackup === true,
    /** 真执行恢复。默认关：误触一次就把库覆盖了。 */
    restore: !readOnly && config.allowRestore === true,
    /** 只读诊断永远可用（隔离实例也该能看）。 */
    diagnose: true,
  };

  /** 给 /api/health 与页面用的能力快照。 */
  function capabilitySnapshot() {
    return {
      ...capabilities,
      facades: {
        deletionLedger: facades.ledger !== null,
        deletionWorker: facades.worker !== null,
        deletionStatus: statusFacadeFor() !== null,
        restore: facades.restore !== null,
        backupOps: facades.backupOps !== null,
        m1Backup: facades.m1Backup !== null,
      },
    };
  }

  // ---------------------------------------------------------------------
  // 隔离判定
  // ---------------------------------------------------------------------

  /** @param {string} name */
  function statePath(name) {
    return path.join(stateDir, name);
  }

  /**
   * 读恢复状态文件。**坏文件也要能说清楚坏在哪**，不能静默当没有。
   * @returns {{ present: boolean, state: any, error: string | null }}
   */
  function readRestoreState() {
    const file = statePath(RESTORE_STATE_FILE);
    if (!existsSync(file)) return { present: false, state: null, error: null };
    try {
      const raw = readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') {
        return { present: true, state: null, error: '恢复状态文件不是对象' };
      }
      return { present: true, state: parsed, error: null };
    } catch (err) {
      return { present: true, state: null, error: `恢复状态文件读不出来：${/** @type {Error} */ (err).message}` };
    }
  }

  /**
   * 写恢复状态（供下次启动判定隔离）。
   * @param {{ promoted: boolean, reason: string, backupDir: string }} input
   */
  function writeRestoreState(input) {
    try {
      mkdirSync(stateDir, { recursive: true });
      const payload = {
        promoted: input.promoted === true,
        reason: input.reason,
        backupDir: input.backupDir,
        restoredAt: new Date().toISOString(),
      };
      writeFileSync(statePath(RESTORE_STATE_FILE), `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
      return { ok: true, path: statePath(RESTORE_STATE_FILE), payload };
    } catch (err) {
      // 写不进去不能假装写进去了——下次启动就读不到隔离标志。
      logger.warn(`恢复状态写入失败：${/** @type {Error} */ (err).message}`);
      return { ok: false, error: /** @type {Error} */ (err).message };
    }
  }

  /**
   * 这个实例能不能正常服务。
   *
   * 判据按可信度排序：显式运维置位 > 恢复状态文件 > 账本检查 > 恢复实例缺账本。
   * **任何一条成立就不许上线。** 隔离实例只允许只读诊断。
   *
   * @returns {{
   *   active: boolean, canServe: boolean, source: string | null,
   *   reasons: Array<{ code: string, detail: string, severity: 'blocker'|'warning' }>,
   *   banner: string | null, checkedAt: string,
   * }}
   */
  function isolation() {
    /** @type {Array<{ code: string, detail: string, severity: 'blocker'|'warning' }>} */
    const reasons = [];
    /** @type {string | null} */
    let source = null;

    // 1) 运维显式置位：最优先，且不需要别的证据。
    if (typeof config.isolationReason === 'string' && config.isolationReason.length > 0) {
      reasons.push({
        code: 'EXPLICIT_ISOLATION',
        detail: config.isolationReason,
        severity: 'blocker',
      });
      source = 'config';
    }

    // 2) 上一次恢复留下的状态：promoted=false 就是不许上线。
    const restoreState = readRestoreState();
    if (restoreState.error !== null) {
      reasons.push({ code: 'RESTORE_STATE_UNREADABLE', detail: restoreState.error, severity: 'blocker' });
      source = source ?? 'restore-state';
    }
    if (restoreState.state !== null && restoreState.state.promoted === false) {
      reasons.push({
        code: String(restoreState.state.reason ?? 'RESTORE_NOT_PROMOTED'),
        detail: `这个实例由备份恢复而来，但未通过校验上架（${String(restoreState.state.backupDir ?? '来源未记录')}）。`,
        severity: 'blocker',
      });
      source = source ?? 'restore-state';
    }

    // 3) 恢复实例 + 账本：账本不可用就没法证明「删过的东西没复活」。
    if (typeof config.restoredFrom === 'string' && config.restoredFrom.length > 0) {
      const ledger = /** @type {any} */ (facades.ledger);
      if (facades.ledger === null) {
        reasons.push({
          code: 'LEDGER_UNAVAILABLE',
          detail: '本实例由备份恢复，但独立删除账本门面不存在：无法证明备份之后的删除没有被复活。',
          severity: 'blocker',
        });
        source = source ?? 'restore-instance';
      } else if (ledger.available === false) {
        reasons.push({
          code: 'LEDGER_UNAVAILABLE',
          detail: `独立删除账本不可用：${String(ledger.unavailableReason ?? '原因未给出')}`,
          severity: 'blocker',
        });
        source = source ?? 'restore-instance';
      } else {
        try {
          const verdict = /** @type {any} */ (ledger.verify());
          if (!verdict || verdict.ok !== true) {
            // corruptAt === 'missing' 表示「账本从来没写过」——同样不可信，
            // 因为我们证明不了备份之后有没有发生过删除。
            const missing = verdict?.corruptAt === 'missing';
            reasons.push({
              code: missing ? 'LEDGER_MISSING' : 'LEDGER_CORRUPT',
              detail: missing
                ? '独立删除账本里没有任何记录（账本文件还没建立）：无法证明备份之后没有发生过删除。'
                : `独立删除账本校验未通过：${String(verdict?.corruptAt ?? '未知位置')}`,
              severity: 'blocker',
            });
            source = source ?? 'restore-instance';
          }
        } catch (err) {
          reasons.push({
            code: 'LEDGER_CHECK_FAILED',
            detail: `账本校验抛错：${/** @type {Error} */ (err).message}`,
            severity: 'blocker',
          });
          source = source ?? 'restore-instance';
        }
      }
    }

    const active = reasons.length > 0;
    return {
      active,
      canServe: !active,
      source,
      reasons,
      banner: active
        ? '这个实例不能上线，只能只读检修'
        : null,
      checkedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------
  // 删除四层报告
  // ---------------------------------------------------------------------

  /** @param {unknown} value */
  function parseJson(value) {
    if (typeof value !== 'string' || value.length === 0) return null;
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  /**
   * 独立账本里有没有这条删除的记录。
   * @param {string} tombstoneId
   * @returns {{ checked: boolean, synced: boolean | null, detail: string }}
   */
  function ledgerSyncFor(tombstoneId) {
    if (facades.ledger === null) {
      // 未知 ≠ 没记。这一格必须显示「无法核实」。
      return { checked: false, synced: null, detail: '独立删除账本未接入，无法核实这条删除是否已记入账本。' };
    }
    try {
      const read = /** @type {any} */ (facades.ledger).read({ sinceSeq: 0, limit: 100_000 });
      const entries = Array.isArray(read?.entries) ? read.entries : [];
      const hit = entries.find((e) => String(e?.tombstoneId ?? e?.tombstone_id ?? '') === tombstoneId);
      return hit
        ? { checked: true, synced: true, detail: `已在独立账本第 ${String(hit.seq ?? '?')} 条` }
        : { checked: true, synced: false, detail: '账本里没有这条记录：DB 与账本脱节，恢复时不能信任这个删除。' };
    } catch (err) {
      return { checked: false, synced: null, detail: `读账本失败：${/** @type {Error} */ (err).message}` };
    }
  }

  /**
   * 第 3 层：旧备份最晚到期时间。
   *
   * 逻辑：删除生效**之前**创建的备份才可能含这条内容；
   * 它们的到期时间的**最大值**就是「最晚到期」——保守说，到这之前旧备份里可能还躺着。
   * @param {string} shieldedAt
   */
  function backupExpiryFor(shieldedAt) {
    /** @type {Array<{ backupId: string, createdAt: string, expiresAt: string, basis: string }>} */
    const risky = [];
    try {
      const rows = /** @type {any[]} */ (
        db
          .prepare(
            `SELECT backup_id, created_at, retention_until, status
               FROM backups
              WHERE status IN ('complete', 'verified')
              ORDER BY created_at ASC`,
          )
          .all()
      );
      for (const row of rows) {
        const createdAt = iso(row.created_at);
        if (createdAt === null) continue;
        // 只有「删除之前就存在」的备份才可能含被删内容
        if (createdAt >= shieldedAt) continue;
        const retention = iso(row.retention_until);
        const expiresAt = retention ?? addDays(createdAt, keepDays);
        if (expiresAt === null) continue;
        risky.push({
          backupId: String(row.backup_id),
          createdAt,
          expiresAt,
          basis: retention === null ? `按保留 ${keepDays} 天推算` : '备份记录里的 retention_until',
        });
      }
    } catch {
      return {
        at: null,
        status: /** @type {const} */ ('unknown'),
        riskyBackups: [],
        basis: '读 backups 表失败，无法计算旧备份到期时间。',
      };
    }

    if (risky.length === 0) {
      return {
        at: null,
        status: /** @type {const} */ ('no_risky_backup'),
        riskyBackups: [],
        basis: '删除生效时还没有备份记录，所以不存在「含这条内容的旧备份」。',
      };
    }
    const latest = risky.reduce((a, b) => (a.expiresAt > b.expiresAt ? a : b));
    return {
      at: latest.expiresAt,
      status: /** @type {const} */ ('computed'),
      riskyBackups: risky,
      keepDays,
      basis: `口径：只看「删除发生之前创建的备份」并逐份计算（不用保留策略的笼统时间）。本次 ${risky.length} 份符合条件，最晚一份到 ${latest.expiresAt.slice(0, 10)} 才过期；在此之前旧备份里可能仍有内容。`,
    };
  }

  /**
   * 第 4 层：外部副本与其它插件源。
   *
   * 这两类**我们管不到**，所以默认就是「未核实 / 未处理」。
   * 如果库里有登记表就读，没有就用默认的诚实清单——绝不能因为「没记录」就显示成「已处理」。
   * @param {string} memoryId
   */
  function externalLayerFor(memoryId) {
    /** @type {Array<{ kind: string, verified: boolean, note: string }>} */
    let externalCopies = [];
    /** @type {Array<{ system: string, handled: boolean, note: string }>} */
    let hostCopies = [];
    let registered = false;

    const tableExists = (/** @type {string} */ name) => {
      try {
        return (
          db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?").get(name) !== undefined
        );
      } catch {
        return false;
      }
    };

    if (tableExists('deletion_external_copies')) {
      try {
        const rows = /** @type {any[]} */ (
          db
            .prepare('SELECT kind, verified, note FROM deletion_external_copies WHERE target_id = ?')
            .all(memoryId)
        );
        if (rows.length > 0) {
          registered = true;
          externalCopies = rows.map((r) => ({
            kind: String(r.kind),
            verified: Number(r.verified) === 1,
            note: r.note === null ? '' : String(r.note),
          }));
        }
      } catch {
        /* 表在但读不出来：按未登记处理，下面给默认清单 */
      }
    }

    if (tableExists('deletion_host_copies')) {
      try {
        const rows = /** @type {any[]} */ (
          db
            .prepare('SELECT system, handled, note FROM deletion_host_copies WHERE target_id = ?')
            .all(memoryId)
        );
        if (rows.length > 0) {
          registered = true;
          hostCopies = rows.map((r) => ({
            system: String(r.system),
            handled: Number(r.handled) === 1,
            note: r.note === null ? '' : String(r.note),
          }));
        }
      } catch {
        /* 同上 */
      }
    }

    if (!registered) {
      // 默认清单：把我们**确定管不到**的几类都列出来，全部标未核实/未处理。
      externalCopies = [
        { kind: 'offline_export', verified: false, note: '离线导出（U 盘/移动盘/打印稿）：没有可核实的删除记录' },
        { kind: 'cloud_sync', verified: false, note: '云同步副本（网盘/同步盘）：本工具无法触达' },
      ];
      hostCopies = [
        { system: 'dsh', handled: false, note: '宿主的会话历史（session JSONL）不会因这条记忆被删除而自动消失' },
        { system: 'engram', handled: false, note: '其它插件自有记忆库，需在它那边单独删除' },
        { system: 'lingshu', handled: false, note: '其它插件自有记忆库，需在它那边单独删除' },
      ];
    }

    const unverifiedCount = externalCopies.filter((c) => !c.verified).length;
    const unhandledCount = hostCopies.filter((c) => !c.handled).length;
    return {
      externalCopies,
      hostCopies,
      unverifiedCount,
      unhandledCount,
      status: unverifiedCount + unhandledCount === 0 ? '清干净了' : '仍有未核实/未处理',
      registered,
      basis: registered
        ? '来自库内登记表 deletion_external_copies / deletion_host_copies'
        : '没有登记表：按「我们能管到的范围」列出默认清单，一律标未核实/未处理',
    };
  }

  /**
   * 第 2 层：在线清理。
   * @param {string} tombstoneId
   */
  function onlineCleanupFor(tombstoneId) {
    /** @type {any[]} */
    let jobs = [];
    try {
      jobs = /** @type {any[]} */ (
        db
          .prepare(
            `SELECT job_id, kind, status, attempts, last_error, created_at, finished_at
               FROM deletion_jobs WHERE tombstone_id = ? ORDER BY created_at ASC`,
          )
          .all(tombstoneId)
      );
    } catch {
      return {
        at: null,
        status: /** @type {const} */ ('unknown'),
        jobs: { total: 0, done: 0, failed: 0, running: 0, pending: 0 },
        error: '读 deletion_jobs 失败',
        basis: 'deletion_jobs',
      };
    }

    /** @type {Record<string, number>} */
    const counts = { total: jobs.length, done: 0, failed: 0, running: 0, pending: 0, dead: 0 };
    /** @type {string[]} */
    const errors = [];
    let lastFinished = /** @type {string | null} */ (null);
    for (const job of jobs) {
      const status = String(job.status);
      if (status === 'done') counts.done += 1;
      else if (status === 'failed') counts.failed += 1;
      else if (status === 'dead') counts.dead += 1;
      else if (status === 'running') counts.running += 1;
      else counts.pending += 1;
      if (typeof job.last_error === 'string' && job.last_error.length > 0) {
        errors.push(`${String(job.kind)}: ${job.last_error}`);
      }
      const finished = iso(job.finished_at);
      if (finished !== null && (lastFinished === null || finished > lastFinished)) lastFinished = finished;
    }

    /** @type {'not_started'|'pending'|'running'|'done'|'failed'|'partial'} */
    let status;
    if (counts.total === 0) status = 'not_started';
    else if (counts.failed > 0 && counts.done === 0) status = 'failed';
    else if (counts.failed > 0 || counts.dead > 0) status = 'partial';
    else if (counts.done === counts.total) status = 'done';
    else if (counts.running > 0) status = 'running';
    else status = 'pending';

    const at = status === 'done' ? lastFinished : null;
    const basis =
      status === 'not_started'
        ? '没有清理任务：正文与派生物**还没有被在线清过**'
        : status === 'done'
          ? '全部清理任务完成'
          : `${counts.total} 个任务里 ${counts.done} 个完成、${counts.failed + counts.dead} 个失败、${counts.running + counts.pending} 个未完成`;

    return { at, status, jobs: counts, errors, basis };
  }

  /**
   * 删除状态分层报告。
   *
   * @param {string} memoryId
   */
  async function deletionStatus(memoryId) {
    if (typeof memoryId !== 'string' || memoryId.trim().length === 0) {
      throw fail('缺少 memoryId');
    }
    /** @type {any} */
    const tomb = db
      .prepare("SELECT * FROM deletion_tombstones WHERE target_kind = 'memory' AND target_id = ?")
      .get(memoryId);
    if (tomb === undefined || tomb === null) {
      return {
        available: true,
        memoryId,
        deleted: false,
        layers: null,
        note: '这条记忆没有删除墓碑：它没被请求删除过。',
      };
    }

    const shieldedAt = iso(tomb.requested_at) ?? new Date(0).toISOString();
    const ledger = ledgerSyncFor(String(tomb.tombstone_id));

    // del3 若已提供官方分层报告，以它为准、我们补边缘字段（避免两套口径）。
    const official = statusFacadeFor();
    /** @type {any} */
    let officialReport = null;
    /** @type {string | null} */
    let officialError = null;
    if (official !== null) {
      try {
        officialReport = await official(memoryId);
      } catch (err) {
        officialError = /** @type {Error} */ (err).message;
      }
    }

    const online = onlineCleanupFor(String(tomb.tombstone_id));
    const backup = backupExpiryFor(shieldedAt);
    const external = externalLayerFor(memoryId);

    // ---- 门面优先：del3 的 deletionStatus 是权威判据，我们只补齐展示字段
    const fromFacade = officialReport !== null && typeof officialReport === 'object';

    const cleanProgress = fromFacade && officialReport.progress
      ? {
          total: asInt(officialReport.progress.total),
          done: asInt(officialReport.progress.done),
          failed: asInt(officialReport.progress.failed),
          running: asInt(officialReport.progress.running),
          pending: asInt(officialReport.progress.pending),
          dead: asInt(officialReport.progress.dead),
        }
      : online.jobs;

    /** @type {'not_started'|'pending'|'running'|'done'|'failed'|'partial'} */
    const cleanStatus = fromFacade
      ? deriveCleanupStatus(cleanProgress, officialReport.workerDoneAt)
      : online.status;
    const cleanDoneAt = fromFacade
      ? (iso(officialReport.workerDoneAt) ?? (cleanStatus === 'done' ? online.at : null))
      : online.at;

    const externalCopies = fromFacade && Array.isArray(officialReport.externalCopies)
      ? officialReport.externalCopies
      : external.externalCopies;
    const hostCopies = fromFacade && Array.isArray(officialReport.hostCopies)
      ? officialReport.hostCopies
      : external.hostCopies;
    const unverifiedCount = externalCopies.filter((c) => c?.verified !== true).length;
    const unhandledCount = hostCopies.filter((c) => c?.handled !== true).length;

    const ledgerSynced = fromFacade && 'ledgerSynced' in officialReport
      ? officialReport.ledgerSynced
      : ledger.synced;

    /** @type {any} */
    const layers = {
      shielded: {
        index: 1,
        key: 'shielded',
        title: '立即屏蔽',
        at: (fromFacade ? iso(officialReport.shieldedAt) : null) ?? shieldedAt,
        status: 'done',
        done: true,
        basis: '写 tombstone 那一刻就已经生效——检索不到，不需要等清理。',
      },
      onlineCleanup: {
        index: 2,
        key: 'onlineCleanup',
        title: '在线清理',
        at: cleanDoneAt,
        status: cleanStatus,
        done: cleanStatus === 'done',
        jobs: cleanProgress,
        errors: online.errors,
        basis:
          cleanStatus === 'not_started'
            ? '没有清理任务：正文与派生物**还没有被在线清过**'
            : cleanStatus === 'done'
              ? '全部清理任务完成'
              : `${cleanProgress.total} 个任务里 ${cleanProgress.done} 个完成、${cleanProgress.failed + cleanProgress.dead} 个失败、${cleanProgress.running + cleanProgress.pending} 个未完成`,
        // del3 给的逐步明细（哪一步卡住了一眼能看出来）
        steps: fromFacade && Array.isArray(officialReport.steps) ? officialReport.steps : null,
      },
      backupExpiry: {
        index: 3,
        key: 'backupExpiry',
        title: '旧备份到期',
        // 这一层用**本地精确算法**：只看「删除发生之前创建的备份」，逐份给到期时间。
        // 门面的 backupExpiryAt 是按保留策略给的笼统值，语义上不如前者准；只有本地算不出来时才用它。
        at: backup.status === 'unknown' ? (iso(officialReport?.backupExpiryAt) ?? null) : backup.at,
        status: backup.status,
        done: backup.at !== null && new Date(backup.at).getTime() <= Date.now(),
        riskyBackups: backup.riskyBackups,
        keepDays: backup.keepDays ?? keepDays,
        basis: backup.basis,
      },
      external: {
        index: 4,
        key: 'external',
        title: '外部与其它源',
        at: null,
        status: 'unverified',
        done: unverifiedCount + unhandledCount === 0,
        externalCopies,
        hostCopies,
        unverifiedCount,
        unhandledCount,
        basis: external.basis,
      },
    };

    // 还有一个最容易被忽略的真相：已经发到模型/外部服务的内容撤不回来。
    /** @type {string[]} */
    const caveats = [
      '屏蔽是立即的，清正文是异步的，旧备份到期是未来的时间点——这三件事不在同一刻完成。',
      '已经发给模型或外部服务的内容无法追溯撤回，只能停止后续使用。',
    ];
    if (unverifiedCount + unhandledCount > 0) {
      caveats.push('第 4 层永远需要人确认：本工具碰不到离线副本，也删不掉别的插件的库。');
    }
    if (ledgerSynced === null) {
      caveats.push('独立删除账本没接入：恢复时无法证明这条删除不会因为旧备份而复活。');
    }
    if (ledgerSynced === false) {
      caveats.push('数据库认为删了，但独立账本里没有这条记录：恢复时这条删除可能被整体漏掉。');
    }

    // 门面自己写的注意事项单独放：它们是「清理链的技术细节」，
    // 跟上面那三条「需要人记住的前提」不是一个层级，混在一起会淹掉重点。
    /** @type {string[]} */
    const notes = [];
    if (fromFacade && Array.isArray(officialReport.notes)) {
      for (const note of officialReport.notes) {
        if (typeof note === 'string' && note.length > 0) notes.push(note);
      }
    }

    return {
      available: true,
      memoryId,
      deleted: true,
      tombstoneId: String(tomb.tombstone_id),
      epoch: Number(tomb.deletion_epoch),
      scopeId: String(tomb.scope_id),
      reason: String(tomb.reason),
      requestedBy: String(tomb.requested_by),
      requestedAt: shieldedAt,
      layers,
      progress: cleanProgress,
      ledgerSynced,
      ledgerDetail: fromFacade
        ? (ledgerSynced === true ? '独立账本里已记这条删除。' : ledgerSynced === false ? '独立账本里没有这条删除的记录。' : ledger.detail)
        : ledger.detail,
      // 门面的「三不一承诺」：物理擦除 / 备份过期 / 外部撤回，各自是否已达成
      claims: fromFacade && officialReport.claims ? officialReport.claims : null,
      // 一句话结论，但**必须**带上第 4 层的前提
      summary:
        layers.onlineCleanup.status === 'done'
          ? '本机这边已清理完；旧备份与外部副本仍按下表计时/待核实。'
          : '已立即屏蔽，但本机的正文清理还没完成；旧备份与外部副本另算。',
      caveats,
      /** 清理链的技术说明（来自 del3），与 caveats 分层展示。 */
      notes,
      official: fromFacade ? { available: true } : null,
      officialError,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * 从进度反推清理状态。门面给的是数字，界面上要给一句话。
   * @param {{ total: number, done: number, failed: number, running?: number, pending?: number, dead?: number }} jobs
   * @param {string|null} workerDoneAt
   */
  function deriveCleanupStatus(jobs, workerDoneAt) {
    if (iso(workerDoneAt) !== null) return 'done';
    const total = asInt(jobs.total);
    const done = asInt(jobs.done);
    const failed = asInt(jobs.failed) + asInt(jobs.dead ?? 0);
    if (total === 0) return 'not_started';
    if (failed > 0 && done === 0) return 'failed';
    if (failed > 0) return 'partial';
    if (done === total) return 'done';
    if (asInt(jobs.running ?? 0) > 0) return 'running';
    return 'pending';
  }

  /**
   * 待清理列表。
   * @param {{ status?: string, limit?: unknown }} [query]
   */
  async function listDeletions(query = {}) {
    const limitRaw = query.limit === undefined || query.limit === null || query.limit === ''
      ? 50
      : Number(query.limit);
    if (!Number.isFinite(limitRaw) || limitRaw < 1) throw fail('limit 必须是 ≥1 的整数');
    const limit = Math.min(Math.trunc(limitRaw), 200);

    const wantPending = query.status === undefined || query.status === null || query.status === '' || query.status === 'pending';
    if (!wantPending && query.status !== 'all' && query.status !== 'completed') {
      throw fail("status 只支持 pending | completed | all");
    }

    /** @type {any[]} */
    let tombstones = [];
    try {
      tombstones = /** @type {any[]} */ (
        db
          .prepare(
            `SELECT t.tombstone_id, t.target_id, t.scope_id, t.reason, t.requested_by,
                    t.deletion_epoch, t.status, t.requested_at,
                    (SELECT COUNT(*) FROM deletion_jobs j WHERE j.tombstone_id = t.tombstone_id) AS job_total,
                    (SELECT COUNT(*) FROM deletion_jobs j WHERE j.tombstone_id = t.tombstone_id AND j.status = 'done') AS job_done,
                    (SELECT COUNT(*) FROM deletion_jobs j WHERE j.tombstone_id = t.tombstone_id AND j.status IN ('failed','dead')) AS job_failed
               FROM deletion_tombstones t
              WHERE t.target_kind = 'memory'
              ORDER BY t.requested_at DESC
              LIMIT ?`,
          )
          .all(limit)
      );
    } catch {
      return { available: false, items: [], reason: 'deletion_tombstones 读不出来', limit };
    }

    const items = tombstones.map((row) => {
      const total = asInt(row.job_total);
      const done = asInt(row.job_done);
      const failed = asInt(row.job_failed);
      /** @type {'pending'|'running'|'done'|'failed'|'not_started'} */
      let status;
      if (total === 0) status = 'not_started';
      else if (failed > 0 && done === 0) status = 'failed';
      else if (done === total) status = 'done';
      else status = 'pending';
      return {
        tombstoneId: String(row.tombstone_id),
        memoryId: String(row.target_id),
        scopeId: String(row.scope_id),
        reason: String(row.reason),
        requestedBy: String(row.requested_by),
        epoch: Number(row.deletion_epoch),
        requestedAt: iso(row.requested_at),
        progress: { total, done, failed },
        status,
        layerNow: status === 'done' ? 2 : 1,
        note:
          status === 'done'
            ? '本机清理已完成；旧备份与外部副本仍需单独核实。'
            : status === 'not_started'
              ? '已屏蔽，清理任务还没创建。'
              : '已屏蔽，清理进行中/待重试。',
      };
    });

    const filtered = items.filter((item) => {
      if (query.status === 'all') return true;
      if (query.status === 'completed') return item.status === 'done';
      return item.status !== 'done';
    });

    return {
      available: true,
      items: filtered.slice(0, limit),
      limit,
      total: items.length,
      shown: filtered.length,
      status: query.status ?? 'pending',
      facade: facades.worker === null ? 'not_available' : 'available',
      note:
        facades.worker === null
          ? '删除 worker 门面未接入：这里只反映数据库里的任务状态，不会主动推进清理。'
          : '删除 worker 已接入。',
      checkedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------
  // 备份中心
  // ---------------------------------------------------------------------

  /**
   * 备份列表。优先 backup3 门面；否则直接读 M1 的 backups 表 + 文件系统。
   */
  async function listBackups() {
    /** @type {any[]} */
    let rows = [];
    let source = 'backups 表';
    if (facades.backupOps !== null && typeof (/** @type {any} */ (facades.backupOps).listBackups) === 'function') {
      try {
        const listed = await /** @type {any} */ (facades.backupOps).listBackups();
        rows = Array.isArray(listed?.items) ? listed.items : Array.isArray(listed) ? listed : [];
        source = 'backupOps 门面';
      } catch (err) {
        logger.warn(`backupOps.listBackups 失败，退回直接读表：${/** @type {Error} */ (err).message}`);
        rows = [];
      }
    }
    if (rows.length === 0) {
      try {
        rows = /** @type {any[]} */ (
          db
            .prepare(
              `SELECT backup_id, kind, path, byte_size, sha256, schema_version, deletion_epoch,
                      source_watermark, status, error, created_at, verified_at, retention_until
                 FROM backups ORDER BY created_at DESC LIMIT 200`,
            )
            .all()
        );
      } catch {
        return {
          available: false,
          items: [],
          dir: backupDir,
          reason: 'backups 表读不出来',
        };
      }
    }

    const items = rows.map((row) => {
      const filePath = row.path === undefined || row.path === null ? null : String(row.path);
      let exists = false;
      let sizeActual = null;
      if (typeof filePath === 'string' && filePath.length > 0) {
        try {
          const stat = statSync(filePath);
          exists = stat.isFile();
          sizeActual = exists ? stat.size : null;
        } catch {
          exists = false;
        }
      }
      const status = String(row.status ?? 'unknown');
      const verified = status === 'verified' || iso(row.verified_at) !== null;
      /** @type {'ok'|'missing_file'|'failed'|'unverified'} */
      let integrity = 'unverified';
      if (status === 'failed') integrity = 'failed';
      else if (!exists && filePath !== null) integrity = 'missing_file';
      else if (verified) integrity = 'ok';

      return {
        backupId: String(row.backup_id ?? ''),
        kind: String(row.kind ?? 'unknown'),
        dir: filePath === null ? null : path.basename(filePath),
        path: filePath,
        fileName: filePath === null ? null : path.basename(filePath),
        byteSize: row.byte_size === null || row.byte_size === undefined ? null : Number(row.byte_size),
        sizeActual,
        sha256: row.sha256 === null || row.sha256 === undefined ? null : String(row.sha256),
        schemaVersion: row.schema_version === null || row.schema_version === undefined ? null : String(row.schema_version),
        watermark: row.source_watermark === null || row.source_watermark === undefined ? null : Number(row.source_watermark),
        deletionEpoch: row.deletion_epoch === null || row.deletion_epoch === undefined ? null : Number(row.deletion_epoch),
        status,
        verified,
        verifiedAt: iso(row.verified_at),
        createdAt: iso(row.created_at),
        retentionUntil: iso(row.retention_until),
        error: row.error === null || row.error === undefined ? null : String(row.error),
        exists,
        integrity,
      };
    });

    return {
      available: true,
      dir: backupDir,
      items,
      total: items.length,
      keepDays,
      source,
      // 当前库的删除水位：备份的 deletion_epoch 比它低，说明备份之后又发生过删除，
      // 恢复到那一份就会让已删内容复活——这个对比必须摆在界面上。
      currentDeletionEpoch: (() => {
        try {
          const row = /** @type {{value?: string} | undefined} */ (
            db.prepare("SELECT value FROM brain_meta WHERE key = 'deletion_epoch'").get()
          );
          return row?.value === undefined || row.value === null ? 0 : Number(row.value);
        } catch {
          return null;
        }
      })(),
      capability: { backup: capabilities.backup, verify: true },
      note:
        items.length === 0
          ? '还没有任何备份记录。没有备份就没有「回退点」，删除之后旧备份这一层也就无从谈起。'
          : null,
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * 触发一次备份。需要 capability.backup。
   * @param {unknown} body
   */
  async function createBackup(body) {
    if (readOnly) throw fail('本服务以 --read-only 启动，拒绝备份写入', 'STORAGE_READONLY');
    if (!capabilities.backup) {
      const err = /** @type {Error & {code?: string, details?: Record<string, unknown>}} */ (
        new Error('备份能力未开启：请以 --allow-backup 启动（默认关闭，避免误触占地）')
      );
      err.code = 'CAPABILITY_REQUIRED';
      err.details = { capability: 'backup', howToEnable: '--allow-backup 或 BRAIN_ALLOW_BACKUP=1' };
      throw err;
    }

    /** @type {any} */
    let result;
    if (facades.backupOps !== null) {
      result = await /** @type {any} */ (facades.backupOps).createBackup({
        blobsDir: body && typeof body === 'object' ? /** @type {any} */ (body).blobsDir : undefined,
        outDir: backupDir,
        label: body && typeof body === 'object' ? /** @type {any} */ (body).label ?? 'console' : 'console',
      });
      return { available: true, implementation: 'backupOps', dir: result?.dir ?? null, result };
    }
    if (facades.m1Backup !== null) {
      result = await /** @type {any} */ (facades.m1Backup).createSnapshot({ kind: 'manual' });
      return {
        available: true,
        implementation: 'm1Backup',
        dir: result?.path ?? null,
        backupId: result?.backup_id ?? null,
        byteSize: result?.byte_size ?? null,
        sha256: result?.sha256 ?? null,
        checkpoint: result?.checklist ?? null,
        note: '用的是 M1 的备份服务（全量快照 + 校验 + 原子落位）；backup3 增强接入后自动切换。',
      };
    }
    throw notAvailable('backup.createBackup');
  }

  /**
   * 目录名 → 绝对路径，且必须落在 backupDir 里。
   * @param {string} name
   */
  function resolveBackupDir(name) {
    if (typeof name !== 'string' || !SAFE_DIR_NAME.test(name) || name.includes('..')) {
      throw fail('备份目录名不合法（只允许单层目录名，不含 .. 与分隔符）');
    }
    const root = path.resolve(backupDir);
    const full = path.resolve(root, name);
    if (full !== root && !full.startsWith(root + path.sep)) {
      throw fail('备份目录越界');
    }
    return full;
  }

  /**
   * 复校一份备份。
   * @param {string} dirName
   */
  async function verifyBackup(dirName) {
    const full = resolveBackupDir(dirName);

    // 先用库里的记录找到 backupId（M1 verifySnapshot 支持按 id 或 path）
    /** @type {any} */
    let row = null;
    try {
      row = db
        .prepare('SELECT backup_id, path FROM backups WHERE backup_id = ? OR path LIKE ? LIMIT 1')
        .get(dirName, `%${dirName}%`);
    } catch {
      row = null;
    }

    if (facades.backupOps !== null && typeof (/** @type {any} */ (facades.backupOps).verifyBackup) === 'function') {
      const verdict = await /** @type {any} */ (facades.backupOps).verifyBackup(full);
      return { available: true, implementation: 'backupOps', dir: dirName, path: full, ...verdict };
    }
    if (facades.m1Backup !== null) {
      const verdict = await /** @type {any} */ (facades.m1Backup).verifySnapshot(
        row?.backup_id ? { backup_id: String(row.backup_id) } : { path: full },
      );
      return {
        available: true,
        implementation: 'm1Backup',
        dir: dirName,
        path: full,
        ok: verdict?.ok === true,
        problems: Array.isArray(verdict?.checks)
          ? verdict.checks.filter((c) => c.ok !== true).map((c) => `${String(c.name)}: ${String(c.detail ?? 'failed')}`)
          : [],
        checks: verdict?.checks ?? null,
        backupId: verdict?.backup_id ?? null,
      };
    }
    throw notAvailable('backup.verifyBackup');
  }

  // ---------------------------------------------------------------------
  // 恢复编排
  // ---------------------------------------------------------------------

  /**
   * 本地预演：即使 backup3 没接入，也要能算出「能不能恢复」。
   * 这不是替代 backup3，是在它到位之前先把 blockers 摆出来。
   *
   * @param {{ backupDir: string }} input
   */
  async function localPlan(input) {
    const full = resolveBackupDir(input.backupDir);
    /** @type {string[]} */
    const blockers = [];
    /** @type {string[]} */
    const warnings = [];

    /** @type {any} */
    let backupInfo = { createdAt: null, schemaVersion: null, watermark: null, ledgerEpoch: null, tables: [] };
    /** @type {any} */
    let row = null;
    try {
      row = db
        .prepare(
          `SELECT backup_id, path, created_at, schema_version, source_watermark, deletion_epoch, status, byte_size
             FROM backups WHERE path = ? OR backup_id = ? OR path LIKE ? LIMIT 1`,
        )
        .get(full, input.backupDir, `%${input.backupDir}%`);
    } catch {
      row = null;
    }
    if (row !== null && row !== undefined) {
      backupInfo = {
        createdAt: iso(row.created_at),
        schemaVersion: row.schema_version === null ? null : String(row.schema_version),
        watermark: row.source_watermark === null ? null : Number(row.source_watermark),
        ledgerEpoch: row.deletion_epoch === null ? null : Number(row.deletion_epoch),
        tables: [],
        backupId: String(row.backup_id),
        byteSize: row.byte_size === null ? null : Number(row.byte_size),
        status: String(row.status),
      };
    } else {
      // 没有记录不等于没有文件：直接看目录。
      if (!existsSync(full)) {
        blockers.push(`BACKUP_NOT_FOUND: ${input.backupDir} 既没有备份记录也没有这个目录`);
      } else {
        warnings.push('备份目录存在但库内没有对应记录：无法核对 watermark 与 schema 版本。');
      }
    }

    // 完整性校验：失败直接拒绝恢复（M3-INTERFACES §5.1 第 1 步）
    /** @type {any} */
    let verify = null;
    try {
      verify = await verifyBackup(input.backupDir);
    } catch (err) {
      const e = /** @type {any} */ (err);
      if (e.code === 'NOT_AVAILABLE') {
        warnings.push('备份校验门面未接入：本次预演**没有**校验备份完整性。');
      } else {
        warnings.push(`备份校验失败：${e.message}`);
      }
    }
    if (verify !== null && verify.ok === false) {
      blockers.push(`BACKUP_CORRUPT: 备份校验未通过（${(verify.problems ?? []).slice(0, 3).join('; ') || '详见校验结果'}）`);
    }

    // 独立删除账本检查（M3-INTERFACES §1.2）
    /** @type {any} */
    const ledgerCheck = {
      ok: false,
      backupEpoch: backupInfo.ledgerEpoch,
      ledgerEpoch: null,
      stale: false,
      reason: null,
    };
    if (facades.ledger === null) {
      ledgerCheck.reason = 'LEDGER_UNAVAILABLE';
      blockers.push('LEDGER_MISSING: 独立删除账本不存在——无法证明备份之后的删除没有被复活');
    } else if (hasMethods(facades.ledger, ['checkForRestore'])) {
      // 契约 §1.2 的强制输入：这是权威判据，不用我们自己拼 epoch 比较。
      try {
        const check = /** @type {any} */ (facades.ledger).checkForRestore({
          backupEpoch: backupInfo.ledgerEpoch,
          backupCreatedAt: backupInfo.createdAt,
        });
        ledgerCheck.ok = check?.ok === true;
        ledgerCheck.backupEpoch = check?.backupEpoch ?? backupInfo.ledgerEpoch;
        ledgerCheck.ledgerEpoch = check?.ledgerEpoch ?? null;
        ledgerCheck.stale = (check?.warnings ?? []).some((w) => String(w).includes('AFTER_BACKUP'));
        ledgerCheck.reason = ledgerCheck.ok ? null : (check?.blockers ?? [])[0] ?? null;
        ledgerCheck.deletionsAfterBackup =
          typeof check?.deletionsAfterBackup === 'number' ? check.deletionsAfterBackup : null;
        for (const b of check?.blockers ?? []) blockers.push(`${String(b)}`);
        for (const w of check?.warnings ?? []) warnings.push(`${String(w)}`);
      } catch (err) {
        ledgerCheck.reason = 'LEDGER_CHECK_FAILED';
        blockers.push(`LEDGER_CHECK_FAILED: ${/** @type {Error} */ (err).message}`);
      }
    } else {
      try {
        const verdict = /** @type {any} */ (facades.ledger).verify();
        if (!verdict || verdict.ok !== true) {
          ledgerCheck.reason = 'LEDGER_CORRUPT';
          blockers.push(`LEDGER_CORRUPT: 账本校验失败（${String(verdict?.corruptAt ?? '未知')}）`);
        } else {
          const wm = /** @type {any} */ (facades.ledger).watermark();
          ledgerCheck.ledgerEpoch = wm?.epoch === null || wm?.epoch === undefined ? null : Number(wm.epoch);
          const backupEpoch = backupInfo.ledgerEpoch;
          if (backupEpoch !== null && ledgerCheck.ledgerEpoch !== null && ledgerCheck.ledgerEpoch < backupEpoch) {
            ledgerCheck.stale = true;
            ledgerCheck.reason = 'LEDGER_STALE_BEHIND_BACKUP';
            blockers.push(
              `LEDGER_STALE_BEHIND_BACKUP: 账本 epoch ${ledgerCheck.ledgerEpoch} 低于备份 epoch ${backupEpoch}——备份之后有删除没记账`,
            );
          } else {
            ledgerCheck.ok = true;
          }
        }
      } catch (err) {
        ledgerCheck.reason = 'LEDGER_CHECK_FAILED';
        blockers.push(`LEDGER_CHECK_FAILED: ${/** @type {Error} */ (err).message}`);
      }
    }

    const isolationRequired = blockers.length > 0;
    const deletionsAfterBackup =
      typeof ledgerCheck.deletionsAfterBackup === 'number' ? ledgerCheck.deletionsAfterBackup : null;
    return {
      ok: blockers.length === 0,
      implementation: 'local-fallback',
      backupDir: input.backupDir,
      backup: backupInfo,
      verify,
      ledgerCheck,
      isolationRequired,
      blockers,
      warnings,
      // 恢复到这份备份之后，需要用账本重放多少条删除——「不复活」的关键数字
      deletionsAfterBackup,
      steps: [
        { step: 1, key: 'verify', title: '校验备份完整性', status: verify?.ok === false ? 'blocked' : verify === null ? 'unknown' : 'ok', detail: verify === null ? '校验门面未接入' : verify.ok ? '通过' : '未通过' },
        { step: 2, key: 'ledger', title: '检查独立删除账本', status: ledgerCheck.ok ? 'ok' : 'blocked', detail: ledgerCheck.reason ?? '通过' },
        { step: 3, key: 'import', title: '导入主表', status: isolationRequired ? 'isolated' : 'planned', detail: '先主表，后派生' },
        {
          step: 4,
          key: 'merge',
          title: '强制合并账本（重放备份之后的删除）',
          status: isolationRequired ? 'isolated' : 'planned',
          detail:
            deletionsAfterBackup !== null && deletionsAfterBackup > 0
              ? `必须重放 ${deletionsAfterBackup} 条删除，否则它们会跟着备份一起复活`
              : '账本里没有「备份之后的删除」需要重放',
        },
        { step: 5, key: 'rebuild', title: '重建派生数据（FTS 三表 / ngram / 摘要索引）', status: 'planned', detail: '' },
        { step: 6, key: 'promote', title: '判定上架', status: isolationRequired ? 'isolated' : 'planned', detail: isolationRequired ? 'promoted=false：只能只读检修' : 'promoted=true' },
      ],
      note: '这是本地预演：真执行需要 backup3 的 executeRestore 门面。',
    };
  }

  /**
   * 只读预演。
   * @param {unknown} body
   */
  async function planRestore(body) {
    const input = body !== null && typeof body === 'object' ? /** @type {any} */ (body) : {};
    if (typeof input.backupDir !== 'string' || input.backupDir.length === 0) {
      throw fail('restore/plan 需要 backupDir（备份目录名）');
    }
    if (facades.restore !== null) {
      try {
        const plan = await /** @type {any} */ (facades.restore).planRestore({
          backupDir: input.backupDir,
          hostCopies: input.hostCopies,
        });
        return { ...plan, implementation: 'backup3' };
      } catch (err) {
        logger.warn(`backup3.planRestore 失败，退回本地预演：${/** @type {Error} */ (err).message}`);
      }
    }
    return localPlan({ backupDir: input.backupDir });
  }

  /**
   * 执行恢复。**默认 dry-run**。
   *
   * 三层闸门，缺一层都不执行：
   *   1. `dryRun === false`（缺省是 true，所以漏传就一定是预演）
   *   2. `confirm === 'RESTORE'`（精确串，顺手点不到）
   *   3. 服务以 `--allow-restore` 启动
   *
   * @param {unknown} body
   */
  async function executeRestore(body) {
    const input = body !== null && typeof body === 'object' ? /** @type {any} */ (body) : {};
    const dryRun = input.dryRun !== false; // 只有**显式** false 才可能真执行

    if (typeof input.backupDir !== 'string' || input.backupDir.length === 0) {
      throw fail('restore/execute 需要 backupDir（备份目录名）');
    }

    // 预演无论如何都先算出来——真执行也要靠它。
    /** @type {any} */
    let plan = null;
    /** @type {string | null} */
    let planError = null;
    try {
      plan = await planRestore({ backupDir: input.backupDir });
    } catch (err) {
      planError = /** @type {Error} */ (err).message;
    }

    if (dryRun) {
      return {
        dryRun: true,
        executed: false,
        promoted: null,
        plan,
        planError,
        confirmationRequired: true,
        howToExecute: {
          method: 'POST /api/restore/execute',
          body: { backupDir: input.backupDir, dryRun: false, confirm: RESTORE_CONFIRM_TOKEN },
          serverFlag: '--allow-restore',
        },
        note: '这只是预演，库没有被改动。要真执行必须同时满足：dryRun=false + confirm="RESTORE" + 服务以 --allow-restore 启动。',
      };
    }

    // 到了这里说明显式要求真执行。逐道闸门检查。
    if (input.confirm !== RESTORE_CONFIRM_TOKEN) {
      throw fail(`真执行恢复必须带 confirm="${RESTORE_CONFIRM_TOKEN}"（区分大小写）`, 'CONFIRMATION_REQUIRED');
    }
    if (!capabilities.restore) {
      const err = /** @type {Error & {code?: string, details?: Record<string, unknown>}} */ (
        new Error('恢复执行能力未开启：请以 --allow-restore 启动')
      );
      err.code = 'CAPABILITY_REQUIRED';
      err.details = { capability: 'restore', howToEnable: '--allow-restore 或 BRAIN_ALLOW_RESTORE=1' };
      throw err;
    }
    if (planError !== null) throw fail(`预演失败，不能执行：${planError}`);
    if (facades.restore === null) throw notAvailable('restore.executeRestore');

    const targetDir =
      typeof input.targetDir === 'string' && input.targetDir.length > 0 ? input.targetDir : config.dbPath;

    const result = await /** @type {any} */ (facades.restore).executeRestore(plan, { targetDir });
    const state = writeRestoreState({
      promoted: result?.promoted === true,
      reason: String(result?.reason ?? (result?.promoted === true ? 'RESTORE_PROMOTED' : 'RESTORE_NOT_PROMOTED')),
      backupDir: input.backupDir,
    });

    // 重放结果是「旧备份不许让已删内容复活」这条门槛的直接回显。
    // 备份线可能用不同字段名，这里统一探测；都没有就明说「未报告」，不假装成功。
    const replayRaw =
      result?.replay ?? result?.replayed ?? result?.ledgerMerge ?? result?.ledger_merge ?? result?.mergedDeletions ?? null;
    const replay = normalizeReplay(replayRaw);
    const expectedReplay = typeof plan?.deletionsAfterBackup === 'number' ? plan.deletionsAfterBackup : null;

    return {
      dryRun: false,
      executed: true,
      promoted: result?.promoted === true,
      reason: result?.reason ?? null,
      restoredAt: result?.restoredAt ?? new Date().toISOString(),
      rebuilt: result?.rebuilt ?? null,
      warnings: result?.warnings ?? [],
      plan,
      // 重放：expected 是账本里「备份之后发生过的删除」条数
      replay,
      replayExpected: expectedReplay,
      replayNote:
        expectedReplay === null || expectedReplay === 0
          ? '这份备份之后没有发生过删除，不需要重放。'
          : replay === null
            ? `备份之后有 ${expectedReplay} 条删除需要重放，但执行结果里没有报告重放情况——不能假定它成功了。`
            : replay.ok
              ? `重放 ${replay.applied} 条删除：成功。`
              : `重放 ${replay.applied} 条删除：${replay.failed} 条失败——**被删内容可能已随备份复活，不能上线**。`,
      restoreState: state,
      note:
        result?.promoted === true
          ? '恢复已上架。'
          : '恢复已完成但未上架（promoted=false）：这个实例只能只读检修，页面顶部会一直显示隔离横幅。',
    };
  }

  /**
   * 把备份线报告的重放结果归一成 `{ applied, failed, ok }`。
   * @param {unknown} raw
   * @returns {{ applied: number, failed: number, ok: boolean, raw: unknown } | null}
   */
  function normalizeReplay(raw) {
    if (raw === null || raw === undefined) return null;
    if (typeof raw === 'number') return { applied: raw, failed: 0, ok: true, raw };
    if (typeof raw !== 'object') return null;
    const o = /** @type {any} */ (raw);
    const applied = asInt(o.applied ?? o.replayed ?? o.count ?? o.merged ?? 0);
    const failed = asInt(o.failed ?? o.errors?.length ?? o.failedCount ?? 0);
    return {
      applied,
      failed,
      ok: o.ok === undefined ? failed === 0 : o.ok === true && failed === 0,
      raw,
    };
  }

  /** 健康页要看到的治理状态。 */
  function healthExtra() {
    const iso1 = isolation();
    return {
      isolation: iso1,
      capabilities: capabilitySnapshot(),
      backupDir,
      ledgerDir: path.join(path.dirname(config.dbPath), DELETION_LEDGER_DIRNAME),
      keepDays,
    };
  }

  return {
    capabilities,
    capabilitySnapshot,
    isolation,
    healthExtra,
    deletionStatus,
    listDeletions,
    listBackups,
    createBackup,
    verifyBackup,
    planRestore,
    executeRestore,
    /** 排障用：当前探测到的门面。 */
    facades: () => ({ ...capabilitySnapshot().facades }),
  };
}
