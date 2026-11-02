// @ts-check
/**
 * 目录入口：让 `node --test tests/m7/mood` 能跑全部 M7.2 用例。
 *
 * 照 tests/m6/entities/run-all.mjs：Node 24 的 test runner 把目录参数当成模块入口，
 * 而不是递归搜索目录。目录里放 package.json + main 指向本文件后，两种调用都成立：
 *   node --test tests/m7/mood
 *   node --test "tests/m7/mood/**\/*.test.mjs"
 *
 * 新增测试文件时，记得在这里也 import 一行。
 */

import './mood-facade.test.mjs';
import './fox-mood-migration.test.mjs';
import './fox-mood-bridge.test.mjs';
