// @ts-check
/**
 * §18.1「长上下文测试」：十万字多会话历史，早期约定晚期问。
 *
 *   node tools/run-scale-eval.mjs             # 跑并写 docs/SCALE-REPORT.md
 *   node tools/run-scale-eval.mjs --stdout    # 只打印
 *
 * ── 它和 tests/eval 的 120 用例评测有什么不同 ──
 *
 * 120 用例评测是**质量**评测：语料 26 条，看检索准不准。
 * 这里是**规模**评测：语料十万字以上、1400+ 条，看「历史足够长之后还能不能找回早期约定」。
 *
 * 后者是设计文档 §18.1 的原话，也是「外置大脑」存在的理由——
 * 如果十万字之后早期约定就找不回了，这东西没有意义。
 *
 * ── §18.1 的六条里，哪些测、哪些不测 ──
 *
 * 1. 十万字多会话、早期约定晚期问 → **测**
 * 2. 返回正确内容/来源/版本 → **测**（Recall + 来源可追溯）
 * 3. 上下文只含相关片段 → **不适用**（automatic 注入未开，没有真实构包）
 * 4. 修改早期参数后旧值不再被当当前事实 → **测**（写新版本 + asOf 双查）
 * 5. 代码/表格/配置精确回查 → **测**
 * 6. 服务重启后从任务快照继续 → **不适用**（task_snapshots 为空，未实现）
 *
 * 不适用项在报告里单列并写明原因，不算通过也不算失败。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { openBrain } from '../packages/memory/src/index.js'
import { ANCHOR, buildScaleCorpus, buildScaleQueries } from '../tests/eval/scale-corpus.mjs'

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url))
const OUT = fileURLToPath(new URL('../docs/SCALE-REPORT.md', import.meta.url))
const SCOPE = 'scale-eval'
const PERSON = 'scale-owner'
/** 每条记忆写入的时间基准：越往后越新，模拟跨会话的时间推进 */
const BASE_TS = Date.parse('2026-01-05T00:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

const corpus = buildScaleCorpus({ noiseCount: 1400 })
const queries = buildScaleQueries()

const dir = mkdtempSync(join(tmpdir(), 'dsh-scale-'))
const brain = openBrain({ dbPath: join(dir, 'brain.db'), migrationsDir: MIGRATIONS, bindings: { scope_id: SCOPE, person_id: PERSON } })

const keyToId = new Map()
const startedAt = Date.now()

/** 把语料灌进去。早期层时间最早，干扰层次之，晚期层最新。 */
async function seed() {
  const all = [...corpus.early, ...corpus.noise, ...corpus.late]
  for (let i = 0; i < all.length; i += 1) {
    const m = all[i]
    const when = new Date(BASE_TS + i * 6 * 60 * 60 * 1000).toISOString()
    const created = await brain.memories.create({
      scopeId: SCOPE,
      personId: PERSON,
      layer: 'long',
      type: m.type || 'semantic',
      content: m.content,
      summary: m.summary,
      sourceType: 'summary',
      sourceIds: [],
      confidence: 0.9,
      importance: m.importance ?? 0.5,
      privacy: 'private',
      originSystem: 'brain',
      producer: 'tools/run-scale-eval',
      validFrom: when,
    })
    keyToId.set(m.key, created.id)
    await brain.sources.link(created.id, {
      sourceKind: 'tool_call',
      sourceSystem: 'eval',
      sourceEventId: `scale:${m.key}`,
      locator: `tests/eval/scale-corpus#${m.key}`,
    })
  }
}
await seed()
const seedMs = Date.now() - startedAt

/** 跑查询 */
const rows = []
for (const q of queries) {
  const res = brain.memories.search({ query: q.query, scopeId: SCOPE, personId: PERSON, limit: 10 })
  const hits = res.hits || []
  const ids = hits.map((h) => String(h.memoryId))
  const expectIds = q.expectKeys.map((k) => keyToId.get(k)).filter(Boolean)
  const recalled = expectIds.filter((id) => ids.includes(id))
  const traceable = hits.length === 0 || hits.every((h) => Array.isArray(h.sourceRefs) && h.sourceRefs.length > 0)
  rows.push({
    id: q.id,
    query: q.query,
    hitCount: hits.length,
    recallHit: recalled.length > 0,
    traceable,
    status: res.diagnostics ? res.diagnostics.status : null,
    top1: hits[0] ? String(hits[0].summary).slice(0, 40) : null,
    note: q.note,
  })
}

// ── §18.1 第 4 条：修改早期参数后，旧值不许再当当前事实 ──
const oldQuoteId = keyToId.get('anchor_quote')
const newQuoteValue = ANCHOR.quoteValue + 30
const newQuote = await brain.memories.create({
  scopeId: SCOPE,
  personId: PERSON,
  layer: 'long',
  type: 'semantic',
  content: `${ANCHOR.project} 外墙保温${ANCHOR.quoteKey}调整为 ${newQuoteValue} ${ANCHOR.quoteUnit}（材料与图号不变：${ANCHOR.material}，${ANCHOR.drawing}）。`,
  summary: `${ANCHOR.quoteKey}（新）：${newQuoteValue} ${ANCHOR.quoteUnit}`,
  sourceType: 'summary',
  sourceIds: [],
  confidence: 0.9,
  importance: 0.95,
  privacy: 'private',
  originSystem: 'brain',
  producer: 'tools/run-scale-eval',
  validFrom: new Date(BASE_TS + 300 * DAY).toISOString(),
})
// 旧的那条显式标失效。
// 注意 update 是 CAS：expectedVersion 在**第三个参数**里，不在 patch 里；
// 而 supersedes 不在 PATCHABLE 白名单里（取代关系走另一条路径），这里只改状态与有效期。
const oldRow = brain.memories.get(oldQuoteId)
if (!oldRow) throw new Error('scale: 拿不到旧报价条目（scope 收口后可能读不到，检查 bindings）')
await brain.memories.update(
  oldQuoteId,
  {
    status: 'superseded',
    validUntil: new Date(BASE_TS + 299 * DAY).toISOString(),
  },
  {
    expectedVersion: oldRow.version,
    changedBy: 'tools/run-scale-eval',
    reason: '参数调整：旧报价失效',
  },
)

const afterUpdate = brain.memories.search({ query: `${ANCHOR.quoteKey}`, scopeId: SCOPE, personId: PERSON, limit: 10 })
const afterHits = afterUpdate.hits || []
const oldStillTop = afterHits.length > 0 && String(afterHits[0].memoryId) === oldQuoteId
const newInTop = afterHits.some((h) => String(h.memoryId) === newQuote.id)

// 历史时点：改之前查，应拿到旧值
const asOfOld = brain.memories.search({
  query: `${ANCHOR.quoteKey}`,
  scopeId: SCOPE,
  personId: PERSON,
  limit: 10,
  asOf: new Date(BASE_TS + 200 * DAY).toISOString(),
})
const asOfHits = asOfOld.hits || []
const oldInAsOf = asOfHits.some((h) => String(h.memoryId) === oldQuoteId)
const newInAsOf = asOfHits.some((h) => String(h.memoryId) === newQuote.id)

await brain.close()
try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }

