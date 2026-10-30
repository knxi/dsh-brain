// @ts-check
/**
 * `@dsh-brain/persona` —— 系统 4「人格与主动社交」的统一入口。
 *
 * ── 六个子模块与它们的边界 ──
 *
 * ```
 *   import-persona   人格文件 → 九字段（只读解析，不落任何东西）
 *        │
 *   persona          档案 / 版本 / 五层 / 冲突 / 激活 / 回滚 / 注入渲染
 *        │
 *   person-model     每个用户独立的资料 + 风格 + 主动社交策略（冷启动四维 0.1）
 *        │
 *   relationship     关系四维 + 变化依据（单次 0.08、10 分钟 0.12 两道闸）
 *        │
 *   social           候选 → 评分 → 仲裁 → 发送（默认 dry_run，永不擅自外发）
 *        │
 *   response         回复 / 简短 / 延迟 / 拒绝 / 沉默 五态留痕（保护类禁止沉默）
 * ```
 *
 * ── 接入方式（lead 在 `packages/memory/src/index.js` 里加几行）──
 *
 * ```js
 * import { createPersona } from '@dsh-brain/persona'
 *
 * // workspace 是 lead 的 `createWorkspace(...)` 返回值；不传 = 三个开关全关
 * const persona = createPersona({ db, queue, clock, alert, workspace, bindings: facadeBindings })
 * return { ..., persona }
 * ```
 *
 * 拿到的是 `{ scopeId, personId, profiles, versions, importer, persons, relationships, social, response, gate, switches, sources }`。
 * 真发通道将来通过 `createPersona({ channel })` 注入（现在没有实现任何 IM 通道）。
 *
 * ── 默认安全姿态 ──
 *
 * `workspace` 没注入 = 三个开关全关 = 主动社交零写入零外发。
 * 这不是「忘了接」的兜底，而是契约 §6 的默认值：漏接的后果必须是「什么都不做」。
 */

import {
  IMPLEMENTED_SOCIAL_SOURCES,
  PENDING_SOCIAL_SOURCES,
  SOCIAL_SOURCES,
  readGate,
} from './util.js';

/** 人格：文件解析与导入 */
export {
  PERSONA_FIELDS,
  SOURCE_TYPES,
  createPersonaImporter,
  fieldHasContent,
  inferSourceType,
  layersFromFields,
  parsePersonaMarkdown,
  readPersonaFile,
} from './import-persona.js';

/** 人格：档案 / 版本 / 冲突 / 渲染 */
export {
  CONFLICT_KINDS,
  CONFLICT_RESOLUTIONS,
  DEFAULT_RENDER_TOKENS,
  NEVER_AUTO_RESOLVED,
  VERSION_STATUSES,
  classifyConflict,
  createPersonaProfiles,
  createPersonaVersions,
  diffLayerObjects,
  flattenLayers,
  renderLayersText,
  rowToConflict,
  rowToProfile,
  rowToVersion,
} from './persona.js';

/** 人物模型 */
export {
  DEFAULT_POLICY,
  DEFAULT_STYLE,
  REPLY_LENGTHS,
  createPersonModels,
  emptyBundle,
  normalizeChannels,
  normalizeQuietHours,
  normalizeStyle,
  normalizeTopicCooldowns,
  summarizePerson,
} from './person-model.js';

/** 关系四维 */
export {
  COOLDOWN_CAP,
  COOLDOWN_WINDOW_MS,
  MAX_STEP_DELTA,
  createRelationships,
  normalizeDeltas,
} from './relationship.js';

/** 主动社交 */
export {
  DEFAULT_EXPIRY_HOURS,
  MIN_ENERGY,
  MIN_GAP_MINUTES,
  MIN_MOOD,
  NIGHT_END_HOUR,
  NIGHT_START_HOUR,
  SCORE_LIMITS,
  SCORE_THRESHOLD,
  createSocial,
  rowToCandidate,
} from './social.js';

/** care 信号质量（`unfinished_care` 的生成源头与硬闸共用这一份判据） */
export {
  CARE_COMPLETED_MARKERS,
  CARE_STRONG_KEYWORDS,
  CARE_WEAK_KEYWORDS,
  careStrengthOf,
  isResolvedCareText,
} from './care.js';

