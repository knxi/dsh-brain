// @ts-check
/**
 * 反思候选的权限判据：等级 → 能不能做这件事。
 *
 * 这一组断言全是**安全边界**，不是功能测试：
 * 写坏一个 `>=` 就能让 L0 的智能体把 25 条反思全否决掉，而且丢弃是终态、撤不回来。
 * 所以每条规则都正着测一遍、反着测一遍（该拒的拒、该放的放）。
 *
 * 判据本身的来由见 apps/brain-tools/index.js 里 resolveReflectionPermission 的注释。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveReflectionPermission as perm } from '../../apps/brain-tools/index.js'

test('等级解析：读不到 / 不认识的值一律按 L0（失败关）', () => {
  for (const raw of [null, undefined, '', 'L9', 'l2', '2', 2, {}, []]) {
    const out = perm({ level: raw, action: 'list' })
    assert.equal(out.level, 'L0', '输入 ' + JSON.stringify(raw) + ' 应该落到 L0')
    assert.equal(out.lv, 0)
  }
})

test('等级解析：四个合法值原样认出来', () => {
  for (const [raw, lv] of [['L0', 0], ['L1', 1], ['L2', 2], ['L3', 3]]) {
    const out = perm({ level: raw, action: 'list' })
    assert.equal(out.level, raw)
    assert.equal(out.lv, lv)
  }
})

test('list：任何等级都能看（包括 L0）', () => {
  for (const level of ['L0', 'L1', 'L2', 'L3', null]) {
    const out = perm({ level, action: 'list' })
    assert.equal(out.allowed, true, 'list 在 ' + String(level) + ' 下应该允许')
    assert.equal(out.reason, 'ok')
  }
  // 不给 action 时默认就是 list
  assert.equal(perm({ level: 'L0' }).allowed, true)
})

test('run：需要 L2 以上（会新增候选，比处理已有候选重）', () => {
  assert.equal(perm({ level: 'L0', action: 'run' }).allowed, false)
  assert.equal(perm({ level: 'L1', action: 'run' }).allowed, false)
  assert.equal(perm({ level: 'L2', action: 'run' }).allowed, true)
  assert.equal(perm({ level: 'L3', action: 'run' }).allowed, true)
  assert.equal(perm({ level: 'L1', action: 'run' }).reason, 'level_too_low')
})

test('promote：只有 L3 能晋升（会往记忆库写长期记忆）', () => {
  for (const level of ['L0', 'L1', 'L2']) {
    const out = perm({ level, action: 'promote' })
    assert.equal(out.allowed, false, level + ' 不该能晋升')
    assert.equal(out.reason, 'level_too_low')
  }
  assert.equal(perm({ level: 'L3', action: 'promote' }).allowed, true)
})

test('dismiss：L0 一律不许', () => {
  for (const confidence of [0.2, 0.45, 0.5, 0.85, null]) {
    const out = perm({ level: 'L0', action: 'dismiss', confidence })
    assert.equal(out.allowed, false, 'L0 不该能否决（置信度 ' + String(confidence) + '）')
    assert.equal(out.reason, 'level_too_low')
  }
})

test('dismiss：L1 只能否 ≤0.45 的噪声，其余要 L2', () => {
  // 四档真实置信度里只有 knowledge_gap（0.45）落在 L1
  assert.equal(perm({ level: 'L1', action: 'dismiss', confidence: 0.45 }).allowed, true)
  assert.equal(perm({ level: 'L1', action: 'dismiss', confidence: 0.45 }).reason, 'ok_weak_only')
  assert.equal(perm({ level: 'L1', action: 'dismiss', confidence: 0.3 }).allowed, true)
  // 承诺 0.5 / 模式 0.6 / 矛盾 0.85 —— 这几档 L1 不许碰
  for (const confidence of [0.5, 0.6, 0.85]) {
    const out = perm({ level: 'L1', action: 'dismiss', confidence })
    assert.equal(out.allowed, false, 'L1 不该能否置信度 ' + confidence + ' 的候选')
    assert.equal(out.reason, 'level_too_low_for_confidence')
  }
})

test('dismiss：置信度读不到时 L1 不猜，按拒处理', () => {
  for (const confidence of [null, undefined, NaN, 'abc']) {
    const out = perm({ level: 'L1', action: 'dismiss', confidence })
    assert.equal(out.allowed, false, '置信度 ' + String(confidence) + ' 不可用时不该放行')
  }
})

test('dismiss：L2 / L3 能否决任意置信度', () => {
  for (const level of ['L2', 'L3']) {
    for (const confidence of [0.45, 0.5, 0.6, 0.85, null]) {
      const out = perm({ level, action: 'dismiss', confidence })
      assert.equal(out.allowed, true, level + ' 应该能否决（置信度 ' + String(confidence) + '）')
      assert.equal(out.reason, 'ok')
    }
  }
})

test('不认识的 action 一律拒，且不误判成 list', () => {
  for (const action of ['delete', 'DROP', 'purge', '']) {
    // 空字符串按默认 list 处理，其余都该拒
    const out = perm({ level: 'L3', action })
    if (action === '') assert.equal(out.allowed, true)
    else {
      assert.equal(out.allowed, false, 'action=' + action + ' 应该被拒')
      assert.equal(out.reason, 'unknown_action')
    }
  }
})

test('大小写不敏感：Dismiss / PROMOTE 跟小写等价', () => {
  assert.equal(perm({ level: 'L2', action: 'Dismiss', confidence: 0.85 }).allowed, true)
  assert.equal(perm({ level: 'L2', action: 'PROMOTE' }).allowed, false)
  assert.equal(perm({ level: 'L3', action: 'Promote' }).allowed, true)
})
