// @ts-check
/**
 * 消费者：at-least-once + 幂等 + 每会话 source_seq 水位。
 *
 * 语义（CONTRACTS 第 3 节 / 设计 21.2）：
 * - `consumer_offsets.last_source_seq` 是「**连续**处理到的水位」，不是「见过的最大 seq」。
 * - 乱序到达：事件先原样保留（events 全量落盘），消费侧遇到缺口就停，不越过缺口去处理更大的 seq。
 * - 缺口由人/策略显式修复（`repairGap`），修复动作写审计 —— 这就是「用明确水位修复投影」。
 * - handler 成功后才推进 offset；handler 成功但 offset 提交失败 → 事件会被再次交付，
 *   handler 必须幂等（不承诺跨进程 exactly-once）。
 * - handler 失败达上限 → 该 consumer 进入 `dead`，不静默跳过。
 */

import { randomBytes } from 'node:crypto';
import { BrainError } from '@dsh-brain/core';
import { insertAudit, toEventRecord } from './ledger.js';

/** @typedef {import('./ledger.js').EventRecord} EventRecord */

export const DEFAULT_CONSUMER = 'projector';
export const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * @param {string} prefix
 * @returns {string}
 */
function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/**
 * @typedef {Object} ConsumerOffsetRow
 * @property {string} consumer
 * @property {string} scope_id
 * @property {string} session_id
 * @property {number} last_source_seq
 * @property {string} status
 * @property {number} attempts
 * @property {string | null} last_error
 * @property {number} consumed_count
 */

/**
 * @param {Record<string, unknown>} row
 * @returns {ConsumerOffsetRow}
 */
function toOffsetRow(row) {
  return {
    consumer: String(row.consumer),
    scope_id: String(row.scope_id),
    session_id: String(row.session_id),
    last_source_seq: Number(row.last_source_seq ?? 0),
    status: String(row.status ?? 'active'),
    attempts: Number(row.attempts ?? 0),
    last_error: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    consumed_count: Number(row.consumed_count ?? 0),
  };
}

/**
 * 造消费者服务。
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: import('./ledger.js').TxApi) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   maxAttempts?: number,
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 * }} options
 */
