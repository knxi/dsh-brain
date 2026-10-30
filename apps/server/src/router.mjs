// @ts-check
/**
 * 极简路由：按路径段匹配，参数全部走命名捕获。
 *
 * 安全要点：
 * - 只解析 `url.pathname`，**从不**用路径拼文件系统路径（静态资源走固定白名单表）；
 * - 段内先 decode 再校验，拒绝 `..` / `.` / 空段 / `%2f` `%5c`（编码后的分隔符）/ NUL；
 * - 不匹配 → 404；方法不匹配 → 405 并给 `Allow` 头。
 */

/** 一个 URL 路径段里绝对不允许出现的东西。 */
const FORBIDDEN_SEGMENT = /(\u0000|%2f|%5c|%00|\\)/i;

/**
 * 解析路径为段数组。任何可疑形态直接返回 null 让调用方回 400。
 * @param {string} rawPath
 * @returns {string[] | null}
 */
export function parsePath(rawPath) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  if (!rawPath.startsWith('/')) return null;
  if (rawPath.length > 1024) return null;
  const rawSegments = rawPath.split('/').slice(1);
  /** @type {string[]} */
  const segments = [];
  for (const raw of rawSegments) {
    if (raw.length === 0) continue; // 尾斜杠、重复斜杠：忽略
    if (FORBIDDEN_SEGMENT.test(raw)) return null;
    let decoded;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null; // 非法百分号编码
    }
    // decode 之后还要再看一遍：%2e%2e 解出来就是 ..
    if (decoded === '.' || decoded === '..') return null;
    if (decoded.includes('/') || decoded.includes('\\') || decoded.includes('\u0000')) return null;
    if (decoded.length > 200) return null;
    segments.push(decoded);
  }
  return segments;
}

/**
 * @typedef {Object} RouteContext
 * @property {import('node:http').IncomingMessage} req
 * @property {import('node:http').ServerResponse} res
 * @property {URL} url
 * @property {Record<string, string>} params
 * @property {string[]} segments
 */

/**
 * @typedef {Object} Route
 * @property {'GET'|'POST'|'DELETE'|'PUT'|'PATCH'} method
 * @property {string[]} pattern 例如 ['api','memories',':id']
 * @property {(ctx: RouteContext) => unknown | Promise<unknown>} handler
 */

/**
 * 编译路由表。
 * @param {Route[]} routes
 */
export function createRouter(routes) {
  const compiled = routes.map((route) => ({
    ...route,
    keys: route.pattern.filter((p) => p.startsWith(':')).map((p) => p.slice(1)),
    literals: route.pattern.filter((p) => !p.startsWith(':')),
  }));

  /**
   * 返回**所有**路径匹配的候选（按 method 再筛），这样路径对但方法错时能给出准确的 405 + Allow。
   * @param {string[]} segments
   * @returns {Array<{ route: Route, params: Record<string,string> }>}
   */
  function match(segments) {
    /** @type {Array<{ route: Route, params: Record<string,string> }>} */
    const candidates = [];
    for (const route of compiled) {
      if (route.pattern.length !== segments.length) continue;
      /** @type {Record<string,string>} */
      const params = {};
      let ok = true;
      for (let i = 0; i < route.pattern.length; i += 1) {
        const part = route.pattern[i];
        if (part.startsWith(':')) {
          params[part.slice(1)] = segments[i];
        } else if (part !== segments[i]) {
          ok = false;
          break;
        }
      }
      if (ok) candidates.push({ route, params });
    }
    return candidates;
  }

  return { match, routes: compiled };
}
