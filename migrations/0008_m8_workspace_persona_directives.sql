-- ============================================================================
-- 0008_m8_workspace_persona_directives.sql —— 系统 3/4/5/6 的数据地基（M8）
--
-- 一次建齐四套系统的表，但**互不耦合**：谁先上线谁先写，没写的表就是空表，
-- 不影响 M1~M7 任何既有路径（它们只认 events/memories/entities/mood 那几张）。
--
-- 一、为什么独立成一大批而不是每个系统一批迁移
--   这四套系统共享「工作空间事件」这一个通信面（方案 §3.1：各模块不得互相
--   改写内部状态，统一发布结构化事件）。事件面一旦拆开建，先建的那批会缺
--   约束。宁可一次 26 张表，也别做三批互相追补的迁移。
--
-- 二、与 0001 主账口径保持一致（照抄，不发明）
--   - 时间列一律 TEXT（ISO 8601）+ 对应 *_local（本地时区展示用）；
--     例外：需要做毫秒算术的锚点列用 REAL 毫秒（如 lease_until、heartbeat_at），
--     理由与 0007 fox_state 相同——`now - lease_until > 0` 每次转 ISO 都是错的来源。
--   - 幂等靠 UNIQUE，不靠「先查后写」（并发下先查后写必然漏）。
--   - 软删除：本批表大多**不真删行**，用 status 表达生命周期。
--     查询侧必须自己过滤 status，`ON DELETE CASCADE` 帮不上忙（沿用 0006 的纪律）。
--   - 不做 BEGIN/COMMIT（迁移器已经在单事务里包住整个文件）。
--
-- 三、明确不做的事（现在写清楚，省得以后返工）
--   - **不改 memories.status 的 CHECK 枚举**。要加 'quarantined' 只能重建表，
--     风险远大于收益。免疫隔离走 immune_quarantine 独立表 + 查询侧 join 过滤。
--   - **不给 memories 加 salience 列**。显著性/情绪标记是「标记器」的输出，
--     属于另一个模块，独立表可单独回滚（memory_salience）。检索排序用 LEFT JOIN。
--   - **不做多用户表结构改造**。person_id/scope_id 一列不少，但 MVP 仍单用户；
--     所有新表都带 scope_id（除刻意全局的 brain_switches），将来开多用户不用再迁。
-- ============================================================================


