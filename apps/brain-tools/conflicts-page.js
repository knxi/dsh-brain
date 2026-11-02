// @ts-check
/**
 * 外置大脑 · 矛盾核验页面（/dsh-brain/conflicts，内嵌在 DSH Web 里，同源无额外端口）
 *
 * ── 这页要解决什么 ──
 *
 * M6 把 Engram 的 `contradicts` 迁进来了，共 6 条。它们**并列保留**——没有任何自动选边，
 * 因为「哪条对」这件事只有主人能判。但之前只能看 `/api/conflicts` 的 JSON，
 * 而判断需要的恰恰是并排看全文：同一个说法详略不同，还是真冲突，得读原文。
 *
 * 2026-10-30 起这页不只是看：判断完之后可以直接在这页做核验。
 * 依据 CONTRACTS §17.4「永不自动选边。人核验完再动手，动作要能回滚」——
 * 把「人已经做完判断之后的那一步」搬到页面上，而不是让人回命令行跑 merge-duplicates.mjs。
 *
 * ── 三个动作的语义（页面文案必须如实照这个写，不许含糊）──
 *
 * - keep-left ：留左侧，右侧被左侧取代。走门面 `memories.supersede`：右侧封口
 *               （status=superseded）、`valid_until` 落值、**正文一个字不删**、
 *               `asOf` 回看历史时刻仍能读到旧说法；随后删掉这条矛盾边。
 * - keep-right：反过来。
 * - not-conflict：两条记忆都不动，只把这条边从「矛盾」改标成「细化（refines）/
 *               佐证（supports）」（删矛盾边 + 建一条新 kind 的边）。
 *
 * 三个动作都必须**先把后果说清、再点第二下**才发请求（两步确认）。理由和
 * `tools/merge-duplicates.mjs` 默认 dry-run 是同一条：判断错了要能看见「刚才到底做了什么」
 * 和「怎么撤销」，不能一键落库。
 *
 * ── 为什么不用 window.confirm ──
 *
 * `tools/verify-pages.mjs` 的 DOM stub 里没有 confirm（也没有 alert），用了就是 TypeError，
 * 内联脚本跑不完、冒烟直接红。而且 confirm 只有一句话、不能随动作变文案、更说不出
 * 「valid_until 会落值、正文不删」——它挡不住误操作，只多了一次点击。
 * 所以这里用「按钮自己变成确认态 + 卡片里写出后果」：第一次点不落库，第二次才发请求，
 * 3 秒内不点第二次自动退回。
 *
 * 视觉沿用项目既定语言：近黑仪器面板、单一琥珀强调、等宽数字、留白克制
 * （2026-11-01 换版：纸感浅色 → 近黑；骨架与 token 收进 theme.js，这页只留并排卡片与动作区）。
 * 矛盾用唯一的红（--bad），因为这是全项目唯一「需要人现在处理」的状态；已核验用 --ok。
 * 动作区**不新造色值**，也**不引入第二个强调色**：只用 theme 里的
 * --accent / --accent-soft / --ok / --ok-soft / --bad / --bad-soft / --line / --card / --muted。
 */

// 骨架统一收在 nav.js：品牌条 + 标题区 + 粘性导航整块是 renderPageHead()，
// 页面只说自己是谁（active）、叫什么（title）、一句话说明（sub）。
import { renderPageHead } from './nav.js?v=1793594997081'

