// @ts-check
/**
 * apps/brain-tools/used-later.js 单元测试（M4.6 观测闭环）。
 *
 * 覆盖任务书要求的四种判定情况 + 判据边界 + 隐私 + 聚合口径：
 *   1. 命中 + 回答引用了连续原文（≥12 字） → usedLater: true / evidence: 'quote'
 *   2. 命中 + 回答没引用原文（改写/没用）   → usedLater: null（不是 false）
 *   3. 检索零命中                          → 一条占位行，usedLater: null
 *   4. handler 内部抛错不外泄              → handleSessionEvent 不抛（turn/end 不能被污染）
 *
 * 纪律：
 * - 只用 node:test / node:assert/strict；临时目录 mkdtempSync，测完清理；
 * - 每次都用**显式临时路径**，绝不碰 data/logs/*.jsonl（CONTRACTS 12.1 / 12.39）；
 * - 不 import apps/brain-tools/index.js（宿主插件需要 DSH 运行时）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MIN_QUOTE_CHARS,
  appendUsedLater,
  createUsedLaterTracker,
  findQuote,
  judgeTurn,
  normalizeUsedLaterEntry,
  readUsedLaterLog,
  summarizeUsedLater,
} from '../../../apps/brain-tools/used-later.js'
import { renderUsagePage } from '../../../apps/brain-tools/usage-page.js'

/** 固定基准时刻（手算过：1700000000000 ms = 2023-11-14T22:13:20.000Z） */
const FIXED_NOW = 1700000000000

/**
 * 建一个测完自动删的临时目录。
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-used-later-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

/** 一条足够长的记忆正文（引用判定用的真实语料） */
const MEMORY_CONTENT = '踢脚线报价按 1.2m 一段计，铝板材质，含税单价 128 元/段，图号 建施-03。'

/**
 * 造一个「助手回答里引用了正文前半句」的回答文本。
 * 引用的连续片段远长于 12 字，判定必须命中。
 */
const ANSWER_QUOTED = '按记忆里的口径：踢脚线报价按 1.2m 一段计，铝板材质，其余不变。'

/**
 * 造一个「改写成自己的话、没有连续原文」的回答。
 * 「按段计价、铝板、128 元」都是有语义重叠但不连续的词，判据必须判成 null。
 */
const ANSWER_REWORDED = '报价按段计价，用铝板，每段 128 元，含税。'

// ---------------------------------------------------------------------------
// 1. 命中 + 被引用 → true / quote（并且日志不落正文）
// ---------------------------------------------------------------------------
test('1. 命中且回答引用了连续原文 → usedLater: true / evidence: quote', (t) => {
  const dir = tempDir(t)
  const logPath = join(dir, 'logs', 'used-later.jsonl')
  const tracker = createUsedLaterTracker({ logPath, now: () => FIXED_NOW })

  assert.equal(
    tracker.noteSearch({
      sessionId: 'sess-quote',
      turn: 7,
      query: '踢脚线报价',
      hits: [{ memoryId: 'mem-a', content: MEMORY_CONTENT }],
    }),
    true,
  )
  // assistant/message：真实事件形状（data.message.content 为 block 数组）
  tracker.handleSessionEvent(
    { id: 'sess-quote' },
    {
      type: 'assistant/message',
      data: { turn: 7, message: { role: 'assistant', content: [{ type: 'text', text: ANSWER_QUOTED }] } },
    },
  )
  tracker.handleSessionEvent(
    { id: 'sess-quote' },
    { type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } },
  )

  const read = readUsedLaterLog(logPath)
  assert.equal(read.exists, true)
  assert.equal(read.total, 1, '一条命中 = 一行证据')
  assert.equal(read.skipped, 0)

  const row = read.entries[0]
  assert.equal(row.memoryId, 'mem-a')
  assert.equal(row.usedLater, true)
  assert.equal(row.evidence, 'quote')
  assert.equal(row.usedLaterWhy, null)
  assert.equal(row.memoryIdsCount, 1)
  assert.equal(row.turn, 7)
  assert.equal(row.query, '踢脚线报价')
  assert.equal(row.channel, 'tool')
  // quoteLen 必须是「最长连续原文」而不是刚好 12：这里引用了正文前 20 字左右
  assert.ok(row.quoteLen >= MIN_QUOTE_CHARS, `quoteLen=${row.quoteLen} 应 ≥ ${MIN_QUOTE_CHARS}`)
  assert.match(row.quoteHash, /^[0-9a-f]{8}$/, 'quoteHash 是 sha256 前 8 位十六进制')

  // 隐私：日志里不能出现记忆正文或回答原文（只证「引用了」，不复制内容）
  const raw = readFileSync(logPath, 'utf8')
  assert.equal(raw.includes('踢脚线报价按'), false, '日志里不许出现记忆正文片段')
  assert.equal(raw.includes('铝板材质'), false, '日志里不许出现记忆正文片段')
  assert.equal(raw.includes('含税单价'), false, '日志里不许出现记忆正文片段')
  // 输出形状固定：多一个字段少一个字段都算契约变更
  assert.deepEqual(Object.keys(row).sort(), [
    'at', 'channel', 'evidence', 'memoryId', 'memoryIdsCount', 'query',
    'quoteHash', 'quoteLen', 'sessionId', 'ts', 'turn', 'usedLater', 'usedLaterWhy',
  ])
})

