// @ts-check
/**
 * 修实体 kind 的错标（M6.1）——「观察期把实体过一遍」的执行工具。
 *
 *   node tools/fix-entity-kinds.mjs                           # 预演（默认）：只报告会改什么
 *   node tools/fix-entity-kinds.mjs --apply                   # 真写内置表里的错标
 *   node tools/fix-entity-kinds.mjs --name lead --kind other   # 单条指定（预演）
 *   node tools/fix-entity-kinds.mjs --name lead --kind other --apply
 *
 * 为什么需要它：`entities.upsert` 有一条刻意的「kind 不降级」规则（保护迁移时的具体类型
 * 不被后到的 `other` 打回），代价是**反方向修正改不动**——`person` → `other` 在门面下
 * 无路可走。观察期实测到的错标正是这个方向：Engram 时代把 teammate 代号
 * （`context2` / `connector2` / `console2` / `lead`）当成了 `person`。
 * 与其让人去 `UPDATE entities` 绕过审计，不如给一条带审计的显式入口
 * （门面方法 `entities.updateKind`）。
 *
 * 设计要点（都是有理由的，别随手改）：
 *
 * 1. **默认 dry-run**：预演用 `readOnly: true` 打开，不跑迁移、零写入。
 *    `--apply` 才走 `openBrain()` 真写；**它会自动应用未执行的迁移**（CONTRACTS §13.7），
 *    所以报告里必须点名这件事，否则接手人不知道库是什么时候被什么操作升级的。
 * 2. **内置表只放「明确标错」的**：能确定是错标的才进来，猜的一律不进。
 *    刻意**不含 `小狐狸`**——它是真的 person（Engram 里就是主人的化身），改它才是错的。
 * 3. **不自动备份**：工具只提示备份落点（`data/backups/`），真备份由人决定。
 *    一个「顺手备份」的实现会在库很大时把一条改 4 行 kind 的命令拖成几分钟，
 *    还容易在半途失败后留下「备份有了、数据没改」的不一致。
 * 4. **幂等**：同 kind 再跑一次全部 `changed=false`；门面那边连审计都不写，
 *    重复跑不会在审计表里堆一排空动作。
 * 5. **按 scope 收口**：默认只动 `owner-default` 的实体，`--scope` 显式指定别的 scope。
 *    跨 scope 的「找不到」与「不存在」同形，不确认存在性（CONTRACTS §13.10 口径）。
 * 6. **失败不中断**：逐条 try/catch 最后汇总——一条坏数据不该让剩下的四条都不改。
 * 7. **SQLITE_BUSY 有限重试（≤3）**：生产 `dsh web` 可能正开着 WAL，撞锁退避重试；
 *    三次还不行就如实报错退出，死循环比失败更糟。
 */

import { existsSync } from 'node:fs'
import { ENTITY_KINDS, openBrain } from '../packages/memory/src/index.js'
import { loadMigrations } from '../packages/memory/src/migrator.js'

const BRAIN_DB = 'E:/ds-h/dsh-brain/data/brain.db'
const MIGRATIONS = 'E:/ds-h/dsh-brain/migrations'
/** 默认只动这个 scope（CONTRACTS §2 的 MVP 固定绑定）。 */
const DEFAULT_SCOPE = 'owner-default'
const DEFAULT_PERSON = 'owner'
/** 审计里的 actor：能看出是哪个工具动的手。 */
const DEFAULT_ACTOR = 'tools/fix-entity-kinds.mjs'
const DEFAULT_REASON = '修正上游错标的 kind（Engram 时代把 teammate 代号标成人）'
/** 备份落点（只提示，不自动执行）。 */
const BACKUP_DIR = 'E:/ds-h/dsh-brain/data/backups'

/**
 * 内置的「明确标错」映射。
 *
 * 只收录**能确定是错标**的：这 4 个是 Engram 时代的 teammate 代号，不是人。
 * 刻意不含 `小狐狸`：它是真的 person，把 person→other 用在一个真实体上就是破坏数据。
 * 新条目要么有实测依据、要么有主人指令，别凭「看着像」往上加。
 */
const BUILTIN_FIXES = Object.freeze([
  Object.freeze({ name: 'context2', kind: 'other' }),
  Object.freeze({ name: 'connector2', kind: 'other' }),
  Object.freeze({ name: 'console2', kind: 'other' }),
  Object.freeze({ name: 'lead', kind: 'other' }),
])

