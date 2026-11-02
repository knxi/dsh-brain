// @ts-check
/**
 * 系统 4 · 人格版本管理（`persona.js`）。
 *
 * 验收清单：
 *  1. 五层校验：未知层 / 非对象层一律拒
 *  2. 版本号自增（同一事务里算 + 插），`parent_version` 与 `diff_json` 对得上
 *  3. `diffVersions` 字段级差异（added / removed / changed），并写回 `diff_json`
 *  4. `detectConflicts`：身份与边界类**永远 unresolved**，即使调用方要求自动消解
 *  5. `activate`：同 profile 只能一个 active（部分唯一索引兜底），旧版 superseded
 *  6. `rollback`：旧版重新激活、当前 active 置 rolled_back、**版本行数不变**
 *  7. `renderForContext`：超预算截断并标 `truncated:true`，锁定层优先保留
 *  8. 跨 scope：另一个 scope 读不到、激活不了
 */

import test from 'node:test';
import {
  PERSONA_MD,
  assert,
  countRows,
  createRig,
  getRow,
  writePersonaFile,
} from './helpers.mjs';

/** A 版：基线。 */
const LAYERS_A = Object.freeze({
  locked: {
    identity: { name: '小狐狸', role: '独立个体', notes: [] },
    boundaries: ['你的隐私归你'],
    taboos: ['不许外发'],
  },
  base: {
    values: ['值得托付'],
    tone: { personality: ['温柔，但有骨头'], expression: ['结论先行'], notes: [] },
    address: { term: '主人', avoid: '你', notes: [] },
    relationshipDefaults: { stance: null, notes: [] },
    examples: [],
    longTermDirectives: ['本机的事直接做'],
  },
  learned: {},
  userOverride: {},
  transient: {},
});

/** B 版：改了边界与语气（用来制造 identity/boundary/style 三类差异）。 */
const LAYERS_B = Object.freeze({
  ...LAYERS_A,
  locked: {
    identity: { name: '小狐狸', role: '独立个体 + 你的搭档', notes: [] },
    boundaries: ['你的隐私归你', '不骗你'],
    taboos: ['不许外发'],
  },
  base: {
    ...LAYERS_A.base,
    tone: { personality: ['温柔，但有骨头', '有点小脾气'], expression: ['结论先行'], notes: [] },
  },
});

/**
 * 建一个 profile（走导入，省得手搓 profile 行）。
 * @param {{ persona: any, dir: string }} rig
 */
async function ensureProfile(rig) {
  const filePath = writePersonaFile(rig.dir, PERSONA_MD);
  const imported = await rig.persona.profiles.importFromFile({ filePath });
  return imported.profileId;
}

test('createVersion：五层校验（未知层 / 非对象层一律拒）', async (t) => {
  const rig = createRig(t);
  const profileId = await ensureProfile(rig);
  await assert.rejects(
    () => rig.persona.versions.createVersion({ profileId, layers: { locked: {}, unknownLayer: {} } }),
    (err) => err.code === 'INVALID_ARGUMENT' && /未知层/.test(err.message),
  );
  await assert.rejects(
    () => rig.persona.versions.createVersion({ profileId, layers: { locked: ['不是对象'] } }),
    (err) => err.code === 'INVALID_ARGUMENT',
  );
  assert.equal(countRows(rig.brain.db, 'persona_versions'), 1, '被拒的建版不许落库');
});

test('createVersion：版本号自增 + parent_version + diff_json', async (t) => {
  const rig = createRig(t);
  const profileId = await ensureProfile(rig);
  const v2 = await rig.persona.versions.createVersion({ profileId, layers: LAYERS_A, changeReason: '手工一版' });
  assert.equal(v2.version, 2);
  assert.equal(v2.status, 'draft');
  assert.ok(v2.tokens > 0);

  const v3 = await rig.persona.versions.createVersion({ profileId, layers: LAYERS_B, changeReason: '改了边界', parentVersion: 2 });
  assert.equal(v3.version, 3);
  assert.ok(Array.isArray(v3.diff.changed) && v3.diff.changed.length >= 1, '建版时就该算好与父版本的差异');

  const row = getRow(rig.brain.db, 'SELECT * FROM persona_versions WHERE id = ?', [v3.id]);
  assert.equal(Number(row.parent_version), 2);
  const diff = JSON.parse(String(row.diff_json));
  assert.ok(diff.changed.some((entry) => entry.field === 'boundaries'));
});

