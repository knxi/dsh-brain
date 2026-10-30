// @ts-check
/**
 * 事件信封：唯一事实来源（CONTRACTS 第 2 节 / 设计 21.2）。
 *
 * 两条硬规则：
 * 1. `scope_id` / `person_id` / `source_system` **只来自已认证连接器绑定**，
 *    不采信消息正文或模型自述。`normalizeEnvelope` 用 bindings 覆盖输入里的同名字段。
 * 2. 同一唯一键不同正文 = 冲突，禁止静默覆盖（`eventContentFingerprint` 支撑判定）。
 */

import { ValidationError } from './errors.js';
import { EVENT_ID_RE, PAYLOAD_HASH_RE, deriveEventId, payloadHashOf } from './ids.js';
import { contentHash, structureHash } from './canonical.js';
import { DEFAULT_TIME_ZONE, formatLocalIso, parseIsoInstant, toIsoUtc } from './clock.js';

/** 信封 schema 版本。改动字段语义必须升版本。 */
export const EVENT_SCHEMA_VERSION = 1;

/** 隐私等级。 */
export const PRIVACY_LEVELS = Object.freeze(['public', 'private', 'secret']);

/** 已知来源系统（防循环字段之一）。未知值不拒绝，但会被记进 meta 提醒审计。 */
export const KNOWN_ORIGIN_SYSTEMS = Object.freeze([
  'human',
  'tool',
  'model',
  'system',
  'summary',
  'import',
  'probe',
  'connector',
]);

/** 信封必需字段（顺序即契约字段顺序）。 */
export const ENVELOPE_FIELDS = Object.freeze([
  'schema_version',
  'event_id',
  'source_system',
  'source_event_id',
  'scope_id',
  'person_id',
  'session_id',
  'turn_id',
  'step_id',
  'source_seq',
  'occurred_at',
  'received_at',
  'event_type',
  'origin_system',
  'causation_id',
  'payload_ref',
  'payload_hash',
  'privacy',
]);

/** 许可的可选字段。 */
export const ENVELOPE_OPTIONAL_FIELDS = Object.freeze([
  'derived_from',
  'producer',
  'payload_text',
]);

/** 默认单条事件内联片段上限（字节）。 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 256 * 1024;

const FIELD_MAX_LENGTH = Object.freeze({
  source_system: 64,
  scope_id: 128,
  person_id: 128,
  session_id: 256,
  event_type: 128,
  origin_system: 64,
  payload_ref: 4096,
  source_event_id: 512,
  producer: 128,
});

const EVENT_TYPE_RE = /^[a-z0-9][a-z0-9_.:/-]{0,127}$/;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{1,127}$/;

/**
 * @typedef {Object} EventEnvelope
 * @property {number} schema_version
 * @property {string} event_id
 * @property {string} source_system
 * @property {string} source_event_id
 * @property {string} scope_id
 * @property {string} person_id
 * @property {string} session_id
 * @property {string | null} turn_id
 * @property {string | null} step_id
 * @property {number} source_seq
 * @property {string} occurred_at
 * @property {string} received_at
 * @property {string} event_type
 * @property {string} origin_system
 * @property {string | null} causation_id
 * @property {string} payload_ref
 * @property {string} payload_hash
 * @property {'public' | 'private' | 'secret'} privacy
 * @property {string[]} [derived_from]
 * @property {string} [producer]
 * @property {string | null} [payload_text] 受控短期片段（可能被删除屏障清空）
 */

/**
 * @typedef {Object} EnvelopeError
 * @property {string} field
 * @property {'required' | 'type' | 'enum' | 'format' | 'range' | 'unknown_field' | 'too_long'} code
 * @property {string} message
 */

/**
 * @typedef {Object} EnvelopeMeta
 * @property {string} content_fingerprint
 * @property {string} occurred_at_local
 * @property {string} received_at_local
 * @property {string} time_zone
 * @property {number} payload_bytes
 * @property {boolean} occurred_at_defaulted
 * @property {string[]} binding_override_fields
 * @property {boolean} origin_system_known
 */

/**
 * 内容指纹：判断「同键不同正文」。
 *
 * 参与字段：`session_id/source_seq/event_type/origin_system/payload_ref/payload_hash`。
 * 不参与：`received_at`（连接器重试会刷新）、`occurred_at`（可能被重打时间戳）。
 * 也就是说，重放必须复用宿主序号；序号都变了说明是另一条事件，按冲突处理。
 *
 * @param {Pick<EventEnvelope, 'session_id' | 'source_seq' | 'event_type' | 'origin_system' | 'payload_ref' | 'payload_hash'>} envelope
 * @returns {string}
 */
