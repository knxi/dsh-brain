// @ts-check
/**
 * `contextPackages` 门面 + 0003 迁移。
 *
 * 压的是 M2 两条验收项：
 * 1.「检索结果必有预算说明」→ `budget_json` 要完整往返（含 `dropped[]` 的丢弃理由、
 *    `estimated` / `tokenizerId` 的估算凭据）。
 * 2.「`built → attached → sent` 三级证据链完整可查」→ 状态只能单向推进、
 *    carrier 锁定、首次证据时间不刷。
 */

import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { assert, MIGRATIONS_DIR, SCOPE_A, createBrain, fixedClock } from './helpers.mjs';
import { openDatabase } from '../../../packages/memory/src/db.js';
import { applyMigrations, listMigrations, loadMigrations, rollbackLastMigration } from '../../../packages/memory/src/migrator.js';

/**
 * 造一个符合 context2 交付形状的 ContextPackage（多段、有丢弃项、有估算凭据）。
 * @param {Record<string, unknown>} [overrides]
 */
function contextPackage(overrides = {}) {
  return {
    contextId: 'ctx_test_1',
    builtAt: '2026-10-28T10:00:00.000Z',
    policyVersion: 'm2.0',
    scopeId: SCOPE_A,
    personId: 'owner',
    sessionId: 'sess-1',
    turnId: 'turn-1',
    stepId: 'step-1',
    segments: [
      {
        memoryId: 'mem_card',
        version: 3,
        layer: 'long',
        type: 'semantic',
        summary: '名片：铜版纸 300g / 90×54mm',
        contentHash: 'sha256:aaaa',
        sourceRefs: [{ id: 'ref_1', sourceEventId: 'evt-1' }],
        evidenceKind: 'owner_words',
        validFrom: null,
        validUntil: null,
        score: 0.9,
      },
      {
        memoryId: 'mem_brochure',
        version: 1,
        layer: 'long',
        type: 'semantic',
        summary: '画册：250g 哑粉 / 210×285mm',
        contentHash: 'sha256:bbbb',
        sourceRefs: [{ id: 'ref_2', sourceEventId: 'evt-2' }],
        evidenceKind: 'owner_words',
        validFrom: null,
        validUntil: null,
        score: 0.5,
      },
    ],
    injectedText: '1. 名片 (mem_card; sources=ref_1)\n2. 画册 (mem_brochure; sources=ref_2)',
    estimatedTokens: 180,
    tokenizerId: 'estimate:cjk1/ascii4',
    canonicalHash: 'sha256:0123456789abcdef',
    budget: {
      brainAllowance: 2048,
      used: 180,
      dropped: [{ memoryId: 'mem_scaffold', reason: 'over_budget', detail: '超出 brain_allowance', score: 0.2 }],
      formula: 'max(0, min(brainCap, modelWindow - hostInputTokens - outputReserve - safetyMargin))',
      safetyMargin: 1024,
      brainCap: 2048,
      modelWindow: 65536,
      hostInputTokens: 20000,
      outputReserve: 4096,
      estimated: true,
      hostInputSource: 'runtime-context:estimated',
      tokenizerId: 'estimate:cjk1/ascii4',
      notes: ['hostInput 是估算值'],
    },
    diagnostics: { status: 'ok', reasons: [], evidenceStrength: 'primary', segmentedFallback: false },
    status: 'built',
    carrier: null,
    ...overrides,
  };
}

