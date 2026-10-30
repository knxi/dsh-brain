// @ts-check
/**
 * `social` —— 主动社交：候选生成 → 评分 → 策略仲裁 → 发送（系统 4 下半 · 3）。
 *
 * ── 方案 §7.5 的标准链路，一条都不能跳 ──
 *
 * ```
 *   候选生成器 ──→ social_candidates(status='proposed')
 *        │               │ score()
 *        │               ▼
 *        │        status='scored'（score_breakdown 必填）
 *        │               │ arbitrate()：过 proactive_policies 的闸
 *        │               ▼
 *        │        status='awaiting_approval'
 *        │               │ send()：默认 dry_run，绝不真发
 *        │               ▼
 *        └────────→ social_sends(delivery_mode='dry_run' | 'approved')
 * ```
 *
 * **不能由模型临时起意直接发送**——所以每个候选必须先落表、必须带 `evidence_json`
 * （只有 id，不放正文）、必须有 `score_breakdown_json`（凭什么给这个分）。
 *
 * ── 三条铁律 ──
 *
 * 1. **开关关着就零写入**：`social.enabled=0` 或 `paused=1` 时，候选不落表、
 *    状态不推进、`social_sends` 一条都不写（连 dry_run 也不写）。
 *    想看「本来会说什么」用 `preview()`，它**只读**。
 * 2. **dry_run 是默认**：`send()` 默认只写 `delivery_mode='dry_run'` 的记录，
 *    不改候选状态、不占每日上限。真发（`approved`）需要
 *    `social.enabled=1` **且** `social.allow_external=1`，并且还要有注入的通道钩子；
 *    没有钩子就如实返回 `{ queued:false, reason:'no_channel_configured' }`。
 * 3. **真实性优先于丰富度**：`discovery`（「我查到了」「刚做完了」）没有真实
 *    `evidence_ref` 一律 `rejected`。宁可一条不发，也不编一句「我发现了一个规律」。
 *
 * ── 评分公式（方案 §7.5 的落地）──
 *
 * `总分 = clamp(50 + 相关性 + 实际帮助 + 关系适配 + 新鲜度 − 打扰成本 − 重复度 − 忙碌/负面反馈 − 压力资源, 0, 100)`
 *
 * 其中硬闸（移植自 `plugins/dsh-fox-mood/core.js` 的 `shouldReachOut`）**不给加权留口子**：
 * 深夜 0–6 点、30 分钟内已发、精力 < 25、心情 < 30 —— 命中即 `rejected`，
 * 不让「关系很熟 + 状态很好」把它们抵掉，那正是骚扰的起点。
 */

import { BrainError } from './core.js';
import { CARE_STRONG_KEYWORDS, CARE_WEAK_KEYWORDS, careStrengthOf, isResolvedCareText } from './care.js';
import {
  IMPLEMENTED_SOCIAL_SOURCES,
  PENDING_SOCIAL_SOURCES,
  SOCIAL_SOURCES,
  SOCIAL_LIVE_STATUSES,
  assertScope,
  clamp,
  clampInt,
  createTxApi,
  localOf,
  localDayOf,
  localHmOf,
  localHourOf,
  newId,
  readGate,
  requireEnum,
  requireEpochMs,
  requireString,
  resolveScopeId,
  rowToPolicy,
  rowToRelationship,
  safeJsonArray,
  safeJsonObject,
  stringifyJson,
  truncate,
} from './util.js';

/** 硬闸：深夜起点（本地时区，含）。 */
export const NIGHT_START_HOUR = 0;
/** 硬闸：深夜终点（不含）。0–6 点一律不打扰。 */
export const NIGHT_END_HOUR = 6;
/** 硬闸：距上次**真实**外发不足 30 分钟不再开口。 */
export const MIN_GAP_MINUTES = 30;
/** 硬闸：精力低于 25 说不动话。 */
export const MIN_ENERGY = 25;
/** 硬闸：心情低于 30 容易说错话。 */
export const MIN_MOOD = 30;
/** 分数门槛：与 `shouldReachOut` 的 `score >= 55` 一致。 */
export const SCORE_THRESHOLD = 55;
/** 候选默认有效期（小时）。老候选在某天突然被执行是最难查的一类 bug。 */
export const DEFAULT_EXPIRY_HOURS = 12;

/** 评分成分的权重上限（写进 score_breakdown，事后可解释）。 */
export const SCORE_LIMITS = Object.freeze({
  relevance: 25,
  actualHelp: 20,
  relationshipFit: 15,
  freshness: 15,
  /**
   * 来源质量分：只给 `unfinished_care` 用。
   *
   * 为什么单独一项而不是揉进相关性：相关性是「和这个人/这件事有没有关」，
   * 质量是「这条线索本身值不值得开口」。混在一起之后，「项目汇报」这种关键词误命中
   * 会被相关性分数掩盖——上一版就是这么把三条垃圾候选送上 75 分的。
   */
  sourceQuality: 10,
  interruptionCost: -20,
  repetitionPenalty: -20,
  busyPenalty: -25,
  resourcePressure: -15,
});

/** 各来源的「相关性 / 实际帮助」基准分（不同来源的信息量本来就不一样）。 */
const SOURCE_SCORES = Object.freeze({
  schedule: { relevance: 8, actualHelp: 4 },
  unfinished_care: { relevance: 16, actualHelp: 10 },
  commitment: { relevance: 18, actualHelp: 14 },
  discovery: { relevance: 12, actualHelp: 12 },
  shared_memory: { relevance: 10, actualHelp: 6 },
  verification: { relevance: 9, actualHelp: 5 },
  curiosity: { relevance: 7, actualHelp: 4 },
});


