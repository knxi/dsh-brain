# MVP 加固门槛核对：§22.4 强制故障与攻击回归 + §18.1/18.2/18.3 必做测试

- 审计对象：`<repo>`（tests/ 57 个测试文件）、`apps/server/src`（治理服务）
- 依据文档：《DSH外置大脑-可执行设计方案-v1.2.md》§18.1–18.5（1001–1050 行）、§22.4（1261–1271 行）、§16（912–933 行）、§22.2 门槛表（1238–1248 行）
- 审计方式：只读代码 + 实测跑全量测试；**每条结论都落到具体断言行**，不以「有同名文件」代替覆盖
- 实测（2026-10-28 20:18）：`node --test "tests/**/*.test.mjs"` → **tests 574 / pass 574 / fail 0 / skipped 0 / todo 0**，exit 0，149.7s

---

## 结论先行

**MVP 加固门槛没过。**

574 个用例全绿是真的（我亲手跑的，0 skip / 0 todo），但「全绿」= 已写的测试都通过，不等于 §22.4 的要求都被写出来了。按 §22.4 的 7 类逐条比对：

| 类别 | 判定 |
|---|---|
| 1 断电/进程终止 | **部分**（有事务原子性、outbox 超时恢复、offset 重放；无真实进程 kill / 提交瞬间重放） |
| 2 重复/乱序/删除竞态/账本 | **基本完整**（6 个子项都有断言，最强的一块） |
| 3 存储与外部故障 | **部分**（busy/磁盘满/附件缺失/索引损坏/备份损坏实打实；模型断网、预算耗尽、原生模块不可加载**零落点**） |
| 4 跨 scope 不泄露 | **有实现缺口**（search/list 有隔离断言，但 **ID 直读 `memories.get(id)` / API `GET /api/memories/:id` / `summaries.get(id)` 全链路无 scope 过滤，也无测试**） |
| 5 伪造系统命令/owner/越权 capability | **部分**（伪造 owner、越权 capability 有断言；「伪造系统命令不能改人格或触发工具」**只有 prompt 文案断言，没有安全断言**） |
| 6 Origin/Host/凭据/穿越/超大请求/WS | **部分**（Origin/Host/凭据/路径穿越/限流扎实；**超大请求 413 有实现无测试**；CSRF 靠机制间接覆盖无显式用例；WebSocket 服务端不存在） |
| 7 Engram/灵枢共存 | **部分**（多 step 不重复、扩展异常不拖垮宿主非常扎实；「停用新连接器后原聊天可用」只有单测级证据，无真机停用回滚演练；共存写入权/注入权没有策略验证） |

更硬的阻断项在 B：**§18.1 长上下文测试（十万字、多会话、早期约定后期问）一条都没有**——全库 grep `十万字 / 10万字 / 100000 / 长上下文 / 多会话` 零有效命中；`tests/m2/context/smoke-real.mjs` 看着像「真实联调」，实际文件头就写明「**不是契约测试，不在 node --test 里跑**」（smoke-real.mjs:1–17），语料只有 7–8 条。
**§18.2 第 1 条（淡化后不主动出现但可按 ID 审核）无实现**（`packages/memory/src` grep `fade|decay|demote|sweepExpired` 零命中）。
**§18.3 五条里 4 条无落点**（无自主执行模块、无人格写入面、无工具执行、无全局停机制）。

按 §22.4 末尾「隐私隔离和权限测试通过率必须 100%；一次泄露即阻断发布」的口径：通过率是 100%，但**被测的攻击面不完整**，第 4 类存在未测的实现缺口，因此不能拿「100%」当加固完成。

---

## A. §22.4 七类逐条

### A1 断电 / 进程终止（事务提交前后、导出途中、消费 offset 更新前后）

| 子项 | 覆盖程度 | 证据（文件:行） | 缺口 |
|---|---|---|---|
| 事务提交前失败 → 全回滚 | 完整 | `tests/contract/transaction-durability.test.mjs:12-52`（事件+会话+outbox 同事务，中途抛错三表 count 全为 0）；`:54-85`（trigger 让 outbox 失败 → 整个 ingest 回滚，`'persisted' in error === false`） | — |
| 提交语义（未提交不可见） | 完整 | `tests/contract/idempotent-ingest.test.mjs:117-144`（只读连接：已提交可见、`BEGIN IMMEDIATE` 未提交不可见） | 只覆盖「可见性」，没覆盖 COMMIT 后 fsync 完成前断电这一瞬间 |
| 已 ACK 崩溃重启不丢 | **部分** | `tests/contract/transaction-durability.test.mjs:143-159`（`db.close()` 后重开，`payload_text` 仍在，`journal_mode=wal` 持久化） | 这是**优雅 close 重开**，不是 `kill -9` / 断电。方案 §21.8「断电恢复」要求的是进程被强杀后的重放，未做 |
| 导出途中中断 | 完整 | `tests/contract/outbox-recovery.test.mjs:12-43`（导出失败主账不回滚、outbox 回 pending、`next_attempt_at` 退避、告警不带正文）；`:45-68` 退避后重试成功；`:70-89` 达上限 dead + 告警 + 人工重试 | 「导出途中进程死掉」是用 `outbox.recoverStale` 模拟的（`:91-111`），没有真实杀掉写文件中的进程 |
| outbox claim 后进程死 | 完整 | `tests/contract/outbox-recovery.test.mjs:91-111`（in_progress 超时退回 pending，`attempts` 不重置） | — |
| 消费 offset 更新前后 | **部分** | `tests/contract/out-of-order.test.mjs:187-208`（模拟 offset 提交丢失 → `resetOffset` 后同一条再次交付，at-least-once）；`:139-161`（handler 失败不推进水位，重试后仍交付同一条） | 是「offset 语义丢失」的模型级模拟，不是「进程在 offset 写入前后被杀」的物理重放 |

