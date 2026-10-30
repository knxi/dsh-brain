// @ts-check
/**
 * 注入文本渲染 + 来源标记 + 最终请求的两级承载探测。
 *
 * 两条硬纪律：
 * 1. **注入必须能自证来源**（CONTRACTS 10.6）。实机抓到的闭环链是：探针注入的标记被当用户话语
 *    摄入，之后在没开注入的会话里被再次召回。所以每一段注入都带 `origin_system` / `producer` /
 *    段级 memoryId，摄取侧按这些标记剔除自身注入。
 * 2. **sent 判据要查两级承载**（CONTRACTS 10.9）。同一个 provider 实测两种形态：
 *    主请求 `systemLen=0` + `request.messages[role=system]`，标题旁路 `request.system`。
 *    只查 `options.system` 会漏判。
 */

/**
 * @typedef {import('./types.js').ContextSegment} ContextSegment
 */

/** 注入内容的来源系统。摄取侧据此剔除。 */
export const INJECTION_ORIGIN_SYSTEM = 'brain';
/** 注入内容的产生者（本包）。 */
export const INJECTION_PRODUCER = '@dsh-brain/context';
/** 注入块起始标记（connector 的摄取侧用这个认自己的注入）。 */
export const INJECTION_BEGIN = '<!-- brain-context:begin';
/** 注入块结束标记。 */
export const INJECTION_END = '<!-- brain-context:end -->';

/**
 * canonicalHash 的自引用占位符。
 *
 * 为什么需要：注入文本要携带自己的 `canonical_hash`（sent 判据得能在请求对象里找得到它），
 * 但哈希又必须覆盖注入文本本身。直接算会自引用。做法是把哈希位先写占位符再算摘要，
 * 算完后回填。于是：
 *   canonicalHash === sha256(canonicalize({ segments, injectedText: 占位符版, policyVersion }))
 * 校验时把 `text.replace(hash, HASH_PLACEHOLDER)` 还原即可复算（见 `hashableInjectedText`）。
 */
export const HASH_PLACEHOLDER = 'sha256:__CANONICAL_HASH__';

/** 包的说明行：明确告诉模型这不是用户新发言（防闭环 + 防误引）。 */
export const INJECTION_NOTICE =
  '[外置记忆·动态上下文] 以下片段由外置大脑检索注入，不是用户的新发言；' +
  '引用时须保留来源，不得把注入内容当成新的独立事实证据（CONTRACTS 10.6）。';

/** 两级承载位置（CONTRACTS 10.9）。 */
export const SENT_CARRIERS = Object.freeze(['system', 'messages[role=system]']);

/**
 * 把多行文本压成单行（段摘要来自检索，防御性地不许它打断注入块结构）。
 *
 * @param {unknown} value
 * @returns {string}
 */
