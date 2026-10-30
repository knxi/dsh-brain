// @ts-check
/**
 * 合并「同义重复」记忆（观察期产物）—— 走 `supersedes`，绝不删。
 *
 *   node tools/merge-duplicates.mjs            # 预演（默认）：只报告会合并什么，不写库
 *   node tools/merge-duplicates.mjs --apply    # 真写
 *
 * ── 为什么是这几对 ──
 * 来自 2026-10-29 夜的观察期体检（`docs/OBSERVATION-2026-10-29.md` 第二、七节）：
 * 6 条 `contradicts` 里 4 条是同一件事的两种说法，另外检索实测又抓到一条「同一事实存了三遍」。
 * 判定标准是「是不是同一件事的两种说法」，**不是**「哪条更好看」：
 *
 * - 工作目录：`当前工作目录为 E:\ds-h` vs `DSH 当前项目工作目录为 E:\ds-h` —— 同一句，后者更短；
 * - 项目根目录：带「本轮我担任 teammate search / task-3」的那条 vs 纯事实 —— 前者多了一段**已过期**的
 *   团队角色信息，留着会污染「项目根」这条事实的检索；
 * - explicit 三工具：`只挂了三个显式工具` vs `只挂载 brain_search / brain_remember / brain_forget 三个…`
 *   —— 同一句，后者点名了工具；
 * - 星海 UI：`前端星海页面` vs `外置大脑（dsh-brain）的前端 UI` —— 同一句，后者指明了产品；
 * - 3d-memory-sea UI 三份重复：留信息最全的那条（带 dsh-brain + GitHub 项目名），另两条被它取代。
 *
 * 保留方向一律是「信息更全 / 没有过期上下文」的那条。**反了就是拿信息换重复。**
 *
 * ── 设计要点 ──
 * 1. **默认 dry-run**：`readOnly: true` 打开，不跑迁移、零写入。
 * 2. **走门面 `memories.supersede`**：它会封口旧条目（`status=superseded` + `valid_until`）、
 *    给新条目记 `supersedes`、并写 `memory_versions` 版本记录。**不删任何正文**，
 *    `asOf` 回看历史时刻仍能看到旧值——这正是「不自动选边」的落地方式。
 * 3. **顺带清掉结局已解决的 `contradicts` 边**：两条说的是同一件事，合并后还挂着「矛盾」红条
 *    就是在骗人。边是可重建的派生结构（`entities.js` 的注释写了为什么能真删），
 *    删前把重建 SQL 打到报告里。
 * 4. **幂等**：旧条目已经是 `superseded` 且 `supersedes` 指向同一条 → `already`，不再动。
 * 5. **失败不中断**：逐对 try/catch，最后汇总。
 *
 * ── 回滚 ──
 * `--apply` 的报告会打印回滚 SQL（把 status/valid_until/supersedes 复位 + 重建边）。
 * **真出事时用它，不要凭记忆手写。**
 */

import { existsSync } from 'node:fs'
import { openBrain } from '../packages/memory/src/index.js'

const BRAIN_DB = 'E:/ds-h/dsh-brain/data/brain.db'
const MIGRATIONS = 'E:/ds-h/dsh-brain/migrations'
const DEFAULT_SCOPE = 'owner-default'
const DEFAULT_PERSON = 'owner'
const DEFAULT_ACTOR = 'tools/merge-duplicates.mjs'
const BACKUP_DIR = 'E:/ds-h/dsh-brain/data/backups'

/**
 * 待合并清单：`oldId` 被 `newId` 取代。
 * 每条都带 `note`（为什么），报告里会原样打出来——半年后回看要能读懂当时的判断。
 *
 * @type {ReadonlyArray<{ oldId: string, newId: string, note: string }>}
 */
