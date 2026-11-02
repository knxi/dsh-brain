// @ts-check
/**
 * 外置大脑 · 类脑页（/dsh-brain/cognition）
 *
 * ── 这页要解决什么 ──
 *
 * 系统 3 的五个模块在跑（显著性 / 反思 / 技能 / 免疫 / 脑干），但它们的产出
 * 全都只是「库里的行」：反思候选躺在 `reflections`、隔离条目躺在 `immune_quarantine`、
 * 告警躺在 `health_alerts`。没有人去看，它们就等于没发生。
 *
 * 五个模块里**只有告警需要立刻处理**（库坏了、备份没了、outbox 堆了），
 * 所以这页的顺序是刻意反过来的：**告警中心在第一屏**，统计排在它后面。
 * 统计是「知道大概」，告警是「现在就得管」，两者的紧迫性不在一个量级。
 *
 * ── 为什么反思与隔离区是可操作的 ──
 *
 * 反思默认只是 `candidate`：晋升才写进记忆，丢弃就再也不提。
 * 隔离区默认只是「标记」：释放是「我核验过，能用」，清除是「内容销毁」。
 * 这两处都是**人的判断**，模块刻意不自动做——所以页面必须给出按钮，
 * 否则「让人看」就退化成「让人看得到但动不了」。
 *
 * ── 纪律 ──
 *
 * 1. 一切写操作两步确认 + POST + `X-Brain-Action: 1`；
 * 2. 缺失字段显示「–」，不编 0（`stats.salience` 报错时不能显示成「0 个标记」）；
 * 3. 空列表要说明「为什么」：没告警 ≠ 没检查，页面同时显示 `lastCheckedAt`。
 */

// 导航与页面骨架统一收在 nav.js（品牌条 / 标题区 / 粘性导航只在那定义一次）。
import { renderPageHead } from './nav.js?v=1793594997081'

/** 告警严重度中文 + 着色类名。 */
const SEVERITY_META = {
  high: { label: '高', cls: 'high' },
  medium: { label: '中', cls: 'medium' },
  low: { label: '低', cls: 'low' },
  info: { label: '提示', cls: 'info' },
}

/** 免疫命中原因中文。 */
const REASON_LABELS = {
  prompt_injection: '提示注入',
  memory_poison: '记忆投毒',
  anomalous_tool_output: '工具输出异常',
  forged_owner: '伪造指令',
  credential_leak: '疑似凭据泄露',
  other: '其它',
}

/**
 * 反思 kind 中文（2026-11-02 改成口语）。
 *
 * 原来是「未完成的承诺 / 知识缺口 / 行为模式」——书面上没错，但要读两遍才知道
 * 它在说我的什么。改成人话：这不是分类法考试，是让人扫一眼知道「这条在提醒我啥」。
 */
const REFLECTION_KIND_LABELS = {
  commitment: '有个承诺没兑现',
  knowledge_gap: '有个问题没查',
  pattern: '最近反复出现',
  diary: '自我日记',
  dream: '梦境整理',
  premonition: '行动预演',
  contradiction: '两条记忆打架',
}

/** 记忆类型 → 中文。反思正文里会引用类型，英文代号得翻过来才读得懂。 */
const MEMORY_TYPE_LABELS = {
  semantic: '事实', profile: '偏好', commitment: '承诺', episode: '经历',
  skill: '方法', self: '自省', relationship: '关系', boundary: '边界',
}

/** 置信度 → 人话档位。0.60 这种数字单独摆着没人能判断「这算高还是低」。 */
function confidenceLabel(v) {
  if (v >= 0.8) return '高'
  if (v >= 0.6) return '中高'
  if (v >= 0.5) return '中'
  return '低'
}

/**
 * 告警 `detail` 里已知字段的中文名（2026-11-02）。
 *
 * detail 是各模块自己塞的自由 JSON，原来页面直接 `JSON.stringify` 出来，
 * 人看到的是 `{"backlog":1341,"dead":0,"warnCount":500}`——数字全都淹在花括号和引号里。
 * 这里给已知键配中文，未知键原样保留（不猜含义，也别丢信息）。
 */
const DETAIL_LABELS = {
  backlog: '积压', dead: '死信', warnCount: '告警阈值', count: '数量',
  missing: '缺失', table: '表', retries: '重试次数', error: '错误',
  level: '等级', scope: '范围', kind: '类型', id: 'id',
}

