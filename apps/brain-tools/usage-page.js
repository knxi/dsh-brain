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
 * 视觉沿用项目既定语言：near-black 仪器面板、单一琥珀强调、等宽数字、留白克制
 *（2026-11-01 换版：纸感浅色 → 近黑；骨架与 token 收进 theme.js，这页只留图表与列表）。
 * 纪律：这里只呈现事实和候选，不下「该删哪条」的结论——删记忆是不可逆的。
 */

// 骨架统一收在 nav.js：品牌条 + 标题区 + 粘性导航整块是 renderPageHead()，
// 页面只说自己是谁（active）、叫什么（title）、一句话说明（sub）。
import { renderPageHead } from './nav.js?v=1793594997081'

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
/* ── 这一页自己的部分只剩两件事：每日柱的高度、检索流水表的列距 ──
   统计条 / 面板 / 两栏 / 排行行 / 徽章 / 说明条 / 空态 / 柱状图 / 页脚 全在 theme.js
   的组件层里，这里不再复写——v1 那种「每页一份差不多」正是换一次版改不齐的根源。 */

/* 每日柱比通用柱图矮一档（96px）：下面还要挂一行日期标签。
   JS 按 84px 折算柱高（96 − 12px 标签位），改这里要同步改本页脚本里的 84。 */
.bars{height:96px;gap:4px}

/* 检索流水表：列多、行密。用 theme 的 .tbl 打底，这里只压内边距、把查询句提一档。 */
.flow td{padding:7px 10px 7px 0}
.flow th{padding:0 10px 7px 0}
.flow td.q{font-weight:450;color:var(--ink)}

/* 说明条在流式段落之间要留白：theme 的 .note 默认贴边（那是给 panel-foot 内用的），
   这里用两个位置类补间距，不复写 .note 本身。 */
.note-lead{margin:0 0 18px}
.panel-body>.note{margin-top:12px}

