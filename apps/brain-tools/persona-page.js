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
 * 1. 冲突裁决、取消候选都要两步确认 + POST + `X-Brain-Action: 1`；
 * 2. 缺字段显示「–」：`relationship === null` 是「还没有关系记录」，不是「四维全 0」；
 * 3. 所有开关状态照实显示，包括「真发会被拦在哪一道」。
 */

import { renderNav, NAV_CSS } from './nav.js'

/** 主动社交候选来源中文。三类刻意没做的来源也列出，页面上说清「没做」而不是「没有」。 */
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
  { key: 'learned', label: '学习层', note: '从相处里学到的倾向（本轮留空）' },
  { key: 'userOverride', label: '主人覆盖', note: '主人显式指定，压过基础层' },
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

/** 单条社交候选（fresh 或 wouldSay 或已验证候选）。 */
function socialCard(candidate, opts) {
  const options = opts && typeof opts === 'object' ? opts : {}
  const title = candidate.persisted ? '已落表的候选' : '新鲜候选'
  const wouldSay = options.highlight === true
  const chips = [
    '<span class="chip kind">' + esc(SOURCE_LABELS[candidate.source] || candidate.source) + '</span>',
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
    ? '<button class="btn small danger" data-act="social-cancel" data-id="' + esc(dryId)
      + '" data-confirm="取消这条主动社交候选">取消候选</button>'
    : ''
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
    + '<button class="btn small" data-act="social-dry-run" data-id="' + esc(dryId)
    + '" data-source="' + esc(candidate.source) + '" data-topic="' + esc(candidate.topic || '')
    + '" data-text="' + esc(candidate.text) + '">如果现在发会怎样</button>'
    + cancelButton
    + '</div>'
    + '</div>'
}

/** 主动社交整块。 */
function socialPanel(social) {
  if (!social || social.available !== true) {
    return '<div class="empty"><strong>主动社交预演不可用</strong>'
      + '<span>' + esc(social && social.message ? social.message : 'persona.social.preview() 这次没跑起来。')
      + '没有预演数据时不要判断「它不想说话」——这是「算不出来」。</span></div>'
  }
  const sw = social.switches || {}
  const switchLine = '<div class="gate-row">'
    + '<span class="chip ' + (sw.paused ? 'bad' : 'ok') + '">全局暂停 ' + (sw.paused ? '开' : '关') + '</span>'
    + '<span class="chip ' + (sw.socialEnabled ? 'ok' : '') + '">主动社交 ' + (sw.socialEnabled ? '开' : '关') + '</span>'
    + '<span class="chip ' + (sw.allowExternal ? 'ok' : '') + '">允许外发 ' + (sw.allowExternal ? '开' : '关') + '</span>'
    + '<span class="chip ' + (sw.wouldBlockRealSend ? 'bad' : 'ok') + '">真发会被拦：'
    + esc(sw.wouldBlockRealSend ? (sw.denied === null || sw.denied === undefined ? '允许外发未开' : String(sw.denied)) : '不会') + '</span>'
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
      + '<span>三类来源还没实现（共同记忆 / 求证 / 好奇），'
      + '已实现的四类（作息 / 没问完的关心 / 承诺 / 新发现）这次也都没有可用的依据。'
      + '「没有候选」是诚实状态，不是故障。</span></div>'

  const persisted = Array.isArray(social.persistedToday) && social.persistedToday.length
    ? '<div class="sub-block"><div class="sub-title">今天已落表的候选</div>'
      + social.persistedToday.map((candidate) => socialCard(candidate, {})).join('') + '</div>'
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
    + (policy ? '<span>策略 <b>' + esc(flat({ enabled: policy.enabled, dailyCap: policy.dailyCap, cooldownMinutes: policy.cooldownMinutes, maxPending: policy.maxPending, quietHours: policy.quietHours })) + '</b></span>' : '')
    + '</div>'

  const skipped = Array.isArray(social.skipped) && social.skipped.length
    ? '<div class="skip">没做的来源：' + social.skipped.map((item) => '<span class="chip">'
      + esc(SOURCE_LABELS[item.source] || flat(item.source)) + '：' + esc(dash(item.reason)) + '</span>').join('') + '</div>'
    : ''

  return switchLine + policyLine + wouldSay
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
      + '<span class="chip kind">' + esc(CONFLICT_KIND_LABELS[conflict.kind] || conflict.kind) + '</span>'
      + '<span class="conflict-field">' + esc(conflict.layer + '.' + conflict.field) + '</span>'
      + '<span class="chip ' + (resolved ? 'ok' : 'bad') + '">'
      + esc(CONFLICT_RESOLUTION_LABELS[conflict.resolution] || conflict.resolution) + '</span>'
      + '</div>'
      + '<div class="conflict-diff">'
      + '<div><span class="diff-k">旧</span>' + esc(dash(conflict.oldValue)) + '</div>'
      + '<div><span class="diff-k">新</span>' + esc(dash(conflict.newValue)) + '</div>'
      + '</div>'
      + (resolved ? '' : '<div class="social-actions">'
        + '<button class="btn small" data-act="conflict-keep-old" data-id="' + esc(conflict.id)
        + '" data-confirm="保留旧值 ' + esc(conflict.field) + '">保留旧值</button>'
        + '<button class="btn small" data-act="conflict-keep-new" data-id="' + esc(conflict.id)
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
        }))
        : [],
      pendingSources: Array.isArray(previewRaw.pendingSources) ? previewRaw.pendingSources.map(String) : [],
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
    ? '<div class="gate-row">'
      + '<span class="chip ' + (gate.paused ? 'bad' : 'ok') + '">全局暂停 ' + (gate.paused ? '开' : '关') + '</span>'
      + '<span class="chip ' + (gate.socialEnabled ? 'ok' : '') + '">主动社交 ' + (gate.socialEnabled ? '开' : '关') + '</span>'
      + '<span class="chip ' + (gate.allowExternal ? 'ok' : '') + '">允许外发 ' + (gate.allowExternal ? '开' : '关') + '</span>'
      + '<span class="chip ' + (gate.canExternal ? 'ok' : 'bad') + '">外发能力 '
      + (gate.canExternal ? '有' : '无（只会 dry_run）') + '</span>'
      + (gate.denied ? '<span class="chip bad">当前被拒绝：' + esc(String(gate.denied)) + '</span>' : '')
      + '</div>'
    : '<div class="diag warn">开关快照读不到：gate() 没返回。不要据此判断「全是关的」。</div>'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 人格与主动社交</title>
