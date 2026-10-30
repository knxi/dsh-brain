// @ts-check
/**
 * 页面运行时冒烟：把每个控制台页面的内联脚本**真执行一遍**。
 *
 * ── 为什么需要这个 ──
 *
 * 2026-10-29 踩了两次「检查都不报、只有浏览器里炸」的坑（CONTRACTS 12.8 / 12.9）：
 *   1. 模板字符串里写了个反引号 → 整个文件语法错、插件加载失败、路由全 404；
 *   2. `)` 结尾的行紧跟 `(` 开头的行 → JS 不插分号，两行被解析成连续调用，
 *      运行时 `is not a function`，而 `new Function(src)` 语法检查照样通过。
 *
 * `new Function` 只能证明「能解析」，不能证明「能跑」。这个脚本补的就是那一段：
 * 用最小 DOM stub + mock fetch，把内联脚本执行到底，看它有没有抛。
 *
 * 它不是浏览器，覆盖不到布局/样式；但它能挡住上面那两类静默错误，
 * 而这两类恰恰是最容易漏、后果最严重（整页白屏或整个插件下线）的。
 *
 *   node tools/verify-pages.mjs
 */

import { renderConsolePage } from '../apps/brain-tools/console-page.js'
import { renderSeaPage } from '../apps/brain-tools/sea-page.js'
import { renderUsagePage } from '../apps/brain-tools/usage-page.js'
import { renderConflictsPage } from '../apps/brain-tools/conflicts-page.js'
import { renderEntitiesPage } from '../apps/brain-tools/entities-page.js'
import { renderGovernancePage } from '../apps/brain-tools/governance-page.js'
import { renderMoodPage } from '../apps/brain-tools/mood-page.js'

