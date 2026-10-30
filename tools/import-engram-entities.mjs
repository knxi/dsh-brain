// @ts-check
/**
 * 把 Engram 的**实体 / 记忆-实体关联 / 记忆间关系边**迁进外置大脑（M6）。
 *
 *   node tools/import-engram-entities.mjs            # 预演：只报告会写什么（不碰目标库）
 *   node tools/import-engram-entities.mjs --apply    # 真写
 *
 * 与 `tools/import-engram.mjs`（迁记忆正文）是配套的第二步：那一步已经把 Engram 的
 * nodes / facts 搬成了 memories，并在 `source_refs` 里留了
 *   source_system='engram', source_event_id='engram:<库文件名>:node:<engram-node-id>'
 * 这一步靠这条线索把「Engram 的 node_id」反解成「我们的 memory_id」——**只反解，不猜**。
 * 映射不上的关联/边一律跳过并计数，绝不编造 memory_id 硬挂。
 *
 * 设计要点（都是有理由的，别随手改）：
 *
 * 1. **默认 dry-run**：预演不打开写连接（readOnly），不跑迁移、不产生任何写入。
 *    `--apply` 才 openBrain 真写；那时若目标库还停在 0005，会自动应用 0006 建表
 *    （这是 M6 上线的正常路径，报告里会点名）。
 * 2. **Engram 目录只读**：三个 Engram 库全部 `readOnly: true` 打开，只 SELECT。
 *    这不是「尽量」，是红线——不迁移、不改写别人的库。
 * 3. **kind 只认白名单**：实体 kind 非 person/project/tool/concept/other 的一律落 `other`；
 *    关系边 kind 非 supersedes/contradicts/supports/refines 的跳过计数（塞进去会被
 *    CHECK 约束拒掉，还不如自己拦下来讲清楚）。
 * 4. **幂等靠门面的唯一约束**：`(scope_id,name)` 唯一、`(memory_id,entity_id)` 主键、
 *    `(from,to,kind)` 唯一。连跑两次第二次应该全是 `already / unchanged`。
 * 5. **失败不中断**：逐条 try/catch，最后汇总；一条坏数据不该让整次迁移停摆。
 * 6. **SQLITE_BUSY 有限重试（≤3）**：生产 `dsh web` 可能正开着 WAL。撞锁就退避重试，
 *    三次还不行就如实报错退出——死循环比失败更糟。
 *
 * 迁移范围（实测，2026-10-29）：
 *   user.db 19 实体 / 23 关联 / 0 边；project-7022… 99 / 201 / 8；project-3b92… 5 / 5 / 0
 *   合计 123 实体（117 个唯一名）、229 条关联、8 条边（7 contradicts + 1 supersedes）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ENTITY_KINDS, MEMORY_EDGE_KINDS, openBrain } from '../packages/memory/src/index.js'

const ENGRAM_DIR = 'C:/Users/su/.dsh/engram'
const BRAIN_DB = 'E:/ds-h/dsh-brain/data/brain.db'
const MIGRATIONS = 'E:/ds-h/dsh-brain/migrations'
const SCOPE_ID = 'owner-default'
const PERSON_ID = 'owner'

/** 与 packages/memory/src/entities.js 的上限保持一致（预检用） */
const MAX_NAME = 80
const MAX_ALIASES = 20
/** 迁来的关系边统一带这句原因，方便日后从边表反查是不是迁移产物 */
const EDGE_REASON = '来自 Engram 迁移'
/** 报告里最多保留多少条失败/未映射明细 */
const MAX_SAMPLES = 5
const MAX_ERRORS = 10
/** source_refs 的 id 形状：engram:<库文件名>:node|fact:<engram 节点 id> */
const SOURCE_REF_RE = /^engram:(.+):(node|fact):(.+)$/

const APPLY = process.argv.includes('--apply')
const MODE = APPLY ? 'apply' : 'dry-run'

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
/* 1. 读 Engram（只读）                                                        */
/* -------------------------------------------------------------------------- */

