// @ts-check
/**
 * hook-shape.test.mjs — 钩子的**形状**本身是否正确。
 *
 * 这一组测试防的是 M0 那次真实事故：把 `agent/turn-stopping`（serial）写成
 * waterfall 签名（多写一个 next 参数）→ `next is not a function` →
 * 整轮 `turn/end reason=error` + 进程退出码 1。
 * 形状错了，功能再对也是零分。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../../apps/connector/index.js'
import { createFakeAgent, createFakeCtx, fakePackage, fakeSession, runEmit, runSerial, runWaterfall, tempDir } from './helpers.mjs'

/** @returns {{ ctx: ReturnType<typeof createFakeCtx>, runtime: any, dir: string, cleanup: () => void }} */
function boot(config = {}) {
  const temp = tempDir()
  const ctx = createFakeCtx()
  const runtime = apply(ctx, { logLevel: 'silent', dir: temp.dir, ...config })
  return { ctx, runtime, dir: temp.dir, cleanup: temp.cleanup }
}

test('插件导出 cordis 要求的 name / inject / apply 三件套', async () => {
  const module = await import('../../../apps/connector/index.js')
  assert.equal(typeof module.name, 'string')
  assert.ok(module.name.length > 0)
  assert.ok(Array.isArray(module.inject))
  assert.equal(typeof module.apply, 'function')
  // 不导出 Config：cordis 会把导出的 Config 当 schemastery schema 去 validate
  assert.equal(module.Config, undefined)
})

test('恰好注册五个钩子，事件名与分发模式对得上', () => {
  const { ctx, cleanup } = boot()
  assert.deepEqual(ctx.registered, [
    'system-prompt/assemble',
    'agent/pre-step',
    'llm/stream',
    'session/event',
    'agent/turn-stopping',
  ])
  cleanup()
})

test('agent/turn-stopping 按 serial 调用（没有 next）不报错', async () => {
  const { ctx, runtime, cleanup } = boot({ mode: 'explicit' })
  // 宿主对 serial 事件不传 next。若监听器写成 (payload, next) 并 await next()，
  // 这里会直接 TypeError —— 正是 M0 那个坑。
  await runSerial(ctx, 'agent/turn-stopping', [{ turn: 1, signal: new AbortController().signal, agent: createFakeAgent() }])
  assert.equal(runtime.stats.turnStoppingCalls, 1)
  assert.equal(runtime.stats.errors, 0)
  assert.equal(runtime.errors.length, 0)
  cleanup()
})

test('system-prompt/assemble 是 waterfall：await next() 后返回装配结果', async () => {
  const { ctx, cleanup } = boot({ mode: 'shadow' })
  const assembly = {
    sections: [{ name: 'HARNESS_IDENTITY', text: 'identity' }],
    contexts: [{ name: 'WORKING_DIRECTORY', text: 'cwd' }],
    tools: [],
    variables: {},
  }
  const output = await runWaterfall(
    ctx,
    'system-prompt/assemble',
    [assembly, { agent: createFakeAgent() }],
    () => Promise.resolve(assembly),
  )
  assert.equal(output.sections.length, 1)
  assert.equal(output.contexts.length, 1)
  cleanup()
})

test('agent/pre-step 是 waterfall，且 reject 决策原样透传（不包装成 enter）', async () => {
  const { ctx, cleanup } = boot({ mode: 'explicit' })
  const reject = { kind: 'reject', reason: { kind: 'no-input' } }
  const output = await runWaterfall(
    ctx,
    'agent/pre-step',
    [{ messages: [], turn: 1, step: 1, signal: new AbortController().signal, agent: createFakeAgent() }],
    () => Promise.resolve(reject),
  )
  assert.deepEqual(output, reject)
  cleanup()
})

test('llm/stream 同步透传：返回值就是 next() 的返回值（不是被 await 成 Promise）', () => {
  const { ctx, cleanup } = boot({ mode: 'shadow' })
  // 宿主的 llm/stream 里 next() 返回的是 AsyncIterable，不是 Promise。
  // 把它包装成 Promise 会直接破坏流（宿主 yield* 不了）。
  const iterable = (async function* () {
    yield { type: 'text-delta', text: 'ok' }
  })()
  const output = runWaterfall(
    ctx,
    'llm/stream',
    [{ provider: 'deepseek-official', model: 'deepseek-flash', system: '', messages: [], sessionId: 'session-synthetic-0001' }],
    () => iterable,
  )
  assert.equal(output, iterable)
  assert.equal(typeof /** @type {any} */ (output).then, 'undefined')
  cleanup()
})

test('session/event 是 emit 监听：不 await、返回值被忽略', () => {
  const { ctx, runtime, cleanup } = boot({ mode: 'shadow' })
  runEmit(ctx, 'session/event', [fakeSession(), { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } }])
  assert.equal(runtime.stats.sessionEvents, 1)
  cleanup()
})

test('下游 next() 的错误必须原样透传（吞掉会改变宿主行为）', async () => {
  const { ctx, runtime, cleanup } = boot({ mode: 'explicit' })
  const boom = new Error('host-side assembly blew up')
  await assert.rejects(
    async () =>
      runWaterfall(ctx, 'system-prompt/assemble', [{}, { agent: createFakeAgent() }], () => Promise.reject(boom)),
    (error) => {
      assert.equal(/** @type {Error} */ (error).message, 'host-side assembly blew up')
      return true
    },
  )
  // 透传的同时仍要记账（否则事故无迹可查），且只记一次
  assert.equal(runtime.stats.errors, 1)
  cleanup()
})

test('explicit 模式默认注入通道是 contexts（PromptContext 快照，不是 system section）', async () => {
  const { ctx, runtime, cleanup } = boot({ mode: 'explicit' })
  runtime.supply(fakePackage({ contextId: 'ctx-shape-0001' }), { sessionId: 'session-synthetic-0001', turn: 1, step: 1 })
  const assembly = { sections: [{ name: 'S', text: 's' }], contexts: [], tools: [], variables: {} }
  const output = await runWaterfall(
    ctx,
    'system-prompt/assemble',
    [assembly, { agent: createFakeAgent() }],
    () => Promise.resolve(assembly),
  )
  assert.equal(output.contexts.length, 1)
  assert.equal(output.contexts[0].name, 'brain:memory')
  // 关键：不注册 complete 节，也不往 sections 里塞东西（会被宿主静默丢弃且提升为系统指令）
  assert.equal(output.sections.length, 1)
  cleanup()
})
