# CONTRACTS — 模块边界与接口契约

> 本文件是全队的对齐依据。改契约必须先改这里，再改代码。
> 母本：《DSH外置大脑-可执行设计方案-v1.2》第 21、22 节。本文件只挑实现必需的部分。

## 0. 工程决策（已定，不再讨论）

| 项 | 决定 | 理由 |
|---|---|---|
| 语言 | 纯 ESM JavaScript + JSDoc `// @ts-check` | 现有 DSH 插件生态（engram / 灵枢 / fox-mood）全是 ESM JS；Node 24 原生跑，无构建链，探针改动即刻生效。TS 只在需要时用 JSDoc 拿类型。 |
| 运行时 | Node >= 22.13（本机 24.19） | `node:sqlite` 内置，实测可用（`DatabaseSync`/`StatementSync`/`Session`/`backup`），不需要原生编译 sqlite3。 |
| SQLite 驱动 | `node:sqlite` | 免依赖、免编译。若后续需要 sqlite-vec 再评估。 |
| 主账 | 单一 SQLite 主账 | 文档 21.2：JSONL 是带水位的异步导出，不是第二主账。 |
| 包管理 | pnpm workspace | 与现有 profile 一致。 |
| 测试 | `node --test` | 零依赖。 |

## 1. 包边界与写入权

**一条铁律：只有 `@dsh-brain/memory` 写记忆；只有 `@dsh-brain/context` 组装上下文；只有 connector 与宿主通信。**

| 包 | 职责 | 允许写 |
|---|---|---|
| `@dsh-brain/core` | 事件信封、ID、时钟、错误类型、纯函数工具 | 无状态，不碰 IO |
| `@dsh-brain/memory` | schema/迁移/事务/outbox/幂等/删除屏障/备份 | `data/brain.db`、`migrations/` |
| `@dsh-brain/search` | 中文检索：FTS5、n-gram、RRF 融合、来源回查 | 只读 memory 提供的连接；不自己建表 |
| `@dsh-brain/context` | 检索→构包→Token 预算→built/attached 状态 | 不写记忆库 |
| `@dsh-brain/backup` | 全量快照、校验、隔离恢复、删除账本合并 | `data/backups/` |
| `apps/connector` | DSH 插件（cordis）：挂 `agent/pre-step`、`system-prompt/assemble`、`session/event` | 只写有界持久队列 `data/events/` |
| `apps/probe` | M0 接入探针：记录真实事件序列 | `data/probe/` |
| `apps/server` | 本地 HTTP API（127.0.0.1） | 不直接写库，走 memory API |
| `apps/console` | 只读控制台 | 无 |

## 2. 事件信封（唯一事实来源，文档 21.2）

```js
/** @typedef {Object} EventEnvelope */
{
  schema_version: 1,
  event_id: 'stable-id',
  source_system: 'dsh',
  source_event_id: 'host-id',
  scope_id: 'owner-default',
  person_id: 'owner',
  session_id: 'session-id',
  turn_id: 'turn-id-or-null',
  step_id: 'step-id-or-null',
  source_seq: 123,
  occurred_at: '2026-10-28T10:00:00.000Z',
  received_at: '2026-10-28T10:00:01.000Z',
  event_type: 'user/message',
  origin_system: 'human',
  causation_id: null,
  payload_ref: 'blob-or-inline-reference',
  payload_hash: 'sha256:...',
  privacy: 'private'
}
```

规则：
- `scope_id` / `person_id` 来自已认证连接器绑定，**不采信消息正文或模型自述**；MVP 固定 `owner`，但校验代码必须存在。
- 唯一约束：`(source_system, scope_id, source_event_id)`。同键不同正文 = 冲突，禁止静默覆盖。
- 宿主无稳定 ID 时由 connector 首次持久入队时生成并复用，**不得按正文哈希去重**（两次相同的人类消息可能是两个真事件）。
- 防循环字段：`origin_system`、`causation_id`、`derived_from[]`。自身注入的上下文、工具回传的历史记忆不得被当成新的独立事实证据。

## 3. 持久化与事务

- 单写入队列；`PRAGMA foreign_keys=ON`、`journal_mode=WAL`、`busy_timeout`、`synchronous` 写进部署清单。
- 同一事务提交：原始事件 + 必要状态推进 + outbox 工作项。**事务提交后才 ACK**。
- JSONL 导出失败不回滚已确认主账：保持 outbox 未完成并告警。
- 消费端 at-least-once + 幂等，记录 consumer offset；**不承诺跨进程 exactly-once**。
- 模型/网络请求不得包在长事务内。

## 4. 数据表（MVP 必需，文档 22.1）

`events`、`sessions`、`memories`、`memory_versions`、`source_refs`、`summaries`、`summary_sources`、`task_snapshots`、`context_packages`、`outbox`、`consumer_offsets`、`deletion_tombstones`、`deletion_jobs`、`backups`、`audit_logs`、`schema_migrations`

## 5. 记忆条目字段（文档 4.3）

`id`、`person_id`、`scope_id`、`layer`(fragment|long|permanent)、`type`(profile|episode|semantic|commitment|skill|self|relationship|boundary)、`content`、`summary`、`source_type`(owner_words|observation|inference|web|tool|summary)、`source_ids`、`confidence`、`importance`、`privacy`(public|private|secret)、`status`(candidate|active|superseded|expired|suppressed|archived|deleted)、`created_at`、`updated_at`、`last_mentioned_at`、`last_recalled_at`、`mention_count`、`recall_count`、`valid_from`、`valid_until`、`supersedes`、`pinned`、`version`、`embedding_version`

推断（`source_type=inference`）必须 `confidence < 1`，**不得伪装成确定事实**。

## 6. 上下文装配：built / attached / sent（文档 21.4）

三级证据边界，不得混用：
- **built**：Brain 构建了包（有 `context_id`、canonical payload hash、`tokenizer_id`、`estimated_tokens`）
- **attached**：包已挂到宿主传入的 assembly/decision 上
- **sent**：最终请求边界已证实包含该片段 —— **没有请求边界证据时禁止声称 sent**

预算公式：
```
brain_allowance = max(0, min(brain_cap, model_window - host_input - output_reserve - safety_margin))
```
拿不到 `host_input` 或准确 tokenizer 时：固定小额上限 + 标注"估算"，不伪造精确 Token。
初始 `brain_cap = 2048`，safety_margin = max(模型窗口 5%, 1024)。**待实测。**

注入方式：`await next()` 后**复制**并追加自带来源的片段，不原地改宿主数组；不注册"完整系统提示"（`complete: true` 会绕过宿主规则）。

## 7. 检索：中文是第一个要证伪的假设（文档 21.5）

- FTS5 是索引框架，**不保证默认分词适合中文**。必须先实测 trigram tokenizer 在本机 `node:sqlite` 上是否可用。
- 中文二字/单字查询另备自维护 n-gram 或安全参数化 LIKE 兜底。
- 保存原文 + 规范化检索文本两份；数字、单位、版本、符号不被不可逆清洗。
- 检索不足必须能区分四种情况：无相关记忆 / 证据不够 / 来源丢失 / 来源冲突。**不用相似结果硬凑。**
- 图扩散限制跳数、候选数和 scope，禁止全图无界遍历。
- **FTS5 语法事实（M2 实测，必须遵守）**：括号组后面**不能**直接跟 phrase 用空格表达隐式 AND —— `("展" OR "板") "尺"` 抛 `fts5: syntax error`，必须写显式 `AND`：`("展" OR "板") AND "尺"`。纯 phrase 之间用空格（隐式 AND）是合法的。
  → 拼 `MATCH` 串时**段间一律显式 `AND`**，不要依赖空格。
  → 触发条件很隐蔽：多段查询里前一段 token 数 > 4 会走 OR 生成括号组，后面还有段就炸。`展板成品尺寸 铝板厚度` 就是。
  → 后果最危险：主路整条降级成 ngram 弱路（P@10 49.9% vs 主路 83.6%），**而 status 可能仍是 ok** —— 静默降级。
  → 上层必须能看见这件事：`diagnostics.primaryLaneHit=false` + notes 说明"结果来自 n-gram 兜底"，不许顶着 ok 蒙混。
- **弱证据不自动丢弃**（M2 定）：构包侧按 `evidenceStrength`（`primary`/`ngram_fallback`/`unknown`）如实标注并照常注入，是否降级由上层策略决定。裁判权在检索层，构包侧再判一次就是双重裁判。

## 8. 删除屏障（文档 21.7）

删除顺序固定：写 tombstone → 增 `deletion_epoch` → 目标与全部派生物不可检索 → 返回 202 → 异步 worker 清正文。
所有派生任务（摘要、提取、导入、恢复）**必须重查删除屏障**。旧 worker 完成后不得把内容写回。

## 9. 探针输出规范（M0）

`apps/probe` 每次运行产出 `data/probe/<runId>/`：
- `timeline.jsonl` —— 逐条 `{ts, hook, seq, phase: 'before'|'after'|'reject'|'pass', payload 摘要}`
- `verdict.json` —— 对文档 23.3 六个问题的逐条回答：`{question, status: 'answered'|'partial'|'unknown', evidence, note}`
- `timeline.md` —— 人工可读时序

探针纪律：**只记录不干预**（除了一个受控的注入实验），不改宿主 messages 数组，不注册 `complete` 节。

## 10. M0 实测修正（优先级高于前面各节）

