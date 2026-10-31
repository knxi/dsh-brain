// @ts-check
/**
 * auto-extract.js — 从对话里自动抽取长期记忆（M5 第一阶段：纯规则，零模型）
 *
 * ── 立场：宁可漏，不能错 ──
 *
 * ROADMAP 第二节把这块定为「风险最高」：自动提取质量差会污染记忆库，而**污染比没有更糟**
 * ——检索会变差，主人会开始不信它。而「不信」一旦发生，不是删几条记忆能修回来的。
 *
 * 所以本模块的判据是：**只认明确到不需要解释的句式**。
 * 判不准就漏掉，漏掉只是这条没自动记住（主人还能显式说「记住」），
 * 错记则是一条假事实长期参与召回、还会被后续矛盾检测当成「主人说过」。
 * 两边的代价不对称，所以阈值往「漏」那一侧压。
 *
 * 具体体现为四道闸，任何一道不过就整条丢弃（不是降级、不是打分）：
 *   1. 整句是疑问 → 丢（「你记住了吗」）
 *   2. 整句是假设 → 丢（「如果能记住就好」）
 *   3. 触发词前是否定 → 丢（「不用记住这个」）
 *   4. 触发词后面没有具体内容 → 丢（「记住」「记一下啊」）
 *
 * ── 为什么不调模型 ──
 *
 * 这一阶段 Brain 不发任何 LLM 请求。规模型抽取的错误率在「长尾自然语言」上不可测，
 * 而且错误形态是「看起来很像真的」——这恰好是最难抽检发现的。先纯规则跑一段，
 * 拿 M4.5 的使用统计去量它有没有把检索质量拉低，再谈上模型。
 *
 * ── 不做什么（诚实清单）──
 *
 * - **不做语义推断**：不从「今天又加班到十点」推出「主人常加班」。
 * - **不覆盖全部句式**：四条规则只认祈使/规则/决定/自述四类。比喻、反讽、
 *   第三人称转述（「我同事说他记得…」）一律不碰。
 * - **不保证不误提取**：见文件末尾「已知最可能误提的两种句式」。
 * - **不进永久记忆**：本模块只产出 candidates，写库/升层由调用方决定（ROADMAP：
 *   自动可进长期，永久必须主人说了算）。建议调用方用 `sourceType: 'observation'`。
 *
 * ── 副作用纪律 ──
 *
 * 全部对外方法零抛出（顶层 try/catch）。本模块挂在宿主的 `turn/end` 钩子上，
 * 抛错会把主人回合变成 reason=error（CONTRACTS 10.2），那是比漏提取严重得多的事故。
 * sidecar 写失败只返回 `{ ok: false }`，不抛、不重试。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 消息缓存最多保留多少个会话（超出驱逐最早插入的会话）。 */
export const MAX_SESSIONS = 64
/**
 * 单个会话最多缓存多少条用户消息（超出丢最旧）。
 *
 * 2026-10-30 从 4 提到 12：实测一个 turn 里宿主会推 6+ 条 `user/message`，其中绝大多数是
 * 注入块（runtime-context / skill-catalog / agent-instructions …）。缓存只有 4 格时，
 * 主人真说的那句话会被后续注入块挤出窗口。现在调用侧已按 `source.kind === 'user'` 白名单
 * 收口（只缓存主人手打的字），12 是给多步回合与消息重发的余量。
 */
export const MAX_MESSAGES_PER_SESSION = 12
/**
 * 单条消息进缓存前最多保留多少字符。
 *
 * 只防「有人贴了一整篇文档进来」把内存撑爆，不影响判定：正常对话消息远小于此。
 * 注意 `excerptLen` 记的仍是**原始**长度，不是截断后的长度。
 */
export const MAX_CACHED_TEXT_CHARS = 4000
/**
 * 提取内容的下限（去掉空白/标点/符号后的字符数）。
 *
 * 取 2 不是取 4：中文里两字对象很常见（「备份」「对账」「铝板」），
 * 卡到 4 会把「别忘了备份」这种明确指令漏掉；而 1 字（「记住啊」的「啊」）
 * 必须拦住，所以下限正好落在 2。
 */
export const MIN_CONTENT_CHARS = 2
/**
 * 指代型内容的上限（去掉空白/标点后 ≤ 此长度且以指代词开头 → 丢弃）。
 *
 * 「记住那个参数」抽出来是「那个参数」——没有对象，进库等于噪声。
 * 但「这个参数是超时 30 秒」超过这个长度，指代词只是句首修饰，内容本身是完整的，保留。
 */
