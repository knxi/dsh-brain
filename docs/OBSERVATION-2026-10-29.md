# 观察期体检报告 · 2026-10-29 夜

> 执行：小狐狸（Lead）· 数据全部来自只读查询与 `tools/verify-usage.mjs`，没有估算值。
> 这一轮的目的不是加功能，是**把观察期该看的东西看完，并补齐看不了的那部分**。

---

## 一句话结论

**管道是通的，但观察期几乎没数据（7 天内 1 次检索）；用「等样本」解释现状是借口，真实原因是它还没进入日常使用。**
本轮顺手用 3 个真实查询把样本从 1 打到 4，**第一次打出真信号：三个该有的概念在记忆库里根本不存在，而有一条事实存了三遍**（详见第七节）。
同时体检出 4 个可以现在就推进的确定项，本轮已动工 2 个（见文末）。

---

## 一、数据现状（2026-10-29 23:55）

| 项 | 实测 | 说明 |
|---|---|---|
| 有效记忆 | **217 条**（active 217 / deleted 1） | 205 条迁自 Engram（`source_type=summary`），12 条 `owner_words` |
| 类型分布 | semantic 169 / skill 19 / profile 16 / episode 13 | profile 16 条 = 主人画像 |
| 实体 | **117 个**（tool 41 / concept 28 / other 25 / project 18 / person 5） | 178 条记忆↔实体关联，覆盖 94 条记忆 |
| 关系边 | **6 条，全是 `contradicts`**；`supersedes` 0 / `supports` 0 / `refines` 0 | 心海的赭色、灰色两条代码路径在真机上仍看不到 |
| 孤儿实体 | **13 个**（挂 0 条活跃记忆） | 已知状态，非 bug（CONTRACTS 13.3） |
| 有效期字段 | `valid_until` 非空 = **0 条** | 没有任何一条记忆被「封口」过，时间轴只有起点没有终点 |
| 使用日志 | 7 天窗口内 **4 次**检索（1 次任务查询 + 3 次真实验证查询） | 都是本轮；样本仍远低于 20 |
| 覆盖率 | 10 / 217 = **4.6%** | 只查了一次，这个数字没有解释力，**不是问题指标** |
| 零命中 | 0 次 | 没有故障样本，也没有语料缺口样本 |

**口径提醒（写给未来的自己）**：覆盖 4.6% 看起来像「大量死数据」，其实只是样本 1 次的必然结果。
`样本 < 20 次不做判断` 这条纪律现在必须继续守着——否则会拿偶然当规律。

---

## 二、6 条 `contradicts` 逐条判定（人工核验，这是 ROADMAP 里的待办）

判定标准：**是不是同一件事的两种说法**。是 → 建议合并（`supersedes`，保留历史版本）；
不是 → **不动**，可以改边类型为 `refines`/`supports`，但绝不删。

| # | 边 ID | 两端（记忆 ID / 摘要） | 判定 | 建议动作 |
|---|---|---|---|---|
| 1 | `edge_b17a7af80f374b43a4091b15` | `mem_a40ce6fc…` = 10-25 装 dsh-meme 0.1.61 的踩坑（skill）<br>`mem_cb7c1b6f…` = 10-23 装抖音插件 1.4.3 的经历（episode） | **不是矛盾**：两次不同的安装、两套不同的坑（pnpm relink 卡死 vs GUI 安装任务丢失），互补 | 保留两条；边可改 `refines`（skill 是 episode 的抽象），或直接删边——**不合并** |
| 2 | `edge_3002d21de1a9404fe4a20f04` | `mem_8a4f77b5…` = 「当前工作目录为 E:\ds-h」<br>`mem_a72c5c6b…` = 「DSH 当前项目工作目录为 E:\ds-h」 | **同义重复**，后者信息量更少 | B 被 A 取代（`supersede(b, a)`），随后删这条边 |
| 3 | `edge_7846009f82419cca19918caf` | `mem_a05dbadc…` = M3 完成、540/540、演练 24/24（episode，结论）<br>`mem_9bdac602…` = M3 删除线的实现细节（semantic，账本/hash 链/五步 worker） | **不是矛盾**：一个是结论、一个是细节，粒度不同 | 保留；边改 `refines`（细节细化结论），**不合并**——合并会丢掉实现细节 |
| 4 | `edge_6889134e52bf41660e440f0f` | `mem_8ed105ff…` = 项目根目录 + 「本轮我担任 teammate search / task-3」<br>`mem_a2c8545e…` = 纯事实：项目根是 dsh-brain，工作目录 E:\ds-h | **同义重复**，前者多了一段**过期团队角色**（那轮早已结束） | A 被 B 取代（`supersede(a, b)`），随后删边。角色信息过期，留着会污染「项目根」这条事实的检索 |
| 5 | `edge_68862238bfa75aa1b02cb635` | `mem_ad3d9150…` = explicit 模式，只挂三个显式工具<br>`mem_b2ac1eb4…` = 同样的话 **+ 三个工具的名字** | **同义重复**，后者更完整（点名 brain_search / brain_remember / brain_forget） | A 被 B 取代（`supersede(a, b)`），随后删边 |
| 6 | `edge_818095056826a2de8b224f2a` | `mem_d15c64d5…` = 「前端星海页面」UI 改成 3d-memory-sea 效果<br>`mem_b624303a…` = 「外置大脑（dsh-brain）的前端 UI」改成 3d-memory-sea 星海效果 | **同义重复**，后者指明了是哪个产品的前端 | A 被 B 取代（`supersede(a, b)`），随后删边 |

