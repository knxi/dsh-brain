-- 合并同义重复记忆的回滚脚本（2026-10-30 17:50）
-- 执行了什么：tools/merge-duplicates.mjs --apply 把 5 条同义重复记忆封口（status=superseded）、
--   给保留条目记 supersedes，并删掉 4 条已无意义的 contradicts 边。
-- 备份：data/backups/brain-consistency-20261030-174932.db（VACUUM INTO 一致性快照，integrity ok）
--
-- 什么时候用它：只有「判定错了」才回滚。判定依据见 docs/OBSERVATION-2026-10-29.md 第二、七节。
-- 怎么用：node --input-type=module 内用 DatabaseSync 打开 data/brain.db（非只读）逐条 exec；
--   或用 sqlite CLI。执行前再备一份当前库。
-- 注意：memory_versions 里的 supersede 版本记录不会因为这条 SQL 消失（那是审计痕迹，本来就该留）。

UPDATE memories SET status='active', valid_until=NULL, valid_until_local=NULL, version=version+1 WHERE id='mem_a72c5c6bed9b02c695a23e80';
UPDATE memories SET supersedes=NULL, version=version+1 WHERE id='mem_8a4f77b599b142aeaa526f08';
INSERT INTO memory_edges (id, scope_id, from_memory_id, to_memory_id, kind, reason, source_system, created_at, created_at_local) VALUES ('edge_3002d21de1a9404fe4a20f04','owner-default','mem_8a4f77b599b142aeaa526f08','mem_a72c5c6bed9b02c695a23e80','contradicts','来自 Engram 迁移','restored','2026-10-30T09:50:21.133Z','2026-10-30T09:50:21.133Z');

UPDATE memories SET status='active', valid_until=NULL, valid_until_local=NULL, version=version+1 WHERE id='mem_8ed105ff55505ce79951878f';
UPDATE memories SET supersedes=NULL, version=version+1 WHERE id='mem_a2c8545eab415cfa8b090db9';
INSERT INTO memory_edges (id, scope_id, from_memory_id, to_memory_id, kind, reason, source_system, created_at, created_at_local) VALUES ('edge_6889134e52bf41660e440f0f','owner-default','mem_8ed105ff55505ce79951878f','mem_a2c8545eab415cfa8b090db9','contradicts','来自 Engram 迁移','restored','2026-10-30T09:50:21.141Z','2026-10-30T09:50:21.141Z');

UPDATE memories SET status='active', valid_until=NULL, valid_until_local=NULL, version=version+1 WHERE id='mem_ad3d9150efc939b7268b96d5';
UPDATE memories SET supersedes=NULL, version=version+1 WHERE id='mem_b2ac1eb46b936d35df1493df';
INSERT INTO memory_edges (id, scope_id, from_memory_id, to_memory_id, kind, reason, source_system, created_at, created_at_local) VALUES ('edge_68862238bfa75aa1b02cb635','owner-default','mem_ad3d9150efc939b7268b96d5','mem_b2ac1eb46b936d35df1493df','contradicts','来自 Engram 迁移','restored','2026-10-30T09:50:21.210Z','2026-10-30T09:50:21.210Z');

UPDATE memories SET status='active', valid_until=NULL, valid_until_local=NULL, version=version+1 WHERE id='mem_d15c64d56328ce0b7fe8a1d3';
UPDATE memories SET supersedes=NULL, version=version+1 WHERE id='mem_b624303a799918a286441509';
INSERT INTO memory_edges (id, scope_id, from_memory_id, to_memory_id, kind, reason, source_system, created_at, created_at_local) VALUES ('edge_818095056826a2de8b224f2a','owner-default','mem_d15c64d56328ce0b7fe8a1d3','mem_b624303a799918a286441509','contradicts','来自 Engram 迁移','restored','2026-10-30T09:50:21.215Z','2026-10-30T09:50:21.215Z');

UPDATE memories SET status='active', valid_until=NULL, valid_until_local=NULL, version=version+1 WHERE id='mem_d9eedfc310205a221c02bddc';
UPDATE memories SET supersedes=NULL, version=version+1 WHERE id='mem_b624303a799918a286441509';
