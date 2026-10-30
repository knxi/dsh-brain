// @ts-check
/**
 * `brainstem` —— 健康监控与告警（脑干）。
 *
 * ── 它做什么 ──
 *
 * 定期做一组**只读**检查，把「现在是不是出问题了」变成 `health_alerts` 里的一行行记录：
 * 库完整吗、WAL 有没有膨胀、事件有没有积压、删除任务有没有卡住、错误事件有没有激增、
 * 备份是不是过期了。
 *
 * 与 `/api/health` 的分工：health 是「此刻的快照」，这张表是「发生过什么」。
 * 没有它，监测就只是一次次点开看；有了它，才能回答「昨天半夜库锁了多久」。
 *
 * ── 三条纪律 ──
 *
 * 1. **检查项只读，不修**。这里不跑 checkpoint、不改 PRAGMA、不动备份目录。
 *    自动修复会让「健康」变成「我自己觉得健康」——所以修复永远是一个显式动作。
 * 2. **告警去重靠 `ux_health_alerts_open_code`**（0008 的部分唯一索引：同一 code
 *    同时只允许一条 open）。反复触发累加 `occurrences` 并更新 `last_seen_at`，
 *    而不是刷屏；故障消失后自动 resolve（`resolution='auto_recovered'`），
 *    让「现在还有几条在响」永远是准的。
 * 3. **不受 paused 开关影响**。它是无意识系统而不是自主行为：把体检也停掉，
 *    等于在「主人要求全局停止」时顺便把仪表盘也关了——那是最不该失明的时刻。
 *    （这条在 docs 里写清楚，是刻意的设计选择。）
 *
 * ── 严重度映射（常量表，见 CHECK_SEVERITY）──
 *
 * 为什么写常量：安全/运维阈值必须可审、可回滚。写死在 if 里的话，改一个阈值
 * 谁也不敢动，动了也说不清影响面。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { BrainError, formatLocalIso } from '@dsh-brain/core';
import {
  clampInt,
  createReader,
  hashKey,
  newId,
  parseObjectJson,
  requireRow,
  requireText,
  resolveScopeId,
  stringifyJson,
  tableExists,
} from './internal.js';

/** 检查项 code。用点号分层：`域.对象`，面板可以按域折叠。 */
export const CHECK_CODES = Object.freeze({
  DB_QUICK_CHECK: 'db.quick_check',
  WAL_SIZE: 'db.wal_size',
  OUTBOX_BACKLOG: 'outbox.backlog',
  DELETION_PENDING: 'deletion.pending',
  ERROR_EVENT_RATE: 'error.event_rate',
  BACKUP_STALE: 'backup.stale',
});

/**
 * 每个检查项的严重度。
 *
 * 理由（为什么不是全都 high）：
 * - `db.quick_check` high：库损坏时读到的每一个答案都不可信，这是最高优先级。
 * - `backup.stale` medium：不是当前故障，但故障发生时少了一个可回滚点；
 *   它需要人处理，不该半夜把人叫起来。
 * - `deletion.pending` medium：删除请求没有落地=隐私承诺没有兑现，
 *   比性能问题严重，但仍不是系统崩溃。
 * - `error.event_rate` medium：错误在激增说明某个模块正在坏，需要人看。
 * - `wal_size` low：性能问题（读响应变慢），不影响正确性。
 * - `outbox.backlog` low：事件积压是**延迟**不是错误，消费者跟上就好。
 */
export const CHECK_SEVERITY = Object.freeze({
  [CHECK_CODES.DB_QUICK_CHECK]: 'high',
  [CHECK_CODES.WAL_SIZE]: 'low',
  [CHECK_CODES.OUTBOX_BACKLOG]: 'low',
  [CHECK_CODES.DELETION_PENDING]: 'medium',
  [CHECK_CODES.ERROR_EVENT_RATE]: 'medium',
  [CHECK_CODES.BACKUP_STALE]: 'medium',
});

/** 各检查项的中文标题（告警列表要人看得懂）。 */
export const CHECK_TITLES = Object.freeze({
  [CHECK_CODES.DB_QUICK_CHECK]: '主账完整性检查未通过',
  [CHECK_CODES.WAL_SIZE]: 'WAL 文件过大（checkpoint 可能滞后）',
  [CHECK_CODES.OUTBOX_BACKLOG]: 'outbox 事件积压',
  [CHECK_CODES.DELETION_PENDING]: '删除任务长时间未完成',
  [CHECK_CODES.ERROR_EVENT_RATE]: '错误事件在最近一小时内激增',
  [CHECK_CODES.BACKUP_STALE]: '最新备份已超过 7 天',
});

