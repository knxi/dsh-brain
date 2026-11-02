// @ts-check
/**
 * 补录「文档里有、库里没有」的结论性事实（M7.1 · 2026-10-30）。
 *
 * ── 为什么需要它 ──
 * 观察期拿三个「明明该有」的查询真打了一遍（`docs/OBSERVATION-2026-10-29.md` 第七节）：
 * 「群星设计血统」「心海定义」「卸载 Engram 的目标」在库里**全部是「证据不够」**。
 * 不是索引坏了（语义相邻的条目都捞得出来），是这些结论**从来没进过记忆库**——
 * 它们只活在 docs 里。迁移搬的是「对话里说过的话」，没搬「文档里沉淀的结论」。
 *
 * ── 为什么 sourceType 是 observation 而不是 owner_words ──
 * 这些是**我读文档整理出来的结论**，不是主人这一句亲口说的。写成 owner_words 就是虚报，
 * 而且会毁掉 M5 自动提取的区分度（那套要靠 observation 表达「我看到的」）。
 * 所以：`sourceType='observation'` + `confidence=0.8`。
 *
 * ── 幂等 ──
 * 按 `content` 精确比对已存在的记忆（同 scope + 未删除）；已存在就跳过并如实报 `already`。
 * 重复跑不会制造第二份——同一条事实存两遍正是这次要治的病（合并过 5 对重复）。
 *
 *   node tools/seed-project-facts.mjs            # 预演（默认，只读打开）
 *   node tools/seed-project-facts.mjs --apply    # 真写
 */

import { openBrain } from '../packages/memory/src/index.js'

const BRAIN_DB = 'E:/ds-h/dsh-brain/data/brain.db'
const MIGRATIONS = 'E:/ds-h/dsh-brain/migrations'
const DEFAULT_SCOPE = 'owner-default'
const DEFAULT_PERSON = 'owner'
const PRODUCER = 'tools/seed-project-facts.mjs'

/**
 * 内置补录清单。每条都标了依据文件——**没有依据的不写**，
 * 记忆库里塞一条「像是真的」比空着更糟。
 *
 * @type {ReadonlyArray<{ content: string, summary: string, type: string, importance: number, basis: string }>}
 */
const FACTS = Object.freeze([
  Object.freeze({
    type: 'semantic',
    importance: 0.9,
    summary: '外置大脑的目标：补齐能力后卸载 Engram 与灵枢',
    basis: 'docs/HANDOVER.md §4「还不能卸灵枢 / Engram」，docs/ROADMAP.md 开头',
    content:
      '外置大脑（dsh-brain）的最终目标是补齐能力后卸载 Engram 与灵枢。硬门槛两条：' +
      '①自动提取（M5）——现在是 explicit 模式，主人不说「记住」就不记，卸了等于停止记录新东西；' +
      '②观察期数据——迁进来的 205 条要实际用几轮，搬过来 ≠ 用得好。' +
      '卸载顺序：并行跑 → 观察一周 → 先关一个 → 再关另一个；卸前必须完整备份（E:\\ds-h\\tools\\backup\\backup-dsh.ps1）。',
  }),
  Object.freeze({
    type: 'semantic',
    importance: 0.7,
    summary: '心海 3D 星图视觉来自 3d-memory-sea（MIT）',
    basis: 'docs/HANDOVER.md §8「三段设计血统」',
    content:
      '心海的 3D 星图视觉来自 GitHub 项目 3d-memory-sea（MIT 许可），借的是：三维投影、斐波那契球面布簇、' +
      '深度排序遮挡、Canvas 2D 渲染。页面自身零第三方依赖、无构建链。',
  }),
  Object.freeze({
    type: 'semantic',
    importance: 0.7,
    summary: '心海的交互框架抄《群星（Stellaris）》，只借交互不借素材',
    basis: 'docs/HANDOVER.md §8「三段设计血统」',
    content:
      '心海的交互框架抄的是游戏《群星（Stellaris）》的交互模式，**只借交互、不借素材和代码**：' +
      '地图模式切换、左侧边栏、右侧上下文面板、顶部状态条、底部工具栏、hover 反馈。',
  }),
  Object.freeze({
    type: 'semantic',
    importance: 0.6,
    summary: '心海动效方法论来自《UI 动画设计指南》（skillsbot 11806）',
    basis: 'docs/HANDOVER.md §8「三段设计血统」',
    content:
      '心海的动效方法论来自《UI 动画设计指南》（skillsbot 11806）：缓动曲线、时序、重叠，' +
      '以及 prefers-reduced-motion 降级。',
  }),
  Object.freeze({
    type: 'semantic',
    importance: 0.75,
    summary: '「心海」是 /dsh-brain/sea 的自造名（3D 记忆海页面）',
    basis: 'docs/HANDOVER.md §1 入口表；docs/ROADMAP.md「现在能用的」',
    content:
      '「心海」是外置大脑 3D 记忆海页面（/dsh-brain/sea）的自造名——那是把全库记忆以星点 + 真实关系边' +
      '呈现出来的可视化视图（星点沉浮、可筛选、可点星聚焦）。它不是独立项目，也不是对外产品名。',
  }),
  Object.freeze({
    type: 'semantic',
    importance: 0.7,
    summary: '设计母本是《DSH外置大脑-可执行设计方案-v1.2》；文档与实机冲突时以实机为准',
    basis: 'docs/HANDOVER.md 开头 + §9 第 2 句「不信文档，信实验」',
    content:
      '外置大脑的原始设计母本是《DSH外置大脑-可执行设计方案-v1.2》，实现按 M0–M6 分阶段对照它落地。' +
      '**文档和实机行为对不上时以实机为准**——至少 5 处对不上过：hook 名、注入形态、隔离边界、FTS 语法、createdAt。',
  }),
  Object.freeze({
    type: 'semantic',
    importance: 0.85,
    summary: '观察期纪律：样本 < 20 次不做「准不准」的判断',
    basis: 'docs/ROADMAP.md「当前第一优先：观察期」，docs/CONTRACTS.md §12',
    content:
      '外置大脑观察期纪律：样本少于 20 次检索不做任何「检索准不准」的判断；' +
      '零命中榜里出现「明明该有的东西」才是真信号（那时才查索引）；覆盖率不等于「没用」，不据此删记忆；' +
      '判断「命中是否被用上」只认已回答里出现连续 ≥12 字原文的证据，没引用不等于没用上，记未判定而不是 false。',
  }),
  Object.freeze({
    type: 'semantic',
    importance: 0.9,
    summary: '外置大脑三条铁律：不开 automatic 注入 / 不调检索权重 / 不迁灵枢',
    basis: 'docs/ROADMAP.md「明确不做的事」+ docs/CONTRACTS.md 实测',
    content:
      '外置大脑三条不做：①不自动开 automatic 注入（会在每轮对话里塞东西，生产插件组合和真实语料都没验过）；' +
      '②没有新数据不调检索权重——实测 ngram 权重一进排序，P@10 就从 83.6% 掉到 49.9%；' +
      '③不迁灵枢——它的 33 个节点全是对话原文不是记忆，迁进来只稀释检索，它的价值在自动注入机制而不在数据。',
  }),
])

