// @ts-check
/**
 * M2 `asOf` 时点回看：要能回答「当时那个参数是什么」。
 *
 * 硬要求（任务重点 3）：`validFrom` / `validUntil` 必须在 **SQL 层**过滤，
 * 不是查回来再在 JS 里筛。这里用三件事证明它真的在链路里：
 *  1. 半开区间语义 `[validFrom, validUntil)`：左边界含、右边界不含；
 *  2. 不在有效期内的候选会被链路丢掉并在 notes 里报出来（不是返回后才筛）；
 *  3. supersede 之后，当前检索给新值、`asOf` 给旧值。
 */

import test from 'node:test';
import { assert, SCOPE_A, createBrain, draft } from './helpers.mjs';

const T = (h, m = 0) => `2026-10-28T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

test('有效期半开区间：左边界含、右边界不含', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({
      content: '名片厚度 300g，有效期 10:00 到 12:00',
      sourceIds: ['evt-window-1'],
      validFrom: T(10),
      validUntil: T(12),
    }),
  );

  // 区间内
  assert.ok(brain.memories.get(created.id, { asOf: T(11) }), '区间内必须回看到');
  // 左边界：validFrom 当刻有效（>=）
  assert.ok(brain.memories.get(created.id, { asOf: T(10) }), 'asOf 恰好等于 validFrom 时应有效');
  // 右边界：validUntil 当刻已失效（<）
  assert.equal(brain.memories.get(created.id, { asOf: T(12) }), null, 'asOf 恰好等于 validUntil 时应已失效');
  // 区间外
  assert.equal(brain.memories.get(created.id, { asOf: T(9) }), null);
  assert.equal(brain.memories.get(created.id, { asOf: T(13) }), null);
  // 不传 asOf 是「当前」，只按状态过滤，不按有效期过滤（get 的历史语义交给 asOf）
  assert.ok(brain.memories.get(created.id));
});

test('检索侧同样按有效期过滤，并在 notes 里报出被有效期筛掉的条数', async (t) => {
  const { brain } = createBrain(t);
  await brain.memories.create(
    draft({
      content: '喷绘布 1.2m 宽，有效期只到 11:00',
      sourceIds: ['evt-window-2'],
      validFrom: T(9),
      validUntil: T(11),
    }),
  );

  // 当前时刻（固定时钟 10:00） → 有效
  const now = brain.memories.search({ query: '喷绘布', scopeId: SCOPE_A });
  assert.equal(now.hits.length, 1);
  assert.equal(now.diagnostics.status, 'ok');

  // 12:00 回看 → 已过有效期，命中为空，且 notes 必须说明是有效期原因
  const later = brain.memories.search({ query: '喷绘布', scopeId: SCOPE_A, asOf: T(12) });
  assert.equal(later.hits.length, 0);
  assert.equal(later.diagnostics.status, 'no_related');
  assert.ok(
    later.diagnostics.notes.some((note) => note.includes('有效期')),
    `notes 应说明是有效期过滤导致，实际：${JSON.stringify(later.diagnostics.notes)}`,
  );

  // 8:30 回看 → 当时还没生效（validFrom 是 09:00）
  const before = brain.memories.search({ query: '喷绘布', scopeId: SCOPE_A, asOf: T(8, 30) });
  assert.equal(before.hits.length, 0);
});

test('supersede 后：当前给新值，asOf 回看到旧值（当时那个参数是什么）', async (t) => {
  const { brain, fc } = createBrain(t);
  const oldOne = await brain.memories.create(
    draft({ content: '铜版纸名片厚度 300g', summary: '名片 300g', sourceIds: ['evt-v1'], validFrom: T(9) }),
  );
  const newOne = await brain.memories.create(
    draft({ content: '铜版纸名片厚度改成 250g', summary: '名片 250g', sourceIds: ['evt-v2'], validFrom: T(13) }),
  );
  // 让 supersede 发生在 10:05，这样 10:00 那一刻旧值仍然有效（半开区间 [.. , 10:05)）
  fc.advance(5 * 60_000);
  await brain.memories.supersede(oldOne.id, newOne.id);

  // 10:00（旧值当时有效、新值还没到 validFrom）→ 只能看到旧值
  const atTen = brain.memories.search({ query: '铜版纸名片厚度', scopeId: SCOPE_A, asOf: T(10), minCoverage: 0.2 });
  assert.deepEqual(atTen.hits.map((h) => h.memoryId), [oldOne.id], '10:00 回看必须给旧值');

  // 14:00（新值已生效、旧值已被 supersede 封口在 10:05）→ 只能看到新值
  const atFourteen = brain.memories.search({ query: '铜版纸名片厚度', scopeId: SCOPE_A, asOf: T(14), minCoverage: 0.2 });
  assert.deepEqual(atFourteen.hits.map((h) => h.memoryId), [newOne.id], '14:00 回看必须给新值');

  // 旧值在 14:00 连 get 都回看不到
  assert.equal(brain.memories.get(oldOne.id, { asOf: T(14) }), null);
  // 但在 10:00 能
  assert.ok(brain.memories.get(oldOne.id, { asOf: T(10) }));
});

test('asOf 允许回看 superseded / expired 状态（历史不是「当前」）', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({ content: '旧报价 0.45 元一张', sourceIds: ['evt-old-price'] }),
  );
  await brain.memories.update(
    created.id,
    { status: 'expired', validUntil: T(12) },
    { expectedVersion: 1 },
  );

  // 当前检索：expired 不返回
  assert.equal(brain.memories.search({ query: '旧报价', scopeId: SCOPE_A }).hits.length, 0);
  // asOf 回看 11:00：当时还有效 → 返回
  const atEleven = brain.memories.search({ query: '旧报价', scopeId: SCOPE_A, asOf: T(11) });
  assert.equal(atEleven.hits.length, 1);
  // includeExpired 能让当前检索带上 expired，但不受 asOf 影响
  const withExpired = brain.memories.search({ query: '旧报价', scopeId: SCOPE_A, includeExpired: true });
  assert.equal(withExpired.hits.length, 1);
});

test('asOf 接受带时区偏移的输入：8 点 +08:00 等于 0 点 UTC', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(
    draft({
      content: '材料表 2026-10-28 上午有效',
      sourceIds: ['evt-tz'],
      validFrom: '2026-10-28T08:00:00.000+08:00', // = 00:00Z
      validUntil: '2026-10-28T12:00:00.000+08:00', // = 04:00Z
    }),
  );
  // 02:00Z 落在 [00:00Z, 04:00Z) 内
  assert.ok(brain.memories.get(created.id, { asOf: '2026-10-28T02:00:00.000Z' }), '不同偏移必须规范化后比较');
  // 05:00Z 已过
  assert.equal(brain.memories.get(created.id, { asOf: '2026-10-28T05:00:00.000Z' }), null);
  // 存储侧也统一成 UTC
  const memory = brain.memories.get(created.id);
  assert.equal(memory.validFrom, '2026-10-28T00:00:00.000Z');
  assert.equal(memory.validUntil, '2026-10-28T04:00:00.000Z');
});

test('非法 asOf 直接报可理解错误，不静默当成「当前」', async (t) => {
  const { brain } = createBrain(t);
  const created = await brain.memories.create(draft({ content: '随便一条', sourceIds: ['evt-x'] }));
  assert.throws(
    () => brain.memories.get(created.id, { asOf: '不是时间' }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /asOf/);
      return true;
    },
  );
  assert.throws(
    () => brain.memories.search({ query: '随便', scopeId: SCOPE_A, asOf: '2026-13-45' }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      return true;
    },
  );
});

test('validUntil 早于 validFrom 的窗口写入后不会命中任何时刻', async (t) => {
  const { brain } = createBrain(t);
  // 门面不做区间合法性拒绝（expressly 允许建时间窗口），但检索侧必须是空
  const created = await brain.memories.create(
    draft({ content: '倒挂窗口 螺丝钉', sourceIds: ['evt-bad'], validFrom: T(14), validUntil: T(10) }),
  );
  for (const at of [T(9), T(10), T(12), T(14), T(16)]) {
    assert.equal(brain.memories.get(created.id, { asOf: at }), null, `倒挂窗口在 ${at} 不该有效`);
  }
  assert.equal(brain.memories.search({ query: '倒挂窗口', scopeId: SCOPE_A, asOf: T(12) }).hits.length, 0);
});
