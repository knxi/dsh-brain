// @ts-check
/**
 * 控制台页面测试：托管方式、凭据注入方式、四块结构、CSP 与静态白名单。
 *
 * 重点不是「HTML 里有几个 div」，而是：
 * - 凭据怎么送到页面的（meta，不进 URL）；
 * - 页面结构是否真的包含四块检查器；
 * - 静态资源是不是白名单托管（不做任意路径映射）。
 */

import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, createTempBrain, startTestServer } from './helpers.mjs';

const CONSOLE_DIR = fileURLToPath(new URL('../../../apps/console/', import.meta.url));

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

test('GET / ：返回页面，凭据只出现在 meta 里', async () => {
  const { status, headers, text } = await server.request('/', { token: null });
  assert.equal(status, 200);
  assert.match(String(headers.get('content-type')), /text\/html/);
  assert.match(text, /<html lang="zh-CN">/);

  // 凭据通过 meta 注入（页面自己拿去放 Authorization 头）
  assert.match(text, /<meta name="brain-token" content="[A-Za-z0-9_-]{32,}"/);
  assert.ok(text.includes(server.token), '页面应当拿到凭据');

  // 但绝不能出现在 URL 形态里（浏览器历史 / Referer / 书签都会泄漏）
  assert.equal(text.includes('?token='), false);
  assert.equal(text.includes('?token%3D'), false);
  assert.equal(/href="[^"]*token/i.test(text), false);

  // 也不能有内联脚本（CSP 是 script-src 'self'）
  assert.equal(/<script(?![^>]*src=)[^>]*>/.test(text), false, '不允许内联 <script>');
});

test('GET / ：四块检查器的根节点都在', async () => {
  const { text } = await server.request('/');
  for (const id of ['view-memories', 'view-context', 'view-search', 'view-health']) {
    assert.ok(text.includes(`id="${id}"`), `缺少区块 ${id}`);
  }
  // 三级证据与四态诊断的关键文案
  assert.ok(text.includes('built'));
  assert.ok(text.includes('attached'));
  assert.ok(text.includes('sent'));
  assert.ok(text.includes('no_related'));
  assert.ok(text.includes('insufficient_evidence'));
  assert.ok(text.includes('source_missing'));
  assert.ok(text.includes('source_conflict'));
});

test('页面不写内联 style 属性（CSP style-src 不含 unsafe-inline）', async () => {
  const { text } = await server.request('/');
  const inlineStyle = /<[^>]+\sstyle="/.test(text);
  assert.equal(inlineStyle, false, '页面骨架里不该有内联 style');
});

test('GET /assets/app.js 与 styles.css：正确 content-type', async () => {
  const js = await server.request('/assets/app.js', { token: null });
  assert.equal(js.status, 200);
  assert.match(String(js.headers.get('content-type')), /javascript/);
  assert.ok(js.text.includes('brain-token'), '前端要从 meta 读凭据');

  const css = await server.request('/assets/styles.css', { token: null });
  assert.equal(css.status, 200);
  assert.match(String(css.headers.get('content-type')), /text\/css/);
  assert.ok(css.text.includes('--font-mono'), '等宽数字是硬要求');
});

test('前端代码不使用 innerHTML 落地数据、不写内联 style', () => {
  const js = readFileSync(path.join(CONSOLE_DIR, 'app.js'), 'utf8');
  assert.equal(/\.innerHTML\s*=/.test(js), false, '禁止用 innerHTML 落地数据');
  assert.equal(/\.style\./.test(js), false, 'CSP 会拦掉 inline style，别用 .style');
  assert.equal(/insertAdjacentHTML/.test(js), false);
  assert.equal(/document\.write/.test(js), false);
  // 凭据只能从 meta / 内存里来，不许从 URL 读
  assert.equal(/location\.search/.test(js), false, '不许从 query 读凭据');
  assert.ok(js.includes('name="brain-token"'));
});

test('favicon 请求回 204（不污染日志、不 404）', async () => {
  const { status } = await server.request('/favicon.ico', { token: null });
  assert.equal(status, 204);
});

test('页面带头部安全策略：不可缓存、不可嵌框、无 CORS', async () => {
  const { headers } = await server.request('/', { token: null });
  assert.match(String(headers.get('cache-control')), /no-store/);
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('access-control-allow-origin'), null);
  assert.match(String(headers.get('content-security-policy')), /script-src 'self'/);
});

test('控制台只有三个文件（白名单之外 404）', async () => {
  for (const name of ['package.json', 'assets/nope.js', 'src/server.mjs', '../package.json']) {
    const res = await server.request(`/${name}`, { token: null });
    assert.equal(res.status, 404, `${name} 不该被托管`);
  }
});
