// @ts-check
/**
 * tools/backup-manual-persona.mjs —— 「人格与关系数据」补数据前的手动备份。
 *
 * 为什么用 `sqlite.backup()` 而不是复制文件：
 * 生产库跑在 WAL 模式，`brain.db` + `-wal` + `-shm` 三个文件才是一份完整状态。
 * 服务正在 3080 上持有连接，裸 copy 拿到的是中间态；`backup()` 走 SQLite 自己的
 * 在线备份 API，页级一致快照，且对源库只加短暂读锁，不影响在跑的服务。
 *
 * 用法：
 *   node tools/backup-manual-persona.mjs                        # 默认落 data/backups/manual-before-persona-data-<ts>.db
 *   node tools/backup-manual-persona.mjs --db <path> --out <file>
 *   node tools/backup-manual-persona.mjs --verify-only --out <file>
 *
 * 输出：备份路径、字节数、源/备份两侧 integrity_check、关键表行数对照。
 * 退出码：0 成功（integrity=ok 且行数一致）/ 1 失败。
 */

import { DatabaseSync, backup } from 'node:sqlite'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 本次补数据会碰的表 + 作为「没被误伤」见证的表。 */
const WATCH_TABLES = [
  'memories',
  'person_models',
  'persona_profiles',
  'persona_versions',
  'persona_conflicts',
  'relationship_states',
  'relationship_events',
  'proactive_policies',
  'social_suggestions',
  'relationship_response_decisions',
]

function stampLocal() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function parseArgs(argv) {
  const args = { db: path.join(ROOT, 'data', 'brain.db'), out: null, verifyOnly: false, label: 'manual-before-persona-data' }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--db') { args.db = argv[i + 1]; i += 1 }
    else if (a === '--out') { args.out = argv[i + 1]; i += 1 }
    else if (a === '--label') { args.label = argv[i + 1]; i += 1 }
    else if (a === '--verify-only') args.verifyOnly = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  if (!args.out) args.out = path.join(ROOT, 'data', 'backups', `${args.label}-${stampLocal()}.db`)
  return args
}

/**
 * 只读打开一份库，读 integrity + 关键表行数。
 * @param {string} dbPath
 */
function inspect(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const integrity = String(Object.values(/** @type {any} */ (db.prepare('PRAGMA integrity_check').get() ?? {}))[0] ?? 'unknown')
    /** @type {Record<string, number | null>} */
    const counts = {}
    for (const table of WATCH_TABLES) {
      try {
        counts[table] = Number(/** @type {any} */ (db.prepare(`SELECT COUNT(*) AS c FROM "${table}"`).get())?.c ?? 0)
      } catch {
        counts[table] = null
      }
    }
    return { integrity, counts, bytes: statSync(dbPath).size }
  } finally {
    db.close()
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node tools/backup-manual-persona.mjs [--db <path>] [--out <file>] [--label <前缀>] [--verify-only]')
    return 0
  }

  if (args.verifyOnly) {
    if (!existsSync(args.out)) {
      console.error(`备份文件不存在：${args.out}`)
      return 1
    }
    const info = inspect(args.out)
    console.log(JSON.stringify({ out: args.out, ...info }, null, 1))
    return info.integrity === 'ok' ? 0 : 1
  }

  if (!existsSync(args.db)) {
    console.error(`源库不存在：${args.db}`)
    return 1
  }
  mkdirSync(path.dirname(args.out), { recursive: true })
  if (existsSync(args.out)) {
    console.error(`目标已存在，拒绝覆盖：${args.out}`)
    return 1
  }

  const before = inspect(args.db)
  console.log(`源库：${args.db}`)
  console.log(`  字节=${before.bytes} integrity=${before.integrity}`)
  console.log(`  行数=${JSON.stringify(before.counts)}`)

  // 在线备份：源库只读打开，交给 SQLite 的 backup API 做页级快照
  const src = new DatabaseSync(args.db, { readOnly: true })
  try {
    await backup(src, args.out)
  } finally {
    src.close()
  }

  const after = inspect(args.out)
  console.log(`备份：${args.out}`)
  console.log(`  字节=${after.bytes} integrity=${after.integrity}`)
  console.log(`  行数=${JSON.stringify(after.counts)}`)

  const diffs = WATCH_TABLES.filter((t) => before.counts[t] !== after.counts[t])
  if (after.integrity !== 'ok') {
    console.error(`✗ 备份 integrity_check 不是 ok：${after.integrity}`)
    return 1
  }
  if (diffs.length > 0) {
    console.error(`✗ 行数与源库不一致：${diffs.map((t) => `${t} ${before.counts[t]}→${after.counts[t]}`).join('; ')}`)
    return 1
  }
  console.log('✓ 备份完成，integrity=ok，关键表行数与源库一致')
  return 0
}

main().then((code) => { process.exitCode = code }, (err) => {
  console.error('失败：', err instanceof Error ? err.stack ?? err.message : String(err))
  process.exitCode = 1
})
