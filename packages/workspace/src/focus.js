// @ts-check
/**
 * `attention_focus` 注意力焦点 —— 方案 §10「注意力占用」的落地。
 *
 * ── 一句话 ──
 *
 * 维护「此刻在做什么」，并**阻止低优先级的内部意图抢占重要任务**。
 *
 * ── 为什么要有抢占门槛 ──
 *
 * 没有门槛时，任何一个空闲触发的模块（反思、维护、清理）都能把焦点抢走。
 * 结果就是：主人交代的事做到一半，系统跑去「整理记忆」——它自己觉得很勤快，
 * 主人看到的是「这玩意儿怎么又不干活了」。
 *
 * 门槛的具体算法：新焦点必须满足 `新priority > 当前priority + preempt_margin`
 * 才允许抢占。margin 默认 10，意味着「同级不抢、差一级才抢」。
 *
 * ── 抢占必须留痕 ──
 *
 * 被抢了要写 `audit_logs`（action='attention.preempt'）并发一条 `attention` 通道的
 * 事件。否则「为什么这个任务做到一半没人管了」永远查不出来。
 */

import { BrainError, createClock } from '@dsh-brain/core'

export const FOCUS_KINDS = Object.freeze(['session', 'task', 'directive', 'person', 'maintenance', 'idle'])

/** 优先级预设（数字大 = 更该被保护）。与方案 §8.4 的优先级语义对齐。 */
export const FOCUS_PRIORITY = Object.freeze({
  owner_interrupt: 100,   // 主人实时打断与全局停止
  owner_task: 90,         // 主人当前明确任务
  commitment: 70,         // 已到期承诺
  maintenance: 50,        // 必要系统维护
  reflection: 30,         // 记忆整理与反思
  curiosity: 10,          // 好奇探索与非必要陪伴
})

/** 默认占用时长：5 分钟。到点自动失效，避免死焦点挡住一切。 */
export const DEFAULT_FOCUS_TTL_MS = 5 * 60_000
/** 默认抢占门槛。 */
export const DEFAULT_PREEMPT_MARGIN = 10

function newAuditId() {
  const { randomBytes } = /** @type {any} */ (globalThis).process.getBuiltinModule('node:crypto')
  return `audit_${randomBytes(12).toString('hex')}`
}

/**
 * @param {unknown} row
 * @returns {any}
 */
function rowToFocus(row) {
  return {
    scopeId: String(row.scope_id),
    kind: String(row.focus_kind),
    ref: row.focus_ref == null ? null : String(row.focus_ref),
    label: row.focus_label == null ? null : String(row.focus_label),
    priority: Number(row.priority ?? 50),
    preemptMargin: Number(row.preempt_margin ?? DEFAULT_PREEMPT_MARGIN),
    acquiredAt: String(row.acquired_at),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    preemptedFrom: row.preempted_from == null ? null : String(row.preempted_from),
    preemptCount: Number(row.preempt_count ?? 0),
    source: row.source == null ? null : String(row.source),
    reason: row.reason == null ? null : String(row.reason),
    updatedAt: String(row.updated_at),
  }
}

/**
 * 注意力门面。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> } | null,
 *   clock?: any, alert?: (info: any) => void,
 *   bindings?: { scope_id?: string }, now?: () => number,
 *   events?: { publish: (input: any) => Promise<any> } | null,
 * }} options
 */
