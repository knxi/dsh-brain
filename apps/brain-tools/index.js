// @ts-check
/**
 * @dsh-brain/brain-tools — 让模型能主动用外置大脑的工具层。
 *
 * 为什么单独一个包、不并进 connector：
 *   connector 管的是「注入」（往宿主上下文里塞片段），它是 waterfall 形状的东西；
 *   这里管的是「显式检索」（模型自己决定什么时候查、查什么）。
 *   两者的失败模式、权限边界、测试方式都不一样，混在一起会让 connector 那个 50KB
 *   的文件更长，也更难证明「注入不会污染对话」。
 *
 * 三个工具：
 *   - brain_search   查记忆（带来源、版本、有效期、证据强度）
 *   - brain_remember 记一条（主人明确要求记住时用）
 *   - brain_forget   遗忘一条（写 tombstone + 独立删除账本）
 *
 * 纪律（来自 docs/CONTRACTS.md）：
 *   - 工具失败不影响宿主对话：每个 execute 顶层 try/catch，只回结构化错误
 *   - 检索不足要如实说（四种状态：no_related / insufficient_evidence /
 *     source_missing / source_conflict），不许拿相似结果硬凑
 *   - 写入的 originSystem 是 'dsh'（来自 DSH 会话），不是 'brain'——注入回路
 *     要靠这个字段在摄取侧被剔除，不能把自己写成人类证据
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { request as httpRequest } from 'node:http'
import { renderConsolePage } from './console-page.js'
import { renderSeaPage } from './sea-page.js'
import { renderUsagePage } from './usage-page.js'
import { renderConflictsPage } from './conflicts-page.js'
import { renderEntitiesPage } from './entities-page.js'
import { appendUsage, computeCoverage, readUsageLog, summarizeUsage, DEFAULT_WINDOW_DAYS } from './usage-log.js'
import {
  createUsedLaterTracker,
  readUsedLaterLog,
  summarizeUsedLater,
  assistantTextOf,
  DEFAULT_USED_LATER_LOG,
} from './used-later.js'
import {
  createAutoExtractor,
  DEFAULT_AUTO_EXTRACT_LOG,
} from './auto-extract.js'
import {
  appendConflictAction,
  readConflictActions,
  CONFLICT_ACTIONS,
  NOT_CONFLICT_KINDS,
  DEFAULT_CONFLICT_LOG,
} from './conflict-log.js'

export const name = 'brain-tools'
export const inject = ['tools', 'webServer']

/** 控制台路由前缀：挂在 DSH 自己的 webServer 上，同源同端口，不额外起服务。 */
const ROUTE = '/dsh-brain'

/** 默认生产库路径。可以用 config.storePath 覆盖。 */
const DEFAULT_STORE = 'E:/ds-h/dsh-brain/data/brain.db'
/** 默认迁移目录 */
const DEFAULT_MIGRATIONS = 'E:/ds-h/dsh-brain/migrations'
/**
 * 使用日志默认落点。放 data/logs/ 而不是库旁边：它是观测数据，
 * 不进主账、不参与备份/恢复/删除账本，过期可以直接删文件。
 */
const DEFAULT_USAGE_LOG = 'E:/ds-h/dsh-brain/data/logs/usage.jsonl'
/** 使用情况页默认统计窗口（天） */
const DEFAULT_USAGE_WINDOW_DAYS = 7

/**
 * 结构化错误：永远不把异常抛给宿主。
 * @param {unknown} error
 * @param {string} where
 */
function toolError(error, where) {
  const err = /** @type {any} */ (error)
  const code = err && typeof err.code === 'string' ? err.code : 'TOOL_ERROR'
  const message = err && typeof err.message === 'string' ? err.message : String(error)
  return {
    ok: false,
    code,
    message: `外置大脑 ${where} 失败：${message}`,
    hint: '这是工具层内部错误，不影响当前对话。可以继续正常回答。',
  }
}

/**
 * 把检索诊断翻译成人话。
 * 四种"没搜到"必须分开说，否则模型会把"证据不够"当成"没有"。
 * @param {any} diagnostics
 */
function explainDiagnostics(diagnostics) {
  const status = diagnostics && diagnostics.status ? diagnostics.status : 'ok'
  const notes = Array.isArray(diagnostics && diagnostics.notes) ? diagnostics.notes : []
  /** @type {Record<string,string>} */
  const human = {
    ok: '检索正常',
    no_related: '确实没有相关记忆（不是丢了，是没有）',
    insufficient_evidence: '可能相关，但证据不够——不要据此下确定结论',
    source_missing: '找到了，但来源已丢失，无法核对原文',
    source_conflict: '找到了，但来源之间有冲突，需要你判断',
  }
  return {
    status,
    readable: human[status] || status,
    notes,
    primaryLaneHit: diagnostics && typeof diagnostics.primaryLaneHit === 'boolean'
      ? diagnostics.primaryLaneHit
      : null,
    degraded: diagnostics && diagnostics.degraded ? diagnostics.degraded : null,
  }
}

/**
 * 一条命中渲染成人话：摘要 + 坐标 + 来源 + 有效期 + 证据强度。
 * 坐标（memoryId@version）是给"能不能核对原文"用的，不能省。
 * @param {any} hit
 */
function renderHit(hit) {
  const refs = Array.isArray(hit.sourceRefs) ? hit.sourceRefs : []
  return {
    memoryId: hit.memoryId,
    version: hit.version,
    summary: hit.summary,
    layer: hit.layer,
    type: hit.type,
    evidenceKind: hit.evidenceKind,
    validFrom: hit.validFrom,
    validUntil: hit.validUntil,
    score: hit.score,
    matchedBy: hit.matchedBy,
    sources: refs.map((/** @type {any} */ r) => ({
      id: r.id,
      system: r.sourceSystem,
      eventId: r.sourceEventId || r.eventId,
      locator: r.locator,
      contentHash: r.contentHash,
    })),
    sourceCount: refs.length,
  }
}

