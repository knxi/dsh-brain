// @ts-check
/**
 * 外置大脑 · 实体总览页（/dsh-brain/entities，内嵌在 DSH Web 里，同源无额外端口）
 *
 * ── 为什么需要这页 ──
 *
 * M6 把 117 个实体迁进来了，但除了 `/api/entities` 的 JSON 和首页一个计数，
 * **没有任何地方能看见它们**。这跟「有 6 条矛盾却只能看 JSON」是同一类缺口：
 * 数据进了库，人还看不见，就等于没进来。
 *
 * 这页要让人一眼看出三件事（都是实测发现的问题）：
 *   1. **分布**：tool 41 / concept 28 / other 25 / project 18 / person 5。
 *   2. **孤儿**：13 个实体一条记忆都没挂——Engram 侧挂的 node 当初没被导入，
 *      它们现在只是名字。留着还是清掉要人判断。
 *   3. **错标**：Engram 把 context2 / connector2 / console2 这类标成了 person。
 *      这页把 kind 摊开摆，就是为了让人看见「这个分类不对」。
 *
 * ── 为什么只读 ──
 *
 * 改 kind、合并实体、删孤儿，都需要一套「谁改的、依据、能不能撤回」的留痕，
 * 那是 M7 的活。现在给按钮就等于让人在没有回退的情况下动结构。
 * 所以这页只做「看见 + 定位」：能筛、能搜、能展开看名下记忆、能复制 ID。
 *
 * 视觉沿用项目既定语言：near-black 仪器面板、单一琥珀强调、等宽数字、留白克制
 *（2026-11-01 换版：纸感浅色 → 近黑；骨架与 token 收进 theme.js，这页只留分组与展开行）。
 */

// 导航统一收在 nav.js（顺序与高亮只在那定义一次）。页面只说自己是谁。
// 导航样式已并入 theme.js 的注入区，不再从这里引 NAV_CSS。
import { renderNav } from './nav.js'

/** @param {{ scopeId: string }} opts */
export function renderEntitiesPage({ scopeId }) {
  const escapedScope = String(scopeId).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 实体</title>
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
/* ── 这一页自己的部分：统计条 / 筛选行 / 实体分组 / 展开的记忆 ──
   骨架（底、标题区、路径行、页脚、导航、滚动条、焦点环）全在标记区里，这里不重复。 */

.stats{display:flex;padding:0;background:linear-gradient(180deg,var(--card),var(--card-2));
  border:1px solid var(--line);border-radius:var(--r);margin-bottom:18px;flex-wrap:wrap;overflow:hidden}
.stat{display:flex;flex-direction:column;gap:2px;padding:12px 20px;flex:1;min-width:118px;
  border-right:1px solid var(--line-soft)}
.stat:last-child{border-right:none}
.stat-k{font-size:10px;color:var(--muted);letter-spacing:.09em}
.stat-v{font-size:17px;font-weight:560;font-family:var(--mono);font-variant-numeric:tabular-nums;
  letter-spacing:-.01em;color:var(--ink);line-height:1.35}
.stat-v.warn{color:var(--warn)}

.bar{display:flex;gap:8px;align-items:center;margin-bottom:18px;flex-wrap:wrap}
input[type=search]{flex:1;min-width:220px;height:36px;padding:0 12px;border:1px solid var(--line);
  border-radius:var(--r-sm);background:var(--card-2);font:inherit;font-size:13px;color:var(--ink);
  outline:none;transition:border-color .14s var(--ease)}
input[type=search]::placeholder{color:var(--faint)}
input[type=search]:focus{border-color:var(--accent-line)}

/* 类型筛选：一行小 tab，不是一排按钮。常态透明，选中的那枚才浮出来——
   五个类型各套一个实心盒子，筛选行会比下面的实体列表还抢眼。 */
.kinds{display:flex;gap:2px;flex-wrap:wrap}
.kbtn{font-size:12px;padding:6px 11px;border:1px solid transparent;border-radius:var(--r-sm);
  background:transparent;color:var(--muted);cursor:pointer;font-family:inherit;
  transition:color .14s var(--ease),background .14s var(--ease),border-color .14s var(--ease);
  white-space:nowrap;line-height:1.5}
.kbtn:hover{border-color:var(--line);background:var(--raise);color:var(--ink)}
.kbtn.on{border-color:var(--accent-line);background:var(--accent-soft);color:var(--accent);
  font-weight:560}
.only{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);
  cursor:pointer;user-select:none;padding:0 2px}
.only input{cursor:pointer;accent-color:var(--accent)}

/* 分组 = 一块面板：表头是「工具 tool · 41」，下面是可展开的行。
   行与行之间只用 --line-soft —— 117 个实体如果一张行一张小卡片，铺出来是一面
   「卡片墙」，会把「同一类里的东西」读成「117 件互相无关的事」。
   一整块面板 + 细线分行，读法是「一个类目下的连续条目」，跟记忆页同一个语言。 */
.group{margin-bottom:22px;border:1px solid var(--line);border-radius:var(--r);
  overflow:hidden;background:var(--card)}
