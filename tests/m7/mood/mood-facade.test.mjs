// @ts-check
/**
 * M7.2：`mood` 门面（fox_state / fox_events）。
 *
 * 压的是任务书里的六条必测项，每条一个 test，期望值手算写死：
 *  1. saveState 幂等（单行 / 不刷 created_at / created 标志）   → test 1
 *  2. getState 往返（毫秒 → ISO → 毫秒，边界值不漂）            → test 2
 *  3. appendEvent + listEvents 排序（新→旧、同 at 也不乱）      → test 3
 *  4. pruneEvents（只留最近 N 条，返回删了几条）                 → test 4
 *  5. delta JSON 往返（数值不丢、脏数据不炸）                    → test 5
 *  6. 空库不炸（null / [] / 0，且不抛）                          → test 6
 *
 * 附加边界（都是这一层真会踩的）：
 *  7. 非有限数一律拒（NaN/Infinity 不是「心情」）
 *  8. note 截断 500 字；delta 非对象拒
 *  9. 事件 (at, kind) 幂等
 * 10. 单行约束是 schema 级（CHECK id = 1），不只是门面纪律
 * 11. **不做 scope 过滤**：两张表没有 scope_id 列，传 scopeId 也不生效（CONTRACTS §19）
 * 12. 不进检索：写事件不会往 memories 里塞任何东西
 */

import test from 'node:test';
import { assert, columnNames, countRows, createBrain } from './helpers.mjs';

/** 一份跟生产实测值同量级的状态（mood 86.55 / energy 94.26 / bond 93.30）。 */
const STATE = Object.freeze({
  version: 1,
  mood: 86.55,
  energy: 94.26,
  bond: 93.3,
  createdAt: 1792471298296,
  updatedAt: 1793356703343,
  lastInteractAt: 1793355696670,
  lastProactiveAt: 0,
});

test('saveState：单行 upsert，重复写幂等，created_at 不被刷', async (t) => {
  const { brain } = createBrain(t);
  const first = await brain.mood.saveState(STATE);
  assert.equal(first.created, true, '第一次写必须报 created');
  assert.equal(first.updatedAt, new Date(STATE.updatedAt).toISOString(), 'updatedAt 必须如实回显 ISO');

  const rowAfterFirst = /** @type {Record<string, any>} */ (
    brain.db.prepare('SELECT * FROM fox_state WHERE id = 1').get()
  );
  assert.equal(rowAfterFirst.created_at, new Date(STATE.createdAt).toISOString());
  // local 列是同一时刻的 +08:00 形态（2026-10-20 那批时间戳在 Asia/Shanghai 是某个下午）
  assert.match(String(rowAfterFirst.created_at_local), /\+08:00$/);

  const second = await brain.mood.saveState({ ...STATE, mood: 90, updatedAt: STATE.updatedAt + 60_000 });
  assert.equal(second.created, false, '第二次写必须报 created:false');
  assert.equal(countRows(brain.db, 'fox_state'), 1, '单行表不许写出第二行');
  const rowAfterSecond = /** @type {Record<string, any>} */ (
    brain.db.prepare('SELECT * FROM fox_state WHERE id = 1').get()
  );
  assert.equal(Number(rowAfterSecond.mood), 90, '数值要更新');
  assert.equal(
    rowAfterSecond.created_at,
    new Date(STATE.createdAt).toISOString(),
    'created_at 是「这份状态第一次进主账的时刻」，重复 save 不许刷掉',
  );
});

test('getState：往返一致（毫秒 ↔ ISO），空库返回 null', async (t) => {
  const { brain } = createBrain(t);
  assert.equal(brain.mood.getState(), null, '空库必须返回 null，不许造一份默认状态');

  await brain.mood.saveState(STATE);
  const state = brain.mood.getState();
  assert.ok(state);
  assert.equal(state.mood, 86.55);
  assert.equal(state.energy, 94.26);
  assert.equal(state.bond, 93.3);
  assert.equal(state.version, 1);
  assert.equal(state.createdAt, '2026-10-20T04:41:38.296Z');
  assert.equal(state.updatedAt, '2026-10-30T10:38:23.343Z');
  // 毫秒字段原样回来（这是 core.js 演化运算的锚点，不许变成字符串）
  assert.equal(state.lastInteractAt, 1793355696670);
  assert.equal(state.lastProactiveAt, 0, '0 是「从没主动过」，不是 null');

  // 往返闭合：把读回来的再写一遍，主账内容不许变
  await brain.mood.saveState(state);
  const again = brain.mood.getState();
  assert.deepEqual(again, state, 'getState → saveState → getState 必须闭合');
});

