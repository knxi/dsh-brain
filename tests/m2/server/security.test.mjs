// @ts-check
/**
 * 安全测试：凭据、Host、Origin、路径穿越、日志脱敏、资源白名单。
 *
 * 这些不是「打个勾」—— 每条都对应一种真实攻击面（见 apps/server/src/auth.mjs 的注释）。
 */

import net from 'node:net';
import test from 'node:test';
import {
  assert,
  createTempBrain,
  startTestServer,
  MIGRATIONS_DIR,
  TEST_TOKEN,
} from './helpers.mjs';
import { generateToken, assertTokenShape } from '../../../apps/server/src/config.mjs';
import { createLogger, redact, registerSecret } from '../../../apps/server/src/log.mjs';
import { startServer } from '../../../apps/server/src/server.mjs';

/** @type {Awaited<ReturnType<typeof startTestServer>>} */
let server;
/** @type {Awaited<ReturnType<typeof createTempBrain>>} */
let brain;

test.before(async () => {
  brain = await createTempBrain();
  server = await startTestServer({ dbPath: brain.dbPath });
});

test.after(async () => {
  await server?.close();
  await brain?.close();
});

/**
 * 裸 socket 请求：curl/fetch 会替我们规范化路径、管好 Host，测不出真实攻击面。
 * @param {{ port: number, pathname?: string, method?: string, headers?: Record<string,string>, body?: string }} opts
 */
function rawRequest(opts) {
  const { port, pathname = '/', method = 'GET', headers = {}, body = '' } = opts;
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      /** @type {Record<string,string>} */
      const merged = { Host: `127.0.0.1:${port}`, Connection: 'close', ...headers };
      if (body.length > 0) merged['Content-Length'] = String(Buffer.byteLength(body));
      const head = [`${method} ${pathname} HTTP/1.1`];
      for (const [k, v] of Object.entries(merged)) head.push(`${k}: ${v}`);
      socket.write(`${head.join('\r\n')}\r\n\r\n${body}`);
    });
    let buffer = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error('rawRequest 超时')));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
    });
    socket.on('error', reject);
    socket.on('end', () => {
      const split = buffer.indexOf('\r\n\r\n');
      const headText = split === -1 ? buffer : buffer.slice(0, split);
      const bodyText = split === -1 ? '' : buffer.slice(split + 4);
      const statusLine = headText.split('\r\n')[0] ?? '';
      const status = Number(statusLine.split(' ')[1] ?? 0);
      resolve({ status, head: headText, body: bodyText, raw: buffer });
    });
  });
}

// ---------------------------------------------------------------------------
// 凭据
// ---------------------------------------------------------------------------

test('缺少凭据 → 401，并给出 WWW-Authenticate', async () => {
  const { status, headers, json } = await server.request('/api/health', { token: null });
  assert.equal(status, 401);
  assert.equal(json.error.code, 'UNAUTHORIZED');
  assert.match(String(headers.get('www-authenticate')), /Bearer/);
});

test('错误凭据 → 401（不泄漏「差多少」）', async () => {
  const { status, json } = await server.request('/api/health', { token: 'x'.repeat(64) });
  assert.equal(status, 401);
  assert.equal(json.error.code, 'UNAUTHORIZED');
  // 错误消息不能回显用户提供的凭据
  assert.equal(JSON.stringify(json).includes('x'.repeat(64)), false);
});

test('凭据放在 query 里一律无效（凭据只走 header）', async () => {
  const noHeader = await server.request(`/api/health`, { token: null, query: { token: TEST_TOKEN } });
  assert.equal(noHeader.status, 401);

  const wrongPlace = await server.request(`/api/health`, { token: null, query: { apiKey: TEST_TOKEN, bearer: TEST_TOKEN } });
  assert.equal(wrongPlace.status, 401);
});

test('凭据也可以走 X-Brain-Token 头（curl 手测用）', async () => {
  const { status } = await server.request('/api/health', {
    token: null,
    headers: { 'X-Brain-Token': TEST_TOKEN },
  });
  assert.equal(status, 200);
});

