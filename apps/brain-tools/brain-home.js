// @ts-check
/**
 * 项目根 / 数据目录的统一解析口（2026-11-02 加，为了「换一台电脑也能装起来」）。
 *
 * 为什么要有这个文件：
 *   之前整个插件有 11 处硬编码 `E:/ds-h/dsh-brain/...`。换一台机器，盘符、目录名、
 *   用户目录都可能不同，插件一激活就全部指向不存在的路径 —— 而且**看起来什么都不报**：
 *   库打不开被 structured error 吞成「查不到记忆」，日志写不进被 catch 掉，
 *   页面回 500。现象就是「装上了，但什么都没发生」，很难猜是路径问题。
 *
 * 解析顺序（先精确后宽松，最后兜底但**绝不抛**）：
 *   1. cordis config 里显式给的路径 —— 那由调用方自己覆盖，不经过这里
 *   2. 环境变量 DSH_BRAIN_HOME（指向 dsh-brain 仓库根）
 *   3. 从本文件往上找 package.json.name === 'dsh-brain'（插件是从仓库里链路挂进 profile 的，
 *      所以这个一定能找到——除非用户把 apps/brain-tools 单独拷走了）
 *   4. 兜底到 ~/.dsh-brain，并打一行警告：库不跟项目走，换机会丢数据
 *
 * 为什么这里绝不 throw：模块顶层抛异常会让宿主把整个插件判成加载失败，
 * 连「为什么失败」都看不到（2026-10-28 真踩过：宿主静默丢弃整层）。
 * 宁可带着一个警告活下来，让人能从 /dsh-brain 页面上看到问题。
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * 本文件所在目录（.../apps/brain-tools/）。
 *
 * 先 realpath 一层：插件是通过 junction / `link:` 挂进 profile 的，
 * `import.meta.url` 拿到的是**链接路径**。Node 默认会把软链解析成真实路径，
 * 但如果哪天宿主带了 `--preserve-symlinks`（或换了打包器），这里就会拿到 profile 里的
 * 那层链接，往上走 N 层也找不到仓库根，直接掉进 fallback 空库——
 * 2026-11-02 用 `node --preserve-symlinks` 实测复现过，页面表现只是「查不到记忆」。
 * realpath 一次，把这层依赖变显式。
 */
const HERE = (() => {
  const raw = fileURLToPath(new URL('.', import.meta.url))
  try {
    return realpathSync(raw)
  } catch {
    return raw
  }
})()

/** 是不是目录（`existsSync` 对文件也返回 true，用它判定会给出误导性文案） */
/** @param {string} p */
const isDir = (p) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** @param {string} dir */
const isBrainRoot = (dir) => {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return Boolean(pkg && pkg.name === 'dsh-brain')
  } catch {
    return false
  }
}

/**
 * 从 start 往上找仓库根。**不限层数**（原先是硬编码 8 层，
 * pnpm 那种 `node_modules/.pnpm/@dsh-brain+brain-tools@file+…/node_modules/@dsh-brain/...`
 * 布局很容易超过 8 层，超了会静默掉进 fallback 空库）。
 * @param {string} start
 */
