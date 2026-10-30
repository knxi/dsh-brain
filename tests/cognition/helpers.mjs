// @ts-check
/**
 * 系统 3（cognition）测试的公共工具。
 *
 * 纪律（照 M6/M7 测试）：
 * - 全部在 `mkdtemp` 下的临时主账里跑，**绝不碰 `data/brain.db`**；
 * - `workspace` 用**真实实现**（`packages/workspace`），不是桩：
 *   开关语义（默认 0、`isEnabled` 判断）正是我们要测的东西；
 * - 期望值手算写死，不拿实现自己算出来的数当答案。
 */

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../packages/core/src/index.js';
import { openBrain } from '../../packages/memory/src/index.js';
import { createWorkspace } from '../../packages/workspace/src/index.js';
import { createCognition } from '../../packages/cognition/src/index.js';

export { assert };

/** 仓库内 migrations 目录。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** 主账缺省 scope（与 ledger.js / workspace 默认值一致）。 */
export const DEFAULT_SCOPE_ID = 'owner-default';
/** 另一个 scope：跨 scope 不泄漏的对照组。 */
export const OTHER_SCOPE_ID = 'owner-other';
export const DEFAULT_PERSON_ID = 'owner';

/** cognition 会写的全部业务表（「开关关闭零副作用」的断言清单）。 */
export const COGNITION_TABLES = Object.freeze([
  'memory_salience',
  'reflection_runs',
  'reflections',
  'skill_stats',
  'skill_lessons',
  'immune_quarantine',
  'health_alerts',
]);

/**
 * 可推进的固定时钟（时间断言要确定性，不能靠 `Date.now()` 碰运气）。
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
 * 打开一个临时主账 + 真实 workspace + cognition 门面。
 *
 * @param {import('node:test').TestContext} t
 * @param {{ startIso?: string, promoteViaFacade?: boolean, workspace?: boolean, scopeId?: string, backupsDir?: string }} [opts]
 */