/** detail 的单个值 → 一行字。对象就退回 JSON（少见，但别让它变成 [object Object]）。 */
function formatDetailValue(v) {
  if (v === null || v === undefined) return '–'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

/**
 * 告警的 `module` → 中文。
 *
 * 原来是「模块 brainstem」——`brainstem` 是代码里的模块名，不是给人看的。
 * 未知模块原样显示（不猜归属，宁可露出代号也不编一个错的）。
 */
function moduleLabel(v) {
  if (v === null || v === undefined || v === '') return '–'
  const map = {
    brainstem: '脑干体检',
    reflection: '反思',
    social: '主动社交',
    immune: '免疫扫描',
    skill: '工具统计',
    memory: '记忆库',
    store: '存储',
    outbox: '事件投递',
  }
  return map[String(v)] || String(v)
}

/**
 * 隔离条目的 `sourceType` → 中文。
 *
 * 原来是裸的 `console` / `tool` 这种值直接铺在页面上——技术上准确，
 * 但看的人得先知道这套内部命名。未知值仍然原样显示（不猜）。
 */
function sourceTypeLabel(v) {
  if (v === null || v === undefined || v === '') return '–'
  const map = {
    console: '控制台',
    im: '聊天消息',
    tool: '工具返回',
    file: '文件',
    memory: '记忆正文',
    event: '事件',
    session: '会话记录',
    connector: '外部接入',
  }
  return map[String(v)] || String(v)
}

/**
 * 「谁做的」这类 actor 值 → 中文。`console` / `owner` 是内部账号名，
 * 页面上写「确认人 console」等于把内部命名暴露给读者。
 */
function actorLabel(v) {
  if (v === null || v === undefined || v === '') return '–'
  const map = {
    console: '控制台',
    owner: '主人',
    agent: '模型自己',
    system: '系统',
    migration: '迁移脚本',
    'brain-tools': '工具层',
  }
  return map[String(v)] || String(v)
}

/** 告警状态中文。 */
const ALERT_STATUS_LABELS = {
  open: '未处理',
  acked: '已确认',
  resolved: '已解决',
  expired: '已过期',
}

/** 告警状态 → theme 的 chip 语气（theme 只有 accent / ok / warn / bad / plain 五档）。 */
const ALERT_STATUS_TONE = {
  open: 'bad',
  acked: 'accent',
  resolved: 'ok',
  expired: 'plain',
}

/** 拼 chip 的 class。未知取值给中性档，不猜也不编一个没有的颜色。 */
function chipClass(tone) {
  return tone ? 'chip ' + tone : 'chip'
}

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

/** 对象取值：`{ error: '...' }` 也算取不到（stats 里某张表缺失时的形状）。 */
function pick(obj, key, fallback) {
  if (!obj || typeof obj !== 'object') return fallback
  if (obj.error) return fallback
  const value = obj[key]
  return value === undefined || value === null ? fallback : value
}

/**
 * 把异常翻成人能判断的一句话。
 * `no such table` 是首启最常见的一种：库还在 0007 时，页面必须说「表还没建」，
 * 而不是让人看着「没有待处理告警」以为系统很健康。
 */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const missing = /no such table:\s*([A-Za-z0-9_]+)/.exec(message)
  if (missing) return missing[1] + ' 表不存在（0008 迁移未应用？）'
  return message
}

/**
 * 剥掉反思正文里的内部 ID（2026-11-02）。
 *
 * 生成器以前把 `memory:mem_9f825e06...` 直接拼进正文，一条六十字的反思有一半是机器码，
 * 人读不下去。生成的源头已经改成只写人话（见 reflect.js 的 memoryExcerpt），
 * 但库里还压着一批旧候选——展示时统一剥一次。
 *
 * 溯源不受影响：ID 本来就在 `evidence` 字段里，卡片上另有一行「依据 N 条」。
 */
function cleanReflectionText(text) {
  let s = String(text == null ? '' : text)
  // 记忆类型代号 → 中文（旧文案里是「semantic」类的记忆，人得先翻译一遍）
  s = s.replace(/「(semantic|profile|commitment|episode|skill|self|relationship|boundary)」/g,
    (_m, t) => '「' + (MEMORY_TYPE_LABELS[t] || t) + '」')
  // 「（证据：memory:a、memory:b）」这种整段先摘掉
  s = s.replace(/[（(]\s*证据\s*[：:][^）)]*[）)]/g, '')
  // 剩下的裸 ID
  s = s.replace(/\b(?:memory|event|edge):[A-Za-z0-9_-]+/g, '')
  // 剥完可能留下空括号、或以逗号开头的括号，顺手收干净
  s = s.replace(/[（(]\s*[、，,；;]?\s*[）)]/g, '')
  s = s.replace(/[（(]\s*[，,]\s*/g, '（')
  s = s.replace(/、\s*[）)]/g, '）')
  s = s.replace(/[，,]\s*[，,]/g, '，')
  s = s.replace(/\s{2,}/g, ' ')
  s = s.replace(/\s+([。，、；：）])/g, '$1')
  return s.trim()
}

/**
 * 收集类脑视图（同步）。
 *
 * @param {any} brain openBrain 的返回值
 * @param {{ scopeId: string, limit?: number }} opts
 */
