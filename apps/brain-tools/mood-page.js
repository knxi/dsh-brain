// @ts-check
/**
 * 外置大脑 · 心情页（/dsh-brain/mood，内嵌在 DSH Web 里，同源无额外端口）
 *
 * ── 这页要解决什么 ──
 *
 * 心情 / 精力 / 亲密度是三个**会自己演化**的数（`plugins/dsh-fox-mood/core.js` 的
 * `evolve`：按小时回精力、按长期不动降心情），它们决定我说话的语气、要不要主动开口、
 * 亲密度够不够喊人。但之前这三格里发生的事只有提示词里看得见——人只能从我的语气里猜，
 * 而语气是最容易骗人的东西。
 *
 * 所以这页做三件事：现在是多少、定性词是什么、最近怎么回事。
 * 顺带明确一件事：**情绪也是要跟着记忆一起备份的数据**，所以它得能看、能核对，
 * 而不是黑盒里一个数字。
 *
 * ── 口径纪律（照 CONTRACTS §17.2 / §18.4）──
 *
 * - 缺字段一律显示「–」，**绝不编 0**。`state === null`（主账没情感表、插件备档也读不到）
 *   时三个数字都是「–」，因为「没记录」和「记 0 分」是两件事，混了就把「读不到」说成
 *   「它心情归零了」——后果完全不同。
 * - 定性词照抄 `plugins/dsh-fox-mood/core.js` 的 `describeMood / describeEnergy /
 *   describeBond`，**不自己发明一套**：同一条 86 分在提示词里叫「很好，有点飘」、
 *   在页面上叫「优秀」，读的人会以为是两件事。三张档位表逐字对齐那边。
 * - 事件的中文标签优先用接口给的 `label`（后端已按 EVENT_EFFECTS 映射好），
 *   只有在 label 缺失时才用本页这份兜底表——不维护第二个真相。
 *
 * ── 三个状态都得写对（这页最容易偷懒的地方）──
 *
 *   1. 有数据：三格数字 + 定性词 + 时间线（时间 / 中文标签 / 备注 / delta）。
 *   2. 有状态但事件为空：「还没有情感记录」+ 一句这页为什么存在。
 *   3. `state === null`：三格「–」+ 顶部说明「这是没记录，不是 0 分」。
 *
 * 视觉沿用项目既定语言：near-black 仪器面板、单一琥珀强调、等宽数字、留白克制
 *（2026-11-01 换版：纸感浅色 → 近黑；骨架与 token 收进 theme.js，这页只留状态与时间线）。
 * 涨（delta > 0）用 --ok 绿、跌用 --bad 红，**零不动不显示**——一排 +0 只是噪声。
 */

// 导航与页面骨架统一收在 nav.js（品牌条 / 标题区 / 粘性导航只在那定义一次）。
// 样式已并入 theme.js 的注入区，这里不再引 NAV_CSS。
import { renderPageHead } from './nav.js?v=1793594997081'

