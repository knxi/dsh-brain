// @ts-check
/**
 * sent-evidence.test.mjs — sent 判据：查两级承载 + 按 purpose 剔除旁路。
 *
 * 契约 10.4 / 10.9 的实测事实：
 *   - 主请求：`systemLen=0`，system prompt 在 `messages[role=system]` 里；
 *   - 标题旁路：`systemLen=481`，在 `request.system` 里。
 *   **只看 `options.system` 会漏判 sent。**
 *   - `llm/stream` 次数 ≠ step 数：每次多一发 `purpose=session-title`。
 *
 * 证据边界（必须诚实）：命中 = 「宿主决定发这些内容」，**不证明字节出网**。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../../apps/connector/index.js'
import { BYPASS_PURPOSES, checkSent, describeRequest, isMainRequest } from '../../../apps/connector/probe-sent.js'
import { createFakeAgent, createFakeCtx, fakePackage, runWaterfall, tempDir } from './helpers.mjs'

const SESSION = 'session-synthetic-0001'
const CONTEXT_ID = 'ctx-sent-0001'

/**
 * 建立实例并完成一次注入，返回注入文本（供构造请求用）。
 * @param {{ channel?: string }} [options]
 */
async function injectOnce(options = {}) {
  const temp = tempDir()
  const ctx = createFakeCtx()
  const runtime = apply(ctx, {
    logLevel: 'silent',
    dir: temp.dir,
    mode: 'explicit',
    injectChannel: options.channel ?? 'contexts',
  })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: CONTEXT_ID }), { sessionId: SESSION, turn: 1, step: 1 })

  let injectedText = ''
  if ((options.channel ?? 'contexts') === 'contexts') {
    const assembly = { sections: [], contexts: [], tools: [], variables: {} }
    const injected = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
    injectedText = injected.contexts[0].text
  } else {
    const decision = await runWaterfall(
      ctx,
      'agent/pre-step',
      [{ messages: [], turn: 1, step: 1, signal: new AbortController().signal, agent }],
      () => Promise.resolve({ kind: 'enter', messages: [] }),
    )
    injectedText = decision.messages[0].content[0].text
  }
  return { ctx, runtime, injectedText, cleanup: temp.cleanup }
}

/**
 * 只在天花板消息里携带注入（主请求的真实形态）。
 * @param {string} text
 * @param {string} [purpose]
 */
function requestWithSystemRoleMessage(text, purpose) {
  return {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    system: '',
    messages: [
      { role: 'system', content: [{ type: 'text', text }] },
      { role: 'user', content: [{ type: 'text', text: '主人这句话' }] },
    ],
    sessionId: SESSION,
    ...(purpose === undefined ? {} : { purpose }),
  }
}

test('describeRequest：两级承载能分辨出「在 messages[role=system]」', () => {
  const described = describeRequest(requestWithSystemRoleMessage(CONTEXT_ID))
  assert.equal(described.systemLen, 0)
  assert.equal(described.systemRoleMessageCount, 1)
  assert.ok(described.systemRoleTextLen > 0)
  assert.equal(described.systemPromptCarriedIn, 'messages[role=system]')
})

test('describeRequest：标题旁路形态承载在 request.system', () => {
  const described = describeRequest({
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    system: '标题生成的系统提示',
    messages: [{ role: 'user', content: [{ type: 'text', text: '生成标题' }] }],
    purpose: 'session-title',
  })
  assert.equal(described.systemLen, '标题生成的系统提示'.length)
  assert.equal(described.systemRoleMessageCount, 0)
  assert.equal(described.systemPromptCarriedIn, 'request.system')
})

test('sent：只查 messages[role=system] 也能判出来（只看 options.system 会漏判）', async () => {
  const { ctx, runtime, injectedText, cleanup } = await injectOnce()
  const request = requestWithSystemRoleMessage(injectedText)
  const verdict = checkSent(request, CONTEXT_ID)
  assert.equal(verdict.hit, true)
  assert.deepEqual(verdict.matchedIn, ['messages[role=system]'])

  runWaterfall(ctx, 'llm/stream', [request], () => (async function* () {})())
  assert.equal(runtime.stats.mainRequests, 1)
  assert.equal(runtime.stats.sentConfirmed, 1)
  assert.equal(runtime.stats.attachedUnconfirmed, 0)

  const sentRecord = runtime.queue.readAll().find((record) => record.record_kind === 'context_sent')
  assert.equal(sentRecord.context_id, CONTEXT_ID)
  assert.equal(sentRecord.evidence_level, 'sent:request-object')
  assert.equal(sentRecord.proves_wire_delivery, false, '命中的是请求对象，不是出网字节')
  assert.equal(sentRecord.system_prompt_carried_in, 'messages[role=system]')
  cleanup()
})

