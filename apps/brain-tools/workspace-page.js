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
 *   1. 六个开关（含全局暂停）——**每一次改动都要两步确认**；
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

import { renderNav, NAV_CSS } from './nav.js'

/** 开关的中文名与语义。顺序＝契约 §6 的顺序（逃生门排最前）。 */
const SWITCH_META = [
  { name: 'autonomy.enabled', label: '自主指令', kind: 'bool', hint: '允许自主指令排队与执行' },
  { name: 'autonomy.max_level', label: '最高权限等级', kind: 'level', hint: '自主动作最高能到哪一级' },
  { name: 'social.enabled', label: '主动社交', kind: 'bool', hint: '允许生成主动开口的候选' },
  { name: 'social.allow_external', label: '允许外发', kind: 'bool', hint: '关 = 只进控制台，绝不真发' },
  { name: 'reflection.enabled', label: '空闲反思', kind: 'bool', hint: '空闲时要不要自己想事' },
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

/** 单个开关卡。 */
function switchCard(sw) {
  const changed = sw.isDefault ? '默认值' : (sw.updatedAt ? fmtWhen(sw.updatedAt) + ' 改过' : '改过')
  const warn = sw.name === 'paused' && sw.enabled ? ' paused-on' : ''
  return '<div class="sw' + warn + '">'
    + '<div class="sw-top"><span class="sw-label">' + esc(sw.label) + '</span>'
    + '<span class="sw-value' + (sw.enabled && sw.kind === 'bool' ? ' on' : '') + '">'
    + esc(switchValueText(sw)) + '</span></div>'
    + '<div class="sw-name">' + esc(sw.name) + '</div>'
    + '<div class="sw-hint">' + esc(sw.hint) + '</div>'
    + '<div class="sw-meta">' + esc(changed)
    + (sw.updatedBy ? ' · ' + esc(sw.updatedBy) : '') + '</div>'
    + (sw.reason ? '<div class="sw-reason">' + esc(sw.reason) + '</div>' : '')
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
    + '<td><span class="chip kind">' + esc(CANDIDATE_KIND_LABELS[c.kind] || c.kind) + '</span></td>'
    + '<td class="title">' + esc(c.title) + '</td>'
    + '<td class="n">' + esc(num(c.score)) + '</td>'
    + '<td class="n">' + esc(num(c.priority)) + '</td>'
    + '<td><span class="chip st-' + esc(c.status) + '">' + esc(CANDIDATE_STATUS_LABELS[c.status] || c.status)
    + '</span></td>'
    + '<td class="n">' + esc(num(c.evidenceCount)) + '</td>'
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
    + '<span class="chip ch-' + esc(e.channel || 'other') + '">'
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
.wrap{max-width:1180px;margin:0 auto;padding:38px 30px 80px}
.head{display:flex;align-items:baseline;gap:14px;margin-bottom:6px;flex-wrap:wrap}
h1{font-size:21px;font-weight:650;letter-spacing:.01em;margin:0}
.sub{color:var(--muted);font-size:12.5px}
.path{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-bottom:22px;word-break:break-all}

.diag{margin:0 0 18px;padding:13px 17px;border-radius:10px;font-size:13px;
  background:var(--card);border:1px solid var(--line);line-height:1.7}
.diag.warn{border-color:#e8cdb4;background:#fdf6ee;color:#8a5327}

.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  margin-bottom:20px;overflow:hidden}
.card-head{display:flex;align-items:baseline;gap:10px;padding:14px 20px;
  border-bottom:1px solid var(--line);background:#fdfaf6;flex-wrap:wrap}
.card-title{font-size:13.5px;font-weight:620}
.card-meta{font-size:11.5px;color:var(--muted);margin-left:auto;font-family:var(--mono)}
.body{padding:14px 20px 18px}

/* 六开关：三列网格，一格一个逃生门。暂停开着时整格变红底，
   让「现在是停的状态」不靠读数字才能发现。 */
.switches{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
@media(max-width:880px){.switches{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.switches{grid-template-columns:1fr}}
.sw{border:1px solid var(--line);border-radius:11px;padding:13px 15px;background:#fff;
  display:flex;flex-direction:column;gap:5px;min-width:0}
.sw.paused-on{border-color:#e0b9b4;background:#fdf3f2}
.sw-top{display:flex;align-items:baseline;gap:8px}
.sw-label{font-size:13.5px;font-weight:600}
.sw-value{font-family:var(--mono);font-size:12px;margin-left:auto;color:var(--muted);
  border:1px solid var(--line);border-radius:6px;padding:1px 7px}
.sw-value.on{color:var(--ochre);border-color:var(--ochre);background:var(--ochre-soft)}
.sw-name{font-family:var(--mono);font-size:10.5px;color:var(--muted);word-break:break-all}
.sw-hint{font-size:12px;color:var(--muted);line-height:1.55}
.sw-meta{font-size:11px;color:var(--muted);font-family:var(--mono)}
.sw-reason{font-size:11.5px;color:var(--muted);border-left:2px solid var(--line);padding-left:8px;line-height:1.5}
.btn{margin-top:6px;align-self:flex-start;font:inherit;font-size:12.5px;padding:6px 13px;
  border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);
  cursor:pointer;transition:all .15s}
.btn:hover{border-color:var(--ochre);color:var(--ochre)}
.btn.armed{border-color:var(--bad);background:#f6e6e4;color:var(--bad);font-weight:600}
.btn[disabled]{opacity:.45;cursor:not-allowed}

.focus-box{display:flex;flex-direction:column;gap:10px}
.focus-main{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.focus-kind{font-family:var(--mono);font-size:12px;color:var(--muted);
  border:1px solid var(--line);border-radius:6px;padding:2px 8px}
.focus-label{font-size:16px;font-weight:600}
.focus-grid{display:flex;gap:20px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.focus-grid b{font-family:var(--mono);font-weight:550;color:var(--ink);margin-left:4px}

.chip{display:inline-block;font-size:11px;padding:1px 8px;border-radius:6px;
  border:1px solid var(--line);color:var(--muted);background:#faf7f2;white-space:nowrap}
.chip.ok{color:var(--ok);border-color:#cfe0d6;background:#eef5f0}
.chip.bad{color:var(--bad);border-color:#e6c9c5;background:#f9efee}
.chip.kind{color:var(--ochre);border-color:#e8d3bf;background:var(--ochre-soft)}
.chip.st-proposed{color:var(--ochre);border-color:#e8d3bf;background:var(--ochre-soft)}
.chip.st-executing{color:#4a5f8a;border-color:#cdd8ea;background:#eff3fa}
.chip.st-done{color:var(--ok);border-color:#cfe0d6;background:#eef5f0}
.chip.st-failed,.chip.st-rejected{color:var(--bad);border-color:#e6c9c5;background:#f9efee}
.chip.st-expired{color:var(--muted)}
.chip.ch-sense{color:#4a7a6a;border-color:#cfe3da;background:#eef6f1}
.chip.ch-attention{color:var(--ochre);border-color:#e8d3bf;background:var(--ochre-soft)}
.chip.ch-memory{color:#5a6785;border-color:#d3dae8;background:#f0f3f9}
.chip.ch-affect{color:#8a5a72;border-color:#e6cfd8;background:#faf0f4}
.chip.ch-action{color:#6a5f8a;border-color:#dad3ea;background:#f3f0fa}
.chip.ch-result{color:var(--ok);border-color:#cfe0d6;background:#eef5f0}
.chip.ch-error{color:var(--bad);border-color:#e6c9c5;background:#f9efee}
.chip.ch-resource{color:#7a6a4a;border-color:#e6ddc9;background:#faf6ee}

.tbl-wrap{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.tbl th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;
  letter-spacing:.04em;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.tbl tr:last-child td{border-bottom:none}
.tbl td.title{max-width:340px;word-break:break-word}
.tbl td.n{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;
  white-space:nowrap;color:var(--ink)}
.tbl td.when{font-family:var(--mono);font-size:11.5px;color:var(--muted);white-space:nowrap}
.tbl td.muted{color:var(--muted);font-size:11.5px;max-width:180px;word-break:break-word}

/* 事件流：一行一件事，时间定宽，channel 用色块，模块名等宽。 */
.ev{display:flex;align-items:baseline;gap:12px;padding:9px 0;border-bottom:1px solid var(--line);
  flex-wrap:wrap;font-size:12.5px}
.ev:last-child{border-bottom:none}
.ev-when{font-family:var(--mono);font-size:11.5px;color:var(--muted);white-space:nowrap;
  min-width:84px;font-variant-numeric:tabular-nums}
.ev-mod{font-family:var(--mono);font-size:11.5px;color:var(--ink)}
.ev-kind{color:var(--ink)}
.ev-sub{font-family:var(--mono);font-size:10.5px;color:var(--muted)}
.ev-sal{font-family:var(--mono);font-size:10.5px;color:var(--muted);margin-left:auto}

.empty{padding:34px 0 36px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}
.empty strong{display:block;color:var(--ink);font-size:14.5px;font-weight:620;margin-bottom:6px}
.empty span{display:block;max-width:560px;margin:0 auto}

.toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:12px}
.toolbar label{font-size:12px;color:var(--muted)}
select{font:inherit;font-size:12.5px;padding:5px 9px;border-radius:8px;
  border:1px solid var(--line);background:var(--card);color:var(--ink)}
#err{display:none;margin:0 0 16px;padding:11px 15px;border-radius:10px;
  border:1px solid #e6c9c5;background:#f9efee;color:var(--bad);font-size:12.5px;line-height:1.6}
#err.show{display:block}

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
    <h1>工作空间</h1>
    <span class="sub">自主开关 · 注意力焦点 · 候选队列 · 事件流</span>
    ${renderNav({ active: 'workspace' })}
  </div>
  <div class="path">scope: ${esc(scopeId)} · /dsh-brain/api/workspace · 生成于 ${esc(fmtWhen(v.at))}</div>

  <div id="err"></div>
  ${unavailableBox}
  ${errorsBox}
  ${schemaBox}
  ${pausedOn ? '<div class="diag warn"><b>全局暂停开着（paused=1）</b>：所有自主模块必须停手。'
    + '这是逃生门，不是故障——确认要恢复时在下面单独点「关闭」。</div>' : ''}

  <div class="card">
    <div class="card-head">
      <span class="card-title">六个开关</span>
      <span class="card-meta">点两下才生效</span>
    </div>
    <div class="body">
      <div class="switches">${v.switches.length ? v.switches.map(switchCard).join('') : '<div class="empty"><strong>开关没读到</strong><span>门面不可用或表不存在，所以这里没有可点的东西。不要据此认为「都是关的」。</span></div>'}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">注意力焦点</span>
      <span class="card-meta">${v.focus ? '有焦点' : '无焦点'}</span>
    </div>
    <div class="body">${focusCard(v.focus)}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">候选队列</span>
      <span class="card-meta">${esc(String(v.candidates.length))} 条</span>
    </div>
    <div class="body">
      <div class="toolbar">
        <label for="f-status">按状态筛选</label>
        <select id="f-status">
          <option value="">全部</option>
          <option value="proposed">待仲裁</option>
          <option value="executing">执行中</option>
          <option value="done">已完成</option>
          <option value="rejected">已驳回</option>
          <option value="expired">已过期</option>
          <option value="failed">失败</option>
        </select>
        <label for="f-kind">按 kind 筛选</label>
        <select id="f-kind">
          <option value="">全部</option>
          <option value="memory_write">写记忆</option>
          <option value="reflection">反思</option>
          <option value="proactive">主动开口</option>
          <option value="directive">自主指令</option>
          <option value="maintenance">维护</option>
          <option value="skill_update">技能更新</option>
          <option value="quarantine">隔离</option>
        </select>
        <span class="card-meta" id="f-count"></span>
      </div>
      <div id="cand-body">${candidatesTable(v.candidates)}</div>
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">最近事件</span>
      <span class="card-meta">${v.eventsUnavailable ? '数据缺失' : esc(String(v.events.length)) + ' 条'}</span>
    </div>
    <div class="body">${eventsList(v.events, v.eventsUnavailable)}</div>
  </div>

  <p class="note">
    <b>这页为什么存在：</b>开关是逃生门，候选和事件是「它在想什么」的痕迹。
    看不见这三样，就只能等出事再从日志里倒推。<b>每一处改动都走两步确认 + 同源写保护</b>
    （POST + <code>X-Brain-Action: 1</code>），没有「点一下就全开」的路径。
    事件是 append-only 的，这里只读，不做任何过滤性删除。
  </p>

  <div class="foot">
    <span>只读视图 + 六个开关 · 数据来自 /dsh-brain/api/workspace</span>
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