export function collectCognitionView(brain, opts) {
  const scopeId = String(opts && opts.scopeId ? opts.scopeId : '')
  const limit = Math.min(Math.max(Number(opts && opts.limit) || 50, 1), 200)
  const cog = brain && brain.cognition
  if (!cog) {
    return {
      unavailable: '类脑门面（brain.cognition）还没接线：openBrain 里没构造 createCognition。'
        + '这页先只显示空壳，**不要**把「看不到」当成「没有告警」。',
      scopeId,
      stats: null,
      alerts: [],
      reflections: [],
      quarantine: [],
      weakSkills: [],
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

  const rawStats = safe(() => cog.stats({ scopeId }), null)
  const stats = rawStats && typeof rawStats === 'object'
    ? {
      salience: pick(rawStats.salience, 'marked', null),
      reflectCandidate: pick(pick(rawStats.reflect, 'byStatus', null), 'candidate', null),
      reflectRuns: pick(rawStats.reflect, 'runs', null),
      reflectLastRunAt: pick(rawStats.reflect, 'lastRunAt', null),
      weakSkills: pick(rawStats.skill, 'weak', null),
      skills: pick(rawStats.skill, 'skills', null),
      quarantined: pick(rawStats.immune, 'quarantined', null),
      alertsOpen: pick(rawStats.brainstem, 'open', null),
      alertsAcked: pick(rawStats.brainstem, 'acked', null),
      worstSeverity: pick(rawStats.brainstem, 'worstSeverity', null),
      lastCheckedAt: pick(rawStats.brainstem, 'lastCheckedAt', null),
    }
    : null

  const alertsRaw = safe(() => cog.brainstem.listAlerts({ scopeId, limit }), null)
  const alerts = ((alertsRaw && alertsRaw.items) || []).map((item) => ({
    id: String(item.id),
    code: String(item.code),
    module: item.module == null ? null : String(item.module),
    severity: String(item.severity),
    title: String(item.title),
    status: String(item.status),
    occurrences: Number(item.occurrences) || 1,
    at: item.at == null ? null : String(item.at),
    firstSeenAt: item.firstSeenAt == null ? null : String(item.firstSeenAt),
    lastSeenAt: item.lastSeenAt == null ? null : String(item.lastSeenAt),
    ackedBy: item.ackedBy == null ? null : String(item.ackedBy),
    resolution: item.resolution == null ? null : String(item.resolution),
    detail: item.detail && typeof item.detail === 'object' ? item.detail : null,
  }))

  /**
   * 反思正文只有「结构化描述 + 来源 id」——这是刻意的，见 reflect.test.mjs 的硬断言
   * （隐私 + 体积：反思表跟着记忆一起备份，正文重复存原文既涨体积也涨泄露面）。
   *
   * 但人看页面得知道「它到底在说哪件事」。所以这里按 evidence 里的 id **回查一次摘要**，
   * 只用于渲染、不写回 reflections 表。查不到就返回 null，卡片上就不显示这一行——
   * 预览是加分项，不该把整页拖垮。
   */
  const evidencePreviewOf = (evidence) => {
    if (!Array.isArray(evidence) || evidence.length === 0) return null
    const db = brain && brain.db
    if (!db || typeof db.prepare !== 'function') return null
    for (const ref of evidence) {
      const raw = String(ref == null ? '' : ref)
      const sep = raw.indexOf(':')
      if (sep <= 0) continue
      const kind = raw.slice(0, sep)
      const id = raw.slice(sep + 1)
      if (!id) continue
      try {
        let row = null
        if (kind === 'memory') {
          row = db.prepare('SELECT content, summary FROM memories WHERE id = ? AND scope_id = ?').get(id, scopeId)
        } else if (kind === 'event') {
          row = db.prepare('SELECT payload_text FROM events WHERE event_id = ? AND scope_id = ?').get(id, scopeId)
        }
        if (!row) continue
        // 优先 summary：它本来就是一句话概括；退回 content 时清掉 markdown 记号，
        // 否则卡片上会出现「**两个严重问题**： 1. **⚠️ 账户允许提现…」这种残片。
        const source = kind === 'event' ? (row.payload_text || '') : (row.summary || row.content || '')
        let text = String(source)
          .replace(/\r?\n/g, ' ')
          .replace(/[（(]自动提取[）)]/g, '')   // 来源标记，占位且没信息
          .replace(/[#*`>]/g, '')
          .replace(/[{}"]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (!text) continue
        // 截在句子边界上：宁可短一点，也别从半句话开始
        const stop = text.search(/[。！？；]/)
        if (stop > 8 && stop < 56) text = text.slice(0, stop + 1)
        return text.length > 52 ? text.slice(0, 52) + '…' : text
      } catch {
        // 表/列不存在或这条被删了：跳过，继续看下一条证据
      }
    }
    return null
  }

  const reflectionsRaw = safe(() => cog.reflect.list({ scopeId, status: 'candidate', limit }), null)
  const reflections = ((reflectionsRaw && reflectionsRaw.items) || []).map((item) => ({
    id: String(item.id),
    kind: String(item.kind),
    text: cleanReflectionText(item.text),
    // 「它到底在说哪件事」——从证据里回查一句摘要，只给页面看
    evidencePreview: evidencePreviewOf(item.evidence),
    evidenceCount: Array.isArray(item.evidence) ? item.evidence.length : 0,
    confidence: Number(item.confidence) || 0,
    status: String(item.status),
    createdAt: item.createdAt == null ? null : String(item.createdAt),
  }))

  const quarantineRaw = safe(() => cog.immune.list({ scopeId, limit }), null)
  const quarantine = ((quarantineRaw && quarantineRaw.items) || []).map((item) => ({
    id: String(item.id),
    reasonCode: String(item.reasonCode),
    severity: String(item.severity),
    excerpt: item.excerpt == null ? null : String(item.excerpt),
    sourceType: item.sourceType == null ? null : String(item.sourceType),
    sourceRef: item.sourceRef == null ? null : String(item.sourceRef),
    status: String(item.status),
    at: item.at == null ? null : String(item.at),
  }))

  const weakRaw = safe(() => cog.skill.listWeakSkills({ scopeId, limit: 20 }), null)
  const weakSkills = ((weakRaw && weakRaw.items) || []).map((item) => ({
    skillKey: String(item.skillKey),
    attempts: Number(item.attempts) || 0,
    failures: Number(item.failures) || 0,
    consecutiveFailures: Number(item.consecutiveFailures) || 0,
    confidence: Number(item.confidence) || 0,
    reasons: Array.isArray(item.reasons) ? item.reasons.map(String) : [],
    updatedAt: item.updatedAt == null ? null : String(item.updatedAt),
  }))

  return {
    unavailable: null,
    scopeId,
    stats,
    alerts,
    reflections,
    quarantine,
    weakSkills,
    errors,
    // 表不存在 ≠ 没有告警：页面顶部必须说清楚，否则「全空」会被读成「很健康」。
    schemaHint: errors.some((message) => message.includes('0008'))
      ? '数据库还没升到 0008：类脑的几张表（health_alerts / reflections / immune_quarantine 等）还没建。'
        + '「没有待处理告警」在这里等于「还没法查」，不是「一切正常」；迁移跑完后刷新本页。'
      : null,
    at: new Date().toISOString(),
  }
}

/** 五格统计：这是「知道大概」，不是操作入口，所以放告警后面。 */
function statsGrid(stats) {
  if (!stats) {
    return '<div class="empty"><strong>统计读不到</strong>'
      + '<span>门面在，但统计调用失败（某张表缺失？）。这一格不编 0，只如实说读不到。</span></div>'
  }
  // 五个格子上的词全换成口语（2026-11-02）：
  // 「显著性标记」「弱技能」「隔离条目」是内部术语，读者得先学会这套词才看得懂数字。
  // 「技能」也一并改成「工具」——它指的是我能调用的那些 tool，叫技能是项目黑话。
  const cells = [
    { k: '被标重的记忆', v: stats.salience, note: '按重要度打过高分的那几条' },
    { k: '待看反思', v: stats.reflectCandidate, note: '累计跑过 ' + num(stats.reflectRuns) + ' 次' },
    { k: '把握还不高的工具', v: stats.weakSkills, note: '共 ' + num(stats.skills) + ' 个工具在用' },
    { k: '拦下的可疑内容', v: stats.quarantined, note: '还没人核验过' },
    { k: '待处理告警', v: stats.alertsOpen, note: '最严重的一条：' + dash(stats.worstSeverity === null ? null : (SEVERITY_META[stats.worstSeverity] || {}).label || stats.worstSeverity) },
  ]
  return '<div class="stats">' + cells.map((cell) => '<div class="stat">'
    + '<span class="stat-k">' + esc(cell.k) + '</span>'
    + '<span class="stat-v">' + esc(num(cell.v)) + '</span>'
    + '<span class="stat-n">' + esc(cell.note) + '</span>'
    + '</div>').join('') + '</div>'
}

/** 一条告警。状态决定按钮：open 可 ack + resolve；acked 只能 resolve。 */
function alertRow(alert) {
  const sev = SEVERITY_META[alert.severity] || { label: alert.severity, cls: 'info' }
  const buttons = []
  if (alert.status === 'open') {
    buttons.push('<button class="btn btn--sm" data-act="alert-ack" data-id="' + esc(alert.id)
      + '" data-confirm="确认告警 ' + esc(alert.code) + '">已知悉</button>')
    buttons.push('<button class="btn btn--sm" data-act="alert-resolve" data-id="' + esc(alert.id)
      + '" data-confirm="解决告警 ' + esc(alert.code) + '">标记解决</button>')
  } else if (alert.status === 'acked') {
    buttons.push('<button class="btn btn--sm" data-act="alert-resolve" data-id="' + esc(alert.id)
      + '" data-confirm="解决告警 ' + esc(alert.code) + '">标记解决</button>')
  }
  const detailKeys = alert.detail && typeof alert.detail === 'object' ? Object.keys(alert.detail) : []
  const detailText = detailKeys
    .map((k) => (DETAIL_LABELS[k] || k) + ' ' + formatDetailValue(alert.detail[k]))
    .join(' · ')
  const detail = detailText ? '<div class="alert-detail">' + esc(detailText) + '</div>' : ''
  return '<div class="alert sev-' + esc(sev.cls) + '">'
    + '<div class="alert-top">'
    + '<span class="sev-badge ' + esc(sev.cls) + '">' + esc(sev.label) + '</span>'
    // 告警码不再是正文的一部分，改挂 title：它是给排查用的人看的，不该占一行版面
    + '<span class="alert-title" title="' + esc(alert.code) + '">' + esc(alert.title) + '</span>'
    + '<span class="' + chipClass(ALERT_STATUS_TONE[alert.status]) + '">'
    + esc(ALERT_STATUS_LABELS[alert.status] || alert.status) + '</span>'
    + '<span class="alert-when">' + esc(fmtWhen(alert.lastSeenAt)) + '</span>'
    + '</div>'
    + '<div class="alert-meta">'
    + '<span>来自 <b>' + esc(moduleLabel(alert.module)) + '</b></span>'
    + '<span>出现 ' + esc(num(alert.occurrences)) + ' 次</span>'
    + '<span>首次 ' + esc(fmtWhen(alert.firstSeenAt)) + '</span>'
    + (alert.ackedBy ? '<span>确认人 ' + esc(actorLabel(alert.ackedBy)) + '</span>' : '')
    + (alert.resolution ? '<span>结论 ' + esc(alert.resolution) + '</span>' : '')
    + '</div>'
    + detail
    + (buttons.length ? '<div class="alert-actions">' + buttons.join('') + '</div>' : '')
    + '</div>'
}

function alertsPanel(view) {
  if (!view.alerts.length) {
    const checked = view.stats && view.stats.lastCheckedAt
      ? '最近一次体检：' + fmtWhen(view.stats.lastCheckedAt)
      : '还没有体检记录（lastCheckedAt 为「–」）'
    return '<div class="empty"><strong>没有待处理告警</strong>'
      + '<span>这不等于「什么都没检查过」：' + esc(checked) + '。'
      + '脑干只在你或调度器调 checkOnce 时才跑，所以「没有告警」也可能是「还没检查」。</span></div>'
  }
  return view.alerts.map(alertRow).join('')
}

/** 反思候选：晋升写记忆（低置信度、标 inference），丢弃是软状态。 */
function reflectionsPanel(reflections) {
  if (!reflections.length) {
    return '<div class="empty"><strong>没有待处理的反思候选</strong>'
      + '<span>反思默认关闭（reflection.enabled=0），所以「没有候选」是预期状态。'
      + '打开开关并跑一次 runOnce 之后，这里才会出现东西。</span></div>'
  }
  return reflections.map((item) => '<div class="refl">'
    + '<div class="refl-top">'
    + '<span class="chip accent">' + esc(REFLECTION_KIND_LABELS[item.kind] || item.kind) + '</span>'
    + '<span class="refl-text">' + esc(item.text) + '</span>'
    + '</div>'
    // 「它到底在说哪件事」：从证据里回查的一句摘要。只在这里显示——reflections.text 里不存原文。
    + (item.evidencePreview ? '<div class="refl-quote">' + esc(item.evidencePreview) + '</div>' : '')
    + '<div class="refl-meta">'
    + '<span>把握 <b>' + esc(confidenceLabel(item.confidence)) + '</b>'
    + '（' + esc(item.confidence.toFixed(2)) + '）</span>'
    + '<span>依据 <b>' + esc(num(item.evidenceCount)) + '</b> 条</span>'
    + '<span>产出 <b>' + esc(fmtWhen(item.createdAt)) + '</b></span>'
    + '</div>'
    + '<div class="alert-actions">'
    + '<button class="btn btn--sm" data-act="refl-promote" data-id="' + esc(item.id)
    + '" data-confirm="把这条反思晋升进记忆">晋升为记忆</button>'
    + '<button class="btn btn--sm btn--danger" data-act="refl-dismiss" data-id="' + esc(item.id)
    + '" data-confirm="丢弃这条反思">丢弃</button>'
    + '</div>'
    + '</div>').join('')
}

/** 免疫隔离区：释放是核验后放行，清除是销毁摘录（都不物理删行）。 */
function quarantinePanel(quarantine) {
  if (!quarantine.length) {
    return '<div class="empty"><strong>隔离区是空的</strong>'
      + '<span>没有内容命中免疫规则（提示注入 / 记忆投毒 / 伪造指令 / 凭据泄露）。'
      + '隔离区空不代表绝对安全——它只说明已扫描的内容里没有命中。</span></div>'
  }
  return quarantine.map((item) => '<div class="quar">'
    + '<div class="quar-top">'
    + '<span class="sev-badge ' + esc((SEVERITY_META[item.severity] || { cls: 'info' }).cls) + '">'
    + esc((SEVERITY_META[item.severity] || { label: item.severity }).label) + '</span>'
    + '<span class="refl-text">' + esc(REASON_LABELS[item.reasonCode] || item.reasonCode) + '</span>'
    + '<span class="alert-when">' + esc(fmtWhen(item.at)) + '</span>'
    + '</div>'
    + (item.excerpt ? '<div class="quar-excerpt">' + esc(item.excerpt) + '</div>' : '')
    + '<div class="refl-meta">'
    + '<span>来源 <b>' + esc(sourceTypeLabel(item.sourceType)) + '</b></span>'
    + '<span>出处 <b>' + esc(dash(item.sourceRef)) + '</b></span>'
    + '</div>'
    + '<div class="alert-actions">'
    + '<button class="btn btn--sm" data-act="quar-release" data-id="' + esc(item.id)
    + '" data-confirm="核验放行这条隔离内容">释放</button>'
    + '<button class="btn btn--sm btn--danger" data-act="quar-purge" data-id="' + esc(item.id)
    + '" data-confirm="销毁这条隔离内容的摘录">清除</button>'
    + '</div>'
    + '</div>').join('')
}

/**
 * 工具名 → 这个工具是干什么的。
 *
 * 弱技能表原来只有一列 `bash.exec`——名字准，但读者不知道这活儿是干嘛的，
 * 也就没法判断「这技能老出错」要不要当回事。未知工具显示「—」，不猜。
 */
const TOOL_PURPOSE = {
  'bash.exec': '执行命令行',
  'shell.exec': '执行命令行',
  read: '读文件',
  write: '写文件',
  edit: '改文件',
  glob: '按路径找文件',
  grep: '搜文件内容',
  pwsh: '跑 PowerShell 命令',
  brain_search: '查外置大脑的记忆',
  brain_remember: '往大脑里记一条',
  brain_forget: '删掉一条记忆',
  brain_reflection: '处理反思候选',
  fox_think: '记下我自己的判断',
  fox_feel: '记下情绪反应',
  send_meme: '发表情包',
  web_search: '搜网页',
  web_fetch: '抓网页内容',
  computer_click: '点鼠标',
  computer_type: '敲键盘输入',
  screen_observe: '看屏幕',
  app_launch: '启动应用',
  ask_user_question: '向主人提问',
  team_task_list: '看团队任务',
  team_task_create: '建团队任务',
  team_task_update: '更新团队任务',
  team_task_get: '读一个团队任务',
  cg: '灵枢认知图',
  lingshu_cg: '灵枢认知图（旧名）',
  stg: '语义时空图',
  learn_meme: '收录表情包',
  present: '交付文件',
  session_search: '翻以前聊过什么',
  session_event_read: '读一次会话事件',
  skill: '加载技能说明',
}

/**
 * 把握还不高的工具。
 *
 * 这表原来叫「弱技能 / 老出错的工具」——名字是错的。判据是「把握低 **或** 连续失败」，
 * 而实测下来绝大多数条目只是**调用次数太少**（`fox_feel` 用过 3 次、失败 0 次，
 * 照样上榜）。叫「老出错」等于冤枉它们，也会让人误判「我的工具坏了」。
 *
 * 所以标题改成「把握还不高的工具」，并在表头下说清两种成因；原因那列直接给出是哪一种。
 * 只读：这个模块刻意不自动改写调用步骤，页面也不给「修」的按钮。
 */
/**
 * 这张表的「原因」列。
 *
 * 不能照抄后端：后端只给「低置信度 / 连续失败」两个标签，而表下的判据说明
 * 让读者按成因分「真失败过」和「只是用得少」。照抄的话四行全写「低把握」，
 * 那句说明就成了空话——表格自己没区分，还指望读者去数「失败」列。
 * 这里按调用数据直接说清是哪一种。
 */
function weakSkillReason(item) {
  const streak = Number(item.consecutiveFailures) || 0
  const failures = Number(item.failures) || 0
  const attempts = Number(item.attempts) || 0
  if (streak > 0) return '连续失败 ' + streak + ' 次'
  if (failures > 0) return '失败过 ' + failures + ' 次'
  if (attempts > 0) return '只用了 ' + attempts + ' 次，样本少'
  return '把握还没上来'
}

function weakSkillsPanel(weakSkills) {
  if (!weakSkills.length) {
    return '<div class="empty"><strong>没有把握低的工具</strong>'
      + '<span>没有工具同时满足「把握低」或「连续失败」两个条件。'
      + '这个模块只做计数与把握度，不会自动改写调用步骤。</span></div>'
  }
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr>'
    + '<th>工具</th><th>用途</th><th>用过</th><th>失败</th><th>连续失败</th><th>把握</th><th>原因</th><th>更新</th>'
    + '</tr></thead><tbody>' + weakSkills.map((item) => '<tr>'
      + '<td class="title"><code>' + esc(item.skillKey) + '</code></td>'
      + '<td class="muted">' + esc(TOOL_PURPOSE[item.skillKey] || '—') + '</td>'
      + '<td class="num">' + esc(num(item.attempts)) + '</td>'
      + '<td class="num">' + esc(num(item.failures)) + '</td>'
      + '<td class="num">' + esc(num(item.consecutiveFailures)) + '</td>'
      + '<td class="num" title="' + esc(item.confidence.toFixed(2)) + '">'
      + esc(confidenceLabel(item.confidence)) + '</td>'
      // 成因自己算（见 weakSkillReason）：后端标签分不出「失败过」和「只是用得少」
      + '<td class="muted">' + esc(weakSkillReason(item)) + '</td>'
      + '<td class="when">' + esc(fmtWhen(item.updatedAt)) + '</td>'
      + '</tr>').join('') + '</tbody></table></div>'
      // 一句判据说明：这张表混着「真出过错」和「只是用得少」两种，不说清会被误读成本事差
      + '<p class="tbl-note">上榜有两种原因：<b>真失败过</b>，或者<b>只用过两三次、样本太少</b>。'
      + '看「失败」列和「原因」列区分——失败 0 的那几个只是用得不熟，不是坏了。</p>'
}

/**
 * 渲染类脑页。
 *
 * @param {{ scopeId?: string, view?: ReturnType<typeof collectCognitionView> }} [opts]
 * @returns {string}
 */
export function renderCognitionPage(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const view = o.view && typeof o.view === 'object' ? o.view : null
  const scopeId = String(o.scopeId == null ? (view ? view.scopeId : '') : o.scopeId)
  const v = view || {
    unavailable: '页面没拿到数据（collectCognitionView 没有调用）。',
    scopeId,
    stats: null,
    alerts: [],
    reflections: [],
    quarantine: [],
    weakSkills: [],
    errors: [],
  }
  const openAlerts = v.alerts.filter((a) => a.status === 'open').length
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

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 类脑</title>
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
/* ── 这一页自己的部分：诊断条 / 五格统计的排布 / 告警卡 / 反思卡与隔离卡 ──
   骨架、面板（.panel 系列）、标签（.chip）、表格（.tbl）、按钮（.btn）、空态、
   说明条全在 theme.js 的组件层里，页面不再复写。 */

.diag{margin:0 0 18px;padding:11px 16px;border-radius:var(--r-sm);font-size:13px;
  background:var(--card);border:1px solid var(--line);border-left:2px solid var(--line);
  line-height:1.7;box-shadow:0 1px 2px rgba(23,32,60,.04)}
.diag.warn{border-left-color:var(--warn);background:var(--warn-soft);color:#9a5f0d}

/* 告警中心是唯一「现在就得管」的区域：只给头带一层红软底，卡片本身仍是中性底。
   六条告警一起把整卡染红就分不出轻重了。 */
.panel.alerts .panel-head{background:var(--bad-soft);border-bottom-color:rgba(214,69,69,.20)}

/* 五格统计：数字是主角，一行铺开；1px 的 --line 做格线。窄屏 5 → 3 → 2 折。 */
.stats{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:1px;background:var(--line)}
.stats .stat{border-right:none;padding:16px 20px}
.stats .stat-v{font-size:1.63rem}
.stats .stat-n{font-size:11.5px;color:var(--muted)}
@media(max-width:900px){.stats{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media(max-width:620px){.stats{grid-template-columns:repeat(2,minmax(0,1fr))}}

/* 告警：左边一道 2px 状态线区分严重度，比整块换底色克制。 */
.alert{border:1px solid var(--line);border-left:2px solid var(--line);border-radius:var(--r);
  padding:13px 16px;margin-bottom:10px;background:var(--card);
  transition:background var(--dur-fast) var(--ease-soft),border-color var(--dur-fast)}
.alert:hover{background:var(--raise)}
.alert.sev-high{border-left-color:var(--bad)}
.alert.sev-medium{border-left-color:var(--warn)}
.alert.sev-low{border-left-color:var(--faint)}
.alert.sev-info{border-left-color:var(--line)}
.alert-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.sev-badge{font-size:10.5px;font-weight:600;padding:1.5px 7px;border-radius:4px;
  letter-spacing:.04em;font-family:var(--mono);line-height:1.6}
.sev-badge.high{background:var(--bad-soft);color:var(--bad)}
.sev-badge.medium{background:var(--warn-soft);color:var(--warn)}
.sev-badge.low,.sev-badge.info{background:var(--raise);color:var(--muted)}
.alert-title{font-size:14px;font-weight:600;word-break:break-word;color:var(--ink)}
.alert-when{font-family:var(--mono);font-size:11px;color:var(--faint);margin-left:auto;
  white-space:nowrap;font-variant-numeric:tabular-nums}
.alert-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-top:6px}
.alert-meta code{font-size:11px}
.alert-detail{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:6px;
  white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.alert-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}

/* 反思 / 隔离：同一套卡片语言，内部排布是这页独有的 */
.refl,.quar{border:1px solid var(--line);border-radius:var(--r);padding:13px 16px;
  margin-bottom:10px;background:var(--card);
  transition:background var(--dur-fast) var(--ease-soft)}
.refl:hover,.quar:hover{background:var(--raise)}
.refl-top,.quar-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.refl-text{font-size:13.5px;line-height:1.6;word-break:break-word;color:var(--ink-2)}
/* 反思卡片里的「它说的是哪件事」：从证据 id 回查的一句摘要。
   灰底 + 左细线，跟上面那句结构化描述分开——一个是结论，一个是依据。 */
.refl-quote{margin-top:7px;padding:7px 11px;border-radius:6px;background:var(--card-2);
  border-left:2px solid var(--line);font-size:12px;color:var(--muted);line-height:1.7;
  word-break:break-word}
.refl-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-top:6px}
.refl-meta b{font-family:var(--mono);font-weight:550;color:var(--ink);margin-left:4px;
  font-variant-numeric:tabular-nums}
/* 隔离摘录：凹槽底 + 左侧 hairline，读起来是「引用的原文」而不是本页正文 */
.quar-excerpt{font-size:12px;color:var(--ink-2);background:var(--card-2);
  border-left:2px solid var(--line);border-radius:0 var(--r-sm) var(--r-sm) 0;
  padding:7px 11px;margin-top:8px;word-break:break-word;white-space:pre-wrap;
  max-height:110px;overflow:auto}

/* theme 的 .btn 只差一个待确认态 */
.btn.armed{border-color:var(--bad);background:var(--bad-soft);color:var(--bad);font-weight:600}

/* 把握还不高的工具表：theme 的 .tbl 给结构与数字列，这里只补列宽与语气 */
/* 表格下面的判据说明：这张表混着「真失败」和「用得少」，不说清会被读成「本事差」 */
.tbl-note{margin:10px 2px 0;font-size:11.5px;color:var(--muted);line-height:1.75}
.tbl-note b{color:var(--ink-2);font-weight:600}
.tbl-wrap{overflow-x:auto}
.tbl td.title{max-width:340px;word-break:break-word}
.tbl td.when{font-family:var(--mono);font-size:11px;color:var(--faint);white-space:nowrap;
  font-variant-numeric:tabular-nums}
.tbl td.muted{color:var(--muted);font-size:11.5px}
.tbl code{font-size:11.5px}

#err{display:none;margin:0 0 16px;padding:11px 15px;border-radius:var(--r-sm);
  border:1px solid var(--line);border-left:2px solid var(--bad);
  background:var(--bad-soft);color:#a03c3c;font-size:12.5px;line-height:1.6}
#err.show{display:block}

/* theme 的 .note 是 margin:0（面板脚用），这页它独立成段，需要一点间距 */
.note{margin-top:22px}
.note code{font-size:11.5px}
</style>
</head>
<body>
<div class="wrap">
  ${renderPageHead({
    active: 'cognition',
    title: '类脑',
    sub: '告警 · 被打分的记忆 · 反思 · 拦下的内容 · 工具。只有告警需要立刻处理，所以它在第一屏，统计排在后面。'
  })}
  <div class="path">scope: ${esc(scopeId)} · /dsh-brain/api/cognition · 生成于 ${esc(fmtWhen(v.at))}</div>

  <div id="err"></div>
  ${unavailableBox}
  ${errorsBox}
  ${schemaBox}

  <div class="panel alerts">
    <div class="panel-head">
      <span class="panel-title">告警中心</span>
      <span class="panel-meta">${esc(String(openAlerts))} 条未处理 / 共 ${esc(String(v.alerts.length))} 条</span>
    </div>
    <div class="panel-body">${alertsPanel(v)}</div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">五格统计</span>
      <span class="panel-meta">${v.stats && v.stats.lastCheckedAt ? '体检于 ' + esc(fmtWhen(v.stats.lastCheckedAt)) : '还没体检'}</span>
    </div>
    <div class="panel-body">${statsGrid(v.stats)}</div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">反思候选</span>
      <span class="panel-meta">${esc(String(v.reflections.length))} 条待处理</span>
    </div>
    <div class="panel-body">${reflectionsPanel(v.reflections)}</div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">免疫隔离区</span>
      <span class="panel-meta">${esc(String(v.quarantine.length))} 条隔离中</span>
    </div>
    <div class="panel-body">${quarantinePanel(v.quarantine)}</div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">把握还不高的工具</span>
      <span class="panel-meta">${esc(String(v.weakSkills.length))} 条</span>
    </div>
    <div class="panel-body">${weakSkillsPanel(v.weakSkills)}</div>
  </div>

  <p class="note">
    <b>这页为什么存在：</b>五个模块的产出都只是库里的行。没有人看，它们就等于没发生。
    其中<b>只有告警需要立刻处理</b>（库锁、备份缺失、outbox 堆积、WAL 偏大），
    所以告警排第一屏，统计是「知道大概」排在它后面。
    反思晋升与隔离释放都是<b>人的判断</b>：模块刻意不自动做，页面必须给得出按钮，
    否则「让人看」就变成「看得到但动不了」。所有操作写库前都要过同源保护。
  </p>

  <div class="foot">
    <span>数据来自 /dsh-brain/api/cognition</span>
    <span style="flex:1"></span>
    <a href="/dsh-brain">回记忆</a>
  </div>
</div>
<script>
(function(){
  var ACTIONS = {
    'alert-ack': '/dsh-brain/api/cognition/alert/ack',
    'alert-resolve': '/dsh-brain/api/cognition/alert/resolve',
    'refl-promote': '/dsh-brain/api/cognition/reflection/promote',
    'refl-dismiss': '/dsh-brain/api/cognition/reflection/dismiss',
    'quar-release': '/dsh-brain/api/cognition/quarantine/release',
    'quar-purge': '/dsh-brain/api/cognition/quarantine/purge'
  };

  function failText(e){
    return (e && e.message) ? e.message : String(e);
  }
  function send(url, body, btn){
    var err = document.getElementById('err');
    if (err){ err.className = ''; err.textContent = ''; }
    btn.disabled = true;
    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Brain-Action': '1' },
      body: JSON.stringify(body)
    }).then(function(r){
      return r.json().catch(function(){ return { ok: false, message: '服务端返回的不是 JSON' }; });
    }).then(function(d){
      if (!d || d.ok !== true){ throw new Error((d && d.message) ? String(d.message) : '写操作失败'); }
      location.reload();
    }).catch(function(e){
      if (err){ err.className = 'show'; err.textContent = '写操作没成功：' + failText(e); }
      btn.disabled = false;
      btn.className = 'btn btn--sm';
      btn.textContent = btn.getAttribute('data-original') || '重试';
    });
  }

  // 两步确认：第一下只上膛，四秒后自动复位。写操作全是「改库」，一点就生效。
  var armed = null;
  function disarm(btn){
    if (!btn) return;
    btn.textContent = btn.getAttribute('data-original') || '操作';
    btn.className = btn.getAttribute('data-base-class') || 'btn btn--sm';
    if (armed === btn) armed = null;
  }
  document.addEventListener('click', function(event){
    var btn = event.target && event.target.closest ? event.target.closest('button[data-act]') : null;
    if (!btn) return;
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
    var url = ACTIONS[btn.getAttribute('data-act')];
    if (!url){ return; }
    send(url, { id: btn.getAttribute('data-id') }, btn);
  });
})();
</script>
</body>
</html>`
}
