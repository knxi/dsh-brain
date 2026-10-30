// @ts-check
/**
 * 主账门面：幂等摄取、会话投影、审计、水位查询。
 *
 * 这里是 M1 最核心的写入路径：
 *
 * ```
 * normalizeEnvelope（纯函数校验，队列外，失败即拒绝）
 *        │
 *        ▼
 * queue.write(BEGIN IMMEDIATE)
 *   ├─ 查唯一键 (source_system, scope_id, source_event_id)
 *   │    ├─ 已存在且指纹相同 → duplicate（补 outbox 后提交，不新增事件）
 *   │    └─ 已存在但正文不同 → ConflictError（整事务回滚）
 *   ├─ INSERT events
 *   ├─ UPSERT sessions（last_source_seq 只增不减、event_count+1）
 *   └─ INSERT outbox（同一事务，dedupe_key 唯一）
 * COMMIT ────────────────────────────► 返回 persisted: true（这才是 ACK）
 * ```
 *
 * 任何一步失败（含 COMMIT 时磁盘满）都会 reject；调用方**不得**显示「已记住」。
 */

import { randomBytes } from 'node:crypto';
import { BrainError, ConflictError, normalizeEnvelope } from '@dsh-brain/core';
import { enqueueOutbox } from './outbox.js';
import { createTxApi } from './write-queue.js';
import { readDeletionEpoch, readMeta, readMetaInt } from './meta.js';

/** 单用户 MVP 默认绑定。连接器必须显式传自己的 bindings。 */
export const DEFAULT_SCOPE_ID = 'owner-default';
export const DEFAULT_PERSON_ID = 'owner';
export const DEFAULT_SOURCE_SYSTEM = 'dsh';

/** 事件入队后默认派生的投影工作项类型。 */
export const PROJECT_EVENT_WORK_KIND = 'project_event';

/** @typedef {ReturnType<typeof createTxApi>} TxApi */

/**
 * @typedef {Object} EventRecord
 * @property {string} event_id
 * @property {number} schema_version
 * @property {string} source_system
 * @property {string} source_event_id
 * @property {string} scope_id
 * @property {string} person_id
 * @property {string} session_id
 * @property {string | null} turn_id
 * @property {string | null} step_id
 * @property {number} source_seq
 * @property {string} event_type
 * @property {string} origin_system
 * @property {string | null} causation_id
 * @property {string[]} derived_from
 * @property {string} payload_ref
 * @property {string} payload_hash
 * @property {string | null} payload_text
 * @property {number | null} payload_bytes
 * @property {string} privacy
 * @property {string} occurred_at
 * @property {string} occurred_at_local
 * @property {string} received_at
 * @property {string} received_at_local
 * @property {string} time_zone
 * @property {string} content_fingerprint
 * @property {number} deletion_epoch
 */

/**
 * @param {Record<string, unknown>} row
 * @returns {EventRecord}
 */
export function toEventRecord(row) {
  let derivedFrom = [];
  try {
    derivedFrom = JSON.parse(String(row.derived_from ?? '[]'));
  } catch {
    derivedFrom = [];
  }
  return {
    event_id: String(row.event_id),
    schema_version: Number(row.schema_version),
    source_system: String(row.source_system),
    source_event_id: String(row.source_event_id),
    scope_id: String(row.scope_id),
    person_id: String(row.person_id),
    session_id: String(row.session_id),
    turn_id: row.turn_id === null || row.turn_id === undefined ? null : String(row.turn_id),
    step_id: row.step_id === null || row.step_id === undefined ? null : String(row.step_id),
    source_seq: Number(row.source_seq),
    event_type: String(row.event_type),
    origin_system: String(row.origin_system),
    causation_id: row.causation_id === null || row.causation_id === undefined ? null : String(row.causation_id),
    derived_from: Array.isArray(derivedFrom) ? derivedFrom.map(String) : [],
    payload_ref: String(row.payload_ref),
    payload_hash: String(row.payload_hash),
    payload_text: row.payload_text === null || row.payload_text === undefined ? null : String(row.payload_text),
    payload_bytes: row.payload_bytes === null || row.payload_bytes === undefined ? null : Number(row.payload_bytes),
    privacy: String(row.privacy),
    occurred_at: String(row.occurred_at),
    occurred_at_local: String(row.occurred_at_local),
    received_at: String(row.received_at),
    received_at_local: String(row.received_at_local),
    time_zone: String(row.time_zone),
    content_fingerprint: String(row.content_fingerprint),
    deletion_epoch: Number(row.deletion_epoch ?? 0),
  };
}

