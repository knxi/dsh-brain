-- ============================================================================
-- 0006_m6_entities.sql —— 实体与记忆关系（M6）
--
-- 补的是 Engram 有、我们原来没有的两块能力：
--   1. 实体：人物 / 项目 / 工具 / 概念。「这个实体说过什么」靠全文检索拼不出来。
--   2. 记忆↔记忆关系：原来只有 memories.supersedes 一条链式取代，
--      表达不了双向的 contradicts —— 而矛盾恰恰是最该被人工核验的状态。
--
-- 与主账口径保持一致（照 0001 的写法）：
--   - 时间列一律 TEXT（ISO 字符串）+ 对应的 *_local，不用毫秒数；
--   - 软删除：memory_entities / memory_edges 不真删行，查询时 join memories
--     过滤 status='deleted'，已删记忆的关联不参与任何结果；
--   - 唯一约束承担幂等：重复写同一实体/同一条边不产生第二行。
--
-- 注意：`ON DELETE CASCADE` 只对**真删**生效。本系统的删除是 status='deleted'
-- + deletion_epoch 的软删除，所以级联删除不能替代查询侧的过滤。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. entities —— 去重后的实体清单。
--    (scope_id, name) 唯一：实体是「一个名字」，分裂成同名两行是错的。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id                TEXT PRIMARY KEY,
  scope_id          TEXT NOT NULL,
  person_id         TEXT,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'other'
                      CHECK (kind IN ('person', 'project', 'tool', 'concept', 'other')),
  -- JSON 数组字符串：别的叫法。查「Workers」要能命中「Cloudflare Workers」
  aliases           TEXT NOT NULL DEFAULT '[]',
  importance        REAL NOT NULL DEFAULT 0.5
                      CHECK (importance >= 0 AND importance <= 1),
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'merged', 'deleted')),
  -- 合并目标（同义实体后期收敛用）；指向本表 id，不设外键避免合并链自我锁死
  merged_into       TEXT,
  -- 出处：迁入的记 engram，手记的记 dsh。source_ref 只存首次来源，幂等重迁不覆盖
  source_system     TEXT,
  source_ref        TEXT,
  created_at        TEXT NOT NULL,
  created_at_local  TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  updated_at_local  TEXT NOT NULL,
  deletion_epoch    INTEGER NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_entities_scope_name
  ON entities (scope_id, name);
CREATE INDEX IF NOT EXISTS ix_entities_kind
  ON entities (scope_id, kind, status);
CREATE INDEX IF NOT EXISTS ix_entities_source_ref
  ON entities (source_system, source_ref);

-- ---------------------------------------------------------------------------
-- 2. memory_entities —— 记忆 ↔ 实体（多对多）。
--    主键就是幂等：同一条记忆挂同一个实体只会有一行。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id        TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  -- 可选：这条记忆里该实体扮演什么（subject / object / context）。不知道就 NULL，
  -- 不填占位值——占位值会在统计里变成假分布。
  role             TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX IF NOT EXISTS ix_memory_entities_entity
  ON memory_entities (entity_id);

-- ---------------------------------------------------------------------------
-- 3. memory_edges —— 记忆 ↔ 记忆的有向关系。
--    supersedes 与 memories.supersedes 列并存：列是「这条被哪条取代」的快照，
--    边是完整图；写入方必须两边一致（见 entities.js 的说明）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_edges (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  from_memory_id   TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL
                     CHECK (kind IN ('supersedes', 'contradicts', 'supports', 'refines')),
  reason           TEXT,
  source_system    TEXT,
  source_ref       TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  deletion_epoch   INTEGER NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  -- 自环没有语义；允许它就等于允许「这条记忆和它自己矛盾」
  CHECK (from_memory_id <> to_memory_id)
);

-- 同一条边只留一行：重复 link 幂等
CREATE UNIQUE INDEX IF NOT EXISTS ux_memory_edges_triple
  ON memory_edges (from_memory_id, to_memory_id, kind);
CREATE INDEX IF NOT EXISTS ix_memory_edges_from
  ON memory_edges (from_memory_id, kind);
CREATE INDEX IF NOT EXISTS ix_memory_edges_to
  ON memory_edges (to_memory_id, kind);
