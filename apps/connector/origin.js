// @ts-check
/**
 * origin.js — 注入来源标记与「谁发的东西」判定。
 *
 * 这一层是契约 10.6 的落点。M0 实机抓到了完整闭环：
 *   探针注入的合成标记 → 灵枢当**用户话语**摄入成记忆节点 → 之后在没开注入的
 *   新会话里被自动召回、再次注入 → 这次进最终请求的片段不是探针发的。
 * 不做来源标记 + 摄取侧剔除，记忆库会被自己的注入喂胖，而且越喂越多。
 *
 * 标记形态（单行，便于正则与人工阅读，放在注入文本第一行）：
 *   <!-- dsh-brain-origin:{"v":1,"originSystem":"brain",...} -->
 *
 * 为什么用 HTML 注释：模型看不见它（不占注意力），正则能精确抓，且在
 * system prompt / user message 两种承载里都不会被宿主任何渲染层改写。
 */

/** 本连接器自己的来源系统标识。兄弟引擎各用各的：engram / lingshu / probe … */
export const ORIGIN_SYSTEM = 'brain'

/** 生产者标识，回答「这条是哪个进程/插件发的」。 */
export const PRODUCER = '@dsh-brain/connector'

/** 标记版本，便于以后改格式而不误读旧数据。 */
export const ORIGIN_MARKER_VERSION = 1

/** 标记前缀，摄取侧靠它一眼认出自己的注入。 */
export const ORIGIN_MARKER_PREFIX = '<!-- dsh-brain-origin:'

/**
 * context2（`@dsh-brain/context`）的注入块抬头。
 *
 * 为什么连接器要认它：`automatic` 模式的包是 `build()` 产出的，注入文本由 context2 渲染，
 * 格式是 `<!-- brain-context:begin origin_system=... producer=... canonical_hash=... -->`
 * （`packages/context/src/render.js`）。两种格式都得被识别，否则：
 *   - 我们会在 context2 的文本外面再套一层自己的标记（双层标记，检查器看成两条注入）；
 *   - 更糟：它被回灌进 `session/event` 时认不出是注入 → 被当人类证据二次沉淀（契约 10.6 闭环）。
 */
export const CONTEXT_INJECTION_BEGIN = '<!-- brain-context:begin'

/** 从 context2 抬头里读 `origin_system=xxx`。 */
const CONTEXT_ORIGIN_PATTERN = /origin_system=([A-Za-z0-9._:-]+)/

/**
 * 从 context2 抬头里读 `canonical_hash=sha256:...`（sent 判据最硬的针）。
 */
const CONTEXT_HASH_PATTERN = /canonical_hash=(sha256:[A-Za-z0-9]+)/

/**
 * 解析 context2 的注入块抬头。
 * @param {string} text
 * @returns {{ originSystem: string, canonicalHash: string | null } | null}
 */
export function parseContextInjectionHeader(text) {
  if (typeof text !== 'string' || !text.includes(CONTEXT_INJECTION_BEGIN)) return null
  const originMatch = CONTEXT_ORIGIN_PATTERN.exec(text)
  const hashMatch = CONTEXT_HASH_PATTERN.exec(text)
  return {
    originSystem: originMatch !== null ? originMatch[1] : ORIGIN_SYSTEM,
    canonicalHash: hashMatch !== null ? hashMatch[1] : null,
  }
}

/**
 * @typedef {Object} OriginTag
 * @property {number} v
 * @property {string} originSystem
 * @property {string} producer
 * @property {string} contextId
 * @property {string} policyVersion
 */

/**
 * @typedef {Object} OriginTagInput
 * @property {string} [originSystem]
 * @property {string} [producer]
 * @property {string} contextId
 * @property {string} [policyVersion]
 */

/**
 * 生成来源标记文本（单行）。
 * @param {OriginTagInput} input
 * @returns {string}
 */
export function formatOriginTag(input) {
  const payload = {
    v: ORIGIN_MARKER_VERSION,
    originSystem: input.originSystem ?? ORIGIN_SYSTEM,
    producer: input.producer ?? PRODUCER,
    // contextId 只允许安全字符：它会被写进正则与日志，不接受任意文本
    contextId: safeToken(input.contextId),
    policyVersion: input.policyVersion ?? 'm2.0',
  }
  return `${ORIGIN_MARKER_PREFIX}${JSON.stringify(payload)} -->`
}

/**
 * 从任意文本里解析出第一个来源标记。
 * 坏 JSON / 缺字段一律返回 null —— 解析失败不能抛，摄取侧在热路径上。
 * @param {string} text
 * @returns {OriginTag | null}
 */
export function parseOriginTag(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const start = text.indexOf(ORIGIN_MARKER_PREFIX)
  if (start < 0) return null
  const end = text.indexOf('-->', start + ORIGIN_MARKER_PREFIX.length)
  if (end < 0) return null
  const json = text.slice(start + ORIGIN_MARKER_PREFIX.length, end).trim()
  try {
    const parsed = JSON.parse(json)
    if (parsed === null || typeof parsed !== 'object') return null
    if (typeof parsed.originSystem !== 'string') return null
    return {
      v: Number(parsed.v ?? 0),
      originSystem: parsed.originSystem,
      producer: typeof parsed.producer === 'string' ? parsed.producer : '',
      contextId: typeof parsed.contextId === 'string' ? parsed.contextId : '',
      policyVersion: typeof parsed.policyVersion === 'string' ? parsed.policyVersion : '',
    }
  } catch {
    return null
  }
}

