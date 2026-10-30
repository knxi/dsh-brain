// @ts-check
/**
 * @dsh-brain/connector — DSH 外置大脑连接器（cordis 插件）。
 *
 * ## 挂什么
 * | 钩子 | 模式 | 我们做什么 |
 * |---|---|---|
 * | `system-prompt/assemble` | waterfall | `await next()` 后**复制** assembly，把 Brain 片段作为 PromptContext 追加 |
 * | `agent/pre-step` | waterfall | `await next()`，decision 带 messages 时复制后追加（备用通道） |
 * | `llm/stream` | waterfall | **只观测**：抓最终请求对象做 sent 判据，绝不改写 |
 * | `session/event` | emit 监听 | 摄取到有界持久队列（按 seq 幂等） |
 * | `agent/turn-stopping` | **serial** | 回合收尾控制点。**不是 waterfall**，没有 next 参数 |
 *
 * ## 七条硬纪律（docs/M2-INTERFACES.md §3.2，逐条有落点）
 * 1. **运行期零抛出**：每个 hook 顶层 try/catch（`runGuarded`）。下游 `next()` 的错误
 *    **原样透传**（吞掉会改变宿主行为），只有我们自己产生的错误被吞并记日志。
 * 2. **按 step 幂等**：`(sessionId,turn,step)` 解析见 state.js，注入前过 `StepLedger`。
 * 3. **注入带来源**：inject.js 的文本第一行就是 `<!-- dsh-brain-origin:{...} -->`；
 *    摄取侧按 origin.js 剔除自身与兄弟引擎的注入（契约 10.6 闭环）。
 * 4. **不注册 `complete: true`**：本插件只挂 waterfall，不注册任何 system prompt 节。
 * 5. **不改宿主数组**：一律 `{...obj, contexts|messages: [...原, 新]}`。
 * 6. **sent 查两级承载**：probe-sent.js 同时查 `options.system` 与
 *    `options.messages[role=system]`（+ 非 system 消息，覆盖 pre-step 通道）。
 * 7. **请求计数剔除旁路**：`purpose === 'session-title'` 不计入主请求。
 *
 * ## 模式
 * `off` 不挂任何 hook；`shadow`（默认）只算不注入；`explicit` 只注入别人
 * `supply()` 递过来的包；`automatic` 用配置的 `buildPackage()` 自己构包。
 */

import { createHash } from 'node:crypto'
import { BoundedEventQueue } from './queue.js'
import { CARRIER, createEvidenceSink } from './evidence.js'
import { CHANNEL_CONTEXTS, CHANNEL_PRESTEP, CHANNELS, buildContextEntry, buildUserMessage, estimateTokens, normalizePackage } from './inject.js'
import { checkSentAny, describeRequest, isMainRequest } from './probe-sent.js'
import { ORIGIN_SYSTEM, PRODUCER, classifyUserFrame, parseOriginTag } from './origin.js'
import { PackageSlots, StepLedger, isInjectingMode, resolveStepKey } from './state.js'

/** cordis 插件名 */
export const name = 'brain-connector'

/**
 * 不声明 inject：本插件不依赖 `systemPrompt` 服务注册 provider，只挂事件 waterfall；
 * 服务不存在时事件永不触发，等于自然降级。加载期失败（找不到包）会被宿主降级成
 * warning（M0 §3 实测），不会拖垮宿主。
 */
export const inject = []

/** 模式：off | shadow | explicit | automatic */
export const MODES = Object.freeze(['off', 'shadow', 'explicit', 'automatic'])

const DEFAULT_CONFIG = {
  /** 模式，默认 shadow（M2 门槛：automatic 要先过「无重复注入」验收）。 */
  mode: 'shadow',
  /** 有界持久队列落点（契约 §1：connector 只写 data/events/）。 */
  dir: 'E:/ds-h/dsh-brain/data/events',
  /** 注入通道：'contexts'（默认，PromptContext/durable user-role 快照）或 'pre-step'。 */
  injectChannel: 'contexts',
  /** 注入文本上限（字符）。截断只截正文，不截来源标记。 */
  maxInjectChars: 6000,
  /** 队列里是否落事件正文（默认落，便于记忆层取原文；上限见 maxPayloadChars）。 */
  captureText: true,
  /** 单条事件正文字符上限（契约 11.5：payload_text ≤ 256KB，这里默认更保守）。 */
  maxPayloadChars: 4096,
  /** 连接器绑定值。契约 §2：不采信消息正文，MVP 固定 owner。 */
  scopeId: 'owner-default',
  personId: 'owner',
  /** 队列有界参数。 */
  queue: { maxBufferedLines: 2000, maxFileBytes: 2 * 1024 * 1024, maxSegments: 4 },
  /** 账本/槽位上限。 */
  ledgerLimit: 512,
  slotLimit: 32,
  /** automatic 模式下 await 构包的超时（毫秒）。超时即弃答，不拖住 step。 */
  buildTimeoutMs: 800,
  /** automatic 模式的自构包函数（context2 接上后注入）。签名见 docs/M2-INTERFACES.md §2。 */
  buildPackage: null,
  /**
   * 主账门面（`openBrain()` 的返回，可选）。
   * attached/sent 两级的证据就是靠它的 `store.contextPackages.updateStatus` 落库的；
   * 没有它（或它还没实现这个门面）时一切照旧，只是检查器查不到证据。
   */
  store: null,
  /**
   * 主账库路径（可选）。给了就由连接器自己 `openBrain()` —— 让 profile patch 只写一行路径，
   * 不用在 YAML 里写 JS 表达式。任何一步失败都只降级成 warning（旁路，不许拖垮宿主）。
   */
  storePath: '',
  /** migrations 目录（配合 storePath；缺省用 memory 包的默认值）。 */
  migrationsDir: '',
  /** memory 包说明符：包名或 `file:///...` URL（未 link 的 workspace 包用后者）。 */
  memoryModule: '@dsh-brain/memory',
  /** context 包说明符（同上）。 */
  contextModule: '@dsh-brain/context',
  /** automatic 模式的构包预算入参（M2-INTERFACES §2 的 budget）。 */
  budget: { modelWindow: 128000, hostInputTokens: 4000, outputReserve: 2000, brainCap: 2048 },
  /** 有 store 时是否自动用 `context.build()` 构包（automatic 模式）。 */
  autoBuild: true,
  /** 日志级别：info | warn | silent */
  logLevel: 'info',
}

