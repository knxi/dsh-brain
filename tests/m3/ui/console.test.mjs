// @ts-check
/**
 * 控制台页面（M3 部分）：两块新视图的结构、隔离横幅、以及前端纪律。
 *
 * 这些断言防的是「看着像做了」：横幅只是个 div、四层其实合并成一栏、前端偷偷用 innerHTML。
 */

import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert, createTempBrain, startUiServer } from './helpers.mjs';

const CONSOLE_DIR = fileURLToPath(new URL('../../../apps/console/', import.meta.url));

/** @type {Awaited<ReturnType<typeof startUiServer>>} */
let server;
/** @type {Awaited<ReturnType<typeof createTempBrain>>} */
let tmp;

test.before(async () => {
  tmp = await createTempBrain();
  server = await startUiServer({
    dbPath: tmp.dbPath,
    backupDir: tmp.backupsDir,
    stateDir: tmp.stateDir,
  });
});

test.after(async () => {
  await server?.close();
  await tmp?.close();
});

test('页面有删除状态与备份中心两块视图的根节点', async () => {
  const { text } = await server.request('/');
  assert.ok(text.includes('id="view-deletions"'), '缺少删除状态视图');
  assert.ok(text.includes('id="view-backups"'), '缺少备份中心视图');
  assert.ok(text.includes('data-view="deletions"'), '导航里没有删除入口');
  assert.ok(text.includes('data-view="backups"'), '导航里没有备份入口');
});

test('隔离横幅的 DOM 骨架必须在（有条文、有原因容器、有出口）', async () => {
  const { text } = await server.request('/');
  assert.ok(text.includes('id="isolation-banner"'), '缺少隔离横幅容器');
  assert.ok(text.includes('role="alert"'), '横幅要能被读屏播报');
  assert.ok(text.includes('这个实例不能上线，只能只读检修'), '横幅没说清楚「不能上线」');
  assert.ok(text.includes('id="isolation-reasons"'), '横幅要能列出具体原因');
  assert.ok(text.includes('id="isolation-go"'), '横幅要给出修复出口');
  // 默认隐藏：只有 promoted=false 才显示
  assert.match(text, /id="isolation-banner"[^>]*hidden/);
});

test('删除四层在前端分别渲染，不许合并成一栏', async () => {
  const js = readFileSync(path.join(CONSOLE_DIR, 'app.js'), 'utf8');
  // 四层的 key 必须各自出现（顺序即语义）
  for (const key of ['shielded', 'onlineCleanup', 'backupExpiry', 'external']) {
    assert.ok(js.includes(`'${key}'`), `前端缺少第 ${key} 层`);
  }
  assert.ok(js.includes('四层状态'), '缺少四层区块标题');
  // 每层有独立的数据态（不同视觉）
  assert.ok(js.includes("'data-state': state"), '四层要走 data-state 区分视觉');
  // 后端给的 caveats 必须被渲染出来（「三件事不在同一刻」就是从这里来的）
  assert.ok(js.includes('report.caveats'), '前端没渲染 caveats，结论会缺前提');

  // 页面的引子要先说清楚「不是一件事」
  const { text } = await server.request('/');
  assert.ok(text.includes('不在同一刻完成'), '页面没解释四层的时间差异');
});

test('备份中心覆盖时间/版本/watermark/校验/大小', async () => {
  const { text } = await server.request('/');
  for (const th of ['时间', '类型', '版本', 'watermark', '大小', '校验']) {
    assert.ok(text.includes(`>${th}<`), `备份表缺列 ${th}`);
  }
  // 能力条：备份/恢复/目录/保留
  for (const id of ['cap-backup', 'cap-restore', 'cap-dir', 'cap-keep', 'backup-create']) {
    assert.ok(text.includes(`id="${id}"`), `能力条缺 ${id}`);
  }
});

test('恢复执行在 UI 上也是「默认预演」：真执行要手输确认', () => {
  const js = readFileSync(path.join(CONSOLE_DIR, 'app.js'), 'utf8');
  assert.ok(js.includes('预演恢复'), '缺少预演按钮');
  assert.ok(js.includes('真执行恢复'), '缺少真执行按钮');
  assert.ok(js.includes("value.trim() === 'RESTORE'"), '真执行必须要求手输 RESTORE');
  assert.ok(js.includes('dryRun: false'), '真执行时要显式带 dryRun:false');
  // 默认按钮是禁用的
  assert.match(js, /type: 'button',\s*disabled: true \}/, '真执行按钮默认必须禁用');
});

test('前端纪律：不用 innerHTML、不写内联 style、不从 URL 读凭据', () => {
  const js = readFileSync(path.join(CONSOLE_DIR, 'app.js'), 'utf8');
  assert.equal(/\.innerHTML\s*=/.test(js), false, '禁止用 innerHTML 落地数据');
  assert.equal(/\.style\./.test(js), false, 'CSP 会拦 inline style，别用 .style');
  assert.equal(/insertAdjacentHTML/.test(js), false);
  assert.equal(/location\.search/.test(js), false, '不许从 query 读凭据');
});

test('样式里有隔离横幅与四层时间线的定义', () => {
  const css = readFileSync(path.join(CONSOLE_DIR, 'styles.css'), 'utf8');
  for (const sel of ['.isolated', '.isolated__title', '.layers', '.layer__no', '.capbar', '.restorebox', '.confirmrow']) {
    assert.ok(css.includes(sel), `样式缺 ${sel}`);
  }
  // 四层用不同状态色：done/active/blocked/unknown 都要有
  for (const state of ['done', 'active', 'blocked', 'unknown']) {
    assert.ok(css.includes(`.layer[data-state="${state}"]`), `四层缺 ${state} 状态样式`);
  }
});

test('页面里没有内联 style（CSP style-src 不含 unsafe-inline）', async () => {
  const { text } = await server.request('/');
  assert.equal(/<[^>]+\sstyle="/.test(text), false, '页面骨架里不该有内联 style');
  const { headers } = await server.request('/');
  const csp = String(headers.get('content-security-policy') ?? '');
  assert.equal(csp.includes('unsafe-inline'), false);
});
