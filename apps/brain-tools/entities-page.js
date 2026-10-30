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
 * 视觉沿用项目既定语言：纸感浅色、单一赭石强调、等宽数字、留白克制。
 */

// 导航统一收在 nav.js（顺序与高亮只在那定义一次）。页面只说自己是谁。
import { renderNav, NAV_CSS } from './nav.js'

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
.wrap{max-width:1040px;margin:0 auto;padding:38px 30px 80px}
.head{display:flex;align-items:baseline;gap:14px;margin-bottom:6px}
h1{font-size:21px;font-weight:650;letter-spacing:.01em;margin:0}
.sub{color:var(--muted);font-size:12.5px}
.nav{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap}
.navlink{font-size:13px;padding:8px 15px;border:1px solid var(--line);border-radius:10px;
  background:var(--card);color:var(--ink);text-decoration:none;transition:all .18s;white-space:nowrap}
.navlink:hover{border-color:var(--ochre);color:var(--ochre)}
.path{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-bottom:22px}

.stats{display:flex;gap:26px;padding:16px 20px;background:var(--card);border:1px solid var(--line);
  border-radius:12px;margin-bottom:18px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column;gap:2px}
.stat-k{font-size:10.5px;color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
.stat-v{font-size:19px;font-weight:620;font-family:var(--mono);font-variant-numeric:tabular-nums}
.stat-v.warn{color:var(--warn)}

.bar{display:flex;gap:10px;align-items:center;margin-bottom:20px;flex-wrap:wrap}
input[type=search]{flex:1;min-width:220px;padding:10px 13px;border:1px solid var(--line);
  border-radius:10px;background:var(--card);font-size:13.5px;color:var(--ink);outline:none;transition:border-color .18s}
input[type=search]:focus{border-color:var(--ochre)}
.kinds{display:flex;gap:6px;flex-wrap:wrap}
.kbtn{font-size:12px;padding:7px 12px;border:1px solid var(--line);border-radius:9px;
  background:var(--card);color:var(--ink);cursor:pointer;transition:all .18s}
.kbtn:hover{border-color:var(--ochre);color:var(--ochre)}
.kbtn.on{background:var(--ochre);border-color:var(--ochre);color:#fff}
.only{display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--muted);cursor:pointer;user-select:none}
.only input{cursor:pointer}

.group{margin-bottom:22px}
.group-head{display:flex;align-items:baseline;gap:9px;margin-bottom:9px}
.group-name{font-size:12.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}
.group-count{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.ent{background:var(--card);border:1px solid var(--line);border-radius:10px;
  margin-bottom:7px;overflow:hidden;transition:border-color .15s}
.ent:hover{border-color:#d9cfc0}
.ent.open{border-color:var(--ochre)}
.ent-row{display:flex;align-items:baseline;gap:10px;padding:11px 15px;cursor:pointer;flex-wrap:wrap}
.ent-name{font-size:13.5px;font-weight:540;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip{font-size:10.5px;padding:2px 7px;border-radius:5px;background:#f1ece4;color:var(--muted);white-space:nowrap}
.chip.alias{background:var(--ochre-soft);color:var(--ochre)}
.chip.n{cursor:default}
.chip.n.zero{background:#f6e6e4;color:var(--bad)}
.ent-body{border-top:1px solid var(--line);padding:12px 15px;background:#fdfbf8;display:none}
.ent.open .ent-body{display:block}
.mem{padding:6px 0;border-bottom:1px dotted var(--line);font-size:12.5px}
.mem:last-child{border-bottom:none}
.mem-id{font-family:var(--mono);font-size:10.5px;color:var(--muted);cursor:pointer;margin-left:8px}
.mem-id:hover{color:var(--ochre)}
.note{font-size:12px;color:var(--muted);padding:11px 15px}

.empty{background:var(--card);border:1px solid var(--line);border-radius:12px;
  padding:44px 20px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}
.foot{margin-top:34px;padding-top:20px;border-top:1px solid var(--line);
  color:var(--muted);font-size:12px;display:flex;gap:18px;flex-wrap:wrap;align-items:center}
.foot a{color:var(--ochre);text-decoration:none;border-bottom:1px dotted currentColor}
${NAV_CSS}
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
