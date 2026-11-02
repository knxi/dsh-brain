// @ts-check
/**
 * tools/import-relationship-events.mjs —— 从真实会话记录补 `relationship_events`。
 *
 * ── 数据只从哪来 ──
 *
 * `C:\Users\su\.dsh\sessions\--E-ds-h--\<会话>\session.v4.jsonl.zstd`，逐帧解压，
 * 只取同时满足两条的事件：
 *   1. `event.type === 'user/message'`
 *   2. `event.data.source.kind === 'user'`
 * 再排除「**不是主人说的**」那部分：子代理会话（`delegationDepth > 0` 或带
 * `parentSession`）里的 `source.kind='user'` 是 agent 派活时注入的 prompt，
 * 不是主人开口——必须剔除，否则会把「派活」算成「聊天」。
 *
 * ── 一次互动怎么算 ──
 *
 * 同一会话里相隔不足 10 分钟的连续消息属于**同一次对话**，合并成一个互动段，
 * 段起点时间即事件时间。10 分钟这个口径不是随手取的：
 * `relationship.js` 的 `COOLDOWN_WINDOW_MS = 10 分钟`，聚合到 ≥10 分钟就不会
 * 出现「同一段对话被冷却窗口夹成 0 增量」的自欺欺人结果。
 *
 * ── 为什么走门面 ──
 *
 * 一律 `brain.persona.relationships.applyEvent()`：四维演化、单次幅度上限、
 * 冷却窗口、审计事件行都在门面里；直接 INSERT 等于绕过全部不变量。
 * 幂等键 `session-import:<会话>:<段起点毫秒>`，重复跑只会返回 duplicate，不会多写行。
 *
 * 用法：
 *   node tools/import-relationship-events.mjs                 # 只扫描 + 预览（默认 dry-run）
 *   node tools/import-relationship-events.mjs --apply         # 真写库
 *   node tools/import-relationship-events.mjs --apply --days 30
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { openBrain } from '../packages/memory/src/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const SESSIONS_ROOT = path.join(process.env.USERPROFILE ?? '', '.dsh', 'sessions', '--E-ds-h--')
/** zstd 帧魔数 */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 同一次对话的合并窗口（与 relationship.js 的冷却窗口对齐） */
const SESSION_GAP_MS = 10 * 60_000
/** 事件 kind（≤64 字符） */
const EVENT_KIND = 'conversation_user_message'
/**
 * 四维增量系数（每条真实互动段一次）。
 * 口径：`MAX_STEP_DELTA = 0.08` 是「一次强互动」的上限，一次普通对话按它的 1/13~1/27
 * 计；四维大小关系反映语义——熟悉 > 好感 > 信任 > 亲密（说私事最少发生）。
 */
const DELTAS = Object.freeze({ familiarity: 0.006, trust: 0.004, intimacy: 0.003, rapport: 0.005 })

function parseArgs(argv) {
  const args = { db: path.join(ROOT, 'data', 'brain.db'), apply: false, days: null, limit: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--db') { args.db = argv[i + 1]; i += 1 }
    else if (a === '--days') { args.days = Number(argv[i + 1]); i += 1 }
    else if (a === '--limit') { args.limit = Number(argv[i + 1]); i += 1 }
    else if (a === '--apply') args.apply = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

/** 切帧并逐帧解压（`zstdDecompressSync` 只解第一帧，所以必须按魔数切开）。 */
function decompressFrames(buf) {
  const offsets = []
  let cursor = 0
  while (true) {
    const at = buf.indexOf(FRAME_MAGIC, cursor)
    if (at < 0) break
    offsets.push(at)
    cursor = at + FRAME_MAGIC.length
  }
  /** @type {Buffer[]} */
  const chunks = []
  let failed = 0
  for (let k = 0; k < offsets.length; k += 1) {
    const start = offsets[k]
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(start, end)))
    } catch {
      // 魔数出现在压缩数据内部会误命中；解不开就跳过，最后一帧报错才算真问题
      if (k === offsets.length - 1) failed += 1
    }
  }
  return { text: Buffer.concat(chunks).toString('utf8'), frames: offsets.length, failed }
}

/**
 * 扫描一个会话文件：返回它的会话元信息 + 主人真实开口的时间点。
 * @param {string} sessionDir
 * @param {string} file
 */