/**
 * 插件入口。
 * @param {any} ctx cordis 上下文
 * @param {Partial<typeof DEFAULT_CONFIG>} [config]
 * @returns {ConnectorRuntime}
 */
export function apply(ctx, config = {}) {
  const merged = mergeConfig(config)
  const runtime = createRuntime(ctx, merged)
  runtime.log('info', `boot mode=${merged.mode} dir=${merged.dir} channel=${merged.injectChannel}`)
  if (merged.mode === 'off') {
    runtime.log('info', 'mode=off：不注册任何 hook')
    return runtime
  }
  registerHooks(ctx, runtime, merged)
  return runtime
}

/**
 * @typedef {ReturnType<typeof createRuntime>} ConnectorRuntime
 */

/**
 * @param {Partial<typeof DEFAULT_CONFIG>} config
 */
function mergeConfig(config) {
  const merged = { ...DEFAULT_CONFIG, ...(config ?? {}) }
  merged.queue = { ...DEFAULT_CONFIG.queue, ...(config?.queue ?? {}) }
  if (!MODES.includes(merged.mode)) {
    // 非法模式降级为 shadow 而不是抛 —— 加载期也不抛（宿主只给 warning，但宁可自己兜住）
    merged.mode = 'shadow'
  }
  if (!CHANNELS.includes(merged.injectChannel)) merged.injectChannel = CHANNEL_CONTEXTS
  return merged
}

/**
 * 构造运行时骨架（也被测试直接使用）。
 * @param {any} ctx
 * @param {typeof DEFAULT_CONFIG} config
 */
function createRuntime(ctx, config) {
  /** @type {Array<{hook: string, phase: string, message: string, at: string, meta?: Record<string, unknown>}>} */
  const errors = []
  /** @type {Array<Record<string, unknown>>} */
  const traces = []
  /** @type {Set<string>} */
  const seenEvents = new Set()
  /** @type {Set<string>} */
  const sentContexts = new Set()
  /** @type {Map<string, {text: string, turn: number|null, step: number|null, at: number}>} */
  const queryCache = new Map()
  /** @type {Map<string, {turn: number|null, step: number|null}>} */
  const stepCursor = new Map()

  const stats = {
    mode: config.mode,
    assembleCalls: 0,
    preStepCalls: 0,
    streamCalls: 0,
    sessionEvents: 0,
    turnStoppingCalls: 0,
    mainRequests: 0,
    bypassRequests: 0,
    packagesBuilt: 0,
    packagesMissing: 0,
    injectedContexts: 0,
    injectedMessages: 0,
    skippedDuplicate: 0,
    skippedIncompleteKey: 0,
    skippedEmptyPackage: 0,
    attachedUnconfirmed: 0,
    sentConfirmed: 0,
    humanMessages: 0,
    selfInjectedMessages: 0,
    siblingInjectedMessages: 0,
    contextSnapshotMessages: 0,
    errors: 0,
    queueDropped: 0,
    queueWriteFailures: 0,
  }

  const queue = new BoundedEventQueue({
    ...config.queue,
    dir: config.dir,
    onError: (message) => {
      stats.queueWriteFailures += 1
      log('warn', `queue: ${message}`)
    },
  })

  const ledger = new StepLedger({ limit: config.ledgerLimit })
  const slots = new PackageSlots({ limit: config.slotLimit })

  // attached / sent 两级的证据落库器。store 缺门面时它自己跳过，我们只管调。
  // 旁路里的旁路：这里任何失败都只回 outcome，绝不向上抛（契约 10.2）。
  const evidence = createEvidenceSink({
    store: config.store,
    log: (level, message) => log(level, message),
    onRecord: (record, action) => {
      queue.append({
        record_kind: 'context_evidence',
        event_type: action === 'attach' ? 'context/attached' : 'context/sent',
        status: record.status,
        context_id: record.contextId,
        carrier: record.carrier,
        evidence_level: action === 'attach' ? record.attached.level : record.sent.level,
        // 恒 false：请求对象命中 ≠ 字节出网（契约 10.4）。
        proves_wire_delivery: false,
        observed_hash_locations: action === 'attach' ? record.attached.locations : record.sent.locations,
        store_facade: evidence.facadeKind(),
        at: new Date().toISOString(),
      })
    },
  })

  /**
   * 主账的惰性初始化：第一次真正要构包 / 落证据时才 `openBrain()`。
   *
   * 为什么惰性而不是 apply 时就打开：加载期不能因为主账打不开影响宿主（M0 §3 实测
   * 加载期失败只降级 warning），而 openBrain() 会跑迁移、建写队列，代价不该摊在插件加载上。
   * 为什么全 catch：这是旁路，任何失败都只让「检查器查不到证据」，绝不影响对话（契约 10.2）。
   *
   * @type {Promise<unknown|null> | null}
   */
  let storePromise = null
  /** @type {{ status: 'injected'|'not-configured'|'ready'|'failed', reason: string|null, dbPath: string|null }} */
  let storeInfo = {
    status: config.store !== null && config.store !== undefined ? 'injected' : 'not-configured',
    reason: null,
    dbPath: null,
  }

  /**
   * @returns {Promise<unknown|null>}
   */
  function ensureStore() {
    if (config.store !== null && config.store !== undefined) return Promise.resolve(config.store)
    if (typeof config.storePath !== 'string' || config.storePath.length === 0) return Promise.resolve(null)
    if (storePromise === null) storePromise = openStore()
    return storePromise
  }

  /**
   * @returns {Promise<unknown|null>}
   */
  async function openStore() {
    try {
      const memoryModule = await import(config.memoryModule)
      if (typeof memoryModule.openBrain !== 'function') {
        storeInfo = { status: 'failed', reason: 'openBrain_not_exported', dbPath: config.storePath }
        log('warn', '主账未打开：memory 模块没有导出 openBrain')
        return null
      }
      const store = memoryModule.openBrain({
        dbPath: config.storePath,
        ...(typeof config.migrationsDir === 'string' && config.migrationsDir.length > 0
          ? { migrationsDir: config.migrationsDir }
          : {}),
      })
      evidence.setStore(store)
      storeInfo = { status: 'ready', reason: null, dbPath: config.storePath }
      log('info', `主账已打开：${config.storePath}`)
      return store
    } catch (error) {
      const reason = describeError(error)
      storeInfo = { status: 'failed', reason, dbPath: config.storePath }
      log('warn', `主账打开失败（降级为不落库，不影响宿主）：${reason}`)
      return null
    }
  }

  /**
   * @param {'info'|'warn'|'error'} level
   * @param {string} message
   */
  function log(level, message) {
    if (config.logLevel === 'silent') return
    const line = `[brain-connector] ${message}`
    try {
      const logger = ctx?.logger
      if (level === 'info') {
        if (typeof logger?.info === 'function') logger.info(line)
        else if (config.logLevel !== 'silent') console.log(line)
      } else {
        if (typeof logger?.warn === 'function') logger.warn(line)
        else console.error(line)
      }
    } catch {
      /* 日志口自己崩了也不能抛 */
    }
  }

  /**
   * 记一条诊断 trace（内存 + 队列）。绝不抛。
   * @param {string} hook
   * @param {Record<string, unknown>} meta
   */
  function trace(hook, meta) {
    const line = { record_kind: 'hook_trace', hook, at: new Date().toISOString(), ...meta }
    traces.push(line)
    if (traces.length > 200) traces.shift()
    queue.append(line)
  }

  /**
   * 记一条错误（内存 + 队列 + 日志）。绝不抛。
   * 落过账的 error 会打标记，这样最外层的 guard 不会重复记第二遍
   * （同一个错误记两次会让「零抛出」的验收统计失真）。
   * @param {string} hook
   * @param {string} phase
   * @param {unknown} error
   * @param {Record<string, unknown>} [meta]
   */
  function report(hook, phase, error, meta) {
    stats.errors += 1
    const message = describeError(error)
    errors.push({ hook, phase, message, at: new Date().toISOString(), meta })
    if (errors.length > 32) errors.shift()
    queue.append({
      record_kind: 'hook_error',
      hook,
      phase,
      message,
      at: new Date().toISOString(),
      ...(meta ?? {}),
    })
    log('error', `${hook} ${phase} failed (contained): ${message}`)
    markReported(error)
  }

  const runtime = {
    name,
    mode: config.mode,
    dir: config.dir,
    stats,
    ledger,
    slots,
    queue,
    traces,
    errors,
    /**
     * 递一个包给 explicit 模式（控制台 / server / 测试用）。
     * @param {Record<string, any>} pkg
     * @param {{ sessionId?: string|null, turn?: number|null, step?: number|null }} [target]
     */
    supply(pkg, target = {}) {
      const slot = slots.supply(pkg, target)
      // 读 contextId 只用于诊断 —— 但 package 可能是坏对象（Proxy / 抛错 getter），
      // 所以这行必须自己兜住：supply 是外部调用口，同样不许抛。
      let contextId = '<unreadable>'
      try {
        contextId = String(pkg?.contextId ?? '')
      } catch {
        /* 保持 <unreadable> */
      }
      trace('runtime.supply', { slot: slot.id, contextId })
      return slot
    },
    /** 尽力把缓冲落盘。 */
    flush() {
      return queue.flush()
    },
    /**
     * 等所有证据落库的旁路写完成（测试 / 冒烟用；运行期不需要等）。
     * @returns {Promise<void>}
     */
    flushEvidence() {
      return evidence.settled()
    },
    /** attached/sent 证据落库器（诊断与冒烟用）。 */
    evidence,
    /** 惰性打开主账（automatic 构包与证据落库共用；测试/冒烟可直接 await）。 */
    ensureStore,
    /** 主账状态（诊断用）。 */
    storeInfo() {
      return { ...storeInfo }
    },
    /** 卸载收尾：flush 一次并清空。 */
    close() {
      try {
        queue.close()
      } catch {
        /* 收尾期不抛 */
      }
    },
    /** 诊断快照（给检查器/冒烟脚本；不含正文）。 */
    diagnostics() {
      return {
        mode: config.mode,
        dir: config.dir,
        injectChannel: config.injectChannel,
        stats: { ...stats },
        ledgerSize: ledger.size,
        slotCount: slots.size,
        queue: queue.stats(),
        queueErrors: queue.recentErrors(),
        store: { ...storeInfo },
        evidence: {
          facade: evidence.facadeKind(),
          counts: evidence.counts(),
          records: evidence.all().map((record) => ({
            contextId: record.contextId,
            status: record.status,
            carrier: record.carrier,
            attachedAt: record.attached.at || null,
            sentAt: record.sent.at || null,
            sentLocations: record.sent.locations,
          })),
        },
        errors: errors.slice(-10),
        recentTraces: traces.slice(-20),
      }
    },
    /** @param {'info'|'warn'|'error'} level @param {string} message */
    log,
    trace,
    report,
    /** @internal 供 hook 使用 */
    _config: config,
    _seenEvents: seenEvents,
    _sentContexts: sentContexts,
    _queryCache: queryCache,
    _stepCursor: stepCursor,
  }

  return runtime
}

