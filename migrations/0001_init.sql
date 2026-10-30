-- ============================================================================
-- 0001_init.sql — DSH 外置大脑 M1 主账初始化
--
-- 覆盖 CONTRACTS 第 4 节 / 设计 22.1 必需 16 张表：
--   events, sessions, memories, memory_versions, source_refs, summaries,
--   summary_sources, task_snapshots, context_packages, outbox,
--   consumer_offsets, deletion_tombstones, deletion_jobs, backups,
--   audit_logs, schema_migrations
-- 另加 1 张内部元数据表 brain_meta（deletion_epoch / last_snapshot_id 等）。
--
-- 约定：
-- * 所有时间双存：`*_at` 为 UTC ISO（毫秒精度，Z 结尾），`*_at_local` 为本地时区
--   ISO（带 ±hh:mm 偏移）。见 CONTRACTS 第 4.3 节。
-- * 布尔一律 INTEGER 0/1 —— node:sqlite 不接受 JS 布尔绑定，见 docs/m1-notes.md。
-- * 枚举用 CHECK 约束，非法值在写入层就失败，不靠应用层自觉。
-- * 删除屏障：正文列允许 NULL（异步清正文后保留状态行），行不物理删除。
-- * 本文件由 packages/memory/src/migrator.js 在单个事务内执行；不得含 BEGIN/COMMIT。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 迁移账本：由迁移器 bootstrap 建表，这里用 IF NOT EXISTS 保持同一形状。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version          TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  checksum         TEXT NOT NULL,
  applied_at       TEXT NOT NULL,
  applied_at_local TEXT NOT NULL,
  duration_ms      INTEGER,
  direction        TEXT NOT NULL DEFAULT 'up' CHECK (direction IN ('up', 'down'))
);

