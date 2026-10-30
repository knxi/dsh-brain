// @ts-check
/**
 * used-later.js — 「这次命中，被回答用上了吗？」(M4.6)
 *
 * ── 为什么需要独立一层 ──
 *
 * `brain_search` 的 execute 拿不到后续回答（工具在模型说话之前就跑完了），所以
 * usage.jsonl 里 `usedLater` 只能留 null（CONTRACTS 12.5）。判定必须发生在
 * **`session/event` 的 `turn/end`**：那一刻本回合的 assistant 最终文本已经定了，
 * 而索引/检索已经关掉（CONTRACTS 10.8 实测：turn/end 时 searchEvents 直接
 * `SESSION_QUERY_INDEX_FAILED: index closed`），所以判定**只用内存缓存**。
 *
 * ── 判据（严格，不猜）──
 *
 * 只有当 assistant 最终文本里出现**某条命中记忆正文的连续 ≥ 12 字原文片段**时，
 * 才记 `usedLater: true` + `evidence: 'quote'`。
 *
 * - 没引用原文 → 记 `usedLater: null`（未判定），**绝不记 false**。
 *   模型把记忆改写成自己的话、只用其中语义、或者压根没用，从文本上分不开；
 *   记 false 等于把「测不到」谎报成「没用上」。
 * - **禁止语义猜测、禁止代理指标**：不许用「同一会话又查了同一个词」「回答里出现
 *   了关键词」这类凑数（CONTRACTS 12.5 明令）。那会得出漂亮但假的数据，而这份数据
 *   是用来判断「能不能卸掉灵枢/Engram」的。
 * - 12 字是权衡：再短（如 6 字）会把「铝板」「踢脚线」这种通用词命中当引用，
 *   假阳性高；再长（如 24 字）会漏掉合理摘引。取 12 是「一句完整短语」的下限。
 *
 * ── 隐私边界 ──
 *
 * **日志里不落记忆正文、也不落 assistant 文本的片段**。只记 `quoteLen`（长度）
 * 和 `quoteHash`（sha256 前 8 位）——它能证明「确实引用了这段原文」，但不复制内容。
 * query 照旧只在本机 data/logs 落盘（与 usage.jsonl 同一条纪律）。
 *
 * ── 副作用纪律 ──
 *
 * 本模块所有对外函数**永不抛**：append 吞错，handler 顶层 try/catch。
 * 抛错会让宿主 turn/end 变成 reason=error，直接污染主人回合（CONTRACTS 10.2）。
 */

import { appendFileSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { createHash } from 'node:crypto'

import { MAX_QUERY_CHARS, MAX_READ_BYTES } from './usage-log.js'

/**
 * 引用判定所需的最小连续原文长度（code unit 计）。
 * 中文 1 字 = 1 code unit；emoji / 生僻字（代理对）会按 2 个计——对「≥12」这个
 * 下限没有实质影响，但别把 12 理解成「12 个视觉字符」的精确等号。
 */
export const MIN_QUOTE_CHARS = 12

/**
 * sidecar 默认落点（生产）。测试/冒烟**必须**显式传临时路径：
 * 合成数据写进观察期日志比没有统计更糟（CONTRACTS 12.1 / 12.39 同一条纪律）。
 */
export const DEFAULT_USED_LATER_LOG = 'E:/ds-h/dsh-brain/data/logs/used-later.jsonl'

/** 一个会话最多缓存多少个未判定的会话（超出驱逐最旧）。 */
export const MAX_SESSIONS = 32
/** 单个会话最多缓存多少次未判定的检索（超出丢最旧）。 */
export const MAX_SEARCHES_PER_SESSION = 8
/** 一次检索最多缓存多少条命中的正文（超出不判定，不截断成假数据）。 */
export const MAX_HITS_PER_SEARCH = 20
/** 单条命中正文最多缓存多少字（超长只取前 N 字，判定基准仍算"原文"）。 */
export const MAX_CONTENT_CHARS = 2000

/** must-never-false 的字段在 normalize 处再兜一层：false 一律落 null。 */
const USED_LATER_WHY = Object.freeze({
  NO_HITS: 'no_hits',
  NO_ASSISTANT_TEXT: 'no_assistant_text',
  NO_CONTENT_CACHED: 'no_content_cached',
  NO_QUOTE_IN_ANSWER: 'no_quote_in_answer',
  NO_TURN_END: 'no_turn_end',
})

/**
 * 把文本规范化成判定用形态：所有空白（含换行/全角空格）折叠成一个半角空格。
 *
 * 为什么折叠：assistant 回答和记忆正文里的换行位置几乎不可能一致，
 * 不做折叠等于「跨行的原文永远判不出来」，引用率会被系统性低估。
 * 折叠后仍要求字符序列连续——**不做**去空格/去标点的模糊匹配：
 * 那会引入假阳性，而假阳性比漏判更糟（会让人以为记忆被用上了）。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function normalizeQuoteText(text) {
  if (text === null || text === undefined) return ''
  return String(text).replace(/\s+/g, ' ').trim()
}

/**
 * @param {string} text
 * @returns {string} sha256 前 8 位（十六进制）
 */
function shortHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)
}

