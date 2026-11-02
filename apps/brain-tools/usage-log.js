// @ts-check
/**
 * 外置大脑 · 使用统计（usage log）
 *
 * 记录每一次检索「实际发生了什么」：谁查的、查了什么、命中几条、走的是主路还是弱路、
 * 诊断说什么、花了多少毫秒。没有这份数据，就没法回答 ROADMAP 里那个卡住进度的
 * 问题——「检索到底准不准，能不能卸掉灵枢/Engram」。搬过来 ≠ 用得好。
 *
 * ── 为什么是 append-only JSONL，而不是写进 SQLite 主账 ──
 *
 * 1. 它是**观测数据**不是记忆数据。主账只有一条写入路径，每次写都要过事务 + outbox +
 *    幂等摄取，是给「必须可回滚、可溯源的人类事实」准备的。观测数据量比记忆大一个量级，
 *    混进去会拖慢主账，还会污染备份/恢复/删除账本的口径（删一条记忆不该牵扯使用日志）。
 * 2. 追加式 JSONL 天然 append-only：损坏一行不影响其余，能直接 tail，能按天切分，
 *    过期直接删文件——不需要走删除账本那一套。
 * 3. 它必须**永远不能影响被观测的行为**。这是项目里「工具失败不阻塞对话」那条纪律
 *    再往下延一层：写日志失败，检索照样返回。
 *
 * ── 边界（诚实清单）──
 *
 * - **不记录「这次命中是否真的被后续回答用上」**。那需要看模型下一步说了什么，
 *   工具层拿不到；硬猜会得出漂亮但假的数据。这里留 `usedLater: null` 和
 *   `usedLaterWhy` 字段，等 M5 有 turn/end 钩子再补。
 * - **不记录命中正文**，只记 memoryId。日志里不该有记忆内容副本（隐私 + 体积）。
 * - **query 是主人原话**，属私密。日志只落在本机 `data/logs/`，控制台同源同端口展示，
 *   不进任何外部通道。写库前把长度裁到 200 字。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** 单条 query 进日志前的最长字数（防止有人把整篇文档塞进来） */
export const MAX_QUERY_CHARS = 200
/** 单条记录里保留的命中 id 上限 */
export const MAX_HIT_IDS = 20
/** 读日志时的尾读上限：16 MB。超过只读尾部，坏行会被跳过。 */
export const MAX_READ_BYTES = 16 * 1024 * 1024
/** 默认统计窗口（天） */
export const DEFAULT_WINDOW_DAYS = 7

/**
 * 把任意值截成安全字符串。
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null}
 */
function clip(value, max) {
  if (value == null) return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > max ? text.slice(0, max) + '…' : text
}

/**
 * 把「可能是 null / 空串 / 数字 / 数字字符串」的值收成 number|null。
 *
 * 为什么要专门一个函数（这是实机踩到的坑）：
 * `Number(null) === 0` 且 `Number.isFinite(0) === true`，所以
 * `Number.isFinite(Number(v))` 会把「没提供」误判成 **0**。
 * 日志要经过「写盘 → 读回 → 再规范化」，这个误判会让 `durationMs: null`
 * 读回来变成 `0`，于是「根本没有耗时数据」的记录以 0ms 混进 timing 的
 * p50/p95/avg——统计照样能算，数字是假的。
 *
 * @param {unknown} value
 * @returns {number|null}
 */