-- ---------------------------------------------------------------------------
-- 内部元数据：全局单调 deletion_epoch、最近快照 ID、库代次。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain_meta (
  key              TEXT PRIMARY KEY,
  value            TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 1. events —— 原始事件，唯一事实来源。
--    唯一键 (source_system, scope_id, source_event_id)；同键不同正文 = 冲突。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  event_id            TEXT PRIMARY KEY,
  schema_version      INTEGER NOT NULL DEFAULT 1 CHECK (schema_version >= 1),
  source_system       TEXT NOT NULL,
  source_event_id     TEXT NOT NULL,
  scope_id            TEXT NOT NULL,
  person_id           TEXT NOT NULL,
  session_id          TEXT NOT NULL,
  turn_id             TEXT,
  step_id             TEXT,
  source_seq          INTEGER NOT NULL CHECK (source_seq >= 0),
  event_type          TEXT NOT NULL,
  origin_system       TEXT NOT NULL,
  causation_id        TEXT,
  derived_from        TEXT NOT NULL DEFAULT '[]',
  payload_ref         TEXT NOT NULL,
  payload_hash        TEXT NOT NULL,
  payload_text        TEXT,
  payload_bytes       INTEGER CHECK (payload_bytes IS NULL OR payload_bytes >= 0),
  privacy             TEXT NOT NULL CHECK (privacy IN ('public', 'private', 'secret')),
  occurred_at         TEXT NOT NULL,
  occurred_at_local   TEXT NOT NULL,
  received_at         TEXT NOT NULL,
  received_at_local   TEXT NOT NULL,
  time_zone           TEXT NOT NULL,
  content_fingerprint TEXT NOT NULL,
  deletion_epoch      INTEGER NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  created_at          TEXT NOT NULL,
  created_at_local    TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_events_source_key
  ON events (source_system, scope_id, source_event_id);
CREATE INDEX IF NOT EXISTS ix_events_session_seq
  ON events (session_id, source_seq);
CREATE INDEX IF NOT EXISTS ix_events_scope_seq
  ON events (scope_id, source_seq);
CREATE INDEX IF NOT EXISTS ix_events_occurred
  ON events (occurred_at);
CREATE INDEX IF NOT EXISTS ix_events_type
  ON events (event_type);
CREATE INDEX IF NOT EXISTS ix_events_fingerprint
  ON events (content_fingerprint);

-- ---------------------------------------------------------------------------
-- 2. sessions —— 会话投影：last_source_seq 只增不减（乱序到达不倒退）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  session_id        TEXT PRIMARY KEY,
  scope_id          TEXT NOT NULL,
  person_id         TEXT NOT NULL,
  source_system     TEXT NOT NULL,
  started_at        TEXT,
  started_at_local  TEXT,
  last_event_at     TEXT,
  last_event_at_local TEXT,
  last_source_seq   INTEGER CHECK (last_source_seq IS NULL OR last_source_seq >= 0),
  event_count       INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  deletion_epoch    INTEGER NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  created_at        TEXT NOT NULL,
  created_at_local  TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  updated_at_local  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_sessions_scope
  ON sessions (scope_id);

-- ---------------------------------------------------------------------------
-- 3. memories —— 记忆条目（字段对齐 CONTRACTS 第 5 节 / 设计 4.3）。
--    推断必须 confidence < 1，不得伪装成确定事实。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
  id                   TEXT PRIMARY KEY,
  person_id            TEXT,
  scope_id             TEXT NOT NULL,
  layer                TEXT NOT NULL CHECK (layer IN ('fragment', 'long', 'permanent')),
  type                 TEXT NOT NULL CHECK (type IN (
                         'profile', 'episode', 'semantic', 'commitment',
                         'skill', 'self', 'relationship', 'boundary')),
  content              TEXT,
  summary              TEXT,
  source_type          TEXT NOT NULL CHECK (source_type IN (
                         'owner_words', 'observation', 'inference', 'web', 'tool', 'summary')),
  source_ids           TEXT NOT NULL DEFAULT '[]',
  confidence           REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  importance           REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  privacy              TEXT NOT NULL DEFAULT 'private'
                         CHECK (privacy IN ('public', 'private', 'secret')),
  status               TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN (
                         'candidate', 'active', 'superseded', 'expired',
                         'suppressed', 'archived', 'deleted')),
  created_at           TEXT NOT NULL,
  created_at_local     TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  updated_at_local     TEXT NOT NULL,
  last_mentioned_at    TEXT,
  last_mentioned_at_local TEXT,
  last_recalled_at     TEXT,
  last_recalled_at_local  TEXT,
  mention_count        INTEGER NOT NULL DEFAULT 0 CHECK (mention_count >= 0),
  recall_count         INTEGER NOT NULL DEFAULT 0 CHECK (recall_count >= 0),
  valid_from           TEXT,
  valid_from_local     TEXT,
  valid_until          TEXT,
  valid_until_local    TEXT,
  supersedes           TEXT,
  pinned               INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  version              INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  embedding_version    TEXT,
  content_hash         TEXT,
  deletion_epoch       INTEGER NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  CHECK (source_type <> 'inference' OR confidence < 1.0)
);

CREATE INDEX IF NOT EXISTS ix_memories_status
  ON memories (status);
CREATE INDEX IF NOT EXISTS ix_memories_scope_layer
  ON memories (scope_id, layer, status);
CREATE INDEX IF NOT EXISTS ix_memories_type
  ON memories (type, status);
CREATE INDEX IF NOT EXISTS ix_memories_supersedes
  ON memories (supersedes);
CREATE INDEX IF NOT EXISTS ix_memories_valid_until
  ON memories (valid_until);

-- ---------------------------------------------------------------------------
-- 4. memory_versions —— 逐版本留痕；纠错保留被取代链。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_versions (
  memory_id       TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version         INTEGER NOT NULL CHECK (version >= 1),
  content         TEXT,
  summary         TEXT,
  status          TEXT NOT NULL CHECK (status IN (
                    'candidate', 'active', 'superseded', 'expired',
                    'suppressed', 'archived', 'deleted')),
  source_type     TEXT,
  source_ids      TEXT NOT NULL DEFAULT '[]',
  confidence      REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  importance      REAL CHECK (importance IS NULL OR (importance >= 0 AND importance <= 1)),
  privacy         TEXT NOT NULL CHECK (privacy IN ('public', 'private', 'secret')),
  supersedes      TEXT,
  changed_by      TEXT NOT NULL,
  change_reason   TEXT,
  content_hash    TEXT,
  payload_hash    TEXT,
  created_at      TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  PRIMARY KEY (memory_id, version)
);

