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
import { renderPageHead } from './nav.js?v=1793594997081'
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
/* ── 这一页只剩四件 theme 没覆盖的事 ──
   统计条 / 检索行 / 列表 / 标签 / 分页按钮 的样式全在 theme.js 的组件层里，
   页面不再复写。v1 那种「每页一份差不多」正是换一次版改不齐的根源。 */

/* 诊断条：左缘一道 2px 状态线，比整块换底色克制 */
.diag{margin:0 0 14px;padding:10px 14px;border-radius:var(--r-sm);font-size:13px;
  background:var(--card);border:1px solid var(--line);border-left:2px solid var(--line);
  line-height:1.6;box-shadow:0 1px 2px rgba(23,32,60,.04)}
.diag.warn{border-left-color:var(--warn);background:var(--warn-soft);color:#9a5f0d}
.diag.bad{border-left-color:var(--bad);background:var(--bad-soft);color:#a03c3c}

/* 记忆行沿用自己的类名（JS 里拼的是 summary / id），映射到 theme 的行排版 */
.summary{font-size:13px;flex:1;min-width:0;color:var(--ink-2);line-height:1.6}
.row:hover .summary,.row.is-selected .summary{color:var(--ink)}
.id{font-family:var(--mono);font-size:10px;color:var(--faint);flex:none}

/* 分页条：压小一档，让它待在列表底下不抢戏 */
.pager{display:flex;gap:8px;align-items:center;margin-top:14px;flex-wrap:wrap}
.pg-info{font-family:var(--mono);font-size:11.5px;color:var(--muted);
  font-variant-numeric:tabular-nums;min-width:186px;text-align:center}
.pg-size{font-size:11.5px;color:var(--muted);display:flex;align-items:center;gap:7px;margin-left:auto}
.pg-size .select{height:32px}

/* 翻页时把上一页的行压暗而不是清空——整块闪一下看着像页面崩了 */
.list.loading{opacity:.55}
.empty button{margin-top:14px}
.spin{display:inline-block;width:12px;height:12px;border:1.5px solid var(--line);
  border-top-color:var(--accent);border-radius:50%;animation:s .7s linear infinite;vertical-align:-2px}
@keyframes s{to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div class="wrap">
  ${renderPageHead({
    active: 'memory',
    title: '记忆',
    sub: 'DSH · explicit 模式，只挂显式工具。每条记忆都得说清来源、第几版、什么时候有效、多确定。'
  })}
  <div class="path">${escapedDbPath}</div>

  <div class="stats" id="stats">
    <div class="stat"><span class="stat-k">记忆</span><span class="stat-v" id="s-mem">–</span></div>
    <div class="stat"><span class="stat-k">实体</span><span class="stat-v" id="s-ent">–</span></div>
    <div class="stat"><span class="stat-k">检索</span><span class="stat-v" id="s-usage">–</span></div>
    <div class="stat"><span class="stat-k">索引</span><span class="stat-v" id="s-idx">–</span></div>
  </div>

  <div id="alert"></div>

  <div class="searchbar">
    <input class="input" type="search" id="q" placeholder="搜记忆：中文、尺寸、图号、代码标识符都行"
      autocomplete="off" spellcheck="false">
    <button class="btn btn--primary" id="go">检索</button>
    <button class="btn" id="all">全部</button>
  </div>

  <div id="diag"></div>
  <div class="list" id="list"><div class="empty">正在载入…</div></div>

  <div class="pager" id="pager">
    <button class="btn btn--sm" id="prev" disabled>← 上一页</button>
    <span class="pg-info" id="pg-info">–</span>
    <button class="btn btn--sm" id="next" disabled>下一页 →</button>
    <label class="pg-size">每页
      <select class="select" id="pg-size">
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