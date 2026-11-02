// @ts-check
/**
 * 孤儿实体关联工具的单测（M6.3）。
 *
 * 测的是「判据」本身，不是 CLI：
 * - 孤儿识别（挂着活跃记忆的不算孤儿）
 * - 中文实体名 / alias 命中
 * - **路径片段不算提到实体**（`E:\ds-h\x` 里的 `ds-h` 不能命中）——这是实测踩到的坑
 * - 已关联的排除
 * - 无证据返回空数组（不猜）
 *
 * 全部用临时库，跑完删干净。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openBrain } from '../../../packages/memory/src/index.js'
import { findOrphans, findCandidates } from '../../../tools/link-orphan-entities.mjs'

const MIGRATIONS = 'E:/ds-h/dsh-brain/migrations'
const SCOPE = 'test-scope'

/**
 * 建一个临时主账（测完删）。
 * @param {import('node:test').TestContext} t
 */
async function tempBrain(t) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-orphan-'))
  const brain = await openBrain({
    dbPath: join(dir, 'brain.db'),
    migrationsDir: MIGRATIONS,
    bindings: { scope_id: SCOPE, person_id: 'test-owner' },
  })
  // 顺序要紧：`t.after` 按注册顺序执行，**先关库再删目录**。
  // 反过来会 EPERM（Windows 上打开着的 sqlite 文件删不掉）——实测过。
  t.after(async () => {
    await brain.close?.()
  })
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  return brain
}

/** @param {any} brain @param {string} content @param {string} [summary] */
async function addMemory(brain, content, summary) {
  const created = await brain.memories.create({
    scopeId: SCOPE,
    personId: 'test-owner',
    layer: 'long',
    type: 'semantic',
    content,
    summary: summary ?? content.slice(0, 30),
    sourceType: 'observation',
    sourceIds: [],
    confidence: 0.6,
    importance: 0.5,
    privacy: 'private',
    originSystem: 'dsh',
    producer: 'tests/link-orphans',
  })
  return created
}

test('1. findOrphans：挂着活跃记忆的实体不算孤儿', async (t) => {
  const brain = await tempBrain(t)
  const linked = await brain.entities.upsert({ scopeId: SCOPE, name: '心海', kind: 'project' })
  const orphan = await brain.entities.upsert({ scopeId: SCOPE, name: '群星', kind: 'other' })
  const memory = await addMemory(brain, '心海是 3D 记忆海页面的自造名。')
  await brain.entities.linkMemory(memory.id, linked.id, { role: 'mentioned_in' })

  const orphans = findOrphans(brain.db, SCOPE)
  const names = orphans.map((/** @type {any} */ e) => e.name)
  assert.deepEqual(names, ['群星'], '只有群星是孤儿')
  assert.equal(orphan.id, orphans[0].id)
})

test('2. findCandidates：中文实体名命中正文，且带片段', async (t) => {
  const brain = await tempBrain(t)
  const entity = await brain.entities.upsert({ scopeId: SCOPE, name: '群星', kind: 'other' })
  const memory = await addMemory(brain, '心海的交互框架抄的是游戏《群星（Stellaris）》的交互模式。')

  const candidates = findCandidates(brain.db, { id: entity.id, name: '群星', kind: 'other', aliases: [] }, {
    scopeId: SCOPE,
    limit: 20,
    minLength: 2,
    excludeIds: new Set(),
  })
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].memoryId, memory.id)
  assert.match(candidates[0].excerpt, /群星/, '片段里必须能看到命中的词')
})

test('3. 路径片段不算提到实体（实测踩过的坑）', async (t) => {
  const brain = await tempBrain(t)
  const entity = await brain.entities.upsert({ scopeId: SCOPE, name: 'ds-h', kind: 'project' })
  // 只出现在路径里 → 不该算证据
  await addMemory(brain, '代码根目录是 E:\\ds-h\\dsh-brain，工作目录 E:\\ds-h。')
  const candidates = findCandidates(brain.db, { id: entity.id, name: 'ds-h', kind: 'project', aliases: [] }, {
    scopeId: SCOPE,
    limit: 20,
    minLength: 2,
    excludeIds: new Set(),
  })
  assert.equal(candidates.length, 0, '路径里的子串不是「提到这个实体」')
})

test('4. alias 命中：实体名不在正文、但 alias 在', async (t) => {
  const brain = await tempBrain(t)
  const entity = await brain.entities.upsert({
    scopeId: SCOPE,
    name: '外置大脑项目',
    kind: 'project',
    aliases: ['dsh-brain'],
  })
  const memory = await addMemory(brain, 'dsh-brain 的 M3 删除线已交付。')
  const candidates = findCandidates(
    brain.db,
    { id: entity.id, name: '外置大脑项目', kind: 'project', aliases: ['dsh-brain'] },
    { scopeId: SCOPE, limit: 20, minLength: 2, excludeIds: new Set() },
  )
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].memoryId, memory.id)
  assert.equal(candidates[0].matched, 'dsh-brain')
})

test('5. 已关联的记忆被排除（幂等的基础）', async (t) => {
  const brain = await tempBrain(t)
  const entity = await brain.entities.upsert({ scopeId: SCOPE, name: '心海', kind: 'project' })
  const memory = await addMemory(brain, '心海的 3D 星图视觉来自 3d-memory-sea。')
  const candidates = findCandidates(
    brain.db,
    { id: entity.id, name: '心海', kind: 'project', aliases: [] },
    { scopeId: SCOPE, limit: 20, minLength: 2, excludeIds: new Set([memory.id]) },
  )
  assert.equal(candidates.length, 0, '已关联的不能再进候选')
})

test('6. 无证据返回空数组（不猜）', async (t) => {
  const brain = await tempBrain(t)
  const entity = await brain.entities.upsert({ scopeId: SCOPE, name: 'toNumber', kind: 'concept' })
  await addMemory(brain, '完全无关的一条记忆：外墙保温用 50mm 岩棉。')
  const candidates = findCandidates(
    brain.db,
    { id: entity.id, name: 'toNumber', kind: 'concept', aliases: [] },
    { scopeId: SCOPE, limit: 20, minLength: 2, excludeIds: new Set() },
  )
  assert.deepEqual(candidates, [], '没有任何证据就不建关联')
})

test('7. 实体名过短被跳过（minLength）', async (t) => {
  const brain = await tempBrain(t)
  const entity = await brain.entities.upsert({ scopeId: SCOPE, name: 'X', kind: 'other' })
  await addMemory(brain, 'X 是一个字母，到处都是 X。')
  const candidates = findCandidates(
    brain.db,
    { id: entity.id, name: 'X', kind: 'other', aliases: [] },
    { scopeId: SCOPE, limit: 20, minLength: 2, excludeIds: new Set() },
  )
  assert.deepEqual(candidates, [], '单字实体太泛，直接跳过')
})
