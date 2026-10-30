// @ts-check
/**
 * 按 ID 直读的 scope 隔离（P0 隐私缺口回归）。
 *
 * 背景：`memories.get(id)` / `summaries.get(id)` / `store.getMemory(id)` /
 * `GET /api/memories/:id` 早期只有 `WHERE id = ?`，任何人拿到一个 id 就能读到
 * 别的 scope 的正文——这违反了设计文档 §22.4 第 4 类「跨 scope 的查询、ID 直读、
 * 分页游标…未授权正文和元数据均不得泄露」。
 *
 * 本文件锁死四条口径：
 * 1. **默认收口**：不传 scopeId 时按绑定（`bindings.scope_id`）过滤，收不到就是 null；
 * 2. **显式覆盖**：传 `opts.scopeId` 才切换上下文（等同 HTTP 的 `?scopeId=`），
 *    这是「声明上下文」，不是「内部越权」；
 * 3. **内部越权开关**：`opts.allowCrossScope === true` 是唯一跨 scope 通道，
 *    **只能进程内用**，不许从 HTTP 暴露；
 * 4. **不确认存在性**：跨 scope 的 id 在 HTTP 上回 404（与「真不存在」同形），
 *    回 403 等于告诉对方「这条存在，只是你没权限」。
 *
 * 分页游标也要覆盖：cursor 是 `(created_at, id)` 键集，本身不含 scope，
 * 但用 A 的 cursor 翻页时绝不能把 B 的行带出来。
 */

import test from 'node:test';
import { assert, MIGRATIONS_DIR, SCOPE_A, SCOPE_B, countRows, createBrain, draft } from './helpers.mjs';
import { openBrain } from '../../../packages/memory/src/index.js';
import { createCorrections } from '../../../packages/memory/src/correction.js';
import { createTempBrain, startTestServer } from '../server/helpers.mjs';

/** 只在 B scope 出现的独特正文（HTTP 响应里出现即泄漏）。 */
const B_SECRET = 'B-scope 私有：外墙保温用 50mm 岩棉，图号 结施-09';

/**
 * 再开一个绑定到指定 scope 的实例（同一库文件，只读用）。
 * @param {string} dbPath
 * @param {string} scopeId
 */
function openBound(dbPath, scopeId) {
  return openBrain({
    dbPath,
    migrationsDir: MIGRATIONS_DIR,
    bindings: { scope_id: scopeId, person_id: 'owner' },
  });
}

// ---------------------------------------------------------------------------
// 门面层：memories.get
// ---------------------------------------------------------------------------

test('memories.get：默认按绑定 scope 收口，拿到 B 的 id 也读不到', async (t) => {
  const { brain } = createBrain(t); // 缺省绑定 = SCOPE_A
  const foreign = await brain.memories.create(draft({ content: B_SECRET, scopeId: SCOPE_B }));

  assert.equal(brain.memories.get(foreign.id), null, '默认绑定 A 时，B 的 id 必须读不到');
  assert.equal(brain.memories.get(foreign.id, { scopeId: SCOPE_A }), null, '显式声明 A 也读不到 B');
  // asOf 分支是最容易漏的口子：时点回看必须同样收口
  assert.equal(
    brain.memories.get(foreign.id, { asOf: '2026-10-28T10:00:00.000Z' }),
    null,
    'asOf 时点回看不许绕过 scope 收口',
  );

  // 显式声明 B 上下文才读得到（「上下文声明」不是「越权」）
  const own = brain.memories.get(foreign.id, { scopeId: SCOPE_B });
  assert.ok(own);
  assert.equal(own.content, B_SECRET);
  assert.equal(own.scopeId, SCOPE_B);
});

