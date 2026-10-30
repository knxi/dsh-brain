// @ts-check
/**
 * `immune` —— 安全隔离（免疫系统）。
 *
 * ── 它防什么 ──
 *
 * 一段从外面进来的文字（网页、工具输出、别人转来的消息、导入的记忆）可能在试图
 * 改变「谁说了算」：假装是主人授权、假装是 system 指令、把凭据塞进记忆、
 * 用聊天模板标记伪装工具边界。一旦这种内容进了上下文，后面所有推理都建在它上面。
 * 这里就是那道「先隔离、再让人看」的闸门。
 *
 * ── 三条纪律 ──
 *
 * 1. **扫描不改 memories**。这是本模块最重要的边界：命中之后记忆**仍然在表里**，
 *    只是多了一条 `immune_quarantine`。要不要把某条记忆排除出检索，是检索侧
 *    用 `isQuarantined()` 自己决定的事——隔离区不能偷偷删数据，也不能替检索做决定。
 *    （0008 文件头也明确：不给 memories 加 'quarantined' 状态。）
 * 2. **隔离区自己不成为新的泄露面**：`excerpt` 最多 500 字，`detail_json` 只存
 *    规则 id 与文本长度/哈希，**不存全文**；purge 时把 excerpt 一并清空。
 * 3. **幂等靠 UNIQUE(scope_id, dedupe_key)**：同一对象 + 同一原因 + 同一段文本
 *    只挂一条；重复 scan 返回既有 id（`duplicated: true`），不重复污染列表。
 *
 * ── 为什么 severity 是常量表 ──
 *
 * 安全阈值必须可审。写死在判断树里的 severity 谁也不敢改，改一次也说不清影响范围；
 * 常量表让「什么算 high」成为一次可讨论、可回滚的改动。
 */

import { BrainError } from '@dsh-brain/core';
import {
  clampInt,
  createReader,
  hashKey,
  newId,
  parseObjectJson,
  requireRow,
  requireText,
  resolveScopeId,
  stringifyJson,
  truncate,
} from './internal.js';

/** `immune_quarantine.reason_code` 的枚举（与 0008 的 CHECK 一致）。 */
export const IMMUNE_REASON_CODES = Object.freeze([
  'prompt_injection',
  'memory_poison',
  'anomalous_tool_output',
  'forged_owner',
  'credential_leak',
  'other',
]);

/**
 * 原因 → 默认严重度（规则可以覆盖，取所有命中的最高值）。
 *
 * 为什么这样分：
 * - `prompt_injection` high：直接试图改写指令层级。它一旦进了上下文，
 *   后面每一步判断都可能被它牵着走——这是最彻底的失控路径。
 * - `forged_owner` high：冒充主人授权。主人授权是我们最高等级的信任来源，
 *   伪造它等于直接攻击权限模型。
 * - `credential_leak` high：凭据进记忆是**不可逆**的（备份、导出、历史版本都在）。
 * - `memory_poison` medium：投毒影响长期判断，但通常需要多步才生效，且有版本链可追。
 * - `anomalous_tool_output` medium：多数是格式噪声，隔离观察即可；
 *   但聊天模板标记（[INST] 等）本身常是注入载体，所以不给 low。
 */
export const REASON_SEVERITY = Object.freeze({
  prompt_injection: 'high',
  forged_owner: 'high',
  credential_leak: 'high',
  memory_poison: 'medium',
  anomalous_tool_output: 'medium',
  other: 'low',
});

/** severity 排序权重（取最高用）。 */
const SEVERITY_ORDER = Object.freeze({ low: 1, medium: 2, high: 3 });

/** 隔离摘录上限：与 0008 表注释一致（<=500 字）。 */
export const MAX_EXCERPT_LENGTH = 500;
/** 单次扫描的文本上限：再长的输入截断扫描（不因为一次超大输入把 CPU 打满）。 */
export const MAX_SCAN_CHARS = 64 * 1024;
/** 长 base64 判定阈值：256 字符以上且是单行（正常文本不会长这样）。 */
export const LONG_BASE64_MIN = 256;
export const DEFAULT_QUARANTINE_LIMIT = 50;
export const MAX_QUARANTINE_LIMIT = 200;

