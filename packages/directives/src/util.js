// @ts-check
/**
 * 系统 5 的小工具：ID、可绑参数、只读句柄、时间归一、JSON 兜底、事件发布。
 *
 * 刻意不 import `@dsh-brain/core`（零依赖，理由见 index.js 文件头），
 * 所以这里有一份最小的 `toBindable` 与 `createSimpleTxApi`。它们只覆盖本模块
 * 真正用到的 SQLite 绑定类型；写路径上的**事务**仍然由注入的 `queue.write`
 * 提供（`tx` 形如 memory 包的 TxApi：`run/get/all/exec`），本模块不自己 BEGIN。
 */

import { randomBytes } from 'node:crypto';
import { DirectivesError } from './errors.js';

/**
 * 生成带前缀的稳定 ID（与全库同口径：前缀 + 24 位十六进制）。
 * @param {string} prefix
 * @returns {string}
 */
export function newId(prefix) {
  return `${prefix}_${randomBytes(12).toString('hex')}`;
}

/**
 * 绑定值规整：node:sqlite 不接受 JS 布尔 / undefined / NaN。
 * @param {unknown} value
 * @returns {null | number | bigint | string | Uint8Array}
 */
export function toBindable(value) {
  if (value === undefined || value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value ? 1 : 0;
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('不能绑定 NaN/Infinity 到 SQLite 参数');
      return value;
    case 'bigint':
    case 'string':
      return value;
    default:
      break;
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
  if (value instanceof Date) return value.toISOString();
  throw new TypeError(`不能绑定 ${Object.prototype.toString.call(value)} 到 SQLite 参数`);
}

/**
 * 只读句柄（读路径用，不开事务）。
 *
 * 注意：**不要**拿它执行写语句。写一律走 `queue.write`（单写队列 + 事务），
 * 否则「步骤流水 + 预算扣减 + 状态迁移」就不是原子的了。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function createSimpleTxApi(db) {
  /**
   * @param {string} sql
   * @param {unknown[] | Record<string, unknown>} [params]
   */
  const bind = (sql, params) => {
    const stmt = db.prepare(sql);
    if (params === undefined) return { stmt, args: [] };
    if (Array.isArray(params)) return { stmt, args: params.map(toBindable) };
    /** @type {Record<string, unknown>} */
    const named = {};
    for (const [key, value] of Object.entries(params)) named[key] = toBindable(value);
    return { stmt, args: [named] };
  };
  return {
    db,
    run(sql, params) {
      const { stmt, args } = bind(sql, params);
      return /** @type {{ changes: number | bigint, lastInsertRowid: number | bigint }} */ (stmt.run(...args));
    },
    get(sql, params) {
      const { stmt, args } = bind(sql, params);
      return /** @type {Record<string, unknown> | undefined} */ (stmt.get(...args));
    },
    all(sql, params) {
      const { stmt, args } = bind(sql, params);
      return /** @type {Record<string, unknown>[]} */ (stmt.all(...args));
    },
    exec(sql) {
      db.exec(sql);
    },
  };
}

/**
 * 时间归一：`now` 可以是毫秒数、ISO 串、Date、返回它们的函数，或省略。
 *
 * 省略时取 `clock.stamp().utc` ——**不取 `Date.now()`**：生产与测试都必须能被
 * 假时钟驱动，否则超时 / 租约这类断言只能靠 sleep 碰运气。
 *
 * @param {number | string | Date | (() => number | string | Date) | undefined | null} now
 * @param {{ stamp?: () => { utc: string } }} [clock]
 * @returns {number}
 */
