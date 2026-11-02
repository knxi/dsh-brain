// 评测集目录入口：node --test tests/eval
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const result = spawnSync(process.execPath, ['--test', path.join(here, 'eval.test.mjs')], {
  stdio: 'inherit',
  cwd: path.resolve(here, '..', '..'),
})
process.exitCode = result.status === null ? 1 : result.status