function listEngramFiles() {
  if (!existsSync(ENGRAM_DIR)) return []
  return readdirSync(ENGRAM_DIR)
    .filter((f) => f.endsWith('.db'))
    .sort()
}

/**
 * @typedef {Object} EngramData
 * @property {string[]} files
 * @property {{ file: string, entities?: number, nodeEntities?: number, edges?: number, error?: string }[]} databases
 * @property {{ file: string, engramId: string, name: string, kind: string, aliasesJson: unknown }[]} entities
 * @property {{ file: string, nodeId: string, engramEntityId: string }[]} nodeEntities
 * @property {{ file: string, seq: number, fromId: string, toId: string, type: string }[]} edges
 */

/** @returns {EngramData} */
function readEngram() {
  /** @type {EngramData} */
  const out = { files: [], databases: [], entities: [], nodeEntities: [], edges: [] }
  out.files = listEngramFiles()
  for (const file of out.files) {
    /** @type {import('node:sqlite').DatabaseSync | null} */
    let db = null
    try {
      db = new DatabaseSync(join(ENGRAM_DIR, file), { readOnly: true })
    } catch (error) {
      out.databases.push({ file, error: messageOf(error) })
      continue
    }
    /** @param {string} sql */
    const all = (sql) => {
      try { return db.prepare(sql).all() } catch { return null }
    }
    const ents = all('SELECT id, name, kind, aliases_json FROM entities') ?? []
    const nes = all('SELECT node_id, entity_id FROM node_entities') ?? []
    // edges 是复合主键、没有自增 id；用 rowid 排序给 sourceRef 一个稳定序号
    const eds = all('SELECT rowid AS rid, from_id, to_id, type FROM edges ORDER BY rowid')
      ?? all('SELECT from_id, to_id, type FROM edges')
      ?? []

    for (const row of ents) {
      out.entities.push({
        file,
        engramId: String(row.id),
        name: String(row.name ?? ''),
        kind: String(row.kind ?? ''),
        aliasesJson: row.aliases_json,
      })
    }
    for (const row of nes) {
      out.nodeEntities.push({ file, nodeId: String(row.node_id), engramEntityId: String(row.entity_id) })
    }
    for (const [index, row] of eds.entries()) {
      out.edges.push({
        file,
        seq: index + 1,
        fromId: String(row.from_id),
        toId: String(row.to_id),
        type: String(row.type),
      })
    }
    out.databases.push({ file, entities: ents.length, nodeEntities: nes.length, edges: eds.length })
    db.close()
  }
  return out
}

/* -------------------------------------------------------------------------- */
/* 2. 读目标库现状（镜像；dry-run 也要能看出「已存在」）                        */
/* -------------------------------------------------------------------------- */

/**
 * @param {import('node:sqlite').DatabaseSync} db
 */
