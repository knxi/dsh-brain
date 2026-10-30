// @ts-check
/**
 * M3 独立删除账本（M3-INTERFACES §1）。
 *
 * 这本账是 M3 门槛的地基：只从旧备份读 tombstone，永远不知道「比备份更新的删除」。
 * 所以这里测的不是「能写能读」，而是四条更硬的性质：
 *
 *  1. **append-only + hash 链**：改中间一行、截断尾部，都必须能被 verify 抓出来；
 *  2. **绝不存被删正文**：正文类字段直接拒绝，文件里搜不到语料正文；
 *  3. **checkForRestore 是闸门**：缺失 / corrupt / 水位落后于备份 epoch → blocker；
 *  4. **追加即事实**：账本写不进去时删除必须失败（在 deletion 集成测试里守）。
 *
 * 数据全合成（尺寸 / 材质 / 图号 / 报价 / 英文标识符），不碰真实私密历史。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClock } from '../../../packages/core/src/index.js';
import {
  GENESIS_HASH,
  LEDGER_ENTRIES_FILE,
  LEDGER_TAIL_FILE,
  MAX_REASON_CHARS,
  computeEntryHash,
  computeTailChecksum,
  createDeletionLedger,
  defaultDeletionLedgerDir,
} from '../../../packages/memory/src/deletion-ledger.js';

/** 合成语料：都是主人真实语境里的东西，但不含任何真实记录。 */
const CORPUS = Object.freeze({
  card: '铜版纸名片 300g，成品 90×54mm，报价 0.45 元一张',
  drawing: '建施-03 首层标高 0.00，层高 3.6m',
  steel: '结施 JS-2026-017 梁截面 2400×600',
  code: 'deletion_epoch / pnpm resume / build:web',
});

const START_ISO = '2026-10-28T10:00:00.000Z';

/** @param {import('node:test').TestContext} t */
function makeLedger(t, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-m3-ledger-'));
  const clock = createClock({ timeZone: 'Asia/Shanghai', now: () => new Date(START_ISO) });
  const ledger = createDeletionLedger({ dir, clock, ...opts });
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟释放不影响断言 */
    }
  });
  return { dir, ledger, clock };
}

/**
 * 造一条 append 入参。
 * @param {number} epoch
 * @param {Record<string, unknown>} [overrides]
 */
function entryInput(epoch, overrides = {}) {
  return {
    tombstoneId: `tmb_${String(epoch).padStart(4, '0')}`,
    memoryId: `mem_${String(epoch).padStart(4, '0')}`,
    epoch,
    requestedAt: START_ISO,
    scopeId: 'owner-default',
    reason: '主人要求删除',
    actor: 'owner',
    ...overrides,
  };
}

