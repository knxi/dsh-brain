// @ts-check
/**
 * 构包主流程：结构、注入文本来源标记、预算账、幂等、不改输入。
 *
 * 「必有来源、必有版本、必有预算说明」是 M2 门槛，这三条在这里逐条断言。
 */

import test from 'node:test';
import {
  assert,
  IDENTITY,
  ROOMY_BUDGET,
  FIXED_NOW,
  buildOnce,
  makeHit,
  makeSearchResult,
  manyHits,
  mockStore,
} from './helpers.mjs';
import {
  ESTIMATE_TOKENIZER_ID,
  INJECTION_BEGIN,
  INJECTION_END,
  INJECTION_ORIGIN_SYSTEM,
  INJECTION_PRODUCER,
  build,
  estimateTokens,
  verifyCanonicalHash,
} from '../../../packages/context/src/index.js';

test('build 返回结构：字段齐全，出生状态 built', async () => {
  const store = mockStore(
    makeSearchResult({
      hits: [
        makeHit({ memoryId: 'mem_a', score: 0.9 }),
        makeHit({ memoryId: 'mem_b', score: 0.5 }),
      ],
    }),
  );
  const pkg = await buildOnce({ store });

  // 身份与位置
  assert.ok(typeof pkg.contextId === 'string' && pkg.contextId.startsWith('ctx_'), 'contextId 形状');
  assert.equal(pkg.builtAt, FIXED_NOW);
  assert.equal(pkg.policyVersion, 'm2.0');
  assert.equal(pkg.scopeId, 'owner-default');
  assert.equal(pkg.personId, 'owner');
  assert.equal(pkg.sessionId, 'sess-m2-1');
  assert.equal(pkg.turnId, 'turn-1');
  assert.equal(pkg.stepId, 'step-1');

  // 段：按相关性降序
  assert.equal(pkg.segments.length, 2);
  assert.deepEqual(
    pkg.segments.map((seg) => seg.memoryId),
    ['mem_a', 'mem_b'],
  );
  for (const seg of pkg.segments) {
    assert.equal(typeof seg.memoryId, 'string');
    assert.ok(seg.version > 0, '必有版本');
    assert.ok(Array.isArray(seg.sourceRefs) && seg.sourceRefs.length > 0, '必有来源');
    assert.ok(seg.sourceRefs.every((ref) => typeof ref.id === 'string' && ref.id.length > 0));
    assert.equal(typeof seg.summary, 'string');
    assert.equal(typeof seg.layer, 'string');
    assert.equal(typeof seg.type, 'string');
    assert.equal(typeof seg.evidenceKind, 'string');
    assert.equal(typeof seg.contentHash, 'string');
  }

  // 预算说明三件套
  assert.equal(typeof pkg.estimatedTokens, 'number');
  assert.equal(pkg.tokenizerId, ESTIMATE_TOKENIZER_ID);
  assert.match(pkg.tokenizerId, /^estimate:/, 'tokenizer 拿不到就明说是估算，不假装精确');
  assert.ok(pkg.budget.used > 0);
  assert.ok(pkg.budget.used <= pkg.budget.brainAllowance, 'used 不许超预算');
  assert.ok(pkg.estimatedTokens <= pkg.budget.brainAllowance, '估算 Token 也不许超预算');
  assert.equal(pkg.budget.brainAllowance, 2048);
  assert.deepEqual(pkg.budget.dropped, []);
  assert.equal(pkg.budget.estimated, false);
  assert.equal(pkg.budget.hostInputSource, 'provided');

  // 三级证据起点
  assert.equal(pkg.status, 'built');
  assert.equal(pkg.evidence.attached, null);
  assert.equal(pkg.evidence.sent, null);
  assert.equal(pkg.carrier, null);

  assert.equal(pkg.diagnostics.status, 'ok');
  assert.deepEqual(pkg.diagnostics.reasons, []);
  // mock 没给 primaryLaneHit → 证据强度如实记 unknown，不假装主路命中
  assert.equal(pkg.diagnostics.evidenceStrength, 'unknown');
  assert.equal(pkg.diagnostics.segmentedFallback, false);
  assert.equal(verifyCanonicalHash(pkg), true);
});