function scanSession(sessionDir, file) {
  const { text, frames, failed } = decompressFrames(fs.readFileSync(file))
  /** @type {{ origin: string | null, delegationDepth: number, parentSession: string | null } | null} */
  let meta = null
  /** @type {{ at: number, chars: number }[]} */
  const userMessages = []
  let allUserKind = 0

  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === 'session' && meta === null) {
      meta = {
        origin: event.origin ?? null,
        delegationDepth: Number(event.delegationDepth ?? 0),
        parentSession: event.parentSession ?? null,
      }
    }
    if (event.type !== 'user/message') continue
    if (event.data?.source?.kind !== 'user') continue
    allUserKind += 1
    const content = event.data?.content
    const chars = Array.isArray(content)
      ? content.filter((c) => c?.type === 'text').reduce((n, c) => n + String(c.text ?? '').length, 0)
      : 0
    userMessages.push({ at: Number(event.time), chars })
  }

  const depth = Number(meta?.delegationDepth ?? 0)
  const parent = meta?.parentSession ?? null
  // 子代理会话里的 source.kind=user 是派活 prompt，不是主人说话
  const isHuman = depth === 0 && parent === null
  return { sessionDir, frames, failed, meta, allUserKind, isHuman, userMessages }
}

/**
 * 把一条会话里的消息压成互动段（间隔 < 10 分钟算同一段）。
 * @param {{ at: number, chars: number }[]} messages
 * @param {string} sessionDir
 */
function toSegments(messages, sessionDir) {
  const sorted = [...messages].sort((a, b) => a.at - b.at)
  /** @type {{ at: number, session: string, count: number, chars: number, lastAt: number }[]} */
  const segments = []
  for (const message of sorted) {
    const last = segments[segments.length - 1]
    if (last && message.at - last.lastAt < SESSION_GAP_MS) {
      last.count += 1
      last.chars += message.chars
      last.lastAt = message.at
      continue
    }
    segments.push({ at: message.at, session: sessionDir, count: 1, chars: message.chars, lastAt: message.at })
  }
  return segments
}