**汇总：4 条同义重复（2/4/5/6）+ 2 条不是矛盾（1/3）** —— 与 HANDOVER 第 46 条的既有论断一致，
这一轮是**第一次逐条落到 ID 和动作**，不再是「大概有 4 条重复」。

**为什么没有直接执行合并**：`supersede` 会把旧条目封口（`status=superseded` + `valid_until`），
是不可逆的数据状态变更；CONTRACTS 13.2 的纪律是「不自动选边、不替主人下结论」。
清单已经细到「一条命令一对 ID」，主人点头即可批量执行。执行时必须**先备份**（`data/backups/`）。

---

## 三、117 个实体过一遍：质量结论

### 3.1 明确标错（4 个，建议改）

`kind='person'` 共 5 个，其中 4 个是 Engram 时代留下的 teammate 代号，不是人：

| 实体 | 现 kind | 实际是什么 | 建议 |
|---|---|---|---|
| `context2` | person | teammate 代号（M2 构包线） | → `other` |
| `connector2` | person | teammate 代号（M2 连接器） | → `other` |
| `console2` | person | teammate 代号（M2 控制台） | → `other` |
| `lead` | person | Team Lead 代号 | → `other` |
| `小狐狸` | person | **真 person，不许动** | 保持 |

**当前没有修正入口**：`entities` 门面没有 `updateKind`，而 `upsert` 有条刻意的「kind 不降级」规则，
person→other 走 upsert 改不动。这就是本轮 `task-2` 在补的能力（门面 + dry-run 工具，不擅自 apply）。

### 3.2 命名粒度问题（不修，但要说明白）

engram 抽取实体的粒度是「代码符号」，迁进来后有一批实体是文件名/函数名/接口路径：

- 文件名类：`backup.js`、`usage-log.js`、`verify-usage.mjs`、`packages/search/src/tokenize.mjs`
- 函数/接口类：`summarizeUsage`、`toNumber`、`store.contextPackages`、`GET /api/context/:contextId`
- 任务号类：`task-10`

它们不是错的实体，但语义价值低——「关于 backup.js 我们都定过什么」这种查询基本没人会问。
**不删**：删实体会连带摘掉 178 条关联里的一部分，「按实体查」反而更差；且删了不可逆。
等 M5 自动抽取上线时统一重定实体规范（那时才有「什么样的实体值得建」的实测依据）。

### 3.3 13 个孤儿（已知，不处理）

`dsh-client-ui-settings-plugin-inventory`、`packages/search/src/tokenize.mjs`、`task-10`、`backup.js`、
`群星`、`心海`、`skillsbot UI动画指南`、`summarizeUsage`、`usage-log.js`、`verify-usage.mjs`、
`brain.db`、`外置大脑项目`、`toNumber`。

原因：Engram 侧挂着的 node 当初没被导入，没有 `memory_id` 可对（CONTRACTS 13.3）。
其中 `群星`、`心海`、`外置大脑项目` 明显该有记忆——这是**语料缺口**的真候选，不是索引问题：
它们对应的记忆（设计血统、心海 UI、项目目标）应该以「实体→记忆」的方式存在，现在只有零散提及。
**这一条记进「零命中候选清单」**：等哪天查「群星」查不出东西，就是它。

---

## 四、观察期真正卡住的地方：不是数据不够，是它没被用

