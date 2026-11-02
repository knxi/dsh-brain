// @ts-check
/**
 * 外置大脑 · 工作空间页（/dsh-brain/workspace）
 *
 * ── 这页要解决什么 ──
 *
 * 系统 3 的通信面（`packages/workspace`）在跑，但主人只能从我的行为里猜：
 * 自主到底开没开、现在注意力在哪、有哪些候选在排队、最近发生过什么。
 * 这四件事全是「看不见就没法核」的东西——尤其开关，它是逃生门。
 *
 * 所以这页只做四块，按「先能停、再看在干嘛、最后看流水」排：
 *   1. 开关（含全局暂停）——**每一次改动都要两步确认**；
 *   2. 注意力焦点（当前在做什么、优先级、还剩多久）；
 *   3. 候选队列（等仲裁的东西 + 凭什么在那里）；
 *   4. 最近事件流（channel / 来源模块 / kind / 时间）。
 *
 * ── 为什么服务端把数据直接渲进 HTML ──
 *
 * 心情页是「骨架 + 前端 fetch 填」。这页不一样：开关与候选是**当前状态**，
 * 首屏就该看得见；而且这页的写操作是「点一下改全局」，一旦前端脚本挂了，
 * 只给一个空壳页面反而更危险（人以为开关是关的，其实开着）。
 * 所以数据在服务端渲染，前端脚本只负责「交互」：切换、筛选、两步确认。
 *
 * ── 两条安全纪律 ──
 *
 * 1. **两步确认**：所有写按钮第一次点击只进入「待确认」，第二次才发请求。
 *    这不是防误触的装饰——`paused` 一开全局停，`autonomy.enabled` 一开
 *    自主指令就能排队，两个都不该一点就变。
 * 2. **写请求一律 POST + `X-Brain-Action: 1`**（和矛盾核验同一套同源保护）。
 *    页面里不许出现 GET 改状态的写法。
 *
 * 缺字段一律显示「–」，不编 0：`focus === null` 是「没有焦点」，不是「优先级 0」。
 */

// 导航与页面骨架统一收在 nav.js（品牌条 / 标题区 / 粘性导航只在那定义一次）。
import { renderPageHead } from './nav.js?v=1793594997081'

/** 开关的中文名与语义。顺序＝契约 §6 的顺序（逃生门排最前）。 */
const SWITCH_META = [
  { name: 'autonomy.enabled', label: '自主指令', kind: 'bool', hint: '允许自主指令排队与执行' },
  { name: 'autonomy.max_level', label: '最高权限等级', kind: 'level', hint: '自主动作最高能到哪一级' },
  { name: 'social.enabled', label: '主动社交', kind: 'bool', hint: '允许生成主动开口的候选' },
  { name: 'social.allow_external', label: '允许外发', kind: 'bool', hint: '关 = 只进控制台，绝不真发' },
  { name: 'reflection.enabled', label: '空闲反思', kind: 'bool', hint: '空闲时要不要自己想事' },
  // 2026-11-02：反思候选的自动晋升。加这条是因为新开关没登记时页面会把它当
  // 「未登记的开关」原样显示成 key——能看能用，但看不懂是什么。
  { name: 'reflection.auto_promote', label: '反思自动晋升', kind: 'bool',
    hint: '反思跑完自动把候选升成记忆（只升「两条记忆打架」这类，每轮最多 3 条）' },
  { name: 'paused', label: '全局暂停', kind: 'bool', hint: '最高优先级：一开所有自主模块停手' },
]

/** 候选 kind 中文。未知值原样显示，不猜。 */
const CANDIDATE_KIND_LABELS = {
  memory_write: '写记忆',
  reflection: '反思',
  proactive: '主动开口',
  directive: '自主指令',
  maintenance: '维护',
  skill_update: '技能更新',
  quarantine: '隔离',
}

