// @ts-check
/**
 * Outbox：与「原始事件 + 状态推进」**同一事务**写入的工作项。
 *
 * 核心语义（CONTRACTS 第 3 节）：
 * - 主账提交成功之后才允许异步派发；派发失败不回滚已确认主账。
 * - 失败保持未完成（`failed`/`dead`）并告警，绝不静默丢弃。
 * - `dedupe_key` 唯一：同一事件的同一类工作项只会有一条；重放补写是幂等的。
 */

import { randomBytes } from 'node:crypto';
import { BrainError } from '@dsh-brain/core';
import { createTxApi } from './write-queue.js';

/** @typedef {ReturnType<typeof createTxApi>} TxApi */

export const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_RETRY_BASE_MS = 5000;

/**
 * @typedef {Object} OutboxItemInput
 * @property {string} kind 工作项类型（如 `project_event` / `export_jsonl` / `purge_tombstone`）
 * @property {string} dedupeKey 幂等键（同一工作项重复入队只留一条）
 * @property {string} [aggregateKind]
 * @property {string} [aggregateId]
 * @property {string | null} [eventId]
 * @property {unknown} [payload] 会被 JSON 序列化；不得包含凭据
 * @property {number} [maxAttempts]
 */

/**
 * @param {TxApi} tx
 * @param {string} dedupeKey
 * @returns {Record<string, unknown> | undefined}
 */
function findByDedupeKey(tx, dedupeKey) {
  return tx.get('SELECT * FROM outbox WHERE dedupe_key = ?', [dedupeKey]);
}

/**
 * 在给定事务里入队一条工作项（幂等）。
 * 必须在调用方的事务内使用 —— 这是「事件 + 状态 + outbox 同事务」的落点。
 *
 * @param {TxApi} tx
 * @param {OutboxItemInput} item
 * @param {{ stamp: () => { utc: string, local: string } }} clock
 * @returns {{ outbox_id: string, deduped: boolean }}
 */
export function enqueueOutbox(tx, item, clock) {
  if (typeof item.kind !== 'string' || item.kind.length === 0) {
    throw new BrainError('INVALID_ARGUMENT', 'outbox 工作项缺少 kind');
  }
  if (typeof item.dedupeKey !== 'string' || item.dedupeKey.length === 0) {
    throw new BrainError('INVALID_ARGUMENT', 'outbox 工作项缺少 dedupeKey');
  }
  const existing = findByDedupeKey(tx, item.dedupeKey);
  if (existing !== undefined) {
    return { outbox_id: String(existing.outbox_id), deduped: true };
  }
  const stamp = clock.stamp();
  const outboxId = `obx_${randomBytes(12).toString('hex')}`;
  const payload = item.payload === undefined ? null : JSON.stringify(item.payload);
  tx.run(
    `INSERT INTO outbox (
       outbox_id, kind, dedupe_key, aggregate_kind, aggregate_id, event_id,
       payload, status, attempts, max_attempts, created_at, created_at_local,
       updated_at, updated_at_local
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?, ?)`,
    [
      outboxId,
      item.kind,
      item.dedupeKey,
      item.aggregateKind ?? null,
      item.aggregateId ?? null,
      item.eventId ?? null,
      payload,
      item.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      stamp.utc,
      stamp.local,
      stamp.utc,
      stamp.local,
    ],
  );
  return { outbox_id: outboxId, deduped: false };
}

/**
 * @typedef {Object} OutboxRow
 * @property {string} outbox_id
 * @property {string} kind
 * @property {string} dedupe_key
 * @property {string} status
 * @property {number} attempts
 * @property {number} max_attempts
 * @property {string | null} event_id
 * @property {string | null} payload
 * @property {string | null} last_error
 */

/**
 * @param {Record<string, unknown>} row
 * @returns {OutboxRow}
 */
function toOutboxRow(row) {
  return {
    outbox_id: String(row.outbox_id),
    kind: String(row.kind),
    dedupe_key: String(row.dedupe_key),
    status: String(row.status),
    attempts: Number(row.attempts ?? 0),
    max_attempts: Number(row.max_attempts ?? DEFAULT_MAX_ATTEMPTS),
    event_id: row.event_id === null || row.event_id === undefined ? null : String(row.event_id),
    payload: row.payload === null || row.payload === undefined ? null : String(row.payload),
    last_error: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
  };
}

/**
 * @typedef {Object} OutboxAlert
 * @property {'outbox_failed' | 'outbox_dead'} kind
 * @property {string} outbox_id
 * @property {string} work_kind
 * @property {number} attempts
 * @property {number} max_attempts
 * @property {string} message
 */

