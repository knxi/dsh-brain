// @ts-check
/**
 * `reflect` —— 空闲反思（默认模式网络）。
 *
 * ── 它做什么 ──
 *
 * 在一段历史窗口里找四类「值得想一下」的东西，产出**候选洞察**（reflections.status='candidate'）：
 * 未完成的承诺、知识缺口、重复出现的模式、互相矛盾的记忆。
 *
 * ── 三条硬纪律 ──
 *
 * 1. **纯本地规则，禁止联网、禁止调 LLM**。理由不是「省 token」，而是可解释性：
 *    反思会进入长期记忆。如果它的来源是一个黑盒模型，「这条结论怎么来的」就永远查不清；
 *    而规则反思的每一条都能指回具体的 memory/event id，错了能改规则重跑。
 *    （接 LLM 是以后的事，届时应作为独立产线，而不是偷偷塞进这里。）
 * 2. **空证据不落库**。一条没有来源的反思等于一条凭空的记忆：既不能核对也不能撤回。
 *    在 `runOnce` 里空证据候选直接丢弃，一条 `reflections` 行都不写。
 * 3. **默认关闭**。`reflection.enabled` 不为真时 `runOnce` 立刻返回
 *    `{ skipped: true }`，**零副作用**：不写 reflection_runs、不写 reflections、不发事件。
 *    这条有测试钉住——「关掉后一张业务表都不写」是开关可信的前提。
 *
 * ── 反思与记忆的关系 ──
 *
 * 反思默认只是候选（candidate）。只有 `promote()` 才写进 memories，
 * 且写进去时 `source_type='inference'`、`confidence <= 0.6`、`layer='fragment'`：
 * 「我猜的」永远不能长得像「主人说的」。
 * 晋升是显式动作（人/控制台触发），不受 `reflection.enabled` 限制——
 * 否则关掉自动反思之后，已经产出的候选就再也处理不了了。
 */

import { BrainError, contentHash } from '@dsh-brain/core';
import {
  clamp01,
  clampInt,
  createReader,
  isPausedSwitch,
  isSwitchEnabled,
  newId,
  normalizeInstant,
  notify,
  parseObjectJson,
  parseStringArray,
  requireRow,
  requireText,
  resolveScopeId,
  stringifyJson,
} from './internal.js';

/** `reflection_runs.trigger` 的枚举（与 0008 的 CHECK 一致）。 */
export const REFLECTION_TRIGGERS = Object.freeze(['manual', 'idle', 'scheduled', 'after_turn']);

/** `reflections.kind` 的枚举（与 0008 的 CHECK 一致）。 */
export const REFLECTION_KINDS = Object.freeze([
  'commitment',
  'knowledge_gap',
  'pattern',
  'diary',
  'dream',
  'premonition',
  'contradiction',
]);

/**
 * 反思类型 → 晋升后记忆的 type。
 *
 * 为什么这么映射（不只是「看着像」）：
 * - commitment → commitment：承诺就是承诺，它该和主人亲口说的承诺排在同一个篮子里。
 * - knowledge_gap / pattern / contradiction → semantic：这三类都是「归纳出来的认识」，
 *   不是发生过的事（episode），也不是关于「我是谁」（self）。
 * - diary / dream → self：「我」的内部状态；它们明确不是对外部世界的事实。
 * - premonition → episode：行动预演留下的是一条「设想过的场景」，按事件形态存。
 */
export const KIND_TO_MEMORY_TYPE = Object.freeze({
  commitment: 'commitment',
  knowledge_gap: 'semantic',
  pattern: 'semantic',
  contradiction: 'semantic',
  diary: 'self',
  dream: 'self',
  premonition: 'episode',
});

/**
 * 每类反思的初始置信度。
 *
 * 依据是「这条规则的误报率」：
 * - commitment 0.50：关键词规则（待/以后/下次）会把「下次再说」这种废话也抓进来。
 * - knowledge_gap 0.45：同上，而且「不知道」常常是修辞（「这我哪知道」）。
 * - pattern 0.60：有计数与时间跨度撑着，比单句关键词可靠。
 * - contradiction 0.85：来自显式 memory_edges(kind='contradicts')，是别人建好的边；
 *   但它仍只代表「需要人工核验」，不代表「其中一条是错的」，所以不给到 0.9 以上。
 */
export const KIND_CONFIDENCE = Object.freeze({
  commitment: 0.5,
  knowledge_gap: 0.45,
  pattern: 0.6,
  contradiction: 0.85,
});

/**
 * 晋升写入 memories 时的置信度上限。
 *
 * 为什么硬编码 0.6：反思是推断，推断不得伪装成事实。0.6 是全库里
 * 「inference 类记忆」的默认上限，超过它就会在检索排序里和主人口述的记忆平起平坐。
 */
export const PROMOTED_CONFIDENCE_CAP = 0.6;

/** 默认反思窗口：看最近 24 小时。一天一次的空闲反思够覆盖「今天发生了什么」。 */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** 窗口上限 30 天：再长的窗口一次读不完全库，也不该由一次反思承担。 */
export const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** 每条规则最多读的行数（防止一次反思扫全库）。 */
export const DEFAULT_INPUT_LIMIT = 200;
export const MAX_INPUT_LIMIT = 1000;
/** 同类记忆 ≥3 条、跨度 >3 天才算「模式」（一次两次是偶然，三天内是同一件事）。 */
export const PATTERN_MIN_COUNT = 3;
export const PATTERN_MIN_SPAN_MS = 3 * 24 * 60 * 60 * 1000;
/** 反思正文上限：反思是摘要，不是原文存档。 */
export const MAX_REFLECTION_TEXT = 300;
export const DEFAULT_REFLECTION_LIMIT = 50;
export const MAX_REFLECTION_LIMIT = 200;

