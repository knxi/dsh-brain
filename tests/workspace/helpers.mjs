// @ts-check
/**
 * 系统 3 工作空间的测试脚手架。
 *
 * 纪律（与 tests/m7/mood/helpers.mjs 同一条）：
 * 1. 一律 mkdtemp，**绝不碰 data/brain.db**；
 * 2. 不 import apps/（这里只测包）；
 * 3. 时钟可注入——时间相关的断言不能靠 sleep，那会让测试慢且飘。
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { openBrain } from '../../packages/memory/src/index.js'
import { createWorkspace } from '../../packages/workspace/src/index.js'

export const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
export const ROOT = path.resolve(HERE, '..', '..')
export const MIGRATIONS_DIR = path.join(ROOT, 'migrations')

/** 固定时钟：所有写入的 created_at 都落在这一刻，断言可重放。 */
export function fixedClock(startIso = '2026-10-31T02:00:00.000Z') {
  const timeZone = 'Asia/Shanghai'
  let current = Date.parse(startIso)
  return {
    timeZone,
    clock: {
      timeZone,
      now: () => current,
      stamp: () => {
        const utc = new Date(current).toISOString()
        const local = new Date(current + 8 * 3600_000).toISOString().replace('Z', '+08:00')
        return { utc, local }
      },
    },
    advance(ms) {
      current += ms
      return current
    },
    set(ms) {
      current = ms
      return current
    },
  }
}

/**
 * 建一个临时库并组装 workspace。`now` 与 clock 同步推进，避免「事件时间」
 * 和「租约时间」两套时钟打架。
 *
 * @param {import('node:test').TestContext} t
 */
export function createWorkspaceFixture(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m8-ws-'))
  const dbPath = path.join(dir, 'brain.db')
  const fc = fixedClock(opts.startIso)
  const brain = openBrain({
    dbPath,
    migrationsDir: MIGRATIONS_DIR,
    clock: /** @type {any} */ (fc.clock),
  })
  const workspace = createWorkspace({
    db: brain.db,
    queue: brain.queue,
    clock: /** @type {any} */ (fc.clock),
    bindings: { scope_id: 'owner-default' },
    now: () => fc.clock.now(),
  })
  t.after(async () => {
    await brain.close().catch(() => {})
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* Windows 句柄延迟释放 */
    }
  })
  return { brain, workspace, dir, dbPath, fc }
}

/** 数某张表的行数。 */
export function countRows(db, table) {
  const row = db.prepare(`SELECT count(*) AS n FROM ${table}`).get()
  return Number(row?.n ?? 0)
}

export { assert, pathToFileURL }
