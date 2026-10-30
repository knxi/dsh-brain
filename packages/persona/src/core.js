// @ts-check
/**
 * `@dsh-brain/core` 的唯一入口（本包内所有模块都从这里拿 core）。
 *
 * ── 为什么是相对路径而不是 `from '@dsh-brain/core'` ──
 *
 * Windows 上 `node_modules/@dsh-brain/core` 是 **junction**（pnpm workspace 的默认做法）。
 * 实测 Node 24 的 ESM 解析对「绝对目标」的 junction 只解析半程：
 * 从本包 import 得到的 `BrainError` 与从 `packages/memory` import 得到的
 * **不是同一个类**（`instanceof` 为 false）。
 *
 * 后果不是「报错」而是更糟的东西：本包抛出的 `NOT_FOUND` / `INVALID_ARGUMENT`
 * 经 `queue.write` 的 `isBrainError()` 判断后**被当成未知错误包成 `STORAGE_ERROR`**，
 * 错误码静默降级——这类问题在集成后才炸，且很难查。
 *
 * 用相对路径后两边解析到同一个真实文件（`packages/core/src/index.js`），
 * 模块身份唯一。**只有这一个文件允许 import core**，其它模块一律 `from './core.js'`，
 * 将来换回包名只需改这一行。
 */

export {
  BrainError,
  formatLocalIso,
  localParts,
  sha256Hex,
} from '../../core/src/index.js';