/**
 * 已落过账的错误打标记，避免最外层 guard 重复记第二遍。
 */
const REPORTED = Symbol.for('dsh-brain.connector.reported')

/**
 * @param {unknown} error
 * @returns {unknown}
 */
function markReported(error) {
  try {
    if (error !== null && typeof error === 'object') /** @type {any} */ (error)[REPORTED] = true
  } catch {
    /* 冻结对象 / Proxy：打不上标记就算了，代价只是可能多记一遍 */
  }
  return error
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isReported(error) {
  try {
    return error !== null && typeof error === 'object' && /** @type {any} */ (error)[REPORTED] === true
  } catch {
    return false
  }
}

/**
 * 挂五个钩子。每个钩子体内部自带 try/catch，注册动作本身包一层。
 * @param {any} ctx
 * @param {ConnectorRuntime} runtime
 * @param {typeof DEFAULT_CONFIG} config
 */
function registerHooks(ctx, runtime, config) {
  const guard = (/** @type {string} */ hookName, /** @type {(...args: any[]) => any} */ callback) => {
    return (/** @type {any[]} */ ...args) => {
      /** 下游结果的兜底取法：最后一个参数如果是函数，就是 waterfall 的 next */
      const fallback = () => {
        const last = args[args.length - 1]
        try {
          return typeof last === 'function' ? last() : undefined
        } catch {
          return undefined
        }
      }
      try {
        const result = callback(...args)
        if (result !== null && typeof result === 'object' && typeof result.then === 'function') {
          return result.catch((error) => {
            // handler 内部已经识别并透传的宿主错误 → 继续透传，不重复记账、不降级
            if (isReported(error)) throw error
            // 漏网错误（handler 有 bug）→ 记一次，然后降级成宿主原本的结果，宁可不注入也不污染回合
            runtime.report(hookName, 'unhandled', error)
            return fallback()
          })
        }
        return result
      } catch (error) {
        if (isReported(error)) throw error
        runtime.report(hookName, 'sync-throw', error)
        return fallback()
      }
    }
  }

  try {
    ctx.on(
      'system-prompt/assemble',
      guard('system-prompt/assemble', (assembly, context, next) => handleAssemble(runtime, config, assembly, context, next)),
    )
    ctx.on(
      'agent/pre-step',
      guard('agent/pre-step', (payload, next) => handlePreStep(runtime, config, payload, next)),
    )
    ctx.on(
      'llm/stream',
      guard('llm/stream', (options, next) => handleStream(runtime, config, options, next)),
    )
    ctx.on(
      'session/event',
      guard('session/event', (session, event) => handleSessionEvent(runtime, config, session, event)),
    )
    // ⚠️ agent/turn-stopping 是 **serial** 分发（宿主用 dispatch.serial），监听器没有 next。
    // M0 实测：把它写成 waterfall 签名（多写一个 next 参数）→ turn/end reason=error + 退出码 1。
    ctx.on(
      'agent/turn-stopping',
      guard('agent/turn-stopping', (payload) => handleTurnStopping(runtime, config, payload)),
    )
    runtime.log('info', 'hooks registered: assemble / pre-step / llm.stream / session.event / turn-stopping(serial)')
  } catch (error) {
    runtime.report('register', 'mount', error)
  }
}

/**
 * `system-prompt/assemble` waterfall。
 *
 * 形状（实测）：`(assembly, context, next) => Promise<PromptAssembly>`。
 * `context` 的类型声明只有 `{scope, signal}`，但运行时实际带 `agent`
 * （`assembleContextFor(agent, signal)` 返回 `{agent, scope: agent, signal}`）——
 * 这是拿 sessionId 的唯一途径，所以按「有就用、没有就失败关闭」读。
 *
 * @param {ConnectorRuntime} runtime
 * @param {typeof DEFAULT_CONFIG} config
 * @param {any} assembly
 * @param {any} context
 * @param {() => Promise<any>} next
 * @returns {Promise<any>}
 */
async function handleAssemble(runtime, config, assembly, context, next) {
  runtime.stats.assembleCalls += 1
  let out
  try {
    out = await next()
  } catch (error) {
    // 下游错误必须原样透传：吞掉会改变宿主行为（例如 abort / 装配失败）。
    runtime.report('system-prompt/assemble', 'next', error)
    throw error
  }
  try {
    const key = resolveStepKey({ agent: context?.agent })
    const described = {
      stepKey: key.key,
      complete: key.complete,
      reason: key.reason,
      sectionCount: Array.isArray(out?.sections) ? out.sections.length : -1,
      contextCount: Array.isArray(out?.contexts) ? out.contexts.length : -1,
      contextNames: Array.isArray(out?.contexts)
        ? out.contexts.map((entry) => (typeof entry?.name === 'string' ? entry.name : '')).filter(Boolean).slice(0, 12)
        : [],
      toolCount: Array.isArray(out?.tools) ? out.tools.length : -1,
      carriedIn: typeof context?.agent === 'object' && context?.agent !== null ? 'agent' : 'no-agent',
    }
    if (!key.complete) {
      runtime.stats.skippedIncompleteKey += 1
      runtime.trace('assemble.skip', { ...described, why: 'incomplete step key' })
      return out
    }
    // 只声明了单一注入通道：另一条通道整体不启用，从设计上排除「同一 step 双注入」。
    if (config.injectChannel !== CHANNEL_CONTEXTS) {
      runtime.trace('assemble.observe', { ...described, injectChannel: config.injectChannel })
      return out
    }
    const outcome = await maybeInject(runtime, config, {
      tracePrefix: 'assemble',
      channel: CHANNEL_CONTEXTS,
      key,
      source: out,
      described,
    })
    return outcome ?? out
  } catch (error) {
    // 我们自己的加工失败 → 返回宿主原本的装配结果，绝不把异常抛给宿主。
    runtime.report('system-prompt/assemble', 'process', error)
    return out
  }
}

/**
 * `agent/pre-step` waterfall。
 *
 * 形状（实测）：`(payload, next) => Promise<PreStepDecision>`；
 * payload = `{messages, turn, step, signal, agent}`（`agent` 由 agentEvents 的 fused 注入）。
 * decision 可能是 `{kind:'reject', reason}` —— 必须原样返回，不能包装成别的形状。
 *
 * @param {ConnectorRuntime} runtime
 * @param {typeof DEFAULT_CONFIG} config
 * @param {any} payload
 * @param {() => Promise<any>} next
 * @returns {Promise<any>}
 */
async function handlePreStep(runtime, config, payload, next) {
  runtime.stats.preStepCalls += 1
  let decision
  try {
    decision = await next()
  } catch (error) {
    runtime.report('agent/pre-step', 'next', error)
    throw error
  }
  try {
    const key = resolveStepKey({ agent: payload?.agent, turn: payload?.turn, step: payload?.step })
    const described = {
      stepKey: key.key,
      complete: key.complete,
      turn: key.turn,
      step: key.step,
      kind: typeof decision?.kind === 'string' ? decision.kind : 'unknown',
      messages: Array.isArray(decision?.messages) ? decision.messages.length : -1,
    }
    if (decision?.kind === 'reject') {
      runtime.trace('pre-step.reject', described)
      return decision
    }
    if (!key.complete) {
      runtime.stats.skippedIncompleteKey += 1
      runtime.trace('pre-step.skip', { ...described, why: 'incomplete step key' })
      return decision
    }
    if (config.injectChannel !== CHANNEL_PRESTEP) {
      runtime.trace('pre-step.observe', { ...described, injectChannel: config.injectChannel })
      return decision
    }
    const outcome = await maybeInject(runtime, config, {
      tracePrefix: 'pre-step',
      channel: CHANNEL_PRESTEP,
      key,
      source: decision,
      described,
      // pre-step 是本轮**唯一**能稳定拿到用户 query 的时刻：assemble 早于
      // `session.append('user/message')`，而 pre-step 的 payload.messages 已经带上了
      // 本轮 claim 到的消息。所以这条通道能让第一个 step 也构出包来。
      query: lastHumanText(payload?.messages),
    })
    return outcome ?? decision
  } catch (error) {
    runtime.report('agent/pre-step', 'process', error)
    return decision
  }
}

/**
 * 取包 + 判幂等 + 注入。三条通道共用。
 *
 * @param {ConnectorRuntime} runtime
 * @param {typeof DEFAULT_CONFIG} config
 * @param {{ tracePrefix: 'assemble'|'pre-step', channel: string, key: ReturnType<typeof resolveStepKey>, source: any, described: Record<string, unknown>, query?: string }} input
 * @returns {Promise<any>} 新的 assembly / decision；不注入时返回 null
 */
async function maybeInject(runtime, config, input) {
  const { tracePrefix, channel, key, source, described } = input
  if (runtime.ledger.has(key.key)) {
    // 幂等第一道闸：同一 (session,turn,step) 已经注入过，不再重复。
    runtime.stats.skippedDuplicate += 1
    const existing = runtime.ledger.get(key.key)
    runtime.trace(tracePrefix + '.inject.duplicate', {
      ...described,
      channel,
      existingChannel: existing?.channel ?? null,
      existingContextId: existing?.contextId ?? null,
    })
    return null
  }

  const resolved = await obtainPackage(runtime, config, key, input.query)
  if (resolved === null) {
    runtime.stats.packagesMissing += 1
    runtime.trace(tracePrefix + '.inject.no-package', { ...described, channel, mode: config.mode })
    return null
  }
  if (!resolved.ok) {
    runtime.stats.skippedEmptyPackage += 1
    runtime.trace(tracePrefix + '.inject.bad-package', {
      ...described,
      channel,
      issues: resolved.issues,
      contextId: String(resolved.pkg?.contextId ?? ''),
    })
    return null
  }

  const pkg = resolved.pkg
  const contextId = String(pkg.contextId)

  // shadow 模式：算到底但不挂（只算不注入），指标一样记，便于灰度对比。
  if (!isInjectingMode(config.mode)) {
    const entry = channel === CHANNEL_CONTEXTS
      ? buildContextEntry(pkg, { maxChars: config.maxInjectChars })
      : buildUserMessage(pkg, { maxChars: config.maxInjectChars })
    if (entry === null) {
      runtime.stats.skippedEmptyPackage += 1
      runtime.trace(tracePrefix + '.inject.shadow-empty', { ...described, channel, contextId })
      return null
    }
    const text = 'text' in entry ? String(entry.text) : ''
    runtime.trace(tracePrefix + '.inject.shadow', {
      ...described,
      channel,
      contextId,
      wouldInject: true,
      textLen: text.length,
      estimatedTokens: estimateTokens(text),
      originSystem: ORIGIN_SYSTEM,
    })
    return null // shadow：绝不改宿主对象
  }

  if (channel === CHANNEL_CONTEXTS) {
    const entry = buildContextEntry(pkg, { maxChars: config.maxInjectChars })
    if (entry === null) {
      runtime.stats.skippedEmptyPackage += 1
      runtime.trace(tracePrefix + '.inject.empty', { ...described, channel, contextId })
      return null
    }
    const contexts = Array.isArray(source?.contexts) ? source.contexts : []
    // 铁律 5：复制后追加，绝不 push 到宿主数组里。
    const nextAssembly = { ...source, contexts: [...contexts, entry] }
    runtime.ledger.mark(key.key, {
      channel,
      contextId,
      canonicalHash: typeof pkg.canonicalHash === 'string' ? pkg.canonicalHash : null,
      sessionId: String(key.sessionId),
      turn: Number(key.turn),
      step: Number(key.step),
    })
    runtime.stats.injectedContexts += 1
    // attached 级证据：宿主已把片段挂到这次装配结果上。
    // carrier 如实写 user 消息 —— M0 实测 `assembly.contexts` 会物化成 durable user-role snapshot
    // （`M0-probe-report.md` §2 Q2），既不是 system 也不是 messages[role=system]。
    // 旁路写、不等它：落库失败由 evidence 内部消化，绝不影响这一轮（契约 10.2）。
    void runtime.evidence.attached({
      contextId,
      channel,
      carrier: CARRIER.USER_MESSAGE,
      turn: key.turn,
      step: key.step,
      sessionId: key.sessionId,
    })
    runtime.queue.append({
      record_kind: 'context_attached',
      event_type: 'context/attached',
      context_id: contextId,
      channel,
      carrier: CARRIER.USER_MESSAGE,
      session_id: key.sessionId,
      turn_id: key.turn,
      step_id: key.step,
      text_len: entry.text.length,
      estimated_tokens: estimateTokens(entry.text),
      origin_system: ORIGIN_SYSTEM,
      producer: PRODUCER,
      policy_version: typeof pkg.policyVersion === 'string' ? pkg.policyVersion : null,
      canonical_hash: typeof pkg.canonicalHash === 'string' ? pkg.canonicalHash : null,
      at: new Date().toISOString(),
    })
    runtime.trace(tracePrefix + '.inject.contexts', {
      ...described,
      contextId,
      textLen: entry.text.length,
      estimatedTokens: estimateTokens(entry.text),
      contextsBefore: contexts.length,
      contextsAfter: nextAssembly.contexts.length,
      mutatedHostArray: false,
    })
    return nextAssembly
  }

  // pre-step 通道
  const message = buildUserMessage(pkg, { maxChars: config.maxInjectChars })
  if (message === null) {
    runtime.stats.skippedEmptyPackage += 1
    runtime.trace(tracePrefix + '.inject.empty', { ...described, channel, contextId })
    return null
  }
  const messages = Array.isArray(source?.messages) ? source.messages : []
  // 铁律 5 + 保留 decision 的其它字段（kind / startsRequestSeries …）
  const nextDecision = { ...source, messages: [...messages, message] }
  runtime.ledger.mark(key.key, {
    channel,
    contextId,
    canonicalHash: typeof pkg.canonicalHash === 'string' ? pkg.canonicalHash : null,
    sessionId: String(key.sessionId),
    turn: Number(key.turn),
    step: Number(key.step),
  })
  runtime.stats.injectedMessages += 1
  // attached 级证据：pre-step 追加的消息同样落在 user 角色（M0 Q2 实测）。
  void runtime.evidence.attached({
    contextId,
    channel,
    carrier: CARRIER.USER_MESSAGE,
    turn: key.turn,
    step: key.step,
    sessionId: key.sessionId,
  })
  runtime.queue.append({
    record_kind: 'context_attached',
    event_type: 'context/attached',
    context_id: contextId,
    channel,
    carrier: CARRIER.USER_MESSAGE,
    session_id: key.sessionId,
    turn_id: key.turn,
    step_id: key.step,
    text_len: message.content[0].text.length,
    estimated_tokens: estimateTokens(message.content[0].text),
    origin_system: ORIGIN_SYSTEM,
    producer: PRODUCER,
    at: new Date().toISOString(),
  })
  runtime.trace(tracePrefix + '.inject.pre-step', {
    ...described,
    contextId,
    messagesBefore: messages.length,
    messagesAfter: nextDecision.messages.length,
    mutatedHostArray: false,
  })
  return nextDecision
}

/**
 * 取这一 step 要注入的包。三条来源，优先级从明确到自动：
 *   1. explicit / shadow：别人 `supply()` 递过来的包（按 session/turn/step 匹配）
 *      —— shadow 用 peek 不消费（只算不注入，不能把包吃掉）
 *   2. automatic / shadow：配置的 `buildPackage()`（带超时，超时即弃答）
 *   3. automatic / shadow：`autoBuild` 打开且主账可开 → 直接调 `@dsh-brain/context` 的 `build()`
 *      （这是真机端到端要跑的那条路：真 store + 真检索 + 真构包）
 *
 * shadow 下若能构包也会调：灰度阶段要看的就是「如果开了会注入什么」。
 * 代价是每次 step 多一次构包开销，所以 shadow 部署时请别挂真构包器。
 *
 * @param {ConnectorRuntime} runtime
 * @param {typeof DEFAULT_CONFIG} config
 * @param {ReturnType<typeof resolveStepKey>} key
 * @param {string} [queryOverride] pre-step 通道能直接从 payload.messages 读到本轮用户话，
 *   优先用它；assemble 通道只能用 queryCache（真机上第一个 step 还拿不到）。
 * @returns {Promise<{ ok: boolean, issues: string[], pkg: Record<string, any> | null } | null>}
 */
async function obtainPackage(runtime, config, key, queryOverride) {
  const target = { sessionId: key.sessionId, turn: key.turn, step: key.step }
  const consume = isInjectingMode(config.mode)
  const supplied = consume ? runtime.slots.take(target) : runtime.slots.peek(target)
  if (supplied !== null) {
    runtime.stats.packagesBuilt += 1
    return normalizeSafe(supplied.pkg)
  }
  if (config.mode !== 'automatic' && config.mode !== 'shadow') return null
  const cachedQuery = runtime._queryCache.get(String(key.sessionId))?.text ?? ''
  const query = typeof queryOverride === 'string' && queryOverride.length > 0 ? queryOverride : cachedQuery
  const buildInput = {
    sessionId: key.sessionId,
    turnId: key.turn,
    stepId: key.step,
    scopeId: config.scopeId,
    personId: config.personId,
    query,
  }
  try {
    // 路径 2：外部注入的构包函数
    if (typeof config.buildPackage === 'function') {
      const built = await withTimeout(
        Promise.resolve(config.buildPackage(buildInput)),
        config.buildTimeoutMs,
        'buildPackage',
      )
      if (built === null || built === undefined) return null
      runtime.stats.packagesBuilt += 1
      return normalizeSafe(built)
    }
    // 路径 3：自己开主账 + 调 context.build()
    if (config.autoBuild !== true) return null
    // query 为空就别构包了。真机实测（e2e）：第一个 step 的 `system-prompt/assemble`
    // 发生在 `session.append('user/message')` **之前**（宿主 turn() → preStep() → step()），
    // 所以那一步的 queryCache 还是空的。空 query 构出来必然是不相关空包，
    // 既浪费一次检索，又在主账里堆一行没用的 built。跳过并留 trace。
    if (query.length === 0) {
      runtime.trace('auto-build.skip', {
        stepKey: key.key,
        why: 'empty query（第一个 step 早于 user/message commit）',
      })
      return null
    }
    const store = await runtime.ensureStore()
    if (store === null) {
      runtime.trace('auto-build.skip', { stepKey: key.key, why: 'no store' })
      return null
    }
    const contextModule = await import(config.contextModule)
    if (typeof contextModule.build !== 'function') {
      runtime.report('automatic', 'build', new Error(`context 模块 ${String(config.contextModule)} 没有导出 build`), {
        stepKey: key.key,
      })
      return null
    }
    const built = await withTimeout(
      Promise.resolve(contextModule.build({ store, ...buildInput, budget: config.budget })),
      config.buildTimeoutMs,
      'context.build',
    )
    if (built === null || built === undefined) return null
    runtime.stats.packagesBuilt += 1
    return normalizeSafe(built)
  } catch (error) {
    runtime.report('automatic', 'build', error, { stepKey: key.key })
    return null
  }
}

/**
 * 包一层，防 normalizePackage 被畸形对象（Proxy / 抛错 getter）搞出异常。
 * @param {unknown} pkg
 */
function normalizeSafe(pkg) {
  try {
    return normalizePackage(pkg)
  } catch (error) {
    return { ok: false, issues: [`normalize failed: ${describeError(error)}`], pkg: null }
  }
}

/**
 * `llm/stream` waterfall。**只观测，绝不改写**。
 *
 * 形状（实测）：`(options, next) => AsyncIterable<StreamChunk>`；`next()` 返回
 * AsyncIterable，不是 Promise —— 所以这里同步透传，绝不 `await` 它的结果再包一层，
 * 否则会把流变成 Promise 而破坏宿主。
 *
 * @param {ConnectorRuntime} runtime
 * @param {typeof DEFAULT_CONFIG} config
 * @param {any} options
 * @param {() => any} next
 * @returns {any}
 */
function handleStream(runtime, config, options, next) {
  runtime.stats.streamCalls += 1
  try {
    observeRequest(runtime, config, options)
  } catch (error) {
    runtime.report('llm/stream', 'observe', error)
  }
  // 透传。next() 自己的错误照常抛给宿主（我们不改写请求，也就没有资格吞它的错）。
  return next()
}

/**
 * sent 判据：最终请求对象里是否含这个包的可检索标识。
 *
 * 三级承载都查（契约 10.9 的两级 + 非 system 消息，覆盖 contexts / pre-step 两个通道）。
 * 针按优先级：`canonicalHash`（context2 的注入文本自带，覆盖内容）→ `contextId`（兜底）。
 *
 * 命中之后两件事：写自己的队列账（`context_sent`），并把 sent 证据推进主账
 * （`store.contextPackages.updateStatus`，可选 + 不抛）。
 *
 * @param {ConnectorRuntime} runtime
 * @param {typeof DEFAULT_CONFIG} config
 * @param {any} options
 */
function observeRequest(runtime, config, options) {
  const described = describeRequest(options)
  const main = isMainRequest(options)
  if (main) runtime.stats.mainRequests += 1
  else runtime.stats.bypassRequests += 1

  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : null
  const candidates = sessionId !== null ? runtime.ledger.forSession(sessionId) : runtime.ledger.recent(4)

  /** @type {string[]} */
  const confirmed = []
  /** @type {string[]} */
  const unconfirmed = []
  for (const entry of candidates) {
    if (runtime._sentContexts.has(entry.contextId)) continue
    const verdict = checkSentAny(options, [entry.canonicalHash, entry.contextId])
    if (verdict.hit) {
      runtime._sentContexts.add(entry.contextId)
      confirmed.push(`${entry.contextId}@${verdict.matchedIn.join('+')}`)
      runtime.stats.sentConfirmed += 1
      // sent 级证据推进主账：carrier 用**实际观测到**的命中位置（不是声明值）。
      // 旁路写、不等它；没有 store.contextPackages 时它自己跳过。
      void runtime.evidence.sent({
        contextId: entry.contextId,
        matchedIn: verdict.matchedIn,
        needle: verdict.needle,
        purpose: described.purpose,
      })
      runtime.queue.append({
        record_kind: 'context_sent',
        event_type: 'context/sent',
        context_id: entry.contextId,
        session_id: entry.sessionId,
        turn_id: entry.turn,
        step_id: entry.step,
        channel: entry.channel,
        purpose: described.purpose,
        matched_in: verdict.matchedIn,
        carriers_checked: verdict.carriersChecked,
        needle: verdict.needle,
        system_prompt_carried_in: described.systemPromptCarriedIn,
        // 诚实边界：这层证据只到「宿主决定发这些内容」，不证明字节出网（契约 10.4）。
        evidence_level: 'sent:request-object',
        proves_wire_delivery: false,
        at: new Date().toISOString(),
      })
    } else {
      unconfirmed.push(entry.contextId)
    }
  }
  if (unconfirmed.length > 0) runtime.stats.attachedUnconfirmed += unconfirmed.length

  runtime.trace('llm.stream', {
    ...described,
    sessionId,
    confirmed,
    unconfirmed: unconfirmed.slice(0, 4),
    counted: main ? 'main' : 'bypass',
  })
}

/**
 * `session/event` emit 监听 —— 摄取到有界持久队列。
 *
 * 关键纪律：
 *   - 宿主是 fire-and-forget 的 post-commit feed，**不保证落盘**、可能重投；
 *     我们自己按 `sessionId#seq` 幂等，并自持久入队（契约 10.1/§3）。
 *   - 注入内容的二次沉淀在这里被拦住（契约 10.6）：user 角色消息先分类，
 *     `self_injected` / `sibling_injected` 绝不当人类证据落进 human 通道。
 *
 * @param {ConnectorRuntime} runtime
 * @param {typeof DEFAULT_CONFIG} config
 * @param {any} session
 * @param {any} event
 */
function handleSessionEvent(runtime, config, session, event) {
  runtime.stats.sessionEvents += 1
  const sessionId = typeof session?.id === 'string' ? session.id : null
  const eventType = typeof event?.type === 'string' ? event.type : 'unknown'
  const seq = typeof event?.seq === 'number' ? event.seq : null
  const dedupeKey = `${sessionId ?? 'no-session'}#${seq ?? 'no-seq'}`
  if (runtime._seenEvents.has(dedupeKey)) {
    runtime.trace('event.duplicate', { sessionId, eventType, seq })
    return
  }
  runtime._seenEvents.add(dedupeKey)
  if (runtime._seenEvents.size > 4096) {
    // 有界：Set 按插入序驱逐最老
    const oldest = runtime._seenEvents.values().next()
    if (oldest.done !== true) runtime._seenEvents.delete(oldest.value)
  }

  const data = event?.data !== undefined && event?.data !== null && typeof event.data === 'object' ? event.data : {}
  const turn = numberOrNull(data.turn) ?? cursorOf(runtime, sessionId).turn
  const step = numberOrNull(data.step) ?? cursorOf(runtime, sessionId).step
  if (sessionId !== null) {
    const cursor = cursorOf(runtime, sessionId)
    if (eventType === 'turn/start') runtime._stepCursor.set(sessionId, { turn, step: null })
    else if (eventType === 'step/start') runtime._stepCursor.set(sessionId, { turn, step })
    else if (eventType === 'turn/end' || eventType === 'session/disposed') runtime._stepCursor.delete(sessionId)
    else if (cursor.turn === null && turn !== null) runtime._stepCursor.set(sessionId, { turn, step })
  }

  /** @type {Record<string, unknown>} */
  const envelope = {
    record_kind: 'event',
    schema_version: 1,
    event_id: `dsh:${sessionId ?? 'no-session'}:${seq ?? 'no-seq'}`,
    source_system: 'dsh',
    source_event_id: seq === null ? null : String(seq),
    scope_id: config.scopeId,
    person_id: config.personId,
    session_id: sessionId,
    turn_id: turn,
    step_id: step,
    source_seq: seq,
    occurred_at: typeof event?.time === 'number' ? new Date(event.time).toISOString() : new Date().toISOString(),
    received_at: new Date().toISOString(),
    event_type: eventType,
    origin_system: 'human',
    ingest_class: 'not-a-message',
    causation_id: null,
    derived_from: Array.isArray(event?.sourceEventSeqs) ? [...event.sourceEventSeqs] : [],
    surface_op: typeof event?.surfaceOp === 'string' ? event.surfaceOp : null,
    payload_hash: null,
    payload_text: null,
    privacy: 'private',
    meta: {},
  }

  // 消息类事件：分类 + 摘要。正文只对消息类型落盘。
  if (eventType === 'user/message' || eventType === 'system/message' || eventType === 'assistant/message' || eventType === 'developer/message') {
    const frame = extractFrame(data)
    const classification = eventType === 'user/message'
      ? classifyUserFrame(frame)
      : {
          ingestClass: eventType === 'system/message' ? 'context_snapshot' : 'not-a-message',
          originSystem: eventType === 'system/message' ? 'source:system-prompt' : eventType === 'assistant/message' ? 'model' : 'unknown',
          reason: `non-user message event (${eventType})`,
        }
    envelope.origin_system = classification.originSystem
    envelope.ingest_class = classification.ingestClass
    envelope.payload_hash = frame.text.length > 0 ? shortHash(frame.text) : null
    if (config.captureText && frame.text.length > 0) {
      envelope.payload_text = truncate(frame.text, config.maxPayloadChars)
    }
    envelope.meta = {
      source_kind: frame.sourceKind,
      source_form: frame.sourceForm,
      text_len: frame.text.length,
      classified_by: classification.reason,
      carries_own_origin_marker: parseOriginTag(frame.text) !== null,
    }
    if (eventType === 'user/message') {
      if (classification.ingestClass === 'human') {
        runtime.stats.humanMessages += 1
        if (sessionId !== null && frame.text.length > 0) {
          runtime._queryCache.set(sessionId, { text: truncate(frame.text, 2000), turn, step, at: Date.now() })
          if (runtime._queryCache.size > 32) {
            const oldest = runtime._queryCache.keys().next()
            if (oldest.done !== true) runtime._queryCache.delete(oldest.value)
          }
        }
      } else if (classification.ingestClass === 'self_injected') {
        runtime.stats.selfInjectedMessages += 1
      } else if (classification.ingestClass === 'sibling_injected') {
        runtime.stats.siblingInjectedMessages += 1
      } else if (classification.ingestClass === 'context_snapshot') {
        runtime.stats.contextSnapshotMessages += 1
      }
    }
  } else if (eventType === 'tool/call' || eventType === 'tool/result') {
    envelope.origin_system = 'tool'
    envelope.ingest_class = 'tool-output'
    envelope.meta = { tool_name: pickString(data.name, data.message?.name), tool_call_id: pickString(data.id, data.message?.id) }
  } else if (eventType === 'turn/end') {
    envelope.meta = { reason_kind: pickString(data.reason?.kind, data.reason) }
  }

  runtime.queue.append(envelope)
  runtime.trace('event.ingested', {
    sessionId,
    eventType,
    seq,
    turn,
    step,
    originSystem: envelope.origin_system,
    ingestClass: envelope.ingest_class,
  })
  if (eventType === 'turn/end') {
    // 回合结束：清账（下一轮 step 从 1 重新开始，键不会撞）。
    runtime._sentContexts.clear()
  }
}

/**
 * `agent/turn-stopping` **serial** —— 没有 next，返回 void。
 *
 * M0 Q3 的纪律：turn-stopping 只是「停止时的控制点」，**不是已经结束**。
 * 所以这里只写候选快照，不写任何「已完成」结论（真正的完成判据是 turn/end）。
 *
 * @param {ConnectorRuntime} runtime
 * @param {typeof DEFAULT_CONFIG} config
 * @param {any} payload
 */
function handleTurnStopping(runtime, config, payload) {
  runtime.stats.turnStoppingCalls += 1
  runtime.queue.append({
    record_kind: 'turn_stopping',
    event_type: 'agent/turn-stopping',
    session_id: typeof payload?.agent?.session?.id === 'string' ? payload.agent.session.id : null,
    turn_id: numberOrNull(payload?.turn),
    snapshot_kind: 'candidate',
    note: 'turn-stopping is a stopping control point, not a turn/end; never treat as completed',
    at: new Date().toISOString(),
  })
  runtime.trace('turn-stopping', { turn: numberOrNull(payload?.turn) })
}

/**
 * 从 pre-step 的 messages 里取最后一条**人类**输入的文本，作为构包 query。
 *
 * 为什么要过滤：pre-step 的 messages 里已经混入宿主自己的 runtime-context 快照与
 * 兄弟引擎的注入（M0 §2 Q2 实测），拿它们当 query 会把检索带偏。
 *
 * @param {unknown} messages
 * @returns {string}
 */
function lastHumanText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = /** @type {Record<string, any>} */ (messages[index])
    if (message === null || typeof message !== 'object') continue
    if (message.role !== 'user') continue
    const kind = message.source?.kind
    if (typeof kind === 'string' && kind !== 'user') continue
    const text = messageTextOf(message)
    if (text.length > 0) return text
  }
  return ''
}

