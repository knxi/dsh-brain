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

import { renderNav } from './nav.js'

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

/** 反思 kind 中文。 */
const REFLECTION_KIND_LABELS = {
  commitment: '未完成的承诺',
  knowledge_gap: '知识缺口',
  pattern: '行为模式',
  diary: '自我日记',
  dream: '梦境整理',
  premonition: '行动预演',
  contradiction: '发现的矛盾',
}

/** 告警状态中文。 */
const ALERT_STATUS_LABELS = {
  open: '未处理',
  acked: '已确认',
  resolved: '已解决',
  expired: '已过期',
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

  const reflectionsRaw = safe(() => cog.reflect.list({ scopeId, status: 'candidate', limit }), null)
  const reflections = ((reflectionsRaw && reflectionsRaw.items) || []).map((item) => ({
    id: String(item.id),
    kind: String(item.kind),
    text: String(item.text),
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
  const cells = [
    { k: '显著性标记', v: stats.salience, note: '被标记上权重的记忆' },
    { k: '反思候选', v: stats.reflectCandidate, note: '累计反思运行 ' + num(stats.reflectRuns) + ' 次' },
    { k: '弱技能', v: stats.weakSkills, note: '共 ' + num(stats.skills) + ' 个技能在册' },
    { k: '隔离条目', v: stats.quarantined, note: '命中但还没核验' },
    { k: '未处理告警', v: stats.alertsOpen, note: '最坏 ' + dash(stats.worstSeverity === null ? null : (SEVERITY_META[stats.worstSeverity] || {}).label || stats.worstSeverity) },
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
    buttons.push('<button class="btn small" data-act="alert-ack" data-id="' + esc(alert.id)
      + '" data-confirm="确认告警 ' + esc(alert.code) + '">已知悉</button>')
    buttons.push('<button class="btn small" data-act="alert-resolve" data-id="' + esc(alert.id)
      + '" data-confirm="解决告警 ' + esc(alert.code) + '">标记解决</button>')
  } else if (alert.status === 'acked') {
    buttons.push('<button class="btn small" data-act="alert-resolve" data-id="' + esc(alert.id)
      + '" data-confirm="解决告警 ' + esc(alert.code) + '">标记解决</button>')
  }
  const detail = alert.detail && Object.keys(alert.detail).length > 0
    ? '<div class="alert-detail">' + esc(JSON.stringify(alert.detail)) + '</div>'
    : ''
  return '<div class="alert sev-' + esc(sev.cls) + '">'
    + '<div class="alert-top">'
    + '<span class="sev-badge ' + esc(sev.cls) + '">' + esc(sev.label) + '</span>'
    + '<span class="alert-title">' + esc(alert.title) + '</span>'
    + '<span class="chip st-' + esc(alert.status) + '">' + esc(ALERT_STATUS_LABELS[alert.status] || alert.status) + '</span>'
    + '<span class="alert-when">' + esc(fmtWhen(alert.lastSeenAt)) + '</span>'
    + '</div>'
    + '<div class="alert-meta">'
    + '<code>' + esc(alert.code) + '</code>'
    + '<span>模块 ' + esc(dash(alert.module)) + '</span>'
    + '<span>出现 ' + esc(num(alert.occurrences)) + ' 次</span>'
    + '<span>首次 ' + esc(fmtWhen(alert.firstSeenAt)) + '</span>'
    + (alert.ackedBy ? '<span>确认人 ' + esc(alert.ackedBy) + '</span>' : '')
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
    + '<span class="chip kind">' + esc(REFLECTION_KIND_LABELS[item.kind] || item.kind) + '</span>'
    + '<span class="refl-text">' + esc(item.text) + '</span>'
    + '</div>'
    + '<div class="refl-meta">'
    + '<span>置信度 <b>' + esc(item.confidence.toFixed(2)) + '</b></span>'
    + '<span>证据 <b>' + esc(num(item.evidenceCount)) + '</b> 条</span>'
    + '<span>产出 <b>' + esc(fmtWhen(item.createdAt)) + '</b></span>'
    + '</div>'
    + '<div class="alert-actions">'
    + '<button class="btn small" data-act="refl-promote" data-id="' + esc(item.id)
    + '" data-confirm="把这条反思晋升进记忆">晋升为记忆</button>'
    + '<button class="btn small danger" data-act="refl-dismiss" data-id="' + esc(item.id)
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
    + '<span>来源 <b>' + esc(dash(item.sourceType)) + '</b></span>'
    + '<span>ref <b>' + esc(dash(item.sourceRef)) + '</b></span>'
    + '</div>'
    + '<div class="alert-actions">'
    + '<button class="btn small" data-act="quar-release" data-id="' + esc(item.id)
    + '" data-confirm="核验放行这条隔离内容">释放</button>'
    + '<button class="btn small danger" data-act="quar-purge" data-id="' + esc(item.id)
    + '" data-confirm="销毁这条隔离内容的摘录">清除</button>'
    + '</div>'
    + '</div>').join('')
}

/** 弱技能：只读。这个模块刻意不自动改写步骤，页面也不给「修」的按钮。 */
function weakSkillsPanel(weakSkills) {
  if (!weakSkills.length) {
    return '<div class="empty"><strong>没有弱技能</strong>'
      + '<span>没有技能同时满足「低置信度」或「连续失败」两个条件。'
      + '这个模块只做计数与置信度，不会自动改写技能步骤。</span></div>'
  }
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr>'
    + '<th>技能</th><th>尝试</th><th>失败</th><th>连续失败</th><th>置信度</th><th>原因</th><th>更新</th>'
    + '</tr></thead><tbody>' + weakSkills.map((item) => '<tr>'
      + '<td class="title"><code>' + esc(item.skillKey) + '</code></td>'
      + '<td class="n">' + esc(num(item.attempts)) + '</td>'
      + '<td class="n">' + esc(num(item.failures)) + '</td>'
      + '<td class="n">' + esc(num(item.consecutiveFailures)) + '</td>'
      + '<td class="n">' + esc(item.confidence.toFixed(2)) + '</td>'
      + '<td class="muted">' + esc(item.reasons.join(' / ') || '–') + '</td>'
      + '<td class="when">' + esc(fmtWhen(item.updatedAt)) + '</td>'
      + '</tr>').join('') + '</tbody></table></div>'
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
  color-scheme:dark;
  --paper:#0a0b0d; --card:#111419; --card-2:#0c0e11; --raise:#181c22; --sunken:#07080a;
  --ink:#e9ebee; --ink-2:#b7bdc7; --muted:#79818d; --faint:#4b525c;
  --line:#232831; --line-2:#333b46; --line-soft:rgba(255,255,255,.055);
  --accent:#e3a662; --accent-line:rgba(227,166,98,.34); --accent-soft:rgba(227,166,98,.10);
  --ochre:var(--accent); --ochre-soft:var(--accent-soft);
  --ok:#5cc08c; --ok-soft:rgba(92,192,140,.10);
  --warn:#d9a253; --warn-soft:rgba(217,162,83,.10);
  --bad:#dd6b5c; --bad-soft:rgba(221,107,92,.10);
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  --r:10px; --r-sm:6px; --ease:cubic-bezier(.2,0,0,1);
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.65 var(--sans);
  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;
  background-image:linear-gradient(to right,rgba(255,255,255,.022) 1px,transparent 1px),
    linear-gradient(to bottom,rgba(255,255,255,.022) 1px,transparent 1px);
  background-size:64px 64px;
  -webkit-mask-image:radial-gradient(ellipse 110% 70% at 50% 0%,#000,transparent 72%);
  mask-image:radial-gradient(ellipse 110% 70% at 50% 0%,#000,transparent 72%)}
body::after{content:"";position:fixed;inset:0 0 auto 0;height:420px;z-index:0;pointer-events:none;
  background:radial-gradient(ellipse 68% 100% at 50% -22%,rgba(126,158,204,.075),transparent 70%)}
::selection{background:rgba(227,166,98,.26);color:#fff}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}
code{font-family:var(--mono);font-size:.92em;background:var(--raise);color:var(--ink-2);
  padding:1px 5px;border-radius:4px}
b,strong{font-weight:620;color:var(--ink)}
em{font-style:normal;color:var(--accent)}
h1{font-size:20px;font-weight:600;letter-spacing:-.012em;margin:0;line-height:1.25;
  display:flex;align-items:center;gap:9px}
h1::before{content:"";width:5px;height:5px;border-radius:1px;background:var(--accent);
  box-shadow:0 0 9px rgba(227,166,98,.5);flex:none}
.sub{color:var(--muted);font-size:12.5px}
.head{display:flex;align-items:baseline;gap:12px;margin-bottom:2px;flex-wrap:wrap}
.path{font-family:var(--mono);font-size:11px;color:var(--faint);margin:4px 0 22px;
  letter-spacing:.01em;word-break:break-all}
.path::after{content:"";display:block;height:1px;margin-top:16px;
  background:linear-gradient(90deg,var(--line-2),var(--line-soft) 55%,transparent 88%)}
.wrap{position:relative;z-index:1;max-width:1080px;margin:0 auto;padding:34px 30px 88px}
.wrap.wrap--wide{max-width:1200px}
.foot{margin-top:36px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);
  font-size:11.5px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}
.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}
*{scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}
::-webkit-scrollbar{width:10px;height:10px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:#242a32;border-radius:8px;border:3px solid var(--paper)}
::-webkit-scrollbar-thumb:hover{background:#39414d}
:focus-visible{outline:1.5px solid var(--accent-line);outline-offset:2px;border-radius:3px}
.nav{display:flex;gap:2px;margin-left:auto;flex-wrap:wrap;align-items:center}
.navlink{font-size:12.5px;letter-spacing:.01em;padding:6px 11px;border:1px solid transparent;
  border-radius:var(--r-sm);background:transparent;color:var(--muted);text-decoration:none;
  transition:color .14s var(--ease),background .14s var(--ease),border-color .14s var(--ease);
  white-space:nowrap}
.navlink:hover{border-color:var(--line);background:var(--raise);color:var(--ink);
  text-decoration:none}
.navlink.active{border-color:var(--accent-line);background:var(--accent-soft);
  color:var(--accent);font-weight:560}
.navlink.active:hover{color:var(--accent)}
/* ══ THEME:END ══ */
/* ── 这一页自己的部分：诊断条 / 卡片 / 五格统计 / 标签 / 告警 / 反思 / 隔离 / 表格 ──
   骨架（底、标题区、路径行、页脚、导航）全在标记区里，这里不重复。 */

.diag{margin:0 0 18px;padding:12px 16px;border-radius:var(--r-sm);font-size:13px;
  background:var(--card);border:1px solid var(--line);border-left:2px solid var(--line-2);
  line-height:1.7}
.diag.warn{border-left-color:var(--warn);background:var(--warn-soft);color:var(--warn)}

.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
  margin-bottom:20px;overflow:hidden}
.card-head{display:flex;align-items:baseline;gap:10px;padding:13px 20px;
  border-bottom:1px solid var(--line);background:var(--card-2);flex-wrap:wrap}
.card-title{font-size:13.5px;font-weight:620}
.card-meta{font-size:11.5px;color:var(--muted);margin-left:auto;font-family:var(--mono);
  font-variant-numeric:tabular-nums}
.body{padding:14px 20px 18px}
/* 告警中心是唯一「现在就得管」的区域：只给头带一层红软底，卡片本身仍是中性底。
   六条告警一起把整卡染红就分不出轻重了。 */
.card.alerts .card-head{background:var(--bad-soft);border-bottom-color:rgba(221,107,92,.22)}

/* 五格统计：数字是主角，一行铺开，窄屏折行。 */
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:var(--r);overflow:hidden}
.stat{background:var(--card);padding:16px 20px;display:flex;flex-direction:column;gap:3px;min-width:0}
.stat-k{font-size:10.5px;color:var(--muted);letter-spacing:.08em;white-space:nowrap;text-transform:uppercase}
.stat-v{font-size:26px;font-weight:560;font-family:var(--mono);font-variant-numeric:tabular-nums;
  letter-spacing:-.01em;line-height:1.15;color:var(--ink)}
.stat-n{font-size:11.5px;color:var(--muted);line-height:1.45}
@media(max-width:900px){.stats{grid-template-columns:repeat(3,1fr)}}
@media(max-width:620px){.stats{grid-template-columns:repeat(2,1fr)}}

/* 标签：等宽小字 + 软底。默认中性——只有「要人停一下」的状态才上色。 */
.chip{display:inline-block;font-size:10.5px;padding:1.5px 7px;border-radius:4px;
  border:1px solid var(--line);color:var(--muted);background:var(--raise);
  font-family:var(--mono);letter-spacing:.01em;white-space:nowrap;line-height:1.6}
.chip.kind{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.chip.st-open{color:var(--bad);border-color:rgba(221,107,92,.30);background:var(--bad-soft)}
.chip.st-acked{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.chip.st-resolved{color:var(--ok);border-color:rgba(92,192,140,.30);background:var(--ok-soft)}
.chip.st-expired{color:var(--faint);background:transparent;border-color:var(--line)}

/* 告警：左边一道 2px 状态线区分严重度，比整块换底色克制。 */
.alert{border:1px solid var(--line);border-left:2px solid var(--line-2);border-radius:var(--r);
  padding:13px 16px;margin-bottom:10px;background:var(--card);
  transition:background .14s var(--ease)}
.alert:hover{background:var(--raise)}
.alert.sev-high{border-left-color:var(--bad)}
.alert.sev-medium{border-left-color:var(--warn)}
.alert.sev-low{border-left-color:var(--line-2)}
.alert.sev-info{border-left-color:var(--line)}
.alert-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.sev-badge{font-size:10.5px;font-weight:600;padding:1.5px 7px;border-radius:4px;
  letter-spacing:.04em;font-family:var(--mono);line-height:1.6}
.sev-badge.high{background:var(--bad-soft);color:var(--bad)}
.sev-badge.medium{background:var(--warn-soft);color:var(--warn)}
.sev-badge.low{background:var(--raise);color:var(--muted)}
.sev-badge.info{background:var(--raise);color:var(--muted)}
.alert-title{font-size:14px;font-weight:600;word-break:break-word;color:var(--ink)}
.alert-when{font-family:var(--mono);font-size:11px;color:var(--faint);margin-left:auto;
  white-space:nowrap;font-variant-numeric:tabular-nums}
.alert-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-top:6px}
.alert-meta code{font-size:11px}
.alert-detail{font-family:var(--mono);font-size:11px;color:var(--muted);margin-top:6px;
  white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.alert-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}

/* 反思 / 隔离：同一套卡片语言 */
.refl,.quar{border:1px solid var(--line);border-radius:var(--r);padding:13px 16px;
  margin-bottom:10px;background:var(--card);transition:background .14s var(--ease)}
.refl:hover,.quar:hover{background:var(--raise)}
.refl-top,.quar-top{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.refl-text{font-size:13.5px;line-height:1.6;word-break:break-word;color:var(--ink-2)}
.refl-meta{display:flex;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);margin-top:6px}
.refl-meta b{font-family:var(--mono);font-weight:550;color:var(--ink);margin-left:4px;
  font-variant-numeric:tabular-nums}
/* 隔离摘录：凹槽底 + 左侧 hairline，读起来是「引用的原文」而不是本页正文 */
.quar-excerpt{font-size:12px;color:var(--ink-2);background:var(--sunken);
  border-left:2px solid var(--line);border-radius:0 var(--r-sm) var(--r-sm) 0;
  padding:7px 11px;margin-top:8px;word-break:break-word;white-space:pre-wrap;
  max-height:110px;overflow:auto}

/* 按钮：暗底上一个中性方框，hover 只把边框提亮；armed 是待确认态，danger 只到 hover 才红。 */
.btn{font:inherit;font-size:12.5px;padding:6px 13px;border-radius:var(--r-sm);
  border:1px solid var(--line);background:var(--card);color:var(--ink-2);cursor:pointer;
  transition:border-color .14s var(--ease),color .14s var(--ease),background .14s var(--ease)}
.btn:hover{border-color:var(--line-2);background:var(--raise);color:var(--ink)}
.btn:active{transform:translateY(.5px)}
.btn.small{font-size:12px;padding:5px 11px}
.btn.danger:hover{border-color:var(--bad);color:var(--bad);background:var(--bad-soft)}
.btn.armed{border-color:var(--bad);background:var(--bad-soft);color:var(--bad);font-weight:600}
.btn[disabled]{opacity:.4;cursor:not-allowed}

/* 弱技能表：表头一道线，行间用 hairline，数字等宽右对齐。 */
.tbl-wrap{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.tbl th{text-align:left;font-weight:600;color:var(--muted);font-size:10.5px;
  letter-spacing:.08em;text-transform:uppercase;padding:8px 10px;
  border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.tbl tr:last-child td{border-bottom:none}
.tbl tbody tr:hover{background:rgba(255,255,255,.02)}
.tbl td.title{max-width:340px;word-break:break-word}
.tbl td.n{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.tbl td.when{font-family:var(--mono);font-size:11px;color:var(--faint);white-space:nowrap;
  font-variant-numeric:tabular-nums}
.tbl td.muted{color:var(--muted);font-size:11.5px}
.tbl code{font-size:11.5px}

.empty{padding:30px 0 32px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}
.empty strong{display:block;color:var(--ink);font-size:14.5px;font-weight:620;margin-bottom:6px}
.empty span{display:block;max-width:560px;margin:0 auto}

#err{display:none;margin:0 0 16px;padding:11px 15px;border-radius:var(--r-sm);
  border:1px solid var(--line);border-left:2px solid var(--bad);
  background:var(--bad-soft);color:var(--bad);font-size:12.5px;line-height:1.6}
#err.show{display:block}

.note{font-size:12px;color:var(--muted);margin-top:22px;padding:13px 17px;
  border-left:2px solid var(--line-2);line-height:1.85}
.note b{color:var(--ink);font-weight:600}
.note code{font-size:11.5px}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>类脑</h1>
    <span class="sub">告警 · 显著性 · 反思 · 免疫 · 技能</span>
    ${renderNav({ active: 'cognition' })}
  </div>
  <div class="path">scope: ${esc(scopeId)} · /dsh-brain/api/cognition · 生成于 ${esc(fmtWhen(v.at))}</div>

  <div id="err"></div>
  ${unavailableBox}
  ${errorsBox}
  ${schemaBox}

  <div class="card alerts">
    <div class="card-head">
      <span class="card-title">告警中心</span>
      <span class="card-meta">${esc(String(openAlerts))} 条未处理 / 共 ${esc(String(v.alerts.length))} 条</span>
    </div>
    <div class="body">${alertsPanel(v)}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">五格统计</span>
      <span class="card-meta">${v.stats && v.stats.lastCheckedAt ? '体检于 ' + esc(fmtWhen(v.stats.lastCheckedAt)) : '还没体检'}</span>
    </div>
    <div class="body">${statsGrid(v.stats)}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">反思候选</span>
      <span class="card-meta">${esc(String(v.reflections.length))} 条待处理</span>
    </div>
    <div class="body">${reflectionsPanel(v.reflections)}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">免疫隔离区</span>
      <span class="card-meta">${esc(String(v.quarantine.length))} 条隔离中</span>
    </div>
    <div class="body">${quarantinePanel(v.quarantine)}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">弱技能</span>
      <span class="card-meta">${esc(String(v.weakSkills.length))} 条</span>
    </div>
    <div class="body">${weakSkillsPanel(v.weakSkills)}</div>
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
      btn.className = 'btn small';
      btn.textContent = btn.getAttribute('data-original') || '重试';
    });
  }

  // 两步确认：第一下只上膛，四秒后自动复位。写操作全是「改库」，一点就生效。
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
    var url = ACTIONS[btn.getAttribute('data-act')];
    if (!url){ return; }
    send(url, { id: btn.getAttribute('data-id') }, btn);
  });
})();
</script>
</body>
</html>`
}