test('连续认证失败会被限流（429）', async () => {
  // 用一个独立实例，避免污染其它用例的计数
  const tmp = await createTempBrain();
  const isolated = await startTestServer({ dbPath: tmp.dbPath, token: TEST_TOKEN });
  try {
    let last = 0;
    for (let i = 0; i < 14; i += 1) {
      const res = await isolated.request('/api/health', { token: 'wrong-but-long-enough-token-value-xxxxxx' });
      last = res.status;
      if (last === 429) break;
    }
    assert.equal(last, 429, '连续失败应当被限流');
  } finally {
    await isolated.close();
    await tmp.close();
  }
});

test('凭据不可预测：CSPRNG、43 字符、两次不同', () => {
  const a = generateToken();
  const b = generateToken();
  assert.notEqual(a, b);
  assert.equal(a.length, 43);
  assert.match(a, /^[A-Za-z0-9_-]+$/);
});

test('弱凭据被拒绝启动', () => {
  assert.throws(() => assertTokenShape('short'), /太短/);
  assert.throws(() => assertTokenShape('test-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), /占位符/);
  assert.throws(() => assertTokenShape(''), /为空/);
  assert.equal(assertTokenShape('a'.repeat(40)).length, 40);
});

// ---------------------------------------------------------------------------
// Host / Origin
// ---------------------------------------------------------------------------

test('Host 不在白名单 → 403（挡 DNS rebinding）', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/health',
    headers: { Host: 'evil.example.com', Authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /HOST_NOT_ALLOWED/);
});

test('页面也过 Host 检查（否则 rebinding 能读走内嵌凭据）', async () => {
  const res = await rawRequest({ port: server.port, pathname: '/', headers: { Host: 'attacker.test' } });
  assert.equal(res.status, 403);
  assert.match(res.body, /HOST_NOT_ALLOWED/);
  assert.equal(res.body.includes(TEST_TOKEN), false);
});

test('Origin 不在白名单 → 403（挡浏览器里的其它网页）', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'POST',
    headers: {
      Origin: 'http://evil.example.com',
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content: 'x' }),
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /ORIGIN_NOT_ALLOWED/);
});

test('opaque origin（file:// / sandbox iframe）被拒', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/health',
    headers: { Origin: 'null', Authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /opaque origin/);
});

test('Referer 的 origin 不在白名单也被拒', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/health',
    headers: { Referer: 'http://evil.example.com/page', Authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(res.status, 403);
});

test('同源 Origin 放行', async () => {
  const { status } = await server.request('/api/health', {
    headers: { Origin: `http://127.0.0.1:${server.port}` },
  });
  assert.equal(status, 200);
});

// ---------------------------------------------------------------------------
// 路径穿越与资源白名单
// ---------------------------------------------------------------------------

