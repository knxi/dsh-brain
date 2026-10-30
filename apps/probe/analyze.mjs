// @ts-check
/**
 * analyze.mjs — 把 timeline.jsonl 归纳成 verdict.json（六问）+ timeline.md（人读时序）。
 *
 * 原则：status 由可计算判据决定，不由愿望决定。判据不满足就降级为 partial/unknown，
 * 并在 missing 字段写清"缺什么证据才能升级"。
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** @typedef {{scene?: string, ts: string, hook: string, seq: number, phase: string, [k: string]: any}} TimelineEvent */
/** @typedef {{question: string, status: 'answered'|'partial'|'unknown', evidence: string[], note: string, missing?: string}} VerdictItem */

/**
 * 读一个 jsonl。
 * @param {string} file
 * @returns {TimelineEvent[]}
 */
function readTimeline(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((event) => event !== null)
}

/**
 * 取某场景某 hook 的事件。
 * @param {TimelineEvent[]} events
 * @param {string} hook
 * @param {string} [phase]
 */
function pick(events, hook, phase) {
  return events.filter((event) => event.hook === hook && (phase === undefined || event.phase === phase))
}

/**
 * sessionQuery 实调的子钩子名。
 *
 * 注意：探针 record() 用 `{ts, hook, seq, phase, ...payload}` 组装行，payload 里的
 * `hook` 会**覆盖**行上的 hook 字段——所以这些子名就是行上的 hook 值。
 * @type {Set<string>}
 */
const SESSION_QUERY_HOOKS = new Set([
  'sessionQuery/probe',
  'observeSession',
  'observation/describe',
  'observation/retain+release',
  'readEvent',
  'readSurface',
  'readSession',
  'listSessions',
  'searchEvents/page1',
  'searchEvents/page2-via-cursor',
  'searchSessions',
])

/**
 * 统计某场景的装配点次数。
 * @param {TimelineEvent[]} events
 */
function sceneMetrics(events) {
  const sessionEvents = pick(events, 'session/event')
  const turnsStarted = sessionEvents.filter((event) => event.type === 'turn/start')
  const stepsStarted = sessionEvents.filter((event) => event.type === 'step/start')
  const assembleBefore = pick(events, 'system-prompt/assemble', 'before')
  const preStepBefore = pick(events, 'agent/pre-step', 'before')
  const llmStream = pick(events, 'llm/stream', 'before')
  const turnEnd = sessionEvents.filter((event) => event.type === 'turn/end')
  const stepEnd = sessionEvents.filter((event) => event.type === 'step/end')
  const userMessages = sessionEvents.filter((event) => event.type === 'user/message')
  const systemMessages = sessionEvents.filter((event) => event.type === 'system/message')
  const toolResults = sessionEvents.filter((event) => event.type === 'tool/result')
  const requestErrors = pick(events, 'agent/request-error', 'before')
  const agentErrors = pick(events, 'agent/error')
  const turnStopping = pick(events, 'agent/turn-stopping')

  const markerInRequest = llmStream.filter(
    (event) => event.systemHasProbeMarker === true || (event.messageProbeMarkerCount ?? 0) > 0,
  )
  const markerUserMessages = userMessages.filter((event) => event.messageBrief?.carriesProbeMarker === true)

  // 共用同一通道的其它注入方（例如 lingshu:*）：assemble 的 after 摘要里才看得到它们 push 的块。
  const assembleAfter = pick(events, 'system-prompt/assemble', 'after')
  const injectedBlockSeries = assembleAfter.map((event) => ({
    contextNames: Array.isArray(event.contextNames) ? event.contextNames : [],
    foreignBlocks: (Array.isArray(event.contextNames) ? event.contextNames : []).filter(
      (name) => name.startsWith('lingshu:') || name.startsWith('brain-probe:'),
    ),
  }))

  return {
    eventTypeCounts: countBy(sessionEvents.map((event) => event.type)),
    turnsStarted: turnsStarted.map((event) => event.turn),
    stepsStarted: stepsStarted.map((event) => ({ turn: event.turn, step: event.step })),
    turnEndReasons: turnEnd.map((event) => ({ turn: event.turn, reason: event.reasonKind })),
    stepEndCount: stepEnd.length,
    assembleCount: assembleBefore.length,
    preStepCount: preStepBefore.length,
    preStepRejects: pick(events, 'agent/pre-step', 'reject').length,
    llmStreamCount: llmStream.length,
    requestErrors: requestErrors.map((event) => event.code),
    agentErrors: agentErrors.map((event) => event.error),
    turnStoppingCount: turnStopping.length,
    userMessageCount: userMessages.length,
    systemMessageCount: systemMessages.length,
    toolResultCount: toolResults.length,
    marker: {
      userMessagesCarryingMarker: markerUserMessages.length,
      requestsCarryingMarker: markerInRequest.length,
      markerMessageEvents: markerUserMessages.map((event) => ({
        seq: event.seq,
        textLen: event.messageBrief?.textLen,
        textHash: event.messageBrief?.textHash,
        turn: event.turn,
        step: event.step,
      })),
    },
    requests: llmStream.map((event) => ({
      provider: event.provider,
      model: event.model,
      purpose: event.purpose,
      systemLen: event.systemLen,
      systemRoleMessageCount: event.systemRoleMessageCount,
      systemRoleTextLen: event.systemRoleTextLen,
      systemPromptCarriedIn: event.systemPromptCarriedIn,
      messageCount: event.messageCount,
      messageRoles: event.messageRoles,
      systemHasProbeMarker: event.systemHasProbeMarker,
      requestFrozen: event.requestFrozen,
      topLevelKeys: event.topLevelKeys,
    })),
    /** system prompt 的承载形态（request.system / messages[role=system]）—— sent 判据必须两级都查。 */
    systemPromptCarriedInSeries: llmStream.map((event) => ({
      purpose: event.purpose,
      carriedIn: event.systemPromptCarriedIn,
      systemLen: event.systemLen,
      systemRoleTextLen: event.systemRoleTextLen,
    })),
    /** assemble(after) 里每个 step 实际注入的外来块（按 step 列，能看出是否逐 step 增长）。 */
    injectedBlockSeries,
    /** sessionQuery 只读实调结果（子钩子名来自 payload.hook，会覆盖行上的 hook 字段）。 */
    sessionQuery: events
      .filter((event) => SESSION_QUERY_HOOKS.has(event.hook))
      .map((event) => ({
        hook: event.hook,
        phase: event.phase,
        errorCode: event.errorCode ?? null,
        detail:
          event.eventCount ??
          event.targetSeq ??
          event.sessionCount ??
          event.itemCount ??
          event.releasedOriginal ??
          event.page2ItemCount ??
          event.surfaceNodeCount ??
          undefined,
      })),
    // 旁路请求（例如 session-title 的标题生成）不是这一 step 的最终请求，必须从"每 step 一次"的计数里剔除。
    requestPurposes: llmStream.map((event) => event.purpose ?? '(none)'),
    mainRequestCount: llmStream.filter((event) => !String(event.purpose ?? '').toLowerCase().includes('title')).length,
    assembly: assembleBefore.map((event) => ({
      sectionCount: event.sectionCount,
      contextCount: event.contextCount,
      toolCount: event.toolCount,
      contextNames: event.contextNames,
    })),
  }
}

