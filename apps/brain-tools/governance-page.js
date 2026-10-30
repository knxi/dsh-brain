// @ts-check
/**
 * 外置大脑 · 治理视图（/dsh-brain/governance，内嵌在 DSH Web 里，同源无额外端口）
 *
 * ── 这页要解决什么 ──
 *
 * 主人说「治理面板打不开」。查下来不是坏了，是没起进程：治理服务在 7420，
 * 要单开一个终端跑 `node apps/server/index.mjs --port 7420`，忘了起就一片空白。
 * 每次想看一眼「最近有没有备份 / 删过什么 / 恢复隔离状态」都得先起服务，体验太差。
 *
 * 所以这页把**能看的部分**内嵌进 3080：备份清单、删除账本、账本水位、隔离状态，
 * 一个端口看全。写操作仍然留在 7420。
 *
 * ── 为什么坚决不做写操作（最重要） ──
 *
 * 治理服务能删记忆、能恢复备份，它靠一份 32 字节 token 文件鉴权。
 * 把这套能力挂到 3080 上，等于把唯一的门锁拆掉——3080 是宿主 webServer 的路由，
 * 没有那层 token。所以这一版**只读**，零安全降级：
 *   - 只看，不做：删除 / 备份 / 恢复 / 隔离解除一律不在这页发请求；
 *   - 页面上明写「写操作请起治理服务」，给可复制的启动命令；
 *   - 给一个 7420 状态灯：在跑绿灯、没起灰灯，一眼看出「不是坏了，是没起」。
 *
 * ── 口径纪律（本项目反复踩的坑） ──
 *
 * 字段缺失一律显示「–」，**不编 0、不编 ok**。
 * 特别注意区分两种「空」：
 *   - `total === 0` 且 `items` 是空数组 → 「还没有备份记录」（真实的空）；
 *   - 整个 `backups` 字段没返回 → 「数据缺失」（读不到，不是没有）。
 * 这两件事混在一起，用户会以为「我没有备份」而实际是「接口没读到」——后果完全不同。
 *
 * 视觉沿用项目既定语言：纸感浅色、单一赭石强调、等宽数字、留白克制。
 * 红只给「需要人现在处理」的状态：隔离生效、备份校验失败、删除失败。
 */

// 导航统一收在 nav.js（顺序与高亮只在那定义一次）。页面只说自己是谁。
import { renderNav, NAV_CSS } from './nav.js'

