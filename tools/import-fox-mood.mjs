// @ts-check
/**
 * 把情感插件的历史状态迁进主账（M7.2）。
 *
 *   node tools/import-fox-mood.mjs            # 预演：只读 state.json + 只读打开主账
 *   node tools/import-fox-mood.mjs --apply    # 真写：1 条状态 + 全部事件
 *
 * 迁什么：
 *   - `~/.dsh/fox-mood/state.json` 里的**当前状态**（mood / energy / bond / 时间锚点）→ `fox_state`
 *   - 同一个文件里的 **events 数组**（被夸/被返工/办成了…）→ `fox_events`
 *
 * 设计要点（都是有理由的，别随手改）：
 *
 * 1. **默认 dry-run**：预演不打开写连接（readOnly），不跑迁移、不产生任何写入。
 *    `--apply` 才 openBrain 真写；那时若目标库还停在 0006，会自动应用 0007 建表
 *    （这是 M7.2 上线的正常路径，报告里会点名，见 CONTRACTS 13.7）。
 * 2. **幂等靠 (at, kind)**：同一时刻的同类事件视为同一次记账。第二遍跑应该全是
 *    `already`——这条最重要，因为「重跑一次迁移」是最常见的运维动作。
 * 3. **状态是 upsert**：`fox_state` 只有一行，重复迁移只会更新它，不会长出第二行。
 * 4. **坏条目不中断**：逐条 try/catch，最后汇总；一条脏数据不该让整次迁移停摆。
 *    状态本身坏了（缺 mood/energy/bond）才算硬失败——那种情况会明确报错。
 * 5. **SQLITE_BUSY 有限重试（≤3）**：生产 `dsh web` 可能正开着 WAL。
 *    撞锁退避重试，三次还不行就如实报错退出——死循环比失败更糟。
 * 6. **不写 memories**：情感状态永不进检索（那会把检索稀释成垃圾）。
 *    本脚本只碰 `fox_state` / `fox_events` 两张表。
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { openBrain } from '../packages/memory/src/index.js'

/** 默认 state.json 落点（与插件 `FOX_MOOD_DIR` 的缺省值一致）。 */
const DEFAULT_STATE_FILE = join(homedir(), '.dsh', 'fox-mood', 'state.json')
/** 默认目标库。`--brain=<path>` / `DSH_BRAIN_DB` 可覆盖（**测试必须用临时库**，别拿生产练手）。 */
const DEFAULT_BRAIN_DB = 'E:/ds-h/dsh-brain/data/brain.db'
const SOURCE_SYSTEM = 'fox-mood-import'
/** 预演时最多读多少条已有事件来判重（门面写入侧还有一层 (at, kind) 兜底）。 */
const DEDUPE_WINDOW = 500
const MAX_ERRORS = 10

const APPLY = process.argv.includes('--apply')
const MODE = APPLY ? 'apply' : 'dry-run'

/** `--state=<path>` 可覆盖 state.json 路径（测试 / 多实例）。 */
const stateArg = process.argv.find((arg) => arg.startsWith('--state='))
const STATE_FILE = stateArg ? stateArg.slice('--state='.length) : (process.env.FOX_MOOD_STATE || DEFAULT_STATE_FILE)

/** `--brain=<path>` 可覆盖目标库（测试 / 演练）。 */
const brainArg = process.argv.find((arg) => arg.startsWith('--brain='))
const BRAIN_DB = brainArg ? brainArg.slice('--brain='.length) : (process.env.DSH_BRAIN_DB || DEFAULT_BRAIN_DB)

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** 撞锁的 errcode：SQLITE_BUSY(5) / SQLITE_LOCKED(6) 及扩展码 */
const BUSY_CODES = new Set([5, 6, 517, 518, 261, 262])
function isBusy(error) {
  if (!error) return false
  const code = Number(/** @type {any} */ (error).errcode)
  if (BUSY_CODES.has(code)) return true
  return /SQLITE_BUSY|SQLITE_LOCKED|database (table )?is locked/i.test(messageOf(error))
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 有限重试：只对撞锁重试，业务错误（INVALID_ARGUMENT / NOT_FOUND）直接抛。
 * @template T
 * @param {() => T | Promise<T>} fn
 * @param {string} label
 * @returns {Promise<T>}
 */
async function withBusyRetry(fn, label) {
  /** @type {any} */
  let lastError
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await fn()
    } catch (error) {
      lastError = error
      if (!isBusy(error) || attempt === 3) throw error
      const wait = 250 * attempt * attempt
      console.warn('[busy] ' + label + ' 第 ' + attempt + ' 次撞锁，' + wait + 'ms 后重试')
      await sleep(wait)
    }
  }
  throw lastError
}

