// @ts-check
/**
 * 孤儿实体关联（M6.3）——「关于 X 我们都定过什么」查不全的补丁。
 *
 *   node tools/link-orphan-entities.mjs                 # 预演（默认，只读）
 *   node tools/link-orphan-entities.mjs --apply         # 真写
 *   node tools/link-orphan-entities.mjs --only 群星      # 只处理一个实体
 *   node tools/link-orphan-entities.mjs --limit 10 --min-length 2
 *
 * ── 背景 ──
 * 117 个实体里有 15 个是孤儿（挂 0 条活跃记忆）。其中 `群星` / `心海` / `外置大脑项目`
 * 这类明显该有记忆——它们是「关于 X 我们都定过什么」的入口。根因是补录结论性事实时
 * **只写了记忆、没挂实体关联**。
 *
 * ── 核心纪律：不猜 ──
 * 候选记忆必须满足：**正文或摘要里真的出现了实体名或它的某个 alias**（`includes` 子串）。
 * 不做相似度、不做语义匹配、不编造任何关联。**挂错的关系比没有关系难查得多**（CONTRACTS §13.4）。
 * 一个都没提到的实体如实报 `no_evidence`，一条都不建。
 *
 * ── 为什么 dry-run 用 SQL 读孤儿 ──
 * 门面 `entities.stats()` 只给孤儿**数量**，不给名单；`forMemory` 是「记忆→实体」方向。
 * dry-run 用只读连接直查（零写入），apply 时所有写都走门面（不绕过写队列与审计）。
 */

import { openBrain } from '../packages/memory/src/index.js'
import { pathToFileURL } from 'node:url'

const BRAIN_DB = 'E:/ds-h/dsh-brain/data/brain.db'
const MIGRATIONS = 'E:/ds-h/dsh-brain/migrations'
const DEFAULT_SCOPE = 'owner-default'
const DEFAULT_PERSON = 'owner'
/** 每条记忆命中片段前后各取多少字（只用于人读报告，不落库）。 */
const EXCERPT_PAD = 20
/** 建关系时的 role：表示「这条记忆提到过这个实体」。 */
const LINK_ROLE = 'mentioned_in'

const USAGE = `用法：
  node tools/link-orphan-entities.mjs                          预演（默认，不写库）
  node tools/link-orphan-entities.mjs --apply                  真写
  node tools/link-orphan-entities.mjs --only <实体名>           只处理一个实体
  node tools/link-orphan-entities.mjs --limit <n>              每个实体最多关联几条（默认 20）
  node tools/link-orphan-entities.mjs --min-length <n>         实体名最短长度（默认 2）
  node tools/link-orphan-entities.mjs --scope <scopeId>        指定 scope（默认 ${DEFAULT_SCOPE}）`

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = {
    apply: false,
    scopeId: DEFAULT_SCOPE,
    only: null,
    limit: 20,
    minLength: 2,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') out.apply = true
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else if (arg === '--scope') out.scopeId = String(argv[++i] ?? '')
    else if (arg === '--only') out.only = String(argv[++i] ?? '')
    else if (arg === '--limit') out.limit = Math.max(1, Number(argv[++i]) || 20)
    else if (arg === '--min-length') out.minLength = Math.max(1, Number(argv[++i]) || 2)
    else throw new Error(`未知参数：${arg}\n${USAGE}`)
  }
  return out
}

/**
 * 找出孤儿实体（挂 0 条活跃记忆）。
 * 只读直查：`stats()` 只给数量，拿不到名单；这里不写任何东西。
 *
 * @param {any} db
 * @param {string} scopeId
 * @returns {Array<{ id: string, name: string, kind: string, aliases: string[] }>}
 */
