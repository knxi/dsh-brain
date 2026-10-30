// @ts-check
/**
 * M1 契约：事件信封、稳定 ID、时钟、错误分类（`@dsh-brain/core`，纯函数）。
 */

import test from 'node:test';
import {
  assert,
  DEFAULT_BINDINGS,
  createEvent,
} from './helpers.mjs';
import {
  ConflictError,
  PRIVACY_LEVELS,
  StorageError,
  ValidationError,
  assertBindings,
  assertValidEnvelope,
  canonicalJson,
  createClock,
  deriveEventId,
  eventContentFingerprint,
  formatLocalIso,
  isBrainError,
  isValidIsoInstant,
  normalizeEnvelope,
  payloadHashOf,
  validateEnvelope,
} from '../../packages/core/src/index.js';

const clock = createClock({ timeZone: 'Asia/Shanghai', now: () => new Date('2026-10-28T10:00:03.000Z') });

test('normalizeEnvelope：身份字段只取绑定，伪造值被覆盖并记录', () => {
  const input = createEvent({
    // 伪造：正文/模型自述里出现的 scope / person / source_system 一律不采信
    source_system: 'evil-system',
    scope_id: 'someone-else',
    person_id: 'not-owner',
  });
  const { envelope, meta } = normalizeEnvelope(input, { bindings: DEFAULT_BINDINGS, clock });

  assert.equal(envelope.source_system, 'dsh');
  assert.equal(envelope.scope_id, 'owner-default');
  assert.equal(envelope.person_id, 'owner');
  assert.deepEqual(meta.binding_override_fields.sort(), ['person_id', 'scope_id', 'source_system']);
  assert.equal(envelope.schema_version, 1);
  assert.equal(envelope.privacy, 'private');
  assert.equal(envelope.turn_id, null);
  assert.equal(envelope.step_id, null);
  assert.equal(envelope.causation_id, null);
  assert.deepEqual(envelope.derived_from, []);
  assert.equal(envelope.received_at, '2026-10-28T10:00:03.000Z');
  assert.equal(envelope.event_id, deriveEventId({
    source_system: 'dsh',
    scope_id: 'owner-default',
    source_event_id: 'host-1',
  }));
  assert.equal(envelope.payload_ref, `inline:${envelope.event_id}`);
  assert.equal(envelope.payload_hash, payloadHashOf(String(input.payload_text)));
});

test('normalizeEnvelope：校验失败抛 ValidationError，逐字段列出问题', () => {
  const cases = [
    [{ session_id: undefined }, 'session_id'],
    [{ source_seq: -1 }, 'source_seq'],
    [{ source_seq: 1.5 }, 'source_seq'],
    [{ occurred_at: '昨天下午' }, 'occurred_at'],
    [{ received_at: '2026-10-28' }, 'received_at'],
    [{ payload_hash: 'md5:abc' }, 'payload_hash'],
    [{ privacy: 'top-secret' }, 'privacy'],
    [{ event_type: 'User Message' }, 'event_type'],
    [{ unknown_field_here: 1 }, 'unknown_field_here'],
  ];
  for (const [patch, field] of cases) {
    const input = { ...createEvent(), ...patch };
    if (patch.session_id === undefined) delete input.session_id;
    let error = null;
    try {
      normalizeEnvelope(input, { bindings: DEFAULT_BINDINGS, clock });
    } catch (err) {
      error = err;
    }
    assert.ok(error instanceof ValidationError, `${field} 应该抛 ValidationError，实际 ${String(error)}`);
    assert.ok(
      error.errors.some((item) => item.field === field),
      `${field} 的错误项缺失：${JSON.stringify(error.errors)}`,
    );
  }
  assert.equal(PRIVACY_LEVELS.length, 3);
  assert.throws(() => assertValidEnvelope({ nope: true }), ValidationError);
});

test('normalizeEnvelope：缺少已认证绑定直接拒绝', () => {
  assert.throws(() => assertBindings({}), ValidationError);
  assert.throws(() => normalizeEnvelope(createEvent(), {}), ValidationError);
});

test('稳定 ID：同唯一键永远同 ID，且与字段键序无关', () => {
  const a = normalizeEnvelope(createEvent(), { bindings: DEFAULT_BINDINGS, clock });
  const b = normalizeEnvelope(createEvent({ received_at: '2026-10-28T10:00:09.000Z' }), {
    bindings: DEFAULT_BINDINGS,
    clock,
  });
  assert.equal(a.envelope.event_id, b.envelope.event_id);

  const c = normalizeEnvelope(createEvent({ source_event_id: 'host-2' }), { bindings: DEFAULT_BINDINGS, clock });
  assert.notEqual(a.envelope.event_id, c.envelope.event_id);

  const key1 = { source_system: 'dsh', scope_id: 'owner-default', source_event_id: 'host-1' };
  const key2 = { source_event_id: 'host-1', scope_id: 'owner-default', source_system: 'dsh' };
  assert.equal(deriveEventId(key1), deriveEventId(key2));
});