/* -------------------------------------------------------------------------- */
/* 1. 读 state.json（只读）                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} MoodFile
 * @property {any} raw
 * @property {boolean} present
 * @property {string | null} error
 */

/** @returns {MoodFile} */
function readStateFile() {
  if (!existsSync(STATE_FILE)) return { raw: null, present: false, error: null }
  try {
    return { raw: JSON.parse(readFileSync(STATE_FILE, 'utf8')), present: true, error: null }
  } catch (error) {
    return { raw: null, present: true, error: messageOf(error) }
  }
}

/**
 * 把 state.json 拆成「一条状态」+「N 条事件」，坏条目单独计数。
 *
 * 坏条目的判据（宁严勿宽：写进去的门面会拒，早一点拦下来报得更清楚）：
 *   - `at` 不是有限正数 → 坏（事件没有发生时刻就没有意义）
 *   - `kind` 不是非空字符串 → 坏
 * @param {any} raw
 */
function splitState(raw) {
  const base = raw && typeof raw === 'object' ? raw : {}
  /** @type {{ mood: number, energy: number, bond: number, version: number, createdAt: number, updatedAt: number, lastInteractAt: number, lastProactiveAt: number } | null} */
  let state = null
  /** @type {string[]} */
  const stateProblems = []
  for (const field of ['mood', 'energy', 'bond']) {
    const value = Number(base[field])
    if (!Number.isFinite(value)) stateProblems.push(field + ' 不是有限数')
  }
  if (stateProblems.length === 0) {
    state = {
      version: Number(base.version) || 1,
      mood: Number(base.mood),
      energy: Number(base.energy),
      bond: Number(base.bond),
      createdAt: Number(base.createdAt) || 0,
      updatedAt: Number(base.updatedAt) || 0,
      lastInteractAt: Number(base.lastInteractAt) || 0,
      lastProactiveAt: Number(base.lastProactiveAt) || 0,
    }
  }

  /** @type {Array<{ at: number, kind: string, note: string, delta: Record<string, number> }>} */
  const events = []
  /** @type {Array<{ index: number, reason: string }>} */
  const badEvents = []
  const list = Array.isArray(base.events) ? base.events : []
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    if (!item || typeof item !== 'object') {
      badEvents.push({ index, reason: '不是对象' })
      continue
    }
    const at = Number(item.at)
    if (!Number.isFinite(at) || at <= 0) {
      badEvents.push({ index, reason: 'at 不是有限正数：' + String(item.at) })
      continue
    }
    const kind = typeof item.kind === 'string' ? item.kind.trim() : ''
    if (!kind) {
      badEvents.push({ index, reason: 'kind 为空' })
      continue
    }
    const delta = item.delta && typeof item.delta === 'object' && !Array.isArray(item.delta) ? item.delta : {}
    events.push({
      at,
      kind,
      note: typeof item.note === 'string' ? item.note : '',
      delta,
    })
  }

  return {
    state,
    stateProblems,
    events,
    badEvents,
    rawEventCount: list.length,
  }
}

/* -------------------------------------------------------------------------- */
/* 2. 读主账现状（预演也能预判 already）                                        */
/* -------------------------------------------------------------------------- */

/**
 * @param {any} brain
 */
