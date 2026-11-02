// @ts-check
/**
 * probe-sent.js — `llm/stream` 请求边界观测：sent 判据。
 *
 * 契约 10.4 / 10.9 + M0 §4.5.3：
 *   - `llm/stream` 的 `options` 是**完整、deep-frozen 的最终请求对象**，是本地最强
 *     证据边界：能证明「宿主决定发这些内容」，**不证明字节出网**。
 *   - 同一个 provider 的 system prompt 有**两种承载**，实测都出现：
 *       主请求：`systemLen=0` / `systemRoleMessageCount=1` / 承载在 `messages[role=system]`
 *       标题旁路：`systemLen=481` / 承载在 `request.system`
 *     **只看 `options.system` 会漏判 sent。**
 *   - `llm/stream` 调用次数 ≠ step 数：每次还多一发 `purpose="session-title"` 的旁路
 *     请求。统计注入/请求次数必须按 purpose 剔除，否则注入次数会算错。
 *
 * 本模块只做纯函数分析：不写盘、不改请求、不抛。
 */

/** 旁路请求的 purpose（标题生成）。按 purpose 剔除它们，不算进主请求计数。 */
export const BYPASS_PURPOSES = Object.freeze(['session-title'])

/**
 * @typedef {Object} CarrierTexts
 * @property {string} system        `request.system` 字段（标题旁路走这条）
 * @property {string} systemRole    `messages[]` 里 role=system 的文本（主请求走这条）
 * @property {string} otherMessages 非 system 的消息文本（pre-step 通道的注入落在这里）
 * @property {string} all          三者拼接，用于整体命中判定
 */

/**
 * @typedef {Object} RequestDescription
 * @property {string} purpose
 * @property {boolean} isMainRequest
 * @property {string} provider
 * @property {string} model
 * @property {number} systemLen
 * @property {number} systemRoleMessageCount
 * @property {number} systemRoleTextLen
 * @property {'request.system'|'messages[role=system]'|'absent'} systemPromptCarriedIn
 * @property {number} messageCount
 * @property {string[]} messageRoles
 * @property {boolean} frozen
 * @property {boolean} isObject
 */

/**
 * 把请求里的文本按承载位置拆开。所有字段都防御式读取（options 可能被别家包装过）。
 * @param {unknown} options
 * @returns {CarrierTexts}
 */
export function collectCarriers(options) {
  const opts = /** @type {Record<string, any>} */ (options ?? {})
  const system = typeof opts.system === 'string' ? opts.system : ''
  const messages = Array.isArray(opts.messages) ? opts.messages : []
  /** @type {string[]} */
  const systemParts = []
  /** @type {string[]} */
  const otherParts = []
  for (const message of messages) {
    if (message === null || typeof message !== 'object') continue
    const text = messageText(/** @type {Record<string, any>} */ (message))
    if (text.length === 0) continue
    if (message.role === 'system') systemParts.push(text)
    else otherParts.push(text)
  }
  const systemRole = systemParts.join('\n')
  const otherMessages = otherParts.join('\n')
  return {
    system,
    systemRole,
    otherMessages,
    all: [system, systemRole, otherMessages].filter((part) => part.length > 0).join('\n'),
  }
}

/**
 * 判断是否「主请求」（非 session-title 之类的旁路）。
 * @param {unknown} options
 * @returns {boolean}
 */
export function isMainRequest(options) {
  const opts = /** @type {Record<string, any>} */ (options ?? {})
  const purpose = typeof opts.purpose === 'string' ? opts.purpose : ''
  if (purpose.length === 0) return true
  return !BYPASS_PURPOSES.includes(purpose)
}

/**
 * 请求摘要。字段名与 M0 探针保持兼容（`systemPromptCarriedIn` / `systemRoleTextLen` …），
 * 便于把 M0 timeline 与 M2 冒烟产物直接对照。
 * @param {unknown} options
 * @returns {RequestDescription}
 */
