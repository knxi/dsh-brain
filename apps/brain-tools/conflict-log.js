// @ts-check
/**
 * 矛盾核验动作的审计 sidecar（M7 · 2026-10-30）。
 *
 * 为什么需要它：`/dsh-brain/conflicts` 从只读变成可操作之后，人可以在页面上
 * 「保留左侧 / 保留右侧 / 两条都对」——这是**写记忆库**的动作。现有的可追溯性缝不上这一层：
 *
 * - `memories.supersede` 会写 `memory_versions`（旧条目的封口有痕）——那半边有；
 * - 但「谁在哪一刻点了哪个按钮、把哪条边删了」没有任何地方记。
 *   删边是派生结构（`entities.js` 的注释说它可重建），可**重建需要知道当初是什么**。
 *
 * 所以这里落一份 append-only 的动作流水：一行一个动作，足以后置重放/回滚。
 *
 * 几条纪律（都是本项目反复踩过的）：
 * 1. **不记记忆正文**：只记 id 和动作。正文进日志等于把隐私复制一份到另一个文件。
 * 2. **失败不抛**：调用方是 HTTP handler，日志写失败不许把「已经改成功的库」说成失败
 *    （写失败只在返回值里标 `logged: false`）。
 * 3. **路径必须可配置**：验收脚本显式传临时路径，别把合成动作写进生产流水
 *    （CONTRACTS §12.39：假数据混进观察期比没有统计更糟）。
 * 4. **每行自带 `schema`**：将来字段变了，老行还能被认出来。
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** 生产默认落点。路径可被 config.conflictLogPath 覆盖。 */
export const DEFAULT_CONFLICT_LOG = 'E:/ds-h/dsh-brain/data/logs/conflict-actions.jsonl'

/** 允许的动作。新增动作必须同时在这里和前端的选择器里加。 */
export const CONFLICT_ACTIONS = Object.freeze(['keep-left', 'keep-right', 'not-conflict'])

/** 允许的「改成什么关系」的取值（仅 not-conflict 用）。 */
export const NOT_CONFLICT_KINDS = Object.freeze(['refines', 'supports'])

const SCHEMA = 1

/**
 * 规范化一条动作记录：固定字段形状，缺的补 null，多的一律丢掉。
 * 「多带一个字段」在日志里就是噪声，后续按字段读的人会以为是有效数据。
 *
 * @param {Record<string, any>} raw
 * @param {number} [now]
 * @returns {Record<string, any>}
 */
export function normalizeConflictAction(raw, now = Date.now()) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const at = Number.isFinite(source.at) ? Number(source.at) : now
  /** @param {unknown} v */
  const str = (v) => (typeof v === 'string' && v.length > 0 ? v.slice(0, 200) : null)
  const action = CONFLICT_ACTIONS.includes(String(source.action)) ? String(source.action) : null
  return {
    schema: SCHEMA,
    ts: new Date(at).toISOString(),
    at,
    edgeId: str(source.edgeId),
    action,
    // kind 只在 not-conflict 时有意义；其它动作一律 null（避免「看似有值」的误读）
    kind: action === 'not-conflict' && NOT_CONFLICT_KINDS.includes(String(source.kind))
      ? String(source.kind)
      : null,
    fromId: str(source.fromId),
    toId: str(source.toId),
    keptId: str(source.keptId),
    supersededId: str(source.supersededId),
    newEdgeId: str(source.newEdgeId),
    edgeRemoved: source.edgeRemoved === true,
    scopeId: str(source.scopeId),
    actor: str(source.actor) ?? 'console:/dsh-brain/conflicts',
  }
}

/**
 * 追加一条动作流水。
 *
 * **永远 resolve**（不抛）：写日志失败不能让一次已经成功的库写入被报成失败。
 *
 * @param {string} logPath
 * @param {Record<string, any>} entry
 * @param {number} [now]
 * @returns {Promise<{ ok: boolean, error?: string }>}
 */
export async function appendConflictAction(logPath, entry, now = Date.now()) {
  try {
    if (typeof logPath !== 'string' || logPath.length === 0) {
      return { ok: false, error: 'logPath 为空' }
    }
    await mkdir(dirname(logPath), { recursive: true })
    await appendFile(logPath, JSON.stringify(normalizeConflictAction(entry, now)) + '\n', 'utf8')
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 读回动作流水（新→旧）。给「已核验」标记和未来的人工复核用。
 *
 * 解析失败的行跳过并计数——一行坏数据不该让整份流水不可读。
 *
 * @param {string} logPath
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<{ exists: boolean, entries: Record<string, any>[], skipped: number }>}
 */
export async function readConflictActions(logPath, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 2000)
  /** @type {string} */
  let text
  try {
    text = await readFile(logPath, 'utf8')
  } catch {
    return { exists: false, entries: [], skipped: 0 }
  }
  const lines = text.split('\n')
  /** @type {Record<string, any>[]} */
  const entries = []
  let skipped = 0
  for (const line of lines) {
    if (!line.trim()) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object') entries.push(parsed)
      else skipped += 1
    } catch {
      skipped += 1
    }
  }
  entries.reverse()
  return { exists: true, entries: entries.slice(0, limit), skipped }
}
