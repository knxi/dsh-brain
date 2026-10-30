// @ts-check
/**
 * M7.2：插件侧主账桥接（`plugins/dsh-fox-mood/brain-bridge.js`）。
 *
 * 这一层是「brain.db 唯一真相、state.json 降级」的落地处，所以压三类东西：
 *   A. 纯函数（合并 / 映射）—— 决定「谁更新」「事件怎么并」，错一条就丢事实；
 *   B. 降级路径 —— 主账拿不到时必须返回 null **而不抛**（插件功能一个不少）；
 *   C. 真连上一个临时主账 —— 写进去、读回来，证明桥接不是纸上接线。
 *
 * 纪律：全程 mkdtemp 临时库，不碰 `data/brain.db`。
 */

import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assert,
  BRIDGE_ENTRY,
  MEMORY_ENTRY,
  fixedClock,
} from './helpers.mjs';
import { openBrain } from '../../../packages/memory/src/index.js';

// 动态 import 只接受 URL / 裸名，不接受 Windows 绝对路径（ERR_UNSUPPORTED_ESM_URL_SCHEME）
const {
  createBrainBridge,
  mergeEvents,
  mergeMoodState,
  resolveEntry,
  rowToCoreState,
  stateToRow,
} = await import(pathToFileURL(BRIDGE_ENTRY).href);

/** 一份 core 形状的状态（毫秒时间戳，跟 core.js 的形态一致）。 */
const LOCAL_STATE = Object.freeze({
  version: 1,
  mood: 86.55,
  energy: 94.26,
  bond: 93.3,
  createdAt: 1792471298296,
  updatedAt: 1793356703343,
  lastInteractAt: 1793355696670,
  lastProactiveAt: 0,
  events: [{ at: 1793355696670, kind: 'success', note: '办成了', delta: { mood: 8 } }],
});

test('resolveEntry：裸名原样、绝对路径转 file URL、file URL 原样', () => {
  assert.equal(resolveEntry('@dsh-brain/memory'), '@dsh-brain/memory');
  assert.equal(resolveEntry('E:/ds-h/dsh-brain/packages/memory/src/index.js'), 'file:///E:/ds-h/dsh-brain/packages/memory/src/index.js');
  assert.equal(resolveEntry('E:\\ds-h\\x.js'), 'file:///E:/ds-h/x.js');
  assert.equal(resolveEntry('file:///E:/x.js'), 'file:///E:/x.js');
  assert.equal(resolveEntry(''), '');
});

test('mergeEvents：并集按 (at, kind) 去重、升序、只留 60 条、note 非空者优先', () => {
  const local = [
    { at: 1000, kind: 'chat', note: '', delta: {} },
    { at: 3000, kind: 'praise', note: '本地' },
  ];
  const remote = [
    { at: 2000, kind: 'success', note: '主账' },
    { at: 3000, kind: 'praise', note: '主账有 note' },
  ];
  const merged = mergeEvents(local, remote);
  assert.deepEqual(merged.map((event) => event.at), [1000, 2000, 3000], '升序（core.js 的 events 是正序）');
  assert.equal(merged.length, 3, '同 (at, kind) 只留一条');
  assert.equal(
    merged[2].note,
    '本地',
    '两条 note 都非空时保留先到的：不拼文本（拼出来的句子没人写过，以后会当成真实记录）',
  );
  assert.equal(merged[0].kind, 'chat');

  // 同键时「note 非空者优先」——空的那个让位
  const filled = mergeEvents(
    [{ at: 1, kind: 'chat', note: '' }],
    [{ at: 1, kind: 'chat', note: '主账有 note' }],
  );
  assert.equal(filled[0].note, '主账有 note', '本地这条 note 是空的，让主账那句更完整的进去');

  // 空值 / 坏值不炸
  assert.deepEqual(mergeEvents(undefined, null), []);
  assert.deepEqual(
    mergeEvents([{ at: 1 }], []).length,
    0,
    '没有 kind 的条目不是事件，丢掉而不是存成半条',
  );

  // 超过 60 条只留最近 60（core.js 的窗口）
  const many = Array.from({ length: 80 }, (_, index) => ({ at: index, kind: 'chat' }));
  const trimmed = mergeEvents(many, []);
  assert.equal(trimmed.length, 60);
  assert.equal(trimmed[0].at, 20, '留的是最近 60 条');
  assert.equal(trimmed.at(-1).at, 79);
});

