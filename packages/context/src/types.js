// @ts-check
/**
 * `@dsh-brain/context` 的公共类型（纯 JSDoc，无运行时导出）。
 *
 * 签名来源：docs/M2-INTERFACES.md 第 2 节；边界纪律来源：docs/CONTRACTS.md 第 6 节与第 10 节。
 * 本文件只有类型，不许出现副作用代码。
 */

/**
 * 检索命中的单条来源引用（M2-INTERFACES §1.3 `SourceRef` 的子集）。
 * 只保留稳定字段：哈希与来源标记都靠它，所以不许多带临时列（如 rowid）。
 *
 * @typedef {Object} ContextSourceRef
 * @property {string|null} [id]
 * @property {string|null} [sourceSystem]
 * @property {string|null} [sourceEventId]
 * @property {string|null} [locator]
 * @property {string|null} [contentHash]
 */

/**
 * 注入段落。字段 = M2-INTERFACES §2 的 `segments[]`，外加上用于裁剪审计的 `score`。
 *
 * @typedef {Object} ContextSegment
 * @property {string} memoryId
 * @property {number} version
 * @property {'fragment'|'long'|'permanent'} layer
 * @property {string} type
 * @property {string} summary
 * @property {string} contentHash
 * @property {ContextSourceRef[]} sourceRefs
 * @property {string} evidenceKind
 * @property {string|null} validFrom
 * @property {string|null} validUntil
 * @property {number} score 检索相关性（只用于排序与裁剪，不参与 canonicalHash）
 */

/**
 * 被丢掉的段落账目：为什么丢必须写清楚（契约 §6 / M2-INTERFACES §2 纪律）。
 *
 * reason 是稳定短码，detail 给人看。
 * - `missing_source`：命中没有来源引用 → 不许注入（M2 门槛「检索结果必有来源」）
 * - `missing_version`：命中没有合法版本号 → 不许注入（M2 门槛「必有版本」）
 * - `search_degraded`：检索诊断不是 ok，全部命中都不采用（契约 §7 不硬凑）
 * - `budget_below_envelope`：连包的来源标记开销都放不下，整包不注入
 * - `over_budget_low_relevance`：预算超限，按相关性从最低端裁掉
 * - `empty_summary`：段摘要是空串，注入没有信息量
 *
 * @typedef {Object} DroppedSegment
 * @property {string} memoryId
 * @property {string} reason
 * @property {string} detail
 * @property {number} [score]
 * @property {number} [segmentTokens]
 */

/**
 * 预算账本。`brainAllowance` / `used` / `dropped` 是接口要求的三个字段，
 * 其余是审计用的附加说明（检查器要能复述「为什么只给这么多」）。
 *
 * @typedef {Object} ContextBudget
 * @property {number} brainAllowance 本次允许外置大脑占用的 Token 上限
 * @property {number} used 实际占用的 Token（保守上界：来源标记开销 + 各段行估算）
 * @property {DroppedSegment[]} dropped 每一段被丢的理由
 * @property {string} formula 公式原文（逐字照抄 CONTRACTS §6，便于检查器显示）
 * @property {number} safetyMargin
 * @property {number} brainCap
 * @property {number|null} modelWindow
 * @property {number|null} hostInputTokens
 * @property {number} outputReserve
 * @property {boolean} estimated 是否走了「拿不到准确输入」的估算路径
 * @property {'provided'|'estimated'} hostInputSource
 * @property {string} tokenizerId
 * @property {string[]} notes 预算侧的说明（估算原因、缺省值等）
 */