.group-head{display:flex;align-items:baseline;gap:9px;padding:10px 15px;
  border-bottom:1px solid var(--line);background:var(--card-2)}
.group-name{font-size:11px;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.group-count{font-family:var(--mono);font-size:11px;color:var(--faint);
  font-variant-numeric:tabular-nums}

/* 实体行：hover 只提亮一行；展开时把正文区压到 --card-2 并加一道上沿细线，
   当前项靠「这里多出来一块」指认，不靠整行换色。 */
.ent{background:transparent;border-bottom:1px solid var(--line-soft);
  transition:background .14s var(--ease)}
.ent:last-child{border-bottom:none}
.ent:hover{background:var(--raise)}
.ent.open{background:var(--card)}
.ent-row{display:flex;align-items:baseline;gap:9px;padding:10px 15px;cursor:pointer;flex-wrap:wrap}
.ent-name{font-size:13.5px;font-weight:520;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;
  white-space:nowrap;color:var(--ink-2)}
.ent:hover .ent-name,.ent.open .ent-name{color:var(--ink)}
.chip{font-size:10.5px;padding:1.5px 7px;border-radius:4px;background:var(--raise);color:var(--muted);
  font-family:var(--mono);white-space:nowrap;line-height:1.6}
.chip.alias{background:var(--accent-soft);color:var(--accent)}
.chip.n{cursor:default;font-variant-numeric:tabular-nums}
.chip.n.zero{background:var(--bad-soft);color:var(--bad)}
.ent-body{border-top:1px solid var(--line);padding:10px 15px;background:var(--card-2);display:none}
.ent.open .ent-body{display:block}
.mem{padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:12.5px;color:var(--ink-2)}
.mem:last-child{border-bottom:none}
.mem-id{font-family:var(--mono);font-size:10.5px;color:var(--faint);cursor:pointer;margin-left:8px;
  transition:color .14s var(--ease)}
.mem-id:hover{color:var(--accent)}
.note{font-size:12px;color:var(--muted);padding:11px 15px;line-height:1.8}

.empty{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
  padding:44px 20px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>实体</h1>
    <span class="sub">记忆挂在谁名下</span>
    ${renderNav({ active: 'entities' })}
  </div>
  <div class="path">scope: ${escapedScope} · /dsh-brain/api/entities</div>

  <div class="stats" id="stats">
    <div class="stat"><span class="stat-k">实体</span><span class="stat-v" id="s-total">–</span></div>
    <div class="stat"><span class="stat-k">有记忆的</span><span class="stat-v" id="s-linked">–</span></div>
    <div class="stat"><span class="stat-k">孤儿</span><span class="stat-v" id="s-orphan">–</span></div>
    <div class="stat"><span class="stat-k">类型</span><span class="stat-v" id="s-kinds">–</span></div>
  </div>

  <div class="bar">
    <input type="search" id="q" placeholder="搜实体名或别名" autocomplete="off" spellcheck="false">
    <div class="kinds" id="kinds"></div>
    <label class="only"><input type="checkbox" id="only-orphan"> 只看孤儿</label>
  </div>

  <div id="groups"><div class="empty">载入中…</div></div>

  <p class="note">
    孤儿 = 一条记忆都没挂上的实体。Engram 那边挂着 node，但那些 node 当初按内容长度/状态被过滤掉了，
    所以没有对应的记忆可挂——**留着还是清掉得人判断**，这里只负责让它们浮出来。<br>
    类型标错也是同理：Engram 把 context2 / connector2 / console2 这类标成了 person，迁的时候只搬不改。
  </p>

  <div class="foot">
    <span>只读视图。改类型 / 合并 / 清理孤儿需要留痕机制，属于 M7。</span>
    <span style="flex:1"></span>
    <a href="/dsh-brain">回列表</a>
  </div>
</div>
<script>
(function(){
  var KIND_LABEL = { person: '人', project: '项目', tool: '工具', concept: '概念', other: '其他' }
  var all = []
  var stats = null
  var activeKind = ''
  var onlyOrphan = false
  var keyword = ''

  function el(tag, cls, text){ var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
  function txt(id, v){ var n = document.getElementById(id); if (n) n.textContent = v }
  function esc(v){ return v == null ? '' : String(v) }

  function renderStats(){
    if (!stats) return
    txt('s-total', stats.total)
    txt('s-linked', stats.linked)
    txt('s-orphan', stats.orphan)
    txt('s-kinds', Object.keys(stats.byKind || {}).length)
    var o = document.getElementById('s-orphan')
    if (o) o.className = 'stat-v' + (stats.orphan > 0 ? ' warn' : '')
  }

  function renderKinds(){
    var box = document.getElementById('kinds')
    box.textContent = ''
    var allBtn = el('button', 'kbtn' + (activeKind === '' ? ' on' : ''), '全部')
    allBtn.addEventListener('click', function(){ activeKind = ''; renderKinds(); renderGroups() })
    box.appendChild(allBtn)
    var kinds = stats && stats.byKind ? stats.byKind : {}
    var keys = Object.keys(kinds).sort(function(a, b){ return kinds[b] - kinds[a] })
    keys.forEach(function(k){
      var b = el('button', 'kbtn' + (activeKind === k ? ' on' : ''), (KIND_LABEL[k] || k) + ' ' + kinds[k])
      b.addEventListener('click', function(){ activeKind = (activeKind === k ? '' : k); renderKinds(); renderGroups() })
      box.appendChild(b)
    })
  }

  function visible(){
    return all.filter(function(e){
      if (activeKind && e.kind !== activeKind) return false
      if (onlyOrphan && e.memoryCount > 0) return false
      if (keyword){
        var hay = (e.name + ' ' + (e.aliases || []).join(' ')).toLowerCase()
        if (hay.indexOf(keyword.toLowerCase()) < 0) return false
      }
      return true
    })
  }

  function memRow(m){
    var row = el('div', 'mem')
    row.appendChild(el('span', null, esc(m.summary || '（无摘要）')))
    var id = el('span', 'mem-id', esc(m.memoryId))
    id.title = '点击复制'
    id.addEventListener('click', function(){
      try { navigator.clipboard.writeText(m.memoryId); id.textContent = '已复制'; setTimeout(function(){ id.textContent = m.memoryId }, 1000) } catch (e) {}
    })
    row.appendChild(id)
    return row
  }

  function entCard(e){
    var card = el('div', 'ent')
    var row = el('div', 'ent-row')
    row.appendChild(el('span', 'ent-name', esc(e.name)))
    ;(e.aliases || []).forEach(function(a){ row.appendChild(el('span', 'chip alias', esc(a))) })
    row.appendChild(el('span', 'chip n' + (e.memoryCount > 0 ? '' : ' zero'), e.memoryCount + ' 条'))
    if (e.sourceSystem) row.appendChild(el('span', 'chip', esc(e.sourceSystem)))
    card.appendChild(row)

    var body = el('div', 'ent-body')
    card.appendChild(body)
    var loaded = false

    row.addEventListener('click', function(){
      var open = card.className.indexOf('open') >= 0
      if (open){ card.className = 'ent'; return }
      card.className = 'ent open'
      if (loaded) return
      loaded = true
      body.appendChild(el('div', 'note', '载入中…'))
      fetch('/dsh-brain/api/entities/memories?id=' + encodeURIComponent(e.id), { credentials: 'same-origin' })
        .then(function(r){ return r.json() })
        .then(function(d){
          body.textContent = ''
          if (!d || !d.ok){ body.appendChild(el('div', 'note', (d && d.message) || '读取失败')); return }
          var items = d.items || []
          if (items.length === 0){ body.appendChild(el('div', 'note', '这个实体名下没有记忆（孤儿）。')); return }
          items.forEach(function(m){ body.appendChild(memRow(m)) })
        })
        .catch(function(err){ body.textContent = ''; body.appendChild(el('div', 'note', '读取失败：' + err.message)) })
    })
    return card
  }

  function renderGroups(){
    var box = document.getElementById('groups')
    box.textContent = ''
    var list = visible()
    if (list.length === 0){
      box.appendChild(el('div', 'empty', '没有符合条件的实体。'))
      return
    }
    var byKind = {}
    list.forEach(function(e){
      if (!byKind[e.kind]) byKind[e.kind] = []
      byKind[e.kind].push(e)
    })
    var order = ['tool', 'concept', 'project', 'person', 'other']
    var keys = Object.keys(byKind).sort(function(a, b){
      var ia = order.indexOf(a); var ib = order.indexOf(b)
      if (ia < 0) ia = 99
      if (ib < 0) ib = 99
      if (ia !== ib) return ia - ib
      return byKind[b].length - byKind[a].length
    })
    keys.forEach(function(k){
      var g = el('div', 'group')
      var head = el('div', 'group-head')
      head.appendChild(el('span', 'group-name', KIND_LABEL[k] || k))
      head.appendChild(el('span', 'group-count', k + ' · ' + byKind[k].length))
      g.appendChild(head)
      byKind[k]
        .slice()
        .sort(function(a, b){ return b.memoryCount - a.memoryCount || a.name.localeCompare(b.name) })
        .forEach(function(e){ g.appendChild(entCard(e)) })
      box.appendChild(g)
    })
  }

  fetch('/dsh-brain/api/entities?limit=500', { credentials: 'same-origin' })
    .then(function(r){ return r.json() })
    .then(function(d){
      var box = document.getElementById('groups')
      box.textContent = ''
      if (!d || !d.ok){ box.appendChild(el('div', 'empty', (d && d.message) || '读取失败')); return }
      all = d.items || []
      stats = d.stats || null
      renderStats()
      renderKinds()
      renderGroups()
    })
    .catch(function(err){
      var box = document.getElementById('groups')
      box.textContent = ''
      box.appendChild(el('div', 'empty', '读取失败：' + err.message))
    })

  var qEl = document.getElementById('q')
  qEl.addEventListener('input', function(){ keyword = qEl.value.trim(); renderGroups() })
  document.getElementById('only-orphan').addEventListener('change', function(ev){
    onlyOrphan = !!ev.target.checked
    renderGroups()
  })
})()
</script>
</body>
</html>`
}
