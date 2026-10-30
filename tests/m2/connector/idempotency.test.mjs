// @ts-check
/**
 * idempotency.test.mjs — 按 `(sessionId, turnId, stepId)` 幂等。
 *
 * 契约 10.1 的实测事实：`system-prompt/assemble` 与 `agent/pre-step` 是**每 step
 * 一次**，不是每轮一次；多步回合的第 2 个 step 会重新装配整个 system prompt、
 * 重过 pre-step waterfall。
 *
 * 这里用一套「假 watermark harness」复现这个推进节奏：
 *   - assemble 阶段宿主的 `agent.phase.step` 还是**上一个** step（当前 = +1）；
 *   - 同一 step 内宿主可能重复调用（重试路径在 `refreshContext`，但故障恢复路径
 *     可能重新装配）—— 重复调用绝不能重复注入；
 *   - 不同 step / 不同 turn 各自注入一次。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../../apps/connector/index.js'
import { createFakeAgent, createFakeCtx, fakePackage, runWaterfall, tempDir } from './helpers.mjs'

const SESSION = 'session-synthetic-0001'

/**
 * 启动一个连接器实例。
 * @param {Record<string, any>} [config]
 */
function boot(config = {}) {
  const temp = tempDir()
  const ctx = createFakeCtx()
  const runtime = apply(ctx, { logLevel: 'silent', dir: temp.dir, mode: 'explicit', ...config })
  return { ctx, runtime, cleanup: temp.cleanup }
}

/**
 * @param {ReturnType<typeof createFakeCtx>} ctx
 * @param {any} agent
 * @param {{ turn: number, step: number }} position
 * @param {any[]} baseContexts
 */
async function assembleOnce(ctx, agent, position, baseContexts = []) {
  const assembly = { sections: [{ name: 'S', text: 's' }], contexts: [...baseContexts], tools: [], variables: {} }
  return runWaterfall(
    ctx,
    'system-prompt/assemble',
    [assembly, { agent }],
    () => Promise.resolve(assembly),
  )
}

/**
 * @param {ReturnType<typeof createFakeCtx>} ctx
 * @param {any} agent
 * @param {{ turn: number, step: number }} position
 */
