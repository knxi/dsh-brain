# DSH 外置大脑 · 交接文档

> 2026-10-29 建 · 2026-10-30 更新 · 负责人：小狐狸
> 交付状态：**M0–M6 + M4.6 + M6.1 + M6.1b + M6.2 + M7 + M7.2 + M7.3 已完成**
> （explicit 模式 + 使用统计 + 实体与关系 + usedLater 观测 + 实体 kind 修正 + 记忆去重合并 +
> 跨 scope 直读收口 + 统计口径对齐 + 列表分页 / 矛盾核验动作 / 治理内嵌代理 / 结论补录 +
> 情感状态并入主账 + 七页统一导航）
> **2026-10-30 的改动要重启 dsh web 才全部生效**（ESM 模块缓存；插件也是宿主一次性加载）。
> 代码根：`<repo>` · 依据：《DSH外置大脑-可执行设计方案-v1.2》

---

## 0. 一句话说清这是什么

给 DSH 加一个**跨会话的长期记忆层**：存得下、找得准、装得少、接得上、改得掉、删得净、恢复得了。

**它不是给模型加窗口**，是让模型不再依赖完整历史输入。有效上下文扩展 ≠ 上下文窗口扩展。

---

## 1. 现在能跑什么（先看这个）

| 入口 | 地址 | 说明 |
|---|---|---|
| 心海（3D 记忆海） | `http://127.0.0.1:3080/dsh-brain/sea` | 四种地图模式 + 筛选 + 点星聚焦 |
| 列表视图 | `http://127.0.0.1:3080/dsh-brain` | 搜索、来源、版本、有效期；首屏带「近 7 天检索 N 次 / 命中率」 |
| **使用情况** | `http://127.0.0.1:3080/dsh-brain/usage` | **检索留痕的聚合视图**：命中率、零命中榜、覆盖率、最近流水 |
| **矛盾核验** | `http://127.0.0.1:3080/dsh-brain/conflicts` | **6 条冲突并排看全文**：两端原文、实体、时间、可复制 ID（只读，不替你判） |
| **实体** | `http://127.0.0.1:3080/dsh-brain/entities` | **117 个实体按类型分组**：筛、搜、只看孤儿、点开看名下记忆（只读，不改类型） |
| 设置页 | DSH 设置 → 「外置大脑」 | 一个按钮直接打开控制台 |
| 治理面板 | `node apps/server/index.mjs` → `127.0.0.1:7420` | 删除四层 / 备份中心 / 隔离横幅（**要单独起**） |

模型侧三个工具：`brain_search` 查 / `brain_remember` 记 / `brain_forget` 忘。

**当前数据**：217 条记忆、217 条来源引用、422 条关联、4 个类型簇。
217 条里 205 条是从 Engram 迁来的，12 条是手工记的。

**M6 迁入（2026-10-29）**：117 个实体（tool 41 / concept 28 / other 25 / project 18 / person 5）、
178 条记忆↔实体关联（覆盖 94 条记忆）、**6 条矛盾边**（全是 Engram 里本来就有的 `contradicts`）。
另有 13 个实体是孤儿——Engram 侧挂的 node 没被导入，没有 id 可对（详见 CONTRACTS 13.3）。

### 重启让改动生效

```powershell
Ctrl+C
dsh web --port 3080 --no-open
```

> **host 插件改代码必须重启**。cordis 能热加载 patch 配置变化，但已 import 的 ESM 模块有缓存。
> 判断有没有重启：看 node 进程的 StartTime，别靠猜。

---

## 2. 架构

```
DSH（宿主 0.2.1-rc.3）
   │
   ├─ session/event ────────────┐
   ├─ system-prompt/assemble ───┤
   ├─ agent/pre-step ───────────┤   （connector 已实现，生产未启用）
   ├─ llm/stream（sent 判据）───┤
   │                            ▼
   │                    apps/connector   自动注入（automatic，未开）
   │
   └─ 工具调用 ──────────► apps/brain-tools   显式工具（生产在跑）
                                │
                                ▼
                        packages/memory      单 SQLite 主账
                       /     |      \
              packages/core  packages/search  migrations/
```

### 关键文件地图

