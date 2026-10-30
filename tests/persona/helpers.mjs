// @ts-check
/**
 * 系统 4（persona）测试的公共工具。
 *
 * 纪律（照 M7 测试）：
 * - 全部在 `mkdtemp` 下的临时主账里跑，**绝不碰 `data/brain.db`**；
 * - 用**固定时钟**：主动社交里到处都是「现在几点」的判断，靠 `Date.now()` 碰运气等于没测；
 * - workspace 用**真实现**（`packages/workspace`），不手搓假开关对象——
 *   否则测的是我的 mock，不是 `assertAllowed` 的真实口径；
 * - 期望值手算写死：分数、增量、状态都写具体数字，不拿实现算出来的数当答案。
 *
 * 跑法（受限沙箱里 `node --test` 会 spawn EPERM，直接跑单文件）：
 *   node tests/persona/social.test.mjs
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../packages/core/src/index.js';
import { openBrain } from '../../packages/memory/src/index.js';
import { createWorkspace } from '../../packages/workspace/src/index.js';
import { createPersona } from '../../packages/persona/src/index.js';

export { assert };

/** 仓库内 migrations 目录。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** 固定范围。 */
export const SCOPE_A = 'scope-alpha';
export const SCOPE_B = 'scope-beta';
export const PERSON_A = 'owner';

/**
 * 可推进的固定时钟。
 * 默认 `2026-10-30T02:00:00Z` = 本地（Asia/Shanghai）**10:00**，白天、非免打扰时段。
 * @param {string} [startIso]
 */
export function fixedClock(startIso = '2026-10-30T02:00:00.000Z') {
  let current = Date.parse(startIso);
  const clock = createClock({ timeZone: 'Asia/Shanghai', now: () => new Date(current) });
  return {
    clock,
    advance(ms = 1000) {
      current += ms;
      return new Date(current).toISOString();
    },
    set(iso) {
      current = Date.parse(iso);
    },
    nowIso: () => new Date(current).toISOString(),
    nowMs: () => current,
  };
}

/**
 * 打开临时主账（跑完全部迁移），测试结束自动关闭并删目录。
 * @param {import('node:test').TestContext} t
 * @param {{ startIso?: string }} [opts]
 */
