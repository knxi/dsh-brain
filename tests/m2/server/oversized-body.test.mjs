// @ts-check
/**
 * oversized-body.test.mjs — §22.4 第 6 类「超大请求」的真实回归。
 *
 * 被测实现：`apps/server/src/http-util.mjs:163-199`（readBody 有界读取）+
 * `apps/server/src/api.mjs:177/192/298/315/327`（所有写端点都过 readJson(limit)）。
 *
 * 这一组**必须**用裸 socket 发真请求：fetch 会替我们规范化 Content-Length，
 * 测不出「不看客户端自报长度，只认实际字节数」这件事。
 *
 * ⚠️ 已知实现缺口（见 docs/MVP-HARDENING-GAP.md P0 第 2 条与下面第 3 条用例）：
 *   `readBody` 正确设了 `err.status = 413 / code = 'PAYLOAD_TOO_LARGE'`，但
 *   `mapError()`（http-util.mjs:112-154）没有 `PAYLOAD_TOO_LARGE` 分支，
 *   于是落进 default 分支返回 **HTTP 500**。请求确实被拒了（不 OOM、不落库、
 *   服务不崩），但契约要求的是 413。测试如实断言现状，不粉饰成 413。
 */

import test from 'node:test';
import { assert, createTempBrain, startTestServer, TEST_TOKEN } from './helpers.mjs';
import { rawRequest } from './raw-client.mjs';
import { MAX_BODY_BYTES } from '../../../apps/server/src/config.mjs';

/** 请求体里放的唯一标记：落库检查靠它，不靠模糊的「大概没写进去」。 */
const MARKER = 'OVERSIZED-BODY-MARKER-20261028';

/** @type {Awaited<ReturnType<typeof startTestServer>>} */
let server;
/** @type {Awaited<ReturnType<typeof createTempBrain>>} */
let brain;
/** 共享实例的基线条数：seedFixture 会造 8 条。 */
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

/** 造一个**字节数精确**的 JSON 请求体（filler 是未知字段，服务端要么忽略要么 400）。 */
function exactSizeJson(totalBytes) {
  const probe = JSON.stringify({ content: '边界请求体', filler: '' });
  const diff = totalBytes - Buffer.byteLength(probe);
  assert.ok(diff > 0, 'totalBytes 太小');
  return JSON.stringify({ content: '边界请求体', filler: 'a'.repeat(diff) });
}

/** 读列表（用于证明「被拒的请求没有落库」）。 */
async function listMemories() {
  const { status, json } = await server.request('/api/memories', { query: { limit: 200 } });
  assert.equal(status, 200);
  return json;
}

// ---------------------------------------------------------------------------
// 1. 真的超大请求：被拒 + 不落库 + 不崩 + 不挂住
// ---------------------------------------------------------------------------

test('超过上限的真实请求体 → 被拒（PAYLOAD_TOO_LARGE），不落库，服务不崩', async () => {
  const body = JSON.stringify({ content: `${MARKER} ${'x'.repeat(90 * 1024)}` });
  assert.ok(Buffer.byteLength(body) > MAX_BODY_BYTES, '请求体必须真超上限');

  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body,
  });

  // 被拒（不是 201，也不是把 90KB 读进内存）
  assert.ok(res.status >= 400, `超大请求应被拒绝，实际 ${res.status}`);
  assert.equal(res.timedOut, false, '连接不能被挂住（有界读取必须立刻收工并丢字节）');
  assert.match(res.raw, /PAYLOAD_TOO_LARGE/, '错误码要稳定可判');
  // 不回显请求体（错误响应只给稳定错误码与一句话）
  assert.equal(res.body.includes(MARKER), false, '错误响应回显了请求体内容');

  // 不落库
  const listed = await listMemories();
  assert.equal(listed.total, baselineTotal, '超大请求不该产生任何记忆');
  assert.equal(
    JSON.stringify(listed.items).includes(MARKER),
    false,
    '超大请求的正文出现在了列表里',
  );

  // 服务不崩
  const ping = await server.request('/api/ping', { token: null });
  assert.equal(ping.status, 200);
  assert.equal(ping.json.ok, true);
});

// ---------------------------------------------------------------------------
// 2. 不靠 Content-Length 自报：chunked 流式超大 body 也拦得住
// ---------------------------------------------------------------------------

test('chunked 流式超大 body（无 Content-Length）→ 读到超限即拒，服务不崩', async () => {
  // 只发到「刚好超过上限」就停、且**不发终止块**：服务端必须按已读字节数判断，
  // 而不是等客户端把整个 body 发完（这正是「不能靠 Content-Length 自报」的含义）。
  const overshoot = 2 * 1024;
  const body = Buffer.from(
    JSON.stringify({ content: `${MARKER} ${'y'.repeat(MAX_BODY_BYTES + overshoot)}` }),
    'utf8',
  );
  const sendBytes = MAX_BODY_BYTES + overshoot;

  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body,
    chunked: true,
    stopAfterBytes: sendBytes,
  });

  assert.ok(res.status >= 400, `chunked 超大请求应被拒绝，实际 ${res.status}（endedBy=${res.endedBy}）`);
  assert.equal(res.timedOut, false, '连接不能被挂住');
  assert.match(res.raw, /PAYLOAD_TOO_LARGE/, '错误码要稳定可判');

  const listed = await listMemories();
  assert.equal(listed.total, baselineTotal, 'chunked 超大请求不该产生任何记忆');

  const ping = await server.request('/api/ping', { token: null });
  assert.equal(ping.status, 200);
});