export function createBrain(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-cog-'));
  const dbPath = path.join(dir, 'brain.db');
  const fc = fixedClock(opts.startIso);
  /** 主账层面的告警（索引缺失之类）。 */
  const brainAlerts = [];
  /** cognition 层面的告警。 */
  const alerts = [];
  const brain = openBrain({
    dbPath,
    clock: fc.clock,
    alert: (info) => brainAlerts.push(info),
  });
  const scopeId = opts.scopeId ?? DEFAULT_SCOPE_ID;
  const workspace = opts.workspace === false
    ? null
    : createWorkspace({
      db: brain.db,
      queue: brain.queue,
      clock: fc.clock,
      alert: (info) => alerts.push(info),
      bindings: { scope_id: scopeId, person_id: DEFAULT_PERSON_ID },
    });
  const cognition = createCognition({
    db: brain.db,
    queue: brain.queue,
    clock: fc.clock,
    alert: (info) => alerts.push(info),
    workspace,
    bindings: { scope_id: scopeId, person_id: DEFAULT_PERSON_ID },
    dbPath,
    backupsDir: opts.backupsDir ?? path.join(dir, 'backups'),
    // 默认走记忆门面的晋升路径（生产接线形态）；direct 模式用来测「没接门面」的兜底。
    memories: opts.promoteViaFacade === false ? null : brain.memories,
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

  return { brain, workspace, cognition, dir, dbPath, fc, alerts, brainAlerts };
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
 * 断言「cognition 一张业务表都没写」（开关关闭/空跑时的零副作用）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [context]
 * @param {{ memories?: number }} [opts] 已有记忆的基线条数（默认 0）
 */
export function assertNoBusinessWrites(db, context = '', opts = {}) {
  for (const table of COGNITION_TABLES) {
    assert.equal(countRows(db, table), 0, `${context}${table} 必须一行都不写`);
  }
  assert.equal(
    countRows(db, 'memories'),
    opts.memories ?? 0,
    `${context}memories 也不许写（基线 ${opts.memories ?? 0}）`,
  );
}

/**
 * 白盒插入一条 events（测试造数据用；主账正常写入应走 ledger.ingestEvent）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ eventId?: string, scopeId?: string, eventType?: string, payloadText?: string | null, occurredAt?: string, sourceSeq?: number }} [input]
 * @returns {string}
 */
export function insertEvent(db, input = {}) {
  const scopeId = input.scopeId ?? DEFAULT_SCOPE_ID;
  const eventId = input.eventId ?? `evt_${Math.random().toString(16).slice(2, 26)}`;
  const occurredAt = input.occurredAt ?? '2026-10-28T09:00:00.000Z';
  const seq = input.sourceSeq ?? 1;
  db.prepare(
    `INSERT INTO events (
       event_id, schema_version, source_system, source_event_id, scope_id, person_id, session_id,
       turn_id, step_id, source_seq, event_type, origin_system, causation_id, derived_from,
       payload_ref, payload_hash, payload_text, payload_bytes, privacy,
       occurred_at, occurred_at_local, received_at, received_at_local, time_zone,
       content_fingerprint, deletion_epoch, created_at, created_at_local
     ) VALUES (?, 1, 'test', ?, ?, ?, 'session-test', NULL, NULL, ?, ?, 'dsh', NULL, '[]',
               ?, ?, ?, ?, 'private', ?, ?, ?, ?, 'Asia/Shanghai', ?, 0, ?, ?)`,
  ).run(
    eventId,
    `src_${eventId}`,
    scopeId,
    DEFAULT_PERSON_ID,
    seq,
    input.eventType ?? 'message.received',
    `ref:${eventId}`,
    `hash_${eventId}`,
    input.payloadText ?? null,
    input.payloadText === null || input.payloadText === undefined ? null : Buffer.byteLength(input.payloadText, 'utf8'),
    occurredAt,
    occurredAt.replace('Z', '+00:00'),
    occurredAt,
    occurredAt.replace('Z', '+00:00'),
    `fp_${eventId}`,
    occurredAt,
    occurredAt.replace('Z', '+00:00'),
  );
  return eventId;
}

/**
 * 白盒插入一条 `ws_events`（工作空间事件；健康检查会数 error 渠道）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id?: string, scopeId?: string, channel?: string, atMs?: number, module?: string, kind?: string }} [input]
 * @returns {string}
 */
export function insertWsEvent(db, input = {}) {
  const id = input.id ?? `wse_${Math.random().toString(16).slice(2, 26)}`;
  const scopeId = input.scopeId ?? DEFAULT_SCOPE_ID;
  const atMs = input.atMs ?? Date.parse('2026-10-28T09:00:00.000Z');
  const at = new Date(atMs).toISOString();
  db.prepare(
    `INSERT INTO ws_events (
       id, scope_id, at, at_local, at_ms, channel, source_module, kind,
       subject_type, subject_id, payload_json, salience, dedupe_key, created_at, created_at_local
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, '{}', 0, NULL, ?, ?)`,
  ).run(
    id,
    scopeId,
    at,
    at,
    atMs,
    input.channel ?? 'error',
    input.module ?? 'test-module',
    input.kind ?? 'test.event',
    at,
    at,
  );
  return id;
}

/**
 * 白盒插入 N 条 outbox 工作项（健康检查会数积压）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} count
 * @param {{ status?: string }} [opts]
 */
export function insertOutboxItems(db, count, opts = {}) {
  const status = opts.status ?? 'pending';
  const stamp = '2026-10-28T09:00:00.000Z';
  const stmt = db.prepare(
    `INSERT INTO outbox (
       outbox_id, kind, dedupe_key, aggregate_kind, aggregate_id, event_id, payload,
       payload_hash, status, attempts, max_attempts, deletion_epoch,
       created_at, created_at_local, updated_at, updated_at_local
     ) VALUES (?, 'test_job', ?, NULL, NULL, NULL, NULL, NULL, ?, 0, 5, 0, ?, ?, ?, ?)`,
  );
  // 包在一个事务里：逐条 autocommit 会触发几百次 fsync（测试会慢到 20s+）。
  db.exec('BEGIN IMMEDIATE');
  try {
    for (let index = 0; index < count; index += 1) {
      stmt.run(`obx_test_${index}`, `dedupe_${index}`, status, stamp, stamp, stamp, stamp);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      if (db.isTransaction) db.exec('ROLLBACK');
    } catch {
      /* 回滚失败不掩盖原错误 */
    }
    throw err;
  }
}

/**
 * 白盒插一条「卡住的删除任务」（脑干会检查超宽限的 pending/failed 删除任务）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ createdAt?: string, epoch?: number, status?: string }} [opts]
 * @returns {{ tombstoneId: string, jobId: string }}
 */
export function insertPendingDeletionJob(db, opts = {}) {
  const stamp = opts.createdAt ?? '2026-10-28T06:00:00.000Z';
  const epoch = opts.epoch ?? 1;
  const status = opts.status ?? 'pending';
  const tombstoneId = `tsb_test_${epoch}`;
  const jobId = `job_test_${epoch}`;
  db.prepare(
    `INSERT INTO deletion_tombstones (
       tombstone_id, target_kind, target_id, scope_id, reason, requested_by,
       deletion_epoch, status, requested_at, requested_at_local, created_at, created_at_local
     ) VALUES (?, 'memory', ?, ?, 'test', 'test', ?, 'pending', ?, ?, ?, ?)`,
  ).run(tombstoneId, `mem_deleted_${epoch}`, DEFAULT_SCOPE_ID, epoch, stamp, stamp, stamp, stamp);
  db.prepare(
    `INSERT INTO deletion_jobs (
       job_id, tombstone_id, target_kind, target_id, scope_id, kind, status,
       attempts, max_attempts, deletion_epoch, created_at, created_at_local
     ) VALUES (?, ?, 'memory', ?, ?, 'purge_text', ?, 0, 5, ?, ?, ?)`,
  ).run(jobId, tombstoneId, `mem_deleted_${epoch}`, DEFAULT_SCOPE_ID, status, epoch, stamp, stamp);
  return { tombstoneId, jobId };
}

/**
 * 开关便捷写法（真实 workspace）。
 * @param {any} workspace
 * @param {string} name
 * @param {string} value
 */
export async function setSwitch(workspace, name, value) {
  return workspace.setSwitch(name, value, { by: 'test', reason: '测试' });
}

/**
 * 在指定目录造一个「备份文件」，并把 mtime 设到指定时刻。
 * @param {string} dir
 * @param {string} name
 * @param {number} mtimeMs
 */
export function touchBackup(dir, name, mtimeMs) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  writeFileSync(file, 'fake-backup');
  const seconds = mtimeMs / 1000;
  utimesSync(file, seconds, seconds);
  return file;
}