test('append → read → watermark → verify：链首是 GENESIS，seq 连续，水位跟最后一条走', async (t) => {
  const { ledger } = makeLedger(t);

  const first = ledger.append(entryInput(1));
  const second = ledger.append(entryInput(2, { memoryId: 'mem_0002' }));
  const third = ledger.append(entryInput(3, { memoryId: 'mem_0003' }));

  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  assert.equal(third.seq, 3);
  assert.deepEqual(ledger.watermark(), { epoch: 3, lastSeq: 3, updatedAt: ledger.watermark().updatedAt });

  const all = ledger.read();
  assert.equal(all.entries.length, 3);
  assert.equal(all.nextSeq, null);
  assert.equal(all.entries[0].prevHash, GENESIS_HASH);
  assert.equal(all.entries[1].prevHash, all.entries[0].entryHash);
  assert.equal(all.entries[2].prevHash, all.entries[1].entryHash);
  // 每条 hash 都能独立重算出来（不是写死的常量）
  for (const entry of all.entries) {
    const { entryHash, ...withoutHash } = entry;
    assert.equal(computeEntryHash(withoutHash), entryHash);
  }

  assert.deepEqual(ledger.verify(), { ok: true, entryCount: 3, lastSeq: 3 });

  // 分页读：sinceSeq 是「读大于它」的语义
  const page = ledger.read({ sinceSeq: 1, limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.equal(page.entries[0].seq, 2);
  assert.equal(page.nextSeq, 3);
});

test('绝不存被删正文：正文类字段直接拒绝，文件里搜不到语料正文', async (t) => {
  const { ledger, dir } = makeLedger(t);

  for (const key of ['content', 'payload', 'memoryText', 'body', 'summary']) {
    assert.throws(
      () => ledger.append({ ...entryInput(1), [key]: CORPUS.card }),
      (err) => {
        // memoryText 不在允许键里（既不是正文白名单也不是元数据键）——也必须失败
        return err.code === 'INVALID_ARGUMENT' && /正文|元数据字段/.test(err.message);
      },
      `字段 ${key} 必须被拒绝`,
    );
  }
  // 一次都没写进去
  assert.equal(ledger.verify().entryCount, 0);

  // 正常追加后，账本文件里不能出现任何语料正文
  ledger.append(entryInput(1, { memoryId: 'mem_card' }));
  ledger.append(entryInput(2, { memoryId: 'mem_drawing', reason: '图号错了' }));
  const raw = readFileSync(path.join(dir, LEDGER_ENTRIES_FILE), 'utf8');
  for (const text of Object.values(CORPUS)) {
    assert.equal(raw.includes(text), false, `账本里不该出现正文：${text}`);
  }
  // 允许的是元数据：id / epoch / 时间 / scope / 原因 / 执行者
  const firstLine = JSON.parse(raw.split('\n')[0]);
  assert.deepEqual(
    Object.keys(firstLine).sort(),
    ['actor', 'entryHash', 'epoch', 'memoryId', 'prevHash', 'reason', 'requestedAt', 'scopeId', 'seq', 'targetId', 'targetKind', 'tombstoneId', 'v'].sort(),
  );
  assert.equal(firstLine.memoryId, 'mem_card');
});

test('reason 按码点截断：用户把正文粘进原因也不会被整段带进账本', async (t) => {
  const { ledger, dir } = makeLedger(t);
  const long = `${CORPUS.steel}${'真的不要留'.repeat(60)}`;
  ledger.append(entryInput(1, { reason: long }));
  const line = JSON.parse(readFileSync(path.join(dir, LEDGER_ENTRIES_FILE), 'utf8').split('\n')[0]);
  assert.equal([...line.reason].length, MAX_REASON_CHARS + 1, '截断后应多一个省略号');
  assert.ok(line.reason.endsWith('…'));
});

test('篡改中间一行 → verify 报 CORRUPT，checkForRestore 也拦住', async (t) => {
  const { ledger, dir } = makeLedger(t);
  ledger.append(entryInput(1));
  ledger.append(entryInput(2, { memoryId: 'mem_0002' }));
  ledger.append(entryInput(3, { memoryId: 'mem_0003' }));

  const file = path.join(dir, LEDGER_ENTRIES_FILE);
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  const tampered = JSON.parse(lines[1]);
  tampered.reason = '被人手改过';
  lines[1] = JSON.stringify(tampered);
  writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

  const verdict = ledger.verify();
  assert.equal(verdict.ok, false);
  assert.match(String(verdict.corruptAt), /^line:2:/, `应指向第 2 行，实际 ${verdict.corruptAt}`);

  const check = ledger.checkForRestore({ backupEpoch: 0, dbPath: path.join(dir, 'brain.db') });
  assert.equal(check.ok, false);
  assert.ok(check.blockers.includes('LEDGER_CORRUPT'));
});

test('文件被截断（尾部行丢失）→ CORRUPT，不许当成「没事」', async (t) => {
  const { ledger, dir } = makeLedger(t);
  ledger.append(entryInput(1));
  ledger.append(entryInput(2, { memoryId: 'mem_0002' }));
  ledger.append(entryInput(3, { memoryId: 'mem_0003' }));

  const file = path.join(dir, LEDGER_ENTRIES_FILE);
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
  writeFileSync(file, `${lines.slice(0, 2).join('\n')}\n`, 'utf8'); // 砍掉第 3 行

  const verdict = ledger.verify();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.corruptAt, 'tail_ahead_of_entries');
  // 截断方向比「多一行」危险得多：不能自愈、不能放行
  assert.notEqual(verdict.repairable, true);

  const check = ledger.checkForRestore({ backupEpoch: 0 });
  assert.ok(check.blockers.includes('LEDGER_CORRUPT'));
});

test('上一轮追加写完行但没写 tail（torn tail）→ verify 报可修复，下一次 append 自愈', async (t) => {
  const { ledger, dir, clock } = makeLedger(t);
  ledger.append(entryInput(1));

  // 模拟崩在两次 fsync 之间：行已经在文件里，tail 还停在上一版
  const file = path.join(dir, LEDGER_ENTRIES_FILE);
  const raw = readFileSync(file, 'utf8');
  const entries = raw.trimEnd().split('\n').map((line) => JSON.parse(line));
  const prevHash = entries[entries.length - 1].entryHash;
  const orphanBody = {
    v: 1,
    seq: 2,
    tombstoneId: 'tmb_orphan',
    targetKind: 'memory',
    targetId: 'mem_orphan',
    memoryId: 'mem_orphan',
    epoch: 2,
    requestedAt: clock.stamp().utc,
    scopeId: 'owner-default',
    reason: '',
    actor: 'owner',
    prevHash,
  };
  const orphan = { ...orphanBody, entryHash: computeEntryHash(orphanBody) };
  writeFileSync(file, `${raw.trimEnd()}\n${JSON.stringify(orphan)}\n`, 'utf8');

  const torn = ledger.verify();
  assert.equal(torn.ok, false);
  assert.equal(torn.corruptAt, 'entries_ahead_of_tail');
  assert.equal(torn.repairable, true);
  // 恢复工具读到这个状态必须保守：它不干净
  assert.ok(ledger.checkForRestore({ backupEpoch: 0 }).blockers.includes('LEDGER_CORRUPT'));

  // 但正常写路径能自愈（否则一次崩溃就让账本永远不能写）
  const next = ledger.append(entryInput(3, { memoryId: 'mem_0003' }));
  assert.equal(next.seq, 3);
  const healed = ledger.verify();
  assert.equal(healed.ok, true);
  assert.equal(healed.entryCount, 3);
  // 自愈后那条孤儿行留在链里（append-only 不许改写历史）
  const seqs = ledger.read().entries.map((entry) => entry.seq);
  assert.deepEqual(seqs, [1, 2, 3]);
});

test('checkForRestore：账本缺失 / 水位落后于备份 epoch / 通过，三种结论都明确', async (t) => {
  const { ledger, dir } = makeLedger(t);

  // 1) 空目录（从没写过）→ MISSING
  const missing = ledger.checkForRestore({ backupEpoch: 0, dbPath: path.join(dir, 'brain.db') });
  assert.equal(missing.ok, false);
  assert.ok(missing.blockers.includes('LEDGER_MISSING'));

  // 2) 有删除记录但水位落后于备份 epoch → STALE_BEHIND_BACKUP
  ledger.append(entryInput(1));
  ledger.append(entryInput(2, { memoryId: 'mem_0002' }));
  const stale = ledger.checkForRestore({ backupEpoch: 5, dbPath: path.join(dir, 'brain.db') });
  assert.equal(stale.ok, false);
  assert.ok(stale.blockers.includes('LEDGER_STALE_BEHIND_BACKUP'));
  assert.equal(stale.ledgerEpoch, 2);
  assert.equal(stale.backupEpoch, 5);

  // 3) 水位 >= 备份 epoch → 通过
  const ok = ledger.checkForRestore({ backupEpoch: 2, backupCreatedAt: START_ISO, dbPath: path.join(dir, 'brain.db') });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.blockers, []);
  assert.equal(ok.ledgerEpoch, 2);
  assert.equal(ok.entryCount, 2);

  // 4) 备份之后有删除 → 通过但必须警告「要重放」
  ledger.append(entryInput(3, { memoryId: 'mem_0003' }));
  const after = ledger.checkForRestore({ backupEpoch: 2, dbPath: path.join(dir, 'brain.db') });
  assert.equal(after.ok, true);
  assert.ok(after.warnings.includes('LEDGER_HAS_DELETIONS_AFTER_BACKUP'));
  assert.equal(after.deletionsAfterBackup, 1);
  assert.equal(after.resumeFromSeq, 3);
  assert.deepEqual(
    ledger.readAfterEpoch(2).map((entry) => Number(entry.epoch)),
    [3],
  );

  // 5) backupEpoch 非法（恢复工具的调用 bug）→ blocker，不许放行
  const bad = ledger.checkForRestore({ backupEpoch: '2' });
  assert.equal(bad.ok, false);
  assert.ok(bad.blockers.includes('BACKUP_EPOCH_INVALID'));
});

