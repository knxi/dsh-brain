// @ts-check
/**
 * HTTP 底层工具：统一响应、错误映射、有界请求体读取、安全响应头。
 *
 * 纪律：
 * - **所有**响应都带 `Cache-Control: no-store`（检查器数据不许进浏览器缓存）；
 * - **所有**响应都带 nosniff / 禁止引用 / 禁止被嵌框；
 * - 错误响应只回稳定错误码与一句话，不回 SQL、不回栈、不回正文。
 */

/** 统一响应头（每个响应都带）。 */
export const BASE_HEADERS = Object.freeze({
  'Cache-Control': 'no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
});

/** 页面 CSP：只允许同源脚本与样式，没有任何内联脚本（凭据走 meta 标签，不走内联 JS）。 */
export const CONSOLE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * @param {import('node:http').ServerResponse} res
 * @param {Record<string, string>} [extra]
 */
function headersWith(res, extra = {}) {
  return { ...BASE_HEADERS, ...extra };
}

/**
 * 发 JSON。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 * @param {Record<string, string>} [extra]
 */
export function sendJson(res, status, body, extra = {}) {
  let payload;
  try {
    payload = JSON.stringify(body ?? null);
  } catch (err) {
    // 序列化失败不能把错误细节回给客户端。
    payload = JSON.stringify({ error: { code: 'SERIALIZE_ERROR', message: '响应序列化失败' } });
    status = 500;
  }
  res.writeHead(
    status,
    headersWith(res, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(Buffer.byteLength(payload)),
      ...extra,
    }),
  );
  res.end(payload);
}

/**
 * 发文本（静态资源）。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} contentType
 * @param {string | Buffer} body
 * @param {Record<string, string>} [extra]
 */
export function sendText(res, status, contentType, body, extra = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  res.writeHead(
    status,
    headersWith(res, {
      'Content-Type': contentType,
      'Content-Length': String(buf.byteLength),
      ...extra,
    }),
  );
  res.end(buf);
}

/**
 * 统一错误响应。
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 * @param {Record<string, string>} [extra]
 */
export function sendError(res, status, code, message, details, extra = {}) {
  /** @type {Record<string, unknown>} */
  const error = { code, message };
  if (details && Object.keys(details).length > 0) error.details = details;
  sendJson(res, status, { error }, extra);
}

/**
 * 业务错误 → HTTP 状态。
 * @param {unknown} err
 * @returns {{ status: number, code: string, message: string, details?: Record<string, unknown> }}
 */
export function mapError(err) {
  const code = typeof (/** @type {any} */ (err)?.code) === 'string' ? /** @type {any} */ (err).code : '';
  const message =
    err instanceof Error && typeof err.message === 'string' && err.message.length > 0
      ? err.message
      : '内部错误';
  /** @type {Record<string, unknown>} */
  let details = {};
  if (err && typeof (/** @type {any} */ (err).details) === 'object' && /** @type {any} */ (err).details) {
    details = /** @type {Record<string, unknown>} */ (/** @type {any} */ (err).details);
  }

  switch (code) {
    case 'INVALID_ARGUMENT':
    case 'ENVELOPE_INVALID':
      return { status: 400, code, message, details };
    case 'NOT_FOUND':
      return { status: 404, code, message, details };
    case 'EVENT_CONFLICT':
    case 'DELETION_BARRIER':
      return { status: 409, code, message, details };
    case 'NOT_AVAILABLE':
      // 501：能力还没接入。跟 500（真出错）分开，界面才能说「尚未接入」而不是「服务坏了」。
      return { status: 501, code, message, details };
    case 'CAPABILITY_REQUIRED':
    case 'ISOLATED_INSTANCE':
      return { status: 403, code, message, details };
    case 'CONFIRMATION_REQUIRED':
      return { status: 400, code, message, details };
    case 'STORAGE_BUSY':
      return { status: 503, code, message, details };
    case 'QUEUE_CLOSED':
      return { status: 503, code, message, details };
    case 'STORAGE_FULL':
      return { status: 507, code, message, details };
    case 'STORAGE_READONLY':
      return { status: 403, code, message, details };
    case 'STORAGE_CORRUPT':
      return { status: 500, code, message, details };
    case 'PAYLOAD_TOO_LARGE':
      // 413：请求体超过上限（readBody 在累积超限时就拒，不等读完，避免 OOM）。
      //
      // 2026-10-29 补：这个分支原来**漏了**。readBody 明明设了 err.status = 413，
      // 但 mapError 只按 code 查表，没有这个 case 就落进 default 回 500 ——
      // 客户端分不清「我发太大了」和「服务内部坏了」。
      // 行为上一直是安全的（不读完、不落库、不崩），错的只是状态码。
      return { status: 413, code, message, details };
    default:
      return { status: 500, code: code || 'INTERNAL_ERROR', message };
  }
}

/**
 * 有界读取请求体。超过上限立刻 413 并且不再累积——不能靠 Content-Length 自报。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<string>}
 */
export function readBody(req, options = {}) {
  const limit = options.limit ?? 64 * 1024;
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    let settled = false;
    const fail = (/** @type {Error & {status?: number, code?: string}} */ err) => {
      if (settled) return;
      settled = true;
      req.removeAllListeners('data');
      req.removeAllListeners('end');
      req.resume(); // 丢弃剩余字节，避免连接挂住
      reject(err);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        const err = /** @type {Error & {status?: number, code?: string}} */ (
          new Error(`请求体超过 ${limit} 字节上限`)
        );
        err.status = 413;
        err.code = 'PAYLOAD_TOO_LARGE';
        fail(err);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => fail(/** @type {Error} */ (err)));
  });
}

/**
 * 读取并解析 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req
 * @param {{ limit?: number }} [options]
 * @returns {Promise<unknown>}
 */
export async function readJson(req, options = {}) {
  const raw = await readBody(req, options);
  if (raw.trim().length === 0) {
    const err = /** @type {Error & {status?: number, code?: string}} */ (new Error('请求体为空'));
    err.status = 400;
    err.code = 'INVALID_ARGUMENT';
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    const err = /** @type {Error & {status?: number, code?: string}} */ (new Error('请求体不是合法 JSON'));
    err.status = 400;
    err.code = 'INVALID_ARGUMENT';
    throw err;
  }
}