/** @type {Array<{ name: string, ok: boolean, detail: string }>} */
const checks = []
const check = (name, ok, detail = '') => {
  checks.push({ name, ok: !!ok, detail })
  console.log(`[${ok ? 'OK  ' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
}

/**
 * Canvas 2D context 的最小代理：任何方法调用都返回空函数，任何属性可读可写。
 * sea-page 用 Canvas 画星海——这里只证明调用链不会因为缺方法而炸，
 * **不验证画得对不对**（那是浏览器截图的事）。
 *
 * 唯一额外做的一件事：把每次 stroke 时的 strokeStyle 记下来。
 * 心海的关系边「按 kind 分色」是核心规格（红=矛盾/赭=取代/灰=佐证），
 * 只看「没抛异常」证明不了那三种颜色真的画出来了，这里能证明。
 */
function makeCanvasContext(sink) {
  // 渐变对象：页面里 createRadialGradient 之后会 addColorStop，
  // 少了这个页面渲染会在星星循环里炸——而那是「画面真的画出来了」的唯一证明。
  const gradient = { addColorStop() {} }
  const store = {
    canvas: { width: 800, height: 600 },
    measureText: () => ({ width: 10 }),
  }
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'stroke') {
        return () => {
          if (sink && typeof target.strokeStyle === 'string') sink(target.strokeStyle)
        }
      }
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient' || prop === 'createPattern') {
        return () => gradient
      }
      if (prop in target) return target[prop]
      return () => {}
    },
    set(target, prop, value) {
      target[prop] = value
      return true
    },
  })
}

/**
 * 最小 DOM stub。
 * 只实现页面脚本真正会用到的那几个方法：createElement / createTextNode /
 * getElementById / appendChild / addEventListener / className / textContent / style。
 * 少了哪一个会**明确报错**（而不是静默跳过）——那正是我们想知道的。
 * @param {((style: string) => void) | null} onStroke
 */
function createDom(onStroke) {
  /** @type {any[]} */
  const created = []
  /** @type {Map<string, any>} */
  const byId = new Map()

  function makeEl(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      width: 800,
      height: 600,
      title: '',
      href: '',
      value: '',
      colSpan: 0,
      style: {},
      children: [],
      appendChild(child) { this.children.push(child); return child },
      addEventListener() {},
      removeEventListener() {},
      setAttribute() {},
      querySelector() { return null },
      querySelectorAll() { return [] },
      getBoundingClientRect() { return { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 } },
      getContext() { return makeCanvasContext(onStroke) },
    }
    created.push(node)
    return node
  }

  const document = {
    createElement: makeEl,
    createTextNode: (text) => ({ text: String(text) }),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, makeEl('div'))
      return byId.get(id)
    },
    scripts: [],
    body: makeEl('body'),
  }
  return { document, created, byId }
}

/**
 * mock fetch：按 URL 返回**结构完整**的假数据。
 * 结构必须够用——假数据少一个字段，页面就会走另一条分支，
 * 那条有 bug 的分支反而测不到（本次 ASI 坑就是只在「有 validFrom 时」触发）。
 */
function fakeResponse(url, init) {
  // M7：矛盾核验动作是 POST，stub 必须能按 method 分流——
  // 否则页面把动作请求打进来会拿到「没有为这个 URL 准备假数据」，测试就假绿了。
  const method = init && typeof init.method === 'string' ? init.method.toUpperCase() : 'GET'
  // M7 分页：按请求里的 limit/offset 动态回填，页面翻页逻辑才能被真跑一遍。
  // 写死固定响应会让「翻到第 2 页」和「末页 disabled」永远测不到（offset 不跟着变）。
  const memUrl = String(url)
  if (memUrl.includes('/dsh-brain/api/memories?')) {
    const offMatch = memUrl.match(/[?&]offset=(\d+)/)
    const limMatch = memUrl.match(/[?&]limit=(\d+)/)
    const offset = offMatch ? Number(offMatch[1]) : 0
    const limit = limMatch ? Number(limMatch[1]) : 50
    const total = 217
    return {
      ok: true,
      items: [{ memoryId: 'mem_a', version: 1, summary: '外墙保温 50mm', layer: 'long', type: 'semantic', evidenceKind: 'summary', validFrom: '2026-10-28', validUntil: null, sourceCount: 1 }],
      total,
      limit,
      offset,
      hasMore: offset + limit < total,
      nextOffset: offset + 1,
    }
  }

  if (method === 'POST' && String(url).includes('/api/conflicts/action')) {
    return {
      ok: true,
      action: 'keep-left',
      edgeId: 'edge_1',
      keptId: 'mem_a',
      supersededId: 'mem_b',
      edgeRemoved: true,
      newEdgeId: null,
      kind: null,
      logged: true,
      rollbackHint: '撤销：把 mem_b 的 status 改回 active…',
    }
  }
  const summary = {
    windowDays: 7, since: 0, now: 0, total: 3, okCount: 3, failCount: 0,
    hitCount: 2, zeroHitCount: 1, hitRate: 0.667, callHitRate: 0.667,
    byChannel: { tool: 3 }, byStatus: { ok: 2, no_related: 1 },
    degradedCount: 0, degradedRate: 0, laneMissCount: 1, laneMissRate: 0.333,
    timing: { avg: 12, p50: 10, p95: 30, max: 40, samples: 3 },
    topQueries: [{ query: '踢脚线报价', count: 2, hits: 2, zero: 0, failed: 0, lastAt: 0 }],
    zeroHitQueries: [{ query: '量子纠缠', count: 1, failed: 0, lastAt: 0 }],
    byDay: [{ date: '2026-10-29', count: 3, okCount: 3, hits: 2, zero: 1, failed: 0 }],
    lastAt: 0, touchedIds: ['mem_a'], touchedCount: 1,
  }
  const conflictItem = {
    id: 'edge_1',
    fromMemoryId: 'mem_a', toMemoryId: 'mem_b',
    kind: 'contradicts',
    reason: '厚度说法不一致',
    sourceSystem: 'engram',
    createdAt: '2026-10-29T10:00:00.000Z',
    // 关键：validFrom 必须给，否则页面走不到「chips + entities 循环」那段
    from: {
      memoryId: 'mem_a', version: 1, summary: '外墙保温 50mm', content: '外墙保温用 50mm 岩棉，图号 建施-11。',
      type: 'semantic', layer: 'long', importance: 0.7,
      validFrom: '2026-10-28T00:00:00.000Z', validUntil: null,
      originSystem: 'engram', createdAt: '2026-10-29T10:00:00.000Z',
      entities: ['外墙保温', '岩棉'],
    },
    to: {
      memoryId: 'mem_b', version: 1, summary: '外墙保温 80mm', content: '外墙保温改用 80mm 岩棉，图号 建施-12。',
      type: 'semantic', layer: 'long', importance: 0.6,
      validFrom: '2026-10-29T00:00:00.000Z', validUntil: null,
      originSystem: 'engram', createdAt: '2026-10-29T10:00:00.000Z',
      entities: ['外墙保温'],
    },
  }

  const payloads = {
    '/dsh-brain/api/stats': {
      ok: true, memories: 217, indexReady: true, dbPath: 'x',
      entities: { total: 117, byKind: { tool: 41 }, linked: 104, orphan: 13 },
      conflicts: 6,
      usage: { windowDays: 7, total: 3, hitRate: 0.667, zeroHitCount: 1 },
    },
    '/dsh-brain/api/memories': {
      ok: true,
      items: [{ memoryId: 'mem_a', version: 1, summary: '外墙保温 50mm', layer: 'long', type: 'semantic', evidenceKind: 'summary', validFrom: '2026-10-28', validUntil: null, sourceCount: 1 }],
      // M7 分页：真分页分支必须被走到。缺这几个字段，页面会退化成「老契约兼容」
      // 分支——那条路能跑，但「第 N / M 页」和末页 disabled 就永远测不到了。
      total: 217, limit: 50, offset: 0, hasMore: true, nextOffset: 1,
    },
    '/dsh-brain/api/search': {
      ok: true,
      hits: [{ memoryId: 'mem_a', version: 1, summary: '外墙保温 50mm', layer: 'long', type: 'semantic', evidenceKind: 'summary', sourceCount: 1, matchedBy: ['char'] }],
      diagnostics: { status: 'ok', readable: '检索正常' },
    },
    '/dsh-brain/api/usage': {
      ok: true, logPath: 'x', logExists: true, skippedLines: 0, truncated: false,
      summary,
      coverage: {
        totalMemories: 217, touched: 1, neverHit: 216, touchedRate: 0.005,
        neverHitSamples: [{ memoryId: 'mem_x', summary: '从未被查到', type: 'profile', importance: 0.95 }],
      },
      recent: [{ at: 0, ts: '', channel: 'tool', query: '踢脚线', hitCount: 2, status: 'ok', durationMs: 12, ok: true, code: null }],
    },
    '/dsh-brain/api/scene': {
      ok: true,
      // 四个点：边的两端必须都在点集里，否则页面会跳过这条边，
      // 那条「按 kind 分色」的代码路径就测不到了。
      points: [
        { id: 'mem_a', version: 1, text: '外墙保温 50mm', content: '', cluster: 'semantic', type: 'semantic', origin: 'engram', layer: 'long', evidenceKind: 'summary', weight: 0.7, sources: 1, createdAt: 0, validFrom: '2026-10-28', validUntil: null },
        { id: 'mem_b', version: 1, text: '外墙保温 80mm', content: '', cluster: 'semantic', type: 'semantic', origin: 'dsh', layer: 'long', evidenceKind: 'summary', weight: 0.6, sources: 1, createdAt: 1, validFrom: '2026-10-29', validUntil: null },
        { id: 'mem_c', version: 1, text: '踢脚线报价口径', content: '', cluster: 'episode', type: 'episode', origin: 'dsh', layer: 'short', evidenceKind: 'summary', weight: 0.5, sources: 0, createdAt: 2, validFrom: '2026-10-25', validUntil: null },
        { id: 'mem_d', version: 1, text: '报价单先出细项再汇总', content: '', cluster: 'skill', type: 'skill', origin: 'dsh', layer: 'long', evidenceKind: 'summary', weight: 0.8, sources: 2, createdAt: 3, validFrom: '2026-10-20', validUntil: null },
      ],
      // 四种真实关系边各一条：每种 kind 的画法（红虚线 / 赭实线 / 灰细线）
      // 都必须被真跑一遍，生产库现在只有 contradicts，赭和灰在真机上看不到。
      edges: [
        { edgeId: 'edge_c1', a: 'mem_a', b: 'mem_b', kind: 'contradicts', reason: '厚度说法不一致', sourceSystem: 'engram', createdAt: 1793270000000, createdAtRaw: '2026-10-29T10:00:00.000Z', fromSummary: '外墙保温 50mm', toSummary: '外墙保温 80mm', score: 1 },
        { edgeId: 'edge_s1', a: 'mem_b', b: 'mem_c', kind: 'supersedes', reason: '后一条替代前一条', sourceSystem: 'engram', createdAt: 1793270001000, createdAtRaw: '2026-10-29T10:00:01.000Z', fromSummary: '外墙保温 80mm', toSummary: '踢脚线报价口径', score: 0.8 },
        { edgeId: 'edge_p1', a: 'mem_c', b: 'mem_d', kind: 'supports', reason: '互相印证', sourceSystem: null, createdAt: 1793270002000, createdAtRaw: '2026-10-29T10:00:02.000Z', fromSummary: '踢脚线报价口径', toSummary: '报价单先出细项再汇总', score: 0.55 },
        { edgeId: 'edge_r1', a: 'mem_a', b: 'mem_d', kind: 'refines', reason: '更细的说明', sourceSystem: null, createdAt: 1793270003000, createdAtRaw: '2026-10-29T10:00:03.000Z', fromSummary: '外墙保温 50mm', toSummary: '报价单先出细项再汇总', score: 0.55 },
      ],
      // 假边（同簇相邻）降级到这个字段，默认不画
      backgroundEdges: [
        { a: 'mem_a', b: 'mem_b', score: 0.5, kind: 'topic' },
        { a: 'mem_a', b: 'mem_c', score: 0.25, kind: 'topic' },
      ],
      edgesDegraded: false,
      stats: {
        total: 4, edges: 4, backgroundEdges: 2, clusters: 3,
        edgesByKind: { supersedes: 1, contradicts: 1, supports: 1, refines: 1 },
        edgesDegraded: false,
      },
    },
    '/dsh-brain/api/entities/memories': {
      ok: true,
      entity: { id: 'ent_1', name: '外墙保温', kind: 'concept', aliases: ['岩棉'], importance: 0.8, memoryCount: 2 },
      items: [
        { memoryId: 'mem_a', summary: '外墙保温 50mm', type: 'semantic', layer: 'long', importance: 0.7, status: 'active', validFrom: '2026-10-28', validUntil: null, linkedAt: '2026-10-29T10:00:00.000Z' },
      ],
    },
    '/dsh-brain/api/entities': {
      ok: true,
      items: [{ id: 'ent_1', name: '外墙保温', kind: 'concept', aliases: ['岩棉'], importance: 0.8, status: 'active', sourceSystem: 'engram', createdAt: '2026-10-29T10:00:00.000Z', memoryCount: 2 }],
      stats: { total: 1, byKind: { concept: 1 }, linked: 1, orphan: 0 },
    },
    '/dsh-brain/api/conflicts': {
      ok: true, items: [conflictItem], stats: { total: 1, byKind: { contradicts: 1 } },
    },
    // M7.2 心情页：给「有数据」这一档，三格数字 + 两条事件（第二条只有两个 delta，
    // 用来验「delta 为 0 的不显示」这条）。空态/state=null 由页面自己处理，
    // 这里只有一套 mock，所以只断言有数据态（其余分支 gov2 已用自家 stub 验过）。
    '/dsh-brain/api/mood': {
      ok: true,
      source: 'brain',
      state: { mood: 86.5, energy: 94.2, bond: 93.3, updatedAt: 1793356703343, lastInteractAt: 1793355696670 },
      events: [
        { id: 'ev_1', at: 1793355696670, kind: 'success', label: '事情办成了', note: 'M6.1b 合并完，验收全绿', delta: { mood: 7.7, energy: 1, bond: 1.9 } },
        { id: 'ev_2', at: 1793353723607, kind: 'chat', label: '聊了几句', note: null, delta: { mood: 2.1, bond: 1 } },
      ],
      stats: { events: 2, oldestAt: 1793353723607, newestAt: 1793355696670 },
    },
    // M7 治理只读视图：三种状态都要能验到。这里给「有数据 + 7420 在跑」，
    // 「读不到」的状态由 gains 断言单独喂（见页面断言段）。
    '/dsh-brain/api/governance': {
      ok: true,
      scopeId: 'owner-default',
      canWrite: false,
      writeHint: '写操作（删除/备份/恢复）需要治理服务：node apps/server/index.mjs --port 7420',
      console: { running: true, port: 7420, checkedAt: '2026-10-30T10:00:00.000Z' },
      backups: {
        total: 2,
        items: [
          { id: 'bkp_20261030_aaaabbbb', createdAt: '2026-10-30T09:00:00.000Z', sizeBytes: 12582912, integrity: 'ok', path: 'E:/ds-h-backups/brain.db', fileExists: true, deletionEpoch: 1 },
          { id: 'bkp_20261029_ccccdddd', createdAt: '2026-10-29T09:00:00.000Z', sizeBytes: null, integrity: 'unknown', path: null, fileExists: false, deletionEpoch: null },
        ],
      },
      deletions: {
        total: 1,
        items: [{ at: '2026-10-30T08:00:00.000Z', memoryId: 'mem_deadbeef', tombstoneId: 'tomb_1', actor: 'owner', reason: '主人要求遗忘', epoch: 2 }],
      },
      ledger: { entries: 2, epoch: 2, lastHashShort: 'a1b2c3d4', updatedAt: '2026-10-30T09:59:00.000Z', healthy: true, corruptAt: null },
      isolation: { required: false, reason: null },
    },
  }
  for (const [prefix, payload] of Object.entries(payloads)) {
    if (String(url).startsWith(prefix)) return payload
  }
  return { ok: false, message: 'verify-pages 没有为这个 URL 准备假数据：' + url }
}

/**
 * 执行一个页面的内联脚本。
 * @param {string} pageName
 * @param {string} html
 * @param {{ debug?: boolean }} [opts] debug=true 时给 location.search 带上 ?debug，
 *   页面会把调试钩子挂到 window.__sea 上（心海的关系边断言靠它）
 * @returns {Promise<{ hooks: any[], strokes: string[] }>} hooks=页面暴露的调试钩子，
 *   strokes=画布每次 stroke 用的 strokeStyle（用来证明三种关系的颜色真的画出来了）
 */
async function runPage(pageName, html, opts = {}) {
  const scripts = []
  const re = /<script>([\s\S]*?)<\/script>/g
  let match
  while ((match = re.exec(html))) scripts.push(match[1])
  check(pageName + ' 有内联脚本', scripts.length > 0, `blocks=${scripts.length}`)
  /** @type {any[]} */
  const hooks = []
  /** @type {string[]} */
  const strokes = []
  /** @type {string[]} 只含「首屏默认状态」的 stroke 记录，切开关之前的快照 */
  let defaultStrokes = []
  /** @type {{ defaultOn: boolean, turnedOn: boolean, onStrokes: string[], offStrokes: string[] } | null} */
  let backgroundProbe = null
  // M7：分页与矛盾动作的钩子只能在 runPage 内部调用——它们最后要碰 document，
  // 而 globalThis.document 在本函数返回时就被还原了。所以「按真按钮的路径跑一遍」
  // 必须在这里做，外面只断言结果（跟上面 __sea 的处理同一套办法）。
  /** @type {any} */
  let pagerProbe = null
  /** @type {any} */
  let actionProbe = null
  /** @type {any} */
  let moodProbe = null
  if (scripts.length === 0) return { hooks, strokes, defaultStrokes, backgroundProbe, pagerProbe, actionProbe, moodProbe }

  for (let i = 0; i < scripts.length; i += 1) {
    const { document, byId, created } = createDom((style) => strokes.push(style))
    // 页面脚本只依赖这几个全局：document / fetch / performance / setTimeout / navigator
    const saved = {
      document: globalThis.document,
      fetch: globalThis.fetch,
      window: globalThis.window,
      requestAnimationFrame: globalThis.requestAnimationFrame,
    }
    // @ts-expect-error 故意替换全局做 stub
    globalThis.document = document
    // @ts-expect-error 同上
    globalThis.fetch = async (url, init) => ({ json: async () => fakeResponse(String(url), init) })
    // sea-page 依赖 window（devicePixelRatio / addEventListener / innerWidth）和 rAF。
    // 用变量而不是字面量：页面会往 window 上挂调试钩子（window.__sea），
    // 挂完得能从这拿到，不然「边分色对不对」只能靠肉眼看。
    let rafHops = 0
    /** @type {any[]} */
    const frameErrors = []
    const windowStub = {
      devicePixelRatio: 1,
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
    }
    // @ts-expect-error 同上
    globalThis.window = windowStub
    // @ts-expect-error 同上
    globalThis.requestAnimationFrame = (cb) => {
      // 只放两帧：真循环会在这里跑不完，而两帧足够暴露「渲染函数一调就炸」
      if (rafHops < 2) {
        rafHops += 1
        setTimeout(() => {
          try { cb(performance.now()) } catch (error) { frameErrors.push(error) }
        }, 0)
      }
      return rafHops
    }
    // browser 里 window 的属性同时也是全局变量（裸 innerWidth 也能读到）。
    // sea-page 正是这么用的，所以 stub 要跟着模拟——否则会报 innerWidth is not defined。
    // @ts-expect-error 同上
    globalThis.innerWidth = 1200
    // @ts-expect-error 同上
    globalThis.innerHeight = 800
    // @ts-expect-error 同上
    globalThis.devicePixelRatio = 1
    // sea-page 读 location.search 判断有没有 ?debug 调试钩子
    // @ts-expect-error 同上
    globalThis.location = { search: opts.debug ? '?debug' : '', hash: '', href: 'http://127.0.0.1/dsh-brain/sea', pathname: '/dsh-brain/sea' }
    // sea-page 末尾有 setInterval(load, 30000) 轮询，会让 Node 进程**永不退出**（实测卡死过）。
    // 冒烟只验「首次渲染不抛」，轮询本身没有验证价值，直接不注册。
    const savedSetInterval = globalThis.setInterval
    // @ts-expect-error 同上
    globalThis.setInterval = () => 0
    // navigator 不动：Node 24 里 globalThis.navigator 只有 getter，赋值会抛 TypeError。
    // 页面里唯一用到 navigator.clipboard 的地方在点击回调里，不点击就不会执行。
    try {
      // 用 async 包裹，页面里的 fetch().then 才能真的跑完
      const fn = new Function(`return (async () => {\n${scripts[i]}\n})()`)
      await fn()
      // 脚本里都是 fetch(...).then(...)，给微任务一轮时间落 DOM
      await new Promise((resolve) => setTimeout(resolve, 30))
      const touched = created.length > 0 || byId.size > 0
      if (windowStub.__sea) hooks.push(windowStub.__sea)
      // M7：分页与矛盾动作的调试钩子。DOM stub 派发不了真实 click，
      // 所以页面把「按钮能干的事」挂成函数——冒烟拿它走同一条真实路径
      // （go → loadList → fetch → render），不是绕过页面另算一遍。
      if (windowStub.__pager) hooks.push(windowStub.__pager)
      if (windowStub.__conflicts) hooks.push(windowStub.__conflicts)
      if (windowStub.__mood) hooks.push(windowStub.__mood)
      check(`${pageName} 内联脚本#${i} 真跑不抛`, true, `创建节点 ${created.length} 个 / 取用 id ${byId.size} 个`)
      check(`${pageName} 内联脚本#${i} 真的操作了 DOM`, touched)
      // 帧内错误以前被 rAF stub 直接吞掉，页面渲染炸了但冒烟还是绿的——这里补上。
      check(`${pageName} 内联脚本#${i} 帧内渲染不抛`,
        frameErrors.length === 0,
        frameErrors.length
          ? String((frameErrors[0] && frameErrors[0].message) || frameErrors[0])
          : `frames=${rafHops}`)
      // M7 分页：真按「下一页 / 上一页 / 换每页条数」走一遍，记录 state 快照
      if (windowStub.__pager && typeof windowStub.__pager.next === 'function') {
        const p = windowStub.__pager
        const s0 = p.state()
        await p.next()
        const s1 = p.state()
        await p.prev()
        const s2 = p.state()
        await p.setPageSize(20)
        const s3 = p.state()
        pagerProbe = { s0, s1, s2, s3 }
      }
      // M7 矛盾动作：第一次「点」只进确认态，第二次才执行
      if (windowStub.__conflicts && typeof windowStub.__conflicts.press === 'function') {
        const c = windowStub.__conflicts
        c.press('edge_1', 'keep-left')
        const armed = c.cards()
        await c.confirm('edge_1', 'keep-left')
        // 二次确认发的是真 fetch，落完 DOM 要等一轮微任务 + 定时器——
        // 立刻取 cards() 会读到 busy:true 的中间态（实测过）。
        await new Promise((resolve) => setTimeout(resolve, 30))
        const done = c.cards()
        actionProbe = { armed, done }
      }
      // M7.2 心情页：state() 内部要读 DOM，必须在 document stub 还活着的时候取，
      // 出了 runPage 就还原了（跟 __pager 同一个坑）。
      if (windowStub.__mood && typeof windowStub.__mood.state === 'function') {
        moodProbe = windowStub.__mood.state()
      }
      // 心海的背景弱边开关：DOM stub 只在 runPage 内部有效，
      // 所以「切开关 + 重绘」的证据在这里收，外部只断言结果。
      if (windowStub.__sea && typeof windowStub.__sea.toggleBackground === 'function'
        && typeof windowStub.__sea.paint === 'function') {
        const hook = windowStub.__sea
        defaultStrokes = strokes.slice()
        const defaultOn = hook.showBackground()
        const beforeOn = strokes.length
        hook.toggleBackground()
        const turnedOn = hook.showBackground()
        hook.paint()
        const onStrokes = strokes.slice(beforeOn)
        const beforeOff = strokes.length
        hook.toggleBackground()
        hook.paint()
        const offStrokes = strokes.slice(beforeOff)
        backgroundProbe = { defaultOn, turnedOn, onStrokes, offStrokes }
      }
    } catch (error) {
      check(`${pageName} 内联脚本#${i} 真跑不抛`, false, error instanceof Error ? `${error.name}: ${error.message}` : String(error))
    } finally {
      // @ts-expect-error 还原
      globalThis.document = saved.document
      // @ts-expect-error 还原
      globalThis.fetch = saved.fetch
      // @ts-expect-error 还原
      globalThis.window = saved.window
      // @ts-expect-error 还原
      globalThis.requestAnimationFrame = saved.requestAnimationFrame
      // @ts-expect-error 还原
      globalThis.innerWidth = undefined
      // @ts-expect-error 还原
      globalThis.innerHeight = undefined
      // @ts-expect-error 还原
      globalThis.devicePixelRatio = undefined
      // @ts-expect-error 还原
      globalThis.location = undefined
      // @ts-expect-error 还原
      globalThis.setInterval = savedSetInterval
    }
  }
  return { hooks, strokes, defaultStrokes, backgroundProbe, pagerProbe, actionProbe, moodProbe }
}