test('证据强度：主路命中标 primary；主路 0 命中标 ngram_fallback 但不自动降级', async () => {
  const primary = await buildOnce({
    store: mockStore(makeSearchResult({ hits: [makeHit()], primaryLaneHit: true })),
  });
  assert.equal(primary.diagnostics.evidenceStrength, 'primary');
  assert.equal(primary.diagnostics.status, 'ok');
  assert.ok(
    !primary.diagnostics.reasons.some((reason) => reason.includes('ngram_fallback')),
    '主路命中不该有弱证据提示',
  );

  // 弱证据：照常注入（裁判权在检索层），但必须如实标注，检查器能分开显示
  const weak = await buildOnce({
    store: mockStore(makeSearchResult({ hits: [makeHit()], primaryLaneHit: false })),
  });
  assert.equal(weak.diagnostics.evidenceStrength, 'ngram_fallback');
  assert.equal(weak.diagnostics.status, 'ok');
  assert.equal(weak.segments.length, 1, '弱证据不等于检索不足，段照常注入');
  assert.ok(weak.diagnostics.reasons.some((reason) => reason.includes('ngram_fallback') && reason.includes('弱证据')));

  // 多段补偿：检索层分段召回过 → 如实透传
  const segmented = await buildOnce({
    store: mockStore(makeSearchResult({ hits: [makeHit()], primaryLaneHit: true, segmented: true })),
  });
  assert.equal(segmented.diagnostics.segmentedFallback, true);
  assert.ok(
    segmented.diagnostics.reasons.some((reason) => reason.includes('检索补偿') && reason.includes('段间')),
    `分段补偿要留痕：${JSON.stringify(segmented.diagnostics.reasons)}`,
  );
});

test('注入文本：带可识别来源标记，每段带来源与版本（CONTRACTS 10.6）', async () => {
  const store = mockStore(makeSearchResult({ hits: [makeHit({ memoryId: 'mem_a', version: 7 })] }));
  const pkg = await buildOnce({ store });

  assert.ok(pkg.injectedText.startsWith(INJECTION_BEGIN), '注入块带起始标记');
  assert.ok(pkg.injectedText.trimEnd().endsWith(INJECTION_END), '注入块带结束标记');
  assert.ok(pkg.injectedText.includes(`origin_system=${INJECTION_ORIGIN_SYSTEM}`), '带 origin_system');
  assert.ok(pkg.injectedText.includes(`producer=${INJECTION_PRODUCER}`), '带 producer');
  assert.ok(pkg.injectedText.includes(`canonical_hash=${pkg.canonicalHash}`), '带自身摘要（sent 判据要用）');
  assert.ok(pkg.injectedText.includes('不是用户的新发言'), '明确告诉模型这不是用户新发言');

  // 每段：memoryId + 版本 + 证据类型 + 来源 id
  assert.ok(pkg.injectedText.includes('mem_a'));
  assert.ok(pkg.injectedText.includes('|v7]'));
  assert.ok(pkg.injectedText.includes('owner_words'));
  assert.ok(pkg.injectedText.includes('sources=src_mem_a'));
});

test('空 query：不调用检索，按「没有相关记忆」如实降级', async () => {
  const store = mockStore(makeSearchResult({}));
  const pkg = await buildOnce({ store, query: '   ' });
  assert.equal(store.calls.length, 0, '空查询不该浪费一次检索');
  assert.equal(pkg.diagnostics.status, 'no_related');
  assert.deepEqual(pkg.segments, []);
  assert.equal(pkg.injectedText, '');
  assert.equal(pkg.estimatedTokens, 0);
  assert.equal(pkg.budget.used, 0);
  assert.ok(pkg.diagnostics.reasons.some((reason) => reason.includes('query_empty')));
});

test('检索调用参数：query / scopeId / personId / limit 逐项传对', async () => {
  const store = mockStore(makeSearchResult({}));
  await buildOnce({ store, query: '建施-03 图号' });
  assert.deepEqual(store.calls[0], {
    query: '建施-03 图号',
    scopeId: IDENTITY.scopeId,
    personId: IDENTITY.personId,
    limit: 10,
  });
});

