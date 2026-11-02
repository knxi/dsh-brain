// @ts-check
/**
 * 检索不足时的如实降级（M2 门槛「检索不足不胡答」的构包侧落地，CONTRACTS §7）。
 *
 * 纪律：
 * - `diagnostics.status !== 'ok'` → 返回空段 + 说明原因，**不拿相似当相关硬凑**；
 * - 即使检索层给了命中，状态不是 ok 时一律不采用，但逐条记账（让检查器看见「有命中但我没用」）；
 * - 四种「检索不足」必须可区分：no_related / insufficient_evidence / source_missing / source_conflict；
 * - search 抛错不许被包装成「没找到」——异常照抛，由上层决定重试还是弃答。
 */

import test from 'node:test';
import { assert, buildOnce, makeHit, makeSearchResult, mockStore } from './helpers.mjs';
import { build } from '../../../packages/context/src/index.js';

const DEGRADE_CASES = [
  ['no_related', '没有相关记忆'],
  ['insufficient_evidence', '证据不足'],
  ['source_missing', '来源'],
  ['source_conflict', '冲突'],
];

test('四种检索不足：空段 + 空注入文本 + 说明原因，绝不硬凑', async () => {
  for (const [status, keyword] of DEGRADE_CASES) {
    // 故意给一条完整命中：降级时也不许用
    const store = mockStore(makeSearchResult({ hits: [makeHit({ memoryId: 'mem_a' })], status }));
    const pkg = await buildOnce({ store });

    assert.equal(pkg.diagnostics.status, status, `诊断状态必须原样保留 ${status}`);
    assert.deepEqual(pkg.segments, [], `${status} 不许有段`);
    assert.equal(pkg.injectedText, '', `${status} 不许注入文本`);
    assert.equal(pkg.estimatedTokens, 0);
    assert.equal(pkg.budget.used, 0);
    assert.equal(pkg.status, 'built', '降级包也是一个 built 包（可查、可审计，只是没内容）');
    assert.ok(
      pkg.diagnostics.reasons.some((reason) => reason.includes(status) && reason.includes(keyword)),
      `${status} 的诊断理由要说清楚：${JSON.stringify(pkg.diagnostics.reasons)}`,
    );
    // 有命中但不采用 → 必须有账
    assert.equal(pkg.budget.dropped.length, 1);
    assert.equal(pkg.budget.dropped[0].memoryId, 'mem_a');
    assert.equal(pkg.budget.dropped[0].reason, 'search_degraded');
  }
});

test('降级时不调用的检索也没白花：no_related 且零命中也一样如实上报', async () => {
  const store = mockStore(makeSearchResult({ hits: [], status: 'no_related' }));
  const pkg = await buildOnce({ store });
  assert.equal(pkg.diagnostics.status, 'no_related');
  assert.deepEqual(pkg.budget.dropped, []);
  assert.deepEqual(pkg.segments, []);
});

test('检索层降级（fts_unavailable）要透传进诊断理由', async () => {
  const store = mockStore(
    makeSearchResult({ hits: [makeHit()], degraded: 'fts_unavailable', notes: ['FTS5 不可用，改用 LIKE 兜底'] }),
  );
  const pkg = await buildOnce({ store });
  assert.equal(pkg.diagnostics.status, 'ok');
  assert.ok(pkg.diagnostics.reasons.some((reason) => reason.includes('fts_unavailable')));
  assert.ok(pkg.diagnostics.reasons.some((reason) => reason.includes('FTS5 不可用')));
});

test('状态 ok 但命中全部缺来源 → 如实升为 source_missing，不假装 ok', async () => {
  const store = mockStore(
    makeSearchResult({ hits: [makeHit({ memoryId: 'mem_x', sourceRefs: [] })] }),
  );
  const pkg = await buildOnce({ store });
  assert.equal(pkg.diagnostics.status, 'source_missing');
  assert.deepEqual(pkg.segments, []);
  assert.equal(pkg.injectedText, '');
  assert.equal(pkg.budget.dropped[0].reason, 'missing_source');
});

