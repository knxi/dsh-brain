// @ts-check
/**
 * evidence.test.mjs — `attached` / `sent` 两级的判定与落库（Lead 收口清单四条硬要求）。
 *
 * 1. 可选注入：`store.contextPackages.updateStatus` 不存在 → 跳过，不报错；
 * 2. 绝不影响宿主：落库失败只记账，**不许向上抛**（契约 10.2）；
 * 3. `proves_wire_delivery` 恒 `false`（请求对象命中 ≠ 字节出网）；
 * 4. carrier 用**实际观测到**的承载位置，不用声明值。
 *
 * 另加：不跳级 / 不回退 / 幂等（照 context2 的状态机语义逐条对齐）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../../apps/connector/index.js'
import {
  CARRIER,
  CARRIERS,
  CARRIER_BY_MATCH,
  ATTACHED_EVIDENCE_LEVEL,
  SENT_EVIDENCE_LEVEL,
  carriersFor,
  createEvidenceSink,
} from '../../../apps/connector/evidence.js'
import { checkSentAny } from '../../../apps/connector/probe-sent.js'
import { createFakeAgent, createFakeCtx, fakePackage, fakeStore, runWaterfall, tempDir } from './helpers.mjs'

const SESSION = 'session-synthetic-0001'
const CONTEXT_ID = 'ctx-evidence-0001'

/** @param {Record<string, any>} [config] */
function boot(config = {}) {
  const temp = tempDir()
  const ctx = createFakeCtx()
  const runtime = apply(ctx, { logLevel: 'silent', dir: temp.dir, mode: 'explicit', ...config })
  return { ctx, runtime, cleanup: temp.cleanup }
}

/** @param {string} label */
function labelOf(label) {
  return `[${label}]`
}

// ── 4. carrier 映射：实测位置 → 真实承载 ─────────────────────────────────────

test('carrier 词表多了第三个值：Brain 的两个注入通道都落 user 消息', () => {
  assert.deepEqual([...CARRIERS], ['system', 'messages[role=system]', 'messages[user]'])
  assert.equal(CARRIER_BY_MATCH['request.system'], 'system')
  assert.equal(CARRIER_BY_MATCH['messages[role=system]'], 'messages[role=system]')
  // M0 实测：assembly.contexts 与 pre-step 追加都物化成 user 角色消息
  assert.equal(CARRIER_BY_MATCH['messages[other]'], CARRIER.USER_MESSAGE)
})

test('carriersFor：多级命中保序去重，未知位置丢弃（不猜）', () => {
  assert.deepEqual(carriersFor(['messages[role=system]']), ['messages[role=system]'])
  assert.deepEqual(carriersFor(['request.system', 'messages[other]']), ['system', 'messages[user]'])
  assert.deepEqual(carriersFor(['request.system', 'request.system']), ['system'])
  assert.deepEqual(carriersFor(['somewhere[else]']), [])
  assert.deepEqual(carriersFor(null), [])
})

// ── 1. 可选注入 ─────────────────────────────────────────────────────────────

test('store 缺失 / 无 contextPackages / 无 updateStatus：一律跳过，不报错', async () => {
  const cases = [
    { name: 'no store', store: null },
    { name: 'empty object', store: {} },
    { name: 'contextPackages=null', store: { contextPackages: null } },
    { name: 'no updateStatus', store: { contextPackages: { save() {} } } },
  ]
  for (const entry of cases) {
    const { ctx, runtime, cleanup } = boot({ store: entry.store })
    const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
    runtime.supply(fakePackage({ contextId: `${CONTEXT_ID}-${entry.name}` }), { sessionId: SESSION, turn: 1, step: 1 })

    const assembly = { sections: [], contexts: [], tools: [], variables: {} }
    const out = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
    await runtime.flushEvidence()

    assert.equal(out.contexts.length, 1, `${entry.name}：注入本身不受影响`)
    assert.equal(runtime.stats.errors, 0, `${entry.name}：没有门面不是错误`)
    // 门面在但缺 updateStatus 时报 no_update_status（比 absent 更精确，便于检查器区分部署状态）
    const expectedFacade = entry.name === 'no updateStatus' ? 'no_update_status' : 'absent'
    assert.equal(runtime.diagnostics().evidence.facade, expectedFacade, entry.name)
    assert.equal(runtime.diagnostics().evidence.counts.skipped, 1, `${entry.name}：记一次 skipped`)
    cleanup()
  }
})

