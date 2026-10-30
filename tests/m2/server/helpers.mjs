// @ts-check
/**
 * M2-D（server + console）测试公共工具。
 *
 * 纪律：
 * - 只用 `mkdtemp` 下的临时主账，**不碰** `data/brain.db`；
 * - 合成语料覆盖主人的真实工作语境（尺寸 / 材质 / 图号 / 报价 / 英文标识符），
 *   不引用任何真实私密历史（CONTRACTS §12 第 5 条）；
 * - 造数据用直接 SQL（memory2 的门面还在并行开发，测试不能等它）。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBrain } from '../../../packages/memory/src/index.js';
import { silentLogger } from '../../../apps/server/src/log.mjs';
import { startServer } from '../../../apps/server/src/server.mjs';

export { assert };

export const MIGRATIONS_DIR = fileURLToPath(new URL('../../../migrations/', import.meta.url));

/** 固定测试凭据：32+ 字符、不像占位符（避免被 assertTokenShape 拒掉）。 */
export const TEST_TOKEN = 'q7Zm3xK9vT2pL8wR4yN6bV1cX5aZ0sDfGhJkMnPqStUvWxYzAbCdEfG';

/** 合成语料：主人真实工作语境，但全部是假数据。 */
export const CORPUS = Object.freeze([
  {
    id: 'mem-ceiling-1200',
    summary: '客厅吊顶标高 1.2m，走石膏板叠级，灯槽留 1200mm',
    content: '客厅吊顶标高处 1.2m，走 9.5mm 纸面石膏板叠级，灯槽净宽 1200mm，收口用 2400×600 成品线条。',
    layer: 'long',
    type: 'semantic',
    sourceType: 'owner_words',
    confidence: 0.9,
    importance: 0.8,
  },
  {
    id: 'mem-drawing-jianshi-03',
    summary: '图号 建施-03 的窗台高度 900mm，与 2400×600 石材对缝',
    content: '图纸 建施-03 的窗台高度是 900mm，石材板 2400×600 铺贴时按缝对齐，不许现场随意裁。',
    layer: 'long',
    type: 'semantic',
    sourceType: 'observation',
    confidence: 0.75,
    importance: 0.7,
  },
  {
    id: 'mem-partition-price',
    summary: '轻钢龙骨 75 系隔墙报价 128 元/㎡',
    content: '轻钢龙骨隔墙用 75 系，双面双层 9.5mm 纸面石膏板，含人工报价 128 元/㎡，不含腻子乳胶漆。',
    layer: 'fragment',
    type: 'episode',
    sourceType: 'owner_words',
    confidence: 0.85,
    importance: 0.6,
  },
  {
    id: 'mem-no-source',
    summary: '客户说下周一要出图（无来源）',
    content: '客户说下周一要出全套施工图，现在还不知道真假，先记一笔。',
    layer: 'fragment',
    type: 'episode',
    sourceType: 'inference',
    confidence: 0.4,
    importance: 0.4,
  },
  {
    id: 'mem-orphan-source',
    summary: '报价单 v3 合计 184320 元（来源已丢失）',
    content: '报价单 v3 合计 184320 元，含石材与龙骨隔墙，originSystem=tool 导入。',
    layer: 'fragment',
    type: 'semantic',
    sourceType: 'tool',
    confidence: 0.8,
    importance: 0.65,
  },
  {
    id: 'mem-conflict-a',
    summary: '卫生间墙面砖规格 300×600',
    content: '卫生间墙面砖规格 300×600，竖贴。',
    layer: 'long',
    type: 'semantic',
    sourceType: 'owner_words',
    confidence: 0.8,
    importance: 0.5,
  },
  {
    id: 'mem-conflict-b',
    summary: '卫生间墙面砖规格 400×800',
    content: '卫生间墙面砖规格 400×800，横贴，上一版记错了。',
    layer: 'long',
    type: 'semantic',
    sourceType: 'owner_words',
    confidence: 0.8,
    importance: 0.5,
  },
  {
    // 专门用来演示 insufficient_evidence：来源完好、内容独特，
    // 用一个只覆盖它很小一部分的长查询去搜，就会落在「相关但撑不住答案」。
    id: 'mem-isolated-arch',
    summary: '样板间过道垭口宽度 1500mm，门槛石用深灰花岗岩',
    content: '样板间过道垭口宽度 1500mm，门槛石用深灰花岗岩，收边打硅酮胶。',
    layer: 'long',
    type: 'semantic',
    sourceType: 'owner_words',
    confidence: 0.85,
    importance: 0.55,
  },
]);

