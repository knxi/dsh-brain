// @ts-check
/**
 * `entities` / `memoryEdges` 门面（M6）—— 实体与记忆间的关系。
 *
 * ── 为什么补这两张表 ──
 *
 * Engram 有 `entities` / `node_entities` / `edges`，我们原来只有全文检索。
 * 两个真实缺口：
 *
 * 1. **「这个实体说过什么」拼不出来**。全文检索只能按词命中，
 *    要回答「关于 dsh-im 我们都定过什么」得先知道哪些记忆挂在它名下。
 * 2. **矛盾表达不了**。`memories.supersedes` 是单向链式取代（新的顶替旧的），
 *    而 `contradicts` 是**双向的并列冲突**——两条都还活着，需要人工核验。
 *    把它们硬塞进 supersedes 就等于擅自判定谁对，那是替主人做决定。
 *
 * ── 四条纪律 ──
 *
 * 1. **只写不猜**：`upsert` 只按 `(scope_id, name)` 精确合并。**不做相似度自动缝合**
 *    —— 名字相近不等于同一实体（「Remotion」和「Remotion 视频」要人来判断），
 *    错合并比不合并难恢复得多。
 * 2. **不掩盖冲突**：`contradicts` 是事实而不是错误。本门面不做任何「自动选边」，
 *    只如实返回冲突对。
 * 3. **删除口径跟随主账**：所有查询 join `memories` 过滤 `status = 'deleted'`。
 *    已删记忆的实体关联不参与任何结果——不让删掉的东西从旁边漏回来。
 *    （表上的 `ON DELETE CASCADE` 只对真删生效，本系统是软删除，挡不住。）
 * 4. **幂等优先**：`(scope_id, name)` 唯一、`(memory_id, entity_id)` 主键、
 *    `(from, to, kind)` 唯一。重复写只返回既有行，不制造第二份。
 *
 * 依赖：写一律走 `queue.write`（单写队列 + 事务），读走 `createTxApi`。
 */

import { BrainError } from '@dsh-brain/core'
import { insertAudit } from './ledger.js'
import { createTxApi } from './write-queue.js'
import { newId, requireEnum, requireString, requireUnit } from './memory-util.js'

/** 实体种类。`other` 是兜底，不做「猜一个更像的」——猜错会污染按类型统计。 */
export const ENTITY_KINDS = Object.freeze(['person', 'project', 'tool', 'concept', 'other'])

/**
 * 记忆间关系的种类。
 * - `supersedes`：from 取代 to（新结论顶替旧结论）
 * - `contradicts`：两者并列冲突，**都需要保留**，等核验
 * - `supports`：from 是 to 的佐证
 * - `refines`：from 是 to 的细化（不否定）
 */
export const MEMORY_EDGE_KINDS = Object.freeze(['supersedes', 'contradicts', 'supports', 'refines'])

/** 实体名长度上限。超长的多半是把整句话当名字，那是错的。 */
const MAX_NAME_LENGTH = 80
/** 单实体别名上限，防脏数据把 aliases 撑爆。 */
const MAX_ALIASES = 20
/** 列表默认条数。 */
export const DEFAULT_ENTITY_LIMIT = 200

/**
 * 名字规范化：压空白、去首尾。**不做大小写折叠**——
 * `AGENTS.md` 和 `agents.md` 在文件名语境下未必是同一个东西，让人来判断。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeName(value) {
  const raw = requireString(value, 'name')
  // requireString 已经拦掉纯空白，这里只管「压缩空白后」的形态与长度
  const name = raw.replace(/\s+/g, ' ').trim()
  if (name.length > MAX_NAME_LENGTH) {
    throw new BrainError('INVALID_ARGUMENT', `name 太长（${name.length} > ${MAX_NAME_LENGTH}）：${name.slice(0, 40)}…`)
  }
  return name
}

/**
 * 解析 aliases 列。**脏数据不炸查询**：解析不了当空数组（与 parseJsonArray 的严格版不同，
 * 这里读的是历史数据，宁可少几个别名也不能让整次检索 500）。
 * @param {unknown} text
 * @returns {string[]}
 */
function safeAliases(text) {
  if (text === null || text === undefined) return []
  if (Array.isArray(text)) return text.map((v) => String(v))
  try {
    const parsed = JSON.parse(String(text))
    return Array.isArray(parsed) ? parsed.map((v) => String(v)) : []
  } catch {
    return []
  }
}

/**
 * 规范化传入的别名列表：压空白、去空、小写去重（别名本身就是同义，折叠大小写合理）。
 * @param {unknown} list
 * @returns {string[]}
 */
function normalizeAliases(list) {
  if (!Array.isArray(list)) return []
  /** @type {string[]} */
  const out = []
  const seen = new Set()
  for (const item of list) {
    if (typeof item !== 'string') continue
    const value = item.replace(/\s+/g, ' ').trim()
    if (value.length === 0 || value.length > MAX_NAME_LENGTH) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
    if (out.length >= MAX_ALIASES) break
  }
  return out
}