test('memories.get：双向收口——绑定 B 的实例读不到 A 的 id', async (t) => {
  const { brain, dbPath } = createBrain(t);
  const local = await brain.memories.create(draft({ content: 'A-scope：铜版纸名片 300g，0.45 元一张' }));

  const bound = openBound(dbPath, SCOPE_B);
  try {
    assert.equal(bound.memories.get(local.id), null, '绑定 B 时 A 的 id 读不到');
    assert.equal(bound.memories.get(local.id, { scopeId: SCOPE_B }), null);
    // 显式切回 A 仍可读（同一进程内的合法上下文切换）
    assert.equal(bound.memories.get(local.id, { scopeId: SCOPE_A })?.id, local.id);
  } finally {
    await bound.close();
  }
});

test('memories.get：allowCrossScope 是唯一内部越权通道', async (t) => {
  const { brain } = createBrain(t);
  const foreign = await brain.memories.create(draft({ content: B_SECRET, scopeId: SCOPE_B }));

  assert.equal(brain.memories.get(foreign.id), null, '不传开关就不许跨');
  const crossed = brain.memories.get(foreign.id, { allowCrossScope: true });
  assert.ok(crossed, 'allowCrossScope=true 必须能跨（内部维护路径要能用）');
  assert.equal(crossed.content, B_SECRET);
  // 传了别的 scopeId 也不能配合开关读错人：开关优先级最高是「已知内部行为」，
  // 这里只锁住「不给开关就不行」，避免以后有人把开关默认成 true。
  assert.equal(brain.memories.get(foreign.id, { scopeId: SCOPE_A }), null);
});

// ---------------------------------------------------------------------------
// 门面层：summaries.get
// ---------------------------------------------------------------------------

test('summaries.get：默认收口，显式 scopeId / allowCrossScope 才跨', async (t) => {
  const { brain } = createBrain(t);
  const foreign = await brain.summaries.create({ scopeId: SCOPE_B, text: B_SECRET, sourceEventIds: [] });

  assert.equal(brain.summaries.get(foreign.id), null, '默认绑定 A 时，B 的摘要必须读不到');
  assert.equal(brain.summaries.get(foreign.id, { scopeId: SCOPE_A }), null);

  const own = brain.summaries.get(foreign.id, { scopeId: SCOPE_B });
  assert.ok(own);
  assert.equal(own.text, B_SECRET);
  assert.ok(brain.summaries.get(foreign.id, { allowCrossScope: true }), '内部开关要能跨');
});

// ---------------------------------------------------------------------------
// 门面层：list 与分页游标
// ---------------------------------------------------------------------------

test('memories.list：默认只列本 scope，显式 scopeId 才列对方', async (t) => {
  const { brain } = createBrain(t);
  const a = await brain.memories.create(draft({ content: 'A：画册封面 250g 哑粉' }));
  const b = await brain.memories.create(draft({ content: B_SECRET, scopeId: SCOPE_B }));

  const listA = brain.memories.list({});
  assert.deepEqual(listA.items.map((m) => m.id), [a.id], 'A 的列表不许出现 B 的行');

  const listB = brain.memories.list({ scopeId: SCOPE_B });
  assert.deepEqual(listB.items.map((m) => m.id), [b.id]);
});

