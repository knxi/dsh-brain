// @ts-check
/**
 * M6.2：「按 id 直读」的跨 scope 收口——实体 / 关系边 / 构包 / 来源 / HTTP 构包列表。
 *
 * 为什么单独一个文件：`tests/m2/memory/scope-isolation.test.mjs` 已经锁死了
 * `memories.get` / `summaries.get` / `list` + 游标 / `GET /api/memories/:id` /
 * `DELETE /api/memories/:id` / `GET /api/context/:id` / corrections 这一批。
 * 本文件补的是**同一口径下先前漏掉的入口**：
 *
 * | 入口 | 改前 | 改后 |
 * |---|---|---|
 * | `entities.get(id)` | `WHERE e.id = ?`（跨 scope 能读） | 默认 caller scope，越界 `null` |
 * | `entities.memoriesFor(entityId)` | 返回**记忆正文**，无 scope | 越界 `[]` |
 * | `entities.forMemory(memoryId)` | 无 scope | 越界 `[]` |
 * | `memoryEdges.forMemory(memoryId)` | 无 scope | 越界 `{out:[],in:[]}` |
 * | `memoryEdges.remove(id)` | 按 id 真删，无 scope | 越界 `{removed:false}`，不删行 |
 * | `contextPackages.get(contextId)` | `WHERE context_id = ?` | 越界 `null` |
 * | `contextPackages.updateStatus(contextId)` | 无 scope（能改别人证据） | 越界 `NOT_FOUND` |
 * | `sources.forMemory(memoryId)` | 无 scope（`source_refs` 没有 scope 列） | 越界 `[]` |
 * | `sources.verify(refId)` | 无 scope | 越界 `source_missing` |
 * | `GET /api/contexts` | 不传 `scopeId` = 列全库 | 默认只列本 scope |
 *
 * 四条纪律（与 CONTRACTS §16 一致）：
 * 1. 默认按 caller 的 scope 过滤；`opts.scopeId` 是「声明上下文」，不是越权；
 * 2. 跨 scope 与「不存在」**同形**——`null` / `[]` / 空视图 / `{removed:false}` /
 *    `NOT_FOUND`，一律不确认存在性；
 * 3. 错误文案**不许出现 "scope" / "scopeId"**（出现就等于确认「这条存在，只是不归你」）；
 * 4. `allowCrossScope === true` 是唯一内部越权通道，HTTP 层不暴露。
 *
 * 纪律：只用 node:test + node:assert/strict，全部在 mkdtemp 临时主账里跑，不碰 data/brain.db。
 */

import test from 'node:test';
import {
  assert,
  SCOPE_A,
  SCOPE_B,
  countRows,
  createBrain,
  draft,
} from '../../m2/memory/helpers.mjs';
import { createTempBrain, startTestServer } from '../../m2/server/helpers.mjs';

/**
 * 只在 B scope 出现的独特正文：返回值/HTTP 响应里出现即泄漏。
 * **刻意不含 "scope" 字样**——这样任何地方冒出 scope 都只可能是泄底，断言不会被数据误伤。
 */
const B_SECRET = 'B 私有：外墙保温改 80mm 岩棉，图号 结施-12';

/**
 * 断言一段文案里没有泄底词。
 *
 * 注意口径：`构包记录不存在：<caller 给的 id>` 这种**回显调用方入参**是允许的
 * （不是我们泄露的信息，砍掉反而丢掉排查线索）。不许出现的是「scope 不一致 /
 * 不属于你」这类说明。所以本文件里的 id 特意不含 scope 字样，断言才判得干净。
 */
function assertNoScopeWord(text, label) {
  const s = String(text ?? '');
  assert.doesNotMatch(s, /scope/i, `${label}：文案不许出现 scope 字样（出现等于确认对方存在）`);
}

/**
 * 造一条 B scope 的实体 + 记忆关联（同 scope 两端，`linkMemory` 的合法路径）。
 * @param {ReturnType<typeof createBrain>['brain']} brain
 * @param {{ content?: string, summary?: string, entityName?: string }} [opts]
 */
async function seedB(brain, opts = {}) {
  const memory = await brain.memories.create(
    draft({
      content: opts.content ?? B_SECRET,
      ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
      scopeId: SCOPE_B,
    }),
  );
  const entity = await brain.entities.upsert({
    name: opts.entityName ?? 'B 私有实体',
    kind: 'concept',
    scopeId: SCOPE_B,
  });
  await brain.entities.linkMemory(memory.id, entity.id);
  return { memory, entity };
}

// ===========================================================================
// 1. 实体：get / forMemory / memoriesFor
// ===========================================================================

