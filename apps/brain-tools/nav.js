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
 * 2. **这个文件不再管样式**（2026-11-01）。原先是两套 `.navlink`（纸感版给十个页面、
 *    深色版给心海），谁也别处的样式都从这里引。问题是页面热重载只认自己的 mtime，
 *    页面内部静态 import 的模块会被缓存成旧实例——改导航样式必须重启宿主才生效，
 *    而改主题、改页面都只要刷新。同一份样式两处定义 + 一处改不动，就是「改不齐」的根源。
 *    现在：导航样式统一在 theme.js 的注入区（十个页面）与 sea-page.js 的 `<style>` 里
 *    （心海是近黑全屏页，就地定义）。**样式跟着页面文件走，改完刷新即见。**
 * 3. **不许出现裸反引号**：这个文件虽然不在模板字符串里，但拼 HTML 一律用单引号
 *    字符串数组 join，不用模板字符串——同一套纪律，少一个踩坑的地方（CONTRACTS 3.7 第 31 条）。
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
 * @param {{ active?: string }} [opts]
 *   active —— 当前页的 key（取 NAV_ITEMS 里的 key）。**只用于高亮**；
 *             给未知值或干脆不传时导航照常渲染、只是没有高亮项——不报错、不猜。
 * @returns {string} 一段 HTML 片段（`<nav>`，可直接插进页面模板）
 */
export function renderNav(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const active = typeof o.active === 'string' ? o.active : ''
  const parts = []
  for (const item of NAV_ITEMS) {
    const on = item.key === active
    parts.push(
      '<a class="navlink' + (on ? ' active' : '') + '" href="' + attr(item.href) + '"'
      + (on ? ' aria-current="page"' : '') + '>' + attr(item.label) + '</a>'
    )
  }
  return '<nav class="nav" aria-label="外置大脑导航">' + parts.join('') + '</nav>'
}