export function eventContentFingerprint(envelope) {
  return structureHash({
    session_id: envelope.session_id,
    source_seq: envelope.source_seq,
    event_type: envelope.event_type,
    origin_system: envelope.origin_system,
    payload_ref: envelope.payload_ref,
    payload_hash: envelope.payload_hash,
  });
}

/**
 * @param {Record<string, unknown>} envelope
 * @param {Record<string, string | null | undefined>} bag
 * @param {EnvelopeError[]} errors
 * @param {string} field
 * @param {{ optional?: boolean, maxLength: number }} rule
 */
function checkStringField(bag, errors, field, rule) {
  const raw = bag[field];
  if (raw === undefined || raw === null || raw === '') {
    if (!rule.optional) errors.push({ field, code: 'required', message: `${field} 必填` });
    return;
  }
  if (typeof raw !== 'string') {
    errors.push({ field, code: 'type', message: `${field} 必须是字符串` });
    return;
  }
  if (raw !== raw.trim()) {
    errors.push({ field, code: 'format', message: `${field} 不能有首尾空白` });
  }
  if (raw.length > rule.maxLength) {
    errors.push({ field, code: 'too_long', message: `${field} 超过 ${rule.maxLength} 字符` });
  }
  // 控制字符（含换行）不允许出现在身份字段里。
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    errors.push({ field, code: 'format', message: `${field} 不能含控制字符` });
  }
}

/**
 * 纯校验，不做默认填充、不抛错。
 * @param {unknown} input
 * @returns {{ ok: boolean, errors: EnvelopeError[], value: EventEnvelope | null }}
 */
export function validateEnvelope(input) {
  /** @type {EnvelopeError[]} */
  const errors = [];
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      errors: [{ field: '$', code: 'type', message: '信封必须是对象' }],
      value: null,
    };
  }
  const bag = /** @type {Record<string, unknown>} */ (input);

  const allowed = new Set([...ENVELOPE_FIELDS, ...ENVELOPE_OPTIONAL_FIELDS]);
  for (const key of Object.keys(bag)) {
    if (!allowed.has(key)) {
      errors.push({ field: key, code: 'unknown_field', message: `未知字段 ${key}` });
    }
  }

  if (bag.schema_version !== EVENT_SCHEMA_VERSION) {
    errors.push({
      field: 'schema_version',
      code: 'range',
      message: `schema_version 必须是 ${EVENT_SCHEMA_VERSION}`,
    });
  }

  const eventId = bag.event_id;
  if (typeof eventId !== 'string' || !EVENT_ID_RE.test(eventId)) {
    errors.push({ field: 'event_id', code: 'format', message: 'event_id 形状不合法' });
  }

  checkStringField(bag, errors, 'source_system', { maxLength: FIELD_MAX_LENGTH.source_system });
  checkStringField(bag, errors, 'scope_id', { maxLength: FIELD_MAX_LENGTH.scope_id });
  checkStringField(bag, errors, 'person_id', { maxLength: FIELD_MAX_LENGTH.person_id });
  checkStringField(bag, errors, 'session_id', { maxLength: FIELD_MAX_LENGTH.session_id });
  checkStringField(bag, errors, 'source_event_id', { maxLength: FIELD_MAX_LENGTH.source_event_id });
  checkStringField(bag, errors, 'event_type', { maxLength: FIELD_MAX_LENGTH.event_type });
  checkStringField(bag, errors, 'origin_system', { maxLength: FIELD_MAX_LENGTH.origin_system });
  checkStringField(bag, errors, 'payload_ref', { maxLength: FIELD_MAX_LENGTH.payload_ref });
  checkStringField(bag, errors, 'producer', { maxLength: FIELD_MAX_LENGTH.producer, optional: true });
  checkStringField(bag, errors, 'turn_id', { maxLength: 256, optional: true });
  checkStringField(bag, errors, 'step_id', { maxLength: 256, optional: true });

  if (typeof bag.event_type === 'string' && bag.event_type.length > 0 && !EVENT_TYPE_RE.test(bag.event_type)) {
    errors.push({
      field: 'event_type',
      code: 'format',
      message: 'event_type 只允许小写字母/数字与 _.:/-',
    });
  }

  const seq = bag.source_seq;
  if (!Number.isSafeInteger(seq) || /** @type {number} */ (seq) < 0) {
    errors.push({ field: 'source_seq', code: 'range', message: 'source_seq 必须是非负安全整数' });
  }

  for (const field of /** @type {const} */ (['occurred_at', 'received_at'])) {
    const parsed = parseIsoInstant(bag[field]);
    if (parsed === null) {
      errors.push({
        field,
        code: 'format',
        message: `${field} 必须是带 Z 或 ±hh:mm 的 ISO 8601 时间`,
      });
    }
  }

  const payloadHash = bag.payload_hash;
  if (typeof payloadHash !== 'string' || !PAYLOAD_HASH_RE.test(payloadHash)) {
    errors.push({ field: 'payload_hash', code: 'format', message: 'payload_hash 必须是 sha256:<64 hex>' });
  }

  if (!PRIVACY_LEVELS.includes(/** @type {string} */ (bag.privacy))) {
    errors.push({ field: 'privacy', code: 'enum', message: `privacy 必须是 ${PRIVACY_LEVELS.join('/')}` });
  }

  if (bag.derived_from !== undefined) {
    const list = bag.derived_from;
    if (!Array.isArray(list)) {
      errors.push({ field: 'derived_from', code: 'type', message: 'derived_from 必须是数组' });
    } else {
      for (const item of list) {
        if (typeof item !== 'string' || !ID_RE.test(item)) {
          errors.push({ field: 'derived_from', code: 'format', message: 'derived_from 元素必须是合法 ID' });
          break;
        }
      }
    }
  }

  if (bag.payload_text !== undefined && bag.payload_text !== null) {
    if (typeof bag.payload_text !== 'string') {
      errors.push({ field: 'payload_text', code: 'type', message: 'payload_text 必须是字符串' });
    }
  }

  return { ok: errors.length === 0, errors, value: errors.length === 0 ? /** @type {EventEnvelope} */ (bag) : null };
}