export function apply(ctx, config) {
  const storePath = (config && config.storePath) || DEFAULT_STORE
  const migrationsDir = (config && config.migrationsDir) || DEFAULT_MIGRATIONS
  const scopeId = (config && config.scopeId) || 'owner-default'
  const personId = (config && config.personId) || 'owner'
  const usageLogPath = (config && config.usageLogPath) || DEFAULT_USAGE_LOG
  const usageWindowDays = Number(config && config.usageWindowDays) > 0
    ? Number(config.usageWindowDays)
    : DEFAULT_USAGE_WINDOW_DAYS
  /**
   * usedLater 证据落点（sidecar）。同样必须可配置：冒烟/测试显式传临时路径，
   * 否则合成数据会写进观察期日志——比没有统计更糟（CONTRACTS 12.1 / 12.39）。
   */
  const usedLaterLogPath = (config && config.usedLaterLogPath) || DEFAULT_USED_LATER_LOG
  /**
   * 命中是否被回答用上：只能在 turn/end 判定，所以单独一个观察器。
   * 它只读内存缓存（turn/end 那一刻索引已关，CONTRACTS 10.8），零抛出。
   */
  const usedLaterTracker = createUsedLaterTracker({ logPath: usedLaterLogPath })
  /**
   * 矛盾核验动作的审计流水（M7）。同样必须可配置：验收脚本显式传临时路径，
   * 否则合成的「核验动作」会写进生产流水，让人以为真有人在页面上点过。
   */
  const conflictLogPath = (config && config.conflictLogPath) || DEFAULT_CONFLICT_LOG

  /**
   * 记一次检索。**永不抛、永不阻塞结论**——appendUsage 内部已经吞掉所有错误，
   * 这里再包一层是为了让调用点看不出差别（观测失败不该被误读成检索失败）。
   * @param {Record<string, any>} entry
   */
  const recordUsage = (entry) => {
    appendUsage(usageLogPath, entry)
  }

  /** @type {Promise<any> | null} */
  let brainPromise = null
  /**
   * 懒加载 + 单例。加载失败不缓存失败结果，下次还能重试。
   */
  const getBrain = () => {
    if (!brainPromise) {
      brainPromise = (async () => {
        const mod = await import('@dsh-brain/memory')
        const openBrain = mod.openBrain
        if (typeof openBrain !== 'function') throw new Error('@dsh-brain/memory 没有导出 openBrain')
        return openBrain({ dbPath: storePath, migrationsDir, bindings: { scope_id: scopeId, person_id: personId } })
      })().catch((error) => {
        brainPromise = null
        throw error
      })
    }
    return brainPromise
  }

  const tools = ctx.tools || (typeof ctx.get === 'function' ? ctx.get('tools') : null)
  if (!tools || typeof tools.register !== 'function') {
    // 没 tools 服务就什么都不挂，但也不抛——加载期失败只该降级。
    console.error('[brain-tools] 没有 tools 服务，工具未挂载')
    return
  }

  // ── M5 Phase 1 自动提取（规则型，2026-10-30 夜）────────────────
  // 立场（ROADMAP 第二优先那节的原话）：自动提取质量差会污染记忆库，**污染比没有更糟**。
  // 所以这一版只认「明确到不需要解释」的句式（规则全在 auto-extract.js），
  // 配额硬限、写库标记 observation + 「（自动提取）」、随时可关、失败静默。
  // **不调模型**：Brain 自身不发 LLM 请求，语义提取等观察期数据够了再说。
  const autoExtractLogPath = (config && config.autoExtractLogPath) || DEFAULT_AUTO_EXTRACT_LOG
  const autoExtractEnabled = !(config && config.autoExtract === false)
    && String(process.env.BRAIN_AUTO_EXTRACT || '').toLowerCase() !== 'off'
  const autoExtractor = createAutoExtractor({
    logPath: autoExtractLogPath,
    enabled: autoExtractEnabled,
    maxPerTurn: config && config.autoExtractPerTurn != null ? Number(config.autoExtractPerTurn) : 1,
  })
  /**
   * 已判定过的 turn。同一个 turn 重复 judge 会重复产候选、重复扣配额
   * （模块文档点名过），所以在这里按 `(sessionId, turn)` 去重。有界。
   */
  const judgedTurns = new Set()

  /**
   * turn/end 之后异步跑：候选 → 去重 → 写库（observation）→ 关联来源 → 落 sidecar。
   * **整段零抛出**：它跑在宿主的事件回调里，抛错会让 turn/end reason=error。
   *
   * @param {string} sessionId
   * @param {number|null} turn
   * @returns {Promise<void>}
   */
  const runAutoExtract = async (sessionId, turn) => {
    try {
      const key = `${sessionId}#${String(turn)}`
      if (judgedTurns.has(key)) return
      judgedTurns.add(key)
      if (judgedTurns.size > 512) {
        const oldest = judgedTurns.values().next()
        if (!oldest.done) judgedTurns.delete(oldest.value)
      }
      const result = autoExtractor.judgeTurn({ sessionId, turn })
      if (result.candidates.length === 0) {
        if (result.skipped === 'quota' || result.skipped === 'disabled') {
          await autoExtractor.record({
            sessionId,
            turn,
            rule: 'n/a',
            status: result.skipped === 'quota' ? 'skipped_quota' : 'skipped_disabled',
          })
        }
        return
      }
      const brain = await getBrain()
      for (const candidate of result.candidates) {
        try {
          // 去重：同 scope 同 content 已有就不写。自动提取绝不能制造重复
          // （本项目刚花力气合并过 5 对同义重复）。
          const dup = brain.db
            .prepare("SELECT id FROM memories WHERE status = 'active' AND scope_id = ? AND content = ? LIMIT 1")
            .get(scopeId, candidate.content)
          if (dup !== undefined) {
            await autoExtractor.record({
              sessionId,
              turn,
              rule: candidate.rule,
              status: 'duplicate',
              memoryId: String(/** @type {any} */ (dup).id),
              excerptLen: candidate.excerptLen,
            })
            continue
          }
          const created = await brain.memories.create({
            scopeId,
            personId,
            layer: 'long',
            type: candidate.type === 'profile' ? 'profile' : 'semantic',
            content: candidate.content,
            summary: candidate.summary,
            // 机器读出来的，不是主人原话 —— 这条不能写成 owner_words（CONTRACTS §18.6 同源纪律）
            sourceType: 'observation',
            sourceIds: [],
            confidence: 0.6,
            importance: 0.4,
            privacy: 'private',
            originSystem: 'dsh',
            producer: 'brain-tools:auto-extract',
          })
          try {
            await brain.sources.link(created.id, {
              sourceKind: 'tool_call',
              sourceSystem: 'dsh',
              sourceEventId: `turn:${sessionId}:${String(turn)}`,
              locator: 'brain-tools/auto-extract',
            })
          } catch {
            /* 来源关联失败不改写结论：记忆本身已经写进去了 */
          }
          await autoExtractor.record({
            sessionId,
            turn,
            rule: candidate.rule,
            status: 'created',
            memoryId: created.id,
            excerptLen: candidate.excerptLen,
          })
        } catch (error) {
          await autoExtractor.record({
            sessionId,
            turn,
            rule: candidate.rule,
            status: 'failed',
            reason: (error instanceof Error ? error.message : String(error)).slice(0, 160),
            excerptLen: candidate.excerptLen,
          })
        }
      }
    } catch {
      /* 失败静默：提取坏了不影响主人回合 */
    }
  }

  /**
   * 事件分发：user/message 缓存（提取只认主人说的话），turn/end 判定。
   * 同步、零抛出；真正写库的那段是 fire-and-forget。
   *
   * @param {any} session
   * @param {any} event
   * @returns {void}
   */
  const autoExtractOnEvent = (session, event) => {
    try {
      const sessionId = typeof session?.id === 'string' && session.id ? session.id : null
      if (sessionId === null) return
      const type = typeof event?.type === 'string' ? event.type : ''
      const data = event?.data !== undefined && event?.data !== null && typeof event.data === 'object' ? event.data : {}
      const turn = typeof data.turn === 'number' && Number.isFinite(data.turn) ? data.turn : null
      if (type === 'user/message') {
        // 复用 used-later 的取文本实现（user/message 与 assistant/message 的 data 同形）。
        const text = assistantTextOf(data)
        if (text.length > 0) autoExtractor.noteUserMessage(sessionId, turn, text)
        return
      }
      if (type === 'turn/end') {
        const reasonKind = data.reason && typeof data.reason === 'object' ? data.reason.kind : data.reason
        // 只提取「正常完成」的回合：中断/报错的回合里，主人的话可能没说完。
        if (String(reasonKind) !== 'completed') return
        void runAutoExtract(sessionId, turn)
      }
    } catch {
      /* 静默 */
    }
  }

  // ── usedLater 观测：turn/end 钩子（M4.6）────────────────────────
  // `session/event` 是 **emit 监听**，签名 `(session, event)`，没有 next。
  // 写成 waterfall 形状（多写 next 参数）就是运行期抛错 → turn/end reason=error +
  // 进程退出码 1，直接把观测事故变成主人回合的事故（CONTRACTS 10.2 实测踩过）。
  // handler 内部已顶层 try/catch；注册动作再包一层，加载期失败只降级。
  // 只挂监听、不注入、不改宿主任何数组——这里只读事件。
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('session/event', (session, event) => {
        usedLaterTracker.handleSessionEvent(session, event)
        autoExtractOnEvent(session, event)
      })
      console.error(
        `[brain-tools] usedLater 观测 + 自动提取已挂载（提取${autoExtractEnabled ? '开' : '关'}）`,
      )
    } else {
      console.error('[brain-tools] 没有 ctx.on，usedLater 观测与自动提取未挂载（工具不受影响）')
    }
  } catch (error) {
    console.error('[brain-tools] 观测钩子挂载失败（已忽略）:', error instanceof Error ? error.message : String(error))
  }

  // ── brain_search ───────────────────────────────────────────────
  tools.register(defineTool({
    name: 'brain_search',
    description:
      '查外置大脑里的长期记忆。主人提到「之前说过的」「上次那个」「你还记得吗」、' +
      '或者要复用早先定过的参数/决定/偏好时，用它。' +
      '返回带来源、版本、有效期和证据强度的命中；命中不足时会如实说明是「没有」还是「证据不够」，' +
      '这时不要硬答。不要拿它替代正常工作——只在真的需要跨会话记忆时查。',
    parameters: {
      query: {
        type: 'string',
        description: '检索关键词或一句话。中文、尺寸、图号、代码标识符都可以。',
      },
      limit: {
        type: 'number',
        description: '最多返回几条，默认 8，范围 1–20。',
      },
      asOf: {
        type: 'string',
        description: '可选，ISO 日期。查「某个时点这条记忆是什么样」，用于看历史版本。',
      },
      entity: {
        type: 'string',
        description:
          '可选，按实体收窄：人名 / 项目名 / 工具名 / 概念名（如「灵枢」「dsh-im」「Remotion」）。' +
          '只给 entity 不给 query 时，列出这个实体名下的全部记忆；' +
          '同时给 query 时，先在检索结果里筛出属于该实体的那些。查「关于 X 我们都定过什么」用它。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      // ── 使用统计埋点 ────────────────────────────────────────────
      // 用 finally 统一落盘，不靠每个 return 手动补：漏一条路径，统计数据就有洞，
      // 而这份数据是用来判断「能不能卸掉灵枢/Engram」的，不能有洞。
      // 会话身份只能从运行时字段拿——工具参数 schema 里没有 sessionId（M0 实测事实 4）。
      const startedAt = Date.now()
      const sessionId = exec && exec.agent && exec.agent.session ? exec.agent.session.id : null
      const queryForLog = args && typeof args.query === 'string' ? args.query.trim() : ''
      const limitForLog = Math.min(Math.max(Number(args && args.limit) || 8, 1), 20)
      /** @type {Record<string, any> | null} */
      let logged = null
      try {
        const query = typeof args.query === 'string' ? args.query.trim() : ''
        const entityNeedle = typeof args.entity === 'string' ? args.entity.trim() : ''
        if (!query && !entityNeedle) {
          logged = { ok: false, code: 'EMPTY_QUERY', hitCount: 0, status: 'error' }
          return { ok: false, code: 'EMPTY_QUERY', message: 'query 不能为空（想按实体查就给 entity）。' }
        }
        const limit = Math.min(Math.max(Number(args.limit) || 8, 1), 20)
        const brain = await getBrain()

        // ── 实体解析（可选）────────────────────────────────────────
        // 「关于 X 我们都定过什么」靠全文检索拼不出来：得先知道哪些记忆挂在 X 名下。
        // 实体对不上或有多解时**不猜**——猜错会拿不相干的记忆冒充本实体的证据，
        // 比直接说「对不上」糟得多。
        /** @type {any} */
        let entityHit = null
        if (entityNeedle) {
          if (!brain.entities || typeof brain.entities.resolve !== 'function') {
            logged = { ok: false, code: 'ENTITY_UNSUPPORTED', hitCount: 0, status: 'error' }
            return { ok: false, code: 'ENTITY_UNSUPPORTED', message: '这个库还不支持按实体查（缺 0006 迁移或 entities 门面）。' }
          }
          const resolved = brain.entities.resolve(entityNeedle, { scopeId })
          if (!resolved.entity) {
            const candidates = (resolved.candidates || []).map((/** @type {any} */ e) => `${e.name}（${e.kind}）`)
            const ambiguous = resolved.ambiguous === true
            logged = {
              ok: false,
              code: ambiguous ? 'AMBIGUOUS_ENTITY' : 'ENTITY_NOT_FOUND',
              hitCount: 0,
              status: 'no_related',
            }
            return {
              ok: true,
              message: ambiguous
                ? `「${entityNeedle}」对上了不止一个实体：${candidates.join('、')}。请用更完整的名字重查一次。`
                : `没有叫「${entityNeedle}」的实体。可以不带 entity 直接按关键词查。`,
              hits: [],
              diagnostics: { status: 'no_related', readable: '实体没对上，没有检索', notes: [], primaryLaneHit: null, degraded: null },
              entityQuery: { needle: entityNeedle, resolved: false, ambiguous, candidates },
            }
          }
          entityHit = resolved.entity
        }

        // ── 检索 ───────────────────────────────────────────────────
        let hits = []
        let diagnostics = { status: 'ok', readable: '检索正常', notes: [], primaryLaneHit: null, degraded: null }
        if (query) {
          const result = brain.memories.search({
            query,
            scopeId,
            personId,
            limit,
            ...(args.asOf ? { asOf: args.asOf } : {}),
          })
          hits = (result.hits || []).map(renderHit)
          diagnostics = explainDiagnostics(result.diagnostics)
        }

        // ── 实体过滤 / 按实体列清单 ─────────────────────────────────
        /** @type {any[]} */
        let entityItems = []
        let entityFallback = false
        if (entityHit) {
          const owned = brain.entities.memoriesFor(entityHit.id, { limit: 500, scopeId })
          const ownedIds = new Set(owned.map((/** @type {any} */ m) => m.memoryId))
          if (query) {
            const filtered = hits.filter((h) => ownedIds.has(h.memoryId))
            if (filtered.length > 0) {
              hits = filtered
            } else {
              // 检索有结果、但没有一条属于这个实体：不静默给空——
              // 退回实体名下清单并明确说「没命中这个词」，让模型自己决定怎么用。
              entityFallback = true
              entityItems = owned.slice(0, limit)
              hits = []
            }
          } else {
            entityItems = owned.slice(0, limit)
          }
        }

        // 给每条命中补上它挂的实体：跨会话回答「这是关于谁的」时才不用再查一次
        for (const h of hits) {
          try {
            h.entities = brain.entities ? brain.entities.forMemory(h.memoryId, { scopeId }).map((/** @type {any} */ e) => e.name) : []
          } catch {
            h.entities = []
          }
        }

        const lines = []
        if (entityHit) {
          const aliasText = entityHit.aliases && entityHit.aliases.length ? `，别名 ${entityHit.aliases.join('/')}` : ''
          lines.push(`实体「${entityHit.name}」（${entityHit.kind}${aliasText}）：`)
        }
        if (entityItems.length > 0) {
          if (entityFallback) {
            lines.push(`检索「${query}」没有命中这个实体名下的记忆，下面改成列出它名下全部 ${entityItems.length} 条：`)
          } else if (!query) {
            lines.push(`名下共 ${entityItems.length} 条记忆：`)
          }
          for (const m of entityItems) {
            const span = m.validFrom || m.validUntil
              ? `　有效期 ${m.validFrom || '…'} → ${m.validUntil || '…'}`
              : ''
            lines.push(`· [${m.memoryId}] ${m.summary || '（无摘要）'}（${m.layer}/${m.type}，重要度 ${m.importance}）${span}`)
          }
        }
        if (hits.length > 0) {
          lines.push(`找到 ${hits.length} 条（${diagnostics.readable}）：`)
          for (const h of hits) {
            const span = h.validFrom || h.validUntil
              ? `　有效期 ${h.validFrom || '…'} → ${h.validUntil || '…'}`
              : ''
            const ents = h.entities && h.entities.length ? `　实体 ${h.entities.join('/')}` : ''
            lines.push(`· [${h.memoryId}@v${h.version}] ${h.summary}（${h.layer}/${h.type}/${h.evidenceKind}，来源 ${h.sourceCount} 条）${span}${ents}`)
          }
          if (diagnostics.primaryLaneHit === false) {
            lines.push('注意：这批结果来自弱检索路径（主路没命中），可信度低于正常命中，当作线索而不是定论。')
          }
          if (diagnostics.status !== 'ok') {
            lines.push(`注意：${diagnostics.readable}。`)
          }
        }
        if (hits.length === 0 && entityItems.length === 0) {
          lines.push(entityHit && query
            ? `这个实体名下没有匹配「${query}」的记忆。`
            : `没找到相关记忆（${diagnostics.readable}）。`)
        }

        // ── usedLater 观测：缓存「命中 + 正文」，等 turn/end 再判定 ──
        // 工具层看不到后续回答（CONTRACTS 12.5），判定只能放到回合结束；
        // 而 turn/end 那一刻检索索引已关（CONTRACTS 10.8），正文必须现在读、现在缓存。
        //
        // 三条纪律：
        // 1. 只缓存**真正检索命中**（hits）；按实体列清单（entityItems）没有 query 命中
        //    语义，混进引用率会把两个口径搅在一起。
        // 2. 缓存有界（见 used-later.js 的 MAX_* 常量）；日志里不落正文，只记
        //    quoteLen / quoteHash。
        // 3. 缓存失败不影响检索：noteSearch 内部吞错，这里读正文也逐条 try。
        if (sessionId) {
          /** @type {Array<{ memoryId: string, content: string }>} */
          const cacheHits = []
          for (const hit of hits) {
            const memoryId = typeof hit.memoryId === 'string' ? hit.memoryId : ''
            if (!memoryId) continue
            let content = ''
            try {
              // 单条读取：search 返回的 hit 里没有正文（只有 summary），
              // 而判据要的是「正文的连续原文片段」，所以这里补读一次。
              const memory = brain.memories.get(memoryId, { scopeId })
              content = memory && typeof memory.content === 'string' ? memory.content : ''
            } catch {
              content = ''
            }
            cacheHits.push({ memoryId, content })
          }
          const phaseTurn = exec && exec.agent && exec.agent.phase ? exec.agent.phase.turn : null
          usedLaterTracker.noteSearch({
            sessionId,
            turn: typeof phaseTurn === 'number' && Number.isFinite(phaseTurn) ? phaseTurn : null,
            query,
            hits: cacheHits,
          })
        }

        logged = {
          ok: true,
          hitCount: hits.length + entityItems.length,
          hitIds: [...hits.map((h) => h.memoryId), ...entityItems.map((m) => m.memoryId)],
          status: diagnostics.status,
          primaryLaneHit: diagnostics.primaryLaneHit,
          degraded: diagnostics.degraded,
        }
        return {
          ok: true,
          message: lines.join('\n'),
          hits,
          ...(entityItems.length > 0 ? { entityItems } : {}),
          diagnostics,
          ...(entityHit
            ? {
                entity: {
                  id: entityHit.id,
                  name: entityHit.name,
                  kind: entityHit.kind,
                  aliases: entityHit.aliases,
                  memoryCount: entityHit.memoryCount,
                  fallback: entityFallback,
                },
              }
            : {}),
        }
      } catch (error) {
        const failure = toolError(error, '检索')
        logged = { ok: false, code: failure.code, hitCount: 0, status: 'error' }
        return failure
      } finally {
        recordUsage({
          channel: 'tool',
          query: queryForLog,
          limit: limitForLog,
          asOf: args && args.asOf ? args.asOf : null,
          durationMs: Date.now() - startedAt,
          sessionId,
          ...(logged || { ok: false, code: 'NO_OUTCOME', hitCount: 0, status: 'error' }),
        })
      }
    },
  }))

  // ── brain_remember ─────────────────────────────────────────────
  tools.register(defineTool({
    name: 'brain_remember',
    description:
      '把一条信息写进外置大脑的长期记忆。**只在主人明确要求「记住」「记一下」「别忘」时用**，' +
      '不要自作主张往里塞东西——记忆会跨会话影响以后的行为，乱写比不写糟。' +
      '写进去的内容带 DSH 会话来源，不会被当成独立的人类证据二次吸收。',
    parameters: {
      content: {
        type: 'string',
        description: '要记住的内容，一句话说清（不超过 500 字）。',
      },
      summary: {
        type: 'string',
        description: '可选，注入用的短摘要（不超过 120 字）。不填会自动截取 content 前 40 字。',
      },
      kind: {
        type: 'string',
        enum: ['fact', 'preference', 'decision', 'episode', 'skill'],
        description: '记忆类型：fact 事实 / preference 偏好 / decision 决定 / episode 经历 / skill 方法。默认 fact。',
      },
      importance: {
        type: 'number',
        description: '重要度 0–1，默认 0.6。只有真正长期有用的才值得高。',
      },
      origin: {
        type: 'string',
        enum: ['owner_words', 'observation'],
        description:
          '这条信息从哪来：owner_words = 主人亲口说的（默认，置信度 1）；' +
          'observation = 我读文档/自己观察到的结论（置信度 0.8）。' +
          '**别把文档结论记成主人原话**——混了之后就没法区分「他说的」和「我看来的」。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      try {
        const content = typeof args.content === 'string' ? args.content.trim() : ''
        if (!content) return { ok: false, code: 'EMPTY_CONTENT', message: 'content 不能为空。' }
        if (content.length > 500) {
          return { ok: false, code: 'CONTENT_TOO_LONG', message: `内容 ${content.length} 字，超过 500 字上限。请压缩后再记。` }
        }
        const kindInput = typeof args.kind === 'string' ? args.kind : 'fact'
        const typeMap = {
          fact: 'semantic', preference: 'profile', decision: 'semantic',
          episode: 'episode', skill: 'skill',
        }
        const layerMap = {
          fact: 'long', preference: 'long', decision: 'long',
          episode: 'long', skill: 'long',
        }
        if (!(kindInput in typeMap)) {
          return { ok: false, code: 'BAD_KIND', message: 'kind 只能是 fact / preference / decision / episode / skill。' }
        }
        const summary = typeof args.summary === 'string' && args.summary.trim()
          ? args.summary.trim().slice(0, 120)
          : content.slice(0, 40)
        const importance = Math.min(Math.max(Number(args.importance) || 0.6, 0), 1)
        // origin（2026-10-30 加）：区分「主人亲口说的」和「我读文档/观察到的结论」。
        // 之前这里硬编码 owner_words + confidence=1 —— 把文档结论记成主人原话是虚报，
        // 而且会让 M5 自动提取那套「observation 才算我看到的」失去区分度。
        const originInput = args.origin === 'observation' ? 'observation' : 'owner_words'
        const sourceType = originInput
        const confidence = originInput === 'observation' ? 0.8 : 1
        const brain = await getBrain()
        const created = await brain.memories.create({
          scopeId,
          personId,
          layer: layerMap[kindInput],
          type: typeMap[kindInput],
          content,
          summary,
          sourceType,
          sourceIds: [],
          confidence,
          importance,
          privacy: 'private',
          // 来源系统仍是 dsh：无论哪种 origin，都是「在 DSH 会话里被写进来的」。
          // 区分「谁说的」靠 sourceType，不靠 originSystem——后者是摄取侧防回路的键。
          originSystem: 'dsh',
          producer: 'brain-tools:brain_remember',
        })
        // 关联来源：不然检索会如实报 `source_missing`（「来源已丢失，无法核对原文」），
        // 而实际上来源就是「主人在 DSH 会话里明确要求记住」这个动作本身。
        // sourceKind 用 'tool_call' 最贴切——这条记忆来自一次工具调用，不是某条会话事件。
        // resolveEventIdentity 对 events 表里没有的 id 只记 source_event_id、不当孤儿，所以合成 id 安全。
        try {
          await brain.sources.link(created.id, {
            sourceKind: 'tool_call',
            sourceSystem: 'dsh',
            sourceEventId: `tool:brain_remember:${created.id}`,
            locator: 'brain-tools/brain_remember',
          })
        } catch (linkError) {
          // 来源关联失败不改写结论——记忆本身已经写进去了
          console.error('[brain-tools] 来源关联失败:', linkError instanceof Error ? linkError.message : String(linkError))
        }
        return {
          ok: true,
          message: `记住了 [${created.id}@v${created.version}]：${summary}`,
          memoryId: created.id,
          version: created.version,
        }
      } catch (error) {
        return toolError(error, '写入')
      }
    },
  }))

  // ── brain_forget ───────────────────────────────────────────────
  tools.register(defineTool({
    name: 'brain_forget',
    description:
      '遗忘一条外置大脑记忆。**只在主人明确要求删除/忘掉时用**。' +
      '它会立刻让这条记忆不可检索、写独立删除账本、并异步清理正文与索引。' +
      '注意：这会把内容从大脑里删掉，但不等于从你所有备份和别的插件里删净——报告会如实分层说明。',
    parameters: {
      memoryId: {
        type: 'string',
        description: '要遗忘的记忆 ID（来自 brain_search 或 brain_remember 的返回）。',
      },
      reason: {
        type: 'string',
        description: '可选，删除原因（会记进删除账本，不超过 160 字）。默认「主人要求遗忘」。',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args) {
      try {
        const memoryId = typeof args.memoryId === 'string' ? args.memoryId.trim() : ''
        if (!memoryId) return { ok: false, code: 'EMPTY_ID', message: 'memoryId 不能为空。' }
        const reason = typeof args.reason === 'string' && args.reason.trim()
          ? args.reason.trim().slice(0, 160)
          : '主人要求遗忘'
        const brain = await getBrain()
        // 注意：deletion.requestDeletion 的入参是 snake_case（target_kind / target_id / scope_id / reason），
        // 不是 { memoryId }。M3 实测的签名，别按直觉写。
        const result = await brain.deletion.requestDeletion({
          target_kind: 'memory',
          target_id: memoryId,
          scope_id: scopeId,
          reason,
          jobs: ['purge_text', 'scrub_index', 'drop_context_packages', 'purge_exports', 'purge_blobs'],
        })
        return {
          ok: true,
          message:
            `已开始遗忘 ${memoryId}：立即屏蔽生效，删除账本已记（epoch ${result && result.deletion_epoch}）。\n` +
            '正文与索引的清理是异步的；旧备份里的副本要等备份到期，外部副本无法核实——这些都已经记在删除状态报告里。',
          // 注意字段名：requestDeletion 返回的是 snake_case
          // { status, tombstone_id, deletion_epoch, affected, jobs, outbox_id, ledger }
          tombstoneId: result && result.tombstone_id,
          epoch: result && result.deletion_epoch,
          ledgerSynced: !!(result && result.ledger),
          affected: result && result.affected,
        }
      } catch (error) {
        return toolError(error, '遗忘')
      }
    },
  }))

  // ── 治理服务：进程内拉起 + 同源代理（2026-10-30 晚）────────────
  // 主人的原话是「治理面板不要输入命令打开」——他要的是点一下就能用。
  // 之前只内嵌了只读视图，写操作还得去开终端，这不是他要的。
  //
  // 做法：在**本进程内**启动原来的治理服务（复用 apps/server，同库、同 token 机制），
  // 再把 `/dsh-brain/governance` 代理过去。这样：
  //   - 删除 / 备份 / 恢复全都能用，不用敲命令，也不用记端口；
  //   - token 保护没被拆掉：治理服务的页面由它自己注入 `<meta name="brain-token">`，
  //     跨站读不到那张页面就拿不到 token（它只认 Authorization 头，不认 cookie）；
  //   - 端口被占用（比如主人自己已经起着 7420）→ 当成「已有服务」，直接代理到它。
  //
  // 失败一律降级、不抛：插件加载失败会让整站 404（CONTRACTS 3.7）。
  const governancePort = Number(config && config.governancePort) > 0
    ? Number(config.governancePort)
    : 7420
  const governanceDisabled = !!(config && config.governance === false)
  /** @type {{ port: number, token: string } | null} */
  let governanceRuntime = null
  /** @type {Promise<void>} */
  let governanceStarting = Promise.resolve()

  const ensureGovernance = () => {
    governanceStarting = governanceStarting.then(async () => {
      if (governanceRuntime !== null || governanceDisabled) return
      try {
        const mod = await import('../server/src/server.mjs')
        const started = await mod.startServer({
          dbPath: storePath,
          migrationsDir,
          port: governancePort,
          // 治理面板的「备份能力 / 恢复能力」默认是关的（config.allowBackup/allowRestore 默认 false）。
          // 那是安全闸，但主人要的是「点开就能用」——所以在本进程内启动时显式打开。
          // 安全性没有实质下降：仍然只监听本机回环、仍然要 Bearer token 才写；
          // 恢复还额外要求面板上的双确认（dryRun=false + confirm=RESTORE）。
          // 想关就 config.governanceAllowBackup / governanceAllowRestore 传 false。
          allowBackup: !(config && config.governanceAllowBackup === false),
          allowRestore: !(config && config.governanceAllowRestore === false),
          logger: undefined,
        })
        governanceRuntime = { port: started.port, token: started.token, close: started.close }
        console.error(`[brain-tools] 治理服务已在本进程内启动：http://127.0.0.1:${started.port}/`)
      } catch (error) {
        const code = error && /** @type {any} */ (error).code
        if (code === 'EADDRINUSE') {
          // 已经有人（多半是主人自己起的 7420）在跑：直接用现成的，不重复启动。
          governanceRuntime = { port: governancePort, token: '', close: null }
          console.error(`[brain-tools] 端口 ${governancePort} 已被占用，治理面板直接代理到已有服务`)
        } else {
          console.error('[brain-tools] 治理服务启动失败（治理面板降级为只读页）:', error instanceof Error ? error.message : String(error))
        }
      }
    })
    // 吞掉链路里的错误：启动失败不该变成未处理的 rejection
    governanceStarting = governanceStarting.catch(() => {})
    return governanceStarting
  }
  // 启动是副作用，但**不在 apply 里 await**：插件加载不该等一个 HTTP 服务起来。
  // dispose 时把它关掉——否则进程退出会留着监听句柄（实测 node 会报 UV_HANDLE_CLOSING 断言）。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      void ensureGovernance()
      return () => {
        const runtime = governanceRuntime
        governanceRuntime = null
        if (runtime && typeof runtime.close === 'function') {
          Promise.resolve(runtime.close()).catch(() => {})
        }
      }
    })
  } else {
    void ensureGovernance()
  }

  /**
   * 把请求代理到治理服务。**只在 GET 页面上改写 HTML**（注入 API 前缀补丁），
   * 其余原样流式转发——不缓冲正文，避免大响应占内存。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {string} upstreamPath
   * @returns {Promise<void>}
   */
  const proxyGovernance = (req, res, upstreamPath) => new Promise((resolve) => {
    const target = governanceRuntime
    if (target === null) {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end('<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>治理服务未就绪</title>'
        + '<body style="font-family:system-ui;padding:2rem"><h1>治理服务未就绪</h1>'
        + '<p>进程内治理服务还没起来（或已关闭）。看日志里 <code>[brain-tools] 治理服务</code> 那行。</p></body></html>')
      resolve()
      return
    }
    /** @type {Record<string, any>} */
    const headers = { ...req.headers }
    headers.host = `127.0.0.1:${target.port}`
    // 我们不转发 Connection: keep-alive 之类的逐跳头，交给 http 模块自己管
    delete headers.connection
    delete headers['proxy-connection']

    const upstream = httpRequest(
      { host: '127.0.0.1', port: target.port, path: upstreamPath, method: req.method, headers },
      (up) => {
        const contentType = String(up.headers['content-type'] || '')
        const isHtml = contentType.includes('text/html')
        if (!isHtml) {
          res.writeHead(up.statusCode || 502, up.headers)
          up.pipe(res)
          up.on('end', () => resolve())
          up.on('error', () => resolve())
          return
        }
        // HTML：要注入一段 shim，把页面里的绝对 /api/... 改到 /dsh-brain/governance/api/...
        // 不改原 console 代码——那种「为了内嵌去改业务前端」的改动最容易埋坑。
        /** @type {Buffer[]} */
        const chunks = []
        up.on('data', (/** @type {Buffer} */ c) => chunks.push(c))
        up.on('end', () => {
          let html = Buffer.concat(chunks).toString('utf8')
          const shim = '<script>(function(){var P="/dsh-brain/governance";'
            + 'function fix(u){return (typeof u==="string"&&u.charAt(0)==="/")?P+u:u}'
            + 'var f=window.fetch;if(f){window.fetch=function(u,o){return f.call(window,fix(u),o)}}'
            + 'var op=XMLHttpRequest.prototype.open;'
            + 'XMLHttpRequest.prototype.open=function(m,u){var a=Array.prototype.slice.call(arguments);a[1]=fix(u);return op.apply(this,a)};'
            // 原面板是「另一个世界」（自己的样式、自己的导航）。挂一个固定的「回去」入口，
            // 不然点进来之后只能靠浏览器后退——那不是一套页面该有的样子。
            + 'function back(){var a=document.createElement("a");a.href="/dsh-brain";'
            + 'a.textContent="← 回记忆控制台";'
            + 'a.style.cssText="position:fixed;right:16px;bottom:16px;z-index:99999;padding:7px 12px;'
            + 'border-radius:8px;background:#20242f;color:#e8eaf0;font:13px/1.4 system-ui,sans-serif;'
            + 'text-decoration:none;border:1px solid #333a49;box-shadow:0 4px 14px rgba(0,0,0,.35)";'
            + 'a.onmouseenter=function(){a.style.background="#2a3040"};a.onmouseleave=function(){a.style.background="#20242f"};'
            + 'document.body.appendChild(a)}'
            + 'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",back)}else{back()}'
            + '})();</script>'
          html = html.includes('</head>')
            ? html.replace('</head>', shim + '</head>')
            : shim + html
          const out = Buffer.from(html, 'utf8')
          /** @type {Record<string, any>} */
          const outHeaders = { ...up.headers }
          delete outHeaders['content-length']
          delete outHeaders['content-encoding']
          outHeaders['content-length'] = String(out.length)
          outHeaders['cache-control'] = 'no-store'
          res.writeHead(up.statusCode || 200, outHeaders)
          res.end(out)
          resolve()
        })
        up.on('error', () => resolve())
      },
    )
    upstream.on('error', (error) => {
      try {
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(`治理服务转发失败：${error instanceof Error ? error.message : String(error)}`)
      } catch {
        /* 响应已经发过就只能算了 */
      }
      resolve()
    })
    req.pipe(upstream)
  })

  // ── 控制台：挂在 DSH 自己的 webServer 上 ─────────────────────────
  // 同源、同端口、零额外进程。主人要的是「在 DSH 里点一下能看见」。
  const webServer = ctx.webServer ?? (typeof ctx.get === 'function' ? ctx.get('webServer') : null)
  if (webServer && typeof webServer.register === 'function') {
    const sendJson = (res, obj, status = 200) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      })
      res.end(JSON.stringify(obj))
    }

    // ── 写操作的同源保护（2026-10-30）─────────────────────────────
    // 控制台的所有写动作（目前只有矛盾核验）都要求：
    //   1. 带自定义头 `X-Brain-Action: 1` —— 浏览器跨站请求带不上自定义头
    //      （要 CORS 预检，而本服务不答预检），这一条就挡住了典型的 CSRF；
    //   2. 若带 Origin，hostname 必须是本机回环。
    // 不引入 token：3080 本机控制台本来就是「登录了 DSH 才能开」的口子，
    // 再加一层会被绕过（token 只能放在页面里，等于没放）。真要做到更强，
    // 该走 7420 那套带鉴权的治理服务，而不是在 3080 上自己造。
    const ACTION_HEADER = 'x-brain-action'

    /**
     * 读 JSON 请求体。**永不抛**：返回结构化结果，由调用方决定状态码。
     * @param {import('node:http').IncomingMessage} req
     * @param {number} [maxBytes]
     * @returns {Promise<{ ok: true, value: any } | { ok: false, code: string }>}
     */
    const readJsonBody = (req, maxBytes = 64 * 1024) => new Promise((resolve) => {
      /** @type {Buffer[]} */
      const chunks = []
      let size = 0
      let settled = false
      const done = (/** @type {any} */ value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      req.on('data', (/** @type {Buffer} */ chunk) => {
        if (settled) return
        size += chunk.length
        if (size > maxBytes) {
          done({ ok: false, code: 'BODY_TOO_LARGE' })
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        const text = Buffer.concat(chunks).toString('utf8').trim()
        if (text.length === 0) return done({ ok: false, code: 'EMPTY_BODY' })
        try {
          const value = JSON.parse(text)
          if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return done({ ok: false, code: 'BAD_JSON' })
          }
          return done({ ok: true, value })
        } catch {
          return done({ ok: false, code: 'BAD_JSON' })
        }
      })
      req.on('error', () => done({ ok: false, code: 'READ_ERROR' }))
    })

    /**
     * 写操作的同源校验。返回错误码（null = 通过）。
     * @param {import('node:http').IncomingMessage} req
     * @returns {string|null}
     */
    const checkWriteOrigin = (req) => {
      if (req.headers[ACTION_HEADER] !== '1') return 'FORBIDDEN_NO_ACTION_HEADER'
      const origin = req.headers.origin
      if (typeof origin === 'string' && origin.length > 0) {
        let hostname = ''
        try {
          hostname = new URL(origin).hostname
        } catch {
          return 'FORBIDDEN_ORIGIN'
        }
        // 只在 IPv4/IPv6 回环与 localhost 上放行；端口不校验（真机验证会起 3081）。
        const ok = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
        if (!ok) return 'FORBIDDEN_ORIGIN'
      }
      return null
    }

    /**
     * M8 写操作的统一前置（八个写接口共用）。
     *
     * 顺序不能换：先看 method、再验同源、最后才读 body——
     * 没通过同源校验的请求连请求体都不该读（读体是开销，也是攻击面）。
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @returns {Promise<Record<string, any> | null>} null = 已经回过错误响应，调用方直接 return
     */
    const jsonAction = async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '这个接口只接受 POST' }, 405)
        return null
      }
      const originError = checkWriteOrigin(req)
      if (originError !== null) {
        sendJson(res, {
          ok: false,
          code: originError,
          message: '写操作必须来自本机控制台：需要 X-Brain-Action: 1 头，且来源必须是本机回环。',
        }, 403)
        return null
      }
      const body = await readJsonBody(req)
      if (!body.ok) {
        const message = body.code === 'BODY_TOO_LARGE'
          ? '请求体太大（上限 64 KB）'
          : body.code === 'EMPTY_BODY'
            ? '请求体为空'
            : body.code === 'BAD_JSON'
              ? '请求体不是合法的 JSON 对象'
              : '读取请求体失败'
        sendJson(res, { ok: false, code: body.code, message }, 400)
        return null
      }
      return body.value
    }

    /**
     * 写失败统一成结构化 JSON：**不许把异常抛给宿主**。
     * 状态码按错误码分：参数错 400、找不到 404、跨 scope 403、其余 503。
     * 这里刻意不用 500：500 在控制台口径里等于「未知崩溃」，而这几个接口的
     * 失败原因都是可分类的（参数 / 不存在 / 门面未接线 / 写队列不可用）。
     */
    const writeFailure = (res, label, error) => {
      const err = /** @type {any} */ (error)
      const message = error instanceof Error ? error.message : String(error)
      const code = err && typeof err.code === 'string' ? err.code : 'WRITE_FAILED'
      const status = code === 'INVALID_ARGUMENT'
        ? 400
        : code === 'NOT_FOUND'
          ? 404
          : code === 'FORBIDDEN_SCOPE'
            ? 403
            : 503
      sendJson(res, { ok: false, code, message: `${label}失败：${message}` }, status)
    }

    /**
     * 从 `social.preview()` 的结果里挑出「这次 dry-run 要解释的那条候选」。
     * 优先 candidateId（已落表的），其次正文精确匹配，再次 source(+topic)。
     * 都对不上就取第一条 wouldSend 或第一条——**但返回 null 时不编一条**。
     *
     * @param {any} preview
     * @param {Record<string, any>} body
     */
    const pickDryRunCandidate = (preview, body) => {
      const wantedId = typeof body.candidateId === 'string' ? body.candidateId.trim() : ''
      const wantedSource = typeof body.source === 'string' ? body.source.trim() : ''
      const wantedTopic = typeof body.topic === 'string' ? body.topic.trim() : ''
      const wantedText = typeof body.text === 'string' ? body.text.trim() : ''
      const all = [
        ...(Array.isArray(preview.persistedToday) ? preview.persistedToday : []),
        ...(Array.isArray(preview.fresh) ? preview.fresh : []),
        ...(Array.isArray(preview.wouldSay) ? preview.wouldSay : []),
      ]
      if (wantedId) {
        const byId = all.find((item) => item && item.id != null && String(item.id) === wantedId)
        if (byId) return byId
      }
      if (wantedText) {
        const byText = all.find((item) => item && typeof item.text === 'string' && item.text === wantedText)
        if (byText) return byText
      }
      if (wantedSource) {
        const bySource = all.find((item) => item && String(item.source) === wantedSource
          && (!wantedTopic || (item.topic != null && String(item.topic) === wantedTopic)))
        if (bySource) return bySource
      }
      return all.find((item) => item && item.wouldSend === true) || all[0] || null
    }

    /** dry-run 返回给页面的候选精简：只给展示需要的字段，不整包抛给前端。 */
    const slimSocialCandidate = (item) => (item
      ? {
        id: item.id == null ? null : String(item.id),
        source: item.source == null ? null : String(item.source),
        topic: item.topic == null ? null : String(item.topic),
        text: item.text == null ? null : String(item.text),
        score: Number(item.score) || 0,
        evidenceCount: Array.isArray(item.evidence) ? item.evidence.length : 0,
        wouldSend: item.wouldSend === true,
        blockedBy: item.blockedBy == null ? null : String(item.blockedBy),
        status: item.status == null ? null : String(item.status),
        gates: Array.isArray(item.gates) ? item.gates : [],
      }
      : null)

    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        const url = new URL(req.url || '/', 'http://localhost')
        const pathname = url.pathname.slice(ROUTE.length) || '/'
        try {
          if (pathname === '/' || pathname === '') {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'X-Frame-Options': 'SAMEORIGIN',
            })
            res.end(renderConsolePage({ dbPath: storePath }))
            return
          }

          if (pathname === '/api/stats') {
            const brain = await getBrain()
            // 口径（2026-10-30 修）：只数 status='active'。
            // ① `superseded` 是已封口的历史版本，检索永远返回不了它——
            //    算进来会让首页数字虚高，更糟的是会让覆盖率的分母偏大（见下方 catalog）。
            // ② 顺带补上 scope 过滤：原来只过滤 deleted，多 scope 时会数到别人的记忆。
            const activeRow = brain.db
              .prepare("SELECT count(*) AS c FROM memories WHERE status = 'active' AND scope_id = ?")
              .get(scopeId)
            const supersededRow = brain.db
              .prepare("SELECT count(*) AS c FROM memories WHERE status = 'superseded' AND scope_id = ?")
              .get(scopeId)
            let indexReady = true
            try {
              brain.db.prepare('SELECT count(*) FROM search_fts_char').get()
            } catch {
              indexReady = false
            }
            // 顺带带上使用情况摘要：首页一眼能看到「到底用了几次」。
            // 观察期最怕的不是数据难看，是装了没人看——数字得摆在第一屏。
            const usageRead = readUsageLog(usageLogPath, { since: Date.now() - usageWindowDays * 86400000 })
            const usageSummary = summarizeUsage(usageRead.entries, { windowDays: usageWindowDays })
            // 实体与冲突计数：首页要能一眼看到「有没有矛盾待核验」。
            // 库还没有 0006（老备份恢复出来的）时留 null，不要让首页整体 500。
            let entityStats = null
            let conflictCount = 0
            try {
              if (brain.entities && typeof brain.entities.stats === 'function') {
                entityStats = brain.entities.stats({ scopeId })
                conflictCount = brain.memoryEdges && typeof brain.memoryEdges.conflicts === 'function'
                  ? brain.memoryEdges.conflicts({ scopeId, limit: 500 }).length
                  : 0
              }
            } catch {
              entityStats = null
              conflictCount = 0
            }
            sendJson(res, {
              ok: true,
              memories: activeRow && activeRow.c != null ? Number(activeRow.c) : 0,
              // 已封口的历史版本单列一格：不混进「记忆」总数，但也不藏起来——
              // 合并做过 5 对，用户有权在首页看到「有 5 条被取代」。
              superseded: supersededRow && supersededRow.c != null ? Number(supersededRow.c) : 0,
              indexReady,
              dbPath: storePath,
              entities: entityStats,
              conflicts: conflictCount,
              usage: {
                windowDays: usageWindowDays,
                total: usageSummary.total,
                hitRate: usageSummary.hitRate,
                zeroHitCount: usageSummary.zeroHitCount,
              },
            })
            return
          }

          if (pathname === '/api/memories') {
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200)
            // 分页（2026-10-30）：控制台列表页要「第 N / M 页 · 共 X 条」，键集游标给不出页码。
            // offset 夹到非负整数；越界 offset 返回空 items 但 total 仍然真实——
            // 「越界了」和「库里没有」是两件事，页面要能分辨（前者提示回第 1 页，后者是真空）。
            const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset')) || 0))
            const brain = await getBrain()
            // status 只给 active：列表页是「现在能用的记忆」，
            // superseded 是已封口的历史版本（合并产物），混进来会让人以为它还在生效。
            const listed = brain.memories.list({ scopeId, personId, limit, offset, status: 'active' })
            const items = (listed.items || []).map((m) => ({
              memoryId: m.id,
              version: m.version,
              summary: m.summary || m.content,
              layer: m.layer,
              type: m.type,
              evidenceKind: m.sourceType,
              validFrom: m.validFrom,
              validUntil: m.validUntil,
              sourceCount: typeof m.sourceCount === 'number' ? m.sourceCount : null,
            }))
            sendJson(res, {
              ok: true,
              items,
              total: listed.total,
              limit: listed.limit,
              offset: listed.offset,
              hasMore: listed.hasMore,
              nextOffset: listed.offset + items.length,
            })
            return
          }

          if (pathname === '/api/search') {
            const q = (url.searchParams.get('q') || '').trim()
            if (!q) {
              sendJson(res, { ok: false, message: '搜索词不能为空' }, 400)
              return
            }
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 50)
            const startedAt = Date.now()
            try {
              const brain = await getBrain()
              const result = brain.memories.search({ query: q, scopeId, personId, limit })
              const diagnostics = explainDiagnostics(result.diagnostics)
              const hits = (result.hits || []).map(renderHit).map((h) => ({
                memoryId: h.memoryId,
                version: h.version,
                summary: h.summary,
                layer: h.layer,
                type: h.type,
                evidenceKind: h.evidenceKind,
                validFrom: h.validFrom,
                validUntil: h.validUntil,
                sourceCount: h.sourceCount,
                matchedBy: h.matchedBy,
              }))
              // 控制台检索单独记 channel=console：人工点搜索和模型主动检索的准度
              // 不该混在一个命中率里——混了就没法回答「模型会不会用」。
              recordUsage({
                channel: 'console',
                query: q,
                limit,
                ok: true,
                hitCount: hits.length,
                hitIds: hits.map((h) => h.memoryId),
                status: diagnostics.status,
                primaryLaneHit: diagnostics.primaryLaneHit,
                degraded: diagnostics.degraded,
                durationMs: Date.now() - startedAt,
              })
              sendJson(res, { ok: true, hits, diagnostics })
            } catch (searchError) {
              // 失败也要进统计：只记成功的那部分，命中率会虚高，比没有数据更糟
              recordUsage({
                channel: 'console',
                query: q,
                limit,
                ok: false,
                code: 'CONSOLE_SEARCH_FAILED',
                hitCount: 0,
                status: 'error',
                durationMs: Date.now() - startedAt,
              })
              throw searchError
            }
            return
          }

          // 星海视图：3D 记忆海（Canvas 2D，无 WebGL）。视觉思路来自 MIT 的 3d-memory-sea。
          if (pathname === '/sea') {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'X-Frame-Options': 'SAMEORIGIN',
            })
            res.end(renderSeaPage())
            return
          }

          // ── 使用情况：观察期的核心仪表盘（ROADMAP 第一优先） ──────
          if (pathname === '/usage') {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'X-Frame-Options': 'SAMEORIGIN',
            })
            res.end(renderUsagePage({ logPath: usageLogPath, windowDays: usageWindowDays }))
            return
          }

          // 矛盾核验页：6 条并列保留的冲突要能「并排看全文」——
          // 只给摘要判不出「详略不同」还是「真冲突」，而这是全项目唯一需要人现在处理的状态。
          if (pathname === '/conflicts') {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'X-Frame-Options': 'SAMEORIGIN',
            })
            res.end(renderConflictsPage({ scopeId }))
            return
          }

          // 实体总览：117 个实体迁进来了，但光有 JSON 和首页一个计数等于看不见。
          // 这页按 kind 分组铺开，孤儿和错标自然浮出来（数据进了库但人看不见＝没进来）。
          if (pathname === '/entities') {
            res.writeHead(200, {
              'Content-Type': 'text/html; charset=utf-8',
              'Cache-Control': 'no-store',
              'X-Content-Type-Options': 'nosniff',
              'X-Frame-Options': 'SAMEORIGIN',
            })
            res.end(renderEntitiesPage({ scopeId }))
            return
          }

          if (pathname === '/api/usage') {
            const days = Math.min(Math.max(Number(url.searchParams.get('days')) || usageWindowDays, 1), 365)
            const now = Date.now()
            const since = now - days * 24 * 60 * 60 * 1000
            const read = readUsageLog(usageLogPath, { since })
            const summary = summarizeUsage(read.entries, { now, windowDays: days })
            // 覆盖率要全库清单。分母只算 `active`：superseded 已被封口、检索注定查不到，
            // 把它算进分母会让覆盖率和「从没被查到」榜都被历史版本稀释——
            // 而这张榜正是观察期判断「语料缺口」的依据，不能掺进永远不会命中的行。
            // 只取 id/summary/type/importance 四个字段：统计页不需要正文，少读一个字段就少一分泄露面。
            const brain = await getBrain()
            const catalog = brain.db
              .prepare("SELECT id, summary, type, importance FROM memories WHERE status = 'active' AND scope_id = ?")
              .all(scopeId)
              .map((/** @type {any} */ m) => ({
                id: m.id,
                summary: m.summary,
                type: m.type,
                importance: m.importance,
              }))
            const coverage = computeCoverage({
              totalMemories: catalog.length,
              touchedIds: summary.touchedIds,
              catalog,
            })
            // usedLater 口径：sidecar 与 usage.jsonl 是两个文件、两套口径。
            // 前者「每条命中一行」，所以 hitRows 不等于 usage 的 hitCount——
            // 页面上不要拿两个数互相校验，各有各的分母（CONTRACTS 15 写清了）。
            const usedLaterRead = readUsedLaterLog(usedLaterLogPath, { since })
            const usedLater = summarizeUsedLater(usedLaterRead.entries, { now, windowDays: days })
            sendJson(res, {
              ok: true,
              logPath: usageLogPath,
              logExists: read.exists,
              skippedLines: read.skipped,
              truncated: read.truncated,
              summary,
              coverage,
              usedLater,
              usedLaterLog: {
                path: usedLaterLogPath,
                exists: usedLaterRead.exists,
                skippedLines: usedLaterRead.skipped,
                truncated: usedLaterRead.truncated,
              },
              // 最近流水：query 是主人原话，只在本机同源页面展示，不进任何外部通道。
              // 顺带只挑页面真要的字段——尤其丢掉 usedLater 这类占位，免得前端以为它有值。
              recent: read.entries.slice(-30).map((e) => ({
                at: e.at,
                ts: e.ts,
                channel: e.channel,
                query: e.query,
                hitCount: e.hitCount,
                status: e.status,
                durationMs: e.durationMs,
                ok: e.ok,
                code: e.code,
              })),
            })
            return
          }

          // ── 实体与冲突（M6）──────────────────────────────────────
          if (pathname === '/api/entities') {
            const brain = await getBrain()
            if (!brain.entities || typeof brain.entities.list !== 'function') {
              sendJson(res, { ok: false, message: '当前库还没有实体能力（缺 0006 迁移）' }, 501)
              return
            }
            const kind = (url.searchParams.get('kind') || '').trim() || undefined
            const q = (url.searchParams.get('q') || '').trim() || undefined
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500)
            const listed = brain.entities.list({ scopeId, kind, query: q, limit })
            sendJson(res, { ok: true, items: listed.items, stats: brain.entities.stats({ scopeId }) })
            return
          }

          if (pathname === '/api/entities/memories') {
            const entityId = (url.searchParams.get('id') || '').trim()
            if (!entityId) {
              sendJson(res, { ok: false, message: 'id 不能为空' }, 400)
              return
            }
            const brain = await getBrain()
            if (!brain.entities) {
              sendJson(res, { ok: false, message: '当前库还没有实体能力' }, 501)
              return
            }
            // 控制台也有 scope 纪律：跨 scope 的实体 id 必须与「不存在」同形（404），
            // 而且 `memoriesFor` 返回的是**记忆正文**，不收口就是整段正文泄露。
            const entity = brain.entities.get(entityId, { scopeId })
            if (!entity) {
              sendJson(res, { ok: false, message: '实体不存在' }, 404)
              return
            }
            sendJson(res, { ok: true, entity, items: brain.entities.memoriesFor(entityId, { limit: 200, scopeId }) })
            return
          }

          if (pathname === '/api/conflicts') {
            const brain = await getBrain()
            if (!brain.memoryEdges || typeof brain.memoryEdges.conflicts !== 'function') {
              sendJson(res, { ok: false, message: '当前库还没有关系能力（缺 0006 迁移）' }, 501)
              return
            }
            const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 100, 1), 500)
            const edges = brain.memoryEdges.conflicts({ scopeId, limit })
            // 给每条冲突补两端**全文 + 实体 + 来源**：页面上要并排读原文才判得出
            // 「详略不同」还是「真冲突」。只给摘要等于让人凭印象裁决。
            const inspect = (memoryId) => {
              const memory = brain.memories.get(memoryId, { scopeId })
              if (!memory) return { memoryId, missing: true }
              let entities = []
              try {
                entities = brain.entities ? brain.entities.forMemory(memoryId, { scopeId }).map((e) => e.name) : []
              } catch {
                entities = []
              }
              return {
                memoryId,
                version: memory.version,
                summary: memory.summary,
                // 正文给全：判断靠的是原文，截断会把关键差异切掉
                content: memory.content,
                type: memory.type,
                layer: memory.layer,
                importance: memory.importance,
                validFrom: memory.validFrom,
                validUntil: memory.validUntil,
                originSystem: memory.originSystem,
                createdAt: memory.createdAt,
                entities,
              }
            }
            sendJson(res, {
              ok: true,
              items: edges.map((edge) => ({
                ...edge,
                from: inspect(edge.fromMemoryId),
                to: inspect(edge.toMemoryId),
              })),
              stats: brain.memoryEdges.stats({ scopeId }),
            })
            return
          }

          // ── 矛盾核验动作（M7，会写库）──────────────────────────────
          // 三个动作的语义与命令行版 tools/merge-duplicates.mjs 完全一致：
          //   keep-left / keep-right：保留一侧，另一侧走 supersede 封口（正文不删、asOf 可回看），
          //                           然后删掉这条矛盾边；
          //   not-conflict：两条都不动，只把「矛盾」改成「细化/佐证」。
          // 每一步都往 data/logs/conflict-actions.jsonl 落一行，失败不影响已完成的库写入。
          if (pathname === '/api/conflicts/action') {
            if (req.method !== 'POST') {
              sendJson(res, { ok: false, code: 'METHOD_NOT_ALLOWED', message: '这个接口只接受 POST' }, 405)
              return
            }
            const originError = checkWriteOrigin(req)
            if (originError !== null) {
              sendJson(res, {
                ok: false,
                code: originError,
                message: '写操作必须来自本机控制台：需要 X-Brain-Action: 1 头，且来源必须是本机回环。',
              }, 403)
              return
            }
            const body = await readJsonBody(req)
            if (!body.ok) {
              const message = body.code === 'BODY_TOO_LARGE'
                ? '请求体太大（上限 64 KB）'
                : body.code === 'EMPTY_BODY'
                  ? '请求体为空'
                  : body.code === 'BAD_JSON'
                    ? '请求体不是合法的 JSON 对象'
                    : '读取请求体失败'
              sendJson(res, { ok: false, code: body.code, message }, 400)
              return
            }
            const edgeId = typeof body.value.edgeId === 'string' ? body.value.edgeId.trim() : ''
            const action = typeof body.value.action === 'string' ? body.value.action.trim() : ''
            const kindRaw = typeof body.value.kind === 'string' ? body.value.kind.trim() : ''
            if (!edgeId) {
              sendJson(res, { ok: false, code: 'EDGE_ID_REQUIRED', message: 'edgeId 不能为空。' }, 400)
              return
            }
            if (!CONFLICT_ACTIONS.includes(action)) {
              sendJson(res, {
                ok: false,
                code: 'INVALID_ACTION',
                message: `action 只能是 ${CONFLICT_ACTIONS.join(' / ')}。`,
              }, 400)
              return
            }
            const brain = await getBrain()
            if (!brain.memoryEdges || typeof brain.memoryEdges.list !== 'function') {
              sendJson(res, { ok: false, code: 'EDGES_UNAVAILABLE', message: '当前库还没有关系能力（缺 0006 迁移）' }, 501)
              return
            }
            try {
              // list 只返回两端都没删的边——正好是「现在还能处理」的集合。
              const edge = brain.memoryEdges.list({ scopeId, kind: 'contradicts', limit: 500 })
                .find((/** @type {any} */ e) => String(e.id) === edgeId)
              if (!edge) {
                sendJson(res, { ok: false, code: 'EDGE_NOT_FOUND', message: '这条矛盾边不存在，或已经被处理过。' }, 404)
                return
              }
              const fromId = String(edge.fromMemoryId)
              const toId = String(edge.toMemoryId)
              /** @type {Record<string, any>} */
              let outcome
              if (action === 'keep-left' || action === 'keep-right') {
                const keptId = action === 'keep-left' ? fromId : toId
                const supersededId = action === 'keep-left' ? toId : fromId
                // supersede(oldId, newId)：old 被 new 取代 —— 所以要保留的那条当 new。
                await brain.memories.supersede(supersededId, keptId, { scopeId })
                const removal = await brain.memoryEdges.remove(edgeId)
                outcome = {
                  keptId,
                  supersededId,
                  edgeRemoved: !!(removal && removal.removed),
                  newEdgeId: null,
                  kind: null,
                }
              } else {
                const kind = NOT_CONFLICT_KINDS.includes(kindRaw) ? kindRaw : 'refines'
                const removal = await brain.memoryEdges.remove(edgeId)
                const linked = await brain.memoryEdges.link({
                  scopeId,
                  fromMemoryId: fromId,
                  toMemoryId: toId,
                  kind,
                  reason: '人工核验：两条都保留，不是矛盾',
                  sourceSystem: 'console',
                })
                outcome = {
                  keptId: null,
                  supersededId: null,
                  edgeRemoved: !!(removal && removal.removed),
                  newEdgeId: linked.id,
                  kind,
                }
              }
              const logged = await appendConflictAction(conflictLogPath, {
                edgeId,
                action,
                kind: outcome.kind,
                fromId,
                toId,
                keptId: outcome.keptId,
                supersededId: outcome.supersededId,
                newEdgeId: outcome.newEdgeId,
                edgeRemoved: outcome.edgeRemoved,
                scopeId,
              })
              sendJson(res, {
                ok: true,
                action,
                edgeId,
                keptId: outcome.keptId,
                supersededId: outcome.supersededId,
                edgeRemoved: outcome.edgeRemoved,
                newEdgeId: outcome.newEdgeId,
                kind: outcome.kind,
                // 日志没写成功必须如实说：库已经改了，但这次动作没有留痕。
                logged: logged.ok,
                loggedError: logged.ok ? null : logged.error,
                rollbackHint: action === 'not-conflict'
                  ? `撤销：删掉新边 ${outcome.newEdgeId}，再重建一条 contradicts 边（两端 ${fromId} / ${toId}）。`
                  : `撤销：把 ${outcome.supersededId} 的 status 改回 active、valid_until 清空、${outcome.keptId} 的 supersedes 清空，再重建矛盾边。写法见 docs/MERGE-ROLLBACK-20261030.sql。`,
              })
              return
            } catch (error) {
              sendJson(res, {
                ok: false,
                code: error && /** @type {any} */ (error).code ? String(/** @type {any} */ (error).code) : 'ACTION_FAILED',
                message: `核验动作失败：${error instanceof Error ? error.message : String(error)}`,
              }, 500)
              return
            }
          }

          // ── 治理面板（M7，2026-10-30 晚定稿）──────────────────────
          // 主人的原话：「治理面板不要输入命令打开」「这些东西都无法使用」。
          //
          // 定稿做法：**/dsh-brain/governance 直接 302 跳到治理面板本体**。
          // 为什么不再做 HTML 代理改写：面板的 HTML 里是 `href="/assets/styles.css"`
          // 这种绝对路径 + CSP `script-src 'self'`。要在别的路径下渲染它，就得同时
          // 改写静态资源路径、注入的 shim 又被 CSP 挡掉——任何一处漏都是「能打开但
          // 一片空白」的半成品（真的交出去了，被主人当场撞上）。跳过去功能 100% 一致，
          // 而且 7420 的面板顶部已经有「记忆视图」入口条，回得来。
          //
          // 子路径（/governance/api/*）保留代理：老书签、以及任何相对请求都还能用。
          // 治理服务没起来时才降级成只读页（下面是 fallback）。
          if (pathname === '/governance' || pathname.startsWith('/governance/')) {
            await ensureGovernance()
            if (governanceRuntime !== null) {
              const sub = pathname.slice('/governance'.length)
              // 主入口（精确路径）跳转；子路径照旧代理
              if (sub === '' && (req.method === 'GET' || req.method === 'HEAD')) {
                res.writeHead(302, {
                  Location: `http://127.0.0.1:${governanceRuntime.port}/`,
                  'Cache-Control': 'no-store',
                })
                res.end()
                return
              }
              const upstreamPath = (sub === '' ? '/' : sub) + (url.search || '')
              await proxyGovernance(req, res, upstreamPath)
              return
            }
            try {
              const mod = await import('./governance-page.js')
              res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'SAMEORIGIN',
              })
              res.end(mod.renderGovernancePage({ scopeId }))
            } catch (error) {
              const detail = (error instanceof Error ? error.message : String(error))
                .replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] || c)
              res.writeHead(501, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
              res.end(`<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>治理视图未就绪</title>`
                + `<body style="font-family:system-ui;padding:2rem">`
                + `<h1>治理视图还没就绪</h1><p>governance-page.js 加载失败：${detail}</p>`
                + `<p>写操作仍可用独立治理服务：<code>node apps/server/index.mjs --port 7420</code></p></body></html>`)
            }
            return
          }

          if (pathname === '/api/governance') {
            const brain = await getBrain()
            // 7420 是否在跑：本机回环短探测。**探不到就是 false**，不猜「应该可以」。
            let consoleRunning = false
            try {
              const probe = await fetch('http://127.0.0.1:7420/', {
                method: 'HEAD',
                signal: AbortSignal.timeout(800),
              })
              consoleRunning = probe.status >= 200 && probe.status < 500
            } catch {
              consoleRunning = false
            }
            /** @type {{ total: number|null, items: any[] }} */
            let backups = { total: null, items: [] }
            try {
              const rows = brain.backup && typeof brain.backup.listSnapshots === 'function'
                ? brain.backup.listSnapshots({ limit: 10 })
                : null
              backups = rows === null
                ? { total: null, items: [] }
                : {
                    total: rows.length,
                    items: rows.map((/** @type {any} */ r) => ({
                      id: r.backup_id ?? null,
                      createdAt: r.created_at ?? null,
                      sizeBytes: r.byte_size == null ? null : Number(r.byte_size),
                      // status 是库里的真实字段；不认识的值原样给，页面按灰显示——
                      // 别把「没校验过」美化成 ok。
                      integrity: r.status == null ? 'unknown' : String(r.status),
                      path: r.path ?? null,
                      fileExists: r.file_exists === true,
                      deletionEpoch: r.deletion_epoch == null ? null : Number(r.deletion_epoch),
                    })),
                  }
            } catch {
              backups = { total: null, items: [] }
            }
            /** @type {{ total: number|null, items: any[] }} */
            let deletions = { total: null, items: [] }
            /** @type {{ entries: number|null, epoch: number|null, lastHashShort: string|null, updatedAt: string|null, healthy: boolean|null, corruptAt: string|null }} */
            let ledger = { entries: null, epoch: null, lastHashShort: null, updatedAt: null, healthy: null, corruptAt: null }
            try {
              const ledgerFacade = brain.deletionLedger
              if (ledgerFacade && typeof ledgerFacade.read === 'function') {
                const read = ledgerFacade.read()
                const entries = Array.isArray(read && read.entries) ? read.entries : []
                deletions = {
                  total: entries.length,
                  // 字段名按 deletion-ledger 的 INPUT_KEY_SET 取（tombstoneId/memoryId/targetId/actor/reason/requestedAt）
                  items: entries.slice(-10).reverse().map((/** @type {any} */ e) => ({
                    at: e.requestedAt ?? null,
                    memoryId: e.memoryId ?? e.targetId ?? null,
                    tombstoneId: e.tombstoneId ?? null,
                    actor: e.actor ?? null,
                    reason: e.reason ?? null,
                    epoch: e.epoch == null ? null : Number(e.epoch),
                  })),
                }
              }
              if (typeof ledgerFacade.verify === 'function') {
                const verdict = ledgerFacade.verify()
                const wm = typeof ledgerFacade.watermark === 'function' ? ledgerFacade.watermark() : null
                ledger = {
                  entries: verdict && verdict.entryCount != null ? Number(verdict.entryCount) : null,
                  epoch: wm && wm.epoch != null ? Number(wm.epoch) : null,
                  lastHashShort: wm && typeof wm.lastHash === 'string' ? wm.lastHash.slice(0, 8) : null,
                  updatedAt: wm && wm.updatedAt ? String(wm.updatedAt) : null,
                  healthy: verdict && verdict.ok === true,
                  corruptAt: verdict && verdict.ok === false ? String(verdict.corruptAt ?? 'unknown') : null,
                }
              }
            } catch {
              // 账本不可用：保持 null，让页面显示「–」。不编 0。
            }
            // 隔离：证据只有两条——①账本自身校验不通过；②最近备份的 epoch 落后于当前 epoch
            // （说明备份之后删过东西，拿它恢复会把删掉的复活）。判不了就 required=false + reason 说明。
            const newestEpoch = backups.items.length > 0 ? backups.items[0].deletionEpoch : null
            const currentEpoch = ledger.epoch
            let isolation = { required: false, reason: /** @type {string|null} */ (null) }
            if (ledger.healthy === false) {
              isolation = { required: true, reason: `删除账本校验失败：${ledger.corruptAt ?? 'unknown'}` }
            } else if (newestEpoch !== null && currentEpoch !== null && newestEpoch < currentEpoch) {
              isolation = {
                required: true,
                reason: `最近备份的 deletion_epoch(${newestEpoch}) 落后于当前(${currentEpoch})：备份之后删过东西，恢复必须隔离。`,
              }
            } else if (newestEpoch === null || currentEpoch === null) {
              isolation = { required: false, reason: null }
            }
            sendJson(res, {
              ok: true,
              scopeId,
              canWrite: false,
              writeHint: '写操作（删除 / 备份 / 恢复）需要独立治理服务：node apps/server/index.mjs --port 7420',
              console: { running: consoleRunning, port: 7420, checkedAt: new Date().toISOString() },
              backups,
              deletions,
              ledger,
              isolation,
            })
            return
          }

          // ── 心情页（M7.2：情感状态并进主账之后的新页面）──────────
          if (pathname === '/mood') {
            try {
              const mod = await import('./mood-page.js')
              res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'SAMEORIGIN',
              })
              res.end(mod.renderMoodPage({ scopeId }))
            } catch (error) {
              const detail = (error instanceof Error ? error.message : String(error))
                .replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] || c)
              res.writeHead(501, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
              res.end('<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>心情页未就绪</title>'
                + `<body style="font-family:system-ui;padding:2rem"><h1>心情页还没就绪</h1><p>${detail}</p>`
                + '<p><a href="/dsh-brain">回记忆控制台</a></p></body></html>')
            }
            return
          }

          if (pathname === '/api/mood') {
            const brain = await getBrain()
            /** @type {Record<string, any> | null} */
            let state = null
            /** @type {any[]} */
            let events = []
            /** @type {Record<string, any> | null} */
            let stats = null
            let source = 'brain'
            try {
              if (brain.mood && typeof brain.mood.getState === 'function') {
                state = brain.mood.getState()
                // 门面的 listEvents 返回 `{ items, limit }`，不是裸数组。
                // 直接 `events = listEvents() || []` 会让 events.map 在下面炸成 500
                // （2026-10-30 真机踩过：api/mood 500 / events.map is not a function）。
                const listed = brain.mood.listEvents({ limit: 50 })
                events = Array.isArray(listed)
                  ? listed
                  : listed && Array.isArray(listed.items)
                    ? listed.items
                    : []
                stats = brain.mood.stats()
              } else {
                source = 'unavailable'
              }
            } catch {
              source = 'unavailable'
              state = null
              events = []
            }
            // 过渡期兜底：主账里还没有情感表（0007 未应用）或门面不可用时读插件的 state.json。
            // 这不是「再加一个数据源」，而是迁移途中页面上必须看得到状态，不能空着——
            // 返回值里的 `source` 会如实说明这次数字是从哪来的。
            if (state === null) {
              try {
                const { readFile } = await import('node:fs/promises')
                const home = process.env.USERPROFILE || process.env.HOME || ''
                const raw = await readFile(home + '/.dsh/fox-mood/state.json', 'utf8')
                const parsed = JSON.parse(raw)
                state = {
                  mood: parsed.mood,
                  energy: parsed.energy,
                  bond: parsed.bond,
                  updatedAt: parsed.updatedAt ?? null,
                  lastInteractAt: parsed.lastInteractAt ?? null,
                }
                const rawEvents = Array.isArray(parsed.events) ? parsed.events : []
                events = rawEvents.slice(-50).reverse()
                stats = { events: rawEvents.length, oldestAt: null, newestAt: null }
                source = 'state.json'
              } catch {
                // 读不到就保持 null——页面显示「–」，不编 0（CONTRACTS §17.2）
              }
            }
            // 事件中文标签与 plugins/dsh-fox-mood/core.js 的 EVENT_EFFECTS 保持一致。
            // 改了那边要同步这——所以直接把映射放在响应里由后端给，页面不再自己维护一份。
            const EVENT_LABELS = {
              praise: '被夸了',
              retasked: '被返工',
              pushed: '被催了',
              interesting: '碰到有意思的东西',
              success: '事情办成了',
              failure: '办砸了',
              late_night: '深夜还陪着',
              long_absence: '好久没见了',
              chat: '聊了几句',
              rest: '歇了一会儿',
            }
            sendJson(res, {
              ok: true,
              source,
              state,
              events: events.map((/** @type {any} */ e) => {
                let delta = e && e.delta !== undefined ? e.delta : null
                if (typeof delta === 'string') {
                  try {
                    delta = JSON.parse(delta)
                  } catch {
                    delta = null
                  }
                }
                return {
                  id: e && e.id != null ? String(e.id) : null,
                  at: e && e.at != null ? Number(e.at) : null,
                  kind: e && typeof e.kind === 'string' ? e.kind : 'unknown',
                  label: e && typeof e.kind === 'string' ? EVENT_LABELS[e.kind] || e.kind : '未知',
                  note: e && typeof e.note === 'string' ? e.note : null,
                  delta: delta && typeof delta === 'object' ? delta : null,
                }
              }),
              stats,
            })
            return
          }

          // ── M8 四页：工作空间 / 类脑 / 人格与社交 / 自主指令（2026-10-30）──
          // **懒加载**：页面模块里任何错误都不许拖垮整个插件（工具也得能活）。
          // 加载失败 → 501 + 一段说人话的说明，而不是白屏或 404。
          // 数据在服务端渲染（collectXxxView + renderXxxPage），前端脚本只管交互：
          // 这样即使脚本挂了，开关与候选这些「当前状态」仍然看得见。
          if (pathname === '/workspace' || pathname === '/cognition'
            || pathname === '/persona' || pathname === '/directives') {
            try {
              const brain = await getBrain()
              /** @type {string} */
              let html = ''
              if (pathname === '/workspace') {
                const mod = await import('./workspace-page.js')
                html = mod.renderWorkspacePage({ scopeId, view: mod.collectWorkspaceView(brain, { scopeId }) })
              } else if (pathname === '/cognition') {
                const mod = await import('./cognition-page.js')
                html = mod.renderCognitionPage({ scopeId, view: mod.collectCognitionView(brain, { scopeId }) })
              } else if (pathname === '/persona') {
                const mod = await import('./persona-page.js')
                html = mod.renderPersonaPage({ scopeId, view: mod.collectPersonaView(brain, { scopeId }) })
              } else {
                const mod = await import('./directives-page.js')
                html = mod.renderDirectivesPage({ scopeId, view: mod.collectDirectivesView(brain, { scopeId }) })
              }
              res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
                'X-Frame-Options': 'SAMEORIGIN',
              })
              res.end(html)
            } catch (error) {
              const detail = (error instanceof Error ? error.message : String(error))
                .replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] || c)
              res.writeHead(501, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
              res.end('<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><title>页面未就绪</title>'
                + `<body style="font-family:system-ui;padding:2rem"><h1>这个页面还没就绪</h1>`
                + `<p>${pathname} 的页面模块加载失败：${detail}</p>`
                + '<p><a href="/dsh-brain">回记忆控制台</a></p></body></html>')
            }
            return
          }

          // ── M8 读接口：页面与 API 共用同一个 collect 函数（不维护第二套口径）──
          // 门面没接线时返回 501 + 说清是哪一块没接——不许 500，也不许假装「没有数据」。
          if (pathname === '/api/workspace' || pathname === '/api/cognition'
            || pathname === '/api/persona' || pathname === '/api/directives') {
            try {
              const brain = await getBrain()
              if (pathname === '/api/workspace') {
                const mod = await import('./workspace-page.js')
                const view = mod.collectWorkspaceView(brain, { scopeId })
                if (view.unavailable) {
                  sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: view.unavailable }, 501)
                  return
                }
                sendJson(res, { ok: true, ...view })
                return
              }
              if (pathname === '/api/cognition') {
                const mod = await import('./cognition-page.js')
                const view = mod.collectCognitionView(brain, { scopeId })
                if (view.unavailable) {
                  sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: view.unavailable }, 501)
                  return
                }
                sendJson(res, { ok: true, ...view })
                return
              }
              if (pathname === '/api/persona') {
                const mod = await import('./persona-page.js')
                const view = mod.collectPersonaView(brain, { scopeId })
                if (view.unavailable) {
                  sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: view.unavailable }, 501)
                  return
                }
                sendJson(res, { ok: true, ...view })
                return
              }
              const mod = await import('./directives-page.js')
              const view = mod.collectDirectivesView(brain, { scopeId })
              if (view.unavailable) {
                sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: view.unavailable }, 501)
                return
              }
              sendJson(res, { ok: true, ...view })
              return
            } catch (error) {
              sendJson(res, {
                ok: false,
                code: error && /** @type {any} */ (error).code ? String(/** @type {any} */ (error).code) : 'READ_FAILED',
                message: `读 ${pathname} 失败：${error instanceof Error ? error.message : String(error)}`,
              }, 503)
              return
            }
          }

          // ── M8 写接口：全部 POST + X-Brain-Action + 本机 Origin ──────
          // 页面侧还有一道「两步确认」：这两层是独立的，前端被绕过也过不了这里的同源校验。
          if (pathname === '/api/workspace/switch') {
            const body = await jsonAction(req, res)
            if (!body) return
            const name = typeof body.name === 'string' ? body.name.trim() : ''
            const value = body.value === undefined || body.value === null ? null : String(body.value)
            if (!name || value === null || value === '') {
              sendJson(res, {
                ok: false,
                code: 'INVALID_ARGUMENT',
                message: 'name 和 value 都必填（value 传字符串；布尔开关只接受 0 / 1）',
              }, 400)
              return
            }
            try {
              const brain = await getBrain()
              if (!brain.workspace || typeof brain.workspace.setSwitch !== 'function') {
                sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: '工作空间门面未接线，改不了开关' }, 501)
                return
              }
              const result = await brain.workspace.setSwitch(String(name), value, {
                by: 'console',
                reason: typeof body.reason === 'string' && body.reason.trim()
                  ? body.reason.trim().slice(0, 200)
                  : '控制台手动切换',
              })
              sendJson(res, {
                ok: true,
                name: result.name,
                value: result.value,
                previous: result.previous,
                note: '开关已改并写审计。它会立刻影响自主模块——空窗期不存在。',
              })
            } catch (error) {
              writeFailure(res, '改开关', error)
            }
            return
          }

          if (pathname === '/api/cognition/reflection/promote'
            || pathname === '/api/cognition/reflection/dismiss') {
            const body = await jsonAction(req, res)
            if (!body) return
            const id = typeof body.id === 'string' ? body.id.trim() : ''
            if (!id) {
              sendJson(res, { ok: false, code: 'INVALID_ARGUMENT', message: 'id 必填（反思 id）' }, 400)
              return
            }
            try {
              const brain = await getBrain()
              if (!brain.cognition || !brain.cognition.reflect) {
                sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: '类脑门面未接线，动不了反思' }, 501)
                return
              }
              if (pathname.endsWith('/promote')) {
                const result = await brain.cognition.reflect.promote(id, { scopeId })
                sendJson(res, { ok: true, action: 'promote', result })
              } else {
                const result = await brain.cognition.reflect.dismiss(id, { by: 'console', scopeId })
                sendJson(res, { ok: true, action: 'dismiss', result })
              }
            } catch (error) {
              writeFailure(res, pathname.endsWith('/promote') ? '晋升反思' : '丢弃反思', error)
            }
            return
          }

          if (pathname === '/api/cognition/quarantine/release'
            || pathname === '/api/cognition/quarantine/purge') {
            const body = await jsonAction(req, res)
            if (!body) return
            const id = typeof body.id === 'string' ? body.id.trim() : ''
            if (!id) {
              sendJson(res, { ok: false, code: 'INVALID_ARGUMENT', message: 'id 必填（隔离条目 id）' }, 400)
              return
            }
            try {
              const brain = await getBrain()
              if (!brain.cognition || !brain.cognition.immune) {
                sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: '类脑门面未接线，动不了隔离区' }, 501)
                return
              }
              if (pathname.endsWith('/release')) {
                const result = await brain.cognition.immune.release(id, {
                  by: 'console',
                  notes: typeof body.notes === 'string' ? body.notes.slice(0, 500) : '控制台核验放行',
                  scopeId,
                })
                sendJson(res, { ok: true, action: 'release', result })
              } else {
                const result = await brain.cognition.immune.purge(id, { by: 'console', scopeId })
                sendJson(res, { ok: true, action: 'purge', result })
              }
            } catch (error) {
              writeFailure(res, pathname.endsWith('/release') ? '释放隔离条目' : '清除隔离条目', error)
            }
            return
          }

          if (pathname === '/api/cognition/alert/ack' || pathname === '/api/cognition/alert/resolve') {
            const body = await jsonAction(req, res)
            if (!body) return
            const id = typeof body.id === 'string' ? body.id.trim() : ''
            if (!id) {
              sendJson(res, { ok: false, code: 'INVALID_ARGUMENT', message: 'id 必填（告警 id）' }, 400)
              return
            }
            try {
              const brain = await getBrain()
              if (!brain.cognition || !brain.cognition.brainstem) {
                sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: '类脑门面未接线，动不了告警' }, 501)
                return
              }
              if (pathname.endsWith('/ack')) {
                const result = await brain.cognition.brainstem.ack(id, { by: 'console', scopeId })
                sendJson(res, { ok: true, action: 'ack', result })
              } else {
                const result = await brain.cognition.brainstem.resolve(id, {
                  by: 'console',
                  resolution: typeof body.resolution === 'string' && body.resolution.trim()
                    ? body.resolution.trim().slice(0, 200)
                    : '控制台标记解决',
                  scopeId,
                })
                sendJson(res, { ok: true, action: 'resolve', result })
              }
            } catch (error) {
              writeFailure(res, pathname.endsWith('/ack') ? '确认告警' : '解决告警', error)
            }
            return
          }

          // 主动社交 dry-run：**只读**预演，不写任何业务行、不真发。
          // 页面上的「如果现在发会怎样」按钮打的就是这里。
          if (pathname === '/api/persona/social/dry-run') {
            const body = await jsonAction(req, res)
            if (!body) return
            try {
              const brain = await getBrain()
              if (!brain.persona || !brain.persona.social) {
                sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: '人格门面未接线，算不了社交候选' }, 501)
                return
              }
              const personId = typeof body.personId === 'string' && body.personId.trim()
                ? body.personId.trim()
                : brain.persona.personId
              const preview = brain.persona.social.preview({ personId, limit: 20 })
              const wanted = pickDryRunCandidate(preview, body)
              sendJson(res, {
                ok: true,
                readOnly: true,
                result: {
                  wouldSend: !!(wanted && wanted.wouldSend === true),
                  blockedBy: wanted && wanted.blockedBy != null
                    ? String(wanted.blockedBy)
                    : (wanted ? null : 'no_candidate'),
                  candidate: slimSocialCandidate(wanted),
                  switches: preview.switches ?? null,
                  counts: preview.counts ?? null,
                  note: preview.note ?? null,
                },
              })
            } catch (error) {
              writeFailure(res, '演算主动社交', error)
            }
            return
          }

          if (pathname === '/api/persona/social/cancel') {
            const body = await jsonAction(req, res)
            if (!body) return
            const id = typeof body.id === 'string' ? body.id.trim() : ''
            if (!id) {
              sendJson(res, { ok: false, code: 'INVALID_ARGUMENT', message: 'id 必填（社交候选 id）' }, 400)
              return
            }
            try {
              const brain = await getBrain()
              if (!brain.persona || !brain.persona.social) {
                sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: '人格门面未接线，取消不了候选' }, 501)
                return
              }
              const result = await brain.persona.social.cancel(id, {
                reason: typeof body.reason === 'string' && body.reason.trim()
                  ? body.reason.trim().slice(0, 200)
                  : '控制台手动取消',
              })
              sendJson(res, { ok: true, action: 'cancel', result })
            } catch (error) {
              writeFailure(res, '取消社交候选', error)
            }
            return
          }

          if (pathname === '/api/persona/conflict/resolve') {
            const body = await jsonAction(req, res)
            if (!body) return
            const id = typeof body.id === 'string' ? body.id.trim() : ''
            const resolution = typeof body.resolution === 'string' ? body.resolution.trim() : ''
            if (!id) {
              sendJson(res, { ok: false, code: 'INVALID_ARGUMENT', message: 'id 必填（冲突 id）' }, 400)
              return
            }
            if (!['keep_old', 'keep_new', 'merged', 'deferred'].includes(resolution)) {
              sendJson(res, {
                ok: false,
                code: 'INVALID_ARGUMENT',
                message: 'resolution 只能是 keep_old / keep_new / merged / deferred',
              }, 400)
              return
            }
            try {
              const brain = await getBrain()
              if (!brain.persona || !brain.persona.versions) {
                sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: '人格门面未接线，裁决不了冲突' }, 501)
                return
              }
              const result = await brain.persona.versions.resolveConflict({ conflictId: id, resolution, by: 'console' })
              sendJson(res, { ok: true, action: 'resolveConflict', result })
            } catch (error) {
              writeFailure(res, '裁决人格冲突', error)
            }
            return
          }

          // 全局暂停：最高优先级的逃生门。走 workspace 开关，不另造一套状态。
          if (pathname === '/api/directives/pause') {
            const body = await jsonAction(req, res)
            if (!body) return
            const paused = body.paused === true || body.paused === 1 || body.paused === '1'
              || body.value === '1'
            try {
              const brain = await getBrain()
              if (!brain.workspace || typeof brain.workspace.setSwitch !== 'function') {
                sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: '工作空间门面未接线，改不了全局暂停' }, 501)
                return
              }
              const result = await brain.workspace.setSwitch('paused', paused ? '1' : '0', {
                by: 'console',
                reason: paused ? '控制台：暂停一切自主执行' : '控制台：恢复自主执行',
              })
              sendJson(res, {
                ok: true,
                paused,
                value: result.value,
                previous: result.previous,
                note: paused
                  ? '已暂停：所有自主模块都必须停手。恢复需要再点一次。'
                  : '已恢复：自主模块仍需各自的开关为 1 才会动。',
              })
            } catch (error) {
              writeFailure(res, paused ? '暂停' : '恢复', error)
            }
            return
          }

          if (pathname === '/api/directives/level') {
            const body = await jsonAction(req, res)
            if (!body) return
            const level = typeof body.level === 'string' ? body.level.trim().toUpperCase() : ''
            if (!['L0', 'L1', 'L2', 'L3'].includes(level)) {
              sendJson(res, { ok: false, code: 'INVALID_ARGUMENT', message: 'level 只能是 L0 / L1 / L2 / L3' }, 400)
              return
            }
            try {
              const brain = await getBrain()
              if (!brain.workspace || typeof brain.workspace.setSwitch !== 'function') {
                sendJson(res, { ok: false, code: 'FACADE_UNAVAILABLE', message: '工作空间门面未接线，改不了权限等级' }, 501)
                return
              }
              const result = await brain.workspace.setSwitch('autonomy.max_level', level, {
                by: 'console',
                reason: `控制台：权限等级切到 ${level}`,
              })
              sendJson(res, {
                ok: true,
                level,
                value: result.value,
                previous: result.previous,
                note: level === 'L0'
                  ? 'L0 是只读：所有需要动作的指令都会被闸门拒绝。'
                  : `已切到 ${level}；高于这个等级的动作连声明都不允许。`,
              })
            } catch (error) {
              writeFailure(res, '改权限等级', error)
            }
            return
          }

          if (pathname === '/api/scene') {
            const brain = await getBrain()
            // 直接查库而不是走 memories.list：list 有分页上限（默认截到 200），
            // 星海要看全量，而且这里只需要十几个字段，一次 SQL 比走门面更快更准。
            const raw = brain.db.prepare(`
              SELECT m.id, m.version, m.type, m.origin_system, m.layer, m.source_type,
                     m.importance, m.summary, m.content, m.created_at, m.valid_from, m.valid_until,
                     (SELECT count(*) FROM source_refs r WHERE r.memory_id = m.id) AS source_count
              FROM memories m
              WHERE m.status != 'deleted' AND m.scope_id = ?
              ORDER BY m.created_at ASC
            `).all(scopeId)
            /** 时间字段可能是 ISO 字符串也可能是毫秒数，统一成数字再给前端排序用 */
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
              // 来源系统：心海的「来源模式」按它着色（手记 vs 迁入）
              origin: m.origin_system || 'other',
              layer: m.layer,
              evidenceKind: m.source_type,
              weight: typeof m.importance === 'number' ? m.importance : 0.5,
              sources: typeof m.source_count === 'number' ? m.source_count : 0,
              createdAt: ts(m.created_at),
              validFrom: m.valid_from,
              validUntil: m.valid_until,
            }))
            // ── 边：真实关系边（M6 的 memory_edges 表）────────────────
            // 以前这里是「同簇内按时间相邻连」的假边（kind='topic'），
            // 纯粹为了画面有点连接。问题不在难看，在于它会冒充关系：
            // 两条只是同类型、时间相邻，画一条线出去，看起来就是「这两条有关系」。
            // 设计文档 §11.2 要求边是有类型的关联，supersedes 与 contradicts 必须能区分，
            // 所以真边单独一个字段，假边降级成 backgroundEdges（默认不画）。
            const edges = []
            /** @type {Record<string, number>} */
            const edgesByKind = { supersedes: 0, contradicts: 0, supports: 0, refines: 0 }
            let edgesDegraded = false
            try {
              if (brain.memoryEdges && typeof brain.memoryEdges.list === 'function') {
                // list 已经只返回两端都未删的边（SQL 里 JOIN memories ... status != 'deleted'），
                // 和上面的 points 用同一个口径，不会出现「边指向屏幕外的星」。
                for (const edge of brain.memoryEdges.list({ scopeId, limit: 500 })) {
                  if (Object.prototype.hasOwnProperty.call(edgesByKind, edge.kind)) {
                    edgesByKind[edge.kind] += 1
                  }
                  edges.push({
                    edgeId: edge.id,
                    a: edge.fromMemoryId,
                    b: edge.toMemoryId,
                    kind: edge.kind,
                    reason: edge.reason,
                    sourceSystem: edge.sourceSystem,
                    createdAt: ts(edge.createdAt),
                    createdAtRaw: edge.createdAt,
                    // 两端摘要给 hover / 点边面板用：只看摘要不看正文，
                    // 心海这一屏不是读原文的地方（读原文在 /conflicts 和详情面板）。
                    fromSummary: edge.fromSummary,
                    toSummary: edge.toSummary,
                    // 线宽口径：矛盾最重 > 取代 > 佐证/细化。前端只按它调粗细，不自己猜。
                    score: edge.kind === 'contradicts' ? 1 : (edge.kind === 'supersedes' ? 0.8 : 0.55),
                  })
                }
              } else {
                edgesDegraded = true
              }
            } catch {
              // 老库缺 0006（从老备份恢复出来的）时表可能不存在，或者门面缺席。
              // 这一屏绝不能因此 500——降级成空边，页面上明说原因。
              edges.length = 0
              edgesDegraded = true
            }
            // ── 背景弱边：原来的同簇相邻连，保留但降级 ──────────────
            // 默认不画（页面上有开关）。理由：真边现在只有个位数，
            // 纯真边会显得星海没有连接；但默认必须只画真实关系。
            const backgroundEdges = []
            const byCluster = new Map()
            for (const p of points) {
              if (!byCluster.has(p.cluster)) byCluster.set(p.cluster, [])
              byCluster.get(p.cluster).push(p)
            }
            for (const list of byCluster.values()) {
              const sorted = list.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
              for (let i = 0; i < sorted.length; i += 1) {
                for (let d = 1; d <= 2 && i + d < sorted.length; d += 1) {
                  backgroundEdges.push({ a: sorted[i].id, b: sorted[i + d].id, score: 0.5 / d, kind: 'topic' })
                }
              }
            }
            sendJson(res, {
              ok: true,
              points,
              edges,
              backgroundEdges,
              edgesDegraded,
              stats: {
                total: points.length,
                // edges 只数真实关系边——页面顶部那个「关联」数字不能把背景边算进去，
                // 否则降级和正常看起来一样，等于把「没有关系」报成「有关系」。
                edges: edges.length,
                backgroundEdges: backgroundEdges.length,
                clusters: byCluster.size,
                edgesByKind,
                edgesDegraded,
              },
            })
            return
          }

          sendJson(res, { ok: false, message: '未知路径：' + pathname }, 404)
        } catch (error) {
          // 控制台出错不许把异常抛给宿主
          const message = error instanceof Error ? error.message : String(error)
          try {
            sendJson(res, { ok: false, message }, 500)
          } catch { /* 响应已发出就放弃 */ }
        }
      },
    }))
  } else {
    console.error('[brain-tools] 没有 webServer 服务，控制台路由未挂载（工具不受影响）')
  }

  console.error(`[brain-tools] 已挂载 3 个工具 + 控制台 ${ROUTE}，库：${storePath}`)
}
