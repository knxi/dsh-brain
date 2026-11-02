// @ts-check
/**
 * queue.js — 有界持久事件队列（连接器唯一的落盘点）。
 *
 * 契约约束：
 *   - 契约 §1：connector 只写 `data/events/`，绝不写记忆库。
 *   - 契约 §3：单写入队列；消费端 at-least-once + 幂等，connector 侧负责**不丢、不重**。
 *   - 契约 §10.2 + 会话 feed 语义：写失败**绝不抛出**，观测器异常不能拖垮宿主回合。
 *
 * 为什么要有界：会话事件是 fire-and-forget feed，宿主不会为我们背压。
 * 无限缓冲 = 进程内存被一条跑疯的会话吃掉；所以缓冲行数、单分片字节数、
 * 分片数三道上限，超了先丢**最老**的缓冲行并在统计里记 dropped。
 *
 * 落盘形态（JSONL，老 → 新）：
 *   <dir>/dsh-events.jsonl       当前分片
 *   <dir>/dsh-events.1.jsonl     上一代
 *   … 最多 maxSegments 个；再老的在轮转时删除
 *
 * 同步 appendFileSync：事件量级是「每 step 几条」，M0 探针已实测可用；
 * 换成异步写会引入「进程被强杀时缓冲全丢」的额外损失（M0 实测强杀 = 零终结事件）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 当前分片文件名 */
const SEGMENT_NAME = 'dsh-events.jsonl'

/**
 * @typedef {Object} QueueOptions
 * @property {string} dir 落盘目录
 * @property {number} [maxBufferedLines] 内存缓冲上限（超出丢最老）
 * @property {number} [maxFileBytes] 单个分片字节上限，超过就轮转
 * @property {number} [maxSegments] 保留多少个分片（含当前）
 * @property {(message: string) => void} [onError] 写失败时的降级报告口（不得抛）
 */

/**
 * @typedef {Object} QueueStats
 * @property {number} appended 已接受的行数
 * @property {number} written 已成功落盘的行数
 * @property {number} dropped 因有界策略丢弃的行数
 * @property {number} writeFailures 写失败次数
 * @property {number} rotations 轮转次数
 * @property {number} pending 仍在缓冲里的行数
 */

export class BoundedEventQueue {
  /** @type {string} */
  #dir
  /** @type {string[]} */
  #buffer = []
  /** @type {number} */
  #maxBufferedLines
  /** @type {number} */
  #maxFileBytes
  /** @type {number} */
  #maxSegments
  /** @type {(message: string) => void} */
  #onError
  /** @type {QueueStats} */
  #stats = { appended: 0, written: 0, dropped: 0, writeFailures: 0, rotations: 0, pending: 0 }
  /** @type {boolean} */
  #dirReady = false
  /** @type {string[]} */
  #recentErrors = []

  /**
   * @param {QueueOptions} options
   */
  constructor(options) {
    if (typeof options?.dir !== 'string' || options.dir.length === 0) {
      throw new TypeError('BoundedEventQueue: options.dir is required')
    }
    this.#dir = options.dir
    this.#maxBufferedLines = positiveInt(options.maxBufferedLines, 2000)
    this.#maxFileBytes = positiveInt(options.maxFileBytes, 2 * 1024 * 1024)
    this.#maxSegments = Math.max(1, positiveInt(options.maxSegments, 4))
    this.#onError = typeof options.onError === 'function' ? options.onError : () => {}
  }

  /** @returns {string} */
  get dir() {
    return this.#dir
  }

