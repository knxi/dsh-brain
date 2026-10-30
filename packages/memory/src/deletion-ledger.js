// @ts-check
/**
 * 独立删除账本（M3-INTERFACES §1）。
 *
 * **为什么必须有**：只从旧备份里读 tombstone，永远不知道「比这个备份更新的删除」。
 * 备份是某一刻的快照，账本才是「删除发生过」的单调事实流。恢复工具如果把备份直接
 * 上架，备份里那条已经被删的记忆就会复活——M3 门槛「旧备份恢复不复活」就靠这本账。
 *
 * ## 落点与形态
 * - **活跃 DB 之外**：默认 `<dbPath 所在目录>/deletion-ledger/`（生产即 `data/deletion-ledger/`），
 *   可指到别的盘或离线介质。**不写死绝对路径**：测试里 openBrain 指向 mkdtemp，
 *   账本自然跟着进临时目录，不会污染仓库。
 * - `entries.jsonl`：append-only，一行一条删除；每行带 `prevHash` → `entryHash` 的 hash 链。
 * - `tail.json`：水位文件（entries / lastSeq / lastHash / epoch）+ 尾部 checksum，原子改名落位。
 *   它让 `watermark()` 成为 O(1)，也让「文件被截断」这件事可被检测（行数对不上 checksum）。
 *
 * ## 绝不存被删正文
 * 行里只有元数据白名单键（见 `ENTRY_KEYS`）。传进来的多余字段**直接拒绝**，不是静默丢弃——
 * 「账本里没有正文」这件事必须由代码保证，不能靠调用方自觉。`reason` 会被截断到
 * `MAX_REASON_CHARS`（用户可能在里面粘正文，截断是最后一道闸）。
 *
 * ## 追加失败的语义
 * `append()` 抛错 = 账本没记上 = **删除请求必须失败**（M3-INTERFACES §1.3）。
 * 账本与 DB 事务的相对顺序是「先记账本、后提交 DB」：最坏情况是账本多一条而 DB 没删
 * （恢复时会重放一条幂等的删除），这个方向的错误是安全的；反过来的错误（DB 删了而
 * 账本没记）会让旧备份复活，绝不接受。
 *
 * ## 可降级构造，不可降级追加
 * 目录建不出来 / 不可写时，`createDeletionLedger()` **不抛**，返回 `available=false` 的实例
 * （`openBrain()` 不能因为账本目录没建好就整个起不来）。但一旦要删除，`append()` 必须抛错，
 * 由删除事务把它变成「删除失败」——不许虚报删除成功。
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrainError, canonicalJson, contentHash, createClock, sha256Hex } from '@dsh-brain/core';

/** 账本格式版本。改格式要能读老版本，否则恢复工具会误判 corrupt。 */
export const LEDGER_FORMAT_VERSION = 1;

export const LEDGER_ENTRIES_FILE = 'entries.jsonl';
export const LEDGER_TAIL_FILE = 'tail.json';
export const LEDGER_LOCK_FILE = 'append.lock';

/** 链首行的 prevHash 常量（不是哈希，是标记：一眼能看出这是第一行）。 */
export const GENESIS_HASH = 'GENESIS';

/** reason 字段上限。用户粘正文进来时截断，账本不该成为第二条正文通道。 */
export const MAX_REASON_CHARS = 160;

/**
 * 行里允许出现的键（白名单）。任何不在表里的键 = corrupt。
 * 这张表就是「绝不存被删正文」的可执行定义。
 */
export const ENTRY_KEYS = Object.freeze([
  'v',
  'seq',
  'tombstoneId',
  'targetKind',
  'targetId',
  'memoryId',
  'epoch',
  'requestedAt',
  'scopeId',
  'reason',
  'actor',
  'prevHash',
  'entryHash',
]);

const ENTRY_KEY_SET = new Set(ENTRY_KEYS);

/** 明确拒绝的正文类字段：调用方传了就是意图错误，必须大声失败而不是悄悄忽略。 */
const FORBIDDEN_INPUT_KEYS = Object.freeze(['content', 'text', 'body', 'summary', 'snippet', 'payload', 'excerpt', 'memories']);

/**
 * append 接受的输入键（白名单）。**多余字段一律拒绝**，不是静默丢弃——
 * `memoryText` 这种"看起来像正文"的字段只要被静默忽略，就永远不知道自己差点把正文
 * 写进账本。宁可让调用方立刻炸一次，也不要让账本变成第二条正文通道。
 */
