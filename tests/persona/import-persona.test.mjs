// @ts-check
/**
 * 系统 4 · 人格导入（`import-persona.js`）。
 *
 * 这一组测试就是这条需求的验收清单：
 *  1. `~/.dsh/AGENTS.md` 那种结构（`## 一、我是谁` + 列表 + 表格）能被字段化成九项
 *  2. 解析不到的字段进 `needsReview`，**不猜**
 *  3. `importFromFile` 建 profile + 首版 `draft` 版本，并算 `source_hash`
 *  4. 文件没改 → 不新建版本（哈希判定）
 *  5. 文件改了 → 新版本 + `diff_json` 有变化
 *  6. **只读**：导入不修改人格文件本身
 *  7. 跨 scope 拒绝；不支持的类型明确报错
 */

import test from 'node:test';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { sha256Hex } from '../../packages/core/src/index.js';
import { parsePersonaMarkdown, layersFromFields } from '../../packages/persona/src/import-persona.js';
import {
  PERSONA_MD,
  SCOPE_B,
  assert,
  countRows,
  createRig,
  getRow,
  writePersonaFile,
} from './helpers.mjs';

test('解析 AGENTS.md 结构：九字段全部有内容，needsReview 为空', () => {
  const parsed = parsePersonaMarkdown(PERSONA_MD);
  const fields = parsed.fields;
  assert.deepEqual(parsed.needsReview, [], '这份文件九个字段都能解析到，不该有待确认项');
  assert.equal(fields.identity.name, '小狐狸');
  assert.equal(fields.identity.role, '独立个体 + 你的搭档');
  assert.match(fields.identity.selfDescription, /小狐狸/);
  assert.ok(fields.identity.notes.includes('我住在你的机器里。'), '### 1.1 子标题要继承上级章节角色');
  assert.deepEqual(fields.values, ['值得托付：说「做完了」就是真做完了。', '严谨到底：不确定就验证。']);
  assert.deepEqual(fields.boundaries, ['你的隐私归你：私事只属于你和我。', '不骗你：没做过的不说做过。']);
  assert.deepEqual(fields.tone.personality, ['温柔，但有骨头：该反对的时候不含糊。', '有判断：不满足于「能跑通」。']);
  assert.deepEqual(fields.tone.expression, ['结论先行：先给结果和判断。', '别句句上表格：复杂信息才用清单压平。']);
  assert.equal(fields.address.term, '主人', '称呼要从「叫「主人」」里抽出来');
  assert.equal(fields.address.avoid, '你');
  assert.equal(fields.longTermDirectives.length, 2, '五、怎么干活 的编号列表 → 长期指令');
  assert.equal(fields.examples.length, 2, '表格行 → 表达示例');
  assert.deepEqual(fields.examples[0], {
    kind: 'table',
    lang: null,
    state: '高兴 / 被夸',
    text: '句子变短、会得瑟一两句',
  });
  assert.ok(
    fields.taboos.some((line) => line.includes('pnpm install')),
    '全局强否定句（不许…）要进 taboos',
  );
  assert.deepEqual(parsed.ignoredSections, ['八之三、别把自己弄丢'], '没匹配到角色的章节要如实列出');
});

test('解析不到的字段进 needsReview：宁可留空，不编一条出来', () => {
  const parsed = parsePersonaMarkdown('# 只有一句话\n\n今天天气不错。\n');
  assert.equal(parsed.needsReview.length, 9, '九个字段全都没解析到，就该列 9 条');
  for (const item of parsed.needsReview) {
    assert.equal(item.reason, 'not_found');
    assert.match(item.detail, /不猜/);
  }
  assert.deepEqual(parsed.fields.values, []);
  assert.equal(parsed.fields.identity.name, null);
  assert.equal(parsed.fields.address.term, null);
});

test('纯函数：同一份文本解析两次结果完全一致', () => {
  const a = parsePersonaMarkdown(PERSONA_MD);
  const b = parsePersonaMarkdown(PERSONA_MD);
  assert.deepEqual(a, b, '解析不能依赖时间/随机数（要能拿来对拍）');
});