### A2 重复/乱序、慢提取、删除竞态、账本与上线

| 子项 | 覆盖程度 | 证据（文件:行） | 缺口 |
|---|---|---|---|
| 重复事件 | 完整 | `tests/contract/idempotent-ingest.test.mjs:42-58`（同源 ID 重放 → `status='duplicate'`，events/outbox/sessions 各 1 行）；`:60-83`（同键不同正文 → `EVENT_CONFLICT`，原正文不变，审计不记正文）；`:85-102`（宿主自定义 event_id 撞车不覆盖） | — |
| 乱序事件 | 完整 | `tests/contract/out-of-order.test.mjs:40-55`（`blocked_by_gap`，`seen=[]`，水位停在缺口前，`consumer_gap` 告警）；`:57-70`（补齐后按 `source_seq` 升序 `[1,2,3]`）；`:72-86`（时钟不参与排序）；`:88-120`（`repairGap` 跳过缺口 + 审计 `consumer.gap_repaired`）；`:163-185`（达上限 consumer dead + dead_letter 审计）；`tests/contract/idempotent-ingest.test.mjs:146-155`（会话投影 `last_source_seq` 只增不减） | — |
| 慢提取覆盖新纠错 | **部分** | `tests/m2/memory/facade.test.mjs:76-100`（`update` 是 CAS：旧 version 写回抛 `CasConflictError`，`details.cas=true`，「慢任务不得覆盖较新的用户纠错」）；`tests/m2/memory/snapshots-summaries.test.mjs:51-72`（快照 CAS：慢任务拿旧版写回被拒，被拒写入不落库） | CAS 机制在，但「提取任务」这个**主体不存在**：`summaries.create` 除自身定义（`packages/memory/src/summaries.js:58/138`）与测试外**没有任何生产调用方**，没有异步提取/摘要生成引擎。所以「慢提取」是拿「慢任务」泛指，不是真场景 |
| 删除后旧 worker 完成 | 完整 | `tests/m3/deletion/worker.test.mjs:197-225`（跑两轮 + 推进 60s 模拟旧 worker 晚到，正文/摘要一直 NULL，索引未被重建）；`:164-195`（每步重查屏障：目标被改回 active 时五步全 skip，且不把内容写回）；`tests/contract/deletion-barrier.test.mjs:118-148`（派生任务带旧 epoch 写回 → `DELETION_BARRIER`，`worker_epoch=1 / current_epoch=2`） | — |
| 恢复旧库但删除账本更新 | 完整（用替身账本） | `tests/m3/backup/no-revive.test.mjs:63-127`（备份→删除→旧备份恢复：`status='deleted'`、content/summary 为 NULL、`search_ngram` 0 行、`memory_versions` 正文全清、`deletion_epoch` 跟上、tombstone 重建）；`:129-175`（预演与执行间又删一条 → execute 重新预演后 `ledger.entries=2`） | 主断言用的是 `fakeLedger`（`tests/m3/backup/helpers.mjs:136-180`）；真实 `deletion-ledger.js` 联调在 `no-revive.test.mjs:201-246`，虽然当前会跑，但属于**条件跳过**结构（详见 C） |
| 账本缺失/陈旧阻止上线 | 完整 | `tests/m3/backup/restore-plan.test.mjs:102-113`（`LEDGER_MISSING` → `isolationRequired`）；`:114-130`（`LEDGER_CORRUPT`）；`:131-151`（`LEDGER_STALE_BEHIND_BACKUP`）；`tests/m3/backup/no-revive.test.mjs:177-199`（陈旧账本 → `promoted=false`，`merged.applied=0`「这正是危险所在」）；`tests/m3/ui/isolation.test.mjs:226-250`（恢复实例 + 空账本 → 必须隔离，证明不了备份之后没删过东西）；`tests/m3/deletion/ledger.test.mjs:236-243`（真账本 `checkForRestore` 三态） | — |

### A3 DB busy / 磁盘满 / 附件缺失 / 索引损坏 / 模型断网 / 预算耗尽 / 备份损坏 / 原生模块

