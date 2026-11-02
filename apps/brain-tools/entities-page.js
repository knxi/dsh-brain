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

// 骨架统一收在 nav.js：品牌条 + 标题区 + 粘性导航整块是 renderPageHead()，
// 页面只说自己是谁（active）、叫什么（title）、一句话说明（sub）。
import { renderPageHead } from './nav.js?v=1793594997081'

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
/* ── 这一页自己的部分：筛选行 / 类型 tab / 实体分组 / 展开的记忆 ──
   统计条、搜索输入、徽章、说明条、空态、页脚全在 theme.js 的组件层里，这里不再复写。 */

/* 筛选行：搜索框走 theme 的 .input，这里只排一行并让它吃掉剩余宽度。 */
.filterbar{display:flex;gap:8px;align-items:center;margin-bottom:18px;flex-wrap:wrap}
.filterbar .input{flex:1;min-width:220px}

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
/* 徽章底板用 theme 的 .chip（别名走 .accent），这里只补「计数等宽 / 为零标红」。 */
.chip.n{cursor:default;font-variant-numeric:tabular-nums}
.chip.n.zero{background:var(--bad-soft);color:var(--bad)}
.ent-body{border-top:1px solid var(--line);padding:10px 15px;background:var(--card-2);display:none}
.ent.open .ent-body{display:block}
.mem{padding:6px 0;border-bottom:1px solid var(--line-soft);font-size:12.5px;color:var(--ink-2)}
.mem:last-child{border-bottom:none}
.mem-id{font-family:var(--mono);font-size:10.5px;color:var(--faint);cursor:pointer;margin-left:8px;
  transition:color .14s var(--ease)}
.mem-id:hover{color:var(--accent)}
</style>
</head>
<body>
<div class="wrap">
  ${renderPageHead({
    active: 'entities',
    title: '实体',
    sub: '记忆挂在谁名下——分布、孤儿、错标，一眼看见。'
  })}
  <div class="path">scope: ${escapedScope} · /dsh-brain/api/entities</div>

  <div class="stats" id="stats">
    <div class="stat"><span class="stat-k">实体</span><span class="stat-v" id="s-total">–</span></div>
    <div class="stat"><span class="stat-k">有记忆的</span><span class="stat-v" id="s-linked">–</span></div>
    <div class="stat"><span class="stat-k">孤儿</span><span class="stat-v" id="s-orphan">–</span></div>
    <div class="stat"><span class="stat-k">类型</span><span class="stat-v" id="s-kinds">–</span></div>
  </div>

  <div class="filterbar">
    <input class="input" type="search" id="q" placeholder="搜实体名或别名" autocomplete="off" spellcheck="false">
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
    ;(e.aliases || []).forEach(function(a){ row.appendChild(el('span', 'chip accent', esc(a))) })
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