> 来源：实机探针 `docs/M0-probe-report.md`（`dsh 0.2.1-rc.3` + Node 24.19 真回合）。
> 这四条是会直接毁掉实现的真事实，不是建议。跟前面各节冲突时，**以本节为准**。

### 10.1 装配与写入必须按 step 幂等
`system-prompt/assemble` 与 `agent/pre-step` 是**每 step 一次**，不是每轮一次。多步回合的第 2 个 step 会重新装配整个 system prompt、重过 pre-step waterfall（实测 tool-read：1 turn / 2 step → 2 assemble / 2 pre-step）。
→ 构包与记忆写入必须按 `(session_id, turn_id, step_id)` 幂等；重复调用不得产生重复片段或重复记忆。
→ 模型重试在同一 step 的 `while` 里 `continue`，**不重跑**这两个 waterfall，只重跑 `refreshContext`（仅刷新 runtime-context 文本，不重跑 sections/tools/variables provider）。

### 10.2 连接器 hook 运行期零抛出
插件**运行期**抛错 → `turn/end reason=error` + 进程退出码 1，直接污染用户回合。**加载期**失败（包缺失等）只降级为 warning，宿主照常回答。
→ 每个 hook 顶层 `try/catch`，捕获后只记日志，绝不向宿主抛。
→ 典型雷区：把 `emit` 监听器写成 waterfall（多写 `next` 参数）就是运行期抛错。挂 hook 前必须对照类型声明确认 `@mode`。

### 10.3 隔离验收必须是路径断言
**独立 profile ≠ 数据隔离。** `dsh-base` 默认所有 profile 共享 `$DSH_HOME/sessions` 与 `$DSH_HOME/storages`。
→ "测试/生产隔离"的验收必须写成断言：实际生效的 `session-persistence-jsonl.root`、`storage-json.root`、`session-query-sqlite.path` 落在预期路径。
→ **不接受"我用了独立 profile"作为隔离证据。**

### 10.4 sent 的判据与请求计数
`llm/stream` waterfall 的 `options` 是完整、deep-frozen 的最终请求对象，是本地最强证据边界。注入片段在其中被检索到 → 可称 sent（到"宿主决定发这些内容"这一层），仍**不证明字节出网**。
→ 检查器三级显示 built / attached / sent，sent 判据 = payload hash 在请求对象中命中。
→ 统计请求数必须按 `purpose` 剔除 `session-title` 旁路调用，否则注入次数会算错。

### 10.5 词法表的真实 order 常量
system prompt 侧：`HARNESS_IDENTITY=-1000`、`DEPLOYMENT_PERSONA_PREFIX=0`、`TOOL_*=1000+`、`DEPLOYMENT_PERSONA_SUFFIX=10200`，同 order 按 name 的 code-unit 序稳定排序。
runtime context 侧：`WORKING_DIRECTORY=100` … `WEB_SURFACE=210`。
→ Brain 的片段必须落在**固定、不与工具节抢位置的 order 区间**。

### 10.6 注入必须能自证来源，否则会形成闭环
实机抓到的闭环链（见 `docs/M0-probe-report.md` §4.5.1）：
探针注入的合成标记 → 被灵枢当**用户话语**摄入成记忆节点 → 之后在一个完全没开注入的新会话里被自动召回并再次注入 → 这次进最终请求的片段**不是探针发的**。

→ 所有注入片段必须带可识别来源标记（`origin_system` / `producer` / `derived_from[]`）。
→ 摄取侧必须按来源剔除自身与兄弟引擎的注入，**绝不让注入内容二次沉淀为独立的人类证据**。
→ 来源计数按独立原始事件统计，不按模型重复了多少次。

### 10.7 宿主不做注入仲裁，预算按最厚的 step 留
- 宿主会把多个注入方的块**全部收下**，不去重、不仲裁：实测同一 step 的 `assembly.contexts` 里 `brain-probe:marker` 与 `lingshu:auto-recall` 并列共存。
- 同一轮内注入块会**逐 step 变多**：`tool-read`（1 turn / 2 step）step1 只有 `auto-recall`，step2 变成 `auto-recall` + `session-window`。

→ 唯一注入责任方必须由 **Brain 侧显式指定**，宿主不替你兜底。
→ 静态去重不够用；Token 预算按该轮**最厚的那个 step**留。

### 10.8 历史回查不能在 turn 内同步做
`sessionQuery` 实调两半结果：
- 精确读**全绿**：`observeSession`（source=live / cursor / lease 释放）、`readEvent`、`readSession`（replay validation 通过）、`readSurface`。
- 全文搜索**全灭**：`searchEvents` → `SESSION_QUERY_SESSION_NOT_FOUND`；`searchSessions` → `SESSION_QUERY_INDEX_FAILED: index closed`；`listSessions` → `inactive context`。

根因：`turn/end` 那一刻进程正在 dispose，索引已关。

→ M2 的索引重建与历史回查必须由**独立进程或后台任务**执行。
→ "搜索暂不可用 → 明确弃答"是一等公民状态，不许降级成"没找到"。

### 10.9 sent 判据必须查两级承载形态，且 carrier 词表是三项
同一个 provider 的 system prompt 有**两种承载**，实测都出现：
- 主请求：`systemLen=0`、`systemRoleMessageCount=1`、`systemTextLen=2729`、`carriedIn=request.messages[role=system]`
- 标题旁路：`systemLen=481`、`carriedIn=request.system`

→ **只看 `options.system` 会漏判 sent。** 检查器必须两级都查：`options.system` 与 `options.messages[role=system]`。

**M2 补充：登记的 carrier 是三形态，不是两形态。** Brain 自己的注入通道（`systemPrompt.context()` / `assembly.contexts` / `agent/pre-step`）**实测物化成 user 角色消息**，所以词表是：

```
system | messages[role=system] | messages[user]
```

把「user 消息里的注入」记成 `messages[role=system]` 等于在检查器里显示一个**从未发生的位置**——那是造假，不是简化。
词表外（如 `messages[assistant]`）一律拒绝：这个闸门就是防造假用的。

### 10.10 connector 实测形状差异（类型声明里没有，但决定成败）

> 来源：`apps/connector/README.md` + brainlab 真回合冒烟（run `data/probe/m2-connector-20261028-193301`）。
> 这些是**运行时实测**出来的，照类型声明写会踩空。

1. **`agent` 是运行时字段，类型声明里没有。** `assembleContextFor()` 返回 `{agent, scope: agent, signal}`；`agentEvents` 的 `fused` 把 `agent` 注进**所有** agent 事件 payload。**`agent.session.id` 是拿 sessionId 的唯一途径** —— 照 `AssembleContext{scope?, signal?}` 写，永远拿不到会话身份，幂等键直接废。
2. **`agent.phase.step` 在 assemble 阶段是「上一个 step」。** `phase.step = step` 在 `preStep()` 返回之后才赋值，`phase.turn` 则在 preStep 之前就赋好。所以：assemble 里当前 step = `phase.step + 1`；pre-step 里必须用 `payload.step`。
3. **`interpolate` 是隐形地雷。** `assembly.contexts` 的文本会被 `{{variable}}` 插值，**遇到未注册变量名直接抛错**。注入的是记忆正文（可能含模板代码/花括号）→ PromptContext 必须 `interpolate: false`，否则运行期炸宿主。
4. **`llm/stream` 的 `next()` 返回 `AsyncIterable`，不是 Promise。** `await next()` 再包一层会把流变成 Promise，直接破坏宿主。正确写法是 `return next()`。
5. **cordis waterfall 是同步组合、不 await 展开**：`next()` 返回下游 listener 的原始返回值（可能是 Promise），最外层由宿主 await。
6. **静默失效点**：`assemble()` 末尾在 runtime-context 被抑制时**只保留 `required` contexts**。我们追加的块不是 required，会被静默剔除且不报错。这是已知边界，检查器要知道"没看见"不一定是"没注入"。
7. `refreshContext` 源码确认「waterfall 追加的 contexts 保留 accepted 值」→ 追加路线安全，不需要注册 provider。
8. **摄取侧判据需要两重**：`source.kind !== 'user'` 是比文本标记更早的结构判据，但**兄弟引擎可能写成 `{kind:'user'}`**（M0 探针就是这样）。所以结构判据 + 文本指纹**都不能省**。

### 10.11 摄取分类与三级证据的记录约定

- 连接器入队信封新增 **`ingest_class`** ∈ `human | self_injected | sibling_injected | context_snapshot | tool-output | not-a-message`。
- **只有 `human` 进人类证据通道**（契约 10.6 的闭环就靠这条拦住）。
- 检查器读两类记录：`context_attached`（built → attached）、`context_sent`（attached → sent）。
- `context_sent` 固定带 `evidence_level: 'sent:request-object'` + **`proves_wire_delivery: false`**，诚实标注"未证明出网"。
- 自己的注入写 `source: {kind:'runtime-context', form:'recall'}`。


同一个 provider 的 system prompt 有**两种承载**，实测都出现：
- 主请求：`systemLen=0`、`systemRoleMessageCount=1`、`systemTextLen=2729`、`carriedIn=request.messages[role=system]`
- 标题旁路：`systemLen=481`、`carriedIn=request.system`

→ **只看 `options.system` 会漏判 sent。** 检查器必须两级都查：`options.system` 与 `options.messages[role=system]`。