  /** @returns {QueueStats} */
  stats() {
    return { ...this.#stats, pending: this.#buffer.length }
  }

  /** @returns {string[]} 最近 N 条写失败说明（诊断用，不含正文） */
  recentErrors() {
    return [...this.#recentErrors]
  }

  /**
   * 入队一行（对象会被 JSON 序列化）。**绝不抛**。
   * @param {unknown} record
   * @returns {boolean} 是否被接受（false = 有界策略丢弃或不可序列化）
   */
  append(record) {
    /** @type {string | undefined} */
    let line
    try {
      line = JSON.stringify(record)
    } catch {
      // 不可序列化（循环引用 / 抛错 getter）= 这条数据根本没进队列 → 记 dropped，不算写失败
      this.#stats.dropped += 1
      return false
    }
    if (typeof line !== 'string') {
      this.#stats.dropped += 1
      return false
    }
    try {
      this.#buffer.push(line)
      this.#stats.appended += 1
      // 有界：丢最老的缓冲行（保新弃旧 —— 新的才是还在演进的那一轮）
      while (this.#buffer.length > this.#maxBufferedLines) {
        this.#buffer.shift()
        this.#stats.dropped += 1
      }
      this.flush()
      return true
    } catch (error) {
      this.#stats.writeFailures += 1
      this.#report(`append failed: ${describeError(error)}`)
      return false
    }
  }

  /**
   * 把缓冲同步落盘。**绝不抛**。
   * @returns {{ written: number, error: string | null }}
   */
  flush() {
    if (this.#buffer.length === 0) return { written: 0, error: null }
    try {
      this.#ensureDir()
      const path = join(this.#dir, SEGMENT_NAME)
      this.#maybeRotate(path)
      const chunk = this.#buffer.join('\n') + '\n'
      appendFileSync(path, chunk, 'utf8')
      const written = this.#buffer.length
      this.#buffer = []
      this.#stats.written += written
      return { written, error: null }
    } catch (error) {
      this.#stats.writeFailures += 1
      const message = describeError(error)
      this.#report(`flush failed: ${message}`)
      // 缓冲保留到上限，下一条 append 触发的 flush 会重试；再失败就靠有界策略丢老行。
      return { written: 0, error: message }
    }
  }

  /**
   * 读回所有分片（老 → 新），返回已解析记录。坏行跳过（不污染主账）。
   * @returns {Array<Record<string, unknown>>}
   */
  readAll() {
    /** @type {Array<Record<string, unknown>>} */
    const records = []
    for (const path of this.segmentPaths()) {
      let text = ''
      try {
        text = readFileSync(path, 'utf8')
      } catch {
        continue
      }
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue
        try {
          const parsed = JSON.parse(line)
          if (parsed !== null && typeof parsed === 'object') records.push(parsed)
        } catch {
          /* 坏行 = 半写；跳过，不污染 */
        }
      }
    }
    return records
  }

  /**
   * 分片路径，老 → 新。
   * @returns {string[]}
   */
  segmentPaths() {
    /** @type {string[]} */
    const older = []
    for (let index = this.#maxSegments - 1; index >= 1; index -= 1) {
      older.push(join(this.#dir, segmentName(index)))
    }
    // older 现在是「最老 → 次新」，去不存在的
    const existing = older.filter((path) => existsSync(path))
    const current = join(this.#dir, SEGMENT_NAME)
    return existsSync(current) ? [...existing, current] : [...existing, current]
  }

  /** 收尾：尽力 flush 一次，然后清空缓冲。绝不抛。 */
  close() {
    this.flush()
    this.#buffer = []
  }

  /** @param {string} path */
  #maybeRotate(path) {
    let size = 0
    try {
      size = existsSync(path) ? statSync(path).size : 0
    } catch {
      size = 0
    }
    if (size < this.#maxFileBytes) return
    try {
      // 从最老往新挪：.N 删掉，.N-1 → .N，current → .1
      const last = segmentName(this.#maxSegments - 1)
      const lastPath = join(this.#dir, last)
      if (existsSync(lastPath)) rmSync(lastPath, { force: true })
      for (let index = this.#maxSegments - 2; index >= 1; index -= 1) {
        const from = join(this.#dir, segmentName(index))
        const to = join(this.#dir, segmentName(index + 1))
        if (existsSync(from)) renameSync(from, to)
      }
      renameSync(path, join(this.#dir, segmentName(1)))
      this.#stats.rotations += 1
    } catch (error) {
      this.#report(`rotate failed: ${describeError(error)}`)
    }
  }

  #ensureDir() {
    if (this.#dirReady) return
    mkdirSync(this.#dir, { recursive: true })
    this.#dirReady = true
  }

  /** @param {string} message */
  #report(message) {
    this.#recentErrors.push(message)
    if (this.#recentErrors.length > 20) this.#recentErrors.shift()
    try {
      this.#onError(message)
    } catch {
      /* 报告口自己崩了也不能抛 */
    }
  }
}

/**
 * @param {number} index
 * @returns {string}
 */
function segmentName(index) {
  return index === 0 ? SEGMENT_NAME : `dsh-events.${index}.jsonl`
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function positiveInt(value, fallback) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.floor(value)
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  const anyError = /** @type {any} */ (error)
  return String(anyError?.message ?? anyError ?? 'unknown error')
}

/**
 * 目录里有多少个分片（诊断用）。
 * @param {string} dir
 * @returns {number}
 */
export function segmentCount(dir) {
  try {
    return readdirSync(dir).filter((name) => name === SEGMENT_NAME || /^dsh-events\.\d+\.jsonl$/.test(name)).length
  } catch {
    return 0
  }
}
