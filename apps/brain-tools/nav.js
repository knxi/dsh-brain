// @ts-check
/**
 * 外置大脑 · 统一导航（/dsh-brain 这一套页面共用的唯一一份）
 *
 * ── 为什么单独抽一个文件 ──
 *
 * 2026-10-30 之前六个页面各写各的导航：记忆页 3 个链接、使用页 2 个、矛盾页 2 个、
 * 实体页 3 个、心海页 1 个（还是「列表视图 ←」这种反着叫的名字），治理页 3 个。
 * 结果是「从 A 页能去哪」取决于你站在哪页——同一套页面里有两套地图，人得靠记。
 *
 * 这里把**导航项和顺序**收成一个数据表（NAV_ITEMS），页面只负责说自己是谁（active）。
 * 加一页、改顺序、改叫法，都只改这张表，不用再去六个文件里找 `<a class="navlink"`。
 *
 * ── 三条纪律 ──
 *
 * 1. **顺序固定**：记忆 / 心海 / 使用 / 矛盾 / 实体 / 心情 / 空间 / 类脑 / 人格 / 指令 / 治理。
 *    顺序按「读 → 看 → 用 → 验 → 人 → 我 → 空间 → 系统 → 说话 → 动手 → 管」的认知路径排，
 *    不是按字母、不是按新旧。后四项是 M8 的四套系统（工作空间 / 类脑协同 / 人格与社交 /
 *    自主指令），排在「心情」之后、「治理」之前：先看「我怎么样」，再看「系统怎么样」，
 *    最后才是「谁能动它」。
 * 2. **样式沿用现有 .navlink**：这里定义的 .navlink 与各页面原来那份逐字一致
 *    （纸感浅色、1px --line 边框、13px 字），所以插入后**视觉零变化**，
 *    只多了 `.active` 一档高亮。不借统一导航的机会改版式。
 * 3. **不许出现裸反引号**：这个文件虽然不在模板字符串里，但拼 HTML 一律用单引号
 *    字符串数组 join，不用模板字符串——同一套纪律，少一个踩坑的地方（CONTRACTS 3.7 第 31 条）。
 *
 * ── 心海为什么有一份深色版 ──
 *
 * 心海是近黑底的星海全屏页，纸感白底链接（--card 写成 #fffdfa）放上去是一排刺眼的
 * 白块。这里不改它的底色、也不给它单独写一套导航数据——**导航项完全同一份**，
 * 只是配色换成语义等价的深色（边框/文字的透明度与心海页里 .btn 已有的值一致）。
 * 也就是说：地图是同一张，只是墨色跟着纸走。
 */

/**
 * 导航项。**顺序在这里定义一次**，所有页面按它渲染。
 * key 同时是 `renderNav({ active })` 的取值，也是将来做「当前页」判定的唯一凭据。
 * @type {ReadonlyArray<{ key: string, label: string, href: string }>}
 */
export const NAV_ITEMS = Object.freeze([
  { key: 'memory', label: '记忆', href: '/dsh-brain' },
  { key: 'sea', label: '心海', href: '/dsh-brain/sea' },
  { key: 'usage', label: '使用', href: '/dsh-brain/usage' },
  { key: 'conflicts', label: '矛盾', href: '/dsh-brain/conflicts' },
  { key: 'entities', label: '实体', href: '/dsh-brain/entities' },
  { key: 'mood', label: '心情', href: '/dsh-brain/mood' },
  { key: 'workspace', label: '空间', href: '/dsh-brain/workspace' },
  { key: 'cognition', label: '类脑', href: '/dsh-brain/cognition' },
  { key: 'persona', label: '人格', href: '/dsh-brain/persona' },
  { key: 'directives', label: '指令', href: '/dsh-brain/directives' },
  { key: 'governance', label: '治理', href: '/dsh-brain/governance' },
])

/**
 * 纸感导航样式（记忆 / 使用 / 矛盾 / 实体 / 心情 / 空间 / 类脑 / 人格 / 指令 / 治理 十页）。
 * 各页面把它插到自己的 `</style>` 前面即可；规则逐字沿用原来那份 .navlink，
 * 所以**不会改变现有观感**，新增的只有 `.nav` 容器与 `.active` 高亮。
 *
 * `flex-wrap:wrap` 是防溢出的：十一项在窄屏挤不下时在 nav 内部换行，
 * 而不是把整行顶出去（不动各页 .head 的版式）。
 */
export const NAV_CSS = [
  '.nav{display:flex;gap:8px;margin-left:auto;flex-wrap:wrap;align-items:center}',
  '.navlink{font-size:13px;padding:8px 15px;border:1px solid var(--line);border-radius:10px;',
  '  background:var(--card);color:var(--ink);text-decoration:none;transition:all .18s;white-space:nowrap}',
  '.navlink:hover{border-color:var(--ochre);color:var(--ochre)}',
  '.navlink.active{border-color:var(--ochre);background:var(--ochre-soft);color:var(--ochre);',
  '  font-weight:600}',
  '.navlink.active:hover{color:var(--ochre)}',
].join('\n')

/**
 * 心海用的深色版（近黑底）。色值不是新造的——边框/文字用的是心海页 .btn 里
 * 已经在用的 rgba(140,170,210,.22) / #cfd8e6 / #ffd18a，只是把纸感那套换成语义等价的深色。
 * 导航项仍然是 NAV_ITEMS 同一份，不另写一套。
 */
export const NAV_CSS_DARK = [
  '.nav-dark{display:flex;gap:6px;flex-wrap:wrap;align-items:center;flex:none}',
  '.nav-dark .navlink{font-size:11.5px;padding:5px 11px;border-radius:7px;',
  '  border:1px solid rgba(140,170,210,.22);background:rgba(20,26,38,.8);color:#cfd8e6;',
  '  text-decoration:none;transition:all .15s;white-space:nowrap}',
  '.nav-dark .navlink:hover{border-color:rgba(170,200,240,.5);color:#fff;background:rgba(30,38,54,.92)}',
  '.nav-dark .navlink.active{border-color:rgba(200,160,90,.55);color:#ffd18a;background:rgba(30,38,54,.92)}',
  '.nav-dark .navlink.active:hover{color:#ffd18a}',
].join('\n')

/** HTML 属性值转义：label / href 目前都是常量，但模板拼字符串就该一律转义，别留口子。 */
function attr(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * 渲染统一导航条。
 *
 * @param {{ active?: string, variant?: 'paper' | 'dark' }} [opts]
 *   active  —— 当前页的 key（取 NAV_ITEMS 里的 key）。**只用于高亮**；
 *              给未知值或干脆不传时导航照常渲染、只是没有高亮项——不报错、不猜。
 *   variant —— 'paper'（默认，纸感十页）/ 'dark'（心海近黑底）。
 * @returns {string} 一段 HTML 片段（`<nav>`，可直接插进页面模板）
 */
export function renderNav(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const active = typeof o.active === 'string' ? o.active : ''
  const dark = o.variant === 'dark'
  const parts = []
  for (const item of NAV_ITEMS) {
    const on = item.key === active
    parts.push(
      '<a class="navlink' + (on ? ' active' : '') + '" href="' + attr(item.href) + '"'
      + (on ? ' aria-current="page"' : '') + '>' + attr(item.label) + '</a>'
    )
  }
  return '<nav class="nav' + (dark ? ' nav-dark' : '') + '" aria-label="外置大脑导航">'
    + parts.join('') + '</nav>'
}
