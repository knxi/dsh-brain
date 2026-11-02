// @ts-check
/**
 * 异步删除清理 worker（M3-INTERFACES §2）。
 *
 * ## 全链位置
 * ```
 * requestDeletion：tombstone → epoch → 账本 → 立即屏蔽 → 202 + jobIds
 *   ↓（异步）
 * 本文件 runOnce()：正文 → FTS 三表 → context_packages → 导出 → blob 引用
 *   ↓
 * deletionStatus(memoryId)：分层报告（UI 靠它分四层显示，不许合成一个「已删除」）
 * ```
 *
 * ## 三条硬要求
 * 1. **每步重查屏障**。每个步骤执行前都重新确认「这条目标现在仍然是删除态」。
 *    删除前启动、删除后完成的旧 worker 不许把内容写回——本 worker 的所有写操作都是
 *    「删除方向」（清字段、删行、置状态），没有任何一步会把内容写回去；捕获的
 *    hash/ID 只用于报告，不用于重建。
 * 2. **派生依赖立即屏蔽在前**，清理在后。`requestDeletion` 已经把摘要置 suppressed、
 *    上下文包置 discarded；这里只是把残留数据真正抹掉。
 * 3. **不许过度承诺**。`deletionStatus()` 里没有任何「已彻底删除」的说法：
 *    在线清理完成 ≠ 旧备份到期 ≠ 外部副本已核实 ≠ 物理介质已擦除。四层分开报。
 *
 * ## 与 M1 `runPurgeWorker` 的关系
 * M1 的 worker 只认 `purge_text`（其余 kind 会显式 failed/dead）。本 worker 接管 M3 的
 * 完整五步，并对已存在的墓碑**幂等补齐**缺失的 job（不改变 M1 的 `DEFAULT_PURGE_JOBS`，
 * 那样会让 M1 的既有行为漂移）。两者不要同时跑同一批 job。
 */

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { BrainError } from '@dsh-brain/core';
import { M3_PURGE_JOBS } from './deletion.js';
import { insertAudit } from './ledger.js';
import { META_KEYS, readMetaInt } from './meta.js';
import { createTxApi } from './write-queue.js';
import { searchNames } from './search-bridge.js';

/** @typedef {import('./write-queue.js').TxApi} TxApi */
/** @typedef {{ utc: string, local: string }} Stamp */

/**
 * 每个步骤对应的可读名（UI 与日志都用它，不另起一套词）。
 * 顺序就是执行顺序，与 `M3_PURGE_JOBS` 一致。
 */
export const PURGE_STEP_LABELS = Object.freeze({
  purge_text: '清正文',
  scrub_index: '清 FTS 三表',
  drop_context_packages: '清上下文包引用',
  purge_exports: '清导出文件',
  purge_blobs: '摘 blob 引用',
});

/** 默认备份保留天数（与 backup3 的 prune 默认一致；到期时间按绝对时间算）。 */
export const DEFAULT_BACKUP_RETENTION_DAYS = 7;

/** 已知的宿主 / 其它插件源记录（未处理时 handled=false，不许默认成 true）。 */
export const DEFAULT_HOST_COPIES = Object.freeze([
  { system: 'dsh', handled: false },
  { system: 'engram', handled: false },
  { system: 'lingshu', handled: false },
]);

/**
 * 已知的外部辐射面。**默认全部 verified=false**：我们没有能力核实它们，
 * 就不许写 true（「外部副本未核实就写 verified=false」是 M3 的诚实要求）。
 */
export const DEFAULT_EXTERNAL_COPIES = Object.freeze([
  { kind: 'model-provider-request', verified: false },
  { kind: 'host-session-log', verified: false },
  { kind: 'offline-backup-media', verified: false },
]);

/** @param {string} prefix */
function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/**
 * 递归收集目录下的文件（限深，避免误扫一个巨大的挂载点）。
 * @param {string} dir
 * @param {number} [maxDepth]
 * @returns {string[]}
 */
function listFiles(dir, maxDepth = 3) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} current @param {number} depth */
  const walk = (current, depth) => {
    if (depth > maxDepth) return;
    /** @type {import('node:fs').Dirent[]} */
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return; // 目录读不了就当它没有（不因为一个坏目录把整步搞崩）
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(dir, 0);
  return out;
}

/**
 * 造 M3 删除 worker。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: TxApi) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => Stamp, timeZone?: string },
 *   barrier: { checkTargetBarrier: (job: Record<string, unknown>) => { ok: boolean, reason?: string } },
 *   ledger?: { verify: () => { ok: boolean }, watermark: () => { epoch: number }, readAfterEpoch: (epoch: number) => unknown[] } | null,
 *   dbPath?: string,
 *   exportsDir?: string | null,
 *   blobsDir?: string | null,
 *   backupRetentionDays?: number,
 *   externalCopies?: Array<{ kind: string, verified: boolean }> | null,
 *   hostCopies?: Array<{ system: string, handled: boolean }> | null,
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 * }} options
 */