test('mergeMoodState：按 updatedAt 选新，相等时取主账，事件取并集', () => {
  const remoteNewer = { ...LOCAL_STATE, mood: 50, updatedAt: LOCAL_STATE.updatedAt + 1000, events: [] };
  assert.equal(mergeMoodState(LOCAL_STATE, remoteNewer).source, 'brain');
  assert.equal(mergeMoodState(LOCAL_STATE, remoteNewer).state.mood, 50);

  const remoteOlder = { ...LOCAL_STATE, mood: 50, updatedAt: LOCAL_STATE.updatedAt - 1000, events: [] };
  const older = mergeMoodState(LOCAL_STATE, remoteOlder);
  assert.equal(older.source, 'local');
  assert.equal(older.state.mood, 86.55, '本地更新就保留本地数值');

  // 相等（迁移刚做完的典型情况）→ 取主账，避免「迁移完第一次启动又转回旧值」
  const remoteSame = { ...LOCAL_STATE, mood: 42, events: [] };
  assert.equal(mergeMoodState(LOCAL_STATE, remoteSame).source, 'brain');
  assert.equal(mergeMoodState(LOCAL_STATE, remoteSame).state.mood, 42);

  // 任一为空
  assert.equal(mergeMoodState(LOCAL_STATE, null).source, 'local');
  assert.equal(mergeMoodState(null, remoteNewer).source, 'brain');

  // 事件永远是并集：被选中的那一侧缺事件时，另一侧的也要带上
  const withEvents = mergeMoodState(
    { ...LOCAL_STATE, updatedAt: 1000, events: [{ at: 500, kind: 'chat', note: '本地独有' }] },
    { ...LOCAL_STATE, updatedAt: 2000, events: [{ at: 900, kind: 'praise', note: '主账独有' }] },
  );
  assert.deepEqual(
    withEvents.state.events.map((event) => event.kind),
    ['chat', 'praise'],
    '事件并集：两侧独有的事实都不许丢',
  );
});

test('rowToCoreState：ISO → 毫秒，事件反转成升序；stateToRow 反向不丢 0', () => {
  const row = {
    version: 1,
    mood: 86.55,
    energy: 94.26,
    bond: 93.3,
    createdAt: '2026-10-20T04:41:38.296Z',
    updatedAt: '2026-10-30T10:38:23.343Z',
    lastInteractAt: 1793355696670,
    lastProactiveAt: 0,
  };
  const back = rowToCoreState(row, [
    { at: 3000, kind: 'praise', note: null, delta: { mood: 7 } },
    { at: 1000, kind: 'chat', note: '', delta: {} },
  ]);
  assert.equal(back.createdAt, 1792471298296);
  assert.equal(back.updatedAt, 1793356703343);
  assert.equal(back.lastProactiveAt, 0, '0 = 从没主动过，不许变成 null');
  assert.deepEqual(back.events.map((event) => event.at), [1000, 3000], '门面给的是新→旧，core 要升序');
  assert.equal(back.events[0].note, '', 'null note 转成空串（core.normalize 的期待形态）');

  // 反向：毫秒原样传给门面（门面负责转 ISO）
  const mapped = stateToRow(LOCAL_STATE);
  assert.equal(mapped.updatedAt, 1793356703343);
  assert.equal(mapped.lastProactiveAt, 0);
  assert.equal(mapped.lastInteractAt, 1793355696670);
  assert.equal(mapped.mood, 86.55);
});