test('memories.list：分页游标跨 scope 不许泄漏', async (t) => {
  const { brain } = createBrain(t);
  /** @type {string[]} */
  const aIds = [];
  for (let i = 0; i < 3; i += 1) {
    const created = await brain.memories.create(draft({ content: `A 的批量条目 ${i}：吊顶龙骨间距 ${400 + i * 100}mm` }));
    aIds.push(created.id);
  }
  /** @type {string[]} */
  const bIds = [];
  for (let i = 0; i < 2; i += 1) {
    const created = await brain.memories.create(draft({ content: `${B_SECRET} #${i}`, scopeId: SCOPE_B }));
    bIds.push(created.id);
  }

  // A 用 limit=2 翻完所有页：两页的并集必须正好是 A 的三条，一条 B 都不能混进来
  const seen = [];
  let cursor = null;
  let guard = 0;
  do {
    const page = brain.memories.list({ limit: 2, cursor });
    seen.push(...page.items.map((m) => m.id));
    cursor = page.nextCursor;
    guard += 1;
  } while (cursor !== null && guard < 10);
  assert.deepEqual([...seen].sort(), [...aIds].sort(), 'A 翻页结果必须恰好是 A 的行');
  assert.equal(seen.some((id) => bIds.includes(id)), false, 'A 的翻页结果里混进了 B 的行');

  // 反向：拿 B 的 cursor 去查 A，绝不能把 B 带出来
  const bPage = brain.memories.list({ scopeId: SCOPE_B, limit: 1 });
  assert.ok(bPage.nextCursor, 'B 两行、limit=1，必然有 cursor');
  const crossed = brain.memories.list({ limit: 10, cursor: bPage.nextCursor });
  assert.equal(
    crossed.items.some((m) => bIds.includes(m.id)),
    false,
    'B 的 cursor + A 的上下文，不许把 B 的行翻出来',
  );
});

// ---------------------------------------------------------------------------
// HTTP 层：GET /api/memories/:id 与 GET /api/memories
// ---------------------------------------------------------------------------

test('HTTP：GET /api/memories/:id 跨 scope 回 404，且响应里不含对方正文', async () => {
  const tmp = await createTempBrain({ seed: false });
  const server = await startTestServer({ dbPath: tmp.dbPath });
  try {
    const foreign = await tmp.brain.memories.create(draft({ content: B_SECRET, scopeId: SCOPE_B }));
    const local = await tmp.brain.memories.create(draft({ content: 'A：隔墙报价 128 元/㎡' }));

    // 不声明 scope：默认是服务端绑定的 scope（owner-default）→ 越界 id 与「不存在」同形
    const denied = await server.request(`/api/memories/${foreign.id}`);
    assert.equal(denied.status, 404, '跨 scope 的 id 必须 404，不能 403（403 等于承认它存在）');
    assert.equal(denied.json.error.code, 'NOT_FOUND');
    assert.equal(denied.text.includes('岩棉'), false, '404 响应里不许出现对方正文');

    // 本 scope 的照常读
    assert.equal((await server.request(`/api/memories/${local.id}`)).status, 200);

    // 显式声明对方 scope 才能读到（与 list 的 ?scopeId= 同口径）
    const declared = await server.request(`/api/memories/${foreign.id}`, { query: { scopeId: SCOPE_B } });
    assert.equal(declared.status, 200);
    assert.equal(declared.json.memory.content, B_SECRET);
  } finally {
    await server.close();
    await tmp.close();
  }
});

test('HTTP：GET /api/memories 默认只列本 scope，显式 scopeId 才列对方', async () => {
  const tmp = await createTempBrain({ seed: false });
  const server = await startTestServer({ dbPath: tmp.dbPath });
  try {
    const foreign = await tmp.brain.memories.create(draft({ content: B_SECRET, scopeId: SCOPE_B }));
    await tmp.brain.memories.create(draft({ content: 'A：名片 90×54mm' }));

    const plain = await server.request('/api/memories');
    assert.equal(plain.status, 200);
    assert.equal(
      plain.json.items.some((m) => m.id === foreign.id),
      false,
      '不声明 scope 的列表不许出现别的 scope',
    );
    assert.equal(plain.text.includes('岩棉'), false);

    const declared = await server.request('/api/memories', { query: { scopeId: SCOPE_B } });
    assert.equal(declared.status, 200);
    assert.deepEqual(declared.json.items.map((m) => m.id), [foreign.id]);
  } finally {
    await server.close();
    await tmp.close();
  }
});