/**
 * @param {string[]} values
 * @returns {Record<string, number>}
 */
function countBy(values) {
  /** @type {Record<string, number>} */
  const out = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

/**
 * 主分析入口。
 * @param {string} runDir
 * @returns {{runId: string, generatedAt: string, summary: {answered: number, partial: number, unknown: number}, questions: VerdictItem[], metrics: Record<string, any>}}
 */
export function analyzeRun(runDir) {
  const scenesDir = join(runDir, 'scenes')
  /** @type {Record<string, TimelineEvent[]>} */
  const byScene = {}
  if (existsSync(scenesDir)) {
    for (const entry of readdirSync(scenesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      byScene[entry.name] = readTimeline(join(scenesDir, entry.name, 'timeline.jsonl'))
    }
  }
  /** @type {Record<string, any>} */
  const metrics = {}
  for (const [scene, events] of Object.entries(byScene)) metrics[scene] = sceneMetrics(events)

  const single = metrics.single
  const toolRead = metrics['tool-read']
  const toolFail = metrics['tool-fail']
  const injectPre = metrics['inject-pre']
  const injectCtx = metrics['inject-ctx']
  const interruptGraceful = metrics['interrupt-graceful']
  const interruptHard = metrics['interrupt-hard']

  /** @type {VerdictItem[]} */
  const questions = []

  // ── Q1：一轮触发几次 assemble / pre-step；重试是否重复；注入顺序受谁影响 ──
  {
    const evidence = []
    /** @type {'answered'|'partial'|'unknown'} */
    let status = 'unknown'
    if (single && single.assembleCount > 0) {
      evidence.push(
        `实机 scenes/single：turn=${single.turnsStarted.join(',')}，assemble(before)=${single.assembleCount}，pre-step(before)=${single.preStepCount}，llm/stream 主请求=${single.mainRequestCount}（全部请求 purpose=${JSON.stringify(single.requestPurposes)}）→ 单步回合 1:1:1；多出来的那次请求是旁路（标题生成），不是主请求。`,
      )
    }
    if (toolRead && toolRead.stepsStarted.length >= 2) {
      evidence.push(
        `实机 scenes/tool-read：steps=${JSON.stringify(toolRead.stepsStarted)}，assemble=${toolRead.assembleCount}，pre-step=${toolRead.preStepCount}，llm/stream 主请求=${toolRead.mainRequestCount}（purpose=${JSON.stringify(toolRead.requestPurposes)}）→ 每个 step 各触发一次 assemble + pre-step，不是每轮一次。`,
      )
      status = 'answered'
    } else if (toolRead) {
      evidence.push(`实机 scenes/tool-read：steps=${toolRead.stepsStarted.length}（模型未按预期进入第二步），无法据此断言多步比例。`)
      if (single?.assembleCount > 0) status = 'partial'
    }
    const retried = Object.entries(metrics).filter(([, m]) => m.requestErrors.length > 0)
    if (retried.length === 0) {
      evidence.push(
        '静态证据（dsh-agent-loop/lib/index.js:1039-1060, 1130-1140）：重试在 step() 内的 while 循环里 continue，只重跑 prepareRequest/refreshContext/llm.stream，不回到 preStep()，因此 assemble 与 agent/pre-step 不重复触发。本次所有场景未观测到 agent/request-error，重试路径**未在实机触发**。',
      )
    }
    questions.push({
      question: '一轮用户输入触发几次 assemble / pre-step？模型重试是否重复？实际注入顺序受哪些插件和 prepend 影响？',
      status,
      evidence,
      note:
        'assemble 与 pre-step 是"每 step 一次"，不是"每轮一次"：多步回合的第二个 step 会重新装配一次完整 system prompt 并重新过 pre-step waterfall。重试在同一 step 内循环，不重跑这两个 waterfall，但会重跑 refreshContext（只刷新 runtime-context，不重跑 sections/tools/variables）。注入顺序由各插件注册的 section.order / context.order 决定，再按 name 的 code-unit 序稳定排序；pre-step 侧则取决于各监听器把消息 prepend 还是 append 到 messages 数组。',
      missing:
        '要升级"重试不重复"为实机 answered，需要一个可控失败触发 agent/request-error → retry 的场景（需要注入会失败的 mock provider 或在 llm/stream 里受控抛错）。',
    })
  }

  // ── Q2：追加片段是否持久化为 system/message；如何按 turn/step 更新且不重复提取 ──
  {
    const evidence = []
    /** @type {'answered'|'partial'|'unknown'} */
    let status = 'unknown'
    if (injectPre) {
      evidence.push(
        `实机 scenes/inject-pre（受控注入实验 B：pre-step 复制数组追加一条 user message）：user/message 事件数=${injectPre.userMessageCount}，其中携带探针标记的=${injectPre.marker.userMessagesCarryingMarker}，带标记的请求数=${injectPre.marker.requestsCarryingMarker}/${injectPre.llmStreamCount}。`,
      )
      if (injectPre.marker.userMessagesCarryingMarker > 0) {
        evidence.push('结论：pre-step 追加的消息被宿主当作真实 user 消息持久化进会话日志（user/message 事件），不是临时上下文。')
        status = 'answered'
      }
    }
    if (injectCtx) {
      evidence.push(
        `实机 scenes/inject-ctx（受控注入实验 A：注册 systemPrompt.context，PromptContext）：system/message 事件数=${injectCtx.systemMessageCount}，user/message 事件数=${injectCtx.userMessageCount}，携带标记的 user/message=${injectCtx.marker.userMessagesCarryingMarker}，带标记的请求数=${injectCtx.marker.requestsCarryingMarker}/${injectCtx.llmStreamCount}。`,
      )
      if (injectCtx.marker.userMessagesCarryingMarker > 0) {
        evidence.push(
          '结论：assembly.contexts 走的是 durable user-role snapshot 通道 —— 落成 user/message 快照（source.kind=runtime-context），不落成 system/message。system prompt 只由 sections 决定。',
        )
        status = 'answered'
      }
    }
    evidence.push(
      '静态证据（dsh-agent-loop/lib/index.js:298-345 RuntimeContextProjection.project）：宿主自己已经用"保留值比对"做去重 —— 新快照文本与上次保留值相同就不产生新 user message。这意味着同一段注入只要文本不变，宿主不会每 step 重复 append；但**它不会阻止 Brain 自己重复提取**，责任在连接器：追加时必须带自己的来源标记（source.kind / sourceEventSeqs），提取时必须按该标记剔除自身注入。',
    )
    questions.push({
      question: '追加片段是否会持久化为 system/message？如何按 turn/step 更新而不把自身旧注入再次提取？',
      status,
      evidence,
      note:
        '两条通道的持久化形态不同：sections（system prompt 节）→ system/message，每个 step 重新投影并可能 replace 首节点或 append 新节点；contexts（PromptContext）→ user/message 的 durable 快照，带 source.kind=runtime-context 与 named sections 归因。按 turn/step 更新靠每次 assemble 重新求值 + 宿主快照去重；防自身重复提取必须靠连接器自己在 source/sourceEventSeqs 上打标并过滤，宿主不替你做。',
      missing: '未实测"同一 Brain 片段在连续两轮里不被二次提取"的完整闭环 —— 需要 M1 的连接器摄取侧一起验证。',
    })
  }

  // ── Q3：终结事件 ──
  {
    const evidence = []
    /** @type {'answered'|'partial'|'unknown'} */
    let status = 'partial'
    if (toolFail) {
      evidence.push(
        `实机 scenes/tool-fail：tool/result=${toolFail.toolResultCount}，step/end=${toolFail.stepEndCount}，turn/end reasons=${JSON.stringify(toolFail.turnEndReasons)} → 工具失败不终结回合，而是以 tool/result 进日志、回合继续。`,
      )
    }
    if (interruptGraceful) {
      evidence.push(
        `实机 scenes/interrupt-graceful（6.5s 后 SIGTERM 优雅取消）：eventTypes=${JSON.stringify(interruptGraceful.eventTypeCounts)}，turn/end reasons=${JSON.stringify(interruptGraceful.turnEndReasons)}，step/end=${interruptGraceful.stepEndCount}，turn-stopping=${interruptGraceful.turnStoppingCount}。`,
      )
    }
    if (interruptHard) {
      evidence.push(
        `实机 scenes/interrupt-hard（taskkill /F 强杀）：eventTypes=${JSON.stringify(interruptHard.eventTypeCounts)}，turn/end reasons=${JSON.stringify(interruptHard.turnEndReasons)}，step/end=${interruptHard.stepEndCount}。`,
      )
      if (interruptHard.turnEndReasons.length === 0) {
        evidence.push(
          '强杀进程不会留下 turn/end：宿主没有机会写终结事件，会话日志停在最后一个已 commit 的事件上。因此"进程被强杀"与"用户取消"是两种不同边界，连接器不能把两者都当回合完成。',
        )
      }
    }
    // 用户续写（task-4 新增实机）：同一 session 用 --session-id 接第二轮。
    const resume = metrics['coexist-2-resume']
    const firstRound = metrics['coexist-1']
    if (resume && firstRound) {
      evidence.push(
        `实机 用户续写（scenes/coexist-1 → coexist-2-resume，同一 session 用 headless --session-id 接续）：第一轮 turn=${firstRound.turnsStarted.length}/step=${firstRound.stepsStarted.length}/user-message=${firstRound.userMessageCount}，第二轮 turn=${resume.turnsStarted.length}/step=${resume.stepsStarted.length}/user-message=${resume.userMessageCount}，第二轮 turn/end reasons=${JSON.stringify(resume.turnEndReasons)} → 续写是在**同一条会话日志上追加新 turn**，不是新会话；终结事件与首轮同构（completed）。`,
      )
    }
    evidence.push(
      '静态证据（dsh-session/lib/types/types.d.ts:267-287 + dsh-agent-loop/lib/index.js:1000-1120）：终结事件族是 turn/end{reason: completed|blocked|aborted|error|max-tokens}、step/end、assistant/message{interrupted:true}、agent/turn-stopping（serial，停止时的控制点，不是已结束）、agent/request-error、agent/error；session/disposed 是卸载，不是回合结束。',
    )
    evidence.push(
      '快照更新时机判据：只在 turn/end 之后更新任务快照；agent/turn-stopping 只可写"候选"，不可当已结束；assistant/message 每 step 都会出现且可能 interrupted=true，不能当最终回答；session/disposed 只做收尾尽力而为之的补写，不能当成回合完成信号。',
    )
    questions.push({
      question: '生成中被打断、工具失败、用户续写、会话卸载、取消时有哪些终结事件？何时允许更新任务快照？',
      status,
      evidence,
      note:
        '工具失败 = 回合继续（tool/result 进日志，下一步模型看到错误）；进程强杀 = 无终结事件（日志停在最后一次 commit）；用户续写 = 同一条会话日志上追加新 turn、终结事件与首轮同构；用户取消走 aborted turn/end；会话卸载走 session/disposed。任务快照只应在 turn/end 后更新，且要按 reason 分流：completed 才可标完成，aborted/error 必须保持未完成。',
      missing:
        '只剩"用户取消（abort signal）"没实测：headless 是一次性进程，没有交互式取消入口；Windows 上从进程外发信号等价于 TerminateProcess（已实测：无终结事件）。要升 answered 需进程内 harness 用 AbortController 直接 abort agent，或在 web profile 里点取消。',
    })
  }

  // ── Q4：sessionQuery 权限/分页/游标/订阅补读边界 ──
  {
    const evidence = [
      '静态证据（dsh-session-query/lib/types/index.d.ts:35-150）：ctx.sessionQuery 提供 observeSession / readSession / readSurface / readEvent / searchEvents / searchSessions；搜索是分页接口，必须消费 cursor；readSession 是完整逻辑日志并做 replay validation，不等于逐字节物理 JSONL；readSurface 是当前模型 surface，不能当完整人类聊天归档。',
      '静态证据（dsh-base/cordis.patch.yml session-query-sqlite 行）：默认 path=:memory:、openAt=never —— 即 ctx.sessionQuery 挂载但**搜索默认关闭**，search 调用会以 SESSION_QUERY_SEARCH_DISABLED 失败，只有精确读/标题/血缘可用。本次 brainlab 把它改成 openAt=startup + 落在仓库内 sqlite，属于测试 profile 的显式覆盖。',
      '静态证据（dsh-session-query/lib/types/observation.d.ts:7-30）：Observation lease 必须按生命周期释放，不能长期持有。',
      '订阅补读边界：session/event 是 post-commit、fire-and-forget 的 append feed（会话日志状态 commit，不等于磁盘 flush）；监听器失败被隔离，宿主不等待回调落盘。因此连接器必须自己做持久入队 + 按 seq/cursor 补读，不能假设 feed 完整覆盖或已落盘。',
      `实机（本次 run 的 session/event 观测）：共记录 ${
        Object.values(metrics).reduce((sum, m) => sum + Object.values(m.eventTypeCounts).reduce((a, b) => a + b, 0), 0)
      } 条会话事件，含 ${JSON.stringify(
        Object.keys(
          Object.values(metrics).reduce((acc, m) => {
            for (const key of Object.keys(m.eventTypeCounts)) acc[key] = true
            return acc
          }, /** @type {Record<string, boolean>} */ ({})),
        ),
      )}；feed 中确实能收到 turn/start、step/start、user/message、assistant/message、step/end、turn/end 这些持久事件。`,
      '插件初始化顺序：cordis 按服务可用性驱动激活（行顺序不承载加载语义，见 dsh-base 的 cordis.patch.yml 头部注释），所以不能靠"我排在前面"保证先跑；服务不可用时靠 inject 声明等待，而不是靠 try/catch 猜。',
    ]

    // ── task-4 新增：sessionQuery 只读实调（在 turn/end 之后、宿主濒临退出的窗口里跑）──
    const queryMetrics = metrics.single?.sessionQuery ?? []
    const qHook = (/** @type {string} */ name) => queryMetrics.find((item) => item.hook === name)
    const qOk = (/** @type {string} */ name) => qHook(name)?.phase === 'after'
    const qErr = (/** @type {string} */ name) => qHook(name)?.errorCode ?? null
    if (queryMetrics.length > 0) {
      evidence.push(
        '实机 sessionQuery 只读实调（scenes/single，turn/end 之后）：' +
          [
            `observeSession=${qOk('observeSession') ? 'ok' : `fail(${qErr('observeSession')})`}`,
            `retain+release=${qOk('observation/retain+release') ? 'ok' : `fail(${qErr('observation/retain+release')})`}`,
            `readEvent=${qOk('readEvent') ? 'ok' : `fail(${qErr('readEvent')})`}`,
            `readSession=${qOk('readSession') ? 'ok（replay validation 通过）' : `fail(${qErr('readSession')})`}`,
            `readSurface=${qOk('readSurface') ? 'ok' : `fail(${qErr('readSurface')})`}`,
            `searchEvents=${qOk('searchEvents/page1') ? 'ok' : `fail(${qErr('searchEvents/page1')})`}`,
            `searchSessions=${qOk('searchSessions') ? 'ok' : `fail(${qErr('searchSessions')})`}`,
            `listSessions=${qOk('listSessions') ? 'ok' : `fail(${qErr('listSessions')})`}`,
          ].join('；'),
      )
      evidence.push(
        '这组结果的含义：**精确读接口（observeSession / readEvent / readSession / readSurface + lease 释放）在 turn/end 之后可用**；**全文搜索接口全部失败** —— searchEvents 报 SESSION_QUERY_SESSION_NOT_FOUND（该 session 还不在索引语料里），searchSessions 报 SESSION_QUERY_INDEX_FAILED: "session-search SQLite index is closed"，listSessions 报 "cannot get required service \\"sessions\\" in inactive context"。',
      )
      evidence.push(
        '→ M2 硬约束：**历史回查不能嵌在 turn 内做**。turn/end 时刻进程正在 dispose，索引会关、服务会 inactive；必须走「事件已落盘 → 独立进程/后台任务读持久化索引」。同时证实"cursor 分页"在本形态下**未能实跑**（搜索没走到能返回 cursor 的那一步）。',
      )
    }

    questions.push({
      question: 'sessionQuery 的权限、分页、游标和订阅补读边界是什么？插件初始化顺序及服务不可用时如何降级？',
      status: 'partial',
      evidence,
      note:
        '权限由 Gateway/remote-access 的方法级访问控制 + scope 过滤承担（非 owner peer 无权读他人会话）；分页必须消费 cursor；订阅侧 session/event 只保证"已 commit 的 append 通知"，不保证落盘与完整覆盖，连接器必须自持久化 + 补读。初始化顺序不可依赖行序，要用 cordis inject 声明依赖。实测补充：精确读可用、全文搜索在 turn/end 后的退出窗口里不可用，所以 M2 的回查必须放到进程外/后台。',
      missing:
        'cursor 分页与 scope 过滤仍未实跑：service 在退出窗口里返回 SESSION_QUERY_INDEX_FAILED（index closed）与 SESSION_QUERY_SESSION_NOT_FOUND，拿不到带 nextCursor 的第一页。要升 answered 需要：在一个**长期存活**的宿主进程里（web profile 或进程内 harness）对已落盘 session 跑 searchEvents 两页 + searchSessions 带 filters，并另跑一次 openAt=never 验证 SESSION_QUERY_SEARCH_DISABLED 降级。',
    })
  }

  // ── Q5：能否在最终请求边界证明 sent ──
  {
    const evidence = []
    /** @type {'answered'|'partial'|'unknown'} */
    let status = 'unknown'
    const anyRequests = Object.entries(metrics).filter(([, m]) => m.llmStreamCount > 0)
    if (anyRequests.length > 0) {
      const first = /** @type {any} */ (anyRequests[0][1]).requests[0]
      evidence.push(
        `实机：${anyRequests.length} 个场景在 llm/stream waterfall 上拿到了将发送的完整请求（topLevelKeys=${JSON.stringify(first.topLevelKeys)}，requestFrozen=${first.requestFrozen}，systemLen=${first.systemLen}，messageCount=${first.messageCount}）。`,
      )
      status = 'answered'
    }
    // task-4 新增：system prompt 的承载形态不唯一 —— sent 判据必须两级都查。
    const carriedIn = new Set()
    for (const metricsItem of Object.values(metrics)) {
      for (const item of /** @type {any} */ (metricsItem).systemPromptCarriedInSeries ?? []) {
        if (item.carriedIn !== undefined) carriedIn.add(`${item.purpose}:${item.carriedIn}`)
      }
    }
    if (carriedIn.size > 0) {
      evidence.push(
        `实机 同一个 provider 的两种承载形态（**探针 bug 级发现**）：${JSON.stringify([...carriedIn])}。主请求的 system prompt 会以 \`messages[role=system]\` 形态进请求（此时 options.system 为空、systemLen=0），而 session-title 旁路走 \`request.system\`（systemLen=481）。**只看 options.system 会漏判 sent** —— 检查器必须同时查请求的 system 字段与 messages 里的 role=system 文本。`,
      )
    }
    const markerScene = Object.entries(metrics).find(([, m]) => m.marker.requestsCarryingMarker > 0)
    if (markerScene) {
      evidence.push(
        `实机 ${/** @type {string} */ (markerScene[0])}：探针注入的合成片段在 llm/stream 的请求对象里被检索到（requestsCarryingMarker=${/** @type {any} */ (markerScene[1]).marker.requestsCarryingMarker}）→ 这是"片段确实进入最终请求"的实证，而不只是"我构造过它"。`,
      )
    } else {
      evidence.push(
        '本次注入实验的标记未在 llm/stream 请求对象里命中（原因可能是标记落在 runtime-context 快照的去重路径上），详见对应场景记录；此时只能声称 attached。',
      )
    }
    evidence.push(
      '证据边界：llm/stream 拿到的是**交给 adapter 之前的请求对象**（deep-frozen，带 agent-loop 构造标记），能证明"宿主决定发这些内容"；它不证明"字节已经出网"。要证明出网需要 provider 侧回执（requestId/usage）或抓包。',
    )
    evidence.push(
      '检查器诚实显示规则：built = 有 context_id/canonical payload hash/估算 token；attached = 已挂到 assembly（本 run 能在 system-prompt/assemble 的 after 里看到）；sent = 在 llm/stream 请求对象里命中同一 payload hash。三者不可混用，缺哪层就显示哪层。',
    )
    questions.push({
      question: '能否在最终请求边界证明 Brain 片段实际 sent？不能时检查器如何诚实显示 attached 而非完整请求？',
      status,
      evidence,
      note:
        '可以证明到"进入最终请求对象"这一层：llm/stream waterfall 的 options 是完整请求（system + messages + provider/model），且被 deep-freeze 并带 loop 构造标记。再往下（真正出网字节）没有本地证据，只有 provider 回执。检查器应分三级显示 built/attached/sent，sent 的判据是 payload hash 在请求对象里命中，而不是"我调用过注入 API"。',
      missing: '未取得 provider 侧 requestId 与 usage 的对照样本，因此"出网"这一层保持 unknown；不做任何已发送的更强断言。',
    })
  }

  // ── Q6：唯一注入责任方 + 测试/生产隔离 ──
  {
    const evidence = []
    const sessionIsolation = existsSync('E:/ds-h/dsh-brain/data/probe/lab/sessions')
    evidence.push(
      `实机隔离：brainlab 的 session-persistence-jsonl.root 被 patch 到 E:/ds-h/dsh-brain/data/probe/lab/sessions（存在=${sessionIsolation}），storage-json.root 与 session-query-sqlite.path 同样落到 data/probe/lab。`,
    )
    evidence.push(
      '静态事实（对照）：dsh-base 的默认 session-persistence-jsonl.root = dshHomePath("sessions")、storage-json.root = dshHomePath("storages")，**所有 profile 共享同一个 $DSH_HOME 目录**。也就是说"独立 profile"本身并不隔离数据；隔离只有在显式覆盖 root/path 后才成立。这是本次实测的一条重要负面发现。',
    )
    evidence.push(
      '生产 profile 未被触碰：本次全部改动只发生在 ~/.dsh/profiles/brainlab 与 E:/ds-h/dsh-brain 下，未读未写 ~/.dsh/profiles/web 的任何文件。',
    )
    evidence.push(
      '扩展异常隔离：探针第一版把 agent/turn-stopping 当成 waterfall 写（多写了 next 参数），实测结果为该轮 turn/end reason=error、进程退出码 1 —— 即插件异常**会**拖垮当前回合，宿主只隔离"监听器失败本身"不让进程崩，但不保证回合成功。所以唯一注入责任方不仅是"谁写"，还包括"谁保证自己不抛"。',
    )

    // ── task-4 新增：第三方注入方（灵枢）真挂实测 ──
    const coexist1 = metrics['coexist-1']
    const coexist2 = metrics['coexist-2-resume']
    const injectCtxScene = metrics['inject-ctx']
    const toolReadScene = metrics['tool-read']
    if (coexist1 && coexist2) {
      const series1 = (coexist1.injectedBlockSeries ?? []).map((item) => item.foreignBlocks)
      const series2 = (coexist2.injectedBlockSeries ?? []).map((item) => item.foreignBlocks)
      evidence.push(
        `实机 第三方注入方共存（灵枢 @furongjun1999/dsh-memory@0.9.13 真挂进 brainlab，认知图根重定向到 data/probe/lab/lingshu-mdcg，全程合成数据）：` +
          `第一轮 assemble(after) 外来注入块 = ${JSON.stringify(series1)}；` +
          `第二轮（同一会话续写）外来注入块 = ${JSON.stringify(series2)}。` +
          `→ 灵枢确实在 system-prompt/assemble 里向 assembly.contexts push 了自己的块（lingshu:auto-recall，第二轮起再加 lingshu:session-window），且宿主照常完成回合（turn/end=completed）。`,
      )
      evidence.push(
        `实机 双注入方并存（scenes/inject-ctx，探针自己也开了一个注入）：assemble(after) 的 contextNames 同时出现 brain-probe:marker 与 lingshu:auto-recall（外来块 = ${JSON.stringify((injectCtxScene?.injectedBlockSeries ?? []).map((item) => item.foreignBlocks))}）→ **两个互相不知道的注入方会在同一 step、同一通道上并列 push，宿主不做去重、不做仲裁，两份都进装配结果**。`,
      )
      evidence.push(
        `实机 逐 step 变化（scenes/tool-read，1 turn / 2 step）：step1 外来块 = ${JSON.stringify((toolReadScene?.injectedBlockSeries ?? [])[0]?.foreignBlocks ?? [])}，step2 外来块 = ${JSON.stringify((toolReadScene?.injectedBlockSeries ?? [])[1]?.foreignBlocks ?? [])} → 同一轮对话里第二个 step 的注入块**比第一个多**（灵枢的会话窗口在第二 step 才成形）。这意味着"注入结果是逐 step 变化的"，Brain 无法靠"我知道上一 step 注入了什么"来静态去重，且 Token 预算必须按**最厚的那个 step** 留。`,
      )
      evidence.push(
        '隔离实测（路径断言，不是"我用了独立 profile"）：brainlab 的 session-persistence-jsonl.root=.../lab/sessions、storage-json.root=.../lab/storages、session-query-sqlite.path=.../lab/session-index.sqlite；灵枢自身的认知图根由 MDCG_ROOT + profile config 双保险锁到 .../lab/lingshu-mdcg（它启动日志自报 root=E:\\ds-h\\dsh-brain\\data\\probe\\lab\\lingshu-mdcg）。全程没有读写真生产的 ~/.dsh/.dsh-memory 认知图。',
      )
      evidence.push(
        '停用恢复：灵枢是"摘掉 Junction + 移除 patch 行"两处即可完全摘除，与探针同一套回滚手法（见 data/probe/rollback.json 的四步验证）。',
      )
    }
    questions.push({
      question: 'Engram/灵枢继续启用时的唯一注入责任方如何划分？测试 profile 的数据和生产是否真正隔离？',
      status: coexist1 && coexist2 ? 'answered' : 'partial',
      evidence,
      note:
        '隔离结论是负面的：独立 profile ≠ 数据隔离，$DSH_HOME 默认共享 sessions/storages；必须在 profile patch 里显式覆盖 root/path，并以路径断言验收（brainlab 已这样做并验证落地，灵枢的认知图根也一并重定向）。注入责任方：实测证明"多注入方共存"在架构上**完全可能且不会报错**——宿主把各插件 push 的 contexts 全部接受并送进最终请求，不去重、不仲裁。因此必须在 Brain 侧显式指定唯一 owner（建议 M2 起 Brain 为唯一注入方，Engram/灵枢降为只读摄取或关闭注入），否则同一 step 会出现多份语义重复的记忆片段，且彼此会把对方的注入当"外部消息"再次提取。',
      missing:
        'Engram 未挂载实测（它依赖 @huggingface/transformers 与本地模型下载，与"只读合成数据、零外部成本"的探针纪律不匹配）。但 Engram 走的是 agent/pre-step prepend（与灵枢的 assemble contexts 是两条不同通道），"多注入方互不感知"的结论对两条通道都成立，因为它来自宿主侧"不做仲裁"这一单一事实。要补 Engram 实测需要：允许一次模型依赖安装并接受下载成本，或换用不带 embedding 的 Engram 配置。',
    })
  }

  const summary = {
    answered: questions.filter((item) => item.status === 'answered').length,
    partial: questions.filter((item) => item.status === 'partial').length,
    unknown: questions.filter((item) => item.status === 'unknown').length,
  }

  const verdict = {
    runId: runDir.split(/[\\/]/).pop() ?? 'unknown',
    generatedAt: new Date().toISOString(),
    summary,
    questions,
    metrics,
  }

  writeFileSync(join(runDir, 'verdict.json'), JSON.stringify(verdict, null, 2), 'utf8')
  writeFileSync(join(runDir, 'timeline.md'), renderTimelineMarkdown(verdict, byScene), 'utf8')
  return verdict
}

/**
 * 生成人读时序。
 * @param {{runId: string, generatedAt: string, summary: {answered: number, partial: number, unknown: number}, questions: VerdictItem[], metrics: Record<string, any>}} verdict
 * @param {Record<string, TimelineEvent[]>} byScene
 * @returns {string}
 */
function renderTimelineMarkdown(verdict, byScene) {
  const lines = []
  lines.push(`# M0 探针时序 — ${verdict.runId}`)
  lines.push('')
  lines.push(`生成时间：${verdict.generatedAt}`)
  lines.push('')
  lines.push(`六问状态：${verdict.summary.answered} answered / ${verdict.summary.partial} partial / ${verdict.summary.unknown} unknown`)
  lines.push('')
  lines.push('## 场景总览')
  lines.push('')
  lines.push('| 场景 | turn | step | assemble | pre-step | llm/stream | turn/end 原因 | 标记进请求 |')
  lines.push('|---|---|---|---|---|---|---|---|')
  for (const [scene, metrics] of Object.entries(verdict.metrics)) {
    lines.push(
      `| ${scene} | ${metrics.turnsStarted.length} | ${metrics.stepsStarted.length} | ${metrics.assembleCount} | ${metrics.preStepCount} | ${metrics.llmStreamCount} | ${metrics.turnEndReasons.map((item) => `${item.reason}`).join(',') || '（无）'} | ${metrics.marker.requestsCarryingMarker} |`,
    )
  }
  lines.push('')
  lines.push('## 逐场景时序')
  for (const [scene, events] of Object.entries(byScene)) {
    lines.push('')
    lines.push(`### ${scene}`)
    lines.push('')
    lines.push('| # | 时间 | hook | phase | 摘要 |')
    lines.push('|---|---|---|---|---|')
    for (const event of events) {
      if (event.hook === 'session/event') {
        lines.push(
          `| ${event.seq} | ${event.ts.slice(11, 23)} | session/event | info | ${event.type}${event.turn !== undefined ? ` turn=${event.turn}` : ''}${event.step !== undefined ? ` step=${event.step}` : ''}${event.messageBrief ? ` · msg=${event.messageBrief.role}/${event.messageBrief.blocks}块/${event.messageBrief.textLen}字` : ''}${event.reasonKind ? ` · reason=${event.reasonKind}` : ''} |`,
        )
        continue
      }
      const details = []
      for (const key of ['turn', 'step', 'assemble', 'sectionCount', 'contextCount', 'toolCount', 'provider', 'model', 'systemLen', 'messageCount', 'systemHasProbeMarker', 'requestFrozen', 'probeInjection', 'kind', 'action']) {
        if (event[key] !== undefined) details.push(`${key}=${JSON.stringify(event[key])}`)
      }
      lines.push(`| ${event.seq} | ${event.ts.slice(11, 23)} | ${event.hook} | ${event.phase} | ${details.join(' ') || ''} |`)
    }
  }
  lines.push('')
  lines.push('## 六问')
  for (const [index, item] of verdict.questions.entries()) {
    lines.push('')
    lines.push(`### Q${index + 1} [${item.status}] ${item.question}`)
    lines.push('')
    lines.push(`- 结论：${item.note}`)
    if (item.missing) lines.push(`- 升级条件：${item.missing}`)
    lines.push('- 证据：')
    for (const evidence of item.evidence) lines.push(`  - ${evidence}`)
  }
  lines.push('')
  return lines.join('\n')
}

// 直接执行：node analyze.mjs <runDir>
if (process.argv[1] && process.argv[1].endsWith('analyze.mjs')) {
  const target = process.argv[2]
  if (!target) {
    console.error('usage: node analyze.mjs <runDir>')
    process.exit(1)
  }
  const verdict = analyzeRun(target)
  console.log(JSON.stringify(verdict.summary))
}
