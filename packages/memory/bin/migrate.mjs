#!/usr/bin/env node
// @ts-check
/**
 * 迁移 CLI。
 *
 * 用法：
 *   node packages/memory/bin/migrate.mjs [--db <path>] [--dir <migrations>] [--status] [--dry-run] [--rollback]
 *
 * 默认库：<repo>/data/brain.db；默认迁移目录：<repo>/migrations。
 * 不读凭据，不碰 Engram / 灵枢 的库。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../src/db.js';
import {
  applyMigrations,
  defaultMigrationsDir,
  getCurrentVersion,
  listMigrations,
  rollbackLastMigration,
} from '../src/migrator.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const args = { db: path.join(repoRoot, 'data', 'brain.db'), dir: defaultMigrationsDir() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    switch (token) {
      case '--db':
        args.db = String(argv[++i]);
        break;
      case '--dir':
        args.dir = String(argv[++i]);
        break;
      case '--status':
        args.status = true;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--rollback':
        args.rollback = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        if (token.startsWith('--')) throw new Error(`未知参数：${token}`);
    }
  }
  return args;
}

function usage() {
  console.log(`用法：
  node packages/memory/bin/migrate.mjs [--db <path>] [--dir <dir>] [--status] [--dry-run] [--rollback]

  --status     只打印当前迁移状态
  --dry-run    只列出待执行迁移
  --rollback   回滚最后一个迁移（需要 .down.sql；不承诺无损）`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const dbPath = String(args.db);
  const dir = String(args.dir);
  const opened = openDatabase({ path: dbPath });
  try {
    if (args.status) {
      const rows = listMigrations(opened.db);
      console.log(JSON.stringify({ db: dbPath, dir, currentVersion: getCurrentVersion(opened.db), migrations: rows }, null, 2));
      return;
    }
    if (args.rollback) {
      const result = rollbackLastMigration(opened.db, { dir });
      console.log(JSON.stringify({ db: dbPath, ...result }, null, 2));
      return;
    }
    const result = applyMigrations(opened.db, { dir, dryRun: args.dryRun === true });
    console.log(JSON.stringify({ db: dbPath, dir, ...result }, null, 2));
  } finally {
    opened.db.close();
  }
}

main().catch((err) => {
  console.error(`[migrate] 失败：${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
