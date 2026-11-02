// @ts-check
/**
 * tools/check-m8.mjs —— 0008 迁移的体检脚本（只读）。
 *
 * 为什么要有它：0008 一次建 26 张表，靠人眼数表名会漏；靠「跑起来没报错」
 * 更不可靠——CREATE TABLE IF NOT EXISTS 和 DROP TABLE IF EXISTS 都会把
 * 明显的错吞掉（表建错了名字也是「没报错」）。所以这里逐个断言。
 *
 * 用法：
 *   node tools/check-m8.mjs                       # 检查默认生产库（只读）
 *   node tools/check-m8.mjs --db <path>           # 检查指定库
 *   node tools/check-m8.mjs --db <path> --expect 0008   # 同时断言 schema 版本
 *
 * 它**只读**：以只读方式打开，不跑迁移、不写任何东西。能安全指向生产库。
 */

import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/** 0008 应当建出来的 26 张表。少一张就是迁移没跑全，多一张是别人加的。 */
const M8_TABLES = [
  // 一、全局工作空间
  'ws_events', 'ws_consumers', 'ws_candidates', 'attention_focus',
  'memory_salience', 'affect_observations',
  // 二、反思 / 技能
  'reflection_runs', 'reflections', 'skill_stats', 'skill_lessons',
  // 三、免疫 / 脑干
  'immune_quarantine', 'health_alerts',
  // 四、人格
  'persona_profiles', 'persona_versions', 'persona_conflicts',
  // 五、人物模型 / 关系 / 社交
  'person_models', 'relationship_states', 'relationship_events',
  'proactive_policies', 'social_candidates', 'social_sends', 'response_decisions',
  // 六、自主指令
  'directives', 'directive_runs', 'directive_steps', 'brain_switches',
]

/** 0008 建出来的全部索引（含两个部分唯一索引，它们最容易被写错）。 */
const M8_INDEXES = [
  'ix_ws_events_scope_ms', 'ix_ws_events_channel', 'ix_ws_events_subject', 'ix_ws_events_module',
  'ix_ws_candidates_ready', 'ix_ws_candidates_kind', 'ix_ws_candidates_expiry', 'ix_ws_candidates_lease',
  'ix_memory_salience_scope', 'ix_affect_obs_person', 'ix_affect_obs_status',
  'ix_reflection_runs_started', 'ix_reflections_status', 'ix_reflections_run',
  'ix_skill_lessons_key',
  'ix_immune_status', 'ix_immune_subject',
  'ix_health_alerts_open', 'ux_health_alerts_open_code',
  'ux_persona_profiles_default', 'ux_persona_versions_active', 'ix_persona_versions_profile',
  'ix_persona_conflicts_open',
  'ix_relationship_events_person',
  'ix_social_candidates_queue', 'ix_social_candidates_pending',
  'ix_social_sends_candidate', 'ix_social_sends_at',
  'ix_response_decisions_at', 'ix_response_decisions_decision',
  'ix_directives_queue', 'ix_directives_parent',
  'ix_directive_runs_directive', 'ix_directive_runs_lease',
  'ix_directive_steps_run',
]

/** 默认开关：自主与主动社交默认必须是关闭的。 */
const EXPECTED_SWITCHES = {
  'autonomy.enabled': '0',
  'autonomy.max_level': 'L1',
  'social.enabled': '0',
  'social.allow_external': '0',
  'reflection.enabled': '0',
  'paused': '0',
}

function parseArgs(argv) {
  const args = { db: path.join(ROOT, 'data', 'brain.db'), expect: null }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--db') { args.db = argv[i + 1]; i += 1 }
    else if (a === '--expect') { args.expect = argv[i + 1]; i += 1 }
    else if (a === '--help' || a === '-h') { args.help = true }
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node tools/check-m8.mjs [--db <path>] [--expect <version>]')
    return 0
  }

  const db = new DatabaseSync(args.db, { readOnly: true })
  const problems = []
  const ok = []

  try {
    // schema 版本
    let version = null
    try {
      const row = db.prepare(
        "SELECT version FROM schema_migrations WHERE direction = 'up' ORDER BY CAST(version AS INTEGER) DESC LIMIT 1"
      ).get()
      version = row?.version ?? null
    } catch {
      problems.push('读不到 schema_migrations —— 这不像一个 brain 主账')
    }
    if (version) ok.push(`schema 版本 = ${version}`)
    if (args.expect && version !== args.expect) {
      problems.push(`schema 版本是 ${version}，期望 ${args.expect}`)
    }

    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all().map((r) => r.name)
    )
    const missingTables = M8_TABLES.filter((t) => !tables.has(t))
    if (missingTables.length) problems.push(`缺表: ${missingTables.join(', ')}`)
    else ok.push(`0008 的 26 张表全在`)

    const indexes = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
        .all().map((r) => r.name)
    )
    const missingIndexes = M8_INDEXES.filter((i) => !indexes.has(i))
    if (missingIndexes.length) problems.push(`缺索引: ${missingIndexes.join(', ')}`)
    else ok.push(`0008 的 ${M8_INDEXES.length} 个索引全在（含两个部分唯一索引）`)

    // 部分唯一索引真的生效吗？插两条 active 人格版本应该被拒。
    // 这个检查会写库，所以在只读打开时不跑；只在 --write-probe 且非生产库时跑。
    // 这里默认只做结构断言，行为断言交给 tests/。

    // fox_state 新增两列
    const foxCols = new Set(db.prepare('PRAGMA table_info(fox_state)').all().map((r) => r.name))
    const missingFox = ['stress', 'initiative'].filter((c) => !foxCols.has(c))
    if (missingFox.length) problems.push(`fox_state 缺列: ${missingFox.join(', ')}`)
    else ok.push('fox_state 已补 stress / initiative')

    // 默认开关
    if (tables.has('brain_switches')) {
      const rows = db.prepare('SELECT name, value FROM brain_switches').all()
      const map = new Map(rows.map((r) => [r.name, r.value]))
      for (const [k, v] of Object.entries(EXPECTED_SWITCHES)) {
        if (!map.has(k)) problems.push(`brain_switches 缺 ${k}`)
        else if (map.get(k) !== v) problems.push(`brain_switches.${k} = ${map.get(k)}，期望 ${v}（默认必须是关闭/保守的）`)
      }
      if (!problems.some((p) => p.includes('brain_switches'))) ok.push('六个默认开关值正确（自主/社交/反思默认关）')
    }

    // 现有记忆数（顺带报一下，确认没把主账弄坏）
    if (tables.has('memories')) {
      const c = db.prepare("SELECT count(*) AS c FROM memories WHERE status = 'active'").get()
      ok.push(`memories.active = ${c.c}`)
    }
  } finally {
    db.close()
  }

  console.log(`库: ${args.db}`)
  for (const line of ok) console.log(`  ok   ${line}`)
  for (const line of problems) console.log(`  FAIL ${line}`)
  if (problems.length) {
    console.log(`\n结论：${problems.length} 个问题`)
    return 1
  }
  console.log('\n结论：0008 结构体检通过')
  return 0
}

process.exitCode = main()