export function createConsumers(options) {
  const { db, queue, clock } = options;
  const defaultMaxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const alert = options.alert ?? (() => {});

  /**
   * @param {{ consumer: string, scope_id: string, session_id: string }} key
   * @returns {ConsumerOffsetRow | null}
   */
  function getOffset(key) {
    const row = /** @type {Record<string, unknown> | undefined} */ (
      db
        .prepare('SELECT * FROM consumer_offsets WHERE consumer = ? AND scope_id = ? AND session_id = ?')
        .get(key.consumer, key.scope_id, key.session_id)
    );
    return row === undefined ? null : toOffsetRow(row);
  }

  /**
   * 确保 offset 行存在（初始水位 0，表示「还没处理任何事件」；会话内 source_seq 从 1 开始）。
   * @param {{ consumer: string, scope_id: string, session_id: string }} key
   */
  async function ensureOffset(key) {
    return queue.write(
      (tx) => {
        const stamp = clock.stamp();
        tx.run(
          `INSERT INTO consumer_offsets (
             consumer, scope_id, session_id, last_source_seq, consumed_count, status,
             attempts, updated_at, updated_at_local
           ) VALUES (?, ?, ?, 0, 0, 'active', 0, ?, ?)
           ON CONFLICT(consumer, scope_id, session_id) DO NOTHING`,
          [key.consumer, key.scope_id, key.session_id, stamp.utc, stamp.local],
        );
        return getOffset(key);
      },
      { label: 'consumer.ensureOffset' },
    );
  }

  /**
   * 消费该会话里 `source_seq > offset` 的事件，按 seq 升序。
   *
   * 返回 `status`：
   * - `processed`       处理了 1..limit 条
   * - `drained`         没有更多可处理事件
   * - `blocked_by_gap`  存在缺口（expected_seq 缺失），停在缺口前
   * - `failed`          handler 抛错，未推进水位
   * - `dead`            handler 失败达上限，consumer 已标记 dead
   * @param {{
   *   consumer?: string,
   *   scope_id: string,
   *   session_id: string,
   *   handler: (event: EventRecord) => unknown | Promise<unknown>,
   *   limit?: number,
   *   maxAttempts?: number,
   * }} input
   */
  async function consume(input) {
    const consumer = input.consumer ?? DEFAULT_CONSUMER;
    const { scope_id, session_id, handler } = input;
    if (typeof handler !== 'function') {
      throw new BrainError('INVALID_ARGUMENT', 'consume 需要 handler 函数');
    }
    const key = { consumer, scope_id, session_id };
    const limit = Math.max(1, Math.min(input.limit ?? 50, 500));
    const maxAttempts = input.maxAttempts ?? defaultMaxAttempts;
    await ensureOffset(key);

    /** @type {Array<{ source_seq: number, event_id: string }>} */
    const events = [];
    for (let i = 0; i < limit; i += 1) {
      const offsetRow = getOffset(key);
      if (offsetRow === null) throw new BrainError('NOT_FOUND', 'consumer offset 行丢失');
      if (offsetRow.status === 'dead') {
        return { status: /** @type {const} */ ('dead'), consumer, processed: events.length, events };
      }
      const offset = offsetRow.last_source_seq;

      const candidate = /** @type {Record<string, unknown> | undefined} */ (
        db
          .prepare(
            `SELECT * FROM events
              WHERE scope_id = ? AND session_id = ? AND source_seq > ?
              ORDER BY source_seq ASC LIMIT 1`,
          )
          .get(scope_id, session_id, offset)
      );
      if (candidate === undefined) {
        return {
          status: /** @type {const} */ (events.length > 0 ? 'processed' : 'drained'),
          consumer,
          processed: events.length,
          events,
          last_source_seq: offset,
        };
      }

      const candidateSeq = Number(candidate.source_seq);
      if (candidateSeq > offset + 1) {
        const expected = offset + 1;
        const stamp = clock.stamp();
        await queue.write(
          (tx) => {
            tx.run(
              `UPDATE consumer_offsets
                  SET status = 'blocked_by_gap', last_error = ?, updated_at = ?, updated_at_local = ?
                WHERE consumer = ? AND scope_id = ? AND session_id = ?`,
              [`缺少 source_seq=${expected}`, stamp.utc, stamp.local, consumer, scope_id, session_id],
            );
          },
          { label: 'consumer.blockedByGap' },
        );
        alert({
          kind: 'consumer_gap',
          message: `会话 ${session_id} 缺少 source_seq=${expected}，消费停在缺口前`,
          detail: { consumer, scope_id, session_id, expected_seq: expected, candidate_seq: candidateSeq },
        });
        return {
          status: /** @type {const} */ ('blocked_by_gap'),
          consumer,
          expected_seq: expected,
          candidate_seq: candidateSeq,
          processed: events.length,
          events,
          last_source_seq: offset,
        };
      }

      const event = toEventRecord(candidate);
      try {
        await handler(event);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const attempts = offsetRow.attempts + 1;
        const alive = attempts < maxAttempts;
        const stamp = clock.stamp();
        await queue.write(
          (tx) => {
            tx.run(
              `UPDATE consumer_offsets
                  SET status = ?, attempts = ?, last_error = ?, updated_at = ?, updated_at_local = ?
                WHERE consumer = ? AND scope_id = ? AND session_id = ?`,
              [alive ? 'active' : 'dead', attempts, message.slice(0, 2000), stamp.utc, stamp.local, consumer, scope_id, session_id],
            );
            if (!alive) {
              insertAudit(
                tx,
                newId('aud'),
                {
                  action: 'consumer.dead_letter',
                  actor: consumer,
                  target_kind: 'event',
                  target_id: event.event_id,
                  scope_id,
                  result: 'error',
                  detail: { attempts, max_attempts: maxAttempts, expected_seq: candidateSeq },
                },
                clock,
              );
            }
          },
          { label: 'consumer.fail' },
        );
        if (!alive) {
          alert({
            kind: 'consumer_dead',
            message: `consumer ${consumer} 处理 ${session_id} 失败达上限，已进入 dead`,
            detail: { consumer, scope_id, session_id, attempts, last_error: message.slice(0, 200) },
          });
        }
        return {
          status: /** @type {const} */ (alive ? 'failed' : 'dead'),
          consumer,
          processed: events.length,
          events,
          error: message,
          attempts,
          last_source_seq: offset,
        };
      }

      // 成功：CAS 推进水位。若并发已推进，则本次不重复计数。
      const advanced = await queue.write(
        (tx) => {
          const current = tx.get(
            'SELECT last_source_seq FROM consumer_offsets WHERE consumer = ? AND scope_id = ? AND session_id = ?',
            [consumer, scope_id, session_id],
          );
          if (current === undefined || Number(current.last_source_seq ?? 0) !== offset) return false;
          const stamp = clock.stamp();
          tx.run(
            `UPDATE consumer_offsets
                SET last_source_seq = ?, last_event_id = ?, last_occurred_at = ?,
                    consumed_count = consumed_count + 1, status = 'active',
                    attempts = 0, last_error = NULL, updated_at = ?, updated_at_local = ?
              WHERE consumer = ? AND scope_id = ? AND session_id = ?`,
            [candidateSeq, event.event_id, event.occurred_at, stamp.utc, stamp.local, consumer, scope_id, session_id],
          );
          return true;
        },
        { label: 'consumer.advance' },
      );
      if (!advanced) {
        return {
          status: /** @type {const} */ ('offset_conflict'),
          consumer,
          processed: events.length,
          events,
          last_source_seq: getOffset(key)?.last_source_seq ?? offset,
        };
      }
      events.push({ source_seq: candidateSeq, event_id: event.event_id });
    }

    return {
      status: /** @type {const} */ ('processed'),
      consumer,
      processed: events.length,
      events,
      last_source_seq: getOffset(key)?.last_source_seq ?? 0,
    };
  }

  /**
   * 显式修复缺口：把水位推进到「候选 seq - 1」，承认中间缺失，之后按序继续。
   * 必须给 reason（写进审计），不允许静默跳过。
   * @param {{
   *   consumer?: string,
   *   scope_id: string,
   *   session_id: string,
   *   reason: string,
   *   actor?: string,
   * }} input
   * @returns {Promise<{ status: 'repaired' | 'no_gap', consumer: string, from: number, to: number, skipped: number }>}
   */
  async function repairGap(input) {
    const consumer = input.consumer ?? DEFAULT_CONSUMER;
    if (typeof input.reason !== 'string' || input.reason.trim().length === 0) {
      throw new BrainError('INVALID_ARGUMENT', 'repairGap 必须给出 reason（明确水位修复的理由）');
    }
    await ensureOffset({ consumer, scope_id: input.scope_id, session_id: input.session_id });
    return queue.write(
      (tx) => {
        const offsetRow = tx.get(
          'SELECT * FROM consumer_offsets WHERE consumer = ? AND scope_id = ? AND session_id = ?',
          [consumer, input.scope_id, input.session_id],
        );
        if (offsetRow === undefined) throw new BrainError('NOT_FOUND', 'consumer offset 行丢失');
        const offset = Number(offsetRow.last_source_seq ?? 0);
        const candidate = tx.get(
          `SELECT source_seq FROM events
            WHERE scope_id = ? AND session_id = ? AND source_seq > ?
            ORDER BY source_seq ASC LIMIT 1`,
          [input.scope_id, input.session_id, offset],
        );
        if (candidate === undefined) {
          const stamp = clock.stamp();
          tx.run(
            `UPDATE consumer_offsets SET status = 'active', last_error = NULL, updated_at = ?, updated_at_local = ?
              WHERE consumer = ? AND scope_id = ? AND session_id = ?`,
            [stamp.utc, stamp.local, consumer, input.scope_id, input.session_id],
          );
          return { status: /** @type {const} */ ('no_gap'), consumer, from: offset, to: offset, skipped: 0 };
        }
        const candidateSeq = Number(candidate.source_seq);
        if (candidateSeq <= offset + 1) {
          // 没有缺口：下一条就是连续的，只需要把状态从 blocked_by_gap 恢复。
          const stamp = clock.stamp();
          tx.run(
            `UPDATE consumer_offsets SET status = 'active', last_error = NULL, updated_at = ?, updated_at_local = ?
              WHERE consumer = ? AND scope_id = ? AND session_id = ?`,
            [stamp.utc, stamp.local, consumer, input.scope_id, input.session_id],
          );
          return { status: /** @type {const} */ ('no_gap'), consumer, from: offset, to: offset, skipped: 0 };
        }
        const target = candidateSeq - 1;
        const stamp = clock.stamp();
        tx.run(
          `UPDATE consumer_offsets
              SET last_source_seq = ?, status = 'active', attempts = 0, last_error = NULL,
                  updated_at = ?, updated_at_local = ?
            WHERE consumer = ? AND scope_id = ? AND session_id = ?`,
          [target, stamp.utc, stamp.local, consumer, input.scope_id, input.session_id],
        );
        insertAudit(
          tx,
          newId('aud'),
          {
            action: 'consumer.gap_repaired',
            actor: input.actor ?? 'operator',
            target_kind: 'session',
            target_id: input.session_id,
            scope_id: input.scope_id,
            result: 'ok',
            detail: {
              consumer,
              from_seq: offset,
              to_seq: target,
              skipped: target - offset,
              reason: input.reason,
            },
          },
          clock,
        );
        return {
          status: /** @type {const} */ ('repaired'),
          consumer,
          from: offset,
          to: target,
          skipped: target - offset,
        };
      },
      { label: 'consumer.repairGap' },
    );
  }

  /**
   * 重置 offset（运维/测试用；会丢失「已消费」水位，必须显式调用）。
   * @param {{ consumer?: string, scope_id: string, session_id: string }} key
   */
  async function resetOffset(key) {
    const consumer = key.consumer ?? DEFAULT_CONSUMER;
    return queue.write(
      (tx) => {
        const result = tx.run('DELETE FROM consumer_offsets WHERE consumer = ? AND scope_id = ? AND session_id = ?', [
          consumer,
          key.scope_id,
          key.session_id,
        ]);
        return { deleted: Number(result.changes) };
      },
      { label: 'consumer.resetOffset' },
    );
  }

  /** @returns {ConsumerOffsetRow[]} */
  function listOffsets() {
    return /** @type {Record<string, unknown>[]} */ (db.prepare('SELECT * FROM consumer_offsets ORDER BY consumer').all()).map(
      toOffsetRow,
    );
  }

  return { consume, ensureOffset, getOffset, repairGap, resetOffset, listOffsets };
}
