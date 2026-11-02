// @ts-check
/**
 * state.js — 幂等键解析 + 有界步进账本 + 外供包槽。
 *
 * 契约 10.1 是这里存在的唯一理由：
 *   `system-prompt/assemble` 与 `agent/pre-step` 是**每 step 一次**，不是每轮一次；
 *   多步回合的第二个 step 会重新装配整个 system prompt、重过 pre-step waterfall。
 *   → 构包与注入必须按 `(sessionId, turnId, stepId)` 幂等。
 *
 * 自己跑出来的一条关键事实（类型声明里没写，只在运行时存在）：
 *   agent 事件 payload 已被宿主 fused 注入 `agent` 字段（`dsh-agent` 的 agentEvents：
 *   `fused = payload => ({...payload, agent})`），所以 `agent/pre-step` / `agent/turn-stopping`
 *   直接拿 `payload.agent` 就有 agent；`system-prompt/assemble` 的 context 里同样带
 *   `agent`（`assembleContextFor(agent, signal)` 返回 `{agent, scope: agent, signal}`）。
 *   而 sessionId 在 `agent.session.id`。
 *   → 全部按「有就读、没有就失败关闭」处理：拿不到完整键时**不注入**（宁可不注入，
 *     也不重复注入），并把诊断写进队列。
 */

/** 解析不出来的占位符 */
const UNKNOWN = 'unknown'

/**
 * @typedef {Object} StepKey
 * @property {string} key              `session#turn#step` 形式的幂等键
 * @property {string|null} sessionId
 * @property {number|null} turn
 * @property {number|null} step
 * @property {boolean} complete       三项齐全才算完整键；不完整时一律不注入
 * @property {string} reason          不完整的原因（诊断）
 */

/**
 * 从一个可能带 session 的对象上读 sessionId。
 * 顺序：`session.id` → `sessionId` → `id`（agent.id）。
 *
 * 兜底为什么要加 `agent:` 前缀：`agent.id` 是 agent 身份，`session.id` 才是会话
 * 主账键。两者通常一致但不保证；直接混用会让幂等键空间串味（一个 agent 复用
 * 到新会话时可能撞上旧键）。加前缀 = 键空间隔离，语义也诚实。
 * @param {unknown} value
 * @returns {string|null}
 */
export function readSessionId(value) {
  if (value === null || typeof value !== 'object') return null
  const record = /** @type {Record<string, any>} */ (value)
  const sessionId = record.session?.id
  if (typeof sessionId === 'string' && sessionId.length > 0) return sessionId
  if (typeof record.sessionId === 'string' && record.sessionId.length > 0) return record.sessionId
  if (typeof record.id === 'string' && record.id.length > 0) return `agent:${record.id}`
  return null
}

/**
 * 从 agent 上读当前 turn。
 *
 * `agent.phase` 是宿主的运行相位（`{kind:'running', abort, turn, step, wakeRequested}`）。
 * `turn` 在 `turn()` 里、`preStep` 之前就已赋值 —— 读它是可靠的。
 * @param {unknown} agent
 * @returns {number|null}
 */
export function readAgentTurn(agent) {
  if (agent === null || typeof agent !== 'object') return null
  const phase = /** @type {Record<string, any>} */ (agent).phase
  const turn = phase?.turn
  return typeof turn === 'number' && Number.isFinite(turn) ? turn : null
}

/**
 * 从 agent 上读「当前正在 preStep 的 step」。
 *
 * 这里有个坑（实测代码得出）：`phase.step = step` 是在 `preStep()` **返回之后**
 * （`session.append('step/start')` 之后）才赋值的。所以在 `system-prompt/assemble`
 * 里读到的 `phase.step` 还是**上一个** step 的号，当前 step = `phase.step + 1`。
 * 在 `agent/pre-step` 里则必须用 payload.step（payload 里就是当前值）。
 *
 * 只用于 assemble 分支的推导；pre-step 分支永远优先用 payload.step。
 * @param {unknown} agent
 * @returns {number|null}
 */
export function readAgentNextStep(agent) {
  if (agent === null || typeof agent !== 'object') return null
  const phase = /** @type {Record<string, any>} */ (agent).phase
  const step = phase?.step
  if (typeof step !== 'number' || !Number.isFinite(step)) return null
  return step + 1
}

/**
 * 解析一步的幂等键。
 * @param {{ agent?: unknown, sessionId?: unknown, turn?: unknown, step?: unknown }} input
 * @returns {StepKey}
 */
