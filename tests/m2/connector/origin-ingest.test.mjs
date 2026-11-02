// @ts-check
/**
 * origin-ingest.test.mjs — 注入带来源标记 + 摄取侧剔除自身/兄弟注入。
 *
 * 这是契约 10.6 的验收：M0 实测的闭环链是
 *   注入 → 被兄弟引擎当「用户话语」摄入成记忆 → 跨会话召回 → 再注入。
 * 只要摄取侧把注入当人类证据，这个环就会自己养大自己。
 *
 * 判据分两层：
 *   1. 文本层：我们自己的来源标记（`<!-- dsh-brain-origin:{...} -->`）与兄弟指纹；
 *   2. 结构层：`source.kind !== 'user'` 的消息根本不是人打的字。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { apply } from '../../../apps/connector/index.js'
import { buildContextEntry, buildUserMessage, hasOriginMarker, renderInjectedText } from '../../../apps/connector/inject.js'
import { ORIGIN_MARKER_PREFIX, classifyUserFrame, formatOriginTag, parseOriginTag } from '../../../apps/connector/origin.js'
import {
  createFakeAgent,
  createFakeCtx,
  fakePackage,
  fakeSession,
  runEmit,
  runWaterfall,
  tempDir,
  userMessageEvent,
} from './helpers.mjs'

const SESSION = 'session-synthetic-0001'

test('来源标记往返：生成 → 解析 → 字段一致', () => {
  const tag = formatOriginTag({ contextId: 'ctx-origin-0001', policyVersion: 'm2.0' })
  assert.ok(tag.startsWith(ORIGIN_MARKER_PREFIX))
  assert.ok(tag.endsWith('-->'))
  const parsed = parseOriginTag(`前缀\n${tag}\n正文`)
  assert.equal(parsed?.originSystem, 'brain')
  assert.equal(parsed?.producer, '@dsh-brain/connector')
  assert.equal(parsed?.contextId, 'ctx-origin-0001')
  assert.equal(parsed?.v, 1)
})

test('坏标记不抛，返回 null（摄取侧在热路径上）', () => {
  assert.equal(parseOriginTag('没有标记'), null)
  assert.equal(parseOriginTag(`${ORIGIN_MARKER_PREFIX}不是 JSON -->`), null)
  assert.equal(parseOriginTag(`${ORIGIN_MARKER_PREFIX}{"v":1}-->`), null, '缺 originSystem 应拒绝')
  assert.equal(parseOriginTag(''), null)
  assert.equal(parseOriginTag(/** @type {any} */ (null)), null)
})

test('注入文本第一行必须是来源标记（截断也不能截掉它）', () => {
  const pkg = fakePackage({ contextId: 'ctx-mark-first' })
  const text = renderInjectedText(pkg, { maxChars: 260 })
  const firstLine = text.split('\n')[0]
  assert.ok(hasOriginMarker(firstLine), `第一行没有来源标记: ${firstLine}`)
  assert.equal(parseOriginTag(firstLine)?.contextId, 'ctx-mark-first')
  // 超长时截断正文，标记仍在第一行
  const long = renderInjectedText(
    fakePackage({ contextId: 'ctx-mark-long', summary: '长'.repeat(4000) }),
    { maxChars: 300 },
  )
  assert.ok(long.length <= 300)
  assert.ok(hasOriginMarker(long.split('\n')[0]))
})

test('注入文本带「不是主人现在说的话」的使用纪律 + 预算说明（估算标注）', () => {
  const text = renderInjectedText(fakePackage({ contextId: 'ctx-discipline' }))
  assert.ok(text.includes('不是主人现在说的话'), '必须显式声明注入不等于新指令')
  assert.ok(text.includes('估算'))
  assert.ok(text.includes('estimate:chars/2.5'))
  assert.ok(text.includes('证据状态：ok'))
})

test('context2 已经打过来源标记时不再叠加第二层', () => {
  const inner = formatOriginTag({ contextId: 'ctx-from-context2' })
  const pkg = fakePackage({ contextId: 'ctx-from-context2', injectedText: `${inner}\n外部构包器给的正文` })
  const text = renderInjectedText(pkg)
  const occurrences = text.split(ORIGIN_MARKER_PREFIX).length - 1
  assert.equal(occurrences, 1, '双层标记会让检查器把一条注入看成两条')
  assert.ok(text.includes('外部构包器给的正文'))
})

test('PromptContext 必须关掉插值（interpolate:false），否则正文里的 {{x}} 会让宿主装配抛错', () => {
  const entry = buildContextEntry(fakePackage({ contextId: 'ctx-interp', summary: '模板里有 {{unknown_var}} 这种东西' }))
  assert.equal(entry?.interpolate, false)
  assert.ok(entry?.text.includes('{{unknown_var}}'), '关掉插值后原样保留')
})

test('pre-step 通道的消息 source 用非 user kind（结构层可识别）', () => {
  const message = buildUserMessage(fakePackage({ contextId: 'ctx-msg-kind' }))
  assert.equal(message?.role, 'user')
  assert.equal(message?.source.kind, 'runtime-context')
  assert.equal(message?.source.form, 'recall')
  assert.notEqual(message?.source.kind, 'user')
})