export const DEICTIC_MAX_CHARS = 6

/** summary 末尾必须带的标记：主人要能一眼看出这条不是他亲口说的。 */
export const AUTO_MARK = '（自动提取）'

/** sidecar 默认落点（生产）。测试必须显式传临时路径，绝不碰这个文件。 */
export const DEFAULT_AUTO_EXTRACT_LOG = 'E:/ds-h/dsh-brain/data/logs/auto-extract.jsonl'

// ─────────────────────────────────────────────────────────────────────────────
// 反例闸（先筛整句，再谈规则）
// ─────────────────────────────────────────────────────────────────────────────

/** 问号：出现即按疑问处理，宁可漏。 */
const QUESTION_MARK = /[?？]/u
/**
 * 句尾疑问语气词。
 *
 * 只认 吗/呢/么/嘛 收尾。**不认「吧」**——「就按这个吧」是决定不是疑问，
 * 把「吧」当疑问会把一整类 switch-to 句式全砍掉。
 */
const QUESTION_TAIL = /(?:吗|呢|么|嘛)[\s。.！!～~]*$/u
/** 疑问词组（不需要问号也能定性）。 */
const QUESTION_PHRASES = /(?:还记得|记不记得|记住了?没|记住没|记下来没|记了没)/u

/**
 * 假设/条件句式。出现即丢。
 *
 * 为什么连「如果…」也一刀砍：条件句里确实可能藏偏好（「如果超时就重试三次」），
 * 但同一句法也产出「如果能记住就好」这种**愿望**。分不开就不提。
 */
const HYPOTHETICAL = /(?:如果|要是|假如|假使|若是|万一|倘若|就算|哪怕|假设|设想)/u

/**
 * 否定词表。只查**触发词之前**的窗口——触发词之后出现的否定是内容的一部分，
 * 不能拿来否决整句（「以后都用 pnpm 别用 npm」里的「别用」是被记录的内容）。
 */
const NEGATION = /(?:不用|不要|不必|无需|没必要|没有必要|不需要|不想|甭|勿|别|莫)/u

/** 否定窗口里要剔除的「别」构词：「别的」「别人」「别处」不是否定。 */
const NOT_NEGATION_BI = /别(?:的|人|处)/gu

/** 否定窗口长度（字符）。窗口内出现否定词 → 整条丢。 */
const NEGATION_WINDOW = 12

/**
 * 第三人称转述：别人的话**不是**主人的偏好/决定。
 *
 * 「记住他说过以后都用 pnpm」「据说铝板单价 128」——语义上是转述，
 * 记成主人的 fact/preference 是最坏的一种污染：检索时会被当主人自己的话召回。
 * 为什么提到整句级（而不是只拦 remember-verb）：
 * 「记住他说过以后都用 pnpm」里的「以后都用」会独立命中 always-use，
 * 规则级否决拦不住，只能整句砍。
 * `听说(?!读写)` 是防「听说读写能力」这种正常用词。
 */
const THIRD_PERSON_REPORT = /(?:他说|她说|据说|有人说|别人说|听说(?!读写))/u

/** 子句边界：触发词之后取到第一个边界为止。 */
const CLAUSE_STOP = /[，。！？；：、,!?;:\r\n]/u

/** 纯时间词/语气词内容：抽出来没有信息量。 */
const TRANSIENT_CONTENT =
  /^(?:今天|明天|后天|昨天|今晚|等会|等会儿|回头|待会|待会儿|晚上|早上|中午|一下|一下下|再说|再说吧|算了|好的|行|嗯|哦|对)$/u

/** 指代开头。配合长度上限使用，见 DEICTIC_MAX_CHARS。 */
const DEICTIC_HEAD =
  /^(?:这个|那个|这些|那些|这条|那条|这件|那件|这类|那些事|这|那|它|它们|上面|刚才|刚刚|前面|上次|上回|之前)/u

/**
 * 内容级否决：反讽 / 粗口 / 否定语气。
 *
 * 「我记住个屁」「这有什么好记的」字面完全合规（有触发词、有内容），
 * 但语义是**否定**——抽进库就是把主人的玩笑记成事实。
 * 这类信号只能靠词表，覆盖不全（见文件末尾的漏网清单）。
 */
const DENY_CONTENT = /(?:个屁|个毛|个头|才怪|鬼才|有啥好|没什么好记|没什么可记)/u

