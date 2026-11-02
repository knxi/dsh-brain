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
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本文件所在目录（.../apps/brain-tools/） */
const HERE = fileURLToPath(new URL('.', import.meta.url))

/** @param {string} dir */
const isBrainRoot = (dir) => {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return Boolean(pkg && pkg.name === 'dsh-brain')
  } catch {
    return false
  }
}

/** @param {string} start */
const walkUp = (start) => {
  let dir = start
  for (let i = 0; i < 8; i += 1) {
    if (isBrainRoot(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

const FALLBACK_HOME = join(homedir(), '.dsh-brain')

const envHome = process.env.DSH_BRAIN_HOME
/** @type {string|null} */
let resolved = null
/** @type {string} */
let source = ''

if (envHome && existsSync(envHome)) {
  resolved = envHome
  source = 'env:DSH_BRAIN_HOME'
} else {
  const walked = walkUp(HERE)
  if (walked) {
    resolved = walked
    source = 'walk-up:package.json'
  }
}

if (resolved === null) {
  console.error(
    '[brain-tools] 找不到 dsh-brain 仓库根（向上 8 层没有 name=dsh-brain 的 package.json，'
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
 * packages/persona/src/session-signal-index.js 的绝对 file URL。
 * 原来这里写死 `file:///E:/ds-h/dsh-brain/packages/...`，换机必炸。
 * 用 import.meta.url 推：apps/brain-tools/ → ../../ → 仓库根。
 */
export const SESSION_SIGNAL_INDEX_URL = new URL(
  '../../packages/persona/src/session-signal-index.js',
  import.meta.url,
).href