const USAGE = `用法：
  node tools/seed-project-facts.mjs            预演（默认，只读，不写库）
  node tools/seed-project-facts.mjs --apply    真写`

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** @param {string[]} argv */
function parseArgs(argv) {
  const out = { apply: false }
  for (const arg of argv) {
    if (arg === '--apply') out.apply = true
    else if (arg === '--help' || arg === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else throw new Error(`未知参数：${arg}\n${USAGE}`)
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  console.log(`=== 补录项目结论性事实（${args.apply ? '真写' : '预演'}）===`)
  console.log(`库：${BRAIN_DB} | scope：${DEFAULT_SCOPE} | 清单：${FACTS.length} 条`)
  console.log(args.apply
    ? '--apply 走 openBrain()，会顺手应用未执行的迁移（CONTRACTS §13.7）——当前库已是 0006。'
    : '本次不会写库：预演用 readOnly 连接打开，不跑迁移。')
  console.log('sourceType=observation（文档结论，不是主人原话）、confidence=0.8。')
  console.log('')

  const brain = await openBrain({
    dbPath: BRAIN_DB,
    migrationsDir: MIGRATIONS,
    bindings: { scope_id: DEFAULT_SCOPE, person_id: DEFAULT_PERSON },
    readOnly: !args.apply,
  })

  /** @type {Array<{ summary: string, action: string, memoryId?: string, detail?: string }>} */
  const results = []

  try {
    // 幂等判据：同 scope、未删除、content 完全一致。用 list 拉全量再比，不猜 hash 口径。
    const existing = new Set()
    let cursor = null
    do {
      const page = brain.memories.list({ scopeId: DEFAULT_SCOPE, limit: 200, ...(cursor ? { cursor } : {}) })
      for (const item of page.items) {
        if (item && typeof item.content === 'string') existing.add(item.content)
      }
      cursor = page.nextCursor
    } while (cursor)

    for (const fact of FACTS) {
      try {
        if (existing.has(fact.content)) {
          results.push({ summary: fact.summary, action: 'already', detail: '库里已有同文记忆' })
          continue
        }
        if (!args.apply) {
          results.push({ summary: fact.summary, action: 'would-create', detail: `依据：${fact.basis}` })
          continue
        }
        const created = await brain.memories.create({
          scopeId: DEFAULT_SCOPE,
          personId: DEFAULT_PERSON,
          layer: 'long',
          type: fact.type,
          content: fact.content,
          summary: fact.summary,
          sourceType: 'observation',
          sourceIds: [],
          confidence: 0.8,
          importance: fact.importance,
          privacy: 'private',
          originSystem: 'dsh',
          producer: PRODUCER,
        })
        // 来源关联：不然检索会如实报 source_missing。locator 指向依据文档，人能顺着核对。
        try {
          await brain.sources.link(created.id, {
            sourceKind: 'document',
            sourceSystem: 'dsh',
            sourceEventId: `doc:${fact.basis.split(' ')[0]}`,
            locator: fact.basis,
          })
        } catch {
          /* 关联失败不改写结论：记忆本身已经写进去了 */
        }
        existing.add(fact.content)
        results.push({ summary: fact.summary, action: 'created', memoryId: created.id, detail: `依据：${fact.basis}` })
      } catch (error) {
        results.push({ summary: fact.summary, action: 'failed', detail: messageOf(error) })
      }
    }
  } finally {
    await brain.close?.()
  }

  console.log('补录清单：')
  for (const row of results) {
    console.log(`  · ${row.action.padEnd(13)} ${row.summary}`)
    if (row.memoryId) console.log(`      ${row.memoryId}`)
    if (row.detail) console.log(`      ${row.detail}`)
  }
  const count = (/** @type {string} */ a) => results.filter((r) => r.action === a).length
  console.log('')
  console.log(
    `SUMMARY mode=${args.apply ? 'apply' : 'dry-run'} planned=${FACTS.length} ` +
      `created=${count('created')} would_create=${count('would-create')} already=${count('already')} failed=${count('failed')}`,
  )
  if (count('failed') > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(`[seed-project-facts] 失败：${messageOf(error)}`)
  process.exitCode = 1
})
