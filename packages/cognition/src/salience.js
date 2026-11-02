// @ts-check
/**
 * `salience` —— 显著性标记器（杏仁核）。
 *
 * ── 它回答一个问题：这条记忆「该不该更容易被想起来」 ──
 *
 * 注意用词：是「更容易被想起来」，不是「更可信」。方案把这两件事分开是有道理的：
 * 一条带着强烈情绪的记忆可能完全记错（吵架时说错的话、深夜的错觉），
 * 而一条平淡的事实（名片 300g / 90×54mm）可能恰恰是每天要用的。
 * 所以本模块只写 `memory_salience`，**绝不改 memories 的 source_type / importance / 正文**
 * ——情绪标记不是证据，显著性不能把 observation 升格成事实。
 *
 * ── 为什么独立成表（0008 文件头第三条）──
 *
 * 显著性是可回滚的派生物：标记器改了规则，整张标记表可以从零重算（原始记忆不动）。
 * 如果把它写成 memories 的一列，重算就得改主账行，而主账行每一次改动都要留版本
 * 与来源，成本远高于收益。
 *
 * ── 三条纪律 ──
 *
 * 1. **只加权重不改排序主序**：`salienceBoost()` 的上限是 0.15，相关性（检索命中）
 *    才是主序。显著性再高也不能让一条不相关的记忆挤掉相关结果（见 MAX_SALIENCE_BOOST 注释）。
 * 2. **没标记 ≠ 不重要**：表里没有这一行表示「还没评估过」（哨兵语义，与 events 里
 *    可空的 salience 一致）。读取方必须把两者分开，不要拿 0 当「不重要」。
 * 3. **不做跨 scope**：标记与读取都强制带 scope；主键虽然只有 memory_id，
 *    但写入前会校验记忆归属，跨 scope 的一律 NOT_FOUND（不暴露存在性）。
 */

import { BrainError } from '@dsh-brain/core';
import {
  clamp01,
  createReader,
  finiteNumberOrNull,
  normalizeStringArray,
  parseStringArray,
  requireFiniteNumber,
  requireText,
  resolveScopeId,
  stringifyJson,
} from './internal.js';

/**
 * 各信号 → 显著性权重的分配。
 *
 * 为什么这样分（合计 1.0，输出天然落在 0..1）：
 *
 * - `ownerEmphasis` 0.35：**主人的语气强调是最强信号**。同样是「周四要交」，
 *   主人补一句「这个千万别忘」和随口一提，对未来的价值完全不同。这是唯一由
 *   人类意图直接注入的分量，权重必须最高。
 * - `mentionCount` 0.25：复现频率。被提起过 N 次的事，说明它在工作记忆里活着。
 *   权重低于主人强调：复读三遍的废话也很多（口头禅、每天一样的问候）。
 * - `hasCommitment` 0.25：承诺带后果。忘了承诺不是「少想起来一次」，是**违约**。
 *   给到与频率同档的权重，是因为它的代价不对称（漏掉的成本远高于多想一次的代价）。
 * - `affectIntensity` 0.15：情绪强度只影响「会不会被想起」，不影响「对不对」。
 *   权重最低：情绪是噪声最高的信号，深夜的情绪尤其不可信。
 */
export const SALIENCE_WEIGHTS = Object.freeze({
  ownerEmphasis: 0.35,
  mentionCount: 0.25,
  hasCommitment: 0.25,
  affectIntensity: 0.15,
});

/**
 * 检索排序里显著性的加成上限（0..0.15）。
 *
 * 为什么必须设上限：检索的主序是**相关性**（这条记忆是否回答了当前问题）。
 * 显著性只该在「相关性接近」时做微弱偏置。如果加成能到 0.5，
 * 一条被情绪标记过的无关记忆就会挤掉真正有用的结果——那正是「情绪劫持检索」，
 * 比没有显著性更糟。0.15 是「能感觉到，但翻不了盘」的量级。
 */
export const MAX_SALIENCE_BOOST = 0.15;

/** 提及次数的归一化饱和点：>= 10 次视为满分（再多是噪声，不再额外加权）。 */
export const MENTION_SATURATION = 10;

export const DEFAULT_SALIENCE_LIMIT = 50;
export const MAX_SALIENCE_LIMIT = 200;
export const DEFAULT_MARKED_BY = 'amygdala';

/**
 * 由四个可解释的信号算显著性（纯函数，无 IO）。
 *
 * 调用方先用它算分，再把分数交给 `markMemory()` —— 分开是为了让「为什么这条分数高」
 * 可复算、可回放。把规则藏进写库函数里，事后就只能猜。
 *
 * @param {{ ownerEmphasis?: number, mentionCount?: number, hasCommitment?: boolean | number, affectIntensity?: number }} [signals]
 * @returns {number} 0..1
 */
