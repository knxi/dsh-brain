// @ts-check
/**
 * 中文检索文本的规范化、切分与 n-gram 生成。
 *
 * 设计直接来自实测结论（见 docs/search-capability-report.md）：
 * - 本机 SQLite 3.53.3 的 unicode61 把「连续中文 + 相邻数字」当成**一个 token**
 *   （实测 fts5vocab 里出现 `03图里首层平面标高是0` 这种 term），所以原文直接进
 *   unicode61 索引时，中文词、两字词、中文与数字相邻的编号全部搜不到。
 * - 兜底做法：入库与查询两侧都先把 CJK 字符逐个用空格隔开（`char-space`），
 *   ASCII 词、数字、版本号、符号保持原样。这样 unicode61 得到的 token 就是
 *   单字 + 完整 ASCII 词，两字词可用 phrase 查询，单字可用单 token 查询。
 * - 保存两份文本：原文（content）不动，检索副本（searchable text）做规范化。
 *   规范化只用于检索，不可逆清洗不落到原文。
 */

/** CJK 与假名、谚文的字符范围（用于切分与 n-gram）。 */
const CJK_CLASS = '\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uac00-\\ud7af';
const CJK_ONE = new RegExp(`[${CJK_CLASS}]`, 'u');
const CJK_G = new RegExp(`[${CJK_CLASS}]`, 'gu');
/** 段切分符：空白 + 中文标点。`:` `-` `.` `/` `×` 故意保留在段内，交给 tokenizer。 */
const SEGMENT_SEP = /[\s,;!?()[\]{}<>。、…—～·「」『』【】《》""'']+/u;

/**
 * 检索用的规范化：NFKC + 小写。
 * 只用于检索副本，不写回原文。数字/单位/版本号在 NFKC 下逐字符不变
 * （1.2m / 1200mm / 2400×600 / 建施-03 / JS-2026-017 / M100 已实测，见报告）。
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeForSearch(raw) {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase();
}

/**
 * 字符级切分：CJK 逐字加空格，数字与字母的边界加空格，其余保持原 token 边界。
 *
 * `用readSurface读取` -> `用 readsurface 读 取`
 * `建施-03图里标高` -> `建 施 -03 图 里 标 高`
 * `1440dpi` -> `1440 dpi`，`250g` -> `250 g`：实测「查 dpi 漏掉 1440dpi」后补的规则。
 * 查询侧同样切分，所以查 `1440dpi` 仍是相邻 phrase，不会丢精确性。
 * @param {unknown} raw
 * @returns {string} 规范化并切分后的检索文本
 */
