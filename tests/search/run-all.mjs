// @ts-check
/**
 * 目录入口：让 `node --test tests/search` 也能跑起来。
 *
 * 实测（Node v24.19.0 / Windows）：`node --test <目录>` 会把目录参数当成模块去
 * resolve，报 `Cannot find module '...\tests\search'`；直接给文件或 glob 才正常。
 * 这个 ESM 入口把三个测试文件静态引入，于是 `node --test tests/search` 能跑全。
 * 等效命令（任何 Node 版本都可用）：`node --test "tests/search/*.test.mjs"`。
 */
import './capability.test.mjs';
import './tokenize.test.mjs';
import './index.test.mjs';
