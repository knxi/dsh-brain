// @ts-check
/**
 * 构包证据链的**正列**：0003 迁移加的 budget_json / carrier / sent_evidence_json /
 * evidence_strength / segments_json。
 *
 * 这条测试是为一个真实的漏接写的：M2 早期这几列还不存在，检查器一直从
 * `memory_versions` 里猜预算形状，把「有预算说明」显示成「未记录」。
 * 列早就在了，是查询没接上——这里把它钉住。
 */

import test from 'node:test';
import { assert, createTempBrain, startUiServer } from './helpers.mjs';

/** @type {Awaited<ReturnType<typeof startUiServer>>} */
let server;
/** @type {Awaited<ReturnType<typeof createTempBrain>>} */
let tmp;

const NOW = '2026-10-28T12:00:00.000Z';
const LOCAL = '2026-10-28T20:00:00.000+08:00';

test.before(async () => {
  tmp = await createTempBrain();
  const db = tmp.brain.db;

  /**
   * @param {{
   *   id: string, status?: string, budget?: any, carrier?: string|null,
   *   sentEvidence?: any, evidenceStrength?: string|null, segments?: any[],
   *   stepId?: string|null, withBudget: boolean,
   * }} input
   */
  const insert = (input) => {
    db.prepare(
      `INSERT INTO context_packages (
         context_id, scope_id, person_id, session_id, turn_id, step_id, policy_version,
         tokenizer_id, estimated_tokens, memory_versions, deletion_epoch, payload_hash,
         status, built_at, built_at_local, attached_at, attached_at_local,
         sent_at, sent_at_local, created_at, created_at_local,
         budget_json, carrier, sent_evidence_json, evidence_strength, segments_json
       ) VALUES (?, 'owner-default', 'owner', 'session-ctx', 'turn-9', ?, 'm2.0',
                 'estimate:chars/2.5', 742, '[]', 0, ?,
                 ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?)`,
    ).run(
      input.id,
      input.stepId ?? 'step-1',
      `sha256:payload-${input.id}`,
      input.status ?? 'sent',
      NOW,
      LOCAL,
      NOW,
      LOCAL,
      NOW,
      LOCAL,
      NOW,
      LOCAL,
      input.withBudget && input.budget !== undefined ? JSON.stringify(input.budget) : null,
      input.carrier ?? null,
      input.sentEvidence === undefined ? null : JSON.stringify(input.sentEvidence),
      input.evidenceStrength ?? null,
      input.segments === undefined ? null : JSON.stringify(input.segments),
    );
  };

  // A：完整证据——预算 + 载体 + sent 明细 + 检索质量 + 段
  insert({
    id: 'ctx-full-evidence',
    withBudget: true,
    budget: {
      brainAllowance: 2048,
      used: 742,
      dropped: [
        { memoryId: 'mem-m3-ceiling', reason: '低相关（得分 0.11 < 阈值 0.34）' },
        { memoryId: 'mem-gone-forever', reason: '被删除屏障剔除' },
      ],
    },
    carrier: 'messages[role=system]',
    sentEvidence: {
      evidenceLevel: 'request_object_hit',
      provesWireDelivery: false,
      observedHashLocations: ['messages[3]'],
    },
    evidenceStrength: 'ngram_fallback',
    segments: [
      {
        memoryId: 'mem-m3-ceiling',
        version: 1,
        layer: 'long',
        type: 'semantic',
        summary: '客厅吊顶 1.2m，石膏板叠级，灯槽 1200mm',
        contentHash: 'sha256:seg-a',
      },
    ],
  });

  // B：只有预算，没有载体（对照：「有预算」和「载体记了没」是两件事）
  insert({
    id: 'ctx-budget-only',
    status: 'built',
    withBudget: true,
    budget: { brainAllowance: 1024, used: 300, dropped: [] },
  });

  // C：什么都没有（老包）——必须如实说没记录，不许编
  insert({ id: 'ctx-nothing', status: 'built', withBudget: false });

  server = await startUiServer({
    dbPath: tmp.dbPath,
    backupDir: tmp.backupsDir,
    stateDir: tmp.stateDir,
  });
});

test.after(async () => {
  await server?.close();
  await tmp?.close();
});

// ---------------------------------------------------------------------------
// 预算（M2 验收项「必有预算说明」）
// ---------------------------------------------------------------------------

