// @ts-check
/**
 * `brain_meta` 内部元数据读写。
 *
 * 目前只放三类东西：
 * - `deletion_epoch`：全局单调删除纪元。删除事务里 +1，派生任务回写前必须比较它；
 * - `last_snapshot_id`：最近一次一致性快照，便于恢复流程定位；
 * - `db_generation`：库代次（恢复切换后可递增，供缓存失效）。
 *
 * 所有函数都要求传入 `TxApi`（事务内）或 `createTxApi(db)`（只读路径）。
 * 单写入队列保证同进程写串行；跨进程由 `BEGIN IMMEDIATE` 的写锁保证。
 */

import { createTxApi } from './write-queue.js';

/** @typedef {ReturnType<typeof createTxApi>} TxApi */

export const META_KEYS = Object.freeze({
  deletionEpoch: 'deletion_epoch',
  lastSnapshotId: 'last_snapshot_id',
  dbGeneration: 'db_generation',
});

/**
 * @param {TxApi} tx
 * @param {string} key
 * @returns {string | null}
 */
export function readMeta(tx, key) {
  const row = tx.get('SELECT value FROM brain_meta WHERE key = ?', [key]);
  return row === undefined ? null : String(row.value);
}

/**
 * @param {TxApi} tx
 * @param {string} key
 * @param {string} value
 * @param {{ stamp: () => { utc: string, local: string } }} clock
 */
export function writeMeta(tx, key, value, clock) {
  const stamp = clock.stamp();
  tx.run(
    `INSERT INTO brain_meta (key, value, updated_at, updated_at_local)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_at_local = excluded.updated_at_local`,
    [key, value, stamp.utc, stamp.local],
  );
}

/**
 * @param {TxApi} tx
 * @param {string} key
 * @param {number} [fallback]
 * @returns {number}
 */
export function readMetaInt(tx, key, fallback = 0) {
  const row = tx.get('SELECT CAST(value AS INTEGER) AS n FROM brain_meta WHERE key = ?', [key]);
  if (row === undefined || row.n === null) return fallback;
  const n = Number(row.n);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 原子 +1 并返回新值。
 * @param {TxApi} tx
 * @param {string} key
 * @param {{ stamp: () => { utc: string, local: string } }} clock
 * @returns {number}
 */
export function bumpMetaCounter(tx, key, clock) {
  const stamp = clock.stamp();
  tx.run(
    `INSERT INTO brain_meta (key, value, updated_at, updated_at_local)
     VALUES (?, '1', ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = CAST(brain_meta.value AS INTEGER) + 1,
       updated_at = excluded.updated_at,
       updated_at_local = excluded.updated_at_local`,
    [key, stamp.utc, stamp.local],
  );
  const n = readMetaInt(tx, key, 0);
  if (!(n >= 1)) {
    throw new Error(`brain_meta.${key} 递增失败（读到 ${String(n)}）`);
  }
  return n;
}

/**
 * 当前删除纪元（只读）。没有记录时视为 0。
 * @param {TxApi | import('node:sqlite').DatabaseSync} handle
 * @returns {number}
 */
export function readDeletionEpoch(handle) {
  const tx = 'get' in handle ? /** @type {TxApi} */ (handle) : createTxApi(/** @type {import('node:sqlite').DatabaseSync} */ (handle));
  return readMetaInt(tx, META_KEYS.deletionEpoch, 0);
}

/**
 * 分配下一个删除纪元（必须在写事务内调用）。
 * @param {TxApi} tx
 * @param {{ stamp: () => { utc: string, local: string } }} clock
 * @returns {number}
 */
export function bumpDeletionEpoch(tx, clock) {
  return bumpMetaCounter(tx, META_KEYS.deletionEpoch, clock);
}
