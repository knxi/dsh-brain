// @ts-check
/**
 * run-all.mjs — 本目录测试入口。
 *
 * Node 24.19 的 `node --test <目录>` **不递归目录**，会把目录当模块入口而
 * MODULE_NOT_FOUND（契约 11.6）。所以要么用 glob，要么在这里显式列出。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tests = readdirSync(here).filter((name) => name.endsWith('.test.mjs')).sort()
const result = spawnSync(process.execPath, ['--test', ...tests.map((name) => join(here, name))], {
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
