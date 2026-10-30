// @ts-check
/**
 * queue-bounds.test.mjs — 有界持久队列。
 *
 * 契约要求：connector 自持久入队（不能假设 feed 已落盘）、写失败不抛、
 * 有界（不能把进程内存吃穿）、坏行不污染主账。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BoundedEventQueue, segmentCount } from '../../../apps/connector/queue.js'
import { tempDir } from './helpers.mjs'

test('append 后能读回（JSONL，老 → 新）', () => {
  const temp = tempDir()
  const queue = new BoundedEventQueue({ dir: temp.dir })
  queue.append({ a: 1 })
  queue.append({ a: 2 })
  queue.append({ a: 3 })
  const records = queue.readAll()
  assert.deepEqual(records, [{ a: 1 }, { a: 2 }, { a: 3 }])
  assert.equal(queue.stats().written, 3)
  assert.equal(queue.stats().pending, 0)
  temp.cleanup()
})

test('写失败不抛，且缓冲保留（上限内不丢数据）', () => {
  const temp = tempDir()
  const notADir = join(temp.dir, 'file-instead-of-dir')
  writeFileSync(notADir, 'x', 'utf8')
  /** @type {string[]} */
  const errors = []
  const queue = new BoundedEventQueue({ dir: notADir, onError: (message) => errors.push(message) })
  const accepted = queue.append({ a: 1 })
  assert.equal(accepted, true, '入队成功，落盘失败')
  assert.ok(queue.stats().writeFailures >= 1)
  assert.equal(queue.stats().pending, 1, '缓冲必须保留，等下次 flush 重试')
  assert.ok(errors.length >= 1)
  temp.cleanup()
})

test('超过内存上限时丢最老（保新弃旧）', () => {
  const temp = tempDir()
  const notADir = join(temp.dir, 'blocked')
  writeFileSync(notADir, 'x', 'utf8')
  const queue = new BoundedEventQueue({ dir: notADir, maxBufferedLines: 3 })
  for (let index = 1; index <= 10; index += 1) queue.append({ n: index })
  const stats = queue.stats()
  assert.equal(stats.pending, 3, '缓冲恒不超过上限')
  assert.equal(stats.dropped, 7)
  assert.equal(stats.appended, 10)
  temp.cleanup()
})

test('单分片超字节上限时轮转，且只保留 maxSegments 个分片', () => {
  const temp = tempDir()
  const queue = new BoundedEventQueue({ dir: temp.dir, maxFileBytes: 300, maxSegments: 3 })
  for (let index = 0; index < 60; index += 1) {
    queue.append({ index, padding: 'x'.repeat(40) })
  }
  assert.ok(queue.stats().rotations >= 1, '应当发生过轮转')
  assert.ok(segmentCount(temp.dir) <= 3, `分片数必须受 maxSegments 约束，实际 ${segmentCount(temp.dir)}`)
  // 最新的数据一定还在（轮转保新）
  const records = queue.readAll()
  assert.ok(records.length > 0)
  assert.equal(records[records.length - 1].index, 59)
  temp.cleanup()
})

test('坏行被跳过，不污染主账', () => {
  const temp = tempDir()
  const queue = new BoundedEventQueue({ dir: temp.dir })
  queue.append({ ok: 1 })
  // 手工塞一条半写行（进程被强杀时真会出现）
  const path = join(temp.dir, 'dsh-events.jsonl')
  writeFileSync(path, '{"ok":1}\n{"half":', 'utf8')
  const records = queue.readAll()
  assert.deepEqual(records, [{ ok: 1 }])
  temp.cleanup()
})

test('不可序列化的数据也不抛，只计 dropped', () => {
  const temp = tempDir()
  const queue = new BoundedEventQueue({ dir: temp.dir })
  const circular = {}
  circular.self = circular
  assert.equal(queue.append(circular), false)
  assert.equal(queue.stats().dropped, 1)
  assert.equal(queue.stats().writeFailures, 0)
  temp.cleanup()
})

test('未初始化目录也能读（返回空数组而非抛错）', () => {
  const temp = tempDir()
  const queue = new BoundedEventQueue({ dir: join(temp.dir, 'never-created') })
  assert.deepEqual(queue.readAll(), [])
  temp.cleanup()
})