const pages = [
  ['console-page', renderConsolePage({ dbPath: 'E:\\ds-h\\dsh-brain\\data\\brain.db' })],
  // sea-page 带 ?debug：它会把 __sea 调试钩子挂出来，后面要拿它验关系边的分类与背景开关
  ['sea-page', renderSeaPage(), { debug: true }],
  ['usage-page', renderUsagePage({ logPath: 'E:\\ds-h\\dsh-brain\\data\\logs\\usage.jsonl', windowDays: 7 })],
  ['conflicts-page', renderConflictsPage({ scopeId: 'owner-default' })],
  ['entities-page', renderEntitiesPage({ scopeId: 'owner-default' })],
  // M7：治理只读视图。它的内联脚本只发 GET /api/governance，
  // 断言还要证明「页面里没有写请求」——那是这次内嵌的安全边界。
  ['governance-page', renderGovernancePage({ scopeId: 'owner-default' })],
  // M7.2：心情页（情感状态并进主账之后的新页面）
  ['mood-page', renderMoodPage({ scopeId: 'owner-default' })],
]

/** @type {Map<string, { hooks: any[], strokes: string[] }>} */
const ranPages = new Map()
for (const [name, html, opts] of pages) {
  // 用 includes 而不是 endsWith：sea-page 的模板末尾是几行 HTML 注释（以 --> 结束），
  // 不是 </html>。浏览器容错，但 endsWith 会把它误判成「模板被截断」。
  check(name + ' 生成了完整文档', typeof html === 'string' && html.includes('</html>'), 'len=' + (html ? html.length : 0))
  check(name + ' 没有未闭合的模板占位', !String(html).includes('${'))
  ranPages.set(name, await runPage(name, String(html), opts))
}

