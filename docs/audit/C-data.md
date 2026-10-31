# C · 数据层审计：到底什么在被用，什么零使用

> 审计对象：`E:\ds-h\dsh-brain\data\`（brain.db + logs + ledger + backups）
> 审计方式：SQLite 只读连接（`DatabaseSync(path,{readOnly:true})`）+ JSONL 解析，未写库、未跑任何会写日志的脚本
> 审计时刻：**2026-10-30 22:50 (UTC+8)** ＝ `2026-10-30T14:50Z`
> 库状态：WAL 模式，4.4 MB（1074 page × 4096B），`PRAGMA quick_check = ok`
> 复现脚本：`E:\ds-h\tmp\audit-data.mjs`、`audit-stats.mjs`、`audit-logs.mjs`、`audit-cross.mjs`、`audit-tables.mjs`

---

## 0. 一句话结论

**只有「手工记一条 → 全文查一下 → 人看结果」这条最短链路真的在跑**（写入 13 次、检索 13 次、遗忘 1 次，全部发生在 2 天内的开发自举期）。
**63 张表里 32 张零行**：关系图、构包注入、事件总线、会话索引、反思、人格、社交、自主指令、工作区、技能、情绪、健康、免疫——代码和页面都在，生产数据一条都没有。
库里的 226 条记忆中 **90.7%（205 条）是 Engram 迁移的存量**，本系统自己写进来的只有 21 条（13 条真实 remember + 8 条种子脚本）。

---

## 1. 核心数字表

| 指标 | 数字 | 备注 |
|---|---|---|
| 数据库表总数 | **63** | 含 13 张 FTS/ngram 检索索引表 |
| 有数据的表 | 31 | 业务表 18 / 索引表 13 |
| **零行表** | **32** | 占全部表 50.8% |
| memories 总数 | **226** | 含 deleted 1 / superseded 7 / active 218 |
| ├ 迁移（Engram） | **205** (90.7%) | `producer=tools/import-engram` |
| ├ 真实写入（工具） | **13** (5.8%) | `producer=brain-tools:brain_remember` |
| └ 种子脚本（合成） | **8** (3.5%) | `producer=tools/seed-project-facts.mjs` |
| **auto-extract 产生** | **0** (0.0%) | `data\logs\auto-extract.jsonl` **文件根本不存在** |
| memory_versions | 233 | 205 迁移 + 13 remember + 8 seed + 7 supersede |
| source_refs（来源凭据） | 225 | 217 tool_call + 8 document；1 条记忆无来源 |
| 记忆 ↔ 实体覆盖率 | **45.6%** (103/226) | memory_entities 197 行 |
| entities | 117 | **100% 来自 engram**，构建于 10-29 18:24 |
| ├ 孤儿实体（不挂任何记忆） | **10** (8.5%) | |
| └ 只挂 1 条记忆的实体 | **76** (65.0%) | 实体图谱是散的 |
| **memory_edges** | **0** | 关系图完全空；`contradicts` 边 0 条 |
| **context_packages** | **0** | 构包/注入通道**从未写入一条** |
| **events** | **0** | 事件总线（M1 主干）零事件 |
| **sessions** | **0** | 会话索引零行 |
| 数据库存活时长 | 2 天 3 小时 | migration 0001 @ 10-28T11:34Z |

---

## 2. 使用频次：三个工具到底被调过几次

### 2.1 brain_search —— 13 次（唯一有埋点的工具）

`data\logs\usage.jsonl` 共 **13 行**（不是 12，最后一行无换行符容易数漏）。

| 维度 | 分布 |
|---|---|
| 通道 | `tool` 11 次 / `console` 2 次 |
| 会话 | **11 次全部来自同一个会话** `session-0aefdb13…`；console 2 次无 sessionId |
| 日期 | 10-29 4 次 / 10-30 9 次（UTC） |
| 时间跨度 | 10-29T15:54Z → 10-30T14:48Z（约 23 小时） |
| 返回状态 | `ok` 7 次 / `insufficient_evidence` **6 次（46.2%）** |
| 命中 | 累计 59 条（13 次平均 4.5 条），去重 43 条；**零命中 0 次** |
| 查询去重 | 12 条不同 query（「心海 记忆海 定义 页面名字」查了 2 次） |
| 耗时 | 4–91 ms，中位数 20 ms |
| primaryLaneHit | true 12 / false 1 |

**这 13 次查询的主题全是项目自举**：外置大脑项目进度/根目录、卸载 Engram 顺序、心海页面命名、群星交互参考、密码、灵枢。
没有一次来自「日常聊天里回忆主人说过的事」——**功能可用，但没有进入日常使用**。

### 2.2 brain_remember —— 13 次（**无 usage 埋点**）

从 `memories.producer` 反推：10-28 2 条、10-29 11 条，最后一次 **10-29 01:11:33**，至今 **约 46 小时零新增**。

> ⚠️ **埋点缺失（重要发现）**：`apps\brain-tools\index.js` 里 `recordUsage()` 只挂在 `brain_search` 的 `finally`（行 616）与 console 检索路由（行 1290/1305）。
> `brain_remember`（行 631）和 `brain_forget`（行 743）**没有任何统计记录**。
> 后果：写入频次只能靠数 `producer` 字段事后倒推，**遗忘连倒推都做不到**（见下）。

### 2.3 brain_forget —— 1 次（**无 usage 埋点，且有残留**）

| 证据源 | 内容 |
|---|---|
| `deletion-ledger\entries.jsonl` | 1 条，seq=1，10-28T12:53:22Z，actor=`owner`，目标 `mem_68ae658e…` |
| `deletion_tombstones` | 1 行，status=**pending** |
| `deletion_jobs` | **5 行，5 个 job 全部 pending**（purge_text / scrub_index / drop_context_packages / purge_exports / purge_blobs） |
| `outbox` | 1 行 `purge_tombstone` status=**pending** |
| `audit_logs` | 1 条 `deletion.requested` result=ok |
| **实际残留** | 该记忆仍在 `search_fts_char` 索引里（1 行）；记忆正文仍可读（status=deleted） |

**结论：遗忘只完成了「写账本」，没有完成「擦除」。** 删除管线从 10-28 起挂了 2 天，5 个 job 一直 pending。

### 2.4 usedLater 使用判定 —— 27 行，真用上的只有 3 条

`data\logs\used-later.jsonl` 共 27 行（7 个时间点 = 覆盖 13 次检索中的 **7 次，53.8%**）。

| 判定 | 行数 | 占比 |
|---|---|---|
| `usedLater=true`（有 quote 证据） | **3** | 11.1% |
| `usedLater=null`，理由 `no_quote_in_answer` | **24** | **88.9%** |
| `usedLater=false` | 0 | 0% |

- 被检索命中的 **43 条去重记忆中，只有 3 条（7.0%）被证实真的被回答引用过**；
- 24 条 null 全部是「回答里找不到引用」——判定器不区分「没用」和「没法判定」，**这个指标目前是不可用的哑指标**；
- 27 行里 15 行来自同一 turn（turn 3），说明一次检索把 5 条命中全量铺开判定。

### 2.5 冲突处理 —— 2 次（人工）

`data\logs\conflict-actions.jsonl` 2 行，都是 `keep-right`，actor=`console:/dsh-brain/conflicts`，10-30T10:30Z，`edgeRemoved=true`。
**图里现在 0 条边**——处理一条删一条，被处理的那 2 条 contradicts 边不留任何痕迹，事后无法追溯处理过什么。`kind` 字段也是 null。

### 2.6 控制台开关 —— 6 次（刚被打开，功能没跑）

`brain_switches` 6 行，2026-10-30 22:16（审计前 34 分钟）由 `console` 手工切换：

| 开关 | 值 | 切换后对应表 |
|---|---|---|
| `autonomy.enabled` | 1（L1→L2→L3） | `directives`=0、`directive_runs`=0 |
| `social.enabled` | 1 | `social_candidates`=0、`social_sends`=0 |
| `social.allow_external` | 1 | 同上 |
| `reflection.enabled` | 1 | `reflection_runs`=0、`reflections`=0 |
| `paused` | 0 | — |

**开关打开 ≠ 功能在跑。** 30 分钟内三套自主系统一条数据都没产出。

### 2.7 使用频次汇总表（0 次显式列出）

| 功能/通道 | 调用次数 | 时间跨度 | 判定 |
|---|---|---|---|
| `brain_search`（tool） | 11 | 10-29 ~ 10-30 | ⚠️ 真实但只在一个开发会话 |
| `brain_search`（console） | 2 | 10-30 | ✅ 真实（手工试） |
| `brain_remember` | 13（倒推） | 10-28 ~ 10-29 | ⚠️ 真实但已停 45h，无埋点 |
| `brain_forget` | 1 | 10-28 | ⚠️ 账本写了，擦除未执行 |
| 冲突处理页（keep-right） | 2 | 10-30 | ✅ 真实（人工 2 次） |
| 控制台开关 | 6 | 10-30 | ✅ 真实（但对应功能零产出） |
| 备份（库内台账） | 1 | 10-29 | ⚠️ 磁盘有 8 个产物，台账只 1 条 |
| 恢复演练 | 3（磁盘 json） | 10-28 ~ 10-30 | ⚠️ 有产物，库内零记录 |
| **auto-extract（自动提取）** | **0** | — | ❌ 日志文件不存在，库内 0 条 |
| **context 构包/注入** | **0** | — | ❌ `context_packages`=0 |
| **事件驱动链路** | **0** | — | ❌ `events`=0、`sessions`=0 |
| **实体/关系检索** | **0** | — | ❌ `memory_edges`=0 |
| **总结（summaries）** | **0** | — | ❌ |
| **反思（reflections）** | **0** | — | ❌ |
| **人格（persona_*）** | **0** | — | ❌ 3 张表全空 |
| **社交（social_*）** | **0** | — | ❌ 2 张表全空 |
| **自主指令（directives）** | **0** | — | ❌ 3 张表全空 |
| **工作区（ws_*）** | **0** | — | ❌ 3 张表全空 |
| **技能（skill_*）** | **0** | — | ❌ 2 张表全空 |
| **情绪（affect_observations）** | **0** | — | ❌ |
| **关系事件（relationship_events）** | **0** | — | ❌ |
| **记忆显著性（memory_salience）** | **0** | — | ❌ |
| **健康告警（health_alerts）** | **0** | — | ❌ |
| **免疫隔离（immune_quarantine）** | **0** | — | ❌ |
| **任务快照（task_snapshots）** | **0** | — | ❌ |
| **Blob 存储（blobs/blob_refs）** | **0** | — | ❌ |
| **注意力焦点（attention_focus）** | **0** | — | ❌ |
| **应答决策（response_decisions）** | **0** | — | ❌ |
| **消费者位点（consumer_offsets）** | **0** | — | ❌ 说明事件消费从未启动 |
| **人格冲突（persona_conflicts）** | **0** | — | ❌ |

---

## 3. 实体与边：117 个实体大部分是「迁移产物」，不是使用产物

| 指标 | 数字 |
|---|---|
| entities 总数 | 117 |
| 来源 | `source_system='engram'` **117/117（100%）** |
| 构建时间 | 全部 2026-10-29T18:24:21（一次 m6 回填脚本） |
| kind 分布 | tool 41 / other 29 / concept 28 / project 18 / **person 1** |
| importance | **全部 0.5**（默认值，从未计算过） |
| status | 全部 active；`merged_into` 全 NULL（合并功能零使用） |
| 孤儿实体 | 10（8.5%） |
| 挂 1 条记忆 | 76 个（65.0%） |
| 最高 fanout | 15 条（1 个实体） |

**memory_entities 覆盖率 45.6%（103/226）**，但结构极不均衡：

| 来源 | 总数 | 挂实体 | 覆盖率 |
|---|---|---|---|
| 迁移（import-engram） | 205 | 97 | 47.3% |
| 真实写入（brain_remember） | 13 | **1** | **7.7%** ← 写路径不建实体 |
| 种子脚本 | 8 | 5 | 62.5% |

**新写入的 13 条记忆只有 1 条挂了实体**——说明「写记忆 → 抽实体」这条路在线上根本没接通，117 个实体全是迁移时一次性回填的静态资产。

**边：0 条。** `memory_edges` 空表，`contradicts` 0 条。conflict-actions 那 2 条是 `edgeRemoved=true`，即处理完就删边，所以：
- 现在的「矛盾可见」页面打开是空的；
- 一共只出现过 2 条矛盾边，全部由人工在控制台处理，**没有任何自动核验记录**；
- 处理痕迹只剩 2 行 jsonl，库里查不到。

另：`supersedes` 语义有 1 条不一致——7 条 status=superseded，`memories.supersedes` 非空 6 条，`memory_versions` 里 `changed_by='memories.supersede'` 7 条（差额 1 条没回写主表字段）。

---

## 4. context_packages = 0：connector/注入那条路**完全没有数据支撑**

| 通道 | 表 | 行数 |
|---|---|---|
| 构包 | `context_packages` | **0** |
| 事件输入 | `events` | **0** |
| 会话索引 | `sessions` | **0** |
| 消费者位点 | `consumer_offsets` | **0** |
| 摘要 | `summaries` / `summary_sources` | **0 / 0** |

- 生产环境**一次构包都没发生**，`attached_at`/`sent_at`/`injected_text_hash` 这些注入证据列从未被写过。
- 测试期跑过：`data\probe\m2-connector-20261028-193301\`（10-28 19:33）与 `m2-e2e-20261028-200648\`（10-28 20:07，自带独立 brain.db）。**这些是探针数据，不在主库，不能算真实使用。**
- 所以「检索结果自动进上下文」这个卖点，**在生产里 0 次验证**。M2 的 connector 闭环只在 probe 里绿过。

---

## 5. 真实使用 vs 合成/测试数据（判据隔离）

| 类别 | 条数 | 判定依据 |
|---|---|---|
| **Engram 迁移存量** | 205 | `producer=tools/import-engram`，`origin_system=engram`，created 10-28T17:16Z 批量 |
| **真实工具写入** | 13 | `producer=brain-tools:brain_remember`，内容为主人偏好/项目事实，逐条时间错开 |
| **脚本种子（合成）** | 8 | `producer=tools/seed-project-facts.mjs`，10-30T18:22:26～28 **2 秒内批量插入**，内容是项目设计事实 → **不算真实使用** |
| **auto-extract（自动）** | **0** | 库内 producer 无该值；日志文件不存在 |
| **probe/e2e/smoke 污染** | **0** | 主库无污染；探针全部用独立 db 目录 |
| 含 "probe/测试" 字样的记忆 | 10 | 抽样核对均为迁移来的**历史会话总结**（内容是"D1 场景 probe 结果"），不是测试残留 |

**结论：主库没被测试数据污染，这点干净。但「本系统自己产生的真实使用」只有 13 条记忆 + 13 次检索。**

> 另注：`fox_events` 有 60 行（10-30 19:00～22:28，kind: chat 45 / success 10 / late_night 4 / interesting 1），来自 **dsh-fox 人格插件**的 `fox_feel`，属于情绪状态流水，**不是 brain 记忆功能的使用**，不能算进上面的使用统计。

---

## 6. 数据质量观察（12 条，按严重度排）

1. **检索命中从不回写库**：`memories.recall_count` **226/226 全为 0**，`last_recalled_at` **全 NULL**。记忆库内没有任何「被召回过」的热度数据，只能靠 used-later 日志补，而那个日志只覆盖 54% 的检索、只有 11% 能判定。
2. **删除未闭环**：tombstone pending + 5 个 deletion_job pending + outbox pending + 被删记忆仍在 FTS 索引。遗忘功能只做了一半。
3. **写入/遗忘无埋点**：`recordUsage` 只挂 search。remember 频次靠数 producer 倒推，forget 连倒推都只能靠账本文件。
4. **auto-extract 从未跑过一次**：功能代码在（`auto-extract.js`，纯规则、零模型），日志文件不存在，库内 0 条。**「自动提取」是纯代码，零运行证据。**
5. **事件主干断裂**：`events`=0 是最可能的根因——没有事件，反思/社交候选/自主指令就没有输入侧（此处为数据推断，代码因果由 A/B 报告确认）。三套自主系统（22:16 打开开关）到现在一条产出都没有。
6. **关系图为空**：`memory_edges`=0，「按实体查/矛盾提示」两个页面打开都是空的。
7. **实体是静态回填**：117 个全 engram、importance 全 0.5、merged_into 全 NULL、新写入记忆实体覆盖仅 7.7%。
8. **备份台账不完整**：`backups` 表 1 条（10-29 01:28），磁盘上有 4 个 `brain-consistency-*.db` + 1 个 `pre-migrate-*` 目录（内含 brain.db）+ 3 个 `restore-drill-*.json` → **约 8 个产物只登记 1 条**。
9. **分层/隐私/作用域字段是占位**：226 条全部 `layer=long`、`privacy=private`、`scope_id=owner-default`。三套设计维度实质单值，从未产生差异化。
10. **置信度/重要度堆积默认值**：confidence 0.6 有 89 条、0.3 有 48 条；importance 0.55 有 88 条。迁移时没算，之后没重算。
11. **README 数字过时**：README/HANDOVER 口径 205 迁移 / 217 总量 / 117 实体；实测 **226**（多 8 条 seed + 1 条 remember），实体 117 对得上。
12. **日志覆盖不自洽**：13 次检索 vs 27 行 usedLater（7 个时间点）——有 6 次检索没有配对判定，说明 turn/end 钩子的判定不是每次都跑，指标分母不稳定。

---

## 7. 结论

### 7.1 什么在被用（真实）

| 层级 | 结论 |
|---|---|
| **真在用** | 极简链路：`brain_remember` 记 13 条 → `brain_search` 查 13 次（59 命中）→ 人看（3 条被证实引用） |
| **在用但是人工** | 冲突页处理 2 次、控制台开关 6 次、删除请求 1 次、备份 1 次 |
| **可用的** | 检索本身是健康的：0 次零命中、20ms 中位数、FTS 双索引进度一致（226/226） |

### 7.2 什么零使用（32 张空表 → 归为 9 类能力）

1. **事件与注入主干**：events / sessions / context_packages / consumer_offsets（connector 路）——**这部分是产品核心卖点，0 次生产验证**
2. **实体与关系**：memory_edges（图空）
3. **反思与总结**：reflections / reflection_runs / summaries / summary_sources
4. **人格**：persona_profiles / persona_versions / persona_conflicts
5. **社交主动**：social_candidates / social_sends
6. **自主执行**：directives / directive_runs / directive_steps / attention_focus / task_snapshots / response_decisions
7. **工作区**：ws_events / ws_candidates / ws_consumers
8. **技能与情绪**：skill_stats / skill_lessons / affect_observations / relationship_events / memory_salience
9. **运维安全**：health_alerts / immune_quarantine / blobs / blob_refs

### 7.3 对「功能是否齐全」的判断

- **代码层面：齐。** 63 张表、7 个 migration、探针与测试都能跑到 576/576 绿。
- **使用层面：不齐。** 50 张业务表里 32 张（64%）零行；真正的使用痕迹只覆盖「记住/查一下」两个动作，且集中在 2 天开发期内、最后一次写入停在约 46 小时前。
- **最要命的两处**：①`events`=0 让所有自主能力没有输入；②`context_packages`=0 让「检索自动进上下文」这条最核心的出路一次没跑过。
- **数据本身是健康的**（quick_check ok、FTS 自洽、迁移数据 205 条完整可读），问题不在数据损坏，**在链路没接通、埋点没覆盖、指标不可用**。

### 7.4 若只修三件事，按性价比排

1. **给 `brain_remember` / `brain_forget` 加 `recordUsage` 埋点**（3 行代码）——否则「记忆到底有没有被记」永远只能靠数 producer。
2. **打通 `events` → 消费链路**，或明确关掉三套自主系统并隐藏对应页面——现在是有页面、有开关、零数据，属于最差的中间态。
3. **把 `used-later` 的 `no_quote_in_answer` 从「null」里拆出来**，否则「记忆有没有用」这个唯一想回答的问题，分母里 89% 是无法判定的哑数据。