test('chunked 猛发不停止 → 服务端提前关闭连接（不把整个 body 读完），仍不落库、不崩', async () => {
  // 这一条不要求客户端收到错误响应：服务端在有未读入站数据时关闭连接，
  // Windows 会发 RST，客户端接收缓冲可能被丢弃（表现为 ECONNABORTED / 空响应）。
  // 真正的断言是「服务端没有乖乖把 1MB 读完才回应」：连接被提前中止、没有落库、进程还活着。
  const body = Buffer.from(
    JSON.stringify({ content: `${MARKER} ${'q'.repeat(1024 * 1024)}` }),
    'utf8',
  );
  const startedAt = Date.now();
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body,
    chunked: true,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(res.timedOut, false, '连接不能被挂住');
  // 要么收到了 4xx/5xx（服务端先 flush 再关），要么被服务端提前中止（写失败 / 空响应）。
  assert.ok(
    res.status >= 400 || res.writeError !== null,
    `服务端应在超限时提前收工，实际 status=${res.status} writeError=${res.writeError} endedBy=${res.endedBy}`,
  );
  assert.ok(elapsedMs < 5_000, `不该等满 1MB 传完，实际 ${elapsedMs}ms`);

  const listed = await listMemories();
  assert.equal(listed.total, baselineTotal, '猛发的超大请求不该产生任何记忆');
  const ping = await server.request('/api/ping', { token: null });
  assert.equal(ping.status, 200);
});

// ---------------------------------------------------------------------------
// 3. 状态码契约：请求体超限 → 413 Content Too Large
// ---------------------------------------------------------------------------

test('状态码：超限请求回 413（不是 500）', async () => {
  const body = JSON.stringify({ content: `${MARKER} ${'z'.repeat(80 * 1024)}` });
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
    body,
  });

  // 契约（RFC 9110 与设计方案 §22.4）：请求体超限 → 413 Content Too Large。
  //
  // 这条测试本来是「提醒式」的：第一版断言的是 500，因为当时 mapError 只按 code 查表、
  // 没有 PAYLOAD_TOO_LARGE 分支，readBody 设了 err.status=413 也被改写成 500。
  // 2026-10-29 补上分支后，期望值改成 413 —— 提醒生效了，这是它该有的下场。
  assert.equal(res.status, 413, `超限请求应回 413，实际 ${res.status}`);
  assert.match(res.body, /PAYLOAD_TOO_LARGE/);
  assert.equal(res.timedOut, false);
});

// ---------------------------------------------------------------------------
// 4. 谎报 Content-Length：HTTP 层不接受「少报长度 + 偷塞大 body」
// ---------------------------------------------------------------------------

test('谎报 Content-Length（少报）不会把超大 body 写进库', async () => {
  const body = JSON.stringify({ content: `${MARKER} ${'w'.repeat(100 * 1024)}` });
  const res = await rawRequest({
    port: server.port,
    pathname: '/api/memories',
    method: 'POST',
    // 自报 16 字节，实际发 100KB+：Node 的 HTTP 解析器按 CL 截断，剩余字节被当成
    // 第二个请求 → clientError 400。关键是：**没有任何一条被当成合法写请求落库**。
    headers: {
      Authorization: `Bearer ${TEST_TOKEN}`,
      'Content-Type': 'application/json',
      'Content-Length': '16',
    },
    body,
  });

  assert.ok(res.status >= 400, `谎报长度应被拒，实际 ${res.status}`);
  assert.equal(res.timedOut, false);
  const listed = await listMemories();
  assert.equal(listed.total, baselineTotal, '谎报 Content-Length 的请求不该落库');
  const ping = await server.request('/api/ping', { token: null });
  assert.equal(ping.status, 200);
});

// ---------------------------------------------------------------------------
// 5/6. 边界：恰好上限放行、超一个字节就拒（用独立实例，避免影响上面的基线）
// ---------------------------------------------------------------------------

test('边界：恰好等于上限的请求体不被读体上限误杀；超一个字节就拒', async () => {
  const edgeBrain = await createTempBrain();
  const edge = await startTestServer({ dbPath: edgeBrain.dbPath });
  try {
    const exact = exactSizeJson(MAX_BODY_BYTES);
    assert.equal(Buffer.byteLength(exact), MAX_BODY_BYTES, '构造的请求体必须恰好等于上限');
    const accepted = await rawRequest({
      port: edge.port,
      pathname: '/api/memories',
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: exact,
    });
    // 允许 201（filler 被忽略）或 400 INVALID_ARGUMENT（未知字段被拒）——
    // 唯一不允许的是「被读体上限拦下」。
    assert.equal(
      accepted.raw.includes('PAYLOAD_TOO_LARGE'),
      false,
      `恰好等于上限不该被 413 拦，实际 ${accepted.status}：${accepted.body.slice(0, 200)}`,
    );

    const over = exactSizeJson(MAX_BODY_BYTES + 1);
    assert.equal(Buffer.byteLength(over), MAX_BODY_BYTES + 1);
    const rejected = await rawRequest({
      port: edge.port,
      pathname: '/api/memories',
      method: 'POST',
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, 'Content-Type': 'application/json' },
      body: over,
    });
    assert.ok(rejected.status >= 400, '超一个字节也必须拒');
    assert.match(rejected.raw, /PAYLOAD_TOO_LARGE/);

    const ping = await edge.request('/api/ping', { token: null });
    assert.equal(ping.status, 200);
  } finally {
    await edge.close();
    await edgeBrain.close();
  }
});
