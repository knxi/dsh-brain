// @ts-check
/**
 * 使用统计真机验收：读真实 usage.jsonl + 生产库 catalog，打印人话报告。
 *
 *   node tools/verify-usage.mjs
 *
 * **只读**，这条是硬纪律：
 * - 对 brain.db 一个字节都不写。打开时 `readOnly: true`；
 * - **不设置任何 PRAGMA**（连 `busy_timeout` 都不设——它是连接级设置，但这里按
 *   「最多 journal_mode 查询」的最严口径来处理），只 `PRAGMA journal_mode` 读一下；
 * - usage.jsonl 只读，不裁剪、不改写、不轮转。
 *
 * 为什么复用 apps/brain-tools/usage-log.js 而不是自己解析 JSONL：
 * 聚合口径必须和宿主插件里跑的是同一段代码。自己另写一份，验收出来的数就和线上
 * 看到的数对不上，那这份报告就白做了。
 *
 * 空日志（还没人查过）是**正常状态**，不是失败——退出码照样 0，只如实说一句
 * 「还没有检索记录」，覆盖率照算（此时全是「从没被查到」）。
 *
 * 退出码：
 *   0  跑通（含空日志）
 *   1  库打不开 / 读失败 / 被杀锁（SQLITE_BUSY）——如实报错，不重试死循环
 */

import { DatabaseSync } from 'node:sqlite'
import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  readUsageLog,
  summarizeUsage,
  computeCoverage,
  DEFAULT_WINDOW_DAYS,
} from '../apps/brain-tools/usage-log.js'
import { readUsedLaterLog, summarizeUsedLater } from '../apps/brain-tools/used-later.js'

/** 项目根（本文件在 tools/ 下一层） */
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DB_PATH = path.join(ROOT, 'data', 'brain.db')
/**
 * 使用日志路径。默认生产路径；`BRAIN_USAGE_LOG` 只用于「换目录部署」和
 * 「拿临时日志自测非空分支」——自测时绝不指向 data/logs，免得把生产日志碰了。
 */
const LOG_PATH = process.env.BRAIN_USAGE_LOG || path.join(ROOT, 'data', 'logs', 'usage.jsonl')
/**
 * usedLater sidecar 路径（M4.6）。同样默认生产路径；`BRAIN_USED_LATER_LOG`
 * 只用于换目录部署或自测非空分支——自测绝不指向 data/logs。
 */
const USED_LATER_LOG = process.env.BRAIN_USED_LATER_LOG || path.join(ROOT, 'data', 'logs', 'used-later.jsonl')
const SCOPE = 'owner-default'
const WINDOW_DAYS = DEFAULT_WINDOW_DAYS

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 百分比文案。null（无样本）显示成 —，不要显示 0%，那会误导成「算出来是零」。
 * @param {unknown} value
 * @returns {string}
 */
function rateText(value) {
  // 必须先判 null/undefined：Number(null) === 0，会把「没有样本」误显示成 0.0%
  if (value == null || value === '') return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return (n * 100).toFixed(1) + '%'
}

/**
 * 本地时间（YYYY-MM-DD HH:mm）。用本地时区，跟使用日志的 byDay 口径一致。
 * @param {unknown} ms
 * @returns {string}
 */
function fmtTime(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n <= 0) return '—'
  const d = new Date(n)
  const p = (/** @type {number} */ x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 把任意值压成单行、限长的展示文本。
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function head(value, max) {
  if (value == null) return '(空)'
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text) return '(空)'
  return text.length > max ? text.slice(0, max) + '…' : text
}

/**
 * 判断一个错误是不是「库被占用/被锁」。只用来决定报错文案，不做重试。
 * @param {unknown} err
 * @returns {boolean}
 */
function isBusy(err) {
  const msg = err instanceof Error ? err.message : String(err)
  return /SQLITE_BUSY|database is locked|database table is locked/i.test(msg)
}

const now = Date.now()
const since = now - WINDOW_DAYS * DAY_MS

console.log('=== 0. 环境 ===')
console.log('  项目根:', ROOT)
console.log('  主账库:', DB_PATH, existsSync(DB_PATH) ? '' : '（文件不存在！）')
console.log('  使用日志:', LOG_PATH)
console.log('  引用证据:', USED_LATER_LOG, existsSync(USED_LATER_LOG) ? '' : '（尚未产生）')
console.log('  统计窗口:', WINDOW_DAYS, '天（' + fmtTime(since) + ' ~ ' + fmtTime(now) + '）')

