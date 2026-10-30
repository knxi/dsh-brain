// @ts-check
/**
 * `persona` —— 人格档案、版本、冲突、激活/回滚、注入渲染（系统 4 上半 · 2）。
 *
 * ── 一句话立场 ──
 *
 * **人格本体不在库里，注入内容在库里。** `~/.dsh/AGENTS.md` 是主人手写的母本，
 * 本模块只解析它（在 `import-persona.js`）并把结果存成「带版本的快照」；
 * 想改人格去改文件，想控制注入去切版本。两条路不许混，这样出问题时永远能回答
 * 「现在注入的是哪一版、它是从哪份文件来的」。
 *
 * ── 五层与「谁能改」──
 *
 * | 层 | 内容 | 谁可以改 |
 * |---|---|---|
 * | `locked` | 身份 / 边界 / 禁忌 | **没有人**。冲突一律 `unresolved`，等主人裁决 |
 * | `base` | 价值观 / 语气 / 称呼 / 关系默认 / 例子 / 长期指令 | 新版本（人工或导入） |
 * | `learned` | 从相处里学到的倾向 | 将来的学习管线（本轮留空） |
 * | `userOverride` | 主人显式指定 | 主人（控制台） |
 * | `transient` | 单次上下文临时覆盖 | 调用方（不进历史版本） |
 *
 * ── 三条硬纪律 ──
 *
 * 1. **只允许一个 active**：靠 `ux_persona_versions_active`（部分唯一索引）兜底，
 *    门面里再收一遍（先把旧的置 `superseded` 再置新的 `active`，同一事务）。
 * 2. **身份与边界冲突绝不自动消解**：`detectConflicts` 里 identity/boundary/contradiction
 *    三类**无视** `autoResolve` 参数，永远写 `unresolved`。自动消解这两类等于
 *    自己给自己改底线。
 * 3. **回滚不删版本**：`rollback` 把旧版重新激活、当前 active 置 `rolled_back`。
 *    版本历史是「我以前是谁」的账，删了就再也对不上账。
 */

import { BrainError } from './core.js';
import {
  LAYER_TO_CONFLICT,
  PERSONA_LAYERS,
  assertScope,
  clampInt,
  createTxApi,
  estimateTokens,
  newId,
  optionalString,
  requireEnum,
  requireString,
  resolveScopeId,
  safeJsonArray,
  safeJsonObject,
  stringifyJson,
  truncate,
} from './util.js';

/** 注入渲染默认预算（token）。够放「锁定层 + 基础要点 + 覆盖层」。 */
export const DEFAULT_RENDER_TOKENS = 600;
/** 冲突 `old_value`/`new_value` 列的截断长度（不存大段正文）。 */
const CONFLICT_VALUE_MAX = 500;
/** 冲突类型（0008 的 CHECK）。 */
export const CONFLICT_KINDS = Object.freeze(['identity', 'boundary', 'style', 'preference', 'contradiction']);
/** 冲突处理（0008 的 CHECK）。 */
export const CONFLICT_RESOLUTIONS = Object.freeze(['unresolved', 'keep_old', 'keep_new', 'merged', 'deferred']);
/**
 * **永远不许自动消解**的冲突类型。
 *
 * - `identity` / `boundary`：改的是「我是谁」和「我不做什么」，自动合并等于改底线。
 * - `contradiction`：两边都可能是真的，自动选边等于替主人下结论。
 */
export const NEVER_AUTO_RESOLVED = Object.freeze(['identity', 'boundary', 'contradiction']);
/** 版本状态（0008 的 CHECK）。 */
export const VERSION_STATUSES = Object.freeze(['draft', 'active', 'superseded', 'rolled_back', 'rejected']);

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
export function rowToProfile(row) {
  return {
    id: String(row.id),
    scopeId: String(row.scope_id),
    name: String(row.name),
    sourceType: String(row.source_type),
    sourcePath: row.source_path == null ? null : String(row.source_path),
    sourceHash: row.source_hash == null ? null : String(row.source_hash),
    isDefault: Number(row.is_default ?? 0) === 1,
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
export function rowToVersion(row) {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    scopeId: String(row.scope_id),
    version: Number(row.version),
    parentVersion: row.parent_version == null ? null : Number(row.parent_version),
    sourceHash: row.source_hash == null ? null : String(row.source_hash),
    layers: safeJsonObject(row.layers_json),
    conflicts: safeJsonArray(row.conflicts_json),
    diff: safeJsonObject(row.diff_json),
    renderedText: row.rendered_text == null ? null : String(row.rendered_text),
    tokenEstimate: row.token_estimate == null ? null : Number(row.token_estimate),
    changeReason: row.change_reason == null ? null : String(row.change_reason),
    status: String(row.status),
    activatedAt: row.activated_at == null ? null : String(row.activated_at),
    deactivatedAt: row.deactivated_at == null ? null : String(row.deactivated_at),
    createdAt: String(row.created_at),
    createdBy: row.created_by == null ? null : String(row.created_by),
  };
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
export function rowToConflict(row) {
  return {
    id: String(row.id),
    profileId: String(row.profile_id),
    fromVersion: row.from_version == null ? null : Number(row.from_version),
    toVersion: row.to_version == null ? null : Number(row.to_version),
    layer: String(row.layer),
    field: String(row.field),
    kind: String(row.kind),
    oldValue: row.old_value == null ? null : String(row.old_value),
    newValue: row.new_value == null ? null : String(row.new_value),
    detail: row.detail == null ? null : String(row.detail),
    resolution: String(row.resolution),
    createdAt: String(row.created_at),
  };
}

/**
 * 层级对象扁平化：`{locked:{identity:{name:'x'}}}` → `{'locked.identity.name':'x'}`。
 * 数组当作**叶子**（整组比较 + 逐项差集）——按索引展开会把「多了一条禁忌」
 * 变成十条噪音，反而看不出改了什么。
 * @param {Record<string, any>} layers
 * @returns {Map<string, { layer: string, field: string, value: any }>}
 */
export function flattenLayers(layers) {
  /** @type {Map<string, { layer: string, field: string, value: any }>} */
  const out = new Map();
  for (const layer of PERSONA_LAYERS) {
    const body = layers?.[layer];
    if (!body || typeof body !== 'object' || Array.isArray(body)) continue;
    for (const [field, value] of Object.entries(body)) {
      const base = `${layer}.${field}`;
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) || typeof value !== 'object') {
        out.set(base, { layer, field, value });
        continue;
      }
      // 对象：往下拆一层（identity 里的 notes 是数组 → 当作叶子）
      const leaves = collectLeaves(value, base);
      if (leaves.length === 0) {
        out.set(base, { layer, field, value });
      } else {
        for (const [path, leaf] of leaves) out.set(path, { layer, field, value: leaf });
      }
    }
  }
  return out;
}

