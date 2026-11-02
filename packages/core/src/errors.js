// @ts-check
/**
 * 错误类型：全项目统一的稳定错误码。
 *
 * 纪律：
 * - 错误只描述「哪一步失败」，**不带记忆正文、不带凭据**。
 * - `details` 允许带 ID / 哈希 / SQLite 元数据，禁止带 payload 内容。
 * - 任何错误都不代表「已记住」；只有 ingest 返回 `persisted: true` 才算。
 */

/**
 * @typedef {'ENVELOPE_INVALID'
 *   | 'EVENT_CONFLICT'
 *   | 'STORAGE_ERROR' | 'STORAGE_FULL' | 'STORAGE_BUSY' | 'STORAGE_CORRUPT'
 *   | 'STORAGE_PERMISSION' | 'STORAGE_READONLY' | 'STORAGE_IO'
 *   | 'QUEUE_CLOSED' | 'WRITE_ASYNC_FORBIDDEN'
 *   | 'DELETION_BARRIER'
 *   | 'MIGRATION_ERROR' | 'MIGRATION_CHECKSUM_MISMATCH' | 'MIGRATION_NO_DOWN'
 *   | 'BACKUP_ERROR' | 'BACKUP_VERIFY_FAILED' | 'RESTORE_REFUSED'
 *   | 'CONSUMER_GAP' | 'NOT_FOUND' | 'INVALID_ARGUMENT'
 * } BrainErrorCode
 */

/**
 * @typedef {Object} BrainErrorOptions
 * @property {Record<string, unknown>} [details] 结构化细节；不得包含记忆正文或凭据
 * @property {unknown} [cause] 原始底层错误（可能是 SQLite 错误）
 */

/**
 * 跨模块实例的错误识别标记。
 *
 * ── 为什么需要它（2026-10-31 实测踩到的真问题）──
 *
 * 本仓库的 `@dsh-brain/*` 依赖是**目录 junction**（`packages/x/node_modules/@dsh-brain/core`
 * → `packages/core`）。Node 的 ESM 解析不会把它们 realpath 成同一份，于是
 * **每个包都加载了一份独立的 core 模块**，`BrainError` 因此有多个类对象：
 *
 *   packages/memory 里 `err instanceof BrainError` === false，
 *   即使这个 err 明明是 packages/cognition 抛出的 BrainError。
 *
 * 后果很具体：`write-queue.wrapWriteError` 用 `instanceof` 判断，跨包抛的业务错误
 * （NOT_FOUND / INVALID_ARGUMENT）会被包成 STORAGE_ERROR，错误码直接丢失——
 * 上层再怎么断言也断言不到原来那个码，而且看起来像数据库坏了。
 *
 * `Symbol.for()` 走**全局注册表**：不同模块实例取到的是同一个 symbol，
 * 所以 brand 检查跨实例有效。这是不改动依赖布局就能根治的最小方案。
 */
export const BRAIN_ERROR_BRAND = Symbol.for('@dsh-brain/error');