if (!existsSync(DB_PATH)) {
  console.error('\n[失败] 主账库不存在，无法做覆盖率验收。路径：' + DB_PATH)
  process.exit(1)
}

// ── 只读打开主账库 ───────────────────────────────────────────────
/** @type {DatabaseSync | null} */
let db = null
/** @type {Array<{ id: string, summary: string|null, type: string|null, importance: number|null }>} */
let catalog = []
/** 已封口的记忆条数（status='superseded'）：不进覆盖率分母，但要能看见。 */
let supersededTotal = 0
let journalMode = 'unknown'
let dbError = null

try {
  db = new DatabaseSync(DB_PATH, { readOnly: true })
  // 只查询，不设置：确认库是不是 WAL（WAL 下只读连接不会写 -wal/-shm）
  const pragmaRow = /** @type {{ journal_mode?: string } | undefined} */ (
    db.prepare('PRAGMA journal_mode').get()
  )
  journalMode = String(pragmaRow?.journal_mode ?? 'unknown')
  // 字段名已按 sqlite_master 实测确认，不是猜的。
  // 分母只算 status='active'：superseded 已被合并封口、检索永远查不到，
  // 算进来会让「从没被查到」榜塞满历史版本，把真正的语料缺口盖掉（2026-10-30 修）。
  const rows = /** @type {any[]} */ (
    db
      .prepare(
        "SELECT id, summary, type, importance FROM memories WHERE status = 'active' AND scope_id = ?",
      )
      .all(SCOPE)
  )
  // 已封口的条数单列出来，报告里要看得到「有多少条被取代过」。
  supersededTotal = Number(
    db.prepare("SELECT count(*) AS c FROM memories WHERE status = 'superseded' AND scope_id = ?").get(SCOPE)?.c ?? 0,
  )
  catalog = rows.map((r) => ({
    id: String(r.id),
    summary: r.summary ?? null,
    type: r.type ?? null,
    importance: r.importance == null ? null : Number(r.importance),
  }))
} catch (err) {
  dbError = err
} finally {
  try {
    db?.close()
  } catch {
    /* 关闭失败不掩盖原错误 */
  }
}

if (dbError) {
  const msg = dbError instanceof Error ? dbError.message : String(dbError)
  console.error('\n[失败] 读主账库出错，未做任何写入，已停下。')
  if (isBusy(dbError)) {
    console.error('  原因：库被占用（SQLITE_BUSY）。多半是宿主正在写。')
    console.error('  处理：等宿主空闲再跑这次验收；本脚本不做重试。')
  } else {
    console.error('  原因：', msg)
  }
  console.error('\nSUMMARY 库读取失败，未出报告')
  process.exit(1)
}

console.log('  日志模式:', journalMode, '| 有效记忆:', catalog.length, '条')
console.log('  打开方式: readOnly（未执行任何 PRAGMA 写操作）')

// ── 1. 读使用日志 ───────────────────────────────────────────────
const logExists = existsSync(LOG_PATH)
const logSize = logExists ? statSync(LOG_PATH).size : 0
const usage = readUsageLog(LOG_PATH, { since })
const summary = summarizeUsage(usage.entries, { now, windowDays: WINDOW_DAYS })

console.log('\n=== 1. 使用日志 ===')
if (!logExists) {
  console.log('  状态: 还没有检索记录（usage.jsonl 尚未创建）')
  console.log('  说明: 这是首次验收的正常状态，不是失败。等有人真的检索过，这个文件才会出现。')
} else if (summary.total === 0) {
  console.log('  状态: 文件存在（' + (logSize / 1024).toFixed(1) + ' KB），但窗口内没有检索记录')
  if (usage.total === 0) {
    console.log('  说明: 文件里一行可用记录都没有（可能只有空白行），也算「还没有检索记录」。')
  } else {
    console.log('  说明: 文件里有 ' + usage.total + ' 条记录，但都早于最近 ' + WINDOW_DAYS + ' 天。')
    console.log('        最近一次检索时间:', fmtTime(summary.lastAt))
  }
} else {
  console.log('  文件:', LOG_PATH)
  console.log('  大小:', (logSize / 1024).toFixed(1), 'KB | 窗口内记录:', summary.total, '条')
  if (usage.skipped > 0) {
    console.log('  坏行:', usage.skipped, '行（半截 JSON / 非对象），已跳过，不影响统计')
  }
  if (usage.truncated) {
    console.log('  注意: 文件超过尾读上限，只统计了尾部一段（更早的记录没算进来）')
  }
  console.log('  最近一次检索:', fmtTime(summary.lastAt))
}

