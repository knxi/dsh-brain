// @ts-check
/**
 * M3 备份恢复测试的公共工具。
 *
 * 纪律：
 * - 全部在 `mkdtemp` 临时目录里跑，跑完删；**不碰**真实主账与真实删除账本。
 * - 删除账本用两种：`fakeLedger`（接口替身，测隔离路径）与 del3 的真实
 *   `createDeletionLedger`（真实联调用例，存在才用）。
 * - 语料全部合成（尺寸 / 材质 / 图号 / 报价）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../../packages/core/src/index.js';
import { openBrain } from '../../../packages/memory/src/index.js';

export { assert };

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));
export const SCOPE = 'owner-default';

/**
 * 可推进的固定时钟。
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
 * 打开一个临时主账（已跑完 0005 迁移），测试结束自动关闭并删目录。
 * @param {import('node:test').TestContext} t
 * @param {{ startIso?: string, brainOptions?: Record<string, unknown> }} [opts]
 */
export function createBrain(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m3-'));
  const dbPath = path.join(dir, 'brain.db');
  const outDir = path.join(dir, 'backups');
  const blobsDir = path.join(dir, 'blobs');
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
  return { brain, dir, dbPath, outDir, blobsDir, fc, alerts };
}

/**
 * 一条带默认值的记忆 draft。
 * @param {Record<string, unknown>} overrides
 */
export function draft(overrides = {}) {
  return {
    layer: 'long',
    type: 'semantic',
    content: '占位内容',
    summary: '占位摘要',
    sourceType: 'owner_words',
    sourceIds: [],
    privacy: 'private',
    originSystem: 'dsh',
    producer: 'm3-test',
    ...overrides,
  };
}

/** 合成语料（主人真实工作语境）。 */
export const CORPUS = Object.freeze([
  '铜版纸名片 300g，成品尺寸 90×54mm，报价 0.45 元一张',
  '画册封面用 250g 哑粉纸，覆哑膜，成品 210×285mm',
  '建施-03 图里首层平面标高 0.00，层高 3.6m',
  '结施 JS-2026-017 梁截面 2400×600',
]);

/**
 * 批量写入记忆，返回 id 数组。
 * @param {ReturnType<typeof createBrain>['brain']} brain
 * @param {string[]} [contents]
 * @returns {Promise<string[]>}
 */
export async function seedMemories(brain, contents = [...CORPUS]) {
  /** @type {string[]} */
  const ids = [];
  for (const content of contents) {
    const created = await brain.memories.create(draft({ content, summary: content.slice(0, 30) }));
    ids.push(created.id);
  }
  return ids;
}

/**
 * 接口替身账本（M3-INTERFACES §1.2 的全部方法）。
 *
 * @param {{
 *   entries?: Array<Record<string, any>>,
 *   missing?: boolean,
 *   corrupt?: boolean,
 *   external?: boolean,
 * }} [opts]
 */
export function fakeLedger(opts = {}) {
  const { missing = false, corrupt = false, external = true } = opts;
  /** @type {Array<Record<string, any>>} */
  const list = (opts.entries ?? []).map((entry, index) => ({ ...entry, seq: entry.seq ?? index + 1 }));
  let seq = list.length;
  const maxEpoch = () => list.reduce((max, entry) => Math.max(max, Number(entry.epoch ?? 0)), 0);
  return {
    /** @param {Record<string, any>} entry */
    append(entry) {
      seq += 1;
      list.push({ ...entry, seq });
      return { seq, entryHash: `fake:${seq}`, watermark: { epoch: maxEpoch(), lastSeq: seq } };
    },
    watermark() {
      if (missing) return null;
      return { epoch: maxEpoch(), lastSeq: seq, updatedAt: '2026-10-28T10:00:00.000Z' };
    },
    /**
     * @param {{ sinceSeq?: number, limit?: number }} [readOpts]
     */
    read(readOpts = {}) {
      const sinceSeq = Number(readOpts.sinceSeq ?? 0);
      const limit = Number(readOpts.limit ?? 100);
      const entries = list.filter((entry) => Number(entry.seq) > sinceSeq).slice(0, limit);
      return { entries, nextSeq: entries.length === 0 ? sinceSeq : Number(entries[entries.length - 1].seq) };
    },
    verify() {
      if (missing) return { ok: false, entryCount: 0, lastSeq: 0, corruptAt: 'missing' };
      if (corrupt) return { ok: false, entryCount: seq, lastSeq: seq, corruptAt: 'line:1:tampered' };
      return { ok: true, entryCount: seq, lastSeq: seq };
    },
    /** @param {{ backupEpoch: number, backupCreatedAt?: string }} input */
    checkForRestore(input) {
      const warnings = external ? [] : ['LEDGER_NOT_EXTERNAL'];
      if (missing) return { ok: false, blockers: ['LEDGER_MISSING'], warnings };
      if (corrupt) return { ok: false, blockers: ['LEDGER_CORRUPT'], warnings };
      if (maxEpoch() < Number(input.backupEpoch ?? 0)) {
        return { ok: false, blockers: ['LEDGER_STALE_BEHIND_BACKUP'], warnings };
      }
      return { ok: true, blockers: [], warnings };
    },
    /** 测试用：当前条目数。 */
    count: () => seq,
  };
}

/**
 * 造一条账本条目（与 deletion.requestDeletion 的返回值对齐）。
 * @param {{ tombstoneId: string, memoryId: string, epoch: number, scopeId?: string }} input
 */
export function ledgerEntry(input) {
  return {
    tombstoneId: input.tombstoneId,
    memoryId: input.memoryId,
    epoch: input.epoch,
    requestedAt: '2026-10-28T10:00:00.000Z',
    scopeId: input.scopeId ?? SCOPE,
    reason: 'm3-test',
    actor: 'owner',
  };
}

/**
 * 统计表行数。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 */
export function countRows(db, table) {
  const row = /** @type {{ n?: number }} */ (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  return Number(row?.n ?? 0);
}

/**
 * 尝试加载 del3 真实账本（不存在返回 null，测试可跳过真实联调用例）。
 * @returns {Promise<((options: { dir: string, readOnly?: boolean }) => any) | null>}
 */
export async function loadRealLedgerFactory() {
  try {
    const module = await import('../../../packages/memory/src/deletion-ledger.js');
    return typeof module.createDeletionLedger === 'function' ? module.createDeletionLedger : null;
  } catch {
    return null;
  }
}
