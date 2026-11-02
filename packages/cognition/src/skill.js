// @ts-check
/**
 * `skill` —— 技能校准（小脑）。
 *
 * ── 它做什么 ──
 *
 * 把「工具 + 动作」的真实执行结果聚合成一个**可比较的置信度**：
 * 这个技能在我手里到底靠不靠谱。并从这个过程里提炼可复用的教训（skill_lessons）。
 *
 * ── 为什么用威尔逊下界，不用「成功率」 ──
 *
 * 成功率在样本少时会骗人：1 次成功 = 100% 成功率，看起来比 20 次成功 18 次的工具
 * 更可靠，实际上后者才是有统计支撑的。威尔逊下界把「样本量」算进去：
 * 样本越少，下界离 1 越远；随着尝试增多，下界收敛到真实成功率。
 * 这正是技能置信度需要的性质——**小样本不给高置信度**。
 *
 *   下界 = (p̂ + z²/2n − z·√(p̂(1−p̂)/n + z²/4n²)) / (1 + z²/n)
 *   p̂ = successes / attempts，z = 1.96（95% 双侧）
 *
 * 实算（测试里写死这几个数）：1/1 → 0.2065；5/5 → 0.5655；0/1 → 0；8/10 → 0.4902。
 *
 * ── 沙箱拒绝为什么不算「技能失败」 ──
 *
 * 工具被沙箱挡下来（EPERM/EACCES/EROFS）时，失败的位置不在技能本身，而在环境权限：
 * 同一段命令在放行后会跑得很好。如果把它记成 failures，`listWeakSkills` 就会
 * 在每次权限收紧后把一批本来好用的技能标成「弱」——那是**用环境噪声污染技能记忆**。
 * 所以这类错误只增加尝试次数（置信度按统计自然下降），不增加失败计数、
 * 不打断连续成功记录，并且在 lesson 里归成 `precondition`（「需要放行」是前置条件，
 * 不是失败原因）。
 *
 * ── 刻意不做 ──
 *
 * 不自动改写技能步骤（0008 文件头第 10 条）：自动改写的步骤一旦错一次会一直错下去，
 * 而那正是最难发现的一类错误。这里只做**计数与置信度**。
 */

import { BrainError } from '@dsh-brain/core';
import {
  clamp01,
  clampInt,
  createReader,
  newId,
  normalizeStringArray,
  parseObjectJson,
  requireText,
  resolveScopeId,
  stringifyJson,
} from './internal.js';

/** 威尔逊下界的 z 值：95% 双侧置信。 */
export const WILSON_Z = 1.96;
/** 低于这个置信度算「弱技能」。 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;
/**
 * 置信度判断的最少样本数。
 *
 * 为什么需要它：威尔逊下界在小样本时天然很低（1 次成功 = 0.2065），
 * 如果直接拿「confidence < 0.5」当弱技能，那么**每个刚出现的技能都会被标成弱**——
 * 那是「未知」不是「弱」。样本 <3 次时只靠「连续失败」这一条判断。
 */
export const MIN_ATTEMPTS_FOR_CONFIDENCE = 3;
/** 连续失败到这个数就列入弱技能（哪怕历史成功率还行——它正在坏）。 */
export const CONSECUTIVE_FAILURE_THRESHOLD = 3;
export const DEFAULT_WEAK_LIMIT = 20;
export const MAX_WEAK_LIMIT = 200;
export const DEFAULT_LESSON_LIMIT = 50;
export const MAX_LESSON_LIMIT = 200;
export const MAX_SKILL_KEY_LENGTH = 120;
export const MAX_TOOL_LENGTH = 80;
export const MAX_ACTION_LENGTH = 80;
export const MAX_ERROR_CODE_LENGTH = 64;

/**
 * 沙箱/权限类错误码：**环境问题，不是技能问题**。
 * 用集合 + 前缀匹配两条路：真实工具可能给 `EPERM`，也可能给 `SANDBOX_EPERM`。
 */
export const SANDBOX_ERROR_CODES = Object.freeze(['EPERM', 'EACCES', 'EROFS', 'EZFS', 'SANDBOX_DENIED']);
/** 瞬态故障：值得重试，但这次尝试确实失败了。 */
export const TRANSIENT_ERROR_CODES = Object.freeze([
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAGAIN',
  'EBUSY',
  'EPIPE',
  'EAI_AGAIN',
  'RATE_LIMITED',
  'RATE_LIMIT',
]);