function toNumber(value) {
  if (value == null || value === '') return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

/**
 * 把一条原始记录规范化成固定形状。
 * 为什么不让调用方直接 JSON.stringify：日志是长期资产，字段形状必须由这里说了算，
 * 否则半年后各种形状混在一起，聚合逻辑会变成一堆防御性判断。
 *
 * `channel` 的三个取值是有意分开的（2026-10-30 深夜补）：
 * - `tool`   模型主动检索
 * - `console` 人在控制台检索
 * - `write`  **写入/遗忘**（brain_remember / brain_forget）
 *   之前只有前两个，于是「查了几次」有数、「记了几次/忘了几次」只能事后倒推
 *   producer 字段和账本文件——写入侧连一次调用都没有留痕，那不是观测，是盲区。
 *   query 对写入恒为 null：记忆正文不进使用日志（隐私），要分的类型放 op。
 *
 * @param {Record<string, any>} raw
 * @param {number} [now]
 * @returns {{
 *   ts: string, at: number, channel: 'tool'|'console'|'write'|'unknown', op: string|null,
 *   query: string|null, limit: number|null, asOf: string|null, ok: boolean, code: string|null,
 *   hitCount: number, hitIds: string[], status: string|null,
 *   primaryLaneHit: boolean|null, degraded: string|null, durationMs: number|null,
 *   sessionId: string|null, usedLater: null, usedLaterWhy: string
 * }}
 */
export function normalizeUsageEntry(raw, now = Date.now()) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const channelInput = typeof source.channel === 'string' ? source.channel : 'unknown'
  const channel = channelInput === 'tool' || channelInput === 'console' || channelInput === 'write'
    ? channelInput
    : 'unknown'
  const hitIdsRaw = Array.isArray(source.hitIds) ? source.hitIds : []
  const hitIds = hitIdsRaw
    .filter((id) => typeof id === 'string' && id.length > 0)
    .slice(0, MAX_HIT_IDS)
  const at = toNumber(source.at)
  const limit = toNumber(source.limit)
  const hitCount = toNumber(source.hitCount)
  const duration = toNumber(source.durationMs)
  return {
    ts: typeof source.ts === 'string' && source.ts ? source.ts : new Date(now).toISOString(),
    at: at == null ? now : at,
    channel,
    // 写入侧的类型（remember 的 kind / forget）。检索侧恒为 null。
    op: clip(source.op, 20),
    query: clip(source.query, MAX_QUERY_CHARS),
    limit,
    asOf: clip(source.asOf, 40),
    ok: source.ok !== false,
    code: clip(source.code, 60),
    hitCount: hitCount == null ? 0 : Math.max(0, hitCount),
    hitIds,
    status: clip(source.status, 40),
    primaryLaneHit: typeof source.primaryLaneHit === 'boolean' ? source.primaryLaneHit : null,
    degraded: clip(source.degraded, 80),
    durationMs: duration == null ? null : Math.max(0, duration),
    sessionId: clip(source.sessionId, 80),
    // 见文件头「边界」：不是漏做，是刻意留空。
    usedLater: null,
    usedLaterWhy: '工具层看不到后续回答，无法判定是否被真正用上；等 turn/end 钩子补',
  }
}

/**
 * 追加一条使用记录。**永不抛**。
 * @param {string} logPath
 * @param {Record<string, any>} entry
 * @param {number} [now]
 * @returns {{ ok: boolean, error?: string }}
 */
export function appendUsage(logPath, entry, now = Date.now()) {
  try {
    if (typeof logPath !== 'string' || !logPath) throw new Error('logPath 为空')
    const line = JSON.stringify(normalizeUsageEntry(entry, now))
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, line + '\n', 'utf8')
    return { ok: true }
  } catch (error) {
    // 观测失败不能改变被观测行为：吞掉，最多在宿主 stderr 留一行
    const message = error instanceof Error ? error.message : String(error)
    console.error('[brain-usage] 使用日志写入失败（已忽略，不影响检索）:', message)
    return { ok: false, error: message }
  }
}

/**
 * 解析日志文本。坏行跳过并计数——一行坏了不该让整份统计失效。
 * @param {string} text
 * @returns {{ entries: any[], skipped: number }}
 */
export function parseUsageLines(text) {
  /** @type {any[]} */
  const entries = []
  let skipped = 0
  if (typeof text !== 'string' || !text) return { entries, skipped }
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries.push(normalizeUsageEntry(parsed))
      } else {
        skipped += 1
      }
    } catch {
      skipped += 1
    }
  }
  return { entries, skipped }
}

/**
 * 读日志。文件不存在 → 空结果（不是错误：还没人查过）。
 * @param {string} logPath
 * @param {{ limit?: number, since?: number, maxBytes?: number }} [opts]
 * @returns {{ entries: any[], total: number, skipped: number, exists: boolean, truncated: boolean, logPath: string }}
 */
