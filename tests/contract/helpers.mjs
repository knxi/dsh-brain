// @ts-check
/**
 * M1 契约测试的公共工具。
 *
 * 纪律：测试**不碰**真实记忆库，全部用 `mkdtemp` 下的临时主账。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../packages/core/src/index.js';
import { openBrain } from '../../packages/memory/src/index.js';

export { assert };

/** 仓库内 migrations 目录。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** CONTRACTS 第 4 节要求的 16 张表。 */
export const REQUIRED_TABLES = Object.freeze([
  'events',
  'sessions',
  'memories',
  'memory_versions',
  'source_refs',
  'summaries',
  'summary_sources',
  'task_snapshots',
  'context_packages',
  'outbox',
  'consumer_offsets',
  'deletion_tombstones',
  'deletion_jobs',
  'backups',
  'audit_logs',
  'schema_migrations',
]);

/** 内部元数据表（不属于 16 张必需表，但由 0001 一起创建）。 */
export const INTERNAL_TABLES = Object.freeze(['brain_meta']);

export const DEFAULT_BINDINGS = Object.freeze({
  source_system: 'dsh',
  scope_id: 'owner-default',
  person_id: 'owner',
});

/**
 * 可推进的固定时钟：同一测试里想控制时间就 advance。
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
 * 造一条测试用原始信封。
 * @param {Record<string, unknown>} [overrides]
 */
export function createEvent(overrides = {}) {
  const seq = typeof overrides.source_seq === 'number' ? overrides.source_seq : 1;
  const minute = String(seq % 60).padStart(2, '0');
  return {
    source_event_id: `host-${seq}`,
    session_id: 'sess-1',
    source_seq: seq,
    event_type: 'user/message',
    origin_system: 'human',
    occurred_at: `2026-10-28T10:${minute}:00.000Z`,
    payload_text: `第 ${seq} 条消息`,
    ...overrides,
  };
}

/**
 * 打开一个临时主账，测试结束自动清理。
 * @param {import('node:test').TestContext} t
 * @param {{ startIso?: string, brainOptions?: Record<string, unknown> }} [opts]
 */
export function createBrain(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m1-'));
  const dbPath = path.join(dir, 'brain.db');
  const backupDir = path.join(dir, 'backups');
  /** @type {Array<Record<string, unknown>>} */
  const alerts = [];
  const fc = fixedClock(opts.startIso);
  const brain = openBrain({
    ...(opts.brainOptions ?? {}),
    dbPath: typeof opts.brainOptions?.dbPath === 'string' ? /** @type {string} */ (opts.brainOptions.dbPath) : dbPath,
    backupDir,
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
        /* 已关闭 / 队列已停：清理阶段不掩盖测试失败 */
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 偶发文件句柄延迟释放，不影响断言 */
    }
  });
  return { brain, dir, dbPath, backupDir, alerts, fc };
}

/**
 * 直接插一条合法 memory（M1 没有记忆写入 API，M2 才有；测试用白盒 SQL 造数据）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id?: string, content?: string, scope_id?: string, status?: string }} [opts]
 */
export function insertMemory(db, opts = {}) {
  const id = opts.id ?? 'mem_1';
  const scopeId = opts.scope_id ?? 'owner-default';
  const status = opts.status ?? 'active';
  db.prepare(
    `INSERT INTO memories (
       id, person_id, scope_id, layer, type, content, summary, source_type, source_ids,
       confidence, importance, privacy, status, created_at, created_at_local,
       updated_at, updated_at_local, mention_count, recall_count, pinned, version
     ) VALUES (?, 'owner', ?, 'long', 'semantic', ?, '摘要', 'owner_words', '[]',
       1.0, 0.8, 'private', ?, '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00',
       '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00', 0, 0, 0, 1)`,
  ).run(id, scopeId, opts.content ?? '会遗忘的内容', status);
  db.prepare(
    `INSERT INTO memory_versions (
       memory_id, version, content, summary, status, source_type, source_ids,
       confidence, importance, privacy, changed_by, created_at, created_at_local
     ) VALUES (?, 1, ?, '摘要', 'active', 'owner_words', '[]', 1.0, 0.8, 'private',
       'test', '2026-10-28T10:00:00.000Z', '2026-10-28T18:00:00.000+08:00')`,
  ).run(id, opts.content ?? '会遗忘的内容');
  return id;
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
