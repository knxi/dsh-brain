// @ts-check
/**
 * M2 预算公式边界：逐字对照 CONTRACTS §6。
 *
 * 覆盖：正常公式、cap 生效、窗口不足、预算为 0、估算路径（拿不到 hostInputTokens /
 * 拿不到 modelWindow）、非法参数、整数化。
 */

import test from 'node:test';
import { assert } from './helpers.mjs';
import {
  BRAIN_BUDGET_FORMULA,
  DEFAULT_BRAIN_CAP,
  ESTIMATED_HOST_INPUT_ALLOWANCE,
  SAFETY_MARGIN_FLOOR,
  computeBudget,
  computeSafetyMargin,
} from '../../../packages/context/src/index.js';

test('预算公式：逐字对照 CONTRACTS §6 的 safetyMargin 与 brainAllowance', () => {
  const budget = computeBudget({ modelWindow: 32000, hostInputTokens: 1000, outputReserve: 4096 });

  // safetyMargin = max(32000 * 0.05, 1024) = 1600
  assert.ok(Math.abs(budget.safetyMargin - 1600) < 1e-9, `safetyMargin=${budget.safetyMargin}`);
  // brainAllowance = max(0, min(2048, 32000 - 1000 - 4096 - 1600)) = 2048
  assert.equal(budget.brainAllowance, DEFAULT_BRAIN_CAP);
  assert.equal(budget.brainCap, 2048);
  assert.equal(budget.estimated, false);
  assert.equal(budget.hostInputSource, 'provided');
  assert.equal(budget.used, 0);
  assert.deepEqual(budget.dropped, []);

  // 公式原文逐字存在，检查器要能显示这一行
  assert.equal(budget.formula, BRAIN_BUDGET_FORMULA);
  assert.match(budget.formula, /safetyMargin = max\(modelWindow \* 0\.05, 1024\)/);
  assert.match(
    budget.formula,
    /brainAllowance = max\(0, min\(brainCap \?\? 2048, modelWindow - hostInputTokens - outputReserve - safetyMargin\)\)/,
  );
});

test('safetyMargin：5% 与 1024 的切换点在 20480', () => {
  // 20480 * 0.05 = 1024，正好相等
  assert.equal(computeSafetyMargin(20480), 1024);
  // 窗口小 → 取下界
  assert.equal(computeSafetyMargin(8000), SAFETY_MARGIN_FLOOR);
  // 窗口大 → 取 5%
  assert.ok(Math.abs(computeSafetyMargin(40000) - 2000) < 1e-9);
  // 窗口未知 → 下界（不猜）
  assert.equal(computeSafetyMargin(null), SAFETY_MARGIN_FLOOR);
});

test('brainCap 生效：窗口余量很大时仍不超过 cap', () => {
  const budget = computeBudget({ modelWindow: 32000, hostInputTokens: 0, outputReserve: 0, brainCap: 700 });
  // min(700, 32000 - 0 - 0 - 1600) = 700
  assert.equal(budget.brainAllowance, 700);
  assert.equal(budget.brainCap, 700);
});

test('窗口不足：宿主输入吃掉余量后预算被夹到 0', () => {
  const budget = computeBudget({ modelWindow: 4000, hostInputTokens: 3000, outputReserve: 512 });
  // safetyMargin = 1024；4000 - 3000 - 512 - 1024 = -536 → max(0, ...) = 0
  assert.equal(budget.brainAllowance, 0);
  assert.equal(budget.estimated, false);

  // 窗口比 safetyMargin 还小的极端情形
  const tiny = computeBudget({ modelWindow: 1000, hostInputTokens: 0, outputReserve: 0 });
  assert.equal(tiny.brainAllowance, 0);
});