export function resolveStepKey(input) {
  const sessionId = normalizeSessionId(input?.sessionId) ?? readSessionId(input?.agent)
  const turn = normalizeCount(input?.turn) ?? readAgentTurn(input?.agent)
  const step = normalizeCount(input?.step) ?? readAgentNextStep(input?.agent)
  const complete = sessionId !== null && turn !== null && step !== null
  const reason = complete
    ? 'complete'
    : sessionId === null
      ? 'missing sessionId'
      : turn === null
        ? 'missing turn'
        : 'missing step'
  return {
    key: `${sessionId ?? UNKNOWN}#${turn ?? UNKNOWN}#${step ?? UNKNOWN}`,
    sessionId,
    turn,
    step,
    complete,
    reason,
  }
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeSessionId(value) {
  if (typeof value !== 'string' || value.length === 0) return null
  return value
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function normalizeCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null
  return value
}

/**
 * @typedef {Object} LedgerEntry
 * @property {string} key
 * @property {string} channel   'contexts' | 'pre-step'
 * @property {string} contextId
 * @property {number} turn
 * @property {number} step
 * @property {string} sessionId
 * @property {number} at        Date.now()
 */

/**
 * 有界步进账本：记录「这一步已经注入过什么」。
 *
 * 为什么有界：一轮会话的 step 数量不可控（工具循环能跑很久）。账本只用来
 * 防同一 step 重复注入 + 给 sent 检查提供候选，不需要永久保存 —— 永久化是
 * 记忆层的事（context_packages 表）。
 */
export class StepLedger {
  /** @type {Map<string, LedgerEntry>} */
  #entries = new Map()
  /** @type {number} */
  #limit

  /** @param {{ limit?: number }} [options] */
  constructor(options = {}) {
    const limit = options.limit
    this.#limit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 512
  }

  /** @param {string} key @returns {boolean} */
  has(key) {
    return this.#entries.has(key)
  }

  /** @param {string} key @returns {LedgerEntry | undefined} */
  get(key) {
    return this.#entries.get(key)
  }

  /**
   * 记一步的注入。重复写同一个 key 覆盖为最新（后写的通道赢）。
   * @param {string} key
   * @param {Omit<LedgerEntry, 'key'|'at'>} entry
   * @returns {LedgerEntry}
   */
  mark(key, entry) {
    const record = { key, ...entry, at: Date.now() }
    this.#entries.set(key, record)
    // 有界：插入序即时间序（Map 保留插入顺序），驱逐最老
    while (this.#entries.size > this.#limit) {
      const oldest = this.#entries.keys().next()
      if (oldest.done === true) break
      this.#entries.delete(oldest.value)
    }
    return record
  }

  /** @returns {number} */
  get size() {
    return this.#entries.size
  }

  /** @returns {LedgerEntry[]} 最近的条目（新 → 老） */
  recent(limit = 8) {
    const all = [...this.#entries.values()]
    return all.slice(Math.max(0, all.length - limit)).reverse()
  }

  /** @param {string} sessionId @returns {LedgerEntry[]} 该会话最近的注入（新 → 老） */
  forSession(sessionId) {
    return [...this.#entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .reverse()
  }

  /** 清空（测试与回合收尾用）。 */
  clear() {
    this.#entries.clear()
  }
}

/**
 * @typedef {Object} SuppliedPackage
 * @property {string} id
 * @property {Record<string, any>} pkg
 * @property {string|null} sessionId   null = 通配任意会话
 * @property {number|null} turn        null = 通配任意 turn
 * @property {number|null} step        null = 通配任意 step
 * @property {number} at
 */

/**
 * 外供包槽：`explicit` 模式只有「别人明确递过来的包」才会被注入。
 *
 * 这是 deliberate 的设计：M2 阶段构包还在并行开发，连接器不该自己猜要注入什么。
 * 控制台 / server / 测试可以 `supply()` 一个假包或真包进来，连接器只负责
 * 「按 step 幂等地挂上 + 证明 sent」。
 */
export class PackageSlots {
  /** @type {SuppliedPackage[]} */
  #slots = []
  /** @type {number} */
  #limit
  /** @type {number} */
  #seq = 0

  /** @param {{ limit?: number }} [options] */
  constructor(options = {}) {
    const limit = options.limit
    this.#limit = typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 32
  }

  /**
   * @param {Record<string, any>} pkg
   * @param {{ sessionId?: string|null, turn?: number|null, step?: number|null }} [target]
   * @returns {SuppliedPackage}
   */
  supply(pkg, target = {}) {
    this.#seq += 1
    const slot = {
      id: `slot-${this.#seq}`,
      pkg,
      sessionId: typeof target.sessionId === 'string' ? target.sessionId : null,
      turn: typeof target.turn === 'number' ? target.turn : null,
      step: typeof target.step === 'number' ? target.step : null,
      at: Date.now(),
    }
    this.#slots.push(slot)
    while (this.#slots.length > this.#limit) this.#slots.shift()
    return slot
  }

  /**
   * 取出第一个匹配的槽（匹配即消费 —— explicit 的语义是「这一步用它一次」）。
   * @param {{ sessionId: string|null, turn: number|null, step: number|null }} target
   * @returns {SuppliedPackage | null}
   */
  take(target) {
    for (let index = 0; index < this.#slots.length; index += 1) {
      const slot = this.#slots[index]
      if (!matches(slot.sessionId, target.sessionId)) continue
      if (!matches(slot.turn, target.turn)) continue
      if (!matches(slot.step, target.step)) continue
      this.#slots.splice(index, 1)
      return slot
    }
    return null
  }

  /**
   * 只看不消费（shadow 模式：算「本来会注入什么」，但不能把别人的包吃掉）。
   * @param {{ sessionId: string|null, turn: number|null, step: number|null }} target
   * @returns {SuppliedPackage | null}
   */
  peek(target) {
    for (const slot of this.#slots) {
      if (!matches(slot.sessionId, target.sessionId)) continue
      if (!matches(slot.turn, target.turn)) continue
      if (!matches(slot.step, target.step)) continue
      return slot
    }
    return null
  }

  /** @returns {number} */
  get size() {
    return this.#slots.length
  }

  /** 清空。 */
  clear() {
    this.#slots = []
  }
}

/**
 * @param {unknown} expected null = 通配
 * @param {unknown} actual
 * @returns {boolean}
 */
function matches(expected, actual) {
  if (expected === null || expected === undefined) return true
  return expected === actual
}

/**
 * 是不是「只算不注入」的模式。
 * @param {string} mode
 * @returns {boolean}
 */
export function isShadowMode(mode) {
  return mode === 'shadow'
}

/**
 * 是不是「会真的注入」的模式。
 * @param {string} mode
 * @returns {boolean}
 */
export function isInjectingMode(mode) {
  return mode === 'explicit' || mode === 'automatic'
}