test('幂等（CONTRACTS 10.1）：同一 step 重放 → 同 contextId、同 canonicalHash、同样的段', async () => {
  const store = mockStore(makeSearchResult({ hits: [makeHit({ memoryId: 'mem_a' })] }));
  const first = await buildOnce({ store });
  const second = await buildOnce({ store });
  assert.equal(second.contextId, first.contextId);
  assert.equal(second.canonicalHash, first.canonicalHash);
  assert.deepEqual(second.segments, first.segments);
  assert.equal(second.injectedText, first.injectedText);
  // 换 step 就是另一个位置，不该复用 contextId
  const otherStep = await buildOnce({ store, stepId: 'step-2' });
  assert.notEqual(otherStep.contextId, first.contextId);
});

test('不改输入：mock 返回值（含 hits 数组）在构建后原样不动', async () => {
  const hit = makeHit({ memoryId: 'mem_a' });
  const searchResult = makeSearchResult({ hits: [hit] });
  const before = JSON.stringify(searchResult);
  const store = mockStore(searchResult);
  const pkg = await buildOnce({ store });
  assert.equal(JSON.stringify(searchResult), before, '构包不许原地改检索结果');
  // 段的来源引用也是新对象，不与检索结果共享引用
  assert.notEqual(pkg.segments[0].sourceRefs[0], hit.sourceRefs[0]);
});

test('预算随参数变化：窗口不足时 brainAllowance=0，段全部记账不注入', async () => {
  const store = mockStore(makeSearchResult({ hits: [makeHit()] }));
  const pkg = await buildOnce({
    store,
    budget: { modelWindow: 4000, hostInputTokens: 3000, outputReserve: 512 },
  });
  assert.equal(pkg.budget.brainAllowance, 0);
  assert.deepEqual(pkg.segments, []);
  assert.equal(pkg.injectedText, '');
  assert.equal(pkg.budget.used, 0);
  assert.equal(pkg.budget.dropped.length, 1);
  assert.equal(pkg.budget.dropped[0].reason, 'budget_zero');
  assert.equal(pkg.budget.dropped[0].memoryId, 'mem_a');
  assert.ok(pkg.diagnostics.reasons.some((reason) => reason.includes('预算为 0')));
  // 诊断状态仍是 ok：这是预算不足，不是检索不足，不许混淆
  assert.equal(pkg.diagnostics.status, 'ok');
});

test('超限裁剪：按相关性从最低端裁，每段为什么被丢都有账', async () => {
  const hits = manyHits(12, 60);
  const store = mockStore(makeSearchResult({ hits }));
  const pkg = await buildOnce({ store });

  assert.equal(pkg.budget.brainAllowance, 2048);
  assert.ok(pkg.segments.length > 0, '至少得留下一段');
  assert.ok(pkg.segments.length < hits.length, '预算装不下全部 12 段');

  const droppedCount = hits.length - pkg.segments.length;
  assert.equal(pkg.budget.dropped.length, droppedCount, '被丢的段数必须和账目条数一致');
  for (const entry of pkg.budget.dropped) {
    assert.equal(entry.reason, 'over_budget_low_relevance');
    assert.equal(typeof entry.detail, 'string');
    assert.ok(entry.detail.length > 0, '每段都要给丢弃理由');
    assert.equal(typeof entry.score, 'number');
    assert.equal(typeof entry.segmentTokens, 'number');
  }

  // 保留的是分数最高的前 N 段；被丢段的分数都 <= 保留段的最低分
  const kept = pkg.segments;
  const keptIds = kept.map((seg) => seg.memoryId);
  assert.deepEqual(keptIds, hits.slice(0, kept.length).map((hit) => hit.memoryId));
  const keptLowestScore = kept[kept.length - 1].score;
  for (const entry of pkg.budget.dropped) {
    assert.ok(entry.score <= keptLowestScore, `被丢段 ${entry.memoryId} 的分数不该高于保留段`);
  }

  // 账本自洽
  assert.ok(pkg.budget.used <= pkg.budget.brainAllowance);
  assert.ok(pkg.estimatedTokens <= pkg.budget.brainAllowance);
  assert.ok(pkg.diagnostics.reasons.some((reason) => reason.includes('预算超限')));
  // 裁剪后行号重排，且注入文本里只出现保留段
  assert.ok(pkg.injectedText.includes('1. ['));
  for (const entry of pkg.budget.dropped) {
    assert.ok(!pkg.injectedText.includes(`(${entry.memoryId};`), `被丢的段不该出现在注入文本：${entry.memoryId}`);
  }
});