system prompt 侧：`HARNESS_IDENTITY=-1000`、`DEPLOYMENT_PERSONA_PREFIX=0`、`TOOL_*=1000+`、`DEPLOYMENT_PERSONA_SUFFIX=10200`，同 order 按 name 的 code-unit 序稳定排序。
runtime context 侧：`WORKING_DIRECTORY=100` … `WEB_SURFACE=210`。
→ Brain 的片段必须落在**固定、不与工具节抢位置的 order 区间**。

## 11. M1 实测修正（node:sqlite 真实边界）

> 来源：`docs/m1-notes.md`。实测出来的行为，不是文档承诺。写 M2/M3 时照着来。

### 11.1 回滚必须走 `safeRollback()`
磁盘满（`SQLITE_FULL` = 13）会让 SQLite **自动回滚整个事务**；错误抛出时 `db.isTransaction === false`，此时再执行 `ROLLBACK` 会抛 `cannot rollback - no transaction is active`——**把真正的磁盘满错误顶掉，上层误判故障类型**。

### 11.2 绑定统一走 `toBindable()`
`node:sqlite` **不接受 JS 布尔**（`TypeError: Provided value cannot be bound`），`undefined` / `NaN` / `Infinity` 同样拒。布尔列一律 INTEGER 0/1，所有绑定走唯一入口 `toBindable()`（boolean→0/1、undefined→NULL、Date→ISO、拒 NaN/Infinity）。

### 11.3 部署 PRAGMA（回读值）
`journal_mode=WAL` / `synchronous=FULL` / `busy_timeout=5000` / `foreign_keys=ON` / `temp_store=MEMORY` / `wal_autocheckpoint=1000`。
注意 `busy_timeout` 的 node:sqlite 默认值是 **0**——一撞写锁立刻 `SQLITE_BUSY`，必须显式设置。改 `DEFAULT_PRAGMAS` 必须同步改 `docs/m1-notes.md` 并重跑 `pragmas.test.mjs`。

### 11.4 备份原子落位
`backup(db, path)` 是顶层函数，**会覆盖已存在文件**。要满足"失败不覆盖上一份有效备份"，必须 `.tmp` → 校验 → `renameSync` 原子落位。
另：`UPDATE/DELETE ... LIMIT` 在标准构建不可用，认领类操作一律 `SELECT ids` + `WHERE id IN (...)`。

### 11.5 信封字段收敛
`source_seq` 定为**必填非负整数**（按宿主序号归并、判缺口的前提），连接器在首次入队时分配并复用，不许留空。
信封额外承载受控短期片段 `payload_text`（≤ 256KB，删除时置 NULL）。

### 11.6 测试入口
Node 24.19 的 `node --test <目录>` **不递归目录**，会把目录当模块入口 `MODULE_NOT_FOUND`。
统一用 `node --test "tests/**/*.test.mjs"`（根 `package.json` 的 `test` 脚本）或各目录的 `run-all.mjs`。

## 12. M4 使用统计实测修正

> 来源：2026-10-29 做「使用统计」（ROADMAP 第一优先）时实机踩到的。这一节的每一条都是
> **不会报错、只会让数据悄悄变错**的那类问题——比崩溃难查得多。

### 12.1 使用日志必须显式传临时路径
`apply(ctx, config)` 的 `usageLogPath` 有生产默认值（`data/logs/usage.jsonl`）。冒烟或测试只传
`storePath` 时，合成查询会真的写进生产观察期日志——**比没有统计更糟**：它会让「检索准不准」
这个判断建立在假数据上。所有非生产入口必须显式传临时路径。

### 12.2 失败检索不得计入「零命中」
零命中榜的唯一用途是找语料缺口。把 `ok:false`（空 query、超时、库坏）混进去，榜上会全是故障，
真正的缺口被盖掉。定死的口径：

- `hitCount` / `zeroHitCount` / `zeroHitQueries` / `laneMissCount` **只统计 `ok !== false` 的记录**；
- `hitRate` 分母是 `okCount`（跑完的检索数），不是总调用数；
- 另给 `callHitRate = hitCount / total` 作为含失败的保守口径；
- 失败只进 `failCount` 与 `byStatus`。

### 12.3 控制台路由的 pathname 必须 slice ROUTE
`webServer.register({ kind: 'prefix', path: '/dsh-brain' })` 之后，handler 收到的 `req.url`
**仍然带 `/dsh-brain` 前缀**。切错位不会抛错：`/api/stats` 被切空会命中 `/` 分支，
**返回列表页 HTML 且状态码 200**——上层 JSON.parse 失败后表现为「接口没数据」，而不是 404。
路由验收必须带前缀真发请求（见 `tools/verify-routes.mjs`）。

### 12.4 观测数据不进主账
`usage.jsonl` 是 append-only 观测，不是记忆。写进 SQLite 主账会：拖慢每次记忆写入的事务、
污染备份/恢复/删除账本的口径（删一条记忆不该牵扯使用日志）、并且让日志没法「删个文件就清干净」。

### 12.5 「命中是否被后续用上」工具层判定不了
`brain_search` 的 `execute` 拿不到后续回答。只能留 `usedLater: null` + `usedLaterWhy` 字段，
等 `turn/end` 钩子。**不许**用「同一会话里又查了同一个词」这类代理指标充数——那是猜，不是观测。

### 12.6 模板页必须验内联脚本语法
新页面（`usage-page.js`）是同 HANDOVER 3.7 第 31 条那样的大模板字符串。反引号截断和内联 JS
语法错**在 Node 侧都不报**，只在浏览器里白屏。落地做法：提取 `<script>` 块，用
`new Function(src)` 只解析不执行。

### 12.7 验收要有 HTTP 层
渲染函数单测（拿到 HTML 串）+ 工具冒烟（假 ctx）都验不到「API 字段名和页面对不上」这类静默错位。
`tools/verify-routes.mjs` 起真 server、发真请求、断言真响应体。

### 12.8 语法检查挡不住 ASI：模板页必须真跑一次
`conflicts-page.js` 里这两行**语法完全合法**，但运行时炸：

```js
if (t) chips.appendChild(el('span', 'chip time', fmt(m.validFrom) + ' → ' + fmt(m.validUntil)))
(m.entities || []).forEach(function (name) { chips.appendChild(el('span', 'chip ent', name)) })
```

上一行以 `)` 结尾、下一行以 `(` 开头，**JavaScript 不会自动插入分号**，整段被解析成
`chips.appendChild(...)(m.entities || [])` 的连续调用 → 运行时报
`chips.appendChild(...) is not a function`。`new Function(src)` 只验语法，这类错照样过。

挡法有两条：`tools/verify-pages.mjs`（DOM stub + mock fetch）真执行一遍内联脚本；
或者起真实例在浏览器里跑一次。**「语法通过」不等于「能跑」**。

### 12.9 在模板里写「反引号陷阱」的注释，会再踩一次
12.6 说的反引号截断，2026-10-29 在 `conflicts-page.js` 的注释里**又踩了一次**——
我在解释这个坑时写了一个反引号，模板字符串当场被截断，文件语法错，
整个 `brain-tools` 插件加载失败、`/dsh-brain` 下所有路由 404（连 `/api/stats` 都没了）。

**模板里的注释也不能出现反引号**，哪怕是在解释这个坑。
要提它的时候写「反引号」三个字，别写那个字符本身。

## 13. M6 实体与关系实测修正

> 来源：2026-10-29 做 M6（实体 / 记忆↔实体 / 记忆↔记忆关系）时的实测与迁移结果。

### 13.1 软删除挡不住 `ON DELETE CASCADE`
`memory_entities` / `memory_edges` 上写了 `REFERENCES memories(id) ON DELETE CASCADE`，
但本系统的删除是 `status='deleted'` + `deletion_epoch` 的**软删除**，永远不会触发真 `DELETE`。
所以级联删除在本系统里**等于没写**：所有查询必须自己
`JOIN memories ... WHERE status != 'deleted'`。
实测：把一条记忆标成 deleted 后，靠查询侧过滤，边和关联都正确消失；不靠过滤就会漏回来。

### 13.2 实体 upsert 必须合并，不能分裂
Engram 的 123 个实体里只有 **117 个唯一名**——6 个跨库同名（`dsh-grsai-canvas` / `DSH` /
`小狐狸` / `AGENTS.md` / `Remotion` / `dsh-im`）。若按「一次导入 = 一行」落库，
同一个工具会分裂成 6 行，「按实体查」直接废掉。
合并规则四条：`kind` 不降级（`tool` 不被 `other` 打回）、`aliases` 取并集、
`importance` 取较大值、`source_system/source_ref` **只补空不覆盖**（保留首次出处）。

### 13.3 映射不上就跳过，绝不编造 id
Engram 的 229 条 `node_entities` 里有 **51 条映射不上**——上游 `import-engram.mjs` 按
`MIN_CONTENT=12` 和非 `active` 过滤，那些 node 压根没进我们的库，所以没有 `memory_id` 可对。
必须跳过并计数（连带 13 个实体成为孤儿）。
**不许**用「内容相似」去猜一个 `memory_id`：把关系挂到错的记忆上，比缺关系难查得多。

### 13.4 加迁移要同步改三处，不止白名单
`HANDOVER` 坑 33 说的「改两处白名单」不够，实际是**三处**：

1. `tests/contract/migrations.test.mjs` 的 `EXTRA_TABLES`（不含新表 → 「未登记的表」断言红）；
2. `tests/m2/memory/context-packages.test.mjs` 的回滚测试——它原来写死「回滚最新一个、再回滚 0003」，
   加了新迁移后回滚到的是新版本，断言直接红。改成「回滚所有 `> 0003` 的版本」的循环，以后加迁移不用再改；
