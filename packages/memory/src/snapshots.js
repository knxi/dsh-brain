// @ts-check
/**
 * `snapshots` 门面 —— 任务快照的最小版（M2-INTERFACES §1.4）。
 *
 * 存在理由（CONTRACTS §21.3 的 CAS 纪律）：长任务写到一半，用户可能已经纠错。
 * 慢任务写回时必须证明「我基于的版本还是最新版」，否则就是拿过期认知覆盖新事实。
 * 所以 `save()` 的 version 是**期望的下一版**：
 *   - 不传 → 用 `maxVersion + 1`（正常推进）
 *   - 传了 → 必须正好等于 `maxVersion + 1`，否则抛 `CasConflictError`
 *     （这就是「冲突重读，不让慢任务覆盖较新的用户纠错」的落地）
 */

import { BrainError, formatLocalIso } from '@dsh-brain/core';
import { createTxApi } from './write-queue.js';
import { CasConflictError, clampInt, newId, normalizeInstant, parseJsonArray, requireString, stringifyJsonArray } from './memory-util.js';

/** 0001 的 task_snapshots.status CHECK 允许值。 */
export const SNAPSHOT_STATUSES = Object.freeze([
  'pending',
  'in_progress',
  'partial',
  'completed',
  'cancelled',
  'failed',
  'outcome_unknown',
]);

/**
 * @typedef {Object} SnapshotInput
 * @property {string} [scopeId]
 * @property {string} [taskId]
 * @property {string} [sessionId]
 * @property {string} [turnId]
 * @property {string} [goal]
 * @property {string[]} [doneSteps]
 * @property {string[]} [pendingSteps]
 * @property {string[]} [artifactHashes]
 * @property {number|string|null} [sourceEventWatermark]
 * @property {string[]} [pendingEffects]
 * @property {number} [version]
 * @property {string} [status]
 * @property {string|null} [leaseOwner]
 * @property {string|null} [leaseExpiresAt]
 */

/**
 * 快照的 `task_id`：同一 (scope, session, turn) 视为同一个任务槽。
 * @param {{ scopeId: string, sessionId?: string|null, turnId?: string|null, taskId?: string|null }} input
 * @returns {string}
 */
export function deriveTaskId(input) {
  if (input.taskId !== undefined && input.taskId !== null && input.taskId !== '') return String(input.taskId);
  return `${input.scopeId}::${input.sessionId ?? '-'}::${input.turnId ?? '-'}`;
}

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string }, timeZone: string },
 *   bindings?: { scope_id?: string },
 * }} options
 */
