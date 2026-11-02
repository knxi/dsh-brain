// @ts-check
/**
 * session-signal-index —— 从**真实会话历史**里抽「未说完的关心」与「未兑现的承诺」。
 *
 * 为什么需要这个文件（2026-10-31 凌晨）：
 * `social.js` 的 `unfinished_care` / `commitment` 两类来源只查记忆库，而记忆库是
 * 「稳定事实」的仓库——身体/情绪线索、随口答应的事，本来就不会被记成长期记忆。
 * 于是这两类来源在真实数据上永远返回 `no_care_evidence` / `no_open_commitment`：
 * 不是没发生过，是**没人把它们放进一个能查的地方**。
 *
 * 这里把会话原文扫一遍，只抽两类**可被机器识别**的信号：
 *   - care：主人提过身体/情绪/具体安排，之后没再收尾的
 *   - commitment：主人明确交代、或我明确答应、但还没看到完成迹象的
 * 每条都带真实会话坐标（`sessionId@毫秒时间戳`）当 evidence——没有坐标的一律不产出。
 *
 * 纪律：
 *   - 只读会话文件，不写库；
 *   - 排除子代理会话（那里的 `source.kind==='user'` 是派活 prompt，不是主人说话）；
 *   - 排除注入块（system-reminder / runtime-context / 团队消息 / 技能目录…）；
 *   - 已完成语义（「改好了」「搞定了」）不进候选；
 *   - 结果写进 `data/persona/session-signals.json` 当缓存，供社交门面同步读。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import zlib from 'node:zlib'
import { dirname, join } from 'node:path'

/** 会话根目录（DSH 默认布局；可用参数覆盖，测试用临时目录）。 */
export const DEFAULT_SESSIONS_ROOT = `${process.env.USERPROFILE ?? ''}/.dsh/sessions`
/** 缓存落点。 */
export const DEFAULT_CACHE_PATH = 'E:/ds-h/dsh-brain/data/persona/session-signals.json'
/** zstd 帧魔数（多帧文件必须逐帧解，`zstdDecompressSync` 只解第一帧）。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 只看最近多少天的会话。 */
export const LOOKBACK_DAYS = 21

/** 身体/情绪/具体安排的强信号。 */
const CARE_STRONG = [
  '疼', '痛', '发烧', '感冒', '头疼', '头晕', '胃疼', '胃不舒服', '失眠', '没睡', '熬夜',
  '累死', '太累', '好累', '崩溃', '焦虑', '烦死', '难受', '不舒服',
  '体检', '医院', '吃药', '手术',
  // 情绪词必须带修饰，不能留裸词：'emo' 会命中 'demo'，'心情' 会命中「心情页/心情功能」——
  // 实测第一条 care 就是「心情 亲密度 精力能不能跟外置大脑合并」，那是任务说明，不是关心。
  '心情不好', '心情很差', '心情差', '心情糟', 'emo了', '有点emo',
]
/** 弱信号：只用来提升排序，不单独成候选（避免「加班」这种词天天命中）。 */
const CARE_WEAK = ['加班', '开会', '赶工', '截止', '出差', '值班']

/**
 * 具体安排：时间词 + 动作词同时出现才算。
 *
 * 为什么单独补这一类：实测主人 291 条真实消息里，身体/情绪词一条都没命中——
 * 不是没关心可问，是这类话本来就不会以「头疼」的形式出现。真正高频的是
 * 「明天要去交图」「周五下午开会」这种**有时间的安排**，隔天问一句「那事办了吗」
 * 既有依据也有用。判据必须窄：时间词 + 动作词同时命中，且消息要短（≤120 字），
 * 否则会把任务说明当成安排。
 */
const SCHEDULE_TIME_RE = /(明天|后天|今晚|周[一二三四五六日天]|周末|上午|下午|晚上)/
const SCHEDULE_ACTION = ['去', '要', '得', '准备', '安排', '开会', '交', '见面', '出发', '送', '接']

/** 已收尾语义：出现就说明这事已经过去了，不该再问。 */
const DONE_MARKERS = ['好了', '搞定', '修好', '解决', '完成', '已改', '已修', '弄完', '结束了', '没事了', '恢复了']