/** 基础错误：所有项目错误的父类。 */
export class BrainError extends Error {
  /**
   * @param {BrainErrorCode} code
   * @param {string} message
   * @param {BrainErrorOptions} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BrainError';
    this.code = code;
    /** @type {Record<string, unknown>} */
    this.details = options.details ?? {};
    // 非枚举属性：不出现在 JSON/stdout 里，但 instanceof 失效时能认亲。
    Object.defineProperty(this, BRAIN_ERROR_BRAND, {
      value: true,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }

  /** 供日志使用的脱敏摘要（不含 stack、不含正文）。 */
  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/** 事件信封/参数校验失败。`errors` 是逐字段的问题清单。 */
export class ValidationError extends BrainError {
  /**
   * @param {string} message
   * @param {Array<{field: string, code: string, message: string}>} errors
   * @param {BrainErrorOptions} [options]
   */
  constructor(message, errors, options = {}) {
    super('ENVELOPE_INVALID', message, {
      ...options,
      details: { ...(options.details ?? {}), errors },
    });
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

/**
 * 幂等冲突：唯一键 `(source_system, scope_id, source_event_id)` 已存在，但正文不同。
 * 禁止静默覆盖；调用方必须报错并保留原记录。
 */
export class ConflictError extends BrainError {
  /**
   * @param {string} message
   * @param {{
   *   source_system: string,
   *   scope_id: string,
   *   source_event_id: string,
   *   event_id: string,
   *   stored_payload_hash: string,
   *   incoming_payload_hash: string,
   * }} info
   * @param {BrainErrorOptions} [options]
   */
  constructor(message, info, options = {}) {
    super('EVENT_CONFLICT', message, { ...options, details: { ...info } });
    this.name = 'ConflictError';
    this.info = info;
  }
}

/**
 * 存储层失败（写失败、磁盘满、busy、损坏、只读、权限）。
 *
 * `retriable` 只表示「是否值得自动重试」：
 * - busy/locked → true
 * - disk full / corrupt / read-only / permission → false（需要人工处理）
 */
export class StorageError extends BrainError {
  /**
   * @param {BrainErrorCode} code
   * @param {string} message
   * @param {BrainErrorOptions & {retriable?: boolean}} [options]
   */
  constructor(code, message, options = {}) {
    const { retriable, ...rest } = options;
    super(code, message, rest);
    this.name = 'StorageError';
    this.retriable = retriable === true;
  }

  /**
   * 把 node:sqlite 抛出的错误映射成稳定错误码。
   * 输入只读取 `code/errcode/errstr/message`，不读取 SQL 或参数。
   * @param {unknown} err
   * @returns {{ code: BrainErrorCode, retriable: boolean, sqlite: { code?: string, errcode?: number, errstr?: string } | null }}
   */
  static classify(err) {
    if (err instanceof StorageError) {
      return { code: err.code, retriable: err.retriable, sqlite: null };
    }
    if (!isSqliteError(err)) {
      return { code: 'STORAGE_ERROR', retriable: false, sqlite: null };
    }
    const errcode = Number(err.errcode);
    const sqlite = {
      ...(typeof err.code === 'string' ? { code: err.code } : {}),
      ...(Number.isFinite(errcode) ? { errcode } : {}),
      ...(typeof err.errstr === 'string' ? { errstr: err.errstr } : {}),
    };
    switch (errcode) {
      case 13:
        return { code: 'STORAGE_FULL', retriable: false, sqlite };
      case 5:
      case 6:
        return { code: 'STORAGE_BUSY', retriable: true, sqlite };
      case 11:
      case 26:
        return { code: 'STORAGE_CORRUPT', retriable: false, sqlite };
      case 8:
        return { code: 'STORAGE_READONLY', retriable: false, sqlite };
      case 3:
        return { code: 'STORAGE_PERMISSION', retriable: false, sqlite };
      case 10:
        return { code: 'STORAGE_IO', retriable: false, sqlite };
      default:
        return { code: 'STORAGE_ERROR', retriable: false, sqlite };
    }
  }

  /** @param {unknown} err @param {string} operation */
  static from(err, operation) {
    if (err instanceof BrainError) return err;
    const { code, retriable, sqlite } = StorageError.classify(err);
    const errstr = sqlite?.errstr ?? (err instanceof Error ? err.message : String(err));
    return new StorageError(code, `${operation} 失败：${errstr}`, {
      retriable,
      details: { operation, sqlite },
      cause: err,
    });
  }
}

/** 写入队列已关闭（进程退出/恢复流程中），拒绝新写入。 */
export class QueueClosedError extends BrainError {
  /** @param {string} message @param {BrainErrorOptions} [options] */
  constructor(message, options = {}) {
    super('QUEUE_CLOSED', message, options);
    this.name = 'QueueClosedError';
  }
}

/**
 * 删除屏障：派生任务带着旧 `deletion_epoch` 回来写回内容时拒绝。
 * 语义见 CONTRACTS 第 8 节：删除前启动、删除后完成的 worker 不得复活内容。
 */
export class DeletionBarrierError extends BrainError {
  /**
   * @param {string} message
   * @param {{ worker_epoch: number, current_epoch: number, target_kind?: string, target_id?: string }} info
   * @param {BrainErrorOptions} [options]
   */
  constructor(message, info, options = {}) {
    super('DELETION_BARRIER', message, { ...options, details: { ...info } });
    this.name = 'DeletionBarrierError';
    this.info = info;
  }
}

/** 迁移失败：SQL 执行失败、校验值不符、缺少 down 文件。 */
export class MigrationError extends BrainError {
  /**
   * @param {BrainErrorCode} code
   * @param {string} message
   * @param {BrainErrorOptions & {version?: string}} [options]
   */
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = 'MigrationError';
  }
}

/** 备份/恢复失败。 */
export class BackupError extends BrainError {
  /**
   * @param {BrainErrorCode} code
   * @param {string} message
   * @param {BrainErrorOptions} [options]
   */
  constructor(code, message, options = {}) {
    super(code, message, options);
    this.name = 'BackupError';
  }
}

/**
 * `node:sqlite` 错误的判定。node 24 上错误对象形如
 * `{ code: 'ERR_SQLITE_ERROR', errcode: 13, errstr: 'database or disk is full', message }`。
 * @param {unknown} err
 * @returns {err is Error & { code?: string, errcode?: number, errstr?: string }}
 */
export function isSqliteError(err) {
  return (
    err instanceof Error &&
    /** @type {{ code?: unknown }} */ (err).code === 'ERR_SQLITE_ERROR'
  );
}

/**
 * 是不是本项目的错误（跨模块实例也认）。
 *
 * 判断顺序有讲究：
 * 1. `instanceof` 最快，同实例时命中（绝大多数情况）；
 * 2. brand symbol 兜底 —— 目录 junction 造成的「多份 core 实例」场景；
 * 3. **不按 `name` 或 `code` 猜**：普通 Error 加个 code 属性很常见，
 *    按形状猜会把第三方错误误判成自家错误，比漏判更危险。
 * @param {unknown} err
 * @returns {err is BrainError}
 */
export function isBrainError(err) {
  if (!(err instanceof Error) && (err === null || typeof err !== 'object')) return false;
  if (err instanceof BrainError) return true;
  return /** @type {any} */ (err)?.[BRAIN_ERROR_BRAND] === true;
}

/**
 * 把任意错误包装成 BrainError，保留原始 cause。
 * @param {unknown} err
 * @param {BrainErrorCode} [fallbackCode]
 * @param {string} [operation]
 */
export function asBrainError(err, fallbackCode = 'STORAGE_ERROR', operation = 'operation') {
  if (err instanceof BrainError) return err;
  if (isSqliteError(err)) return StorageError.from(err, operation);
  const message = err instanceof Error ? err.message : String(err);
  return new BrainError(fallbackCode, `${operation} 失败：${message}`, { cause: err });
}
