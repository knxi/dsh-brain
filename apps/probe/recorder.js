/**
 * recorder.js — 探针的唯一落盘点。
 *
 * 纪律：
 *   - 只追加写 timeline.jsonl，不改宿主任何状态。
 *   - 写失败绝不抛出：观测器异常不能拖垮宿主回合（契约红线 + 会话 feed 隔离语义）。
 *   - 每条一行 JSON：{ts, hook, seq, phase, ...摘要}，符合 docs/CONTRACTS.md 第 9 节。
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** 探针标记：受控注入实验用的合成片段，能在最终请求里被检索到就是 sent 证据。 */
export const PROBE_MARKER_ID = 'brain-probe-marker-0001'
export const PROBE_MARKER = `[BRAIN-PROBE-MARKER ${PROBE_MARKER_ID}] synthetic fragment for M0 assembly probe; origin=probe`

/** @type {{dir: string | null, seq: number, lines: string[]}} */
const state = { dir: null, seq: 0, lines: [] }

/**
 * 初始化输出目录。
 * @param {string} dir 本次 runId 的输出目录
 */
export function initRecorder(dir) {
  state.dir = dir
  state.seq = 0
  state.lines = []
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'timeline.jsonl'), '', 'utf8')
  } catch (error) {
    console.error('[brain-probe] 无法建立输出目录:', error && error.message)
    state.dir = null
  }
}

/** @returns {string | null} 当前输出目录（未初始化则为 null） */
export function recorderDir() {
  return state.dir
}

/**
 * 记一条事件。
 * @param {string} hook 钩子名（或 probe/boot 这类探针自有事件）
 * @param {'before'|'after'|'reject'|'pass'|'info'} phase 阶段
 * @param {Record<string, unknown>} [payload] 摘要（必须已脱敏、已截断）
 */
export function record(hook, phase, payload = {}) {
  state.seq += 1
  const line = { ts: new Date().toISOString(), hook, seq: state.seq, phase, ...payload }
  state.lines.push(JSON.stringify(line))
  if (state.dir === null) return
  try {
    appendFileSync(join(state.dir, 'timeline.jsonl'), JSON.stringify(line) + '\n', 'utf8')
  } catch (error) {
    console.error('[brain-probe] timeline 写入失败:', error && error.message)
  }
}

/**
 * 把任意值压成有界摘要：字符串截断、数组取长度、对象取指定键。
 * @param {unknown} value
 * @param {number} [max] 字符串上限
 * @returns {unknown}
 */
export function brief(value, max = 160) {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…(len=${value.length})` : value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return { arrayLen: value.length }
  if (typeof value === 'object') return `{${Object.keys(value).slice(0, 12).join(',')}}`
  return String(value)
}
