// @ts-check
/**
 * `person-model` —— 每个用户独立的资料、互动风格与主动社交策略（系统 4 下半 · 1）。
 *
 * ── 为什么「每个用户一份」是硬要求 ──
 *
 * 方案 §7.4：核心人格共享，但**用户资料 / 关系 / 风格 / 社交策略 / 情绪观察不共享**。
 * 所以冷启动必须保守：`relationship_states` 四维各从 **0.1** 起步，
 * 不继承任何人的值、不读任何全局「亲密度」。这条靠两件事保证：
 * 1. 建行时显式写入 0.1（不是从别处复制）；
 * 2. `relationship_states` 的主键是 `(scope_id, person_id)`，物理上不可能「借」别人的值。
 *
 * ── 冷启动的默认策略（宁可少说一句）──
 *
 * | 项 | 默认 | 理由 |
 * |---|---|---|
 * | `enabled` | 1 | 策略层允许，但全局 `social.enabled=0` 仍然一条都不发 |
 * | `quiet_hours` | 00:00–07:30 | 深夜不吵人 |
 * | `daily_cap` | 2 | 一天最多两句 |
 * | `cooldown_minutes` | 180 | 三小时内不重复 |
 * | `max_pending` | 1 | 待批准最多一条，不堆积 |
 * | `channels` | `["console"]` | 只进控制台，不外发 |
 */

import { BrainError } from './core.js';
import {
  DEFAULT_PERSON_ID,
  assertScope,
  clampInt,
  createTxApi,
  requireEnum,
  requireString,
  requireUnit,
  resolveScopeId,
  rowToPerson,
  rowToPolicy,
  rowToRelationship,
  safeJsonObject,
  stringifyJson,
} from './util.js';

/** 互动风格枚举。 */
export const REPLY_LENGTHS = Object.freeze(['short', 'normal', 'long']);

/**
 * 冷启动默认风格。
 * 三项容忍度都偏低（0.3~0.4）：先假设对方**不太**喜欢被追问、被分享，
 * 熟了再调高——反过来（先假设对方喜欢）会让新用户第一周就被烦到。
 */
export const DEFAULT_STYLE = Object.freeze({
  replyLength: 'normal',
  address: null,
  humor: 0.4,
  questionTolerance: 0.4,
  shareTolerance: 0.3,
});

/**
 * 冷启动默认策略（与 0008 的 DEFAULT 值一致，但 `topic_cooldowns` 显式给一套——
 * 「未完成的关心」问过一次至少隔 12 小时再问，不然就是催命）。
 */
export const DEFAULT_POLICY = Object.freeze({
  enabled: 1,
  quietHours: [{ from: '00:00', to: '07:30' }],
  dailyCap: 2,
  cooldownMinutes: 180,
  topicCooldowns: { unfinished_care: 720, discovery: 360, schedule: 720 },
  maxPending: 1,
  channels: ['console'],
});

/**
 * 风格校验/合并：只认已知键，未知键直接拒（写进去没人读得懂，还会让下次读的人以为有这功能）。
 * @param {unknown} style
 * @returns {Record<string, any>}
 */
export function normalizeStyle(style) {
  if (style === undefined || style === null) return {};
  if (typeof style !== 'object' || Array.isArray(style)) {
    throw new BrainError('INVALID_ARGUMENT', 'style 必须是对象');
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, value] of Object.entries(/** @type {Record<string, any>} */ (style))) {
    if (key === 'replyLength') out.replyLength = requireEnum(value, REPLY_LENGTHS, 'style.replyLength');
    else if (key === 'address') out.address = value === null ? null : requireString(value, 'style.address');
    else if (key === 'humor') out.humor = requireUnit(value, 'style.humor', 0.4);
    else if (key === 'questionTolerance') out.questionTolerance = requireUnit(value, 'style.questionTolerance', 0.4);
    else if (key === 'shareTolerance') out.shareTolerance = requireUnit(value, 'style.shareTolerance', 0.3);
    else throw new BrainError('INVALID_ARGUMENT', `style 含未知键：${key}`);
  }
  return out;
}

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   scopeId?: string,
 *   bindings?: { scope_id?: string, person_id?: string },
 * }} options
 */
