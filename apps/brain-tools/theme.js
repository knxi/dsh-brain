// @ts-check
/**
 * 外置大脑 · 视觉主题（/dsh-brain 这一套页面共用的唯一一份设计系统）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * v2「白昼实验室 / LIGHT LAB」—— 2026-11-01 第二次换版
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * v1 是「夜间仪器」：近黑底 + 琥珀。用久了的问题很具体——日间环境下对比过硬、
 * 截图分享发灰、打印基本没法看。v2 换成浅色，但不是「白色版 v1」：
 *
 *   1. **雾白纸面，不是纯白**：#f2f4f7 打底，白面板浮在上面。纯白会让 1px 细线
 *      失去存在感，整页糊成一片。
 *   2. **电靛蓝承担全部「可行动」语义**：#3b5bdb。全站唯一彩色，其余颜色只做
 *      状态与数据区分。v1 的琥珀退役（--ochre 别名到 --accent，免得旧页面报错）。
 *   3. **蓝图网格 + 顶部自然光晕**：56px 的靛蓝细网格压到 4% 透明度，光学上
 *      像铺在绘图桌上的图纸——「实验室」隐喻的全部来源，不靠炫光。
 *   4. **阴影只表达「离开纸面一瞬」**：常驻只有 0 1px 2px，hover 才抬到 0 10px 26px。
 *      v1 是「不用阴影」，v2 是「只用最轻的一层」——浅底上没阴影会显平。
 *   5. **心海是唯一暗区**：「外面白、里面黑」——统计条保持浅色，只有三维视窗
 *      内部是深色仪器。视窗内强调色局部覆盖为青 #59e3ff（见 sea-page.js）。
 *
 * ── 架构（跟 v1 一样，别改）──
 *
 * 视觉唯一来源就是这个文件，由 tools/apply-theme.mjs 在构建期注入到各
 * *-page.js 的 THEME 标记区。原因见 apply-theme.mjs 顶部：页面热重载靠 mtime
 * 加 query，但页面内部静态 import 的模块不带 query，改了 theme 不重启就是不生效。
 *
 * 跟 v1 的一个结构差异：**组件层也收进来了**（stats/panel/list/chip/kv/tbl/
 * bars/ev/switch/duo/budget/vs）。v1 把组件留在各页、theme 只管骨架，结果是十个
 * 页面各有一份「差不多」的组件样式；v2 既然要统一浅色质感，就让组件也只有一个来源，
 * 各页只写自己独有的部分。
 *
 * ── 三条纪律 ──
 *
 * 1. **不用模板字符串**：内容会拼进各页的模板串，用单引号数组 join。
 * 2. **token 名向后兼容**：旧页面里 --ochre / --ochre-soft 别名到 --accent。
 * 3. **一个强调色**：任何「再加一个彩色」的冲动都是 bug。
 */

/**
 * 色板与尺度。**改观感只改这一块。**
 *
 * 表面四层：--paper（页面底）→ --card（面板）→ --card-2（面板内次级）→ --raise（hover）
 * 墨色四级：--ink（标题/关键数值）→ --ink-2（正文）→ --muted（说明）→ --faint（标注）
 * 线两档：  --line（结构线）→ --line-soft（行间线）
 * 强调一个：--accent 电靛蓝；--accent-2 只在预算条渐变里当深端
 * 状态三枚：--ok / --warn / --bad，只允许出现在标记与数值上
 * 数据语义两枚：--slate / --violet，比状态色更淡，只做区分不做强调
 */
export const THEME_TOKENS = [
  ':root{',
  '  color-scheme:light;',
  // ── 表面：雾白纸面，不是纯白 ──
  '  --paper:#f2f4f7; --card:#ffffff; --card-2:#f7f8fa; --raise:#edf0f5;',
  // ── 墨色：冷灰系，不用纯黑 ──
  '  --ink:#1a2332; --ink-2:#3d4a5c; --muted:#68788e; --faint:#98a5b7;',
  // ── 线 ──
  '  --line:#e4e8ef; --line-soft:rgba(25,42,68,.07);',
  // ── 强调：电靛蓝，全站唯一彩色 ──
  '  --accent:#3b5bdb; --accent-2:#7048e8;',
  '  --accent-line:rgba(59,91,219,.40); --accent-soft:rgba(59,91,219,.09);',
  // 旧名兼容：v1 页面里既有 --ochre / --ochre-soft
  '  --ochre:var(--accent); --ochre-soft:var(--accent-soft);',
  // ── 状态：浅底重新校准过，别直接搬深色版的值 ──
  '  --ok:#2f9e63;   --ok-soft:rgba(47,158,99,.11);',
  '  --warn:#dd7f0e; --warn-soft:rgba(221,127,14,.11);',
  '  --bad:#d64545;  --bad-soft:rgba(214,69,69,.09);',
  // ── 数据语义 ──
  '  --slate:#8296ad; --violet:#8a6fd6;',
  // ── 字体 ──
  '  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
  '  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;',
  // ── 尺度：圆角两档、动效三条曲线三档时长 ──
  '  --r:12px; --r-sm:7px;',
  '  --ease:cubic-bezier(.2,0,0,1);',
  '  --ease-out:cubic-bezier(.16,1,.3,1);',
  '  --ease-soft:cubic-bezier(.4,0,.2,1);',
  '  --dur-fast:.16s; --dur-normal:.28s; --dur-slow:.6s;',
  '}',
].join('\n')

