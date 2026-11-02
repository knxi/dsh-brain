// @ts-check
/**
 * 准入闸门：凭据 + Host + Origin 三重限制。
 *
 * 威胁模型（本机服务，真正的风险不是「远程攻击者」，而是）：
 * 1. **浏览器里的其它网页** ← 用 Origin 检查 + 强制自定义头 + 无 CORS 头来挡；
 * 2. **DNS rebinding** ← 用 Host 白名单挡（浏览器会把攻击者域名放进 Host）；
 * 3. **本机其它进程** ← 用凭据挡（文件 0600，凭据不出现在 URL/日志）；
 * 4. **凭据泄漏到历史/书签/代理日志** ← 凭据只走 Authorization 头，绝不接受 query 参数。
 *
 * 这些检查是**叠加**的，任意一条不满足就拒绝——不做「凭据对了就放行一切」。
 */

import { createHash, timingSafeEqual } from 'node:crypto';

/** 401 应答头：告诉客户端该怎么带凭据（`WWW-Authenticate` 不带 realm 细节）。 */
export const UNAUTHORIZED_HEADERS = Object.freeze({
  'WWW-Authenticate': 'Bearer realm="dsh-brain-console"',
});

/** 认证失败计数窗口（毫秒）。 */
const FAILURE_WINDOW_MS = 60_000;

/** 单窗口内允许的认证失败次数，超过则 429。 */
const MAX_FAILURES = 12;

/**
 * 定长常量时间比较。长度不同也必须比较完，避免用长度泄漏信息。
 * @param {string} a
 * @param {string} b
 */
