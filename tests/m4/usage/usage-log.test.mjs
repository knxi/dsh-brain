// @ts-check
/**
 * apps/brain-tools/usage-log.js 单元测试（M4 使用统计）。
 *
 * 覆盖任务书 12 类必测项，外加「尾部字节截断」一条加固。所有期望值都是手算的字面量：
 * 时间戳、百分比、分位数、按天分组都写死成具体数字，不用 assert.ok(x > 0) 这种空断言。
 *
 * 纪律：
 * - 只用 node:test / node:assert/strict；临时目录 mkdtempSync，测完清理；
 * - 不碰 data/brain.db，不 import @dsh-brain/memory；
 * - 不 import apps/brain-tools/index.js（host 插件，需要 DSH 运行时）。
 *
 * 已知模块缺陷不在测试里「固化」，只在报告里点名；本文件刻意用显式 durationMs /
 * importance 的样本，避免把 Number(null) === 0 的边界行为写成期望值。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_WINDOW_DAYS,
  MAX_HIT_IDS,
  MAX_QUERY_CHARS,
  MAX_READ_BYTES,
  appendUsage,
  computeCoverage,
  normalizeUsageEntry,
  parseUsageLines,
  readUsageLog,
  summarizeUsage,
} from '../../../apps/brain-tools/usage-log.js';

/** 固定基准时刻：1700000000000 ms = 2023-11-14T22:13:20.000Z（手算过） */
const FIXED_NOW = 1700000000000;
const DAY = 24 * 60 * 60 * 1000;

/**
 * 建一个测完自动删的临时目录（含 Windows 上删除重试）。
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

// ---------------------------------------------------------------------------
// 1. 追加 → 读回，字段形状固定
// ---------------------------------------------------------------------------
test('1. appendUsage 追加后能读回，字段形状由 normalizeUsageEntry 固定', (t) => {
  const logPath = join(tempDir(t), 'logs', 'usage.jsonl');

  const first = appendUsage(
    logPath,
    {
      channel: 'tool',
      query: '  铜版纸   名片 报价 ',
      limit: 8,
      asOf: null,
      ok: true,
      code: null,
      hitCount: 2,
      hitIds: ['mem-a', 'mem-b'],
      status: 'ok',
      primaryLaneHit: true,
      degraded: null,
      durationMs: 42,
      sessionId: 'sess-1',
    },
    FIXED_NOW,
  );
  assert.deepEqual(first, { ok: true }, '成功路径只返回 { ok: true }，不夹带别的字段');
  assert.deepEqual(appendUsage(logPath, { query: '第二条', hitCount: 0 }, FIXED_NOW + 1000), { ok: true });

  const read = readUsageLog(logPath);
  assert.equal(read.exists, true);
  assert.equal(read.total, 2);
  assert.equal(read.skipped, 0);

  const e = read.entries[0];
  // 字段清单写死：多一个少一个都算契约变更，必须显式改测试。
  assert.deepEqual(Object.keys(e).sort(), [
    'asOf',
    'at',
    'channel',
    'code',
    'degraded',
    'durationMs',
    'hitCount',
    'hitIds',
    'limit',
    'ok',
    'primaryLaneHit',
    'query',
    'sessionId',
    'status',
    'ts',
    'usedLater',
    'usedLaterWhy',
  ]);

  assert.equal(e.ts, '2023-11-14T22:13:20.000Z', 'ts 是 now 的 ISO 串，手算值');
  assert.equal(e.at, FIXED_NOW);
  assert.equal(e.channel, 'tool');
  assert.equal(e.query, '铜版纸 名片 报价', 'clip：连续空白压成一个空格，首尾 trim');
  assert.equal(e.limit, 8);
  assert.equal(e.asOf, null);
  assert.equal(e.ok, true);
  assert.equal(e.code, null);
  assert.equal(e.hitCount, 2);
  assert.deepEqual(e.hitIds, ['mem-a', 'mem-b']);
  assert.equal(e.status, 'ok');
  assert.equal(e.primaryLaneHit, true);
  assert.equal(e.degraded, null);
  assert.equal(e.durationMs, 42);
  assert.equal(e.sessionId, 'sess-1');
  assert.equal(e.usedLater, null, 'usedLater 刻意留空（工具层看不到后续回答）');
  assert.equal(typeof e.usedLaterWhy, 'string');
  assert.ok(e.usedLaterWhy.length > 0, 'usedLater 留空必须带原因，别让人以为是漏做');

  // 缺省值也要被补齐成同一形状，而不是缺字段
  const second = read.entries[1];
  assert.deepEqual(Object.keys(second).sort(), Object.keys(e).sort());
  assert.equal(second.ts, new Date(FIXED_NOW + 1000).toISOString());
  assert.equal(second.channel, 'unknown', '没给 channel 时回落到 unknown');
  assert.equal(second.ok, true, 'ok 缺省视为成功');
  assert.equal(second.hitCount, 0);
  assert.deepEqual(second.hitIds, []);
  // 注意：second.durationMs / second.limit 在读回时会被 normalize 二次处理，
  // 从 null 漂成 0（Number(null)===0 的坑，见文件末尾「已知缺陷」测试与交付报告）。
  // 这里不把错误行为写成期望值，正确期望放在 todo 测试里等 apps 侧修复。
});

// ---------------------------------------------------------------------------
// 2. 目录不存在时自动建（含多级）
// ---------------------------------------------------------------------------
test('2. 目录不存在时 appendUsage 自动创建（多级目录）', (t) => {
  const dir = tempDir(t);
  const logPath = join(dir, 'a', 'b', 'c', 'usage.jsonl');

  assert.equal(existsSync(join(dir, 'a')), false, '前提：临时目录里还没这个子目录');

  const res = appendUsage(logPath, { query: '自动建目录', hitCount: 1 }, FIXED_NOW);
  assert.deepEqual(res, { ok: true });
  assert.equal(existsSync(join(dir, 'a', 'b', 'c')), true, '多级目录应被递归创建');
  assert.equal(existsSync(logPath), true);

  const lines = readFileSync(logPath, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1, '一次调用只追加一行');
  assert.doesNotThrow(() => JSON.parse(lines[0]));
});

// ---------------------------------------------------------------------------
// 3. logPath 非法：返回 ok:false，永不抛
// ---------------------------------------------------------------------------
test('3. logPath 非法时返回 { ok: false }，永不抛，只在 stderr 留一行线索', (t) => {
  const dir = tempDir(t);
  // 失败路径会 console.error —— 这里接管掉，避免测试输出被刷屏，同时数调用次数。
  const spy = t.mock.method(console, 'error', () => {});

  /** @type {Array<[string, any]>} */
  const cases = [
    ['空串', ''],
    ['null', null],
    ['undefined', undefined],
    ['数字', 42],
    // NUL 是跨平台的路径非法字符，Node 会抛 ERR_INVALID_ARG_VALUE
    ['含 NUL 字符的路径', join(dir, 'nul\0name.jsonl')],
  ];
  if (process.platform === 'win32') {
    // Windows 保留字符：appendFileSync 会抛 EINVAL
    cases.push(['Windows 保留字符 <', join(dir, 'bad<name>.jsonl')]);
  }

  for (const [label, badPath] of cases) {
    spy.mock.resetCalls();
    /** @type {{ ok: boolean, error?: string }} */
    let result = { ok: true };
    assert.doesNotThrow(
      () => {
        result = appendUsage(badPath, { query: 'q' }, FIXED_NOW);
      },
      `${label}：appendUsage 必须吞掉异常，绝不抛给检索主流程`,
    );
    assert.equal(result.ok, false, `${label}：应返回 ok:false`);
    assert.equal(typeof result.error, 'string', `${label}：要带 error 说明`);
    assert.ok(/** @type {string} */ (result.error).length > 0, `${label}：error 不能是空串`);
    assert.equal(spy.mock.callCount(), 1, `${label}：失败要恰好留一行 console.error 线索`);
  }
});

