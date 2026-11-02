-- ============================================================================
-- 0007_m7_fox_mood.down.sql —— 回滚 0007
--
-- 只撤 schema 与里面的数据。这两张表**可以重建**：状态能由 state.json 回填，
-- 事件能由 state.json 的 events 数组重新迁移（`tools/import-fox-mood.mjs`）。
-- 所以不需要像删除账本那样留痕；真要保住数据请用升级前备份。
--
-- 顺序：先删索引再删表（表删了索引也没了，但保持显式便于人工核对）。
-- ============================================================================
DROP INDEX IF EXISTS idx_fox_events_at;
DROP TABLE IF EXISTS fox_events;

DROP TABLE IF EXISTS fox_state;