/**
 * 在回答里找「命中记忆正文的连续原文片段」。
 *
 * 算法：把正文按 MIN_QUOTE_CHARS 长度滑窗，任一窗口在回答里出现过即算命中；
 * 命中后向两侧扩展，求出**最长连续匹配**的长度。只返回第一处命中（同一条记忆
 * 被引用两次不重复计数——引用率按「条」算，不按「处」算）。
 *
 * 复杂度：正文 ≤ MAX_CONTENT_CHARS（2000）× 窗口 indexOf，最坏 ~2000 次字符串查找；
 * 一次 turn/end 最多 8 次检索 × 20 条命中，实际远低于上限，且发生在回合边界，
 * 不阻塞对话流。
 *
 * @param {unknown} assistantText
 * @param {unknown} memoryContent
 * @returns {{ quoteLen: number, quoteHash: string } | null}
 */
export function findQuote(assistantText, memoryContent) {
  const answer = normalizeQuoteText(assistantText)
  const memory = normalizeQuoteText(memoryContent)
  if (answer.length < MIN_QUOTE_CHARS || memory.length < MIN_QUOTE_CHARS) return null

  const width = MIN_QUOTE_CHARS
  for (let i = 0; i + width <= memory.length; i += 1) {
    const probe = memory.slice(i, i + width)
    const at = answer.indexOf(probe)
    if (at < 0) continue

    // 向两侧扩展：记录「最长连续原文」而不是「刚好 12 字」。
    // 扩展只做相等比较，不做任何容错——容错就是猜测。
    let memoryStart = i
    let answerStart = at
    while (
      memoryStart > 0 &&
      answerStart > 0 &&
      memory[memoryStart - 1] === answer[answerStart - 1]
    ) {
      memoryStart -= 1
      answerStart -= 1
    }
    let memoryEnd = i + width
    let answerEnd = at + width
    while (
      memoryEnd < memory.length &&
      answerEnd < answer.length &&
      memory[memoryEnd] === answer[answerEnd]
    ) {
      memoryEnd += 1
      answerEnd += 1
    }

    const quote = memory.slice(memoryStart, memoryEnd)
    return { quoteLen: quote.length, quoteHash: shortHash(quote) }
  }
  return null
}

/**
 * 把一次检索 + 该回合最终回答，判成「每行一条」的证据记录。
 *
 * 输出契约（每个元素 = sidecar 里的一行）：
 * - 命中了 N 条 → N 行（每行一个 memoryId，`memoryIdsCount` 都是 N）；
 * - 一次检索 0 命中 → 1 行占位（memoryId=null，`usedLaterWhy='no_hits'`），
 *   这样「查了但没找到」也能被观察到，而不是从统计里消失。
 *
 * **每一行的 usedLater 只可能是 true 或 null**，不存在 false。
 *
 * @param {{
 *   assistantText?: string,
 *   searches?: Array<{ query?: string|null, turn?: number|null, channel?: string|null, at?: number|null,
 *     hits?: Array<{ memoryId?: string|null, content?: string|null }> }>,
 *   now?: number,
 * }} input
 * @returns {any[]}
 */