export function singleLine(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/**
 * 渲染注入块的头部（含哈希占位符）。
 *
 * @param {{ policyVersion: string }} input
 * @returns {string}
 */
export function renderHeader({ policyVersion }) {
  return (
    `${INJECTION_BEGIN} origin_system=${INJECTION_ORIGIN_SYSTEM} producer=${INJECTION_PRODUCER} ` +
    `policy=${policyVersion} canonical_hash=${HASH_PLACEHOLDER} -->\n${INJECTION_NOTICE}`
  );
}

/**
 * 渲染注入块的尾部。
 * @returns {string}
 */
export function renderFooter() {
  return INJECTION_END;
}

/**
 * 渲染一段（带来源与版本，M2 门槛「必有来源、必有版本」）。
 *
 * 格式固定，测试与检查器都依赖它：
 * `1. [long|semantic|owner_words|v2] 摘要 (mem_x; sources=src_1,src_2)`
 *
 * @param {ContextSegment} segment
 * @param {number} index 0 基
 * @returns {string}
 */
export function renderSegmentLine(segment, index) {
  const summary = singleLine(segment.summary);
  const refs = Array.isArray(segment.sourceRefs) ? segment.sourceRefs : [];
  const refIds = refs.map((ref) => ref?.id ?? ref?.sourceEventId ?? '?');
  const sources = refIds.length === 0 ? 'sources=-' : `sources=${refIds.join(',')}`;
  const kind = `${segment.layer}|${segment.type}|${segment.evidenceKind}|v${segment.version}`;
  return `${index + 1}. [${kind}] ${summary} (${segment.memoryId}; ${sources})`;
}

/**
 * 组装注入文本。返回占位符版与逐行 Token，供预算扣减与哈希复算。
 *
 * `segments` 为空时返回 `text: ''`——**不注入**。空包只留 header 是纯浪费 Token 且无信息量。
 *
 * @param {{ policyVersion: string, segments: ContextSegment[] }} input
 * @param {(text: string) => number} estimateTokens
 * @returns {{
 *   textWithPlaceholder: string,
 *   header: string,
 *   footer: string,
 *   lines: string[],
 *   lineTokens: number[],
 *   envelopeTokens: number,
 * }}
 */
export function assembleInjectedText({ policyVersion, segments }, estimateTokens) {
  // 空包不注入：只有来源标记没有内容，纯占预算且没有信息量。
  if (!Array.isArray(segments) || segments.length === 0) {
    return { textWithPlaceholder: '', header: '', footer: '', lines: [], lineTokens: [], envelopeTokens: 0 };
  }
  const header = renderHeader({ policyVersion });
  const footer = renderFooter();
  const lines = segments.map((segment, index) => renderSegmentLine(segment, index));
  const lineTokens = lines.map((line) => estimateTokens(line));
  const textWithPlaceholder = [header, ...lines, footer].join('\n');
  return {
    textWithPlaceholder,
    header,
    footer,
    lines,
    lineTokens,
    envelopeTokens: estimateTokens(header) + estimateTokens(footer),
  };
}

/**
 * 把注入文本还原成「可复算哈希」的形态：把回填进去的哈希换回占位符。
 *
 * @param {string} injectedText
 * @param {string} canonicalHash
 * @returns {string}
 */
export function hashableInjectedText(injectedText, canonicalHash) {
  if (typeof injectedText !== 'string' || injectedText.length === 0) return '';
  if (typeof canonicalHash !== 'string' || canonicalHash.length === 0) return injectedText;
  return injectedText.split(canonicalHash).join(HASH_PLACEHOLDER);
}

/**
 * 把消息 content 归一成文本（宿主可能是 string，也可能是 OpenAI 多段数组）。
 *
 * @param {unknown} content
 * @returns {string}
 */
export function messageContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (/** @type {{text?: unknown}} */ (part).text) === 'string') {
          return /** @type {{text: string}} */ (part).text;
        }
        return '';
      })
      .join('\n');
  }
  if (content && typeof content === 'object' && typeof (/** @type {{text?: unknown}} */ (content).text) === 'string') {
    return /** @type {{text: string}} */ (content).text;
  }
  return '';
}

/**
 * 取最终请求对象里所有 system 承载位置的文本（两级都查，CONTRACTS 10.9）。
 *
 * @param {unknown} request 最终请求对象（`llm/stream` 的 deep-frozen options）
 * @returns {Array<{ carrier: string, text: string, messageIndex: number|null }>}
 */
export function extractSystemCarriers(request) {
  /** @type {Array<{ carrier: string, text: string, messageIndex: number|null }>} */
  const carriers = [];
  if (!request || typeof request !== 'object') return carriers;
  const bag = /** @type {{ system?: unknown, messages?: unknown }} */ (request);
  if (typeof bag.system === 'string' && bag.system.length > 0) {
    carriers.push({ carrier: 'system', text: bag.system, messageIndex: null });
  }
  const messages = Array.isArray(bag.messages) ? bag.messages : [];
  messages.forEach((message, index) => {
    if (!message || typeof message !== 'object') return;
    const entry = /** @type {{ role?: unknown, content?: unknown }} */ (message);
    if (entry.role !== 'system') return;
    const text = messageContentToText(entry.content);
    if (text.length === 0) return;
    carriers.push({ carrier: 'messages[role=system]', text, messageIndex: index });
  });
  return carriers;
}

/**
 * 在最终请求对象里找这个包的哈希，返回命中的承载位置。
 *
 * 命中 → 可以称 `sent`（到「宿主决定发这些内容」这一层，仍不证明字节出网，CONTRACTS 10.4）。
 *
 * @param {unknown} request
 * @param {string} canonicalHash
 * @returns {{ found: boolean, carriers: string[] }}
 */
export function findCanonicalHashInRequest(request, canonicalHash) {
  if (typeof canonicalHash !== 'string' || canonicalHash.length === 0) {
    return { found: false, carriers: [] };
  }
  const carriers = extractSystemCarriers(request)
    .filter((entry) => entry.text.includes(canonicalHash))
    .map((entry) => entry.carrier);
  return { found: carriers.length > 0, carriers: [...new Set(carriers)] };
}
