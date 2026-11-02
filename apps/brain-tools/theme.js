// @ts-check
/**
 * 外置大脑 · 视觉主题（/dsh-brain 这一套页面共用的唯一一份设计系统）
 *
 * ── 为什么单独抽一份 ──
 *
 * 2026-11-01 之前十个页面各抄一份 `:root{--paper:#faf8f4;--card:#fffdfa;...}`，
 * 色值、圆角、字重全是复制粘贴。想换一次观感就得改十个文件，而且改不齐——
 * 复制粘贴的样式表没有「同一份」这回事，只有「目前碰巧一样」。
 *
 * 这里把**表面/墨色/线/强调/状态/尺度**收成一张 token 表（THEME_TOKENS），
 * 把**页面骨架**（body 底、正文排版、标题区、路径行、页脚、滚动条、焦点环）
 * 收成 THEME_BASE。页面只 import 一次 THEME_CSS 插进自己的 `<style>` 开头，
 * 再写自己特有的部分（列表、表格、时间线、图谱……）。
 *
 * ── 视觉语言（这一版：仪器面板）──
 *
 * 不是「深色皮肤」，是换了一套表达方式：
 *
 *   1. **近黑作纸，靠线分层**：粒子/星海那张（心海页）已经是近黑底，这里跟它同族。
 *      分块不用阴影（暗底上的阴影只会糊成一团），用 1px 细线 + 极小的明度差。
 *   2. **单一强调色**：全线只用一枚琥珀（--accent），软底一律是它的 10% 透明度，
 *      不引入第二个彩色。紫蓝渐变、发光边框那种「AI 味」正是从「多一个强调色」开始的。
 *   3. **等宽数字 + 宽字距小标签**：ID、时间、分数、版本全走 --mono 与 tabular-nums；
 *      说明文字收成 11px、字距 +.06em 的小标签。仪器的信息密度靠排版，不靠装饰。
 *   4. **背景是刻度，不是纹理**：整页一层 64px 极淡网格 + 顶部一道冷光，
 *      光学上像面板的坐标纸；层级压到 2% 以下，绝不和正文抢注意力。
 *   5. **动效只交代状态**：140ms、cubic-bezier(.2,0,0,1)，只改边框/背景/位移 0.5px。
 *      不加弹跳、不加旋转、不加持续脉动。
 *
 * ── 三条纪律 ──
 *
 * 1. **token 名向后兼容**：旧页面里 --ochre / --ochre-soft 满天飞，这里把它们
 *    别名到 --accent / --accent-soft，而不是改名。这样换色只改一处，
 *    各页里那些旧名字不用一个个追着改（改了反而多几十个出错点）。
 * 2. **不用模板字符串**：这个文件的内容会被拼进各页的模板串里，用单引号数组
 *    join —— 少一个踩嵌套反引号的地方（CONTRACTS 3.7 第 31 条同一纪律）。
 * 3. **只管骨架，不管组件**：列表怎么排版、表格怎么分栏，是各页自己的事。
 *    这里多定义一条，页内就多一条要覆盖的死样式。
 */

/**
 * 色板与尺度。**改观感只改这一块。**
 *
 * 表面三档：--paper（页面底）→ --card（面板）→ --raise（浮起/hover）。
 * 墨色四档：--ink（正文）→ --ink-2（次级）→ --muted（说明）→ --faint（刻度/占位）。
 * 线两档：  --line（常态）→ --line-2（hover/重点）。
 * 强调一个：--accent。状态三枚：--ok / --warn / --bad，只允许出现在标记与数值上。
 */