/** 候选状态中文。 */
const CANDIDATE_STATUS_LABELS = {
  proposed: '待仲裁',
  executing: '执行中',
  done: '已完成',
  rejected: '已驳回',
  expired: '已过期',
  failed: '失败',
}

/** 事件 channel 中文（0008 的 8 个枚举，一个不多一个不少）。 */
const CHANNEL_LABELS = {
  sense: '感知',
  attention: '注意',
  memory: '记忆',
  affect: '情绪',
  action: '行动',
  result: '结果',
  error: '错误',
  resource: '资源',
}

/** 候选状态 → theme 的 chip 语气（theme 只有 accent / ok / warn / bad / plain 五档）。 */
const STATUS_CHIP = {
  proposed: 'accent',
  executing: '',
  done: 'ok',
  rejected: 'bad',
  expired: 'plain',
  failed: 'bad',
}

/** 事件 channel → chip 语气：八种 channel 不配八种颜色，只有注意/结果/错误值得上色。 */
const CHANNEL_CHIP = {
  attention: 'accent',
  result: 'ok',
  error: 'bad',
}

/** 拼 chip 的 class。未知取值给中性档，不猜也不编一个没有的颜色。 */
function chipClass(map, key) {
  const tone = map[key]
  return tone ? 'chip ' + tone : 'chip'
}

/** HTML 转义：所有进模板的数据都过这一道，别靠「我记得转义」。 */
function esc(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 数据缺失一律「–」。空字符串也当缺失——空栏和「值是空」在界面上是同一件事。 */
function dash(value) {
  if (value === null || value === undefined) return '–'
  const text = String(value)
  return text.length === 0 ? '–' : text
}

/** 数字：非有限数给「–」，不把 NaN 写成 0。 */
function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? String(n) : '–'
}

/**
 * 时间显示：本地 `MM-DD HH:mm`。服务器就是主人这台机器，本地时区即主人时区。
 * 解析不了的原样返回（比猜一个时间更诚实）。
 */
function fmtWhen(value) {
  if (value === null || value === undefined || value === '') return '–'
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return String(value)
  const pad = (n) => String(n).padStart(2, '0')
  return pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

/**
 * 读最近事件流。
 *
 * 为什么直接查 `ws_events` 而不走 `workspace.pullEvents`：
 * `pullEvents` 是「按消费水位往后拉」，第一次调用会从最旧开始给，正合适做消费者，
 * 但不适合「最近发生了什么」。这页要的是倒序最新 N 条，一条只读 SQL 更准。
 * 只取展示需要的列，不读 payload（可能含正文）。
 *
 * @param {{ prepare: (sql: string) => any }} db
 * @param {string} scopeId
 * @param {number} limit
 */
function readRecentEvents(db, scopeId, limit) {
  try {
    const rows = db.prepare(
      'SELECT id, at, channel, source_module, kind, subject_type, subject_id, salience'
      + ' FROM ws_events WHERE scope_id = ? ORDER BY at_ms DESC, id DESC LIMIT ?',
    ).all(scopeId, limit)
    return rows.map((row) => ({
      id: String(row.id),
      at: row.at == null ? null : String(row.at),
      channel: row.channel == null ? null : String(row.channel),
      sourceModule: row.source_module == null ? null : String(row.source_module),
      kind: row.kind == null ? null : String(row.kind),
      subjectType: row.subject_type == null ? null : String(row.subject_type),
      subjectId: row.subject_id == null ? null : String(row.subject_id),
      salience: row.salience == null ? null : Number(row.salience),
    }))
  } catch {
    // 老库没有 0008 这张表：降级为空并让页面明说原因，不 500。
    return { unavailable: 'ws_events 表不存在或读不了（缺 0008 迁移？）', items: [] }
  }
}

/** 期望中的表名：这些缺失时说明库还没升到 0008，而不是「没有数据」。 */
const M8_TABLES = ['brain_switches', 'ws_events', 'ws_candidates', 'attention_focus']

/**
 * 把异常翻成人能判断的一句话。
 * `no such table` 是首启最常见的一种：库还停在 0007，这时页面必须说「表还没建」，
 * 而不是让主人看着一排空列表以为「系统很干净」。
 */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const missing = /no such table:\s*([A-Za-z0-9_]+)/.exec(message)
  if (missing) return missing[1] + ' 表不存在（0008 迁移未应用？）'
  return message
}

