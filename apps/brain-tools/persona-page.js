// @ts-check
/**
 * 外置大脑 · 人格与主动社交页（/dsh-brain/persona）
 *
 * ── 这页要解决什么 ──
 *
 * 系统 4 里最需要「看得见」的是两件事：
 *   1. **现在注入的是哪一版人格、它由哪几层组成**——人格会影响我说出口的每句话，
 *      不能只存在库里；
 *   2. **主动开口这件事，它今天本来会说什么、为什么没发**——`social.preview()` 是
 *      方案里唯一允许的「预演」入口，它只读、不写任何业务行，所以可以随时按。
 *
 * 第三件事是「关系四维」，它决定我说话的分寸；第四件是回复决策的五态占比——
 * 沉默也是决策，占比能直接暴露「它是不是在装没听见」（保护类输入不许沉默）。
 *
 * ── 为什么「如果现在发会怎样」是按钮而不是自动跑 ──
 *
 * `preview()` 每次都会根据当前时间/精力/心情/关系重新算分。自动跑意味着页面每次
 * 刷新都在做一次「假设性判断」，人分不清「这是演算还是它真发过」。做成按钮：
 * 点了才算、点了才显示，而且结果**只显示在页面顶部**、不写库、不产生发送记录。
 *
 * ── 纪律 ──
 *
 * 1. 冲突裁决、取消候选、以及**批准并发送**都要两步确认 + POST + `X-Brain-Action: 1`；
 *    批准发送的预备态 3 秒自动退回（真发的代价不可撤回，手滑不能生效）；
 * 2. 缺字段显示「–」：`relationship === null` 是「还没有关系记录」，不是「四维全 0」；
 * 3. 所有开关状态照实显示，包括「真发会被拦在哪一道」；
 * 4. 发送结果贴在候选卡上：成功 / 被闸门拒的原因 / note 三样都照实写，
 *    服务端回 `ok:false` 就是没发出去，不许渲染成成功。
 */

import { renderPageHead } from './nav.js?v=1793594997081'

/**
 * 主动社交候选来源中文。
 *
 * 这张表只负责「怎么叫」；「做了没有」一律读 `social.sourceStates`
 * （来自 `social.js` 的 `SOCIAL_SOURCE_STATE`）——把「没做」写死在这里，
 * 代码补齐之后页面就会开始说错话，那是最难被发现的一类过期文案。
 */
const SOURCE_LABELS = {
  schedule: '作息时间',
  unfinished_care: '没问完的关心',
  commitment: '未完成的承诺',
  discovery: '新发现',
  shared_memory: '共同记忆',
  verification: '求证',
  curiosity: '好奇',
}

/** 评分组件中文。 */
const COMPONENT_LABELS = {
  relevance: '相关性',
  actualHelp: '实际帮助',
  relationshipFit: '关系适配',
  freshness: '新鲜度',
  interruptionCost: '打扰成本',
  repetitionPenalty: '重复度',
  busyPenalty: '忙碌/负面反馈',
  resourcePressure: '压力资源',
}

/** 硬闸中文。 */
const GATE_LABELS = {
  switches: '开关',
  policy_disabled: '该用户策略',
  missing_evidence: '缺少证据',
  night_hours: '深夜时段',
  too_soon: '距上次太近',
  low_energy: '精力过低',
  low_mood: '心情过低',
}

/** 冲突类型中文。 */
const CONFLICT_KIND_LABELS = {
  identity: '身份',
  boundary: '边界',
  style: '风格',
  preference: '偏好',
  contradiction: '矛盾',
}

/** 冲突处理状态中文。 */
const CONFLICT_RESOLUTION_LABELS = {
  unresolved: '未裁决',
  keep_old: '保留旧值',
  keep_new: '采用新值',
  merged: '已合并',
  deferred: '延后',
}

/** 五层中文。顺序就是契约里的顺序。 */
const LAYERS = [
  { key: 'locked', label: '锁定层', note: '身份/边界/禁忌：没有人能改' },
  { key: 'base', label: '基础层', note: '价值观/语气/称呼：随新版本演进' },
  { key: 'learned', label: '学习层', note: '从相处里学到的倾向（每 12 小时自动归纳，可回滚）' },
  { key: 'userOverride', label: '主人覆盖', note: '主人显式指定，压过基础层（唯一可手写的一层）' },
  { key: 'transient', label: '临时层', note: '单次上下文覆盖，不进历史' },
]

/** 回复五态中文。 */
const DECISION_LABELS = {
  reply: '正常回复',
  brief_reply: '简短回复',
  delay: '延后',
  decline: '拒绝',
  silent: '沉默',
}

/** 关系四维中文与「这个分数像什么」。 */
const DIMENSIONS = [
  { key: 'familiarity', label: '熟悉', hint: '我知道你多少事、你知道我多少事' },
  { key: 'trust', label: '信任', hint: '能不能托付、说过的话算不算数' },
  { key: 'intimacy', label: '亲密', hint: '能不能说私事、能不能撒娇' },
  { key: 'rapport', label: '好感', hint: '相处舒不舒服、愿不愿意主动找' },
]

function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function dash(value) {
  if (value === null || value === undefined) return '–'
  const text = String(value)
  return text.length === 0 ? '–' : text
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? String(n) : '–'
}

function fmtWhen(value) {
  if (value === null || value === undefined || value === '') return '–'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n) => String(n).padStart(2, '0')
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/**
 * 任意值 → 一行可读文本。**不产生 [object Object]**：
 * 对象走 JSON、数组走顿号、其它走 String。
 */
function flat(value) {
  if (value === null || value === undefined) return '–'
  if (typeof value === 'string') return value.length === 0 ? '–' : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '（空）'
    return value.map((item) => (typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item))).join('；')
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== null && v !== undefined && v !== '')
    if (entries.length === 0) return '（空）'
    return entries.map(([k, v]) => k + '：' + (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v))).join('；')
  }
  return String(value)
}

/** 「主人覆盖」层的编辑器：一行一条「键：值」，整段交给服务端解析。 */
function overrideEditor(body) {
  const preset = body && typeof body === 'object'
    ? Object.entries(body).map(([field, value]) => field + '：' + flat(value)).join('\n')
    : ''
  return '<div class="override-editor" data-override-box>'
    + '<textarea data-override-text rows="4" spellcheck="false" '
    + 'placeholder="一行一条，比如：&#10;称呼：叫我老板&#10;语气：别用敬语">'
    + esc(preset) + '</textarea>'
    + '<div class="override-actions">'
    + '<button type="button" class="btn btn--sm" data-act="override-save" data-confirm="保存覆盖">保存覆盖</button>'
    + '<span class="override-hint">点一次，再点一次确认 → 生成新版本并立即生效，随时可回滚</span>'
    + '</div>'
    + '</div>'
}

/** 分层内容：每层把字段铺成人话。 */
function layersBlock(layers) {
  if (!layers || typeof layers !== 'object') {
    return '<div class="empty"><strong>没有分层内容</strong><span>这个版本没有 layers 数据。</span></div>'
  }
  return '<div class="layers">' + LAYERS.map((layer) => {
    const body = layers[layer.key]
    const hasBody = body && typeof body === 'object' && Object.keys(body).length > 0
    const inner = hasBody
      ? Object.entries(body).map(([field, value]) => '<div class="layer-row">'
        + '<span class="layer-field">' + esc(field) + '</span>'
        + '<span class="layer-value">' + esc(flat(value)) + '</span>'
        + '</div>').join('')
      : '<div class="layer-empty">（这一层是空的）</div>'
    return '<div class="layer">'
      + '<div class="layer-head"><b>' + esc(layer.label) + '</b>'
      + '<span class="layer-key">' + esc(layer.key) + '</span>'
      + '<span class="layer-note">' + esc(layer.note) + '</span></div>'
      + inner
      // 只有「主人覆盖」这一层给编辑入口：它是设计里唯一留给主人手写的层。
      + (layer.key === 'userOverride' ? overrideEditor(body) : '')
      + '</div>'
  }).join('') + '</div>'
}

/** 评分拆解：components + 闸门 + 门槛。 */
function breakdownBlock(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') {
    return '<div class="score-empty">这条候选没有评分拆解（已落表的旧候选可能没有）。</div>'
  }
  const components = breakdown.components && typeof breakdown.components === 'object' ? breakdown.components : {}
  const chips = Object.keys(COMPONENT_LABELS).filter((key) => components[key] !== undefined).map((key) => {
    const value = Number(components[key])
    const cls = value < 0 ? 'down' : (value > 0 ? 'up' : '')
    return '<span class="score-chip ' + cls + '">' + esc(COMPONENT_LABELS[key])
      + ' <b>' + esc((value > 0 ? '+' : '') + String(value)) + '</b></span>'
  }).join('')
  const gates = Array.isArray(breakdown.gates) ? breakdown.gates : []
  const gateList = gates.length
    ? gates.map((gate) => '<span class="gate ' + (gate && gate.passed ? 'pass' : 'fail') + '">'
      + (gate && gate.passed ? '✓ ' : '✗ ') + esc(GATE_LABELS[gate && gate.code] || (gate && gate.code) || '未知闸门')
      + (gate && gate.detail ? '（' + esc(gate.detail) + '）' : '')
      + '</span>').join('')
    : '<span class="gate">没有闸门记录</span>'
  return '<div class="score-box">'
    + '<div class="score-chips">' + (chips || '<span class="score-empty">没有加权项</span>') + '</div>'
    + '<div class="score-gates">' + gateList + '</div>'
    + '<div class="score-meta">门槛 ' + esc(num(breakdown.threshold))
    + ' · 公式 ' + esc(dash(breakdown.formula)) + '</div>'
    + '</div>'
}

/**
 * 开关条（2026-11-02 重做）。
 *
 * 旧版是「文字 chip + 开关状态拼在一句里」（「主动社交 开」），三个问题：
 *   1. **看不出能点**：渲染出来跟旁边只读的状态 chip 长得一样，主人得猜；
 *   2. **「关」被画成灰底**，而「全局暂停：关」其实是最正常的状态——灰色读成了「禁用」；
 *   3. 只读信息（外发能力 / 真发会不会被拦）跟开关挤在同一排，权重一样，分不清哪些能操作。
 *
 * 新版：每个开关是一格「标签 + 拨杆 + 状态字」，拨杆的位置本身就是状态，
 * 谁都能看出这是可拨的；只读信息移出这一排，单独一行说明。
 *
 * 两步确认仍然复用页面里已有的 armed 机制（第一次点只提醒后果，4 秒不点自动退回）。
 * **armed 只加类、不改 textContent**：这套按钮内部是 span 结构，
 * 一旦被 textContent 覆盖，拨杆和状态字就没了。
 *
 * 「外发能力」不是开关（取决于通道有没有配），仍然只读。
 */
function switchPill(item) {
  const next = item.on ? '0' : '1'
  return '<button type="button" class="sw' + (item.on ? ' on' : '') + '"'
    + ' data-act="switch" data-switch="' + esc(item.name) + '" data-next="' + next + '"'
    + ' data-label="' + esc(item.label) + '"'
    + ' aria-pressed="' + (item.on ? 'true' : 'false') + '"'
    + ' title="' + esc(item.hint) + '（点一下切换）">'
    + '<span class="sw-k">' + esc(item.label) + '</span>'
    + '<span class="sw-s">' + (item.on ? '开' : '关') + '</span>'
    + '<span class="sw-t" aria-hidden="true"><i></i></span>'
    + '</button>'
}

/** 一排开关。items = [{ name, label, on, hint }]；compact 用于卡片内部（跟页头那排分级） */
function switchBar(items, compact) {
  return '<div class="sw-bar' + (compact ? ' sw-bar--compact' : '') + '">'
    + (items || []).map(switchPill).join('') + '</div>'
}

/**
 * 策略编辑器（2026-10-31）：把「每日上限 / 冷却 / 待批准上限 / 免打扰」从只读变成可改。
 *
 * 为什么不并进开关：开关（paused / social.enabled / allow_external）是**放不放行**，
 * 这几个是**闸门放多宽**。两类混在一起会让人以为关了开关就等于不发。
 * 写操作走 POST /api/persona/policy，底部按钮同样两步确认。
 */
function policyEditor(policy) {
  const quiet = Array.isArray(policy.quietHours)
    ? policy.quietHours.map((entry) => String(entry.from) + '-' + String(entry.to)).join(', ')
    : ''
  const field = (name, label, value, hint, min, max) =>
    '<label class="pol-field"><span>' + esc(label) + '</span>'
    + '<input type="number" data-policy="' + esc(name) + '" value="' + esc(String(value)) + '"'
    + ' min="' + min + '" max="' + max + '" title="' + esc(hint) + '"></label>'
  return '<div class="policy-box" data-policy-box>'
    + '<div class="policy-head">策略（生效中的阈值，改了立刻影响下一次仲裁）</div>'
    + '<div class="policy-grid">'
    + field('dailyCap', '每日上限', policy.dailyCap, '一天最多真发几条（0 = 一条都不发）', 0, 100)
    + field('cooldownMinutes', '冷却（分钟）', policy.cooldownMinutes, '两条之间至少隔多久', 0, 10080)
    + field('maxPending', '待批准上限', policy.maxPending, '队列里最多攒几条待批准', 0, 100)
    + '<label class="pol-field wide"><span>免打扰时段</span>'
    + '<input type="text" data-policy="quietHours" value="' + esc(quiet) + '"'
    + ' placeholder="00:00-07:30, 12:00-13:00（留空 = 不设免打扰）"'
    + ' title="格式 HH:mm-HH:mm，多个用逗号分隔；留空表示取消免打扰"></label>'
    + '</div>'
    + '<div class="policy-actions">'
    + '<button type="button" class="btn btn--sm" data-act="policy-save" data-confirm="保存策略">保存策略</button>'
    + '<span class="policy-note">点两次保存（两步确认）。范围会被服务端校验，越界的值会以错误码拒绝，不会静默夹取。</span>'
    + '</div></div>'
}

