// @ts-check
/**
 * API 契约测试（M2-INTERFACES §4.1）。
 *
 * 覆盖：健康、记忆列表/详情、检索四态、构包三级证据、写入、删除 202。
 * 全部跑在临时主账上，数据是合成的。
 */

import test from 'node:test';
import { assert, createTempBrain, startTestServer } from './helpers.mjs';

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

// ---------------------------------------------------------------------------
// 健康
// ---------------------------------------------------------------------------

test('GET /api/health：给出库状态与降级清单，且不泄露凭据', async () => {
  const { status, json, headers } = await server.request('/api/health');
  assert.equal(status, 200);
  assert.equal(typeof json.ok, 'boolean');
  assert.equal(typeof json.version, 'string');
  assert.equal(typeof json.db.schemaVersion, 'string');
  assert.equal(typeof json.db.path, 'string');
  assert.ok(Array.isArray(json.degraded));
  assert.ok(json.store && typeof json.store.implementation === 'string');
  assert.ok(['facade', 'shim'].includes(json.store.implementation));
  // 数据库路径不该包含凭据
  assert.equal(json.db.path.includes(server.token), false);
  // 缓存策略：检查器数据不许进浏览器缓存
  assert.match(String(headers.get('cache-control')), /no-store/);
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
});

test('GET /api/ping：免凭据探活，且不含内部信息', async () => {
  const { status, json } = await server.request('/api/ping', { token: null });
  assert.equal(status, 200);
  assert.deepEqual(json, { ok: true, service: 'dsh-brain-server' });
});

// ---------------------------------------------------------------------------
// 记忆列表与详情
// ---------------------------------------------------------------------------

test('GET /api/memories：返回 items/nextCursor/limit/total', async () => {
  const { status, json } = await server.request('/api/memories');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.items));
  assert.ok(json.items.length > 0);
  assert.equal(typeof json.limit, 'number');
  assert.equal(typeof json.total, 'number');
  assert.ok('nextCursor' in json);

  const first = json.items[0];
  for (const field of ['id', 'layer', 'type', 'status', 'sourceType', 'confidence', 'version', 'validFrom', 'validUntil', 'sources', 'sourceStats']) {
    assert.ok(field in first, `记忆条目缺字段 ${field}`);
  }
});