| 路径 | 作用 | 状态 |
|---|---|---|
| `docs/CONTRACTS.md` | **全队契约**，含 M0/M1/M4.5/M6 实测约束（40+ 条） | 权威 |
| `docs/M0-probe-report.md` | 接入探针：六问 4 answered / 2 partial | 已完成 |
| `docs/M1-notes.md` / `m2-notes.md` | 各阶段实现记录与坑 | 已完成 |
| `docs/MIGRATION.md` | 从 Engram 迁移的方法与判断依据 | 已完成 |
| `docs/ROADMAP.md` | 下一步优先级与明确不做的事 | 持续更新 |
| `docs/M2-INTERFACES.md` / `M3-INTERFACES.md` | 各阶段并行开发契约 | 已完成 |
| `apps/brain-tools/index.js` | 三个工具 + 控制台路由 + 检索埋点 + 实体检索 | **生产在跑** |
| `apps/brain-tools/sea-page.js` | 心海页面（Canvas 2D） | **生产在跑** |
| `apps/brain-tools/console-page.js` | 列表页（含实体计数与冲突红条） | **生产在跑** |
| `apps/brain-tools/conflicts-page.js` | **M6**：矛盾核验页（两端并排看全文，只读不判定） | **生产在跑** |
| `apps/brain-tools/entities-page.js` | **M6**：实体总览页（按类型分组、孤儿、名下记忆） | **生产在跑** |
| `apps/brain-tools/usage-log.js` | **使用统计**：JSONL 追加/解析/聚合/覆盖率 | **M4.5 新增** |
| `apps/brain-tools/usage-page.js` | 使用情况页 | **M4.5 新增** |
| `apps/brain-tools/used-later.js` | **M4.6**：`turn/end` 判据（连续 ≥12 字原文才记 `usedLater:true`）、有界内存缓存、sidecar 落盘/读取/聚合 | **M4.6 新增，重启后生效** |
| `apps/brain-tools/conflict-log.js` | **M7**：矛盾核验动作的审计流水（append-only JSONL，不记正文，写失败不抛） | **M7 新增** |
| `apps/brain-tools/governance-page.js` | **M7**：`/dsh-brain/governance` 的只读**降级页**（治理服务起不来时才显示；正常走 7420 代理） | **M7 新增，M7.3 接入统一导航** |
| `migrations/0007_m7_fox_mood.sql` | **M7.2**：`fox_state`（单行快照，`CHECK id=1`）+ `fox_events`（事件流水，`at DESC` 索引） | **已应用（0007）** |
| `packages/memory/src/mood.js` | **M7.2**：情感门面（`getState/saveState/appendEvent/listEvents/pruneEvents/stats`；**不进检索、不做 scope 过滤**） | **生产在跑（门面可用）** |
| `plugins/dsh-fox-mood/brain-bridge.js` | **M7.2**：插件↔主账桥（先写 state.json 再写主账；启动按 `updatedAt` 合并、事件取并集） | **M7.2 新增，重启插件生效** |
| `tools/import-fox-mood.mjs` | **M7.2**：把 state.json 历史迁进主账（默认 dry-run、`(at,kind)` 幂等、`--state/--brain` 可覆盖） | **已 apply 57 条** |
| `apps/brain-tools/nav.js` | **M7.3**：七页统一导航（顺序唯一真相 + 当前页高亮 + 心海深色变体） | **M7.3 新增** |
| `apps/brain-tools/mood-page.js` | **M7.3**：`/dsh-brain/mood` 心情页（三格数字 + 定性词 + 事件时间线） | **M7.3 新增** |
| `tools/seed-project-facts.mjs` | **M7**：补录「文档里有、库里没有」的结论（默认 dry-run、按 content 幂等、`sourceType=observation`） | **M7 新增，已 apply 8 条** |
| `tools/fix-entity-kinds.mjs` | **M6.1**：实体 kind 修正（默认 dry-run 只读；`--apply` 才写） | **2026-10-30 已 apply（4 条）** |
| `tools/merge-duplicates.mjs` | **M6.1b**：同义重复记忆合并（走 `supersedes`；默认 dry-run，`--apply` 打印回滚 SQL） | **2026-10-30 已 apply（5 对）** |
| `docs/MERGE-ROLLBACK-20261030.sql` | **M6.1b**：那次合并的回滚 SQL（复位 status/valid_until/supersedes + 重建 4 条边） | **留档** |
| `packages/memory/src/entities.js` | **M6**：实体 + 记忆关系两个门面 | **生产在跑** |
| `migrations/0006_m6_entities.sql` | **M6**：entities / memory_entities / memory_edges | **已应用（0006）** |
| `tools/import-engram-entities.mjs` | **M6**：从 Engram 迁实体/关联/冲突边 | **已跑过（幂等）** |
| `tools/verify-routes.mjs` | 控制台路由 + M6 实体接口验收（起真 server） | M4.5 新增，M6 扩充 |
| `tools/verify-pages.mjs` | **页面运行时冒烟**：DOM stub + mock fetch 真跑五个页面的内联脚本 | M6 新增 |
| `tools/verify-usage.mjs` | 使用统计真库只读报告 | M4.5 新增 |
| `tests/eval/` | **§22.3 可回归测试集**：120 用例 / 7 类 / 五项门槛（合成语料） | **新增** |
| `tools/run-eval.mjs` | 生成 §22.3 评测报告 → `docs/EVAL-REPORT.md` | **新增** |
| `tools/run-scale-eval.mjs` | **§18.1 长上下文规模评测**（十万字，1445 条）→ `docs/SCALE-REPORT.md` | **新增** |
| `docs/MVP-ACCEPTANCE-GAP.md` / `MVP-HARDENING-GAP.md` | 对照设计文档的缺口审计（§22.3 / §22.4 / §18） | **新增** |
| `apps/connector/` | 自动注入连接器 | 已实现未启用 |
| `apps/server/` + `apps/console/` | 治理面板（独立端口 7420） | 可用 |
| `packages/memory/` | 主账：事件、事务、outbox、删除、备份、恢复 | 72+103 测试 |
| `packages/search/` | 中文检索（char-space + trigram + ngram + RRF） | 29 测试 |
| `packages/context/` | 构包、预算、built/attached/sent | 66 测试 |
| `tools/` | 普查 / 导入 / 验收 / 预览脚本 | 可用 |

