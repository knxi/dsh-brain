#!/usr/bin/env node
// @ts-check
/**
 * 真实恢复演练（M3 门槛）：**真起库、真写记忆、真删、真备份、真恢复、真比对**，不 mock 主账。
 *
 * 用法：
 *   node packages/memory/src/restore-drill.mjs
 *
 * 产出：
 *   - stdout：完整 JSON 报告
 *   - `data/backups/restore-drill-<时间戳>.json`：落盘报告（可复跑对比）
 *   - exit 0 表示全部检查通过；任一失败 exit 1 并打印失败项
 *
 * 两处"不是 mock"的说明：
 * 1. 主账、备份、恢复、比对全部用真实文件与真实 SQLite。
 * 2. 独立删除账本优先用 del3 的 `deletion-ledger.js`；它尚未交付时，用本文件内的
 *    **最小 JSONL 账本**（append-only + sha256 链 + verify），并如实写进报告的
 *    `ledger.implementation`。这是接口替身，不是结果造假：删、备份、恢复、比对都真实执行。
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createClock } from '@dsh-brain/core';
import { openBrain } from './index.js';
import { createBackup, verifyBackup } from './backup.js';
import { planRestore, executeRestore } from './restore.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** @param {unknown} err */
function messageOf(err) {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 演练内置的最小删除账本（M3-INTERFACES §1.2 接口 + JSONL hash 链）。
 * 只存元数据，不存正文；append-only；verify 校验链。
 * @param {string} dir
 */
function createBuiltinLedger(dir) {
  const file = path.join(dir, 'deletion-ledger.jsonl');
  mkdirSync(dir, { recursive: true });

  /** @returns {Array<Record<string, any>>} */
  function readLines() {
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  }

  /** @returns {number} */
  function maxEpoch() {
    const lines = readLines();
    return lines.length === 0 ? 0 : Math.max(...lines.map((line) => Number(line.epoch ?? 0)));
  }

  return {
    /** @param {Record<string, any>} entry */
    append(entry) {
      const lines = readLines();
      const seq = lines.length + 1;
      const prevHash = lines.length === 0 ? null : String(lines[lines.length - 1].entryHash);
      const payload = {
        seq,
        tombstoneId: String(entry.tombstoneId),
        memoryId: String(entry.memoryId),
        epoch: Number(entry.epoch),
        requestedAt: String(entry.requestedAt),
        scopeId: String(entry.scopeId ?? 'owner-default'),
        reason: String(entry.reason ?? ''),
        actor: String(entry.actor ?? 'owner'),
        prevHash,
      };
      const entryHash = `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
      appendFileSync(file, `${JSON.stringify({ ...payload, entryHash })}\n`, 'utf8');
      return {
        seq,
        entryHash,
        watermark: { epoch: Math.max(maxEpoch(), Number(entry.epoch)), lastSeq: seq, updatedAt: new Date().toISOString() },
      };
    },
    watermark() {
      const lines = readLines();
      return {
        epoch: maxEpoch(),
        lastSeq: lines.length,
        updatedAt: existsSync(file) ? statSync(file).mtime.toISOString() : null,
      };
    },
    /** @param {{ sinceSeq?: number, limit?: number }} [opts] */
    read(opts = {}) {
      const sinceSeq = Number(opts.sinceSeq ?? 0);
      const limit = Number(opts.limit ?? 100);
      const lines = readLines().filter((line) => Number(line.seq) > sinceSeq).slice(0, limit);
      return { entries: lines, nextSeq: lines.length === 0 ? sinceSeq : Number(lines[lines.length - 1].seq) };
    },
    verify() {
      const lines = readLines();
      let prevHash = null;
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const { entryHash, ...payload } = line;
        const expected = `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
        if (payload.seq !== index + 1 || payload.prevHash !== prevHash || expected !== entryHash) {
          return { ok: false, entryCount: lines.length, lastSeq: lines.length, corruptAt: index + 1 };
        }
        prevHash = entryHash;
      }
      return { ok: true, entryCount: lines.length, lastSeq: lines.length };
    },
    /** @param {{ backupEpoch: number, backupCreatedAt?: string }} input */
    checkForRestore(input) {
      const verify = this.verify();
      if (!verify.ok) {
        return { ok: false, blockers: ['LEDGER_CORRUPT'], warnings: ['LEDGER_NOT_EXTERNAL'] };
      }
      if (this.watermark().epoch < Number(input.backupEpoch ?? 0)) {
        return { ok: false, blockers: ['LEDGER_STALE_BEHIND_BACKUP'], warnings: ['LEDGER_NOT_EXTERNAL'] };
      }
      return { ok: true, blockers: [], warnings: ['LEDGER_NOT_EXTERNAL'] };
    },
    /** 演练用：把账本目录复制一份（模拟"旧账本副本"）。 */
    snapshotTo(destDir) {
      cpSync(dir, destDir, { recursive: true });
      return destDir;
    },
  };
}