test('GET /api/memories：过滤条件生效，且非法枚举被拒', async () => {
  const long = await server.request('/api/memories', { query: { layer: 'long' } });
  assert.equal(long.status, 200);
  assert.ok(long.json.items.length > 0);
  assert.ok(long.json.items.every((m) => m.layer === 'long'));

  const bad = await server.request('/api/memories', { query: { layer: 'nope' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.error.code, 'INVALID_ARGUMENT');
});

test('GET /api/memories/:id：带来源、来源统计、版本历史', async () => {
  const { status, json } = await server.request('/api/memories/mem-ceiling-1200');
  assert.equal(status, 200);
  const m = json.memory;
  assert.equal(m.id, 'mem-ceiling-1200');
  assert.ok(Array.isArray(m.sources));
  assert.equal(m.sources.length, 1);
  assert.equal(m.sources[0].verification.ok, true);
  assert.equal(m.sourceStats.total, 1);
  assert.equal(m.sourceStats.verified, 1);
  assert.ok(Array.isArray(m.versions));
  assert.equal(m.versions[0].version, 1);
  assert.ok(Array.isArray(m.supersedeChain));
});

test('GET /api/memories/:id：来源丢失要被标出来，不许当 ok', async () => {
  const { json } = await server.request('/api/memories/mem-orphan-source');
  assert.equal(json.memory.sources.length, 1);
  assert.equal(json.memory.sources[0].verification.ok, false);
  assert.equal(json.memory.sources[0].verification.reason, 'source_missing');
  assert.equal(json.memory.sourceStats.missing, 1);
});

test('GET /api/memories/:id?asOf=：能回到某时点判断这条事实是否有效', async () => {
  const before = await server.request('/api/memories/mem-ceiling-1200', { query: { asOf: '2025-06-01T00:00:00.000Z' } });
  assert.equal(before.status, 200);
  assert.equal(before.json.memory.asOf.inEffect, false);
  assert.match(before.json.memory.asOf.note, /还没生效/);

  const after = await server.request('/api/memories/mem-ceiling-1200', { query: { asOf: '2026-06-01T00:00:00.000Z' } });
  assert.equal(after.json.memory.asOf.inEffect, true);
});

test('GET /api/memories/:id：不存在的 id 回 404', async () => {
  const { status, json } = await server.request('/api/memories/mem-nope');
  assert.equal(status, 404);
  assert.equal(json.error.code, 'NOT_FOUND');
});

// ---------------------------------------------------------------------------
// 检索诊断四态
// ---------------------------------------------------------------------------

test('GET /api/search：命中且来源可核对 → ok', async () => {
  const { status, json } = await server.request('/api/search', { query: { q: '吊顶' } });
  assert.equal(status, 200);
  assert.ok(json.hits.length > 0);
  assert.equal(json.diagnostics.status, 'ok');
  assert.ok(Array.isArray(json.diagnostics.notes));
  assert.ok(json.statusLegend && json.statusLegend.ok);
});

test('GET /api/search：真没有 → no_related（不是「检索失败」）', async () => {
  // 中文检索是单字级召回：只要有一个字在库里就会命中。要验证「真没有」，
  // 得用一个库里任何一条都不含的字/词。
  const { json } = await server.request('/api/search', { query: { q: 'zzq-nothing-matches-this' } });
  assert.equal(json.hits.length, 0);
  assert.equal(json.diagnostics.status, 'no_related');
  assert.ok(Array.isArray(json.diagnostics.notes));
});

test('GET /api/search：相关但撑不住答案 → insufficient_evidence', async () => {
  // 命中集合全部来源完好，但查询远远大于命中的那段内容 → 覆盖度低于阈值。
  // 用词刻意避开了库里其它记忆的字（中文按单字召回，共享一个字就会带进来）。
  const { json } = await server.request('/api/search', {
    query: { q: '垭口 门槛 硅酮 灰色 铝方通 灯带 软膜 弧形 铁艺 珠帘 硬包 踢脚线 波打线 收口条' },
  });
  assert.ok(json.hits.length > 0, '应当有命中');
  assert.equal(json.diagnostics.status, 'insufficient_evidence');
  assert.ok(json.diagnostics.notes.some((n) => n.includes('覆盖度')));
  // 这条路径不该出现「来源有问题」的指控：证据不够 ≠ 来源坏了
  assert.equal(json.diagnostics.notes.some((n) => n.includes('来源丢失')), false);
  assert.equal(json.diagnostics.notes.some((n) => n.includes('来源互相冲突')), false);
});

test('GET /api/search：minCoverage 可调，阈值放低就会把「不够」当成「够」', async () => {
  const q = '垭口 门槛 硅酮 灰色 铝方通 灯带 软膜 弧形 铁艺 珠帘 硬包 踢脚线 波打线 收口条';

  const strict = await server.request('/api/search', { query: { q } });
  assert.equal(strict.json.diagnostics.status, 'insufficient_evidence');

  // 把阈值压到几乎为零：同一批命中就变成 ok —— 正是「拿相似结果硬凑」会发生的事。
  const loose = await server.request('/api/search', { query: { q, minCoverage: 0.01 } });
  assert.equal(loose.json.diagnostics.status, 'ok');

  const bad = await server.request('/api/search', { query: { q, minCoverage: 7 } });
  assert.equal(bad.status, 400);
});

test('GET /api/search：无来源/来源已删 → source_missing', async () => {
  // 这条记忆的来源指向一个已被删除屏障标记的事件。
  const { json } = await server.request('/api/search', { query: { q: '报价单' } });
  assert.ok(json.hits.length > 0);
  assert.equal(json.diagnostics.status, 'source_missing');
  assert.ok(json.diagnostics.notes.some((n) => n.includes('来源丢失')));

  // 完全没挂来源的记忆同样归到「来源层面有问题」，不会被当成证据。
  const noSource = await server.request('/api/search', { query: { q: '客户说下周一' } });
  assert.ok(noSource.json.hits.length > 0);
  assert.equal(noSource.json.diagnostics.status, 'source_missing');
  assert.ok(noSource.json.diagnostics.notes.some((n) => n.includes('无来源记录')));
});

test('GET /api/search：同一来源两种说法 → source_conflict', async () => {
  const { json } = await server.request('/api/search', { query: { q: '卫生间墙面砖' } });
  assert.ok(json.hits.length >= 2);
  assert.equal(json.diagnostics.status, 'source_conflict');
  assert.ok(json.diagnostics.notes.some((n) => n.includes('来源互相冲突')));

  // 冲突的那条记忆，两条来源引用都要能被单独看见（否则「冲突」是个空指控）
  const conflicted = json.hits.find((h) => h.memoryId === 'mem-conflict-a');
  assert.ok(conflicted, '应当命中带冲突来源的那条记忆');
  assert.equal(conflicted.sourceRefs.length, 2);
  const hashes = new Set(conflicted.sourceRefs.map((r) => r.contentHash).filter(Boolean));
  assert.equal(hashes.size, 2, '两条来源的内容指纹应当不同');
});

test('GET /api/search：缺 q → 400；超长 q → 400', async () => {
  const missing = await server.request('/api/search');
  assert.equal(missing.status, 400);
  assert.equal(missing.json.error.code, 'INVALID_ARGUMENT');

  const long = await server.request('/api/search', { query: { q: '长'.repeat(250) } });
  assert.equal(long.status, 400);
  assert.equal(long.json.error.code, 'INVALID_ARGUMENT');
});

test('GET /api/search：LIKE 通配符被转义，不能用来探测整库', async () => {
  const { json } = await server.request('/api/search', { query: { q: '%' } });
  // `%` 若未转义会命中全部；转义后应视为字面量，命中 0 条。
  assert.equal(json.hits.length, 0);
  assert.equal(json.diagnostics.status, 'no_related');
});

// ---------------------------------------------------------------------------
// 上下文检查器
// ---------------------------------------------------------------------------

test('GET /api/context/:id：只到 built 的包，不许显示成已注入', async () => {
  const { status, json } = await server.request('/api/context/ctx-built-only');
  assert.equal(status, 200);
  assert.equal(json.status, 'built');
  assert.equal(json.evidence.ceiling, 'built');
  const levels = Object.fromEntries(json.evidence.steps.map((s) => [s.level, s.proven]));
  assert.equal(levels.built, true);
  assert.equal(levels.attached, false);
  assert.equal(levels.sent, false);
  assert.ok(json.evidence.caveats.some((c) => c.includes('未达 sent')));
  assert.ok(Array.isArray(json.segments));
  assert.equal(json.segments.length, 2);
  assert.equal(json.segments[0].sourceRefs.length, 1);
});

test('GET /api/context/:id：预算没记录就如实说没记录，不伪造', async () => {
  const { json } = await server.request('/api/context/ctx-built-only');
  assert.equal(json.budget.recorded, false);
  assert.equal(json.budget.allowance, null);
  assert.ok(json.budget.note.includes('未记录'));
});

test('GET /api/context/:id：snapshot 形态能给出预算与被丢掉的段与理由', async () => {
  const { json } = await server.request('/api/context/ctx-snapshot');
  assert.equal(json.budget.recorded, true);
  assert.equal(json.budget.allowance, 2048);
  assert.equal(json.budget.used, 900);
  assert.equal(json.budget.dropped.length, 1);
  assert.ok(json.budget.dropped[0].reason.length > 0);
  assert.match(json.package.injectedText, /brain:ctx-snapshot/);
});

test('GET /api/context/:id：sent 的证据要带边界说明（不证明出网）', async () => {
  const { json } = await server.request('/api/context/ctx-sent');
  assert.equal(json.evidence.ceiling, 'sent');
  assert.ok(json.evidence.caveats.some((c) => c.includes('不证明字节')));
  assert.ok(json.evidence.caveats.some((c) => c.includes('两级')));
  assert.equal(json.evidence.carrier, null);
  assert.match(json.evidence.carrierNote, /未记录/);
});

test('GET /api/context/:id：失效包不能算作注入证据', async () => {
  const { json } = await server.request('/api/context/ctx-discarded');
  assert.equal(json.evidence.ceiling, 'none');
  assert.ok(json.evidence.caveats.some((c) => c.includes('已失效')));
});

test('GET /api/contexts：按 session 过滤，并带 token 估算与段数', async () => {
  const { status, json } = await server.request('/api/contexts', { query: { sessionId: 'session-synth-01' } });
  assert.equal(status, 200);
  assert.ok(json.items.length >= 3);
  assert.ok(json.items.every((c) => c.sessionId === 'session-synth-01'));
  for (const item of json.items) {
    assert.equal(typeof item.estimatedTokens, 'number');
    assert.equal(typeof item.segmentCount, 'number');
  }
});

// ---------------------------------------------------------------------------
// 写入
// ---------------------------------------------------------------------------

test('POST /api/memories：写入成功返回 201，且能立刻读回', async () => {
  const created = await server.request('/api/memories', {
    method: 'POST',
    body: JSON.stringify({
      content: '石材干挂用 1200mm 宽板，背后挂件间距 600mm。',
      summary: '石材干挂挂件间距 600mm',
      layer: 'long',
      type: 'semantic',
      sourceType: 'owner_words',
      confidence: 0.9,
      importance: 0.7,
    }),
  });
  assert.equal(created.status, 201, `写入失败：${created.text}`);
  assert.match(created.json.id, /^mem_/);
  assert.equal(created.json.version, 1);

  const readback = await server.request(`/api/memories/${created.json.id}`);
  assert.equal(readback.status, 200);
  assert.match(readback.json.memory.content, /挂件间距/);
  assert.equal(readback.json.memory.versions.length, 1);
});

test('POST /api/memories：推断不能伪装成确定事实（confidence 被压到 <1）', async () => {
  const created = await server.request('/api/memories', {
    method: 'POST',
    body: JSON.stringify({
      content: '推测客户更喜欢浅色石材。',
      sourceType: 'inference',
      confidence: 1,
    }),
  });
  assert.equal(created.status, 201);
  const readback = await server.request(`/api/memories/${created.json.id}`);
  assert.ok(readback.json.memory.confidence < 1);
  assert.equal(readback.json.memory.sourceType, 'inference');
});

test('POST /api/memories：空正文/非法枚举一律 400', async () => {
  const empty = await server.request('/api/memories', { method: 'POST', body: JSON.stringify({ content: '   ' }) });
  assert.equal(empty.status, 400);

  const badLayer = await server.request('/api/memories', {
    method: 'POST',
    body: JSON.stringify({ content: 'x', layer: 'eternal' }),
  });
  assert.equal(badLayer.status, 400);
  assert.equal(badLayer.json.error.code, 'INVALID_ARGUMENT');

  const notJson = await server.request('/api/memories', { method: 'POST', body: '{oops' });
  assert.equal(notJson.status, 400);
});

// ---------------------------------------------------------------------------
// 删除（202 + 清理进度）
// ---------------------------------------------------------------------------

test('DELETE /api/memories/:id：202 受理、写墓碑、之后检索不到', async () => {
  const target = 'mem-partition-price';

  const del = await server.request(`/api/memories/${target}`, { method: 'DELETE' });
  assert.equal(del.status, 202);
  assert.equal(del.json.status, 'accepted');
  assert.match(del.json.tombstoneId, /^tmb/);
  assert.equal(typeof del.json.deletionEpoch, 'number');
  assert.ok(del.json.deletionEpoch >= 1);
  assert.ok(del.json.cleanup.total >= 1);
  // 202 的含义必须说清楚：受理 ≠ 清干净
  assert.match(del.json.meaning, /不表示/);

  const list = await server.request('/api/memories');
  assert.equal(list.json.items.some((m) => m.id === target), false);

  const search = await server.request('/api/search', { query: { q: '轻钢龙骨' } });
  assert.equal(search.json.hits.some((h) => h.memoryId === target), false);

  const detail = await server.request(`/api/memories/${target}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.memory.tombstoned, true);
});

test('DELETE /api/memories/:id：重复删除幂等，不重复抬 epoch', async () => {
  const first = await server.request('/api/memories/mem-drawing-jianshi-03', { method: 'DELETE' });
  assert.equal(first.status, 202);
  const epoch1 = first.json.deletionEpoch;

  const second = await server.request('/api/memories/mem-drawing-jianshi-03', { method: 'DELETE' });
  assert.equal(second.status, 202);
  assert.equal(second.json.status, 'already_tombstoned');
  assert.equal(second.json.idempotent, true);
  assert.equal(second.json.deletionEpoch, epoch1);
});

test('DELETE /api/memories/:id：不存在 → 404', async () => {
  const { status, json } = await server.request('/api/memories/mem-ghost', { method: 'DELETE' });
  assert.equal(status, 404);
  assert.equal(json.error.code, 'NOT_FOUND');
});
