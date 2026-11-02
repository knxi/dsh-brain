// @ts-check
/**
 * tools/init-person.mjs —— 冷启动一个人物模型（幂等）。
 *
 * 为什么单独一个命令、而不是让程序自己建：
 * 「谁是我的对话对象」这件事**必须是显式动作**。让它自动建，等于系统自己
 * 决定了「有一个人存在、我跟他关系从 0.1 起步」——那是替主人做决定。
 *
 * 所以这里做成一次性初始化：建 `person_models` + `relationship_states` +
 * `proactive_policies` 各一行，全部取**最保守默认**（四维各 0.1、
 * 主动社交 enabled=1 但 daily_cap=2、只走控制台通道）。
 *
 * 用法：
 *   node tools/init-person.mjs                          # 生产库，person=owner，显示名=主人
 *   node tools/init-person.mjs --db <path> --person <id> --name <名字>
 *   node tools/init-person.mjs --dry-run                # 只看会写什么
 *
 * 幂等：已存在则只报告，不覆盖（避免把人工调过的关系值刷回默认）。
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openBrain } from '../packages/memory/src/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

function parseArgs(argv) {
  const args = {
    db: path.join(ROOT, 'data', 'brain.db'),
    person: 'owner',
    name: '主人',
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--db') { args.db = argv[i + 1]; i += 1 }
    else if (a === '--person') { args.person = argv[i + 1]; i += 1 }
    else if (a === '--name') { args.name = argv[i + 1]; i += 1 }
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node tools/init-person.mjs [--db <path>] [--person <id>] [--name <显示名>] [--dry-run]')
    return 0
  }

  const brain = openBrain({
    dbPath: args.db,
    migrationsDir: path.join(ROOT, 'migrations'),
    readOnly: args.dryRun,
  })
  try {
    const existing = brain.db
      .prepare('SELECT person_id, display_name, cold_start FROM person_models WHERE person_id = ?')
      .get(args.person)
    if (existing) {
      console.log(`已存在：person=${existing.person_id} 显示名=${existing.display_name} cold_start=${existing.cold_start}`)
      console.log('（幂等：不覆盖已有关系值，避免把你调过的亲密度刷回 0.1）')
      return 0
    }
    if (args.dryRun) {
      console.log(`[dry-run] 会建：person=${args.person} 显示名=${args.name}`)
      console.log('  四维初始：熟悉/信任/亲密/好感 = 0.1（保守冷启动，不继承任何人）')
      console.log('  主动社交策略：enabled=1、daily_cap=2、cooldown=180min、通道=仅控制台')
      return 0
    }
    const result = await brain.persona.persons.ensurePerson({
      personId: args.person,
      displayName: args.name,
    })
    console.log(`已建：${JSON.stringify(result)}`)
    const rel = brain.persona.relationships.getState({ personId: args.person })
    console.log(`关系四维：熟悉 ${rel.familiarity} / 信任 ${rel.trust} / 亲密 ${rel.intimacy} / 好感 ${rel.rapport}`)
    const policy = brain.persona.persons.getPolicy({ personId: args.person })
    console.log(`主动社交策略：${JSON.stringify(policy)}`)
    return 0
  } finally {
    await brain.close()
  }
}

main().then((code) => { process.exitCode = code }, (err) => {
  console.error('失败：', err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