/** @param {{ scopeId: string }} opts */
export function renderConflictsPage({ scopeId }) {
  const escapedScope = String(scopeId).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>外置大脑 · 矛盾核验</title>
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
/* ── 这一页自己的部分：并排读的两栏 / 两步确认的动作区 / 核验结果提示 ──
   统计条 / 徽章 / 说明条 / 空态 / 页脚 / 选择框全在 theme.js 的组件层里，这里不再复写。 */

/* 说明条：整块红底会让人以为系统在报警，这里只在左边给一道 2px 红线。 */
.banner{background:var(--card);border:1px solid var(--line);border-left:2px solid var(--bad);
  border-radius:var(--r-sm);padding:15px 19px;margin-bottom:22px;color:var(--ink-2);
  font-size:13.5px;line-height:1.7}
.banner b,.banner strong{font-weight:620;color:var(--ink)}

/* 核验卡片就是 theme 的 .panel：已核验态只换边线色 + 头带一层 ok 软底。
   不改边框粗细——那一变布局跟着跳。序号是这页独有的刻度。 */
.panel.done{border-color:rgba(47,158,99,.32)}
.panel.done .panel-head{background:var(--ok-soft)}
.idx{font-family:var(--mono);font-size:11px;color:var(--faint);font-variant-numeric:tabular-nums}

/* 并排两栏：中间一条竖线当「对照」的轴，轴心那枚 ⇄ 用 theme 的 .vs-mid
   （字号/颜色/居中主题里已经有了，这里只把轴线补上）。 */
.pair{display:grid;grid-template-columns:minmax(0,1fr) 46px minmax(0,1fr);align-items:stretch}
.pair>.vs-mid{border-left:1px solid var(--line);border-right:1px solid var(--line)}
@media(max-width:900px){.pair{grid-template-columns:minmax(0,1fr)}}
.side{padding:18px 20px;min-width:0}
/* 右栏压一档底色：两段正文并排时，眼睛要靠底色认出「这是另一条」而不是同一条的续写。
   --card-2 在浅底上只差 1%，不够认，所以用 --raise。 */
.side.b{background:var(--raise)}
.side-tag{font-family:var(--mono);font-size:10.5px;color:var(--muted);letter-spacing:.08em;
  margin-bottom:8px;text-transform:uppercase}
/* 正文是这页的主角：行高放到 1.75，长段才有可读性。 */
.text{margin:0 0 12px;font-size:13.5px;line-height:1.75;white-space:pre-wrap;word-break:break-word}
.text.clamped{display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.more{font-family:inherit;font-size:11.5px;color:var(--accent);background:none;border:none;
  padding:0;cursor:pointer;text-decoration:underline dotted;text-underline-offset:2px;
  margin-bottom:10px}
.more:hover{color:var(--ink)}
/* 徽章底色/字体走 theme 的 .chip（实心 entity 用 .accent），这里只补排布和一个时间变体。 */
.side .chips{margin-bottom:10px}
.chip.time{font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.mid{display:flex;align-items:baseline;gap:10px;font-size:11px;color:var(--muted);
  border-top:1px solid var(--line);padding-top:9px;flex-wrap:wrap}
.mid code{font-size:10.5px;cursor:pointer}
.mid code:hover{background:var(--accent-soft);color:var(--accent)}

/* ── 动作区：每个动作第一次点只是把后果写出来，第二次才落库 ── */
.side-act{margin-top:11px}
.act{font-family:inherit;font-size:12px;padding:7px 13px;border-radius:var(--r-sm);line-height:1.45;
  border:1px solid var(--line);background:var(--card);color:var(--ink-2);
  cursor:pointer;text-align:left;
  transition:border-color .14s var(--ease),color .14s var(--ease),background .14s var(--ease)}
.act:hover{border-color:var(--accent-line);color:var(--accent)}
/* 确认态是实心靛蓝：第二步要一眼看出「按下去就真落库了」 */
.act.armed{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600}
.act.armed:hover{color:#fff}
.act.working{opacity:.55;cursor:progress;border-color:var(--line);color:var(--muted)}
.act.disabled{opacity:.4;cursor:not-allowed}
.act.disabled:hover{border-color:var(--line);color:var(--ink-2)}
.judge{display:flex;align-items:center;gap:10px;padding:12px 20px;border-top:1px solid var(--line);
  background:var(--card-2);flex-wrap:wrap}
.judge-label{font-size:12px;color:var(--muted)}

/* 提示条：两步确认的后果、执行结果、失败原因都走这里。 */
.hint{display:none;font-size:12.5px;line-height:1.8;white-space:pre-wrap;word-break:break-word}
.hint.show{display:block;padding:11px 20px;border-top:1px solid var(--line)}
.hint.pending{background:var(--accent-soft);color:var(--accent)}
.hint.ok{background:var(--card-2);color:var(--ok);border-left:2px solid var(--ok)}
.hint.bad{background:var(--bad-soft);color:var(--bad);border-left:2px solid var(--bad)}
.badge{font-size:10.5px;padding:1.5px 7px;border-radius:4px;font-weight:600;font-family:var(--mono);
  letter-spacing:.02em;border:1px solid transparent;line-height:1.6}
.badge:empty{display:none}
.badge.done{border-color:rgba(47,158,99,.34);color:var(--ok)}

.reason{padding:11px 20px;border-top:1px solid var(--line);font-size:12.5px;
  color:var(--muted);background:var(--card-2)}
.reason b{color:var(--ink);font-weight:550}

/* 空态沿用 theme 的 .empty，只把「没有待核验的矛盾」这句标成好消息色。 */
.empty strong{color:var(--ok)}

/* 页尾那段动作说明紧跟卡片列表，需要一点上间距（theme 的 .note 默认贴边，是给面板内用的）。 */
.note-gap{margin-top:18px}
</style>
</head>
<body>
<div class="wrap">
  ${renderPageHead({
    active: 'conflicts',
    title: '矛盾核验',
    sub: '并排读原文，然后在这里定——系统永不自动选边。'
  })}
  <div class="path">scope: ${escapedScope} · /dsh-brain/api/conflicts</div>

  <div class="banner">
    这些记忆<strong>两条都还活着</strong>，系统没有替你选边，也不会自动合并或删除——判断需要的不是相似度，
    是把两条原文并排读一遍。读完可以<strong>直接在这页定</strong>：每个动作第一次点只是把后果写给你看，
    第二次才真的落库。
  </div>

  <div class="stats" id="stats">
    <div class="stat"><span class="stat-k">待核验</span><span class="stat-v bad" id="s-total">–</span></div>
    <div class="stat"><span class="stat-k">全部关系</span><span class="stat-v" id="s-all">–</span></div>
    <div class="stat"><span class="stat-k">其中取代</span><span class="stat-v" id="s-sup">–</span></div>
    <div class="stat"><span class="stat-k">本次已核验</span><span class="stat-v ok" id="s-done">0</span></div>
  </div>

  <div id="list"><div class="empty">载入中…</div></div>

  <p class="note note-gap">
    <b>三个动作各自做什么</b>（点第二下之前，卡片里会把对应那条原话再写一遍）：
    「保留这条」= 这一条留下，另一条走 <code>supersedes</code> 封口（<code>valid_until</code> 落值、
    <b>正文一个字不删</b>、<code>asOf</code> 回看历史时刻仍能读到），然后删掉这条矛盾边；
    「两条都对，不是矛盾」= 两条记忆都不动，只把关系从「矛盾」改标成「细化 / 佐证」。
    <b>删是不可逆的，取代不是</b>——所以这里没有「直接删掉一条」的入口。
  </p>

  <div class="foot">
    <span>动作都留痕、都能撤销：每张卡核验完会给出撤销方式（rollbackHint）。系统永不自动选边。</span>
    <span style="flex:1"></span>
    <a href="/dsh-brain">回列表</a>
  </div>
</div>
<script>
(function(){
  var ACTION_URL = '/dsh-brain/api/conflicts/action'
  var LIST_URL = '/dsh-brain/api/conflicts?limit=200'
  // 两步确认的退回时限：3 秒够看清后果，又不至于离开工位回来还挂着「等你确认」。
  var CONFIRM_TTL = 3000
  // 本次页面里核验成功的卡片数（只影响顶部那一格，不参与任何库内统计）
  var doneCount = 0
  /** 每张卡的运行时状态：edgeId / busy / done / armed / timer / 按钮集合 */
  var CARDS = []

  function el(tag, cls, text){ var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n }
  function txt(id, v){ var n = document.getElementById(id); if (n) n.textContent = v }
  function fmt(iso){ if (!iso) return '–'; var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    var p = function(n){ return String(n).padStart(2,'0') }
    return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) }

  // ── 动作规格：label / confirmLabel / consequence 三样都必须如实描述后果 ──────
  // consequence 会在第一次点击后原样显示在卡片里，所以它必须说清「会动什么、不会动什么」。
  function keepSpec(act){
    var isLeft = act === 'keep-left'
    var keptSide = isLeft ? '左' : '右'
    var goneSide = isLeft ? '右' : '左'
    var keptTag = isLeft ? 'A' : 'B'
    var goneTag = isLeft ? 'B' : 'A'
    return {
      action: act,
      cls: isLeft ? 'act-keep-left' : 'act-keep-right',
      label: '保留这条（' + keptTag + '）',
      confirmLabel: '确认：' + goneSide + '侧封口 →',
      short: '保留' + keptSide + '侧、封口' + goneSide + '侧',
      consequence: keptSide + '侧（' + keptTag + '）原样保留，一个字都不改。' +
        goneSide + '侧（' + goneTag + '）会被标成「已被取代」：valid_until 落上今天的日期，' +
        '正文不删、asOf 回看历史时刻仍能读到它。然后删掉这条矛盾边。'
    }
  }

  function relLabel(kind){ return kind === 'supports' ? '佐证' : '细化' }

  function notConflictSpec(kind){
    var k = kind === 'supports' ? 'supports' : 'refines'
    var name = relLabel(k)
    var meaning = k === 'supports'
      ? '两条不是互相打脸，而是各自独立、可以互相印证'
      : '两条不是互相打脸，而是详略/粒度不同——B（右）是 A（左）更细的说法'
    return {
      action: 'not-conflict',
      kind: k,
      cls: 'act-not-conflict',
      label: '改标成「' + name + '」',
      confirmLabel: '确认：改标成「' + name + '」→',
      short: '把「矛盾」改标成「' + name + '」',
      consequence: '两条记忆一个字都不动，只把这条边从「矛盾」改标成「' + name + '」：' +
        meaning + '。关系方向沿用原来那条矛盾边（A → B），不重排两端。'
    }
  }

  // ── 后端错误码 → 人话 ──────────────────────────────────────────────
  // 原则：能说清「为什么 + 现在该干什么」的才写明确解释；拿不准的一律归 UNKNOWN
  // 并让主人把原话发过来，**不猜**。错误码本身必须原样显示，方便对日志。
  var ERROR_TEXT = {
    EDGE_NOT_FOUND: '这张矛盾边已经不在库里了——可能刚被核验过，或它两端的记忆有一条被删了。刷新页面看最新状态。',
    ALREADY_RESOLVED: '这条矛盾已经处理过了（可能另一个标签页先点了）。刷新页面看最新状态。',
    INVALID_ACTION: '页面发的动作后端不认识——是页面和后端版本对不上，刷新页面（必要时重装插件）再试。',
    FORBIDDEN: '被后端的同源写保护挡下了（不是同源页面发的、或少了 X-Brain-Action 头）。从这页点按钮重试；还不行把这个 code 发我。',
    BAD_REQUEST: '请求缺字段或格式不对（edgeId / action 必填）。这是页面 bug，把 code 发我。',
    SCOPE_MISMATCH: '这条边不属于当前 scope，没动它。确认你在对的 scope 页面上。',
    BUSY: '库正忙（另一个写入还没结束），等一两秒再点一次。',
    NETWORK: '连不上本机服务：确认 dsh web 还在跑，然后刷新页面。'
  }
  var UNKNOWN_TEXT = '后端没说清原因。把 code 和后面那行原话发我。'

  function humanOf(code, msg){
    if (code && ERROR_TEXT[code]) return ERROR_TEXT[code]
    // 接口回了 HTTP 错误页（多半是 404：后端还没上这个动作接口，或前缀对不上）。
    // 这一条必须和 NETWORK 分开——服务在跑却说「连不上」，比不说更糟。
    if (code && code.indexOf('HTTP_') === 0) {
      return '接口回了 HTTP ' + code.slice(5) + '，不是正常 JSON——多半是这个动作接口还没上（或路由前缀不对），不是网络问题。把这个 code 发我。'
    }
    // 有的路径会把 SQLite 的忙/锁包成 5xx，code 不是我们的枚举——按原话判断，不编 code
    if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String(msg || ''))) return ERROR_TEXT.BUSY
    return UNKNOWN_TEXT
  }

  // ── 两步确认的状态机 ───────────────────────────────────────────────
  // 同一张卡同一时刻只允许一个动作处于「待确认」（armed）：点另一个动作会先把上一个退回，
  // 否则屏幕上会出现两个橙色确认按钮，第二步点哪个都说不清。
  function clearArm(card){
    if (card.timer) { try { clearTimeout(card.timer) } catch (e) { /* 忽略 */ } card.timer = null }
    card.armed = null
  }

  function resetButtons(card){
    for (var i = 0; i < card.buttons.length; i++) {
      var b = card.buttons[i]
      b.className = 'act ' + b.__cls
      b.textContent = b.__label
    }
  }

  function disarm(card){
    var armed = card.armed
    clearArm(card)
    if (armed && armed.btn) {
      armed.btn.className = 'act ' + armed.btn.__cls
      armed.btn.textContent = armed.btn.__label
    }
    if (!card.busy && !card.done) {
      card.hint.className = 'hint'
      card.hint.textContent = ''
    }
  }

  function arm(card, btn, spec){
    if (!card || card.busy || card.done) return
    if (card.armed && card.armed.btn === btn) {
      // 第二步：这才是真的发请求
      fire(card, btn, card.armed.spec)
      return
    }
    disarm(card)
    card.armed = { btn: btn, spec: spec }
    btn.className = 'act armed ' + spec.cls
    btn.textContent = spec.confirmLabel
    card.hint.className = 'hint show pending'
    card.hint.textContent = spec.consequence +
      ' 再点一下这个按钮就执行；3 秒内不再点就自动退回，什么都不改。'
    card.timer = setTimeout(function(){ disarm(card) }, CONFIRM_TTL)
    // Node 里（verify-pages 的 DOM stub）这个定时器会让进程多等 3 秒；
    // 浏览器里 setTimeout 返回数字、没有 unref，所以这段只在 Node 下生效。
    if (card.timer && typeof card.timer.unref === 'function') card.timer.unref()
  }

  function fire(card, btn, spec){
    clearArm(card)
    card.busy = true
    btn.className = 'act working ' + spec.cls
    btn.textContent = '提交中…'
    card.hint.className = 'hint show pending'
    card.hint.textContent = '正在执行：' + spec.short + '…'
    var payload = { edgeId: card.edgeId, action: spec.action }
    if (spec.kind) payload.kind = spec.kind
    fetch(ACTION_URL, {
      method: 'POST',
      credentials: 'same-origin',
      // 后端要 X-Brain-Action 头才认这是同源页面发来的写请求（挡脚本/跨站直接打接口）
      headers: { 'Content-Type': 'application/json', 'X-Brain-Action': '1' },
      body: JSON.stringify(payload)
    }).then(function(r){
      return r.json().catch(function(parseErr){
        // 后端回了非 JSON（4xx/5xx 的 HTML 错误页、或路由还没上）。
        // 这时**不能**报成「连不上服务」——服务在跑，是接口不对，编个网络故障就是骗人。
        // 注意：verify-pages 的 mock 响应没有 status 字段，所以没有 status 时按原样抛出。
        if (typeof r.status === 'number') {
          return { ok: false, code: 'HTTP_' + r.status, message: '接口返回了非 JSON（HTTP ' + r.status + '）' }
        }
        throw parseErr
      })
    }).then(function(d){
      card.busy = false
      if (d && d.ok === true) okDone(card, spec, d)
      else badDone(card, spec, d || {})
    }).catch(function(err){
      card.busy = false
      badDone(card, spec, { code: 'NETWORK', message: (err && err.message) || String(err) })
    })
  }

  function okDone(card, spec, d){
    card.done = true
    card.card.className = 'panel done'
    card.badge.className = 'badge done'
    card.badge.textContent = '已核验'
    resetButtons(card)
    for (var i = 0; i < card.buttons.length; i++) {
      card.buttons[i].className = 'act disabled ' + card.buttons[i].__cls
      card.buttons[i].disabled = true
    }
    var what
    if (spec.action === 'keep-left' || spec.action === 'keep-right') {
      var keptIsLeft = spec.action === 'keep-left'
      var keptId = d.keptId || '（后端未回 id）'
      var goneId = d.supersededId || '（后端未回 id）'
      what = '已保留' + (keptIsLeft ? '左' : '右') + '侧 ' + keptId +
        '；' + (keptIsLeft ? '右' : '左') + '侧 ' + goneId + ' 已封口（valid_until 落值、正文未删、asOf 仍可回看）。'
    } else {
      what = '两条记忆都没动，这条边已从「矛盾」改标成「' + relLabel(spec.kind) + '」' +
        (d.newEdgeId ? '（新边 ' + d.newEdgeId + '）' : '') + '。'
    }
    var removed = d.edgeRemoved === true
      ? '矛盾边已删除。'
      : (d.edgeRemoved === false ? '注意：后端报告矛盾边未删除，别当成已清干净。' : '')
    // rollbackHint 由后端给（它知道这次写了哪些行）。没给就如实说没给——绝不自己编一段看起来像的 SQL。
    var rb = d.rollbackHint || '（后端没返回撤销方式；别凭记忆手写 SQL，先在 data/backups 里找回滚点）'
    // 留痕状态必须如实说（2026-11-02）。后端一直在返回 logged / loggedError，
    // 页面从来没读过——于是「库改了、日志没写成」会被渲染成一次干净的成功，
    // 而页脚还写着「都留痕、都能撤销」。承诺和实现就差这一句。
    var logLine = ''
    if (d.logged !== true){
      logLine = d.loggedError
        ? '\\n⚠ 留痕失败：' + d.loggedError + '（库已改，但这次核验没写进 conflict-actions 日志）'
        : '\\n⚠ 后端没报告是否留痕，别默认它记上了'
    }
    card.hint.className = 'hint show ok'
    card.hint.textContent = '已核验 · ' + what + removed + logLine + '\\n撤销方式：' + rb
    doneCount += 1
    txt('s-done', String(doneCount))
    refreshStats()
  }

  function badDone(card, spec, d){
    var code = d && d.code ? String(d.code) : 'UNKNOWN'
    var human = humanOf(code, d && d.message)
    var extra = ''
    // 后端原话带出来，但和上面的解释重复就不啰嗦
    if (d && d.message && human.indexOf(String(d.message)) < 0) extra = ' 后端原话：' + d.message
    card.hint.className = 'hint show bad'
    card.hint.textContent = '没做成（' + code + '）：' + human + extra
    resetButtons(card)
    // 失败后卡片仍然可用：按钮回到未确认态，可以再点一次（库忙、网络抖都能原地重试）。
    if (code === 'ALREADY_RESOLVED' || code === 'EDGE_NOT_FOUND') {
      card.hint.textContent += ' 这张卡的正文仍可读，但这条边已经不待核验了。'
    }
  }

  function refreshStats(){
    fetch(LIST_URL, { credentials: 'same-origin' })
      .then(function(r){ return r.json() })
      .then(function(d){
        if (!d || !d.ok) return
        // 只刷数字，不重画卡片：刚核验完的卡还要留着显示「做了什么 + 撤销方式」。
        applyStats(d)
      })
      .catch(function(){ /* 统计刷不动不影响卡片状态，下次操作还会再刷 */ })
  }

  function applyStats(d){
    var items = (d && d.items) || []
    var stats = d && d.stats ? d.stats : null
    var pending = stats && stats.byKind && typeof stats.byKind.contradicts === 'number'
      ? stats.byKind.contradicts
      : items.length
    txt('s-total', String(pending))
    txt('s-all', stats ? String(stats.total) : '–')
    txt('s-sup', stats && stats.byKind ? String(stats.byKind.supersedes || 0) : '–')
  }

  function side(m, label, cls, card, actKey){
    var box = el('div', 'side' + (cls ? ' ' + cls : ''))
    box.appendChild(el('div', 'side-tag', label))
    if (!m || m.missing){
      box.appendChild(el('p', 'text', '（这条记忆已不存在或已删除）'))
      return box
    }
    var text = el('p', 'text clamped', m.content || m.summary || '（无正文）')
    box.appendChild(text)
    var long = (m.content || '').length > 220
    if (long){
      var moreBtn = el('button', 'more', '展开全文')
      var open = false
      moreBtn.addEventListener('click', function(){
        open = !open
        text.className = 'text' + (open ? '' : ' clamped')
        moreBtn.textContent = open ? '收起' : '展开全文'
      })
      box.appendChild(moreBtn)
    }
    var chips = el('div', 'chips')
    if (m.type) chips.appendChild(el('span', 'chip', m.type))
    if (m.layer) chips.appendChild(el('span', 'chip', m.layer))
    if (m.importance != null) chips.appendChild(el('span', 'chip', '重要度 ' + m.importance))
    if (m.originSystem) chips.appendChild(el('span', 'chip', '来源 ' + m.originSystem))
    var t = m.validFrom || m.validUntil
    if (t) chips.appendChild(el('span', 'chip time', fmt(m.validFrom) + ' → ' + fmt(m.validUntil)))
    // 这里必须用变量承接，不许写成行首的 (m.entities || []).forEach(...)：
    // 上一行以 ) 结尾、下一行以 ( 开头时 JavaScript **不会**自动插入分号，
    // 整段会被解析成 chips.appendChild(...)(...) 的连续调用，运行时报
    // 「chips.appendChild(...) is not a function」。语法检查完全查不出来，
    // 只有真的在浏览器里跑一次才会现形。
    // 另外：本文件外侧是模板字符串，注释里连一个反引号都不能出现——
    // 那会把整个模板截断（HANDOVER 3.7 第 31 条），我写这段注释时就踩过一次。
    var ents = m.entities || []
    for (var i = 0; i < ents.length; i++) {
      chips.appendChild(el('span', 'chip accent', ents[i]))
    }
    box.appendChild(chips)
    var mid = el('div', 'mid')
    var code = el('code', null, m.memoryId)
    code.title = '点击复制'
    code.addEventListener('click', function(){
      try {
        navigator.clipboard.writeText(m.memoryId)
        code.textContent = '已复制 ' + m.memoryId
        setTimeout(function(){ code.textContent = m.memoryId }, 1200)
      } catch (e) { /* 剪贴板不可用就静默 */ }
    })
    mid.appendChild(code)
    if (m.version != null) mid.appendChild(el('span', null, 'v' + m.version))
    if (m.createdAt) mid.appendChild(el('span', null, '记于 ' + fmt(m.createdAt)))
    box.appendChild(mid)

    // 动作按钮：只在这一端有真实记忆 id 时挂（缺 id 就没法告诉后端动哪条）
    if (card && card.edgeId && actKey) {
      var spec = keepSpec(actKey)
      var actBtn = el('button', 'act ' + spec.cls, spec.label)
      // __act / __label / __cls 是给复位和自动化验用的锚点：
      // DOM stub 里 setAttribute 是空函数、也没有 dataset，属性直接挂对象最稳。
      actBtn.__act = actKey
      actBtn.__label = spec.label
      actBtn.__cls = spec.cls
      actBtn.addEventListener('click', function(){ arm(card, actBtn, keepSpec(actKey)) })
      var actRow = el('div', 'side-act')
      actRow.appendChild(actBtn)
      box.appendChild(actRow)
      card.buttons.push(actBtn)
    }
    return box
  }

  function syncRel(card){
    if (!card.relBtn) return
    var spec = notConflictSpec(card.sel ? card.sel.value : 'refines')
    card.relBtn.__label = spec.label
    card.relBtn.__cls = spec.cls
    if (card.armed && card.armed.btn === card.relBtn) {
      // 已经在等确认：关系类型改成什么，后果就跟着改成什么，别让人对着旧文案点第二下
      card.armed.spec = spec
      card.relBtn.textContent = spec.confirmLabel
      card.hint.textContent = spec.consequence +
        ' 再点一下这个按钮就执行；3 秒内不再点就自动退回，什么都不改。'
    } else if (!card.busy && !card.done) {
      card.relBtn.textContent = spec.label
    }
  }

  function card(item, i){
    var wrap = el('div', 'panel')
    var edgeId = item.edgeId || item.id || null
    var cardState = {
      edgeId: edgeId, busy: false, done: false, armed: null, timer: null,
      buttons: [], card: wrap, hint: null, badge: null, sel: null, relBtn: null
    }
    var head = el('div', 'panel-head')
    head.appendChild(el('span', 'idx', '#' + (i + 1)))
    head.appendChild(el('span', 'chip bad', item.kind))
    var badge = el('span', 'badge', '')
    head.appendChild(badge)
    head.appendChild(el('span', 'panel-meta', (item.sourceSystem ? '来自 ' + item.sourceSystem + ' · ' : '') + fmt(item.createdAt)))
    wrap.appendChild(head)
    cardState.badge = badge

    var pair = el('div', 'pair')
    pair.appendChild(side(item.from, 'A · 这条说', '', cardState, 'keep-left'))
    pair.appendChild(el('div', 'vs-mid', '⇄'))
    pair.appendChild(side(item.to, 'B · 那条说', 'b', cardState, 'keep-right'))
    wrap.appendChild(pair)

    var judge = el('div', 'judge')
    judge.appendChild(el('span', 'judge-label', '两条都对，不是矛盾？关系改成：'))
    var sel = el('select', 'select')
    var optRefines = el('option', null, '细化（refines）')
    optRefines.value = 'refines'
    var optSupports = el('option', null, '佐证（supports）')
    optSupports.value = 'supports'
    sel.appendChild(optRefines)
    sel.appendChild(optSupports)
    sel.value = 'refines'
    sel.addEventListener('change', function(){ syncRel(cardState) })
    judge.appendChild(sel)
    cardState.sel = sel

    if (edgeId) {
      var relSpec = notConflictSpec('refines')
      var relBtn = el('button', 'act ' + relSpec.cls, relSpec.label)
      relBtn.__act = 'not-conflict'
      relBtn.__label = relSpec.label
      relBtn.__cls = relSpec.cls
      relBtn.addEventListener('click', function(){
        arm(cardState, relBtn, notConflictSpec(sel.value))
      })
      judge.appendChild(relBtn)
      cardState.relBtn = relBtn
      cardState.buttons.push(relBtn)
    } else {
      judge.appendChild(el('span', 'judge-label', '（这条边没有 id，无法操作）'))
    }
    wrap.appendChild(judge)

    var hint = el('div', 'hint')
    wrap.appendChild(hint)
    cardState.hint = hint

    if (!edgeId) {
      // 没有 edgeId 时把两个「保留这条」也停掉，别让人点了才发现没法执行
      for (var b = 0; b < cardState.buttons.length; b++) {
        cardState.buttons[b].className = 'act disabled ' + cardState.buttons[b].__cls
        cardState.buttons[b].disabled = true
      }
      hint.className = 'hint show bad'
      hint.textContent = '这条边缺少 edgeId，页面无法对它执行动作（不影响阅读两端原文）。'
    }

    CARDS.push(cardState)
    return wrap
  }

  function findCard(edgeId){
    for (var i = 0; i < CARDS.length; i++) {
      if (CARDS[i].edgeId === edgeId) return CARDS[i]
    }
    return null
  }
  function findButton(card, act){
    for (var i = 0; i < card.buttons.length; i++) {
      if (card.buttons[i].__act === act) return card.buttons[i]
    }
    return null
  }

  // ── 调试/自动化钩子 ────────────────────────────────────────────────
  // verify-pages 的 DOM stub 里 addEventListener 是空函数，派发不了真实 click，
  // 只能靠这个钩子驱动「第一步/第二步」。它不新增任何权限——干的正是页面按钮能做的事。
  try {
    window.__conflicts = {
      version: 'actions-1',
      actionUrl: ACTION_URL,
      cards: function(){
        return CARDS.map(function(c){
          return {
            edgeId: c.edgeId, busy: c.busy, done: c.done,
            armed: c.armed ? c.armed.spec.action : null,
            hint: c.hint ? c.hint.textContent : '',
            badge: c.badge ? c.badge.textContent : ''
          }
        })
      },
      press: function(edgeId, act){
        var c = findCard(edgeId); if (!c) return 'no-card'
        var b = findButton(c, act); if (!b) return 'no-button'
        if (c.armed && c.armed.btn === b) return 'already-armed'
        arm(c, b, act === 'not-conflict' ? notConflictSpec(c.sel ? c.sel.value : 'refines') : keepSpec(act))
        return 'armed'
      },
      confirm: function(edgeId, act){
        var c = findCard(edgeId); if (!c) return 'no-card'
        var b = findButton(c, act); if (!b) return 'no-button'
        if (!(c.armed && c.armed.btn === b)) return 'not-armed'
        fire(c, b, c.armed.spec)
        return 'fired'
      },
      setRel: function(edgeId, kind){
        var c = findCard(edgeId); if (!c || !c.sel) return 'no-card'
        c.sel.value = kind === 'supports' ? 'supports' : 'refines'
        syncRel(c)
        return c.sel.value
      }
    }
  } catch (e) { /* 没有 window（非浏览器环境）：钩子不挂，页面照常工作 */ }

  fetch(LIST_URL, { credentials: 'same-origin' })
    .then(function(r){ return r.json() })
    .then(function(d){
      var list = document.getElementById('list')
      list.textContent = ''
      if (!d || !d.ok){
        txt('s-total', '?')
        list.appendChild(el('div', 'empty', (d && d.message) || '读取失败'))
        return
      }
      var items = d.items || []
      applyStats(d)
      if (items.length === 0){
        var e = el('div', 'empty')
        e.appendChild(el('strong', null, '没有待核验的矛盾'))
        // 用 span 而不是裸文本节点：.empty span 有 max-width 和居中约束，裸文本拿不到。
        // 文案里也不该出现 contradicts 这个表名——读页面的人不知道它指什么。
        e.appendChild(el('span', null, '库里还没有任何一对记忆被判为互相矛盾。'))
        list.appendChild(e)
        return
      }
      items.forEach(function(item, i){ list.appendChild(card(item, i)) })
    })
    .catch(function(err){
      var list = document.getElementById('list')
      list.textContent = ''
      list.appendChild(el('div', 'empty', '读取失败：' + err.message))
    })
})()
</script>
</body>
</html>`
}