/**
 * 派活 prompt 特征。
 *
 * 为什么必须排除：子代理会话里 `source.kind` **同样**是 `'user'`——因为派活 prompt 就是
 * 以用户身份注入的。实测不加这道闸，care 来源抽出来的第一条是
 * 「你是 DSH「外置大脑」项目的实现者，代号 gov2…」，拿它去嘘寒问暖是灾难。
 * 判据用「长度 + 至少两个任务说明书特征」双重命中，避免误伤真正的长消息。
 */
const DELEGATION_MARKERS = [
  '共享任务板', 'team_task', '项目根：', '工作目录', '你的任务', '第一步：', '代号',
  '先 `team_task_get`', '插件根目录', '需要输出', '请优先用', '请用 read 工具', '输出（中文',
]

/**
 * @param {string} text
 * @returns {boolean}
 */
export function looksLikeDelegationPrompt(text) {
  const raw = typeof text === 'string' ? text : ''
  if (raw.length < 200) return false
  const trimmed = raw.trim()
  // 「任务：…」这类开头的超长消息也是派活（实测主会话里同样存在）
  if (/^(任务|背景|要求)[:：]/.test(trimmed)) return true
  if (/^你是\s*(DSH|dsh|「?外置大脑|dsh-brain)/.test(trimmed)) return true
  return DELEGATION_MARKERS.filter((marker) => raw.includes(marker)).length >= 2
}

/**
 * 承诺句式：主人交代 or 我答应。
 * 每条都要能对上「谁承诺了什么」，不匹配就不产出。
 */
const COMMITMENT_PATTERNS = [
  /(?:我|这边)(?:会|来|去)?(?:帮你|给你|替你|马上|回头|明天|今晚|等下|稍后)(?:看|改|做|弄|查|写|修|处理|安排)/,
  /(?:等下|稍后|回头|明天|今晚)(?:我)?(?:再|就|来)?(?:改|做|弄|查|看|写|修)/,
  /(?:记得|别忘了|别忘|一定要)(?:帮我|给我|把)/,
  /(?:你)?(?:先)?(?:改|修|做|写|弄)(?:一下|下|一遍|个)[^。！？\n]{2,40}/,
]

/**
 * 注入块特征：这些不是主人打的字，扫到直接丢。
 * 会话里 `source.kind` 已经能挡掉大部分，这里是第二道——因为历史数据里
 * 早期版本可能没写 source。
 */
const INJECTION_MARKERS = [
  '[外置大脑 · 运行时提示]',
  'Current runtime context',
  'system-reminder',
  '<engram_profile>',
  '<engram_recall>',
  'Background subagent',
  'Team message from',
  'Agent ',
  'Evidence gate',
  '以下由 untrusted-memory 标签包裹',
]

/**
 * 逐帧解压多帧 zstd。
 * @param {Buffer} raw
 * @returns {string}
 */
export function decodeSessionFrames(raw) {
  const offsets = []
  let at = 0
  while (true) {
    const i = raw.indexOf(ZSTD_MAGIC, at)
    if (i < 0) break
    offsets.push(i)
    at = i + 4
  }
  const out = []
  for (let k = 0; k < offsets.length; k += 1) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : raw.length
    try {
      out.push(zlib.zstdDecompressSync(raw.subarray(offsets[k], end)).toString('utf8'))
    } catch {
      /* 坏帧跳过：一行坏掉不该让整份索引失效 */
    }
  }
  return out.join('')
}

/**
 * 从一条消息文本里判断 care / commitment 信号。纯函数，测试直接调。
 * @param {string} text
 * @param {{ at?: number }} [meta]
 * @returns {{ kind: 'care'|'commitment'|null, quality?: 'strong'|'weak', excerpt?: string }}
 */
