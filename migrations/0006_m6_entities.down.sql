-- ============================================================================
-- 0006_m6_entities.down.sql —— 回滚 0006
--
-- 只撤 schema 与其中的数据。实体/关系可以重建（来源可重新迁移），
-- 所以不需要像删除账本那样留痕；真要保住数据请用升级前备份。
-- 顺序：先删索引再删表（表删了索引也没了，但保持显式便于人工核对）。
-- ============================================================================
DROP INDEX IF EXISTS ix_memory_edges_to;
DROP INDEX IF EXISTS ix_memory_edges_from;
DROP INDEX IF EXISTS ux_memory_edges_triple;
DROP TABLE IF EXISTS memory_edges;

DROP INDEX IF EXISTS ix_memory_entities_entity;
DROP TABLE IF EXISTS memory_entities;

DROP INDEX IF EXISTS ix_entities_source_ref;
DROP INDEX IF EXISTS ix_entities_kind;
DROP INDEX IF EXISTS ux_entities_scope_name;
DROP TABLE IF EXISTS entities;