export function createDeletionWorker(options) {
  const { db, queue, clock, barrier } = options;
  const alert = options.alert ?? (() => {});
  const baseDir = options.dbPath ? path.dirname(path.resolve(options.dbPath)) : null;
  const exportsDir = options.exportsDir === undefined ? (baseDir ? path.join(baseDir, 'exports') : null) : options.exportsDir;
  const blobsDir = options.blobsDir === undefined ? (baseDir ? path.join(baseDir, 'blobs') : null) : options.blobsDir;
  const retentionDays = options.backupRetentionDays ?? DEFAULT_BACKUP_RETENTION_DAYS;
  const externalCopies = options.externalCopies ?? [...DEFAULT_EXTERNAL_COPIES];
  const hostCopies = options.hostCopies ?? [...DEFAULT_HOST_COPIES];

  /** 只读句柄（读路径用，不开事务）。 */
  const tx = createTxApi(db);

  /** 三套索引表名（与 0002 迁移一致，改前缀要同步改 search-bridge）。 */
  const indexNames = searchNames();

  /**
   * 索引表是否存在。缺表不是错误：迁移没跑 = 本来就没有索引残留。
   * @param {string} name
   * @returns {boolean}
   */
  function tableExists(name) {
    return (
      db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE (type = 'table' OR type = 'view') AND name = ?").get(name) !== undefined
    );
  }

  /**
   * 屏障重查（**每个步骤执行前都调**）。
   *
   * 用目标级判据而不是全局 epoch：契约 §8 的「必须重查屏障」是为了不让过期 worker 写回，
   * 但清理类 job 用全局 epoch 会被「别的目标发生删除」误伤（M1 实测过，见 m1-notes §4.11）。
   *
   * @param {Record<string, unknown>} job
   * @returns {{ ok: boolean, reason: string, epoch: number }}
   */
  function recheckBarrier(job) {
    const tomb = /** @type {Record<string, unknown> | undefined} */ (
      tx.get('SELECT * FROM deletion_tombstones WHERE tombstone_id = ?', [String(job.tombstone_id)])
    );
    if (tomb === undefined) {
      return { ok: false, reason: 'tombstone_missing', epoch: Number(job.deletion_epoch) };
    }
    if (String(tomb.status) === 'failed') {
      return { ok: false, reason: 'tombstone_failed', epoch: Number(tomb.deletion_epoch) };
    }
    // 目标仍然处于删除态才允许清理。epoch 用的是**墓碑当前**的 epoch（可能比 job 上记的更新：
    // 期间发生过别的删除不影响本目标的清理，删除方向多做一次无害）。
    const targetKind = String(job.target_kind);
    const targetId = String(job.target_id);
    const epoch = Number(tomb.deletion_epoch);
    switch (targetKind) {
      case 'memory': {
        const row = /** @type {Record<string, unknown> | undefined} */ (
          tx.get('SELECT status, deletion_epoch FROM memories WHERE id = ?', [targetId])
        );
        // 行已经没了（被彻底清掉）→ 目标确实不在活数据里，继续清残留
        if (row === undefined) return { ok: true, reason: 'target_absent', epoch };
        if (String(row.status) !== 'deleted') {
          // 目标被改回非删除态（例如恢复流程重放前）→ 不许继续清理
          return { ok: false, reason: 'target_not_deleted', epoch };
        }
        return { ok: true, reason: 'ok', epoch };
      }
      default:
        return { ok: true, reason: 'ok', epoch };
    }
  }

  /**
   * 给一个墓碑补齐缺失的 M3 步骤（幂等：同墓碑同 kind 只插一次）。
   * @param {TxApi} txh
   * @param {Record<string, unknown>} tomb
   * @param {Stamp} stamp
   * @returns {number} 新插入的 job 数
   */
  function queueJobsForTombstone(txh, tomb, stamp) {
    const epoch = Number(tomb.deletion_epoch);
    let queued = 0;
    for (const kind of M3_PURGE_JOBS) {
      const exists = txh.get('SELECT 1 AS hit FROM deletion_jobs WHERE tombstone_id = ? AND kind = ?', [
        String(tomb.tombstone_id),
        kind,
      ]);
      if (exists !== undefined) continue;
      txh.run(
        `INSERT INTO deletion_jobs (
           job_id, tombstone_id, target_kind, target_id, scope_id, kind,
           status, attempts, max_attempts, deletion_epoch, created_at, created_at_local
         ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, 5, ?, ?, ?)`,
        [
          newId('job'),
          String(tomb.tombstone_id),
          String(tomb.target_kind),
          String(tomb.target_id),
          String(tomb.scope_id),
          kind,
          epoch,
          stamp.utc,
          stamp.local,
        ],
      );
      queued += 1;
    }
    return queued;
  }

  /**
   * 补齐 M3 五步 job（幂等）。只针对仍是 pending/purged 的墓碑。
   * @param {{ limit?: number }} [opts]
   * @returns {Promise<{ queued: number, tombstones: number }>}
   */
  async function ensureQueued(opts = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    return queue.write(
      (txh) => {
        const tombs = txh.all(
          `SELECT * FROM deletion_tombstones
            WHERE status IN ('pending', 'purged')
            ORDER BY deletion_epoch ASC
            LIMIT ?`,
          [limit],
        );
        const stamp = clock.stamp();
        let queued = 0;
        for (const tomb of tombs) queued += queueJobsForTombstone(txh, tomb, stamp);
        return { queued, tombstones: tombs.length };
      },
      { label: 'deletionWorker.ensureQueued' },
    );
  }

  /**
   * 对**已有墓碑**的目标补齐清理队列（M3-INTERFACES §2.2 的 `enqueue` 入口）。
   *
   * 刻意不允许用它"发起删除"：发起删除必须走 `deletion.requestDeletion`（要写账本、抬
   * epoch、立即屏蔽）。这里只补 job，避免出现「排了清理但没打墓碑」的半吊子状态。
   *
   * @param {{ memoryId?: string, targetId?: string, targetKind?: string, reason?: string, actor?: string }} input
   * @returns {Promise<{ tombstoneId: string, epoch: number, queued: number }>}
   */
  async function enqueue(input = {}) {
    const targetKind = input.targetKind ?? 'memory';
    const targetId = input.memoryId ?? input.targetId;
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw new BrainError('INVALID_ARGUMENT', 'deletionWorker.enqueue 需要 memoryId（或 targetId）');
    }
    return queue.write(
      (txh) => {
        const tomb = /** @type {Record<string, unknown> | undefined} */ (
          txh.get('SELECT * FROM deletion_tombstones WHERE target_kind = ? AND target_id = ?', [targetKind, targetId])
        );
        if (tomb === undefined) {
          throw new BrainError(
            'NOT_FOUND',
            '该目标没有删除墓碑：发起删除必须走 deletion.requestDeletion（worker 只负责清理，不负责打标记）',
          );
        }
        const queued = queueJobsForTombstone(txh, tomb, clock.stamp());
        return { tombstoneId: String(tomb.tombstone_id), epoch: Number(tomb.deletion_epoch), queued };
      },
      { label: 'deletionWorker.enqueue' },
    );
  }

  /**
   * 认领一批 job（按「epoch → 步骤顺序」排序，保证同一目标 5 步不乱序）。
   * @param {number} limit
   * @returns {Promise<Array<Record<string, unknown>>>}
   */
  async function claimJobs(limit) {
    const order =
      "CASE kind WHEN 'purge_text' THEN 0 WHEN 'scrub_index' THEN 1 WHEN 'drop_context_packages' THEN 2 " +
      "WHEN 'purge_exports' THEN 3 WHEN 'purge_blobs' THEN 4 ELSE 9 END";
    return queue.write(
      (txh) => {
        const rows = txh.all(
          `SELECT * FROM deletion_jobs
            WHERE status IN ('pending', 'failed')
            ORDER BY deletion_epoch ASC, ${order} ASC, created_at ASC, job_id ASC
            LIMIT ?`,
          [limit],
        );
        if (rows.length === 0) return [];
        const stamp = clock.stamp();
        const ids = rows.map((row) => String(row.job_id));
        const placeholders = ids.map(() => '?').join(',');
        txh.run(
          `UPDATE deletion_jobs
              SET status = 'running', attempts = attempts + 1, started_at = ?, started_at_local = ?
            WHERE job_id IN (${placeholders})`,
          [stamp.utc, stamp.local, ...ids],
        );
        return rows.map((row) => ({ ...row, attempts: Number(row.attempts ?? 0) + 1 }));
      },
      { label: 'deletionWorker.claim' },
    );
  }

  /**
   * 第 1 步：清正文（与 M1 等价，另把目标在 `memory_versions` 里的正文也清掉）。
   * @param {TxApi} txh
   * @param {Record<string, unknown>} job
   * @returns {{ rowsTouched: number, detail?: Record<string, unknown> }}
   */
  function stepPurgeText(txh, job) {
    const targetId = String(job.target_id);
    const stamp = clock.stamp();
    let changed = 0;
    switch (String(job.target_kind)) {
      case 'memory': {
        changed += Number(
          txh.run(
            `UPDATE memories
                SET content = NULL, summary = NULL, content_hash = NULL, status = 'deleted',
                    updated_at = ?, updated_at_local = ?
              WHERE id = ?`,
            [stamp.utc, stamp.local, targetId],
          ).changes,
        );
        changed += Number(
          txh.run('UPDATE memory_versions SET content = NULL, summary = NULL WHERE memory_id = ?', [targetId]).changes,
        );
        changed += Number(txh.run('DELETE FROM source_refs WHERE memory_id = ?', [targetId]).changes);
        changed += Number(
          txh.run(
            `UPDATE summaries
                SET content = NULL, status = 'deleted', updated_at = ?, updated_at_local = ?
              WHERE summary_id IN (
                SELECT summary_id FROM summary_sources WHERE source_kind = 'memory' AND source_id = ?
              )`,
            [stamp.utc, stamp.local, targetId],
          ).changes,
        );
        return { rowsTouched: changed };
      }
      case 'event': {
        changed += Number(txh.run('UPDATE events SET payload_text = NULL WHERE event_id = ?', [targetId]).changes);
        return { rowsTouched: changed };
      }
      case 'session': {
        changed += Number(txh.run('UPDATE events SET payload_text = NULL WHERE session_id = ?', [targetId]).changes);
        return { rowsTouched: changed };
      }
      case 'summary': {
        changed += Number(
          txh.run(
            `UPDATE summaries SET content = NULL, status = 'deleted', updated_at = ?, updated_at_local = ?
              WHERE summary_id = ?`,
            [stamp.utc, stamp.local, targetId],
          ).changes,
        );
        return { rowsTouched: changed };
      }
      case 'source_ref': {
        changed += Number(txh.run('DELETE FROM source_refs WHERE ref_id = ?', [targetId]).changes);
        return { rowsTouched: changed };
      }
      case 'context_package': {
        changed += Number(
          txh.run("UPDATE context_packages SET status = 'discarded' WHERE context_id = ?", [targetId]).changes,
        );
        return { rowsTouched: changed };
      }
      case 'task_snapshot': {
        changed += Number(txh.run("UPDATE task_snapshots SET pending_effects = '[]' WHERE snapshot_id = ?", [targetId]).changes);
        return { rowsTouched: changed };
      }
      case 'scope': {
        changed += Number(txh.run('UPDATE events SET payload_text = NULL WHERE scope_id = ?', [String(job.scope_id)]).changes);
        return { rowsTouched: changed };
      }
      default:
        throw new BrainError('INVALID_ARGUMENT', `未知目标类型：${String(job.target_kind)}`);
    }
  }

  /**
   * 第 2 步：清 FTS 三表（`search_fts_char` / `search_fts_trigram` / `search_ngram`）。
   *
   * 为什么不用 `SearchIndex.removeDoc()`：它内部按 `docHas()` 判存在，索引表缺失时会炸；
   * 而"表不存在"在这种清理路径上是正常状态（迁移没跑）。这里直接按 doc_id 删，幂等。
   * @param {TxApi} txh
   * @param {Record<string, unknown>} job
   * @returns {{ rowsTouched: number, detail?: Record<string, unknown> }}
   */
  function stepScrubIndex(txh, job) {
    if (String(job.target_kind) !== 'memory') {
      return { rowsTouched: 0, detail: { notApplicable: 'index_only_for_memory' } };
    }
    const docId = String(job.target_id);
    const tables = [indexNames.ftsChar, indexNames.ftsTrigram, indexNames.ngram];
    const missing = tables.filter((name) => !tableExists(name));
    if (missing.length === tables.length) {
      return { rowsTouched: 0, detail: { indexMissing: true } };
    }
    let changed = 0;
    /** @type {Record<string, number>} */
    const perTable = {};
    for (const name of tables) {
      if (missing.includes(name)) continue;
      const result = txh.run(`DELETE FROM ${name} WHERE doc_id = ?`, [docId]);
      perTable[name] = Number(result.changes);
      changed += Number(result.changes);
    }
    return { rowsTouched: changed, detail: { perTable, missing } };
  }

  /**
   * 第 3 步：清 `context_packages` 里对该目标的引用。
   *
   * 包本身在 `requestDeletion` 里已经 discarded（对外不可读），这里把**内容字段**抹掉，
   * 免得构包片段留在包里还能被读到。
   * @param {TxApi} txh
   * @param {Record<string, unknown>} job
   * @returns {{ rowsTouched: number, detail?: Record<string, unknown> }}
   */
  function stepDropContextPackages(txh, job) {
    const targetId = String(job.target_id);
    if (String(job.target_kind) === 'context_package') {
      const changed = Number(
        txh.run(
          `UPDATE context_packages
              SET status = 'discarded', segments_json = NULL, diagnostics_json = NULL
            WHERE context_id = ?`,
          [targetId],
        ).changes,
      );
      return { rowsTouched: changed };
    }
    if (String(job.target_kind) !== 'memory') {
      return { rowsTouched: 0, detail: { notApplicable: 'memory_reference_only' } };
    }
    // memory_versions 是 `[{"memoryId":"mem_x","version":1}]`：用带引号的精确片段匹配，
    // 不用裸 id（`mem_a` 不该命中 `mem_ab`）。
    const needle = `%"memoryId":"${targetId}"%`;
    const rows = txh.all(
      'SELECT context_id FROM context_packages WHERE memory_versions LIKE ? OR segments_json LIKE ?',
      [needle, needle],
    );
    if (rows.length === 0) return { rowsTouched: 0, detail: { packages: 0 } };
    let changed = 0;
    for (const row of rows) {
      changed += Number(
        txh.run(
          `UPDATE context_packages
              SET status = 'discarded', segments_json = NULL, diagnostics_json = NULL,
                  memory_versions = '[]'
            WHERE context_id = ?`,
          [String(row.context_id)],
        ).changes,
      );
    }
    return { rowsTouched: changed, detail: { packages: rows.length } };
  }

  /**
   * 第 4 步：清导出文件（JSONL）。
   *
   * 导出是**带水位的异步导出**，不是第二主账（CONTRACTS §0）；但已落盘的文件里可能
   * 还有被删记录，所以这里逐行剔除。不认识的格式保留原样——宁可漏清一行，
   * 也不把用户的导出文件改坏。
   * @param {Record<string, unknown>} job
   * @returns {{ rowsTouched: number, detail?: Record<string, unknown> }}
   */
  function stepPurgeExports(job) {
    if (!exportsDir || !existsSync(exportsDir)) {
      return { rowsTouched: 0, detail: { exportsDir: exportsDir ?? null, dirMissing: true } };
    }
    const targetId = String(job.target_id);
    const files = listFiles(exportsDir).filter((file) => /\.(jsonl|ndjson|json)$/i.test(file));
    let filesTouched = 0;
    let linesRemoved = 0;
    /** @type {string[]} */
    const touched = [];
    for (const file of files) {
      let text;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue; // 读不了的文件跳过（权限/占用），不因为一个文件把整步搞失败
      }
      const lines = text.split('\n');
      /** @type {string[]} */
      const kept = [];
      let removedHere = 0;
      for (const line of lines) {
        if (line.trim().length === 0) {
          kept.push(line);
          continue;
        }
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          kept.push(line); // 解析不了的行原样保留
          continue;
        }
        const hit =
          record !== null &&
          typeof record === 'object' &&
          (String(record.id ?? '') === targetId || String(record.memoryId ?? record.memory_id ?? '') === targetId);
        if (hit) {
          removedHere += 1;
          continue;
        }
        kept.push(line);
      }
      if (removedHere === 0) continue;
      // 原子重写：.tmp → rename。写入失败就不动原文件（宁可留残留，不可留半个文件）。
      const tmp = `${file}.purge-${process.pid}.tmp`;
      writeFileSync(tmp, kept.join('\n'), { encoding: 'utf8' });
      renameSync(tmp, file);
      filesTouched += 1;
      linesRemoved += removedHere;
      touched.push(file);
    }
    return { rowsTouched: linesRemoved, detail: { filesScanned: files.length, filesTouched, linesRemoved, files: touched } };
  }

  /**
   * 第 5 步：摘 blob 引用。
   *
   * **只摘引用、不物理删文件**。原因不是偷懒：备份读者可能还引用同一个 blob
   * （M3-INTERFACES §4.1「备份读者完成前禁止 GC 删除被引用 blob」），物理 GC 是
   * backup3 的独立能力。这一步的产出是「哪些 blob 现在无引用、可被 GC」，
   * 以及它是否还有物理文件残留 —— 那个残留要如实报给 UI。
   * @param {TxApi} txh
   * @param {Record<string, unknown>} job
   * @returns {{ rowsTouched: number, detail?: Record<string, unknown> }}
   */
  function stepPurgeBlobs(txh, job) {
    if (String(job.target_kind) !== 'memory') {
      return { rowsTouched: 0, detail: { notApplicable: 'blob_refs_only_for_memory' } };
    }
    const targetId = String(job.target_id);
    /** @type {Set<string>} */
    const hashes = new Set();
    for (const row of txh.all(
      'SELECT DISTINCT content_hash AS hash FROM memory_versions WHERE memory_id = ? AND content_hash IS NOT NULL',
      [targetId],
    )) {
      hashes.add(String(row.hash));
    }
    for (const row of txh.all(
      'SELECT DISTINCT payload_hash AS hash FROM memory_versions WHERE memory_id = ? AND payload_hash IS NOT NULL',
      [targetId],
    )) {
      hashes.add(String(row.hash));
    }
    if (hashes.size === 0) return { rowsTouched: 0, detail: { hashes: 0 } };

    /** @type {Array<{ hash: string, filePresent: boolean }>} */
    const released = [];
    /** @type {Array<{ hash: string, refCount: number }>} */
    const stillReferenced = [];
    for (const hash of hashes) {
      const liveMemories = Number(
        txh.get(
          "SELECT COUNT(*) AS n FROM memories WHERE content_hash = ? AND deletion_epoch = 0 AND status <> 'deleted'",
          [hash],
        )?.n ?? 0,
      );
      const liveVersions = Number(
        txh.get(
          `SELECT COUNT(*) AS n FROM memory_versions mv
             JOIN memories m ON m.id = mv.memory_id
            WHERE mv.content_hash = ? AND m.deletion_epoch = 0 AND m.status <> 'deleted'`,
          [hash],
        )?.n ?? 0,
      );
      const liveRefs = Number(txh.get('SELECT COUNT(*) AS n FROM source_refs WHERE content_hash = ?', [hash])?.n ?? 0);
      const liveEvents = Number(
        txh.get('SELECT COUNT(*) AS n FROM events WHERE payload_hash = ? AND deletion_epoch = 0', [hash])?.n ?? 0,
      );
      const refCount = liveMemories + liveVersions + liveRefs + liveEvents;
      if (refCount > 0) {
        stillReferenced.push({ hash, refCount });
        continue;
      }
      const plain = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
      const filePresent =
        blobsDir !== null && blobsDir !== undefined && (existsSync(path.join(blobsDir, plain)) || existsSync(path.join(blobsDir, hash)));
      released.push({ hash, filePresent });
    }
    return {
      rowsTouched: 0,
      detail: {
        released,
        stillReferenced,
        physicalFilesRemoved: 0,
        physicalRemovalDeferred: true,
        note: '物理 blobs 未删除：备份读者可能仍引用它们，GC 属 backup3 的独立能力',
      },
    };
  }

  /** 步骤实现表（顺序与 M3_PURGE_JOBS 一致）。 */
  const STEP_IMPL = Object.freeze({
    purge_text: stepPurgeText,
    scrub_index: stepScrubIndex,
    drop_context_packages: stepDropContextPackages,
    purge_blobs: stepPurgeBlobs,
  });

  /**
   * 记录一次 job 成功。
   * @param {Record<string, unknown>} job
   * @param {{ rowsTouched: number, detail?: Record<string, unknown> }} outcome
   */
  async function completeJob(job, outcome) {
    const jobId = String(job.job_id);
    await queue.write(
      (txh) => {
        const stamp = clock.stamp();
        txh.run(
          `UPDATE deletion_jobs SET status = 'done', last_error = NULL, finished_at = ?, finished_at_local = ?
            WHERE job_id = ?`,
          [stamp.utc, stamp.local, jobId],
        );
        const remaining = txh.get("SELECT COUNT(*) AS n FROM deletion_jobs WHERE tombstone_id = ? AND status <> 'done'", [
          String(job.tombstone_id),
        ]);
        if (Number(remaining?.n ?? 0) === 0) {
          // 五步全绿才算 purged→verified。注意：verified 只代表**在线清理**完成，
          // 不代表旧备份到期、外部副本撤回或物理擦除（那些在 deletionStatus 里单列）。
          txh.run("UPDATE deletion_tombstones SET status = 'verified' WHERE tombstone_id = ?", [String(job.tombstone_id)]);
        } else {
          txh.run("UPDATE deletion_tombstones SET status = 'purged' WHERE tombstone_id = ? AND status = 'pending'", [
            String(job.tombstone_id),
          ]);
        }
        insertAudit(
          txh,
          newId('aud'),
          {
            action: 'deletion.purged',
            actor: 'deletion-worker',
            target_kind: String(job.target_kind),
            target_id: String(job.target_id),
            scope_id: String(job.scope_id),
            result: 'ok',
            detail: {
              job_id: jobId,
              kind: String(job.kind),
              rows_touched: outcome.rowsTouched,
              ...(outcome.detail === undefined ? {} : { step: outcome.detail }),
              deletion_epoch: Number(job.deletion_epoch),
            },
            deletion_epoch: Number(job.deletion_epoch),
          },
          clock,
        );
      },
      { label: 'deletionWorker.completeJob' },
    );
  }

  /**
   * 记录一次 job 失败（含屏障拒绝）。
   * @param {Record<string, unknown>} job
   * @param {string} reason
   * @param {boolean} countAttempt
   */
  async function failJob(job, reason, countAttempt) {
    const jobId = String(job.job_id);
    const attempts = Number(job.attempts ?? 1);
    const maxAttempts = Number(job.max_attempts ?? 5);
    const alive = countAttempt ? attempts < maxAttempts : true;
    await queue.write(
      (txh) => {
        const stamp = clock.stamp();
        txh.run(
          `UPDATE deletion_jobs SET status = ?, last_error = ?, finished_at = ?, finished_at_local = ?
            WHERE job_id = ?`,
          [alive ? 'failed' : 'dead', reason.slice(0, 2000), stamp.utc, stamp.local, jobId],
        );
        if (!alive) {
          txh.run("UPDATE deletion_tombstones SET status = 'failed' WHERE tombstone_id = ?", [String(job.tombstone_id)]);
          insertAudit(
            txh,
            newId('aud'),
            {
              action: 'deletion.dead_letter',
              actor: 'deletion-worker',
              target_kind: String(job.target_kind),
              target_id: String(job.target_id),
              scope_id: String(job.scope_id),
              result: 'error',
              detail: { job_id: jobId, kind: String(job.kind), attempts, max_attempts: maxAttempts, reason: reason.slice(0, 200) },
              deletion_epoch: Number(job.deletion_epoch),
            },
            clock,
          );
        }
      },
      { label: 'deletionWorker.failJob' },
    );
    if (!alive) {
      alert({
        kind: 'deletion_dead',
        message: `删除清理任务失败达上限：${String(job.target_kind)}/${String(job.target_id)}（${String(job.kind)}）`,
        detail: { job_id: jobId, attempts, reason: reason.slice(0, 200) },
      });
    }
  }

  /**
   * 执行一个 job 的完整五步。
   *
   * 注意执行顺序是**硬编码**的 `M3_PURGE_JOBS` 顺序，不依赖 job 的 created_at：
   * 正文必须在 blob 引用之前清（要让 content_hash 还活着才拿得到引用集合）。
   *
   * @param {Record<string, unknown>} job
   * @returns {Promise<{ jobId: string, memoryId: string|null, step: string, ok: boolean, skipped?: boolean, error?: string, detail?: Record<string, unknown> }>}
   */
  async function executeJob(job) {
    const jobId = String(job.job_id);
    const memoryId = String(job.target_kind) === 'memory' ? String(job.target_id) : null;
    const kind = String(job.kind);
    try {
      // 屏障重查：**每步之前**都做（契约 §8）。tombstone 没了 = 目标不再是删除态，
      // 这一步放弃；这不是失败，是"世界变了"，标 done 免得每轮重试。
      const gate = recheckBarrier(job);
      if (!gate.ok) {
        // 屏障拒绝不是「失败」，是「世界变了，不该做」：标 done 并留 note，
        // 既不重试也不消耗 attempts（否则一个消失的墓碑会被反复重试到 dead）。
        await queue.write(
          (txh) => {
            const stamp = clock.stamp();
            txh.run(
              "UPDATE deletion_jobs SET status = 'done', last_error = ?, finished_at = ?, finished_at_local = ? WHERE job_id = ?",
              [`barrier:${gate.reason}`, stamp.utc, stamp.local, jobId],
            );
            insertAudit(
              txh,
              newId('aud'),
              {
                action: 'deletion.purge_skipped',
                actor: 'deletion-worker',
                target_kind: String(job.target_kind),
                target_id: String(job.target_id),
                scope_id: String(job.scope_id),
                result: 'ok',
                detail: { job_id: jobId, kind, barrier: gate.reason, deletion_epoch: Number(job.deletion_epoch) },
                deletion_epoch: Number(job.deletion_epoch),
              },
              clock,
            );
          },
          { label: 'deletionWorker.barrierDone' },
        );
        return { jobId, memoryId, step: kind, ok: true, skipped: true, detail: { barrier: gate.reason } };
      }

      let outcome;
      if (kind === 'purge_exports') {
        // 文件 IO 放在事务外：事务内做文件操作会拉长写锁，而且不受 SQLite 回滚保护
        // （回滚了文件也回不来，所以宁可不进事务）。做完再单独记 job 状态。
        // 但屏障还是要**再查一次**：走到这一步之前可能已经过去了一次 IO 的时间。
        const recheck = recheckBarrier(job);
        if (!recheck.ok) {
          throw new BrainError('DELETION_BARRIER', `清理前屏障复检未通过：${recheck.reason}`, {
            details: { barrier: recheck.reason },
          });
        }
        outcome = stepPurgeExports(job);
      } else {
        const impl = /** @type {((txh: TxApi, job: Record<string, unknown>) => { rowsTouched: number, detail?: Record<string, unknown> }) | undefined} */ (
          STEP_IMPL[/** @type {keyof typeof STEP_IMPL} */ (kind)]
        );
        if (impl === undefined) {
          throw new BrainError('INVALID_ARGUMENT', `M3 worker 不认识的清理步骤：${kind}`);
        }
        // 屏障重查与清理在**同一个事务**里：避免"检查通过 → 别人改了 → 我照旧清"的窗口。
        outcome = await queue.write(
          (txh) => {
            const inner = recheckBarrier(job);
            if (!inner.ok) {
              const err = new BrainError('DELETION_BARRIER', `清理前屏障复检未通过：${inner.reason}`);
              /** @type {any} */ (err).details = { ...(err.details ?? {}), barrier: inner.reason };
              throw err;
            }
            return impl(txh, job);
          },
          { label: `deletionWorker.${kind}` },
        );
      }
      await completeJob(job, outcome);
      return { jobId, memoryId, step: kind, ok: true, detail: outcome.detail ?? { rowsTouched: outcome.rowsTouched } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 屏障类拒绝不消耗重试次数（不是我们的错，是目标状态变了）
      const barrierReason = /** @type {{ details?: { barrier?: string } }} */ (err).details?.barrier;
      await failJob(job, message, barrierReason === undefined);
      return { jobId, memoryId, step: kind, ok: false, error: message };
    }
  }

  /**
   * 跑一轮。
   *
   * @param {{ maxJobs?: number, includeBackfill?: boolean }} [opts]
   * @returns {Promise<{
   *   processed: number,
   *   failed: number,
   *   skipped: number,
   *   backfilled: number,
   *   jobs: Array<{ jobId: string, memoryId: string|null, step: string, ok: boolean, skipped?: boolean, error?: string }>,
   * }>}
   */
  async function runOnce(opts = {}) {
    const maxJobs = Math.max(1, Math.min(opts.maxJobs ?? 10, 200));
    let backfilled = 0;
    if (opts.includeBackfill !== false) {
      const queued = await ensureQueued({ limit: Math.min(maxJobs * 5, 200) });
      backfilled = queued.queued;
    }
    const claimed = await claimJobs(maxJobs);
    /** @type {Array<{ jobId: string, memoryId: string|null, step: string, ok: boolean, skipped?: boolean, error?: string, detail?: Record<string, unknown> }>} */
    const jobs = [];
    let failed = 0;
    let skipped = 0;
    for (const job of claimed) {
      const result = await executeJob(job);
      jobs.push({
        jobId: result.jobId,
        memoryId: result.memoryId,
        step: result.step,
        ok: result.ok,
        ...(result.skipped === true ? { skipped: true } : {}),
        ...(result.error === undefined ? {} : { error: result.error }),
        ...(result.detail === undefined ? {} : { detail: result.detail }),
      });
      if (!result.ok) failed += 1;
      if (result.skipped === true) skipped += 1;
    }
    return { processed: claimed.length, failed, skipped, backfilled, jobs };
  }

  /**
   * 分层删除状态（UI 四层显示的**唯一**数据源）。
   *
   * 诚实边界（写在返回里，不靠 UI 自己补）：
   * - `workerDoneAt` 只代表**在线清理**完成，不等于物理删净；
   * - `backupExpiryAt` 是旧备份**最晚**到期时间，按绝对时间算；
   * - `externalCopies[].verified` 默认 false：没核实就不许写 true；
   * - `hostCopies[].handled` 默认 false：其它插件源记录我们没处理；
   * - `claims.physicallyErased` 恒 false：MVP 不做物理擦除。
   *
   * @param {string} memoryId
   * @param {{ targetKind?: string, now?: string }} [opts]
   * @returns {Record<string, unknown>}
   */
  function deletionStatus(memoryId, opts = {}) {
    if (typeof memoryId !== 'string' || memoryId.length === 0) {
      throw new BrainError('INVALID_ARGUMENT', 'deletionStatus 需要 memoryId');
    }
    const targetKind = opts.targetKind ?? 'memory';
    const nowIso = opts.now ?? clock.stamp().utc;
    const nowMs = Date.parse(nowIso);

    const tomb = /** @type {Record<string, unknown> | undefined} */ (
      tx.get('SELECT * FROM deletion_tombstones WHERE target_kind = ? AND target_id = ?', [targetKind, memoryId])
    );
    if (tomb === undefined) {
      return {
        memoryId,
        targetKind,
        found: false,
        shieldedAt: null,
        workerDoneAt: null,
        backupExpiryAt: null,
        externalCopies: [],
        hostCopies: [],
        progress: { total: 0, done: 0, failed: 0 },
        ledgerSynced: false,
        claims: { physicallyErased: false, backupsExpired: false, externalRetracted: false },
        notes: ['没有找到这个目标的删除记录：它可能从未被删除，或这是另一份库。'],
      };
    }

    const tombstoneId = String(tomb.tombstone_id);
    const jobs = /** @type {Array<Record<string, unknown>>} */ (
      tx.all('SELECT * FROM deletion_jobs WHERE tombstone_id = ?', [tombstoneId])
    );
    const total = jobs.length;
    const done = jobs.filter((job) => String(job.status) === 'done').length;
    const failedJobs = jobs.filter((job) => {
      const status = String(job.status);
      return status === 'failed' || status === 'dead';
    }).length;
    const pending = jobs.filter((job) => String(job.status) === 'pending' || String(job.status) === 'running').length;
    const allDone = total > 0 && done === total;
    const workerDoneAt = allDone
      ? jobs
          .map((job) => (job.finished_at === null || job.finished_at === undefined ? null : String(job.finished_at)))
          .filter((value) => value !== null)
          .sort()
          .at(-1) ?? null
      : null;

    // 旧备份最晚到期时间：按**最新一条完成的备份 + 保留天数**，绝对时间算。
    /** @type {string|null} */
    let backupExpiryAt = null;
    let backupExpiryBasis = 'no-backup-records';
    let lastBackupAt = null;
    const lastBackup = /** @type {Record<string, unknown> | undefined} */ (
      tx.get(
        "SELECT created_at FROM backups WHERE status IN ('complete', 'verified') ORDER BY created_at DESC LIMIT 1",
      )
    );
    if (lastBackup !== undefined) {
      lastBackupAt = String(lastBackup.created_at);
      const base = Date.parse(lastBackupAt);
      if (Number.isFinite(base)) {
        backupExpiryAt = new Date(base + retentionDays * 24 * 60 * 60 * 1000).toISOString();
        backupExpiryBasis = 'retention-policy';
      }
    }
    const backupsExpired = backupExpiryAt !== null && Number.isFinite(nowMs) && Date.parse(backupExpiryAt) <= nowMs;

    const ledgerSynced = tomb.ledger_synced_at !== null && tomb.ledger_synced_at !== undefined;

    /** @type {string[]} */
    const notes = [];
    notes.push('立即屏蔽已在写入 tombstone 那一刻生效；在线清理（workerDoneAt）完成不代表物理删净。');
    if (backupExpiryAt === null) {
      notes.push('没有可用的备份记录：算不出「旧备份最晚到期时间」，不能声称旧备份里已无此内容。');
    } else if (!backupsExpired) {
      notes.push(
        `旧备份最晚到期时间按最近一次备份（${lastBackupAt}）+ ${retentionDays} 天计算；到期前备份文件里仍可能有这条内容。`,
      );
    } else {
      notes.push(`按保留策略，旧备份已于 ${backupExpiryAt} 到期；是否真的被清掉取决于备份清理是否实际执行（不代用户断言）。`);
    }
    notes.push('MVP 的每日备份不等于「7 天内物理删净」；物理残留清理 / 加密擦除是单独能力，本状态不含该承诺。');
    notes.push('已经发到模型或外部服务的内容无法追溯撤回，只能停止后续使用。');
    if (!ledgerSynced) {
      notes.push('独立删除账本里没有这条记录（ledgerSynced=false）：旧备份恢复时无法证明它被删过，恢复必须隔离。');
    }
    if (pending > 0) notes.push(`还有 ${pending} 个清理步骤在排队或执行中。`);
    if (failedJobs > 0) notes.push(`${failedJobs} 个清理步骤失败（见 progress.failed），失败步骤的数据可能仍有残留。`);
    if (externalCopies.some((copy) => copy.verified !== true)) {
      notes.push('至少一个外部副本未核实（verified=false）：我们不知道它是否还留着这条内容。');
    }
    if (hostCopies.some((copy) => copy.handled !== true)) {
      notes.push('宿主 / 其它插件源记录未处理（hostCopies[].handled=false）。');
    }

    return {
      memoryId,
      targetKind,
      found: true,
      tombstoneId,
      // ---- 四层（UI 按这个顺序显示，不许合成一个"已删除"）----
      /** 1. 立即屏蔽 */
      shieldedAt: String(tomb.requested_at),
      /** 2. 在线清理完成时间 */
      workerDoneAt,
      workerState: allDone ? 'done' : failedJobs > 0 ? 'failed' : pending > 0 ? 'pending' : 'partial',
      /** 3. 旧备份最晚到期 */
      backupExpiryAt,
      backupExpiryBasis,
      backupRetentionDays: retentionDays,
      lastBackupAt,
      /** 4. 外部副本 + 宿主副本 */
      externalCopies,
      hostCopies,
      // ---- 进度与账本 ----
      progress: { total, done, failed: failedJobs },
      steps: jobs.map((job) => ({
        kind: String(job.kind),
        label: PURGE_STEP_LABELS[/** @type {keyof typeof PURGE_STEP_LABELS} */ (String(job.kind))] ?? String(job.kind),
        status: String(job.status),
        attempts: Number(job.attempts ?? 0),
        lastError: job.last_error === null || job.last_error === undefined ? null : String(job.last_error),
        finishedAt: job.finished_at === null || job.finished_at === undefined ? null : String(job.finished_at),
      })),
      ledgerSynced,
      ledger: ledgerSynced ? { tombstoneId, epoch: Number(tomb.deletion_epoch) } : null,
      deletionEpoch: Number(tomb.deletion_epoch),
      tombstoneStatus: String(tomb.status),
      // ---- 能力边界（不是占位，是如实声明）----
      claims: {
        physicallyErased: false,
        backupsExpired,
        externalRetracted: false,
      },
      notes,
    };
  }

  /**
   * 待清理列表（UI 的 `GET /api/deletions?status=pending`）。
   * @param {{ status?: string, limit?: number }} [opts]
   */
  function listPending(opts = {}) {
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 200));
    const status = opts.status ?? 'pending';
    const rows = /** @type {Array<Record<string, unknown>>} */ (
      status === 'all'
        ? tx.all('SELECT * FROM deletion_jobs ORDER BY created_at ASC LIMIT ?', [limit])
        : tx.all('SELECT * FROM deletion_jobs WHERE status = ? ORDER BY created_at ASC LIMIT ?', [status, limit])
    );
    return rows.map((row) => ({
      jobId: String(row.job_id),
      tombstoneId: String(row.tombstone_id),
      targetKind: String(row.target_kind),
      targetId: String(row.target_id),
      kind: String(row.kind),
      status: String(row.status),
      attempts: Number(row.attempts ?? 0),
      deletionEpoch: Number(row.deletion_epoch),
      lastError: row.last_error === null || row.last_error === undefined ? null : String(row.last_error),
    }));
  }

  /**
   * 当前删除纪元（给上层做屏障自查用）。
   * @returns {number}
   */
  function currentEpoch() {
    return readMetaInt(tx, META_KEYS.deletionEpoch, 0);
  }

  return {
    runOnce,
    ensureQueued,
    enqueue,
    deletionStatus,
    listPending,
    currentEpoch,
    exportsDir,
    blobsDir,
    /** 供测试与 UI 显示的路径信息（不读盘）。 */
    describe() {
      return { exportsDir, blobsDir, backupRetentionDays: retentionDays, steps: [...M3_PURGE_JOBS] };
    },
  };
}
