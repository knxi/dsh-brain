#!/usr/bin/env node
// @ts-check
/**
 * tools/install.mjs —— 把 dsh-brain 挂进一个 DSH profile（2026-11-02）。
 *
 * ── 为什么需要这个脚本 ──
 * 这套东西原来是「本机长出来的」：
 *   - 插件靠一个手建的 junction 挂进 profile 的 node_modules；
 *   - 内部 9 个 workspace 包靠 pnpm 建的 node_modules 链接互相 import；
 *   - 源码里 11 处路径写死 E:/ds-h/dsh-brain。
 * 换一台电脑时，README 只写了「已接在 ~/.dsh/profiles/web」——没有一句怎么接。
 * 于是现象就是：独立进程的治理面板（node apps/server/index.mjs，7420）能打开，
 * 其他 10 个页面和 3 个工具全 404 —— 因为插件压根没被挂上。
 *
 * ── 这个脚本干什么 ──
 * 不依赖 pnpm，直接按每个包 package.json 声明的依赖建 junction：
 *   1. workspace 包之间（@dsh-brain/*）互链
 *   2. apps/brain-tools 挂进 profile 的 node_modules（宿主按包名解析到它）
 *   3. 找宿主的 @deepseek-ai/dsh-tools，给插件链上（peerDependency，插件不装它）
 *   4. 往 profile 的 cordis.patch.yml 追加 `- insert:` 条目（幂等，已有就跳过）
 *   5. 建 data 目录并跑迁移建库（库已存在则只补缺的迁移）
 *   6. 自检：路径解析对不对、库能不能开、插件入口能不能 import
 *
 * ── 用法 ──
 *   node tools/install.mjs
 *   node tools/install.mjs --profile desktop
 *   node tools/install.mjs --dsh-home "D:\my\.dsh" --profile web
 *   node tools/install.mjs --dry-run          # 只打印计划，不动磁盘
 *   node tools/install.mjs --pin-paths        # 在 patch 里写死 storePath/migrationsDir
 *
 * 退出码：0 = 全部就绪；1 = 有阻断项（会在输出里点名是哪一条）。
 */

import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

/** dsh-brain 仓库根（tools/ 的上一级） */
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

// ── 参数 ────────────────────────────────────────────────────────────────────

/**
 * @typedef {{ profile: string, dshHome: string, dryRun: boolean, pinPaths: boolean }} Options
 */

/** @returns {Options} */
function parseArgs() {
  /** @type {Options} */
  const opts = { profile: '', dshHome: '', dryRun: false, pinPaths: false }
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--profile') opts.profile = String(argv[++i] ?? '')
    else if (token === '--dsh-home') opts.dshHome = String(argv[++i] ?? '')
    else if (token === '--dry-run') opts.dryRun = true
    else if (token === '--pin-paths') opts.pinPaths = true
    else if (token === '--help' || token === '-h') {
      console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 30).join('\n'))
      process.exit(0)
    } else {
      console.error(`不认识的参数：${token}（--help 看用法）`)
      process.exit(1)
    }
  }
  return opts
}

const opts = parseArgs()

// ── 小工具 ──────────────────────────────────────────────────────────────────

const OK = (msg) => console.log(`  [ok]   ${msg}`)
const SKIP = (msg) => console.log(`  [skip] ${msg}`)
const DO = (msg) => console.log(`  [do]   ${msg}`)
const WARN = (msg) => console.log(`  [warn] ${msg}`)
const FAIL = (msg) => {
  console.log(`  [FAIL] ${msg}`)
  return msg
}

/** @type {string[]} */
const blockers = []

/** @param {string} msg */
const block = (msg) => {
  blockers.push(msg)
  return FAIL(msg)
}

/** @param {string} p */
const exists = (p) => existsSync(p)

/**
 * 真实路径（不存在就返回 null，不抛）。
 * @param {string} p
 * @returns {string|null}
 */
const real = (p) => {
  try {
    return realpathSync(p)
  } catch {
    return null
  }
}

