// @ts-check
/**
 * `relationship` —— 关系四维（熟悉/信任/亲密/好感）与变化依据（系统 4 下半 · 2）。
 *
 * ── 为什么不合并成一个「亲密度」──
 *
 * 方案 §7.2：四维分别保存。一个人可以「很熟但不信任」，也可以「不熟但很有好感」。
 * 合并成一个数字，就把「能不能托付事情」和「能不能开玩笑」这两件完全不同的事
 * 抹成了同一件。四维各自的语义：
 *
 * | 维度 | 回答的问题 |
 * |---|---|---|
 * | `familiarity` 熟悉 | 我知道你多少事、你知道我多少事 |
 * | `trust` 信任 | 能不能托付、说过的话算不算数 |
 * | `intimacy` 亲密 | 能不能说私事、能不能撒娇 |
 * | `rapport` 好感 | 相处起来舒不舒服、愿不愿意主动找 |
 *
 * ── 三条防「关系数字乱涨」的机制（这是本模块的核心）──
 *
 * 1. **单次幅度上限 `MAX_STEP_DELTA = 0.08`**：一次互动最多把一个维度推 8%。
 *    没有这条，一句「谢谢」就能把信任顶到 1.0，然后系统会以为它跟谁都熟。
 * 2. **同 kind 冷却窗口 `COOLDOWN_WINDOW_MS = 10 分钟` + 累计上限 `COOLDOWN_CAP = 0.12`**：
 *    同一类事件 10 分钟内累计最多推 12%。防的是**刷**——重复调用
 *    `applyEvent({kind:'praise'})` 不该把关系刷爆。
 * 3. **每次变化必写 `relationship_events`**：没有依据的数字就是一堆来路不明的浮点数。
 *    事件里记的是**实际生效的增量**（被夹取后的值），不是原始请求值。
 *
 * ── 幂等 ──
 *
 * `idempotencyKey` 有值时靠 `UNIQUE (scope_id, idempotency_key)` 去重：
 * 同键第二次返回 `{ applied:false, duplicate:true }`，**不更新状态、不写第二条事件**。
 */

import { BrainError } from './core.js';
import {
  RELATIONSHIP_DIMENSIONS,
  assertScope,
  clamp,
  clampInt,
  createTxApi,
  newId,
  optionalString,
  requireEpochMs,
  requireString,
  resolveScopeId,
  localOf,
  rowToRelationship,
  safeJsonArray,
  stringifyJson,
} from './util.js';

/**
 * 单次事件对任一维度的最大变化量。
 * 0.08 = 约 12 次「好的互动」才能把一维从 0.1 推到 1.0。刻意慢。
 */
export const MAX_STEP_DELTA = 0.08;

/** 同一 kind 的冷却窗口：10 分钟。 */
export const COOLDOWN_WINDOW_MS = 10 * 60_000;

/** 同一 kind 在一个窗口内可累计的最大增幅（所有维度各自计算）。 */
export const COOLDOWN_CAP = 0.12;

/** `kind` 长度上限（超长多半是把整句话当 kind 了）。 */
const MAX_KIND_LENGTH = 64;

/** `basis_json` 保留的依据条数（只是最近依据，不是账本——账本在 relationship_events）。 */
const MAX_BASIS = 20;

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string, epoch_ms?: number } },
 *   scopeId?: string,
 *   bindings?: { scope_id?: string, person_id?: string },
 * }} options
 */