function readTarget(brain) {
  const out = {
    /** 0007 的两张表是否已建 */
    tablesReady: false,
    schemaVersion: brain.schemaVersion,
    hasState: false,
    /** @type {Set<string>} 已有的 (at, kind) */
    eventKeys: new Set(),
    events: 0,
    error: null,
  }
  try {
    const row = brain.mood.getState()
    out.hasState = row !== null
    const listed = brain.mood.listEvents({ limit: DEDUPE_WINDOW })
    out.events = brain.mood.stats().events
    for (const event of listed.items) out.eventKeys.add(String(event.at) + '|' + String(event.kind))
    out.tablesReady = true
  } catch (error) {
    // 表没建（目标库还停在 0006）时这里会抛 SQLITE_ERROR，这是**预期**的预演状态
    out.error = messageOf(error)
    out.tablesReady = false
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* 3. 主流程                                                                   */
/* -------------------------------------------------------------------------- */

async function main() {
  const report = {
    mode: MODE,
    generatedAt: new Date().toISOString(),
    stateFile: STATE_FILE,
    brainDb: BRAIN_DB,
    sourceSystem: SOURCE_SYSTEM,
  }

  const file = readStateFile()
  if (!file.present) {
    console.error('找不到情感状态文件：' + STATE_FILE)
    console.error('（可用 FOX_MOOD_STATE 或 --state=<path> 指定；没有历史状态就没什么可迁的）')
    process.exitCode = 1
    return
  }
  if (file.error) {
    console.error('读不了情感状态文件：' + STATE_FILE + ' → ' + file.error)
    process.exitCode = 1
    return
  }

  const split = splitState(file.raw)
  report.source = {
    rawEventCount: split.rawEventCount,
    events: split.events.length,
    badEvents: split.badEvents.length,
    badEventSamples: split.badEvents.slice(0, MAX_ERRORS),
    state: split.state
      ? { mood: split.state.mood, energy: split.state.energy, bond: split.state.bond, updatedAt: split.state.updatedAt }
      : null,
    stateProblems: split.stateProblems,
  }

  if (!existsSync(BRAIN_DB)) {
    console.error('找不到目标库：' + BRAIN_DB)
    process.exitCode = 1
    return
  }

  /** @type {any} */
  let brain
  try {
    brain = await withBusyRetry(
      () => openBrain({
        dbPath: BRAIN_DB,
        // 预演用只读连接：不跑迁移、不产生任何写入（CONTRACTS 13.7 的口径）
        readOnly: !APPLY,
      }),
      'openBrain',
    )
  } catch (error) {
    console.error('打开目标库失败：' + messageOf(error))
    process.exitCode = 1
    return
  }

  try {
    report.schemaVersion = brain.schemaVersion
    report.migrationsApplied = brain.migrations?.applied ?? []
    const target = readTarget(brain)
    report.targetBefore = {
      tablesReady: target.tablesReady,
      hasState: target.hasState,
      events: target.events,
      error: target.error,
    }

    /** 事件迁移统计 */
    const stat = { total: split.events.length, created: 0, already: 0, failed: 0 }
    /** @type {Array<{ at: number, kind: string, message: string }>} */
    const failures = []

    /** 状态迁移统计 */
    const stateStat = { planned: split.state !== null, written: false, skippedReason: /** @type {string | null} */ (null) }

    if (!APPLY) {
      // 预演：只按主账现状推数字，一个字节都不写
      for (const event of split.events) {
        if (target.eventKeys.has(String(event.at) + '|' + event.kind)) stat.already += 1
        else stat.created += 1
      }
      if (stateStat.planned) stateStat.skippedReason = '预演模式不写库'
    } else {
      // 真写：先状态、再事件（状态是「此刻」，事件是「为什么」）
      if (split.state) {
        try {
          await withBusyRetry(
            () => brain.mood.saveState({
              ...split.state,
              // saveState 缺省会「用记账时刻」，这里必须**信任 state.json 的演化锚点**，
              // 否则迁完第一次 tick 会从「迁移那一刻」重新积分，把这段精力/心情变化算丢。
              createdAt: split.state.createdAt || undefined,
              updatedAt: split.state.updatedAt || undefined,
            }),
            'mood.saveState',
          )
          stateStat.written = true
        } catch (error) {
          stateStat.skippedReason = messageOf(error)
        }
      }
      for (const event of split.events) {
        try {
          const result = await withBusyRetry(
            () => brain.mood.appendEvent({
              at: event.at,
              kind: event.kind,
              note: event.note,
              delta: event.delta,
              sourceSystem: SOURCE_SYSTEM,
            }),
            'mood.appendEvent ' + event.kind + '@' + event.at,
          )
          if (result.created) stat.created += 1
          else stat.already += 1
        } catch (error) {
          stat.failed += 1
          if (failures.length < MAX_ERRORS) {
            failures.push({ at: event.at, kind: event.kind, message: messageOf(error) })
          }
        }
      }
    }

    report.state = stateStat
    report.events = stat
    report.failures = failures

    const after = readTarget(brain)
    report.targetAfter = { tablesReady: after.tablesReady, hasState: after.hasState, events: after.events }

    console.log(JSON.stringify(report, null, 2))

    console.log('')
    console.log('=== 情感状态迁移（' + (APPLY ? '真写' : '预演') + '）===')
    console.log('数据源：' + STATE_FILE + '（状态 ' + (split.state ? '1 条' : '无/坏') + '，事件 ' + split.rawEventCount + ' 条原始 / ' + split.events.length + ' 条可用）')
    console.log('目标库：' + BRAIN_DB + '（schema ' + String(report.schemaVersion) + (report.migrationsApplied.length ? '，本次应用 ' + report.migrationsApplied.join(',') : '') + '）')
    if (report.migrationsApplied.includes('0007')) {
      console.log('注意：本次顺带应用了 0007 迁移（建出 fox_state / fox_events）。这是 --apply 的正常路径，报告里必须点名。')
    }
    if (!target.tablesReady) {
      console.log('目标库还没建 0007 的两张表：预演的数字是按「全都要新增」推的；--apply 会先应用 0007 再写。')
    }
    console.log('状态   ：' + (stateStat.planned
      ? (APPLY
        ? (stateStat.written ? '写入成功（单行 upsert）' : '写入失败 → ' + String(stateStat.skippedReason))
        : '将写入（单行 upsert，覆盖目标库现有那一行）')
      : '跳过（state.json 里没有可用的 mood/energy/bond' + (split.stateProblems.length ? '：' + split.stateProblems.join('；') : '') + '）'))
    console.log('事件   ：' + stat.total + ' → 新增 ' + stat.created + ' / 已存在 ' + stat.already + ' / 坏条目 ' + split.badEvents.length + ' / 失败 ' + stat.failed)
    if (split.badEvents.length) {
      console.log('坏条目明细（前 ' + MAX_ERRORS + ' 条）：')
      for (const bad of split.badEvents.slice(0, MAX_ERRORS)) console.log('   · events[' + bad.index + '] ← ' + bad.reason)
    }
    if (failures.length) {
      console.log('写入失败明细：')
      for (const bad of failures) console.log('   · ' + bad.kind + '@' + bad.at + ' ← ' + bad.message)
    }
    console.log('目标库：fox_state=' + (after.tablesReady ? (after.hasState ? '有 1 行' : '空') : '未建') + ' / fox_events=' + (after.tablesReady ? after.events + ' 条' : '未建'))
    if (!APPLY) console.log('')
    if (!APPLY) console.log('（预演模式。没有写任何东西。加 --apply 真写。）')
    console.log('SUMMARY mode=' + MODE + ' state_file=' + STATE_FILE + ' state_written=' + (APPLY ? stateStat.written : 'planned:' + stateStat.planned) + ' events_total=' + stat.total + ' events_created=' + stat.created + ' events_already=' + stat.already + ' events_failed=' + stat.failed + ' bad_events=' + split.badEvents.length + ' target.tables=' + (after.tablesReady ? 'ready' : 'missing') + ' target.fox_events=' + (after.tablesReady ? after.events : 'n/a'))
  } finally {
    try {
      await brain.close()
    } catch {
      /* 关闭失败不掩盖主结果 */
    }
  }
}

main().catch((error) => {
  console.error('迁移失败：', error)
  process.exitCode = 1
})
