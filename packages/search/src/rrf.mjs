// @ts-check
/**
 * RRF（Reciprocal Rank Fusion）融合。
 *
 * 用途：把「主路 FTS5-char-space」「补充路 FTS5-trigram」「兜底路 自维护 n-gram」
 * 三路排序融合成一个排序，而不是拿某一套相似度分数硬拼。
 * 契约 §7 要求「不用相似结果硬凑」，所以融合结果必须带上每一路是否命中
 * （matchedBy），供上层判断证据强弱。
 *
 * 标准 RRF：score(d) = Σ_r w_r / (k + rank_r(d))，rank 从 1 开始。
 */

/**
 * @typedef {{ id: string, score: number, matchedBy?: string[] }} RankedItem
 * @typedef {{ route: string, items: RankedItem[] }} RankedList
 */

/**
 * @param {RankedList[]} lists
 * @param {{ k?: number, weights?: Record<string, number>, limit?: number }} [opts]
 * @returns {{ id: string, score: number, matchedBy: string[], ranks: Record<string, number> }[]}
 */
export function rrfFuse(lists, opts = {}) {
  const k = opts.k ?? 60;
  const weights = opts.weights ?? {};
  const limit = opts.limit ?? 50;
  /** @type {Map<string, { id: string, score: number, matchedBy: string[], ranks: Record<string, number> }>} */
  const acc = new Map();
  for (const list of lists) {
    const w = weights[list.route] ?? 1;
    // 权重 0 表示这一路只用于诊断（例如 char 已足够覆盖时不让 ngram 噪声进排序）
    if (w <= 0) continue;
    list.items.forEach((item, i) => {
      const rank = i + 1;
      const cur = acc.get(item.id) ?? { id: item.id, score: 0, matchedBy: [], ranks: {} };
      cur.score += w / (k + rank);
      cur.ranks[list.route] = rank;
      if (!cur.matchedBy.includes(list.route)) cur.matchedBy.push(list.route);
      acc.set(item.id, cur);
    });
  }
  return [...acc.values()].sort((a, b) => (b.score - a.score) || (a.id < b.id ? -1 : 1)).slice(0, limit);
}

/**
 * 单路排名的归一化分数（仅用于同一条路内部排序，不跨路比较）。
 * @param {{ id: string, score: number }[]} items
 */
export function normalizeScores(items) {
  if (!items.length) return [];
  const max = Math.max(...items.map((i) => i.score));
  const min = Math.min(...items.map((i) => i.score));
  const span = max - min;
  return items.map((i) => ({
    id: i.id,
    score: span === 0 ? 1 : (i.score - min) / span,
    matchedBy: [],
  }));
}