const walkUp = (start) => {
  let dir = start
  for (;;) {
    if (isBrainRoot(dir)) {
      // 命中在 node_modules 里 = 这是「拷贝安装」的副本，不是用户的工作仓库。
      // 库要是建在里面，下次 install / 更新就被一起清掉，而且因为 walkUp「成功」，
      // 下面那条「找不到仓库根」的兜底告警根本不会响。
      if (/[\\/]node_modules[\\/]/i.test(dir)) {
        console.error(
          `[brain-tools] 推导出的仓库根在 node_modules 里（${dir}）——这是拷贝安装的副本，`
          + '库建在里面会在插件更新时被清掉。改用 junction / link 安装，或显式设置 DSH_BRAIN_HOME。',
        )
      }
      return dir
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const FALLBACK_HOME = resolve(join(homedir(), '.dsh-brain'))

const envHome = process.env.DSH_BRAIN_HOME
/** @type {string|null} */
let resolved = null
/** @type {string} */
let source = ''

if (envHome) {
  // 必须先 resolve：`DSH_BRAIN_HOME=.` 或 `./dsh-brain` 这种写法很自然，
  // 但直接存相对串会让 BRAIN_HOME / storePath 随宿主进程 cwd 漂移——
  // 换个 cwd 起动就是另一个空库，而 SOURCE 还显示 env:...，看着像配置正确。
  const abs = resolve(envHome)
  if (!isDir(abs)) {
    console.error(`[brain-tools] DSH_BRAIN_HOME 指向的不是一个存在的目录（${abs}），忽略它，继续自动推导。`)
  } else if (!isBrainRoot(abs)) {
    // 只认「带 package.json.name=dsh-brain 的仓库根」。
    // 之前这里只判 existsSync，于是指到 data/ 或 apps/ 这种子目录也照收：
    // 库静默落到 data\data\brain.db，旧记忆全部查不到，而 BRAIN_HOME_SOURCE 还显示
    // env:DSH_BRAIN_HOME，看起来像「配置正确」——比直接报错难查得多（2026-11-02 实测踩到）。
    console.error(
      `[brain-tools] DSH_BRAIN_HOME 指向的目录不是仓库根（缺 package.json.name=dsh-brain）：${abs}，`
      + '忽略它，继续自动推导。确实想改数据位置的话：DSH_BRAIN_HOME 要指仓库根，'
      + '数据路径另外用 cordis 配置的 storePath / migrationsDir 指定。',
    )
  } else {
    resolved = abs
    source = 'env:DSH_BRAIN_HOME'
  }
}

if (resolved === null) {
  const walked = walkUp(HERE)
  if (walked) {
    resolved = walked
    source = 'walk-up:package.json'
  }
}

if (resolved === null) {
  console.error(
    '[brain-tools] 找不到 dsh-brain 仓库根（从插件位置往上直到盘根都没有 name=dsh-brain 的 package.json，'
    + '也没设 DSH_BRAIN_HOME）。数据将落到兜底目录 ' + FALLBACK_HOME
    + ' —— 这意味着库不跟项目走，换机会丢记忆。',
  )
}

/** dsh-brain 仓库根 */
export const BRAIN_HOME = resolved ?? FALLBACK_HOME
/** 解析来源，页面/自检用来如实说明「库到底在哪、为什么在那」 */
export const BRAIN_HOME_SOURCE = resolved === null ? 'fallback:~/.dsh-brain' : source

/** 数据根（库、日志、人格状态都在它下面） */
export const BRAIN_DATA = join(BRAIN_HOME, 'data')
/** 迁移目录 */
export const BRAIN_MIGRATIONS = join(BRAIN_HOME, 'migrations')

/** 生产库 */
export const DEFAULT_STORE_PATH = join(BRAIN_DATA, 'brain.db')
/** 日志目录（观测数据，不进主账、不参与备份/恢复） */
export const BRAIN_LOG_DIR = join(BRAIN_DATA, 'logs')
/** 运行参数目录（通道、主动送达、会话信号缓存） */
export const BRAIN_PERSONA_DIR = join(BRAIN_DATA, 'persona')

export const DEFAULT_USAGE_LOG_PATH = join(BRAIN_LOG_DIR, 'usage.jsonl')
export const DEFAULT_SOCIAL_OUTBOX_PATH = join(BRAIN_LOG_DIR, 'social-outbox.jsonl')
export const DEFAULT_AUTO_EXTRACT_LOG_PATH = join(BRAIN_LOG_DIR, 'auto-extract.jsonl')
export const DEFAULT_CONFLICT_LOG_PATH = join(BRAIN_LOG_DIR, 'conflict-actions.jsonl')
export const DEFAULT_USED_LATER_LOG_PATH = join(BRAIN_LOG_DIR, 'used-later.jsonl')
export const DEFAULT_CHANNEL_CONFIG_PATH = join(BRAIN_PERSONA_DIR, 'channel.json')
export const DEFAULT_SOCIAL_AUTO_PATH = join(BRAIN_PERSONA_DIR, 'social-auto.json')
export const DEFAULT_SESSION_SIGNAL_PATH = join(BRAIN_PERSONA_DIR, 'session-signals.json')

/**
 * packages/persona/src/session-signal-index.js 的绝对 file URL；找不到就是 null。
 *
 * 改过两次，记下来免得第三遍：
 *   1. 最初写死 `file:///E:/ds-h/...` —— 换机必炸；
 *   2. 改成从 `import.meta.url` 往上推两级 —— 修了换机，但和 BRAIN_HOME 变成两套口径：
 *      一旦走 fallback（插件被拷到仓库外 / DSH_BRAIN_HOME 没设对），库和日志都自洽落到
 *      ~/.dsh-brain，唯独这个 URL 指向拷贝位置的虚空，运行时才炸且不吭声。
 *   3. 现在统一从 BRAIN_HOME 推，缺失时**明确告警并返回 null**（调用方已有 catch，
 *      会退化成「社交门面如实说没有依据」，而不是静默）。
 */
export const SESSION_SIGNAL_INDEX_URL = (() => {
  const target = join(BRAIN_HOME, 'packages', 'persona', 'src', 'session-signal-index.js')
  if (!existsSync(target)) {
    console.error(
      `[brain-tools] 找不到会话信号索引模块（${target}）——主动社交的 care / commitment 两类`
      + '会一直回「没有依据」。通常是仓库不完整，或 BRAIN_HOME 推导到了别处。',
    )
    return null
  }
  return pathToFileURL(target).href
})()