/**
 * 通道编辑器（2026-10-31）：QQ 只是当前这一个，换成任意 dsh-im 目标都行。
 *
 * 为什么不把通道配置塞进服务端渲染：它是**插件的运行参数**（存
 * data/persona/channel.json），不在人格门面的 view 里。所以这里先渲染空壳，
 * 页面加载后再 fetch /api/persona/channels 填当前值。
 * 保存后**不用重启**——outboundChannel 每次发送都现读配置。
 */
function channelEditor() {
  return '<div class="policy-box" data-channel-box>'
    + '<div class="policy-head">投递通道（读取中…）</div>'
    + '<div class="policy-grid">'
    + '<label class="pol-field wide"><span>Bot ID</span>'
    + '<input type="text" data-channel="botId" placeholder="qq_xxx / bot_xxx（从 dsh-im 设置页复制）"></label>'
    + '<label class="pol-field wide"><span>Target ID</span>'
    + '<input type="text" data-channel="targetId" placeholder="tgt_xxx（投递目标的调用别名）"></label>'
    + '<label class="pol-field"><span>备注名</span>'
    + '<input type="text" data-channel="label" placeholder="比如：我的微信"></label>'
    + '</div>'
    + '<div class="policy-actions">'
    + '<button type="button" class="btn btn--sm" data-act="channel-save" data-confirm="保存通道">保存通道</button>'
    + '<span class="policy-note">路径：设置 → IM机器人 → 对应账号 → 投递设置 → 复制 Bot ID / 调用参数。保存即时生效。</span>'
    + '</div></div>'
}

/**
 * 主动送达设置（2026-10-31）：**在面板上改，不用碰 cordis.patch.yml**。
 *
 * 跟通道编辑器同一套做法：服务端只渲染空壳，页面加载后 fetch
 * `/api/persona/social-auto` 填当前值；保存后**不用重启**——每次送达前现读
 * `data/persona/social-auto.json`。
 */
function socialAutoEditor() {
  return '<div class="policy-box" data-socialauto-box>'
    + '<div class="policy-head">主动送达（读取中…）</div>'
    + '<div class="policy-grid">'
    + '<label class="pol-field wide"><span>自动送达</span>'
    + '<select data-socialauto="enabled">'
    + '<option value="true">开 —— 每轮生成候选后自动送一条</option>'
    + '<option value="false">关 —— 只生成候选，不送达</option>'
    + '</select></label>'
    + '<label class="pol-field wide"><span>送到哪</span>'
    + '<select data-socialauto="mode">'
    + '<option value="console">只控制台 —— 记一条，不打扰</option>'
    + '<option value="both">控制台 + 微信真发</option>'
    + '</select></label>'
    + '</div>'
    + '<div class="policy-actions">'
    + '<button type="button" class="btn btn--sm" data-act="socialauto-save" data-confirm="保存主动送达设置">保存</button>'
    + '<span class="policy-note">保存后下一轮（30 分钟内）生效，不用重启。选「微信真发」前先在 dsh-im 里确认机器人是在线的。</span>'
    + '</div></div>'
}

/** 单条社交候选（fresh 或 wouldSay 或已验证候选）。 */
function socialCard(candidate, opts) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const title = candidate.persisted ? '已落表的候选' : '新鲜候选'
  const wouldSay = options.highlight === true
  const chips = [
    '<span class="chip accent">' + esc(SOURCE_LABELS[candidate.source] || candidate.source) + '</span>',
    '<span class="chip">分数 ' + esc(num(candidate.score)) + '</span>',
  ]
  if (candidate.topic) chips.push('<span class="chip">话题 ' + esc(candidate.topic) + '</span>')
  if (candidate.persisted) chips.push('<span class="chip">' + esc(title) + '</span>')
  if (candidate.wouldSend) chips.push('<span class="chip ok">会发</span>')
  else chips.push('<span class="chip bad">不发</span>')
  if (candidate.blockedBy) {
    chips.push('<span class="chip bad">拦在：' + esc(GATE_LABELS[candidate.blockedBy] || candidate.blockedBy) + '</span>')
  }
  const dryId = candidate.id ? String(candidate.id) : ''
  const cancelButton = candidate.persisted && dryId
    ? '<button class="btn btn--sm btn--danger" data-act="social-cancel" data-id="' + esc(dryId)
      + '" data-confirm="取消这条主动社交候选">取消候选</button>'
    : ''
  // 发送按钮只给**已落表**的候选：`social.send(candidateId)` 认的是库里的 id，
  // 预演产生的 fresh 候选没有 id，给它一个按钮只会点出一句报错。
  // 「没有按钮」要配一句原因，否则会被读成「这页坏了」。
  const sendButtons = candidate.persisted && dryId
    ? '<button class="btn btn--sm" data-act="social-send-dry" data-id="' + esc(dryId) + '">试发（不真发）</button>'
      + '<button class="btn btn--sm btn--danger" data-act="social-send-approved" data-id="' + esc(dryId)
      + '" data-confirm="批准并发送">批准并发送</button>'
    : '<span class="send-hint">这条是预演（没落表），拿到候选 id 之后才能试发 / 批准发送</span>'
  return '<div class="social' + (wouldSay ? ' would-say' : '') + '">'
    + '<div class="social-top">' + chips.join('') + '</div>'
    + '<div class="social-text">' + esc(candidate.text) + '</div>'
    + '<div class="social-meta">'
    + '<span>来源 <b>' + esc(SOURCE_LABELS[candidate.source] || candidate.source) + '</b></span>'
    + '<span>证据 <b>' + esc(num(candidate.evidenceCount)) + '</b> 条</span>'
    + (candidate.status ? '<span>状态 <b>' + esc(candidate.status) + '</b></span>' : '')
    + (candidate.expiresAt ? '<span>过期 <b>' + esc(fmtWhen(candidate.expiresAt)) + '</b></span>' : '')
    + '</div>'
    + breakdownBlock(candidate.breakdown)
    + '<div class="social-actions">'
    + '<button class="btn btn--sm" data-act="social-dry-run" data-id="' + esc(dryId)
    + '" data-source="' + esc(candidate.source) + '" data-topic="' + esc(candidate.topic || '')
    + '" data-text="' + esc(candidate.text) + '">如果现在发会怎样</button>'
    + sendButtons
    + cancelButton
    + '</div>'
    + (dryId ? '<div class="send-out" data-send-out="' + esc(dryId) + '"></div>' : '')
    + '</div>'
}

/**
 * 来源实现状态：已实现几类、还缺哪几类、缺的那类缺什么数据。
 *
 * 全部由 `social.sourceStates` 生成，页面不写死任何一个数字——
 * 「三类还没实现」这种句子一旦写死，代码补齐后它会开始撒谎，
 * 而且没人会记得回来改它。
 */
function sourceStatusBlock(social) {
  const implemented = Array.isArray(social.implementedSources) ? social.implementedSources : []
  const pending = Array.isArray(social.pendingSources) ? social.pendingSources : []
  const states = social.sourceStates && typeof social.sourceStates === 'object' ? social.sourceStates : {}
  const labelOf = (source) => SOURCE_LABELS[source] || String(source)
  const doneChips = implemented.map((source) => {
    const evidence = states[source] && states[source].evidence ? String(states[source].evidence) : '依据未标注'
    return '<span class="chip ok" title="依据：' + esc(evidence) + '">' + esc(labelOf(source)) + '</span>'
  }).join('')
  const missingChips = pending.map((source) => {
    const missing = states[source] && states[source].missing ? String(states[source].missing) : '缺依据（原因未标注）'
    return '<span class="chip bad" title="' + esc(missing) + '">' + esc(labelOf(source)) + '：仍缺依据</span>'
  }).join('')
  return '<div class="social-meta">'
    + '<span>来源实现 <b>' + esc(String(implemented.length)) + ' / ' + esc(String(implemented.length + pending.length)) + '</b></span>'
    + doneChips + missingChips
    + '</div>'
    + (pending.length
      ? '<div class="note-inline">' + pending.map((source) => esc(labelOf(source)) + '没做，缺的是：'
        + esc(states[source] && states[source].missing ? String(states[source].missing) : '依据（原因未标注）')).join('；')
        + '</div>'
      : '')
}

/** 主动社交整块。 */
function socialPanel(social) {
  if (!social || social.available !== true) {
    return '<div class="empty"><strong>主动社交预演不可用</strong>'
      + '<span>' + esc(social && social.message ? social.message : 'persona.social.preview() 这次没跑起来。')
      + '没有预演数据时不要判断「它不想说话」——这是「算不出来」。</span></div>'
  }
  const sw = social.switches || {}
  const implementedSources = Array.isArray(social.implementedSources) ? social.implementedSources : []
  const pendingSources = Array.isArray(social.pendingSources) ? social.pendingSources : []
  // 这里原来还有一排「全局暂停 / 主动社交 / 允许外发」的开关，跟页头那排是**同一份数据**
  // 的两个快照（v.gate 与 social.switches），点哪个都是同一次写入，会互相覆盖——
  // 逻辑上没冲突，但两排一模一样地摆着会读成「上面管全局、下面管候选」，那是误导。
  // 所以这里只留卡片专属的结论：按当前开关，真发这条会不会被拦。
  const switchLine = '<div class="gate-note">'
    + '<span class="chip ' + (sw.wouldBlockRealSend ? 'bad' : 'ok') + '">真发会被拦：'
    + esc(sw.wouldBlockRealSend ? (sw.denied === null || sw.denied === undefined ? '允许外发未开' : String(sw.denied)) : '不会') + '</span>'
    + '<span class="chip plain">三个开关在页面上方那一排，改那里就够</span>'
    + '</div>'

  const wouldSay = Array.isArray(social.wouldSay) && social.wouldSay.length
    ? '<div class="would-say-box"><div class="would-say-head">如果开关全开，它本来会发这些</div>'
      + social.wouldSay.map((candidate) => socialCard(candidate, { highlight: true })).join('')
      + '</div>'
    : '<div class="empty"><strong>现在没有一条「本来会发」的候选</strong>'
      + '<span>可能是被硬闸拦住（深夜/刚发过/精力低/没证据），也可能是开关没开。'
      + '下面的新鲜候选里能看到每一条被拦在哪一道。</span></div>'

  const fresh = Array.isArray(social.fresh) && social.fresh.length
    ? social.fresh.map((candidate) => socialCard(candidate, {})).join('')
    : '<div class="empty"><strong>没有新鲜候选</strong>'
      + '<span>已实现的 ' + esc(String(implementedSources.length)) + ' 类来源这次都没有可用依据'
      + (pendingSources.length
        ? '，' + pendingSources.map((source) => esc(SOURCE_LABELS[source] || source)).join('、') + ' 仍缺机器可读的来源'
        : '')
      + '。每一类为什么没产，看下面「没做的来源」——「没有候选」是诚实状态，不是故障。</span></div>'

  // 候选分组（2026-11-02）：原来今天落表的候选全平铺，实测 25 条里 14 条是已经
  // rejected 的死候选——它们拿不到任何操作按钮，只负责把页面拉长半屏。
  // 现在只把「等你处理的」直接列出来，已结束的折进 <details> 默认收起。
  const PENDING_STATUSES = ['awaiting_approval', 'scheduled']
  const persistedAll = Array.isArray(social.persistedToday) ? social.persistedToday : []
  const persistedActive = persistedAll.filter((candidate) => PENDING_STATUSES.includes(String(candidate.status)))
  const persistedClosed = persistedAll.filter((candidate) => !PENDING_STATUSES.includes(String(candidate.status)))
  const persisted = persistedAll.length
    ? '<div class="sub-block"><div class="sub-title">今天已落表的候选'
      + '（共 ' + esc(String(persistedAll.length)) + ' 条，' + esc(String(persistedActive.length)) + ' 条等你处理）</div>'
      + (persistedActive.length
        ? persistedActive.map((candidate) => socialCard(candidate, {})).join('')
        : '<div class="empty"><strong>没有等你处理的候选</strong>'
          + '<span>今天落表的候选都已结束（被拒 / 已取消 / 已发出）。要回看就展开下面那块。</span></div>')
      + (persistedClosed.length
        ? '<details class="closed-list"><summary>已结束的候选 ' + esc(String(persistedClosed.length))
          + ' 条（展开看）</summary>'
          + persistedClosed.map((candidate) => socialCard(candidate, {})).join('')
          + '</details>'
        : '')
      + '</div>'
    : ''

  const sends = Array.isArray(social.sendsToday) && social.sendsToday.length
    ? '<div class="sub-block"><div class="sub-title">今天发过的动作（默认全是演算）</div>'
      + '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>时间</th><th>模式</th><th>结果</th><th>来源</th><th>内容</th></tr></thead><tbody>'
      + social.sendsToday.map((send) => '<tr>'
        + '<td class="when">' + esc(fmtWhen(send.at)) + '</td>'
        + '<td><span class="chip">' + esc(dash(send.mode)) + '</span></td>'
        + '<td>' + (send.ok ? '<span class="chip ok">成功</span>' : '<span class="chip bad">失败</span>') + '</td>'
        + '<td class="muted">' + esc(SOURCE_LABELS[send.source] || dash(send.source)) + '</td>'
        + '<td class="title">' + esc(dash(send.text)) + '</td>'
        + '</tr>').join('')
      + '</tbody></table></div></div>'
    : ''

  const counts = social.counts || {}
  const policy = social.policy && typeof social.policy === 'object' ? social.policy : null
  const policyLine = '<div class="social-meta">'
    + '<span>今日已批准 <b>' + esc(num(counts.approvedToday)) + '</b></span>'
    + '<span>待批准 <b>' + esc(num(counts.pending)) + '</b></span>'
    + '<span>今日发送记录 <b>' + esc(num(counts.sendsToday)) + '</b></span>'
    + '</div>'
    + (policy ? policyEditor(policy) : '')
    + channelEditor()
    + socialAutoEditor()

  const skipped = Array.isArray(social.skipped) && social.skipped.length
    ? '<div class="skip">没做的来源：' + social.skipped.map((item) => {
      const reason = String(item.reason == null ? '–' : item.reason)
      // chip 里只放一句能扫过去的摘要；完整原因（有些要讲清缺哪张表）挂在 title 上，
      // 不然「好奇」那一条能把整行撑成一段话。
      const short = reason.length > 64 ? reason.slice(0, 62) + '…' : reason
      const detail = item.detail == null ? reason : String(item.detail)
      return '<span class="chip" title="' + esc(detail) + '">'
        + esc(SOURCE_LABELS[item.source] || flat(item.source)) + '：' + esc(short) + '</span>'
    }).join('') + '</div>'
    : ''

  return switchLine + sourceStatusBlock(social) + policyLine + wouldSay
    + '<div class="sub-block"><div class="sub-title">新鲜候选（每条都带评分拆解与闸门）</div>' + fresh + '</div>'
    + persisted + sends + skipped
    + '<div class="note-inline">' + esc(dash(social.note)) + '</div>'
}

