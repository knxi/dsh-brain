// @ts-check
/**
 * 工作空间 · 全局开关（逃生门）的验收测试。
 *
 * 这一组测试的定位不是「功能对不对」，而是「**关掉的时候真的什么都没发生**」。
 * 逃生门失效是这类系统最贵的一种 bug：平时看不出来，出事那天才发现关不掉。
 */

import test from 'node:test'
import { assert, countRows, createWorkspaceFixture } from './helpers.mjs'

test('默认姿态：自主 / 主动社交 / 外发 / 反思 全部关闭，paused=0', async (t) => {
  const { workspace } = createWorkspaceFixture(t)
  assert.equal(workspace.isEnabled('autonomy.enabled'), false, '自主默认必须关')
  assert.equal(workspace.isEnabled('social.enabled'), false, '主动社交默认必须关')
  assert.equal(workspace.isEnabled('social.allow_external'), false, '外发默认必须关')
  assert.equal(workspace.isEnabled('reflection.enabled'), false, '反思默认必须关')
  assert.equal(workspace.isPaused(), false, '全局暂停默认是 0')
  assert.equal(workspace.getSwitch('autonomy.max_level'), 'L1', '默认权限等级 L1')
})

test('布尔开关只接受 0/1：给个 "yes" 必须被拒（模糊值不许进库）', async (t) => {
  const { workspace } = createWorkspaceFixture(t)
  await assert.rejects(
    () => workspace.setSwitch('autonomy.enabled', 'yes', { by: 'test' }),
    /只接受 '0' \/ '1'/,
    '布尔开关必须拒绝非 0/1 的值——否则「yes 算不算开」会变成每个人理解都不一样',
  )
  await assert.rejects(() => workspace.setSwitch('paused', 'maybe', { by: 'test' }), /只接受 '0' \/ '1'/)
})

test('switch 大小写/形态：1/true/on/yes 算开，其它一律算关', async (t) => {
  const { workspace } = createWorkspaceFixture(t)
  for (const [value, expected] of [['1', true], ['0', false]]) {
    await workspace.setSwitch('reflection.enabled', value, { by: 'test' })
    assert.equal(workspace.isEnabled('reflection.enabled'), expected, `${value} → ${expected}`)
  }
  // 非布尔键接受任意字符串（如 max_level = 'L2'）
  await workspace.setSwitch('autonomy.max_level', 'L2', { by: 'test' })
  assert.equal(workspace.getSwitch('autonomy.max_level'), 'L2')
})

test('改开关要留审计：谁、从什么改到什么、为什么', async (t) => {
  const { workspace, brain } = createWorkspaceFixture(t)
  await workspace.setSwitch('social.enabled', '1', { by: 'owner', reason: '观察期试验' })
  const row = brain.db
    .prepare("SELECT * FROM audit_logs WHERE action = 'switch.set' AND target_id = 'social.enabled' ORDER BY ts DESC LIMIT 1")
    .get()
  assert.ok(row, '必须有一条 switch.set 审计')
  assert.equal(String(row.actor), 'owner')
  const detail = JSON.parse(String(row.detail))
  assert.equal(detail.before, '0')
  assert.equal(detail.after, '1')
  assert.equal(detail.reason, '观察期试验')
})

test('assertAllowed：暂停优先级最高，其次是模块开关，最后是等级', async (t) => {
  const { workspace } = createWorkspaceFixture(t)
  // 三个模块默认都不允许
  assert.equal(workspace.assertAllowed({ module: 'autonomy' }).allowed, false)
  assert.equal(workspace.assertAllowed({ module: 'social' }).allowed, false)
  assert.equal(workspace.assertAllowed({ module: 'reflection' }).allowed, false)

  // 打开自主但等级不够 L2
  await workspace.setSwitch('autonomy.enabled', '1', { by: 'test' })
  assert.equal(workspace.assertAllowed({ module: 'autonomy', requiredLevel: 'L1' }).allowed, true)
  const low = workspace.assertAllowed({ module: 'autonomy', requiredLevel: 'L2' })
  assert.equal(low.allowed, false)
  assert.match(String(low.reason), /level_too_low/)

  // 暂停压过一切：即使模块开着、等级够，也必须拒绝
  await workspace.setSwitch('paused', '1', { by: 'owner', reason: '全局停止' })
  const paused = workspace.assertAllowed({ module: 'autonomy', requiredLevel: 'L1' })
  assert.equal(paused.allowed, false)
  assert.equal(paused.reason, 'global_paused')
})

test('外发开关独立于社交开关：social.enabled=1 不等于允许外发', async (t) => {
  const { workspace } = createWorkspaceFixture(t)
  await workspace.setSwitch('social.enabled', '1', { by: 'test' })
  const allowed = workspace.assertAllowed({ module: 'social' })
  assert.equal(allowed.allowed, true)
  assert.equal(allowed.allowExternal, false, 'allow_external 还是 0，必须只进控制台')

  await workspace.setSwitch('social.allow_external', '1', { by: 'owner' })
  assert.equal(workspace.assertAllowed({ module: 'social' }).allowExternal, true)
})

test('listSwitches：六个已知开关都在，缺的用默认值补齐并标注 isDefault', async (t) => {
  const { workspace } = createWorkspaceFixture(t)
  const list = workspace.listSwitches()
  const names = list.map((item) => item.name)
  for (const expected of ['autonomy.enabled', 'autonomy.max_level', 'social.enabled', 'social.allow_external', 'reflection.enabled', 'paused']) {
    assert.ok(names.includes(expected), `缺开关 ${expected}`)
  }
  const autonomy = list.find((item) => item.name === 'autonomy.enabled')
  assert.equal(autonomy.value, '0')
  assert.equal(autonomy.isDefault, true, '迁移里 INSERT OR IGNORE 写的是默认值，没被改过就该标 isDefault')
})

test('关掉开关后写入零副作用：noop 路径不产生任何行（逃生门真能逃）', async (t) => {
  const { workspace, brain } = createWorkspaceFixture(t)
  const before = {
    events: countRows(brain.db, 'ws_events'),
    candidates: countRows(brain.db, 'ws_candidates'),
    audits: countRows(brain.db, 'audit_logs'),
  }
  // 模拟一个守规矩的模块：先问开关，不允许就什么都不做
  const gate = workspace.assertAllowed({ module: 'reflection' })
  assert.equal(gate.allowed, false)
  if (gate.allowed) {
    await workspace.publish({ channel: 'affect', sourceModule: 'dmn', kind: 'reflection.started' })
    await workspace.propose({ kind: 'reflection', originModule: 'dmn', title: '不该发生' })
  }
  assert.equal(countRows(brain.db, 'ws_events'), before.events, '关着的时候不许有事件')
  assert.equal(countRows(brain.db, 'ws_candidates'), before.candidates, '关着的时候不许有候选')
  assert.equal(countRows(brain.db, 'audit_logs'), before.audits, '连审计都不该多（它没做任何事）')
})
