#!/usr/bin/env node
// @ts-check
/**
 * tools/promote-to-plugin.mjs —— 把外置大脑从「patch 手插的裸插件」升级成「正规 profile 依赖」
 * （2026-11-02）。
 *
 * ── 为什么要有这一步 ──
 * 现在 dsh-brain 是靠 profile 的 `cordis.patch.yml` 里一条 `- insert:` 手插进去的。
 * 能跑、页面也在，但它**不属于「已安装插件」这个集合**：
 *   - 设置 → 插件 → 已安装插件 里看不到它；
 *   - 没有开关、没有卸载按钮；
 *   - 换电脑时也没人知道「这个插件该怎么装」。
 * 而 `dsh-fox-mood` 是正经依赖（`"dsh-fox-mood": "link:..."` + 进 `bundles`），
 * 所以它在列表里、能开关、能卸。本脚本把 dsh-brain 改成同一种形态。
 *
 * ── 为什么不跑 pnpm install ──
 * `dsh plugin install` 会跑 pnpm，按 lockfile 重建**整个** profile 的 node_modules。
 * 那台机器上装着十几个插件，版本漂移和拆坏目录的代价远大于收益
 * （2026-10-20 真踩过：服务运行时跑 pnpm install 把插件目录拆坏）。
 * 这里只做两件手工能保证等价的事：
 *   1. package.json 里写 `link:` 依赖 + 进 bundles  —— 这是「声明」
 *   2. `node_modules/@dsh-brain/brain-tools` 的 junction —— 这是「实现」
 * pnpm 只是按声明重建链接的工具；链接已经在位，就不需要它再动一遍。
 *
 * ── 用法 ──
 *   node tools/promote-to-plugin.mjs --dry-run        # 只看会改什么（默认就是 dry-run）
 *   node tools/promote-to-plugin.mjs --apply          # 真写（会先备份）
 *   node tools/promote-to-plugin.mjs --revert         # 从最近的备份还原
 *   node tools/promote-to-plugin.mjs --profile web --dsh-home "D:\x\.dsh"
 *
 * ⚠ 改完必须**重启 DSH** 才生效。重启前请先停服务再跑（本脚本只改文件，不停服务）。
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PLUGIN_NAME = '@dsh-brain/brain-tools'
const PLUGIN_DIR = join(REPO_ROOT, 'apps', 'brain-tools')

// ── 参数 ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const REVERT = argv.includes('--revert')
const flag = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && typeof argv[i + 1] === 'string' ? argv[i + 1] : fallback
}
const DSH_HOME = resolve(flag('--dsh-home', process.env.DSH_HOME || join(homedir(), '.dsh')))
const PROFILE_NAME = flag('--profile', 'web')
const PROFILE_DIR = join(DSH_HOME, 'profiles', PROFILE_NAME)
const PKG_PATH = join(PROFILE_DIR, 'package.json')
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')

const log = (msg) => console.log(msg)
const ok = (msg) => console.log(`  [ok]   ${msg}`)
const skip = (msg) => console.log(`  [skip] ${msg}`)
const todo = (msg) => console.log(`  [todo] ${msg}`)
const warn = (msg) => console.log(`  [warn] ${msg}`)

log('\n=== 外置大脑：升级为正规插件 ===\n')
log(`仓库：  ${REPO_ROOT}`)
log(`profile：${PROFILE_DIR}`)
log(`插件：  ${PLUGIN_NAME}  ->  ${PLUGIN_DIR}\n`)

if (!existsSync(PKG_PATH)) {
  console.error(`[x] 找不到 ${PKG_PATH} —— profile 不对，用 --profile 指定（web / desktop）`)
  process.exit(1)
}

/** 备份文件，返回备份路径 */
function backup(file) {
  if (!existsSync(file)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = `${file}.bak-promote-${stamp}`
  copyFileSync(file, dest)
  return dest
}

/** 找该 profile 下最近的一次 promote 备份 */
function latestBackup(file) {
  const dir = dirname(file)
  const base = file.split(/[\\/]/).pop() ?? ''
  const candidates = readdirSync(dir)
    .filter((name) => name.startsWith(`${base}.bak-promote-`))
    .sort()
  return candidates.length === 0 ? null : join(dir, candidates[candidates.length - 1])
}

// ── 回滚 ────────────────────────────────────────────────────────────────────

if (REVERT) {
  const pkgBak = latestBackup(PKG_PATH)
  const patchBak = latestBackup(PATCH_PATH)
  if (pkgBak === null && patchBak === null) {
    console.error('[x] 没找到 promote 备份，没什么可回滚的')
    process.exit(1)
  }
  for (const [file, bak] of [[PKG_PATH, pkgBak], [PATCH_PATH, patchBak]]) {
    if (bak === null) {
      skip(`${file} 没有备份，跳过`)
      continue
    }
    if (!APPLY) {
      todo(`将从 ${bak} 还原 ${file}`)
      continue
    }
    copyFileSync(bak, file)
    ok(`已还原 ${file}  <- ${bak}`)
  }
  if (!APPLY) log('\n（dry-run：加 --apply --revert 才真还原）')
  else log('\n✓ 回滚完成，重启 DSH 后恢复成「patch 手插」形态')
  process.exit(0)
}

// ── 1. package.json：加 link 依赖 + 进 bundles ──────────────────────────────

log('--- 1. profile package.json ---')
const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8'))
/** link: 协议，跟 dsh-fox-mood 同一种写法 */
const linkSpec = `link:${PLUGIN_DIR.replace(/\\/g, '/')}`

let pkgChanged = false
pkg.dependencies = pkg.dependencies ?? {}
if (pkg.dependencies[PLUGIN_NAME] === linkSpec) {
  skip(`dependencies 里已经有 ${PLUGIN_NAME}`)
} else {
  todo(`dependencies["${PLUGIN_NAME}"] = "${linkSpec}"`)
  pkg.dependencies[PLUGIN_NAME] = linkSpec
  pkgChanged = true
}

pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
if (pkg.dsh.profile.bundles.includes(PLUGIN_NAME)) {
  skip(`bundles 里已经有 ${PLUGIN_NAME}`)
} else {
  todo(`dsh.profile.bundles += "${PLUGIN_NAME}"`)
  pkg.dsh.profile.bundles.push(PLUGIN_NAME)
  pkgChanged = true
}

if (pkgChanged && APPLY) {
  const bak = backup(PKG_PATH)
  writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  ok(`已写回 package.json${bak ? `（备份 ${bak.split(/[\\/]/).pop()}）` : ''}`)
}

// ── 2. cordis.patch.yml：注释掉手写的 insert（避免重复插入）─────────────────

log('\n--- 2. cordis.patch.yml（去掉手写的 insert）---')

/**
 * 把包含 PLUGIN_NAME 的那段 `- insert:` 整块注释掉。
 * 只认「`- insert:` 之后的第一层列表项里出现 PLUGIN_NAME」这种结构；
 * 认不出就原样返回并在输出里报出来，绝不瞎改。
 * @param {string} text
 * @returns {{ next: string, changed: boolean, reason: string }}
 */
function commentOutInsert(text) {
  const lines = text.split('\n')
  /** 找包含包名的行 */
  const hitIndex = lines.findIndex((line) => line.includes(PLUGIN_NAME))
  if (hitIndex < 0) return { next: text, changed: false, reason: '没找到插入条目' }

  // 往上找最近的 `- insert:`
  let start = -1
  for (let i = hitIndex; i >= 0; i -= 1) {
    if (/^-\s*insert:\s*$/.test(lines[i])) {
      start = i
      break
    }
    // 撞到另一个顶层条目就放弃（结构不是我们以为的那样）
    if (/^-\s+\S/.test(lines[i]) && !/^\s/.test(lines[i])) break
  }
  if (start < 0) return { next: text, changed: false, reason: '找不到所属的 - insert: 块，没敢动' }

  // 往下找下一个顶层 `- ` 条目（块结束）
  let end = lines.length
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^-/.test(lines[i])) {
      end = i
      break
    }
  }

  const block = lines.slice(start, end)
  if (block.some((line) => line.includes('# [已由 promote-to-plugin 停用'))) {
    return { next: text, changed: false, reason: '已经注释过了' }
  }
  const commented = [
    '# [已由 promote-to-plugin 停用 2026-11-02] 现在走 package.json 的正规依赖 + bundles，',
    '# 不再需要手写 insert（重复插入会导致同一插件被加载两次）。',
    ...block.map((line) => (line.trim() === '' ? line : `# ${line}`)),
  ]
  return { next: [...lines.slice(0, start), ...commented, ...lines.slice(end)].join('\n'), changed: true, reason: 'ok' }
}

