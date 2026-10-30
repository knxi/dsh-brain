// @ts-check
/**
 * `brain_switches` 全局开关 —— 停止闸门（方案 §8.5 / §10「全局停止」）。
 *
 * ── 为什么单独一张表、单独一个模块 ──
 *
 * 因为它是**唯一的逃生门**。所有自主行为（反思、社交、指令、外发）在执行前
 * 都必须问它一句「现在允许吗」。这个判断必须便宜、可靠、没有副作用——
 * 它自己不能依赖任何可能出问题的东西。
 *
 * ── 语义纪律 ──
 *
 * 1. **缺省即关闭**。`isEnabled()` 在对某个键没把握时返回 `false`。
 *    一个"读不到就当开着"的开关等于没有开关。
 * 2. **只有显式真值才算开**：'1' / 'true' / 'on' / 'yes'（大小写不敏感）。
 *    '0'、''、'off'、'false'、'no'、任何其它字符串都算关。
 * 3. **`paused` 是最高优先级**：它不区分模块，任何自主行为看到 paused 都必须停手。
 * 4. **值不校验成布尔**：`autonomy.max_level` 存的是 'L1' 这种等级字符串，
 *    不是开/关。所以这张表是 key-value，不是 boolean 表。
 */

import { BrainError, createClock } from '@dsh-brain/core'

/** 已知开关（未知键也允许读写，便于将来扩展；这里只是给默认值兜底）。 */
export const KNOWN_SWITCHES = Object.freeze({
  'autonomy.enabled': '0',
  'autonomy.max_level': 'L1',
  'social.enabled': '0',
  'social.allow_external': '0',
  'reflection.enabled': '0',
  'paused': '0',
})

/** 会被 `isEnabled` 当布尔解释的键。 */
const BOOLEAN_SWITCHES = Object.freeze([
  'autonomy.enabled', 'social.enabled', 'social.allow_external', 'reflection.enabled', 'paused',
])

const TRUE_VALUES = Object.freeze(['1', 'true', 'on', 'yes'])

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function toBool(value) {
  if (value === true) return true
  if (value === false || value === undefined || value === null) return false
  return TRUE_VALUES.includes(String(value).trim().toLowerCase())
}

/**
 * 开关门面。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> } | null,
 *   clock?: any, alert?: (info: any) => void, now?: () => number,
 * }} options
 */