test('HTTP：allowCrossScope 不许从 HTTP 暴露（传了也不生效）', async () => {
  const tmp = await createTempBrain({ seed: false });
  const server = await startTestServer({ dbPath: tmp.dbPath });
  try {
    const foreign = await tmp.brain.memories.create(draft({ content: B_SECRET, scopeId: SCOPE_B }));
    const sneaky = await server.request(`/api/memories/${foreign.id}`, {
      query: { allowCrossScope: 'true' },
    });
    assert.equal(sneaky.status, 404, 'URL 上的 allowCrossScope 必须被忽略');
    assert.equal(sneaky.text.includes('岩棉'), false);

    const sneakyList = await server.request('/api/memories', { query: { allowCrossScope: 'true' } });
    assert.equal(
      sneakyList.json.items.some((m) => m.id === foreign.id),
      false,
      '列表接口同样不许接受 allowCrossScope',
    );
  } finally {
    await server.close();
    await tmp.close();
  }
});

// ---------------------------------------------------------------------------
// 写路径：update / supersede / requestDeletion / requestDelete
// ---------------------------------------------------------------------------

test('memories.update：跨 scope 的 id 必须 NOT_FOUND，且数据一字未改', async (t) => {
  const { brain } = createBrain(t);
  const foreign = await brain.memories.create(draft({ content: B_SECRET, scopeId: SCOPE_B }));
  const versionsBefore = countRows(brain.db, 'memory_versions');

  await assert.rejects(
    () => brain.memories.update(foreign.id, { content: '被越权改掉的内容' }, { expectedVersion: 1 }),
    (err) => {
      assert.equal(err.code, 'NOT_FOUND', '跨 scope 一律 NOT_FOUND（不确认存在性）');
      return true;
    },
  );

  const row = /** @type {any} */ (
    brain.db.prepare('SELECT content, version, status FROM memories WHERE id = ?').get(foreign.id)
  );
  assert.equal(row.content, B_SECRET, '被拒的写不许改原文');
  assert.equal(Number(row.version), 1, '被拒的写不许抬版本');
  assert.equal(String(row.status), 'active');
  assert.equal(countRows(brain.db, 'memory_versions'), versionsBefore, '被拒的写不许留版本记录');
  assert.equal(brain.memories.get(foreign.id, { scopeId: SCOPE_B })?.content, B_SECRET);

  // 内部维护路径：显式开关才放行（且只有进程内可用）
  const crossed = await brain.memories.update(
    foreign.id,
    { content: '维护路径改写' },
    { expectedVersion: 1, allowCrossScope: true },
  );
  assert.equal(crossed.version, 2);
});

test('memories.supersede：跨 scope 一律 NOT_FOUND，两条状态都不许动', async (t) => {
  const { brain } = createBrain(t);
  const oldB = await brain.memories.create(draft({ content: 'B 旧值：岩棉 50mm', scopeId: SCOPE_B }));
  const newB = await brain.memories.create(draft({ content: 'B 新值：岩棉 80mm', scopeId: SCOPE_B }));
  const aOld = await brain.memories.create(draft({ content: 'A 旧值：岩棉 50mm' }));
  const aNew = await brain.memories.create(draft({ content: 'A 新值：岩棉 80mm' }));

  // 三条越权路径都要 NOT_FOUND：全在 B / 新的在 B / 旧的 in B
  await assert.rejects(
    () => brain.memories.supersede(oldB.id, newB.id),
    (err) => err.code === 'NOT_FOUND',
  );
  await assert.rejects(
    () => brain.memories.supersede(aOld.id, newB.id),
    (err) => err.code === 'NOT_FOUND',
    '旧值在 A、新值在 B：不许因为「同 scope 校验」而确认 B 存在',
  );
  await assert.rejects(
    () => brain.memories.supersede(oldB.id, aNew.id),
    (err) => err.code === 'NOT_FOUND',
  );

  for (const id of [oldB.id, aOld.id]) {
    const row = /** @type {any} */ (
      brain.db.prepare('SELECT status, supersedes, version FROM memories WHERE id = ?').get(id)
    );
    assert.equal(String(row.status), 'active', '被拒的 supersede 不许改状态');
    assert.equal(row.supersedes, null, '被拒的 supersede 不许连链');
    assert.equal(Number(row.version), 1, '被拒的 supersede 不许抬版本');
  }

  // 同 scope 内正常可用（收口没有把合法写入一起挡掉）
  await brain.memories.supersede(aOld.id, aNew.id);
  const superseded = /** @type {any} */ (
    brain.db.prepare('SELECT status FROM memories WHERE id = ?').get(aOld.id)
  );
  assert.equal(String(superseded.status), 'superseded');
});

