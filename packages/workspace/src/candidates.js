// @ts-check
/**
 * `ws_candidates` 候选板 —— 执行控制器的仲裁输入（方案 §3.1 的另一半）。
 *
 * ── 它解决什么问题 ──
 *
 * 「反思模块想写一条记忆」「社交模块想主动开口」「调度器想立一条指令」——
 * 这些想法如果各自直接执行，系统就变成一堆各干各的模块。候选板把它们变成
 * **待仲裁的提议**：带分数、带证据、带过期时间，由一个（现在是人看、将来是
 * 控制器）决定谁先动。
 *
 * ── 四条纪律 ──
 *
 * 1. **没有证据的候选不许执行**。证据可以在提议时为空（比如纯时间触发的关心），
 *    但需要证据的 kind（memory_write / proactive / directive）在执行前必须非空，
 *    否则 `claim` 直接拒绝并把候选标 `rejected`。
 *    这条比"信任上游"重要：会生成候选的模块恰好是最容易自欺的模块。
 * 2. **必须过期**。没有 expires_at 的候选是定时炸弹——某天系统重启后，
 *    一条三天前的"想问候一下"被执行了，那是最难解释的行为。
 *    `claim` 会检查并顺手置 `expired`。
 * 3. **租约防双执行**。`claim` 是一条带条件的 UPDATE，changes=0 就是没抢到。
 *    不用"先查后改"——并发下必然两个 owner 都以为自己抢到了。
 * 4. **完成必须带 owner**。别人完成不了你的候选（`WHERE lease_owner = ?`）。
 */

import { BrainError, createClock, formatLocalIso } from '@dsh-brain/core'

export const CANDIDATE_KINDS = Object.freeze([
  'memory_write', 'reflection', 'proactive', 'directive', 'maintenance', 'skill_update', 'quarantine',
])

export const CANDIDATE_STATUSES = Object.freeze([
  'proposed', 'selected', 'executing', 'done', 'rejected', 'expired', 'failed', 'deferred',
])

/** 执行前必须有证据的 kind（其余允许空，比如纯时间触发） */
export const KINDS_REQUIRING_EVIDENCE = Object.freeze(['memory_write', 'proactive', 'directive'])

/** 默认租约：2 分钟。超过这个时间没心跳就该被回收。 */
export const DEFAULT_LEASE_MS = 120_000
/** 被回收后的退避：30 秒内不许再抢，避免死循环抢占。 */
export const RECLAIM_BACKOFF_MS = 30_000
/** 单次 list 的硬上限。 */
export const MAX_LIST_LIMIT = 200

function newId() {
  const { randomBytes } = /** @type {any} */ (globalThis).process.getBuiltinModule('node:crypto')
  return `ws_cand_${randomBytes(12).toString('hex')}`
}

/**
 * @param {unknown} row
 * @returns {any}
 */
function rowToCandidate(row) {
  const parse = (text, fallback) => {
    try {
      return JSON.parse(String(text ?? ''))
    } catch {
      return fallback
    }
  }
  return {
    id: String(row.id),
    scopeId: String(row.scope_id),
    kind: String(row.kind),
    originModule: String(row.origin_module),
    title: String(row.title),
    payload: parse(row.payload_json, {}),
    score: Number(row.score ?? 0),
    scoreBreakdown: parse(row.score_breakdown_json, {}),
    priority: Number(row.priority ?? 50),
    status: String(row.status),
    evidence: parse(row.evidence_json, []),
    reason: row.reason == null ? null : String(row.reason),
    notBefore: row.not_before == null ? null : String(row.not_before),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leaseUntil: row.lease_until == null ? null : Number(row.lease_until),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
  }
}

/**
 * 候选板。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> } | null,
 *   clock?: any, alert?: (info: any) => void,
 *   bindings?: { scope_id?: string }, now?: () => number,
 * }} options
 */