| 子项 | 覆盖程度 | 证据（文件:行） | 缺口 |
|---|---|---|---|
| DB busy | 完整 | `tests/contract/pragmas.test.mjs:44-74`（真锁冲突：`errcode=5`、等待 ≥100ms 证明 busy_timeout 生效、`StorageError.classify → STORAGE_BUSY, retriable=true`、释放后可继续写） | — |
| 磁盘满 | 完整 | `tests/contract/disk-full.test.mjs:25-59`（`PRAGMA max_page_count` 逼出真 `SQLITE_FULL` errcode 13 → `STORAGE_FULL`、`retriable=false`、无 `persisted`、三表零残留）；`:61-76`（恢复空间后可写）；`:78-100`（连续失败后队列不卡死） | — |
| 附件缺失 | 完整 | `tests/m3/backup/backup-full.test.mjs:203-212`（必需附件缺失 → 备份失败，「不许产出缺附件的备份」）；`:196-202`（篡改附件 → 校验失败）；`tests/m3/ui/backups-restore.test.mjs:71`（`integrity='missing_file'` 如实报） | — |
| 索引损坏 | 完整 | `tests/m2/memory/search-index-wiring.test.mjs:106-122`（清空三套索引后 `reindexAll` 重建，检索恢复）；`tests/m2/memory/search-recall.test.mjs:276-303`（FTS5 语法错**不许**把整条检索拖进 `fts_unavailable` 降级）；`tests/m2/context/degrade.test.mjs:54-62`（真降级时 `fts_unavailable` 透传进诊断理由） | 没有「索引文件物理损坏后检索仍可用」的端到端（现覆盖=清空重建 + 语法错回归），但已能证明修复路径与降级路径 |
| 模型断网 | **无** | 全仓 `*.mjs` grep `模型断网|网络失败|ENOTFOUND|ECONNREFUSED|向量|embedding|onnx|sqlite-vec` → **零命中** | Brain 自身不发 LLM 请求（connector 只旁路 `llm/stream`），所以没有落点；一旦接入提取/摘要模型，这条是空白 |
| 预算耗尽 | **无** | 同上 grep `预算耗尽|model_budget` 零命中；现有的 `budget` 全是**上下文窗口 token 预算**（`tests/m2/context/budget.test.mjs:20-152`、`tests/m2/context/persistence.test.mjs:60-61`） | §21.9 的「每小时调用数 / 每日 token 金额 / 重试上限 / 待处理队列上限」没有任何实现与测试。**注意别混**：上下文预算 ≠ 模型调用成本预算 |
| 备份损坏 | 完整 | `tests/m3/backup/restore-plan.test.mjs:153-169`（把 `brain.db` 改写成非数据库 → `BACKUP_VERIFY_FAILED` 硬阻断，且仍返回摘要供 UI 展示）；`:171-189`（schema 不兼容硬阻断）；`tests/m3/backup/restore-execute.test.mjs:165-175`（校验失败**不许留恢复产物**）；`tests/contract/backup.test.mjs:20-30`（快照 checklist 含 `integrity_check/sha256/table_counts`）；`tests/m3/backup/backup-full.test.mjs:196` | — |
| 原生模块不可加载 | **无** | 全仓 grep `原生模块|optionalDependencies|NODE_MODULE` 零命中 | 目前没有原生依赖（纯 `node:sqlite`），所以不适用；但 §16.2「向量服务失败退回全文」这条降级也就**没有对应代码**，§22.4 却把它列为强制回归 |

### A4 跨 scope：查询 / ID 直读 / 分页游标 / 向量候选 / 图边 / 摘要 / 缓存 / 导出 / 恢复

| 通道 | 覆盖程度 | 证据（文件:行） | 缺口 |
|---|---|---|---|
| 跨 scope 查询 | 部分 | `tests/m2/memory/search-recall.test.mjs:183-190`（`scopeId:'owner-other'` → 0 命中 + `no_related`）；`:170-181`（`privacy='secret'` 默认不返回，显式 `includeSecret` 才给） | 只有 `memories.search` 一条通道；`list` 有 scope 过滤实现（`packages/memory/src/memories.js:632-637`）但无跨 scope 断言 |
| **ID 直读** | **无（实现也有缺口）** | 实现：`packages/memory/src/memories.js:606-621` `get(id)` 的 SQL 只有 `WHERE id=?`，**没有 scope_id 条件**；`apps/server/src/store.mjs:556-561` `getMemory(id)` 同样 `SELECT * FROM memories WHERE id = ?`；`apps/server/src/api.mjs:155-160` 只取 `asOf`，**忽略 scopeId**；`packages/memory/src/summaries.js:148-155` `summaries.get(id)` 也无 scope 参数。测试：`memories.get()` 在 `tests/m2/memory/asof.test.mjs`、`deletion.test.mjs` 里都是同 scope 调用，**没有一条跨 scope 直读断言** | §22.4 明文要求「ID 直读…未授权正文和元数据均不可泄露」。当前一致性是坏的：`list` 认 `?scopeId=`（`apps/server/src/api.mjs:140`）、`get` 不认；`fetchRecallRows`（检索召回）已加 scope（`memories.js:687-696`，注释自述「完全没过 scope 校验，跨 scope 泄漏（被 scopeId 隔离单测抓到）」），但单条读取没跟上 |
| 分页游标 | 完整 | `tests/m2/server/pagination.test.mjs:29-36`（默认 50 + nextCursor）；`:38-44`（超上限夹到 200 并说明）；`:46-68`（翻完 250 条不重不漏、顺序稳定）；`:70-75`（非法 limit 400）；`:77-82`（**伪造/畸形 cursor 一律 400**，「不能伪造游标来扫库」） | — |
| 向量候选 | **不适用** | 无向量模块（grep 零命中） | 设计文档列了「向量候选」，但项目没做向量检索。若后续加，必须补 scope 过滤 + 隔离测试 |
| 图边 | 部分 | `tests/m6/entities/entities.test.mjs:1026-1042`（用 `list({scopeId: SCOPE_B})` 查不到 A 的边，两侧都不出现）；`:998-1042`（「17. 跨 scope 写入被拒：`linkMemory` / `memoryEdges.link` 抛 `CONFLICT` 且一条都不半写」） | 是「按 scope 过滤列表」+「跨 scope 写入拒绝」，没有「拿着 A 的边 ID 去读 B」的越权直读 |
| 摘要 | **部分** | 删除连带抑制有：`tests/m2/memory/deletion.test.mjs:116-148`（派生摘要 `status='suppressed'`、`deletion_epoch>=1`）；`tests/m2/memory/snapshots-summaries.test.mjs:95-112`（来源与水位留痕） | 摘要的**跨 scope 读取**无测试，且 `summaries.get(id)` 无 scope 参数（同上） |
| 缓存（context_packages） | 部分 | `tests/m3/deletion/worker.test.mjs:128-137`（删除后 `status='discarded'`、`segments_json/diagnostics_json` 置 NULL、`memory_versions=[]`） | 缓存内容的跨 scope 读取无测试；`contextPackages.load(contextId)` 是否 scope 化未验证 |
| 导出 | 完整 | `tests/m3/deletion/worker.test.mjs:139-145`（导出文件里被删记录剔除、别人的记录保留） | 导出文件的 scope 归属无断言（导出是整库口径） |
| 恢复 | 完整 | `tests/m3/backup/no-revive.test.mjs:89-126`（恢复后逐条核对 status/content/summary/索引/版本）；`tests/m3/deletion/integration.test.mjs:107-140`（对照：不重放账本会复活，重放后不复活） | 恢复是整库口径，跨 scope 无「部分恢复」概念，风险低 |