---

## 3. 实测事实清单（最值钱的部分）

> 这些全是**实机跑出来**的，不是文档推测。照文档写会踩空的地方都在这里。

### 3.1 宿主装配与时序

1. **`assemble` / `pre-step` 是每 step 一次，不是每轮一次**。两步回合 = 2 次装配。构包与写入必须按 `(session, turn, step)` 幂等。
2. **重试不重跑 waterfall**。同一 step 内 `continue`，只重跑 `refreshContext`（仅刷新 runtime-context 文本）。
3. **首步 `assemble` 早于 `user/message` commit**。所以 `contexts` 通道首步拿不到 query，想到首步就注入只能走 `inject-channel: pre-step`。
4. **`agent` 是运行时字段，类型声明里没有**。`agent.session.id` 是拿 sessionId 的唯一途径。
5. **`agent.phase.step` 在 assemble 阶段是上一个 step**（当前 = +1）。
6. **`assembly.contexts` 的文本会被 `{{var}}` 插值，未注册变量直接抛**。注入必须 `interpolate: false`。
7. **`llm/stream` 的 `next()` 返回 `AsyncIterable` 不是 Promise**。`await next()` 会毁掉流。
8. **非 required 的 contexts 在 runtime-context 被抑制时会被静默剔除**，不报错。
9. **宿主对多个注入方的块全收、不仲裁**。唯一注入责任方必须自己指定。
10. **请求计数必须按 `purpose` 剔除 `session-title` 旁路**，否则注入次数会算错。

### 3.2 sent 的证据边界

11. **system prompt 有两种承载**：主请求在 `messages[role=system]`（此时 `options.system` 是空的），标题旁路在 `request.system`。**只看一个会漏判 sent**。
12. **Brain 自己的注入通道物化成 `messages[user]`**。所以 carrier 词表是三项：`system` / `messages[role=system]` / `messages[user]`。记错位置就是造假。
13. `sent` 只证明「宿主决定发这些内容」，**不证明字节出网**。`proves_wire_delivery` 恒 false。

### 3.3 隔离与闭环

14. **独立 profile ≠ 数据隔离**。`dsh-base` 默认所有 profile 共享 `$DSH_HOME/sessions` 和 `storages`。隔离验收必须写成**路径断言**。
15. **注入会形成闭环**：实测抓到「探针注入的标记被灵枢摄入成记忆节点 → 跨会话自动召回 → 再次进最终请求」。所以注入必须带 `origin_system`，摄取侧按来源剔除。

### 3.4 SQLite（node:sqlite）

16. **布尔不能绑定**。`stmt.run(..., true)` 抛 TypeError。布尔列一律 INTEGER 0/1。
17. **磁盘满时 SQLite 会自动回滚整个事务**，错误抛出时 `db.isTransaction === false`。再 `ROLLBACK` 会抛 "no transaction is active"，把真正的 SQLITE_FULL 顶掉。回滚必须走 `safeRollback()`。
18. **`busy_timeout` 默认是 0**，一撞写锁立刻 SQLITE_BUSY。必须显式设成 5000。
19. **`backup(db, path)` 会覆盖已存在文件**。要「失败不覆盖上一份」必须 tmp → 校验 → rename。
20. **`UPDATE/DELETE ... LIMIT` 在标准构建不可用**。认领类操作一律 `SELECT ids` + `WHERE id IN (...)`。

### 3.5 中文检索

21. **FTS5 不接受「括号组后直接跟 phrase」的隐式 AND**。`("展" OR "板") "尺"` 直接抛语法错，必须写显式 `AND`。触发条件隐蔽：多段查询里前段 > 4 token 走 OR、后面还有段就炸。
22. 这个错误会让**主路整条降级成 ngram 弱路**（P@10 49.9% vs 83.6%），**而 status 可能仍是 ok**——最危险的静默降级。
23. **默认 `unicode61` 会把整句中文当一个 token**。纯默认分词 hit@10 只有 50%。
24. 落地路线：**char-space 检索副本主路 + trigram 补充 + ngram 只做诊断 + LIKE 最后兜底 + RRF 融合** → hit@10 100% / P@10 83.6% / MRR 0.981。
25. **用户输入不能直进 MATCH**。`建施-03`、`JS-2026-017`、`1.2m`、`build:web` 四种都抛异常，必须转双引号 phrase。
26. **trigram 两字以下静默 0 命中**，不报错不抛异常。任何「没异常就算成功」的健康检查都会漏。

### 3.6 迁移

