// @ts-check
/**
 * 删除屏障基础（CONTRACTS 第 8 节 / 设计 21.7 的 M1 子集）。
 *
 * 固定顺序：
 *   写 tombstone → deletion_epoch +1 → 目标与全部派生物不可检索 → 返回 accepted（上层映射 202）
 *   → 异步 worker 清正文（重查屏障后执行）
 *
 * 两个屏障检查，语义不同，不要混用：
 * - `assertEpochFresh(workerEpoch)`：给**派生/写回类**任务（摘要、提取、导入、恢复）用。
 *   全局 deletion_epoch 前进即保守放弃 —— 宁可多算一次，也不让删除后完成的 worker 写回。
 * - `checkTargetBarrier(job)`：给**清理类** job 用。按目标 + 该目标的 epoch 判断，
 *   别的目标发生删除不会误伤本 job。
 *
 * M1 范围声明（不虚报）：
 * - 已实现：tombstone、epoch、即时不可检索、正文清除（memories/memory_versions/events.payload_text/
 *   summaries）、source_refs 删除、context_packages 保守失效、审计、屏障重查。
 * - **M3 补齐**（本文件负责的部分）：删除事务内**同步追加独立删除账本**（`ledger` 选项），
 *   账本追加失败 → 整个删除请求失败，绝不虚报删除成功。FTS 三表 / 导出 / blob 引用的清理
 *   在 `deletion-worker.js` 里做；本文件只负责「打标记 + 记账 + 排 job」。
 * - 未接线账本时（不传 `ledger`）行为与 M1 完全一致：`ledger_synced_at` 保持 NULL，
 *   恢复流程必须把它当限制报告。传了 ledger 但账本不可用 → 删除请求直接失败。
 */

import { randomBytes } from 'node:crypto';
import { BrainError, DeletionBarrierError } from '@dsh-brain/core';
import { enqueueOutbox } from './outbox.js';
import { insertAudit } from './ledger.js';
import { META_KEYS, bumpDeletionEpoch, readDeletionEpoch, writeMeta } from './meta.js';

/** @typedef {import('./write-queue.js').TxApi} TxApi */

/** 目标类型白名单（与 DDL CHECK 一致）。 */
export const TARGET_KINDS = Object.freeze([
  'memory',
  'event',
  'session',
  'summary',
  'source_ref',
  'context_package',
  'task_snapshot',
  'scope',
]);

/** 清理 job 类型白名单（与 DDL CHECK 一致）。 */
export const JOB_KINDS = Object.freeze([
  'purge_text',
  'scrub_index',
  'purge_exports',
  'drop_context_packages',
  'purge_blobs',
]);

/** M1 默认为一个目标排哪些清理 job。 */
export const DEFAULT_PURGE_JOBS = Object.freeze(['purge_text']);

/**
 * M3 完整清理链，**顺序即执行顺序**（M3-INTERFACES §2.1 第 6 步）：
 * 正文 → FTS 三表 → context_packages → 导出 → blob 引用。
 *
 * 注意：`DEFAULT_PURGE_JOBS` 保持 M1 的最小值不变（改默认值会让 M1 的删除测试与
 * 已有行为漂移）；M3 的完整链由 `deletion-worker.js` 对已存在的墓碑**幂等补齐**。
 * 顺序也不靠 job 的 created_at 保证——worker 按这张表排序执行。
 */
export const M3_PURGE_JOBS = Object.freeze([
  'purge_text',
  'scrub_index',
  'drop_context_packages',
  'purge_exports',
  'purge_blobs',
]);

/**
 * @param {string} prefix
 * @returns {string}
 */
function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/**
 * 造删除屏障服务。
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: TxApi) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   ledger?: ReturnType<import('./deletion-ledger.js').createDeletionLedger> | null,
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 * }} options
 */
