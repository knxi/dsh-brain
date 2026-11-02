// @ts-check
/**
 * §22.3 可回归测试集 —— 120 个固定用例 + 五项门槛。
 *
 * ── 这个测试和别的测试有什么不同 ──
 *
 * tests/ 下其他 574 个用例验的是**工程正确性**（事务、幂等、边界、恢复）。
 * 这里验的是**检索质量**：在当前实现下，那 120 个问题到底答不答得上。
 *
 * ── 门槛没达标会红 ──
 *
 * 这是有意的。设计文档 §22.3 写的「建议 MVP 门槛」是：
 * Recall@10 ≥ 90%、精确值必须一致、当前查询旧值误用 = 0、
 * 来源可回查率 100%、无答案用例错误回答 = 0。
 *
 * 如果现在不达标，**测试就该红**——那是真实状态，不是测试写错了。
 * 修的方向是检索能力（或重新审视用例是否过严），不是把断言放宽。
 *
 * ── 两条不算进去的 ──
 *
 * 任务快照续接、构包注入 precision、模型最终回答质量，
 * 都在报告里单列「不适用」并写明原因，不算通过也不算失败。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CASES, CASE_COUNTS, REQUIRED_COUNTS } from './cases.mjs'
import { EVAL_PERSON, EVAL_SCOPE } from './fixtures.mjs'
import { THRESHOLDS, evaluate } from './metrics.mjs'
import { seedBrain } from './seed.mjs'

const MIGRATIONS = fileURLToPath(new URL('../../migrations/', import.meta.url))

test('§22.3 用例集：120 条，7 类配额与设计文档一致', () => {
  assert.equal(CASES.length, 120, '用例总数必须是 120')
  for (const [category, expected] of Object.entries(REQUIRED_COUNTS)) {
    assert.equal(CASE_COUNTS[category], expected, `${category} 应为 ${expected} 条，实际 ${CASE_COUNTS[category]}`)
  }
  assert.equal(new Set(CASES.map((c) => c.id)).size, 120, '用例 id 必须唯一')
  for (const c of CASES) {
    assert.ok(typeof c.query === 'string' && c.query.length > 0, `${c.id} 缺 query`)
    assert.ok(typeof c.note === 'string' && c.note.length > 0, `${c.id} 缺 note`)
    // 要么期望召回，要么期望弃答 —— 不允许两个都不表态（那样这条用例没有判定标准）
    const hasExpectation = c.expectKeys.length > 0 || c.expectAbstain === true
    assert.ok(hasExpectation, `${c.id} 既没期望来源也没说该弃答，等于没有判定标准`)
  }
})

test('§22.3 评测：五项门槛（检索层）', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-brain-eval-'))
  const { brain, keyToId, close } = await seedBrain({ dbPath: join(dir, 'brain.db'), migrationsDir: MIGRATIONS })
  try {
    const report = evaluate({
      search: (/** @type {any} */ args) => brain.memories.search({
        ...args,
        scopeId: EVAL_SCOPE,
        personId: EVAL_PERSON,
      }),
      cases: CASES,
      keyToId,
      limit: 10,
    })

    t.diagnostic(`用例 ${report.total} · 可回答 ${report.answerableTotal} · 应弃答 ${report.abstainCases}`)
    t.diagnostic(`Recall@10 = ${report.recallAt10} (${report.recallNumerator}/${report.recallDenominator})，门槛 ${THRESHOLDS.recallAt10}`)
    t.diagnostic(`精确值正确率 = ${report.exactCorrectRate} (${report.exactNumerator}/${report.exactDenominator})`)
    t.diagnostic(`当前查询旧值误用 = ${report.staleMisuse}，门槛 ${THRESHOLDS.staleMisuse}`)
    t.diagnostic(`来源可追溯率 = ${report.sourceTraceability} (${report.sourceNumerator}/${report.sourceDenominator})`)
    t.diagnostic(`无答案用例错误确定回答 = ${report.falseAnswers} / ${report.abstainCases}（比率 ${report.falseAnswerRate}）`)
    t.diagnostic(`其中系统如实弃答 ${report.abstainedProperly} 条（insufficient_evidence / no_related）—— 这是做对了`)
    t.diagnostic(`不适用项：${report.notApplicable.map((/** @type {any} */ x) => x.item).join('；')}`)
    if (report.failures.length > 0) {
      t.diagnostic(`未达标用例 ${report.failures.length} 条：${report.failures.slice(0, 12).map((/** @type {any} */ f) => f.id).join(', ')}`)
    }

    // ── 结构断言（必须全过）──
    assert.equal(report.total, 120)

    // ── 五项门槛 ──
    assert.ok(
      report.recallAt10 !== null && report.recallAt10 >= THRESHOLDS.recallAt10,
      `Recall@10 ${report.recallAt10} 低于门槛 ${THRESHOLDS.recallAt10}`,
    )
    assert.ok(
      report.exactCorrectRate !== null && report.exactCorrectRate >= THRESHOLDS.exactCorrectRate,
      `精确值正确率 ${report.exactCorrectRate} 低于门槛 ${THRESHOLDS.exactCorrectRate}`,
    )
    assert.equal(report.staleMisuse, THRESHOLDS.staleMisuse, `当前查询旧值误用应为 0，实际 ${report.staleMisuse}`)
    assert.ok(
      report.sourceTraceability !== null && report.sourceTraceability >= THRESHOLDS.sourceTraceability,
      `来源可追溯率 ${report.sourceTraceability} 低于门槛 ${THRESHOLDS.sourceTraceability}`,
    )
    assert.equal(report.falseAnswers, THRESHOLDS.falseAnswerRate, `无答案用例错误确定回答应为 0，实际 ${report.falseAnswers}`)
  } finally {
    await close()
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }
})
