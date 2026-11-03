// @ts-check
/**
 * 外置大脑 · 心海（3D 记忆海）
 *
 * 视觉与三维算法思路来自 asdfd3/3d-memory-sea（MIT License，见文件末尾版权声明）：
 *   斐波那契球面布簇、yaw/pitch 旋转透视投影、按深度排序遮挡、Canvas 2D 渲染。
 *
 * **交互骨架参考 Stellaris（群星）**，取它最有用的五个设计：
 *   1. 地图模式（Map Modes）—— 同一份数据，不同视角着色。这里做四种：类型 / 重要度 / 时间 / 来源
 *   2. 左侧常驻边栏 —— 筛选与导航，不占主视图
 *   3. 右侧上下文面板 —— 点选后出现，讲清这一颗星是什么
 *   4. 顶部状态条 —— 常驻统计 + 当前模式，不用点进去看
 *   5. 底部上下文工具栏 —— 选中对象后才出现针对它的操作
 * 另加 hover 即时反馈（悬停高亮邻居 + 浮出摘要），这是群星最舒服的地方。
 *
 * 为什么不全抄游戏：群星有几十个面板，那是策略游戏需要的信息密度。
 * 心海只需要「看清记忆、找到关联、读懂一颗星」，多一个常驻面板都是负担。
 */

// 导航统一收在 nav.js（导航项与顺序只在那定义一次）。
// 心海是近黑底全屏页，导航样式就地写在下面 <style> 里——不引 nav.js 的 CSS：
// 页面内部的静态 import 不随页面热重载失效，改 nav.js 的样式会看不到（见 <style> 里的说明）。
import { renderPageHead } from './nav.js?v=1793594997081'

export function renderSeaPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>心海 · 外置大脑</title>
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

/* ══ 心海 v3「视窗」══
   v2 是全屏仪器：画布铺满整个窗口，标题和统计只能浮在渐隐层上。
   v3 把它收进一张圆角卡片——页面回到正常的浅色文档流（标题 / 统计条 / 视窗 / 说明），
   深空只活在里面那一块。

   这么改不只是为了好看：全屏画布下，画布的坐标基准是 innerWidth/innerHeight，
   而视窗内的 HUD（顶部条、左右栏、底部提示）全靠 --chrome-h 这个量出来的变量避让，
   标题说明多折一行整组 HUD 就错位。收进卡片后视窗有确定的矩形边界，
   canvas 的投影中心改成视窗自己的宽高，页面布局怎么变都不影响三维画面。 */

/* 统计条：四格白卡，label 走英文代号 + 中文注，数值是等宽大字。
   下边距原来写 0，白卡跟下面的深空面板直接贴死，两块不同材质的块黏成一片、
   谁也读不出边界。给 18px 呼吸（跟 .stats 的默认下边距同值），别让他们粘连。 */
.stats--sea{margin:14px 0 18px}
.stats--sea .stat{padding:11px 20px;gap:2px}
.stats--sea .stat-k{display:flex;align-items:baseline;gap:6px;font-size:10px;color:var(--muted);
  letter-spacing:.04em;white-space:nowrap}
.stats--sea .stat-k i{font:500 8.5px var(--mono);font-style:normal;letter-spacing:.16em;
  color:var(--faint);text-transform:uppercase}