/** 人格版本卡。 */
function versionPanel(version, profiles, versions) {
  if (!version) {
    return '<div class="empty"><strong>没有激活的人格版本</strong>'
      + '<span>' + (profiles.length
        ? '有 ' + profiles.length + ' 份档案（' + profiles.map((p) => p.name).join(' / ') + '），但都没有激活版本。'
          + '人格不会自动生效：导入之后还要显式激活一版。'
        : '还没有导入过人格文件。人格本体在 ~/.dsh/AGENTS.md，Brain 只解析与缓存，不回写。')
      + '</span></div>'
  }
  return '<div class="ver-bar">'
    + '<span class="chip ok">v' + esc(num(version.version)) + '</span>'
    + '<span class="chip">' + esc(version.status) + '</span>'
    + '<span class="chip">档案 ' + esc(version.profileId) + '</span>'
    + '<span class="chip">激活于 ' + esc(fmtWhen(version.activatedAt)) + '</span>'
    + '<span class="chip">Token≈' + esc(num(version.tokenEstimate)) + '</span>'
    + '</div>'
    + (version.changeReason ? '<div class="social-meta"><span>变更原因 <b>' + esc(version.changeReason) + '</b></span></div>' : '')
    + (version.sourceHash ? '<div class="social-meta"><span>内容哈希 <b>' + esc(String(version.sourceHash).slice(0, 16)) + '</b></span></div>' : '')
    + '<div class="sub-title" style="margin-top:14px">五层内容（页面只读，改人格请改文件）</div>'
    + layersBlock(version.layers)
    + (versions.length > 1 ? '<div class="social-meta" style="margin-top:10px"><span>档案内共 <b>' + esc(String(versions.length)) + '</b> 个版本（新→旧）</span></div>' : '')
}

/** 冲突列表：keep_old / keep_new 都必须人来点。 */
function conflictsPanel(conflicts) {
  if (!conflicts.length) {
    return '<div class="empty"><strong>没有待裁决的冲突</strong>'
      + '<span>人格合并时如果出现身份/边界/风格冲突，会在这里列出来。'
      + '身份、边界、矛盾三类**永远不自动消解**——自动选边等于替主人下结论。</span></div>'
  }
  return conflicts.map((conflict) => {
    const resolved = conflict.resolution !== 'unresolved'
    return '<div class="conflict">'
      + '<div class="conflict-top">'
      + '<span class="chip accent">' + esc(CONFLICT_KIND_LABELS[conflict.kind] || conflict.kind) + '</span>'
      + '<span class="conflict-field">' + esc(conflict.layer + '.' + conflict.field) + '</span>'
      + '<span class="chip ' + (resolved ? 'ok' : 'bad') + '">'
      + esc(CONFLICT_RESOLUTION_LABELS[conflict.resolution] || conflict.resolution) + '</span>'
      + '</div>'
      + '<div class="conflict-diff">'
      + '<div><span class="diff-k">旧</span>' + esc(dash(conflict.oldValue)) + '</div>'
      + '<div><span class="diff-k">新</span>' + esc(dash(conflict.newValue)) + '</div>'
      + '</div>'
      + (resolved ? '' : '<div class="social-actions">'
        + '<button class="btn btn--sm" data-act="conflict-keep-old" data-id="' + esc(conflict.id)
        + '" data-confirm="保留旧值 ' + esc(conflict.field) + '">保留旧值</button>'
        + '<button class="btn btn--sm" data-act="conflict-keep-new" data-id="' + esc(conflict.id)
        + '" data-confirm="采用新值 ' + esc(conflict.field) + '">采用新值</button>'
        + '</div>')
      + '</div>'
  }).join('')
}

/** 关系四维：条形图，0..1。 */
function relationshipPanel(relationship) {
  if (!relationship) {
    return '<div class="empty"><strong>还没有关系记录</strong>'
      + '<span>新用户从 0.1 起步，而且要真的发生过互动才会有变化。'
      + '「读不到」不是「四维全 0」——这两个在界面上必须能分开。</span></div>'
  }
  return '<div class="rel">' + DIMENSIONS.map((dimension) => {
    const value = Number(relationship[dimension.key])
    const shown = Number.isFinite(value) ? value : null
    const pct = shown === null ? 0 : Math.max(0, Math.min(100, shown * 100))
    return '<div class="rel-row">'
      + '<div class="rel-head"><span class="rel-label">' + esc(dimension.label) + '</span>'
      + '<span class="rel-value">' + esc(shown === null ? '–' : shown.toFixed(2)) + '</span></div>'
      + '<div class="rel-bar"><span style="width:' + esc(String(pct.toFixed(1))) + '%"></span></div>'
      + '<div class="rel-hint">' + esc(dimension.hint) + '</div>'
      + '</div>'
  }).join('') + '</div>'
}

/** 回复五态占比。 */
function decisionsPanel(stats) {
  if (!stats || !stats.byDecision || typeof stats.byDecision !== 'object') {
    return '<div class="empty"><strong>回复决策统计读不到</strong><span>这一格不编 0。</span></div>'
  }
  const total = Number(stats.total) || 0
  const keys = Object.keys(DECISION_LABELS)
  const rows = keys.map((key) => {
    const count = Number(stats.byDecision[key]) || 0
    const pct = total > 0 ? (count / total) * 100 : 0
    return '<div class="dec-row">'
      + '<span class="dec-label">' + esc(DECISION_LABELS[key]) + '</span>'
      + '<div class="dec-bar"><span class="dec-' + esc(key) + '" style="width:' + esc(pct.toFixed(1)) + '%"></span></div>'
      + '<span class="dec-count">' + esc(String(count)) + '</span>'
      + '</div>'
  }).join('')
  return '<div class="dec">' + rows + '</div>'
    + '<div class="social-meta" style="margin-top:10px">'
    + '<span>窗口 <b>' + esc(num(stats.days)) + '</b> 天</span>'
    + '<span>合计 <b>' + esc(num(stats.total)) + '</b> 条</span>'
    + '<span>保护类被沉默 <b>' + esc(num(stats.protectedSilent)) + '</b> 条'
    + (Number(stats.protectedSilent) === 0 ? '（这个数必须恒为 0）' : '（不为 0 就是 bug）') + '</span>'
    + '</div>'
}

/**
 * 把异常翻成人能判断的一句话。
 * `no such table` 是首启最常见的一种：库还在 0007 时页面必须说「表还没建」，
 * 而不是让「没有候选」看起来像「它今天不想说话」。
 */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const missing = /no such table:\s*([A-Za-z0-9_]+)/.exec(message)
  if (missing) return missing[1] + ' 表不存在（0008 迁移未应用？）'
  return message
}

/**
 * 收集人格视图（同步）。
 *
 * @param {any} brain
 * @param {{ scopeId: string, personId?: string, days?: number }} opts
 */
export function collectPersonaView(brain, opts) {
  const scopeId = String(opts && opts.scopeId ? opts.scopeId : '')
  const personId = String(opts && opts.personId ? opts.personId : 'owner')
  const days = Math.min(Math.max(Number(opts && opts.days) || 7, 1), 90)
  const persona = brain && brain.persona
  if (!persona) {
    return {
      unavailable: '人格门面（brain.persona）还没接线：openBrain 里没构造 createPersona。'
        + '这页先只显示空壳，**不要**把「看不到」当成「没有主动社交」。',
      scopeId,
      personId,
      gate: null,
      profiles: [],
      activeVersion: null,
      versions: [],
      conflicts: [],
      relationship: null,
      social: { available: false, message: '门面未接线' },
      responseStats: null,
      errors: [],
      schemaHint: null,
      at: new Date().toISOString(),
    }
  }

  /** @type {string[]} */
  const errors = []
  const safe = (fn, fallback) => {
    try {
      return fn()
    } catch (error) {
      errors.push(describeError(error))
      return fallback
    }
  }

  const gate = safe(() => persona.gate(), null)
  const profilesList = safe(() => persona.profiles.list({ limit: 20 }), { items: [] })
  const profiles = ((profilesList && profilesList.items) || []).map((item) => ({
    id: String(item.id),
    name: String(item.name),
    sourceType: String(item.sourceType),
    isDefault: item.isDefault === true,
    status: String(item.status),
    updatedAt: item.updatedAt == null ? null : String(item.updatedAt),
  }))
  const profile = profiles.find((item) => item.isDefault) || profiles[0] || null

  const versionsList = profile
    ? safe(() => persona.versions.list({ profileId: profile.id, limit: 20 }), { items: [] })
    : { items: [] }
  const versions = ((versionsList && versionsList.items) || []).map((item) => ({
    id: String(item.id),
    version: Number(item.version),
    status: String(item.status),
    activatedAt: item.activatedAt == null ? null : String(item.activatedAt),
  }))
  const activeRaw = profile ? safe(() => persona.versions.getActive({ profileId: profile.id }), null) : null
  const activeVersion = activeRaw
    ? {
      id: String(activeRaw.id),
      profileId: String(activeRaw.profileId),
      version: Number(activeRaw.version),
      status: String(activeRaw.status),
      layers: activeRaw.layers && typeof activeRaw.layers === 'object' ? activeRaw.layers : null,
      tokenEstimate: activeRaw.tokenEstimate,
      changeReason: activeRaw.changeReason == null ? null : String(activeRaw.changeReason),
      sourceHash: activeRaw.sourceHash == null ? null : String(activeRaw.sourceHash),
      activatedAt: activeRaw.activatedAt == null ? null : String(activeRaw.activatedAt),
    }
    : null

  const conflictsRaw = profile
    ? safe(() => persona.versions.listConflicts({ profileId: profile.id, limit: 100 }), { items: [] })
    : { items: [] }
  const conflicts = ((conflictsRaw && conflictsRaw.items) || []).map((item) => ({
    id: String(item.id),
    layer: String(item.layer),
    field: String(item.field),
    kind: String(item.kind),
    oldValue: item.oldValue == null ? null : String(item.oldValue),
    newValue: item.newValue == null ? null : String(item.newValue),
    resolution: String(item.resolution),
  }))

  const relationshipRaw = safe(() => persona.relationships.getState({ personId }), null)
  const relationship = relationshipRaw
    ? {
      familiarity: Number(relationshipRaw.familiarity),
      trust: Number(relationshipRaw.trust),
      intimacy: Number(relationshipRaw.intimacy),
      rapport: Number(relationshipRaw.rapport),
    }
    : null

  // preview 是唯一允许的「本来会说什么」入口：只读、开关全关也能跑、不写业务行。
  const previewRaw = safe(() => persona.social.preview({ personId, limit: 20 }), null)
  const social = previewRaw && typeof previewRaw === 'object'
    ? {
      available: true,
      at: previewRaw.at || null,
      switches: previewRaw.switches || null,
      policy: previewRaw.policy || null,
      selfState: previewRaw.selfState || null,
      counts: previewRaw.counts || null,
      wouldSay: normalizeCandidates(previewRaw.wouldSay),
      fresh: normalizeCandidates(previewRaw.fresh),
      persistedToday: normalizeCandidates(previewRaw.persistedToday),
      sendsToday: Array.isArray(previewRaw.sendsToday)
        ? previewRaw.sendsToday.map((send) => ({
          mode: send.mode == null ? null : String(send.mode),
          ok: send.ok === true,
          at: send.at == null ? null : String(send.at),
          topic: send.topic == null ? null : String(send.topic),
          source: send.source == null ? null : String(send.source),
          text: send.text == null ? null : String(send.text),
        }))
        : [],
      skipped: Array.isArray(previewRaw.skipped)
        ? previewRaw.skipped.map((item) => ({
          source: item && item.source != null ? String(item.source) : null,
          reason: item && item.reason != null ? String(item.reason) : null,
          // 「缺什么数据」比「没做」有用得多：页面把 detail 完整显示，reason 只留摘要。
          detail: item && item.detail != null ? String(item.detail) : null,
        }))
        : [],
      pendingSources: Array.isArray(previewRaw.pendingSources) ? previewRaw.pendingSources.map(String) : [],
      implementedSources: Array.isArray(previewRaw.implementedSources) ? previewRaw.implementedSources.map(String) : [],
      // 来源状态表整块拷成普通对象：它是 `Object.freeze` 的常量，
      // 但页面要按字段渲染（证据来自哪张表 / 没实现缺什么），逐字段摊平更好读。
      sourceStates: previewRaw.sourceStates && typeof previewRaw.sourceStates === 'object'
        ? Object.fromEntries(Object.keys(previewRaw.sourceStates).map((key) => {
          const state = previewRaw.sourceStates[key] && typeof previewRaw.sourceStates[key] === 'object'
            ? previewRaw.sourceStates[key]
            : {}
          return [key, {
            implemented: state.implemented === true,
            evidence: state.evidence == null ? null : String(state.evidence),
            missing: state.missing == null ? null : String(state.missing),
          }]
        }))
        : {},
      note: previewRaw.note == null ? null : String(previewRaw.note),
    }
    : { available: false, message: 'persona.social.preview() 返回空（门面在，但预演没跑起来）' }

  const responseStatsRaw = safe(() => persona.response.stats({ days }), null)
  const responseStats = responseStatsRaw
    ? {
      days: Number(responseStatsRaw.days),
      byDecision: responseStatsRaw.byDecision && typeof responseStatsRaw.byDecision === 'object'
        ? { ...responseStatsRaw.byDecision }
        : null,
      total: Number(responseStatsRaw.total),
      protectedSilent: Number(responseStatsRaw.protectedSilent),
    }
    : null

  return {
    unavailable: null,
    scopeId,
    personId,
    gate,
    profiles,
    activeVersion,
    versions,
    conflicts,
    relationship,
    social,
    responseStats,
    errors,
    // 表不存在 ≠ 没有候选：页面顶部必须说清楚，否则「没有候选」会被读成「它不想说话」。
    schemaHint: errors.some((message) => message.includes('0008'))
      ? '数据库还没升到 0008：人格与社交的几张表（persona_versions / social_candidates / relationship_states 等）还没建。'
        + '「没有候选、没有关系记录」在这里等于「还读不到」，不是真实的社交状态；迁移跑完后刷新本页。'
      : null,
    at: new Date().toISOString(),
  }
}

