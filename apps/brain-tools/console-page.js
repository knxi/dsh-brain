// @ts-check
/**
 * 外置大脑 · 控制台页面（内嵌在 DSH Web 里，同源，无额外端口）
 *
 * 为什么内嵌而不跳独立 console：
 *   独立的治理面板（apps/server，端口 7420）要额外起进程、额外鉴权、跨端口。
 *   主人要的是「在 DSH 里点一下能看见」——那就在 DSH 自己的 webServer 上开个路由，
 *   同源、同端口、零额外进程。完整的删除/备份治理面板仍然是独立 console，
 *   这里给一个链接过去。
 *
 * 视觉沿用项目既定语言：near-black 仪器面板、单一琥珀强调、等宽数字、留白克制
 * （2026-11-01 换版：纸感浅色 → 近黑；骨架与 token 收进 theme.js，这页只留列表与分页）。
 */

// 导航统一收在 nav.js（顺序与高亮只在那定义一次）。页面只说自己是谁。
import { renderNav } from './nav.js'
// 设计系统收在 theme.js，由 tools/apply-theme.mjs 注入到下面的 THEME 标记区。
// 不在这里 import：页面是热重载的（按 mtime 加 ?v=），但页面内部的静态 import
// 解析出的 URL 不带 query，会把 theme.js 缓存成旧实例——改主题就不生效了。

