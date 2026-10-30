// @ts-check
/**
 * brain-tools 冒烟：不装进宿主，先在进程内真跑三个工具。
 *
 * 验什么：
 *   1. apply() 能在假 ctx 上挂出三个工具（且不抛）
 *   2. brain_remember 能真写进一条，返回 memoryId@version
 *   3. brain_search 能真查回来，带来源/版本/有效期
 *   4. brain_forget 能真删掉，删完再查不到
 *   5. 三个工具都不抛异常——只回结构化错误
 *
 * 用 mkdtemp 临时库，绝不碰生产库。
 *
 *   node apps/brain-tools/smoke.mjs
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const MIGRATIONS = 'E:/ds-h/dsh-brain/migrations'

/** @type {any[]} */
const registered = []
/**
 * `session/event` 的监听器（fake ctx 捕获，用来模拟回合结束）。
 * @type {Array<(session: any, event: any) => void>}
 */
const sessionHandlers = []
const fakeCtx = {
  tools: {
    register: (/** @type {any} */ tool) => registered.push(tool),
  },
  // usedLater 观测靠 session/event（emit 监听）。fake ctx 必须提供 on，
  // 否则这条路在冒烟里永远不会被跑到——那等于没验。
  on: (/** @type {string} */ eventName, /** @type {any} */ handler) => {
    if (eventName === 'session/event') sessionHandlers.push(handler)
    return () => {}
  },
}

const dir = mkdtempSync(join(tmpdir(), 'brain-tools-smoke-'))
const storePath = join(dir, 'brain.db')
/**
 * 使用日志也必须落在临时目录。
 * 不传的话会走 DEFAULT_USAGE_LOG（生产 data/logs/usage.jsonl），
 * 冒烟就往观察期数据里掺假数据——那比没有统计更糟。
 */
const usageLogPath = join(dir, 'usage.jsonl')
/** usedLater sidecar 同样必须显式传临时路径（CONTRACTS 12.1 / 12.39）。 */
const usedLaterLogPath = join(dir, 'used-later.jsonl')

/** @type {any[]} */
const checks = []
const check = (/** @type {string} */ name, ok, /** @type {string} */ detail) => {
  checks.push({ name, ok: !!ok, detail })
  const mark = ok ? 'OK  ' : 'FAIL'
  console.log(`[${mark}] ${name} — ${detail}`)
}