/**
 * 把 preview 返回的候选规整成页面用的形状。
 * 拆解字段通过 `scoreBreakdown` 传进来（fresh 是 `scoreBreakdown`，落表候选也是）。
 *
 * @param {any} list
 */
function normalizeCandidates(list) {
  if (!Array.isArray(list)) return []
  return list.map((item) => {
    const breakdown = item && item.scoreBreakdown && typeof item.scoreBreakdown === 'object'
      ? item.scoreBreakdown
      : (item && item.breakdown && typeof item.breakdown === 'object' ? item.breakdown : null)
    return {
      id: item && item.id != null ? String(item.id) : '',
      persisted: !!(item && item.persisted),
      source: item && item.source != null ? String(item.source) : 'unknown',
      topic: item && item.topic != null ? String(item.topic) : null,
      text: item && item.text != null ? String(item.text) : '',
      evidenceCount: Array.isArray(item && item.evidence) ? item.evidence.length : 0,
      score: Number(item && item.score) || 0,
      breakdown: breakdown
        ? {
          formula: breakdown.formula == null ? null : String(breakdown.formula),
          components: breakdown.components && typeof breakdown.components === 'object' ? breakdown.components : {},
          gates: Array.isArray(breakdown.gates) ? breakdown.gates : [],
          threshold: breakdown.threshold,
        }
        : null,
      wouldSend: !!(item && item.wouldSend),
      blockedBy: item && item.blockedBy != null ? String(item.blockedBy) : null,
      status: item && item.status != null ? String(item.status) : null,
      reason: item && item.reason != null ? String(item.reason) : null,
      expiresAt: item && item.expiresAt != null ? String(item.expiresAt) : null,
    }
  })
}

/**
 * 渲染人格页。
 *
 * @param {{ scopeId?: string, personId?: string, view?: ReturnType<typeof collectPersonaView> }} [opts]
 * @returns {string}
 */
export function renderPersonaPage(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const view = o.view && typeof o.view === 'object' ? o.view : null
  const scopeId = String(o.scopeId == null ? (view ? view.scopeId : '') : o.scopeId)
  const personId = String(o.personId == null ? (view ? view.personId : 'owner') : o.personId)
  const v = view || {
    unavailable: '页面没拿到数据（collectPersonaView 没有调用）。',
    scopeId,
    personId,
    gate: null,
    profiles: [],
    activeVersion: null,
    versions: [],
    conflicts: [],
    relationship: null,
    social: { available: false, message: '没有视图数据' },
    responseStats: null,
    errors: [],
  }
  const gate = v.gate && typeof v.gate === 'object' ? v.gate : null
  const unavailableBox = v.unavailable
    ? '<div class="diag warn"><b>门面未接线</b><br>' + esc(v.unavailable) + '</div>'
    : ''
  const errorsBox = Array.isArray(v.errors) && v.errors.length
    ? '<div class="diag warn"><b>读取时有 ' + esc(String(v.errors.length)) + ' 处失败</b>：'
      + esc(v.errors.join('；')) + '（缺的部分显示为「–」）</div>'
    : ''
  const schemaBox = v.schemaHint
    ? '<div class="diag warn"><b>库版本落后</b><br>' + esc(v.schemaHint) + '</div>'
    : ''
  const gateLine = gate
    ? switchBar([
        { name: 'paused', label: '全局暂停', on: gate.paused === true, hint: '最高优先级：暂停后所有自主模块停手' },
        { name: 'social.enabled', label: '主动社交', on: gate.socialEnabled === true, hint: '关掉后不再生成候选、也不发送' },
        { name: 'social.allow_external', label: '允许外发', on: gate.allowExternal === true, hint: '关掉后只能 dry_run，批准也不会真发' },
      ])
      + '<div class="gate-note">'
      + '<span class="chip ' + (gate.canExternal ? 'ok' : 'bad') + '">外发能力 '
      + (gate.canExternal ? '有（已配置的聊天通道）' : '无（只会 dry_run）') + '</span>'
      + (gate.denied ? '<span class="chip bad">当前被拒绝：' + esc(String(gate.denied)) + '</span>' : '')
      + '<span class="chip plain">总闸：三个开关改一次就对所有自主模块生效</span>'
      + '</div>'
    : '<div class="diag warn">开关快照读不到：gate() 没返回。不要据此判断「全是关的」。</div>'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 人格与主动社交</title>
<style>
/* ══ THEME:BEGIN ══ */
:root{
  color-scheme:light;
  --paper:#f2f4f7; --card:#ffffff; --card-2:#f7f8fa; --raise:#edf0f5;
  --ink:#1a2332; --ink-2:#3d4a5c; --muted:#68788e; --faint:#98a5b7;
  --line:#e4e8ef; --line-soft:rgba(25,42,68,.07);
  --accent:#3b5bdb; --accent-2:#7048e8;
  --accent-line:rgba(59,91,219,.40); --accent-soft:rgba(59,91,219,.09);
  --ochre:var(--accent); --ochre-soft:var(--accent-soft);
  --ok:#2f9e63;   --ok-soft:rgba(47,158,99,.11);
  --warn:#dd7f0e; --warn-soft:rgba(221,127,14,.11);
  --bad:#d64545;  --bad-soft:rgba(214,69,69,.09);
  --slate:#8296ad; --violet:#8a6fd6;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;
  --r:12px; --r-sm:7px;
  --ease:cubic-bezier(.2,0,0,1);
  --ease-out:cubic-bezier(.16,1,.3,1);
  --ease-soft:cubic-bezier(.4,0,.2,1);
  --dur-fast:.16s; --dur-normal:.28s; --dur-slow:.6s;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.65 var(--sans);
  letter-spacing:.005em;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;
  text-rendering:optimizeLegibility}
body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:linear-gradient(to right,rgba(59,91,219,.040) 1px,transparent 1px),
    linear-gradient(to bottom,rgba(59,91,219,.040) 1px,transparent 1px);
  background-size:56px 56px;
  -webkit-mask-image:radial-gradient(ellipse 115% 75% at 50% 0%,#000,transparent 74%);
  mask-image:radial-gradient(ellipse 115% 75% at 50% 0%,#000,transparent 74%)}
body::after{content:"";position:fixed;inset:0 0 auto 0;height:400px;z-index:0;pointer-events:none;
  background:radial-gradient(ellipse 70% 100% at 50% -24%,rgba(255,255,255,.9),transparent 70%)}
body.sea-mode::before,body.sea-mode::after{display:none}
::selection{background:rgba(59,91,219,.16);color:var(--ink)}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
code{font-family:var(--mono);font-size:.92em;background:var(--raise);color:var(--ink-2);
  padding:1px 5px;border-radius:4px}
b,strong{font-weight:620;color:var(--ink)}
em{font-style:normal;color:var(--accent)}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}
*{scrollbar-width:thin;scrollbar-color:#d3dae4 transparent}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#d3dae4;border-radius:8px;border:3px solid var(--paper)}
::-webkit-scrollbar-thumb:hover{background:#b9c3d2}
:focus-visible{outline:1.5px solid var(--accent-line);outline-offset:2px;border-radius:3px}
.wrap{position:relative;z-index:1;width:min(100%,1240px);margin:0 auto;
  padding:24px clamp(20px,3.5vw,44px) 76px}
.wrap.wrap--wide{width:min(100%,1360px)}
.brandbar{display:flex;align-items:center;gap:12px;min-height:54px;padding-bottom:16px;
  border-bottom:1px solid var(--line-soft);font-family:var(--mono)}
.brandmark{position:relative;width:30px;height:30px;display:grid;place-items:center;flex:none}
.brandmark::before,.brandmark::after{content:"";position:absolute;inset:2px;
  border:1.5px solid var(--accent-line);transform:rotate(45deg);border-radius:2px}
.brandmark::before{animation:brand-spin 12s linear infinite;transform-origin:50% 50%}
.brandmark::after{inset:8px;border-color:var(--accent)}
.brandmark i{width:4px;height:4px;border-radius:50%;background:var(--accent)}
@keyframes brand-spin{to{transform:rotate(405deg)}}
.brandname{font-size:.76rem;font-weight:650;letter-spacing:.22em;color:var(--ink)}
.brandname small{display:block;font-size:.5rem;font-weight:500;letter-spacing:.3em;
  color:var(--muted);margin-top:1px}
.system-state{display:flex;align-items:center;gap:8px;margin-left:auto;height:28px;padding:0 10px;
  border:1px solid var(--line);border-radius:999px;background:var(--card);
  font-size:9px;letter-spacing:.14em;color:var(--muted)}
.system-state b{font-weight:500;color:var(--ok)}
.system-state .lamp{width:5px;height:5px;box-shadow:0 0 0 3px var(--ok-soft)}
.head{display:grid;grid-template-columns:minmax(0,auto) minmax(280px,1fr);gap:8px 34px;
  margin-top:30px}
.head-kicker{grid-column:1/-1;font:500 .58rem/1.2 var(--mono);letter-spacing:.24em;
  color:var(--accent);opacity:.9}
h1{display:flex;align-items:center;gap:10px;margin:0;
  font-size:clamp(2rem,3vw,2.55rem);font-weight:640;letter-spacing:-.045em;line-height:1.08}
h1::before{content:"";width:3px;height:.72em;border-radius:2px;flex:none;
  background:linear-gradient(var(--accent),rgba(59,91,219,.25))}
.head>.sub{justify-self:end;text-align:right;max-width:46ch;padding-bottom:5px;
  font-size:.82rem;line-height:1.65;color:var(--muted)}
.nav{position:sticky;top:12px;z-index:10;grid-column:1/-1;
  display:flex;flex-wrap:nowrap;gap:4px;align-items:center;margin-top:24px;padding:6px;
  border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.86);
  backdrop-filter:blur(16px);box-shadow:0 4px 18px rgba(23,32,60,.05);
  overflow-x:auto;scrollbar-width:none}
.nav::-webkit-scrollbar{display:none}
.navlink{position:relative;flex:0 0 auto;min-height:38px;display:grid;place-items:center;
  padding:0 12px;border:1px solid transparent;border-radius:7px;background:transparent;
  font-size:.76rem;letter-spacing:.04em;color:var(--muted);text-decoration:none;
  white-space:nowrap;cursor:pointer;
  transition:color var(--dur-fast) var(--ease-soft),background var(--dur-fast),
    border-color var(--dur-fast),transform var(--dur-fast) var(--ease-out)}
.navlink:hover{transform:translateY(-1px);background:var(--raise);color:var(--ink);
  text-decoration:none}
.navlink:active{transform:translateY(1px)}
.navlink.active{border-color:var(--accent-line);
  background:linear-gradient(180deg,rgba(59,91,219,.11),rgba(59,91,219,.045));
  color:var(--accent);font-weight:560}
.navlink.active:hover{background:linear-gradient(180deg,rgba(59,91,219,.13),rgba(59,91,219,.06));
  color:var(--accent)}
.navlink::after{content:"";position:absolute;left:28%;right:28%;bottom:4px;height:2px;
  border-radius:1px;background:var(--accent);transform:scaleX(0);transform-origin:center;
  transition:transform var(--dur-normal) var(--ease-out)}
.navlink.active::after{transform:scaleX(1)}
.path{display:flex;align-items:center;gap:8px;margin:16px 0 24px;
  font-family:var(--mono);font-size:10px;color:var(--faint);letter-spacing:.035em;
  word-break:break-all}
.path::before{content:"PATH";flex:none;font-size:8px;letter-spacing:.15em;color:var(--accent);
  border:1px solid var(--accent-line);padding:1px 5px;border-radius:3px;
  background:var(--accent-soft)}
.path::after{content:"";flex:1;height:1px;margin-left:6px;
  background:linear-gradient(90deg,var(--line),var(--line-soft) 55%,transparent 88%)}
.view{display:none}
.view.active{display:block;animation:view-in .36s var(--ease)}
@keyframes view-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
.view.active>*{animation:rise-in .46s var(--ease-out) both}
.view.active>*:nth-child(2){animation-delay:45ms}.view.active>*:nth-child(3){animation-delay:90ms}
.view.active>*:nth-child(4){animation-delay:135ms}.view.active>*:nth-child(5){animation-delay:180ms}
.view.active>*:nth-child(6){animation-delay:225ms}
.view.active>*:nth-child(n+7){animation-delay:270ms}
@keyframes rise-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
.stats{display:flex;flex-wrap:wrap;padding:0;margin-bottom:18px;overflow:hidden;
  background:var(--card);border:1px solid var(--line);border-radius:var(--r);
  box-shadow:0 1px 2px rgba(23,32,60,.04)}
.stat{display:flex;flex-direction:column;gap:2px;padding:14px 22px;flex:1;min-width:112px;
  border-right:1px solid var(--line-soft)}
.stat:last-child{border-right:none}
.stat-k{font-size:10px;color:var(--muted);letter-spacing:.09em}
.stat-v{font-size:1.34rem;font-weight:600;font-family:var(--mono);
  font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:var(--ink);line-height:1.35}
.stat-v.ok{color:var(--ok)} .stat-v.warn{color:var(--warn)} .stat-v.bad{color:var(--bad)}
.stat-n{font-size:11px;color:var(--faint);line-height:1.6}
.stat--big .stat-v{font-size:2.15rem}
.searchbar{display:flex;gap:8px;align-items:center;margin:0 0 16px;padding:8px;
  border:1px solid var(--line);border-radius:12px;background:var(--card);
  box-shadow:0 1px 2px rgba(23,32,60,.04)}
.searchbar .input{flex:1;min-width:240px;border-color:transparent;background:var(--card-2)}
.input,.select{height:36px;padding:0 12px;border:1px solid var(--line);border-radius:var(--r-sm);
  background:var(--card);font:inherit;font-size:13px;color:var(--ink);outline:none;
  transition:border-color var(--dur-fast) var(--ease),box-shadow var(--dur-fast) var(--ease),
    background var(--dur-fast)}
.input::placeholder{color:var(--faint)}
.input:focus,.select:focus{border-color:var(--accent-line);background:var(--card);
  box-shadow:0 0 0 3px rgba(59,91,219,.12)}
.select{font-family:var(--mono);font-size:12px;padding:0 8px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;
  height:34px;padding:0 15px;border:1px solid var(--line);border-radius:var(--r-sm);
  background:var(--card);color:var(--ink-2);font:inherit;font-size:13px;cursor:pointer;
  white-space:nowrap;
  transition:transform var(--dur-fast) var(--ease-out),border-color var(--dur-fast),
    color var(--dur-fast),background var(--dur-fast),box-shadow var(--dur-fast)}
.btn:hover{transform:translateY(-1px);border-color:#c9d2e0;background:var(--raise);
  color:var(--ink)}
.btn:active{transform:translateY(0) scale(.975)}
.btn--primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;
  box-shadow:0 2px 8px rgba(59,91,219,.28)}
.btn--primary:hover{background:#334fc4;border-color:#334fc4;color:#fff;
  box-shadow:0 4px 14px rgba(59,91,219,.34)}
.btn--ghost{background:transparent;border-color:var(--line-soft)}
.btn--danger{border-color:var(--bad-soft);color:var(--bad)}
.btn--danger:hover{background:var(--bad-soft);border-color:var(--bad);color:var(--bad)}
.btn--sm{height:28px;padding:0 11px;font-size:12px;font-family:var(--mono)}
.btn[disabled]{opacity:.38;cursor:not-allowed;transform:none}
.panel{border:1px solid var(--line);border-radius:var(--r);background:var(--card);
  overflow:hidden;box-shadow:0 1px 2px rgba(23,32,60,.04)}
.panel+.panel{margin-top:16px}
.panel-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;
  padding:13px 18px;border-bottom:1px solid var(--line);background:var(--card-2)}
.panel-title{font-size:13px;font-weight:600;color:var(--ink);line-height:1.5}
.panel-meta{font-size:11px;color:var(--muted);margin-left:auto;font-family:var(--mono)}
.panel-body{padding:16px 18px}
.panel-foot{padding:10px 16px;border-top:1px solid var(--line-soft);font-size:11.5px;
  color:var(--muted);line-height:1.7}
.panel--quiet{background:transparent;border-style:dashed;box-shadow:none}
.split{display:grid;grid-template-columns:minmax(0,1.62fr) minmax(0,1fr);gap:20px;
  align-items:start}
.split--even{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}
.grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:start}
.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start}
.list{display:flex;flex-direction:column;overflow:hidden;
  border:1px solid var(--line);border-radius:var(--r);background:var(--card);
  box-shadow:0 1px 2px rgba(23,32,60,.04)}
