// @ts-check
/**
 * 外置大脑 · 矛盾核验页面（/dsh-brain/conflicts，内嵌在 DSH Web 里，同源无额外端口）
 *
 * ── 这页要解决什么 ──
 *
 * M6 把 Engram 的 `contradicts` 迁进来了，共 6 条。它们**并列保留**——没有任何自动选边，
 * 因为「哪条对」这件事只有主人能判。但之前只能看 `/api/conflicts` 的 JSON，
 * 而判断需要的恰恰是并排看全文：同一个说法详略不同，还是真冲突，得读原文。
 *
 * 2026-10-30 起这页不只是看：判断完之后可以直接在这页做核验。
 * 依据 CONTRACTS §17.4「永不自动选边。人核验完再动手，动作要能回滚」——
 * 把「人已经做完判断之后的那一步」搬到页面上，而不是让人回命令行跑 merge-duplicates.mjs。
 *
 * ── 三个动作的语义（页面文案必须如实照这个写，不许含糊）──
 *
 * - keep-left ：留左侧，右侧被左侧取代。走门面 `memories.supersede`：右侧封口
 *               （status=superseded）、`valid_until` 落值、**正文一个字不删**、
 *               `asOf` 回看历史时刻仍能读到旧说法；随后删掉这条矛盾边。
 * - keep-right：反过来。
 * - not-conflict：两条记忆都不动，只把这条边从「矛盾」改标成「细化（refines）/
 *               佐证（supports）」（删矛盾边 + 建一条新 kind 的边）。
 *
 * 三个动作都必须**先把后果说清、再点第二下**才发请求（两步确认）。理由和
 * `tools/merge-duplicates.mjs` 默认 dry-run 是同一条：判断错了要能看见「刚才到底做了什么」
 * 和「怎么撤销」，不能一键落库。
 *
 * ── 为什么不用 window.confirm ──
 *
 * `tools/verify-pages.mjs` 的 DOM stub 里没有 confirm（也没有 alert），用了就是 TypeError，
 * 内联脚本跑不完、冒烟直接红。而且 confirm 只有一句话、不能随动作变文案、更说不出
 * 「valid_until 会落值、正文不删」——它挡不住误操作，只多了一次点击。
 * 所以这里用「按钮自己变成确认态 + 卡片里写出后果」：第一次点不落库，第二次才发请求，
 * 3 秒内不点第二次自动退回。
 *
 * 视觉沿用项目既定语言：纸感浅色、单一赭石强调、等宽数字、留白克制。
 * 矛盾用唯一的红（--bad），因为这是全项目唯一「需要人现在处理」的状态；已核验用 --ok。
 * 动作区**不新造色值**：只用页面上已经存在的 --ochre / --ochre-soft / --ok / --bad /
 * --bad-soft / --line / --card / --muted 和 #fdfaf6、#8f3d35（banner 里已在用）。
 */

// 导航统一收在 nav.js（顺序与高亮只在那定义一次）。页面只说自己是谁。
import { renderNav, NAV_CSS } from './nav.js'

/** @param {{ scopeId: string }} opts */
export function renderConflictsPage({ scopeId }) {
  const escapedScope = String(scopeId).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 矛盾核验</title>
<style>
:root{
  --paper:#faf8f4; --card:#fffdfa; --ink:#241f1b; --muted:#8a8178;
  --line:#e7e0d6; --ochre:#a8632f; --ochre-soft:#f3e6d8;
  --ok:#3f7f5f; --warn:#a8632f; --bad:#a8443a; --bad-soft:#fbf0ee;
  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);
  font:14px/1.7 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  -webkit-font-smoothing:antialiased}
.wrap{max-width:1120px;margin:0 auto;padding:38px 30px 80px}
.head{display:flex;align-items:baseline;gap:14px;margin-bottom:6px}
h1{font-size:21px;font-weight:650;letter-spacing:.01em;margin:0}
.sub{color:var(--muted);font-size:12.5px}
.nav{display:flex;gap:8px;margin-left:auto}
.navlink{font-size:13px;padding:8px 15px;border:1px solid var(--line);border-radius:10px;
  background:var(--card);color:var(--ink);text-decoration:none;transition:all .18s;white-space:nowrap}
.navlink:hover{border-color:var(--ochre);color:var(--ochre)}
.path{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-bottom:22px}

