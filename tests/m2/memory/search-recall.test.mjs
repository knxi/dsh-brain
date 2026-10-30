// @ts-check
/**
 * M2 检索命中：这是「集成 search 包」到底成不成立的证据。
 *
 * 语料全是合成的主人口味（尺寸 / 材质 / 图号 / 报价 / 英文与代码标识符），
 * 断言的是**中文本体能力**而不是「能返回点什么」：
 * - 中文两字词、单字、短句必须命中（默认 unicode61 对这些是 0%）。
 * - 数字单位、图号、代码标识符必须**精确**回查（1.2m 与 1200mm 不做等价推断）。
 * - 四种会让裸 MATCH 抛错的输入必须不抛，且被标记为「已转义」。
 */

import test from 'node:test';
import { assert, SCOPE_A, createBrain, draft, hitKeys, seedCorpus } from './helpers.mjs';


test('中文两字词命中（英文 tokenizer 对中文两字词是 0 命中）', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);
  const result = brain.memories.search({ query: '铜版', scopeId: SCOPE_A });
  assert.equal(result.diagnostics.status, 'ok');
  const keys = hitKeys(result, ids);
  assert.ok(keys.includes('business-card'), `「铜版」应命中名片那条，实际：${keys.join(',')}`);
  assert.ok(keys.includes('scaffold-price'), '「铜版」也应命中「和铜版纸名片的报价不是一回事」那条');
});

test('中文单字命中', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);
  const result = brain.memories.search({ query: '梁', scopeId: SCOPE_A });
  const keys = hitKeys(result, ids);
  assert.ok(keys.includes('steel-note'), `单字「梁」应命中结施说明，实际：${keys.join(',')}`);
});

test('中文短句命中（三字以上）', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);
  const result = brain.memories.search({ query: '喷绘精度', scopeId: SCOPE_A });
  const keys = hitKeys(result, ids);
  assert.ok(keys.includes('banner'), `「喷绘精度」应命中户外喷绘，实际：${keys.join(',')}`);
});

test('数字单位精确回查：1.2m / 2400×600 / 90×54mm', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);

  const width = brain.memories.search({ query: '1.2m', scopeId: SCOPE_A });
  assert.ok(hitKeys(width, ids).includes('banner'), '「1.2m」必须精确命中');
  assert.equal(width.diagnostics.queryWasEscaped, true, '「1.2m」原样进 MATCH 会崩，必须标记为已转义');

  const beam = brain.memories.search({ query: '2400×600', scopeId: SCOPE_A });
  assert.ok(hitKeys(beam, ids).includes('steel-note'), '「2400×600」必须精确命中');

  const card = brain.memories.search({ query: '90×54mm', scopeId: SCOPE_A });
  assert.ok(hitKeys(card, ids).includes('business-card'), '「90×54mm」必须精确命中');
});

test('不做数字等价推断：1200mm 不该命中 1.2m（CONTRACTS §7 保留原始参数）', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);
  const result = brain.memories.search({ query: '1200mm', scopeId: SCOPE_A });
  assert.equal(
    hitKeys(result, ids).includes('banner'),
    false,
    '1.2m ≠ 1200mm 的等价换算不属于检索层（报告 §5 明确不做），宁可不命中也不编',
  );
});

test('图号精确回查：建施-03 / JS-2026-017（裸 MATCH 会报 no such column）', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);

  const dwg = brain.memories.search({ query: '建施-03', scopeId: SCOPE_A });
  assert.equal(dwg.diagnostics.queryWasEscaped, true);
  assert.ok(hitKeys(dwg, ids).includes('drawing-03'));

  const js = brain.memories.search({ query: 'JS-2026-017', scopeId: SCOPE_A });
  assert.equal(js.diagnostics.queryWasEscaped, true);
  assert.ok(hitKeys(js, ids).includes('steel-note'));
});