test('deletion.requestDeletion：跨 scope 不许删，不留墓碑、不碰数据', async (t) => {
  const { brain } = createBrain(t);
  const foreign = await brain.memories.create(draft({ content: B_SECRET, scopeId: SCOPE_B }));

  await assert.rejects(
    () =>
      brain.deletion.requestDeletion({
        target_kind: 'memory',
        target_id: foreign.id,
        scope_id: SCOPE_A,
        reason: '越权删除',
      }),
    (err) => {
      assert.equal(err.code, 'NOT_FOUND', '跨 scope 的删除目标一律 NOT_FOUND');
      return true;
    },
  );

  assert.equal(countRows(brain.db, 'deletion_tombstones'), 0, '被拒的删除不许留墓碑');
  assert.equal(brain.deletion.getDeletionEpoch(), 0, '被拒的删除不许抬 epoch');
  const row = /** @type {any} */ (
    brain.db.prepare('SELECT status, content, deletion_epoch FROM memories WHERE id = ?').get(foreign.id)
  );
  assert.equal(String(row.status), 'active');
  assert.equal(row.content, B_SECRET);
  assert.equal(Number(row.deletion_epoch), 0);
  // 目标仍在 B scope 可读（真删是另一条路径的事）
  assert.ok(brain.memories.get(foreign.id, { scopeId: SCOPE_B }));
});

test('corrections：跨 scope 的 currentView / asOfView / chainOf / supersede 全部不认', async (t) => {
  const { brain } = createBrain(t);
  const corrections = createCorrections({
    db: brain.db,
    queue: brain.queue,
    clock: brain.clock,
    memories: brain.memories,
    bindings: { scope_id: SCOPE_A },
  });
  const foreign = await brain.memories.create(
    draft({ content: B_SECRET, summary: 'B 摘要暗号', scopeId: SCOPE_B }),
  );
  const foreign2 = await brain.memories.create(draft({ content: 'B 的另一条：岩棉 80mm', scopeId: SCOPE_B }));

  const view = corrections.currentView(foreign.id);
  assert.equal(view.readable, false, '跨 scope 的 id 不许 readable');
  assert.equal(view.reason, 'not_found', '不确认存在性：与「真不存在」同形');
  assert.equal(view.value, null);
  const asOfView = corrections.asOfView(foreign.id, '2026-10-28T10:00:00.000Z');
  assert.equal(asOfView.reason, 'not_found', 'asOf 回看也不许跨 scope');
  assert.deepEqual(corrections.chainOf(foreign.id), [], '纠错链不许跨 scope 泄漏');

  await assert.rejects(
    () => corrections.supersede(foreign.id, foreign2.id, { reason: '越权纠错' }),
    (err) => err.code === 'NOT_FOUND',
  );
  const row = /** @type {any} */ (
    brain.db.prepare('SELECT status, supersedes FROM memories WHERE id = ?').get(foreign.id)
  );
  assert.equal(String(row.status), 'active', '被拒的纠错不许改状态');
  assert.equal(row.supersedes, null);
});

// ---------------------------------------------------------------------------
// HTTP 写路径 + 上下文包（store.requestDelete / getContext / hydrateSegments）
// ---------------------------------------------------------------------------

