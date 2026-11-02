// @ts-check
/**
 * csrf-explicit.test.mjs — §22.4 第 6 类「非法 Origin/Host、缺少凭据、CSRF」的**显式**用例。
 *
 * 为什么单独写这一组：现有测试里 Origin/Host/凭据各自有断言（security.test.mjs），
 * 但**没有一条直接模拟「浏览器跨站请求」**。审计结论是「机制够用，缺显式用例」。
 * 这一组把真实攻击形态摆出来跑一遍：
 *
 *   - 跨站表单提交（form-urlencoded + Cookie，无自定义头）；
 *   - 本机其它端口上的网页（同 IP 不同源）；
 *   - CORS preflight；
 *   - 拿合法凭据去配恶意 Origin（证明凭据不能绕过 Origin）；
 *   - 拿合法凭据去配恶意 Host（证明 Host 是第一道，且挡 DNS rebinding）。
 *
 * 设计依据：`apps/server/src/auth.mjs:40-61`（凭据只认 header，显式不读 Cookie/query）、
 * `:178-219`（Host → Origin/Referer → 失败计数 → 凭据，顺序即安全设计）、
 * `apps/server/src/server.mjs:231-243`（闸门在路由之前，任一不满足即拒）。
 *
 * 用的都是**裸 socket**：浏览器能做的额外动作（伪造 Cookie、不报 Content-Length）
 * 必须由请求方自己构造，fetch 会替我们规范掉。
 */

import test from 'node:test';
import { assert, createTempBrain, startTestServer, TEST_TOKEN } from './helpers.mjs';
import { rawRequest } from './raw-client.mjs';

/** @type {Awaited<ReturnType<typeof startTestServer>>} */
let server;
/** @type {Awaited<ReturnType<typeof createTempBrain>>} */
let brain;
let baselineTotal = -1;

test.before(async () => {
  brain = await createTempBrain();
  server = await startTestServer({ dbPath: brain.dbPath });
  const listed = await server.request('/api/memories', { query: { limit: 200 } });
  baselineTotal = listed.json.total;
});

test.after(async () => {
  await server?.close();
  await brain?.close();
});

/** 证明「被拒的跨站请求没有写进任何东西」。 */
async function assertNoWrite(hint) {
  const { status, json } = await server.request('/api/memories', { query: { limit: 200 } });
  assert.equal(status, 200);
  assert.equal(json.total, baselineTotal, `${hint}：跨站请求产生了新记忆`);
  assert.equal(JSON.stringify(json.items).includes('hacked-by-cross-site'), false, `${hint}：跨站正文落库了`);
}

// ---------------------------------------------------------------------------
// 1. 跨站表单提交：浏览器最容易做到的「简单请求」
// ---------------------------------------------------------------------------

test('跨站表单提交（无自定义头 + Cookie 带真凭据）→ 403 ORIGIN_NOT_ALLOWED，且不落库', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'POST',
    headers: {
      // 浏览器的跨站表单一定带 Origin；Cookie 会自动带上（浏览器行为）
      Origin: 'http://evil.example.com',
      Cookie: `brain_token=${TEST_TOKEN}; session=abc123`,
      // 跨站表单只能用这三个简单 Content-Type 之一 —— 这就是 CSRF 不需要 preflight 的原因
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'content=hacked-by-cross-site',
  });

  assert.equal(res.status, 403, '跨站表单必须被 Origin 闸门拦住');
  assert.match(res.body, /ORIGIN_NOT_ALLOWED/);
  // 拒绝理由不能回显对方给的 Origin（避免日志/页面被注入）
  assert.equal(res.body.includes('evil.example.com'), false);
  // Cookie 里的凭据不能被当作已认证
  assert.equal(res.body.includes(TEST_TOKEN), false);
  await assertNoWrite('跨站表单');
});

// ---------------------------------------------------------------------------
// 2. Cookie 从来不是凭据：三种情形都必须 401
// ---------------------------------------------------------------------------