.banner{background:var(--bad-soft);border:1px solid #eccfca;border-radius:12px;
  padding:15px 19px;margin-bottom:22px;color:#8f3d35;font-size:13.5px;line-height:1.7}
.banner b{font-weight:650}

.stats{display:flex;gap:26px;padding:15px 20px;background:var(--card);border:1px solid var(--line);
  border-radius:12px;margin-bottom:22px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column;gap:2px}
.stat-k{font-size:10.5px;color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
.stat-v{font-size:19px;font-weight:620;font-family:var(--mono);font-variant-numeric:tabular-nums}
.stat-v.bad{color:var(--bad)}
.stat-v.ok{color:var(--ok)}

.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  margin-bottom:20px;overflow:hidden;transition:box-shadow .2s}
.card:hover{box-shadow:0 2px 14px rgba(36,31,27,.05)}
/* 已核验：左侧一条 ok 色竖线，不改边框粗细（避免布局跳动），也不新造色值 */
.card.done{box-shadow:inset 3px 0 0 var(--ok)}
.card.done:hover{box-shadow:inset 3px 0 0 var(--ok),0 2px 14px rgba(36,31,27,.05)}
.card-head{display:flex;align-items:baseline;gap:10px;padding:14px 20px;
  border-bottom:1px solid var(--line);background:#fdfaf6;flex-wrap:wrap}
.idx{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.kind{font-size:11px;padding:2px 8px;border-radius:6px;background:var(--bad-soft);
  color:var(--bad);font-weight:550;letter-spacing:.02em}
.meta{font-size:11.5px;color:var(--muted);margin-left:auto}

.pair{display:grid;grid-template-columns:1fr 46px 1fr;align-items:stretch}
@media(max-width:820px){.pair{grid-template-columns:1fr}}
.side{padding:18px 20px;min-width:0}
.side.b{background:#fdfbf8}
.vs{display:flex;align-items:center;justify-content:center;color:var(--muted);
  font-size:15px;border-left:1px solid var(--line);border-right:1px solid var(--line)}
@media(max-width:820px){
  .vs{border-left:none;border-right:none;border-top:1px solid var(--line);
    border-bottom:1px solid var(--line);padding:6px 0;font-size:12px}
}
.side-tag{font-size:10.5px;color:var(--muted);letter-spacing:.08em;margin-bottom:8px;text-transform:uppercase}
.text{margin:0 0 12px;font-size:13.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word}
.text.clamped{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.more{font-size:11.5px;color:var(--ochre);background:none;border:none;padding:0;
  cursor:pointer;text-decoration:underline dotted;margin-bottom:10px}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}
.chip{font-size:10.5px;padding:2px 7px;border-radius:5px;background:#f1ece4;color:var(--muted)}
.chip.ent{background:var(--ochre-soft);color:var(--ochre)}
.chip.time{font-family:var(--mono);letter-spacing:-.01em}
.mid{display:flex;align-items:baseline;gap:10px;font-size:11px;color:var(--muted);
  border-top:1px dotted var(--line);padding-top:9px;flex-wrap:wrap}
.mid code{font-family:var(--mono);font-size:10.5px;background:#f1ece4;padding:1px 5px;
  border-radius:4px;cursor:pointer}
.mid code:hover{background:var(--ochre-soft);color:var(--ochre)}

/* ── 动作区：每个动作第一次点只是把后果写出来，第二次才落库 ── */
.side-act{margin-top:11px}
.act{font-family:inherit;font-size:12px;padding:7px 13px;border-radius:9px;line-height:1.45;
  border:1px solid var(--line);background:var(--card);color:var(--ink);
  cursor:pointer;transition:all .16s;text-align:left}
.act:hover{border-color:var(--ochre);color:var(--ochre)}
.act.armed{background:var(--ochre);border-color:var(--ochre);color:var(--card);font-weight:600}
.act.armed:hover{color:var(--card)}
.act.working{opacity:.55;cursor:progress;border-color:var(--line);color:var(--muted)}
.act.disabled{opacity:.4;cursor:not-allowed}
.act.disabled:hover{border-color:var(--line);color:var(--ink)}
.judge{display:flex;align-items:center;gap:10px;padding:12px 20px;border-top:1px solid var(--line);
  background:#fdfaf6;flex-wrap:wrap}
.judge-label{font-size:12px;color:var(--muted)}
.rel-select{font-family:inherit;font-size:12px;padding:6px 9px;border-radius:8px;
  border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
.hint{display:none;font-size:12.5px;line-height:1.8;white-space:pre-wrap;word-break:break-word}
.hint.show{display:block;padding:11px 20px;border-top:1px solid var(--line)}
.hint.pending{background:var(--ochre-soft);color:var(--ochre)}
.hint.ok{background:#fdfaf6;color:var(--ok);border-left:3px solid var(--ok)}
.hint.bad{background:var(--bad-soft);color:#8f3d35;border-left:3px solid var(--bad)}
.badge{font-size:10.5px;padding:2px 8px;border-radius:6px;font-weight:600;letter-spacing:.02em;
  border:1px solid transparent}
.badge:empty{display:none}
.badge.done{border-color:var(--ok);color:var(--ok)}

.reason{padding:11px 20px;border-top:1px solid var(--line);font-size:12.5px;
  color:var(--muted);background:#fdfaf6}
.reason b{color:var(--ink);font-weight:550}

.empty{background:var(--card);border:1px solid var(--line);border-radius:14px;
  padding:52px 24px;text-align:center;color:var(--muted);font-size:13.5px;line-height:1.9}
.empty strong{display:block;color:var(--ok);font-size:15px;margin-bottom:6px}
.note{font-size:12px;color:var(--muted);margin-top:22px;padding:13px 17px;border-left:2px solid var(--line);line-height:1.8}
.note b{color:var(--ink);font-weight:550}
.foot{margin-top:34px;padding-top:20px;border-top:1px solid var(--line);
  color:var(--muted);font-size:12px;display:flex;gap:18px;flex-wrap:wrap;align-items:center}
.foot a{color:var(--ochre);text-decoration:none;border-bottom:1px dotted currentColor}
${NAV_CSS}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>矛盾核验</h1>
    <span class="sub">并排读原文，然后在这里定</span>
    ${renderNav({ active: 'conflicts' })}
  </div>
  <div class="path">scope: ${escapedScope} · /dsh-brain/api/conflicts</div>

  <div class="banner">
    这些记忆<strong>两条都还活着</strong>，系统没有替你选边，也不会自动合并或删除——判断需要的不是相似度，
    是把两条原文并排读一遍。读完可以<strong>直接在这页定</strong>：每个动作第一次点只是把后果写给你看，
    第二次才真的落库。
  </div>

  <div class="stats" id="stats">
    <div class="stat"><span class="stat-k">待核验</span><span class="stat-v bad" id="s-total">–</span></div>
    <div class="stat"><span class="stat-k">全部关系</span><span class="stat-v" id="s-all">–</span></div>
    <div class="stat"><span class="stat-k">其中取代</span><span class="stat-v" id="s-sup">–</span></div>
    <div class="stat"><span class="stat-k">本次已核验</span><span class="stat-v ok" id="s-done">0</span></div>
  </div>

  <div id="list"><div class="empty">载入中…</div></div>

  <p class="note">
    <b>三个动作各自做什么</b>（点第二下之前，卡片里会把对应那条原话再写一遍）：
    「保留这条」= 这一条留下，另一条走 <code>supersedes</code> 封口（<code>valid_until</code> 落值、
    <b>正文一个字不删</b>、<code>asOf</code> 回看历史时刻仍能读到），然后删掉这条矛盾边；
    「两条都对，不是矛盾」= 两条记忆都不动，只把关系从「矛盾」改标成「细化 / 佐证」。
    <b>删是不可逆的，取代不是</b>——所以这里没有「直接删掉一条」的入口。
  </p>

  <div class="foot">
    <span>动作都留痕、都能撤销：每张卡核验完会给出撤销方式（rollbackHint）。系统永不自动选边。</span>
    <span style="flex:1"></span>
    <a href="/dsh-brain">回列表</a>
  </div>
</div>
<script>
(function(){
  var ACTION_URL = '/dsh-brain/api/conflicts/action'
  var LIST_URL = '/dsh-brain/api/conflicts?limit=200'
  // 两步确认的退回时限：3 秒够看清后果，又不至于离开工位回来还挂着「等你确认」。
  var CONFIRM_TTL = 3000
  // 本次页面里核验成功的卡片数（只影响顶部那一格，不参与任何库内统计）
  var doneCount = 0
  /** 每张卡的运行时状态：edgeId / busy / done / armed / timer / 按钮集合 */
  var CARDS = []

  function el(tag, cls, text){ var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
  function txt(id, v){ var n = document.getElementById(id); if (n) n.textContent = v }
  function fmt(iso){ if (!iso) return '–'; var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function(n){ return String(n).padStart(2,'0') }
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) }

  // ── 动作规格：label / confirmLabel / consequence 三样都必须如实描述后果 ──────
  // consequence 会在第一次点击后原样显示在卡片里，所以它必须说清「会动什么、不会动什么」。
  function keepSpec(act){
    var isLeft = act === 'keep-left'
    var keptSide = isLeft ? '左' : '右'
    var goneSide = isLeft ? '右' : '左'
    var keptTag = isLeft ? 'A' : 'B'
    var goneTag = isLeft ? 'B' : 'A'
    return {
      action: act,
      cls: isLeft ? 'act-keep-left' : 'act-keep-right',
      label: '保留这条（' + keptTag + '）',
      confirmLabel: '确认：' + goneSide + '侧封口 →',
      short: '保留' + keptSide + '侧、封口' + goneSide + '侧',
      consequence: keptSide + '侧（' + keptTag + '）原样保留，一个字都不改。' +
        goneSide + '侧（' + goneTag + '）会被标成「已被取代」：valid_until 落上今天的日期，' +
        '正文不删、asOf 回看历史时刻仍能读到它。然后删掉这条矛盾边。'
    }
  }

  function relLabel(kind){ return kind === 'supports' ? '佐证' : '细化' }

  function notConflictSpec(kind){
    var k = kind === 'supports' ? 'supports' : 'refines'
    var name = relLabel(k)
    var meaning = k === 'supports'
      ? '两条不是互相打脸，而是各自独立、可以互相印证'
      : '两条不是互相打脸，而是详略/粒度不同——B（右）是 A（左）更细的说法'
    return {
      action: 'not-conflict',
      kind: k,
      cls: 'act-not-conflict',
      label: '改标成「' + name + '」',
      confirmLabel: '确认：改标成「' + name + '」→',
      short: '把「矛盾」改标成「' + name + '」',
      consequence: '两条记忆一个字都不动，只把这条边从「矛盾」改标成「' + name + '」：' +
        meaning + '。关系方向沿用原来那条矛盾边（A → B），不重排两端。'
    }
  }

  // ── 后端错误码 → 人话 ──────────────────────────────────────────────
  // 原则：能说清「为什么 + 现在该干什么」的才写明确解释；拿不准的一律归 UNKNOWN
  // 并让主人把原话发过来，**不猜**。错误码本身必须原样显示，方便对日志。
  var ERROR_TEXT = {
    EDGE_NOT_FOUND: '这张矛盾边已经不在库里了——可能刚被核验过，或它两端的记忆有一条被删了。刷新页面看最新状态。',
    ALREADY_RESOLVED: '这条矛盾已经处理过了（可能另一个标签页先点了）。刷新页面看最新状态。',
    INVALID_ACTION: '页面发的动作后端不认识——是页面和后端版本对不上，刷新页面（必要时重装插件）再试。',
    FORBIDDEN: '被后端的同源写保护挡下了（不是同源页面发的、或少了 X-Brain-Action 头）。从这页点按钮重试；还不行把这个 code 发我。',
    BAD_REQUEST: '请求缺字段或格式不对（edgeId / action 必填）。这是页面 bug，把 code 发我。',
    SCOPE_MISMATCH: '这条边不属于当前 scope，没动它。确认你在对的 scope 页面上。',
    BUSY: '库正忙（另一个写入还没结束），等一两秒再点一次。',
    NETWORK: '连不上本机服务：确认 dsh web 还在跑，然后刷新页面。'
  }
  var UNKNOWN_TEXT = '后端没说清原因。把 code 和后面那行原话发我。'

  function humanOf(code, msg){
    if (code && ERROR_TEXT[code]) return ERROR_TEXT[code]
    // 接口回了 HTTP 错误页（多半是 404：后端还没上这个动作接口，或前缀对不上）。
    // 这一条必须和 NETWORK 分开——服务在跑却说「连不上」，比不说更糟。
    if (code && code.indexOf('HTTP_') === 0) {
      return '接口回了 HTTP ' + code.slice(5) + '，不是正常 JSON——多半是这个动作接口还没上（或路由前缀不对），不是网络问题。把这个 code 发我。'
    }
    // 有的路径会把 SQLite 的忙/锁包成 5xx，code 不是我们的枚举——按原话判断，不编 code
    if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String(msg || ''))) return ERROR_TEXT.BUSY
    return UNKNOWN_TEXT
  }

  // ── 两步确认的状态机 ───────────────────────────────────────────────
  // 同一张卡同一时刻只允许一个动作处于「待确认」（armed）：点另一个动作会先把上一个退回，
  // 否则屏幕上会出现两个橙色确认按钮，第二步点哪个都说不清。
  function clearArm(card){
    if (card.timer) { try { clearTimeout(card.timer) } catch (e) { /* 忽略 */ } card.timer = null }
    card.armed = null
  }

  function resetButtons(card){
    for (var i = 0; i < card.buttons.length; i++) {
      var b = card.buttons[i]
      b.className = 'act ' + b.__cls
      b.textContent = b.__label
    }
  }

  function disarm(card){
    var armed = card.armed
    clearArm(card)
    if (armed && armed.btn) {
      armed.btn.className = 'act ' + armed.btn.__cls
      armed.btn.textContent = armed.btn.__label
    }
    if (!card.busy && !card.done) {
      card.hint.className = 'hint'
      card.hint.textContent = ''
    }
  }

  function arm(card, btn, spec){
    if (!card || card.busy || card.done) return
    if (card.armed && card.armed.btn === btn) {
      // 第二步：这才是真的发请求
      fire(card, btn, card.armed.spec)
      return
    }
    disarm(card)
    card.armed = { btn: btn, spec: spec }
    btn.className = 'act armed ' + spec.cls
    btn.textContent = spec.confirmLabel
    card.hint.className = 'hint show pending'
    card.hint.textContent = spec.consequence +
      ' 再点一下这个按钮就执行；3 秒内不再点就自动退回，什么都不改。'
    card.timer = setTimeout(function(){ disarm(card) }, CONFIRM_TTL)
    // Node 里（verify-pages 的 DOM stub）这个定时器会让进程多等 3 秒；
    // 浏览器里 setTimeout 返回数字、没有 unref，所以这段只在 Node 下生效。
    if (card.timer && typeof card.timer.unref === 'function') card.timer.unref()
  }

  function fire(card, btn, spec){
    clearArm(card)
    card.busy = true
    btn.className = 'act working ' + spec.cls
    btn.textContent = '提交中…'
    card.hint.className = 'hint show pending'
    card.hint.textContent = '正在执行：' + spec.short + '…'
    var payload = { edgeId: card.edgeId, action: spec.action }
    if (spec.kind) payload.kind = spec.kind
    fetch(ACTION_URL, {
      method: 'POST',
      credentials: 'same-origin',
      // 后端要 X-Brain-Action 头才认这是同源页面发来的写请求（挡脚本/跨站直接打接口）
      headers: { 'Content-Type': 'application/json', 'X-Brain-Action': '1' },
      body: JSON.stringify(payload)
    }).then(function(r){
      return r.json().catch(function(parseErr){
        // 后端回了非 JSON（4xx/5xx 的 HTML 错误页、或路由还没上）。
        // 这时**不能**报成「连不上服务」——服务在跑，是接口不对，编个网络故障就是骗人。
        // 注意：verify-pages 的 mock 响应没有 status 字段，所以没有 status 时按原样抛出。
        if (typeof r.status === 'number') {
          return { ok: false, code: 'HTTP_' + r.status, message: '接口返回了非 JSON（HTTP ' + r.status + '）' }
        }
        throw parseErr
      })
    }).then(function(d){
      card.busy = false
      if (d && d.ok === true) okDone(card, spec, d)
      else badDone(card, spec, d || {})
    }).catch(function(err){
      card.busy = false
      badDone(card, spec, { code: 'NETWORK', message: (err && err.message) || String(err) })
    })
  }

  function okDone(card, spec, d){
    card.done = true
    card.card.className = 'card done'
    card.badge.className = 'badge done'
    card.badge.textContent = '已核验'
    resetButtons(card)
    for (var i = 0; i < card.buttons.length; i++) {
      card.buttons[i].className = 'act disabled ' + card.buttons[i].__cls
      card.buttons[i].disabled = true
    }
    var what
    if (spec.action === 'keep-left' || spec.action === 'keep-right') {
      var keptIsLeft = spec.action === 'keep-left'
      var keptId = d.keptId || '（后端未回 id）'
      var goneId = d.supersededId || '（后端未回 id）'
      what = '已保留' + (keptIsLeft ? '左' : '右') + '侧 ' + keptId +
        '；' + (keptIsLeft ? '右' : '左') + '侧 ' + goneId + ' 已封口（valid_until 落值、正文未删、asOf 仍可回看）。'
    } else {
      what = '两条记忆都没动，这条边已从「矛盾」改标成「' + relLabel(spec.kind) + '」' +
        (d.newEdgeId ? '（新边 ' + d.newEdgeId + '）' : '') + '。'
    }
    var removed = d.edgeRemoved === true
      ? '矛盾边已删除。'
      : (d.edgeRemoved === false ? '注意：后端报告矛盾边未删除，别当成已清干净。' : '')
    // rollbackHint 由后端给（它知道这次写了哪些行）。没给就如实说没给——绝不自己编一段看起来像的 SQL。
    var rb = d.rollbackHint || '（后端没返回撤销方式；别凭记忆手写 SQL，先在 data/backups 里找回滚点）'
    card.hint.className = 'hint show ok'
    card.hint.textContent = '已核验 · ' + what + removed + '\\n撤销方式：' + rb
    doneCount += 1
    txt('s-done', String(doneCount))
    refreshStats()
  }

  function badDone(card, spec, d){
    var code = d && d.code ? String(d.code) : 'UNKNOWN'
    var human = humanOf(code, d && d.message)
    var extra = ''
    // 后端原话带出来，但和上面的解释重复就不啰嗦
    if (d && d.message && human.indexOf(String(d.message)) < 0) extra = ' 后端原话：' + d.message
    card.hint.className = 'hint show bad'
    card.hint.textContent = '没做成（' + code + '）：' + human + extra
    resetButtons(card)
    // 失败后卡片仍然可用：按钮回到未确认态，可以再点一次（库忙、网络抖都能原地重试）。
    if (code === 'ALREADY_RESOLVED' || code === 'EDGE_NOT_FOUND') {
      card.hint.textContent += ' 这张卡的正文仍可读，但这条边已经不待核验了。'
    }
  }

  function refreshStats(){
    fetch(LIST_URL, { credentials: 'same-origin' })
      .then(function(r){ return r.json() })
      .then(function(d){
        if (!d || !d.ok) return
        // 只刷数字，不重画卡片：刚核验完的卡还要留着显示「做了什么 + 撤销方式」。
        applyStats(d)
      })
      .catch(function(){ /* 统计刷不动不影响卡片状态，下次操作还会再刷 */ })
  }

  function applyStats(d){
    var items = (d && d.items) || []
    var stats = d && d.stats ? d.stats : null
    var pending = stats && stats.byKind && typeof stats.byKind.contradicts === 'number'
      ? stats.byKind.contradicts
      : items.length
    txt('s-total', String(pending))
    txt('s-all', stats ? String(stats.total) : '–')
    txt('s-sup', stats && stats.byKind ? String(stats.byKind.supersedes || 0) : '–')
  }

  function side(m, label, cls, card, actKey){
    var box = el('div', 'side' + (cls ? ' ' + cls : ''))
    box.appendChild(el('div', 'side-tag', label))
    if (!m || m.missing){
      box.appendChild(el('p', 'text', '（这条记忆已不存在或已删除）'))
      return box
    }
    var text = el('p', 'text clamped', m.content || m.summary || '（无正文）')
    box.appendChild(text)
    var long = (m.content || '').length > 220
    if (long){
      var moreBtn = el('button', 'more', '展开全文')
      var open = false
      moreBtn.addEventListener('click', function(){
        open = !open
        text.className = 'text' + (open ? '' : ' clamped')
        moreBtn.textContent = open ? '收起' : '展开全文'
      })
      box.appendChild(moreBtn)
    }
    var chips = el('div', 'chips')
    if (m.type) chips.appendChild(el('span', 'chip', m.type))
    if (m.layer) chips.appendChild(el('span', 'chip', m.layer))
    if (m.importance != null) chips.appendChild(el('span', 'chip', '重要度 ' + m.importance))
    if (m.originSystem) chips.appendChild(el('span', 'chip', '来源 ' + m.originSystem))
    var t = m.validFrom || m.validUntil
    if (t) chips.appendChild(el('span', 'chip time', fmt(m.validFrom) + ' → ' + fmt(m.validUntil)))
    // 这里必须用变量承接，不许写成行首的 (m.entities || []).forEach(...)：
    // 上一行以 ) 结尾、下一行以 ( 开头时 JavaScript **不会**自动插入分号，
    // 整段会被解析成 chips.appendChild(...)(...) 的连续调用，运行时报
    // 「chips.appendChild(...) is not a function」。语法检查完全查不出来，
    // 只有真的在浏览器里跑一次才会现形。
    // 另外：本文件外侧是模板字符串，注释里连一个反引号都不能出现——
    // 那会把整个模板截断（HANDOVER 3.7 第 31 条），我写这段注释时就踩过一次。
    var ents = m.entities || []
    for (var i = 0; i < ents.length; i++) {
      chips.appendChild(el('span', 'chip ent', ents[i]))
    }
    box.appendChild(chips)
    var mid = el('div', 'mid')
    var code = el('code', null, m.memoryId)
    code.title = '点击复制'
    code.addEventListener('click', function(){
      try {
        navigator.clipboard.writeText(m.memoryId)
        code.textContent = '已复制 ' + m.memoryId
        setTimeout(function(){ code.textContent = m.memoryId }, 1200)
      } catch (e) { /* 剪贴板不可用就静默 */ }
    })
    mid.appendChild(code)
    if (m.version != null) mid.appendChild(el('span', null, 'v' + m.version))
    if (m.createdAt) mid.appendChild(el('span', null, '记于 ' + fmt(m.createdAt)))
    box.appendChild(mid)

    // 动作按钮：只在这一端有真实记忆 id 时挂（缺 id 就没法告诉后端动哪条）
    if (card && card.edgeId && actKey) {
      var spec = keepSpec(actKey)
      var actBtn = el('button', 'act ' + spec.cls, spec.label)
      // __act / __label / __cls 是给复位和自动化验用的锚点：
      // DOM stub 里 setAttribute 是空函数、也没有 dataset，属性直接挂对象最稳。
      actBtn.__act = actKey
      actBtn.__label = spec.label
      actBtn.__cls = spec.cls
      actBtn.addEventListener('click', function(){ arm(card, actBtn, keepSpec(actKey)) })
      var actRow = el('div', 'side-act')
      actRow.appendChild(actBtn)
      box.appendChild(actRow)
      card.buttons.push(actBtn)
    }
    return box
  }

  function syncRel(card){
    if (!card.relBtn) return
    var spec = notConflictSpec(card.sel ? card.sel.value : 'refines')
    card.relBtn.__label = spec.label
    card.relBtn.__cls = spec.cls
    if (card.armed && card.armed.btn === card.relBtn) {
      // 已经在等确认：关系类型改成什么，后果就跟着改成什么，别让人对着旧文案点第二下
      card.armed.spec = spec
      card.relBtn.textContent = spec.confirmLabel
      card.hint.textContent = spec.consequence +
        ' 再点一下这个按钮就执行；3 秒内不再点就自动退回，什么都不改。'
    } else if (!card.busy && !card.done) {
      card.relBtn.textContent = spec.label
    }
  }

  function card(item, i){
    var wrap = el('div', 'card')
    var edgeId = item.edgeId || item.id || null
    var cardState = {
      edgeId: edgeId, busy: false, done: false, armed: null, timer: null,
      buttons: [], card: wrap, hint: null, badge: null, sel: null, relBtn: null
    }
    var head = el('div', 'card-head')
    head.appendChild(el('span', 'idx', '#' + (i + 1)))
    head.appendChild(el('span', 'kind', item.kind))
    var badge = el('span', 'badge', '')
    head.appendChild(badge)
    head.appendChild(el('span', 'meta', (item.sourceSystem ? '来自 ' + item.sourceSystem + ' · ' : '') + fmt(item.createdAt)))
    wrap.appendChild(head)
    cardState.badge = badge

    var pair = el('div', 'pair')
    pair.appendChild(side(item.from, 'A · 这条说', '', cardState, 'keep-left'))
    pair.appendChild(el('div', 'vs', '⇄'))
    pair.appendChild(side(item.to, 'B · 那条说', 'b', cardState, 'keep-right'))
    wrap.appendChild(pair)

    var judge = el('div', 'judge')
    judge.appendChild(el('span', 'judge-label', '两条都对，不是矛盾？关系改成：'))
    var sel = el('select', 'rel-select')
    var optRefines = el('option', null, '细化（refines）')
    optRefines.value = 'refines'
    var optSupports = el('option', null, '佐证（supports）')
    optSupports.value = 'supports'
    sel.appendChild(optRefines)
    sel.appendChild(optSupports)
    sel.value = 'refines'
    sel.addEventListener('change', function(){ syncRel(cardState) })
    judge.appendChild(sel)
    cardState.sel = sel

    if (edgeId) {
      var relSpec = notConflictSpec('refines')
      var relBtn = el('button', 'act ' + relSpec.cls, relSpec.label)
      relBtn.__act = 'not-conflict'
      relBtn.__label = relSpec.label
      relBtn.__cls = relSpec.cls
      relBtn.addEventListener('click', function(){
        arm(cardState, relBtn, notConflictSpec(sel.value))
      })
      judge.appendChild(relBtn)
      cardState.relBtn = relBtn
      cardState.buttons.push(relBtn)
    } else {
      judge.appendChild(el('span', 'judge-label', '（这条边没有 id，无法操作）'))
    }
    wrap.appendChild(judge)

    var hint = el('div', 'hint')
    wrap.appendChild(hint)
    cardState.hint = hint

    if (!edgeId) {
      // 没有 edgeId 时把两个「保留这条」也停掉，别让人点了才发现没法执行
      for (var b = 0; b < cardState.buttons.length; b++) {
        cardState.buttons[b].className = 'act disabled ' + cardState.buttons[b].__cls
        cardState.buttons[b].disabled = true
      }
      hint.className = 'hint show bad'
      hint.textContent = '这条边缺少 edgeId，页面无法对它执行动作（不影响阅读两端原文）。'
    }

    CARDS.push(cardState)
    return wrap
  }

  function findCard(edgeId){
    for (var i = 0; i < CARDS.length; i++) {
      if (CARDS[i].edgeId === edgeId) return CARDS[i]
    }
    return null
  }
  function findButton(card, act){
    for (var i = 0; i < card.buttons.length; i++) {
      if (card.buttons[i].__act === act) return card.buttons[i]
    }
    return null
  }

  // ── 调试/自动化钩子 ────────────────────────────────────────────────
  // verify-pages 的 DOM stub 里 addEventListener 是空函数，派发不了真实 click，
  // 只能靠这个钩子驱动「第一步/第二步」。它不新增任何权限——干的正是页面按钮能做的事。
  try {
    window.__conflicts = {
      version: 'actions-1',
      actionUrl: ACTION_URL,
      cards: function(){
        return CARDS.map(function(c){
          return {
            edgeId: c.edgeId, busy: c.busy, done: c.done,
            armed: c.armed ? c.armed.spec.action : null,
            hint: c.hint ? c.hint.textContent : '',
            badge: c.badge ? c.badge.textContent : ''
          }
        })
      },
      press: function(edgeId, act){
        var c = findCard(edgeId); if (!c) return 'no-card'
        var b = findButton(c, act); if (!b) return 'no-button'
        if (c.armed && c.armed.btn === b) return 'already-armed'
        arm(c, b, act === 'not-conflict' ? notConflictSpec(c.sel ? c.sel.value : 'refines') : keepSpec(act))
        return 'armed'
      },
      confirm: function(edgeId, act){
        var c = findCard(edgeId); if (!c) return 'no-card'
        var b = findButton(c, act); if (!b) return 'no-button'
        if (!(c.armed && c.armed.btn === b)) return 'not-armed'
        fire(c, b, c.armed.spec)
        return 'fired'
      },
      setRel: function(edgeId, kind){
        var c = findCard(edgeId); if (!c || !c.sel) return 'no-card'
        c.sel.value = kind === 'supports' ? 'supports' : 'refines'
        syncRel(c)
        return c.sel.value
      }
    }
  } catch (e) { /* 没有 window（非浏览器环境）：钩子不挂，页面照常工作 */ }

  fetch(LIST_URL, { credentials: 'same-origin' })
    .then(function(r){ return r.json() })
    .then(function(d){
      var list = document.getElementById('list')
      list.textContent = ''
      if (!d || !d.ok){
        txt('s-total', '?')
        list.appendChild(el('div', 'empty', (d && d.message) || '读取失败'))
        return
      }
      var items = d.items || []
      applyStats(d)
      if (items.length === 0){
        var e = el('div', 'empty')
        e.appendChild(el('strong', null, '没有待核验的矛盾'))
        e.appendChild(document.createTextNode('库里所有记忆之间都没有记过 contradicts。'))
        list.appendChild(e)
        return
      }
      items.forEach(function(item, i){ list.appendChild(card(item, i)) })
    })
    .catch(function(err){
      var list = document.getElementById('list')
      list.textContent = ''
      list.appendChild(el('div', 'empty', '读取失败：' + err.message))
    })
})()
</script>
</body>
</html>`
}