// ---------------------------------------------------------------------------
// 4. 坏行跳过并计数，好行照样读出
// ---------------------------------------------------------------------------
test('4. 坏行（半截 JSON / 非对象）被跳过并计数，空行直接忽略，好行照读', (t) => {
  const dir = tempDir(t);
  const logPath = join(dir, 'usage.jsonl');

  const good1 = JSON.stringify({ at: FIXED_NOW, query: '好行1', hitCount: 1 });
  const good2 = JSON.stringify({ at: FIXED_NOW + 1, query: '好行2', hitCount: 0 });
  const text = [
    good1,
    '{"at": 1700000000001, "query": "半截', // 半截 JSON → catch
    '', // 空行：不是坏行，continue 且不计数
    '   ', // 纯空白行：同上
    '[1,2,3]', // 数组 → 非对象
    '"just a string"', // 字符串 → 非对象
    '42', // 数字 → 非对象
    'null', // JSON.parse 得 null → 非对象
    good2,
  ].join('\n');

  const parsed = parseUsageLines(text);
  assert.equal(parsed.entries.length, 2, '两条好行都要读出来');
  assert.deepEqual(parsed.entries.map((e) => e.query), ['好行1', '好行2']);
  // 坏行 = 半截 JSON + 数组 + 字符串 + 数字 + null = 5；两个空行不计（模块语义：
  // 「空行不是坏数据」，skipped 只数解析失败/非对象的行）。
  assert.equal(parsed.skipped, 5);

  // readUsageLog 走同一套解析，口径必须一致
  writeFileSync(logPath, text + '\n', 'utf8');
  const read = readUsageLog(logPath);
  assert.equal(read.exists, true);
  assert.equal(read.total, 2);
  assert.equal(read.skipped, read.skipped);
  assert.equal(read.skipped, 5);
  assert.deepEqual(read.entries.map((e) => e.at), [FIXED_NOW, FIXED_NOW + 1]);

  // 全是坏行时也不能炸，只是 entries 为空
  writeFileSync(logPath, '坏行\n{不是JSON}\n[]\n', 'utf8');
  const onlyBad = readUsageLog(logPath);
  assert.deepEqual(onlyBad.entries, []);
  assert.equal(onlyBad.skipped, 3);
});

