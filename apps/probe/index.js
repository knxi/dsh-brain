// @ts-check
/**
 * @dsh-brain/probe — M0 接入探针（Cordis 插件形态）。
 *
 * 唯一职责：把 DSH 真实装配点上的事件原样记进 timeline.jsonl。
 *
 * 纪律（docs/CONTRACTS.md 第 9 节）：
 *   - 默认只记录不干预：每个 waterfall 监听器都只 `await next()` / `return next()`，不改装配结果。
 *   - 不改宿主 messages 数组：只在显式注入实验（config.injectPreStep）里**复制**后追加。
 *   - 不注册 complete:true 系统提示节。
 *   - 不写凭据、不写消息正文以外的敏感内容；正文只落长度与哈希摘要。
 *
 * 观测点：
 *   system-prompt/assemble / agent/pre-step / agent/turn-stopping / agent/request-error /
 *   agent/error / session/event / session/flush / session/disposed / llm/stream / tools/result
 */
import { createHash } from 'node:crypto'
import { PROBE_MARKER, PROBE_MARKER_ID, brief, initRecorder, record, recorderDir } from './recorder.js'

/**
 * 构造宿主可直接接纳的 user-role 标记消息。
 *
 * 为什么不用 `createUserMessage`：探针住在仓库里（link 挂载），解析不到
 * `@deepseek-ai/dsh-llm`（它只存在于 dsh 全局安装树）。所以按 UserMessage 的
 * 公开形状自己构造：{role,id,content,source}。source.kind='user' 与 Engram 现有
 * 做法一致（它也用 createUserMessage 追加 user 消息）。
 * @param {string} text
 * @returns {any}
 */