function readTargetMirror(db) {
  /** @param {string} sql */
  const all = (sql) => {
    try { return db.prepare(sql).all() } catch { return null }
  }

  const sourceRefs = all("SELECT memory_id, source_event_id FROM source_refs WHERE source_system = 'engram'") ?? []
  const memoryRows = all('SELECT id, status FROM memories') ?? []
  // 三张 M6 表可能还不存在（目标库停在 0005）——null 就是「没建」，不是「空的」
  const entityRows = all('SELECT id, name, kind, aliases, importance FROM entities')
  const linkRows = all('SELECT memory_id, entity_id FROM memory_entities')
  const edgeRows = all('SELECT from_memory_id, to_memory_id, kind FROM memory_edges')

  /** @type {Map<string, string>} */
  const nodeRefs = new Map()
  /** @type {Map<string, string>} */
  const factRefs = new Map()
  let refRegexMiss = 0
  for (const row of sourceRefs) {
    const match = SOURCE_REF_RE.exec(String(row.source_event_id ?? ''))
    if (!match) { refRegexMiss += 1; continue }
    const key = `${match[1]}:${match[3]}`
    if (match[2] === 'node') nodeRefs.set(key, String(row.memory_id))
    else factRefs.set(key, String(row.memory_id))
  }

  /** @type {Map<string, string>} memory_id -> status */
  const memoryStatus = new Map()
  for (const row of memoryRows) memoryStatus.set(String(row.id), String(row.status))

  /** @type {Map<string, { id: string | null, kind: string, aliases: string[], importance: number }>} */
  const entityByName = new Map()
  for (const row of entityRows ?? []) {
    entityByName.set(String(row.name), {
      id: String(row.id),
      kind: String(row.kind),
      aliases: normalizeAliases(parseAliases(row.aliases).list),
      importance: Number(row.importance) || 0.5,
    })
  }

  /** @type {Set<string>} 已有的 (memory_id|entity_id) 对 */
  const linkPairs = new Set()
  for (const row of linkRows ?? []) linkPairs.add(`${row.memory_id}|${row.entity_id}`)

  /** @type {Set<string>} 已有的 (from|to|kind) 三元组 */
  const edgeTriples = new Set()
  for (const row of edgeRows ?? []) {
    edgeTriples.add(`${row.from_memory_id}|${row.to_memory_id}|${row.kind}`)
  }

  return {
    sourceRefCount: sourceRefs.length,
    refRegexMiss,
    nodeRefs,
    factRefs,
    memoryStatus,
    entityByName,
    linkPairs,
    edgeTriples,
    /** 三张 M6 表是否已建（决定 dry-run 能不能精确预判） */
    tablesReady: entityRows !== null && linkRows !== null && edgeRows !== null,
    entityCount: entityRows === null ? null : entityRows.length,
    linkCount: linkRows === null ? null : linkRows.length,
    edgeCount: edgeRows === null ? null : edgeRows.length,
  }
}

/* -------------------------------------------------------------------------- */
/* 3. 小工具                                                                   */
/* -------------------------------------------------------------------------- */

/** 名字规范化，规则与 entities.js 的 normalizeName 一致（提前做为了单独统计被拒的行） */
function normalizeName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (name.length === 0) return { ok: false, reason: 'name 为空' }
  if (name.length > MAX_NAME) return { ok: false, reason: `name 超长（${name.length} > ${MAX_NAME}）` }
  return { ok: true, name }
}

/** 解析 Engram 的 aliases_json。脏数据当空数组，不炸。 */
function parseAliases(raw) {
  if (raw === null || raw === undefined) return { list: /** @type {string[]} */ ([]), bad: false }
  try {
    const parsed = JSON.parse(String(raw))
    if (!Array.isArray(parsed)) return { list: /** @type {string[]} */ ([]), bad: true }
    return { list: parsed.filter((v) => typeof v === 'string'), bad: false }
  } catch {
    return { list: /** @type {string[]} */ ([]), bad: true }
  }
}

/** 别名规范化：压空白、去空、小写去重、上限 20（照 entities.js） */
function normalizeAliases(list) {
  /** @type {string[]} */
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== 'string') continue
    const value = item.replace(/\s+/g, ' ').trim()
    if (value.length === 0 || value.length > MAX_NAME) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= MAX_ALIASES) break
  }
  return out
}

/** 把 Engram 的 kind 收进白名单，不在就落 other（不丢实体、不硬塞） */
function safeEntityKind(raw) {
  const kind = String(raw ?? '')
  return /** @type {any} */ (ENTITY_KINDS).includes(kind) ? kind : 'other'
}

/** 把 Engram 的边类型收进白名单；非法返回 null 让调用方计数跳过 */
function safeEdgeKind(raw) {
  const kind = String(raw ?? '')
  return /** @type {any} */ (MEMORY_EDGE_KINDS).includes(kind) ? kind : null
}

/**
 * 预演用的「假 upsert」：合并规则与 entities.js 一致（kind 不降级、aliases 并集）。
 * 只算统计，不产生任何写入。
 */