function findOrphans(db, scopeId) {
  const rows = db
    .prepare(
      `SELECT e.id, e.name, e.kind, e.aliases
         FROM entities e
        WHERE e.status = 'active' AND e.scope_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM memory_entities me
              JOIN memories m ON m.id = me.memory_id
             WHERE me.entity_id = e.id AND m.status = 'active'
          )
        ORDER BY e.name`,
    )
    .all(scopeId)
  return rows.map((/** @type {any} */ r) => {
    /** @type {string[]} */
    let aliases = []
    try {
      const parsed = typeof r.aliases === 'string' ? JSON.parse(r.aliases) : r.aliases
      if (Array.isArray(parsed)) aliases = parsed.filter((a) => typeof a === 'string' && a.length > 0)
    } catch {
      aliases = []
    }
    return { id: String(r.id), name: String(r.name), kind: String(r.kind), aliases }
  })
}

/**
 * 给一个实体找候选记忆：**正文或摘要里真的出现了实体名（或 alias）**。
 *
 * 只做 `includes` 判据——不做相似度、不做语义匹配。
 *
 * @param {any} db
 * @param {{ id: string, name: string, aliases: string[] }} entity
 * @param {{ scopeId: string, limit: number, minLength: number, excludeIds: Set<string> }} opts
 * @returns {Array<{ memoryId: string, summary: string|null, excerpt: string, matched: string, already: boolean }>}
 */
