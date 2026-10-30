// @ts-check
/**
 * HTTP 服务装配：node:http，无框架。
 *
 * 请求流水线（顺序是安全设计的一部分，不要调换）：
 *   1. 解析路径段（非法形态 → 400，宁可直接拒也不猜）
 *   2. 非 `/api/*` → 静态资源白名单（GET only）
 *   3. `/api/ping` → 免凭据的极简探活（不泄露任何内部信息）
 *   4. 其余 `/api/*` → 准入闸门（Host → Origin → 失败计数 → 凭据）
 *   5. 路由匹配（路径对方法错 → 405 + Allow）
 *   6. 执行 → 统一 JSON 响应
 *
 * 日志只记 method + pathname + 状态码 + 耗时 + 字节数：
 * **不记 query（搜索词是主人的私事）、不记 Authorization、不记请求体。**
 */

import http from 'node:http';
import { createApi } from './api.mjs';
import { createGuard } from './auth.mjs';
import { resolveConfig } from './config.mjs';
import { createGovernance } from './governance.mjs';
import { mapError, sendError, sendJson } from './http-util.mjs';
import { createLogger, newRequestId, registerSecret } from './log.mjs';
import { createRouter, parsePath } from './router.mjs';
import { openStore } from './store.mjs';

/** URL 长度上限（HTTP 层，避免超长串进解析器）。 */
const MAX_URL_LENGTH = 8192;

/**
 * 隔离实例仍允许的写操作。
 *
 * 隔离（promoted=false）时正常服务必须拒绝——但「用恢复把自己修好」是唯一出路，
 * 所以 `/api/restore/*` 放行（它们本身还有 dry-run + confirm + capability 三重闸门）。
 * 备份也放行：隔离期间先把当前坏状态留一份，是负责任的做法。
 */
const ISOLATION_ALLOWED_WRITES = new Set([
  'POST /api/restore/plan',
  'POST /api/restore/execute',
  'POST /api/backups',
]);

/**
 * 路由表。handler 统一接收 `{ req, res, url, params }`，返回 `{ status, body }`。
 * @param {ReturnType<typeof createApi>} api
 */
function buildRoutes(api) {
  return [
    { method: /** @type {const} */ ('GET'), pattern: ['api', 'ping'], run: () => api.handlers.ping() },
    { method: /** @type {const} */ ('GET'), pattern: ['api', 'health'], run: () => api.handlers.health() },
    { method: /** @type {const} */ ('GET'), pattern: ['api', 'memories'], run: (ctx) => api.handlers.listMemories(ctx.url) },
    { method: /** @type {const} */ ('POST'), pattern: ['api', 'memories'], run: (ctx) => api.handlers.createMemory(ctx.req) },
    {
      method: /** @type {const} */ ('GET'),
      pattern: ['api', 'memories', ':id'],
      run: (ctx) => api.handlers.getMemory(ctx.params, ctx.url),
    },
    {
      method: /** @type {const} */ ('DELETE'),
      pattern: ['api', 'memories', ':id'],
      run: (ctx) => api.handlers.deleteMemory(ctx.params, ctx.req),
    },
    { method: /** @type {const} */ ('GET'), pattern: ['api', 'search'], run: (ctx) => api.handlers.search(ctx.url) },
    { method: /** @type {const} */ ('GET'), pattern: ['api', 'contexts'], run: (ctx) => api.handlers.listContexts(ctx.url) },
    {
      method: /** @type {const} */ ('GET'),
      pattern: ['api', 'context', ':contextId'],
      run: (ctx) => api.handlers.getContext(ctx.params, ctx.url),
    },

    // ---- M3：删除状态 · 备份中心 · 恢复编排
    {
      method: /** @type {const} */ ('GET'),
      pattern: ['api', 'deletions'],
      run: (ctx) => api.handlers.listDeletions(ctx.url),
    },
    {
      method: /** @type {const} */ ('GET'),
      pattern: ['api', 'deletions', ':memoryId'],
      run: (ctx) => api.handlers.deletionStatus(ctx.params),
    },
    {
      method: /** @type {const} */ ('GET'),
      pattern: ['api', 'backups'],
      run: () => api.handlers.listBackups(),
    },
    {
      method: /** @type {const} */ ('POST'),
      pattern: ['api', 'backups'],
      run: (ctx) => api.handlers.createBackup(ctx.req),
    },
    {
      method: /** @type {const} */ ('GET'),
      pattern: ['api', 'backups', ':dir', 'verify'],
      run: (ctx) => api.handlers.verifyBackup(ctx.params),
    },
    {
      method: /** @type {const} */ ('POST'),
      pattern: ['api', 'restore', 'plan'],
      run: (ctx) => api.handlers.planRestore(ctx.req),
    },
    {
      method: /** @type {const} */ ('POST'),
      pattern: ['api', 'restore', 'execute'],
      run: (ctx) => api.handlers.executeRestore(ctx.req),
    },
  ];
}