/**
 * 造 outbox 服务。
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: TxApi) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   alert?: (info: OutboxAlert) => void,
 * }} options
 */
export function createOutbox(options) {
  const { db, queue, clock } = options;
  const alert = options.alert ?? (() => {});

  /**
   * 认领工作项：标记为 `in_progress` 并计一次尝试。
   * 崩溃后由 `recoverStale` 退回 pending。
   * @param {{ limit?: number, now?: Date, visibilityMs?: number }} [opts]
   * @returns {Promise<OutboxRow[]>}
   */
  async function claim(opts = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 10, 100));
    const nowStamp = opts.now ?? clock.stamp();
    const nowIso = nowStamp instanceof Date ? nowStamp.toISOString() : nowStamp.utc;
    return queue.write(
      (tx) => {
        const rows = tx.all(
          `SELECT * FROM outbox
            WHERE status IN ('pending', 'failed')
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY created_at ASC
            LIMIT ?`,
          [nowIso, limit],
        );
        if (rows.length === 0) return [];
        const stamp = clock.stamp();
        const ids = rows.map((row) => String(row.outbox_id));
        const placeholders = ids.map(() => '?').join(',');
        tx.run(
          `UPDATE outbox
              SET status = 'in_progress',
                  attempts = attempts + 1,
                  last_attempt_at = ?,
                  last_attempt_at_local = ?,
                  updated_at = ?,
                  updated_at_local = ?
            WHERE outbox_id IN (${placeholders})`,
          [nowIso, stamp.local, nowIso, stamp.local, ...ids],
        );
        return rows.map((row) => {
          const patched = { ...row, status: 'in_progress', attempts: Number(row.attempts ?? 0) + 1 };
          return toOutboxRow(patched);
        });
      },
      { label: 'outbox.claim' },
    );
  }

  /**
   * 完成工作项。幂等：已 done 直接返回。
   * @param {string} outboxId
   * @param {{ detail?: Record<string, unknown> }} [opts]
   * @returns {Promise<{ outbox_id: string, status: 'done' | 'already_done' }>}
   */
  async function complete(outboxId, opts = {}) {
    return queue.write(
      (tx) => {
        const row = tx.get('SELECT status FROM outbox WHERE outbox_id = ?', [outboxId]);
        if (row === undefined) {
          throw new BrainError('NOT_FOUND', `outbox 工作项不存在：${outboxId}`);
        }
        if (String(row.status) === 'done') {
          return { outbox_id: outboxId, status: /** @type {const} */ ('already_done') };
        }
        const stamp = clock.stamp();
        tx.run(
          `UPDATE outbox
              SET status = 'done',
                  completed_at = ?,
                  completed_at_local = ?,
                  updated_at = ?,
                  updated_at_local = ?,
                  last_error = NULL
            WHERE outbox_id = ?`,
          [stamp.utc, stamp.local, stamp.utc, stamp.local, outboxId],
        );
        return { outbox_id: outboxId, status: /** @type {const} */ ('done') };
      },
      { label: 'outbox.complete' },
    );
  }

  /**
   * 标记失败：未到上限则回到 pending 并退避；到上限则 dead 并告警。
   * @param {string} outboxId
   * @param {unknown} error
   * @param {{ retryDelayMs?: number }} [opts]
   * @returns {Promise<{ outbox_id: string, status: 'pending' | 'dead', attempts: number, max_attempts: number }>}
   */
  async function fail(outboxId, error, opts = {}) {
    const message = error instanceof Error ? error.message : String(error);
    /** @type {OutboxAlert | null} */
    let pendingAlert = null;
    const result = await queue.write(
      (tx) => {
        const row = tx.get('SELECT * FROM outbox WHERE outbox_id = ?', [outboxId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `outbox 工作项不存在：${outboxId}`);
        const attempts = Number(row.attempts ?? 0);
        const maxAttempts = Number(row.max_attempts ?? DEFAULT_MAX_ATTEMPTS);
        const stamp = clock.stamp();
        const truncated = message.slice(0, 2000);
        if (attempts >= maxAttempts) {
          tx.run(
            `UPDATE outbox SET status = 'dead', last_error = ?, updated_at = ?, updated_at_local = ?
              WHERE outbox_id = ?`,
            [truncated, stamp.utc, stamp.local, outboxId],
          );
          pendingAlert = {
            kind: 'outbox_dead',
            outbox_id: outboxId,
            work_kind: String(row.kind),
            attempts,
            max_attempts: maxAttempts,
            message: truncated,
          };
          return { outbox_id: outboxId, status: /** @type {const} */ ('dead'), attempts, max_attempts: maxAttempts };
        }
        const base = opts.retryDelayMs ?? DEFAULT_RETRY_BASE_MS;
        const delay = Math.min(base * 2 ** Math.max(0, attempts - 1), 5 * 60 * 1000);
        const nextAt = new Date(Date.parse(stamp.utc) + delay).toISOString();
        tx.run(
          `UPDATE outbox
              SET status = 'pending',
                  last_error = ?,
                  next_attempt_at = ?,
                  updated_at = ?,
                  updated_at_local = ?
            WHERE outbox_id = ?`,
          [truncated, nextAt, stamp.utc, stamp.local, outboxId],
        );
        pendingAlert = {
          kind: 'outbox_failed',
          outbox_id: outboxId,
          work_kind: String(row.kind),
          attempts,
          max_attempts: maxAttempts,
          message: truncated,
        };
        return { outbox_id: outboxId, status: /** @type {const} */ ('pending'), attempts, max_attempts: maxAttempts };
      },
      { label: 'outbox.fail' },
    );
    if (pendingAlert) {
      try {
        alert(pendingAlert);
      } catch {
        /* 告警失败不影响主账状态 */
      }
    }
    return result;
  }

  /**
   * 崩溃恢复：把超时仍 `in_progress` 的工作项退回 pending。
   * @param {{ olderThanMs?: number, now?: Date }} [opts]
   * @returns {Promise<number>} 退回的条数
   */
  async function recoverStale(opts = {}) {
    const olderThanMs = opts.olderThanMs ?? 60_000;
    const now = opts.now ?? clock.stamp();
    const nowIso = now instanceof Date ? now.toISOString() : now.utc;
    const threshold = new Date(Date.parse(nowIso) - olderThanMs).toISOString();
    return queue.write(
      (tx) => {
        const stamp = clock.stamp();
        const result = tx.run(
          `UPDATE outbox
              SET status = 'pending',
                  last_error = 'stale in_progress recovered',
                  updated_at = ?,
                  updated_at_local = ?
            WHERE status = 'in_progress'
              AND (last_attempt_at IS NULL OR last_attempt_at < ?)`,
          [stamp.utc, stamp.local, threshold],
        );
        return Number(result.changes);
      },
      { label: 'outbox.recoverStale' },
    );
  }

  /**
   * 人工/策略重试死信。
   * @param {string} outboxId
   * @returns {Promise<{ outbox_id: string, status: 'pending' }>}
   */
  async function retryDead(outboxId) {
    return queue.write(
      (tx) => {
        const row = tx.get('SELECT status FROM outbox WHERE outbox_id = ?', [outboxId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `outbox 工作项不存在：${outboxId}`);
        if (String(row.status) !== 'dead') {
          throw new BrainError('INVALID_ARGUMENT', `只有 dead 状态可以人工重试（当前 ${String(row.status)}）`);
        }
        const stamp = clock.stamp();
        tx.run(
          `UPDATE outbox
              SET status = 'pending', attempts = 0, last_error = NULL,
                  next_attempt_at = NULL, updated_at = ?, updated_at_local = ?
            WHERE outbox_id = ?`,
          [stamp.utc, stamp.local, outboxId],
        );
        return { outbox_id: outboxId, status: /** @type {const} */ ('pending') };
      },
      { label: 'outbox.retryDead' },
    );
  }

  /** @returns {Array<{status: string, count: number}>} */
  function stats() {
    return /** @type {Array<{status: string, count: number}>} */ (
      db
        .prepare('SELECT status, COUNT(*) AS count FROM outbox GROUP BY status ORDER BY status')
        .all()
        .map((row) => ({ status: String(row.status), count: Number(row.count) }))
    );
  }

  /**
   * @param {{ status?: string, limit?: number }} [opts]
   * @returns {OutboxRow[]}
   */
  function list(opts = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const rows = opts.status
      ? db.prepare('SELECT * FROM outbox WHERE status = ? ORDER BY created_at ASC LIMIT ?').all(opts.status, limit)
      : db.prepare('SELECT * FROM outbox ORDER BY created_at ASC LIMIT ?').all(limit);
    return /** @type {Record<string, unknown>[]} */ (rows).map(toOutboxRow);
  }

  return { claim, complete, fail, recoverStale, retryDead, stats, list };
}