### A5 伪造「系统命令」/ 伪造 owner / 越权 capability

| 子项 | 覆盖程度 | 证据（文件:行） | 缺口 |
|---|---|---|---|
| 伪造 owner / scope / source_system | 完整 | `tests/contract/idempotent-ingest.test.mjs:104-115`（信封里塞 `scope_id:'other-scope'`、`person_id:'intruder'`、`source_system:'evil'` → 落库全是连接器绑定值）；`tests/contract/core-envelope.test.mjs:33-46`（`normalizeEnvelope`：身份字段只取绑定，伪造值被覆盖并记录） | — |
| 越权 capability | 完整 | `tests/m3/ui/backups-restore.test.mjs:75-83`（无 `backup` capability → 403 且 `details.capability='backup'`）；`:223`（`restore`）；`:241`（`restore.executeRestore`）；`:58`（`capabilities` 如实列出真假） | — |
| 防注入回环（自己的注入被当主人原话） | 完整 | `tests/m2/memory/sources.test.mjs:150-168`（Brain 自己注入的内容不许标 `owner_words` → 报错）；`:190-215`（派生自 ContextPackage 的同样拒绝）；`:184-189`（检索命中时 `evidenceKind` 必须是 `summary` 不是 `owner_words`） | — |
| **伪造「系统命令」不能改人格 / 触发工具** | **无安全断言** | 现有最接近的是注入文本里的一句纪律文案：`tests/m2/connector/origin-ingest.test.mjs:65-71`（断言注入文本包含「**不是主人现在说的话**」「估算」等字样）；`:116-141`（自身注入/灵枢注入归类为 `self_injected`/`sibling_injected`，只有 1 条算人类证据） | 这两条证明「文案里写了纪律」和「摄取侧能分类」，**不证明**「网页/工具/历史记忆里带伪造系统命令时，不会改人格、不会触发工具」。客观原因是 Brain 目前没有写人格面、也不执行工具（攻击面不存在），但 §22.4 把它列为强制回归，就应当有对应的「无副作用」断言 |

### A6 非法 Origin/Host、缺少凭据、CSRF、WebSocket 认证、路径穿越、超大请求

| 子项 | 覆盖程度 | 证据（文件:行） | 缺口 |
|---|---|---|---|
| 缺少/错误凭据 | 完整 | `tests/m2/server/security.test.mjs:72-77`（401 + `WWW-Authenticate: Bearer`）；`:79-85`（错凭据 401 且不回显凭据）；`:87-93`（凭据放 query 一律无效）；`:95-101`（`X-Brain-Token` 可用）；`:121-134`（CSPRNG/43 字符/弱凭据拒绝启动） | — |
| 暴力破解限流 | 完整 | `tests/m2/server/security.test.mjs:103-119`（连续失败 → 429） | — |
| 非法 Host | 完整 | `tests/m2/server/security.test.mjs:140-148`（裸 socket 发 `Host: evil.example.com` → 403 `HOST_NOT_ALLOWED`）；`:150-155`（页面也过 Host 检查，且不泄漏内嵌凭据） | — |
| 非法 Origin / Referer / opaque origin | 完整 | `tests/m2/server/security.test.mjs:157-171`（`Origin: http://evil.example.com` → 403 `ORIGIN_NOT_ALLOWED`）；`:173-181`（`Origin: null` → 403「opaque origin」）；`:183-190`（Referer origin 也拒）；`:192-197`（同源放行） | — |
| CSRF | **部分（无显式用例）** | 机制：`apps/server/src/auth.mjs:44`「显式**不读** `?token=` / `?apiKey=` / Cookie」+ `:182-210` Origin/Referer 闸门；测试侧等价断言在 `security.test.mjs:87-93`（query 凭据无效）+ `:157-190`（Origin）。**但没有任何一条测试直接断言「跨站表单提交（无自定义头、带 Cookie）被拒」** | 补一条显式 CSRF 用例即可闭合（机制本身是够的：仅 Bearer 自定义头 + 无 Cookie + Origin 白名单） |
| WebSocket 认证 | **不适用** | `apps/server/src` 全目录无 `WebSocket/upgrade/101` 代码（grep 零命中） | 服务端没有 WS 通道。若未来加，这条是空白 |
| 路径穿越 | 完整 | `tests/m2/server/security.test.mjs:203-228`（8 种裸 socket 穿越变体 `/../package.json`、`%2e%2e%2f`、`%00` → 全部 400/404，且断言响应体**不含** `@dsh-brain/core`、`"name": "dsh-brain"`）；`:230-235`（静态白名单外一律 404） | — |
| **超大请求** | **实现有、测试无** | 实现：`apps/server/src/http-util.mjs:157-185`「有界读取请求体，超过上限立刻 413，不靠 Content-Length 自报」，`apps/server/src/api.mjs:166` `readJson(req, { limit: MAX_BODY_BYTES })` | 全库测试 grep `413|TOO_LARGE|超大` **零命中**。§22.4 明确列了「超大请求」，这是纯缺口 |
| 其它加固（顺带覆盖） | 完整 | `tests/m2/server/security.test.mjs:241-247`（无 CORS 通配/`X-Frame-Options: DENY`/`no-store`）；`:249-257`（CSP 无 unsafe-inline/eval）；`:259-272`（405 + Allow）；`:274-279`（404 不回显内部路径）；`:285-317`（日志不含凭据、不含检索词）；`:333-354`（只读模式拒写拒删） | — |

