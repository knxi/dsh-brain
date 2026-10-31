// @ts-check
/**
 * 外置大脑 · 使用情况页面（/dsh-brain/usage，内嵌在 DSH Web 里，同源无额外端口）
 *
 * 这份页面要回答的不是「系统健康吗」，而是 ROADMAP 里那个卡住进度的问题：
 *   **检索到底准不准？能不能据此决定卸掉灵枢 / Engram？**
 *
 * 所以四块内容按「能不能下判断」排：
 *   1. 概览：查了多少次、命中率、零命中、弱路降级——够不够样本
 *   2. 每日趋势：观察期有没有在真的用（不是装了没用）
 *   3. 零命中查询：语料缺口还是索引问题，看原话最快
 *   4. 从没被查到的记忆：重要却从没被想起的，才是死数据嫌疑
 *
 * 视觉沿用项目既定语言：纸感浅色、单一赭石强调、等宽数字、留白克制。
 * 纪律：这里只呈现事实和候选，不下「该删哪条」的结论——删记忆是不可逆的。
 */

// 导航统一收在 nav.js（顺序与高亮只在那定义一次）。页面只说自己是谁。
import { renderNav, NAV_CSS } from './nav.js'

/**
 * @param {{ logPath: string, windowDays: number }} opts
 */
export function renderUsagePage({ logPath, windowDays }) {
  const escapedLogPath = String(logPath).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const days = Number(windowDays) > 0 ? Number(windowDays) : 7
  // 天数窗口是**服务端**变量：接口地址在这里拼好，页面脚本只负责把字符串搬进去。
  // 不写成「单引号里放 ${days}」——那虽然也能被外层模板串插值成数字，但读起来像坏掉的
  // 模板串（审计就把它读成了 bug），靠隐式行为兜底不如显式拼一次。
  const usageApi = '/dsh-brain/api/usage?days=' + days
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 使用情况</title>
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
.nav{display:flex;gap:8px;margin-left:auto}
.navlink{font-size:13px;padding:8px 15px;border:1px solid var(--line);border-radius:10px;
  background:var(--card);color:var(--ink);text-decoration:none;transition:all .18s;white-space:nowrap}
.navlink:hover{border-color:var(--ochre);color:var(--ochre)}
.path{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-bottom:22px;word-break:break-all}

.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:1px;
  background:var(--line);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-bottom:22px}
.stat{background:var(--card);padding:15px 17px;display:flex;flex-direction:column;gap:3px}
.stat-k{font-size:10.5px;color:var(--muted);letter-spacing:.05em;text-transform:uppercase}
.stat-v{font-size:20px;font-weight:620;font-family:var(--mono);font-variant-numeric:tabular-nums;line-height:1.2}
.stat-n{font-size:11px;color:var(--muted)}
.stat-v.good{color:var(--ok)} .stat-v.warn{color:var(--warn)} .stat-v.bad{color:var(--bad)}

h2{font-size:13px;font-weight:600;letter-spacing:.02em;margin:0 0 12px;color:var(--ink)}
h2 span{font-weight:400;color:var(--muted);font-size:11.5px;margin-left:8px;letter-spacing:0}
.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin-bottom:18px}
.grid2{display:grid;grid-template-columns:1.35fr 1fr;gap:18px}
@media(max-width:760px){.grid2{grid-template-columns:1fr}}