export function createDeletionBarrier(options) {
  const { db, queue, clock } = options;
  const ledger = options.ledger ?? null;
  const alert = options.alert ?? (() => {});

  /** 当前全局删除纪元。 */
  function getDeletionEpoch() {
    return readDeletionEpoch(db);
  }

  /**
   * 派生任务写回前重查屏障：worker 启动时的 epoch 若落后于当前 epoch，拒绝写回。
   * @param {number} workerEpoch
   * @param {{ target_kind?: string, target_id?: string }} [context]
   * @returns {number} 当前 epoch（等于 workerEpoch 时）
   */
  function assertEpochFresh(workerEpoch, context = {}) {
    if (!Number.isInteger(workerEpoch) || workerEpoch < 0) {
      throw new BrainError('INVALID_ARGUMENT', `deletion_epoch 必须是非负整数（收到 ${String(workerEpoch)}）`);
    }
    const current = getDeletionEpoch();
    if (workerEpoch < current) {
      throw new DeletionBarrierError('派生任务基于过期删除纪元，拒绝写回', {
        worker_epoch: workerEpoch,
        current_epoch: current,
        ...context,
      });
    }
    return current;
  }

  /**
   * 独立账本同步：**只在删除的 DB 事务内调用**。
   *
   * 抛错 = 账本没记上 = 整个删除请求必须失败（M3-INTERFACES §1.3）。
   * 偏置方向是刻意选的：
   * - 账本成功 + 事务提交失败 → 账本多一条，恢复时会重放一条**幂等**删除（安全）；
   * - 事务成功 + 账本失败 → 旧备份会把已删内容复活（绝不接受，所以先记账本）。
   *
   * 账本里只放元数据（tombstoneId / 目标 / epoch / 时间 / scope / 原因 / 执行者），
   * 正文由 worker 清，永不过账本。
   *
   * @param {TxApi} tx
   * @param {{
   *   tombstoneId: string,
   *   targetKind: string,
   *   targetId: string,
   *   scopeId: string,
   *   epoch: number,
   *   reason: string,
   *   actor: string,
   *   stamp: { utc: string, local: string },
   * }} input
   * @returns {{ seq: number, entryHash: string, watermark: { epoch: number, lastSeq: number, updatedAt: string } } | null}
   */
  function syncDeletionLedger(tx, input) {
    if (ledger === null) return null; // 未接线：保持 M1 语义（ledger_synced_at 留 NULL）
    const appended = ledger.append({
      tombstoneId: input.tombstoneId,
      targetKind: input.targetKind,
      targetId: input.targetId,
      memoryId: input.targetKind === 'memory' ? input.targetId : null,
      epoch: input.epoch,
      requestedAt: input.stamp.utc,
      scopeId: input.scopeId,
      reason: input.reason,
      actor: input.actor,
    });
    tx.run(
      'UPDATE deletion_tombstones SET ledger_synced_at = ?, ledger_synced_at_local = ? WHERE tombstone_id = ?',
      [input.stamp.utc, input.stamp.local, input.tombstoneId],
    );
    return appended;
  }

  /**
   * 目标表的 scope 探针（只用于判断「行存在但 scope 不同」）。
   * `source_refs` 没有 scope 列、`scope` 目标本身即边界，因此不在表里。
   */
  const TARGET_SCOPE_PROBES = Object.freeze({
    memory: 'SELECT scope_id FROM memories WHERE id = ?',
    event: 'SELECT scope_id FROM events WHERE event_id = ?',
    session: 'SELECT scope_id FROM sessions WHERE session_id = ?',
    summary: 'SELECT scope_id FROM summaries WHERE summary_id = ?',
    task_snapshot: 'SELECT scope_id FROM task_snapshots WHERE snapshot_id = ?',
    context_package: 'SELECT scope_id FROM context_packages WHERE context_id = ?',
  });

  /**
   * 写路径 scope 校验：目标行必须属于调用方 scope，否则一律 `NOT_FOUND`
   * （不是 FORBIDDEN——不确认目标存在性）。
   *
   * 只拒绝「行存在但 scope 不同」：行不存在仍放行，保留「对未落库目标预打墓碑」的
   * 既有语义（删除屏障本来就是先屏蔽、后清正文，预删除是合法用法）。
   *
   * @param {TxApi} tx
   * @param {string} targetKind
   * @param {string} targetId
   * @param {string} scopeId
   */
  function assertTargetScope(tx, targetKind, targetId, scopeId) {
    const sql = TARGET_SCOPE_PROBES[targetKind];
    if (sql === undefined) return;
    const row = /** @type {Record<string, unknown> | undefined} */ (tx.get(sql, [targetId]));
    if (row === undefined) return;
    const rowScope = row.scope_id === null || row.scope_id === undefined ? null : String(row.scope_id);
    if (rowScope !== null && rowScope !== scopeId) {
      throw new BrainError('NOT_FOUND', `删除目标不存在：${targetKind}/${targetId}`);
    }
  }

  /**
   * 发起删除。返回 `status:'accepted'` 表示「已立即屏蔽、等待异步清正文」——
   * 调用方应映射为 HTTP 202，而不是「已删干净」。
   *
   * @param {{
   *   target_kind: string,
   *   target_id: string,
   *   scope_id: string,
   *   reason: string,
   *   actor?: string,
   *   jobs?: readonly string[],
   * }} input
   * @returns {Promise<{
   *   status: 'accepted' | 'already_tombstoned',
   *   tombstone_id: string,
   *   deletion_epoch: number,
   *   idempotent?: boolean,
   *   affected?: Array<{ table: string, changes: number }>,
   *   jobs?: number,
   *   outbox_id?: string,
   *   ledger?: { seq: number, entryHash: string, watermark: { epoch: number, lastSeq: number, updatedAt: string } } | null,
   *   ledger_backfilled?: boolean,
   * }>}
   */
  async function requestDeletion(input) {
    if (!TARGET_KINDS.includes(input.target_kind)) {
      throw new BrainError('INVALID_ARGUMENT', `不支持的目标类型：${String(input.target_kind)}`);
    }
    if (typeof input.target_id !== 'string' || input.target_id.length === 0) {
      throw new BrainError('INVALID_ARGUMENT', '删除请求缺少 target_id');
    }
    if (typeof input.scope_id !== 'string' || input.scope_id.length === 0) {
      throw new BrainError('INVALID_ARGUMENT', '删除请求缺少 scope_id');
    }
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
      throw new BrainError('INVALID_ARGUMENT', '删除请求必须给出 reason');
    }
    const jobs = input.jobs ?? DEFAULT_PURGE_JOBS;
    for (const kind of jobs) {
      if (!JOB_KINDS.includes(kind)) {
        throw new BrainError('INVALID_ARGUMENT', `不支持的清理任务类型：${String(kind)}`);
      }
    }

    return queue.write(
      (tx) => {
        // 写路径 scope 收口：跨 scope 的目标一律 NOT_FOUND（不确认存在性）。
        assertTargetScope(tx, input.target_kind, input.target_id, input.scope_id);
        /** @type {Record<string, unknown> | undefined} */
        const existing = tx.get('SELECT * FROM deletion_tombstones WHERE target_kind = ? AND target_id = ?', [
          input.target_kind,
          input.target_id,
        ]);
        if (existing !== undefined) {
          // 已有墓碑也要对 scope：否则同一个 id 能被另一 scope 的请求「复用」成幂等放行。
          const existingScope =
            existing.scope_id === null || existing.scope_id === undefined ? null : String(existing.scope_id);
          if (existingScope !== null && existingScope !== input.scope_id) {
            throw new BrainError('NOT_FOUND', `删除目标不存在：${input.target_kind}/${input.target_id}`);
          }
          // 幂等：同一目标重复删除不重复抬高 epoch、不重复排队。
          /** @type {Record<string, unknown>} */
          const idempotent = {
            status: /** @type {const} */ ('already_tombstoned'),
            tombstone_id: String(existing.tombstone_id),
            deletion_epoch: Number(existing.deletion_epoch),
            idempotent: true,
          };
          // 老库补账：M1 时代打的墓碑没有跨备份记录（ledger_synced_at = NULL）。
          // 这里补记一次，让「账本覆盖全部删除」对历史数据也成立。同一 tombstone 只补一次，
          // 所以重复删除不会把账本撑爆。补记失败 → 事务回滚 → 请求失败（不许假装同步过）。
          if (ledger !== null && existing.ledger_synced_at === null) {
            const stamp = clock.stamp();
            idempotent.ledger = syncDeletionLedger(tx, {
              tombstoneId: idempotent.tombstone_id,
              targetKind: input.target_kind,
              targetId: input.target_id,
              scopeId: String(existing.scope_id ?? input.scope_id),
              epoch: Number(existing.deletion_epoch),
              reason: String(existing.reason ?? input.reason),
              actor: input.actor ?? 'owner',
              stamp,
            });
            idempotent.ledger_backfilled = true;
          }
          return idempotent;
        }

        const epoch = bumpDeletionEpoch(tx, clock);
        const tombstoneId = newId('tmb');
        const stamp = clock.stamp();
        tx.run(
          `INSERT INTO deletion_tombstones (
             tombstone_id, target_kind, target_id, scope_id, reason, requested_by,
             deletion_epoch, status, requested_at, requested_at_local, created_at, created_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
          [
            tombstoneId,
            input.target_kind,
            input.target_id,
            input.scope_id,
            input.reason,
            input.actor ?? 'owner',
            epoch,
            stamp.utc,
            stamp.local,
            stamp.utc,
            stamp.local,
          ],
        );

        // **独立账本同步**（M3-INTERFACES §1.3）：在 DB 事务内同步追加，不 await。
        // 顺序刻意如此——账本 append 抛错 → 事务回滚 → 删除请求失败。宁可删除失败，
        // 也不许出现「DB 认为删了、账本没记」这种旧备份会复活的组合。
        const ledgerRecord = syncDeletionLedger(tx, {
          tombstoneId,
          targetKind: input.target_kind,
          targetId: input.target_id,
          scopeId: input.scope_id,
          epoch,
          reason: input.reason,
          actor: input.actor ?? 'owner',
          stamp,
        });

        // 立即屏蔽：目标与派生物立刻不可检索（正文留给 worker）。
        const affected = shieldTarget(tx, {
          target_kind: input.target_kind,
          target_id: input.target_id,
          scope_id: input.scope_id,
          epoch,
          stamp,
        });

        // 上下文包保守失效：任何旧 epoch 的包都可能含被删内容，注入前必须重建（设计 21.4-7）。
        const packages = tx.run(
          `UPDATE context_packages
              SET status = 'discarded'
            WHERE scope_id = ? AND deletion_epoch < ? AND status IN ('built', 'attached')`,
          [input.scope_id, epoch],
        );
        affected.push({ table: 'context_packages', changes: Number(packages.changes) });

        for (const kind of jobs) {
          tx.run(
            `INSERT INTO deletion_jobs (
               job_id, tombstone_id, target_kind, target_id, scope_id, kind,
               status, attempts, max_attempts, deletion_epoch, created_at, created_at_local
             ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 5, ?, ?, ?)`,
            [
              newId('job'),
              tombstoneId,
              input.target_kind,
              input.target_id,
              input.scope_id,
              kind,
              epoch,
              stamp.utc,
              stamp.local,
            ],
          );
        }

        const outbox = enqueueOutbox(
          tx,
          {
            kind: 'purge_tombstone',
            dedupeKey: `tombstone:${tombstoneId}:purge`,
            aggregateKind: 'deletion_tombstone',
            aggregateId: tombstoneId,
            payload: { tombstone_id: tombstoneId, deletion_epoch: epoch },
          },
          clock,
        );

        insertAudit(
          tx,
          newId('aud'),
          {
            action: 'deletion.requested',
            actor: input.actor ?? 'owner',
            target_kind: input.target_kind,
            target_id: input.target_id,
            scope_id: input.scope_id,
            result: 'ok',
            detail: {
              reason: input.reason,
              deletion_epoch: epoch,
              jobs,
              affected,
              // 审计只放账本位置与哈希，不放账本行内容（原因已在上面，正文永不进来）
              ledger_seq: ledgerRecord?.seq ?? null,
              ledger_entry_hash: ledgerRecord?.entryHash ?? null,
            },
            deletion_epoch: epoch,
          },
          clock,
        );

        return {
          status: /** @type {const} */ ('accepted'),
          tombstone_id: tombstoneId,
          deletion_epoch: epoch,
          affected,
          jobs: jobs.length,
          outbox_id: outbox.outbox_id,
          ledger: ledgerRecord,
        };
      },
      { label: 'deletion.request' },
    );
  }

  /**
   * 目标当前是否处于删除态（检索层必须据此过滤）。
   * @param {{ target_kind: string, target_id: string }} target
   * @returns {boolean}
   */
  function isDeleted(target) {
    const row = /** @type {Record<string, unknown> | undefined} */ (
      db
        .prepare("SELECT 1 AS hit FROM deletion_tombstones WHERE target_kind = ? AND target_id = ? AND status <> 'failed'")
        .get(target.target_kind, target.target_id)
    );
    return row !== undefined;
  }

  /**
   * @param {{ status?: string, limit?: number }} [opts]
   * @returns {Record<string, unknown>[]}
   */
  function listTombstones(opts = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    return opts.status
      ? /** @type {Record<string, unknown>[]} */ (
          db.prepare('SELECT * FROM deletion_tombstones WHERE status = ? ORDER BY deletion_epoch ASC LIMIT ?').all(opts.status, limit)
        )
      : /** @type {Record<string, unknown>[]} */ (
          db.prepare('SELECT * FROM deletion_tombstones ORDER BY deletion_epoch ASC LIMIT ?').all(limit)
        );
  }

  /**
   * @param {{ status?: string, limit?: number }} [opts]
   * @returns {Record<string, unknown>[]}
   */
  function listJobs(opts = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
    return opts.status
      ? /** @type {Record<string, unknown>[]} */ (
          db.prepare('SELECT * FROM deletion_jobs WHERE status = ? ORDER BY created_at ASC LIMIT ?').all(opts.status, limit)
        )
      : /** @type {Record<string, unknown>[]} */ (
          db.prepare('SELECT * FROM deletion_jobs ORDER BY created_at ASC LIMIT ?').all(limit)
        );
  }

  /**
   * 清理类 job 的屏障重查：按目标判断，不受其它目标删除影响。
   * @param {Record<string, unknown>} job
   * @returns {{ ok: boolean, reason?: string }}
   */
  function checkTargetBarrier(job) {
    const tomb = /** @type {Record<string, unknown> | undefined} */ (
      db.prepare('SELECT * FROM deletion_tombstones WHERE tombstone_id = ?').get(String(job.tombstone_id))
    );
    if (tomb === undefined) return { ok: false, reason: 'tombstone_missing' };
    if (Number(tomb.deletion_epoch) !== Number(job.deletion_epoch)) return { ok: false, reason: 'epoch_mismatch' };
    const targetId = String(job.target_id);
    const epoch = Number(job.deletion_epoch);

    switch (String(job.target_kind)) {
      case 'memory': {
        const row = /** @type {Record<string, unknown> | undefined} */ (
          db.prepare('SELECT status, deletion_epoch FROM memories WHERE id = ?').get(targetId)
        );
        if (row === undefined) return { ok: true };
        if (String(row.status) !== 'deleted') return { ok: false, reason: 'target_not_deleted' };
        if (Number(row.deletion_epoch) < epoch) return { ok: false, reason: 'target_epoch_stale' };
        return { ok: true };
      }
      case 'event': {
        const row = /** @type {Record<string, unknown> | undefined} */ (
          db.prepare('SELECT deletion_epoch FROM events WHERE event_id = ?').get(targetId)
        );
        if (row === undefined) return { ok: true };
        if (Number(row.deletion_epoch) < epoch) return { ok: false, reason: 'target_epoch_stale' };
        return { ok: true };
      }
      case 'session': {
        const row = /** @type {Record<string, unknown> | undefined} */ (
          db.prepare('SELECT deletion_epoch FROM sessions WHERE session_id = ?').get(targetId)
        );
        if (row === undefined) return { ok: true };
        if (Number(row.deletion_epoch) < epoch) return { ok: false, reason: 'target_epoch_stale' };
        return { ok: true };
      }
      case 'summary': {
        const row = /** @type {Record<string, unknown> | undefined} */ (
          db.prepare('SELECT status, deletion_epoch FROM summaries WHERE summary_id = ?').get(targetId)
        );
        if (row === undefined) return { ok: true };
        if (String(row.status) !== 'deleted') return { ok: false, reason: 'target_not_deleted' };
        if (Number(row.deletion_epoch) < epoch) return { ok: false, reason: 'target_epoch_stale' };
        return { ok: true };
      }
      default:
        return { ok: true };
    }
  }

  /**
   * 认领并执行清理任务。
   * @param {{ limit?: number, actor?: string }} [opts]
   * @returns {Promise<{ claimed: number, results: Array<Record<string, unknown>> }>}
   */
  async function runPurgeWorker(opts = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
    const actor = opts.actor ?? 'purge-worker';
    const claimed = await queue.write(
      (tx) => {
        const rows = tx.all(
          `SELECT * FROM deletion_jobs
            WHERE status IN ('pending', 'failed')
            ORDER BY created_at ASC LIMIT ?`,
          [limit],
        );
        if (rows.length === 0) return [];
        const stamp = clock.stamp();
        const ids = rows.map((row) => String(row.job_id));
        const placeholders = ids.map(() => '?').join(',');
        tx.run(
          `UPDATE deletion_jobs
              SET status = 'running', attempts = attempts + 1, started_at = ?, started_at_local = ?
            WHERE job_id IN (${placeholders})`,
          [stamp.utc, stamp.local, ...ids],
        );
        return rows.map((row) => ({ ...row, attempts: Number(row.attempts ?? 0) + 1 }));
      },
      { label: 'deletion.claimJobs' },
    );

    /** @type {Array<Record<string, unknown>>} */
    const results = [];
    for (const job of claimed) {
      results.push(await executeJob(job, actor));
    }
    return { claimed: claimed.length, results };
  }

  /**
   * @param {Record<string, unknown>} job
   * @param {string} actor
   * @returns {Promise<Record<string, unknown>>}
   */
  async function executeJob(job, actor) {
    const jobId = String(job.job_id);
    const epoch = Number(job.deletion_epoch);
    try {
      const barrier = checkTargetBarrier(job);
      if (!barrier.ok) {
        throw new DeletionBarrierError('删除屏障重查未通过，拒绝清理', {
          worker_epoch: epoch,
          current_epoch: getDeletionEpoch(),
          target_kind: String(job.target_kind),
          target_id: String(job.target_id),
        });
      }
      const changed = await queue.write((tx) => purgeTarget(tx, job), { label: 'deletion.purge' });
      await queue.write(
        (tx) => {
          const stamp = clock.stamp();
          tx.run(
            `UPDATE deletion_jobs
                SET status = 'done', last_error = NULL, finished_at = ?, finished_at_local = ?
              WHERE job_id = ?`,
            [stamp.utc, stamp.local, jobId],
          );
          const remaining = tx.get(
            "SELECT COUNT(*) AS n FROM deletion_jobs WHERE tombstone_id = ? AND status <> 'done'",
            [String(job.tombstone_id)],
          );
          if (Number(remaining?.n ?? 0) === 0) {
            tx.run("UPDATE deletion_tombstones SET status = 'verified' WHERE tombstone_id = ?", [
              String(job.tombstone_id),
            ]);
          } else {
            tx.run("UPDATE deletion_tombstones SET status = 'purged' WHERE tombstone_id = ? AND status = 'pending'", [
              String(job.tombstone_id),
            ]);
          }
          insertAudit(
            tx,
            newId('aud'),
            {
              action: 'deletion.purged',
              actor,
              target_kind: String(job.target_kind),
              target_id: String(job.target_id),
              scope_id: String(job.scope_id),
              result: 'ok',
              detail: { job_id: jobId, kind: String(job.kind), rows_touched: changed, deletion_epoch: epoch },
              deletion_epoch: epoch,
            },
            clock,
          );
        },
        { label: 'deletion.completeJob' },
      );
      return { job_id: jobId, status: 'done', rows_touched: changed };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const attempts = Number(job.attempts ?? 1);
      const maxAttempts = Number(job.max_attempts ?? 5);
      const alive = attempts < maxAttempts;
      await queue.write(
        (tx) => {
          const stamp = clock.stamp();
          tx.run(
            `UPDATE deletion_jobs
                SET status = ?, last_error = ?, finished_at = ?, finished_at_local = ?
              WHERE job_id = ?`,
            [alive ? 'failed' : 'dead', message.slice(0, 2000), stamp.utc, stamp.local, jobId],
          );
          if (!alive) {
            tx.run("UPDATE deletion_tombstones SET status = 'failed' WHERE tombstone_id = ?", [String(job.tombstone_id)]);
            insertAudit(
              tx,
              newId('aud'),
              {
                action: 'deletion.dead_letter',
                actor,
                target_kind: String(job.target_kind),
                target_id: String(job.target_id),
                scope_id: String(job.scope_id),
                result: 'error',
                detail: { job_id: jobId, attempts, max_attempts: maxAttempts },
                deletion_epoch: epoch,
              },
              clock,
            );
          }
        },
        { label: 'deletion.failJob' },
      );
      if (!alive) {
        alert({
          kind: 'deletion_dead',
          message: `删除清理任务失败达上限：${String(job.target_kind)}/${String(job.target_id)}`,
          detail: { job_id: jobId, attempts, last_error: message.slice(0, 200) },
        });
      }
      return { job_id: jobId, status: alive ? 'failed' : 'dead', error: message };
    }
  }

  /**
   * 真正清正文（必须在 `checkTargetBarrier` 通过后调用）。
   * @param {TxApi} tx
   * @param {Record<string, unknown>} job
   * @returns {number}
   */
  function purgeTarget(tx, job) {
    const targetId = String(job.target_id);
    const stamp = clock.stamp();
    let changed = 0;
    switch (String(job.target_kind)) {
      case 'memory': {
        changed += Number(
          tx.run(
            `UPDATE memories
                SET content = NULL, summary = NULL, content_hash = NULL, status = 'deleted',
                    updated_at = ?, updated_at_local = ?
              WHERE id = ?`,
            [stamp.utc, stamp.local, targetId],
          ).changes,
        );
        changed += Number(
          tx.run(
            'UPDATE memory_versions SET content = NULL, summary = NULL WHERE memory_id = ?',
            [targetId],
          ).changes,
        );
        changed += Number(tx.run('DELETE FROM source_refs WHERE memory_id = ?', [targetId]).changes);
        changed += Number(
          tx.run(
            `UPDATE summaries
                SET content = NULL, status = 'deleted', updated_at = ?, updated_at_local = ?
              WHERE summary_id IN (
                SELECT summary_id FROM summary_sources WHERE source_kind = 'memory' AND source_id = ?
              )`,
            [stamp.utc, stamp.local, targetId],
          ).changes,
        );
        return changed;
      }
      case 'event': {
        changed += Number(
          tx.run(
            'UPDATE events SET payload_text = NULL WHERE event_id = ?',
            [targetId],
          ).changes,
        );
        return changed;
      }
      case 'session': {
        changed += Number(
          tx.run('UPDATE events SET payload_text = NULL WHERE session_id = ?', [targetId]).changes,
        );
        return changed;
      }
      case 'summary': {
        changed += Number(
          tx.run(
            `UPDATE summaries
                SET content = NULL, status = 'deleted', updated_at = ?, updated_at_local = ?
              WHERE summary_id = ?`,
            [stamp.utc, stamp.local, targetId],
          ).changes,
        );
        return changed;
      }
      case 'source_ref': {
        changed += Number(tx.run('DELETE FROM source_refs WHERE ref_id = ?', [targetId]).changes);
        return changed;
      }
      case 'context_package': {
        changed += Number(
          tx.run("UPDATE context_packages SET status = 'discarded' WHERE context_id = ?", [targetId]).changes,
        );
        return changed;
      }
      case 'task_snapshot': {
        changed += Number(
          tx.run("UPDATE task_snapshots SET pending_effects = '[]' WHERE snapshot_id = ?", [targetId]).changes,
        );
        return changed;
      }
      case 'scope': {
        changed += Number(
          tx.run('UPDATE events SET payload_text = NULL WHERE scope_id = ?', [String(job.scope_id)]).changes,
        );
        return changed;
      }
      default:
        throw new BrainError('INVALID_ARGUMENT', `未知目标类型：${String(job.target_kind)}`);
    }
  }

  return {
    getDeletionEpoch,
    assertEpochFresh,
    requestDeletion,
    isDeleted,
    listTombstones,
    listJobs,
    checkTargetBarrier,
    runPurgeWorker,
  };
}

/**
 * 恢复用：把独立账本里的删除条目**重放**到刚恢复的库里（M3-INTERFACES §5.1 第 4 步）。
 *
 * 为什么不能复用 `requestDeletion`：
 * - 后者会 `bumpDeletionEpoch` 并**再往账本写一条**——账本是权威源，恢复过程不该回写它；
 * - 恢复库的 epoch 起点是备份时刻的值，直接 bump 出来的新 epoch 可能低于账本水位，
 *   账本的单调约束会拒绝写入，重放反而失败。
 *
 * 所以这里做的是**幂等合并**：目标已有墓碑就跳过；没有就补墓碑 + 立即屏蔽 + 排 M3 清理 job，
 * 并把恢复库的 `deletion_epoch` 抬到 `max(当前, 条目 epoch)`（只抬不降，不写账本）。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: TxApi) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 * }} options
 * @param {Array<{ tombstoneId?: string, targetKind?: string, targetId?: string, memoryId?: string|null, epoch: number, requestedAt?: string, scopeId: string, reason?: string, actor?: string }>} entries
 * @returns {Promise<{ applied: number, skipped: number, results: Array<{ targetId: string, applied: boolean, reason: string, epoch?: number }> }>}
 */
export async function replayLedgerDeletions(options, entries) {
  const { db, queue, clock } = options;
  if (!Array.isArray(entries)) {
    throw new BrainError('INVALID_ARGUMENT', 'replayLedgerDeletions 需要账本条目数组');
  }
  /** @type {Array<{ targetId: string, applied: boolean, reason: string, epoch?: number }>} */
  const results = [];
  let applied = 0;
  let skipped = 0;

  for (const entry of entries) {
    const targetKind = typeof entry.targetKind === 'string' && entry.targetKind.length > 0 ? entry.targetKind : 'memory';
    if (!TARGET_KINDS.includes(targetKind)) {
      results.push({ targetId: String(entry.targetId ?? ''), applied: false, reason: 'unsupported_target_kind' });
      skipped += 1;
      continue;
    }
    const targetId = String(entry.targetId ?? entry.memoryId ?? '');
    if (targetId.length === 0) {
      results.push({ targetId: '', applied: false, reason: 'missing_target_id' });
      skipped += 1;
      continue;
    }
    const outcome = await queue.write(
      (tx) => {
        const existing = tx.get('SELECT tombstone_id FROM deletion_tombstones WHERE target_kind = ? AND target_id = ?', [
          targetKind,
          targetId,
        ]);
        if (existing !== undefined) return { applied: false, reason: 'already_tombstoned', epoch: Number(entry.epoch) };
        if (!Number.isInteger(Number(entry.epoch)) || Number(entry.epoch) < 1) {
          return { applied: false, reason: 'invalid_epoch', epoch: undefined };
        }
        const stamp = clock.stamp();
        // 只抬不降：恢复库的删除纪元必须 >= 账本说过发生过的 epoch。
        const current = readDeletionEpoch(tx);
        const epoch = Math.max(current, Number(entry.epoch));
        if (epoch !== current) writeMeta(tx, META_KEYS.deletionEpoch, String(epoch), clock);

        const replayTombstoneId =
          typeof entry.tombstoneId === 'string' && entry.tombstoneId.length > 0 ? entry.tombstoneId : newId('tmb');
        tx.run(
          `INSERT INTO deletion_tombstones (
             tombstone_id, target_kind, target_id, scope_id, reason, requested_by,
             deletion_epoch, status, ledger_synced_at, ledger_synced_at_local,
             requested_at, requested_at_local, created_at, created_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
          [
            replayTombstoneId,
            targetKind,
            targetId,
            String(entry.scopeId ?? 'owner-default'),
            String(entry.reason ?? 'replayed_from_ledger'),
            String(entry.actor ?? 'restore'),
            epoch,
            stamp.utc,
            stamp.local,
            String(entry.requestedAt ?? stamp.utc),
            stamp.utc,
            stamp.utc,
            stamp.local,
          ],
        );
        const affected = shieldTarget(tx, {
          target_kind: targetKind,
          target_id: targetId,
          scope_id: String(entry.scopeId ?? 'owner-default'),
          epoch,
          stamp,
        });
        tx.run(
          `UPDATE context_packages SET status = 'discarded'
            WHERE scope_id = ? AND deletion_epoch < ? AND status IN ('built', 'attached')`,
          [String(entry.scopeId ?? 'owner-default'), epoch],
        );
        for (const kind of M3_PURGE_JOBS) {
          tx.run(
            `INSERT INTO deletion_jobs (
               job_id, tombstone_id, target_kind, target_id, scope_id, kind,
               status, attempts, max_attempts, deletion_epoch, created_at, created_at_local
             ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 5, ?, ?, ?)`,
            [
              newId('job'),
              String(replayTombstoneId),
              targetKind,
              targetId,
              String(entry.scopeId ?? 'owner-default'),
              kind,
              epoch,
              stamp.utc,
              stamp.local,
            ],
          );
        }
        insertAudit(
          tx,
          newId('aud'),
          {
            action: 'deletion.replayed_from_ledger',
            actor: 'restore',
            target_kind: targetKind,
            target_id: targetId,
            scope_id: String(entry.scopeId ?? 'owner-default'),
            result: 'ok',
            detail: { ledger_epoch: Number(entry.epoch), effective_epoch: epoch, affected },
            deletion_epoch: epoch,
          },
          clock,
        );
        return { applied: true, reason: 'replayed', epoch };
      },
      { label: 'deletion.replayFromLedger' },
    );
    results.push({ targetId, ...outcome });
    if (outcome.applied) applied += 1;
    else skipped += 1;
  }
  return { applied, skipped, results };
}

