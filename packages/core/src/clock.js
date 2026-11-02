// @ts-check
/**
 * 时钟：UTC 与本地时区双存（CONTRACTS 第 4.3 节「所有时间同时保存 UTC 时间戳和本地时区」）。
 *
 * 纯函数：`Intl` 是运行时内置能力，不做 IO；`now` 可注入以便测试确定化。
 */

/** 默认时区。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

/** RFC3339 严格形状（必须带 Z 或 ±hh:mm 偏移）。 */
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** @type {Map<string, Intl.DateTimeFormat>} */
const formatterCache = new Map();

/**
 * @param {string} timeZone
 * @returns {Intl.DateTimeFormat}
 */
function formatterFor(timeZone) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    // hourCycle h23：避免某些 ICU 数据在午夜返回 "24"。
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/**
 * @param {string} timeZone
 * @returns {boolean}
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/**
 * 本地时区分量。
 * @param {Date} instant
 * @param {string} timeZone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
export function localParts(instant, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(instant);
  /** @type {Record<string, number>} */
  const bag = {};
  for (const part of parts) {
    if (part.type === 'literal') continue;
    bag[part.type] = Number(part.value);
  }
  for (const key of ['year', 'month', 'day', 'hour', 'minute', 'second']) {
    if (!Number.isInteger(bag[key])) {
      throw new RangeError(`无法解析时区 ${timeZone} 的 ${key}`);
    }
  }
  return {
    year: bag.year,
    month: bag.month,
    day: bag.day,
    hour: bag.hour,
    minute: bag.minute,
    second: bag.second,
  };
}

/**
 * 该时刻的时区偏移（分钟，东为正）。
 * @param {Date} instant
 * @param {string} timeZone
 * @returns {number}
 */
export function timeZoneOffsetMinutes(instant, timeZone) {
  const p = localParts(instant, timeZone);
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second, instant.getUTCMilliseconds());
  return Math.round((localAsUtc - instant.getTime()) / 60000);
}

/**
 * 规范化 UTC ISO（毫秒精度，`Z` 结尾）。
 * @param {Date | number} value
 * @returns {string}
 */
export function toIsoUtc(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError('无效的时间值');
  return date.toISOString();
}

/**
 * 解析严格的 ISO instant；不合法返回 null（不抛）。
 * @param {unknown} value
 * @returns {Date | null}
 */
export function parseIsoInstant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT_RE.test(value)) return null;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidIsoInstant(value) {
  return parseIsoInstant(value) !== null;
}

/**
 * 本地时区 ISO（带 ±hh:mm 偏移），例如 `2026-10-28T18:00:00.000+08:00`。
 * @param {Date} instant
 * @param {string} [timeZone]
 * @returns {string}
 */
export function formatLocalIso(instant, timeZone = DEFAULT_TIME_ZONE) {
  const p = localParts(instant, timeZone);
  const offset = timeZoneOffsetMinutes(instant, timeZone);
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` +
    `.${pad(instant.getUTCMilliseconds(), 3)}${sign}${hh}:${mm}`
  );
}

/**
 * @typedef {Object} ClockStamp
 * @property {string} utc     UTC ISO（毫秒精度）
 * @property {string} local   本地时区 ISO（带偏移）
 * @property {string} time_zone IANA 时区名
 * @property {number} epoch_ms UTC 毫秒
 */

/**
 * @typedef {Object} Clock
 * @property {() => Date} now
 * @property {() => string} nowUtc
 * @property {() => string} nowLocal
 * @property {() => ClockStamp} stamp
 * @property {(value: unknown) => Date | null} parse
 * @property {(value: Date | number | string) => string} toUtc
 * @property {string} timeZone
 */

/**
 * 造一个时钟。`now` 可注入（测试固定时间）。
 * @param {{ now?: () => Date | number, timeZone?: string }} [options]
 * @returns {Clock}
 */
export function createClock(options = {}) {
  const timeZone = options.timeZone ?? DEFAULT_TIME_ZONE;
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`无效时区：${String(timeZone)}`);
  }
  const now = options.now ?? (() => new Date());

  /** @returns {Date} */
  const nowDate = () => {
    const raw = now();
    const date = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(date.getTime())) throw new RangeError('时钟返回了无效时间');
    return date;
  };

  return {
    now: nowDate,
    nowUtc: () => toIsoUtc(nowDate()),
    nowLocal: () => formatLocalIso(nowDate(), timeZone),
    stamp: () => {
      const date = nowDate();
      return {
        utc: toIsoUtc(date),
        local: formatLocalIso(date, timeZone),
        time_zone: timeZone,
        epoch_ms: date.getTime(),
      };
    },
    parse: (value) => {
      if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
      if (typeof value === 'number') {
        const d = new Date(value);
        return Number.isNaN(d.getTime()) ? null : d;
      }
      return parseIsoInstant(value);
    },
    toUtc: (value) => {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) throw new RangeError('无效的时间值');
      return toIsoUtc(date);
    },
    timeZone,
  };
}