test('降级：主账拿不到时 load() 返回 null、persist() 不抛、status=degraded', async () => {
  const debugLines = [];
  const bridge = createBrainBridge({
    dbPath: path.join(tmpdir(), 'not-a-real-dir-' + Date.now(), 'brain.db'),
    entries: [path.join(tmpdir(), 'no-such-module-' + Date.now() + '.js')],
    retryMs: 60_000,
    debug: (line) => debugLines.push(line),
  });
  assert.equal(bridge.status(), 'degraded');
  assert.equal(await bridge.load(), null, '连不上就是 null，不是抛错');
  // fire-and-forget 也不许产生未处理拒绝
  await bridge.persist(LOCAL_STATE, LOCAL_STATE.events[0]);
  assert.equal(bridge.status(), 'degraded');
  assert.ok(bridge.lastError(), '失败原因要留着（排查时不至于两眼一抹黑）');
  assert.ok(debugLines.some((line) => line.includes('降级')), '降级这件事必须进调试日志');
  await bridge.dispose();

  // 显式关掉时连一次都不试
  const off = createBrainBridge({ disabled: true });
  assert.equal(await off.connect(), null);
  assert.equal(await off.load(), null);
});

test('真连一个临时主账：persist 写进去、load 读回来（状态 + 事件都在）', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m7-bridge-'));
  const dbPath = path.join(dir, 'brain.db');
  // 先建库（跑迁移），然后关掉——桥接自己会再开一个连接
  const seed = openBrain({ dbPath, clock: fixedClock().clock });
  await seed.close();
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  const debugLines = [];
  const bridge = createBrainBridge({
    dbPath,
    entries: [MEMORY_ENTRY],
    debug: (line) => debugLines.push(line),
  });
  t.after(async () => {
    await bridge.dispose();
  });

  assert.equal(await bridge.load(), null, '空主账里还没有状态行 → null（不是失败）');
  assert.equal(bridge.status(), 'connected', '空库也算连上');

  await bridge.persist(LOCAL_STATE, LOCAL_STATE.events[0]);
  await bridge.flush();

  const loaded = await bridge.load();
  assert.ok(loaded, '写完之后必须读得回来');
  const core = rowToCoreState(loaded.state, loaded.events);
  assert.equal(core.mood, 86.55);
  assert.equal(core.updatedAt, LOCAL_STATE.updatedAt, 'updatedAt 往返不漂（这是演化起点，漂了就算丢时间）');
  assert.equal(core.events.length, 1);
  assert.equal(core.events[0].kind, 'success');
  assert.deepEqual(core.events[0].delta, { mood: 8 }, 'delta 往返不丢');

  // 幂等重放：再写一次同样的事件，主账不许出现第二条
  await bridge.persist(LOCAL_STATE, LOCAL_STATE.events[0]);
  await bridge.flush();
  const after = await bridge.load();
  assert.equal(after.events.length, 1, '同一 (at, kind) 重放不制造第二条');

  // 用一个独立只读连接核对落库形态（别只信门面自己说的话）
  const check = openBrain({ dbPath, readOnly: true });
  const stateRow = /** @type {Record<string, any>} */ (check.db.prepare('SELECT * FROM fox_state WHERE id = 1').get());
  assert.equal(Number(stateRow.mood), 86.55);
  assert.equal(stateRow.updated_at, '2026-10-30T10:38:23.343Z');
  assert.equal(Number(stateRow.last_proactive_at), 0);
  const eventRows = /** @type {Array<Record<string, any>>} */ (check.db.prepare('SELECT * FROM fox_events').all());
  assert.equal(eventRows.length, 1);
  assert.equal(String(eventRows[0].kind), 'success');
  assert.equal(String(eventRows[0].source_system), 'fox-mood', '实时写入的来源记 fox-mood');
  await check.close();
});
