// @ts-check
/**
 * 单写入队列：进程内串行化所有写事务。
 *
 * 为什么必须有：
 * - 避免同一进程内多连接/多任务同时写导致 SQLITE_BUSY；
 * - 保证「原始事件 + 状态推进 + outbox 工作项」在**同一事务**里提交；
 * - 保证 ACK 发生在 COMMIT 之后：`write()` 的 Promise 在提交成功后才 resolve，
 *   任何失败（含磁盘满）都 reject —— 调用方不得显示「已记住」。
 *
 * 实测边界（见 docs/m1-notes.md）：
 * - `SQLITE_FULL`(13) 会让 SQLite **自动回滚整个事务**，此时 `db.isTransaction === false`，
 *   再执行 `ROLLBACK` 会抛 "cannot rollback - no transaction is active"。
 *   所以回滚一律走 `safeRollback`，绝不掩盖原始错误。
 * - `UNIQUE`(1555) 之类的语句级错误不会销毁事务，事务仍然可用。
 */

import { BrainError, QueueClosedError, StorageError, isBrainError, isSqliteError } from '@dsh-brain/core';

/**
 * 绑定值规整：node:sqlite 不接受 JS 布尔/undefined/NaN。
 * 这是全项目唯一的参数绑定入口，防止各处漏转。
 * @param {unknown} value
 * @returns {null | number | bigint | string | Uint8Array}
 */
export function toBindable(value) {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value ? 1 : 0;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new BrainError('INVALID_ARGUMENT', '不能绑定 NaN/Infinity 到 SQLite 参数');
      }
      return value;
    case 'bigint':
      return value;
    case 'string':
      return value;
    default:
      break;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  throw new BrainError('INVALID_ARGUMENT', `不能绑定 ${Object.prototype.toString.call(value)} 到 SQLite 参数`);
}

/**
 * 事务外也会用到的同步事务执行器。
 *
 * 规则：
 * - `fn` 必须**同步**完成；返回 thenable 视为违约（模型/网络请求不得包在长事务内）。
 * - 出错时安全回滚并抛出原错误（不吞、不换）。
 *
 * @template T
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {(tx: TxApi) => T} fn
 * @param {string} [label]
 * @returns {T}
 */
export function runInTransaction(db, fn, label = 'transaction') {
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (err) {
    throw StorageError.from(err, `${label}:begin`);
  }
  /** @type {T} */
  let result;
  try {
    result = fn(createTxApi(db));
  } catch (err) {
    safeRollback(db);
    throw err;
  }
  if (result !== null && typeof result === 'object' && typeof (/** @type {{ then?: unknown }} */ (result).then) === 'function') {
    safeRollback(db);
    throw new BrainError(
      'WRITE_ASYNC_FORBIDDEN',
      `${label} 的事务回调返回了 Promise：事务内禁止异步 IO（模型/网络请求必须移到事务外）`,
    );
  }
  try {
    db.exec('COMMIT');
  } catch (err) {
    safeRollback(db);
    throw StorageError.from(err, `${label}:commit`);
  }
  return result;
}

/**
 * 安全回滚：SQLITE_FULL 等错误可能已让 SQLite 自动回滚，此时 ROLLBACK 会报错。
 * 这里吞掉回滚失败，保证原始错误向上传播。
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function safeRollback(db) {
  try {
    if (db.isTransaction) db.exec('ROLLBACK');
  } catch {
    /* 事务已不存在：本来就不需要回滚 */
  }
}

/**
 * @typedef {Object} TxApi
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {(sql: string, params?: unknown[] | Record<string, unknown>) => import('node:sqlite').StatementSync} prepare
 * @property {(sql: string, params?: unknown[] | Record<string, unknown>) => { changes: number | bigint, lastInsertRowid: number | bigint }} run
 * @property {(sql: string, params?: unknown[] | Record<string, unknown>) => Record<string, unknown> | undefined} get
 * @property {(sql: string, params?: unknown[] | Record<string, unknown>) => Record<string, unknown>[]} all
 * @property {(sql: string) => void} exec
 */

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {TxApi}
 */
export function createTxApi(db) {
  /**
   * @param {string} sql
   * @param {unknown[] | Record<string, unknown>} [params]
   */
  const bind = (sql, params) => {
    const stmt = db.prepare(sql);
    if (params === undefined) return /** @type {{ stmt: import('node:sqlite').StatementSync, args: [] }} */ ({ stmt, args: [] });
    if (Array.isArray(params)) {
      return { stmt, args: params.map(toBindable) };
    }
    /** @type {Record<string, null | number | bigint | string | Uint8Array>} */
    const named = {};
    for (const [key, value] of Object.entries(params)) named[key] = toBindable(value);
    return { stmt, args: [named] };
  };
  return {
    db,
    prepare: (sql, params) => bind(sql, params).stmt,
    run: (sql, params) => {
      const { stmt, args } = bind(sql, params);
      return /** @type {{ changes: number | bigint, lastInsertRowid: number | bigint }} */ (stmt.run(...args));
    },
    get: (sql, params) => {
      const { stmt, args } = bind(sql, params);
      return /** @type {Record<string, unknown> | undefined} */ (stmt.get(...args));
    },
    all: (sql, params) => {
      const { stmt, args } = bind(sql, params);
      return /** @type {Record<string, unknown>[]} */ (stmt.all(...args));
    },
    exec: (sql) => db.exec(sql),
  };
}

