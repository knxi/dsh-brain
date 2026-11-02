// @ts-check
/**
 * 构包主流程：检索 → 规范化 → 预算裁剪 → 渲染注入文本 → canonicalHash → built 包。
 *
 * 四条不许让步的纪律：
 * 1. **预算公式逐字照抄**（CONTRACTS §6）。拿不到准确输入就标估算，不伪造精确 Token。
 * 2. **检索不足如实降级**（CONTRACTS §7 / M2 门槛「检索不足不胡答」）：`diagnostics.status !== 'ok'`
 *    时返回空段 + 说明原因，绝不拿「相似」当「相关」硬凑。
 * 3. **超限裁剪有账可查**：先从相关性最低的一端裁，每段为什么被丢都进 `budget.dropped`。
 * 4. **构建幂等**（CONTRACTS 10.1）：同一 `(sessionId, turnId, stepId)` + 同一 query
 *    重放得到同一 `contextId`、同一 `canonicalHash`、同样的段；不产生重复片段。
 *
 * store 只依赖 `store.memories.search()`（M2-INTERFACES §1.2）。真实检索由 Lead 收口；
 * 本函数不碰数据库、不写记忆库（CONTRACTS §1：只有 memory 包写记忆）。
 */

import { BrainError, asBrainError, deriveStableId } from '@dsh-brain/core';
import { computeBudget } from './budget.js';
import { computeCanonicalHash } from './canonical.js';
import { ESTIMATE_TOKENIZER_ID, estimateTokens } from './estimate.js';
import { HASH_PLACEHOLDER, assembleInjectedText, singleLine } from './render.js';

/** @typedef {import('./types.js').ContextPackage} ContextPackage */
/** @typedef {import('./types.js').ContextSegment} ContextSegment */
/** @typedef {import('./types.js').DroppedSegment} DroppedSegment */
/** @typedef {import('./types.js').ContextSourceRef} ContextSourceRef */

/** 默认策略版本（M2-INTERFACES §2）。 */
export const DEFAULT_POLICY_VERSION = 'm2.0';

/** 默认检索条数（与 M2-INTERFACES §1.2 的 `limit = 10` 一致）。 */
export const DEFAULT_RETRIEVAL_LIMIT = 10;

/** 检索诊断的合法状态（M2-INTERFACES §1.2）。 */
export const SEARCH_STATUSES = Object.freeze([
  'ok',
  'no_related',
  'insufficient_evidence',
  'source_missing',
  'source_conflict',
]);

/** 每种「检索不足」的人话说明。构包侧照抄，不改写状态。 */
const DEGRADE_REASONS = Object.freeze(
  /** @type {Record<string, string>} */ ({
    no_related: '检索状态 no_related：没有相关记忆，不注入任何片段（不拿相似结果硬凑）',
    insufficient_evidence: '检索状态 insufficient_evidence：命中证据不足，不注入',
    source_missing: '检索状态 source_missing：命中缺少可核对来源，不注入',
    source_conflict: '检索状态 source_conflict：来源互相冲突，不注入',
  }),
);

/** 段层合法的 layer 值。 */
const LAYERS = Object.freeze(['fragment', 'long', 'permanent']);

/**
 * 回填后的真实哈希长度：`sha256:` + 64 hex = 71 字符。
 * 预算估算用等长桩串，保证「预算时算的长度 = 回填后真实长度」，不会因为占位符更短而低估。
 */
const HASH_SIZE_STUB = `sha256:${'0'.repeat(64)}`;

/**
 * @param {string} field
 * @param {unknown} value
 * @returns {string}
 */
function requireNonEmptyString(field, value) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BrainError('INVALID_ARGUMENT', `${field} 必须是非空字符串，收到 ${String(value)}`, {
      details: { field },
    });
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function optionalIdLike(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new BrainError('INVALID_ARGUMENT', `turnId/stepId 必须是字符串、数字或 null，收到 ${typeof value}`, {
    details: { field: 'turnId/stepId' },
  });
}