test('sent：承载在 request.system 里同样判得出来', async () => {
  const { ctx, runtime, injectedText, cleanup } = await injectOnce()
  const request = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    system: injectedText,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    sessionId: SESSION,
  }
  assert.deepEqual(checkSent(request, CONTEXT_ID).matchedIn, ['request.system'])
  runWaterfall(ctx, 'llm/stream', [request], () => (async function* () {})())
  assert.equal(runtime.stats.sentConfirmed, 1)
  cleanup()
})

test('sent：请求里没有我们的片段 → 只能停在 attached（绝不谎报 sent）', async () => {
  const { ctx, runtime, cleanup } = await injectOnce()
  const request = requestWithSystemRoleMessage('宿主自己的系统提示，没有我们的片段')
  assert.equal(checkSent(request, CONTEXT_ID).hit, false)
  runWaterfall(ctx, 'llm/stream', [request], () => (async function* () {})())
  assert.equal(runtime.stats.sentConfirmed, 0)
  assert.equal(runtime.stats.attachedUnconfirmed, 1)
  assert.equal(runtime.queue.readAll().some((record) => record.record_kind === 'context_sent'), false)
  cleanup()
})

test('purpose=session-title 的旁路请求不计入主请求，也不重复计入 sent', async () => {
  const { ctx, runtime, injectedText, cleanup } = await injectOnce()
  const main = requestWithSystemRoleMessage(injectedText)
  const bypass = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    system: '标题系统提示',
    messages: [{ role: 'user', content: [{ type: 'text', text: '生成标题' }] }],
    sessionId: SESSION,
    purpose: 'session-title',
  }
  runWaterfall(ctx, 'llm/stream', [main], () => (async function* () {})())
  runWaterfall(ctx, 'llm/stream', [bypass], () => (async function* () {})())

  assert.equal(runtime.stats.streamCalls, 2)
  assert.equal(runtime.stats.mainRequests, 1, '标题旁路不算主请求')
  assert.equal(runtime.stats.bypassRequests, 1)
  assert.equal(runtime.stats.sentConfirmed, 1, '同一个 contextId 只确认一次')
  cleanup()
})

test('isMainRequest / BYPASS_PURPOSES 语义', () => {
  assert.ok(BYPASS_PURPOSES.includes('session-title'))
  assert.equal(isMainRequest({ purpose: 'session-title' }), false)
  assert.equal(isMainRequest({ purpose: '' }), true)
  assert.equal(isMainRequest({}), true)
  assert.equal(isMainRequest(null), true)
})

test('pre-step 通道的注入落在 user 消息里，sent 判据要能扫到（messages[other]）', async () => {
  const { ctx, runtime, injectedText, cleanup } = await injectOnce({ channel: 'pre-step' })
  const request = {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    system: '',
    messages: [
      { role: 'system', content: [{ type: 'text', text: '宿主系统提示' }] },
      { role: 'user', content: [{ type: 'text', text: injectedText }] },
    ],
    sessionId: SESSION,
  }
  const verdict = checkSent(request, CONTEXT_ID)
  assert.equal(verdict.hit, true)
  assert.deepEqual(verdict.matchedIn, ['messages[other]'])
  assert.equal(verdict.carriersChecked.length, 3, '三级承载都要报出来，检查器才能显示查了哪里')
  runWaterfall(ctx, 'llm/stream', [request], () => (async function* () {})())
  assert.equal(runtime.stats.sentConfirmed, 1)
  cleanup()
})

test('回合结束后 sent 去重记忆被清空（下一轮可以重新确认）', async () => {
  const { ctx, runtime, injectedText, cleanup } = await injectOnce()
  const request = requestWithSystemRoleMessage(injectedText)
  runWaterfall(ctx, 'llm/stream', [request], () => (async function* () {})())
  assert.equal(runtime.stats.sentConfirmed, 1)

  // turn/end 清掉 sent 去重集合
  const { runEmit, fakeSession, turnEndEvent } = await import('./helpers.mjs')
  runEmit(ctx, 'session/event', [fakeSession(SESSION), turnEndEvent({ seq: 20 })])
  runWaterfall(ctx, 'llm/stream', [request], () => (async function* () {})())
  assert.equal(runtime.stats.sentConfirmed, 2, '新回合重新确认，不是永久锁死')
  cleanup()
})