test('外部性：同盘只给 warning，不给路径时明说「未核实」', async (t) => {
  const { ledger, dir } = makeLedger(t);
  ledger.append(entryInput(1));

  const sameVolume = ledger.checkForRestore({ backupEpoch: 1, dbPath: path.join(dir, 'brain.db') });
  assert.ok(sameVolume.warnings.includes('LEDGER_NOT_EXTERNAL'));

  const unverified = ledger.checkForRestore({ backupEpoch: 1 });
  assert.ok(unverified.warnings.includes('LEDGER_EXTERNALITY_UNVERIFIED'));
});

test('跨实例追加不写坏链（同一目录两个实例交替写）', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-m3-ledger-multi-'));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  const clock = createClock({ timeZone: 'Asia/Shanghai', now: () => new Date(START_ISO) });
  const a = createDeletionLedger({ dir, clock });
  const b = createDeletionLedger({ dir, clock });

  a.append(entryInput(1));
  b.append(entryInput(2, { memoryId: 'mem_0002' }));
  a.append(entryInput(3, { memoryId: 'mem_0003' }));
  b.append(entryInput(4, { memoryId: 'mem_0004' }));

  const verdict = a.verify();
  assert.equal(verdict.ok, true);
  assert.equal(verdict.entryCount, 4);
  const seqs = a.read().entries.map((entry) => entry.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4]);
});