const PAIRS = Object.freeze([
  Object.freeze({
    oldId: 'mem_a72c5c6bed9b02c695a23e80',
    newId: 'mem_8a4f77b599b142aeaa526f08',
    note: '工作目录同一句，前者少了「当前」二字；留更明确的英文路径写法',
  }),
  Object.freeze({
    oldId: 'mem_8ed105ff55505ce79951878f',
    newId: 'mem_a2c8545eab415cfa8b090db9',
    note: '项目根目录同一句；前者多了已过期的「本轮担任 teammate search / task-3」',
  }),
  Object.freeze({
    oldId: 'mem_ad3d9150efc939b7268b96d5',
    newId: 'mem_b2ac1eb46b936d35df1493df',
    note: 'explicit 三工具同一句；后者点名了三个工具，信息更全',
  }),
  Object.freeze({
    oldId: 'mem_d15c64d56328ce0b7fe8a1d3',
    newId: 'mem_b624303a799918a286441509',
    note: '星海 UI 同一句；后者指明是「外置大脑（dsh-brain）的前端」，归属更准',
  }),
  Object.freeze({
    oldId: 'mem_d9eedfc310205a221c02bddc',
    newId: 'mem_b624303a799918a286441509',
    note: '3d-memory-sea UI 三份重复之一，留带 dsh-brain + GitHub 项目名的那条',
  }),
])

const USAGE = `用法：
  node tools/merge-duplicates.mjs            预演（默认，不写库）
  node tools/merge-duplicates.mjs --apply    真写
  node tools/merge-duplicates.mjs --scope <scopeId>   指定 scope（默认 ${DEFAULT_SCOPE}）`

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** @param {any} error */
function isBusy(error) {
  if (!error) return false
  const code = Number(error.errcode)
  if (new Set([5, 6, 517, 518, 261, 262]).has(code)) return true
  return /SQLITE_BUSY|SQLITE_LOCKED|database (table )?is locked/i.test(messageOf(error))
}
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 有限重试：只对撞锁重试（生产 dsh web 可能正开着 WAL），业务错误直接抛。
 * @template T
 * @param {() => T | Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withBusyRetry(fn) {
  /** @type {unknown} */
  let last
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      last = error
      if (!isBusy(error)) throw error
      await sleep(250 * (attempt + 1) ** 2)
    }
  }
  throw last
}

/** @param {string[]} argv */
function parseArgs(argv) {
  /** @type {{ apply: boolean, scopeId: string, reason: string }} */
  const out = { apply: false, scopeId: DEFAULT_SCOPE, reason: '合并同义重复记忆（观察期核验）' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--apply') out.apply = true
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else if (arg === '--scope') out.scopeId = String(argv[++i] ?? '')
    else if (arg === '--reason') out.reason = String(argv[++i] ?? '')
    else throw new Error(`未知参数：${arg}\n${USAGE}`)
  }
  return out
}