// ── 2. 检索质量（窗口内）─────────────────────────────────────────
console.log('\n=== 2. 检索质量（窗口内）===')
if (summary.total === 0) {
  console.log('  窗口内没有检索记录，命中率 / 零命中 / 弱路降级暂无可统计的样本。')
} else {
  console.log('  检索次数:', summary.total, '次（成功', summary.okCount, '/ 失败', summary.failCount + '）')
  console.log(
    '  命中率:', rateText(summary.hitRate),
    '（' + summary.hitCount + ' 次至少命中 1 条 / ' + summary.zeroHitCount + ' 次一条没命中）',
  )
  console.log(
    '  弱路降级:', summary.laneMissCount, '次（占 ' + rateText(summary.laneMissRate) + '）',
    '— 主路没命中、靠弱检索救回来的次数，这是最该盯的指标',
  )
  if (summary.degradedCount > 0) {
    console.log('  另记 degraded:', summary.degradedCount, '次（占 ' + rateText(summary.degradedRate) + '）')
  }

  const channels = Object.entries(summary.byChannel)
  if (channels.length) {
    console.log('  来源分布:', channels.map(([k, v]) => k + '=' + v).join('  '))
  }
  const statuses = Object.entries(summary.byStatus)
  if (statuses.length) {
    console.log('  状态分布:', statuses.map(([k, v]) => k + '=' + v).join('  '))
  }

  if (summary.timing.samples > 0) {
    const t = summary.timing
    console.log(
      '  耗时: p50=' + (t.p50 ?? '—') + 'ms  p95=' + (t.p95 ?? '—') + 'ms  max=' + (t.max ?? '—') + 'ms  平均=' + (t.avg ?? '—') + 'ms',
    )
  }

  if (summary.zeroHitQueries.length === 0) {
    console.log('  零命中查询: 无（每次检索都至少命中一条）')
  } else {
    console.log('  零命中查询（前 5，按次数降序）:')
    for (const q of summary.zeroHitQueries.slice(0, 5)) {
      console.log('    · "' + head(q.query, 50) + '" 查了 ' + q.count + ' 次，一次没命中 | 最近 ' + fmtTime(q.lastAt))
    }
  }
}

// ── 3. 覆盖率 ───────────────────────────────────────────────────
const coverage = computeCoverage(
  { totalMemories: catalog.length, touchedIds: summary.touchedIds, catalog },
  { sampleLimit: 5 },
)
// stale 的口径跟 computeCoverage 走同一份实现，别在报告里各算一套（两套算法迟早会打架）。
// touchedSet 保留原始集合：下面按类型统计「从没被查到」时只遍历 catalog 里的 id，
// 多出来的 stale id 不会影响结果，而 coverage 那边已经把它从分子剔掉了。
const touchedSet = new Set(Array.isArray(summary.touchedIds) ? summary.touchedIds : [])
const staleTouched = Number(coverage.staleTouched) || 0

console.log('\n=== 3. 覆盖率 ===')
console.log('  全量有效记忆:', catalog.length, "条（scope_id='" + SCOPE + "'，status='active'）")
if (supersededTotal > 0) {
  console.log('  其中已封口（superseded，不进分母）:', supersededTotal, '条 —— 已合并的历史版本，检索查不到')
}
console.log('  窗口内被查到过:', coverage.touched, '条')
console.log('  从没被查到过:', coverage.neverHit, '条')
console.log('  覆盖率:', rateText(coverage.touchedRate))
if (staleTouched > 0) {
  console.log(
    '  说明: 命中 id 里有 ' + staleTouched + ' 个已不在当前 catalog（删过 / 已封口 / 换过 scope），',
  )
  console.log('        这几个已从分子里剔除，覆盖率不会因此虚高。')
}

if (catalog.length === 0) {
  console.log('  catalog 为空，没有可展示的样本。')
} else if (coverage.neverHitSamples.length === 0) {
  console.log('  全部记忆都被查到过，没有「从没被查到」的样本。')
} else {
  console.log('  从没被查到的 top ' + coverage.neverHitSamples.length + '（按 importance 降序）:')
  for (const m of coverage.neverHitSamples.slice(0, 5)) {
    console.log(
      '    · [' + (m.type || '未知类型') + '] imp=' + (m.importance == null ? '—' : m.importance) +
      ' | ' + head(m.summary, 46) + ' | ' + m.memoryId,
    )
  }
}

