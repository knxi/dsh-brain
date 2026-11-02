-- ============================================================================
-- 0005_m3_restore.down.sql —— 回滚 0005
--
-- 只撤 schema；blob 文件本身不在这里删（GC 是显式运维动作）。
-- 注意：`ALTER TABLE ... DROP COLUMN` 在 SQLite 3.35+ 可用（本机 3.53.3 实测）。
-- ============================================================================
DROP INDEX IF EXISTS ix_blob_refs_hash;
DROP TABLE IF EXISTS blob_refs;
DROP INDEX IF EXISTS ix_blobs_created;
DROP TABLE IF EXISTS blobs;
ALTER TABLE backups DROP COLUMN label;
ALTER TABLE backups DROP COLUMN format;
