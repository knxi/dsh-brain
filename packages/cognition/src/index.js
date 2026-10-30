// @ts-check
/**
 * `@dsh-brain/cognition` —— 系统 3「类脑协同」的五个模块统一出口。
 *
 * ```
 *   salience  显著性标记（杏仁核）    → memory_salience
 *   reflect   空闲反思（默认模式网络）→ reflection_runs / reflections（可选写 memories）
 *   skill     技能校准（小脑）        → skill_stats / skill_lessons
 *   immune    安全隔离（免疫系统）    → immune_quarantine
 *   brainstem 健康监控（脑干）        → health_alerts
 * ```
 *
 * ── 装配纪律 ──
 *
 * 1. 五套模块共享**同一个 db / queue / clock / alert**：主账只有一个写入方（单写队列），
 *    任何模块自己开连接都会破坏「事件+状态+outbox 同事务提交」的保证。
 * 2. `workspace` 由调用方注入（`openBrain` 组装时传进来），本包**不自己建**：
 *    它掌管全局开关与事件面，谁都能 new 一个的话，开关就不再是唯一闸门。
 * 3. `workspace` 缺失时**不崩**：每个模块按「开关判不了 = 当成关」的默认安全姿态降级，
 *    并记一次 warning。这样 `openBrain` 还来不及接线时，整个大脑仍能起来。
 * 4. `dbPath` / `backupsDir` / `memories` 都是**可选**注入，用来把体检与晋升做到完整：
 *    - `dbPath`：算 WAL 大小、推断默认备份目录；
 *    - `backupsDir`：生产是 `data/backups/`；
 *    - `memories`：反思晋升时走记忆门面（拿到三套索引与 source_refs）；不传则直接写行，
 *      语义正确但需要后续 `reindexAll()` 才可检索（返回 `via:'direct'` 标明）。
 */

import { createBrainstem } from './brainstem.js';
import { createImmune } from './immune.js';
import { createReflect } from './reflect.js';
import { createSalience } from './salience.js';
import { createSkill } from './skill.js';
import { notify } from './internal.js';

export { createSalience } from './salience.js';
export { createReflect } from './reflect.js';
export { createSkill } from './skill.js';
export { createImmune } from './immune.js';
export { createBrainstem } from './brainstem.js';

export {
  computeSalienceFromSignals,
  salienceBoost,
  SALIENCE_WEIGHTS,
  MAX_SALIENCE_BOOST,
} from './salience.js';
export {
  topicTokens,
  KIND_TO_MEMORY_TYPE,
  KIND_CONFIDENCE,
  PROMOTED_CONFIDENCE_CAP,
  REFLECTION_TRIGGERS,
  REFLECTION_KINDS,
} from './reflect.js';
export {
  wilsonLowerBound,
  classifyError,
  skillKeyOf,
  LOW_CONFIDENCE_THRESHOLD,
  MIN_ATTEMPTS_FOR_CONFIDENCE,
  CONSECUTIVE_FAILURE_THRESHOLD,
  SANDBOX_ERROR_CODES,
  TRANSIENT_ERROR_CODES,
} from './skill.js';
export {
  detectSecurityIssues,
  IMMUNE_RULES,
  IMMUNE_REASON_CODES,
  REASON_SEVERITY,
  MAX_EXCERPT_LENGTH,
} from './immune.js';
export { CHECK_CODES, CHECK_SEVERITY, CHECK_TITLES } from './brainstem.js';

/**
 * 组装系统 3 的全部模块。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string, epoch_ms?: number }, timeZone?: string },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   workspace?: any,
 *   bindings?: { scope_id?: string, person_id?: string } | null,
 *   dbPath?: string | null,
 *   backupsDir?: string | null,
 *   memories?: { create: (draft: any) => Promise<{ id: string }> } | null,
 * }} options
 */
export function createCognition(options = /** @type {any} */ ({})) {
  if (!options || typeof options !== 'object') {
    throw new TypeError('createCognition 需要 options 对象');
  }
  const { db, queue, clock } = options;
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createCognition 需要 db（node:sqlite DatabaseSync）');
  }
  if (!queue || typeof queue.write !== 'function') {
    throw new TypeError('createCognition 需要 queue.write（主账单写队列）');
  }
  if (!clock || typeof clock.stamp !== 'function') {
    throw new TypeError('createCognition 需要 clock.stamp()');
  }

  const alert = typeof options.alert === 'function' ? options.alert : () => {};
  const workspace = options.workspace ?? null;
  const bindings = options.bindings ?? null;
  const shared = { db, queue, clock, alert, workspace, bindings };

  if (!workspace) {
    // 降级而不是崩：模块自己会在开关判不了时按「关」处理（默认安全姿态）。
    notify(alert, 'cognition.workspace_missing', 'workspace 未接线：反思等自主模块会按「关闭」处理（零副作用），其余模块照常可用', {
      hint: 'openBrain 组装时把 createWorkspace(...) 的返回值传进来',
    });
  }

  const salience = createSalience(shared);
  const reflect = createReflect({ ...shared, memories: options.memories ?? null });
  const skill = createSkill(shared);
  const immune = createImmune(shared);
  const brainstem = createBrainstem({
    ...shared,
    dbPath: options.dbPath ?? null,
    backupsDir: options.backupsDir ?? null,
  });

  return {
    /** 注入绑定里的默认 scope（没有就是 null，调用时必须显式传 scopeId）。 */
    scopeId: bindings?.scope_id ?? null,
    /** 显著性标记（杏仁核）。 */
    salience,
    /** 空闲反思（默认模式网络）。 */
    reflect,
    /** 技能校准（小脑）。 */
    skill,
    /** 安全隔离（免疫系统）。 */
    immune,
    /** 健康监控与告警（脑干）。 */
    brainstem,
    /**
     * 汇总统计（面板/验收用）。失败不抛：某张表没建时给 0，而不是让整个面板崩掉。
     * @param {{ scopeId?: string }} [query]
     */
    stats(query = {}) {
      const safe = (fn) => {
        try {
          return fn();
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) };
        }
      };
      return {
        scopeId: query.scopeId ?? bindings?.scope_id ?? null,
        salience: safe(() => salience.stats(query)),
        reflect: safe(() => reflect.stats(query)),
        skill: safe(() => skill.stats(query)),
        immune: safe(() => immune.stats(query)),
        brainstem: safe(() => brainstem.stats(query)),
      };
    },
  };
}
