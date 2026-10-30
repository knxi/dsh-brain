// @ts-check
/**
 * 服务日志：结构化、脱敏、**凭据永不入日志**（CONTRACTS 第 12 节第 4 条）。
 *
 * 设计：
 * - 所有登记为 secret 的字符串在输出前被替换成 `[redacted]`；
 * - 请求行只记 method / 脱敏后的 path / 状态码 / 耗时 / 字节数；
 * - 不记 Authorization 头、不记 Cookie、不记请求体正文；
 * - 落 stderr（stdout 留给启动信息，便于 `> file` 分离）。
 */

import { randomBytes } from 'node:crypto';

/** @type {Set<string>} 需要脱敏的值（凭据本体）。 */
const secrets = new Set();

/** @type {Array<[RegExp, string]>} 追加的脱敏规则。 */
const rules = [];

const LEVELS = /** @type {const} */ ({ debug: 10, info: 20, warn: 30, error: 40, silent: 99 });

/**
 * 登记一个永不输出的值。
 * @param {string} value
 */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}

/**
 * 脱敏：把登记过的凭据与常见凭据形态从字符串里抹掉。
 * @param {string} input
 * @returns {string}
 */
export function redact(input) {
  if (typeof input !== 'string' || input.length === 0) return '';
  let out = input;
  for (const secret of secrets) {
    if (secret.length >= 8 && out.includes(secret)) out = out.split(secret).join('[redacted]');
  }
  // 兜底：即便调用方误传了 Authorization 形态也不落盘。
  out = out.replace(/\b(Bearer|Token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, '$1 [redacted]');
  out = out.replace(/\b([?&](?:token|key|secret|auth)=)[^&\s]{8,}/gi, '$1[redacted]');
  for (const [pattern, replacement] of rules) out = out.replace(pattern, replacement);
  return out;
}

/**
 * 追加一条自定义脱敏规则（例如抹掉主账绝对路径）。
 * @param {RegExp} pattern
 * @param {string} replacement
 */
export function addRedactionRule(pattern, replacement) {
  rules.push([pattern, replacement]);
}

/** 生成短请求 ID，便于把一次请求的多行日志串起来（不用于鉴权）。 */
export function newRequestId() {
  return randomBytes(4).toString('hex');
}

/**
 * @typedef {Object} Logger
 * @property {(...args: unknown[]) => void} debug
 * @property {(...args: unknown[]) => void} info
 * @property {(...args: unknown[]) => void} warn
 * @property {(...args: unknown[]) => void} error
 */

/**
 * 创建 logger。
 * @param {{ level?: string, sink?: (line: string) => void, now?: () => Date }} [options]
 * @returns {Logger}
 */
export function createLogger(options = {}) {
  const threshold = LEVELS[/** @type {keyof typeof LEVELS} */ (options.level ?? 'info')] ?? LEVELS.info;
  const sink =
    options.sink ??
    ((line) => {
      process.stderr.write(`${line}\n`);
    });

  /**
   * @param {keyof typeof LEVELS} level
   * @param {unknown[]} args
   */
  function emit(level, args) {
    if (LEVELS[level] < threshold) return;
    const d = (options.now ?? (() => new Date()))();
    const stamp = d.toISOString().slice(11, 23);
    const body = args
      .map((arg) => {
        if (arg instanceof Error) return redact(`${arg.name}: ${arg.message}`);
        if (typeof arg === 'string') return redact(arg);
        try {
          return redact(JSON.stringify(arg));
        } catch {
          return '[unserializable]';
        }
      })
      .join(' ');
    sink(`${stamp} ${level.toUpperCase().padEnd(5)} ${body}`);
  }

  return {
    debug: (...args) => emit('debug', args),
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
  };
}

/** 静默 logger（测试用）。 */
export const silentLogger = /** @type {Logger} */ ({
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
});
