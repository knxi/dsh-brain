// @ts-check
/**
 * 目录入口：让 `node --test tests/m4/usage` 也能跑全部使用统计测试。
 *
 * 实测（Node v24.19.0 / Windows）：`node --test <目录>` 会在某些调用方式下把目录参数
 * 当成模块入口去 resolve（报 Cannot find module），而 `node --test "<glob>"` 一直可用。
 * 目录里放 package.json + main 指向本文件后，两种调用都成立：
 *   node --test tests/m4/usage
 *   node --test "tests/m4/usage/*.test.mjs"
 *
 * 新增测试文件时，记得在这里也 import 一行。
 */

import './usage-log.test.mjs';
import './used-later.test.mjs';