test('账本目录不可用：构造不抛、available=false，但 append 必须抛（删除不许虚报成功）', async (t) => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dsh-m3-ledger-bad-'));
  t.after(() => {
    try {
      rmSync(parent, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  // 用「一个普通文件当目录」制造不可用：mkdir 必失败，跨平台稳定（不依赖权限位）
  const blocker = path.join(parent, 'not-a-dir');
  writeFileSync(blocker, 'x', 'utf8');
  const dir = path.join(blocker, 'deletion-ledger');

  const alerts = [];
  const ledger = createDeletionLedger({ dir, alert: (info) => alerts.push(info) });
  assert.equal(ledger.available, false);
  assert.ok(ledger.unavailableReason !== null);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'deletion_ledger_unavailable');

  assert.throws(
    () => ledger.append(entryInput(1)),
    (err) => err.code === 'STORAGE_ERROR' && /必须失败/.test(err.message),
    '账本不可用时 append 必须失败',
  );

  const check = ledger.checkForRestore({ backupEpoch: 0 });
  assert.equal(check.ok, false);
  assert.ok(check.blockers.includes('LEDGER_MISSING'));
});

test('epoch 单调不降：倒退的 epoch 会被拒绝', async (t) => {
  const { ledger } = makeLedger(t);
  ledger.append(entryInput(3));
  assert.throws(
    () => ledger.append(entryInput(2)),
    (err) => err.code === 'INVALID_ARGUMENT' && /单调不降/.test(err.message),
  );
});

test('非 UTC ISO 时间 / 缺字段都被拒绝（宁可不记，也不记错）', async (t) => {
  const { ledger } = makeLedger(t);
  assert.throws(() => ledger.append(entryInput(1, { requestedAt: '2026-10-28 10:00:00' })), /UTC ISO/);
  assert.throws(() => ledger.append({ ...entryInput(1), tombstoneId: '' }), /tombstoneId/);
  assert.throws(() => ledger.append(entryInput(1, { scopeId: '' })), /scopeId/);
  assert.throws(() => ledger.append(entryInput(0)), /epoch/);
  assert.equal(ledger.verify().entryCount, 0);
});

test('默认落点跟着主账走：<db 所在目录>/deletion-ledger（不写死仓库绝对路径）', async () => {
  const fromDb = defaultDeletionLedgerDir({ dbPath: path.join('E:', 'some-tmp', 'brain.db') });
  assert.equal(fromDb, path.join('E:', 'some-tmp', 'deletion-ledger'));
  assert.ok(!fromDb.includes('dsh-brain'));
  // 没给 dbPath 时回落到仓库 data/，用于 CLI 与生产默认
  assert.ok(defaultDeletionLedgerDir().endsWith(path.join('data', 'deletion-ledger')));
});

test('tail 文件是独立可校验的水位：checksum 覆盖行数与链尾', async (t) => {
  const { ledger, dir } = makeLedger(t);
  ledger.append(entryInput(1));
  ledger.append(entryInput(2, { memoryId: 'mem_0002' }));

  const tailPath = path.join(dir, LEDGER_TAIL_FILE);
  assert.ok(existsSync(tailPath), 'tail.json 必须存在（水位是 O(1) 可读的）');
  const tail = JSON.parse(readFileSync(tailPath, 'utf8'));
  assert.equal(tail.entries, 2);
  assert.equal(tail.lastSeq, 2);
  assert.equal(tail.epoch, 2);
  assert.equal(computeTailChecksum(tail), tail.checksum);

  // 改水位（声称记了 3 条）→ checksum 立刻不符
  const forged = { ...tail, entries: 3 };
  assert.notEqual(computeTailChecksum(forged), forged.checksum);

  // 删掉 tail 也不放过
  unlinkSync(tailPath);
  const verdict = ledger.verify();
  assert.equal(verdict.ok, false);
  assert.equal(verdict.corruptAt, 'tail_missing');
});
