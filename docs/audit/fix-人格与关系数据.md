# 修复：人格与关系数据（task-8）

> 执行者：`persona-data`（teammate）
> 执行时间：2026-10-31 00:37 – 00:52（Asia/Shanghai）
> 生产库：`E:\ds-h\dsh-brain\data\brain.db`（被 3080 的 dsh web 进程持有，WAL 模式）
> 实际运行环境：**Node v24.19.0**（任务书写的是 v22.22.2，本机实测是 24.19.0；`node:sqlite` 与 `zlib.zstdDecompressSync` 均可用）
> 结论：三步全部完成，页面三块空数据已变成真实数据；`node --test` 989 pass / 0 fail。

---

## 0. 改前状态（实测）

`Invoke-RestMethod http://127.0.0.1:3080/dsh-brain/api/persona`（2026-10-30T16:34:57Z）：

| 关键字段 | 改前值 |
|---|---|
| `profiles` | `[]` |
| `activeVersion` | `null` |
| `versions` | `[]` |
| `relationship` | familiarity 0.1 / trust 0.1 / intimacy 0.1 / rapport 0.1 |
| `social.skipped` 中 schedule | `insufficient_history（少于 5 条互动记录，不知道作息）` |

表行数（备份时同一次只读快照）：

| 表 | 行数 |
|---|---|
| `memories` | 226 |
| `person_models` | 1 |
| `persona_profiles` | 0 |
| `persona_versions` | 0 |
| `persona_conflicts` | 0 |
| `relationship_states` | 1 |
| `relationship_events` | 0 |
| `proactive_policies` | 1 |

> 注意：`person_models` / `relationship_states` / `proactive_policies` **本来各已有 1 行**——冷启动已经跑过，只是关系事件是空的。所以页面看到的「全 0.1」不是缺行，是初始值本身。

---

## 1. 备份（动手前，纪律第一条）

用 SQLite **在线 `backup()`**（`node:sqlite` 的 `backup()`，不是文件拷贝——生产库在 WAL 模式且正被服务持有，裸 copy 会拿到中间态）：

```
node tools/backup-manual-persona.mjs
```

| 项 | 值 |
|---|---|
| 备份路径 | `E:\ds-h\dsh-brain\data\backups\manual-before-persona-data-20261031-003706.db` |
| 源库字节 | 4,399,104 |
| 备份字节 | 4,403,200 |
| 源库 `PRAGMA integrity_check` | `ok` |
| 备份 `PRAGMA integrity_check` | `ok` |
| 关键表行数比对 | 全部一致（含 `memories` 226） |

工具：`tools/backup-manual-persona.mjs`（新增）。它会先读源库快照，备份后再读备份文件，**行数不一致或 integrity 不是 ok 就退出码 1**，不会让后续步骤在坏备份上继续。

---

## 2. A 步：人物模型冷启动

```
node tools/init-person.mjs --dry-run
node tools/init-person.mjs
```

两次输出一致：

```
已存在：person=owner 显示名=主人 cold_start=1
（幂等：不覆盖已有关系值，避免把你调过的亲密度刷回 0.1）
```

**判断**：脚本按设计幂等（`INSERT OR IGNORE` + 已存在只报告），人物模型本来就在。**A 步没有产生任何写入**，这是正确行为，不是失败——强行覆盖会把关系值刷回 0.1。

| | 前 | 后 |
|---|---|---|
| `person_models` | 1 | 1 |
| `relationship_states` | 1 | 1 |
| `proactive_policies` | 1 | 1 |
| `cold_start` | 1 | 1 |

---

## 3. B 步：人格版本导入并激活

### 3.1 先只读解析（不碰库）

```
node tools/import-persona-fox.mjs --dry-run
```

来源：`C:\Users\su\.dsh\AGENTS.md`，10,333 字节，`sourceHash=1cfd8a5440d2757ea516d6e5743b6d477a0ebad0b6aed2086a39d946603b9677`（sha256，用于「文件改了才重新导入」）。

九字段解析结果（中文 Markdown 的标题层级识别正确）：