test('save：幂等（同 contextId 只留一条，不刷首次时间与内容）', async (t) => {
  const { brain } = createBrain(t);
  const first = await brain.contextPackages.save(contextPackage());
  assert.deepEqual(first, { id: 'ctx_test_1', created: true, status: 'built' });

  const second = await brain.contextPackages.save(
    contextPackage({ injectedText: '完全不同的内容', estimatedTokens: 9999, builtAt: '2026-10-29T00:00:00.000Z' }),
  );
  assert.equal(second.created, false, '重复 save 必须能识别出来（context2 的「先 get 再 save」是进程内兜底，真正的幂等在这里）');
  assert.equal(second.status, 'built');

  const rows = /** @type {Array<Record<string, unknown>>} */ (
    brain.db.prepare('SELECT * FROM context_packages WHERE context_id = ?').all('ctx_test_1')
  );
  assert.equal(rows.length, 1);
  assert.equal(Number(rows[0].estimated_tokens), 180, '重复 save 不许覆盖已有内容');
  assert.equal(String(rows[0].built_at), '2026-10-28T10:00:00.000Z', '重复 save 不许刷 built_at');
  assert.equal(brain.contextPackages.list({ sessionId: 'sess-1' }).items.length, 1);
});

test('save：只能以 status=built 出生（不许自称 attached/sent）', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(
    () => brain.contextPackages.save(contextPackage({ status: 'sent' })),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /built/);
      return true;
    },
  );
});

test('save：缺 canonicalHash 直接拒（sent 判据不能没有基底）', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(
    () => brain.contextPackages.save(contextPackage({ canonicalHash: undefined })),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /canonicalHash/);
      return true;
    },
  );
});

test('预算说明完整往返：allowance / used / dropped[] / 估算凭据 都不许丢', async (t) => {
  const { brain } = createBrain(t);
  await brain.contextPackages.save(contextPackage());
  const pkg = brain.contextPackages.get('ctx_test_1');
  assert.ok(pkg);

  const budget = /** @type {Record<string, any>} */ (pkg.budget);
  assert.equal(budget.brainAllowance, 2048);
  assert.equal(budget.used, 180);
  assert.equal(budget.dropped.length, 1);
  assert.equal(budget.dropped[0].memoryId, 'mem_scaffold');
  assert.equal(budget.dropped[0].reason, 'over_budget', '被丢弃的段必须带理由（控制台要展示「为什么没注入」）');
  assert.equal(budget.dropped[0].detail, '超出 brain_allowance');
  // 估算凭据：这两个字段决定控制台能不能说「这是估算值」
  assert.equal(budget.estimated, true);
  assert.equal(budget.tokenizerId, 'estimate:cjk1/ascii4');
  assert.equal(budget.hostInputSource, 'runtime-context:estimated');
  assert.match(String(budget.formula), /brainAllowance|brainCap/);
  // 顶层也不许把估算当精确
  assert.equal(pkg.tokenizerId, 'estimate:cjk1/ascii4');
  assert.equal(pkg.estimatedTokens, 180);
});

test('三级证据链：built → attached → sent 单向推进，时间与 carrier 都留痕', async (t) => {
  const { brain, fc } = createBrain(t);
  await brain.contextPackages.save(contextPackage());

  fc.advance(1000);
  const attached = await brain.contextPackages.updateStatus('ctx_test_1', {
    status: 'attached',
    carrier: 'messages[role=system]',
    evidence: { attached: { carrier: 'messages[role=system]', observed: true } },
  });
  assert.equal(attached.status, 'attached');
  assert.equal(attached.previousStatus, 'built');
  assert.equal(attached.idempotent, false);

  fc.advance(1000);
  const sent = await brain.contextPackages.updateStatus('ctx_test_1', {
    status: 'sent',
    evidence: { sent: { evidence_level: 'request_object', proves_wire_delivery: false, observed_hash_locations: ['messages[role=system]'] } },
  });
  assert.equal(sent.status, 'sent');

  const pkg = /** @type {Record<string, any>} */ (brain.contextPackages.get('ctx_test_1'));
  assert.equal(pkg.status, 'sent');
  assert.equal(pkg.carrier, 'messages[role=system]');
  assert.ok(pkg.attachedAt, 'attached_at 必须留痕');
  assert.ok(pkg.sentAt, 'sent_at 必须留痕');
  // 契约 10.9：找到 ≠ 出网，proves_wire_delivery 必须如实存 false
  assert.equal(pkg.sentEvidence.sent.proves_wire_delivery, false);
  assert.deepEqual(pkg.sentEvidence.sent.observed_hash_locations, ['messages[role=system]']);
  assert.equal(pkg.sentEvidence.attached.observed, true, 'attached 阶段证据要保留，不能被 sent 覆盖');
});