/** WAL 告警阈值：64MB。缺省 wal_autocheckpoint=1000 页（约 4MB），到这个量级说明 checkpoint 明显滞后。 */
export const WAL_WARN_BYTES = 64 * 1024 * 1024;
/** outbox 积压告警阈值（pending + failed + in_progress）。 */
export const OUTBOX_WARN_COUNT = 500;
/** 删除任务宽限：一小时内还在排队是正常的（worker 可能刚好没跑）。 */
export const DELETION_PENDING_GRACE_MS = 60 * 60 * 1000;
/** 错误事件统计窗口与阈值：一小时 20 条。 */
export const ERROR_EVENT_WINDOW_MS = 60 * 60 * 1000;
export const ERROR_EVENT_WARN_COUNT = 20;
/** 备份过期阈值：7 天。 */
export const BACKUP_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_ALERT_LIMIT = 50;
export const MAX_ALERT_LIMIT = 200;
/** 备份目录里这些后缀是半成品，不参与「最新备份」判断。 */
const PARTIAL_SUFFIX = /\.(tmp|partial|part|inprogress)$/i;

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
function rowToAlert(row) {
  return {
    id: String(row.id),
    scopeId: row.scope_id == null ? null : String(row.scope_id),
    at: String(row.at),
    atMs: Number(row.at_ms),
    code: String(row.code),
    module: String(row.module),
    severity: String(row.severity),
    title: String(row.title),
    detail: parseObjectJson(row.detail_json),
    status: String(row.status),
    occurrences: Number(row.occurrences ?? 1),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    ackedAt: row.acked_at == null ? null : String(row.acked_at),
    ackedBy: row.acked_by == null ? null : String(row.acked_by),
    resolvedAt: row.resolved_at == null ? null : String(row.resolved_at),
    resolution: row.resolution == null ? null : String(row.resolution),
    createdAt: String(row.created_at),
  };
}

/**
 * 造健康监控模块。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string, epoch_ms: number } },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   workspace?: any,
 *   bindings?: { scope_id?: string, person_id?: string } | null,
 *   dbPath?: string | null,
 *   backupsDir?: string | null,
 * }} options
 */
