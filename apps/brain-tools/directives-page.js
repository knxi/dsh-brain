// @ts-check
/**
 * 外置大脑 · 自主指令页（/dsh-brain/directives）
 *
 * ── 这页要解决什么 ──
 *
 * 系统 5 是全项目唯一「会自己动」的东西，所以这页的第一屏不是队列，而是
 * **它到底能做什么、绝不能做什么**。理由很直接：主人要先知道边界，才有资格决定
 * 要不要打开它。把安全说明藏到页面最底下，等于默认「你已经懂了」。
 *
 * 之后的顺序按「停 → 看 → 查」排：
 *   1. 全局开关（暂停按钮 + 权限等级选择）——暂停优先于一切；
 *   2. 队列（状态/优先级/权限等级/预算用量/停止条件）；
 *   3. 运行记录与步进流水（它真跑过什么，一步一步）。
 *
 * ── 「能做什么」是从代码里读出来的，不是抄的 ──
 *
 * 内置动作白名单（`ACTION_TABLE`）只有 6 个动作，本页直接调
 * `directives.describe()` 拿它们，不手写一份可能过期的列表。
 * 「绝不能做什么」也是照包的设计边界写的（没有 child_process / 没有网络 /
 * 没有动态 import / 不可逆动作不许进白名单 / 没 hook = 不执行）。
 *
 * ── 纪律 ──
 *
 * 1. 暂停与改等级都要两步确认 + POST + `X-Brain-Action: 1`；
 * 2. 预算显示用「已用 / 预算」，预算为 0 时显示「–」而不是除出 Infinity%；
 * 3. 队列为空、没跑过、流水为空都要说清「因为什么」。
 */

import { renderNav, NAV_CSS } from './nav.js'