test('carrier 支持三种真实承载形态（Brain 的注入走 messages[user]）', async (t) => {
  const { brain } = createBrain(t);
  // 三种不是同义词：system prompt 走独立字段 / 物化进 messages / Brain 注入物化成 user 消息。
  // connector2 在 llm/stream 观测到 Brain 的注入落在 user 角色消息里（M0 探针 §2 Q2），
  // 所以 messages[user] 必须能记，否则只能谎报成 messages[role=system]。
  for (const [index, carrier] of ['system', 'messages[role=system]', 'messages[user]'].entries()) {
    const contextId = `ctx_carrier_${index}`;
    await brain.contextPackages.save(contextPackage({ contextId }));
    await brain.contextPackages.updateStatus(contextId, { status: 'attached', carrier });
    assert.equal(brain.contextPackages.get(contextId).carrier, carrier, `${carrier} 必须能被记下来`);
  }

  // 词表外的承载仍然拒绝（不许随手编一个位置）
  await assert.rejects(
    () => brain.contextPackages.updateStatus('ctx_carrier_0', { status: 'sent', carrier: 'messages[assistant]' }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /carrier/);
      return true;
    },
  );
});

test('跳级 built → sent 被拒（no_skip）', async (t) => {
  const { brain } = createBrain(t);
  await brain.contextPackages.save(contextPackage());
  await assert.rejects(
    () => brain.contextPackages.updateStatus('ctx_test_1', { status: 'sent' }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.equal(err.details.rule, 'no_skip', '错误里必须带规则名，调用方才好区别对待');
      assert.equal(err.details.from, 'built');
      assert.equal(err.details.to, 'sent');
      return true;
    },
  );
  assert.equal(brain.contextPackages.get('ctx_test_1').status, 'built', '被拒的推进不许改状态');
});

test('回退 sent → attached 被拒（no_regression）', async (t) => {
  const { brain } = createBrain(t);
  await brain.contextPackages.save(contextPackage());
  await brain.contextPackages.updateStatus('ctx_test_1', { status: 'attached' });
  await brain.contextPackages.updateStatus('ctx_test_1', { status: 'sent' });
  await assert.rejects(
    () => brain.contextPackages.updateStatus('ctx_test_1', { status: 'attached' }),
    (err) => {
      assert.equal(err.details.rule, 'no_regression');
      return true;
    },
  );
  assert.equal(brain.contextPackages.get('ctx_test_1').status, 'sent');
});

test('carrier 锁定：换个承载体提交证据被拒（carrier_locked），同状态也一样', async (t) => {
  const { brain } = createBrain(t);
  await brain.contextPackages.save(contextPackage());
  await brain.contextPackages.updateStatus('ctx_test_1', { status: 'attached', carrier: 'system' });

  // 推进时换 carrier
  await assert.rejects(
    () => brain.contextPackages.updateStatus('ctx_test_1', { status: 'sent', carrier: 'messages[role=system]' }),
    (err) => {
      assert.equal(err.details.rule, 'carrier_locked');
      return true;
    },
  );
  // **同状态**重复 mark 时换 carrier 也必须拒（早期版本会静默吞掉）
  await assert.rejects(
    () => brain.contextPackages.updateStatus('ctx_test_1', { status: 'attached', carrier: 'messages[role=system]' }),
    (err) => {
      assert.equal(err.details.rule, 'carrier_locked');
      return true;
    },
  );
  assert.equal(brain.contextPackages.get('ctx_test_1').carrier, 'system', '锁定后不许被改');
});