/** 规范化路径用于比较（Windows 大小写不敏感）。 */
const samePath = (a, b) => {
  const ra = real(a)
  const rb = real(b)
  if (ra === null || rb === null) return false
  return ra.toLowerCase() === rb.toLowerCase()
}

/**
 * 一个目录里的 package.json 声明的包名（读不到返回 null）。
 *
 * 为什么用「包名」而不是「realpath 对比」来判定链接是否就位：
 * pnpm 在 Windows 上建的 junction 目标写成 `Global\E:\...`，Node 的 realpathSync
 * 对这种形式会返回自身，readlinkSync 直接 EINVAL —— 两者都会把「已经建好的链接」
 * 误判成「指向别处」，然后整个安装器卡在自己造的冲突上（真踩过）。
 * 读目标目录里的 package.json 反而更准：它证明的不只是「链到了某处」，而是「链到了对的包」。
 * @param {string} dir
 * @returns {string|null}
 */
const packageNameAt = (dir) => {
  try {
    const pkg = readJson(join(dir, 'package.json'))
    return typeof pkg.name === 'string' ? pkg.name : null
  } catch {
    return null
  }
}

/**
 * 建目录链接（Windows 用 junction，不需要管理员；其它平台用目录软链）。
 * 幂等：已存在且包名对得上就跳过；包名不对就报冲突，绝不替你删。
 * @param {string} linkPath
 * @param {string} targetPath
 * @param {string} [expectName] 期望在链接目录里读到的包名
 */
function linkDir(linkPath, targetPath, expectName) {
  const absTarget = resolve(targetPath)
  if (!exists(absTarget)) throw new Error(`链接目标不存在：${absTarget}`)
  if (expectName && packageNameAt(absTarget) !== expectName) {
    throw new Error(`链接目标 ${absTarget} 的包名不是 ${expectName}（读到 ${packageNameAt(absTarget) ?? '无'}）`)
  }

  if (exists(linkPath)) {
    const actual = packageNameAt(linkPath)
    if (expectName ? actual === expectName : samePath(linkPath, absTarget)) {
      SKIP(`已就位 ${shorten(linkPath)}`)
      return 'exists'
    }
    throw new Error(
      `${linkPath} 已存在但内容不对（当前指向 ${actual ?? real(linkPath) ?? '?'}，想要 ${expectName ?? absTarget}）。`
      + ' 不会替你删，确认后手工删掉它再重跑。',
    )
  }

  if (opts.dryRun) {
    DO(`将链接 ${shorten(linkPath)} -> ${absTarget}`)
    return 'planned'
  }
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(absTarget, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
  DO(`链接 ${shorten(linkPath)} -> ${absTarget}`)
  return 'created'
}

/** 把长路径压短（只为了输出好读，不影响逻辑）。 */
function shorten(p) {
  const home = homedir()
  if (p.toLowerCase().startsWith(home.toLowerCase())) return '~' + p.slice(home.length)
  if (p.toLowerCase().startsWith(REPO_ROOT.toLowerCase())) return '.' + p.slice(REPO_ROOT.length)
  return p
}

/** @param {string} p @returns {any} */
function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'))
}

// ── 0. 预检 ─────────────────────────────────────────────────────────────────

console.log('\n=== dsh-brain 安装器 ===\n')
console.log(`仓库根：${REPO_ROOT}`)

const nodeMajor = Number(process.versions.node.split('.')[0])
const nodeMinor = Number(process.versions.node.split('.')[1])
const nodeOk = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13)
console.log(`Node：${process.versions.node} ${nodeOk ? '(ok，有 node:sqlite)' : '(太旧)'}`)
if (!nodeOk) block('Node 需要 >= 22.13（要用内置 node:sqlite）。先升级 Node。')