export function createPersonModels(options) {
  const { db, queue, clock } = options;
  const scopeId = resolveScopeId(options);
  const tx = createTxApi(db);

  /**
   * 冷启动建一个用户：person_models + relationship_states（四维 0.1）+ proactive_policies。
   *
   * 三张表都用 `INSERT OR IGNORE`：重复调用幂等，且**不会覆盖**已经被关系事件
   * 推上去的值（这是「重复调用」与「重置关系」的分界线）。
   *
   * @param {{ personId?: string, displayName?: string, style?: Record<string, any>, scopeId?: string }} input
   * @returns {Promise<{ created: boolean, person: any, relationship: any, policy: any }>}
   */
  async function ensurePerson(input = /** @type {any} */ ({})) {
    assertScope(scopeId, input.scopeId, 'input.scopeId');
    const personId = requireString(input.personId ?? options.bindings?.person_id ?? DEFAULT_PERSON_ID, 'personId');
    const displayName = input.displayName === undefined || input.displayName === null ? null : String(input.displayName).slice(0, 120);
    const style = { ...DEFAULT_STYLE, ...normalizeStyle(input.style) };
    const stamp = clock.stamp();

    return queue.write(
      (txh) => {
        const before = txh.get('SELECT 1 AS ok FROM person_models WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
        txh.run(
          `INSERT OR IGNORE INTO person_models (
             scope_id, person_id, display_name, aliases_json, style_json, cold_start,
             person_model_version, created_at, created_at_local, updated_at, updated_at_local
           ) VALUES (?, ?, ?, '[]', ?, 1, 1, ?, ?, ?, ?)`,
          [scopeId, personId, displayName, stringifyJson(style, 'style'), stamp.utc, stamp.local, stamp.utc, stamp.local],
        );
        // 四维各 0.1：**不继承任何人的值**（方案 §7.2 冷启动纪律）
        txh.run(
          `INSERT OR IGNORE INTO relationship_states (
             scope_id, person_id, familiarity, trust, intimacy, rapport, basis_json, version,
             last_change_at, created_at, created_at_local, updated_at, updated_at_local
           ) VALUES (?, ?, 0.1, 0.1, 0.1, 0.1, '[]', 1, NULL, ?, ?, ?, ?)`,
          [scopeId, personId, stamp.utc, stamp.local, stamp.utc, stamp.local],
        );
        txh.run(
          `INSERT OR IGNORE INTO proactive_policies (
             scope_id, person_id, enabled, quiet_hours_json, daily_cap, cooldown_minutes,
             topic_cooldowns_json, max_pending, channels_json, policy_version,
             created_at, created_at_local, updated_at, updated_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
          [
            scopeId,
            personId,
            DEFAULT_POLICY.enabled,
            stringifyJson(DEFAULT_POLICY.quietHours, 'quietHours'),
            DEFAULT_POLICY.dailyCap,
            DEFAULT_POLICY.cooldownMinutes,
            stringifyJson(DEFAULT_POLICY.topicCooldowns, 'topicCooldowns'),
            DEFAULT_POLICY.maxPending,
            stringifyJson(DEFAULT_POLICY.channels, 'channels'),
            stamp.utc,
            stamp.local,
            stamp.utc,
            stamp.local,
          ],
        );
        const person = txh.get('SELECT * FROM person_models WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
        const relationship = txh.get('SELECT * FROM relationship_states WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
        const policy = txh.get('SELECT * FROM proactive_policies WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
        return {
          created: before === undefined,
          person: rowToPerson(/** @type {any} */ (person)),
          relationship: rowToRelationship(/** @type {any} */ (relationship)),
          policy: rowToPolicy(/** @type {any} */ (policy)),
        };
      },
      { label: 'persona.ensurePerson' },
    );
  }

  /**
   * 取用户。**查不到返回 null**（不造默认行——「这个用户还不存在」和
   * 「这个用户是冷启动」是两件事，前者该由 ensurePerson 显式建）。
   * @param {{ personId?: string, scopeId?: string }} [query]
   */
  function get(query = {}) {
    assertScope(scopeId, query.scopeId, 'query.scopeId');
    const personId = requireString(query.personId ?? options.bindings?.person_id ?? DEFAULT_PERSON_ID, 'personId');
    const row = tx.get('SELECT * FROM person_models WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
    return row === undefined ? null : rowToPerson(row);
  }

  /**
   * 列本 scope 的用户。
   * @param {{ limit?: number }} [query]
   */
  function list(query = {}) {
    const limit = clampInt(query.limit, 1, 500, 100, 'limit');
    const rows = tx.all('SELECT * FROM person_models WHERE scope_id = ? ORDER BY created_at ASC LIMIT ?', [scopeId, limit]);
    return { items: rows.map((row) => rowToPerson(row)), limit };
  }

  /**
   * 更新互动风格。**只要用户显式配置过，`cold_start` 就置 0**——
   * 之后的所有保守默认值都应当让位给这份配置。
   * @param {{ personId?: string, style: Record<string, any>, scopeId?: string }} input
   */
  async function updateStyle(input = /** @type {any} */ ({})) {
    assertScope(scopeId, input.scopeId, 'input.scopeId');
    const personId = requireString(input.personId ?? options.bindings?.person_id ?? DEFAULT_PERSON_ID, 'personId');
    const patch = normalizeStyle(input.style);
    if (Object.keys(patch).length === 0) throw new BrainError('INVALID_ARGUMENT', 'updateStyle 至少要给一个字段');
    return queue.write(
      (txh) => {
        const row = txh.get('SELECT * FROM person_models WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `用户不存在：${personId}（先 ensurePerson）`);
        const merged = { ...DEFAULT_STYLE, ...safeJsonObject(row.style_json), ...patch };
        const stamp = clock.stamp();
        txh.run(
          `UPDATE person_models
              SET style_json = ?, cold_start = 0, person_model_version = person_model_version + 1,
                  updated_at = ?, updated_at_local = ?
            WHERE scope_id = ? AND person_id = ?`,
          [stringifyJson(merged, 'style'), stamp.utc, stamp.local, scopeId, personId],
        );
        const after = txh.get('SELECT * FROM person_models WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
        return rowToPerson(/** @type {any} */ (after));
      },
      { label: 'persona.personModels.updateStyle' },
    );
  }

  /**
   * 取主动社交策略（没有行返回 null，由调用方决定用默认还是报错）。
   * @param {{ personId?: string }} [query]
   */
  function getPolicy(query = {}) {
    const personId = requireString(query.personId ?? options.bindings?.person_id ?? DEFAULT_PERSON_ID, 'personId');
    const row = tx.get('SELECT * FROM proactive_policies WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
    return row === undefined ? null : rowToPolicy(row);
  }

  /**
   * 改策略（主人/控制台动作）。改动 `policy_version` +1：
   * 每次候选仲裁都会记下当时的 policy_version，事后能回答「这条是按哪版策略批的」。
   * @param {{
   *   personId?: string,
   *   enabled?: boolean,
   *   quietHours?: Array<{ from: string, to: string }>,
   *   dailyCap?: number,
   *   cooldownMinutes?: number,
   *   topicCooldowns?: Record<string, number>,
   *   maxPending?: number,
   *   channels?: string[],
   * }} input
   */
  async function updatePolicy(input = /** @type {any} */ ({})) {
    const personId = requireString(input.personId ?? options.bindings?.person_id ?? DEFAULT_PERSON_ID, 'personId');
    return queue.write(
      (txh) => {
        const row = txh.get('SELECT * FROM proactive_policies WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `策略不存在：${personId}（先 ensurePerson）`);
        const current = rowToPolicy(/** @type {any} */ (row));
        /** @type {string[]} */
        const quietHours = input.quietHours === undefined ? current.quietHours : normalizeQuietHours(input.quietHours);
        const dailyCap = input.dailyCap === undefined ? current.dailyCap : clampInt(input.dailyCap, 0, 100, 2, 'dailyCap');
        const cooldownMinutes =
          input.cooldownMinutes === undefined ? current.cooldownMinutes : clampInt(input.cooldownMinutes, 0, 10080, 180, 'cooldownMinutes');
        const maxPending = input.maxPending === undefined ? current.maxPending : clampInt(input.maxPending, 0, 100, 1, 'maxPending');
        const topicCooldowns = input.topicCooldowns === undefined ? current.topicCooldowns : normalizeTopicCooldowns(input.topicCooldowns);
        const channels = input.channels === undefined ? current.channels : normalizeChannels(input.channels);
        const enabled = input.enabled === undefined ? current.enabled : input.enabled === true;
        const stamp = clock.stamp();
        txh.run(
          `UPDATE proactive_policies
              SET enabled = ?, quiet_hours_json = ?, daily_cap = ?, cooldown_minutes = ?,
                  topic_cooldowns_json = ?, max_pending = ?, channels_json = ?,
                  policy_version = policy_version + 1, updated_at = ?, updated_at_local = ?
            WHERE scope_id = ? AND person_id = ?`,
          [
            enabled ? 1 : 0,
            stringifyJson(quietHours, 'quietHours'),
            dailyCap,
            cooldownMinutes,
            stringifyJson(topicCooldowns, 'topicCooldowns'),
            maxPending,
            stringifyJson(channels, 'channels'),
            stamp.utc,
            stamp.local,
            scopeId,
            personId,
          ],
        );
        const after = txh.get('SELECT * FROM proactive_policies WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
        return rowToPolicy(/** @type {any} */ (after));
      },
      { label: 'persona.personModels.updatePolicy' },
    );
  }

  return { ensurePerson, get, list, updateStyle, getPolicy, updatePolicy, scopeId };
}

/**
 * 免打扰时段校验：`HH:mm`，允许跨午夜（from > to 表示跨天）。
 * @param {unknown} value
 * @returns {Array<{ from: string, to: string }>}
 */
export function normalizeQuietHours(value) {
  if (!Array.isArray(value)) throw new BrainError('INVALID_ARGUMENT', 'quietHours 必须是数组');
  const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new BrainError('INVALID_ARGUMENT', 'quietHours 项必须是 {from,to}');
    const from = requireString(/** @type {any} */ (entry).from, 'quietHours.from');
    const to = requireString(/** @type {any} */ (entry).to, 'quietHours.to');
    if (!HHMM.test(from) || !HHMM.test(to)) {
      throw new BrainError('INVALID_ARGUMENT', `quietHours 必须是 HH:mm（收到 ${from} → ${to}）`);
    }
    return { from, to };
  });
}

/**
 * @param {unknown} value
 * @returns {Record<string, number>}
 */
export function normalizeTopicCooldowns(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BrainError('INVALID_ARGUMENT', 'topicCooldowns 必须是对象（话题 → 分钟）');
  }
  /** @type {Record<string, number>} */
  const out = {};
  for (const [topic, minutes] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n < 0) throw new BrainError('INVALID_ARGUMENT', `topicCooldowns.${topic} 必须是非负数`);
    out[topic] = Math.floor(n);
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
export function normalizeChannels(value) {
  if (!Array.isArray(value)) throw new BrainError('INVALID_ARGUMENT', 'channels 必须是数组');
  return value.map((item) => requireEnum(item, ['console', 'im', 'other'], 'channels[]'));
}

/**
 * 新用户的一行摘要（面板/报告用）。`cold_start=true` 时必须显式提醒调用方：
 * 「这个人还没被配置过，一切按保守默认来」。
 * @param {{ person: any, relationship: any, policy: any }} bundle
 */
export function summarizePerson(bundle) {
  return {
    personId: bundle.person.personId,
    displayName: bundle.person.displayName,
    coldStart: bundle.person.coldStart,
    style: bundle.person.style,
    relationship: {
      familiarity: bundle.relationship.familiarity,
      trust: bundle.relationship.trust,
      intimacy: bundle.relationship.intimacy,
      rapport: bundle.relationship.rapport,
    },
    policy: {
      enabled: bundle.policy.enabled,
      dailyCap: bundle.policy.dailyCap,
      cooldownMinutes: bundle.policy.cooldownMinutes,
      maxPending: bundle.policy.maxPending,
      quietHours: bundle.policy.quietHours,
      channels: bundle.policy.channels,
    },
  };
}

/** 供测试/工具构造一个「没有 row」的空包。 */
export function emptyBundle(personId = DEFAULT_PERSON_ID) {
  return {
    person: { personId, displayName: null, coldStart: true, style: { ...DEFAULT_STYLE } },
    relationship: { familiarity: 0.1, trust: 0.1, intimacy: 0.1, rapport: 0.1 },
    policy: { ...DEFAULT_POLICY },
  };
}