test('Cookie 里放真凭据 + 合法 Origin → 仍然 401（服务端从不读 Cookie）', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'GET',
    headers: {
      Origin: `http://127.0.0.1:${server.port}`,
      Cookie: `brain_token=${TEST_TOKEN}`,
    },
  });

  assert.equal(res.status, 401, 'Cookie 不是凭据载体');
  assert.match(res.body, /UNAUTHORIZED/);
  assert.equal(res.body.includes(TEST_TOKEN), false, '拒绝响应回显了 Cookie 里的凭据');
  // 服务端自己也不种 Cookie：没有任何会话状态可被跨站利用
  assert.equal(res.head.toLowerCase().includes('set-cookie'), false, '服务端不该种 Cookie');
});

test('Cookie 里放真凭据 + 无 Origin/Referer → 仍然 401（本机进程模型也只认 header）', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'GET',
    headers: { Cookie: `brain_token=${TEST_TOKEN}` },
  });
  assert.equal(res.status, 401);
  assert.match(res.body, /UNAUTHORIZED/);
});

// ---------------------------------------------------------------------------
// 3. 凭据不能绕过 Origin：两者是叠加条件，不是「有一个就行」
// ---------------------------------------------------------------------------

test('合法 Bearer + 恶意 Origin → 403（凭据不能换掉 Origin 检查）', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'GET',
    headers: { Origin: 'http://evil.example.com', Authorization: `Bearer ${TEST_TOKEN}` },
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /ORIGIN_NOT_ALLOWED/);
});

test('本机其它端口的 Origin → 403（同 IP 不同源不算同源）', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'GET',
    headers: {
      // 本机另一个服务起的页面（比如画布插件、别的工具）也是「别的网页」
      Origin: `http://127.0.0.1:${server.port + 1}`,
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /ORIGIN_NOT_ALLOWED/);
});

test('跨站 GET 且无凭据 → 403 而不是 401（Origin 闸门先于凭据，不提示「带凭据就能进」）', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'GET',
    headers: { Origin: 'http://evil.example.com' },
  });
  assert.equal(res.status, 403);
  assert.match(res.body, /ORIGIN_NOT_ALLOWED/);
  assert.equal(res.body.includes('UNAUTHORIZED'), false);
});

// ---------------------------------------------------------------------------
// 4. Host 是第一道：挡 DNS rebinding
// ---------------------------------------------------------------------------

test('合法 Bearer + 恶意 Host → 403 HOST_NOT_ALLOWED（Host 检查先于 Origin 与凭据）', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'GET',
    headers: {
      Host: 'evil.example.com',
      Origin: 'http://evil.example.com',
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
  });
  assert.equal(res.status, 403);
  // Host 最先判：即使 Origin 也非法，报的也必须是 Host（顺序是安全设计的一部分）
  assert.match(res.body, /HOST_NOT_ALLOWED/);
  assert.equal(res.body.includes('ORIGIN_NOT_ALLOWED'), false);
});

// ---------------------------------------------------------------------------
// 5. CORS preflight：不给任何放行头
// ---------------------------------------------------------------------------

test('恶意 Origin 的 CORS preflight → 403，且响应没有任何 CORS 放行头', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'OPTIONS',
    headers: {
      Origin: 'http://evil.example.com',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });

  assert.equal(res.status, 403);
  const head = res.head.toLowerCase();
  assert.equal(head.includes('access-control-allow-origin'), false, '不能回任何 CORS 放行头');
  assert.equal(head.includes('access-control-allow-credentials'), false);
  assert.equal(head.includes('access-control-allow-methods'), false);
});

// ---------------------------------------------------------------------------
// 6. 对照组：同源 + 合法凭据必须放行（证明检查不误杀正常页面）
// ---------------------------------------------------------------------------

test('同源 Origin + 合法 Bearer → 200（闸门不是一刀切）', async () => {
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'GET',
    headers: {
      Origin: `http://127.0.0.1:${server.port}`,
      Authorization: `Bearer ${TEST_TOKEN}`,
    },
  });
  assert.equal(res.status, 200);
  assert.match(res.body, /"items"/);
});
