// @ts-check
/**
 * M7.2 端到端：真实插件（`plugins/dsh-fox-mood/index.js`）在「主账可用」时的双写。
 *
 * 前面两条测试分别压了门面和桥接，但它们证明不了**接线对了**——
 * 插件是否真的在 apply 时把状态写进主账、`fox_feel` 是否真的把事件写进 `fox_events`、
 * state.json 是否仍然是完整副本。这条就是来钉这三件事的。
 *
 * 做法：mkdtemp 造两个临时目录（插件状态目录 + 主账目录），用假 ctx 跑 apply，
 * 然后轮询主账直到写入落地（插件的写是 fire-and-forget，不阻塞对话）。
 *
 * 纪律：
 * - 绝不碰 `~/.dsh/fox-mood/state.json` 与 `data/brain.db`（两个路径都显式覆盖）；
 * - 结束恢复环境变量，不污染同进程的其它测试（`--test-isolation=none` 是共享进程）。
 */

import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openBrain } from '../../../packages/memory/src/index.js';
import { assert, fixedClock } from './helpers.mjs';

/** 真实插件的 Host 半边（Host 目录不在本仓库包内，往上四层）。 */
const PLUGIN_ENTRY = pathToFileURL(
  fileURLToPath(new URL('../../../../plugins/dsh-fox-mood/index.js', import.meta.url)),
).href;

/**
 * 假 ctx：够 apply() 用（工具注册 / 事件监听 / effect / webServer）。
 */
function makeCtx() {
  const tools = new Map();
  const listeners = new Map();
  const disposers = [];
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    on(event, fn) {
      listeners.set(event, fn);
      return () => listeners.delete(event);
    },
    effect(fn) {
      const result = fn();
      if (typeof result === 'function') disposers.push(result);
      return () => {};
    },
    get: () => null,
    webServer: { register: () => () => {} },
  };
  return { ctx, tools, listeners, disposers };
}

/**
 * 轮询等待条件成立（插件写主账是异步 fire-and-forget，没有可 await 的句柄）。
 * @param {() => boolean} predicate
 * @param {{ timeoutMs?: number, label?: string }} [opts]
 */
async function waitFor(predicate, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('等待超时：' + (opts.label ?? '条件始终不成立'));
}

test('主账可用：apply 写状态、fox_feel 写事件、state.json 仍是完整副本', async (t) => {
  const previousStateDir = process.env.FOX_MOOD_DIR;
  const previousBrainFlag = process.env.FOX_MOOD_BRAIN;
  const root = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m7-e2e-'));
  const moodDir = path.join(root, 'mood');
  const dbPath = path.join(root, 'brain.db');

  process.env.FOX_MOOD_DIR = moodDir;
  delete process.env.FOX_MOOD_BRAIN; // 确保桥接是开着的

  // 先把主账建好（跑完迁移），再让插件连——模拟「迁移已执行、插件重启」
  const seed = openBrain({ dbPath, clock: fixedClock().clock });
  await seed.close();

  const { ctx, tools, disposers } = makeCtx();
  const { apply } = await import(PLUGIN_ENTRY);
  apply(ctx, { brainDb: dbPath });

  t.after(async () => {
    // 先拆插件（关主账连接），再恢复环境变量
    for (const dispose of disposers) {
      try {
        await dispose();
      } catch {
        /* 卸载期失败不影响断言 */
      }
    }
    if (previousStateDir === undefined) delete process.env.FOX_MOOD_DIR;
    else process.env.FOX_MOOD_DIR = previousStateDir;
    if (previousBrainFlag === undefined) delete process.env.FOX_MOOD_BRAIN;
    else process.env.FOX_MOOD_BRAIN = previousBrainFlag;
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟释放不影响断言 */
    }
  });

  const reader = openBrain({ dbPath, readOnly: true });
  t.after(async () => {
    try {
      await reader.close();
    } catch {
      /* ignore */
    }
  });
  const count = (/** @type {string} */ table) =>
    Number(/** @type {{ n?: number }} */ (reader.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).n ?? 0);

  // 1. apply 首次落盘就把状态写进主账（面板在第一次对话前就能读到东西）
  await waitFor(() => count('fox_state') === 1, { label: '主账里出现 fox_state 那一行' });
  const stateRow = /** @type {Record<string, any>} */ (reader.db.prepare('SELECT * FROM fox_state WHERE id = 1').get());
  assert.equal(Number(stateRow.version), 1);
  assert.ok(Number(stateRow.mood) > 0 && Number(stateRow.mood) <= 100, '心情必须落在 0..100');
  assert.match(String(stateRow.updated_at), /^\d{4}-\d{2}-\d{2}T.*Z$/, 'updated_at 是 UTC ISO');

  // 2. state.json 也写了（缓存副本，降级时全靠它）
  const fileState = JSON.parse(readFileSync(path.join(moodDir, 'state.json'), 'utf8'));
  assert.equal(fileState.version, 1);
  assert.ok(Array.isArray(fileState.events));

  // 3. fox_feel 记账 → 事件进主账 + 状态被更新
  const tool = tools.get('fox_feel');
  assert.ok(tool, '必须注册 fox_feel');
  const result = await tool.execute({ kind: 'praise', note: '端到端双写验证' });
  assert.equal(result.ok, true);

  await waitFor(() => count('fox_events') === 1, { label: '主账里出现那条 praise 事件' });
  const eventRow = /** @type {Record<string, any>} */ (reader.db.prepare('SELECT * FROM fox_events').get());
  assert.equal(String(eventRow.kind), 'praise');
  assert.equal(String(eventRow.note), '端到端双写验证');
  assert.equal(String(eventRow.source_system), 'fox-mood', '实时写入的来源是 fox-mood');
  const delta = JSON.parse(String(eventRow.delta_json));
  assert.ok(Number.isFinite(Number(delta.mood)), 'delta 里必须带心情增量（「为什么变了」的依据）');

  // 4. 同一条事件在 state.json 里也在（**降级不丢状态**：两边都留）
  const afterFeel = JSON.parse(readFileSync(path.join(moodDir, 'state.json'), 'utf8'));
  const fileEvent = afterFeel.events.find((event) => event.note === '端到端双写验证');
  assert.ok(fileEvent, 'state.json 里必须有同一条事件（缓存副本不能是残的）');
  assert.equal(fileEvent.kind, 'praise');
  assert.equal(Number(fileEvent.at), Number(eventRow.at), '两边的时间戳必须是同一个（同一次记账）');
});
