// @ts-check
/**
 * 纠错链（M3-INTERFACES §3）：`supersede` 保留链，`asOf` 能回看旧值；**删除不可绕过**。
 *
 * ## 为什么单独一层
 * `memories.supersede(oldId, newId)` 已经能改状态、连 `supersedes` 链、写版本快照，但：
 * - 它不接受 `{ reason, effectiveAt }`（M3 契约 §3 的签名要求）；
 * - 「当前查询不再用旧值」这件事在门面层没有统一出口（`get()` 对 `superseded` 行仍可读，
 *   只有检索层按 `status='active'` 过滤）。
 *
 * 所以这一层补齐语义，**不改 M2 门面**（改了会让 418 里的 103 条 M2 测试行为漂移）：
 * - `supersede(oldId, newId, { reason, effectiveAt })`：纠错，保留链，可指定生效时间；
 * - `currentView(id)`：当前视图——superseded 且已过生效时间 → 不可用；
 * - `asOfView(id, asOf)`：时点回看——能读到旧值（这正是纠错与遗忘的分界）；
 * - `chainOf(id)`：链（只给元数据，不给正文；已删节点标 deleted 且 content 为空）。
 *
 * ## 纠错 vs 遗忘（一张表，代码里逐条兑现）
 * | 维度 | 纠错 supersede | 遗忘 delete |
 * |---|---|---|
 * | 当前查询 | 不再使用旧值 | 不可读 |
 * | 历史查询 asOf | **可显式回看旧值** | **任何查询均不可读，历史模式不能绕过** |
 * | 链 | 保留 `supersedes` 链 | tombstone 元数据保留在独立账本 |
 *
 * 表格第三行由两件东西保证，不是靠口头：
 * - `memories.get/search` 的 SQL 里固定有 `deletion_epoch = 0 AND status <> 'deleted'`；
 * - `isTombstoned()` 再按 `deletion_tombstones` 做一次字节级确认。
 * 所以这里**不做任何 `asOf` 绕过**：`asOfView` 读不到时明确区分「没删，只是当时无效」
 * 与「已删，任何时点都读不到」。
 */

import { BrainError } from '@dsh-brain/core';
import { insertAudit } from './ledger.js';
import { createTxApi } from './write-queue.js';
import { newId as newAuditId, normalizeInstant } from './memory-util.js';

/** @typedef {import('./write-queue.js').TxApi} TxApi */
/** @typedef {ReturnType<typeof import('./memories.js').createMemories>} MemoriesFacade */

/** 链的最大追跳数：防御脏数据造成的环 / 无限链。 */
export const MAX_CHAIN_DEPTH = 32;

/**
 * 从一行 `memories` 里取**可外露的**元数据（永远不含正文）。
 * 已删除的行只回 `status='deleted'` 与时间，正文与摘要一律 null。
 * @param {Record<string, unknown>} row
 */
function toChainNode(row) {
  const deleted = String(row.status) === 'deleted' || Number(row.deletion_epoch ?? 0) > 0;
  return {
    id: String(row.id),
    version: Number(row.version ?? 1),
    status: deleted ? 'deleted' : String(row.status),
    validFrom: row.valid_from ?? null,
    validUntil: row.valid_until ?? null,
    supersedes: row.supersedes ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    // 已删除：正文与摘要都不给（不是空字符串，是 null——「没有」和「空」要分得开）
    content: deleted ? null : row.content ?? null,
    summary: deleted ? null : row.summary ?? null,
  };
}

/**
 * 造纠错链服务。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: TxApi) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string }, timeZone?: string },
 *   memories: MemoriesFacade,
 *   bindings?: { scope_id?: string },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 * }} options
 */
