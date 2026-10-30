// @ts-check
/**
 * §22.3 评测指标计算。
 *
 * ── 为什么单独一个文件 ──
 *
 * 指标口径本身就是结论的一部分。把「怎么算」和「怎么跑」分开写，
 * 以后要改口径能一眼看出改了什么、影响了哪些数字。
 *
 * ── 五条门槛（设计文档 §22.3）──
 *
 * | 指标 | 门槛 |
 * |---|---|
 * | Recall@10 | ≥ 90% |
 * | 精确参数 | 必须与期望值/单位一致 |
 * | 当前查询旧值误用 | = 0 |
 * | 注入来源可回查率 | = 100% |
 * | 无答案用例错误确定回答 | = 0 |
 *
 * 「注入 precision」这一条在这里的口径是**检索层的来源可追溯率**——
 * 因为 automatic 注入没开，没有真实的构包可测。这一点必须在报告里写明，
 * 不能拿检索指标冒充注入指标。
 *
 * ── 两条不算进去的 ──
 *
 * - **任务快照续接**：`task_snapshots` 表是空的，快照没接进生产。
 *   这一类只算「检索层能否找回未完成任务」，快照续接单列**不适用（未实现）**。
 *   不适用不等于通过，也不等于失败。
 * - **模型最终回答质量**：设计文档要求「模型最终回答和纯检索分别评分」。
 *   本脚本只评检索层。模型回答质量需要真实 LLM 回合，属另一套评测。
 */

/** §22.3 的门槛 */
export const THRESHOLDS = Object.freeze({
  recallAt10: 0.9,
  exactCorrectRate: 1.0,
  staleMisuse: 0,
  sourceTraceability: 1.0,
  falseAnswerRate: 0,
})

/**
 * 从命中里抽 memoryId 集合。
 * @param {any[]} hits
 * @returns {string[]}
 */
function hitIds(hits) {
  return (hits || []).map((h) => String(h.memoryId))
}

/**
 * 在一条命中里找某个精确值。
 * 只看 summary + content（用户实际能看到的那部分）。
 * @param {any} hit
 * @param {{ value: string, unit?: string }} expect
 * @returns {boolean}
 */
function hitHasExact(hit, expect) {
  const text = `${hit.summary || ''}\n${hit.content || ''}`
  if (!text.includes(String(expect.value))) return false
  if (expect.unit && !text.includes(String(expect.unit))) return false
  return true
}

/**
 * 跑一遍所有用例。
 *
 * @param {{
 *   search: (args: { query: string, limit: number, asOf?: string }) => { hits: any[], diagnostics: any },
 *   cases: import('./cases.mjs').EvalCase[],
 *   keyToId: Map<string, string>,
 *   limit?: number,
 * }} input
 */
export function evaluate(input) {
  const limit = input.limit ?? 10
  /** @type {any[]} */
  const results = []

  for (const c of input.cases) {
    const expectIds = c.expectKeys.map((k) => input.keyToId.get(k)).filter(Boolean)
    const forbidIds = (c.forbidKeys || []).map((k) => input.keyToId.get(k)).filter(Boolean)
    /** @type {any} */
    let outcome
    try {
      const res = input.search({
        query: c.query,
        limit,
        ...(c.asOf ? { asOf: c.asOf } : {}),
      })
      const hits = res.hits || []
      const ids = hitIds(hits)
      const textById = new Map(hits.map((h) => [String(h.memoryId), h]))

      const recalled = expectIds.filter((id) => ids.includes(id))
      const recallHit = expectIds.length === 0 ? null : recalled.length > 0
      const forbiddenHits = forbidIds.filter((id) => ids.includes(id))
      const top1 = ids[0] || null

      // 精确值：在**期望那几条**的命中里找；若期望条目没被召回，算精确值失败
      let exactOk = null
      if (c.expectExact) {
        const candidates = recalled.map((id) => textById.get(id)).filter(Boolean)
        exactOk = candidates.some((h) => hitHasExact(h, c.expectExact))
      }

      // 来源可追溯：每条命中都带 sourceRefs 且非空
      const traceable = hits.length === 0
        ? true
        : hits.every((h) => Array.isArray(h.sourceRefs) && h.sourceRefs.length > 0)

      outcome = {
        id: c.id,
        category: c.category,
        query: c.query,
        asOf: c.asOf || null,
        expectIds,
        expectAbstain: c.expectAbstain === true,
        hitCount: hits.length,
        recalled,
        recallHit,
        forbiddenHits,
        exactOk,
        expectExact: c.expectExact || null,
        traceable,
        top1,
        top1IsStale: forbidIds.length > 0 && top1 !== null && forbidIds.includes(top1),
        status: res.diagnostics && res.diagnostics.status ? res.diagnostics.status : null,
        degraded: res.diagnostics && res.diagnostics.degraded ? res.diagnostics.degraded : null,
        note: c.note,
        error: null,
      }
    } catch (error) {
      outcome = {
        id: c.id,
        category: c.category,
        query: c.query,
        asOf: c.asOf || null,
        expectIds,
        expectAbstain: c.expectAbstain === true,
        hitCount: 0,
        recalled: [],
        recallHit: false,
        forbiddenHits: [],
        exactOk: false,
        expectExact: c.expectExact || null,
        traceable: false,
        top1: null,
        top1IsStale: false,
        status: 'error',
        degraded: null,
        note: c.note,
        error: error instanceof Error ? error.message : String(error),
      }
    }
    results.push(outcome)
  }

  return summarize(results)
}