/** 名字长度上限（与 packages/memory/src/entities.js 的 MAX_NAME_LENGTH 一致）。 */
const MAX_NAME = 80

const USAGE = `用法：
  node tools/fix-entity-kinds.mjs                            预演（默认，不写库）
  node tools/fix-entity-kinds.mjs --apply                    真写内置表
  node tools/fix-entity-kinds.mjs --name <实体名> --kind <kind> [--apply]
  node tools/fix-entity-kinds.mjs --scope <scopeId>          指定 scope（默认 ${DEFAULT_SCOPE}）
  node tools/fix-entity-kinds.mjs --reason "<为什么改>"       写进审计 detail
  node tools/fix-entity-kinds.mjs --actor "<谁改的>"          写进审计 actor
  可选 kind：${ENTITY_KINDS.join(' | ')}`

const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** 撞锁的 errcode：SQLITE_BUSY(5) / SQLITE_LOCKED(6) 及扩展码 */
const BUSY_CODES = new Set([5, 6, 517, 518, 261, 262])
/** @param {any} error */
function isBusy(error) {
  if (!error) return false
  const code = Number(error.errcode)
  if (BUSY_CODES.has(code)) return true
  return /SQLITE_BUSY|SQLITE_LOCKED|database (table )?is locked/i.test(messageOf(error))
}
/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 有限重试：只对撞锁重试，业务错误（INVALID_ARGUMENT / NOT_FOUND / CONFLICT）直接抛。
 * 最多 3 次，退避 250 / 1000 / 2250ms。
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
      console.warn(`[busy] ${label} 第 ${attempt} 次撞锁，${wait}ms 后重试`)
      await sleep(wait)
    }
  }
  throw lastError
}

/* -------------------------------------------------------------------------- */
/* 1. 参数                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} Args
 * @property {boolean} apply
 * @property {boolean} help
 * @property {string | null} name
 * @property {string | null} kind
 * @property {string} scopeId
 * @property {string} actor
 * @property {string} reason
 */

/**
 * @param {string[]} argv
 * @returns {Args}
 */
function parseArgs(argv) {
  /** @type {Args} */
  const out = {
    apply: false,
    help: false,
    name: null,
    kind: null,
    scopeId: DEFAULT_SCOPE,
    actor: DEFAULT_ACTOR,
    reason: DEFAULT_REASON,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    /** @param {string} label */
    const take = (label) => {
      const value = argv[i + 1]
      // `--name --kind` 这种漏值要当场拦下，而不是把 '--kind' 当成实体名
      if (value === undefined || value.startsWith('--')) throw new Error(`${label} 缺一个值`)
      i += 1
      return value
    }
    if (arg === '--apply') out.apply = true
    else if (arg === '--name') out.name = take('--name')
    else if (arg === '--kind') out.kind = take('--kind')
    else if (arg === '--scope') out.scopeId = take('--scope')
    else if (arg === '--actor') out.actor = take('--actor')
    else if (arg === '--reason') out.reason = take('--reason')
    else if (arg === '--help' || arg === '-h') out.help = true
    else throw new Error(`不认识的参数：${arg}（--help 看用法）`)
  }

  // 单条模式必须成对出现：只给名字不知道要改成什么，只给 kind 不知道该改谁
  if ((out.name === null) !== (out.kind === null)) {
    throw new Error('--name 与 --kind 必须同时给（单条模式）')
  }
  if (out.name !== null) {
    const name = out.name.trim()
    if (name.length === 0) throw new Error('--name 不能为空')
    if (name.length > MAX_NAME) throw new Error(`--name 太长（${name.length} > ${MAX_NAME}）`)
    out.name = name
  }
  if (out.kind !== null && !/** @type {any} */ (ENTITY_KINDS).includes(out.kind)) {
    throw new Error(`--kind 取值非法：${out.kind}（可选 ${ENTITY_KINDS.join(' | ')}）`)
  }
  if (out.scopeId.trim().length === 0) throw new Error('--scope 不能为空')
  return out
}

/* -------------------------------------------------------------------------- */
/* 2. 计划（纯逻辑，不碰库）                                                    */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {Object} FixPlan
 * @property {string} name
 * @property {string} kind 目标 kind
 * @property {string} source 'builtin' | 'cli'
 */

/**
 * @param {Args} args
 * @returns {FixPlan[]}
 */
function buildPlan(args) {
  if (args.name !== null && args.kind !== null) {
    return [{ name: args.name, kind: args.kind, source: 'cli' }]
  }
  return BUILTIN_FIXES.map((fix) => ({ name: fix.name, kind: fix.kind, source: 'builtin' }))
}

