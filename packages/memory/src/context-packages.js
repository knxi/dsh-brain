// @ts-check
/**
 * `contextPackages` 门面 —— 构包的三级证据链（built → attached → sent）与预算明细。
 *
 * 存在理由（M2 验收项）：
 * - 「检索结果**必有预算说明**」：`budget.brainAllowance` / `budget.dropped[]`（哪些段被丢、为什么）
 *   必须有地方落地，否则控制台只能说「本次未记录预算明细」；
 * - 「`built → attached → sent` **三级证据链完整可查**」：carrier 与 sent 判据结论要能查。
 *
 * 两条硬纪律：
 * 1. **状态只能单向推进**：`built → attached → sent`。跳级（built→sent）与回退（sent→attached）
 *    一律拒绝并给出规则名（`no_skip` / `no_regression`），与 context2 的状态机口径一致。
 *    「不许从 built 直接跳 sent」是契约 §6 的原话，不是我的偏好。
 * 2. **首次证据时间不刷**：`attached_at` / `sent_at` 用 COALESCE 只写一次。重复 mark 是幂等的，
 *    不能把「第一次证明挂上了」的时间改成后来那次——那会把证据链的时间线抹掉。
 *
 * 刻意**不存** `injectedText` 全文（见 0003 迁移头部取舍说明）：只存指纹，检查器用 segments 还原。
 */

import { BrainError, contentHash, formatLocalIso } from '@dsh-brain/core';
import { createTxApi } from './write-queue.js';
import { META_KEYS, readMetaInt } from './meta.js';
import { clampInt, normalizeInstant, requireEnum, requireString } from './memory-util.js';

/** 0001 的 context_packages.status CHECK 允许值。 */
export const PACKAGE_STATUSES = Object.freeze(['built', 'attached', 'sent', 'discarded', 'expired']);

/**
 * sent/attached 判据里的**承载形态**。三项各自对应一种真实观测位置，不是同义词：
 *
 * - `system`                 —— 请求对象的 `options.system`（system prompt 走独立字段，
 *                               标题旁路实测就是这个形态，CONTRACTS §10.9）。
 * - `messages[role=system]`  —— system prompt 物化进 `messages` 数组时的形态（主请求实测
 *                               是 `systemLen=0` + `carriedIn=messages[role=system]`）。
 * - `messages[user]`         —— Brain 的注入通道（`systemPrompt.context()` /
 *                               `assembly.contexts` / `agent/pre-step`）实测**物化成 user
 *                               角色消息**（docs/M0-probe-report.md §2 Q2），
 *                               连接器在 `llm/stream` 观测到的命中位置就是这里。
 *
 * 为什么必须区分：把「user 消息里的注入」记成 `messages[role=system]` 等于在检查器里
 * 显示一个从未发生的位置，证据链就假了。carrier 必须是**实际观测到的那个**。
 */
export const CARRIERS = Object.freeze(['system', 'messages[role=system]', 'messages[user]']);

/** 检索质量强度（context2 在包 diagnostics 里给，落库供控制台做徽章/筛选）。 */
export const EVIDENCE_STRENGTHS = Object.freeze(['primary', 'ngram_fallback', 'unknown']);

/**
 * 允许的状态推进。`discarded` / `expired` 是终态。
 * @type {Record<string, readonly string[]>}
 */
const ALLOWED_TRANSITIONS = Object.freeze({
  built: ['attached'],
  attached: ['sent'],
  sent: [],
  discarded: [],
  expired: [],
});

/**
 * 判定被拒的推进属于哪条规则（错误里要带规则名，调用方才能区别对待）。
 * @param {string} from
 * @param {string} to
 * @returns {'no_skip'|'no_regression'|'terminal'}
 */
export function transitionRule(from, to) {
  const order = ['built', 'attached', 'sent'];
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(to);
  if (fromIndex >= 0 && toIndex >= 0) {
    // 从 built 直接去 sent 是「跳级」；往回走是「回退」
    return toIndex > fromIndex + 1 ? 'no_skip' : 'no_regression';
  }
  // 终态（discarded / expired）不该再推进
  return 'terminal';
}

