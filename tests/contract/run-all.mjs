// @ts-check
/**
 * 目录入口：让 `node --test tests/contract` 能跑全部契约测试。
 *
 * 为什么需要它：Node 24.19 的 test runner 把目录参数当成模块入口，
 * 而不是递归搜索目录（实测 `node --test tests/contract` 直接报 MODULE_NOT_FOUND）。
 * 目录里放 package.json + main 指向本文件后，两种调用都成立：
 *   node --test tests/contract
 *   node --test "tests/contract/*.test.mjs"
 *
 * 新增测试文件时，记得在这里也 import 一行。
 */

import './core-envelope.test.mjs';
import './migrations.test.mjs';
import './idempotent-ingest.test.mjs';
import './transaction-durability.test.mjs';
import './disk-full.test.mjs';
import './outbox-recovery.test.mjs';
import './out-of-order.test.mjs';
import './deletion-barrier.test.mjs';
import './backup.test.mjs';
import './pragmas.test.mjs';