test('状态 ok 但命中没有合法版本 → 升为 insufficient_evidence，不注入', async () => {
  const store = mockStore(makeSearchResult({ hits: [makeHit({ memoryId: 'mem_y', version: 0 })] }));
  const pkg = await buildOnce({ store });
  assert.equal(pkg.diagnostics.status, 'insufficient_evidence');
  assert.deepEqual(pkg.segments, []);
  assert.equal(pkg.budget.dropped[0].reason, 'missing_version');
});

test('部分命中缺来源：只丢那些，其余照常注入，账目分开记', async () => {
  const store = mockStore(
    makeSearchResult({
      hits: [
        makeHit({ memoryId: 'mem_ok', score: 0.9 }),
        makeHit({ memoryId: 'mem_nosrc', score: 0.8, sourceRefs: [] }),
        makeHit({ memoryId: 'mem_nover', score: 0.7, version: null }),
      ],
    }),
  );
  const pkg = await buildOnce({ store });
  assert.equal(pkg.diagnostics.status, 'ok');
  assert.deepEqual(pkg.segments.map((seg) => seg.memoryId), ['mem_ok']);
  const reasons = pkg.budget.dropped.map((entry) => `${entry.memoryId}:${entry.reason}`).sort();
  assert.deepEqual(reasons, ['mem_nosrc:missing_source', 'mem_nover:missing_version']);
  assert.ok(pkg.diagnostics.reasons.some((reason) => reason.includes('未注入')));
});

test('空摘要命中：记账为 empty_summary，不注入空气', async () => {
  const store = mockStore(makeSearchResult({ hits: [makeHit({ memoryId: 'mem_empty', summary: '   ' })] }));
  const pkg = await buildOnce({ store });
  assert.deepEqual(pkg.segments, []);
  assert.equal(pkg.budget.dropped[0].reason, 'empty_summary');
  assert.equal(pkg.diagnostics.status, 'insufficient_evidence');
});

test('检索抛错：包装成 BrainError 抛出，不伪装成「没找到」', async () => {
  const store = mockStore(() => {
    throw new Error('SQLITE 磁盘满');
  });
  await assert.rejects(
    () => buildOnce({ store }),
    (/** @type {any} */ err) => {
      assert.equal(err.code, 'STORAGE_ERROR');
      assert.ok(err.cause instanceof Error, '保留原始错误作为 cause');
      assert.ok(!('persisted' in err));
      return true;
    },
  );
});

test('检索返回畸形值：一律按证据不足处理，不静默当成有证据', async () => {
  const missing = await buildOnce({ store: mockStore(() => undefined) });
  assert.equal(missing.diagnostics.status, 'insufficient_evidence');
  assert.deepEqual(missing.segments, []);
  assert.ok(missing.diagnostics.reasons.some((reason) => reason.includes('不是对象')));

  const noStatus = await buildOnce({ store: mockStore({ hits: [makeHit()], diagnostics: {} }) });
  assert.equal(noStatus.diagnostics.status, 'insufficient_evidence');
  assert.ok(noStatus.diagnostics.reasons.some((reason) => reason.includes('缺失')));

  const unknownStatus = await buildOnce({
    store: mockStore({ hits: [makeHit()], diagnostics: { status: 'weird_new_status', notes: [] } }),
  });
  assert.equal(unknownStatus.diagnostics.status, 'insufficient_evidence');
  assert.ok(unknownStatus.diagnostics.reasons.some((reason) => reason.includes('不可识别')));
  assert.deepEqual(unknownStatus.segments, []);
});

test('hits 里混进非对象垃圾：记 invalid_hit，不影响脏数据之外的正常段', async () => {
  const store = mockStore(
    makeSearchResult({
      hits: [null, 'oops', { memoryId: 'mem_ok', ...makeHit({ memoryId: 'mem_ok' }) }, 42],
    }),
  );
  const pkg = await buildOnce({ store });
  assert.deepEqual(pkg.segments.map((seg) => seg.memoryId), ['mem_ok']);
  const invalid = pkg.budget.dropped.filter((entry) => entry.reason === 'invalid_hit');
  assert.equal(invalid.length, 3);
});