// ---------------------------------------------------------------------------
// 2. 命中 + 没引用原文 → null（绝对不许 false）
// ---------------------------------------------------------------------------
test('2. 命中但回答改写成自己的话 → usedLater: null + 原因，不记 false', (t) => {
  const dir = tempDir(t)
  const logPath = join(dir, 'used-later.jsonl')
  const tracker = createUsedLaterTracker({ logPath, now: () => FIXED_NOW })

  tracker.noteSearch({
    sessionId: 'sess-reworded',
    turn: 3,
    query: '踢脚线报价',
    hits: [{ memoryId: 'mem-b', content: MEMORY_CONTENT }],
  })
  tracker.handleSessionEvent(
    { id: 'sess-reworded' },
    { type: 'assistant/message', data: { message: { content: ANSWER_REWORDED } } },
  )
  tracker.handleSessionEvent({ id: 'sess-reworded' }, { type: 'turn/end', data: { turn: 3 } })

  const row = readUsedLaterLog(logPath).entries[0]
  assert.equal(row.memoryId, 'mem-b')
  assert.equal(row.usedLater, null, '没引用原文不等于没用上，只能记未判定')
  assert.equal(row.evidence, null)
  assert.equal(row.quoteLen, null)
  assert.equal(row.quoteHash, null)
  assert.equal(row.usedLaterWhy, 'no_quote_in_answer')
  assert.equal('usedLater' in row && row.usedLater === false, false, '硬约束：任何情况下都不许落 false')
})

// ---------------------------------------------------------------------------
// 3. 检索零命中 → 一行占位，usedLater: null
// ---------------------------------------------------------------------------
test('3. 检索零命中 → 落一行占位（memoryId=null），usedLater: null', (t) => {
  const dir = tempDir(t)
  const logPath = join(dir, 'used-later.jsonl')
  const tracker = createUsedLaterTracker({ logPath, now: () => FIXED_NOW })

  tracker.noteSearch({ sessionId: 'sess-empty', turn: 1, query: '量子纠缠退相干', hits: [] })
  tracker.handleSessionEvent(
    { id: 'sess-empty' },
    { type: 'assistant/message', data: { message: { content: '我没找到相关记忆。' } } },
  )
  tracker.handleSessionEvent({ id: 'sess-empty' }, { type: 'turn/end', data: { turn: 1 } })

  const read = readUsedLaterLog(logPath)
  assert.equal(read.total, 1)
  const row = read.entries[0]
  assert.equal(row.memoryId, null)
  assert.equal(row.memoryIdsCount, 0)
  assert.equal(row.usedLater, null)
  assert.equal(row.usedLaterWhy, 'no_hits')
})