test('代码 / 英文标识符：readSurface / build:web / deletion_epoch / pnpm', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);

  const readSurface = brain.memories.search({ query: 'readSurface', scopeId: SCOPE_A });
  assert.ok(hitKeys(readSurface, ids).includes('canvas-tool'), 'readSurface 必须命中（大小写不敏感）');

  const buildWeb = brain.memories.search({ query: 'build:web', scopeId: SCOPE_A });
  assert.equal(buildWeb.diagnostics.queryWasEscaped, true, '「build:web」的冒号是 FTS5 列语法');
  assert.ok(hitKeys(buildWeb, ids).includes('identifiers'));

  const epoch = brain.memories.search({ query: 'deletion_epoch', scopeId: SCOPE_A });
  assert.ok(hitKeys(epoch, ids).includes('identifiers'));

  const pnpm = brain.memories.search({ query: 'pnpm', scopeId: SCOPE_A });
  assert.ok(hitKeys(pnpm, ids).includes('identifiers'));
});

test('数字字母边界切分：查 1440dpi 与 dpi 都能命中', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);
  assert.ok(hitKeys(brain.memories.search({ query: '1440dpi', scopeId: SCOPE_A }), ids).includes('banner'));
  assert.ok(hitKeys(brain.memories.search({ query: 'dpi', scopeId: SCOPE_A }), ids).includes('banner'));
});

test('hits 结构完整：必有版本、必有来源、必有有效期字段（M2 门槛）', async (t) => {
  const { brain } = createBrain(t);
  await seedCorpus(brain);
  const result = brain.memories.search({ query: '铜版', scopeId: SCOPE_A });
  assert.ok(result.hits.length > 0);
  for (const hit of result.hits) {
    assert.equal(typeof hit.memoryId, 'string');
    assert.ok(Number.isInteger(hit.version) && hit.version >= 1, '命中必须有版本');
    assert.equal(typeof hit.score, 'number');
    assert.ok(Array.isArray(hit.matchedBy) && hit.matchedBy.length > 0, '命中必须说明靠哪一路匹配');
    for (const lane of hit.matchedBy) assert.ok(['char', 'trigram', 'ngram', 'like'].includes(lane));
    assert.ok(Array.isArray(hit.sourceRefs) && hit.sourceRefs.length > 0, '命中必须有来源（M2 门槛第一条）');
    assert.equal(typeof hit.sourceRefs[0].sourceEventId, 'string');
    assert.ok(['owner_words', 'observation', 'inference', 'web', 'tool', 'summary'].includes(hit.evidenceKind));
    assert.equal(typeof hit.contentHash, 'string');
    assert.ok(hit.contentHash.startsWith('sha256:'));
    assert.ok('validFrom' in hit && 'validUntil' in hit);
    assert.equal(typeof hit.layer, 'string');
    assert.equal(typeof hit.type, 'string');
    assert.equal(typeof hit.summary, 'string');
  }
});

test('diagnostics 结构符合契约（四种检索不足 + escaped + degraded + notes）', async (t) => {
  const { brain } = createBrain(t);
  await seedCorpus(brain);
  const result = brain.memories.search({ query: '铜版', scopeId: SCOPE_A });
  assert.deepEqual(Object.keys(result.diagnostics).sort(), [
    'bestCoverage',
    'candidateCount',
    'degraded',
    'notes',
    // 契约字段之外只增不改的额外诊断：本轮是否有主路命中（弱证据可见化）
    'primaryLaneHit',
    'queryWasEscaped',
    'routes',
    'status',
  ]);
  assert.equal(result.diagnostics.degraded, null);
  assert.ok(Array.isArray(result.diagnostics.notes));
  assert.ok(['ok', 'no_related', 'insufficient_evidence', 'source_missing', 'source_conflict'].includes(result.diagnostics.status));
});

test('limit 生效且不影响 diagnostics 判定', async (t) => {
  const { brain } = createBrain(t);
  await seedCorpus(brain);
  const wide = brain.memories.search({ query: '报价', scopeId: SCOPE_A, limit: 10 });
  const narrow = brain.memories.search({ query: '报价', scopeId: SCOPE_A, limit: 1 });
  assert.ok(wide.hits.length >= 2, '「报价」至少命中名片与脚手架两条');
  assert.equal(narrow.hits.length, 1);
  assert.equal(narrow.diagnostics.status, wide.diagnostics.status, 'limit 不该改变证据判定');
});

test('空查询与纯标点查询按 no_related 返回，不抛错也不瞎兜底', async (t) => {
  const { brain } = createBrain(t);
  await seedCorpus(brain);
  for (const query of ['', '   ', '，。、']) {
    const result = brain.memories.search({ query, scopeId: SCOPE_A });
    assert.equal(result.hits.length, 0);
    assert.equal(result.diagnostics.status, 'no_related');
    assert.ok(result.diagnostics.notes.length > 0, '必须说明为什么没结果');
  }
});