27. **灵枢的节点是对话原文不是记忆**。33 个节点全是 `layer=contextual` / `role=user`，证据数 0。它的价值在自动注入机制，不在数据。**所以没迁**。
28. **Engram 才是真记忆库**：`nodes` 存提炼过的记忆，`facts` 是实体事实链（带 valid_at / invalid_at / replaced_by）。
29. **迁移前必须做凭据脱敏**。源库里存在明文凭据类记录（本次命中 4 条，已处理）。Engram 自己也做了脱敏，但我们这道是第二重保险。
30. **迁移会丢 createdAt**。`memories.create` 不由外部指定创建时间，所以 205 条迁入记录的 `createdAt` 全是导入那一刻。**原始时间要存进 `validFrom`**，时间轴读它。

### 3.7 插件工程

31. **模板字符串里不能有裸反引号**。`sea-page.js` 是一整个大模板，我在注释里写了个反引号，直接把字符串截断，页面编译失败。
    **2026-10-29 在 `conflicts-page.js` 又踩了一次**——而且是在「解释这个坑」的注释里写了一个反引号。
    后果：文件语法错 → `brain-tools` 插件加载失败 → `/dsh-brain` 下所有路由 404（连 `/api/stats` 都没了）。
    要提它的时候写「反引号」三个字，**别写那个字符本身**。
32. **并行改 `index.js` 要先建文件再引用**。先写 re-export 后建目标文件，会让所有下游瞬间加载失败。
33. **新增迁移必须同步改两处测试白名单**：`tests/contract/migrations.test.mjs` 的表清单、`tests/m2/memory/context-packages.test.mjs` 的版本列表。
34. **`memories.list()` 有分页上限（200）**。要看全量得直接查库（心海的 scene 接口就这么干的）。

### 3.8 使用统计（M4.5）

35. **`Number(null) === 0` 会让「没有数据」变成「数据是 0」**。`durationMs: null` 写盘、读回再规范化
    时变 0，被当成真实耗时混进 p50/p95——统计照样算得出数，数字是假的。所有数值字段必须走显式
    null 判定（`toNumber()`），**不能写 `Number.isFinite(Number(v))`**。同源的坑还有 `computeCoverage`
    的 importance：缺字段必须保持 null，不是 0 分重要度。
36. **失败检索混进零命中榜 = 把故障榜当语料缺口榜**。零命中 / 命中只统计 `ok !== false` 的记录，
    `hitRate` 分母用「跑完的检索数」，另给 `callHitRate` 作含失败的保守口径。
37. **控制台路由的 `req.url` 带 `/dsh-brain` 前缀**。`webServer.register({ kind: 'prefix' })` 之后
    handler 里 `pathname.slice(ROUTE.length)` 切错位**不会报错**：`/api/stats` 被切空会命中 `/` 分支，
    **返回列表页 HTML 且状态 200**——上层 JSON.parse 失败后表现为「接口没数据」，而不是 404。
38. **工具 `execute` 的第二参数能拿到 `agent.session.id`**（`ToolRunContext` 里有 `agent`，参数 schema 里
    没有 sessionId）。「这次检索属于哪个会话」只能从这儿取；拿不到就记 null，不许编。
39. **冒烟必须显式传 `usageLogPath`**。不传会走生产默认值，合成查询真的写进观察期日志——
    **比没有统计更糟**，它会让「检索准不准」的判断建立在假数据上。
40. **模板页的语法错不会在 Node 侧报**。反引号截断（3.7 第 31 条）和内联 JS 语法错都只在浏览器里
    白屏。挡法：提取 `<script>` 块，用 `new Function(src)` 只解析不执行。
41. **可以起第二个 `dsh web` 实例（`--port 3081`）做真机验证**，不打断正在跑的会话。启动要约 20 秒，
    **16 秒探测会误判「连不上」**；验证完立刻 kill。注意两个实例共享 `$DSH_HOME`（见第 14 条）。

---

### 3.9 实体与关系（M6）

> 完整约束见 `CONTRACTS.md` 第 13 节。这里只留最容易踩的四条。

42. **软删除挡不住 `ON DELETE CASCADE`**。本系统的删除是 `status='deleted'` + `deletion_epoch`，
    永远不会触发真 `DELETE`；三张新表上的级联**等于没写**，所有查询必须自己
    `JOIN memories ... WHERE status != 'deleted'`。
43. **实体必须合并、不能分裂**。Engram 的 123 条实体只有 **117 个唯一名**（6 个跨库同名），
    按「一次导入一行」落库会把同一个工具拆成 6 份，「按实体查」直接废掉。
44. **映射不上就跳过，不猜 id**。229 条 `node_entities` 有 **51 条没有对应 memory**
    （上游 `import-engram` 按内容长度/状态过滤掉了那些 node），跳过并计数。
    连带 **13 个实体是孤儿**——这是**已知**状态，不是 bug。
45. **迁移脚本会顺手升级 schema**。`--apply` 走 `openBrain()`，它会自动应用未执行的迁移
    （本次生产库 0005 → 0006）。报告里必须写明，否则接手人不知道库是什么时候变的。
    `dry-run` 必须用 `readOnly: true` 打开，确保预演零写入。