3. 任何断言 `schemaVersion === '0005'` 的地方。

**2026-10-31 补记（加 0007 时又踩了一次）**：第 3 条的债是真的——`tests/m6/entities/entities.test.mjs`
里写死了 `schemaVersion === '0006'` 与「最后一版是 0006」，加 0007 之后直接红两处。
处理照 13.10 的原则：**测试意图不变**（M6 的三表在最新 schema 下存在、0006 能干净回滚），
只把写死的版本号换成「磁盘上最后一版」+「先回滚掉 > 0006 的版本再回滚 0006」。
以后再断言当前版本号之前，先想一遍「下一版迁移会不会把它变成假话」。

### 13.5 Engram 的 edges 实测口径与文档不同
实测 8 条边是 **`contradicts` 7 + `supersedes` 1**（不是先前记的 6+2）。
而且 Engram 侧本身存在**自环边**（`from_id === to_id`），迁移时必须拒绝——门面有
`CHECK (from_memory_id <> to_memory_id)` 挡着。能映射上是 6 条，全是 `contradicts`；
那条 `supersedes` 的 to 端没迁过，进不来。

### 13.6 上游数据的错标不替它擦
Engram 把 `context2` / `connector2` / `console2` 几个实体标成 `person`。
迁移**只搬不改**（这些值都在白名单内），留给人工判断。
在迁移脚本里「顺手修正」上游语义，等于让后来人分不清哪些是原数据、哪些是迁移者的推断。

### 13.7 迁移脚本会顺手升级 schema，必须在报告里说
`--apply` 走 `openBrain()`，而它会自动应用未执行的迁移。所以一次「迁数据」实际附带做了
「升级 schema」（本次生产库 0005 → 0006）。这通常正是想要的，但**必须在报告里写明**，
否则接手人不知道库是什么时候、被什么操作改动的。`dry-run` 必须用 `readOnly: true` 打开，
确保预演零写入（本次已核对：预演后 schema 仍 0005、三表 count = 0）。

### 13.8 覆盖率阈值 0.34 → 0.75（由评测集逼出来的）
`DEFAULT_MIN_COVERAGE` 原为 **0.34**，松到「踢脚线**不锈钢**报价」缺了「不锈钢」也算找到，
`status` 判 `ok`。用 §22.3 的 120 用例评测集扫阈值，结果：

| 阈值 | Recall@10 | 无答案用例误答 |
|---|---|---|
| 0.34 | 0.990 | 7 / 15 |
| 0.55 | 0.990 | 3 / 15 |
| 0.65 | 0.990 | 2 / 15 |
| **0.75** | **0.990** | **0 / 15** |
| 0.85 | 0.990 | 0 / 15 |

**Recall 全程不变，误答单调下降** —— 提高门槛只砍误答、不伤召回。
定在 0.75（不选 0.85：结果相同，留余量）。改成 0.75 后全量测试未红（当时是 576/576；
2026-10-30 复核为 **989/989 全绿**），即现有测试的查询覆盖率都在 0.75 以上。

**代价与监控**：更严意味着更多查询落在 `insufficient_evidence`。生产观察期必须盯
`/dsh-brain/usage` 上这个状态的比例——如果高得不正常，说明真实问句的冗余词比评测集多，
阈值该回调。**不许凭感觉调，看数据。**

### 13.9 「弃答」不等于「没命中」——评测口径别再搞错
评测「无答案用例错误确定回答」时，**只有 `status === 'ok'` 才算系统给出了确定回答**。
`insufficient_evidence`（证据不够，别下结论）和 `no_related`（确实没有）都是系统在**正确地弃答**，
把它们算成「错误回答」等于惩罚「老实说不知道」，正好和设计意图相反。
第一版评测就是这么写错的，把 8 条正确答案算成了失败。

### 13.10 安全口径变更必须同步测试，并留下「为什么改」
把「按 ID 直读 / 直写」从「不校验 scope」收紧到「默认按 scope 收口」时，有一条既有测试跟着变：
`tests/m3/deletion/correction.test.mjs` 原本断言跨 scope 调 `supersede` 抛
`INVALID_ARGUMENT` + 「不在同一 scope」。新口径统一抛 **`NOT_FOUND`**——因为旧错误码和文案
等于告诉调用方「**这条记忆存在，只是不归你**」，而「不确认存在性」正是收口的目的之一。

**这不是回归，是口径变更的正确结果。** 处理原则：

1. **测试意图不变**（跨 scope 必须被拒）→ 断言保留，只改错误码；
2. **必须在测试里注释「为什么改」**——否则三个月后会有人以为当年写错了、又改回去；
3. **不许反过来改口径去迁就旧测试**。遇到「测试红了要不要放宽」这种岔路，先问：
   红的是「实现坏了」还是「口径变了」。这次是后者。

## 14. 禁止事项（红线）

1. 不改已安装的 `@deepseek-ai/dsh` 包文件。
2. 不改生产 profile（`~/.dsh/profiles/web`）配置。
3. 不迁移、不改写 Engram / 灵枢 的现有记忆库。
4. 不把凭据写进 URL、日志、导出文档。
5. 不在探针里碰真实私密历史 —— 只用合成数据。
6. 反引号 / 依赖：不引入需要原生编译的依赖（sqlite3、better-sqlite3），除非有充分理由并单独评审。

## 15. M4.6 usedLater 判据与局限

> 来源：2026-10-30 做「命中是否被回答用上」观测闭环（`apps/brain-tools/used-later.js`）。
> 这一节解释**为什么只能这么判**。判据一旦放宽，这份数据就会从「观测」变成「猜测」，
> 而它要回答的是「能不能卸掉灵枢 / Engram」——猜出来的数比没有数更糟。

### 15.1 判据：只认连续 ≥ 12 字原文片段

`turn/end` 时，把本回合每条命中记忆的**正文**与 assistant 最终文本比对：
回答里必须出现正文中**一段连续 ≥ 12 字**的原文，才记 `usedLater: true` + `evidence: 'quote'`。

为什么是 12：

- 6～8 字会把「铝板」「踢脚线」「报价」这类通用词命中当成引用，假阳性会让引用率虚高；
- 24 字以上会漏掉合理摘引（模型常常只摘半句）；
- 12 字大约是一句完整短语的下限，实测语料（踢脚线报价、外墙保温那几条）用 12 能稳定分开
  「引了原文」和「改写成自己的话」。

边界（都是**刻意不做**的）：

- 不做去空格 / 去标点的模糊匹配——那会把「同义不同字」也算成引用，是猜测；
- 不比对 `summary` 字段：判据说的是正文。检索返回的 hit 里只有 summary，没有正文，
  所以 `brain_search` 成功路径**当场**用 `memories.get()` 补读正文缓存（turn/end 时索引已关，
  CONTRACTS 10.8，那时候读不了）。
- 空白会被折叠成一个半角空格（回答和正文的换行位置不可能一致，不折叠等于跨行永远判不出）；
  长度按 UTF-16 code unit 计，「12 字」对中文准确，对 emoji / 代理对会算 2。
- 正文超过 2000 字只缓存前 2000 字：引用出现在更靠后的位置会判不出。已知盲区，
  记忆正文一般远短于这个上限（`brain_remember` 限 500 字），迁入的长文才可能碰到。

### 15.2 没引用原文 → `null`，**绝不记 `false`**

「没出现连续原文」有三种完全不同的情况：模型改写成自己的话、只用了语义、压根没用。
从文本上**分不开**。记 `false` 等于把「测不到」谎报成「没用上」，会让观察期数据看起来
比真实更差，进而误导「要不要保留记忆库」这种判断。

所以口径固定为：

- 引用原文 → `usedLater: true` + `evidence: 'quote'`；
- 其余一切（改写、无 assistant 文本、正文没缓存上、上一回合没等到 turn/end）→ `usedLater: null`
  + 一个明确的 `usedLaterWhy`（`no_quote_in_answer` / `no_assistant_text` / `no_content_cached` /
  `no_hits` / `no_turn_end`）。

`normalizeUsedLaterEntry()` 在落盘前再强制一次：不管调用方传什么，`usedLater` 只可能
`true` 或 `null`。口径错了不会报错，只会让统计悄悄变假，所以锁加在最外层。

禁止的代理指标（CONTRACTS 12.5 明令）：同会话又查同一个词、回答里出现关键词、命中率高低——
都不许用来推算「用上了」。

### 15.3 引用率是**下界**，不是全量

`quoteRate = 被引用条数 / 命中条数`。它只统计「回答里出现了连续原文」的那部分，
模型把记忆改写成自己的话时这里必然漏掉。所以：

- 真实「命中被用上」的比例 **只会比它高**，不会低；
- 它是**下界**，不能当「记忆利用率」直接汇报；
- 分子分母都只算**有命中行的证据**（`hitRows`），零命中的检索单独记 `noHitRetrievals`，
  不进分母（和 12.2 的「失败检索不算零命中」同一个道理）。

### 15.4 与 `usage.jsonl` 是两套口径，别互相校验

| 文件 | 粒度 | 命中计什么 |
|---|---|---|
| `data/logs/usage.jsonl` | 每次**检索**一行 | `hitCount` = 返回条数（含按实体列清单的 `entityItems`） |
| `data/logs/used-later.jsonl` | 每条**命中记忆**一行 | `hitRows` = 参与引用判定的命中条数（不含 `entityItems`） |

