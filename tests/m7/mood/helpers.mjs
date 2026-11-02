// @ts-check
/**
 * M7.2 情感状态测试的公共工具。
 *
 * 纪律（照 M6 测试）：
 * - 全部在 `mkdtemp` 下的临时主账里跑，**绝不碰 `data/brain.db`**；
 * - 不 import `apps/` 与宿主相关的东西（要 DSH 环境）；
 * - 期望值手算写死，不靠实现自己算出来的数当答案。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../../packages/core/src/index.js';
import { openBrain } from '../../../packages/memory/src/index.js';

export { assert };

/** 仓库内 migrations 目录。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

/**
 * `@dsh-brain/memory` 的绝对路径入口（插件侧桥接不按包名解析，见 brain-bridge.js）。
 * 用它验证「插件不硬依赖包名也能连上主账」。
 */
export const MEMORY_ENTRY = fileURLToPath(new URL('../../../packages/memory/src/index.js', import.meta.url));

/**
 * 插件侧主账桥接（纯 ESM、只依赖 node:url，可直接 import）。
 * 插件不在本仓库包内（`E:/ds-h/plugins/dsh-fox-mood/`），所以从 tests/m7/mood/ 要往上四层。
 */
export const BRIDGE_ENTRY = fileURLToPath(
  new URL('../../../../plugins/dsh-fox-mood/brain-bridge.js', import.meta.url),
);

/**
 * 可推进的固定时钟：时间断言要确定性，不能靠 `Date.now()` 碰运气。
 * @param {string} [startIso]
 */
export function fixedClock(startIso = '2026-10-28T10:00:00.000Z') {
  let current = Date.parse(startIso);
  const clock = createClock({ timeZone: 'Asia/Shanghai', now: () => new Date(current) });
  return {
    clock,
    advance(ms = 1000) {
      current += ms;
      return new Date(current).toISOString();
    },
    set(iso) {
      current = Date.parse(iso);
    },
    nowIso: () => new Date(current).toISOString(),
    nowMs: () => current,
  };
}

/**
 * 打开一个临时主账（跑完全部迁移），测试结束自动关闭并删目录。
 * @param {import('node:test').TestContext} t
 * @param {{ startIso?: string }} [opts]
 */
export function createBrain(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m7-'));
  const dbPath = path.join(dir, 'brain.db');
  const fc = fixedClock(opts.startIso);
  const brain = openBrain({ dbPath, clock: fc.clock });
  let closed = false;
  t.after(async () => {
    if (!closed) {
      closed = true;
      try {
        await brain.close();
      } catch {
        /* 已关闭：不掩盖测试失败 */
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟释放不影响断言 */
    }
  });
  return { brain, dir, dbPath, fc };
}

/**
 * 统计某表行数。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 */
export function countRows(db, table) {
  const row = /** @type {{ n?: number }} */ (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  return Number(row?.n ?? 0);
}

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @returns {string[]}
 */
export function columnNames(db, table) {
  return /** @type {Array<{ name: string }>} */ (db.prepare(`PRAGMA table_info(${table})`).all()).map((row) => row.name);
}
