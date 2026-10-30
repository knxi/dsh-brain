// @ts-check
/**
 * API 处理器集合 + 控制台静态资源。
 *
 * 约定（M2-INTERFACES §4.1）：
 * - 响应统一形状；列表接口一律 `{ items, nextCursor, limit, total, limitNote }`；
 * - 参数全部从 URL / body 显式取，**不信任**任何隐式来源；
 * - 静态资源**只**从三个固定文件取（不做任意路径映射，路径穿越无从谈起）。
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { CONSOLE_CSP, readJson, sendError, sendJson, sendText } from './http-util.mjs';
import { MAX_BODY_BYTES, SERVER_VERSION } from './config.mjs';

/**
 * 白名单静态资源：URL 段 → 磁盘文件名。**只有这三个**。
 * 不做 `path.join(dir, segments)` 这种通用映射，因此不可能被穿越。
 */
const STATIC_ROUTES = new Map([
  ['', 'index.html'],
  ['index.html', 'index.html'],
  ['assets/app.js', 'app.js'],
  ['assets/styles.css', 'styles.css'],
]);

/** 内容类型表（只覆盖白名单里的文件）。 */
const CONTENT_TYPES = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['app.js', 'text/javascript; charset=utf-8'],
  ['styles.css', 'text/css; charset=utf-8'],
]);

/**
 * 把凭据注入页面：走 `<meta>` 而不是内联 `<script>`，
 * 这样 CSP 可以保持 `script-src 'self'`（没有 unsafe-inline），
 * 而且凭据**不进 URL**、不进书签、不进 Referer。
 *
 * @param {string} html
 * @param {string} token
 */