// ── M7：分页行为（runPage 内部已按真按钮路径跑过，这里只断言结果）──
const consoleRan = ranPages.get('console-page') || { hooks: [] }
const pagerProbe = consoleRan.pagerProbe || null
check('console-page 暴露了分页调试钩子', !!consoleRan.hooks.find((h) => h && typeof h.go === 'function'))
check('分页首屏：offset=0、每页 50、总数来自服务端',
  !!pagerProbe && pagerProbe.s0.offset === 0 && pagerProbe.s0.pageSize === 50 && pagerProbe.s0.total === 217,
  JSON.stringify(pagerProbe && { offset: pagerProbe.s0.offset, size: pagerProbe.s0.pageSize, total: pagerProbe.s0.total }))
check('点下一页 offset 前进到 50',
  !!pagerProbe && pagerProbe.s1.offset === 50, JSON.stringify(pagerProbe && { offset: pagerProbe.s1.offset }))
check('点上一页回到第 1 页（offset=0）',
  !!pagerProbe && pagerProbe.s2.offset === 0, JSON.stringify(pagerProbe && { offset: pagerProbe.s2.offset }))
check('换每页条数回第 1 页、每页 20',
  !!pagerProbe && pagerProbe.s3.offset === 0 && pagerProbe.s3.pageSize === 20,
  JSON.stringify(pagerProbe && { offset: pagerProbe.s3.offset, size: pagerProbe.s3.pageSize }))