test('预算为 0：rawAllowance 恰好为 0 时严谨取 0', () => {
  // 10000 - 8976 - 0 - 1024 = 0
  const budget = computeBudget({ modelWindow: 10000, hostInputTokens: 8976, outputReserve: 0 });
  assert.equal(budget.safetyMargin, 1024);
  assert.equal(budget.brainAllowance, 0);

  // outputReserve 单独把余量吃光
  const reserveAte = computeBudget({ modelWindow: 10000, hostInputTokens: 0, outputReserve: 8976 });
  assert.equal(reserveAte.brainAllowance, 0);
});

test('拿不到 hostInputTokens：固定小额上限 + 明确标「估算」，不伪造精确值', () => {
  const budget = computeBudget({ modelWindow: 32000 });
  // min(brainCap 2048, 512, 32000 - 0 - 1600) = 512
  assert.equal(budget.brainAllowance, ESTIMATED_HOST_INPUT_ALLOWANCE);
  assert.equal(budget.estimated, true);
  assert.equal(budget.hostInputSource, 'estimated');
  assert.ok(
    budget.notes.some((note) => note.includes('host_input_tokens_unavailable')),
    `notes 要写清楚为什么是估算：${JSON.stringify(budget.notes)}`,
  );
  assert.equal(budget.hostInputTokens, null);
  // 不伪装：tokenizerId 带 estimate: 前缀
  assert.match(budget.tokenizerId, /^estimate:/);
});

test('拿不到 hostInputTokens：窗口本身很小时，估算上限再被窗口收一次，保证不超窗', () => {
  // safetyMargin = 1024；ceiling = 1500 - 0 - 1024 = 476
  const budget = computeBudget({ modelWindow: 1500 });
  assert.equal(budget.brainAllowance, 476);
  assert.equal(budget.estimated, true);
});

test('拿不到 hostInputTokens：brainCap 更小时按 cap 走', () => {
  const budget = computeBudget({ modelWindow: 32000, brainCap: 100 });
  assert.equal(budget.brainAllowance, 100);
  assert.equal(budget.estimated, true);
});

test('拿不到 modelWindow：不套公式，用固定小额上限并说明原因', () => {
  const budget = computeBudget({});
  assert.equal(budget.modelWindow, null);
  assert.equal(budget.brainAllowance, ESTIMATED_HOST_INPUT_ALLOWANCE);
  assert.equal(budget.safetyMargin, SAFETY_MARGIN_FLOOR);
  assert.equal(budget.estimated, true);
  assert.ok(budget.notes.some((note) => note.includes('model_window_unavailable')));
});

test('未提供 outputReserve：按 0 计算但必须留痕（预算偏乐观是事实）', () => {
  const budget = computeBudget({ modelWindow: 32000, hostInputTokens: 1000 });
  assert.equal(budget.outputReserve, 0);
  assert.ok(budget.notes.some((note) => note.includes('output_reserve_not_provided')));
});

test('非法参数：INVALID_ARGUMENT，不静默兜底', () => {
  const asserts = [
    { modelWindow: 0 },
    { modelWindow: -1 },
    { modelWindow: Number.NaN },
    { hostInputTokens: -1 },
    { outputReserve: Number.POSITIVE_INFINITY },
    { brainCap: -5 },
    { outputReserve: /** @type {any} */ ('1') },
  ];
  for (const patch of asserts) {
    assert.throws(
      () => computeBudget(patch),
      (/** @type {any} */ err) => err.code === 'INVALID_ARGUMENT',
      `应该拒绝 ${JSON.stringify(patch)}`,
    );
  }
});

test('Token 记账取整：预算向下取整（不向上多给不到 1 token 的余量）', () => {
  // safetyMargin = 30001 * 0.05 = 1500.05；30001 - 27000 - 0 - 1500.05 = 1500.95 → 1500
  const budget = computeBudget({ modelWindow: 30001, hostInputTokens: 27000, outputReserve: 0 });
  assert.equal(budget.brainAllowance, 1500);
  assert.ok(Number.isInteger(budget.brainAllowance));
});
