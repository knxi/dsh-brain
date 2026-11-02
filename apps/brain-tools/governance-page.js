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
 * 视觉沿用项目既定语言：near-black 仪器面板、单一琥珀强调、等宽数字、留白克制
 *（2026-11-01 换版：纸感浅色 → 近黑；骨架与 token 收进 theme.js，这页只留状态卡与表格）。
 * 红只给「需要人现在处理」的状态：隔离生效、备份校验失败、删除失败。
 */

// 导航统一收在 nav.js（顺序与高亮只在那定义一次）。页面只说自己是谁。
// 导航样式已并入 theme.js 的注入区，不再从这里引 NAV_CSS。
import { renderPageHead } from './nav.js?v=1793594997081'

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
/* ── 这一页自己的部分：7420 状态卡 / 统计条 / 表格 / 标签 / 空态 ──
   骨架（底、标题区、路径行、页脚、导航、滚动条、焦点环）全在标记区里，这里不重复。 */

/* 隔离生效时的横幅：整块软底 + 左缘一道状态线。红只给「要人现在处理」的状态。 */
.banner{background:var(--bad-soft);border:1px solid rgba(214,69,69,.20);border-left:2px solid var(--bad);
  border-radius:var(--r-sm);padding:13px 17px;margin-bottom:22px;color:var(--ink);
  font-size:13.5px;line-height:1.7}
.banner strong{font-weight:650;color:var(--bad)}
.banner.hide,.hide{display:none!important}

.card{background:var(--card);border:1px solid var(--line);border-radius:var(--r);
  margin-bottom:18px;overflow:hidden;transition:border-color .14s var(--ease)}
.card:hover{border-color:var(--line)}
.card-head{display:flex;align-items:baseline;gap:10px;padding:13px 20px;
  border-bottom:1px solid var(--line);background:var(--card-2);flex-wrap:wrap}
.card-title{font-size:13px;font-weight:600;color:var(--ink)}
.meta{font-size:11.5px;color:var(--muted);margin-left:auto;font-variant-numeric:tabular-nums}
.body{padding:15px 20px}
.body.tight{padding:0}

/* 状态灯：一枚 7px 小点，不发光。绿=在跑、暗=没起、灰=未知。 */
.lamp{display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--line-2);
  flex:none;align-self:center}
.lamp.on{background:var(--ok)}
.lamp.off{background:var(--faint)}
.lamp.unknown{background:var(--line-2)}
.lamp-text{font-size:12.5px;font-weight:600;color:var(--muted)}
.lamp-text.on{color:var(--ok)}
.lamp-text.off{color:var(--muted)}
.lamp-text.unknown{color:var(--muted)}
.lead{margin:0 0 4px;font-size:13px;line-height:1.75;color:var(--ink-2)}
.lead.dim{color:var(--muted)}
.cmdrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:12px 0 10px}
.cmd{font-family:var(--mono);font-size:12px;background:var(--sunken);padding:8px 12px;
  border-radius:var(--r-sm);color:var(--ink-2);cursor:pointer;border:1px solid var(--line);
  word-break:break-all;line-height:1.5;
  transition:border-color .14s var(--ease),color .14s var(--ease)}
.cmd:hover{border-color:var(--line);color:var(--ink)}
.ghost{height:32px;padding:0 13px;border:1px solid var(--line);border-radius:var(--r-sm);
  background:var(--card);font:inherit;font-size:12.5px;color:var(--ink-2);cursor:pointer;
  transition:border-color .14s var(--ease),background .14s var(--ease),color .14s var(--ease)}
.ghost:hover{border-color:var(--line);background:var(--raise);color:var(--ink)}
.ghost:active{transform:translateY(.5px)}
.openlink{font-size:12.5px;padding:7px 13px;border:1px solid var(--accent-line);
  border-radius:var(--r-sm);background:var(--accent-soft);color:var(--accent);text-decoration:none;
  white-space:nowrap;transition:background .14s var(--ease),border-color .14s var(--ease)}
.openlink:hover{background:rgba(59,91,219,.16);text-decoration:none}
.hint{margin:0;font-size:12px;color:var(--muted);line-height:1.75}

.stats{display:flex;gap:26px;padding:15px 20px;background:var(--card);border:1px solid var(--line);
  border-radius:var(--r);margin-bottom:20px;flex-wrap:wrap}
