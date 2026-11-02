// @ts-check
/**
 * 心海预览服务（临时，只为验证渲染效果）。
 *
 * 为什么需要：宿主不重启就不会加载新页面代码，但 UI 改完不看一眼等于没验证。
 * 这里用同一个 renderSeaPage() + 同一个数据映射起一个独立小服务，
 * 在临时端口上渲染，截图确认后关掉。**不复用宿主路由、不改生产配置。**
 *
 *   node tools/preview-sea.mjs [port]
 */
import { createServer } from 'node:http'
import { DatabaseSync } from 'node:sqlite'
import { renderSeaPage } from '../apps/brain-tools/sea-page.js'

const PORT = Number(process.argv[2]) || 7421
const DB = 'E:/ds-h/dsh-brain/data/brain.db'
const SCOPE = 'owner-default'

const db = new DatabaseSync(DB, { readOnly: true })

function scene() {
  const raw = db.prepare(`
    SELECT m.id, m.version, m.type, m.origin_system, m.layer, m.source_type,
           m.importance, m.summary, m.content, m.created_at, m.valid_from, m.valid_until,
           (SELECT count(*) FROM source_refs r WHERE r.memory_id = m.id) AS source_count
    FROM memories m
    WHERE m.status != 'deleted' AND m.scope_id = ?
    ORDER BY m.created_at ASC
  `).all(SCOPE)

  const ts = (v) => {
    if (v == null || v === '') return null
    const n = typeof v === 'number' ? v : Date.parse(String(v))
    return Number.isFinite(n) ? n : null
  }
  const points = raw.map((m) => ({
    id: m.id,
    version: m.version,
    text: m.summary || (m.content || '').slice(0, 40),
    content: m.content || '',
    cluster: m.type || 'other',
    type: m.type || 'other',
    origin: m.origin_system || 'other',
    layer: m.layer,
    evidenceKind: m.source_type,
    weight: typeof m.importance === 'number' ? m.importance : 0.5,
    sources: typeof m.source_count === 'number' ? m.source_count : 0,
    createdAt: ts(m.created_at),
    validFrom: m.valid_from,
    validUntil: m.valid_until,
  }))

  const edges = []
  const byCluster = new Map()
  for (const p of points) {
    if (!byCluster.has(p.cluster)) byCluster.set(p.cluster, [])
    byCluster.get(p.cluster).push(p)
  }
  for (const list of byCluster.values()) {
    const sorted = list.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    for (let i = 0; i < sorted.length; i += 1) {
      for (let d = 1; d <= 2 && i + d < sorted.length; d += 1) {
        edges.push({ a: sorted[i].id, b: sorted[i + d].id, score: 0.5 / d, kind: 'topic' })
      }
    }
  }
  return { ok: true, points, edges, stats: { total: points.length, edges: edges.length, clusters: byCluster.size } }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  if (url.pathname === '/dsh-brain/api/scene') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(scene()))
    return
  }
  if (url.pathname === '/' || url.pathname === '/dsh-brain/sea') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(renderSeaPage())
    return
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

server.listen(PORT, '127.0.0.1', () => {
  const s = scene().stats
  console.log('[preview] http://127.0.0.1:' + PORT + '/  |  ' + s.total + ' 点 / ' + s.edges + ' 边 / ' + s.clusters + ' 簇')
  console.log('[preview] 验证完记得关掉（Ctrl+C 或 kill 这个进程）')
})