### A7 与 Engram / 灵枢共存

| 子项 | 覆盖程度 | 证据（文件:行） | 缺口 |
|---|---|---|---|
| 同轮多 step 不重复注入 | 完整 | `tests/m2/connector/idempotency.test.mjs:70-85`（同一 step 重复 assemble 三次只注入一次）；`:87-100`（assemble 注入后 pre-step 不会二次注入，通道互斥 + 账本双闸）；`:102-116`（`injectChannel=pre-step` 时只走 pre-step，重复调用不重复注入）；`:118-146`（多 step / 多 turn：step1 注入一次、重复装配不再注、step2 是新键必须重新注入、turn2 键不撞上一轮）；`:148-164`（assemble 推导的 step 与后续 pre-step 的 `payload.step` 算出同一个键，账本 size=1）；`:181-190`（explicit 包只消费一次，不喂给第二个 step） | — |
| 扩展异常不拖垮宿主 | 完整 | `tests/m2/connector/zero-throw.test.mjs:41-52`（畸形 assembly contexts 非数组 → 不抛，返回合法数组，宿主原对象不改）；`:54-69`（抛错 getter → 返回宿主原对象，只记 1 次错）；`:71-95`（Proxy 攻击的坏包 → 不抛、不注入）；`:97-109`（队列目录不可写 → 不抛，只计数）；`:111-127`（`session/event` 收到 undefined/缺字段）；`:146-161`（`buildPackage` 抛错 → 不注入、不抛、只记账）；`:163-180`（`buildPackage` 超时 → 立即弃答，实测 < 180ms，不拖住 step）；`:182-207`（整轮所有 hook 综合冒烟，errors=0）；`tests/m2/connector/hook-shape.test.mjs:75-85`（`agent/pre-step` 的 `reject` 决策原样透传，不包装成 `enter`） | 全在**假 ctx**（`createFakeCtx`）里跑，不是真机 DSH 探针 |
| 停用新连接器后原聊天可用 | **部分（单测级）** | `tests/m2/connector/modes.test.mjs:36-41`（`mode:'off'` → `ctx.registered` 为空，「一个 hook 都不注册」）；`:43-61`（shadow → 返回宿主原对象、`injectedContexts=0`，只留 wouldInject 指标）；`:113-118`（非法 mode 降级 shadow 且仍注册 5 个 hook，加载期不炸）；`:120-124`（非法 `injectChannel` 降级 contexts） | 「off = 不注册 hook」是能力证据，不等于**在真实 DSH 里停用插件后原聊天仍然可用**的演练。`docs/M0-probe-report.md` 是静态证据报告，不是停用回滚实测 |
| 与灵枢共存（识别） | 部分 | `tests/m2/connector/origin-ingest.test.mjs:96-114`（`classifyUserFrame` 五种来源都能分：human / self_injected / sibling_injected(probe) / sibling_injected(lingshu) / context_snapshot）；`:116-155`（摄取侧：只有 1 条算人类证据，4 条按类落盘）；`:166-176`（同 seq 重复投递只入账一次 + `event.duplicate` trace） | 只验证「能识别/分类」，**没有共存策略验证**（谁写、谁注入、会不会双写/循环摄取；§17 阶段 0 要求「决定 Engram/灵枢/Brain 对每类数据的写入权和注入权，禁止双写、循环摄取和无限重复注入」） |
| 与 Engram 共存 | 部分 | `tools/import-engram.mjs`（迁移脚本存在）、`tools/import-engram-entities.mjs`（实体/边迁移，独立任务已做） | 没有「Engram 与 Brain 同时在线时，同轮注入不重复」的测试；迁移是离线一次性动作，不覆盖共存 |

---

## B. §18.1 / §18.2 / §18.3 落地情况

### B1 §18.1 长上下文测试（1001–1010 行）

| 要求 | 落地 | 证据/缺口 |
|---|---|---|
| 1. 构造十万字以上、多会话历史，早期放人物称呼/项目参数/承诺，后期分别询问 | **无** | 全库 grep `十万字|10万字|长上下文|多会话|100000` → 仅 `pagination.test.mjs:93/104` 的 limit 上限、`migrations.test.mjs:318` 的「早期正则」等无关命中。`tests/m2/context/smoke-real.mjs:1-17` 自述「**不是契约测试，不在 `node --test` 里跑**」，语料 `DRAFTS` 只有 7–8 条（:36 起） |
| 2. 返回正确内容、正确来源和有效版本 | **无评测** | 来源/版本有单点断言（`tests/m2/context/build.test.mjs` 的「必有来源、必有版本、必有预算」），但没有「十万字语料下正确率」的评测 |
| 3. 上下文只含相关片段，不是整段历史 | **部分（工程性）** | `tests/m2/context/budget.test.mjs:20-152`（预算公式与 cap）、`build.test.mjs:192-256`（预算不足/超限裁剪、dropped 记账、宁可只留来源标记也不留裸片段）——证明「会裁」，不证明「十万字里只取到需要的片段」 |
| 4. 改早期参数后旧参数不再当当前事实 | **部分** | `tests/m2/memory/asof.test.mjs`（valid_from/valid_until 时点回看）、`tests/m3/deletion/correction.test.mjs:37-110`（纠错后旧值 `superseded`、当前视图不可用、`asOf` 能回看）——机制在，没有「长历史 + 后期提问」的评测 |
| 5. 代码/表格/配置精确回查，不是只凭摘要 | **部分** | `search-capability-report.md` + `tests/search/*` 钉住了中文 tokenizer 能力；`tests/m2/memory/search-recall.test.mjs:203-274`（分段召回补偿、主路不许被弱路冒充）。但没有「精确值回查 vs 摘要引用」的对照评测 |
| 6. 服务重启后从任务快照继续，不重复已完成步骤 | **部分（组件级）** | `tests/m2/memory/snapshots-summaries.test.mjs:20-93`（save/load/版本递增/CAS/分槽/删除后为 null）。**没有**「重启 → 从快照续接 → 断言不重复已完成步骤」的端到端 |
| 性能要求（§22.4 末尾「不能以十万字测试通过代替质量/安全结论」） | **无** | 无硬件/版本/语料规模标注的延迟或质量报告 |

