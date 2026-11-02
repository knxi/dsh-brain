// @ts-check
/**
 * modes.test.mjs — off / shadow / explicit / automatic 四种模式。
 *
 * 契约 §3.3：默认 `shadow`（只算不注入）；`automatic` 必须先过「无重复注入」测试
 * 才允许单独 profile 开启。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply, MODES } from '../../../apps/connector/index.js'
import { createFakeAgent, createFakeCtx, fakePackage, runWaterfall, tempDir } from './helpers.mjs'

const SESSION = 'session-synthetic-0001'

/** @param {Record<string, any>} [config] */
function boot(config = {}) {
  const temp = tempDir()
  const ctx = createFakeCtx()
  const runtime = apply(ctx, { logLevel: 'silent', dir: temp.dir, ...config })
  return { ctx, runtime, cleanup: temp.cleanup }
}

/** @param {ReturnType<typeof createFakeCtx>} ctx @param {any} agent */
async function assemble(ctx, agent) {
  const assembly = { sections: [{ name: 'S', text: 's' }], contexts: [], tools: [], variables: {} }
  return runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
}

test('四种模式常量齐备，默认是 shadow', () => {
  assert.deepEqual([...MODES], ['off', 'shadow', 'explicit', 'automatic'])
  const { runtime, cleanup } = boot()
  assert.equal(runtime.mode, 'shadow')
  cleanup()
})

test('off：一个 hook 都不注册', () => {
  const { ctx, runtime, cleanup } = boot({ mode: 'off' })
  assert.deepEqual(ctx.registered, [])
  assert.equal(runtime.mode, 'off')
  cleanup()
})

test('shadow：算出「本来会注入什么」但绝不改宿主对象', async () => {
  const { ctx, runtime, cleanup } = boot({ mode: 'shadow' })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-shadow-0001' }), { sessionId: SESSION, turn: 1, step: 1 })

  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const out = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))

  assert.equal(out, assembly, 'shadow 必须返回宿主原对象')
  assert.equal(out.contexts.length, 0)
  assert.equal(runtime.stats.injectedContexts, 0)
  const shadowTrace = runtime.traces.find((trace) => trace.hook === 'assemble.inject.shadow')
  assert.ok(shadowTrace !== undefined, 'shadow 模式要留下「本应注入」的指标')
  assert.equal(shadowTrace.wouldInject, true)
  assert.equal(shadowTrace.contextId, 'ctx-shadow-0001')
  assert.ok(Number(shadowTrace.estimatedTokens) > 0)
  assert.equal(runtime.slots.size, 1, 'shadow 只能 peek，不能把包吃掉')
  cleanup()
})

test('explicit：只有别人 supply 的包才会注入', async () => {
  const { ctx, runtime, cleanup } = boot({ mode: 'explicit' })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })

  const withoutSlot = await assemble(ctx, agent)
  assert.equal(withoutSlot.contexts.length, 0, '没递包就不注入')

  runtime.supply(fakePackage({ contextId: 'ctx-explicit-0001' }), { sessionId: SESSION, turn: 1, step: 1 })
  const withSlot = await assemble(ctx, agent)
  assert.equal(withSlot.contexts.length, 1)
  assert.ok(withSlot.contexts[0].text.includes('ctx-explicit-0001'))
  cleanup()
})

test('automatic：用 buildPackage 自动构包，并拿到 query', async () => {
  /** @type {Array<Record<string, any>>} */
  const requests = []
  const { ctx, runtime, cleanup } = boot({
    mode: 'automatic',
    buildPackage(input) {
      requests.push(input)
      return fakePackage({ contextId: 'ctx-auto-0001' })
    },
  })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })

  // 先让一条人类消息进 query 缓存（automatic 构包要用它）
  const { runEmit, fakeSession, userMessageEvent } = await import('./helpers.mjs')
  runEmit(ctx, 'session/event', [fakeSession(SESSION), userMessageEvent({ seq: 1, text: '踢脚线 1.2m 怎么算' })])

  const out = await assemble(ctx, agent)
  assert.equal(out.contexts.length, 1)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].sessionId, SESSION)
  assert.equal(requests[0].turnId, 1)
  assert.equal(requests[0].stepId, 1)
  assert.equal(requests[0].query, '踢脚线 1.2m 怎么算')
  assert.equal(runtime.stats.injectedContexts, 1)
  cleanup()
})

test('automatic 返回 null（检索不足/无相关记忆）时不注入，也不报错', async () => {
  const { ctx, runtime, cleanup } = boot({ mode: 'automatic', buildPackage: () => null })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  const out = await assemble(ctx, agent)
  assert.equal(out.contexts.length, 0)
  assert.equal(runtime.stats.errors, 0)
  cleanup()
})

test('非法 mode 降级为 shadow 而不是抛（加载期也不能炸）', () => {
  const { ctx, runtime, cleanup } = boot({ mode: 'whatever' })
  assert.equal(runtime.mode, 'shadow')
  assert.equal(ctx.registered.length, 5)
  cleanup()
})

test('非法 injectChannel 降级为 contexts', () => {
  const { runtime, cleanup } = boot({ injectChannel: 'http-header' })
  assert.equal(runtime.diagnostics().injectChannel, 'contexts')
  cleanup()
})

test('diagnostics 不含正文，只给计数与最近错误', async () => {
  const { ctx, runtime, cleanup } = boot({ mode: 'automatic', buildPackage: () => fakePackage({ contextId: 'ctx-diag' }) })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  await assemble(ctx, agent)
  const diagnostics = runtime.diagnostics()
  assert.equal(diagnostics.mode, 'automatic')
  assert.equal(typeof diagnostics.stats.injectedContexts, 'number')
  assert.equal(Array.isArray(diagnostics.errors), true)
  const serialized = JSON.stringify(diagnostics)
  assert.equal(serialized.includes('踢脚线'), false, '诊断信息不得带记忆正文')
  cleanup()
})