export const THEME_TOKENS = [
  ':root{',
  '  color-scheme:dark;',
  // ── 表面 ──
  '  --paper:#0a0b0d; --card:#111419; --card-2:#0c0e11; --raise:#181c22; --sunken:#07080a;',
  // ── 墨色 ──
  '  --ink:#e9ebee; --ink-2:#b7bdc7; --muted:#79818d; --faint:#4b525c;',
  // ── 线：暗底上 1px 线是最主要的分层手段，压到看不见就白分层了。
  //    --line      结构线（卡片外框、分栏）
  //    --line-soft 行间细分线（列表行之间、表格行之间）——比结构线淡一档，
  //                长列表才不会变成一排硬横杠，也不会淡到看不出行界。
  '  --line:#232831; --line-2:#333b46; --line-soft:rgba(255,255,255,.055);',
  // ── 强调：单一琥珀。软底只允许是它的低透明度，不许另配一个颜色 ──
  '  --accent:#e3a662; --accent-line:rgba(227,166,98,.34); --accent-soft:rgba(227,166,98,.10);',
  // 旧名兼容：各页里既有 --ochre/--ochre-soft，也让它们指向同一枚强调色
  '  --ochre:var(--accent); --ochre-soft:var(--accent-soft);',
  // ── 状态 ──
  '  --ok:#5cc08c; --ok-soft:rgba(92,192,140,.10);',
  '  --warn:#d9a253; --warn-soft:rgba(217,162,83,.10);',
  '  --bad:#dd6b5c; --bad-soft:rgba(221,107,92,.10);',
  // ── 字体 ──
  '  --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,"Cascadia Mono",monospace;',
  '  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;',
  // ── 尺度：圆角两档，够用；动效一条曲线，够用 ──
  '  --r:10px; --r-sm:6px; --ease:cubic-bezier(.2,0,0,1);',
  '}',
].join('\n')

/**
 * 页面骨架。**插在每个页面 `<style>` 的最前面**，页内样式自然覆盖它。
 *
 * 只包含「十页都一样、且与页面内容无关」的部分：底、排版、标题区、路径行、
 * 页脚、滚动条、焦点环、选中态。任何一处页面自己已经写了同义规则，
 * 都该删掉页内那份，改由这里统一——否则以后改一处漏九处。
 */
