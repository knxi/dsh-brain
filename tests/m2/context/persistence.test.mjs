// @ts-check
/**
 * 旁路落库：`context_packages`（检查器唯一能查到「这次为什么只注入这些」的地方）。
 *
 * 三条硬约束（Lead 定的）：
 * 1. **可选依赖**：store 没有 `contextPackages` 门面就跳过，绝不硬绑。
 * 2. **失败不失败构包**：落库抛错只记 `diagnostics.persistence`，包照常返回、内容不变。
 * 3. **幂等**：同一 `contextId` 重放不重复插（contextId 本身就是确定性派生的）。
 */

import test from 'node:test';
import {
  ROOMY_BUDGET,
  assert,
  buildOnce,
  makeHit,
  makeSearchResult,
  manyHits,
  mockContextPackages,
  mockStore,
} from './helpers.mjs';
import {
  BRAIN_BUDGET_FORMULA,
  build,
  verifyCanonicalHash,
} from '../../../packages/context/src/index.js';

test('store 没有 contextPackages 门面：build 正常，旁路记为 skipped', async () => {
  const store = mockStore(makeSearchResult({ hits: [makeHit()] }));
  const pkg = await buildOnce({ store });

  assert.equal(pkg.status, 'built');
  assert.equal(pkg.segments.length, 1);
  assert.equal(verifyCanonicalHash(pkg), true);
  assert.deepEqual(pkg.diagnostics.persistence, {
    status: 'skipped',
    reason: 'no_context_packages_facade',
    contextId: pkg.contextId,
  });
  // 跳过落库不该污染诊断
  assert.ok(!pkg.diagnostics.reasons.some((reason) => reason.includes('落库')));
});

test('有门面：把包完整落库（budget.dropped 一并写进去），status=persisted', async () => {
  // 12 段挤 2048 预算 → 必然产生 dropped 账目，正好验证「检查器能看见为什么没注入」
  const { facade, calls } = mockContextPackages();
  const store = mockStore(makeSearchResult({ hits: manyHits(12, 60) }), facade);
  const pkg = await buildOnce({ store });

  assert.equal(pkg.diagnostics.persistence.status, 'persisted');
  assert.equal(pkg.diagnostics.persistence.reason, null);
  assert.equal(calls.save.length, 1, '一次 build 只落库一次');
  assert.equal(calls.get.length, 1, '有 get 就先查一次幂等');

  /** @type {any} */
  const saved = calls.save[0];
  assert.equal(saved.contextId, pkg.contextId);
  assert.equal(saved.status, 'built');
  assert.equal(saved.canonicalHash, pkg.canonicalHash);
  // 核心目的：预算账完整落库
  assert.equal(saved.budget.formula, BRAIN_BUDGET_FORMULA);
  assert.equal(saved.budget.brainAllowance, pkg.budget.brainAllowance);
  assert.equal(saved.budget.used, pkg.budget.used);
  assert.ok(saved.budget.dropped.length > 0, 'dropped[] 必须落库');
  assert.deepEqual(saved.budget.dropped, pkg.budget.dropped);
  for (const entry of saved.budget.dropped) {
    assert.equal(typeof entry.memoryId, 'string');
    assert.equal(typeof entry.reason, 'string');
    assert.ok(entry.detail.length > 0, '每段丢弃理由都要落库');
  }
  assert.deepEqual(saved.segments, pkg.segments);
  // 落库发生在填 persistence 之前：存进去的包不该带旁路自己的结果（避免自引用）
  assert.equal(saved.diagnostics.persistence, undefined);
});

test('有门面但 save 抛错：构包照常成功，旁路失败如实入 diagnostics，包内容不变', async () => {
  const failure = new Error('SQLITE_BUSY: database is locked');
  const { facade } = mockContextPackages({ fail: failure });
  const store = mockStore(makeSearchResult({ hits: [makeHit()] }), facade);
  const pkg = await buildOnce({ store });

  // 包本身完全正常——落库是旁路，不是构包的前置条件
  assert.equal(pkg.status, 'built');
  assert.equal(pkg.segments.length, 1);
  assert.ok(pkg.injectedText.length > 0);
  assert.equal(verifyCanonicalHash(pkg), true);
  assert.ok(pkg.estimatedTokens > 0);
  // 旁路失败可见、可查
  assert.equal(pkg.diagnostics.persistence.status, 'failed');
  assert.match(String(pkg.diagnostics.persistence.reason), /SQLITE_BUSY/);
  assert.ok(pkg.diagnostics.reasons.some((reason) => reason.includes('旁路落库失败') && reason.includes('不影响')));
  // 诊断状态仍是检索诊断，不被落库篡改
  assert.equal(pkg.diagnostics.status, 'ok');

  // 关键：落库失败不改变包内容 → 与「没有门面」时同输入同哈希
  const withoutFacade = await buildOnce({ store: mockStore(makeSearchResult({ hits: [makeHit()] })) });
  assert.equal(pkg.canonicalHash, withoutFacade.canonicalHash);
  assert.equal(pkg.injectedText, withoutFacade.injectedText);
  assert.deepEqual(pkg.segments, withoutFacade.segments);
});