/**
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string }, timeZone: string },
 *   bindings?: { scope_id?: string, person_id?: string },
 * }} options
 */
export function createContextPackages(options) {
  const { db, queue, clock } = options;
  const defaultScopeId = options.bindings?.scope_id ?? null;
  const defaultPersonId = options.bindings?.person_id ?? null;
  const tx = createTxApi(db);

  /**
   * 取当前删除纪元。构包记录落库时记下，供后续核对「这个包是不是在删除之后建的」。
   * @param {any} txh
   * @returns {number}
   */
  function currentEpoch(txh) {
    return readMetaInt(txh, META_KEYS.deletionEpoch, 0);
  }

  /**
   * @param {unknown} value
   * @param {string} field
   * @returns {string|null}
   */
  function serializeNullable(value, field) {
    if (value === undefined || value === null) return null;
    try {
      return JSON.stringify(value);
    } catch {
      throw new BrainError('INVALID_ARGUMENT', `${field} 不能序列化成 JSON`);
    }
  }

  /**
   * @param {unknown} text
   * @returns {string|null}
   */
  function parseNullableJson(text) {
    if (text === null || text === undefined) return null;
    try {
      return JSON.parse(String(text));
    } catch {
      return null; // 存量脏数据不该让整条查询炸
    }
  }

  /**
   * 写入一个构包（幂等：同 contextId 只留第一条，不刷首次时间）。
   * @param {Record<string, any>} pkg
   * @returns {Promise<{ id: string, created: boolean, status: string }>}
   */
  async function save(pkg) {
    if (!pkg || typeof pkg !== 'object') {
      throw new BrainError('INVALID_ARGUMENT', 'contextPackages.save 需要 ContextPackage 对象');
    }
    const contextId = requireString(pkg.contextId, 'contextId');
    const scopeId = requireString(pkg.scopeId ?? defaultScopeId, 'scopeId');
    const policyVersion = requireString(pkg.policyVersion, 'policyVersion');
    // payload_hash 是 sent 判据的基础，缺了就没法证明「这段内容进过请求」。
    // 不在这里重算：canonicalize 是 @dsh-brain/context 的职责，memory 不越界实现第二套。
    const payloadHash = requireString(pkg.canonicalHash, 'canonicalHash');
    const builtAt = normalizeInstant(pkg.builtAt, 'builtAt') ?? clock.stamp().utc;
    const status = requireEnum(pkg.status ?? 'built', PACKAGE_STATUSES, 'status');
    if (status !== 'built') {
      throw new BrainError(
        'INVALID_ARGUMENT',
        `构包只能以 status='built' 出生（收到 ${status}）：attached/sent 必须由观测证据推进，不能自称`,
      );
    }

    const segments = Array.isArray(pkg.segments) ? pkg.segments : [];
    const memoryVersions = segments
      .filter((segment) => segment && typeof segment === 'object' && segment.memoryId !== undefined)
      .map((segment) => ({ memoryId: String(segment.memoryId), version: Number(segment.version ?? 1) }));
    const estimatedTokens =
      pkg.estimatedTokens === undefined || pkg.estimatedTokens === null
        ? null
        : clampInt(pkg.estimatedTokens, 0, Number.MAX_SAFE_INTEGER, 0, 'estimatedTokens');
    const diagnostics = pkg.diagnostics && typeof pkg.diagnostics === 'object' ? pkg.diagnostics : null;
    const evidenceStrength = requireEnum(
      diagnostics?.evidenceStrength ?? pkg.evidenceStrength,
      EVIDENCE_STRENGTHS,
      'diagnostics.evidenceStrength',
      { fallback: 'unknown' },
    );
    const injectedTextHash =
      typeof pkg.injectedText === 'string' && pkg.injectedText.length > 0 ? contentHash(pkg.injectedText) : null;

    return queue.write(
      (txh) => {
        const existing = txh.get('SELECT context_id, status FROM context_packages WHERE context_id = ?', [contextId]);
        if (existing !== undefined) {
          // 幂等：不覆盖内容、不刷 built_at/created_at、不改状态。
          // context2 也是「先 get 再 save」，但那只是同进程兜底；真正的幂等由这里扛。
          return { id: String(existing.context_id), created: false, status: String(existing.status) };
        }
        const stamp = clock.stamp();
        txh.run(
          `INSERT INTO context_packages (
             context_id, scope_id, person_id, session_id, turn_id, step_id,
             policy_version, tokenizer_id, estimated_tokens, memory_versions,
             deletion_epoch, payload_hash, status,
             built_at, built_at_local, created_at, created_at_local,
             budget_json, carrier, sent_evidence_json, evidence_strength,
             segments_json, diagnostics_json, injected_text_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'built', ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
          [
            contextId,
            scopeId,
            pkg.personId ?? defaultPersonId,
            pkg.sessionId ?? null,
            pkg.turnId ?? null,
            pkg.stepId ?? null,
            policyVersion,
            pkg.tokenizerId ?? null,
            estimatedTokens,
            JSON.stringify(memoryVersions),
            currentEpoch(txh),
            payloadHash,
            builtAt,
            formatLocalIso(new Date(builtAt), clock.timeZone),
            stamp.utc,
            stamp.local,
            serializeNullable(pkg.budget, 'budget'),
            evidenceStrength,
            serializeNullable(segments, 'segments'),
            serializeNullable(diagnostics, 'diagnostics'),
            injectedTextHash,
          ],
        );
        return { id: contextId, created: true, status: 'built' };
      },
      { label: 'contextPackages.save' },
    );
  }

  /**
   * 推进状态（只允许 built → attached → sent）。
   *
   * `evidence` 形如 `{ attached: {...}, sent: {...} }`，会合并进 `sent_evidence_json`。
   * `carrier` 一旦设定就锁定：换个承载体意味着证据对不上，必须拒绝。
   *
   * **scope 收口**（CONTRACTS §16）：写路径同样收口——跨 scope 的 contextId 与
   * 「不存在」同形，一律 `NOT_FOUND`（沿用本函数既有的错误码与文案，不加新分支）。
   * 否则别人猜到一个 id 就能改你的「sent 证据」，把观察期数据搞脏。
   *
   * @param {string} contextId
   * @param {{ status: string, carrier?: string|null, evidence?: Record<string, unknown>|null }} input
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {Promise<{ id: string, status: string, previousStatus: string, idempotent: boolean }>}
   */
  async function updateStatus(contextId, input, opts = {}) {
    requireString(contextId, 'contextId');
    if (!input || typeof input !== 'object') {
      throw new BrainError('INVALID_ARGUMENT', 'contextPackages.updateStatus 需要 { status, carrier?, evidence? }');
    }
    const target = requireEnum(input.status, PACKAGE_STATUSES, 'status');
    const carrier = input.carrier === undefined || input.carrier === null ? null : requireEnum(input.carrier, CARRIERS, 'carrier');
    const scopeId = opts.allowCrossScope === true ? null : requireString(opts.scopeId ?? defaultScopeId, 'scopeId');

    return queue.write(
      (txh) => {
        const row = txh.get(
          'SELECT * FROM context_packages WHERE context_id = ? AND (? IS NULL OR scope_id = ?)',
          [contextId, scopeId, scopeId],
        );
        // 跨 scope 与「真不存在」同形：都不确认存在性
        if (row === undefined) {
          throw new BrainError('NOT_FOUND', `构包记录不存在：${contextId}`);
        }
        const current = String(row.status);
        const existingCarrier = row.carrier === null || row.carrier === undefined ? null : String(row.carrier);
        // carrier 锁定检查**必须在幂等分支之前**：同状态重复 mark 时若换了承载体，
        // 那不是「幂等」，是「拿另一份证据去覆盖已记录的证据」——必须报错。
        // 早期版本把这段放在幂等 return 之后，同状态换 carrier 会被静默吞掉（单测抓到）。
        if (existingCarrier !== null && carrier !== null && existingCarrier !== carrier) {
          throw new BrainError(
            'INVALID_ARGUMENT',
            `构包承载形态已锁定为 ${existingCarrier}，不许改成 ${carrier}（carrier_locked：换了承载体，sent 证据就对不上了）`,
            { details: { contextId, rule: 'carrier_locked', lockedCarrier: existingCarrier, incomingCarrier: carrier } },
          );
        }
        if (current === target) {
          // 幂等：同一状态重复 mark 不报错、不刷时间。
          return { id: contextId, status: current, previousStatus: current, idempotent: true };
        }
        const allowed = ALLOWED_TRANSITIONS[current] ?? [];
        if (!allowed.includes(target)) {
          const rule = transitionRule(current, target);
          throw new BrainError(
            'INVALID_ARGUMENT',
            `构包状态不许从 ${current} 推进到 ${target}（规则 ${rule}）：` +
              '只允许 built → attached → sent，跳级与回退都会被拒',
            { details: { contextId, from: current, to: target, rule, allowed } },
          );
        }

        const nextCarrier = existingCarrier ?? carrier;

        const stamp = clock.stamp();
        const mergedEvidence = (() => {
          const previous = parseNullableJson(row.sent_evidence_json);
          const base = previous && typeof previous === 'object' ? { ...previous } : {};
          if (input.evidence && typeof input.evidence === 'object') {
            for (const [key, value] of Object.entries(input.evidence)) base[key] = value;
          }
          return Object.keys(base).length ? JSON.stringify(base) : null;
        })();

        txh.run(
          `UPDATE context_packages
              SET status = ?,
                  carrier = COALESCE(carrier, ?),
                  sent_evidence_json = COALESCE(?, sent_evidence_json),
                  attached_at = CASE WHEN ? = 'attached' THEN COALESCE(attached_at, ?) ELSE attached_at END,
                  attached_at_local = CASE WHEN ? = 'attached' THEN COALESCE(attached_at_local, ?) ELSE attached_at_local END,
                  sent_at = CASE WHEN ? = 'sent' THEN COALESCE(sent_at, ?) ELSE sent_at END,
                  sent_at_local = CASE WHEN ? = 'sent' THEN COALESCE(sent_at_local, ?) ELSE sent_at_local END
            WHERE context_id = ?`,
          [
            target,
            nextCarrier,
            mergedEvidence,
            target,
            stamp.utc,
            target,
            stamp.local,
            target,
            stamp.utc,
            target,
            stamp.local,
            contextId,
          ],
        );
        return { id: contextId, status: target, previousStatus: current, idempotent: false };
      },
      { label: 'contextPackages.updateStatus' },
    );
  }

  /**
   * @param {Record<string, unknown>} row
   * @returns {Record<string, unknown>}
   */
  function toPackage(row) {
    const attachedAt = row.attached_at == null ? null : String(row.attached_at);
    const sentAt = row.sent_at == null ? null : String(row.sent_at);
    return {
      id: String(row.context_id),
      scopeId: String(row.scope_id),
      personId: row.person_id == null ? null : String(row.person_id),
      sessionId: row.session_id == null ? null : String(row.session_id),
      turnId: row.turn_id == null ? null : String(row.turn_id),
      stepId: row.step_id == null ? null : String(row.step_id),
      policyVersion: String(row.policy_version),
      tokenizerId: row.tokenizer_id == null ? null : String(row.tokenizer_id),
      estimatedTokens: row.estimated_tokens == null ? null : Number(row.estimated_tokens),
      memoryVersions: parseNullableJson(row.memory_versions) ?? [],
      deletionEpoch: Number(row.deletion_epoch ?? 0),
      payloadHash: String(row.payload_hash),
      status: String(row.status),
      builtAt: String(row.built_at),
      attachedAt,
      sentAt,
      carrier: row.carrier == null ? null : String(row.carrier),
      evidenceStrength: row.evidence_strength == null ? null : String(row.evidence_strength),
      budget: parseNullableJson(row.budget_json),
      segments: parseNullableJson(row.segments_json) ?? [],
      diagnostics: parseNullableJson(row.diagnostics_json),
      sentEvidence: parseNullableJson(row.sent_evidence_json),
      injectedTextHash: row.injected_text_hash == null ? null : String(row.injected_text_hash),
      expiresAt: row.expires_at == null ? null : String(row.expires_at),
    };
  }

  /**
   * 读一条构包。
   *
   * **scope 收口**（CONTRACTS §16）：`segments` / `diagnostics` / `payloadHash` 里
   * 可能带注入文本和记忆正文片段，跨 scope 必须与「不存在」同形——返回 `null`。
   * 与 `memories.get` / `summaries.get` 同一口径（默认按绑定 scope，显式声明才切上下文，
   * `allowCrossScope` 只给进程内维护路径）。
   *
   * @param {string} contextId
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {Record<string, unknown> | null}
   */
  function get(contextId, opts = {}) {
    requireString(contextId, 'contextId');
    const scopeId = opts.allowCrossScope === true ? null : requireString(opts.scopeId ?? defaultScopeId, 'scopeId');
    const row = tx.get(
      'SELECT * FROM context_packages WHERE context_id = ? AND (? IS NULL OR scope_id = ?)',
      [contextId, scopeId, scopeId],
    );
    return row === undefined ? null : toPackage(/** @type {Record<string, unknown>} */ (row));
  }

  /**
   * 按会话/轮次列构包（控制台的「上下文检查器」用）。
   *
   * 游标是 `(built_at, context_id)` 键集，不用 offset（避免深翻页漂移）。
   *
   * **scope 收口**（CONTRACTS §16）：默认只列 caller scope，不给 `scopeId` 不等于
   * 「列全库」。维护脚本要跨库看，显式 `allowCrossScope: true`。
   *
   * @param {{
   *   sessionId?: string, turnId?: string, stepId?: string, scopeId?: string,
   *   allowCrossScope?: boolean,
   *   status?: string, limit?: number, cursor?: string|null,
   * }} [query]
   * @returns {{ items: Record<string, unknown>[], nextCursor: string|null }}
   */
  function list(query = {}) {
    const limit = clampInt(query.limit, 1, 200, 20, 'limit');
    /** @type {string[]} */
    const where = [];
    /** @type {unknown[]} */
    const params = [];
    const scopeId = query.allowCrossScope === true ? null : requireString(query.scopeId ?? defaultScopeId, 'scopeId');
    if (scopeId !== null) {
      where.push('scope_id = ?');
      params.push(scopeId);
    }
    if (query.sessionId !== undefined && query.sessionId !== null) {
      where.push('session_id = ?');
      params.push(requireString(query.sessionId, 'sessionId'));
    }
    if (query.turnId !== undefined && query.turnId !== null) {
      where.push('turn_id = ?');
      params.push(requireString(query.turnId, 'turnId'));
    }
    if (query.stepId !== undefined && query.stepId !== null) {
      where.push('step_id = ?');
      params.push(requireString(query.stepId, 'stepId'));
    }
    if (query.status !== undefined && query.status !== null && query.status !== 'all') {
      where.push('status = ?');
      params.push(requireEnum(query.status, PACKAGE_STATUSES, 'status'));
    }
    if (query.cursor !== undefined && query.cursor !== null && query.cursor !== '') {
      const cursor = decodeCursor(query.cursor);
      where.push('(built_at < ? OR (built_at = ? AND context_id < ?))');
      params.push(cursor.builtAt, cursor.builtAt, cursor.id);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = tx.all(
      `SELECT * FROM context_packages ${clause} ORDER BY built_at DESC, context_id DESC LIMIT ?`,
      [...params, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    return {
      items: page.map((row) => toPackage(/** @type {Record<string, unknown>} */ (row))),
      nextCursor: hasMore && last ? encodeCursor(String(last.built_at), String(last.context_id)) : null,
    };
  }

  return { save, updateStatus, get, list };
}

/**
 * @param {string} builtAt
 * @param {string} id
 * @returns {string}
 */
function encodeCursor(builtAt, id) {
  return Buffer.from(JSON.stringify({ b: builtAt, i: id }), 'utf8').toString('base64url');
}

/**
 * @param {string} cursor
 * @returns {{ builtAt: string, id: string }}
 */
function decodeCursor(cursor) {
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    if (typeof parsed?.b !== 'string' || typeof parsed?.i !== 'string') throw new Error('bad shape');
    return { builtAt: parsed.b, id: parsed.i };
  } catch {
    throw new BrainError('INVALID_ARGUMENT', `list 的 cursor 非法：${String(cursor).slice(0, 40)}`);
  }
}