try {
  const { apply } = await import('./index.js')
  apply(fakeCtx, {
    storePath,
    migrationsDir: MIGRATIONS,
    scopeId: 'smoke-scope',
    personId: 'smoke-owner',
    usageLogPath,
    usedLaterLogPath,
    // 治理服务（7420）在插件里是进程内自动拉起的（2026-10-30）。
    // 冒烟必须关掉：否则它会拿临时库去 listen 7420，既慢又可能和真机抢端口。
    governance: false,
  })

  check('挂载三个工具', registered.length === 3,
    `registered=${registered.length} names=${registered.map((t) => t.name).join(',')}`)

  /** @type {Map<string, any>} */
  const byName = new Map(registered.map((t) => [t.name, t]))
  check('工具名正确',
    byName.has('brain_search') && byName.has('brain_remember') && byName.has('brain_forget'),
    [...byName.keys()].join(','))

  const remember = byName.get('brain_remember')
  const search = byName.get('brain_search')
  const forget = byName.get('brain_forget')

  // ── 1. 记一条（真实语境：踢脚线报价） ──
  const remembered = await remember.execute({
    content: '踢脚线报价按 1.2m 一段计，铝板材质，含税单价 128 元/段，图号 建施-03。',
    summary: '踢脚线报价：1.2m/段，铝板，128 元/段，建施-03',
    kind: 'fact',
    importance: 0.8,
  })
  check('brain_remember 写入成功', remembered && remembered.ok === true,
    JSON.stringify(remembered).slice(0, 220))
  const memoryId = remembered && remembered.memoryId
  check('返回 memoryId@version', !!memoryId && !!remembered.version, `${memoryId}@v${remembered.version}`)

  // ── 2. 查回来（中文 + 数字 + 图号） ──
  // 带上 exec：usedLater 观测要 sessionId 才能把检索缓到本会话，等 turn/end 判定。
  // 真实宿主就是这么传的（M0 实测事实：exec.agent.session.id）。
  const SMOKE_SESSION = 'smoke-session-1'
  const smokeExec = { agent: { session: { id: SMOKE_SESSION }, phase: { turn: 1 } } }
  const found = await search.execute({ query: '踢脚线报价', limit: 5 }, smokeExec)
  check('brain_search 命中', found && found.ok === true && Array.isArray(found.hits) && found.hits.length > 0,
    `hits=${found && found.hits ? found.hits.length : 0} status=${found && found.diagnostics ? found.diagnostics.status : '?'}`)
  const hit = found && found.hits && found.hits[0]
  check('命中带来源与版本', !!hit && !!hit.memoryId && typeof hit.version === 'number',
    hit ? `${hit.memoryId}@v${hit.version} sources=${hit.sourceCount}` : 'no hit')
  check('写入的命中带来源（不该是 source_missing）',
    !!hit && hit.sourceCount > 0 && found.diagnostics.status !== 'source_missing',
    hit ? `sourceCount=${hit.sourceCount} status=${found.diagnostics.status}` : 'no hit')

  const foundUnit = await search.execute({ query: '1.2m 图号 建施-03', limit: 5 })
  check('数字与图号可查', foundUnit && foundUnit.hits && foundUnit.hits.length > 0,
    `hits=${foundUnit && foundUnit.hits ? foundUnit.hits.length : 0}`)

  // ── 3. 查一个肯定没有的（诊断要如实） ──
  const empty = await search.execute({ query: '量子纠缠退相干玻色子', limit: 5 })
  check('无关查询不硬凑', empty && empty.ok === true && (empty.hits || []).length === 0,
    `status=${empty && empty.diagnostics ? empty.diagnostics.status : '?'} hits=${empty && empty.hits ? empty.hits.length : 0}`)
  check('无关查询的诊断可读', !!empty && !!empty.diagnostics && !!empty.diagnostics.readable,
    empty && empty.diagnostics ? empty.diagnostics.readable : 'missing')

  // ── 4. 忘掉 ──
  const forgotten = await forget.execute({ memoryId, reason: '冒烟测试清理' })
  check('brain_forget 成功', forgotten && forgotten.ok === true,
    JSON.stringify(forgotten).slice(0, 220))
  check('遗忘记了账本 epoch', forgotten && Number.isFinite(forgotten.epoch), `epoch=${forgotten && forgotten.epoch}`)

  const afterForget = await search.execute({ query: '踢脚线报价', limit: 5 })
  check('遗忘后查不到', afterForget && afterForget.ok === true && (afterForget.hits || []).length === 0,
    `hits=${afterForget && afterForget.hits ? afterForget.hits.length : 0} status=${afterForget && afterForget.diagnostics ? afterForget.diagnostics.status : '?'}`)

  // ── 5. 错误路径：不能抛，只回结构化错误 ──
  // kind 用了 enum，dsh-tools 会在 execute 之前就校验并抛——这层框架校验是好事，
  // 真实宿主会把它转成工具错误交给模型。这里同时验证「框架会拦」和「我们自己也拦」。
  let badKindThrew = null
  let badKindResult = null
  try {
    badKindResult = await remember.execute({ content: 'x', kind: '不存在的类型' })
  } catch (error) {
    badKindThrew = error instanceof Error ? error.message : String(error)
  }
  check('非法 kind 被拦（框架 enum 或自己的校验都算）',
    (badKindThrew !== null && /invalid arguments|must be one of/i.test(badKindThrew)) ||
    (badKindResult && badKindResult.ok === false && badKindResult.code === 'BAD_KIND'),
    badKindThrew ? `框架拦下：${badKindThrew}` : JSON.stringify(badKindResult).slice(0, 160))

  const emptyQuery = await search.execute({ query: '   ' })
  check('空 query 回结构化错误', emptyQuery && emptyQuery.ok === false && emptyQuery.code === 'EMPTY_QUERY', JSON.stringify(emptyQuery).slice(0, 160))

  const badForget = await forget.execute({ memoryId: 'mem_does_not_exist_000' })
  check('删不存在的 id 不抛异常', badForget && typeof badForget.ok === 'boolean', JSON.stringify(badForget).slice(0, 200))

  let tooLongThrew = null
  let tooLongResult = null
  try {
    tooLongResult = await remember.execute({ content: 'x'.repeat(501) })
  } catch (error) {
    tooLongThrew = error instanceof Error ? error.message : String(error)
  }
  check('超长内容被拒',
    (tooLongResult && tooLongResult.ok === false && tooLongResult.code === 'CONTENT_TOO_LONG') ||
    (tooLongThrew !== null && /500|length|max/i.test(tooLongThrew)),
    tooLongThrew || (tooLongResult && tooLongResult.code))

  // ── 6. 使用统计：每次检索都要留痕（观察期的全部数据来源） ──
  const { readUsageLog, summarizeUsage } = await import('./usage-log.js')
  const usage = readUsageLog(usageLogPath)
  check('检索留下了使用记录', usage.entries.length > 0,
    `entries=${usage.entries.length} skipped=${usage.skipped} exists=${usage.exists}`)
  check('记录都标了 channel=tool',
    usage.entries.length > 0 && usage.entries.every((e) => e.channel === 'tool'),
    [...new Set(usage.entries.map((e) => e.channel))].join(',') || 'none')
  const repeatQueries = usage.entries.filter((e) => e.query === '踢脚线报价')
  check('同一 query 两次都记下（遗忘前后）', repeatQueries.length === 2, `count=${repeatQueries.length}`)
  check('零命中查询如实记下',
    usage.entries.some((e) => e.query === '量子纠缠退相干玻色子' && e.hitCount === 0),
    JSON.stringify(usage.entries.find((e) => e.query === '量子纠缠退相干玻色子') || {}).slice(0, 160))
  check('失败路径也进统计（空 query）',
    usage.entries.some((e) => e.ok === false && e.code === 'EMPTY_QUERY'), '')
  const usageSummary = summarizeUsage(usage.entries)
  check('聚合能算出来',
    usageSummary.total === usage.entries.length &&
    typeof usageSummary.hitRate === 'number' &&
    usageSummary.failCount >= 1,
    `total=${usageSummary.total} ok=${usageSummary.okCount} fail=${usageSummary.failCount} hitRate=${usageSummary.hitRate} zero=${usageSummary.zeroHitCount} avg=${usageSummary.timing.avg}ms`)
  check('失败检索不算进零命中',
    usageSummary.zeroHitCount === 2 && usageSummary.failCount === 1,
    `zero=${usageSummary.zeroHitCount}（两次真零命中）fail=${usageSummary.failCount}（一次空 query）`)
  check('使用日志没落到生产路径', !usageLogPath.includes('E:/ds-h/dsh-brain/data/logs'), usageLogPath)

  // ── 7. usedLater：turn/end 判定（只认回答里的连续原文） ──
  // 这一段验的是「整条观测链」：apply 真挂了 session/event → 检索真缓存了正文 →
  // turn/end 真判定并落 sidecar。单测只测纯函数，这里测接线。
  check('usedLater 观测挂上了 session/event', sessionHandlers.length === 1, `handlers=${sessionHandlers.length}`)
  const emitSessionEvent = (/** @type {any} */ event) => {
    for (const handler of sessionHandlers) handler({ id: SMOKE_SESSION }, event)
  }
  // 回答里引用了刚写入那条记忆的连续原文（远超 12 字），判据必须判成引用
  emitSessionEvent({
    type: 'assistant/message',
    data: { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: '按记忆里的口径：踢脚线报价按 1.2m 一段计，铝板材质，其余不变。' }] } },
  })
  emitSessionEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

  const { readUsedLaterLog } = await import('./used-later.js')
  const usedLaterRead = readUsedLaterLog(usedLaterLogPath)
  check('turn/end 落下了 usedLater 证据',
    usedLaterRead.exists && usedLaterRead.total === 1,
    `exists=${usedLaterRead.exists} total=${usedLaterRead.total} skipped=${usedLaterRead.skipped}`)
  const evidence = usedLaterRead.entries[0]
  check('回答引用了连续原文 → usedLater:true / evidence:quote',
    !!evidence && evidence.usedLater === true && evidence.evidence === 'quote' && evidence.quoteLen >= 12,
    JSON.stringify({
      usedLater: evidence && evidence.usedLater,
      evidence: evidence && evidence.evidence,
      quoteLen: evidence && evidence.quoteLen,
      memoryIdsCount: evidence && evidence.memoryIdsCount,
    }))
  check('证据只记长度与哈希，不落正文',
    !!evidence && /^[0-9a-f]{8}$/.test(evidence.quoteHash) && !JSON.stringify(evidence).includes('铝板材质'),
    `quoteHash=${evidence && evidence.quoteHash}`)
  check('usedLater 日志在临时目录', !usedLaterLogPath.includes('E:/ds-h/dsh-brain/data/logs'), usedLaterLogPath)
} catch (error) {
  check('未捕获异常（不该有）', false, error instanceof Error ? error.message : String(error))
} finally {
  const failed = checks.filter((c) => !c.ok)
  const report = {
    total: checks.length,
    passed: checks.length - failed.length,
    failed: failed.map((f) => ({ name: f.name, detail: f.detail })),
    note: '临时库，跑完即删；生产库未触碰',
  }
  console.log('\n' + JSON.stringify(report, null, 2))
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  if (failed.length > 0) process.exitCode = 1
}