test('超限裁剪：预算只够来源标记时宁可不注，也不留裸片段', async () => {
  // safetyMargin=1024；1100 - 0 - 0 - 1024 = 76 → 只够头部，装不下任何一段
  const store = mockStore(makeSearchResult({ hits: [makeHit()] }));
  const pkg = await buildOnce({ store, budget: { modelWindow: 1100, hostInputTokens: 0, outputReserve: 0 } });
  assert.equal(pkg.budget.brainAllowance, 76);
  assert.deepEqual(pkg.segments, []);
  assert.equal(pkg.injectedText, '');
  assert.equal(pkg.budget.used, 0);
  assert.equal(pkg.budget.dropped.length, 1);
  assert.ok(
    ['budget_below_envelope', 'over_budget_low_relevance'].includes(pkg.budget.dropped[0].reason),
    `理由要可查：${JSON.stringify(pkg.budget.dropped)}`,
  );
});

test('估算路径：拿不到 hostInputTokens 时固定小额上限 + reasons 明说估算', async () => {
  const store = mockStore(makeSearchResult({ hits: [makeHit({ summary: '短摘要' })] }));
  const pkg = await buildOnce({ store, budget: { modelWindow: 32000 } });
  assert.equal(pkg.budget.estimated, true);
  assert.equal(pkg.budget.hostInputSource, 'estimated');
  assert.equal(pkg.budget.brainAllowance, 512);
  assert.ok(pkg.diagnostics.reasons.some((reason) => reason.includes('估算')), '诊断里要说明这是估算');
  assert.equal(pkg.estimatedTokens <= 512, true);
});

test('段摘要是多行时压成单行，不破坏注入块结构', async () => {
  const store = mockStore(makeSearchResult({ hits: [makeHit({ summary: '第一行\n第二行\r\n第三行' })] }));
  const pkg = await buildOnce({ store });
  assert.ok(pkg.segments[0].summary.includes('第一行 第二行 第三行'));
  assert.equal(pkg.injectedText.split('\n').filter((line) => line.startsWith('1. [')).length, 1);
});

test('参数错误：store 形状不对 / 身份缺失 / 非法时间 → INVALID_ARGUMENT', async () => {
  const goodStore = mockStore(makeSearchResult({}));
  const cases = [
    () => build(/** @type {any} */ ({ store: {}, query: 'x', ...IDENTITY })),
    () => build(/** @type {any} */ ({ store: { memories: {} }, query: 'x', ...IDENTITY })),
    () => build(/** @type {any} */ ({ store: goodStore, query: 'x', ...IDENTITY, scopeId: '  ' })),
    () => build(/** @type {any} */ ({ store: goodStore, query: 'x', ...IDENTITY, personId: undefined })),
    () => build(/** @type {any} */ ({ store: goodStore, query: 'x', ...IDENTITY, sessionId: 42 })),
    () => build(/** @type {any} */ ({ store: goodStore, query: 42, ...IDENTITY })),
    () => build(/** @type {any} */ ({ store: goodStore, query: 'x', ...IDENTITY, budget: ROOMY_BUDGET, now: () => 'not-a-date' })),
    () => build(/** @type {any} */ ({ store: goodStore, query: 'x', ...IDENTITY, budget: ROOMY_BUDGET, retrievalLimit: 0 })),
  ];
  for (const run of cases) {
    await assert.rejects(run, (/** @type {any} */ err) => err.code === 'INVALID_ARGUMENT');
  }
});

test('估算口径自洽：整体估算 <= 逐行估算之和（used 是保守上界）', async () => {
  const store = mockStore(makeSearchResult({ hits: [makeHit({ summary: '中文摘要 with English 1200mm' })] }));
  const pkg = await buildOnce({ store });
  assert.equal(pkg.estimatedTokens, estimateTokens(pkg.injectedText));
  assert.ok(pkg.budget.used >= pkg.estimatedTokens);
});
