// @ts-check
/**
 * attach.mjs — 把探针插件可复现地挂进 brainlab profile，或干净地摘下来。
 *
 * 为什么不用 `pnpm link:`：pnpm 在 Windows 上会把 `link:E:\...` 当相对路径解析，
 * 生成指向 `profile\E:\...` 的坏 Junction（实测）。Node 的模块解析只认
 * `node_modules/<name>` 这个目录本身，所以直接用 Junction 指到仓库是最稳的做法。
 *
 * 用法：
 *   node apps/probe/attach.mjs attach    # 挂上探针
 *   node apps/probe/attach.mjs detach    # 摘掉探针（回滚验证）
 *   node apps/probe/attach.mjs status    # 查看当前状态
 */
import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const PROFILE_DIR = process.env.DSH_PROFILE_BRAINLAB || 'C:/Users/su/.dsh/profiles/brainlab'
const PROBE_DIR = 'E:/ds-h/dsh-brain/apps/probe'
const LINK_PARENT = join(PROFILE_DIR, 'node_modules', '@dsh-brain')
const LINK_PATH = join(LINK_PARENT, 'probe')

const action = process.argv[2] ?? 'status'

/** @param {string} message */
function log(message) {
  console.log(`[attach] ${message}`)
}

switch (action) {
  case 'attach': {
    mkdirSync(LINK_PARENT, { recursive: true })
    if (existsSync(LINK_PATH) || isBrokenLink(LINK_PATH)) {
      rmSync(LINK_PATH, { recursive: true, force: true })
    }
    // Junction 不需要管理员权限，也不需要 Developer Mode。
    execJunction(LINK_PATH, PROBE_DIR)
    log(`attached ${LINK_PATH} -> ${PROBE_DIR}`)
    log(`verify index.js: ${existsSync(join(LINK_PATH, 'index.js'))}`)
    break
  }
  case 'detach': {
    if (existsSync(LINK_PATH) || isBrokenLink(LINK_PATH)) {
      rmSync(LINK_PATH, { recursive: true, force: true })
      log(`detached ${LINK_PATH}`)
    } else {
      log('nothing to detach')
    }
    break
  }
  default: {
    const exists = existsSync(LINK_PATH)
    log(`profile: ${PROFILE_DIR}`)
    log(`link: ${LINK_PATH} exists=${exists}`)
    if (exists) {
      try {
        log(`target: ${readlinkSync(LINK_PATH)}`)
      } catch (error) {
        log(`target unreadable (junction): ${/** @type {any} */ (error).message}`)
      }
      log(`probe index.js present: ${existsSync(join(LINK_PATH, 'index.js'))}`)
    }
  }
}

/** @param {string} path */
function isBrokenLink(path) {
  try {
    return lstatSync(path).isSymbolicLink() || lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 用 PowerShell 的 New-Item -ItemType Junction 建立目录联接（跨盘可用）。
 * @param {string} linkPath
 * @param {string} target
 */
function execJunction(linkPath, target) {
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `New-Item -ItemType Junction -Path "${linkPath}" -Target "${target}" | Out-Null`], {
    stdio: 'inherit',
  })
}