export function createSwitches(options) {
  const { db, queue } = options
  const clock = options.clock ?? createClock({})
  const alert = options.alert ?? (() => {})

  /** 读原始值。没这行返回 `null`（不返回默认值——调用方要能区分"没配"和"配成关"）。 */
  function get(name) {
    const key = String(name ?? '').trim()
    if (!key) throw new BrainError('INVALID_ARGUMENT', '开关名必填')
    try {
      const row = db.prepare('SELECT value FROM brain_switches WHERE name = ?').get(key)
      return row ? String(row.value) : null
    } catch (err) {
      // 表不存在（迁移没跑）时不要让调用方崩：当"没配"处理，isEnabled 会返回 false
      alert({ kind: 'workspace.getSwitch', message: `读开关失败：${err instanceof Error ? err.message : String(err)}`, detail: { name: key } })
      return null
    }
  }

  /**
   * 是否允许。**不确定就是不允许**（安全侧默认）。
   * @param {string} name
   */
  function isEnabled(name) {
    const raw = get(name)
    if (raw === null) return false
    return toBool(raw)
  }

  /** 全局暂停。**任何自主行为执行前必须问。** */
  function isPaused() {
    return isEnabled('paused')
  }

  /**
   * 一次问三个问题：暂停了吗？这个模块开了吗？等级够吗？
   * 任一不满足返回 `{ allowed: false, reason }`。
   *
   * @param {{ module: 'autonomy' | 'social' | 'reflection', requiredLevel?: 'L0' | 'L1' | 'L2' | 'L3' }} input
   */
  function assertAllowed(input) {
    if (isPaused()) return { allowed: false, reason: 'global_paused' }
    if (input?.module === 'autonomy') {
      if (!isEnabled('autonomy.enabled')) return { allowed: false, reason: 'autonomy_disabled' }
      const level = get('autonomy.max_level') ?? 'L1'
      const order = ['L0', 'L1', 'L2', 'L3']
      const required = input?.requiredLevel ?? 'L1'
      if (order.indexOf(level) < order.indexOf(required)) {
        return { allowed: false, reason: `level_too_low(${level}<${required})` }
      }
      return { allowed: true, reason: 'ok', level }
    }
    if (input?.module === 'social') {
      if (!isEnabled('social.enabled')) return { allowed: false, reason: 'social_disabled' }
      return { allowed: true, reason: 'ok', allowExternal: isEnabled('social.allow_external') }
    }
    if (input?.module === 'reflection') {
      if (!isEnabled('reflection.enabled')) return { allowed: false, reason: 'reflection_disabled' }
      return { allowed: true, reason: 'ok' }
    }
    return { allowed: false, reason: 'unknown_module' }
  }

  /**
   * 改开关（写审计：谁在什么时候为什么改的）。
   *
   * @param {string} name
   * @param {string | number | boolean} value
   * @param {{ by?: string, reason?: string }} [meta]
   */
  async function set(name, value, meta = {}) {
    const key = String(name ?? '').trim()
    if (!key) throw new BrainError('INVALID_ARGUMENT', '开关名必填')
    const raw = typeof value === 'boolean' ? (value ? '1' : '0') : String(value)
    if (BOOLEAN_SWITCHES.includes(key) && !['0', '1'].includes(raw)) {
      throw new BrainError('INVALID_ARGUMENT', `${key} 是布尔开关，只接受 '0' / '1'（收到 '${raw}'）`)
    }
    if (!queue) throw new BrainError('QUEUE_CLOSED', '写队列不可用，改不了开关')
    const stamp = clock.stamp()
    const by = meta?.by == null ? 'unknown' : String(meta.by).slice(0, 120)
    const reason = meta?.reason == null ? null : String(meta.reason).slice(0, 400)

    return queue.write(
      (tx) => {
        const before = tx.get('SELECT value FROM brain_switches WHERE name = ?', [key])
        tx.run(
          `INSERT INTO brain_switches (name, value, updated_at, updated_at_local, updated_by, reason)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             value = excluded.value, updated_at = excluded.updated_at,
             updated_at_local = excluded.updated_at_local,
             updated_by = excluded.updated_by, reason = excluded.reason`,
          [key, raw, stamp.utc, stamp.local, by, reason],
        )
        try {
          tx.run(
            `INSERT INTO audit_logs (audit_id, ts, ts_local, actor, action, target_kind, target_id, result, detail)
             VALUES (?, ?, ?, ?, 'switch.set', 'switch', ?, 'ok', ?)`,
            [
              `audit_${clock.stamp().utc.replace(/\D/g, '').slice(0, 12)}_${randomHex(6)}`,
              stamp.utc, stamp.local, by, key,
              JSON.stringify({ before: before ? String(before.value) : null, after: raw, reason }),
            ],
          )
        } catch (err) {
          alert({ kind: 'workspace.setSwitch.audit', message: `开关审计写入失败：${err instanceof Error ? err.message : String(err)}` })
        }
        return { ok: true, name: key, value: raw, previous: before ? String(before.value) : null }
      },
      { label: 'workspace.setSwitch' },
    )
  }

  /** 全部开关（面板用）。缺的键用默认值补上，方便一眼看全。 */
  function list() {
    let rows = []
    try {
      rows = db.prepare('SELECT * FROM brain_switches ORDER BY name').all()
    } catch {
      rows = []
    }
    const map = new Map(rows.map((r) => [String(r.name), r]))
    /** 迁移时 `INSERT OR IGNORE` 写进去的算「还是默认值」，不是人工改过。 */
    const isDefaultRow = (row) => !row || String(row.updated_by ?? '') === 'migration'
    const out = []
    const seen = new Set()
    for (const [name, fallback] of Object.entries(KNOWN_SWITCHES)) {
      const row = map.get(name)
      seen.add(name)
      out.push({
        name,
        value: row ? String(row.value) : fallback,
        isDefault: isDefaultRow(row),
        enabled: toBool(row ? row.value : fallback),
        updatedAt: row ? String(row.updated_at) : null,
        updatedBy: row ? String(row.updated_by ?? '') || null : null,
        reason: row ? String(row.reason ?? '') || null : null,
      })
    }
    for (const [name, row] of map) {
      if (seen.has(name)) continue
      out.push({
        name,
        value: String(row.value),
        isDefault: isDefaultRow(row),
        enabled: toBool(row.value),
        updatedAt: String(row.updated_at),
        updatedBy: String(row.updated_by ?? '') || null,
        reason: String(row.reason ?? '') || null,
      })
    }
    return out
  }

  return { get, isEnabled, isPaused, assertAllowed, set, list }
}

/** @returns {string} */
function randomHex(bytes) {
  const { randomBytes } = /** @type {any} */ (globalThis).process.getBuiltinModule('node:crypto')
  return randomBytes(bytes).toString('hex')
}