function findCandidates(db, entity, opts) {
  const needles = [entity.name, ...entity.aliases]
    .map((s) => s.trim())
    .filter((s) => s.length >= opts.minLength)
  if (needles.length === 0) return []

  /** @type {Map<string, { memoryId: string, summary: string|null, excerpt: string, matched: string }>} */
  const found = new Map()
  for (const needle of needles) {
    const like = `%${needle}%`
    const rows = db
      .prepare(
        `SELECT m.id, m.summary, m.content
           FROM memories m
          WHERE m.status = 'active' AND m.scope_id = ?
            AND (m.content LIKE ? OR m.summary LIKE ?)
          ORDER BY m.importance DESC, m.created_at DESC
          LIMIT ?`,
      )
      .all(opts.scopeId, like, like, opts.limit)
    for (const /** @type {any} */ row of rows) {
      const id = String(row.id)
      if (found.has(id) || opts.excludeIds.has(id)) continue
      const content = String(row.content ?? '')
      const summaryText = row.summary == null ? '' : String(row.summary)
      const haystack = content || summaryText
      const at = haystack.indexOf(needle)
      if (at < 0) continue
      // **路径片段不算提到实体**（2026-10-30 实测教训）：
      // 实体 `ds-h` 会在 `E:\ds-h\dsh-brain`、`E:\ds-h\_tools` 这类路径里命中 20+ 条，
      // 那是「文件路径里有个子串」，不是「这条记忆在说这个实体」。
      // 判据：命中位置的紧邻字符是路径分隔符 → 跳过。中文实体（群星/心海）不受影响。
      const before = haystack[at - 1] ?? ''
      const after = haystack[at + needle.length] ?? ''
      if (before === '\\' || before === '/' || after === '\\' || after === '/') continue
      const start = Math.max(0, at - EXCERPT_PAD)
      const end = Math.min(haystack.length, at + needle.length + EXCERPT_PAD)
      found.set(id, {
        memoryId: id,
        summary: row.summary == null ? null : summaryText,
        excerpt: (start > 0 ? '…' : '') + haystack.slice(start, end) + (end < haystack.length ? '…' : ''),
        matched: needle,
      })
    }
  }
  return [...found.values()].slice(0, opts.limit).map((item) => ({ ...item, already: false }))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log(`=== 孤儿实体关联（${args.apply ? '真写' : '预演'}）===`)
  console.log(`库：${BRAIN_DB} | scope：${args.scopeId} | 每实体上限 ${args.limit} | 名字最短 ${args.minLength}`)
  console.log(args.apply
    ? '--apply 走 openBrain()，会顺手应用未执行的迁移（CONTRACTS §13.7）。'
    : '本次不会写库：预演用 readOnly 连接打开。候选判据只有一条——正文/摘要里真的出现了实体名或 alias。')
  console.log('')

  const brain = await openBrain({
    dbPath: BRAIN_DB,
    migrationsDir: MIGRATIONS,
    bindings: { scope_id: args.scopeId, person_id: DEFAULT_PERSON },
    readOnly: !args.apply,
  })

  /** @type {Array<{ name: string, kind: string, action: string, candidates: any[], detail?: string }>} */
  const report = []

  try {
    const orphans = findOrphans(brain.db, args.scopeId)
    const targets = args.only === null ? orphans : orphans.filter((e) => e.name === args.only)
    console.log(`孤儿实体：${orphans.length} 个${args.only === null ? '' : `（本次只处理「${args.only}」→ ${targets.length} 个）`}`)
    console.log('')

    for (const entity of targets) {
      try {
        // 已关联的记忆要排除，否则会重复建
        /** @type {Set<string>} */
        const existing = new Set()
        const linked = brain.db
          .prepare(
            `SELECT me.memory_id FROM memory_entities me
               JOIN memories m ON m.id = me.memory_id
              WHERE me.entity_id = ? AND m.status = 'active'`,
          )
          .all(entity.id)
        for (const /** @type {any} */ row of linked) existing.add(String(row.memory_id))

        const candidates = findCandidates(brain.db, entity, {
          scopeId: args.scopeId,
          limit: args.limit,
          minLength: args.minLength,
          excludeIds: existing,
        })

        if (candidates.length === 0) {
          report.push({ name: entity.name, kind: entity.kind, action: 'no_evidence', candidates: [] })
          continue
        }

        if (!args.apply) {
          report.push({ name: entity.name, kind: entity.kind, action: 'would-link', candidates })
          continue
        }

        let created = 0
        for (const candidate of candidates) {
          try {
            const result = await brain.entities.linkMemory(candidate.memoryId, entity.id, { role: LINK_ROLE })
            if (result && result.linked === true) created += 1
          } catch (error) {
            // 一条失败不影响其余（跨 scope 拒绝、记忆被删等都在这里）
            candidate.error = messageOf(error)
          }
        }
        report.push({
          name: entity.name,
          kind: entity.kind,
          action: created > 0 ? 'linked' : 'no-new',
          candidates,
          detail: `新建 ${created} 条`,
        })
      } catch (error) {
        report.push({ name: entity.name, kind: entity.kind, action: 'failed', candidates: [], detail: messageOf(error) })
      }
    }
  } finally {
    await brain.close?.()
  }

  // ── 人读报告 ──
  const withEvidence = report.filter((r) => r.candidates.length > 0)
  const noEvidence = report.filter((r) => r.candidates.length === 0)
  console.log(`有证据 ${withEvidence.length} 个 / 无证据 ${noEvidence.length} 个`)
  console.log('')
  for (const row of withEvidence) {
    console.log(`· ${row.name} (${row.kind}) → ${row.candidates.length} 条候选${row.detail ? `，${row.detail}` : ''}`)
    for (const c of row.candidates) {
      console.log(`    - ${c.memoryId} 「${c.excerpt}」${c.matched === row.name ? '' : `（alias: ${c.matched}）`}${c.error ? ` [失败: ${c.error}]` : ''}`)
    }
  }
  if (noEvidence.length > 0) {
    console.log('')
    console.log('无证据（不建任何关联）：')
    console.log('  ' + noEvidence.map((r) => r.name).join(', '))
  }

  const planned = report.reduce((sum, r) => sum + r.candidates.length, 0)
  const linked = report.filter((r) => r.action === 'linked').reduce((sum, r) => sum + r.candidates.length, 0)
  console.log('')
  console.log(
    `SUMMARY mode=${args.apply ? 'apply' : 'dry-run'} scope=${args.scopeId} orphans=${report.length} ` +
      `with_evidence=${withEvidence.length} no_evidence=${noEvidence.length} ` +
      `candidates=${planned} links_${args.apply ? 'created' : 'planned'}=${args.apply ? linked : planned} ` +
      `failed=${report.filter((r) => r.action === 'failed').length}`,
  )
  if (report.some((r) => r.action === 'failed')) process.exitCode = 1
}

// 只有「直接跑这个文件」才执行 main；被测试 import 时不执行（否则一 import 就读生产库）。
const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    console.error(`[link-orphan-entities] 失败：${messageOf(error)}`)
    process.exitCode = 1
  })
}

export { findOrphans, findCandidates }