function injectBootMeta(html, token) {
  const escaped = token.replace(/[&<>"']/g, (c) => /** @type {Record<string,string>} */ ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
  const meta = `  <meta name="brain-token" content="${escaped}" />\n  <meta name="brain-version" content="${SERVER_VERSION}" />\n`;
  return html.includes('</head>') ? html.replace('</head>', `${meta}</head>`) : `${meta}${html}`;
}

/**
 * 创建处理器集合。
 * @param {{
 *   store: ReturnType<typeof import('./store.mjs').openStore>,
 *   config: import('./config.mjs').ServerConfig,
 *   governance: ReturnType<typeof import('./governance.mjs').createGovernance>,
 * }} deps
 */
export function createApi({ store, config, governance }) {
  /**
   * 每次都读 index.html，**不缓存**。
   *
   * 缓存过一版，代价是「改了 HTML 但页面还是旧的」，排查半天才发现是进程里的模板。
   * 这是本机检查器、单用户、8KB 的文件，每次读一次磁盘完全不值得省。
   */
  function loadIndex() {
    return readFileSync(path.join(config.consoleDir, 'index.html'), 'utf8');
  }

  /**
   * 静态资源。`segments` 已经过 router 的段级校验（无 `..`、无编码分隔符）。
   * 这里再做一次 resolve 前缀断言，双保险。
   * @param {import('node:http').ServerResponse} res
   * @param {string[]} segments
   * @param {string} token
   */
  function serveStatic(res, segments, token) {
    const key = segments.join('/');
    const fileName = STATIC_ROUTES.get(key);
    if (fileName === undefined) {
      sendError(res, 404, 'NOT_FOUND', '没有这个资源');
      return;
    }
    const root = path.resolve(config.consoleDir);
    const full = path.resolve(root, fileName);
    if (!full.startsWith(root + path.sep)) {
      // 理论上不可达：白名单里的名字都是固定字符串。真到了这里说明白名单被改坏了。
      sendError(res, 404, 'NOT_FOUND', '没有这个资源');
      return;
    }
    let body;
    try {
      const stat = statSync(full);
      if (!stat.isFile()) throw new Error('not a file');
      body = readFileSync(full);
    } catch {
      sendError(res, 500, 'CONSOLE_ASSET_MISSING', `控制台资源缺失：${fileName}`);
      return;
    }

    if (fileName === 'index.html') {
      const html = injectBootMeta(loadIndex(), token);
      sendText(res, 200, /** @type {string} */ (CONTENT_TYPES.get(fileName)), html, {
        'Content-Security-Policy': CONSOLE_CSP,
        'X-Robots-Tag': 'noindex, nofollow',
      });
      return;
    }
    sendText(res, 200, /** @type {string} */ (CONTENT_TYPES.get(fileName)), body);
  }

  // ---- handlers -----------------------------------------------------------

  function health() {
    const base = store.health();
    // M3 的治理面：隔离判定、能力矩阵、备份目录。隔离横幅就靠这里的 isolation.active。
    const extra = governance.healthExtra();
    return {
      status: 200,
      body: {
        ...base,
        isolation: extra.isolation,
        capabilities: extra.capabilities,
        governance: {
          backupDir: extra.backupDir,
          ledgerDir: extra.ledgerDir,
          keepDays: extra.keepDays,
        },
        // 隔离实例即使能打开页面，也不能假装自己是正常的
        ok: base.ok && extra.isolation.canServe,
      },
    };
  }

  /**
   * 列表。`?scopeId=` 声明读取上下文；不传时由 store 收口到服务端默认 scope
   * （不是「全库」）。`allowCrossScope` 只给进程内用，这里不读。
   *
   * @param {URL} url
   */
  async function listMemories(url) {
    const q = url.searchParams;
    const result = await store.listMemories({
      scopeId: q.get('scopeId') ?? undefined,
      personId: q.get('personId') ?? undefined,
      layer: q.get('layer') ?? undefined,
      type: q.get('type') ?? undefined,
      status: q.get('status') ?? undefined,
      limit: q.get('limit') ?? undefined,
      cursor: q.get('cursor') ?? null,
    });
    return { status: 200, body: result };
  }

  /**
   * 记忆详情。
   *
   * scope 与列表同口径：`?scopeId=` 是**声明读取上下文**，缺省取服务端默认 scope。
   * 越界 id → 404（与「不存在」同形），不确认存在性——403 等于告诉对方「这条存在，
   * 只是你没权限」。`allowCrossScope` 是进程内开关，这里**故意不读** URL 参数，
   * URL 上写了也不生效。
   *
   * @param {Record<string, string>} params
   * @param {URL} url
   */
  async function getMemory(params, url) {
    const asOf = url.searchParams.get('asOf');
    const scopeId = url.searchParams.get('scopeId') ?? undefined;
    const memory = await store.getMemory(params.id, { asOf: asOf ?? undefined, scopeId });
    if (memory === null) return { status: 404, body: { error: { code: 'NOT_FOUND', message: `记忆不存在：${params.id}` } } };
    return { status: 200, body: { memory } };
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   */
  async function createMemory(req) {
    const body = await readJson(req, { limit: MAX_BODY_BYTES });
    const created = await store.createMemory(body);
    return { status: 201, body: created };
  }

  /**
   * @param {Record<string, string>} params
   * @param {import('node:http').IncomingMessage} req
   */
  async function deleteMemory(params, req) {
    // 允许空 body（浏览器 DELETE 常常不带 body），但带了就必须是合法 JSON。
    let body = {};
    const contentLength = Number(req.headers['content-length'] ?? 0);
    const hasBody = (Number.isFinite(contentLength) && contentLength > 0) || req.headers['transfer-encoding'] !== undefined;
    if (hasBody) {
      const parsed = await readJson(req, { limit: MAX_BODY_BYTES });
      if (parsed !== null && typeof parsed === 'object') body = parsed;
    }
    const result = await store.requestDelete(params.id, body);
    // 202 Accepted：已受理、已屏蔽，但正文清理是异步的。
    return { status: 202, body: result };
  }

  /**
   * @param {URL} url
   */
  async function search(url) {
    const q = url.searchParams.get('q');
    if (q === null || q.trim().length === 0) {
      return { status: 400, body: { error: { code: 'INVALID_ARGUMENT', message: '检索需要 q 参数' } } };
    }
    const result = await store.searchMemories({
      query: q,
      scopeId: url.searchParams.get('scopeId') ?? undefined,
      personId: url.searchParams.get('personId') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      asOf: url.searchParams.get('asOf') ?? undefined,
      // 覆盖度阈值可以调：阈值越低越容易「凑出答案」，检查器要能演示这条线在哪。
      minCoverage: url.searchParams.get('minCoverage') ?? undefined,
    });
    return {
      status: 200,
      body: {
        query: q,
        ...result,
        // 四态的可读解释，前端直接用（也方便 curl 的人看懂）
        statusLegend: {
          ok: '命中且来源可核对',
          no_related: '库中确实没有相关记忆',
          insufficient_evidence: '有命中，但来源/置信度不足以支撑回答',
          source_missing: '命中的记忆指向的原始来源已不存在',
          source_conflict: '同一事实存在互相矛盾的记录',
        },
      },
    };
  }

  /**
   * 构包列表。`?scopeId=` 是**声明读取上下文**，不传时由 store 收口到服务端默认 scope
   * （不是「全库」）；`allowCrossScope` 只给进程内用，这里不读。
   *
   * @param {URL} url
   */
  async function listContexts(url) {
    const result = await store.listContexts({
      sessionId: url.searchParams.get('sessionId') ?? undefined,
      turnId: url.searchParams.get('turnId') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
      cursor: url.searchParams.get('cursor') ?? null,
      scopeId: url.searchParams.get('scopeId') ?? undefined,
    });
    return { status: 200, body: result };
  }

  /**
   * 构包详情。
   *
   * scope 与列表同口径：`?scopeId=` 是声明读取上下文，缺省取服务端默认 scope。
   * 越界 contextId → 404（与「不存在」同形），不确认存在性。
   *
   * @param {Record<string, string>} params
   * @param {URL} url
   */
  async function getContext(params, url) {
    const scopeId = url.searchParams.get('scopeId') ?? undefined;
    const detail = await store.getContext(params.contextId, { scopeId });
    if (detail === null) {
      return { status: 404, body: { error: { code: 'NOT_FOUND', message: `构包不存在：${params.contextId}` } } };
    }
    // 顶层同时给 `package` 与 `status`（契约要求的形状）。
    return { status: 200, body: { ...detail, status: detail.status, package: detail.package } };
  }

  /** 探活用：不需要凭据，也不泄露任何内部信息。 */
  function ping() {
    return { status: 200, body: { ok: true, service: 'dsh-brain-server' } };
  }

  // ---- M3：删除状态 / 备份中心 / 恢复 -------------------------------------

  /**
   * @param {Record<string, string>} params
   */
  async function deletionStatus(params) {
    const report = await governance.deletionStatus(params.memoryId);
    return { status: 200, body: report };
  }

  /**
   * @param {URL} url
   */
  async function listDeletions(url) {
    const result = await governance.listDeletions({
      status: url.searchParams.get('status') ?? undefined,
      limit: url.searchParams.get('limit') ?? undefined,
    });
    return { status: 200, body: result };
  }

  async function listBackups() {
    const result = await governance.listBackups();
    return { status: 200, body: result };
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   */
  async function createBackup(req) {
    // 允许空 body：备份不需要参数。带了就必须是合法 JSON。
    const contentLength = Number(req.headers['content-length'] ?? 0);
    const hasBody =
      (Number.isFinite(contentLength) && contentLength > 0) || req.headers['transfer-encoding'] !== undefined;
    const body = hasBody ? await readJson(req, { limit: MAX_BODY_BYTES }) : {};
    const result = await governance.createBackup(body);
    return { status: 201, body: result };
  }

  /**
   * @param {Record<string, string>} params
   */
  async function verifyBackup(params) {
    const result = await governance.verifyBackup(params.dir);
    return { status: 200, body: result };
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   */
  async function planRestore(req) {
    const body = await readJson(req, { limit: MAX_BODY_BYTES });
    const plan = await governance.planRestore(body);
    return { status: 200, body: plan };
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   */
  async function executeRestore(req) {
    const contentLength = Number(req.headers['content-length'] ?? 0);
    const hasBody =
      (Number.isFinite(contentLength) && contentLength > 0) || req.headers['transfer-encoding'] !== undefined;
    const body = hasBody ? await readJson(req, { limit: MAX_BODY_BYTES }) : {};
    const result = await governance.executeRestore(body);
    // 预演回 200（什么都没发生）；真执行回 202（已受理且已完成写库，但上架与否看 promoted）。
    return { status: result.dryRun === true ? 200 : 202, body: result };
  }

  return {
    handlers: {
      health,
      listMemories,
      getMemory,
      createMemory,
      deleteMemory,
      search,
      listContexts,
      getContext,
      ping,
      deletionStatus,
      listDeletions,
      listBackups,
      createBackup,
      verifyBackup,
      planRestore,
      executeRestore,
    },
    serveStatic,
  };
}