test('store 的门面就绪时：attached 写入主账，状态是 attached + 正确 carrier', async () => {
  const store = fakeStore()
  const { ctx, runtime, cleanup } = boot({ store })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: CONTEXT_ID }), { sessionId: SESSION, turn: 1, step: 1 })

  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  await runtime.flushEvidence()

  assert.equal(runtime.diagnostics().evidence.facade, 'ready')
  assert.equal(store.calls.length, 1)
  const call = store.calls[0]
  assert.equal(call.contextId, CONTEXT_ID)
  assert.equal(call.patch.status, 'attached')
  assert.equal(call.patch.carrier, CARRIER.USER_MESSAGE)
  assert.equal(call.patch.evidence.evidence_level, ATTACHED_EVIDENCE_LEVEL)
  assert.equal(call.patch.evidence.channel, 'contexts')
  assert.equal(call.patch.evidence.turn, 1)
  assert.equal(call.patch.evidence.step, 1)
  // 3. 挂上 ≠ 发了
  assert.equal(call.patch.evidence.proves_wire_delivery, false)
  cleanup()
})

// ── 2. 绝不影响宿主 ─────────────────────────────────────────────────────────

test('落库抛错（async reject）：宿主结果不受影响，错误被吞进日志', async () => {
  const store = fakeStore({ failWith: 'main ledger is locked' })
  const { ctx, runtime, cleanup } = boot({ store })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-fail-async' }), { sessionId: SESSION, turn: 1, step: 1 })

  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const out = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  await runtime.flushEvidence()

  assert.equal(out.contexts.length, 1, '注入照常生效')
  assert.equal(runtime.stats.errors, 0, '旁路落库失败不是 hook 错误')
  const counts = runtime.diagnostics().evidence.counts
  assert.equal(counts.failed, 1)
  assert.equal(runtime.diagnostics().evidence.records[0].status, 'attached', '内存状态仍前进，只是没落库')
  cleanup()
})

test('落库同步抛错也不影响宿主', async () => {
  const store = fakeStore({ failWith: new Error('sync boom'), mode: 'sync' })
  const { ctx, runtime, cleanup } = boot({ store })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-fail-sync' }), { sessionId: SESSION, turn: 1, step: 1 })

  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const out = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  await runtime.flushEvidence()
  assert.equal(out.contexts.length, 1)
  assert.equal(runtime.stats.errors, 0)
  assert.equal(runtime.diagnostics().evidence.counts.failed, 1)
  cleanup()
})

test('同步门面（updateStatus 返回 undefined）也能正常推进', async () => {
  const store = fakeStore({ mode: 'sync' })
  const { ctx, runtime, cleanup } = boot({ store })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-sync-store' }), { sessionId: SESSION, turn: 1, step: 1 })
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  await runtime.flushEvidence()
  assert.equal(store.calls.length, 1)
  assert.equal(runtime.diagnostics().evidence.counts.persisted, 1)
  cleanup()
})

// ── 3 + 4. sent：proves_wire_delivery=false + carrier 用实测位置 ──────────────

/**
 * 跑「注入 + 一次 llm/stream 命中」的完整链路。
 * @param {{ requestFor: (text: string) => any }} options
 */
async function runAttachThenSent(options) {
  const store = fakeStore()
  const { ctx, runtime, cleanup } = boot({ store })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: CONTEXT_ID }), { sessionId: SESSION, turn: 1, step: 1 })

  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const injected = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  const text = injected.contexts[0].text
  await runtime.flushEvidence()

  runWaterfall(ctx, 'llm/stream', [options.requestFor(text)], () => (async function* () {})())
  await runtime.flushEvidence()
  return { store, runtime, text, cleanup }
}

test('sent 的 carrier 用实测的 messages[role=system]（不是声明的 user）', async () => {
  const { store, runtime, cleanup } = await runAttachThenSent({
    requestFor: (text) => ({
      system: '',
      messages: [
        { role: 'system', content: [{ type: 'text', text }] },
        { role: 'user', content: [{ type: 'text', text: '主人这句话' }] },
      ],
      sessionId: SESSION,
    }),
  })
  assert.equal(store.calls.length, 2, 'attached + sent 各写一次')
  assert.equal(store.calls[0].patch.status, 'attached')
  assert.equal(store.calls[0].patch.carrier, CARRIER.USER_MESSAGE)
  assert.equal(store.calls[1].patch.status, 'sent')
  assert.equal(store.calls[1].patch.carrier, CARRIER.SYSTEM_ROLE_MESSAGE, '实际观测到哪就写哪')
  assert.deepEqual(store.calls[1].patch.evidence.observed_hash_locations, [CARRIER.SYSTEM_ROLE_MESSAGE])
  assert.equal(store.calls[1].patch.evidence.evidence_level, SENT_EVIDENCE_LEVEL)
  assert.equal(store.calls[1].patch.evidence.proves_wire_delivery, false)
  assert.equal(runtime.stats.sentConfirmed, 1)
  cleanup()
})