export function toSearchableText(raw) {
  return normalizeForSearch(raw)
    .replace(CJK_G, (ch) => ` ${ch} `)
    .replace(/([0-9])([a-z])/g, '$1 $2')
    .replace(/([a-z])([0-9])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 把用户查询切成若干「段」，段内是精确短语，段间是 AND。
 * 段切分只认空白与中文标点；`build:web`、`1.2m`、`建施-03` 留在同一段内。
 * @param {unknown} raw
 * @returns {string[]} 规范化后的原始段（未做 char-space）
 */
export function querySegments(raw) {
  return normalizeForSearch(raw)
    .split(SEGMENT_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 段内的「检索 token」：char-space 之后的 token 列表（已小写）。
 * 用于判断查询是否有有效内容、拼装 phrase 查询、以及算覆盖度。
 * @param {string} segment
 * @returns {string[]}
 */
export function segmentTokens(segment) {
  return toSearchableText(segment).split(' ').filter(Boolean);
}

/**
 * 构造 FTS5 MATCH 查询串。
 *
 * 实测：把用户输入原样丢给 MATCH 会直接报错——
 *   `建施-03` / `JS-2026-017` -> `no such column: 03` / `no such column: 2026`
 *   `1.2m` -> `fts5: syntax error near "."`
 *   `build:web` -> `no such column: build`
 * 所以每个 token 必须落在双引号 phrase 里，内部 `"` 转义成 `""`。
 *
 * @param {unknown} raw
 * @param {{ mode?: 'phrase'|'and'|'or'|'adaptive', maxPhraseTokens?: number }} [opts]
 *   mode='adaptive'（默认，实测最优）：段内 token 数 <= maxPhraseTokens 时用 phrase
 *     （短查询要精确相邻，「铜版」不该匹配到「铜…版」分开出现的句子）；
 *     超过则退化为 OR（口语长查询「上次那个铜版纸名片的报价是多少」里的虚词
 *     不能把结果 AND 死；靠 bm25 的 idf 把「的/是/多少」自动压权）。
 *   mode='phrase'：全部段内相邻；mode='and'：所有 token 只要求 AND；
 *   mode='or'：段内全部 OR。
 * @returns {{ ok: boolean, query: string, tokens: string[], segments: number, mode: string, reason?: string }}
 */
export function buildFtsMatch(raw, opts = {}) {
  const mode = opts.mode ?? 'adaptive';
  const maxPhraseTokens = opts.maxPhraseTokens ?? 4;
  const segs = querySegments(raw);
  /** @type {string[]} */
  const parts = [];
  /** @type {string[]} */
  const allTokens = [];
  for (const seg of segs) {
    const toks = segmentTokens(seg);
    if (!toks.length) continue;
    allTokens.push(...toks);
    const quoted = toks.map((t) => `"${t.replaceAll('"', '""')}"`);
    if (mode === 'and') {
      // 每段拆成独立 token 时，段内也是 AND
      parts.push(...quoted);
    } else if (mode === 'or' || (mode === 'adaptive' && toks.length > maxPhraseTokens)) {
      // OR 组必须加括号：否则和相邻段的结合顺序会错
      parts.push(quoted.length === 1 ? quoted[0] : `(${quoted.join(' OR ')})`);
    } else if (toks.length === 1) {
      parts.push(quoted[0]);
    } else {
      // phrase：一个引号内有空格，FTS5 视为相邻序列（这是**段内**，不是段间，不要改成 AND）
      parts.push(`"${toks.map((t) => t.replaceAll('"', '""')).join(' ')}"`);
    }
  }
  if (!parts.length) return { ok: false, query: '', tokens: [], segments: segs.length, mode, reason: 'no_tokens' };
  // 段间一律显式 `AND`，**不能用空格**（隐式 AND）。
  //
  // 这是集成期挖出来的真 bug（M2 memory2 报，FTS5 行为在纯 :memory: 虚表上钉过）：
  // FTS5 不接受「括号组后面直接跟 phrase」——
  //   ("展" OR "板") "尺"                 -> fts5: syntax error near ""尺""
  //   ("展" OR "板") AND "尺"             -> ok
  //   ("展" OR "板" OR "成") "铝 板 厚 度" -> fts5: syntax error near ""铝 板 厚 度""
  // 触发条件 = 多段查询里前一段 token 数 > maxPhraseTokens（走 OR 分支）、后面还有段。
  // 真实输入 `展板成品尺寸 铝板厚度` 正好命中：整条查询抛错 → 调用方的整条检索被拖进降级。
  // 纯 phrase 段之间用空格本来合法，但统一写 `AND` 才不会再踩这一整类。
  return { ok: true, query: parts.join(' AND '), tokens: allTokens, segments: segs.length, mode };
}

/**
 * 生成 n-gram 倒排项（自维护索引用，不依赖 FTS5）。
 *
 * 规则（都由实测召回率决定，见报告 4.3）：
 * - CJK 连续段：单字 + 相邻双字（bigram）。
 * - ASCII/数字连续段：整 token；长度 >= 3 时额外补 3-gram，兼顾子串与标识符。
 * - 权重：bigram=2，CJK 单字=1，ASCII 整 token=2，ASCII 3-gram=1。
 *
 * @param {unknown} raw
 * @returns {Map<string, number>} term -> weight
 */
export function ngramTerms(raw) {
  const text = normalizeForSearch(raw);
  /** @type {Map<string, number>} */
  const out = new Map();
  const bump = (term, w) => {
    if (!term) return;
    out.set(term, Math.max(out.get(term) ?? 0, w));
  };
  // 把文本切成「CJK 段」与「非 CJK 段」交替
  const runs = text.match(new RegExp(`[${CJK_CLASS}]+|[^${CJK_CLASS}]+`, 'gu')) ?? [];
  for (const run of runs) {
    if (CJK_ONE.test(run)) {
      const chars = [...run];
      for (const ch of chars) bump(ch, 1);
      for (let i = 0; i + 1 < chars.length; i += 1) bump(chars[i] + chars[i + 1], 2);
    } else {
      // 非 CJK：按空白与标点切出 token
      for (const tok of run.split(/[^\p{L}\p{N}_]+/u)) {
        const t = tok.trim();
        if (!t) continue;
        bump(t, 2);
        if ([...t].length >= 3) {
          const cs = [...t];
          for (let i = 0; i + 3 <= cs.length; i += 1) bump(cs.slice(i, i + 3).join(''), 1);
        }
      }
    }
  }
  return out;
}

/**
 * 查询的覆盖度：命中的 n-gram 权重之和 / 查询总权重。
 * 用于区分「有相关记忆」与「可能相关但证据不够」——不拿相似结果硬凑。
 * @param {Map<string, number>} queryTerms
 * @param {Set<string>} docTerms
 * @returns {number} 0..1
 */
export function coverageOf(queryTerms, docTerms) {
  let total = 0;
  let hit = 0;
  for (const [term, w] of queryTerms) {
    total += w;
    if (docTerms.has(term)) hit += w;
  }
  return total === 0 ? 0 : hit / total;
}

/**
 * 把查询 token 集合（用于对候选做覆盖度复核）。
 * @param {unknown} raw
 * @returns {Map<string, number>}
 */
export function queryTermWeights(raw) {
  return ngramTerms(raw);
}

/** 导出常量给测试与实验用。 */
export const INTERNALS = { CJK_CLASS, SEGMENT_SEP, CJK_ONE };