/**
 * 即时屏蔽：把目标与直接派生物标记为不可检索。不在这里清正文（那是 worker 的活）。
 * @param {TxApi} tx
 * @param {{ target_kind: string, target_id: string, scope_id: string, epoch: number, stamp: { utc: string, local: string } }} input
 * @returns {Array<{ table: string, changes: number }>}
 */
export function shieldTarget(tx, input) {
  const { target_kind, target_id, scope_id, epoch, stamp } = input;
  /** @type {Array<{ table: string, changes: number }>} */
  const affected = [];
  switch (target_kind) {
    case 'memory': {
      affected.push({
        table: 'memories',
        changes: Number(
          tx.run(
            `UPDATE memories
                SET status = 'deleted', deletion_epoch = ?, updated_at = ?, updated_at_local = ?
              WHERE id = ? AND scope_id = ?`,
            [epoch, stamp.utc, stamp.local, target_id, scope_id],
          ).changes,
        ),
      });
      affected.push({
        table: 'summaries',
        changes: Number(
          tx.run(
            `UPDATE summaries
                SET status = 'suppressed', deletion_epoch = ?, updated_at = ?, updated_at_local = ?
              WHERE summary_id IN (
                SELECT summary_id FROM summary_sources WHERE source_kind = 'memory' AND source_id = ?
              )`,
            [epoch, stamp.utc, stamp.local, target_id],
          ).changes,
        ),
      });
      break;
    }
    case 'event': {
      affected.push({
        table: 'events',
        changes: Number(
          tx.run(
            'UPDATE events SET deletion_epoch = ?, payload_text = NULL WHERE event_id = ? AND scope_id = ?',
            [epoch, target_id, scope_id],
          ).changes,
        ),
      });
      break;
    }
    case 'session': {
      affected.push({
        table: 'events',
        changes: Number(
          tx.run(
            'UPDATE events SET deletion_epoch = ?, payload_text = NULL WHERE session_id = ? AND scope_id = ?',
            [epoch, target_id, scope_id],
          ).changes,
        ),
      });
      affected.push({
        table: 'sessions',
        changes: Number(
          tx.run('UPDATE sessions SET deletion_epoch = ? WHERE session_id = ? AND scope_id = ?', [
            epoch,
            target_id,
            scope_id,
          ]).changes,
        ),
      });
      break;
    }
    case 'summary': {
      affected.push({
        table: 'summaries',
        changes: Number(
          tx.run(
            `UPDATE summaries SET status = 'deleted', deletion_epoch = ?, updated_at = ?, updated_at_local = ?
              WHERE summary_id = ? AND scope_id = ?`,
            [epoch, stamp.utc, stamp.local, target_id, scope_id],
          ).changes,
        ),
      });
      break;
    }
    case 'source_ref': {
      affected.push({
        table: 'source_refs',
        changes: Number(tx.run('DELETE FROM source_refs WHERE ref_id = ?', [target_id]).changes),
      });
      break;
    }
    case 'context_package': {
      affected.push({
        table: 'context_packages',
        changes: Number(
          tx.run("UPDATE context_packages SET status = 'discarded' WHERE context_id = ?", [target_id]).changes,
        ),
      });
      break;
    }
    case 'task_snapshot': {
      affected.push({
        table: 'task_snapshots',
        changes: Number(
          tx.run(
            `UPDATE task_snapshots SET deletion_epoch = ?, updated_at = ?, updated_at_local = ?
              WHERE snapshot_id = ? AND scope_id = ?`,
            [epoch, stamp.utc, stamp.local, target_id, scope_id],
          ).changes,
        ),
      });
      break;
    }
    case 'scope': {
      affected.push({
        table: 'memories',
        changes: Number(
          tx.run(
            `UPDATE memories SET status = 'deleted', deletion_epoch = ?, updated_at = ?, updated_at_local = ?
              WHERE scope_id = ?`,
            [epoch, stamp.utc, stamp.local, scope_id],
          ).changes,
        ),
      });
      affected.push({
        table: 'events',
        changes: Number(
          tx.run('UPDATE events SET deletion_epoch = ?, payload_text = NULL WHERE scope_id = ?', [
            epoch,
            scope_id,
          ]).changes,
        ),
      });
      affected.push({
        table: 'sessions',
        changes: Number(
          tx.run('UPDATE sessions SET deletion_epoch = ? WHERE scope_id = ?', [epoch, scope_id]).changes,
        ),
      });
      break;
    }
    default:
      throw new BrainError('INVALID_ARGUMENT', `未知目标类型：${String(target_kind)}`);
  }
  return affected;
}
