// @ts-check
/**
 * `@dsh-brain/core` —— 事件信封、稳定 ID、时钟、错误类型。
 * 纯函数，不碰 IO；任何模块都可以依赖本包，本包不依赖任何模块。
 */

export {
  BrainError,
  ValidationError,
  ConflictError,
  StorageError,
  QueueClosedError,
  DeletionBarrierError,
  MigrationError,
  BackupError,
  isSqliteError,
  isBrainError,
  asBrainError,
} from './errors.js';

export {
  DEFAULT_TIME_ZONE,
  createClock,
  formatLocalIso,
  isValidIsoInstant,
  isValidTimeZone,
  localParts,
  parseIsoInstant,
  timeZoneOffsetMinutes,
  toIsoUtc,
} from './clock.js';

export {
  canonicalJson,
  contentHash,
  sha256Hex,
  structureHash,
} from './canonical.js';

export {
  DEFAULT_ID_HEX_LENGTH,
  EVENT_ID_RE,
  PAYLOAD_HASH_RE,
  deriveEventId,
  deriveStableId,
  newEventId,
  normalizeEventIdentity,
  payloadHashOf,
} from './ids.js';

export {
  DEFAULT_MAX_PAYLOAD_BYTES,
  ENVELOPE_FIELDS,
  ENVELOPE_OPTIONAL_FIELDS,
  EVENT_SCHEMA_VERSION,
  KNOWN_ORIGIN_SYSTEMS,
  PRIVACY_LEVELS,
  assertBindings,
  assertValidEnvelope,
  eventContentFingerprint,
  normalizeEnvelope,
  validateEnvelope,
} from './envelope.js';
