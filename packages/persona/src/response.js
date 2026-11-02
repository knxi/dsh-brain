// @ts-check
/**
 * `response` —— 回复 / 简短 / 延迟 / 拒绝 / 沉默 的五态仲裁与留痕（系统 4 下半 · 4）。
 *
 * ── 为什么沉默也要记一笔 ──
 *
 * 方案 §7.6：沉默是一种决策，不是「没发生」。没有 `response_decisions`，
 * 「这条消息为什么没回」就永远只能猜；而「没回」恰恰是最容易出事故的一类行为
 * （漏掉主人的任务、装没听见纠正、把授权请求当噪音）。
 *
 * ── 一条铁律：保护类输入禁止 silent ──
 *
 * `formal_task`（任务）/ `correction`（纠错）/ `forget`（遗忘）/ `permission`（授权）/
 * `stop`（停止）/ `commitment`（承诺）——这六类里任何一条被判成 `silent`，
 * 都等于「主人说了话，系统装没听见」。所以：
 *
 * 1. 判定逻辑给出 `silent` 时**强制改 `reply`**，`reason_category` 记
 *    `protected_input_forced_reply`，返回里 `forced:true`（默认行为：宁可多说一句）。
 * 2. 传 `strict:true` 时**直接抛错**（`PROTECTED_SILENT_FORBIDDEN`）——
 *    集成阶段用它来抓「谁把保护类输入判成了沉默」。
 * 3. 调用方显式要求 `silent` 也一样处理：**不存在绕过路径**。
 *
 * ── 不做的事 ──
 *
 * **不伪造「已读」，也不推测对方态度**（0008 的注释就是这条）。本模块只记
 * 「我这边打算怎么回、为什么」，不写任何「他看过了/他生气了」这类没有依据的判断。
 */

import { BrainError } from './core.js';
import {
  INPUT_KINDS,
  PROTECTED_KINDS,
  RESPONSE_DECISIONS,
  assertScope,
  clampInt,
  createTxApi,
  localOf,
  newId,
  optionalString,
  requireEnum,
  requireString,
  resolveScopeId,
  stringifyJson,
} from './util.js';

/** 保护类输入被强制改成 `reply` 时的原因类别。 */
export const REASON_PROTECTED_FORCED = 'protected_input_forced_reply';

/**
 * 从上下文里嗅「这是不是保护类输入」。
 *
 * **只用于把口径收紧**：识别到就按保护类处理（禁止沉默）；识别不到不会让任何东西
 * 变宽松。所以误判的代价是「多回一句」，而不是「漏掉一件任务」——这个不对称是故意的。
 *
 * @param {{ protectedKind?: string | null, inputKind?: string, context?: Record<string, any> }} input
 * @returns {string | null}
 */
export function inferProtectedKind(input) {
  const explicit = optionalString(input.protectedKind, 'protectedKind');
  if (explicit !== null) {
    return requireEnum(explicit, PROTECTED_KINDS, 'protectedKind');
  }
  if (input.inputKind !== undefined && input.inputKind !== 'owner_message') return null;
  const context = input.context ?? {};
  const flags = Array.isArray(context.flags) ? context.flags.map((flag) => String(flag)) : [];
  for (const kind of PROTECTED_KINDS) {
    if (flags.includes(kind)) return kind;
  }
  const text = typeof context.text === 'string' ? context.text : '';
  if (text.length === 0) return null;
  /** @type {Array<[string, RegExp]>} */
  const patterns = [
    ['forget', /(忘掉|遗忘|别记|删掉这条|删除记忆)/],
    ['stop', /(停下|停止|别做了|别再做了|别继续|取消掉|不要继续)/],
    ['permission', /(权限|授权|允许我|放权)/],
    ['correction', /(你错了|纠错|说错了|这里不对|不对，|更正|纠正)/],
    ['commitment', /(答应我|承诺|说好了|记得.{0,6}(要|去|帮我))/],
    ['formal_task', /(任务|帮我(做|改|写|查|跑|整理)|实现|修复|跑一遍)/],
  ];
  for (const [kind, pattern] of patterns) {
    if (pattern.test(text)) return kind;
  }
  return null;
}

/**
 * 五态仲裁门面。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string, epoch_ms?: number }, timeZone?: string },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   workspace?: any,
 *   scopeId?: string,
 *   bindings?: { scope_id?: string, person_id?: string },
 *   strictProtected?: boolean,
 * }} options
 */