export const THEME_BASE = [
  '*{box-sizing:border-box}',
  'html{-webkit-text-size-adjust:100%}',
  'body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.65 var(--sans);',
  '  -webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}',

  // 背景刻度：64px 网格 + 顶部冷光。两层都压到 2% 附近，只在余光里起作用。
  // mask 让网格从顶部往下渐隐，页面滚到深处时不再有格子——长列表需要的是安静。
  'body::before{content:"";position:fixed;inset:0;z-index:0;pointer-events:none;',
  '  background-image:linear-gradient(to right,rgba(255,255,255,.022) 1px,transparent 1px),',
  '    linear-gradient(to bottom,rgba(255,255,255,.022) 1px,transparent 1px);',
  '  background-size:64px 64px;',
  '  -webkit-mask-image:radial-gradient(ellipse 110% 70% at 50% 0%,#000,transparent 72%);',
  '  mask-image:radial-gradient(ellipse 110% 70% at 50% 0%,#000,transparent 72%)}',
  'body::after{content:"";position:fixed;inset:0 0 auto 0;height:420px;z-index:0;pointer-events:none;',
  '  background:radial-gradient(ellipse 68% 100% at 50% -22%,rgba(126,158,204,.075),transparent 70%)}',

  '::selection{background:rgba(227,166,98,.26);color:#fff}',
  'a{color:var(--accent);text-decoration:none}',
  'a:hover{text-decoration:underline;text-underline-offset:3px;text-decoration-thickness:1px}',
  'code{font-family:var(--mono);font-size:.92em;background:var(--raise);color:var(--ink-2);',
  '  padding:1px 5px;border-radius:4px}',
  'b,strong{font-weight:620;color:var(--ink)}',
  'em{font-style:normal;color:var(--accent)}',

  // 标题：前面一枚 5px 方形刻度，是这一版唯一的装饰件。
  // 它承担「这是哪儿」的定位作用；每页一个，所以不构成噪声。
  'h1{font-size:20px;font-weight:600;letter-spacing:-.012em;margin:0;line-height:1.25;',
  '  display:flex;align-items:center;gap:9px}',
  'h1::before{content:"";width:5px;height:5px;border-radius:1px;background:var(--accent);',
  '  box-shadow:0 0 9px rgba(227,166,98,.5);flex:none}',
  '.sub{color:var(--muted);font-size:12.5px}',
  '.head{display:flex;align-items:baseline;gap:12px;margin-bottom:2px;flex-wrap:wrap}',

  // 路径行：等宽、极淡、字距微开。它下面是内容区，压住它别抢标题。
  // 下方一道渐隐横线当作「工具栏下沿」——这一版唯一的结构性分隔，
  // 让标题区与内容区之间有个界，而不是直接贴上去。
  '.path{font-family:var(--mono);font-size:11px;color:var(--faint);margin:4px 0 22px;',
  '  letter-spacing:.01em;word-break:break-all}',
  '.path::after{content:"";display:block;height:1px;margin-top:16px;',
  '  background:linear-gradient(90deg,var(--line-2),var(--line-soft) 55%,transparent 88%)}',

  '.wrap{position:relative;z-index:1;max-width:1080px;margin:0 auto;padding:34px 30px 88px}',
  // 宽版：列表页 1080 够用，但九列表格、并排双栏那种信息密集页会被挤。
  // 用修饰类而不是给 .wrap 调宽——正文行的可读宽度是靠留白撑出来的，
  // 为了两张表把整站正文行拉到 1200px 是拿可读性换密度。
  // 写成 .wrap.wrap--wide（两个类）而不是 .wrap--wide：页面自己的 `.wrap` 规则
  // 在注入区之后，同特异性下它会赢；双类把它锁死，免得「加了修饰类却没变宽」。
  '.wrap.wrap--wide{max-width:1200px}',
  '.foot{margin-top:36px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);',
  '  font-size:11.5px;display:flex;gap:16px;flex-wrap:wrap;align-items:center}',

  // 数字永远是等宽的：跳动的持仓价、翻页的条数、毫秒，都不许把行推歪。
  '.num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}',

  // 滚动条：跟着暗底走，细、无箭头、hover 才亮一点
  '*{scrollbar-width:thin;scrollbar-color:var(--line-2) transparent}',
  '::-webkit-scrollbar{width:10px;height:10px}',
  '::-webkit-scrollbar-track{background:transparent}',
  '::-webkit-scrollbar-thumb{background:#242a32;border-radius:8px;border:3px solid var(--paper)}',
  '::-webkit-scrollbar-thumb:hover{background:#39414d}',

  // 键盘焦点：清楚但不刺眼。鼠标点击不显示（:focus-visible 自带）。
  ':focus-visible{outline:1.5px solid var(--accent-line);outline-offset:2px;border-radius:3px}',

  // 导航（原 nav.js 的 NAV_CSS 并到这里）：一行 tab，不是一排按钮。
  // 十一条链接并排时，每条一个盒子就成了一排抢视线的方块；常态透明、
  // 只有 hover 才浮出底色，当前项用强调色软底 + 细边框——视觉重量降一档，
  // 位置感靠颜色而不是盒子撑。
  '.nav{display:flex;gap:2px;margin-left:auto;flex-wrap:wrap;align-items:center}',
  '.navlink{font-size:12.5px;letter-spacing:.01em;padding:6px 11px;border:1px solid transparent;',
  '  border-radius:var(--r-sm);background:transparent;color:var(--muted);text-decoration:none;',
  '  transition:color .14s var(--ease),background .14s var(--ease),border-color .14s var(--ease);',
  '  white-space:nowrap}',
  '.navlink:hover{border-color:var(--line);background:var(--raise);color:var(--ink);',
  '  text-decoration:none}',
  '.navlink.active{border-color:var(--accent-line);background:var(--accent-soft);',
  '  color:var(--accent);font-weight:560}',
  '.navlink.active:hover{color:var(--accent)}',
].join('\n')

/**
 * 页面直接插这一个：`<style>${THEME_CSS} 页面自己的样式</style>`。
 * 顺序有意义——theme 在前，页内在后，页内覆盖 theme。
 */
export const THEME_CSS = THEME_TOKENS + '\n' + THEME_BASE
