-- ===========================================================================
-- 0003_m2_context_evidence.sql —— 构包的证据链：预算、承载形态、sent 判据、弱证据强度。
--
-- 为什么需要这一版（M2 验收项「built → attached → sent 三级证据链完整可查」+「必有预算说明」）：
-- 0001 建 `context_packages` 时只设计了状态与时间戳，**没有地方放预算明细和 sent 判据**。
-- 后果是实打实的：
--   * context2 算出的 `budget.brainAllowance` / `budget.dropped[]`（"哪些段被丢了、为什么"）
--     在主账里无处落地，只能塞进 memory_versions 的快照 JSON，检查器经常拿不到 →
--     控制台只能显示「本次未记录预算明细」；
--   * 契约 §10.9 要求 sent 判据查两级承载（`options.system` / `options.messages[role=system]`），
--     但结论落在哪一列没人规定 → 检查器把 carrier 显示成「未记录」，证据链断一环。
--
-- 设计取舍（写清楚，别以后被人当成漏存）：
--   * **不落 `injectedText` 全文**。它包含记忆正文，落库等于把私密内容再存一份，
--     且体积随预算线性涨。这里只存 `injected_text_hash`；检查器要还原"注入了什么"
--     用 `segments_json` 里的逐段 summary，要核对字节用 `payload_hash`（canonicalHash）。
--   * `attached_at` / `sent_at` 0001 已有，本版不重复加列。
--   * `evidence_strength` 单列出来（而不是只塞 JSON），因为控制台要按它做徽章与筛选。
--
-- 幂等：`CREATE ... IF NOT EXISTS` 自幂等；`ALTER TABLE ADD COLUMN` 无 IF NOT EXISTS，
-- 由 migrator 账本 + 单事务原子性保证（与 0002 同口径，CONTRACTS §11）。
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. 预算说明（M2 验收：「必有预算说明」）
--    存 context2 给出的整个 budget 对象：
--      { brainAllowance, used, dropped: [{ memoryId, reason, detail, score?, segmentTokens? }],
--        formula, safetyMargin, brainCap, modelWindow, hostInputTokens, outputReserve,
--        estimated, hostInputSource, tokenizerId, notes[] }
--    `estimated` / `tokenizerId` 必须一起存：拿不到真 tokenizer 时这两个字段是
--    「这是估算值」的唯一凭据，缺了控制台就会把估算当精确值显示。
-- ---------------------------------------------------------------------------
ALTER TABLE context_packages ADD COLUMN budget_json TEXT;

-- ---------------------------------------------------------------------------
-- 2. 三级证据：承载形态 + sent 判据结论（契约 §10.9 两级承载）
-- ---------------------------------------------------------------------------
ALTER TABLE context_packages ADD COLUMN carrier TEXT;

-- ---------------------------------------------------------------------------
-- 3. sent 证据明细（evidence_level / proves_wire_delivery / observed_hash_locations[]）
--    与 0001 的 `payload_hash` 配套：判据 = payload_hash 在请求对象里被找到；
--    但「找到了」不等于「字节出网」，所以 proves_wire_delivery 必须如实存。
-- ---------------------------------------------------------------------------
ALTER TABLE context_packages ADD COLUMN sent_evidence_json TEXT;

-- ---------------------------------------------------------------------------
-- 4. 检索质量（weak evidence 徽章）：primary | ngram_fallback | unknown
-- ---------------------------------------------------------------------------
ALTER TABLE context_packages ADD COLUMN evidence_strength TEXT;

-- ---------------------------------------------------------------------------
-- 5. 段与诊断明细 + 注入文本指纹
--    segments_json     —— 逐段 { memoryId, version, layer, type, summary, contentHash, sourceRefs, ... }
--    diagnostics_json  —— { status, reasons[], evidenceStrength, segmentedFallback }
--    injected_text_hash—— 注入文本的 sha256（不存全文，见文件头取舍说明）
-- ---------------------------------------------------------------------------
ALTER TABLE context_packages ADD COLUMN segments_json TEXT;
ALTER TABLE context_packages ADD COLUMN diagnostics_json TEXT;
ALTER TABLE context_packages ADD COLUMN injected_text_hash TEXT;

-- ---------------------------------------------------------------------------
-- 6. step_id —— 契约 §10.1：装配与写入按 (session_id, turn_id, step_id) 幂等
--    0001 的 context_packages 只有 turn_id，缺 step 就无法定位「同一轮里第几个 step 的包」。
-- ---------------------------------------------------------------------------
ALTER TABLE context_packages ADD COLUMN step_id TEXT;

CREATE INDEX IF NOT EXISTS ix_context_packages_turn_step
  ON context_packages (session_id, turn_id, step_id, built_at);

CREATE INDEX IF NOT EXISTS ix_context_packages_strength
  ON context_packages (evidence_strength, status);
