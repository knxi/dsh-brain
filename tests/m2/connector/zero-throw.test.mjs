// @ts-check
/**
 * zero-throw.test.mjs — 运行期零抛出。
 *
 * 契约 10.2 / M0 §2 Q6 实测：插件在 hook 里抛错 → 宿主 `turn/end reason=error` +
 * 进程退出码 1，**直接污染用户回合**。加载期失败只降级成 warning，两者不是一回事。
 *
 * 所以这里的判据分两类，必须分清：
 *   A. **我们自己的**加工失败（坏包、畸形 assembly、写盘失败、构包器抛错）→ 绝不抛，
 *      返回宿主原本的对象 + 记一条错误。
 *   B. **宿主下游 `next()` 的失败** → 必须原样透传（吞掉会改变宿主行为）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply } from '../../../apps/connector/index.js'
import {
  createFakeAgent,
  createFakeCtx,
  fakePackage,
  fakeSession,
  runEmit,
  runSerial,
  runWaterfall,
  tempDir,
  turnEndEvent,
  userMessageEvent,
} from './helpers.mjs'

const SESSION = 'session-synthetic-0001'

/** @param {Record<string, any>} [config] */
function boot(config = {}) {
  const temp = tempDir()
  const ctx = createFakeCtx()
  const runtime = apply(ctx, { logLevel: 'silent', dir: temp.dir, mode: 'explicit', ...config })
  return { ctx, runtime, temp, cleanup: temp.cleanup }
}

test('畸形 assembly（contexts 不是数组）不抛，且能安全注入', async () => {
  const { ctx, runtime, cleanup } = boot()
  runtime.supply(fakePackage({ contextId: 'ctx-zerothrow-1' }), { sessionId: SESSION, turn: 1, step: 1 })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })

  const broken = /** @type {any} */ ({ sections: null, contexts: 'not-an-array', tools: null, variables: null })
  const out1 = await runWaterfall(ctx, 'system-prompt/assemble', [broken, { agent }], () => Promise.resolve(broken))
  assert.ok(Array.isArray(out1.contexts), 'contexts 不是数组时按空数组处理，结果必须是合法数组')
  assert.equal(out1.contexts.length, 1)
  assert.equal(broken.contexts, 'not-an-array', '宿主原对象不得被改写')
  cleanup()
})

test('畸形 assembly（抛错 getter）不抛，返回宿主原对象', async () => {
  const { ctx, runtime, cleanup } = boot()
  runtime.supply(fakePackage({ contextId: 'ctx-zerothrow-2' }), { sessionId: SESSION, turn: 1, step: 1 })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })

  const hostile = /** @type {any} */ ({ contexts: [{ name: 'x', text: 'y' }], sections: [] })
  Object.defineProperty(hostile, 'tools', {
    get() {
      throw new Error('getter blows up')
    },
  })
  const out2 = await runWaterfall(ctx, 'system-prompt/assemble', [hostile, { agent }], () => Promise.resolve(hostile))
  assert.equal(out2, hostile, '加工失败时必须返回宿主原本的对象')
  assert.equal(runtime.stats.errors, 1, '失败要被记账，但只记一次')
  cleanup()
})

test('损坏的 package（Proxy 抛错 / 缺字段 / 空段）不抛，且不注入', async () => {
  const { ctx, runtime, cleanup } = boot()
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })

  const hostilePackage = new Proxy(
    {},
    {
      get() {
        throw new Error('package getter explodes')
      },
      has() {
        throw new Error('package trap explodes')
      },
      ownKeys() {
        throw new Error('package ownKeys explodes')
      },
    },
  )
  runtime.supply(/** @type {any} */ (hostilePackage), { sessionId: SESSION, turn: 1, step: 1 })
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const out = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  assert.equal(out.contexts.length, 0)
  assert.ok(runtime.stats.skippedEmptyPackage >= 1 || runtime.stats.errors >= 1)
  cleanup()
})

