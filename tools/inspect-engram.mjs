// @ts-check
/**
 * 细看 Engram 的 schema 与样本，为迁移映射做准备。
 * **只读**。
 *
 *   node tools/inspect-engram.mjs
 */
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const ENGRAM_DIR = 'C:/Users/su/.dsh/engram'
const TARGETS = [
  'user.db',
  'project-7022370e5838aae5c77897be.db',
  'project-3b92d40c126b15da92301344.db',
]

function cols(db, table) {
  try {
    return db.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name + ':' + c.type)
  } catch {
    return []
  }
}

for (const file of TARGETS) {
  console.log('\n██████ ' + file + ' ██████')
  let db
  try {
    db = new DatabaseSync(join(ENGRAM_DIR, file), { readOnly: true })
  } catch (error) {
    console.log('打开失败:', error instanceof Error ? error.message : error)
    continue
  }
  for (const table of ['nodes', 'facts', 'entities', 'edges', 'node_entities', 'profile_blocks']) {
    let n = 0
    try { n = Number(db.prepare(`SELECT count(*) c FROM "${table}"`).get().c) } catch { continue }
    if (n === 0 && table !== 'nodes') continue
    console.log('\n-- ' + table + ' (' + n + ' 行)')
    console.log('   列:', cols(db, table).join(', '))
    try {
      const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid DESC LIMIT 3`).all()
      for (const r of rows) {
        const slim = {}
        for (const [k, v] of Object.entries(r)) {
          if (typeof v === 'string' && v.length > 160) slim[k] = v.slice(0, 160) + '…'
          else slim[k] = v
        }
        console.log('   ', JSON.stringify(slim))
      }
    } catch (error) {
      console.log('   抽样失败:', error instanceof Error ? error.message : error)
    }
  }
  db.close()
}