/**
 * 教训文案。**固定文案 + 错误码**，不把工具返回的动态消息写进 text：
 * 那会让同一类错误每次都变成一个新行（UNIQUE 形同虚设），表的体积远大于信息量。
 */
const LESSON_TEXT = Object.freeze({
  sandbox: '需要沙箱/权限放行：环境限制挡住了执行，不是技能本身失败',
  transient: '瞬态故障（超时/连接/限流）：可以重试，不代表技能不可靠',
  failure: '技能执行失败：同类错误反复出现时，先检查前置条件或步骤',
  unknown: '未知错误：需要人工看一眼原始返回',
});

/**
 * 威尔逊下界（成功率的下置信界）。
 *
 * @param {number} successes 成功次数
 * @param {number} attempts 尝试次数（含被环境挡下来的）
 * @param {number} [z]
 * @returns {number} 0..1
 */
export function wilsonLowerBound(successes, attempts, z = WILSON_Z) {
  const n = Math.max(0, Math.floor(Number.isFinite(attempts) ? attempts : 0));
  const s = Math.max(0, Math.min(n, Math.floor(Number.isFinite(successes) ? successes : 0)));
  if (n === 0) return 0;
  const p = s / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.round(clamp01((center - margin) / denominator) * 1e4) / 1e4;
}

/**
 * 错误归类。返回 `sandbox | transient | failure | unknown`。
 * @param {unknown} errorCode
 * @returns {'sandbox' | 'transient' | 'failure' | 'unknown'}
 */
export function classifyError(errorCode) {
  if (errorCode === undefined || errorCode === null || errorCode === '') return 'unknown';
  const code = String(errorCode).trim().toUpperCase();
  if (code.length === 0) return 'unknown';
  if (SANDBOX_ERROR_CODES.includes(code) || /SANDBOX|EPERM|EACCES|EROFS|PERMISSION_DENIED/.test(code)) {
    return 'sandbox';
  }
  if (TRANSIENT_ERROR_CODES.includes(code) || /TIMEOUT|ECONN|EAGAIN|EBUSY|RATE_?LIMIT|THROTTL/.test(code)) {
    return 'transient';
  }
  return 'failure';
}

/**
 * 技能键：`<tool>` 或 `<tool>:<action>`（与 0008 注释一致）。
 * @param {{ tool?: string | null, action?: string | null, skillKey?: string | null }} input
 * @returns {string}
 */