export function readUsageLog(logPath, opts = {}) {
  const empty = { entries: [], total: 0, skipped: 0, exists: false, truncated: false, logPath }
  try {
    if (typeof logPath !== 'string' || !logPath) return empty
    const stat = statSync(logPath)
    if (!stat.isFile()) return empty
    const maxBytes = Number(opts.maxBytes) || MAX_READ_BYTES
    const truncated = stat.size > maxBytes
    // 大文件只读尾部：使用日志是「最近发生了什么」，越老越不重要
    const buffer = readFileSync(logPath)
    const slice = truncated ? buffer.subarray(buffer.length - maxBytes) : buffer
    let text = slice.toString('utf8')
    if (truncated) {
      // 尾部截断会让第一行是半截 JSON，丢掉它
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    const parsed = parseUsageLines(text)
    let entries = parsed.entries
    if (Number.isFinite(opts.since)) {
      const since = Number(opts.since)
      entries = entries.filter((e) => Number(e.at) >= since)
    }
    const total = entries.length
    if (Number.isFinite(opts.limit) && Number(opts.limit) > 0) {
      entries = entries.slice(-Number(opts.limit))
    }
    return { entries, total, skipped: parsed.skipped, exists: true, truncated, logPath }
  } catch {
    return empty
  }
}

/**
 * 本地日期键（YYYY-MM-DD）。用本地时区而不是 toISOString——
 * UTC 会把人晚上 8 点以后的检索算到「第二天」，看起来像每天数据都对不上。
 * @param {number} at
 * @returns {string}
 */
function localDayKey(at) {
  const d = new Date(at)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * @param {number[]} sorted 已升序
 * @param {number} q 0–1
 */
function percentile(sorted, q) {
  if (sorted.length === 0) return null
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))
  return sorted[idx]
}

/**
 * 聚合。纯函数，不碰文件系统——测试和真机走同一段逻辑。
 *
 * @param {any[]} entries 已规范化的记录（正常化由 readUsageLog/normalizeUsageEntry 保证）
 * @param {{ now?: number, windowDays?: number }} [opts]
 * @returns {any}
 */