CREATE INDEX IF NOT EXISTS ix_memory_versions_created
  ON memory_versions (created_at);

-- ---------------------------------------------------------------------------
-- 5. source_refs —— 记忆 → 原始来源；independent_source_key 防循环计数
--    （自身注入/工具回传/摘要转述不得当成新的独立事实证据）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS source_refs (
  ref_id                  TEXT PRIMARY KEY,
  memory_id               TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  source_kind             TEXT NOT NULL CHECK (source_kind IN (
                            'event', 'summary', 'document', 'url', 'tool_call')),
  event_id                TEXT REFERENCES events(event_id) ON DELETE SET NULL,
  source_system           TEXT,
  source_event_id         TEXT,
  doc_ref                 TEXT,
  locator                 TEXT,
  content_hash            TEXT,
  independent_source_key  TEXT NOT NULL,
  created_at              TEXT NOT NULL,
  created_at_local        TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_source_refs_memory_event
  ON source_refs (memory_id, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_source_refs_memory
  ON source_refs (memory_id);
CREATE INDEX IF NOT EXISTS ix_source_refs_independent
  ON source_refs (independent_source_key);

-- ---------------------------------------------------------------------------
-- 6. summaries —— 层级摘要（可重建派生数据，正文可被删除屏障清空）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS summaries (
  summary_id          TEXT PRIMARY KEY,
  scope_id            TEXT NOT NULL,
  person_id           TEXT,
  summary_kind        TEXT NOT NULL CHECK (summary_kind IN ('canonical', 'window', 'task')),
  level               INTEGER NOT NULL DEFAULT 0 CHECK (level >= 0),
  parent_summary_id   TEXT REFERENCES summaries(summary_id) ON DELETE SET NULL,
  content             TEXT,
  token_estimate      INTEGER CHECK (token_estimate IS NULL OR token_estimate >= 0),
  status              TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'stale', 'suppressed', 'deleted')),
  source_watermark    INTEGER,
  deletion_epoch      INTEGER NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  valid_from          TEXT,
  valid_from_local    TEXT,
  valid_until         TEXT,
  valid_until_local   TEXT,
  content_hash        TEXT,
  created_at          TEXT NOT NULL,
  created_at_local    TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  updated_at_local    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_summaries_scope_level
  ON summaries (scope_id, level, status);
CREATE INDEX IF NOT EXISTS ix_summaries_parent
  ON summaries (parent_summary_id);

-- ---------------------------------------------------------------------------
-- 7. summary_sources —— 摘要 → 来源（事件/记忆/摘要），支撑 reverse reference。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS summary_sources (
  summary_id   TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
  source_kind  TEXT NOT NULL CHECK (source_kind IN ('event', 'memory', 'summary', 'document')),
  source_id    TEXT NOT NULL,
  ordinal      INTEGER NOT NULL DEFAULT 0 CHECK (ordinal >= 0),
  source_hash  TEXT,
  created_at   TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  PRIMARY KEY (summary_id, source_kind, source_id)
);

CREATE INDEX IF NOT EXISTS ix_summary_sources_source
  ON summary_sources (source_kind, source_id);

-- ---------------------------------------------------------------------------
-- 8. task_snapshots —— 任务快照；版本化 + 租约代次（fencing token）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_snapshots (
  snapshot_id           TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL,
  scope_id              TEXT NOT NULL,
  session_id            TEXT,
  turn_id               TEXT,
  version               INTEGER NOT NULL CHECK (version >= 1),
  source_event_watermark INTEGER,
  artifact_hashes       TEXT NOT NULL DEFAULT '[]',
  last_verified_step    TEXT,
  pending_effects       TEXT NOT NULL DEFAULT '[]',
  status                TEXT NOT NULL DEFAULT 'pending' CHECK (status IN (
                          'pending', 'in_progress', 'partial', 'completed',
                          'cancelled', 'failed', 'outcome_unknown')),
  lease_owner           TEXT,
  lease_run_generation  INTEGER NOT NULL DEFAULT 0 CHECK (lease_run_generation >= 0),
  lease_expires_at      TEXT,
  lease_expires_at_local TEXT,
  deletion_epoch        INTEGER NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  created_at            TEXT NOT NULL,
  created_at_local      TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  updated_at_local      TEXT NOT NULL,
  UNIQUE (task_id, version)
);

CREATE INDEX IF NOT EXISTS ix_task_snapshots_scope_status
  ON task_snapshots (scope_id, status);
CREATE INDEX IF NOT EXISTS ix_task_snapshots_lease
  ON task_snapshots (lease_owner, lease_expires_at);

-- ---------------------------------------------------------------------------
-- 9. context_packages —— 构包记录；built / attached / sent 三级证据边界。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS context_packages (
  context_id        TEXT PRIMARY KEY,
  scope_id          TEXT NOT NULL,
  person_id         TEXT,
  session_id        TEXT,
  turn_id           TEXT,
  policy_version    TEXT NOT NULL,
  tokenizer_id      TEXT,
  estimated_tokens  INTEGER CHECK (estimated_tokens IS NULL OR estimated_tokens >= 0),
  memory_versions   TEXT NOT NULL DEFAULT '[]',
  deletion_epoch    INTEGER NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  payload_hash      TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'built'
                      CHECK (status IN ('built', 'attached', 'sent', 'discarded', 'expired')),
  built_at          TEXT NOT NULL,
  built_at_local    TEXT NOT NULL,
  attached_at       TEXT,
  attached_at_local TEXT,
  sent_at           TEXT,
  sent_at_local     TEXT,
  expires_at        TEXT,
  expires_at_local  TEXT,
  created_at        TEXT NOT NULL,
  created_at_local  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_context_packages_session
  ON context_packages (session_id, built_at);
CREATE INDEX IF NOT EXISTS ix_context_packages_expiry
  ON context_packages (status, expires_at);

-- ---------------------------------------------------------------------------
-- 10. outbox —— 事务内工作项；主账提交后异步导出/投影。
--     失败不回滚已确认主账：保持未完成并告警。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS outbox (
  outbox_id            TEXT PRIMARY KEY,
  kind                 TEXT NOT NULL,
  dedupe_key           TEXT NOT NULL,
  aggregate_kind       TEXT,
  aggregate_id         TEXT,
  event_id             TEXT,
  payload              TEXT,
  payload_hash         TEXT,
  status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'in_progress', 'done', 'failed', 'dead')),
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts         INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  next_attempt_at      TEXT,
  next_attempt_at_local TEXT,
  last_attempt_at      TEXT,
  last_attempt_at_local TEXT,
  last_error           TEXT,
  completed_at         TEXT,
  completed_at_local   TEXT,
  deletion_epoch       INTEGER NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0),
  created_at           TEXT NOT NULL,
  created_at_local     TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  updated_at_local     TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_outbox_dedupe
  ON outbox (dedupe_key);