/**
 * 构包诊断。
 * status 取值与 memory 检索诊断同一套（M2-INTERFACES §1.2），构包只做如实降级，不改写。
 *
 * `evidenceStrength` / `segmentedFallback` 是**只增不改**的扩展字段（memory2 从 M2 起提供
 * `diagnostics.primaryLaneHit`）：主路命中 = `primary`；命中只来自 n-gram 弱路 =
 * `ngram_fallback`（P@10 约 49.9% vs 主路 83.6%，按线索对待）；拿不到该字段 = `unknown`。
 * 构包**不因弱证据自动降级**（裁判权在检索层），要不要更保守由上层策略决定。
 *
 * @typedef {Object} ContextDiagnostics
 * @property {'ok'|'no_related'|'insufficient_evidence'|'source_missing'|'source_conflict'} status
 * @property {string[]} reasons
 * @property {'primary'|'ngram_fallback'|'unknown'} [evidenceStrength]
 * @property {boolean} [segmentedFallback] 检索层是否走了多段查询补偿（段间 OR）
 * @property {{
 *   status: 'persisted'|'skipped'|'failed',
 *   reason: string|null,
 *   contextId: string,
 * }} [persistence] 旁路落库结果（store 没有 `contextPackages` 门面时是 skipped）
 */

/**
 * `context_packages` 落库门面（memory2 提供，可选）。
 *
 * 构包侧**只依赖 `save` 存在**：没有门面就跳过，绝不硬绑、绝不因为落库失败让构包失败。
 * `get` 用来做幂等判断（同一 contextId 重放不重复插），有就用、没有就交给 save 自己幂等。
 *
 * @typedef {Object} ContextPackagesFacade
 * @property {(pkg: ContextPackage) => unknown} save
 * @property {(contextId: string) => unknown} [get]
 * @property {(contextId: string, patch: { status?: string, carrier?: string|null, evidence?: unknown }) => unknown} [updateStatus]
 * @property {(filter: Record<string, unknown>) => unknown} [list]
 */

/**
 * 注入证据：三级状态各占一格，没有证据就是 null，**不许用布尔假装**。
 *
 * @typedef {Object} ContextEvidence
 * @property {null | { at: string, carrier: string, turn: (string|number|null), step: (string|number|null) }} attached
 * @property {null | { at: string, carrier: string, evidenceKind: 'declared'|'observed', matchedCarriers: string[] }} sent
 */

/**
 * 动态上下文包（CONTRACTS §6 的三级证据粒度）。
 *
 * @typedef {Object} ContextPackage
 * @property {string} contextId
 * @property {string} builtAt
 * @property {string} policyVersion
 * @property {string} scopeId
 * @property {string} personId
 * @property {string} sessionId
 * @property {string|null} turnId
 * @property {string|null} stepId
 * @property {ContextSegment[]} segments
 * @property {string} injectedText 实际挂给宿主的文本（带来源标记；空串表示不注入）
 * @property {number} estimatedTokens
 * @property {string} tokenizerId
 * @property {string} canonicalHash
 * @property {ContextBudget} budget
 * @property {ContextDiagnostics} diagnostics
 * @property {'built'} status 出生只能是 built
 * @property {ContextEvidence} evidence
 * @property {string|null} carrier 当前承载位置（attached 后才有值）
 */

/**
 * `build()` 的入参。
 *
 * `store` 只需要具备 `memories.search()`（M2-INTERFACES §1.2）；测试注入 mock，
 * 真实联调由 Lead 收口。store 缺失或形状不对 → 抛 INVALID_ARGUMENT（编程错误，不降级）。
 *
 * `store.contextPackages` 是**可选**门面：在就顺手把包（含 `budget.dropped[]`）落到主账，
 * 不在就跳过；落库失败只写 `diagnostics.persistence`，绝不影响构包结果。
 *
 * @typedef {Object} BuildInput
 * @property {{ memories: { search: Function }, contextPackages?: ContextPackagesFacade }} store
 * @property {string} query
 * @property {string} scopeId
 * @property {string} personId
 * @property {string} sessionId
 * @property {string|number|null} [turnId]
 * @property {string|number|null} [stepId]
 * @property {{ modelWindow?: number, hostInputTokens?: number, outputReserve?: number, brainCap?: number }} [budget]
 * @property {string} [policyVersion]
 * @property {number} [retrievalLimit] 检索条数上限（默认 10，与 M2-INTERFACES §1.2 一致）
 * @property {string} [asOf] 时点回看（ISO）；透传给 `memories.search`
 * @property {() => Date | number | string} [now] 时钟注入，测试用
 */

export {};