/**
 * @param {Record<string, any>} node
 * @param {string} base
 * @returns {Array<[string, any]>}
 */
function collectLeaves(node, base) {
  /** @type {Array<[string, any]>} */
  const out = [];
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null) continue;
    const path = `${base}.${key}`;
    if (Array.isArray(value) || typeof value !== 'object') out.push([path, value]);
    else out.push(...collectLeaves(value, path));
  }
  return out;
}

/**
 * @param {any} a
 * @param {any} b
 * @returns {boolean}
 */
function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((item, index) => JSON.stringify(item) === JSON.stringify(b[index]));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * 两组层对象的字段级差异。
 *
 * 返回结构（`added`/`removed`/`changed` 三种条目形状一致，便于控制台直接渲染）：
 * ```js
 * { path:'locked.boundaries', layer:'locked', field:'boundaries',
 *   from:[...], to:[...], itemsAdded:[...], itemsRemoved:[...] }
 * ```
 * @param {Record<string, any>} fromLayers
 * @param {Record<string, any>} toLayers
 * @returns {{ added: any[], removed: any[], changed: any[] }}
 */
export function diffLayerObjects(fromLayers, toLayers) {
  const fromMap = flattenLayers(fromLayers ?? {});
  const toMap = flattenLayers(toLayers ?? {});
  /** @type {any[]} */
  const added = [];
  /** @type {any[]} */
  const removed = [];
  /** @type {any[]} */
  const changed = [];

  for (const [path, entry] of toMap) {
    if (!fromMap.has(path)) {
      added.push({ path, layer: entry.layer, field: entry.field, from: null, to: entry.value });
      continue;
    }
    const before = /** @type {{ value: any }} */ (fromMap.get(path));
    if (sameValue(before.value, entry.value)) continue;
    /** @type {string[]} */
    const itemsAdded = [];
    /** @type {string[]} */
    const itemsRemoved = [];
    if (Array.isArray(before.value) && Array.isArray(entry.value)) {
      const oldSet = new Set(before.value.map((item) => JSON.stringify(item)));
      const newSet = new Set(entry.value.map((item) => JSON.stringify(item)));
      for (const item of entry.value) if (!oldSet.has(JSON.stringify(item))) itemsAdded.push(String(item));
      for (const item of before.value) if (!newSet.has(JSON.stringify(item))) itemsRemoved.push(String(item));
    }
    changed.push({ path, layer: entry.layer, field: entry.field, from: before.value, to: entry.value, itemsAdded, itemsRemoved });
  }
  for (const [path, entry] of fromMap) {
    if (toMap.has(path)) continue;
    removed.push({ path, layer: entry.layer, field: entry.field, from: entry.value, to: null });
  }
  return { added, removed, changed };
}

/**
 * 每条差异归到哪种冲突（决定「能不能自动消解」）。
 * @param {{ layer: string, field: string, from: any, to: any, itemsRemoved?: string[] }} diff
 * @returns {string}
 */
export function classifyConflict(diff) {
  const layer = String(diff.layer);
  const field = String(diff.field);
  if ((layer === 'locked' || layer === 'transient') && field === 'identity') return 'identity';
  if (layer === 'locked' && (field === 'boundaries' || field === 'taboos')) return 'boundary';
  if (field === 'tone' || field === 'address') return 'style';
  if (field === 'values' || field === 'relationshipDefaults') return 'preference';
  // 其余：两边都有内容又互相不包含 → 判成「自相矛盾」（也需要人看，不自动消解）
  const fromText = JSON.stringify(diff.from ?? '');
  const toText = JSON.stringify(diff.to ?? '');
  if (fromText.length > 4 && toText.length > 4) return 'contradiction';
  return 'preference';
}