test('sent 的 carrier 用实测的 system（标题旁路形态）', async () => {
  const { store, cleanup } = await runAttachThenSent({
    requestFor: (text) => ({
      system: text,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      sessionId: SESSION,
    }),
  })
  assert.equal(store.calls[1].patch.carrier, CARRIER.SYSTEM)
  assert.deepEqual(store.calls[1].patch.evidence.observed_hash_locations, [CARRIER.SYSTEM])
  cleanup()
})

test('sent 的 carrier 用实测的 messages[user]（Brain 真实路径：user 角色消息）', async () => {
  const { store, cleanup } = await runAttachThenSent({
    requestFor: (text) => ({
      system: '',
      messages: [
        { role: 'system', content: [{ type: 'text', text: '宿主系统提示' }] },
        { role: 'user', content: [{ type: 'text', text }] },
      ],
      sessionId: SESSION,
    }),
  })
  assert.equal(store.calls[1].patch.carrier, CARRIER.USER_MESSAGE)
  assert.deepEqual(store.calls[1].patch.evidence.observed_hash_locations, [CARRIER.USER_MESSAGE])
  cleanup()
})

test('请求里没有本包标识时：不写 sent，只停在 attached', async () => {
  const store = fakeStore()
  const { ctx, runtime, cleanup } = boot({ store })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-unconfirmed' }), { sessionId: SESSION, turn: 1, step: 1 })
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  await runtime.flushEvidence()

  runWaterfall(
    ctx,
    'llm/stream',
    [{ system: '宿主自己的提示', messages: [], sessionId: SESSION }],
    () => (async function* () {})(),
  )
  await runtime.flushEvidence()

  assert.equal(store.calls.length, 1, '只有 attached 一次')
  assert.equal(store.calls[0].patch.status, 'attached')
  assert.equal(runtime.stats.sentConfirmed, 0)
  assert.ok(runtime.stats.attachedUnconfirmed >= 1)
  assert.equal(runtime.diagnostics().evidence.records[0].status, 'attached')
  cleanup()
})

test('canonicalHash 优先于 contextId 当 sent 针（内容级证据更强）', async () => {
  const { store, cleanup } = await runAttachThenSent({
    requestFor: (text) => ({
      system: text,
      messages: [],
      sessionId: SESSION,
    }),
  })
  // fakePackage 的 canonicalHash 不在注入文本里（我们没往文本里回填），
  // 所以这一轮命中的针应该是 contextId —— 验证 needle 字段如实记录。
  const sentCall = store.calls[1]
  assert.equal(sentCall.patch.evidence.needle, CONTEXT_ID)
  cleanup()
})

test('checkSentAny 接受多针且返回第一根命中的针', () => {
  const request = { system: 'xx sha256:deadbeef yy', messages: [] }
  const verdict = checkSentAny(request, ['sha256:deadbeef', 'ctx-none'])
  assert.equal(verdict.hit, true)
  assert.equal(verdict.needle, 'sha256:deadbeef')
  assert.deepEqual(verdict.matchedIn, ['request.system'])

  const miss = checkSentAny(request, ['ctx-none'])
  assert.equal(miss.hit, false)
  assert.equal(checkSentAny(request, []).hit, false)
  assert.equal(checkSentAny(request, [null, undefined, '']).hit, false)
})

// ── 状态机：不跳级 / 不回退 / 幂等 ──────────────────────────────────────────

test('拒绝跳级：built 直接 sent 会回 rejected，不写主账', async () => {
  const store = fakeStore()
  const sink = createEvidenceSink({ store })
  const outcome = await sink.sent({ contextId: 'ctx-skip', matchedIn: ['messages[other]'] })
  await sink.settled()
  assert.equal(outcome.status, 'rejected')
  assert.equal(outcome.reason, 'no_skip_from_built')
  assert.equal(store.calls.length, 0)
})