test('secret 隐私默认不进检索结果（注入不该自动带出去）', async (t) => {
  const { brain } = createBrain(t);
  await brain.memories.create(
    { scopeId: SCOPE_A, layer: 'long', type: 'boundary', content: '银行卡密码提示词是 2400×600 这句里的暗号',
      summary: '机密', sourceType: 'owner_words', sourceIds: ['evt-secret'], originSystem: 'dsh',
      producer: 'test', privacy: 'secret' },
  );
  const hidden = brain.memories.search({ query: '暗号', scopeId: SCOPE_A });
  assert.equal(hidden.hits.length, 0, 'secret 默认不返回');
  const revealed = brain.memories.search({ query: '暗号', scopeId: SCOPE_A, includeSecret: true });
  assert.equal(revealed.hits.length, 1, '显式 includeSecret 才能取到');
});

test('scopeId 隔离：看不见别的 scope 的记忆', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);
  const foreign = brain.memories.search({ query: '铜版', scopeId: 'owner-other' });
  assert.equal(foreign.hits.length, 0);
  assert.equal(foreign.diagnostics.status, 'no_related');
  assert.ok(hitKeys(brain.memories.search({ query: '铜版', scopeId: SCOPE_A }), ids).length > 0);
});

// ---------------------------------------------------------------------------
// 多段长查询：段间 AND 的语义边界 + 分段召回补偿
//
// 实测（`buildFtsMatch` 实际输出，不是推测）：
//   `铜版纸名片`（无空格）  -> ("铜" OR "版" OR "纸" OR "名" OR "片")   ← 单段、5 token > 4 → OR
//   `铜版纸 名片`（有空格） -> "铜 版 纸" "名 片"                     ← 两段 phrase + 段间隐式 AND
// 用户加空格本意是「分开找」，结果反而要求同一文档里两个短语都连续相邻出现。
// `memories.search()` 在「原查询主路 0 命中」时按段重查再 RRF 合并，
// 补的正是缺的那层「段间 OR」——这一组测试钉住它。
// ---------------------------------------------------------------------------

test('多段长查询：分段召回补偿让主路重新命中（不再全靠 ngram 兜底）', async (t) => {
  const { brain } = createBrain(t);
  // 两条记忆分别只覆盖一段：整串 AND 时必然 0 命中
  await brain.memories.create(
    draft({ content: '展板尺寸 1200×2400mm，用 5mm PVC 板', summary: '展板尺寸与板材', sourceIds: ['evt-board-1'] }),
  );
  await brain.memories.create(
    draft({ content: '铝板报价 380 元一平米，含税', summary: '铝板报价', sourceIds: ['evt-board-2'] }),
  );

  const result = brain.memories.search({ query: '展板尺寸 铝板报价', scopeId: SCOPE_A });

  // 核心断言：两条都要召回（原来整串 AND 是 0）
  assert.equal(result.hits.length, 2, `两条都应召回，实际 ${result.hits.length}`);
  // 主路必须真的参与，而不是又退回 ngram 弱路
  assert.equal(result.diagnostics.primaryLaneHit, true, '分段召回补偿后主路必须命中');
  assert.ok(result.diagnostics.routes.segmented, 'routes 里要能看到 segmented 路的候选数');
  assert.equal(result.diagnostics.routes.segmented.count, 2);
  assert.ok(
    result.diagnostics.notes.some((note) => note.includes('段间 OR')),
    `notes 必须说明发生了分段补偿，实际：${JSON.stringify(result.diagnostics.notes)}`,
  );
});

test('多段长查询：三段里有两段能命中也能召回', async (t) => {
  const { brain } = createBrain(t);
  await brain.memories.create(draft({ content: '展板尺寸 1200×2400mm', summary: '展板', sourceIds: ['evt-a'] }));
  await brain.memories.create(draft({ content: '铝板报价 380 元一平米含税', summary: '铝板', sourceIds: ['evt-b'] }));
  const result = brain.memories.search({ query: '展板尺寸 铝板报价 含税', scopeId: SCOPE_A });
  assert.equal(result.hits.length, 2);
  assert.equal(result.diagnostics.primaryLaneHit, true);
  assert.ok(result.diagnostics.routes.segmented.segments >= 2);
});