.row{position:relative;padding:12px 18px 12px 20px;cursor:pointer;
  border-bottom:1px solid var(--line-soft);
  transition:background var(--dur-normal) var(--ease-soft)}
.row:last-child{border-bottom:none}
.row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;
  background:transparent;transition:background var(--dur-fast) var(--ease)}
.row:hover{background:var(--raise)}
.row:hover::before{background:var(--accent)}
.row.is-selected{background:var(--raise);box-shadow:inset 0 0 0 1px rgba(59,91,219,.10)}
.row.is-selected::before{background:var(--accent)}
.row-top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.row-title{font-size:13px;flex:1;min-width:0;color:var(--ink-2);line-height:1.6}
.row:hover .row-title,.row.is-selected .row-title{color:var(--ink)}
.row-id{font-family:var(--mono);font-size:10px;color:var(--faint);flex:none}
.list .row{animation:row-in .28s var(--ease-out) both}
.list .row:nth-child(2){animation-delay:24ms}.list .row:nth-child(3){animation-delay:48ms}
.list .row:nth-child(4){animation-delay:72ms}.list .row:nth-child(5){animation-delay:96ms}
.list .row:nth-child(6){animation-delay:120ms}.list .row:nth-child(7){animation-delay:144ms}
.list .row:nth-child(8){animation-delay:168ms}.list .row:nth-child(9){animation-delay:192ms}
.list .row:nth-child(n+10){animation-delay:216ms}
@keyframes row-in{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}
.chips{display:flex;gap:5px;flex-wrap:wrap}
.chip{font-size:10.5px;padding:1.5px 7px;border-radius:4px;white-space:nowrap;
  font-family:var(--mono);background:var(--raise);color:var(--muted)}
.chip.accent{background:var(--accent-soft);color:var(--accent)}
.chip.ok{background:var(--ok-soft);color:var(--ok)}
.chip.warn{background:var(--warn-soft);color:var(--warn)}
.chip.bad{background:var(--bad-soft);color:var(--bad)}
.chip.plain{background:transparent;color:var(--faint);box-shadow:inset 0 0 0 1px var(--line)}
.tags{display:flex;gap:4px 14px;flex-wrap:wrap;margin-top:5px;align-items:center}
.tag{font-size:10.5px;padding:0;color:var(--faint);font-family:var(--mono);
  letter-spacing:.01em;white-space:nowrap;line-height:1.7}
.tag.ok{color:var(--ok)}
.tag.bad{padding:0 5px;border-radius:3px;background:var(--bad-soft);color:var(--bad)}
.tag.accent{color:var(--accent)}
.note{font-size:12px;color:var(--muted);line-height:1.8;margin:0;
  padding:10px 14px;border-left:2px solid var(--line);border-radius:0 6px 6px 0;
  background:linear-gradient(90deg,rgba(59,91,219,.035),transparent 70%)}
.note.warn{border-left-color:var(--warn);background:var(--warn-soft);color:#9a5f0d}
.note.bad{border-left-color:var(--bad);background:var(--bad-soft);color:#a03c3c}
.note b{color:var(--ink)}
.kv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px 12px;margin:0;font-size:12px}
.kv dt{color:var(--muted)}
.kv dd{margin:0;color:var(--ink-2);font-family:var(--mono);font-size:11.5px;
  word-break:break-all;font-variant-numeric:tabular-nums}
.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.tbl th{text-align:left;font-weight:500;color:var(--muted);font-size:9.5px;
  letter-spacing:.08em;text-transform:uppercase;font-family:var(--mono);
  padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--line-soft);color:var(--ink-2);
  vertical-align:baseline}
.tbl tr:last-child td{border-bottom:none}
.tbl td.num{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;
  white-space:nowrap}
.tbl td.mono{font-family:var(--mono);font-size:11.5px;color:var(--faint)}
.tbl tbody tr{transition:background var(--dur-fast) var(--ease-soft)}
.tbl tbody tr:hover{background:rgba(59,91,219,.035)}
.empty{padding:44px 20px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}
.empty strong{display:block;color:var(--ink);font-size:13.5px;font-weight:600;margin-bottom:5px}
.empty span{display:block;max-width:540px;margin:0 auto}
.lamp{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block;vertical-align:1px}
.lamp.ok{background:var(--ok)} .lamp.warn{background:var(--warn)}
.lamp.bad{background:var(--bad)} .lamp.off{background:var(--faint)}
.bars{display:flex;align-items:flex-end;gap:6px;height:110px;padding-top:6px}
.bar{flex:1;min-width:8px;height:100%;display:flex;flex-direction:column;
  justify-content:flex-end;gap:2px}
.bar-i{background:linear-gradient(to top,rgba(59,91,219,.45),var(--accent));
  border-radius:2px 2px 0 0;min-height:2px}
.bar-i.zero{background:var(--line)}
.bar-x{font-family:var(--mono);font-size:9px;color:var(--faint);text-align:center;
  white-space:nowrap;overflow:hidden;height:12px}
.legend{display:flex;gap:14px;font-size:11px;color:var(--muted);margin-top:10px}
.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;
  vertical-align:0}
.rank{display:flex;align-items:baseline;gap:10px;padding:7px 0;
  border-bottom:1px solid var(--line-soft);font-size:12.5px}
.rank:last-child{border-bottom:none}
.rank-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
  color:var(--ink-2)}
.rank-n{font-family:var(--mono);font-size:11.5px;color:var(--muted);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.ev{display:flex;gap:14px;padding:11px 0;border-bottom:1px solid var(--line-soft)}
.ev:last-child{border-bottom:none}
.ev-when{font-family:var(--mono);font-size:11.5px;color:var(--faint);white-space:nowrap;
  min-width:86px;padding-top:2px;font-variant-numeric:tabular-nums}
.ev-main{flex:1;min-width:0}
.ev-label{font-size:13px;color:var(--ink);line-height:1.5}
.ev-note{font-size:12px;color:var(--muted);margin-top:2px;line-height:1.7}
.ev-delta{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.dl{font-family:var(--mono);font-size:10.5px;padding:1px 7px;border-radius:4px;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.dl.up{background:var(--ok-soft);color:var(--ok)}
.dl.down{background:var(--bad-soft);color:var(--bad)}
.switch-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}
.switch{display:flex;flex-direction:column;gap:6px;padding:14px 15px;
  border:1px solid var(--line);border-radius:var(--r);background:var(--card);
  transition:transform var(--dur-normal) var(--ease-out),border-color var(--dur-normal),
    box-shadow var(--dur-normal)}
.switch:hover{transform:translateY(-2px);border-color:rgba(59,91,219,.30);
  box-shadow:0 10px 26px rgba(23,32,60,.09)}
.switch-top{display:flex;align-items:baseline;gap:8px}
.switch-name{font-size:13px;color:var(--ink);font-weight:560;flex:1}
.switch-key{font-family:var(--mono);font-size:10.5px;color:var(--faint)}
.switch-desc{font-size:11.5px;color:var(--muted);line-height:1.7}
.switch-note{font-size:11px;color:var(--faint);line-height:1.7;
  border-left:2px solid var(--line-soft);padding-left:8px}
.switch .btn{align-self:flex-start;margin-top:2px}
.duo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0}
.duo-col{padding:14px 16px}
.duo-col+.duo-col{border-left:1px solid var(--line)}
.duo-h{font-size:11px;color:var(--muted);letter-spacing:.06em;margin-bottom:10px}
.allow{display:flex;flex-direction:column;gap:10px}
.allow-i{padding:10px 12px;border:1px solid var(--line-soft);border-radius:var(--r-sm);
  background:var(--card-2)}
.allow-t{font-size:12.5px;color:var(--accent);font-weight:560;margin-bottom:3px}
.allow-d{font-size:11.5px;color:var(--muted);line-height:1.7}
.allow-r{font-size:11px;color:var(--faint);line-height:1.7;margin-top:4px;
  border-top:1px solid var(--line-soft);padding-top:4px}
.forbid{display:flex;flex-direction:column;gap:9px;font-size:12px;color:var(--ink-2);
  line-height:1.75}
.forbid-i{display:flex;gap:9px}
.forbid-i::before{content:"";width:5px;height:5px;border-radius:1px;background:var(--bad);
  flex:none;margin-top:7px}
.budget{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}
.budget-top{display:flex;align-items:baseline;gap:8px;font-size:12px}
.budget-k{color:var(--muted);flex:1}
.budget-num{font-family:var(--mono);font-size:11.5px;color:var(--ink-2);
  font-variant-numeric:tabular-nums}
.budget-track{height:6px;border-radius:3px;background:var(--raise);overflow:hidden}
.budget-fill{height:100%;border-radius:3px;
  background:linear-gradient(90deg,var(--accent-2),var(--accent))}
.budget-fill.over{background:var(--bad)}
.vs{display:grid;grid-template-columns:minmax(0,1fr) 40px minmax(0,1fr);gap:0;
  align-items:stretch}
.vs-card{padding:14px 16px;border:1px solid var(--line);border-radius:var(--r);
  background:var(--card);display:flex;flex-direction:column;gap:8px}
.vs-mid{display:grid;place-items:center;color:var(--faint);font-size:15px}
.vs-side{font-size:10.5px;color:var(--faint);letter-spacing:.06em;font-family:var(--mono)}
.vs-body{font-size:12.5px;color:var(--ink-2);line-height:1.75}
.vs-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}
.foot{margin-top:48px;padding-top:22px;border-top:1px solid var(--line);
  display:flex;gap:16px;flex-wrap:wrap;align-items:center;
  font-family:var(--mono);font-size:9px;letter-spacing:.06em;color:var(--faint)}