/**
 * @param {unknown} at
 * @returns {string}
 */
function timestampOf(at) {
  if (at === undefined || at === null) return new Date().toISOString();
  const date = at instanceof Date ? at : new Date(/** @type {string|number} */ (at));
  if (Number.isNaN(date.getTime())) {
    throw new BrainError('INVALID_ARGUMENT', 'now 返回的时间不合法', { details: { field: 'now' } });
  }
  return date.toISOString();
}

/**
 * 取构建时刻：`now` 可以是函数（注入时钟）也可以是时间值。
 * @param {unknown} now
 * @returns {string}
 */
function builtAtOf(now) {
  const raw = typeof now === 'function' ? /** @type {() => unknown} */ (now)() : now;
  return timestampOf(raw);
}

/**
 * @param {unknown} store
 */
function assertStore(store) {
  if (!store || typeof store !== 'object') {
    throw new BrainError('INVALID_ARGUMENT', 'build 需要 store（openBrain() 的返回）', { details: { field: 'store' } });
  }
  const memories = /** @type {{ memories?: unknown }} */ (store).memories;
  if (!memories || typeof memories !== 'object' || typeof (/** @type {{search?: unknown}} */ (memories).search) !== 'function') {
    throw new BrainError('INVALID_ARGUMENT', 'store.memories.search 不是函数：构包必须通过记忆层检索（M2-INTERFACES §1.2）', {
      details: { field: 'store.memories.search' },
    });
  }
}

/**
 * 来源引用白名单化：只留稳定字段。多带临时列（rowid 之类）会让 canonicalHash 漂移。
 *
 * @param {unknown} refs
 * @returns {ContextSourceRef[]}
 */
function normalizeSourceRefs(refs) {
  if (!Array.isArray(refs)) return [];
  /** @type {ContextSourceRef[]} */
  const out = [];
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    const bag = /** @type {Record<string, unknown>} */ (ref);
    const pick = (/** @type {string} */ key) => (typeof bag[key] === 'string' ? /** @type {string} */ (bag[key]) : null);
    out.push({
      id: pick('id'),
      sourceSystem: pick('sourceSystem'),
      sourceEventId: pick('sourceEventId'),
      locator: pick('locator'),
      contentHash: pick('contentHash'),
    });
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string|null}
 */