/** 指令状态中文。顺序＝状态机的大致生命周期。 */
const STATUS_LABELS = {
  proposed: '已提议',
  awaiting_approval: '待批准',
  queued: '排队中',
  running: '执行中',
  paused: '已暂停',
  blocked: '受阻',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

/** 停止条件中文。 */
const STOP_LABELS = {
  goal_completed: '目标完成',
  owner_interrupted: '主人中断',
  valid_until_passed: '已过期',
  budget_exhausted: '预算耗尽',
  time_exhausted: '时间用尽',
  missing_required_permission: '缺权限',
  workspace_missing: '工作空间缺失',
  hook_missing: '没接 hook',
  action_failed: '动作失败',
  step_cap_reached: '到步数上限',
  lease_expired: '租约过期',
}

/** 步进流水 kind 中文（0008 的六个枚举）。 */
const STEP_KIND_LABELS = {
  plan: '计划',
  tool: '工具',
  decision: '决策',
  note: '记录',
  error: '错误',
  stop: '停止',
}

/** 调度闸门拒绝原因中文。 */
const GATE_REASON_LABELS = {
  global_paused: '全局暂停',
  autonomy_disabled: '自主指令未开启',
  autonomy_max_level: '权限等级不够',
  workspace_missing: '工作空间门面缺失',
  workspace_incomplete: '工作空间门面不完整',
  max_level_invalid: '权限等级值不认识',
  max_level_too_low: '权限等级 L0（只读，不执行）',
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

/**
 * 预算进度条。预算 0 时不给百分比（除零会变成 NaN/Infinity，那比「–」更骗人）。
 *
 * @param {number} used
 * @param {number} budget
 * @param {string} label
 */
function budgetBar(used, budget, label) {
  const u = Number(used)
  const b = Number(budget)
  const hasBudget = Number.isFinite(b) && b > 0
  const pct = hasBudget ? Math.max(0, Math.min(100, (u / b) * 100)) : 0
  const over = hasBudget && u > b
  return '<div class="budget">'
    + '<div class="budget-head"><span>' + esc(label) + '</span>'
    + '<span class="budget-num">' + esc(Number.isFinite(u) ? String(u) : '–') + ' / '
    + esc(hasBudget ? String(b) : '–') + '</span></div>'
    + '<div class="budget-bar"><span class="' + (over ? 'over' : '') + '" style="width:'
    + esc(pct.toFixed(1)) + '%"></span></div>'
    + '</div>'
}

/**
 * 把异常翻成人能判断的一句话。
 * `no such table` 是首启最常见的一种：库还在 0007 时页面必须说「表还没建」，
 * 而不是让「队列空」看起来像「没有任务在跑」。
 */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  const missing = /no such table:\s*([A-Za-z0-9_]+)/.exec(message)
  if (missing) return missing[1] + ' 表不存在（0008 迁移未应用？）'
  return message
}

/**
 * 收集自主指令视图（同步）。
 *
 * @param {any} brain
 * @param {{ scopeId: string, limit?: number }} opts
 */
export function collectDirectivesView(brain, opts) {
  const scopeId = String(opts && opts.scopeId ? opts.scopeId : '')
  const limit = Math.min(Math.max(Number(opts && opts.limit) || 50, 1), 200)
  const dir = brain && brain.directives
  if (!dir) {
    return {
      unavailable: '自主指令门面（brain.directives）还没接线：openBrain 里没构造 createDirectives。'
        + '这页先只显示空壳，**不要**把「看不到」当成「它没在跑」。',
      scopeId,
      describe: null,
      gate: null,
      paused: null,
      maxLevel: null,
      directives: [],
      stats: null,
      runs: [],
      steps: [],
      runsUnavailable: null,
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

  const describe = safe(() => dir.describe(), null)
  const gate = safe(() => dir.readGate(), null)
  const stats = safe(() => dir.stats(), null)
  const listed = safe(() => dir.list({ limit }), { items: [] })
  const directives = ((listed && listed.items) || []).map((item) => ({
    id: String(item.id),
    title: String(item.title),
    reason: item.reason == null ? null : String(item.reason),
    status: String(item.status),
    priority: Number(item.priority) || 0,
    permissionScope: String(item.permissionScope),
    trigger: String(item.trigger),
    source: String(item.source),
    budgets: item.budgets && typeof item.budgets === 'object' ? item.budgets : {},
    usage: item.usage && typeof item.usage === 'object' ? item.usage : {},
    stopConditions: Array.isArray(item.stopConditions) ? item.stopConditions.map(String) : [],
    allowedTools: Array.isArray(item.allowedTools) ? item.allowedTools.map(String) : [],
    validUntil: item.validUntil == null ? null : String(item.validUntil),
    lastError: item.lastError == null ? null : String(item.lastError),
    createdAt: item.createdAt == null ? null : String(item.createdAt),
    finishedAt: item.finishedAt == null ? null : String(item.finishedAt),
  }))

  // 运行记录与流水：门面没有暴露 listRuns，但这是纯只读展示，
  // 直接查表比逼别人加 API 更快，也更不容易越界改 packages。
  const readRuns = () => {
    const rows = brain.db.prepare(
      'SELECT id, directive_id, attempt, status, started_at, finished_at, steps_used,'
      + ' tokens_used, stop_reason, error FROM directive_runs'
      + ' WHERE scope_id = ? ORDER BY started_at DESC, id DESC LIMIT ?',
    ).all(scopeId, limit)
    return rows.map((row) => ({
      id: String(row.id),
      directiveId: String(row.directive_id),
      attempt: Number(row.attempt) || 1,
      status: String(row.status),
      startedAt: row.started_at == null ? null : String(row.started_at),
      finishedAt: row.finished_at == null ? null : String(row.finished_at),
      stepsUsed: Number(row.steps_used) || 0,
      tokensUsed: Number(row.tokens_used) || 0,
      stopReason: row.stop_reason == null ? null : String(row.stop_reason),
      error: row.error == null ? null : String(row.error),
    }))
  }
  let runs = []
  let runsUnavailable = null
  try {
    runs = readRuns()
  } catch {
    runsUnavailable = 'directive_runs 表不存在或读不了（缺 0008 迁移？）'
    runs = []
  }

  let steps = []
  try {
    const rows = brain.db.prepare(
      'SELECT run_id, seq, at, kind, summary, ok, duration_ms FROM directive_steps'
      + ' WHERE scope_id = ? ORDER BY at DESC, seq DESC LIMIT ?',
    ).all(scopeId, Math.min(limit * 2, 200))
    steps = rows.map((row) => ({
      runId: String(row.run_id),
      seq: Number(row.seq) || 0,
      at: row.at == null ? null : String(row.at),
      kind: String(row.kind),
      summary: String(row.summary),
      ok: row.ok == null ? null : Number(row.ok) === 1,
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
    }))
  } catch {
    steps = []
  }

  const switches = brain.workspace && typeof brain.workspace.listSwitches === 'function'
    ? safe(() => brain.workspace.listSwitches(), [])
    : []
  const pausedRow = (Array.isArray(switches) ? switches : []).find((row) => row.name === 'paused')
  const levelRow = (Array.isArray(switches) ? switches : []).find((row) => row.name === 'autonomy.max_level')

  return {
    unavailable: null,
    scopeId,
    describe,
    gate,
    paused: pausedRow ? pausedRow.value === '1' || pausedRow.enabled === true : null,
    maxLevel: levelRow ? String(levelRow.value) : null,
    directives,
    stats,
    runs,
    steps,
    runsUnavailable,
    errors,
    // 表不存在 ≠ 没有指令：页面顶部必须说清楚，否则「队列空」会被读成「没在跑」。
    schemaHint: errors.some((message) => message.includes('0008'))
      ? '数据库还没升到 0008：directives / directive_runs / directive_steps 还没建。'
        + '「队列空、没跑过」在这里等于「还读不到」，不是「它没动」；迁移跑完后刷新本页。'
      : null,
    at: new Date().toISOString(),
  }
}

/** 首屏安全边界：从包的设计边界来，不手写「大概」。 */
function boundaryPanel(view) {
  const describe = view.describe || {}
  const actions = Array.isArray(describe.actions) ? describe.actions : []
  const hooksBound = Array.isArray(describe.scheduler && describe.scheduler.hooksBound)
    ? describe.scheduler.hooksBound
    : []
  const actionRows = actions.length
    ? actions.map((action) => '<div class="action">'
      + '<div class="action-top"><span class="chip kind">' + esc(action.label || action.name) + '</span>'
      + '<span class="chip">' + esc(action.level) + '</span>'
      + (action.available ? '<span class="chip ok">hook 已接</span>' : '<span class="chip bad">hook 未接（不会执行）</span>')
      + '<span class="chip ' + (action.reversible ? 'ok' : 'bad') + '">'
      + (action.reversible ? '可回退' : '不可逆（不该在这里）') + '</span>'
      + '</div>'
      + '<div class="action-why">' + esc(dash(action.why)) + '</div>'
      + (action.rollback ? '<div class="action-rollback">回退：' + esc(action.rollback) + '</div>' : '')
      + '</div>').join('')
    : '<div class="empty"><strong>动作白名单没读到</strong><span>describe() 没有返回 actions。</span></div>'

  const posture = describe.defaultPosture && typeof describe.defaultPosture === 'object' ? describe.defaultPosture : null
  return '<div class="bounds">'
    + '<div class="bound-col">'
    + '<div class="bound-title ok">它能做什么（白名单全集，' + esc(String(actions.length)) + ' 个）</div>'
    + actionRows
    + '<div class="bound-foot">已绑定 hook：' + esc(hooksBound.length ? hooksBound.join(' / ') : '无（所有动作都会返回 hook_missing，绝不假装成功）') + '</div>'
    + '</div>'
    + '<div class="bound-col">'
    + '<div class="bound-title bad">它绝不能做什么</div>'
    + '<ul class="never">'
    + '<li><b>不执行任意命令</b>：包里没有 <code>child_process</code>、没有 <code>fs.write</code>、没有网络、没有动态 import。</li>'
    + '<li><b>不真外发消息</b>：全项目没有任何 IM 通道；外发要人配通道，默认返回 <code>no_channel_configured</code>。</li>'
    + '<li><b>不能自己扩权</b>：动作等级高于 <code>autonomy.max_level</code> 时连声明都不允许（反扩权硬判）。</li>'
    + '<li><b>不会无限跑</b>：每条指令都有 step/token/time 预算与停止条件，超预算即停。</li>'
    + '<li><b>不可逆的动作进不了白名单</b>：表里每一条都写了「误做之后怎么回退」。</li>'
    + '<li><b>没有 hook 就等于不执行</b>：返回 <code>hook_missing</code>，不写假成功。</li>'
    + '<li><b>默认全关</b>：<code>autonomy.enabled=0</code> + <code>max_level=L1</code>，不打开就零动作。</li>'
    + '<li><b>暂停优先一切</b>：<code>paused=1</code> 时连「要不要跑」的判断都不做。</li>'
    + '</ul>'
    + (posture ? '<div class="bound-foot">默认姿态：自主=' + esc(dash(posture.autonomyEnabled))
      + ' · 最高等级=' + esc(dash(posture.maxLevel))
      + ' · 外部动作=' + esc(dash(posture.externalActions))
      + ' · 任意命令=' + esc(dash(posture.arbitraryCommandExecution)) + '</div>' : '')
    + '</div>'
    + '</div>'
}

/** 全局开关：暂停 + 权限等级。 */
function globalPanel(view) {
  const gate = view.gate && typeof view.gate === 'object' ? view.gate : null
  const paused = view.paused === true
  const gateText = gate
    ? (gate.ok === true
      ? '<span class="chip ok">调度闸门通过</span>'
      : '<span class="chip bad">调度闸门拒绝：' + esc(GATE_REASON_LABELS[gate.reason] || dash(gate.reason)) + '</span>')
    : '<span class="chip">闸门读数不可用</span>'
  const levels = ['L0', 'L1', 'L2', 'L3']
  const levelOptions = levels.map((level) => '<option value="' + esc(level) + '"'
    + (view.maxLevel === level ? ' selected' : '') + '>' + esc(level) + '</option>').join('')
  const levelMeta = view.describe && view.describe.scheduler && Array.isArray(view.describe.scheduler.gates)
    ? view.describe.scheduler.gates
    : []
  return '<div class="global-grid">'
    + '<div class="global-box">'
    + '<div class="global-k">全局暂停</div>'
    + '<div class="global-v ' + (paused ? 'on' : '') + '">' + (paused === null ? '–' : (paused ? '已暂停' : '未暂停')) + '</div>'
    + '<div class="global-hint">暂停优先于一切：按下之后任何自主模块都不该再动。'
    + '恢复也要单独点一次，不会自己回来。</div>'
    + '<button class="btn ' + (paused ? '' : 'danger') + '" data-act="pause" data-value="'
    + (paused ? '0' : '1') + '" data-confirm="' + (paused ? '恢复自主执行' : '立即暂停所有自主执行') + '">'
    + (paused ? '恢复执行' : '立即暂停') + '</button>'
    + '</div>'
    + '<div class="global-box">'
    + '<div class="global-k">最高权限等级</div>'
    + '<div class="global-v">' + esc(dash(view.maxLevel)) + '</div>'
    + '<div class="global-hint">等级决定哪些动作能被执行。L0 = 只读，几乎所有动作都会拒绝。'
    + '低于动作要求等级时，' + (levelMeta.length ? '闸门（' + esc(levelMeta.join(' / ')) + '）' : '闸门') + '会拦住它。</div>'
    + '<div class="level-row">'
    + '<select id="level-select" aria-label="权限等级">' + levelOptions + '</select>'
    + '<button class="btn" data-act="level" data-confirm="应用权限等级">应用等级</button>'
    + '</div>'
    + '</div>'
    + '<div class="global-box">'
    + '<div class="global-k">闸门与门面</div>'
    + '<div class="global-v small">' + gateText + '</div>'
    + '<div class="global-hint">'
    + '工作空间门面：' + (view.describe && view.describe.hasWorkspace ? '已接线' : '未接线（所有自主行为按关处理）')
    + ' · 指令表：' + (view.describe && view.describe.tableExists ? '存在' : '不存在')
    + '</div>'
    + '</div>'
    + '</div>'
}

/** 队列表。 */
function queuePanel(directives) {
  if (!directives.length) {
    return '<div class="empty"><strong>队列是空的</strong>'
      + '<span>没有任何指令。自主指令不会自己冒出来：要么人创建，要么内部候选经人批准'
      + '（autonomy 最多到 L1，且必须人批）。空队列是正常状态。</span></div>'
  }
  return '<div class="tbl-wrap"><table class="tbl"><thead><tr>'
    + '<th>标题</th><th>状态</th><th>优先级</th><th>权限</th><th>预算用量</th><th>停止条件</th><th>创建</th>'
    + '</tr></thead><tbody>' + directives.map((item) => {
      const steps = item.usage.stepsUsed === undefined ? 0 : item.usage.stepsUsed
      const stepsBudget = item.budgets.step === undefined ? 0 : item.budgets.step
      const tokens = item.usage.tokensUsed === undefined ? 0 : item.usage.tokensUsed
      const tokensBudget = item.budgets.token === undefined ? 0 : item.budgets.token
      return '<tr>'
        + '<td class="title"><b>' + esc(item.title) + '</b>'
        + (item.reason ? '<div class="muted">' + esc(item.reason) + '</div>' : '')
        + (item.lastError ? '<div class="err-line">上次错误：' + esc(item.lastError) + '</div>' : '')
        + '</td>'
        + '<td><span class="chip st-' + esc(item.status) + '">' + esc(STATUS_LABELS[item.status] || item.status) + '</span>'
        + '<div class="muted tiny">' + esc(item.trigger) + ' / ' + esc(item.source) + '</div></td>'
        + '<td class="n">' + esc(num(item.priority)) + '</td>'
        + '<td class="n">' + esc(item.permissionScope) + '</td>'
        + '<td class="budget-cell">'
        + budgetBar(steps, stepsBudget, '步数')
        + budgetBar(tokens, tokensBudget, 'Token')
        + '</td>'
        + '<td class="muted">' + esc(item.stopConditions.map((s) => STOP_LABELS[s] || s).join(' / ') || '–') + '</td>'
        + '<td class="when">' + esc(fmtWhen(item.createdAt))
        + (item.validUntil ? '<div class="muted tiny">有效至 ' + esc(fmtWhen(item.validUntil)) + '</div>' : '') + '</td>'
        + '</tr>'
    }).join('') + '</tbody></table></div>'
}

/** 运行记录 + 步进流水。 */
function runsPanel(view) {
  if (view.runsUnavailable) {
    return '<div class="empty"><strong>运行记录读不到</strong><span>' + esc(view.runsUnavailable) + '</span></div>'
  }
  const runs = view.runs.length
    ? '<div class="tbl-wrap"><table class="tbl"><thead><tr>'
      + '<th>指令</th><th>尝试</th><th>状态</th><th>步数</th><th>Token</th><th>停止原因</th><th>开始</th><th>结束</th>'
      + '</tr></thead><tbody>' + view.runs.map((run) => '<tr>'
        + '<td class="title"><code title="' + esc(run.id) + '">' + esc(run.directiveId) + '</code></td>'
        + '<td class="n">#' + esc(num(run.attempt)) + '</td>'
        + '<td><span class="chip st-' + esc(run.status) + '">' + esc(STATUS_LABELS[run.status] || run.status) + '</span></td>'
        + '<td class="n">' + esc(num(run.stepsUsed)) + '</td>'
        + '<td class="n">' + esc(num(run.tokensUsed)) + '</td>'
        + '<td class="muted">' + esc(run.stopReason ? (STOP_LABELS[run.stopReason] || run.stopReason) : '–') + '</td>'
        + '<td class="when">' + esc(fmtWhen(run.startedAt)) + '</td>'
        + '<td class="when">' + esc(fmtWhen(run.finishedAt)) + '</td>'
        + '</tr>').join('') + '</tbody></table></div>'
    : '<div class="empty"><strong>还没有运行记录</strong>'
      + '<span>这条执行器一次都没跑过。默认 <code>autonomy.enabled=0</code>，'
      + '不打开就永远不会产生运行记录。</span></div>'

  const steps = view.steps.length
    ? '<div class="steps">' + view.steps.map((step) => '<div class="step">'
      + '<span class="step-when">' + esc(fmtWhen(step.at)) + '</span>'
      + '<span class="chip kind">' + esc(STEP_KIND_LABELS[step.kind] || step.kind) + '</span>'
      + '<span class="step-seq">#' + esc(num(step.seq)) + '</span>'
      + '<span class="step-summary">' + esc(step.summary) + '</span>'
      + (step.ok === null ? '' : (step.ok ? '<span class="chip ok">成功</span>' : '<span class="chip bad">失败</span>'))
      + '</div>').join('') + '</div>'
    : '<div class="empty"><strong>没有步进流水</strong>'
      + '<span>运行记录里的每一步会写在这（plan / tool / decision / note / error / stop）。'
      + '没有流水通常意味着还没跑过。</span></div>'

  return '<div class="sub-block"><div class="sub-title">运行记录（' + esc(String(view.runs.length)) + ' 条）</div>'
    + runs + '</div>'
    + '<div class="sub-block"><div class="sub-title">步进流水（最近 ' + esc(String(view.steps.length)) + ' 步）</div>'
    + steps + '</div>'
}

/**
 * 渲染自主指令页。
 *
 * @param {{ scopeId?: string, view?: ReturnType<typeof collectDirectivesView> }} [opts]
 * @returns {string}
 */
export function renderDirectivesPage(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const view = o.view && typeof o.view === 'object' ? o.view : null
  const scopeId = String(o.scopeId == null ? (view ? view.scopeId : '') : o.scopeId)
  const v = view || {
    unavailable: '页面没拿到数据（collectDirectivesView 没有调用）。',
    scopeId,
    describe: null,
    gate: null,
    paused: null,
    maxLevel: null,
    directives: [],
    stats: null,
    runs: [],
    steps: [],
    runsUnavailable: null,
    errors: [],
  }
  const stats = v.stats && typeof v.stats === 'object' ? v.stats : null
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
  const statsLine = stats
    ? '<div class="stat-line">'
      + '<span>待批准 <b>' + esc(num(stats.awaiting_approval)) + '</b></span>'
      + '<span>排队 <b>' + esc(num(stats.queued)) + '</b></span>'
      + '<span>执行中 <b>' + esc(num(stats.running)) + '</b></span>'
      + '<span>受阻 <b>' + esc(num(stats.blocked)) + '</b></span>'
      + '<span>已完成 <b>' + esc(num(stats.completed)) + '</b></span>'
      + '<span>失败 <b>' + esc(num(stats.failed)) + '</b></span>'
      + '<span>合计 <b>' + esc(num(stats.total)) + '</b></span>'
      + '</div>'
    : '<div class="stat-line"><span>统计读不到</span></div>'

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 自主指令</title>
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
.card.bounds-card{border-color:#dcd6cb}
.card-head{display:flex;align-items:baseline;gap:10px;padding:14px 20px;
  border-bottom:1px solid var(--line);background:#fdfaf6;flex-wrap:wrap}
.card-title{font-size:13.5px;font-weight:620}
.card-meta{font-size:11.5px;color:var(--muted);margin-left:auto;font-family:var(--mono)}
.body{padding:14px 20px 18px}

/* 首屏安全边界：左右两栏。左边是白名单（能做），右边是硬边界（绝不能做）。
   这两栏都必须是「读得下去」的正文，而不是一句概括。 */
.bounds{display:grid;grid-template-columns:1fr 1fr;gap:22px}
@media(max-width:920px){.bounds{grid-template-columns:1fr}}
.bound-title{font-size:13px;font-weight:650;margin-bottom:10px;padding-bottom:6px;
  border-bottom:1px solid var(--line)}
.bound-title.ok{color:var(--ok)}
.bound-title.bad{color:var(--bad)}
.action{border-left:2px solid var(--line);padding:2px 0 2px 12px;margin-bottom:11px}
.action-top{display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.action-why{font-size:12px;color:var(--muted);margin-top:4px;line-height:1.6}
.action-rollback{font-size:11.5px;color:var(--muted);margin-top:3px}
.never{margin:0;padding-left:20px;font-size:12.5px;line-height:1.85}
.never li{margin-bottom:7px}
.never b{color:var(--ink)}
.never code{font-family:var(--mono);font-size:11px;background:#f1ece4;padding:1px 5px;border-radius:4px}
.bound-foot{margin-top:12px;font-size:11.5px;color:var(--muted);border-top:1px dashed var(--line);
  padding-top:9px;line-height:1.7}

.global-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
@media(max-width:920px){.global-grid{grid-template-columns:1fr}}
.global-box{border:1px solid var(--line);border-radius:11px;padding:14px 16px;background:#fff;min-width:0}
.global-k{font-size:11.5px;color:var(--muted);letter-spacing:.04em}
.global-v{font-size:24px;font-weight:640;font-family:var(--mono);margin:2px 0 6px}
.global-v.on{color:var(--bad)}
.global-v.small{font-size:12px;font-family:inherit;font-weight:500;line-height:1.8}
.global-hint{font-size:11.5px;color:var(--muted);line-height:1.65;margin-bottom:9px}
.level-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
select{font:inherit;font-size:12.5px;padding:5px 9px;border-radius:8px;
  border:1px solid var(--line);background:var(--card);color:var(--ink)}

.stat-line{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-bottom:12px}
.stat-line b{font-family:var(--mono);font-weight:550;color:var(--ink);margin-left:4px}

.chip{display:inline-block;font-size:11px;padding:1px 8px;border-radius:6px;
  border:1px solid var(--line);color:var(--muted);background:#faf7f2;white-space:nowrap}
.chip.ok{color:var(--ok);border-color:#cfe0d6;background:#eef5f0}
.chip.bad{color:var(--bad);border-color:#e6c9c5;background:#f9efee}
.chip.kind{color:var(--ochre);border-color:#e8d3bf;background:var(--ochre-soft)}
.chip.st-running{color:var(--ochre);border-color:#e8d3bf;background:var(--ochre-soft)}
.chip.st-queued{color:#4a5f8a;border-color:#cdd8ea;background:#eff3fa}
.chip.st-awaiting_approval{color:#8a5a72;border-color:#e6cfd8;background:#faf0f4}
.chip.st-blocked{color:var(--bad);border-color:#e6c9c5;background:#f9efee}
.chip.st-completed{color:var(--ok);border-color:#cfe0d6;background:#eef5f0}
.chip.st-failed,.chip.st-cancelled{color:var(--bad);border-color:#e6c9c5;background:#f9efee}
.chip.st-paused{color:var(--muted)}

.tbl-wrap{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse;font-size:12.5px}
.tbl th{text-align:left;font-weight:600;color:var(--muted);font-size:11px;
  letter-spacing:.04em;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:9px 10px;border-bottom:1px solid var(--line);vertical-align:top}
.tbl tr:last-child td{border-bottom:none}
.tbl td.title{max-width:300px;word-break:break-word}
.tbl td.n{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.tbl td.when{font-family:var(--mono);font-size:11.5px;color:var(--muted);white-space:nowrap}
.tbl td.muted{color:var(--muted);font-size:11.5px}
.tbl code{font-family:var(--mono);font-size:11px;background:#f1ece4;padding:1px 5px;border-radius:4px}
.muted.tiny{font-size:10.5px;margin-top:3px}
.err-line{font-size:11px;color:var(--bad);margin-top:3px;word-break:break-word}

.budget-cell{min-width:132px}
.budget{margin-bottom:5px}
.budget-head{display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted);margin-bottom:2px}
.budget-num{font-family:var(--mono);font-variant-numeric:tabular-nums}
.budget-bar{height:5px;border-radius:3px;background:#f1ece4;overflow:hidden}
.budget-bar span{display:block;height:100%;background:var(--ochre);border-radius:3px}
.budget-bar span.over{background:var(--bad)}

.sub-block{margin-top:16px}
.sub-title{font-size:12.5px;font-weight:620;margin-bottom:8px}
.steps{display:flex;flex-direction:column;gap:2px}
.step{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:12.5px;
  padding:7px 0;border-bottom:1px dotted var(--line)}
.step:last-child{border-bottom:none}
.step-when{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;min-width:80px}
.step-seq{font-family:var(--mono);font-size:10.5px;color:var(--muted)}
.step-summary{flex:1;min-width:200px;word-break:break-word}

.btn{font:inherit;font-size:12.5px;padding:6px 13px;border-radius:8px;border:1px solid var(--line);
  background:var(--card);color:var(--ink);cursor:pointer;transition:all .15s}
.btn:hover{border-color:var(--ochre);color:var(--ochre)}
.btn.danger:hover{border-color:var(--bad);color:var(--bad)}
.btn.armed{border-color:var(--bad);background:#f6e6e4;color:var(--bad);font-weight:600}
.btn[disabled]{opacity:.45;cursor:not-allowed}

.empty{padding:30px 0 32px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}
.empty strong{display:block;color:var(--ink);font-size:14.5px;font-weight:620;margin-bottom:6px}
.empty span{display:block;max-width:580px;margin:0 auto}
.empty code{font-family:var(--mono);font-size:11.5px;background:#f1ece4;padding:1px 5px;border-radius:4px}
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
    <h1>自主指令</h1>
    <span class="sub">能做什么 · 绝不能做什么 · 队列 · 运行流水</span>
    ${renderNav({ active: 'directives' })}
  </div>
  <div class="path">scope: ${esc(scopeId)} · /dsh-brain/api/directives · 生成于 ${esc(fmtWhen(v.at))}</div>

  <div id="err"></div>
  ${unavailableBox}
  ${errorsBox}
  ${schemaBox}

  <div class="card bounds-card">
    <div class="card-head">
      <span class="card-title">这个执行器的边界（先看这里）</span>
      <span class="card-meta">读自包的能力自述，不是手抄</span>
    </div>
    <div class="body">${boundaryPanel(v)}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">全局开关</span>
      <span class="card-meta">暂停优先于一切</span>
    </div>
    <div class="body">${globalPanel(v)}</div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">指令队列</span>
      <span class="card-meta">${esc(String(v.directives.length))} 条</span>
    </div>
    <div class="body">
      ${statsLine}
      ${queuePanel(v.directives)}
    </div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">运行记录与步进流水</span>
      <span class="card-meta">真跑过的步骤</span>
    </div>
    <div class="body">${runsPanel(v)}</div>
  </div>

  <p class="note">
    <b>这页为什么把边界放第一屏：</b>这是全项目唯一「会自己动」的东西。先知道它能做什么、
    绝不能做什么，才有资格决定要不要打开它。它的动作白名单只有上面那几个，
    每个都写了「误做之后怎么回退」——<b>不可逆的动作进不了白名单</b>。
    默认姿态是「自主关 + 等级 L1」，不打开就零动作；
    <code>paused=1</code> 时连「要不要跑」的判断都不做。
  </p>

  <div class="foot">
    <span>数据来自 /dsh-brain/api/directives</span>
    <span style="flex:1"></span>
    <a href="/dsh-brain">回记忆</a>
  </div>
</div>
<script>
(function(){
  function failText(e){ return (e && e.message) ? e.message : String(e); }
  function errBox(message){
    var host = document.getElementById('err');
    if (host){ host.className = 'show'; host.textContent = message; }
  }
  function clearErr(){
    var host = document.getElementById('err');
    if (host){ host.className = ''; host.textContent = ''; }
  }
  function send(url, body, btn){
    clearErr();
    if (btn) btn.disabled = true;
    fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Brain-Action': '1' },
      body: JSON.stringify(body)
    }).then(function(response){
      return response.json().catch(function(){ return { ok: false, message: '服务端返回的不是 JSON' }; });
    }).then(function(data){
      if (!data || data.ok !== true){ throw new Error((data && data.message) ? String(data.message) : '操作没成功'); }
      location.reload();
    }).catch(function(error){
      errBox('操作没成功：' + failText(error));
      if (btn){
        btn.disabled = false;
        btn.textContent = btn.getAttribute('data-original') || '重试';
        btn.className = btn.getAttribute('data-base-class') || 'btn';
      }
    });
  }

  // 两步确认：暂停与改等级都是「改全局」，一点就生效的东西必须点两下。
  var armed = null;
  function disarm(btn){
    if (!btn) return;
    btn.textContent = btn.getAttribute('data-original') || '操作';
    btn.className = btn.getAttribute('data-base-class') || 'btn';
    if (armed === btn) armed = null;
  }
  document.addEventListener('click', function(event){
    var btn = event.target && event.target.closest ? event.target.closest('button[data-act]') : null;
    if (!btn) return;
    if (!btn.getAttribute('data-original')) btn.setAttribute('data-original', btn.textContent || '操作');
    if (!btn.getAttribute('data-base-class')) btn.setAttribute('data-base-class', btn.className || 'btn');
    if (armed !== btn){
      if (armed) disarm(armed);
      armed = btn;
      btn.className = 'btn armed';
      btn.textContent = '再点一次：' + (btn.getAttribute('data-confirm') || '确认');
      window.setTimeout(function(){ if (armed === btn) disarm(btn); }, 4000);
      return;
    }
    armed = null;
    var act = btn.getAttribute('data-act');
    if (act === 'pause'){
      send('/dsh-brain/api/directives/pause', { paused: btn.getAttribute('data-value') === '1' }, btn);
      return;
    }
    if (act === 'level'){
      var select = document.getElementById('level-select');
      var level = select ? select.value : '';
      if (!level){ errBox('没有选到等级'); return; }
      send('/dsh-brain/api/directives/level', { level: level }, btn);
    }
  });
})();
</script>
</body>
</html>`
}
