// @ts-check
/**
 * 外置大脑 · 心情页（/dsh-brain/mood，内嵌在 DSH Web 里，同源无额外端口）
 *
 * ── 这页要解决什么 ──
 *
 * 心情 / 精力 / 亲密度是三个**会自己演化**的数（`plugins/dsh-fox-mood/core.js` 的
 * `evolve`：按小时回精力、按长期不动降心情），它们决定我说话的语气、要不要主动开口、
 * 亲密度够不够喊人。但之前这三格里发生的事只有提示词里看得见——人只能从我的语气里猜，
 * 而语气是最容易骗人的东西。
 *
 * 所以这页做三件事：现在是多少、定性词是什么、最近怎么回事。
 * 顺带明确一件事：**情绪也是要跟着记忆一起备份的数据**，所以它得能看、能核对，
 * 而不是黑盒里一个数字。
 *
 * ── 口径纪律（照 CONTRACTS §17.2 / §18.4）──
 *
 * - 缺字段一律显示「–」，**绝不编 0**。`state === null`（主账没情感表、插件备档也读不到）
 *   时三个数字都是「–」，因为「没记录」和「记 0 分」是两件事，混了就把「读不到」说成
 *   「它心情归零了」——后果完全不同。
 * - 定性词照抄 `plugins/dsh-fox-mood/core.js` 的 `describeMood / describeEnergy /
 *   describeBond`，**不自己发明一套**：同一条 86 分在提示词里叫「很好，有点飘」、
 *   在页面上叫「优秀」，读的人会以为是两件事。三张档位表逐字对齐那边。
 * - 事件的中文标签优先用接口给的 `label`（后端已按 EVENT_EFFECTS 映射好），
 *   只有在 label 缺失时才用本页这份兜底表——不维护第二个真相。
 *
 * ── 三个状态都得写对（这页最容易偷懒的地方）──
 *
 *   1. 有数据：三格数字 + 定性词 + 时间线（时间 / 中文标签 / 备注 / delta）。
 *   2. 有状态但事件为空：「还没有情感记录」+ 一句这页为什么存在。
 *   3. `state === null`：三格「–」+ 顶部说明「这是没记录，不是 0 分」。
 *
 * 视觉沿用项目既定语言：纸感浅色、单一赭石强调、等宽数字、留白克制。
 * 涨（delta > 0）用 --ok 绿、跌用 --bad 红，**零不动不显示**——一排 +0 只是噪声。
 */

import { renderNav, NAV_CSS } from './nav.js'

/** @param {{ scopeId?: string }} [opts] */
export function renderMoodPage({ scopeId } = {}) {
  const escapedScope = String(scopeId == null ? '' : scopeId).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 心情</title>
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
.wrap{max-width:1080px;margin:0 auto;padding:38px 30px 80px}
.head{display:flex;align-items:baseline;gap:14px;margin-bottom:6px}
h1{font-size:21px;font-weight:650;letter-spacing:.01em;margin:0}
.sub{color:var(--muted);font-size:12.5px}
.path{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-bottom:22px;word-break:break-all}

.diag{margin:0 0 18px;padding:13px 17px;border-radius:10px;font-size:13px;
  background:var(--card);border:1px solid var(--line);line-height:1.7}
.diag.warn{border-color:#e8cdb4;background:#fdf6ee;color:#8a5327}

/* 三格大数字：数字是这页的主角，定性词跟在底下当注脚。
   1px 的 --line 做格线（跟使用情况页的 stats 同一套做法），不新造色值。 */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);
  border:1px solid var(--line);border-radius:14px;overflow:hidden;margin-bottom:16px}
.stat{background:var(--card);padding:20px 22px;display:flex;flex-direction:column;gap:3px;min-width:0}
.stat-k{font-size:11px;color:var(--muted);letter-spacing:.05em}
.stat-v{font-size:34px;font-weight:640;font-family:var(--mono);font-variant-numeric:tabular-nums;line-height:1.15}
.stat-n{font-size:12.5px;color:var(--muted)}
@media(max-width:620px){.stats{grid-template-columns:1fr}}

