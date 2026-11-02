// @ts-check
/**
 * `mood` 门面（M7.2）—— 情感状态（心情 / 精力 / 亲密度）并入主账。
 *
 * ── 为什么要有这张表，而不是写进 memories ──
 *
 * 这份状态每 5 分钟演化一次，一天 288 条。写进 memories 会**把检索稀释成垃圾**；
 * 更要紧的是语义不对：「实时状态」（此刻的我）和「跨会话记忆」（我以前说过的）
 * 是两种东西，混在一起之后，检索既查不准当下，也翻不出过去。
 * 所以走专用表，**不进检索、不进 memories**。
 *
 * ── 两张表的分工（0007 迁移）──
 *
 * - `fox_state`：单行快照（`CHECK (id = 1)`）。这一行就是「此刻的我」。
 * - `fox_events`：事件流水。是状态变化的**原因**，用来还原「为什么心情是这样」。
 *
 * ── 四条纪律 ──
 *
 * 1. **不做 scope 过滤**（CONTRACTS §16 的显式例外）。
 *    其它门面（memories / entities / contextPackages…）默认按 caller scope 收口，
 *    因为它们的语义是「某个 scope 掌握的记忆」。这两张表的语义是**「这一个我」的状态**：
 *    `fox_state` 只有一行、没有 `scope_id` 列，`fox_events` 也不按 scope 分——
 *    心情不因为换了项目目录就变成另一个人的心情。
 *    真要支持多实例，正确做法是加一列 `instance_id` 并改主键，而不是借 scope 列糊上去。
 *    **所以这里刻意没有 `scopeId` 参数，传了也不生效。**
 * 2. **幂等优先**：`fox_state` 走 `ON CONFLICT(id) DO UPDATE`；
 *    `fox_events` 以 **`(at, kind)` 为幂等键**（同一毫秒的同类事件视为同一次记账）。
 *    为什么事件也去重：迁移脚本会反复跑、插件可能重放一回合，制造重复事件等于
 *    把「最近发生了什么」讲成结巴——而这恰好是注入提示词和主动引擎要读的东西。
 * 3. **脏数据不炸查询**：`delta_json` 解析不了当 `{}`；数值列统一 `Number()`。
 *    这两张表是**热路径**（每 5 分钟写、每次对话读），一条坏行不该让整次注入 500。
 * 4. **写一律走 `queue.write`（单写队列 + 事务）**，读走 `createTxApi`——与全库同一套。
 *
 * ── 时间字段的两种形态（别统一）──
 *
 * - `createdAt` / `updatedAt`：ISO 8601 UTC 字符串。对应库里的 `created_at` / `updated_at`
 *   TEXT 列，跟主账其它表一个口径（人工排查、备份核对、跨表 join 都按这个形态）。
 * - `lastInteractAt` / `lastProactiveAt` / `at`：**毫秒数字**。对应库里的 REAL 列。
 *   这三个值喂的是 `core.js` 里的毫秒算术（`now - lastInteractAt > 30 * 60_000`），
 *   存 ISO 每次都要 `Date.parse` 一遍，多一次转换就多一个时区出错的地方。
 *
 * 调用方（`plugins/dsh-fox-mood`）因此要自己做一次毫秒 ↔ ISO 的转换：
 * `Date.parse(getState().updatedAt)` 拿毫秒，`saveState({ updatedAt: <毫秒或ISO> })` 都能吃。
 */

import { BrainError, formatLocalIso } from '@dsh-brain/core'
import { createTxApi } from './write-queue.js'
import { clampInt, newId, normalizeInstant, requireString } from './memory-util.js'

/** 默认时区：与 `openBrain` 的缺省值一致（`createClock({ timeZone })` 没传时就是它）。 */
const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/** 快照表的固定主键（`CHECK (id = 1)` 把「只能有一行」写进了 schema）。 */
export const FOX_STATE_ID = 1
/** `note` 截断上限：与 `brain_remember` 的记忆正文上限一致，一句情绪说明不该更长。 */
export const MAX_NOTE_LENGTH = 500
/** `listEvents` 默认条数。够覆盖 core.js 的 60 条窗口 + 面板的 20 条。 */
export const DEFAULT_EVENT_LIMIT = 100
/** `listEvents` 硬上限：再大就该用 `since` 缩小范围，而不是一次拉全库。 */
export const MAX_EVENT_LIMIT = 500
/** `pruneEvents` 默认保留条数（约 1.7 天：一天 288 条演化里真记事件远少于这个数）。 */
export const DEFAULT_EVENT_KEEP = 500
/** 事件种类最大长度。超长多半是把整句话当 kind 了，那是错的。 */
const MAX_KIND_LENGTH = 64
/** 插件写入的事件默认记这个来源；迁移脚本会显式传自己的来源。 */
const DEFAULT_SOURCE_SYSTEM = 'fox-mood'