function previewUpsert(byName, input) {
  const current = byName.get(input.name)
  if (current === undefined) {
    byName.set(input.name, {
      id: null, // 新实体还没有真 id —— 新增的关联一定也是新增
      kind: input.kind,
      aliases: normalizeAliases(input.aliases),
      importance: 0.5,
    })
    return { created: true, changed: false, id: null }
  }
  const nextKind = current.kind === 'other' && input.kind !== 'other' ? input.kind : current.kind
  const nextAliases = normalizeAliases([...current.aliases, ...input.aliases])
  const changed = nextKind !== current.kind
    || JSON.stringify(nextAliases) !== JSON.stringify(current.aliases)
  byName.set(input.name, { ...current, kind: nextKind, aliases: nextAliases })
  return { created: false, changed, id: current.id }
}

/* -------------------------------------------------------------------------- */
/* 4. 三个迁移阶段                                                             */
/* -------------------------------------------------------------------------- */

/** @param {Map<string, any>} byEngram */
function pushSample(list, item) {
  if (list.length < MAX_SAMPLES) list.push(item)
  return list
}

/**
 * 阶段一：实体。
 * @param {any} brain
 * @param {ReturnType<typeof readTargetMirror>} mirror
 * @param {EngramData} data
 */
async function importEntities(brain, mirror, data) {
  const stat = { total: 0, created: 0, merged: 0, unchanged: 0, invalidName: 0, kindFallback: 0, badAliases: 0, failed: 0 }
  /** @type {{ file: string, name: string, reason: string }[]} */
  const invalidSamples = []
  /** @type {{ ref: string, message: string }[]} */
  const errors = []
  /** @type {Map<string, string | null>} '<file>:<engramEntityId>' -> 我们库的实体 id（预演时新实体为 null） */
  const byEngram = new Map()

  for (const row of data.entities) {
    stat.total += 1
    const normalized = normalizeName(row.name)
    if (!normalized.ok) {
      stat.invalidName += 1
      pushSample(invalidSamples, { file: row.file, name: row.name.slice(0, 40), reason: normalized.reason })
      continue
    }
    const aliases = parseAliases(row.aliasesJson)
    if (aliases.bad) stat.badAliases += 1
    if (!/** @type {any} */ (ENTITY_KINDS).includes(row.kind)) stat.kindFallback += 1
    const kind = safeEntityKind(row.kind)
    const sourceRef = `engram:${row.file}:entity:${row.engramId}`
    const key = `${row.file}:${row.engramId}`

    if (!APPLY) {
      const preview = previewUpsert(mirror.entityByName, { name: normalized.name, kind, aliases: aliases.list })
      if (preview.created) stat.created += 1
      else if (preview.changed) stat.merged += 1
      else stat.unchanged += 1
      byEngram.set(key, preview.id)
      continue
    }

    try {
      const result = await withBusyRetry(
        () => brain.entities.upsert({
          name: normalized.name,
          kind,
          aliases: aliases.list,
          sourceSystem: 'engram',
          sourceRef,
        }),
        `entities.upsert ${key}`,
      )
      if (result.created) stat.created += 1
      else if (result.updated) stat.merged += 1
      else stat.unchanged += 1
      byEngram.set(key, String(result.id))
    } catch (error) {
      stat.failed += 1
      if (errors.length < MAX_ERRORS) errors.push({ ref: sourceRef, message: messageOf(error) })
    }
  }

  return { stat, byEngram, invalidSamples, errors }
}

/**
 * 阶段二：记忆 ↔ 实体关联。
 * @param {any} brain
 * @param {ReturnType<typeof readTargetMirror>} mirror
 * @param {EngramData} data
 * @param {Map<string, string | null>} byEngram
 */