CREATE INDEX IF NOT EXISTS ix_outbox_ready
  ON outbox (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS ix_outbox_kind
  ON outbox (kind, status);
CREATE INDEX IF NOT EXISTS ix_outbox_event
  ON outbox (event_id);

-- ---------------------------------------------------------------------------
-- 11. consumer_offsets —— at-least-once 消费水位（每 consumer × scope × session）。
--     last_source_seq 是「已连续处理到的水位」；缺口未补齐时停止推进。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS consumer_offsets (
  consumer         TEXT NOT NULL,
  scope_id         TEXT NOT NULL,
  session_id       TEXT NOT NULL DEFAULT '',
  last_source_seq  INTEGER NOT NULL DEFAULT 0 CHECK (last_source_seq >= 0),
  last_event_id    TEXT,
  last_occurred_at TEXT,
  consumed_count   INTEGER NOT NULL DEFAULT 0 CHECK (consumed_count >= 0),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'blocked_by_gap', 'dead')),
  attempts         INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error       TEXT,
  dead_letter_at   TEXT,
  dead_letter_at_local TEXT,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  PRIMARY KEY (consumer, scope_id, session_id)
);

CREATE INDEX IF NOT EXISTS ix_consumer_offsets_status
  ON consumer_offsets (status);

-- ---------------------------------------------------------------------------
-- 12. deletion_tombstones —— 删除墓碑：先写墓碑再清正文；epoch 全局单调。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deletion_tombstones (
  tombstone_id        TEXT PRIMARY KEY,
  target_kind         TEXT NOT NULL CHECK (target_kind IN (
                        'memory', 'event', 'session', 'summary', 'source_ref',
                        'context_package', 'task_snapshot', 'scope')),
  target_id           TEXT NOT NULL,
  scope_id            TEXT NOT NULL,
  reason              TEXT NOT NULL,
  requested_by        TEXT NOT NULL,
  deletion_epoch      INTEGER NOT NULL CHECK (deletion_epoch >= 1),
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'purged', 'verified', 'failed')),
  ledger_synced_at    TEXT,
  ledger_synced_at_local TEXT,
  notes               TEXT,
  requested_at        TEXT NOT NULL,
  requested_at_local  TEXT NOT NULL,
  created_at          TEXT NOT NULL,
  created_at_local    TEXT NOT NULL,
  UNIQUE (target_kind, target_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_deletion_tombstones_epoch
  ON deletion_tombstones (deletion_epoch);
CREATE INDEX IF NOT EXISTS ix_deletion_tombstones_status
  ON deletion_tombstones (status);

-- ---------------------------------------------------------------------------
-- 13. deletion_jobs —— 异步清正文工作项；worker 完成前必须重查屏障。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deletion_jobs (
  job_id          TEXT PRIMARY KEY,
  tombstone_id    TEXT NOT NULL REFERENCES deletion_tombstones(tombstone_id) ON DELETE CASCADE,
  target_kind     TEXT NOT NULL,
  target_id       TEXT NOT NULL,
  scope_id        TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN (
                    'purge_text', 'scrub_index', 'purge_exports',
                    'drop_context_packages', 'purge_blobs')),
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'running', 'done', 'failed', 'dead')),
  attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts    INTEGER NOT NULL DEFAULT 5 CHECK (max_attempts >= 1),
  last_error      TEXT,
  deletion_epoch  INTEGER NOT NULL CHECK (deletion_epoch >= 1),
  created_at      TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  started_at      TEXT,
  started_at_local TEXT,
  finished_at     TEXT,
  finished_at_local TEXT
);

