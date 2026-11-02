// @ts-check
/**
 * 把 Engram 的记忆迁进外置大脑。
 *
 * **默认 dry-run，加 --apply 才真写。**
 *
 *   node tools/import-engram.mjs              # 预演：只报告会导什么
 *   node tools/import-engram.mjs --apply      # 真写
 *
 * 设计要点（都是有理由的，别随手改）：
 *
 * 1. **只迁 nodes 和 facts** —— 这两张表有 `content` 纯文本。entities/edges 是结构，
 *    先不迁（没有 content 可检索；关系边等外置大脑能表达关系时再说）。
 * 2. **不迁 embedding** —— Engram 存的是 2048 维浮点数组，我们的检索是 char-space FTS，
 *    两套向量不通。迁过来是死重。
 * 3. **保留来源** —— `sourceEventId = engram:<库名>:<原行 id>`，`originSystem = 'engram'`。
 *    契约 10.6 靠这个字段识别「这是二手来料」，不会被当成本系统的独立证据。
 * 4. **凭据必须脱敏** —— Engram 的正文里存着 FTP 明文密码。契约明令：密钥/凭据
 *    不写入普通记忆正文。所以命中凭据模式的一律替换成占位符再入库，并在报告里点名。
 * 5. **幂等** —— 用内容指纹去重：已存在同 content 的跳过。重复跑不会灌一堆重复。
 * 6. **失败不中断** —— 逐条 try/catch，最后汇总。一条坏数据不该让整次迁移停摆。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { openBrain } from '../packages/memory/src/index.js'

const ENGRAM_DIR = 'C:/Users/su/.dsh/engram'
const BRAIN_DB = 'E:/ds-h/dsh-brain/data/brain.db'
const MIGRATIONS = 'E:/ds-h/dsh-brain/migrations'
const SCOPE_ID = 'owner-default'
const PERSON_ID = 'owner'
/** 短于此长度的内容不迁：碎片没有检索价值，只会稀释召回 */
const MIN_CONTENT = 12
/** 单条内容上限，超了就截断（我们的 content 字段是 TEXT，但别灌进去几万字） */
const MAX_CONTENT = 2000

const APPLY = process.argv.includes('--apply')

/** content 指纹，用来跨库去重 */
const fingerprint = (text) => createHash('sha256')
  .update(String(text).replace(/\s+/g, ' ').trim())
  .digest('hex')
  .slice(0, 16)

/**
 * 凭据脱敏。
 * 为什么要做：Engram 里真的存着 `密码=xxxx` 这种明文。
 * 迁进来之前不处理，就等于把凭据抄进一个新的、将来可能被导出/备份的库。
 */
const SECRET_PATTERNS = [
  /(密码|口令|password|passwd|pwd)\s*[=:：]\s*\S+/gi,
  /(token|api[_-]?key|secret[_-]?key)\s*[=:：]\s*\S+/gi,
  /(ftp:\/\/[^\s:]+:)([^\s@]+)(@)/gi,
]
function redactSecrets(text) {
  let out = String(text)
  let hit = false
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, ...groups) => {
      hit = true
      // FTP URL 形式：保留账号部分，遮住密码
      if (groups.length >= 3 && /^ftp:\/\//i.test(m)) return groups[0] + '[凭据已移除]' + groups[2]
      return m.replace(/[=:：]\s*\S+/, '$&'.replace(/\S+$/, '')) .replace(/\s*\S+$/, ' [凭据已移除]')
    })
  }
  return { text: out, redacted: hit }
}

/** Engram kind → 我们的 type */
function mapType(kind, slotRoom) {
  const k = String(kind || slotRoom || '').toLowerCase()
  if (k === 'episode') return 'episode'
  if (k === 'decision') return 'semantic'
  if (k === 'fact') return 'semantic'
  if (k === 'preference') return 'profile'
  if (k === 'skill') return 'skill'
  if (k === 'commitment' || k === 'goal') return 'commitment'
  if (k === 'self') return 'self'
  if (k === 'relationship') return 'relationship'
  return 'semantic'
}

function safeAll(db, sql) {
  try { return db.prepare(sql).all() } catch { return [] }
}

function collectFromDb(file) {
  const out = []
  const path = join(ENGRAM_DIR, file)
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (error) {
    return { out, error: error instanceof Error ? error.message : String(error) }
  }

  // nodes：主线记忆
  for (const row of safeAll(db, "SELECT * FROM nodes WHERE status = 'active'")) {
    out.push({
      refId: 'engram:' + file + ':node:' + row.id,
      content: row.content,
      type: mapType(row.kind, row.slot_room),
      importance: typeof row.importance === 'number' ? row.importance : 0.5,
      confidence: typeof row.confidence === 'number' ? row.confidence : 0.5,
      createdAt: typeof row.created_at === 'number' ? row.created_at : null,
      sessionId: row.source_session_id || null,
      room: row.slot_room || null,
      kindRaw: row.kind || null,
      origin: 'node',
    })
  }

  // facts：实体事实链。content 是「关于某实体的一句话」
  for (const row of safeAll(db, 'SELECT * FROM facts')) {
    if (row.invalid_at != null) continue // 已失效的事实不迁（迁了就是复活旧结论）
    out.push({
      refId: 'engram:' + file + ':fact:' + row.id,
      content: row.content,
      type: 'semantic',
      importance: 0.55,
      confidence: 0.6,
      createdAt: typeof row.created_at === 'number' ? row.created_at : null,
      sessionId: null,
      room: 'fact',
      kindRaw: 'fact',
      origin: 'fact',
    })
  }

  db.close()
  return { out, error: null }
}