test('appendEvent + listEvents：新→旧，同 at 也稳定', async (t) => {
  const { brain } = createBrain(t);
  const at1 = 1793355000000;
  const at2 = 1793355600000;
  const at3 = 1793356200000;

  const a = await brain.mood.appendEvent({ at: at1, kind: 'chat', note: '聊了几句', delta: { mood: 1.8, bond: 0.9 } });
  const b = await brain.mood.appendEvent({ at: at2, kind: 'praise', note: '被夸', delta: { mood: 7, energy: 3, bond: 2 } });
  const c = await brain.mood.appendEvent({ at: at3, kind: 'success', note: '办成了', delta: { mood: 8 } });
  assert.match(a.id, /^fev_[0-9a-f]{24}$/, 'id 由门面生成，不是自增序');
  assert.ok([a.id, b.id, c.id].every((id) => id.startsWith('fev_')));

  const listed = brain.mood.listEvents();
  assert.deepEqual(
    listed.items.map((item) => item.kind),
    ['success', 'praise', 'chat'],
    '必须新→旧（面板和注入都只关心最近的）',
  );
  assert.equal(listed.limit, 100, '缺省 limit 是 100');

  // 同一毫秒两条：不许因为排序不稳定而抖动
  const same1 = await brain.mood.appendEvent({ at: at3, kind: 'chat', note: '同一毫秒' });
  const same2 = await brain.mood.appendEvent({ at: at3, kind: 'praise', note: '同一毫秒另一条' });
  const twice = brain.mood.listEvents();
  const twiceAgain = brain.mood.listEvents();
  assert.deepEqual(
    twice.items.map((item) => item.id),
    twiceAgain.items.map((item) => item.id),
    '同一 at 的排序必须稳定（ORDER BY at DESC, id DESC）',
  );
  assert.ok(same1.id !== same2.id, '同 at 不同 kind 是两条事件');

  // 过滤：kind / since
  assert.equal(brain.mood.listEvents({ kind: 'chat' }).items.length, 2);
  assert.equal(brain.mood.listEvents({ since: at2 }).items.length, 4, 'since 是闭区间（>=）');
  // limit 夹在 1..500（limit=0 与全库其它门面一致：当「没传」处理，落默认 100）
  assert.equal(brain.mood.listEvents({ limit: 0 }).limit, 100, 'limit 0 与 list() 其它门面同口径：当没传');
  assert.equal(brain.mood.listEvents({ limit: 99_999 }).limit, 500, 'limit 上限 500');
});

test('pruneEvents：只留最近 N 条，返回删了几条', async (t) => {
  const { brain } = createBrain(t);
  const base = 1793300000000;
  for (let index = 0; index < 6; index += 1) {
    await brain.mood.appendEvent({ at: base + index * 1000, kind: 'chat', note: '第 ' + index + ' 条' });
  }
  assert.equal(countRows(brain.db, 'fox_events'), 6);

  const pruned = await brain.mood.pruneEvents({ keep: 2 });
  assert.deepEqual(pruned, { removed: 4, keep: 2 }, '删 4 条留 2 条');
  const left = brain.mood.listEvents();
  assert.deepEqual(
    left.items.map((item) => item.note),
    ['第 5 条', '第 4 条'],
    '留的必须是**最近**的，不是最早的',
  );

  // 再跑一次没有可删的：不许报负数 / 不许重复计数
  const again = await brain.mood.pruneEvents({ keep: 2 });
  assert.deepEqual(again, { removed: 0, keep: 2 });
});

