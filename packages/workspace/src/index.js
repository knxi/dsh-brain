// @ts-check
/**
 * `@dsh-brain/workspace` —— 全局工作空间（系统 3 的通信面与仲裁层）。
 *
 * ── 它在整个系统里的位置 ──
 *
 * ```
 *   感知（connector）
 *        │  publish({channel:'sense'})
 *        ▼
 *   ┌─────────────────────┐
 *   │   全局工作空间        │  ← 本包：事件总线 + 候选仲裁 + 注意力 + 开关
 *   └─────┬─────────┬─────┘
 *         │         │
 *   反思/技能    社交/指令
 *   （cognition） （persona / directives）
 * ```
 *
 * 方案 §3.1 的规则在这里变成三道真实约束：
 * 1. 模块之间不直接调用，只 `publish` 事件；
 * 2. 想改变世界就 `propose` 候选，由执行控制器（现在是人，将来是 scheduler）仲裁；
 * 3. 任何自主行为执行前必须 `assertAllowed` / `isPaused`。
 *
 * ── 为什么把四个子模块放在一个包里 ──
 *
 * 它们的生命周期完全一致（跟着主账一起构造、一起关闭），拆成四个包只会多出
 * 四份 junction 与四份 exports 配置，而没有任何隔离收益——它们本来就是同一个
 * 概念「工作空间」的四个面。
 *
 * ── 依赖方向（重要） ──
 *
 * 本包**只依赖 @dsh-brain/core**，不依赖 memory 包。写队列 `queue` 由调用方注入
 * （`openBrain` 组装时传进来）。这样杜绝了 memory ↔ workspace 的循环依赖，
 * 也让本包可以脱离主账单独测试（传一个假 queue 即可）。
 */

import { createClock } from '@dsh-brain/core'
import { createEventBus, WS_CHANNELS } from './events.js'
import { createCandidateBoard, CANDIDATE_KINDS, CANDIDATE_STATUSES, KINDS_REQUIRING_EVIDENCE } from './candidates.js'
import { createAttention, FOCUS_KINDS, FOCUS_PRIORITY } from './focus.js'
import { createSwitches, KNOWN_SWITCHES, toBool } from './switches.js'

/**
 * @typedef {Object} WorkspaceOptions
 * @property {import('node:sqlite').DatabaseSync} db
 * @property {{ write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> } | null} queue
 * @property {any} [clock]
 * @property {(info: { kind: string, message: string, detail?: Record<string, unknown> }) => void} [alert]
 * @property {{ scope_id?: string, person_id?: string }} [bindings]
 * @property {() => number} [now] 测试注入时钟用
 */

/**
 * 组装全局工作空间。
 *
 * @param {WorkspaceOptions} options
 */
export function createWorkspace(options) {
  if (!options || !options.db) throw new TypeError('createWorkspace 需要 db')
  const clock = options.clock ?? createClock({})
  const scopeId = options.bindings?.scope_id ?? 'owner-default'
  const base = {
    db: options.db,
    queue: options.queue ?? null,
    clock,
    alert: options.alert ?? (() => {}),
    bindings: { scope_id: scopeId },
    now: options.now,
  }

  const switches = createSwitches(base)
  const events = createEventBus(base)
  const candidates = createCandidateBoard(base)
  const attention = createAttention({ ...base, events })

  return {
    scopeId,

    // ── 开关（逃生门，放最前面）───────────────────────────────
    /** 读原始值；没配返回 null。 */
    getSwitch: switches.get,
    /** 布尔语义：不确定就是不允许。 */
    isEnabled: switches.isEnabled,
    /** 全局暂停。任何自主行为执行前必须问。 */
    isPaused: switches.isPaused,
    /** 一次问三个问题：暂停？模块开？等级够？ */
    assertAllowed: switches.assertAllowed,
    /** 改开关（写审计）。 */
    setSwitch: switches.set,
    /** 全部开关（面板用）。 */
    listSwitches: switches.list,

    // ── 事件总线 ─────────────────────────────────────────────
    /** 发布事件（不抛错；返回 null 表示没写进去）。 */
    publish: events.publish,
    /** 读某模块消费水位。 */
    getCursor: events.getCursor,
    /** 拉取水位后的事件（只读，不推进水位）。 */
    pullEvents: events.pullEvents,
    /** 推进消费水位（处理成功之后才调）。 */
    advanceCursor: events.advanceCursor,
    /** 事件统计。 */
    stats: events.stats,

    // ── 候选与仲裁 ───────────────────────────────────────────
    /** 提一个候选（score/evidence/expiresAt 都在这里定）。 */
    propose: candidates.propose,
    /** 列候选（优先级 + 分数降序）。 */
    listCandidates: candidates.listCandidates,
    /** 抢占执行权（租约）。 */
    claim: candidates.claim,
    /** 续租。 */
    heartbeat: candidates.heartbeat,
    /** 结案（必须带对的 owner）。 */
    complete: candidates.complete,
    /** 回收租约过期的僵尸候选。 */
    reclaimExpired: candidates.reclaimExpired,
    /** 候选面板统计。 */
    candidateStats: candidates.stats,

    // ── 注意力 ───────────────────────────────────────────────
    /** 读当前焦点（过期焦点带 expired 标记）。 */
    getFocus: attention.getFocus,
    /** 是否有未过期焦点。 */
    hasActiveFocus: attention.hasActiveFocus,
    /** 请求焦点（带抢占门槛与审计）。 */
    acquireFocus: attention.acquireFocus,
    /** 释放焦点（只在 ref 匹配时）。 */
    releaseFocus: attention.releaseFocus,

    /** 子门面原样暴露，便于分模块使用与测试。 */
    sub: { switches, events, candidates, attention },
  }
}

export { WS_CHANNELS } from './events.js'
export {
  CANDIDATE_KINDS,
  CANDIDATE_STATUSES,
  KINDS_REQUIRING_EVIDENCE,
  DEFAULT_LEASE_MS,
  RECLAIM_BACKOFF_MS,
} from './candidates.js'
export { createEventBus, PAYLOAD_SOFT_BYTES, PAYLOAD_HARD_BYTES, DEFAULT_PULL_LIMIT, MAX_PULL_LIMIT } from './events.js'
export { createCandidateBoard, MAX_LIST_LIMIT } from './candidates.js'
export { createAttention, FOCUS_KINDS, FOCUS_PRIORITY, DEFAULT_FOCUS_TTL_MS, DEFAULT_PREEMPT_MARGIN } from './focus.js'
export { createSwitches, KNOWN_SWITCHES, toBool } from './switches.js'