/**
 * 建临时主账（已跑迁移）。
 *
 * async：合成数据插完后要调 `memories.reindexAll()` —— 直接 SQL 插入不会自动进检索索引，
 * 不重建索引的话检索会诚实地报「索引与主账不一致」而不是命中。真实写入走门面时没这个问题。
 *
 * @param {{ seed?: boolean }} [opts]
 */
export async function createTempBrain(opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'brain-m2d-'));
  const dbPath = path.join(dir, 'brain.db');
  const brain = openBrain({ dbPath, migrationsDir: MIGRATIONS_DIR });
  if (opts.seed !== false) await seedFixture(brain);
  return {
    dir,
    dbPath,
    brain,
    async close() {
      try {
        await brain.close();
      } catch {
        /* 已关闭 */
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

/**
 * 直接 SQL 造合成数据。所有字符串常量、无用户输入 —— 不构成注入面。
 * @param {ReturnType<typeof openBrain>} brain
 */
export async function seedFixture(brain) {
  const db = brain.db;
  const now = new Date('2026-10-28T10:00:00.000Z').toISOString();
  const local = '2026-10-28T18:00:00.000+08:00';

  /** @param {string} id @param {{eventId?: string|null, hash?: string|null}} [opts] */
  const insertEvent = (id, opts = {}) => {
    db.prepare(
      `INSERT INTO events (
         event_id, schema_version, source_system, source_event_id, scope_id, person_id,
         session_id, turn_id, step_id, source_seq, event_type, origin_system,
         payload_ref, payload_hash, privacy, occurred_at, occurred_at_local,
         received_at, received_at_local, time_zone, content_fingerprint,
         created_at, created_at_local
       ) VALUES (?, 1, 'dsh', ?, 'owner-default', 'owner',
                 'session-synth-01', 'turn-1', 'step-1', ?, 'user/message', 'human',
                 ?, ?, 'private', ?, ?, ?, ?, 'Asia/Shanghai', ?,
                 ?, ?)`,
    ).run(
      id,
      `host-${id}`,
      1,
      `inline:${id}`,
      opts.hash ?? 'sha256:aaaa',
      now,
      local,
      now,
      local,
      `fp-${id}`,
      now,
      local,
    );
  };

  insertEvent('evt-ceiling', { hash: 'sha256:ceiling' });
  insertEvent('evt-drawing', { hash: 'sha256:drawing' });
  insertEvent('evt-partition', { hash: 'sha256:partition' });
  insertEvent('evt-bathroom', { hash: 'sha256:bathroom' });
  insertEvent('evt-bathroom-2', { hash: 'sha256:bathroom-2' });
  insertEvent('evt-orphan', { hash: 'sha256:orphan' });
  insertEvent('evt-isolated', { hash: 'sha256:isolated' });

  /**
   * @param {typeof CORPUS[number] & {status?: string}} m
   */
  const insertMemory = (m) => {
    db.prepare(
      `INSERT INTO memories (
         id, person_id, scope_id, layer, type, content, summary, source_type, source_ids,
         confidence, importance, privacy, status, created_at, created_at_local,
         updated_at, updated_at_local, mention_count, recall_count,
         valid_from, valid_from_local, valid_until, valid_until_local,
         pinned, version, content_hash, deletion_epoch
       ) VALUES (?, 'owner', 'owner-default', ?, ?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?,
                 ?, ?, 1, 0, ?, ?, ?, ?, 0, 1, ?, 0)`,
    ).run(
      m.id,
      m.layer,
      m.type,
      m.content,
      m.summary,
      m.sourceType,
      '[]',
      m.confidence,
      m.importance,
      m.status ?? 'active',
      now,
      local,
      now,
      local,
      '2026-01-01T00:00:00.000Z',
      local,
      null,
      null,
      `sha256:${m.id}`,
    );
    db.prepare(
      `INSERT INTO memory_versions (
         memory_id, version, content, summary, status, source_type, source_ids,
         confidence, importance, privacy, changed_by, change_reason, content_hash,
         created_at, created_at_local
       ) VALUES (?, 1, ?, ?, ?, ?, '[]', ?, ?, 'private', 'seed', 'fixture', ?, ?, ?)`,
    ).run(
      m.id,
      m.content,
      m.summary,
      m.status ?? 'active',
      m.sourceType,
      m.confidence,
      m.importance,
      `sha256:${m.id}`,
      now,
      local,
    );
  };

  for (const m of CORPUS) insertMemory(m);

  /**
   * @param {string} refId
   * @param {string} memoryId
   * @param {{eventId?: string|null, hash?: string|null, key?: string}} [opts]
   */
  const insertSource = (refId, memoryId, opts = {}) => {
    db.prepare(
      `INSERT INTO source_refs (
         ref_id, memory_id, source_kind, event_id, source_system, source_event_id,
         locator, content_hash, independent_source_key, created_at, created_at_local
       ) VALUES (?, ?, 'event', ?, 'dsh', ?, ?, ?, ?, ?, ?)`,
    ).run(
      refId,
      memoryId,
      opts.eventId === undefined ? 'evt-ceiling' : opts.eventId,
      opts.eventId ? `host-${opts.eventId}` : null,
      opts.eventId ? `inline:${opts.eventId}` : null,
      opts.hash ?? null,
      opts.key ?? `dsh:${opts.eventId ?? 'unknown'}`,
      now,
      local,
    );
  };

  // 正常来源（哈希与 event 一致 → 验证通过）
  insertSource('ref-ceiling', 'mem-ceiling-1200', { eventId: 'evt-ceiling' });
  insertSource('ref-drawing', 'mem-drawing-jianshi-03', { eventId: 'evt-drawing' });
  insertSource('ref-partition', 'mem-partition-price', { eventId: 'evt-partition' });

  // mem-no-source：完全不挂来源。memory 层把它判成 source_missing（「无来源记录」），
  //   检查器照实显示，不改写成「没问题」。
  //
  // mem-orphan-source：来源指向一个**已被删除**的事件。
  //   这是真实形态：事件被删除屏障标记（deletion_epoch > 0），记忆本身还在。
  //   外部 UUID 引用不存在的 event 会被 FK 挡住，所以这里用「事件已删」而不是「事件不存在」。
  insertSource('ref-orphan', 'mem-orphan-source', { eventId: 'evt-orphan', key: 'dsh:evt-orphan' });
  db.prepare("UPDATE events SET deletion_epoch = 1 WHERE event_id = 'evt-orphan'").run();

  // 来源冲突：**同一条记忆**挂着两个内容指纹不同的来源。
  //   memory 层的判据是「同一记忆出现 ≥2 个不同来源内容指纹」→ source_conflict。
  insertSource('ref-bath-a1', 'mem-conflict-a', {
    eventId: 'evt-bathroom',
    hash: 'sha256:bath-v1',
    key: 'dsh:evt-bathroom',
  });
  insertSource('ref-bath-a2', 'mem-conflict-a', {
    eventId: 'evt-bathroom-2',
    hash: 'sha256:bath-v2',
    key: 'dsh:evt-bathroom-2',
  });
  insertSource('ref-bath-b', 'mem-conflict-b', { eventId: 'evt-bathroom', key: 'dsh:evt-bathroom' });
  insertSource('ref-isolated', 'mem-isolated-arch', { eventId: 'evt-isolated' });

  // ---- 构包：覆盖 built / attached / sent / discarded 四态
  /** @param {{id: string, status: string, segments: any, attachedAt?: string|null, sentAt?: string|null, tokens?: number}} pkg */
  const insertPackage = (pkg) => {
    db.prepare(
      `INSERT INTO context_packages (
         context_id, scope_id, person_id, session_id, turn_id, policy_version,
         tokenizer_id, estimated_tokens, memory_versions, deletion_epoch, payload_hash,
         status, built_at, built_at_local, attached_at, attached_at_local,
         sent_at, sent_at_local, created_at, created_at_local
       ) VALUES (?, 'owner-default', 'owner', 'session-synth-01', 'turn-1', 'm2.0',
                 'estimate:chars/2.5', ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      pkg.id,
      pkg.tokens ?? 420,
      JSON.stringify(pkg.segments),
      `sha256:payload-${pkg.id}`,
      pkg.status,
      now,
      local,
      pkg.attachedAt ?? null,
      pkg.attachedAt ? local : null,
      pkg.sentAt ?? null,
      pkg.sentAt ? local : null,
      now,
      local,
    );
  };

  // 只到 built：紧凑形态（[{memoryId, version}]），且没有预算明细 → 检查器要如实说「未记录」
  insertPackage({
    id: 'ctx-built-only',
    status: 'built',
    segments: [
      { memoryId: 'mem-ceiling-1200', version: 1 },
      { memoryId: 'mem-drawing-jianshi-03', version: 1 },
    ],
  });
  insertPackage({
    id: 'ctx-attached',
    status: 'attached',
    segments: [{ memoryId: 'mem-partition-price', version: 1 }],
    attachedAt: '2026-10-28T10:00:01.000Z',
  });
  insertPackage({
    id: 'ctx-sent',
    status: 'sent',
    segments: [{ memoryId: 'mem-ceiling-1200', version: 1 }],
    attachedAt: '2026-10-28T10:00:01.000Z',
    sentAt: '2026-10-28T10:00:02.000Z',
  });
  insertPackage({ id: 'ctx-discarded', status: 'discarded', segments: [] });

  // 快照形态：带完整 segments + budget，用来验证「有明细就显示明细」
  db.prepare(
    `INSERT INTO context_packages (
       context_id, scope_id, person_id, session_id, turn_id, policy_version,
       tokenizer_id, estimated_tokens, memory_versions, deletion_epoch, payload_hash,
       status, built_at, built_at_local, created_at, created_at_local
     ) VALUES ('ctx-snapshot', 'owner-default', 'owner', 'session-synth-02', 'turn-2', 'm2.0',
               'estimate:chars/2.5', 900, ?, 0, 'sha256:payload-snapshot', 'built', ?, ?, ?, ?)`,
  ).run(
    JSON.stringify({
      segments: [{ memoryId: 'mem-partition-price', version: 1, summary: '轻钢龙骨 75 系隔墙报价 128 元/㎡' }],
      injectedText: '<!-- brain:ctx-snapshot -->\n- 轻钢龙骨 75 系隔墙报价 128 元/㎡',
      budget: {
        brainAllowance: 2048,
        used: 900,
        dropped: [{ memoryId: 'mem-conflict-b', reason: '低相关（得分 0.12 < 阈值 0.3）' }],
      },
    }),
    now,
    local,
    now,
    local,
  );

  // 直接 SQL 插入绕过了 memory 门面的写路径，所以索引还是空的。
  // 显式重建一次：不重建的话检索会（正确地）报「索引与主账不一致」而不是命中。
  // 真实写入走 `memories.create` 时索引是同步维护的，不存在这一步。
  if (typeof brain.memories?.reindexAll === 'function') {
    await brain.memories.reindexAll();
  }

  return { now, local };
}

/**
 * 批量造 N 条记忆（分页测试用）。
 * @param {ReturnType<typeof openBrain>} brain
 * @param {number} count
 */
export async function seedManyMemories(brain, count) {
  const db = brain.db;
  const now = new Date('2026-10-01T00:00:00.000Z');
  const local = '2026-10-01T08:00:00.000+08:00';
  const stmt = db.prepare(
    `INSERT INTO memories (
       id, person_id, scope_id, layer, type, content, summary, source_type, source_ids,
       confidence, importance, privacy, status, created_at, created_at_local,
       updated_at, updated_at_local, mention_count, recall_count, pinned, version, content_hash, deletion_epoch
     ) VALUES (?, 'owner', 'owner-default', 'fragment', 'episode', ?, ?, 'owner_words', '[]',
               0.7, 0.5, 'private', 'active', ?, ?, ?, ?, 0, 0, 0, 1, ?, 0)`,
  );
  for (let i = 0; i < count; i += 1) {
    // 时间递增，保证 keyset 分页有稳定顺序
    const ts = new Date(now.getTime() + i * 60_000).toISOString();
    const id = `mem-bulk-${String(i).padStart(4, '0')}`;
    stmt.run(id, `批量合成条目 ${i}：吊顶龙骨间距 ${400 + (i % 5) * 100}mm`, `批量条目 ${i}`, ts, local, ts, local, `sha256:${id}`);
  }
  if (typeof brain.memories?.reindexAll === 'function') {
    await brain.memories.reindexAll();
  }
}

/**
 * 起一个测试服务（端口 0 由系统分配）。
 * @param {{ dbPath?: string, token?: string, readOnlyDb?: boolean }} [opts]
 */
export async function startTestServer(opts = {}) {
  const running = await startServer({
    dbPath: opts.dbPath,
    port: 0,
    token: opts.token ?? TEST_TOKEN,
    readOnlyDb: opts.readOnlyDb ?? false,
    migrationsDir: MIGRATIONS_DIR,
    logger: silentLogger,
  });
  const base = running.url.replace(/\/$/, '');

  /**
   * @param {string} pathname
   * @param {RequestInit & { token?: string|null, query?: Record<string, string|number|null|undefined>, headers?: Record<string,string> }} [init]
   */
  async function request(pathname, init = {}) {
    const { token = running.token, query, headers, ...rest } = init;
    const url = new URL(`${base}${pathname}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        // null / undefined 表示「不要这个参数」；传 String(null) 会变成字面量 "null"，曾踩过。
        if (v === null || v === undefined) continue;
        url.searchParams.set(k, String(v));
      }
    }
    /** @type {Record<string,string>} */
    const merged = { ...(headers ?? {}) };
    if (token !== null) merged.Authorization = `Bearer ${token}`;
    if (rest.body !== undefined && merged['Content-Type'] === undefined) {
      merged['Content-Type'] = 'application/json';
    }
    const res = await fetch(url, { ...rest, headers: merged, redirect: 'manual' });
    const text = await res.text();
    let json = null;
    try {
      json = text.length > 0 ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { res, status: res.status, headers: res.headers, text, json };
  }

  return { ...running, base, request };
}
