-- ===========================================================================
-- 0002_m2_memory.sql —— M2 记忆层：防循环字段、快照/摘要扩展列、三套检索索引。
--
-- 依据：docs/M2-INTERFACES.md §1.6、docs/CONTRACTS.md §5/§7/§8/§10.6/§11。
--
-- 幂等策略（照实说，不假装）：
--   * `CREATE ... IF NOT EXISTS` 部分对重复执行天然幂等。
--   * `ALTER TABLE ... ADD COLUMN` 在 SQLite 里**没有** IF NOT EXISTS。这里的幂等
--     由 migrator 的账本保证（schema_migrations 记录了 0002 的 checksum，重复
--     applyMigrations 只 skip，不会重跑 SQL）。若 0002 中途失败，迁移器在
--     BEGIN IMMEDIATE 事务里整体回滚，列不会残留，重试时从干净状态开始。
--     这正是 CONTRACTS §11 要求的「迁移 SQL 不得含 BEGIN/COMMIT」的原因。
--
-- 三套检索索引的 DDL **逐字同步** `@dsh-brain/search` 的
-- `createSearchSchemaStatements()`（契约 §1：search 只导出 SQL，由 memory 执行）。
-- 同步关系由 `tests/m2/memory/search-schema-sync.test.mjs` 逐表/逐列断言，
-- 任何一侧漂移都会让测试红，不靠人眼维护。
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. memories 新增列 —— 防循环（CONTRACTS §10.6）
--
--   实测过的闭环：Brain 注入的片段被别的引擎当「用户话语」摄入成新记忆，之后
--   在没开注入的会话里被召回并再次注入。根因是注入内容没有可识别来源。
--   所以每条记忆必须自证来源（origin_system / producer / derived_from /
--   causation_id），摄取侧才能按来源剔除自身与兄弟引擎的注入。
-- ---------------------------------------------------------------------------
ALTER TABLE memories ADD COLUMN origin_system TEXT;
ALTER TABLE memories ADD COLUMN producer TEXT;
ALTER TABLE memories ADD COLUMN derived_from TEXT NOT NULL DEFAULT '[]';
ALTER TABLE memories ADD COLUMN causation_id TEXT;

CREATE INDEX IF NOT EXISTS ix_memories_origin
  ON memories (origin_system, producer);

-- asOf 时点回看的主查询路径：按 scope + 状态 + 有效期区间在 SQL 层过滤，
-- 不是「查回来再在 JS 里筛」。
CREATE INDEX IF NOT EXISTS ix_memories_scope_validity
  ON memories (scope_id, status, valid_from, valid_until);

-- ---------------------------------------------------------------------------
-- 2. task_snapshots 新增列 —— 最小版任务快照（M2-INTERFACES §1.4）
--    目标 / 已完成步骤 / 待办步骤都是 JSON 文本，与 artifact_hashes 同风格。
-- ---------------------------------------------------------------------------
ALTER TABLE task_snapshots ADD COLUMN goal TEXT;
ALTER TABLE task_snapshots ADD COLUMN done_steps TEXT NOT NULL DEFAULT '[]';
ALTER TABLE task_snapshots ADD COLUMN pending_steps TEXT NOT NULL DEFAULT '[]';

CREATE INDEX IF NOT EXISTS ix_task_snapshots_session_turn
  ON task_snapshots (session_id, turn_id, version);

-- ---------------------------------------------------------------------------
-- 3. summaries.layer —— M2-INTERFACES §1.5 的 layer 参数
--    0001 的 summary_kind 受 CHECK 约束（canonical|window|task），M2 的 layer
--    是更上层的语义分组，单独一列承载，不改 0001 的约束（改历史迁移是禁止的）。
-- ---------------------------------------------------------------------------
ALTER TABLE summaries ADD COLUMN layer TEXT;

CREATE INDEX IF NOT EXISTS ix_summaries_layer
  ON summaries (scope_id, layer, status);

-- ---------------------------------------------------------------------------
-- 4. source_refs —— 按宿主来源回查（来源丢失判定的主路径）
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS ix_source_refs_system_event
  ON source_refs (source_system, source_event_id);

-- ---------------------------------------------------------------------------
-- 5. 三套检索索引（DDL 来自 @dsh-brain/search 的 createSearchSchemaStatements）
--
-- 分工（全部由实测决定，见 docs/search-capability-report.md）：
--   search_fts_char    unicode61 + char-space 主路（中文单字/两字/词、编号）
--   search_fts_trigram trigram + 原文，补充路（<3 字符静默 0 命中，不能当主路）
--   search_ngram       自维护倒排，覆盖度诊断 + 空结果兜底（不进正常排序）
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS search_fts_char USING fts5(
  doc_id UNINDEXED,
  body,
  tokenize = 'unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_fts_trigram USING fts5(
  doc_id UNINDEXED,
  body,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS search_ngram (
  term    TEXT    NOT NULL,
  doc_id  TEXT    NOT NULL,
  tf      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (term, doc_id)
) WITHOUT ROWID;

-- 按 doc_id 查存在性/删除必须有这条索引（实测：不加时批量索引退化成 O(n²)）。
CREATE INDEX IF NOT EXISTS search_ngram_doc_id ON search_ngram(doc_id);
