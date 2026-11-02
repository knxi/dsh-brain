// @ts-check
/**
 * `@dsh-brain/context` —— 动态上下文装配（CONTRACTS §1：「只有 `@dsh-brain/context` 组装上下文」）。
 *
 * 对外只暴露构包与三级证据状态；预算、估算、渲染、摘要各自独立可测。
 *
 * 典型用法（connector 侧）：
 * ```js
 * const pkg = await build({ store, query, scopeId, personId, sessionId, turnId, stepId, budget });
 * if (pkg.injectedText) {
 *   const attached = markAttached(pkg, { carrier: 'messages[role=system]', turn: turnId, step: stepId });
 *   // ……宿主真的把文本发出去了，才在 llm/stream 里用最终请求对象标 sent：
 *   // markSent(attached, { carrier: 'messages[role=system]', observedIn: request });
 * }
 * ```
 */

export { build, DEFAULT_POLICY_VERSION, DEFAULT_RETRIEVAL_LIMIT, SEARCH_STATUSES } from './build.js';

export {
  BRAIN_BUDGET_FORMULA,
  DEFAULT_BRAIN_CAP,
  ESTIMATED_HOST_INPUT_ALLOWANCE,
  SAFETY_MARGIN_FLOOR,
  SAFETY_MARGIN_RATIO,
  computeBudget,
  computeSafetyMargin,
} from './budget.js';

export {
  ASCII_CHARS_PER_TOKEN,
  CJK_TOKENS_PER_CHAR,
  ESTIMATE_TOKENIZER_ID,
  describeTokenizer,
  estimateTokens,
  isCjkCodePoint,
} from './estimate.js';

export {
  HASH_PLACEHOLDER,
  INJECTION_BEGIN,
  INJECTION_END,
  INJECTION_NOTICE,
  INJECTION_ORIGIN_SYSTEM,
  INJECTION_PRODUCER,
  SENT_CARRIERS,
  assembleInjectedText,
  extractSystemCarriers,
  findCanonicalHashInRequest,
  hashableInjectedText,
  messageContentToText,
  renderFooter,
  renderHeader,
  renderSegmentLine,
  singleLine,
} from './render.js';

export { CANONICAL_HASH_PREFIX, computeCanonicalHash, verifyCanonicalHash } from './canonical.js';

export {
  PACKAGE_STATUS,
  SENT_EVIDENCE_KIND,
  markAttached,
  markSent,
  nextTransition,
} from './state.js';