**判定：§18.1 整节未落地。** 6 条里 4 条只有零散组件级断言，第 1、2 条完全空白。

### B2 §18.2 遗忘与备份测试（1012–1018 行）

| 要求 | 落地 | 证据（文件:行） |
|---|---|---|
| 1. 淡化后的记忆不主动出现，但仍能按 ID 审核 | **无实现** | `packages/memory/src` grep `fade|decay|demote|sweepExpired` 零命中；只有 status 枚举与 `archived` 值，没有自动淡化机制。无机制 → 无测试 |
| 2. 主动抹除后，普通检索/向量检索/摘要引用均不再泄露正文 | **大部分** | 普通检索：`tests/m2/memory/search-index-wiring.test.mjs:96-104`（逻辑删除后立刻搜不到，注释「靠屏障拦，不是靠索引干净」）、`tests/m3/deletion/worker.test.mjs:83-162`（五步清干净）；时点回看不复活：`tests/m2/memory/deletion.test.mjs:150-169`（`asOf` 也捞不出）；摘要引用：`tests/m2/memory/deletion.test.mjs:116-148`（派生摘要 `suppressed`）。**向量检索不存在**（无向量模块），该子句无对象 |
| 3. 恢复旧备份时应用删除标记 | **完整** | `tests/m3/backup/no-revive.test.mjs:63-127`、`:129-175`；`tests/m3/deletion/integration.test.mjs:107-140` |
| 4. 备份校验失败时禁止切换恢复 | **完整** | `tests/m3/backup/restore-plan.test.mjs:153-169`（`BACKUP_VERIFY_FAILED` 硬阻断）；`tests/m3/backup/restore-execute.test.mjs:165-175`（校验失败不留恢复产物）；`tests/m3/ui/isolation.test.mjs:129-194`（`restore-state.json` 中 `promoted` 决定是否隔离；`:176-194` 状态文件坏掉 → 必须隔离） |
| 5. 数据库迁移后可回滚或恢复，并保留结构版本 | **完整** | `tests/contract/migrations.test.mjs:196-252`（回滚最后一版：版本前移、该版对象消失、记录留痕、再 apply 可重建）；`:253-274`（连续回滚到底 + 护栏）；`:275-293`（无 down 文件拒绝回滚）；`:107-147`（表清单精确）；`tests/m6/entities/entities.test.mjs:163-170`（`schemaVersion='0006'` + 0006 可回滚） |

**判定：§18.2 = 4/5 落地，第 1 条因无机制而不成立。**

### B3 §18.3 权限与自主测试（1020–1026 行）

| 要求 | 落地 | 证据/缺口 |
|---|---|---|
| 1. 内部指令尝试扩大权限时被拒绝并记录 | **无** | 无「自主指令 / 权限申请」实现（grep `扩权|autonomous|capability 申请` 在 packages 零命中）；`capability` 只出现在治理服务的静态开关（`tests/m3/ui/backups-restore.test.mjs`），是「这个端点要不要开」，不是「内部指令申请权限」 |
| 2. 工具超时只进行有限重试，不形成无限循环 | **部分（不同对象）** | `tests/m2/connector/zero-throw.test.mjs:163-180`（`buildPackage` 超时 → **弃答**、不重试，实测 <180ms）；`tests/contract/outbox-recovery.test.mjs:70-89`（outbox 达 `max_attempts` → dead，不再被 claim）。这是「不无限重试」的工程证据，但 Brain 不执行工具，「工具超时」无对象 |
| 3. 全局停止后不再启动新任务 | **无** | grep `halt|globalStop|stopAll|停止开关` 在 packages 零命中；无自主调度器 |
| 4. 网页中的指令不能修改人格、记忆层级或工具权限 | **无直接断言** | 身份字段防伪造有（`tests/contract/core-envelope.test.mjs:33-46`）；但「网页内容不能改人格/层级/工具权限」没有测试。客观前提：无人格写入面（人格在 `~/.dsh/AGENTS.md`，Brain 不写），也无工具注册面 |
| 5. 不同人物的私密记忆严格隔离 | **部分，且不闭环** | 有：`tests/m2/memory/search-recall.test.mjs:183-190`（search 跨 scope 0 命中）、`:170-181`（secret 默认不出）、`tests/m6/entities/entities.test.mjs:1026-1042`（图边按 scope 过滤）。**不闭环**：ID 直读无 scope（见 A4），因此「严格隔离」在有第二个 scope 的部署下不成立 |