/** 必须存在的 workspace 目录 */
const REQUIRED_PACKAGES = ['core', 'memory', 'search', 'cognition', 'persona', 'workspace', 'directives', 'context']
for (const name of REQUIRED_PACKAGES) {
  if (!exists(join(REPO_ROOT, 'packages', name))) block(`缺 packages/${name} —— 仓库不完整（git clone 没拉全？）`)
}
if (!exists(join(REPO_ROOT, 'apps', 'brain-tools', 'index.js'))) block('缺 apps/brain-tools/index.js —— 仓库不完整')
if (!exists(join(REPO_ROOT, 'migrations'))) block('缺 migrations/ —— 仓库不完整')

// ── 1. 定位 DSH home 与 profile ─────────────────────────────────────────────

const DSH_HOME = resolve(opts.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'))
console.log(`DSH home：${DSH_HOME}`)

const profilesDir = join(DSH_HOME, 'profiles')
if (!exists(profilesDir)) {
  block(`找不到 ${profilesDir} —— DSH 装了吗？装过至少启动一次再来跑这个脚本。`)
}

/**
 * 找出要装进哪个 profile。
 * 显式 --profile 优先；否则挑一个既有 package.json 又有 cordis.patch.yml 的，优先 web。
 * @returns {string}
 */
function pickProfile() {
  if (opts.profile) {
    const p = join(profilesDir, opts.profile)
    if (!exists(p)) block(`profile 不存在：${p}`)
    return p
  }
  if (!exists(profilesDir)) return ''
  const preferred = ['web', 'desktop', 'cli']
  for (const name of preferred) {
    const p = join(profilesDir, name)
    if (exists(join(p, 'package.json'))) return p
  }
  // 兜底：profiles 下任意一个带 package.json 的
  try {
    for (const entry of readdirSync(profilesDir)) {
      const p = join(profilesDir, entry)
      if (exists(join(p, 'package.json'))) return p
    }
  } catch {
    /* 读不了就交给下面的 block */
  }
  return ''
}

const PROFILE_DIR = pickProfile()
if (!PROFILE_DIR) block('没找到可用的 profile（~/.dsh/profiles/{web,desktop} 都不存在）。用 --profile 指定。')
if (PROFILE_DIR) console.log(`profile：${PROFILE_DIR}\n`)

// ── 2. workspace 包互链 ─────────────────────────────────────────────────────

/** 收集所有 workspace 包（packages/* + apps/*，只认 @dsh-brain scope）。 */
function collectPackages() {
  /** @type {{ dir: string, name: string, deps: string[], kind: 'packages'|'apps' }[]} */
  const out = []
  for (const kind of /** @type {const} */ (['packages', 'apps'])) {
    const root = join(REPO_ROOT, kind)
    if (!exists(root)) continue
    for (const entry of readdirSync(root)) {
      const dir = join(root, entry)
      const pkgPath = join(dir, 'package.json')
      if (!exists(pkgPath)) continue
      try {
        const pkg = readJson(pkgPath)
        if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@dsh-brain/')) continue
        out.push({
          dir,
          name: pkg.name,
          deps: Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith('@dsh-brain/')),
          kind,
        })
      } catch {
        /* 坏 package.json 跳过 */
      }
    }
  }
  return out
}

const packages = collectPackages()
/** @type {Map<string, string>} name -> dir */
const packageDirs = new Map(packages.map((p) => [p.name, p.dir]))

