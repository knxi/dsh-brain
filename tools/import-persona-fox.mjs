// @ts-check
/**
 * tools/import-persona-fox.mjs —— 把 `~/.dsh/AGENTS.md`（小狐狸人格）导入成人格档案 + 首版并激活。
 *
 * 只走门面：`readPersonaFile` / `parsePersonaMarkdown` / `layersFromFields` /
 * `brain.persona.profiles.importFromFile` / `brain.persona.versions.activate`。
 * 不手写 INSERT —— 分层校验、diff、token 估算、状态流转全在门面里。
 *
 * 用法：
 *   node tools/import-persona-fox.mjs --dry-run     # 只解析、只打印，不写库
 *   node tools/import-persona-fox.mjs               # 写库并激活
 *   node tools/import-persona-fox.mjs --db <path> --file <path> --name <档案名> --by <操作者>
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PERSONA_FIELDS,
  estimateTokens,
  layersFromFields,
  parsePersonaMarkdown,
  readPersonaFile,
} from '../packages/persona/src/index.js'
import { openBrain } from '../packages/memory/src/index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const FIELD_LABELS = [
  ['identity', '身份'],
  ['values', '价值观'],
  ['boundaries', '边界'],
  ['tone', '语气'],
  ['address', '称呼'],
  ['relationshipDefaults', '关系'],
  ['taboos', '禁忌'],
  ['examples', '例子'],
  ['longTermDirectives', '长期指令'],
]

/**
 * 递归统计一个字段里的「字符串条目数 + 总字数」，并取一个预览串。
 * 字段形状有三种：字符串数组、对象（内含数组与字符串）、对象数组（examples）。
 * @param {unknown} value
 */
function tally(value) {
  /** @type {string[]} */
  const strings = []
  /** @param {unknown} node */
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string') {
      const s = node.trim()
      if (s) strings.push(s)
      return
    }
    if (Array.isArray(node)) { for (const item of node) walk(item); return }
    if (typeof node === 'object') { for (const item of Object.values(node)) walk(item) }
  }
  walk(value)
  return { items: strings.length, chars: strings.reduce((n, s) => n + s.length, 0), preview: strings[0] ?? '' }
}

function summarize(parsed, bytes) {
  console.log(`人格文件：${bytes} 字节`)
  console.log('解析字段（九字段）：')
  for (const [field, label] of FIELD_LABELS) {
    const t = tally(parsed.fields?.[field])
    const preview = t.preview ? t.preview.replace(/\s+/g, ' ').slice(0, 42) : '(空)'
    console.log(`  ${String(field).padEnd(20)} ${label.padEnd(5)} 条目=${String(t.items).padStart(3)} 字数=${String(t.chars).padStart(4)} ｜ ${preview}`)
  }
  const layers = layersFromFields(parsed.fields)
  console.log('五层：')
  for (const [layer, body] of Object.entries(layers)) {
    const keys = Object.keys(body ?? {})
    const chars = keys.reduce((n, k) => n + tally(body[k]).chars, 0)
    console.log(`  ${layer.padEnd(13)} 键=${String(keys.length).padStart(2)} 字数=${String(chars).padStart(4)} ｜ ${keys.join(',') || '(空)'}`)
  }
  console.log(`统计：${JSON.stringify(parsed.stats)}`)
  console.log(`需人工复核：${parsed.needsReview.length === 0 ? '无' : JSON.stringify(parsed.needsReview)}`)
  console.log(`被忽略的章节：${parsed.ignoredSections.length === 0 ? '无' : JSON.stringify(parsed.ignoredSections)}`)
  console.log(`章节角色表：`)
  for (const s of parsed.sections) {
    if (s.level === 0) continue
    console.log(`  ${'#'.repeat(s.level)} ${s.title.slice(0, 28).padEnd(30)} → ${s.roles.join(',') || '(未归类)'}`)
  }
  console.log(`渲染 token 估算：${estimateTokens(JSON.stringify(layers))}`)
  return layers
}

function parseArgs(argv) {
  const args = {
    db: path.join(ROOT, 'data', 'brain.db'),
    file: path.join(process.env.USERPROFILE ?? 'C:' + String.fromCharCode(92), '.dsh', 'AGENTS.md'),
    name: '小狐狸',
    by: 'persona-data',
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--db') { args.db = argv[i + 1]; i += 1 }
    else if (a === '--file') { args.file = argv[i + 1]; i += 1 }
    else if (a === '--name') { args.name = argv[i + 1]; i += 1 }
    else if (a === '--by') { args.by = argv[i + 1]; i += 1 }
    else if (a === '--dry-run') args.dryRun = true
    else if (a === '--help' || a === '-h') args.help = true
  }
  return args
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log('用法: node tools/import-persona-fox.mjs [--dry-run] [--db <path>] [--file <path>] [--name <名>] [--by <操作者>]')
    return 0
  }

  // ── 1) 纯函数解析（不碰库）──
  const file = readPersonaFile(args.file)
  const parsed = parsePersonaMarkdown(file.text)
  console.log(`sourceHash=${file.sourceHash}`)
  console.log(`mtime=${file.mtime}`)
  const layers = summarize(parsed, file.bytes)

  const unknown = PERSONA_FIELDS.filter((f) => !FIELD_LABELS.some(([k]) => k === f))
  if (unknown.length) console.log(`（PERSONA_FIELDS 里还有未展示字段：${unknown.join(',')}）`)

  if (args.dryRun) {
    console.log('\n[dry-run] 没有打开数据库，没有写任何东西。')
    return 0
  }

  // ── 2) 写库：导入 + 激活 ──
  const brain = openBrain({
    dbPath: args.db,
    migrationsDir: path.join(ROOT, 'migrations'),
  })
  try {
    const imported = await brain.persona.profiles.importFromFile({ filePath: args.file, name: args.name })
    console.log(`\n导入结果：${JSON.stringify(imported)}`)
    if (!imported.profileId) throw new Error('导入没有返回 profileId')

    const versions = brain.persona.versions.list({ profileId: imported.profileId })
    console.log(`档案 ${imported.profileId} 现有版本：${JSON.stringify(versions.items.map((v) => ({ id: v.id, version: v.version, status: v.status, tokens: v.tokens })))}`)

    const target = imported.versionId
      ? brain.persona.versions.get({ id: imported.versionId })
      : versions.items.find((v) => v.status !== 'rejected') ?? null
    if (!target) throw new Error('没有可激活的版本')

    const activated = await brain.persona.versions.activate(target.id, { by: args.by, reason: '补齐人格与关系数据：导入 ~/.dsh/AGENTS.md' })
    console.log(`激活结果：${JSON.stringify(activated)}`)

    const active = brain.persona.versions.getActive({ profileId: imported.profileId })
    console.log(`当前激活版本：${active ? JSON.stringify({ id: active.id, version: active.version, status: active.status, tokens: active.tokens }) : 'null'}`)
    const rendered = brain.persona.versions.renderForContext({ profileId: imported.profileId, maxTokens: 6000 })
    console.log(`渲染：tokens=${rendered.tokens} truncated=${rendered.truncated} 前 200 字=${JSON.stringify(rendered.text.slice(0, 200))}`)
    return 0
  } finally {
    await brain.close()
  }
}

main().then((code) => { process.exitCode = code }, (err) => {
  console.error('失败：', err instanceof Error ? err.stack ?? err.message : String(err))
  process.exitCode = 1
})