/**
 * 承诺的触发词。**只做线索，不做判定**：真正决定它是承诺的是 memories.type。
 * 包含「待」「以后」「下次」「还没」等，题面要求的四个都在。
 */
const COMMITMENT_HINTS = /(待|以后|下次|还没|回头|记得|抽空|改天|之后要|过两天|晚点)/;
/** 完成/取消的标记：命中就当这件事已经了了，不再产出反思。 */
const DONE_HINTS = /(已完成|做完了|搞定了|办好了|不用了|取消了|已经完成|已处理|已解决)/;
/** 知识缺口的触发词。 */
const GAP_HINTS = /(不知道|待查|没确认|未确认|不确定|查一下|没查过|待核实|待确认|还没搞清)/;
/** 「之后补上了」的标记。 */
const GAP_FILLED_HINTS = /(确认了|查到了|已确认|核实了|补上了|搞清楚了|已更新|已查|问过了)/;
/** 事件完成类 event_type（用于判断承诺是否已了结）。 */
const DONE_EVENT_TYPE = /(done|complete|finish|sent|closed|resolved|cancel|commit)/i;

/** 中文二元组停用词：这些组合在任何句子里都出现，拿去求交集等于没有交集。 */
const STOP_BIGRAMS = new Set([
  '我们', '你们', '他们', '这个', '那个', '这样', '那样', '一个', '一种', '没有', '还是',
  '就是', '可以', '应该', '现在', '今天', '明天', '昨天', '然后', '因为', '所以', '但是',
  '如果', '还有', '什么', '怎么', '为什么', '时候', '东西', '事情', '这种', '那些', '这些',
  '的话', '一下', '已经', '不是', '这个', '知道', '觉得', '可能', '需要', '自己', '不要',
]);

/**
 * 提取主题词（拉丁词 + 中文二元组），用于判断「两段文字是不是在说同一件事」。
 *
 * 为什么不用分词库：这是纯本地规则模块，多一个依赖就多一个「版本升级后反思结果变了」
 * 的变量。二元组交集在「同一件事换种说法」上够用，且不需要词典。
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function topicTokens(text) {
  const source = String(text ?? '').toLowerCase();
  /** @type {Set<string>} */
  const tokens = new Set();
  for (const match of source.matchAll(/[a-z][a-z0-9_.-]{2,}/g)) tokens.add(match[0]);
  const cjk = source.replace(/[^\u4e00-\u9fff]+/g, ' ').trim();
  if (cjk.length === 0) return tokens;
  for (const run of cjk.split(/\s+/)) {
    if (run.length < 2) continue;
    for (let index = 0; index + 2 <= run.length; index += 1) {
      const bigram = run.slice(index, index + 2);
      if (STOP_BIGRAMS.has(bigram)) continue;
      tokens.add(bigram);
    }
  }
  return tokens;
}

/**
 * 两组主题词是否有交集。
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {boolean}
 */
function sharesTopic(a, b) {
  if (a.size === 0 || b.size === 0) return false;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) if (large.has(token)) return true;
  return false;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function textOf(value) {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * 读 join 起来的记忆正文/摘要（只用于模式匹配，**不回显**）。
 * @param {Record<string, any>} row
 * @returns {string}
 */
function memoryHaystack(row) {
  return `${textOf(row.content)}\n${textOf(row.summary)}`;
}

/**
 * 事务内查重签名：同 kind + 同证据集合视为同一条反思。
 * @param {string} kind
 * @param {string[]} evidence
 * @returns {string}
 */
function evidenceSignature(kind, evidence) {
  return `${kind}|${[...evidence].sort().join(',')}`;
}

/**
 * 事务内查重。
 *
 * 为什么这里可以「先查后写」而没违反 UNIQUE 铁律：`reflections` 表（0008）**没有**
 * 可用于幂等的 UNIQUE 约束，而迁移只有 lead 能改。本模块的写入全部经由单写队列
 * 串行执行，同进程内不存在并发漏写；跨进程并发由「同一时间只有一个反思调度者」
 * 的使用约定兜底（见 docs/SYSTEM3-COGNITION.md「已知缺口」）。
 * @param {any} tx
 * @param {string} scopeId
 * @param {string} signature
 * @returns {string | null} 已存在的反思 id
 */
function findDuplicateReflection(tx, scopeId, signature) {
  const rows = tx.all(
    `SELECT id, kind, evidence_json FROM reflections
      WHERE scope_id = ? AND status IN ('candidate', 'promoted')
      ORDER BY created_at DESC LIMIT 500`,
    [scopeId],
  );
  for (const row of rows) {
    const evidence = parseStringArray(row.evidence_json);
    if (evidenceSignature(String(row.kind), evidence) === signature) return String(row.id);
  }
  return null;
}

/**
 * 规则 1：未完成的承诺。
 *
 * 两个来源：
 * - `memories(type='commitment', status='active')`：**本身就是承诺**，含完成标记才排除。
 * - `events`：正文含承诺触发词；再看它之后的事件里有没有「完成信号」且说的是同一件事
 *   （主题词有交集）。没有交集就不算完成——「今天做完了设计稿」不该了结「下周发工资」。
 * @param {any} tx
 * @param {{ scopeId: string, fromIso: string, toIso: string, limit: number }} ctx
 * @returns {{ candidates: any[], memories: number, events: number }}
 */
function collectCommitments(tx, ctx) {
  /** @type {any[]} */
  const candidates = [];
  let scannedMemories = 0;
  let scannedEvents = 0;

  const memories = tx.all(
    `SELECT id, content, summary, created_at FROM memories
      WHERE scope_id = ? AND type = 'commitment' AND status IN ('active', 'candidate')
        AND deletion_epoch = 0 AND created_at >= ? AND created_at < ?
      ORDER BY created_at DESC LIMIT ?`,
    [ctx.scopeId, ctx.fromIso, ctx.toIso, ctx.limit],
  );
  scannedMemories += memories.length;
  for (const row of memories) {
    const haystack = memoryHaystack(row);
    if (DONE_HINTS.test(haystack)) continue;
    // 「还没确认/不知道」更像知识缺口：交给 knowledge_gap 规则，避免同一段文字被两条规则重复报。
    if (GAP_HINTS.test(haystack)) continue;
    candidates.push({
      kind: 'commitment',
      text: `还有一件未完成的承诺（memory:${String(row.id)}，记录于 ${String(row.created_at).slice(0, 10)}）。建议确认它是否还需要做。`,
      evidence: [`memory:${String(row.id)}`],
      confidence: KIND_CONFIDENCE.commitment,
    });
  }

  const events = tx.all(
    `SELECT event_id, event_type, payload_text, occurred_at FROM events
      WHERE scope_id = ? AND deletion_epoch = 0
        AND occurred_at >= ? AND occurred_at < ? AND payload_text IS NOT NULL
      ORDER BY occurred_at ASC LIMIT ?`,
    [ctx.scopeId, ctx.fromIso, ctx.toIso, ctx.limit],
  );
  scannedEvents += events.length;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const haystack = textOf(event.payload_text);
    if (!COMMITMENT_HINTS.test(haystack) || DONE_HINTS.test(haystack)) continue;
    if (GAP_HINTS.test(haystack)) continue;
    const topics = topicTokens(haystack);
    // 主题词为空：证据不足，宁可不产出。空主题会让「任何完成事件」都被当成同一件事。
    if (topics.size === 0) continue;
    let resolved = false;
    for (let later = index + 1; later < events.length; later += 1) {
      const next = events[later];
      if (!DONE_EVENT_TYPE.test(String(next.event_type)) && !DONE_HINTS.test(textOf(next.payload_text))) continue;
      if (sharesTopic(topics, topicTokens(next.payload_text))) {
        resolved = true;
        break;
      }
    }
    if (resolved) continue;
    candidates.push({
      kind: 'commitment',
      text: `事件里出现未完成的约定表述（event:${String(event.event_id)}，${String(event.occurred_at).slice(0, 10)}），之后没有找到完成记录。`,
      evidence: [`event:${String(event.event_id)}`],
      confidence: KIND_CONFIDENCE.commitment,
    });
  }

  return { candidates, memories: scannedMemories, events: scannedEvents };
}