async function importLinks(brain, mirror, data, byEngram) {
  const stat = { total: 0, linked: 0, already: 0, unmappedMemory: 0, unmappedEntity: 0, deletedMemory: 0, failed: 0 }
  /** @type {{ file: string, nodeId: string, entityId: string, reason: string }[]} */
  const unmappedSamples = []
  /** @type {{ ref: string, message: string }[]} */
  const errors = []

  /** @param {string} file @param {string} nodeId */
  const resolveMemoryId = (file, nodeId) => {
    const key = `${file}:${nodeId}`
    return mirror.nodeRefs.get(key) ?? mirror.factRefs.get(key) ?? null
  }

  for (const row of data.nodeEntities) {
    stat.total += 1
    const sample = { file: row.file, nodeId: row.nodeId, entityId: row.engramEntityId, reason: '' }

    const memoryId = resolveMemoryId(row.file, row.nodeId)
    if (memoryId === null) {
      stat.unmappedMemory += 1
      sample.reason = 'source_refs 里没有这条 node（当初正文没迁或已删）'
      pushSample(unmappedSamples, sample)
      continue
    }
    // byEngram 里没有 = 该实体 upsert 失败或被 name 预检拒了，不许挂
    if (!byEngram.has(`${row.file}:${row.engramEntityId}`)) {
      stat.unmappedEntity += 1
      sample.reason = '实体没有成功写入（上一阶段失败/被拒）'
      pushSample(unmappedSamples, sample)
      continue
    }
    const entityId = byEngram.get(`${row.file}:${row.engramEntityId}`) ?? null
    if (mirror.memoryStatus.get(memoryId) === 'deleted') {
      stat.deletedMemory += 1
      sample.reason = '目标记忆已删除（门面会拒，直接跳过）'
      pushSample(unmappedSamples, sample)
      continue
    }

    if (!APPLY) {
      // 实体是本次新建（还没有 id）→ 关联必然新增；否则按镜像里的已有配对判断
      const already = entityId !== null && mirror.linkPairs.has(`${memoryId}|${entityId}`)
      if (already) stat.already += 1
      else stat.linked += 1
      if (entityId !== null) mirror.linkPairs.add(`${memoryId}|${entityId}`)
      continue
    }

    try {
      const result = await withBusyRetry(
        () => brain.entities.linkMemory(memoryId, /** @type {string} */ (entityId)),
        `entities.linkMemory ${row.file}/${row.nodeId.slice(0, 8)}`,
      )
      if (result.linked) stat.linked += 1
      else stat.already += 1
    } catch (error) {
      // 极端情况：两次读之间记忆被删了 → CONFLICT。当「已删」计，不当失败。
      if (/已删除/.test(messageOf(error))) {
        stat.deletedMemory += 1
        continue
      }
      stat.failed += 1
      if (errors.length < MAX_ERRORS) {
        errors.push({ ref: `${row.file}:node_entities:${row.nodeId}/${row.engramEntityId}`, message: messageOf(error) })
      }
    }
  }

  return { stat, unmappedSamples, errors }
}

/**
 * 阶段三：记忆间关系边。
 * @param {any} brain
 * @param {ReturnType<typeof readTargetMirror>} mirror
 * @param {EngramData} data
 */
