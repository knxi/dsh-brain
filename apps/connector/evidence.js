// @ts-check
/**
 * evidence.js — `attached` / `sent` 两级的判定与落库。
 *
 * 为什么这一级只能由连接器做：**只有它在回合边界拿得到 `(turn, step)` 与最终请求对象**
 * （`llm/stream` 的 deep-frozen options）。构包侧（context2）出生只能给 `built`。
 *
 * 四条硬要求（Lead 收口清单）：
 * 1. **可选注入**：`store.contextPackages.updateStatus` 不存在 → 跳过，不报错。
 *    形状照 context2 `packages/context/src/build.js` 的 `persistPackage`：
 *    没有能力不是错误，是「这个部署没装主账」。
 * 2. **绝不影响宿主**：落库是旁路里的旁路。这里**所有**函数都不抛，失败只回
 *    `{ status: 'failed', reason }` 交给调用方记日志（契约 10.2）。
 * 3. **`proves_wire_delivery` 恒为 `false`**：能证到的是「最终请求对象里有这个 payload」，
 *    不是「字节出网」。检查器靠这个字段决定措辞，不许美化。
 * 4. **carrier 用实际观测到的**：`probe-sent` 的三级命中位置映射成真实承载，绝不默认填声明值。
 *
 * ## carrier 词表比契约多一个值
 * CONTRACTS 10.9 / M2-INTERFACES §2 的 carrier 词表是 `system` / `messages[role=system]`
 * 两级 —— 那是 **system prompt** 的两种承载。但 M0 实测（`M0-probe-report.md` §2 Q2）
 * 明确了 Brain 的注入通道：
 *   - `systemPrompt.context()` / `assembly.contexts` → **durable user-role snapshot**（user/message）
 *   - `agent/pre-step` 追加 → user/message
 * 两条通道都落在 **user 角色消息**里，既不是 `system` 也不是 `messages[role=system]`。
 * 所以本模块定义第三值 `messages[user]`。不照实写就会把「user 消息里的注入」谎报成
 * system 承载，检查器会显示一个从未发生的位置。已上报 Lead / context2。
 */

/**
 * 承载位置。
 * @readonly
 */
export const CARRIER = Object.freeze({
  /** `request.system` —— 标题旁路形态 */
  SYSTEM: 'system',
  /** `messages[role=system]` —— 主请求的 system prompt 形态 */
  SYSTEM_ROLE_MESSAGE: 'messages[role=system]',
  /** 非 system 的消息（Brain 的 contexts / pre-step 两个通道都落这里） */
  USER_MESSAGE: 'messages[user]',
})

/** 所有合法 carrier。 */
export const CARRIERS = Object.freeze([CARRIER.SYSTEM, CARRIER.SYSTEM_ROLE_MESSAGE, CARRIER.USER_MESSAGE])

/**
 * `probe-sent` 的命中位置 → 真实 carrier。
 * 未知位置返回 null（不猜、不默认）。
 * @type {Readonly<Record<string, string>>}
 */
export const CARRIER_BY_MATCH = Object.freeze({
  'request.system': CARRIER.SYSTEM,
  'messages[role=system]': CARRIER.SYSTEM_ROLE_MESSAGE,
  'messages[other]': CARRIER.USER_MESSAGE,
})

/** attached 级的证据标签：证明的是「挂到了宿主传入的装配结果上」。 */
export const ATTACHED_EVIDENCE_LEVEL = 'attached:assembly'
/** sent 级的证据标签：证明的是「进了最终请求对象」。 */
export const SENT_EVIDENCE_LEVEL = 'sent:request-object'

/**
 * 把命中位置映射成 carrier 列表（去重、保序、丢弃未知）。
 * @param {unknown} matchedIn
 * @returns {string[]}
 */
export function carriersFor(matchedIn) {
  if (!Array.isArray(matchedIn)) return []
  /** @type {string[]} */
  const carriers = []
  for (const match of matchedIn) {
    const carrier = CARRIER_BY_MATCH[String(match)]
    if (carrier !== undefined && !carriers.includes(carrier)) carriers.push(carrier)
  }
  return carriers
}

/**
 * 三级状态（与 context2 的 `PACKAGE_STATUS` 同名同义，避免两套词）。
 * @readonly
 */
