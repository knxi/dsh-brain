// @ts-check
/**
 * 工作空间 · 事件总线 / 候选仲裁 / 注意力焦点 的验收测试。
 *
 * 三条主线：
 * 1. **事件**：能发、能去重、能按水位消费、坏载荷被拒；
 * 2. **候选**：提议→抢占→结案，双 owner 只有一个抢到，无证据不许执行；
 * 3. **注意力**：低优先级抢不走重要任务（这是「专注」这件事的工程定义）。
 */

import test from 'node:test'
import { assert, countRows, createWorkspaceFixture } from './helpers.mjs'

// ───────────────────────────── 事件总线 ─────────────────────────────

test('publish 落库：字段齐全，at_ms 可排序', async (t) => {
  const { workspace, brain } = createWorkspaceFixture(t)
  const result = await workspace.publish({
    channel: 'sense',
    sourceModule: 'thalamus',
    kind: 'message.received',
    subjectType: 'session',
    subjectId: 'sess_1',
    payload: { text: '你好' },
    salience: 0.4,
  })
  assert.ok(result, 'publish 必须返回写入结果')
  assert.equal(result.deduped, false)

  const row = brain.db.prepare('SELECT * FROM ws_events WHERE id = ?').get(result.id)
  assert.ok(row, '事件必须真的写进库')
  assert.equal(String(row.channel), 'sense')
  assert.equal(String(row.source_module), 'thalamus')
  assert.equal(String(row.kind), 'message.received')
  assert.equal(Number(row.salience), 0.4)
  assert.equal(JSON.parse(String(row.payload_json)).text, '你好')
  assert.match(String(row.at_local), /\+08:00$/, 'at_local 必须是 +08:00 形态')
})

test('dedupeKey 幂等：同一 key 第二次发布返回既有 id，不新增行', async (t) => {
  const { workspace, brain } = createWorkspaceFixture(t)
  const first = await workspace.publish({
    channel: 'resource', sourceModule: 'brainstem', kind: 'disk.low', dedupeKey: 'disk.low:2026-10-31',
  })
  const second = await workspace.publish({
    channel: 'resource', sourceModule: 'brainstem', kind: 'disk.low', dedupeKey: 'disk.low:2026-10-31',
  })
  assert.equal(second.id, first.id, '幂等键命中必须返回同一条')
  assert.equal(second.deduped, true)
  assert.equal(countRows(brain.db, 'ws_events'), 1, '不许出现第二行')
})

test('没有 dedupeKey 的事件每次都新建（不是所有事件都该去重）', async (t) => {
  const { workspace, brain } = createWorkspaceFixture(t)
  await workspace.publish({ channel: 'affect', sourceModule: 'modulator', kind: 'energy.tick' })
  await workspace.publish({ channel: 'affect', sourceModule: 'modulator', kind: 'energy.tick' })
  assert.equal(countRows(brain.db, 'ws_events'), 2)
})

test('坏输入不抛错但返回 null：未知 channel、超大 payload', async (t) => {
  const { workspace, brain } = createWorkspaceFixture(t)
  const badChannel = await workspace.publish({ channel: 'nope', sourceModule: 'x', kind: 'y' })
  assert.equal(badChannel, null, '未知 channel 返回 null 而不是抛错（发布不该拖垮主流程）')

  const huge = await workspace.publish({
    channel: 'sense', sourceModule: 'thalamus', kind: 'huge', payload: { blob: 'x'.repeat(20000) },
  })
  assert.equal(huge, null, '超过硬上限的 payload 必须拒绝')
  assert.equal(countRows(brain.db, 'ws_events'), 0, '被拒的事件不许落库')
})

test('pullEvents + advanceCursor：水位只推进到处理完的位置', async (t) => {
  const { workspace, brain, fc } = createWorkspaceFixture(t)
  for (let i = 0; i < 3; i += 1) {
    await workspace.publish({ channel: 'memory', sourceModule: 'hippocampus', kind: `mem.${i}` })
    fc.advance(1000)
  }
  // 首跑没有水位：从最早开始（sinceMs 传 null 表示不限）
  const first = workspace.pullEvents({ moduleName: 'dmn', limit: 2, sinceMs: null })
  assert.equal(first.events.length, 2)
  assert.ok(first.nextCursor.lastAtMs !== null)

  // 没推进水位之前，同一个模块再拉还是从原处开始（不自动前进）
  const again = workspace.pullEvents({ moduleName: 'dmn', limit: 2, sinceMs: null })
  assert.equal(again.events[0].id, first.events[0].id, '未推进水位就不许跳过事件')

  // 推进之后只拿新的
  await workspace.advanceCursor({
    moduleName: 'dmn', lastAtMs: first.nextCursor.lastAtMs, lastEventId: first.nextCursor.lastEventId, count: 2,
  })
  const cursor = workspace.getCursor('dmn')
  assert.equal(cursor.consumedCount, 2)
  const third = workspace.pullEvents({ moduleName: 'dmn', limit: 10 })
  assert.equal(third.events.length, 1, '推进水位后应该只剩最后一条')

  // 另一个模块的水位独立
  assert.equal(workspace.getCursor('cerebellum'), null)
  assert.equal(countRows(brain.db, 'ws_consumers'), 1)
})