async function importEdges(brain, mirror, data) {
  const stat = { total: 0, created: 0, already: 0, unmappedEndpoint: 0, selfLoop: 0, invalidKind: 0, deletedMemory: 0, failed: 0 }
  /** @type {{ file: string, seq: number, type: string, fromId: string, toId: string, reason: string }[]} */
  const unmappedSamples = []
  /** @type {{ ref: string, message: string }[]} */
  const errors = []

  /** @param {string} file @param {string} nodeId */
  const resolveMemoryId = (file, nodeId) => {
    const key = `${file}:${nodeId}`
    return mirror.nodeRefs.get(key) ?? mirror.factRefs.get(key) ?? null
  }

  for (const row of data.edges) {
    stat.total += 1
    const sample = { file: row.file, seq: row.seq, type: row.type, fromId: row.fromId, toId: row.toId, reason: '' }

    const kind = safeEdgeKind(row.type)
    if (kind === null) {
      stat.invalidKind += 1
      sample.reason = `kind 不在白名单：${row.type}`
      pushSample(unmappedSamples, sample)
      continue
    }

    const fromMemoryId = resolveMemoryId(row.file, row.fromId)
    const toMemoryId = resolveMemoryId(row.file, row.toId)
    if (fromMemoryId === null || toMemoryId === null) {
      stat.unmappedEndpoint += 1
      const loopNote = row.fromId === row.toId ? '；且 Engram 侧两端 id 相同（本条本身就是自环）' : ''
      sample.reason = `端点映射失败（from=${fromMemoryId === null ? '缺失' : 'ok'}, to=${toMemoryId === null ? '缺失' : 'ok'}）${loopNote}`
      pushSample(unmappedSamples, sample)
      continue
    }
    // 自环：门面会抛 INVALID_ARGUMENT（CHECK 也拦）。自己先拦下来，报清楚而不是报"失败"
    if (fromMemoryId === toMemoryId) {
      stat.selfLoop += 1
      sample.reason = '两端解析到同一条记忆（Engram 里的自环边），无意义'
      pushSample(unmappedSamples, sample)
      continue
    }
    if (mirror.memoryStatus.get(fromMemoryId) === 'deleted' || mirror.memoryStatus.get(toMemoryId) === 'deleted') {
      stat.deletedMemory += 1
      sample.reason = '端点记忆已删除'
      pushSample(unmappedSamples, sample)
      continue
    }

    const sourceRef = `engram:${row.file}:edge:${row.seq}`

    if (!APPLY) {
      const key = `${fromMemoryId}|${toMemoryId}|${kind}`
      if (mirror.edgeTriples.has(key)) stat.already += 1
      else { stat.created += 1; mirror.edgeTriples.add(key) }
      continue
    }

    try {
      const result = await withBusyRetry(
        () => brain.memoryEdges.link({
          fromMemoryId,
          toMemoryId,
          kind,
          reason: EDGE_REASON,
          sourceSystem: 'engram',
          sourceRef,
        }),
        `memoryEdges.link ${sourceRef}`,
      )
      if (result.created) stat.created += 1
      else stat.already += 1
    } catch (error) {
      if (/已删除/.test(messageOf(error))) {
        stat.deletedMemory += 1
        continue
      }
      stat.failed += 1
      if (errors.length < MAX_ERRORS) errors.push({ ref: sourceRef, message: messageOf(error) })
    }
  }

  return { stat, unmappedSamples, errors }
}

/* -------------------------------------------------------------------------- */
/* 5. 目标库统计（只读）                                                       */
/* -------------------------------------------------------------------------- */

/** @param {any} brain */
function readTargetCounts(brain) {
  /** @param {string} sql */
  const one = (sql) => {
    try { return brain.db.prepare(sql).get() } catch { return null }
  }
  /** @param {string} sql */
  const many = (sql) => {
    try { return brain.db.prepare(sql).all() } catch { return null }
  }
  const entities = one('SELECT count(*) c FROM entities')
  const memoryEntities = one('SELECT count(*) c FROM memory_entities')
  const memoryEdges = one('SELECT count(*) c FROM memory_edges')
  return {
    entities: entities === null ? null : Number(entities.c),
    memoryEntities: memoryEntities === null ? null : Number(memoryEntities.c),
    memoryEdges: memoryEdges === null ? null : Number(memoryEdges.c),
    entitiesByKind: many('SELECT kind, count(*) c FROM entities GROUP BY kind ORDER BY c DESC'),
    edgesByKind: many('SELECT kind, count(*) c FROM memory_edges GROUP BY kind ORDER BY c DESC'),
  }
}

/* -------------------------------------------------------------------------- */
/* 6. 主流程                                                                   */
/* -------------------------------------------------------------------------- */

const pct = (part, total) => (total === 0 ? '0%' : `${((part / total) * 100).toFixed(1)}%`)

