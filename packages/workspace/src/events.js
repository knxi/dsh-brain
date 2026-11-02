// @ts-check
/**
 * `ws_events` 事件总线 —— 系统 3 的通信面（全局工作空间的落地物）。
 *
 * ── 为什么需要它，而不是让模块互相调用 ──
 *
 * 方案 §3.1：各区块不得互相随意改写内部状态，统一向全局工作空间发布结构化事件；
 * 只有记忆网关能写记忆，只有指令调度器能启动任务。
 *
 * 这条纪律的工程意义很具体：如果「反思模块」直接往 memories 写、直接调「社交模块」
 * 发消息，那么三天后就没有人说得清「这条记忆是谁写的、为什么写」。事件总线让
 * **产出**与**消费**解耦：产出的只说「我发现了什么」，消费的自己决定要不要动。
 *
 * ── 三条实现纪律 ──
 *
 * 1. **publish 不抛错**。发布事件是"顺带记账"，不该因为记账失败而让主流程崩掉。
 *    失败时返回 `null` 并 `alert`——调用方必须检查返回值，不许假装成功。
 * 2. **幂等靠 dedupe_key**（`UNIQUE(scope_id, dedupe_key)`）。可空，空 = 不去重。
 *    为什么允许不去重：有些事件确实每毫秒都不同（如精力演化），给它们编去重键
 *    只会制造"看起来一样但故意不同"的假键。
 * 3. **消费水位不自动推进**。`pullEvents` 只读并返回 `nextCursor`，推进由调用方
 *    在处理完成之后显式 `advanceCursor`。自动推进会在「消费失败」时静默丢事件——
 *    那种丢法是查不出来的。
 */

import { BrainError, createClock, formatLocalIso } from '@dsh-brain/core'

/** 事件通道枚举：与 migrations/0008 的 CHECK 保持一致（改这里必须同时改迁移）。 */
export const WS_CHANNELS = Object.freeze([
  'sense', 'attention', 'memory', 'affect', 'action', 'result', 'error', 'resource',
])

/** 单条 payload 的软/硬上限（字节）。软上限记告警，硬上限拒绝写入。 */
export const PAYLOAD_SOFT_BYTES = 2048
export const PAYLOAD_HARD_BYTES = 16 * 1024

/** 单次 pull 的默认与硬上限。 */
export const DEFAULT_PULL_LIMIT = 100
export const MAX_PULL_LIMIT = 1000

/** 事件 id 前缀。 */
const EVENT_ID_PREFIX = 'ws_evt'