test('1. entities.get：默认按绑定 scope 收口，跨 scope 的 id 与「不存在」同形（null）', async (t) => {
  const { brain } = createBrain(t); // 缺省绑定 = SCOPE_A
  const mine = await brain.entities.upsert({ name: '本 scope 实体', kind: 'tool' });
  const { entity: other } = await seedB(brain);

  assert.equal(brain.entities.get(other.id), null, '默认绑定 A 时，B 的实体 id 必须读不到');
  assert.equal(brain.entities.get(other.id, { scopeId: SCOPE_A }), null, '显式声明 A 也读不到 B');
  // 与「真不存在」的返回值必须完全一样（同形，不是「空对象」也不是抛错）
  assert.deepEqual(brain.entities.get(other.id), brain.entities.get('ent_000000000000000000000000'));

  // 同 scope 正常（收口没有把合法读取一起挡掉）
  assert.equal(brain.entities.get(mine.id)?.kind, 'tool');

  // 显式声明 B 上下文才读得到（「上下文声明」不是「越权」）
  assert.equal(brain.entities.get(other.id, { scopeId: SCOPE_B })?.kind, 'concept');

  // 内部开关：只给进程内维护路径
  assert.equal(brain.entities.get(other.id, { allowCrossScope: true })?.kind, 'concept');
});

test('2. entities.memoriesFor：别 scope 的实体名下不许读出它的记忆（含摘要）', async (t) => {
  const { brain } = createBrain(t);
  const { entity: other, memory: otherMemory } = await seedB(brain, { summary: B_SECRET });

  const foreign = brain.entities.memoriesFor(other.id);
  assert.deepEqual(foreign, [], '跨 scope 的实体必须返回空数组');
  assert.equal(JSON.stringify(foreign).includes('岩棉'), false, '返回值里不许出现对方摘要/正文');

  // 显式声明 B 才拿得到（这是「上下文声明」，不是泄露）。
  // 注意：memoriesFor 的返回字段是 summary 不是 content（正文只留在库里），
  // 所以这里断言 summary —— 拿它当「有没有读到对方数据」的判据。
  const declared = brain.entities.memoriesFor(other.id, { scopeId: SCOPE_B });
  assert.equal(declared.length, 1);
  assert.equal(declared[0].memoryId, otherMemory.id);
  assert.equal(declared[0].summary, B_SECRET);

  // 同 scope 的实体名下记忆照常返回
  const localMemory = await brain.memories.create(draft({ content: 'A：隔墙报价 128 元/㎡' }));
  const localEntity = await brain.entities.upsert({ name: '本 scope 实体', kind: 'tool' });
  await brain.entities.linkMemory(localMemory.id, localEntity.id);
  assert.deepEqual(
    brain.entities.memoriesFor(localEntity.id).map((row) => row.memoryId),
    [localMemory.id],
  );
});

test('3. entities.forMemory：跨 scope 的记忆 id 返回空数组（不确认存在性）', async (t) => {
  const { brain } = createBrain(t);
  const { memory: other } = await seedB(brain);

  assert.deepEqual(brain.entities.forMemory(other.id), [], '跨 scope 的记忆不许列出它挂的实体');
  assert.equal(brain.entities.forMemory(other.id, { scopeId: SCOPE_A }).length, 0);
  // 显式声明 B 才看得到
  const declared = brain.entities.forMemory(other.id, { scopeId: SCOPE_B });
  assert.equal(declared.length, 1);
  assert.equal(declared[0].name, 'B 私有实体');
});

// ===========================================================================
// 2. 关系边：forMemory / remove
// ===========================================================================

test('4. memoryEdges.forMemory：跨 scope 返回空视图，三处过滤都生效', async (t) => {
  const { brain } = createBrain(t);
  const b1 = await brain.memories.create(draft({ content: `${B_SECRET} #1`, summary: 'B 起点摘要', scopeId: SCOPE_B }));
  const b2 = await brain.memories.create(draft({ content: `${B_SECRET} #2`, summary: 'B 对端摘要', scopeId: SCOPE_B }));
  await brain.memoryEdges.link({
    scopeId: SCOPE_B,
    fromMemoryId: b1.id,
    toMemoryId: b2.id,
    kind: 'contradicts',
    reason: 'B 内部矛盾',
  });

  assert.deepEqual(
    brain.memoryEdges.forMemory(b1.id),
    { out: [], in: [] },
    '跨 scope 的 id 必须返回空视图（与「没有关系」同形）',
  );

  // 显式声明 B 才看得到边与对端摘要
  const declared = brain.memoryEdges.forMemory(b1.id, { scopeId: SCOPE_B });
  assert.equal(declared.out.length, 1);
  assert.equal(declared.out[0].kind, 'contradicts');
  assert.equal(declared.out[0].peerSummary, 'B 对端摘要');
  assert.equal(JSON.stringify(declared).includes('岩棉'), false, '对端摘要不许带出正文');
});