// ---------------------------------------------------------------------------
// 5. query 截断、hitIds 裁剪
// ---------------------------------------------------------------------------
test('5. query 超 200 字截成 200+…，hitIds 超 20 条被裁，边界值不误伤', (t) => {
  const logPath = join(tempDir(t), 'usage.jsonl');
  assert.equal(MAX_QUERY_CHARS, 200);
  assert.equal(MAX_HIT_IDS, 20);

  const longQuery = '甲'.repeat(250);
  const ids = Array.from({ length: 25 }, (_, i) => `mem-${i}`);
  const res = appendUsage(logPath, { query: longQuery, hitIds: ids, hitCount: 25 }, FIXED_NOW);
  assert.deepEqual(res, { ok: true });

  const e = readUsageLog(logPath).entries[0];
  assert.equal(e.query.length, 201, '200 字 + 一个省略号 = 201');
  assert.equal(e.query.slice(0, 200), '甲'.repeat(200), '保留的是前 200 字，不是后 200 字');
  assert.equal(e.query.slice(200), '…', '截断标记只能是结尾的一个 …');

  assert.equal(e.hitIds.length, 20, 'hitIds 最多留 20 条');
  assert.deepEqual(e.hitIds, ids.slice(0, 20), '保留的是最前面的 20 条（检索按相关度排序）');
  assert.equal(e.hitIds[0], 'mem-0');
  assert.equal(e.hitIds[19], 'mem-19');
  assert.equal(e.hitIds.includes('mem-20'), false);

  // 边界：恰好 200 字不截断、恰好 20 条不裁剪
  const exactPath = join(tempDir(t), 'exact.jsonl');
  const exactIds = Array.from({ length: 20 }, (_, i) => `id-${i}`);
  appendUsage(exactPath, { query: '乙'.repeat(200), hitIds: exactIds }, FIXED_NOW);
  const exact = readUsageLog(exactPath).entries[0];
  assert.equal(exact.query, '乙'.repeat(200), '恰好 200 字必须原样保留，不加省略号');
  assert.equal(exact.query.endsWith('…'), false);
  assert.equal(exact.hitIds.length, 20, '恰好 20 条必须全部保留');

  // hitIds 里的非字符串/空串被过滤掉（宁可少记，不记脏数据）
  const dirtyPath = join(tempDir(t), 'dirty.jsonl');
  appendUsage(dirtyPath, { query: 'q', hitIds: ['a', '', 42, null, 'b'] }, FIXED_NOW);
  assert.deepEqual(readUsageLog(dirtyPath).entries[0].hitIds, ['a', 'b']);
});

// ---------------------------------------------------------------------------
// 6. 文件不存在 → exists:false，空结果，不抛
// ---------------------------------------------------------------------------
test('6. readUsageLog 文件不存在时返回 exists:false 与空数组，不抛', (t) => {
  const dir = tempDir(t);
  const logPath = join(dir, 'nope', 'usage.jsonl');

  /** @type {any} */
  let read;
  assert.doesNotThrow(() => {
    read = readUsageLog(logPath);
  }, '「还没人查过」不是错误，不能抛');
  assert.equal(read.exists, false);
  assert.deepEqual(read.entries, []);
  assert.equal(read.total, 0);
  assert.equal(read.skipped, 0);
  assert.equal(read.truncated, false);
  assert.equal(read.logPath, logPath, '空结果也要回显查的是哪个文件');

  // 非法 logPath 同样安全返回空结果
  for (const bad of ['', null, 42, join(dir, 'nul\0name.jsonl')]) {
    /** @type {any} */
    let r;
    assert.doesNotThrow(() => {
      r = readUsageLog(/** @type {any} */ (bad));
    }, `非法 logPath ${String(bad)} 不该抛`);
    assert.equal(r.exists, false);
    assert.deepEqual(r.entries, []);
  }

  // 路径存在但是目录（不是文件）→ 也走空结果
  const asDir = join(dir, 'a-directory');
  mkdirSync(asDir);
  const dirRead = readUsageLog(asDir);
  assert.equal(dirRead.exists, false, '目录不是日志文件');
  assert.deepEqual(dirRead.entries, []);
});