/** 一天中的时段文案（schedule 候选的草稿措辞）。 */
function periodWordOf(/** @type {number} */ hour) {
  if (hour < 6) return '凌晨';
  if (hour < 11) return '早上';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 23) return '晚上';
  return '夜里';
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
export function rowToCandidate(row) {
  return {
    id: String(row.id),
    scopeId: String(row.scope_id),
    personId: String(row.person_id),
    source: String(row.source),
    topic: row.topic == null ? null : String(row.topic),
    text: String(row.text),
    evidence: safeJsonArray(row.evidence_json).map((item) => String(item)),
    score: Number(row.score ?? 0),
    scoreBreakdown: safeJsonObject(row.score_breakdown_json),
    status: String(row.status),
    reason: row.reason == null ? null : String(row.reason),
    policyVersion: row.policy_version == null ? null : Number(row.policy_version),
    scheduledFor: row.scheduled_for == null ? null : String(row.scheduled_for),
    expiresAt: row.expires_at == null ? null : String(row.expires_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    decidedAt: row.decided_at == null ? null : String(row.decided_at),
    idempotencyKey: row.idempotency_key == null ? null : String(row.idempotency_key),
  };
}

/**
 * 主动社交门面。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string, epoch_ms?: number }, timeZone?: string },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   workspace?: any,
 *   scopeId?: string,
 *   bindings?: { scope_id?: string, person_id?: string },
 *   channel?: ((input: { channel: string, text: string, candidate: any }) => Promise<any>) | null,
 * }} options
 */
export function createSocial(options) {
  const { db, queue, clock } = options;
  const scopeId = resolveScopeId(options);
  const tx = createTxApi(db);
  const timeZone = clock.timeZone ?? 'Asia/Shanghai';
  const alert = options.alert ?? (() => {});
  const workspace = options.workspace ?? null;
  const channelHook = typeof options.channel === 'function' ? options.channel : null;

  /** @param {unknown} value */
  function resolveNowMs(value) {
    if (value === undefined || value === null || value === '') return clock.stamp().epoch_ms ?? Date.now();
    const ms = requireEpochMs(value, 'now');
    if (ms === null) throw new BrainError('INVALID_ARGUMENT', 'now 不是合法时间');
    return ms;
  }

  /** @param {string} personId */
  function requirePerson(personId) {
    const row = tx.get('SELECT * FROM person_models WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
    if (row === undefined) {
      throw new BrainError('NOT_FOUND', `用户不存在：${personId}（先 ensurePerson 冷启动）`);
    }
    return /** @type {Record<string, any>} */ (row);
  }

  /**
   * 读一份评分上下文（全只读）。
   * @param {{ personId: string, nowMs: number }} input
   */
  function loadContext(input) {
    const { personId, nowMs } = input;
    const personRow = requirePerson(personId);
    const relationshipRow = tx.get('SELECT * FROM relationship_states WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
    const relationship = relationshipRow === undefined ? null : rowToRelationship(/** @type {any} */ (relationshipRow));
    const policyRow = tx.get('SELECT * FROM proactive_policies WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
    const policy = policyRow === undefined ? null : rowToPolicy(/** @type {any} */ (policyRow));

    // 自己的状态（fox_state 是「这一个我」的单行表，不做 scope 过滤）
    let selfState = { mood: 60, energy: 60, stress: 0, known: false };
    try {
      const stateRow = tx.get('SELECT mood, energy, stress FROM fox_state WHERE id = 1');
      if (stateRow !== undefined) {
        selfState = {
          mood: Number(stateRow.mood),
          energy: Number(stateRow.energy),
          stress: stateRow.stress == null ? 0 : Number(stateRow.stress),
          known: true,
        };
      }
    } catch {
      // fox_state 不存在（迁移没跑全）：按「未知」处理，不影响评分可用性
    }

    const lastApproved = tx.get(
      `SELECT MAX(s.at_ms) AS at_ms
         FROM social_sends s
         JOIN social_candidates c ON c.id = s.candidate_id
        WHERE s.scope_id = ? AND c.person_id = ? AND s.delivery_mode = 'approved' AND s.ok = 1`,
      [scopeId, personId],
    );
    const lastApprovedAtMs = lastApproved?.at_ms == null ? null : Number(lastApproved.at_ms);

    const recentTopics = tx.all(
      `SELECT c.topic AS topic, MAX(s.at_ms) AS at_ms
         FROM social_sends s
         JOIN social_candidates c ON c.id = s.candidate_id
        WHERE s.scope_id = ? AND c.person_id = ? AND s.delivery_mode = 'approved' AND s.ok = 1
          AND s.at_ms > ?
        GROUP BY c.topic`,
      [scopeId, personId, nowMs - 7 * 24 * 3600_000],
    );

    const declines = tx.get(
      `SELECT COUNT(*) AS n FROM response_decisions
        WHERE scope_id = ? AND person_id = ? AND decision = 'decline' AND at_ms > ?`,
      [scopeId, personId, nowMs - 7 * 24 * 3600_000],
    );

    let busy = false;
    try {
      const focus = tx.get(
        `SELECT priority, focus_kind FROM attention_focus
          WHERE scope_id = ? AND focus_kind IN ('task','directive') AND priority >= 70`,
        [scopeId],
      );
      busy = focus !== undefined;
    } catch {
      busy = false;
    }

    return {
      personId,
      nowMs,
      lday: localDayOf(nowMs, timeZone),
      hour: localHourOf(nowMs, timeZone),
      hm: localHmOf(nowMs, timeZone),
      person: {
        displayName: personRow.display_name == null ? null : String(personRow.display_name),
        style: safeJsonObject(personRow.style_json),
      },
      relationship,
      policy,
      selfState,
      lastApprovedAtMs,
      recentTopics: recentTopics.map((row) => ({ topic: row.topic == null ? null : String(row.topic), atMs: Number(row.at_ms) })),
      declines7d: Number(declines?.n ?? 0),
      busy,
    };
  }

  /**
   * 评分（也是硬闸所在）。
   *
   * `ctx` 可省略：省略时按候选自带的 `personId`（或绑定的人）现读一次上下文——
   * 这样控制器/CLI 可以直接 `score({ source:'discovery', evidence:['evt_1'] })` 问一句
   * 「这条要是发，几分」，不必自己拼上下文。
   *
   * @param {{
   *   source: string,
   *   topic?: string | null,
   *   evidence?: string[],
   *   personId?: string,
   *   now?: number | string | Date,
   *   ageHours?: number,
   * }} candidate
   * @param {ReturnType<typeof loadContext> & { assumeEnabled?: boolean }} [ctx]
   * @returns {{ score: number, breakdown: Record<string, any>, should: boolean, gates: any[] }}
   */
  function score(candidate, givenCtx) {
    const ctx =
      givenCtx ??
      (() => {
        const personId = requireString(candidate.personId ?? options.bindings?.person_id, 'personId');
        const loaded = loadContext({ personId, nowMs: resolveNowMs(candidate.now) });
        // 独立调用一律按**真实开关**判（不假设「开着」）：问「该不该发」就得把开关算进去。
        // 想预演「如果开着」，用 `preview()`——它显式传 `assumeEnabled:true`。
        return { ...loaded, assumeEnabled: false };
      })();
    const source = requireEnum(candidate.source, SOCIAL_SOURCES, 'candidate.source');
    const evidence = Array.isArray(candidate.evidence) ? candidate.evidence.map((item) => String(item)) : [];
    const base = SOURCE_SCORES[source] ?? { relevance: 8, actualHelp: 4 };
    /** @type {Array<{ code: string, passed: boolean, detail: string }>} */
    const gates = [];
    const gateOut = (/** @type {string} */ code, /** @type {boolean} */ passed, /** @type {string} */ detail) => {
      gates.push({ code, passed, detail });
      return passed;
    };

    // ── 硬闸（不给加权留口子）──
    if (!ctx.assumeEnabled) {
      const gate = readGate(workspace);
      gateOut('switches', gate.canWrite, gate.denied ?? 'ok');
      if (ctx.policy && ctx.policy.enabled !== true) gateOut('policy_disabled', false, '该用户的主动社交策略已关闭');
      else gateOut('policy_disabled', true, 'ok');
    }
    gateOut('missing_evidence', evidence.length > 0, evidence.length > 0 ? '有真实依据' : '没有 evidence_ref（不许编造）');
    gateOut(
      'night_hours',
      !(ctx.hour >= NIGHT_START_HOUR && ctx.hour < NIGHT_END_HOUR),
      `本地时间 ${ctx.hm}（${NIGHT_START_HOUR}–${NIGHT_END_HOUR} 点不打扰）`,
    );
    const sinceLastMin = ctx.lastApprovedAtMs === null ? Infinity : (ctx.nowMs - ctx.lastApprovedAtMs) / 60_000;
    gateOut('too_soon', sinceLastMin >= MIN_GAP_MINUTES, ctx.lastApprovedAtMs === null ? '从没真发过' : `距上次真发 ${Math.round(sinceLastMin)} 分钟`);
    gateOut('low_energy', ctx.selfState.energy >= MIN_ENERGY, `精力 ${Math.round(ctx.selfState.energy)}`);
    gateOut('low_mood', ctx.selfState.mood >= MIN_MOOD, `心情 ${Math.round(ctx.selfState.mood)}`);

    // ── 来源质量（只对 care 类有意义：strong 加分，weak 直接硬闸挡掉）──
    const quality = candidate.quality === 'weak' ? 'weak' : candidate.quality === 'strong' ? 'strong' : null;
    if (quality !== null) {
      gateOut(
        'source_quality',
        quality !== 'weak',
        quality === 'weak'
          ? '弱 care 信号（加班/汇报/项目…这类没有「后来怎么样了」）不配占一次主动开口'
          : '强 care 信号（身体/情绪/有时点的具体安排）',
      );
    }
    const sourceQuality = quality === 'strong' ? 6 : 0;

    // ── 加权成分 ──
    const evidenceBonus = Math.min(evidence.length, 3) * 2;
    const relevance = clamp(base.relevance + evidenceBonus, 0, SCORE_LIMITS.relevance);
    const actualHelp = clamp(base.actualHelp, 0, SCORE_LIMITS.actualHelp);

    const warmth = ctx.relationship ? (Number(ctx.relationship.intimacy) + Number(ctx.relationship.rapport)) / 2 : 0;
    const trust = ctx.relationship ? Number(ctx.relationship.trust) : 0;
    const relationshipFit = clamp(Math.round(-6 + warmth * 20 + trust * 6), -10, SCORE_LIMITS.relationshipFit);

    const ageHours = Number.isFinite(candidate.ageHours) ? Number(candidate.ageHours) : 0;
    let freshness = 6;
    if (ageHours <= 2) freshness = 12;
    else if (ageHours <= 12) freshness = 9;
    else if (ageHours <= 24) freshness = 6;
    else if (ageHours <= 72) freshness = 3;
    else freshness = 0;
    freshness = clamp(freshness, 0, SCORE_LIMITS.freshness);

    let interruptionCost = 0;
    if (ctx.hour >= 22 || ctx.hour < 8) interruptionCost -= 10;
    else if (ctx.hour >= 19 && ctx.hour < 22) interruptionCost -= 3;
    if (sinceLastMin < 180) interruptionCost -= 8;
    else if (sinceLastMin < 24 * 60) interruptionCost -= 4;
    interruptionCost = clamp(interruptionCost, SCORE_LIMITS.interruptionCost, 0);

    let repetitionPenalty = 0;
    const topic = candidate.topic === undefined || candidate.topic === null ? null : String(candidate.topic);
    if (topic) {
      const sameTopic = ctx.recentTopics.find((entry) => entry.topic === topic);
      if (sameTopic) repetitionPenalty -= 18 * Math.exp(-(ctx.nowMs - sameTopic.atMs) / (7 * 24 * 3600_000));
    }
    repetitionPenalty = clamp(Math.round(repetitionPenalty), SCORE_LIMITS.repetitionPenalty, 0);

    let busyPenalty = 0;
    if (ctx.busy) busyPenalty -= 15;
    busyPenalty -= Math.min(ctx.declines7d * 4, 20);
    busyPenalty = clamp(busyPenalty, SCORE_LIMITS.busyPenalty, 0);

    let resourcePressure = 0;
    if (ctx.selfState.energy < 35) resourcePressure -= 8;
    if (ctx.selfState.mood < 45) resourcePressure -= 6;
    if (ctx.selfState.stress > 0.6) resourcePressure -= 6;
    resourcePressure = clamp(resourcePressure, SCORE_LIMITS.resourcePressure, 0);

    const sum =
      relevance + actualHelp + sourceQuality + relationshipFit + freshness + interruptionCost + repetitionPenalty + busyPenalty + resourcePressure;
    const total = clamp(Math.round(50 + sum), 0, 100);
    const failed = gates.filter((gate) => !gate.passed);
    const should = failed.length === 0 && total >= SCORE_THRESHOLD;

    return {
      score: total,
      should,
      gates,
      breakdown: {
        formula:
          'clamp(50 + relevance + actualHelp + sourceQuality + relationshipFit + freshness - interruptionCost - repetition - busy - resource, 0, 100)',
        source,
        components: {
          relevance,
          actualHelp,
          sourceQuality,
          relationshipFit,
          freshness,
          interruptionCost,
          repetitionPenalty,
          busyPenalty,
          resourcePressure,
        },
        limits: SCORE_LIMITS,
        inputs: {
          evidenceCount: evidence.length,
          sourceQuality: quality,
          localHour: ctx.hour,
          localHm: ctx.hm,
          sinceLastApprovedMinutes: Number.isFinite(sinceLastMin) ? Math.round(sinceLastMin) : null,
          selfState: ctx.selfState,
          relationship: ctx.relationship
            ? {
                familiarity: ctx.relationship.familiarity,
                trust: ctx.relationship.trust,
                intimacy: ctx.relationship.intimacy,
                rapport: ctx.relationship.rapport,
              }
            : null,
          busy: ctx.busy,
          declines7d: ctx.declines7d,
          repeatedTopic: Boolean(topic && ctx.recentTopics.some((entry) => entry.topic === topic)),
        },
        gates,
        threshold: SCORE_THRESHOLD,
        should,
      },
    };
  }

  /**
   * 策略闸（免打扰 / 每日上限 / 冷却 / 话题冷却 / 待批准上限）。
   * @param {ReturnType<typeof loadContext>} ctx
   * @param {{ topic?: string | null, source?: string }} [candidate]
   * @returns {{ passed: boolean, reason: string, gates: any[], stats: any }}
   */
  function checkPolicyGates(ctx, candidate = {}) {
    /** @type {Array<{ code: string, passed: boolean, detail: string }>} */
    const gates = [];
    const policy = ctx.policy;
    if (!policy) return { passed: false, reason: 'policy_missing', gates, stats: null };
    gates.push({ code: 'policy_enabled', passed: policy.enabled, detail: policy.enabled ? 'ok' : '该用户策略关闭' });

    const inQuiet = policy.quietHours.some((entry) => {
      if (entry.from <= entry.to) return ctx.hm >= entry.from && ctx.hm < entry.to;
      // 跨午夜：22:00–07:30
      return ctx.hm >= entry.from || ctx.hm < entry.to;
    });
    gates.push({ code: 'quiet_hours', passed: !inQuiet, detail: `${ctx.hm}，免打扰：${policy.quietHours.map((e) => `${e.from}-${e.to}`).join(',') || '无'}` });

    const sentToday = countApprovedToday({ personId: ctx.personId, nowMs: ctx.nowMs });
    gates.push({ code: 'daily_cap', passed: sentToday < policy.dailyCap, detail: `今日真发 ${sentToday}/${policy.dailyCap}（${ctx.lday}）` });

    const sinceLastMin = ctx.lastApprovedAtMs === null ? Infinity : (ctx.nowMs - ctx.lastApprovedAtMs) / 60_000;
    gates.push({
      code: 'cooldown',
      passed: sinceLastMin >= policy.cooldownMinutes,
      detail: `${Math.round(sinceLastMin)} 分钟前发过（冷却 ${policy.cooldownMinutes}）`,
    });

    const topic = candidate.topic === undefined || candidate.topic === null ? null : String(candidate.topic);
    if (topic && policy.topicCooldowns[topic] !== undefined) {
      const sameTopic = ctx.recentTopics.find((entry) => entry.topic === topic);
      const minutes = sameTopic ? (ctx.nowMs - sameTopic.atMs) / 60_000 : Infinity;
      gates.push({
        code: 'topic_cooldown',
        passed: minutes >= policy.topicCooldowns[topic],
        detail: `话题 ${topic} 冷却 ${policy.topicCooldowns[topic]} 分钟（已过 ${Math.round(minutes)}）`,
      });
    }

    const pending = countPending(ctx.personId);
    gates.push({ code: 'max_pending', passed: pending < policy.maxPending, detail: `待批准 ${pending}/${policy.maxPending}` });

    const failed = gates.find((gate) => !gate.passed);
    return { passed: failed === undefined, reason: failed?.code ?? 'ok', gates, stats: { sentToday, pending } };
  }

  /**
   * 本地自然日已真发的条数（`delivery_mode='approved' AND ok=1`）。
   * dry_run 不算：它没真的打扰过谁。
   * @param {{ personId?: string, nowMs?: number }} [query]
   */
  function countApprovedToday(query = {}) {
    const nowMs = resolveNowMs(query.nowMs);
    const lday = localDayOf(nowMs, timeZone);
    const personId = query.personId ?? null;
    const row =
      personId === null
        ? tx.get(
            `SELECT COUNT(*) AS n FROM social_sends
              WHERE scope_id = ? AND delivery_mode = 'approved' AND ok = 1 AND at_local LIKE ?`,
            [scopeId, `${lday}T%`],
          )
        : tx.get(
            `SELECT COUNT(*) AS n FROM social_sends s
               JOIN social_candidates c ON c.id = s.candidate_id
              WHERE s.scope_id = ? AND c.person_id = ? AND s.delivery_mode = 'approved' AND s.ok = 1 AND s.at_local LIKE ?`,
            [scopeId, personId, `${lday}T%`],
          );
    return Number(row?.n ?? 0);
  }

  /** @param {string} personId */
  function countPending(personId) {
    const row = tx.get(
      `SELECT COUNT(*) AS n FROM social_candidates
        WHERE scope_id = ? AND person_id = ? AND status IN ('awaiting_approval', 'scheduled')`,
      [scopeId, personId],
    );
    return Number(row?.n ?? 0);
  }

  /**
   * 候选生成器（四类）。**只产出草稿，不写库；写库与评分在 `generate` 里**。
   *
   * 已实现：`schedule` / `unfinished_care` / `commitment` / `discovery`。
   * 未实现（TODO）：`shared_memory` / `verification` / `curiosity`——
   * 这三类没有可靠的机器可读依据，硬做只会变成编造。见 `skipped` 里的说明。
   *
   * @param {ReturnType<typeof loadContext>} ctx
   * @param {Record<string, any[]>} [signals]
   * @returns {{ drafts: any[], skipped: Array<{ source: string, reason: string }> }}
   */
  function collectDrafts(ctx, signals) {
    /** @type {any[]} */
    const drafts = [];
    /** @type {Array<{ source: string, reason: string }>} */
    const skipped = [];
    const personId = ctx.personId;

    /**
     * @param {string} source
     * @param {any[]} items
     */
    const pushSignals = (source, items) => {
      for (const item of items) {
        if (!item || typeof item !== 'object') continue;
        drafts.push({
          source,
          topic: item.topic === undefined || item.topic === null ? null : String(item.topic),
          text: String(item.text ?? '').slice(0, 500),
          evidence: Array.isArray(item.evidence) ? item.evidence.map((value) => String(value)) : [],
          ageHours: Number.isFinite(item.ageHours) ? Number(item.ageHours) : 0,
          // 注入方可以显式标质量（care 类信号）；不标就按「没有被压低」处理
          quality: item.quality === 'weak' ? 'weak' : item.quality === 'strong' ? 'strong' : undefined,
          scheduledFor: item.scheduledFor ?? null,
          expiresAt: item.expiresAt ?? null,
        });
      }
    };

    // signals 是宿主/测试注入的「现成依据」；给了就不再从库里猜。
    const givenSources = new Set(Object.keys(signals ?? {}));

    for (const source of PENDING_SOCIAL_SOURCES) {
      if (!givenSources.has(source)) skipped.push({ source, reason: 'not_implemented' });
    }

    // ── 1) schedule：按已知作息与时段 ──
    if (givenSources.has('schedule')) {
      pushSignals('schedule', signals?.schedule ?? []);
    } else {
      const rows = tx.all(
        `SELECT id, at_ms, at_local, kind FROM relationship_events
          WHERE scope_id = ? AND person_id = ? ORDER BY at_ms DESC LIMIT 40`,
        [scopeId, personId],
      );
      if (rows.length < 5) {
        skipped.push({ source: 'schedule', reason: 'insufficient_history（少于 5 条互动记录，不知道作息）' });
      } else {
        const hours = rows.map((row) => localHourOf(Number(row.at_ms), timeZone)).sort((a, b) => a - b);
        const low = hours[Math.floor(hours.length * 0.25)];
        const high = hours[Math.floor(hours.length * 0.75)];
        const todayEvents = rows.filter((row) => String(row.at_local).startsWith(`${ctx.lday}T`));
        if (todayEvents.length > 0) {
          skipped.push({ source: 'schedule', reason: 'already_interacted_today（今天已经聊过，不重复打招呼）' });
        } else if (ctx.hour < Math.max(0, low - 1) || ctx.hour > Math.min(23, high + 1)) {
          skipped.push({ source: 'schedule', reason: `outside_active_hours（当前 ${ctx.hm} 不在 ${low}–${high} 点作息内）` });
        } else {
          drafts.push({
            source: 'schedule',
            topic: 'schedule.daily_hello',
            text: `${periodWordOf(ctx.hour)}了，今天还没听见动静，过来问一句：还顺吗？`,
            evidence: rows.slice(0, 3).map((row) => String(row.id)),
            ageHours: 0,
            scheduledFor: null,
            expiresAt: null,
          });
        }
      }
    }

    // ── 2) unfinished_care：上次提到身体/情绪/具体安排，之后没问过 ──
    //
    // 这一路最容易出垃圾候选，所以有四道过滤（顺序有意义）：
    //   a. **记忆类型**只认 episode / commitment——profile / semantic / boundary
    //      是稳定事实（「是本项目的 Team Lead」「要结果不要流程汇报」），
    //      根本没有「后来怎么样了」；
    //   b. **已完成语义**直接跳过（已修复/搞定了/…）——问一件对方早就收尾的事等于没读；
    //   c. **强/弱关键词分级**：只有身体/情绪/有时点的具体安排才算强信号；
    //      弱信号（加班/开会/汇报…）照常生成候选但会被 `source_quality` 硬闸挡掉，
    //      好让「被挡下的」列表能解释原因；
    //   d. 近 14 天、且 3 天内没问过同一话题。
    if (givenSources.has('unfinished_care')) {
      pushSignals('unfinished_care', signals?.unfinished_care ?? []);
    } else {
      const allKeywords = [...CARE_STRONG_KEYWORDS, ...CARE_WEAK_KEYWORDS];
      const likes = allKeywords.map(() => 'content LIKE ? OR summary LIKE ?').join(' OR ');
      const params = [scopeId, personId];
      for (const keyword of allKeywords) params.push(`%${keyword}%`, `%${keyword}%`);
      let rows = [];
      try {
        rows = tx.all(
          `SELECT id, content, summary, type, created_at FROM memories
            WHERE scope_id = ? AND person_id = ? AND status = 'active'
              AND type IN ('episode', 'commitment')
              AND (${likes})
            ORDER BY created_at DESC LIMIT 20`,
          params,
        );
      } catch {
        rows = [];
      }

      let resolved = 0;
      const relevant = rows.filter((row) => {
        const ageMs = ctx.nowMs - Date.parse(String(row.created_at));
        if (!Number.isFinite(ageMs) || ageMs > 14 * 24 * 3600_000) return false;
        const text = `${String(row.summary ?? '')} ${String(row.content ?? '')}`;
        if (isResolvedCareText(text)) {
          resolved += 1;
          return false;
        }
        const topic = `care:${row.id}`;
        const asked = tx.get(
          `SELECT 1 AS ok FROM social_candidates
            WHERE scope_id = ? AND person_id = ? AND topic = ? AND created_at > ?`,
          [scopeId, personId, topic, new Date(ctx.nowMs - 3 * 24 * 3600_000).toISOString()],
        );
        return asked === undefined;
      });
      if (relevant.length === 0) {
        const reason =
          rows.length === 0
            ? 'no_care_evidence（近 14 天没有身体/情绪/具体安排类线索）'
            : resolved > 0
              ? `no_open_care（命中的 ${resolved} 条都已收尾：含「已修复/搞定了」等完成语义）`
              : 'no_care_evidence（近 14 天的线索都已问过）';
        skipped.push({ source: 'unfinished_care', reason });
      } else {
        for (const row of relevant.slice(0, 3)) {
          const rawText = `${String(row.summary ?? '')} ${String(row.content ?? '')}`;
          const strength = careStrengthOf(rawText);
          const snippet = truncate(row.summary ?? row.content ?? '', 40) ?? '';
          const ageHours = (ctx.nowMs - Date.parse(String(row.created_at))) / 3600_000;
          drafts.push({
            source: 'unfinished_care',
            topic: `care:${row.id}`,
            text: `上次你提到「${snippet}」，后来怎么样了？`,
            evidence: [String(row.id)],
            // strong 才配拿「来源质量分」；weak 会被硬闸挡掉（见 score 的 source_quality 闸）
            quality: strength,
            ageHours: Number.isFinite(ageHours) ? ageHours : 0,
            scheduledFor: null,
            expiresAt: null,
          });
        }
      }
    }

    // ── 3) commitment：reflections/directives 里的未完成承诺 ──
    if (givenSources.has('commitment')) {
      pushSignals('commitment', signals?.commitment ?? []);
    } else {
      let found = 0;
      try {
        const reflections = tx.all(
          `SELECT id, text, confidence, created_at FROM reflections
            WHERE scope_id = ? AND kind = 'commitment' AND status IN ('candidate', 'promoted')
            ORDER BY created_at DESC LIMIT 5`,
          [scopeId],
        );
        for (const row of reflections) {
          const ageHours = (ctx.nowMs - Date.parse(String(row.created_at))) / 3600_000;
          found += 1;
          drafts.push({
            source: 'commitment',
            topic: `commit:reflection:${row.id}`,
            text: `之前说好的「${truncate(row.text, 40)}」还没收尾，要不要我接着推？`,
            evidence: [String(row.id)],
            ageHours: Number.isFinite(ageHours) ? ageHours : 0,
            scheduledFor: null,
            expiresAt: null,
          });
        }
      } catch {
        /* reflections 表缺失（迁移没跑全）时静默跳过 */
      }
      try {
        const directives = tx.all(
          `SELECT id, title, status, created_at FROM directives
            WHERE scope_id = ? AND status IN ('proposed', 'awaiting_approval', 'queued', 'running', 'paused')
            ORDER BY priority DESC, created_at ASC LIMIT 5`,
          [scopeId],
        );
        for (const row of directives) {
          const ageHours = (ctx.nowMs - Date.parse(String(row.created_at))) / 3600_000;
          found += 1;
          drafts.push({
            source: 'commitment',
            topic: `commit:directive:${row.id}`,
            text: `「${truncate(row.title, 40)}」还挂在那儿（${row.status}），要我接着弄吗？`,
            evidence: [String(row.id)],
            ageHours: Number.isFinite(ageHours) ? ageHours : 0,
            scheduledFor: null,
            expiresAt: null,
          });
        }
      } catch {
        /* directives 表缺失时跳过 */
      }
      if (found === 0) skipped.push({ source: 'commitment', reason: 'no_open_commitment（没有未完成的承诺）' });
    }

    // ── 4) discovery：真实发现（必须有真实 evidence_ref）──
    if (givenSources.has('discovery')) {
      pushSignals('discovery', signals?.discovery ?? []);
    } else {
      let rows = [];
      try {
        rows = tx.all(
          `SELECT id, kind, payload_json, at_ms, subject_type, subject_id FROM ws_events
            WHERE scope_id = ? AND channel = 'result' AND at_ms > ?
            ORDER BY at_ms DESC LIMIT 10`,
          [scopeId, ctx.nowMs - 6 * 3600_000],
        );
      } catch {
        rows = [];
      }
      const withText = rows
        .map((row) => {
          const payload = safeJsonObject(row.payload_json);
          const summary = payload.summary ?? payload.title ?? payload.text ?? null;
          return { row, summary: summary === null ? null : String(summary) };
        })
        .filter((entry) => entry.summary !== null && entry.summary.trim().length > 0);
      if (withText.length === 0) {
        skipped.push({ source: 'discovery', reason: 'no_recent_result（近 6 小时没有真实结果事件）' });
      } else {
        for (const { row, summary } of withText.slice(0, 3)) {
          drafts.push({
            source: 'discovery',
            topic: `discovery:${row.id}`,
            text: `刚把「${truncate(summary, 40)}」弄完了，跟你说一声。`,
            evidence: [String(row.id)],
            ageHours: (ctx.nowMs - Number(row.at_ms)) / 3600_000,
            scheduledFor: null,
            expiresAt: null,
          });
        }
      }
    }

    return { drafts, skipped };
  }

  /**
   * 生成候选并落库（开关关着时只算不写）。
   *
   * @param {{
   *   personId?: string,
   *   now?: number | string | Date,
   *   signals?: Record<string, any[]>,
   *   persist?: boolean,
   *   sources?: string[],
   *   scopeId?: string,
   * }} [input]
   */
  async function generate(input = /** @type {any} */ ({})) {
    assertScope(scopeId, input.scopeId, 'input.scopeId');
    const personId = requireString(input.personId ?? options.bindings?.person_id, 'personId');
    const nowMs = resolveNowMs(input.now);
    const gate = readGate(workspace);
    const ctx = { ...loadContext({ personId, nowMs }), assumeEnabled: !gate.canWrite };
    const collected = collectDrafts(ctx, input.signals);
    const allowSources = Array.isArray(input.sources) && input.sources.length > 0 ? new Set(input.sources.map(String)) : null;
    const drafts = collected.drafts.filter((draft) => !allowSources || allowSources.has(draft.source));
    const persistWanted = input.persist !== false;
    const canPersist = persistWanted && gate.canWrite;

    /** @type {any[]} */
    const candidates = [];
    let persisted = 0;
    let duplicates = 0;
    let rejected = 0;

    for (const draft of drafts) {
      const idempotencyKey = `${draft.source}:${draft.topic ?? draft.text.slice(0, 24)}:${localDayOf(nowMs, timeZone)}`;
      const scored = score(
        { source: draft.source, topic: draft.topic, evidence: draft.evidence, ageHours: draft.ageHours, quality: draft.quality },
        ctx,
      );
      const expiresAt = draft.expiresAt ?? new Date(nowMs + DEFAULT_EXPIRY_HOURS * 3600_000).toISOString();
      const baseStatus = draft.evidence.length === 0 ? 'rejected' : scored.gates.every((g) => g.passed) ? 'scored' : 'rejected';
      const reason = draft.evidence.length === 0 ? 'missing_evidence' : baseStatus === 'rejected' ? (scored.gates.find((g) => !g.passed)?.code ?? 'gated') : null;

      if (!canPersist) {
        candidates.push({
          id: null,
          source: draft.source,
          topic: draft.topic,
          text: draft.text,
          evidence: draft.evidence,
          score: scored.score,
          scoreBreakdown: scored.breakdown,
          status: baseStatus,
          reason,
          persisted: false,
          wouldSend: scored.should,
        });
        continue;
      }

      const stamp = clock.stamp();
      const candidateId = newId('sol');
      const inserted = await queue.write(
        (txh) => {
          const result = txh.run(
            `INSERT INTO social_candidates (
               id, scope_id, person_id, source, topic, text, evidence_json, score, score_breakdown_json,
               status, reason, scheduled_for, expires_at, created_at, created_at_local, updated_at, updated_at_local, idempotency_key
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope_id, idempotency_key) DO NOTHING`,
            [
              candidateId,
              scopeId,
              personId,
              draft.source,
              draft.topic,
              draft.text,
              stringifyJson(draft.evidence, 'evidence'),
              scored.score,
              stringifyJson(scored.breakdown, 'scoreBreakdown'),
              baseStatus,
              reason,
              draft.scheduledFor,
              expiresAt,
              stamp.utc,
              stamp.local,
              stamp.utc,
              stamp.local,
              idempotencyKey,
            ],
          );
          const changed = Number(result.changes ?? 0);
          if (changed === 0) {
            const existing = txh.get('SELECT * FROM social_candidates WHERE scope_id = ? AND idempotency_key = ?', [
              scopeId,
              idempotencyKey,
            ]);
            return { inserted: false, row: existing };
          }
          return { inserted: true, row: txh.get('SELECT * FROM social_candidates WHERE id = ?', [candidateId]) };
        },
        { label: 'persona.social.generate' },
      );
      if (!inserted.inserted) {
        duplicates += 1;
        candidates.push({ ...rowToCandidate(/** @type {any} */ (inserted.row)), persisted: true, duplicate: true, wouldSend: false });
        continue;
      }
      persisted += 1;
      if (baseStatus === 'rejected') rejected += 1;
      candidates.push({ ...rowToCandidate(/** @type {any} */ (inserted.row)), persisted: true, wouldSend: scored.should });
    }

    return {
      personId,
      generatedAt: clock.stamp().utc,
      switches: { paused: gate.paused, socialEnabled: gate.socialEnabled, allowExternal: gate.allowExternal, denied: gate.denied },
      persisted,
      duplicates,
      rejected,
      preview: !canPersist,
      blocked: canPersist ? null : (gate.denied ?? 'persist_disabled'),
      candidates,
      skipped: collected.skipped,
      pendingSources: PENDING_SOCIAL_SOURCES,
    };
  }

  /** @param {string} candidateId */
  function getCandidate(candidateId) {
    const row = tx.get('SELECT * FROM social_candidates WHERE id = ? AND scope_id = ?', [candidateId, scopeId]);
    return row === undefined ? null : rowToCandidate(row);
  }

  /**
   * 列候选（默认只列「活」的）。
   * @param {{ personId?: string, status?: string, statuses?: string[], limit?: number }} [query]
   */
  function listCandidates(query = {}) {
    const limit = clampInt(query.limit, 1, 500, 100, 'limit');
    /** @type {string[]} */
    const params = [scopeId];
    /** @type {string[]} */
    const where = ['scope_id = ?'];
    if (query.personId) {
      where.push('person_id = ?');
      params.push(requireString(query.personId, 'personId'));
    }
    if (query.status) {
      where.push('status = ?');
      params.push(requireEnum(query.status, [...SOCIAL_LIVE_STATUSES, 'sent', 'answered', 'rejected', 'expired', 'cancelled'], 'status'));
    } else if (Array.isArray(query.statuses) && query.statuses.length > 0) {
      where.push(`status IN (${query.statuses.map(() => '?').join(',')})`);
      for (const status of query.statuses) {
        params.push(requireEnum(status, [...SOCIAL_LIVE_STATUSES, 'sent', 'answered', 'rejected', 'expired', 'cancelled'], 'statuses[]'));
      }
    } else {
      where.push(`status IN (${SOCIAL_LIVE_STATUSES.map(() => '?').join(',')})`);
      for (const status of SOCIAL_LIVE_STATUSES) params.push(status);
    }
    params.push(limit);
    const rows = tx.all(
      `SELECT * FROM social_candidates WHERE ${where.join(' AND ')} ORDER BY score DESC, created_at DESC LIMIT ?`,
      params,
    );
    return { items: rows.map((row) => rowToCandidate(row)), limit };
  }

  /**
   * 仲裁：过策略闸，`scored → awaiting_approval`；过不去就 `rejected`（带原因）。
   *
   * 开关关着时**什么都不写**（连 rejected 也不落）：暂停状态下不该产生业务行。
   * @param {string} candidateId
   * @param {{ now?: number | string | Date, by?: string }} [meta]
   */
  async function arbitrate(candidateId, meta = {}) {
    const id = requireString(candidateId, 'candidateId');
    const nowMs = resolveNowMs(meta.now);
    const gate = readGate(workspace);
    const candidate = getCandidate(id);
    if (!candidate) throw new BrainError('NOT_FOUND', `候选不存在：${id}`);
    if (!gate.canWrite) {
      return { advanced: false, reason: gate.denied, status: candidate.status, gates: [], written: false };
    }
    if (!['proposed', 'scored'].includes(candidate.status)) {
      return { advanced: false, reason: 'invalid_status', status: candidate.status, gates: [], written: false };
    }
    const ctx = loadContext({ personId: candidate.personId, nowMs });
    const verdict = checkPolicyGates(ctx, { topic: candidate.topic, source: candidate.source });
    const stamp = clock.stamp();
    const nextStatus = verdict.passed ? 'awaiting_approval' : 'rejected';
    await queue.write(
      (txh) => {
        txh.run(
          `UPDATE social_candidates
              SET status = ?, reason = ?, policy_version = ?, decided_at = ?, updated_at = ?, updated_at_local = ?
            WHERE id = ? AND scope_id = ?`,
          [
            nextStatus,
            verdict.passed ? null : verdict.reason,
            ctx.policy?.policyVersion ?? null,
            stamp.utc,
            stamp.utc,
            stamp.local,
            id,
            scopeId,
          ],
        );
      },
      { label: 'persona.social.arbitrate' },
    );
    return {
      advanced: verdict.passed,
      status: nextStatus,
      reason: verdict.reason,
      gates: verdict.gates,
      stats: verdict.stats,
      policyVersion: ctx.policy?.policyVersion ?? null,
      written: true,
    };
  }

  /**
   * 发送 / 记录。
   *
   * - 默认 `mode='dry_run'`：只写 `social_sends(delivery_mode='dry_run', ok=1)`，
   *   **不改候选状态、不占每日上限、不碰任何 IM**。
   * - `mode='approved'`：需要 `social.enabled=1` 且 `social.allow_external=1`
   *   且候选处于 `awaiting_approval`/`scheduled`；
   *   没有通道钩子 → 如实返回 `{ queued:false, reason:'no_channel_configured' }`
   *   （并留一条 `ok=0` 的 approved 记录：这是「尝试过但没发出去」的账）。
   * - `paused=1` / `social.enabled=0`：**一条都不写**，直接返回原因。
   *
   * @param {string} candidateId
   * @param {{ mode?: 'dry_run' | 'approved', channel?: string, now?: number | string | Date, approvedBy?: string }} [meta]
   */
  async function send(candidateId, meta = /** @type {any} */ ({})) {
    const id = requireString(candidateId, 'candidateId');
    const mode = requireEnum(meta.mode ?? 'dry_run', ['dry_run', 'approved'], 'mode', { fallback: 'dry_run' });
    const nowMs = resolveNowMs(meta.now);
    const gate = readGate(workspace);
    const candidate = getCandidate(id);
    if (!candidate) throw new BrainError('NOT_FOUND', `候选不存在：${id}`);
    if (!gate.canWrite) {
      return { sent: false, ok: false, recorded: false, queued: false, reason: gate.denied, deliveryMode: mode };
    }

    if (mode === 'dry_run') {
      const record = await recordSend({ candidate, mode: 'dry_run', channel: meta.channel ?? 'console', ok: true, nowMs, receipt: { note: 'dry_run: 没有真的发出去' } });
      return {
        sent: false,
        ok: true,
        recorded: true,
        queued: false,
        deliveryMode: 'dry_run',
        sendId: record.sendId,
        reason: 'dry_run_only',
        text: candidate.text,
      };
    }

    // ── 真发分支 ──
    if (!gate.canExternal) {
      return { sent: false, ok: false, recorded: false, queued: false, reason: 'external_disabled', deliveryMode: 'approved' };
    }
    if (!['awaiting_approval', 'scheduled'].includes(candidate.status)) {
      return {
        sent: false,
        ok: false,
        recorded: false,
        queued: false,
        reason: 'invalid_status',
        status: candidate.status,
        deliveryMode: 'approved',
      };
    }
    const channel = meta.channel ?? 'im';
    if (!channelHook) {
      const record = await recordSend({
        candidate,
        mode: 'approved',
        channel,
        ok: false,
        nowMs,
        error: 'no_channel_configured',
        receipt: { note: '没有配置发送通道（本轮只留 hook，不实现具体 IM）' },
      });
      return {
        sent: false,
        ok: false,
        queued: false,
        recorded: true,
        deliveryMode: 'approved',
        sendId: record.sendId,
        reason: 'no_channel_configured',
      };
    }
    try {
      const result = await channelHook({ channel, text: candidate.text, candidate, personId: candidate.personId });
      if (!result || result.ok === false) {
        const record = await recordSend({
          candidate,
          mode: 'approved',
          channel,
          ok: false,
          nowMs,
          error: String(result?.error ?? 'channel_rejected'),
          receipt: { note: '通道返回失败' },
        });
        return { sent: false, ok: false, queued: false, recorded: true, deliveryMode: 'approved', sendId: record.sendId, reason: 'channel_rejected' };
      }
      const record = await recordSend({
        candidate,
        mode: 'approved',
        channel,
        ok: true,
        nowMs,
        externalId: result.externalId === undefined || result.externalId === null ? null : String(result.externalId),
        receipt: { hook: 'external', channel },
      });
      return {
        sent: true,
        ok: true,
        queued: true,
        recorded: true,
        deliveryMode: 'approved',
        sendId: record.sendId,
        externalId: record.externalId,
        reason: 'sent',
      };
    } catch (err) {
      alert({
        kind: 'persona.social_channel_failed',
        message: `发送通道抛错：${err instanceof Error ? err.message : String(err)}`,
        detail: { candidateId: id, channel },
      });
      const record = await recordSend({
        candidate,
        mode: 'approved',
        channel,
        ok: false,
        nowMs,
        error: 'channel_error',
        receipt: { note: '通道抛错（详情见告警）' },
      });
      return { sent: false, ok: false, queued: false, recorded: true, deliveryMode: 'approved', sendId: record.sendId, reason: 'channel_error' };
    }
  }

  /**
   * 写一条发送记录（内部）。`delivery_mode='approved' AND ok=1` 时同时把候选推进到 `sent`。
   * @param {{
   *   candidate: any, mode: string, channel: string, ok: boolean, nowMs: number,
   *   error?: string | null, externalId?: string | null, receipt?: Record<string, any>,
   * }} input
   */
  async function recordSend(input) {
    const stamp = clock.stamp();
    const at = new Date(input.nowMs).toISOString();
    // `at_local` 用配置时区的完整形态：统计按「本地自然日」前缀 LIKE，展示给人看也不带歧义。
    const atLocalFull = localOf(at, timeZone);
    const sendId = newId('ssd');
    const externalId = input.externalId ?? null;
    await queue.write(
      (txh) => {
        txh.run(
          `INSERT INTO social_sends (
             id, candidate_id, scope_id, channel, delivery_mode, at, at_local, at_ms, ok,
             error, external_id, receipt_json, created_at, created_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            sendId,
            input.candidate.id,
            scopeId,
            input.channel,
            input.mode,
            at,
            atLocalFull,
            input.nowMs,
            input.ok ? 1 : 0,
            input.error ?? null,
            externalId,
            stringifyJson(input.receipt ?? {}, 'receipt'),
            stamp.utc,
            stamp.local,
          ],
        );
        if (input.mode === 'approved' && input.ok) {
          txh.run(
            `UPDATE social_candidates SET status = 'sent', decided_at = ?, updated_at = ?, updated_at_local = ?
              WHERE id = ? AND scope_id = ?`,
            [at, stamp.utc, stamp.local, input.candidate.id, scopeId],
          );
        }
      },
      { label: 'persona.social.send' },
    );
    return { sendId, externalId };
  }

  /**
   * 取消候选（人工）。已终态的不动。
   * @param {string} candidateId
   * @param {{ reason?: string }} [meta]
   */
  async function cancel(candidateId, meta = {}) {
    const id = requireString(candidateId, 'candidateId');
    const gate = readGate(workspace);
    if (!gate.canWrite) return { cancelled: false, reason: gate.denied };
    const candidate = getCandidate(id);
    if (!candidate) throw new BrainError('NOT_FOUND', `候选不存在：${id}`);
    if (!SOCIAL_LIVE_STATUSES.includes(candidate.status)) {
      return { cancelled: false, reason: 'invalid_status', status: candidate.status };
    }
    const stamp = clock.stamp();
    await queue.write(
      (txh) => {
        txh.run(
          `UPDATE social_candidates SET status = 'cancelled', reason = ?, decided_at = ?, updated_at = ?, updated_at_local = ?
            WHERE id = ? AND scope_id = ?`,
          [meta.reason ?? 'cancelled_by_owner', stamp.utc, stamp.utc, stamp.local, id, scopeId],
        );
      },
      { label: 'persona.social.cancel' },
    );
    return { cancelled: true, id, status: 'cancelled', reason: meta.reason ?? 'cancelled_by_owner' };
  }

  /**
   * 过期清理：`expires_at < now` 的活候选 → `expired`。
   * @param {{ now?: number | string | Date }} [meta]
   */
  async function expire(meta = {}) {
    const nowMs = resolveNowMs(meta.now);
    const gate = readGate(workspace);
    if (!gate.canWrite) return { expired: 0, reason: gate.denied };
    const stamp = clock.stamp();
    const iso = new Date(nowMs).toISOString();
    return queue.write(
      (txh) => {
        const result = txh.run(
          `UPDATE social_candidates
              SET status = 'expired', reason = 'expired', decided_at = ?, updated_at = ?, updated_at_local = ?
            WHERE scope_id = ? AND status IN ('proposed','scored','awaiting_approval','scheduled')
              AND expires_at IS NOT NULL AND expires_at < ?`,
          [iso, stamp.utc, stamp.local, scopeId, iso],
        );
        return { expired: Number(result.changes ?? 0) };
      },
      { label: 'persona.social.expire' },
    );
  }

  /**
   * **只读**预演：完全不写库，回答「如果现在开着主动社交，今天本来会说什么」。
   *
   * 这是主人唯一能「感觉到」系统的入口（`bin/social-dryrun.mjs` 就是它的壳），
   * 所以它**必须**在开关全关的情况下也能跑，且绝不因为预览而写任何业务行。
   *
   * @param {{
   *   personId?: string,
   *   now?: number | string | Date,
   *   signals?: Record<string, any[]>,
   *   limit?: number,
   * }} [input]
   */
  function preview(input = /** @type {any} */ ({})) {
    assertScope(scopeId, input.scopeId, 'input.scopeId');
    const personId = requireString(input.personId ?? options.bindings?.person_id, 'personId');
    const nowMs = resolveNowMs(input.now);
    const gate = readGate(workspace);
    const ctx = { ...loadContext({ personId, nowMs }), assumeEnabled: true };
    const collected = collectDrafts(ctx, input.signals);
    const limit = clampInt(input.limit, 1, 100, 20, 'limit');

    // 今天已经落表的候选（已说过的不再重复展示评分，但要看得到）
    const todayRows = tx.all(
      `SELECT * FROM social_candidates WHERE scope_id = ? AND person_id = ? AND created_at_local LIKE ? ORDER BY score DESC LIMIT ?`,
      [scopeId, personId, `${ctx.lday}T%`, limit],
    );

    /** @type {any[]} */
    const fresh = [];
    for (const draft of collected.drafts.slice(0, limit)) {
      const scored = score({ source: draft.source, topic: draft.topic, evidence: draft.evidence, ageHours: draft.ageHours, quality: draft.quality }, ctx);
      const verdict = checkPolicyGates(ctx, { topic: draft.topic, source: draft.source });
      fresh.push({
        id: null,
        persisted: false,
        source: draft.source,
        topic: draft.topic,
        text: draft.text,
        evidence: draft.evidence,
        score: scored.score,
        scoreBreakdown: scored.breakdown,
        gates: scored.gates,
        policyGates: verdict.gates,
        wouldSend: scored.should && verdict.passed,
        blockedBy: scored.should ? (verdict.passed ? null : verdict.reason) : (scored.gates.find((g) => !g.passed)?.code ?? 'below_threshold'),
      });
    }

    /** @type {any[]} */
    const persistedToday = todayRows.map((row) => {
      const candidate = rowToCandidate(row);
      return {
        ...candidate,
        persisted: true,
        wouldSend: candidate.status === 'awaiting_approval' || candidate.status === 'sent',
        blockedBy: candidate.status === 'rejected' ? candidate.reason : null,
      };
    });

    const sendsToday = tx.all(
      `SELECT s.id, s.delivery_mode, s.ok, s.at, s.at_ms, c.topic, c.source, c.text
         FROM social_sends s JOIN social_candidates c ON c.id = s.candidate_id
        WHERE s.scope_id = ? AND c.person_id = ? AND s.at_local LIKE ?
        ORDER BY s.at_ms DESC LIMIT 20`,
      [scopeId, personId, `${ctx.lday}T%`],
    );

    return {
      personId,
      at: { utc: new Date(nowMs).toISOString(), local: `${ctx.lday} ${ctx.hm}`, hour: ctx.hour },
      switches: {
        paused: gate.paused,
        socialEnabled: gate.socialEnabled,
        allowExternal: gate.allowExternal,
        denied: gate.denied,
        wouldBlockRealSend: gate.denied !== null || !gate.allowExternal,
      },
      policy: ctx.policy,
      selfState: ctx.selfState,
      relationship: ctx.relationship
        ? {
            familiarity: ctx.relationship.familiarity,
            trust: ctx.relationship.trust,
            intimacy: ctx.relationship.intimacy,
            rapport: ctx.relationship.rapport,
          }
        : null,
      counts: {
        approvedToday: countApprovedToday({ personId, nowMs }),
        pending: countPending(personId),
        sendsToday: sendsToday.length,
      },
      wouldSay: [...persistedToday.filter((item) => item.wouldSend), ...fresh.filter((item) => item.wouldSend)],
      fresh: fresh.sort((a, b) => b.score - a.score),
      /**
       * 弱 care 信号被丢弃的条数（`blockedBy === 'source_quality'`）。
       * 单独计数给 UI 折叠用：这类候选的正文往往是一段项目日志，
       * 摊在第一屏上只会让人困惑，但「为什么没问」又必须能解释。
       */
      weakCareDropped: fresh.filter((candidate) => candidate.blockedBy === 'source_quality').length,
      persistedToday,
      sendsToday: sendsToday.map((row) => ({
        mode: String(row.delivery_mode),
        ok: Number(row.ok) === 1,
        at: String(row.at),
        topic: row.topic == null ? null : String(row.topic),
        source: String(row.source),
        text: String(row.text),
      })),
      skipped: collected.skipped,
      pendingSources: PENDING_SOCIAL_SOURCES,
      implementedSources: IMPLEMENTED_SOCIAL_SOURCES,
      note: 'dry-run 只读预演：没有写任何业务行，也没有真的发出去。',
    };
  }

  /**
   * 把候选推给 workspace 的候选板（交给执行控制器仲裁）。
   * 只留接口不在本轮自动调用：社交候选的仲裁在本模块内已经有一层策略闸，
   * 再提一遍是给「统一候选队列」留位置。
   * @param {string} candidateId
   */
  async function proposeToWorkspace(candidateId) {
    const id = requireString(candidateId, 'candidateId');
    const candidate = getCandidate(id);
    if (!candidate) throw new BrainError('NOT_FOUND', `候选不存在：${id}`);
    if (!workspace || typeof workspace.propose !== 'function') {
      return { proposed: false, reason: 'workspace_unavailable' };
    }
    const result = await workspace.propose({
      kind: 'proactive',
      originModule: 'persona',
      title: `${candidate.source}: ${truncate(candidate.text, 60)}`,
      payload: { candidateId: candidate.id, personId: candidate.personId, topic: candidate.topic, source: candidate.source },
      score: candidate.score,
      scoreBreakdown: candidate.scoreBreakdown,
      priority: 40,
      evidence: candidate.evidence,
      expiresAt: candidate.expiresAt,
      idempotencyKey: `social:${candidate.id}`,
    });
    return { proposed: true, workspaceCandidateId: result?.id ?? null };
  }

  return {
    generate,
    preview,
    score,
    arbitrate,
    send,
    cancel,
    expire,
    getCandidate,
    listCandidates,
    countApprovedToday,
    loadContext,
    checkPolicyGates,
    proposeToWorkspace,
    scopeId,
    // 常量外抛，测试与文档直接引用，避免「魔法数字」两处不同步
    NIGHT_START_HOUR,
    NIGHT_END_HOUR,
    MIN_GAP_MINUTES,
    MIN_ENERGY,
    MIN_MOOD,
    SCORE_THRESHOLD,
    DEFAULT_EXPIRY_HOURS,
    IMPLEMENTED_SOCIAL_SOURCES,
    PENDING_SOCIAL_SOURCES,
  };
}