test('5. memoryEdges.remove：跨 scope 不许删（removed:false 且一行不动）', async (t) => {
  const { brain } = createBrain(t);
  const b1 = await brain.memories.create(draft({ content: `${B_SECRET} #1`, scopeId: SCOPE_B }));
  const b2 = await brain.memories.create(draft({ content: `${B_SECRET} #2`, scopeId: SCOPE_B }));
  const edge = await brain.memoryEdges.link({
    scopeId: SCOPE_B,
    fromMemoryId: b1.id,
    toMemoryId: b2.id,
    kind: 'supports',
  });

  assert.deepEqual(await brain.memoryEdges.remove(edge.id), { removed: false }, '跨 scope 与「不存在」同形');
  assert.equal(countRows(brain.db, 'memory_edges'), 1, '被拒的删除不许真删行');

  // 同 scope 的边照常能删（用 B 的上下文声明）
  assert.deepEqual(await brain.memoryEdges.remove(edge.id, { scopeId: SCOPE_B }), { removed: true });
  assert.equal(countRows(brain.db, 'memory_edges'), 0);

  // 不存在的 id 同样 {removed:false}（同形）
  assert.deepEqual(await brain.memoryEdges.remove('edge_000000000000000000000000'), { removed: false });
});

// ===========================================================================
// 3. 构包：get / updateStatus
// ===========================================================================

/**
 * 造一条最小可用构包（形状照 context-packages.test.mjs 的 contextPackage()）。
 * @param {Record<string, unknown>} [overrides]
 */
function pkgDraft(overrides = {}) {
  return {
    contextId: 'ctx-a-only',
    builtAt: '2026-10-28T10:00:00.000Z',
    policyVersion: 'm2.0',
    scopeId: SCOPE_A,
    personId: 'owner',
    sessionId: 'sess-scope',
    turnId: 'turn-1',
    stepId: 'step-1',
    segments: [
      {
        memoryId: 'mem_scope_1',
        version: 1,
        layer: 'long',
        type: 'semantic',
        summary: 'A：隔墙报价 128 元/㎡',
        contentHash: 'sha256:aaaa',
        sourceRefs: [],
        evidenceKind: 'owner_words',
        validFrom: null,
        validUntil: null,
        score: 0.9,
      },
    ],
    injectedText: '1. A：隔墙报价 128 元/㎡',
    estimatedTokens: 40,
    tokenizerId: 'estimate:cjk1/ascii4',
    canonicalHash: 'sha256:0123456789abcdef',
    budget: null,
    diagnostics: { status: 'ok', reasons: [], evidenceStrength: 'primary', segmentedFallback: false },
    status: 'built',
    carrier: null,
    ...overrides,
  };
}

test('6. contextPackages.get：跨 scope 返回 null（段里的摘要也是正文片段）', async (t) => {
  const { brain } = createBrain(t);
  await brain.contextPackages.save(pkgDraft());
  await brain.contextPackages.save(
    pkgDraft({
      contextId: 'ctx-b-only',
      scopeId: SCOPE_B,
      injectedText: '1. B：外墙保温 80mm 岩棉',
      segments: [
        {
          memoryId: 'mem_scope_b',
          version: 1,
          layer: 'long',
          type: 'semantic',
          summary: B_SECRET,
          contentHash: 'sha256:bbbb',
          sourceRefs: [],
          evidenceKind: 'owner_words',
          validFrom: null,
          validUntil: null,
          score: 0.9,
        },
      ],
    }),
  );

  assert.equal(brain.contextPackages.get('ctx-b-only'), null, '跨 scope 与「不存在」同形');
  assert.deepEqual(brain.contextPackages.get('ctx-b-only'), brain.contextPackages.get('ctx-missing'));

  // 显式声明 B 才读得到
  const declared = brain.contextPackages.get('ctx-b-only', { scopeId: SCOPE_B });
  assert.ok(declared);
  assert.equal(declared.scopeId, SCOPE_B);

  // 同 scope 照常
  assert.equal(brain.contextPackages.get('ctx-a-only')?.scopeId, SCOPE_A);
});