// 按类型看「从没被查到」的分布——比只看 top5 更容易发现整类没被用上
if (catalog.length > 0) {
  /** @type {Map<string, { total: number, missed: number }>} */
  const byType = new Map()
  for (const m of catalog) {
    const key = m.type || '(null)'
    const cur = byType.get(key) || { total: 0, missed: 0 }
    cur.total += 1
    if (!touchedSet.has(m.id)) cur.missed += 1
    byType.set(key, cur)
  }
  const list = [...byType.entries()].sort((a, b) => b[1].missed - a[1].missed || b[1].total - a[1].total)
  console.log('  按类型（从没被查到 / 总数）:')
  for (const [type, v] of list.slice(0, 8)) {
    console.log('    · ' + type + ': ' + v.missed + '/' + v.total)
  }
}

// ── 4. 引用（usedLater）────────────────────────────────────────
// 口径与 /api/usage、/dsh-brain/usage 页面共用 summarizeUsedLater 这一段代码，
// 自己另写一份解析的话，命令行报出来的数会和页面上的对不上。
const usedLaterRead = readUsedLaterLog(USED_LATER_LOG, { since })
const usedLater = summarizeUsedLater(usedLaterRead.entries, { now, windowDays: WINDOW_DAYS })

console.log('\n=== 4. 引用（usedLater：命中是否被回答用上）===')
if (!usedLaterRead.exists || usedLater.rows === 0) {
  console.log('  状态: 还没有可判定的引用证据（引用率 ' + rateText(usedLater.quoteRate) + '）')
  console.log('  说明: 这不是失败。证据只在「brain_search 命中 → 模型答完 → turn/end」之后才产生，')
  console.log('        还没走过一轮完整回合时这个文件不存在。文件缺失 ≠ 判定失败。')
} else {
  console.log('  证据行:', usedLater.rows, '行（命中', usedLater.hitRows, '+ 零命中检索', usedLater.noHitRetrievals + '）')
  console.log(
    '  引用率:', rateText(usedLater.quoteRate),
    '（' + usedLater.quotedCount + ' / ' + usedLater.hitRows + ' 条命中在回答里出现了连续 ≥' + usedLater.minQuoteChars + ' 字原文）',
  )
  console.log('  未判定:', usedLater.unjudgedCount, '条（命中但没检出连续原文——不等于没用上）')
  if (usedLaterRead.skipped > 0) {
    console.log('  坏行:', usedLaterRead.skipped, '行（半截 JSON / 非对象），已跳过')
  }
  // 最近几条只看判词，不看正文（sidecar 里本来也只有长度与哈希）
  const tail = usedLaterRead.entries.slice(-5)
  if (tail.length > 0) {
    console.log('  最近判定:')
    for (const row of tail) {
      const label = row.usedLater === true ? '引用' : '未判定'
      const why = row.usedLaterWhy ? '(' + row.usedLaterWhy + ')' : ''
      console.log(
        '    · ' + fmtTime(row.at) + ' | ' + label + why +
        ' | ' + (row.memoryId || '（零命中检索）') +
        (row.quoteLen != null ? ' | 连续 ' + row.quoteLen + ' 字 #' + row.quoteHash : ''),
      )
    }
  }
  console.log('  口径:', usedLater.note)
}

// ── 5. 结论 ─────────────────────────────────────────────────────
let verdict
if (summary.total === 0) {
  verdict = '还没有检索记录（空日志，正常状态）'
} else if (coverage.touched === 0) {
  verdict = '有检索但一条都没命中，需要查检索本身'
} else if (Number(summary.hitRate) < 0.5) {
  verdict = '命中率偏低，先看零命中查询里的词'
} else if (summary.laneMissCount > 0) {
  verdict = '命中正常，但有弱路降级，建议抽查降级那几次'
} else {
  verdict = '检索与覆盖率看起来正常'
}

console.log('\n=== 5. 结论 ===')
console.log('  ' + verdict)
console.log(
  '\nSUMMARY 窗口=' + WINDOW_DAYS + 'd 检索=' + summary.total +
  ' 命中率=' + rateText(summary.hitRate) +
  ' 零命中=' + summary.zeroHitCount +
  ' 弱路降级=' + summary.laneMissCount +
  ' 覆盖=' + coverage.touched + '/' + catalog.length + '(' + rateText(coverage.touchedRate) + ')' +
  ' 引用率=' + rateText(usedLater.quoteRate) + '(' + usedLater.quotedCount + '/' + usedLater.hitRows + ')' +
  ' 结论=' + verdict,
)