test('delta JSON 往返：数值不丢，脏数据不炸查询', async (t) => {
  const { brain } = createBrain(t);
  const delta = { mood: 7.7, energy: 1, bond: 1.9 };
  await brain.mood.appendEvent({ at: 1793355000000, kind: 'success', note: '办成了', delta });
  const [item] = brain.mood.listEvents().items;
  assert.deepEqual(item.delta, delta, 'delta 必须原样往返（这是「为什么变了」的依据）');

  // 缺省 delta → 空对象，不是 null
  await brain.mood.appendEvent({ at: 1793355001000, kind: 'chat' });
  const second = brain.mood.listEvents().items[0];
  assert.deepEqual(second.delta, {});
  assert.equal(second.note, null, '没写 note 就是 null，不编空串');

  // 脏数据（白盒写进去的坏 JSON）不炸查询：当 {}
  brain.db
    .prepare(
      `INSERT INTO fox_events (id, at, kind, note, delta_json, source_system, created_at, created_at_local, deletion_epoch)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run('fev_broken', 1793355002000, 'praise', '坏行', '{不是 JSON', 'test', '2026-10-30T12:00:00.000Z', '2026-10-30T20:00:00.000+08:00');
  const listed = brain.mood.listEvents();
  assert.equal(listed.items.length, 3, '一条坏 JSON 不许让整次查询失败');
  const broken = listed.items.find((entry) => entry.id === 'fev_broken');
  assert.deepEqual(broken.delta, {}, '解析不了当空对象（宁可少一个增量，也不要 500）');
});

test('空库：getState / listEvents / stats / pruneEvents 全部不炸', async (t) => {
  const { brain } = createBrain(t);
  assert.equal(brain.mood.getState(), null);
  assert.deepEqual(brain.mood.listEvents(), { items: [], limit: 100 });
  assert.deepEqual(brain.mood.listEvents({ since: 1, kind: 'chat' }), { items: [], limit: 100 });
  assert.deepEqual(brain.mood.stats(), { events: 0, oldestAt: null, newestAt: null });
  assert.deepEqual(await brain.mood.pruneEvents(), { removed: 0, keep: 500 }, '空库 prune 是 0 条，不是报错');
});

test('非法输入：非有限数一律拒（NaN 不是「心情」）', async (t) => {
  const { brain } = createBrain(t);
  for (const field of ['mood', 'energy', 'bond']) {
    await assert.rejects(
      () => brain.mood.saveState({ ...STATE, [field]: Number.NaN }),
      (err) => {
        assert.equal(err.code, 'INVALID_ARGUMENT');
        assert.match(err.message, new RegExp(field));
        return true;
      },
      `${field}=NaN 必须拒`,
    );
  }
  await assert.rejects(
    () => brain.mood.saveState({ ...STATE, energy: Infinity }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.equal(countRows(brain.db, 'fox_state'), 0, '被拒的写入不许落库');

  // 越界夹取而不是拒（core.js 已 clamp，越界只可能是浮点边界，
  // 为它拒掉整条写入等于让状态卡在旧值上）
  await brain.mood.saveState({ ...STATE, mood: 120, energy: -5 });
  const clamped = brain.mood.getState();
  assert.equal(clamped.mood, 100);
  assert.equal(clamped.energy, 0);
});

test('appendEvent：note 截断 500 字，delta 非对象拒，kind 必填', async (t) => {
  const { brain } = createBrain(t);
  const longNote = '很'.repeat(600);
  await brain.mood.appendEvent({ at: 1793355000000, kind: 'chat', note: longNote });
  const [item] = brain.mood.listEvents().items;
  assert.equal(item.note.length, 500, 'note 截断到 500 字（与 brain_remember 正文上限一致）');
  assert.equal(item.note, longNote.slice(0, 500));

  await assert.rejects(
    () => brain.mood.appendEvent({ at: 1793355000000, kind: 'chat', delta: [1, 2] }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      return true;
    },
    'delta 必须是对象，数组要拒（存进去没人读得懂）',
  );
  await assert.rejects(
    () => brain.mood.appendEvent({ kind: 'chat' }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      return true;
    },
    'at 必填（事件没有发生时刻就没意义）',
  );
});

test('appendEvent 幂等：同一 (at, kind) 只留一条', async (t) => {
  const { brain } = createBrain(t);
  const at = 1793355000000;
  const first = await brain.mood.appendEvent({ at, kind: 'praise', note: '第一次' });
  assert.equal(first.created, true);
  const second = await brain.mood.appendEvent({ at, kind: 'praise', note: '重放一次' });
  assert.equal(second.created, false, '迁移脚本重跑 / 插件重放必须幂等');
  assert.equal(second.id, first.id, '幂等重放返回既有 id，不制造第二份');
  assert.equal(countRows(brain.db, 'fox_events'), 1);
  assert.equal(brain.mood.listEvents().items[0].note, '第一次', '幂等不许覆盖既有内容');

  // 同 at 不同 kind 是两条（幂等键是 (at, kind)，不是 at）
  const other = await brain.mood.appendEvent({ at, kind: 'success' });
  assert.equal(other.created, true);
  assert.equal(countRows(brain.db, 'fox_events'), 2);
});

test('单行约束在 schema 级（CHECK id = 1），不只是门面纪律', async (t) => {
  const { brain } = createBrain(t);
  await brain.mood.saveState(STATE);
  assert.throws(
    () =>
      brain.db
        .prepare(
          `INSERT INTO fox_state (id, version, mood, energy, bond, created_at, created_at_local, updated_at, updated_at_local, deletion_epoch)
           VALUES (2, 1, 50, 50, 50, '2026-10-30T00:00:00.000Z', '2026-10-30T08:00:00.000+08:00', '2026-10-30T00:00:00.000Z', '2026-10-30T08:00:00.000+08:00', 0)`,
        )
        .run(),
    /CHECK constraint failed/,
    '绕过门面直插第二行也必须被 schema 挡住（多行状态 = 「哪一个我」）',
  );
});

test('不做 scope 过滤：两张表没有 scope_id 列，传 scopeId 也不生效（CONTRACTS §19）', async (t) => {
  const { brain } = createBrain(t);
  assert.ok(!columnNames(brain.db, 'fox_state').includes('scope_id'), 'fox_state 不许有 scope_id');
  assert.ok(!columnNames(brain.db, 'fox_events').includes('scope_id'), 'fox_events 不许有 scope_id');

  // 传了也当没传：不同 scope 读到的必须是**同一行**（情感状态是「这一个我」的）
  await brain.mood.saveState({ ...STATE, mood: 70 });
  const state = brain.mood.getState();
  assert.equal(state.mood, 70);

  const a = brain.mood.listEvents({ limit: 10 });
  const b = brain.mood.listEvents({ limit: 10, scopeId: 'owner-other' });
  assert.deepEqual(a, b, '传 scopeId 不改变结果（范围参数在门面里根本不存在）');
});

test('不进检索：写事件不会往 memories 里塞任何东西', async (t) => {
  const { brain } = createBrain(t);
  await brain.mood.appendEvent({ at: 1793355000000, kind: 'success', note: '一天推完三件，验收全绿' });
  await brain.mood.saveState(STATE);
  assert.equal(countRows(brain.db, 'memories'), 0, '情感状态绝不写 memories（那会把检索稀释成垃圾）');

  // 反向也成立：三套检索索引里一条都没有（状态正文压根不进索引管线）
  assert.equal(countRows(brain.db, 'search_fts_char'), 0, '状态正文不进 search_fts_char');
  assert.equal(countRows(brain.db, 'search_fts_trigram'), 0, '状态正文不进 search_fts_trigram');
  assert.equal(countRows(brain.db, 'search_ngram'), 0, '状态正文不进 search_ngram');
});

test('stats：条数与最早/最新时刻', async (t) => {
  const { brain } = createBrain(t);
  await brain.mood.appendEvent({ at: 1793355000000, kind: 'chat' });
  await brain.mood.appendEvent({ at: 1793356200000, kind: 'success' });
  assert.deepEqual(brain.mood.stats(), {
    events: 2,
    oldestAt: 1793355000000,
    newestAt: 1793356200000,
  });
});
