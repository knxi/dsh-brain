#!/usr/bin/env node
// @ts-check
/**
 * 外置大脑 · 主题注入器
 *
 * ── 为什么不是「页面直接 import theme.js」──
 *
 * 页面早就支持热重载：apps/brain-tools/index.js 的 loadPageModule 按**文件 mtime**
 * 给动态 import 加 `?v=` 参数，改完文件下一次请求就是新版，不用重启 DSH。
 *
 * 但 G（2026-11-01）实测了一条：页面模块里写 `import { THEME_CSS } from './theme.js'`，
 * 页面重新加载时浏览器/Node 解析出的 theme.js URL **不带 query**，于是命中的是
 * 缓存里的旧实例——改主题必须重启宿主，热重载对依赖不成立。
 *（验证脚本见本仓库提交说明：两个模块，a import b，换 a 的 query 后 b 仍是旧值。）
 *
 * 所以主题走**构建期注入**：theme.js 是唯一的源，本脚本把 THEME_CSS 的文本
 * 写进各页面文件的标记区。写文件会更新页面自己的 mtime → 热重载照常生效，
 * 页面也保持自包含（不依赖运行时解析顺序，离线测试同样成立）。
 *
 * ── 用法 ──
 *
 *   node tools/apply-theme.mjs                      # 注入全部页面
 *   node tools/apply-theme.mjs --only mood-page.js  # 只注入指定页面（并行改造时用）
 *   node tools/apply-theme.mjs --check              # 只检查是否与 theme.js 一致（CI 用，不写盘）
 *
 * `--only` 接受逗号分隔的多个文件名。**多人同时改不同页面时必须用它**：
 * 本脚本写的是文件全文，两个人同时跑全量注入会互相覆盖对方刚写好的内容。
 *
 * 改完 theme.js 必须跑一次，否则页面还是上一版观感（本脚本正是为此存在）。
 *
 * 标记区（页内保持原样，勿手改中间内容）：
 *
 *   /* ══ THEME:BEGIN ══ *\/
 *   ...（本脚本生成）...
 *   /* ══ THEME:END ══ *\/
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGES_DIR = join(HERE, '..', 'apps', 'brain-tools')
const THEME_FILE = join(PAGES_DIR, 'theme.js')

const BEGIN = '/* ══ THEME:BEGIN ══ */'
const END = '/* ══ THEME:END ══ */'

/**
 * 读 theme.js 里的 THEME_CSS。
 * 用 import 而不是正则抠字符串：theme.js 的内容是拼出来的，直接拿导出的成品最不容易错。
 */
async function loadThemeCss() {
  const url = new URL('file://' + THEME_FILE.replace(/\\/g, '/'))
  const mod = await import(url.href + '?t=' + Date.now())
  if (typeof mod.THEME_CSS !== 'string' || mod.THEME_CSS.length < 100) {
    throw new Error('theme.js 没有导出可用的 THEME_CSS')
  }
  return mod.THEME_CSS
}

/**
 * 把 CSS 文本变成**能安全放进模板字符串**的形态。
 *
 * 页面主体是 `return \`<!DOCTYPE html>...\`` 这样的模板串，注入的文本里只要出现
 * 反引号或 `${` 就会把外层模板串截断——那是最难查的一类坏法（页面直接白屏或报
 * 语法错，而错的位置在生成的 HTML 里）。这里直接拒绝，而不是悄悄转义：
 * 主题里本来就该有 CSS，不该有 JS 模板语法。
 */
function assertTemplateSafe(css, fileName) {
  if (css.includes('`')) {
    throw new Error(fileName + ': THEME_CSS 里有反引号，会截断页面的模板字符串')
  }
  if (css.includes('${')) {
    throw new Error(fileName + ': THEME_CSS 里有 ${，会被页面模板字符串当成插值')
  }
}

/** 找出页面文件里的标记区并替换。返回新的全文（不改文件）。 */
function injectInto(source, css, fileName) {
  const b = source.indexOf(BEGIN)
  const e = source.indexOf(END)
  if (b < 0 || e < 0) return null // 这页还没接入主题
  if (e < b) throw new Error(fileName + ': THEME:END 出现在 THEME:BEGIN 之前')
  return source.slice(0, b + BEGIN.length) + '\n' + css + '\n' + source.slice(e)
}

async function main() {
  const check = process.argv.includes('--check')
  const onlyArg = process.argv.indexOf('--only')
  const only = onlyArg >= 0 && process.argv[onlyArg + 1]
    ? new Set(process.argv[onlyArg + 1].split(',').map((s) => s.trim()).filter(Boolean))
    : null
  const css = await loadThemeCss()

  const allFiles = readdirSync(PAGES_DIR)
    .filter((f) => f.endsWith('-page.js'))
    .sort()
  // --only 里写了不存在的文件名时直接报错：并行改造时静默跳过等于「以为注入了、其实没有」
  if (only) {
    const unknown = [...only].filter((f) => !allFiles.includes(f))
    if (unknown.length) throw new Error('--only 里有不存在的页面：' + unknown.join(', '))
  }
  const files = only ? allFiles.filter((f) => only.has(f)) : allFiles

  const changed = []
  const missing = []
  const failed = []

  for (const fileName of files) {
    const full = join(PAGES_DIR, fileName)
    assertTemplateSafe(css, fileName)
    const before = readFileSync(full, 'utf8')
    let after
    try {
      after = injectInto(before, css, fileName)
    } catch (err) {
      failed.push(fileName + ' — ' + /** @type {Error} */ (err).message)
      continue
    }
    if (after === null) {
      missing.push(fileName)
      continue
    }
    if (after === before) continue
    changed.push(fileName)
    if (!check) writeFileSync(full, after, 'utf8')
  }

  const mode = check ? '只检查' : '已注入'
  console.log(
    '[apply-theme] ' + mode + '：' + files.length + ' 页 / 变更 ' + changed.length +
    (changed.length ? '（' + changed.join(', ') + '）' : '')
  )
  if (missing.length) console.log('[apply-theme] 未接入主题（无标记区）：' + missing.join(', '))
  if (failed.length) {
    console.error('[apply-theme] 失败：\n  ' + failed.join('\n  '))
  }
  if (check && changed.length) {
    console.error('[apply-theme] 页面主题与 theme.js 不一致：跑 node tools/apply-theme.mjs 重新注入')
    process.exitCode = 1
    return
  }
  if (failed.length) process.exitCode = 1
}

main().catch((err) => {
  console.error('[apply-theme] 出错：' + err.message)
  process.exitCode = 1
})