export function nowMsOf(now, clock) {
  if (typeof now === 'function') return toMs(now(), 'now');
  if (now !== undefined && now !== null) return toMs(now, 'now');
  if (clock && typeof clock.stamp === 'function') {
    const ms = Date.parse(clock.stamp().utc);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
export function toMs(value, field) {
  /** @type {number} */
  let ms;
  if (typeof value === 'number') ms = value;
  else if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'string') ms = Date.parse(value);
  else ms = Number.NaN;
  if (!Number.isFinite(ms)) throw new TypeError(`${field} 不是合法时刻（收到 ${String(value)}）`);
  return ms;
}

/**
 * 毫秒 → ISO UTC。入库的 `*_at` 列一律这个形态（与主账同口径）。
 * @param {number} ms
 * @returns {string}
 */
export function isoOf(ms) {
  return new Date(ms).toISOString();
}

/**
 * 解析 JSON 列。脏数据一律回落默认值——这两张表是**历史数据**，
 * 一条坏行不该让整次调度 500。
 * @template T
 * @param {unknown} raw
 * @param {T} fallback
 * @returns {T}
 */
export function safeJson(raw, fallback) {
  if (raw === null || raw === undefined || raw === '') return fallback;
  if (typeof raw === 'object') return /** @type {T} */ (raw);
  try {
    const parsed = JSON.parse(String(raw));
    return parsed === null || parsed === undefined ? fallback : /** @type {T} */ (parsed);
  } catch {
    return fallback;
  }
}

/**
 * 整数夹取。非有限数一律回落 `fallback`（不静默变成 0——0 是有意义的值）。
 * @param {unknown} value
 * @param {number} min
 * @param {number} max
 * @param {number} fallback
 * @returns {number}
 */
export function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * 发布一条工作空间事件：**永不抛错，也永不假装成功**。
 *
 * 契约 §2 的纪律是「publish 返回 null 时 builder 不得继续假装写成功」。
 * 本模块的处理是：事件只是**对外通知**，不是本模块的事实来源（事实在
 * directives / directive_runs / directive_steps 三张表里），所以 publish 失败
 * 不改变业务结论，但会把失败交给 `alert`，让它在健康页上看得见。
 *
 * @param {{ publish?: (event: Record<string, unknown>) => unknown } | null | undefined} workspace
 * @param {Record<string, unknown>} event
 * @param {(info: { kind: string, message: string, detail?: Record<string, unknown> }) => void} [alert]
 * @returns {{ id: string | null, ok: boolean }}
 */
export function safePublish(workspace, event, alert) {
  if (!workspace || typeof workspace.publish !== 'function') return { id: null, ok: false };
  try {
    const out = workspace.publish(event);
    const id = out !== null && typeof out === 'object' && 'id' in out ? String(/** @type {{ id?: unknown }} */ (out).id) : null;
    if (id === null && alert) {
      alert({
        kind: 'directive_publish_degraded',
        message: '工作空间事件发布返回空：事件没落库（业务事实仍在主表里）',
        detail: { kind: event.kind, subject: event.subjectId ?? null },
      });
    }
    return { id, ok: id !== null };
  } catch (err) {
    if (alert) {
      alert({
        kind: 'directive_publish_failed',
        message: `工作空间事件发布失败：${err instanceof Error ? err.message : String(err)}`,
        detail: { kind: event.kind },
      });
    }
    return { id: null, ok: false };
  }
}

/**
 * 把错误压成一行摘要（写进 `directive_steps.summary` 用）。
 * @param {unknown} err
 * @param {number} [maxLength]
 * @returns {string}
 */
export function errorLine(err, maxLength = 300) {
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return message.length > maxLength ? `${message.slice(0, maxLength)}…` : message;
}

/**
 * 走写队列，并**保住本模块的错误类型**。
 *
 * 为什么需要这一层：memory 包的写队列会把事务回调里抛出的任何非 `BrainError`
 * 包成 `StorageError`（`wrapWriteError`），但 `cause` 会保留原错误。本包刻意零依赖
 * （不 import 它的 BrainError），所以在这里把 `cause` 还原回来——否则
 * `PermissionEscalationError` / `InvalidTransitionError` 到了上层会变成
 * 一条 `STORAGE_ERROR`，那比不分类还糟：调用方会以为"磁盘坏了"。
 *
 * 事务语义不受影响：包装发生在 COMMIT 失败/回滚**之后**，原错误已完整保留。
 *
 * @template T
 * @param {{ write: <U>(fn: (tx: any) => U, meta?: { label?: string }) => Promise<U> }} queue
 * @param {(tx: any) => T} fn
 * @param {{ label?: string }} [meta]
 * @returns {Promise<T>}
 */
export async function writeThrough(queue, fn, meta) {
  try {
    return await queue.write(fn, meta);
  } catch (err) {
    const cause = /** @type {{ cause?: unknown }} */ (err)?.cause;
    if (cause instanceof DirectivesError) throw cause;
    throw err;
  }
}