46. **Engram 标的「矛盾」多数是重复**。迁进来的 6 条 `contradicts` 里，**4 条**其实是同一件事的
    详略/角度差异（星海 UI、explicit 模式、项目根目录、当前工作目录那四对），只有 2 条是不同的事。
    这反倒佐证了「不自动选边 / 不自动合并」的价值：自动合并会把两条都抹掉，
    人就以为从没定过这回事。**6 条都该由人看一遍**（`/dsh-brain/conflicts` 就是为这个做的），
    这本来就是 M6 想达到的效果。

47. **心海的边是真实关系边，不是画着玩的近似连线**。`/api/scene` 原来返回「同簇内按时间相邻连」的
    `kind:'topic'` 边——画面是好看了，但它会冒充关系（两条只是同类型、时间相邻，线一画就像「有关系」）。
    现在 `edges` 只放 `memory_edges` 里的真实关系（带 `kind` / `reason` / `sourceSystem` / `createdAt` /
    两端摘要），`topic` 边降级到 `backgroundEdges`，页面上手动开「同簇相邻（背景）」才画。
    `memoryEdges` 不可用时（老库缺 0006）降级为空边 + `edgesDegraded`，**不让这一屏 500**。
    颜色口径与画布同源：**红虚线=矛盾（最粗，最该被看见）、赭实线=取代、灰细线=佐证/细化**。
    生产库现在只有 6 条 `contradicts`、0 条 `supersedes`，所以赭色和灰色在真机上还看不到——
    这两条代码路径靠 `tools/verify-pages.mjs` 的 fake 数据（四种 kind 各一条边）覆盖。
    注意 ESM 模块缓存：改完 `brain-tools` 要**重启 dsh web**（或另起一个实例）才看得到效果。

## 4. 当前限制（诚实清单）

| 限制 | 影响 | 为什么没做 |
|---|---|---|
| **只有 explicit，不会自动记** | 用户不说「记住」，它就不记 | 自动提取质量差会污染记忆库，**污染比没有更糟**。要先做小范围试跑 + 人工抽检 |
| **没开 automatic 注入** | 不会自动往对话里塞记忆 | 生产插件组合、真实语料都没验过。expicit 已够用 |
| **Engram 的 105 个实体、7 条关系边没迁** | 表达不了「这个实体说过什么」，也表达不了 `contradicts` 矛盾 | 我们的库还只有 `supersedes`，没有实体表和矛盾关系 |
| **治理面板要单独起进程** | 删除/备份/恢复要 `node apps/server/index.mjs` | 只做进了独立 console，没内嵌到 `/dsh-brain/governance` |
| **`backupExpiryAt` 口径不一致** | 门面给笼统时间，UI 按逐份算 | UI 的逐份算法更准，以它为准 |
| **M0 还有 2 个 partial** | 用户取消、sessionQuery cursor 分页没实测 | headless 一次性进程无交互取消入口；搜索在退出窗口里关了索引 |
| **「命中是否真被用上」只补了一半** | 现在能看出「回答里引用了命中记忆的原文」，看不出「用了但改写成自己的话」 | M4.6 的判据刻意保守：**assistant 最终文本里出现某条命中正文的连续 ≥12 字原文**才记 `true + evidence:'quote'`；其余一律 `null + usedLaterWhy`，**永不记 false**。所以引用率是**下界**，不是全量。语义层面「用上了但没引原话」判不了——那就如实说判不了 |
| **使用统计样本还很少** | 现在任何命中率 / 覆盖率都不代表长期表现 | 观察期刚开始（M4.5 才落地）。**样本 < 20 次不做判断** |
| **覆盖率不等于「没用」** | 迁入的 205 条大多只在特定语境才该被想起 | 页面只给事实和候选清单，不下「该删哪条」的结论——删记忆不可逆 |
| **51 条 Engram 关联没迁进来** | 13 个实体是孤儿，「关于 X 我们都定过什么」查不全 | 那些 node 没被导入、没有 `memory_id` 可对。**不编造 id**（CONTRACTS 13.3） |
| **矛盾只记录、不判定** | 6 条矛盾并列保留，得人来核验 | 自动选边等于替主人下结论。首页只出红条提示，不静默、不处理 |
| **实体不会自动抽取** | 只有迁来的 117 个 + 手工 upsert 的；新对话里提到的工具/项目不会自己变成实体 | 自动抽取与 M5 自动提取是同一类风险（污染记忆库），一起等观察期数据说话 |

### 还不能卸灵枢 / Engram

差两个硬条件：

1. **自动提取** —— 外置大脑不会自己记，卸了等于**停止记录新东西**。
2. **观察期** —— 205 条要实际用几轮，看检索准不准。搬过来 ≠ 用得好。

卸载顺序建议：并行跑 → 观察一周 → 先关一个 → 再关另一个。**卸前必须完整备份**
（`E:\ds-h\tools\backup\backup-dsh.ps1`）。

---

## 5. 怎么验证

### 跑测试

```powershell
cd <repo>
node --test "tests/**/*.test.mjs"     # 全量：630 个（2026-10-30 实测 629 pass / 1 fail）
```

