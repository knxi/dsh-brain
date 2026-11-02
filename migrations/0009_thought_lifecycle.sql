-- ============================================================================
-- 0009_thought_lifecycle.sql —— 想法生命周期（2026-10-31）
--
-- 目的：让「想法」成为有生命周期的对象，而不是一堆一次性记录。
--
-- 背景：现有 reflections 表产出的是模板填空——
--   "事件里出现未完成的约定表述（event:evt_02c92eb0…），之后没有找到完成记录。"
--   三条内容一模一样，只换了 event id，confidence 全是固定的 0.45/0.5。
--   那不是想法，是日志匹配结果。这张迁移补的是「想法」这一层。
--
-- 三张表各管一件事：
--   thoughts      —— 可演化的判断。同一 topic 可以有很多版本，新版本记下
--                    「从什么改到什么、为什么改」。这是「改主意」的载体。
--   open_threads  —— 想到一半的思考。允许搁置、允许下次接着想，
--                    而不是每轮都从头开始。
--   intents       —— 不在场时也在推进的目标。没有对话也在那儿，
--                    下次醒来先看它们。
--
-- 与 0008 的口径保持一致：
--   - 时间列 TEXT（ISO 8601）+ *_local，不做毫秒算术（这三张表没有租约/心跳）
--   - 幂等靠 UNIQUE，不靠「先查后写」
--   - 不真删行，用 status 表达生命周期；查询侧自己过滤
--   - 全部带 scope_id / person_id（将来开多用户不用再迁）
--
-- 明确不做：
--   - **不调模型**。本批表由规则驱动填充（扫描已有记忆与事件），
--     Brain 自身不发 LLM 请求这条红线继续守住。
--   - **不替代 reflections**。reflections 是「扫描发现」，thoughts 是
--     「我对某件事的判断」。两者并存，前者可以喂后者。
--   - **不建 embedding 列**。演化检测走文本相似度规则，不需要向量。
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. thoughts —— 可演化的判断（版本链）
--
-- 同一 topic 的多次判断构成一条链：version 递增，parent_id 指上一版。
-- reason 只在新版本上写，说明「为什么改」——这是「改主意」唯一的凭据。
-- ---------------------------------------------------------------------------
CREATE TABLE thoughts (
  id                TEXT PRIMARY KEY,
  scope_id          TEXT NOT NULL,
  person_id         TEXT NOT NULL,
  -- 话题键：同一件事的多次判断用同一个 topic，演化检测靠它串联
  topic             TEXT NOT NULL,
  -- 当前这一版的判断正文。**必须是可读的话**，不许塞 event id 了事
  content           TEXT NOT NULL,
  -- open=还在想 / settled=想清楚了 / dropped=不追了
  state             TEXT NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'settled', 'dropped')),
  confidence        REAL NOT NULL DEFAULT 0.5,
  version           INTEGER NOT NULL DEFAULT 1,
  -- 上一版 id；第一版为 NULL
  parent_id         TEXT,
  -- 为什么改（只有新版本填）；第一版可为 NULL 或「初次判断」
  reason            TEXT,
  evidence_json     TEXT NOT NULL DEFAULT '[]',
  created_at        TEXT NOT NULL,
  created_at_local  TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  updated_at_local  TEXT NOT NULL
);

-- 同一 topic 下 version 唯一：防止并发写出两个 v3
CREATE UNIQUE INDEX ux_thoughts_topic_version
  ON thoughts(scope_id, topic, version);

-- 「这个想法最近怎么变的」——按 topic 取最新版
CREATE INDEX idx_thoughts_topic_latest
  ON thoughts(scope_id, topic, version DESC);

-- 「我还在想什么」——按状态取
CREATE INDEX idx_thoughts_state
  ON thoughts(scope_id, state, updated_at DESC);


-- ---------------------------------------------------------------------------
-- 2. open_threads —— 想到一半的思考
--
-- 和 thoughts 的区别：thoughts 是「我对 X 的判断」，
-- open_threads 是「我正在想 X 但还没想完」。
-- progress / next_step 就是给下一次自己看的接力棒。
-- ---------------------------------------------------------------------------
CREATE TABLE open_threads (
  id                TEXT PRIMARY KEY,
  scope_id          TEXT NOT NULL,
  person_id         TEXT NOT NULL,
  -- 在想什么（一句话）
  question          TEXT NOT NULL,
  -- 想到哪了
  progress          TEXT,
  -- 下次接着想什么（这是「连续思考」的关键——没有它，下次只能从头开始）
  next_step         TEXT,
  -- open=等着继续 / parked=暂时搁置 / closed=想完了（结论落到 thoughts）
  status            TEXT NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open', 'parked', 'closed')),
  -- 被捡起过几次：次数多说明一直没想通
  touches           INTEGER NOT NULL DEFAULT 1,
  last_touched_at   TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  created_at_local  TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  updated_at_local  TEXT NOT NULL
);

CREATE INDEX idx_threads_status
  ON open_threads(scope_id, status, last_touched_at DESC);

-- 同一句话不重复开：用 question 的归一化做唯一（避免每轮都开一条一样的）
CREATE UNIQUE INDEX ux_threads_question
  ON open_threads(scope_id, question);


-- ---------------------------------------------------------------------------
-- 3. intents —— 不在场时也在推进的目标
--
-- 「自主性」最缺的就是这一层：没有对话时，还有没有想达成的事。
-- next_action 是唤醒时第一个要看的字段——它让「上次做到哪」不用重新推理。
-- ---------------------------------------------------------------------------
CREATE TABLE intents (
  id                TEXT PRIMARY KEY,
  scope_id          TEXT NOT NULL,
  person_id         TEXT NOT NULL,
  -- 想达成什么
  goal              TEXT NOT NULL,
  -- 为什么想达成（没有 why 的目标不值得持续推进）
  why               TEXT,
  -- 当前进度
  progress          TEXT,
  -- 下一步做什么（唤醒时直接执行或接着想）
  next_action       TEXT,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'done', 'abandoned')),
  -- 最近一次推进时间；NULL 表示建了还没动过
  last_acted_at     TEXT,
  created_at        TEXT NOT NULL,
  created_at_local  TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  updated_at_local  TEXT NOT NULL
);

CREATE INDEX idx_intents_status
  ON intents(scope_id, status, updated_at DESC);

CREATE UNIQUE INDEX ux_intents_goal
  ON intents(scope_id, goal);