| 字段 | 条目 | 字数 | 首个条目 |
|---|---|---|---|
| identity 身份 | 4 | 136 | 小狐狸 |
| values 价值观 | 6 | 267 | 值得托付：说「做完了」就是真做完了…… |
| boundaries 边界 | 4 | 137 | 你的隐私归你…… |
| tone 语气 | 11 | 454 | 温柔，但有骨头…… |
| address 称呼 | 4 | 113 | 主人（avoid=你） |
| relationshipDefaults 关系 | 10 | 370 | 独立个体 + 你的搭档…… |
| taboos 禁忌 | 8 | 372 | 严谨到底：不确定就验证…… |
| examples 例子 | 18 | 198 | 6 条「情绪泄露通道」表格 |
| longTermDirectives 长期指令 | 15 | 636 | 本机范围里的事，直接做…… |

五层：`locked` 3 键 645 字 / `base` 6 键 2038 字 / `learned`、`userOverride`、`transient` 空。
`needsReview`：无。`ignoredSections`：`八之二、记忆的放进与清出`、`八之三、别把自己弄丢`（未命中任何角色关键词，**如实忽略而不是硬塞**）。
渲染 token 估算：2,636。

### 3.2 写库 + 激活

```
node tools/import-persona-fox.mjs
```

| 项 | 值 |
|---|---|
| profile | `ppr_89e5e880a2551154a83312c5`（name=小狐狸，sourceType=`agents_md`） |
| version | `pver_8f99e7bdac23dfe641bd5a6f`，v1 |
| 状态流转 | `draft` → `active`（`activatedAt=2026-10-30T16:38:00.725Z`，by=`persona-data`） |
| 渲染 | `tokens=2464 truncated=false` |
| 幂等复跑 | `created:false, unchanged:true` + `activated:false, alreadyActive:true`（不新建版本） |

工具：`tools/import-persona-fox.mjs`（新增）。全程只走门面（`readPersonaFile` / `parsePersonaMarkdown` / `layersFromFields` / `profiles.importFromFile` / `versions.activate`），没有手写一条 INSERT。

| | 前 | 后 |
|---|---|---|
| `persona_profiles` | 0 | 1 |
| `persona_versions` | 0 | 1（active） |

> 口径提示：API 里 `activeVersion.tokenEstimate=593` 是建版时写进 `token_estimate` 列的字段级估算；`renderForContext` 报的 2,464 是渲染成注入文本后的估算。两者口径不同，不是矛盾。

---

## 4. C 步：从真实会话补关系事件

### 4.1 数据从哪来、怎么筛（这一步最容易造假，写清楚）

来源：`C:\Users\su\.dsh\sessions\--E-ds-h--\<会话>\session.v4.jsonl.zstd`，106 个会话文件。

**多帧解压**：文件是多帧 zstd，`zlib.zstdDecompressSync` 只解第一帧。按魔数 `28 b5 2f fd` 切帧，逐帧解压后拼接：

| 项 | 值 |
|---|---|
| 会话文件 | 106 |
| zstd 帧 | 48,417 |
| 解不开的帧 | 0 |

**只取主人真开口**：先要求 `event.type === 'user/message'` 且 `event.data.source.kind === 'user'`，得到 **333 条**。但这 333 条里有水分——必须再按会话身份剔除：

- 子代理会话（`origin='subagent'`、`delegationDepth=1`、有 `parentSession`）里的 `source.kind='user'` 是 **agent 派活时注入的 prompt**，不是主人说话；
- 这类共 **56 条**，全部剔除。

→ **277 条是主人真实开口**（顶层会话，`delegationDepth=0` 且无 `parentSession`）。

**一次互动的口径**：同一会话里相隔不足 10 分钟的消息算同一次对话，合并成一个互动段，段起点即事件时间。选 10 分钟不是随手取——`relationship.js` 的 `COOLDOWN_WINDOW_MS` 正好是 10 分钟，聚合到这个粒度就不会出现「同一段对话被冷却窗口夹成 0 增量」的自欺欺人结果。

