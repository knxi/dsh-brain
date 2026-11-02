-- ============================================================================
-- 0005_m3_restore.sql —— M3 备份恢复：内容寻址 blob 存储 + 备份形态标记
--
-- 依据：docs/M3-INTERFACES.md §4.1 / §4.2、docs/CONTRACTS.md §11.4。
--
-- 为什么需要新表：
--   * `blobs`      —— blob 内容寻址的元数据（hash / size / 引用计数 / 存储路径）。
--                     备份清单要记录"每个必需附件 hash"，GC 要判定"哪些 blob 还被引用"。
--   * `blob_refs`  —— 显式引用关系（谁引用了哪个 blob）。GC 的权威依据；
--                     比解析 `events.payload_ref` 字符串稳得多。
--   * `backups.format` —— M1 的平面文件备份（'file'）与 M3 的目录形态备份（'dir'）共存。
--                     默认 'file' 保证既有记录语义不变。
--
-- 兼容性：只加列 + 加表，不改既有列/约束；`ALTER TABLE ADD COLUMN` 无 IF NOT EXISTS，
-- 幂等由迁移器账本保证（重复 apply 只 skip，见 0002 注释）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. blobs —— 内容寻址、写入不可变
--    hash 用 `sha256:<64 hex>` 形式（与 CONTRACTS 的哈希风格一致）；
--    文件落点 `<blobsDir>/<hex 前两位>/<hex>`，由 storage_path 记录相对路径。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blobs (
  hash             TEXT PRIMARY KEY,
  size             INTEGER NOT NULL CHECK (size >= 0),
  content_type     TEXT,
  storage_path     TEXT,
  ref_count        INTEGER NOT NULL DEFAULT 0 CHECK (ref_count >= 0),
  source           TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  verified_at      TEXT,
  verified_at_local TEXT
);

CREATE INDEX IF NOT EXISTS ix_blobs_created
  ON blobs (created_at);

-- ---------------------------------------------------------------------------
-- 2. blob_refs —— 谁引用了 blob（GC 判定引用集）
--    owner_kind 与记忆/事件/备份的引用面一致；UNIQUE 保证重复登记幂等。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blob_refs (
  ref_id           TEXT PRIMARY KEY,
  hash             TEXT NOT NULL REFERENCES blobs(hash) ON DELETE CASCADE,
  owner_kind       TEXT NOT NULL CHECK (owner_kind IN ('event', 'source_ref', 'memory', 'summary', 'backup')),
  owner_id         TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  UNIQUE (hash, owner_kind, owner_id)
);

CREATE INDEX IF NOT EXISTS ix_blob_refs_hash
  ON blob_refs (hash);

-- ---------------------------------------------------------------------------
-- 3. backups —— 记录备份形态与人类可读标签
--    format: 'file'（M1 单文件 .db）| 'dir'（M3 目录：brain.db + manifest.json + blobs/）
-- ---------------------------------------------------------------------------
ALTER TABLE backups ADD COLUMN format TEXT NOT NULL DEFAULT 'file';
ALTER TABLE backups ADD COLUMN label TEXT;