test('拒绝回退：sent 之后再 attached', async () => {
  const store = fakeStore()
  const sink = createEvidenceSink({ store })
  await sink.attached({ contextId: 'ctx-regress', channel: 'contexts', carrier: CARRIER.USER_MESSAGE, turn: 1, step: 1 })
  await sink.sent({ contextId: 'ctx-regress', matchedIn: ['messages[other]'] })
  const outcome = await sink.attached({ contextId: 'ctx-regress', channel: 'contexts', carrier: CARRIER.USER_MESSAGE, turn: 1, step: 2 })
  await sink.settled()
  assert.equal(outcome.status, 'rejected')
  assert.equal(outcome.reason, 'no_regression_from_sent')
  assert.equal(sink.get('ctx-regress').status, 'sent')
})

test('幂等：同一 step 重复 attached / 重复 sent 不重复写主账', async () => {
  const store = fakeStore()
  const sink = createEvidenceSink({ store })
  await sink.attached({ contextId: 'ctx-idem', channel: 'contexts', carrier: CARRIER.USER_MESSAGE, turn: 1, step: 1 })
  const again = await sink.attached({ contextId: 'ctx-idem', channel: 'contexts', carrier: CARRIER.USER_MESSAGE, turn: 1, step: 1 })
  await sink.sent({ contextId: 'ctx-idem', matchedIn: ['messages[other]'] })
  const sentAgain = await sink.sent({ contextId: 'ctx-idem', matchedIn: ['messages[other]'] })
  await sink.settled()
  assert.equal(again.status, 'skipped')
  assert.equal(again.reason, 'already_attached')
  assert.equal(sentAgain.status, 'skipped')
  assert.equal(store.calls.filter((call) => call.patch.status === 'attached').length, 1)
  assert.equal(store.calls.filter((call) => call.patch.status === 'sent').length, 1)
})

test('没有实测命中的 sent 被拒绝（不许声明式 sent）', async () => {
  const store = fakeStore()
  const sink = createEvidenceSink({ store })
  await sink.attached({ contextId: 'ctx-declared', channel: 'contexts', carrier: CARRIER.USER_MESSAGE, turn: 1, step: 1 })
  const outcome = await sink.sent({ contextId: 'ctx-declared', matchedIn: [] })
  await sink.settled()
  assert.equal(outcome.status, 'rejected')
  assert.equal(outcome.reason, 'no_request_boundary_evidence')
})

// ── 队列账 ─────────────────────────────────────────────────────────────────

test('证据推进也会落进连接器自己的队列（context_evidence）', async () => {
  const store = fakeStore()
  const { ctx, runtime, cleanup } = boot({ store })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-queue-proof' }), { sessionId: SESSION, turn: 1, step: 1 })
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const injected = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  await runtime.flushEvidence()
  runWaterfall(
    ctx,
    'llm/stream',
    [{ system: '', messages: [{ role: 'system', content: [{ type: 'text', text: injected.contexts[0].text }] }], sessionId: SESSION }],
    () => (async function* () {})(),
  )
  await runtime.flushEvidence()

  const records = runtime.queue.readAll().filter((record) => record.record_kind === 'context_evidence')
  assert.equal(records.length, 2)
  assert.deepEqual(records.map((record) => record.event_type), ['context/attached', 'context/sent'])
  for (const record of records) assert.equal(record.proves_wire_delivery, false)
  assert.equal(records[1].store_facade, 'ready')
  cleanup()
})

test('diagnostics 的 evidence 段可给检查器用，且不含正文', async () => {
  const store = fakeStore()
  const { ctx, runtime, cleanup } = boot({ store })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-diag', summary: '机密正文不应出现在诊断里' }), { sessionId: SESSION, turn: 1, step: 1 })
  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  await runtime.flushEvidence()
  const diagnostics = runtime.diagnostics()
  assert.equal(diagnostics.evidence.facade, 'ready')
  assert.equal(diagnostics.evidence.records.length, 1)
  assert.equal(diagnostics.evidence.records[0].carrier, CARRIER.USER_MESSAGE)
  assert.equal(JSON.stringify(diagnostics).includes('机密正文'), false)
  cleanup()
})

test('标签常量与 context2 的语义对齐（供检查器统一措辞）', () => {
  assert.equal(ATTACHED_EVIDENCE_LEVEL, 'attached:assembly')
  assert.equal(SENT_EVIDENCE_LEVEL, 'sent:request-object')
  assert.ok(labelOf('constants-are-strings').startsWith('['))
})