/** @returns {Promise<void>} */
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(BRAIN_DB)) throw new Error(`主账库不存在：${BRAIN_DB}`)

  const mode = args.apply ? 'apply' : 'dry-run'
  console.log(`=== 合并同义重复记忆（${args.apply ? '真写' : '预演'}）===`)
  console.log(`库：${BRAIN_DB}`)
  console.log(`scope：${args.scopeId}；清单：${PAIRS.length} 对；actor：${DEFAULT_ACTOR}`)
  if (args.apply) {
    console.log('--apply 走 openBrain()，会顺手应用未执行的迁移（CONTRACTS §13.7）——当前库已是 0006。')
    console.log(`备份建议：先做一致性快照到 ${BACKUP_DIR}（用 VACUUM INTO，别直接 copy .db：WAL 里的内容不在主文件里）。`)
  } else {
    console.log('本次不会写库：预演用 readOnly 连接打开，不跑迁移、不落一条 UPDATE。')
  }
  console.log('')

  const brain = await openBrain({
    dbPath: BRAIN_DB,
    migrationsDir: MIGRATIONS,
    bindings: { scope_id: args.scopeId, person_id: DEFAULT_PERSON },
    readOnly: !args.apply,
  })

  /** @type {Array<{ oldId: string, newId: string, action: string, note: string, detail?: string }>} */
  const results = []
  /** @type {string[]} */
  const rollback = []

  try {
    for (const pair of PAIRS) {
      try {
        const oldRow = await withBusyRetry(() => brain.memories.get(pair.oldId))
        const newRow = await withBusyRetry(() => brain.memories.get(pair.newId))

        if (!oldRow) {
          results.push({ ...pair, action: 'missing-old', detail: '旧条目不存在' })
          continue
        }
        if (!newRow) {
          results.push({ ...pair, action: 'missing-new', detail: '新条目不存在（拒绝合并到不存在的目标）' })
          continue
        }
        if (String(oldRow.status) === 'deleted') {
          results.push({ ...pair, action: 'skip-deleted', detail: '旧条目已删除' })
          continue
        }
        if (String(oldRow.status) === 'superseded') {
          const pointsToRight = String(oldRow.supersedes ?? '') === '' || String(oldRow.supersedes) === pair.newId
          if (pointsToRight) {
            results.push({ ...pair, action: 'already', detail: '已是 superseded 状态' })
            continue
          }
        }
        if (String(newRow.status) !== 'active') {
          results.push({ ...pair, action: 'skip-new-inactive', detail: `目标状态=${newRow.status}` })
          continue
        }

        // 结局已解决的 contradicts 边：合并后不该再报「矛盾」
        const edges = await withBusyRetry(() => brain.memoryEdges.forMemory(pair.oldId))
        const contradicting = [...edges.out, ...edges.in].filter((edge) => {
          if (String(edge.kind) !== 'contradicts') return false
          const other = String(edge.fromMemoryId) === pair.oldId ? edge.toMemoryId : edge.fromMemoryId
          return String(other) === pair.newId
        })

        if (!args.apply) {
          results.push({
            ...pair,
            action: 'would-merge',
            detail: `将封口旧条目并删 ${contradicting.length} 条 contradicts 边`,
          })
          continue
        }

        await withBusyRetry(() => brain.memories.supersede(pair.oldId, pair.newId, { scopeId: args.scopeId }))
        for (const edge of contradicting) {
          await withBusyRetry(() => brain.memoryEdges.remove(String(edge.id)))
        }
        results.push({
          ...pair,
          action: 'merged',
          detail: `已封口旧条目，删 ${contradicting.length} 条 contradicts 边`,
        })
        rollback.push(
          `UPDATE memories SET status='active', valid_until=NULL, valid_until_local=NULL, version=version+1 WHERE id='${pair.oldId}';`,
          `UPDATE memories SET supersedes=NULL, version=version+1 WHERE id='${pair.newId}';`,
          ...contradicting.map(
            (edge) =>
              `INSERT INTO memory_edges (id, scope_id, from_memory_id, to_memory_id, kind, reason, source_system, created_at, created_at_local) ` +
              `VALUES ('${edge.id}','${args.scopeId}','${edge.fromMemoryId}','${edge.toMemoryId}','contradicts',` +
              `${edge.reason === null ? 'NULL' : `'${String(edge.reason).replace(/'/g, "''")}'`},'restored','${new Date().toISOString()}','${new Date().toISOString()}');`,
          ),
        )
      } catch (error) {
        results.push({ ...pair, action: 'failed', detail: messageOf(error) })
      }
    }
  } finally {
    await brain.close?.()
  }

  console.log('合并清单（旧 → 新）：')
  for (const row of results) {
    console.log(`  · ${row.action.padEnd(12)} ${row.oldId} → ${row.newId}`)
    console.log(`      ${row.note}`)
    if (row.detail) console.log(`      ${row.detail}`)
  }
  console.log('')

  const count = (/** @type {string} */ action) => results.filter((row) => row.action === action).length
  if (args.apply && rollback.length > 0) {
    console.log('回滚 SQL（万一判断错了，照这个执行；不要凭记忆手写）：')
    for (const line of rollback) console.log(`  ${line}`)
    console.log('')
  }
  console.log(
    `SUMMARY mode=${mode} scope=${args.scopeId} planned=${PAIRS.length} ` +
      `merged=${count('merged')} would_merge=${count('would-merge')} already=${count('already')} ` +
      `failed=${count('failed')} skipped=${count('missing-old') + count('missing-new') + count('skip-deleted') + count('skip-new-inactive')}`,
  )
  if (count('failed') > 0 || count('missing-old') > 0 || count('missing-new') > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`[merge-duplicates] 失败：${messageOf(error)}`)
  process.exitCode = 1
})