test('单段查询不触发分段补偿（正常路径与排序不受影响）', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);
  const result = brain.memories.search({ query: '铜版', scopeId: SCOPE_A });
  assert.equal(result.diagnostics.routes.segmented, undefined, '单段查询不该走分段补偿');
  assert.equal(result.diagnostics.primaryLaneHit, true);
  assert.ok(hitKeys(result, ids).includes('business-card'));
});

test('无空格长查询本来就走 OR，不触发分段补偿', async (t) => {
  const { brain } = createBrain(t);
  const ids = await seedCorpus(brain);
  const result = brain.memories.search({ query: '铜版纸名片的报价', scopeId: SCOPE_A });
  assert.equal(result.diagnostics.routes.segmented, undefined, '单段 5 token 走 OR，已在主路命中，不需要补偿');
  assert.ok(result.hits.length > 0);
  assert.ok(hitKeys(result, ids).includes('business-card'));
});

test('分段补偿不放宽证据判定：无关的多段查询仍然是 no_related', async (t) => {
  const { brain } = createBrain(t);
  await seedCorpus(brain);
  const result = brain.memories.search({ query: '量子纠缠 退相干 玻色子', scopeId: SCOPE_A });
  assert.equal(result.hits.length, 0);
  assert.equal(result.diagnostics.status, 'no_related');
  assert.equal(result.diagnostics.primaryLaneHit, false);
});

test('分段补偿只取各段的主路命中，不把弱路结果抬成主路', async (t) => {
  const { brain } = createBrain(t);
  // 这条记忆只与第二段的个别字偶合，主路短语不会命中
  await brain.memories.create(draft({ content: '铝板边角料处理流程', summary: '边角料', sourceIds: ['evt-scrap'] }));
  const result = brain.memories.search({ query: '展板尺寸 铝板报价', scopeId: SCOPE_A });
  // 允许命中（主路对「铝板报价」段确实命中不了、但「铝板」相关字可能进 ngram 兜底），
  // 关键是：如果 segmented 没结果，primaryLaneHit 就不能被标成 true。
  if (!result.diagnostics.routes.segmented) {
    assert.equal(result.diagnostics.primaryLaneHit, false, '没有主路命中时不许把 primaryLaneHit 标成 true');
  }
});

test('OR 段 + 后续段：不允许把主路整条拖进降级（search 包 FTS5 语法错的回归闸门）', async (t) => {
  const { brain } = createBrain(t);
  // `展板成品尺寸` 单段 6 token > 4 → 走 OR；`铝板厚度` 走 phrase。
  // 修复前 buildFtsMatch 生成 `("展" OR …) "铝 板 厚 度"`（隐式 AND）→
  // FTS5 直接 syntax error → 整条检索 degraded=fts_unavailable、只剩 ngram 弱路。
  await brain.memories.create(
    draft({ content: '展板成品尺寸 1200×2400mm，5mm PVC 板', summary: '展板规格', sourceIds: ['evt-or-1'] }),
  );
  await brain.memories.create(
    draft({ content: '铝板厚度 3mm，报价 380 元一平米', summary: '铝板厚度与报价', sourceIds: ['evt-or-2'] }),
  );

  const result = brain.memories.search({ query: '展板成品尺寸 铝板厚度', scopeId: SCOPE_A });

  // 四条断言，任何一条红都说明这条链路又退化了
  assert.equal(result.diagnostics.degraded, null, '主路不该被 FTS5 语法错拖进降级');
  assert.equal(result.diagnostics.primaryLaneHit, true, '主路必须命中（不是靠 ngram 兜底）');
  assert.ok(
    Number(result.diagnostics.routes.fts_char?.count ?? 0) > 0,
    `char 路必须有候选，routes：${JSON.stringify(result.diagnostics.routes)}`,
  );
  assert.ok(result.hits.length > 0);
  assert.equal(
    result.diagnostics.notes.some((note) => note.includes('FTS5 查询失败')),
    false,
    `不该再走 FTS5 失败分支，notes：${JSON.stringify(result.diagnostics.notes)}`,
  );
});