/** @param {{ scopeId?: string }} [opts] */
export function renderMoodPage({ scopeId } = {}) {
  const escapedScope = String(scopeId == null ? '' : scopeId).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 心情</title>
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
/* ── 这一页只剩三件 theme 没覆盖的事 ──
   骨架（品牌条 / 标题区 / 路径行 / 页脚 / 导航 / 滚动条 / 焦点环）、时间线
   （.ev/.ev-when/.ev-main/.ev-label/.ev-note/.ev-delta/.dl）、面板、空态、说明条、
   统计条的容器样式全在 theme.js 的组件层里，页面不再复写。 */

/* 诊断条：左缘一道 2px 状态线，比整块换底色克制 */
.diag{margin:0 0 18px;padding:11px 16px;border-radius:var(--r-sm);font-size:13px;
  background:var(--card);border:1px solid var(--line);border-left:2px solid var(--line);
  line-height:1.7;box-shadow:0 1px 2px rgba(23,32,60,.04)}
.diag.warn{border-left-color:var(--warn);background:var(--warn-soft);color:#9a5f0d}

.meta{display:flex;gap:22px;flex-wrap:wrap;font-size:12px;color:var(--muted);margin-bottom:22px}
.meta b{font-weight:550;color:var(--ink-2);font-family:var(--mono);font-size:11.5px;margin-left:5px;
  font-variant-numeric:tabular-nums}

/* theme 的 .note 是 margin:0（给面板脚用的），这页它独立成段，需要一点间距 */
.note{margin-top:22px}
.note code{font-size:11.5px}

/* ══ 三维情感环图（2026-11-02 第二版）══
   第一版我画成了三维散点轨迹，主人给了参考图——他要的是**信息图式的环形进度**。
   环形图其实比散点更对该页的用途：一眼读完「几分之几」，不需要先建立坐标系；
   而「怎么走到这里的」交给下面那条事件带，两件事分开表达，主视觉只有一个。 */
.rings{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;align-items:start;
  padding:6px 0 2px}
.ring{display:flex;flex-direction:column;align-items:center;gap:5px}
/* 环用 conic-gradient 画：--ring-p 是 0..100 的百分比，--ring-c 是这一维的颜色。
   inset 的白色内圆把实心饼切成环，比 SVG 少一堆元素，也更容易跟着主题走。 */
.ring-donut{position:relative;width:100%;max-width:164px;aspect-ratio:1/1;border-radius:50%;
  background:conic-gradient(var(--ring-c,#c9d2e0) calc(var(--ring-p,0) * 1%), var(--raise) 0)}
.ring-core{position:absolute;inset:14%;border-radius:50%;background:var(--card);
  display:flex;flex-direction:column;align-items:center;justify-content:center}
.ring-core b{font-family:var(--mono);font-weight:600;font-size:26px;color:var(--ink);
  letter-spacing:-.03em;font-variant-numeric:tabular-nums;line-height:1.1}
.ring-core span{font-family:var(--mono);font-size:8.5px;color:var(--faint);letter-spacing:.12em}
.ring-k{font-size:12.5px;color:var(--ink);letter-spacing:.02em}
.ring-n{font-size:11px;color:var(--muted);text-align:center;line-height:1.5}
@media(max-width:640px){
  .rings{grid-template-columns:minmax(0,1fr)}
  .ring-donut{max-width:140px}
}

/* 事件带：环图下面的时间维度。
   环形图讲「现在是什么状态」，这条带讲「怎么走到这里的」。
   每条事件一根细竖条：颜色 = 事件类型，高度 = 变化幅度，越靠右越新。
   宽度封在 16px——让它读起来像一条时间带，而不是一排色块。 */
.evband-wrap{margin-top:18px;padding-top:14px;border-top:1px solid var(--line-soft)}
.evband{display:flex;align-items:flex-end;justify-content:center;gap:4px;height:56px}
.evband i{width:100%;max-width:16px;min-width:4px;border-radius:2px 2px 0 0;cursor:default;
  opacity:.8;transition:opacity .15s var(--ease-soft),transform .15s var(--ease-out);
  transform-origin:bottom center}
.evband i:hover{opacity:1;transform:scaleY(1.12)}
.evband-foot{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:8px;
  font-size:10px;font-family:var(--mono);color:var(--faint);letter-spacing:.06em}
.evband-foot span{display:inline-flex;align-items:center;gap:5px}
.evband-foot em{width:6px;height:6px;border-radius:50%;font-style:normal;display:inline-block}
</style>
</head>
<body>
<div class="wrap">
  ${renderPageHead({
    active: 'mood',
    title: '心情',
    sub: '心情 / 精力 / 亲密三个数由插件按时间和事件自己演化。这页只读——能看见、能核对，才不会被一句「还好」糊过去。'
  })}
  <div class="path">scope: ${escapedScope} · /dsh-brain/api/mood</div>

  <div id="top-note"></div>

  <div class="meta">
    <span>数据来源 <b id="meta-source">–</b></span>
    <span>状态更新于 <b id="meta-updated">–</b></span>
    <span>最近互动 <b id="meta-interact">–</b></span>
    <span>事件 <b id="meta-count">–</b></span>
  </div>

  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">三维情感</span>
      <span class="panel-meta" id="ev-meta">–</span>
    </div>
    <div class="panel-body">
      <div class="rings" id="rings"></div>
      <!-- 事件带：最近 N 条事件按时间排成一条小条阵。
           环形图讲「现在是什么状态」，这条带讲「怎么走到这里的」——
           两者缺一个都不完整，但主视觉只该有一个，所以它做得很轻。 -->
      <div class="evband-wrap">
        <div class="evband" id="evband"></div>
        <div class="evband-foot"><span>最近事件（旧 → 新）</span><span id="evband-legend"></span></div>
      </div>
      <div id="orbit-tip"></div>
      <div id="orbit-empty"></div>
    </div>
  </div>

  <p class="note">
    <b>这页为什么存在：</b>三个数不是每次现编的——它们由
    <code>plugins/dsh-fox-mood/core.js</code> 的 <code>evolve</code> 按时间和事件自己演化，
    决定我主动说话的分寸和称呼。既然它会影响我说出口的每句话，就不该只在提示词里黑着：
    能看见、能核对，才不会被一句「还好」糊过去。它也是**要跟着记忆一起备份的数据**。
    <b>定性词和提示词里的是同一套口径</b>，页面上写着什么，我收到的就是什么。
  </p>

  <div class="foot">
    <span>只读视图 · 数据来自 /dsh-brain/api/mood</span>
    <span style="flex:1"></span>
    <a href="/dsh-brain">回记忆</a>
  </div>
</div>
<script>
(function(){
  var API = '/dsh-brain/api/mood'
  // 缺字段一律显示「–」，不编 0（CONTRACTS §17.2 / §18.4）。
  var DASH = '–'

  function el(tag, cls, text){
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }
  function txt(id, v){ var n = document.getElementById(id); if (n) n.textContent = v }
  function readTxt(id){ var n = document.getElementById(id); return n ? n.textContent : '' }
  function isNum(v){ return typeof v === 'number' && isFinite(v) }

  // ── 定性词：逐字照抄 plugins/dsh-fox-mood/core.js 的三张档位表 ──────────
  // 那边是给提示词说人话用的；这边是给人看的。同一个数字必须落同一个词，
  // 否则「页面上写 86 很好」和「提示词里写 86 还算平稳」会互相打脸。
  function describeMood(v){
    if (v >= 85) return '很好，有点飘'
    if (v >= 70) return '不错'
    if (v >= 55) return '还算平稳'
    if (v >= 40) return '有点低落'
    if (v >= 25) return '明显不开心'
    return '很糟，别招我'
  }
  function describeEnergy(v){
    if (v >= 85) return '精神得很'
    if (v >= 70) return '清醒'
    if (v >= 55) return '正常'
    if (v >= 40) return '有点乏'
    if (v >= 25) return '很困，脑子发钝'
    return '快没了，只想瘫着'
  }
  function describeBond(v){
    if (v >= 85) return '很熟，能互相损'
    if (v >= 70) return '亲近，说话可以不客气'
    if (v >= 55) return '熟悉，会开点玩笑'
    if (v >= 40) return '认识了，开始有默契'
    if (v >= 25) return '刚认识不久，客气但真诚'
    return '还很生分'
  }

  // ── 事件中文标签兜底表 ─────────────────────────────────────────────
  // 接口已经按 EVENT_EFFECTS 给了 label，正常情况用不上这张表；
  // 留着只是为了「label 缺了就退回 kind」，而不是让页面上出现英文 kind。
  var KIND_LABEL = {
    praise: '被夸了', retasked: '被返工', pushed: '被催了', interesting: '碰到有意思的东西',
    success: '事情办成了', failure: '办砸了', late_night: '深夜还陪着', long_absence: '好久没见了',
    chat: '聊了几句', rest: '歇了一会儿'
  }
  function kindLabel(k){
    if (typeof k === 'string' && k !== '') return KIND_LABEL[k] || k
    return '未知事件'
  }

  // delta 的固定顺序：心情 / 精力 / 亲密。零不动不显示。
  var DELTA_KEYS = [['mood', '心情'], ['energy', '精力'], ['bond', '亲密']]

  function fmtWhen(v){
    if (v === null || v === undefined || v === '') return DASH
    var d = typeof v === 'number' ? new Date(v) : new Date(String(v))
    if (isNaN(d.getTime())) return String(v)
    var p = function(n){ return String(n).padStart(2, '0') }
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  }

  function sourceText(s){
    if (s === 'brain') return '主账'
    if (s === 'state.json') return '插件备档'
    if (s === 'unavailable') return '读不到'
    if (typeof s === 'string' && s !== '') return s
    return DASH
  }

  // 页面运行态。不挂到 DOM 上——DOM stub 里读不到子节点拼起来的文本，
  // 所以渲染时同步记一份，供 window.__mood.state() 与断言用（记的**就是**写进 DOM 的内容）。
  var view = {
    status: 'loading',    // loading / ok / nostate / error
    source: null,
    hasState: false,
    state: null,          // 最近一次读到的三维状态；环图和 __mood.state() 用同一份
    events: 0,
    eventsEmpty: false,
    error: null,
    topNote: '',
    rendered: [],         // [{ when, label, note, delta: ['心情 +7', ...] }]
    meta: { source: DASH, updated: DASH, interact: DASH, count: DASH }
  }

  function setTopNote(text, warn){
    var host = document.getElementById('top-note')
    if (host) host.textContent = ''
    view.topNote = text || ''
    if (host && text) host.appendChild(el('div', warn ? 'diag warn' : 'diag', text))
  }

  // emptyBox / deltaRow 随「文字事件列表」一起退役了（2026-11-02）：
  // 空态现在压在环图下面，事件条用 title 出文字，都不再需要这两个构造器。
  // deltaTexts 保留——事件条的 title 还用它拼「心情 +1.7 · 亲密 +0.8」。
  function deltaTexts(delta){
    var out = []
    if (!delta || typeof delta !== 'object') return out
    for (var i = 0; i < DELTA_KEYS.length; i++){
      var v = delta[DELTA_KEYS[i][0]]
      if (!isNum(v) || v === 0) continue
      out.push(DELTA_KEYS[i][1] + ' ' + (v > 0 ? '+' : '') + String(v))
    }
    return out
  }

  // ── 三维环图 + 事件带（2026-11-02 第二版）──────────────────────────
  //
  // 第一版画的是三维散点轨迹，主人给了参考图：要的是**信息图式的环形进度**。
  // 环形图更贴这页的用途——一眼读完「几分之几」，不用先建立坐标系；
  // 「怎么走到这里的」交给下面那条事件带。两件事分开表达，主视觉只留一个。
  //
  // 用 CSS conic-gradient 而不是 SVG：环是平面的，不需要矢量缩放；
  // 而且纯 DOM 在页面探测的 DOM stub 里也能渲染（SVG 那几个 createElementNS 会挂）。
  /** 事件类型 → 颜色。事件带和图例共用这一张表，不会出现「图例说青的、画出来是紫的」。 */
  var KIND_COLOR = {
    praise:       [ 89, 227, 255],
    success:      [ 47, 200, 140],
    failure:      [214,  69,  69],
    retasked:     [221, 127,  14],
    pushed:       [230, 190,  60],
    interesting:  [160, 130, 246],
    chat:         [110, 168, 255],
    rest:         [120, 160, 190],
    late_night:   [139, 124, 246],
    long_absence: [140, 160, 200]
  }
  function kindRgb(kind){ return KIND_COLOR[kind] || [140, 160, 200] }

  var RING = [
    { key: 'mood',   label: '心情', color: '#1FA9BC', desc: describeMood },
    { key: 'energy', label: '精力', color: '#3B5BDB', desc: describeEnergy },
    { key: 'bond',   label: '亲密', color: '#9B4F96', desc: describeBond }
  ]
  var EVBAND_MAX = 24

  /** 三道环形进度。没有数据时环是空的、数字显示 –（不编 0）。 */
  function renderRings(state){
    var host = document.getElementById('rings')
    if (!host) return
    host.textContent = ''
    for (var i = 0; i < RING.length; i++){
      var dim = RING[i]
      var raw = state ? state[dim.key] : null
      var has = isNum(raw)
      var v = has ? Math.max(0, Math.min(100, raw)) : 0

      var wrap = el('div', 'ring')
      var donut = el('div', 'ring-donut')
      donut.style.setProperty('--ring-c', dim.color)
      donut.style.setProperty('--ring-p', String(v))
      if (!has) donut.style.setProperty('--ring-c', 'transparent')

      var core = el('div', 'ring-core')
      core.appendChild(el('b', null, has ? String(Math.round(raw)) : DASH))
      core.appendChild(el('span', null, '/100'))
      donut.appendChild(core)

      wrap.appendChild(donut)
      wrap.appendChild(el('div', 'ring-k', dim.label))
      wrap.appendChild(el('div', 'ring-n', has ? dim.desc(raw) : '没有记录'))
      host.appendChild(wrap)
    }
  }

  /**
   * 事件带：最近 N 条事件，每根竖条一次事件。
   * 颜色 = 事件类型（跟图例同一张表），高度 = 这条事件的总体变化幅度，越右越新。
   * 悬停用原生 title——这里只有一行信息，不值得再造一个浮窗。
   */
  function renderEvBand(list){
    var host = document.getElementById('evband')
    var legend = document.getElementById('evband-legend')
    if (host) host.textContent = ''
    if (legend) legend.textContent = ''
    if (!host || !Array.isArray(list) || list.length === 0) return

    var recent = list.slice(0, EVBAND_MAX).slice().reverse()   // 旧 → 新
    var maxMag = 1
    var mags = []
    var seen = []
    for (var i = 0; i < recent.length; i++){
      var d = (recent[i] && recent[i].delta && typeof recent[i].delta === 'object') ? recent[i].delta : {}
      var mag = Math.abs(isNum(d.mood) ? d.mood : 0)
        + Math.abs(isNum(d.energy) ? d.energy : 0)
        + Math.abs(isNum(d.bond) ? d.bond : 0)
      mags.push(mag)
      if (mag > maxMag) maxMag = mag
    }
    for (var j = 0; j < recent.length; j++){
      var e = recent[j] || {}
      var rgb = kindRgb(e.kind)
      var label = (typeof e.label === 'string' && e.label !== '') ? e.label : kindLabel(e.kind)
      var bar = el('i')
      bar.style.height = Math.round(9 + (mags[j] / maxMag) * 42) + 'px'
      bar.style.background = 'rgb(' + rgb.join(',') + ')'
      bar.title = fmtWhen(e.at) + ' · ' + label
        + (deltaTexts(e.delta).length ? ' · ' + deltaTexts(e.delta).join(' · ') : '')
      host.appendChild(bar)
      if (seen.indexOf(e.kind) < 0) seen.push(e.kind)
    }
    if (legend){
      for (var k = 0; k < seen.length && k < 5; k++){
        var sp = el('span')
        var dot = el('em')
        dot.style.background = 'rgb(' + kindRgb(seen[k]).join(',') + ')'
        sp.appendChild(dot)
        sp.appendChild(document.createTextNode(kindLabel(seen[k])))
        legend.appendChild(sp)
      }
    }
  }

  function renderViz(list, state){
    var empty = document.getElementById('orbit-empty')
    if (empty) empty.classList.remove('show')
    view.rendered = []
    renderRings(state)

    if (!Array.isArray(list)){
      // 没给 events 字段：这是「读不到」，不是「没有记录」——两者不能混。
      view.events = 0
      view.eventsEmpty = false
      txt('ev-meta', '数据缺失')
      renderEvBand([])
      return
    }
    view.events = list.length
    if (list.length === 0){
      view.eventsEmpty = true
      txt('ev-meta', '0 条')
      renderEvBand([])
      return
    }
    var recent = list.slice(0, EVBAND_MAX)
    txt('ev-meta', '最近 ' + recent.length + ' 条（共 ' + list.length + '）')
    for (var i = 0; i < recent.length; i++){
      var e = recent[i] || {}
      view.rendered.push({
        when: fmtWhen(e.at),
        label: (typeof e.label === 'string' && e.label !== '') ? e.label : kindLabel(e.kind),
        note: (typeof e.note === 'string' && e.note !== '') ? e.note : null,
        delta: deltaTexts(e.delta)
      })
    }
    renderEvBand(recent)
  }

  function renderMeta(d, state){
    var stats = d.stats && typeof d.stats === 'object' ? d.stats : null
    view.meta.source = sourceText(d.source)
    view.meta.updated = state ? fmtWhen(state.updatedAt) : DASH
    view.meta.interact = state ? fmtWhen(state.lastInteractAt) : DASH
    view.meta.count = (stats && isNum(stats.events)) ? String(stats.events) + ' 条' : DASH
    txt('meta-source', view.meta.source)
    txt('meta-updated', view.meta.updated)
    txt('meta-interact', view.meta.interact)
    txt('meta-count', view.meta.count)
  }

  function renderAll(d){
    var state = (d.state && typeof d.state === 'object') ? d.state : null
    view.state = state
    view.hasState = state !== null
    view.error = null
    renderMeta(d, state)
    if (state === null){
      view.status = 'nostate'
      setTopNote('没有读到情感状态：主账的情感表还没数据，插件备档也读不到。'
        + '三个环是空的——这是「没有记录」，不是 0 分。', true)
    } else {
      view.status = 'ok'
      setTopNote('')
    }
    renderViz(d.events, state)
  }

  function fail(message){
    view.status = 'error'
    view.error = message
    view.hasState = false
    view.state = null
    view.events = 0
    view.eventsEmpty = false
    view.rendered = []
    view.meta.source = DASH
    view.meta.updated = DASH
    view.meta.interact = DASH
    view.meta.count = DASH
    txt('meta-source', DASH)
    txt('meta-updated', DASH)
    txt('meta-interact', DASH)
    txt('meta-count', DASH)
    setTopNote('读不到情感状态：' + message + '。三个环是空的——状态未知，不是 0。', true)
    renderViz(null, null)
    txt('ev-meta', '读取失败')
  }

  function load(){
    view.status = 'loading'
    return fetch(API, { credentials: 'same-origin' })
      .then(function(r){ return r.json() })
      .then(function(d){
        if (!d || d.ok !== true){
          fail((d && d.message) ? String(d.message) : '接口没有返回 ok:true')
          return
        }
        renderAll(d)
      }, function(e){
        fail((e && e.message) ? String(e.message) : String(e))
      })
      .then(function(){ return view })
  }

  // ── 自动化钩子（verify-pages / 本地 probe 用）──────────────────────
  // DOM stub 里 addEventListener 是空实现、querySelector 恒为 null，
  // 所以断言不能靠「点一下再看」。这里把运行态与**已渲染进 DOM 的内容**摊出来：
  //   window.__mood.state()   -> { status, hasState, numbers, texts, meta, rendered, eventsEmpty, topNote }
  //   window.__mood.reload()  -> Promise，重跑一次真实加载路径
  var moodApi = {
    state: function(){
      return {
        status: view.status,
        source: view.source,
        hasState: view.hasState,
        events: view.events,
        eventsEmpty: view.eventsEmpty,
        error: view.error,
        topNote: view.topNote,
        // 三个数不再单独占一栏（跟环图重复，2026-11-02 删掉那排大数字），
        // 所以这两个字段改成**从环图用的同一份 state 读**，而不是从已删的 DOM 读。
        // 字段形状保持不变——调用方（探测脚本）不用改。
        numbers: {
          mood: (view.state && isNum(view.state.mood)) ? String(Math.round(view.state.mood)) : DASH,
          energy: (view.state && isNum(view.state.energy)) ? String(Math.round(view.state.energy)) : DASH,
          bond: (view.state && isNum(view.state.bond)) ? String(Math.round(view.state.bond)) : DASH
        },
        texts: {
          mood: (view.state && isNum(view.state.mood)) ? describeMood(view.state.mood) : DASH,
          energy: (view.state && isNum(view.state.energy)) ? describeEnergy(view.state.energy) : DASH,
          bond: (view.state && isNum(view.state.bond)) ? describeBond(view.state.bond) : DASH
        },
        meta: {
          source: readTxt('meta-source'),
          updated: readTxt('meta-updated'),
          interact: readTxt('meta-interact'),
          count: readTxt('meta-count')
        },
        rendered: view.rendered.slice()
      }
    },
    reload: load
  }
  if (typeof window !== 'undefined') window.__mood = moodApi

  load()
})()
</script>
</body>
</html>`
}
