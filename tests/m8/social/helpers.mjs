// @ts-check
/**
 * M8 · 主动社交新增三类来源（shared_memory / verification / curiosity）的测试工具。
 *
 * 为什么不直接复用 `tests/persona/helpers.mjs`：那边的 `insertMemory` 把
 * `source_type` 固定成 owner_words、`confidence` 固定成 0.9——正好把这次要测的
 * 「求证」两个字的前提（observation + 低置信度）挡在门外。
 * 这里只补「能按需写这些列」的那一小块，其余（时钟、workspace、persona 装配）
 * 全部复用 persona 的真实装置，不另起一套假门面。
 *
 * 纪律同 persona：临时主账、固定时钟、绝不碰 `data/brain.db`。
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClock } from '../../../packages/core/src/index.js';
import { openBrain } from '../../../packages/memory/src/index.js';
import { createWorkspace } from '../../../packages/workspace/src/index.js';
import { createPersona } from '../../../packages/persona/src/index.js';

export { assert };

/** 固定范围（与 persona 测试一致，便于对照）。 */
export const SCOPE_A = 'scope-alpha';
export const PERSON_A = 'owner';

/**
 * 默认时钟：`2026-10-30T02:00:00Z` = 本地 10:00（白天，避开深夜硬闸）。
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
 * 开一个跑完全部迁移的临时主账，测试结束自动删。
 * @param {import('node:test').TestContext} t
 * @param {{ startIso?: string }} [opts]
 */