test('7. contextPackages.updateStatus：跨 scope NOT_FOUND，文案里不许出现 scope 字样，状态一字未改', async (t) => {
  const { brain } = createBrain(t);
  await brain.contextPackages.save(
    pkgDraft({ contextId: 'ctx-b-only', scopeId: SCOPE_B, status: 'built' }),
  );

  await assert.rejects(
    () => brain.contextPackages.updateStatus('ctx-b-only', { status: 'attached', carrier: 'system' }),
    (err) => {
      assert.equal(err.code, 'NOT_FOUND', '跨 scope 一律 NOT_FOUND（不确认存在性）');
      assertNoScopeWord(err.message, 'updateStatus 越界');
      return true;
    },
  );

  const row = /** @type {any} */ (
    brain.db.prepare('SELECT status, carrier, attached_at FROM context_packages WHERE context_id = ?').get('ctx-b-only')
  );
  assert.equal(String(row.status), 'built', '被拒的推进不许改状态');
  assert.equal(row.carrier, null, '被拒的推进不许写载体');

  // 不存在的 id 错误码完全相同（同形）
  await assert.rejects(
    () => brain.contextPackages.updateStatus('ctx-missing', { status: 'attached' }),
    (err) => err.code === 'NOT_FOUND',
  );

  // 显式声明 B 才推得动
  const ok = await brain.contextPackages.updateStatus(
    'ctx-b-only',
    { status: 'attached', carrier: 'system' },
    { scopeId: SCOPE_B },
  );
  assert.equal(ok.status, 'attached');
});

test('8. contextPackages.list：默认只列本 scope，显式 scopeId / allowCrossScope 才跨', async (t) => {
  const { brain } = createBrain(t);
  await brain.contextPackages.save(pkgDraft());
  await brain.contextPackages.save(pkgDraft({ contextId: 'ctx-b-only', scopeId: SCOPE_B }));

  const plain = brain.contextPackages.list({});
  assert.deepEqual(plain.items.map((i) => i.id), ['ctx-a-only'], '默认不许把别 scope 的包列出来');

  const declared = brain.contextPackages.list({ scopeId: SCOPE_B });
  assert.deepEqual(declared.items.map((i) => i.id), ['ctx-b-only']);

  // 维护路径：显式开关才看全库（并明确标注这是跨库口径）
  const all = brain.contextPackages.list({ allowCrossScope: true });
  assert.equal(all.items.length, 2);
});

// ===========================================================================
// 4. 来源：forMemory / verify（source_refs 没有 scope 列，靠 JOIN memories）
// ===========================================================================

test('9. sources.forMemory：跨 scope 返回空数组（locator / hash 也是元数据）', async (t) => {
  const { brain } = createBrain(t);
  const { memory: other } = await seedB(brain);
  await brain.sources.link(other.id, { sourceEventId: 'evt-b-private', locator: 'B-secret-locator' });

  assert.deepEqual(brain.sources.forMemory(other.id), [], '跨 scope 不许读出对方来源');
  const declared = brain.sources.forMemory(other.id, { scopeId: SCOPE_B });
  assert.equal(declared.length, 1);
  assert.equal(declared[0].locator, 'B-secret-locator');

  // 同 scope 正常
  const local = await brain.memories.create(draft({ content: 'A：名片 90×54mm' }));
  await brain.sources.link(local.id, { locator: 'A-locator' });
  assert.equal(brain.sources.forMemory(local.id).length, 1);
});

test('10. sources.verify：跨 scope 的 refId 归到 source_missing（与「不存在」同形）', async (t) => {
  const { brain } = createBrain(t);
  const { memory: other } = await seedB(brain);
  const linked = await brain.sources.link(other.id, { locator: 'B-locator-2' });

  const crossed = brain.sources.verify(linked.id);
  assert.equal(crossed.ok, false);
  assert.equal(crossed.reason, 'source_missing', '跨 scope 与「真不存在」必须给同一个 reason');
  assert.deepEqual(crossed, brain.sources.verify('ref_00000000000000000000000000000000'));

  // 显式声明 B 才验得动
  assert.equal(brain.sources.verify(linked.id, { scopeId: SCOPE_B }).ok, true);
});

// ===========================================================================
// 5. 删除语义没被顺带改掉（"已删除" 和 "跨 scope" 是两件事）
// ===========================================================================