// ── M7：矛盾核验动作的两步确认（第一次点绝对不许执行）──
const conflictsRan = ranPages.get('conflicts-page') || { hooks: [] }
const actionProbe = conflictsRan.actionProbe || null
check('conflicts-page 暴露了核验动作钩子', !!conflictsRan.hooks.find((h) => h && typeof h.press === 'function'))
check('第一次点只进入确认态（没有直接执行）',
  !!actionProbe && JSON.stringify(actionProbe.armed).includes('armed') &&
    !JSON.stringify(actionProbe.armed).includes('"done":true'),
  JSON.stringify(actionProbe && actionProbe.armed).slice(0, 140))
check('第二次点才真的执行，卡片标成已核验',
  !!actionProbe && JSON.stringify(actionProbe.done).includes('done'),
  JSON.stringify(actionProbe && actionProbe.done).slice(0, 160))

// ── M7.2：心情页（三格数字 + 事件时间线 + delta 只显示非零）──
const moodRan = ranPages.get('mood-page') || { hooks: [] }
const moodSt = moodRan.moodProbe || null
check('mood-page 暴露了心情调试钩子', !!moodRan.hooks.find((h) => h && typeof h.state === 'function'))
check('心情页读到三格数字（86.5/94.2/93.3 取整成 87/94/93）',
  !!moodSt && moodSt.numbers && moodSt.numbers.mood === '87' && moodSt.numbers.energy === '94' && moodSt.numbers.bond === '93',
  JSON.stringify(moodSt && moodSt.numbers))
