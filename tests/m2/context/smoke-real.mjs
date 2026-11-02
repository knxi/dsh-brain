// @ts-check
/**
 * 真实联调 smoke —— **不是契约测试**，不在 `node --test "tests/m2/context/*.test.mjs"` 里跑。
 *
 * 目的：用真实主账 + 真实 `memories.search()` 跑一遍 `build()`，核对契约测试里
 * mock 的形状与真实返回的差异（mock 按 M2-INTERFACES §1.2，真实实现在
 * `packages/memory/src/memories.js`）。
 *
 * 用法：`node tests/m2/context/smoke-real.mjs`
 * 只用临时库 + 合成语料（CONTRACTS §12：不碰真实私密历史）。
 *
 * 两处**术语必须分清**，别把它们混成一个数字：
 * - 索引文档数：`SELECT count(*) FROM search_fts_char` 等 → 索引里到底有多少文档。
 * - 检索路由候选数：`search().diagnostics.routes.<route>.count` → **这一次查询**该路
 *   命中几个候选。它可以是 0 而索引是满的（查询词覆盖不足 / 该路不命中），
 *   这不叫「索引没通电」。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrain } from '../../../packages/memory/src/index.js';
import {
  build,
  markAttached,
  markSent,
  verifyCanonicalHash,
} from '../../../packages/context/src/index.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));
const SCOPE_ID = 'owner-default';
const PERSON_ID = 'owner';

/** 合成语料：尺寸 / 材质 / 图号 / 报价 / 英文工具名与代码标识符（CONTRACTS §6 合成数据纪律）。 */
const DRAFTS = [
  {
    content: '展板成品尺寸 1.2m × 2.4m，出图按 1200mm × 2400mm 标注，出血各留 3mm。',
    summary: '展板 1.2m×2.4m 出图按 1200×2400mm，出血 3mm',
    layer: 'long',
    type: 'semantic',
    sourceType: 'owner_words',
  },
  {
    content: '建施-03 那张图的铝板厚度写的是 3mm，实际报价要按 25 元/平方算，别按 1.5mm 那种。',
    summary: '建施-03 铝板 3mm，报价 25 元/平方',
    layer: 'long',
    type: 'commitment',
    sourceType: 'owner_words',
  },
  {
    content: 'build() 的 canonicalHash 用 @dsh-brain/core 的 canonicalize，别自己写一套 JSON 序列化。',
    summary: 'canonicalHash 复用 core 的 canonicalize',
    layer: 'long',
    type: 'skill',
    sourceType: 'owner_words',
  },
  {
    // 故意不传 summary → 验证检索层的 deriveSummary 兜底（SUMMARY_FALLBACK_CHARS = 40）
    content:
      '名片用 300g 铜版纸，成品 90×54mm，四周出血各 1mm。这一条故意不给 summary，' +
      '用来验证 memories.search() 的兜底摘要会不会生效。',
    layer: 'long',
    type: 'semantic',
    sourceType: 'owner_words',
  },
];

const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m2-context-smoke-'));
const dbPath = path.join(dir, 'brain.db');
/** @type {Awaited<ReturnType<typeof openBrain>>|null} */
let brain = null;