// ───────────────────────────── 候选仲裁 ─────────────────────────────

test('候选全流程：propose → claim → complete', async (t) => {
  const { workspace, brain, fc } = createWorkspaceFixture(t)
  const { id } = await workspace.propose({
    kind: 'memory_write',
    originModule: 'hippocampus',
    title: '把「以后都用 pnpm」写成候选记忆',
    payload: { content: '以后都用 pnpm' },
    score: 72,
    scoreBreakdown: { relevance: 40, freshness: 20, help: 12 },
    priority: 60,
    evidence: ['mem_abc'],
    // 用注入时钟算，不要用 Date.now()：fixture 是固定时钟，
    // 两者混用会让「过期判定」在测试里凭空发生（这条踩过一次）。
    expiresAt: new Date(fc.clock.now() + 3600_000).toISOString(),
  })

  const claimed = await workspace.claim({ id, owner: 'hippocampus' })
  assert.equal(claimed.ok, true)
  assert.equal(claimed.candidate.status, 'executing')

  const done = await workspace.complete({ id, owner: 'hippocampus', status: 'done', reason: '已写入' })
  assert.equal(done.ok, true)
  const row = brain.db.prepare('SELECT status, reason FROM ws_candidates WHERE id = ?').get(id)
  assert.equal(String(row.status), 'done')
  assert.equal(String(row.reason), '已写入')
})

test('双 owner 抢同一个候选：只有一个成功（租约是原子的）', async (t) => {
  const { workspace } = createWorkspaceFixture(t)
  const { id } = await workspace.propose({
    kind: 'maintenance', originModule: 'brainstem', title: '重建索引', evidence: ['e1'],
  })
  const a = await workspace.claim({ id, owner: 'owner-a' })
  const b = await workspace.claim({ id, owner: 'owner-b' })
  assert.equal(a.ok, true)
  assert.equal(b.ok, false)
  assert.equal(b.reason, 'leased')
})

test('需要证据的候选没证据 → claim 时被拒并标 rejected', async (t) => {
  const { workspace, brain } = createWorkspaceFixture(t)
  const { id } = await workspace.propose({
    kind: 'proactive',            // 属于 KINDS_REQUIRING_EVIDENCE
    originModule: 'social',
    title: '问候一下',
    evidence: [],
  })
  const claimed = await workspace.claim({ id, owner: 'social' })
  assert.equal(claimed.ok, false)
  assert.equal(claimed.reason, 'evidence_missing')
  const row = brain.db.prepare('SELECT status, reason FROM ws_candidates WHERE id = ?').get(id)
  assert.equal(String(row.status), 'rejected', '要拒绝就拒绝干净，别留在队列里反复被抢')
  assert.match(String(row.reason), /证据/)
})

test('过期候选 claim 时被顺手标 expired（不执行三天前的关心）', async (t) => {
  const { workspace, brain, fc } = createWorkspaceFixture(t)
  const { id } = await workspace.propose({
    kind: 'proactive',
    originModule: 'social',
    title: '问一句吃了没',
    evidence: ['evt_1'],
    expiresAt: new Date(fc.clock.now() + 60_000).toISOString(),
  })
  fc.advance(120_000) // 两分钟后就过期了
  const claimed = await workspace.claim({ id, owner: 'social' })
  assert.equal(claimed.ok, false)
  assert.equal(claimed.reason, 'expired')
  assert.equal(String(brain.db.prepare('SELECT status FROM ws_candidates WHERE id = ?').get(id).status), 'expired')
})

test('候选幂等键：同一 key 重复提议返回同一个 id', async (t) => {
  const { workspace, brain } = createWorkspaceFixture(t)
  const a = await workspace.propose({
    kind: 'reflection', originModule: 'dmn', title: '复盘', idempotencyKey: 'reflection:2026-10-31',
  })
  const b = await workspace.propose({
    kind: 'reflection', originModule: 'dmn', title: '复盘（重跑）', idempotencyKey: 'reflection:2026-10-31',
  })
  assert.equal(b.id, a.id)
  assert.equal(b.deduped, true)
  assert.equal(countRows(brain.db, 'ws_candidates'), 1)
})

test('reclaimExpired：租约过期的僵尸候选回到队列，并加退避', async (t) => {
  const { workspace, brain, fc } = createWorkspaceFixture(t)
  const { id } = await workspace.propose({ kind: 'maintenance', originModule: 'brainstem', title: '清理', evidence: ['e'] })
  const claimed = await workspace.claim({ id, owner: 'worker-1', leaseMs: 5000 })
  assert.equal(claimed.ok, true)

  fc.advance(6000) // 租约过期
  const reclaim = await workspace.reclaimExpired()
  assert.equal(reclaim.reclaimed, 1)

  const row = brain.db.prepare('SELECT status, reason, not_before FROM ws_candidates WHERE id = ?').get(id)
  assert.equal(String(row.status), 'proposed')
  assert.equal(String(row.reason), 'lease_expired')
  assert.ok(row.not_before, '回收后必须有退避时间，否则会立刻被抢回去无限循环')

  // 退避期内抢不到
  const tooEarly = await workspace.claim({ id, owner: 'worker-2' })
  assert.equal(tooEarly.ok, false)
  assert.equal(tooEarly.reason, 'not_before')
})