function makeMarkerMessage(text) {
  return {
    role: 'user',
    id: `probe-msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** cordis 插件名 */
export const name = 'brain-probe'

/** 需要 systemPrompt 服务：只用于受控注入实验注册/注销 context 贡献。 */
export const inject = ['systemPrompt']

/**
 * 平台侧默认配置（普通对象，不是 schemastery schema —— 导出 `Config` 会被 cordis
 * 当成 schema 去 `.validate`，探针不引入 schemastery 依赖）。
 */
const DEFAULT_CONFIG = {
  /** 输出目录；缺省从 DSH_PROBE_RUN_DIR 环境变量读，再缺省到 _adhoc。 */
  dir: '',
  /** 受控注入实验 A：注册一个动态 user-role context 贡献（PromptContext）。 */
  injectContext: false,
  /** 受控注入实验 B：在第一个 step 的 pre-step 决策里复制数组并追加一条带来源的 user message。 */
  injectPreStep: false,
  /** 是否记录消息正文摘要（只记长度 + sha256 前 12 位，永不落正文）。 */
  hashText: true,
}

/**
 * 计算短哈希，用于判断"是不是同一条注入被重复提取"，而不泄露正文。
 * @param {string} text
 * @returns {string}
 */
function shortHash(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

/**
 * 把消息压成安全摘要。
 * @param {any} message
 * @returns {Record<string, unknown>}
 */
function messageBrief(message) {
  if (message === null || message === undefined) return { kind: 'none' }
  const content = Array.isArray(message.content) ? message.content : []
  const text = content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('\n')
  return {
    sourceKind: message.source?.kind ?? 'unknown',
    role: message.role ?? 'unknown',
    blocks: content.length,
    blockTypes: content.map((block) => block?.type).filter(Boolean),
    textLen: text.length,
    textHash: text.length > 0 ? shortHash(text) : null,
    carriesProbeMarker: text.includes(PROBE_MARKER_ID),
  }
}

/**
 * 判断一个装配是否含有探针标记。
 * @param {any} assembly
 * @returns {{inSections: boolean, inContexts: boolean}}
 */
function markerInAssembly(assembly) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  const contexts = Array.isArray(assembly?.contexts) ? assembly.contexts : []
  return {
    inSections: sections.some((section) => typeof section?.text === 'string' && section.text.includes(PROBE_MARKER_ID)),
    inContexts: contexts.some((entry) => typeof entry?.text === 'string' && entry.text.includes(PROBE_MARKER_ID)),
  }
}

/**
 * 装配摘要：只记名称清单与计数，不记正文。
 * @param {any} assembly
 */
function assemblyBrief(assembly) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : []
  const contexts = Array.isArray(assembly?.contexts) ? assembly.contexts : []
  const tools = Array.isArray(assembly?.tools) ? assembly.tools : []
  return {
    sectionCount: sections.length,
    sectionNames: sections.map((section) => section?.name).filter(Boolean),
    sectionTextLens: sections.map((section) => (typeof section?.text === 'string' ? section.text.length : 0)),
    contextCount: contexts.length,
    contextNames: contexts.map((entry) => entry?.name).filter(Boolean),
    toolCount: tools.length,
    variableKeys: assembly?.variables && typeof assembly.variables === 'object' ? Object.keys(assembly.variables) : [],
  }
}

/**
 * 插件入口。
 * @param {any} ctx cordis 上下文
 * @param {Partial<typeof DEFAULT_CONFIG>} [config]
 */
export function apply(ctx, config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config }
  const dir = merged.dir || process.env.DSH_PROBE_RUN_DIR || 'E:/ds-h/dsh-brain/data/probe/_adhoc'
  initRecorder(dir)
  record('probe/boot', 'info', {
    plugin: name,
    dir: recorderDir(),
    pid: process.pid,
    node: process.version,
    cwd: process.cwd(),
    config: { injectContext: merged.injectContext, injectPreStep: merged.injectPreStep },
  })

  // ── 观测点 1：系统提示装配 waterfall（sections/contexts/tools/variables） ──
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    record('system-prompt/assemble', 'before', {
      ...assemblyBrief(assembly),
      scope: brief(context?.scope),
      hasSignal: context?.signal instanceof AbortSignal,
      ...markerInAssembly(assembly),
    })
    let out
    try {
      out = await next()
    } catch (error) {
      record('system-prompt/assemble', 'after', { thrown: true, error: brief(String(error && error.message)) })
      throw error
    }
    record('system-prompt/assemble', 'after', {
      ...assemblyBrief(out),
      mutatedByProbe: false,
      ...markerInAssembly(out),
    })
    return out
  })

  // ── 观测点 2：agent/pre-step waterfall（每 step 一次；reject 必须原样保留） ──
  let injected = false
  ctx.on('agent/pre-step', async (payload, next) => {
    record('agent/pre-step', 'before', {
      turn: payload?.turn,
      step: payload?.step,
      claimedMessages: Array.isArray(payload?.messages) ? payload.messages.length : -1,
      claimedBrief: Array.isArray(payload?.messages) ? payload.messages.map(messageBrief) : [],
      hasSignal: payload?.signal instanceof AbortSignal,
    })
    const decision = await next()
    if (decision?.kind === 'reject') {
      record('agent/pre-step', 'reject', { turn: payload?.turn, step: payload?.step, reason: brief(decision.reason) })
      return decision
    }
    record('agent/pre-step', 'after', {
      turn: payload?.turn,
      step: payload?.step,
      kind: decision?.kind,
      messages: Array.isArray(decision?.messages) ? decision.messages.length : -1,
      startsRequestSeries: decision?.startsRequestSeries === true,
    })

    // 受控注入实验 B：只做一次，只复制不原地改。
    if (merged.injectPreStep && !injected && payload?.turn === 1 && payload?.step === 1) {
      injected = true
      const marker = makeMarkerMessage(`${PROBE_MARKER} (channel=pre-step-append)`)
      const nextMessages = [...(decision.messages ?? []), marker]
      record('agent/pre-step', 'after', {
        probeInjection: 'pre-step-append',
        copiedNotMutated: true,
        before: (decision.messages ?? []).length,
        after: nextMessages.length,
        markerId: PROBE_MARKER_ID,
      })
      return { ...decision, messages: nextMessages }
    }
    return decision
  })

  // ── 观测点 3：最终请求边界（llm/stream waterfall 收到的是 complete request） ──
  ctx.on('llm/stream', (options, next) => {
    const systemText = typeof options?.system === 'string' ? options.system : ''
    const messages = Array.isArray(options?.messages) ? options.messages : []
    // 实测教训（task-4）：system prompt 有两种承载形态 —— 请求的 `system` 字段，或
    // （适配器声明 in-history 时）一条 role=system 的 message。只看 options.system 会漏判 sent。
    const systemRoleMessages = messages.filter((message) => message?.role === 'system')
    const systemRoleText = systemRoleMessages
      .map((message) =>
        Array.isArray(message.content)
          ? message.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
          : '',
      )
      .join('\n')
    record('llm/stream', 'before', {
      provider: options?.provider,
      model: options?.model,
      // purpose 区分主请求与旁路请求（例如 session-title 的标题生成）；只有主请求才代表这一 step 的最终请求。
      purpose: options?.purpose ?? '(none)',
      stream: options?.stream === true,
      systemLen: systemText.length,
      systemRoleMessageCount: systemRoleMessages.length,
      systemRoleTextLen: systemRoleText.length,
      // sent 检查必须两级都查：请求的 system 字段 / messages 里的 role=system。
      systemPromptCarriedIn:
        systemText.length > 0 ? 'request.system' : systemRoleText.length > 0 ? 'messages[role=system]' : 'absent',
      systemHasProbeMarker: systemText.includes(PROBE_MARKER_ID) || systemRoleText.includes(PROBE_MARKER_ID),
      messageCount: messages.length,
      messageProbeMarkerCount: messages.filter((message) =>
        JSON.stringify(message ?? '').includes(PROBE_MARKER_ID),
      ).length,
      messageRoles: messages.map((message) => message?.role ?? 'unknown'),
      topLevelKeys: options && typeof options === 'object' ? Object.keys(options).slice(0, 24) : [],
      // 请求对象是否被宿主标记为 agent-loop 构造（标记 = 内容由会话日志决定，不可改写）
      requestFrozen: options ? Object.isFrozen(options) : null,
    })
    // 只透传，绝不短路、绝不改写。
    return next()
  })

  // ── 观测点 6：sessionQuery 只读实调（turn/end 之后跑一次；全是读，不写、不改宿主） ──
  let queryProbeDone = false
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'turn/end' || queryProbeDone) return
    const sessionId = session?.id
    if (sessionId === undefined) return
    const engine = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined
    if (engine === undefined || engine === null) {
      record('sessionQuery/probe', 'info', { available: false, reason: 'service not mounted' })
      return
    }
    queryProbeDone = true
    // 故意不 await：观察者不能拖长会话事件分发。
    void probeSessionQuery(engine, sessionId)
  })

  // ── 观测点 4：会话持久事件 feed（post-commit，fire-and-forget） ──
  ctx.on('session/event', (session, event) => {
    const data = event?.data ?? {}
    record('session/event', 'info', {
      session: session?.id,
      type: event?.type,
      seq: event?.seq,
      turn: data.turn,
      step: data.step,
      reasonKind: data.reason?.kind,
      interrupted: data.interrupted === true,
      surfaceOp: brief(data.surfaceOp ?? event?.surfaceOp),
      sourceEventSeqs: Array.isArray(event?.sourceEventSeqs) ? event.sourceEventSeqs : undefined,
      messageBrief: event?.type === 'user/message' || event?.type === 'system/message' || event?.type === 'assistant/message'
        ? messageBrief(data.message ?? data)
        : undefined,
      toolName: data.name ?? data.message?.name,
      toolCallId: data.id ?? data.message?.id,
    })
  })

  // ── 观测点 5：其余生命周期/故障边界 ──
  // agent/turn-stopping 是 serial 分发（agent-loop 用 dispatch.serial），监听器没有 next，
  // 返回 Promise<void> 即可。实测：在这里用 waterfall 签名会让整轮 turn/end reason=error。
  ctx.on('agent/turn-stopping', (payload) => {
    record('agent/turn-stopping', 'before', { turn: payload?.turn })
  })

  ctx.on('agent/request-error', async (payload, next) => {
    record('agent/request-error', 'before', {
      turn: payload?.turn,
      step: payload?.step,
      code: payload?.failure?.code,
      status: payload?.failure?.status,
      retryAfterMs: payload?.failure?.providerRetryAfterMs,
      hasRetryPolicy: payload?.retryPolicy !== undefined,
    })
    const out = await next()
    record('agent/request-error', 'after', { action: out?.kind ?? 'none' })
    return out
  })

  ctx.on('agent/error', (payload) => {
    record('agent/error', 'info', {
      turn: payload?.turn,
      step: payload?.step,
      error: brief(String(payload?.error && payload.error.message)),
    })
  })

  ctx.on('session/flush', async (session) => {
    record('session/flush', 'info', { session: session?.id })
  })

  ctx.on('session/disposed', (session) => {
    record('session/disposed', 'info', { session: session?.id })
  })

  ctx.on('tools/result', (exec, result) => {
    record('tools/result', 'info', {
      tool: exec?.name ?? exec?.call?.name,
      callId: exec?.id ?? exec?.call?.id,
      ok: result?.ok ?? (result?.error === undefined),
      error: brief(String(result?.error?.message ?? result?.error ?? '')),
    })
  })

  // ── 受控注入实验 A：动态 user-role context（PromptContext，不是 system section） ──
  if (merged.injectContext) {
    ctx.systemPrompt.context({
      name: 'brain-probe:marker',
      order: 9e8,
      text: () => `${PROBE_MARKER} (channel=prompt-context)`,
    })
    record('probe/injection', 'info', {
      kind: 'systemPrompt.context',
      sectionName: 'brain-probe:marker',
      order: 9e8,
      markerId: PROBE_MARKER_ID,
      registersCompleteSection: false,
    })
  }

  record('probe/ready', 'info', { hookCount: 11 })
}

/**
 * sessionQuery 只读实调：验证权限/分页/游标/lease 释放的实际行为。
 *
 * 纪律：全是读操作；每一步单独 try/catch，绝不让未捕获 rejection 泄漏到宿主
 * （fire-and-forget 的 Promise 一旦 reject 会变成 unhandledRejection）。
 * 正文一律不落盘，只记条数、游标存在性、错误码。
 *
 * @param {any} engine ctx.sessionQuery 实例
 * @param {string} sessionId 本会话 id
 */
async function probeSessionQuery(engine, sessionId) {
  /** @param {string} name @param {(value: any) => Record<string, unknown>} build */
  const safe = async (name, build) => {
    try {
      const value = await build()
      record('sessionQuery', 'after', { hook: name, session: sessionId, ...value })
      return value
    } catch (error) {
      const anyError = /** @type {any} */ (error)
      record('sessionQuery', 'reject', {
        hook: name,
        session: sessionId,
        errorCode: anyError?.code ?? null,
        errorName: anyError?.name ?? null,
        error: brief(String(anyError?.message ?? error), 200),
      })
      return undefined
    }
  }

  // 1) observeSession + lease 生命周期（观察租约必须按生命周期释放）
  /** @type {any} */
  const lease = await safe('observeSession', async () => {
    const observed = await engine.observeSession(sessionId)
    return { observed }
  })
  const observation = lease?.observed
  if (observation !== undefined && observation !== null) {
    record('sessionQuery', 'info', {
      hook: 'observation/describe',
      session: sessionId,
      source: observation.source,
      eventCount: Array.isArray(observation.events) ? observation.events.length : -1,
      cursor: observation.cursor,
      inheritedEventCount: observation.inheritedEventCount,
      hasProjections: observation.projections !== undefined,
    })
    // retain() 拿一份独立租约，然后立刻释放，验证两段释放都可用
    await safe('observation/retain+release', async () => {
      const retained = typeof observation.retain === 'function' ? observation.retain() : undefined
      const releasedRetained = disposeLease(retained)
      const releasedOriginal = disposeLease(observation)
      return { retainedCreated: retained !== undefined, releasedRetained, releasedOriginal }
    })
    /** 观察到的最后 seq，供 readEvent 取范围 */
    const cursorSeq = Number(observation.cursor)
    // 2) readEvent：带 before/after 的范围读
    if (Number.isFinite(cursorSeq) && cursorSeq >= 0) {
      await safe('readEvent', async () => {
        const window = await engine.readEvent({ sessionId, seq: cursorSeq, before: 1, after: 1 })
        return {
          targetType: window?.target?.type,
          targetSeq: window?.target?.seq,
          windowEvents: Array.isArray(window?.events) ? window.events.length : -1,
          startSeq: window?.startSeq,
          endSeq: window?.endSeq,
        }
      })
    }
  }

  // 3) readSurface：当前模型 surface（不是完整人类聊天归档）
  await safe('readSurface', async () => {
    const surface = await engine.readSurface(sessionId)
    return {
      surfaceNodeCount: Array.isArray(surface?.surface?.nodes) ? surface.surface.nodes.length : -1,
      capturedThroughSeq: surface?.seq,
      hasHeader: surface?.header !== undefined,
    }
  })

  // 4) readSession：完整逻辑日志（会做 replay validation）
  await safe('readSession', async () => {
    const snapshot = await engine.readSession(sessionId)
    return {
      eventCount: Array.isArray(snapshot?.events) ? snapshot.events.length : -1,
      replayValidated: true,
    }
  })

  // 5) searchEvents：一页 + 消费 cursor 翻页（M2 历史回查的核心判据）
  await safe('searchEvents/page1', async () => {
    const page = await engine.searchEvents({ sessionId, query: 'probe', limit: 1 })
    return {
      itemCount: Array.isArray(page?.items) ? page.items.length : -1,
      hasNextCursor: page?.nextCursor !== undefined,
      cursorType: typeof page?.nextCursor,
    }
  })
  await safe('searchEvents/page2-via-cursor', async () => {
    const page1 = await engine.searchEvents({ sessionId, query: 'probe', limit: 1 })
    if (page1?.nextCursor === undefined) return { page2Skipped: 'no nextCursor on page1' }
    const page2 = await engine.searchEvents({ sessionId, query: 'probe', limit: 1, cursor: page1.nextCursor })
    return {
      page2ItemCount: Array.isArray(page2?.items) ? page2.items.length : -1,
      page2HasNextCursor: page2?.nextCursor !== undefined,
      cursorAccepted: true,
    }
  })

  // 6) searchSessions：跨会话分页 + filters 形状
  await safe('searchSessions', async () => {
    const page = await engine.searchSessions({ query: 'probe', limit: 2 })
    return {
      itemCount: Array.isArray(page?.items) ? page.items.length : -1,
      hasNextCursor: page?.nextCursor !== undefined,
    }
  })

  // 7) listSessions：完整逻辑语料（live-preferred）
  await safe('listSessions', async () => {
    const records = await engine.listSessions()
    return { sessionCount: Array.isArray(records) ? records.length : -1 }
  })
}

/**
 * 释放一个 observation lease（Disposable 或显式 dispose 两种形态都兼容）。
 * @param {any} lease
 * @returns {boolean} 是否释放成功
 */
function disposeLease(lease) {
  if (lease === undefined || lease === null) return false
  try {
    if (typeof lease[Symbol.dispose] === 'function') {
      lease[Symbol.dispose]()
      return true
    }
    if (typeof lease.dispose === 'function') {
      lease.dispose()
      return true
    }
    return false
  } catch {
    return false
  }
}