/**
 * 创建未监听的 HTTP 服务实例。
 *
 * @param {{
 *   store: ReturnType<typeof openStore>,
 *   governance: ReturnType<typeof createGovernance>,
 *   config: import('./config.mjs').ServerConfig & { token: string },
 *   logger: import('./log.mjs').Logger,
 * }} deps
 */
export function createBrainServer({ store, governance, config, logger }) {
  const api = createApi({ store, config, governance });
  const router = createRouter(buildRoutes(api));
  const token = config.token;

  /** 监听端口在 listen 之后才知道（允许 port=0），闸门用闭包拿最新值。 */
  /** @type {ReturnType<typeof createGuard> | null} */
  let guard = null;

  /** 隔离判定有文件 IO + 账本校验，缓存几秒就够（不是安全决策的关键路径）。 */
  let isolationCache = { at: 0, value: /** @type {any} */ (null) };
  function isolationSnapshot() {
    const now = Date.now();
    if (isolationCache.value !== null && now - isolationCache.at < 3_000) return isolationCache.value;
    const value = governance.isolation();
    isolationCache = { at: now, value };
    return value;
  }
  /** 恢复/备份之后立刻让缓存失效，避免横幅慢一拍。 */
  function refreshIsolation() {
    isolationCache = { at: 0, value: null };
    return isolationSnapshot();
  }

  /**
   * 把请求原样转发到宿主的 `/dsh-brain/*`（2026-10-30）。
   *
   * 为什么要它：主人要的是「7420 一个端口，治理 + 记忆那套页面都能用」。
   * 那套页面挂在 dsh web（3080）上，同源、零额外进程——这里**只转发，不复制实现**，
   * 复制一份就意味着两套页面迟早对不上。
   *
   * 两条纪律：
   * - **流式转发**（不缓冲），大响应不占内存；
   * - **宿主没起就如实 502**，不猜、不静默换源（否则页面会「看着在、其实是空的」）。
   *
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {number} hostPort
   * @returns {Promise<{ status: number }>}
   */
  function proxyToHost(req, res, hostPort) {
    return new Promise((resolve) => {
      /** @type {Record<string, any>} */
      const headers = { ...req.headers, host: `127.0.0.1:${hostPort}` };
      delete headers.connection;
      delete headers['proxy-connection'];
      const upstream = http.request(
        { host: '127.0.0.1', port: hostPort, path: req.url ?? '/', method: req.method, headers },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
          up.on('end', () => resolve({ status: up.statusCode ?? 200 }));
          up.on('error', () => resolve({ status: 502 }));
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end(
            `宿主 dsh web 没在 127.0.0.1:${hostPort} 上跑。\n` +
              '记忆/心海/使用/矛盾/实体/心情 这些页面挂在宿主上，先起 dsh web：dsh web --port ' +
              `${hostPort} --no-open`,
          );
        }
        resolve({ status: 502 });
      });
      req.pipe(upstream);
    });
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handler(req, res) {
    const startedAt = process.hrtime.bigint();
    const requestId = newRequestId();
    const method = (req.method ?? 'GET').toUpperCase();

    /** @param {number} status @param {number} bytes */
    const logLine = (status, bytes) => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      // 只记 pathname：query 里可能有主人的检索词，不该进日志。
      logger.info(
        `${method} ${new URL(req.url ?? '/', 'http://127.0.0.1').pathname} → ${status} ${ms.toFixed(1)}ms ${bytes}b rid=${requestId}`,
      );
    };

    try {
      const rawUrl = req.url ?? '/';
      // 8192 是常规浏览器的 URL 上限；超过直接 414，不让超长串进任何解析器。
      if (rawUrl.length > MAX_URL_LENGTH) {
        sendError(res, 414, 'URI_TOO_LONG', '请求路径过长');
        logLine(414, 0);
        return;
      }
      const url = new URL(rawUrl, 'http://127.0.0.1');
      const segments = parsePath(url.pathname);
      if (segments === null) {
        sendError(res, 400, 'BAD_PATH', '请求路径不合法（含编码分隔符、上级目录或非法编码）');
        logLine(400, 0);
        return;
      }

      // ---- /dsh-brain/*：反向代理到宿主（dsh web，默认 3080）---------
      // 让 7420 成为**唯一入口**：治理面板 + 记忆/心海/使用/矛盾/实体/心情。
      // 免凭据：这些页面在 3080 上本来就是本机公开视图，代理不该改变它的可达性。
      // 但 Host 检查照过——防 DNS rebinding 是这一层的事，与是否免凭据无关。
      if (segments.length > 0 && segments[0] === 'dsh-brain') {
        const hostVerdict = guard === null ? { ok: true } : guard.checkHost(req);
        if (!hostVerdict.ok) {
          sendError(res, hostVerdict.status ?? 403, hostVerdict.code ?? 'HOST_NOT_ALLOWED', hostVerdict.message ?? '拒绝访问');
          logLine(hostVerdict.status ?? 403, 0);
          return;
        }
        const proxied = await proxyToHost(req, res, config.hostPort);
        logLine(proxied.status, 0);
        return;
      }

      // ---- 静态资源：只有 GET，只有三份文件（外加 favicon 的 204）
      const isApi = segments.length > 0 && segments[0] === 'api';
      if (!isApi) {
        // 页面不需要凭据（跨源读不到响应体），但 **必须** 过 Host 检查：
        // 否则 DNS rebinding 会让攻击者页面与本页面同源，直接读走 <meta> 里的凭据。
        const hostVerdict = guard === null ? { ok: true } : guard.checkHost(req);
        if (!hostVerdict.ok) {
          sendError(res, hostVerdict.status ?? 403, hostVerdict.code ?? 'HOST_NOT_ALLOWED', hostVerdict.message ?? '拒绝访问');
          logLine(hostVerdict.status ?? 403, 0);
          return;
        }
        if (method !== 'GET' && method !== 'HEAD') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', '静态资源只支持 GET', undefined, { Allow: 'GET' });
          logLine(405, 0);
          return;
        }
        if (segments.length === 1 && segments[0] === 'favicon.ico') {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          logLine(204, 0);
          return;
        }
        if (method === 'HEAD') {
          // HEAD 只回报能力，不读文件；避免为 HEAD 单独维护一套响应逻辑。
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
          res.end();
          logLine(200, 0);
          return;
        }
        api.serveStatic(res, segments, token);
        logLine(200, 0);
        return;
      }

      // ---- /api/ping：免凭据，只回一个布尔
      if (segments.length === 2 && segments[1] === 'ping') {
        if (method !== 'GET') {
          sendError(res, 405, 'METHOD_NOT_ALLOWED', '只支持 GET', undefined, { Allow: 'GET' });
          logLine(405, 0);
          return;
        }
        const { status, body } = api.handlers.ping();
        sendJson(res, status, body);
        logLine(status, 0);
        return;
      }

      // ---- 准入闸门
      if (guard === null) {
        sendError(res, 503, 'NOT_READY', '服务正在启动');
        logLine(503, 0);
        return;
      }
      const verdict = guard.check(req);
      if (!verdict.ok) {
        sendError(
          res,
          verdict.status ?? 401,
          verdict.code ?? 'UNAUTHORIZED',
          verdict.message ?? '拒绝访问',
          undefined,
          verdict.headers ?? {},
        );
        logLine(verdict.status ?? 401, 0);
        return;
      }

      // ---- 隔离闸门（M3）
      //
      // promoted=false 的实例**不能提供正常服务**——横幅只是让人看见，这里才是拦得住。
      // 只读诊断照常（隔离了也要能查），/api/restore/* 放行（那是唯一的修复路径）。
      const isolation = isolationSnapshot();
      if (isolation.active && method !== 'GET' && method !== 'HEAD') {
        const key = `${method} ${url.pathname}`;
        if (!ISOLATION_ALLOWED_WRITES.has(key)) {
          sendError(
            res,
            403,
            'ISOLATED_INSTANCE',
            '这个实例处于隔离状态，只能只读检修：不做正常写入，也不能上线。',
            {
              isolation: {
                active: true,
                source: isolation.source,
                reasons: isolation.reasons.map((r) => r.code),
                howToRecover: 'POST /api/restore/execute（带 dryRun:false + confirm）重新恢复，或修好独立删除账本后重启。',
              },
            },
          );
          logLine(403, 0);
          return;
        }
      }

      // ---- 路由
      const candidates = router.match(segments);
      if (candidates.length === 0) {
        sendError(res, 404, 'NOT_FOUND', `没有这个接口：${url.pathname}`);
        logLine(404, 0);
        return;
      }
      const chosen = candidates.find((c) => c.route.method === method);
      if (chosen === undefined) {
        const allow = [...new Set(candidates.map((c) => c.route.method))].join(', ');
        sendError(res, 405, 'METHOD_NOT_ALLOWED', `${url.pathname} 不支持 ${method}`, undefined, { Allow: allow });
        logLine(405, 0);
        return;
      }

      const result = await chosen.route.run({ req, res, url, params: chosen.params, segments });
      if (res.writableEnded) {
        logLine(res.statusCode, 0);
        return;
      }
      const status = typeof result?.status === 'number' ? result.status : 200;
      sendJson(res, status, result?.body ?? null);
      logLine(status, Number(res.getHeader('content-length') ?? 0));
    } catch (err) {
      const mapped = mapError(err);
      const anyErr = /** @type {any} */ (err);
      if (mapped.status >= 500) {
        logger.error(`rid=${requestId} ${mapped.code}: ${mapped.message}`);
      } else {
        logger.warn(`rid=${requestId} ${mapped.code}: ${mapped.message}`);
      }
      if (!res.headersSent) {
        sendError(res, mapped.status, mapped.code, mapped.message, mapped.details);
      } else {
        res.destroy();
      }
      logLine(mapped.status, 0);
    }
  }

  const server = http.createServer((req, res) => {
    // 兜底：handler 内的异常已经处理，这里只防「连 handler 都没进」。
    handler(req, res).catch(() => {
      if (!res.headersSent) sendError(res, 500, 'INTERNAL_ERROR', '内部错误');
      else res.destroy();
    });
  });

  server.keepAliveTimeout = 5_000;
  server.headersTimeout = 10_000;
  server.requestTimeout = 20_000;
  server.on('clientError', (/** @type {Error} */ err, /** @type {import('node:net').Socket} */ socket) => {
    logger.warn(`clientError: ${err.message}`);
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    else socket.destroy();
  });

  return {
    server,
    api,
    /** listen 之后调用：闸门需要真实端口来校验 Host/Origin。 */
    bindGuard(/** @type {number} */ port) {
      guard = createGuard({ token, port });
      return guard;
    },
    get guard() {
      return guard;
    },
    /** 恢复/备份之后调用，让隔离横幅立刻反映新状态。 */
    refreshIsolation,
  };
}