export function judgeTurn(input) {
  const assistantText = typeof input?.assistantText === 'string' ? input.assistantText : ''
  const searches = Array.isArray(input?.searches) ? input.searches : []
  const fallbackNow = Number.isFinite(input?.now) ? Number(input.now) : Date.now()

  /** @type {any[]} */
  const entries = []

  for (const search of searches) {
    const query = clipText(search?.query, MAX_QUERY_CHARS)
    const channel = typeof search?.channel === 'string' && search.channel ? search.channel : 'tool'
    const sessionId = clipText(search?.sessionId, 80)
    const turn = typeof search?.turn === 'number' && Number.isFinite(search.turn) ? search.turn : null
    const at = Number.isFinite(search?.at) ? Number(search.at) : fallbackNow
    const hits = Array.isArray(search?.hits) ? search.hits : []

    /** @param {Record<string, any>} patch */
    const base = (patch) => ({
      ts: new Date(at).toISOString(),
      at,
      channel,
      sessionId,
      turn,
      query,
      memoryIdsCount: hits.length,
      memoryId: null,
      usedLater: null,
      evidence: null,
      quoteLen: null,
      quoteHash: null,
      usedLaterWhy: null,
      ...patch,
    })

    if (hits.length === 0) {
      entries.push(base({ usedLaterWhy: USED_LATER_WHY.NO_HITS }))
      continue
    }

    for (const hit of hits) {
      const memoryId = typeof hit?.memoryId === 'string' && hit.memoryId ? hit.memoryId : null
      if (memoryId === null) continue

      if (!assistantText) {
        // 宿主没给 assistant 文本：判不了，就如实说判不了（不猜、不算作没引用）。
        entries.push(base({ memoryId, usedLaterWhy: USED_LATER_WHY.NO_ASSISTANT_TEXT }))
        continue
      }

      const content = typeof hit?.content === 'string' ? hit.content : ''
      if (!content) {
        // 正文没缓存上（读库失败/被删除）：同样是「判不了」，不是「没引用」。
        entries.push(base({ memoryId, usedLaterWhy: USED_LATER_WHY.NO_CONTENT_CACHED }))
        continue
      }

      const quote = findQuote(assistantText, content)
      if (quote !== null) {
        entries.push(base({
          memoryId,
          usedLater: true,
          evidence: 'quote',
          quoteLen: quote.quoteLen,
          quoteHash: quote.quoteHash,
          usedLaterWhy: null,
        }))
      } else {
        entries.push(base({ memoryId, usedLaterWhy: USED_LATER_WHY.NO_QUOTE_IN_ANSWER }))
      }
    }
  }

  return entries
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string|null}
 */
function clipText(value, max) {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > max ? text.slice(0, max) + '…' : text
}

/**
 * 把一条证据记录规范化成固定形状（落盘前唯一入口）。
 *
 * 这里再强制一次「禁止 false」：不管调用方传什么，`usedLater` 只可能 true / null。
 * 口径错了不会报错，只会让统计悄悄变假——所以在落盘的最外层加锁，而不是相信调用方。
 *
 * @param {Record<string, any>} raw
 * @param {number} [now]
 * @returns {Record<string, any>}
 */
