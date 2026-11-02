// @ts-check
/**
 * helpers.mjs — M2 连接器测试用的假宿主。
 *
 * 为什么要有这套假件：连接器的全部风险都在「跟宿主装配点的形状对齐」上。
 * 我们要能在**不启动 dsh** 的情况下复现 M0 实测到的语义：
 *   - waterfall 是同步组合（spread 最后一个参数是 next），listener 的返回值
 *     直接透传，由最外层 await；
 *   - serial 不传 next（`agent/turn-stopping`）；
 *   - emit 不关心返回值（`session/event`）；
 *   - agent 事件 payload 里被 fused 注入 `agent` 字段，sessionId 在 `agent.session.id`；
 *   - assemble 阶段 `agent.phase.step` 还是**上一个** step（当前 = +1）。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * 假 cordis Context：只实现连接器用到的 `on` / `logger`。
 * @param {{ logger?: { info?: Function, warn?: Function } }} [options]
 */
export function createFakeCtx(options = {}) {
  /** @type {Map<string, Function[]>} */
  const handlers = new Map()
  /** @type {string[]} */
  const registered = []
  const ctx = {
    handlers,
    registered,
    logger: {
      info: options.logger?.info ?? (() => {}),
      warn: options.logger?.warn ?? (() => {}),
    },
    /**
     * @param {string} event
     * @param {Function} callback
     */
    on(event, callback) {
      if (!handlers.has(event)) handlers.set(event, [])
      handlers.get(event).push(callback)
      registered.push(event)
      return () => {
        const list = handlers.get(event) ?? []
        const index = list.indexOf(callback)
        if (index >= 0) list.splice(index, 1)
      }
    },
  }
  return ctx
}

/**
 * 按 cordis 语义跑一次 waterfall：注册顺序外→内，最后一个参数是 next。
 *
 * cordis 的真实实现（`cordis/lib/index.js` 的 `waterfall`）：
 *   `const next = () => (cbs.shift() ?? inner)(...args)`，且 `args` 末尾已经 push 了 next。
 * 所以每个 listener 收到 `(...原参数, next)`，返回值**不 await 展开**（由最外层 await）。
 * @param {ReturnType<typeof createFakeCtx>} ctx
 * @param {string} event
 * @param {any[]} args 不含 next
 * @param {(...args: any[]) => any} inner
 * @returns {any}
 */
export function runWaterfall(ctx, event, args, inner) {
  const callbacks = [...(ctx.handlers.get(event) ?? [])]
  let index = 0
  const next = () => {
    const callback = callbacks[index++] ?? inner
    return callback(...args, next)
  }
  return next()
}

/**
 * 按 cordis 语义跑一次 serial：顺序执行、每个返回值 await、没有 next。
 * @param {ReturnType<typeof createFakeCtx>} ctx
 * @param {string} event
 * @param {any[]} args
 * @returns {Promise<void>}
 */
export async function runSerial(ctx, event, args) {
  for (const callback of [...(ctx.handlers.get(event) ?? [])]) {
    await callback(...args)
  }
}

/**
 * 按 cordis 语义跑一次 emit：fire-and-forget，错误被隔离。
 * @param {ReturnType<typeof createFakeCtx>} ctx
 * @param {string} event
 * @param {any[]} args
 */
export function runEmit(ctx, event, args) {
  for (const callback of [...(ctx.handlers.get(event) ?? [])]) {
    try {
      const returned = callback(...args)
      if (returned !== null && typeof returned === 'object' && typeof returned.then === 'function') {
        returned.catch(() => {})
      }
    } catch {
      /* 宿主隔离监听器异常 */
    }
  }
}

/**
 * 假 agent。形状照宿主实测：
 *   - `session.id` 是会话主账键
 *   - `phase = {kind:'running', turn, step}`，step 是「上一个已完成的 step」
 * @param {{ sessionId?: string, turn?: number, previousStep?: number, kind?: string }} [options]
 */
export function createFakeAgent(options = {}) {
  const sessionId = options.sessionId ?? 'session-synthetic-0001'
  const turn = options.turn ?? 1
  const previousStep = options.previousStep ?? 0
  return {
    id: `agent-${sessionId}`,
    session: { id: sessionId },
    phase: { kind: options.kind ?? 'running', turn, step: previousStep },
  }
}

/**
 * 假 ContextPackage（形状按 docs/M2-INTERFACES.md §2，但故意只填连接器会用到的字段）。
 * @param {{ contextId?: string, summary?: string, segments?: any[], status?: string, injectedText?: string }} [options]
 */