/**
 * 启动服务（测试与 CLI 共用入口）。
 *
 * @param {import('./config.mjs').ServerConfig & {
 *   token?: string, logger?: import('./log.mjs').Logger, migrationsDir?: string,
 * }} [options]
 */
export async function startServer(options = {}) {
  const config = resolveConfig(options);
  const logger = options.logger ?? createLogger({ level: config.logLevel });
  // 任何时候都要先把凭据登记进脱敏表，再让它有可能出现在任何日志上下文里。
  registerSecret(/** @type {string} */ (config.token));

  const store = openStore({
    dbPath: config.dbPath,
    readOnly: config.readOnlyDb,
    migrationsDir: options.migrationsDir,
    backupDir: config.backupDir,
    logger,
  });

  // M3 治理面：删除四层报告 / 备份中心 / 恢复编排 / 隔离判定。
  const governance = createGovernance({ store, config, logger });

  const brain = createBrainServer({ store, governance, config: /** @type {any} */ (config), logger });

  await new Promise((resolve, reject) => {
    const onError = (/** @type {NodeJS.ErrnoException} */ err) => {
      brain.server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      brain.server.removeListener('error', onError);
      resolve(undefined);
    };
    brain.server.once('error', onError);
    brain.server.once('listening', onListening);
    brain.server.listen(config.port, config.host);
  });

  const address = brain.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  brain.bindGuard(port);

  const url = `http://${config.host}:${port}/`;

  return {
    url,
    port,
    host: config.host,
    /** 仅供进程内使用（测试、启动打印不输出它）。 */
    token: config.token,
    store,
    governance,
    server: brain.server,
    logger,
    /** 让调用方在恢复/备份之后主动刷新隔离判定。 */
    refreshIsolation: () => brain.refreshIsolation(),
    async close() {
      await new Promise((resolve) => brain.server.close(() => resolve(undefined)));
      await store.close();
    },
  };
}