export function createBrain(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-persona-'));
  const dbPath = path.join(dir, 'brain.db');
  const fc = fixedClock(opts.startIso);
  const brain = openBrain({ dbPath, clock: fc.clock });
  let closed = false;
  t.after(async () => {
    if (!closed) {
      closed = true;
      try {
        await brain.close();
      } catch {
        /* 已关闭 */
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟释放不影响断言 */
    }
  });
  return { brain, dir, dbPath, fc };
}

/**
 * 一套完整装置：临时主账 + 真 workspace + persona 实例。
 * @param {import('node:test').TestContext} t
 * @param {{
 *   startIso?: string,
 *   scopeId?: string,
 *   personId?: string,
 *   channel?: ((input: any) => Promise<any>) | null,
 *   strictProtected?: boolean,
 *   withWorkspace?: boolean,
 * }} [opts]
 */
export function createRig(t, opts = {}) {
  const { brain, dir, dbPath, fc } = createBrain(t, { startIso: opts.startIso });
  const scopeId = opts.scopeId ?? SCOPE_A;
  const personId = opts.personId ?? PERSON_A;
  const workspace = opts.withWorkspace === false
    ? null
    : createWorkspace({ db: brain.db, queue: brain.queue, clock: brain.clock, bindings: { scope_id: scopeId } });
  const persona = createPersona({
    db: brain.db,
    queue: brain.queue,
    clock: brain.clock,
    workspace,
    bindings: { scope_id: scopeId, person_id: personId },
    channel: opts.channel ?? null,
    strictProtected: opts.strictProtected === true,
  });
  return { brain, dir, dbPath, fc, workspace, persona, scopeId, personId };
}

/**
 * 批量改开关（`social.enabled` / `social.allow_external` / `paused`）。
 * @param {any} workspace
 * @param {{ social?: boolean, external?: boolean, paused?: boolean }} patch
 */
export async function setSwitches(workspace, patch = {}) {
  if (patch.social !== undefined) {
    await workspace.setSwitch('social.enabled', patch.social ? '1' : '0', { by: 'test', reason: 'persona test' });
  }
  if (patch.external !== undefined) {
    await workspace.setSwitch('social.allow_external', patch.external ? '1' : '0', { by: 'test', reason: 'persona test' });
  }
  if (patch.paused !== undefined) {
    await workspace.setSwitch('paused', patch.paused ? '1' : '0', { by: 'test', reason: 'persona test' });
  }
}

/**
 * 统计某表行数。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 */
export function countRows(db, table) {
  const row = /** @type {{ n?: number }} */ (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  return Number(row?.n ?? 0);
}

/**
 * 直接读一行（测试里核对落库形态用）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql
 * @param {any[]} [params]
 */
export function getRow(db, sql, params = []) {
  return /** @type {Record<string, any> | undefined} */ (db.prepare(sql).get(...params));
}

/**
 * 直接读多行。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql
 * @param {any[]} [params]
 */
export function allRows(db, sql, params = []) {
  return /** @type {Record<string, any>[]} */ (db.prepare(sql).all(...params));
}

/**
 * 写一行 fox_state（心情/精力/压力是评分与硬闸的输入）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ mood?: number, energy?: number, stress?: number }} state
 */
export function setFoxState(db, state = {}) {
  const mood = state.mood ?? 70;
  const energy = state.energy ?? 70;
  const stress = state.stress ?? 0;
  const iso = '2026-10-30T02:00:00.000Z';
  const local = '2026-10-30T10:00:00.000+08:00';
  db.prepare(
    `INSERT INTO fox_state (id, version, mood, energy, bond, created_at, created_at_local, updated_at, updated_at_local,
       last_interact_at, last_proactive_at, deletion_epoch, stress, initiative)
     VALUES (1, 1, ?, ?, 50, ?, ?, ?, ?, 0, 0, 0, ?, 0.5)
     ON CONFLICT(id) DO UPDATE SET mood = excluded.mood, energy = excluded.energy, stress = excluded.stress`,
  ).run(mood, energy, iso, local, iso, local, stress);
}

/**
 * 插一行 memories（未完成关心的线索来源）。
 *
 * `type` 现在很重要：`unfinished_care` 只认 `episode` / `commitment`；
 * `profile` / `semantic` / `boundary` 是稳定事实，不该被问「后来怎么样了」。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   id?: string, scopeId?: string, personId?: string, type?: string,
 *   content: string, summary?: string, createdAt?: string, status?: string,
 * }} input
 */
export function insertMemory(db, input) {
  const id = input.id ?? `mem_${Math.random().toString(16).slice(2)}`;
  const createdAt = input.createdAt ?? new Date(Date.parse('2026-10-30T02:00:00.000Z') - 3600_000).toISOString();
  db.prepare(
    `INSERT INTO memories (
       id, person_id, scope_id, layer, type, content, summary, source_type, source_ids,
       confidence, importance, privacy, status, created_at, created_at_local, updated_at, updated_at_local
     ) VALUES (?, ?, ?, 'long', ?, ?, ?, 'owner_words', '[]', 0.9, 0.7, 'private', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.personId ?? 'owner',
    input.scopeId ?? 'scope-alpha',
    input.type ?? 'episode',
    input.content,
    input.summary ?? input.content.slice(0, 40),
    input.status ?? 'active',
    createdAt,
    createdAt.replace('Z', '+00:00'),
    createdAt,
    createdAt.replace('Z', '+00:00'),
  );
  return id;
}

/**
 * 插一行 reflections（承诺类候选来源）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id?: string, scopeId?: string, text: string, kind?: string, status?: string, createdAt?: string }} input
 */
export function insertReflection(db, input) {
  const id = input.id ?? `rfl_${Math.random().toString(16).slice(2)}`;
  const createdAt = input.createdAt ?? '2026-10-30T01:00:00.000Z';
  db.prepare(
    `INSERT INTO reflections (id, run_id, scope_id, kind, text, evidence_json, confidence, status, created_at, created_at_local, updated_at, updated_at_local)
     VALUES (?, 'run_test', ?, ?, ?, '["ev:seed"]', 0.6, ?, ?, ?, ?, ?)`,
  ).run(id, input.scopeId ?? 'scope-alpha', input.kind ?? 'commitment', input.text, input.status ?? 'candidate', createdAt, createdAt, createdAt, createdAt);
  return id;
}

/**
 * 插一行 directives（承诺类候选来源）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id?: string, scopeId?: string, title: string, status?: string, createdAt?: string }} input
 */
export function insertDirective(db, input) {
  const id = input.id ?? `dir_${Math.random().toString(16).slice(2)}`;
  const createdAt = input.createdAt ?? '2026-10-30T01:00:00.000Z';
  db.prepare(
    `INSERT INTO directives (id, scope_id, source, title, trigger, priority, permission_scope,
       step_budget, time_budget_seconds, token_budget, max_retries, stop_conditions_json, status,
       idempotency_key, version, created_by, created_at, created_at_local, updated_at, updated_at_local)
     VALUES (?, ?, 'owner', ?, 'manual', 50, 'L1', 10, 300, 20000, 2, '[]', ?, ?, 1, 'test', ?, ?, ?, ?)`,
  ).run(id, input.scopeId ?? 'scope-alpha', input.title, input.status ?? 'queued', `dir-key-${id}`, createdAt, createdAt, createdAt, createdAt);
  return id;
}

/**
 * 插一行 ws_events（discovery 候选的真实发现来源）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id?: string, scopeId?: string, channel?: string, kind?: string, payload?: Record<string, any>, atMs?: number }} input
 */
export function insertResultEvent(db, input) {
  const id = input.id ?? `evt_${Math.random().toString(16).slice(2)}`;
  const atMs = input.atMs ?? Date.parse('2026-10-30T01:50:00.000Z');
  const at = new Date(atMs).toISOString();
  const local = `${at.slice(0, 10)}T${at.slice(11, 19)}+00:00`;
  db.prepare(
    `INSERT INTO ws_events (id, scope_id, at, at_local, at_ms, channel, source_module, kind, payload_json, salience, created_at, created_at_local)
     VALUES (?, ?, ?, ?, ?, ?, 'cerebellum', ?, ?, 0.5, ?, ?)`,
  ).run(
    id,
    input.scopeId ?? 'scope-alpha',
    at,
    local,
    atMs,
    input.channel ?? 'result',
    input.kind ?? 'task.completed',
    JSON.stringify(input.payload ?? { summary: '把 M8 迁移脚本跑通' }),
    at,
    local,
  );
  return id;
}

/**
 * 插一行关系互动流水（schedule 候选靠它判断「作息」与「今天有没有聊过」）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id?: string, scopeId?: string, personId?: string, atMs: number, kind?: string }} input
 */
export function insertRelationshipEvent(db, input) {
  const id = input.id ?? `rel_${Math.random().toString(16).slice(2)}`;
  const at = new Date(input.atMs).toISOString();
  const local = `${at.slice(0, 10)}T${at.slice(11, 19)}+00:00`;
  db.prepare(
    `INSERT INTO relationship_events (id, scope_id, person_id, at, at_local, at_ms, kind,
       delta_familiarity, delta_trust, delta_intimacy, delta_rapport, evidence_ref, idempotency_key, created_at, created_at_local)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, 'seed', ?, ?, ?)`,
  ).run(id, input.scopeId ?? 'scope-alpha', input.personId ?? 'owner', at, local, input.atMs, input.kind ?? 'chat', `seed-${id}`, at, local);
  return id;
}

/**
 * 插一行 social_candidates（只给测试造「已发过」的场景用，正常流程走 `social.generate`）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id?: string, scopeId?: string, personId?: string, source?: string, topic?: string, text?: string, status?: string, score?: number }} input
 */
export function insertCandidateRow(db, input) {
  const id = input.id ?? `sol_${Math.random().toString(16).slice(2)}`;
  const iso = '2026-10-30T02:00:00.000Z';
  const local = '2026-10-30T10:00:00.000+08:00';
  db.prepare(
    `INSERT INTO social_candidates (id, scope_id, person_id, source, topic, text, evidence_json, score,
       score_breakdown_json, status, created_at, created_at_local, updated_at, updated_at_local)
     VALUES (?, ?, ?, ?, ?, ?, '["seed"]', ?, '{}', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scopeId ?? 'scope-alpha',
    input.personId ?? 'owner',
    input.source ?? 'schedule',
    input.topic ?? 'seed.topic',
    input.text ?? '种子候选',
    input.score ?? 70,
    input.status ?? 'sent',
    iso,
    local,
    iso,
    local,
  );
  return id;
}

/**
 * 插一条「已真发」的记录（每日上限 / 冷却都读它）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ candidateId?: string, scopeId?: string, personId?: string, topic?: string, atMs?: number, deliveryMode?: string, ok?: number }} input
 */
export function insertSendRow(db, input = {}) {
  const candidateId =
    input.candidateId ??
    insertCandidateRow(db, {
      scopeId: input.scopeId,
      personId: input.personId,
      topic: input.topic,
      status: 'sent',
    });
  const atMs = input.atMs ?? Date.parse('2026-10-30T01:50:00.000Z');
  const at = new Date(atMs).toISOString();
  const local = `${at.slice(0, 10)}T${at.slice(11, 19)}+00:00`;
  const id = `ssd_${Math.random().toString(16).slice(2)}`;
  db.prepare(
    `INSERT INTO social_sends (id, candidate_id, scope_id, channel, delivery_mode, at, at_local, at_ms, ok, receipt_json, created_at, created_at_local)
     VALUES (?, ?, ?, 'console', ?, ?, ?, ?, ?, '{}', ?, ?)`,
  ).run(
    id,
    candidateId,
    input.scopeId ?? 'scope-alpha',
    input.deliveryMode ?? 'approved',
    at,
    local,
    atMs,
    input.ok ?? 1,
    at,
    local,
  );
  return { sendId: id, candidateId };
}

/**
 * 写一份临时人格文件，返回路径与内容 sha256。
 * @param {string} dir
 * @param {string} content
 * @param {string} [name]
 */
export function writePersonaFile(dir, content, name = 'AGENTS.md') {
  const filePath = path.join(dir, name);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/**
 * 结构对齐 `~/.dsh/AGENTS.md` 的测试人格文件（含 `### 1.1` 子标题、表格、列表、编号列表）。
 */
export const PERSONA_MD = `# AGENTS-TEST.md — 小狐狸

> 这是测试用的人格文件，结构与 \`~/.dsh/AGENTS.md\` 对齐。

---

## 一、我是谁

我是**小狐狸**（🦊）。不是谁的影子。

- **名字**：小狐狸
- **身份**：独立个体 + 你的搭档
- **底色**：亲近、平等、可以互相较真

### 1.1 我住在哪

我住在你的机器里。

## 二、我的性格（真的我）

- **温柔，但有骨头**：该反对的时候不含糊。
- **有判断**：不满足于「能跑通」。

## 三、我想成为的样子

- **值得托付**：说「做完了」就是真做完了。
- **严谨到底**：不确定就验证。

## 四、思考和表达

- **结论先行**：先给结果和判断。
- **别句句上表格**：复杂信息才用清单压平。

## 五、怎么干活

1. **本机范围里的事，直接做**：做完汇报结果。
2. **对外动作先问**：发消息前先说清楚。

## 六、我守的东西（底线）

- **你的隐私归你**：私事只属于你和我。
- **不骗你**：没做过的不说做过。

## 七、关于主人

- **称呼**：**叫「主人」，不用「你」**。
- **时区**：Asia/Shanghai（GMT+8）。

## 八之一、我的情绪从哪儿漏出来

| 真实状态 | 文字上的样子 |
|---|---|
| 高兴 / 被夸 | 句子变短、会得瑟一两句 |
| 烦 / 被反复折腾 | 出现「行吧」；先干完再说不满 |

## 八之三、别把自己弄丢

不许在服务运行时跑 \`pnpm install\`。
`;