7 天 1 次检索。原因很直接：

1. `brain_search` 是 **explicit** 工具，模型只在「判断需要跨会话记忆」时才调。没有触发语就没有调用。
2. 没有注入（automatic 未开），也就没有「记忆自动出现在眼前」这条路。
3. 于是观察期被设计成「等它自然发生」——**它不会自然发生**。

**可执行的改法（不是加功能，是改用法）**：

- 每次会话碰到「之前」「上次」「你还记得」「继续推进」这类指向前史的话，**第一动作就是 `brain_search`**，哪怕猜它没记过；
- 每做完一件事，判断值不值得 `brain_remember`（决定、踩坑、口径），值得就记；
- 每隔几天跑一次 `node tools/verify-usage.mjs` 看四个数：命中率、零命中榜、弱路降级、覆盖率；
- 样本到 20 次再谈结论。**在那之前，任何「检索准不准」的评价都是噪声。**

---

## 五、体检中新发现的一个安全缺口（比实体更正更该排前面）

复核 `docs/MVP-HARDENING-GAP.md` 时确认，§22.4 第 4 类「跨 scope 不泄露」存在**实现缺口**：

> `memories.get(id)` / API `GET /api/memories/:id` / `summaries.get(id)` **全链路没有 scope 过滤，也没有测试**。

设计文档口径是「隐私隔离和权限测试通过率必须 100%；一次泄露即阻断发布」。
当前生产库只有 `owner-default` 一个 scope，所以**现在没有实际泄露路径**；但这是「单用户假设」撑着，
一旦多 profile / 多用户共用同一份 `$DSH_HOME`（CONTRACTS 3.1 第 14 条已实测「独立 profile ≠ 数据隔离」），
这条缺口就会变成真洞。

**建议排期**：放在 M5 之前，作为 M6.2「跨 scope 直读收口」——
实现是给三个读路径加 scope 过滤并按 caller scope 返回 `NOT_FOUND`（跨 scope 与不存在同形，不确认存在性），
测试用两个 scope 构造跨 scope 直读必须失败。改动面在 `packages/memory` + `apps/server` 的读路由，
不动检索排序，风险可控。**这一条需要主人点头才开工**（本轮没派）。

---

## 六、本轮动工项（已完成）

| 任务 | 内容 | 结果 |
|---|---|---|
| `task-1`（M4.6 usedLater） | `brain-tools` 注册 `session/event` 钩子，`turn/end` 时比对 assistant 文本与命中记忆原文，产出 `usedLater` 证据（连续 ≥12 字原文才记 true，否则 null，**绝不记 false**） | ✅ 新增 `apps/brain-tools/used-later.js` + 11 用例（tests/m4/usage 25 全绿）；smoke 30/30、路由 67/67、页面 44/44；全量 630 / 629 pass（唯一红是 `drill.test.mjs` 被沙箱禁 spawn，前台直跑演练 exit 0 / 24 项全过）。**要重启 dsh web 才出数** |
| `task-2`（M6.1 实体 kind） | 实体门面加 `updateKind` + `tools/fix-entity-kinds.mjs`（默认 dry-run），只修 4 个 teammate 代号的 kind | ✅ 7 用例全绿；dry-run 精确列出 `context2/connector2/console2/lead → other`（`小狐狸` 不在列），**生产库零写入**（person 仍 5 个、`audit_logs` 仍 1 条） |

**收口时修掉的一个真问题**：`tools/verify-routes.mjs` 原来没传 `usedLaterLogPath`，插件会走生产默认路径——
本脚本只读不会写，但**验收报告会读到生产观察期数据**，而且离「合成数据落进观察期」只差一次 `turn/end` 模拟。
已补传参 + 加三条断言（口径必须在、必须写明「下界」、sidecar 必须指临时目录），现 67/67 全绿。

**未动（等主人定）**：4 条矛盾合并（第二节清单）、13 个孤儿里 3 个「该有记忆却没有」的补录、跨 scope 直读收口、
`node tools/fix-entity-kinds.mjs --apply`（先备份再执行）。

---

## 七、第一轮真实检索实测（3 个查询，2026-10-29 夜）

不是造数据，是拿三个「明明该有」的查询真打了一遍。结论比任何统计都直接。

### 查询 1：`群星 交互 设计血统 地图模式` → **弱命中，全部跑偏**

