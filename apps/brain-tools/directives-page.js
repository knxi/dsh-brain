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

import { renderPageHead } from './nav.js?v=1793594997081'

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
      + '<div class="action-top"><span class="chip accent">' + esc(action.label || action.name) + '</span>'
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
    + '<button class="btn' + (paused ? '' : ' btn--danger') + '" data-act="pause" data-value="'
    + (paused ? '0' : '1') + '" data-confirm="' + (paused ? '恢复自主执行' : '立即暂停所有自主执行') + '">'
    + (paused ? '恢复执行' : '立即暂停') + '</button>'
    + '</div>'
    + '<div class="global-box">'
    + '<div class="global-k">最高权限等级</div>'
    + '<div class="global-v">' + esc(dash(view.maxLevel)) + '</div>'
    + '<div class="global-hint">等级决定哪些动作能被执行。L0 = 只读，几乎所有动作都会拒绝。'
    + '低于动作要求等级时，' + (levelMeta.length ? '闸门（' + esc(levelMeta.join(' / ')) + '）' : '闸门') + '会拦住它。</div>'
    + '<div class="level-row">'
    + '<select id="level-select" class="select" aria-label="权限等级">' + levelOptions + '</select>'
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
        + '<div class="muted tiny">' + esc(item.trigger) + ' / ' + esc(item.source) + '</div>'
        // 批准入口（2026-11-02 补）。之前整页只有「暂停」和「切等级」，没有任何
        // 批准按钮，而 autonomy 转出来的指令一律是 awaiting_approval —— 于是系统
        // 会不停生成「我想做点什么」，主人却没有任何地方能点头，指令永远跑不动。
        + (item.status === 'awaiting_approval'
          ? '<div class="row-actions"><button class="btn btn--sm" data-act="directive-approve"'
            + ' data-id="' + esc(item.id) + '" data-confirm="批准这条指令">批准</button></div>'
          : '')
        + '</td>'
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
      + '<span class="chip accent">' + esc(STEP_KIND_LABELS[step.kind] || step.kind) + '</span>'
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
/* 行内动作按钮（目前只有「批准」）：贴在状态徽章下面，不留额外外边距把行撑高。 */
.row-actions{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap}
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
/* ── 这一页自己的部分：边界两栏 / 全局开关 / 指令队列 / 预算条 / 运行流水 ──
   骨架与通用组件（面板、徽章、按钮、表格、说明、空态）在标记区里，这里不重复。 */

/* 诊断条：左缘一道 2px 状态线，跟面板同底，只标边缘。 */
.diag{margin:0 0 16px;padding:10px 14px;border-radius:var(--r-sm);font-size:13px;
  background:var(--card);border:1px solid var(--line);border-left:2px solid var(--line);
  line-height:1.7;box-shadow:0 1px 2px rgba(23,32,60,.04)}