/**
 * 规则 2：知识缺口。
 *
 * 判据与承诺对称：出现「不知道/待查/没确认」，且**之后**没有同一主题的补充记录
 * （「确认了/查到了/补上了」+ 主题词交集）。
 * @param {any} tx
 * @param {{ scopeId: string, fromIso: string, toIso: string, limit: number }} ctx
 * @returns {{ candidates: any[], memories: number, events: number }}
 */
function collectKnowledgeGaps(tx, ctx) {
  /** @type {any[]} */
  const candidates = [];
  let scannedMemories = 0;
  let scannedEvents = 0;

  const memories = tx.all(
    `SELECT id, content, summary, created_at FROM memories
      WHERE scope_id = ? AND status IN ('active', 'candidate') AND deletion_epoch = 0
        AND created_at >= ? AND created_at < ?
      ORDER BY created_at ASC LIMIT ?`,
    [ctx.scopeId, ctx.fromIso, ctx.toIso, ctx.limit],
  );
  scannedMemories += memories.length;
  for (const row of memories) {
    const haystack = memoryHaystack(row);
    if (!GAP_HINTS.test(haystack)) continue;
    const topics = topicTokens(haystack);
    if (topics.size === 0) continue;
    let filled = false;
    for (const later of memories) {
      if (String(later.created_at) <= String(row.created_at)) continue;
      const laterHaystack = memoryHaystack(later);
      if (!GAP_FILLED_HINTS.test(laterHaystack)) continue;
      if (sharesTopic(topics, topicTokens(laterHaystack))) {
        filled = true;
        break;
      }
    }
    if (filled) continue;
    candidates.push({
      kind: 'knowledge_gap',
      text: `有一条知识缺口没补上（memory:${String(row.id)}，${String(row.created_at).slice(0, 10)}）：出现过「待查/没确认」之类的表述，之后没有对应的补充记录。`,
      evidence: [`memory:${String(row.id)}`],
      confidence: KIND_CONFIDENCE.knowledge_gap,
    });
  }

  const events = tx.all(
    `SELECT event_id, event_type, payload_text, occurred_at FROM events
      WHERE scope_id = ? AND deletion_epoch = 0
        AND occurred_at >= ? AND occurred_at < ? AND payload_text IS NOT NULL
      ORDER BY occurred_at ASC LIMIT ?`,
    [ctx.scopeId, ctx.fromIso, ctx.toIso, ctx.limit],
  );
  scannedEvents += events.length;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const haystack = textOf(event.payload_text);
    if (!GAP_HINTS.test(haystack)) continue;
    const topics = topicTokens(haystack);
    if (topics.size === 0) continue;
    let filled = false;
    for (let later = index + 1; later < events.length; later += 1) {
      const next = events[later];
      if (!GAP_FILLED_HINTS.test(textOf(next.payload_text))) continue;
      if (sharesTopic(topics, topicTokens(next.payload_text))) {
        filled = true;
        break;
      }
    }
    if (filled) continue;
    candidates.push({
      kind: 'knowledge_gap',
      text: `会话里留下一个没补的缺口（event:${String(event.event_id)}，${String(event.occurred_at).slice(0, 10)}）：说了不确定，之后没有查到结果。`,
      evidence: [`event:${String(event.event_id)}`],
      confidence: KIND_CONFIDENCE.knowledge_gap,
    });
  }

  return { candidates, memories: scannedMemories, events: scannedEvents };
}