console.log('--- 1. workspace 包互链 ---')
for (const pkg of packages) {
  for (const dep of pkg.deps) {
    const depDir = packageDirs.get(dep)
    if (!depDir) {
      WARN(`${pkg.name} 声明的 ${dep} 不在本仓库里（跳过）`)
      continue
    }
    try {
      linkDir(join(pkg.dir, 'node_modules', '@dsh-brain', dep.replace('@dsh-brain/', '')), depDir, dep)
    } catch (error) {
      block(`${pkg.name} -> ${dep} 链接失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// brain-tools 运行时有动态 import('@dsh-brain/memory')，不在 package.json 的 dependencies 里。
// 把 packages/ 下的库包都链进去：几个 junction 无害，将来加 import 也不会断。
// apps/ 里的其它 app（connector/console/probe/server）互相没有依赖，不链。
const brainToolsDir = join(REPO_ROOT, 'apps', 'brain-tools')
if (exists(brainToolsDir)) {
  for (const pkg of packages) {
    if (pkg.kind !== 'packages') continue
    try {
      linkDir(
        join(brainToolsDir, 'node_modules', '@dsh-brain', pkg.name.replace('@dsh-brain/', '')),
        pkg.dir,
        pkg.name,
      )
    } catch (error) {
      block(`brain-tools -> ${pkg.name} 链接失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

// ── 3. 把插件挂进 profile ───────────────────────────────────────────────────

console.log('\n--- 2. 挂进 profile ---')
if (PROFILE_DIR) {
  try {
    linkDir(join(PROFILE_DIR, 'node_modules', '@dsh-brain', 'brain-tools'), brainToolsDir, '@dsh-brain/brain-tools')
  } catch (error) {
    block(`插件挂进 profile 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 4. 给插件接上宿主的 @deepseek-ai/dsh-tools ──────────────────────────────

console.log('\n--- 3. peerDependency: @deepseek-ai/dsh-tools ---')
/**
 * 插件 `import { defineTool } from '@deepseek-ai/dsh-tools'`。
 * 插件文件在仓库里（不在 profile 的 node_modules 下），Node 的解析只会往仓库上层走，
 * 走不到 ~/.dsh/profiles/<profile>/node_modules —— 所以这里必须显式链一个过去。
 * 目标按可靠性排序：profile 里那个（宿主真正在用的版本）> 全局 npm 的 dsh > 环境变量 DSH_CHECKOUT。
 * @returns {string|null}
 */
function findHostDshTools() {
  /** @type {string[]} */
  const candidates = []
  if (PROFILE_DIR) candidates.push(join(PROFILE_DIR, 'node_modules', '@deepseek-ai', 'dsh-tools'))
  const envCheckout = process.env.DSH_CHECKOUT
  if (envCheckout) candidates.push(join(envCheckout, 'node_modules', '@deepseek-ai', 'dsh-tools'))

  /** @param {string} file @param {string[]} args */
  const tryExec = (file, args) => {
    try {
      return execFileSync(file, args, { encoding: 'utf8', timeout: 20000, windowsHide: true }).trim()
    } catch {
      return ''
    }
  }

  // 全局 npm 根。Windows 上直接 execFileSync('npm.cmd') 会 EINVAL（.cmd 必须经 cmd /c）。
  const npmRoot = process.platform === 'win32'
    ? tryExec(process.env.ComSpec || 'cmd.exe', ['/c', 'npm root -g'])
    : tryExec('npm', ['root', '-g'])
  if (npmRoot) {
    candidates.push(join(npmRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools'))
    candidates.push(join(npmRoot, '@deepseek-ai', 'dsh-tools'))
  }

  // 连 npm 都调不到时的常见位置兜底
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? ''
    if (appData) {
      candidates.push(join(appData, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools'))
    }
  } else {
    for (const prefix of ['/usr/local/lib/node_modules', '/usr/lib/node_modules']) {
      candidates.push(join(prefix, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-tools'))
    }
  }

  for (const candidate of candidates) {
    if (real(candidate) !== null) return candidate
  }
  return null
}

const dshToolsTarget = findHostDshTools()
if (dshToolsTarget === null) {
  block(
    '找不到宿主的 @deepseek-ai/dsh-tools。插件靠它拿 defineTool，没有它加载就抛。'
    + ' 确认 DSH 装过（npm i -g @deepseek-ai/dsh）并用 --dsh-home 指到正确的 home。',
  )
} else {
  try {
    linkDir(
      join(brainToolsDir, 'node_modules', '@deepseek-ai', 'dsh-tools'),
      dshToolsTarget,
      '@deepseek-ai/dsh-tools',
    )
  } catch (error) {
    block(`接 dsh-tools 失败：${error instanceof Error ? error.message : String(error)}`)
  }
}

// ── 5. 写 profile 的 cordis.patch.yml ───────────────────────────────────────

console.log('\n--- 4. profile 的 cordis.patch.yml ---')
if (PROFILE_DIR) {
  const patchPath = join(PROFILE_DIR, 'cordis.patch.yml')
  const marker = '@dsh-brain/brain-tools'
  let text = exists(patchPath) ? readFileSync(patchPath, 'utf8') : ''

  if (text.includes(marker)) {
    SKIP(`patch 里已经有 ${marker} 的条目`)
    // 只提示：老安装可能写死了旧路径
    if (/storePath:\s*['"]?[A-Za-z]:[\\/]/.test(text)) {
      WARN('patch 里 storePath 是写死的绝对路径。换目录后会自动失效，建议删掉那两行让它自动推导。')
    }
  } else {
    const blockYaml = [
      '',
      '',
      '# ── 外置大脑（由 tools/install.mjs 写入，2026-11-02）─────────────────',
      '# 只挂显式工具：brain_search / brain_remember / brain_forget，不挂注入。',
      '# 库位置默认由插件自己从仓库位置推导（apps/brain-tools/brain-home.js）。',
      '# 要钉死位置：--pin-paths 重跑，或手工加 storePath / migrationsDir。',
      '- insert:',
      '    - id: brain-tools',
      `      name: '${marker}'`,
      '      config:',
      "        scopeId: 'owner-default'",
      "        personId: 'owner'",
    ]
    if (opts.pinPaths) {
      blockYaml.push(`        storePath: '${posix(join(REPO_ROOT, 'data', 'brain.db'))}'`)
      blockYaml.push(`        migrationsDir: '${posix(join(REPO_ROOT, 'migrations'))}'`)
    }
    const addition = blockYaml.join('\n') + '\n'

    if (opts.dryRun) {
      DO(`将向 ${shorten(patchPath)} 追加 ${marker} 的 insert 条目`)
    } else {
      mkdirSync(dirname(patchPath), { recursive: true })
      if (text.length > 0 && !text.endsWith('\n')) appendFileSync(patchPath, '\n', 'utf8')
      appendFileSync(patchPath, addition, 'utf8')
      DO(`已向 ${shorten(patchPath)} 追加 insert 条目`)
    }
  }
}

/** 正斜杠路径（cordis 的 yaml 里用正斜杠更一致）。 */
function posix(p) {
  return p.replace(/\\/g, '/')
}

// ── 6. 数据目录 + 迁移 ──────────────────────────────────────────────────────

console.log('\n--- 5. 数据目录与库 ---')
const DATA_DIR = join(REPO_ROOT, 'data')
const DB_PATH = join(DATA_DIR, 'brain.db')

for (const sub of ['', 'logs', 'persona', 'blobs', 'events', 'exports', 'backups']) {
  const dir = sub ? join(DATA_DIR, sub) : DATA_DIR
  if (exists(dir)) {
    SKIP(`目录已存在 ${shorten(dir)}`)
  } else if (opts.dryRun) {
    DO(`将建目录 ${shorten(dir)}`)
  } else {
    mkdirSync(dir, { recursive: true })
    DO(`建目录 ${shorten(dir)}`)
  }
}

if (exists(DB_PATH)) {
  SKIP(`库已存在 ${shorten(DB_PATH)}（不会动你的数据）`)
} else if (opts.dryRun) {
  DO(`将建库 ${shorten(DB_PATH)} 并跑迁移`)
} else {
  try {
    const out = execFileSync(
      process.execPath,
      [join(REPO_ROOT, 'packages', 'memory', 'bin', 'migrate.mjs'), '--db', DB_PATH, '--dir', join(REPO_ROOT, 'migrations')],
      { encoding: 'utf8', cwd: REPO_ROOT, timeout: 120000, windowsHide: true },
    )
    DO(`建库并跑完迁移 ${shorten(DB_PATH)}`)
    const summary = out.trim().split('\n').slice(-3).join(' | ')
    if (summary) console.log(`         ${summary}`)
  } catch (error) {
    const detail = error && typeof error === 'object' && 'stdout' in error ? String(error.stdout) : ''
    block(`迁移失败：${error instanceof Error ? error.message : String(error)}${detail ? `\n         ${detail.slice(0, 500)}` : ''}`)
  }
}

// ── 7. 自检 ─────────────────────────────────────────────────────────────────

console.log('\n--- 6. 自检 ---')

try {
  const brainHome = await import(new URL('../apps/brain-tools/brain-home.js', import.meta.url).href)
  console.log(`  仓库根解析：${brainHome.BRAIN_HOME}  (${brainHome.BRAIN_HOME_SOURCE})`)
  console.log(`  默认库：    ${brainHome.DEFAULT_STORE_PATH}`)
  console.log(`  迁移目录：  ${brainHome.BRAIN_MIGRATIONS}`)
  if (resolve(brainHome.BRAIN_HOME).toLowerCase() !== REPO_ROOT.toLowerCase()) {
    block(`brain-home 解析出的仓库根不是当前仓库（${brainHome.BRAIN_HOME} ≠ ${REPO_ROOT}）。检查 DSH_BRAIN_HOME。`)
  } else {
    OK('路径推导指向本仓库')
  }
} catch (error) {
  block(`brain-home.js 加载失败：${error instanceof Error ? error.message : String(error)}`)
}

if (exists(DB_PATH) && !opts.dryRun) {
  try {
    const { openBrain } = await import(new URL('../packages/memory/src/index.js', import.meta.url).href)
    const brain = await openBrain({ dbPath: DB_PATH, migrationsDir: join(REPO_ROOT, 'migrations') })
    const kb = Math.max(1, Math.round(readFileSync(DB_PATH).length / 1024))
    OK(`库能打开（${kb} KB）`)
    if (brain && typeof brain.close === 'function') await brain.close()
  } catch (error) {
    block(`库打不开：${error instanceof Error ? error.message : String(error)}`)
  }
}

// 插件入口能不能 import：这一步最像宿主的加载方式，能提前暴露 peerDependency 缺失
if (!opts.dryRun) {
  try {
    const mod = await import(new URL('../apps/brain-tools/index.js', import.meta.url).href)
    if (mod && mod.name === 'brain-tools') OK('插件入口能 import（name/inject 就绪）')
    else WARN('插件入口 import 成功但没导出预期的 name')
  } catch (error) {
    block(
      `插件入口 import 失败：${error instanceof Error ? error.message : String(error)}`
      + '\n         多半是 @deepseek-ai/dsh-tools 没接上（见第 3 步）。',
    )
  }
} else {
  SKIP('dry-run：跳过入口 import 自检')
}

// ── 收尾 ────────────────────────────────────────────────────────────────────

console.log('')
if (blockers.length > 0) {
  console.log(`✗ 有 ${blockers.length} 个阻断项，先解决它们：`)
  for (const [i, msg] of blockers.entries()) console.log(`  ${i + 1}. ${msg.split('\n')[0]}`)
  console.log('\n（修完重跑本脚本，它是幂等的。）')
  process.exit(1)
}

console.log('✓ 全部就绪。下一步：')
console.log('  1. 重启 DSH（web 是 `dsh web --port 3080`；桌面版直接重开）')
console.log('  2. 浏览器打开 http://127.0.0.1:3080/dsh-brain —— 能看到记忆列表就通了')
console.log('  3. 在会话里问一句「查一下外置大脑里关于 X 的记录」，模型应该调用 brain_search')
console.log('')
console.log('  ⚠ 只是「治理面板」能开（7420）不算装好：那是独立 node 进程，与宿主无关。')
console.log('    真正的判据是 /dsh-brain 页面（同源 3080）和 brain_search 工具都在。')