export function createResponse(options) {
  const { db, queue, clock } = options;
  const scopeId = resolveScopeId(options);
  const tx = createTxApi(db);
  const timeZone = clock.timeZone ?? 'Asia/Shanghai';
  const strictDefault = options.strictProtected === true;

  /** @param {unknown} value */
  function resolveNowMs(value) {
    if (value === undefined || value === null || value === '') return clock.stamp().epoch_ms ?? Date.now();
    const ms = Date.parse(String(value));
    if (!Number.isFinite(ms)) throw new BrainError('INVALID_ARGUMENT', `now 不是合法时间：${String(value)}`);
    return ms;
  }

  /**
   * 判定五态。
   *
   * 口径（简单、可测，不追求「像人」）：
   * - `owner_message`：默认 `reply`；风格是短回复或 `context.brief` → `brief_reply`。
   *   **主人说话不允许 silent/decline**（保护类在这里是绝对项，非保护类也不该装死）。
   * - `social_input`：忙/免打扰 → `delay`；被明确拒绝过 → `decline`；否则 `brief_reply`。
   * - `system_event` / `maintenance`：`silent`（噪音不进对话）。
   *
   * @param {{
   *   personId?: string,
   *   sessionId?: string | null,
   *   inputKind?: string,
   *   protectedKind?: string | null,
   *   decision?: string,
   *   reasonCategory?: string | null,
   *   notes?: string | null,
   *   now?: number | string | Date,
   *   strict?: boolean,
   *   context?: {
   *     text?: string,
   *     flags?: string[],
   *     busy?: boolean,
   *     brief?: boolean,
   *     localHour?: number,
   *     replyLength?: string,
   *     declinedRecently?: boolean,
   *     policyVersion?: number,
   *   },
   *   scopeId?: string,
   * }} [input]
   */
  async function decide(input = /** @type {any} */ ({})) {
    assertScope(scopeId, input.scopeId, 'input.scopeId');
    const inputKind = requireEnum(input.inputKind ?? 'owner_message', INPUT_KINDS, 'inputKind', { fallback: 'owner_message' });
    const sessionId = optionalString(input.sessionId, 'sessionId');
    const personId = optionalString(input.personId, 'personId');
    const context = input.context ?? {};
    const protectedKind = inferProtectedKind({ protectedKind: input.protectedKind, inputKind, context });
    if (protectedKind !== null && inputKind !== 'owner_message') {
      throw new BrainError(
        'INVALID_ARGUMENT',
        `protectedKind=${protectedKind} 只对 owner_message 有意义（收到 inputKind=${inputKind}）`,
      );
    }
    const nowMs = resolveNowMs(input.now);
    const atIso = new Date(nowMs).toISOString();

    /** @type {string} */
    let decision;
    if (input.decision !== undefined && input.decision !== null) {
      decision = requireEnum(input.decision, RESPONSE_DECISIONS, 'decision');
    } else {
      decision = arbitrateDecision({ inputKind, context });
    }

    let forced = false;
    let reasonCategory = optionalString(input.reasonCategory ?? null, 'reasonCategory');
    if (protectedKind !== null && decision === 'silent') {
      const strict = input.strict === undefined ? strictDefault : input.strict === true;
      if (strict) {
        throw new BrainError('INVALID_ARGUMENT', `保护类输入禁止 silent（protectedKind=${protectedKind}）`, {
          details: { code: 'PROTECTED_SILENT_FORBIDDEN', protectedKind, inputKind, personId },
        });
      }
      decision = 'reply';
      forced = true;
      reasonCategory = REASON_PROTECTED_FORCED;
    }
    if (reasonCategory === null) reasonCategory = defaultReasonOf(decision, inputKind, { protectedKind, context });

    const policyVersion = clampInt(context.policyVersion, 0, Number.MAX_SAFE_INTEGER, readPolicyVersion(personId), 'policyVersion');

    /** @type {Record<string, any>} */
    const notes = {
      decidedBy: 'persona.response',
      ...(forced ? { originalDecision: 'silent', protectedKind } : {}),
      ...(input.notes === undefined || input.notes === null ? {} : { note: String(input.notes).slice(0, 400) }),
    };

    const id = newId('rsp');
    const stamp = clock.stamp();
    await queue.write(
      (txh) => {
        txh.run(
          `INSERT INTO response_decisions (
             id, scope_id, person_id, session_id, at, at_local, at_ms, decision, input_kind,
             reason_category, protected_kind, policy_version, notes, created_at, created_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id,
            scopeId,
            personId,
            sessionId,
            atIso,
            localOf(atIso, timeZone),
            nowMs,
            decision,
            inputKind,
            reasonCategory,
            protectedKind,
            policyVersion,
            stringifyJson(notes, 'notes'),
            stamp.utc,
            stamp.local,
          ],
        );
      },
      { label: 'persona.response.decide' },
    );

    return {
      id,
      personId,
      sessionId,
      decision,
      inputKind,
      protectedKind,
      forced,
      reasonCategory,
      policyVersion,
      at: atIso,
      localDay: stamp.local.slice(0, 10),
      timeZone,
    };
  }

  /**
   * 纯决策函数（不写库，方便单测/复算）。
   * @param {{ inputKind: string, context: Record<string, any> }} input
   * @returns {string}
   */
  function arbitrateDecision(input) {
    const { inputKind, context } = input;
    if (inputKind === 'system_event' || inputKind === 'maintenance') return 'silent';
    if (inputKind === 'social_input') {
      if (context.declinedRecently === true) return 'decline';
      const hour = Number.isFinite(context.localHour) ? Number(context.localHour) : null;
      const quiet = hour !== null && hour >= 0 && hour < 6;
      if (context.busy === true || quiet) return 'delay';
      return 'brief_reply';
    }
    // owner_message：主人说的话默认必须回
    if (context.brief === true || context.replyLength === 'short') return 'brief_reply';
    return 'reply';
  }

  /**
   * @param {string | null} personId
   * @returns {number}
   */
  function readPolicyVersion(personId) {
    if (!personId) return 0;
    const row = tx.get('SELECT policy_version FROM proactive_policies WHERE scope_id = ? AND person_id = ?', [scopeId, personId]);
    return row?.policy_version == null ? 0 : Number(row.policy_version);
  }

  /**
   * 列决策记录（控制台用）。`days` 按**本地自然日**回溯。
   * @param {{ days?: number, personId?: string, decision?: string, inputKind?: string, limit?: number }} [query]
   */
  function listDecisions(query = {}) {
    const days = clampInt(query.days, 1, 365, 7, 'days');
    const limit = clampInt(query.limit, 1, 1000, 200, 'limit');
    const sinceMs = (clock.stamp().epoch_ms ?? Date.now()) - days * 24 * 3600_000;
    /** @type {any[]} */
    const params = [scopeId, sinceMs];
    /** @type {string[]} */
    const where = ['scope_id = ?', 'at_ms >= ?'];
    if (query.personId) {
      where.push('person_id = ?');
      params.push(requireString(query.personId, 'personId'));
    }
    if (query.decision) {
      where.push('decision = ?');
      params.push(requireEnum(query.decision, RESPONSE_DECISIONS, 'decision'));
    }
    if (query.inputKind) {
      where.push('input_kind = ?');
      params.push(requireEnum(query.inputKind, INPUT_KINDS, 'inputKind'));
    }
    params.push(limit);
    const rows = tx.all(`SELECT * FROM response_decisions WHERE ${where.join(' AND ')} ORDER BY at_ms DESC, id DESC LIMIT ?`, params);
    return { days, limit, items: rows.map((row) => rowToDecision(row)) };
  }

  /**
   * 按决策分布统计（面板/日报用）。
   * @param {{ days?: number }} [query]
   */
  function stats(query = {}) {
    const days = clampInt(query.days, 1, 365, 7, 'days');
    const sinceMs = (clock.stamp().epoch_ms ?? Date.now()) - days * 24 * 3600_000;
    const rows = tx.all(
      `SELECT decision, COUNT(*) AS n FROM response_decisions
        WHERE scope_id = ? AND at_ms >= ? GROUP BY decision`,
      [scopeId, sinceMs],
    );
    /** @type {Record<string, number>} */
    const byDecision = {};
    for (const decision of RESPONSE_DECISIONS) byDecision[decision] = 0;
    for (const row of rows) byDecision[String(row.decision)] = Number(row.n);
    const silentProtected = tx.get(
      `SELECT COUNT(*) AS n FROM response_decisions
        WHERE scope_id = ? AND at_ms >= ? AND decision = 'silent' AND protected_kind IS NOT NULL`,
      [scopeId, sinceMs],
    );
    return {
      days,
      byDecision,
      total: Object.values(byDecision).reduce((sum, value) => sum + value, 0),
      /** 保护类输入被 silent 的条数：**必须恒为 0**，不为 0 就是 bug（测试钉住）。 */
      protectedSilent: Number(silentProtected?.n ?? 0),
    };
  }

  return { decide, arbitrateDecision, listDecisions, stats, inferProtectedKind, scopeId };
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
export function rowToDecision(row) {
  /** @type {Record<string, any>} */
  let notes = {};
  try {
    const parsed = JSON.parse(String(row.notes ?? '{}'));
    notes = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    notes = {};
  }
  return {
    id: String(row.id),
    personId: row.person_id == null ? null : String(row.person_id),
    sessionId: row.session_id == null ? null : String(row.session_id),
    at: String(row.at),
    atMs: Number(row.at_ms),
    decision: String(row.decision),
    inputKind: String(row.input_kind),
    reasonCategory: row.reason_category == null ? null : String(row.reason_category),
    protectedKind: row.protected_kind == null ? null : String(row.protected_kind),
    policyVersion: row.policy_version == null ? null : Number(row.policy_version),
    notes,
  };
}

/**
 * 默认原因类别（没显式给时）。
 * @param {string} decision
 * @param {string} inputKind
 * @param {{ protectedKind: string | null, context: Record<string, any> }} meta
 * @returns {string}
 */
function defaultReasonOf(decision, inputKind, meta) {
  if (decision === 'reply') return meta.protectedKind ? 'protected_input_required_reply' : 'answered';
  if (decision === 'brief_reply') return inputKind === 'social_input' ? 'social_short_ack' : 'brief_by_style';
  if (decision === 'delay') return 'busy_or_quiet_hours';
  if (decision === 'decline') return 'social_declined';
  return inputKind === 'owner_message' ? 'owner_message_silent' : 'not_a_conversation_input';
}

/**
 * 判定一条记录是否违规（控制台自检用）：保护类输入落成 silent。
 * @param {{ decision: string, protectedKind?: string | null }} item
 * @returns {boolean}
 */
export function isProtectedSilentViolation(item) {
  return item.decision === 'silent' && item.protectedKind !== null && item.protectedKind !== undefined;
}