.foot::before{content:"";width:5px;height:5px;background:var(--accent)}
@media(max-width:980px){
  .split,.split--even,.grid2,.grid3{grid-template-columns:minmax(0,1fr)}
}
@media(max-width:900px){
  .head{grid-template-columns:1fr}
  .head>.sub{justify-self:start;text-align:left;max-width:62ch}
  .nav{top:8px;margin-top:18px;overflow-x:auto;justify-content:flex-start;
    mask-image:linear-gradient(90deg,#000 82%,transparent 97%);
    -webkit-mask-image:linear-gradient(90deg,#000 82%,transparent 97%)}
  .navlink{flex:0 0 auto;min-width:64px}
  .switch-grid{grid-template-columns:minmax(0,1fr)}
  .duo{grid-template-columns:minmax(0,1fr)}
  .duo-col+.duo-col{border-left:none;border-top:1px solid var(--line)}
  .vs{grid-template-columns:minmax(0,1fr)}
  .vs-mid{display:none}
}
@media(max-width:800px){
  .wrap{padding:18px 16px 44px}
  .system-state span{display:none}
  .path{margin-bottom:16px}
}
@media(max-width:560px){
  .brandbar{min-height:48px;padding-bottom:14px}
  .brandname{font-size:.68rem}
  .system-state{font-size:8px}
  .head{margin-top:22px}
  .head-kicker{font-size:.54rem}
  h1{font-size:1.6rem}
  .path{margin:14px 0 18px}
  .searchbar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:stretch}
  .searchbar .input{grid-column:1/-1;min-width:0}
  .searchbar .btn{width:100%;min-height:42px}
  .stat{min-width:46%;padding:13px 16px}
  .stat:nth-child(2n){border-right:none}
  .stat-v{font-size:1.12rem}
  .panel-body{padding:16px}
}
@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;
    animation-iteration-count:1!important;transition-duration:.01ms!important;
    scroll-behavior:auto!important}
  .view.active>*{animation:none}
}
/* ══ THEME:END ══ */
/* ── 这一页自己的部分：诊断条 / 候选卡 / 评分拆解 / 通道表单 / 关系四维 / 决策五态 ──
   骨架与通用组件（面板、徽章、按钮、表格、说明、空态）在标记区里，这里不重复。 */

/* 诊断条：左缘一道 2px 状态线。整块换底色会跟面板抢层级，这里只标边缘。 */
.diag{margin:0 0 16px;padding:10px 14px;border-radius:var(--r-sm);font-size:13px;
  background:var(--card);border:1px solid var(--line);border-left:2px solid var(--line);
  line-height:1.6;box-shadow:0 1px 2px rgba(23,32,60,.04)}
.diag.warn{border-left-color:var(--warn);background:var(--warn-soft);color:#9a5f0d}
.diag.bad{border-left-color:var(--bad);background:var(--bad-soft);color:#a03c3c}

/* 顶部开关行：一排 chip。闸门 chip 说的是「这条候选过没过」，开关 chip 说的是「放不放行」。 */
.gate-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;align-items:center}
.gate{font-family:var(--mono);font-size:10.5px;padding:1.5px 7px;border-radius:4px;
  background:var(--raise);color:var(--muted);line-height:1.6;white-space:nowrap}
.gate.pass{background:var(--ok-soft);color:var(--ok)}
.gate.fail{background:var(--bad-soft);color:var(--bad)}

/* ── 开关条（2026-11-02 重做）──
   一排白面板，每格是「标签 + 拨杆 + 状态字」。
   拨杆的位置本身就是状态：左=关、右=开，看得出是能拨的东西，不用先猜哪里能点。
   关用灰、开用靛蓝；「全局暂停」是紧急闸，开着时转红。 */
.sw-bar{display:flex;flex-wrap:wrap;margin:0 0 9px;border:1px solid var(--line);
  border-radius:10px;background:var(--card);overflow:hidden;
  box-shadow:0 1px 2px rgba(23,32,60,.04)}
.sw{position:relative;display:flex;align-items:center;gap:12px;flex:1 1 176px;
  padding:12px 16px;border:none;border-right:1px solid var(--line-soft);
  background:transparent;font:inherit;cursor:pointer;text-align:left;
  transition:background var(--dur-fast) var(--ease-soft)}
.sw:last-child{border-right:none}
.sw:hover{background:var(--raise)}
.sw:focus-visible{outline:1.5px solid var(--accent-line);outline-offset:-3px}
.sw-k{font-size:12.5px;color:var(--ink-2);letter-spacing:.02em;white-space:nowrap}
.sw-t{position:relative;flex:none;width:38px;height:20px;border-radius:999px;
  background:#d3dae4;transition:background var(--dur-normal) var(--ease-soft)}
.sw-t i{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;
  background:#fff;box-shadow:0 1px 3px rgba(16,24,40,.3);
  transition:transform var(--dur-normal) var(--ease-out)}
.sw.on .sw-t{background:var(--accent)}
.sw.on .sw-t i{transform:translateX(18px)}
.sw-s{margin-left:auto;font:10px var(--mono);letter-spacing:.08em;color:var(--muted)}
.sw.on .sw-s{color:var(--ok)}
/* 全局暂停是紧急闸：开着时拨杆转红，跟另外两个「放行型」开关分开读 */
.sw[data-switch="paused"].on .sw-t{background:var(--bad)}
.sw[data-switch="paused"].on .sw-s{color:var(--bad)}
/* 两步确认：第一次点不破坏内部结构，只罩一层「再点一次」 */
.sw.armed{background:var(--bad-soft)}
.sw.armed>*{opacity:0}
.sw.armed::before{content:"再点一次确认";position:absolute;inset:0;display:grid;
  place-items:center;font-size:11.5px;font-weight:600;color:var(--bad);letter-spacing:.04em}
/* 只读信息（外发能力 / 真发会不会被拦）：从开关排里挪出来单独一行，
   免得跟可点控件抢权重——一排里混着「能点的」和「只能看的」是最容易点错的设计。 */
.gate-note{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 14px}
/* 卡片内的小一号：跟页头那排形成层级，不至于两排一样重 */
.sw-bar--compact .sw{padding:9px 14px;gap:9px}
.sw-bar--compact .sw-k{font-size:12px}
.sw-bar--compact .sw-t{width:34px;height:18px}
.sw-bar--compact .sw-t i{width:14px;height:14px}
.sw-bar--compact .sw.on .sw-t i{transform:translateX(16px)}

/* 策略 / 通道 / 主动送达表单：开关是「放不放行」，这些是「闸门放多宽」，所以分开放。 */
.policy-box{margin:10px 0 4px;padding:12px 14px;border:1px solid var(--line);
  border-radius:var(--r-sm);background:var(--card-2)}
.policy-head{font-family:var(--mono);font-size:10.5px;color:var(--muted);margin-bottom:9px;
  letter-spacing:.06em;text-transform:uppercase}
.policy-grid{display:flex;flex-wrap:wrap;gap:10px 14px}
.pol-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--muted)}
.pol-field input,.pol-field select{height:32px;padding:0 9px;border:1px solid var(--line);
  border-radius:var(--r-sm);font:inherit;font-size:12px;color:var(--ink);background:var(--card);
  outline:none;transition:border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease)}
.pol-field input{width:112px}
.pol-field select{min-width:150px;cursor:pointer}
.pol-field.wide input{width:300px}
.pol-field input:focus,.pol-field select:focus{border-color:var(--accent-line);
  box-shadow:0 0 0 3px rgba(59,91,219,.12)}
.policy-actions{display:flex;align-items:center;gap:10px;margin-top:11px;flex-wrap:wrap}
.policy-note{font-size:11px;color:var(--muted);line-height:1.7}

.override-editor{margin-top:10px}
.override-editor textarea{width:100%;box-sizing:border-box;font:inherit;font-family:var(--mono);
  font-size:12.5px;line-height:1.65;padding:9px 11px;border:1px solid var(--line);
  border-radius:var(--r-sm);background:var(--card);color:var(--ink);resize:vertical;
  outline:none;transition:border-color var(--dur-fast) var(--ease),
    box-shadow var(--dur-fast) var(--ease)}
.override-editor textarea:focus{border-color:var(--accent-line);
  box-shadow:0 0 0 3px rgba(59,91,219,.12)}
.override-actions{display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap}
.override-hint{font-size:11px;color:var(--muted)}

/* 候选卡：一句话 + 来源/分数/话题 + 三个动作。would-say 用靛蓝软底标出
   「如果开关全开，它本来会发这句」——这是这页最要紧的一眼。 */
.social{border:1px solid var(--line);border-radius:var(--r-sm);padding:12px 15px;
  margin-bottom:9px;background:var(--card-2);
  transition:border-color var(--dur-fast) var(--ease-soft)}
.social:hover{border-color:var(--accent-line)}
.social.would-say{border-color:var(--accent-line);background:var(--accent-soft)}
.social-top{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.social-text{font-size:13.5px;line-height:1.72;margin-top:8px;word-break:break-word;
  white-space:pre-wrap;color:var(--ink)}
.social-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:11px;color:var(--muted);margin-top:7px;
  font-variant-numeric:tabular-nums}
.social-meta b{font-family:var(--mono);font-weight:550;color:var(--ink);margin-left:4px}
.social-actions{display:flex;gap:7px;flex-wrap:wrap;margin-top:10px}
/* 发送结果贴在候选卡里：成功 / 被拒原因 / note 三行都在原地，不用翻别处核对。 */
.send-out{display:none;margin-top:9px;border-radius:var(--r-sm);border:1px solid var(--line);
  background:var(--raise);padding:8px 11px;font-size:12px;line-height:1.7}
.send-out.show{display:block}
.send-line{color:var(--ink-2)}
.send-line.ok{color:var(--ok)}
.send-line.bad{color:var(--bad)}
.send-line.warn{color:var(--warn)}
.send-meta{font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-top:4px;
  font-variant-numeric:tabular-nums}
.send-hint{font-size:11px;color:var(--muted);align-self:center}
.would-say-box{border:1px dashed var(--accent-line);border-radius:var(--r-sm);
  padding:12px 15px;margin:14px 0;background:var(--accent-soft)}
.would-say-head{font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--accent);
  margin-bottom:8px;letter-spacing:.06em;text-transform:uppercase}
.sub-block{margin-top:16px}
.sub-title{font-size:12.5px;font-weight:600;margin-bottom:8px;color:var(--ink)}
/* 已结束的候选：默认收起。折叠块用 <details>，不写 JS——浏览器自己管展开状态。 */
.closed-list{margin-top:12px;border:1px solid var(--line-soft);border-radius:var(--r-sm);
  padding:0 13px;background:var(--card-2)}
.closed-list>summary{cursor:pointer;padding:10px 0;font-size:12px;color:var(--muted);
  user-select:none;list-style-position:inside}
.closed-list>summary:hover{color:var(--ink)}
.closed-list[open]>summary{border-bottom:1px solid var(--line-soft);margin-bottom:10px}
.closed-list .social{margin-bottom:10px;background:var(--card)}
.note-inline{font-size:11px;color:var(--muted);margin-top:12px;
  border-left:2px solid var(--line);padding-left:10px;line-height:1.7}
.skip{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;font-size:11px;color:var(--muted)}

