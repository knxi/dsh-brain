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

// 导航统一收在 nav.js。心海是近黑底全屏页，所以用它的深色版（同一份导航项，配色跟纸走）。
import { renderNav, NAV_CSS_DARK } from './nav.js'

export function renderSeaPage() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>心海 · 外置大脑</title>
<style>
  *{box-sizing:border-box}
  html,body{margin:0;height:100%;overflow:hidden;background:#07090f;color:#cfd8e6;
    font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased}
  #sea{display:block;position:fixed;inset:0;cursor:grab}
  #sea.dragging{cursor:grabbing}

  #bar{position:fixed;top:0;left:0;right:0;z-index:10;display:flex;align-items:center;gap:14px;
    padding:12px 18px;background:linear-gradient(180deg,rgba(7,9,15,.94),rgba(7,9,15,0))}
  #bar h1{font-size:14.5px;font-weight:600;margin:0;letter-spacing:.03em;color:#e6edf7;flex:none}
  .modes{display:flex;gap:2px;padding:2px;border-radius:9px;background:rgba(18,24,36,.8);
    border:1px solid rgba(120,150,200,.16)}
  .mode{font-size:11.5px;padding:5px 11px;border-radius:7px;cursor:pointer;color:#7e8da5;
    background:transparent;border:none;transition:all .15s;white-space:nowrap;font-family:inherit}
  .mode:hover{color:#cfd8e6}
  .mode.on{background:rgba(120,160,230,.18);color:#a9c6f0}
  #count{margin-left:auto;font-size:11.5px;color:#6f7f96;font-variant-numeric:tabular-nums;flex:none}
  #count b{color:#a9bcd6;font-weight:600}
  .btn{font-size:11.5px;padding:5px 11px;border-radius:7px;cursor:pointer;flex:none;font-family:inherit;
    border:1px solid rgba(140,170,210,.22);background:rgba(20,26,38,.8);color:#cfd8e6;
    transition:all .15s;text-decoration:none;display:inline-block}
  .btn:hover{border-color:rgba(170,200,240,.5);color:#fff;background:rgba(30,38,54,.92)}
  .btn.on{border-color:rgba(170,200,240,.55);color:#ffd18a}

  #side{position:fixed;left:14px;top:60px;bottom:48px;width:186px;z-index:9;
    display:flex;flex-direction:column;gap:12px;overflow-y:auto;padding-right:2px}
  #side::-webkit-scrollbar{width:5px}
  #side::-webkit-scrollbar-thumb{background:rgba(120,150,200,.2);border-radius:3px}
  .card{padding:11px 12px;border-radius:11px;background:rgba(13,17,26,.82);
    border:1px solid rgba(120,150,200,.14);backdrop-filter:blur(8px)}
  .card h3{margin:0 0 8px;font-size:10px;font-weight:600;letter-spacing:.09em;
    text-transform:uppercase;color:#5c6b82}
  .item{display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer;
    font-size:12px;color:#9fb0c7;transition:color .13s;user-select:none}
  .item:hover{color:#e6edf7}
  .item.off{opacity:.32}
  .dot{width:8px;height:8px;border-radius:50%;flex:none}
  .item .n{margin-left:auto;font-size:10.5px;color:#5c6b82;font-variant-numeric:tabular-nums}
  #q{width:100%;padding:6px 9px;border-radius:7px;font-size:12px;font-family:inherit;
    border:1px solid rgba(120,150,200,.18);background:rgba(7,9,15,.7);color:#cfd8e6;outline:none}
  #q:focus{border-color:rgba(170,200,240,.45)}
  #q::placeholder{color:#4a5670}

  #detail{position:fixed;right:14px;top:60px;width:336px;max-height:calc(100vh - 148px);
    overflow-y:auto;z-index:11;padding:16px 18px;border-radius:13px;display:none;
    background:rgba(12,16,25,.95);border:1px solid rgba(140,170,210,.2);
    box-shadow:0 18px 60px rgba(0,0,0,.65);backdrop-filter:blur(12px)}
  #detail::-webkit-scrollbar{width:5px}
  #detail::-webkit-scrollbar-thumb{background:rgba(120,150,200,.2);border-radius:3px}
  #detail.show{display:block}
  #detail .x{float:right;cursor:pointer;color:#66748c;font-size:15px;line-height:1;padding:1px 4px}
  #detail .x:hover{color:#cfd8e6}
  #detail h2{font-size:13.5px;font-weight:600;margin:0 0 9px;color:#e6edf7;line-height:1.5;padding-right:20px}
  .chips{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:11px}
  .chip{font-size:10.5px;padding:2px 8px;border-radius:6px;background:rgba(120,150,200,.13);color:#8fa3c0}
  .chip.warn{background:rgba(200,120,90,.16);color:#d99a76}
  .body{font-size:12.5px;color:#a9b8cd;line-height:1.75;white-space:pre-wrap;word-break:break-word;
    max-height:220px;overflow-y:auto;margin-bottom:12px}
  .row{display:grid;grid-template-columns:62px 1fr;gap:8px;padding:4px 0;
    border-bottom:1px solid rgba(140,170,210,.08);font-size:11.5px}
  .row:last-child{border-bottom:none}
  .k{color:#5c6b82}
  .v{color:#a9b8cd;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}

  #ctx{position:fixed;left:50%;bottom:16px;transform:translateX(-50%) translateY(14px);
    z-index:12;display:flex;gap:7px;padding:7px;border-radius:11px;opacity:0;pointer-events:none;
    background:rgba(13,17,26,.94);border:1px solid rgba(140,170,210,.2);
    box-shadow:0 12px 40px rgba(0,0,0,.6);backdrop-filter:blur(10px);transition:all .18s}
  #ctx.show{opacity:1;pointer-events:auto;transform:translateX(-50%) translateY(0)}

  #tip{position:fixed;z-index:13;pointer-events:none;display:none;max-width:280px;
    padding:7px 11px;border-radius:8px;font-size:11.5px;line-height:1.55;color:#cfd8e6;
    background:rgba(9,12,19,.96);border:1px solid rgba(140,170,210,.22);
    box-shadow:0 8px 26px rgba(0,0,0,.6)}
  #tip.show{display:block}
  #tip b{color:#e6edf7}

  #hint{position:fixed;right:16px;bottom:14px;z-index:8;font-size:11px;color:#4a5670;
    text-align:right;line-height:1.75}
  #error{position:fixed;inset:0;display:none;place-items:center;color:#c98a72;z-index:20;
    font-size:13px;background:rgba(7,9,15,.92);padding:40px;text-align:center}
  #empty{position:fixed;inset:0;display:none;place-items:center;z-index:5;pointer-events:none;
    color:#5c6b82;font-size:13.5px;text-align:center;line-height:2}
  #empty.show{display:grid}

  /* 关系图例与背景开关。
     语义色沿用矛盾核验页（纸感那一屏）的 --bad / --ochre，
     但星海是近黑底，纸面上的暗红 #a8443a / 赭 #a8632f 放上去会糊成一团，
     所以只提亮不明换色相（红仍是那个红、赭仍是那个赭）。 */
  .rel{display:flex;align-items:center;gap:9px;padding:3.5px 0;font-size:11.5px;color:#9fb0c7}
  .rel i{flex:none;width:26px;height:0;border-top-style:solid;border-top-width:2px}
  .rel i.dash{border-top-style:dashed}
  .rel i.thin{border-top-width:1px}
  .rel .n{margin-left:auto;font-size:10.5px;color:#5c6b82;font-variant-numeric:tabular-nums}
  .rel-note{font-size:10.5px;color:#5c6b82;line-height:1.65;margin-top:8px;
    border-top:1px solid rgba(120,150,200,.1);padding-top:8px}
  .sw{flex:none;width:26px;height:14px;border-radius:8px;background:rgba(120,150,200,.16);
    position:relative;transition:background .15s}
  .sw::after{content:'';position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;
    background:#7e8da5;transition:left .15s,background .15s}
  .sw.on{background:rgba(200,160,90,.42)}
  .sw.on::after{left:14px;background:#ffd18a}
  .reltag{display:inline-block;font-size:10.5px;padding:2px 8px;border-radius:6px;margin-bottom:10px;
    border:1px solid currentColor}
  .pair{display:grid;grid-template-columns:1fr;gap:6px;padding:10px 0;margin-bottom:10px;
    border-top:1px solid rgba(140,170,210,.1);border-bottom:1px solid rgba(140,170,210,.1)}
  .pair .side{font-size:12px;color:#a9b8cd;line-height:1.6}
  .pair .end{font-size:10px;color:#5c6b82;letter-spacing:.06em;margin-bottom:2px}
${NAV_CSS_DARK}
</style>
</head>
<body>
<canvas id="sea"></canvas>

<div id="bar">
  <h1>心海</h1>
  <div class="modes" id="modes">
    <button class="mode on" data-mode="type">类型</button>
    <button class="mode" data-mode="weight">重要度</button>
    <button class="mode" data-mode="time">时间</button>
    <button class="mode" data-mode="origin">来源</button>
  </div>
  <span id="count">—</span>
  <button class="btn" id="btnRecent">只看最近</button>
  <button class="btn" id="btnReset">复位</button>
  ${renderNav({ active: 'sea', variant: 'dark' })}
</div>

<div id="side">
  <div class="card">
    <h3>关系</h3>
    <div id="legend"></div>
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
    <h3>搜索</h3>
    <input id="q" placeholder="摘要关键词" autocomplete="off" spellcheck="false">
  </div>
</div>

<div id="detail"></div>
<div id="ctx"></div>
<div id="tip"></div>
<div id="hint">滚轮推拉 · 左键拖旋转 · 右键平移 · 点星看原文 · 点边看关系</div>
<div id="error"></div>
<div id="empty">还没有记忆。<br>让外置大脑记点东西，心海就会亮起来。</div>

<script>
(() => {
  const canvas = document.getElementById('sea')
  const g = canvas.getContext('2d')
  const elCount = document.getElementById('count')
  const elDetail = document.getElementById('detail')
  const elCtx = document.getElementById('ctx')
  const elTip = document.getElementById('tip')
  const elError = document.getElementById('error')
  const elEmpty = document.getElementById('empty')

  const KIND = {
    semantic:     { label: '事实', color: [ 96, 214, 186] },
    profile:      { label: '偏好', color: [126, 206, 255] },
    commitment:   { label: '约定', color: [255, 198, 118] },
    episode:      { label: '经历', color: [138, 172, 255] },
    skill:        { label: '方法', color: [186, 150, 255] },
    self:         { label: '自省', color: [255, 142, 190] },
    relationship: { label: '关系', color: [255, 170, 140] },
    boundary:     { label: '边界', color: [150, 158, 176] },
  }
  const ORIGIN = {
    dsh:     { label: '手记', color: [255, 210, 130] },
    engram:  { label: '迁入', color: [130, 175, 235] },
    brain:   { label: '自省', color: [186, 150, 255] },
    lingshu: { label: '灵枢', color: [150, 200, 180] },
  }
  const FALLBACK = [140, 160, 190]
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
    canvas.width = Math.floor(innerWidth * dpr)
    canvas.height = Math.floor(innerHeight * dpr)
    canvas.style.width = innerWidth + 'px'
    canvas.style.height = innerHeight + 'px'
    g.setTransform(dpr, 0, 0, dpr, 0, 0)
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

  function refreshStats() {
    // 「关联」只数真实关系边。背景边数是另一个数字，挂在开关那一行——
    // 把背景线算进关联合计，等于把「没有关系」报成「有关系」。
    elCount.innerHTML = '<b>' + points.length + '</b> 颗星 · <b>' + edges.length
      + '</b> 条真实关联 · 当前 <b>' + visiblePoints().length + '</b> 可见'
    updateLegendCounts()
    const elBgCount = document.getElementById('bgCount')
    if (elBgCount) elBgCount.textContent = showBackground ? String(backgroundEdges.length) : '关'
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

  async function load() {
    try {
      const res = await fetch('/dsh-brain/api/scene', { credentials: 'same-origin' })
      const data = await res.json()
      if (!data.ok) throw new Error(data.message || '接口返回失败')
      ingest(data)
      recalTimeRange()
    } catch (error) {
      elError.textContent = '读不到心海数据：' + error.message
      elError.style.display = 'grid'
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
    return { x: innerWidth / 2 + x1 * f, y: innerHeight / 2 + y1 * f, f, depth }
  }

  /** 画一条边。线型由 kind 决定；solid=true 用于给强边铺底层光晕（忽略虚线）。 */
  function strokeSeg(a, b, st, alpha, lw, solid) {
    g.save()
    g.lineWidth = Math.max(0.5, lw)
    g.setLineDash(solid ? [] : (st.dash || []))
    g.strokeStyle = 'rgba(' + st.color.join(',') + ',' + Math.max(0, Math.min(1, alpha)).toFixed(3) + ')'
    g.beginPath()
    g.moveTo(a.x, a.y)
    g.lineTo(b.x, b.y)
    g.stroke()
    g.restore()
  }

  function frame(t) {
    stepCam(t)
    g.clearRect(0, 0, innerWidth, innerHeight)

    for (let i = 0; i < 160; i += 1) {
      const x = (hash('bg' + i) % 1000) / 1000 * innerWidth
      const y = (hash('bgy' + i) % 1000) / 1000 * innerHeight
      const a = 0.04 + ((Math.sin(t / 2600 + i) + 1) / 2) * 0.1
      g.fillStyle = 'rgba(150,180,240,' + a + ')'
      g.fillRect(x, y, 1, 1)
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
        strokeSeg(a, b, stBg, alpha, hot ? 1.4 : 0.9)
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
        if (st.weight >= 0.75) strokeSeg(a, b, st, Math.min(0.4, alpha * 0.3), lw * 3.1, true)
        strokeSeg(a, b, st, alpha, lw)
        lastEdgeSegs.push({ x1: a.x, y1: a.y, x2: b.x, y2: b.y, edge, kind })
      }
    }

    if (mode !== 'time') {
      const groups = new Map()
      for (const point of list) {
        const key = point.type || 'other'
        const p = pos.get(point.id)
        const acc = groups.get(key) || { x: 0, y: 0, n: 0, near: 0 }
        acc.x += p.x; acc.y += p.y; acc.n += 1; acc.near = Math.max(acc.near, p.f)
        groups.set(key, acc)
      }
      g.font = '600 12px system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif'
      g.textAlign = 'center'
      for (const pair of groups) {
        const key = pair[0], acc = pair[1]
        if (acc.n < 3) continue
        g.globalAlpha = 0.42 * Math.min(1, acc.near * 1.5)
        g.fillStyle = 'rgb(' + colorOfType(key).join(',') + ')'
        g.fillText(labelOfType(key), acc.x / acc.n, acc.y / acc.n)
      }
      g.globalAlpha = 1
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
      const r = Math.max(0.9, point.radius * p.f * 1.5) * pulseK

      if (point.sources > 0 && r > 2) {
        g.beginPath()
        g.arc(p.x, p.y, r * 1.95, 0, Math.PI * 2)
        g.strokeStyle = 'rgba(' + c.join(',') + ',' + (0.1 * depthFade) + ')'
        g.lineWidth = 1
        g.stroke()
      }

      const glow = g.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3.2)
      glow.addColorStop(0, 'rgba(' + c.join(',') + ',' + (0.55 * depthFade) + ')')
      glow.addColorStop(1, 'rgba(' + c.join(',') + ',0)')
      g.fillStyle = glow
      g.beginPath()
      g.arc(p.x, p.y, r * 3.2, 0, Math.PI * 2)
      g.fill()

      g.fillStyle = 'rgba(' + c.join(',') + ',' + ((isSel || isHov ? 1 : 0.9) * depthFade) + ')'
      g.beginPath()
      g.arc(p.x, p.y, r, 0, Math.PI * 2)
      g.fill()

      if (isSel || isHov) {
        g.beginPath()
        g.arc(p.x, p.y, r * 2.4, 0, Math.PI * 2)
        g.strokeStyle = 'rgba(' + c.join(',') + ',.88)'
        g.lineWidth = 1.5
        g.stroke()
      }
    }

    // 标签：只画最靠前的几个。
    // 原来「f > 0.62 就画」在 217 颗星时会糊成一整片——文字互相压住，比不画更糟。
    // 改成：候选按 f 降序，最多 9 个，且做过重叠剔除（文字块之间有碰撞就跳过）。
    // 其余靠 hover 浮出摘要，这跟群星「悬停才展开细节」是一个思路。
    if (!anchor) {
      const cand = []
      for (const point of list) {
        const p = pos.get(point.id)
        if (p.f > 0.72) cand.push({ point, p })
      }
      cand.sort((a, b) => b.p.f - a.p.f)
      const placed = []
      let drawn = 0
      g.font = '11.5px system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif'
      g.textAlign = 'center'
      for (const item of cand) {
        if (drawn >= 9) break
        const text = item.point.text || ''
        const label = text.length > 16 ? text.slice(0, 16) + '…' : text
        const w = g.measureText(label).width
        const x = item.p.x
        const y = item.p.y + item.point.radius * item.p.f * 1.5 + 14
        // 与已画的标签比矩形碰撞（留 4px 余量）
        let hit = false
        for (const r2 of placed) {
          if (Math.abs(x - r2.x) < (w + r2.w) / 2 + 8 && Math.abs(y - r2.y) < 15) { hit = true; break }
        }
        if (hit) continue
        placed.push({ x, y, w })
        g.globalAlpha = Math.min(0.85, (item.p.f - 0.72) * 4 + 0.35)
        g.fillStyle = '#a9bcd6'
        g.fillText(label, x, y)
        drawn += 1
      }
      g.globalAlpha = 1
    }

    requestAnimationFrame(frame)
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
    meta.style.cssText = 'margin-top:4px;font-size:10.5px;color:#6f7f96'
    meta.textContent = cut(seg.edge.fromSummary, 20) + ' ↔ ' + cut(seg.edge.toSummary, 20)
    elTip.appendChild(meta)
    elTip.classList.add('show')
    elTip.style.left = Math.min(mx + 14, innerWidth - 300) + 'px'
    elTip.style.top = Math.min(my + 14, innerHeight - 80) + 'px'
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

    const x = document.createElement('span')
    x.className = 'x'; x.textContent = '✕'
    x.onclick = () => exitFocus()
    elDetail.appendChild(x)

    const h2 = document.createElement('h2')
    h2.textContent = p.text || '(无摘要)'
    elDetail.appendChild(h2)

    const chips = document.createElement('div')
    chips.className = 'chips'
    const addChip = (txt, warn) => {
      const c = document.createElement('span')
      c.className = 'chip' + (warn ? ' warn' : '')
      c.textContent = txt
      chips.appendChild(c)
    }
    addChip(labelOfType(p.type))
    if (p.layer) addChip(p.layer)
    addChip(labelOfOrigin(p.origin) + ' 来源', p.origin === 'engram')
    addChip('引用 ' + (p.sources || 0) + ' 处', !(p.sources > 0))
    const nb = neighborMap.get(id)
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
    elDetail.appendChild(chips)

    const body = document.createElement('div')
    body.className = 'body'
    body.textContent = p.content || p.text || ''
    elDetail.appendChild(body)

    const rows = [
      ['ID', p.id],
      ['版本', 'v' + (p.version || 1)],
      ['重要度', String(p.weight != null ? p.weight : '—')],
    ]
    if (p.createdAt) rows.push(['记于', new Date(p.createdAt).toLocaleString('zh-CN')])
    if (p.validFrom || p.validUntil) rows.push(['有效期', (p.validFrom || '…') + ' → ' + (p.validUntil || '…')])
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
    meta.style.cssText = 'margin-top:4px;font-size:10.5px;color:#6f7f96'
    meta.textContent = labelOfType(p.type) + ' · ' + labelOfOrigin(p.origin) + ' · 引用 ' + (p.sources || 0) + ' 处' + (nb ? ' · 邻居 ' + nb.size : '')
    elTip.appendChild(meta)
    elTip.classList.add('show')
    elTip.style.left = Math.min(mx + 14, innerWidth - 300) + 'px'
    elTip.style.top = Math.min(my + 14, innerHeight - 80) + 'px'
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
      const id = pickAt(e.clientX, e.clientY)
      hovered = id
      // 星优先：落在一颗星上就只讲这颗星，不当成「边」来悬停。
      // 没星才试边——真实关系边就那么几条，悬停要能命中。
      const seg = id ? null : pickEdge(e.clientX, e.clientY)
      hoverEdgeKey = seg ? edgeKey(seg.edge) : null
      canvas.style.cursor = (id || seg) ? 'pointer' : 'grab'
      if (seg) showEdgeTip(seg, e.clientX, e.clientY)
      else showTip(id, e.clientX, e.clientY)
    }
  })
  window.addEventListener('mouseup', (e) => {
    canvas.classList.remove('dragging')
    if (dragging && !dragMoved && !dragging.right) {
      const id = pickAt(e.clientX, e.clientY)
      if (id) showDetail(id)
      else {
        const seg = pickEdge(e.clientX, e.clientY)
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

  document.getElementById('btnReset').onclick = () => { exitFocus() }
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

  // Esc 退出。先关关系面板（它是最近打开的那层），再退聚焦——
  // 一次 Esc 只退一层，跟「进入一个局部」的心智一致。
  window.addEventListener('keydown', (e) => {
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
          width: innerWidth,
          height: innerHeight,
          dx: Math.round((r.x - innerWidth / 2) * 100) / 100,
          dy: Math.round((r.y - innerHeight / 2) * 100) / 100,
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