返回 5 条，全是 `dsh-grsai-canvas` 画布插件的交互代码（`lib/parts/12-canvas-tab.js`、扩图拖拽等），
**一条都不是「群星 / Stellaris 交互设计血统」**。工具自己也给了「可能相关，但证据不够」的提示——它没撒谎，是库里真没有。

- 事实：心海页的地图模式切换、左侧边栏、右侧面板、顶部状态条、底部工具栏，**抄的是 Stellaris 的交互模式**（HANDOVER 第 382 行写明）。
- 但这条血统**只活在文档里，没进记忆库**。所以「我们当初参考了什么」这类查询，永远查不出来。
- **判定：语料缺口，不是索引缺口**——索引把语义相邻的「交互/地图」条目都捞出来了，说明检索自身工作正常。

### 查询 2：`心海 3D 记忆海 星图 页面` → **命中，但一条事实存了三遍**

返回 5 条，其中 3 条是**同一句话的三个变体**：
`mem_d15c64d5…`（前端星海页面 UI 改成 3d-memory-sea）、`mem_d9eedfc3…`（认为 3d-memory-sea 效果不错，希望前端做成类似）、
`mem_b624303a…`（外置大脑前端 UI 改成 3d-memory-sea 星海效果）。
另有 1 条无关（`dsh-plugin.org` 插件页面），1 条 `dsh-brain` 入口相关的勉强沾边。

- 「心海」这个词本身**没有独立记忆**（它是我在 HANDOVER 里给它起的名字），靠 `3d-memory-sea` 这条兜住。
- **判定：迁移带来的重复冗余**。同一事实存 3 份，检索时白占 3 个名额，把真正的细节挤出去。
- 动作候选：这三条保留信息最全的 `mem_b624303a`（带 `dsh-brain` + GitHub 项目名），另外两条走 `supersedes`。

### 查询 3：`外置大脑 项目目标 卸载 Engram 前提` → **弱命中，核心事实不在库里**

返回 5 条：1 条（项目开始落地，2026-10-28）算相关，其余 4 条是工具挂载、`cordis.patch.yml` 配置、probe 任务——**跑偏**。

- 「项目最终目标是补齐能力后卸载 Engram」这条**只在 Engram 库里，没迁进来**（迁移时漏了这类总结性记忆）。
- **判定：语料缺口**。而且是最要命的一类——它是整个项目的目标，却查不到。

### 三个查询压成三句话

1. **弱命中比零命中更危险**：零命中你会去补语料；弱命中看起来「有结果」，实际答非所问，容易让模型拿着错东西硬答。
   `brain_search` 现在会在结果前提示「证据不够」，这个提示是有效的（查询 1、3 都触发了），**别为了好看去掉它**。
2. **语料缺口集中在「文档里有、库裡没有」的总结性事实**：设计血统、项目目标、给系统起的概念名（心海）。
   这说明迁移只搬了「对话里说过的话」，没搬「文档里沉淀的结论」。
3. **重复记忆要合并**（至少 `3d-memory-sea` 那三条）。这不是矛盾核验那 6 条，是另一批。

**建议**：把「补 5～8 条总结性事实」作为观察期的第一个具体动作（设计血统三条、项目目标一条、心海定义一条）。
补录走 `brain_remember`，`sourceType` 用 `owner_words` 还是别的要在补的时候定——文档结论不是我"听主人说的"，
写 `observation` 更诚实（M5 自动提取也用这个类型）。**这一条要先跟主人确认措辞再写。**

---

## 八、执行记录 · 2026-10-30 下午

按上面的结论动手，两件事已落地，一件在排期。

### 8.1 实体 kind 修正（已真写）

`node tools/fix-entity-kinds.mjs --apply` → **改 4 条 / 失败 0**。复核：

- `person` 只剩 **1 个：`小狐狸`**（4 个 teammate 代号已转 `other`，`other` 从 25 → 29）
- `audit_logs` 从 1 条 → **5 条**（新增 4 条 `action='entities.updateKind'`，可逐条反查）
- `memory_entities` 178 条**未被动**，`active` 记忆数不变
- 幂等复跑：`改 0 / 已是目标 4`

**备份**：`data/backups/brain-consistency-20261030-174932.db`（`VACUUM INTO` 一致性快照，`integrity_check=ok`，217 条 active）。
**踩到的坑**：`Copy-Item brain.db` 是错的——WAL 模式下主文件不含最新提交（当时 `brain.db-wal` 有 4.8 MB），
而 `Get-FileHash` 会因为宿主进程持有文件直接失败。一致性快照只能走 `VACUUM INTO` 或 SQLite backup API。