export function fakePackage(options = {}) {
  const contextId = options.contextId ?? 'ctx-synthetic-0001'
  const segments = options.segments ?? [
    {
      memoryId: 'mem-1',
      version: 3,
      layer: 'long',
      type: 'semantic',
      summary: options.summary ?? '踢脚线报价按 1.2m 段计，2400×600 板材损耗 8%',
      contentHash: 'sha256:abcdef0123456789',
      sourceRefs: [{ sourceSystem: 'dsh', sourceEventId: '12' }],
      evidenceKind: 'owner_words',
      validFrom: '2026-10-01T00:00:00.000Z',
      validUntil: null,
    },
  ]
  return {
    contextId,
    builtAt: '2026-10-28T10:00:00.000Z',
    policyVersion: 'm2.0',
    scopeId: 'owner-default',
    personId: 'owner',
    sessionId: 'session-synthetic-0001',
    turnId: 1,
    stepId: 1,
    segments,
    injectedText: options.injectedText ?? '',
    estimatedTokens: 42,
    tokenizerId: 'estimate:chars/2.5',
    canonicalHash: 'sha256:1111222233334444',
    budget: { brainAllowance: 2048, used: 42, dropped: [] },
    diagnostics: { status: options.status ?? 'ok', reasons: [] },
    status: 'built',
  }
}

/**
 * 一个临时队列目录（测试后自动清理）。
 * @returns {{ dir: string, cleanup: () => void }}
 */
export function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'brain-connector-test-'))
  return {
    dir,
    cleanup() {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 清理失败不影响测试结论 */
      }
    },
  }
}

/**
 * 一条 user/message 事件（形状照 SessionEvent）。
 * @param {{ seq?: number, text?: string, sourceKind?: string, sourceForm?: string, turn?: number, step?: number }} [options]
 */
export function userMessageEvent(options = {}) {
  return {
    type: 'user/message',
    seq: options.seq ?? 3,
    time: Date.UTC(2026, 9, 28, 10, 0, 0),
    surfaceOp: 'append',
    data: {
      message: {
        id: `msg-${options.seq ?? 3}`,
        role: 'user',
        content: [{ type: 'text', text: options.text ?? '帮我算一下 2400×600 的板材用量' }],
        source: {
          kind: options.sourceKind ?? 'user',
          ...(options.sourceForm === undefined ? {} : { form: options.sourceForm }),
        },
      },
      turn: options.turn ?? 1,
      step: options.step ?? 1,
    },
  }
}

/**
 * 一条 turn/start 事件。
 * @param {{ seq?: number, turn?: number }} [options]
 */
export function turnStartEvent(options = {}) {
  return { type: 'turn/start', seq: options.seq ?? 1, time: Date.UTC(2026, 9, 28, 10, 0, 0), data: { turn: options.turn ?? 1 } }
}

/**
 * 一条 step/start 事件。
 * @param {{ seq?: number, turn?: number, step?: number }} [options]
 */
export function stepStartEvent(options = {}) {
  return {
    type: 'step/start',
    seq: options.seq ?? 2,
    time: Date.UTC(2026, 9, 28, 10, 0, 0),
    data: { turn: options.turn ?? 1, step: options.step ?? 1 },
  }
}

/**
 * 一条 turn/end 事件。
 * @param {{ seq?: number, turn?: number, reason?: string }} [options]
 */
export function turnEndEvent(options = {}) {
  return {
    type: 'turn/end',
    seq: options.seq ?? 9,
    time: Date.UTC(2026, 9, 28, 10, 0, 1),
    data: { turn: options.turn ?? 1, reason: { kind: options.reason ?? 'completed' } },
  }
}

/**
 * 假 session 对象（`session.id` 是主账键）。
 * @param {string} [id]
 */
export function fakeSession(id = 'session-synthetic-0001') {
  return { id }
}

/**
 * 假主账门面（`store.contextPackages.updateStatus`）。
 *
 * 形状照 memory2 的 `store.contextPackages`：`updateStatus(contextId, patch)`。
 * 记录每次调用，便于断言「写进去了什么、按什么顺序」。
 *
 * @param {{ failWith?: string | Error | null, mode?: 'async'|'sync' }} [options]
 *   - `failWith`：非空时每次调用都抛（验「落库失败不许影响宿主」）
 *   - `mode`：'sync' 时 updateStatus 返回 undefined（门面可能是同步实现，必须兼容）
 */
export function fakeStore(options = {}) {
  /** @type {Array<{ contextId: string, patch: Record<string, any>, at: number }>} */
  const calls = []
  /** @type {Map<string, Record<string, any>>} */
  const latest = new Map()
  const failWith = options.failWith ?? null
  const mode = options.mode ?? 'async'

  const updateStatus = (/** @type {string} */ contextId, /** @type {Record<string, any>} */ patch) => {
    if (failWith !== null) {
      const error = failWith instanceof Error ? failWith : new Error(failWith)
      if (mode === 'sync') throw error
      return Promise.reject(error)
    }
    calls.push({ contextId, patch, at: Date.now() })
    latest.set(contextId, { ...(latest.get(contextId) ?? {}), ...patch })
    return mode === 'sync' ? undefined : Promise.resolve({ contextId })
  }

  return {
    calls,
    latest,
    contextPackages: { updateStatus },
  }
}