test('layersFromFields：身份/边界/禁忌进 locked，其余进 base，学习层留空', () => {
  const { fields } = parsePersonaMarkdown(PERSONA_MD);
  const layers = layersFromFields(fields);
  assert.deepEqual(Object.keys(layers), ['locked', 'base', 'learned', 'userOverride', 'transient']);
  assert.equal(layers.locked.identity.name, '小狐狸');
  assert.equal(layers.locked.boundaries.length, 2);
  assert.ok(Array.isArray(layers.locked.taboos));
  assert.equal(layers.base.values.length, 2);
  assert.equal(layers.base.address.term, '主人');
  assert.deepEqual(layers.learned, {}, '导入不该假装学到了什么');
  assert.deepEqual(layers.userOverride, {}, '导入不该替主人写覆盖层');
});

test('importFromFile：建 profile + 首版 draft，source_hash 是内容 sha256', async (t) => {
  const { persona, dir, brain } = createRig(t);
  const content = PERSONA_MD;
  const filePath = writePersonaFile(dir, content);
  const result = await persona.profiles.importFromFile({ name: 'default', filePath });

  assert.equal(result.created, true);
  assert.equal(result.unchanged, false);
  assert.equal(result.version, 1);
  assert.equal(result.sourceHash, sha256Hex(content), 'source_hash 必须是内容 sha256');
  assert.deepEqual(result.needsReview, []);

  const profileRow = getRow(brain.db, 'SELECT * FROM persona_profiles WHERE id = ?', [result.profileId]);
  assert.ok(profileRow);
  assert.equal(profileRow.source_type, 'agents_md', 'AGENTS.md 要识别成 agents_md');
  assert.equal(profileRow.source_path, filePath);
  assert.equal(profileRow.source_hash, result.sourceHash);
  assert.equal(profileRow.status, 'draft');
  assert.equal(Number(profileRow.is_default), 0, '导入不自动设成默认档案');

  const versionRow = getRow(brain.db, 'SELECT * FROM persona_versions WHERE id = ?', [result.versionId]);
  assert.equal(versionRow.status, 'draft', '首版是 draft，要主人显式激活');
  assert.equal(versionRow.profile_id, result.profileId);
  assert.equal(Number(versionRow.version), 1);
  assert.equal(versionRow.source_hash, result.sourceHash);
  assert.ok(String(versionRow.rendered_text).includes('小狐狸'), '首版就要有可注入的精简文本');
  assert.ok(Number(versionRow.token_estimate) > 0);
  const layers = JSON.parse(String(versionRow.layers_json));
  assert.equal(layers.locked.identity.name, '小狐狸');
});

test('importFromFile 幂等：文件没改就不再建版本', async (t) => {
  const { persona, dir, brain } = createRig(t);
  const filePath = writePersonaFile(dir, PERSONA_MD);
  const first = await persona.profiles.importFromFile({ filePath });
  const second = await persona.profiles.importFromFile({ filePath });

  assert.equal(second.created, false);
  assert.equal(second.unchanged, true, '哈希没变就是「不用重新导入」');
  assert.equal(second.versionId, null);
  assert.equal(second.profileId, first.profileId);
  assert.equal(countRows(brain.db, 'persona_profiles'), 1, '同名档案不许建第二行');
  assert.equal(countRows(brain.db, 'persona_versions'), 1, '哈希没变不许建第二版');
});

test('文件改了：建 v2，diff_json 记录字段级变化，profile 哈希跟着更新', async (t) => {
  const { persona, dir, brain } = createRig(t);
  const filePath = writePersonaFile(dir, PERSONA_MD);
  const first = await persona.profiles.importFromFile({ filePath });

  const changed = PERSONA_MD.replace('- **不骗你**：没做过的不说做过。', '- **不骗你**：没做过的不说做过，也不夸大半成品。');
  writePersonaFile(dir, changed);
  const second = await persona.profiles.importFromFile({ filePath });

  assert.equal(second.created, false, '档案还是那一个');
  assert.equal(second.unchanged, false);
  assert.equal(second.version, 2);
  assert.notEqual(second.versionId, first.versionId);

  const versionRow = getRow(brain.db, 'SELECT * FROM persona_versions WHERE version = 2 AND profile_id = ?', [first.profileId]);
  const diff = JSON.parse(String(versionRow.diff_json));
  assert.ok(diff.changed.length >= 1, '边界文案改了，diff 必须记下来');
  const boundaryDiff = diff.changed.find((entry) => entry.field === 'boundaries');
  assert.ok(boundaryDiff);
  assert.ok(boundaryDiff.itemsAdded.some((line) => line.includes('不夸大半成品')));

  const profileRow = getRow(brain.db, 'SELECT * FROM persona_profiles WHERE id = ?', [first.profileId]);
  assert.equal(profileRow.source_hash, second.sourceHash);
});

