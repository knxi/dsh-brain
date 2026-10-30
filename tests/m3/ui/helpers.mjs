// @ts-check
/**
 * M3（删除状态 / 备份中心 / 隔离）测试公共工具。
 *
 * 纪律：
 * - 只用 `mkdtemp` 下的临时主账与临时备份目录，**不碰** `data/`；
 * - del3 / backup3 的门面不存在时，API 必须返回 `not_available` 而不是 500——
 *   这些测试正是要在「门面缺失」的默认环境下跑通；
 * - 合成语料覆盖主人的工作语境，不引用任何真实私密历史。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrain } from '../../../packages/memory/src/index.js';
import { silentLogger } from '../../../apps/server/src/log.mjs';
import { startServer } from '../../../apps/server/src/server.mjs';

export { assert };

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

/** 固定测试凭据：32+ 字符、不像占位符。 */
export const TEST_TOKEN = 'm3uiQ7Zm3xK9vT2pL8wR4yN6bV1cX5aZ0sDfGhJkMnPq';

const NOW = '2026-10-28T12:00:00.000Z';
const LOCAL = '2026-10-28T20:00:00.000+08:00';

/** 合成记忆语料（进墓碑的是它们）。 */
export const CORPUS = Object.freeze([
  {
    id: 'mem-m3-ceiling',
    content: '客厅吊顶标高 1.2m，走 9.5mm 纸面石膏板叠级，灯槽净宽 1200mm。',
    summary: '客厅吊顶 1.2m，石膏板叠级，灯槽 1200mm',
  },
  {
    id: 'mem-m3-partition',
    content: '轻钢龙骨 75 系隔墙，双面双层 9.5mm 纸面石膏板，含人工 128 元/㎡。',
    summary: '轻钢龙骨隔墙 128 元/㎡',
  },
  {
    id: 'mem-m3-drawing',
    content: '建施-03 窗台高度 900mm，石材 2400×600 按缝对齐。',
    summary: '建施-03 窗台 900mm',
  },
]);

/**
 * 建临时主账 + 临时备份/状态目录。
 */