export function describeRequest(options) {
  const opts = /** @type {Record<string, any>} */ (options ?? {})
  const carriers = collectCarriers(options)
  const messages = Array.isArray(opts.messages) ? opts.messages : []
  const systemRoleMessages = messages.filter((message) => message?.role === 'system')
  let carriedIn = 'absent'
  if (carriers.system.length > 0) carriedIn = 'request.system'
  else if (carriers.systemRole.length > 0) carriedIn = 'messages[role=system]'
  const purpose = typeof opts.purpose === 'string' && opts.purpose.length > 0 ? opts.purpose : '(none)'
  return {
    purpose,
    isMainRequest: isMainRequest(options),
    provider: typeof opts.provider === 'string' ? opts.provider : '',
    model: typeof opts.model === 'string' ? opts.model : '',
    systemLen: carriers.system.length,
    systemRoleMessageCount: systemRoleMessages.length,
    systemRoleTextLen: carriers.systemRole.length,
    systemPromptCarriedIn: /** @type {'request.system'|'messages[role=system]'|'absent'} */ (carriedIn),
    messageCount: messages.length,
    messageRoles: messages.map((message) => (typeof message?.role === 'string' ? message.role : 'unknown')),
    frozen: options !== null && typeof options === 'object' ? Object.isFrozen(options) : false,
    isObject: options !== null && typeof options === 'object',
  }
}

/**
 * @typedef {Object} SentVerdict
 * @property {boolean} hit
 * @property {boolean} isMainRequest
 * @property {string} purpose
 * @property {string[]} matchedIn  命中位置：'request.system' | 'messages[role=system]' | 'messages[other]'
 * @property {string[]} carriersChecked 这次实际检查了哪些承载（恒为三级，便于检查器展示）
 * @property {string} needle
 * @property {boolean} systemPromptPresent
 */

/**
 * sent 判据：针（通常是 contextId）是否出现在最终请求对象里。
 *
 * 三级承载**全都查**：
 *   1. `request.system`        —— 标题旁路形态
 *   2. `messages[role=system]` —— 主请求形态（只看 options.system 会漏判）
 *   3. `messages[非 system]`   —— pre-step 通道注入的 user-role 快照
 *
 * @param {unknown} options
 * @param {string} needle
 * @returns {SentVerdict}
 */
export function checkSent(options, needle) {
  const target = typeof needle === 'string' ? needle : ''
  const carriers = collectCarriers(options)
  const matchedIn = []
  if (target.length > 0) {
    if (carriers.system.includes(target)) matchedIn.push('request.system')
    if (carriers.systemRole.includes(target)) matchedIn.push('messages[role=system]')
    if (carriers.otherMessages.includes(target)) matchedIn.push('messages[other]')
  }
  const described = describeRequest(options)
  return {
    hit: matchedIn.length > 0,
    isMainRequest: described.isMainRequest,
    purpose: described.purpose,
    matchedIn,
    carriersChecked: ['request.system', 'messages[role=system]', 'messages[other]'],
    needle: target,
    systemPromptPresent: described.systemPromptCarriedIn !== 'absent',
  }
}

/**
 * 多针版本的 sent 判据：任意一根针命中就算命中，返回第一根命中的针。
 *
 * 为什么需要多针：一个包有两种可检索标识 ——
 *   - `canonicalHash`（context2 的注入文本里自带，覆盖内容，最强）；
 *   - `contextId`（本连接器自己拼的注入文本里的标识，供给包的兜底）。
 * 优先用 hash：它证明的是「这段内容」到了请求里，而不只是「这个 id 出现了」。
 *
 * @param {unknown} options
 * @param {string[]} needles 按优先级排列，空值会被跳过
 * @returns {SentVerdict}
 */
export function checkSentAny(options, needles) {
  const candidates = (Array.isArray(needles) ? needles : []).filter(
    (needle) => typeof needle === 'string' && needle.length > 0,
  )
  /** @type {SentVerdict | null} */
  let lastMiss = null
  for (const needle of candidates) {
    const verdict = checkSent(options, needle)
    if (verdict.hit) return verdict
    lastMiss = verdict
  }
  if (lastMiss !== null) return lastMiss
  const described = describeRequest(options)
  return {
    hit: false,
    isMainRequest: described.isMainRequest,
    purpose: described.purpose,
    matchedIn: [],
    carriersChecked: ['request.system', 'messages[role=system]', 'messages[other]'],
    needle: '',
    systemPromptPresent: described.systemPromptCarriedIn !== 'absent',
  }
}

/**
 * 从一条消息里取模型可见文本。
 * @param {Record<string, any>} message
 * @returns {string}
 */
function messageText(message) {
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  /** @type {string[]} */
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (typeof block.content === 'string') parts.push(block.content)
  }
  return parts.join('\n')
}