if (!existsSync(PATCH_PATH)) {
  skip('profile 没有 cordis.patch.yml，无需处理')
} else {
  const text = readFileSync(PATCH_PATH, 'utf8')
  const { next, changed, reason } = commentOutInsert(text)
  if (!changed) {
    skip(reason)
  } else if (!APPLY) {
    todo('将把那段 - insert: 整块注释掉')
  } else {
    const bak = backup(PATCH_PATH)
    writeFileSync(PATCH_PATH, next, 'utf8')
    ok(`已注释掉手写 insert${bak ? `（备份 ${bak.split(/[\\/]/).pop()}）` : ''}`)
  }
}

// ── 3. 确认链接在位 ────────────────────────────────────────────────────────

log('\n--- 3. node_modules 链接 ---')
const linkPath = join(PROFILE_DIR, 'node_modules', '@dsh-brain', 'brain-tools')
if (!existsSync(linkPath)) {
  warn(`缺 ${linkPath}`)
  warn('先跑 `node tools/install.mjs` 把链接建好，再回来跑这个脚本。')
} else {
  let linkedTo = ''
  try {
    const target = readFileSync(join(linkPath, 'package.json'), 'utf8')
    linkedTo = JSON.parse(target).name ?? ''
  } catch {
    linkedTo = ''
  }
  if (linkedTo === PLUGIN_NAME) ok(`链接在位且指向正确（读到包名 ${linkedTo}）`)
  else warn(`链接在，但读到的包名是 "${linkedTo}"，预期 ${PLUGIN_NAME} —— 检查它指向哪`)
}

// ── 收尾 ────────────────────────────────────────────────────────────────────

log('')
if (!APPLY) {
  log('这是 dry-run。确认无误后加 --apply 真写（会先自动备份）。')
  log('备份文件名形如 package.json.bak-promote-<时间戳>，--revert --apply 可还原。')
} else {
  log('✓ 文件已改好。生效方式：')
  log('  1. 停掉 DSH（关窗口 / Ctrl+C）')
  log('  2. 重新启动：dsh --profile ' + PROFILE_NAME)
  log('  3. 设置 → 插件 → 已安装插件，应该能看到「' + PLUGIN_NAME + '」并能开关')
  log('  4. 顺手验一下 http://127.0.0.1:3080/dsh-brain 还是 200')
  log('')
  log('  回滚：node tools/promote-to-plugin.mjs --revert --apply')
}