// ---------------------------------------------------------------------------
// 7. since 过滤（闭区间）+ limit 取尾部 N 条
// ---------------------------------------------------------------------------
test('7. since 为闭区间过滤，limit 取尾部 N 条，total 是 limit 之前的条数', (t) => {
  const logPath = join(tempDir(t), 'usage.jsonl');
  const ats = [1000, 2000, 3000, 4000, 5000];
  for (const at of ats) {
    appendUsage(logPath, { at, query: `q${at}`, hitCount: 1 }, FIXED_NOW);
  }

  const all = readUsageLog(logPath);
  assert.equal(all.total, 5);
  assert.deepEqual(all.entries.map((e) => e.at), ats, '读回顺序 = 文件追加顺序');

  const since = readUsageLog(logPath, { since: 3000 });
  assert.deepEqual(since.entries.map((e) => e.at), [3000, 4000, 5000], 'since=3000 要包含 at=3000（闭区间）');
  assert.equal(since.total, 3);

  const limited = readUsageLog(logPath, { limit: 2 });
  assert.deepEqual(limited.entries.map((e) => e.at), [4000, 5000], 'limit 取最新的尾部 N 条');
  assert.equal(limited.total, 5, 'total 统计 limit 截断前的条数');

  const both = readUsageLog(logPath, { since: 2000, limit: 2 });
  assert.equal(both.total, 4, 'since 过滤后 4 条');
  assert.deepEqual(both.entries.map((e) => e.at), [4000, 5000], '先 since 再取尾部 2 条');

  const noLimit = readUsageLog(logPath, { limit: 0 });
  assert.equal(noLimit.entries.length, 5, 'limit<=0 视为不限制（不能读成空）');
  assert.equal(noLimit.total, 5);
});

// ---------------------------------------------------------------------------
// 8. 窗口外记录被排除
// ---------------------------------------------------------------------------
test('8. summarizeUsage 排除窗口外记录，窗口边界按闭区间计入', () => {
  assert.equal(DEFAULT_WINDOW_DAYS, 7);
  const now = Date.UTC(2026, 4, 20, 12, 0, 0); // 2026-05-20T12:00:00Z
  const since7 = now - 7 * DAY;

  const raw = [
    { at: now, query: '窗口内-现在', hitCount: 1, channel: 'tool', ok: true, status: 'ok' },
    { at: now - DAY, query: '窗口内-昨天', hitCount: 0, channel: 'tool', ok: true, status: 'ok' },
    { at: since7, query: '窗口边界-整7天前', hitCount: 1, channel: 'console', ok: true, status: 'ok' },
    { at: since7 - 1, query: '窗口外-差1ms', hitCount: 1, channel: 'tool', ok: true, status: 'ok' },
    { at: since7 - 8 * DAY, query: '窗口外-15天前', hitCount: 1, channel: 'tool', ok: true, status: 'ok' },
    { at: now - 40 * DAY, query: '窗口外-40天前', hitCount: 1, channel: 'tool', ok: true, status: 'ok' },
  ];
  const entries = raw.map((r) => normalizeUsageEntry(r, now));

  const s = summarizeUsage(entries, { now });
  assert.equal(s.windowDays, 7);
  assert.equal(s.since, since7);
  assert.equal(s.total, 3, '只有 now / 昨天 / 边界整7天前 三条在窗口内');
  assert.equal(s.hitCount, 2);
  assert.equal(s.zeroHitCount, 1);
  assert.equal(s.lastAt, now);
  assert.deepEqual(s.byChannel, { tool: 2, console: 1 }, '窗口外的 tool 记录不能混进来');
  assert.deepEqual(entries.map((e) => e.query), raw.map((r) => r.query), 'summarizeUsage 是纯函数，不改入参');

  // windowDays 显式放大后，15 天前 / 7天前-1ms 的两条进来，40 天前仍在外
  const wide = summarizeUsage(entries, { now, windowDays: 30 });
  assert.equal(wide.windowDays, 30);
  assert.equal(wide.since, now - 30 * DAY);
  assert.equal(wide.total, 5, '30 天窗口内共 5 条（40 天前那条仍被排除）');

  // 非法 windowDays 回落到默认 7 天
  for (const bad of [0, -1, NaN, undefined]) {
    assert.equal(
      summarizeUsage(entries, { now, windowDays: /** @type {any} */ (bad) }).windowDays,
      7,
      `windowDays=${String(bad)} 应回落到默认 7 天`,
    );
  }
});

