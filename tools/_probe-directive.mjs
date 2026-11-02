// 临时探针：验证「塞一条指令进去，执行器到底能不能跑」。
// 走真实生产入口 openBrain()，不加 directiveHooks（与 apps/brain-tools/index.js:358 的接法一致）。
// 只写一条指令 + 让它跑一轮；跑完打印库里的真实行。
import { openBrain } from '@dsh-brain/memory';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

const DB = 'E:/ds-h/dsh-brain/data/brain.db';
const BACKUP_DIR = 'E:/ds-h/dsh-brain/data/backups';

// ── 0. 先备份（VACUUM INTO 是事务一致的，WAL 里没合并的数据也会带上）──
mkdirSync(BACKUP_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backupPath = `${BACKUP_DIR}/manual-before-directive-probe-${stamp}.db`;
{
  const raw = new DatabaseSync(DB);
  raw.exec(`VACUUM INTO '${backupPath.replace(/\\/g, '/')}'`);
  raw.close();
}
console.log(`[0] 已备份 → ${backupPath}`);

// ── 1. 生产接法打开主账（没有 directiveHooks）──
const brain = openBrain({ dbPath: DB, migrationsDir: 'E:/ds-h/dsh-brain/migrations' });
const dir = brain.directives;

console.log('\n[1] 闸门读数 readGate():');
console.log(JSON.stringify(dir.readGate(), null, 1));

console.log('\n[2] 六个内置动作的接线状态 actions.list():');
for (const a of dir.actions.list()) {
  console.log(`   ${a.name.padEnd(20)} level=${a.level} hook=${a.hook} available=${a.available}`);
}

// ── 2. 建一条指令（L1 / 只允许 memory_maintenance）──
const created = await dir.create({
  title: '探针：验证执行器是否真的能跑',
  reason: '主人要求实测指令队列是空壳还是能执行',
  trigger: 'manual',
  source: 'owner',
  priority: 50,
  permissionScope: 'L1',
  allowedTools: ['memory_maintenance'],
  stepBudget: 3,
  timeBudgetSeconds: 60,
  tokenBudget: 1000,
  maxRetries: 1,
  createdBy: 'owner',
  idempotencyKey: `probe-directive-${stamp}`,
});
console.log(`\n[3] create → id=${created.id} status=${created.directive.status} created=${created.created}`);

// ── 3. proposed → awaiting_approval → queued ──
await dir.stateMachine.transition({ id: created.id, to: 'awaiting_approval', reason: 'probe: 进入待批', by: 'owner' });
const approved = await dir.approve(created.id, { by: 'owner' });
console.log(`[4] 批准 → status=${approved?.status ?? approved?.directive?.status ?? '?'}`);

// ── 4. 跑一轮 ──
const run = await dir.scheduler.runOnce({ owner: 'probe-runner', maxSteps: 3 });
console.log('\n[5] runOnce 返回:');
console.log(JSON.stringify(run, null, 1));

// ── 5. 库里真实落成了什么 ──
const after = dir.get(created.id);
console.log('\n[6] 指令最终状态:', JSON.stringify({
  id: after.id,
  status: after.status,
  stepsUsed: after.stepsUsed,
  tokensUsed: after.tokensUsed,
  attempts: after.attempts,
  lastError: after.lastError,
}, null, 1));

const raw = new DatabaseSync(DB, { readOnly: true });
for (const t of ['directive_runs', 'directive_steps']) {
  const rows = raw.prepare(`SELECT * FROM ${t} WHERE directive_id = ? ORDER BY rowid`).all(created.id);
  console.log(`\n[7] ${t} 行数=${rows.length}`);
  for (const r of rows) console.log('   ', JSON.stringify(r).slice(0, 500));
}
const audits = raw.prepare("SELECT ts, action, result, target_id FROM audit_logs WHERE target_id = ? ORDER BY rowid").all(created.id);
console.log(`\n[8] audit_logs 行数=${audits.length}`);
for (const a of audits) console.log('   ', JSON.stringify(a));
raw.close();

await brain.close?.();
process.exit(0);
