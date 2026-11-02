// @ts-check
/**
 * Token 预算（CONTRACTS §6，M2-INTERFACES §2）。
 *
 * 公式**逐字照抄**，一个字都不改：
 *
 * ```
 * safetyMargin   = max(modelWindow * 0.05, 1024)
 * brainAllowance = max(0, min(brainCap ?? 2048, modelWindow - hostInputTokens - outputReserve - safetyMargin))
 * ```
 *
 * 拿不到 `modelWindow` 或 `hostInputTokens` 时不套公式、不猜一个假输入：
 * 改用**固定小额上限**并在 `notes` / `estimated` / `hostInputSource` 里明确标「估算」。
 * 伪造精确 Token 比不注入更危险——检查器会把假的数字当成真的。
 */

import { BrainError } from '@dsh-brain/core';
import { ESTIMATE_TOKENIZER_ID } from './estimate.js';

/** 公式原文常量：检查器直接显示这一行，和 CONTRACTS 对照。 */
export const BRAIN_BUDGET_FORMULA =
  'safetyMargin = max(modelWindow * 0.05, 1024); ' +
  'brainAllowance = max(0, min(brainCap ?? 2048, modelWindow - hostInputTokens - outputReserve - safetyMargin))';

/** 初始 brain_cap（CONTRACTS §6：「初始 brain_cap = 2048，待实测」）。 */
export const DEFAULT_BRAIN_CAP = 2048;

/** safety_margin 下界 1024。 */
export const SAFETY_MARGIN_FLOOR = 1024;

/** safety_margin 比例 5%。 */
export const SAFETY_MARGIN_RATIO = 0.05;

/**
 * 拿不到宿主已用输入 Token 时的固定小额上限。
 *
 * 为什么是 512：M0 实测同一个 provider 的 system prompt 单节就有 2729 字符量级，
 * 拿不到真实占用时给一个「注入了也不会把回合顶爆」的量级；这个数**不是**对
 * host_input 的猜测，而是明确的额度封顶（所以不代入公式，直接 min）。
 */
export const ESTIMATED_HOST_INPUT_ALLOWANCE = 512;

/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} min
 * @returns {number|null}
 */
function optionalNumber(field, value, min) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min) {
    throw new BrainError('INVALID_ARGUMENT', `budget.${field} 必须是 >= ${min} 的有限数字，收到 ${String(value)}`, {
      details: { field: `budget.${field}`, received: typeof value === 'number' ? value : typeof value },
    });
  }
  return value;
}

/**
 * 计算 safetyMargin。`modelWindow` 未知时公式无定义，取下界 1024（并在 notes 里说明）。
 *
 * @param {number|null} modelWindow
 * @returns {number}
 */
export function computeSafetyMargin(modelWindow) {
  if (modelWindow === null) return SAFETY_MARGIN_FLOOR;
  return Math.max(modelWindow * SAFETY_MARGIN_RATIO, SAFETY_MARGIN_FLOOR);
}

/**
 * 计算预算账本。返回值里的 `used` / `dropped` 是空壳，由 build 填。
 *
 * @param {{ modelWindow?: number, hostInputTokens?: number, outputReserve?: number, brainCap?: number }} [input]
 * @returns {import('./types.js').ContextBudget}
 */
export function computeBudget(input = {}) {
  if (input === null || typeof input !== 'object') {
    throw new BrainError('INVALID_ARGUMENT', 'budget 必须是对象');
  }
  const modelWindow = optionalNumber('modelWindow', input.modelWindow, 1);
  const hostInputTokens = optionalNumber('hostInputTokens', input.hostInputTokens, 0);
  const outputReserve = optionalNumber('outputReserve', input.outputReserve, 0) ?? 0;
  const brainCap = optionalNumber('brainCap', input.brainCap, 0) ?? DEFAULT_BRAIN_CAP;
  const safetyMargin = computeSafetyMargin(modelWindow);

  /** @type {string[]} */
  const notes = [];
  if (input.outputReserve === undefined || input.outputReserve === null) {
    notes.push('output_reserve_not_provided：未提供输出预留 Token，按 0 计算（预算偏乐观，调用方应显式给值）');
  }

  let brainAllowance;
  if (modelWindow !== null && hostInputTokens !== null) {
    // 逐字对应公式：max(0, min(brainCap ?? 2048, modelWindow - hostInputTokens - outputReserve - safetyMargin))
    const rawAllowance = modelWindow - hostInputTokens - outputReserve - safetyMargin;
    brainAllowance = Math.max(0, Math.min(brainCap, rawAllowance));
  } else {
    // 估算路径：不套公式，固定小额上限；窗口已知时再按窗口余量收一次，保证不超窗。
    if (modelWindow === null) {
      notes.push('model_window_unavailable：未提供模型窗口，无法计算窗口余量，改用固定小额上限（估算）');
    }
    if (hostInputTokens === null) {
      notes.push(
        'host_input_tokens_unavailable：拿不到宿主已用输入 Token，改用固定小额上限，tokenizerId 为估算口径（不伪造精确 Token）',
      );
    }
    const ceiling =
      modelWindow === null ? Number.POSITIVE_INFINITY : Math.max(0, modelWindow - outputReserve - safetyMargin);
    brainAllowance = Math.max(0, Math.min(brainCap, ESTIMATED_HOST_INPUT_ALLOWANCE, ceiling));
  }

  // Token 是整数单位，向下取整；向上取整会让预算比公式允许多出不到 1 token。
  brainAllowance = Math.floor(brainAllowance);

  const estimated = modelWindow === null || hostInputTokens === null;
  return {
    brainAllowance,
    used: 0,
    dropped: [],
    formula: BRAIN_BUDGET_FORMULA,
    safetyMargin,
    brainCap,
    modelWindow,
    hostInputTokens,
    outputReserve,
    estimated,
    hostInputSource: hostInputTokens === null ? 'estimated' : 'provided',
    tokenizerId: ESTIMATE_TOKENIZER_ID,
    notes,
  };
}
