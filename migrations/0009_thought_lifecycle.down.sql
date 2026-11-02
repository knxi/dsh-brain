-- 0009 down —— 回滚想法生命周期三张表。
-- 先删索引再删表（SQLite 删表会连带删索引，但显式写出来便于人工核对）。
-- 注意：这三张表里只有本系统自己写的数据，回滚即丢；执行前先确认没有值得保留的想法。

DROP INDEX IF EXISTS idx_thoughts_state;
DROP INDEX IF EXISTS idx_thoughts_topic_latest;
DROP INDEX IF EXISTS ux_thoughts_topic_version;
DROP TABLE IF EXISTS thoughts;

DROP INDEX IF EXISTS idx_threads_status;
DROP INDEX IF EXISTS ux_threads_question;
DROP TABLE IF EXISTS open_threads;

DROP INDEX IF EXISTS idx_intents_status;
DROP INDEX IF EXISTS ux_intents_goal;
DROP TABLE IF EXISTS intents;
