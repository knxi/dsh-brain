-- ============================================================================
-- 0001_init.down.sql — 回滚 0001（仅用于演练/测试与明确授权的降级）
--
-- 注意（设计 21.8）：不是所有 down migration 都无损。本文件会丢弃全部主账数据，
-- 只保证「schema 回到空库」这一个语义；生产降级必须用升级前备份，而不是靠它。
-- `schema_migrations` 表由迁移器保留（回滚记录需要它），这里不 DROP。
-- ============================================================================

DROP TABLE IF EXISTS audit_logs;
DROP TABLE IF EXISTS backups;
DROP TABLE IF EXISTS deletion_jobs;
DROP TABLE IF EXISTS deletion_tombstones;
DROP TABLE IF EXISTS consumer_offsets;
DROP TABLE IF EXISTS outbox;
DROP TABLE IF EXISTS context_packages;
DROP TABLE IF EXISTS task_snapshots;
DROP TABLE IF EXISTS summary_sources;
DROP TABLE IF EXISTS summaries;
DROP TABLE IF EXISTS source_refs;
DROP TABLE IF EXISTS memory_versions;
DROP TABLE IF EXISTS memories;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS brain_meta;