export const EVIDENCE_STATUS = Object.freeze({
  BUILT: 'built',
  ATTACHED: 'attached',
  SENT: 'sent',
})

/**
 * @typedef {Object} EvidenceRecord
 * @property {string} contextId
 * @property {'built'|'attached'|'sent'} status
 * @property {string|null} carrier
 * @property {{ level: string, at: string, turn: number|null, step: number|null, locations: string[] }} attached
 * @property {{ level: string, at: string, provesWireDelivery: false, locations: string[], strength: 'observed'|'declared' }} sent
 * @property {number} updates 成功落库次数
 */

/**
 * @typedef {Object} UpdateOutcome
 * @property {'persisted'|'skipped'|'failed'|'rejected'} status
 * @property {string|null} reason
 * @property {string} contextId
 */

/**
 * 建一个证据落库器。
 *
 * @param {{
 *   store?: unknown,
 *   log?: (level: 'info'|'warn'|'error', message: string) => void,
 *   onRecord?: (record: EvidenceRecord, action: 'attach'|'send') => void,
 * }} [options]
 */
export function createEvidenceSink(options = {}) {
  let store = options.store ?? null
  const log = typeof options.log === 'function' ? options.log : () => {}
  const onRecord = typeof options.onRecord === 'function' ? options.onRecord : () => {}

  /** @type {Map<string, EvidenceRecord>} */
  const records = new Map()
  /** @type {Set<Promise<unknown>>} 让测试/冒烟能等到所有旁路写完成 */
  const pending = new Set()
  /** @type {{ persisted: number, skipped: number, failed: number, rejected: number }} */
  const counters = { persisted: 0, skipped: 0, failed: 0, rejected: 0 }

  /**
   * 取（或建）一条证据记录。**不**做任何 IO。
   * @param {string} contextId
   * @param {{ sessionId?: string|null, turn?: number|null, step?: number|null }} [position]
   * @returns {EvidenceRecord}
   */
  function recordOf(contextId, position = {}) {
    let record = records.get(contextId)
    if (record === undefined) {
      record = {
        contextId,
        status: EVIDENCE_STATUS.BUILT,
        carrier: null,
        attached: { level: '', at: '', turn: position.turn ?? null, step: position.step ?? null, locations: [] },
        sent: { level: '', at: '', provesWireDelivery: false, locations: [], strength: 'declared' },
        updates: 0,
      }
      records.set(contextId, record)
    }
    return record
  }

  /**
   * 调 `store.contextPackages.updateStatus`（如果它存在）。**绝不抛**。
   *
   * @param {string} contextId
   * @param {Record<string, unknown>} patch
   * @returns {Promise<UpdateOutcome>}
   */
  async function updateStatus(contextId, patch) {
    try {
      const facade = /** @type {{ contextPackages?: unknown }} */ (store ?? {}).contextPackages
      if (facade === null || facade === undefined || typeof facade !== 'object') {
        counters.skipped += 1
        return { status: 'skipped', reason: 'no_context_packages_facade', contextId }
      }
      const api = /** @type {{ updateStatus?: unknown }} */ (facade)
      if (typeof api.updateStatus !== 'function') {
        counters.skipped += 1
        return { status: 'skipped', reason: 'update_status_not_callable', contextId }
      }
      await /** @type {(id: string, patch: Record<string, unknown>) => Promise<unknown>} */ (api.updateStatus)(contextId, patch)
      counters.persisted += 1
      return { status: 'persisted', reason: null, contextId }
    } catch (error) {
      // 旁路写失败：只记账，不向上抛（契约 10.2）。
      counters.failed += 1
      const reason = error instanceof Error ? error.message : String(error)
      log('warn', `evidence.updateStatus(${contextId}) failed (contained): ${reason}`)
      return { status: 'failed', reason, contextId }
    }
  }

  /**
   * 包一层：把 promise 放进 pending，永不 reject。
   * @param {Promise<UpdateOutcome>} promise
   * @returns {Promise<UpdateOutcome>}
   */
  function track(promise) {
    const safe = promise.catch((error) => ({
      status: /** @type {'failed'} */ ('failed'),
      reason: error instanceof Error ? error.message : String(error),
      contextId: 'unknown',
    }))
    pending.add(safe)
    void safe.finally(() => pending.delete(safe))
    return safe
  }

  /**
   * built → attached。宿主已把片段挂到装配结果上。
   *
   * 状态机（照 CONTRACTS §6 / context2 的语义逐条对齐，但不复用它的 carrier 白名单）：
   * - `sent` 之后再 attached = 回退 → 拒绝；
   * - `attached` 重复调用 = 幂等（保留首次时间戳）；
   * - carrier 以**实际通道落点**为准（两个注入通道都落 user 角色消息）。
   *
   * @param {{
   *   contextId: string,
   *   channel: 'contexts'|'pre-step',
   *   carrier: string,
   *   turn?: number|null,
   *   step?: number|null,
   *   sessionId?: string|null,
   * }} input
   * @returns {Promise<UpdateOutcome>}
   */
  function attached(input) {
    const contextId = typeof input?.contextId === 'string' ? input.contextId : ''
    if (contextId.length === 0) {
      return Promise.resolve({ status: /** @type {'skipped'} */ ('skipped'), reason: 'missing_context_id', contextId })
    }
    return track(markAttachedInner(input))
  }

  /**
   * @param {NonNullable<Parameters<typeof attached>[0]>} input
   * @returns {Promise<UpdateOutcome>}
   */
  async function markAttachedInner(input) {
    const contextId = String(input.contextId)
    const carrier = typeof input.carrier === 'string' && input.carrier.length > 0 ? input.carrier : CARRIER.USER_MESSAGE
    const record = recordOf(contextId, { turn: input.turn ?? null, step: input.step ?? null })

    if (record.status === EVIDENCE_STATUS.SENT) {
      counters.rejected += 1
      log('warn', `evidence: 拒绝状态回退（sent → attached）contextId=${contextId}`)
      return { status: /** @type {'rejected'} */ ('rejected'), reason: 'no_regression_from_sent', contextId }
    }
    if (record.status === EVIDENCE_STATUS.ATTACHED) {
      // 同一 step 的重放：幂等，不改首次证据。
      return { status: /** @type {'skipped'} */ ('skipped'), reason: 'already_attached', contextId }
    }

    record.status = EVIDENCE_STATUS.ATTACHED
    record.carrier = carrier
    record.attached = {
      level: ATTACHED_EVIDENCE_LEVEL,
      at: new Date().toISOString(),
      turn: input.turn ?? null,
      step: input.step ?? null,
      locations: [carrier],
    }
    record.updates += 1

    const outcome = await updateStatus(contextId, {
      status: EVIDENCE_STATUS.ATTACHED,
      carrier,
      evidence: {
        evidence_level: ATTACHED_EVIDENCE_LEVEL,
        // 挂了 ≠ 发了。这一级同样不证明出网。
        proves_wire_delivery: false,
        observed_hash_locations: [carrier],
        channel: input.channel,
        turn: record.attached.turn,
        step: record.attached.step,
        session_id: input.sessionId ?? null,
        at: record.attached.at,
      },
    })
    try {
      onRecord(record, 'attach')
    } catch {
      /* 回调崩了也不能抛 */
    }
    if (outcome.status !== 'persisted') {
      log('info', `evidence.attached(${contextId}) 未落库：${String(outcome.reason)}`)
    }
    return outcome
  }

  /**
   * attached → sent。最终请求对象里真的找到了这个 payload。
   *
   * `locations` 必须是**实测命中位置**（`probe-sent` 的 `matchedIn`），不接受调用方只声明。
   * 没命中位置的 sent 一律降级成 `declared` 弱证据 —— 但本连接器不会走到那条路：
   * 我们只在真命中时才调 `sent()`。
   *
   * @param {{
   *   contextId: string,
   *   matchedIn: string[],
   *   carrier?: string|null,
   *   needle?: string|null,
   *   purpose?: string|null,
   * }} input
   * @returns {Promise<UpdateOutcome>}
   */
  function sent(input) {
    const contextId = typeof input?.contextId === 'string' ? input.contextId : ''
    if (contextId.length === 0) {
      return Promise.resolve({ status: /** @type {'skipped'} */ ('skipped'), reason: 'missing_context_id', contextId })
    }
    return track(markSentInner(input))
  }

  /**
   * @param {NonNullable<Parameters<typeof sent>[0]>} input
   * @returns {Promise<UpdateOutcome>}
   */
  async function markSentInner(input) {
    const contextId = String(input.contextId)
    const locations = carriersFor(input.matchedIn)
    const observed = locations.length > 0

    // 没有实测位置：不许声称 sent（CONTRACTS §6）。
    if (!observed) {
      counters.rejected += 1
      log('warn', `evidence: 拒绝无请求边界证据的 sent contextId=${contextId}`)
      return { status: /** @type {'rejected'} */ ('rejected'), reason: 'no_request_boundary_evidence', contextId }
    }

    const record = recordOf(contextId)
    if (record.status === EVIDENCE_STATUS.SENT) {
      const sameCarrier = record.carrier === null || locations.includes(record.carrier)
      if (sameCarrier) {
        return { status: /** @type {'skipped'} */ ('skipped'), reason: 'already_sent', contextId }
      }
      counters.rejected += 1
      return { status: /** @type {'rejected'} */ ('rejected'), reason: 'carrier_locked_after_sent', contextId }
    }
    if (record.status === EVIDENCE_STATUS.BUILT) {
      // 不跳级：没 attached 就 sent 说明调用方漏了一步，拒绝而不是替它猜。
      counters.rejected += 1
      log('warn', `evidence: 拒绝跳级（built → sent）contextId=${contextId}`)
      return { status: /** @type {'rejected'} */ ('rejected'), reason: 'no_skip_from_built', contextId }
    }

    // carrier 用**实际观测到**的那个（多级命中时取第一个：最贴近声明语序）。
    const carrier = typeof input.carrier === 'string' && locations.includes(input.carrier)
      ? input.carrier
      : locations[0]

    record.status = EVIDENCE_STATUS.SENT
    record.carrier = carrier
    record.sent = {
      level: SENT_EVIDENCE_LEVEL,
      at: new Date().toISOString(),
      provesWireDelivery: false,
      locations: [...locations],
      strength: 'observed',
    }
    record.updates += 1

    const outcome = await updateStatus(contextId, {
      status: EVIDENCE_STATUS.SENT,
      carrier,
      evidence: {
        evidence_level: SENT_EVIDENCE_LEVEL,
        // 恒 false：这层证据只到「宿主决定发这些内容」，不证明字节出网（CONTRACTS 10.4）。
        proves_wire_delivery: false,
        observed_hash_locations: [...locations],
        matched_in: Array.isArray(input.matchedIn) ? [...input.matchedIn] : [],
        needle: typeof input.needle === 'string' ? input.needle : null,
        purpose: typeof input.purpose === 'string' ? input.purpose : null,
        at: record.sent.at,
      },
    })
    try {
      onRecord(record, 'send')
    } catch {
      /* 同上 */
    }
    if (outcome.status !== 'persisted') {
      log('info', `evidence.sent(${contextId}) 未落库：${String(outcome.reason)}`)
    }
    return outcome
  }

  return {
    /**
     * 延迟注入主账（连接器在第一次需要注入时才打开主账，避免加载期依赖）。
     * 已存在的 store 不会被覆盖成 null。
     * @param {unknown} nextStore
     */
    setStore(nextStore) {
      if (nextStore === null || nextStore === undefined) return
      store = nextStore
    },
    /** @param {string} contextId */
    get(contextId) {
      return records.get(contextId) ?? null
    },
    /** @returns {EvidenceRecord[]} */
    all() {
      return [...records.values()]
    },
    /**
     * 等所有旁路写完成（测试 / 冒烟用；运行期不需要）。
     * @returns {Promise<void>}
     */
    async settled() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending])
      }
    },
    counts() {
      return { ...counters }
    },
    /** 主账门面在不在（诊断用，供冒烟区分「没装主账」和「写了但失败」）。 */
    facadeKind() {
      const facade = /** @type {{ contextPackages?: unknown }} */ (store ?? {}).contextPackages
      if (facade === null || facade === undefined || typeof facade !== 'object') return 'absent'
      const api = /** @type {{ updateStatus?: unknown }} */ (facade)
      return typeof api.updateStatus === 'function' ? 'ready' : 'no_update_status'
    },
    attached,
    sent,
    /** 清空内存状态（测试用）。 */
    reset() {
      records.clear()
    },
  }
}