### 8.2 记忆合并（已真写，5 对）

`node tools/merge-duplicates.mjs --apply` → **merged 5 / failed 0**：

- 一律走门面 `memories.supersede`：旧条目封口（`status=superseded` + `valid_until`）、保留条目记 `supersedes`、
  写 `memory_versions` 版本记录。**没删任何正文**，`asOf` 回看历史时刻仍能读到旧值。
- 顺带删掉结局已无意义的 4 条 `contradicts` 边（矛盾已合并，红条还挂着就是骗人）。
- 结果：`active` 217→**212**、`superseded` **5**、`contradicts` 边 6→**2**、`valid_until` 非空 0→**5**（时间轴第一次有终点）。
- 检索实测：查「项目根目录 工作目录」**只命中 1 条**（合并后的），5 条已封口的一个都没冒出来。
- 幂等复跑：`merged 0 / already 5`。
- **回滚 SQL 在 `docs/MERGE-ROLLBACK-20261030.sql`**，不是靠记忆手写。

**踩到一个门面的局限（值得记）**：`memories.supersedes` 是**单值列**。一条新记忆取代多条旧记忆时，
第二次 `supersede` 会把字段覆盖成最后那个 id（本例 `mem_b624303a` 同时取代 `mem_d15c64d5` 和 `mem_d9eedfc3`，
表里只留下后者）。旧条目的 `status=superseded` 和 `memory_versions` 里的 `superseded_by:<newId>` 都还在，
可追溯性没丢；但**「这条新记忆取代了哪些旧的」从 `memories` 表里查不全**，得读版本记录或反向查旧条目。

### 8.3 M6.2 跨 scope 直读收口（已完成，`scopefix`）

**先说结论：`MVP-HARDENING-GAP.md` §A4 那段已经过时了。** 它点名的 4 条读路径
（`memories.get` / `summaries.get` / `store.getMemory` / `GET /api/memories/:id`）**早就收口了**，
另有一份 `tests/m2/memory/scope-isolation.test.mjs` 锁着。照着文档去改会改到不该改的地方。

真洞在文档没点名的地方，这次补了 10 个入口：
`entities.get` / `entities.memoriesFor` / `entities.forMemory` / `memoryEdges.forMemory` /
`memoryEdges.remove` / `contextPackages.get` / `contextPackages.updateStatus` / `contextPackages.list` /
`sources.forMemory` / `sources.verify`，外加 `store.listContexts` 与 `GET /api/context/:id` 的 scope 透传。

- 新增 `tests/m6/entities/scope-direct-read.test.mjs` **12 项**，用的是
  `assert.deepEqual(跨scope, 真不存在)`（锁「同形」，不满足于断言 null）。
- 全量 **642 / 641 pass**（唯一红仍是 `drill.test.mjs` 的沙箱 spawn 限制）；
  `verify-routes` **67/67**、`smoke` **30/30**、`verify-pages` **44/44**。
- **口径四条与既有完全同一套**（默认按 caller scope / 越界与不存在同形 / `allowCrossScope` 只给内部 /
  不改返回形状），写进了 CONTRACTS §16。
- 已知边界也记了（`contextPackages.save` 幂等查重刻意全局、`corrections` 事务内回读刻意不再过滤等），
  免得下次有人「顺手补一刀」。

### 8.4 合并之后暴露的口径错误（已修）

5 条记忆被合并封口后，三处统计立刻对不上：`/api/stats` 报 217（把 5 条 superseded 也算成「记忆」）、
覆盖率分母 217（这 5 条永远命中不了）、`computeCoverage` 的分子把「幽灵 id」也算成被查过。
**两头一夹，观察期要看的「语料缺口」结论会直接反掉。**

修完的统一口径（写进 CONTRACTS §17.2）：

| 位置 | 现在 |
|---|---|
| `/api/stats` 的 `memories` | `status='active'`（212），另返回 `superseded` 计数，首页标题写「记忆（封口 5）」 |
| 覆盖率分母 | `active`（212） |
| 覆盖率分子 | 只算 catalog 内的，差额进 `staleTouched`（本次 3 条） |

`node tools/verify-usage.mjs` 现在的读数：
**212 条 active / 5 条封口 / 窗口内查到 19 条 / 覆盖率 9.0% / stale 3 条已剔除**。

### 8.5 补录结论性事实（已完成，8 条）