export function skillKeyOf(input) {
  if (typeof input.skillKey === 'string' && input.skillKey.trim().length > 0) {
    return requireText(input.skillKey, 'skillKey', { maxLength: MAX_SKILL_KEY_LENGTH });
  }
  const tool = requireText(input.tool, 'tool', { maxLength: MAX_TOOL_LENGTH });
  const action = input.action === undefined || input.action === null || input.action === ''
    ? null
    : requireText(input.action, 'action', { maxLength: MAX_ACTION_LENGTH });
  return action === null ? tool : `${tool}:${action}`;
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
function rowToSkill(row) {
  const notes = parseObjectJson(row.notes);
  return {
    id: String(row.id),
    scopeId: String(row.scope_id),
    skillKey: String(row.skill_key),
    tool: row.tool == null ? null : String(row.tool),
    action: row.action == null ? null : String(row.action),
    attempts: Number(row.attempts ?? 0),
    successes: Number(row.successes ?? 0),
    failures: Number(row.failures ?? 0),
    consecutiveFailures: Number(row.consecutive_failures ?? 0),
    confidence: Number(row.confidence ?? 0),
    lastSuccessAt: row.last_success_at == null ? null : String(row.last_success_at),
    lastFailureAt: row.last_failure_at == null ? null : String(row.last_failure_at),
    lastErrorCode: row.last_error_code == null ? null : String(row.last_error_code),
    sandboxBlocks: Number(notes.sandboxBlocks ?? 0),
    lastErrorClass: notes.lastErrorClass == null ? null : String(notes.lastErrorClass),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
function rowToLesson(row) {
  return {
    id: String(row.id),
    scopeId: String(row.scope_id),
    skillKey: String(row.skill_key),
    kind: String(row.kind),
    text: String(row.text),
    evidence: normalizeStringArray(parseJsonSafeArray(row.evidence_json), 'evidence'),
    confidence: Number(row.confidence ?? 0.5),
    occurrences: Number(row.occurrences ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * @param {unknown} text
 * @returns {unknown[]}
 */
function parseJsonSafeArray(text) {
  if (Array.isArray(text)) return text;
  if (text === null || text === undefined || text === '') return [];
  try {
    const parsed = JSON.parse(String(text));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 造技能校准模块。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   workspace?: any,
 *   bindings?: { scope_id?: string, person_id?: string } | null,
 * }} options
 */
export function createSkill(options) {
  const { db, queue, clock } = options;
  const bindings = options.bindings ?? null;
  const reader = createReader(db);

  /**
   * 记一次执行结果。
   *
   * @param {{
   *   skillKey?: string,
   *   tool?: string,
   *   action?: string | null,
   *   ok: boolean,
   *   errorCode?: string | null,
   *   durationMs?: number | null,
   *   evidence?: string[],
   *   scopeId?: string,
   * }} input
   * @returns {Promise<any>}
   */
  async function recordResult(input = /** @type {any} */ ({})) {
    if (typeof input.ok !== 'boolean') {
      throw new BrainError('INVALID_ARGUMENT', 'ok 必填且必须是布尔（成功/失败不能靠猜）');
    }
    const skillKey = skillKeyOf(input);
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const ok = input.ok;
    const errorCode = input.errorCode === undefined || input.errorCode === null || input.errorCode === ''
      ? null
      : requireText(input.errorCode, 'errorCode', { maxLength: MAX_ERROR_CODE_LENGTH });
    if (ok && errorCode !== null) {
      throw new BrainError('INVALID_ARGUMENT', 'ok=true 时不应带 errorCode（成功和失败不能同时成立）');
    }
    const durationMs = input.durationMs === undefined || input.durationMs === null
      ? null
      : Math.max(0, Math.floor(Number(input.durationMs)));
    if (durationMs !== null && !Number.isFinite(durationMs)) {
      throw new BrainError('INVALID_ARGUMENT', `durationMs 必须是有限数（收到 ${String(input.durationMs)}）`);
    }
    const evidence = normalizeStringArray(input.evidence, 'evidence');
    const errorClass = ok ? null : classifyError(errorCode);
    const tool = input.tool === undefined || input.tool === null ? null : requireText(input.tool, 'tool', { maxLength: MAX_TOOL_LENGTH });
    const action = input.action === undefined || input.action === null || input.action === ''
      ? null
      : requireText(input.action, 'action', { maxLength: MAX_ACTION_LENGTH });

    return queue.write(
      (tx) => {
        const existing = tx.get('SELECT * FROM skill_stats WHERE scope_id = ? AND skill_key = ?', [scopeId, skillKey]);
        const before = existing === undefined
          ? { attempts: 0, successes: 0, failures: 0, consecutive_failures: 0, last_success_at: null, notes: null }
          : {
              attempts: Number(existing.attempts ?? 0),
              successes: Number(existing.successes ?? 0),
              failures: Number(existing.failures ?? 0),
              consecutive_failures: Number(existing.consecutive_failures ?? 0),
              last_success_at: existing.last_success_at ?? null,
              notes: existing.notes ?? null,
            };

        const attempts = before.attempts + 1;
        const successes = before.successes + (ok ? 1 : 0);
        // 沙箱拒绝不记 failures：失败的位置在环境权限，不在技能本身（见文件头）。
        const failures = before.failures + (ok || errorClass === 'sandbox' ? 0 : 1);
        const consecutiveFailures = ok
          ? 0
          : errorClass === 'sandbox'
            ? before.consecutive_failures // 环境拒绝不打断也不累计「连续失败」
            : before.consecutive_failures + 1;
        const confidence = wilsonLowerBound(successes, attempts);

        const notes = parseObjectJson(before.notes);
        if (errorClass === 'sandbox') {
          notes.sandboxBlocks = Number(notes.sandboxBlocks ?? 0) + 1;
        }
        if (errorClass !== null) {
          notes.lastErrorClass = errorClass;
          notes.lastErrorCode = errorCode;
        }
        const stamp = clock.stamp();
        const id = existing === undefined ? newId('skl') : String(existing.id);
        const lastSuccessAt = ok ? stamp.utc : before.last_success_at;
        const lastFailureAt = !ok && errorClass !== 'sandbox' ? stamp.utc : null;

        tx.run(
          `INSERT INTO skill_stats (
             id, scope_id, skill_key, tool, action, attempts, successes, failures,
             consecutive_failures, confidence, last_success_at, last_failure_at, last_error_code,
             notes, created_at, created_at_local, updated_at, updated_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(scope_id, skill_key) DO UPDATE SET
             tool = COALESCE(excluded.tool, skill_stats.tool),
             action = COALESCE(excluded.action, skill_stats.action),
             attempts = excluded.attempts,
             successes = excluded.successes,
             failures = excluded.failures,
             consecutive_failures = excluded.consecutive_failures,
             confidence = excluded.confidence,
             last_success_at = COALESCE(excluded.last_success_at, skill_stats.last_success_at),
             last_failure_at = COALESCE(excluded.last_failure_at, skill_stats.last_failure_at),
             last_error_code = COALESCE(excluded.last_error_code, skill_stats.last_error_code),
             notes = excluded.notes,
             updated_at = excluded.updated_at,
             updated_at_local = excluded.updated_at_local`,
          [
            id,
            scopeId,
            skillKey,
            tool ?? (existing === undefined ? null : existing.tool),
            action ?? (existing === undefined ? null : existing.action),
            attempts,
            successes,
            failures,
            consecutiveFailures,
            confidence,
            lastSuccessAt,
            lastFailureAt,
            errorCode,
            stringifyJson(notes, 'notes'),
            stamp.utc,
            stamp.local,
            stamp.utc,
            stamp.local,
          ],
        );

        /** @type {any | null} */
        let lesson = null;
        if (!ok) {
          // 沙箱拒绝归 precondition（需要放行），其余归 failure_reason（技能/步骤问题）。
          const kind = errorClass === 'sandbox' ? 'precondition' : 'failure_reason';
          const text = `${errorCode ?? 'UNKNOWN'}：${LESSON_TEXT[errorClass ?? 'unknown']}`;
          // 幂等靠 UNIQUE(scope_id, skill_key, kind, text)：同一原因只累加 occurrences，
          // 不新增行。这是 0008 显式设计的口径，也避免「同一错误每天一条新记录」。
          tx.run(
            `INSERT INTO skill_lessons (
               id, scope_id, skill_key, kind, text, evidence_json, confidence, occurrences,
               created_at, created_at_local, updated_at, updated_at_local
             ) VALUES (?, ?, ?, ?, ?, ?, 0.5, 1, ?, ?, ?, ?)
             ON CONFLICT(scope_id, skill_key, kind, text) DO UPDATE SET
               occurrences = skill_lessons.occurrences + 1,
               confidence = MIN(0.9, skill_lessons.confidence + 0.05),
               evidence_json = excluded.evidence_json,
               updated_at = excluded.updated_at,
               updated_at_local = excluded.updated_at_local`,
            [
              newId('sln'),
              scopeId,
              skillKey,
              kind,
              text,
              stringifyJson(evidence, 'evidence'),
              stamp.utc,
              stamp.local,
              stamp.utc,
              stamp.local,
            ],
          );
          const rowAfter = tx.get(
            'SELECT id, occurrences FROM skill_lessons WHERE scope_id = ? AND skill_key = ? AND kind = ? AND text = ?',
            [scopeId, skillKey, kind, text],
          );
          lesson = {
            id: rowAfter === undefined ? null : String(rowAfter.id),
            kind,
            text,
            occurrences: rowAfter === undefined ? 1 : Number(rowAfter.occurrences),
            created: rowAfter !== undefined && Number(rowAfter.occurrences) === 1,
          };
        }

        return {
          skillKey,
          scopeId,
          ok,
          errorClass,
          attempts,
          successes,
          failures,
          consecutiveFailures,
          confidence,
          sandboxDenied: errorClass === 'sandbox',
          lesson,
          durationMs,
        };
      },
      { label: 'skill.recordResult' },
    );
  }

  /**
   * 读一项技能（可选带上它的教训）。
   * @param {string} skillKey
   * @param {{ scopeId?: string, withLessons?: boolean }} [opts]
   * @returns {any | null}
   */
  function getSkill(skillKey, opts = {}) {
    const key = requireText(skillKey, 'skillKey', { maxLength: MAX_SKILL_KEY_LENGTH });
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const row = reader.get('SELECT * FROM skill_stats WHERE scope_id = ? AND skill_key = ?', [scopeId, key]);
    if (row === undefined) return null;
    const skill = rowToSkill(row);
    if (opts.withLessons === true) skill.lessons = listLessons({ skillKey: key, scopeId }).items;
    return skill;
  }

  /**
   * 弱技能清单：置信度低，或正在连续失败。
   *
   * 为什么要两个条件：置信度是「历史总体表现」，连续失败是「现在正在坏」。
   * 一个历史成功率 90% 的技能连挂 3 次，比一个置信度 0.4 但稳定的技能更该先看。
   * @param {{ limit?: number, scopeId?: string }} [query]
   * @returns {{ items: any[], limit: number }}
   */
  function listWeakSkills(query = {}) {
    const scopeId = resolveScopeId(query.scopeId, bindings);
    const limit = clampInt(query.limit, 1, MAX_WEAK_LIMIT, DEFAULT_WEAK_LIMIT, 'limit');
    const rows = reader.all(
      `SELECT * FROM skill_stats
        WHERE scope_id = ?
          AND ((attempts >= ? AND confidence < ?) OR consecutive_failures >= ?)
        ORDER BY consecutive_failures DESC, confidence ASC, updated_at DESC
        LIMIT ?`,
      [scopeId, MIN_ATTEMPTS_FOR_CONFIDENCE, LOW_CONFIDENCE_THRESHOLD, CONSECUTIVE_FAILURE_THRESHOLD, limit],
    );
    return {
      items: rows.map((row) => {
        const skill = rowToSkill(row);
        /** @type {string[]} */
        const reasons = [];
        if (skill.attempts >= MIN_ATTEMPTS_FOR_CONFIDENCE && skill.confidence < LOW_CONFIDENCE_THRESHOLD) {
          reasons.push('低置信度');
        }
        if (skill.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) reasons.push('连续失败');
        return { ...skill, reasons };
      }),
      limit,
    };
  }

  /**
   * 列教训。
   * @param {{ skillKey?: string, kind?: string, limit?: number, scopeId?: string }} [query]
   * @returns {{ items: any[], limit: number }}
   */
  function listLessons(query = {}) {
    const scopeId = resolveScopeId(query.scopeId, bindings);
    const limit = clampInt(query.limit, 1, MAX_LESSON_LIMIT, DEFAULT_LESSON_LIMIT, 'limit');
    const where = ['scope_id = ?'];
    /** @type {any[]} */
    const params = [scopeId];
    if (query.skillKey !== undefined && query.skillKey !== null && query.skillKey !== '') {
      where.push('skill_key = ?');
      params.push(requireText(query.skillKey, 'skillKey', { maxLength: MAX_SKILL_KEY_LENGTH }));
    }
    if (query.kind !== undefined && query.kind !== null && query.kind !== '') {
      where.push('kind = ?');
      params.push(String(query.kind));
    }
    params.push(limit);
    const rows = reader.all(
      `SELECT * FROM skill_lessons WHERE ${where.join(' AND ')}
        ORDER BY occurrences DESC, updated_at DESC LIMIT ?`,
      params,
    );
    return { items: rows.map(rowToLesson), limit };
  }

  /**
   * 统计（面板用）。
   * @param {{ scopeId?: string }} [opts]
   * @returns {{ skills: number, weak: number, lessons: number }}
   */
  function stats(opts = {}) {
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    return {
      skills: reader.count('SELECT COUNT(*) AS n FROM skill_stats WHERE scope_id = ?', [scopeId]),
      weak: reader.count(
        `SELECT COUNT(*) AS n FROM skill_stats WHERE scope_id = ?
          AND ((attempts >= ? AND confidence < ?) OR consecutive_failures >= ?)`,
        [scopeId, MIN_ATTEMPTS_FOR_CONFIDENCE, LOW_CONFIDENCE_THRESHOLD, CONSECUTIVE_FAILURE_THRESHOLD],
      ),
      lessons: reader.count('SELECT COUNT(*) AS n FROM skill_lessons WHERE scope_id = ?', [scopeId]),
    };
  }

  return {
    recordResult,
    getSkill,
    listWeakSkills,
    listLessons,
    stats,
    wilsonLowerBound,
    classifyError,
    skillKeyOf,
    WILSON_Z,
    LOW_CONFIDENCE_THRESHOLD,
    MIN_ATTEMPTS_FOR_CONFIDENCE,
    CONSECUTIVE_FAILURE_THRESHOLD,
  };
}