.meta{display:flex;gap:22px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-bottom:22px}
.meta b{font-weight:550;color:var(--ink);font-family:var(--mono);font-size:11.5px;margin-left:5px}

.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  margin-bottom:20px;overflow:hidden}
.card-head{display:flex;align-items:baseline;gap:10px;padding:14px 20px;
  border-bottom:1px solid var(--line);background:#fdfaf6;flex-wrap:wrap}
.card-title{font-size:13.5px;font-weight:620}
.card-meta{font-size:11.5px;color:var(--muted);margin-left:auto}
.body{padding:4px 20px 12px}

/* 时间线：一行一件事。时间列定宽等宽数字，右边正文自适应。
   不加竖线、不加圆点——信息密度够低，加了反而是装饰。 */
.ev{display:flex;gap:14px;padding:12px 0;border-bottom:1px solid var(--line)}
.ev:last-child{border-bottom:none}
.ev-when{font-family:var(--mono);font-size:11.5px;color:var(--muted);white-space:nowrap;
  min-width:84px;padding-top:2px;font-variant-numeric:tabular-nums}
.ev-main{flex:1;min-width:0}
.ev-label{font-size:13.5px;font-weight:560;line-height:1.5}
.ev-note{font-size:12.5px;color:var(--muted);margin-top:2px;white-space:pre-wrap;word-break:break-word}
.ev-delta{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.dl{font-family:var(--mono);font-size:11px;padding:1px 7px;border-radius:5px;
  font-variant-numeric:tabular-nums;white-space:nowrap}
.dl.up{background:#e6f0ea;color:var(--ok)}
.dl.down{background:#f6e6e4;color:var(--bad)}

.empty{padding:40px 0 44px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}
.empty strong{display:block;color:var(--ink);font-size:14.5px;font-weight:620;margin-bottom:6px}
.empty span{display:block;max-width:520px;margin:0 auto}
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
    <h1>心情</h1>
    <span class="sub">情感状态的只读视图</span>
    ${renderNav({ active: 'mood' })}
  </div>
  <div class="path">scope: ${escapedScope} · /dsh-brain/api/mood</div>

  <div id="top-note"></div>

  <div class="stats" id="stats">
    <div class="stat">
      <span class="stat-k">心情</span>
      <span class="stat-v" id="m-mood">–</span>
      <span class="stat-n" id="m-mood-t">–</span>
    </div>
    <div class="stat">
      <span class="stat-k">精力</span>
      <span class="stat-v" id="m-energy">–</span>
      <span class="stat-n" id="m-energy-t">–</span>
    </div>
    <div class="stat">
      <span class="stat-k">亲密</span>
      <span class="stat-v" id="m-bond">–</span>
      <span class="stat-n" id="m-bond-t">–</span>
    </div>
  </div>

  <div class="meta">
    <span>数据来源 <b id="meta-source">–</b></span>
    <span>状态更新于 <b id="meta-updated">–</b></span>
    <span>最近互动 <b id="meta-interact">–</b></span>
    <span>事件 <b id="meta-count">–</b></span>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">最近事件</span>
      <span class="card-meta" id="ev-meta">–</span>
    </div>
    <div class="body" id="events"><div class="empty">载入中…</div></div>
  </div>

  <p class="note">
    <b>这页为什么存在：</b>三个数不是每次现编的——它们由
    <code>plugins/dsh-fox-mood/core.js</code> 的 <code>evolve</code> 按时间和事件自己演化，
    决定我主动说话的分寸和称呼。既然它会影响我说出口的每句话，就不该只在提示词里黑着：
    能看见、能核对，才不会被一句「还好」糊过去。它也是**要跟着记忆一起备份的数据**。
    <b>定性词和提示词里的是同一套口径</b>，页面上写着什么，我收到的就是什么。
  </p>

  <div class="foot">
    <span>只读视图 · 数据来自 /dsh-brain/api/mood</span>
    <span style="flex:1"></span>
    <a href="/dsh-brain">回记忆</a>
  </div>
</div>
<script>
(function(){
  var API = '/dsh-brain/api/mood'
  // 缺字段一律显示「–」，不编 0（CONTRACTS §17.2 / §18.4）。
  var DASH = '–'

  function el(tag, cls, text){
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  function txt(id, v){ var n = document.getElementById(id); if (n) n.textContent = v }
  function readTxt(id){ var n = document.getElementById(id); return n ? n.textContent : '' }
  function isNum(v){ return typeof v === 'number' && isFinite(v) }

  // ── 定性词：逐字照抄 plugins/dsh-fox-mood/core.js 的三张档位表 ──────────
  // 那边是给提示词说人话用的；这边是给人看的。同一个数字必须落同一个词，
  // 否则「页面上写 86 很好」和「提示词里写 86 还算平稳」会互相打脸。
  function describeMood(v){
    if (v >= 85) return '很好，有点飘'
    if (v >= 70) return '不错'
    if (v >= 55) return '还算平稳'
    if (v >= 40) return '有点低落'
    if (v >= 25) return '明显不开心'
    return '很糟，别招我'
  }
  function describeEnergy(v){
    if (v >= 85) return '精神得很'
    if (v >= 70) return '清醒'
    if (v >= 55) return '正常'
    if (v >= 40) return '有点乏'
    if (v >= 25) return '很困，脑子发钝'
    return '快没了，只想瘫着'
  }
  function describeBond(v){
    if (v >= 85) return '很熟，能互相损'
    if (v >= 70) return '亲近，说话可以不客气'
    if (v >= 55) return '熟悉，会开点玩笑'
    if (v >= 40) return '认识了，开始有默契'
    if (v >= 25) return '刚认识不久，客气但真诚'
    return '还很生分'
  }

  // ── 事件中文标签兜底表 ─────────────────────────────────────────────
  // 接口已经按 EVENT_EFFECTS 给了 label，正常情况用不上这张表；
  // 留着只是为了「label 缺了就退回 kind」，而不是让页面上出现英文 kind。
  var KIND_LABEL = {
    praise: '被夸了', retasked: '被返工', pushed: '被催了', interesting: '碰到有意思的东西',
    success: '事情办成了', failure: '办砸了', late_night: '深夜还陪着', long_absence: '好久没见了',
    chat: '聊了几句', rest: '歇了一会儿'
  }
  function kindLabel(k){
    if (typeof k === 'string' && k !== '') return KIND_LABEL[k] || k
    return '未知事件'
  }

  // delta 的固定顺序：心情 / 精力 / 亲密。零不动不显示。
  var DELTA_KEYS = [['mood', '心情'], ['energy', '精力'], ['bond', '亲密']]

  function fmtWhen(v){
    if (v === null || v === undefined || v === '') return DASH
    var d = typeof v === 'number' ? new Date(v) : new Date(String(v))
    if (isNaN(d.getTime())) return String(v)
    var p = function(n){ return String(n).padStart(2, '0') }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function sourceText(s){
    if (s === 'brain') return '主账'
    if (s === 'state.json') return '插件备档'
    if (s === 'unavailable') return '读不到'
    if (typeof s === 'string' && s !== '') return s
    return DASH
  }

  // 页面运行态。不挂到 DOM 上——DOM stub 里读不到子节点拼起来的文本，
  // 所以渲染时同步记一份，供 window.__mood.state() 与断言用（记的**就是**写进 DOM 的内容）。
  var view = {
    status: 'loading',    // loading / ok / nostate / error
    source: null,
    hasState: false,
    events: 0,
    eventsEmpty: false,
    error: null,
    topNote: '',
    rendered: [],         // [{ when, label, note, delta: ['心情 +7', ...] }]
    meta: { source: DASH, updated: DASH, interact: DASH, count: DASH }
  }

  function setStat(numId, textId, value, describe){
    var ok = isNum(value)
    txt(numId, ok ? String(Math.round(value)) : DASH)
    txt(textId, ok ? describe(value) : DASH)
  }

  function setTopNote(text, warn){
    var host = document.getElementById('top-note')
    if (host) host.textContent = ''
    view.topNote = text || ''
    if (host && text) host.appendChild(el('div', warn ? 'diag warn' : 'diag', text))
  }

  function emptyBox(title, why){
    var box = el('div', 'empty')
    box.appendChild(el('strong', null, title))
    box.appendChild(el('span', null, why))
    return box
  }

  function deltaRow(delta){
    if (!delta || typeof delta !== 'object') return null
    var box = null
    for (var i = 0; i < DELTA_KEYS.length; i++){
      var key = DELTA_KEYS[i][0]
      var v = delta[key]
      if (!isNum(v) || v === 0) continue
      if (!box) box = el('div', 'ev-delta')
      box.appendChild(el('span', 'dl ' + (v > 0 ? 'up' : 'down'),
        DELTA_KEYS[i][1] + ' ' + (v > 0 ? '+' : '') + String(v)))
    }
    return box
  }
  function deltaTexts(delta){
    var out = []
    if (!delta || typeof delta !== 'object') return out
    for (var i = 0; i < DELTA_KEYS.length; i++){
      var v = delta[DELTA_KEYS[i][0]]
      if (!isNum(v) || v === 0) continue
      out.push(DELTA_KEYS[i][1] + ' ' + (v > 0 ? '+' : '') + String(v))
    }
    return out
  }

  // ── 事件时间线 ─────────────────────────────────────────────────────
  function renderEvents(list){
    var host = document.getElementById('events')
    if (host) host.textContent = ''
    view.rendered = []
    if (!Array.isArray(list)){
      // 没给 events 字段：这是「读不到」，不是「没有记录」——两者不能混。
      view.events = 0
      view.eventsEmpty = false
      if (host) host.appendChild(emptyBox('事件没读到',
        '接口没有返回 events 字段，所以这条线是空的——不代表没有记录。'))
      txt('ev-meta', '数据缺失')
      return
    }
    view.events = list.length
    if (list.length === 0){
      view.eventsEmpty = true
      if (host) host.appendChild(emptyBox('还没有情感记录',
        '一次都还没记过：被夸、被返工、办成一件事、深夜还陪着，都会在这条线上留一格。'
        + '心境就是靠这些一格一格变的，所以这页存在——不然只能从我说话的语气里猜。'))
      txt('ev-meta', '0 条')
      return
    }
    txt('ev-meta', '显示最近 ' + list.length + ' 条')
    var i = 0
    for (i = 0; i < list.length; i++){
      var e = list[i] || {}
      var row = el('div', 'ev')
      var when = fmtWhen(e.at)
      row.appendChild(el('div', 'ev-when', when))
      var main = el('div', 'ev-main')
      var label = (typeof e.label === 'string' && e.label !== '') ? e.label : kindLabel(e.kind)
      main.appendChild(el('div', 'ev-label', label))
      var note = (typeof e.note === 'string' && e.note !== '') ? e.note : null
      if (note) main.appendChild(el('div', 'ev-note', note))
      var chips = deltaRow(e.delta)
      if (chips) main.appendChild(chips)
      row.appendChild(main)
      if (host) host.appendChild(row)
      view.rendered.push({ when: when, label: label, note: note, delta: deltaTexts(e.delta) })
    }
  }

  function renderMeta(d, state){
    var stats = d.stats && typeof d.stats === 'object' ? d.stats : null
    view.meta.source = sourceText(d.source)
    view.meta.updated = state ? fmtWhen(state.updatedAt) : DASH
    view.meta.interact = state ? fmtWhen(state.lastInteractAt) : DASH
    view.meta.count = (stats && isNum(stats.events)) ? String(stats.events) + ' 条' : DASH
    txt('meta-source', view.meta.source)
    txt('meta-updated', view.meta.updated)
    txt('meta-interact', view.meta.interact)
    txt('meta-count', view.meta.count)
  }

  function renderAll(d){
    var state = (d.state && typeof d.state === 'object') ? d.state : null
    view.hasState = state !== null
    view.error = null
    renderMeta(d, state)
    if (state === null){
      view.status = 'nostate'
      setStat('m-mood', 'm-mood-t', null, describeMood)
      setStat('m-energy', 'm-energy-t', null, describeEnergy)
      setStat('m-bond', 'm-bond-t', null, describeBond)
      setTopNote('没有读到情感状态：主账的情感表还没数据，插件备档也读不到。'
        + '三格显示「–」——这是「没有记录」，不是 0 分。', true)
    } else {
      view.status = 'ok'
      setStat('m-mood', 'm-mood-t', state.mood, describeMood)
      setStat('m-energy', 'm-energy-t', state.energy, describeEnergy)
      setStat('m-bond', 'm-bond-t', state.bond, describeBond)
      setTopNote('')
    }
    renderEvents(d.events)
  }

  function fail(message){
    view.status = 'error'
    view.error = message
    view.hasState = false
    view.events = 0
    view.eventsEmpty = false
    view.rendered = []
    setStat('m-mood', 'm-mood-t', null, describeMood)
    setStat('m-energy', 'm-energy-t', null, describeEnergy)
    setStat('m-bond', 'm-bond-t', null, describeBond)
    view.meta.source = DASH
    view.meta.updated = DASH
    view.meta.interact = DASH
    view.meta.count = DASH
    txt('meta-source', DASH)
    txt('meta-updated', DASH)
    txt('meta-interact', DASH)
    txt('meta-count', DASH)
    setTopNote('读不到情感状态：' + message + '。三格显示「–」——状态未知，不是 0。', true)
    var host = document.getElementById('events')
    if (host){
      host.textContent = ''
      host.appendChild(emptyBox('事件没读到', '接口这次没返回可用数据，所以这条线是空的——不是「没有记录」。'))
    }
    txt('ev-meta', '读取失败')
  }

  function load(){
    view.status = 'loading'
    return fetch(API, { credentials: 'same-origin' })
      .then(function(r){ return r.json() })
      .then(function(d){
        if (!d || d.ok !== true){
          fail((d && d.message) ? String(d.message) : '接口没有返回 ok:true')
          return
        }
        renderAll(d)
      }, function(e){
        fail((e && e.message) ? String(e.message) : String(e))
      })
      .then(function(){ return view })
  }

  // ── 自动化钩子（verify-pages / 本地 probe 用）──────────────────────
  // DOM stub 里 addEventListener 是空实现、querySelector 恒为 null，
  // 所以断言不能靠「点一下再看」。这里把运行态与**已渲染进 DOM 的内容**摊出来：
  //   window.__mood.state()   -> { status, hasState, numbers, texts, meta, rendered, eventsEmpty, topNote }
  //   window.__mood.reload()  -> Promise，重跑一次真实加载路径
  var moodApi = {
    state: function(){
      return {
        status: view.status,
        source: view.source,
        hasState: view.hasState,
        events: view.events,
        eventsEmpty: view.eventsEmpty,
        error: view.error,
        topNote: view.topNote,
        numbers: {
          mood: readTxt('m-mood'),
          energy: readTxt('m-energy'),
          bond: readTxt('m-bond')
        },
        texts: {
          mood: readTxt('m-mood-t'),
          energy: readTxt('m-energy-t'),
          bond: readTxt('m-bond-t')
        },
        meta: {
          source: readTxt('meta-source'),
          updated: readTxt('meta-updated'),
          interact: readTxt('meta-interact'),
          count: readTxt('meta-count')
        },
        rendered: view.rendered.slice()
      }
    },
    reload: load
  }
  if (typeof window !== 'undefined') window.__mood = moodApi

  load()
})()
</script>
</body>
</html>`
}