export async function createTempBrain() {
  const dir = mkdtempSync(path.join(tmpdir(), 'brain-m3ui-'));
  const dbPath = path.join(dir, 'brain.db');
  const backupsDir = path.join(dir, 'backups');
  const stateDir = path.join(dir, 'server');
  const brain = openBrain({ dbPath, migrationsDir: MIGRATIONS_DIR, backupDir: backupsDir });

  const db = brain.db;
  for (const m of CORPUS) {
    db.prepare(
      `INSERT INTO memories (
         id, person_id, scope_id, layer, type, content, summary, source_type, source_ids,
         confidence, importance, privacy, status, created_at, created_at_local,
         updated_at, updated_at_local, mention_count, recall_count, pinned, version, content_hash, deletion_epoch
       ) VALUES (?, 'owner', 'owner-default', 'long', 'semantic', ?, ?, 'owner_words', '[]',
                 0.85, 0.7, 'private', 'active', ?, ?, ?, ?, 0, 0, 0, 1, ?, 0)`,
    ).run(m.id, m.content, m.summary, NOW, LOCAL, NOW, LOCAL, `sha256:${m.id}`);
  }

  return {
    dir,
    dbPath,
    backupsDir,
    stateDir,
    brain,
    async close() {
      try {
        await brain.close();
      } catch {
        /* 已关闭 */
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/**
 * 造一条删除墓碑 + 若干清理任务。
 *
 * **走真实删除路径**（`deletion.requestDeletion`）：独立删除账本会同步追加，
 * `ledgerSynced` 才是真的 true。直接往表里插墓碑会造出「数据库认为删了但账本没记」的
 * 假象——那是另一种错误状态，不该当成常态来测四层报告。
 *
 * @param {ReturnType<typeof openBrain>} brain
 * @param {{
 *   memoryId: string, requestedAt?: string, reason?: string, epoch?: number,
 *   jobs?: Array<{ kind?: string, status: string, lastError?: string, finishedAt?: string }>,
 * }} input
 */
export async function seedDeletion(brain, input) {
  const db = brain.db;
  const requestedAt = input.requestedAt ?? NOW;
  const local = LOCAL;

  /** @type {string} */
  let tombstoneId;
  /** @type {number} */
  let epoch;

  const deleter = /** @type {any} */ (brain.deletion);
  if (deleter && typeof deleter.requestDeletion === 'function') {
    const result = await deleter.requestDeletion({
      target_kind: 'memory',
      target_id: input.memoryId,
      scope_id: 'owner-default',
      reason: input.reason ?? 'owner 要求删除（合成测试）',
    });
    tombstoneId = String(result.tombstone_id);
    epoch = Number(result.deletion_epoch);
  } else {
    tombstoneId = `tmb_${input.memoryId}`;
    epoch = input.epoch ?? 1;
    db.prepare(
      `INSERT INTO deletion_tombstones (
         tombstone_id, target_kind, target_id, scope_id, reason, requested_by,
         deletion_epoch, status, requested_at, requested_at_local, created_at, created_at_local
       ) VALUES (?, 'memory', ?, 'owner-default', ?, 'owner', ?, 'pending', ?, ?, ?, ?)`,
    ).run(
      tombstoneId,
      input.memoryId,
      input.reason ?? 'owner 要求删除（合成测试）',
      epoch,
      requestedAt,
      local,
      requestedAt,
      local,
    );
  }

  // 时间可控：真实路径写的是「现在」，测试要模拟「几天前删的」。
  db.prepare('UPDATE deletion_tombstones SET requested_at = ?, requested_at_local = ? WHERE tombstone_id = ?').run(
    requestedAt,
    local,
    tombstoneId,
  );

  // 重写清理任务：真实路径默认建一条 purge_text pending，测试要能指定各种状态。
  db.prepare('DELETE FROM deletion_jobs WHERE tombstone_id = ?').run(tombstoneId);
  let index = 0;
  for (const job of input.jobs ?? []) {
    index += 1;
    db.prepare(
      `INSERT INTO deletion_jobs (
         job_id, tombstone_id, target_kind, target_id, scope_id, kind,
         status, attempts, max_attempts, last_error, deletion_epoch,
         created_at, created_at_local, started_at, started_at_local, finished_at, finished_at_local
       ) VALUES (?, ?, 'memory', ?, 'owner-default', ?, ?, 1, 5, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `job_${tombstoneId}_${index}`,
      tombstoneId,
      input.memoryId,
      job.kind ?? 'purge_text',
      job.status,
      job.lastError ?? null,
      epoch,
      requestedAt,
      local,
      job.status === 'running' || job.status === 'done' ? requestedAt : null,
      job.status === 'running' || job.status === 'done' ? local : null,
      job.finishedAt ?? (job.status === 'done' ? NOW : null),
      job.finishedAt !== undefined || job.status === 'done' ? local : null,
    );
  }
  return { tombstoneId, epoch };
}

/**
 * 造一条备份记录（不含真实文件）。
 * @param {ReturnType<typeof openBrain>} brain
 * @param {{ backupId: string, createdAt: string, retentionUntil?: string|null, status?: string, pathOverride?: string }} input
 */
export function seedBackupRow(brain, input) {
  brain.db
    .prepare(
      `INSERT INTO backups (
         backup_id, kind, path, byte_size, sha256, status, schema_version,
         deletion_epoch, source_watermark, created_at, created_at_local, retention_until
       ) VALUES (?, 'daily', ?, 40960, ?, ?, '0002', 0, 12, ?, ?, ?)`,
    )
    .run(
      input.backupId,
      input.pathOverride ?? path.join(brain.dbPath, '..', 'backups', input.backupId, 'brain.db'),
      `sha256:${input.backupId}`,
      input.status ?? 'verified',
      input.createdAt,
      input.createdAt,
      input.retentionUntil ?? null,
    );
}

/** 设置当前删除水位。 */
export function setDeletionEpoch(brain, epoch) {
  brain.db
    .prepare(
      `INSERT INTO brain_meta (key, value, updated_at, updated_at_local)
       VALUES ('deletion_epoch', ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(String(epoch), NOW, LOCAL);
}

/**
 * 起一个测试服务（端口 0）。
 * @param {{ dbPath: string, backupDir?: string, stateDir?: string, allowBackup?: boolean,
 *   allowRestore?: boolean, isolationReason?: string, restoredFrom?: string, readOnlyDb?: boolean }} opts
 */
export async function startUiServer(opts) {
  const running = await startServer({
    dbPath: opts.dbPath,
    port: 0,
    token: TEST_TOKEN,
    migrationsDir: MIGRATIONS_DIR,
    logger: silentLogger,
    backupDir: opts.backupDir,
    stateDir: opts.stateDir,
    allowBackup: opts.allowBackup ?? false,
    allowRestore: opts.allowRestore ?? false,
    isolationReason: opts.isolationReason,
    restoredFrom: opts.restoredFrom,
    readOnlyDb: opts.readOnlyDb ?? false,
  });
  const base = running.url.replace(/\/$/, '');

  /**
   * @param {string} pathname
   * @param {{ method?: string, token?: string|null, query?: Record<string, string|number|null|undefined>,
   *   body?: unknown, headers?: Record<string,string> }} [init]
   */
  async function request(pathname, init = {}) {
    const { method = 'GET', token = running.token, query, body, headers } = init;
    const url = new URL(`${base}${pathname}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v === null || v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
    /** @type {Record<string,string>} */
    const merged = { ...(headers ?? {}) };
    if (token !== null) merged.Authorization = `Bearer ${token}`;
    if (body !== undefined) merged['Content-Type'] = 'application/json';
    const res = await fetch(url, {
      method,
      headers: merged,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    /** @type {any} */
    let json = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { res, status: res.status, headers: res.headers, text, json };
  }

  return { ...running, base, request };
}
