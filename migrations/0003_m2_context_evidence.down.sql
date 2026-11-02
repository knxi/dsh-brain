-- ===========================================================================
-- 0003_m2_context_evidence.down.sql —— 回滚构包证据列。
--
-- 纪律（CONTRACTS §11）：回滚**不承诺无损**。本文件只回滚 schema；
-- 0003 之后写入的预算 / carrier / sent 证据 / 段明细会随列一起消失。
-- 生产降级请用升级前备份，不要靠这里。
--
-- 顺序：先删索引再删列（SQLite 在被索引引用的列上 DROP COLUMN 会直接失败）。
-- ===========================================================================

DROP INDEX IF EXISTS ix_context_packages_strength;
DROP INDEX IF EXISTS ix_context_packages_turn_step;

ALTER TABLE context_packages DROP COLUMN step_id;
ALTER TABLE context_packages DROP COLUMN injected_text_hash;
ALTER TABLE context_packages DROP COLUMN diagnostics_json;
ALTER TABLE context_packages DROP COLUMN segments_json;
ALTER TABLE context_packages DROP COLUMN evidence_strength;
ALTER TABLE context_packages DROP COLUMN sent_evidence_json;
ALTER TABLE context_packages DROP COLUMN carrier;
ALTER TABLE context_packages DROP COLUMN budget_json;