export function createRelationships(options) {
  const { queue, clock } = options;
  const db = options.db;
  const scopeId = resolveScopeId(options);
  const tx = createTxApi(db);
  const timeZone = clock.timeZone ?? 'Asia/Shanghai';

  /**
   * 读关系状态。没有行返回 `null`（不凭空造 0.1：那是冷启动该干的事）。
   * @param {{ personId?: string, scopeId?: string }} [query]
   */
  function getState(query = {}) {
    assertScope(scopeId, query.scopeId, 'query.scopeId');
    const personId = requireString(query.personId ?? options.bindings?.person_id, 'personId');
    const row = tx.get('SELECT * FROM relationship_states WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
    return row === undefined ? null : rowToRelationship(row);
  }

  /**
   * 应用一次关系事件。
   *
   * @param {{
   *   personId?: string,
   *   kind: string,
   *   deltas: Record<string, number>,
   *   evidenceRef?: string | null,
   *   idempotencyKey?: string | null,
   *   notes?: string | null,
   *   at?: number | string | Date | null,
   *   scopeId?: string,
   * }} input
   * @returns {Promise<{
   *   applied: boolean,
   *   duplicate?: boolean,
   *   reason?: string,
   *   eventId?: string,
   *   personId?: string,
   *   requested?: Record<string, number>,
   *   appliedDeltas?: Record<string, number>,
   *   clamped?: Record<string, { from: number, to: number, why: string }>,
   *   before?: Record<string, number>,
   *   after?: Record<string, number>,
   * }>}
   */
  async function applyEvent(input = /** @type {any} */ ({})) {
    assertScope(scopeId, input.scopeId, 'input.scopeId');
    const personId = requireString(input.personId ?? options.bindings?.person_id, 'personId');
    const kind = requireString(input.kind, 'kind').trim();
    if (kind.length > MAX_KIND_LENGTH) {
      throw new BrainError('INVALID_ARGUMENT', `kind 太长（${kind.length} > ${MAX_KIND_LENGTH}）`);
    }
    const evidenceRef = optionalString(input.evidenceRef, 'evidenceRef');
    const idempotencyKey = optionalString(input.idempotencyKey, 'idempotencyKey');
    const notes = input.notes === undefined || input.notes === null ? null : String(input.notes).slice(0, 500);
    const atMs = requireEpochMs(input.at, 'at') ?? (clock.stamp().epoch_ms ?? Date.now());
    const requested = normalizeDeltas(input.deltas);

    return queue.write(
      (txh) => {
        const stateRow = txh.get('SELECT * FROM relationship_states WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
        if (stateRow === undefined) {
          throw new BrainError('NOT_FOUND', `关系状态不存在：${personId}（先 ensurePerson 冷启动）`);
        }
        // 幂等：同键不重复应用（UNIQUE 兜底，这里先查是为了返回稳定的 duplicate 语义）
        if (idempotencyKey) {
          const existing = txh.get('SELECT id FROM relationship_events WHERE scope_id = ? AND idempotency_key = ?', [
            scopeId,
            idempotencyKey,
          ]);
          if (existing !== undefined) {
            return { applied: false, duplicate: true, eventId: String(existing.id), personId };
          }
        }

        const before = rowToRelationship(/** @type {any} */ (stateRow));
        /**
         * 窗口内同 kind 已用掉的增幅（按维度分别算）。
         * 口径写成「同 kind + 同维度」的累计，比「所有维度合计」更严：
         * 一次事件同时推四维时，每一维都还要各自受 0.12 的限制。
         */
        /** @type {Record<string, number>} */
        const used = {};
        for (const dimension of RELATIONSHIP_DIMENSIONS) used[dimension] = 0;
        const recent = txh.all(
          `SELECT delta_familiarity, delta_trust, delta_intimacy, delta_rapport
             FROM relationship_events
            WHERE scope_id = ? AND person_id = ? AND kind = ? AND at_ms > ?`,
          [scopeId, personId, kind, atMs - COOLDOWN_WINDOW_MS],
        );
        for (const row of recent) {
          used.familiarity += Math.abs(Number(row.delta_familiarity ?? 0));
          used.trust += Math.abs(Number(row.delta_trust ?? 0));
          used.intimacy += Math.abs(Number(row.delta_intimacy ?? 0));
          used.rapport += Math.abs(Number(row.delta_rapport ?? 0));
        }

        /** @type {Record<string, number>} */
        const appliedDeltas = {};
        /** @type {Record<string, { from: number, to: number, why: string }>} */
        const clamped = {};
        let anyChange = false;
        /** 是否真的被冷却窗口卡死（用来区分「到边界了」和「刷太多被限流」） */
        let cooldownBlocked = false;
        for (const dimension of RELATIONSHIP_DIMENSIONS) {
          const want = requested[dimension] ?? 0;
          if (want === 0) {
            appliedDeltas[dimension] = 0;
            continue;
          }
          // 1) 单次幅度上限
          let effective = clamp(want, -MAX_STEP_DELTA, MAX_STEP_DELTA);
          let why = Math.abs(want) > MAX_STEP_DELTA ? `单次上限 ${MAX_STEP_DELTA}` : '';
          // 2) 10 分钟窗口内的累计上限
          const remaining = Math.max(0, COOLDOWN_CAP - used[dimension]);
          if (Math.abs(effective) > remaining) {
            effective = effective > 0 ? remaining : -remaining;
            why = why ? `${why} + 冷却窗口剩余 ${remaining.toFixed(3)}` : `冷却窗口剩 ${remaining.toFixed(3)}（同 kind 10 分钟内已推 ${used[dimension].toFixed(3)}）`;
            if (remaining === 0) cooldownBlocked = true;
          }
          if (why) clamped[dimension] = { from: want, to: effective, why };
          // 3) 结果仍夹在 [0,1]
          const current = Number(before[dimension]);
          const next = clamp(current + effective, 0, 1);
          const realDelta = next - current;
          appliedDeltas[dimension] = Number(realDelta.toFixed(6));
          if (realDelta !== 0) anyChange = true;
        }

        if (!anyChange) {
          return {
            applied: false,
            reason: cooldownBlocked ? 'cooldown_exhausted' : 'no_effect',
            personId,
            requested,
            appliedDeltas,
            clamped,
            before: pickDimensions(before),
            after: pickDimensions(before),
          };
        }

        const stamp = clock.stamp();
        const at = new Date(atMs).toISOString();
        // at_local 跟着事件发生时刻走，不跟着写库时刻走（两者可能不同：补记历史）
        const atLocal = localOf(at, timeZone);
        const eventId = newId('rel');
        txh.run(
          `INSERT INTO relationship_events (
             id, scope_id, person_id, at, at_local, at_ms, kind,
             delta_familiarity, delta_trust, delta_intimacy, delta_rapport,
             evidence_ref, notes, idempotency_key, created_at, created_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            eventId,
            scopeId,
            personId,
            at,
            atLocal,
            atMs,
            kind,
            appliedDeltas.familiarity,
            appliedDeltas.trust,
            appliedDeltas.intimacy,
            appliedDeltas.rapport,
            evidenceRef,
            notes,
            idempotencyKey,
            stamp.utc,
            stamp.local,
          ],
        );

        /** @type {Record<string, number>} */
        const after = {};
        for (const dimension of RELATIONSHIP_DIMENSIONS) {
          after[dimension] = Number(clamp(Number(before[dimension]) + appliedDeltas[dimension], 0, 1).toFixed(6));
        }
        const basis = safeJsonArray(stateRow.basis_json).map((item) => String(item));
        if (evidenceRef) basis.push(evidenceRef);
        const trimmedBasis = basis.slice(-MAX_BASIS);
        txh.run(
          `UPDATE relationship_states
              SET familiarity = ?, trust = ?, intimacy = ?, rapport = ?,
                  basis_json = ?, version = version + 1, last_change_at = ?,
                  updated_at = ?, updated_at_local = ?
            WHERE scope_id = ? AND person_id = ?`,
          [
            after.familiarity,
            after.trust,
            after.intimacy,
            after.rapport,
            stringifyJson(trimmedBasis, 'basis'),
            at,
            stamp.utc,
            stamp.local,
            scopeId,
            personId,
          ],
        );
        return {
          applied: true,
          eventId,
          personId,
          kind,
          requested,
          appliedDeltas,
          clamped,
          before: pickDimensions(before),
          after,
        };
      },
      { label: 'persona.relationship.applyEvent' },
    );
  }

  /**
   * 关系变化历史（新→旧）。
   * @param {{ personId?: string, limit?: number, since?: number | string | null }} [query]
   */
  function history(query = {}) {
    const personId = requireString(query.personId ?? options.bindings?.person_id, 'personId');
    const limit = clampInt(query.limit, 1, 1000, 50, 'limit');
    const since = requireEpochMs(query.since, 'since');
    const rows =
      since === null
        ? tx.all('SELECT * FROM relationship_events WHERE scope_id = ? AND person_id = ? ORDER BY at_ms DESC, id DESC LIMIT ?', [
            scopeId,
            personId,
            limit,
          ])
        : tx.all(
            'SELECT * FROM relationship_events WHERE scope_id = ? AND person_id = ? AND at_ms >= ? ORDER BY at_ms DESC, id DESC LIMIT ?',
            [scopeId, personId, since, limit],
          );
    return {
      items: rows.map((row) => ({
        id: String(row.id),
        personId: String(row.person_id),
        at: String(row.at),
        atMs: Number(row.at_ms),
        kind: String(row.kind),
        deltas: {
          familiarity: Number(row.delta_familiarity),
          trust: Number(row.delta_trust),
          intimacy: Number(row.delta_intimacy),
          rapport: Number(row.delta_rapport),
        },
        evidenceRef: row.evidence_ref == null ? null : String(row.evidence_ref),
        notes: row.notes == null ? null : String(row.notes),
        idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
      })),
      limit,
    };
  }

  /**
   * 统计（面板用）：事件数、最早/最新、四维均值。
   * @param {{ personId?: string }} [query]
   */
  function stats(query = {}) {
    const personId = requireString(query.personId ?? options.bindings?.person_id, 'personId');
    const row = tx.get(
      'SELECT COUNT(*) AS c, MIN(at_ms) AS lo, MAX(at_ms) AS hi FROM relationship_events WHERE scope_id = ? AND person_id = ?',
      [scopeId, personId],
    );
    const state = getState({ personId });
    return {
      personId,
      events: Number(row?.c ?? 0),
      oldestAtMs: row?.lo == null ? null : Number(row.lo),
      newestAtMs: row?.hi == null ? null : Number(row.hi),
      state: state === null ? null : pickDimensions(state),
    };
  }

  return { getState, applyEvent, history, stats, scopeId, MAX_STEP_DELTA, COOLDOWN_WINDOW_MS, COOLDOWN_CAP };
}

/**
 * 四维增量校验：只认四个维度，值必须是有限数；未知键直接拒。
 * @param {unknown} deltas
 * @returns {Record<string, number>}
 */
export function normalizeDeltas(deltas) {
  if (deltas === undefined || deltas === null) return {};
  if (typeof deltas !== 'object' || Array.isArray(deltas)) {
    throw new BrainError('INVALID_ARGUMENT', 'deltas 必须是对象（四维 → 增量）');
  }
  /** @type {Record<string, number>} */
  const out = {};
  for (const [dimension, value] of Object.entries(/** @type {Record<string, unknown>} */ (deltas))) {
    if (!RELATIONSHIP_DIMENSIONS.includes(dimension)) {
      throw new BrainError('INVALID_ARGUMENT', `deltas 含未知维度：${dimension}（只允许 ${RELATIONSHIP_DIMENSIONS.join(' | ')}）`);
    }
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) throw new BrainError('INVALID_ARGUMENT', `deltas.${dimension} 必须是有限数`);
    out[dimension] = n;
  }
  return out;
}

/**
 * @param {Record<string, any>} state
 * @returns {{ familiarity: number, trust: number, intimacy: number, rapport: number }}
 */
function pickDimensions(state) {
  return {
    familiarity: Number(state.familiarity),
    trust: Number(state.trust),
    intimacy: Number(state.intimacy),
    rapport: Number(state.rapport),
  };
}