// ---------------------------------------------------------------------------
// 4. handler 内部抛错不外泄（最重要的一条：turn/end 不能被观测代码打坏）
// ---------------------------------------------------------------------------
test('4. handler 内部抛错不外泄：append 失败 / 恶意事件都不抛', (t) => {
  const dir = tempDir(t)
  const logPath = join(dir, 'used-later.jsonl')
  /** @type {Array<{ reason: string }>} */
  const drops = []
  const tracker = createUsedLaterTracker({
    logPath,
    now: () => FIXED_NOW,
    // 故意让落盘抛错，模拟磁盘满 / 权限问题
    appendEntry: () => { throw new Error('磁盘满了（模拟）') },
    onDrop: (reason) => { drops.push({ reason }) },
  })

  tracker.noteSearch({ sessionId: 'sess-boom', turn: 2, hits: [{ memoryId: 'mem-c', content: MEMORY_CONTENT }] })
  tracker.handleSessionEvent(
    { id: 'sess-boom' },
    { type: 'assistant/message', data: { message: { content: ANSWER_QUOTED } } },
  )
  // 不抛即通过；同时写失败要被计数，而不是悄悄消失
  assert.doesNotThrow(() =>
    tracker.handleSessionEvent({ id: 'sess-boom' }, { type: 'turn/end', data: { turn: 2 } }),
  )
  assert.equal(tracker.stats().writeFailures, 1, '写失败要计数')

  // 各种畸形输入：session 没有 id / event 是 null / data 不是对象 / content 是循环结构
  assert.doesNotThrow(() => tracker.handleSessionEvent(null, null))
  assert.doesNotThrow(() => tracker.handleSessionEvent({}, { type: 'turn/end' }))
  assert.doesNotThrow(() => tracker.handleSessionEvent({ id: 'x' }, { type: 'assistant/message', data: 42 }))
  assert.doesNotThrow(() => tracker.handleSessionEvent({ id: 'x' }, { type: 'unknown/thing' }))
  const circular = { message: {} }
  circular.message.content = [circular]
  assert.doesNotThrow(() => tracker.handleSessionEvent({ id: 'x' }, { type: 'assistant/message', data: circular }))

  // noteSearch 也不能抛：sessionId 缺失返回 false，不改检索行为
  assert.equal(tracker.noteSearch({ hits: [] }), false)
  assert.equal(tracker.noteSearch({ sessionId: 'x', hits: [{ memoryId: 42 }] }), true, '坏 memoryId 被过滤，不抛')
})

// ---------------------------------------------------------------------------
// 5. 判据边界：11 字不算、12 字算
// ---------------------------------------------------------------------------
test('5. 判据边界：连续原文 11 字不算引用，12 字才算', () => {
  const content = 'AAAAAAAABBBBCCCC' // 16 字
  // 11 字（AAAAAAAABBB，位置 0..10）
  assert.equal(findQuote('前缀 AAAAAAAABBB 后缀', content), null, '11 字不足以判定')
  // 12 字（AAAAAAAABBBB，位置 0..11）
  const quoted = findQuote('前缀 AAAAAAAABBBB 后缀', content)
  assert.notEqual(quoted, null, '12 字必须判定为引用')
  assert.ok(quoted && quoted.quoteLen >= 12)
  // 只有 12 字下限、正文本身短于 12 字时永远不命中（不许拿短文本凑）
  assert.equal(findQuote('短正文', '短正文'), null)
  // 空白折叠：正文含换行，回答写单行时应命中（换行位置不同不该判成没引用）
  assert.notEqual(findQuote('第一行内容 第二行内容的说明', '第一行内容\n第二行内容的说明'), null)
  // 但去空格/去标点的模糊匹配不许做（那会引入假阳性）
  assert.equal(
    findQuote('第一行内容 第二行内容的说明文字', '第一行内容，第二行内容的说明文字'),
    null,
    '标点不同不算连续原文',
  )
})

// ---------------------------------------------------------------------------
// 6. 取不到 assistant 文本 → 未判定 + 明确原因（不猜）
// ---------------------------------------------------------------------------
test('6. 没有 assistant 文本 → usedLater: null + no_assistant_text', (t) => {
  const dir = tempDir(t)
  const logPath = join(dir, 'used-later.jsonl')
  const tracker = createUsedLaterTracker({ logPath, now: () => FIXED_NOW })

  tracker.noteSearch({ sessionId: 'sess-notext', turn: 4, hits: [{ memoryId: 'mem-d', content: MEMORY_CONTENT }] })
  tracker.handleSessionEvent({ id: 'sess-notext' }, { type: 'turn/end', data: { turn: 4 } })

  const row = readUsedLaterLog(logPath).entries[0]
  assert.equal(row.memoryId, 'mem-d')
  assert.equal(row.usedLater, null)
  assert.equal(row.usedLaterWhy, 'no_assistant_text')
})