> **沙箱里跑不动的那个坑（2026-10-30 实测）**：在受限沙箱（如 DSH 的 workspace-write）里，
> `node --test` 默认会 fork 每个测试文件并捕获输出，而沙箱禁止子进程管道 →
> **整批 `spawn EPERM`，一个用例都跑不出来**。绕过：`node --test --test-isolation=none "tests/**/*.test.mjs"`
> （单进程 630 用例约 160s）。此时唯一会红的是 `tests/m3/backup/drill.test.mjs`——
> 它自己 `spawnSync` 真跑 `restore-drill.mjs`，同样被沙箱拒（`actual: null`）。
> **这是环境限制不是回归**：前台直接跑 `node packages/memory/src/restore-drill.mjs` 得 exit 0 / 24 项全过。
> 有 spawn 权限的终端里用原命令跑一次，应 630/630。

| 套件 | 用例 |
|---|---|
| `tests/contract` | 72（M1 主账） |
| `tests/search` | 29（检索） |
| `tests/m2/memory` | 103 |
| `tests/m2/context` | 66 |
| `tests/m2/connector` | 82 |
| `tests/m2/server` | 66 |
| `tests/m3/deletion` | 33 |
| `tests/m3/backup` | 34 |
| `tests/m3/ui` | 55 |
| `tests/m4/usage` | 14（使用统计） |
| `tests/m6/entities` | 20（实体与关系） |

### 真机验证

```powershell
node packages/memory/src/restore-drill.mjs   # 真实恢复演练：真删/真备/真恢复，24 项
```

结论原文：**删了的东西恢复后仍然没有**；三条隔离路径（账本缺失/损坏/陈旧）均 `promoted=false`。

### 工具层与控制台（M4.5 新增，都用临时库）

```powershell
node apps/brain-tools/smoke.mjs   # 三个工具真跑一遍 → 30 项（含使用统计留痕 + usedLater 接线）
node tools/verify-routes.mjs      # 起真 server、发真请求，验控制台路由与 API 字段 → 67 项（含 usedLater 口径）
node tools/verify-usage.mjs       # 使用统计真库只读报告：就绪/命中率/覆盖率/引用率（§4），可日常跑
node tools/verify-pages.mjs       # 页面运行时冒烟：五个页面的内联脚本真跑一遍 → 44 项
node tools/fix-entity-kinds.mjs   # **M6.1** 实体 kind 修正预演（默认只读）；加 --apply 才真写
node tools/run-eval.mjs           # §22.3 质量评测：120 用例五项门槛 → docs/EVAL-REPORT.md
node tools/run-scale-eval.mjs     # §18.1 规模评测：1445 条 / 11.6 万字 → docs/SCALE-REPORT.md
```

`verify-pages.mjs` 是 2026-10-29 之后加的，专挡「语法通过但跑不起来」——`new Function(src)` 只验解析，
挡不住 ASI（`)` 结尾的行紧跟 `(` 开头的行会被解析成连续调用），也挡不住模板串被反引号截断。
它用最小 DOM stub 把脚本执行到底，缺哪个浏览器 API 就直接红，不静默跳过。

`verify-routes.mjs` 是专为「字段名对不上但页面不报错」这类静默错位写的——渲染单测和工具冒烟都盖不到。

### 数据迁移

```powershell
node tools/survey-memory-sources.mjs         # 普查两个外部源（只读）
node tools/import-engram.mjs                 # 预演
node tools/import-engram.mjs --apply         # 真写（自动去重 + 凭据脱敏）
node tools/verify-import.mjs                 # 验收：总量/类型/凭据残留/检索
```

### 心愿海

```powershell
node tools/preview-sea.mjs 7430              # 临时预览（不碰宿主）
node tools/verify-sea.mjs                    # 页面结构 + scene 接口字段
```

`?debug` 打开 `window.__sea` 调试钩子（生产不留）。

---

## 6. 怎么回滚

### 关掉外置大脑（保留代码和数据）

编辑 `C:\Users\<you>\.dsh\profiles\web\cordis.patch.yml`，注释掉末尾那段：

```yaml
- insert:
    - id: brain-tools
      name: '@dsh-brain/brain-tools'
      ...
```

然后重启。

### 恢复接入前的配置

```powershell
# 备份在：C:\Users\<you>\.dsh\profiles\web\_pre-m4-20261028-205035\
Copy-Item "_pre-m4-20261028-205035\package.json" "C:\Users\<you>\.dsh\profiles\web\package.json" -Force
Copy-Item "_pre-m4-20261028-205035\cordis.patch.yml" "C:\Users\<you>\.dsh\profiles\web\cordis.patch.yml" -Force
```

### 数据

| 项 | 位置 |
|---|---|
| 记忆库 | `data/brain.db` |
| 导前备份 | `data/brain.db.pre-engram-import-20261029-011559` |
| 一致性快照 | `data/backups/bkp_c123a465aa8a45ad141e6690.db`（3.4 MB，校验通过） |
| 删除账本 | `data/deletion-ledger/`（**活跃库之外**，不能丢） |

### 红线（本次全程未违反，改的时候别破坏）