function normalizeIsoOrNull(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

/**
 * 把一个检索命中规范成一个注入段。**不改输入**。
 *
 * @param {unknown} hit
 * @returns {{ segment: ContextSegment|null, reason: string|null, detail: string }}
 */
function normalizeHit(hit) {
  if (!hit || typeof hit !== 'object') {
    return { segment: null, reason: 'invalid_hit', detail: '检索命中不是对象，无法追踪来源' };
  }
  const bag = /** @type {Record<string, unknown>} */ (hit);
  const memoryId = typeof bag.memoryId === 'string' && bag.memoryId.length > 0 ? bag.memoryId : null;
  if (memoryId === null) {
    return { segment: null, reason: 'missing_memory_id', detail: '命中没有 memoryId，无法建立「来源→记忆→注入」链' };
  }
  const version = typeof bag.version === 'number' && Number.isInteger(bag.version) && bag.version > 0 ? bag.version : null;
  const layer = typeof bag.layer === 'string' && LAYERS.includes(bag.layer) ? bag.layer : 'unknown';
  const type = typeof bag.type === 'string' && bag.type.length > 0 ? bag.type : 'unknown';
  const evidenceKind = typeof bag.evidenceKind === 'string' && bag.evidenceKind.length > 0 ? bag.evidenceKind : 'unknown';
  const summary = singleLine(bag.summary);
  const score = typeof bag.score === 'number' && Number.isFinite(bag.score) ? bag.score : 0;
  return {
    segment: {
      memoryId,
      version: version === null ? 0 : version,
      layer: /** @type {'fragment'|'long'|'permanent'} */ (layer),
      type,
      summary,
      contentHash: typeof bag.contentHash === 'string' ? bag.contentHash : '',
      sourceRefs: normalizeSourceRefs(bag.sourceRefs),
      evidenceKind,
      validFrom: normalizeIsoOrNull(bag.validFrom),
      validUntil: normalizeIsoOrNull(bag.validUntil),
      score,
    },
    reason: null,
    detail: '',
  };
}

/**
 * 相关性排序：分数降序，同分按 memoryId 升序（确定性，保证同输入同哈希）。
 *
 * @param {ContextSegment} a
 * @param {ContextSegment} b
 * @returns {number}
 */
function byRelevance(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (a.memoryId < b.memoryId) return -1;
  if (a.memoryId > b.memoryId) return 1;
  return 0;
}

/**
 * 构建动态上下文包。**出生状态只能是 built**。
 *
 * @param {import('./types.js').BuildInput} input
 * @returns {Promise<ContextPackage>}
 */
export async function build(input) {
  if (!input || typeof input !== 'object') {
    throw new BrainError('INVALID_ARGUMENT', 'build 需要一个入参对象', { details: { field: 'input' } });
  }
  assertStore(input.store);
  const query = typeof input.query === 'string' ? input.query : null;
  if (query === null) {
    throw new BrainError('INVALID_ARGUMENT', 'query 必须是字符串', { details: { field: 'query' } });
  }
  const scopeId = requireNonEmptyString('scopeId', input.scopeId);
  const personId = requireNonEmptyString('personId', input.personId);
  const sessionId = requireNonEmptyString('sessionId', input.sessionId);
  const turnId = optionalIdLike(input.turnId);
  const stepId = optionalIdLike(input.stepId);
  const policyVersion =
    input.policyVersion === undefined || input.policyVersion === null
      ? DEFAULT_POLICY_VERSION
      : requireNonEmptyString('policyVersion', input.policyVersion);
  const retrievalLimit = input.retrievalLimit === undefined ? DEFAULT_RETRIEVAL_LIMIT : input.retrievalLimit;
  if (!Number.isInteger(retrievalLimit) || retrievalLimit < 1) {
    throw new BrainError('INVALID_ARGUMENT', 'retrievalLimit 必须是正整数', {
      details: { field: 'retrievalLimit', received: retrievalLimit },
    });
  }
  const asOf = typeof input.asOf === 'string' && input.asOf.length > 0 ? input.asOf : undefined;

  const builtAt = builtAtOf(input.now);
  // `budget` 是计算器；`used` / `dropped` 由本函数回填。
  const budgetLedger = computeBudget(input.budget ?? {});
  /** @type {DroppedSegment[]} */
  const dropped = [...budgetLedger.dropped];
  /** @type {string[]} */
  const reasons = [];

  // ---- 1. 检索 -------------------------------------------------------------
  const trimmedQuery = query.trim();
  /** @type {{ hits: unknown[], diagnostics: { status: string, notes: string[], degraded: string|null } }} */
  let searchResult;
  if (trimmedQuery.length === 0) {
    // 空查询不调检索：这是「没有相关记忆」，不是「检索失败」。
    searchResult = {
      hits: [],
      diagnostics: { status: 'no_related', notes: ['query_empty：查询为空，未调用检索'], degraded: null },
    };
  } else {
    try {
      const raw = await input.store.memories.search({
        query,
        scopeId,
        personId,
        limit: retrievalLimit,
        ...(asOf === undefined ? {} : { asOf }),
      });
      searchResult = normalizeSearchResult(raw);
    } catch (err) {
      // 检索炸了不许包装成「没找到」——上层要么重试要么如实弃答（CONTRACTS 10.8 同理）。
      throw asBrainError(err, 'STORAGE_ERROR', 'memories.search');
    }
  }

  const rawStatus = searchResult.diagnostics.status;
  let searchStatus = SEARCH_STATUSES.includes(rawStatus) ? rawStatus : 'insufficient_evidence';
  if (searchStatus !== rawStatus) {
    reasons.push(`检索诊断状态不可识别（${String(rawStatus)}），按 insufficient_evidence 处理（保守降级）`);
  }
  reasons.push(...searchResult.diagnostics.notes.map((note) => `检索：${note}`));
  if (searchResult.diagnostics.degraded) {
    reasons.push(`检索降级：${searchResult.diagnostics.degraded}`);
  }

  const hits = Array.isArray(searchResult.hits) ? searchResult.hits : [];

  // 证据强度（memory2 的 `diagnostics.primaryLaneHit`，只增不改的扩展字段）。
  // 为什么不据此自动降级：判定「检索够不够」的裁判权在检索层（status + notes），
  // 构包侧再判一次就是双重裁判，还会掩盖真实命中。这里只把强度如实体现在包里；
  // 要不要更保守（例如弱证据整包不注入）由上层策略决定，改策略不用改构包。
  const evidenceStrength =
    searchResult.diagnostics.primaryLaneHit === true
      ? 'primary'
      : searchResult.diagnostics.primaryLaneHit === false
        ? 'ngram_fallback'
        : 'unknown';
  const segmentedFallback = searchResult.diagnostics.segmented === true;
  if (evidenceStrength === 'ngram_fallback' && hits.length > 0) {
    reasons.push('证据强度：ngram_fallback（主路 char/trigram 本轮 0 命中，按弱证据对待；构包不自动降级）');
  }
  if (segmentedFallback) {
    reasons.push('检索补偿：多段查询段间 AND 卡死，已按段分头检索 + RRF 合并（段内 phrase、段间 OR）');
  }

  /** @type {ContextSegment[]} */
  let usable = [];

  if (searchStatus !== 'ok') {
    // 如实降级：命中一律不采用，但仍逐条记账，让检查器看见「有命中但我没用」。
    reasons.push(DEGRADE_REASONS[searchStatus]);
    for (const hit of hits) {
      const normalized = normalizeHit(hit);
      const memoryId = normalized.segment?.memoryId ?? '(unknown)';
      dropped.push({
        memoryId,
        reason: 'search_degraded',
        detail: `检索诊断 status=${searchStatus}，构包不采用任何命中（不拿相似结果硬凑）`,
        score: normalized.segment?.score,
      });
    }
  } else {
    // ---- 2. 规范化 + 排序（确定性，保证同输入同哈希） ----------------------
    /** @type {ContextSegment[]} */
    const normalizedSegments = [];
    for (const hit of hits) {
      const normalized = normalizeHit(hit);
      if (normalized.segment === null) {
        dropped.push({
          memoryId: '(unknown)',
          reason: /** @type {string} */ (normalized.reason),
          detail: normalized.detail,
        });
        continue;
      }
      normalizedSegments.push(normalized.segment);
    }
    normalizedSegments.sort(byRelevance);

    // ---- 3. 完整性过滤：「必有来源、必有版本」是注入前提 -------------------
    for (const segment of normalizedSegments) {
      if (segment.version <= 0) {
        dropped.push({
          memoryId: segment.memoryId,
          reason: 'missing_version',
          detail: '命中没有合法版本号，来源不可回查（M2 门槛「必有版本」），不注入',
          score: segment.score,
        });
        continue;
      }
      if (segment.sourceRefs.length === 0) {
        dropped.push({
          memoryId: segment.memoryId,
          reason: 'missing_source',
          detail: '命中没有来源引用，无法自证来源（M2 门槛「必有来源」），不注入',
          score: segment.score,
        });
        continue;
      }
      if (segment.summary.length === 0) {
        dropped.push({
          memoryId: segment.memoryId,
          reason: 'empty_summary',
          detail: '段摘要是空串，注入没有信息量',
          score: segment.score,
        });
        continue;
      }
      usable.push(segment);
    }

    // 全部命中都因「来源/版本」被丢时，如实把状态升到对应档位，不假装 ok。
    if (usable.length === 0 && normalizedSegments.length > 0) {
      const onlySourceMissing = dropped.every(
        (item) => item.reason === 'missing_source' || item.reason === 'invalid_hit',
      ) && dropped.some((item) => item.reason === 'missing_source');
      searchStatus = onlySourceMissing ? 'source_missing' : 'insufficient_evidence';
      reasons.push(
        onlySourceMissing
          ? '命中全部缺少可核对来源，状态升为 source_missing（不注入）'
          : '命中均不满足「必有来源 + 必有版本」，状态升为 insufficient_evidence（不注入）',
      );
    }
  }

  // ---- 4. 预算裁剪：从相关性最低端裁，逐段记账 -----------------------------
  // 判定口径 = **最终注入文本的估算**（含来源标记与接缝换行），与 `estimatedTokens` 同一个函数；
  // 摘要占位符按真实哈希长度（71 字符）折算，保证「预算时算的长度 = 回填后真实长度」。
  /** @type {ContextSegment[]} */
  let finalSegments = [];
  /** @type {string} 占位符版注入文本（canonicalHash 的哈希基底） */
  let canonicalInput = '';
  /** @type {number} */
  let estimatedTokens = 0;

  if (usable.length > 0) {
    const allowance = budgetLedger.brainAllowance;
    const full = assembleInjectedText({ policyVersion, segments: usable }, estimateTokens);
    /**
     * 回填哈希后的同长文本估算。
     * @param {string} textWithPlaceholder
     * @returns {number}
     */
    const budgetTokensOf = (textWithPlaceholder) =>
      estimateTokens(textWithPlaceholder.split(HASH_PLACEHOLDER).join(HASH_SIZE_STUB));
    const fullTokens = budgetTokensOf(full.textWithPlaceholder);

    if (allowance <= 0) {
      for (const segment of usable) {
        dropped.push({
          memoryId: segment.memoryId,
          reason: 'budget_zero',
          detail: `brainAllowance=${allowance}（预算为 0 或窗口不足），不注入任何段`,
          score: segment.score,
        });
      }
      reasons.push(`预算为 0（brainAllowance=${allowance}）：不注入任何片段，段全部记入 dropped`);
    } else if (allowance < full.envelopeTokens) {
      for (const segment of usable) {
        dropped.push({
          memoryId: segment.memoryId,
          reason: 'budget_below_envelope',
          detail: `brainAllowance=${allowance} 连来源标记开销（${full.envelopeTokens} token）都放不下，整包不注入`,
          score: segment.score,
        });
      }
      reasons.push(
        `预算不足：brainAllowance=${allowance} < 来源标记开销 ${full.envelopeTokens}，整包不注入（宁可不注，不留裸片段）`,
      );
    } else {
      // 严格「先丢低相关段」：从分数最低的一端开始裁，裁到放得下为止。
      let keepCount = usable.length;
      let kept = full;
      let keptTokens = fullTokens;
      while (keepCount > 0 && keptTokens > allowance) {
        keepCount -= 1;
        kept =
          keepCount === 0
            ? { textWithPlaceholder: '', envelopeTokens: 0, lineTokens: [] }
            : assembleInjectedText({ policyVersion, segments: usable.slice(0, keepCount) }, estimateTokens);
        keptTokens = keepCount === 0 ? 0 : budgetTokensOf(kept.textWithPlaceholder);
      }
      finalSegments = usable.slice(0, keepCount);
      if (keepCount < usable.length) {
        const lowestKeptScore = finalSegments.length > 0 ? finalSegments[finalSegments.length - 1].score : null;
        for (let index = keepCount; index < usable.length; index += 1) {
          const segment = usable[index];
          dropped.push({
            memoryId: segment.memoryId,
            reason: 'over_budget_low_relevance',
            detail:
              `预算超限（注入需 ${fullTokens} token，只允许 ${allowance}），` +
              `按相关性从最低端裁剪：检索融合分 score=${segment.score}` +
              (lowestKeptScore === null ? '' : `，低于保留段最低分 ${lowestKeptScore}`),
            score: segment.score,
            segmentTokens: full.lineTokens[index],
          });
        }
        reasons.push(
          `预算超限：注入需 ${fullTokens} token、允许 ${allowance}，按相关性从最低端裁掉 ${usable.length - finalSegments.length} 段`,
        );
      }
      if (finalSegments.length > 0) {
        canonicalInput = kept.textWithPlaceholder;
        estimatedTokens = keptTokens;
      }
    }
  }

  if (dropped.length > 0 && searchStatus === 'ok' && finalSegments.length > 0) {
    // 预算裁剪不影响诊断状态，只在 reasons 里留一句。
    reasons.push(`有 ${dropped.length} 段未注入，逐段理由见 budget.dropped`);
  }

  // ---- 5. 渲染 + 摘要（占位符 → 回填，避免自引用） -----------------------
  const canonicalHash = computeCanonicalHash({
    segments: finalSegments,
    injectedText: canonicalInput,
    policyVersion,
  });
  const injectedText = finalSegments.length === 0 ? '' : canonicalInput.split(HASH_PLACEHOLDER).join(canonicalHash);

  // 回填后的真实文本与预算口径同长，重算一次最诚实。
  const used = finalSegments.length === 0 ? 0 : estimateTokens(injectedText);
  estimatedTokens = used;
  if (budgetLedger.estimated) {
    reasons.push(
      `Token 预算为估算（${budgetLedger.hostInputSource === 'estimated' ? '拿不到 hostInputTokens' : '模型窗口未知'}），` +
        `tokenizerId=${ESTIMATE_TOKENIZER_ID}，不当作精确值`,
    );
  }
  if (used > budgetLedger.brainAllowance) {
    // 不该发生（裁剪已保证），但账本必须自洽：出现了就如实报。
    reasons.push(`预算账不自洽：used=${used} > brainAllowance=${budgetLedger.brainAllowance}`);
  }

  // ---- 6. 组装包（出生只能 built） ---------------------------------------
  const contextId = deriveStableId(
    'dsh-brain/context',
    { scopeId, personId, sessionId, turnId, stepId, policyVersion, query },
    { prefix: 'ctx_', hexLength: 24 },
  );

  /** @type {ContextPackage} */
  const pkg = {
    contextId,
    builtAt,
    policyVersion,
    scopeId,
    personId,
    sessionId,
    turnId,
    stepId,
    segments: finalSegments,
    injectedText,
    estimatedTokens,
    tokenizerId: ESTIMATE_TOKENIZER_ID,
    canonicalHash,
    budget: {
      ...budgetLedger,
      used,
      dropped,
    },
    diagnostics: {
      status: /** @type {'ok'|'no_related'|'insufficient_evidence'|'source_missing'|'source_conflict'} */ (searchStatus),
      reasons,
      evidenceStrength: /** @type {'primary'|'ngram_fallback'|'unknown'} */ (evidenceStrength),
      segmentedFallback,
    },
    status: 'built',
    evidence: { attached: null, sent: null },
    carrier: null,
  };

  // ---- 7. 旁路落库（可选依赖，失败不许影响构包） ---------------------------
  // `context_packages` 是检查器唯一能查到「这次为什么只注入这些」的地方，
  // 尤其是 `budget.dropped[]`。但记录成功与否不能决定包的价值：
  // store 没门面 → 跳过；save 抛错 → 只记 diagnostics，包照常返回。
  const persistence = await persistPackage(input.store, pkg);
  if (persistence.status === 'failed') {
    reasons.push(`旁路落库失败（不影响本次构包）：${persistence.reason}`);
  }
  return {
    ...pkg,
    diagnostics: { ...pkg.diagnostics, persistence },
  };
}

/**
 * 把包落到主账的 `context_packages`（旁路，永不抛）。
 *
 * 幂等：同一 `contextId` 重放时先 `get` 一下，已存在就不再 `save`——不依赖门面的 upsert 实现
 * （CONTRACTS 10.1：同一 step 的 assemble / pre-step 会被重复调用）。
 *
 * 门面形状（memory2 的 `store.contextPackages`）：
 * - `save(pkg)` 必填；`get(contextId)` / `updateStatus(...)` / `list(...)` 可选。
 * - 只要 `save` 不是函数就当作「没有这个能力」，不报错、不猜。
 *
 * @param {{ contextPackages?: unknown }} store
 * @param {ContextPackage} pkg
 * @returns {Promise<{
 *   status: 'persisted'|'skipped'|'failed',
 *   reason: string|null,
 *   contextId: string,
 * }>}
 */
async function persistPackage(store, pkg) {
  const contextId = pkg.contextId;
  const facade = /** @type {{ contextPackages?: unknown }} */ (store ?? {}).contextPackages;
  if (!facade || typeof facade !== 'object') {
    return { status: 'skipped', reason: 'no_context_packages_facade', contextId };
  }
  const api = /** @type {{ save?: unknown, get?: unknown }} */ (facade);
  if (typeof api.save !== 'function') {
    return { status: 'skipped', reason: 'context_packages_save_not_callable', contextId };
  }
  try {
    if (typeof api.get === 'function') {
      const existing = await /** @type {(contextId: string) => Promise<unknown>} */ (api.get)(contextId);
      if (existing !== null && existing !== undefined) {
        // 同一 contextId 已落过：这是幂等通过，不是失败，也不再写一次。
        return { status: 'skipped', reason: 'already_persisted', contextId };
      }
    }
    await /** @type {(pkg: ContextPackage) => Promise<unknown>} */ (api.save)(pkg);
    return { status: 'persisted', reason: null, contextId };
  } catch (err) {
    // 落库失败绝不外抛（契约 10.2 的精神：别让旁路污染用户回合）。
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason: message, contextId };
  }
}

