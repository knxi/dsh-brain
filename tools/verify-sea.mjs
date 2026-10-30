// @ts-check
/**
 * 心海验收：页面结构 + scene 接口字段。**离线**跑，不依赖宿主重启。
 *
 *   node tools/verify-sea.mjs
 */
const m = await import('../apps/brain-tools/index.js')
const sea = await import('../apps/brain-tools/sea-page.js')

const html = sea.renderSeaPage()
console.log('=== 1. 页面 ===')
console.log('字节数:', html.length, '| 行数:', html.split('\n').length)

const STRUCT = [
  ['四个地图模式', ['data-mode="type"', 'data-mode="weight"', 'data-mode="time"', 'data-mode="origin"']],
  ['左侧筛选栏', ['id="filterType"', 'id="filterOrigin"', 'id="q"']],
  ['右侧上下文面板', ['id="detail"', 'id="ctx"']],
  ['hover 提示', ['id="tip"']],
  ['顶部状态条', ['id="count"', 'class="modes"']],
  ['关键函数', ['function layout', 'function frame', 'function showDetail', 'function showTip', 'neighborMap', 'recalTimeRange']],
]
let bad = 0
for (const [name, needles] of STRUCT) {
  const missing = needles.filter((n) => !html.includes(n))
  if (missing.length) { bad += 1; console.log('  ✗', name, '缺:', missing.join(', ')) }
  else console.log('  ✓', name)
}

console.log('\n=== 2. scene 接口 ===')
let route = null
const ctx = {
  tools: { register() {} },
  webServer: { register(o) { route = o; return () => {} } },
  effect(fn) { fn() },
  get(k) { return ctx[k] },
}
m.apply(ctx, { storePath: 'E:/ds-h/dsh-brain/data/brain.db', migrationsDir: 'E:/ds-h/dsh-brain/migrations', scopeId: 'owner-default', personId: 'owner' })

const chunks = []
const res = { writeHead(s) { this.status = s }, end(b) { chunks.push(b) } }
await route.handler({ url: '/dsh-brain/api/scene', method: 'GET' }, res)
const j = JSON.parse(String(chunks[0]))
console.log('HTTP:', res.status, '| stats:', JSON.stringify(j.stats))

const origins = [...new Set(j.points.map((p) => p.origin))]
const types = [...new Set(j.points.map((p) => p.type))]
console.log('origin 取值:', origins.join(', '), '（来源模式靠它着色）')
console.log('type 取值:', types.join(', '))

const missingOrigin = j.points.filter((p) => !p.origin).length
if (missingOrigin) { bad += 1; console.log('  ✗ 有', missingOrigin, '个点缺 origin') }
else console.log('  ✓ 所有点都有 origin')

const sample = j.points[0] || {}
console.log('样例字段:', Object.keys(sample).join(', '))

console.log('\n=== 3. 结论 ===')
console.log(bad === 0 ? '全部通过。宿主重启后 /dsh-brain/sea 就是新版心海。' : ('有 ' + bad + ' 项问题'))
if (bad > 0) process.exitCode = 1