/**
 * @param {Record<string, any>} message
 * @returns {string}
 */
function messageTextOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  /** @type {string[]} */
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * 从消息事件 data 里取文本与来源信息（防御式：形状不确定）。
 * @param {Record<string, any>} data
 * @returns {{ text: string, sourceKind: string|null, sourceForm: string|null }}
 */
function extractFrame(data) {
  const message = data?.message !== undefined && data.message !== null && typeof data.message === 'object' ? data.message : data
  const content = message?.content
  /** @type {string[]} */
  const parts = []
  if (typeof content === 'string') parts.push(content)
  else if (Array.isArray(content)) {
    for (const block of content) {
      if (block === null || typeof block !== 'object') continue
      if (typeof block.text === 'string') parts.push(block.text)
      else if (typeof block.content === 'string') parts.push(block.content)
    }
  }
  return {
    text: parts.join('\n'),
    sourceKind: typeof message?.source?.kind === 'string' ? message.source.kind : null,
    sourceForm: typeof message?.source?.form === 'string' ? message.source.form : null,
  }
}

/**
 * @param {ConnectorRuntime} runtime
 * @param {string|null} sessionId
 * @returns {{ turn: number|null, step: number|null }}
 */
function cursorOf(runtime, sessionId) {
  if (sessionId === null) return { turn: null, step: null }
  return runtime._stepCursor.get(sessionId) ?? { turn: null, step: null }
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 取第一个字符串候选。
 * @param {...unknown} values
 * @returns {string|null}
 */
function pickString(...values) {
  for (const value of values) if (typeof value === 'string' && value.length > 0) return value
  return null
}

/**
 * @param {string} text
 * @returns {string}
 */
function shortHash(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 16)}`
}

/**
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
function truncate(text, max) {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 12))}…(truncated)` : text
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  const anyError = /** @type {any} */ (error)
  const message = String(anyError?.message ?? anyError ?? 'unknown error')
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

/**
 * Promise 超时包装。超时后 reject —— 调用方 catch 成「没有包」，不注入。
 * （被放弃的 promise 自己跑完，不产生副作用，也不影响宿主。）
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return promise
  /** @type {any} */
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
      if (typeof timer?.unref === 'function') timer.unref()
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}
