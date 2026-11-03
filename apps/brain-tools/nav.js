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
 * ── 2026-11-01 v2 改版：品牌条和标题区也收进来 ──
 *
 * v2「白昼实验室」的页面骨架是三段式的，每页都一样：
 *
 *     品牌条（标记 + 字标 + 系统状态灯）
 *     标题区（编号 kicker → 大标题 → 右对齐说明）
 *     粘性导航条（十个 tab，吸顶）
 *
 * 这三段如果留在十个页面里各写一遍，改一个字母就要改十个文件——跟当初导航散落
 * 各页是同一个病。所以整块收成 `renderPageHead()`：页面只传「我是谁、叫什么、
 * 一句话说明」，其余完全一致。
 *
 * ── 三条纪律 ──
 *
 * 1. **顺序固定**：记忆 / 心海 / 使用 / 矛盾 / 实体 / 心情 / 空间 / 类脑 / 人格 / 指令 / 治理。
 *    顺序按「读 → 看 → 用 → 验 → 人 → 我 → 空间 → 系统 → 说话 → 动手 → 管」的认知路径排，
 *    不是按字母、不是按新旧。
 * 2. **这个文件不管样式**（2026-11-01）。原先两套 `.navlink` 都从这里引，但页面热重载
 *    只认自己的 mtime，页面内部静态 import 的模块会被缓存成旧实例——改导航样式必须
 *    重启宿主。现在样式统一在 theme.js 的注入区，心海的就地写在 sea-page.js。
 *    **样式跟着页面文件走，改完刷新即见。**
 * 3. **不许出现裸反引号**：拼 HTML 一律用单引号字符串数组 join，不用模板字符串。
 */

/**
 * 导航项。**顺序在这里定义一次**，所有页面按它渲染。
 * key 同时是 `renderNav({ active })` 的取值，也是「当前页」判定的唯一凭据。
 * kicker —— 标题区左上角那行 mono 编号：`序号 / 页名`。
 * 2026-11-02 改：原来是 `01 / MEMORY CONTROL` 这种英文代号，主人问「为什么都是英文」——
 * 这是中文工具，编号只需要「我在第几页、这页叫什么」，不需要再背一套英文。
 * @type {ReadonlyArray<{ key: string, label: string, href: string, kicker: string }>}
 */
export const NAV_ITEMS = Object.freeze([
  { key: 'memory', label: '记忆', href: '/dsh-brain', kicker: '01 / 记忆控制台' },
  { key: 'sea', label: '心海', href: '/dsh-brain/sea', kicker: '02 / 心海星图' },
  { key: 'usage', label: '使用', href: '/dsh-brain/usage', kicker: '03 / 使用台账' },
  { key: 'conflicts', label: '矛盾', href: '/dsh-brain/conflicts', kicker: '04 / 矛盾核验' },
  { key: 'entities', label: '实体', href: '/dsh-brain/entities', kicker: '05 / 实体图谱' },
  { key: 'mood', label: '心情', href: '/dsh-brain/mood', kicker: '06 / 心情状态' },
  { key: 'workspace', label: '空间', href: '/dsh-brain/workspace', kicker: '07 / 工作空间' },
  { key: 'cognition', label: '类脑', href: '/dsh-brain/cognition', kicker: '08 / 类脑协同' },
  { key: 'persona', label: '人格', href: '/dsh-brain/persona', kicker: '09 / 人格关系' },
  { key: 'directives', label: '指令', href: '/dsh-brain/directives', kicker: '10 / 自主指令' },
  { key: 'governance', label: '治理', href: '/dsh-brain/governance', kicker: '11 / 治理面板' },
])

/** HTML 属性值转义：href 目前都是常量，但模板拼字符串就该一律转义，别留口子。 */
function attr(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 文本转义（标题、说明这些要进 HTML 的）。 */
function text(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 品牌条：左边一枚慢转的菱形标记 + 字标，右边系统状态灯。
 *
 * 每页一字不差，所以不收参数——真要改字标，改这一处就够。
 * 状态灯固定 ONLINE：这套页面只有在服务真起来时才能被访问到，能打开就是在线；
 * 真实连通状态显示在 7420 治理面板的右上角，不在这里冒充。
 */
export function renderBrandbar() {
  return '<div class="brandbar">'
    + '<div class="brandmark" aria-hidden="true"><i></i></div>'
    + '<div class="brandname">外置大脑<small>EXTERNAL BRAIN / NEURAL OS</small></div>'
    + '<div class="system-state"><i class="lamp ok"></i><span>NEURAL CORE</span><b>ONLINE</b></div>'
    + '</div>'
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
      + (on ? ' aria-current="page"' : '') + '>' + text(item.label) + '</a>'
    )
  }
  return '<nav class="nav" aria-label="外置大脑导航">' + parts.join('') + '</nav>'
}

/**
 * 页面骨架的头三段：品牌条 + 标题区（含粘性导航）。
 *
 * 页面用法：`<div class="wrap">${renderPageHead({...})}<div class="path">…</div>…</div>`
 *
 * @param {{ active: string, title: string, sub?: string }} opts
 *   active —— 当前页 key（决定导航高亮与 kicker 编号）
 *   title  —— 大标题（「记忆」「心海」…）
 *   sub    —— 标题右侧那句说明，一到两行
 * @returns {string}
 */
export function renderPageHead(opts) {
  const o = opts && typeof opts === 'object' ? opts : {}
  const active = typeof o.active === 'string' ? o.active : ''
  const item = NAV_ITEMS.find((it) => it.key === active)
  const kicker = item ? item.kicker : ''
  return renderBrandbar()
    + '<div class="head">'
    + '<div class="head-kicker">' + text(kicker) + '</div>'
    + '<h1>' + text(o.title || '') + '</h1>'
    + (o.sub ? '<span class="sub">' + text(o.sub) + '</span>' : '')
    + renderNav({ active: active })
    + '</div>'
}