`entityItems`（`brain_search` 给 entity 不给 query 时列出的清单）没有 query 命中语义，
混进引用率会把两个口径搅在一起，所以它不计入判定，也就永远不会出现在 sidecar 里。
两个文件的条数对不上是**设计如此**，不是漏记。

### 15.5 时序与副作用边界

- 判定只发生在 `session/event` 的 `turn/end`；`turn/start` 清空上回合的 assistant 文本缓冲。
- **turn/end 之后不调检索、不调索引**：那一刻索引已关（10.8），判定只用内存里缓存的
  「命中 id + 正文 + assistant 文本」。
- handler 顶层 try/catch，**零抛出**（10.2）：观测事故不许变成 `turn/end reason=error`。
  落盘失败只计数（`stats().writeFailures`），不影响对话、不影响其它行。
- 缓存有界（32 会话 × 8 次检索 × 20 条命中 × 2000 字正文）：超限丢最旧，不截断成假数据；
  丢弃条数在 `onDrop` / `stats().droppedSearches` 里可见。
- `assistant/message` 只记**非空**文本，且取**最后一条**（最终回答）；空文本消息
  （纯工具调用）不覆盖，否则会把真正有内容的回答洗掉。
- 日志里**不落记忆正文、不落回答片段**，只记 `quoteLen` 与 `quoteHash`（sha256 前 8）。

### 15.6 隔离纪律（再次强调，这里踩过一次）

`usedLaterLogPath` 与 `usageLogPath` 一样**必须可配置**，冒烟/测试/合成数据必须显式传临时路径。
合成证据写进观察期日志（`data/logs/used-later.jsonl`）比没有统计更糟：它会让「记忆到底有没有
被用上」这个判断建立在假数据上。验收脚本里对应断言：`smoke.mjs` 检查 sidecar 落在临时目录且
日志里不含正文片段。

## 16. M6.2 跨 scope「按 id 直读」收口

> 来源：2026-10-30 复核 `docs/MVP-HARDENING-GAP.md` §A4 时，照着文档给的「文件:行」去核对
> 代码，发现**文档已经过时**：`memories.get` / `summaries.get` / `store.getMemory` /
> `GET /api/memories/:id` 这四条早已收口（另有一份 `tests/m2/memory/scope-isolation.test.mjs`
> 锁着）。真正的洞在文档没点名的地方——实体、关系边、构包、来源。所以这一节的审计结论
> **以代码为准**，别再照抄缺口文档。

### 16.1 口径四条（与 `memories.get` / `updateKind` / `supersede` 完全同一套）

1. **默认按 caller 的 scope 过滤**。不传 `scopeId` 就用绑定值（`bindings.scope_id`，
   `openBrain` 恒定注入），**不是「全库」**。`list` 系列同理——不传不等于不过滤。
2. **跨 scope 与「不存在」同形**。返回型入口给 `null` / `[]` / `{out:[],in:[]}` /
   `{removed:false}`；抛错型入口一律 `NOT_FOUND`。两种结果必须与「这条真的不存在」
   **逐字节一样**（测试用 `assert.deepEqual(跨scope, 真不存在)` 锁死这条）。
3. **`opts.allowCrossScope === true` 是唯一内部越权通道**，必须显式传，
   **不许从 HTTP 暴露**（URL 上写了也不生效，`tools/verify-routes.mjs` 与
   `scope-isolation.test.mjs` 各有断言）。
4. **不改变返回对象形状**。收口只加 `WHERE` 条件，不加字段——多一个字段就可能让页面
   静默错位（控制台是按字段名直取的）。

### 16.2 为什么错误文案里不许出现 "scope" / "scopeId"

这是收口的**一半**，只做过滤不做文案等于漏。

- 403 + 「不在同一 scope」= 明确告诉调用方「**这条存在，只是不归你**」。拿到这个信号，
  攻击者就知道该往哪个 id 上继续撞（枚举、试探、社工）。这比「读不到」更糟。
- 所以越界必须回 **404 + `NOT_FOUND` + 与真不存在同一句文案**（`记忆不存在：<id>` /
  `实体不存在：<id>` / `构包记录不存在：<id>`）。调用方无法从响应里区分两种情况。
- CONTRACTS 13.10 记的是同一条口径的第一次落地（`supersede` 从 `INVALID_ARGUMENT`
  +「不在同一 scope」改成 `NOT_FOUND`）。

**边界（别矫枉过正）**：`构包记录不存在：ctx-b-only` 这种**回显调用方自己传入的 id**
是允许的——那不是我们泄露的信息，砍掉反而丢掉排查线索。不许出现的是「scope 不一致 /
不属于你 / 权限不足」这类说明。测试里的 id 因此刻意不含 scope 字样，`/scope/i` 断言
才判得干净。

### 16.3 审计表（本次以代码为准复核，含改前状态）

已收口、**本次未改**（只补了测试的不管）：

| 入口 | 位置 |
|---|---|
| `memories.get` / `list` / `search`(→`fetchRecallRows`) / `update` / `supersede` | `packages/memory/src/memories.js` |
| `summaries.get` | `packages/memory/src/summaries.js` |
| `snapshots.load`（`task_id` 派生带 scope + 显式双查） | `packages/memory/src/snapshots.js` |
| `entities.list` / `resolve` / `stats` / `updateKind` | `packages/memory/src/entities.js` |
| `memoryEdges.list` / `conflicts` / `stats` | `packages/memory/src/entities.js` |
| `store.getMemory`（主查询 + 取代链前后各查一次） / `store.getContext` / `store.listMemories` | `apps/server/src/store.mjs` |
| `GET /api/memories/:id`（透传 `?scopeId=`） / `GET /api/memories` / `GET /api/search` | `apps/server/src/api.mjs` |
| 控制台 `/api/memories` / `/api/search` / `/api/entities` / `/api/scene`（后者直接 SQL 带 scope） | `apps/brain-tools/index.js` |
| corrections 的 `currentView` / `asOfView` / `chainOf` / `supersede` | `packages/memory/src/correction.js` |

本次**补上**的缺口（改前都是「按 id 直读、不带 scope」）：

| 入口 | 改前 | 改后 |
|---|---|---|
| `entities.get(id)` | `WHERE e.id = ?` | 越界 `null` |
| `entities.memoriesFor(entityId)` | 无 scope，返回别 scope 的记忆摘要 | 越界 `[]` |
| `entities.forMemory(memoryId)` | 无 scope | 越界 `[]` |
| `memoryEdges.forMemory(memoryId)` | 无 scope（边/本条/对端三处都没过滤） | 越界 `{out:[],in:[]}` |
| `memoryEdges.remove(id)` | 按 id 真删 | 越界 `{removed:false}`，不删行 |
| `contextPackages.get(contextId)` | `WHERE context_id = ?` | 越界 `null` |
| `contextPackages.updateStatus(contextId)` | 无 scope（能改别人的 sent 证据） | 越界 `NOT_FOUND` |
| `contextPackages.list` | 不传 `scopeId` = 列全库 | 默认只列本 scope |
| `sources.forMemory(memoryId)` | 无 scope | 越界 `[]` |
| `sources.verify(refId)` | 无 scope | 越界 `source_missing` |
| `GET /api/contexts`（`store.listContexts`） | 不传 `scopeId` = 列全库 | 默认只列本 scope |
| `GET /api/context/:id`（`api.mjs`） | 不读 `?scopeId=`，靠 store 默认值 | 透传 `?scopeId=`（与 memories 同口径） |
| 控制台 `/api/entities/memories` / `/api/conflicts` | 门面调用不带 scope | 显式传 `scopeId` |

**`source_refs` / `memory_entities` 表根本没有 `scope_id` 列**（0001 / 0006 的建表就是如此），
所以这两张表的收口**只能靠 `JOIN memories` / `JOIN entities`**，别加列也别在应用层"先查后判"
（两次查询之间可以插一条删除，判据会漂）。已在 `sources.js` / `entities.js` 的 SQL 里落地。

### 16.4 这次有一条既有测试跟着改（不是回归，是口径变更）

`tests/m6/entities/update-kind.test.mjs` 原来用 `brain.entities.get(others.id)` 跨 scope 读，
来核对「另一个 scope 的那一行确实没被改」。`entities.get` 收口后这条读取会变成 `null`。

处理照 13.10 的原则：**测试意图（核对那一行没被动过）不变**，只把读取方式改成
`get(others.id, { scopeId: SCOPE_B })`（显式声明上下文），并在测试里写明为什么。
**没有放宽任何断言**——被拒的写入该不落库还是不许落库。

### 16.5 已知边界（刻意不做）

- **`memories.get` 的 `opts.scopeId` 是"声明上下文"不是"越权"**：同进程内显式传另一个
  scope 能读到那边的数据。这是设计选择（服务端/CLI 要能多 scope 运维），安全边界落在
  「谁能传这个参数」上——HTTP 层只从 `?scopeId=` 取，而入口只有一个已认证的本机控制台。
- **`sources.verify` 只回 `{ok, reason, refId}`**，收口后跨 scope 归到 `source_missing`；
  它不吐内容，收口是为了不让「refId 存不存在」变成探测面。