export function normalizeUsedLaterEntry(raw, now = Date.now()) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const usedLater = source.usedLater === true ? true : null
  const at = Number.isFinite(source.at) ? Number(source.at) : now
  const memoryId = typeof source.memoryId === 'string' && source.memoryId ? source.memoryId : null
  const evidence = usedLater === true && typeof source.evidence === 'string' ? source.evidence : null
  const quoteLen = usedLater === true && Number.isFinite(source.quoteLen) ? Math.max(0, Number(source.quoteLen)) : null
  const quoteHash = usedLater === true && typeof source.quoteHash === 'string' && source.quoteHash
    ? source.quoteHash
    : null
  const memoryIdsCount = Number.isFinite(source.memoryIdsCount) ? Math.max(0, Number(source.memoryIdsCount)) : 0
  const turn = Number.isFinite(source.turn) ? Number(source.turn) : null

  return {
    ts: typeof source.ts === 'string' && source.ts ? source.ts : new Date(at).toISOString(),
    at,
    channel: typeof source.channel === 'string' && source.channel ? source.channel : 'tool',
    sessionId: clipText(source.sessionId, 80),
    turn,
    query: clipText(source.query, MAX_QUERY_CHARS),
    memoryIdsCount,
    memoryId,
    usedLater,
    evidence,
    quoteLen,
    quoteHash,
    usedLaterWhy: usedLater === true
      ? null
      : (typeof source.usedLaterWhy === 'string' && source.usedLaterWhy ? source.usedLaterWhy : 'unknown'),
  }
}

/**
 * 追加一行证据。**永不抛**（观测失败不能改变被观测行为）。
 * @param {string} logPath
 * @param {Record<string, any>} entry
 * @param {number} [now]
 * @returns {{ ok: boolean, error?: string }}
 */