/** @param {{ scopeId: string }} opts */
export function renderGovernancePage({ scopeId }) {
  const escapedScope = String(scopeId).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 治理视图</title>
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
.head{display:flex;align-items:baseline;gap:14px;margin-bottom:6px;flex-wrap:wrap}
h1{font-size:21px;font-weight:650;letter-spacing:.01em;margin:0}
.sub{color:var(--muted);font-size:12.5px}
.nav{display:flex;gap:8px;margin-left:auto}
.navlink{font-size:13px;padding:8px 15px;border:1px solid var(--line);border-radius:10px;
  background:var(--card);color:var(--ink);text-decoration:none;transition:all .18s;white-space:nowrap}
.navlink:hover{border-color:var(--ochre);color:var(--ochre)}
.path{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-bottom:22px;word-break:break-all}

.banner{background:var(--bad-soft);border:1px solid #eccfca;border-radius:12px;
  padding:15px 19px;margin-bottom:22px;color:#8f3d35;font-size:13.5px;line-height:1.7}
.banner strong{font-weight:650}
.banner.hide,.hide{display:none!important}

.card{background:var(--card);border:1px solid var(--line);border-radius:14px;
  margin-bottom:20px;overflow:hidden;transition:box-shadow .2s}
.card:hover{box-shadow:0 2px 14px rgba(36,31,27,.05)}
.card-head{display:flex;align-items:baseline;gap:10px;padding:14px 20px;
  border-bottom:1px solid var(--line);background:#fdfaf6;flex-wrap:wrap}
.card-title{font-size:13.5px;font-weight:620}
.meta{font-size:11.5px;color:var(--muted);margin-left:auto}
.body{padding:16px 20px}
.body.tight{padding:0}

.lamp{display:inline-block;width:9px;height:9px;border-radius:50%;background:#d9d3c9;
  vertical-align:middle;flex:none}
.lamp.on{background:var(--ok);box-shadow:0 0 0 3px #e8f1ec}
.lamp.off{background:#b8b0a5;box-shadow:0 0 0 3px #f2eee7}
.lamp.unknown{background:#d9d3c9}
.lamp-text{font-size:13px;font-weight:600}
.lamp-text.on{color:var(--ok)}
.lamp-text.off{color:var(--muted)}
.lamp-text.unknown{color:var(--muted)}
.lead{margin:0 0 4px;font-size:13px;line-height:1.75;color:var(--ink)}
.lead.dim{color:var(--muted)}
.cmdrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0 10px}
.cmd{font-family:var(--mono);font-size:12px;background:#f1ece4;padding:9px 12px;border-radius:8px;
  color:var(--ink);cursor:pointer;border:1px dashed transparent;word-break:break-all;line-height:1.5}
.cmd:hover{border-color:var(--ochre);color:var(--ochre)}
.ghost{padding:8px 14px;border:1px solid var(--line);border-radius:9px;background:var(--card);
  font-size:12.5px;color:var(--ink);cursor:pointer;transition:all .18s}
.ghost:hover{border-color:var(--ochre);color:var(--ochre)}
.openlink{font-size:12.5px;padding:8px 14px;border:1px solid var(--line);border-radius:9px;
  background:var(--card);color:var(--ochre);text-decoration:none;white-space:nowrap;transition:all .18s}
.openlink:hover{border-color:var(--ochre);background:var(--ochre-soft)}
.hint{margin:0;font-size:12.5px;color:var(--muted);line-height:1.7}

.stats{display:flex;gap:26px;padding:15px 20px;background:var(--card);border:1px solid var(--line);
  border-radius:12px;margin-bottom:22px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column;gap:2px;min-width:0}
.stat-k{font-size:10.5px;color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
.stat-v{font-size:19px;font-weight:620;font-family:var(--mono);font-variant-numeric:tabular-nums}
.stat-v.bad{color:var(--bad)}
.stat-v.ok{color:var(--ok)}
.stat-v.small{font-size:13px;font-weight:550}
.lgrid{display:flex;gap:34px;flex-wrap:wrap}
.lgrid .stat-v.small{max-width:420px;word-break:break-all}

.tbl{width:100%;border-collapse:collapse}
.tbl th{font-size:10.5px;color:var(--muted);text-align:left;font-weight:550;letter-spacing:.05em;
  text-transform:uppercase;padding:9px 20px;border-bottom:1px solid var(--line);background:#fdfaf6;white-space:nowrap}
.tbl td{padding:12px 20px;border-bottom:1px solid var(--line);vertical-align:top;font-size:12.5px}
.tbl tr:last-child td{border-bottom:none}
.tbl .num{font-family:var(--mono);font-variant-numeric:tabular-nums;white-space:nowrap}
.tbl .when{white-space:nowrap;color:var(--ink)}
.subline{font-size:11px;color:var(--muted);word-break:break-all;line-height:1.6;margin-top:3px}

.tag{display:inline-block;font-size:11px;padding:2px 8px;border-radius:6px;font-weight:550;
  letter-spacing:.02em;white-space:nowrap}
.tag.ok{background:#e6f0ea;color:var(--ok)}
.tag.bad{background:#f6e6e4;color:var(--bad)}
.tag.warn{background:#fdf6ee;color:var(--warn)}
.tag.plain{background:#f1ece4;color:var(--muted)}
code.copy{font-family:var(--mono);font-size:11px;background:#f1ece4;padding:2px 6px;
  border-radius:4px;cursor:pointer;color:var(--ink);word-break:break-all}
code.copy:hover{background:var(--ochre-soft);color:var(--ochre)}

.empty{padding:44px 22px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}
.empty strong{display:block;color:var(--ink);font-size:14.5px;font-weight:620;margin-bottom:6px}
.empty.miss strong{color:var(--warn)}
.body.tight .hint{margin:0;padding:10px 20px 14px}
.diag{margin:0 0 20px;padding:13px 17px;border-radius:10px;font-size:13px;
  background:var(--card);border:1px solid var(--line)}
.diag.bad{border-color:#eccfca;background:#fdf1f0;color:#8f3d35}

.note{font-size:12px;color:var(--muted);margin-top:22px;padding:13px 17px;
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
    <h1>治理视图</h1>
    <span class="sub">只读 · 看状态，不做写操作</span>
    ${renderNav({ active: 'governance' })}
  </div>
  <div class="path">scope: ${escapedScope} · /dsh-brain/api/governance</div>

  <div class="banner hide" id="iso-banner"></div>

  <div class="card">
    <div class="card-head">
      <span class="lamp unknown" id="lamp"></span>
      <span class="card-title">治理服务</span>
      <span class="lamp-text unknown" id="lamp-text">检查中…</span>
      <span class="meta" id="lamp-meta">–</span>
    </div>
    <div class="body">
      <p class="lead" id="console-note">正在探测 7420 是否在跑…</p>
      <div class="cmdrow">
        <code class="cmd" id="cmd" title="点击复制">node apps/server/index.mjs --port 7420</code>
        <button class="ghost" id="copy-cmd" type="button">复制命令</button>
        <a class="openlink" id="open-7420" href="http://127.0.0.1:7420/" target="_blank" rel="noopener">打开 7420</a>
      </div>
      <p class="hint" id="write-hint">在这个页面之前没有任何写操作入口：删除 / 备份 / 恢复都不在 3080 上执行。</p>
    </div>
  </div>

  <div class="stats">
    <div class="stat"><span class="stat-k">备份</span><span class="stat-v" id="s-backups">–</span></div>
    <div class="stat"><span class="stat-k">删除记录</span><span class="stat-v" id="s-deletions">–</span></div>
    <div class="stat"><span class="stat-k">隔离</span><span class="stat-v" id="s-iso">–</span></div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">备份中心</span>
      <span class="meta" id="bk-meta">–</span>
    </div>
    <div class="body tight" id="backups"><div class="empty">载入中…</div></div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">删除账本</span>
      <span class="meta" id="dl-meta">–</span>
    </div>
    <div class="body tight" id="deletions"><div class="empty">载入中…</div></div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">账本水位</span>
      <span class="meta" id="lg-meta">–</span>
    </div>
    <div class="body" id="ledger"><div class="empty">载入中…</div></div>
  </div>

  <div class="card">
    <div class="card-head">
      <span class="card-title">恢复隔离</span>
      <span class="meta" id="iso-meta">–</span>
    </div>
    <div class="body" id="isolation"><div class="empty">载入中…</div></div>
  </div>

  <!-- 情感状态：情绪也是要跟着记忆一起备份的数据，治理页该看得见它。
       只读三个数，定性词和事件时间线在心情页——两页各说一件事，不重复维护同一份档位表。 -->
  <div class="card">
    <div class="card-head">
      <span class="card-title">情感状态</span>
      <span class="meta" id="mood-meta">–</span>
    </div>
    <div class="body" id="mood"><div class="empty">载入中…</div></div>
  </div>

  <p class="note">
    <b>为什么这页不能删东西：</b>治理服务（<code>7420</code>）靠一份 32 字节 token 文件鉴权，
    删除 / 备份 / 恢复全在那层门锁后面。把那些按钮挂到 3080 上，等于把唯一的锁拆了。
    所以这里的边界很硬：<b>看得到状态，写操作请起治理服务</b>。
    状态灯是灰的不代表坏了——是服务没起，跑一下上面的命令再点「打开 7420」。
  </p>

  <div class="foot">
    <span>只读视图 · 数据来自 /dsh-brain/api/governance</span>
    <span style="flex:1"></span>
    <a href="/dsh-brain">回列表</a>
  </div>
</div>
<script>
(function(){
  var CMD = 'node apps/server/index.mjs --port 7420'
  var MAX_ROWS = 10

  function el(tag, cls, text){ var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
  function txt(id, v){ var n = document.getElementById(id); if (n) n.textContent = v }
  function setCls(id, cls){ var n = document.getElementById(id); if (n) n.className = cls }
  function isNum(v){ return typeof v === 'number' && isFinite(v) }

  // 数字口径：缺失 → 「–」；真 0 → 「0」。**绝不**把缺失补成 0。
  function numText(v){
    if (isNum(v)) return String(v)
    if (typeof v === 'string' && v.trim() !== ''){ var n = Number(v); if (isFinite(n)) return String(n) }
    return '–'
  }
  function fmtTime(iso){
    if (iso === null || iso === undefined || iso === '') return '–'
    var d = new Date(iso)
    if (isNaN(d.getTime())) return String(iso)
    var p = function(n){ return String(n).padStart(2, '0') }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }
  function fmtSize(v){
    var bytes = v
    if (typeof bytes === 'string' && bytes.trim() !== '') bytes = Number(bytes)
    if (!isNum(bytes)) return '–'
    return (bytes / 1048576).toFixed(1) + ' MB'
  }
  function tag(cls, text, title){
    var n = el('span', cls, text)
    if (title) n.title = title
    return n
  }

  // 校验状态：ok 绿 / failed 红 / 其余灰。未知值原样显示，不替它说「通过」。
  function integrityTag(v){
    var raw = typeof v === 'string' ? v : ''
    if (raw === 'ok') return tag('tag ok', '通过', raw)
    if (raw === 'failed') return tag('tag bad', '失败', raw)
    if (raw === 'missing_file') return tag('tag plain', '文件缺失', raw)
    if (raw === 'unverified') return tag('tag plain', '未校验', raw)
    if (raw === '') return tag('tag plain', '–', '接口没有返回 integrity')
    return tag('tag plain', raw, '未识别的 integrity 值：' + raw)
  }
  function resultTag(v){
    var raw = typeof v === 'string' ? v : ''
    if (raw === 'done') return tag('tag ok', '已完成', raw)
    if (raw === 'failed') return tag('tag bad', '失败', raw)
    if (raw === 'dead') return tag('tag bad', '失败（dead）', raw)
    if (raw === 'pending' || raw === 'running') return tag('tag warn', '进行中', raw)
    if (raw === 'not_started') return tag('tag plain', '未开始', raw)
    if (raw === '') return tag('tag plain', '–', '接口没有返回 result')
    return tag('tag plain', raw, '未识别的 result 值：' + raw)
  }

  // 可点击复制。剪贴板不可用时不假装成功——改成把全文摊出来，让人能手动选。
  function copyCode(full, shortLabel){
    var label = shortLabel != null ? shortLabel : full
    var code = el('code', 'copy', label)
    if (!full) return code
    code.title = '点击复制：' + full
    code.addEventListener('click', function(){
      var clip = (typeof navigator !== 'undefined' && navigator) ? navigator.clipboard : null
      try {
        if (clip && typeof clip.writeText === 'function'){
          clip.writeText(full)
          code.textContent = '已复制'
          setTimeout(function(){ code.textContent = label }, 1200)
        } else {
          code.textContent = full
          code.title = '剪贴板不可用，请手动复制'
        }
      } catch (err) {
        code.textContent = full
        code.title = '剪贴板不可用，请手动复制'
      }
    })
    return code
  }
  // 记忆 ID 只给前 8 位（够认人、不刷屏），完整值在下一行小字里。
  function shortId(v){
    if (v === null || v === undefined || v === '') return ''
    return String(v).slice(0, 8)
  }
  // 备份 ID 给前 14 位：备份 ID 常带日期前缀（bkp_20261030_...），只给 8 位全撞成同一天。
  function shortBackupId(v){
    if (v === null || v === undefined || v === '') return ''
    return String(v).slice(0, 14)
  }
  function statBox(k, v, cls){
    var box = el('div', 'stat')
    box.appendChild(el('span', 'stat-k', k))
    box.appendChild(el('span', 'stat-v' + (cls ? ' ' + cls : ''), v))
    return box
  }
  function emptyBox(title, text, missing){
    var box = el('div', 'empty' + (missing ? ' miss' : ''))
    box.appendChild(el('strong', null, title))
    box.appendChild(document.createTextNode(text))
    return box
  }
  function tableHead(cols){
    var thead = el('thead')
    var tr = el('tr')
    var i = 0
    for (i = 0; i < cols.length; i++) tr.appendChild(el('th', null, cols[i]))
    thead.appendChild(tr)
    return thead
  }

  // ── 顶部状态灯 ─────────────────────────────────────────────
  function renderConsole(c){
    var lamp = document.getElementById('lamp')
    if (!c || typeof c !== 'object' || typeof c.running !== 'boolean'){
      if (lamp) lamp.className = 'lamp unknown'
      setCls('lamp-text', 'lamp-text unknown')
      txt('lamp-text', '状态未知')
      txt('lamp-meta', c && c.checkedAt ? '探测于 ' + fmtTime(c.checkedAt) : '–')
      txt('console-note', '接口没有返回 console.running——不能假设它在跑，也不能假设它没起，所以不亮灯。')
      return
    }
    if (c.running){
      if (lamp) lamp.className = 'lamp on'
      setCls('lamp-text', 'lamp-text on')
      txt('lamp-text', '在跑')
      // 服务在跑时说清楚「你在哪、该去哪」，不用「降级」这类吓人的词：
      // 本页是同源只读视图（同一份数据、能看不能写），功能最全的是 7420 那个面板。
      txt('console-note', '治理服务已在跑（7420）。删除 / 备份 / 恢复都在那个面板上做；'
        + '你现在看的这页是同一份数据的只读视图——备份清单、删除账本、账本水位、隔离状态都能看，'
        + '只是不发写请求。功能最全的入口是下面的「打开 7420」，/dsh-brain/governance 正常也是通向它。')
    } else {
      if (lamp) lamp.className = 'lamp off'
      setCls('lamp-text', 'lamp-text off')
      txt('lamp-text', '没起')
      txt('console-note', '7420 没起——这是常态，不代表坏了。要在项目根（dsh-brain）下跑下面这条命令，再点「打开 7420」。'
        + '在那之前，这页照样能看备份清单、删除账本、账本水位和隔离状态。')
    }
    var port = c.port === null || c.port === undefined ? '–' : String(c.port)
    var when = c.checkedAt ? ' · 探测于 ' + fmtTime(c.checkedAt) : ''
    txt('lamp-meta', '端口 ' + port + when)
  }

  // ── 备份清单 ───────────────────────────────────────────────
  function renderBackups(b){
    var host = document.getElementById('backups')
    host.textContent = ''
    if (!b || typeof b !== 'object' || !Array.isArray(b.items)){
      txt('s-backups', '–')
      txt('bk-meta', '数据缺失')
      host.appendChild(emptyBox('备份数据没读到',
        '接口没有返回 backups.items——这是「读不到」，不是「没有备份」，别当成 0。', true))
      return
    }
    var items = b.items
    var total = b.total
    var totalText = numText(total)
    txt('s-backups', totalText)
    if (items.length === 0){
      // 真实的空：total 也是 0 / 缺失且数组为空 → 「还没有备份记录」。
      txt('bk-meta', '共 ' + totalText + ' 份')
      host.appendChild(emptyBox('还没有备份记录',
        '没有备份就没有回退点——删除之后，旧备份这一层也就无从谈起。备份要起治理服务做。', false))
      return
    }
    var shown = Math.min(items.length, MAX_ROWS)
    txt('bk-meta', '共 ' + totalText + ' 份 · 显示最近 ' + shown + ' 份')

    var table = el('table', 'tbl')
    table.appendChild(tableHead(['创建时间', '大小', '校验', '备份']))
    var tbody = el('tbody')
    var i = 0
    for (i = 0; i < shown; i++){
      var bk = items[i] || {}
      var tr = el('tr')
      var tdWhen = el('td', 'when', fmtTime(bk.createdAt))
      tr.appendChild(tdWhen)
      tr.appendChild(el('td', 'num', fmtSize(bk.sizeBytes)))
      var tdInt = el('td')
      tdInt.appendChild(integrityTag(bk.integrity))
      tr.appendChild(tdInt)
      var tdId = el('td')
      tdId.appendChild(copyCode(bk.id ? String(bk.id) : '', shortBackupId(bk.id) || '–'))
      if (bk.path){
        tdId.appendChild(el('div', 'subline', String(bk.path)))
      } else {
        tdId.appendChild(el('div', 'subline', '路径未记录'))
      }
      tr.appendChild(tdId)
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    host.appendChild(table)
    if (items.length > MAX_ROWS){
      host.appendChild(el('p', 'hint', '还有 ' + (items.length - MAX_ROWS) + ' 份更早的没列出来（本页最多列 ' + MAX_ROWS + ' 份）。'))
    }
  }

  // ── 删除账本最近条目 ───────────────────────────────────────
  function renderDeletions(dl){
    var host = document.getElementById('deletions')
    host.textContent = ''
    if (!dl || typeof dl !== 'object' || !Array.isArray(dl.items)){
      txt('s-deletions', '–')
      txt('dl-meta', '数据缺失')
      host.appendChild(emptyBox('删除账本没读到',
        '接口没有返回 deletions.items——这是「读不到」，不是「没删过东西」。', true))
      return
    }
    var items = dl.items
    var totalText = numText(dl.total)
    txt('s-deletions', totalText)
    if (items.length === 0){
      txt('dl-meta', '共 ' + totalText + ' 条')
      host.appendChild(emptyBox('还没有删除记录',
        '账本里没有条目。删除是不可逆的——真要删，去治理服务上走删除流程，它会记账。', false))
      return
    }
    var shown = Math.min(items.length, MAX_ROWS)
    txt('dl-meta', '共 ' + totalText + ' 条 · 显示最近 ' + shown + ' 条')

    var table = el('table', 'tbl')
    table.appendChild(tableHead(['时间', '记忆 ID', '操作者', '结果']))
    var tbody = el('tbody')
    var i = 0
    for (i = 0; i < shown; i++){
      var d = items[i] || {}
      var tr = el('tr')
      tr.appendChild(el('td', 'when', fmtTime(d.at)))
      var tdId = el('td')
      var fullId = d.memoryId === null || d.memoryId === undefined ? '' : String(d.memoryId)
      tdId.appendChild(copyCode(fullId, shortId(fullId) || '–'))
      if (fullId.length > 8) tdId.appendChild(el('div', 'subline', '完整：' + fullId))
      tr.appendChild(tdId)
      tr.appendChild(el('td', null, d.actor === null || d.actor === undefined || d.actor === '' ? '–' : String(d.actor)))
      var tdRes = el('td')
      tdRes.appendChild(resultTag(d.result))
      tr.appendChild(tdRes)
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    host.appendChild(table)
    if (items.length > MAX_ROWS){
      host.appendChild(el('p', 'hint', '还有 ' + (items.length - MAX_ROWS) + ' 条更早的没列出来（本页最多列 ' + MAX_ROWS + ' 条）。'))
    }
  }

  // ── 账本水位 ───────────────────────────────────────────────
  function renderLedger(lg){
    var host = document.getElementById('ledger')
    host.textContent = ''
    if (!lg || typeof lg !== 'object'){
      txt('lg-meta', '数据缺失')
      host.appendChild(emptyBox('账本水位没读到',
        '接口没有返回 ledger——水位未知，不能当成「零条」。', true))
      return
    }
    var box = el('div', 'lgrid')
    box.appendChild(statBox('条目', numText(lg.entries)))
    box.appendChild(statBox('epoch', numText(lg.epoch)))
    box.appendChild(statBox('末条 hash', lg.lastHashShort ? String(lg.lastHashShort) : '–', 'small'))
    box.appendChild(statBox('更新于', fmtTime(lg.updatedAt), 'small'))
    host.appendChild(box)
    txt('lg-meta', lg.updatedAt ? '更新于 ' + fmtTime(lg.updatedAt) : '–')
  }

  // ── 隔离状态 ───────────────────────────────────────────────
  function renderIsolation(iso){
    var banner = document.getElementById('iso-banner')
    var host = document.getElementById('isolation')
    host.textContent = ''
    if (!iso || typeof iso !== 'object' || typeof iso.required !== 'boolean'){
      txt('s-iso', '–')
      txt('iso-meta', '状态未知')
      if (banner) banner.className = 'banner hide'
      host.appendChild(emptyBox('隔离状态未知',
        '接口没有返回 isolation.required——既不能说「已隔离」，也不能说「未触发」。', true))
      return
    }
    if (iso.required){
      txt('s-iso', '已隔离')
      setCls('s-iso', 'stat-v bad')
      txt('iso-meta', '需要人处理')
      if (banner){
        banner.className = 'banner'
        banner.textContent = ''
        banner.appendChild(el('strong', null, '恢复隔离生效：这个实例只能只读检修。'))
        banner.appendChild(document.createTextNode(' ' + (iso.reason ? String(iso.reason) : '（接口没有给原因）')))
      }
      host.appendChild(statBox('状态', '已隔离', 'bad'))
      host.appendChild(el('p', 'lead', iso.reason ? String(iso.reason) : '（接口没有给原因）'))
      host.appendChild(el('p', 'hint', '隔离解除是写操作，不在这页做。'))
    } else {
      txt('s-iso', '未触发')
      setCls('s-iso', 'stat-v ok')
      txt('iso-meta', '正常')
      if (banner) banner.className = 'banner hide'
      host.appendChild(statBox('状态', '未触发'))
      host.appendChild(el('p', 'hint', '没有隔离原因。这个实例可以正常服务。'))
    }
  }

  // ── 情感状态（只读三格）────────────────────────────────────
  // 情绪也是要跟着记忆一起备份的数据，所以治理页该看得见它：备份清单能看出「记忆有没有回退点」，
  // 这三格能看出「我自己的状态有没有回退点」。
  //
  // 口径和心情页一致：缺字段「–」，state 为 null 也「–」——**不补 0**。
  // 这里只给数字，不给定性词：定性词档位表只维护一份（在心情页 / core.js），
  // 在这页再抄一遍就成了第二份真相，改一边忘一边就是两个说法。
  var moodView = { loaded: false, ok: false, hasState: false, mood: '–', energy: '–', bond: '–', meta: '–' }

  function renderMood(m){
    var host = document.getElementById('mood')
    if (host) host.textContent = ''
    moodView.loaded = true
    moodView.ok = !!(m && m.ok === true)
    var state = (m && m.state && typeof m.state === 'object') ? m.state : null
    moodView.hasState = state !== null
    if (!moodView.ok){
      moodView.mood = '–'
      moodView.energy = '–'
      moodView.bond = '–'
      moodView.meta = '读不到'
      txt('mood-meta', moodView.meta)
      if (host) host.appendChild(emptyBox('情感状态没读到',
        '接口这次没返回可用数据。三格一律「–」——状态未知，不是 0。', true))
      return
    }
    if (state === null){
      moodView.mood = '–'
      moodView.energy = '–'
      moodView.bond = '–'
      moodView.meta = '没有记录'
      txt('mood-meta', moodView.meta)
      if (host) host.appendChild(emptyBox('还没有情感记录',
        '主账的情感表还没数据，插件备档也读不到。三格「–」，不是 0 分。', true))
      return
    }
    moodView.mood = numText(state.mood)
    moodView.energy = numText(state.energy)
    moodView.bond = numText(state.bond)
    moodView.meta = '只读 · /dsh-brain/api/mood'
    txt('mood-meta', moodView.meta)
    var box = el('div', 'lgrid')
    box.appendChild(statBox('心情', moodView.mood))
    box.appendChild(statBox('精力', moodView.energy))
    box.appendChild(statBox('亲密', moodView.bond))
    box.appendChild(statBox('更新于', fmtTime(state.updatedAt), 'small'))
    if (host) host.appendChild(box)
    var row = el('p', 'hint')
    row.appendChild(document.createTextNode('定性词（很好，有点飘…）和逐条事件在心情页：'))
    var go = el('a', 'openlink', '看心情页 →')
    go.href = '/dsh-brain/mood'
    go.style.marginLeft = '8px'
    row.appendChild(go)
    if (host) host.appendChild(row)
  }

  // 情感状态走独立接口、独立失败：治理接口挂了不该连带把它说成「读不到」，
  // 反之亦然——两个数据源各报各的状态，不互相背锅。
  function loadMood(){
    fetch('/dsh-brain/api/mood', { credentials: 'same-origin' })
      .then(function(r){ return r.json() })
      .then(renderMood, function(err){
        renderMood({ ok: false, message: (err && err.message) ? String(err.message) : String(err) })
      })
  }

  function failAll(message){
    renderConsole(null)
    renderBackups(null)
    renderDeletions(null)
    renderLedger(null)
    renderIsolation(null)
    txt('s-backups', '–')
    txt('s-deletions', '–')
    txt('s-iso', '–')
    setCls('s-iso', 'stat-v')
    var hint = document.getElementById('write-hint')
    if (hint){
      hint.className = 'diag bad'
      hint.textContent = '读取失败：' + message + '。状态未知（不是 0，也不是 ok）。'
    }
  }

  // 复制启动命令：只写剪贴板，不发任何请求。
  var copyBtn = document.getElementById('copy-cmd')
  if (copyBtn){
    copyBtn.addEventListener('click', function(){
      var clip = (typeof navigator !== 'undefined' && navigator) ? navigator.clipboard : null
      try {
        if (clip && typeof clip.writeText === 'function'){
          clip.writeText(CMD)
          copyBtn.textContent = '已复制'
          setTimeout(function(){ copyBtn.textContent = '复制命令' }, 1200)
        } else {
          copyBtn.textContent = '请手动选中命令'
        }
      } catch (err) {
        copyBtn.textContent = '请手动选中命令'
      }
    })
  }

  // 唯一的一次请求：GET。这页永远不会发 POST / DELETE。
  fetch('/dsh-brain/api/governance', { credentials: 'same-origin' })
    .then(function(r){ return r.json() })
    .then(function(d){
      if (!d || d.ok !== true){
        failAll((d && d.message) || '接口没有返回 ok:true')
        return
      }
      var hint = document.getElementById('write-hint')
      if (hint){
        hint.className = 'hint'
        if (d.canWrite === false){
          hint.textContent = '本页只读（canWrite=false）。' + (d.writeHint ? String(d.writeHint) : '写操作（删除/备份/恢复）需要治理服务：' + CMD)
        } else if (d.canWrite === true){
          hint.textContent = '后端报告 canWrite=true，但本页不提供任何写操作。删除 / 备份 / 恢复请到治理服务上做。'
        } else {
          hint.textContent = '没有拿到 canWrite 标记（–）。本页无论如何都不发写请求；写操作请到治理服务上做。'
        }
      }
      renderIsolation(d.isolation)
      renderConsole(d.console)
      renderBackups(d.backups)
      renderDeletions(d.deletions)
      renderLedger(d.ledger)
    })
    .catch(function(err){
      failAll(err && err.message ? String(err.message) : String(err))
    })

  loadMood()

  // 调试钩子：DOM stub 里读不到子节点拼起来的文本，所以单独记一份渲染结果给断言用。
  if (typeof window !== 'undefined'){
    window.__governance = {
      mood: function(){
        return {
          loaded: moodView.loaded,
          ok: moodView.ok,
          hasState: moodView.hasState,
          mood: moodView.mood,
          energy: moodView.energy,
          bond: moodView.bond,
          meta: moodView.meta
        }
      }
    }
  }
})()
</script>
</body>
</html>`
}