// ── 汇总 ──
const recallHitCount = rows.filter((r) => r.recallHit).length
const traceableCount = rows.filter((r) => r.traceable).length
const recallRate = rows.length > 0 ? recallHitCount / rows.length : 0
const traceRate = rows.length > 0 ? traceableCount / rows.length : 0

const lines = []
lines.push('# §18.1 长上下文测试 · 规模报告')
lines.push('')
lines.push(`> 由 \`node tools/run-scale-eval.mjs\` 生成 · ${new Date().toISOString()}`)
lines.push('> 对照基准：《DSH外置大脑-可执行设计方案-v1.2》§18.1')
lines.push('')
lines.push('## 1. 语料规模')
lines.push('')
lines.push('| 项 | 值 |')
lines.push('|---|---|')
lines.push(`| 记忆条数 | **${corpus.total}**（早期约定 ${corpus.early.length} + 干扰 ${corpus.noise.length} + 晚期杂项 ${corpus.late.length}） |`)
lines.push(`| 正文字数 | **${corpus.totalChars.toLocaleString('en-US')}** 字 |`)
lines.push(`| 时间跨度 | ${corpus.total} × 6 小时 ≈ ${Math.round((corpus.total * 6) / 24)} 天 |`)
lines.push(`| 灌库耗时 | ${(seedMs / 1000).toFixed(1)} 秒 |`)
lines.push('')
lines.push('干扰层与早期层**同域、同句式、只差项目名与数值**——这样「找得回」靠的是真能区分，不是唯一词碰巧命中。')
lines.push('')
lines.push('## 2. 早期约定能不能找回来（§18.1 第 1、2 条）')
lines.push('')
lines.push(`- 查询数：**${rows.length}**`)
lines.push(`- 召回命中：**${recallHitCount} / ${rows.length}**（${(recallRate * 100).toFixed(1)}%）`)
lines.push(`- 来源可追溯：**${traceableCount} / ${rows.length}**（${(traceRate * 100).toFixed(1)}%）`)
lines.push('')
lines.push('| id | 查询 | 命中 | 召回 | 来源 | status | top1 |')
lines.push('|---|---|---|---|---|---|---|')
for (const r of rows) {
  lines.push(`| ${r.id} | ${r.query.replace(/\|/g, '\\|')} | ${r.hitCount} | ${r.recallHit ? '✅' : '❌'} | ${r.traceable ? '✅' : '❌'} | ${r.status || '—'} | ${(r.top1 || '—').replace(/\|/g, '\\|')} |`)
}
lines.push('')
lines.push('## 3. 改参数后旧值还会不会被当当前事实（§18.1 第 4 条）')
lines.push('')
lines.push(`- 新版本写入后查当前：新值进 top10 = ${newInTop ? '✅' : '❌'}，旧值仍在 top1 = ${oldStillTop ? '❌ 未失效' : '✅ 已让位'}`)
lines.push(`- 按历史时点查（改之前的时点）：旧值可见 = ${oldInAsOf ? '✅' : '❌'}，新值不该出现 = ${newInAsOf ? '❌ 泄漏了未来的值' : '✅ 没出现'}`)
lines.push('')
lines.push('## 4. 不适用（不算通过，也不算失败）')
lines.push('')
lines.push('| 项 | 为什么不算 |')
lines.push('|---|---|')
lines.push('| §18.1 第 3 条「上下文只含相关片段」 | automatic 注入未启用，`context_packages=0`，没有真实构包可测 |')
lines.push('| §18.1 第 6 条「重启后从任务快照继续」 | `task_snapshots` 为空，快照未接进生产 |')
lines.push('')
lines.push('## 5. 复现')
lines.push('')
lines.push('```powershell')
lines.push('cd E:\\ds-h\\dsh-brain')
lines.push('node tools/run-scale-eval.mjs')
lines.push('```')
lines.push('')

const text = lines.join('\n')

if (process.argv.includes('--stdout')) {
  console.log(text)
} else {
  writeFileSync(OUT, text, 'utf8')
  console.log(`报告已写入 ${OUT}`)
  console.log(`语料 ${corpus.total} 条 / ${corpus.totalChars.toLocaleString('en-US')} 字 · 早期约定召回 ${recallHitCount}/${rows.length} (${(recallRate * 100).toFixed(1)}%) · 来源可追溯 ${traceableCount}/${rows.length}`)
  console.log(`改参数后：新值进榜=${newInTop} 旧值让位=${!oldStillTop} 历史时点旧值可见=${oldInAsOf} 未来值泄漏=${newInAsOf}`)
  if (recallRate < 0.9 || oldStillTop || newInAsOf) process.exitCode = 1
}