export function createAttention(options) {
  const { db, queue } = options
  const clock = options.clock ?? createClock({})
  const alert = options.alert ?? (() => {})
  const now = options.now ?? (() => Date.now())
  const events = options.events ?? null
  const defaultScope = options.bindings?.scope_id ?? 'owner-default'

  /** 读当前焦点。过期焦点视为没有（但**不删行**，留给面板看历史）。 */
  function getFocus(scopeId = defaultScope) {
    const row = db.prepare('SELECT * FROM attention_focus WHERE scope_id = ?').get(scopeId)
    if (!row) return null
    const focus = rowToFocus(row)
    if (focus.expiresAt) {
      const ms = Date.parse(focus.expiresAt)
      if (Number.isFinite(ms) && ms <= now()) return { ...focus, expired: true }
    }
    return { ...focus, expired: false }
  }

  /** 焦点是否仍然有效（未过期）。 */
  function hasActiveFocus(scopeId = defaultScope) {
    const f = getFocus(scopeId)
    return Boolean(f && !f.expired)
  }

  /**
   * 请求获取焦点。返回 `{ ok, focus, preempted, reason }`。
   *
   * - 当前无焦点（或已过期）→ 直接拿。
   * - 同一个 ref → 续期（不算抢占）。
   * - 不同 ref 且 priority > 当前 + margin → 抢占（写审计 + 发事件）。
   * - 否则拒绝，返回当前焦点让调用方自己决定要不要降级。
   *
   * @param {{
   *   kind: string, ref?: string | null, label?: string | null,
   *   priority?: number, margin?: number, ttlMs?: number,
   *   source?: string | null, reason?: string | null, scopeId?: string,
   * }} input
   */
  async function acquireFocus(input) {
    const kind = String(input?.kind ?? '')
    if (!FOCUS_KINDS.includes(kind)) {
      throw new BrainError('INVALID_ARGUMENT', `未知焦点 kind: ${kind}`)
    }
    if (!queue) return { ok: false, reason: 'queue_unavailable', focus: getFocus(input?.scopeId) }

    const scopeId = input?.scopeId ?? defaultScope
    const priority = Number.isFinite(Number(input?.priority)) ? Math.round(Number(input.priority)) : 50
    const margin = Number.isFinite(Number(input?.margin)) ? Math.round(Number(input.margin)) : DEFAULT_PREEMPT_MARGIN
    const ttlMs = Math.max(1000, Number(input?.ttlMs ?? DEFAULT_FOCUS_TTL_MS) || DEFAULT_FOCUS_TTL_MS)
    const ref = input?.ref == null ? null : String(input.ref)
    const nowMs = now()
    const stamp = clock.stamp()
    const expiresAt = new Date(nowMs + ttlMs).toISOString()

    const outcome = await queue.write(
      (tx) => {
        const row = tx.get('SELECT * FROM attention_focus WHERE scope_id = ?', [scopeId])
        const existing = row ? rowToFocus(row) : null
        const existingExpired = existing?.expiresAt
          ? (Date.parse(String(existing.expiresAt)) || 0) <= nowMs
          : false

        // 1) 没有焦点 / 已过期 → 直接拿
        if (!existing || existingExpired) {
          tx.run(
            `INSERT INTO attention_focus (
               scope_id, focus_kind, focus_ref, focus_label, priority, preempt_margin,
               acquired_at, acquired_at_local, expires_at, preempted_from, preempt_count,
               source, reason, updated_at, updated_at_local
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope_id) DO UPDATE SET
               focus_kind = excluded.focus_kind, focus_ref = excluded.focus_ref,
               focus_label = excluded.focus_label, priority = excluded.priority,
               preempt_margin = excluded.preempt_margin, acquired_at = excluded.acquired_at,
               acquired_at_local = excluded.acquired_at_local, expires_at = excluded.expires_at,
               preempted_from = excluded.preempted_from,
               preempt_count = attention_focus.preempt_count + excluded.preempt_count,
               source = excluded.source, reason = excluded.reason,
               updated_at = excluded.updated_at, updated_at_local = excluded.updated_at_local`,
            [
              scopeId, kind, ref, input?.label ?? null, priority, margin,
              stamp.utc, stamp.local, expiresAt,
              existing && existingExpired ? existing.ref : null,
              existing && existingExpired ? 1 : 0,
              input?.source ?? null, input?.reason ?? null, stamp.utc, stamp.local,
            ],
          )
          return { ok: true, preempted: existing && existingExpired ? `expired:${existing.ref ?? ''}` : false }
        }

        // 2) 同一个 ref → 续期
        if (existing.kind === kind && existing.ref === ref) {
          tx.run(
            `UPDATE attention_focus SET expires_at = ?, priority = ?, preempt_margin = ?,
               updated_at = ?, updated_at_local = ? WHERE scope_id = ?`,
            [expiresAt, priority, margin, stamp.utc, stamp.local, scopeId],
          )
          return { ok: true, preempted: false, renewed: true }
        }

        // 3) 抢占判定：差满一个 margin 就允许抢（**取等号**——方案 §8.4 里
        //    P100 主人实时打断 vs P90 主人当前任务正好差 10，那一级必须能抢）；
        //    低于一个 margin 则同级互不打扰。
        if (priority >= existing.priority + existing.preemptMargin) {
          tx.run(
            `UPDATE attention_focus SET
               focus_kind = ?, focus_ref = ?, focus_label = ?, priority = ?, preempt_margin = ?,
               acquired_at = ?, acquired_at_local = ?, expires_at = ?,
               preempted_from = ?, preempt_count = preempt_count + 1,
               source = ?, reason = ?, updated_at = ?, updated_at_local = ?
             WHERE scope_id = ?`,
            [
              kind, ref, input?.label ?? null, priority, margin,
              stamp.utc, stamp.local, expiresAt,
              existing.ref, input?.source ?? null, input?.reason ?? null,
              stamp.utc, stamp.local, scopeId,
            ],
          )
          // 抢占留痕：审计 + 事件（两者都失败不影响抢占本身，但会 alert）
          try {
            tx.run(
              `INSERT INTO audit_logs (audit_id, ts, ts_local, actor, action, target_kind, target_id, scope_id, result, detail)
               VALUES (?, ?, ?, ?, 'attention.preempt', ?, ?, ?, 'ok', ?)`,
              [
                newAuditId(), stamp.utc, stamp.local, String(input?.source ?? kind),
                String(existing.kind), existing.ref, scopeId,
                JSON.stringify({ from: { kind: existing.kind, ref: existing.ref, priority: existing.priority }, to: { kind, ref, priority } }),
              ],
            )
          } catch (err) {
            alert({ kind: 'attention.audit', message: `抢占审计写入失败：${err instanceof Error ? err.message : String(err)}` })
          }
          return { ok: true, preempted: existing.ref ?? existing.kind }
        }

        // 4) 拒绝
        return { ok: false, reason: 'preempt_denied', current: existing }
      },
      { label: 'attention.acquireFocus' },
    )

    if (outcome.ok && outcome.preempted) {
      // 事件发布在事务外（publish 自己不抛错，失败只会 alert）
      await events?.publish?.({
        channel: 'attention',
        sourceModule: 'attention',
        kind: 'attention.preempted',
        subjectType: 'system',
        payload: { kind, ref, priority, preempted: outcome.preempted },
        scopeId,
      })
    }
    return { ...outcome, focus: getFocus(scopeId) }
  }

  /**
   * 释放焦点。**只在当前 ref 匹配时释放**——防止 A 把 B 的焦点清了。
   * @param {{ expectRef?: string | null, scopeId?: string }} [input]
   */
  async function releaseFocus(input = {}) {
    if (!queue) return { ok: false, reason: 'queue_unavailable' }
    const scopeId = input?.scopeId ?? defaultScope
    const expectRef = input?.expectRef === undefined ? undefined : input.expectRef
    const stamp = clock.stamp()
    return queue.write(
      (tx) => {
        const row = tx.get('SELECT focus_ref FROM attention_focus WHERE scope_id = ?', [scopeId])
        if (!row) return { ok: false, reason: 'no_focus' }
        const currentRef = row.focus_ref == null ? null : String(row.focus_ref)
        if (expectRef !== undefined && expectRef !== currentRef) {
          return { ok: false, reason: 'ref_mismatch', currentRef }
        }
        tx.run(
          `UPDATE attention_focus SET focus_kind = 'idle', focus_ref = NULL, focus_label = NULL,
             priority = 0, expires_at = ?, updated_at = ?, updated_at_local = ? WHERE scope_id = ?`,
          [new Date(now() + DEFAULT_FOCUS_TTL_MS).toISOString(), stamp.utc, stamp.local, scopeId],
        )
        return { ok: true }
      },
      { label: 'attention.releaseFocus' },
    )
  }

  return { getFocus, hasActiveFocus, acquireFocus, releaseFocus }
}