// ---------------------------------------------------------------------------
// 7. turn/start 时上一回合残留 → 如实记「判不了」，不拿新回合文本硬套
// ---------------------------------------------------------------------------
test('7. 上一回合没等到 turn/end 的残留 → no_turn_end，不静默丢弃', (t) => {
  const dir = tempDir(t)
  const logPath = join(dir, 'used-later.jsonl')
  const tracker = createUsedLaterTracker({ logPath, now: () => FIXED_NOW })

  tracker.noteSearch({ sessionId: 'sess-residue', turn: 9, hits: [{ memoryId: 'mem-e', content: MEMORY_CONTENT }] })
  // 直接进下一回合：此时 assistantText 为空，绝不能拿空文本判成「没引用」
  tracker.handleSessionEvent({ id: 'sess-residue' }, { type: 'turn/start', data: { turn: 10 } })

  const read = readUsedLaterLog(logPath)
  assert.equal(read.total, 1)
  assert.equal(read.entries[0].usedLater, null)
  assert.equal(read.entries[0].usedLaterWhy, 'no_turn_end')
})

// ---------------------------------------------------------------------------
// 8. 落盘规范器：false 一律被吞成 null（口径在写入处上锁）
// ---------------------------------------------------------------------------
test('8. normalizeUsedLaterEntry：usedLater 只可能 true / null，false 被吞成 null', () => {
  const row = normalizeUsedLaterEntry({ usedLater: false, memoryId: 'm', usedLaterWhy: 'x' }, FIXED_NOW)
  assert.equal(row.usedLater, null)
  assert.equal(row.evidence, null)
  const truthy = normalizeUsedLaterEntry({ usedLater: 'yes', memoryId: 'm' }, FIXED_NOW)
  assert.equal(truthy.usedLater, null, '只有严格 true 才算引用，字符串不算')
  const good = normalizeUsedLaterEntry(
    { usedLater: true, evidence: 'quote', quoteLen: 14, quoteHash: 'abcd1234', memoryId: 'm' },
    FIXED_NOW,
  )
  assert.equal(good.usedLater, true)
  assert.equal(good.evidence, 'quote')
  // 内联到 JSONL 后仍可解析
  assert.equal(JSON.parse(JSON.stringify(good)).memoryId, 'm')
  // appendUsedLater 空路径不抛（观测失败不影响调用方）
  assert.equal(appendUsedLater('', { memoryId: 'm' }, FIXED_NOW).ok, false)
})

// ---------------------------------------------------------------------------
// 9. 聚合口径：引用率 = 被引用 / 命中行，零命中单列，空样本给 null
// ---------------------------------------------------------------------------
test('9. summarizeUsedLater：引用率是下界，零命中不进分母，空样本返回 null', () => {
  const entries = [
    // 2 条命中：1 条被引用、1 条未判定
    { at: FIXED_NOW - 1000, channel: 'tool', memoryId: 'm1', usedLater: true, evidence: 'quote' },
    { at: FIXED_NOW - 900, channel: 'tool', memoryId: 'm2', usedLater: null, usedLaterWhy: 'no_quote_in_answer' },
    // 1 次零命中
    { at: FIXED_NOW - 800, channel: 'tool', memoryId: null, usedLater: null, usedLaterWhy: 'no_hits' },
    // 窗口外的旧记录不算
    { at: FIXED_NOW - 30 * 24 * 60 * 60 * 1000, channel: 'tool', memoryId: 'm3', usedLater: true },
  ]
  const summary = summarizeUsedLater(entries, { now: FIXED_NOW, windowDays: 7 })
  assert.equal(summary.rows, 3)
  assert.equal(summary.hitRows, 2)
  assert.equal(summary.quotedCount, 1)
  assert.equal(summary.unjudgedCount, 1)
  assert.equal(summary.noHitRetrievals, 1)
  assert.equal(summary.quoteRate, 0.5)
  assert.deepEqual(summary.byChannel, { tool: 3 })
  assert.equal(summary.minQuoteChars, MIN_QUOTE_CHARS)
  assert.match(summary.note, /下界/)

  const empty = summarizeUsedLater([], { now: FIXED_NOW, windowDays: 7 })
  assert.equal(empty.hitRows, 0)
  assert.equal(empty.quoteRate, null, '没有样本必须是 null，不能是 0（Number(null) === 0 那个坑）')
})

// ---------------------------------------------------------------------------
// 10. judgeTurn 纯函数：多命中 / 多检索各记一行，行数 = 命中条数
// ---------------------------------------------------------------------------
test('10. judgeTurn：多命中按 memoryId 各一行，行数与命中条数一致', () => {
  const entries = judgeTurn({
    assistantText: ANSWER_QUOTED,
    now: FIXED_NOW,
    searches: [
      {
        sessionId: 's',
        turn: 1,
        query: 'q1',
        hits: [
          { memoryId: 'm-hit', content: MEMORY_CONTENT },
          { memoryId: 'm-miss', content: '完全无关的另一条记忆正文，一段关于外墙保温厚度和岩棉规格的说明。' },
        ],
      },
    ],
  })
  assert.equal(entries.length, 2)
  assert.equal(entries[0].usedLater, true)
  assert.equal(entries[1].usedLater, null)
  assert.equal(entries[0].memoryIdsCount, 2)
  assert.equal(entries[1].memoryIdsCount, 2)
})