export function appendUsedLater(logPath, entry, now = Date.now()) {
  try {
    if (typeof logPath !== 'string' || !logPath) throw new Error('logPath 为空')
    const line = JSON.stringify(normalizeUsedLaterEntry(entry, now))
    mkdirSync(dirname(logPath), { recursive: true })
    appendFileSync(logPath, line + '\n', 'utf8')
    return { ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error('[brain-used-later] 证据写入失败（已忽略，不影响对话）:', message)
    return { ok: false, error: message }
  }
}

/**
 * 解析 sidecar 文本。坏行跳过并计数（一行坏了不该让整份统计失效）。
 * @param {string} text
 * @returns {{ entries: any[], skipped: number }}
 */
export function parseUsedLaterLines(text) {
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
        entries.push(normalizeUsedLaterEntry(parsed))
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
 * 读 sidecar。文件不存在 → 空结果（还没判定过，不是错误）。
 * @param {string} logPath
 * @param {{ since?: number, limit?: number, maxBytes?: number }} [opts]
 * @returns {{ entries: any[], total: number, skipped: number, exists: boolean, truncated: boolean, logPath: string }}
 */
export function readUsedLaterLog(logPath, opts = {}) {
  const empty = { entries: [], total: 0, skipped: 0, exists: false, truncated: false, logPath }
  try {
    if (typeof logPath !== 'string' || !logPath) return empty
    const stat = statSync(logPath)
    if (!stat.isFile()) return empty
    const maxBytes = Number(opts.maxBytes) || MAX_READ_BYTES
    const truncated = stat.size > maxBytes
    const buffer = readFileSync(logPath)
    const slice = truncated ? buffer.subarray(buffer.length - maxBytes) : buffer
    let text = slice.toString('utf8')
    if (truncated) {
      // 尾部截断会让第一行是半截 JSON，丢掉它
      const nl = text.indexOf('\n')
      text = nl >= 0 ? text.slice(nl + 1) : ''
    }
    const parsed = parseUsedLaterLines(text)
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
 * 聚合。纯函数，不碰文件系统（API / 页面 / 命令行报告走同一段逻辑）。
 *
 * 口径（写死在返回值里的 note，页面和报告都用它）：
 * - `hitRows`：被判定过引用的命中条数（只算有 memoryId 的行）；
 * - `quotedCount`：其中 `usedLater === true` 的条数；
 * - `unjudgedCount`：命中但没判成 true 的条数（null，不是 false）；
 * - `quoteRate`：quotedCount / hitRows —— **下界**。模型改写记忆的表述时这里
 *   必然漏掉，所以真实「用上了」的比例只会比它高，不会低；
 * - `noHitRetrievals`：零命中的检索次数（单独一列，不进分母）。
 *
 * @param {any[]} entries
 * @param {{ now?: number, windowDays?: number }} [opts]
 * @returns {any}
 */
export function summarizeUsedLater(entries, opts = {}) {
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now()
  const windowDays = Number.isFinite(opts.windowDays) && Number(opts.windowDays) > 0
    ? Number(opts.windowDays)
    : 7
  const since = now - windowDays * 24 * 60 * 60 * 1000

  const list = (Array.isArray(entries) ? entries : []).filter(
    (e) => e && typeof e === 'object' && Number(e.at) >= since,
  )

  /** @type {Record<string, number>} */
  const byChannel = {}
  let hitRows = 0
  let quotedCount = 0
  let unjudgedCount = 0
  let noHitRetrievals = 0

  for (const e of list) {
    const channel = typeof e.channel === 'string' && e.channel ? e.channel : 'unknown'
    byChannel[channel] = (byChannel[channel] || 0) + 1
    if (typeof e.memoryId === 'string' && e.memoryId) {
      hitRows += 1
      if (e.usedLater === true) quotedCount += 1
      else unjudgedCount += 1
    } else {
      noHitRetrievals += 1
    }
  }

  return {
    windowDays,
    since,
    now,
    /** 总行数（命中行 + 零命中占位行） */
    rows: list.length,
    hitRows,
    quotedCount,
    unjudgedCount,
    noHitRetrievals,
    quoteRate: hitRows > 0 ? Math.round((quotedCount / hitRows) * 1000) / 1000 : null,
    byChannel,
    minQuoteChars: MIN_QUOTE_CHARS,
    note:
      '引用率只统计 assistant 文本里出现命中记忆连续 ' + MIN_QUOTE_CHARS +
      ' 字以上原文的行，是下界不是全量：模型改写成自己的话时分不出来，那算「未判定」不算「没用上」。',
  }
}

/**
 * 建一个 usedLater 观察器。**所有方法都不抛**。
 *
 * 生命周期（sessionId 维度，内存里）：
 *   1. `noteSearch()`：brain_search 检索完，把命中的 memoryId + 正文缓存起来；
 *   2. `assistant/message`：记下本回合最后一条非空 assistant 文本（覆盖，不累积——
 *      最终文本才是判定基准；文本为空的消息不覆盖，否则工具调用消息会把内容洗掉）；
 *   3. `turn/end`：判定 + 逐行落盘 + 清空该会话缓存；
 *   4. `turn/start`：清掉上一回合残留的检索（没等到 turn/end 的那些），落成
 *      `usedLater: null` + `usedLaterWhy: 'no_turn_end'`——如实说「这轮判不了」，
 *      而不是静默丢掉让数据缺口看不见；
 *   5. `session/disposed`：直接清空（这回合不属于任何回答）。
 *
 * @param {{
 *   logPath?: string,
 *   now?: () => number,
 *   appendEntry?: (logPath: string, entry: Record<string, any>, now: number) => any,
 *   onDrop?: (reason: string, detail?: Record<string, any>) => void,
 * }} [options]
 */
export function createUsedLaterTracker(options = {}) {
  const logPath = typeof options.logPath === 'string' && options.logPath
    ? options.logPath
    : DEFAULT_USED_LATER_LOG
  const nowFn = typeof options.now === 'function' ? options.now : () => Date.now()
  const appendEntry = typeof options.appendEntry === 'function'
    ? options.appendEntry
    : (path, entry, at) => appendUsedLater(path, entry, at)
  const onDrop = typeof options.onDrop === 'function' ? options.onDrop : () => {}

  /** @type {Map<string, { assistantText: string, searches: any[] }>} */
  const sessions = new Map()
  /** 统计（诊断用，不落盘）：被判定的回合数 / 落盘失败次数 / 丢弃的检索次数 */
  const stats = { turnsJudged: 0, entriesWritten: 0, writeFailures: 0, droppedSearches: 0 }

  /**
   * @param {string} sessionId
   * @returns {{ assistantText: string, searches: any[] }}
   */
  function stateOf(sessionId) {
    let state = sessions.get(sessionId)
    if (!state) {
      state = { assistantText: '', searches: [] }
      sessions.set(sessionId, state)
      if (sessions.size > MAX_SESSIONS) {
        // 有界：Map 按插入序，驱逐最老的那个会话。
        const oldest = sessions.keys().next()
        if (oldest.done !== true) sessions.delete(oldest.value)
      }
    }
    return state
  }

  /**
   * 缓存一次检索。调用点：brain_search 的 execute（成功路径）。
   *
   * @param {{
   *   sessionId?: string|null,
   *   turn?: number|null,
   *   query?: string|null,
   *   channel?: string|null,
   *   hits?: Array<{ memoryId?: string|null, content?: string|null }>,
   * }} input
   * @returns {boolean} 是否缓存成功（false = 没有 sessionId 或内部出错，不影响检索本身）
   */
  function noteSearch(input) {
    try {
      const sessionId = typeof input?.sessionId === 'string' && input.sessionId ? input.sessionId : null
      if (sessionId === null) return false

      const hits = (Array.isArray(input?.hits) ? input.hits : [])
        .slice(0, MAX_HITS_PER_SEARCH)
        .map((hit) => ({
          memoryId: typeof hit?.memoryId === 'string' ? hit.memoryId : null,
          content: typeof hit?.content === 'string' ? hit.content.slice(0, MAX_CONTENT_CHARS) : '',
        }))
        .filter((hit) => hit.memoryId !== null)

      const state = stateOf(sessionId)
      state.searches.push({
        sessionId,
        query: typeof input?.query === 'string' ? input.query : null,
        channel: typeof input?.channel === 'string' ? input.channel : 'tool',
        turn: typeof input?.turn === 'number' && Number.isFinite(input.turn) ? input.turn : null,
        at: nowFn(),
        hits,
      })
      if (state.searches.length > MAX_SEARCHES_PER_SESSION) {
        // 有界：丢最旧的一次检索（它已无法归属到较早的回答）。丢多少要能被诊断看见。
        state.searches.shift()
        stats.droppedSearches += 1
        onDrop('search_over_capacity', { sessionId, limit: MAX_SEARCHES_PER_SESSION })
      }
      return true
    } catch (error) {
      onDrop('note_search_failed', { message: error instanceof Error ? error.message : String(error) })
      return false
    }
  }

  /**
   * 把一串判定结果落盘。写失败只计数，不影响其它行。
   * @param {any[]} entries
   * @param {number} at
   */
  function writeEntries(entries, at) {
    for (const entry of entries) {
      try {
        const outcome = appendEntry(logPath, entry, at)
        if (outcome && outcome.ok === false) stats.writeFailures += 1
        else stats.entriesWritten += 1
      } catch {
        stats.writeFailures += 1
      }
    }
  }

  /**
   * 判定并清空一个会话的待判定缓存。
   * @param {string} sessionId
   * @param {number|null} turn 以 turn/end 的 turn 为准（检索侧可能拿不到）
   * @param {string|null} why 传了 why 表示「不是正常回合结束」（例如 turn/start 的残留）
   */
  function judgeAndClear(sessionId, turn, why) {
    const state = sessions.get(sessionId)
    if (!state) return
    sessions.delete(sessionId)
    if (state.searches.length === 0) return

    const at = nowFn()
    const searches = state.searches.map((search) => ({
      ...search,
      turn: turn !== null ? turn : search.turn,
    }))

    if (why !== null) {
      // 非正常结束：不拿别的回合的文本硬套，如实记「判不了」。
      const entries = []
      for (const search of searches) {
        const hits = Array.isArray(search.hits) ? search.hits : []
        if (hits.length === 0) {
          entries.push({ ...search, memoryId: null, usedLater: null, usedLaterWhy: why })
          continue
        }
        for (const hit of hits) {
          entries.push({ ...search, memoryId: hit.memoryId, usedLater: null, usedLaterWhy: why })
        }
      }
      writeEntries(entries, at)
      stats.turnsJudged += 1
      return
    }

    const entries = judgeTurn({ assistantText: state.assistantText, searches, now: at })
    writeEntries(entries, at)
    stats.turnsJudged += 1
  }

  /**
   * `session/event` emit 监听。**顶层 try/catch，零抛出**（CONTRACTS 10.2）：
   * 这里抛错会让宿主把 turn/end 判成 reason=error，把观测事故变成主人的回合事故。
   *
   * @param {any} session
   * @param {any} event
   * @returns {void}
   */
  function handleSessionEvent(session, event) {
    try {
      const sessionId = typeof session?.id === 'string' && session.id ? session.id : null
      if (sessionId === null) return
      const type = typeof event?.type === 'string' ? event.type : ''
      if (!type) return
      const data = event?.data !== undefined && event?.data !== null && typeof event.data === 'object'
        ? event.data
        : {}

      if (type === 'turn/start') {
        // 上一回合没有等到 turn/end（进程异常/事件丢失）就进新回合了：
        // 残留的检索无法归属，如实落「判不了」，不要拿新回合的回答去套旧检索。
        judgeAndClear(sessionId, null, USED_LATER_WHY.NO_TURN_END)
        return
      }

      if (type === 'assistant/message') {
        const text = assistantTextOf(data)
        // 只接受非空文本：工具调用消息（content 里只有 tool_call 块）文本为空，
        // 若让它覆盖，会把前面那条真正有内容的回答洗掉，整个回合都判成 no_assistant_text。
        if (text.length > 0) {
          stateOf(sessionId).assistantText = text.slice(0, 20000)
        }
        return
      }

      if (type === 'turn/end') {
        const turn = typeof data.turn === 'number' && Number.isFinite(data.turn) ? data.turn : null
        judgeAndClear(sessionId, turn, null)
        return
      }

      if (type === 'session/disposed') {
        sessions.delete(sessionId)
      }
    } catch (error) {
      // 零抛出：只留一行 stderr（不进任何日志文件，免得观测日志里混进异常噪声）。
      console.error(
        '[brain-used-later] session/event 处理失败（已忽略，不影响对话）:',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  return {
    noteSearch,
    handleSessionEvent,
    logPath,
    /** 诊断用：当前缓存了几个会话、各缓存了几条检索（不暴露正文）。 */
    pending() {
      return [...sessions.entries()].map(([sessionId, state]) => ({
        sessionId,
        searches: state.searches.length,
        hasAssistantText: state.assistantText.length > 0,
      }))
    },
    stats() {
      return { ...stats }
    },
  }
}

/**
 * 从 `assistant/message` 事件的 data 里取文本。
 *
 * 形状与 `apps/connector/index.js` 里的 `extractFrame` **同形**（那边是模块私有函数，
 * 没有导出；brain-tools 不该 import connector 插件入口——那会带进一整套宿主注册副作用）。
 * 所以这里按同一实测形状重写最小提取：`data.message` 优先，`content` 支持字符串
 * 与 block 数组（block.text 或 block.content）。
 *
 * @param {any} data
 * @returns {string}
 */
export function assistantTextOf(data) {
  try {
    const message = data?.message !== undefined && data.message !== null && typeof data.message === 'object'
      ? data.message
      : data
    const content = message?.content
    /** @type {string[]} */
    const parts = []
    if (typeof content === 'string') parts.push(content)
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block === null || typeof block !== 'object') continue
        if (typeof block.text === 'string') parts.push(block.text)
        else if (typeof block.content === 'string') parts.push(block.content)
      }
    }
    return parts.join('\n')
  } catch {
    return ''
  }
}