test('diffVersions：字段级差异并写回 to 版本的 diff_json', async (t) => {
  const rig = createRig(t);
  const profileId = await ensureProfile(rig);
  const v2 = await rig.persona.versions.createVersion({ profileId, layers: LAYERS_A });
  const v3 = await rig.persona.versions.createVersion({ profileId, layers: LAYERS_B });

  // 先把 to 版本的 diff 抹掉，确认 diffVersions 会重算并写回
  rig.brain.db.prepare("UPDATE persona_versions SET diff_json = '{}' WHERE id = ?").run(v3.id);
  const diff = await rig.persona.versions.diffVersions({ fromId: v2.id, toId: v3.id });

  assert.equal(diff.fromVersion, 2);
  assert.equal(diff.toVersion, 3);
  const boundaryEntry = diff.changed.find((entry) => entry.path === 'locked.boundaries');
  assert.ok(boundaryEntry, 'boundaries 改了要出现在 changed 里');
  assert.deepEqual(boundaryEntry.itemsAdded, ['不骗你']);
  assert.deepEqual(boundaryEntry.itemsRemoved, []);
  const identityEntry = diff.changed.find((entry) => entry.path === 'locked.identity.role');
  assert.ok(identityEntry, '嵌套字段要按路径给出（字段级，不是整层级）');
  assert.deepEqual(identityEntry.from, '独立个体');
  assert.deepEqual(identityEntry.to, '独立个体 + 你的搭档');

  const row = getRow(rig.brain.db, 'SELECT diff_json FROM persona_versions WHERE id = ?', [v3.id]);
  const persisted = JSON.parse(String(row.diff_json));
  assert.ok(persisted.changed.length >= 1, 'diffVersions 必须把结果写回 diff_json');
});

test('detectConflicts：身份与边界类永远 unresolved，绝不自动消解', async (t) => {
  const rig = createRig(t);
  const profileId = await ensureProfile(rig);
  await rig.persona.versions.createVersion({ profileId, layers: LAYERS_A });
  await rig.persona.versions.createVersion({ profileId, layers: LAYERS_B });

  const result = await rig.persona.versions.detectConflicts({
    profileId,
    fromVersion: 2,
    toVersion: 3,
    // **故意**把三类都塞进 autoResolve：身份/边界/矛盾必须无视它
    autoResolve: ['identity', 'boundary', 'style', 'preference', 'contradiction'],
  });

  const identityConflict = result.conflicts.find((conflict) => conflict.kind === 'identity');
  const boundaryConflict = result.conflicts.find((conflict) => conflict.kind === 'boundary');
  const styleConflict = result.conflicts.find((conflict) => conflict.kind === 'style');
  assert.ok(identityConflict, '身份文案改了必须有 identity 冲突');
  assert.equal(identityConflict.resolution, 'unresolved', '身份冲突不许自动消解（等于自己给自己改底线）');
  assert.ok(boundaryConflict);
  assert.equal(boundaryConflict.resolution, 'unresolved', '边界冲突同理');
  assert.ok(styleConflict);
  assert.equal(styleConflict.resolution, 'keep_new', '风格类可以在显式要求时自动取新值');

  const rows = rig.brain.db.prepare('SELECT * FROM persona_conflicts WHERE profile_id = ?').all(profileId);
  assert.equal(rows.length, result.conflicts.length);
  assert.ok(rows.every((row) => ['identity', 'boundary', 'style', 'preference', 'contradiction'].includes(String(row.kind))));
});

test('detectConflicts 幂等：同样的差异不重复写冲突行', async (t) => {
  const rig = createRig(t);
  const profileId = await ensureProfile(rig);
  await rig.persona.versions.createVersion({ profileId, layers: LAYERS_A });
  await rig.persona.versions.createVersion({ profileId, layers: LAYERS_B });

  const first = await rig.persona.versions.detectConflicts({ profileId, fromVersion: 2, toVersion: 3 });
  const before = countRows(rig.brain.db, 'persona_conflicts');
  const second = await rig.persona.versions.detectConflicts({ profileId, fromVersion: 2, toVersion: 3 });
  assert.equal(countRows(rig.brain.db, 'persona_conflicts'), before, '重跑不刷屏');
  assert.equal(second.conflicts.length, first.conflicts.length);
  assert.ok(second.conflicts.every((conflict) => conflict.duplicate === true));
});