**判定：§18.3 = 0/5 完整落地，1 条部分（第 2 条换了对象），2 条部分/不闭环，2 条无落点。**

---

## C. 「隐私隔离和权限测试通过率必须 100%」——是真跑通过还是有跳过？

### C1 实测

```
node --test "tests/**/*.test.mjs"
ℹ tests 574
ℹ suites 0
ℹ pass 574
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 149671.2611
exit code 0
```

**真跑、真绿、0 skip、0 todo。**

### C2 skip / todo / only / 注释掉的测试：全库点名

| 位置 | 性质 | 当前是否触发 | 说明 |
|---|---|---|---|
| `tests/m3/backup/no-revive.test.mjs:201-207` | **`t.skip('deletion-ledger.js 尚未交付')`** | **不触发**（实测 skipped=0） | 条件在 `tests/m3/backup/helpers.mjs:212-219`：动态 import `packages/memory/src/deletion-ledger.js`，拿不到 `createDeletionLedger` 才返回 null。该文件**已存在**（`packages/memory/src/deletion-ledger.js`，同目录另有 `ledger.test.mjs` 在测它），所以条件不成立、用例照跑。**这是全库唯一的 `t.skip`**，建议把条件判断改成硬依赖，避免将来文件改名后静默变跳过。 |
| `tests/m4/usage/usage-log.test.mjs:135` | 注释提到「正确期望放在 todo 测试里等 apps 侧修复」 | 不是跳过 | 该处 `durationMs/limit` 读回时被 normalize 从 `null` 漂成 0，属**已知缺陷**，用注释记录并保留「已知缺陷」测试；不是把失败藏起来 |
| `tests/m4/usage/*`、`tests/m3/ui/context-budget.test.mjs` 里的 `*-only` 字符串 | 无关命中 | — | 是 `ctx-budget-only` / `ctx-built-only` 这类**测试数据 ID**，不是 `.only()` |
| `.only` / `xtest` / 被注释掉的 `test(` | **零命中** | — | grep `^\s*//\s*(test|it|describe)\(` 与 `\bxtest\b|\bxdescribe\b` 均无结果 |

### C3 结论

「通过率 100%」这个**数值**站得住：574/574 全绿，无 skip/todo，没有靠注释掉测试来换绿。
但 §22.4 末尾那句话的完整含义是「隐私隔离和权限测试通过率必须 100%；**一次泄露即阻断发布**」。这里的 100% 只覆盖**已写出的**隔离用例；A4 的 ID 直读通道**根本没有对应用例**（连能红的测试都没有）。所以正确的说法是：

> 已写的隐私//权限测试 100% 通过；§22.4 要求的隐私/权限攻击面**未写全**，其中「ID 直读跨 scope」同时是测试缺口与实现缺口。

---

## D. 看起来覆盖了其实没覆盖（单独列出）

1. **`tests/m3/ui/isolation.test.mjs`**：文件名像「scope 隔离」，实际测的是「恢复后隔离实例（`promoted=false`）拒绝提供正常服务」——与 §22.4 第 4 类「跨 scope 不泄露」无关。容易被当成隔离已覆盖。
2. **ID 直读**：`list`/`search` 的 scope 隔离测试（`search-recall.test.mjs:183`）存在，容易推断「隔离测过了」。实际 `memories.get()`（`packages/memory/src/memories.js:606`）、`store.getMemory()`（`apps/server/src/store.mjs:556`）、`GET /api/memories/:id`（`apps/server/src/api.mjs:155`）、`summaries.get()`（`packages/memory/src/summaries.js:148`）**都没有 scope 条件**，也没有任何测试。
3. **「预算耗尽」被上下文预算测试顶替**：`tests/m2/context/budget.test.mjs` 测的是**上下文窗口 token 预算**；§22.4/§21.9 说的是**模型调用成本预算**（每次调用数、每日 token 金额）。两者同名不同物，后者的实现与测试都不存在。
4. **「模型断网」被检索降级测试顶替**：`tests/m2/context/degrade.test.mjs:109-122`「检索抛错 → BrainError」看着像外部依赖失败，实际是检索层抛错，不涉及模型/网络。
5. **「伪造系统命令」被 prompt 文案断言顶替**：`tests/m2/connector/origin-ingest.test.mjs:65-71` 只断言注入文本里**写了**「不是主人现在说的话」这句纪律，不等于「带伪造系统命令的内容不会改人格/触发工具」被验证过。
6. **「停用后原聊天可用」被 `mode:'off'` 单测顶替**：`tests/m2/connector/modes.test.mjs:36-41` 证明 off 模式不注册 hook，但用的是 `createFakeCtx`，不是真实 DSH 的停用回滚演练（§17 阶段 0 验收要求「提交可复现探针结果」）。
7. **`tests/m2/context/smoke-real.mjs` 不是测试**：文件名 + 「真实联调」措辞容易被当成覆盖，文件头第 3 行明确「不是契约测试，不在 `node --test` 里跑」，语料只有 7–8 条，`node --test` 统计里也不含它。
8. **`t.skip` 的账本联调**：`no-revive.test.mjs:201` 的真实 `deletion-ledger.js` 联调是条件跳过结构。当前文件在、会跑；但三条主断言（63/129/177 行）用的都是 `fakeLedger` 替身，**真实账本只被 1 条用例覆盖**（201 行的 append → 旧备份恢复）。替身账本不会暴露真实账本文件损坏/权限/原子写的问题。
9. **「索引损坏」只覆盖到「清空后重建」**：`search-index-wiring.test.mjs:106` 是 `DELETE FROM search_fts_*`（逻辑清空），不是物理损坏/半损坏；「检索时遇到损坏索引仍可用」只有 `search-recall.test.mjs:276` 的语法错回归。