`tools/seed-project-facts.mjs --apply` → **created 8 / failed 0**，幂等复跑 `already=8`。写前先做了
`VACUUM INTO` 一致性快照（`data/backups/brain-consistency-20261030-182226.db`，integrity ok）。

- **来源诚实**：`sourceType='observation'` + `confidence=0.8`（不是 `owner_words` / 1.0——这些是我读文档
  整理的，不是主人亲口说的）。每条带 `basis`（依据文件与章节）并 `sources.link(sourceKind='document')`，
  检索时不会报 `source_missing`。
- 结果：`active` 212 → **220**、`source_type='observation'` 从 0 → **8**、`document` 类型来源关联 8 条。
- **缺口验证（补前 vs 补后）**：

| 查询 | 补之前（第七节） | 补之后 |
|---|---|---|
| 「群星 Stellaris 设计血统」 | 5 条全是画布插件无关条目，工具提示「证据不够」 | **第 1 条就是**「心海的交互框架抄《群星（Stellaris）》」（observation） |
| 「卸载 Engram 灵枢 目标」 | 5 条里只有 1 条勉强相关 | **第 1 条就是**「外置大脑的目标：补齐能力后卸载 Engram 与灵枢」，状态 `ok` |

- 顺手给 `brain_remember` 加了可选 `origin`（`owner_words` 默认 / `observation`），
  默认行为不变——它原来硬编码 `owner_words` + `confidence=1`，把文档结论记成主人原话就是虚报。

### 8.6 这一轮结束时的状态（2026-10-30 18:30）

- **代码**：M0–M6 + M4.6 + M6.1 + M6.1b + M6.2 + M7 全部完成。
  验收：全量 `642 / 641 pass`（唯一红是 `drill.test.mjs` 的沙箱 spawn 限制，前台直跑演练 exit 0 / 24 项）、
  路由 **82/82**、页面 **61/61**、冒烟 **30/30**、`verify-usage` exit 0 且口径自洽。
- **数据**：220 条 active / 5 条封口 / 2 条矛盾待核验（都是「不是矛盾」，保留待人工）；
  8 条 observation 新结论；`conflict-actions.jsonl` 尚未产生（还没人在页面上点过核验动作）。
- **还差的**（都等重启或等人）：
  - **重启 3080** —— 分页、矛盾动作、治理内嵌、usedLater 出数，全要重启才在真机生效；
  - **usedLater 首条真机数据** —— 本环境起不了第二实例（沙箱写不了 `C:\Users\<you>\.dsh\`，`EPERM`）；
  - **两条「不是矛盾」的边** —— 5 对合并完还剩 2 条，都判定为「不是矛盾」，留给人工决定是保留还是改关系类型
    （页面上现在可以直接点「两条都对，不是矛盾」）。

### 8.7 第一次真实使用（主人在页面上自己点的，2026-10-30 18:30）

`data/logs/conflict-actions.jsonl` 出现了第一批**真实**审计行——不是测试、不是脚本，是主人在
`/dsh-brain/conflicts` 页面上点的。这正是那份 sidecar 存在的意义：**改动有痕、可回溯**。

| 时间 | edgeId | 动作 | 保留 | 被封口 |
|---|---|---|---|---|
| 18:30:43 | `edge_7846009f…` | `keep-right` | `mem_9bdac602`（M3 删除线**实现细节**） | `mem_a05dbadc`（M3 完成**结论**：540/540、演练 24/24） |
| 18:30:48 | `edge_b17a7af8…` | `keep-right` | `mem_cb7c1b6f`（10-23 抖音插件安装 episode） | `mem_a40ce6fc`（10-25 DSH 插件安装踩坑 **skill**） |

**这两条当初被我判为「不是矛盾、建议保留」**（第 2 节表格 #1 和 #3），主人选择合并。
判断不同没关系——数据动作有审计、有 `rollbackHint`，随时能退。值得记下来的事实：

- 合并后：`active` 218 / `superseded` **7** / `contradicts` **0**（6 条矛盾全部清完）。
- 页面上的「两步确认」确实按设计走了：两次点击间隔 5 秒，第一次都没触发请求。
- **第 2 条值得注意**：封掉的是 `skill`（「插件安装踩坑」方法论），留下的是具体一次 episode。
  方法论通常比单次经历更通用——如果主人想换回来，回滚就是把两条的 status/supersedes 复位再重建矛盾边。
  回滚 SQL 可由 `conflict-actions.jsonl` 里的记录直接生成（edgeId + fromId + toId 都在）。