test('classifyUserFrame：人类 / 自身注入 / 探针 / 灵枢 / 宿主快照，五种都能分出来', () => {
  assert.equal(classifyUserFrame({ text: '帮我算板材用量', sourceKind: 'user' }).ingestClass, 'human')

  const own = classifyUserFrame({ text: `${formatOriginTag({ contextId: 'ctx-self' })}\n记忆正文`, sourceKind: 'user' })
  assert.equal(own.ingestClass, 'self_injected')
  assert.equal(own.originSystem, 'brain')

  const probe = classifyUserFrame({ text: '[BRAIN-PROBE-MARKER brain-probe-marker-0001] synthetic', sourceKind: 'user' })
  assert.equal(probe.ingestClass, 'sibling_injected')
  assert.equal(probe.originSystem, 'probe')

  const lingshu = classifyUserFrame({ text: '[lingshu:auto-recall] 你上次提过 1.2m 踢脚线', sourceKind: 'user' })
  assert.equal(lingshu.ingestClass, 'sibling_injected')
  assert.equal(lingshu.originSystem, 'lingshu')

  const snapshot = classifyUserFrame({ text: 'Current runtime context…', sourceKind: 'runtime-context', sourceForm: 'snapshot' })
  assert.equal(snapshot.ingestClass, 'context_snapshot')
  assert.ok(snapshot.originSystem.startsWith('source:runtime-context'))
})

test('摄取侧：自身注入与兄弟注入都不算人类证据，且落盘可查', () => {
  const temp = tempDir()
  const ctx = createFakeCtx()
  const runtime = apply(ctx, { logLevel: 'silent', dir: temp.dir, mode: 'shadow' })
  const session = fakeSession(SESSION)

  runEmit(ctx, 'session/event', [session, userMessageEvent({ seq: 1, text: '主人真的说了这句话', sourceKind: 'user' })])
  runEmit(
    ctx,
    'session/event',
    [
      session,
      userMessageEvent({ seq: 2, text: `${formatOriginTag({ contextId: 'ctx-self-2' })}\n我们自己的注入`, sourceKind: 'user' }),
    ],
  )
  runEmit(
    ctx,
    'session/event',
    [session, userMessageEvent({ seq: 3, text: '[lingshu:auto-recall] 兄弟引擎的注入', sourceKind: 'user' })],
  )
  runEmit(ctx, 'session/event', [session, userMessageEvent({ seq: 4, text: '宿主自己的运行期快照', sourceKind: 'runtime-context', sourceForm: 'snapshot' })])

  assert.equal(runtime.stats.humanMessages, 1, '只有一条是人类证据')
  assert.equal(runtime.stats.selfInjectedMessages, 1)
  assert.equal(runtime.stats.siblingInjectedMessages, 1, '灵枢那条（文本指纹）')
  assert.equal(runtime.stats.contextSnapshotMessages, 1, '宿主自己的运行期快照（结构判据）')
  assert.equal(runtime.stats.errors, 0)

  const records = runtime.queue.readAll().filter((record) => record.record_kind === 'event')
  assert.equal(records.length, 4)
  const bySeq = new Map(records.map((record) => [record.source_seq, record]))
  assert.equal(bySeq.get(1).ingest_class, 'human')
  assert.equal(bySeq.get(1).origin_system, 'human')
  assert.equal(bySeq.get(2).ingest_class, 'self_injected')
  assert.equal(bySeq.get(2).origin_system, 'brain')
  assert.equal(bySeq.get(3).ingest_class, 'sibling_injected')
  assert.equal(bySeq.get(3).origin_system, 'lingshu')
  assert.equal(bySeq.get(4).ingest_class, 'context_snapshot')
  // 信封字段齐（契约 §2 / §11.5：source_seq 必填、payload_text 受控）
  for (const record of records) {
    assert.equal(typeof record.source_seq, 'number')
    assert.equal(record.source_system, 'dsh')
    assert.equal(record.schema_version, 1)
    assert.equal(record.scope_id, 'owner-default')
    assert.equal(record.person_id, 'owner')
    assert.match(String(record.payload_hash), /^sha256:/)
  }
  temp.cleanup()
})

test('重复投递同一 seq 只入账一次（fire-and-forget feed 会重投）', () => {
  const temp = tempDir()
  const ctx = createFakeCtx()
  const runtime = apply(ctx, { logLevel: 'silent', dir: temp.dir, mode: 'shadow' })
  const session = fakeSession(SESSION)
  const event = userMessageEvent({ seq: 7, text: '同一条消息被投了两次' })
  runEmit(ctx, 'session/event', [session, event])
  runEmit(ctx, 'session/event', [session, event])
  const records = runtime.queue.readAll().filter((record) => record.record_kind === 'event')
  assert.equal(records.length, 1)
  assert.ok(runtime.traces.some((trace) => trace.hook === 'event.duplicate'))
  temp.cleanup()
})

test('注入通道写进队列后仍能被识别成自己的来源（闭环自检）', async () => {
  const temp = tempDir()
  const ctx = createFakeCtx()
  const runtime = apply(ctx, { logLevel: 'silent', dir: temp.dir, mode: 'explicit' })
  const agent = createFakeAgent({ sessionId: SESSION, turn: 1, previousStep: 0 })
  runtime.supply(fakePackage({ contextId: 'ctx-loop-check' }), { sessionId: SESSION, turn: 1, step: 1 })

  const assembly = { sections: [], contexts: [], tools: [], variables: {} }
  const injected = await runWaterfall(ctx, 'system-prompt/assemble', [assembly, { agent }], () => Promise.resolve(assembly))
  const injectedText = injected.contexts[0].text

  // 模拟宿主把注入物化成 user/message 快照后回灌给我们（M0 实测就是这么发生的）
  runEmit(ctx, 'session/event', [
    fakeSession(SESSION),
    userMessageEvent({ seq: 11, text: injectedText, sourceKind: 'runtime-context', sourceForm: 'snapshot' }),
  ])
  assert.equal(runtime.stats.humanMessages, 0, '注入绝不能被当人类证据')
  const record = runtime.queue.readAll().find((entry) => entry.record_kind === 'event')
  assert.equal(record.ingest_class, 'self_injected', '文本标记先于结构判据被认出来')
  assert.equal(record.origin_system, 'brain')
  temp.cleanup()
})