function main() {
  if (!existsSync(ENGRAM_DIR)) {
    console.error('找不到 Engram 目录：' + ENGRAM_DIR)
    process.exitCode = 1
    return
  }
  const files = readdirSync(ENGRAM_DIR).filter((f) => f.endsWith('.db') && !f.includes('pre-migration'))

  const report = { apply: APPLY, databases: [], totals: { collected: 0, tooShort: 0, redacted: 0, duplicates: 0, imported: 0, failed: 0 } }
  /** @type {{ refId: string, content: string, type: string, importance: number, confidence: number, createdAt: number|null, sessionId: string|null, room: string|null, kindRaw: string|null, origin: string, db: string }[]} */
  const collected = []

  for (const file of files) {
    const { out, error } = collectFromDb(file)
    const rec = { file, rows: out.length, error, kept: 0, tooShort: 0, redacted: 0 }
    for (const row of out) {
      report.totals.collected += 1
      if (!row.content || String(row.content).trim().length < MIN_CONTENT) {
        rec.tooShort += 1
        report.totals.tooShort += 1
        continue
      }
      // 脱敏必须在收集阶段就做：预演要能看见「哪些会被抹掉」，
      // 而不是等真写的时候才偷偷改。否则主人批准的是没脱敏的版本。
      const { text, redacted } = redactSecrets(String(row.content).slice(0, MAX_CONTENT))
      if (redacted) {
        rec.redacted += 1
        report.totals.redacted += 1
      }
      collected.push({ ...row, content: text, db: file })
      rec.kept += 1
    }
    report.databases.push(rec)
  }

  // 全局去重（跨库同内容只留一份）
  const seen = new Map()
  const unique = []
  for (const row of collected) {
    const fp = fingerprint(row.content)
    if (seen.has(fp)) {
      report.totals.duplicates += 1
      continue
    }
    seen.set(fp, row)
    unique.push(row)
  }

  if (!APPLY) {
    report.preview = unique.slice(0, 15).map((r) => ({
      type: r.type,
      importance: r.importance,
      from: r.db + ' / ' + r.origin,
      content: String(r.content).replace(/\s+/g, ' ').slice(0, 80),
    }))
    console.log(JSON.stringify(report, null, 2))
    console.log('\n（预演模式。加 --apply 才真写。将导入 ' + unique.length + ' 条）')
    return
  }

  // 真写：先看库里已有什么内容，避免重复
  const brain = openBrain({ dbPath: BRAIN_DB, migrationsDir: MIGRATIONS, bindings: { scope_id: SCOPE_ID, person_id: PERSON_ID } })
  const existing = new Set()
  try {
    const listed = brain.memories.list({ scopeId: SCOPE_ID, personId: PERSON_ID, limit: 5000 })
    for (const m of listed.items || []) {
      existing.add(fingerprint(m.content || m.summary || ''))
    }
  } catch { /* 空库也能继续 */ }

  const run = async () => {
    for (const row of unique) {
      const fp = fingerprint(row.content)
      if (existing.has(fp)) {
        report.totals.duplicates += 1
        continue
      }
      const { text, redacted } = redactSecrets(String(row.content).slice(0, MAX_CONTENT))
      if (redacted) report.totals.redacted += 1
      const summaryText = text.replace(/\s+/g, ' ').trim().slice(0, 60)
      try {
        const created = await brain.memories.create({
          scopeId: SCOPE_ID,
          personId: PERSON_ID,
          layer: 'long',
          type: row.type,
          content: text,
          summary: summaryText,
          // 迁来的内容是二手来料，用 summary 而不是 owner_words——不能冒充主人原话
          sourceType: 'summary',
          sourceIds: [],
          confidence: Math.max(0.3, Math.min(1, row.confidence)),
          importance: Math.max(0.1, Math.min(1, row.importance)),
          privacy: 'private',
          originSystem: 'engram',
          producer: 'tools/import-engram',
          ...(row.createdAt ? { validFrom: new Date(row.createdAt).toISOString() } : {}),
        })
        await brain.sources.link(created.id, {
          sourceKind: 'tool_call',
          sourceSystem: 'engram',
          sourceEventId: row.refId,
          locator: 'engram/' + row.db + '/' + row.origin,
        })
        existing.add(fp)
        report.totals.imported += 1
      } catch (error) {
        report.totals.failed += 1
        report.errors = report.errors || []
        if (report.errors.length < 10) {
          report.errors.push({ refId: row.refId, message: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    console.log(JSON.stringify(report, null, 2))
  }

  run().then(() => {
    try { brain.close?.() } catch { /* 忽略 */ }
  }).catch((error) => {
    console.error('导入失败:', error)
    process.exitCode = 1
  })
}

main()