/**
 * 瞬时状态词：只用于 first-person-fact 的「在」分支。
 *
 * 「我这边在忙」「我这边在改」是此刻的状态，不是稳定事实；抽进长期记忆后
 * 每次检索都可能被召回，等于往库里灌过期数据。
 */
const TRANSIENT_STATE =
  /(?:正在|马上就|等一下|稍等|先忙|在忙|在等|在看|在跑|在改|在写|在处理|在测|在弄|忙着)/u

// ─────────────────────────────────────────────────────────────────────────────
// 四条规则
// ─────────────────────────────────────────────────────────────────────────────

/** 偏好词：用来把 remember-verb / always-use 归到 preference/profile。 */
const PREFERENCE_HINTS =
  /(?:喜欢|偏爱|偏好|习惯|讨厌|不喜欢|爱用|常用|一般用|最好|别用|不要用|不愿意|受不了)/u

/**
 * 规则表。**数组顺序 = 命中优先级**（同一句多条规则都命中时，取靠前的）。
 *
 * 每条规则都必须能回答「为什么只认它」，写在各自的注释里。
 */
const RULES = [
  {
    rule: 'remember-verb',
    /**
     * 为什么只认它：
     * 「记住 / 记一下 / 别忘 / 记下来」是**祈使句**，主语就是主人本人，
     * 宾语就是他此刻要我记的东西——这是全篇唯一不需要任何解释的意图表达。
     * 没有别的信号能和它比干净，所以它排第一优先级。
     *
     * 为什么不要裸「记得」：「我记得上次那个坑」是回忆，不是指令；
     * 「记得」几乎都是回顾，加进来立刻会误提一大批。只保留「别忘」这个祈使构词。
     */
    trigger: /(?:记下来|记住|记一下|记着|记下|别忘了|别忘)/u,
    /**
     * 整句否决：`我记住的是上周说的` / `你记住的是 A 还是 B`。
     *
     * 「我记住的」是**回顾**（我在描述自己记得什么），不是祈使（我要你记什么）。
     * 这类句子触发词和真正的「记住 X」长得一模一样，只能靠前置主语 + 判断助词「的」区分。
     * 实测这是 remember-verb 最高频的误提来源。
     */
    rawVeto: /(?:我|你)(?:就|只|还)?记住(?:的|了的是)/u,
    /** 内容取触发词**之后**（「记住 X」的 X 才是要记的东西）。 */
    anchor: 'after',
    kind: (content) => (PREFERENCE_HINTS.test(content) ? 'preference' : 'fact'),
    type: (kind) => (kind === 'preference' ? 'profile' : 'semantic'),
    lead: (kind) => (kind === 'preference' ? '主人要求记住的偏好：' : '主人明确要求记住：'),
  },
  {
    rule: 'always-use',
    /**
     * 为什么只认它：
     * 「以后都 / 统一用 / 一律 / 默认用 / 别再」都带**时间跨度**，
     * 说明说话人想让它被**将来**遵守——这是一条规则，不是对此刻的描述。
     * 描述性的「我现在用 vim」不在其中（那句属于 first-person-fact 的边界外）。
     *
     * 为什么把「别再」也算：否定祈使（「别再用 npm 了」）只在长期规则上出现，
     * 「别再」后面跟的几乎必然是希望停止的行为，和信息量对得上。
     */
    trigger: /(?:以后都|往后都|以后一律|以后统一|统一用|一律用|一律|默认用|默认是|别再|以后不要|以后别)/u,
    anchor: 'after',
    kind: () => 'preference',
    type: () => 'profile',
    lead: () => '主人定下的长期规则：',
  },
  {
    rule: 'switch-to',
    /**
     * 为什么只认它：
     * 「改成 / 换成」是**替换动词**，语义上意味着「从 A 换到 B」这件事已经发生或已被选定；
     * 「定下来 / 就按这个」更是直接宣判。决定类句式里没有比这更硬的标志。
     *
     * 为什么不是「我觉得/我想用」：那是倾向，不是决定；记成 decision 会替主人下结论
     * （与 CONTRACTS 13 节「矛盾绝不自选边」同一条纪律）。
     */
    trigger: /(?:改成|换成|定下来|定下了|就按这个|按这个来|敲定)/u,
    anchor: 'after',
    /**
     * 内容否决：以人称代词开头的「换成 X」是**换位思考**，不是换方案。
     *
     * 「换成你是我也这么干」「换成我就不这么选了」「改成你说的那样吧」——
     * 这三句在中文里极常见，字面全是「换成/改成」，但没有一句是决定。
     * 判据：内容以 你/他/她/它/您/大家/别人/谁 开头，或以「我就/我也/我才」开头。
     * 为什么放行「我们用 SQLite」：「换成我们用 SQLite」是真空决定，
     * 「我们用」不匹配「我就/我也/我才」，所以只砍换位句式，不砍真决定。
     */
    veto: /^(?:你|他|她|它|您|大家|别人|谁)|^我(?:就|也|才)/u,
    kind: () => 'decision',
    type: () => 'semantic',
    lead: () => '主人拍板：',
  },
  {
    rule: 'habit',
    /**
     * 为什么只认它（2026-10-31 放宽，决策①A）：
     * 「我习惯 / 我一般 / 我通常 / 我平时」后面跟的是**稳定的做事方式**，
     * 不是对此刻的描述——这和 first-person-fact 里被砍掉的「在」分支正好相反：
     * 「在忙」是瞬时状态，「习惯晚上干活」是长期模式。
     *
     * 为什么不含「我总是」：「我总是忘」「我总是搞混」抽出来是自嘲，不是偏好。
     */
    trigger: /(?:我习惯|我一般|我通常|我平时|我一向|我从来都)/u,
    anchor: 'after',
    kind: () => 'preference',
    type: () => 'profile',
    lead: () => '主人的习惯：',
  },
  {
    rule: 'future-rule',
    /**
     * 为什么只认它（2026-10-31 放宽，决策①A）：
     * 「下次 / 每次 / 千万别 / 从此以后」带**将来时态**，说的是「以后要照做」，
     * 这是一条规则而不是一次描述。always-use 只认「以后都」这种最硬的写法，
     * 实际对话里更常见的是「下次记得先备份」这类条件式要求，全被漏掉了。
     *
     * 为什么不用 `以后(?!都)` 收全部「以后」：「以后有钱了想买个…」是设想，
     * 不是要求；只收带祈使/否定的那几种构词，宁可漏。
     */
    trigger: /(?:从此以后|下次|每次|往后再|千万别|千万不要)/u,
    anchor: 'after',
    /**
     * 否定还原：内容是从触发词**之后**切的，于是「千万别动那个目录」会抽成
     * 「动那个目录」——**否定词丢了，语义正好反了**。存进库比漏掉更糟：
     * 以后召回这条会建议主人「动那个目录」。所以这里把丢掉的那半个词补回去。
     */
    contentPrefix: (hitText) => (/千万(?:别|不要)/u.test(hitText) ? '别' : ''),
    /**
     * 内容否决：`每次都是这样` / `下次再说` 抽出来是语气词，不是规则。
     * 前者是抱怨，后者是推托——两者都很常见，且字面完全合规。
     */
    veto: /^(?:都|都是|都是这样|这样|再说|再看|再议|吧)/u,
    kind: () => 'preference',
    type: () => 'profile',
    lead: () => '主人要求以后照做：',
  },
  {
    rule: 'first-person-fact',
    /**
     * 为什么只认它：
     * 「我的 X 是 Y」是**自述式事实**：主语（我的 X）和断言（是 Y）都在句内，
     * 不需要任何推断就能读出一条可存的事实。「我这边用 Z」同理。
     *
     * 为什么必须要求谓语（是/用/在）：光有「我的」只是限定语——
     * 「我的那个文件呢」「我的意思是」都不是事实。没有谓语就没有断言。
     *
     * 为什么「在」要额外挂保险丝（veto）：「我这边在忙」是瞬时状态，
     * 不是稳定事实。按表保留了「在」分支，但瞬时词一出现就否决。
     */
    trigger: /(?:我的|我这边|我们这边)/u,
    anchor: 'from',
    /**
     * 触发词之后必须出现谓语，否则不是断言。
     *
     * 2026-10-30 采纳实现者的建议，**砍掉了「在」分支**：
     * 「在」后面几乎必然是瞬时状态（在忙/在等/在改/在跑），原先靠 TRANSIENT_STATE
     * 词表兜底，但词表外一律漏网，而这类漏网最难抽检——「我这边在杭州出差」抽出来
     * 长得完全像事实。按「宁可漏不能错」的立场，这个面值得一次性消掉，
     * 代价只是漏掉极少数「我这边在<城市>」。
     *
     * 2026-10-31 扩到 `做|干|负责`：原表只认「是/用」，于是「我的工作做广告设计」
     * 「我这边负责建筑资料」这类**职业/职责自述**全部漏掉——而它们恰恰是最该记住的
     * 稳定事实。这三个动词本身是断言性的（「做/干/负责」后面必然跟对象），
     * 不像「在」那样同时承担进行时标记，所以单独扩这几个是安全的。
     */
    need: /(?:是|用|做|干|负责)/u,
    /**
     * 保险丝（两个条件互相独立，命中任一就否决）：
     * - `veto`：瞬时状态（「我这边在忙」「我这边在跑测试」）——不是稳定事实；
     * - `vetoExtra`：解释性构词（「我的意思是」「我的看法是」「我的问题是」）——
     *   带「是」但不是事实断言。这条是实测漏网的误提，补进来。
     */
    veto: TRANSIENT_STATE,
    vetoExtra: /(?:我的|我这边)(?:意思|想法|看法|问题|建议|疑问|理解|考虑)/u,
    kind: () => 'fact',
    type: () => 'semantic',
    lead: () => '主人自述：',
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// 纯函数：文本 → 候选
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 整句定性：疑问 / 假设。任一成立 → 整条不提取。
 * @param {string} text
 * @returns {boolean}
 */
function isQuestion(text) {
  if (QUESTION_MARK.test(text)) return true
  if (QUESTION_TAIL.test(text)) return true
  if (QUESTION_PHRASES.test(text)) return true
  return false
}

/**
 * 触发词之前的窗口里是否有否定。
 *
 * 只查前置窗口：触发词之后的否定属于内容（「以后都用 pnpm 别用 npm」要整条记住）。
 * @param {string} text
 * @param {number} index 触发词起点
 * @returns {boolean}
 */
function isNegatedBefore(text, index) {
  const from = Math.max(0, index - NEGATION_WINDOW)
  const window = text.slice(from, index).replace(NOT_NEGATION_BI, '')
  return NEGATION.test(window)
}

/**
 * 从 index 取到子句边界。anchor=after / from 都走这条。
 * @param {string} text
 * @param {number} index
 * @returns {string}
 */
function sliceClause(text, index) {
  // 先跳过紧邻起点的分隔符：`记住，明天十点开会` 的逗号在位置上，
  // 不跳过就会把内容切空（实测踩过：整句被判成「没有内容」而漏掉）。
  const rest = text.slice(index).replace(/^[\s\u3000，。！？；：、,!?;:\r\n]+/u, '')
  const hit = CLAUSE_STOP.exec(rest)
  return hit ? rest.slice(0, hit.index) : rest
}

/**
 * 清洗内容：折叠空白、剥掉首尾标点符号、剥掉开头的系词。
 *
 * 剥系词是为了让内容更接近「要存的那句话」：「记住用 pnpm」→「pnpm」，
 * 而不是把「用」也当内容存进去。但只剥**开头紧邻**的一个，不碰中间。
 * @param {string} segment
 * @returns {string}
 */
function cleanContent(segment) {
  let text = String(segment || '')
    .replace(/[\s\u3000]+/gu, ' ')
    .trim()
  text = text.replace(/^[\s\p{P}\p{S}]+/u, '')
  text = text.replace(/^(?:就是|是|用的是|用的|用)/u, '')
  text = text.replace(/[\s\p{P}\p{S}]+$/u, '')
  return text.trim()
}

/**
 * 内容是否够「具体」。
 * @param {string} content
 * @returns {boolean}
 */
function isSubstantive(content) {
  const core = content.replace(/[\s\p{P}\p{S}]/gu, '')
  if (core.length < MIN_CONTENT_CHARS) return false
  if (TRANSIENT_CONTENT.test(core)) return false
  if (DEICTIC_HEAD.test(content) && core.length <= DEICTIC_MAX_CHARS) return false
  return true
}

/**
 * 生成 summary。末尾必须带标记，且标记永远在最后（先截断内容，再拼标记）。
 * @param {{ lead: (kind: string) => string }} rule
 * @param {string} kind
 * @param {string} content
 * @returns {string}
 */
function buildSummary(rule, kind, content) {
  const head = rule.lead(kind)
  const room = Math.max(20, 120 - head.length - AUTO_MARK.length)
  const body = content.length > room ? content.slice(0, room) + '…' : content
  return head + body + AUTO_MARK
}

/**
 * 纯规则提取：一段用户文本 → 候选数组。
 *
 * 这是单测入口，也是 judgeTurn 的唯一判定来源。**零抛出**（异常一律返回空数组）。
 * 注意：纯函数自己不认识「角色」，它只认文本；「assistant 的话不参与」是
 * judgeTurn 的职责（缓存只由 noteUserMessage 写入）。
 *
 * @param {string} text 用户消息原文
 * @returns {Array<{ rule: string, kind: string, type: string, content: string, summary: string, excerptLen: number }>}
 */
export function extractCandidates(text) {
  try {
    if (typeof text !== 'string') return []
    const raw = text
    if (raw.trim().length === 0) return []
    // 整句定性闸：疑问和假设先砍掉，不进任何规则。
    if (isQuestion(raw)) return []
    if (HYPOTHETICAL.test(raw)) return []
    if (THIRD_PERSON_REPORT.test(raw)) return []

    const out = []
    const seen = new Set()
    for (const rule of RULES) {
      const hit = rule.trigger.exec(raw)
      if (!hit) continue
      // 整句否决（如回顾句「我记住的是…」）：在切内容之前先拦，省得抽出一段假内容。
      if (rule.rawVeto && rule.rawVeto.test(raw)) continue
      if (isNegatedBefore(raw, hit.index)) continue
      const start = rule.anchor === 'after' ? hit.index + hit[0].length : hit.index
      const clause = sliceClause(raw, start)
      if (rule.need && !rule.need.test(clause)) continue
      if (rule.veto && rule.veto.test(clause)) continue
      if (rule.vetoExtra && rule.vetoExtra.test(clause)) continue
      if (DENY_CONTENT.test(clause)) continue
      // 否定还原：有的规则会把触发词里的否定词留在外面（见 future-rule 的 contentPrefix）。
      const prefix = typeof rule.contentPrefix === 'function' ? String(rule.contentPrefix(hit[0]) || '') : ''
      const content = cleanContent(prefix + clause)
      if (!isSubstantive(content)) continue
      const kind = rule.kind(content)
      const type = rule.type(kind)
      const key = rule.rule + '|' + kind + '|' + content
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        rule: rule.rule,
        kind,
        type,
        content,
        summary: buildSummary(rule, kind, content),
        excerptLen: raw.length,
      })
    }
    return out
  } catch {
    return []
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 有状态门面
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 本地日期键（YYYY-MM-DD）。配额的「每天」按**本机本地时间**算——
 * 主人按本地时间生活，用 UTC 会让配额在早上 8 点重置，跟直觉不符。
 * @param {number} now
 * @returns {string}
 */
function localDayKey(now) {
  const d = new Date(now)
  const pad = (n) => (n < 10 ? '0' + n : String(n))
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
}

/**
 * turn 归一：数字/字符串都能比，null/undefined 表示「不指定」。
 * @param {unknown} turn
 * @returns {string|null}
 */
function turnKey(turn) {
  if (turn == null || turn === '') return null
  return String(turn)
}

/**
 * 造一个侧车目录就绪 memo，避免每条记录都 mkdir。
 * @param {string} filePath
 * @returns {() => Promise<void>}
 */
function makeDirEnsurer(filePath) {
  let ready = null
  return () => {
    if (!ready) {
      ready = mkdir(dirname(filePath), { recursive: true }).then(
        () => undefined,
        (err) => {
          // 失败要允许下次重试：清掉 memo 再抛，让调用方 catch 成 { ok: false }。
          ready = null
          throw err
        },
      )
    }
    return ready
  }
}

/**
 * 创建自动提取器。
 *
 * @param {object} [options]
 * @param {string} [options.logPath] sidecar JSONL 落点（测试必须传临时路径）
 * @param {number} [options.maxPerTurn] 每轮最多几条候选，默认 2
 * @param {number} [options.maxPerSessionDay] 每会话每天最多几条，默认 10
 * @param {number} [options.maxPerDay] 全局每天最多几条，默认 40
 * @param {boolean} [options.enabled] 总开关，默认 true
 */
export function createAutoExtractor(options = {}) {
  const opts = options && typeof options === 'object' ? options : {}
  const logPath = typeof opts.logPath === 'string' && opts.logPath ? opts.logPath : DEFAULT_AUTO_EXTRACT_LOG
  // 2026-10-31 放宽（决策①A）：实测「每轮 1 条、每天 20 条」在真实对话里从没打满过——
  // 卡住的不是配额，是规则覆盖。但规则一放宽，配额就会成为新瓶颈，所以同步上调。
  const maxPerTurn = clampInt(opts.maxPerTurn, 2, 1, 10)
  const maxPerSessionDay = clampInt(opts.maxPerSessionDay, 10, 0, 200)
  const maxPerDay = clampInt(opts.maxPerDay, 40, 0, 1000)
  const enabled = opts.enabled !== false

  /**
   * 用户消息缓存：sessionId → 数组（插入序即时间序）。
   *
   * 用 Map 而不是对象：Map 保证插入顺序，驱逐「最早的会话」时直接取 keys 第一个。
   */
  const cache = new Map()

  /** 配额计数（**内存**，不建表：这是运行期节流，不是业务数据，重启归零完全可接受）。 */
  const sessionDayCount = new Map()
  let globalDayCount = 0
  /** 计数归属的本地日期；跨天时整体清零。 */
  let quotaDay = localDayKey(Date.now())

  const stats = { created: 0, skippedDup: 0, skippedQuota: 0, disabled: 0, turns: 0 }

  const ensureDir = makeDirEnsurer(logPath)

  /** 跨天则清空配额计数。 */
  function resetQuotaIfNeeded() {
    const today = localDayKey(Date.now())
    if (today !== quotaDay) {
      quotaDay = today
      sessionDayCount.clear()
      globalDayCount = 0
    }
  }

  /**
   * 缓存一条用户消息（有界）。
   * @param {unknown} sessionId
   * @param {unknown} turn
   * @param {unknown} text
   * @returns {{ ok: boolean }}
   */
  function noteUserMessage(sessionId, turn, text) {
    try {
      if (typeof text !== 'string') return { ok: false }
      const trimmed = text.trim()
      if (!trimmed) return { ok: false }
      const sid = sessionId == null || sessionId === '' ? '__anon__' : String(sessionId)
      const item = {
        turn: turnKey(turn),
        // 只截断存储，不截断判定语义：超长消息的后半段本来也不会成为触发词之后的短内容。
        text: trimmed.length > MAX_CACHED_TEXT_CHARS ? trimmed.slice(0, MAX_CACHED_TEXT_CHARS) : trimmed,
        rawLen: trimmed.length,
      }
      let list = cache.get(sid)
      if (!list) {
        list = []
        cache.set(sid, list)
        // 会话数超限：驱逐最早插入的会话（Map 的 keys 第一个）。
        while (cache.size > MAX_SESSIONS) {
          const oldest = cache.keys().next()
          if (oldest.done) break
          cache.delete(oldest.value)
        }
      } else {
        // 刷新该会话的插入顺序：让它不再是「最早」的候选。
        cache.delete(sid)
        cache.set(sid, list)
      }
      list.push(item)
      while (list.length > MAX_MESSAGES_PER_SESSION) list.shift()
      return { ok: true }
    } catch {
      return { ok: false }
    }
  }

  /**
   * 判定某个 turn 要不要提取。
   *
   * 配额在**判定命中时**扣，而不是等到 record 报 created 才扣：
   * 配额防的是「提取噪声」，噪声在候选产生那一刻就已经产生了（哪怕调用方写库失败、
   * 哪怕被去重挡掉）。按产出扣更保守，符合「宁可漏」的立场。
   *
   * @param {{ sessionId?: unknown, turn?: unknown }} [input]
   * @returns {{ candidates: Array<object>, skipped: 'quota'|'disabled'|null }}
   */
  function judgeTurn(input = {}) {
    try {
      stats.turns += 1
      if (!enabled) {
        stats.disabled += 1
        return { candidates: [], skipped: 'disabled' }
      }
      const args = input && typeof input === 'object' ? input : {}
      const sid = args.sessionId == null || args.sessionId === '' ? '__anon__' : String(args.sessionId)
      const wantTurn = turnKey(args.turn)
      const list = cache.get(sid)
      if (!list || list.length === 0) return { candidates: [], skipped: null }

      const matched = wantTurn == null ? list.slice(-1) : list.filter((it) => it.turn === wantTurn)
      if (matched.length === 0) return { candidates: [], skipped: null }

      // 消息级：一条消息最多 1 条候选（取规则优先级最高的那个，RULES 顺序即优先级）。
      const pool = []
      for (const it of matched) {
        const found = extractCandidates(it.text)
        if (found.length === 0) continue
        const best = found[0]
        // excerptLen 用**原消息**长度，不是截断后的缓存长度——「只记长度」得是真的长度。
        pool.push({ ...best, excerptLen: it.rawLen })
      }
      if (pool.length === 0) return { candidates: [], skipped: null }

      resetQuotaIfNeeded()
      const sessionUsed = sessionDayCount.get(sid) || 0
      const sessionLeft = Math.max(0, maxPerSessionDay - sessionUsed)
      const globalLeft = Math.max(0, maxPerDay - globalDayCount)
      const quotaLeft = Math.min(sessionLeft, globalLeft)
      if (quotaLeft <= 0) {
        stats.skippedQuota += 1
        return { candidates: [], skipped: 'quota' }
      }

      // 轮级：maxPerTurn 截断。
      const take = Math.min(quotaLeft, maxPerTurn, pool.length)
      const chosen = pool.slice(0, take)
      // 扣配额：判定即消耗（见函数注释）。
      sessionDayCount.set(sid, sessionUsed + take)
      globalDayCount += take
      return { candidates: chosen, skipped: null }
    } catch {
      return { candidates: [], skipped: null }
    }
  }

  /**
   * 追加一条 sidecar 记录（**只记长度，不记原文**）。
   *
   * @param {{ sessionId?: unknown, turn?: unknown, rule?: string, status?: string,
   *   memoryId?: string, reason?: string, excerptLen?: number }} [entry]
   * @returns {Promise<{ ok: boolean }>}
   */
  async function record(entry) {
    try {
      const e = entry && typeof entry === 'object' ? entry : {}
      const status = typeof e.status === 'string' && e.status ? e.status : 'unknown'
      const ts = Date.now()
      /** @type {Record<string, unknown>} */
      const line = {
        ts,
        at: new Date(ts).toISOString(),
        sessionId: e.sessionId == null ? null : String(e.sessionId),
        turn: e.turn == null ? null : e.turn,
        rule: typeof e.rule === 'string' ? e.rule : null,
        status,
        // excerptLen 是**原用户消息字数**：能对上「这条是从多长的消息里抽的」，但不含内容。
        excerptLen: Number.isFinite(Number(e.excerptLen)) ? Number(e.excerptLen) : null,
      }
      if (e.memoryId != null && e.memoryId !== '') line.memoryId = String(e.memoryId)
      if (e.reason != null && e.reason !== '') line.reason = String(e.reason)

      // 统计跟写盘解耦：record 记的是「这次判定是什么结果」，写盘失败不改变事实。
      if (status === 'created') stats.created += 1
      else if (status === 'duplicate') stats.skippedDup += 1

      try {
        await ensureDir()
        await appendFile(logPath, JSON.stringify(line) + '\n', 'utf8')
        return { ok: true }
      } catch {
        return { ok: false }
      }
    } catch {
      return { ok: false }
    }
  }

  /**
   * 计数快照。
   * @returns {{ created: number, skippedDup: number, skippedQuota: number, disabled: number, turns: number }}
   */
  function getStats() {
    try {
      return { ...stats }
    } catch {
      return { created: 0, skippedDup: 0, skippedQuota: 0, disabled: 0, turns: 0 }
    }
  }

  return {
    noteUserMessage,
    judgeTurn,
    record,
    stats: getStats,
  }
}

/**
 * 把配置值收成合法整数（越界夹回默认值，不抛）。
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.floor(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

/**
 * 已知最可能误提取的两种句式（写在代码里，供**人工抽检**对照）：
 *
 * 1. **`switch-to` 遇到「定下来」被逗号切断，抽不全**：
 *    「数据库就按这个方案定下来，先上 SQLite」→ 只抽到「方案定下来」，
 *    「先上 SQLite」这个真正的决定被丢了。这不是错记（内容仍是主人的话），
 *    是**失真**：summary 读起来像决定内容就是「方案定下来」。
 *    抽检时优先看 rule=switch-to 且 content 以「方案/这个/那样」开头的条目。
 *
 * 2. **`first-person-fact` 把习惯/做法归成 fact**：
 *    「我的习惯是晚上干活」「我的做法是先备份再改」→ kind=fact/semantic，
 *    实际是 preference/profile。内容是真的，**类型不准**——会让「偏好」类检索
 *    召回到这些条目，而「事实」类检索也会。抽检时优先看 rule=first-person-fact
 *    且 content 含「习惯/做法/风格/一般/通常」的条目。
 *
 * 另外：反讽、粗口、无问号的反问只能靠 `DENY_CONTENT` 词表挡，词表外一律漏网
 * （「记住我谢谢你」这类）。按「宁可漏」的立场这是可以接受的——漏记不影响检索，
 * 错记才会。
 */