/**
 * 凭据上下文词：长 hex 只有出现在「像配置」的上下文里才算泄露。
 *
 * 为什么要这个 guard：40/64 位十六进制串在正常数据里到处都是（sha1/sha256 摘要、
 * content_hash、git commit id）。没有上下文就报，隔离区会被正常哈希灌满，
 * 真正的泄露反而被淹掉。sk- / JWT 这类有强特征前缀的规则不需要 guard。
 */
const CREDENTIAL_CONTEXT = /(token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|credential|密钥|令牌|口令|凭据|密码)/i;

/**
 * 规则表。顺序即「同严重度时的优先顺序」。
 *
 * 每条规则：`{ id, reasonCode, severity, pattern, guard? }`
 * - `pattern` 不带 g 标志（只用 `.exec()` 取第一次命中位置，避免 lastIndex 状态）。
 * - `guard(text)` 返回 false 时该规则不命中（用于降低误报）。
 */
export const IMMUNE_RULES = Object.freeze([
  // ── 提示注入：试图改写「谁说了算」 ──────────────────────────
  {
    id: 'inject.ignore_previous',
    reasonCode: 'prompt_injection',
    severity: 'high',
    pattern: /(忽略|忽视|无视|忘记|不要管|别再管|抛开)(掉)?(以上|上面|之前|前面|先前|所有|全部)?(的)?(所有)?(指令|要求|规则|提示词|提示|设定|约束|限制)/,
  },
  {
    id: 'inject.ignore_previous_en',
    reasonCode: 'prompt_injection',
    severity: 'high',
    pattern: /ignore\s+(all\s+)?(of\s+)?(the\s+)?(previous|above|prior|earlier|preceding)\s+(instructions?|prompts?|rules?|messages?|directions?)/i,
  },
  {
    id: 'inject.you_are_now',
    reasonCode: 'prompt_injection',
    severity: 'high',
    // 只认「你现在是 + 角色词」：单纯「你现在是」后面跟正常内容（「你现在是在忙吗」）不报。
    pattern: /你现在是(?!在|不是|怎么|干嘛|干什么)[^\n。！？?]{1,30}(助手|角色|人格|模式|管理员|system|模型|AI|人工智能)/i,
  },
  {
    id: 'inject.role_prefix',
    reasonCode: 'prompt_injection',
    severity: 'high',
    pattern: /(^|\n)\s*(system|assistant|developer|系统|指令)\s*[:：]/i,
  },
  {
    id: 'inject.override_rules',
    reasonCode: 'prompt_injection',
    severity: 'high',
    pattern: /(不要|别|不用)(再)?(遵守|遵循|受限于?|按照)(之前|以上|上面|原来)?(的)?(规则|限制|约束|设定)/,
  },

  // ── 伪造 owner / 伪造授权 ────────────────────────────────
  {
    id: 'forged.owner_says',
    reasonCode: 'forged_owner',
    severity: 'high',
    pattern: /主人(说|讲|让|允许|同意|批准|授权)(你)?(可以|能|不用|不必|无需|随便|直接)/,
  },
  {
    id: 'forged.authorized',
    reasonCode: 'forged_owner',
    severity: 'high',
    pattern: /(已(经)?(被)?授权|获得(了)?授权|已获批准|已获授权|已被允许)/,
  },
  {
    id: 'forged.no_need_to_ask',
    reasonCode: 'forged_owner',
    severity: 'high',
    pattern: /(不用|无需|不必|不需要)(再)?(问|确认|请示|告诉|汇报|审核|批准)/,
  },
  {
    id: 'forged.owner_identity',
    reasonCode: 'forged_owner',
    severity: 'high',
    pattern: /(我就是?(你的)?主人|我是主人|以主人(身份|名义))/,
  },
  {
    id: 'forged.admin_prefix',
    reasonCode: 'forged_owner',
    severity: 'high',
    pattern: /(^|\n)\s*(owner|admin|root)\s*[:：]/i,
  },

  // ── 凭据泄露 ─────────────────────────────────────────────
  {
    id: 'cred.sk_prefix',
    reasonCode: 'credential_leak',
    severity: 'high',
    pattern: /sk-[A-Za-z0-9_-]{16,}/,
  },
  {
    id: 'cred.github_token',
    reasonCode: 'credential_leak',
    severity: 'high',
    pattern: /(ghp|gho|ghu|ghs|ghr|github_pat|glpat)[-_]?[A-Za-z0-9_]{16,}/,
  },
  {
    id: 'cred.aws_key',
    reasonCode: 'credential_leak',
    severity: 'high',
    pattern: /AKIA[0-9A-Z]{16}/,
  },
  {
    id: 'cred.jwt',
    reasonCode: 'credential_leak',
    severity: 'high',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/,
  },
  {
    id: 'cred.key_value',
    reasonCode: 'credential_leak',
    severity: 'high',
    pattern: /(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
  },
  {
    id: 'cred.hex_token',
    reasonCode: 'credential_leak',
    severity: 'medium',
    pattern: /\b[0-9a-fA-F]{40,}\b/,
    guard: (text) => CREDENTIAL_CONTEXT.test(text),
  },

  // ── 异常工具输出 ─────────────────────────────────────────
  {
    id: 'tool.chat_template',
    reasonCode: 'anomalous_tool_output',
    severity: 'medium',
    pattern: /\[INST\]|\[\/INST\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>|<\|endoftext\|>/i,
  },
  {
    id: 'tool.long_base64',
    reasonCode: 'anomalous_tool_output',
    severity: 'medium',
    pattern: new RegExp(`(?:^|\\n)[A-Za-z0-9+/]{${LONG_BASE64_MIN},}={0,2}(?:\\n|$)`),
  },
  {
    id: 'tool.control_noise',
    reasonCode: 'anomalous_tool_output',
    severity: 'low',
    pattern: /[\u0000-\u0008\u000b\u000c\u000e-\u001f]{8,}/,
  },
]);

/**
 * 纯函数：在文本里跑一遍规则，返回命中清单（不写库、不改任何状态）。
 *
 * 返回值只含**规则 id、原因、严重度、位置与长度**，不回传命中片段：
 * 隔离区之外的地方不该再复述那段可疑文本。
 *
 * @param {unknown} text
 * @returns {{ matches: Array<{ ruleId: string, reasonCode: string, severity: string, index: number, length: number }>, truncated: boolean, textLength: number }}
 */
export function detectSecurityIssues(text) {
  const source = text === undefined || text === null ? '' : String(text);
  const truncated = source.length > MAX_SCAN_CHARS;
  const scan = truncated ? source.slice(0, MAX_SCAN_CHARS) : source;
  /** @type {Array<{ ruleId: string, reasonCode: string, severity: string, index: number, length: number }>} */
  const matches = [];
  for (const rule of IMMUNE_RULES) {
    if (typeof rule.guard === 'function' && rule.guard(scan) !== true) continue;
    const found = rule.pattern.exec(scan);
    if (found === null) continue;
    matches.push({
      ruleId: rule.id,
      reasonCode: rule.reasonCode,
      severity: rule.severity,
      index: found.index,
      length: found[0].length,
    });
  }
  return { matches, truncated, textLength: source.length };
}

/**
 * 从命中清单里取最高严重度与主原因（同严重度取先命中）。
 * @param {Array<{ reasonCode: string, severity: string }>} matches
 * @returns {{ reasonCode: string | null, severity: string | null }}
 */
export function topMatch(matches) {
  if (matches.length === 0) return { reasonCode: null, severity: null };
  /** @type {{ reasonCode: string, severity: string }} */
  let best = matches[0];
  for (const match of matches) {
    if ((SEVERITY_ORDER[match.severity] ?? 0) > (SEVERITY_ORDER[best.severity] ?? 0)) best = match;
  }
  return { reasonCode: best.reasonCode, severity: best.severity };
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
function rowToQuarantine(row) {
  return {
    id: String(row.id),
    scopeId: String(row.scope_id),
    at: String(row.at),
    reasonCode: String(row.reason_code),
    severity: String(row.severity),
    subjectTable: row.subject_table == null ? null : String(row.subject_table),
    subjectId: row.subject_id == null ? null : String(row.subject_id),
    sourceType: row.source_type == null ? null : String(row.source_type),
    sourceRef: row.source_ref == null ? null : String(row.source_ref),
    excerpt: row.excerpt == null ? null : String(row.excerpt),
    detail: parseObjectJson(row.detail_json),
    status: String(row.status),
    reviewedAt: row.reviewed_at == null ? null : String(row.reviewed_at),
    reviewedBy: row.reviewed_by == null ? null : String(row.reviewed_by),
    notes: row.notes == null ? null : String(row.notes),
  };
}

/**
 * 造免疫模块。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string, epoch_ms: number } },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   workspace?: any,
 *   bindings?: { scope_id?: string, person_id?: string } | null,
 * }} options
 */
export function createImmune(options) {
  const { db, queue, clock } = options;
  const bindings = options.bindings ?? null;
  const alert = options.alert ?? null;
  const reader = createReader(db);

  /**
   * 扫描一段内容。
   *
   * **不改 memories**：命中只写 immune_quarantine。是否把某条记忆排除出检索，
   * 由检索侧调 `isQuarantined()` 决定（隔离与检索策略分开，才能各自回滚）。
   *
   * @param {{
   *   text: string,
   *   sourceType?: string | null,
   *   sourceRef?: string | null,
   *   subjectTable?: string | null,
   *   subjectId?: string | null,
   *   scopeId?: string,
   * }} input
   * @returns {Promise<{ quarantined: boolean, reasonCode: string | null, severity: string | null, matches: any[], quarantineId: string | null, duplicated: boolean, truncated: boolean }>}
   */
  async function scan(input = /** @type {any} */ ({})) {
    const text = typeof input.text === 'string' ? input.text : '';
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const sourceType = input.sourceType === undefined || input.sourceType === null || input.sourceType === ''
      ? null
      : requireText(input.sourceType, 'sourceType', { maxLength: 64 });
    const sourceRef = input.sourceRef === undefined || input.sourceRef === null || input.sourceRef === ''
      ? null
      : requireText(input.sourceRef, 'sourceRef', { maxLength: 200 });
    const subjectTable = input.subjectTable === undefined || input.subjectTable === null || input.subjectTable === ''
      ? null
      : requireText(input.subjectTable, 'subjectTable', { maxLength: 64 });
    const subjectId = input.subjectId === undefined || input.subjectId === null || input.subjectId === ''
      ? null
      : requireText(input.subjectId, 'subjectId', { maxLength: 120 });

    const detected = detectSecurityIssues(text);
    if (detected.matches.length === 0) {
      return {
        quarantined: false,
        reasonCode: null,
        severity: null,
        matches: [],
        quarantineId: null,
        duplicated: false,
        truncated: detected.truncated,
      };
    }

    const top = topMatch(detected.matches);
    const subjectKey = subjectTable !== null && subjectId !== null
      ? `${subjectTable}:${subjectId}`
      : sourceType !== null && sourceRef !== null
        ? `${sourceType}:${sourceRef}`
        : 'inline';
    // dedupe：同一对象 + 同一原因 + 同一段文本只挂一条（UNIQUE(scope_id, dedupe_key) 兜底）。
    const dedupeKey = hashKey('imm', [String(top.reasonCode), subjectKey, hashKey('txt', [text])]);
    const excerpt = truncate(text, MAX_EXCERPT_LENGTH);
    const detail = {
      ruleIds: detected.matches.map((match) => match.ruleId),
      positions: detected.matches.map((match) => ({ index: match.index, length: match.length })),
      textLength: detected.textLength,
      truncated: detected.truncated,
      subjectKey,
    };

    const result = await queue.write(
      (tx) => {
        const existing = tx.get(
          'SELECT id, status FROM immune_quarantine WHERE scope_id = ? AND dedupe_key = ?',
          [scopeId, dedupeKey],
        );
        if (existing !== undefined) {
          return { id: String(existing.id), duplicated: true, status: String(existing.status) };
        }
        const stamp = clock.stamp();
        const id = newId('qrn');
        tx.run(
          `INSERT INTO immune_quarantine (
             id, scope_id, at, at_local, at_ms, reason_code, severity,
             subject_table, subject_id, source_type, source_ref, excerpt, detail_json,
             status, dedupe_key
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'quarantined', ?)`,
          [
            id,
            scopeId,
            stamp.utc,
            stamp.local,
            stamp.epoch_ms ?? Date.parse(stamp.utc),
            String(top.reasonCode),
            String(top.severity),
            subjectTable,
            subjectId,
            sourceType,
            sourceRef,
            excerpt,
            stringifyJson(detail, 'detail'),
            dedupeKey,
          ],
        );
        return { id, duplicated: false, status: 'quarantined' };
      },
      { label: 'immune.scan' },
    );

    return {
      quarantined: true,
      reasonCode: top.reasonCode,
      severity: top.severity,
      matches: detected.matches,
      quarantineId: result.id,
      duplicated: result.duplicated,
      truncated: detected.truncated,
    };
  }

  /**
   * 查询某个对象当前是否在隔离中（**给检索侧用的**）。
   * 只认 status='quarantined'：released 是「已核验放行」，purged 是「内容已销毁」。
   * @param {{ subjectTable: string, subjectId: string, scopeId?: string }} input
   * @returns {{ quarantined: boolean, id: string | null, reasonCode: string | null, severity: string | null, status: string | null }}
   */
  function isQuarantined(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const subjectTable = requireText(input.subjectTable, 'subjectTable', { maxLength: 64 });
    const subjectId = requireText(input.subjectId, 'subjectId', { maxLength: 120 });
    const row = reader.get(
      `SELECT id, reason_code, severity, status FROM immune_quarantine
        WHERE scope_id = ? AND subject_table = ? AND subject_id = ? AND status = 'quarantined'
        ORDER BY at_ms DESC, id DESC LIMIT 1`,
      [scopeId, subjectTable, subjectId],
    );
    if (row === undefined) {
      return { quarantined: false, id: null, reasonCode: null, severity: null, status: null };
    }
    return {
      quarantined: true,
      id: String(row.id),
      reasonCode: String(row.reason_code),
      severity: String(row.severity),
      status: String(row.status),
    };
  }

  /**
   * 列隔离条目（默认只看隔离中的）。
   * @param {{ status?: string, reasonCode?: string, limit?: number, scopeId?: string }} [query]
   * @returns {{ items: any[], limit: number }}
   */
  function list(query = {}) {
    const scopeId = resolveScopeId(query.scopeId, bindings);
    const limit = clampInt(query.limit, 1, MAX_QUARANTINE_LIMIT, DEFAULT_QUARANTINE_LIMIT, 'limit');
    const status = query.status === undefined || query.status === null || query.status === ''
      ? 'quarantined'
      : String(query.status);
    const where = ['scope_id = ?', 'status = ?'];
    /** @type {any[]} */
    const params = [scopeId, status];
    if (query.reasonCode !== undefined && query.reasonCode !== null && query.reasonCode !== '') {
      where.push('reason_code = ?');
      params.push(String(query.reasonCode));
    }
    params.push(limit);
    const rows = reader.all(
      `SELECT * FROM immune_quarantine WHERE ${where.join(' AND ')}
        ORDER BY at_ms DESC, id DESC LIMIT ?`,
      params,
    );
    return { items: rows.map(rowToQuarantine), limit };
  }

  /**
   * 释放（核验后放行）。必须记「谁放出来的」：释放是负责任的动作，不能匿名。
   * @param {string} id
   * @param {{ by: string, notes?: string | null, scopeId?: string }} opts
   * @returns {Promise<any>}
   */
  async function release(id, opts = /** @type {any} */ ({})) {
    const quarantineId = requireText(id, 'id', { maxLength: 120 });
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const by = requireText(opts.by, 'by', { maxLength: 120 });
    const notes = opts.notes === undefined || opts.notes === null ? null : String(opts.notes).slice(0, 1000);
    // 事务外预检：业务错误必须在进入写队列之前抛（理由见 internal.requireRow 注释）。
    const pre = requireRow(
      reader,
      'SELECT id, status FROM immune_quarantine WHERE id = ? AND scope_id = ?',
      [quarantineId, scopeId],
      `隔离条目不存在：${quarantineId}`,
    );
    if (String(pre.status) === 'released') {
      return { id: quarantineId, status: 'released', released: false, alreadyReleased: true };
    }
    if (String(pre.status) === 'purged') {
      throw new BrainError('INVALID_ARGUMENT', '已销毁的隔离条目不支持释放');
    }
    return queue.write(
      (tx) => {
        const row = tx.get('SELECT status FROM immune_quarantine WHERE id = ? AND scope_id = ?', [quarantineId, scopeId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `隔离条目不存在：${quarantineId}`);
        const status = String(row.status);
        if (status === 'released') {
          return { id: quarantineId, status, released: false, alreadyReleased: true };
        }
        if (status === 'purged') {
          throw new BrainError('INVALID_ARGUMENT', '已销毁的隔离条目不支持释放');
        }
        const stamp = clock.stamp();
        tx.run(
          `UPDATE immune_quarantine
              SET status = 'released', reviewed_at = ?, reviewed_by = ?, notes = ?
            WHERE id = ? AND scope_id = ?`,
          [stamp.utc, by, notes, quarantineId, scopeId],
        );
        return { id: quarantineId, status: 'released', released: true, alreadyReleased: false, by };
      },
      { label: 'immune.release' },
    );
  }

  /**
   * 销毁（不是物理删行）：status='purged'，同时**清空 excerpt**。
   * 为什么不真删行：审计需要保留「曾经隔离过什么原因」，但内容本身不该继续留着
   * ——否则「销毁」只是换了个状态名。
   * @param {string} id
   * @param {{ by: string, scopeId?: string }} opts
   * @returns {Promise<any>}
   */
  async function purge(id, opts = /** @type {any} */ ({})) {
    const quarantineId = requireText(id, 'id', { maxLength: 120 });
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const by = requireText(opts.by, 'by', { maxLength: 120 });
    // 事务外预检：同 release（业务错误不得穿过写队列，否则错误码会被包装成 STORAGE_ERROR）。
    const pre = requireRow(
      reader,
      'SELECT id, status FROM immune_quarantine WHERE id = ? AND scope_id = ?',
      [quarantineId, scopeId],
      `隔离条目不存在：${quarantineId}`,
    );
    if (String(pre.status) === 'purged') {
      return { id: quarantineId, status: 'purged', purged: false, alreadyPurged: true };
    }
    return queue.write(
      (tx) => {
        const row = tx.get('SELECT status FROM immune_quarantine WHERE id = ? AND scope_id = ?', [quarantineId, scopeId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `隔离条目不存在：${quarantineId}`);
        const status = String(row.status);
        if (status === 'purged') {
          return { id: quarantineId, status, purged: false, alreadyPurged: true };
        }
        const stamp = clock.stamp();
        tx.run(
          `UPDATE immune_quarantine
              SET status = 'purged', reviewed_at = ?, reviewed_by = ?, excerpt = NULL,
                  detail_json = '{}', notes = NULL
            WHERE id = ? AND scope_id = ?`,
          [stamp.utc, by, quarantineId, scopeId],
        );
        return { id: quarantineId, status: 'purged', purged: true, alreadyPurged: false, by };
      },
      { label: 'immune.purge' },
    );
  }

  /**
   * 读一条隔离记录。
   * @param {string} id
   * @param {{ scopeId?: string }} [opts]
   * @returns {any | null}
   */
  function get(id, opts = {}) {
    const quarantineId = requireText(id, 'id', { maxLength: 120 });
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const row = reader.get('SELECT * FROM immune_quarantine WHERE id = ? AND scope_id = ?', [quarantineId, scopeId]);
    return row === undefined ? null : rowToQuarantine(row);
  }

  /**
   * 统计（面板用）。
   * @param {{ scopeId?: string }} [opts]
   * @returns {{ quarantined: number, released: number, purged: number, byReason: Record<string, number> }}
   */
  function stats(opts = {}) {
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const rows = reader.all(
      'SELECT status, reason_code, COUNT(*) AS n FROM immune_quarantine WHERE scope_id = ? GROUP BY status, reason_code',
      [scopeId],
    );
    /** @type {Record<string, number>} */
    const byReason = {};
    /** @type {Record<string, number>} */
    const byStatus = { quarantined: 0, released: 0, purged: 0 };
    for (const row of rows) {
      const count = Number(row.n);
      byStatus[String(row.status)] = (byStatus[String(row.status)] ?? 0) + count;
      byReason[String(row.reason_code)] = (byReason[String(row.reason_code)] ?? 0) + count;
    }
    return { ...byStatus, byReason };
  }

  /**
   * 供调用方在 scan 之后统一发事件用（可选）。扫描自己不 publish：
   * 事件发布是调用方（执行控制器）的职责，免疫模块只管检测与落库。
   * @param {any} result scan 的返回值
   * @returns {{ channel: string, kind: string, payload: Record<string, unknown> } | null}
   */
  function describeEvent(result) {
    if (!result || result.quarantined !== true) return null;
    return {
      channel: 'error',
      kind: 'immune.quarantined',
      payload: {
        quarantineId: result.quarantineId,
        reasonCode: result.reasonCode,
        severity: result.severity,
        duplicated: result.duplicated === true,
      },
    };
  }

  return {
    scan,
    isQuarantined,
    list,
    release,
    purge,
    get,
    stats,
    describeEvent,
    detectSecurityIssues,
    IMMUNE_RULES,
    REASON_SEVERITY,
    MAX_EXCERPT_LENGTH,
  };
}
