// @ts-check
/**
 * 迁移后验收：确认导进来的东西真的可用，且没有把凭据带进来。
 * **只读**。
 *
 *   node tools/verify-import.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { openBrain } from '../packages/memory/src/index.js'

const DB = 'E:/ds-h/dsh-brain/data/brain.db'
const MIGRATIONS = 'E:/ds-h/dsh-brain/migrations'
const SCOPE = 'owner-default'
const PERSON = 'owner'

const db = new DatabaseSync(DB, { readOnly: true })
const all = (sql, ...args) => { try { return db.prepare(sql).all(...args) } catch (e) { return [{ error: e.message }] } }
const one = (sql, ...args) => { try { return db.prepare(sql).get(...args) } catch (e) { return { error: e.message } } }

console.log('=== 1. 总量 ===')
const total = one("SELECT count(*) AS c FROM memories WHERE status != 'deleted'")
console.log('记忆总数:', total.c)
console.log('来源引用:', one('SELECT count(*) AS c FROM source_refs').c)

console.log('\n=== 2. 按类型 ===')
for (const r of all("SELECT type, count(*) AS c FROM memories WHERE status != 'deleted' GROUP BY type ORDER BY c DESC")) {
  console.log('  ', r.type, r.c)
}

console.log('\n=== 3. 按来源系统（engram = 迁移来的）===')
for (const r of all("SELECT origin_system, count(*) AS c FROM memories WHERE status != 'deleted' GROUP BY origin_system")) {
  console.log('  ', r.origin_system || '(null)', r.c)
}

console.log('\n=== 4. 凭据残留检查 ===')
const patterns = ['密码=', '密码：', 'password=', 'passwd=', 'token=', 'api_key=', 'apikey=', 'secret_key=', 'secret=']
let leaked = 0
for (const p of patterns) {
  const hits = all("SELECT id, substr(content, 1, 70) AS head FROM memories WHERE content LIKE ?", '%' + p + '%')
  if (hits.length && !hits[0].error) {
    leaked += hits.length
    console.log('  !! 命中 "' + p + '" ×', hits.length)
    for (const h of hits.slice(0, 3)) console.log('     ', h.id, '|', h.head)
  }
}
if (leaked === 0) console.log('  干净：正文里没有凭据形态的字符串')
else console.log('  合计可疑', leaked, '条（若只是「密码已移除」这类占位符则是正常的）')

console.log('\n=== 5. 迁入抽样 ===')
for (const r of all("SELECT id, type, importance, substr(content, 1, 64) AS head FROM memories WHERE origin_system = 'engram' ORDER BY created_at DESC LIMIT 5")) {
  console.log('  ·', r.type, '| imp=' + r.importance, '|', r.head)
}

db.close()

console.log('\n=== 6. 检索验证（走真实 memories.search）===')
const brain = openBrain({ dbPath: DB, migrationsDir: MIGRATIONS, bindings: { scope_id: SCOPE, person_id: PERSON } })
const probes = ['mumu.bio', 'Cloudflare', '反向代理', '踢脚线', '外置大脑']
for (const q of probes) {
  try {
    const r = brain.memories.search({ query: q, scopeId: SCOPE, personId: PERSON, limit: 3 })
    const top = r.hits[0]
    console.log('  [' + r.diagnostics.status + '] "' + q + '" → ' + r.hits.length + ' 条' + (top ? ' | 首条: ' + String(top.summary).slice(0, 46) : ''))
  } catch (e) {
    console.log('  [ERR] "' + q + '":', e instanceof Error ? e.message : e)
  }
}

console.log('\n=== 7. 星海数据点数 ===')
try {
  const listed = brain.memories.list({ scopeId: SCOPE, personId: PERSON, limit: 1000 })
  const items = listed.items || []
  const clusters = new Set(items.map((m) => m.type))
  console.log('  点:', items.length, '| 簇:', clusters.size, '| 簇名:', [...clusters].join(', '))
} catch (e) {
  console.log('  ERR:', e instanceof Error ? e.message : e)
}
try { brain.close?.() } catch { /* ignore */ }