export function computeSalienceFromSignals(signals = {}) {
  const ownerEmphasis = clamp01(finiteNumberOrNull(signals.ownerEmphasis) ?? 0);
  const mentionRaw = finiteNumberOrNull(signals.mentionCount) ?? 0;
  // 提及次数用 log1p 归一：第 1 次提及最有信息量，第 10 次和第 11 次几乎没有区别。
  const mentionCount = mentionRaw <= 0
    ? 0
    : Math.min(1, Math.log1p(mentionRaw) / Math.log1p(MENTION_SATURATION));
  const hasCommitment = signals.hasCommitment === true || signals.hasCommitment === 1 ? 1 : 0;
  const affectIntensity = clamp01(finiteNumberOrNull(signals.affectIntensity) ?? 0);

  const score =
    SALIENCE_WEIGHTS.ownerEmphasis * ownerEmphasis +
    SALIENCE_WEIGHTS.mentionCount * mentionCount +
    SALIENCE_WEIGHTS.hasCommitment * hasCommitment +
    SALIENCE_WEIGHTS.affectIntensity * affectIntensity;

  // 保留 4 位小数：写入 REAL 列不需要更多精度，也用不着浮点尾巴。
  return Math.round(clamp01(score) * 1e4) / 1e4;
}

/**
 * 显著性 → 检索排序加成（0..MAX_SALIENCE_BOOST）。
 * 输入越界/非数一律按 0 处理：排序路径不能因为一个坏分数抛错。
 * @param {unknown} salience
 * @returns {number}
 */