- **`contextPackages.save` 的幂等查重仍按全局 `context_id` 查**（不带 scope）。
  理由：`context_id` 是 `newId('ctx')` 生成的全局唯一 id，幂等语义本来就是「这个 id 建过
  就不再建」。返回值只有 `{id, created, status}`，不含正文/段/证据，泄露面仅为「这个 uuid
  已存在 + 它处于四态之一」。**刻意不改**：改成按 scope 查会让跨 scope 撞 id 时直接撞主键
  抛 `SQLITE_CONSTRAINT`，把「幂等」变成「500」——用一个新的崩法换一个微弱泄露，不值得。
  要真的支持多 scope 同时建包，得先把 `context_packages` 的主键改成 `(scope_id, context_id)`，
  那是迁移级改动，不在这次收口范围内。
- **`corrections.supersede` 事务内的 `SELECT ... WHERE id = ?`**（chainLength 遍历、版本留痕
  回读）不带 scope：那些 id 已经在**同一事务的前半段**按 scope 校验过（`oldRow` / `newRow`），
  再过滤一遍只会让代码变长而不增加安全性。判据是「这一行有没有在同一事务、校验之后被读过」，
  不是「SQL 里有没有 `scope_id` 这个字面量」。
- **`deletion.js` / `deletion-worker.js` / `restore.js` 里的按 id 操作不改**：删除执行与恢复
  是整库/屏障口径，`scope_id` 在 `requestDeletion` 入口就已经校验（跨 scope 被拒有测试）；
  在清理 worker 里再叠一层 scope 判断，会让「删除屏障对全库生效」这条更强的性质变弱。
- **审计表里的「已收口」不覆盖未来新增入口**：新加任何"按 id 读"都要在这里登记一行，
  否则下次审计又会从过时文档出发。

## 17. M6.1b 合并同义重复 + 统计口径（2026-10-30）

> 来源：观察期把 6 条 `contradicts` 逐条核验完（4 条同义重复 / 2 条不是矛盾），执行合并之后
> 连带暴露了两个口径问题。**合并动作本身不难，难的是合并之后所有数字都要重新对齐。**

### 17.1 `memories.supersedes` 是单值列——一条新记忆取代多条时会被覆盖

`supersede(oldId, newId)` 把新条目那一列写成本次 `oldId`。**一条新记忆取代 2 条旧记忆时，
第二次调用会把字段覆盖成第 2 个 id**（实测：`mem_b624303a` 同时取代 `mem_d15c64d5` 和
`mem_d9eedfc3`，`memories.supersedes` 里只剩后者）。

- 可追溯性**没丢**：两条旧条目的 `status='superseded'` + `valid_until` 都在，
  `memory_versions` 里各有 `superseded_by:<newId>` 的版本记录（reasons 字段）。
- 但「这条新记忆取代了哪些旧的」**从 `memories` 表里查不全**，要读 `memory_versions` 或反向查。
- **不要为此改成数组/多值列**：那要迁移 + 改所有读 `supersedes` 的地方，代价远大于收益。
  真要一对多，正确姿势是建 `memory_edges(kind='supersedes')` 边（表里已支持这个 kind，
  只是迁移时一条 `supersedes` 边都没建）。

### 17.2 统计口径：分母/分子都只算「可检索的 active」

合并之后实测发现三处数字互相不一致，根因都是 `status != 'deleted'` 这个过宽的口径：

| 位置 | 旧口径 | 现在 | 为什么 |
|---|---|---|---|
| `/api/stats` 的 `memories` | `status != 'deleted'`（217） | **`status='active'`（212）**，另返回 `superseded` 计数 | 封口的检索查不到，算进「记忆数」就是虚报。首页标题写「记忆（封口 5）」 |
| `/api/usage` 覆盖率分母 | `status != 'deleted'`（217） | **`active`（212）** | `superseded` 永远命中不了，塞进分母会稀释覆盖率 |
| `computeCoverage` 的分子 | 命中 id 全算（含幽灵 id） | **只算 catalog 内的**，差额进 `staleTouched` | 幽灵 id 占分子不占分母 → 覆盖率虚高、「从没被查到」被压低 |

**为什么这条对观察期特别重要**：覆盖率 + 「从没被查到」榜是用来判断**语料缺口**的依据。
如果 5 条已封口的历史版本混进分母，它们永远"从没被查到"，会伪装成语料缺口；
如果幽灵命中混进分子，覆盖率又虚高。两头一夹，结论直接反了。

**注意别加 `status != 'deleted'` 这类过宽条件**：本系统的删除是软删 + 墓碑，
`superseded` 是一个**新增的第三态**，任何"数记忆"的口径都要显式回答「算不算 superseded」。
答案：所有面向"能不能被检索到"的统计——**不算**。

### 17.3 合并的执行纪律

- 走门面 `memories.supersede`，**不删任何正文**；对应 `contradicts` 边在合并后删掉
  （矛盾已解决，红条还挂着就是骗人；边可重建，删前把 INSERT 语句打进报告）。
- 脚本 `tools/merge-duplicates.mjs`：默认 dry-run（`readOnly` 打开）、`--apply` 才写、
  幂等（已封口的报 `already` 不再动）、**`--apply` 时自动打印回滚 SQL**。
- **回滚 SQL 落盘不靠记忆**：本次在 `docs/MERGE-ROLLBACK-20261030.sql`。
- 备份必须用 **`VACUUM INTO`**（或 SQLite backup API）做一致性快照。
  **`Copy-Item brain.db` 是错的**：WAL 模式下主文件不含最新提交（实测 `brain.db-wal` 有 4.8 MB），
  而且宿主进程持着文件时 `Get-FileHash` 直接失败。

### 17.4 判断「是不是同一件事」的标准

不是「哪条写得好」，而是：**把两条摆在一起，能不能说「这是同一件事的两种说法」**。

- 是 → 合并，保留信息更全、没有过期上下文的那条（**方向反了就是拿信息换重复**）。
- 不是（互补 / 不同粒度 / 不同实例）→ **保留不动**，宁可留着 `contradicts` 让人看。
  本次 2 条不是矛盾的（插件安装 skill vs 抖音安装 episode、M3 结论 vs M3 实现细节）就没动。
- 永不自动选边。人核验完再动手，动作要能回滚。

## 18. M7 交互三件（分页 / 矛盾核验动作 / 治理只读内嵌）

> 来源：2026-10-30 主人在真实使用中提的三条——「列表页做分页」「矛盾可以直接选择」「治理面板打不开」。
> 三条都不是新功能，是**把只读视图补成可用的**。但它们都碰到「写」和「口径」，所以单独成节。

### 18.1 「治理面板打不开」→ 进程内拉起 + 同源代理（**不用再敲命令**）

先记两个结论：

1. `node apps/server/index.mjs --port 7420` 起完是 **200 / 15.6 KB 正常**——不是坏了，是没起。
2. **第一版只内嵌了只读视图，被主人否了**：「治理面板不要输入命令打开」。只读页能看不能动，
   写操作还得开终端——那不是解决问题。

最终做法（`apps/brain-tools/index.js`）：

- **进程内启动治理服务**：插件 apply 时 `import('../server/src/server.mjs')` 调 `startServer()`，
  默认监听 7420、用**同一个库**（`storePath`）。dsh web 活着它就在，不用另开终端。
- **同源代理**：`/dsh-brain/governance` 及其子路径透明转发到 127.0.0.1:7420。
  删除 / 备份 / 恢复全都能点。
- **API 路径补丁**：治理页面的 `app.js` 用绝对路径 `/api/...`，直接代理会打到 3080 的根路径（404）。
  所以在代理 HTML 时注入一段 shim，把 `fetch` / `XHR` 的 `/...` 改写到 `/dsh-brain/governance/...`。
  **不改原 console 代码**——为了内嵌去改业务前端是最容易埋坑的做法。
- **端口被占用 = 已有服务**：`EADDRINUSE` 不当失败，直接代理到那个已有的 7420
  （主人自己起过服务的情况本来就有）。
- **失败一律降级**：启动失败不抛（插件加载失败会让整站 404，CONTRACTS 3.7），
  此时 `/governance` 退回只读页（`governance-page.js`，保留作 fallback）。
- **dispose 要关**：`ctx.effect(() => { 启动; return () => close() })`。
  不关会留监听句柄——实测 node 退出时报 `Assertion failed: UV_HANDLE_CLOSING`。

**为什么 token 保护没有被拆掉**（这条是当时否掉「裸挂写操作」的理由，现在成立）：

- 治理服务仍然只认 `Authorization: Bearer` / `X-Brain-Token` 头，**不认 cookie**；
- 页面由治理服务自己渲染，token 写在 `<meta name="brain-token">` 里；
- **跨站读不到那张页面**（同源策略），所以攻击者拿不到 token，也就发不出能通过鉴权的写请求；
- 实测：`POST /dsh-brain/governance/api/memories` 不带 token → **401**（`tools` 外的临时脚本验过 5/5）。

**代理只改写 HTML**：只对 `content-type: text/html` 缓冲并注入，其余（JS/CSS/API/附件）原样流式转发。

安全提示（留给将来）：这条代理链路**依赖「3080 只在本机回环」**。
如果哪天把 3080 暴露到局域网，等于把治理能力一起暴露了——那时必须先做认证，再说内嵌。

#### 18.1.1 定稿：主入口改成 302，不做 HTML 代理改写（2026-10-30 夜）

**⚠️ 上面那套「代理 + 注入 shim」被真实使用否掉了。** 主人点 `/dsh-brain/governance`
看到的是一张**没有样式、永远「连接中…」**的裸 HTML——功能确实是「打不开」。