function fmt(ms) {
  return new Date(ms).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node tools/import-relationship-events.mjs [--apply] [--db <path>] [--days N] [--limit N]')
    return 0
  }
  if (!fs.existsSync(SESSIONS_ROOT)) {
    console.error(`会话目录不存在：${SESSIONS_ROOT}`)
    return 1
  }

  // ── 1) 扫描真实会话 ──
  const sessionDirs = fs
    .readdirSync(SESSIONS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  let files = 0
  let frames = 0
  let failedFrames = 0
  let userKindTotal = 0
  let excludedSubagent = 0
  /** @type {{ at: number, session: string, count: number, chars: number, lastAt: number }[]} */
  let segments = []

  for (const dir of sessionDirs) {
    const file = path.join(SESSIONS_ROOT, dir, 'session.v4.jsonl.zstd')
    if (!fs.existsSync(file)) continue
    files += 1
    const scanned = scanSession(dir, file)
    frames += scanned.frames
    failedFrames += scanned.failed
    userKindTotal += scanned.allUserKind
    if (!scanned.isHuman) {
      excludedSubagent += scanned.allUserKind
      continue
    }
    segments.push(...toSegments(scanned.userMessages, dir))
  }

  segments.sort((a, b) => a.at - b.at)
  const totalBeforeWindow = segments.length

  if (args.days !== null && Number.isFinite(args.days)) {
    const cutoff = Date.now() - args.days * 86_400_000
    segments = segments.filter((s) => s.at >= cutoff)
  }
  if (args.limit !== null && Number.isFinite(args.limit)) {
    segments = segments.slice(-args.limit)
  }

  console.log('── 扫描 ──')
  console.log(`会话文件：${files} 个，zstd 帧：${frames}，解不开的帧：${failedFrames}`)
  console.log(`source.kind='user' 消息：${userKindTotal} 条`)
  console.log(`  其中子代理会话（派活 prompt，已剔除）：${excludedSubagent} 条`)
  console.log(`  主人真实开口：${userKindTotal - excludedSubagent} 条`)
  console.log(`按 ${SESSION_GAP_MS / 60_000} 分钟合并成互动段：${totalBeforeWindow} 个`)
  console.log(`窗口过滤后待写：${segments.length} 个`)

  if (segments.length === 0) {
    console.error('没有可导入的互动段，停止。')
    return 1
  }

  const spanDays = Math.round((segments[segments.length - 1].at - segments[0].at) / 86_400_000)
  console.log(`时间范围：${fmt(segments[0].at)} → ${fmt(segments[segments.length - 1].at)}（跨度 ${spanDays} 天）`)
  /** @type {Record<string, number>} */
  const byDay = {}
  for (const s of segments) {
    const day = new Date(s.at).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
    byDay[day] = (byDay[day] ?? 0) + 1
  }
  console.log(`按天分布：${JSON.stringify(byDay)}`)
  const recent14 = segments.filter((s) => Date.now() - s.at <= 14 * 86_400_000)
  console.log(`近 14 天段数：${recent14.length}`)
  console.log(`将写入的增量（每段）：${JSON.stringify(DELTAS)} → 合计 ${segments.length} 段 ≈ ${JSON.stringify({
    familiarity: Number((segments.length * DELTAS.familiarity).toFixed(3)),
    trust: Number((segments.length * DELTAS.trust).toFixed(3)),
    intimacy: Number((segments.length * DELTAS.intimacy).toFixed(3)),
    rapport: Number((segments.length * DELTAS.rapport).toFixed(3)),
  })}`)

  if (!args.apply) {
    console.log('\n[dry-run] 没有打开数据库，没有写任何东西。加 --apply 才真写。')
    console.log(`前 3 段示例：${JSON.stringify(segments.slice(0, 3).map((s) => ({ at: fmt(s.at), session: s.session, count: s.count, chars: s.chars })), null, 1)}`)
    return 0
  }

  // ── 2) 写库（走门面 applyEvent）──
  const brain = openBrain({ dbPath: args.db, migrationsDir: path.join(ROOT, 'migrations') })
  try {
    const personId = 'owner'
    const stateBefore = brain.persona.relationships.getState({ personId })
    const statsBefore = brain.persona.relationships.stats({ personId })
    if (stateBefore === null) throw new Error(`关系状态不存在（person=${personId}）：先跑 node tools/init-person.mjs`)
    console.log('\n── 写前 ──')
    console.log(`关系四维：${JSON.stringify({
      familiarity: stateBefore.familiarity,
      trust: stateBefore.trust,
      intimacy: stateBefore.intimacy,
      rapport: stateBefore.rapport,
    })}`)
    console.log(`事件数：${statsBefore.events}`)

    let applied = 0
    let duplicated = 0
    let skipped = 0
    /** @type {Record<string, number>} */
    const skipReasons = {}
    /** @type {Record<string, number>} */
    const clampKinds = {}

    for (const segment of segments) {
      const idempotencyKey = `session-import:${segment.session}:${segment.at}`
      const result = await brain.persona.relationships.applyEvent({
        personId,
        kind: EVENT_KIND,
        deltas: DELTAS,
        evidenceRef: `session:${segment.session}`,
        idempotencyKey,
        notes: `真实会话互动：本段 ${segment.count} 条主人消息、约 ${segment.chars} 字`,
        at: segment.at,
      })
      if (result.applied) {
        applied += 1
        for (const [dim, info] of Object.entries(result.clamped ?? {})) {
          const key = `${dim}:${info.why.includes('冷却') ? 'cooldown' : 'step'}`
          clampKinds[key] = (clampKinds[key] ?? 0) + 1
        }
      } else if (result.duplicate) {
        duplicated += 1
      } else {
        skipped += 1
        const reason = String(result.reason ?? 'unknown')
        skipReasons[reason] = (skipReasons[reason] ?? 0) + 1
      }
    }

    const stateAfter = brain.persona.relationships.getState({ personId })
    const statsAfter = brain.persona.relationships.stats({ personId })
    console.log('\n── 写入结果 ──')
    console.log(`新增事件：${applied}，已存在跳过：${duplicated}，无增量跳过：${skipped}${skipped ? ` ${JSON.stringify(skipReasons)}` : ''}`)
    if (Object.keys(clampKinds).length) console.log(`被夹取的维度计数：${JSON.stringify(clampKinds)}`)
    console.log('── 写后 ──')
    console.log(`关系四维：${JSON.stringify({
      familiarity: stateAfter.familiarity,
      trust: stateAfter.trust,
      intimacy: stateAfter.intimacy,
      rapport: stateAfter.rapport,
    })}`)
    console.log(`事件数：${statsAfter.events}`)
    console.log(`事件时间范围：${statsAfter.oldestAtMs === null ? '—' : fmt(statsAfter.oldestAtMs)} → ${statsAfter.newestAtMs === null ? '—' : fmt(statsAfter.newestAtMs)}`)
    return 0
  } finally {
    await brain.close()
  }
}

main().then((code) => { process.exitCode = code }, (err) => {
  console.error('失败：', err instanceof Error ? err.stack ?? err.message : String(err))
  process.exitCode = 1
})

