# A-packages.md — packages 层审计

> 审计对象：`E:\ds-h\dsh-brain\packages\`（core / memory / search / context / workspace / persona / directives / cognition，以及 README 提到的 backup）
> 审计日期：2026-10-30 夜 · 环境：Windows / node v22.22.2 / 只读审计，未改任何源码与配置
> 生产口径（Lead 已核实，本地复核）：生产 profile `C:\Users\su\.dsh\profiles\web\cordis.patch.yml` 只挂 `apps/brain-tools`（id: brain-tools）。
> 该插件入口 `apps/brain-tools/index.js:183` 动态 import `@dsh-brain/memory`，`:186` 调 `openBrain({ dbPath, migrationsDir, bindings })`。
> 因此：**"生产在用" = 能被 apps/brain-tools 这条链路调到；只被 tests/ 或 tools/ 调到的不算生产在用。**

---

## 一、总表（八包 + backup）

| 包 | 规模（src） | 生产加载 | 生产实际调用 | 判定 | 一句话结论 |
|---|---|---|---|---|---|
| core | 6 文件 / 1152 行 | ✓ 被所有包静态依赖 | ✓ 纯函数（canonicalJson / sha256 / BrainError / clock / ids） | **生产在用** | 地基，必需，保留 |
| memory | 24 文件 / 12734 行 | ✓ `brain-tools/index.js:183` → `openBrain` | ✓ 门面被生产大量调用（memories / sources / entities / memoryEdges / mood / deletion） | **生产在用（唯一主力）** | 真正撑起「查/记/忘/实体/情绪」的包 |
| search | 4 文件 / 818 行（`.mjs`） | ✓ 经 `memory/src/memories.js:25`、`search-bridge.js:21` 静态 import | ✓ 检索主路（FTS char + trigram + ngram + RRF） | **生产在用** | 中文检索本体，保留 |
| context | 8 文件 / 1527 行 | ✗ 不在 brain-tools 链上；只被 `apps/connector/index.js:93` import、`:909` 调 `build()` | ✗ 生产零调用（`context_packages` 表 0 行） | **未接生产 / 半成品** | 构包能力齐全但没人用；接与不接要决策 |
| workspace | 5 文件 / 1257 行 | ✓ 经 `memory/src/index.js:29` 静态 import，`:169` 组装，`:260` 挂到 openBrain 返回对象 | 部分：控制台读开关/焦点/候选 + `setSwitch` 写；**`publish`/`propose` 生产零调用** | **已加载，只用了开关面** | 事件总线与候选仲裁没有任何生产者 |
| cognition | 7 文件 / 3627 行 | ✓ `memory/src/index.js:30` import，`:182` 组装，`:265` 挂出 | 部分：页面只读 + 人工动作（promote / dismiss / release / purge / ack / resolve）；**runOnce / checkOnce / recordResult / markMemory / scan 生产零调用** | **已加载，缺驱动器** | 五套类脑模块没有触发入口，表全空 |
| persona | 10 文件 / 4984 行 | ✓ `memory/src/index.js:31` import，`:198` 组装，`:271` 挂出 | 部分：`social.preview` / `social.cancel` / `versions.resolveConflict` + 页面只读；**generate / arbitrate / send 生产零调用**；`outboundChannel` 未注入 | **已加载，缺驱动 + 缺通道** | 能预演「本来会说什么」，但永远不生成、不发送 |
| directives | 11 文件 / 4630 行 | ✓ `memory/src/index.js:32` import，`:211` 组装，`:276` 挂出 | 部分：暂停/等级开关 + 页面只读 + dry-run 报告；**`scheduler.runOnce` 生产零调用**；`directiveHooks` 未注入 | **已加载，缺驱动 + 缺 hook** | 指令队列永远不执行，六个动作永远 `hook_missing` |
| backup | **0 文件（空目录）** | — | — | **空壳目录** | 代码实体在 `packages/memory/src/backup.js`；README 旧版把它列成包 |

> 规模按 `src/*.js|*.mjs` 实测行数统计；`backup` 目录 `Get-ChildItem -Recurse` 为空。

### 最要紧的三个事实（先看这三条）

1. **M8 四个包确实"挂进生产"了，但只是挂出来，没有任何驱动器。**
   `openBrain` 的返回对象里 `workspace` / `cognition` / `persona` / `directives` 都在（`packages/memory/src/index.js:260,265,271,276`），控制台也能读到真数据；
   但所有「运行一次」的入口在生产侧零调用（下节逐条给引用）。`packages` 目录里除了 `write-queue.js:263` 的超时 timer，**没有任何 `setInterval` / `setTimeout` 驱动**，`apps/brain-tools/index.js` 全文也没有定时器。
2. **生产库现状是最硬的反证：开关全开，业务表全空。**
   只读查询 `data/brain.db`：`brain_switches` 六键 = `paused=0`、`autonomy.enabled=1`、`autonomy.max_level=L3`、`social.enabled=1`、`social.allow_external=1`、`reflection.enabled=1`（**5/6 是开的**），而
   `ws_events` / `ws_candidates` / `attention_focus` / `memory_salience` / `reflections` / `reflection_runs` / `skill_stats` / `skill_lessons` / `immune_quarantine` / `health_alerts` / `social_candidates` / `social_sends` / `response_decisions` / `directives` / `directive_runs` / `directive_steps` / `relationship_events` / `persona_profiles` / `persona_versions` / `persona_conflicts` **全部 0 行**；
   `person_models` / `relationship_states` / `proactive_policies` 各 1 行（来自 `tools/init-person.mjs` 冷启动，不是功能运行产物）。
   → 不是「关着等开」，是「打开也不会动」。
3. **「文档写着实现了」与「生产在跑」是两件事。** M8 的代码与测试是齐的（四个包 292/292 全绿），但接线缺三样：定时/事件驱动、`directiveHooks`、`outboundChannel`。详见第五节。

---

## 二、逐包详述（含证据）

判定口径：**生产** = `apps/brain-tools`（含它按需动态加载的治理服务）；**测试** = `tests/`；**工具** = `tools/`、`packages/*/bin/`、`apps/*/smoke.mjs`。

### 1. core —— 生产在用（地基）

导出：`canonicalJson` / `sha256Hex` / `contentHash` / `structureHash`（canonical.js）、`BrainError` 及错误码（errors.js）、`createClock`（clock.js）、事件信封与 ID（envelope.js / ids.js）。

证据：
- `packages/memory/src/db.js:12`、`ledger.js:25`、`memories.js:24`、`write-queue.js:18` 等全部 `from '@dsh-brain/core'`，生产链路必然加载。
- 错误身份坑已有处理：`packages/persona/src/core.js:5-26` 用相对路径 `../../core/src/index.js` 避开 Windows junction 导致的双实例 `instanceof` 失败（`docs/M8-SYSTEMS-3456.md:116-121` 记录了这个坑）。

结论：保留，不动。

### 2. memory —— 生产在用（唯一主力）

生产实际调用的门面（grep `apps/brain-tools/index.js` 的 `brain.*` 调用）：
`brain.memories.search/get/create/supersede/list`、`brain.sources.link`、`brain.entities.stats/list/get/forMemory/memoriesFor/resolve`、`brain.memoryEdges.list/conflicts/link/remove/stats`、`brain.mood.getState/stats/listEvents`、`brain.deletion.requestDeletion`、`brain.backup.listSnapshots`。

生产库数据：`memories` 226 行（active 218 / superseded 7 / deleted 1）、`source_refs` 225、`memory_entities` 197、`audit_logs` 11、`deletion_tombstones` 1、`backups` 1。
→ 这些是真在用的功能，不是摆设。

**但 memory 内部也有整块没进生产流的：**
- `events` 表 **0 行**、`outbox` 1 行、`summaries` 0 行、`task_snapshots` 0 行、`context_packages` 0 行。
- 对应门面 `summaries` / `snapshots` / `contextPackages` 在 `apps/brain-tools` 里零调用；`contextPackages` 只在删除清理内部被用（`packages/memory/src/deletion-worker.js` 引 `context_packages` 表）。
- M1 的「事件信封 + outbox + 幂等摄取」通道在生产没有流量：`events=0` 说明它主要是测试/探针路径的产物。

结论：保留；`summaries` / `snapshots` / `contextPackages` 属于「代码齐、生产没入口」。

### 3. search —— 生产在用

- `packages/memory/src/memories.js:25` 静态 import `buildFtsMatch / coverageOf / ngramTerms / querySegments / rrfFuse`。
- `packages/memory/src/search-bridge.js:21` 静态 import `createSearchIndex / createSearchSchemaStatements / searchTableNames`。
- 生产 `brain_search` 走的就是这条链路（`apps/brain-tools/index.js:374` 起的工具定义 → `brain.memories.search`）。

结论：保留。它没有独立的 `src/index.js`，入口是 `src/index.mjs`（`package.json` main 指它），风格与其它包不一致，但可用。

### 4. context —— 未接生产（本次审计的重点缺口）

能力齐全：`build` / budget / estimate / render / canonical / state / types，共 1527 行。

引用点（全部非生产）：
- `apps/connector/index.js:93` import `@dsh-brain/context`，`:909` 调 `contextModule.build({ store, ... })` —— connector **没有挂进生产 profile**（Lead 已核实）。
- `apps/server/bin/seed-demo.mjs:183`（工具脚本）。
- `tests/m2/context/**`（测试）。
- `packages/memory/src/context-packages.js:141` 只有一句注释说明「canonicalize 是 context 的职责」，**没有 import context 代码**；`memory/package.json:35` 却声明了 `@dsh-brain/context` 依赖 → 声明了但没用。

后果：
- `context_packages` 表 0 行；`built → attached → sent` 三级证据链在生产从来没有数据。
- README 旧版（现 `docs/README-full.md`）主打的「动态上下文装配 / 注入」在生产 profile 里等于不存在（`explicit` 模式只挂三个显式工具）。

结论：**要么接（挂 connector + 配 automatic/shadow），要么明确标为实验包并从 README 主卖点里拿掉**。现状是「功能写完了，用户用不到」。

### 5. workspace —— 已加载，只用了开关面

`openBrain` 里真实构造并挂出：`packages/memory/src/index.js:169-176`（`createWorkspace({ db, queue, clock, alert, bindings, now })`）、`:260`（返回对象 `workspace`）。

生产调用面（`apps/brain-tools/index.js`）：
- `:2036`、`:2040`、`:2253`、`:2257`、`:2286`、`:2290` `brain.workspace.setSwitch(...)` —— 控制台改开关。
- 页面读：`apps/brain-tools/workspace-page.js:174` `collectWorkspaceView(brain, ...)`，`:1935` 渲染 `/workspace`。
- API：`/api/workspace`、`/api/workspace/switch`（`apps/brain-tools/index.js:1971`、`:2021`）。

零生产引用（只有测试）：
- `workspace.publish` —— `tests/workspace/workspace-bus.test.mjs:18`、`workspace-switches.test.mjs:112`；生产 0。
- `workspace.propose` —— `tests/workspace/workspace-bus.test.mjs:105` 起多处；生产 0。
- 于是 `ws_events`、`ws_candidates`、`attention_focus` 全 0 行。

结论：**通信面（事件总线/候选/注意力）没有任何生产生产者**，只在控制台展示空表。保留代码可以，但要承认它现在是「空转的展示层」。

### 6. cognition —— 已加载，缺驱动器

`memory/src/index.js:30` import、`:182-192` 组装、`:265` 挂出。五个子模块的 API（`salience` / `reflect` / `skill` / `immune` / `brainstem`）实现完整，测试齐全。

**生产侧（apps/brain-tools）对这些方法的全部调用：**
- 人工动作：`reflect.promote`（`:2075`）、`reflect.dismiss`（`:2078`）、`immune.release`（`:2103`）、`immune.purge`（`:2110`）、`brainstem.ack`（`:2134`）、`brainstem.resolve`（`:2137`）。
- 页面只读：`cognition-page.js:171` `brainstem.listAlerts`、`:188` `reflect.list`、`:199` `immune.list`、`:211` `skill.listWeakSkills`。

**零生产调用（逐个核实）：**

| 方法 | 唯一引用者 | 后果 |
|---|---|---|
| `salience.markMemory` | `tests/cognition/salience.test.mjs:49` 等；工具 0 | `memory_salience` 永远 0 行 |
| `reflect.runOnce` | `tests/cognition/reflect.test.mjs:66` 等（30+ 处） | `reflections` / `reflection_runs` 永远 0 行 |
| `skill.recordResult` | `tests/cognition/skill.test.mjs:52` 等 | `skill_stats` / `skill_lessons` 永远 0 行 |
| `immune.scan` | `tests/cognition/immune.test.mjs:38` 等 + `tools/verify-m8-ui.mjs:211`（工具） | `immune_quarantine` 永远 0 行 |
| `brainstem.checkOnce` | `tests/cognition/brainstem.test.mjs:45` 等 | `health_alerts` 永远 0 行 |

「空闲反思」没有任何空闲触发：包里无 `setInterval`/`setTimeout`（除 `write-queue.js:263` 的超时），`apps/brain-tools/index.js` 也没有定时器。`reflection.enabled=1` 在当前生产库上**没有任何作用**。

结论：**代码完整、测试 292 条里占大头，但生产是"只读面板 + 人工点按"，没有自主行为。** 要让它有用，必须补一个驱动点（见第六节）。

### 7. persona —— 已加载，缺驱动 + 缺通道

`memory/src/index.js:31` / `:198-206` / `:271`。10 个文件、4984 行，是全仓库第二大的包。

生产调用面：
- `social.preview`（`apps/brain-tools/persona-page.js:530`、`index.js:2166`）——只读预演「本来会说什么」。
- `social.cancel`（`index.js:2202`）、`versions.resolveConflict`（`index.js:2237`）、`versions.list/getActive/listConflicts`（`persona-page.js:483/491/507`）。
- `/api/persona/social/dry-run`、`/api/persona/social/cancel`、`/api/persona/conflict/resolve`（`index.js:2154/2188/2214`）。

零生产调用（只有 tests）：
- `social.generate` — `tests/persona/social.test.mjs:57` 等 30+ 处；生产 0。
- `social.arbitrate` / `social.score` / `social.send` — 同上包内测试；生产 0。
- 后果：`social_candidates`、`social_sends`、`response_decisions` 全 0 行；`relationship_events` 0 行（`relationship_states` 的 1 行来自 `tools/init-person.mjs`）。

**通道缺口**：`openBrain` 生产调用（`apps/brain-tools/index.js:186`）只传 `dbPath/migrationsDir/bindings`，没传 `outboundChannel` → `memory/src/index.js:205` 把它落成 `null` → 主动消息最多 dry_run，永远发不出去。文档自己也承认（`docs/M8-SYSTEMS-3456.md:100`「真发通道没实现，只留了 hook」）。

结论：**面板能看「它本来会说什么」，但既不会真的生成候选（无 generate 入口），也永远发不出去（无 channel）。**

### 8. directives —— 已加载，缺驱动 + 缺 hook

`memory/src/index.js:32` / `:211-219` / `:276`。11 文件 4630 行。

生产调用面：
- 开关：`/api/directives/pause`（`index.js:2246` → `setSwitch('paused')`，`:2253-2257`）、`/api/directives/level`（`:2276` → `setSwitch('autonomy.max_level')`，`:2286-2290`）。
- 页面只读：`directives-page.js:150` `collectDirectivesView`；其中运行记录**直查 SQL**：`directives-page.js:211` 与 `:240` `brain.db.prepare('SELECT ... FROM directive_runs / directive_steps')`（文档自认此缺口，`docs/M8-SYSTEMS-3456.md:105`）。
- dry-run 报告 `tools`/`bin` 路径（`packages/directives/src/dry-run.js`）。

零生产调用（只有 tests）：
- `scheduler.runOnce` — `tests/directives/scheduler-execution.test.mjs:42`、`scheduler-gates.test.mjs:47`、`scheduler-lease.test.mjs:63` 等；生产 0。
- `scheduler.claimNext` / `heartbeat` / `recoverStaleRuns` / `expireStaleDirectives` — 仅 `tests/directives/*`。
- 后果：`directives`、`directive_runs`、`directive_steps` 全 0 行。

**hook 缺口**：生产 `openBrain` 没传 `directiveHooks` → `memory/src/index.js:218` 落成 `null` → `actions.js:44,113` 六个内置动作一律返回 `{ ok:false, reason:'hook_missing' }`。即使手动往库里塞一条指令、调用 `runOnce`，也会停在 `hook_missing`（`scheduler.js:739`、`:1101`）。
`directives/src/index.js:203` 的注释自己写了「宿主可以在定时器里先问一句再决定要不要调 runOnce」——**而生产里没有任何定时器**。

结论：**自主执行 = 0。开关、权限矩阵、状态机、租约都是真代码，但没有驱动、没有 hook，等于「能看不能动」。**

### 9. backup —— 空壳目录

- `packages/backup/` 下 0 个文件（连 README 都没有）。
- 实际备份/恢复代码在 `packages/memory/src/backup.js`（65 KB）与 `restore.js`（42 KB），生产通过治理服务 `apps/brain-tools/index.js:822` 动态加载 `apps/server/src/server.mjs` 才用到。
- README 旧版目录树把它列成独立包：`docs/README-full.md:309`（`│  └─ backup/ # 全量快照、校验、隔离恢复`）。

结论：**删空目录，或补一个包实体；README 里的目录声明要改。**

---

## 三、死代码清单（"有实现、生产零调用"）

按「零引用来源」排序，全部有 grep 证据：

| # | 能力 | 实现位置 | 引用者 | 生产库证据 |
|---|---|---|---|---|
| 1 | 反思运行 `reflect.runOnce` | `cognition/src/reflect.js:518` 起 | 仅 `tests/cognition/reflect.test.mjs` 等 | `reflections=0`、`reflection_runs=0` |
| 2 | 健康巡检 `brainstem.checkOnce` | `cognition/src/brainstem.js:147` 起 | 仅 `tests/cognition/brainstem.test.mjs` | `health_alerts=0` |
| 3 | 显著性标记 `salience.markMemory` | `cognition/src/salience.js:153` 起 | 仅 `tests/cognition/salience.test.mjs` | `memory_salience=0` |
| 4 | 技能校准 `skill.recordResult` | `cognition/src/skill.js:229` 起 | 仅 `tests/cognition/skill.test.mjs` | `skill_stats=0`、`skill_lessons=0` |
| 5 | 安全扫描 `immune.scan` | `cognition/src/immune.js:310` 起 | `tests/cognition/immune.test.mjs` + `tools/verify-m8-ui.mjs:211` | `immune_quarantine=0` |
| 6 | 指令调度 `scheduler.runOnce/claimNext/heartbeat/recoverStaleRuns` | `directives/src/scheduler.js:95` 起 | 仅 `tests/directives/*` | `directives=0`、`directive_runs=0` |
| 7 | 主动社交生成/仲裁/发送 `social.generate/arbitrate/send/score` | `persona/src/social.js` | 仅 `tests/persona/social.test.mjs` | `social_candidates=0`、`social_sends=0` |
| 8 | 事件总线 `workspace.publish` / 候选 `workspace.propose` | `workspace/src/events.js` / `candidates.js` | 仅 `tests/workspace/*` | `ws_events=0`、`ws_candidates=0` |
| 9 | 构包 `context.build` 全套 | `context/src/build.js:117` 起 | `apps/connector/index.js:909`（未挂载）+ `tests/m2/context/*` | `context_packages=0` |
| 10 | 摘要 / 快照 / 构包门面 | `memory/src/summaries.js`、`snapshots.js`、`context-packages.js` | 生产 `apps/brain-tools` 零调用 | `summaries=0`、`task_snapshots=0`、`context_packages=0` |
| 11 | 备份空目录 | `packages/backup/` | 无 | 0 文件 |

说明：第 1~8 项不是「代码差」，是「**驱动器缺位**」。它们的测试都绿（M8 四包 292/292），逻辑也自洽；缺的是「谁在什么时候调它」。

---

## 四、半成品清单（功能只到一半）

1. **context 包**：能力 100%，生产接入 0%。`explicit` 模式下用户永远看不到注入与三级证据。
2. **cognition**：五套模块都在，但只读展示 + 人工处置；反思、体检、显著性、技能、免疫扫描五项全部无触发。
3. **persona**：人格导入/版本/冲突/关系四维/回复五态是完整实现（测试 5 文件），但主动社交从 generate 起就没有入口；`outboundChannel=null`。
4. **directives**：权限矩阵/状态机/租约/预算/停止条件完整，但 `runOnce` 无人调、`hooks=null` 六动作全 `hook_missing`。
5. **workspace**：开关面在用（控制台能改、能读），事件与候选面空转。
6. **memory**：核心门面在用，但 M1 事件通道（`events=0`）与 M2 的摘要/快照/构包门面在生产没有流量。

---

## 五、文档声称 vs 代码事实（本次审计核心产出）

| # | 文档原话（位置） | 代码/数据事实 | 判定 |
|---|---|---|---|
| 1 | 「四套系统**都已经在磁盘上、在生产库里、在测试覆盖里**，但**默认全部关闭**」`docs/M8-SYSTEMS-3456.md:9` | 表都在 ✓、测试 292/292 ✓；但生产库 **5/6 开关是开的**（`autonomy.enabled=1`、`reflection.enabled=1`、`social.enabled=1`、`social.allow_external=1`、`max_level=L3`），且 M8 业务表全 0 行 | **「默认关闭」与现状不符；更关键的是打开也不会跑** |
| 2 | 「空闲反思」`docs/M8-SYSTEMS-3456.md:48`、开关表 `:63` | 包里无定时器、宿主无定时器，`reflect.runOnce` 零生产调用 | **不存在「空闲」触发** |
| 3 | 「四套系统不是没做完，是刻意的：第一次必须由你亲手打开」`:9-10` | 与同文 `:101`「六个动作目前全部未接线（生产 `hooks=null`）」自相矛盾；且开关打开后仍无任何数据 | 口径冲突：**不是「关着等你开」，是「开了也没驱动器」** |
| 4 | 「六个动作目前全部未接线」`:101` | 属实：`memory/src/index.js:218` 落 `null`；`actions.js:44` 返回 `hook_missing` | ✓ 诚实 |
| 5 | 「真发通道没实现，只留了 hook」`:100` | 属实：`apps/brain-tools/index.js:186` 未传 `outboundChannel`，`memory/src/index.js:205` 为 `null` | ✓ 诚实 |
| 6 | 「四个新控制台页面 + 16 个 API」`:19` | 属实：`/workspace`、`/cognition`、`/persona`、`/directives`（`apps/brain-tools/index.js:1927-1944`）+ 16 个 `/api/*`（`:1967-2290`） | ✓ |
| 7 | 「`directives` 页运行记录直查 SQL」`:105` | 属实：`apps/brain-tools/directives-page.js:211,240` `brain.db.prepare(...)` | ✓ 诚实 |
| 8 | 「packages/backup：全量快照、校验、隔离恢复」`docs/README-full.md:309` | `packages/backup/` 0 文件 | **目录声明错误** |
| 9 | 「明确不在 MVP：……**主动社交**、……**独立自主执行**」`docs/README-full.md:362` | `packages/persona` 4984 行 + `packages/directives` 4630 行就是这两件事的实现 | **口径冲突：README 说不在 MVP，M8 文档说已完工** |
| 10 | 「全量 576 / 576 全绿」`docs/README-full.md:55` | 本次实跑：M8 四包 **292/292 绿**；全量仅 1 处红 `tests/contract/backup.test.mjs:58`（SQLite 版本断言 `3.51.2 !== 3.53.3`，环境差异，非逻辑失败） | 大体属实，数字已漂移；版本断言应改为范围比较 |
| 11 | 「现在到哪一步」表只到 M6（旧 README） | 代码已有 M7/M7.2/M7.3/M8；ROADMAP 的「已完成」表也只到 M7.3（`docs/ROADMAP.md:6-27`），**全文没有 M8** | **文档落后于代码**（好在现 README 已精简，长版进 `docs/README-full.md`） |
| 12 | M8 文档称测试「24 + 75 / 68 / 116 条」`:16-18` | 实跑 M8 四包共 **292** 条（cognition 6 文件 / workspace 2 / persona 5 / directives 10） | 数量级对得上，具体口径不同 |

---

## 六、结论：该删 / 该接 / 该保留

### 保留（生产在用，别动）

- **core / memory / search**：`brain_search` / `brain_remember` / `brain_forget` / 实体 / 冲突 / 情绪 / 删除 / 备份这一整条是真在跑的，生产库有 226 条记忆、225 条来源、197 条实体关联为证。

### 该删或该降级

1. **`packages/backup/` 空目录**：删掉，或补一个真正的包壳；同时改 `docs/README-full.md:309` 的目录树。
2. **`context` 包要么接、要么降级**：
   - 接：把 `apps/connector` 挂进 profile，配 `shadow` 或 `automatic`，让 `context.build` 真正产出 `context_packages`；
   - 不接：在 README/文档里把它标为「实验包（未接入生产）」，不要当作已交付能力。
3. **`memory/package.json:34-36` 的依赖声明补齐**：memory 代码 import 了 `@dsh-brain/cognition` / `persona` / `directives`（`memory/src/index.js:29-32`），但 dependencies 只有 `core/search/workspace` 三个。当前靠 pnpm junction 能跑，换包管理器或 `pnpm deploy --prod` 会断。

### 该接（如果 M8 要产生实际价值，缺的就是这几根线）

1. **cognition 驱动**：在 `apps/brain-tools` 的 `session/event` 里接 `immune.scan`（工具输出/外部文本）与 `skill.recordResult`（工具成败）；加一个低调的定时器（或 `turn/end`）调 `brainstem.checkOnce`、在 `reflection.enabled=1` 时调 `reflect.runOnce`。否则 `health_alerts` / `reflections` 永远是空表。
2. **directives 驱动 + hooks**：定时器问 `readGate()` 再调 `scheduler.runOnce`（`directives/src/index.js:203` 的注释就是这么设计的）；给 `openBrain` 传 `directiveHooks`（六个内置动作），否则开了 `autonomy.enabled` 也只会停在 `hook_missing`。
3. **persona social 入口 + 通道**：接 `social.generate`（比如空闲或显式按钮），以及 `outboundChannel`（IM 侧）——不接就永远只能 dry_run。
4. **workspace 生产者**：上面三条接上后，`publish/propose` 自然会有流量；现在 `ws_events` 空表说明通信面没人用。

### 一句话回答「功能是否齐全、这些是否都有用」

- **齐全度：代码层面齐全，接线层面不齐全。** 八个包里 7 个实现了、测试覆盖了（M8 四包 292/292 绿；全量仅 1 条环境相关的 SQLite 版本断言红），`backup` 是空壳目录。
- **有用性：生产真正在用的只有 `core + memory + search` 这条线**（检索/写入/实体/情绪/删除/备份），外加控制台页面把 M8 的表读出来展示。`context` 全套、M8 四个包的自主驱动、`backup` 空目录，在生产里**没有任何数据流**——生产库「开关全开 + 20 张业务表全 0 行」是最直接的证据。

---

## 七、可复核命令

```powershell
cd E:\ds-h\dsh-brain

# 1) 生产入口与组装点
Select-String apps/brain-tools/index.js -Pattern "await import\('@dsh-brain/memory'\)|openBrain\("
Select-String packages/memory/src/index.js -Pattern "from '@dsh-brain/(workspace|cognition|persona|directives)'"

# 2) M8 驱动方法在生产侧是否存在（预期：除 getSwitch/setSwitch/promote/dismiss/release/purge/ack/resolve/preview/cancel 外无输出）
Select-String apps/brain-tools/index.js -Pattern "reflect\.runOnce|brainstem\.checkOnce|skill\.recordResult|salience\.markMemory|immune\.scan|scheduler\.runOnce|social\.generate|social\.send|workspace\.publish"

# 3) 生产库状态（只读；不要跑会写 data/ 的脚本）
node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('E:/ds-h/dsh-brain/data/brain.db',{readOnly:true});for(const t of ['ws_events','reflections','health_alerts','social_candidates','directives','context_packages']){console.log(t, db.prepare('SELECT COUNT(*) c FROM '+t).get().c)}"

# 4) 测试
node --test "tests/cognition/*.test.mjs" "tests/workspace/*.test.mjs" "tests/persona/*.test.mjs" "tests/directives/*.test.mjs"   # 292/292
node --test "tests/**/*.test.mjs"                                                                                                # 仅 contract/backup 版本断言 1 红
```

> 备注：本次审计只读，未改任何源码/配置；`data/` 下的生产库仅用 `readOnly:true` 打开做 `COUNT(*)`。