test('幂等：同一 contextId 已落过 → 不再 save（不依赖门面的 upsert）', async () => {
  const { facade, calls } = mockContextPackages({ existing: { contextId: 'already-there' } });
  const store = mockStore(makeSearchResult({ hits: [makeHit()] }), facade);

  const first = await buildOnce({ store });
  assert.equal(first.diagnostics.persistence.status, 'skipped');
  assert.equal(first.diagnostics.persistence.reason, 'already_persisted');
  assert.equal(calls.save.length, 0, '已存在就不该再写');

  // 同一个 step 重放：contextId 确定性派生，仍然跳过
  const replay = await buildOnce({ store });
  assert.equal(replay.contextId, first.contextId);
  assert.equal(replay.diagnostics.persistence.reason, 'already_persisted');
  assert.equal(calls.save.length, 0);
  assert.equal(calls.get.length, 2);
});

test('只有 save 没有 get：照样落库（不猜门面必须有什么）', async () => {
  const { facade, calls } = mockContextPackages({ withGet: false });
  const store = mockStore(makeSearchResult({ hits: [makeHit()] }), facade);
  const pkg = await buildOnce({ store });

  assert.equal(pkg.diagnostics.persistence.status, 'persisted');
  assert.equal(calls.save.length, 1);
  // 没有 get 就不该假装查过
  assert.equal(Object.prototype.hasOwnProperty.call(facade, 'get'), false);
});

test('门面形状不对：一律 skipped，不抛错、不猜', async () => {
  const notCallable = await buildOnce({
    store: mockStore(makeSearchResult({ hits: [makeHit()] }), { save: 'not-a-function' }),
  });
  assert.equal(notCallable.diagnostics.persistence.status, 'skipped');
  assert.equal(notCallable.diagnostics.persistence.reason, 'context_packages_save_not_callable');
  assert.equal(notCallable.segments.length, 1);

  const notObject = await buildOnce({
    store: mockStore(makeSearchResult({ hits: [makeHit()] }), 'oops'),
  });
  assert.equal(notObject.diagnostics.persistence.reason, 'no_context_packages_facade');
  assert.equal(notObject.status, 'built');

  // null 也算没有门面
  const nullFacade = await buildOnce({
    store: mockStore(makeSearchResult({ hits: [makeHit()] }), null),
  });
  assert.equal(nullFacade.diagnostics.persistence.status, 'skipped');
});

test('落库失败不影响 markAttached / markSent（三级证据链照常走）', async () => {
  const { markAttached, markSent } = await import('../../../packages/context/src/index.js');
  const { facade } = mockContextPackages({ fail: new Error('disk full') });
  const store = mockStore(makeSearchResult({ hits: [makeHit()] }), facade);
  const pkg = await buildOnce({ store });

  const attached = markAttached(pkg, { carrier: 'messages[role=system]', turn: 'turn-1', step: 'step-1' });
  const sent = markSent(attached, { carrier: 'messages[role=system]' });
  assert.equal(pkg.status, 'built');
  assert.equal(attached.status, 'attached');
  assert.equal(sent.status, 'sent');
  // 旁路失败的结果跟着包一路带下去，检查器仍然看得到
  assert.equal(sent.diagnostics.persistence.status, 'failed');
});

test('落库走的是同一个包实例语义：空包（降级）也落库，且 dropped 里能看到弃答理由', async () => {
  const { facade, calls } = mockContextPackages();
  const store = mockStore(makeSearchResult({ hits: [makeHit()], status: 'source_missing' }), facade);
  const pkg = await buildOnce({ store });

  assert.equal(pkg.diagnostics.status, 'source_missing');
  assert.deepEqual(pkg.segments, []);
  assert.equal(pkg.injectedText, '');
  assert.equal(pkg.diagnostics.persistence.status, 'persisted');
  /** @type {any} */
  const saved = calls.save[0];
  assert.equal(saved.budget.dropped[0].reason, 'search_degraded', '弃答也要落账，供检查器展示');
  assert.equal(saved.budget.used, 0);
});