| 项 | 值 |
|---|---|
| 真实开口消息 | 277 条 |
| 合并成互动段 | **141 个** |
| 时间范围 | 2026-08-14 14:26:23 → 2026-10-31 00:27:15（跨度 77 天） |
| 近 14 天段数 | **90 个**（要求 ≥20，实际 4.5 倍） |
| 涉及会话 | 102 个 |

按天分布（段数）：`08-14:1, 09-27:5, 09-29:1, 09-30:2, 10-01:1, 10-02:2, 10-05:7, 10-07:1, 10-08:1, 10-09:4, 10-11:16, 10-12:1, 10-13:1, 10-15:7, 10-16:1, 10-17:11, 10-18:1, 10-19:6, 10-20:13, 10-21:2, 10-22:3, 10-23:4, 10-24:3, 10-25:4, 10-26:1, 10-28:11, 10-29:15, 10-30:15, 10-31:1`

### 4.2 四维增量系数（可解释，不是为凑数调的）

每段一次 `applyEvent`，四维增量固定为：

```js
{ familiarity: 0.006, trust: 0.004, intimacy: 0.003, rapport: 0.005 }
```

依据：`MAX_STEP_DELTA = 0.08` 是「一次强互动」的上限，一次普通对话按它的 1/13 ~ 1/27 计；四维大小关系反映语义——**熟悉 > 好感 > 信任 > 亲密**（说私事最少发生）。141 段合计 ≈ 熟悉 +0.846 / 信任 +0.564 / 亲密 +0.423 / 好感 +0.705。

### 4.3 写入：走门面，不直接 INSERT

```
node tools/import-relationship-events.mjs --apply
```

一律 `brain.persona.relationships.applyEvent()`：单次幅度夹取、10 分钟同 kind 冷却窗口、审计事件行、`relationship_states` 版本自增，全部由门面负责。每段写入内容：

- `kind = 'conversation_user_message'`
- `idempotencyKey = 'session-import:<会话目录>:<段起点毫秒>'`（天然唯一，重复跑只会 duplicate）
- `evidenceRef = 'session:<会话目录>'`（指回真实会话文件）
- `notes = '真实会话互动：本段 N 条主人消息、约 M 字'`
- `at = 段起点 epoch ms`（补记历史，`at_local` 按发生时刻算，不按写库时刻）

**结果**：

| 项 | 写前 | 写后 |
|---|---|---|
| `relationship_events` | 0 | **141** |
| familiarity | 0.100 | **0.946** |
| trust | 0.100 | **0.664** |
| intimacy | 0.100 | **0.523** |
| rapport | 0.100 | **0.805** |
| 新增 / 跳过 | — | 新增 141、duplicate 0、无增量 0、被夹取 0 |
| 事件时间范围 | — | 2026-08-14 14:26:23 → 2026-10-31 00:27:15 |

**幂等复跑**：`新增 0、已存在跳过 141、无增量 0`，四维与事件数完全不变。

四维没有顶到 1.0，也没有停在 0.1：熟悉 0.946 / 好感 0.805 / 信任 0.664 / 亲密 0.523，符合「141 次真实互动、熟悉比亲密长得快」的语义。

工具：`tools/import-relationship-events.mjs`（新增，默认 dry-run，加 `--apply` 才写）。

---

## 5. 验证

### 5.1 API（`http://127.0.0.1:3080/dsh-brain/api/persona`，2026-10-30T16:39:01Z）

| 验证项 | 要求 | 实测 | |
|---|---|---|---|
| `profiles` | 有行 | 1 行（小狐狸 / `agents_md` / status=active） | ✓ |
| `activeVersion` | 非空 | `pver_8f99e7bdac23dfe641bd5a6f` v1 active，含完整五层 layers | ✓ |
| `versions` | 有行 | 1 行（v1 active） | ✓ |
| `relationship` 四维 | 有变化 | 0.946 / 0.664 / 0.523 / 0.805（原 0.1 / 0.1 / 0.1 / 0.1） | ✓ |
| `social.skipped` schedule | 不再 `insufficient_history` | 变成 `already_interacted_today（今天已经聊过，不重复打招呼）` | ✓ |