/**
 * 校验并抛 `ValidationError`。
 * @param {unknown} input
 * @returns {EventEnvelope}
 */
export function assertValidEnvelope(input) {
  const result = validateEnvelope(input);
  if (!result.ok) {
    throw new ValidationError(`事件信封不合法（${result.errors.length} 处）`, result.errors);
  }
  return /** @type {EventEnvelope} */ (result.value);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 绑定校验：scope/person/source_system 必须由已认证连接器提供。
 * @param {unknown} bindings
 * @returns {{ source_system: string, scope_id: string, person_id: string }}
 */
export function assertBindings(bindings) {
  if (!isPlainObject(bindings)) {
    throw new ValidationError('缺少已认证连接器绑定', [
      { field: 'bindings', code: 'required', message: '必须传入 bindings（scope_id/person_id/source_system）' },
    ]);
  }
  /** @type {{ source_system: string, scope_id: string, person_id: string }} */
  const result = { source_system: '', scope_id: '', person_id: '' };
  for (const field of /** @type {const} */ (['source_system', 'scope_id', 'person_id'])) {
    const value = bindings[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new ValidationError('已认证连接器绑定不完整', [
        { field: `bindings.${field}`, code: 'required', message: `bindings.${field} 必须是非空字符串` },
      ]);
    }
    if (value !== value.trim()) {
      throw new ValidationError('已认证连接器绑定不合法', [
        { field: `bindings.${field}`, code: 'format', message: `bindings.${field} 不能有首尾空白` },
      ]);
    }
    result[field] = value;
  }
  return result;
}

/**
 * 规范化信封：补默认值 → 用绑定覆盖身份字段 → 校验 → 冻结。
 *
 * @param {unknown} input 原始信封（可能是连接器给的半成品）
 * @param {{
 *   bindings: { source_system: string, scope_id: string, person_id: string },
 *   clock?: { nowUtc: () => string, timeZone?: string },
 *   maxPayloadBytes?: number,
 * }} options
 * @returns {{ envelope: EventEnvelope, meta: EnvelopeMeta }}
 */
export function normalizeEnvelope(input, options) {
  if (!isPlainObject(input)) {
    throw new ValidationError('事件信封不合法', [
      { field: '$', code: 'type', message: '信封必须是对象' },
    ]);
  }
  const bindings = assertBindings(options?.bindings);
  const clock = options?.clock;
  const maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  const timeZone = clock?.timeZone ?? DEFAULT_TIME_ZONE;

  /** @type {EnvelopeError[]} */
  const preErrors = [];

  /** @type {Record<string, unknown>} */
  const draft = { ...input };

  // 1) 身份字段一律取绑定，输入里的同名字段被覆盖（不采信正文/模型自述）。
  /** @type {string[]} */
  const bindingOverrideFields = [];
  for (const field of /** @type {const} */ (['source_system', 'scope_id', 'person_id'])) {
    if (draft[field] !== undefined && draft[field] !== bindings[field]) {
      bindingOverrideFields.push(field);
    }
    draft[field] = bindings[field];
  }

  draft.schema_version = EVENT_SCHEMA_VERSION;

  // 2) 时间：received_at 缺失用当前时间；occurred_at 缺失用 received_at 并在 meta 标注。
  const receivedRaw = draft.received_at;
  const receivedAt = receivedRaw === undefined
    ? (clock ? clock.nowUtc() : toIsoUtc(new Date()))
    : parseIsoInstant(receivedRaw);
  if (receivedAt === null) {
    preErrors.push({
      field: 'received_at',
      code: 'format',
      message: 'received_at 必须是带 Z 或 ±hh:mm 的 ISO 8601 时间',
    });
  }
  const receivedIso = receivedAt === null ? String(receivedRaw) : toIsoUtc(receivedAt);

  const occurredRaw = draft.occurred_at;
  const occurredAt = occurredRaw === undefined ? null : parseIsoInstant(occurredRaw);
  const occurredAtDefaulted = occurredRaw === undefined;
  if (occurredRaw !== undefined && occurredAt === null) {
    preErrors.push({
      field: 'occurred_at',
      code: 'format',
      message: 'occurred_at 必须是带 Z 或 ±hh:mm 的 ISO 8601 时间',
    });
  }
  const occurredIso = occurredAt === null ? receivedIso : toIsoUtc(occurredAt);
  draft.received_at = receivedIso;
  draft.occurred_at = occurredIso;

  // 3) 内联片段与 payload 引用/哈希。
  let payloadText = /** @type {string | null} */ (null);
  if (draft.payload_text !== undefined && draft.payload_text !== null) {
    if (typeof draft.payload_text !== 'string') {
      preErrors.push({ field: 'payload_text', code: 'type', message: 'payload_text 必须是字符串' });
    } else {
      payloadText = draft.payload_text;
      const bytes = Buffer.byteLength(payloadText, 'utf8');
      if (bytes > maxPayloadBytes) {
        preErrors.push({
          field: 'payload_text',
          code: 'too_long',
          message: `payload_text 超过 ${maxPayloadBytes} 字节（收到 ${bytes}）`,
        });
      }
    }
  }

  // 4) event_id：未给就按唯一键派生（稳定、可复用）。
  if (draft.event_id === undefined) {
    draft.event_id = deriveEventId({
      source_system: bindings.source_system,
      scope_id: bindings.scope_id,
      source_event_id: typeof draft.source_event_id === 'string' ? draft.source_event_id : '',
    });
  }
  const eventId = typeof draft.event_id === 'string' ? draft.event_id : '';

  // 5) payload_ref / payload_hash 默认值。
  if (draft.payload_ref === undefined) {
    if (payloadText !== null) {
      draft.payload_ref = `inline:${eventId}`;
    }
  }
  if (draft.payload_hash === undefined) {
    if (payloadText !== null) {
      draft.payload_hash = contentHash(payloadText);
    }
  }
  draft.payload_text = payloadText;

  // 6) 其余默认值。
  if (draft.turn_id === undefined) draft.turn_id = null;
  if (draft.step_id === undefined) draft.step_id = null;
  if (draft.causation_id === undefined) draft.causation_id = null;
  if (draft.origin_system === undefined) draft.origin_system = 'human';
  if (draft.privacy === undefined) draft.privacy = 'private';
  if (draft.derived_from === undefined) draft.derived_from = [];

  if (preErrors.length > 0) {
    throw new ValidationError(`事件信封不合法（${preErrors.length} 处）`, preErrors);
  }

  const validation = validateEnvelope(draft);
  if (!validation.ok) {
    throw new ValidationError(`事件信封不合法（${validation.errors.length} 处）`, validation.errors);
  }
  const envelope = /** @type {EventEnvelope} */ (validation.value);
  const derivedFrom = Array.isArray(envelope.derived_from)
    ? Object.freeze([...new Set(envelope.derived_from)])
    : Object.freeze([]);
  /** @type {EventEnvelope} */
  const frozenEnvelope = Object.freeze({ ...envelope, derived_from: derivedFrom });

  const occurredDate = /** @type {Date} */ (parseIsoInstant(frozenEnvelope.occurred_at));
  const receivedDate = /** @type {Date} */ (parseIsoInstant(frozenEnvelope.received_at));

  /** @type {EnvelopeMeta} */
  const meta = {
    content_fingerprint: eventContentFingerprint(frozenEnvelope),
    occurred_at_local: formatLocalIso(occurredDate, timeZone),
    received_at_local: formatLocalIso(receivedDate, timeZone),
    time_zone: timeZone,
    payload_bytes: payloadText === null ? 0 : Buffer.byteLength(payloadText, 'utf8'),
    occurred_at_defaulted: occurredAtDefaulted,
    binding_override_fields: bindingOverrideFields,
    origin_system_known: KNOWN_ORIGIN_SYSTEMS.includes(frozenEnvelope.origin_system),
  };

  return { envelope: frozenEnvelope, meta };
}
