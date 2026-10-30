// @ts-check
/**
 * M3 删除线测试的公共工具。
 *
 * 纪律（CONTRACTS §12 / M3-INTERFACES §8）：
 * - **只用合成语料**，不碰真实私密历史。语料覆盖主人的工作语境（尺寸 / 材质 / 图号 / 报价 / 英文标识符）。
 * - 全部在 `mkdtemp` 下的临时主账里跑，跑完删目录。
 * - 账本落点跟着 dbPath 走（`<临时目录>/deletion-ledger/`），所以一个测试不会污染仓库 `data/`。
 *   这是 openBrain 的默认行为，测试顺带验证它。
 */

import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../../packages/core/src/index.js';
import { openBrain } from '../../../packages/memory/src/index.js';

export { assert };

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

export const SCOPE_A = 'owner-default';
export const SCOPE_B = 'owner-other';

/**
 * 可推进的固定时钟（确定性时间断言的前提）。
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
 * 打开一个临时主账（已跑完 0001~0003 迁移，账本自动落在同目录）。
 * @param {import('node:test').TestContext} t
 * @param {{ startIso?: string, brainOptions?: Record<string, unknown> }} [opts]
 */
export function createBrain(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-m3-del-'));
  const dbPath = path.join(dir, 'brain.db');
  const fc = fixedClock(opts.startIso);
  /** @type {Array<Record<string, unknown>>} */
  const alerts = [];
  const brain = openBrain({
    ...(opts.brainOptions ?? {}),
    dbPath,
    clock: fc.clock,
    alert: (/** @type {Record<string, unknown>} */ info) => alerts.push(info),
  });
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
  return { brain, dir, dbPath, fc, alerts };
}

/**
 * 一条带默认值的 draft。
 * @param {Record<string, unknown>} overrides
 */
export function draft(overrides) {
  return {
    layer: 'long',
    type: 'semantic',
    content: '占位内容（合成）',
    summary: '占位摘要',
    sourceType: 'owner_words',
    sourceIds: [],
    privacy: 'private',
    originSystem: 'dsh',
    producer: 'm3-test-harness',
    ...overrides,
  };
}

/**
 * 合成语料：广告设计 + 建筑工程资料的真实语境，但每一条都是编的。
 * 每条都带 `sourceIds`（M2 门槛：检索结果必有来源）。
 */
export const CORPUS = Object.freeze({
  card: {
    content: '铜版纸名片 300g，成品尺寸 90×54mm，出血 92×56mm，报价 0.45 元一张',
    summary: '名片：铜版纸 300g / 90×54mm / 0.45 元',
    sourceIds: ['evt-m3-card-1'],
  },
  negative: {
    content: '印前文件用 CMYK，总墨量不超过 320%，黑色单黑 K100',
    summary: '印前：CMYK、总墨量 ≤320%',
    sourceIds: ['evt-m3-print-1'],
  },
  drawing: {
    content: '建施-03 图里首层平面标高 0.00，层高 3.6m，楼梯净宽 1.2m',
    summary: '建施-03：标高 0.00 / 层高 3.6m / 净宽 1.2m',
    sourceIds: ['evt-m3-dwg-1'],
  },
  steel: {
    content: '结施 JS-2026-017 梁截面 2400×600，混凝土 C35',
    summary: '结施 JS-2026-017：梁 2400×600 / C35',
    sourceIds: ['evt-m3-dwg-2'],
  },
  steelRevised: {
    content: '结施 JS-2026-017 梁截面改为 2400×700，混凝土 C40（修订版）',
    summary: '结施 JS-2026-017 修订：梁 2400×700 / C40',
    sourceIds: ['evt-m3-dwg-3'],
  },
  quote: {
    content: '脚手架租赁按天算，48 元一天，和铜版纸名片的印刷报价不是一回事',
    summary: '脚手架：48 元/天（与印刷报价分开）',
    sourceIds: ['evt-m3-quote-1'],
  },
  identifiers: {
    content: 'deletion_epoch 与 pnpm 的 resume 逻辑写在 build:web 脚本里',
    summary: '工程：deletion_epoch / pnpm resume / build:web',
    sourceIds: ['evt-m3-code-1'],
  },
});

/**
 * 入库一条记忆。
 * @param {ReturnType<typeof createBrain>['brain']} brain
 * @param {{ content: string, summary?: string, sourceIds?: string[] } & Record<string, unknown>} item
 * @param {Record<string, unknown>} [overrides]
 */
export async function seed(brain, item, overrides = {}) {
  return brain.memories.create(draft({ ...item, ...overrides }));
}

/**
 * 取某张表的所有 doc_id。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 */
export function docIds(db, table) {
  return /** @type {Array<{ doc_id: string }>} */ (db.prepare(`SELECT doc_id FROM ${table}`).all()).map((row) =>
    String(row.doc_id),
  );
}

/**
 * 统计某表行数。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @param {string} [where]
 * @param {unknown[]} [params]
 */
export function countRows(db, table, where = '1=1', params = []) {
  const row = /** @type {{ n?: number }} */ (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...params));
  return Number(row?.n ?? 0);
}

/**
 * 在导出目录里造一个 JSONL（模拟带水位的异步导出已落盘）。
 * @param {string} dir
 * @param {string} name
 * @param {Array<Record<string, unknown>>} records
 */
export function writeExportJsonl(dir, name, records) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`, 'utf8');
  return file;
}

/**
 * 读导出 JSONL 的记录。
 * @param {string} file
 */
export function readExportJsonl(file) {
  const text = readFileSync(file, 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/**
 * 把主账文件复制到新目录（模拟「从旧备份恢复」最底层的一步）。
 * 只拷 .db：测试里不跑 WAL 切换，写完立刻关库即可得到自洽文件。
 * @param {string} fromDb
 * @param {string} toDir
 */
export function copyDbTo(fromDb, toDir) {
  mkdirSync(toDir, { recursive: true });
  const target = path.join(toDir, 'brain.db');
  assert.ok(existsSync(fromDb), `源主账不存在：${fromDb}`);
  copyFileSync(fromDb, target);
  return target;
}