const INPUT_KEY_SET = new Set(['tombstoneId', 'memoryId', 'targetKind', 'targetId', 'epoch', 'requestedAt', 'scopeId', 'reason', 'actor']);

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** 仓库内 `data/` 默认落点（生产用；测试里由调用方显式传 dir）。 */
export function defaultDeletionLedgerDir({ dbPath } = {}) {
  if (typeof dbPath === 'string' && dbPath.length > 0) {
    return path.join(path.dirname(path.resolve(dbPath)), 'deletion-ledger');
  }
  // path.resolve 去掉 fileURLToPath 带的尾分隔符，避免调用方拿到 '…\\deletion-ledger\\'
  return path.resolve(fileURLToPath(new URL('../../../data/deletion-ledger/', import.meta.url)));
}

/**
 * 同步小睡（账本追加在写事务内，不能 await，只能用同步等待）。
 * @param {number} ms
 */
function sleepSync(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new BrainError('INVALID_ARGUMENT', `删除账本缺少 ${field}`);
  }
  return value;
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {number}
 */
function requirePositiveInt(value, field) {
  if (!Number.isInteger(value) || Number(value) < 1) {
    throw new BrainError('INVALID_ARGUMENT', `删除账本的 ${field} 必须是 >= 1 的整数（收到 ${String(value)}）`);
  }
  return /** @type {number} */ (value);
}

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string}
 */
function requireIso(value, field) {
  const text = requireString(value, field);
  if (!ISO_RE.test(text)) {
    throw new BrainError('INVALID_ARGUMENT', `删除账本的 ${field} 必须是 UTC ISO（形如 2026-10-28T10:00:00.000Z，收到 ${text}）`);
  }
  return text;
}

/**
 * reason 截断：按码点切，不切坏中文。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeReason(value) {
  if (value === undefined || value === null) return '';
  const chars = [...String(value).replace(/[\r\n]+/g, ' ')];
  return chars.length <= MAX_REASON_CHARS ? chars.join('') : `${chars.slice(0, MAX_REASON_CHARS).join('')}…`;
}

/**
 * 一行的哈希：去掉 `entryHash` 后规范化再哈希（键序无关）。
 * @param {Record<string, unknown>} entryWithoutHash
 * @returns {string}
 */
export function computeEntryHash(entryWithoutHash) {
  return contentHash(canonicalJson(entryWithoutHash));
}

/**
 * tail 的 checksum：把「行数 + 水位 + 链尾」一起盖章。
 * 截断文件会让 entries 少 → checksum 不符；换掉末行会让 lastHash 变 → 也不符。
 * @param {{ v: number, entries: number, lastSeq: number, lastHash: string, epoch: number, updatedAt: string }} tail
 * @returns {string}
 */
export function computeTailChecksum(tail) {
  return contentHash(
    canonicalJson({
      v: tail.v,
      entries: tail.entries,
      lastSeq: tail.lastSeq,
      lastHash: tail.lastHash,
      epoch: tail.epoch,
      updatedAt: tail.updatedAt,
    }),
  );
}

/**
 * @typedef {Object} LedgerEntry
 * @property {number} v
 * @property {number} seq
 * @property {string} tombstoneId
 * @property {string} targetKind
 * @property {string} targetId
 * @property {string|null} memoryId
 * @property {number} epoch
 * @property {string} requestedAt
 * @property {string} scopeId
 * @property {string} reason
 * @property {string} actor
 * @property {string} prevHash
 * @property {string} entryHash
 */

/**
 * @typedef {Object} LedgerTail
 * @property {number} v
 * @property {number} entries
 * @property {number} lastSeq
 * @property {string} lastHash
 * @property {number} epoch
 * @property {string} updatedAt
 * @property {string} checksum
 */

/**
 * 造独立删除账本。
 *
 * 构造**不抛**（目录不可用 → `available=false`），追加才抛。
 *
 * @param {{
 *   dir: string,
 *   clock?: { stamp: () => { utc: string, local: string } },
 *   fsync?: boolean,
 *   readOnly?: boolean,
 *   lockTimeoutMs?: number,
 *   alert?: (info: { kind: string, message: string, detail?: Record<string, unknown> }) => void,
 * }} options
 */