/**
 * 规则 3：重复出现的模式。
 *
 * 判据：同一 `memories.type` 在窗口内 ≥3 条，且最早与最晚的创建时间跨度 >3 天。
 * 为什么按 type 聚合而不是按关键词聚类：type 是主账已有的语义分类（profile/episode/
 * semantic/commitment/skill/self/relationship/boundary），比关键词稳定；
 * 关键词聚类在中文短文本上误聚率很高（「改天」和「改成」只差一个字）。
 * @param {any} tx
 * @param {{ scopeId: string, fromIso: string, toIso: string, limit: number }} ctx
 * @returns {{ candidates: any[], memories: number, events: number }}
 */
function collectPatterns(tx, ctx) {
  const groups = tx.all(
    `SELECT type AS type, COUNT(*) AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest
       FROM memories
      WHERE scope_id = ? AND status IN ('active', 'candidate', 'superseded')
        AND deletion_epoch = 0 AND created_at >= ? AND created_at < ?
      GROUP BY type HAVING COUNT(*) >= ?
      ORDER BY n DESC LIMIT ?`,
    [ctx.scopeId, ctx.fromIso, ctx.toIso, PATTERN_MIN_COUNT, ctx.limit],
  );
  let scannedMemories = 0;
  /** @type {any[]} */
  const candidates = [];
  for (const group of groups) {
    const memoryRows = tx.all(
      `SELECT id FROM memories
        WHERE scope_id = ? AND type = ? AND status IN ('active', 'candidate', 'superseded')
          AND deletion_epoch = 0 AND created_at >= ? AND created_at < ?
        ORDER BY created_at DESC LIMIT 5`,
      [ctx.scopeId, String(group.type), ctx.fromIso, ctx.toIso],
    );
    scannedMemories += memoryRows.length;
    const count = Number(group.n);
    const spanMs = Date.parse(String(group.newest)) - Date.parse(String(group.oldest));
    if (!Number.isFinite(spanMs) || spanMs <= PATTERN_MIN_SPAN_MS) continue;
    const evidence = memoryRows.map((row) => `memory:${String(row.id)}`);
    if (evidence.length === 0) continue;
    const spanDays = Math.round(spanMs / (24 * 60 * 60 * 1000));
    candidates.push({
      kind: 'pattern',
      text: `「${String(group.type)}」类的记忆在 ${spanDays} 天里出现了 ${count} 次，可能是一个稳定的模式（证据：${evidence.slice(0, 3).join('、')}）。`,
      evidence,
      confidence: KIND_CONFIDENCE.pattern,
    });
  }
  return { candidates, memories: scannedMemories, events: 0 };
}

/**
 * 规则 4：互相矛盾的记忆。
 *
 * 判据：`memory_edges(kind='contradicts')` 两端**都还活着**（未被 deleted/expired/superseded）。
 * 为什么「都还活着」等于「未处理」：一旦一边被取代，矛盾就自然消解了；
 * 如果两边都还在，说明没有人做过裁决——那正是该提醒主人的时候。
 * @param {any} tx
 * @param {{ scopeId: string, fromIso: string, toIso: string, limit: number }} ctx
 * @returns {{ candidates: any[], memories: number, events: number }}
 */
function collectContradictions(tx, ctx) {
  const rows = tx.all(
    `SELECT e.id AS edge_id, e.from_memory_id AS from_id, e.to_memory_id AS to_id, e.created_at AS created_at
       FROM memory_edges e
       JOIN memories f ON f.id = e.from_memory_id
       JOIN memories t ON t.id = e.to_memory_id
      WHERE e.scope_id = ? AND e.kind = 'contradicts' AND e.deletion_epoch = 0
        AND f.scope_id = ? AND t.scope_id = ?
        AND f.status NOT IN ('deleted', 'expired', 'superseded')
        AND t.status NOT IN ('deleted', 'expired', 'superseded')
        AND e.created_at >= ? AND e.created_at < ?
      ORDER BY e.created_at DESC LIMIT ?`,
    [ctx.scopeId, ctx.scopeId, ctx.scopeId, ctx.fromIso, ctx.toIso, ctx.limit],
  );
  /** @type {any[]} */
  const candidates = [];
  for (const row of rows) {
    const evidence = [
      `edge:${String(row.edge_id)}`,
      `memory:${String(row.from_id)}`,
      `memory:${String(row.to_id)}`,
    ];
    candidates.push({
      kind: 'contradiction',
      text: `发现两条记忆互相矛盾（edge:${String(row.edge_id)}，${String(row.created_at).slice(0, 10)}），两边都还在。需要人工核验，系统不自动选边。`,
      evidence,
      confidence: KIND_CONFIDENCE.contradiction,
    });
  }
  return { candidates, memories: 0, events: 0, edges: rows.length };
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
function rowToReflection(row) {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    scopeId: String(row.scope_id),
    kind: String(row.kind),
    text: String(row.text),
    evidence: parseStringArray(row.evidence_json),
    confidence: Number(row.confidence),
    status: String(row.status),
    promotedMemoryId: row.promoted_memory_id == null ? null : String(row.promoted_memory_id),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * 造反思模块。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string, epoch_ms: number } },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   workspace?: any,
 *   bindings?: { scope_id?: string, person_id?: string } | null,
 *   memories?: { create: (draft: any) => Promise<{ id: string }> } | null,
 * }} options
 */