.stat{display:flex;flex-direction:column;gap:2px;min-width:0}
.stat-k{font-size:10.5px;color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
.stat-v{font-size:19px;font-weight:560;font-family:var(--mono);font-variant-numeric:tabular-nums;
  letter-spacing:-.01em;color:var(--ink);line-height:1.3}
.stat-v.bad{color:var(--bad)}
.stat-v.ok{color:var(--ok)}
.stat-v.small{font-size:12.5px;font-weight:450;color:var(--ink-2)}
.lgrid{display:flex;gap:34px;flex-wrap:wrap}
.lgrid .stat-v.small{max-width:420px;word-break:break-all}

.tbl{width:100%;border-collapse:collapse}
.tbl th{font-size:10.5px;color:var(--muted);text-align:left;font-weight:550;letter-spacing:.08em;
  text-transform:uppercase;padding:9px 20px;border-bottom:1px solid var(--line);
  background:var(--card-2);white-space:nowrap}
.tbl td{padding:11px 20px;border-bottom:1px solid var(--line);vertical-align:top;font-size:12.5px;
  color:var(--ink-2)}
.tbl tr:last-child td{border-bottom:none}
.tbl .num{font-family:var(--mono);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.tbl .when{white-space:nowrap;color:var(--ink);font-family:var(--mono);font-size:11.5px;
  font-variant-numeric:tabular-nums}
.subline{font-size:11px;color:var(--faint);word-break:break-all;line-height:1.6;margin-top:3px;
  font-family:var(--mono)}

.tag{display:inline-block;font-size:10.5px;padding:1.5px 7px;border-radius:4px;font-weight:550;
  font-family:var(--mono);letter-spacing:.01em;white-space:nowrap;line-height:1.6}
.tag.ok{background:var(--ok-soft);color:var(--ok)}
.tag.bad{background:var(--bad-soft);color:var(--bad)}
.tag.warn{background:var(--warn-soft);color:var(--warn)}
.tag.plain{background:var(--raise);color:var(--muted)}
code.copy{font-family:var(--mono);font-size:11px;background:var(--raise);padding:2px 6px;
  border-radius:4px;cursor:pointer;color:var(--ink-2);word-break:break-all;
  transition:background .14s var(--ease),color .14s var(--ease)}
code.copy:hover{background:var(--accent-soft);color:var(--accent)}

.empty{padding:44px 22px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}
.empty strong{display:block;color:var(--ink);font-size:14px;font-weight:600;margin-bottom:6px}
.empty.miss strong{color:var(--warn)}
.body.tight .hint{margin:0;padding:10px 20px 14px}
.diag{margin:0 0 20px;padding:11px 16px;border-radius:var(--r-sm);font-size:13px;
  background:var(--card);border:1px solid var(--line);border-left:2px solid var(--line-2);line-height:1.7}
.diag.bad{border-left-color:var(--bad);background:var(--bad-soft);color:var(--ink)}

.note{font-size:12px;color:var(--muted);margin-top:22px;padding:13px 17px;
  border-left:2px solid var(--line);line-height:1.85}
.note b{color:var(--ink);font-weight:600}
</style>
</head>
<body>
<div class="wrap">
  ${renderPageHead({
    active: 'governance',
    title: '治理视图',
    sub: '只读 · 看状态，不做写操作。写操作要回 7420 治理面板。'
  })}
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
  // resultTag 删掉了（2026-11-02）：它渲染的 d.result 接口从来没返回过，
  // 那一列于是恒为「–」。那列已换成账本里真有的「原因 / 凭证」，这段跟着失去消费者。

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
    // 第四列原来是「结果」，读 d.result —— 但删除账本是 append-only 的审计链，
    // 条目里只有「谁在何时申请删了什么、为什么、拿到哪张凭证」，**没有执行结果**。
    // 接口从来没返回过 result，所以那一列恒为「–」，tooltip 永远是「接口没有返回 result」。
    // 与其留一个永远空的列，不如换成账本里真有的两个字段：原因、凭证。
    table.appendChild(tableHead(['时间', '记忆 ID', '操作者', '原因', '凭证']))
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
      tr.appendChild(el('td', null, d.reason === null || d.reason === undefined || d.reason === '' ? '–' : String(d.reason)))
      var tdTomb = el('td')
      var tomb = d.tombstoneId === null || d.tombstoneId === undefined ? '' : String(d.tombstoneId)
      tdTomb.appendChild(copyCode(tomb, shortId(tomb) || '–'))
      tr.appendChild(tdTomb)
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
