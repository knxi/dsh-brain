// @ts-check
/**
 * Token 估算。
 *
 * 纪律（CONTRACTS §6）：
 * - **拿不到真 tokenizer 就不许假装精确**。这里返回的是**上界估算**，
 *   `tokenizerId` 一律带 `estimate:` 前缀，检查器看到就知道这不是实测值。
 * - 宁可高估、不可低估：低估会让最终请求悄悄超窗，而超窗是毁回合的错。
 *
 * 估算口径（写死、可测）：
 * - CJK 字符（汉字/假名/谚文/全角标点）：1 字符 → 1 token（这是上界；真实约 0.6）
 * - 其它字符：4 字符 → 1 token（英文/数字/ASCII 标点的常见近似）
 * - 结果向上取整
 *
 * 之所以不用「统一 chars/2.5」：中文里 2.5 字符约 1.5 token，会低估 1.5 倍，
 * 正好是会把预算算飞的那一侧。
 */

/** 估算口径的稳定标识，写进 `tokenizerId`。 */
export const ESTIMATE_TOKENIZER_ID = 'estimate:cjk1/ascii4';

/** CJK 一个字符折 1 token 的上界。 */
export const CJK_TOKENS_PER_CHAR = 1;
/** 非 CJK 每 4 个字符折 1 token。 */
export const ASCII_CHARS_PER_TOKEN = 4;

/**
 * 是否按「CJK 高成本字符」计价。
 *
 * 覆盖：CJK 统一表意（含扩展 A）、CJK 标点、假名、谚文、全角形式。
 * 这些字符在多数 BPE 词表里都占 1 个以上 token，按 1 估只会偏高，不会偏低。
 *
 * @param {number} codePoint
 * @returns {boolean}
 */
export function isCjkCodePoint(codePoint) {
  return (
    (codePoint >= 0x3000 && codePoint <= 0x303f) || // CJK 标点
    (codePoint >= 0x3040 && codePoint <= 0x30ff) || // 平假名 / 片假名
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) || // CJK 扩展 A
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) || // CJK 基本区
    (codePoint >= 0xac00 && codePoint <= 0xd7af) || // 谚文音节
    (codePoint >= 0xf900 && codePoint <= 0xfaff) || // CJK 兼容表意
    (codePoint >= 0xff00 && codePoint <= 0xffef) || // 全角形式
    (codePoint >= 0x20000 && codePoint <= 0x2ffff) // CJK 扩展 B 及以后
  );
}

/**
 * 估算一段文本的 Token（上界）。
 *
 * @param {unknown} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let cjkChars = 0;
  let otherChars = 0;
  for (const char of text) {
    const codePoint = /** @type {number} */ (char.codePointAt(0));
    if (isCjkCodePoint(codePoint)) cjkChars += 1;
    else otherChars += 1;
  }
  const tokens = cjkChars * CJK_TOKENS_PER_CHAR + otherChars / ASCII_CHARS_PER_TOKEN;
  return Math.ceil(tokens);
}

/**
 * 估算口径的自证说明（给检查器/日志看，不含正文）。
 *
 * @returns {{ tokenizerId: string, exact: false, note: string }}
 */
export function describeTokenizer() {
  return {
    tokenizerId: ESTIMATE_TOKENIZER_ID,
    exact: false,
    note: '估算：CJK 1 字符按 1 token、其它 4 字符按 1 token 取上界；不是实测 tokenizer，不保证精确。',
  };
}