/**
 * 尝试加载 del3 的真实账本；不存在就返回 null（报告里如实标注）。
 * @param {string} dir
 * @param {{ readOnly?: boolean }} [options]
 */
async function loadRealLedger(dir, options = {}) {
  try {
    const module = await import('./deletion-ledger.js');
    if (typeof module.createDeletionLedger === 'function') {
      return { ledger: module.createDeletionLedger({ dir, ...options }), implementation: 'deletion-ledger.js' };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * 复制账本目录（演练里造「旧账本副本」/「损坏账本副本」）。
 * @param {string} src
 * @param {string} dest
 */
function copyLedgerDir(src, dest) {
  rmSync(dest, { recursive: true, force: true });
  if (existsSync(src)) cpSync(src, dest, { recursive: true });
  else mkdirSync(dest, { recursive: true });
  return dest;
}

/**
 * 篡改账本第一条记录，破坏 hash 链（演练用）。
 * @param {string} dir
 * @returns {boolean}
 */
function tamperFirstLedgerEntry(dir) {
  const candidates = [path.join(dir, 'entries.jsonl'), path.join(dir, 'deletion-ledger.jsonl')];
  const target = candidates.find((file) => existsSync(file));
  if (target === undefined) return false;
  const lines = readFileSync(target, 'utf8').split('\n').filter(Boolean);
  if (lines.length === 0) return false;
  const tampered = JSON.parse(lines[0]);
  tampered.reason = 'tampered-by-drill';
  lines[0] = JSON.stringify(tampered);
  writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
  return true;
}

/** @param {string} content */
function draft(content) {
  return {
    layer: 'long',
    type: 'semantic',
    content,
    summary: content.slice(0, 40),
    sourceType: 'owner_words',
    sourceIds: ['evt-drill-1'],
    privacy: 'private',
    originSystem: 'dsh',
    producer: 'restore-drill',
  };
}

async function main() {
  const startedAt = new Date();
  const workspace = mkdtempSync(path.join(tmpdir(), 'brain-restore-drill-'));
  const clock = createClock({ timeZone: 'Asia/Shanghai' });
  const dbPath = path.join(workspace, 'brain.db');
  const backupsDir = path.join(workspace, 'backups');
  const ledgerDir = path.join(workspace, 'deletion-ledger');
  const reportsDir = process.env.DSH_BRAIN_DRILL_REPORT_DIR
    ? path.resolve(process.env.DSH_BRAIN_DRILL_REPORT_DIR)
    : path.join(repoRoot, 'data', 'backups');
  mkdirSync(reportsDir, { recursive: true });

  /** @type {Array<{ name: string, ok: boolean, detail: string }>} */
  const checks = [];
  /** @param {string} name @param {boolean} ok @param {string} detail */
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  const brain = openBrain({ dbPath, backupDir: backupsDir, clock });
  /** @type {Record<string, any>} */
  const report = {
    drill: 'restore-drill',
    at: startedAt.toISOString(),
    ok: false,
    workspace,
    ledger: { implementation: 'builtin-jsonl', entries: 0, watermark: 0 },
    backups: [],
    restore: null,
    isolation: [],
    checks,
    conclusion: '',
  };

  try {
    // 1) 真写记忆（合成语料：尺寸 / 材质 / 图号 / 报价）
    const seeded = [];
    seeded.push(await brain.memories.create(draft('铜版纸名片 300g，成品尺寸 90×54mm，报价 0.45 元一张')));
    seeded.push(await brain.memories.create(draft('画册封面用 250g 哑粉纸，覆哑膜，成品 210×285mm')));
    seeded.push(await brain.memories.create(draft('建施-03 图里首层平面标高 0.00，层高 3.6m')));
    seeded.push(await brain.memories.create(draft('结施 JS-2026-017 梁截面 2400×600')));
    check('seed_memories', seeded.length === 4, `写入 ${seeded.length} 条合成记忆`);

    // 2) 账本 + **备份前必须先真删一条**。
    //    ui3 实测：空账本的 verify() 返回 {ok:false, corruptAt:'missing'}，checkForRestore 报
    //    LEDGER_MISSING，于是「干净库恢复成新实例」一律判隔离。这个判断是对的（没删过东西
    //    ≠ 有证据证明没删过），所以演练顺序必须是：删一条（让账本有记录）→ 备份 → 删更多。
    const realLedger = await loadRealLedger(ledgerDir);
    const ledger = realLedger?.ledger ?? createBuiltinLedger(ledgerDir);
    report.ledger.implementation = realLedger?.implementation ?? 'builtin-jsonl';

    const deletedIds = [seeded[0].id, seeded[2].id];
    const survivorIds = [seeded[1].id, seeded[3].id];
    /** @param {string} memoryId @param {string} [why] */
    async function deleteOne(memoryId, why = 'drill: 备份之后的删除') {
      const deletion = await brain.deletion.requestDeletion({
        target_kind: 'memory',
        target_id: memoryId,
        scope_id: 'owner-default',
        reason: why,
      });
      ledger.append({
        tombstoneId: deletion.tombstone_id,
        memoryId,
        epoch: deletion.deletion_epoch,
        requestedAt: clock.nowUtc(),
        scopeId: 'owner-default',
        reason: why,
        actor: 'drill',
      });
      return deletion;
    }

    // 备份前删一条（epoch 1）：让账本有可验证的记录，否则备份会被判隔离。
    await deleteOne(deletedIds[0], 'drill: 备份之前删除');
    check(
      'delete_before_backup',
      ledger.watermark().epoch === 1,
      `备份前真删一条，账本水位 epoch=${ledger.watermark().epoch}（空账本会让备份被判隔离）`,
    );

    // 账本副本（水位 1）：用于「账本陈旧」隔离场景（恢复 B 时备份 ledgerEpoch=2 > 水位 1）。
    const staleLedgerDir = path.join(workspace, 'ledger-at-epoch-1');
    copyLedgerDir(ledgerDir, staleLedgerDir);

    // 3) 真备份 A（此时账本已有一条删除记录，ledgerEpoch = 1）
    const backupA = await createBackup({ db: brain.db, outDir: backupsDir, clock, queue: brain.queue, kind: 'manual', label: 'drill-before-more-deletes' });
    report.backups.push({
      backupId: backupA.backupId,
      dir: backupA.dir,
      ledgerEpoch: backupA.ledgerEpoch,
      watermark: backupA.watermark,
      verified: verifyBackup(backupA.dir).ok,
      dbSha256: backupA.dbSha256,
    });
    check('backup_a_verified', verifyBackup(backupA.dir).ok, `verifyBackup(${backupA.backupId})`);
    check(
      'backup_a_ledger_epoch_from_snapshot',
      backupA.ledgerEpoch === 1,
      `备份时点 deletion_epoch=${backupA.ledgerEpoch}（从快照内部读，与快照同一时刻）`,
    );

    // 4) 备份之后删第二条（epoch 2）
    await deleteOne(deletedIds[1]);
    report.ledger.entries = ledger.watermark().lastSeq;
    report.ledger.watermark = ledger.watermark().epoch;
    report.ledger.verified = ledger.verify().ok;
    check('deleted_after_backup', ledger.watermark().epoch === 2, `删除后账本水位 epoch=${ledger.watermark().epoch}`);
    check('deleted_shielded_in_live_db', (() => {
      const row = brain.db.prepare('SELECT status FROM memories WHERE id = ?').get(deletedIds[0]);
      return row?.status === 'deleted';
    })(), '当前库里被删记忆 status=deleted（立即不可检索；正文由 worker 清）');

    // 4) 真备份 B（删除之后）—— 验证"每日独立全量"，不是增量链
    const backupB = await createBackup({ db: brain.db, outDir: backupsDir, clock, queue: brain.queue, kind: 'manual', label: 'drill-after-delete' });
    report.backups.push({
      backupId: backupB.backupId,
      dir: backupB.dir,
      ledgerEpoch: backupB.ledgerEpoch,
      watermark: backupB.watermark,
      verified: verifyBackup(backupB.dir).ok,
      dbSha256: backupB.dbSha256,
    });
    check('backup_b_verified', verifyBackup(backupB.dir).ok, `verifyBackup(${backupB.backupId})`);
    check(
      'backups_are_independent_full',
      backupA.dbSha256 !== backupB.dbSha256 && backupB.ledgerEpoch === 2,
      `A/B 是两份独立全量：sha 不同、B 的 ledgerEpoch=${backupB.ledgerEpoch}`,
    );

    // 5) 真恢复 A（旧备份）到隔离路径
    const targetA = path.join(workspace, 'restore-from-a');
    const planA = planRestore({ backupDir: backupA.dir, ledger, targetDir: targetA, dbPath });
    check('plan_a_ok', planA.ok && !planA.isolationRequired, `ok=${planA.ok} isolation=${planA.isolationRequired}`);
    const restoredA = await executeRestore(planA, { db: brain.db, queue: brain.queue, clock, targetDir: targetA, ledger, dbPath });
    report.restore = {
      backup: backupA.backupId,
      promoted: restoredA.promoted,
      reason: restoredA.reason,
      target: restoredA.targetDir,
      preRestoreDir: restoredA.preRestoreDir,
      merged: restoredA.merged,
      rebuilt: restoredA.rebuilt,
    };
    check('restore_a_promoted', restoredA.promoted === true, `promoted=${restoredA.promoted} reason=${restoredA.reason}`);
    check(
      'pre_restore_snapshot_exists',
      typeof restoredA.preRestoreDir === 'string' && existsSync(restoredA.preRestoreDir) && verifyBackup(restoredA.preRestoreDir).ok,
      `_pre-restore 目录：${String(restoredA.preRestoreDir)}`,
    );

    // 6) 真比对：删了的东西恢复后仍然没有
    const restoredDb = new DatabaseSync(restoredA.targetDbPath, { readOnly: true });
    /** @type {Record<string, any>} */
    const compare = {};
    try {
      let deletedStillDeleted = true;
      let deletedBodyAbsent = true;
      for (const memoryId of deletedIds) {
        const row = restoredDb.prepare('SELECT status, content, summary FROM memories WHERE id = ?').get(memoryId);
        if (row === undefined) continue;
        if (row.status !== 'deleted') deletedStillDeleted = false;
        if (row.content !== null || row.summary !== null) deletedBodyAbsent = false;
      }
      let survivorsIntact = true;
      const survivorContents = [];
      for (const memoryId of survivorIds) {
        const row = restoredDb.prepare('SELECT status, content FROM memories WHERE id = ?').get(memoryId);
        if (row === undefined || row.status !== 'active' || row.content === null) survivorsIntact = false;
        survivorContents.push(row?.content ?? null);
      }
      const ftsDeletedHits = restoredDb
        .prepare("SELECT doc_id FROM search_fts_char WHERE search_fts_char MATCH '名片 OR 标高'")
        .all()
        .map((row) => String(row.doc_id));
      const ngramDeleted = restoredDb
        .prepare('SELECT COUNT(*) AS n FROM search_ngram WHERE doc_id = ?')
        .get(deletedIds[0]);
      const survivorHit = restoredDb
        .prepare('SELECT COUNT(*) AS n FROM search_ngram WHERE doc_id = ?')
        .get(survivorIds[0]);
      const survivorTrigram = restoredDb
        .prepare("SELECT doc_id FROM search_fts_trigram WHERE search_fts_trigram MATCH '哑粉纸'")
        .all()
        .map((row) => String(row.doc_id));
      const epochRow = restoredDb.prepare("SELECT value FROM brain_meta WHERE key = 'deletion_epoch'").get();
      const derivedTables = restoredDb
        .prepare("SELECT name FROM sqlite_master WHERE name IN ('search_fts_char','search_fts_trigram','search_ngram')")
        .all()
        .map((row) => String(row.name));

      compare.deleted_memory_does_not_revive = deletedStillDeleted;
      compare.deleted_body_absent = deletedBodyAbsent;
      compare.survivors_intact = survivorsIntact;
      compare.survivor_contents = survivorContents;
      compare.fts_deleted_hits = ftsDeletedHits;
      compare.ngram_deleted_rows = Number(ngramDeleted?.n ?? 0);
      compare.survivor_ngram_rows = Number(survivorHit?.n ?? 0);
      compare.survivor_trigram_hits = survivorTrigram;
      compare.derived_tables = derivedTables;
      compare.deletion_epoch_after_restore = Number(epochRow?.value ?? 0);

      check('deleted_memory_does_not_revive', deletedStillDeleted, '备份之后删除的记忆，恢复后仍为 status=deleted（未复活）');
      check('deleted_body_absent', deletedBodyAbsent, '被删记忆的正文/摘要恢复后仍为 NULL');
      check('survivors_intact', survivorsIntact, '未被删的记忆内容完整');
      check(
        'deleted_not_searchable',
        ftsDeletedHits.length === 0 && Number(ngramDeleted?.n ?? 0) === 0,
        `被删内容在恢复库的 FTS/ngram 中 0 命中（fts=${ftsDeletedHits.length} ngram=${Number(ngramDeleted?.n ?? 0)}）`,
      );
      check('survivor_searchable', Number(survivorHit?.n ?? 0) > 0, `未删内容仍在检索索引中（ngram 行数 ${Number(survivorHit?.n ?? 0)}）`);
      check('derived_rebuilt', derivedTables.length === 3, `三套派生索引重建：${derivedTables.join(',')}`);
      check('deletion_epoch_advanced', Number(epochRow?.value ?? 0) >= 2, `恢复库 deletion_epoch=${Number(epochRow?.value ?? 0)}`);
      report.restore.compare = compare;
    } finally {
      restoredDb.close();
    }

    // 7) 三条隔离路径：账本缺失 / corrupt / 陈旧
    // 7.1 缺失：账本目录不存在（真实账本 readOnly 构造对不存在目录报 LEDGER_MISSING）
    const missingLedgerDir = path.join(workspace, 'no-such-ledger');
    const missingReal = await loadRealLedger(missingLedgerDir, { readOnly: true });
    const missingLedger = missingReal?.ledger ?? null;
    const planMissing = planRestore({ backupDir: backupA.dir, ledger: missingLedger, targetDir: path.join(workspace, 'iso-missing'), dbPath });
    check(
      'isolation_ledger_missing',
      planMissing.isolationRequired === true && planMissing.isolationReasons.some((item) => item.code === 'LEDGER_MISSING'),
      `isolationRequired=${planMissing.isolationRequired} reasons=${planMissing.isolationReasons.map((item) => item.code).join(',')}`,
    );
    report.isolation.push({
      case: 'ledger_missing',
      isolationRequired: planMissing.isolationRequired,
      reasons: planMissing.isolationReasons.map((item) => item.code),
      targetDir: path.join(workspace, 'iso-missing'),
      ledgerDir: missingLedgerDir,
    });
    const missingResult = await executeRestore(planMissing, {
      db: brain.db,
      queue: brain.queue,
      clock,
      targetDir: path.join(workspace, 'iso-missing'),
      ledger: missingLedger,
      dbPath,
    });
    report.isolation[0].promoted = missingResult.promoted;
    report.isolation[0].normalServiceAllowed = missingResult.promoted;
    check(
      'isolation_missing_blocks_promotion',
      missingResult.promoted === false,
      '账本缺失时恢复可以产出隔离副本，但 promoted=false（拒绝提供正常服务）',
    );

    // 7.2 corrupt：复制账本并篡改第一条，破坏 hash 链
    const corruptDir = path.join(workspace, 'ledger-corrupt');
    copyLedgerDir(ledgerDir, corruptDir);
    const tampered = tamperFirstLedgerEntry(corruptDir);
    const corruptReal = await loadRealLedger(corruptDir, { readOnly: true });
    const corruptLedger = corruptReal?.ledger ?? createBuiltinLedger(corruptDir);
    const planCorrupt = planRestore({ backupDir: backupA.dir, ledger: corruptLedger, targetDir: path.join(workspace, 'iso-corrupt'), dbPath });
    check(
      'isolation_ledger_corrupt',
      tampered && planCorrupt.isolationRequired === true && planCorrupt.isolationReasons.some((item) => item.code === 'LEDGER_CORRUPT'),
      `篡改=${tampered} isolationRequired=${planCorrupt.isolationRequired} reasons=${planCorrupt.isolationReasons.map((item) => item.code).join(',')}`,
    );
    const corruptResult = await executeRestore(planCorrupt, {
      db: brain.db,
      queue: brain.queue,
      clock,
      targetDir: path.join(workspace, 'iso-corrupt'),
      ledger: corruptLedger,
      dbPath,
    });
    report.isolation.push({
      case: 'ledger_corrupt',
      isolationRequired: planCorrupt.isolationRequired,
      reasons: planCorrupt.isolationReasons.map((item) => item.code),
      promoted: corruptResult.promoted,
      normalServiceAllowed: corruptResult.promoted,
    });
    check('isolation_corrupt_blocks_promotion', corruptResult.promoted === false, '账本 corrupt 时 promoted=false');

    // 7.3 陈旧：用「删除中途的账本副本」（水位 1）去恢复 B（ledgerEpoch=2）
    const staleReal = await loadRealLedger(staleLedgerDir, { readOnly: true });
    const staleLedger = staleReal?.ledger ?? createBuiltinLedger(staleLedgerDir);
    const staleWatermark = staleLedger.watermark();
    const planStale = planRestore({ backupDir: backupB.dir, ledger: staleLedger, targetDir: path.join(workspace, 'iso-stale'), dbPath });
    check(
      'isolation_ledger_stale',
      planStale.isolationRequired === true && planStale.isolationReasons.some((item) => item.code === 'LEDGER_STALE_BEHIND_BACKUP'),
      `备份 B 的 ledgerEpoch=${backupB.ledgerEpoch}，旧账本水位=${staleWatermark.epoch} → isolationRequired=${planStale.isolationRequired}`,
    );
    const staleResult = await executeRestore(planStale, {
      db: brain.db,
      queue: brain.queue,
      clock,
      targetDir: path.join(workspace, 'iso-stale'),
      ledger: staleLedger,
      dbPath,
    });
    report.isolation.push({
      case: 'ledger_stale_behind_backup',
      isolationRequired: planStale.isolationRequired,
      reasons: planStale.isolationReasons.map((item) => item.code),
      backupLedgerEpoch: backupB.ledgerEpoch,
      ledgerEpoch: staleWatermark.epoch,
      promoted: staleResult.promoted,
      normalServiceAllowed: staleResult.promoted,
    });
    check('isolation_stale_blocks_promotion', staleResult.promoted === false, '账本水位落后于备份 epoch 时 promoted=false');

    report.ok = checks.every((item) => item.ok);
    report.conclusion = report.ok
      ? '删了的东西恢复后仍然没有：备份之后删除的记忆，在旧备份恢复后保持不可读（未复活）；三条隔离路径均 promoted=false。'
      : `演练未通过：${checks.filter((item) => !item.ok).map((item) => item.name).join(', ')}`;
  } catch (err) {
    report.ok = false;
    report.error = messageOf(err);
    check('drill_completed', false, messageOf(err));
    report.conclusion = `演练中断：${messageOf(err)}`;
  } finally {
    try {
      await brain.close();
    } catch {
      /* ignore */
    }
  }

  const reportPath = path.join(reportsDir, `restore-drill-${startedAt.toISOString().replace(/[-:.TZ]/g, '')}.json`);
  try {
    mkdirSync(reportsDir, { recursive: true });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
    report.reportPath = reportPath;
  } catch (err) {
    report.reportPath = null;
    report.reportError = messageOf(err);
  }

  console.log(JSON.stringify(report, null, 2));
  console.error(
    report.ok
      ? `[restore-drill] 通过：${checks.filter((item) => item.ok).length}/${checks.length} 项检查；报告 ${reportPath}`
      : `[restore-drill] 失败：${checks.filter((item) => !item.ok).length}/${checks.length} 项；报告 ${reportPath}`,
  );

  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* Windows 句柄延迟释放不影响结论 */
  }
  process.exit(report.ok ? 0 : 1);
}

main().catch((err) => {
  console.error(`[restore-drill] 崩溃：${messageOf(err)}`);
  process.exit(1);
});