/**
 * @typedef {Object} QueueStats
 * @property {number} pending 已入队尚未完成的任务数（含正在执行的那一个）
 * @property {number} activeWrites 当前正在同步执行事务的数量
 * @property {number} maxActiveWrites 同时执行事务的峰值；串行队列必须恒为 1
 * @property {number} maxPending 挂起任务峰值
 * @property {number} completed 成功提交数
 * @property {number} failed 失败数（含磁盘满）
 * @property {number} slowWrites 超过 slowWriteMs 的写事务数
 * @property {{ code: string, message: string } | null} lastError
 * @property {boolean} closed
 */

/**
 * @typedef {Object} WriteQueueOptions
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {number} [slowWriteMs] 超过该毫秒数的写事务计一次告警（长事务）
 * @property {(info: {label: string, durationMs: number}) => void} [onSlowWrite]
 */

/**
 * 造单写入队列。
 * @param {WriteQueueOptions} options
 */
export function createWriteQueue(options) {
  const db = options.db;
  const slowWriteMs = options.slowWriteMs ?? 1000;
  const onSlowWrite = options.onSlowWrite;

  let tail = /** @type {Promise<void>} */ (Promise.resolve());
  let closed = false;
  let activeWrites = 0;
  let maxActiveWrites = 0;
  let maxPending = 0;
  /** @type {{ pending: number, completed: number, failed: number, slowWrites: number, lastError: { code: string, message: string } | null }} */
  const counters = { pending: 0, completed: 0, failed: 0, slowWrites: 0, lastError: null };

  /**
   * 提交一个写事务。resolve 发生在 COMMIT 之后。
   * @template T
   * @param {(tx: TxApi) => T} fn
   * @param {{ label?: string }} [meta]
   * @returns {Promise<T>}
   */
  function write(fn, meta = {}) {
    const label = meta.label ?? 'write';
    if (closed) {
      return Promise.reject(new QueueClosedError('写入队列已关闭，拒绝新写入'));
    }
    if (typeof fn !== 'function') {
      return Promise.reject(new BrainError('INVALID_ARGUMENT', 'write 需要一个同步事务回调'));
    }
    counters.pending += 1;
    maxPending = Math.max(maxPending, counters.pending);

    /** @type {() => Promise<T>} */
    const execute = async () => {
      const started = Date.now();
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      try {
        const result = runInTransaction(db, fn, label);
        counters.completed += 1;
        return result;
      } catch (err) {
        const wrapped = wrapWriteError(err, label);
        counters.failed += 1;
        counters.lastError = { code: wrapped.code, message: wrapped.message };
        throw wrapped;
      } finally {
        const durationMs = Date.now() - started;
        activeWrites -= 1;
        counters.pending -= 1;
        if (durationMs >= slowWriteMs) {
          counters.slowWrites += 1;
          if (onSlowWrite) {
            try {
              onSlowWrite({ label, durationMs });
            } catch {
              /* 告警回调不得影响写事务结果 */
            }
          }
        }
      }
    };

    // 前一个任务失败不能阻塞后一个；队列只保证串行，不保证整批成功。
    const task = tail.then(execute, execute);
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  /** 等待队列排空（不含之后新入队的任务）。 */
  async function drain() {
    await tail;
  }

  /**
   * 关闭：等排空后关闭数据库句柄。之后 `write` 一律 QueueClosedError。
   * @param {{ timeoutMs?: number }} [opts]
   */
  async function close(opts = {}) {
    closed = true;
    const timeoutMs = opts.timeoutMs ?? 10000;
    await Promise.race([
      drain(),
      new Promise((_resolve, reject) => {
        const timer = setTimeout(() => reject(new QueueClosedError(`关闭超时：队列 ${timeoutMs}ms 未排空`)), timeoutMs);
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) timer.unref();
      }),
    ]);
    try {
      db.close();
    } catch (err) {
      throw StorageError.from(err, 'queue.close');
    }
  }

  /** @returns {QueueStats} */
  function stats() {
    return {
      pending: counters.pending,
      activeWrites,
      maxActiveWrites,
      maxPending,
      completed: counters.completed,
      failed: counters.failed,
      slowWrites: counters.slowWrites,
      lastError: counters.lastError,
      closed,
    };
  }

  return {
    write,
    drain,
    close,
    stats,
    isClosed: () => closed,
  };
}

/**
 * 把写事务里的任何错误规整成项目错误。
 * - 已是 BrainError（ValidationError/ConflictError/DeletionBarrierError…）原样抛出；
 * - node:sqlite 错误按 errcode 映射成 StorageError（磁盘满 → STORAGE_FULL，不 retriable）。
 * @param {unknown} err
 * @param {string} operation
 * @returns {BrainError}
 */
export function wrapWriteError(err, operation) {
  if (isBrainError(err)) return err;
  if (isSqliteError(err)) return StorageError.from(err, operation);
  if (err instanceof Error) {
    return new StorageError('STORAGE_ERROR', `${operation} 失败：${err.message}`, {
      details: { operation },
      cause: err,
    });
  }
  return new StorageError('STORAGE_ERROR', `${operation} 失败：${String(err)}`, {
    details: { operation },
  });
}