test('只读：导入不修改人格文件，也不往 memories 里塞东西', async (t) => {
  const { persona, dir, brain } = createRig(t);
  const filePath = writePersonaFile(dir, PERSONA_MD);
  const before = readFileSync(filePath, 'utf8');
  const beforeStat = statSync(filePath);

  await persona.profiles.importFromFile({ filePath });

  assert.equal(readFileSync(filePath, 'utf8'), before, '人格文件内容不许被改（方案 §7.7：导入不是夺权）');
  assert.equal(statSync(filePath).mtimeMs, beforeStat.mtimeMs, '连 mtime 都不该动');
  assert.equal(countRows(brain.db, 'memories'), 0, '人格导入不是记忆写入');
  assert.equal(countRows(brain.db, 'ws_events'), 0, '也不发事件（还没接线）');
});

test('inspectFile：只判定「改了没有」，不写库', async (t) => {
  const { persona, dir, brain } = createRig(t);
  const filePath = writePersonaFile(dir, PERSONA_MD);
  const first = persona.profiles.inspectFile({ filePath });
  assert.equal(first.changed, true, '没导入过 → 需要导入');
  assert.equal(first.profileId, null);
  assert.equal(countRows(brain.db, 'persona_profiles'), 0, 'inspect 不许写库');

  await persona.profiles.importFromFile({ filePath });
  const again = persona.profiles.inspectFile({ filePath });
  assert.equal(again.changed, false);
  assert.equal(again.profileId !== null, true);
});

test('跨 scope：显式传别的 scope 一律 FORBIDDEN_SCOPE，另一个 scope 也读不到', async (t) => {
  const { persona, dir, brain } = createRig(t);
  const filePath = writePersonaFile(dir, PERSONA_MD);
  const imported = await persona.profiles.importFromFile({ filePath });

  await assert.rejects(
    () => persona.profiles.importFromFile({ filePath, scopeId: SCOPE_B }),
    (err) => err.code === 'FORBIDDEN_SCOPE',
    '导入也要收 scope：不许借调用方的参数跨 scope 写',
  );

  // 另一个 scope 的实例：看不到别人的档案
  const other = createRig(t, { scopeId: SCOPE_B });
  // 共用一个库才能证明「隔离」，这里直接对同一个 brain 组装第二个 scope 的实例
  const { createPersona } = await import('../../packages/persona/src/index.js');
  const personaB = createPersona({
    db: brain.db,
    queue: brain.queue,
    clock: brain.clock,
    workspace: null,
    bindings: { scope_id: SCOPE_B, person_id: 'owner' },
  });
  assert.equal(personaB.profiles.get({ id: imported.profileId }), null, '跨 scope 按 id 直读也必须查不到');
  assert.equal(personaB.profiles.get({ name: 'default' }), null);
  assert.deepEqual(personaB.profiles.list().items, []);
  assert.equal(other.scopeId, SCOPE_B);
});

test('不支持的来源类型：json/yaml 明确报错，不假装解析成功', async (t) => {
  const { persona, dir } = createRig(t);
  const filePath = writePersonaFile(dir, '{"name":"x"}', 'persona.json');
  await assert.rejects(
    () => persona.profiles.importFromFile({ filePath }),
    (err) => {
      assert.equal(err.code, 'INVALID_ARGUMENT');
      assert.match(err.message, /未实现/);
      return true;
    },
  );
});

test('文件不存在：NOT_FOUND（不造空档案）', async (t) => {
  const { persona, dir } = createRig(t);
  await assert.rejects(
    () => persona.profiles.importFromFile({ filePath: path.join(dir, 'missing.md') }),
    (err) => err.code === 'NOT_FOUND',
  );
});