/** 响应仲裁 */
export {
  REASON_PROTECTED_FORCED,
  createResponse,
  inferProtectedKind,
  isProtectedSilentViolation,
  rowToDecision,
} from './response.js';

/** 公共工具与常量 */
export {
  DEFAULT_PERSONA_NAME,
  DEFAULT_PERSON_ID,
  DEFAULT_SCOPE_ID,
  DEFAULT_TIME_ZONE,
  IMPLEMENTED_SOCIAL_SOURCES,
  INPUT_KINDS,
  LAYER_TO_CONFLICT,
  PENDING_SOCIAL_SOURCES,
  PERSONA_LAYERS,
  PROTECTED_KINDS,
  RELATIONSHIP_DIMENSIONS,
  RESPONSE_DECISIONS,
  SOCIAL_LIVE_STATUSES,
  SOCIAL_SOURCES,
  SOCIAL_STATUSES,
  assertScope,
  estimateTokens,
  localDayOf,
  localHourOf,
  readGate,
} from './util.js';

import { createPersonaImporter } from './import-persona.js';
import { createPersonaProfiles, createPersonaVersions } from './persona.js';
import { createPersonModels } from './person-model.js';
import { createRelationships } from './relationship.js';
import { createSocial } from './social.js';
import { createResponse } from './response.js';
import { DEFAULT_PERSON_ID, resolveScopeId } from './util.js';

/**
 * 组装系统 4。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string, epoch_ms?: number }, timeZone?: string },
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 *   workspace?: any,
 *   bindings?: { scope_id?: string, person_id?: string },
 *   scopeId?: string,
 *   channel?: ((input: { channel: string, text: string, candidate: any }) => Promise<any>) | null,
 *   strictProtected?: boolean,
 * }} options
 */
export function createPersona(options) {
  if (!options || !options.db || !options.queue || !options.clock) {
    throw new TypeError('createPersona 需要 { db, queue, clock }');
  }
  const scopeId = resolveScopeId(options);
  const personId = options.bindings?.person_id ?? DEFAULT_PERSON_ID;
  const base = {
    db: options.db,
    queue: options.queue,
    clock: options.clock,
    alert: options.alert ?? (() => {}),
    workspace: options.workspace ?? null,
    scopeId,
    bindings: { scope_id: scopeId, person_id: personId },
  };

  const versions = createPersonaVersions(base);
  const importer = createPersonaImporter({ ...base, versions });
  const profiles = createPersonaProfiles({ ...base, importer });
  const persons = createPersonModels(base);
  const relationships = createRelationships(base);
  const social = createSocial({ ...base, channel: options.channel ?? null });
  const response = createResponse({ ...base, strictProtected: options.strictProtected === true });

  /**
   * 当前开关快照（只读）。
   * @returns {ReturnType<typeof readGate>}
   */
  function gate() {
    return readGate(base.workspace);
  }

  return {
    scopeId,
    personId,
    /** 人格档案（含 `importFromFile` / `inspectFile`） */
    profiles,
    /** 人格版本（`createVersion` / `diffVersions` / `detectConflicts` / `activate` / `rollback` / `renderForContext`） */
    versions,
    /** 人格文件导入器（纯解析在 `parsePersonaMarkdown`） */
    importer,
    /** 人物模型（`ensurePerson` / `updateStyle` / `getPolicy` / `updatePolicy`） */
    persons,
    /** 关系四维（`getState` / `applyEvent` / `history` / `stats`） */
    relationships,
    /** 主动社交（`generate` / `preview` / `score` / `arbitrate` / `send` / `cancel` / `expire`） */
    social,
    /** 回复五态（`decide` / `listDecisions` / `stats`） */
    response,
    /** 开关快照 */
    gate,
    /** 与 gate 同义，便于面板直接展示 */
    switches: gate,
    /** 本包实现的候选来源 / 刻意没做的来源（诚实列出，供 UI 标注） */
    sources: { implemented: IMPLEMENTED_SOCIAL_SOURCES, pending: PENDING_SOCIAL_SOURCES, all: SOCIAL_SOURCES },
  };
}

export default createPersona;