test('11. 已删除记忆：直读语义保持原样（null / 空数组），不是变成「跨 scope」', async (t) => {
  const { brain } = createBrain(t);
  const doomed = await brain.memories.create(draft({ content: 'A：待删除的吊顶龙骨间距 400mm' }));
  const other = await brain.memories.create(draft({ content: 'A：保留的隔墙报价' }));
  const entity = await brain.entities.upsert({ name: '删除测试实体', kind: 'tool' });
  await brain.entities.linkMemory(doomed.id, entity.id);
  await brain.memoryEdges.link({
    fromMemoryId: doomed.id,
    toMemoryId: other.id,
    kind: 'refines',
  });

  assert.deepEqual(brain.entities.memoriesFor(entity.id).map((r) => r.memoryId), [doomed.id]);
  assert.equal(brain.memoryEdges.forMemory(doomed.id).out.length, 1);

  // 软删除
  await brain.memories.update(doomed.id, { status: 'deleted' }, { expectedVersion: 1 });

  // 记忆直读：仍是删除语义（null）
  assert.equal(brain.memories.get(doomed.id), null, '已删记忆直读仍是 null（原有删除语义）');
  // 实体名下不再含它（原样）
  assert.deepEqual(brain.entities.memoriesFor(entity.id), [], '已删记忆不出现在实体名下');
  // 已删记忆自己没有关系视图（原样）
  assert.deepEqual(brain.memoryEdges.forMemory(doomed.id), { out: [], in: [] });
  // 但同 scope 的另一条仍读得到（收口没有把同 scope 的读一起关掉）
  assert.ok(brain.memories.get(other.id));
});

// ===========================================================================
// 6. HTTP 层：GET /api/contexts 的 scope 收口（apps/server）
// ===========================================================================

test('12. HTTP：GET /api/contexts 默认只列本 scope；?scopeId= 才能列对方', async () => {
  const tmp = await createTempBrain({ seed: false });
  const server = await startTestServer({ dbPath: tmp.dbPath });
  try {
    const now = '2026-10-28T10:00:00.000Z';
    const local = '2026-10-28T18:00:00.000+08:00';
    /** @param {string} id @param {string} scopeId */
    const insertPackage = (id, scopeId) => {
      tmp.brain.db
        .prepare(
          `INSERT INTO context_packages (
             context_id, scope_id, person_id, session_id, turn_id, policy_version,
             tokenizer_id, estimated_tokens, memory_versions, deletion_epoch, payload_hash,
             status, built_at, built_at_local, created_at, created_at_local
           ) VALUES (?, ?, 'owner', 'sess-http-scope', 'turn-1', 'm2.0',
                     'estimate:chars/2.5', 10, '[]', 0, ?,
                     'built', ?, ?, ?, ?)`,
        )
        .run(id, scopeId, `sha256:payload-${id}`, now, local, now, local);
    };
    insertPackage('ctx-http-a', SCOPE_A);
    insertPackage('ctx-http-b', SCOPE_B);

    const plain = await server.request('/api/contexts', { query: { sessionId: 'sess-http-scope' } });
    assert.equal(plain.status, 200);
    assert.deepEqual(
      plain.json.items.map((i) => i.contextId),
      ['ctx-http-a'],
      '不声明 scope 的列表不许出现别的 scope',
    );

    // 显式声明 B 才列得到对方（与 /api/memories 的 ?scopeId= 同口径）
    const declared = await server.request('/api/contexts', {
      query: { sessionId: 'sess-http-scope', scopeId: SCOPE_B },
    });
    assert.deepEqual(declared.json.items.map((i) => i.contextId), ['ctx-http-b']);

    // 详情：跨 scope 404 且与「真不存在」同形；显式 scopeId 才 200
    const denied = await server.request('/api/context/ctx-http-b');
    assert.equal(denied.status, 404);
    assert.equal(denied.json.error.code, 'NOT_FOUND');
    const ghost = await server.request('/api/context/ctx-http-ghost');
    assert.equal(ghost.status, 404);
    assert.equal(ghost.json.error.code, denied.json.error.code, '越界与「不存在」必须同码');

    const own = await server.request('/api/context/ctx-http-a');
    assert.equal(own.status, 200);
    const crossed = await server.request('/api/context/ctx-http-b', { query: { scopeId: SCOPE_B } });
    assert.equal(crossed.status, 200);
    assert.equal(crossed.json.package.scopeId, SCOPE_B);

    // allowCrossScope 不许从 HTTP 暴露
    const sneaky = await server.request('/api/context/ctx-http-b', { query: { allowCrossScope: 'true' } });
    assert.equal(sneaky.status, 404, 'URL 上的 allowCrossScope 必须被忽略');
    const sneakyList = await server.request('/api/contexts', {
      query: { sessionId: 'sess-http-scope', allowCrossScope: 'true' },
    });
    assert.equal(
      sneakyList.json.items.some((i) => i.contextId === 'ctx-http-b'),
      false,
      '列表接口同样不许接受 allowCrossScope',
    );
  } finally {
    await server.close();
    await tmp.close();
  }
});