export function createReflect(options) {
  const { db, queue, clock } = options;
  const bindings = options.bindings ?? null;
  const workspace = options.workspace ?? null;
  const memoriesFacade = options.memories ?? null;
  const alert = options.alert ?? null;
  const reader = createReader(db);
  /** workspace 缺失的告警只记一次：每次 runOnce 都喊一遍等于制造告警噪音。 */
  let workspaceWarned = false;

  /**
   * 反思总开关检查。返回 `null` 表示可以跑，否则返回可直接返回的 skipped 结果。
   *
   * **这段必须是 runOnce 的第一件事**：任何写在开关检查之前的副作用
   * （哪怕只是插一条 running 状态的 run 记录）都会让「关掉后零副作用」不成立。
   * @returns {{ skipped: true, reason: string, zeroSideEffects: true } | null}
   */
  function switchGate() {
    if (!workspace) {
      // workspace 没接线：判不了开关。按默认安全姿态处理（不开工），并留一次告警。
      if (!workspaceWarned) {
        workspaceWarned = true;
        notify(alert, 'cognition.reflection_workspace_missing', 'workspace 未接线，空闲反思默认不开工（零副作用）', {});
      }
      return { skipped: true, reason: 'workspace_unavailable', zeroSideEffects: true };
    }
    const enabled = isSwitchEnabled(workspace, 'reflection.enabled');
    if (enabled !== true) {
      return { skipped: true, reason: enabled === false ? 'reflection_disabled' : 'reflection_switch_unknown', zeroSideEffects: true };
    }
    const paused = isPausedSwitch(workspace);
    if (paused !== false) {
      return { skipped: true, reason: paused === true ? 'paused' : 'paused_unknown', zeroSideEffects: true };
    }
    return null;
  }

  /**
   * 跑一次反思。
   *
   * @param {{
   *   windowFrom?: string | number | Date,
   *   windowTo?: string | number | Date,
   *   limit?: number,
   *   trigger?: 'manual' | 'idle' | 'scheduled' | 'after_turn',
   *   scopeId?: string,
   * }} [input]
   * @returns {Promise<any>}
   */
  async function runOnce(input = {}) {
    const gate = switchGate();
    if (gate !== null) return gate;

    const scopeId = resolveScopeId(input.scopeId, bindings);
    const trigger = input.trigger ?? 'manual';
    if (!REFLECTION_TRIGGERS.includes(trigger)) {
      throw new BrainError('INVALID_ARGUMENT', `trigger 取值非法：${String(trigger)}（可选 ${REFLECTION_TRIGGERS.join(' | ')}）`);
    }
    const limit = clampInt(input.limit, 1, MAX_INPUT_LIMIT, DEFAULT_INPUT_LIMIT, 'limit');
    const stampNow = clock.stamp();
    const fromIso = normalizeInstant(input.windowFrom, 'windowFrom')
      ?? new Date(Date.parse(stampNow.utc) - DEFAULT_WINDOW_MS).toISOString();
    // 缺省终点取「现在 + 1ms」：窗口是左闭右开 [from, to)，而刚写下的一条记忆
    // created_at 正好等于此刻。若终点取 now，最新那条永远进不了本次反思——
    // 那是「刚说的事下一次才会被想起来」这类难以察觉的漏检。
    let toIso = normalizeInstant(input.windowTo, 'windowTo')
      ?? new Date(Date.parse(stampNow.utc) + 1).toISOString();
    if (Date.parse(fromIso) >= Date.parse(toIso)) {
      throw new BrainError('INVALID_ARGUMENT', 'windowFrom 必须早于 windowTo');
    }
    if (Date.parse(toIso) - Date.parse(fromIso) > MAX_WINDOW_MS) {
      toIso = new Date(Date.parse(fromIso) + MAX_WINDOW_MS).toISOString();
    }

    // 事务 1：先立批次（running）。这样即便后面崩了，也能回答「这次反思跑过」。
    const runId = newId('rrn');
    const startedAt = stampNow.utc;
    await queue.write(
      (tx) => {
        tx.run(
          `INSERT INTO reflection_runs (
             id, scope_id, trigger, status, started_at, started_at_local,
             window_from, window_to, inputs_json, produced_count, promoted_count
           ) VALUES (?, ?, ?, 'running', ?, ?, ?, ?, '{}', 0, 0)`,
          [runId, scopeId, trigger, startedAt, stampNow.local, fromIso, toIso],
        );
      },
      { label: 'reflect.startRun' },
    );

    const startedMs = Date.now();
    try {
      const outcome = await queue.write(
        (tx) => {
          const ctx = { scopeId, fromIso, toIso, limit };
          const commitment = collectCommitments(tx, ctx);
          const gaps = collectKnowledgeGaps(tx, ctx);
          const patterns = collectPatterns(tx, ctx);
          const contradictions = collectContradictions(tx, ctx);
          const inputs = {
            memories: commitment.memories + gaps.memories + patterns.memories,
            events: commitment.events + gaps.events,
            edges: contradictions.edges,
            windowFrom: fromIso,
            windowTo: toIso,
            limit,
          };

          const all = [
            ...commitment.candidates,
            ...gaps.candidates,
            ...patterns.candidates,
            ...contradictions.candidates,
          ];
          const stamp = clock.stamp();
          let produced = 0;
          let droppedEmpty = 0;
          let duplicates = 0;
          /** @type {string[]} */
          const producedIds = [];

          for (const candidate of all) {
            const evidence = Array.isArray(candidate.evidence) ? candidate.evidence : [];
            // 纪律：空证据直接丢弃，不写行（连 rejected 都不留：没证据的东西不该占位）。
            if (evidence.length === 0) {
              droppedEmpty += 1;
              continue;
            }
            const signature = evidenceSignature(candidate.kind, evidence);
            if (findDuplicateReflection(tx, scopeId, signature) !== null) {
              duplicates += 1;
              continue;
            }
            const id = newId('rfl');
            tx.run(
              `INSERT INTO reflections (
                 id, run_id, scope_id, kind, text, evidence_json, confidence, status,
                 created_at, created_at_local, updated_at, updated_at_local
               ) VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?)`,
              [
                id,
                runId,
                scopeId,
                candidate.kind,
                String(candidate.text).slice(0, MAX_REFLECTION_TEXT),
                stringifyJson(evidence, 'evidence', '[]'),
                clamp01(Number(candidate.confidence)),
                stamp.utc,
                stamp.local,
                stamp.utc,
                stamp.local,
              ],
            );
            produced += 1;
            producedIds.push(id);
          }

          tx.run(
            `UPDATE reflection_runs
                SET status = 'completed', finished_at = ?, inputs_json = ?,
                    produced_count = ?, duration_ms = ?
              WHERE id = ? AND scope_id = ?`,
            [
              stamp.utc,
              stringifyJson(inputs, 'inputs'),
              produced,
              Math.max(0, Date.now() - startedMs),
              runId,
              scopeId,
            ],
          );

          return { produced, duplicates, droppedEmpty, inputs, producedIds };
        },
        { label: 'reflect.runOnce' },
      );

      return {
        runId,
        status: 'completed',
        trigger,
        scopeId,
        windowFrom: fromIso,
        windowTo: toIso,
        produced: outcome.produced,
        duplicates: outcome.duplicates,
        droppedEmpty: outcome.droppedEmpty,
        inputs: outcome.inputs,
        reflectionIds: outcome.producedIds,
      };
    } catch (err) {
      // 规则崩了也要留痕：把批次标 failed 并记错误摘要（不吞）。
      const message = err instanceof Error ? err.message : String(err);
      try {
        await queue.write(
          (tx) => {
            const stamp = clock.stamp();
            tx.run(
              `UPDATE reflection_runs
                  SET status = 'failed', finished_at = ?, duration_ms = ?, error = ?
                WHERE id = ? AND scope_id = ?`,
              [stamp.utc, Math.max(0, Date.now() - startedMs), message.slice(0, 500), runId, scopeId],
            );
          },
          { label: 'reflect.failRun' },
        );
      } catch {
        /* 标记失败也失败：保留原始错误，别掩盖 */
      }
      notify(alert, 'cognition.reflection_failed', `反思批次失败：${message}`, { runId, scopeId });
      return { runId, status: 'failed', trigger, scopeId, windowFrom: fromIso, windowTo: toIso, produced: 0, error: message };
    }
  }

  /**
   * 把一条反思晋升成记忆。
   *
   * 幂等口径：**以 reflections.status 为准**。重复调用返回既有 memory id，
   * 不写第二条记忆。若注入了 memories 门面，还额外用 `memories.causation_id`
   * 兜住「写记忆成功但标记失败」的半途状态。
   *
   * @param {string} reflectionId
   * @param {{ scopeId?: string }} [opts]
   * @returns {Promise<any>}
   */
  async function promote(reflectionId, opts = {}) {
    const id = requireText(reflectionId, 'reflectionId', { maxLength: 120 });
    const scopeId = resolveScopeId(opts.scopeId, bindings);

    if (memoriesFacade && typeof memoriesFacade.create === 'function') {
      return promoteViaFacade(id, scopeId);
    }

    // 事务外预检：业务错误必须在进入写队列之前抛（理由见 internal.requireRow 注释）。
    const pre = requireRow(
      reader,
      'SELECT * FROM reflections WHERE id = ? AND scope_id = ?',
      [id, scopeId],
      `反思不存在：${id}`,
    );
    const preStatus = String(pre.status);
    if (preStatus === 'promoted') {
      return {
        reflectionId: id,
        memoryId: pre.promoted_memory_id == null ? null : String(pre.promoted_memory_id),
        promoted: false,
        alreadyPromoted: true,
        via: 'direct',
      };
    }
    if (preStatus === 'dismissed') throw new BrainError('INVALID_ARGUMENT', '已否决的反思不得晋升');
    if (preStatus === 'expired') throw new BrainError('INVALID_ARGUMENT', '已过期的反思不得晋升');
    const preEvidence = parseStringArray(pre.evidence_json);
    if (preEvidence.length === 0) throw new BrainError('INVALID_ARGUMENT', '空证据的反思不得晋升');

    return queue.write(
      (tx) => {
        // 事务内再读一次：预检与写入之间若被别的路径改了状态，以最新状态为准。
        const row = tx.get('SELECT * FROM reflections WHERE id = ? AND scope_id = ?', [id, scopeId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `反思不存在：${id}`);
        const status = String(row.status);
        if (status === 'promoted') {
          return {
            reflectionId: id,
            memoryId: row.promoted_memory_id == null ? null : String(row.promoted_memory_id),
            promoted: false,
            alreadyPromoted: true,
            via: 'direct',
          };
        }
        if (status === 'dismissed') throw new BrainError('INVALID_ARGUMENT', '已否决的反思不得晋升');
        if (status === 'expired') throw new BrainError('INVALID_ARGUMENT', '已过期的反思不得晋升');

        const evidence = parseStringArray(row.evidence_json);
        if (evidence.length === 0) throw new BrainError('INVALID_ARGUMENT', '空证据的反思不得晋升');

        const kind = String(row.kind);
        const type = KIND_TO_MEMORY_TYPE[kind] ?? 'semantic';
        const confidence = Math.min(PROMOTED_CONFIDENCE_CAP, clamp01(Number(row.confidence)));
        const content = String(row.text).slice(0, MAX_REFLECTION_TEXT);
        const memoryId = newId('mem');
        const stamp = clock.stamp();
        const personId = bindings?.person_id ?? 'owner';

        tx.run(
          `INSERT INTO memories (
             id, person_id, scope_id, layer, type, content, summary, source_type, source_ids,
             confidence, importance, privacy, status,
             created_at, created_at_local, updated_at, updated_at_local,
             pinned, version, content_hash, origin_system, producer, derived_from, causation_id
           ) VALUES (?, ?, ?, 'fragment', ?, ?, ?, 'inference', '[]',
                     ?, 0.4, 'private', 'active',
                     ?, ?, ?, ?, 0, 1, ?, 'brain', 'dmn', ?, ?)`,
          [
            memoryId,
            personId,
            scopeId,
            type,
            content,
            content.slice(0, 120),
            confidence,
            stamp.utc,
            stamp.local,
            stamp.utc,
            stamp.local,
            contentHash(content),
            stringifyJson(evidence, 'derived_from', '[]'),
            id,
          ],
        );
        // 主账的版本留痕：直接 INSERT 绕过了 memories.create，这一步是补回来的。
        tx.run(
          `INSERT INTO memory_versions (
             memory_id, version, content, summary, status, source_type, source_ids,
             confidence, importance, privacy, supersedes, changed_by, change_reason,
             content_hash, created_at, created_at_local
           ) VALUES (?, 1, ?, ?, 'active', 'inference', '[]', ?, 0.4, 'private', NULL, 'dmn', 'promote:reflection', ?, ?, ?)`,
          [memoryId, content, content.slice(0, 120), confidence, contentHash(content), stamp.utc, stamp.local],
        );
        tx.run(
          `UPDATE reflections SET status = 'promoted', promoted_memory_id = ?,
                  updated_at = ?, updated_at_local = ?
            WHERE id = ? AND scope_id = ?`,
          [memoryId, stamp.utc, stamp.local, id, scopeId],
        );
        // 批次的晋升计数：没有它，「这次反思产出的东西后来被采纳了多少」就只能靠猜。
        tx.run(
          `UPDATE reflection_runs SET promoted_count = promoted_count + 1
            WHERE id = ? AND scope_id = ?`,
          [String(row.run_id), scopeId],
        );
        return { reflectionId: id, memoryId, promoted: true, alreadyPromoted: false, type, confidence, via: 'direct' };
      },
      { label: 'reflect.promote' },
    );
  }

  /**
   * 走 memories 门面的晋升路径（可选接线）。
   *
   * 为什么分两步：memories.create 自己会开写事务，不能在另一个写事务里调用
   * （单写队列串行，嵌套会死锁）。所以先把记忆写出来，再用事务把反思标记成 promoted。
   * 两步之间的半途状态由 `causation_id = reflectionId` 兜住：重试时先查已有记忆。
   * @param {string} id
   * @param {string} scopeId
   * @returns {Promise<any>}
   */
  async function promoteViaFacade(id, scopeId) {
    const existingReflection = reader.get('SELECT * FROM reflections WHERE id = ? AND scope_id = ?', [id, scopeId]);
    if (existingReflection === undefined) throw new BrainError('NOT_FOUND', `反思不存在：${id}`);
    if (String(existingReflection.status) === 'promoted') {
      return {
        reflectionId: id,
        memoryId: existingReflection.promoted_memory_id == null ? null : String(existingReflection.promoted_memory_id),
        promoted: false,
        alreadyPromoted: true,
        via: 'facade',
      };
    }
    if (String(existingReflection.status) === 'dismissed') throw new BrainError('INVALID_ARGUMENT', '已否决的反思不得晋升');
    if (String(existingReflection.status) === 'expired') throw new BrainError('INVALID_ARGUMENT', '已过期的反思不得晋升');
    const evidence = parseStringArray(existingReflection.evidence_json);
    if (evidence.length === 0) throw new BrainError('INVALID_ARGUMENT', '空证据的反思不得晋升');

    /** @type {string | null} */
    let memoryId = null;
    const existingMemory = reader.get(
      'SELECT id FROM memories WHERE causation_id = ? AND scope_id = ? AND status <> ? ORDER BY created_at ASC LIMIT 1',
      [id, scopeId, 'deleted'],
    );
    if (existingMemory !== undefined) {
      memoryId = String(existingMemory.id);
    } else {
      const kind = String(existingReflection.kind);
      const created = await memoriesFacade.create({
        scopeId,
        content: String(existingReflection.text).slice(0, MAX_REFLECTION_TEXT),
        summary: String(existingReflection.text).slice(0, 120),
        layer: 'fragment',
        type: KIND_TO_MEMORY_TYPE[kind] ?? 'semantic',
        sourceType: 'inference',
        confidence: Math.min(PROMOTED_CONFIDENCE_CAP, clamp01(Number(existingReflection.confidence))),
        importance: 0.4,
        privacy: 'private',
        status: 'active',
        originSystem: 'brain',
        producer: 'dmn',
        causationId: id,
        derivedFrom: evidence,
      });
      memoryId = String(created.id);
    }

    return queue.write(
      (tx) => {
        const stamp = clock.stamp();
        const current = tx.get('SELECT status, promoted_memory_id FROM reflections WHERE id = ? AND scope_id = ?', [id, scopeId]);
        if (current === undefined) throw new BrainError('NOT_FOUND', `反思不存在：${id}`);
        if (String(current.status) === 'promoted') {
          return {
            reflectionId: id,
            memoryId: current.promoted_memory_id == null ? memoryId : String(current.promoted_memory_id),
            promoted: false,
            alreadyPromoted: true,
            via: 'facade',
          };
        }
        tx.run(
          `UPDATE reflections SET status = 'promoted', promoted_memory_id = ?,
                  updated_at = ?, updated_at_local = ?
            WHERE id = ? AND scope_id = ?`,
          [memoryId, stamp.utc, stamp.local, id, scopeId],
        );
        tx.run(
          `UPDATE reflection_runs SET promoted_count = promoted_count + 1
            WHERE id = ? AND scope_id = ?`,
          [String(existingReflection.run_id), scopeId],
        );
        return { reflectionId: id, memoryId, promoted: true, alreadyPromoted: false, via: 'facade' };
      },
      { label: 'reflect.promoteFacade' },
    );
  }

  /**
   * 否决一条反思（候选是垃圾就得能扔掉，否则反思表会被噪声灌满）。
   * @param {string} reflectionId
   * @param {{ by?: string | null, scopeId?: string }} [opts]
   * @returns {Promise<any>}
   */
  async function dismiss(reflectionId, opts = {}) {
    const id = requireText(reflectionId, 'reflectionId', { maxLength: 120 });
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    // 事务外预检（理由同 promote）。
    const pre = requireRow(
      reader,
      'SELECT status FROM reflections WHERE id = ? AND scope_id = ?',
      [id, scopeId],
      `反思不存在：${id}`,
    );
    const preStatus = String(pre.status);
    if (preStatus === 'dismissed') return { reflectionId: id, status: 'dismissed', dismissed: false, alreadyDismissed: true };
    if (preStatus === 'promoted') throw new BrainError('INVALID_ARGUMENT', '已晋升的反思不得否决');
    return queue.write(
      (tx) => {
        const row = tx.get('SELECT status FROM reflections WHERE id = ? AND scope_id = ?', [id, scopeId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `反思不存在：${id}`);
        const status = String(row.status);
        if (status === 'dismissed') return { reflectionId: id, status, dismissed: false, alreadyDismissed: true };
        if (status === 'promoted') throw new BrainError('INVALID_ARGUMENT', '已晋升的反思不得否决');
        const stamp = clock.stamp();
        tx.run(
          `UPDATE reflections SET status = 'dismissed', updated_at = ?, updated_at_local = ?
            WHERE id = ? AND scope_id = ?`,
          [stamp.utc, stamp.local, id, scopeId],
        );
        return { reflectionId: id, status: 'dismissed', dismissed: true, alreadyDismissed: false, by: opts.by ?? null };
      },
      { label: 'reflect.dismiss' },
    );
  }

  /**
   * 列反思（默认只看候选）。
   * @param {{ status?: string, kind?: string, limit?: number, scopeId?: string }} [query]
   * @returns {{ items: any[], limit: number }}
   */
  function list(query = {}) {
    const scopeId = resolveScopeId(query.scopeId, bindings);
    const limit = clampInt(query.limit, 1, MAX_REFLECTION_LIMIT, DEFAULT_REFLECTION_LIMIT, 'limit');
    const where = ['scope_id = ?'];
    /** @type {any[]} */
    const params = [scopeId];
    if (query.status !== undefined && query.status !== null && query.status !== '') {
      where.push('status = ?');
      params.push(String(query.status));
    }
    if (query.kind !== undefined && query.kind !== null && query.kind !== '') {
      where.push('kind = ?');
      params.push(String(query.kind));
    }
    params.push(limit);
    const rows = reader.all(
      `SELECT * FROM reflections WHERE ${where.join(' AND ')} ORDER BY created_at DESC, id DESC LIMIT ?`,
      params,
    );
    return { items: rows.map(rowToReflection), limit };
  }

  /**
   * 读一条反思。
   * @param {string} reflectionId
   * @param {{ scopeId?: string }} [opts]
   * @returns {any | null}
   */
  function get(reflectionId, opts = {}) {
    const id = requireText(reflectionId, 'reflectionId', { maxLength: 120 });
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const row = reader.get('SELECT * FROM reflections WHERE id = ? AND scope_id = ?', [id, scopeId]);
    return row === undefined ? null : rowToReflection(row);
  }

  /**
   * 统计（面板用）。
   * @param {{ scopeId?: string }} [opts]
   * @returns {{ runs: number, lastRunAt: string | null, lastRunStatus: string | null, byStatus: Record<string, number> }}
   */
  function stats(opts = {}) {
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const run = reader.get(
      'SELECT started_at, status FROM reflection_runs WHERE scope_id = ? ORDER BY started_at DESC, id DESC LIMIT 1',
      [scopeId],
    );
    const statusRows = reader.all(
      'SELECT status, COUNT(*) AS n FROM reflections WHERE scope_id = ? GROUP BY status',
      [scopeId],
    );
    /** @type {Record<string, number>} */
    const byStatus = {};
    for (const row of statusRows) byStatus[String(row.status)] = Number(row.n);
    const runs = reader.count('SELECT COUNT(*) AS n FROM reflection_runs WHERE scope_id = ?', [scopeId]);
    return {
      runs,
      lastRunAt: run === undefined ? null : String(run.started_at),
      lastRunStatus: run === undefined ? null : String(run.status),
      byStatus,
    };
  }

  /**
   * 读一条 run（排查用：inputs/error 都在这里）。
   * @param {string} runId
   * @param {{ scopeId?: string }} [opts]
   * @returns {any | null}
   */
  function getRun(runId, opts = {}) {
    const id = requireText(runId, 'runId', { maxLength: 120 });
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const row = reader.get('SELECT * FROM reflection_runs WHERE id = ? AND scope_id = ?', [id, scopeId]);
    if (row === undefined) return null;
    return {
      id: String(row.id),
      scopeId: String(row.scope_id),
      trigger: String(row.trigger),
      status: String(row.status),
      startedAt: String(row.started_at),
      finishedAt: row.finished_at == null ? null : String(row.finished_at),
      windowFrom: row.window_from == null ? null : String(row.window_from),
      windowTo: row.window_to == null ? null : String(row.window_to),
      inputs: parseObjectJson(row.inputs_json),
      producedCount: Number(row.produced_count ?? 0),
      promotedCount: Number(row.promoted_count ?? 0),
      durationMs: row.duration_ms == null ? null : Number(row.duration_ms),
      error: row.error == null ? null : String(row.error),
    };
  }

  return {
    runOnce,
    promote,
    dismiss,
    list,
    get,
    getRun,
    stats,
    // 常量与纯函数一并挂出：面板/测试不需要再 import 一遍子路径
    REFLECTION_TRIGGERS,
    REFLECTION_KINDS,
    KIND_TO_MEMORY_TYPE,
    KIND_CONFIDENCE,
    PROMOTED_CONFIDENCE_CAP,
    DEFAULT_WINDOW_MS,
    PATTERN_MIN_COUNT,
    PATTERN_MIN_SPAN_MS,
    topicTokens,
  };
}