.stats--sea .stat-v{font-size:1.5rem;line-height:1.3}
.stats--sea .stat-v.ok{color:#17915c}

/* 视窗本体：深空卡片。
   高度策略：**上限贴着「一屏刚好放得下」定**。
   骨架（品牌条 + 标题 + 导航 + 统计条 + 内边距）压到约 380px，900px 高的窗口里
   剩下的 520 只是 flex 分出来的残余——那样黑框占屏 58%，星云被压成一条。
   改成 min-height:580 之后 flex 不再起作用，视窗固定吃 580（占屏约 64%），
   整页高度刚好落在一屏内，既没有滚动条，也比初版的 450 大了近三成。
   （窗口更高时 flex 会继续把它撑满。） */
body.sea-page .wrap{display:flex;flex-direction:column;min-height:100vh;
  padding:14px clamp(20px,3.5vw,44px) 18px}
body.sea-page .wrap>*{flex:none}
body.sea-page .brandbar{min-height:44px;padding-bottom:11px}
body.sea-page .head{margin-top:12px}
body.sea-page h1{font-size:clamp(1.85rem,2.6vw,2.2rem)}
body.sea-page .nav{margin-top:14px}
.viewport{position:relative;flex:1 1 auto;min-height:580px;margin:0;border-radius:16px;overflow:hidden;
  background:radial-gradient(ellipse 92% 74% at 50% 40%,#0c1322 0%,#070c16 52%,#04060c 100%);
  border:1px solid #1a2540;
  box-shadow:0 26px 64px -30px rgba(13,21,44,.62),inset 0 1px 0 rgba(120,170,255,.06)}
/* 四周暗角：星云往中间收，卡片边缘不散成一圈亮点 */
.viewport::after{content:"";position:absolute;inset:0;z-index:1;pointer-events:none;
  background:radial-gradient(ellipse 86% 80% at 50% 46%,transparent 44%,rgba(3,6,12,.46) 100%)}
#sea{display:block;position:relative;z-index:0;cursor:grab;touch-action:none}
#sea.dragging{cursor:grabbing}

/* HUD：整层不吃事件，只有真正的控件吃 */
.vp-hud{position:absolute;inset:0;z-index:2;pointer-events:none;font-family:var(--mono)}
.vp-hud>*{pointer-events:auto}
.vp-tl{position:absolute;top:15px;left:17px;display:flex;flex-direction:column;gap:10px;
  align-items:flex-start;pointer-events:none}
.vp-tl>*{pointer-events:auto}
.vp-tr{position:absolute;top:15px;right:17px;display:flex;flex-direction:column;gap:10px;
  align-items:flex-end;pointer-events:none}
.vp-tr>*{pointer-events:auto}

.vp-live{display:flex;align-items:center;gap:8px;font:9.5px var(--mono);
  letter-spacing:.2em;color:#7f9dbe;pointer-events:none}
.vp-live i{width:5px;height:5px;border-radius:50%;background:#5ee6ff;
  box-shadow:0 0 8px rgba(94,230,255,.85);animation:sea-blink 2.4s infinite}
.vp-live b{font-size:8px;font-weight:500;letter-spacing:.14em;color:#5ee6ff;
  padding:1px 6px;border-radius:3px;border:1px solid rgba(94,230,255,.32);
  background:rgba(94,230,255,.10)}
@keyframes sea-blink{50%{opacity:.3}}

/* 模式切换 + 筛选开关：一排贴在 LIVE 下面 */
.vp-tlrow{display:flex;gap:6px;align-items:center}
.vp-modes{display:flex;gap:2px;padding:3px;border-radius:8px;background:rgba(8,14,28,.74);
  border:1px solid rgba(110,160,235,.16);backdrop-filter:blur(12px)}
.mode{font:10px var(--mono);letter-spacing:.04em;padding:5px 9px;border-radius:6px;cursor:pointer;
  color:#7a93b2;background:transparent;border:none;transition:all .16s;white-space:nowrap}
.mode:hover{color:#cfe0f2}
.mode.on{background:rgba(94,230,255,.13);color:#7ceaff;box-shadow:inset 0 0 0 1px rgba(94,230,255,.28)}

/* 视窗里的按钮：深底窄边，跟白昼外壳的 .btn 是两套，别互相污染 */
.btn{font:10px var(--mono);letter-spacing:.04em;padding:6px 11px;border-radius:7px;cursor:pointer;
  border:1px solid rgba(110,160,235,.22);background:rgba(8,14,28,.74);color:#8fa9c6;
  transition:all .16s;backdrop-filter:blur(12px)}
.btn:hover{color:#bfe6ff;border-color:rgba(94,230,255,.45);background:rgba(94,230,255,.08)}
.btn.on{color:#7ceaff;border-color:rgba(94,230,255,.52);background:rgba(94,230,255,.12)}
.vp-actions{display:flex;gap:6px}
.vp-depth{font:8px var(--mono);letter-spacing:.18em;color:#546e8c;text-align:right;line-height:1.4}
.vp-depth b{display:block;font-size:13px;font-weight:500;letter-spacing:0;color:#8fa9c6;margin-top:2px}

/* 筛选面板：默认收起，点「筛选」才从左滑出——默认视图要干净 */
#side{position:absolute;top:96px;left:17px;bottom:52px;width:200px;z-index:4;
  display:flex;flex-direction:column;gap:9px;overflow-y:auto;padding-right:2px;
  transform:translateX(-124%);opacity:0;pointer-events:none;
  transition:transform .26s var(--ease-out),opacity .2s}
#side.open{transform:none;opacity:1;pointer-events:auto}
#side::-webkit-scrollbar{width:4px}
#side::-webkit-scrollbar-thumb{background:rgba(120,170,255,.2);border-radius:2px}
.card{padding:11px 12px;border-radius:9px;background:rgba(7,12,24,.86);
  border:1px solid rgba(110,160,235,.16);backdrop-filter:blur(14px)}
.card h3{margin:0 0 7px;font:8.5px var(--mono);letter-spacing:.18em;text-transform:uppercase;color:#4c6684}
.item{display:flex;align-items:center;gap:8px;padding:3.5px 0;cursor:pointer;
  font-size:11px;color:#8aa9c4;transition:color .13s;user-select:none}
.item:hover{color:#c6d8ea}
.item.off{opacity:.32}
.dot{width:7px;height:7px;border-radius:50%;flex:none}
.item .n{margin-left:auto;font:9.5px var(--mono);color:#4c6684;font-variant-numeric:tabular-nums}
#q{width:100%;padding:6px 8px;border-radius:6px;font-size:11px;font-family:var(--mono);
  border:1px solid rgba(110,160,235,.18);background:rgba(4,9,20,.72);color:#c6d8ea;outline:none}
#q:focus{border-color:rgba(94,230,255,.5)}
#q::placeholder{color:#3c5a78}

/* 右下 NODE INSPECTOR：空态给说明，选中后原地变成 FOCUS 卡片。
   高度一律按内容自适应（max-height 兜底），不写 top——
   参考视频里聚焦态的卡片很矮，只讲「这是哪一条、分类、重要度、几条关联」，
   完整正文收进折叠区。面板一旦撑满右半屏，它挡住的正好是你在看的那片关系。 */
.vp-inspector{position:absolute;right:17px;bottom:44px;width:264px;max-height:calc(100% - 110px);
  display:flex;flex-direction:column;padding:12px 14px;border-radius:11px;
  background:rgba(7,12,24,.86);border:1px solid rgba(110,160,235,.18);
  backdrop-filter:blur(16px);box-shadow:0 18px 44px -20px rgba(3,7,16,.9);
  transition:border-color .2s,box-shadow .2s}
.vp-inspector.show{border-color:rgba(94,230,255,.34);
  box-shadow:0 0 0 1px rgba(94,230,255,.10),0 22px 52px -22px rgba(3,7,16,.95)}
.insp-k{font:8.5px var(--mono);letter-spacing:.2em;color:#5e7a9c;margin-bottom:8px}
.insp-empty p{margin:0;font-size:11px;line-height:1.8;color:#7f9dbe}
.insp-meta{display:flex;justify-content:space-between;margin-top:11px;padding-top:9px;
  border-top:1px solid rgba(110,160,235,.12);font:8px var(--mono);letter-spacing:.12em;color:#3f5875}
.vp-inspector.show .insp-empty{display:none}

/* 聚焦卡片头：FOCUS · mem_xxxxxx（跟参考视频右下那块一致） */
.focus-head{display:flex;align-items:center;gap:6px;margin-bottom:8px;
  font:8.5px var(--mono);letter-spacing:.18em;color:#5e7a9c}
.focus-head b{color:#7ceaff;font-weight:500;letter-spacing:.06em}
/* 一行元信息替代原来的一整列 key-value 表：重要度 · 关联数 · 类型 */
.focus-meta{margin-top:9px;padding-top:9px;border-top:1px solid rgba(110,160,235,.12);
  font:9.5px var(--mono);color:#7b93b0;letter-spacing:.04em;line-height:1.7}
.focus-meta b{color:#a8c6e2;font-weight:500}
.focus-meta i{font-style:normal;color:#3f5875;margin:0 6px}

#detail{display:none;flex-direction:column;min-height:0;overflow-y:auto;overflow-x:hidden;position:relative}
.vp-inspector.show #detail{display:flex}
#detail::-webkit-scrollbar{width:4px}
#detail::-webkit-scrollbar-thumb{background:rgba(120,170,255,.2);border-radius:2px}
/* 关闭键绝对定位在面板右上：v3 里 #detail 是 flex 容器，float:right 在 flex 里不生效，
   v2 那套 float 写法会让 ✕ 掉到左上角去。 */
#detail .x{position:absolute;top:-2px;right:-2px;cursor:pointer;color:#4c6684;
  font-size:14px;line-height:1;padding:1px 4px}
#detail .x:hover{color:#c6d8ea}
#detail h2{font-size:12.5px;font-weight:500;margin:0 0 8px;color:#d9e6f2;line-height:1.5;padding-right:22px}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:10px}
.chip{font:9.5px var(--mono);padding:2px 7px;border-radius:4px;background:rgba(120,170,255,.13);color:#8aa9c4}
.chip.warn{background:rgba(224,106,92,.16);color:#e08a7a}
.body{font-size:11.5px;color:#a9b8cd;line-height:1.75;white-space:pre-wrap;word-break:break-word;
  max-height:210px;overflow-y:auto;overflow-x:hidden;margin-bottom:10px;min-width:0}
.row{display:grid;grid-template-columns:58px minmax(0,1fr);gap:8px;padding:3.5px 0;
  border-bottom:1px solid rgba(110,160,235,.08);font-size:11px}
.row:last-child{border-bottom:none}
.k{color:#4c6684}
.v{color:#a9b8cd;font-family:var(--mono);word-break:break-all;min-width:0}
/* 详情里的按钮行：跟在详情后面，不再浮在页面底部中央 */
#ctx{display:none;flex-wrap:wrap;gap:6px;margin-top:10px;padding-top:10px;
  border-top:1px solid rgba(110,160,235,.12)}
#ctx.show{display:flex}
#tip{position:absolute;z-index:6;pointer-events:none;display:none;max-width:266px;
  padding:7px 10px;border-radius:7px;font-size:11px;line-height:1.55;color:#c6d8ea;
  background:rgba(5,12,26,.97);border:1px solid rgba(110,160,235,.24);
  box-shadow:0 10px 28px -8px rgba(3,7,16,.9)}
#tip.show{display:block}
#tip b{color:#e6edf7}
#error{position:absolute;inset:0;display:none;place-items:center;color:#e08a7a;z-index:7;
  font-size:12px;background:rgba(4,6,12,.94);padding:40px;text-align:center}
#empty{position:absolute;inset:0;display:none;place-items:center;z-index:5;pointer-events:none;
  color:#4c6684;font-size:13px;text-align:center;line-height:2}
#empty.show{display:grid}

/* 左下角图例 + 底部中央的计数行 + 右下角操作提示 */
.vp-legend{position:absolute;left:17px;bottom:46px;display:flex;flex-direction:column;gap:2px;
  font:9px var(--mono);color:#6b85a4}
.vp-core{position:absolute;left:50%;bottom:14px;transform:translateX(-50%);text-align:center;
  pointer-events:none;white-space:nowrap;padding:5px 18px;
  background:radial-gradient(ellipse 50% 110% at 50% 50%,rgba(4,7,14,.78),transparent 74%);
  text-shadow:0 1px 8px #04060c,0 0 3px #04060c}
.vp-core-k{font:8px var(--mono);letter-spacing:.34em;color:#4a6788}
.vp-core-v{font:8.5px var(--mono);letter-spacing:.12em;color:#6d8bab;margin-top:3px}
.vp-core-v b{color:#bcd8f0;font-weight:500}
.vp-hint{position:absolute;right:13px;bottom:10px;max-width:340px;text-align:right;
  font:7.5px var(--mono);letter-spacing:.05em;color:#44618a;line-height:1.8;pointer-events:none;
  padding:5px 8px;border-radius:6px;
  background:radial-gradient(ellipse 70% 120% at 80% 60%,rgba(4,7,14,.72),transparent 78%);
  text-shadow:0 1px 6px #04060c}

/* 图例 / 背景开关 / 关系标签：结构不动，只是从左侧栏搬到了视窗左下角 */
.rel{display:flex;align-items:center;gap:8px;padding:2px 0;font-size:9.5px;color:#7b93b0}
.rel i{flex:none;width:20px;height:0;border-top-style:solid;border-top-width:2px}
.rel i.dash{border-top-style:dashed}
.rel i.thin{border-top-width:1px}
.rel .n{margin-left:auto;font:9px var(--mono);color:#4c6684;font-variant-numeric:tabular-nums}
.rel-note{font-size:9.5px;color:#4c6684;line-height:1.65;margin-top:7px;
  border-top:1px solid rgba(110,160,235,.1);padding-top:7px}
.sw{flex:none;width:24px;height:13px;border-radius:7px;background:rgba(110,160,235,.16);
  position:relative;transition:background .15s}
.sw::after{content:'';position:absolute;top:2px;left:2px;width:9px;height:9px;border-radius:50%;
  background:#7e97b4;transition:left .15s,background .15s}
.sw.on{background:rgba(94,230,255,.42)}
.sw.on::after{left:13px;background:#5ee6ff}
.reltag{display:inline-block;font:9.5px var(--mono);padding:2px 7px;border-radius:4px;margin-bottom:9px;
  border:1px solid currentColor}
.pair{display:grid;grid-template-columns:1fr;gap:6px;padding:9px 0;margin-bottom:9px;
  border-top:1px solid rgba(110,160,235,.1);border-bottom:1px solid rgba(110,160,235,.1)}
.pair .side{font-size:11px;color:#a9b8cd;line-height:1.6}
.pair .end{font-size:9px;color:#4c6684;letter-spacing:.06em;margin-bottom:2px}

/* 视窗下方的说明段已在 v3.1 撤掉：内容跟标题右侧的 sub 重复，
   而它占的高度正是视窗需要的那一档 */

@media(prefers-reduced-motion:reduce){
  *,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;
    transition-duration:.01ms!important}
  .vp-live i{animation:none}
}
@media(max-width:1024px){
  .viewport{min-height:540px}
  .vp-inspector{width:262px}
}
@media(max-width:900px){
  #side{display:none}
  .vp-inspector{width:min(280px,calc(100% - 34px))}
  .vp-legend{display:none}
  .vp-core{display:none}
  .vp-hint{display:none}
}
</style>
</head>
<body class="sea-page">
<div class="wrap wrap--wide">
  ${renderPageHead({
    active: 'sea',
    title: '心海',
    sub: '把全库记忆映射成可探索的三维神经网络：位置是语义簇，连线是真实关系边。'
  })}

  <div class="stats stats--sea">
    <div class="stat"><span class="stat-k"><i>NEURONS</i>/ 神经节点</span><span class="stat-v num" id="statNodes">—</span></div>
    <div class="stat"><span class="stat-k"><i>SYNAPSES</i>/ 突触连接</span><span class="stat-v num" id="statEdges">—</span></div>
    <div class="stat"><span class="stat-k"><i>CLUSTERS</i>/ 语义簇</span><span class="stat-v num" id="statClusters">—</span></div>
    <div class="stat"><span class="stat-k"><i>FIELD STATUS</i>/ 网络状态</span><span class="stat-v ok" id="statStatus">同步中</span></div>
  </div>

  <section class="viewport" id="viewport" aria-label="三维记忆海">
    <canvas id="sea"></canvas>

    <div class="vp-hud">
      <div class="vp-tl">
        <div class="vp-live"><i></i><span>记忆场</span><b>实时</b></div>
        <div class="vp-tlrow">
          <div class="vp-modes" id="modes">
            <button class="mode on" data-mode="type">类型</button>
            <button class="mode" data-mode="weight">重要度</button>
            <button class="mode" data-mode="time">时间</button>
            <button class="mode" data-mode="origin">来源</button>
          </div>
          <button class="btn" id="btnFilter" aria-expanded="false">筛选</button>
        </div>
      </div>

      <div class="vp-tr">
        <div class="vp-depth">视野深度<b id="statDepth">1.00×</b></div>
        <div class="vp-actions">
          <button class="btn" id="btnSpin">自动旋转</button>
          <button class="btn" id="btnReset">重置视角</button>
        </div>
      </div>

      <aside id="side">
        <div class="card">
          <h3>关系</h3>
          <div class="item" id="bgToggle">
            <span class="sw" id="bgSw"></span>
            <span>同簇相邻（背景）</span>
            <span class="n" id="bgCount">—</span>
          </div>
          <div class="rel-note" id="relNote"></div>
        </div>
        <div class="card">
          <h3>类型</h3>
          <div id="filterType"></div>
        </div>
        <div class="card">
          <h3>来源</h3>
          <div id="filterOrigin"></div>
        </div>
        <div class="card">
          <h3>检索</h3>
          <input id="q" placeholder="摘要关键词" autocomplete="off" spellcheck="false">
          <button class="btn" id="btnRecent" style="margin-top:8px;width:100%">只看最近</button>
        </div>
      </aside>

      <div class="vp-legend" id="legend"></div>

      <div class="vp-core">
        <div class="vp-core-k" id="coreK">语义核心</div>
        <div class="vp-core-v" id="coreV"><b id="cntActive">—</b> 活跃节点 / <b id="cntClusters">—</b> 语义簇</div>
      </div>

      <aside class="vp-inspector" id="inspector">
        <div class="insp-empty" id="inspEmpty">
          <div class="insp-k">节点检视</div>
          <p>点击任意神经节点，放大并查看它的直接关联；点空白处退出聚焦。</p>
          <div class="insp-meta"><span>三维投影</span><span>实时</span></div>
        </div>
        <div id="detail"></div>
        <div id="ctx"></div>
      </aside>

      <div class="vp-hint">DRAG TO ROTATE · SCROLL TO ZOOM · CLICK NODE TO FOCUS · EMPTY SPACE TO EXIT</div>
    </div>

    <div id="tip"></div>
    <div id="error"></div>
    <div id="empty">还没有记忆。<br>让外置大脑记点东西，心海就会亮起来。</div>
  </section>
</div>
<script>
(() => {
  const canvas = document.getElementById('sea')
  const g = canvas.getContext('2d')
  const viewport = document.getElementById('viewport')
  const elDetail = document.getElementById('detail')
  const elCtx = document.getElementById('ctx')
  const elTip = document.getElementById('tip')
  const elError = document.getElementById('error')
  const elEmpty = document.getElementById('empty')
  const elInspector = document.getElementById('inspector')
  const elDepth = document.getElementById('statDepth')
  const elSide = document.getElementById('side')

  /**
   * 视窗逻辑尺寸（CSS 像素）。
   *
   * v2 是全屏画布，投影中心直接用 innerWidth/2、innerHeight/2；v3 画布收进了卡片，
   * 中心点必须是**视窗自己的**中心。这两个变量每帧绘制、拾取、浮窗定位都用它，
   * 一处真源——不要再在任何地方直接摸 innerWidth。
   */
  let VW = 1
  let VH = 1

  const KIND = {
    semantic:     { label: '事实', color: [110, 168, 255] },
    profile:      { label: '偏好', color: [ 89, 227, 255] },
    commitment:   { label: '约定', color: [139, 124, 246] },
    episode:      { label: '经历', color: [180, 140, 242] },
    skill:        { label: '方法', color: [ 76, 195, 230] },
    self:         { label: '自省', color: [169, 184, 255] },
    relationship: { label: '关系', color: [209, 143, 255] },
    boundary:     { label: '边界', color: [140, 160, 200] },
  }
  const ORIGIN = {
    dsh:     { label: '手记', color: [ 89, 227, 255] },
    engram:  { label: '迁入', color: [110, 168, 255] },
    brain:   { label: '自省', color: [180, 140, 242] },
    lingshu: { label: '灵枢', color: [139, 124, 246] },
  }
  const FALLBACK = [140, 160, 200]
  /**
   * 类型 → 英文代号。
   *
   * 参考视频里节点标签是「mem_e8b9b9 · EMOTION」这种「短 id + 全大写类别」的形态：
   * 信息量刚好够认出「这是哪条、属于哪类」，又不至于像摘要那样占掉半个屏幕。
   * 这里给八个类型各配一个代号，标签用它；中文名仍用于簇标签（事实 / 偏好 …）。
   */
  /**
   * 类型 → 节点标签用的短名。
   *
   * 2026-11-02 改：原来是 SEMANTIC / PREFERENCE 这套英文代号，照着某个参考视频的
   * 「mem_e8b9b9 · EMOTION」形态抄的。主人一眼看过去问「这英文正常吗」——
   * 不正常的是设计，不是显示：这是中文记忆库，节点类别没有理由用英文。
   * 现在直接用 KIND 里的中文名，量级也够短（两字，比 SEMANTIC 还省空间）。
   */
  const TYPE_CODE = {
    semantic: '事实',
    profile: '偏好',
    commitment: '约定',
    episode: '经历',
    skill: '方法',
    self: '自省',
    relationship: '关系',
    boundary: '边界',
  }
  const codeOfType = (t) => TYPE_CODE[t] || '其它'
  /** 节点短 id：「mem_e8b9b9」那种长度，够用且要能对上详情面板里的完整 ID。 */
  const shortId = (id) => {
    const s = String(id || '')
    return s.length > 11 ? s.slice(0, 11) : s
  }
  // ── 关系边的语义表 ───────────────────────────────────────────
  // kind 只有这五种：四种真实关系（supersedes / contradicts / supports / refines）
  // 加一种背景近似连线（topic）。线的颜色、线型、粗细、透明度全从这里取，
  // 图例也是照这张表生成的——只有一处真源，不会出现「图例说红的，画出来是紫的」。
  //   contradicts 必须最显眼：这是全项目唯一「需要人现在处理」的状态。
  //   supersedes 与 contradicts 必须能一眼分开：一个是「后来改了」，一个是「两条打架」。
  const REL = {
    contradicts: { label: '矛盾', color: [224, 106, 92], dash: [6, 4], weight: 1.0, alpha: 0.9,
      hint: '两条记忆的说法冲突，需要人来核验' },
    supersedes: { label: '取代', color: [210, 154, 86], dash: null, weight: 0.8, alpha: 0.72,
      hint: '后一条替代了前一条' },
    supports: { label: '佐证', color: [150, 168, 192], dash: null, weight: 0.5, alpha: 0.42,
      hint: '两条互相印证' },
    refines: { label: '细化', color: [150, 168, 192], dash: [2, 3], weight: 0.5, alpha: 0.38,
      hint: '一条是另一条的更细说明' },
    topic: { label: '同簇相邻', color: [104, 122, 148], dash: [2, 4], weight: 0.3, alpha: 0.22,
      hint: '只是同类型、时间相邻，不是真实关系（背景参考）' },
  }
  // 图例顺序：从最该看见的往下排。背景不参与图例计数，单独一行。
  const REL_LEGEND = ['contradicts', 'supersedes', 'supports', 'refines']
  // 绘制顺序：弱边先画、强边后画，矛盾永远压在最上面。
  const REL_DRAW_ORDER = ['refines', 'supports', 'supersedes', 'contradicts']
  const relOf = (kind) => REL[kind] || REL.topic
  const edgeKey = (edge) => edge.edgeId || (edge.a + '>' + edge.b + ':' + edge.kind)
  /** 摘要截断：tip 里两端摘要都要短，否则浮窗横出一条盖住画面 */
  const cut = (text, n) => {
    const s = String(text == null ? '' : text)
    return s.length > n ? s.slice(0, n) + '…' : s
  }
  const colorOfType = (t) => (KIND[t] || {}).color || FALLBACK
  const labelOfType = (t) => (KIND[t] || {}).label || t || '其他'
  const colorOfOrigin = (o) => (ORIGIN[o] || {}).color || FALLBACK
  const labelOfOrigin = (o) => (ORIGIN[o] || {}).label || o || '其他'

  let points = []
  let edges = []
  // 背景弱边（同簇相邻）：默认不画，打开开关才画。
  // 它跟真实关系边分开存，是为了让「关联数」「邻居数」「聚焦范围」这些
  // 都只算真关系——背景线不该让人以为两条记忆真有关系。
  let backgroundEdges = []
  let showBackground = false
  let edgesDegraded = false
  // 关系边的选中/悬停态走独立变量：星和边是两类对象，
  // 混用 selected 会让「点完星再点边」把星的高亮留在那里。
  // 存 key 而不是对象引用：页面每 30 秒重新拉一次数据，对象会换新，key 不会。
  let selectedEdgeKey = null
  let hoverEdgeKey = null
  // 每帧的边投影结果，供边拾取（点到线段距离）用
  let lastEdgeSegs = []
  const neighborMap = new Map()
  const backgroundMap = new Map()
  let mode = 'type'
  const hiddenTypes = new Set()
  const hiddenOrigins = new Set()
  let query = ''
  let focus = new Set()
  const FOCAL = 1100
  const CAM_DEFAULT = { yaw: 0.45, pitch: -0.30, dist: 1250, panX: 0, panY: 0 }
  let cam = Object.assign({}, CAM_DEFAULT)
  // 相机目标值——cam 每帧朝它做指数平滑，不再瞬移。
  // 这是「硬不硬」的关键：直接赋值 = 瞬移，插值 = 动。
  let camTarget = Object.assign({}, CAM_DEFAULT)
  // 尊重系统设置：用户关了动效就退化成瞬时（WCAG 2.3.3）
  const motionOn = !(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  /** 指数平滑：tau 是时间常数(ms)，越大越慢 */
  function smooth(current, target, dt, tau) {
    if (!motionOn) return target
    return current + (target - current) * (1 - Math.exp(-dt / tau))
  }
  let lastFrameT = 0
  let lastDt = 16
  /** 每帧推进一步相机插值 */
  function stepCam(t) {
    const dt = lastFrameT ? Math.min(64, Math.max(0, t - lastFrameT)) : 16
    lastFrameT = t
    lastDt = dt
    // 进入 320ms / 旋转 220ms：距离变化比旋转慢一点，符合「距离越长越慢」
    cam.dist = smooth(cam.dist, camTarget.dist, dt, 320)
    cam.panX = smooth(cam.panX, camTarget.panX, dt, 320)
    cam.panY = smooth(cam.panY, camTarget.panY, dt, 320)
    cam.yaw = smooth(cam.yaw, camTarget.yaw, dt, 220)
    cam.pitch = smooth(cam.pitch, camTarget.pitch, dt, 220)
  }
  let lastPos = new Map()
  let dragging = null
  let dragMoved = false
  // 自动旋转：默认关。开着的时候拖拽会暂停推 yaw（拖拽是直接操纵，不能被抢）
  let autoSpin = false
  // FIELD DEPTH 显示的上一帧文本：只在数字真的变了才写 DOM
  let lastDepthText = ''
  let hovered = null
  let selected = null
  let recentOnly = false
  // 聚焦态：点一颗星就只看它和它的 1 跳邻居，其余隐藏 + 镜头自动拉近对准。
  // 这是主人要的行为——单击即聚焦，不用再点底部按钮。
  let focusMode = null   // { anchor: id, keep: Set<id> } | null

  const hash = (str) => {
    let h = 2166136261
    for (let i = 0; i < str.length; i += 1) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0 }
    return h >>> 0
  }
  const rand = (str) => (hash(str) % 100000) / 100000

  // 「这条记忆属于哪个时刻」——优先用 validFrom，再退回 createdAt。
  // 为什么：迁移进来的 205 条，createdAt 全是导入那一刻（由 create 自动生成），
  // 原始时间存在 validFrom 里。只读 createdAt 的话时间河会挤成一个点。
  const timeOf = (p) => {
    if (p.validFrom) {
      const n = Date.parse(String(p.validFrom))
      if (Number.isFinite(n)) return n
    }
    return p.createdAt || 0
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const rect = viewport.getBoundingClientRect()
    VW = Math.max(1, Math.round(rect.width))
    VH = Math.max(1, Math.round(rect.height))
    canvas.width = Math.floor(VW * dpr)
    canvas.height = Math.floor(VH * dpr)
    canvas.style.width = VW + 'px'
    canvas.style.height = VH + 'px'
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
    // 只改画布物理尺寸：点的世界坐标与相机都不随视窗变化，
    // 投影中心在 project() 里读 VW/VH，下一帧自然就对齐了。
  }

  // 类型模式：簇 = 记忆类型，斐波那契球面铺开
  // 时间模式：x 轴按创建时间排成一条「时间河」
  function layout(list) {
    if (mode === 'time') {
      const times = list.map((p) => timeOf(p) || 0)
      const min = Math.min.apply(null, times.concat([Date.now()]))
      const max = Math.max.apply(null, times.concat([Date.now()]))
      const span = Math.max(1, max - min)
      for (const p of list) {
        const tt = ((timeOf(p) || min) - min) / span
        p.x = (tt - 0.5) * 1150
        p.y = (rand(p.id + 'y') - 0.5) * 300
        p.z = (rand(p.id + 'z') - 0.5) * 420
        p.phase = rand(p.id + 'p') * Math.PI * 2
        p.radius = 1.3 + Math.min(2.6, (p.weight || 0.5) * 2.4) + Math.min(0.9, (p.sources || 0) * 0.22)
      }
      return
    }
    const topics = []
    const seen = new Set()
    for (const p of list) {
      const t = p.type || 'other'
      if (!seen.has(t)) { seen.add(t); topics.push(t) }
    }
    const centers = new Map()
    const total = Math.max(1, topics.length)
    topics.forEach((topic, index) => {
      const y = total === 1 ? 0 : 1 - (index / (total - 1)) * 2
      const ring = Math.sqrt(Math.max(0, 1 - y * y))
      const phi = index * Math.PI * (3 - Math.sqrt(5)) + rand(topic) * 0.6
      const radius = 240 + rand(topic + 'r') * 190
      centers.set(topic, {
        x: Math.cos(phi) * ring * radius,
        y: y * radius * 0.82,
        z: Math.sin(phi) * ring * radius,
      })
    })
    // 每个簇有多少点——簇越大，球壳要越大
    const clusterSize = new Map()
    for (const p of list) clusterSize.set(p.type || 'other', (clusterSize.get(p.type || 'other') || 0) + 1)
    list.forEach((point) => {
      const key = point.type || 'other'
      const center = centers.get(key) || { x: 0, y: 0, z: 0 }
      const a = rand(point.id + 'a') * Math.PI * 2
      const b = Math.acos(2 * rand(point.id + 'b') - 1)
      // 半径随簇大小放大：否则「事实」169 个点会挤成一颗不透明的球，簇名也被埋掉。
      // 指数 0.42 是折中——让大簇摊开，又不至于把小簇推到看不见。
      const scale = Math.pow(Math.max(1, clusterSize.get(key) || 10) / 10, 0.42)
      const rr = (18 + Math.pow(rand(point.id + 'r'), 0.65) * 130) * scale
      point.x = center.x + Math.sin(b) * Math.cos(a) * rr
      point.y = center.y + Math.cos(b) * rr * 0.72
      point.z = center.z + Math.sin(b) * Math.sin(a) * rr
      point.phase = rand(point.id + 'p') * Math.PI * 2
      point.radius = 1.3 + Math.min(2.6, (point.weight || 0.5) * 2.4) + Math.min(0.9, (point.sources || 0) * 0.22)
    })
  }

  function fillAdjacency(map, list) {
    map.clear()
    for (const e of list) {
      if (!map.has(e.a)) map.set(e.a, new Set())
      if (!map.has(e.b)) map.set(e.b, new Set())
      map.get(e.a).add(e.b)
      map.get(e.b).add(e.a)
    }
  }

  function ingest(data) {
    points = (data.points || []).map((p) => Object.assign({}, p))
    // 只认真实关系边。老接口会把假边直接塞在 edges 里（kind='topic'），
    // 这里再按 kind 分一次流：假边不能混进邻居表、也不能混进顶部那个关联数。
    const rawEdges = Array.isArray(data.edges) ? data.edges : []
    edges = rawEdges.filter((e) => e && e.kind && e.kind !== 'topic')
    const bgField = Array.isArray(data.backgroundEdges) ? data.backgroundEdges : []
    const bgLegacy = rawEdges.filter((e) => e && e.kind === 'topic')
    backgroundEdges = bgField.concat(bgLegacy)
    edgesDegraded = !!data.edgesDegraded
    fillAdjacency(neighborMap, edges)
    fillAdjacency(backgroundMap, backgroundEdges)
    focus = new Set(data.focusIds || [])
    layout(points)
    buildFilters()
    // 图例行只在首屏建一次；之后每 30 秒刷新只改数字，不重建 DOM（否则图例会闪）
    if (legendBuilt) syncLegendState()
    else buildLegend()
    refreshStats()
    elEmpty.classList.toggle('show', points.length === 0)
    elError.style.display = 'none'
  }

  /** 参考图里小数字补零（07 CLUSTERS）——纯排版，不影响数值语义。 */
  const pad2 = (n) => (n < 10 ? '0' + n : String(n))

  /** 「语义簇」跟着当前视角的分类维度走：类型模式看类型，来源模式看来源。 */
  function clusterCount() {
    const set = new Set()
    for (const p of points) set.add(mode === 'origin' ? (p.origin || 'other') : (p.type || 'other'))
    return set.size
  }

  function refreshStats() {
    // 「关联」只数真实关系边。背景边数是另一个数字，挂在开关那一行——
    // 把背景线算进关联合计，等于把「没有关系」报成「有关系」。
    updateLegendCounts()
    const elBgCount = document.getElementById('bgCount')
    if (elBgCount) elBgCount.textContent = showBackground ? String(backgroundEdges.length) : '关'
    const setText = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v }
    // 统计条三格 + 底部状态行，数字同源，不各算各的
    setText('statNodes', String(points.length))
    setText('statEdges', String(edges.length))
    setText('statClusters', pad2(clusterCount()))
    updateCoreRow()
  }

  /**
   * 底部状态行：全景说「这台仪器里有多少东西」，聚焦说「你正看着哪一团关系」。
   * 参考视频就是这两种口径在切换（SEMANTIC CORE ↔ ASSOCIATION FOCUS）。
   */
  function updateCoreRow() {
    const k = document.getElementById('coreK')
    const v = document.getElementById('coreV')
    if (!k || !v) return
    if (focusMode) {
      // 链数 = 落在聚焦范围内的真实关系边；节点数 = 此刻真正可见的节点
      let chains = 0
      for (const e of edges) {
        if (focusMode.keep.has(e.a) && focusMode.keep.has(e.b)) chains += 1
      }
      k.textContent = '关联聚焦'
      v.innerHTML = '<b>' + chains + '</b> 条连线 · <b>' + visiblePoints().length
        + '</b> 个节点 · 按 ESC 或空格退出'
    } else {
      k.textContent = '语义核心'
      v.innerHTML = '<b>' + visiblePoints().length + '</b> 活跃节点 / <b>'
        + pad2(clusterCount()) + '</b> 语义簇'
    }
  }

  function buildFilters() {
    const typeBox = document.getElementById('filterType')
    const originBox = document.getElementById('filterOrigin')
    const typeCount = new Map()
    const originCount = new Map()
    for (const p of points) {
      typeCount.set(p.type || 'other', (typeCount.get(p.type || 'other') || 0) + 1)
      originCount.set(p.origin || 'other', (originCount.get(p.origin || 'other') || 0) + 1)
    }
    typeBox.textContent = ''
    for (const pair of Array.from(typeCount.entries()).sort((a, b) => b[1] - a[1])) {
      typeBox.appendChild(makeFilterRow(labelOfType(pair[0]), colorOfType(pair[0]), pair[1], hiddenTypes.has(pair[0]), () => {
        toggle(hiddenTypes, pair[0]); buildFilters(); refreshStats()
      }))
    }
    originBox.textContent = ''
    for (const pair of Array.from(originCount.entries()).sort((a, b) => b[1] - a[1])) {
      originBox.appendChild(makeFilterRow(labelOfOrigin(pair[0]), colorOfOrigin(pair[0]), pair[1], hiddenOrigins.has(pair[0]), () => {
        toggle(hiddenOrigins, pair[0]); buildFilters(); refreshStats()
      }))
    }
  }

  function toggle(set, key) { if (set.has(key)) set.delete(key); else set.add(key) }

  // 图例：颜色/线型/计数全从 REL 表生成，和画布用的是同一份定义。
  // 计数元素留着引用（legendCountEls），refreshStats 只改文字、不重建 DOM——
  // 每 30 秒重新拉一次数据，重建 DOM 会让图例闪一下。
  const legendCountEls = new Map()
  let legendBuilt = false

  function updateLegendCounts() {
    const counts = {}
    for (const e of edges) counts[e.kind] = (counts[e.kind] || 0) + 1
    for (const pair of legendCountEls) {
      const kind = pair[0]
      const el = pair[1]
      el.textContent = String(counts[kind] || 0)
    }
  }

  /** 只更新「随数据变化」的部分（计数、开关外观、降级说明），不动图例行的 DOM */
  function syncLegendState() {
    const sw = document.getElementById('bgSw')
    if (sw) sw.className = showBackground ? 'sw on' : 'sw'
    const note = document.getElementById('relNote')
    if (note) {
      note.textContent = edgesDegraded
        ? '当前库还没有关系能力（缺 0006 迁移），只有背景近似连线可看。'
        : '同簇相邻是「同类型 + 时间相邻」的近似连线，不是真实关系；默认不画，要看再打开。'
    }
    updateLegendCounts()
  }

  function buildLegend() {
    const box = document.getElementById('legend')
    if (box) {
      box.textContent = ''
      legendCountEls.clear()
      for (const kind of REL_LEGEND) {
        const st = REL[kind]
        const row = document.createElement('div')
        row.className = 'rel'
        const line = document.createElement('i')
        // 细线（佐证/细化）在图例里也要看得出比矛盾细，否则图例和画面对不上
        if (st.dash) line.className = (line.className ? line.className + ' ' : '') + 'dash'
        if (st.weight < 0.6) line.className = (line.className ? line.className + ' ' : '') + 'thin'
        line.style.borderTopColor = 'rgb(' + st.color.join(',') + ')'
        const txt = document.createElement('span')
        txt.textContent = st.label
        const n = document.createElement('span')
        n.className = 'n'
        n.textContent = '0'
        row.appendChild(line); row.appendChild(txt); row.appendChild(n)
        row.title = st.hint
        box.appendChild(row)
        legendCountEls.set(kind, n)
      }
      legendBuilt = true
    }
    syncLegendState()
  }

  function makeFilterRow(label, rgb, count, off, onClick) {
    const row = document.createElement('div')
    row.className = 'item' + (off ? ' off' : '')
    const dot = document.createElement('span')
    dot.className = 'dot'
    dot.style.background = 'rgb(' + rgb.join(',') + ')'
    dot.style.boxShadow = '0 0 7px rgba(' + rgb.join(',') + ',.7)'
    const txt = document.createElement('span')
    txt.textContent = label
    const n = document.createElement('span')
    n.className = 'n'
    n.textContent = String(count)
    row.appendChild(dot); row.appendChild(txt); row.appendChild(n)
    row.onclick = onClick
    return row
  }

  function visiblePoints() {
    let list = points
    if (focusMode) list = list.filter((p) => focusMode.keep.has(p.id))
    if (hiddenTypes.size) list = list.filter((p) => !hiddenTypes.has(p.type || 'other'))
    if (hiddenOrigins.size) list = list.filter((p) => !hiddenOrigins.has(p.origin || 'other'))
    if (query) {
      const q = query.toLowerCase()
      list = list.filter((p) => (p.text || '').toLowerCase().indexOf(q) >= 0 || (p.content || '').toLowerCase().indexOf(q) >= 0)
    }
    if (recentOnly) list = list.slice().sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 120)
    return list
  }

  // 群星的地图模式：同一片星区，换个维度重新着色
  let timeMin = 0
  let timeMax = 1
  function recalTimeRange() {
    const ts = points.map((p) => timeOf(p))
    timeMin = Math.min.apply(null, ts.concat([0]))
    timeMax = Math.max.apply(null, ts.concat([1]))
  }
  function colorOf(p) {
    if (mode === 'origin') return colorOfOrigin(p.origin)
    if (mode === 'weight') {
      const w = Math.max(0, Math.min(1, p.weight || 0.5))
      const cold = [70, 88, 120]
      const warm = [255, 186, 96]
      return [
        Math.round(cold[0] + (warm[0] - cold[0]) * w),
        Math.round(cold[1] + (warm[1] - cold[1]) * w),
        Math.round(cold[2] + (warm[2] - cold[2]) * w),
      ]
    }
    if (mode === 'time') {
      const t2 = timeMax > timeMin ? ((timeOf(p) - timeMin) / (timeMax - timeMin)) : 0.5
      return [
        Math.round(90 + 60 * t2),
        Math.round(120 + 110 * t2),
        Math.round(200 - 60 * t2),
      ]
    }
    return colorOfType(p.type)
  }

  /** 统计条第四格：数据链路状态。成功就是「同步中」，失败说「离线」。 */
  function setFieldStatus(ok) {
    const el = document.getElementById('statStatus')
    if (!el) return
    el.textContent = ok ? '同步中' : '离线'
    el.classList.toggle('ok', ok)
    el.classList.toggle('bad', !ok)
  }

  async function load() {
    try {
      const res = await fetch('/dsh-brain/api/scene', { credentials: 'same-origin' })
      const data = await res.json()
      if (!data.ok) throw new Error(data.message || '接口返回失败')
      ingest(data)
      recalTimeRange()
      setFieldStatus(true)
    } catch (error) {
      elError.textContent = '读不到心海数据：' + error.message
      elError.style.display = 'grid'
      setFieldStatus(false)
    }
  }

  function project(point, t) {
    const drift = (selected || hovered) ? 0 : 1
    const wx = point.x + cam.panX + Math.sin(t / 3200 + point.phase) * 7 * drift
    const wy = point.y + cam.panY + Math.cos(t / 4100 + point.phase) * 5 * drift
    const wz = point.z + Math.sin(t / 2700 + point.phase * 1.3) * 7 * drift
    const cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw)
    const cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch)
    const x1 = wx * cy - wz * sy
    const z1 = wx * sy + wz * cy
    const y1 = wy * cp - z1 * sp
    const z2 = wy * sp + z1 * cp
    const depth = cam.dist + z2
    const f = FOCAL / Math.max(140, depth)
    return { x: VW / 2 + x1 * f, y: VH / 2 + y1 * f, f, depth }
  }

  /**
   * 把鼠标的页面坐标换算成视窗本地坐标。
   * v2 画布铺满窗口、原点就在 (0,0)，所以拾取直接用 clientX/clientY；
   * v3 画布在卡片里，必须减掉卡片在页面里的偏移，否则点哪都偏一个 header 的高度。
   */
  function localXY(e) {
    const r = canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  /**
   * 画一条边。
   *
   * v3.2 起从直线改成**二次贝塞尔弧线**：参考视频里的连线是微微弯的，
   * 直线排在一起像电路板走线，弧线才像神经纤维。
   *
   * 弯曲量取两点距离的 6%，最大 22px（长线不至于弯成弓）；
   * 弯向由这条边的 key 哈希决定——同一对点永远弯同一边，不会每帧翻面。
   *
   * 拾取仍然用 lastEdgeSegs 里的端点做直线近似：弯曲最多二十来像素，
   * 而拾取容差本来就有 8px，加上「点到线段」取最近的逻辑，命中不受影响。
   */
  function strokeSeg(a, b, st, alpha, lw, solid, key) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len = Math.hypot(dx, dy) || 1
    const sign = key && hash(key) % 2 === 1 ? -1 : 1
    const bend = Math.min(22, len * 0.06) * sign
    const mx = (a.x + b.x) / 2 - (dy / len) * bend
    const my = (a.y + b.y) / 2 + (dx / len) * bend
    g.save()
    g.lineWidth = Math.max(0.5, lw)
    g.setLineDash(solid ? [] : (st.dash || []))
    g.strokeStyle = 'rgba(' + st.color.join(',') + ',' + Math.max(0, Math.min(1, alpha)).toFixed(3) + ')'
    g.beginPath()
    g.moveTo(a.x, a.y)
    g.quadraticCurveTo(mx, my, b.x, b.y)
    g.stroke()
    g.restore()
  }

  /**
   * 簇核心：参考图里那些带环的大节点（PROJECT 34 / SEMANTIC CORE）。
   *
   * 簇不是额外的数据实体，它就是「同类型节点在屏幕上的质心」。在质心画一枚环 +
   * 名称 + 计数，读法是「这一团是什么、有几个」。点击拾取仍然只认真实记忆点，
   * 不认这枚环——环是标尺，不是可选中的对象。
   *
   * 为什么画在节点之后：环要亮在星点上面。画在节点之前，密集的星会把虚线环切断，
   * 看着像「环坏了」而不是「环在后面」。
   */
  function drawClusters(list, pos) {
    // 时间模式没有簇；聚焦态也不需要——那一刻画面只该有焦点和它的邻居，
    // 再压一层簇环等于在关系图上叠一道无关的标尺。
    if (mode === 'time' || focusMode) return
    const groups = new Map()
    for (const point of list) {
      const key = point.type || 'other'
      const p = pos.get(point.id)
      if (!p) continue
      const acc = groups.get(key) || { x: 0, y: 0, n: 0, near: 0 }
      acc.x += p.x; acc.y += p.y; acc.n += 1; acc.near = Math.max(acc.near, p.f)
      groups.set(key, acc)
    }
    // 大簇先画（环大），小簇后画：反过来的话小簇常被大环的弧线压住
    const clustered = Array.from(groups.entries())
      .filter((pair) => pair[1].n >= 3)
      .sort((a, b) => b[1].n - a[1].n)
    for (const pair of clustered) {
      const key = pair[0], acc = pair[1]
      const cx = acc.x / acc.n
      const cy = acc.y / acc.n
      const rgb = colorOfType(key).join(',')
      // 半径跟簇规模走，但压上限——「事实」一百多个点算出来的环会盖住半屏
      const rr = Math.min(44, 11 + Math.sqrt(acc.n) * 2.5)
      const fade = Math.min(1, acc.near * 1.5)
      g.save()
      // 外环：一圈极淡的虚线，像仪器把这一簇圈出来了
      g.setLineDash([2, 5])
      g.lineWidth = 1
      g.strokeStyle = 'rgba(' + rgb + ',' + (0.15 * fade).toFixed(3) + ')'
      g.beginPath()
      g.arc(cx, cy, rr, 0, Math.PI * 2)
      g.stroke()
      // 内环：实线短环，标核心
      g.setLineDash([])
      g.strokeStyle = 'rgba(' + rgb + ',' + (0.30 * fade).toFixed(3) + ')'
      g.beginPath()
      g.arc(cx, cy, rr * 0.40, 0, Math.PI * 2)
      g.stroke()
      g.restore()
      // 核心辉光
      const core = g.createRadialGradient(cx, cy, 0, cx, cy, 15)
      core.addColorStop(0, 'rgba(' + rgb + ',' + (0.80 * fade).toFixed(3) + ')')
      core.addColorStop(0.34, 'rgba(' + rgb + ',' + (0.26 * fade).toFixed(3) + ')')
      core.addColorStop(1, 'rgba(' + rgb + ',0)')
      g.fillStyle = core
      g.beginPath()
      g.arc(cx, cy, 15, 0, Math.PI * 2)
      g.fill()
      // 名称 + 计数（挂在环上方，跟参考图的簇标签同一位置逻辑）
      // 深底色上的文字一律带一层暗投影：不给的话文字坐在星点里，读不出来
      g.shadowColor = 'rgba(4,7,14,.95)'
      g.shadowBlur = 6
      g.textAlign = 'center'
      g.font = '600 11.5px system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif'
      g.fillStyle = 'rgba(' + rgb + ',' + (0.85 * fade).toFixed(3) + ')'
      g.fillText(labelOfType(key), cx, cy - rr - 12)
      g.font = '9px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace'
      g.fillStyle = 'rgba(' + rgb + ',' + (0.55 * fade).toFixed(3) + ')'
      g.fillText(String(acc.n), cx, cy - rr - 2)
      g.shadowBlur = 0
    }
    g.textAlign = 'left'
  }

  function frame(t) {
    // 自动旋转：只推目标值，让 cam 走既有的指数插值——转起来才不顿。
    if (autoSpin && !dragging) camTarget.yaw += lastDt * 0.00011
    stepCam(t)
    // FIELD DEPTH：默认视距与当前视距的比值，1.00× 就是默认视角。
    // 节流写入——每帧写一次 textContent，等于给 60fps 的渲染循环白加一笔 DOM 开销。
    if (elDepth) {
      const dText = (CAM_DEFAULT.dist / cam.dist).toFixed(2) + '×'
      if (dText !== lastDepthText) { lastDepthText = dText; elDepth.textContent = dText }
    }
    g.clearRect(0, 0, VW, VH)

    // ── 星尘：两层。远层多而暗，近层少而亮，给深底一点纵深和质感，
    //    否则黑底上只剩关系节点，画面是「散点图」而不是「星海」。
    //    位置全用固定哈希算，不占数组内存。
    for (let i = 0; i < 260; i += 1) {
      const x = (hash('bg' + i) % 1000) / 1000 * VW
      const y = (hash('bgy' + i) % 1000) / 1000 * VH
      const tw = (Math.sin(t / 2600 + i * 1.7) + 1) / 2
      g.fillStyle = 'rgba(150,180,240,' + (0.03 + tw * 0.075).toFixed(3) + ')'
      g.fillRect(x, y, 1, 1)
    }
    for (let i = 0; i < 54; i += 1) {
      const x = (hash('nd' + i) % 1000) / 1000 * VW
      const y = (hash('ndy' + i) % 1000) / 1000 * VH
      const tw = (Math.sin(t / 1900 + i * 2.3) + 1) / 2
      g.fillStyle = 'rgba(170,205,255,' + (0.05 + tw * 0.16).toFixed(3) + ')'
      g.beginPath()
      g.arc(x, y, 0.8 + tw * 0.7, 0, Math.PI * 2)
      g.fill()
    }

    // 渐显/渐隐：算出哪些点「应该」可见，然后每个点朝目标透明度平滑过渡。
    // 直接过滤数组 = 点瞬间消失，这就是「生硬」的来源。
    const shouldShow = new Set(visiblePoints().map((p) => p.id))
    for (const p of points) {
      const want = shouldShow.has(p.id) ? 1 : 0
      if (p.a == null) p.a = want
      p.a = smooth(p.a, want, lastDt, 240)
      // 点击脉冲衰减：让被点中的星「弹」一下，而不是死板地亮起来
      if (p.pulse) p.pulse = Math.max(0, p.pulse - lastDt / 280)
    }
    const list = points.filter((p) => (p.a == null ? 1 : p.a) > 0.02)
    const pos = new Map()
    for (const point of list) pos.set(point.id, project(point, t))
    lastPos = pos
    const idx = new Set(list.map((p) => p.id))
    const order = list.slice().sort((a, b) => pos.get(b.id).depth - pos.get(a.id).depth)

    const lit = new Set()
    const anchor = hovered || selected
    if (anchor) {
      const nb = neighborMap.get(anchor)
      if (nb) for (const n of nb) lit.add(n)
      lit.add(anchor)
    }

    // ── 关系边 ───────────────────────────────────────────
    // 绘制顺序有语义：背景弱边在最底，真实关系边按「弱到强」压上去，
    // 矛盾永远最后画——它是这一屏最该被看见的东西。
    lastEdgeSegs = []
    if (showBackground) {
      const stBg = REL.topic
      for (const edge of backgroundEdges) {
        if (!idx.has(edge.a) || !idx.has(edge.b)) continue
        const a = pos.get(edge.a), b = pos.get(edge.b)
        const near = (a.f + b.f) * 0.5
        const hot = hoverEdgeKey === edgeKey(edge) || selectedEdgeKey === edgeKey(edge)
        const alpha = Math.min(0.5, stBg.alpha * Math.min(1, 0.4 + near) * (hot ? 3.2 : 1))
        strokeSeg(a, b, stBg, alpha, hot ? 1.4 : 0.9, false, edgeKey(edge))
        lastEdgeSegs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, edge, kind: 'topic' })
      }
    }
    for (const kind of REL_DRAW_ORDER) {
      const st = REL[kind]
      for (const edge of edges) {
        if (edge.kind !== kind) continue
        if (!idx.has(edge.a) || !idx.has(edge.b)) continue
        const a = pos.get(edge.a), b = pos.get(edge.b)
        const key = edgeKey(edge)
        const near = (a.f + b.f) * 0.5
        const isLit = !!anchor && (edge.a === anchor || edge.b === anchor)
        const isHot = hoverEdgeKey === key || selectedEdgeKey === key
        // 有焦点（悬停或选中某颗星）时压暗无关边：
        // 否则几条红线和两百多颗星互相抢，反而看不出「谁跟谁有关系」
        const dimK = anchor && !isLit ? 0.28 : 1
        let alpha = st.alpha * Math.min(1, 0.32 + near * 1.1) * dimK
        if (isLit) alpha = Math.min(0.97, alpha * 1.55 + 0.12)
        if (isHot) alpha = 0.98
        const lw = Math.max(0.9, st.weight * (0.8 + near * 0.9)) * (isHot ? 1.6 : 1)
        // 强边（矛盾/取代）先铺一层更宽更淡的底，在近黑底上有一点光晕；
        // 线型本身仍是虚线/实线，读法是「粗重=要处理、虚线=冲突」
        if (st.weight >= 0.75) strokeSeg(a, b, st, Math.min(0.4, alpha * 0.3), lw * 3.1, true, key)
        strokeSeg(a, b, st, alpha, lw, false, key)
        lastEdgeSegs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, edge, kind })
      }
    }

    // ── 流动光点：沿真实关系边跑的脉冲，表达「这条关系正在被读到」──
    // 只给强边（矛盾/取代/佐证）加。给弱边也加，画面就成了一片乱飞的萤火，
    // 反而盖掉「哪两条记忆真的有关」这个唯一要说清的信息。
    if (motionOn) {
      for (const kind of REL_DRAW_ORDER) {
        const st = REL[kind]
        if (st.weight < 0.5) continue
        const rgb = st.color.join(',')
        for (const edge of edges) {
          if (edge.kind !== kind) continue
          if (!idx.has(edge.a) || !idx.has(edge.b)) continue
          const a = pos.get(edge.a)
          const b = pos.get(edge.b)
          const len = Math.hypot(b.x - a.x, b.y - a.y)
          if (len < 36) continue // 太短的线看不出流动，白算一遍渐变
          const hot = hoverEdgeKey === edgeKey(edge) || selectedEdgeKey === edgeKey(edge)
          // 每条边的相位固定散开，否则所有光点会同时出发、看着像在闪
          const phase = (hash(edgeKey(edge)) % 1000) / 1000
          const tt = (t * 0.00015 + phase) % 1
          const px = a.x + (b.x - a.x) * tt
          const py = a.y + (b.y - a.y) * tt
          const rr = 1.5 + (hot ? 1.3 : 0)
          const gr = g.createRadialGradient(px, py, 0, px, py, rr * 3.4)
          gr.addColorStop(0, 'rgba(' + rgb + ',' + (hot ? 0.95 : 0.62).toFixed(2) + ')')
          gr.addColorStop(1, 'rgba(' + rgb + ',0)')
          g.fillStyle = gr
          g.beginPath()
          g.arc(px, py, rr * 3.4, 0, Math.PI * 2)
          g.fill()
        }
      }
    }

    for (const point of order) {
      const p = pos.get(point.id)
      const c = colorOf(point)
      const isSel = selected === point.id
      const isHov = hovered === point.id
      const isLit = anchor ? lit.has(point.id) : false
      const dim = anchor && !isLit ? 0.22 : 1
      // 逐点透明度：渐显/渐隐 + 悬停/选中时的高亮权重
      const pa = point.a == null ? 1 : point.a
      const depthFade = Math.max(0.18, Math.min(1, p.f * 1.55)) * dim * pa
      // 点击后弹一下：pulse 从 1 衰减到 0，半径最多放大 55%
      const pulseK = 1 + (point.pulse || 0) * 0.55
      // 本体比 v3.2 小一档（系数 1.5 → 1.15）：参考图的星点本体只有几个像素，
      // 大面积留给光晕。本体大、光晕小就变成「蓝色圆片」，反过来才是「发光的星」。
      const r = Math.max(0.9, point.radius * p.f * 1.15) * pulseK

      if (point.sources > 0 && r > 2) {
        g.beginPath()
        g.arc(p.x, p.y, r * 2.1, 0, Math.PI * 2)
        g.strokeStyle = 'rgba(' + c.join(',') + ',' + (0.14 * depthFade) + ')'
        g.lineWidth = 1
        g.stroke()
      }

      // ── 节点画法 v3.3：白核 + 彩色辉光 ──
      // 参考图里每颗星都是「中心一个过曝的白点 + 外面一圈彩色辉光」；
      // 之前是纯色实心圆加一圈淡晕，看着像贴上去的圆片，不像在发光。
      // 现在分三层：弥散外晕 → 明亮内晕 → 白色核心，全部用 lighter 叠加——
      // 光与光相遇会变亮（跟真实的光一样），而不是互相盖住。
      g.save()
      g.globalCompositeOperation = 'lighter'

      // ① 弥散外晕：范围大、中心淡，负责「光散在空气里」的那层
      const halo = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 8)
      halo.addColorStop(0, 'rgba(' + c.join(',') + ',' + (0.32 * depthFade).toFixed(3) + ')')
      halo.addColorStop(0.3, 'rgba(' + c.join(',') + ',' + (0.14 * depthFade).toFixed(3) + ')')
      halo.addColorStop(1, 'rgba(' + c.join(',') + ',0)')
      g.fillStyle = halo
      g.beginPath()
      g.arc(p.x, p.y, r * 8, 0, Math.PI * 2)
      g.fill()

      // ② 明亮内晕：把颜色压紧在核心周围一圈
      const glow = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 2.4)
      glow.addColorStop(0, 'rgba(' + c.join(',') + ',' + (0.95 * depthFade).toFixed(3) + ')')
      glow.addColorStop(0.46, 'rgba(' + c.join(',') + ',' + (0.42 * depthFade).toFixed(3) + ')')
      glow.addColorStop(1, 'rgba(' + c.join(',') + ',0)')
      g.fillStyle = glow
      g.beginPath()
      g.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2)
      g.fill()

      // ③ 白色核心：星体本身的「过曝点」。往白里提 78%——全白会丢掉类型色，
      //    提少了又回到「蓝色圆片」，这个比例是两者之间的折中。
      const hot = [
        Math.round(c[0] + (255 - c[0]) * 0.68),
        Math.round(c[1] + (255 - c[1]) * 0.68),
        Math.round(c[2] + (255 - c[2]) * 0.68),
      ]
      const core = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.15)
      core.addColorStop(0, 'rgba(255,255,255,' + (0.98 * depthFade).toFixed(3) + ')')
      core.addColorStop(0.62, 'rgba(' + hot.join(',') + ',' + (0.92 * depthFade).toFixed(3) + ')')
      core.addColorStop(1, 'rgba(' + c.join(',') + ',0)')
      g.fillStyle = core
      g.beginPath()
      g.arc(p.x, p.y, r * 1.15, 0, Math.PI * 2)
      g.fill()

      g.restore()

      if (isSel) {
        // 选中态：三层同心环（参考视频里的靶心形态）。
        // 外环虚线缓慢自转、中线实线、内环贴着光点——比单圈白线更能表达「锁定了这一颗」。
        g.save()
        const spin = (t / 9000) * Math.PI * 2
        g.beginPath()
        g.setLineDash([3, 6])
        g.lineWidth = 1
        g.strokeStyle = 'rgba(' + c.join(',') + ',.55)'
        g.arc(p.x, p.y, r * 4.2, spin, spin + Math.PI * 2)
        g.stroke()
        g.setLineDash([])
        g.beginPath()
        g.lineWidth = 1.4
        g.strokeStyle = 'rgba(' + c.join(',') + ',.88)'
        g.arc(p.x, p.y, r * 2.6, 0, Math.PI * 2)
        g.stroke()
        g.restore()
      } else if (isHov) {
        g.beginPath()
        g.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2)
        g.strokeStyle = 'rgba(' + c.join(',') + ',.88)'
        g.lineWidth = 1.5
        g.stroke()
      }
    }

    // 簇标记盖在星点之上（见 drawClusters 的注释）
    drawClusters(list, pos)

    // ── 标签策略（v3.2 按参考视频重做）──
    // 全景：不画节点级文字。226 个点上面叠几条记忆摘要，既看不清也读不完；
    //       画面的主角是簇（drawClusters 已经给了「事实 · 182」），具体是谁靠 hover 回答。
    // 聚焦：给每颗可见节点挂「mem_8d675a · EMOTION」——这时只剩十来颗星，
    //       标签不会互相压，而「这条是什么、属于哪类」正是这一步唯一要看的信息。
    if (focusMode) {
      drawFocusLabels(list, pos)
    }

    requestAnimationFrame(frame)
  }

  /**
   * 聚焦态的节点标签：「mem_8d675a · EMOTION」。
   *
   * 参考视频在聚焦时给每一颗可见节点都挂这种短标签。这里照做，但补了两处：
   *   1. 纵向避让——十来个标签全往右上角挤时，重叠的往下错开一档；
   *   2. 焦点那颗加不透明度——一眼能分出「我点的是这颗，其余是它的邻居」。
   */
  function drawFocusLabels(list, pos) {
    g.textAlign = 'left'
    g.shadowColor = 'rgba(4,7,14,.95)'
    g.shadowBlur = 6
    // 2026-11-02：标签里的类别改成中文了（事实/偏好/约定…），字体必须能落到中文字形上，
    // 否则 9.5px 的等宽字体回退到系统默认宋体会糊成一团。字号也给中文留到 10px。
    g.font = '600 10px ui-monospace,SFMono-Regular,Menlo,Consolas,"Microsoft YaHei","PingFang SC",monospace'
    const placed = []
    // 靠前的先占位，避免远处的标签把近处的挤走
    const ordered = list.slice().sort((a, b) => {
      const pa = pos.get(a.id)
      const pb = pos.get(b.id)
      return (pb ? pb.f : 0) - (pa ? pa.f : 0)
    })
    for (const point of ordered) {
      const p = pos.get(point.id)
      if (!p) continue
      // 正在渐隐的点不打标签：否则切出聚焦的那几帧会留下一串鬼影文字
      if ((point.a == null ? 1 : point.a) < 0.5) continue
      const c = colorOf(point)
      const label = shortId(point.id) + ' · ' + codeOfType(point.type)
      const w = g.measureText(label).width
      const x = p.x + 11
      let y = p.y - 9
      let guard = 0
      while (guard < 6) {
        let hit = false
        for (const r2 of placed) {
          if (Math.abs(x - r2.x) < (w + r2.w) / 2 + 10 && Math.abs(y - r2.y) < 12) { hit = true; break }
        }
        if (!hit) break
        y += 13
        guard += 1
      }
      placed.push({ x, y, w })
      const isAnchor = selected === point.id
      g.fillStyle = 'rgba(' + c.join(',') + ',' + (isAnchor ? 0.98 : 0.78).toFixed(2) + ')'
      g.fillText(label, x, y)
    }
    // 阴影只给文字用，不留给后面的绘制（会被糊出毛边）
    g.shadowBlur = 0
    g.textAlign = 'center'
  }

  function pickAt(mx, my) {
    let best = null
    let bestDepth = Infinity
    for (const pair of lastPos) {
      const id = pair[0], p = pair[1]
      const dx = mx - p.x, dy = my - p.y
      const hit = Math.max(8, 3.5 * p.f * 2)
      if (dx * dx + dy * dy <= hit * hit && p.depth < bestDepth) { best = id; bestDepth = p.depth }
    }
    return best
  }

  /**
   * 边拾取：点到线段的距离。
   * 星优先（点星是主操作），只有没点中星、又落在线附近才算点边；
   * 线段互相穿过时取最近的一条——不然两条边的交点处会随机选一条。
   */
  function pickEdge(mx, my) {
    let best = null
    let bestD = 8
    for (const seg of lastEdgeSegs) {
      const dx = seg.x2 - seg.x1
      const dy = seg.y2 - seg.y1
      const len2 = dx * dx + dy * dy
      let t = len2 > 0 ? ((mx - seg.x1) * dx + (my - seg.y1) * dy) / len2 : 0
      t = Math.max(0, Math.min(1, t))
      const px = seg.x1 + dx * t
      const py = seg.y1 + dy * t
      const d = Math.hypot(mx - px, my - py)
      if (d < bestD) { bestD = d; best = seg }
    }
    return best
  }

  function showEdgeTip(seg, mx, my) {
    elTip.textContent = ''
    const head = document.createElement('b')
    head.textContent = relOf(seg.kind).label + ' · ' + (seg.edge.reason || '（没写原因）')
    elTip.appendChild(head)
    const meta = document.createElement('div')
    meta.style.cssText = 'margin-top:4px;font-size:10.5px;color:#79818d'
    meta.textContent = cut(seg.edge.fromSummary, 20) + ' ↔ ' + cut(seg.edge.toSummary, 20)
    elTip.appendChild(meta)
    elTip.classList.add('show')
    elTip.style.left = Math.max(6, Math.min(mx + 14, VW - 296)) + 'px'
    elTip.style.top = Math.max(6, Math.min(my + 14, VH - 86)) + 'px'
  }

  /**
   * 点边 → 右侧关系面板：类型、原因、两端摘要、建立时间、来源。
   * 和星详情共用同一个容器：同一时刻只看一样东西，不并排挤两栏。
   */
  function showEdgeDetail(edge) {
    const st = relOf(edge.kind)
    selectedEdgeKey = edgeKey(edge)
    selected = null
    elDetail.textContent = ''
    elDetail.classList.add('show')
    elInspector.classList.add('show')

    const x = document.createElement('span')
    x.className = 'x'; x.textContent = '✕'
    x.onclick = () => closeEdgeDetail()
    elDetail.appendChild(x)

    const tag = document.createElement('span')
    tag.className = 'reltag'
    tag.textContent = st.label + ' 关系'
    tag.style.color = 'rgb(' + st.color.join(',') + ')'
    elDetail.appendChild(tag)

    const h2 = document.createElement('h2')
    h2.textContent = edge.reason || '（这条关系没写原因）'
    elDetail.appendChild(h2)

    const pair = document.createElement('div')
    pair.className = 'pair'
    const side = (endLabel, summary) => {
      const wrap = document.createElement('div')
      const k = document.createElement('div')
      k.className = 'end'
      k.textContent = endLabel
      const v = document.createElement('div')
      v.className = 'side'
      v.textContent = summary || '（无摘要）'
      wrap.appendChild(k); wrap.appendChild(v)
      return wrap
    }
    pair.appendChild(side('FROM · 起点', edge.fromSummary))
    pair.appendChild(side('TO · 终点', edge.toSummary))
    elDetail.appendChild(pair)

    const rows = [
      ['类型', edge.kind + '（' + st.label + '）'],
      ['含义', st.hint],
      ['建立于', edge.createdAtRaw || (edge.createdAt ? new Date(edge.createdAt).toLocaleString('zh-CN') : '—')],
      ['来源', edge.sourceSystem || '（未标注）'],
      ['边 ID', edge.edgeId || '—'],
    ]
    for (const kv of rows) {
      const row = document.createElement('div')
      row.className = 'row'
      const kk = document.createElement('div'); kk.className = 'k'; kk.textContent = kv[0]
      const vv = document.createElement('div'); vv.className = 'v'; vv.textContent = kv[1]
      row.appendChild(kk); row.appendChild(vv)
      elDetail.appendChild(row)
    }

    elCtx.textContent = ''
    elCtx.classList.add('show')
    const addBtn = (label, fn) => {
      const b = document.createElement('button')
      b.className = 'btn'; b.textContent = label; b.onclick = fn
      elCtx.appendChild(b)
    }
    if (edge.kind === 'contradicts') {
      addBtn('去核验页并排看全文', () => { location.href = '/dsh-brain/conflicts' })
    }
    addBtn('收起', () => closeEdgeDetail())
  }

  function closeEdgeDetail() {
    selectedEdgeKey = null
    elDetail.classList.remove('show')
    elCtx.classList.remove('show')
    elInspector.classList.remove('show')
  }

  /** 聚焦范围 = 自己 + 真邻居（背景开关打开时再加背景邻居） */
  function keepSetFor(id) {
    const keep = new Set([id])
    const nb = neighborMap.get(id)
    if (nb) for (const n of nb) keep.add(n)
    // 背景开关打开时，聚焦范围也纳入背景邻居：
    // 否则切了开关，聚焦态还卡在「只留真邻居」，屏幕上会只剩一两个孤点。
    if (showBackground) {
      const bg = backgroundMap.get(id)
      if (bg) for (const n of bg) keep.add(n)
    }
    return keep
  }

  function rebuildFocusKeep() {
    if (!focusMode) return
    focusMode = { anchor: focusMode.anchor, keep: keepSetFor(focusMode.anchor) }
  }

  /**
   * 进入聚焦态：只保留目标 + 它的 1 跳邻居，镜头平滑拉近并对准。
   * **写 camTarget 而不是 cam** —— cam 由 stepCam 每帧插值追上去，才有「动」的感觉。
   *
   * ── 对准为什么要算解析解（2026-10-31 修）──
   * 旧写法是 panX = -p.x / panY = -p.y，注释说「近似，z 旋转仍有残余偏移，但够用」。
   * 实际不是「够用」：投影（见 project()）把世界坐标过两道旋转——
   *   x1 = wx·cos(yaw) − wz·sin(yaw)
   *   z1 = wx·sin(yaw) + wz·cos(yaw)
   *   y1 = wy·cos(pitch) − z1·sin(pitch)
   * 只把 pan 设成 −point 等于让 wx=wy=0，此时 x1 = −wz·sin(yaw)、y1 = −wz·cos(yaw)·sin(pitch)，
   * **只要 wz ≠ 0 屏幕位置就偏**，且偏多少与 z 成正比。默认视角 yaw=0.45 / pitch=−0.30 下，
   * 实测最坏偏 4400px（点直接被甩出屏幕），典型几百 px —— 就是「点了星，星不在中间」。
   *
   * 令 x1=0 且 y1=0 可解出唯一的 (wx, wy)：
   *   wx = wz·tan(yaw)
   *   z1 = wz / cos(yaw)
   *   wy = z1·tan(pitch)
   * 反推 panX = wx − p.x、panY = wy − p.y。验证：4 个不同量级的点，偏移从 0~4400px 变成 0.00px。
   *
   * 用 camTarget 的 yaw/pitch 算：聚焦不改这两项，插值到位后的最终视角就是它们；
   * 拿 cam 当前值算会在动画途中偏掉。dist 不参与——x1=y1=0 时中心与焦距无关。
   */
  /** 右上那颗按钮的文案跟着状态走：聚焦时它就是「退出聚焦」 */
  function syncResetLabel() {
    const btn = document.getElementById('btnReset')
    if (btn) btn.textContent = focusMode ? '退出聚焦' : '重置视角'
  }

  function enterFocus(id) {
    const keep = keepSetFor(id)
    focusMode = { anchor: id, keep }
    const p = points.find((x) => x.id === id)
    if (p) {
      // 预备动作：先把这个星弹一下，再让镜头推过去
      p.pulse = 1
      const cyw = Math.cos(camTarget.yaw)
      const syw = Math.sin(camTarget.yaw)
      const cpt = Math.cos(camTarget.pitch)
      const spt = Math.sin(camTarget.pitch)
      // wz 取点自身的 z（选中时 project 里的漂移项 drift=0，不参与）
      const wz = Number.isFinite(p.z) ? p.z : 0
      const cosYaw = Math.abs(cyw) > 1e-6 ? cyw : 1
      const cosPitch = Math.abs(cpt) > 1e-6 ? cpt : 1
      const wx = wz * (syw / cosYaw)
      const z1 = wz / cosYaw
      const wy = z1 * (spt / cosPitch)
      camTarget.panX = wx - p.x
      camTarget.panY = wy - p.y
      // 邻居多就退远一点，别挤到屏幕外；邻居少就推近
      const n = keep.size
      camTarget.dist = n <= 3 ? 520 : (n <= 8 ? 700 : (n <= 20 ? 900 : 1100))
    }
    syncResetLabel()
    refreshStats()
  }

  /** 退出聚焦态：恢复全量 + 镜头平滑归位 */
  function exitFocus() {
    focusMode = null
    selected = null
    selectedEdgeKey = null
    hovered = null
    hoverEdgeKey = null
    camTarget = Object.assign({}, CAM_DEFAULT)
    elDetail.classList.remove('show')
    elCtx.classList.remove('show')
    elInspector.classList.remove('show')
    syncResetLabel()
    refreshStats()
  }

  function showDetail(id) {
    const p = points.find((x) => x.id === id)
    if (!p) return
    selected = id
    // 点星时把边的选中清掉：右侧面板只有一栏，不能同时显示星和边
    selectedEdgeKey = null
    // 点星即聚焦——不用再点按钮
    enterFocus(id)
    elDetail.textContent = ''
    elDetail.classList.add('show')
    elInspector.classList.add('show')

    const x = document.createElement('span')
    x.className = 'x'; x.textContent = '✕'
    x.onclick = () => exitFocus()
    elDetail.appendChild(x)

    // ── 卡片头：FOCUS · mem_xxxxxx ──
    // 参考视频聚焦时右下就是一块矮卡片，第一行写清「我在看哪一条」。
    const nb = neighborMap.get(id)
    const head = document.createElement('div')
    head.className = 'focus-head'
    const hk = document.createElement('span')
    hk.textContent = 'FOCUS'
    const hsep = document.createElement('i')
    hsep.textContent = '·'
    hsep.style.cssText = 'font-style:normal;color:#3f5875'
    const hid = document.createElement('b')
    hid.textContent = shortId(p.id)
    head.appendChild(hk); head.appendChild(hsep); head.appendChild(hid)
    elDetail.appendChild(head)

    const h2 = document.createElement('h2')
    h2.textContent = p.text || '(无摘要)'
    elDetail.appendChild(h2)

    // ── 一行元信息：类型 · 重要度 · 关联数 · 版本 ──
    // 原来是四行 key-value 表，在聚焦卡片里太吃高度；拍成一行，扫一眼就够。
    const meta = document.createElement('div')
    meta.className = 'focus-meta'
    const seg = (label, value) => {
      const i = document.createElement('i'); i.textContent = '·'
      meta.appendChild(i)
      meta.appendChild(document.createTextNode(label))
      const b = document.createElement('b'); b.textContent = value
      meta.appendChild(b)
    }
    meta.appendChild(document.createTextNode(labelOfType(p.type)))
    seg('重要度 ', String(p.weight != null ? p.weight : '—'))
    seg('关联 ', String(nb ? nb.size : 0))
    seg('版本 ', 'v' + (p.version || 1))
    elDetail.appendChild(meta)

    // ── 完整记录：分类/来源/正文/ID/时间，默认收起 ──
    // 面板一撑满右半屏，挡住的正好是你在看的那片关系，所以默认只给结论。
    const more = document.createElement('details')
    const sum = document.createElement('summary')
    sum.textContent = '完整记录'
    more.appendChild(sum)

    const chips = document.createElement('div')
    chips.className = 'chips'
    const addChip = (txt, warn) => {
      const c = document.createElement('span')
      c.className = 'chip' + (warn ? ' warn' : '')
      c.textContent = txt
      chips.appendChild(c)
    }
    if (p.layer) addChip(p.layer)
    addChip(labelOfOrigin(p.origin) + ' 来源', p.origin === 'engram')
    addChip('引用 ' + (p.sources || 0) + ' 处', !(p.sources > 0))
    if (nb) addChip('邻居 ' + nb.size)
    // 这颗星身上有几条真实关系、各是什么类型。颜色和画面/图例一致，
    // 读法统一：红=矛盾、赭=取代、灰=佐证/细化。
    const relCount = {}
    for (const edge of edges) {
      if (edge.a !== id && edge.b !== id) continue
      relCount[edge.kind] = (relCount[edge.kind] || 0) + 1
    }
    for (const kind of REL_LEGEND) {
      if (!relCount[kind]) continue
      const rc = document.createElement('span')
      rc.className = 'chip'
      rc.style.color = 'rgb(' + REL[kind].color.join(',') + ')'
      rc.textContent = REL[kind].label + ' ' + relCount[kind]
      chips.appendChild(rc)
    }
    more.appendChild(chips)

    const body = document.createElement('div')
    body.className = 'body'
    body.textContent = p.content || p.text || ''
    more.appendChild(body)

    const rows = [['ID', p.id]]
    if (p.createdAt) rows.push(['记于', new Date(p.createdAt).toLocaleString('zh-CN')])
    if (p.validFrom || p.validUntil) rows.push(['有效期', (p.validFrom || '…') + ' → ' + (p.validUntil || '…')])
    for (const kv of rows) {
      const row = document.createElement('div')
      row.className = 'row'
      const kk = document.createElement('div'); kk.className = 'k'; kk.textContent = kv[0]
      const vv = document.createElement('div'); vv.className = 'v'; vv.textContent = kv[1]
      row.appendChild(kk); row.appendChild(vv)
      more.appendChild(row)
    }
    elDetail.appendChild(more)

    elCtx.textContent = ''
    elCtx.classList.add('show')
    const addBtn = (label, fn) => {
      const b = document.createElement('button')
      b.className = 'btn'; b.textContent = label; b.onclick = fn
      elCtx.appendChild(b)
    }
    addBtn('回到全部 (Esc)', () => exitFocus())
    addBtn('复制 ID', () => { if (navigator.clipboard) navigator.clipboard.writeText(p.id) })
    addBtn('去列表里搜', () => { location.href = '/dsh-brain?q=' + encodeURIComponent(p.text || '') })
  }

  function showTip(id, mx, my) {
    if (!id) { elTip.classList.remove('show'); return }
    const p = points.find((x) => x.id === id)
    if (!p) { elTip.classList.remove('show'); return }
    elTip.textContent = ''
    const b = document.createElement('b')
    b.textContent = p.text || '(无摘要)'
    elTip.appendChild(b)
    const nb = neighborMap.get(id)
    const meta = document.createElement('div')
    meta.style.cssText = 'margin-top:4px;font-size:10.5px;color:#79818d'
    meta.textContent = labelOfType(p.type) + ' · ' + labelOfOrigin(p.origin) + ' · 引用 ' + (p.sources || 0) + ' 处' + (nb ? ' · 邻居 ' + nb.size : '')
    elTip.appendChild(meta)
    elTip.classList.add('show')
    elTip.style.left = Math.max(6, Math.min(mx + 14, VW - 296)) + 'px'
    elTip.style.top = Math.max(6, Math.min(my + 14, VH - 86)) + 'px'
  }

  canvas.addEventListener('mousedown', (e) => {
    canvas.classList.add('dragging')
    dragging = { x: e.clientX, y: e.clientY, yaw: cam.yaw, pitch: cam.pitch, panX: cam.panX, panY: cam.panY, right: e.button === 2 }
    dragMoved = false
  })
  window.addEventListener('mousemove', (e) => {
    if (dragging) {
      const dx = e.clientX - dragging.x
      const dy = e.clientY - dragging.y
      if (Math.abs(dx) + Math.abs(dy) > 3) dragMoved = true
      if (dragging.right) {
        cam.panX = dragging.panX + dx * 1.6
        cam.panY = dragging.panY + dy * 1.6
        // 拖拽是直接操纵：目标值必须同步，否则松手后相机会被插值拉回去
        camTarget.panX = cam.panX
        camTarget.panY = cam.panY
      } else {
        cam.yaw = dragging.yaw + dx * 0.006
        cam.pitch = Math.max(-1.4, Math.min(1.4, dragging.pitch + dy * 0.006))
        camTarget.yaw = cam.yaw
        camTarget.pitch = cam.pitch
      }
      elTip.classList.remove('show')
      hoverEdgeKey = null
    } else {
      // 拾取与浮窗都用**视窗本地坐标**：画布不再从页面左上角起算（见 localXY 注释）
      const at = localXY(e)
      const id = pickAt(at.x, at.y)
      hovered = id
      // 星优先：落在一颗星上就只讲这颗星，不当成「边」来悬停。
      // 没星才试边——真实关系边就那么几条，悬停要能命中。
      const seg = id ? null : pickEdge(at.x, at.y)
      hoverEdgeKey = seg ? edgeKey(seg.edge) : null
      canvas.style.cursor = (id || seg) ? 'pointer' : 'grab'
      if (seg) showEdgeTip(seg, at.x, at.y)
      else showTip(id, at.x, at.y)
    }
  })
  window.addEventListener('mouseup', (e) => {
    canvas.classList.remove('dragging')
    if (dragging && !dragMoved && !dragging.right) {
      const at = localXY(e)
      const id = pickAt(at.x, at.y)
      if (id) showDetail(id)
      else {
        const seg = pickEdge(at.x, at.y)
        // 点边 → 关系面板（类型/原因/两端/建立时间）
        if (seg) showEdgeDetail(seg.edge)
        // 点空白退出聚焦——不然进了局部就没出口了
        else if (focusMode) exitFocus()
      }
    }
    dragging = null
  })
  canvas.addEventListener('contextmenu', (e) => e.preventDefault())
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    // 滚轮要即时响应（交互反馈不能有延迟感），所以两边一起改
    const next = Math.max(420, Math.min(2600, camTarget.dist + e.deltaY * 1.1))
    camTarget.dist = next
    cam.dist = next
  }, { passive: false })

  document.getElementById('modes').addEventListener('click', (e) => {
    const btn = e.target.closest('.mode')
    if (!btn) return
    mode = btn.dataset.mode
    for (const b of document.querySelectorAll('.mode')) b.classList.toggle('on', b === btn)
    // 时间模式的布局是沿 x 轴展开的，用默认的 45° yaw 看会把时间轴转成一条竖线。
    // 切过去时把相机放平一点，时间才「横着流」。
    if (mode === 'time') {
      camTarget.yaw = 0.06
      camTarget.pitch = -0.10
      camTarget.dist = 1400
      camTarget.panX = 0
      camTarget.panY = 0
    }
    layout(points)
    recalTimeRange()
    buildFilters()
    refreshStats()
  })

  const qEl = document.getElementById('q')
  qEl.addEventListener('input', () => { query = qEl.value.trim(); refreshStats() })

  // ── 视窗右上两颗按钮 ──
  const btnSpin = document.getElementById('btnSpin')
  const btnReset = document.getElementById('btnReset')
  // 重置视角：退聚焦 + 相机归位，顺手把自动旋转停掉——
  // 按了「重置」却还在转，用户会以为按钮没生效。
  btnReset.onclick = () => {
    exitFocus()
    if (autoSpin) {
      autoSpin = false
      if (btnSpin) { btnSpin.classList.remove('on'); btnSpin.textContent = '自动旋转' }
    }
  }
  if (btnSpin) {
    // 自动旋转只推 camTarget.yaw，转动仍走既有的指数插值，所以是「缓缓转」不是「跳着转」
    btnSpin.onclick = () => {
      autoSpin = !autoSpin
      btnSpin.classList.toggle('on', autoSpin)
      btnSpin.textContent = autoSpin ? '停止旋转' : '自动旋转'
    }
  }

  // ── 筛选面板：默认收起，左上角按钮切换 ──
  const btnFilter = document.getElementById('btnFilter')
  if (btnFilter && elSide) {
    btnFilter.onclick = () => {
      const open = elSide.classList.toggle('open')
      btnFilter.classList.toggle('on', open)
      btnFilter.setAttribute('aria-expanded', open ? 'true' : 'false')
    }
  }

  document.getElementById('btnRecent').onclick = (e) => {
    recentOnly = !recentOnly
    e.target.textContent = recentOnly ? '看全部' : '只看最近'
    e.target.classList.toggle('on', recentOnly)
    refreshStats()
  }

  // 背景弱边开关：默认关。打开只是「看一眼同簇相邻」，不产生、也不改变任何真实关系。
  // 关掉后立刻回到「只有真关系」——这个开关不该有记忆，也不该影响其它任何状态。
  function toggleBackground() {
    showBackground = !showBackground
    rebuildFocusKeep()
    if (legendBuilt) syncLegendState()
    else buildLegend()
    refreshStats()
  }

  const bgToggleEl = document.getElementById('bgToggle')
  if (bgToggleEl) bgToggleEl.addEventListener('click', toggleBackground)

  // 退出聚焦：Esc 和空格都行（参考视频的提示写的就是 PRESS SPACE TO EXIT）。
  // 空格只在聚焦态拦——不然会把页面滚动一起吃掉。
  // Esc 的层次是「一次只退一层」：先关关系面板，再退聚焦，跟「进入一个局部」的心智一致。
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.code === 'Space') {
      if (!focusMode) return
      e.preventDefault()
      exitFocus()
      return
    }
    if (e.key !== 'Escape' && e.key !== 'Esc') return
    if (selectedEdgeKey) closeEdgeDetail()
    else if (focusMode) exitFocus()
  })

  window.addEventListener('resize', resize)
  resize()
  load()
  requestAnimationFrame(frame)
  setInterval(load, 30000)

  // 调试钩子：只在 ?debug 时暴露，生产页面不留全局入口。
  // 用途：自动化验证聚焦行为（点星 → 只留邻居 + 镜头拉近）、边分类与背景开关，
  // 不用靠肉眼看。截图验收也是靠它把开关切一遍。
  if (location.search.indexOf('debug') >= 0) {
    window.__sea = {
      showDetail,
      showEdgeDetail,
      exitFocus,
      points: () => points,
      edges: () => edges,
      backgroundEdges: () => backgroundEdges,
      showBackground: () => showBackground,
      toggleBackground,
      degraded: () => edgesDegraded,
      focus: () => focusMode,
      cam: () => Object.assign({}, cam),
      /**
       * 用页面**自己的** project() 算某颗星的屏幕坐标。
       * 专门给「点星后是否真的居中」做可量化验收——不靠肉眼看截图。
       * 返回 dx/dy = 距视口中心的像素差，理想值 0。
       */
      projectOf: (id) => {
        const target = points.find((entry) => entry.id === String(id))
        if (!target) return null
        const r = project(target, performance.now())
        return {
          x: r.x,
          y: r.y,
          width: VW,
          height: VH,
          dx: Math.round((r.x - VW / 2) * 100) / 100,
          dy: Math.round((r.y - VH / 2) * 100) / 100,
        }
      },
      visible: () => visiblePoints().length,
      // 手动推进一帧：自动化验收里切完开关要立刻看到新的线，
      // 而 requestAnimationFrame 在 DOM stub 里只放两帧，等不到下一帧。
      paint: () => frame(performance.now()),
    }
  }
})()
</script>
</body>
</html>

<!--
视觉与三维算法思路来自：
  3d-memory-sea — https://github.com/asdfd3/3d-memory-sea
  MIT License · Copyright (c) asdfd3
  三维投影、斐波那契球面布簇、深度排序遮挡、Canvas 2D 渲染思路来自该项目。

交互骨架参考 Stellaris（Paradox Development Studio）：
  地图模式切换（同一数据换维度着色）、左侧常驻边栏、右侧上下文面板、
  顶部状态条、底部上下文工具栏、hover 即时反馈。
  只借交互模式，未使用任何游戏资源或代码。
-->
`
}