export function createSnapshots(options) {
  const { db, queue, clock } = options;
  const defaultScopeId = options.bindings?.scope_id ?? null;
  const tx = createTxApi(db);

  /**
   * @param {any} txh
   * @param {string} taskId
   * @returns {Record<string, unknown> | undefined}
   */
  function latestRow(txh, taskId) {
    return /** @type {Record<string, unknown> | undefined} */ (
      txh.get(
        `SELECT * FROM task_snapshots
          WHERE task_id = ? AND deletion_epoch = 0
            AND snapshot_id NOT IN (
              SELECT target_id FROM deletion_tombstones WHERE target_kind = 'task_snapshot' AND status <> 'failed')
          ORDER BY version DESC LIMIT 1`,
        [taskId],
      )
    );
  }

  /**
   * 写入新版本快照。
   * @param {SnapshotInput} input
   * @returns {Promise<{ id: string, version: number }>}
   */
  async function save(input) {
    if (!input || typeof input !== 'object') {
      throw new BrainError('INVALID_ARGUMENT', 'snapshots.save 需要 input 对象');
    }
    const scopeId = requireString(input.scopeId ?? defaultScopeId, 'scopeId');
    const sessionId = input.sessionId === undefined || input.sessionId === null ? null : String(input.sessionId);
    const turnId = input.turnId === undefined || input.turnId === null ? null : String(input.turnId);
    const taskId = deriveTaskId({ scopeId, sessionId, turnId, taskId: input.taskId });
    const watermark =
      input.sourceEventWatermark === undefined || input.sourceEventWatermark === null
        ? null
        : Number(input.sourceEventWatermark);
    if (watermark !== null && (!Number.isFinite(watermark) || watermark < 0)) {
      throw new BrainError('INVALID_ARGUMENT', 'sourceEventWatermark 必须是非负整数');
    }
    const requestedVersion =
      input.version === undefined || input.version === null ? null : clampInt(input.version, 1, Number.MAX_SAFE_INTEGER, 1, 'version');

    return queue.write(
      (txh) => {
        const latest = latestRow(txh, taskId);
        const maxVersion = latest === undefined ? 0 : Number(latest.version);
        const nextVersion = maxVersion + 1;
        if (requestedVersion !== null && requestedVersion !== nextVersion) {
          throw new CasConflictError(
            `任务快照 ${taskId} 版本冲突：期望写第 ${requestedVersion} 版，当前最新是第 ${maxVersion} 版`,
            { taskId, expectedVersion: requestedVersion, actualVersion: maxVersion },
          );
        }
        const stamp = clock.stamp();
        const snapshotId = newId('snap');
        const leaseExpires = normalizeInstant(input.leaseExpiresAt, 'leaseExpiresAt');
        txh.run(
          `INSERT INTO task_snapshots (
             snapshot_id, task_id, scope_id, session_id, turn_id, version,
             source_event_watermark, artifact_hashes, pending_effects, status,
             lease_owner, lease_expires_at, lease_expires_at_local,
             goal, done_steps, pending_steps,
             created_at, created_at_local, updated_at, updated_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            snapshotId,
            taskId,
            scopeId,
            sessionId,
            turnId,
            nextVersion,
            watermark,
            stringifyJsonArray(input.artifactHashes, 'artifactHashes'),
            stringifyJsonArray(input.pendingEffects, 'pendingEffects'),
            input.status ?? 'pending',
            input.leaseOwner ?? null,
            leaseExpires,
            leaseExpires === null ? null : formatLocalIso(new Date(leaseExpires), clock.timeZone),
            input.goal === undefined || input.goal === null ? null : String(input.goal),
            stringifyJsonArray(input.doneSteps, 'doneSteps'),
            stringifyJsonArray(input.pendingSteps, 'pendingSteps'),
            stamp.utc,
            stamp.local,
            stamp.utc,
            stamp.local,
          ],
        );
        return { id: snapshotId, version: nextVersion };
      },
      { label: 'snapshots.save' },
    );
  }

  /**
   * 读最新版快照。
   * @param {{ scopeId?: string, sessionId?: string, turnId?: string, taskId?: string }} [query]
   * @returns {Record<string, unknown> | null}
   */
  function load(query = {}) {
    const scopeId = requireString(query.scopeId ?? defaultScopeId, 'scopeId');
    const taskId = deriveTaskId({
      scopeId,
      sessionId: query.sessionId ?? null,
      turnId: query.turnId ?? null,
      taskId: query.taskId ?? null,
    });
    const row = latestRow(tx, taskId);
    if (row === undefined) return null;
    if (String(row.scope_id) !== scopeId) return null;
    return {
      id: String(row.snapshot_id),
      taskId: String(row.task_id),
      scopeId: String(row.scope_id),
      sessionId: row.session_id == null ? null : String(row.session_id),
      turnId: row.turn_id == null ? null : String(row.turn_id),
      version: Number(row.version),
      goal: row.goal == null ? null : String(row.goal),
      doneSteps: parseJsonArray(row.done_steps, 'done_steps'),
      pendingSteps: parseJsonArray(row.pending_steps, 'pending_steps'),
      artifactHashes: parseJsonArray(row.artifact_hashes, 'artifact_hashes'),
      pendingEffects: parseJsonArray(row.pending_effects, 'pending_effects'),
      sourceEventWatermark: row.source_event_watermark == null ? null : Number(row.source_event_watermark),
      status: String(row.status),
      leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  return { save, load, deriveTaskId };
}