/** @param {{ dbPath: string }} opts */
export function renderConsolePage({ dbPath }) {
  const escapedDbPath = String(dbPath).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑</title>
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
/* ── 这一页自己的部分：统计条 / 检索行 / 记忆列表 / 分页 ──
   骨架（底、标题区、路径行、页脚、导航、滚动条、焦点环）全在标记区里，这里不重复。 */

.bar{display:flex;gap:8px;align-items:center;margin:22px 0 16px;flex-wrap:wrap}
input[type=search]{flex:1;min-width:240px;height:38px;padding:0 13px;border:1px solid var(--line);
  border-radius:var(--r-sm);background:var(--card-2);font:inherit;font-size:13.5px;color:var(--ink);
  outline:none;transition:border-color .14s var(--ease),box-shadow .14s var(--ease)}
input[type=search]::placeholder{color:var(--faint)}
input[type=search]:focus{border-color:var(--accent-line);box-shadow:0 0 0 3px rgba(227,166,98,.07)}
button{height:38px;padding:0 16px;border:1px solid var(--line);border-radius:var(--r-sm);
  background:var(--card);color:var(--ink-2);font:inherit;font-size:13px;cursor:pointer;
  transition:border-color .14s var(--ease),color .14s var(--ease),background .14s var(--ease)}
button:hover{border-color:var(--line-2);background:var(--raise);color:var(--ink)}
button:active{transform:translateY(.5px)}
button.primary{background:var(--accent);border-color:var(--accent);color:#14100a;font-weight:600}
button.primary:hover{background:#eeb274;border-color:#eeb274;color:#14100a}

/* 统计条：一条通栏面板，靠竖 hairline 分格。
   四个数字并排是为了横向比较，套四个盒子反而把比较打断。 */
.stats{display:flex;padding:0;background:linear-gradient(180deg,var(--card),var(--card-2));
  border:1px solid var(--line);border-radius:var(--r);margin-bottom:18px;flex-wrap:wrap;overflow:hidden}
.stat{display:flex;flex-direction:column;gap:2px;padding:12px 20px;flex:1;min-width:118px;
  border-right:1px solid var(--line-soft)}
.stat:last-child{border-right:none}
.stat-k{font-size:10px;color:var(--muted);letter-spacing:.09em}
.stat-v{font-size:17px;font-weight:560;font-family:var(--mono);font-variant-numeric:tabular-nums;
  letter-spacing:-.01em;color:var(--ink);line-height:1.35}

/* 记忆列表：一整块面板，行间用比结构线更淡的 --line-soft。
   行间上结构线会变成一排硬横杠；用 --line-soft 才有「一行一行」而不是「一格格」。
   hover 时左侧亮起 2px 强调线——比整行变色指认得更精确。 */
.list{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:var(--r);
  overflow:hidden;background:var(--card)}
.row{padding:11px 18px 11px 20px;border-bottom:1px solid var(--line-soft);position:relative;
  transition:background .14s var(--ease)}
.row:last-child{border-bottom:none}
.row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;background:transparent;
  transition:background .14s var(--ease)}
.row:hover{background:var(--raise)}
.row:hover::before{background:var(--accent)}
.row-top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.summary{font-size:13px;font-weight:400;flex:1;min-width:0;color:var(--ink-2);line-height:1.6}
.row:hover .summary{color:var(--ink)}
.id{font-family:var(--mono);font-size:10px;color:var(--faint);letter-spacing:0;flex:none}

/* 标签：默认是一行**透明注脚**，只有状态类才给软底。
   一行记忆上同时挂着层/类型/来源/有效期四五种标签，全给底色就成了一条彩带，
   一屏下来眼睛不知道往哪看。默认透明之后，整页只剩「来源缺失」那一点红是焦点——
   要人停一下的信息才该显眼，其余是背景资料。 */
.tags{display:flex;gap:3px 11px;flex-wrap:wrap;margin-top:5px;align-items:center}
.tag{font-size:10.5px;padding:0;color:var(--faint);font-family:var(--mono);
  letter-spacing:.01em;white-space:nowrap;line-height:1.7}
.tag.ok{color:var(--ok)}
.tag.bad{padding:0 5px;border-radius:3px;background:var(--bad-soft);color:#c9766a}
.tag.plain{color:var(--faint)}

.empty{padding:52px 20px;text-align:center;color:var(--muted);font-size:13px;line-height:1.8}

/* 诊断条：左边一道 2px 状态线，比整块换底色克制 */
.diag{margin:0 0 14px;padding:11px 16px;border-radius:var(--r-sm);font-size:13px;
  background:var(--card);border:1px solid var(--line);border-left:2px solid var(--line-2);line-height:1.6}
.diag.warn{border-left-color:var(--warn);background:var(--warn-soft);color:#e6bd87}
.diag.bad{border-left-color:var(--bad);background:var(--bad-soft);color:#eda79c}

/* 分页条：压小一档，让它待在列表底下不抢戏 */
.pager{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
.pager button{height:32px;padding:0 13px;font-size:12.5px;font-family:var(--mono)}
.pager button:disabled{opacity:.36;cursor:not-allowed}
.pager button:disabled:hover{border-color:var(--line);background:var(--card);color:var(--ink-2)}
.pg-info{font-family:var(--mono);font-size:11.5px;color:var(--muted);
  font-variant-numeric:tabular-nums;letter-spacing:-.01em;min-width:186px;text-align:center}
.pg-size{font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:7px;margin-left:auto}
.pg-size select{height:32px;padding:0 8px;border:1px solid var(--line);border-radius:var(--r-sm);
  background:var(--card);color:var(--ink-2);font-size:12px;font-family:var(--mono);outline:none}
.pg-size select:focus{border-color:var(--accent-line)}
/* 翻页时把上一页的行压暗而不是清空——整块闪一下看着像页面崩了 */
.list.loading{opacity:.55}
.empty button{margin-top:14px}
.spin{display:inline-block;width:12px;height:12px;border:1.5px solid var(--line-2);
  border-top-color:var(--accent);border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px}
@keyframes s{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>外置大脑</h1>
    <span class="sub">DSH · explicit 模式，只挂显式工具</span>
    ${renderNav({ active: 'memory' })}
  </div>
  <div class="path">${escapedDbPath}</div>

  <div class="stats" id="stats">
    <div class="stat"><span class="stat-k">记忆</span><span class="stat-v" id="s-mem">–</span></div>
    <div class="stat"><span class="stat-k">实体</span><span class="stat-v" id="s-ent">–</span></div>
    <div class="stat"><span class="stat-k">检索</span><span class="stat-v" id="s-usage">–</span></div>
    <div class="stat"><span class="stat-k">索引</span><span class="stat-v" id="s-idx">–</span></div>
  </div>

  <div id="alert"></div>

  <div class="bar">
    <input type="search" id="q" placeholder="搜记忆：中文、尺寸、图号、代码标识符都行"
      autocomplete="off" spellcheck="false">
    <button class="primary" id="go">检索</button>
    <button id="all">全部</button>
  </div>

  <div id="diag"></div>
  <div class="list" id="list"><div class="empty">正在载入…</div></div>

  <div class="pager" id="pager">
    <button id="prev" disabled>← 上一页</button>
    <span class="pg-info" id="pg-info">–</span>
    <button id="next" disabled>下一页 →</button>
    <label class="pg-size">每页
      <select id="pg-size">
        <option value="20">20</option>
        <option value="50" selected>50</option>
        <option value="100">100</option>
      </select>
    </label>
  </div>

  <div class="foot">
    <span>删除 / 备份 / 恢复都在治理面板里（同源，点开就能用）：</span>
    <a href="/dsh-brain/governance">打开治理面板 →</a>
    <span style="flex:1"></span>
    <span id="cost"></span>
  </div>
</div>
<script>
(function(){
  var list = document.getElementById('list')
  var diag = document.getElementById('diag')
  var q = document.getElementById('q')
  var sMem = document.getElementById('s-mem')
  var sIdx = document.getElementById('s-idx')
  var sUsage = document.getElementById('s-usage')
  var sEnt = document.getElementById('s-ent')
  var alertBox = document.getElementById('alert')
  var cost = document.getElementById('cost')
  // 分页条上的四个节点。DOM stub 里 getElementById 拿不到就自动造一个空节点，
  // 所以下面全部按「可能不存在」写（判空），别让一次缺 id 把整页脚本炸掉。
  var pager = document.getElementById('pager')
  var prevBtn = document.getElementById('prev')
  var nextBtn = document.getElementById('next')
  var pgInfo = document.getElementById('pg-info')
  var pgSize = document.getElementById('pg-size')

  function el(tag, cls, text){
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  function esc(v){ return v == null ? '' : String(v) }

  function renderStats(s){
    if (!s || !s.ok) return
    sMem.textContent = s.memories
    // 合并过的历史版本单列：数字只报可检索的 active 条数，封口条数写在标题里。
    // 直接把 superseded 算进「记忆」会让数字虚高，而且它检索不到——首页不该虚报。
    if (sMem.parentNode && typeof s.superseded === 'number' && s.superseded > 0){
      var k = sMem.parentNode.querySelector('.stat-k')
      if (k) k.textContent = '记忆（封口 ' + s.superseded + '）'
      sMem.title = '另有 ' + s.superseded + ' 条已合并封口（superseded）：保留历史版本，但检索不再返回'
    }
    sIdx.textContent = s.indexReady ? '正常' : '待建'
    if (sEnt){
      sEnt.textContent = s.entities && typeof s.entities.total === 'number' ? s.entities.total : '–'
    }
    // 矛盾是并列保留的，不替人选边 —— 所以要在首页明说「有 N 条等你核验」，
    // 而不是安静地留在库里当没发生。红条要能点进去并排看原文。
    if (alertBox){
      alertBox.textContent = ''
      if (typeof s.conflicts === 'number' && s.conflicts > 0){
        var bar = el('div', 'diag bad')
        bar.appendChild(document.createTextNode(
          '有 ' + s.conflicts + ' 条记忆互相矛盾，正在并列保留（没有替你选边）。'))
        var jump = el('a', null, '并排看原文 →')
        jump.href = '/dsh-brain/conflicts'
        jump.style.marginLeft = '10px'
        jump.style.color = 'inherit'
        jump.style.borderBottom = '1px dotted currentColor'
        jump.style.textDecoration = 'none'
        bar.appendChild(jump)
        alertBox.appendChild(bar)
      }
    }
    if (sUsage){
      if (s.usage && s.usage.total > 0){
        var rate = s.usage.hitRate == null ? '' : ' / ' + Math.round(s.usage.hitRate * 100) + '%'
        sUsage.textContent = s.usage.total + ' 次' + rate
      } else {
        sUsage.textContent = '0 次'
      }
    }
  }

  function renderDiag(d){
    diag.textContent = ''
    if (!d) return
    var box = el('div', 'diag' + (d.status === 'ok' ? '' : (d.status === 'no_related' ? '' : ' warn')))
    box.textContent = d.readable || d.status
    diag.appendChild(box)
  }

  function renderItems(items, isSearch){
    list.textContent = ''
    if (!items || items.length === 0){
      list.appendChild(el('div','empty', isSearch ? '没找到相关记忆。' : '还没有记忆。让我记点东西吧。'))
      return
    }
    items.forEach(function(it){
      var row = el('div','row')
      var top = el('div','row-top')
      top.appendChild(el('span','summary', esc(it.summary) || '(无摘要)'))
      top.appendChild(el('span','id', esc(it.memoryId) + '@v' + esc(it.version)))
      row.appendChild(top)
      var tags = el('div','tags')
      if (it.layer) tags.appendChild(el('span','tag', it.layer))
      if (it.type) tags.appendChild(el('span','tag plain', it.type))
      if (it.evidenceKind) tags.appendChild(el('span','tag plain', it.evidenceKind))
      var sc = typeof it.sourceCount === 'number' ? it.sourceCount : (it.sourceRefs ? it.sourceRefs.length : 0)
      tags.appendChild(el('span','tag' + (sc > 0 ? ' ok' : ' bad'), sc > 0 ? ('来源 ' + sc) : '来源缺失'))
      if (it.validFrom || it.validUntil){
        tags.appendChild(el('span','tag plain',
          '有效期 ' + (it.validFrom || '…') + ' → ' + (it.validUntil || '…')))
      }
      if (it.matchedBy && it.matchedBy.length){
        tags.appendChild(el('span','tag plain', '命中 ' + it.matchedBy.join('/')))
      }
      row.appendChild(tags)
      list.appendChild(row)
    })
  }

  // ── 分页 ──────────────────────────────────────────────────────────
  // 契约（后端 apps/brain-tools/index.js 的 /api/memories）：
  //   { ok, items, total, limit, offset, hasMore, nextOffset }
  //   limit 夹在 1..200，offset >= 0；越界 offset 回**空 items 但 total 真实**。
  //
  // 两条铁律，也是这次分页最容易做错的地方：
  //   ① total 只认服务端给的数字。拿不到（老后端 / 没这字段）就保持 null，
  //      文案退化成「第 N 页 · 本页 X 条」，绝不拿 items.length 冒充总数——
  //      那样翻到第 2 页会让「共 X 条」从 212 变成 50。
  //   ② 「还有没有下一页」听 hasMore 的，不自己用 page < pages 算。
  //      total 与 pageSize 之间一旦有取整/并发偏差，自算的页码会把最后一页点空。
  var state = {
    mode: 'list',   // 'list' = 分页态；'search' = 搜索态（不分页，分页条整条隐藏）
    pageSize: 50,   // 首屏固定 limit=50&offset=0（翻页控件里再改）
    offset: 0,
    total: null,    // number = 服务端总数；null = 未知（不猜）
    hasMore: false,
    shown: 0,       // 当前这一页真实渲染了几行
    loading: false,
    lastError: null,
    seq: 0,         // 请求序号：竞态时只让最后发出的那次落 DOM
    clamped: false  // 越界 offset 只夹一次，防止「空页 → 重拉 → 空页」死循环
  }

  function now(){
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
  }

  // 页码总数：total 未知时返回 null（渲染层据此切文案，不编数字）
  function pageCount(){
    if (typeof state.total === 'number' && state.total >= 0){
      return Math.max(1, Math.ceil(state.total / state.pageSize))
    }
    return null
  }

  // 当前页码（1 基）。offset 永远是 pageSize 的整数倍——每次改页都重算，
  // 所以改每页条数时必须把 offset 归零，否则页码会错位。
  function pageIndex(){
    return Math.floor(state.offset / state.pageSize) + 1
  }

  function renderPager(){
    if (!pager) return
    // 搜索态整条隐藏：搜索结果少、不分页，留着按钮只会点出一堆空页
    pager.style.display = state.mode === 'search' ? 'none' : 'flex'
    var pages = pageCount()
    var page = pageIndex()
    // 首尾页 disabled：不能点了没反应，也不能让人以为还没到头
    if (prevBtn) prevBtn.disabled = state.loading || state.offset <= 0
    if (nextBtn) nextBtn.disabled = state.loading || !state.hasMore
    if (pgSize && pgSize.value !== String(state.pageSize)) pgSize.value = String(state.pageSize)
    var text
    if (state.loading){
      text = '载入中… · 第 ' + page + ' 页' + (pages ? ' / ' + pages : '')
    } else if (state.lastError){
      text = '第 ' + page + ' 页载入失败'
    } else if (pages){
      text = '第 ' + page + ' / ' + pages + ' 页 · 共 ' + state.total + ' 条'
    } else {
      text = '第 ' + page + ' 页 · 本页 ' + state.shown + ' 条'
    }
    if (pgInfo) pgInfo.textContent = text
  }

  // 失败不白屏：列表里给原因 + 一个真的能再点一次的「重试」
  function showListError(message, retry){
    list.textContent = ''
    list.className = 'list'
    var box = el('div', 'empty', message)
    if (retry){
      var again = el('button', 'retry', '重试')
      again.addEventListener('click', function(){ retry() })
      box.appendChild(again)
    }
    list.appendChild(box)
    state.shown = 0
  }

  // 返回 Promise：越界夹取后会重拉一页，把重拉的 Promise 交出去，
  // 调用方 await 到的才是**最终**那一页落地，而不是「空页处理完、真数据在路上」的中间态。
  function settle(mySeq, d, t0){
    if (mySeq !== state.seq) return null            // 迟到的那次响应，丢掉
    state.loading = false
    if (cost) cost.textContent = Math.round(now() - t0) + ' ms'
    if (!d || !d.ok){
      state.lastError = (d && d.message) || '读取失败'
      state.hasMore = false
      showListError(state.lastError, loadList)
      renderPager()
      return null
    }
    var items = Array.isArray(d.items) ? d.items : []
    state.total = typeof d.total === 'number' ? d.total : null
    // hasMore 优先信服务端；没这个字段（老后端）才退化成「本页装满了就还有可能」
    state.hasMore = typeof d.hasMore === 'boolean'
      ? d.hasMore
      : (items.length >= state.pageSize && items.length > 0)
    // ── 越界 offset ──
    // 契约说越界回空 items、total 仍真实。分两种情况：
    //   total 已知 → 夹回最后一页（(pages-1)*pageSize）；
    //   total 未知 → 退回上一页（offset-pageSize）。
    // 夹一次就够（state.clamped），夹完还空就是真的空，照实渲染空态。
    if (items.length === 0 && !state.clamped && state.offset > 0){
      state.clamped = true
      var pages = pageCount()
      var lastStart = pages ? (pages - 1) * state.pageSize : Math.max(0, state.offset - state.pageSize)
      state.offset = Math.max(0, lastStart)
      return loadList()
    }
    state.shown = items.length
    renderItems(items, false)
    renderPager()
    return null
  }

  function loadList(){
    state.loading = true
    state.lastError = null
    var mySeq = ++state.seq
    // 首屏才铺「载入中…」骨架；翻页保留上一页的行、只把它压暗，
    // 否则每翻一页整块内容闪白一下，看着像崩了。
    if (!state.shown){
      list.textContent = ''
      list.appendChild(el('div', 'empty', '载入中…'))
    }
    list.className = 'list loading'
    renderPager()
    var t0 = now()
    var url = '/dsh-brain/api/memories?limit=' + state.pageSize + '&offset=' + state.offset
    // 翻页只重拉这一页：stats 是总量口径，翻页不会让它变，重拉纯属浪费一次请求
    return fetchJson(url).then(function(d){
      return settle(mySeq, d, t0)
    }, function(e){
      if (mySeq !== state.seq) return
      state.loading = false
      if (cost) cost.textContent = Math.round(now() - t0) + ' ms'
      state.lastError = (e && e.message) ? e.message : String(e)
      state.hasMore = false
      showListError('读取失败：' + state.lastError, loadList)
      renderPager()
    })
  }

  function goPage(n){
    var target = Math.floor(Number(n))
    if (!isFinite(target)) return Promise.resolve()
    if (target < 1) target = 1
    var pages = pageCount()
    if (pages && target > pages) target = pages     // 点不出越界页
    var nextOffset = (target - 1) * state.pageSize
    if (nextOffset === state.offset && !state.lastError) return Promise.resolve()
    state.offset = nextOffset
    state.clamped = false
    return loadList()
  }

  function goNext(){
    if (state.loading || !state.hasMore) return Promise.resolve()
    return goPage(pageIndex() + 1)
  }

  function goPrev(){
    if (state.loading || state.offset <= 0) return Promise.resolve()
    return goPage(pageIndex() - 1)
  }

  function setPageSize(n){
    var size = Math.floor(Number(n))
    if (!isFinite(size) || size < 1) return Promise.resolve()
    if (size > 200) size = 200                     // 与后端 limit 上夹一致
    if (size === state.pageSize){ renderPager(); return Promise.resolve() }
    // 换每页条数必须回第 1 页：offset 是按旧页长算的，不归零会直接落到第 2、3 页
    state.pageSize = size
    state.offset = 0
    state.clamped = false
    return loadList()
  }

  function showAll(){
    q.value = ''
    if (diag) diag.textContent = ''
    state.mode = 'list'
    // 「全部」= 回到分页态第 1 页。只切 mode 不归零 offset 的话，
    // 点「全部」看到的会是第 3 页的行，标题却写着全部——那就是假分页。
    state.offset = 0
    state.total = null
    state.hasMore = false
    state.shown = 0
    state.clamped = false
    state.lastError = null
    renderPager()
    return loadList()
  }

  function fetchJson(url){
    return fetch(url, { credentials: 'same-origin' }).then(function(r){ return r.json() })
  }

  function loadStats(){
    fetchJson('/dsh-brain/api/stats').then(renderStats).catch(function(){ sMem.textContent = '?' })
  }

  // 搜索：走 /api/search，结果少、不分页——所以进搜索态就把分页条藏起来。
  // 搜索失败给「重试」，别再退回列表页（那会让人以为搜索没发生）。
  function doSearch(){
    var query = q.value.trim()
    if (!query) return showAll()
    state.mode = 'search'
    state.loading = true
    state.lastError = null
    var mySeq = ++state.seq
    renderPager()
    list.textContent = ''
    list.className = 'list loading'
    list.appendChild(el('div', 'empty', '检索中…'))
    var t0 = now()
    return fetchJson('/dsh-brain/api/search?q=' + encodeURIComponent(query)).then(function(d){
      if (mySeq !== state.seq) return
      state.loading = false
      if (cost) cost.textContent = Math.round(now() - t0) + ' ms'
      if (!d || !d.ok){
        state.lastError = (d && d.message) || '检索失败'
        showListError(state.lastError, doSearch)
        renderPager()
        return
      }
      renderDiag(d.diagnostics)
      state.shown = Array.isArray(d.hits) ? d.hits.length : 0
      renderItems(d.hits, true)
      renderPager()
    }, function(e){
      if (mySeq !== state.seq) return
      state.loading = false
      state.lastError = (e && e.message) ? e.message : String(e)
      showListError('检索失败：' + state.lastError, doSearch)
      renderPager()
    })
  }

  if (prevBtn) prevBtn.addEventListener('click', function(){ goPrev() })
  if (nextBtn) nextBtn.addEventListener('click', function(){ goNext() })
  if (pgSize) pgSize.addEventListener('change', function(){ setPageSize(pgSize.value) })
  document.getElementById('go').addEventListener('click', doSearch)
  document.getElementById('all').addEventListener('click', function(){ showAll() })
  q.addEventListener('keydown', function(e){ if (e.key === 'Enter') doSearch() })

  // ── 自动化钩子（verify-pages 用） ─────────────────────────────────
  // tools/verify-pages.mjs 的 DOM stub 里 addEventListener 是空实现——上面那几个
  // 点击回调它永远触发不到。所以把分页的每一步都暴露成可直接 await 的函数，
  // 调用的是页面的**同一条真实代码路径**（go → loadList → fetch → settle →
  // renderItems / renderPager），不抄近路、不另写一份逻辑：
  //
  //   window.__pager.state()                 分页状态快照：
  //                                          { mode, pageSize, offset, page, pages, total,
  //                                            hasMore, shown, loading, lastError,
  //                                            prevDisabled, nextDisabled, pagerVisible, info }
  //   window.__pager.go(n)                   跳第 n 页（1 基，自动夹在 1..pages），返回 Promise
  //   window.__pager.next() / prev()         等价于点「下一页」/「上一页」，返回 Promise
  //   window.__pager.setPageSize(20|50|100)  换每页条数并回第 1 页，返回 Promise
  //   window.__pager.search() / showAll()    等价于点「检索」/「全部」，返回 Promise
  //
  // 断言要点：await 完这些 Promise，DOM 与 state() 都已是最终态（settle 是同步落 DOM 的）。
  var pagerApi = {
    state: function(){
      return {
        mode: state.mode,
        pageSize: state.pageSize,
        offset: state.offset,
        page: pageIndex(),
        pages: pageCount(),
        total: state.total,
        hasMore: state.hasMore,
        shown: state.shown,
        loading: state.loading,
        lastError: state.lastError,
        prevDisabled: !!(prevBtn && prevBtn.disabled),
        nextDisabled: !!(nextBtn && nextBtn.disabled),
        pagerVisible: !!(pager && pager.style.display !== 'none'),
        info: pgInfo ? pgInfo.textContent : ''
      }
    },
    go: goPage,
    next: goNext,
    prev: goPrev,
    setPageSize: setPageSize,
    search: doSearch,
    showAll: showAll
  }
  if (typeof window !== 'undefined') window.__pager = pagerApi

  loadStats()
  // 首屏：stats 与列表分别拉。列表走分页默认值 limit=50&offset=0。
  loadList()
})()
</script>
</body>
</html>`
}