test('首次证据时间不刷：重复 mark 不改 attached_at / sent_at', async (t) => {
  const { brain, fc } = createBrain(t, { startIso: '2026-10-28T10:00:00.000Z' });
  await brain.contextPackages.save(contextPackage());
  await brain.contextPackages.updateStatus('ctx_test_1', { status: 'attached' });
  const firstAttached = brain.contextPackages.get('ctx_test_1').attachedAt;

  fc.advance(60_000);
  const again = await brain.contextPackages.updateStatus('ctx_test_1', { status: 'attached' });
  assert.equal(again.idempotent, true);
  assert.equal(brain.contextPackages.get('ctx_test_1').attachedAt, firstAttached, '重复 mark 不许把首次证据时间改成后来那次');
});

test('注入文本只存指纹，不落原文（隐私与体积）', async (t) => {
  const { brain } = createBrain(t);
  const pkg = contextPackage();
  await brain.contextPackages.save(pkg);
  const stored = /** @type {Record<string, unknown>} */ (
    brain.db.prepare('SELECT * FROM context_packages WHERE context_id = ?').get('ctx_test_1')
  );
  assert.ok(stored.injected_text_hash, '必须有注入文本指纹');
  assert.match(String(stored.injected_text_hash), /^sha256:[0-9a-f]{64}$/);
  // 全文不许出现在任何列里
  const haystack = Object.values(stored).map((v) => (v == null ? '' : String(v))).join('\u0000');
  assert.equal(haystack.includes('sources=ref_1'), false, '注入全文不许落库（含记忆正文，隐私 + 体积）');
  // 但段摘要要留，检查器靠它还原「注入了什么」
  const restored = /** @type {Record<string, any>} */ (brain.contextPackages.get('ctx_test_1'));
  assert.equal(restored.segments.length, 2);
  assert.equal(restored.segments[0].summary, '名片：铜版纸 300g / 90×54mm');
  assert.deepEqual(restored.memoryVersions, [
    { memoryId: 'mem_card', version: 3 },
    { memoryId: 'mem_brochure', version: 1 },
  ]);
});

test('弱证据强度落库，便于控制台做徽章（primary / ngram_fallback / unknown）', async (t) => {
  const { brain } = createBrain(t);
  await brain.contextPackages.save(contextPackage({ contextId: 'ctx_primary' }));
  await brain.contextPackages.save(
    contextPackage({
      contextId: 'ctx_weak',
      diagnostics: { status: 'insufficient_evidence', reasons: ['覆盖度不足'], evidenceStrength: 'ngram_fallback', segmentedFallback: false },
    }),
  );
  await brain.contextPackages.save(
    contextPackage({ contextId: 'ctx_unknown', diagnostics: { status: 'ok', reasons: [], evidenceStrength: undefined } }),
  );

  assert.equal(brain.contextPackages.get('ctx_primary').evidenceStrength, 'primary');
  assert.equal(brain.contextPackages.get('ctx_weak').evidenceStrength, 'ngram_fallback');
  assert.equal(brain.contextPackages.get('ctx_unknown').evidenceStrength, 'unknown', '缺省不许猜成 primary');
  assert.deepEqual(
    brain.contextPackages.get('ctx_weak').diagnostics.reasons,
    ['覆盖度不足'],
    '诊断理由要落库，控制台要能显示「为什么降级」',
  );
});