test('心跳能续期：续过之后别人抢不走', async (t) => {
  const { workspace, fc } = createWorkspaceFixture(t)
  const { id } = await workspace.propose({ kind: 'maintenance', originModule: 'brainstem', title: '长任务', evidence: ['e'] })
  await workspace.claim({ id, owner: 'w1', leaseMs: 10_000 })
  fc.advance(9000)
  const beat = await workspace.heartbeat({ id, owner: 'w1', leaseMs: 10_000 })
  assert.equal(beat.ok, true)
  fc.advance(9000)
  const other = await workspace.claim({ id, owner: 'w2' })
  assert.equal(other.ok, false, '续过租约就不该被别人抢')
})

// ───────────────────────────── 注意力焦点 ─────────────────────────────

test('注意力：无焦点可直接拿，同级抢不走，高优先级能抢占并留审计', async (t) => {
  const { workspace, brain } = createWorkspaceFixture(t)

  const first = await workspace.acquireFocus({
    kind: 'task', ref: 'task-owner-1', label: '给主人改简历', priority: 90, source: 'connector',
  })
  assert.equal(first.ok, true)
  assert.equal(first.focus.kind, 'task')

  // 反思模块（优先级 30）抢不走
  const denied = await workspace.acquireFocus({
    kind: 'maintenance', ref: 'reflect-1', label: '整理记忆', priority: 30, source: 'dmn',
  })
  assert.equal(denied.ok, false)
  assert.equal(denied.reason, 'preempt_denied')
  assert.equal(denied.focus.ref, 'task-owner-1', '拒绝后焦点必须还是原来那个')

  // 主人实时打断（优先级 100）能抢，而且留痕
  const preempt = await workspace.acquireFocus({
    kind: 'task', ref: 'task-owner-2', label: '紧急：改一段文案', priority: 100, source: 'owner',
  })
  assert.equal(preempt.ok, true)
  assert.equal(preempt.preempted, 'task-owner-1')

  const audit = brain.db
    .prepare("SELECT * FROM audit_logs WHERE action = 'attention.preempt' ORDER BY ts DESC LIMIT 1")
    .get()
  assert.ok(audit, '抢占必须写审计——否则「任务做到一半没人管了」永远查不出来')
  assert.equal(JSON.parse(String(audit.detail)).from.ref, 'task-owner-1')

  const event = brain.db
    .prepare("SELECT * FROM ws_events WHERE channel = 'attention' AND kind = 'attention.preempted' ORDER BY at_ms DESC LIMIT 1")
    .get()
  assert.ok(event, '抢占也要发事件，让别的模块知道焦点变了')
})

test('注意力：同一 ref 是续期不是抢占', async (t) => {
  const { workspace } = createWorkspaceFixture(t)
  await workspace.acquireFocus({ kind: 'task', ref: 'task-1', label: 'A', priority: 60 })
  const renewed = await workspace.acquireFocus({ kind: 'task', ref: 'task-1', label: 'A', priority: 60 })
  assert.equal(renewed.ok, true)
  assert.equal(renewed.renewed, true, '同 ref 应该续期')
  assert.equal(workspace.getFocus().preemptCount, 0, '续期不算抢占')
})

test('注意力：release 只在 ref 匹配时生效（A 清不掉 B 的焦点）', async (t) => {
  const { workspace } = createWorkspaceFixture(t)
  await workspace.acquireFocus({ kind: 'task', ref: 'task-1', label: 'A', priority: 90 })
  const wrong = await workspace.releaseFocus({ expectRef: 'task-2' })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.reason, 'ref_mismatch')
  assert.equal(workspace.getFocus().ref, 'task-1', '不匹配时焦点必须原封不动')

  const ok = await workspace.releaseFocus({ expectRef: 'task-1' })
  assert.equal(ok.ok, true)
  assert.equal(workspace.getFocus().kind, 'idle')
})

test('注意力：焦点过期后视为空闲（不会永远被死焦点挡住）', async (t) => {
  const { workspace, fc } = createWorkspaceFixture(t)
  await workspace.acquireFocus({ kind: 'maintenance', ref: 'm1', label: '整理', priority: 20, ttlMs: 5000 })
  assert.equal(workspace.hasActiveFocus(), true)
  fc.advance(6000)
  assert.equal(workspace.hasActiveFocus(), false, '过期焦点不该还占着位置')
  const after = await workspace.getFocus()
  assert.equal(after.expired, true)
})