<style>
:root{
  --paper:#faf8f4; --card:#fffdfa; --ink:#241f1b; --muted:#8a8178;
  --line:#e7e0d6; --ochre:#a8632f; --ochre-soft:#f3e6d8;
  --ok:#3f7f5f; --warn:#a8632f; --bad:#a8443a;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
  font:14px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:38px 30px 80px}
.head{display:flex;align-items:baseline;gap:14px;margin-bottom:6px;flex-wrap:wrap}
h1{font-size:21px;font-weight:650;letter-spacing:.01em;margin:0}
.sub{color:var(--muted);font-size:12.5px}
.path{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-bottom:22px;word-break:break-all}

.diag{margin:0 0 18px;padding:13px 17px;border-radius:10px;font-size:13px;
  background:var(--card);border:1px solid var(--line);line-height:1.7}
.diag.warn{border-color:#e8cdb4;background:#fdf6ee;color:#8a5327}
.gate-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}

.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  margin-bottom:20px;overflow:hidden}
.card.social-card{border-color:#e0d3c0}
.card-head{display:flex;align-items:baseline;gap:10px;padding:14px 20px;
  border-bottom:1px solid var(--line);background:#fdfaf6;flex-wrap:wrap}
.card.social-card .card-head{background:#fbf4e9}
.card-title{font-size:13.5px;font-weight:620}
.card-meta{font-size:11.5px;color:var(--muted);margin-left:auto;font-family:var(--mono)}
.body{padding:14px 20px 18px}

.chip{display:inline-block;font-size:11px;padding:1px 8px;border-radius:6px;
  border:1px solid var(--line);color:var(--muted);background:#faf7f2;white-space:nowrap}
.chip.ok{color:var(--ok);border-color:#cfe0d6;background:#eef5f0}
.chip.bad{color:var(--bad);border-color:#e6c9c5;background:#f9efee}
.chip.kind{color:var(--ochre);border-color:#e8d3bf;background:var(--ochre-soft)}

.social{border:1px solid var(--line);border-radius:11px;padding:13px 16px;margin-bottom:10px;background:#fff}
.social.would-say{border-color:#d8c3a5;background:#fdfaf4}
.social-top{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.social-text{font-size:14px;line-height:1.7;margin-top:8px;word-break:break-word;white-space:pre-wrap}
.social-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-top:6px}
.social-meta b{font-family:var(--mono);font-weight:550;color:var(--ink);margin-left:4px}
.social-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.would-say-box{border:1px dashed #d8c3a5;border-radius:12px;padding:12px 14px;margin:14px 0;
  background:#fdfaf4}
.would-say-head{font-size:12.5px;font-weight:620;color:var(--ochre);margin-bottom:8px}
.sub-block{margin-top:16px}
.sub-title{font-size:12.5px;font-weight:620;margin-bottom:8px;color:var(--ink)}
.note-inline{font-size:11.5px;color:var(--muted);margin-top:12px;border-left:2px solid var(--line);padding-left:10px}
.skip{display:flex;gap:6px;flex-wrap:wrap;margin-top:12px;font-size:11.5px;color:var(--muted)}

.score-box{margin-top:10px;border-top:1px solid var(--line);padding-top:9px}
.score-chips{display:flex;gap:6px;flex-wrap:wrap}
.score-chip{font-family:var(--mono);font-size:10.5px;padding:1px 7px;border-radius:5px;
  border:1px solid var(--line);color:var(--muted);background:#faf7f2;white-space:nowrap}
.score-chip.up{color:var(--ok);border-color:#cfe0d6;background:#eef5f0}
.score-chip.down{color:var(--bad);border-color:#e6c9c5;background:#f9efee}
.score-gates{display:flex;gap:6px;flex-wrap:wrap;margin-top:7px}
.gate{font-size:10.5px;padding:1px 7px;border-radius:5px;background:#f6f3ed;color:var(--muted)}
.gate.pass{background:#eef5f0;color:var(--ok)}
.gate.fail{background:#f9efee;color:var(--bad)}
.score-meta{font-family:var(--mono);font-size:10.5px;color:var(--muted);margin-top:7px;word-break:break-word}
.score-empty{font-size:11.5px;color:var(--muted);margin-top:8px}

.ver-bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
.layers{display:grid;grid-template-columns:1fr;gap:8px;margin-top:8px}
.layer{border:1px solid var(--line);border-radius:10px;padding:11px 14px;background:#fff}
.layer-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-bottom:6px}
.layer-head b{font-size:13px}
.layer-key{font-family:var(--mono);font-size:10.5px;color:var(--muted)}
.layer-note{font-size:11px;color:var(--muted);margin-left:auto}
.layer-row{display:flex;gap:10px;padding:3px 0;font-size:12.5px;border-bottom:1px dotted var(--line)}
.layer-row:last-child{border-bottom:none}
.layer-field{font-family:var(--mono);font-size:11px;color:var(--muted);min-width:120px;word-break:break-all}
.layer-value{flex:1;word-break:break-word}
.layer-empty{font-size:11.5px;color:var(--muted)}

.conflict{border:1px solid var(--line);border-radius:10px;padding:12px 15px;margin-bottom:10px;background:#fff}
.conflict-top{display:flex;gap:10px;flex-wrap:wrap;align-items:baseline}
.conflict-field{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.conflict-diff{margin-top:8px;display:grid;gap:5px}
.conflict-diff>div{font-size:12.5px;padding:6px 9px;background:#faf7f2;border-radius:7px;word-break:break-word}
.conflict-diff .diff-k{display:inline;font-family:var(--mono);font-size:10.5px;color:var(--muted);margin-right:8px}

.rel{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}
@media(max-width:720px){.rel{grid-template-columns:1fr}}
.rel-row{min-width:0}
.rel-head{display:flex;align-items:baseline;gap:8px;margin-bottom:5px}
.rel-label{font-size:13px;font-weight:600}
.rel-value{font-family:var(--mono);font-size:12px;color:var(--ink);margin-left:auto;font-variant-numeric:tabular-nums}
.rel-bar{height:7px;border-radius:4px;background:#f1ece4;overflow:hidden}
.rel-bar span{display:block;height:100%;background:var(--ochre);border-radius:4px}
.rel-hint{font-size:11px;color:var(--muted);margin-top:5px}

.dec{display:grid;gap:7px}
.dec-row{display:flex;align-items:center;gap:10px}
.dec-label{font-size:12.5px;min-width:70px}
.dec-bar{flex:1;height:9px;border-radius:5px;background:#f1ece4;overflow:hidden;min-width:60px}
.dec-bar span{display:block;height:100%;border-radius:5px}
.dec-reply{background:var(--ok)}
.dec-brief_reply{background:#6a8a7a}
.dec-delay{background:var(--ochre)}
.dec-decline{background:#b07a5a}
.dec-silent{background:#9a938a}
.dec-count{font-family:var(--mono);font-size:12px;min-width:34px;text-align:right;font-variant-numeric:tabular-nums}

.btn{font:inherit;font-size:12.5px;padding:6px 13px;border-radius:8px;border:1px solid var(--line);
  background:var(--card);color:var(--ink);cursor:pointer;transition:all .15s}
.btn:hover{border-color:var(--ochre);color:var(--ochre)}
.btn.small{font-size:12px;padding:5px 11px}
.btn.danger:hover{border-color:var(--bad);color:var(--bad)}
.btn.armed{border-color:var(--bad);background:#f6e6e4;color:var(--bad);font-weight:600}
.btn[disabled]{opacity:.45;cursor:not-allowed}

.tbl-wrap{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.tbl th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;
  letter-spacing:.04em;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.tbl tr:last-child td{border-bottom:none}
.tbl td.title{max-width:420px;word-break:break-word}
.tbl td.when{font-family:var(--mono);font-size:11.5px;color:var(--muted);white-space:nowrap}
.tbl td.muted{color:var(--muted);font-size:11.5px}

.empty{padding:30px 0 32px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}
.empty strong{display:block;color:var(--ink);font-size:14.5px;font-weight:620;margin-bottom:6px}
.empty span{display:block;max-width:600px;margin:0 auto}
#err{display:none;margin:0 0 16px;padding:11px 15px;border-radius:10px;
  border:1px solid #e6c9c5;background:#f9efee;color:var(--bad);font-size:12.5px;line-height:1.6}
#err.show{display:block}
#dry-out{display:none;margin:0 0 20px;border:1px solid #d8c3a5;border-radius:12px;
  padding:14px 18px;background:#fdfaf4}
#dry-out.show{display:block}
.dry-title{font-size:13px;font-weight:650;color:var(--ochre);margin-bottom:6px}
.dry-line{font-size:13.5px;line-height:1.7;margin-bottom:5px;word-break:break-word}
.dry-line b{font-family:var(--mono);font-size:12.5px}
.dry-meta{font-size:11.5px;color:var(--muted);margin-top:8px;line-height:1.7}

.note{font-size:12px;color:var(--muted);margin-top:6px;padding:13px 17px;
  border-left:2px solid var(--line);line-height:1.85}
.note b{color:var(--ink);font-weight:600}
.note code{font-family:var(--mono);font-size:11.5px;background:#f1ece4;padding:1px 5px;border-radius:4px}
.foot{margin-top:34px;padding-top:20px;border-top:1px solid var(--line);
  color:var(--muted);font-size:12px;display:flex;gap:18px;flex-wrap:wrap;align-items:center}
.foot a{color:var(--ochre);text-decoration:none;border-bottom:1px dotted currentColor}
${NAV_CSS}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>人格与主动社交</h1>
    <span class="sub">人格版本 · 冲突 · 关系四维 · 主动开口演算 · 回复决策</span>
    ${renderNav({ active: 'persona' })}
  </div>
  <div class="path">scope: ${esc(scopeId)} · person: ${esc(personId)} · /dsh-brain/api/persona · 生成于 ${esc(fmtWhen(v.at))}</div>

  <div id="err"></div>
  ${unavailableBox}
  ${errorsBox}
  ${schemaBox}
  ${gateLine}

  <div id="dry-out"></div>

  <div class="card social-card">
    <div class="card-head">
      <span class="card-title">主动社交候选</span>
      <span class="card-meta">dry-run 演算 · 默认一条都不真发</span>
    </div>
    <div class="body">${socialPanel(v.social)}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">当前激活人格版本</span>
      <span class="card-meta">${v.activeVersion ? 'v' + esc(num(v.activeVersion.version)) : '没有激活版本'}</span>
    </div>
    <div class="body">${versionPanel(v.activeVersion, v.profiles, v.versions)}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">人格冲突</span>
      <span class="card-meta">${esc(String(v.conflicts.length))} 条</span>
    </div>
    <div class="body">${conflictsPanel(v.conflicts)}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">关系四维</span>
      <span class="card-meta">不合并成一个数字</span>
    </div>
    <div class="body">${relationshipPanel(v.relationship)}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">回复决策历史</span>
      <span class="card-meta">五态占比 · 保护类不许沉默</span>
    </div>
    <div class="body">${decisionsPanel(v.responseStats)}</div>
  </div>

  <p class="note">
    <b>这页为什么存在：</b>人格决定我说出口的每句话，主动社交决定我会不会先开口——
    这两件事都不该只在提示词里黑着。上面的候选全部来自
    <code>persona.social.preview()</code>：它只读、不写任何业务行，开关全关也能跑，
    所以随时可以按「如果现在发会怎样」。
    <b>默认一条都不真发</b>：<code>social.allow_external=0</code> 时最多只写一条
    <code>delivery_mode=dry_run</code> 的记录，真发通道没配之前永远返回
    <code>no_channel_configured</code>。冲突的身份/边界/矛盾三类永远不自动消解。
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

  function send(url, body, onOk){
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

  // 其余写操作统一两步确认。
  var ACTIONS = {
    'social-cancel': '/dsh-brain/api/persona/social/cancel',
    'conflict-keep-old': '/dsh-brain/api/persona/conflict/resolve',
    'conflict-keep-new': '/dsh-brain/api/persona/conflict/resolve'
  };
  var armed = null;
  function disarm(btn){
    if (!btn) return;
    btn.textContent = btn.getAttribute('data-original') || '操作';
    btn.className = btn.getAttribute('data-base-class') || 'btn small';
    if (armed === btn) armed = null;
  }
  document.addEventListener('click', function(event){
    var btn = event.target && event.target.closest ? event.target.closest('button[data-act]') : null;
    if (!btn) return;
    var act = btn.getAttribute('data-act');
    if (act === 'social-dry-run'){ dryRun(btn); return; }
    if (!btn.getAttribute('data-original')) btn.setAttribute('data-original', btn.textContent || '操作');
    if (!btn.getAttribute('data-base-class')) btn.setAttribute('data-base-class', btn.className || 'btn small');
    if (armed !== btn){
      if (armed) disarm(armed);
      armed = btn;
      btn.className = 'btn small armed';
      btn.textContent = '再点一次：' + (btn.getAttribute('data-confirm') || '确认');
      window.setTimeout(function(){ if (armed === btn) disarm(btn); }, 4000);
      return;
    }
    armed = null;
    var url = ACTIONS[act];
    if (!url) return;
    var body = { id: btn.getAttribute('data-id') };
    if (act === 'conflict-keep-old') body.resolution = 'keep_old';
    if (act === 'conflict-keep-new') body.resolution = 'keep_new';
    send(url, body, null);
  });
})();
</script>
</body>
</html>`
}
