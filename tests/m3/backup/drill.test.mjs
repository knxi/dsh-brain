// @ts-check
/**
 * M3：真实恢复演练脚本（不 mock）——真跑一次，断言 exit 0 与报告结论。
 */

import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from './helpers.mjs';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const drillPath = fileURLToPath(new URL('../../../packages/memory/src/restore-drill.mjs', import.meta.url));

test('真实恢复演练：exit 0，报告里能看到「删了的东西恢复后仍然没有」', () => {
  const reportDir = mkdtempSync(path.join(tmpdir(), 'm3-drill-report-'));
  try {
    const run = spawnSync(process.execPath, [drillPath], {
      cwd: repoRoot,
      env: { ...process.env, DSH_BRAIN_DRILL_REPORT_DIR: reportDir },
      encoding: 'utf8',
      timeout: 180_000,
    });
    assert.equal(run.status, 0, `drill 失败（exit=${String(run.status)}）：\n${String(run.stderr)}\n${String(run.stdout).slice(0, 3000)}`);

    /** @type {Record<string, any>} */
    const report = JSON.parse(String(run.stdout));
    assert.equal(report.drill, 'restore-drill');
    assert.equal(report.ok, true);
    assert.match(report.conclusion, /删了的东西恢复后仍然没有/);
    assert.ok(Array.isArray(report.checks) && report.checks.length >= 20);
    assert.ok(report.checks.every((item) => item.ok), JSON.stringify(report.checks.filter((item) => !item.ok)));

    const revived = report.checks.find((item) => item.name === 'deleted_memory_does_not_revive');
    assert.equal(revived.ok, true, '核心断言：被删记忆恢复后仍然没有');
    const bodyAbsent = report.checks.find((item) => item.name === 'deleted_body_absent');
    assert.equal(bodyAbsent.ok, true);

    // 三条隔离路径都必须 promoted=false（拒绝提供正常服务）
    const cases = report.isolation.map((item) => item.case).sort();
    assert.deepEqual(cases, ['ledger_corrupt', 'ledger_missing', 'ledger_stale_behind_backup']);
    assert.ok(report.isolation.every((item) => item.promoted === false));
    assert.ok(report.isolation.every((item) => item.normalServiceAllowed === false));

    // 演练用真实备份、真实恢复
    assert.equal(report.restore.promoted, true);
    assert.ok(report.backups.length >= 2, '演练至少产出两份独立全量备份');
    assert.ok(report.backups.every((item) => item.verified === true));

    // 落盘报告可复跑
    const files = readdirSync(reportDir).filter((name) => name.startsWith('restore-drill-'));
    assert.equal(files.length, 1);
    const saved = JSON.parse(readFileSync(path.join(reportDir, files[0]), 'utf8'));
    assert.equal(saved.drill, 'restore-drill');
    assert.equal(saved.restore.compare.deleted_memory_does_not_revive, true);
  } finally {
    try {
      rmSync(reportDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});