- 没改 `@deepseek-ai/dsh` 包文件
- 没动生产 profile 之外的配置
- 没迁移/改写 Engram、灵枢的现有记忆库
- 凭据没进记忆正文、没进日志、没进 URL

---

## 7. 下一步

### 7.0 进度快照（2026-10-30 19:50，主人验收后写入）

**一句话**：规化里 14 个阶段全部完成，代码无欠账；但「卸灵枢/Engram」还差最关键的一块——**自动提取（M5）**。
主人已明确「之前的那些都可以开工了」，所以 M5 从本轮开始动工。

| 阶段 | 状态 |
|---|---|
| M0 探针 / M1 主账 / M2 检索 / M3 治理恢复 / M4 接生产 | ✅ |
| M4.5 使用统计 / M4.6 usedLater / M6 实体关系 | ✅ |
| M6.1 kind 修正 / M6.1b 去重合并 / M6.2 跨 scope 收口 | ✅ |
| M7 分页·矛盾动作·治理内嵌 / M7.2 情感并入 / M7.3 统一导航 | ✅ 代码完成 |
| **M5 自动提取** | ✅ **Phase 1 完成（规则型，2026-10-30 夜）**——23/23 单测 + 四回合全链路真跑（只有明确指令被提取） |

**数据现状**（2026-10-30 19:50 实测）：

| 项 | 值 |
|---|---|
| 记忆 | 218 active / 7 封口 / 1 删除 |
| 类型 | semantic 172 / skill 18 / profile 16 / episode 12 |
| 来源 | 迁入 198 / `owner_words` 12 / **`observation` 8** |
| 实体 | 117（`person` 只剩 `小狐狸`）、**197 关联**、**10 个孤儿** |
| 关系边 | **0 条**（主人已在矛盾页处理完最后 2 条） |
| 情感 | `fox_state` 1 行 + `fox_events` **58 条**（已并入主账） |
| 库 | schema **0007**，`quickCheck: ok` |

**观察期数据**（7 天窗口，`node tools/verify-usage.mjs`）：

```
检索 11 次（成功 11 / 失败 0）｜命中率 100%｜弱路降级 1 次（9.1%）
覆盖率 35/218 = 16.1%｜引用率 13.0%（3/23）
```

按纪律**样本仍低于 20 次门槛**，不能下「检索准不准」的结论。引用率第一次有数了（M4.6 真机跑通）。

**剩余缺口（按优先级）**：

1. ~~**M5 自动提取**~~ ✅ **Phase 1 完成（2026-10-30 夜）**：规则型，四道闸 + 四条规则，配额硬限（每轮 1 / 每会话每天 5 / 全局每天 20），`sourceType=observation` + summary 标「（自动提取）」，随时可关，失败静默。契约见 `CONTRACTS.md` §20。**Phase 2（模型语义提取）等观察期数据，且必须先有配额与抽检。**
2. ~~**15 个孤儿实体**~~ ✅ **已处理（2026-10-30 夜）**：`tools/link-orphan-entities.mjs` 建了 19 条硬证据关联，孤儿 15 → 10（剩下的是 `backup.js`/`toNumber` 这类代码符号，本来就没有记忆）。
3. ~~**弱路降级那 1 次**~~ ✅ **已查清（2026-10-30 夜）**：那次是 10:10 查「心海 记忆海 定义 页面名字」时主路没命中（`primaryLaneHit=false`）——**当时心海定义还没补录**，不是 bug。补录后再查同一句，前 4 条全是 `observation` 的心海事实，且都挂上了「实体 心海」。这次抽查印证了一件事：`insufficient_evidence` 这个状态是诚实的，它说的就是「语料里真没有」。
4. `/dsh-brain/governance` 的 **302 跳转**还没生效（当前进程是在那处改动之前重启的），下次重启后收尾。

**还能不能卸灵枢 / Engram**：**还不能**。两个硬条件里：①自动提取 ❌（本轮开始补），②观察期 ⚠️（11/20 次）。
卸载顺序不变：并行跑 → 观察一周 → 先关一个 → 再关另一个；卸前必须完整备份。

---

按优先级（详见 `docs/ROADMAP.md`）：

1. ~~**使用统计**~~ ✅ **已完成（M4.5）** —— `/dsh-brain/usage` 页面 + `data/logs/usage.jsonl` + 三个验收脚本。
2. ~~**实体表 + 矛盾关系**~~ ✅ **已完成（M6）** —— `migrations/0006` + `packages/memory/src/entities.js`
   + `tools/import-engram-entities.mjs`；117 实体 / 178 关联 / 6 条矛盾已入生产库。
3. ~~**usedLater 观测（M4.6）**~~ ✅ **已完成（2026-10-30 凌晨）** —— `ctx.on('session/event')` + `turn/end` 判定
   + `data/logs/used-later.jsonl` sidecar + `/api/usage` 口径 + 使用情况页一格 + `tools/verify-usage.mjs` §4。
   判据只认**连续 ≥12 字原文**，`usedLater` 只有 `true`/`null`。**重启 dsh web 后开始出数。**
