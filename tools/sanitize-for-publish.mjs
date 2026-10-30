// @ts-check
/**
 * tools/sanitize-for-publish.mjs —— 发布前脱敏（把本机痕迹换成占位符）。
 *
 * 为什么需要它：这个仓库要推到 GitHub，而文档里到处都是 `C:\Users\su\...`
 * 这类绝对路径。泄露用户名不算大事，但没必要——而且本机路径会让别人
 * 直接抄了跑不通（他们会以为装在自己机器的这个位置）。
 *
 * 处理规则（保守，只换绝对路径与用户名，不动技术内容）：
 *   1. `C:\Users\<任何用户名>` → `C:\Users\<you>`（也处理正斜杠形态）
 *   2. `E:\ds-h\dsh-brain` → `<repo>`（项目根，别人路径不同）
 *   3. 不碰 `~/.dsh`、`data/`、代码里的相对路径
 *
 * 默认 dry-run（只报告会改什么）；加 `--apply` 才真写。
 * 幂等：重复跑第二次报告 0 处改动。
 *
 * 用法：
 *   node tools/sanitize-for-publish.mjs
 *   node tools/sanitize-for-publish.mjs --apply
 */

import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { globSync } from 'node:fs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/**
 * 只扫 **Markdown 文档**。
 *
 * 为什么不扫代码（.js/.mjs/.json/.yml）——踩过的坑，写在这里免得有人"顺手扩展"：
 * 代码里的绝对路径是**运行时路径**，不是文档痕迹。
 *   - `apps/brain-tools/cordis.patch.yml` 的 `storePath: 'E:/ds-h/dsh-brain/data/brain.db'`
 *     → 换成 `<repo>` 会让插件直接找不到库；
 *   - `apps/probe/*.mjs` 里 `C:/Users/su/.dsh/profiles/web` 是探针要读的真实 profile 路径；
 *   - 测试脚本的默认库路径同理。
 * 把它们"脱敏"等于把能跑的项目改成不能跑的项目。
 *
 * 文档里写本机路径是「记录」，代码里写是本「依赖」——两者处理方式不一样。
 */
const PATTERNS = ['**/*.md']
/** 这些目录不扫：依赖、数据、临时。 */
const SKIP_DIRS = ['node_modules', 'data', 'tmp', '_tmp', '.git']

const RULES = [
  // `(?!<you>)` 排除已经是占位符的情况——否则第二次跑会把 `C:\Users\<you>`
  // 再匹配一次、替换成同样的字符串，报告里就出现「0 个文件改动但 8 处命中」的怪数字。
  { name: '本机用户目录（反斜杠）', re: /C:\\Users\\(?!<you>)[^\\\s`'"]+/g, to: 'C:\\Users\\<you>' },
  { name: '本机用户目录（正斜杠）', re: /C:\/Users\/(?!<you>)[^/\s`'"]+/g, to: 'C:/Users/<you>' },
  { name: '项目绝对路径', re: /E:\\ds-h\\dsh-brain/g, to: '<repo>' },
  { name: '项目绝对路径（正斜杠）', re: /E:\/ds-h\/dsh-brain/g, to: '<repo>' },
]

/**
 * 收集待扫文件。用 fs.globSync（Node 22+），自己过滤 SKIP_DIRS——
 * 不依赖 .gitignore 解析，因为这条脚本要在「成为仓库之前」也能跑。
 * @returns {string[]}
 */
function collectFiles() {
  const out = []
  for (const pattern of PATTERNS) {
    let hits = []
    try {
      hits = globSync(pattern, { cwd: ROOT })
    } catch {
      continue
    }
    for (const rel of hits) {
      const normalized = String(rel).split(path.sep).join('/')
      if (SKIP_DIRS.some((dir) => normalized === dir || normalized.startsWith(`${dir}/`))) continue
      if (!out.includes(normalized)) out.push(normalized)
    }
  }
  return out.sort()
}

function main() {
  const apply = process.argv.includes('--apply')
  const files = collectFiles()
  const changed = []
  let totalHits = 0

  for (const rel of files) {
    const abs = path.join(ROOT, rel)
    let text
    try {
      text = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    let next = text
    const hitsPerRule = {}
    for (const rule of RULES) {
      const matched = next.match(rule.re)
      if (!matched) continue
      hitsPerRule[rule.name] = matched.length
      totalHits += matched.length
      next = next.replace(rule.re, rule.to)
    }
    if (next !== text) {
      changed.push({ rel, hits: hitsPerRule })
      if (apply) writeFileSync(abs, next, 'utf8')
    }
  }

  console.log(`扫描 ${files.length} 个文件，${apply ? '已' : '将'}脱敏 ${changed.length} 个，共 ${totalHits} 处`)
  for (const item of changed.slice(0, 20)) {
    const parts = Object.entries(item.hits).map(([k, v]) => `${k}×${v}`).join('、')
    console.log(`  ${item.rel}  （${parts}）`)
  }
  if (changed.length > 20) console.log(`  ……还有 ${changed.length - 20} 个文件`)

  if (!apply && changed.length > 0) {
    console.log('\n这是 dry-run。确认无误后加 --apply 真写。')
  }
  if (apply && changed.length === 0) {
    console.log('没有需要脱敏的内容（幂等）。')
  }
  return 0
}

process.exitCode = main()