-- ============================================================================
-- 第一部分：全局工作空间（系统 3 的通信面）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. ws_events —— 模块之间唯一的结构化广播面（append-only）
--
-- 方案 §3.1：各区块不得互相随意改写内部状态，统一在这里发布结构化事件。
-- 这一张表就是那句「不得互相改写」的落地物：谁想影响别人，只能发事件，
-- 别人愿不愿意消费是别人的事（消费水位在 ws_consumers）。
--
-- 为什么 channel 和 source_module 分开：
--   channel 是「什么性质的信息」（感知/注意/记忆/情感/行动/结果/错误/资源），
--   source_module 是「谁发的」（丘脑/海马/杏仁核/前额叶…）。
--   模块会被重命名或合并，channel 不会——按 channel 订阅比按模块订阅稳。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ws_events (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  at               TEXT NOT NULL,
  at_local         TEXT NOT NULL,
  -- 排序锚：events 表用 seq，这里没有全局序需求，用毫秒保证「同秒内先后」可排。
  at_ms            REAL NOT NULL,
  channel          TEXT NOT NULL CHECK (channel IN (
                     'sense',      -- 感知输入（消息、定时器、文件变化）
                     'attention',  -- 焦点变更、抢占
                     'memory',     -- 记忆写入/召回/晋升/纠错
                     'affect',     -- 情绪、精力、压力、显著性
                     'action',     -- 候选行动被提出
                     'result',     -- 行动结果（工具返回、任务完成）
                     'error',      -- 失败、异常、降级
                     'resource'    -- 预算、队列、磁盘、连接
                   )),
  source_module    TEXT NOT NULL,
  kind             TEXT NOT NULL,
  subject_type     TEXT CHECK (subject_type IS NULL OR subject_type IN (
                     'memory', 'entity', 'person', 'session', 'task',
                     'directive', 'candidate', 'skill', 'system')),
  subject_id       TEXT,
  payload_json     TEXT NOT NULL DEFAULT '{}',
  -- 显著性 [0,1]：由杏仁核（显著性标记器）打，**只影响权重不判定事实**。
  -- 0 表示「没评估过」，不等于「不重要」——消费方要能区分这两件事。
  salience         REAL NOT NULL DEFAULT 0 CHECK (salience >= 0 AND salience <= 1),
  -- 去重键：允许空（SQLite 的 UNIQUE 允许多个 NULL，正好表达「这条不去重」）。
  dedupe_key       TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  UNIQUE (scope_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS ix_ws_events_scope_ms ON ws_events (scope_id, at_ms DESC);
CREATE INDEX IF NOT EXISTS ix_ws_events_channel   ON ws_events (scope_id, channel, at_ms DESC);
CREATE INDEX IF NOT EXISTS ix_ws_events_subject   ON ws_events (subject_type, subject_id);
CREATE INDEX IF NOT EXISTS ix_ws_events_module    ON ws_events (source_module, at_ms DESC);

-- ---------------------------------------------------------------------------
-- 2. ws_consumers —— 每个模块的消费水位（相当于消费者的 offset）
--
-- 没有这张表，「广播」就会退化成「重放」：模块重启后不知道该从哪继续，
-- 要么漏事件、要么把同一件事处理三遍（重复写记忆、重复主动开口）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ws_consumers (
  scope_id      TEXT NOT NULL,
  module_name   TEXT NOT NULL,
  -- 已消费到的 ws_events.at_ms；NULL = 从没消费过（首跑从「现在」开始，不补历史）
  last_at_ms    REAL,
  last_event_id TEXT,
  consumed_count INTEGER NOT NULL DEFAULT 0 CHECK (consumed_count >= 0),
  updated_at    TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  error_count   INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
  last_error    TEXT,
  PRIMARY KEY (scope_id, module_name)
);

-- ---------------------------------------------------------------------------
-- 3. ws_candidates —— 候选意图 / 候选行动（执行控制器的仲裁输入）
--
-- 方案 §3.1 的另一半：执行控制器从候选里**选**，而不是谁来谁执行。
-- 候选必须有分数、优先级、过期时间，否则老候选会在某天突然被执行——
-- 那是最难查的一类 bug。
--
-- lease_* 是防重复执行的：一个候选被选中后加租约，租约到期没心跳就回 proposed。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ws_candidates (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'memory_write',  -- 想写一条记忆
                     'reflection',    -- 想发起一次反思
                     'proactive',     -- 想主动开口（交给系统 4 的社交仲裁）
                     'directive',     -- 想立一条自主指令（交给系统 5）
                     'maintenance',   -- 维护（索引整理、摘要重算、清理）
                     'skill_update',  -- 想校准一项技能
                     'quarantine'     -- 想隔离一段可疑内容（免疫）
                   )),
  origin_module    TEXT NOT NULL,
  title            TEXT NOT NULL,
  payload_json     TEXT NOT NULL DEFAULT '{}',
  -- 综合分 [0,100]：由执行控制器算（相关性/紧急度/关系适配/打扰成本…），
  -- 算分依据必须写进 score_breakdown_json，否则事后无法解释「为什么做了这件事」
  score            REAL NOT NULL DEFAULT 0,
  score_breakdown_json TEXT NOT NULL DEFAULT '{}',
  priority         INTEGER NOT NULL DEFAULT 50,
  status           TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                     'proposed', 'selected', 'executing', 'done',
                     'rejected', 'expired', 'failed', 'deferred')),
  -- 证据：这条候选凭什么成立（来源 event id / memory id）。无证据的候选不得执行。
  evidence_json    TEXT NOT NULL DEFAULT '[]',
  reason           TEXT,
  not_before       TEXT,
  expires_at       TEXT,
  -- 租约（status='selected'/'executing' 时有效）
  lease_owner      TEXT,
  lease_until      REAL,
  heartbeat_at     REAL,
  -- 同一来源不重复提候选
  idempotency_key  TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  decided_at       TEXT,
  UNIQUE (scope_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ix_ws_candidates_ready
  ON ws_candidates (scope_id, status, priority DESC, score DESC);
CREATE INDEX IF NOT EXISTS ix_ws_candidates_kind ON ws_candidates (scope_id, kind, status);
CREATE INDEX IF NOT EXISTS ix_ws_candidates_expiry ON ws_candidates (expires_at);
CREATE INDEX IF NOT EXISTS ix_ws_candidates_lease ON ws_candidates (lease_until);

-- ---------------------------------------------------------------------------
-- 4. attention_focus —— 当前注意力焦点（注意力网络）
--
-- 一个 scope 只有一个焦点（PRIMARY KEY 就是这条纪律）。抢占要留痕：
-- 被抢了不写审计的话，「为什么这个任务做到一半没人管了」永远查不出来。
-- 抢占记录统一写 audit_logs（现成的表，action='attention.preempt'）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attention_focus (
  scope_id         TEXT PRIMARY KEY,
  focus_kind       TEXT NOT NULL CHECK (focus_kind IN (
                     'session', 'task', 'directive', 'person', 'maintenance', 'idle')),
  focus_ref        TEXT,
  focus_label      TEXT,
  -- 焦点优先级：数字大 = 更该被保护。低优先级的内部意图不得抢占它（方案 §10「注意力占用」）
  priority         INTEGER NOT NULL DEFAULT 50,
  -- 抢占门槛：新焦点的 priority 必须 > 当前 priority + preempt_margin 才允许抢
  preempt_margin   INTEGER NOT NULL DEFAULT 10,
  acquired_at      TEXT NOT NULL,
  acquired_at_local TEXT NOT NULL,
  expires_at       TEXT,
  preempted_from   TEXT,
  preempt_count    INTEGER NOT NULL DEFAULT 0 CHECK (preempt_count >= 0),
  source           TEXT,
  reason           TEXT,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 5. memory_salience —— 记忆的显著性 / 情绪标记（杏仁核的输出）
--
-- 刻意**不写进 memories**（见文件头第三条）。一张记忆可以没有这一行——
-- 没被标记过的记忆不是「不重要」，是「还没评估」（哨兵值语义，和 events 里
-- 那些可空字段一致）。
--
-- 纪律：只影响检索权重和展示，**不得把 source_type 从 observation 改成事实**。
-- 情绪标记不是证据。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_salience (
  memory_id        TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  salience         REAL NOT NULL DEFAULT 0 CHECK (salience >= 0 AND salience <= 1),
  -- 情感效价/唤醒度 [-1,1]/[0,1]：这两项只影响「会不会被想起」，不影响「对不对」
  affect_valence   REAL CHECK (affect_valence IS NULL OR (affect_valence >= -1 AND affect_valence <= 1)),
  affect_arousal   REAL CHECK (affect_arousal IS NULL OR (affect_arousal >= 0 AND affect_arousal <= 1)),
  -- 标记依据：'event:<id>' / 'affect_observation:<id>' / 'owner_reaction'
  signals_json     TEXT NOT NULL DEFAULT '[]',
  marked_by        TEXT NOT NULL DEFAULT 'amygdala',
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
);

CREATE INDEX IF NOT EXISTS ix_memory_salience_scope ON memory_salience (scope_id, salience DESC);

-- ---------------------------------------------------------------------------
-- 6. affect_observations —— 对「对方」情绪的观察（带置信度、与自己的状态分开）
--
-- 方案 §7.3：对方情绪单独保存为带置信度的观察。
-- 为什么不能塞进 fox_state：fox_state 是「我这一个我」的单行状态（CHECK id=1），
-- 而这是「我看到的你」，可能错、可能有多个来源、要能撤回。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS affect_observations (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  person_id        TEXT NOT NULL,
  at               TEXT NOT NULL,
  at_local         TEXT NOT NULL,
  at_ms            REAL NOT NULL,
  valence          REAL CHECK (valence IS NULL OR (valence >= -1 AND valence <= 1)),
  arousal          REAL CHECK (arousal IS NULL OR (arousal >= 0 AND arousal <= 1)),
  label            TEXT,
  confidence       REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  -- 观察必须带依据：哪句话、哪个事件。没依据的是「猜」。
  evidence_json    TEXT NOT NULL DEFAULT '[]',
  source_kind      TEXT NOT NULL DEFAULT 'message' CHECK (source_kind IN (
                     'message', 'reaction', 'behavior', 'explicit', 'inference')),
  superseded_by    TEXT,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
                     'active', 'retracted', 'expired')),
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_affect_obs_person
  ON affect_observations (scope_id, person_id, at_ms DESC);
CREATE INDEX IF NOT EXISTS ix_affect_obs_status ON affect_observations (scope_id, status);

-- ---------------------------------------------------------------------------
-- 7. fox_state 补两列（压力 / 主动性）—— 方案 §7.3 要求压力单独建模
--
-- 注意 ALTER TABLE 只能加「有默认值」的列；不能加 CHECK 之外的约束。
-- 压力不写进 mood：心情差和压力大是两件事（心情低但没压力 = 累；
-- 心情正常但压力大 = 焦虑），合并成一个数字就没法做正确决策。
-- ---------------------------------------------------------------------------
ALTER TABLE fox_state ADD COLUMN stress REAL NOT NULL DEFAULT 0;
ALTER TABLE fox_state ADD COLUMN initiative REAL NOT NULL DEFAULT 0.5;


-- ============================================================================
-- 第二部分：反思 / 技能校准 / 梦境（系统 3 的默认模式网络与小脑）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 8. reflection_runs —— 一次空闲反思的批次记录
--
-- 幂等与可追溯优先于功能：每次反思必须能回答「什么时候、看了哪段时间、读了
-- 多少条、产出几条、为什么失败」。否则反思会变成每天偷偷往外吐垃圾的机器。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reflection_runs (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  trigger          TEXT NOT NULL CHECK (trigger IN ('manual', 'idle', 'scheduled', 'after_turn')),
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
                     'running', 'completed', 'failed', 'cancelled')),
  started_at       TEXT NOT NULL,
  started_at_local TEXT NOT NULL,
  finished_at      TEXT,
  -- 本次反思看的历史窗口（左闭右开，ISO）
  window_from      TEXT,
  window_to        TEXT,
  -- 读了哪些东西（表名+id 数），**不存正文**（体积与隐私）
  inputs_json      TEXT NOT NULL DEFAULT '{}',
  produced_count   INTEGER NOT NULL DEFAULT 0 CHECK (produced_count >= 0),
  promoted_count   INTEGER NOT NULL DEFAULT 0 CHECK (promoted_count >= 0),
  duration_ms      INTEGER,
  error            TEXT,
  model            TEXT
);