export function summarizeUsage(entries, opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now()
  const windowDays = Number.isFinite(opts.windowDays) && Number(opts.windowDays) > 0
    ? Number(opts.windowDays)
    : DEFAULT_WINDOW_DAYS
  const since = now - windowDays * 24 * 60 * 60 * 1000

  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && typeof e === 'object' && Number(e.at) >= since,
  )

  /** @type {Record<string, number>} */
  const byChannel = {}
  /** @type {Record<string, number>} */
  const byOp = {}
  /** @type {Record<string, number>} */
  const byStatus = {}
  /** @type {Map<string, { query: string, count: number, okCount: number, hits: number, zero: number, failed: number, lastAt: number }>} */
  const queryMap = new Map()
  /** @type {Map<string, { date: string, count: number, okCount: number, hits: number, zero: number, failed: number }>} */
  const dayMap = new Map()
  /** @type {Set<string>} */
  const touchedIds = new Set()
  /** @type {number[]} */
  const durations = []

  let okCount = 0
  let failCount = 0
  let hitCount = 0
  let zeroHitCount = 0
  let degradedCount = 0
  let laneMissCount = 0
  /** 检索类调用数（tool + console）。命中率的分母只能用这个，见循环里的注释。 */
  let retrievalCount = 0
  let retrievalOkCount = 0
  let lastAt = 0

  for (const e of list) {
    const at = Number(e.at) || 0
    if (at > lastAt) lastAt = at
    const channel = e.channel || 'unknown'
    byChannel[channel] = (byChannel[channel] || 0) + 1
    const status = e.status || (e.ok === false ? 'error' : 'unknown')
    byStatus[status] = (byStatus[status] || 0) + 1

    const isOk = e.ok !== false
    if (isOk) okCount += 1
    else failCount += 1

    // 「写了几次、忘了几次」和「查了几次」是两种调用，不能混进同一套指标：
    // 写入成功一次不等于「命中一次」，混进命中率分母会把命中率算成好看但没意义的数。
    // 只有显式的 `write` 通道被排除在检索指标之外；老日志没有 channel 字段
    // （normalize 成 unknown）仍按检索计——向后兼容，不能让历史数据因为加字段而消失。
    const isRetrieval = channel !== 'write'
    if (!isRetrieval) {
      if (typeof e.op === 'string' && e.op) byOp[e.op] = (byOp[e.op] || 0) + 1
      const day = localDayKey(at)
      const curDay = dayMap.get(day) || { date: day, count: 0, okCount: 0, hits: 0, zero: 0, failed: 0 }
      curDay.count += 1
      if (isOk) curDay.okCount += 1
      else curDay.failed += 1
      dayMap.set(day, curDay)
      continue
    }

    retrievalCount += 1
    if (isOk) retrievalOkCount += 1

    const hits = Number(e.hitCount) || 0
    // 命中 / 零命中**只统计跑完的检索**。
    // 检索报错（超时、库坏、参数错）是系统问题，不是「查了没有」——
    // 混进来会让零命中榜变成故障榜，把真正的语料缺口盖掉，
    // 而这页的全部意义就是找语料缺口。
    if (isOk) {
      if (hits > 0) hitCount += 1
      else zeroHitCount += 1
    }

    if (isOk && typeof e.primaryLaneHit === 'boolean' && e.primaryLaneHit === false) laneMissCount += 1
    if (e.degraded) degradedCount += 1

    // 不能写成 Number.isFinite(Number(e.durationMs))：Number(null) === 0，
    // 会把「没有耗时数据」的记录当成 0ms 混进分位数（见 toNumber 的注释）。
    const duration = toNumber(e.durationMs)
    if (duration != null) durations.push(Math.max(0, duration))

    for (const id of Array.isArray(e.hitIds) ? e.hitIds : []) {
      if (typeof id === 'string') touchedIds.add(id)
    }

    const qKey = e.query || null
    if (qKey) {
      const cur = queryMap.get(qKey) ||
        { query: qKey, count: 0, okCount: 0, hits: 0, zero: 0, failed: 0, lastAt: 0 }
      cur.count += 1
      if (isOk) {
        cur.okCount += 1
        if (hits > 0) cur.hits += 1
        else cur.zero += 1
      } else {
        cur.failed += 1
      }
      if (at > cur.lastAt) cur.lastAt = at
      queryMap.set(qKey, cur)
    }

    const day = localDayKey(at)
    const curDay = dayMap.get(day) || { date: day, count: 0, okCount: 0, hits: 0, zero: 0, failed: 0 }
    curDay.count += 1
    if (isOk) {
      curDay.okCount += 1
      if (hits > 0) curDay.hits += 1
      else curDay.zero += 1
    } else {
      curDay.failed += 1
    }
    dayMap.set(day, curDay)
  }

  const total = list.length
  const sorted = durations.slice().sort((a, b) => a - b)
  const avg = sorted.length
    ? Math.round((sorted.reduce((s, v) => s + v, 0) / sorted.length) * 10) / 10
    : null

  const topQueries = [...queryMap.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, 10)
    .map((q) => ({ query: q.query, count: q.count, hits: q.hits, zero: q.zero, failed: q.failed, lastAt: q.lastAt }))

  // 零命中榜只收「查了、跑完了、真没命中」的词。
  // 失败过的词不进榜——那是故障线索，混进语料缺口清单会带偏结论。
  const zeroHitQueries = [...queryMap.values()]
    .filter((q) => q.okCount > 0 && q.hits === 0)
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, 10)
    .map((q) => ({ query: q.query, count: q.okCount, failed: q.failed, lastAt: q.lastAt }))

  const byDay = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1))

  return {
    windowDays,
    since,
    now,
    total,
    okCount,
    failCount,
    hitCount,
    zeroHitCount,
    /**
     * 命中率：分母是**跑完的检索**（okCount），不是全部调用。
     * 检索报错是可靠性问题，混进分母会让命中率跟着故障率跳，看不出检索质量。
     * 要含失败的保守口径，看 callHitRate。
     */
    hitRate: retrievalOkCount > 0 ? Math.round((hitCount / retrievalOkCount) * 1000) / 1000 : null,
    /** 保守口径：命中次数 / 全部检索调用次数（含失败）。 */
    callHitRate: retrievalCount > 0 ? Math.round((hitCount / retrievalCount) * 1000) / 1000 : null,
    byChannel,
    /** 写入/遗忘的类型分布（remember 的 kind、forget）。检索侧不进这里。 */
    byOp,
    /** 检索类调用数（tool + console）与全部调用数的差额就是写入/遗忘。 */
    retrievalCount,
    byStatus,
    degradedCount,
    degradedRate: retrievalOkCount > 0 ? Math.round((degradedCount / retrievalOkCount) * 1000) / 1000 : null,
    /** 主路没命中、靠弱检索救回来的次数。这是最危险的静默降级指标。 */
    laneMissCount,
    laneMissRate: retrievalOkCount > 0 ? Math.round((laneMissCount / retrievalOkCount) * 1000) / 1000 : null,
    timing: {
      avg,
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.length ? sorted[sorted.length - 1] : null,
      samples: sorted.length,
    },
    topQueries,
    zeroHitQueries,
    byDay,
    lastAt: lastAt || null,
    /** 本窗口内被命中过的记忆 id（去重）。用来算「哪些记忆从来没被查到过」。 */
    touchedIds: [...touchedIds],
    touchedCount: touchedIds.size,
  }
}