check('心情页事件时间线渲染了中文标签',
  !!moodSt && Array.isArray(moodSt.rendered) && moodSt.rendered.length === 2 && moodSt.rendered[0].label === '事情办成了',
  JSON.stringify(moodSt && moodSt.rendered && moodSt.rendered.map((r) => r.label)))
check('心情页 delta 只显示非零项（第二条只有心情/亲密两条）',
  !!(moodSt && moodSt.rendered && moodSt.rendered[1] &&
    Array.isArray(moodSt.rendered[1].delta) && moodSt.rendered[1].delta.length === 2),
  JSON.stringify(moodSt && moodSt.rendered && moodSt.rendered[1] && moodSt.rendered[1].delta))

// ── M7：治理视图是只读的（这是内嵌的安全边界，必须由测试守着）──
const govHtml = String((pages.find(([n]) => n === 'governance-page') || [])[1] || '')
check('governance-page 拉的是只读治理接口', govHtml.includes('/dsh-brain/api/governance'))
check('governance-page 里没有任何写请求（POST/DELETE/PUT）',
  !/method\s*:\s*['"]POST/i.test(govHtml) &&
    !/method\s*:\s*['"]DELETE/i.test(govHtml) &&
    !/method\s*:\s*['"]PUT/i.test(govHtml),
  'no write method')
check('governance-page 写明写操作要去 7420（不在这页做）', govHtml.includes('7420'))

// ── 心海的关系边：三种 kind 必须真的被画出来 ────────────────
// 生产库现在只有 contradicts（6 条），supersedes 是 0 条、supports/refines 也是 0 条，
// 真机上那两种颜色根本看不到。fake 里给每种各一条，再用画布的 strokeStyle 记录
// 证明「页面确实按 kind 分色画了」，而不是只证明「脚本没抛异常」。
const seaRan = ranPages.get('sea-page') || { hooks: [], strokes: [] }
const seaHook = seaRan.hooks[0]
check('sea-page 暴露了调试钩子（自动化验边用）', !!seaHook)
if (seaHook) {
  const seaEdges = seaHook.edges()
  const kinds = Array.from(new Set(seaEdges.map((e) => e.kind))).sort()
  check('sea-page 关系边按 kind 分类（四种都进了 edges）',
    seaEdges.length === 4 && kinds.join(',') === 'contradicts,refines,supersedes,supports',
    JSON.stringify(kinds))
  check('sea-page 假边全部降到 backgroundEdges，没混进 edges',
    seaEdges.every((e) => e.kind !== 'topic') &&
      seaHook.backgroundEdges().length === 2 &&
      seaHook.backgroundEdges().every((e) => e.kind === 'topic'),
    JSON.stringify({ edges: seaEdges.length, background: seaHook.backgroundEdges().length }))
  const pointIds = new Set(seaHook.points().map((p) => p.id))
  check('sea-page 边两端都在点集里（画得出来才点得到）',
    seaEdges.every((e) => pointIds.has(e.a) && pointIds.has(e.b)))
  check('sea-page 默认不画背景边', seaHook.showBackground() === false)
  check('sea-page 没降级（有 0006 就有真实边）', seaHook.degraded() === false)
}

// 颜色证据：画布 stroke 记录里必须同时出现红（矛盾）、赭（取代）、灰（佐证/细化）。
// 这里比对的是 REL 表里那三个 rgb 值，色值改了断言会跟着提醒。
// 用 defaultStrokes（切背景开关之前的首屏快照），不受后面开关实验污染。
const strokeText = (seaRan.defaultStrokes || []).join('|')
const hasRed = strokeText.includes('rgba(224,106,92,')
const hasOchre = strokeText.includes('rgba(210,154,86,')
const hasGrey = strokeText.includes('rgba(150,168,192,')
check('sea-page 画出了红色矛盾边', hasRed, `strokes=${(seaRan.defaultStrokes || []).length}`)
check('sea-page 画出了赭色取代边', hasOchre)
check('sea-page 画出了灰色佐证/细化边', hasGrey)
check('sea-page 默认不画背景弱边（画布上没有 topic 色）',
  !strokeText.includes('rgba(104,122,148,'))

// 开关真的能切：打开 → 重绘一帧 → 画布上出现背景弱边的颜色；关掉 → 消失。
// 只看「默认没画」证明不了开关有用，万一改了变量却没重绘呢。
const probe = seaRan.backgroundProbe
check('sea-page 背景开关默认是关的', probe && probe.defaultOn === false, JSON.stringify(probe && probe.defaultOn))
check('sea-page 开关能打开，且重绘后出现背景弱边',
  probe && probe.turnedOn === true && probe.onStrokes.join('|').includes('rgba(104,122,148,'),
  JSON.stringify(probe && { on: probe.turnedOn, strokes: probe.onStrokes.length }))
check('sea-page 关掉开关后背景弱边从画布上消失',
  probe && probe.offStrokes.length > 0 && !probe.offStrokes.join('|').includes('rgba(104,122,148,'))
check('sea-page 开关切回后状态恢复为关', seaHook && seaHook.showBackground() === false)

const failed = checks.filter((c) => !c.ok)
console.log('\n' + JSON.stringify({
  total: checks.length,
  passed: checks.length - failed.length,
  failed: failed.map((f) => ({ name: f.name, detail: f.detail })),
  note: 'DOM stub + mock fetch：能挡「语法过但跑不起来」的错，不覆盖布局与样式',
}, null, 2))
if (failed.length > 0) process.exitCode = 1