export function createDeletionLedger(options) {
  if (!options || typeof options.dir !== 'string' || options.dir.length === 0) {
    throw new TypeError('createDeletionLedger 需要 dir');
  }
  const dir = options.dir;
  const clock = options.clock ?? createClock();
  const doFsync = options.fsync !== false;
  const lockTimeoutMs = options.lockTimeoutMs ?? 2000;
  const alert = options.alert ?? (() => {});

  const entriesPath = path.join(dir, LEDGER_ENTRIES_FILE);
  const tailPath = path.join(dir, LEDGER_TAIL_FILE);
  const lockPath = path.join(dir, LEDGER_LOCK_FILE);

  /** @type {string|null} */
  let unavailableReason = null;
  if (options.readOnly === true) {
    // 只读巡检（检查器 / 恢复预演）：不去 mkdir、不写探针文件——巡检本身不许留痕。
    // 目录不存在就是「没有账本」，由 checkForRestore 报 LEDGER_MISSING。
    if (!existsSync(dir)) unavailableReason = 'read_only_mode_and_dir_missing';
  } else {
    try {
      mkdirSync(dir, { recursive: true });
      // 真实可写性探针：目录存在不等于可写（只读挂载 / 权限 / 公司策略）。
      const probe = path.join(dir, `.probe-${process.pid}-${Date.now().toString(36)}`);
      writeFileSync(probe, 'ok', { encoding: 'utf8' });
      rmSync(probe, { force: true });
    } catch (err) {
      unavailableReason = err instanceof Error ? err.message : String(err);
      try {
        alert({
          kind: 'deletion_ledger_unavailable',
          message: '独立删除账本目录不可用：删除请求将失败（这是故意的，不许虚报删除成功）',
          detail: { dir, error: unavailableReason.slice(0, 200) },
        });
      } catch {
        /* 告警回调不得影响构造 */
      }
    }
  }

  /** @param {boolean} [forWrite] */
  function assertAvailable(forWrite = true) {
    if (unavailableReason === null) return;
    const suffix = forWrite ? '：账本不可用，删除请求必须失败（不许虚报删除成功）' : '：账本不可用';
    throw new BrainError('STORAGE_ERROR', `独立删除账本不可用（${dir}）${suffix}`, {
      details: { dir, error: unavailableReason.slice(0, 200) },
    });
  }

  /** @returns {string} */
  function readTextIfExists(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch (err) {
      const code = /** @type {{ code?: string }} */ (err).code;
      if (code === 'ENOENT') return '';
      throw new BrainError('STORAGE_ERROR', `读取删除账本失败：${file}`, {
        details: { file, error: err instanceof Error ? err.message.slice(0, 200) : String(err) },
      });
    }
  }

  /**
   * 解析行并做**结构**校验（不含链校验，链在 verify 里做）。
   * @returns {{ lines: Array<{ raw: string, entry?: LedgerEntry, error?: string }> }}
   */
  function parseLines() {
    const text = readTextIfExists(entriesPath);
    if (text.length === 0) return { lines: [] };
    const rawLines = text.split('\n');
    // 文件以换行结尾 → 最后一段是空串，不算行。
    if (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
    /** @type {Array<{ raw: string, entry?: LedgerEntry, error?: string }>} */
    const lines = [];
    for (const raw of rawLines) {
      if (raw.trim().length === 0) {
        lines.push({ raw, error: 'blank_line' });
        continue;
      }
      try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          lines.push({ raw, error: 'not_an_object' });
          continue;
        }
        lines.push({ raw, entry: /** @type {LedgerEntry} */ (parsed) });
      } catch {
        lines.push({ raw, error: 'unparsable' });
      }
    }
    return { lines };
  }

  /**
   * 只读严格校验：链、行结构、白名单、tail 一致性。
   * @returns {{ ok: boolean, entryCount: number, lastSeq: number, corruptAt?: string, repairable?: boolean, detail?: Record<string, unknown> }}
   */
  function verify() {
    if (unavailableReason !== null) {
      return { ok: false, entryCount: 0, lastSeq: 0, corruptAt: 'unavailable', detail: { error: unavailableReason.slice(0, 200) } };
    }
    if (!existsSync(entriesPath) && !existsSync(tailPath)) {
      return { ok: false, entryCount: 0, lastSeq: 0, corruptAt: 'missing' };
    }

    const { lines } = parseLines();
    let prev = GENESIS_HASH;
    /** @type {LedgerEntry|null} */
    let last = null;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const where = `line:${i + 1}`;
      if (line.error !== undefined || line.entry === undefined) {
        return { ok: false, entryCount: i, lastSeq: last?.seq ?? 0, corruptAt: `${where}:${line.error ?? 'unknown'}` };
      }
      const entry = line.entry;
      const extra = Object.keys(entry).filter((key) => !ENTRY_KEY_SET.has(key));
      if (extra.length > 0) {
        // 多出来的键最危险：那是往账本塞正文的通道。
        return {
          ok: false,
          entryCount: i,
          lastSeq: last?.seq ?? 0,
          corruptAt: `${where}:unexpected_field`,
          detail: { fields: extra.slice(0, 8) },
        };
      }
      if (entry.v !== LEDGER_FORMAT_VERSION) {
        return {
          ok: false,
          entryCount: i,
          lastSeq: last?.seq ?? 0,
          corruptAt: `${where}:unsupported_version`,
          detail: { v: entry.v },
        };
      }
      if (entry.seq !== i + 1) {
        return { ok: false, entryCount: i, lastSeq: last?.seq ?? 0, corruptAt: `${where}:seq_gap`, detail: { seq: entry.seq } };
      }
      if (entry.prevHash !== prev) {
        return { ok: false, entryCount: i, lastSeq: last?.seq ?? 0, corruptAt: `${where}:chain_broken` };
      }
      const { entryHash, ...withoutHash } = entry;
      const recomputed = computeEntryHash(/** @type {Record<string, unknown>} */ (withoutHash));
      if (recomputed !== entryHash) {
        return { ok: false, entryCount: i, lastSeq: last?.seq ?? 0, corruptAt: `${where}:hash_mismatch` };
      }
      prev = entryHash;
      last = entry;
    }

    const entryCount = lines.length;
    const lastSeq = last?.seq ?? 0;
    const lastHash = last?.entryHash ?? GENESIS_HASH;
    const epoch = last?.epoch ?? 0;

    if (!existsSync(tailPath)) {
      return { ok: false, entryCount, lastSeq, corruptAt: 'tail_missing', repairable: entryCount > 0 };
    }
    /** @type {LedgerTail} */
    let tail;
    try {
      tail = JSON.parse(readTextIfExists(tailPath));
    } catch {
      return { ok: false, entryCount, lastSeq, corruptAt: 'tail_unparsable' };
    }
    const expected = computeTailChecksum({
      v: Number(tail.v),
      entries: Number(tail.entries),
      lastSeq: Number(tail.lastSeq),
      lastHash: String(tail.lastHash ?? ''),
      epoch: Number(tail.epoch),
      updatedAt: String(tail.updatedAt ?? ''),
    });
    if (expected !== tail.checksum) {
      return { ok: false, entryCount, lastSeq, corruptAt: 'tail_checksum_mismatch' };
    }
    if (Number(tail.entries) !== entryCount) {
      // 行数少于 tail = 文件被截断；行数多于 tail = 追加写了一半（torn append）。
      // 后者可以靠下一行 append 自愈，但**恢复工具必须当它不干净**。
      return {
        ok: false,
        entryCount,
        lastSeq,
        corruptAt: Number(tail.entries) > entryCount ? 'tail_ahead_of_entries' : 'entries_ahead_of_tail',
        repairable: Number(tail.entries) < entryCount,
        detail: { tailEntries: Number(tail.entries) },
      };
    }
    if (Number(tail.lastSeq) !== lastSeq || String(tail.lastHash) !== lastHash) {
      return {
        ok: false,
        entryCount,
        lastSeq,
        corruptAt: 'tail_chain_mismatch',
        detail: { tailLastSeq: Number(tail.lastSeq) },
      };
    }
    return { ok: true, entryCount, lastSeq };
  }

  /**
   * 读 tail（不校验，给 watermark 快路径用）。
   * @returns {LedgerTail|null}
   */
  function readTail() {
    if (!existsSync(tailPath)) return null;
    try {
      const parsed = JSON.parse(readTextIfExists(tailPath));
      if (parsed === null || typeof parsed !== 'object') return null;
      return /** @type {LedgerTail} */ (parsed);
    } catch {
      return null;
    }
  }

  /**
   * 原子写 tail：`.tmp` → fsync → rename。写到一半崩溃不会留下半个 tail。
   * @param {{ entries: number, lastSeq: number, lastHash: string, epoch: number, updatedAt: string }} next
   * @returns {LedgerTail}
   */
  function writeTail(next) {
    const tail = {
      v: LEDGER_FORMAT_VERSION,
      entries: next.entries,
      lastSeq: next.lastSeq,
      lastHash: next.lastHash,
      epoch: next.epoch,
      updatedAt: next.updatedAt,
      checksum: '',
    };
    tail.checksum = computeTailChecksum(tail);
    const tmp = `${tailPath}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify(tail)}\n`, { encoding: 'utf8' });
    if (doFsync) {
      const fd = openSync(tmp, 'r+');
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    renameSync(tmp, tailPath);
    return tail;
  }

  /**
   * 在锁内重建当前水位状态。
   *
   * **每次 append 都重读并全量校验**，不用进程内缓存：账本会被恢复工具、别的进程、
   * 甚至人手动看过/改过，缓存一份「我以为的水位」正是让链写坏的最短路径。
   * 条目数本来就不大（一次删除一行），拿正确性换这点性能不划算。
   *
   * 唯一允许的修复：`entries_ahead_of_tail` / `tail_missing`（上一轮追加写完行但没来得及
   * 写 tail），且**只在链完整时**把 tail 重建到实际行数。其余任何异常都抛错拒绝继续写。
   */
  function reconcileState() {
    const verdict = verify();
    if (!verdict.ok) {
      // 全新账本（两个文件都不存在）不是 corrupt，是「还没开始记」。允许从第 1 行起头。
      // 注意方向：这里只放行**写侧**初始化；`checkForRestore` 面对同样的状态仍然报
      // LEDGER_MISSING（恢复工具不许把「没记过账」当成「没有删除」）。
      if (verdict.corruptAt === 'missing') {
        return { entries: 0, lastSeq: 0, lastHash: GENESIS_HASH, epoch: 0, updatedAt: clock.stamp().utc };
      }
      const repairable =
        verdict.repairable === true && (verdict.corruptAt === 'entries_ahead_of_tail' || verdict.corruptAt === 'tail_missing');
      if (!repairable) {
        throw new BrainError('STORAGE_CORRUPT', `删除账本校验失败，拒绝继续追加（${verdict.corruptAt}）`, {
          details: { dir, corruptAt: verdict.corruptAt ?? null },
        });
      }
      const { lines } = parseLines();
      const last = lines.length > 0 ? lines[lines.length - 1].entry : undefined;
      const rebuilt = writeTail({
        entries: lines.length,
        lastSeq: last?.seq ?? 0,
        lastHash: last?.entryHash ?? GENESIS_HASH,
        epoch: last?.epoch ?? 0,
        updatedAt: clock.stamp().utc,
      });
      alert({
        kind: 'deletion_ledger_tail_repaired',
        message: '删除账本尾部水位落后于数据行，已按链完整状态重建水位（上一轮追加未完成）',
        detail: { dir, entries: lines.length },
      });
      return {
        entries: rebuilt.entries,
        lastSeq: rebuilt.lastSeq,
        lastHash: rebuilt.lastHash,
        epoch: rebuilt.epoch,
        updatedAt: rebuilt.updatedAt,
      };
    }
    const tail = readTail();
    return {
      entries: tail ? Number(tail.entries) : 0,
      lastSeq: tail ? Number(tail.lastSeq) : 0,
      lastHash: tail ? String(tail.lastHash) : GENESIS_HASH,
      epoch: tail ? Number(tail.epoch) : 0,
      updatedAt: tail ? String(tail.updatedAt) : clock.stamp().utc,
    };
  }

  /**
   * 独占追加锁。账本是 append-only，多写者交错会直接写出坏链——
   * 宁可让第二个写者明确失败（STORAGE_BUSY），也不写坏。
   * @template T
   * @param {() => T} fn
   * @returns {T}
   */
  function withAppendLock(fn) {
    const started = Date.now();
    /** @type {number|null} */
    let fd = null;
    while (fd === null) {
      try {
        fd = openSync(lockPath, 'wx');
      } catch (err) {
        const code = /** @type {{ code?: string }} */ (err).code;
        if (code !== 'EEXIST') {
          throw new BrainError('STORAGE_ERROR', '删除账本加锁失败', {
            details: { dir, error: err instanceof Error ? err.message.slice(0, 200) : String(err) },
          });
        }
        if (Date.now() - started > lockTimeoutMs) {
          throw new BrainError('STORAGE_BUSY', `删除账本追加锁被占用超过 ${lockTimeoutMs}ms，拒绝并发写入`, {
            details: { dir, lock: lockPath },
          });
        }
        sleepSync(10);
      }
    }
    try {
      writeSync(fd, `${process.pid}:${new Date().toISOString()}\n`);
      return fn();
    } finally {
      try {
        closeSync(/** @type {number} */ (fd));
      } catch {
        /* 关闭失败也要释放锁文件 */
      }
      try {
        rmSync(lockPath, { force: true });
      } catch {
        /* 锁文件删不掉时下一次追加会超时报 STORAGE_BUSY，不会写坏链 */
      }
    }
  }

  /**
   * 追加一条删除记录。
   *
   * 调用位置：**删除 DB 事务内**（在 INSERT tombstone 之后、COMMIT 之前）。
   * 抛错即代表「账本没记上」→ 调用方必须让整个删除请求失败。
   *
   * @param {{
   *   tombstoneId: string,
   *   memoryId?: string|null,
   *   targetKind?: string,
   *   targetId?: string,
   *   epoch: number,
   *   requestedAt: string,
   *   scopeId: string,
   *   reason?: string,
   *   actor?: string,
   * }} input
   * @returns {{ seq: number, entryHash: string, watermark: { epoch: number, lastSeq: number, updatedAt: string } }}
   */
  function append(input) {
    assertAvailable(true);
    if (input === null || typeof input !== 'object') {
      throw new BrainError('INVALID_ARGUMENT', '删除账本 append 需要对象参数');
    }
    const forbidden = FORBIDDEN_INPUT_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(input, key));
    if (forbidden.length > 0) {
      throw new BrainError(
        'INVALID_ARGUMENT',
        `删除账本禁止存被删正文：不接受字段 ${forbidden.join(', ')}。账本只存元数据。`,
      );
    }
    const unexpected = Object.keys(input).filter((key) => !INPUT_KEY_SET.has(key));
    if (unexpected.length > 0) {
      throw new BrainError(
        'INVALID_ARGUMENT',
        `删除账本只接受元数据字段，收到未知字段 ${unexpected.join(', ')}（不要在账本里放正文或大字段）`,
      );
    }
    const targetKind = typeof input.targetKind === 'string' && input.targetKind.length > 0 ? input.targetKind : 'memory';
    const memoryId = input.memoryId === undefined || input.memoryId === null ? null : requireString(input.memoryId, 'memoryId');
    /** @type {string} */
    let targetId;
    if (input.targetId !== undefined && input.targetId !== null) {
      targetId = requireString(input.targetId, 'targetId');
    } else if (memoryId !== null) {
      targetId = memoryId;
    } else {
      throw new BrainError('INVALID_ARGUMENT', '删除账本 append 需要 targetId 或 memoryId');
    }
    const epoch = requirePositiveInt(input.epoch, 'epoch');

    const body = {
      v: LEDGER_FORMAT_VERSION,
      seq: 0,
      tombstoneId: requireString(input.tombstoneId, 'tombstoneId'),
      targetKind,
      targetId,
      memoryId: memoryId ?? (targetKind === 'memory' ? targetId : null),
      epoch,
      requestedAt: requireIso(input.requestedAt, 'requestedAt'),
      scopeId: requireString(input.scopeId, 'scopeId'),
      reason: normalizeReason(input.reason),
      actor: typeof input.actor === 'string' && input.actor.length > 0 ? input.actor : 'unknown',
    };

    return withAppendLock(() => {
      const current = reconcileState();
      // 顺序约定：epoch 单调不降。倒退的 epoch 说明有人在乱序写（或换了库），
      // 账本是恢复的判据，这类事实错误必须拦住。
      if (current.epoch > epoch) {
        throw new BrainError('INVALID_ARGUMENT', `删除账本 epoch 必须单调不降：当前水位 ${current.epoch}，收到 ${epoch}`);
      }
      const seq = current.entries + 1;
      const prevHash = current.entries === 0 ? GENESIS_HASH : current.lastHash;
      const withSeq = { ...body, seq, prevHash };
      const entryHash = computeEntryHash(withSeq);
      /** @type {LedgerEntry} */
      const entry = /** @type {LedgerEntry} */ ({ ...withSeq, entryHash });

      const line = `${JSON.stringify(entry)}\n`;
      const fd = openSync(entriesPath, 'a');
      try {
        writeSync(fd, line, null, 'utf8');
        if (doFsync) fsyncSync(fd);
      } finally {
        closeSync(fd);
      }

      // 行已经落盘（fsync 过），tail 再原子更新。tail 更新失败 → 抛出去让删除失败，
      // 下一轮 append/verify 会把这种「行多 tail 少」识别为可自愈的 torn tail。
      const tail = writeTail({
        entries: seq,
        lastSeq: seq,
        lastHash: entryHash,
        epoch,
        updatedAt: clock.stamp().utc,
      });
      return {
        seq,
        entryHash,
        watermark: { epoch, lastSeq: seq, updatedAt: tail.updatedAt },
      };
    });
  }

  /**
   * 当前水位。**总是读 tail 文件**，不用进程内缓存：恢复工具判 `LEDGER_STALE_BEHIND_BACKUP`
   * 用的就是这个数，宁可多读一次盘。tail 落后（torn）时会少报 epoch —— 方向偏保守，
   * 少报会触发 stale blocker，不会放行。
   * @returns {{ epoch: number, lastSeq: number, updatedAt: string }}
   */
  function watermark() {
    assertAvailable(false);
    const tail = readTail();
    if (tail === null) return { epoch: 0, lastSeq: 0, updatedAt: clock.stamp().utc };
    return { epoch: Number(tail.epoch), lastSeq: Number(tail.lastSeq), updatedAt: String(tail.updatedAt) };
  }

  /**
   * 顺序读。
   * @param {{ sinceSeq?: number, limit?: number }} [opts] `sinceSeq` 是「读 seq 大于它的条目」
   * @returns {{ entries: LedgerEntry[], nextSeq: number|null }}
   */
  function read(opts = {}) {
    assertAvailable(false);
    const sinceSeq = Number.isInteger(opts.sinceSeq) ? Number(opts.sinceSeq) : 0;
    const limit = Number.isInteger(opts.limit) ? Math.max(1, Math.min(/** @type {number} */ (opts.limit), 1000)) : 100;
    const { lines } = parseLines();
    /** @type {LedgerEntry[]} */
    const entries = [];
    for (const line of lines) {
      if (line.entry === undefined) continue;
      if (Number(line.entry.seq) <= sinceSeq) continue;
      entries.push(line.entry);
      if (entries.length >= limit) break;
    }
    const lastRead = entries.length > 0 ? entries[entries.length - 1].seq : sinceSeq;
    const total = lines.filter((line) => line.entry !== undefined).length;
    return { entries, nextSeq: lastRead < total ? lastRead + 1 : null };
  }

  /**
   * 恢复专用：读出「备份之后」发生的全部删除（`entry.epoch > backupEpoch`）。
   * 备份里的 tombstone 只到 `backupEpoch` 为止，之后的删除只能靠账本重放。
   * @param {number} backupEpoch
   * @returns {LedgerEntry[]}
   */
  function readAfterEpoch(backupEpoch) {
    assertAvailable(false);
    const from = Number.isInteger(backupEpoch) && backupEpoch >= 0 ? backupEpoch : 0;
    const { lines } = parseLines();
    return lines
      .map((line) => line.entry)
      .filter((entry) => entry !== undefined && Number(entry.epoch) > from)
      .map((entry) => /** @type {LedgerEntry} */ (entry));
  }

  /**
   * 恢复工具的**强制输入**（M3-INTERFACES §1.2）。不通过 → 不许上线。
   *
   * 判据（backup3 要照着这个接线）：
   * 1. 账本缺失 / 不可用 → `LEDGER_MISSING`
   * 2. 链 / checksum / 行结构任何一处不对 → `LEDGER_CORRUPT`
   * 3. `watermark().epoch < backupEpoch` → `LEDGER_STALE_BEHIND_BACKUP`
   *    含义：备份里记着「删除纪元到了 N」，而账本最多只记到 M < N。说明备份里
   *    那些 epoch ∈ (M, N] 的删除在账本里没有对应记录——要么账本被换过/截断过，
   *    要么删除没同步账本。两种都不能拿来当"删除已跨备份生效"的证据。
   *
   * 通过只代表「账本可信且覆盖了备份的纪元」，**不代表**备份之后没删除：那些删除
   * 要通过 `readAfterEpoch(backupEpoch)` 重放，`resumeFromSeq` 告诉你从哪读。
   *
   * @param {{
   *   backupEpoch: number,
   *   backupCreatedAt?: string,
   *   dbPath?: string,
   *   requireExternal?: boolean,
   * }} input
   * @returns {{
   *   ok: boolean,
   *   blockers: string[],
   *   warnings: string[],
   *   backupEpoch: number,
   *   ledgerEpoch: number,
   *   lastSeq: number,
   *   entryCount: number,
   *   resumeFromSeq: number,
   *   deletionsAfterBackup: number,
   *   corruptAt?: string,
   *   detail: Record<string, unknown>,
   * }}
   */
  function checkForRestore(input) {
    /** @type {string[]} */
    const blockers = [];
    /** @type {string[]} */
    const warnings = [];
    /** @type {Record<string, unknown>} */
    const detail = { dir };
    const backupEpochRaw = input?.backupEpoch;
    const backupEpochValid = Number.isInteger(backupEpochRaw) && Number(backupEpochRaw) >= 0;
    if (!backupEpochValid) {
      blockers.push('BACKUP_EPOCH_INVALID');
      detail.backupEpoch = backupEpochRaw ?? null;
    }
    const backupEpoch = backupEpochValid ? Number(backupEpochRaw) : 0;

    if (unavailableReason !== null) {
      blockers.push('LEDGER_MISSING');
      detail.error = unavailableReason.slice(0, 200);
    }

    let corruptAt = undefined;
    let entryCount = 0;
    let lastSeq = 0;
    let ledgerEpoch = 0;
    if (!blockers.includes('LEDGER_MISSING')) {
      const verdict = verify();
      entryCount = verdict.entryCount;
      lastSeq = verdict.lastSeq;
      if (!verdict.ok) {
        corruptAt = verdict.corruptAt;
        blockers.push('LEDGER_CORRUPT');
        if (verdict.repairable === true) warnings.push('LEDGER_TAIL_REPAIRABLE');
        if (verdict.corruptAt === 'missing') {
          // 「文件都不存在」= 没记过账，比「写坏了」更根本：账本没建立起来。
          blockers[blockers.length - 1] = 'LEDGER_MISSING';
          corruptAt = 'missing';
        }
        detail.corruptAt = corruptAt ?? null;
        if (verdict.detail !== undefined) detail.verify = verdict.detail;
      } else {
        ledgerEpoch = watermark().epoch;
      }
    }

    if (!blockers.includes('LEDGER_MISSING') && !blockers.includes('LEDGER_CORRUPT') && backupEpochValid) {
      if (ledgerEpoch < backupEpoch) {
        blockers.push('LEDGER_STALE_BEHIND_BACKUP');
        detail.backupEpoch = backupEpoch;
        detail.ledgerEpoch = ledgerEpoch;
      }
    }

    // 外部性：账本和主账同一块盘，整盘丢失会一起没——那时"账本证明删除"就失去意义。
    if (typeof input?.dbPath === 'string' && input.dbPath.length > 0) {
      const dbRoot = path.parse(path.resolve(input.dbPath)).root.toLowerCase();
      const ledgerRoot = path.parse(path.resolve(dir)).root.toLowerCase();
      if (dbRoot === ledgerRoot) {
        warnings.push('LEDGER_NOT_EXTERNAL');
        detail.sameVolume = dbRoot;
      }
    } else {
      // 不猜：没给我主账路径，就不能声称账本在外部介质上。
      warnings.push('LEDGER_EXTERNALITY_UNVERIFIED');
    }

    // 备份之后发生过删除 → 恢复必须重放，这一步漏了整个 M3 门槛就白做。
    let deletionsAfterBackup = 0;
    let resumeFromSeq = 0;
    if (!blockers.includes('LEDGER_MISSING') && !blockers.includes('LEDGER_CORRUPT')) {
      const after = readAfterEpoch(backupEpoch);
      deletionsAfterBackup = after.length;
      resumeFromSeq = after.length > 0 ? Number(after[0].seq) : lastSeq + 1;
      if (after.length > 0) {
        warnings.push('LEDGER_HAS_DELETIONS_AFTER_BACKUP');
        detail.deletionsAfterBackup = after.length;
        detail.epochRange = [Number(after[0].epoch), Number(after[after.length - 1].epoch)];
      }
      if (entryCount === 0 && backupEpoch === 0) {
        warnings.push('LEDGER_EMPTY');
      }
    }

    return {
      ok: blockers.length === 0,
      blockers,
      warnings,
      backupEpoch,
      ledgerEpoch,
      lastSeq,
      entryCount,
      resumeFromSeq,
      deletionsAfterBackup,
      ...(corruptAt === undefined ? {} : { corruptAt }),
      detail,
    };
  }

  return {
    dir,
    entriesPath,
    tailPath,
    available: unavailableReason === null,
    unavailableReason,
    append,
    watermark,
    read,
    readAfterEpoch,
    verify,
    checkForRestore,
    /** 供恢复工具/UI 显示的落点信息。 */
    describe() {
      return {
        dir,
        entriesPath,
        tailPath,
        available: unavailableReason === null,
        unavailableReason,
        watermark: unavailableReason === null ? watermark() : null,
      };
    },
  };
}

/**
 * 算一条账本行的指纹，给测试与审计用（不读文件）。
 * @param {unknown} input append 的入参
 * @returns {string}
 */
export function fingerprintAppendInput(input) {
  return sha256Hex(canonicalJson(/** @type {Record<string, unknown>} */ (input ?? {})));
}