/**
 * @typedef {Object} IngestResult
 * @property {'accepted' | 'duplicate'} status
 * @property {true} persisted 已提交到主账；这是「已记住」的唯一依据
 * @property {string} event_id
 * @property {string} outbox_id
 * @property {string} content_fingerprint
 * @property {boolean} duplicate
 * @property {string} ack_at COMMIT 成功之后的时间戳
 */

/**
 * @typedef {Object} AuditInput
 * @property {string} action
 * @property {string} [actor]
 * @property {string} [target_kind]
 * @property {string} [target_id]
 * @property {string} [scope_id]
 * @property {'ok' | 'denied' | 'error'} [result]
 * @property {Record<string, unknown>} [detail]
 * @property {string} [trace_id]
 */

/**
 * 造主账门面。
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: TxApi) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string }, nowUtc: () => string, nowLocal: () => string, timeZone?: string },
 *   bindings?: { source_system: string, scope_id: string, person_id: string },
 *   maxPayloadBytes?: number,
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 * }} options
 */
export function createMainLedger(options) {
  const { db, queue, clock } = options;
  const defaultBindings = options.bindings ?? {
    source_system: DEFAULT_SOURCE_SYSTEM,
    scope_id: DEFAULT_SCOPE_ID,
    person_id: DEFAULT_PERSON_ID,
  };
  const alert = options.alert ?? (() => {});

  const insertEventSql = `INSERT INTO events (
      event_id, schema_version, source_system, source_event_id, scope_id, person_id,
      session_id, turn_id, step_id, source_seq, event_type, origin_system,
      causation_id, derived_from, payload_ref, payload_hash, payload_text, payload_bytes,
      privacy, occurred_at, occurred_at_local, received_at, received_at_local,
      time_zone, content_fingerprint, deletion_epoch, created_at, created_at_local
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, 0, ?, ?
    )`;

  const upsertSessionSql = `INSERT INTO sessions (
      session_id, scope_id, person_id, source_system,
      started_at, started_at_local, last_event_at, last_event_at_local,
      last_source_seq, event_count, deletion_epoch,
      created_at, created_at_local, updated_at, updated_at_local
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      started_at = CASE
        WHEN sessions.started_at IS NULL OR excluded.started_at < sessions.started_at
        THEN excluded.started_at ELSE sessions.started_at END,
      started_at_local = CASE
        WHEN sessions.started_at IS NULL OR excluded.started_at < sessions.started_at
        THEN excluded.started_at_local ELSE sessions.started_at_local END,
      last_event_at = CASE
        WHEN sessions.last_event_at IS NULL OR excluded.last_event_at > sessions.last_event_at
        THEN excluded.last_event_at ELSE sessions.last_event_at END,
      last_event_at_local = CASE
        WHEN sessions.last_event_at IS NULL OR excluded.last_event_at > sessions.last_event_at
        THEN excluded.last_event_at_local ELSE sessions.last_event_at_local END,
      last_source_seq = MAX(COALESCE(sessions.last_source_seq, -1), excluded.last_source_seq),
      event_count = sessions.event_count + 1,
      updated_at = excluded.updated_at,
      updated_at_local = excluded.updated_at_local`;

  /**
   * 摄取一条事件。resolve 即 ACK；reject 即「没有记住」。
   * @param {unknown} input 原始信封
   * @param {{
   *   bindings?: { source_system: string, scope_id: string, person_id: string },
   *   clock?: { nowUtc: () => string, timeZone?: string },
   * }} [opts]
   * @returns {Promise<IngestResult>}
   */
  async function ingestEvent(input, opts = {}) {
    const bindings = opts.bindings ?? defaultBindings;
    const ingestClock = opts.clock ?? clock;
    // 队列外先做纯函数校验：不合法的事件不进入事务。
    const { envelope, meta } = normalizeEnvelope(input, {
      bindings,
      clock: ingestClock,
      maxPayloadBytes: options.maxPayloadBytes,
    });

    try {
      const result = await queue.write(
        (tx) => {
          /** @type {Record<string, unknown> | undefined} */
          const bySourceKey = tx.get(
            `SELECT event_id, content_fingerprint, payload_hash
               FROM events
              WHERE source_system = ? AND scope_id = ? AND source_event_id = ?`,
            [envelope.source_system, envelope.scope_id, envelope.source_event_id],
          );

          if (bySourceKey !== undefined) {
            const storedFingerprint = String(bySourceKey.content_fingerprint);
            if (storedFingerprint !== meta.content_fingerprint) {
              throw new ConflictError('同一源事件 ID 的正文不同，拒绝静默覆盖', {
                source_system: envelope.source_system,
                scope_id: envelope.scope_id,
                source_event_id: envelope.source_event_id,
                event_id: String(bySourceKey.event_id),
                stored_payload_hash: String(bySourceKey.payload_hash),
                incoming_payload_hash: envelope.payload_hash,
              });
            }
            // 幂等重放：不新增事件；补齐可能缺失的 outbox 工作项。
            const existingId = String(bySourceKey.event_id);
            const outbox = enqueueOutbox(
              tx,
              {
                kind: PROJECT_EVENT_WORK_KIND,
                dedupeKey: `event:${existingId}:project`,
                aggregateKind: 'event',
                aggregateId: existingId,
                eventId: existingId,
                payload: { event_id: existingId },
              },
              clock,
            );
            return {
              status: /** @type {const} */ ('duplicate'),
              persisted: /** @type {const} */ (true),
              event_id: existingId,
              outbox_id: outbox.outbox_id,
              content_fingerprint: meta.content_fingerprint,
              duplicate: true,
            };
          }

          /** @type {Record<string, unknown> | undefined} */
          const byEventId = tx.get(
            'SELECT event_id, source_system, scope_id, source_event_id, payload_hash FROM events WHERE event_id = ?',
            [envelope.event_id],
          );
          if (byEventId !== undefined) {
            throw new ConflictError('event_id 已被另一条事件占用，拒绝覆盖', {
              source_system: envelope.source_system,
              scope_id: envelope.scope_id,
              source_event_id: envelope.source_event_id,
              event_id: String(byEventId.event_id),
              stored_payload_hash: String(byEventId.payload_hash),
              incoming_payload_hash: envelope.payload_hash,
            });
          }

          /** @type {Record<string, unknown> | undefined} */
          const session = tx.get('SELECT session_id, scope_id FROM sessions WHERE session_id = ?', [envelope.session_id]);
          if (session !== undefined && String(session.scope_id) !== envelope.scope_id) {
            throw new BrainError('INVALID_ARGUMENT', 'session_id 已属于其它 scope，拒绝跨 scope 写入', {
              details: { session_id: envelope.session_id },
            });
          }

          const stamp = clock.stamp();
          tx.run(insertEventSql, [
            envelope.event_id,
            envelope.schema_version,
            envelope.source_system,
            envelope.source_event_id,
            envelope.scope_id,
            envelope.person_id,
            envelope.session_id,
            envelope.turn_id,
            envelope.step_id,
            envelope.source_seq,
            envelope.event_type,
            envelope.origin_system,
            envelope.causation_id,
            JSON.stringify(envelope.derived_from ?? []),
            envelope.payload_ref,
            envelope.payload_hash,
            envelope.payload_text ?? null,
            meta.payload_bytes,
            envelope.privacy,
            envelope.occurred_at,
            meta.occurred_at_local,
            envelope.received_at,
            meta.received_at_local,
            meta.time_zone,
            meta.content_fingerprint,
            stamp.utc,
            stamp.local,
          ]);

          tx.run(upsertSessionSql, [
            envelope.session_id,
            envelope.scope_id,
            envelope.person_id,
            envelope.source_system,
            envelope.occurred_at,
            meta.occurred_at_local,
            envelope.occurred_at,
            meta.occurred_at_local,
            envelope.source_seq,
            stamp.utc,
            stamp.local,
            stamp.utc,
            stamp.local,
          ]);

          const outbox = enqueueOutbox(
            tx,
            {
              kind: PROJECT_EVENT_WORK_KIND,
              dedupeKey: `event:${envelope.event_id}:project`,
              aggregateKind: 'event',
              aggregateId: envelope.event_id,
              eventId: envelope.event_id,
              payload: { event_id: envelope.event_id },
            },
            clock,
          );

          return {
            status: /** @type {const} */ ('accepted'),
            persisted: /** @type {const} */ (true),
            event_id: envelope.event_id,
            outbox_id: outbox.outbox_id,
            content_fingerprint: meta.content_fingerprint,
            duplicate: false,
          };
        },
        { label: 'ledger.ingestEvent' },
      );

      // ACK 时间取 COMMIT 之后，避免把「事务内时刻」冒充提交时刻。
      return { ...result, ack_at: clock.nowUtc() };
    } catch (err) {
      if (err instanceof ConflictError) {
        try {
          alert({
            kind: 'event_conflict',
            message: '同一源事件 ID 的正文不同，已拒绝写入',
            detail: {
              source_system: err.info.source_system,
              scope_id: err.info.scope_id,
              source_event_id: err.info.source_event_id,
              stored_payload_hash: err.info.stored_payload_hash,
              incoming_payload_hash: err.info.incoming_payload_hash,
            },
          });
        } catch {
          /* 告警失败不掩盖冲突错误 */
        }
        try {
          await writeAudit({
            action: 'event.conflict',
            actor: 'memory',
            target_kind: 'event',
            target_id: err.info.event_id,
            scope_id: err.info.scope_id,
            result: 'error',
            detail: {
              source_system: err.info.source_system,
              source_event_id: err.info.source_event_id,
              stored_payload_hash: err.info.stored_payload_hash,
              incoming_payload_hash: err.info.incoming_payload_hash,
            },
          });
        } catch {
          /* 审计失败不掩盖冲突错误 */
        }
      }
      throw err;
    }
  }

  /**
   * 事件记录读取（含 payload_text；调用方负责权限与删除屏障）。
   * @param {string} eventId
   * @returns {EventRecord | null}
   */
  function readEvent(eventId) {
    const row = /** @type {Record<string, unknown> | undefined} */ (
      db.prepare('SELECT * FROM events WHERE event_id = ?').get(eventId)
    );
    return row === undefined ? null : toEventRecord(row);
  }

  /**
   * @param {{ source_system: string, scope_id: string, source_event_id: string }} identity
   * @returns {EventRecord | null}
   */
  function readEventBySourceKey(identity) {
    const row = /** @type {Record<string, unknown> | undefined} */ (
      db
        .prepare('SELECT * FROM events WHERE source_system = ? AND scope_id = ? AND source_event_id = ?')
        .get(identity.source_system, identity.scope_id, identity.source_event_id)
    );
    return row === undefined ? null : toEventRecord(row);
  }

  /**
   * @param {{ scope_id?: string }} [opts]
   * @returns {number}
   */
  function countEvents(opts = {}) {
    const row = opts.scope_id
      ? /** @type {{ n?: number }} */ (db.prepare('SELECT COUNT(*) AS n FROM events WHERE scope_id = ?').get(opts.scope_id))
      : /** @type {{ n?: number }} */ (db.prepare('SELECT COUNT(*) AS n FROM events').get());
    return Number(row?.n ?? 0);
  }

  /**
   * @param {{ scope_id?: string, session_id?: string, afterSeq?: number, source_system?: string, limit?: number }} [opts]
   * @returns {EventRecord[]}
   */
  function listEvents(opts = {}) {
    const clauses = [];
    const params = [];
    if (opts.scope_id) {
      clauses.push('scope_id = ?');
      params.push(opts.scope_id);
    }
    if (opts.session_id) {
      clauses.push('session_id = ?');
      params.push(opts.session_id);
    }
    if (opts.source_system) {
      clauses.push('source_system = ?');
      params.push(opts.source_system);
    }
    if (opts.afterSeq !== undefined) {
      clauses.push('source_seq > ?');
      params.push(opts.afterSeq);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(opts.limit ?? 200, 1000));
    const rows = db.prepare(`SELECT * FROM events ${where} ORDER BY source_seq ASC LIMIT ?`).all(...params, limit);
    return /** @type {Record<string, unknown>[]} */ (rows).map(toEventRecord);
  }

  /**
   * @param {string} sessionId
   * @returns {Record<string, unknown> | null}
   */
  function getSession(sessionId) {
    const row = /** @type {Record<string, unknown> | undefined} */ (
      db.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId)
    );
    return row ?? null;
  }

  /**
   * 水位：该 scope/session 已收到的最大 source_seq 与最近事件时间。
   * @param {{ scope_id?: string, session_id?: string }} [opts]
   * @returns {{ max_source_seq: number | null, last_received_at: string | null, event_count: number }}
   */
  function eventWatermark(opts = {}) {
    const clauses = [];
    const params = [];
    if (opts.scope_id) {
      clauses.push('scope_id = ?');
      params.push(opts.scope_id);
    }
    if (opts.session_id) {
      clauses.push('session_id = ?');
      params.push(opts.session_id);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const row = /** @type {{ max_seq: number | null, last_received: string | null, n: number }} */ (
      db
        .prepare(`SELECT MAX(source_seq) AS max_seq, MAX(received_at) AS last_received, COUNT(*) AS n FROM events ${where}`)
        .get(...params)
    );
    return {
      max_source_seq: row.max_seq === null ? null : Number(row.max_seq),
      last_received_at: row.last_received ?? null,
      event_count: Number(row.n ?? 0),
    };
  }

  /**
   * 写一条审计。detail 只放 ID/哈希/原因，禁止放正文。
   * @param {AuditInput} input
   * @returns {Promise<{ audit_id: string }>}
   */
  async function writeAudit(input) {
    const auditId = `aud_${randomBytes(12).toString('hex')}`;
    const stamp = clock.stamp();
    await queue.write(
      (tx) => {
        insertAudit(tx, auditId, input, clock);
      },
      { label: 'ledger.audit' },
    );
    return { audit_id: auditId };
  }

  /**
   * @param {{ action?: string, limit?: number }} [opts]
   * @returns {Record<string, unknown>[]}
   */
  function listAudit(opts = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 100, 1000));
    const rows = opts.action
      ? db.prepare('SELECT * FROM audit_logs WHERE action = ? ORDER BY ts ASC LIMIT ?').all(opts.action, limit)
      : db.prepare('SELECT * FROM audit_logs ORDER BY ts ASC LIMIT ?').all(limit);
    return /** @type {Record<string, unknown>[]} */ (rows);
  }

  /** 当前删除纪元（只读）。 */
  function getDeletionEpoch() {
    return readDeletionEpoch(db);
  }

  /**
   * @param {string} key
   * @returns {string | null}
   */
  function getMeta(key) {
    return readMeta(createTxApi(db), key);
  }

  /**
   * @param {string} key
   * @param {number} [fallback]
   */
  function getMetaInt(key, fallback = 0) {
    return readMetaInt(createTxApi(db), key, fallback);
  }

  return {
    ingestEvent,
    readEvent,
    readEventBySourceKey,
    countEvents,
    listEvents,
    getSession,
    eventWatermark,
    writeAudit,
    listAudit,
    getDeletionEpoch,
    getMeta,
    getMetaInt,
  };
}

/**
 * 事务内写审计（供 deletion / outbox / 迁移等已经在事务里的路径使用）。
 * @param {TxApi} tx
 * @param {string} auditId
 * @param {AuditInput} input
 * @param {{ stamp: () => { utc: string, local: string } }} clock
 */
export function insertAudit(tx, auditId, input, clock) {
  const stamp = clock.stamp();
  tx.run(
    `INSERT INTO audit_logs (
       audit_id, ts, ts_local, actor, action, target_kind, target_id, scope_id,
       result, detail, trace_id, deletion_epoch
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      auditId,
      stamp.utc,
      stamp.local,
      input.actor ?? 'system',
      input.action,
      input.target_kind ?? null,
      input.target_id ?? null,
      input.scope_id ?? null,
      input.result ?? 'ok',
      input.detail === undefined ? null : JSON.stringify(input.detail),
      input.trace_id ?? null,
      input.deletion_epoch === undefined ? null : input.deletion_epoch,
    ],
  );
}