/* -------------------------------------------------------------------------- */
/* 3. 主流程                                                                   */
/* -------------------------------------------------------------------------- */

const pct = (part, total) => (total === 0 ? '0%' : `${((part / total) * 100).toFixed(1)}%`)

async function main() {
  /** @type {Args} */
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`参数错误：${messageOf(error)}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  if (args.help) {
    console.log(USAGE)
    return
  }

  const APPLY = args.apply
  const MODE = APPLY ? 'apply' : 'dry-run'

  if (!existsSync(BRAIN_DB)) {
    console.error(`找不到主账：${BRAIN_DB}`)
    process.exitCode = 1
    return
  }

  const plan = buildPlan(args)

  /** @type {any} */
  let brain
  try {
    brain = await withBusyRetry(
      () => openBrain({
        dbPath: BRAIN_DB,
        migrationsDir: MIGRATIONS,
        // 预演用只读连接：不跑迁移、不产生任何写入（CONTRACTS §13.7 的硬要求）
        readOnly: !APPLY,
        bindings: { scope_id: args.scopeId, person_id: DEFAULT_PERSON },
      }),
      'openBrain',
    )
  } catch (error) {
    console.error('打开主账失败：', messageOf(error))
    process.exitCode = 1
    return
  }

  /** 磁盘上最后一版迁移：用来判断 --apply 会不会顺手升级 schema */
  const diskVersions = loadMigrations(MIGRATIONS).map((file) => file.version)
  const diskLatest = diskVersions[diskVersions.length - 1] ?? null
  const willMigrate = diskLatest !== null && brain.schemaVersion !== diskLatest

  const report = {
    mode: MODE,
    generatedAt: new Date().toISOString(),
    brainDb: BRAIN_DB,
    scopeId: args.scopeId,
    schemaVersion: brain.schemaVersion,
    diskLatestMigration: diskLatest,
    applyWillMigrate: willMigrate,
    migrationsAppliedByThisRun: /** @type {string[]} */ (brain.migrations?.applied ?? []),
    backupDir: BACKUP_DIR,
    backupExists: existsSync(BACKUP_DIR),
    planSource: plan[0]?.source ?? 'builtin',
    actor: args.actor,
    reason: args.reason,
    // 结果按计划顺序逐条记，便于人工核对「打算改的」和「实际改的」是不是同一批
    items: /** @type {any[]} */ ([]),
    missing: /** @type {any[]} */ ([]),
    errors: /** @type {any[]} */ ([]),
    summary: { planned: 0, changed: 0, already: 0, missing: 0, failed: 0 },
  }

  try {
    // list 只返回 active 实体（含未删记忆数），单次取全量：117 个实体远小于上限
    const snapshot = brain.entities.list({ scopeId: args.scopeId, limit: 1000 }).items
    /** @type {Map<string, any>} */
    const byName = new Map(snapshot.map((entity) => [String(entity.name), entity]))

    for (const fix of plan) {
      const entity = byName.get(fix.name)
      if (entity === undefined) {
        // 找不到 ≠ 失败：可能已被改过、被合并、或根本不在这个 scope。
        // 如实报出来，但不替人猜「它是不是改名了」。
        report.missing.push({ name: fix.name, kind: fix.kind, reason: '当前 scope 内没有这个 active 实体（可能已合并/删除，或 --scope 不对）' })
        continue
      }
      /** @type {any} */
      const item = {
        name: entity.name,
        id: entity.id,
        previousKind: entity.kind,
        kind: fix.kind,
        memoryCount: entity.memoryCount,
      }

      if (entity.kind === fix.kind) {
        item.action = 'already'
        report.items.push(item)
        continue
      }

      if (!APPLY) {
        // 预演：只算，不写。这一支绝不能出现 await 写操作。
        item.action = 'would-change'
        report.items.push(item)
        continue
      }

      try {
        const result = await withBusyRetry(
          () => brain.entities.updateKind(entity.id, fix.kind, {
            scopeId: args.scopeId,
            changedBy: args.actor,
            reason: args.reason,
          }),
          `entities.updateKind ${fix.name}`,
        )
        item.action = result.changed ? 'changed' : 'already'
        // 以门面返回的 previousKind 为准（快照到写入之间可能已被别人改过）
        item.previousKind = result.previousKind
        report.items.push(item)
      } catch (error) {
        item.action = 'failed'
        item.error = messageOf(error)
        report.items.push(item)
        report.errors.push({ name: fix.name, id: entity.id, message: messageOf(error) })
      }
    }

    for (const item of report.items) {
      if (item.action === 'would-change' || item.action === 'changed') report.summary.changed += 1
      else if (item.action === 'already') report.summary.already += 1
      else if (item.action === 'failed') report.summary.failed += 1
    }
    report.summary.planned = plan.length
    report.summary.missing = report.missing.length

    console.log(JSON.stringify(report, null, 2))

    /* ------------------------------ 人读摘要 ------------------------------ */
    console.log(`\n=== 实体 kind 修正（${APPLY ? '真写' : '预演'}）===`)
    console.log(`库：${BRAIN_DB}（schema ${brain.schemaVersion}${report.migrationsAppliedByThisRun.length ? '，本次应用 ' + report.migrationsAppliedByThisRun.join(',') : ''}）`)
    console.log(`scope：${args.scopeId}；计划来源：${report.planSource === 'cli' ? `--name/--kind 单条指定（${plan[0]?.name} → ${plan[0]?.kind}）` : '内置「明确标错」表'}；审计 actor：${args.actor}`)

    if (report.items.length > 0) {
      console.log('\n实体清单（旧 kind → 新 kind，挂记忆数）：')
      for (const item of report.items) {
        const label = item.action === 'would-change' ? '会改'
          : item.action === 'changed' ? '已改'
            : item.action === 'already' ? '已是目标，跳过'
              : `失败：${item.error}`
        console.log(`  · ${String(item.name).padEnd(14)} ${String(item.previousKind).padEnd(8)} → ${String(item.kind).padEnd(8)} 挂 ${item.memoryCount} 条记忆  ${label}`)
      }
    }
    if (report.missing.length > 0) {
      console.log('\n没找到（不当失败；可能已合并/删除，或 --scope 不对）：')
      for (const miss of report.missing) console.log(`  · ${miss.name} → ${miss.kind}：${miss.reason}`)
    }
    if (report.errors.length > 0) {
      console.log('\n失败明细：')
      for (const err of report.errors) console.log(`  · ${err.name}（${err.id}）：${err.message}`)
    }

    // CONTRACTS §13.7 的硬要求：会不会顺手升级 schema，必须点名
    console.log(
      willMigrate
        ? `\n如 --apply 会顺手应用未执行迁移：${brain.schemaVersion} → ${diskLatest}（走 openBrain() 的自动迁移，属于附带动作，必须在记录里写明）。`
        : `\n如 --apply 会顺手应用未执行迁移：不会——当前库已是最新 ${brain.schemaVersion}，磁盘没有更新的迁移。`,
    )

    if (!APPLY) {
      console.log('本次不会写库：预演用 readOnly 连接打开（不跑迁移），一条 UPDATE/审计都没落。加 --apply 才真写。')
    } else {
      console.log(`真写完成：改 ${report.summary.changed} 条 / 已是目标 ${report.summary.already} 条 / 失败 ${report.summary.failed} 条 / 找不到 ${report.summary.missing} 条。每条改动在 audit_logs 留了 action='entities.updateKind' 的痕。`)
    }
    console.log(`备份提示：真写前后请把 ${BRAIN_DB} 备到 ${BACKUP_DIR}（本工具不自动备份；库里 ${report.backupExists ? '已有该目录' : '还没有该目录'}）。`)

    console.log(
      `SUMMARY mode=${MODE} scope=${args.scopeId} schema=${brain.schemaVersion} planned=${report.summary.planned} `
      + `would_change_or_changed=${report.summary.changed} already=${report.summary.already} `
      + `missing=${report.summary.missing} failed=${report.summary.failed} `
      + `apply_will_migrate=${willMigrate} audit_actor=${args.actor} coverage=${pct(report.summary.changed + report.summary.already, plan.length)}`,
    )

    // 单条模式明确要求改某个实体却找不到 → 这是真错误（不是「无事可做」）
    if (report.planSource === 'cli' && report.missing.length > 0) {
      console.error(`\n--name ${plan[0]?.name} 在 scope ${args.scopeId} 里找不到，退出码 1（单条模式不让「找不到」静默通过）。`)
      process.exitCode = 1
    }
    if (report.summary.failed > 0) process.exitCode = 1
  } finally {
    try { await brain.close() } catch { /* 关闭失败不掩盖主结果 */ }
  }
}

main().catch((error) => {
  console.error('修正实体 kind 失败：', error)
  process.exitCode = 1
})