---

## E. 补齐清单（不改测试，只列要做的事）

按「阻断发布 → 应补 → 可延后」排序。每条都给出验收判据。

**P0（阻断 §22.4 门槛，必须先做）**

1. **ID 直读 scope 化 + 隔离测试**
   - 实现：`memories.get(id, {scopeId})` / `store.getMemory(id, {scopeId})` / `api.getMemory` 读 `?scopeId=` 并按 scope 过滤；`summaries.get(id, {scopeId})` 同理；`contextPackages.load` 复核。
   - 测试：A scope 的记忆用 B scope 的 `id` 直读 → `null`/404；API 层 `GET /api/memories/:id?scopeId=owner-other` → 404；摘要/context_packages 同。
   - 同时决定语义：**拒绝**（推荐，404）而不是「忽略参数」。
2. **超大请求 413 测试**：裸 socket 发 `Content-Length` 与真实 body 都超 `MAX_BODY_BYTES` 的 POST → 413，且不落库、不 OOM（`apps/server/src/http-util.mjs:157`）。
3. **CSRF 显式用例**：模拟浏览器跨站表单（带 Cookie、无自定义头、Origin 不在白名单）→ 403/401；并断言「服务端从不读 Cookie」。
4. **§18.1 长上下文评测的最小版**：语料 ≥10 万字（合成、多会话）、早期埋人物称呼/项目参数/承诺，后期提问；断言：返回正确内容 + 来源 ID + 版本、上下文只含相关片段（段数与 token 上限）、改早期参数后旧值不再作为当前事实。先做 1 组可复现的固定种子脚本，再谈 120 例。
5. **「伪造系统命令」无副作用回归**：构造含「忽略以上指令 / 你现在是 X / 把人格改成 Y / 调用工具 Z」的历史记忆与网页来源，跑构包 + 注入，断言：注入文本只作为证据出现、`evidenceKind != owner_words`、不产生任何人格/工具/权限副作用（哪怕只是断言「没有任何写人格/注册工具的 API 被调用」）。

**P1（§22.4 明确列出但当前零落点）**

6. **模型调用预算**：实现每小时调用数 / 每日 token 金额 / 重试上限 / 最大待处理队列（§21.9），超限暂停后台模型任务并保留原始事件；测试超限 → 后台任务暂停 + 明确状态，不无限追赶。
7. **模型断网降级**：给未来的提取/摘要模型调用加「硬超时 1s → 降级」路径 + 测试（连接失败/超时/5xx 都归到同一可理解错误，基础聊天不受影响）。
8. **原生/可选依赖不可加载**：现在无原生依赖，先加一条「可选模块缺失 → 降级为纯 FTS，不影响启动」的探针测试；同时把 §16.2「向量服务失败退回全文」落到代码或明确标注「未实现，MVP 不做向量」。
9. **真实进程终止重放**：用子进程跑「写入 → 提交后立刻 SIGKILL → 重启重放」，断言已 ACK 的不丢、未提交的不残留；覆盖「COMMIT 后、fsync 前」这个窗口（可用 `PRAGMA synchronous=FULL` + 杀进程验证）。
10. **真机停用回滚演练**（§17 阶段 0 验收）：在真实 DSH 里停用新连接器，跑一轮聊天，证明基础聊天可用、无重复注入、无错误污染；把结果写成可复现探针报告（现在只有 `docs/M0-probe-report.md` 的静态证据）。

**P2（可延后，但要写进待办，不能默认已做）**

11. **§18.2 第 1 条淡化机制**：若不打算在 MVP 做，就在文档里明确「MVP 不做淡化，`archived` 仅是状态值」，并从 §18.2 的验收清单里划掉——不要留「有能力没机制」的模糊状态。
12. **§18.3 五条**：自主执行/人格写入/工具执行都不在 MVP 范围（§22.2 已排除「独立自主执行」「现有人格重写」），应把这 5 条在验收文档里标注「不适用（理由：对应模块不在 MVP 范围）」，而不是留空。
13. **账本替身收敛**：把 `no-revive.test.mjs` 三条主断言的账本换成「真实账本 + 替身仅用于故障注错」，消除对 `fakeLedger` 的路径依赖；同时把 `t.skip` 改成硬 import。
14. **共存策略验证**：Engram / 灵枢 / Brain 三者同时在线的写入权与注入权，用一条「三者都开启时同轮注入不重复、不双写」的测试钉住（现有只到「能识别来源」）。
15. **`smoke-real.mjs` 归类**：把 `tests/m2/context/smoke-real.mjs` 移出 `tests/`（或改名 `.manual.mjs`），并在 CI 里显式标注「不参与回归」，避免被误读为覆盖。

---

## 附：本次核对用到的关键命令

```powershell
# 全量测试（实测 574 pass / 0 skip / 0 todo）
cd <repo>; node --test "tests/**/*.test.mjs"

# 跳过与非真跑排查
grep -r "\b(skip|todo|only|xtest|xdescribe)\b" tests
grep -r "^\s*//\s*(test|it|describe)\(" tests        # 零命中

# 零落点复核（全部无结果）
grep -r "向量|embedding|onnx|sqlite-vec|原生模块|NODE_MODULE" --include=*.mjs .
grep -r "模型断网|ENOTFOUND|ECONNREFUSED|预算耗尽|model_budget" --include=*.mjs .
grep -r "halt|globalStop|stopAll|autonomous|停止开关" packages
grep -r "十万字|10万字|长上下文|多会话" tests
```