CREATE INDEX IF NOT EXISTS ix_deletion_jobs_ready
  ON deletion_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS ix_deletion_jobs_tombstone
  ON deletion_jobs (tombstone_id);

-- ---------------------------------------------------------------------------
-- 14. backups —— 一致性快照 + 校验清单；失败不得覆盖上一份有效文件。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS backups (
  backup_id         TEXT PRIMARY KEY,
  kind              TEXT NOT NULL CHECK (kind IN ('full', 'daily', 'manual', 'pre_migration')),
  path              TEXT NOT NULL,
  byte_size         INTEGER CHECK (byte_size IS NULL OR byte_size >= 0),
  sha256            TEXT,
  checklist         TEXT,
  checklist_hash    TEXT,
  schema_version    TEXT,
  deletion_epoch    INTEGER,
  source_watermark  INTEGER,
  status            TEXT NOT NULL DEFAULT 'creating'
                      CHECK (status IN ('creating', 'complete', 'verified', 'failed')),
  error             TEXT,
  created_at        TEXT NOT NULL,
  created_at_local  TEXT NOT NULL,
  verified_at       TEXT,
  verified_at_local TEXT,
  retention_until   TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_backups_path
  ON backups (path);
CREATE INDEX IF NOT EXISTS ix_backups_status
  ON backups (status, created_at);

-- ---------------------------------------------------------------------------
-- 15. audit_logs —— 审计；只记 ID/动作/结果，不记正文。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  audit_id       TEXT PRIMARY KEY,
  ts             TEXT NOT NULL,
  ts_local       TEXT NOT NULL,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  target_kind    TEXT,
  target_id      TEXT,
  scope_id       TEXT,
  result         TEXT NOT NULL DEFAULT 'ok' CHECK (result IN ('ok', 'denied', 'error')),
  detail         TEXT,
  trace_id       TEXT,
  deletion_epoch INTEGER
);

CREATE INDEX IF NOT EXISTS ix_audit_logs_ts
  ON audit_logs (ts);
CREATE INDEX IF NOT EXISTS ix_audit_logs_action
  ON audit_logs (action, ts);