export function classifySignal(text, meta = {}) {
  const raw = typeof text === 'string' ? text.trim() : ''
  if (raw.length === 0 || raw.length > 2000) return { kind: null }
  if (INJECTION_MARKERS.some((marker) => raw.includes(marker))) return { kind: null }
  // 派活 prompt 以用户身份进来，必须单独挡一道（见 looksLikeDelegationPrompt 的注释）
  if (looksLikeDelegationPrompt(raw)) return { kind: null }
  // 真正会被当成「关心」或「承诺」的话都是口语短句；超过 300 字的是任务说明/文档粘贴，
  // 拿它们抽信号只会抽到文档里的关键词。
  if (raw.length > 300) return { kind: null }

  const excerpt = raw.replace(/\s+/g, ' ').slice(0, 140)

  // 承诺优先：它比 care 更明确（「我明天帮你改」不该被当成「关心」）
  if (COMMITMENT_PATTERNS.some((re) => re.test(raw))) {
    if (DONE_MARKERS.some((marker) => raw.includes(marker))) return { kind: null }
    return { kind: 'commitment', quality: 'strong', excerpt }
  }

  const strongHits = CARE_STRONG.filter((word) => raw.includes(word))
  const weakHits = CARE_WEAK.filter((word) => raw.includes(word))
  if (strongHits.length > 0) {
    if (DONE_MARKERS.some((marker) => raw.includes(marker))) return { kind: null }
    return { kind: 'care', quality: 'strong', excerpt: `${excerpt}（线索：${strongHits.slice(0, 3).join('/')}）` }
  }
  if (weakHits.length >= 2) {
    // 弱信号要两个以上同时出现才算数：单个「开会」是日常，不是关心线索
    if (DONE_MARKERS.some((marker) => raw.includes(marker))) return { kind: null }
    return { kind: 'care', quality: 'weak', excerpt: `${excerpt}（线索：${weakHits.slice(0, 3).join('/')}）` }
  }

  // 具体安排：时间词 + 动作词同时命中、消息够短、且不是「计划/待定」这类未决事
  if (raw.length <= 120 && SCHEDULE_TIME_RE.test(raw) && SCHEDULE_ACTION.some((word) => raw.includes(word))) {
    if (DONE_MARKERS.some((marker) => raw.includes(marker))) return { kind: null }
    return { kind: 'care', quality: 'weak', excerpt: `${excerpt}（具体安排）` }
  }
  return { kind: null }
}

/**
 * 判断一个会话目录是不是子代理会话。
 * 子代理会话里 `source.kind==='user'` 是**派活 prompt**，不是主人说话，
 * 混进来会让候选人对着任务说明嘘寒问暖（实测过）。
 * @param {string} dir
 * @returns {boolean}
 */
function looksLikeSubagentSession(dir) {
  try {
    const files = readdirSync(dir)
    // 子代理会话目录里通常同时有 parent 标记或独立 meta
    const marker = join(dir, 'session.meta.json')
    if (files.includes('session.meta.json')) {
      const meta = JSON.parse(readFileSync(marker, 'utf8'))
      if (meta && (meta.origin === 'subagent' || Number(meta.delegationDepth) > 0 || meta.parentSessionId)) {
        return true
      }
    }
  } catch {
    /* 读不到就当不是 */
  }
  return false
}

/**
 * 扫全部会话，产出 care / commitment 信号。**只读**。
 * @param {{ sessionsRoot?: string, now?: number, lookbackDays?: number }} [options]
 * @returns {{ generatedAt: string, sessionsRoot: string, coverage: { sessions: number, userMessages: number, skippedSubagent: number }, signals: { care: any[], commitment: any[] } }}
 */
