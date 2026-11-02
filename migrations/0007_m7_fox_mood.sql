-- ============================================================================
-- 0007_m7_fox_mood.sql —— 情感状态并入主账（M7.2）
--
-- 背景：心情 / 精力 / 亲密度原来只活在 `~/.dsh/fox-mood/state.json`，
-- 和主账是两套数据、两套备份。这份状态机（`plugins/dsh-fox-mood/core.js`）
-- 每 5 分钟演化一次，一天 288 条——**绝不能写成 memories**：那会把检索稀释成垃圾，
-- 而且「实时状态」和「跨会话记忆」是两种东西（一个是现在，一个是以前）。
-- 所以走专用表，**不进检索、不进 memories**。
--
-- 两张表的分工：
--   fox_state  —— 单行快照（`id = 1` 是 CHECK 约束，不是约定）。这一行就是「此刻的我」。
--   fox_events —— 事件流水（被夸/被返工/办成了…）。是状态变化的**原因**，
--                 用来还原「为什么心情是这样」，也供面板显示最近几条。
--
-- ── 时间列为什么两种形态（别统一，各有各的理由）──
--   * `created_at` / `updated_at` / `created_at_local` / `updated_at_local`：TEXT ISO。
--     这是主账的记账口径（CONTRACTS §11 的「时间列一律 TEXT ISO + *_local」），
--     跨表 join / 人工排查 / 备份核对都按这个形态走，不许改成毫秒。
--   * `at`（事件发生时刻）、`last_interact_at` / `last_proactive_at`：REAL 毫秒。
--     这三个值是**状态机的运算锚点**：core.js 里全是
--     `now - lastInteractAt > 30 * 60_000` 这种毫秒算术，存 ISO 每次都要
--     `Date.parse` 一遍，多一次转换就多一个时区/格式出错的地方。
--     毫秒在 REAL 里是精确的（远小于 2^53），不存在精度损失。
--
-- ── 已知取舍（刻意不做）──
--   * 不给 mood/energy/bond 加 0..100 的 CHECK：core.js 的 `clamp()` 已经保证范围，
--     再加一层 DB 约束只会让「上游算错一个浮点」变成整条写入失败，
--     而这一层的降级动作是「回退 state.json」——没必要为了抓一个永远抓不到的 bug
--     把主路径变成可能失败。门面（mood.js）里照样 clamp，那里是能报错的地方。
--   * 不给 kind 加 CHECK 枚举：情感词表属于插件（`EVENT_EFFECTS` 那 10 种），
--     主账不该硬编码插件的词表——将来加一种事件就得改 schema，代价远大于收益。
--   * 不给 note 加长度 CHECK：门面截断到 500 字，DB 层不重复管。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. fox_state —— 单行状态快照。
--    `CHECK (id = 1)` 把「只能有一行」写进 schema：多行状态会让「此刻的我」变成
--    「哪一个我」，那是设计事故而不是数据问题，必须在插入时就挡住。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fox_state (
  -- 恒为 1。不用 AUTOINCREMENT / 不自增，insert 时显式写 1。
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  -- 状态结构版本（core.js 的 `version`）。将来状态机换形状时靠它做迁移判断。
  version            INTEGER NOT NULL DEFAULT 1,
  mood               REAL NOT NULL,
  energy             REAL NOT NULL,
  bond               REAL NOT NULL,
  created_at         TEXT NOT NULL,
  created_at_local   TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  updated_at_local   TEXT NOT NULL,
  -- 上次「我们聊过」的时刻（毫秒）。空值是合法的：新库还没互动过。
  last_interact_at   REAL,
  -- 上次「我主动开口」的时刻（毫秒），喂主动引擎的频率闸门；0 / NULL = 从没主动过。
  last_proactive_at  REAL,
  -- 与主账其它表同一口径：软删除代际。本表当前不参与删除屏障，
  -- 留着这一列是为了将来真要删整条状态时不用再改 schema。
  deletion_epoch     INTEGER NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0)
);

-- ---------------------------------------------------------------------------
-- 2. fox_events —— 事件流水。
--    id 由门面生成（`fev_<hex>`），不用 AUTOINCREMENT：
--    这样「同一条事件重复写」能靠主键幂等，而不是靠自增序猜。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS fox_events (
  id               TEXT PRIMARY KEY,
  -- 事件发生的毫秒时刻（core.js 的 `at`）。
  at               REAL NOT NULL,
  -- 事件种类（praise / retasked / pushed / interesting / success / failure /
  -- late_night / long_absence / chat / rest）。不设 CHECK，理由见文件头。
  kind             TEXT NOT NULL,
  -- 一句话说明发生了什么。门面截断到 500 字。
  note             TEXT,
  -- 三维度增量，JSON 字符串（如 {"mood":7.7,"energy":1,"bond":1.9}）。
  -- 存 JSON 而不是三列的原因：事件效果是**插件**的东西，加一个维度不该动主账 schema。
  delta_json       TEXT NOT NULL DEFAULT '{}',
  -- 出处：从插件实时写进来的记 fox-mood，历史迁移记 fox-mood-import。查得到就是能追溯。
  source_system    TEXT,
  created_at       TEXT NOT NULL,
  created_at_local TEXT NOT NULL,
  deletion_epoch   INTEGER NOT NULL DEFAULT 0 CHECK (deletion_epoch >= 0)
);

-- 「最近 N 条」是这张表唯一的读取形态（面板 / 注入提示词 / 主动引擎都只看最近的），
-- 所以索引按 at 倒序建，别建正序。
CREATE INDEX IF NOT EXISTS idx_fox_events_at ON fox_events (at DESC);