/**
 * 把层对象渲染成注入文本（按优先级排块；预算不够就截断并标明）。
 * @param {Record<string, any>} layers
 * @param {{ maxTokens?: number }} [options]
 * @returns {{ text: string, tokens: number, truncated: boolean, droppedBlocks: string[] }}
 */
export function renderLayersText(layers, options = {}) {
  const maxTokens = clampInt(options.maxTokens, 32, 200_000, DEFAULT_RENDER_TOKENS, 'maxTokens');
  const locked = layers?.locked ?? {};
  const base = layers?.base ?? {};
  const override = layers?.userOverride ?? {};
  const learned = layers?.learned ?? {};
  const transient = layers?.transient ?? {};

  /** @type {Array<{ label: string, priority: number, lines: string[] }>} */
  const blocks = [];
  /** @type {(list: string[]) => string[]} */
  const clean = (list) => list.filter((line) => typeof line === 'string' && line.trim().length > 0);

  // 优先级 1：锁定层（身份 → 边界 → 禁忌）。注入必须先保证它们完整。
  const identity = locked.identity ?? {};
  /** @type {string[]} */
  const identityLines = [];
  if (identity.name) identityLines.push(`- 名字：${identity.name}`);
  if (identity.role) identityLines.push(`- 身份：${identity.role}`);
  if (identity.selfDescription) identityLines.push(`- 自述：${identity.selfDescription}`);
  for (const note of identity.notes ?? []) identityLines.push(`- ${note}`);
  if (identityLines.length > 0) blocks.push({ label: '我是谁', priority: 1, lines: identityLines });

  const boundaryLines = clean([...(locked.boundaries ?? []), ...(locked.taboos ?? [])]).map((line) => `- ${line}`);
  if (boundaryLines.length > 0) blocks.push({ label: '底线与禁忌（不可自动改写）', priority: 1, lines: boundaryLines });

  // 优先级 2：基础人格要点（称呼 → 语气 → 价值观）
  /** @type {string[]} */
  const addressLines = [];
  if (base.address?.term) addressLines.push(`- 称呼：叫「${base.address.term}」`);
  if (base.address?.avoid) addressLines.push(`- 别叫：${base.address.avoid}`);
  if (addressLines.length > 0) blocks.push({ label: '称呼', priority: 2, lines: addressLines });

  const toneLines = clean([...(base.tone?.personality ?? []), ...(base.tone?.expression ?? []), ...(base.tone?.notes ?? [])]).map(
    (line) => `- ${line}`,
  );
  if (toneLines.length > 0) blocks.push({ label: '性格与表达', priority: 2, lines: toneLines });

  const valueLines = clean(base.values ?? []).map((line) => `- ${line}`);
  if (valueLines.length > 0) blocks.push({ label: '价值取向', priority: 2, lines: valueLines });

  // 优先级 3：关系默认 / 长期指令 / 用户覆盖（覆盖层放这里之后，保证它不会先被截掉）
  /** @type {string[]} */
  const relLines = [];
  if (base.relationshipDefaults?.stance) relLines.push(`- 关系定位：${base.relationshipDefaults.stance}`);
  for (const note of base.relationshipDefaults?.notes ?? []) relLines.push(`- ${note}`);
  if (relLines.length > 0) blocks.push({ label: '关于对方', priority: 3, lines: relLines });

  const directiveLines = clean(base.longTermDirectives ?? []).map((line) => `- ${line}`);
  if (directiveLines.length > 0) blocks.push({ label: '长期指令', priority: 3, lines: directiveLines });

  const overrideLines = summarizeObject(override);
  if (overrideLines.length > 0) blocks.push({ label: '当前用户覆盖', priority: 3, lines: overrideLines });
  const learnedLines = summarizeObject(learned);
  if (learnedLines.length > 0) blocks.push({ label: '学到的倾向', priority: 4, lines: learnedLines });
  const transientLines = summarizeObject(transient);
  if (transientLines.length > 0) blocks.push({ label: '临时覆盖（本次上下文）', priority: 5, lines: transientLines });

  // 例子放最后：占地方但价值最低（它是风格的参考，不是必须遵守的规则）。
  const exampleLines = [];
  for (const example of base.examples ?? []) {
    if (!example || typeof example !== 'object') continue;
    if (example.state) exampleLines.push(`- ${example.state} → ${truncate(example.text, 120)}`);
    else if (example.text) exampleLines.push(`- ${truncate(example.text, 120)}`);
  }
  if (exampleLines.length > 0) blocks.push({ label: '表达参考', priority: 6, lines: exampleLines });

  blocks.sort((a, b) => a.priority - b.priority);

  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const droppedBlocks = [];
  let tokens = 0;
  let truncated = false;
  for (const block of blocks) {
    const header = `## ${block.label}`;
    const headerCost = estimateTokens(header) + 1; // +1 ≈ 换行
    /** @type {string[]} */
    const accepted = [];
    let blockCost = 0;
    for (const line of block.lines) {
      const cost = estimateTokens(line) + 1;
      if (tokens + headerCost + blockCost + cost > maxTokens) {
        truncated = true;
        break;
      }
      accepted.push(line);
      blockCost += cost;
    }
    if (accepted.length === 0) {
      truncated = true;
      droppedBlocks.push(block.label);
      continue;
    }
    out.push(header, ...accepted);
    tokens += headerCost + blockCost;
    if (accepted.length < block.lines.length) droppedBlocks.push(block.label);
  }
  let text = out.join('\n');
  if (truncated) {
    const marker = '…（预算不足，已按优先级截断）';
    text = text.length > 0 ? `${text}\n${marker}` : marker;
  }
  return { text, tokens: estimateTokens(text), truncated, droppedBlocks };
}