.bars{display:flex;align-items:flex-end;gap:5px;height:96px;padding-top:6px}
.bar{flex:1;min-width:5px;display:flex;flex-direction:column;justify-content:flex-end;gap:2px;height:100%}
.bar-i{background:var(--ochre);border-radius:3px 3px 0 0;min-height:2px;transition:height .3s;position:relative}
.bar-i.zero{background:#ddd4c6}
.bar-x{font-family:var(--mono);font-size:9px;color:var(--muted);text-align:center;white-space:nowrap;
  overflow:hidden;height:12px}
.legend{display:flex;gap:14px;font-size:11px;color:var(--muted);margin-top:8px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;vertical-align:-1px}

.rows{display:flex;flex-direction:column}
.r{display:flex;align-items:baseline;gap:10px;padding:7px 0;border-bottom:1px solid var(--line);font-size:13px}
.r:last-child{border-bottom:none}
.r-q{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.r-n{font-family:var(--mono);font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;white-space:nowrap}
.pill{font-size:10.5px;padding:2px 7px;border-radius:6px;background:#f1ece4;color:var(--muted);white-space:nowrap}
.pill.ok{background:#e6f0ea;color:var(--ok)} .pill.bad{background:#f6e6e4;color:var(--bad)}
.pill.warn{background:var(--ochre-soft);color:var(--ochre)}
.empty{padding:18px 0;color:var(--muted);font-size:12.5px}
.flow{width:100%;border-collapse:collapse;font-size:12.5px}
.flow th{text-align:left;font-weight:500;color:var(--muted);font-size:11px;padding:0 10px 7px 0;
  border-bottom:1px solid var(--line);text-transform:uppercase;letter-spacing:.04em}
.flow td{padding:7px 10px 7px 0;border-bottom:1px solid #f2ece4;vertical-align:baseline}
.flow tr:last-child td{border-bottom:none}
.flow td.q{font-weight:500}
.t{font-family:var(--mono);font-size:11px;color:var(--muted);white-space:nowrap}
code{font-family:var(--mono);font-size:11.5px;background:#f1ece4;padding:1px 5px;border-radius:4px}
.foot{margin-top:34px;padding-top:20px;border-top:1px solid var(--line);
  color:var(--muted);font-size:12px;display:flex;gap:18px;flex-wrap:wrap;align-items:center}
.foot a{color:var(--ochre);text-decoration:none;border-bottom:1px dotted currentColor}
.spin{display:inline-block;width:13px;height:13px;border:2px solid var(--line);
  border-top-color:var(--ochre);border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px}
@keyframes s{to{transform:rotate(360deg)}}
.note{font-size:12px;color:var(--muted);margin:10px 0 0;padding:10px 13px;border-left:2px solid var(--line)}
${NAV_CSS}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">
    <h1>使用情况</h1>
    <span class="sub">最近 ${days} 天的检索行为</span>
    ${renderNav({ active: 'usage' })}
  </div>
  <div class="path">${escapedLogPath}</div>

  <div class="stats" id="stats">
    <div class="stat"><span class="stat-k">检索次数</span><span class="stat-v" id="s-total">–</span><span class="stat-n" id="s-total-n"></span></div>
    <div class="stat"><span class="stat-k">命中率</span><span class="stat-v" id="s-hit">–</span><span class="stat-n" id="s-hit-n"></span></div>
    <div class="stat"><span class="stat-k">零命中</span><span class="stat-v" id="s-zero">–</span><span class="stat-n" id="s-zero-n">没找着相关记忆</span></div>
    <div class="stat"><span class="stat-k">弱路命中</span><span class="stat-v" id="s-lane">–</span><span class="stat-n">主路没命中、靠兜底</span></div>
    <div class="stat"><span class="stat-k">平均耗时</span><span class="stat-v" id="s-avg">–</span><span class="stat-n" id="s-avg-n"></span></div>
    <div class="stat"><span class="stat-k">被查到的记忆</span><span class="stat-v" id="s-touch">–</span><span class="stat-n" id="s-touch-n"></span></div>
    <div class="stat"><span class="stat-k">引用率（下界）</span><span class="stat-v" id="s-quote">–</span><span class="stat-n" id="s-quote-n">回答里出现连续原文</span></div>
  </div>

  <p class="note" id="quote-note">引用率只统计「回答里出现了命中记忆连续 12 字以上原文」的命中——
    模型改写成自己的话时分辨不出来，所以这是下界，不是全量；判不了的一律记「未判定」，不记「没用上」。</p>

  <div class="grid2">
    <div class="panel">
      <h2>每日检索<span id="daily-n"></span></h2>
      <div class="bars" id="bars"></div>
      <div class="legend">
        <span><i class="dot" style="background:var(--ochre)"></i>有命中</span>
        <span><i class="dot" style="background:#ddd4c6"></i>零命中</span>
      </div>
    </div>
    <div class="panel">
      <h2>诊断分布</h2>
      <div class="rows" id="status-rows"></div>
    </div>
  </div>

  <div class="grid2">
    <div class="panel">
      <h2>最常查的词<span>前 10</span></h2>
      <div class="rows" id="top-rows"></div>
    </div>
    <div class="panel">
      <h2>零命中查询<span>语料缺口 or 索引问题</span></h2>
      <div class="rows" id="zero-rows"></div>
    </div>
  </div>

  <div class="panel">
    <h2>从没被查到过的记忆<span id="cov-n"></span></h2>
    <div class="rows" id="never-rows"></div>
    <p class="note">按重要度从高到低取。重要却一次没被想起，才是真信号；不重要的一次没被想起很正常。
      这里只给候选，不自动清理——删记忆不可逆。</p>
  </div>

  <div class="panel">
    <h2>最近检索<span id="flow-n"></span></h2>
    <table class="flow">
      <thead><tr><th>时间</th><th>通道</th><th>查询</th><th>命中</th><th>诊断</th><th>耗时</th></tr></thead>
      <tbody id="flow-body"><tr><td colspan="6" class="empty">载入中…</td></tr></tbody>
    </table>
  </div>

  <div class="foot">
    <span>观测数据只落本机 <code>data/logs/usage.jsonl</code>，不进记忆库、不进任何外部通道。</span>
    <span style="flex:1"></span>
    <a href="/dsh-brain">回列表</a>
  </div>
</div>
<script>
(function(){
  var DOC = document
  function el(tag, cls, text){ var n = DOC.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
  function txt(id, v){ var n = DOC.getElementById(id); if (n) n.textContent = v }
  function pct(v){ return v == null ? '–' : (Math.round(v * 1000) / 10) + '%' }
  function num(v){ return v == null ? '–' : String(v) }
  function when(at){ if (!at) return '–'; var d = new Date(at);
    var p = function(n){ return String(n).padStart(2, '0') }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) }

  var STATUS_LABEL = {
    ok: '正常', no_related: '确实没有', insufficient_evidence: '证据不够',
    source_missing: '来源丢失', source_conflict: '来源冲突', error: '出错', unknown: '未知'
  }

  function renderStats(s, cov){
    txt('s-total', num(s.total))
    txt('s-total-n', s.total === 0 ? '还没有检索' : ('成功 ' + s.okCount + ' / 失败 ' + s.failCount))
    txt('s-hit', pct(s.hitRate))
    txt('s-hit-n', s.hitCount + ' / ' + s.okCount + ' 次跑完的检索')
    txt('s-zero', num(s.zeroHitCount))
    txt('s-zero-n', s.failCount > 0 ? ('另有 ' + s.failCount + ' 次检索报错') : '没找着相关记忆')
    txt('s-lane', num(s.laneMissCount))
    txt('s-avg', s.timing && s.timing.avg != null ? (Math.round(s.timing.avg) + ' ms') : '–')
    txt('s-avg-n', s.timing && s.timing.p95 != null ? ('p95 ' + s.timing.p95 + ' ms') : '无样本')
    var tv = DOC.getElementById('s-lane')
    if (tv) tv.className = 'stat-v' + (s.laneMissRate != null && s.laneMissRate > 0.2 ? ' bad' : '')
    var hv = DOC.getElementById('s-hit')
    if (hv) hv.className = 'stat-v' + (s.hitRate == null ? '' : (s.hitRate >= 0.6 ? ' good' : (s.hitRate >= 0.3 ? ' warn' : ' bad')))
    if (cov){
      txt('s-touch', cov.touched + ' / ' + cov.totalMemories)
      txt('s-touch-n', cov.neverHit + ' 条从没被查到')
    }
  }

  function renderQuote(ul){
    var v = DOC.getElementById('s-quote')
    if (!ul){ txt('s-quote','–'); txt('s-quote-n','还没有判定记录'); return }
    txt('s-quote', pct(ul.quoteRate))
    var extra = (ul.noHitRetrievals > 0 ? '，另有 ' + ul.noHitRetrievals + ' 次零命中' : '')
    txt('s-quote-n', ul.hitRows === 0
      ? '还没有可判定的命中'
      : (ul.quotedCount + ' / ' + ul.hitRows + ' 条命中被引用原文' + extra))
    if (v) v.className = 'stat-v' + (ul.quoteRate == null ? '' : (ul.quoteRate >= 0.3 ? ' good' : ''))
  }

  function renderBars(days){
    var box = DOC.getElementById('bars'); box.textContent = ''
    if (!days || days.length === 0){ box.appendChild(el('div','empty','窗口内没有检索。')); return }
    var max = 1
    days.forEach(function(d){ if (d.count > max) max = d.count })
    days.forEach(function(d){
      var wrap = el('div','bar')
      var hitH = Math.round((d.hits / max) * 84)
      var zeroH = Math.round((d.zero / max) * 84)
      if (d.hits > 0){ var hi = el('div','bar-i'); hi.style.height = Math.max(2, hitH) + 'px';
        hi.title = d.date + '：命中 ' + d.hits + ' 次'; wrap.appendChild(hi) }
      if (d.zero > 0){ var zi = el('div','bar-i zero'); zi.style.height = Math.max(2, zeroH) + 'px';
        zi.title = d.date + '：零命中 ' + d.zero + ' 次'; wrap.appendChild(zi) }
      if (d.hits === 0 && d.zero === 0){ var em = el('div','bar-i zero'); em.style.height = '2px'; wrap.appendChild(em) }
      var lbl = el('div','bar-x', d.date.slice(5))
      wrap.appendChild(lbl)
      box.appendChild(wrap)
    })
    txt('daily-n', '　共 ' + days.reduce(function(s, d){ return s + d.count }, 0) + ' 次')
  }

  function renderStatus(byStatus, total){
    var box = DOC.getElementById('status-rows'); box.textContent = ''
    var keys = Object.keys(byStatus || {})
    if (keys.length === 0){ box.appendChild(el('div','empty','还没有数据。')); return }
    keys.sort(function(a, b){ return byStatus[b] - byStatus[a] })
    keys.forEach(function(k){
      var row = el('div','r')
      row.appendChild(el('span','r-q', STATUS_LABEL[k] || k))
      row.appendChild(el('span','pill' + (k === 'ok' ? ' ok' : (k === 'no_related' ? '' : ' warn')), k))
      row.appendChild(el('span','r-n', byStatus[k] + ' 次'))
      box.appendChild(row)
    })
  }

  function renderTop(list){
    var box = DOC.getElementById('top-rows'); box.textContent = ''
    if (!list || list.length === 0){ box.appendChild(el('div','empty','还没有检索。')); return }
    list.forEach(function(q){
      var row = el('div','r')
      row.appendChild(el('span','r-q', q.query))
      row.appendChild(el('span','pill' + (q.hits > 0 ? ' ok' : ' bad'), q.hits > 0 ? ('命中 ' + q.hits) : '全零'))
      row.appendChild(el('span','r-n', q.count + ' 次'))
      box.appendChild(row)
    })
  }

  function renderZero(list){
    var box = DOC.getElementById('zero-rows'); box.textContent = ''
    if (!list || list.length === 0){ box.appendChild(el('div','empty','没有零命中。检索都在起作用。')); return }
    list.forEach(function(q){
      var row = el('div','r')
      row.appendChild(el('span','r-q', q.query))
      row.appendChild(el('span','r-n', q.count + ' 次'))
      box.appendChild(row)
    })
  }

  function renderNever(cov){
    var box = DOC.getElementById('never-rows'); box.textContent = ''
    if (!cov){ return }
    // 两个数口径不同，必须各自标注：neverHit 是「从没被查到过的条数」，touchedRate 是「覆盖率」。
    // 并排写成「178 / 218 条，覆盖率 18.3%」会被读成 178/218=18.3%，而 178/218 实际是 81.6%
    // ——两个正确的数放在一起互相打脸。总数为 0 时不给分母，显示 '–' 而不是 NaN。
    var neverShare = (cov.neverHit != null && cov.totalMemories > 0)
      ? (cov.neverHit / cov.totalMemories) : null
    txt('cov-n', '　从没被查到过 ' + cov.neverHit + ' 条（占 ' + pct(neverShare) + '）· 覆盖率 ' + pct(cov.touchedRate))
    var list = cov.neverHitSamples || []
    if (list.length === 0){ box.appendChild(el('div','empty','全部记忆都被查到过，或还没有记忆。')); return }
    list.forEach(function(m){
      var row = el('div','r')
      row.appendChild(el('span','r-q', m.summary || m.memoryId))
      if (m.type) row.appendChild(el('span','pill', m.type))
      if (m.importance != null) row.appendChild(el('span','r-n', '重要度 ' + m.importance.toFixed(2)))
      box.appendChild(row)
    })
  }

  function renderFlow(recent){
    var body = DOC.getElementById('flow-body'); body.textContent = ''
    if (!recent || recent.length === 0){
      var tr = DOC.createElement('tr')
      var td = el('td', 'empty', '还没有检索记录。等我第一次用 brain_search 就会出现。')
      td.colSpan = 6; tr.appendChild(td); body.appendChild(tr); return
    }
    recent.slice().reverse().forEach(function(e){
      var tr = DOC.createElement('tr')
      tr.appendChild(el('td','t', when(e.at)))
      tr.appendChild(el('td','t', e.channel === 'tool' ? '模型' : '控制台'))
      tr.appendChild(el('td','q', e.query || '（空）'))
      tr.appendChild(el('td','t', e.ok === false ? '失败' : String(e.hitCount)))
      var st = DOC.createElement('td')
      st.appendChild(el('span','pill' + (e.status === 'ok' ? ' ok' : ' warn'), STATUS_LABEL[e.status] || e.status || '–'))
      tr.appendChild(st)
      tr.appendChild(el('td','t', e.durationMs != null ? (e.durationMs + ' ms') : '–'))
      body.appendChild(tr)
    })
    txt('flow-n', '　最近 ' + recent.length + ' 条')
  }

  fetch('${usageApi}', { credentials: 'same-origin' })
    .then(function(r){ return r.json() })
    .then(function(d){
      if (!d || !d.ok){
        var box = DOC.getElementById('status-rows')
        if (box){ box.textContent = ''; box.appendChild(el('div','empty', (d && d.message) || '读取失败')) }
        return
      }
      renderStats(d.summary, d.coverage)
      renderQuote(d.usedLater)
      renderBars(d.summary.byDay)
      renderStatus(d.summary.byStatus, d.summary.total)
      renderTop(d.summary.topQueries)
      renderZero(d.summary.zeroHitQueries)
      renderNever(d.coverage)
      renderFlow(d.recent)
    })
    .catch(function(err){
      var box = DOC.getElementById('status-rows')
      if (box){ box.textContent = ''; box.appendChild(el('div','empty','读取失败：' + err.message)) }
    })
})()
</script>
</body>
</html>`
}