4. ~~**实体 kind 修正（M6.1）**~~ ✅ **已完成并执行（2026-10-30）** —— `updateKind` 门面 + `tools/fix-entity-kinds.mjs`；
   4 条 teammate 代号 → `other` 已 apply，`person` 只剩 `小狐狸`，审计 +4，关联未动。
5. ~~**记忆去重合并（M6.1b）**~~ ✅ **已完成并执行（2026-10-30）** —— `tools/merge-duplicates.mjs` 合并 5 对
   （`active` 217→212、`contradicts` 6→2、`valid_until` 0→5），正文零删除，回滚 SQL 留档。
   连带把三处统计口径改到 `status='active'`（否则覆盖率与「从没被查到」榜会被封口条目污染）。
6. ~~**跨 scope 直读收口（M6.2）**~~ ✅ **已完成（2026-10-30）** —— **注意：`MVP-HARDENING-GAP` §A4 已过时**，
   它点名的 4 条早收口了；真洞在实体 / 边 / 构包 / 来源，补了 10 个入口 + 12 项双 scope 测试。
   口径与「刻意不改」的边界见 `CONTRACTS.md` §16。
7. **观察期（现在轮到它）** —— 正常用几轮，让数据自己说话。**样本 < 20 次不做判断**。
   看点：零命中榜里有没有「明明该有的东西」（那才是索引或语料真缺口）、覆盖率里重要度高却从没被查到的、
   以及**引用率**（M4.6 新增的第四个数）。
   6 条矛盾已核验并处理完（4 条合并 / 2 条保留），过程在 `docs/OBSERVATION-2026-10-29.md`。
8. **自动提取（M5）** —— 卸灵枢的真正前提。**风险高**：要跑在 `turn/end` 之后（M4.6 已经把钩子和「判定只在
   内存缓存里做、不动索引」的模式立起来了，可以复用）、只提取稳定信息、不主观推断、带配额和开关、失败静默。
   **必须用 M4.5 的统计 + M4.6 的引用率去量它有没有把检索质量拉低。**
   → 顺带把「实体自动抽取」并进来做（同一个钩子、同一类风险）。
9. **治理面板内嵌** —— 挂到 `/dsh-brain/governance`，一个端口全搞定。纯体验优化。
10. ~~**补录「文档里有、库里没有」的结论性事实**~~ ✅ **已完成（2026-10-30，8 条）** ——
    `tools/seed-project-facts.mjs`（默认 dry-run、按 content 幂等）；`sourceType=observation` + `confidence=0.8`，
    每条带 `basis` 与 `document` 来源关联。设计血统三条 / 心海定义 / 设计母本 / 项目目标 / 观察期纪律 / 三条铁律。
    **现在查「群星设计血统」「卸载 Engram 的目标」都能命中第一条**（原来全是「证据不够」）。
11. **M7 三个可用性缺口** ✅ **已完成（2026-10-30）** —— 列表分页（`offset` + `total`）、
    矛盾核验动作（两步确认 + CSRF 头 + 审计流水）、治理只读内嵌（零写操作，7420 状态灯）。
    口径与安全边界见 `CONTRACTS.md` §18。**重启 dsh web 后才在真机生效。**

**明确不做**：自动注入开到 automatic、没新数据就调检索权重（实测 ngram 权重一进排序，P@10 从 83.6% 掉到 49.9%）、
观察期没跑够就上自动提取（会把「检索本来就不准」和「提取污染了库」两件事混在一起，事后分不清是哪个的锅）、
把 `usedLater` 记成 `false`（没引用原文 ≠ 没用上，那是猜不是观测——`usedLater` 只有 `true` / `null`）。

---

## 8. 三段设计血统

| 来源 | 许可 | 借了什么 |
|---|---|---|
| **3d-memory-sea** | MIT | 三维投影、斐波那契球面布簇、深度排序遮挡、Canvas 2D 渲染 |
| **Stellaris（群星）** | 仅交互模式 | 地图模式切换、左侧边栏、右侧上下文面板、顶部状态条、底部工具栏、hover 反馈 |
| **UI 动画设计指南**（skillsbot 11806） | 方法论 | 缓动、时序、重叠、`prefers-reduced-motion` |

原始的设计母本是《DSH外置大脑-可执行设计方案-v1.2》。

---

## 9. 留给接手人的四句话

1. **先看 `docs/CONTRACTS.md` 第 10、11、12 节**。那 28 条实测约束是这个项目最贵的东西，绕过去就会重新踩一遍。
2. **不信文档，信实验**。这项目里至少有 5 个地方，文档写的东西和实机行为对不上（hook 名、注入形态、隔离边界、FTS 语法、createdAt）。
3. **数据比代码重要**。改代码最多是功能坏掉，动 `data/brain.db` 或 `data/deletion-ledger/` 可能让已经删掉的东西复活。
4. **观测数据本身也会说谎**。`Number(null)===0`、失败检索混进零命中、路由前缀切错位——这三样**都不报错**，
   只是数字悄悄变错。看任何统计之前，先读它的口径。