/**
 * 把一层里的任意对象渲染成 `- 键：值` 行（覆盖层/学习层结构会变，用通用渲染）。
 * @param {Record<string, any>} node
 * @param {string} [prefix]
 * @returns {string[]}
 */
function summarizeObject(node, prefix = '') {
  /** @type {string[]} */
  const out = [];
  if (!node || typeof node !== 'object' || Array.isArray(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    if (value === undefined || value === null) continue;
    const label = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(value)) {
      const parts = value.map((item) => (typeof item === 'object' ? JSON.stringify(item) : String(item))).filter((item) => item.length > 0);
      if (parts.length > 0) out.push(`- ${label}：${parts.join('；')}`);
    } else if (typeof value === 'object') {
      out.push(...summarizeObject(value, label));
    } else {
      out.push(`- ${label}：${String(value)}`);
    }
  }
  return out;
}

/**
 * 人格档案门面（profile 的增删查 + 默认档案）。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   scopeId?: string,
 *   bindings?: { scope_id?: string },
 *   importer?: { importFromFile: (input: any) => Promise<any>, inspectFile: (input: any) => any, previewFile: (input: any) => any },
 * }} options
 */
export function createPersonaProfiles(options) {
  const { db, queue, clock } = options;
  const scopeId = resolveScopeId(options);
  const tx = createTxApi(db);
  const importer = options.importer ?? null;

  /**
   * 取档案。只按 id 或 name 查自己的 scope——**跨 scope 一律查不到**。
   * @param {{ id?: string, name?: string, scopeId?: string }} [query]
   * @returns {any | null}
   */
  function get(query = {}) {
    assertScope(scopeId, query.scopeId, 'query.scopeId');
    if (query.id) {
      const row = tx.get('SELECT * FROM persona_profiles WHERE id = ? AND scope_id = ?', [requireString(query.id, 'id'), scopeId]);
      return row === undefined ? null : rowToProfile(row);
    }
    if (query.name) {
      const row = tx.get('SELECT * FROM persona_profiles WHERE name = ? AND scope_id = ?', [
        requireString(query.name, 'name'),
        scopeId,
      ]);
      return row === undefined ? null : rowToProfile(row);
    }
    throw new BrainError('INVALID_ARGUMENT', 'get 需要 id 或 name');
  }

  /**
   * 列档案（新→旧）。
   * @param {{ limit?: number }} [query]
   */
  function list(query = {}) {
    const limit = clampInt(query.limit, 1, 500, 50, 'limit');
    const rows = tx.all('SELECT * FROM persona_profiles WHERE scope_id = ? ORDER BY is_default DESC, created_at ASC LIMIT ?', [
      scopeId,
      limit,
    ]);
    return { items: rows.map((row) => rowToProfile(row)), limit };
  }

  /**
   * 设默认档案。同 scope 只能一个默认（`ux_persona_profiles_default` 兜底）。
   * 顺序要紧：先把别人置 0，再把自己置 1，否则唯一索引会先炸。
   * @param {string} profileId
   * @param {{ by?: string }} [meta]
   */
  async function setDefault(profileId, meta = {}) {
    const id = requireString(profileId, 'profileId');
    return queue.write(
      (txh) => {
        const row = txh.get('SELECT id FROM persona_profiles WHERE id = ? AND scope_id = ?', [id, scopeId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `档案不存在：${id}`);
        const stamp = clock.stamp();
        txh.run('UPDATE persona_profiles SET is_default = 0, updated_at = ?, updated_at_local = ? WHERE scope_id = ? AND is_default = 1', [
          stamp.utc,
          stamp.local,
          scopeId,
        ]);
        txh.run('UPDATE persona_profiles SET is_default = 1, updated_at = ?, updated_at_local = ? WHERE id = ? AND scope_id = ?', [
          stamp.utc,
          stamp.local,
          id,
          scopeId,
        ]);
        return { profileId: id, isDefault: true, by: meta.by ?? null };
      },
      { label: 'persona.profiles.setDefault' },
    );
  }

  /**
   * 归档档案（不删行：版本与冲突都挂在它上面，删了就成孤儿）。
   * @param {string} profileId
   * @param {{ reason?: string }} [meta]
   */
  async function archive(profileId, meta = {}) {
    const id = requireString(profileId, 'profileId');
    return queue.write(
      (txh) => {
        const row = txh.get('SELECT id, status FROM persona_profiles WHERE id = ? AND scope_id = ?', [id, scopeId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `档案不存在：${id}`);
        const stamp = clock.stamp();
        txh.run('UPDATE persona_profiles SET status = ?, is_default = 0, updated_at = ?, updated_at_local = ? WHERE id = ? AND scope_id = ?', [
          'archived',
          stamp.utc,
          stamp.local,
          id,
          scopeId,
        ]);
        return { profileId: id, status: 'archived', reason: meta.reason ?? null };
      },
      { label: 'persona.profiles.archive' },
    );
  }

  /**
   * 导入人格文件（实现在 `import-persona.js`，这里只做转发 + 未注入时的明确报错）。
   * @param {{ scopeId?: string, name?: string, filePath: string, sourceType?: string, changeReason?: string }} input
   */
  async function importFromFile(input = /** @type {any} */ ({})) {
    if (!importer) {
      throw new BrainError('INVALID_ARGUMENT', 'createPersonaProfiles 没注入 importer：请用 createPersona({...}) 组装，或自行传 importer');
    }
    return importer.importFromFile(input);
  }

  /**
   * 只判定「文件改了没有」（不写库）。
   * @param {{ name?: string, filePath: string }} input
   */
  function inspectFile(input = /** @type {any} */ ({})) {
    if (!importer) throw new BrainError('INVALID_ARGUMENT', 'createPersonaProfiles 没注入 importer');
    return importer.inspectFile(input);
  }

  return { get, list, setDefault, archive, importFromFile, inspectFile, scopeId };
}

/**
 * 人格版本门面：建版 / 差异 / 冲突 / 激活 / 回滚 / 渲染。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   scopeId?: string,
 *   bindings?: { scope_id?: string },
 * }} options
 */
export function createPersonaVersions(options) {
  const { db, queue, clock } = options;
  const scopeId = resolveScopeId(options);
  const tx = createTxApi(db);
  const alert = options.alert ?? (() => {});

  /**
   * @param {unknown} layers
   * @returns {Record<string, Record<string, any>>}
   */
  function normalizeLayers(layers) {
    if (!layers || typeof layers !== 'object' || Array.isArray(layers)) {
      throw new BrainError('INVALID_ARGUMENT', 'layers 必须是对象（五层）');
    }
    /** @type {Record<string, Record<string, any>>} */
    const out = {};
    for (const key of Object.keys(layers)) {
      if (!PERSONA_LAYERS.includes(key)) {
        throw new BrainError('INVALID_ARGUMENT', `layers 含未知层：${key}（只允许 ${PERSONA_LAYERS.join(' | ')}）`);
      }
    }
    for (const layer of PERSONA_LAYERS) {
      const body = /** @type {any} */ (layers)[layer];
      if (body === undefined || body === null) {
        out[layer] = {};
        continue;
      }
      if (typeof body !== 'object' || Array.isArray(body)) {
        throw new BrainError('INVALID_ARGUMENT', `layers.${layer} 必须是对象`);
      }
      out[layer] = body;
    }
    return out;
  }

  /**
   * 取版本（按 id 或 version 号）。只查绑定 scope。
   * @param {{ id?: string, profileId?: string, version?: number, scopeId?: string }} query
   * @returns {any | null}
   */
  function get(query = {}) {
    assertScope(scopeId, query.scopeId, 'query.scopeId');
    if (query.id) {
      const row = tx.get('SELECT * FROM persona_versions WHERE id = ? AND scope_id = ?', [requireString(query.id, 'id'), scopeId]);
      return row === undefined ? null : rowToVersion(row);
    }
    if (query.profileId !== undefined && query.version !== undefined) {
      const row = tx.get('SELECT * FROM persona_versions WHERE profile_id = ? AND scope_id = ? AND version = ?', [
        requireString(query.profileId, 'profileId'),
        scopeId,
        clampInt(query.version, 1, Number.MAX_SAFE_INTEGER, 1, 'version'),
      ]);
      return row === undefined ? null : rowToVersion(row);
    }
    throw new BrainError('INVALID_ARGUMENT', 'get 需要 id，或 (profileId, version)');
  }

  /**
   * 列版本（新→旧）。
   * @param {{ profileId: string, limit?: number, scopeId?: string }} query
   */
  function list(query = /** @type {any} */ ({})) {
    assertScope(scopeId, query.scopeId, 'query.scopeId');
    const profileId = requireString(query.profileId, 'profileId');
    const limit = clampInt(query.limit, 1, 500, 50, 'limit');
    const rows = tx.all('SELECT * FROM persona_versions WHERE profile_id = ? AND scope_id = ? ORDER BY version DESC LIMIT ?', [
      profileId,
      scopeId,
      limit,
    ]);
    return { items: rows.map((row) => rowToVersion(row)), limit };
  }

  /**
   * 当前激活版本（没有就 null）。
   * @param {{ profileId: string }} query
   */
  function getActive(query = /** @type {any} */ ({})) {
    const profileId = requireString(query.profileId, 'profileId');
    const row = tx.get("SELECT * FROM persona_versions WHERE profile_id = ? AND scope_id = ? AND status = 'active'", [
      profileId,
      scopeId,
    ]);
    return row === undefined ? null : rowToVersion(row);
  }

  /**
   * 新建一版。
   *
   * 幂等/并发口径：版本号 = 同档案内 `MAX(version)+1`，在**同一个写事务**里算与插，
   * 配合 `UNIQUE (profile_id, version)` 兜底——先查后写在并发下必漏。
   *
   * @param {{
   *   profileId: string,
   *   layers: Record<string, any>,
   *   changeReason?: string,
   *   parentVersion?: number,
   *   sourceHash?: string,
   *   createdBy?: string,
   * }} input
   * @returns {Promise<{ id: string, version: number, status: string, diff: any, tokens: number }>}
   */
  async function createVersion(input = /** @type {any} */ ({})) {
    const profileId = requireString(input.profileId, 'profileId');
    const layers = normalizeLayers(input.layers);
    const changeReason = optionalString(input.changeReason, 'changeReason');
    const sourceHash = optionalString(input.sourceHash, 'sourceHash');
    const createdBy = optionalString(input.createdBy, 'createdBy');
    const rendered = renderLayersText(layers);
    const layersJson = stringifyJson(layers, 'layers');

    return queue.write(
      (txh) => {
        const profile = txh.get('SELECT id FROM persona_profiles WHERE id = ? AND scope_id = ?', [profileId, scopeId]);
        if (profile === undefined) throw new BrainError('NOT_FOUND', `档案不存在：${profileId}`);
        const maxRow = txh.get('SELECT MAX(version) AS v FROM persona_versions WHERE profile_id = ? AND scope_id = ?', [profileId, scopeId]);
        const version = Number(maxRow?.v ?? 0) + 1;
        const parentVersion =
          input.parentVersion === undefined || input.parentVersion === null
            ? version > 1
              ? version - 1
              : null
            : clampInt(input.parentVersion, 1, Number.MAX_SAFE_INTEGER, 1, 'parentVersion');
        let parentLayers = {};
        if (parentVersion !== null) {
          const parent = txh.get('SELECT layers_json FROM persona_versions WHERE profile_id = ? AND scope_id = ? AND version = ?', [
            profileId,
            scopeId,
            parentVersion,
          ]);
          if (parent !== undefined) parentLayers = safeJsonObject(parent.layers_json);
        }
        const diff = diffLayerObjects(parentLayers, layers);
        const stamp = clock.stamp();
        const id = newId('pver');
        txh.run(
          `INSERT INTO persona_versions (
             id, profile_id, scope_id, version, parent_version, source_hash, layers_json,
             conflicts_json, diff_json, rendered_text, token_estimate, change_reason, status,
             created_at, created_at_local, created_by
           ) VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?, ?, 'draft', ?, ?, ?)`,
          [
            id,
            profileId,
            scopeId,
            version,
            parentVersion,
            sourceHash,
            layersJson,
            stringifyJson(diff, 'diff'),
            rendered.text,
            rendered.tokens,
            changeReason,
            stamp.utc,
            stamp.local,
            createdBy,
          ],
        );
        return { id, version, status: 'draft', diff, tokens: rendered.tokens };
      },
      { label: 'persona.versions.create' },
    );
  }

  /**
   * 两版之间的字段级差异，并把结果写回 `to` 版本的 `diff_json`。
   * @param {{ fromId: string, toId: string, persist?: boolean }} input
   */
  async function diffVersions(input = /** @type {any} */ ({})) {
    const from = get({ id: requireString(input.fromId, 'fromId') });
    const to = get({ id: requireString(input.toId, 'toId') });
    if (!from) throw new BrainError('NOT_FOUND', `版本不存在：${input.fromId}`);
    if (!to) throw new BrainError('NOT_FOUND', `版本不存在：${input.toId}`);
    const diff = diffLayerObjects(from.layers, to.layers);
    if (input.persist !== false) {
      await queue.write(
        (txh) => {
          txh.run('UPDATE persona_versions SET diff_json = ? WHERE id = ? AND scope_id = ?', [
            stringifyJson(diff, 'diff'),
            to.id,
            scopeId,
          ]);
        },
        { label: 'persona.versions.diff' },
      );
    }
    return { fromVersion: from.version, toVersion: to.version, ...diff };
  }

  /**
   * 检出冲突并写 `persona_conflicts`。
   *
   * **自动消解的边界**：`autoResolve` 里写 `['style']` 之类才可能自动 `keep_new`，
   * 且 identity / boundary / contradiction 三类**永远** `unresolved`（代码里硬判，
   * 不靠调用方自觉）。
   *
   * @param {{
   *   profileId: string,
   *   fromVersion: number,
   *   toVersion: number,
   *   autoResolve?: string[],
   *   persist?: boolean,
   * }} input
   */
  async function detectConflicts(input = /** @type {any} */ ({})) {
    const profileId = requireString(input.profileId, 'profileId');
    const fromVersion = clampInt(input.fromVersion, 1, Number.MAX_SAFE_INTEGER, 1, 'fromVersion');
    const toVersion = clampInt(input.toVersion, 1, Number.MAX_SAFE_INTEGER, 1, 'toVersion');
    const autoResolve = new Set((input.autoResolve ?? []).map((kind) => String(kind)));
    const from = get({ profileId, version: fromVersion });
    const to = get({ profileId, version: toVersion });
    if (!from) throw new BrainError('NOT_FOUND', `版本不存在：v${fromVersion}`);
    if (!to) throw new BrainError('NOT_FOUND', `版本不存在：v${toVersion}`);
    const diff = diffLayerObjects(from.layers, to.layers);
    /** @type {Array<Record<string, any>>} */
    const conflicts = [];
    for (const entry of [...diff.changed, ...diff.added, ...diff.removed]) {
      const kind = classifyConflict(entry);
      // 身份/边界/矛盾三类**永远** unresolved：NEVER_AUTO_RESOLVED 是硬判，
      // 不靠调用方自觉（自动合并这三类等于自己给自己改底线）。
      /** @type {string} */
      let resolution = 'unresolved';
      if (!NEVER_AUTO_RESOLVED.includes(kind) && autoResolve.has(kind)) resolution = 'keep_new';
      conflicts.push({
        layer: LAYER_TO_CONFLICT[/** @type {keyof typeof LAYER_TO_CONFLICT} */ (entry.layer)] ?? 'base',
        field: String(entry.field ?? entry.path),
        path: entry.path,
        kind,
        oldValue: truncate(JSON.stringify(entry.from ?? null), CONFLICT_VALUE_MAX),
        newValue: truncate(JSON.stringify(entry.to ?? null), CONFLICT_VALUE_MAX),
        resolution,
        detail: resolution === 'unresolved' ? '需要主人裁决（身份/边界/矛盾类不许自动消解）' : `按 autoResolve 自动取新值（${kind}）`,
      });
    }

    if (input.persist !== false && conflicts.length > 0) {
      await queue.write(
        (txh) => {
          const stamp = clock.stamp();
          for (const conflict of conflicts) {
            const existing = txh.get(
              `SELECT id FROM persona_conflicts
                WHERE profile_id = ? AND from_version = ? AND to_version = ? AND field = ? AND kind = ?
                  AND COALESCE(old_value,'') = COALESCE(?,'') AND COALESCE(new_value,'') = COALESCE(?,'')`,
              [profileId, fromVersion, toVersion, conflict.field, conflict.kind, conflict.oldValue, conflict.newValue],
            );
            if (existing !== undefined) {
              conflict.id = String(existing.id);
              conflict.duplicate = true;
              continue;
            }
            const id = newId('pcf');
            txh.run(
              `INSERT INTO persona_conflicts (
                 id, profile_id, from_version, to_version, layer, field, kind,
                 old_value, new_value, detail, resolution, created_at, created_at_local
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                id,
                profileId,
                fromVersion,
                toVersion,
                conflict.layer,
                conflict.field,
                conflict.kind,
                conflict.oldValue,
                conflict.newValue,
                conflict.detail,
                conflict.resolution,
                stamp.utc,
                stamp.local,
              ],
            );
            conflict.id = id;
          }
        },
        { label: 'persona.conflicts.detect' },
      );
    }
    return { profileId, fromVersion, toVersion, conflicts, unresolved: conflicts.filter((c) => c.resolution === 'unresolved').length };
  }

  /**
   * 列冲突（控制台/面板用）。
   * @param {{ profileId: string, resolution?: string, limit?: number }} query
   */
  function listConflicts(query = /** @type {any} */ ({})) {
    const profileId = requireString(query.profileId, 'profileId');
    const limit = clampInt(query.limit, 1, 1000, 100, 'limit');
    const resolution = query.resolution === undefined ? null : requireEnum(query.resolution, CONFLICT_RESOLUTIONS, 'resolution');
    const baseSql = `SELECT c.* FROM persona_conflicts c
                       JOIN persona_profiles p ON p.id = c.profile_id
                      WHERE c.profile_id = ? AND p.scope_id = ?`;
    const rows =
      resolution === null
        ? tx.all(`${baseSql} ORDER BY c.created_at DESC, c.id DESC LIMIT ?`, [profileId, scopeId, limit])
        : tx.all(`${baseSql} AND c.resolution = ? ORDER BY c.created_at DESC, c.id DESC LIMIT ?`, [
            profileId,
            scopeId,
            resolution,
            limit,
          ]);
    return { items: rows.map((row) => rowToConflict(row)), limit };
  }

  /**
   * 人工裁决一条冲突。**人是唯一能改这些的地方**。
   * @param {{ conflictId: string, resolution: string, by?: string }} input
   */
  async function resolveConflict(input = /** @type {any} */ ({})) {
    const conflictId = requireString(input.conflictId, 'conflictId');
    const resolution = requireEnum(input.resolution, CONFLICT_RESOLUTIONS.filter((value) => value !== 'unresolved'), 'resolution');
    const by = requireString(input.by, 'by');
    return queue.write(
      (txh) => {
        const row = txh.get(
          'SELECT * FROM persona_conflicts WHERE id = ? AND profile_id IN (SELECT id FROM persona_profiles WHERE scope_id = ?)',
          [conflictId, scopeId],
        );
        if (row === undefined) throw new BrainError('NOT_FOUND', `冲突不存在：${conflictId}`);
        const stamp = clock.stamp();
        txh.run('UPDATE persona_conflicts SET resolution = ?, resolved_at = ?, resolved_by = ? WHERE id = ?', [
          resolution,
          stamp.utc,
          by,
          conflictId,
        ]);
        return { conflictId, resolution, by };
      },
      { label: 'persona.conflicts.resolve' },
    );
  }

  /**
   * 激活一版（同一事务内：旧 active → superseded，新版 → active）。
   * @param {string} versionId
   * @param {{ by: string, reason?: string }} meta
   */
  async function activate(versionId, meta = /** @type {any} */ ({})) {
    const id = requireString(versionId, 'versionId');
    const by = requireString(meta.by, 'by');
    return queue.write(
      (txh) => {
        const row = txh.get('SELECT * FROM persona_versions WHERE id = ? AND scope_id = ?', [id, scopeId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `版本不存在：${id}`);
        if (String(row.status) === 'active') {
          return { activated: false, alreadyActive: true, id, version: Number(row.version), superseded: [] };
        }
        if (String(row.status) === 'rejected') {
          throw new BrainError('INVALID_ARGUMENT', `被拒的版本不能激活：v${row.version}`);
        }
        const stamp = clock.stamp();
        const previous = txh.all("SELECT id, version FROM persona_versions WHERE profile_id = ? AND scope_id = ? AND status = 'active'", [
          String(row.profile_id),
          scopeId,
        ]);
        for (const old of previous) {
          txh.run("UPDATE persona_versions SET status = 'superseded', deactivated_at = ? WHERE id = ?", [stamp.utc, String(old.id)]);
        }
        txh.run("UPDATE persona_versions SET status = 'active', activated_at = ?, deactivated_at = NULL WHERE id = ?", [stamp.utc, id]);
        txh.run("UPDATE persona_profiles SET status = 'active', updated_at = ?, updated_at_local = ? WHERE id = ? AND scope_id = ?", [
          stamp.utc,
          stamp.local,
          String(row.profile_id),
          scopeId,
        ]);
        return {
          activated: true,
          alreadyActive: false,
          id,
          version: Number(row.version),
          superseded: previous.map((old) => ({ id: String(old.id), version: Number(old.version) })),
          by,
          reason: meta.reason ?? null,
          at: stamp.utc,
        };
      },
      { label: 'persona.versions.activate' },
    );
  }

  /**
   * 回滚到某一版（不删版本：当前 active 置 `rolled_back`，目标重新 active）。
   * @param {{ profileId: string, toVersion: number, by: string, reason?: string }} input
   */
  async function rollback(input = /** @type {any} */ ({})) {
    const profileId = requireString(input.profileId, 'profileId');
    const toVersion = clampInt(input.toVersion, 1, Number.MAX_SAFE_INTEGER, 1, 'toVersion');
    const by = requireString(input.by, 'by');
    return queue.write(
      (txh) => {
        const target = txh.get('SELECT * FROM persona_versions WHERE profile_id = ? AND scope_id = ? AND version = ?', [
          profileId,
          scopeId,
          toVersion,
        ]);
        if (target === undefined) throw new BrainError('NOT_FOUND', `版本不存在：v${toVersion}`);
        if (String(target.status) === 'active') {
          return { rolledBack: false, alreadyActive: true, activeVersion: toVersion, rolledBackFrom: null };
        }
        const current = txh.all("SELECT id, version FROM persona_versions WHERE profile_id = ? AND scope_id = ? AND status = 'active'", [
          profileId,
          scopeId,
        ]);
        const stamp = clock.stamp();
        for (const old of current) {
          txh.run("UPDATE persona_versions SET status = 'rolled_back', deactivated_at = ? WHERE id = ?", [stamp.utc, String(old.id)]);
        }
        txh.run("UPDATE persona_versions SET status = 'active', activated_at = ?, deactivated_at = NULL WHERE id = ?", [stamp.utc, String(target.id)]);
        txh.run("UPDATE persona_profiles SET status = 'active', updated_at = ?, updated_at_local = ? WHERE id = ? AND scope_id = ?", [
          stamp.utc,
          stamp.local,
          profileId,
          scopeId,
        ]);
        return {
          rolledBack: true,
          alreadyActive: false,
          activeVersion: Number(target.version),
          rolledBackFrom: current.map((old) => Number(old.version)),
          by,
          reason: input.reason ?? null,
          at: stamp.utc,
        };
      },
      { label: 'persona.versions.rollback' },
    );
  }

  /**
   * 渲染注入文本。
   *
   * 取哪一版：**active 优先**；还没激活过（刚导入）就退回最新版，
   * 并在返回里如实标 `status:'draft'`——不假装它已经生效。
   * @param {{ profileId: string, maxTokens?: number }} query
   */
  function renderForContext(query = /** @type {any} */ ({})) {
    const profileId = requireString(query.profileId, 'profileId');
    const maxTokens = clampInt(query.maxTokens, 32, 200_000, DEFAULT_RENDER_TOKENS, 'maxTokens');
    let row = tx.get("SELECT * FROM persona_versions WHERE profile_id = ? AND scope_id = ? AND status = 'active'", [profileId, scopeId]);
    if (row === undefined) {
      row = tx.get(
        "SELECT * FROM persona_versions WHERE profile_id = ? AND scope_id = ? AND status <> 'rejected' ORDER BY version DESC LIMIT 1",
        [profileId, scopeId],
      );
    }
    if (row === undefined) {
      return { profileId, versionId: null, version: null, status: null, text: '', tokens: 0, truncated: false, maxTokens };
    }
    const version = rowToVersion(/** @type {any} */ (row));
    const rendered = renderLayersText(version.layers, { maxTokens });
    return {
      profileId,
      versionId: version.id,
      version: version.version,
      status: version.status,
      text: rendered.text,
      tokens: rendered.tokens,
      truncated: rendered.truncated,
      droppedBlocks: rendered.droppedBlocks,
      maxTokens,
    };
  }

  return {
    get,
    list,
    getActive,
    createVersion,
    diffVersions,
    detectConflicts,
    listConflicts,
    resolveConflict,
    activate,
    rollback,
    renderForContext,
    normalizeLayers,
    scopeId,
  };
}
