// @ts-check
/**
 * M2 记忆层测试的公共工具。
 *
 * 纪律（CONTRACTS §12 / M2-INTERFACES §6）：
 * - **只用合成语料**，不碰真实私密历史。
 * - 全部在 `mkdtemp` 下的临时主账里跑，跑完删目录。
 * - 语料必须覆盖主人的真实工作语境：尺寸、材质、图号、报价、英文标识符/代码标识符。
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
  };
}

/**
 * 打开一个临时主账（已跑完 0001 + 0002 迁移），测试结束自动关闭并删目录。
 * @param {import('node:test').TestContext} t
 * @param {{ startIso?: string, brainOptions?: Record<string, unknown> }} [opts]
 */
export function createBrain(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m2-'));
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
 * 一条带默认值的 draft（测试里只写关心的字段）。
 * @param {Record<string, unknown>} overrides
 */
export function draft(overrides) {
  return {
    layer: 'long',
    type: 'semantic',
    content: '占位内容',
    summary: '占位摘要',
    sourceType: 'owner_words',
    sourceIds: [],
    privacy: 'private',
    originSystem: 'dsh',
    producer: 'test-harness',
    ...overrides,
  };
}

/**
 * 合成语料：主人的真实工作语境（广告设计 + 建筑工程资料）。
 *
 * 每条都带 `sourceIds`，因为 M2 门槛要求「检索结果必有来源」——没来源的记忆
 * 本来就该被判 `source_missing`（见 search-diagnostics 测试）。
 */
export const CORPUS = Object.freeze([
  {
    key: 'business-card',
    content: '铜版纸名片 300g，成品尺寸 90×54mm，出血 92×56mm，报价 0.45 元一张',
    summary: '名片：铜版纸 300g、90×54mm、0.45 元',
    type: 'semantic',
    sourceIds: ['evt-card-1'],
  },
  {
    key: 'brochure',
    content: '画册封面用 250g 哑粉纸，覆哑膜，成品 210×285mm',
    summary: '画册封面：250g 哑粉纸 + 覆哑膜、210×285mm',
    type: 'semantic',
    sourceIds: ['evt-brochure-1'],
  },
  {
    key: 'drawing-03',
    content: '建施-03 图里首层平面标高是 0.00，层高 3.6m',
    summary: '建施-03：首层标高 0.00、层高 3.6m',
    type: 'semantic',
    sourceIds: ['evt-dwg-1'],
  },
  {
    key: 'steel-note',
    content: 'JS-2026-017 这份结施说明里梁的截面是 2400×600',
    summary: '结施 JS-2026-017：梁截面 2400×600',
    type: 'semantic',
    sourceIds: ['evt-dwg-2'],
  },
  {
    key: 'banner',
    content: '户外喷绘布 1.2m 宽，喷绘精度 1440dpi，挂三天要换',
    summary: '户外喷绘：1.2m 宽、1440dpi',
    type: 'episode',
    sourceIds: ['evt-banner-1'],
  },
  {
    key: 'canvas-tool',
    content: '调用 readSurface 读取画布像素前要先等重绘完成',
    summary: '画布：readSurface 需等重绘完成',
    type: 'skill',
    sourceIds: ['evt-tool-1'],
  },
  {
    key: 'identifiers',
    content: 'deletion_epoch 与 pnpm 的 resume 逻辑写在 build:web 脚本里',
    summary: '工程：deletion_epoch / pnpm resume / build:web',
    type: 'skill',
    sourceIds: ['evt-tool-2'],
  },
  {
    key: 'scaffold-price',
    content: '脚手架租赁报价按天算，和铜版纸名片的报价不是一回事',
    summary: '脚手架按天报价，别和印刷报价混',
    type: 'semantic',
    sourceIds: ['evt-scaffold-1'],
  },
]);

/**
 * 批量入库，返回 `key → id`。
 * @param {ReturnType<typeof createBrain>['brain']} brain
 * @param {Array<Record<string, unknown>>} [items]
 * @returns {Promise<Record<string, string>>}
 */
export async function seedCorpus(brain, items = [...CORPUS]) {
  /** @type {Record<string, string>} */
  const ids = {};
  for (const item of items) {
    const created = await brain.memories.create(draft(item));
    ids[/** @type {string} */ (item.key)] = created.id;
  }
  return ids;
}

/**
 * 打开库内所有 FTS / ngram 索引里的 doc_id（用于删除屏障断言）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [table]
 */
export function indexDocIds(db, table = 'search_fts_trigram') {
  return /** @type {Array<{ doc_id: string }>} */ (db.prepare(`SELECT doc_id FROM ${table}`).all()).map((r) => String(r.doc_id));
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
 * 取 `memories.search()` 命中的 key（按测试语料的 key 反查 id）。
 * @param {{ hits: Array<{ memoryId: string }> }} result
 * @param {Record<string, string>} ids
 * @returns {string[]}
 */
export function hitKeys(result, ids) {
  const reverse = new Map(Object.entries(ids).map(([key, id]) => [id, key]));
  return result.hits.map((hit) => reverse.get(hit.memoryId) ?? hit.memoryId);
}