两个根因（都是 HTML 改写这条路线的结构性坑，不是实现漏了一行）：

1. **静态资源是绝对路径**：面板 HTML 里是 `<link href="/assets/styles.css">`、
   `<script src="/assets/app.js">`。代理到 `/dsh-brain/governance` 之后，这些请求打到
   3080 的**根路径** → 404 → 没样式、脚本不执行。
2. **CSP 会挡掉注入的内联 shim**：面板响应头是
   `Content-Security-Policy: default-src 'none'; script-src 'self'; ...`。
   注入的 `<script>…</script>` 内联块**不执行**，fetch/XHR 路径补丁等于没写。

要在非根路径下渲染别人的页面，得同时搞定「静态资源路径重写 + API 路径重写 + CSP 豁免」，
三件事每一件都会因为页面的一个新资源、一条新规则而悄悄失效——**做出来极易是「能打开但用不了」的半成品**。

**最终做法**：`/dsh-brain/governance`（精确路径、GET/HEAD）直接 **302** 到
`http://127.0.0.1:<governancePort>/`。功能 100% 一致，零改写、零维护。
子路径 `/dsh-brain/governance/api/*` 保留代理（老书签与相对请求还能用）。

**代价**：地址栏会变成 7420。这是可接受的——7420 的面板顶部已经有「记忆视图」入口条
（`.mnav`，链到 `/dsh-brain` 六页），且 7420 自己反向代理宿主，回得来。

**教训（写给自己）**：交付「代理/内嵌别人的页面」之前，必须真在目标路径下打开看过一次。
这一版我用临时 3080 验过「HTML 能取到、API 能转发」，但**没在浏览器里看渲染结果**，
所以「样式和脚本 404」这件事完全没被发现。以后这类活，验证标准是「页面能看、能用」，
不是「接口 200」。

### 18.2 矛盾核验动作的语义（与命令行版一致）

| action | 库里的变化 | 文案必须这么说 |
|---|---|---|
| `keep-left` | 右侧走 `supersede` 封口（`status=superseded` + `valid_until` 落值 + 正文不删 + `asOf` 可回看），然后删矛盾边 | 「右侧封口」，不是「右侧删除」 |
| `keep-right` | 左右反过来 | 同上 |
| `not-conflict` | 两条记忆一个字都不动，只把边改成 `refines`/`supports`（删矛盾边 + 建新边） | 「只改关系，记忆不动」 |

**为什么必须两步确认**：三个动作里有两个会改变「哪条记忆还生效」，一次点击就执行 = 手滑封掉历史版本。
所以第一次点只把**后果**写进卡片（含「封口 / 正文不删 / asOf 可回看 / 删边」），3 秒不点第二次自动退回；
第二次点才发请求。**不用 `window.confirm`**——DOM stub 里跑不了，冒烟测试会红，等于这条防线没有自动化。

### 18.3 3080 上的写接口怎么防 CSRF（以及为什么不加 token）

`POST /api/conflicts/action` 要求：

1. 请求头 `X-Brain-Action: 1` —— 浏览器**跨站**请求带不上自定义头（要 CORS 预检，而本服务不答预检），
   这一条挡住典型 CSRF；
2. 若带 `Origin`，hostname 必须是 `127.0.0.1` / `localhost` / `::1`（端口不校验，真机验证会起 3081）。

**不引入 token 的理由**：token 只能放在页面里，等于把钥匙贴在门上。要真正强鉴权，该走 7420 那套；
3080 的定位就是「本机、已登录 DSH 的人看的控制台」。

### 18.4 分页：offset 与 cursor 互斥，列表只列 active

- 门面 `memories.list` 原来只有键集游标（`(created_at, id)`），给不出页码和总数。
  这次加 `offset` + `total`，**与 `cursor` 互斥**（同时传抛 `INVALID_ARGUMENT`）：
  连续翻页/后台遍历用 cursor（深翻不漂移），人点页码用 offset（多一条 COUNT，可接受）。
- `/api/memories` 现在**只列 `status='active'`**：`superseded` 是合并封口的历史版本，
  混进「现在能用的记忆」列表会让人以为它还在生效（与 §17.2 的口径同源）。
- 越界 `offset` 返回**空 items 但 total 真实**：「越界了」和「库里没有」是两件事，
  页面要能分辨（前者提示回第 1 页，后者是真空）。
- 前端「有没有下一页」只听服务端 `hasMore`，**不自己用 `page < pages` 算**——取整一偏就会把最后一页点空。

### 18.5 核验动作必须留痕：`data/logs/conflict-actions.jsonl`

`supersede` 会写 `memory_versions`（封口那半边有痕），但「谁在哪一刻点了哪个按钮、把哪条边删了」
原本没有任何地方记录；而删边是派生结构（可重建），**重建要先知道当初是什么**。

所以每次动作落一行 append-only 流水：edgeId / action / kind / fromId / toId / keptId / supersededId /
newEdgeId / edgeRemoved / scopeId / actor。**不记正文**（正文进日志等于把隐私复制一份到别的文件）。
写失败不抛——库已经改成功了，日志写失败只能是 `logged:false`，不许把成功的库写入报成失败。

路径同样必须可配置（`config.conflictLogPath`），验收脚本显式传临时路径；
否则「测试点过的核验」会混进生产流水，让人以为真有人处理过那些矛盾（CONTRACTS 12.39 的老账）。

### 18.6 补录「文档里有、库里没有」的结论

观察期实测（`OBSERVATION` 第七节）说明：迁移搬的是「对话里说过的话」，没搬「文档里沉淀的结论」。
补录走 `tools/seed-project-facts.mjs`（默认 dry-run、幂等按 content 精确比对），并且：

- **`sourceType='observation'` + `confidence=0.8`**，不是 `owner_words`——这些是我读文档整理的，
  不是主人亲口说的。记成 `owner_words` 是虚报，还会毁掉 M5「observation 才算我看到的」的区分度。
- 每条都带 `basis`（依据文件与章节）并 `sources.link(sourceKind='document', locator=<依据>)`，
  检索时不会报 `source_missing`。
- 顺手给 `brain_remember` 加了可选 `origin`（`owner_words` 默认 / `observation`），
  默认行为不变——它原来硬编码 `owner_words` + `confidence=1`，把文档结论记成主人原话就是虚报。

## 19. M7.2 情感状态并入主账（2026-10-31）

> 来源：主人要把「心情 / 精力 / 亲密度」跟外置大脑合并。原来这套状态只活在
> `~/.dsh/fox-mood/state.json`（情感插件的私有文件），和主账是**两套数据、两套备份**：
> 备份 `brain.db` 备份不到心情，换个 profile 就丢状态，而且「此刻的我」永远进不了任何可查询的地方。

### 19.1 为什么**不能**写进 `memories`

这份状态每 5 分钟演化一次，一天 288 条。写成记忆会：

1. **把检索稀释成垃圾**——问「名片用什么纸」时，一半命中会是「18:42 心情 85」；
2. **混淆两种东西**：`memories` 回答「我以前说过/定过什么」（可检索的长期知识），
   情感状态回答「此刻的我是什么样」（实时读数）。前者该被检索，后者该被**直接读**。

所以走**专用表** `fox_state` / `fox_events`，**不进检索索引、不进 memories、不参与任何检索排序**。
测试里锁死了这条（`tests/m7/mood/mood-facade.test.mjs`：写事件后 `memories` 与三套检索索引都是 0 行）。

### 19.2 两张表的分工，以及时间列为什么两种形态

| 表 | 是什么 | 读取形态 |
|---|---|---|
| `fox_state` | 单行快照（`CHECK (id = 1)`），「此刻的我」 | 直接读那一行 |
| `fox_events` | 事件流水，是状态变化的**原因** | 只读「最近 N 条」（`at DESC` 索引） |

时间列分两种形态，**别统一**：

- `created_at` / `updated_at` / `*_local`：TEXT ISO。主账的记账口径（§11 的「时间列一律 TEXT ISO」），
  跨表 join、人工排查、备份核对都按这个形态。
- `at` / `last_interact_at` / `last_proactive_at`：REAL 毫秒。这三个值是**状态机的运算锚点**，
  `core.js` 里全是 `now - lastInteractAt > 30 * 60_000` 这类毫秒算术；存 ISO 每次都要 `Date.parse`，
  多一次转换就多一个时区出错的地方。

因此门面 `mood.getState()` 返回的也是混合形态：`createdAt/updatedAt` 是 ISO 字符串，
`lastInteractAt/lastProactiveAt` 是毫秒数字。**调用方自己转一次**（插件里只转一处，见 `brain-bridge.js`）。

### 19.3 **明确不做 scope 过滤**（§16 的显式例外）

§16 的口径是「默认按 caller scope 收口」。`fox_state` / `fox_events` **不适用**，理由：

- 它们的语义是**「这一个我」的状态**，不是「某个 scope 掌握的记忆」。
  心情不会因为换了项目目录就变成另一个人的心情。
- `fox_state` 只有一行、**没有 `scope_id` 列**（0007 的建表就是如此）；
  `fox_events` 同理。没有列就没有「按 scope 过滤」这件事可做。
- 门面 `mood` 的六个方法**都没有 `scopeId` 参数**，传了也不生效
  （测试用 `listEvents({ limit, scopeId })` 与不传的 `deepEqual` 锁死）。