export function createCorrections(options) {
  const { db, queue, clock, memories } = options;
  const defaultScopeId = options.bindings?.scope_id ?? null;
  /** 读路径句柄（只读，不开事务）。 */
  const tx = createTxApi(db);

  /**
   * 解析调用方 scope（写读同口径）：默认按绑定，`allowCrossScope` 才放行。
   *
   * 没绑定又没显式声明 → 直接拒（默认安全：宁可读不到，也不跨 scope 猜）。
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {string|null}
   */
  function resolveScope(opts = {}) {
    if (opts.allowCrossScope === true) return null;
    const scopeId = opts.scopeId ?? defaultScopeId;
    if (typeof scopeId !== 'string' || scopeId.length === 0) {
      throw new BrainError('INVALID_ARGUMENT', 'corrections 操作需要 scopeId（绑定缺失且未显式声明）');
    }
    return scopeId;
  }

  /**
   * 取一行（只读）。删除态的行也返回，供 chain/判定用；正文不外露由 `toChainNode` 负责。
   *
   * **scope 收口**：跨 scope 的 id 与「不存在」同形（返回 undefined），不确认存在性。
   *
   * @param {string} id
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {Record<string, unknown> | undefined}
   */
  function rawRow(id, opts = {}) {
    const scopeId = resolveScope(opts);
    return /** @type {Record<string, unknown> | undefined} */ (
      tx.get('SELECT * FROM memories WHERE id = ? AND (? IS NULL OR scope_id = ?)', [id, scopeId, scopeId])
    );
  }

  /**
   * 该 id 是否有删除墓碑（与检索层同一个判据）。
   * @param {string} id
   * @returns {boolean}
   */
  function hasTombstone(id) {
    const row = tx.get(
      "SELECT 1 AS hit FROM deletion_tombstones WHERE target_kind = 'memory' AND target_id = ? AND status <> 'failed'",
      [id],
    );
    return row !== undefined;
  }

  /**
   * 写一条 `memory_versions` 留痕（与门面同列，纠错链审计要能重建当时的参数）。
   * @param {TxApi} txh
   * @param {Record<string, unknown>} row
   * @param {{ utc: string, local: string }} stamp
   * @param {string} changedBy
   * @param {string|null} reason
   */
  function recordVersion(txh, row, stamp, changedBy, reason) {
    txh.run(
      `INSERT INTO memory_versions (
         memory_id, version, content, summary, status, source_type, source_ids,
         confidence, importance, privacy, supersedes, changed_by, change_reason,
         content_hash, created_at, created_at_local
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(row.id),
        Number(row.version),
        row.content ?? null,
        row.summary ?? null,
        String(row.status),
        row.source_type === null || row.source_type === undefined ? null : String(row.source_type),
        String(row.source_ids ?? '[]'),
        row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
        row.importance === null || row.importance === undefined ? null : Number(row.importance),
        String(row.privacy),
        row.supersedes ?? null,
        changedBy,
        reason,
        row.content_hash ?? null,
        stamp.utc,
        stamp.local,
      ],
    );
  }

  /**
   * 纠错：用 `newId` 取代 `oldId`。保留链，可指定生效时间。
   *
   * 与遗忘的分界：这里**不写 tombstone、不动 deletion_epoch**，所以历史回看仍然可读。
   *
   * **写路径 scope 收口**：两条都必须在调用方 scope 内，任一越界一律 `NOT_FOUND`
   * （不确认存在性）。`allowCrossScope` 只给内部维护用。
   *
   * @param {string} oldId
   * @param {string} newId
   * @param {{ reason?: string, effectiveAt?: string|null, actor?: string, scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {Promise<{
   *   oldVersion: number,
   *   newVersion: number,
   *   effectiveAt: string,
   *   effectiveInFuture: boolean,
   *   reason: string,
   *   chainLength: number,
   * }>}
   */
  async function supersede(oldId, newId, opts = {}) {
    if (typeof oldId !== 'string' || oldId.length === 0) {
      throw new BrainError('INVALID_ARGUMENT', 'corrections.supersede 需要 oldId');
    }
    if (typeof newId !== 'string' || newId.length === 0) {
      throw new BrainError('INVALID_ARGUMENT', 'corrections.supersede 需要 newId');
    }
    if (oldId === newId) {
      throw new BrainError('INVALID_ARGUMENT', 'corrections.supersede 的 oldId 与 newId 不能相同');
    }
    const reason = typeof opts.reason === 'string' && opts.reason.trim().length > 0 ? opts.reason.trim().slice(0, 500) : '';
    const actor = typeof opts.actor === 'string' && opts.actor.length > 0 ? opts.actor : 'owner';
    // 写路径收口：目标必须在调用方 scope 内；越界一律 NOT_FOUND（不确认存在性）。
    const scopeId = resolveScope(opts);

    return queue.write(
      (txh) => {
        const oldRow = /** @type {Record<string, unknown> | undefined} */ (
          txh.get('SELECT * FROM memories WHERE id = ? AND (? IS NULL OR scope_id = ?)', [oldId, scopeId, scopeId])
        );
        const newRow = /** @type {Record<string, unknown> | undefined} */ (
          txh.get('SELECT * FROM memories WHERE id = ? AND (? IS NULL OR scope_id = ?)', [newId, scopeId, scopeId])
        );
        if (oldRow === undefined) throw new BrainError('NOT_FOUND', `记忆不存在：${oldId}`);
        if (newRow === undefined) throw new BrainError('NOT_FOUND', `记忆不存在：${newId}`);
        if (String(oldRow.scope_id) !== String(newRow.scope_id)) {
          throw new BrainError('INVALID_ARGUMENT', 'supersede 的两条记忆必须在同一 scope');
        }
        // 删除压过纠错：已删的记忆不能被"纠错"改成 superseded（那等于绕过删除屏障）。
        if (String(oldRow.status) === 'deleted' || Number(oldRow.deletion_epoch ?? 0) > 0) {
          throw new BrainError('DELETION_BARRIER', '已删除的记忆不能作为被取代目标（删除优先于纠错）');
        }
        if (Number(newRow.deletion_epoch ?? 0) > 0) {
          throw new BrainError('DELETION_BARRIER', '用于纠错的新记忆处于删除态，拒绝用它取代任何东西');
        }

        const stamp = clock.stamp();
        const effectiveAt = normalizeInstant(opts.effectiveAt, 'effectiveAt') ?? stamp.utc;
        const effectiveInFuture = Date.parse(effectiveAt) > Date.parse(stamp.utc);
        const oldVersion = Number(oldRow.version ?? 1) + 1;
        const newVersion = Number(newRow.version ?? 1) + 1;

        // 旧值：状态转 superseded，有效期右边界取 effectiveAt（已有 valid_until 时保留原值——
        // 那可能是更早的一次纠错留下的边界，不该被后一次覆盖）。
        txh.run(
          `UPDATE memories
              SET status = 'superseded',
                  valid_until = COALESCE(valid_until, ?),
                  valid_until_local = COALESCE(valid_until_local, ?),
                  updated_at = ?, updated_at_local = ?, version = version + 1
            WHERE id = ?`,
          [effectiveAt, stamp.local, stamp.utc, stamp.local, oldId],
        );
        // 新值：挂上 supersedes 指针（链在这里成形）。
        txh.run(
          'UPDATE memories SET supersedes = ?, updated_at = ?, updated_at_local = ?, version = version + 1 WHERE id = ?',
          [oldId, stamp.utc, stamp.local, newId],
        );

        const oldAfter = /** @type {Record<string, unknown>} */ (txh.get('SELECT * FROM memories WHERE id = ?', [oldId]));
        const newAfter = /** @type {Record<string, unknown>} */ (txh.get('SELECT * FROM memories WHERE id = ?', [newId]));
        recordVersion(txh, oldAfter, stamp, 'corrections.supersede', reason === '' ? `superseded_by:${newId}` : `${reason} (superseded_by:${newId})`);
        recordVersion(txh, newAfter, stamp, 'corrections.supersede', reason === '' ? `supersedes:${oldId}` : `${reason} (supersedes:${oldId})`);

        // 链长（含自己）：给上层一个"这条纠错了几次"的直观数
        let chainLength = 1;
        let cursor = oldId;
        const seen = new Set([newId]);
        while (cursor !== null && cursor !== undefined && !seen.has(String(cursor)) && chainLength < MAX_CHAIN_DEPTH) {
          seen.add(String(cursor));
          chainLength += 1;
          const row = /** @type {Record<string, unknown> | undefined} */ (
            txh.get('SELECT supersedes FROM memories WHERE id = ?', [String(cursor)])
          );
          cursor = row?.supersedes ?? null;
        }

        insertAudit(
          txh,
          newAuditId('aud'),
          {
            action: 'memory.superseded',
            actor,
            target_kind: 'memory',
            target_id: newId,
            scope_id: String(newRow.scope_id ?? defaultScopeId ?? ''),
            result: 'ok',
            detail: { old_id: oldId, new_id: newId, effective_at: effectiveAt, effective_in_future: effectiveInFuture, chain_length: chainLength },
            deletion_epoch: Number(txh.get("SELECT CAST(value AS INTEGER) AS n FROM brain_meta WHERE key = 'deletion_epoch'")?.n ?? 0),
          },
          clock,
        );

        return { oldVersion, newVersion, effectiveAt, effectiveInFuture, reason, chainLength };
      },
      { label: 'corrections.supersede' },
    );
  }


  /**
   * 当前视图：这套语义上「现在该不该用这条记忆」。
   *
   * - `active` / 其它活状态 → 可读；
   * - `superseded` 且已过生效时间 → 不可用（reason='superseded'），但正文明文**不给**；
   * - `expired` → 不可用（reason='expired'）；
   * - 删除态（tombstone 或 status='deleted' 或 deletion_epoch>0）→ 不可读（reason='deleted'）。
   *
   * @param {string} memoryId
   * @param {{ asOf?: string|null, scopeId?: string, allowCrossScope?: boolean }} [opts] 传 asOf 等价于 `asOfView`
   * @returns {{
   *   id: string,
   *   readable: boolean,
   *   reason: 'ok' | 'superseded' | 'expired' | 'deleted' | 'not_found' | 'not_valid_at_time',
   *   status: string|null,
   *   value: ReturnType<MemoriesFacade['get']> | null,
   *   chain: ReturnType<typeof toChainNode>[],
   * }}
   */
  function currentView(memoryId, opts = {}) {
    if (typeof memoryId !== 'string' || memoryId.length === 0) {
      throw new BrainError('INVALID_ARGUMENT', 'corrections.currentView 需要 memoryId');
    }
    // 跨 scope 与「真不存在」同形：not_found（不确认存在性）
    const row = rawRow(memoryId, opts);
    if (row === undefined) {
      return { id: memoryId, readable: false, reason: 'not_found', status: null, value: null, chain: [] };
    }
    // 删除优先于一切：**即使传了 asOf 也不回看**（历史模式不能绕过删除）。
    if (Number(row.deletion_epoch ?? 0) > 0 || String(row.status) === 'deleted' || hasTombstone(memoryId)) {
      return {
        id: memoryId,
        readable: false,
        reason: 'deleted',
        status: 'deleted',
        value: null,
        chain: chainOf(memoryId, opts),
      };
    }
    // 内部调门面读取时把 scope 带下去：不靠 memories.get 的缺省去猜上下文。
    const scopeOpts =
      opts.allowCrossScope === true ? { allowCrossScope: true } : { scopeId: resolveScope(opts) };
    const value = memories.get(memoryId, opts.asOf === undefined ? scopeOpts : { ...scopeOpts, asOf: opts.asOf });
    const status = String(row.status);
    if (opts.asOf !== undefined && opts.asOf !== null) {
      return {
        id: memoryId,
        readable: value !== null,
        reason: value !== null ? 'ok' : 'not_valid_at_time',
        status,
        value,
        chain: chainOf(memoryId, opts),
      };
    }
    if (status === 'superseded') {
      // 生效时间之前仍然算"当前可用"（补录纠错 / 预定生效时，这是正确语义）
      const until = row.valid_until === null || row.valid_until === undefined ? null : String(row.valid_until);
      const now = clock.stamp().utc;
      const effective = until !== null && Date.parse(until) > Date.parse(now);
      if (!effective) {
        return { id: memoryId, readable: false, reason: 'superseded', status, value: null, chain: chainOf(memoryId, opts) };
      }
    }
    if (status === 'expired' && value === null) {
      return { id: memoryId, readable: false, reason: 'expired', status, value: null, chain: chainOf(memoryId, opts) };
    }
    return { id: memoryId, readable: value !== null, reason: value !== null ? 'ok' : 'not_valid_at_time', status, value, chain: chainOf(memoryId, opts) };
  }

  /**
   * 时点回看（纠错的专用通道）。
   *
   * 语义与 `currentView(id, { asOf })` 相同，但**先判删除**：已删的 id 永远返回
   * `readable=false, reason='deleted'`——这条测试就是 M3 门槛里「历史模式不能绕过删除」。
   * scope 收口与 `currentView` 同口径（跨 scope → not_found）。
   *
   * @param {string} memoryId
   * @param {string} asOf ISO 时点
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   */
  function asOfView(memoryId, asOf, opts = {}) {
    if (asOf === undefined || asOf === null) {
      throw new BrainError('INVALID_ARGUMENT', 'corrections.asOfView 需要 asOf 时点');
    }
    return currentView(memoryId, { ...opts, asOf });
  }

  /**
   * 纠错链（旧 → 新）。只回元数据；已删节点不回正文。
   *
   * **scope 收口**：跨 scope 的 id 返回空链（与「不存在」同形），链上每一跳都按 caller
   * scope 过滤，避免从链里漏出别 scope 的摘要。
   *
   * @param {string} memoryId
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {Array<ReturnType<typeof toChainNode>>}
   */
  function chainOf(memoryId, opts = {}) {
    const scopeId = resolveScope(opts);
    const self = rawRow(memoryId, opts);
    if (self === undefined) return [];
    /** @type {Array<Record<string, unknown>>} */
    const older = [];
    const seen = new Set([memoryId]);
    let cursor = self.supersedes === null || self.supersedes === undefined ? null : String(self.supersedes);
    while (cursor !== null && !seen.has(cursor) && older.length < MAX_CHAIN_DEPTH) {
      seen.add(cursor);
      const row = rawRow(cursor, opts);
      if (row === undefined) break;
      older.push(row);
      cursor = row.supersedes === null || row.supersedes === undefined ? null : String(row.supersedes);
    }
    /** @type {Array<Record<string, unknown>>} */
    const newer = [];
    let currentId = memoryId;
    while (newer.length < MAX_CHAIN_DEPTH) {
      const row = /** @type {Record<string, unknown> | undefined} */ (
        tx.get('SELECT * FROM memories WHERE supersedes = ? AND (? IS NULL OR scope_id = ?)', [
          currentId,
          scopeId,
          scopeId,
        ])
      );
      if (row === undefined) break;
      newer.push(row);
      currentId = String(row.id);
    }
    return [...older.reverse(), self, ...newer].map((row) => toChainNode(row));
  }

  return { supersede, currentView, asOfView, chainOf, hasTombstone };
}
