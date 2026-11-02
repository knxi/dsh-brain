-- ===========================================================================
-- 0002_m2_memory.down.sql —— 回滚 M2 记忆层的 schema 变更。
--
-- 纪律（CONTRACTS §11 / migrator.js）：
--   * 回滚**不承诺无损**。本文件只回滚 schema；0002 之后写入的数据列会随列一起
--     消失（origin_system / producer / derived_from / causation_id / goal /
--     done_steps / pending_steps / layer）。生产降级请用升级前备份，不要靠这里。
--   * 先删索引再删列：SQLite 的 `ALTER TABLE ... DROP COLUMN` 在该列被索引引用时
--     会直接失败，顺序不能反。
--   * DROP TABLE 对 fts5 虚表有效（会连带清掉影子表）。
-- ===========================================================================

-- 5. 三套检索索引（派生数据，可重建：重新 migrate 后再 reindex 即可）
DROP INDEX IF EXISTS search_ngram_doc_id;
DROP TABLE IF EXISTS search_ngram;
DROP TABLE IF EXISTS search_fts_trigram;
DROP TABLE IF EXISTS search_fts_char;

-- 4. source_refs 索引
DROP INDEX IF EXISTS ix_source_refs_system_event;

-- 3. summaries.layer
DROP INDEX IF EXISTS ix_summaries_layer;
ALTER TABLE summaries DROP COLUMN layer;

-- 2. task_snapshots 扩展列
DROP INDEX IF EXISTS ix_task_snapshots_session_turn;
ALTER TABLE task_snapshots DROP COLUMN pending_steps;
ALTER TABLE task_snapshots DROP COLUMN done_steps;
ALTER TABLE task_snapshots DROP COLUMN goal;

-- 1. memories 防循环列（先索引后列）
DROP INDEX IF EXISTS ix_memories_scope_validity;
DROP INDEX IF EXISTS ix_memories_origin;
ALTER TABLE memories DROP COLUMN causation_id;
ALTER TABLE memories DROP COLUMN derived_from;
ALTER TABLE memories DROP COLUMN producer;
ALTER TABLE memories DROP COLUMN origin_system;