export function salienceBoost(salience) {
  const value = finiteNumberOrNull(salience);
  if (value === null) return 0;
  return Math.round(MAX_SALIENCE_BOOST * clamp01(value) * 1e4) / 1e4;
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
function rowToSalience(row) {
  return {
    memoryId: String(row.memory_id),
    scopeId: String(row.scope_id),
    salience: Number(row.salience),
    valence: row.affect_valence === null || row.affect_valence === undefined ? null : Number(row.affect_valence),
    arousal: row.affect_arousal === null || row.affect_arousal === undefined ? null : Number(row.affect_arousal),
    signals: parseStringArray(row.signals_json),
    markedBy: String(row.marked_by),
    version: Number(row.version ?? 1),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * 造显著性标记器。
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
export function createSalience(options) {
  const { db, queue, clock } = options;
  const bindings = options.bindings ?? null;
  const reader = createReader(db);

  /**
   * 标记一条记忆的显著性（同 memory_id 覆盖，version+1）。
   *
   * 为什么覆盖而不是追加历史：显著性不是审计对象，是**当前权重**。
   * 需要「以前标过多少分」的场景由 ws_events（affect 渠道）承担，不在这张表里。
   *
   * @param {{
   *   memoryId: string,
   *   salience: number,
   *   valence?: number | null,
   *   arousal?: number | null,
   *   signals?: string[],
   *   markedBy?: string | null,
   *   scopeId?: string,
   * }} input
   * @returns {Promise<{ memoryId: string, scopeId: string, salience: number, valence: number | null, arousal: number | null, signals: string[], markedBy: string, version: number, created: boolean }>}
   */
  async function markMemory(input = /** @type {any} */ ({})) {
    const memoryId = requireText(input.memoryId, 'memoryId', { maxLength: 120 });
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const salience = clamp01(requireFiniteNumber(input.salience, 'salience'));
    const valence = input.valence === undefined || input.valence === null
      ? null
      : Math.min(1, Math.max(-1, requireFiniteNumber(input.valence, 'valence')));
    const arousal = input.arousal === undefined || input.arousal === null
      ? null
      : clamp01(requireFiniteNumber(input.arousal, 'arousal'));
    const signals = normalizeStringArray(input.signals, 'signals');
    const markedBy = input.markedBy === undefined || input.markedBy === null
      ? DEFAULT_MARKED_BY
      : requireText(input.markedBy, 'markedBy', { maxLength: 64 });

    // 事务外预检：归属错误必须在进入写队列之前抛（理由见 internal.requireRow 的说明）。
    // 跨 scope 一律 NOT_FOUND：不承认别的 scope 里存在这个 id（连存在性都不暴露）。
    const memory = reader.get('SELECT scope_id, status, deletion_epoch FROM memories WHERE id = ?', [memoryId]);
    if (memory === undefined || String(memory.scope_id) !== scopeId) {
      throw new BrainError('NOT_FOUND', `记忆不存在：${memoryId}`);
    }
    if (String(memory.status) === 'deleted' || Number(memory.deletion_epoch ?? 0) > 0) {
      throw new BrainError('INVALID_ARGUMENT', `已删除的记忆不得标记显著性：${memoryId}`);
    }

    return queue.write(
      (tx) => {
        // 归属校验：跨 scope 一律 NOT_FOUND（连「存在但你没有」都不承认，
        // 否则 id 探测就能推断别的 scope 有什么）。
        const memory = tx.get('SELECT scope_id, status, deletion_epoch FROM memories WHERE id = ?', [memoryId]);
        if (memory === undefined || String(memory.scope_id) !== scopeId) {
          throw new BrainError('NOT_FOUND', `记忆不存在：${memoryId}`);
        }
        if (String(memory.status) === 'deleted' || Number(memory.deletion_epoch ?? 0) > 0) {
          throw new BrainError('INVALID_ARGUMENT', `已删除的记忆不得标记显著性：${memoryId}`);
        }

        const existing = tx.get('SELECT version FROM memory_salience WHERE memory_id = ?', [memoryId]);
        const stamp = clock.stamp();
        tx.run(
          `INSERT INTO memory_salience (
             memory_id, scope_id, salience, affect_valence, affect_arousal, signals_json, marked_by,
             created_at, created_at_local, updated_at, updated_at_local, version
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
           ON CONFLICT(memory_id) DO UPDATE SET
             scope_id = excluded.scope_id,
             salience = excluded.salience,
             affect_valence = excluded.affect_valence,
             affect_arousal = excluded.affect_arousal,
             signals_json = excluded.signals_json,
             marked_by = excluded.marked_by,
             updated_at = excluded.updated_at,
             updated_at_local = excluded.updated_at_local,
             version = memory_salience.version + 1`,
          [
            memoryId,
            scopeId,
            salience,
            valence,
            arousal,
            stringifyJson(signals, 'signals', '[]'),
            markedBy,
            stamp.utc,
            stamp.local,
            stamp.utc,
            stamp.local,
          ],
        );
        const version = existing === undefined ? 1 : Number(existing.version) + 1;
        return {
          memoryId,
          scopeId,
          salience,
          valence,
          arousal,
          signals,
          markedBy,
          version,
          created: existing === undefined,
        };
      },
      { label: 'salience.markMemory' },
    );
  }

  /**
   * 读一条记忆的显著性。没有标记（或属于别的 scope）→ `null`。
   * @param {string} memoryId
   * @param {{ scopeId?: string }} [opts]
   * @returns {any | null}
   */
  function getSalience(memoryId, opts = {}) {
    const id = requireText(memoryId, 'memoryId', { maxLength: 120 });
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const row = reader.get('SELECT * FROM memory_salience WHERE memory_id = ? AND scope_id = ?', [id, scopeId]);
    return row === undefined ? null : rowToSalience(row);
  }

  /**
   * 按显著性降序列出（只含仍存活、属于本 scope 的记忆）。
   * join memories 是必要的：已删除记忆的显著性不该在人眼前出现（软删除必须由查询侧过滤）。
   * @param {{ limit?: number, scopeId?: string }} [query]
   * @returns {{ items: any[], limit: number }}
   */
  function listBySalience(query = {}) {
    const scopeId = resolveScopeId(query.scopeId, bindings);
    const limit = Math.min(
      Math.max(Number.isFinite(Number(query.limit)) ? Number(query.limit) : DEFAULT_SALIENCE_LIMIT, 1),
      MAX_SALIENCE_LIMIT,
    );
    const rows = reader.all(
      `SELECT ms.* FROM memory_salience ms
         JOIN memories m ON m.id = ms.memory_id
        WHERE ms.scope_id = ? AND m.scope_id = ?
          AND m.status <> 'deleted' AND m.deletion_epoch = 0
        ORDER BY ms.salience DESC, ms.updated_at DESC, ms.memory_id ASC
        LIMIT ?`,
      [scopeId, scopeId, limit],
    );
    return { items: rows.map(rowToSalience), limit };
  }

  /**
   * 本 scope 的标记统计（面板/验收用）。
   * @param {{ scopeId?: string }} [opts]
   * @returns {{ marked: number, avgSalience: number, maxSalience: number, newestAt: string | null }}
   */
  function stats(opts = {}) {
    const scopeId = resolveScopeId(opts.scopeId, bindings);
    const row = reader.get(
      `SELECT COUNT(*) AS n, AVG(salience) AS avg, MAX(salience) AS max, MAX(updated_at) AS newest
         FROM memory_salience WHERE scope_id = ?`,
      [scopeId],
    );
    return {
      marked: Number(row?.n ?? 0),
      avgSalience: row?.avg === null || row?.avg === undefined ? 0 : Number(row.avg),
      maxSalience: row?.max === null || row?.max === undefined ? 0 : Number(row.max),
      newestAt: row?.newest === null || row?.newest === undefined ? null : String(row.newest),
    };
  }

  return {
    markMemory,
    getSalience,
    listBySalience,
    stats,
    computeSalienceFromSignals,
    salienceBoost,
    // 常量也挂出来：面板/测试不该自己去猜上限
    SALIENCE_WEIGHTS,
    MAX_SALIENCE_BOOST,
    DEFAULT_SALIENCE_LIMIT,
  };
}