function constantTimeEqual(a, b) {
  // 先各自 sha256 成 32 字节定长摘要，再 timingSafeEqual —— 与明文长度无关。
  const ha = createHash('sha256').update(String(a), 'utf8').digest();
  const hb = createHash('sha256').update(String(b), 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/**
 * 从请求里取凭据。**只认 header**：
 * - `Authorization: Bearer <token>`（首选）
 * - `X-Brain-Token: <token>`（curl 手测方便）
 *
 * 显式**不读** `?token=` / `?apiKey=` / Cookie —— 那几个位置都会留下痕迹。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ token: string | null, source: string }}
 */
export function extractToken(req) {
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return { token: m[1].trim(), source: 'authorization' };
    return { token: null, source: 'authorization-malformed' };
  }
  const header = req.headers['x-brain-token'];
  if (typeof header === 'string' && header.trim().length > 0) {
    return { token: header.trim(), source: 'x-brain-token' };
  }
  return { token: null, source: 'none' };
}

/**
 * @typedef {Object} GuardOptions
 * @property {string} token 期望的凭据
 * @property {number} port 实际监听端口（Host/Origin 校验要用）
 * @property {boolean} [enforceOrigin] 默认 true
 * @property {number} [maxFailures]
 */

/**
 * @typedef {Object} GuardVerdict
 * @property {boolean} ok
 * @property {number} [status]
 * @property {string} [code]
 * @property {string} [message]
 * @property {Record<string, string>} [headers]
 * @property {string} [via] 凭据来源（日志用，脱敏后写）
 */

/**
 * 创建准入闸门。
 * @param {GuardOptions} options
 */
export function createGuard(options) {
  const expected = String(options.token);
  const port = Number(options.port);
  const enforceOrigin = options.enforceOrigin !== false;
  const maxFailures = options.maxFailures ?? MAX_FAILURES;

  /** 允许的 Host（含端口）。同一台机器上的回环名，公网名字一律不在表内。 */
  const allowedHosts = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  /** 允许的 Origin（浏览器发起的请求会带它）。 */
  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);

  /** @type {Map<string, { count: number, resetAt: number }>} */
  const failures = new Map();

  /**
   * @param {string} key
   * @param {number} now
   */
  function failureCount(key, now) {
    const entry = failures.get(key);
    if (!entry || entry.resetAt <= now) return 0;
    return entry.count;
  }

  /**
   * @param {string} key
   * @param {number} now
   */
  function recordFailure(key, now) {
    const entry = failures.get(key);
    if (!entry || entry.resetAt <= now) {
      failures.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
      return;
    }
    entry.count += 1;
  }

  /**
   * @param {string} key
   * @param {number} now
   */
  function retryAfterSeconds(key, now) {
    const entry = failures.get(key);
    if (!entry) return Math.ceil(FAILURE_WINDOW_MS / 1000);
    return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
  }

  /**
   * **只**做 Host 校验。静态资源（页面）也必须过这一道：
   *
   * 页面里内嵌了凭据（走 `<meta>`）。如果攻击者能用 DNS rebinding 把 `evil.example`
   * 解析到 127.0.0.1，那么他页面里的 `<iframe>`/`fetch` 就与我们的页面**同源**，
   * 能直接读 DOM、读 `<meta>` 里的凭据。挡这个的唯一手段就是 Host 白名单——
   * 浏览器把攻击者域名放进 `Host`，不是 127.0.0.1，于是被拒。
   *
   * 之所以页面允许匿名 GET（不带凭据）：跨源读不到响应体（无 CORS 头），
   * 本机其它进程本来就能读 0600 的凭据文件，注射 HTML 不降低实际安全性。
   * 但 rebinding 是**真能读**的，所以 Host 检查不能省。
   *
   * @param {import('node:http').IncomingMessage} req
   * @returns {GuardVerdict}
   */
  function checkHost(req) {
    const host = typeof req.headers.host === 'string' ? req.headers.host.toLowerCase() : '';
    if (host.length === 0 || !allowedHosts.has(host)) {
      return {
        ok: false,
        status: 403,
        code: 'HOST_NOT_ALLOWED',
        message: 'Host 不在允许列表内（本服务只服务 127.0.0.1）',
      };
    }
    return { ok: true };
  }

  /**
   * 判定一次请求是否放行。
   * @param {import('node:http').IncomingMessage} req
   * @param {{ now?: number, remoteAddress?: string }} [ctx]
   * @returns {GuardVerdict}
   */
  function check(req, ctx = {}) {
    const now = ctx.now ?? Date.now();
    const key = ctx.remoteAddress ?? req.socket.remoteAddress ?? 'unknown';

    // ---- 1. Host：挡 DNS rebinding。缺失或不在白名单一律拒绝。
    const hostVerdict = checkHost(req);
    if (!hostVerdict.ok) return hostVerdict;

    // ---- 2. Origin / Referer：挡「浏览器里的其它网页」。
    //   没有 Origin 且没有 Referer = 本机进程（curl / 脚本 / 测试），靠凭据把关。
    if (enforceOrigin) {
      const origin = typeof req.headers.origin === 'string' ? req.headers.origin.toLowerCase() : '';
      if (origin.length > 0 && origin !== 'null' && !allowedOrigins.has(origin)) {
        return {
          ok: false,
          status: 403,
          code: 'ORIGIN_NOT_ALLOWED',
          message: 'Origin 不在允许列表内',
        };
      }
      if (origin === 'null') {
        return {
          ok: false,
          status: 403,
          code: 'ORIGIN_NOT_ALLOWED',
          message: '拒绝 opaque origin（file:// / sandbox iframe）',
        };
      }
      const referer = typeof req.headers.referer === 'string' ? req.headers.referer.toLowerCase() : '';
      if (origin.length === 0 && referer.length > 0) {
        let refOrigin = '';
        try {
          refOrigin = new URL(referer).origin.toLowerCase();
        } catch {
          refOrigin = '';
        }
        if (refOrigin.length === 0 || !allowedOrigins.has(refOrigin)) {
          return {
            ok: false,
            status: 403,
            code: 'ORIGIN_NOT_ALLOWED',
            message: 'Referer 的 origin 不在允许列表内',
          };
        }
      }
    }

    // ---- 3. 失败计数：先看是否已被限流。
    if (failureCount(key, now) >= maxFailures) {
      return {
        ok: false,
        status: 429,
        code: 'TOO_MANY_AUTH_FAILURES',
        message: '认证失败次数过多，请稍后再试',
        headers: { 'Retry-After': String(retryAfterSeconds(key, now)) },
      };
    }

    // ---- 4. 凭据：只认 header，不接受 query。
    const { token, source } = extractToken(req);
    if (token === null) {
      recordFailure(key, now);
      return {
        ok: false,
        status: 401,
        code: 'UNAUTHORIZED',
        message: '缺少凭据（Authorization: Bearer <token>）',
        headers: UNAUTHORIZED_HEADERS,
      };
    }
    if (!constantTimeEqual(token, expected)) {
      recordFailure(key, now);
      return {
        ok: false,
        status: 401,
        code: 'UNAUTHORIZED',
        message: '凭据不正确',
        headers: UNAUTHORIZED_HEADERS,
      };
    }

    failures.delete(key);
    return { ok: true, via: source };
  }

  return { check, checkHost, allowedHosts: [...allowedHosts], allowedOrigins: [...allowedOrigins] };
}