test('canonicalJson / payloadHashOf：键序稳定，非法值拒绝', () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"b":1}');
  assert.equal(payloadHashOf({ a: 1, b: 2 }), payloadHashOf({ b: 2, a: 1 }));
  assert.match(payloadHashOf('文本'), /^sha256:[0-9a-f]{64}$/);
  assert.throws(() => canonicalJson({ n: Number.NaN }), /NaN/);
  const loop = { name: 'x' };
  // @ts-expect-error 故意造循环引用
  loop.self = loop;
  assert.throws(() => canonicalJson(loop), /循环/);
});

test('内容指纹：重放不变，正文或序号变化则视为不同', () => {
  const base = normalizeEnvelope(createEvent(), { bindings: DEFAULT_BINDINGS, clock });
  const replay = normalizeEnvelope(createEvent({ received_at: '2026-10-28T10:00:30.000Z' }), {
    bindings: DEFAULT_BINDINGS,
    clock,
  });
  assert.equal(base.meta.content_fingerprint, replay.meta.content_fingerprint);

  const changedText = normalizeEnvelope(createEvent({ payload_text: '换个说法' }), {
    bindings: DEFAULT_BINDINGS,
    clock,
  });
  assert.notEqual(base.meta.content_fingerprint, changedText.meta.content_fingerprint);

  const changedSeq = normalizeEnvelope(createEvent({ source_seq: 2 }), { bindings: DEFAULT_BINDINGS, clock });
  assert.notEqual(base.meta.content_fingerprint, changedSeq.meta.content_fingerprint);
  assert.equal(base.meta.content_fingerprint, eventContentFingerprint(base.envelope));
});

test('时钟：UTC 与本地时区双存，格式可断言', () => {
  const stamp = clock.stamp();
  assert.equal(stamp.utc, '2026-10-28T10:00:03.000Z');
  assert.equal(stamp.local, '2026-10-28T18:00:03.000+08:00');
  assert.equal(stamp.time_zone, 'Asia/Shanghai');
  assert.equal(formatLocalIso(new Date('2026-01-01T00:00:00.000Z'), 'UTC'), '2026-01-01T00:00:00.000+00:00');
  assert.throws(() => createClock({ timeZone: 'Mars/Olympus' }), RangeError);
  assert.equal(isValidIsoInstant('2026-10-28T10:00:00Z'), true);
  assert.equal(isValidIsoInstant('2026-10-28T10:00:00+08:00'), true);
  assert.equal(isValidIsoInstant('2026-10-28 10:00:00'), false);
  assert.equal(isValidIsoInstant('2026-13-40T99:99:99Z'), false);
});

test('错误分类：磁盘满/busy/约束失败映射稳定且不误报已记住', () => {
  // node:sqlite 抛的是 Error 实例，带 code/errcode/errstr
  const fullError = Object.assign(new Error('database or disk is full'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 13,
    errstr: 'database or disk is full',
  });
  const full = StorageError.classify(fullError);
  assert.equal(full.code, 'STORAGE_FULL');
  assert.equal(full.retriable, false);

  const busyError = Object.assign(new Error('database is locked'), {
    code: 'ERR_SQLITE_ERROR',
    errcode: 5,
    errstr: 'database is locked',
  });
  const busy = StorageError.classify(busyError);
  assert.equal(busy.code, 'STORAGE_BUSY');
  assert.equal(busy.retriable, true);

  const constraint = StorageError.classify(
    Object.assign(new Error('UNIQUE constraint failed'), { code: 'ERR_SQLITE_ERROR', errcode: 1555 }),
  );
  assert.equal(constraint.code, 'STORAGE_ERROR');

  const plain = StorageError.classify(new Error('boom'));
  assert.equal(plain.code, 'STORAGE_ERROR');

  const cause = new Error('root');
  const wrapped = StorageError.from(cause, 'ingestEvent');
  assert.equal(wrapped.code, 'STORAGE_ERROR');
  assert.equal(wrapped.cause, cause);
  assert.equal(wrapped.details.operation, 'ingestEvent');
  // 错误对象上没有任何「已记住」标记
  assert.equal('persisted' in wrapped, false);

  const conflict = new ConflictError('x', {
    source_system: 'dsh',
    scope_id: 'owner-default',
    source_event_id: 'host-1',
    event_id: 'evt_1',
    stored_payload_hash: 'sha256:a',
    incoming_payload_hash: 'sha256:b',
  });
  assert.equal(conflict.code, 'EVENT_CONFLICT');
  assert.equal(conflict.info.stored_payload_hash, 'sha256:a');
  assert.equal(isBrainError(conflict), true);
});

test('validateEnvelope：合法信封直接通过，不产生错误', () => {
  const { envelope } = normalizeEnvelope(createEvent(), { bindings: DEFAULT_BINDINGS, clock });
  const result = validateEnvelope(envelope);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});