.diag.warn{border-left-color:var(--warn);background:var(--warn-soft);color:#9a5f0d}
.diag.bad{border-left-color:var(--bad);background:var(--bad-soft);color:#a03c3c}

/* 首屏安全边界：左右两栏。左边白名单（能做），右边硬边界（绝不能做）。
   两栏都必须是能读下去的正文，不是一句概括——这页的第一屏就是它的说明书。 */
.bounds{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:24px}
@media(max-width:920px){.bounds{grid-template-columns:minmax(0,1fr)}}
.bound-title{font-family:var(--mono);font-size:11px;font-weight:600;margin-bottom:11px;
  padding-bottom:7px;border-bottom:1px solid var(--line);letter-spacing:.08em;
  text-transform:uppercase}
.bound-title.ok{color:var(--ok)}
.bound-title.bad{color:var(--bad)}
.action{border-left:2px solid var(--line);padding:2px 0 2px 12px;margin-bottom:12px}
.action-top{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.action-why{font-size:11.5px;color:var(--muted);margin-top:5px;line-height:1.7}
.action-rollback{font-size:11px;color:var(--faint);margin-top:4px;line-height:1.7}
.never{margin:0;padding-left:20px;font-size:12.5px;line-height:1.85;color:var(--ink-2)}
.never li{margin-bottom:8px}
.never li::marker{color:var(--faint)}
.bound-foot{margin-top:13px;font-size:11px;color:var(--muted);
  border-top:1px dashed var(--line);padding-top:10px;line-height:1.7}

/* 全局开关：三格并排。暂停态用 --bad 表示——全页唯一「必须看见」的状态。 */
.global-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
@media(max-width:920px){.global-grid{grid-template-columns:minmax(0,1fr)}}
.global-box{border:1px solid var(--line);border-radius:var(--r-sm);padding:14px 16px;
  background:var(--card-2);min-width:0}
.global-k{font-family:var(--mono);font-size:10.5px;color:var(--muted);letter-spacing:.06em;
  text-transform:uppercase}
.global-v{font-size:23px;font-weight:600;font-family:var(--mono);margin:3px 0 6px;
  font-variant-numeric:tabular-nums;letter-spacing:-.04em;color:var(--ink)}
.global-v.on{color:var(--bad)}
.global-v.small{font-size:12px;font-family:var(--sans);font-weight:500;line-height:1.8;
  letter-spacing:0;color:var(--ink-2)}
.global-hint{font-size:11px;color:var(--muted);line-height:1.7;margin-bottom:10px}
.level-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.level-row .select{width:96px}

/* 队列统计行：一行 mono 数字，比统计条轻一档（它只是队列的脚注）。 */
.stat-line{display:flex;gap:18px;flex-wrap:wrap;font-size:11.5px;color:var(--muted);
  margin-bottom:13px;font-variant-numeric:tabular-nums}
.stat-line b{font-family:var(--mono);font-weight:560;color:var(--ink);margin-left:4px}

/* 状态徽章：绿=完成 / 靛蓝=在跑 / 琥珀=待批准 / 红=坏 / 灰=中性。状态色只做区分，不做强调。 */
.chip.st-running{color:var(--accent);background:var(--accent-soft)}
.chip.st-queued{color:var(--ink-2)}
.chip.st-awaiting_approval{color:var(--warn);background:var(--warn-soft)}
.chip.st-blocked{color:var(--bad);background:var(--bad-soft)}
.chip.st-completed{color:var(--ok);background:var(--ok-soft)}
.chip.st-failed,.chip.st-cancelled{color:var(--bad);background:var(--bad-soft)}
.chip.st-paused{color:var(--muted)}

/* 队列表：标题折行、数字等宽、时间与次要说明降一档 */
.tbl-wrap{overflow-x:auto}
.tbl td.title{max-width:300px;word-break:break-word}
.tbl td.n{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;
  white-space:nowrap}
.tbl td.when{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap;
  font-variant-numeric:tabular-nums}
.tbl td.muted{color:var(--muted);font-size:11px}
.muted.tiny{font-size:10.5px;margin-top:3px}
.err-line{font-size:11px;color:var(--bad);margin-top:4px;word-break:break-word}

/* 预算条：已用 / 预算，超了转红。轨道跟 --raise 同档，不另起底色。 */
.budget-cell{min-width:132px}
.budget-cell .budget{margin-bottom:5px}
.budget-head{display:flex;justify-content:space-between;gap:8px;font-size:10.5px;
  color:var(--muted);margin-bottom:3px}
.budget-head .budget-num{font-size:10.5px}
.budget-bar{height:6px;border-radius:3px;background:var(--raise);overflow:hidden}
.budget-bar span{display:block;height:100%;border-radius:3px;
  background:linear-gradient(90deg,var(--accent-2),var(--accent))}
.budget-bar span.over{background:var(--bad)}

/* 运行流水：一步一行，时间 / 序号等宽，摘要吃掉剩余宽度 */
.sub-block{margin-top:16px}
.sub-title{font-size:12.5px;font-weight:600;margin-bottom:8px;color:var(--ink)}
.steps{display:flex;flex-direction:column;gap:2px}
.step{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;font-size:12.5px;
  padding:7px 0;border-bottom:1px solid var(--line-soft)}
.step:last-child{border-bottom:none}
.step-when{font-family:var(--mono);font-size:10.5px;color:var(--faint);white-space:nowrap;
  min-width:80px;font-variant-numeric:tabular-nums}
.step-seq{font-family:var(--mono);font-size:10.5px;color:var(--faint)}
.step-summary{flex:1;min-width:200px;word-break:break-word;color:var(--ink-2)}

/* 两步确认：armed 时整颗按钮转红，提醒「再点一次就真执行」 */
.btn.armed{border-color:var(--bad);background:var(--bad-soft);color:var(--bad);font-weight:600}

#err{display:none;margin:0 0 16px;padding:10px 14px;border-radius:var(--r-sm);
  border:1px solid var(--line);border-left:2px solid var(--bad);background:var(--bad-soft);
  color:var(--bad);font-size:12.5px;line-height:1.6}
#err.show{display:block}
</style>
</head>
<body>
<div class="wrap wrap-wide">
  ${renderPageHead({
    active: 'directives',
    title: '自主指令',
    sub: '能做什么 · 绝不能做什么 · 队列 · 运行流水'
  })}
  <div class="path">scope: ${esc(scopeId)} · /dsh-brain/api/directives · 生成于 ${esc(fmtWhen(v.at))}</div>

  <div id="err"></div>
  ${unavailableBox}
  ${errorsBox}
  ${schemaBox}

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">这个执行器的边界（先看这里）</span>
      <span class="panel-meta">读自包的能力自述，不是手抄</span>
    </div>
    <div class="panel-body">${boundaryPanel(v)}</div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">全局开关</span>
      <span class="panel-meta">暂停优先于一切</span>
    </div>
    <div class="panel-body">${globalPanel(v)}</div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">指令队列</span>
      <span class="panel-meta">${esc(String(v.directives.length))} 条</span>
    </div>
    <div class="panel-body">
      ${statsLine}
      ${queuePanel(v.directives)}
    </div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">运行记录与步进流水</span>
      <span class="panel-meta">真跑过的步骤</span>
    </div>
    <div class="panel-body">${runsPanel(v)}</div>
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
      return;
    }
    if (act === 'directive-approve'){
      send('/dsh-brain/api/directives/approve', { id: btn.getAttribute('data-id') }, btn);
      return;
    }
  });
})();
</script>
</body>
</html>`
}