// ---------------------------------------------------------------------------
// 9. hitRate / zeroHitCount / laneMissRate / degradedRate 手算
// ---------------------------------------------------------------------------
test('9. hitRate/callHitRate/zeroHitCount/laneMissRate/degradedRate 按「只统计跑完的检索」口径手算', () => {
  const now = FIXED_NOW;
  // 样本（口径：检索失败只进 failCount，不进命中/零命中；比率分母是 okCount）：
  //   #  ok     query      hit  primaryLane  degraded            status
  //   1  true   命中词      3   true         null                ok
  //   2  true   零命中词    0   false        fts-empty→trigram   weak-hit
  //   3  true   零命中词    0   true         null                ok
  //   4  false  故障词      2   null         timeout             error
  const raw = [
    { at: now, query: '命中词', channel: 'tool', status: 'ok', ok: true, hitCount: 3, primaryLaneHit: true, degraded: null },
    { at: now - 1000, query: '零命中词', channel: 'tool', status: 'weak-hit', ok: true, hitCount: 0, primaryLaneHit: false, degraded: 'fts-empty→trigram' },
    { at: now - 2000, query: '零命中词', channel: 'tool', status: 'ok', ok: true, hitCount: 0, primaryLaneHit: true, degraded: null },
    // 失败检索：即使带着 hitCount: 2 也不能算命中（这就是被修掉的旧 bug）
    { at: now - 3000, query: '故障词', channel: 'console', status: 'error', ok: false, hitCount: 2, primaryLaneHit: null, degraded: 'timeout' },
  ];
  const s = summarizeUsage(raw.map((r) => normalizeUsageEntry(r, now)), { now });

  assert.equal(s.total, 4);
  assert.equal(s.okCount, 3, '跑完的检索 3 条');
  assert.equal(s.failCount, 1, '失败检索 1 条');
  assert.equal(s.hitCount, 1, '失败记录即使带着 hitCount: 2 也不算命中');
  assert.equal(s.zeroHitCount, 2, '零命中只数「跑完且真没命中」的 #2 #3');
  assert.equal(s.hitRate, 0.333, 'hitRate 分母是 okCount：1/3 = 0.3333… → 0.333');
  assert.equal(s.callHitRate, 0.25, 'callHitRate 分母是 total（含失败）：1/4 = 0.25');
  assert.equal(s.laneMissCount, 1, '只有 #2 是「成功且 primaryLaneHit=false」');
  assert.equal(s.laneMissRate, 0.333, '1/3 = 0.333（分母 okCount）');
  assert.equal(s.degradedCount, 2, '#2 弱路降级 + #4 超时降级；失败检索的降级也要算进去');
  assert.equal(s.degradedRate, 0.667, '2/3 = 0.6666… → 0.667（分母 okCount）');
  assert.deepEqual(s.byChannel, { tool: 3, console: 1 });
  assert.deepEqual(s.byStatus, { ok: 2, 'weak-hit': 1, error: 1 });

  // 零命中榜只收「查过、跑完、真没命中」的词；失败过的词是故障线索，不进语料缺口榜
  assert.deepEqual(
    s.zeroHitQueries,
    [{ query: '零命中词', count: 2, failed: 0, lastAt: now - 1000 }],
    '「故障词」okCount=0 必须排除；count 等于成功次数',
  );
  assert.equal(s.zeroHitQueries.some((q) => q.query === '故障词'), false);

  // topQueries 新增 failed 字段：失败既不算命中也不算零命中
  assert.deepEqual(s.topQueries.find((q) => q.query === '故障词'), {
    query: '故障词',
    count: 1,
    hits: 0,
    zero: 0,
    failed: 1,
    lastAt: now - 3000,
  });
  assert.deepEqual(s.topQueries.find((q) => q.query === '零命中词'), {
    query: '零命中词',
    count: 2,
    hits: 0,
    zero: 2,
    failed: 0,
    lastAt: now - 1000,
  });

  // 非整除比率要四舍五入到 3 位小数：3/7 = 0.428571… → 0.429
  const seven = Array.from({ length: 7 }, (_, i) => ({
    at: now,
    channel: 'tool',
    status: 'ok',
    ok: true,
    hitCount: i < 3 ? 1 : 0,
  }));
  const s7 = summarizeUsage(seven.map((r) => normalizeUsageEntry(r, now)), { now });
  assert.equal(s7.total, 7);
  assert.equal(s7.okCount, 7);
  assert.equal(s7.hitCount, 3);
  assert.equal(s7.hitRate, 0.429, '3/7 = 0.428571… 四舍五入到 3 位小数');
  assert.equal(s7.callHitRate, 0.429, '没有失败记录时两个口径应当相同');

  // 空样本：所有比率是 null（不是 0 —— 「没有数据」和「命中率为 0」必须能区分开）
  const empty = summarizeUsage([], { now });
  assert.equal(empty.total, 0);
  assert.equal(empty.okCount, 0);
  assert.equal(empty.hitRate, null);
  assert.equal(empty.callHitRate, null);
  assert.equal(empty.laneMissRate, null);
  assert.equal(empty.degradedRate, null);
  assert.equal(empty.lastAt, null);
  assert.deepEqual(empty.byChannel, {});
  assert.deepEqual(empty.byDay, []);
  assert.deepEqual(empty.zeroHitQueries, []);
  assert.equal(empty.touchedCount, 0);
});

