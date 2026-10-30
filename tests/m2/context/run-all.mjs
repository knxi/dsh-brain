// @ts-check
/**
 * 目录入口：让 `node --test tests/m2/context` 能跑全部构包测试。
 *
 * 为什么需要它：Node 24.19 的 test runner 把目录参数当成模块入口、不递归搜索
 * （实测 `node --test tests/contract` 直接 MODULE_NOT_FOUND，见 CONTRACTS §11.6）。
 * 目录里放 package.json + main 指向本文件后，两种调用都成立：
 *   node --test tests/m2/context
 *   node --test "tests/m2/context/*.test.mjs"
 *
 * 新增测试文件时，记得在这里也 import 一行。
 */

import './budget.test.mjs';
import './build.test.mjs';
import './canonical.test.mjs';
import './state.test.mjs';
import './degrade.test.mjs';
import './persistence.test.mjs';