try {
  brain = openBrain({ dbPath, migrationsDir: MIGRATIONS_DIR });
  /** @type {string[]} */
  const createdIds = [];
  for (const draft of DRAFTS) {
    const created = await brain.memories.create({
      ...draft,
      scopeId: SCOPE_ID,
      personId: PERSON_ID,
      confidence: 1,
      importance: 0.7,
      privacy: 'private',
      originSystem: 'dsh',
      producer: 'm2-context-smoke',
    });
    createdIds.push(created.id);
    await brain.sources.link(created.id, {
      sourceSystem: 'dsh',
      sourceEventId: `smoke-${created.id}`,
      locator: `events/smoke/${created.id}`,
      contentHash: `sha256:${'a'.repeat(64)}`,
    });
  }
  const indexed = await brain.memories.reindexAll();
  console.log('[smoke] 建库路径 =', brain.dbPath);
  console.log('[smoke] 索引：', indexed);

  // ---- 自查 A：索引文档数（写入之后统计）----
  /** @param {string} table */
  const countOf = (table) => Number(brain.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0);
  const tableCounts = {
    memories: countOf('memories'),
    search_fts_char: countOf('search_fts_char'),
    search_fts_trigram: countOf('search_fts_trigram'),
    search_ngram: countOf('search_ngram'),
  };
  console.log('[smoke] 索引文档数（不是查询候选数）=', tableCounts);
  if (
    tableCounts.search_fts_char !== tableCounts.memories ||
    tableCounts.search_fts_trigram !== tableCounts.memories
  ) {
    console.error('[smoke] ✖ 索引表行数与 memories 行数不一致：主路/补充路可能没通电');
    process.exitCode = 3;
  }

  // ---- 自查 B：检索路由候选数（本次查询该路命中几个）----
  // `展板成品尺寸 铝板厚度` 是专门用来验证「段内 phrase、段间 OR」的：
  // 两段各自在本库里连续出现，但整串原查询主路 0 命中 → 应该触发 routes.segmented。
  for (const query of ['展板尺寸 铝板报价', '展板成品尺寸 铝板厚度', '展板', '铜版纸 名片']) {
    const result = await brain.memories.search({ query, scopeId: SCOPE_ID, personId: PERSON_ID, limit: 10 });
    console.log(
      `[smoke] search(${query}) status=${result.diagnostics.status} hits=${result.hits.length} ` +
        `primaryLaneHit=${String(result.diagnostics.primaryLaneHit)} ` +
        `routes=${JSON.stringify(result.diagnostics.routes)}`,
    );
  }
  console.log('[smoke] 注：routes.*.count 是「本次查询该路候选数」，与上面的索引文档数不是一回事');

  // ---- 自查 C：summary 兜底（memory2 的 deriveSummary，40 字符 + …）----
  const noSummaryId = createdIds[3];
  const fallbackProbe = await brain.memories.search({
    query: '铜版纸 名片 300g',
    scopeId: SCOPE_ID,
    personId: PERSON_ID,
    limit: 10,
  });
  const fallbackHit = fallbackProbe.hits.find((hit) => hit.memoryId === noSummaryId);
  console.log(
    '[smoke] 无 summary 记忆的兜底摘要 =',
    fallbackHit ? JSON.stringify(fallbackHit.summary) : '（本次查询未命中该条）',
  );
  for (const hit of fallbackProbe.hits) {
    if (hit.summary === null || hit.summary === '') {
      console.error('[smoke] ✖ 命中 summary 为空：', hit.memoryId);
      process.exitCode = 4;
    }
  }

  // ---- 主链路：真实检索 → build → attached → sent ----
  const pkg = await build({
    store: brain,
    query: '展板尺寸 铝板报价 建施-03',
    scopeId: SCOPE_ID,
    personId: PERSON_ID,
    sessionId: 'sess-smoke-1',
    turnId: 'turn-1',
    stepId: 'step-1',
    budget: { modelWindow: 32000, hostInputTokens: 1000, outputReserve: 4096 },
    now: () => new Date('2026-10-28T10:00:00.000Z'),
  });

  console.log('[smoke] build ->', {
    status: pkg.status,
    diagnostics: pkg.diagnostics,
    segments: pkg.segments.map((seg) => `${seg.memoryId}@v${seg.version}(${seg.score})`),
    dropped: pkg.budget.dropped,
    brainAllowance: pkg.budget.brainAllowance,
    used: pkg.budget.used,
    estimatedTokens: pkg.estimatedTokens,
    tokenizerId: pkg.tokenizerId,
    hashVerified: verifyCanonicalHash(pkg),
  });
  console.log('[smoke] injectedText ----------\n' + pkg.injectedText + '\n----------------------------');

  const attached = markAttached(pkg, { carrier: 'messages[role=system]', turn: 'turn-1', step: 'step-1' });
  const sent = markSent(attached, { carrier: 'messages[role=system]' });
  console.log('[smoke] 状态链 =', `${pkg.status} -> ${attached.status} -> ${sent.status}`);

  // ---- smoke 自己的护栏（不是契约测试）----
  if (pkg.segments.length === 0) {
    console.error('[smoke] ✖ 真实检索下没有任何段通过构包过滤');
    process.exitCode = 2;
  }
  for (const seg of pkg.segments) {
    if (typeof seg.summary !== 'string' || seg.summary.length === 0) {
      console.error('[smoke] ✖ 注入段摘要为空：', seg.memoryId);
      process.exitCode = 2;
    }
  }
  if (pkg.estimatedTokens > pkg.budget.brainAllowance) {
    console.error('[smoke] ✖ 估算 Token 超预算');
    process.exitCode = 2;
  }
  if (!verifyCanonicalHash(pkg)) {
    console.error('[smoke] ✖ canonicalHash 复核失败');
    process.exitCode = 2;
  }
} finally {
  if (brain !== null) {
    try {
      await brain.close();
    } catch {
      /* 清理失败不影响 smoke 结论 */
    }
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟释放 */
  }
}