export function buildSignalIndex(options = {}) {
  const sessionsRoot = options.sessionsRoot ?? DEFAULT_SESSIONS_ROOT
  const now = Number.isFinite(options.now) ? Number(options.now) : Date.now()
  const lookbackDays = Number.isFinite(options.lookbackDays) ? Number(options.lookbackDays) : LOOKBACK_DAYS
  const since = now - lookbackDays * 24 * 3600 * 1000

  /** @type {any[]} */
  const care = []
  /** @type {any[]} */
  const commitment = []
  let sessions = 0
  let userMessages = 0
  let skippedSubagent = 0

  let projectDirs = []
  try {
    projectDirs = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionsRoot, entry.name))
  } catch {
    return {
      generatedAt: new Date(now).toISOString(),
      sessionsRoot,
      coverage: { sessions: 0, userMessages: 0, skippedSubagent: 0 },
      signals: { care: [], commitment: [] },
    }
  }

  for (const projectDir of projectDirs) {
    let sessionDirs = []
    try {
      sessionDirs = readdirSync(projectDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(projectDir, entry.name))
    } catch {
      continue
    }
    for (const sessionDir of sessionDirs) {
      const file = join(sessionDir, 'session.v4.jsonl.zstd')
      try {
        if (!statSync(file).isFile()) continue
      } catch {
        continue
      }
      if (looksLikeSubagentSession(sessionDir)) {
        skippedSubagent += 1
        continue
      }
      let text = ''
      try {
        text = decodeSessionFrames(readFileSync(file))
      } catch {
        continue
      }
      if (!text) continue
      sessions += 1
      const sessionId = sessionDir.split(/[\\/]/).pop() ?? 'unknown'

      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        const event = record.event ?? record
        if (!event || event.type !== 'user/message') continue
        const data = event.data ?? {}
        const sourceKind = data.source && typeof data.source === 'object' ? data.source.kind : undefined
        // 白名单：只有 source.kind === 'user' 才是主人手打的字（实测 74 条里只有 36 条）
        if (sourceKind !== 'user') continue
        // 会话事件的时间字段是 `time`（毫秒），不是 `at`——用错就等于「所有信号都是刚才发生的」
        const at = Number(event.time ?? record.time ?? 0)
        if (Number.isFinite(at) && at > 0 && at < since) continue
        const content = data.content ?? data.message?.content
        let messageText = ''
        if (typeof content === 'string') messageText = content
        else if (Array.isArray(content)) {
          messageText = content
            .filter((part) => part && typeof part.text === 'string')
            .map((part) => part.text)
            .join('\n')
        }
        if (!messageText.trim()) continue
        userMessages += 1
        const classified = classifySignal(messageText, { at })
        if (classified.kind === null) continue
        const evidence = `session:${sessionId}@${Number.isFinite(at) ? at : 0}`
        const ageHours = Number.isFinite(at) && at > 0 ? Math.max(0, (now - at) / 3600000) : 0
        const item = {
          text: classified.excerpt,
          evidence: [evidence],
          at: Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : null,
          ageHours: Math.round(ageHours * 10) / 10,
          quality: classified.quality ?? 'strong',
          sessionId,
        }
        if (classified.kind === 'care') care.push(item)
        else commitment.push(item)
      }
    }
  }

  // 同一句重复出现只留最近一次（主话题冷却靠门面那边的 topic 去重，这里先降噪）
  const dedupe = (/** @type {any[]} */ list) => {
    const seen = new Map()
    for (const item of list) {
      const key = String(item.text).slice(0, 60)
      const prev = seen.get(key)
      if (!prev || String(item.at) > String(prev.at)) seen.set(key, item)
    }
    return [...seen.values()].sort((a, b) => a.ageHours - b.ageHours)
  }

  return {
    generatedAt: new Date(now).toISOString(),
    sessionsRoot,
    coverage: { sessions, userMessages, skippedSubagent },
    signals: {
      // 每类最多留 20 条：门面只取 1 条/天，留多了是噪音
      care: dedupe(care).slice(0, 20),
      commitment: dedupe(commitment).slice(0, 20),
    },
  }
}

/**
 * 重建索引并写缓存。**失败不抛**（索引是旁路，不能拖垮驱动器）。
 * @param {{ sessionsRoot?: string, cachePath?: string, now?: number, lookbackDays?: number }} [options]
 * @returns {Promise<{ ok: boolean, index?: any, error?: string }>}
 */
export async function refreshSignalIndex(options = {}) {
  try {
    const index = buildSignalIndex(options)
    const cachePath = options.cachePath ?? DEFAULT_CACHE_PATH
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(cachePath, JSON.stringify(index, null, 2), 'utf8')
    return { ok: true, index }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 读缓存；不存在返回 null（社交门面据此如实说「没有依据」，不编）。
 * @param {string} [cachePath]
 * @returns {any|null}
 */
export function loadSignalIndex(cachePath = DEFAULT_CACHE_PATH) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !parsed.signals) return null
    return parsed
  } catch {
    return null
  }
}