CREATE INDEX IF NOT EXISTS ix_reflection_runs_started
  ON reflection_runs (scope_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- 9. reflections —— 反思产出（候选洞察）
--
-- 关键纪律：默认 status='candidate'，**不能当真实经历**（方案 §10「梦境整理」
-- 与 §18.4 第 6 条）。只有 promoted 的才写进 memories，且写进去时
-- source_type 必须是 'inference'（置信度 < 1，主账 CHECK 会兜底）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS reflections (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  scope_id         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'commitment',     -- 发现未完成的承诺
                     'knowledge_gap',  -- 知识缺口
                     'pattern',        -- 行为/偏好模式
                     'diary',          -- 自我日记
                     'dream',          -- 梦境整理（明确不是事实）
                     'premonition',    -- 行动预演
                     'contradiction'   -- 发现的自相矛盾
                   )),
  text             TEXT NOT NULL,
  -- 依据：必须能指回 event/memory/skill，空数组的反思不得晋升
  evidence_json    TEXT NOT NULL DEFAULT '[]',
  confidence       REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  status           TEXT NOT NULL DEFAULT 'candidate' CHECK (status IN (
                     'candidate', 'promoted', 'dismissed', 'expired')),
  promoted_memory_id TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_reflections_status
  ON reflections (scope_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_reflections_run ON reflections (run_id);

-- ---------------------------------------------------------------------------
-- 10. skill_stats —— 技能校准（小脑）：按「工具+动作」聚合成功失败
--
-- 方案 §9.3：根据真实执行结果更新技能记忆和置信度。
-- 这里刻意只做**计数与置信度**，不做「自动改写步骤」——自动改写技能步骤
-- 一旦错一次就会一直错下去，而那正是最难发现的那类错误。
-- confidence 用 威尔逊下界 还是简单成功率？由模块决定，这列只存结果。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skill_stats (
  id                   TEXT PRIMARY KEY,
  scope_id             TEXT NOT NULL,
  -- 技能键：`<tool>` 或 `<tool>:<action>`。空 action 表示整个工具
  skill_key            TEXT NOT NULL,
  tool                 TEXT,
  action               TEXT,
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  successes            INTEGER NOT NULL DEFAULT 0 CHECK (successes >= 0),
  failures             INTEGER NOT NULL DEFAULT 0 CHECK (failures >= 0),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  confidence           REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  last_success_at      TEXT,
  last_failure_at      TEXT,
  last_error_code      TEXT,
  notes                TEXT,
  created_at           TEXT NOT NULL,
  created_at_local     TEXT NOT NULL,
  updated_at           TEXT NOT NULL,
  updated_at_local     TEXT NOT NULL,
  UNIQUE (scope_id, skill_key)
);

-- ---------------------------------------------------------------------------
-- 11. skill_lessons —— 从失败/成功中提炼的可复用经验
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skill_lessons (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  skill_key        TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('failure_reason', 'effective_step', 'precondition')),
  text             TEXT NOT NULL,
  evidence_json    TEXT NOT NULL DEFAULT '[]',
  confidence       REAL NOT NULL DEFAULT 0.5 CHECK (confidence >= 0 AND confidence <= 1),
  -- 同一原因反复出现就累加，不建新行
  occurrences      INTEGER NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  UNIQUE (scope_id, skill_key, kind, text)
);