async function main() {
  if (!existsSync(ENGRAM_DIR)) {
    console.error(`找不到 Engram 目录：${ENGRAM_DIR}`)
    process.exitCode = 1
    return
  }
  if (!existsSync(BRAIN_DB)) {
    console.error(`找不到目标库：${BRAIN_DB}`)
    process.exitCode = 1
    return
  }

  const data = readEngram()
  if (data.databases.length === 0) {
    console.error('Engram 目录里没有可读的 .db')
    process.exitCode = 1
    return
  }

  /** @type {any} */
  let brain
  try {
    brain = await withBusyRetry(
      () => openBrain({
        dbPath: BRAIN_DB,
        migrationsDir: MIGRATIONS,
        // 预演用只读连接：不跑迁移、不产生任何写入
        readOnly: !APPLY,
        bindings: { scope_id: SCOPE_ID, person_id: PERSON_ID },
      }),
      'openBrain',
    )
  } catch (error) {
    console.error('打开目标库失败：', messageOf(error))
    process.exitCode = 1
    return
  }

  const report = {
    mode: MODE,
    generatedAt: new Date().toISOString(),
    engramDir: ENGRAM_DIR,
    brainDb: BRAIN_DB,
    schemaVersion: brain.schemaVersion,
    migrationsApplied: (brain.migrations?.applied ?? []),
    source: {
      databases: [],
      totals: {
        entities: data.entities.length,
        nodeEntities: data.nodeEntities.length,
        edges: data.edges.length,
      },
    },
  }

  try {
    const mirror = readTargetMirror(brain.db)
    // Engram 目录里还有几个完全没有实体/关联/边的库（shared.db 等），
    // 列进数据源只会让人误以为有五六个来源。只报有数据的，其余记「扫描过但为空」。
    const withData = data.databases.filter((d) => (d.entities ?? 0) + (d.nodeEntities ?? 0) + (d.edges ?? 0) > 0)
    report.source.databases = withData
    report.source.emptyDatabases = data.databases
      .filter((d) => !withData.includes(d))
      .map((d) => d.file)
    report.targetBefore = {
      sourceRefs: mirror.sourceRefCount,
      sourceRefRegexMiss: mirror.refRegexMiss,
      memoryRefs: { node: mirror.nodeRefs.size, fact: mirror.factRefs.size },
      m6TablesReady: mirror.tablesReady,
      entities: mirror.entityCount,
      memoryEntities: mirror.linkCount,
      memoryEdges: mirror.edgeCount,
    }

    const entities = await importEntities(brain, mirror, data)
    const links = await importLinks(brain, mirror, data, entities.byEngram)
    const edges = await importEdges(brain, mirror, data)

    report.entities = entities.stat
    report.links = links.stat
    report.edges = edges.stat

    // 实体/关联成功写入的实体 id 数（预演时新实体为 null，不算已解析）
    const resolvedEntityIds = new Set(
      [...entities.byEngram.values()].filter((id) => id !== null),
    )
    report.coverage = {
      memoryRefs: {
        node: mirror.nodeRefs.size,
        fact: mirror.factRefs.size,
        note: 'source_refs 里能反解出的 Engram 节点 id 数（记忆侧映射基础）',
      },
      links: {
        mapped: links.stat.linked + links.stat.already,
        unmappedMemory: links.stat.unmappedMemory,
        unmappedEntity: links.stat.unmappedEntity,
        rate: pct(links.stat.linked + links.stat.already, links.stat.total),
      },
      edges: {
        mapped: edges.stat.created + edges.stat.already,
        unmappedEndpoint: edges.stat.unmappedEndpoint,
        rate: pct(edges.stat.created + edges.stat.already, edges.stat.total),
      },
    }

    report.unmapped = {
      note: `未映射明细（每类前 ${MAX_SAMPLES} 条；不算失败，如实跳过）`,
      links: links.unmappedSamples,
      edges: edges.unmappedSamples,
      entityInvalidName: entities.invalidSamples,
    }
    report.errors = {
      entity: entities.errors,
      link: links.errors,
      edge: edges.errors,
      total: entities.stat.failed + links.stat.failed + edges.stat.failed,
    }

    report.targetAfter = readTargetCounts(brain)
    if (!APPLY) {
      report.note = mirror.tablesReady
        ? '预演模式，没有写任何东西。目标库已建 M6 表，预演数字是按当前库现状推的。'
        : '预演模式，没有写任何东西。目标库还没应用 0006（M6 三表不存在），实体/关联/边的新增数按空表预估；--apply 会先应用 0006 迁移再写。'
    }
    if (report.migrationsApplied.length > 0) {
      report.note = `目标库已应用迁移：${report.migrationsApplied.join(', ')}`
    }

    console.log(JSON.stringify(report, null, 2))

    console.log('\n=== Engram 实体/关联/关系边迁移（' + (APPLY ? '真写' : '预演') + '）===')
    console.log(`目标库：${BRAIN_DB}（schema ${brain.schemaVersion}${report.migrationsApplied.length ? '，本次应用 ' + report.migrationsApplied.join(',') : ''}）`)
    console.log(`数据源：${report.source.databases.map((d) => `${d.file}=实体${d.entities ?? '?'}/关联${d.nodeEntities ?? '?'}/边${d.edges ?? '?'}${d.error ? ' [打不开:' + d.error + ']' : ''}`).join(' | ')}`)
    if (report.source.emptyDatabases.length) {
      console.log(`（另扫描到 ${report.source.emptyDatabases.length} 个空的 Engram 库，无实体/关联/边：${report.source.emptyDatabases.join(', ')}）`)
    }
    console.log(`memory_id 反解：source_refs=${mirror.sourceRefCount} 条 → node ${mirror.nodeRefs.size} / fact ${mirror.factRefs.size}（正则未命中 ${mirror.refRegexMiss}）`)
    console.log(`实体   ：${entities.stat.total} → 新增 ${entities.stat.created} / 合并 ${entities.stat.merged} / 无变化 ${entities.stat.unchanged} / 名字无效 ${entities.stat.invalidName} / kind 回落 ${entities.stat.kindFallback} / 失败 ${entities.stat.failed}`)
    console.log(`关联   ：${links.stat.total} → 挂上 ${links.stat.linked} / 已存在 ${links.stat.already} / 记忆映射失败 ${links.stat.unmappedMemory} / 实体缺失 ${links.stat.unmappedEntity} / 记忆已删 ${links.stat.deletedMemory} / 失败 ${links.stat.failed}`)
    console.log(`关系边 ：${edges.stat.total} → 建上 ${edges.stat.created} / 已存在 ${edges.stat.already} / 端点映射失败 ${edges.stat.unmappedEndpoint} / 自环 ${edges.stat.selfLoop} / kind 非法 ${edges.stat.invalidKind} / 记忆已删 ${edges.stat.deletedMemory} / 失败 ${edges.stat.failed}`)
    console.log(`覆盖率 ：关联 ${report.coverage.links.rate} / 关系边 ${report.coverage.edges.rate}`)
    if (report.unmapped.links.length) {
      console.log('映射失败明细（关联，前 5）：')
      for (const s of report.unmapped.links) console.log(`   · ${s.file} node=${s.nodeId} entity=${s.entityId} ← ${s.reason}`)
    }
    if (report.unmapped.edges.length) {
      console.log('映射失败明细（关系边）：')
      for (const s of report.unmapped.edges) console.log(`   · ${s.file} #${s.seq} ${s.type} ← ${s.reason}`)
    }
    const after = report.targetAfter
    console.log(`目标库三表：entities=${after.entities ?? '未建'} / memory_entities=${after.memoryEntities ?? '未建'} / memory_edges=${after.memoryEdges ?? '未建'}`)
    if (after.entitiesByKind) console.log('entities by kind：', JSON.stringify(after.entitiesByKind))
    if (after.edgesByKind) console.log('memory_edges by kind：', JSON.stringify(after.edgesByKind))
    if (!APPLY) console.log('\n（预演模式。没有写任何东西。加 --apply 真写。）')
    console.log(`SUMMARY mode=${MODE} entities_total=${entities.stat.total} entities_created=${entities.stat.created} links_total=${links.stat.total} links_created=${links.stat.linked} edges_total=${edges.stat.total} edges_created=${edges.stat.created} errors=${report.errors.total} target.entities=${after.entities ?? 'n/a'} target.memory_entities=${after.memoryEntities ?? 'n/a'} target.memory_edges=${after.memoryEdges ?? 'n/a'}`)
  } finally {
    try { await brain.close() } catch { /* 关闭失败不掩盖主结果 */ }
  }
}

main().catch((error) => {
  console.error('迁移失败：', error)
  process.exitCode = 1
})