/**
 * 把检索返回值收敛成构包能消费的形状。
 * 缺失/畸形字段按「检索不足」处理，不静默当成有证据。
 *
 * @param {unknown} raw
 * @returns {{
 *   hits: unknown[],
 *   diagnostics: {
 *     status: string,
 *     notes: string[],
 *     degraded: string|null,
 *     primaryLaneHit: boolean|null,
 *     segmented: boolean,
 *   },
 * }}
 */
function normalizeSearchResult(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      hits: [],
      diagnostics: {
        status: 'insufficient_evidence',
        notes: ['search 返回值不是对象'],
        degraded: null,
        primaryLaneHit: null,
        segmented: false,
      },
    };
  }
  const bag = /** @type {Record<string, unknown>} */ (raw);
  const diagnostics = bag.diagnostics && typeof bag.diagnostics === 'object'
    ? /** @type {Record<string, unknown>} */ (bag.diagnostics)
    : {};
  const notes = Array.isArray(diagnostics.notes)
    ? diagnostics.notes.filter((note) => typeof note === 'string')
    : [];
  if (diagnostics.status === undefined) notes.push('search.diagnostics.status 缺失');
  // 扩展字段：老实现 / mock 不给就当未知，不假装有主路命中。
  const primaryLaneHit = typeof diagnostics.primaryLaneHit === 'boolean' ? diagnostics.primaryLaneHit : null;
  const routes =
    diagnostics.routes && typeof diagnostics.routes === 'object'
      ? /** @type {Record<string, unknown>} */ (diagnostics.routes)
      : null;
  const segmented = routes !== null && Boolean(routes.segmented);
  return {
    hits: Array.isArray(bag.hits) ? bag.hits : [],
    diagnostics: {
      status: typeof diagnostics.status === 'string' ? diagnostics.status : 'insufficient_evidence',
      notes,
      degraded: typeof diagnostics.degraded === 'string' ? diagnostics.degraded : null,
      primaryLaneHit,
      segmented,
    },
  };
}