test('HTTP：DELETE /api/memories/:id 跨 scope 回 404，且不留墓碑、不碰数据', async () => {
  const tmp = await createTempBrain({ seed: false });
  const server = await startTestServer({ dbPath: tmp.dbPath });
  try {
    const foreign = await tmp.brain.memories.create(draft({ content: B_SECRET, scopeId: SCOPE_B }));

    const denied = await server.request(`/api/memories/${foreign.id}`, { method: 'DELETE' });
    assert.equal(denied.status, 404, '跨 scope 删除必须是 404（不是 403/202）');
    assert.equal(denied.json.error.code, 'NOT_FOUND');
    assert.equal(countRows(tmp.brain.db, 'deletion_tombstones'), 0, '被拒的删除不许留墓碑');
    const row = /** @type {any} */ (
      tmp.brain.db.prepare('SELECT status, content FROM memories WHERE id = ?').get(foreign.id)
    );
    assert.equal(String(row.status), 'active');
    assert.equal(row.content, B_SECRET);
  } finally {
    await server.close();
    await tmp.close();
  }
});

test('HTTP：GET /api/context/:id 跨 scope 回 404；包内引用别 scope 的记忆必须 missing', async () => {
  const tmp = await createTempBrain({ seed: false });
  const server = await startTestServer({ dbPath: tmp.dbPath });
  try {
    const foreign = await tmp.brain.memories.create(
      draft({ content: B_SECRET, summary: 'B 摘要暗号', scopeId: SCOPE_B }),
    );
    const local = await tmp.brain.memories.create(draft({ content: 'A：隔墙 128 元/㎡' }));

    const now = '2026-10-28T10:00:00.000Z';
    const localTs = '2026-10-28T18:00:00.000+08:00';
    /** @param {string} id @param {string} scopeId @param {unknown} memoryVersions */
    const insertPackage = (id, scopeId, memoryVersions) => {
      tmp.brain.db
        .prepare(
          `INSERT INTO context_packages (
             context_id, scope_id, person_id, session_id, turn_id, policy_version,
             tokenizer_id, estimated_tokens, memory_versions, deletion_epoch, payload_hash,
             status, built_at, built_at_local, created_at, created_at_local
           ) VALUES (?, ?, 'owner', 's', 't', 'm2.0', 'estimate:chars/2.5', 10, ?, 0, ?,
                     'built', ?, ?, ?, ?)`,
        )
        .run(
          id,
          scopeId,
          JSON.stringify(memoryVersions),
          `sha256:payload-${id}`,
          now,
          localTs,
          now,
          localTs,
        );
    };

    // A scope 的包，但紧凑引用里塞了 B scope 的记忆 id —— 补全文时必须拒绝
    insertPackage('ctx-leak', SCOPE_A, [{ memoryId: foreign.id, version: 1 }]);
    // B scope 的包，A 绑定不该看见
    insertPackage('ctx-b-only', SCOPE_B, [{ memoryId: foreign.id, version: 1 }]);
    // A scope 的正常包（对照组：收口没有把合法读取一起挡掉）
    insertPackage('ctx-local', SCOPE_A, [{ memoryId: local.id, version: 1 }]);

    const crossId = await server.request('/api/context/ctx-b-only');
    assert.equal(crossId.status, 404, '跨 scope 的 contextId 与「不存在」同形');
    assert.equal(crossId.text.includes('B 摘要暗号'), false);

    const leak = await server.request('/api/context/ctx-leak');
    assert.equal(leak.status, 200);
    assert.equal(leak.json.segments.length, 1);
    assert.equal(leak.json.segments[0].missing, true, '包内引用别 scope 的记忆必须标 missing');
    assert.equal(leak.text.includes('B 摘要暗号'), false, '不许把别 scope 的摘要补齐出来');

    const localPack = await server.request('/api/context/ctx-local');
    assert.equal(localPack.status, 200);
    assert.equal(localPack.json.segments[0].missing, undefined);
    assert.equal(localPack.json.segments[0].memoryId, local.id);
  } finally {
    await server.close();
    await tmp.close();
  }
});