test('activate：同 profile 只能一个 active，旧版 superseded，重复激活幂等', async (t) => {
  const rig = createRig(t);
  const profileId = await ensureProfile(rig);
  const v2 = await rig.persona.versions.createVersion({ profileId, layers: LAYERS_A });
  const v3 = await rig.persona.versions.createVersion({ profileId, layers: LAYERS_B });

  const first = await rig.persona.versions.activate(v2.id, { by: 'owner', reason: '先上 A' });
  assert.equal(first.activated, true);
  assert.deepEqual(first.superseded, []);

  const again = await rig.persona.versions.activate(v2.id, { by: 'owner' });
  assert.equal(again.activated, false);
  assert.equal(again.alreadyActive, true, '重复激活要幂等，不许来回刷状态');

  const second = await rig.persona.versions.activate(v3.id, { by: 'owner', reason: '换 B' });
  assert.equal(second.activated, true);
  assert.deepEqual(second.superseded.map((item) => item.version), [2]);

  const activeAll = rig.brain.db.prepare("SELECT COUNT(*) AS n FROM persona_versions WHERE status = 'active'").get();
  assert.equal(Number(activeAll?.n ?? 0), 1, '整个库只能有一个 active 版本');
  const actives = rig.brain.db.prepare("SELECT version FROM persona_versions WHERE profile_id = ? AND status = 'active'").all(profileId);
  assert.deepEqual(actives.map((row) => Number(row.version)), [3]);
  const superseded = getRow(rig.brain.db, 'SELECT status, deactivated_at FROM persona_versions WHERE id = ?', [v2.id]);
  assert.equal(superseded.status, 'superseded');
  assert.ok(superseded.deactivated_at, '被替换的版本要留 deactivated_at');

  // schema 级兜底：绕过门面直插第二个 active 必须被部分唯一索引挡住
  assert.throws(
    () => rig.brain.db.prepare("UPDATE persona_versions SET status = 'active' WHERE id = ?").run(v2.id),
    /UNIQUE constraint failed/,
    'ux_persona_versions_active 必须挡住「两个人格同时激活」',
  );
});

test('activate：版本不存在 → NOT_FOUND（别静默成功）', async (t) => {
  const rig = createRig(t);
  await assert.rejects(
    () => rig.persona.versions.activate('pver_missing', { by: 'owner' }),
    (err) => err.code === 'NOT_FOUND',
  );
});

test('rollback：旧版重新激活、当前 active 置 rolled_back、版本行数不变', async (t) => {
  const rig = createRig(t);
  const profileId = await ensureProfile(rig);
  const v2 = await rig.persona.versions.createVersion({ profileId, layers: LAYERS_A });
  const v3 = await rig.persona.versions.createVersion({ profileId, layers: LAYERS_B });
  await rig.persona.versions.activate(v2.id, { by: 'owner' });
  await rig.persona.versions.activate(v3.id, { by: 'owner' });
  const totalBefore = countRows(rig.brain.db, 'persona_versions');

  const rolled = await rig.persona.versions.rollback({ profileId, toVersion: 2, by: 'owner', reason: 'B 版边界不对' });
  assert.equal(rolled.rolledBack, true);
  assert.equal(rolled.activeVersion, 2);
  assert.deepEqual(rolled.rolledBackFrom, [3]);
  assert.equal(countRows(rig.brain.db, 'persona_versions'), totalBefore, '回滚不许删版本（版本历史是账）');

  const v3Row = getRow(rig.brain.db, 'SELECT status FROM persona_versions WHERE id = ?', [v3.id]);
  assert.equal(v3Row.status, 'rolled_back');
  const active = rig.persona.versions.getActive({ profileId });
  assert.equal(active.version, 2);

  const again = await rig.persona.versions.rollback({ profileId, toVersion: 2, by: 'owner' });
  assert.equal(again.rolledBack, false);
  assert.equal(again.alreadyActive, true);
});