/**
 * 并集：保留旧的先后顺序，补进新的。
 * @param {string[]} existing
 * @param {string[]} incoming
 * @returns {string[]}
 */
function mergeAliases(existing, incoming) {
  return normalizeAliases([...existing, ...incoming])
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
function rowToEntity(row) {
  return {
    id: String(row.id),
    name: String(row.name),
    kind: String(row.kind),
    aliases: safeAliases(row.aliases),
    importance: Number(row.importance),
    status: String(row.status),
    mergedInto: row.merged_into == null ? null : String(row.merged_into),
    sourceSystem: row.source_system == null ? null : String(row.source_system),
    sourceRef: row.source_ref == null ? null : String(row.source_ref),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    /** 挂在它名下、且未删除的记忆条数 */
    memoryCount: Number(row.memory_count ?? 0),
  }
}

/**
 * @param {Record<string, any>} row
 * @returns {any}
 */
function rowToEdge(row) {
  return {
    id: String(row.id),
    fromMemoryId: String(row.from_memory_id),
    toMemoryId: String(row.to_memory_id),
    kind: String(row.kind),
    reason: row.reason == null ? null : String(row.reason),
    sourceSystem: row.source_system == null ? null : String(row.source_system),
    sourceRef: row.source_ref == null ? null : String(row.source_ref),
    createdAt: String(row.created_at),
  }
}

/**
 * 实体门面。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   bindings?: { scope_id?: string, person_id?: string },
 * }} options
 */
export function createEntities(options) {
  const { db, queue, clock } = options
  const tx = createTxApi(db)
  const bindings = options.bindings ?? {}
  const defaultScope = bindings.scope_id ?? 'owner-default'
  const defaultPerson = bindings.person_id ?? null

  /** @param {any} input */
  const scopeOf = (input) => requireString(input?.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })

  /**
   * 写一条实体：不存在就建，存在就**合并**（不分裂）。
   *
   * 合并规则（每条都有理由）：
   * - `kind` 不降级：已有 `tool` 再遇到 `other` 就保持 `tool`，
   *   否则每迁一次数据 kind 都会被打回 `other`，按类型统计直接废掉。
   *   `person` / `project` / `tool` / `concept` 之间**没有优先级表**——谁更「对」没有客观依据，
   *   结果是「先到的具体类型留下」。迁移顺序不同可能得到不同 kind，这是已知取舍：
   *   任何优先级表都是替数据编造语义，不如留给人看。
   * - `aliases` 取并集：别名只会越用越多，丢掉就是丢检索入口。
   * - `importance` 取较大值：重要度是「至少有多重要」，被低值覆盖会让重要实体沉底。
   * - `source_system` / `source_ref` 只补空、不覆盖：保留**首次出处**，
   *   否则重复迁移会把来源改写成最后一次的来源，源头就查不清了。
   *
   * @param {{
   *   scopeId?: string, personId?: string, name: string,
   *   kind?: 'person'|'project'|'tool'|'concept'|'other',
   *   aliases?: string[], importance?: number,
   *   sourceSystem?: string, sourceRef?: string,
   * }} input
   * @returns {Promise<{ id: string, name: string, kind: string, created: boolean, updated: boolean }>}
   */
  async function upsert(input = /** @type {any} */ ({})) {
    const name = normalizeName(input.name)
    const scopeId = scopeOf(input)
    const kind = requireEnum(input.kind ?? 'other', ENTITY_KINDS, 'kind', { fallback: 'other' })
    const aliases = normalizeAliases(input.aliases)
    const importance = requireUnit(input.importance, 'importance', 0.5)
    const personId = input.personId ?? defaultPerson
    const sourceSystem = input.sourceSystem == null ? null : String(input.sourceSystem)
    const sourceRef = input.sourceRef == null ? null : String(input.sourceRef)

    return queue.write(
      (txh) => {
        const stamp = clock.stamp()
        const existing = txh.get('SELECT * FROM entities WHERE scope_id = ? AND name = ?', [scopeId, name])
        if (existing) {
          const nextKind = existing.kind === 'other' && kind !== 'other' ? kind : String(existing.kind)
          const nextAliases = mergeAliases(safeAliases(existing.aliases), aliases)
          const nextImportance = Math.max(Number(existing.importance) || 0, importance)
          const nextSourceSystem = existing.source_system ?? sourceSystem
          const nextSourceRef = existing.source_ref ?? sourceRef
          const changed =
            nextKind !== String(existing.kind) ||
            JSON.stringify(nextAliases) !== JSON.stringify(safeAliases(existing.aliases)) ||
            nextImportance !== Number(existing.importance) ||
            nextSourceSystem !== (existing.source_system ?? null) ||
            nextSourceRef !== (existing.source_ref ?? null)
          if (changed) {
            txh.run(
              `UPDATE entities
                  SET kind = ?, aliases = ?, importance = ?, source_system = ?, source_ref = ?,
                      updated_at = ?, updated_at_local = ?
                WHERE id = ?`,
              [nextKind, JSON.stringify(nextAliases), nextImportance, nextSourceSystem, nextSourceRef,
                stamp.utc, stamp.local, String(existing.id)],
            )
          }
          return { id: String(existing.id), name, kind: nextKind, created: false, updated: changed }
        }
        const id = newId('ent')
        txh.run(
          `INSERT INTO entities (
             id, scope_id, person_id, name, kind, aliases, importance, status,
             merged_into, source_system, source_ref,
             created_at, created_at_local, updated_at, updated_at_local, deletion_epoch
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?, ?, ?, ?, ?, 0)`,
          [id, scopeId, personId, name, kind, JSON.stringify(aliases), importance,
            sourceSystem, sourceRef, stamp.utc, stamp.local, stamp.utc, stamp.local],
        )
        return { id, name, kind, created: true, updated: false }
      },
      { label: 'entities.upsert' },
    )
  }

  /**
   * 修正实体 kind（M6.1）。
   *
   * ── 为什么需要单独一条写路径 ──
   * `upsert` 有一条刻意的「kind 不降级」规则（见上），它保护迁移时已经定下的具体类型
   * 不被后到的 `other` 打回。代价是**反方向的修正被堵死**：`person` → `other`
   * （上游把 teammate 代号标成「人」的典型错标，CONTRACTS §13.6 记的就是这个）
   * 在门面下根本改不动。观察期要「把实体过一遍」，就必须有一条显式的修正入口——
   * 而不是让人去 `UPDATE entities` 绕过审计。
   *
   * ── 几条口径 ──
   * 1. **只改 kind**：名字/别名/重要度各有自己的写路径，一次修一个维度，
   *    审计日志才读得懂「这次到底改了什么」。
   * 2. **幂等不产噪声**：同 kind 再传一次返回 `changed: false`，既不写
   *    `updated_at` 也不落审计——脚本重复跑不该在审计表里堆一排空动作。
   * 3. **scope 收口**（CONTRACTS §13.10 的口径）：默认按调用方 scope 查，
   *    越界与「不存在」同形，一律 `NOT_FOUND`，不确认对方存在性。
   * 4. **审计走 `audit_logs`**：实体没有版本表（`memory_versions` 属于记忆），
   *    kind 变更的可追溯性全靠这条审计。detail 只放 id / 名字 / 新旧 kind / 原因。
   *
   * @param {string} entityId
   * @param {'person'|'project'|'tool'|'concept'|'other'} kind
   * @param {{ scopeId?: string, allowCrossScope?: boolean, changedBy?: string, reason?: string }} [opts]
   * @returns {Promise<{ id: string, name: string, kind: string, previousKind: string, changed: boolean }>}
   */
  async function updateKind(entityId, kind, opts = /** @type {any} */ ({})) {
    // 枚举校验放在队列外：非法 kind 不该开事务，更不该在库里留任何痕
    const nextKind = requireEnum(kind, ENTITY_KINDS, 'kind')
    requireString(entityId, 'entityId')
    const scopeId = opts.allowCrossScope === true
      ? null
      : requireString(opts.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    const changedBy = requireString(opts.changedBy, 'changedBy', { fallback: 'entities.updateKind' })
    const reason = requireString(opts.reason, 'reason', { fallback: 'update_kind' })

    return queue.write(
      (txh) => {
        const row = txh.get(
          'SELECT * FROM entities WHERE id = ? AND (? IS NULL OR scope_id = ?)',
          [entityId, scopeId, scopeId],
        )
        // 跨 scope 与「真不存在」同形：都不确认存在性
        if (row === undefined) throw new BrainError('NOT_FOUND', `实体不存在：${entityId}`)
        if (String(row.status) === 'deleted') {
          throw new BrainError('CONFLICT', `实体已删除，不能改 kind：${entityId}`)
        }
        const previousKind = String(row.kind)
        const name = String(row.name)
        if (previousKind === nextKind) {
          // 幂等成功。不碰 updated_at：语义上什么都没发生，制造一条「改了但没改」的
          // 审计比不写审计更糟——以后翻审计会以为数据被动过。
          return { id: entityId, name, kind: nextKind, previousKind, changed: false }
        }
        const stamp = clock.stamp()
        txh.run(
          'UPDATE entities SET kind = ?, updated_at = ?, updated_at_local = ? WHERE id = ?',
          [nextKind, stamp.utc, stamp.local, entityId],
        )
        insertAudit(
          txh,
          newId('aud'),
          {
            action: 'entities.updateKind',
            actor: changedBy,
            target_kind: 'entity',
            target_id: entityId,
            scope_id: String(row.scope_id),
            result: 'ok',
            detail: {
              entity_id: entityId,
              name,
              previous_kind: previousKind,
              kind: nextKind,
              reason,
            },
            deletion_epoch: Number(row.deletion_epoch ?? 0),
          },
          clock,
        )
        return { id: entityId, name, kind: nextKind, previousKind, changed: true }
      },
      { label: 'entities.updateKind' },
    )
  }

  /**
   * 按 id 取实体（含未删除记忆条数）。不存在返回 null（不抛——查询语义）。
   *
   * **scope 收口**（CONTRACTS §16）：与 `memories.get` / `updateKind` 同口径——
   * 默认按 caller scope 过滤，拿到别的 scope 的实体 id 返回 `null`，与「这个实体不存在」
   * 同形（不确认存在性）。`opts.allowCrossScope === true` 只给进程内维护路径，
   * **不许**从 HTTP 暴露。
   *
   * @param {string} id
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   */
  function get(id, opts = {}) {
    requireString(id, 'id')
    const scopeId = opts.allowCrossScope === true
      ? null
      : requireString(opts.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    const row = tx.get(
      `SELECT e.*, (
         SELECT count(*) FROM memory_entities me
           JOIN memories m ON m.id = me.memory_id
          WHERE me.entity_id = e.id AND m.status != 'deleted'
       ) AS memory_count
         FROM entities e WHERE e.id = ? AND (? IS NULL OR e.scope_id = ?)`,
      [id, scopeId, scopeId],
    )
    return row === undefined ? null : rowToEntity(/** @type {any} */ (row))
  }

  /**
   * 列表。
   * @param {{ scopeId?: string, kind?: string, query?: string, includeMerged?: boolean, limit?: number }} [query]
   */
  function list(query = {}) {
    const scopeId = requireString(query.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    const limit = Math.min(Math.max(Number(query.limit) || DEFAULT_ENTITY_LIMIT, 1), 1000)
    /** @type {string[]} */
    const where = ['e.scope_id = ?']
    /** @type {any[]} */
    const params = [scopeId]
    if (query.includeMerged !== true) where.push("e.status = 'active'")
    if (query.kind) {
      where.push('e.kind = ?')
      params.push(requireEnum(query.kind, ENTITY_KINDS, 'kind'))
    }
    const needle = typeof query.query === 'string' ? query.query.trim() : ''
    if (needle) {
      // 名字和别名都搜。用 ESCAPE 处理通配符，避免用户输入里的 % _ 变成通配
      const escaped = needle.replace(/[\\%_]/g, (m) => '\\' + m)
      where.push("(e.name LIKE ? ESCAPE '\\' OR e.aliases LIKE ? ESCAPE '\\')")
      params.push(`%${escaped}%`, `%${escaped}%`)
    }
    params.push(limit)
    const rows = tx.all(
      `SELECT e.*, (
         SELECT count(*) FROM memory_entities me
           JOIN memories m ON m.id = me.memory_id
          WHERE me.entity_id = e.id AND m.status != 'deleted'
       ) AS memory_count
         FROM entities e
        WHERE ${where.join(' AND ')}
        ORDER BY memory_count DESC, e.importance DESC, e.name ASC
        LIMIT ?`,
      params,
    )
    return { items: rows.map((row) => rowToEntity(/** @type {any} */ (row))), limit }
  }

  /**
   * 按名字或别名找一个实体。给「按实体检索」用。
   *
   * 先精确匹配名字，再精确匹配别名，最后才 LIKE。**只返回一个**——
   * 候选不唯一时返回 `{ ambiguous: true, candidates }`，让调用方决定，
   * 不替人挑一个「最像的」。
   *
   * 大小写口径（**已知不统一，故意的**）：
   * - 精确名 / 精确别名那两层**区分大小写**——`Remotion` 和 `remotion` 算两个不同的名字，
   *   给它们各自存在的机会；
   * - 模糊层用的是 SQL `LIKE`，对 ASCII **不区分**大小写，所以 `resolve('remotion')`
   *   能靠模糊层找回 `Remotion`。这是 SQLite 的默认行为，不改：
   *   改成 NOCASE 需要重建索引，而收益只在英文名上，中文名本来没有大小写。
   * @param {string} needle
   * @param {{ scopeId?: string }} [opts]
   */
  function resolve(needle, opts = {}) {
    requireString(needle, 'needle')
    const scopeId = requireString(opts.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    // 不用再判空：requireString 已经把纯空白拒成 INVALID_ARGUMENT。
    // 留一个「不可能走到」的分支只会让人以为这里还有别的出口。
    const text = needle.replace(/\s+/g, ' ').trim()
    const escaped = text.replace(/[\\%_]/g, (m) => '\\' + m)

    const find = (sql, params) => tx.all(sql, params).map((row) => rowToEntity(/** @type {any} */ (row)))
    let rows = find(
      "SELECT e.*, 0 AS memory_count FROM entities e WHERE e.scope_id = ? AND e.status = 'active' AND e.name = ?",
      [scopeId, text],
    )
    if (rows.length === 0) {
      rows = find(
        "SELECT e.*, 0 AS memory_count FROM entities e WHERE e.scope_id = ? AND e.status = 'active' AND e.aliases LIKE ? ESCAPE '\\'",
        [scopeId, `%"${escaped}"%`],
      )
    }
    if (rows.length === 0) {
      rows = find(
        "SELECT e.*, 0 AS memory_count FROM entities e WHERE e.scope_id = ? AND e.status = 'active' AND e.name LIKE ? ESCAPE '\\' LIMIT 10",
        [scopeId, `%${escaped}%`],
      )
    }
    if (rows.length === 1) return { entity: rows[0], ambiguous: false, candidates: rows }
    if (rows.length === 0) return { entity: null, ambiguous: false, candidates: [] }
    return { entity: null, ambiguous: true, candidates: rows.slice(0, 10) }
  }

  /**
   * 把一条记忆挂到一个实体上。幂等：重复挂返回 `linked: false`。
   * @param {string} memoryId
   * @param {string} entityId
   * @param {{ role?: string | null }} [extra]
   * @returns {Promise<{ linked: boolean }>}
   */
  async function linkMemory(memoryId, entityId, extra = {}) {
    requireString(memoryId, 'memoryId')
    requireString(entityId, 'entityId')
    const role = extra.role == null ? null : String(extra.role)
    return queue.write(
      (txh) => {
        const memory = txh.get('SELECT status, scope_id FROM memories WHERE id = ?', [memoryId])
        if (memory === undefined) throw new BrainError('NOT_FOUND', `记忆不存在，不能挂实体：${memoryId}`)
        if (String(memory.status) === 'deleted') {
          throw new BrainError('CONFLICT', `记忆已删除，不能挂实体：${memoryId}`)
        }
        const entity = txh.get('SELECT status, scope_id FROM entities WHERE id = ?', [entityId])
        if (entity === undefined) throw new BrainError('NOT_FOUND', `实体不存在：${entityId}`)
        if (String(entity.status) === 'deleted') {
          throw new BrainError('CONFLICT', `实体已删除，不能挂记忆：${entityId}`)
        }
        // 跨 scope 关联是真错位（实测过）：给 owner-default 的记忆挂上 owner-other 的实体后，
        // owner-other 的统计里 memoryCount 会凭空 +1，而 owner-default 里又看不到这个关联。
        // 所以宁可拒，不许写出一条两边对不上的关系。
        if (String(memory.scope_id) !== String(entity.scope_id)) {
          throw new BrainError(
            'CONFLICT',
            `记忆（scope ${String(memory.scope_id)}）与实体（scope ${String(entity.scope_id)}）不在同一 scope，不能关联`,
          )
        }
        const existing = txh.get('SELECT 1 AS ok FROM memory_entities WHERE memory_id = ? AND entity_id = ?', [memoryId, entityId])
        if (existing !== undefined) return { linked: false }
        const stamp = clock.stamp()
        txh.run(
          `INSERT INTO memory_entities (memory_id, entity_id, role, created_at, created_at_local)
           VALUES (?, ?, ?, ?, ?)`,
          [memoryId, entityId, role, stamp.utc, stamp.local],
        )
        return { linked: true }
      },
      { label: 'entities.linkMemory' },
    )
  }

  /**
   * 摘掉一条关联。返回是否真的删了。
   * @param {string} memoryId
   * @param {string} entityId
   * @returns {Promise<{ removed: boolean }>}
   */
  async function unlinkMemory(memoryId, entityId) {
    requireString(memoryId, 'memoryId')
    requireString(entityId, 'entityId')
    return queue.write(
      (txh) => {
        const existing = txh.get('SELECT 1 AS ok FROM memory_entities WHERE memory_id = ? AND entity_id = ?', [memoryId, entityId])
        if (existing === undefined) return { removed: false }
        txh.run('DELETE FROM memory_entities WHERE memory_id = ? AND entity_id = ?', [memoryId, entityId])
        return { removed: true }
      },
      { label: 'entities.unlinkMemory' },
    )
  }

  /**
   * 某条记忆挂着哪些实体（只返回 active 实体）。
   *
   * **scope 收口**（CONTRACTS §16）：拿别的 scope 的记忆 id 来查，返回空数组——
   * 「查不到」与「这条记忆不属于你」同形。两端都查（`me` 的实体侧 + 记忆侧），
   * 因为 `memory_entities` 本身没有 scope 列，只靠一端过滤迟早被人绕开。
   *
   * @param {string} memoryId
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   */
  function forMemory(memoryId, opts = {}) {
    requireString(memoryId, 'memoryId')
    const scopeId = opts.allowCrossScope === true
      ? null
      : requireString(opts.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    return tx
      .all(
        `SELECT e.id, e.name, e.kind, e.aliases, e.importance
           FROM memory_entities me
           JOIN entities e ON e.id = me.entity_id
           JOIN memories m ON m.id = me.memory_id
          WHERE me.memory_id = ? AND e.status = 'active'
            AND (? IS NULL OR e.scope_id = ?)
            AND (? IS NULL OR m.scope_id = ?)
          ORDER BY e.importance DESC, e.name ASC`,
        [memoryId, scopeId, scopeId, scopeId, scopeId],
      )
      .map((row) => ({
        id: String(row.id),
        name: String(row.name),
        kind: String(row.kind),
        aliases: safeAliases(row.aliases),
        importance: Number(row.importance),
      }))
  }

  /**
   * 某实体名下有哪些记忆。已删记忆被排除。
   *
   * **scope 收口**（CONTRACTS §16）：这条返回**记忆正文**（`content`），是全链路里
   * 最该收口的一处——拿别的 scope 的实体 id 来查，必须得到空数组，不是「正文照给」。
   * 实体归属与记忆归属各查一次。
   *
   * @param {string} entityId
   * @param {{ limit?: number, scopeId?: string, allowCrossScope?: boolean }} [opts]
   */
  function memoriesFor(entityId, opts = {}) {
    requireString(entityId, 'entityId')
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500)
    const scopeId = opts.allowCrossScope === true
      ? null
      : requireString(opts.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    return tx.all(
      `SELECT m.id AS memory_id, m.summary, m.content, m.type, m.layer, m.importance,
              m.status, m.valid_from, m.valid_until, me.created_at AS linked_at
         FROM memory_entities me
         JOIN memories m ON m.id = me.memory_id
         JOIN entities e ON e.id = me.entity_id
        WHERE me.entity_id = ? AND m.status != 'deleted'
          AND (? IS NULL OR m.scope_id = ?)
          AND (? IS NULL OR e.scope_id = ?)
        ORDER BY m.importance DESC, m.created_at DESC
        LIMIT ?`,
      [entityId, scopeId, scopeId, scopeId, scopeId, limit],
    ).map((row) => ({
      memoryId: String(row.memory_id),
      summary: row.summary == null ? null : String(row.summary),
      type: row.type == null ? null : String(row.type),
      layer: row.layer == null ? null : String(row.layer),
      importance: Number(row.importance),
      status: String(row.status),
      validFrom: row.valid_from == null ? null : String(row.valid_from),
      validUntil: row.valid_until == null ? null : String(row.valid_until),
      linkedAt: String(row.linked_at),
    }))
  }

  /**
   * 统计。
   * @param {{ scopeId?: string }} [query]
   */
  function stats(query = {}) {
    const scopeId = requireString(query.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    const total = Number(tx.get("SELECT count(*) c FROM entities WHERE scope_id = ? AND status = 'active'", [scopeId]).c)
    /** @type {Record<string, number>} */
    const byKind = {}
    for (const row of tx.all(
      "SELECT kind, count(*) c FROM entities WHERE scope_id = ? AND status = 'active' GROUP BY kind",
      [scopeId],
    )) byKind[String(row.kind)] = Number(row.c)

    const linked = Number(tx.get(
      `SELECT count(DISTINCT me.entity_id) c
         FROM memory_entities me
         JOIN memories m ON m.id = me.memory_id
         JOIN entities e ON e.id = me.entity_id
        WHERE m.status != 'deleted' AND e.scope_id = ? AND e.status = 'active'`,
      [scopeId],
    ).c)
    const orphan = Number(tx.get(
      `SELECT count(*) c FROM entities e
        WHERE e.scope_id = ? AND e.status = 'active'
          AND NOT EXISTS (
            SELECT 1 FROM memory_entities me JOIN memories m ON m.id = me.memory_id
             WHERE me.entity_id = e.id AND m.status != 'deleted')`,
      [scopeId],
    ).c)
    // 只给 orphan 一个字段：按定义它就等于 total - linked。
    // 再挂个 unlinked 是同一件事的两个名字，迟早有人以为它们不是一回事。
    return { total, byKind, linked, orphan }
  }

  return { upsert, updateKind, get, list, resolve, linkMemory, unlinkMemory, forMemory, memoriesFor, stats, ENTITY_KINDS }
}

/**
 * 记忆关系边门面。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string } },
 *   bindings?: { scope_id?: string, person_id?: string },
 * }} options
 */
export function createMemoryEdges(options) {
  const { db, queue, clock } = options
  const tx = createTxApi(db)
  const bindings = options.bindings ?? {}
  const defaultScope = bindings.scope_id ?? 'owner-default'

  /**
   * 记一条关系。幂等：`(from, to, kind)` 已有就返回既有 id、`created: false`。
   *
   * 为什么两端都要校验存在且未删除：
   * 挂一条指向已删记忆的边，等于让删掉的东西从旁边漏回来——M3 的删除屏障
   * 只守主账，关系表必须自己守。
   *
   * @param {{
   *   scopeId?: string, fromMemoryId: string, toMemoryId: string,
   *   kind: 'supersedes'|'contradicts'|'supports'|'refines',
   *   reason?: string, sourceSystem?: string, sourceRef?: string,
   * }} input
   * @returns {Promise<{ id: string, created: boolean }>}
   */
  async function link(input = /** @type {any} */ ({})) {
    const scopeId = requireString(input.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    const fromMemoryId = requireString(input.fromMemoryId, 'fromMemoryId')
    const toMemoryId = requireString(input.toMemoryId, 'toMemoryId')
    const kind = requireEnum(input.kind, MEMORY_EDGE_KINDS, 'kind')
    if (fromMemoryId === toMemoryId) {
      throw new BrainError('INVALID_ARGUMENT', '关系两端不能是同一条记忆（自环没有语义）')
    }
    const reason = input.reason == null ? null : String(input.reason).slice(0, 500)
    const sourceSystem = input.sourceSystem == null ? null : String(input.sourceSystem)
    const sourceRef = input.sourceRef == null ? null : String(input.sourceRef)

    return queue.write(
      (txh) => {
        for (const [id, label] of [[fromMemoryId, 'fromMemoryId'], [toMemoryId, 'toMemoryId']]) {
          const row = txh.get('SELECT status, scope_id FROM memories WHERE id = ?', [id])
          if (row === undefined) throw new BrainError('NOT_FOUND', `${label} 指向的记忆不存在：${id}`)
          if (String(row.status) === 'deleted') {
            throw new BrainError('CONFLICT', `${label} 指向的记忆已删除，不能建关系：${id}`)
          }
          // 边只记在传入 scope 下。两端记忆不属于该 scope 时若放行，会写出
          // 「指定 scope 看得到、记忆真正所属 scope 看不到」的错位关系——
          // 而唯一索引 (from,to,kind) 不含 scope，错记之后连补建都做不了（实测过）。
          if (String(row.scope_id) !== scopeId) {
            throw new BrainError(
              'CONFLICT',
              `${label} 指向的记忆属于 scope ${String(row.scope_id)}，与传入 scope ${scopeId} 不一致，不能建关系`,
            )
          }
        }
        const existing = txh.get(
          'SELECT id FROM memory_edges WHERE from_memory_id = ? AND to_memory_id = ? AND kind = ?',
          [fromMemoryId, toMemoryId, kind],
        )
        if (existing !== undefined) return { id: String(existing.id), created: false }
        const stamp = clock.stamp()
        const id = newId('edge')
        txh.run(
          `INSERT INTO memory_edges (
             id, scope_id, from_memory_id, to_memory_id, kind, reason,
             source_system, source_ref, created_at, created_at_local, deletion_epoch
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [id, scopeId, fromMemoryId, toMemoryId, kind, reason,
            sourceSystem, sourceRef, stamp.utc, stamp.local],
        )
        return { id, created: true }
      },
      { label: 'memoryEdges.link' },
    )
  }

  /**
   * 某条记忆的全部关系：出边 + 入边，都带对端摘要（只看未删的对端）。
   *
   * **scope 收口**（CONTRACTS §16）：跨 scope 的 id 返回 `{ out: [], in: [] }`——
   * 与「这条记忆没有关系」同形。返回形状不变（这里不抛错，避免调用方多一条分支）。
   *
   * @param {string} memoryId
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   */
  function forMemory(memoryId, opts = {}) {
    requireString(memoryId, 'memoryId')
    const scopeId = opts.allowCrossScope === true
      ? null
      : requireString(opts.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    // 已删的记忆自己没有「关系视图」：它已经不在任何搜索结果里了，
    // 再返回它的边会让人以为它还活着。对端过滤只挡另一侧，挡不住这一侧。
    // scope 同理：本条记忆、对端记忆、边自己三处都要过滤——任一处漏了都能被拿来
    // 拼出别 scope 的「谁和谁有关系」（CONTRACTS §16）。
    const self = tx.get('SELECT status FROM memories WHERE id = ? AND (? IS NULL OR scope_id = ?)', [
      memoryId,
      scopeId,
      scopeId,
    ])
    if (self === undefined || String(self.status) === 'deleted') return { out: [], in: [] }
    const out = tx.all(
      `SELECT e.*, m.summary AS peer_summary, m.type AS peer_type
         FROM memory_edges e
         JOIN memories m ON m.id = e.to_memory_id
        WHERE e.from_memory_id = ? AND m.status != 'deleted'
          AND (? IS NULL OR e.scope_id = ?) AND (? IS NULL OR m.scope_id = ?)
        ORDER BY e.created_at DESC`,
      [memoryId, scopeId, scopeId, scopeId, scopeId],
    ).map((row) => ({ ...rowToEdge(/** @type {any} */ (row)), peerSummary: row.peer_summary ?? null, peerType: row.peer_type ?? null }))
    const incoming = tx.all(
      `SELECT e.*, m.summary AS peer_summary, m.type AS peer_type
         FROM memory_edges e
         JOIN memories m ON m.id = e.from_memory_id
        WHERE e.to_memory_id = ? AND m.status != 'deleted'
          AND (? IS NULL OR e.scope_id = ?) AND (? IS NULL OR m.scope_id = ?)
        ORDER BY e.created_at DESC`,
      [memoryId, scopeId, scopeId, scopeId, scopeId],
    ).map((row) => ({ ...rowToEdge(/** @type {any} */ (row)), peerSummary: row.peer_summary ?? null, peerType: row.peer_type ?? null }))
    return { out, in: incoming }
  }

  /**
   * 列表（两端都未删）。
   * @param {{ scopeId?: string, kind?: string, limit?: number }} [query]
   */
  function list(query = {}) {
    const scopeId = requireString(query.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    const limit = Math.min(Math.max(Number(query.limit) || 200, 1), 1000)
    /** @type {string[]} */
    const where = ['e.scope_id = ?', "mf.status != 'deleted'", "mt.status != 'deleted'"]
    /** @type {any[]} */
    const params = [scopeId]
    if (query.kind) {
      where.push('e.kind = ?')
      params.push(requireEnum(query.kind, MEMORY_EDGE_KINDS, 'kind'))
    }
    params.push(limit)
    return tx.all(
      `SELECT e.*, mf.summary AS from_summary, mt.summary AS to_summary
         FROM memory_edges e
         JOIN memories mf ON mf.id = e.from_memory_id
         JOIN memories mt ON mt.id = e.to_memory_id
        WHERE ${where.join(' AND ')}
        ORDER BY e.created_at DESC
        LIMIT ?`,
      params,
    ).map((row) => ({
      ...rowToEdge(/** @type {any} */ (row)),
      fromSummary: row.from_summary ?? null,
      toSummary: row.to_summary ?? null,
    }))
  }

  /**
   * 冲突对（`contradicts`），两端都未删。这是最该被人工看的一类。
   * @param {{ scopeId?: string, limit?: number }} [query]
   */
  function conflicts(query = {}) {
    return list({ ...query, kind: 'contradicts' })
  }

  /**
   * 删一条边。真删（不留 tombstone）：关系是可重建的派生结构，
   * 它的价值在「当前是否仍冲突」，历史留痕走 audit_logs 而不是边表。
   *
   * **scope 收口**（CONTRACTS §16）：跨 scope 的边 id 与「不存在」同形——
   * 返回 `{ removed: false }`，不删任何行（写路径的越权也要挡，否则等于
   * 允许别人用 id 猜出来再删掉你的关系）。
   *
   * @param {string} id
   * @param {{ scopeId?: string, allowCrossScope?: boolean }} [opts]
   * @returns {Promise<{ removed: boolean }>}
   */
  async function remove(id, opts = {}) {
    requireString(id, 'id')
    const scopeId = opts.allowCrossScope === true
      ? null
      : requireString(opts.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    return queue.write(
      (txh) => {
        const existing = txh.get('SELECT 1 AS ok FROM memory_edges WHERE id = ? AND (? IS NULL OR scope_id = ?)', [
          id,
          scopeId,
          scopeId,
        ])
        if (existing === undefined) return { removed: false }
        txh.run('DELETE FROM memory_edges WHERE id = ?', [id])
        return { removed: true }
      },
      { label: 'memoryEdges.remove' },
    )
  }

  /**
   * 统计。
   * @param {{ scopeId?: string }} [query]
   */
  function stats(query = {}) {
    const scopeId = requireString(query.scopeId ?? defaultScope, 'scopeId', { fallback: defaultScope })
    /** @type {Record<string, number>} */
    const byKind = {}
    let total = 0
    for (const row of tx.all(
      `SELECT e.kind, count(*) c
         FROM memory_edges e
         JOIN memories mf ON mf.id = e.from_memory_id
         JOIN memories mt ON mt.id = e.to_memory_id
        WHERE e.scope_id = ? AND mf.status != 'deleted' AND mt.status != 'deleted'
        GROUP BY e.kind`,
      [scopeId],
    )) {
      byKind[String(row.kind)] = Number(row.c)
      total += Number(row.c)
    }
    return { total, byKind }
  }

  return { link, forMemory, list, conflicts, remove, stats, MEMORY_EDGE_KINDS }
}