test('路径穿越一律拒绝，且读不到任何文件内容', async () => {
  const attempts = [
    '/../package.json',
    '/api/../../package.json',
    '/assets/../../package.json',
    '/assets/%2e%2e%2fpackage.json',
    '/api/memories/%2e%2e%2f%2e%2e%2fpackage.json',
    '/..%2f..%2fpackage.json',
    '/assets/app.js%00.png',
    '/api/health/%2e%2e',
  ];
  for (const pathname of attempts) {
    const res = await rawRequest({
      port: server.port,
      pathname,
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    assert.ok(
      [400, 404].includes(res.status),
      `${pathname} 应被拒绝，实际 ${res.status}`,
    );
    // 关键：绝不能让 package.json 的内容漏出来
    assert.equal(res.body.includes('@dsh-brain/core'), false, `${pathname} 泄漏了文件内容`);
    assert.equal(res.body.includes('"name": "dsh-brain"'), false, `${pathname} 泄漏了文件内容`);
  }
});

test('静态资源白名单之外一律 404（不做任意路径映射）', async () => {
  for (const pathname of ['/index.mjs', '/src/server.mjs', '/package.json', '/assets/secret.js', '/apps/server/index.mjs']) {
    const res = await rawRequest({ port: server.port, pathname });
    assert.equal(res.status, 404, `${pathname} 应该 404`);
  }
});

// ---------------------------------------------------------------------------
// 响应头 / 方法
// ---------------------------------------------------------------------------

test('响应不带 CORS 通配、不允许被嵌框、不缓存', async () => {
  const { headers } = await server.request('/api/health');
  assert.equal(headers.get('access-control-allow-origin'), null);
  assert.equal(headers.get('access-control-allow-credentials'), null);
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.match(String(headers.get('cache-control')), /no-store/);
});

test('页面 CSP 不含 unsafe-inline / unsafe-eval', async () => {
  const { headers } = await server.request('/');
  const csp = String(headers.get('content-security-policy') ?? '');
  assert.ok(csp.length > 0, '页面必须有 CSP');
  assert.equal(csp.includes('unsafe-inline'), false);
  assert.equal(csp.includes('unsafe-eval'), false);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /default-src 'none'/);
});

test('方法不匹配 → 405 + Allow', async () => {
  const { status, headers } = await server.request('/api/health', { method: 'POST', body: '{}' });
  assert.equal(status, 405);
  assert.match(String(headers.get('allow')), /GET/);

  const staticPost = await rawRequest({
    port: server.port,
    pathname: '/',
    method: 'POST',
    headers: { 'Content-Length': '2' },
    body: '{}',
  });
  assert.equal(staticPost.status, 405);
});

test('未知接口 → 404，且不回显内部路径结构', async () => {
  const { status, json } = await server.request('/api/nope');
  assert.equal(status, 404);
  assert.equal(json.error.code, 'NOT_FOUND');
  assert.equal(JSON.stringify(json).includes('packages'), false);
});

// ---------------------------------------------------------------------------
// 日志脱敏
// ---------------------------------------------------------------------------

test('日志不含凭据、不含 query（检索词是私事）', async () => {
  const tmp = await createTempBrain();
  /** @type {string[]} */
  const lines = [];
  const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
  const isolated = await startServer({
    dbPath: tmp.dbPath,
    port: 0,
    token: TEST_TOKEN,
    migrationsDir: MIGRATIONS_DIR,
    logger,
  });
  try {
    const base = isolated.url.replace(/\/$/, '');
    const auth = { Authorization: `Bearer ${TEST_TOKEN}` };
    await fetch(`${base}/api/health`, { headers: auth });
    await fetch(`${base}/api/search?q=${encodeURIComponent('石材干挂报价 128 元')}`, { headers: auth });
    // 一次失败的鉴权（错误凭据绝不能进日志）
    await fetch(`${base}/api/health`, { headers: { Authorization: `Bearer ${'leaked-token-value-'.padEnd(48, 'z')}` } });
    await fetch(`${base}/api/memories/%2e%2e%2fpackage.json`, { headers: auth });

    const all = lines.join('\n');
    assert.ok(lines.length > 0, '应该有日志');
    assert.equal(all.includes(TEST_TOKEN), false, '日志里出现了真凭据');
    assert.equal(all.includes('leaked-token-value-'), false, '日志里出现了错误凭据');
    assert.equal(all.includes('石材干挂'), false, '日志里出现了检索词');
    assert.equal(all.includes('q='), false, '日志里出现了 query');
    assert.match(all, /GET \/api\/health → 200/);
  } finally {
    await isolated.close();
    await tmp.close();
  }
});

test('redact() 抹掉登记的凭据与 Authorization 形态', () => {
  const secret = generateToken();
  registerSecret(secret);
  const text = `token=${secret} header=Bearer ${secret} url=?token=${secret}&x=1`;
  const out = redact(text);
  assert.equal(out.includes(secret), false);
  assert.ok(out.includes('[redacted]'));
  assert.equal(redact('Bearer abcdefghijklmnopqrstuvwxyz012345').includes('abcdefghijklmnop'), false);
});

// ---------------------------------------------------------------------------
// 只读模式
// ---------------------------------------------------------------------------

test('只读模式拒绝写入与删除', async () => {
  const tmp = await createTempBrain();
  const ro = await startTestServer({ dbPath: tmp.dbPath, readOnlyDb: true });
  try {
    const created = await ro.request('/api/memories', {
      method: 'POST',
      body: JSON.stringify({ content: '不该写进去的内容' }),
    });
    assert.equal(created.status, 403);
    assert.equal(created.json.error.code, 'STORAGE_READONLY');

    const del = await ro.request('/api/memories/mem-ceiling-1200', { method: 'DELETE' });
    assert.equal(del.status, 403);

    // 读依然可用
    const list = await ro.request('/api/memories');
    assert.equal(list.status, 200);
  } finally {
    await ro.close();
    await tmp.close();
  }
});