CREATE INDEX IF NOT EXISTS ix_skill_lessons_key
  ON skill_lessons (scope_id, skill_key, kind);


-- ============================================================================
-- 第三部分：免疫与脑干（安全隔离 / 健康监控）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 12. immune_quarantine —— 可疑内容隔离区
--
-- 为什么不给 memories 加 'quarantined' 状态（见文件头）：
-- 隔离是「一段内容不可再进入上下文」，它可能还没成为记忆（比如一条注入的
-- 网页、一段异常工具输出）。把它绑在 memories 上就表达不了「非记忆内容」。
--
-- 释放（released）要留 reviewed_by 与时间——谁放出来的必须能查。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS immune_quarantine (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  at               TEXT NOT NULL,
  at_local         TEXT NOT NULL,
  at_ms            REAL NOT NULL,
  reason_code      TEXT NOT NULL CHECK (reason_code IN (
                     'prompt_injection',     -- 提示注入
                     'memory_poison',        -- 记忆投毒（伪造主人原话/权限）
                     'anomalous_tool_output',-- 工具输出异常
                     'forged_owner',         -- 伪造 owner/system 指令
                     'credential_leak',      -- 疑似凭据外泄
                     'other'
                   )),
  severity         TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high')),
  -- 隔离对象：可能在某张表的某一行，也可能只是一个摘录
  subject_table    TEXT,
  subject_id       TEXT,
  source_type      TEXT,
  source_ref       TEXT,
  -- 只存摘录（<=500 字），不存全文——隔离区自己不成为新的泄露面
  excerpt          TEXT,
  detail_json      TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'quarantined' CHECK (status IN (
                     'quarantined', 'released', 'purged')),
  reviewed_at      TEXT,
  reviewed_by      TEXT,
  notes            TEXT,
  -- 同一对象同一原因不重复挂
  dedupe_key       TEXT,
  UNIQUE (scope_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS ix_immune_status
  ON immune_quarantine (scope_id, status, at_ms DESC);
CREATE INDEX IF NOT EXISTS ix_immune_subject
  ON immune_quarantine (subject_table, subject_id);

-- ---------------------------------------------------------------------------
-- 13. health_alerts —— 健康告警（脑干 / 可观测性）
--
-- 与 /api/health 的区别：health 是「此刻的快照」，这张表是「发生过什么」。
-- 没有它，监测就只是一次次点开看；有了它，才能回答「昨天半夜库锁了多久」。
--
-- 去重口径：同一 code 同时只允许一条 open（部分唯一索引，SQLite 3.8+ 支持）。
-- 反复触发的告警累加 occurrences，而不是刷屏。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS health_alerts (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT,
  at               TEXT NOT NULL,
  at_local         TEXT NOT NULL,
  at_ms            REAL NOT NULL,
  code             TEXT NOT NULL,
  module           TEXT NOT NULL DEFAULT 'brainstem',
  severity         TEXT NOT NULL DEFAULT 'medium' CHECK (severity IN ('info', 'low', 'medium', 'high')),
  title            TEXT NOT NULL,
  detail_json      TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acked', 'resolved', 'expired')),
  occurrences      INTEGER NOT NULL DEFAULT 1 CHECK (occurrences >= 1),
  first_seen_at    TEXT NOT NULL,
  last_seen_at     TEXT NOT NULL,
  acked_at         TEXT,
  acked_by         TEXT,
  resolved_at      TEXT,
  resolution       TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_health_alerts_open
  ON health_alerts (status, severity, at_ms DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_health_alerts_open_code
  ON health_alerts (code) WHERE status = 'open';


-- ============================================================================
-- 第四部分：人格（系统 4 上半）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 14. persona_profiles —— 一份人格档案（可以有多个来源，一个默认）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS persona_profiles (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  name             TEXT NOT NULL,
  -- 人格本体仍然在 ~/.dsh/AGENTS.md；这里存的是**解析后的结构化版本**与激活状态。
  -- 不搬家：宿主的人格文件是主人手写的，Brain 只读不接管（方案 §7.7「导入」不是「夺权」）。
  source_type      TEXT NOT NULL DEFAULT 'agents_md' CHECK (source_type IN (
                     'agents_md', 'markdown', 'json', 'yaml', 'manual')),
  source_path      TEXT,
  source_hash      TEXT,
  is_default       INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'archived')),
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  UNIQUE (scope_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_persona_profiles_default
  ON persona_profiles (scope_id) WHERE is_default = 1;

-- ---------------------------------------------------------------------------
-- 15. persona_versions —— 人格版本（分层合成 + 差异 + 回滚）
--
-- 方案 §7.7 五层：locked / base / learned / user_override / transient。
-- 全部塞进 layers_json，因为每层的字段集合会变；用列存的话每加一个字段就要
-- 一次迁移，而人格字段的迭代频率远高于表结构。
--
-- 只允许一个 active（部分唯一索引）：两个人格同时激活会让注入内容自相矛盾。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS persona_versions (
  id               TEXT PRIMARY KEY,
  profile_id       TEXT NOT NULL,
  scope_id         TEXT NOT NULL,
  version          INTEGER NOT NULL CHECK (version >= 1),
  parent_version   INTEGER,
  source_hash      TEXT,
  -- { locked:{...}, base:{...}, learned:{...}, userOverride:{...}, transient:{...} }
  layers_json      TEXT NOT NULL DEFAULT '{}',
  -- 导入时发现的冲突 [{field, kind, old, new, resolution}]
  conflicts_json   TEXT NOT NULL DEFAULT '[]',
  -- 与父版本的字段级差异 {added:[], removed:[], changed:[]}
  diff_json        TEXT NOT NULL DEFAULT '{}',
  -- 每次上下文只注入这一份精简版（方案 §7.7 最后一句：避免重复占 Token）
  rendered_text    TEXT,
  token_estimate   INTEGER,
  change_reason    TEXT,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                     'draft', 'active', 'superseded', 'rolled_back', 'rejected')),
  activated_at     TEXT,
  deactivated_at   TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  created_by       TEXT,
  UNIQUE (profile_id, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_persona_versions_active
  ON persona_versions (profile_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS ix_persona_versions_profile
  ON persona_versions (profile_id, version DESC);

-- ---------------------------------------------------------------------------
-- 16. persona_conflicts —— 人格合并时的字段冲突（必须人工确认）
--
-- 方案 §7.7：标出身份、边界和表达风格冲突，生成合并预览及差异报告。
-- 冲突**不允许自动消解**：身份和边界上的自动消解等于自己给自己改底线。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS persona_conflicts (
  id               TEXT PRIMARY KEY,
  profile_id       TEXT NOT NULL,
  from_version     INTEGER,
  to_version       INTEGER,
  layer            TEXT NOT NULL CHECK (layer IN (
                     'locked', 'base', 'learned', 'user_override', 'transient')),
  field            TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('identity', 'boundary', 'style', 'preference', 'contradiction')),
  old_value        TEXT,
  new_value        TEXT,
  detail           TEXT,
  resolution       TEXT NOT NULL DEFAULT 'unresolved' CHECK (resolution IN (
                     'unresolved', 'keep_old', 'keep_new', 'merged', 'deferred')),
  resolved_at      TEXT,
  resolved_by      TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_persona_conflicts_open
  ON persona_conflicts (profile_id, resolution);


-- ============================================================================
-- 第五部分：人物模型 / 关系 / 主动社交（系统 4 下半）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 17. person_models —— 每个用户独立的资料与互动风格（不共享）
--
-- 方案 §7.4：核心人格共享，用户资料/关系/风格/社交策略/情绪观察**不共享**。
-- 新用户冷启动必须是保守的（不能因为别人亲就对这个也亲）——这一条靠
-- DEFAULT 值实现：新建行的 closeness 一律从低起步，不继承任何全局值。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_models (
  scope_id         TEXT NOT NULL,
  person_id        TEXT NOT NULL,
  display_name     TEXT,
  aliases_json     TEXT NOT NULL DEFAULT '[]',
  -- { replyLength:'short|normal|long', address:'称呼', humor:0-1, questionTolerance:0-1, shareTolerance:0-1 }
  style_json       TEXT NOT NULL DEFAULT '{}',
  -- 冷启动标记：0=用户主动配置过，1=系统按保守默认建的
  cold_start       INTEGER NOT NULL DEFAULT 1 CHECK (cold_start IN (0, 1)),
  person_model_version INTEGER NOT NULL DEFAULT 1 CHECK (person_model_version >= 1),
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  PRIMARY KEY (scope_id, person_id)
);

-- ---------------------------------------------------------------------------
-- 18. relationship_states —— 关系四维（熟悉/信任/亲密/好感，不合并成一个数）
--
-- 方案 §7.2：分别保存，不合并成单一数值。
-- 为什么不合并：一个人可以「很熟但不信任」，合并成一个数字就把这个区别抹掉了，
-- 而这个区别恰恰决定「能不能托付事情」。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS relationship_states (
  scope_id         TEXT NOT NULL,
  person_id        TEXT NOT NULL,
  familiarity      REAL NOT NULL DEFAULT 0.1 CHECK (familiarity >= 0 AND familiarity <= 1),
  trust            REAL NOT NULL DEFAULT 0.1 CHECK (trust >= 0 AND trust <= 1),
  intimacy         REAL NOT NULL DEFAULT 0.1 CHECK (intimacy >= 0 AND intimacy <= 1),
  rapport          REAL NOT NULL DEFAULT 0.1 CHECK (rapport >= 0 AND rapport <= 1),
  -- 每次变更的幅度上限由模块守（这里存不上限，因为上限是策略不是数据）
  basis_json       TEXT NOT NULL DEFAULT '[]',
  version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  last_change_at   TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  PRIMARY KEY (scope_id, person_id)
);

-- ---------------------------------------------------------------------------
-- 19. relationship_events —— 关系变化的依据（每次变化必须有事件）
--
-- 方案 §7.2：变化必须有事件依据、幅度限制和时间戳。
-- 这张表就是「依据」。没有它，关系数字就是一堆来路不明的浮点数。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS relationship_events (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  person_id        TEXT NOT NULL,
  at               TEXT NOT NULL,
  at_local         TEXT NOT NULL,
  at_ms            REAL NOT NULL,
  kind             TEXT NOT NULL,
  delta_familiarity REAL NOT NULL DEFAULT 0,
  delta_trust      REAL NOT NULL DEFAULT 0,
  delta_intimacy   REAL NOT NULL DEFAULT 0,
  delta_rapport    REAL NOT NULL DEFAULT 0,
  -- 这条变化由什么引起：event / memory / interaction 的 id
  evidence_ref     TEXT,
  notes            TEXT,
  idempotency_key  TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  UNIQUE (scope_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ix_relationship_events_person
  ON relationship_events (scope_id, person_id, at_ms DESC);

-- ---------------------------------------------------------------------------
-- 20. proactive_policies —— 每个用户的主动社交策略（免打扰/上限/冷却）
--
-- 方案 §7.5：每个用户独立设置免打扰时段、每日上限、同类问题冷却时间。
-- 注意默认值是「保守」：enabled=1 但 daily_cap=2、max_pending=1。
-- 宁可少说一句，也不做那个烦人的东西。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS proactive_policies (
  scope_id         TEXT NOT NULL,
  person_id        TEXT NOT NULL,
  enabled          INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- [{"from":"00:00","to":"07:30"}]，本地时区
  quiet_hours_json TEXT NOT NULL DEFAULT '[]',
  daily_cap        INTEGER NOT NULL DEFAULT 2 CHECK (daily_cap >= 0),
  cooldown_minutes INTEGER NOT NULL DEFAULT 180 CHECK (cooldown_minutes >= 0),
  -- {"未完成的关心":1440} 之类，按话题冷却
  topic_cooldowns_json TEXT NOT NULL DEFAULT '{}',
  max_pending      INTEGER NOT NULL DEFAULT 1 CHECK (max_pending >= 0),
  -- 允许的发送通道：console=只进控制台等人批；im=允许外发（默认关闭）
  channels_json    TEXT NOT NULL DEFAULT '["console"]',
  policy_version   INTEGER NOT NULL DEFAULT 1 CHECK (policy_version >= 1),
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  PRIMARY KEY (scope_id, person_id)
);

-- ---------------------------------------------------------------------------
-- 21. social_candidates —— 主动社交候选（候选生成器 → 评分 → 仲裁 → 发送）
--
-- 方案 §7.5 的标准链路：**不能由模型临时起意直接发送**。
-- 所以候选必须先在表里，再过评分，再被仲裁，才可能进发送队列。
--
-- 状态机：
--   proposed → scored → awaiting_approval → scheduled → sent → answered
--                    ↘ rejected / expired / cancelled
-- 纪律：awaiting_approval 之后的每一步都要写 social_sends 或审计；
--      没有 delivery_mode='approved' 的发送不得出现（外发默认关闭）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS social_candidates (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  person_id        TEXT NOT NULL,
  -- 候选来源（方案 §7.5 七类来源）
  source           TEXT NOT NULL CHECK (source IN (
                     'schedule',          -- 时间与作息
                     'unfinished_care',   -- 未完成的关心（上次提到生病/疲惫）
                     'commitment',        -- 承诺与事件（截止/纪念日）
                     'discovery',         -- 真实发现（查到了/整理好了/做完了）
                     'shared_memory',     -- 共同记忆
                     'verification',      -- 偏好/记忆核验（只问一次）
                     'curiosity'          -- 好奇与知识缺口
                   )),
  topic            TEXT,
  text             TEXT NOT NULL,
  -- 真实性证据：'我查到了' 这类表述必须有真实工具/任务记录（方案 §7.5 内容真实性）
  evidence_json    TEXT NOT NULL DEFAULT '[]',
  score            REAL NOT NULL DEFAULT 0,
  score_breakdown_json TEXT NOT NULL DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                     'proposed', 'scored', 'awaiting_approval', 'scheduled',
                     'sent', 'answered', 'rejected', 'expired', 'cancelled')),
  reason           TEXT,
  policy_version   INTEGER,
  scheduled_for    TEXT,
  expires_at       TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  decided_at       TEXT,
  -- 同一来源同一话题当天不重复提
  idempotency_key  TEXT,
  UNIQUE (scope_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ix_social_candidates_queue
  ON social_candidates (scope_id, person_id, status, score DESC);
CREATE INDEX IF NOT EXISTS ix_social_candidates_pending
  ON social_candidates (status, scheduled_for);

-- ---------------------------------------------------------------------------
-- 22. social_sends —— 主动消息发送记录（含 dry_run）
--
-- delivery_mode 是这张表的良心：
--   dry_run  = 只是想让主人看见「我本来会说什么」，没有真发出去
--   approved = 主人/策略批准后真发
-- 任何统计「主动社交发了多少」的口径都必须按 mode 分开，否则数字是假的。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS social_sends (
  id               TEXT PRIMARY KEY,
  candidate_id     TEXT NOT NULL,
  scope_id         TEXT NOT NULL,
  channel          TEXT NOT NULL DEFAULT 'console' CHECK (channel IN ('console', 'im', 'other')),
  delivery_mode    TEXT NOT NULL DEFAULT 'dry_run' CHECK (delivery_mode IN ('dry_run', 'approved')),
  at               TEXT NOT NULL,
  at_local         TEXT NOT NULL,
  at_ms            REAL NOT NULL,
  ok               INTEGER NOT NULL DEFAULT 0 CHECK (ok IN (0, 1)),
  error            TEXT,
  external_id      TEXT,
  receipt_json     TEXT NOT NULL DEFAULT '{}',
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_social_sends_candidate ON social_sends (candidate_id);
CREATE INDEX IF NOT EXISTS ix_social_sends_at ON social_sends (scope_id, at_ms DESC);

-- ---------------------------------------------------------------------------
-- 23. response_decisions —— 回复/简短/延迟/拒绝/沉默的决策留痕
--
-- 方案 §7.6：沉默也记录为 response_decision，保存原因类别和策略版本，
-- 但**不伪造「已读」或对方态度**。
-- 为什么必须留痕：没有它，「为什么这条消息没回」就永远只能猜。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS response_decisions (
  id               TEXT PRIMARY KEY,
  scope_id         TEXT NOT NULL,
  person_id        TEXT,
  session_id       TEXT,
  at               TEXT NOT NULL,
  at_local         TEXT NOT NULL,
  at_ms            REAL NOT NULL,
  decision         TEXT NOT NULL CHECK (decision IN (
                     'reply', 'brief_reply', 'delay', 'decline', 'silent')),
  input_kind       TEXT NOT NULL DEFAULT 'message' CHECK (input_kind IN (
                     'owner_message', 'social_input', 'system_event', 'maintenance')),
  reason_category  TEXT,
  -- 沉默被禁止的场景必须能被测出来：'formal_task'/'correction'/'forget'/
  -- 'permission'/'stop'/'commitment' 这些落了 silent 就是 bug，测试会抓
  protected_kind   TEXT,
  policy_version   INTEGER,
  notes            TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_response_decisions_at
  ON response_decisions (scope_id, at_ms DESC);
CREATE INDEX IF NOT EXISTS ix_response_decisions_decision
  ON response_decisions (scope_id, decision, at_ms DESC);


-- ============================================================================
-- 第六部分：自主指令（系统 5）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 24. directives —— 指令对象（长期目标 → 有权限、预算、优先级、停止条件的任务）
--
-- 方案 §8.2 的字段一个不少。**idempotency_key 是必须的**：
-- 重启后重复执行同一指令是这类系统最经典的伤害（「怎么又发了一遍」）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS directives (
  id                  TEXT PRIMARY KEY,
  scope_id            TEXT NOT NULL,
  source              TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner', 'internal', 'maintenance')),
  parent_goal_id      TEXT,
  title               TEXT NOT NULL,
  reason              TEXT,
  trigger             TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN (
                        'manual', 'schedule', 'event', 'idle', 'commitment')),
  priority            INTEGER NOT NULL DEFAULT 40 CHECK (priority >= 0 AND priority <= 100),
  preconditions_json  TEXT NOT NULL DEFAULT '[]',
  allowed_tools_json  TEXT NOT NULL DEFAULT '[]',
  -- L0 只回复 / L1 只读+内部维护 / L2 白名单可逆本地任务 / L3 已授权长期指令
  permission_scope    TEXT NOT NULL DEFAULT 'L0' CHECK (permission_scope IN ('L0', 'L1', 'L2', 'L3')),
  step_budget         INTEGER NOT NULL DEFAULT 10 CHECK (step_budget >= 0),
  time_budget_seconds INTEGER NOT NULL DEFAULT 300 CHECK (time_budget_seconds >= 0),
  token_budget        INTEGER NOT NULL DEFAULT 20000 CHECK (token_budget >= 0),
  max_retries         INTEGER NOT NULL DEFAULT 2 CHECK (max_retries >= 0),
  valid_until         TEXT,
  stop_conditions_json TEXT NOT NULL DEFAULT '["goal_completed","owner_interrupted","missing_required_permission"]',
  status              TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                        'proposed', 'awaiting_approval', 'queued', 'running',
                        'paused', 'blocked', 'completed', 'failed', 'cancelled')),
  -- 已用掉的预算（跨 run 累计，重启不清零）
  steps_used          INTEGER NOT NULL DEFAULT 0 CHECK (steps_used >= 0),
  tokens_used         INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error          TEXT,
  idempotency_key     TEXT NOT NULL,
  version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_by          TEXT,
  created_at          TEXT NOT NULL,
  created_at_local    TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  updated_at_local    TEXT NOT NULL,
  finished_at         TEXT,
  UNIQUE (scope_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS ix_directives_queue
  ON directives (scope_id, status, priority DESC, created_at ASC);
CREATE INDEX IF NOT EXISTS ix_directives_parent ON directives (parent_goal_id);

-- ---------------------------------------------------------------------------
-- 25. directive_runs —— 一次执行（带租约与心跳，防重启重复执行）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS directive_runs (
  id               TEXT PRIMARY KEY,
  directive_id     TEXT NOT NULL,
  scope_id         TEXT NOT NULL,
  attempt          INTEGER NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN (
                     'running', 'completed', 'failed', 'cancelled', 'timeout', 'blocked')),
  lease_owner      TEXT,
  lease_until      REAL,
  heartbeat_at     REAL,
  started_at       TEXT NOT NULL,
  started_at_local TEXT NOT NULL,
  finished_at      TEXT,
  steps_used       INTEGER NOT NULL DEFAULT 0 CHECK (steps_used >= 0),
  tokens_used      INTEGER NOT NULL DEFAULT 0 CHECK (tokens_used >= 0),
  stop_reason      TEXT,
  error            TEXT,
  result_json      TEXT NOT NULL DEFAULT '{}',
  UNIQUE (directive_id, attempt)
);

CREATE INDEX IF NOT EXISTS ix_directive_runs_directive
  ON directive_runs (directive_id, attempt DESC);
CREATE INDEX IF NOT EXISTS ix_directive_runs_lease ON directive_runs (lease_until);

-- ---------------------------------------------------------------------------
-- 26. directive_steps —— 执行步骤流水（不做冗长思维流，只留决策摘要）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS directive_steps (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL,
  scope_id         TEXT NOT NULL,
  seq              INTEGER NOT NULL CHECK (seq >= 1),
  at               TEXT NOT NULL,
  at_local         TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN (
                     'plan', 'tool', 'decision', 'note', 'error', 'stop')),
  summary          TEXT NOT NULL,
  evidence_json    TEXT NOT NULL DEFAULT '{}',
  ok               INTEGER CHECK (ok IS NULL OR ok IN (0, 1)),
  duration_ms      INTEGER,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS ix_directive_steps_run ON directive_steps (run_id, seq);

-- ---------------------------------------------------------------------------
-- 27. brain_switches —— 全局开关（停止 / 暂停 / 自主等级）
--
-- 方案 §8.5 与 §10「全局停止」：停止后不再启动新任务、取消可取消任务、
-- 保留可恢复快照。实现上就是一张 key-value 开关表：
--   autonomy.enabled       '0'|'1'   自主指令是否允许启动
--   autonomy.max_level     'L1'      当前最高权限等级
--   social.enabled         '0'|'1'   主动社交是否允许
--   social.allow_external  '0'|'1'   是否允许真外发（默认 0 = 只进控制台）
--   reflection.enabled     '0'|'1'
--   paused                 '0'|'1'   全局暂停（不区分模块）
-- 刻意**不带 scope**：全局停止就是全局，"只停某个 scope"不叫停止。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brain_switches (
  name             TEXT PRIMARY KEY,
  value            TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  updated_at_local TEXT NOT NULL,
  updated_by       TEXT,
  reason           TEXT
);

-- ---------------------------------------------------------------------------
-- 初始化开关默认值（幂等）：自主与外发默认关闭。
-- 这里 INSERT OR IGNORE 而不是 INSERT，重跑不报错也不覆盖人工改过的值。
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO brain_switches (name, value, updated_at, updated_at_local, updated_by, reason)
VALUES
  ('autonomy.enabled',      '0', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration', '默认关闭：自主指令需主人显式开启'),
  ('autonomy.max_level',    'L1', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration', '默认 L1：只读检索与内部记忆维护'),
  ('social.enabled',        '0', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration', '默认关闭：主动社交需主人显式开启'),
  ('social.allow_external', '0', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration', '默认关闭：只进控制台，不真外发'),
  ('reflection.enabled',    '0', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration', '默认关闭：空闲反思需主人显式开启'),
  ('paused',                '0', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), 'migration', '全局暂停默认关闭');