> `already_interacted_today` 是**正确结果**，不是新故障：最后一段真实互动就在今天 00:27，作息已能估出来（`rows.length >= 5` 已满足），只是「今天聊过了所以不重复打招呼」——这正是防打扰逻辑该有的行为。

### 5.2 页面

`GET /dsh-brain/persona` → **200**，33,585 字节，HTML 内含「小狐狸」。

### 5.3 表行数（改后实测，`integrity_check=ok`）

| 表 | 改前 | 改后 | 说明 |
|---|---|---|---|
| `memories` | 226 | **226** | 未动（纪律：不写 memories） |
| `person_models` | 1 | 1 | A 步幂等 |
| `persona_profiles` | 0 | **1** | B 步 |
| `persona_versions` | 0 | **1**（active） | B 步 |
| `persona_conflicts` | 0 | 0 | 未产生冲突 |
| `relationship_states` | 1 | 1 | 4 维值更新 |
| `relationship_events` | 0 | **141** | C 步 |
| `proactive_policies` | 1 | 1 | A 步幂等 |

### 5.4 测试

```
node --test "tests/**/*.test.mjs"
→ tests 989 / pass 989 / fail 0 / cancelled 0 / skipped 0  (341s)
```

---

## 6. 边界与未做的事（如实）

1. **只补了关系事件，没补其它社交来源**。`shared_memory` / `verification` / `curiosity` 仍是 `not_implemented`（代码里本就没实现），`unfinished_care` / `commitment` / `discovery` 仍是 `no_*_evidence`（近 14 天确实没有对应证据）。这些不在 task-8 范围，也不能靠补数据伪造。
2. **关系事件的 `kind` 是本次自定义的 `conversation_user_message`**，不是系统原有的 kind 枚举。检查过 `social.js` 的 schedule 只读 `at_ms` / `at_local` / `kind` 做时间分布，不依赖具体 kind 值，所以安全。
3. **会话文件在持续增长**。本次扫描时 48,412 帧，复跑时 48,417 帧（当前会话还在写）。新会话不会自动进库——要更新需再跑一次 `node tools/import-relationship-events.mjs --apply`（幂等，只会补新增段）。
4. **互动段只覆盖 `--E-ds-h--` 这一个项目目录的会话**（按任务书指定）。别的项目目录的会话没有计入。
5. **`八之二` / `八之三` 两个章节未进人格分层**（`ignoredSections`），因为标题没命中任何角色关键词。这是解析器的诚实行为，没硬塞。
6. **node 版本与任务书不一致**（实际 v24.19.0 vs 写的 v22.22.2），不影响任何结果，仅记录。

---

## 7. 新增/变更文件

| 文件 | 类型 | 作用 |
|---|---|---|
| `tools/backup-manual-persona.mjs` | 新增 | 在线 `backup()` + integrity/行数校验的手动备份 |
| `tools/import-persona-fox.mjs` | 新增 | 解析 `~/.dsh/AGENTS.md` → 人格档案 + 首版，并激活（默认 dry-run） |
| `tools/import-relationship-events.mjs` | 新增 | 多帧 zstd 会话扫描 → 真实互动段 → `applyEvent`（默认 dry-run） |
| `docs/audit/fix-人格与关系数据.md` | 新增 | 本报告 |

**没有改任何源码**（`packages/` 零改动），没有动 `memories` 表，没有动 `~/.dsh/AGENTS.md` 原文件。

---

## 8. 回滚

```powershell
# 停服务后（或在服务停的时候）用备份覆盖回写
Copy-Item "E:\ds-h\dsh-brain\data\backups\manual-before-persona-data-20261031-003706.db" "E:\ds-h\dsh-brain\data\brain.db" -Force
Remove-Item "E:\ds-h\dsh-brain\data\brain.db-wal","E:\ds-h\dsh-brain\data\brain.db-shm" -Force -ErrorAction SilentlyContinue
```

备份覆盖点：B、C 两步**全部**写入之前。回滚后 `persona_profile`/`persona_version`/141 条关系事件都会消失，`memories` 不受影响。