/**
 * 收集工作空间视图。
 *
 * **同步**：四个门面在这里全是同步读（写才异步），所以页面与 verify 脚本
 * 都能直接调用，不用等 Promise 链。
 *
 * @param {any} brain openBrain 的返回值
 * @param {{ scopeId: string, eventLimit?: number, candidateLimit?: number }} opts
 */
export function collectWorkspaceView(brain, opts) {
  const scopeId = String(opts && opts.scopeId ? opts.scopeId : '')
  const eventLimit = Math.min(Math.max(Number(opts && opts.eventLimit) || 40, 1), 200)
  const candidateLimit = Math.min(Math.max(Number(opts && opts.candidateLimit) || 50, 1), 200)
  const ws = brain && brain.workspace
  if (!ws) {
    return {
      unavailable: '全局工作空间门面（brain.workspace）还没接线：'
        + 'openBrain 里没构造 createWorkspace，或版本还没升上来。'
        + '这页先只显示一个空壳——**不要**把「看不到」当成「全是关的」。',
      scopeId,
      switches: [],
      focus: null,
      candidates: [],
      events: [],
      eventsUnavailable: null,
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

  const rawSwitches = safe(() => ws.listSwitches(), [])
  const byName = new Map((Array.isArray(rawSwitches) ? rawSwitches : []).map((s) => [s.name, s]))
  // 按 SWITCH_META 的顺序铺；表里多出来的开关也照实补在后面（不藏）。
  const switches = SWITCH_META.map((meta) => {
    const row = byName.get(meta.name)
    byName.delete(meta.name)
    return {
      name: meta.name,
      label: meta.label,
      kind: meta.kind,
      hint: meta.hint,
      value: row ? String(row.value) : null,
      enabled: row ? row.enabled === true : false,
      isDefault: row ? row.isDefault === true : true,
      updatedAt: row ? row.updatedAt : null,
      updatedBy: row ? row.updatedBy : null,
      reason: row ? row.reason : null,
    }
  })
  for (const row of byName.values()) {
    switches.push({
      name: row.name,
      label: row.name,
      kind: 'bool',
      hint: '未登记的开关（原样显示）',
      value: String(row.value),
      enabled: row.enabled === true,
      isDefault: row.isDefault === true,
      updatedAt: row.updatedAt,
      updatedBy: row.updatedBy,
      reason: row.reason,
    })
  }

  const focus = safe(() => ws.getFocus(), null)
  const rawCandidates = safe(() => ws.listCandidates({ limit: candidateLimit }), [])
  const candidates = (Array.isArray(rawCandidates) ? rawCandidates : []).map((item) => ({
    id: String(item.id),
    kind: String(item.kind),
    originModule: item.originModule == null ? null : String(item.originModule),
    title: String(item.title),
    score: Number(item.score) || 0,
    priority: Number(item.priority) || 0,
    status: String(item.status),
    evidenceCount: Array.isArray(item.evidence) ? item.evidence.length : 0,
    expiresAt: item.expiresAt == null ? null : String(item.expiresAt),
    createdAt: item.createdAt == null ? null : String(item.createdAt),
    reason: item.reason == null ? null : String(item.reason),
  }))

  const eventsRead = readRecentEvents(brain.db, scopeId, eventLimit)
  const events = Array.isArray(eventsRead) ? eventsRead : eventsRead.items
  const eventsUnavailable = Array.isArray(eventsRead) ? null : eventsRead.unavailable

  const wsStats = safe(() => ws.stats(), null)
  const candidateStats = safe(() => ws.candidateStats(), null)

  return {
    unavailable: null,
    scopeId,
    switches,
    focus: focus
      ? {
        kind: String(focus.kind || ''),
        ref: focus.ref == null ? null : String(focus.ref),
        label: focus.label == null ? null : String(focus.label),
        priority: Number(focus.priority) || 0,
        expiresAt: focus.expiresAt == null ? null : String(focus.expiresAt),
        expired: focus.expired === true,
        source: focus.source == null ? null : String(focus.source),
        acquiredAt: focus.acquiredAt == null ? null : String(focus.acquiredAt),
      }
      : null,
    candidates,
    events,
    eventsUnavailable,
    wsStats,
    candidateStats,
    errors,
    // 表不存在 ≠ 没有数据：页面顶部要说清楚，不然「全空」会被读成「一切正常」。
    schemaHint: errors.some((message) => message.includes('0008'))
      ? '数据库还没升到 0008：工作空间的几张表（' + M8_TABLES.join(' / ') + '）还没建。'
        + '下面的空数据是「表不存在」，不是「没有记录/没有开」；迁移跑完后刷新本页即可。'
      : null,
    at: new Date().toISOString(),
  }
}

/** 开关当前值 → 人话。等级不是布尔，不能显示「开/关」。 */
function switchValueText(sw) {
  if (!sw) return '–'
  if (sw.kind === 'level') return dash(sw.value)
  return sw.enabled ? '开' : '关'
}

/** 开关的写值预览：布尔取反，等级循环到下一级。 */
function nextSwitchValue(sw) {
  if (!sw) return null
  if (sw.kind === 'level') {
    const levels = ['L0', 'L1', 'L2', 'L3']
    const at = levels.indexOf(String(sw.value))
    return levels[(at + 1) % levels.length]
  }
  return sw.enabled ? '0' : '1'
}

/** 开关卡里那行按钮。两步确认靠 data-arm 属性 + 前端脚本，不靠 inline onclick 拼字符串。 */
function switchButton(sw) {
  const next = nextSwitchValue(sw)
  if (next === null) return ''
  const label = sw.kind === 'level' ? ('切到 ' + next) : (next === '1' ? '打开' : '关闭')
  return '<button class="btn sw-btn" data-act="switch" data-name="' + esc(sw.name) + '"'
    + ' data-value="' + esc(next) + '" data-confirm="' + esc(sw.label + ' → ' + next) + '">'
    + esc(label) + '</button>'
}

/** 单个开关卡。卡片本体用 theme 的 .switch，这里只负责把值翻成中文并给出按钮。 */
function switchCard(sw) {
  const changed = sw.isDefault ? '默认值' : (sw.updatedAt ? fmtWhen(sw.updatedAt) + ' 改过' : '改过')
  const warn = sw.name === 'paused' && sw.enabled ? ' paused-on' : ''
  return '<div class="switch' + warn + '">'
    + '<div class="switch-top"><span class="switch-name">' + esc(sw.label) + '</span>'
    + '<span class="sw-value' + (sw.enabled && sw.kind === 'bool' ? ' on' : '') + '">'
    + esc(switchValueText(sw)) + '</span></div>'
    + '<div class="switch-key">' + esc(sw.name) + '</div>'
    + '<div class="switch-desc">' + esc(sw.hint) + '</div>'
    + '<div class="sw-meta">' + esc(changed)
    + (sw.updatedBy ? ' · ' + esc(sw.updatedBy) : '') + '</div>'
    + (sw.reason ? '<div class="switch-note">' + esc(sw.reason) + '</div>' : '')
    + switchButton(sw)
    + '</div>'
}

/** 焦点卡。没有焦点时说清「没有」而不是显示一排 0。 */
function focusCard(focus) {
  if (!focus) {
    return '<div class="empty"><strong>现在没有注意力焦点</strong>'
      + '<span>没有任何模块申请焦点，或上一次焦点已经释放。'
      + '没有焦点不代表系统停摆——它只说明「此刻没有正在做的事被标记」。'
      + '</span></div>'
  }
  const chip = focus.expired
    ? '<span class="chip bad">已过期</span>'
    : '<span class="chip ok">生效中</span>'
  return '<div class="focus-box">'
    + '<div class="focus-main">'
    + '<span class="focus-kind">' + esc(focus.kind) + '</span>'
    + '<span class="focus-label">' + esc(dash(focus.label)) + '</span>'
    + chip
    + '</div>'
    + '<div class="focus-grid">'
    + '<span>优先级 <b>' + esc(num(focus.priority)) + '</b></span>'
    + '<span>到期 <b>' + esc(fmtWhen(focus.expiresAt)) + '</b></span>'
    + '<span>获得于 <b>' + esc(fmtWhen(focus.acquiredAt)) + '</b></span>'
    + '<span>来源 <b>' + esc(dash(focus.source)) + '</b></span>'
    + (focus.ref ? '<span>ref <b>' + esc(focus.ref) + '</b></span>' : '')
    + '</div>'
    + '</div>'
}

/** 候选表。空时给一句「为什么这里是空的」。 */
function candidatesTable(candidates) {
  if (!candidates.length) {
    return '<div class="empty"><strong>候选队列是空的</strong>'
      + '<span>没有模块提出候选：反思没产出、社交没生成、也没有新指令。'
      + '空队列是正常状态，不是故障。</span></div>'
  }
  const rows = candidates.map((c) => '<tr data-status="' + esc(c.status) + '" data-kind="' + esc(c.kind) + '">'
    + '<td><span class="chip accent">' + esc(CANDIDATE_KIND_LABELS[c.kind] || c.kind) + '</span></td>'
    + '<td class="title">' + esc(c.title) + '</td>'
    + '<td class="num">' + esc(num(c.score)) + '</td>'
    + '<td class="num">' + esc(num(c.priority)) + '</td>'
    + '<td><span class="' + chipClass(STATUS_CHIP, c.status) + '">'
    + esc(CANDIDATE_STATUS_LABELS[c.status] || c.status)
    + '</span></td>'
    + '<td class="num">' + esc(num(c.evidenceCount)) + '</td>'
    + '<td class="when">' + esc(fmtWhen(c.expiresAt)) + '</td>'
    + '<td class="when">' + esc(fmtWhen(c.createdAt)) + '</td>'
    + '<td class="muted">' + esc(dash(c.reason)) + '</td>'
    + '</tr>')
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr>'
    + '<th>kind</th><th>标题</th><th>分数</th><th>优先级</th><th>状态</th><th>证据</th>'
    + '<th>过期</th><th>创建</th><th>备注</th>'
    + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>'
}

/** 事件流。 */
function eventsList(events, unavailable) {
  if (unavailable) {
    return '<div class="empty"><strong>事件流读不到</strong><span>' + esc(unavailable) + '</span></div>'
  }
  if (!events.length) {
    return '<div class="empty"><strong>还没有事件</strong>'
      + '<span>没有任何模块往工作空间发过事件。'
      + '事件是 append-only 的：这里空，只说明「还没发生」，不代表「事件系统坏了」。</span></div>'
  }
  return events.map((e) => '<div class="ev">'
    + '<span class="ev-when">' + esc(fmtWhen(e.at)) + '</span>'
    + '<span class="' + chipClass(CHANNEL_CHIP, e.channel || '') + '">'
    + esc(CHANNEL_LABELS[e.channel] || dash(e.channel)) + '</span>'
    + '<span class="ev-mod">' + esc(dash(e.sourceModule)) + '</span>'
    + '<span class="ev-kind">' + esc(dash(e.kind)) + '</span>'
    + (e.subjectType ? '<span class="ev-sub">' + esc(e.subjectType) + (e.subjectId ? '/' + esc(e.subjectId) : '') + '</span>' : '')
    + (Number.isFinite(e.salience) && e.salience > 0 ? '<span class="ev-sal">显著性 ' + esc(e.salience.toFixed(2)) + '</span>' : '')
    + '</div>').join('')
}

/**
 * 渲染工作空间页。
 *
 * @param {{ scopeId?: string, view?: ReturnType<typeof collectWorkspaceView> }} [opts]
 * @returns {string} 完整 HTML
 */
export function renderWorkspacePage(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const view = o.view && typeof o.view === 'object' ? o.view : null
  const scopeId = String(o.scopeId == null ? (view ? view.scopeId : '') : o.scopeId)
  const v = view || {
    unavailable: '页面没拿到数据（collectWorkspaceView 没有调用）。',
    scopeId,
    switches: [],
    focus: null,
    candidates: [],
    events: [],
    eventsUnavailable: null,
    errors: [],
  }

  const unavailableBox = v.unavailable
    ? '<div class="diag warn"><b>门面未接线</b><br>' + esc(v.unavailable) + '</div>'
    : ''
  const errorsBox = Array.isArray(v.errors) && v.errors.length
    ? '<div class="diag warn"><b>读取时有 ' + esc(String(v.errors.length)) + ' 处失败</b>：'
      + esc(v.errors.join('；')) + '（缺的部分显示为「–」，不编 0）</div>'
    : ''
  const schemaBox = v.schemaHint
    ? '<div class="diag warn"><b>库版本落后</b><br>' + esc(v.schemaHint) + '</div>'
    : ''
  const pausedOn = v.switches.some((sw) => sw.name === 'paused' && sw.enabled)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 工作空间</title>
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
/* ── 这一页自己的部分：开关网格的列数 / 焦点卡 / 候选表列宽 / 事件流的一行排布 ──
   骨架、面板（.panel 系列）、标签（.chip）、表格（.tbl）、按钮（.btn）、空态、
   说明条全在 theme.js 的组件层里，页面不再复写。 */

/* 诊断条：左缘一道 2px 状态线，比整块换底色克制 */
.diag{margin:0 0 18px;padding:11px 16px;border-radius:var(--r-sm);font-size:13px;
  background:var(--card);border:1px solid var(--line);border-left:2px solid var(--line);
  line-height:1.7;box-shadow:0 1px 2px rgba(23,32,60,.04)}
.diag.warn{border-left-color:var(--warn);background:var(--warn-soft);color:#9a5f0d}

/* 六开关：theme 的 .switch-grid 是 3 列，这页窄屏先落两列再落一列，只覆盖这两档断点。
   卡片本体（.switch 的 hover 抬 2px）用 theme 的。 */
@media(max-width:900px){.switch-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:620px){.switch-grid{grid-template-columns:minmax(0,1fr)}}

/* 开关卡里 theme 没覆盖的三样：右上角的值徽标、改动时间、暂停时的红框。
   暂停开着只把这一格描红，不整页变红——不然「现在是停的状态」反而看不出来。 */
.sw-value{font-family:var(--mono);font-size:11.5px;margin-left:auto;color:var(--muted);
  border:1px solid var(--line);border-radius:4px;padding:1.5px 7px;line-height:1.6}
.sw-value.on{color:var(--accent);border-color:var(--accent-line);background:var(--accent-soft)}
.sw-meta{font-size:11px;color:var(--faint);font-family:var(--mono)}
.switch.paused-on{border-color:rgba(214,69,69,.34);background:var(--bad-soft)}
.btn.sw-btn{margin-top:4px}
.btn.armed{border-color:var(--bad);background:var(--bad-soft);color:var(--bad);font-weight:600}

/* 焦点卡：kind 是刻度、label 是主体、chip 说是否还有效。 */
.focus-box{display:flex;flex-direction:column;gap:10px}
.focus-main{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.focus-kind{font-family:var(--mono);font-size:11.5px;color:var(--muted);
  border:1px solid var(--line);border-radius:4px;padding:1.5px 7px;line-height:1.6}
.focus-label{font-size:16px;font-weight:600;color:var(--ink)}
.focus-grid{display:flex;gap:20px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.focus-grid b{font-family:var(--mono);font-weight:550;color:var(--ink);margin-left:4px;
  font-variant-numeric:tabular-nums}

/* 候选表：theme 的 .tbl 给结构与数字列，这里只补列宽与两列的语气。 */
.tbl-wrap{overflow-x:auto}
.tbl td.title{max-width:340px;word-break:break-word}
.tbl td.when{font-family:var(--mono);font-size:11px;color:var(--faint);white-space:nowrap;
  font-variant-numeric:tabular-nums}
.tbl td.muted{color:var(--muted);font-size:11.5px;max-width:180px;word-break:break-word}

/* 事件流：一行多个标签。theme 的 .ev 是两栏时间线，这里只补换行与四个标签的排印。 */
.ev{flex-wrap:wrap;align-items:baseline;font-size:12.5px}
.ev-mod{font-family:var(--mono);font-size:11.5px;color:var(--ink)}
.ev-kind{font-size:12.5px;color:var(--ink-2)}
.ev-sub{font-family:var(--mono);font-size:10.5px;color:var(--muted)}
.ev-sal{font-family:var(--mono);font-size:10.5px;color:var(--faint);margin-left:auto;
  font-variant-numeric:tabular-nums}

.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.toolbar label{font-size:12px;color:var(--muted)}
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
<div class="wrap wrap--wide">
  ${renderPageHead({
    active: 'workspace',
    title: '工作空间',
    sub: '自主开关、注意力焦点、候选队列与事件流。开关是逃生门：每一处改动都走两步确认。'
  })}
  <div class="path">scope: ${esc(scopeId)} · /dsh-brain/api/workspace · 生成于 ${esc(fmtWhen(v.at))}</div>

  <div id="err"></div>
  ${unavailableBox}
  ${errorsBox}
  ${schemaBox}
  ${pausedOn ? '<div class="diag warn"><b>全局暂停开着（paused=1）</b>：所有自主模块必须停手。'
    + '这是逃生门，不是故障——确认要恢复时在下面单独点「关闭」。</div>' : ''}

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">${v.switches.length} 个开关</span>
      <span class="panel-meta">点两下才生效</span>
    </div>
    <div class="panel-body">
      <div class="switch-grid">${v.switches.length ? v.switches.map(switchCard).join('') : '<div class="empty"><strong>开关没读到</strong><span>门面不可用或表不存在，所以这里没有可点的东西。不要据此认为「都是关的」。</span></div>'}</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">注意力焦点</span>
      <span class="panel-meta">${v.focus ? '有焦点' : '无焦点'}</span>
    </div>
    <div class="panel-body">${focusCard(v.focus)}</div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">候选队列</span>
      <span class="panel-meta">${esc(String(v.candidates.length))} 条</span>
    </div>
    <div class="panel-body">
      <div class="toolbar">
        <label for="f-status">按状态筛选</label>
        <select class="select" id="f-status">
          <option value="">全部</option>
          <option value="proposed">待仲裁</option>
          <option value="executing">执行中</option>
          <option value="done">已完成</option>
          <option value="rejected">已驳回</option>
          <option value="expired">已过期</option>
          <option value="failed">失败</option>
        </select>
        <label for="f-kind">按 kind 筛选</label>
        <select class="select" id="f-kind">
          <option value="">全部</option>
          <option value="memory_write">写记忆</option>
          <option value="reflection">反思</option>
          <option value="proactive">主动开口</option>
          <option value="directive">自主指令</option>
          <option value="maintenance">维护</option>
          <option value="skill_update">技能更新</option>
          <option value="quarantine">隔离</option>
        </select>
        <span class="panel-meta" id="f-count"></span>
      </div>
      <div id="cand-body">${candidatesTable(v.candidates)}</div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">最近事件</span>
      <span class="panel-meta">${v.eventsUnavailable ? '数据缺失' : esc(String(v.events.length)) + ' 条'}</span>
    </div>
    <div class="panel-body">${eventsList(v.events, v.eventsUnavailable)}</div>
  </div>

  <p class="note">
    <b>这页为什么存在：</b>开关是逃生门，候选和事件是「它在想什么」的痕迹。
    看不见这三样，就只能等出事再从日志里倒推。<b>每一处改动都走两步确认 + 同源写保护</b>
    （POST + <code>X-Brain-Action: 1</code>），没有「点一下就全开」的路径。
    事件是 append-only 的，这里只读，不做任何过滤性删除。
  </p>

  <div class="foot">
    <span>只读视图 + 开关 · 数据来自 /dsh-brain/api/workspace</span>
    <span style="flex:1"></span>
    <a href="/dsh-brain">回记忆</a>
  </div>
</div>
<script>
(function(){
  // 写操作统一入口：POST + 自定义头，与矛盾核验页同一套同源保护。
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
      if (!d || d.ok !== true){
        throw new Error((d && d.message) ? String(d.message) : '写操作失败');
      }
      location.reload();
    }).catch(function(e){
      if (err){ err.className = 'show'; err.textContent = '写操作没成功：' + ((e && e.message) ? e.message : String(e)); }
      btn.disabled = false;
      btn.className = 'btn sw-btn';
      btn.textContent = btn.getAttribute('data-original') || '重试';
    });
  }

  // 两步确认：第一下只「上膛」，三秒内不再点就复位。
  // 不弹 window.confirm：它挡不住误触（回车就确认），而且这页需要看到「将会改成什么」。
  var armed = null;
  function disarm(btn){
    if (!btn) return;
    btn.className = 'btn sw-btn';
    btn.textContent = btn.getAttribute('data-original') || '切换';
    if (armed === btn) armed = null;
  }
  document.addEventListener('click', function(event){
    var btn = event.target && event.target.closest ? event.target.closest('button[data-act]') : null;
    if (!btn) return;
    if (!btn.getAttribute('data-original')){
      btn.setAttribute('data-original', btn.textContent || '切换');
    }
    if (armed !== btn){
      if (armed) disarm(armed);
      armed = btn;
      btn.className = 'btn sw-btn armed';
      btn.textContent = '再点一次：' + (btn.getAttribute('data-confirm') || '确认');
      window.setTimeout(function(){ if (armed === btn) disarm(btn); }, 4000);
      return;
    }
    armed = null;
    var act = btn.getAttribute('data-act');
    if (act === 'switch'){
      send('/dsh-brain/api/workspace/switch', {
        name: btn.getAttribute('data-name'),
        value: btn.getAttribute('data-value')
      }, btn);
    }
  });

  // 候选筛选：纯前端过滤已渲染的行，不重新请求（数据一次给全，筛选不该产生副作用）。
  function applyFilter(){
    var st = document.getElementById('f-status');
    var kd = document.getElementById('f-kind');
    var status = st ? st.value : '';
    var kind = kd ? kd.value : '';
    var rows = document.querySelectorAll('tr[data-status]');
    var shown = 0;
    for (var i = 0; i < rows.length; i++){
      var row = rows[i];
      var okStatus = !status || row.getAttribute('data-status') === status;
      var okKind = !kind || row.getAttribute('data-kind') === kind;
      if (okStatus && okKind){ row.style.display = ''; shown++; }
      else { row.style.display = 'none'; }
    }
    var count = document.getElementById('f-count');
    if (count) count.textContent = '显示 ' + shown + ' / ' + rows.length + ' 条';
  }
  var selStatus = document.getElementById('f-status');
  var selKind = document.getElementById('f-kind');
  if (selStatus) selStatus.addEventListener('change', applyFilter);
  if (selKind) selKind.addEventListener('change', applyFilter);
  applyFilter();
})();
</script>
</body>
</html>`
}