/** `crypto.randomUUID` 不用，保持与项目其它 id 一致的短 hex 形态。 */
function newEventId() {
  const { randomBytes } = /** @type {any} */ (globalThis).process.getBuiltinModule('node:crypto')
  return `${EVENT_ID_PREFIX}_${randomBytes(12).toString('hex')}`
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必须是非空字符串`)
  }
  return value.trim()
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function requireSalience(value) {
  if (value === undefined || value === null) return 0
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw new BrainError('INVALID_ARGUMENT', `salience 必须是有限数（收到 ${String(value)}）`)
  }
  return Math.min(1, Math.max(0, n))
}

/**
 * @param {unknown} row
 * @returns {any}
 */
function rowToEvent(row) {
  let payload = {}
  try {
    payload = JSON.parse(String(row.payload_json ?? '{}'))
  } catch {
    payload = { __parse_error: true, raw: String(row.payload_json ?? '').slice(0, 200) }
  }
  return {
    id: String(row.id),
    scopeId: String(row.scope_id),
    at: String(row.at),
    atLocal: String(row.at_local),
    atMs: Number(row.at_ms),
    channel: String(row.channel),
    sourceModule: String(row.source_module),
    kind: String(row.kind),
    subjectType: row.subject_type == null ? null : String(row.subject_type),
    subjectId: row.subject_id == null ? null : String(row.subject_id),
    payload,
    salience: Number(row.salience ?? 0),
  }
}

/**
 * 事件总线。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> } | null,
 *   clock?: { stamp: () => { utc: string, local: string }, timeZone?: string },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   bindings?: { scope_id?: string },
 *   now?: () => number,
 * }} options
 */
export function createEventBus(options) {
  const { db, queue } = options
  const clock = options.clock ?? createClock({})
  const alert = options.alert ?? (() => {})
  const now = options.now ?? (() => Date.now())
  const defaultScope = options.bindings?.scope_id ?? 'owner-default'
  const timeZone = clock.timeZone ?? 'Asia/Shanghai'

  /**
   * 发布一条事件。**不抛错**：返回 `null` 表示没写进去（队列不可用 / 序列化失败 /
   * payload 过大），调用方必须据此判断，不许假装成功。
   *
   * @param {{
   *   channel: string, sourceModule: string, kind: string,
   *   subjectType?: string | null, subjectId?: string | null,
   *   payload?: unknown, salience?: number, dedupeKey?: string | null,
   *   scopeId?: string,
   * }} input
   * @returns {Promise<{ id: string, at: string, atMs: number, deduped: boolean } | null>}
   */
  async function publish(input) {
    if (!queue) {
      alert({ kind: 'workspace.publish', message: '写队列不可用（只读实例？），事件未落库' })
      return null
    }
    try {
      const channel = requireString(input?.channel, 'channel')
      if (!WS_CHANNELS.includes(channel)) {
        throw new BrainError('INVALID_ARGUMENT', `未知 channel: ${channel}`)
      }
      const sourceModule = requireString(input?.sourceModule, 'sourceModule')
      const kind = requireString(input?.kind, 'kind')
      const scopeId = typeof input?.scopeId === 'string' && input.scopeId ? input.scopeId : defaultScope
      const salience = requireSalience(input?.salience)

      let payloadJson = '{}'
      if (input?.payload !== undefined && input?.payload !== null) {
        try {
          payloadJson = JSON.stringify(input.payload)
        } catch {
          alert({ kind: 'workspace.publish', message: 'payload 无法序列化，事件未落库', detail: { kind } })
          return null
        }
      }
      const bytes = Buffer.byteLength(payloadJson, 'utf8')
      if (bytes > PAYLOAD_HARD_BYTES) {
        alert({
          kind: 'workspace.publish',
          message: `payload 超过硬上限 ${PAYLOAD_HARD_BYTES}B（${bytes}B），事件未落库`,
          detail: { kind, bytes },
        })
        return null
      }
      if (bytes > PAYLOAD_SOFT_BYTES) {
        alert({ kind: 'workspace.publish', message: `payload 超过软上限 ${PAYLOAD_SOFT_BYTES}B（${bytes}B）`, detail: { kind, bytes } })
      }

      const id = newEventId()
      const atMs = now()
      const stamp = clock.stamp()
      const at = stamp.utc
      const atLocal = formatLocalIso(new Date(atMs), timeZone)
      const dedupeKey = input?.dedupeKey == null || input.dedupeKey === '' ? null : String(input.dedupeKey)

      const result = await queue.write(
        (tx) => {
          // 先查去重键：命中就返回既有那条，不新建（UNIQUE 冲突会让整个事务回滚，
          // 而「重复发布」在真实调用里很常见，不该当异常处理）
          if (dedupeKey) {
            const existing = tx.get(
              'SELECT id, at, at_ms FROM ws_events WHERE scope_id = ? AND dedupe_key = ?',
              [scopeId, dedupeKey],
            )
            if (existing) return { id: String(existing.id), at: String(existing.at), atMs: Number(existing.at_ms), deduped: true }
          }
          tx.run(
            `INSERT INTO ws_events (
               id, scope_id, at, at_local, at_ms, channel, source_module, kind,
               subject_type, subject_id, payload_json, salience, dedupe_key,
               created_at, created_at_local
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id, scopeId, at, atLocal, atMs, channel, sourceModule, kind,
              input?.subjectType ?? null, input?.subjectId ?? null, payloadJson, salience, dedupeKey,
              at, atLocal,
            ],
          )
          return { id, at, atMs, deduped: false }
        },
        { label: 'workspace.publish' },
      )
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      alert({ kind: 'workspace.publish', message, detail: { channel: input?.channel, kind: input?.kind } })
      return null
    }
  }

  /**
   * 读某模块的水位。没消费过返回 `null`（不是 0——「从没消费」和「消费到 0」不同）。
   * @param {string} moduleName
   * @param {string} [scopeId]
   */
  function getCursor(moduleName, scopeId = defaultScope) {
    const row = db.prepare(
      'SELECT * FROM ws_consumers WHERE scope_id = ? AND module_name = ?',
    ).get(scopeId, moduleName)
    if (!row) return null
    return {
      moduleName: String(row.module_name),
      lastAtMs: row.last_at_ms == null ? null : Number(row.last_at_ms),
      lastEventId: row.last_event_id == null ? null : String(row.last_event_id),
      consumedCount: Number(row.consumed_count ?? 0),
      errorCount: Number(row.error_count ?? 0),
      lastError: row.last_error == null ? null : String(row.last_error),
      updatedAt: String(row.updated_at),
    }
  }

  /**
   * 拉取水位之后的事件（只读，不推进水位）。
   *
   * @param {{
   *   moduleName: string, limit?: number, channels?: string[],
   *   sinceMs?: number | null, scopeId?: string,
   * }} input
   * @returns {{ events: any[], nextCursor: { lastAtMs: number | null, lastEventId: string | null } }}
   */
  function pullEvents(input) {
    const moduleName = requireString(input?.moduleName, 'moduleName')
    const scopeId = input?.scopeId ?? defaultScope
    const limit = Math.min(MAX_PULL_LIMIT, Math.max(1, Number(input?.limit ?? DEFAULT_PULL_LIMIT) || DEFAULT_PULL_LIMIT))
    const cursor = getCursor(moduleName, scopeId)
    const sinceMs = input?.sinceMs === undefined ? (cursor?.lastAtMs ?? null) : input.sinceMs

    const where = ['scope_id = ?']
    const args = [scopeId]
    if (sinceMs !== null && sinceMs !== undefined && Number.isFinite(Number(sinceMs))) {
      // 用 >= 而不是 >：同一毫秒可能有两条事件，严格大于会漏掉后一条。
      // 重复的那几条由调用方按 id 去重（事件是 append-only，id 唯一）。
      where.push('at_ms >= ?')
      args.push(Number(sinceMs))
    }
    const channels = Array.isArray(input?.channels) ? input.channels.filter((c) => WS_CHANNELS.includes(c)) : []
    if (channels.length) {
      where.push(`channel IN (${channels.map(() => '?').join(',')})`)
      args.push(...channels)
    }
    args.push(limit)

    const rows = db.prepare(
      `SELECT * FROM ws_events WHERE ${where.join(' AND ')} ORDER BY at_ms ASC, id ASC LIMIT ?`,
    ).all(...args)
    // 用 `at_ms >= sinceMs` 是为了不漏同毫秒的后续事件，代价是会把「已经处理过的那条」
    // 再捞回来一次。所以在这里按 id 精确排除它——既不漏（>=），也不重（精确排除）。
    const lastEventId = cursor?.lastEventId ?? null
    const events = rows.map(rowToEvent).filter((event) => event.id !== lastEventId)
    const last = events.length ? events[events.length - 1] : null
    return {
      events,
      nextCursor: {
        lastAtMs: last ? last.atMs : (cursor?.lastAtMs ?? null),
        lastEventId: last ? last.id : (cursor?.lastEventId ?? null),
      },
    }
  }

  /**
   * 推进消费水位。**处理成功之后才调**。
   *
   * @param {{
   *   moduleName: string, lastAtMs: number | null, lastEventId?: string | null,
   *   count?: number, error?: string | null, scopeId?: string,
   * }} input
   */
  async function advanceCursor(input) {
    const moduleName = requireString(input?.moduleName, 'moduleName')
    const scopeId = input?.scopeId ?? defaultScope
    const lastAtMs = input?.lastAtMs == null ? null : Number(input.lastAtMs)
    const lastEventId = input?.lastEventId == null ? null : String(input.lastEventId)
    const count = Math.max(0, Number(input?.count ?? 0) || 0)
    const error = input?.error == null ? null : String(input.error).slice(0, 500)
    if (!queue) {
      alert({ kind: 'workspace.advanceCursor', message: '写队列不可用，水位未推进' })
      return { ok: false }
    }
    const stamp = clock.stamp()
    await queue.write(
      (tx) => {
        tx.run(
          `INSERT INTO ws_consumers (
             scope_id, module_name, last_at_ms, last_event_id, consumed_count,
             updated_at, updated_at_local, error_count, last_error
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope_id, module_name) DO UPDATE SET
             last_at_ms = COALESCE(excluded.last_at_ms, ws_consumers.last_at_ms),
             last_event_id = COALESCE(excluded.last_event_id, ws_consumers.last_event_id),
             consumed_count = ws_consumers.consumed_count + excluded.consumed_count,
             updated_at = excluded.updated_at,
             updated_at_local = excluded.updated_at_local,
             error_count = ws_consumers.error_count + excluded.error_count,
             last_error = COALESCE(excluded.last_error, ws_consumers.last_error)`,
          [
            scopeId, moduleName, lastAtMs, lastEventId, count,
            stamp.utc, stamp.local,
            error ? 1 : 0, error,
          ],
        )
      },
      { label: 'workspace.advanceCursor' },
    )
    return { ok: true }
  }

  /** 事件总数与最近时间（给控制台用）。 */
  function stats(scopeId = defaultScope) {
    const row = db.prepare(
      'SELECT count(*) AS c, max(at_ms) AS lastMs FROM ws_events WHERE scope_id = ?',
    ).get(scopeId)
    return { count: Number(row?.c ?? 0), lastAtMs: row?.lastMs == null ? null : Number(row.lastMs) }
  }

  return { publish, getCursor, pullEvents, advanceCursor, stats }
}