export function createBrainstem(options) {
  const { db, queue, clock } = options;
  const bindings = options.bindings ?? null;
  const reader = createReader(db);
  const dbPath = typeof options.dbPath === 'string' && options.dbPath.length > 0 ? options.dbPath : null;
  const backupsDir = typeof options.backupsDir === 'string' && options.backupsDir.length > 0
    ? options.backupsDir
    : dbPath !== null && dbPath !== ':memory:'
      ? path.join(path.dirname(path.resolve(dbPath)), 'backups')
      : null;

  /**
   * 检查 1：`PRAGMA quick_check`。
   * 用 quick_check 而不是 integrity_check：前者跳过了索引内容比对，日常巡检够用且快得多；
   * 真正的深检应该在维护窗口里单独跑。
   * @returns {{ code: string, ok: boolean, skipped: boolean, severity: string, detail: Record<string, unknown> }}
   */
  function checkQuickCheck() {
    const code = CHECK_CODES.DB_QUICK_CHECK;
    const severity = CHECK_SEVERITY[code];
    try {
      const row = /** @type {any} */ (db.prepare('PRAGMA quick_check').get());
      const verdict = String(row?.quick_check ?? 'unknown');
      return { code, ok: verdict === 'ok', skipped: false, severity, detail: { verdict } };
    } catch (err) {
      return {
        code,
        ok: false,
        skipped: false,
        severity,
        detail: { verdict: 'error', error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) },
      };
    }
  }

  /**
   * 检查 2：WAL 文件大小。需要 dbPath；内存库或没传路径时跳过（不报错）。
   * @returns {{ code: string, ok: boolean, skipped: boolean, severity: string, detail: Record<string, unknown> }}
   */
  function checkWalSize() {
    const code = CHECK_CODES.WAL_SIZE;
    const severity = CHECK_SEVERITY[code];
    if (dbPath === null || dbPath === ':memory:') {
      return { code, ok: true, skipped: true, severity, detail: { reason: 'db_path_unavailable' } };
    }
    let bytes = 0;
    try {
      bytes = statSync(`${dbPath}-wal`).size;
    } catch (err) {
      // ENOENT = 没有 WAL 文件（刚 checkpoint 过或还没写过）：0 字节，不是故障。
      if (/** @type {any} */ (err)?.code !== 'ENOENT') {
        return {
          code,
          ok: true,
          skipped: true,
          severity,
          detail: { reason: 'stat_failed', error: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200) },
        };
      }
      bytes = 0;
    }
    return {
      code,
      ok: bytes <= WAL_WARN_BYTES,
      skipped: false,
      severity,
      detail: { bytes, warnBytes: WAL_WARN_BYTES },
    };
  }

  /**
   * 检查 3：outbox 积压（未消费的工作项）。
   * @returns {{ code: string, ok: boolean, skipped: boolean, severity: string, detail: Record<string, unknown> }}
   */
  function checkOutboxBacklog() {
    const code = CHECK_CODES.OUTBOX_BACKLOG;
    const severity = CHECK_SEVERITY[code];
    if (!tableExists(db, 'outbox')) {
      return { code, ok: true, skipped: true, severity, detail: { reason: 'table_missing' } };
    }
    try {
      const backlog = reader.count(
        "SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending', 'failed', 'in_progress')",
      );
      const dead = reader.count("SELECT COUNT(*) AS n FROM outbox WHERE status = 'dead'");
      return {
        code,
        ok: backlog <= OUTBOX_WARN_COUNT,
        skipped: false,
        severity,
        detail: { backlog, dead, warnCount: OUTBOX_WARN_COUNT },
      };
    } catch (err) {
      return { code, ok: true, skipped: true, severity, detail: { reason: 'query_failed', error: String(err).slice(0, 200) } };
    }
  }

  /**
   * 检查 4：删除任务长时间未完成。
   * 只统计超过宽限期的 pending/failed —— 刚入队几秒的任务不是问题，
   * 每分钟都报一次「有 1 个删除任务在跑」会把告警变成噪音。
   * @param {{ nowMs: number }} ctx
   * @returns {{ code: string, ok: boolean, skipped: boolean, severity: string, detail: Record<string, unknown> }}
   */
  function checkDeletionPending(ctx) {
    const code = CHECK_CODES.DELETION_PENDING;
    const severity = CHECK_SEVERITY[code];
    if (!tableExists(db, 'deletion_jobs')) {
      return { code, ok: true, skipped: true, severity, detail: { reason: 'table_missing' } };
    }
    try {
      const threshold = new Date(ctx.nowMs - DELETION_PENDING_GRACE_MS).toISOString();
      const stale = reader.count(
        "SELECT COUNT(*) AS n FROM deletion_jobs WHERE status IN ('pending', 'failed') AND created_at < ?",
        [threshold],
      );
      const running = reader.count("SELECT COUNT(*) AS n FROM deletion_jobs WHERE status = 'running'");
      return {
        code,
        ok: stale === 0,
        skipped: false,
        severity,
        detail: { stale, running, graceMs: DELETION_PENDING_GRACE_MS },
      };
    } catch (err) {
      return { code, ok: true, skipped: true, severity, detail: { reason: 'query_failed', error: String(err).slice(0, 200) } };
    }
  }

  /**
   * 检查 5：最近一小时内 error 渠道的 ws_events 数量。
   * @param {{ nowMs: number, scopeId: string }} ctx
   * @returns {{ code: string, ok: boolean, skipped: boolean, severity: string, detail: Record<string, unknown> }}
   */
  function checkErrorEventRate(ctx) {
    const code = CHECK_CODES.ERROR_EVENT_RATE;
    const severity = CHECK_SEVERITY[code];
    if (!tableExists(db, 'ws_events')) {
      return { code, ok: true, skipped: true, severity, detail: { reason: 'table_missing' } };
    }
    try {
      const fromMs = ctx.nowMs - ERROR_EVENT_WINDOW_MS;
      const errors = reader.count(
        "SELECT COUNT(*) AS n FROM ws_events WHERE scope_id = ? AND channel = 'error' AND at_ms >= ?",
        [ctx.scopeId, fromMs],
      );
      return {
        code,
        ok: errors <= ERROR_EVENT_WARN_COUNT,
        skipped: false,
        severity,
        detail: { errors, windowMs: ERROR_EVENT_WINDOW_MS, warnCount: ERROR_EVENT_WARN_COUNT },
      };
    } catch (err) {
      return { code, ok: true, skipped: true, severity, detail: { reason: 'query_failed', error: String(err).slice(0, 200) } };
    }
  }

  /**
   * 检查 6：最新备份是否超过 7 天。
   *
   * 目录不存在 → skipped（题面要求：不报错）。目录存在但没有备份文件 → **告警**：
   * 「有目录但从来没成功备份过」不是正常状态，正是最该知道的情况。
   * @param {{ nowMs: number }} ctx
   * @returns {{ code: string, ok: boolean, skipped: boolean, severity: string, detail: Record<string, unknown> }}
   */
  function checkBackupStale(ctx) {
    const code = CHECK_CODES.BACKUP_STALE;
    const severity = CHECK_SEVERITY[code];
    if (backupsDir === null) {
      return { code, ok: true, skipped: true, severity, detail: { reason: 'backup_dir_unconfigured' } };
    }
    if (!existsSync(backupsDir)) {
      return { code, ok: true, skipped: true, severity, detail: { reason: 'backup_dir_missing', dir: backupsDir } };
    }
    try {
      const entries = readdirSync(backupsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && !PARTIAL_SUFFIX.test(entry.name));
      if (entries.length === 0) {
        return { code, ok: false, skipped: false, severity, detail: { reason: 'no_backup_files', dir: backupsDir } };
      }
      let newestMs = 0;
      let newestName = null;
      for (const entry of entries) {
        try {
          const stat = statSync(path.join(backupsDir, entry.name));
          if (stat.mtimeMs > newestMs) {
            newestMs = stat.mtimeMs;
            newestName = entry.name;
          }
        } catch {
          /* 单个文件 stat 失败不影响其它文件 */
        }
      }
      if (newestMs === 0) {
        return { code, ok: false, skipped: false, severity, detail: { reason: 'no_readable_backup', dir: backupsDir } };
      }
      const ageMs = ctx.nowMs - newestMs;
      return {
        code,
        ok: ageMs <= BACKUP_STALE_MS,
        skipped: false,
        severity,
        detail: { newestBackup: newestName, ageMs, staleMs: BACKUP_STALE_MS, fileCount: entries.length },
      };
    } catch (err) {
      return { code, ok: true, skipped: true, severity, detail: { reason: 'scan_failed', error: String(err).slice(0, 200) } };
    }
  }

  /**
   * 跑一次全部检查，并把结果落到 health_alerts。
   *
   * @param {{ scopeId?: string, nowMs?: number }} [input]
   * @returns {Promise<any>}
   */
  async function checkOnce(input = {}) {
    const startedAt = Date.now();
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const stamp = clock.stamp();
    const nowMs = Number.isFinite(Number(input.nowMs)) && input.nowMs !== undefined
      ? Number(input.nowMs)
      : (stamp.epoch_ms ?? Date.parse(stamp.utc));

    const checks = [
      checkQuickCheck(),
      checkWalSize(),
      checkOutboxBacklog(),
      checkDeletionPending({ nowMs }),
      checkErrorEventRate({ nowMs, scopeId }),
      checkBackupStale({ nowMs }),
    ];

    const alerts = await queue.write(
      (tx) => {
        let created = 0;
        let updated = 0;
        let resolved = 0;
        let raised = 0;
        const writeStamp = clock.stamp();
        const nowIso = new Date(nowMs).toISOString();
        // at / at_local 必须指同一个时刻：用 nowMs 推本地形态，而不是用「写库那一刻」。
        const nowLocal = formatLocalIso(new Date(nowMs), clock.timeZone ?? 'Asia/Shanghai');

        for (const check of checks) {
          const open = tx.get("SELECT * FROM health_alerts WHERE code = ? AND status = 'open' LIMIT 1", [check.code]);
          const faulty = check.ok !== true && check.skipped !== true;

          if (!faulty) {
            if (open !== undefined) {
              // 故障消失 → 自动收口。留着一条永远 open 的告警，告警列表很快就会变成噪声。
              tx.run(
                `UPDATE health_alerts
                    SET status = 'resolved', resolved_at = ?, resolution = 'auto_recovered'
                  WHERE id = ?`,
                [nowIso, String(open.id)],
              );
              resolved += 1;
            }
            continue;
          }

          raised += 1;
          const title = CHECK_TITLES[check.code] ?? check.code;
          const detailJson = stringifyJson(check.detail, 'detail');
          if (open !== undefined) {
            // 重复触发：累加 occurrences + 更新 last_seen，不新建行（ux_health_alerts_open_code 兜底）。
            tx.run(
              `UPDATE health_alerts
                  SET occurrences = occurrences + 1, last_seen_at = ?, severity = ?,
                      title = ?, detail_json = ?
                WHERE id = ?`,
              [nowIso, check.severity, title, detailJson, String(open.id)],
            );
            updated += 1;
            continue;
          }
          const id = newId('hal');
          tx.run(
            `INSERT INTO health_alerts (
               id, scope_id, at, at_local, at_ms, code, module, severity, title, detail_json,
               status, occurrences, first_seen_at, last_seen_at, created_at, created_at_local
             ) VALUES (?, ?, ?, ?, ?, ?, 'brainstem', ?, ?, ?, 'open', 1, ?, ?, ?, ?)`,
            [
              id,
              scopeId,
              nowIso,
              nowLocal,
              nowMs,
              check.code,
              check.severity,
              title,
              detailJson,
              nowIso,
              nowIso,
              writeStamp.utc,
              writeStamp.local,
            ],
          );
          created += 1;
        }

        return { created, updated, resolved, raised };
      },
      { label: 'brainstem.checkOnce' },
    );

    return {
      checkedAt: stamp.utc,
      durationMs: Math.max(0, Date.now() - startedAt),
      scopeId,
      checks,
      failed: checks.filter((check) => check.ok !== true && check.skipped !== true).length,
      skipped: checks.filter((check) => check.skipped === true).length,
      alertsRaised: alerts.raised,
      alertsCreated: alerts.created,
      alertsUpdated: alerts.updated,
      alertsResolved: alerts.resolved,
    };
  }

  /**
   * 列告警。
   * @param {{ status?: string, severity?: string, limit?: number, scopeId?: string }} [query]
   * @returns {{ items: any[], limit: number }}
   */
  function listAlerts(query = {}) {
    const scopeId = resolveScopeId(query.scopeId, bindings);
    const limit = clampInt(query.limit, 1, MAX_ALERT_LIMIT, DEFAULT_ALERT_LIMIT, 'limit');
    const where = ['scope_id = ?'];
    /** @type {any[]} */
    const params = [scopeId];
    if (query.status !== undefined && query.status !== null && query.status !== '') {
      where.push('status = ?');
      params.push(String(query.status));
    }
    if (query.severity !== undefined && query.severity !== null && query.severity !== '') {
      where.push('severity = ?');
      params.push(String(query.severity));
    }
    params.push(limit);
    const rows = reader.all(
      `SELECT * FROM health_alerts WHERE ${where.join(' AND ')}
        ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'acked' THEN 1 ELSE 2 END,
                 at_ms DESC, id DESC LIMIT ?`,
      params,
    );
    return { items: rows.map(rowToAlert), limit };
  }

  /**
   * 确认（我看过了，但还没修）。确认不等于解决：状态机分成两步，
   * 是为了让「已确认但还响着」的东西继续留在列表里。
   * @param {string} id
   * @param {{ by: string, scopeId?: string }} opts
   * @returns {Promise<any>}
   */
  async function ack(id, opts = /** @type {any} */ ({})) {
    const alertId = requireText(id, 'id', { maxLength: 120 });
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const by = requireText(opts.by, 'by', { maxLength: 120 });
    // 事务外预检：业务错误必须在进入写队列之前抛（见 internal.requireRow 的说明）。
    const pre = requireRow(
      reader,
      'SELECT status FROM health_alerts WHERE id = ? AND scope_id = ?',
      [alertId, scopeId],
      `告警不存在：${alertId}`,
    );
    if (String(pre.status) === 'acked') {
      return { id: alertId, status: 'acked', acked: false, alreadyAcked: true };
    }
    if (String(pre.status) === 'resolved' || String(pre.status) === 'expired') {
      throw new BrainError('INVALID_ARGUMENT', `已收口的告警不能确认（当前 ${String(pre.status)}）`);
    }
    return queue.write(
      (tx) => {
        const row = tx.get('SELECT status FROM health_alerts WHERE id = ? AND scope_id = ?', [alertId, scopeId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `告警不存在：${alertId}`);
        const status = String(row.status);
        if (status === 'acked') return { id: alertId, status, acked: false, alreadyAcked: true };
        if (status === 'resolved' || status === 'expired') {
          throw new BrainError('INVALID_ARGUMENT', `已收口的告警不能确认（当前 ${status}）`);
        }
        const stamp = clock.stamp();
        tx.run(
          "UPDATE health_alerts SET status = 'acked', acked_at = ?, acked_by = ? WHERE id = ? AND scope_id = ?",
          [stamp.utc, by, alertId, scopeId],
        );
        return { id: alertId, status: 'acked', acked: true, alreadyAcked: false, by };
      },
      { label: 'brainstem.ack' },
    );
  }

  /**
   * 解决（修好了/不修了，都得写原因）。
   * @param {string} id
   * @param {{ by: string, resolution?: string | null, scopeId?: string }} opts
   * @returns {Promise<any>}
   */
  async function resolve(id, opts = /** @type {any} */ ({})) {
    const alertId = requireText(id, 'id', { maxLength: 120 });
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const by = requireText(opts.by, 'by', { maxLength: 120 });
    const resolution = opts.resolution === undefined || opts.resolution === null
      ? null
      : String(opts.resolution).slice(0, 500);
    // 事务外预检（理由同 ack）。
    const pre = requireRow(
      reader,
      'SELECT status FROM health_alerts WHERE id = ? AND scope_id = ?',
      [alertId, scopeId],
      `告警不存在：${alertId}`,
    );
    if (String(pre.status) === 'resolved') {
      return { id: alertId, status: 'resolved', resolved: false, alreadyResolved: true };
    }
    return queue.write(
      (tx) => {
        const row = tx.get('SELECT status FROM health_alerts WHERE id = ? AND scope_id = ?', [alertId, scopeId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `告警不存在：${alertId}`);
        const status = String(row.status);
        if (status === 'resolved') {
          return { id: alertId, status, resolved: false, alreadyResolved: true };
        }
        const stamp = clock.stamp();
        tx.run(
          `UPDATE health_alerts
              SET status = 'resolved', resolved_at = ?, resolution = ?, acked_by = COALESCE(acked_by, ?)
            WHERE id = ? AND scope_id = ?`,
          [stamp.utc, resolution, by, alertId, scopeId],
        );
        return { id: alertId, status: 'resolved', resolved: true, alreadyResolved: false, by, resolution };
      },
      { label: 'brainstem.resolve' },
    );
  }

  /**
   * 统计（面板用）。
   * @param {{ scopeId?: string }} [opts]
   * @returns {{ open: number, acked: number, resolved: number, worstSeverity: string | null, lastCheckedAt: string | null }}
   */
  function stats(opts = {}) {
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const rows = reader.all(
      'SELECT status, COUNT(*) AS n FROM health_alerts WHERE scope_id = ? GROUP BY status',
      [scopeId],
    );
    /** @type {Record<string, number>} */
    const byStatus = {};
    for (const row of rows) byStatus[String(row.status)] = Number(row.n);
    const worst = reader.get(
      `SELECT severity FROM health_alerts WHERE scope_id = ? AND status IN ('open', 'acked')
        ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 WHEN 'low' THEN 2 ELSE 3 END LIMIT 1`,
      [scopeId],
    );
    const last = reader.get(
      'SELECT last_seen_at FROM health_alerts WHERE scope_id = ? ORDER BY last_seen_at DESC, id DESC LIMIT 1',
      [scopeId],
    );
    return {
      open: byStatus.open ?? 0,
      acked: byStatus.acked ?? 0,
      resolved: byStatus.resolved ?? 0,
      worstSeverity: worst === undefined ? null : String(worst.severity),
      lastCheckedAt: last === undefined ? null : String(last.last_seen_at),
    };
  }

  return {
    checkOnce,
    listAlerts,
    ack,
    resolve,
    stats,
    CHECK_CODES,
    CHECK_SEVERITY,
    CHECK_TITLES,
    threshold: Object.freeze({
      WAL_WARN_BYTES,
      OUTBOX_WARN_COUNT,
      DELETION_PENDING_GRACE_MS,
      ERROR_EVENT_WINDOW_MS,
      ERROR_EVENT_WARN_COUNT,
      BACKUP_STALE_MS,
    }),
    /** 供测试/控制台算告警指纹用（与 dedupe 无关，仅展示）。 */
    fingerprint: (code) => hashKey('hal', [String(code)]),
  };
}