/**
 * 覆盖率：全量记忆里有多少条在这个窗口内被命中过。
 * 「从来没被查到」不等于「没用」——迁进来的 205 条里，很多本来就只在特定语境下才该被想起。
 * 所以这里只给事实和候选清单，不下结论。
 *
 * @param {{ totalMemories: number, touchedIds: string[], catalog: Array<{ id: string, summary?: string|null, type?: string|null, importance?: number|null }> }} input
 * @param {{ sampleLimit?: number }} [opts]
 */
export function computeCoverage(input, opts = {}) {
  const totalMemories = Math.max(0, Number(input.totalMemories) || 0)
  const touchedAll = new Set(Array.isArray(input.touchedIds) ? input.touchedIds : [])
  const catalog = Array.isArray(input.catalog) ? input.catalog : []
  const sampleLimit = Number.isFinite(opts.sampleLimit) ? Number(opts.sampleLimit) : 20
  // 分子只算「现在还在库里、还能被检索到」的 id。
  // 历史命中里会留着已封口（superseded）或已换 scope 的 id——把它们算进覆盖率会让
  // 覆盖率虚高、同时让「从没被查到」偏小，两边都失真。差出来的条数单列成 staleTouched，
  // 不藏起来（口径要能自查）。
  const catalogIds = new Set(catalog.filter((m) => m && typeof m.id === 'string').map((m) => m.id))
  const touched = new Set([...touchedAll].filter((id) => catalogIds.has(id)))
  const staleTouched = touchedAll.size - touched.size
  const neverHit = catalog.filter((m) => m && typeof m.id === 'string' && !touched.has(m.id))
  return {
    totalMemories,
    touched: touched.size,
    staleTouched,
    neverHit: Math.max(0, totalMemories - touched.size),
    touchedRate: totalMemories > 0 ? Math.round((touched.size / totalMemories) * 1000) / 1000 : null,
    /** 按重要度从高到低取前 N 条从没被查到的——重要却从没人查，才是真信号 */
    neverHitSamples: neverHit
      .slice()
      .sort((a, b) => (toNumber(b.importance) ?? 0) - (toNumber(a.importance) ?? 0))
      .slice(0, sampleLimit)
      .map((m) => ({
        memoryId: m.id,
        summary: m.summary || null,
        type: m.type || null,
        importance: toNumber(m.importance),
      })),
  }
}