export function createCandidateBoard(options) {
  const { db, queue } = options
  const clock = options.clock ?? createClock({})
  const alert = options.alert ?? (() => {})
  const now = options.now ?? (() => Date.now())
  const defaultScope = options.bindings?.scope_id ?? 'owner-default'

  /**
   * 提议一个候选。
   *
   * @param {{
   *   kind: string, originModule: string, title: string,
   *   payload?: unknown, score?: number, scoreBreakdown?: Record<string, number>,
   *   priority?: number, evidence?: string[], notBefore?: string | null,
   *   expiresAt?: string | null, idempotencyKey?: string | null, scopeId?: string,
   * }} input
   * @returns {Promise<{ id: string, deduped: boolean }>}
   */
  async function propose(input) {
    if (!queue) throw new BrainError('QUEUE_CLOSED', '写队列不可用，无法提议候选')
    const kind = String(input?.kind ?? '')
    if (!CANDIDATE_KINDS.includes(kind)) {
      throw new BrainError('INVALID_ARGUMENT', `未知候选 kind: ${kind}`)
    }
    const originModule = String(input?.originModule ?? '').trim()
    if (!originModule) throw new BrainError('INVALID_ARGUMENT', 'originModule 必填')
    const title = String(input?.title ?? '').trim()
    if (!title) throw new BrainError('INVALID_ARGUMENT', 'title 必填（一句话说明这条候选要做什么）')

    const scopeId = input?.scopeId ?? defaultScope
    const evidence = Array.isArray(input?.evidence) ? input.evidence.map(String) : []
    const score = Number.isFinite(Number(input?.score)) ? Math.max(0, Math.min(100, Number(input.score))) : 0
    const priority = Number.isFinite(Number(input?.priority))
      ? Math.max(0, Math.min(100, Math.round(Number(input.priority))))
      : 50
    const idempotencyKey = input?.idempotencyKey == null || input.idempotencyKey === ''
      ? null
      : String(input.idempotencyKey)

    const id = newId()
    const stamp = clock.stamp()
    const nowMs = now()

    return queue.write(
      (tx) => {
        if (idempotencyKey) {
          const existing = tx.get(
            'SELECT id FROM ws_candidates WHERE scope_id = ? AND idempotency_key = ?',
            [scopeId, idempotencyKey],
          )
          if (existing) return { id: String(existing.id), deduped: true }
        }
        tx.run(
          `INSERT INTO ws_candidates (
             id, scope_id, kind, origin_module, title, payload_json,
             score, score_breakdown_json, priority, status, evidence_json,
             reason, not_before, expires_at, lease_owner, lease_until, heartbeat_at,
             idempotency_key, created_at, created_at_local, updated_at, updated_at_local, decided_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL)`,
          [
            id, scopeId, kind, originModule, title,
            JSON.stringify(input?.payload ?? {}),
            score, JSON.stringify(input?.scoreBreakdown ?? {}), priority,
            JSON.stringify(evidence),
            input?.notBefore ?? null, input?.expiresAt ?? null,
            idempotencyKey, stamp.utc, stamp.local, stamp.utc, stamp.local,
          ],
        )
        return { id, deduped: false }
      },
      { label: 'workspace.propose' },
    )
  }

  /**
   * 列候选（按优先级 + 分数降序）。
   * @param {{ kind?: string, status?: string | string[], limit?: number, scopeId?: string, dueBefore?: number }} [query]
   */
  function listCandidates(query = {}) {
    const scopeId = query.scopeId ?? defaultScope
    const where = ['scope_id = ?']
    const args = [scopeId]
    if (query.kind) {
      where.push('kind = ?')
      args.push(String(query.kind))
    }
    if (query.status) {
      const statuses = Array.isArray(query.status) ? query.status : [query.status]
      const valid = statuses.map(String).filter((s) => CANDIDATE_STATUSES.includes(s))
      if (valid.length) {
        where.push(`status IN (${valid.map(() => '?').join(',')})`)
        args.push(...valid)
      }
    }
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number(query.limit ?? 50) || 50))
    args.push(limit)
    return db.prepare(
      `SELECT * FROM ws_candidates WHERE ${where.join(' AND ')}
       ORDER BY priority DESC, score DESC, created_at ASC LIMIT ?`,
    ).all(...args).map(rowToCandidate)
  }

  /**
   * 抢占一个候选执行权（带租约）。返回 `{ ok: false, reason }` 时**什么都没改**
   * （除了顺手把过期候选标 expired——那是清理，不是执行）。
   *
   * @param {{ id: string, owner: string, leaseMs?: number, scopeId?: string }} input
   */
  async function claim(input) {
    if (!queue) throw new BrainError('QUEUE_CLOSED', '写队列不可用，无法抢占候选')
    const id = String(input?.id ?? '')
    const owner = String(input?.owner ?? '').trim()
    if (!id) throw new BrainError('INVALID_ARGUMENT', 'id 必填')
    if (!owner) throw new BrainError('INVALID_ARGUMENT', 'owner 必填（谁在执行）')
    const scopeId = input?.scopeId ?? defaultScope
    const leaseMs = Math.max(1000, Number(input?.leaseMs ?? DEFAULT_LEASE_MS) || DEFAULT_LEASE_MS)
    const nowMs = now()
    const stamp = clock.stamp()

    return queue.write(
      (tx) => {
        const row = tx.get('SELECT * FROM ws_candidates WHERE id = ? AND scope_id = ?', [id, scopeId])
        if (!row) return { ok: false, reason: 'not_found' }
        const cand = rowToCandidate(row)

        if (cand.status === 'expired' || cand.status === 'done' || cand.status === 'rejected' || cand.status === 'failed') {
          return { ok: false, reason: `status_${cand.status}` }
        }
        // 过期检查：到点就直接置 expired（顺手清理），不交给调用方记
        if (cand.expiresAt) {
          const expiresMs = Date.parse(cand.expiresAt)
          if (Number.isFinite(expiresMs) && expiresMs <= nowMs) {
            tx.run(
              `UPDATE ws_candidates SET status = 'expired', updated_at = ?, updated_at_local = ?, decided_at = ?
               WHERE id = ?`,
              [stamp.utc, stamp.local, stamp.utc, id],
            )
            return { ok: false, reason: 'expired' }
          }
        }
        // not_before 未到
        if (cand.notBefore) {
          const nbMs = Date.parse(cand.notBefore)
          if (Number.isFinite(nbMs) && nbMs > nowMs) return { ok: false, reason: 'not_before' }
        }
        // 租约还在别人手上
        if (cand.leaseUntil != null && cand.leaseUntil > nowMs && cand.leaseOwner !== owner) {
          return { ok: false, reason: 'leased', leaseOwner: cand.leaseOwner, leaseUntil: cand.leaseUntil }
        }
        // 需要证据的 kind 必须有证据
        if (KINDS_REQUIRING_EVIDENCE.includes(cand.kind) && (!Array.isArray(cand.evidence) || cand.evidence.length === 0)) {
          tx.run(
            `UPDATE ws_candidates SET status = 'rejected', reason = ?, updated_at = ?, updated_at_local = ?, decided_at = ?
             WHERE id = ?`,
            ['证据为空：需要证据的候选不得执行', stamp.utc, stamp.local, stamp.utc, id],
          )
          return { ok: false, reason: 'evidence_missing' }
        }

        const changes = tx.run(
          `UPDATE ws_candidates
             SET status = 'executing', lease_owner = ?, lease_until = ?, heartbeat_at = ?,
                 updated_at = ?, updated_at_local = ?
           WHERE id = ? AND scope_id = ?
             AND status IN ('proposed', 'selected')
             AND (lease_until IS NULL OR lease_until < ?)`,
          [owner, nowMs + leaseMs, nowMs, stamp.utc, stamp.local, id, scopeId, nowMs],
        ).changes
        if (!changes) return { ok: false, reason: 'not_claimable' }
        return { ok: true, candidate: { ...cand, status: 'executing', leaseOwner: owner, leaseUntil: nowMs + leaseMs } }
      },
      { label: 'workspace.claim' },
    )
  }

  /** 续租（长任务要周期性调，否则会被别人当僵尸回收）。 */
  async function heartbeat(input) {
    if (!queue) throw new BrainError('QUEUE_CLOSED', '写队列不可用')
    const id = String(input?.id ?? '')
    const owner = String(input?.owner ?? '').trim()
    const leaseMs = Math.max(1000, Number(input?.leaseMs ?? DEFAULT_LEASE_MS) || DEFAULT_LEASE_MS)
    const nowMs = now()
    const stamp = clock.stamp()
    return queue.write(
      (tx) => {
        const changes = tx.run(
          `UPDATE ws_candidates SET lease_until = ?, heartbeat_at = ?, updated_at = ?, updated_at_local = ?
           WHERE id = ? AND lease_owner = ? AND status = 'executing'`,
          [nowMs + leaseMs, nowMs, stamp.utc, stamp.local, id, owner],
        ).changes
        return { ok: changes > 0 }
      },
      { label: 'workspace.heartbeat' },
    )
  }

  /**
   * 结案。`status` 只接受 done / failed / rejected / deferred。
   * 必须带对的 owner——防止 A 把 B 正在做的事结掉。
   */
  async function complete(input) {
    if (!queue) throw new BrainError('QUEUE_CLOSED', '写队列不可用')
    const id = String(input?.id ?? '')
    const owner = String(input?.owner ?? '').trim()
    const status = String(input?.status ?? '')
    if (!['done', 'failed', 'rejected', 'deferred'].includes(status)) {
      throw new BrainError('INVALID_ARGUMENT', `非法的结案状态: ${status}`)
    }
    const reason = input?.reason == null ? null : String(input.reason).slice(0, 500)
    const stamp = clock.stamp()
    return queue.write(
      (tx) => {
        const changes = tx.run(
          `UPDATE ws_candidates
             SET status = ?, reason = ?, lease_owner = NULL, lease_until = NULL,
                 updated_at = ?, updated_at_local = ?, decided_at = ?
           WHERE id = ? AND lease_owner = ? AND status = 'executing'`,
          [status, reason, stamp.utc, stamp.local, stamp.utc, id, owner],
        ).changes
        return { ok: changes > 0 }
      },
      { label: 'workspace.complete' },
    )
  }

  /**
   * 回收僵尸候选（租约过期还在 executing）。返回回收条数。
   *
   * 为什么回收后加 backoff 而不是立刻可抢：一个真正会崩的候选
   * （比如每次执行都 OOM）会在回收→重抢之间无限循环，backoff 把循环打成慢速。
   */
  async function reclaimExpired(input = {}) {
    if (!queue) return { reclaimed: 0 }
    const nowMs = now()
    const stamp = clock.stamp()
    const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Number(input?.limit ?? 50) || 50))
    return queue.write(
      (tx) => {
        const rows = tx.all(
          `SELECT id FROM ws_candidates
           WHERE status = 'executing' AND lease_until IS NOT NULL AND lease_until < ?
           ORDER BY lease_until ASC LIMIT ?`,
          [nowMs, limit],
        )
        let reclaimed = 0
        for (const row of rows) {
          const changes = tx.run(
            `UPDATE ws_candidates
               SET status = 'proposed', lease_owner = NULL, lease_until = NULL, heartbeat_at = NULL,
                   reason = 'lease_expired', not_before = ?,
                   updated_at = ?, updated_at_local = ?
             WHERE id = ? AND status = 'executing' AND lease_until < ?`,
            [
              new Date(nowMs + RECLAIM_BACKOFF_MS).toISOString(),
              stamp.utc, stamp.local, String(row.id), nowMs,
            ],
          ).changes
          reclaimed += changes
        }
        return { reclaimed }
      },
      { label: 'workspace.reclaim' },
    )
  }

  /** 面板统计。 */
  function stats(scopeId = defaultScope) {
    const rows = db.prepare(
      'SELECT status, count(*) AS c FROM ws_candidates WHERE scope_id = ? GROUP BY status',
    ).all(scopeId)
    const byStatus = {}
    for (const r of rows) byStatus[String(r.status)] = Number(r.c)
    return { byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) }
  }

  return { propose, listCandidates, claim, heartbeat, complete, reclaimExpired, stats }
}
