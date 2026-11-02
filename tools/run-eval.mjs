// @ts-check
/**
 * 生成 §22.3 评测报告（Markdown 落 docs/EVAL-REPORT.md）。
 *
 *   node tools/run-eval.mjs            # 写报告
 *   node tools/run-eval.mjs --stdout   # 只打印不写文件
 *
 * 为什么报告要单独生成、不塞进测试：
 * 测试只回答「过没过」，报告要回答「差在哪、为什么差」。两件事的读者不同——
 * 测试给 CI 看，报告给做决定的人看。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CASES, CASE_COUNTS, REQUIRED_COUNTS } from '../tests/eval/cases.mjs'
import { EVAL_PERSON, EVAL_SCOPE } from '../tests/eval/fixtures.mjs'
import { THRESHOLDS, evaluate } from '../tests/eval/metrics.mjs'
import { seedBrain } from '../tests/eval/seed.mjs'

const MIGRATIONS = fileURLToPath(new URL('../migrations/', import.meta.url))
const OUT = fileURLToPath(new URL('../docs/EVAL-REPORT.md', import.meta.url))

/** @param {number|null} v */
const pct = (v) => (v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%')

/** @param {number} v @param {number} threshold */
const mark = (v, threshold) => (v >= threshold ? '✅' : '❌')

const dir = mkdtempSync(join(tmpdir(), 'dsh-eval-report-'))
const { brain, keyToId, close } = await seedBrain({ dbPath: join(dir, 'brain.db'), migrationsDir: MIGRATIONS })

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

await close()
try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }

const lines = []
lines.push('# §22.3 可回归测试集 · 评测报告')
lines.push('')
lines.push(`> 由 \`node tools/run-eval.mjs\` 生成 · ${new Date().toISOString()}`)
lines.push('> 对照基准：《DSH外置大脑-可执行设计方案-v1.2》§22.3')
lines.push('> 用例集：`tests/eval/cases.mjs`（120 条，合成语料，不使用真实隐私）')
lines.push('')
lines.push('## 0. 结论')
lines.push('')

const passedAll =
  report.recallAt10 >= THRESHOLDS.recallAt10 &&
  report.exactCorrectRate >= THRESHOLDS.exactCorrectRate &&
  report.staleMisuse === THRESHOLDS.staleMisuse &&
  report.sourceTraceability >= THRESHOLDS.sourceTraceability &&
  report.falseAnswers === THRESHOLDS.falseAnswerRate

lines.push(passedAll
  ? '**五项门槛全部达标**（检索层口径，见第 3 节「不适用」）。'
  : '**有门槛未达标**——见第 1 节的红项。')
lines.push('')
lines.push('## 1. 五项门槛')
lines.push('')
lines.push('| 指标 | 结果 | 门槛 | 判定 |')
lines.push('|---|---|---|---|')
lines.push(`| Recall@10 | ${pct(report.recallAt10)}（${report.recallNumerator}/${report.recallDenominator}） | ≥ ${pct(THRESHOLDS.recallAt10)} | ${mark(report.recallAt10 ?? 0, THRESHOLDS.recallAt10)} |`)
lines.push(`| 精确参数正确率 | ${pct(report.exactCorrectRate)}（${report.exactNumerator}/${report.exactDenominator}） | = 100% | ${mark(report.exactCorrectRate ?? 0, THRESHOLDS.exactCorrectRate)} |`)
lines.push(`| 当前查询旧值误用 | ${report.staleMisuse} | = 0 | ${report.staleMisuse === 0 ? '✅' : '❌'} |`)
lines.push(`| 来源可回查率（检索层） | ${pct(report.sourceTraceability)}（${report.sourceNumerator}/${report.sourceDenominator}） | = 100% | ${mark(report.sourceTraceability ?? 0, THRESHOLDS.sourceTraceability)} |`)
lines.push(`| 无答案用例错误确定回答 | ${report.falseAnswers} / ${report.abstainCases}（另有 ${report.abstainedProperly} 条如实弃答） | = 0 | ${report.falseAnswers === 0 ? '✅' : '❌'} |`)
lines.push('')
lines.push('## 2. 分类目')
lines.push('')
lines.push('| 类目 | 用例 | 应召回 | 实召回 | 应弃答 | 错误回答 |')
lines.push('|---|---|---|---|---|---|')
for (const [category, expected] of Object.entries(REQUIRED_COUNTS)) {
  const b = report.byCategory[category] || { total: 0, withExpectation: 0, recallHit: 0, abstain: 0, falseAnswer: 0 }
  lines.push(`| ${category} | ${b.total} / ${expected} | ${b.withExpectation} | ${b.recallHit} | ${b.abstain} | ${b.falseAnswer} |`)
}
lines.push('')
lines.push('## 3. 不适用（不算通过，也不算失败）')
lines.push('')
lines.push('| 项 | 为什么不算 |')
lines.push('|---|---|')
for (const n of report.notApplicable) lines.push(`| ${n.item} | ${n.reason} |`)
lines.push('')
lines.push('## 4. 未达标用例明细')
lines.push('')
if (report.failures.length === 0) {
  lines.push('无。')
} else {
  lines.push('| id | 类目 | 查询 | 问题 |')
  lines.push('|---|---|---|---|')
  for (const f of report.failures) {
    const problems = []
    if (f.recallHit === false) problems.push('未召回期望来源')
    if (f.expectExact && f.exactOk === false) problems.push('精确值不符')
    if (f.top1IsStale) problems.push('top1 是过期值')
    if (f.error) problems.push('异常：' + f.error)
    lines.push(`| ${f.id} | ${f.category} | ${String(f.query).replace(/\|/g, '\\|')} | ${problems.join('；') || '—'} |`)
  }
}
lines.push('')
lines.push('## 5. 已知边界（不算缺陷，但要说明）')
lines.push('')
lines.push('- **纯同义词 / 纯口语查询**：当前是 FTS（char-space + trigram + ngram），不做语义扩展。')
lines.push('  「保温棉」查不到「岩棉」、「门口那道槛」查不到「踢脚线」——这类只能靠向量检索或查询改写解决，')
lines.push('  不是调权重能解决的。用例 F26 就是刻意留在这个边界上的。')
lines.push('- **任务快照续接**：`task_snapshots` 表是空的，快照未接进生产。')
lines.push('  本报告第 2 节的 `task_resume` 类只覆盖「检索层能否找回未完成任务」，')
lines.push('  **不覆盖「重启后从快照继续」**——那需要先实现快照写入。')
lines.push('')
lines.push('## 6. 怎么复现')
lines.push('')
lines.push('```powershell')
lines.push('cd E:\\ds-h\\dsh-brain')
lines.push('node --test tests/eval/eval.test.mjs   # 门槛硬断言，不过就红')
lines.push('node tools/run-eval.mjs                # 生成本报告')
lines.push('```')
lines.push('')

const text = lines.join('\n')

if (process.argv.includes('--stdout')) {
  console.log(text)
} else {
  writeFileSync(OUT, text, 'utf8')
  console.log(`报告已写入 ${OUT}`)
  console.log(`Recall@10 ${pct(report.recallAt10)} · 精确值 ${pct(report.exactCorrectRate)} · 旧值误用 ${report.staleMisuse} · 误答 ${report.falseAnswers}/${report.abstainCases}`)
  if (!passedAll) process.exitCode = 1
}
