// @ts-check
/**
 * 迁移前置：先看清两个外部记忆源里到底有什么。
 *
 * **只读**。不改别人的库、不写外置大脑。
 *
 * 为什么要有这一步：
 *   灵枢和 Engram 记的东西性质完全不同——灵枢存的是对话原文（role: user/assistant），
 *   Engram 存的是提炼过的事实/偏好。直接「全量搬」会把一堆对话碎片灌进外置大脑，
 *   检索质量反而更差。所以先量，再定迁移策略。
 *
 *   node tools/survey-memory-sources.mjs [--json]
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const HOME = 'C:/Users/su/.dsh'
const LINGSHU_DIR = join(HOME, '.dsh-memory', 'data', 'mdcg')
const ENGRAM_DIR = join(HOME, 'engram')

/** 极简 frontmatter 解析：只认 `key: value` 和 `key: ["a","b"]`，够用就好。 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!m) return { meta: {}, body: text }
  const meta = {}
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/)
    if (!kv) continue
    const key = kv[1]
    let raw = kv[2].trim()
    if (raw === 'null' || raw === '') { meta[key] = null; continue }
    if (raw === '[]') { meta[key] = []; continue }
    if (/^\[.*\]$/.test(raw)) {
      try { meta[key] = JSON.parse(raw) } catch { meta[key] = raw }
      continue
    }
    if (/^".*"$/.test(raw) || /^'.*'$/.test(raw)) { meta[key] = raw.slice(1, -1); continue }
    if (/^-?\d+(\.\d+)?$/.test(raw)) { meta[key] = Number(raw); continue }
    if (raw === 'true') { meta[key] = true; continue }
    if (raw === 'false') { meta[key] = false; continue }
    meta[key] = raw
  }
  return { meta, body: m[2] }
}

/** 递归列出目录下的 .md */
function walkMarkdown(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walkMarkdown(full, out)
    else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

function surveyLingshu() {
  if (!existsSync(LINGSHU_DIR)) return { available: false, reason: 'NOT_FOUND', dir: LINGSHU_DIR }
  const files = walkMarkdown(LINGSHU_DIR)
  const nodes = []
  for (const file of files) {
    let text
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const { meta, body } = parseFrontmatter(text)
    nodes.push({
      file: file.replace(/\\/g, '/'),
      id: meta.id || null,
      layer: meta.layer || null,
      role: meta.role || null,
      state: meta.lifecycle_state || null,
      importance: typeof meta.importance === 'number' ? meta.importance : null,
      confidence: typeof meta.confidence === 'number' ? meta.confidence : null,
      evidenceCount: typeof meta.evidence_count === 'number' ? meta.evidence_count : 0,
      sensitivity: meta.sensitivity || null,
      session: meta.session || null,
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      createdAt: typeof meta.created_at === 'number' ? meta.created_at : null,
      writer: meta.writer || null,
      edges: Array.isArray(meta.edges) ? meta.edges.length : 0,
      bodyLength: body.trim().length,
      bodyHead: body.trim().slice(0, 100),
    })
  }
  const countBy = (key) => {
    const map = new Map()
    for (const n of nodes) map.set(n[key] ?? '(null)', (map.get(n[key] ?? '(null)') || 0) + 1)
    return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]))
  }
  const candidates = nodes.filter((n) =>
    n.state === 'active' &&
    n.role !== 'assistant' &&
    n.bodyLength >= 20 &&
    (n.layer === 'knowledge' || n.layer === 'anchor' || n.layer === 'self' || n.layer === 'goals' || n.layer === 'structural' ||
     (n.importance != null && n.importance >= 0.5) || n.evidenceCount > 0))
  return {
    available: true,
    dir: LINGSHU_DIR,
    total: nodes.length,
    byLayer: countBy('layer'),
    byRole: countBy('role'),
    byState: countBy('state'),
    withEvidence: nodes.filter((n) => n.evidenceCount > 0).length,
    highImportance: nodes.filter((n) => (n.importance ?? 0) >= 0.5).length,
    candidateForMigration: candidates.length,
    samples: nodes.slice(0, 5).map((n) => ({ id: n.id, layer: n.layer, role: n.role, head: n.bodyHead })),
    candidates: candidates.slice(0, 10).map((n) => ({ id: n.id, layer: n.layer, importance: n.importance, head: n.bodyHead })),
  }
}

function surveyEngram() {
  if (!existsSync(ENGRAM_DIR)) return { available: false, reason: 'NOT_FOUND', dir: ENGRAM_DIR }
  const dbs = readdirSync(ENGRAM_DIR).filter((f) => f.endsWith('.db') && !f.includes('pre-migration'))
  const out = []
  for (const file of dbs) {
    const rec = { file, tables: [], counts: {}, error: null }
    try {
      const db = new DatabaseSync(join(ENGRAM_DIR, file), { readOnly: true })
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
      rec.tables = tables.map((t) => t.name)
      for (const t of rec.tables) {
        try {
          const c = db.prepare(`SELECT count(*) AS c FROM "${t}"`).get()
          rec.counts[t] = Number(c.c)
        } catch { rec.counts[t] = null }
      }
      // 如果有明显的记忆表，抽一行看形状
      for (const t of rec.tables) {
        if (/^(entries|memories|nodes|facts)$/.test(t) && rec.counts[t] > 0) {
          try {
            const row = db.prepare(`SELECT * FROM "${t}" LIMIT 1`).get()
            rec.sampleTable = t
            rec.sample = row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === 'string' ? String(v).slice(0, 90) : v])) : null
          } catch { /* 抽不到就算了 */ }
          break
        }
      }
      db.close()
    } catch (error) {
      rec.error = error instanceof Error ? error.message : String(error)
    }
    out.push(rec)
  }
  return { available: true, dir: ENGRAM_DIR, databases: out }
}

const report = {
  generatedAt: new Date().toISOString(),
  lingshu: surveyLingshu(),
  engram: surveyEngram(),
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(report, null, 2))
} else {
  console.log('=== 灵枢（' + report.lingshu.dir + '）===')
  if (!report.lingshu.available) {
    console.log('不可用:', report.lingshu.reason)
  } else {
    console.log('节点总数:', report.lingshu.total)
    console.log('按 layer:', JSON.stringify(report.lingshu.byLayer))
    console.log('按 role :', JSON.stringify(report.lingshu.byRole))
    console.log('按 state:', JSON.stringify(report.lingshu.byState))
    console.log('有证据的:', report.lingshu.withEvidence, '| 高重要度(>=0.5):', report.lingshu.highImportance)
    console.log('→ 值得迁移的候选:', report.lingshu.candidateForMigration)
    for (const c of report.lingshu.candidates) console.log('   ·', c.id, '(' + c.layer + ', imp=' + c.importance + ')', c.head)
  }
  console.log('')
  console.log('=== Engram（' + report.engram.dir + '）===')
  if (!report.engram.available) {
    console.log('不可用:', report.engram.reason)
  } else {
    for (const db of report.engram.databases) {
      console.log('---', db.file, db.error ? ('打开失败: ' + db.error) : '')
      if (!db.error) {
        const interesting = Object.entries(db.counts).filter(([, v]) => v > 0)
        console.log('  非空表:', interesting.map(([k, v]) => k + '=' + v).join(', ') || '(全空)')
        if (db.sample) console.log('  样例行(' + db.sampleTable + '):', JSON.stringify(db.sample).slice(0, 400))
      }
    }
  }
}