/* 评分拆解：加权项（绿加 / 红减）+ 闸门（✓ 过 / ✗ 拦）。数字一律等宽。 */
.score-box{margin-top:10px;border-top:1px solid var(--line-soft);padding-top:10px}
.score-chips{display:flex;gap:5px;flex-wrap:wrap}
.score-chip{font-family:var(--mono);font-size:10.5px;padding:1.5px 7px;border-radius:4px;
  color:var(--muted);background:var(--raise);white-space:nowrap;line-height:1.6;
  font-variant-numeric:tabular-nums}
.score-chip b{font-weight:560}
.score-chip.up{color:var(--ok);background:var(--ok-soft)}
.score-chip.down{color:var(--bad);background:var(--bad-soft)}
.score-gates{display:flex;gap:5px;flex-wrap:wrap;margin-top:7px}
.score-meta{font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-top:8px;
  word-break:break-word;font-variant-numeric:tabular-nums}
.score-empty{font-size:11px;color:var(--muted);margin-top:8px}

/* 人格版本：版本 chip 行 + 五层内容。层用 --card-2 底，跟外层白面板隔一档。 */
.ver-bar{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.layers{display:grid;grid-template-columns:1fr;gap:7px;margin-top:8px}
.layer{border:1px solid var(--line);border-radius:var(--r-sm);padding:11px 14px;
  background:var(--card-2)}
.layer-head{display:flex;align-items:baseline;gap:9px;flex-wrap:wrap;margin-bottom:6px}
.layer-head b{font-size:12.5px;font-weight:600}
.layer-key{font-family:var(--mono);font-size:10.5px;color:var(--faint);letter-spacing:.02em}
.layer-note{font-size:11px;color:var(--muted);margin-left:auto;line-height:1.7}
.layer-row{display:flex;gap:10px;padding:4px 0;font-size:12.5px;
  border-bottom:1px dotted var(--line)}
.layer-row:last-child{border-bottom:none}
.layer-field{font-family:var(--mono);font-size:11px;color:var(--muted);min-width:120px;
  word-break:break-all}
.layer-value{flex:1;word-break:break-word;color:var(--ink-2)}
.layer-empty{font-size:11px;color:var(--faint)}

/* 冲突：旧值 / 新值两行对照。不下判断，只把差异摊开等人来点。 */
.conflict{border:1px solid var(--line);border-radius:var(--r-sm);padding:12px 15px;
  margin-bottom:9px;background:var(--card-2)}
.conflict-top{display:flex;gap:9px;flex-wrap:wrap;align-items:baseline}
.conflict-field{font-family:var(--mono);font-size:11px;color:var(--ink-2)}
.conflict-diff{margin-top:8px;display:grid;gap:5px}
.conflict-diff>div{font-size:12.5px;padding:7px 10px;background:var(--card);
  border:1px solid var(--line-soft);border-radius:var(--r-sm);word-break:break-word;
  color:var(--ink-2)}
.conflict-diff .diff-k{display:inline;font-family:var(--mono);font-size:10.5px;
  color:var(--faint);margin-right:8px;letter-spacing:.04em}

/* 关系四维：四条各自独立，绝不合并成一个数字。 */
.rel{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
@media(max-width:720px){.rel{grid-template-columns:minmax(0,1fr)}}
.rel-row{min-width:0}
.rel-head{display:flex;align-items:baseline;gap:8px;margin-bottom:6px}
.rel-label{font-size:12.5px;font-weight:560}
.rel-value{font-family:var(--mono);font-size:11.5px;color:var(--accent);margin-left:auto;
  font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.rel-bar{height:6px;border-radius:3px;background:var(--raise);overflow:hidden}
.rel-bar span{display:block;height:100%;border-radius:3px;
  background:linear-gradient(90deg,var(--accent-2),var(--accent))}
.rel-hint{font-size:10.5px;color:var(--faint);margin-top:6px;line-height:1.7}

/* 回复决策五态：一条一色，同色系深浅区分「全回 / 简短回」，不引入第二种彩色。 */
.dec{display:grid;gap:8px}
.dec-row{display:flex;align-items:center;gap:10px}
.dec-label{font-size:12px;min-width:70px;color:var(--ink-2)}
.dec-bar{flex:1;height:6px;border-radius:3px;background:var(--raise);overflow:hidden;
  min-width:60px}
.dec-bar span{display:block;height:100%}
.dec-reply{background:var(--ok)}
.dec-brief_reply{background:rgba(47,158,99,.42)}
.dec-delay{background:var(--accent)}
.dec-decline{background:rgba(221,127,14,.42)}
.dec-silent{background:var(--faint)}
.dec-count{font-family:var(--mono);font-size:11.5px;min-width:34px;text-align:right;
  font-variant-numeric:tabular-nums;color:var(--muted)}

/* 两步确认：armed 时整颗按钮转红，提醒「再点一次就真发」 */
.btn.armed{border-color:var(--bad);background:var(--bad-soft);color:var(--bad);font-weight:600}

/* 表格里只有三列需要页内微调：标题折行、时间等宽、次要说明降一档 */
.tbl-wrap{overflow-x:auto}
.tbl td.title{max-width:420px;word-break:break-word}
.tbl td.when{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;
  font-variant-numeric:tabular-nums}
.tbl td.muted{color:var(--muted);font-size:11px}

/* 出错条与 dry-run 预演框：都贴在页面顶部，只出现一次，不跟候选卡抢注意力 */
#err{display:none;margin:0 0 16px;padding:10px 14px;border-radius:var(--r-sm);
  border:1px solid var(--line);border-left:2px solid var(--bad);background:var(--bad-soft);
  color:var(--bad);font-size:12.5px;line-height:1.6}
#err.show{display:block}
#dry-out{display:none;margin:0 0 18px;border:1px solid var(--accent-line);
  border-radius:var(--r-sm);padding:14px 18px;background:var(--accent-soft)}
#dry-out.show{display:block}
.dry-title{font-family:var(--mono);font-size:10.5px;font-weight:600;color:var(--accent);
  margin-bottom:8px;letter-spacing:.06em;text-transform:uppercase}
.dry-line{font-size:13.5px;line-height:1.7;margin-bottom:5px;word-break:break-word;color:var(--ink)}
.dry-line b{font-family:var(--mono);font-size:12.5px}
.dry-meta{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:8px;line-height:1.7;
  font-variant-numeric:tabular-nums}
</style>
</head>
<body>
<div class="wrap wrap-wide">
  ${renderPageHead({
    active: 'persona',
    title: '人格与主动社交',
    sub: '人格版本 · 冲突 · 关系四维 · 主动开口演算 · 回复决策'
  })}
  <div class="path">scope: ${esc(scopeId)} · person: ${esc(personId)} · /dsh-brain/api/persona · 生成于 ${esc(fmtWhen(v.at))}</div>

  <div id="err"></div>
  ${unavailableBox}
  ${errorsBox}
  ${schemaBox}
  ${gateLine}

  <div id="dry-out"></div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">主动社交候选</span>
      <span class="panel-meta">预演只读 · 批准发送走已配置的聊天通道（dsh-im 主动投递）</span>
    </div>
    <div class="panel-body">${socialPanel(v.social)}</div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">当前激活人格版本</span>
      <span class="panel-meta">${v.activeVersion ? 'v' + esc(num(v.activeVersion.version)) : '没有激活版本'}</span>
    </div>
    <div class="panel-body">${versionPanel(v.activeVersion, v.profiles, v.versions)}</div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">人格冲突</span>
      <span class="panel-meta">${esc(String(v.conflicts.length))} 条</span>
    </div>
    <div class="panel-body">${conflictsPanel(v.conflicts)}</div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">关系四维</span>
      <span class="panel-meta">不合并成一个数字</span>
    </div>
    <div class="panel-body">${relationshipPanel(v.relationship)}</div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">回复决策历史</span>
      <span class="panel-meta">五态占比 · 保护类不许沉默</span>
    </div>
    <div class="panel-body">${decisionsPanel(v.responseStats)}</div>
  </div>

  <p class="note">
    <b>这页为什么存在：</b>人格决定我说出口的每句话，主动社交决定我会不会先开口——
    这两件事都不该只在提示词里黑着。上面的候选全部来自
    <code>persona.social.preview()</code>：它只读、不写任何业务行，开关全关也能跑，
    所以随时可以按「如果现在发会怎样」。
    <b>发送分两档</b>：「试发」只写一条 <code>delivery_mode=dry_run</code> 的记录，
    一个字都不发；「批准并发送」先过策略闸（免打扰 / 每日上限 / 冷却 / 待批准上限），
    过了才经 <b>已配置的聊天通道</b>（dsh-im 主动投递）发给你本人；通道失败会回落本机落盘并
    <b>如实报错</b>。被闸门拦下时页面会照实写出拦在哪一道，不会显示成成功。
  </p>

  <div class="foot">
    <span>数据来自 /dsh-brain/api/persona</span>
    <span style="flex:1"></span>
    <a href="/dsh-brain">回记忆</a>
  </div>
</div>
<script>
(function(){
  function el(tag, cls, text){
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function errBox(message){
    var host = document.getElementById('err');
    if (!host) return;
    host.className = 'show';
    host.textContent = message;
  }
  function clearErr(){
    var host = document.getElementById('err');
    if (host){ host.className = ''; host.textContent = ''; }
  }

  /**
   * 把 dry-run 结果显示在顶部（不写库、不发送）。
   * 这是这页最重要的交互：说得清「本来会发这句 / 现在被哪道闸拦着」。
   */
  function showDry(result){
    var host = document.getElementById('dry-out');
    if (!host) return;
    host.textContent = '';
    host.className = 'show';
    host.appendChild(el('div', 'dry-title', '如果现在发会怎样（只演算，没有真的发）'));
    if (result && result.wouldSend === true && result.candidate) {
      host.appendChild(el('div', 'dry-line', '本来会发这句话：'));
      host.appendChild(el('div', 'dry-line', String(result.candidate.text || '')));
    } else {
      var why = result && result.blockedBy ? String(result.blockedBy) : '没有可用候选';
      host.appendChild(el('div', 'dry-line', '现在不会发：被「' + why + '」拦住。'));
    }
    if (result && result.candidate) {
      var c = result.candidate;
      host.appendChild(el('div', 'dry-meta',
        '来源 ' + String(c.source || '–') + ' · 分数 ' + String(c.score == null ? '–' : c.score)
        + ' · 证据 ' + String(c.evidenceCount == null ? '–' : c.evidenceCount) + ' 条'));
    }
    if (result && result.switches) {
      host.appendChild(el('div', 'dry-meta',
        '开关：全局暂停 ' + (result.switches.paused ? '开' : '关')
        + ' · 主动社交 ' + (result.switches.socialEnabled ? '开' : '关')
        + ' · 允许外发 ' + (result.switches.allowExternal ? '开' : '关')));
    }
    host.appendChild(el('div', 'dry-meta', 'dry-run 全程只读：没有写任何业务行，也没有真发出去。'));
  }

  function send(url, body, onOk, btn){
    clearErr();
    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Brain-Action': '1' },
      body: JSON.stringify(body)
    }).then(function(response){
      return response.json().catch(function(){ return { ok: false, message: '服务端返回的不是 JSON' }; });
    }).then(function(data){
      if (!data || data.ok !== true){ throw new Error((data && data.message) ? String(data.message) : '操作没成功'); }
      if (onOk) onOk(data);
      else location.reload();
    }).catch(function(error){
      errBox('操作没成功：' + ((error && error.message) ? error.message : String(error)));
      // 失败要把按钮从「再点一次：X」的 armed 态复位。不复位的话它会永远停在
      // 那片红色里：armed 变量早在执行前就置 null 了，再点一下只是重新上膛，
      // 人看到的是「按钮卡死」。cognition / directives / workspace 三页都有复位，
      // 就这页漏了。
      if (btn && btn.getAttribute && btn.getAttribute('data-original')){
        btn.className = btn.getAttribute('data-base-class') || 'btn btn--sm';
        btn.textContent = btn.getAttribute('data-original');
      }
    });
  }

  // dry-run 不需要两步确认：它只读，不改变任何状态。
  function dryRun(btn){
    var id = btn.getAttribute('data-id') || '';
    var source = btn.getAttribute('data-source') || '';
    var topic = btn.getAttribute('data-topic') || '';
    btn.disabled = true;
    send('/dsh-brain/api/persona/social/dry-run', { candidateId: id, source: source, topic: topic }, function(data){
      btn.disabled = false;
      showDry(data.result || null);
    });
    window.setTimeout(function(){ btn.disabled = false; }, 3000);
  }

  /**
   * 发送结果写回卡片。
   * 为什么不复用顶部那块 dry-out：发送是按卡片发生的，
   * 结果跑到页面顶部去，人就分不清是哪一条候选的账。
   */
  function showSendOut(id, lines){
    var box = document.querySelector('.send-out[data-send-out="' + id + '"]');
    if (!box) return;
    box.className = 'send-out show';
    box.textContent = '';
    for (var i = 0; i < lines.length; i += 1){
      box.appendChild(el('div', lines[i].cls || 'send-line', lines[i].text));
    }
  }

  /**
   * 试发 / 批准并发送。
   *
   * 和统一 send() 的区别：被策略闸拒绝时服务端返回 ok:false + result.reason，
   * 这是**预期的业务结果**（静默时段、每日上限…），不是异常。所以不能走 send() 的
   * 抛错路径，也不能因为 HTTP 200 就显示成功——失败要如实显示原因。
   */
  function postSend(btn, mode){
    var id = btn.getAttribute('data-id') || '';
    if (!id){ showSendOut(id, [{ cls: 'send-line bad', text: '这条候选没有 id，发不了' }]); return; }
    btn.disabled = true;
    fetch('/dsh-brain/api/persona/social/send', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Brain-Action': '1' },
      body: JSON.stringify({ id: id, mode: mode })
    }).then(function(response){
      return response.json().catch(function(){ return { ok: false, message: '服务端返回的不是 JSON' }; });
    }).then(function(data){
      btn.disabled = false;
      var result = (data && data.result) ? data.result : {};
      var lines = [];
      if (data && data.ok === true && result.ok === true){
        if (mode === 'dry_run') {
          lines.push({ cls: 'send-line ok', text: '试发记录已写入（dry_run，没有真的发出去）。' });
        } else if (result.recorded === false) {
          // 发出去了但没记账：两种结论必须分开写，不能混成「成功」也不能混成「失败」。
          lines.push({
            cls: 'send-line warn',
            text: '消息已经发出去了（这条别重复发），但发送记录没落库：'
              + String(result.recordError || '未知原因') + '。这条需要人工记一下。'
          });
        } else {
          lines.push({ cls: 'send-line ok', text: '已通过 dsh-im 投递到已配置的聊天通道。' });
        }
      } else {
        var why = result && result.reason
          ? String(result.reason)
          : (data && data.message ? String(data.message) : '服务端没有给出原因');
        lines.push({ cls: 'send-line bad', text: '没发出去：' + why });
      }
      if (data && data.note) lines.push({ cls: 'send-line', text: String(data.note) });
      if (result && result.sendId) lines.push({ cls: 'send-meta', text: '发送记录 ' + String(result.sendId) });
      if (result && result.externalId) lines.push({ cls: 'send-meta', text: '外部回执 ' + String(result.externalId) });
      showSendOut(id, lines);
    }).catch(function(error){
      btn.disabled = false;
      showSendOut(id, [{ cls: 'send-line bad', text: '请求失败：' + ((error && error.message) ? error.message : String(error)) }]);
    });
  }

  /** 批准发送的预备状态：第一次点只把后果写在卡片上，3 秒不点自动退回。 */
  var armedSend = null;
  function disarmSend(){
    var btn = armedSend;
    armedSend = null;
    if (!btn) return;
    btn.textContent = btn.getAttribute('data-send-original') || '批准并发送';
    btn.className = btn.getAttribute('data-send-class') || 'btn btn--sm btn--danger';
    var box = document.querySelector('.send-out[data-send-out="' + (btn.getAttribute('data-id') || '') + '"]');
    if (box){ box.className = 'send-out'; box.textContent = ''; }
  }
  function armSend(btn){
    if (!btn.getAttribute('data-send-original')) btn.setAttribute('data-send-original', btn.textContent || '批准并发送');
    if (!btn.getAttribute('data-send-class')) btn.setAttribute('data-send-class', btn.className || 'btn btn--sm btn--danger');
    if (armedSend && armedSend !== btn) disarmSend();
    armedSend = btn;
    btn.className = 'btn btn--sm btn--danger armed';
    btn.textContent = '再点一次就真发';
    showSendOut(btn.getAttribute('data-id') || '', [{
      cls: 'send-line warn',
      // 这段提示原来写反了：说「不会发出去」，而 approved 分支走的是
      // channelHook → dsh-im → 通道配置里那个真实聊天目标。它恰好出现在
      // 「真发」的确认那一刻，骗人就骗在最重要的位置。
      text: '这一步会真的发出去：先按现在的时间重过一遍策略闸（免打扰 / 每日上限 / 冷却 / 是否已过期）→ 写一条 social_sends 记录 → 经 dsh-im 投递到上面「通道配置」里那个聊天目标。3 秒内不再点就自动取消。'
    }]);
    window.setTimeout(function(){ if (armedSend === btn) disarmSend(); }, 3000);
  }

  // 其余写操作统一两步确认。
  var ACTIONS = {
    'social-cancel': '/dsh-brain/api/persona/social/cancel',
    'conflict-keep-old': '/dsh-brain/api/persona/conflict/resolve',
    'conflict-keep-new': '/dsh-brain/api/persona/conflict/resolve',
    'policy-save': '/dsh-brain/api/persona/policy',
    'channel-save': '/dsh-brain/api/persona/channel',
    'socialauto-save': '/dsh-brain/api/persona/social-auto',
    'override-save': '/dsh-brain/api/persona/override'
  };
  var armed = null;
  /** 从策略表单读值。数值项转 Number；免打扰保持字符串，由服务端解析并校验格式。 */
  function readPolicyForm(btn){
    var box = btn.closest ? btn.closest('[data-policy-box]') : null;
    if (!box) return null;
    var payload = {};
    var inputs = box.querySelectorAll('input[data-policy]');
    for (var i = 0; i < inputs.length; i += 1){
      var key = inputs[i].getAttribute('data-policy');
      var raw = inputs[i].value;
      payload[key] = (key === 'quietHours') ? String(raw == null ? '' : raw) : Number(raw);
    }
    return payload;
  }
  /** 从通道表单读值（全是字符串，服务端只做必填与长度校验）。 */
  function readChannelForm(btn){
    var box = btn.closest ? btn.closest('[data-channel-box]') : null;
    if (!box) return null;
    var payload = {};
    var inputs = box.querySelectorAll('input[data-channel]');
    for (var i = 0; i < inputs.length; i += 1){
      payload[inputs[i].getAttribute('data-channel')] = String(inputs[i].value == null ? '' : inputs[i].value).trim();
    }
    return payload;
  }
  /** 读「主人覆盖」编辑框。整段原文交给服务端解析，前端不做「键：值」拆解。 */
  function readOverrideForm(btn){
    var box = btn.closest ? btn.closest('[data-override-box]') : null;
    if (!box) return null;
    var area = box.querySelector('[data-override-text]');
    if (!area) return null;
    return { text: String(area.value == null ? '' : area.value) };
  }
  /** 读主动送达设置。两个 select：enabled 是布尔，mode 是 console|both。 */
  function readSocialAutoForm(btn){
    var box = btn.closest ? btn.closest('[data-socialauto-box]') : null;
    if (!box) return null;
    var enabledSel = box.querySelector('[data-socialauto="enabled"]');
    var modeSel = box.querySelector('[data-socialauto="mode"]');
    if (!enabledSel || !modeSel) return null;
    return {
      enabled: String(enabledSel.value) === 'true',
      mode: String(modeSel.value) === 'both' ? 'both' : 'console'
    };
  }
  function disarm(btn){
    if (!btn) return;
    // 开关条（.sw）内部是 span 结构（标签 / 拨杆 / 状态字）：textContent 和 className
    // 一覆盖，拨杆就没了。它的 armed 只是一个提示类，撤掉就行。
    if (btn.classList && btn.classList.contains('sw')){
      btn.classList.remove('armed');
      if (armed === btn) armed = null;
      return;
    }
    btn.textContent = btn.getAttribute('data-original') || '操作';
    btn.className = btn.getAttribute('data-base-class') || 'btn btn--sm';
    if (armed === btn) armed = null;
  }
  // 通道区块：页面加载后填当前配置（服务端渲染时拿不到——它是插件运行参数，不在人格门面里）。
  (function initChannel(){
    var box = document.querySelector('[data-channel-box]');
    if (!box) return;
    fetch('/dsh-brain/api/persona/channels', { credentials: 'same-origin' })
      .then(function(response){ return response.json(); })
      .then(function(data){
        var heading = box.querySelector('.policy-head');
        // 读失败要说出来。之前这里直接 return 就完事，于是接口 500 时页面永远停在
        // 「读取中…」——主人看到一片哑谜，分不清是「没配置」还是「接口挂了」。
        if (!data || data.ok !== true || !data.current){
          if (heading){
            heading.textContent = '投递通道（读取失败：'
              + (data && data.message ? String(data.message) : '接口没返回内容')
              + ' · 可手填后保存）';
          }
          return;
        }
        var current = data.current;
        var inputs = box.querySelectorAll('input[data-channel]');
        for (var i = 0; i < inputs.length; i += 1){
          var key = inputs[i].getAttribute('data-channel');
          if (current[key] != null) inputs[i].value = String(current[key]);
        }
        if (heading){
          var name = current.label || current.channel || '未命名';
          heading.textContent = '投递通道（现在：' + name + '）' + (data.note ? ' · ' + String(data.note) : '');
        }
      })
      .catch(function(error){
        var heading = box.querySelector('.policy-head');
        if (heading){
          heading.textContent = '投递通道（读取失败：'
            + String(error && error.message ? error.message : error) + ' · 可手填后保存）';
        }
      });
  })();

  // 主动送达区块：页面加载后填当前设置（服务端渲染时拿不到——它也是插件运行参数）。
  (function initSocialAuto(){
    var box = document.querySelector('[data-socialauto-box]');
    if (!box) return;
    fetch('/dsh-brain/api/persona/social-auto', { credentials: 'same-origin' })
      .then(function(response){ return response.json(); })
      .then(function(data){
        var heading = box.querySelector('.policy-head');
        if (!data || data.ok !== true || !data.current){
          if (heading){
            heading.textContent = '主动送达（读取失败：'
              + (data && data.message ? String(data.message) : '接口没返回内容')
              + '）';
          }
          return;
        }
        var current = data.current;
        var enabledSel = box.querySelector('[data-socialauto="enabled"]');
        var modeSel = box.querySelector('[data-socialauto="mode"]');
        if (enabledSel) enabledSel.value = current.enabled ? 'true' : 'false';
        if (modeSel) modeSel.value = current.mode === 'both' ? 'both' : 'console';
        if (heading){
          heading.textContent = '主动送达（现在：'
            + (current.enabled ? (current.mode === 'both' ? '开 · 控制台+微信' : '开 · 只控制台') : '已关闭')
            + '）';
        }
      })
      .catch(function(error){
        var heading = box.querySelector('.policy-head');
        if (heading){
          heading.textContent = '主动送达（读取失败：'
            + String(error && error.message ? error.message : error) + '）';
        }
      });
  })();

  document.addEventListener('click', function(event){
    var btn = event.target && event.target.closest ? event.target.closest('button[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    // 开关（2026-10-31）：第一次点只写后果，第二次才真改；走统一 send()，成功后刷新页面。
    if (act === 'switch'){
      var swName = btn.getAttribute('data-switch') || '';
      var swNext = btn.getAttribute('data-next') || '';
      var swLabel = btn.getAttribute('data-label') || swName;
      if (!swName || (swNext !== '0' && swNext !== '1')) return;
      if (armed !== btn){
        if (armed) disarm(armed);
        armed = btn;
        // 只加类，不改 textContent / className：开关条内部是 span 结构，
        // 一覆盖拨杆和状态字就没了。提示语由 CSS 的 .sw.armed::before 画。
        btn.classList.add('armed');
        window.setTimeout(function(){ if (armed === btn) disarm(btn); }, 4000);
        return;
      }
      armed = null;
      btn.classList.remove('armed');
      send('/dsh-brain/api/workspace/switch', {
        name: swName,
        value: swNext,
        reason: '网页控制台切换「' + swLabel + '」'
      }, null);
      return;
    }
    if (act === 'social-dry-run'){ dryRun(btn); return; }
    if (act === 'social-send-dry'){ postSend(btn, 'dry_run'); return; }
    if (act === 'social-send-approved'){
      if (armedSend !== btn){ armSend(btn); return; }
      // 第二次点 = 确认。先复位按钮再发，防止连点重复投递。
      var sendBtn = btn;
      armedSend = null;
      sendBtn.textContent = sendBtn.getAttribute('data-send-original') || '批准并发送';
      sendBtn.className = sendBtn.getAttribute('data-send-class') || 'btn btn--sm btn--danger';
      postSend(sendBtn, 'approved');
      return;
    }
    if (!btn.getAttribute('data-original')) btn.setAttribute('data-original', btn.textContent || '操作');
    if (!btn.getAttribute('data-base-class')) btn.setAttribute('data-base-class', btn.className || 'btn btn--sm');
    if (armed !== btn){
      if (armed) disarm(armed);
      armed = btn;
      btn.className = 'btn btn--sm armed';
      btn.textContent = '再点一次：' + (btn.getAttribute('data-confirm') || '确认');
      window.setTimeout(function(){ if (armed === btn) disarm(btn); }, 4000);
      return;
    }
    armed = null;
    var url = ACTIONS[act];
    if (!url) return;
    var body;
    if (act === 'policy-save'){
      body = readPolicyForm(btn);
      if (!body){ errBox('读不到策略表单，页面可能已经是旧版本，刷新一次再试'); return; }
    } else if (act === 'channel-save'){
      body = readChannelForm(btn);
      if (!body){ errBox('读不到通道表单，页面可能已经是旧版本，刷新一次再试'); return; }
    } else if (act === 'socialauto-save'){
      body = readSocialAutoForm(btn);
      if (!body){ errBox('读不到主动送达表单，页面可能已经是旧版本，刷新一次再试'); return; }
    } else if (act === 'override-save'){
      body = readOverrideForm(btn);
      if (!body){ errBox('读不到覆盖编辑框，页面可能已经是旧版本，刷新一次再试'); return; }
    } else {
      body = { id: btn.getAttribute('data-id') };
      if (act === 'conflict-keep-old') body.resolution = 'keep_old';
      if (act === 'conflict-keep-new') body.resolution = 'keep_new';
    }
    send(url, body, null, btn);
  });
})();
</script>
</body>
</html>`
}
