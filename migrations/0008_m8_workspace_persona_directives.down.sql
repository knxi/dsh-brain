-- ============================================================================
-- 0008_m8_workspace_persona_directives.down.sql —— 回滚 0008
--
-- 回滚顺序 = 建的逆序。所有表都是本迁移新建的，直接 DROP 即可。
-- 唯一不是「纯 DROP」的是 fox_state 的两列：ALTER TABLE DROP COLUMN。
-- 本机 SQLite 3.53.3 支持（0005 down 已用过同一手法）。
--
-- **不承诺无损**：回滚会连带丢掉这四套系统已经积累的所有数据
-- （工作空间事件、反思产出、人格版本、社交候选、指令）。生产降级请用
-- 升级前备份（deletion-ledger 之外的 data/backups/），不要靠这条 down。
-- ============================================================================

-- ---- 第六部分：自主指令 ----
DROP INDEX IF EXISTS ix_directive_steps_run;
DROP TABLE IF EXISTS directive_steps;
DROP INDEX IF EXISTS ix_directive_runs_lease;
DROP INDEX IF EXISTS ix_directive_runs_directive;
DROP TABLE IF EXISTS directive_runs;
DROP INDEX IF EXISTS ix_directives_parent;
DROP INDEX IF EXISTS ix_directives_queue;
DROP TABLE IF EXISTS directives;
DROP TABLE IF EXISTS brain_switches;

-- ---- 第五部分：人物模型 / 关系 / 主动社交 ----
DROP INDEX IF EXISTS ix_response_decisions_decision;
DROP INDEX IF EXISTS ix_response_decisions_at;
DROP TABLE IF EXISTS response_decisions;
DROP INDEX IF EXISTS ix_social_sends_at;
DROP INDEX IF EXISTS ix_social_sends_candidate;
DROP TABLE IF EXISTS social_sends;
DROP INDEX IF EXISTS ix_social_candidates_pending;
DROP INDEX IF EXISTS ix_social_candidates_queue;
DROP TABLE IF EXISTS social_candidates;
DROP TABLE IF EXISTS proactive_policies;
DROP INDEX IF EXISTS ix_relationship_events_person;
DROP TABLE IF EXISTS relationship_events;
DROP TABLE IF EXISTS relationship_states;
DROP TABLE IF EXISTS person_models;

-- ---- 第四部分：人格 ----
DROP INDEX IF EXISTS ix_persona_conflicts_open;
DROP TABLE IF EXISTS persona_conflicts;
DROP INDEX IF EXISTS ix_persona_versions_profile;
DROP INDEX IF EXISTS ux_persona_versions_active;
DROP TABLE IF EXISTS persona_versions;
DROP INDEX IF EXISTS ux_persona_profiles_default;
DROP TABLE IF EXISTS persona_profiles;

-- ---- 第三部分：免疫与脑干 ----
DROP INDEX IF EXISTS ux_health_alerts_open_code;
DROP INDEX IF EXISTS ix_health_alerts_open;
DROP TABLE IF EXISTS health_alerts;
DROP INDEX IF EXISTS ix_immune_subject;
DROP INDEX IF EXISTS ix_immune_status;
DROP TABLE IF EXISTS immune_quarantine;

-- ---- 第二部分：反思 / 技能 ----
DROP INDEX IF EXISTS ix_skill_lessons_key;
DROP TABLE IF EXISTS skill_lessons;
DROP TABLE IF EXISTS skill_stats;
DROP INDEX IF EXISTS ix_reflections_run;
DROP INDEX IF EXISTS ix_reflections_status;
DROP TABLE IF EXISTS reflections;
DROP INDEX IF EXISTS ix_reflection_runs_started;
DROP TABLE IF EXISTS reflection_runs;

-- ---- 第一部分：全局工作空间 ----
ALTER TABLE fox_state DROP COLUMN initiative;
ALTER TABLE fox_state DROP COLUMN stress;
DROP INDEX IF EXISTS ix_affect_obs_status;
DROP INDEX IF EXISTS ix_affect_obs_person;
DROP TABLE IF EXISTS affect_observations;
DROP INDEX IF EXISTS ix_memory_salience_scope;
DROP TABLE IF EXISTS memory_salience;
DROP TABLE IF EXISTS attention_focus;
DROP INDEX IF EXISTS ix_ws_candidates_lease;
DROP INDEX IF EXISTS ix_ws_candidates_expiry;
DROP INDEX IF EXISTS ix_ws_candidates_kind;
DROP INDEX IF EXISTS ix_ws_candidates_ready;
DROP TABLE IF EXISTS ws_candidates;
DROP TABLE IF EXISTS ws_consumers;
DROP INDEX IF EXISTS ix_ws_events_module;
DROP INDEX IF EXISTS ix_ws_events_subject;
DROP INDEX IF EXISTS ix_ws_events_channel;
DROP INDEX IF EXISTS ix_ws_events_scope_ms;
DROP TABLE IF EXISTS ws_events;