test('list：按 session/turn/step 过滤 + 键集分页', async (t) => {
  const { brain } = createBrain(t);
  for (let i = 0; i < 5; i += 1) {
    await brain.contextPackages.save(
      contextPackage({
        contextId: `ctx_${i}`,
        builtAt: `2026-10-28T10:0${i}:00.000Z`,
        sessionId: i < 3 ? 'sess-1' : 'sess-2',
        turnId: `turn-${i % 2}`,
        stepId: `step-${i}`,
      }),
    );
  }
  assert.equal(brain.contextPackages.list({ sessionId: 'sess-1' }).items.length, 3);
  assert.equal(brain.contextPackages.list({ sessionId: 'sess-2' }).items.length, 2);
  assert.equal(brain.contextPackages.list({ sessionId: 'sess-1', turnId: 'turn-0' }).items.length, 2);

  const page1 = brain.contextPackages.list({ limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.nextCursor);
  const page2 = brain.contextPackages.list({ limit: 2, cursor: page1.nextCursor });
  const page3 = brain.contextPackages.list({ limit: 2, cursor: page2.nextCursor });
  const ids = [...page1.items, ...page2.items, ...page3.items].map((item) => item.id);
  assert.equal(new Set(ids).size, 5, '分页不许重复');
  assert.equal(ids.length, 5, '分页不许遗漏');
});

test('get 不存在返回 null（检查器不能因缺记录崩）', async (t) => {
  const { brain } = createBrain(t);
  assert.equal(brain.contextPackages.get('ctx_not_exist'), null);
  assert.throws(() => brain.contextPackages.get(''), (err) => {
    assert.equal(err.code, 'INVALID_ARGUMENT');
    return true;
  });
});

test('updateStatus 对不存在的构包报 NOT_FOUND', async (t) => {
  const { brain } = createBrain(t);
  await assert.rejects(
    () => brain.contextPackages.updateStatus('ctx_not_exist', { status: 'attached' }),
    (err) => {
      assert.equal(err.code, 'NOT_FOUND');
      return true;
    },
  );
});

test('0003 迁移：三个版本按序应用，重复执行幂等，可回滚且不伤 0001/0002', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m3-'));
  const opened = openDatabase({ path: path.join(dir, 'brain.db') });
  t.after(() => {
    try {
      opened.db.close();
    } catch {
      /* ignore */
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  const fc = fixedClock();
  const columnNames = (/** @type {string} */ table) =>
    /** @type {Array<{ name: string }>} */ (opened.db.prepare(`PRAGMA table_info(${table})`).all()).map((row) => row.name);

  const first = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  // 版本序列跟随磁盘上的迁移（0005 由 M3 备份恢复线加入）
  const expectedVersions = loadMigrations(MIGRATIONS_DIR).map((migration) => migration.version);
  assert.deepEqual(first.applied, expectedVersions);
  assert.equal(first.currentVersion, expectedVersions[expectedVersions.length - 1]);
  for (const column of ['budget_json', 'carrier', 'sent_evidence_json', 'evidence_strength', 'segments_json', 'diagnostics_json', 'injected_text_hash', 'step_id']) {
    assert.ok(columnNames('context_packages').includes(column), `0003 必须加上 ${column} 列`);
  }

  // 幂等：第二次全跳过，列还在
  const second = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.skipped, expectedVersions);
  assert.ok(columnNames('context_packages').includes('budget_json'));

  // 先把 0003 之后的迁移全部回滚（0005 / 0006…），再回滚 0003：验证 0003 回滚不伤 0001/0002。
  // 用循环而不是写死版本号——以后再加迁移，这段不用跟着改。
  const newerVersions = expectedVersions.filter((version) => Number(version) > Number('0003')).reverse();
  for (const version of newerVersions) {
    const rolledNewer = rollbackLastMigration(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
    assert.equal(rolledNewer.rolledBack, version);
  }
  const rolled = rollbackLastMigration(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.equal(rolled.rolledBack, '0003');
  assert.equal(rolled.currentVersion, '0002');
  assert.equal(columnNames('context_packages').includes('budget_json'), false, '回滚后 0003 的列必须消失');
  assert.ok(opened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'memories'").get(), '回滚 0003 不许伤到 0001 的表');
  assert.ok(
    opened.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'search_fts_char'").get(),
    '回滚 0003 不许伤到 0002 的索引表',
  );

  // 再 apply 能重建
  const again = applyMigrations(opened.db, { dir: MIGRATIONS_DIR, clock: fc.clock });
  assert.deepEqual(again.applied, ['0003', ...newerVersions.slice().reverse()]);
  assert.ok(columnNames('context_packages').includes('budget_json'));
  const rows = listMigrations(opened.db);
  assert.equal(rows.length, expectedVersions.length, '回滚要留痕（不删行）');
  assert.equal(rows.find((row) => row.version === '0003')?.direction, 'up');
});