/**
 * 汇总。分母口径写死在这里，别在报告层再算一遍。
 * @param {any[]} results
 */
export function summarize(results) {
  const withExpectation = results.filter((r) => r.expectIds.length > 0)
  const answerable = results.filter((r) => r.expectAbstain !== true)
  const abstainCases = results.filter((r) => r.expectAbstain === true)
  const exactCases = results.filter((r) => r.expectExact)
  const tracedCases = results.filter((r) => r.hitCount > 0)

  const recalledCount = withExpectation.filter((r) => r.recallHit === true).length
  const exactOkCount = exactCases.filter((r) => r.exactOk === true).length
  const staleMisuse = results.filter((r) => r.top1IsStale).length
  const forbiddenTotal = results.reduce((n, r) => n + r.forbiddenHits.length, 0)
  // 「无答案用例错误确定回答」：设计文档要求 = 0。
  //
  // 口径（2026-10-29 修正过一次，原口径太粗）：
  //   只有 `status === 'ok'` 才算「系统给出了确定的回答」。
  //   `insufficient_evidence` 的语义就是「可能相关但证据不够，不要据此下结论」——
  //   那是系统自己在弃答，不该算成错误回答。
  //   `no_related` 更是明确说不好。
  //   把这两种算进去，等于惩罚「老实说不知道」——正好和设计意图相反。
  const falseAnswers = abstainCases.filter((r) => r.hitCount > 0 && r.status === 'ok')
  const abstainedProperly = abstainCases.filter((r) => r.status !== 'ok')
  const traceableOk = tracedCases.filter((r) => r.traceable).length

  /** @type {Record<string, any>} */
  const byCategory = {}
  for (const r of results) {
    if (!byCategory[r.category]) {
      byCategory[r.category] = { total: 0, recallHit: 0, withExpectation: 0, exactOk: 0, exactCases: 0, abstain: 0, falseAnswer: 0 }
    }
    const bucket = byCategory[r.category]
    bucket.total += 1
    if (r.expectIds.length > 0) {
      bucket.withExpectation += 1
      if (r.recallHit) bucket.recallHit += 1
    }
    if (r.expectExact) {
      bucket.exactCases += 1
      if (r.exactOk) bucket.exactOk += 1
    }
    if (r.expectAbstain) {
      bucket.abstain += 1
      if (r.hitCount > 0) bucket.falseAnswer += 1
    }
  }

  return {
    total: results.length,
    recallAt10: withExpectation.length > 0 ? round(recalledCount / withExpectation.length) : null,
    recallNumerator: recalledCount,
    recallDenominator: withExpectation.length,
    exactCorrectRate: exactCases.length > 0 ? round(exactOkCount / exactCases.length) : null,
    exactNumerator: exactOkCount,
    exactDenominator: exactCases.length,
    staleMisuse,
    forbiddenTotal,
    sourceTraceability: tracedCases.length > 0 ? round(traceableOk / tracedCases.length) : null,
    sourceNumerator: traceableOk,
    sourceDenominator: tracedCases.length,
    abstainCases: abstainCases.length,
    falseAnswers: falseAnswers.length,
    falseAnswerRate: abstainCases.length > 0 ? round(falseAnswers.length / abstainCases.length) : null,
    /** 系统如实弃答（insufficient_evidence / no_related）的条数——这是**做对了**，不是失败 */
    abstainedProperly: abstainedProperly.length,
    answerableTotal: answerable.length,
    byCategory,
    failures: results.filter((r) => r.recallHit === false || (r.expectExact && r.exactOk === false) || r.top1IsStale || r.error),
    falseAnswerDetails: falseAnswers,
    results,
    /** 不适用项：明确列出，不算通过也不算失败 */
    notApplicable: [
      {
        item: '任务快照续接（§5.2）',
        reason: 'task_snapshots 表为空，快照未接进生产；本评测只覆盖检索层找回未完成任务',
      },
      {
        item: '注入 precision（构包层，§22.3）',
        reason: 'automatic 注入未启用，context_packages=0；这里用「检索结果来源可追溯率」代替，口径不同，报告里必须分开写',
      },
      {
        item: '模型最终回答质量（§22.3「模型最终回答和纯检索分别评分」）',
        reason: '需要真实 LLM 回合，本脚本只评检索层',
      },
    ],
  }
}

/** @param {number} x */
function round(x) {
  return Math.round(x * 1000) / 1000
}