/* grid 里的两个面板是并排的，不要 theme 的「相邻面板上下留 16px」（会把右列压下去）。 */
.grid2>.panel+.panel{margin-top:0}
</style>
</head>
<body>
<div class="wrap">
  ${renderPageHead({
    active: 'usage',
    title: '使用情况',
    sub: '最近 ' + days + ' 天的检索行为——它要回答的是「检索到底准不准」，不是「系统活着吗」。'
  })}
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

  <p class="note note-lead" id="quote-note">引用率只统计「回答里出现了命中记忆连续 12 字以上原文」的命中——
    模型改写成自己的话时分辨不出来，所以这是下界，不是全量；判不了的一律记「未判定」，不记「没用上」。</p>

  <div class="grid2">
    <div class="panel">
      <div class="panel-head"><span class="panel-title">每日检索</span><span class="panel-meta" id="daily-n"></span></div>
      <div class="panel-body">
        <div class="bars" id="bars"></div>
        <div class="legend">
          <span><i style="background:var(--accent)"></i>有命中</span>
          <span><i style="background:var(--line)"></i>零命中</span>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><span class="panel-title">诊断分布</span></div>
      <div class="panel-body"><div id="status-rows"></div></div>
    </div>
  </div>

  <div class="grid2">
    <div class="panel">
      <div class="panel-head"><span class="panel-title">最常查的词</span><span class="panel-meta">前 10</span></div>
      <div class="panel-body"><div id="top-rows"></div></div>
    </div>
    <div class="panel">
      <div class="panel-head"><span class="panel-title">零命中查询</span><span class="panel-meta">语料缺口 or 索引问题</span></div>
      <div class="panel-body"><div id="zero-rows"></div></div>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><span class="panel-title">从没被查到过的记忆</span><span class="panel-meta" id="cov-n"></span></div>
    <div class="panel-body">
      <div id="never-rows"></div>
      <p class="note">按重要度从高到低取。重要却一次没被想起，才是真信号；不重要的一次没被想起很正常。
        这里只给候选，不自动清理——删记忆不可逆。</p>
    </div>
  </div>

  <div class="panel">
    <div class="panel-head"><span class="panel-title">最近检索</span><span class="panel-meta" id="flow-n"></span></div>
    <div class="panel-body">
      <table class="tbl flow">
        <thead><tr><th>时间</th><th>通道</th><th>查询</th><th>命中</th><th>诊断</th><th>耗时</th></tr></thead>
        <tbody id="flow-body"><tr><td colspan="6" class="empty">载入中…</td></tr></tbody>
      </table>
    </div>
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
  /**
   * 读失败时把所有区块一次性标成「读不到」。
   *
   * 原来两个失败分支只清 status-rows 一个区块，其余 7 块停在 HTML 里的初始
   * 「载入中…」——那比报错更骗人：人分不清「还在读」和「已经挂了」，会一直等。
   * 这页 8 个区块全来自同一个 /api/usage，一个失败就是全失败，没有「部分成功」。
   */
  function failAll(message){
    var boxes = ['status-rows', 'top-rows', 'zero-rows', 'never-rows', 'bars']
    for (var i = 0; i < boxes.length; i += 1){
      var box = DOC.getElementById(boxes[i])
      if (!box) continue
      box.textContent = ''
      box.appendChild(el('div', 'empty', message))
    }
    // flow-body 是 tbody，不能直接塞 div，得包一行
    var flow = DOC.getElementById('flow-body')
    if (flow){
      flow.textContent = ''
      var tr = DOC.createElement('tr')
      var td = DOC.createElement('td')
      td.className = 'empty'
      td.setAttribute('colspan', '6')
      td.textContent = message
      tr.appendChild(td)
      flow.appendChild(tr)
    }
    // 顶部数字格：一律回到「–」，绝不编 0
    var nums = ['s-total', 's-hit', 's-zero', 's-touch', 's-avg', 's-lane', 's-quote']
    for (var j = 0; j < nums.length; j += 1) txt(nums[j], '–')
    var notes = ['s-total-n', 's-hit-n', 's-zero-n', 's-touch-n', 's-avg-n', 's-quote-n', 'quote-note']
    for (var k = 0; k < notes.length; k += 1) txt(notes[k], message)
  }
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
    if (hv) hv.className = 'stat-v' + (s.hitRate == null ? '' : (s.hitRate >= 0.6 ? ' ok' : (s.hitRate >= 0.3 ? ' warn' : ' bad')))
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
    if (v) v.className = 'stat-v' + (ul.quoteRate == null ? '' : (ul.quoteRate >= 0.3 ? ' ok' : ''))
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
      var row = el('div','rank')
      row.appendChild(el('span','rank-t', STATUS_LABEL[k] || k))
      row.appendChild(el('span','chip' + (k === 'ok' ? ' ok' : (k === 'no_related' ? '' : ' warn')), k))
      row.appendChild(el('span','rank-n', byStatus[k] + ' 次'))
      box.appendChild(row)
    })
  }

  function renderTop(list){
    var box = DOC.getElementById('top-rows'); box.textContent = ''
    if (!list || list.length === 0){ box.appendChild(el('div','empty','还没有检索。')); return }
    list.forEach(function(q){
      var row = el('div','rank')
      row.appendChild(el('span','rank-t', q.query))
      row.appendChild(el('span','chip' + (q.hits > 0 ? ' ok' : ' bad'), q.hits > 0 ? ('命中 ' + q.hits) : '全零'))
      row.appendChild(el('span','rank-n', q.count + ' 次'))
      box.appendChild(row)
    })
  }

  function renderZero(list){
    var box = DOC.getElementById('zero-rows'); box.textContent = ''
    if (!list || list.length === 0){ box.appendChild(el('div','empty','没有零命中。检索都在起作用。')); return }
    list.forEach(function(q){
      var row = el('div','rank')
      row.appendChild(el('span','rank-t', q.query))
      row.appendChild(el('span','rank-n', q.count + ' 次'))
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
      var row = el('div','rank')
      row.appendChild(el('span','rank-t', m.summary || m.memoryId))
      if (m.type) row.appendChild(el('span','chip', m.type))
      if (m.importance != null) row.appendChild(el('span','rank-n', '重要度 ' + m.importance.toFixed(2)))
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
      tr.appendChild(el('td','mono', when(e.at)))
      tr.appendChild(el('td','mono', e.channel === 'tool' ? '模型' : '控制台'))
      tr.appendChild(el('td','q', e.query || '（空）'))
      tr.appendChild(el('td','mono', e.ok === false ? '失败' : String(e.hitCount)))
      var st = DOC.createElement('td')
      st.appendChild(el('span','chip' + (e.status === 'ok' ? ' ok' : ' warn'), STATUS_LABEL[e.status] || e.status || '–'))
      tr.appendChild(st)
      tr.appendChild(el('td','mono', e.durationMs != null ? (e.durationMs + ' ms') : '–'))
      body.appendChild(tr)
    })
    txt('flow-n', '　最近 ' + recent.length + ' 条')
  }

  fetch('${usageApi}', { credentials: 'same-origin' })
    .then(function(r){ return r.json() })
    .then(function(d){
      if (!d || !d.ok){
        failAll((d && d.message) || '读取失败')
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
      failAll('读取失败：' + err.message)
    })
})()
</script>
</body>
</html>`
}