export function createBrain(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m8-social-'));
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
 * 完整装置：临时主账 + 真 workspace + persona 门面。
 * @param {import('node:test').TestContext} t
 * @param {{ startIso?: string, scopeId?: string, personId?: string }} [opts]
 */
export function createRig(t, opts = {}) {
  const { brain, fc } = createBrain(t, { startIso: opts.startIso });
  const scopeId = opts.scopeId ?? SCOPE_A;
  const personId = opts.personId ?? PERSON_A;
  const workspace = createWorkspace({ db: brain.db, queue: brain.queue, clock: brain.clock, bindings: { scope_id: scopeId } });
  const persona = createPersona({
    db: brain.db,
    queue: brain.queue,
    clock: brain.clock,
    workspace,
    bindings: { scope_id: scopeId, person_id: personId },
    channel: null,
  });
  return { brain, fc, workspace, persona, scopeId, personId };
}

/** 冷启动 + 打开主动社交开关（沿用 persona 测试的「可写入」前置）。 */
export async function readyRig(t, opts = {}) {
  const rig = createRig(t, opts);
  await rig.persona.persons.ensurePerson({ personId: rig.personId, displayName: '主人' });
  writeFoxState(rig.brain.db, { mood: 70, energy: 70 });
  await rig.workspace.setSwitch('social.enabled', '1', { by: 'test', reason: 'm8 social' });
  return rig;
}

/**
 * 写 fox_state（心情/精力是硬闸输入）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ mood?: number, energy?: number, stress?: number }} state
 */
export function writeFoxState(db, state = {}) {
  const iso = '2026-10-30T02:00:00.000Z';
  const local = '2026-10-30T10:00:00.000+08:00';
  db.prepare(
    `INSERT INTO fox_state (id, version, mood, energy, bond, created_at, created_at_local, updated_at, updated_at_local,
       last_interact_at, last_proactive_at, deletion_epoch, stress, initiative)
     VALUES (1, 1, ?, ?, 50, ?, ?, ?, ?, 0, 0, 0, ?, 0.5)
     ON CONFLICT(id) DO UPDATE SET mood = excluded.mood, energy = excluded.energy, stress = excluded.stress`,
  ).run(state.mood ?? 70, state.energy ?? 70, iso, local, iso, local, state.stress ?? 0);
}

/**
 * 插一行 memories——**按需指定** type / source_type / confidence / importance。
 *
 * 这几个参数正是本次三类来源的判定依据，所以默认值刻意「不满足任何一类」，
 * 让用例必须显式声明自己造的是什么，避免「碰巧命中」的假绿。
 *
 * `validFrom` 单独可设：迁移进来的记忆 `created_at` 是导入时刻、真实发生时间在
 * `valid_from`，这正是 shared_memory 判据必须踩到的那个坑。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   id?: string, scopeId?: string, personId?: string, type?: string, content: string,
 *   summary?: string, createdAt?: string, status?: string, validFrom?: string | null,
 *   sourceType?: string, confidence?: number, importance?: number, sourceIds?: string[],
 *   recallCount?: number,
 * }} input
 */
export function insertMemoryRow(db, input) {
  const id = input.id ?? `mem_${Math.random().toString(16).slice(2)}`;
  const createdAt = input.createdAt ?? '2026-10-30T01:00:00.000Z';
  const local = createdAt.replace('Z', '+00:00');
  const validFrom = input.validFrom === undefined ? null : input.validFrom;
  db.prepare(
    `INSERT INTO memories (
       id, person_id, scope_id, layer, type, content, summary, source_type, source_ids,
       confidence, importance, privacy, status, created_at, created_at_local, updated_at, updated_at_local,
       valid_from, valid_from_local, recall_count
     ) VALUES (?, ?, ?, 'long', ?, ?, ?, ?, ?, ?, ?, 'private', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.personId ?? PERSON_A,
    input.scopeId ?? SCOPE_A,
    input.type ?? 'semantic',
    input.content,
    input.summary ?? input.content.slice(0, 40),
    input.sourceType ?? 'summary',
    JSON.stringify(input.sourceIds ?? []),
    input.confidence ?? 0.5,
    input.importance ?? 0.5,
    input.status ?? 'active',
    createdAt,
    local,
    createdAt,
    local,
    validFrom,
    validFrom === null ? null : validFrom.replace('Z', '+00:00'),
    input.recallCount ?? 0,
  );
  return id;
}

/**
 * 给记忆挂一条出处（`source_refs`）——「找得到出处」的那半边条件。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ memoryId: string, scopeId?: string, refId?: string }} input
 */
export function insertSourceRefRow(db, input) {
  const refId = input.refId ?? `src_${Math.random().toString(16).slice(2)}`;
  const iso = '2026-10-30T01:00:00.000Z';
  db.prepare(
    `INSERT INTO source_refs (ref_id, memory_id, source_kind, source_system, doc_ref,
       independent_source_key, created_at, created_at_local)
     VALUES (?, ?, 'document', 'test', ?, ?, ?, ?)`,
  ).run(refId, input.memoryId, refId, `ind-${refId}`, iso, iso.replace('Z', '+00:00'));
  return refId;
}

/**
 * 插一行实体，并把指定记忆挂上去（锚点判定的一路依据）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scopeId?: string, name: string, kind?: string, memoryIds?: string[], importance?: number }} input
 */
export function insertEntityRow(db, input) {
  const id = `ent_${Math.random().toString(16).slice(2)}`;
  const iso = '2026-10-30T01:00:00.000Z';
  db.prepare(
    `INSERT INTO entities (id, scope_id, person_id, name, kind, aliases, importance, status,
       created_at, created_at_local, updated_at, updated_at_local)
     VALUES (?, ?, 'owner', ?, ?, '[]', ?, 'active', ?, ?, ?, ?)`,
  ).run(
    id,
    input.scopeId ?? SCOPE_A,
    input.name,
    input.kind ?? 'concept',
    input.importance ?? 0.5,
    iso,
    iso.replace('Z', '+00:00'),
    iso,
    iso.replace('Z', '+00:00'),
  );
  for (const memoryId of input.memoryIds ?? []) {
    db.prepare(
      `INSERT INTO memory_entities (memory_id, entity_id, role, created_at, created_at_local)
       VALUES (?, ?, NULL, ?, ?)`,
    ).run(memoryId, id, iso, iso.replace('Z', '+00:00'));
  }
  return id;
}

/**
 * 插一行 reflections（curiosity 缺的那类数据：知识缺口反思）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ id?: string, scopeId?: string, text: string, kind?: string, status?: string }} input
 */
export function insertReflectionRow(db, input) {
  const id = input.id ?? `rfl_${Math.random().toString(16).slice(2)}`;
  const iso = '2026-10-30T01:00:00.000Z';
  db.prepare(
    `INSERT INTO reflections (id, run_id, scope_id, kind, text, evidence_json, confidence, status,
       created_at, created_at_local, updated_at, updated_at_local)
     VALUES (?, 'run_test', ?, ?, ?, '["ev:seed"]', 0.6, ?, ?, ?, ?, ?)`,
  ).run(id, input.scopeId ?? SCOPE_A, input.kind ?? 'knowledge_gap', input.text, input.status ?? 'candidate', iso, iso, iso, iso);
  return id;
}

/**
 * 插一条「已落表的候选」（验证话题冷却 / 每类每天 1 条用）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ scopeId?: string, personId?: string, source?: string, topic?: string, text?: string, status?: string,
 *   createdAtLocal?: string }} input
 */
export function insertCandidateRow(db, input) {
  const id = `sol_${Math.random().toString(16).slice(2)}`;
  const iso = '2026-10-30T02:00:00.000Z';
  const local = input.createdAtLocal ?? '2026-10-30T10:00:00.000+08:00';
  db.prepare(
    `INSERT INTO social_candidates (id, scope_id, person_id, source, topic, text, evidence_json, score,
       score_breakdown_json, status, created_at, created_at_local, updated_at, updated_at_local)
     VALUES (?, ?, ?, ?, ?, ?, '["seed"]', 60, '{}', ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.scopeId ?? SCOPE_A,
    input.personId ?? PERSON_A,
    input.source ?? 'shared_memory',
    input.topic ?? 'seed.topic',
    input.text ?? '种子候选',
    input.status ?? 'scored',
    iso,
    local,
    iso,
    local,
  );
  return id;
}