/**
 * 兄弟引擎的注入指纹。HARD 的一课是「注入会被别人当用户话语吃进去」，
 * 所以我们在**摄取侧**也要认得出别人的注入，而不是只认自己的。
 *
 * 这些模式只用于分类，不用于删除内容：认出来了就标成 sibling_injected，
 * 让记忆层不要把它当人类证据二次沉淀。
 * @type {ReadonlyArray<{ originSystem: string, pattern: RegExp, note: string }>}
 */
export const SIBLING_MARKERS = Object.freeze([
  {
    originSystem: 'probe',
    pattern: /\[BRAIN-PROBE-MARKER\b/,
    note: 'M0 探针的受控注入标记（data/probe timeline 里的 probeMarkerId）',
  },
  {
    originSystem: 'lingshu',
    pattern: /\[lingshu[::]/i,
    note: '灵枢 auto-recall / session-window 块的抬头',
  },
  {
    originSystem: 'engram',
    pattern: /\[engram[::]/i,
    note: 'Engram 记忆注入块的抬头',
  },
])

/**
 * 一帧用户角色消息的分类结果。
 * @typedef {'human'|'self_injected'|'sibling_injected'|'context_snapshot'|'unknown'} IngestClass
 */

/**
 * @typedef {Object} UserTextClassification
 * @property {IngestClass} ingestClass
 * @property {string} originSystem  human / brain / lingshu / engram / probe / context
 * @property {string} reason        给人看的一句话判定理由（诊断用）
 * @property {string} [contextId]   自己的注入才有
 */

/**
 * 判定一条 user 角色消息是不是「人类打的字」。
 *
 * 判据顺序（先结构性证据、后文本证据）：
 *   1. `source.kind !== 'user'` → 不是人打的（宿主自己的 runtime-context 快照、
 *      兄弟引擎的注入、模型转述…… 探针实测 `user/message src=runtime-context`）。
 *      注意：**光靠这条不够** —— M0 探针的注入就写成 `{kind:'user'}`，很脏，
 *      所以还要看文本标记。
 *   2. 文本含自己的来源标记 → self_injected。
 *   3. 文本含兄弟引擎指纹 → sibling_injected。
 *   4. 其余 → human。
 *
 * @param {{ text?: string, sourceKind?: string|null, sourceForm?: string|null }} frame
 * @returns {UserTextClassification}
 */
export function classifyUserFrame(frame) {
  const text = typeof frame?.text === 'string' ? frame.text : ''
  const own = parseOriginTag(text)
  if (own !== null) {
    return {
      ingestClass: 'self_injected',
      originSystem: own.originSystem,
      contextId: own.contextId,
      reason: `carries own origin marker (originSystem=${own.originSystem})`,
    }
  }
  // context2 渲染的注入块（automatic 模式的正常路径）。必须认，否则闭环会被自己重新喂进来。
  const fromContext = parseContextInjectionHeader(text)
  if (fromContext !== null) {
    return {
      ingestClass: 'self_injected',
      originSystem: fromContext.originSystem,
      reason: 'carries @dsh-brain/context injection header (<!-- brain-context:begin ... -->)',
    }
  }
  for (const sibling of SIBLING_MARKERS) {
    if (sibling.pattern.test(text)) {
      return {
        ingestClass: 'sibling_injected',
        originSystem: sibling.originSystem,
        reason: `matches sibling marker: ${sibling.note}`,
      }
    }
  }
  const sourceKind = typeof frame?.sourceKind === 'string' ? frame.sourceKind : null
  if (sourceKind !== null && sourceKind !== 'user') {
    // 结构性证据：这条 user 角色消息的**生产者不是人类**。
    // 兄弟引擎（灵枢/Engram）通常用 createUserMessage（kind='user'），所以它们靠上面的
    // 文本指纹识别；走到这里的基本是宿主自己的运行期上下文（runtime-context /
    // agent-instructions / skill-catalog …），同样不是人类证据。
    const form = typeof frame?.sourceForm === 'string' ? frame.sourceForm : ''
    return {
      ingestClass: 'context_snapshot',
      originSystem: `source:${sourceKind}${form ? `/${form}` : ''}`,
      reason: `non-user message source (kind=${sourceKind}${form ? `, form=${form}` : ''}) → 生产者不是人类`,
    }
  }
  return { ingestClass: 'human', originSystem: 'human', reason: 'plain user message' }
}

/**
 * 只允许安全字符进入标记与日志。
 * @param {string} value
 * @returns {string}
 */
export function safeToken(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  const cleaned = text.replace(/[^A-Za-z0-9._:-]/g, '')
  return cleaned.length > 0 ? cleaned.slice(0, 96) : 'unknown'
}