/**
 * 三维度取值校验 + 夹取。
 *
 * **非有限数直接拒**（NaN / Infinity / 非数字串）：那是上游算坏了，
 * 写进去会让「心情」变成一个无法比较的值。超出 0..100 则**夹取并继续**：
 * core.js 的 `clamp()` 已经保证范围，越界只可能是浮点边界，
 * 为它拒掉整条写入等于让状态卡在旧值上——那是更糟的结果。
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function clampDimension(value, field) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必须是有限数（收到 ${String(value)}）`)
  }
  return Math.min(100, Math.max(0, n))
}

/**
 * 毫秒时刻校验。`null` / `undefined` / `''` 视为「没有」（返回 null，不是 0）——
 * 0 是有意义的值（「从没主动过」），不能跟「没传」混成同一个意思。
 * @param {unknown} value
 * @param {string} field
 * @returns {number | null}
 */
function requireEpochMs(value, field) {
  if (value === undefined || value === null || value === '') return null
  /** @type {number} */
  let ms
  if (typeof value === 'number') ms = value
  else if (value instanceof Date) ms = value.getTime()
  else if (typeof value === 'string') ms = Date.parse(value)
  else ms = Number.NaN
  if (!Number.isFinite(ms)) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 不是合法时刻（收到 ${String(value)}）`)
  }
  return ms
}

/**
 * `delta` 的 JSON 序列化。只收普通对象；数组 / 字符串等一律当 `{}` 存
 * （宁可少存一个维度，也不要往列里塞一个别人读不懂的形状）。
 * @param {unknown} delta
 * @param {string} field
 * @returns {string}
 */
function stringifyDelta(delta, field) {
  if (delta === undefined || delta === null) return '{}'
  if (typeof delta !== 'object' || Array.isArray(delta)) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必须是对象（收到 ${Array.isArray(delta) ? 'array' : typeof delta}）`)
  }
  try {
    return JSON.stringify(delta)
  } catch {
    // 循环引用之类：报清楚，别把一个空对象静默写进去
    throw new BrainError('INVALID_ARGUMENT', `${field} 无法序列化成 JSON（可能有循环引用）`)
  }
}

/**
 * 解析 `delta_json`。脏数据当 `{}`——理由同 entities.js 的 `safeAliases`：
 * 这里读的是历史数据，宁可少几个增量也不能让整次注入 500。
 * @param {unknown} text
 * @returns {Record<string, number>}
 */