// ---------------------------------------------------------------------------
// 11. 页面接线：/dsh-brain/usage 的引用率那一格真的能被 usedLater 数据填上
//
// 为什么这条要在这里验（而不是只靠 tools/verify-pages.mjs）：那个脚本的
// fake /api/usage 是它自己的夹具，这个新字段没在它的夹具里；而「API 字段名
// 和页面对不上」正是 CONTRACTS 12.7 说的那类静默错位。这里用最小 DOM stub
// 真跑一遍 usage 页的内联脚本，证明 d.usedLater → 页面数字的这条链是通的。
// ---------------------------------------------------------------------------
test('11. usage 页把 usedLater 渲染进「引用率」那一格（含字段缺失时的降级）', async () => {
  const html = renderUsagePage({ logPath: '/tmp/x/usage.jsonl', windowDays: 7 })
  assert.ok(html.includes('id="s-quote"'), '页面要有引用率格子')
  assert.ok(html.includes('renderQuote(d.usedLater)'), '页面脚本要消费 usedLater 字段')
  assert.ok(html.includes('下界'), '口径说明要写在页面上')

  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])
  assert.equal(scripts.length, 1)

  /** 用最小 DOM stub 跑一次页面脚本；返回被页面写过的元素表。 */
  const run = async (payload) => {
    /** @type {Map<string, any>} */
    const byId = new Map()
    const makeEl = (/** @type {string} */ tag) => ({
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      title: '',
      colSpan: 0,
      style: {},
      children: [],
      appendChild(/** @type {any} */ child) { this.children.push(child); return child },
    })
    const documentStub = {
      createElement: makeEl,
      getElementById: (/** @type {string} */ id) => {
        if (!byId.has(id)) byId.set(id, makeEl('div'))
        return byId.get(id)
      },
    }
    const savedDocument = globalThis.document
    const savedFetch = globalThis.fetch
    try {
      // @ts-expect-error 故意替换全局做 stub
      globalThis.document = documentStub
      // @ts-expect-error 同上
      globalThis.fetch = async () => ({ json: async () => payload })
      const fn = new Function('return (async () => {\n' + scripts[0] + '\n})()')
      await fn()
      // 页面是 fetch().then() 链，给微任务一轮时间落 DOM
      await new Promise((resolve) => setTimeout(resolve, 10))
    } finally {
      // @ts-expect-error 还原
      globalThis.document = savedDocument
      // @ts-expect-error 还原
      globalThis.fetch = savedFetch
    }
    return byId
  }

  const basePayload = {
    ok: true,
    summary: {
      total: 3, okCount: 3, failCount: 0, hitCount: 2, zeroHitCount: 1,
      hitRate: 0.667, laneMissCount: 1, laneMissRate: 0.333,
      timing: { avg: 12, p50: 10, p95: 30, samples: 3 },
      byStatus: { ok: 2, no_related: 1 },
      topQueries: [], zeroHitQueries: [], byDay: [],
    },
    coverage: { totalMemories: 10, touched: 3, neverHit: 7, touchedRate: 0.3, neverHitSamples: [] },
    recent: [],
  }

  // 有 usedLater：引用率 50%，副标写清 1 / 2 条命中被引用
  const withQuote = await run({
    ...basePayload,
    usedLater: { windowDays: 7, rows: 3, hitRows: 2, quotedCount: 1, unjudgedCount: 1, noHitRetrievals: 1, quoteRate: 0.5 },
  })
  assert.equal(withQuote.get('s-quote').textContent, '50%', '引用率要按 quoteRate 渲染成百分比')
  assert.match(withQuote.get('s-quote-n').textContent, /1 \/ 2 条命中被引用原文/)
  assert.match(withQuote.get('s-quote-n').textContent, /1 次零命中/)

  // 没有 usedLater（老数据 / API 降级）：显示占位，不能崩、不能显示 0%
  const withoutQuote = await run({ ...basePayload })
  assert.equal(withoutQuote.get('s-quote').textContent, '–', '拿不到口径时显示占位，不能编一个 0%')
  assert.equal(withoutQuote.get('s-quote-n').textContent, '还没有判定记录')
})
