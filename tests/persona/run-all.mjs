// @ts-check
/**
 * 目录入口：让 `node --test tests/persona` 能跑全部系统 4 用例。
 *
 * 照 `tests/m7/mood/run-all.mjs`：Node 24 的 test runner 把目录参数当成模块入口，
 * 而不是递归搜索。目录里放 `package.json`（main 指向本文件）后两种调用都成立：
 *   node --test tests/persona
 *   node --test "tests/persona/**\/*.test.mjs"
 *
 * 受限沙箱里 `node --test` 会 spawn 子进程被拒（EPERM），那时直接跑单文件：
 *   node tests/persona/social.test.mjs
 *
 * 新增测试文件时记得在这里也 import 一行。
 */

import './import-persona.test.mjs';
import './persona-versions.test.mjs';
import './relationship.test.mjs';
import './social.test.mjs';
import './response.test.mjs';