function safeDelta(text) {
  if (text === null || text === undefined) return {}
  if (typeof text === 'object') return /** @type {Record<string, number>} */ (text)
  try {
    const parsed = JSON.parse(String(text))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? /** @type {Record<string, number>} */ (parsed)
      : {}
  } catch {
    return {}
  }
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
function rowToState(row) {
  return {
    mood: Number(row.mood),
    energy: Number(row.energy),
    bond: Number(row.bond),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    lastInteractAt: row.last_interact_at == null ? null : Number(row.last_interact_at),
    lastProactiveAt: row.last_proactive_at == null ? null : Number(row.last_proactive_at),
  }
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
function rowToEvent(row) {
  return {
    id: String(row.id),
    at: Number(row.at),
    kind: String(row.kind),
    note: row.note == null ? null : String(row.note),
    delta: safeDelta(row.delta_json),
    sourceSystem: row.source_system == null ? null : String(row.source_system),
    createdAt: String(row.created_at),
  }
}

/**
 * 情感状态门面。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string }, timeZone?: string },
 * }} options
 */
export function createMood(options) {
  const { db, queue, clock } = options
  const tx = createTxApi(db)
  const timeZone = clock.timeZone ?? DEFAULT_TIME_ZONE
  /**
   * ISO → 该时区的本地 ISO。为什么要显式转：`created_at_local` 的口径是
   * 「同一时刻的 +08:00 形态」，调用方传进来的 `createdAt` 是 UTC。
   * 直接复用 `clock.stamp().local` 会写成**写库那一刻**的本地时间，
   * 跟 `created_at` 对不上——两条时间列指两个时刻，人工核对时会当成数据被改过。
   * @param {string} iso
   * @returns {string}
   */
  const localOf = (iso) => formatLocalIso(new Date(iso), timeZone)

  /**
   * 读当前状态快照。**空库返回 `null`**（不抛、不造一份默认状态）：
   * 「还没有状态」和「状态是 65/62/30」是两件事，前者该由调用方决定怎么起步
   * （插件的 `core.initialState()` 才是初始值的唯一来源）。
   * @returns {any | null}
   */
  function getState() {
    const row = tx.get('SELECT * FROM fox_state WHERE id = ?', [FOX_STATE_ID])
    return row === undefined ? null : rowToState(/** @type {any} */ (row))
  }

  /**
   * 写当前状态快照（单行 upsert）。**不覆盖 `created_at`**：
   * 那是「这份状态第一次出现在主账里的时刻」，被每次 tick 刷掉之后就没法回答
   * 「这个状态从什么时候开始算」。
   *
   * @param {{
   *   mood: number, energy: number, bond: number,
   *   version?: number,
   *   createdAt?: number | string | Date,
   *   updatedAt?: number | string | Date,
   *   lastInteractAt?: number | string | null,
   *   lastProactiveAt?: number | string | null,
   * }} state
   * @returns {Promise<{ created: boolean, updatedAt: string }>}
   */
  async function saveState(state = /** @type {any} */ ({})) {
    const mood = clampDimension(state.mood, 'mood')
    const energy = clampDimension(state.energy, 'energy')
    const bond = clampDimension(state.bond, 'bond')
    const version = clampInt(state.version, 1, Number.MAX_SAFE_INTEGER, 1, 'version')
    // createdAt：首次插入才用（更新时 SQL 里不碰这一列）
    const requestedCreatedAt = normalizeInstant(state.createdAt, 'createdAt')
    // updatedAt：没传就用记账时刻。**信任调用方传的演化时间**——
    // 这个值决定 core.js 下次从哪儿开始积分，用「写库的墙上时间」替换它会让
    // 每次落盘都把演化起点往后挪，精力衰减会被算丢一截。
    const requestedUpdatedAt = normalizeInstant(state.updatedAt, 'updatedAt')
    const lastInteractAt = requireEpochMs(state.lastInteractAt, 'lastInteractAt')
    const lastProactiveAt = requireEpochMs(state.lastProactiveAt, 'lastProactiveAt')

    return queue.write(
      (txh) => {
        const stamp = clock.stamp()
        const updatedAt = requestedUpdatedAt ?? stamp.utc
        const existing = txh.get('SELECT 1 AS ok FROM fox_state WHERE id = ?', [FOX_STATE_ID])
        const createdAt = requestedCreatedAt ?? stamp.utc
        txh.run(
          `INSERT INTO fox_state (
             id, version, mood, energy, bond,
             created_at, created_at_local, updated_at, updated_at_local,
             last_interact_at, last_proactive_at, deletion_epoch
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT(id) DO UPDATE SET
             version = excluded.version,
             mood = excluded.mood,
             energy = excluded.energy,
             bond = excluded.bond,
             updated_at = excluded.updated_at,
             updated_at_local = excluded.updated_at_local,
             last_interact_at = excluded.last_interact_at,
             last_proactive_at = excluded.last_proactive_at`,
          [
            FOX_STATE_ID, version, mood, energy, bond,
            // created_at 只在**首次插入**那次落定；更新分支的 SET 里没有这一列，
            // 所以重复 save 不会把「这份状态第一次进主账的时刻」刷掉。
            createdAt, localOf(createdAt),
            updatedAt, localOf(updatedAt),
            lastInteractAt, lastProactiveAt,
          ],
        )
        return { created: existing === undefined, updatedAt }
      },
      { label: 'mood.saveState' },
    )
  }

  /**
   * 追加一条情感事件。
   *
   * **幂等键是 `(at, kind)`**：同一毫秒的同类事件视为同一次记账，重复写返回既有 id、
   * `created: false`。为什么按这个键：迁移脚本会反复跑、插件可能重放一回合；
   * 而「同一毫秒发生两次同一种情绪」在真实调用里几乎不可能（`Date.now()` 毫秒级），
   * 真出现了也是同一个动作被记了两遍。
   *
   * @param {{
   *   at: number | string | Date,
   *   kind: string,
   *   note?: string | null,
   *   delta?: Record<string, number> | null,
   *   sourceSystem?: string | null,
   * }} input
   * @returns {Promise<{ id: string, created: boolean }>}
   */
  async function appendEvent(input = /** @type {any} */ ({})) {
    const at = requireEpochMs(input.at, 'at')
    if (at === null) throw new BrainError('INVALID_ARGUMENT', 'at 必填')
    const rawKind = requireString(input.kind, 'kind').trim()
    if (rawKind.length > MAX_KIND_LENGTH) {
      throw new BrainError('INVALID_ARGUMENT', `kind 太长（${rawKind.length} > ${MAX_KIND_LENGTH}）：${rawKind.slice(0, 20)}…`)
    }
    const note = input.note === undefined || input.note === null
      ? null
      : String(input.note).slice(0, MAX_NOTE_LENGTH)
    const deltaJson = stringifyDelta(input.delta, 'delta')
    const sourceSystem = input.sourceSystem == null ? DEFAULT_SOURCE_SYSTEM : String(input.sourceSystem)

    return queue.write(
      (txh) => {
        const existing = txh.get('SELECT id FROM fox_events WHERE at = ? AND kind = ?', [at, rawKind])
        if (existing !== undefined) return { id: String(existing.id), created: false }
        const stamp = clock.stamp()
        const id = newId('fev')
        txh.run(
          `INSERT INTO fox_events (
             id, at, kind, note, delta_json, source_system,
             created_at, created_at_local, deletion_epoch
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [id, at, rawKind, note, deltaJson, sourceSystem, stamp.utc, stamp.local],
        )
        return { id, created: true }
      },
      { label: 'mood.appendEvent' },
    )
  }

  /**
   * 列事件，**新 → 旧**（`at DESC, id DESC`）。
   *
   * 排序带 `id DESC` 不是装饰：同一毫秒的多条事件若只按 `at` 排，
   * SQLite 不保证稳定顺序，两次查询可能给出不同结果——面板会「跳」。
   *
   * @param {{ limit?: number, since?: number | string | null, kind?: string | null }} [query]
   * @returns {{ items: any[], limit: number }}
   */
  function listEvents(query = {}) {
    const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_EVENT_LIMIT, 1), MAX_EVENT_LIMIT)
    /** @type {string[]} */
    const where = []
    /** @type {any[]} */
    const params = []
    if (query.since !== undefined && query.since !== null && query.since !== '') {
      const since = requireEpochMs(query.since, 'since')
      where.push('at >= ?')
      params.push(since)
    }
    if (query.kind !== undefined && query.kind !== null && query.kind !== '') {
      where.push('kind = ?')
      params.push(requireString(query.kind, 'kind'))
    }
    params.push(limit)
    const sql = `SELECT * FROM fox_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY at DESC, id DESC LIMIT ?`
    return {
      items: tx.all(sql, params).map((row) => rowToEvent(/** @type {any} */ (row))),
      limit,
    }
  }

  /**
   * 只保留最近 `keep` 条事件，删掉更旧的。返回删了几条。
   *
   * 为什么要有这个入口：事件表是**唯一会无限增长**的情感数据（状态行永远一行）。
   * 但插件当前不自动调它——「什么该忘」需要有依据，不能靠一个随手写的阈值。
   * 这里是显式入口，由 CLI / 维护脚本在看过 `stats()` 之后决定。
   *
   * @param {{ keep?: number }} [query]
   * @returns {Promise<{ removed: number, keep: number }>}
   */
  async function pruneEvents(query = {}) {
    const keep = clampInt(query.keep, 1, 1_000_000, DEFAULT_EVENT_KEEP, 'keep')
    return queue.write(
      (txh) => {
        const result = txh.run(
          `DELETE FROM fox_events
            WHERE id NOT IN (SELECT id FROM fox_events ORDER BY at DESC, id DESC LIMIT ?)`,
          [keep],
        )
        return { removed: Number(result.changes ?? 0), keep }
      },
      { label: 'mood.pruneEvents' },
    )
  }

  /**
   * 统计。
   * @returns {{ events: number, oldestAt: number | null, newestAt: number | null }}
   */
  function stats() {
    const row = tx.get('SELECT count(*) AS c, min(at) AS lo, max(at) AS hi FROM fox_events')
    return {
      events: Number(row?.c ?? 0),
      oldestAt: row?.lo == null ? null : Number(row.lo),
      newestAt: row?.hi == null ? null : Number(row.hi),
    }
  }

  return {
    getState,
    saveState,
    appendEvent,
    listEvents,
    pruneEvents,
    stats,
    MAX_NOTE_LENGTH,
    DEFAULT_EVENT_LIMIT,
    DEFAULT_EVENT_KEEP,
  }
}