/**
 * 页面骨架 + 通用组件。**插在每个页面 `<style>` 的最前面**，页内样式自然覆盖它。
 *
 * 顺序：先骨架（底、排印、品牌条、标题区、粘性导航、路径行、页脚、响应式、降级），
 * 再组件（统计条、搜索、输入、按钮、面板、分栏、列表、徽章、说明、表格、图表…）。
 */
export const THEME_BASE = [
  '*{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%}',
  'body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.65 var(--sans);',
  '  letter-spacing:.005em;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;',
  '  text-rendering:optimizeLegibility}',

  // 纸面背景：极淡蓝图网格 + 顶部一道自然光晕。两层都极弱，只在余光里起作用。
  // 心海页是深色视窗，网格会让星点发糊——所以 body.sea-mode 时关掉。
  'body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;',
  '  background-image:linear-gradient(to right,rgba(59,91,219,.040) 1px,transparent 1px),',
  '    linear-gradient(to bottom,rgba(59,91,219,.040) 1px,transparent 1px);',
  '  background-size:56px 56px;',
  '  -webkit-mask-image:radial-gradient(ellipse 115% 75% at 50% 0%,#000,transparent 74%);',
  '  mask-image:radial-gradient(ellipse 115% 75% at 50% 0%,#000,transparent 74%)}',
  'body::after{content:"";position:fixed;inset:0 0 auto 0;height:400px;z-index:0;pointer-events:none;',
  '  background:radial-gradient(ellipse 70% 100% at 50% -24%,rgba(255,255,255,.9),transparent 70%)}',
  'body.sea-mode::before,body.sea-mode::after{display:none}',

  '::selection{background:rgba(59,91,219,.16);color:var(--ink)}',
  'a{color:var(--accent);text-decoration:none}',
  'a:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}',
  'code{font-family:var(--mono);font-size:.92em;background:var(--raise);color:var(--ink-2);',
  '  padding:1px 5px;border-radius:4px}',
  'b,strong{font-weight:620;color:var(--ink)}',
  'em{font-style:normal;color:var(--accent)}',
  // 数字永远等宽：跳动的数值、翻页条数、毫秒都不许把行推歪
  '.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}',

  '*{scrollbar-width:thin;scrollbar-color:#d3dae4 transparent}',
  '::-webkit-scrollbar{width:10px;height:10px}',
  '::-webkit-scrollbar-track{background:transparent}',
  '::-webkit-scrollbar-thumb{background:#d3dae4;border-radius:8px;border:3px solid var(--paper)}',
  '::-webkit-scrollbar-thumb:hover{background:#b9c3d2}',
  ':focus-visible{outline:1.5px solid var(--accent-line);outline-offset:2px;border-radius:3px}',

  '.wrap{position:relative;z-index:1;width:min(100%,1240px);margin:0 auto;',
  '  padding:24px clamp(20px,3.5vw,44px) 76px}',
  // 宽版：九列表格、并排双栏那种信息密集页用
  '.wrap.wrap--wide{width:min(100%,1360px)}',

  // ── 品牌条：左边一枚慢转的菱形标记 + 字标，右边系统状态灯 ──
  // 标记是两个 45° 旋转的方框叠着，外圈 12s 转一圈——这是全站唯一的持续动画，
  // 只为表达「这台机器活着」，不表达任何状态。
  '.brandbar{display:flex;align-items:center;gap:12px;min-height:54px;padding-bottom:16px;',
  '  border-bottom:1px solid var(--line-soft);font-family:var(--mono)}',
  '.brandmark{position:relative;width:30px;height:30px;display:grid;place-items:center;flex:none}',
  '.brandmark::before,.brandmark::after{content:"";position:absolute;inset:2px;',
  '  border:1.5px solid var(--accent-line);transform:rotate(45deg);border-radius:2px}',
  '.brandmark::before{animation:brand-spin 12s linear infinite;transform-origin:50% 50%}',
  '.brandmark::after{inset:8px;border-color:var(--accent)}',
  '.brandmark i{width:4px;height:4px;border-radius:50%;background:var(--accent)}',
  '@keyframes brand-spin{to{transform:rotate(405deg)}}',
  '.brandname{font-size:.76rem;font-weight:650;letter-spacing:.22em;color:var(--ink)}',
  '.brandname small{display:block;font-size:.5rem;font-weight:500;letter-spacing:.3em;',
  '  color:var(--muted);margin-top:1px}',
  '.system-state{display:flex;align-items:center;gap:8px;margin-left:auto;height:28px;padding:0 10px;',
  '  border:1px solid var(--line);border-radius:999px;background:var(--card);',
  '  font-size:9px;letter-spacing:.14em;color:var(--muted)}',
  '.system-state b{font-weight:500;color:var(--ok)}',
  '.system-state .lamp{width:5px;height:5px;box-shadow:0 0 0 3px var(--ok-soft)}',

  // ── 标题区：编号 kicker → 大标题 → 右对齐说明 ──
  // 三级层级让「这是第几页 / 叫什么 / 干嘛的」在一屏内读完，不靠加粗放大硬分主次。
  '.head{display:grid;grid-template-columns:minmax(0,auto) minmax(280px,1fr);gap:8px 34px;',
  '  margin-top:30px}',
  '.head-kicker{grid-column:1/-1;font:500 .58rem/1.2 var(--mono);letter-spacing:.24em;',
  '  color:var(--accent);opacity:.9}',
  'h1{display:flex;align-items:center;gap:10px;margin:0;',
  '  font-size:clamp(2rem,3vw,2.55rem);font-weight:640;letter-spacing:-.045em;line-height:1.08}',
  // 标题前那枚竖条：3px 宽，从实色到 25% 渐隐。比 v1 的小方块更适合大字号标题。
  'h1::before{content:"";width:3px;height:.72em;border-radius:2px;flex:none;',
  '  background:linear-gradient(var(--accent),rgba(59,91,219,.25))}',
  '.head>.sub{justify-self:end;text-align:right;max-width:46ch;padding-bottom:5px;',
  '  font-size:.82rem;line-height:1.65;color:var(--muted)}',

  // ── 导航：粘性分段控制条 ──
  // 吸顶 + 毛玻璃。tab 宽度只由内容决定（flex:0 0 auto），切到任何视图选中块尺寸一致，不跳。
  // 选中态是「软底 + 底部 2px 短下划线」，下划线从中间展开——0.28s，不弹。
  '.nav{position:sticky;top:12px;z-index:10;grid-column:1/-1;',
  '  display:flex;flex-wrap:nowrap;gap:4px;align-items:center;margin-top:24px;padding:6px;',
  '  border:1px solid var(--line);border-radius:12px;background:rgba(255,255,255,.86);',
  '  backdrop-filter:blur(16px);box-shadow:0 4px 18px rgba(23,32,60,.05);',
  '  overflow-x:auto;scrollbar-width:none}',
  '.nav::-webkit-scrollbar{display:none}',
  '.navlink{position:relative;flex:0 0 auto;min-height:38px;display:grid;place-items:center;',
  '  padding:0 12px;border:1px solid transparent;border-radius:7px;background:transparent;',
  '  font-size:.76rem;letter-spacing:.04em;color:var(--muted);text-decoration:none;',
  '  white-space:nowrap;cursor:pointer;',
  '  transition:color var(--dur-fast) var(--ease-soft),background var(--dur-fast),',
  '    border-color var(--dur-fast),transform var(--dur-fast) var(--ease-out)}',
  '.navlink:hover{transform:translateY(-1px);background:var(--raise);color:var(--ink);',
  '  text-decoration:none}',
  '.navlink:active{transform:translateY(1px)}',
  '.navlink.active{border-color:var(--accent-line);',
  '  background:linear-gradient(180deg,rgba(59,91,219,.11),rgba(59,91,219,.045));',
  '  color:var(--accent);font-weight:560}',
  '.navlink.active:hover{background:linear-gradient(180deg,rgba(59,91,219,.13),rgba(59,91,219,.06));',
  '  color:var(--accent)}',
  '.navlink::after{content:"";position:absolute;left:28%;right:28%;bottom:4px;height:2px;',
  '  border-radius:1px;background:var(--accent);transform:scaleX(0);transform-origin:center;',
  '  transition:transform var(--dur-normal) var(--ease-out)}',
  '.navlink.active::after{transform:scaleX(1)}',

  // ── 路径行：左边一枚 PATH 小标，右边渐隐横线收到头 ──
  '.path{display:flex;align-items:center;gap:8px;margin:16px 0 24px;',
  '  font-family:var(--mono);font-size:10px;color:var(--faint);letter-spacing:.035em;',
  '  word-break:break-all}',
  '.path::before{content:"PATH";flex:none;font-size:8px;letter-spacing:.15em;color:var(--accent);',
  '  border:1px solid var(--accent-line);padding:1px 5px;border-radius:3px;',
  '  background:var(--accent-soft)}',
  '.path::after{content:"";flex:1;height:1px;margin-left:6px;',
  '  background:linear-gradient(90deg,var(--line),var(--line-soft) 55%,transparent 88%)}',

  // ── 视图切换：整屏淡入 + 子块错落上移。360ms / 错开 45ms，不弹。 ──
  '.view{display:none}',
  '.view.active{display:block;animation:view-in .36s var(--ease)}',
  '@keyframes view-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}',
  '.view.active>*{animation:rise-in .46s var(--ease-out) both}',
  '.view.active>*:nth-child(2){animation-delay:45ms}.view.active>*:nth-child(3){animation-delay:90ms}',
  '.view.active>*:nth-child(4){animation-delay:135ms}.view.active>*:nth-child(5){animation-delay:180ms}',
  '.view.active>*:nth-child(6){animation-delay:225ms}',
  '.view.active>*:nth-child(n+7){animation-delay:270ms}',
  '@keyframes rise-in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}',

  // ── 统计条：一条通栏面板，靠竖 hairline 分格 ──
  '.stats{display:flex;flex-wrap:wrap;padding:0;margin-bottom:18px;overflow:hidden;',
  '  background:var(--card);border:1px solid var(--line);border-radius:var(--r);',
  '  box-shadow:0 1px 2px rgba(23,32,60,.04)}',
  '.stat{display:flex;flex-direction:column;gap:2px;padding:14px 22px;flex:1;min-width:112px;',
  '  border-right:1px solid var(--line-soft)}',
  '.stat:last-child{border-right:none}',
  '.stat-k{font-size:10px;color:var(--muted);letter-spacing:.09em}',
  '.stat-v{font-size:1.34rem;font-weight:600;font-family:var(--mono);',
  '  font-variant-numeric:tabular-nums;letter-spacing:-.02em;color:var(--ink);line-height:1.35}',
  '.stat-v.ok{color:var(--ok)} .stat-v.warn{color:var(--warn)} .stat-v.bad{color:var(--bad)}',
  '.stat-n{font-size:11px;color:var(--faint);line-height:1.6}',
  '.stat--big .stat-v{font-size:2.15rem}',

  // ── 搜索区：输入框嵌在浅面板里，视觉上它是一个「控件组」而不是两个控件 ──
  '.searchbar{display:flex;gap:8px;align-items:center;margin:0 0 16px;padding:8px;',
  '  border:1px solid var(--line);border-radius:12px;background:var(--card);',
  '  box-shadow:0 1px 2px rgba(23,32,60,.04)}',
  '.searchbar .input{flex:1;min-width:240px;border-color:transparent;background:var(--card-2)}',

  // ── 输入 ──
  '.input,.select{height:36px;padding:0 12px;border:1px solid var(--line);border-radius:var(--r-sm);',
  '  background:var(--card);font:inherit;font-size:13px;color:var(--ink);outline:none;',
  '  transition:border-color var(--dur-fast) var(--ease),box-shadow var(--dur-fast) var(--ease),',
  '    background var(--dur-fast)}',
  '.input::placeholder{color:var(--faint)}',
  '.input:focus,.select:focus{border-color:var(--accent-line);background:var(--card);',
  '  box-shadow:0 0 0 3px rgba(59,91,219,.12)}',
  '.select{font-family:var(--mono);font-size:12px;padding:0 8px}',

  // ── 按钮：hover 抬 1px。浅底上「抬起」是最低成本的反馈，比变暗更清楚。 ──
  '.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;',
  '  height:34px;padding:0 15px;border:1px solid var(--line);border-radius:var(--r-sm);',
  '  background:var(--card);color:var(--ink-2);font:inherit;font-size:13px;cursor:pointer;',
  '  white-space:nowrap;',
  '  transition:transform var(--dur-fast) var(--ease-out),border-color var(--dur-fast),',
  '    color var(--dur-fast),background var(--dur-fast),box-shadow var(--dur-fast)}',
  '.btn:hover{transform:translateY(-1px);border-color:#c9d2e0;background:var(--raise);',
  '  color:var(--ink)}',
  '.btn:active{transform:translateY(0) scale(.975)}',
  '.btn--primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:600;',
  '  box-shadow:0 2px 8px rgba(59,91,219,.28)}',
  '.btn--primary:hover{background:#334fc4;border-color:#334fc4;color:#fff;',
  '  box-shadow:0 4px 14px rgba(59,91,219,.34)}',
  '.btn--ghost{background:transparent;border-color:var(--line-soft)}',
  '.btn--danger{border-color:var(--bad-soft);color:var(--bad)}',
  '.btn--danger:hover{background:var(--bad-soft);border-color:var(--bad);color:var(--bad)}',
  '.btn--sm{height:28px;padding:0 11px;font-size:12px;font-family:var(--mono)}',
  '.btn[disabled]{opacity:.38;cursor:not-allowed;transform:none}',

  // ── 面板 ──
  '.panel{border:1px solid var(--line);border-radius:var(--r);background:var(--card);',
  '  overflow:hidden;box-shadow:0 1px 2px rgba(23,32,60,.04)}',
  '.panel+.panel{margin-top:16px}',
  '.panel-head{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;',
  '  padding:13px 18px;border-bottom:1px solid var(--line);background:var(--card-2)}',
  '.panel-title{font-size:13px;font-weight:600;color:var(--ink);line-height:1.5}',
  '.panel-meta{font-size:11px;color:var(--muted);margin-left:auto;font-family:var(--mono)}',
  '.panel-body{padding:16px 18px}',
  '.panel-foot{padding:10px 16px;border-top:1px solid var(--line-soft);font-size:11.5px;',
  '  color:var(--muted);line-height:1.7}',
  '.panel--quiet{background:transparent;border-style:dashed;box-shadow:none}',

  // ── 分栏 ──
  '.split{display:grid;grid-template-columns:minmax(0,1.62fr) minmax(0,1fr);gap:20px;',
  '  align-items:start}',
  '.split--even{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}',
  '.grid2{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px;align-items:start}',
  '.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;align-items:start}',

  // ── 列表：一整块面板，行间 --line-soft ──
  // hover 时左侧亮起 2px 强调线，比整行变色指认得更精确。
  '.list{display:flex;flex-direction:column;overflow:hidden;',
  '  border:1px solid var(--line);border-radius:var(--r);background:var(--card);',
  '  box-shadow:0 1px 2px rgba(23,32,60,.04)}',
  '.row{position:relative;padding:12px 18px 12px 20px;cursor:pointer;',
  '  border-bottom:1px solid var(--line-soft);',
  '  transition:background var(--dur-normal) var(--ease-soft)}',
  '.row:last-child{border-bottom:none}',
  '.row::before{content:"";position:absolute;left:0;top:0;bottom:0;width:2px;',
  '  background:transparent;transition:background var(--dur-fast) var(--ease)}',
  '.row:hover{background:var(--raise)}',
  '.row:hover::before{background:var(--accent)}',
  '.row.is-selected{background:var(--raise);box-shadow:inset 0 0 0 1px rgba(59,91,219,.10)}',
  '.row.is-selected::before{background:var(--accent)}',
  '.row-top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}',
  '.row-title{font-size:13px;flex:1;min-width:0;color:var(--ink-2);line-height:1.6}',
  '.row:hover .row-title,.row.is-selected .row-title{color:var(--ink)}',
  '.row-id{font-family:var(--mono);font-size:10px;color:var(--faint);flex:none}',
  // 列表首屏错落入场：只给前 9 行单独延时，再往后统一（不给长列表做动画）
  '.list .row{animation:row-in .28s var(--ease-out) both}',
  '.list .row:nth-child(2){animation-delay:24ms}.list .row:nth-child(3){animation-delay:48ms}',
  '.list .row:nth-child(4){animation-delay:72ms}.list .row:nth-child(5){animation-delay:96ms}',
  '.list .row:nth-child(6){animation-delay:120ms}.list .row:nth-child(7){animation-delay:144ms}',
  '.list .row:nth-child(8){animation-delay:168ms}.list .row:nth-child(9){animation-delay:192ms}',
  '.list .row:nth-child(n+10){animation-delay:216ms}',
  '@keyframes row-in{from{opacity:0;transform:translateX(-6px)}to{opacity:1;transform:translateX(0)}}',

  // ── 徽章 ──
  '.chips{display:flex;gap:5px;flex-wrap:wrap}',
  '.chip{font-size:10.5px;padding:1.5px 7px;border-radius:4px;white-space:nowrap;',
  '  font-family:var(--mono);background:var(--raise);color:var(--muted)}',
  '.chip.accent{background:var(--accent-soft);color:var(--accent)}',
  '.chip.ok{background:var(--ok-soft);color:var(--ok)}',
  '.chip.warn{background:var(--warn-soft);color:var(--warn)}',
  '.chip.bad{background:var(--bad-soft);color:var(--bad)}',
  '.chip.plain{background:transparent;color:var(--faint);box-shadow:inset 0 0 0 1px var(--line)}',

  // ── 元信息标签：默认透明，只有状态类给底 ──
  '.tags{display:flex;gap:4px 14px;flex-wrap:wrap;margin-top:5px;align-items:center}',
  '.tag{font-size:10.5px;padding:0;color:var(--faint);font-family:var(--mono);',
  '  letter-spacing:.01em;white-space:nowrap;line-height:1.7}',
  '.tag.ok{color:var(--ok)}',
  '.tag.bad{padding:0 5px;border-radius:3px;background:var(--bad-soft);color:var(--bad)}',
  '.tag.accent{color:var(--accent)}',

  // ── 说明条：左缘一道 2px 线 + 极淡靛蓝底渐隐 ──
  '.note{font-size:12px;color:var(--muted);line-height:1.8;margin:0;',
  '  padding:10px 14px;border-left:2px solid var(--line);border-radius:0 6px 6px 0;',
  '  background:linear-gradient(90deg,rgba(59,91,219,.035),transparent 70%)}',
  '.note.warn{border-left-color:var(--warn);background:var(--warn-soft);color:#9a5f0d}',
  '.note.bad{border-left-color:var(--bad);background:var(--bad-soft);color:#a03c3c}',
  '.note b{color:var(--ink)}',

  // ── 键值表 ──
  '.kv{display:grid;grid-template-columns:96px minmax(0,1fr);gap:8px 12px;margin:0;font-size:12px}',
  '.kv dt{color:var(--muted)}',
  '.kv dd{margin:0;color:var(--ink-2);font-family:var(--mono);font-size:11.5px;',
  '  word-break:break-all;font-variant-numeric:tabular-nums}',

  // ── 表格 ──
  '.tbl{width:100%;border-collapse:collapse;font-size:12.5px}',
  '.tbl th{text-align:left;font-weight:500;color:var(--muted);font-size:9.5px;',
  '  letter-spacing:.08em;text-transform:uppercase;font-family:var(--mono);',
  '  padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}',
  '.tbl td{padding:9px 10px;border-bottom:1px solid var(--line-soft);color:var(--ink-2);',
  '  vertical-align:baseline}',
  '.tbl tr:last-child td{border-bottom:none}',
  '.tbl td.num{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;',
  '  white-space:nowrap}',
  '.tbl td.mono{font-family:var(--mono);font-size:11.5px;color:var(--faint)}',
  '.tbl tbody tr{transition:background var(--dur-fast) var(--ease-soft)}',
  '.tbl tbody tr:hover{background:rgba(59,91,219,.035)}',

  // ── 空态 ──
  '.empty{padding:44px 20px;text-align:center;color:var(--muted);font-size:13px;line-height:1.9}',
  '.empty strong{display:block;color:var(--ink);font-size:13.5px;font-weight:600;margin-bottom:5px}',
  '.empty span{display:block;max-width:540px;margin:0 auto}',

  // ── 状态灯：7px 纯色点 ──
  '.lamp{width:7px;height:7px;border-radius:50%;flex:none;display:inline-block;vertical-align:1px}',
  '.lamp.ok{background:var(--ok)} .lamp.warn{background:var(--warn)}',
  '.lamp.bad{background:var(--bad)} .lamp.off{background:var(--faint)}',

  // ── 柱状图 ──
  '.bars{display:flex;align-items:flex-end;gap:6px;height:110px;padding-top:6px}',
  '.bar{flex:1;min-width:8px;height:100%;display:flex;flex-direction:column;',
  '  justify-content:flex-end;gap:2px}',
  '.bar-i{background:linear-gradient(to top,rgba(59,91,219,.45),var(--accent));',
  '  border-radius:2px 2px 0 0;min-height:2px}',
  '.bar-i.zero{background:var(--line)}',
  '.bar-x{font-family:var(--mono);font-size:9px;color:var(--faint);text-align:center;',
  '  white-space:nowrap;overflow:hidden;height:12px}',
  '.legend{display:flex;gap:14px;font-size:11px;color:var(--muted);margin-top:10px}',
  '.legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;',
  '  vertical-align:0}',

  // ── 排行行 ──
  '.rank{display:flex;align-items:baseline;gap:10px;padding:7px 0;',
  '  border-bottom:1px solid var(--line-soft);font-size:12.5px}',
  '.rank:last-child{border-bottom:none}',
  '.rank-t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
  '  color:var(--ink-2)}',
  '.rank-n{font-family:var(--mono);font-size:11.5px;color:var(--muted);',
  '  font-variant-numeric:tabular-nums;white-space:nowrap}',

  // ── 时间线 ──
  '.ev{display:flex;gap:14px;padding:11px 0;border-bottom:1px solid var(--line-soft)}',
  '.ev:last-child{border-bottom:none}',
  '.ev-when{font-family:var(--mono);font-size:11.5px;color:var(--faint);white-space:nowrap;',
  '  min-width:86px;padding-top:2px;font-variant-numeric:tabular-nums}',
  '.ev-main{flex:1;min-width:0}',
  '.ev-label{font-size:13px;color:var(--ink);line-height:1.5}',
  '.ev-note{font-size:12px;color:var(--muted);margin-top:2px;line-height:1.7}',
  '.ev-delta{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}',
  '.dl{font-family:var(--mono);font-size:10.5px;padding:1px 7px;border-radius:4px;',
  '  font-variant-numeric:tabular-nums;white-space:nowrap}',
  '.dl.up{background:var(--ok-soft);color:var(--ok)}',
  '.dl.down{background:var(--bad-soft);color:var(--bad)}',

  // ── 开关卡（空间页）：hover 抬 2px + 一道浅影，是这页唯一允许「浮起来」的组件 ──
  '.switch-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px}',
  '.switch{display:flex;flex-direction:column;gap:6px;padding:14px 15px;',
  '  border:1px solid var(--line);border-radius:var(--r);background:var(--card);',
  '  transition:transform var(--dur-normal) var(--ease-out),border-color var(--dur-normal),',
  '    box-shadow var(--dur-normal)}',
  '.switch:hover{transform:translateY(-2px);border-color:rgba(59,91,219,.30);',
  '  box-shadow:0 10px 26px rgba(23,32,60,.09)}',
  '.switch-top{display:flex;align-items:baseline;gap:8px}',
  '.switch-name{font-size:13px;color:var(--ink);font-weight:560;flex:1}',
  '.switch-key{font-family:var(--mono);font-size:10.5px;color:var(--faint)}',
  '.switch-desc{font-size:11.5px;color:var(--muted);line-height:1.7}',
  '.switch-note{font-size:11px;color:var(--faint);line-height:1.7;',
  '  border-left:2px solid var(--line-soft);padding-left:8px}',
  '.switch .btn{align-self:flex-start;margin-top:2px}',

  // ── 双栏对照（指令页）──
  '.duo{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:0}',
  '.duo-col{padding:14px 16px}',
  '.duo-col+.duo-col{border-left:1px solid var(--line)}',
  '.duo-h{font-size:11px;color:var(--muted);letter-spacing:.06em;margin-bottom:10px}',
  '.allow{display:flex;flex-direction:column;gap:10px}',
  '.allow-i{padding:10px 12px;border:1px solid var(--line-soft);border-radius:var(--r-sm);',
  '  background:var(--card-2)}',
  '.allow-t{font-size:12.5px;color:var(--accent);font-weight:560;margin-bottom:3px}',
  '.allow-d{font-size:11.5px;color:var(--muted);line-height:1.7}',
  '.allow-r{font-size:11px;color:var(--faint);line-height:1.7;margin-top:4px;',
  '  border-top:1px solid var(--line-soft);padding-top:4px}',
  '.forbid{display:flex;flex-direction:column;gap:9px;font-size:12px;color:var(--ink-2);',
  '  line-height:1.75}',
  '.forbid-i{display:flex;gap:9px}',
  '.forbid-i::before{content:"";width:5px;height:5px;border-radius:1px;background:var(--bad);',
  '  flex:none;margin-top:7px}',

  // ── 预算条 ──
  '.budget{display:flex;flex-direction:column;gap:5px;margin-bottom:10px}',
  '.budget-top{display:flex;align-items:baseline;gap:8px;font-size:12px}',
  '.budget-k{color:var(--muted);flex:1}',
  '.budget-num{font-family:var(--mono);font-size:11.5px;color:var(--ink-2);',
  '  font-variant-numeric:tabular-nums}',
  '.budget-track{height:6px;border-radius:3px;background:var(--raise);overflow:hidden}',
  '.budget-fill{height:100%;border-radius:3px;',
  '  background:linear-gradient(90deg,var(--accent-2),var(--accent))}',
  '.budget-fill.over{background:var(--bad)}',

  // ── 并排对比（矛盾页）──
  '.vs{display:grid;grid-template-columns:minmax(0,1fr) 40px minmax(0,1fr);gap:0;',
  '  align-items:stretch}',
  '.vs-card{padding:14px 16px;border:1px solid var(--line);border-radius:var(--r);',
  '  background:var(--card);display:flex;flex-direction:column;gap:8px}',
  '.vs-mid{display:grid;place-items:center;color:var(--faint);font-size:15px}',
  '.vs-side{font-size:10.5px;color:var(--faint);letter-spacing:.06em;font-family:var(--mono)}',
  '.vs-body{font-size:12.5px;color:var(--ink-2);line-height:1.75}',
  '.vs-actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:14px}',

  // ── 页脚：mono 小字 + 左边一枚靛蓝方块 ──
  '.foot{margin-top:48px;padding-top:22px;border-top:1px solid var(--line);',
  '  display:flex;gap:16px;flex-wrap:wrap;align-items:center;',
  '  font-family:var(--mono);font-size:9px;letter-spacing:.06em;color:var(--faint)}',
  '.foot::before{content:"";width:5px;height:5px;background:var(--accent)}',

  // ── 响应式 ──
  '@media(max-width:980px){',
  '  .split,.split--even,.grid2,.grid3{grid-template-columns:minmax(0,1fr)}',
  '}',
  '@media(max-width:900px){',
  '  .head{grid-template-columns:1fr}',
  '  .head>.sub{justify-self:start;text-align:left;max-width:62ch}',
  '  .nav{top:8px;margin-top:18px;overflow-x:auto;justify-content:flex-start;',
  '    mask-image:linear-gradient(90deg,#000 82%,transparent 97%);',
  '    -webkit-mask-image:linear-gradient(90deg,#000 82%,transparent 97%)}',
  '  .navlink{flex:0 0 auto;min-width:64px}',
  '  .switch-grid{grid-template-columns:minmax(0,1fr)}',
  '  .duo{grid-template-columns:minmax(0,1fr)}',
  '  .duo-col+.duo-col{border-left:none;border-top:1px solid var(--line)}',
  '  .vs{grid-template-columns:minmax(0,1fr)}',
  '  .vs-mid{display:none}',
  '}',
  '@media(max-width:800px){',
  '  .wrap{padding:18px 16px 44px}',
  '  .system-state span{display:none}',
  '  .path{margin-bottom:16px}',
  '}',
  '@media(max-width:560px){',
  '  .brandbar{min-height:48px;padding-bottom:14px}',
  '  .brandname{font-size:.68rem}',
  '  .system-state{font-size:8px}',
  '  .head{margin-top:22px}',
  '  .head-kicker{font-size:.54rem}',
  '  h1{font-size:1.6rem}',
  '  .path{margin:14px 0 18px}',
  '  .searchbar{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;align-items:stretch}',
  '  .searchbar .input{grid-column:1/-1;min-width:0}',
  '  .searchbar .btn{width:100%;min-height:42px}',
  '  .stat{min-width:46%;padding:13px 16px}',
  '  .stat:nth-child(2n){border-right:none}',
  '  .stat-v{font-size:1.12rem}',
  '  .panel-body{padding:16px}',
  '}',

  // ── 无障碍：尊重系统的减少动效设置。关动画不等于关功能。 ──
  '@media(prefers-reduced-motion:reduce){',
  '  *,*::before,*::after{animation-duration:.01ms!important;',
  '    animation-iteration-count:1!important;transition-duration:.01ms!important;',
  '    scroll-behavior:auto!important}',
  '  .view.active>*{animation:none}',
  '}',
].join('\n')

/**
 * 页面直接插这一个：`<style>${THEME_CSS} 页面自己的样式</style>`。
 *
 * 但**实际不这么用**——页面是模板串，theme 由 tools/apply-theme.mjs 在构建期
 * 注入到 THEME 标记区。原因见该脚本顶部：页面内静态 import 的模块不随 mtime 热重载。
 */
export const THEME_CSS = THEME_TOKENS + '\n' + THEME_BASE