test('队列目录不可写时也不抛（写失败只降级 + 计数）', async () => {
  const temp = tempDir()
  const notADir = join(temp.dir, 'this-is-a-file')
  writeFileSync(notADir, 'x', 'utf8')
  const ctx = createFakeCtx()
  const runtime = apply(ctx, { logLevel: 'silent', dir: notADir, mode: 'shadow' })

  runEmit(ctx, 'session/event', [fakeSession(), userMessageEvent({ seq: 1, text: '写不进去也不能抛' })])
  runEmit(ctx, 'session/event', [fakeSession(), turnEndEvent({ seq: 2 })])
  assert.equal(runtime.stats.errors, 0, '写盘失败不是 hook 错误')
  assert.ok(runtime.stats.queueWriteFailures >= 1, '写失败必须被计数，不能静默')
  temp.cleanup()
})

test('session/event 收到 undefined / 缺字段也不抛', () => {
  const { ctx, runtime, cleanup } = boot()
  runEmit(ctx, 'session/event', [undefined, undefined])
  runEmit(ctx, 'session/event', [fakeSession(), { type: 'user/message', data: null }])
  runEmit(ctx, 'session/event', [fakeSession(), { type: 'user/message', data: { message: { content: 'string-content' } } }])
  assert.equal(runtime.stats.errors, 0)
  assert.equal(runtime.stats.sessionEvents, 3)
  cleanup()
})

test('agent/turn-stopping 收到 undefined 也不抛', async () => {
  const { ctx, runtime, cleanup } = boot()
  await runSerial(ctx, 'agent/turn-stopping', [undefined])
  assert.equal(runtime.stats.errors, 0)
  assert.equal(runtime.stats.turnStoppingCalls, 1)
  cleanup()
})

test('llm/stream 收到 null options 也不抛，next 照常被调用', () => {
  const { ctx, runtime, cleanup } = boot()
  const iterable = (async function* () {
    yield 'chunk'
  })()
  let called = 0
  const output = runWaterfall(ctx, 'llm/stream', [null], () => {
    called += 1
    return iterable
  })
  assert.equal(called, 1)
  assert.equal(output, iterable)
  assert.equal(runtime.stats.errors, 0)
  assert.equal(runtime.stats.mainRequests, 1)
  cleanup()
})

test('buildPackage 抛错：不注入、不抛、只记错误', async () => {
  const { ctx, runtime, cleanup } = boot({
    mode: 'automatic',
    buildPackage() {
      throw new Error('context builder exploded')
    },
  })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const out = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  assert.equal(out.contexts.length, 0)
  assert.equal(runtime.stats.injectedContexts, 0)
  assert.ok(runtime.stats.errors >= 1)
  assert.ok(runtime.errors.some((entry) => entry.hook === 'automatic' && entry.phase === 'build'))
  cleanup()
})

test('buildPackage 超时：弃答不注入，不拖住 step', async () => {
  const { ctx, runtime, cleanup } = boot({
    mode: 'automatic',
    buildTimeoutMs: 20,
    buildPackage() {
      return new Promise((resolve) => setTimeout(() => resolve(fakePackage({ contextId: 'ctx-too-late' })), 200))
    },
  })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const started = Date.now()
  const out = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  const elapsed = Date.now() - started
  assert.equal(out.contexts.length, 0)
  assert.ok(elapsed < 180, `超时后应立即放弃，实际耗时 ${elapsed}ms`)
  assert.ok(runtime.stats.errors >= 1)
  cleanup()
})

test('所有 hook 在整轮里一起跑也不抛（综合冒烟）', async () => {
  const { ctx, runtime, cleanup } = boot()
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-combo' }), { sessionId: SESSION, turn: 1, step: 1 })

  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  runEmit(ctx, 'session/event', [fakeSession(), { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } }])
  const injected = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  await runWaterfall(
    ctx,
    'agent/pre-step',
    [{ messages: [], turn: 1, step: 1, signal: new AbortController().signal, agent }],
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  const stream = (async function* () {
    yield 'x'
  })()
  runWaterfall(ctx, 'llm/stream', [{ messages: [{ role: 'system', content: [{ type: 'text', text: injected.contexts[0].text }] }], sessionId: SESSION }], () => stream)
  await runSerial(ctx, 'agent/turn-stopping', [{ turn: 1, agent }])
  runEmit(ctx, 'session/event', [fakeSession(), turnEndEvent({ seq: 9 })])

  assert.equal(runtime.stats.errors, 0)
  assert.equal(runtime.stats.injectedContexts, 1)
  assert.equal(runtime.stats.sentConfirmed, 1)
  cleanup()
})