test('budget_json 有数据时，API 必须返回 dropped[] 与额度，而不是「未记录」', async () => {
  const { status, json } = await server.request('/api/context/ctx-full-evidence');
  assert.equal(status, 200, json);
  const budget = json.budget;
  assert.equal(budget.recorded, true, '写了 budget_json 就不能说没记录');
  assert.equal(budget.allowance, 2048);
  assert.equal(budget.used, 742);
  assert.ok(Array.isArray(budget.dropped));
  assert.equal(budget.dropped.length, 2);
  assert.equal(budget.dropped[0].memoryId, 'mem-m3-ceiling');
  assert.match(String(budget.dropped[0].reason), /低相关/);
  // 被丢掉的段要能看出是什么内容（查不到摘要的也要标出来）
  assert.match(String(budget.dropped[0].summary), /吊顶/);
  assert.equal(budget.dropped[0].stillExists, true);
  assert.equal(budget.dropped[1].stillExists, false, '查不到摘要要标 stillExists=false');
  assert.match(String(budget.source), /budget_json/, '要说明数据来自哪一列');
});

test('只有预算没有载体：两件事分开表达', async () => {
  const { json } = await server.request('/api/context/ctx-budget-only');
  assert.equal(json.budget.recorded, true);
  assert.equal(json.budget.dropped.length, 0);
  assert.equal(json.evidence.carrier, null);
  assert.match(String(json.evidence.carrierNote), /未记录/);
});

test('老包（没有 budget_json）：如实说没记录，不编数字', async () => {
  const { json } = await server.request('/api/context/ctx-nothing');
  assert.equal(json.budget.recorded, false);
  assert.equal(json.budget.allowance, null);
  assert.deepEqual(json.budget.dropped, []);
  assert.match(String(json.budget.note), /未记录/);
});

// ---------------------------------------------------------------------------
// 载体与 sent 明细
// ---------------------------------------------------------------------------

test('carrier 列有值时，证据里必须给出实际承载位置（契约 10.9 两级之一）', async () => {
  const { json } = await server.request('/api/context/ctx-full-evidence');
  assert.equal(json.evidence.carrier, 'messages[role=system]');
  assert.match(String(json.evidence.carrierLabel), /messages\[role=system\]/);
  assert.equal(json.package.carrier, 'messages[role=system]');
  // 不再说「未记录」，而是说「已记录 + 是哪一级」
  assert.equal(
    json.evidence.caveats.some((c) => c.includes('没有记录')),
    false,
    '有载体时不能再写「没有记录」',
  );
  assert.ok(json.evidence.caveats.some((c) => c.includes('载体已记录')));
});

test('sent_evidence_json 要透出，且「不证明出网」的边界被复述', async () => {
  const { json } = await server.request('/api/context/ctx-full-evidence');
  assert.ok(json.evidence.sentEvidence, '缺少 sent 证据明细');
  assert.equal(json.evidence.sentEvidence.evidenceLevel, 'request_object_hit');
  assert.equal(json.evidence.sentEvidence.provesWireDelivery, false);
  assert.ok(Array.isArray(json.evidence.sentEvidence.observedHashLocations));
  assert.ok(json.evidence.caveats.some((c) => c.includes('provesWireDelivery=false')));
});

test('evidence_strength 非 primary 时要有弱证据提示', async () => {
  const { json } = await server.request('/api/context/ctx-full-evidence');
  assert.equal(json.package.evidenceStrength, 'ngram_fallback');
  assert.equal(json.evidence.evidenceStrength, 'ngram_fallback');
  assert.ok(json.evidence.caveats.some((c) => c.includes('ngram_fallback')));
});

// ---------------------------------------------------------------------------
// 段与列表
// ---------------------------------------------------------------------------

test('segments_json 优先于 memory_versions，并说明数据来源', async () => {
  const { json } = await server.request('/api/context/ctx-full-evidence');
  assert.equal(json.segments.length, 1);
  assert.equal(json.segments[0].memoryId, 'mem-m3-ceiling');
  assert.match(String(json.segments[0].summary), /吊顶/);
  assert.equal(json.segmentSource, 'segments_json');
  assert.equal(json.package.segmentCount, 1);
  assert.equal(json.package.stepId, 'step-1');
});

test('GET /api/contexts：列表就能看出「有没有预算 / 载体 / 检索质量」', async () => {
  const { json } = await server.request('/api/contexts', { query: { sessionId: 'session-ctx' } });
  assert.equal(json.items.length, 3);
  const byId = Object.fromEntries(json.items.map((i) => [i.contextId, i]));

  assert.equal(byId['ctx-full-evidence'].hasBudget, true);
  assert.equal(byId['ctx-full-evidence'].carrier, 'messages[role=system]');
  assert.equal(byId['ctx-full-evidence'].evidenceStrength, 'ngram_fallback');
  assert.equal(byId['ctx-full-evidence'].segmentCount, 1);

  assert.equal(byId['ctx-budget-only'].hasBudget, true);
  assert.equal(byId['ctx-budget-only'].carrier, null);

  assert.equal(byId['ctx-nothing'].hasBudget, false);
  assert.equal(byId['ctx-nothing'].carrier, null);
});