// ---------------------------------------------------------------------------
// 10. byDay 用本地日期分组（不是 UTC）
// ---------------------------------------------------------------------------
test('10. byDay 按本地日期分组，跨本地午夜分成两天（不是 UTC）', () => {
  // 三个点全部落在本机时区的 2026-05-10 / 2026-05-11 上：
  //   05-10 12:00 本地、05-10 23:30 本地、05-11 00:30 本地。
  // 用本地构造器取时间戳，所以期望的日期键就是「我给的本地日期」。
  const day1Noon = new Date(2026, 4, 10, 12, 0, 0, 0).getTime();
  const day1Late = new Date(2026, 4, 10, 23, 30, 0, 0).getTime();
  const day2Early = new Date(2026, 4, 11, 0, 30, 0, 0).getTime();
  const now = new Date(2026, 4, 11, 12, 0, 0, 0).getTime();

  // 故意乱序喂入，验证输出仍按日期升序
  const raw = [
    { at: day2Early, query: '午夜后', hitCount: 1 },
    { at: day1Noon, query: '正午', hitCount: 0 },
    { at: day1Late, query: '午夜前', hitCount: 1 },
  ];
  const s = summarizeUsage(raw.map((r) => normalizeUsageEntry(r, now)), { now, windowDays: 7 });

  assert.deepEqual(
    s.byDay,
    [
      // 每行含 okCount/failed（新口径）：失败检索只进 failed，不进 hits/zero
      { date: '2026-05-10', count: 2, okCount: 2, hits: 1, zero: 1, failed: 0 },
      { date: '2026-05-11', count: 1, okCount: 1, hits: 1, zero: 0, failed: 0 },
    ],
    '本地日期必须是 05-10 / 05-11 两天，且升序',
  );

  // 区分力自查：本机不在 UTC 时，模拟「按 UTC 分组」的实现在这三个样本上必然给出不同结果
  // （UTC+8 并成一天、UTC-8 count 分布反过来）。相等就说明样本选得没区分力，必须换。
  if (new Date(day1Noon).getTimezoneOffset() !== 0) {
    /** @type {Map<string, { date: string, count: number, hits: number, zero: number }>} */
    const utcGrouped = new Map();
    for (const [at, hits] of /** @type {Array<[number, number]>} */ ([
      [day2Early, 1],
      [day1Noon, 0],
      [day1Late, 1],
    ])) {
      const key = new Date(at).toISOString().slice(0, 10);
      const cur = utcGrouped.get(key) || { date: key, count: 0, hits: 0, zero: 0 };
      cur.count += 1;
      if (hits > 0) cur.hits += 1;
      else cur.zero += 1;
      utcGrouped.set(key, cur);
    }
    const utcByDay = [...utcGrouped.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
    assert.notDeepEqual(
      utcByDay,
      s.byDay,
      '若这里相等，说明这组样本区分不出本地/UTC，必须换样本再测',
    );
  }
});

// ---------------------------------------------------------------------------
// 11. timing 的 p50 / p95 / max
// ---------------------------------------------------------------------------
test('11. timing 的 p50/p95/max/avg 在已知样本下手算正确', () => {
  const now = FIXED_NOW;
  const make = (durations) =>
    summarizeUsage(
      durations.map((durationMs) => normalizeUsageEntry({ at: now, hitCount: 1, durationMs }, now)),
      { now },
    );

  // 样本 A：[10,20,30,40,50]（乱序喂入）。n=5，下标 = round((n-1)*q)，且夹在 [0, n-1]。
  //   p50: round(4*0.50) = round(2.0) = 2 → sorted[2] = 30
  //   p95: round(4*0.95) = round(3.8) = 4 → sorted[4] = 50
  //   max = 50，avg = 150/5 = 30，samples = 5
  const a = make([30, 10, 50, 20, 40]);
  assert.deepEqual(a.timing, { avg: 30, p50: 30, p95: 50, max: 50, samples: 5 });

  // 样本 B：[1..10]（乱序）。n=10。
  //   p50: round(9*0.50) = round(4.5) = 5 → sorted[5] = 6（Math.round 的半值向上）
  //   p95: round(9*0.95) = round(8.55) = 9 → sorted[9] = 10
  //   max = 10，avg = 55/10 = 5.5，samples = 10
  const b = make([7, 3, 10, 1, 5, 9, 2, 8, 4, 6]);
  assert.deepEqual(b.timing, { avg: 5.5, p50: 6, p95: 10, max: 10, samples: 10 });

  // 样本 C：[5, 10]。n=2。
  //   p50: round(1*0.5) = round(0.5) = 1 → sorted[1] = 10
  //   p95: round(1*0.95) = round(0.95) = 1 → sorted[1] = 10
  //   avg = 7.5（保留 1 位小数）
  const c = make([5, 10]);
  assert.deepEqual(c.timing, { avg: 7.5, p50: 10, p95: 10, max: 10, samples: 2 });

  // 没有耗时样本时全部 null（不是 0）
  const none = summarizeUsage([], { now });
  assert.deepEqual(none.timing, { avg: null, p50: null, p95: null, max: null, samples: 0 });
});

// ---------------------------------------------------------------------------
// 12. computeCoverage
// ---------------------------------------------------------------------------
test('12. computeCoverage：计数、neverHitSamples 按 importance 降序、缺字段不炸', () => {
  /** @type {any[]} */
  const catalog = [
    { id: 'm-a', summary: '低重要度', type: 'fact', importance: 0.2 }, // 已命中，排除
    { id: 'm-b', summary: '高重要度', type: 'decision', importance: 0.9 },
    { id: 'm-c', summary: '中重要度', type: 'preference', importance: 0.5 },
    null, // 坏项：不能炸
    {}, // 缺 id：不能进候选
    { id: 123, importance: 0.99 }, // id 非字符串：不能进候选
    { id: 'm-d', summary: null, type: null, importance: null }, // 字段缺省
  ];

  const result = computeCoverage(
    {
      totalMemories: 5,
      // 重复的 touched 只算一次；**不在 catalog 里的命中 id 不计入分子**（2026-10-30 语义修正）。
      // 它是幽灵 id：删过 / 已封口（superseded）/ 换过 scope。占分子不占分母会让覆盖率虚高、
      // 同时把「从没被查到」压低——观察期就是拿这张榜判断语料缺口的，不能掺进查不到的 id。
      // 差出来的数量进 staleTouched，不藏起来。
      touchedIds: ['m-a', 'm-a', 'x-not-in-catalog'],
      catalog,
    },
    { sampleLimit: 10 },
  );

  assert.equal(result.totalMemories, 5);
  assert.equal(result.touched, 1, '去重后只剩 catalog 内的 m-a（幽灵 id 不进分子）');
  assert.equal(result.staleTouched, 1, 'x-not-in-catalog 归入 stale，口径要能自查');
  assert.equal(result.neverHit, 4, '5 - 1 = 4');
  assert.equal(result.touchedRate, 0.2, '1/5 = 0.2');
  assert.deepEqual(result.neverHitSamples, [
    { memoryId: 'm-b', summary: '高重要度', type: 'decision', importance: 0.9 },
    { memoryId: 'm-c', summary: '中重要度', type: 'preference', importance: 0.5 },
    // 缺 importance 必须是 null：「未知」≠「0 分重要度」。
    // 旧实现用 Number(null)===0 会写成 0，正是 14 号回归测试盯着的同一个坑。
    { memoryId: 'm-d', summary: null, type: null, importance: null },
  ]);

  // sampleLimit 截断：只留重要度最高的 N 条
  const limited = computeCoverage(
    { totalMemories: 5, touchedIds: ['m-a', 'x-not-in-catalog'], catalog },
    { sampleLimit: 2 },
  );
  assert.deepEqual(limited.neverHitSamples.map((m) => m.memoryId), ['m-b', 'm-c']);

  // 缺字段的入参也不能炸（totalMemories 是字符串、touchedIds/catalog 为 null）
  assert.deepEqual(
    computeCoverage(/** @type {any} */ ({ totalMemories: '3', touchedIds: null, catalog: null })),
    { totalMemories: 3, touched: 0, staleTouched: 0, neverHit: 3, touchedRate: 0, neverHitSamples: [] },
  );

  // totalMemories = 0 时比率是 null（没有分母），neverHit 不能算成负数。
  // 此时 catalog 为空 → 两个 touched id 都成幽灵（stale=2），分子必须是 0：
  // 「全库 0 条却查到过 2 条」是自相矛盾的读数，宁可把它标成 stale。
  assert.deepEqual(computeCoverage({ totalMemories: 0, touchedIds: ['a', 'b'], catalog: [] }), {
    totalMemories: 0,
    touched: 0,
    staleTouched: 2,
    neverHit: 0,
    touchedRate: null,
    neverHitSamples: [],
  });
});

// ---------------------------------------------------------------------------
// 额外加固：超过 maxBytes 时只读尾部，半截首行被丢弃且不误计 skipped
// ---------------------------------------------------------------------------
test('额外：超过 maxBytes 只读尾部，被切掉的半截首行不计入 skipped', (t) => {
  const logPath = join(tempDir(t), 'usage.jsonl');
  assert.equal(MAX_READ_BYTES, 16 * 1024 * 1024);
  assert.equal(MAX_READ_BYTES, 16777216);

  // 每行等长：at 固定 4 位、query 固定 2 字符，方便按字节精确切
  const lines = [];
  for (let i = 0; i < 10; i += 1) {
    lines.push(JSON.stringify({ at: 1000 + i, query: `q${i}` }));
  }
  writeFileSync(logPath, lines.join('\n') + '\n', 'utf8');

  const perLine = Buffer.byteLength(`${lines[0]}\n`, 'utf8');
  for (const line of lines) {
    assert.equal(Buffer.byteLength(`${line}\n`, 'utf8'), perLine, '样本必须每行等长');
  }

  // 尾部只留 2 行 - 3 字节 → 首行是半截，应被丢弃，只剩最后一行完整记录
  const tail = readUsageLog(logPath, { maxBytes: perLine * 2 - 3 });
  assert.equal(tail.truncated, true);
  assert.equal(tail.total, 1, '尾部只剩最后一行完整记录');
  assert.equal(tail.entries[0].query, 'q9');
  assert.equal(tail.skipped, 0, '被切掉的半截首行不是坏数据，不能算 skipped');

  // 不触发截断时 10 条都在
  const full = readUsageLog(logPath, { maxBytes: MAX_READ_BYTES });
  assert.equal(full.truncated, false);
  assert.equal(full.total, 10);
});

// ---------------------------------------------------------------------------
// 14. 回归：缺省字段必须归一为 null，且 normalize 在「写盘 → 读回」后保持幂等
//
// 历史 bug：旧实现用 `Number.isFinite(Number(v))` 判断，而 Number(null) === 0，
// 于是「没提供」被当成 0 —— appendUsage 写盘时 durationMs/limit 是 null，
// readUsageLog 读回再 normalize 后变成 0；summarizeUsage 又把 0ms 当真实耗时，
// 让「没有耗时数据」的记录以 0ms 混进 p50/p95/avg。
// 修法（apps/brain-tools/usage-log.js 的 toNumber）：value == null || value === '' 先返回 null。
// 这条测试盯两个性质：① 缺省字段是 null（不是 0）；② normalize 幂等，读回不再漂。
// ---------------------------------------------------------------------------
test('14. 缺省字段归一为 null，normalize 写盘→读回后保持幂等（回归）', (t) => {
  const logPath = join(tempDir(t), 'usage.jsonl');

  const once = normalizeUsageEntry({ query: '缺省字段' }, FIXED_NOW);
  assert.equal(once.ts, '2023-11-14T22:13:20.000Z');
  assert.equal(once.at, FIXED_NOW, 'at 缺省回落到 now');
  assert.equal(once.hitCount, 0, 'hitCount 缺省回落到 0');
  assert.equal(once.durationMs, null, '没给耗时就是 null，不是 0');
  assert.equal(once.limit, null, '没给 limit 就是 null，不是 0');

  // 幂等：normalize(normalize(x)) 必须与 normalize(x) 深等
  assert.deepEqual(normalizeUsageEntry(once, FIXED_NOW), once, 'normalize 必须幂等');

  // 写盘 → 读回：字段一个都不能漂（这是最初 bug 的现场）
  appendUsage(logPath, { query: '缺省字段' }, FIXED_NOW);
  const after = readUsageLog(logPath).entries[0];
  assert.deepEqual(after, once, '读回的记录必须与写入时同形');
  assert.equal(after.durationMs, null, '读回不该把「没有耗时」变成 0ms');
  assert.equal(after.limit, null, '读回不该把「没给 limit」变成 0');

  // 污染已消除：没有耗时数据 → timing 全 null、samples 0（不是一串 0ms）
  assert.deepEqual(
    summarizeUsage([after], { now: FIXED_NOW }).timing,
    { avg: null, p50: null, p95: null, max: null, samples: 0 },
    '缺耗时数据不能以 0ms 参与分位数',
  );

  // 同源：computeCoverage 的缺省 importance 也必须是 null，不能写成「0 分重要度」
  const cover = computeCoverage({ totalMemories: 1, touchedIds: [], catalog: [{ id: 'm-x' }] });
  assert.equal(cover.neverHitSamples[0].importance, null, '缺省 importance 是未知，不是 0 分');

  // 正常数值路径不能被 toNumber 改坏：0 仍是 0，字符串数字仍能收成 number
  const zero = normalizeUsageEntry({ query: 'q', hitCount: 0, durationMs: 0, limit: 0 }, FIXED_NOW);
  assert.equal(zero.hitCount, 0, '真的 0 命中要保留 0');
  assert.equal(zero.durationMs, 0, '真的 0ms 要保留 0，不能变成 null');
  assert.equal(zero.limit, 0, '显式 limit:0 要保留 0');
  const numericString = normalizeUsageEntry({ query: 'q', durationMs: '37', limit: '12' }, FIXED_NOW);
  assert.equal(numericString.durationMs, 37, '数字字符串照旧收成 number');
  assert.equal(numericString.limit, 12);
});