test('renderForContext：锁定核心优先，超预算按优先级截断并标 truncated', async (t) => {
  const rig = createRig(t);
  const profileId = await ensureProfile(rig);
  const v2 = await rig.persona.versions.createVersion({ profileId, layers: LAYERS_B });
  await rig.persona.versions.activate(v2.id, { by: 'owner' });

  const full = rig.persona.versions.renderForContext({ profileId, maxTokens: 2000 });
  assert.equal(full.truncated, false);
  assert.match(full.text, /## 我是谁/);
  assert.match(full.text, /小狐狸/);
  assert.match(full.text, /## 底线与禁忌（不可自动改写）/);
  assert.match(full.text, /称呼：叫「主人」/);

  const tight = rig.persona.versions.renderForContext({ profileId, maxTokens: 32 });
  assert.equal(tight.truncated, true, '预算不够要如实标 truncated');
  assert.match(tight.text, /已按优先级截断/);
  assert.ok(tight.tokens <= 32 + 20, '截断后不该超预算太多');
  assert.match(tight.text, /小狐狸/, '锁定层必须优先保留：先截掉的应该是例子/指令，不是身份');
});

test('renderForContext：还没激活时退回最新版并如实标 draft', async (t) => {
  const rig = createRig(t);
  const profileId = await ensureProfile(rig);
  const v2 = await rig.persona.versions.createVersion({ profileId, layers: LAYERS_A });
  const rendered = rig.persona.versions.renderForContext({ profileId });
  assert.equal(rendered.versionId, v2.id, '没激活也要能渲染（否则导入完就看不了效果）');
  assert.equal(rendered.status, 'draft', '但要如实说它是 draft，不假装已生效');
});

test('跨 scope：另一个 scope 读不到档案/版本，也激活不了', async (t) => {
  const rig = createRig(t);
  const profileId = await ensureProfile(rig);
  const v2 = await rig.persona.versions.createVersion({ profileId, layers: LAYERS_A });

  const { createPersona } = await import('../../packages/persona/src/index.js');
  const personaB = createPersona({
    db: rig.brain.db,
    queue: rig.brain.queue,
    clock: rig.brain.clock,
    workspace: null,
    bindings: { scope_id: 'scope-beta', person_id: 'owner' },
  });
  assert.equal(personaB.versions.get({ id: v2.id }), null);
  assert.deepEqual(personaB.versions.list({ profileId }).items, []);
  await assert.rejects(
    () => personaB.versions.activate(v2.id, { by: 'owner' }),
    (err) => err.code === 'NOT_FOUND',
    '跨 scope 激活必须失败（不是「激活了别人的版本」）',
  );
  assert.equal(rig.persona.versions.getActive({ profileId }), null, '别人的失败操作不许影响本 scope');
});

test('resolveConflict：必须给处置人和处置方式，处置后能按 resolution 过滤', async (t) => {
  const rig = createRig(t);
  const profileId = await ensureProfile(rig);
  await rig.persona.versions.createVersion({ profileId, layers: LAYERS_A });
  await rig.persona.versions.createVersion({ profileId, layers: LAYERS_B });
  await rig.persona.versions.detectConflicts({ profileId, fromVersion: 2, toVersion: 3 });
  const open = rig.persona.versions.listConflicts({ profileId, resolution: 'unresolved' });
  assert.ok(open.items.length >= 2);

  await assert.rejects(
    () => rig.persona.versions.resolveConflict({ conflictId: open.items[0].id, resolution: 'keep_old' }),
    (err) => err.code === 'INVALID_ARGUMENT',
    '没有处置人（by）不许改冲突结论',
  );

  const resolved = await rig.persona.versions.resolveConflict({
    conflictId: open.items[0].id,
    resolution: 'keep_old',
    by: 'owner',
  });
  assert.equal(resolved.resolution, 'keep_old');
  const after = rig.persona.versions.listConflicts({ profileId, resolution: 'keep_old' });
  assert.equal(after.items.length, 1);

  const row = getRow(rig.brain.db, 'SELECT resolved_at, resolved_by FROM persona_conflicts WHERE id = ?', [open.items[0].id]);
  assert.ok(row.resolved_at);
  assert.equal(row.resolved_by, 'owner');
});