async function preStepOnce(ctx, agent, position) {
  const payload = {
    messages: [{ id: 'host-msg', role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    turn: position.turn,
    step: position.step,
    signal: new AbortController().signal,
    agent,
  }
  return runWaterfall(
    ctx,
    'agent/pre-step',
    [payload],
    () => Promise.resolve({ kind: 'enter', messages: payload.messages }),
  )
}

test('同一 step 重复 assemble 三次，只注入一次', async () => {
  const { ctx, runtime, cleanup } = boot()
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-idem-0001' }), { sessionId: SESSION, turn: 1, step: 1 })

  const first = await assembleOnce(ctx, agent, { turn: 1, step: 1 })
  const second = await assembleOnce(ctx, agent, { turn: 1, step: 1 })
  const third = await assembleOnce(ctx, agent, { turn: 1, step: 1 })

  assert.equal(first.contexts.length, 1)
  assert.equal(second.contexts.length, 0, '第二次重复装配不得重复注入')
  assert.equal(third.contexts.length, 0)
  assert.equal(runtime.stats.injectedContexts, 1)
  assert.equal(runtime.stats.skippedDuplicate, 2)
  cleanup()
})

test('同一 step 里 assemble 注入后，pre-step 不会二次注入（通道互斥 + 账本双闸）', async () => {
  const { ctx, runtime, cleanup } = boot()
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-idem-0002' }), { sessionId: SESSION, turn: 1, step: 1 })

  const assembly = await assembleOnce(ctx, agent, { turn: 1, step: 1 })
  const decision = await preStepOnce(ctx, agent, { turn: 1, step: 1 })

  assert.equal(assembly.contexts.length, 1)
  assert.equal(decision.messages.length, 1, 'pre-step 的 messages 不应再被追加')
  assert.equal(runtime.stats.injectedContexts, 1)
  assert.equal(runtime.stats.injectedMessages, 0)
  cleanup()
})

test('injectChannel=pre-step 时只走 pre-step 通道，重复调用不重复注入', async () => {
  const { ctx, runtime, cleanup } = boot({ injectChannel: 'pre-step' })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-idem-0003' }), { sessionId: SESSION, turn: 1, step: 1 })

  const assembly = await assembleOnce(ctx, agent, { turn: 1, step: 1 })
  assert.equal(assembly.contexts.length, 0, 'pre-step 通道下 assemble 不得注入')

  const first = await preStepOnce(ctx, agent, { turn: 1, step: 1 })
  const second = await preStepOnce(ctx, agent, { turn: 1, step: 1 })
  assert.equal(first.messages.length, 2)
  assert.equal(second.messages.length, 1, '同一 step 重复 pre-step 不得重复注入')
  assert.equal(runtime.stats.injectedMessages, 1)
  cleanup()
})

test('多 step / 多 turn 的 watermark 推进：每个 step 各注入一次，共 3 次', async () => {
  const { ctx, runtime, cleanup } = boot()

  // turn 1 / step 1（单步回合）
  const agentStep1 = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-wm-1-1' }), { sessionId: SESSION, turn: 1, step: 1 })
  const t1s1 = await assembleOnce(ctx, agentStep1, { turn: 1, step: 1 })
  assert.equal(t1s1.contexts.length, 1)
  // 宿主重复装配一次（同一 step）
  const t1s1again = await assembleOnce(ctx, agentStep1, { turn: 1, step: 1 })
  assert.equal(t1s1again.contexts.length, 0)

  // turn 1 / step 2（工具调用之后的第 2 个 step：重新装配整个 prompt）
  const agentStep2 = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 1 })
  runtime.supply(fakePackage({ contextId: 'ctx-wm-1-2' }), { sessionId: SESSION, turn: 1, step: 2 })
  const t1s2 = await assembleOnce(ctx, agentStep2, { turn: 1, step: 2 })
  assert.equal(t1s2.contexts.length, 1, '第 2 个 step 是新的幂等键，必须重新注入')
  assert.equal(t1s2.contexts[0].text.includes('ctx-wm-1-2'), true)

  // turn 2 / step 1（同一会话续写：新 turn 的键不能撞上一轮）
  const agentTurn2 = createFakeAgent({ sessionId: SESSION, turn: 2, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-wm-2-1' }), { sessionId: SESSION, turn: 2, step: 1 })
  const t2s1 = await assembleOnce(ctx, agentTurn2, { turn: 2, step: 1 })
  assert.equal(t2s1.contexts.length, 1)

  assert.equal(runtime.stats.injectedContexts, 3)
  assert.equal(runtime.stats.skippedDuplicate, 1)
  cleanup()
})

test('assemble 推导出的 step 与随后 pre-step 的 payload.step 一致（phase.step 是上一个 step）', async () => {
  const { ctx, runtime, cleanup } = boot()
  // 这一步既是 assemble 的目标、也是 pre-step 的目标：两者必须算成同一个键，
  // 否则「同一步只占一条通道」的互斥就会失效。
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-key-align' }), { sessionId: SESSION, turn: 1, step: 1 })

  await assembleOnce(ctx, agent, { turn: 1, step: 1 })
  const ledgerAfterAssemble = runtime.ledger.size
  await preStepOnce(ctx, agent, { turn: 1, step: 1 })

  assert.equal(ledgerAfterAssemble, 1, 'assemble 就该记下这一 step 的键')
  assert.equal(runtime.ledger.size, 1, 'pre-step 不能产生第二个键（说明两边算出了同一个 step）')
  const entry = runtime.ledger.recent(1)[0]
  assert.equal(entry.turn, 1)
  assert.equal(entry.step, 1)
  cleanup()
})

test('缺 sessionId 时失败关闭：不注入，只记 skippedIncompleteKey', async () => {
  const { ctx, runtime, cleanup } = boot()
  // 既没有 session、也没有 id 的 agent（拿不到任何会话身份）→ 幂等键不完整
  const agentWithoutSession = { phase: { kind: 'running', turn: 1, step: 0 } }
  runtime.supply(fakePackage({ contextId: 'ctx-no-session' }), { turn: 1, step: 1 })

  const assembly = await assembleOnce(ctx, agentWithoutSession, { turn: 1, step: 1 })
  assert.equal(assembly.contexts.length, 0)
  assert.equal(runtime.stats.injectedContexts, 0)
  assert.ok(runtime.stats.skippedIncompleteKey >= 1)
  assert.equal(runtime.stats.errors, 0, '键不完整不是错误，是正常的失败关闭')
  cleanup()
})

test('explicit 模式 supply 的包被消费一次，不会喂给第二个 step', async () => {
  const { ctx, runtime, cleanup } = boot()
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-once' }), { sessionId: SESSION, turn: 1, step: 1 })

  const first = await assembleOnce(ctx, agent, { turn: 1, step: 1 })
  const agentStep2 = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 1 })
  const second = await assembleOnce(ctx, agentStep2, { turn: 1, step: 2 })

  assert.equal(first.contexts.length, 1)
  assert.equal(second.contexts.length, 0, '一次性供给不该漏到下一步')
  assert.equal(runtime.slots.size, 0)
  cleanup()
})