**已知边界**：真要支持多实例（一个进程管多个「我」），正确做法是加 `instance_id` 列并改主键，
**不是**借 `scope_id` 糊上去——那会让「owner-default 的心情」和「owner-other 的心情」变成
两份互相看不见的数据，而主人只有一个。

### 19.4 brain 为准、state.json 为缓存：降级契约

这是本次改造唯一真正的风险点，口径写死在这里：

1. **主账可用 → 读写主账**（`data/brain.db` 是唯一真相）；
2. **主账不可用 → 全部退回 `state.json`**（插件的 `core.js` 照常演化，功能一个不少）；
3. **不论哪种情况，`state.json` 永远照写**。它是**缓存副本**，不是被淘汰的旧路：
   主账哪天坏了、被搬走了、schema 升级失败，掉下来的那份就是完整的当下状态，而不是空白。
   所以落盘顺序是**先本地、后主账**——本地成功而主账失败，状态没丢；反过来则会出现
   「主账说写进去了、本地副本却还是旧的」这种窗口。
4. **启动时两份都比一遍**：`updatedAt` 更新的一份作准，**事件取并集**（两侧独有的事实都不丢）。
   相等时取主账——迁移刚做完的典型情况就是相等，取本地会让第一次启动又转回旧值。
5. **插件不硬依赖 `@dsh-brain/memory`**：动态 `import` + try/catch，先按包名、再按绝对路径
   （当前 pnpm workspace 没把 `@dsh-brain/*` 链接到插件目录下）。拿不到就降级，**不抛**——
   记忆库打不开是记忆层的故障，不该变成对话事故。

一句话结论：**主账不可用时不会丢状态**——`state.json` 每次都写、事件取并集、
插件内存里的演化状态也一直在；主账恢复后下一次 `persist` 就把本地状态校准回去。

### 19.5 幂等键：`fox_state` 单行 upsert，`fox_events` 按 `(at, kind)`

- `fox_state`：`INSERT ... ON CONFLICT(id) DO UPDATE`，`created_at` 不在 SET 里
  （那是「这份状态第一次进主账的时刻」，被每次 tick 刷掉就再也答不上「从什么时候开始算」）。
- `fox_events`：**同一毫秒的同类事件视为同一次记账**，重复写返回既有 id、`created: false`。
  为什么事件也去重：迁移脚本会反复跑、插件可能重放一回合，制造重复事件等于把
  「最近发生了什么」讲成结巴——而这恰好是注入提示词和主动引擎要读的东西。
  真实调用里同一毫秒记两次同一种情绪几乎不可能（`Date.now()` 毫秒级），真出现也是同一动作被记两遍。

### 19.6 迁移工具 `tools/import-fox-mood.mjs`

- **默认 dry-run**：只读 `state.json` + `readOnly` 打开主账，一个字节都不写；
- `--apply` 才写：1 条状态 + 全部事件；若目标库还停在 0006 会**自动应用 0007**
  （§13.7 的老账：迁移脚本顺手升级 schema 必须在报告里点名，这次报告里有专门一行）；
- **幂等**：第二遍跑全是 `already=N`（实测：56 条事件，第二次 `created=0 / already=56`）；
- `--state=` / `--brain=` 可覆盖两端路径——**测试与演练必须用临时库**，别拿生产练手；
- 报告要打印：将迁移多少条 / 已存在多少 / 坏条目多少（含明细）/ 有没有写入失败。

### 19.7 已知边界（刻意不做）

- **插件改动要重启 dsh web 才生效**：宿主加载插件是一次性的。本次交付不重启任何跑着的实例
  （`--apply` 也由人统一执行）。
- **不自动 `pruneEvents`**：事件表是唯一会无限增长的情感数据，但「什么该忘」需要有依据。
  门面提供了显式入口（`pruneEvents({ keep })`，默认 500），由人看过 `stats()` 再决定。
- **插件与 `apps/brain-tools` 各持一个连接**：WAL 下多连接是支持的，写入撞锁由
  `SQLITE_BUSY` 的退避重试兜（门面层没有自动重试，插件的写失败只记日志 + 靠 state.json 兜底）。
- **`BACKUP_TABLES` 清单没有登记这两张表**：备份是整库 SQLite backup，两张表自动包含在快照里；
  清单只用于「逐表核对行数」的报告。M6 的 `entities` 三表同样没登记，口径一致。

## 20. M5 Phase 1 自动提取（规则型，2026-10-30 夜）

> 主人说「之前的那些都可以开工了」，M5 从本轮动工。它是项目**风险最高**的一块——
> ROADMAP 的原话：「自动提取质量差会污染记忆库，**污染比没有更糟**」。
> 所以这一阶段只做规则型，不调模型。

### 20.1 为什么 Phase 1 不调模型

Brain 自身**不发 LLM 请求**（架构约定，`apps/connector` 只旁路 `llm/stream` 不主动调模型）。
规则型只认「明确到不需要解释」的句式，**宁可漏、不能错**——这是「污染比没有更糟」的直接推论。
语义提取（模型版）要等观察期数据够、且必须有配额与开关，那是 Phase 2 的事。

### 20.2 四道闸 + 四条规则（实现 `apps/brain-tools/auto-extract.js`）

**整句闸先于规则**，任一命中整条丢弃：疑问（问号 / 句尾「吗呢么嘛」/ 回顾性疑问）、
假设（如果/要是/假如/万一/就算…）、第三人称转述（他说/据说/听说，排除「听说读写」）、
否定（只看触发词前 12 字窗口）、反讽（个屁/才怪/鬼才…）、内容闸（<2 字 / 指代开头 ≤6 字）。

| rule | 触发 | 额外闸 | 归类 |
|---|---|---|---|
| `remember-verb` | 记住 / 记一下 / 别忘 / 记下来 | 挡回顾句（`我记住的是…`） | 含偏好词→preference，否则 fact |
| `always-use` | 以后都 / 统一用 / 一律 / 默认用 / 别再 | — | preference |
| `switch-to` | 改成 / 换成 / 定下来 / 就按这个 | 挡换位假设（`换成你是…`） | decision |
| `first-person-fact` | 我的 / 我这边 + **是/用** | 挡瞬时时态词与「我的意思是」 | fact |

**「在」分支被砍了**（采纳实现者建议，删 `|在` 一行即可回滚）：「在」后面几乎必然是瞬时状态
（在忙/在等/在改），靠词表兜不住，而这类漏网最难抽检——「我这边在杭州出差」长得像事实。

### 20.3 配额：判定即扣，内存计数，不建表

每轮 1 条 / 每会话每天 5 / 全局每天 20；跨天按**本地日期**清零。
**判定命中就扣**（不等写库成功）——配额防的是提取噪声，噪声在候选产生那一刻就存在；
被去重挡掉、写库失败也照扣。为此加了一个「同一 turn 只判定一次」的 `judgedTurns` 集合
（模块文档点名过：重复 judge 会重复扣配额）。

### 20.4 写库纪律（每条都是硬的）

- `sourceType: 'observation'`（**不是 `owner_words`**——这是机器读的，不是主人原话）
- `confidence: 0.6`、`importance: 0.4`（居中偏低；错了也不该顶掉真记忆）
- `producer: 'brain-tools:auto-extract'`，`summary` 末尾必须带 **`（自动提取）`**
  （一眼能在列表页认出来是机器写的）
- **去重**：同 scope 同 `content` 已存在就不写，记 `duplicate`。自动提取绝不能制造重复
  （本项目刚花力气合并过 5 对同义重复）
- **必须 `sources.link`**（`sourceKind='tool_call'`，locator 指向本轮 turn），否则检索会报 `source_missing`
- sidecar `data/logs/auto-extract.jsonl`：**只记 excerptLen 不记原文**（隐私）

### 20.5 只在 `turn/end reason=completed` 之后提取

中断（aborted）、报错、被限流的回合不提取——那时主人的话可能没说完。
提取是 **fire-and-forget**（`void runAutoExtract(...)`），不阻塞、不影响回合；
整段零抛出（抛错会让 `turn/end reason=error`，CONTRACTS 10.2）。

### 20.6 关掉的方式

`config.autoExtract === false` 或环境变量 `BRAIN_AUTO_EXTRACT=off`。
关了之后：候选为空、`skipped: 'disabled'`、sidecar 记一行 `skipped_disabled`——**关掉也要留痕**。

### 20.7 已知误提（人工抽检清单）

实现者自己标的两类，抽检时优先看：

1. `rule=switch-to` 且 content 以「方案 / 这个 / 那样」开头 → 「定下来」被逗号切断，真决定丢了（**失真**，不是错记）
2. `rule=first-person-fact` 且 content 含「习惯 / 做法 / 风格 / 一般 / 通常」→ 其实该归 preference（**类型不准，内容真**）

**抽检入口**：`data/logs/auto-extract.jsonl` 里 `status=created` 的行，按 `rule` 分组看。

### 20.8 验收证据（2026-10-30 全链路真跑，临时库）

注入四个回合：①明确指令 ②疑问句 ③假设句 ④中断回合。结果：

```
写进库的记忆: 1 条
 · content="以后都用 pnpm" | type=semantic | sourceType=observation
   | conf=0.6 | imp=0.4 | summary="主人明确要求记住：以后都用 pnpm（自动提取）"
   | producer=brain-tools:auto-extract
来源关联: 1 条
sidecar: 1 行 {"rule":"remember-verb","status":"created","excerptLen":30,...}
```

只有第 ① 个回合被提取；疑问、假设、中断全部不命中。这就是「宁可漏」的实测样子。
