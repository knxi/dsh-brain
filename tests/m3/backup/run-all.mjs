// @ts-check
/**
 * 目录入口：让 `node --test tests/m3/backup` 能跑全部 M3 备份恢复测试。
 * 新增测试文件时在这里补一行 import。
 */

import './backup-full.test.mjs';
import './blob-gc.test.mjs';
import './prune.test.mjs';
import './restore-plan.test.mjs';
import './restore-execute.test.mjs';
import './no-revive.test.mjs';
import './drill.test.mjs';
