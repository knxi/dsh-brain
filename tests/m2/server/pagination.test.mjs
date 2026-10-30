// @ts-check
/**
 * 分页测试：硬上限、游标正确性、翻页不重不漏、非法参数被拒。
 *
 * 分页上限不是洁癖：一次拉穿主账会让检查器自己变成压力源。
 */

import test from 'node:test';
import { assert, createTempBrain, seedManyMemories, startTestServer } from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof startTestServer>>} */
let server;
/** @type {Awaited<ReturnType<typeof createTempBrain>>} */
let brain;

const BULK = 250;

test.before(async () => {
  brain = await createTempBrain({ seed: false });
  await seedManyMemories(brain.brain, BULK);
  server = await startTestServer({ dbPath: brain.dbPath });
});

test.after(async () => {
  await server?.close();
  await brain?.close();
});

test('默认一页 50 条，带 nextCursor', async () => {
  const { json } = await server.request('/api/memories');
  assert.equal(json.items.length, 50);
  assert.equal(json.limit, 50);
  assert.equal(typeof json.nextCursor, 'string');
  assert.equal(json.total, BULK);
  assert.equal(json.limitNote, null);
});

test('limit 超过硬上限被夹到 200，并在 limitNote 里说明', async () => {
  const { status, json } = await server.request('/api/memories', { query: { limit: 9999 } });
  assert.equal(status, 200);
  assert.equal(json.items.length, 200, '一次最多 200 条');
  assert.equal(json.limit, 200);
  assert.match(String(json.limitNote), /超过上限/);
});

test('翻完全部页：不重、不漏、顺序稳定', async () => {
  /** @type {string[]} */
  const ids = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const { json } = await server.request('/api/memories', { query: { limit: 37, cursor } });
    pages += 1;
    assert.ok(pages <= 20, '翻页次数异常，游标可能没推进');
    for (const item of json.items) ids.push(item.id);
    if (json.nextCursor === null) break;
    cursor = json.nextCursor;
    // 游标必须是可回传的不透明串，且不能是原始时间戳
    assert.equal(typeof cursor, 'string');
    assert.ok(cursor.length > 0);
  }
  assert.equal(ids.length, BULK, `应当收齐 ${BULK} 条，实际 ${ids.length}`);
  assert.equal(new Set(ids).size, BULK, '出现了重复条目');
  // keyset 分页按 created_at DESC：第一条应晚于最后一条
  const first = await server.request(`/api/memories/${ids[0]}`);
  const last = await server.request(`/api/memories/${ids[ids.length - 1]}`);
  assert.ok(first.json.memory.createdAt >= last.json.memory.createdAt);
});

test('limit 非法值被拒（不静默变默认值）', async () => {
  for (const limit of ['0', '-3', 'abc', 'NaN', '1.5e3x']) {
    const { status } = await server.request('/api/memories', { query: { limit } });
    assert.equal(status, 400, `limit=${limit} 应被拒`);
  }
});

test('cursor 非法被拒（不能伪造游标来扫库）', async () => {
  for (const cursor of ['garbage', 'eyJ2IjoyfQ', 'AAAAAAAAAAAAAAAA', Buffer.from('{"v":1}').toString('base64url')]) {
    const { status } = await server.request('/api/memories', { query: { cursor } });
    assert.equal(status, 400, `cursor=${cursor} 应被拒`);
  }
});

test('过滤条件与总数一致（total 是过滤后的数）', async () => {
  const { json } = await server.request('/api/memories', { query: { layer: 'fragment', limit: 5 } });
  assert.equal(json.total, BULK, '合成数据全是 fragment');
  const other = await server.request('/api/memories', { query: { layer: 'permanent' } });
  assert.equal(other.json.total, 0);
  assert.equal(other.json.items.length, 0);
});

test('构包列表也有分页上限', async () => {
  const { json } = await server.request('/api/contexts', { query: { limit: 100000 } });
  assert.equal(json.limit, 200);
  assert.ok(json.items.length <= 200);
  assert.match(String(json.limitNote), /超过上限/);
});

test('检索结果条数受 limit 约束，且不会超过上限', async () => {
  const small = await server.request('/api/search', { query: { q: '批量合成条目', limit: 3 } });
  assert.equal(small.status, 200);
  assert.ok(small.json.hits.length <= 3);

  const huge = await server.request('/api/search', { query: { q: '批量合成条目', limit: 100000 } });
  assert.equal(huge.status, 200);
  assert.ok(huge.json.hits.length <= 200);
});
