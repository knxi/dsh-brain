// @ts-check
/**
 * tools/backup-before-migration.mjs —— 迁移前的一致性备份。
 *
 * 为什么不用裸拷贝文件：主账跑在 WAL 模式，`brain.db` + `-wal` + `-shm` 三个文件
 * 才构成完整状态；在服务运行中直接 copy 三个文件，有可能拿到「db 已更新但 wal 没带上」
 * 的中间态。`VACUUM INTO` 走 SQLite 自己的读事务，产出的是一致快照，且体积更小。
 *
 * 用法：
 *   node tools/backup-before-migration.mjs                    # 备到 data/backups/pre-migrate-<时间戳>/
 *   node tools/backup-before-migration.mjs --db <path> --out <dir>
 *   node tools/backup-before-migration.mjs --verify-only --db <backup.db>
 *
 * 退出码：0 成功 / 1 失败（失败必须让上层的迁移脚本停下来）。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function parseArgs(argv) {
  const args = {
    db: path.join(ROOT, 'data', 'brain.db'),
    out: null,
    verifyOnly: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--db') { args.db = argv[i + 1]; i += 1 }
    else if (a === '--out') { args.out = argv[i + 1]; i += 1 }
    else if (a === '--verify-only') args.verifyOnly = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

/** 读一个库的关键指标（只读打开）。 */
export function inspect(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const check = db.prepare('PRAGMA quick_check').get()
    let version = null
    try {
      version = db.prepare(
        "SELECT version FROM schema_migrations WHERE direction = 'up' ORDER BY CAST(version AS INTEGER) DESC LIMIT 1",
      ).get()?.version ?? null
    } catch { /* 老库可能没有迁移表 */ }
    const count = (sql) => {
      try { return Number(db.prepare(sql).get()?.c ?? 0) } catch { return null }
    }
    return {
      integrity: check ? Object.values(check)[0] : null,
      schemaVersion: version,
      activeMemories: count("SELECT count(*) AS c FROM memories WHERE status = 'active'"),
      entities: count('SELECT count(*) AS c FROM entities'),
      foxEvents: count('SELECT count(*) AS c FROM fox_events'),
    }
  } finally {
    db.close()
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node tools/backup-before-migration.mjs [--db <path>] [--out <dir>] [--verify-only]')
    return 0
  }
  if (!existsSync(args.db)) {
    console.error(`源库不存在：${args.db}`)
    return 1
  }

  if (args.verifyOnly) {
    const info = inspect(args.db)
    console.log(JSON.stringify({ db: args.db, ...info }, null, 2))
    return info.integrity === 'ok' ? 0 : 1
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const outDir = args.out ?? path.join(ROOT, 'data', 'backups', `pre-migrate-${stamp}`)
  mkdirSync(outDir, { recursive: true })
  const dest = path.join(outDir, 'brain.db')

  const srcInfo = inspect(args.db)
  console.log(`源库：${args.db}`)
  console.log(`  schema=${srcInfo.schemaVersion} active记忆=${srcInfo.activeMemories} 实体=${srcInfo.entities}`)

  const db = new DatabaseSync(args.db)
  try {
    // 路径用正斜杠：SQL 字符串里反斜杠是转义字符，Windows 路径会把它吃坏
    db.exec(`VACUUM INTO '${dest.replace(/\\/g, '/').replace(/'/g, "''")}'`)
  } finally {
    db.close()
  }

  const destInfo = inspect(dest)
  const size = statSync(dest).size
  console.log(`备份：${dest}（${(size / 1024 / 1024).toFixed(2)} MB）`)
  console.log(`  schema=${destInfo.schemaVersion} active记忆=${destInfo.activeMemories} 实体=${destInfo.entities}`)

  const problems = []
  if (destInfo.integrity !== 'ok') problems.push(`备份完整性检查失败：${destInfo.integrity}`)
  if (destInfo.schemaVersion !== srcInfo.schemaVersion) problems.push('备份的 schema 版本与源库不一致')
  if (destInfo.activeMemories !== srcInfo.activeMemories) problems.push('备份的记忆条数与源库不一致')

  if (problems.length) {
    console.error('\n备份校验失败：')
    for (const p of problems) console.error(`  - ${p}`)
    return 1
  }
  console.log('\n备份校验通过（integrity=ok，条数一致）')
  console.log(`回滚方法：把 ${dest} 覆盖回 ${args.db}（先停服务），并删掉残留的 brain.db-wal / brain.db-shm`)
  return 0
}

process.exitCode = main()
