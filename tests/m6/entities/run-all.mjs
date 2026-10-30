// @ts-check
/**
 * 目录入口：让 `node --test tests/m6/entities` 能跑全部 M6 实体/关系测试。
 *
 * 照 tests/contract/run-all.mjs：Node 24.19 的 test runner 把目录参数当成模块入口，
 * 而不是递归搜索目录。目录里放 package.json + main 指向本文件后，两种调用都成立：
 *   node --test tests/m6/entities
 *   node --test "tests/m6/entities/**\/*.test.mjs"
 *
 * 新增测试文件时，记得在这里也 import 一行。
 */

import './entities.test.mjs';
import './update-kind.test.mjs';
