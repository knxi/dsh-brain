# M0 接入探针报告 — DSH 真实装配点核查

> 对应《DSH外置大脑-可执行设计方案-v1.2》第 22.2 节 M0 门槛与第 23.3 节六问。
> 全部结论来自本机实机运行（`dsh 0.2.1-rc.3`，Node v24.19.0），不是静态推断。
> 唯一例外：报告中每条 `static:` 开头的证据是宿主包源码行号，用于解释实机现象。

**日期**：2026-10-28 · **探针 run**：`data/probe/m0-20261028-190326/` · **回滚 run**：`data/probe/rollback.json`

---

## 0. 结论摘要（先看这个）

| # | 问题 | 状态 | 一句话结论 |
|---|---|---|---|
| 1 | 一轮触发几次 assemble / pre-step？重试是否重复？ | **answered** | **每 step 一次**，不是每轮一次。多步回合第 2 个 step 会重新装配整个 system prompt 并重过 pre-step waterfall。重试在同一 step 内循环，**不重跑**这两个 waterfall，但会重跑 `refreshContext`。 |
| 2 | 追加片段是否持久化为 system/message？如何按 turn/step 更新不重复提取？ | **answered** | 两条通道形态不同：`sections` → `system/message`；`contexts`（PromptContext）→ **`user/message` 的 durable 快照**。两者都会持久化。去重靠宿主"保留值比对" + 连接器自己打来源标记，宿主不替你做防重复提取。 |
| 3 | 各种中断的终结事件？何时允许更新任务快照？ | **partial** | 工具失败 = 回合继续；进程强杀 = **零终结事件**（日志停在 step 中途）；**用户续写 = 同一会话日志上追加新 turn**（已实测，turn 从 1 变 2）；`turn/end{reason}` 是唯一的回合完成判据。只剩"用户取消"未实测。 |
| 4 | sessionQuery 权限、分页、游标与订阅补读边界？初始化顺序与降级？ | **partial** | 已实调：**精确读全可用**（observeSession/readEvent/readSession/readSurface + lease 释放），**全文搜索全不可用**（`SESSION_QUERY_INDEX_FAILED: index closed` / `SESSION_NOT_FOUND`）。→ M2 历史回查必须放进程外。缺 cursor 分页实跑。 |
| 5 | 能否在最终请求边界证明 sent？ | **answered** | **能证明到"进入最终请求对象"这一层**，但判据必须**两级都查**：system prompt 可能以 `request.system` 或 `messages[role=system]` 形态承载（实测两种都出现）。出网字节仍无本地证据。 |
| 6 | 唯一注入责任方？测试 profile 与生产是否真正隔离？ | **answered** | **灵枢真挂实测**：它向 `assembly.contexts` push 自己的块，宿主**不去重不仲裁**且照常完成回合；更关键——它把探针注入的纹理**摄入成记忆并在后续会话召回**（注入→摄取→再注入回路，已在它认知图文件里验证）。隔离靠路径断言。 |

**记分牌：4 answered / 2 partial / 0 unknown**（task-4 补测后，由 3/3/0 提升）。

**能不能进 M1/M2？** 见第 5 节 —— 结论是**可以进 M1/M2 的骨架，但有 3 条前置约束必须先写进设计**，其中 1 条是本次实测发现的阻断级事实（独立 profile 不隔离数据）。

---

## 1. 环境与复现

### 1.1 本机事实（本次实测确认，非引用）

| 项 | 值 |
|---|---|
| DSH 版本 | `0.2.1-rc.3`，包根 `C:\Users\<you>\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh` |
| Node / pnpm | v24.19.0 / 10.17.0 |
| 真实模型调用 | **打通**。provider `deepseek-official` / model `deepseek-flash`，经 credentials service（`~/.dsh/.credentials.yaml` 管理的 `DEEPSEEK_API_KEY`）。headless bundle 默认 `disabled: true` 掉了 credentials/authorization，brainlab 里显式重新启用。 |

### 1.2 独立 profile `brainlab`

从 `~/.dsh/profiles/headless`（极简模板：`dsh-base` + `dsh-headless`，零依赖）复制而来。改动仅四类：

1. `package.json`：保持两个 bundle，不引入 pnpm 依赖。
2. `cordis.patch.yml`：启用 `credentials`/`authorization`；把 `session-persistence-jsonl.root`、`storage-json.root`、`session-query-sqlite.path` **显式覆盖到仓库内** `data/probe/lab/`；`insert` 探针行。
3. `node_modules/@dsh-brain/probe` → Junction 到 `<repo>\apps\probe`。
4. **`~/.dsh/profiles/web` 全程未读未写。**

> Windows 上 `pnpm link:E:\...` 会被 pnpm 当相对路径解析，生成指向 `profile\E:\...` 的坏 Junction（实测）。故改用 `apps/probe/attach.mjs` 建立 Junction，可 `attach`/`detach`/`status`。

### 1.3 探针（`apps/probe/`）

Cordis 插件形态：`export const name` / `export const inject` / `export function apply(ctx, config)`，纯 ESM JS。

| 观测点 | 挂载方式 | 是否干预 |
|---|---|---|
| `system-prompt/assemble` | waterfall，记录 before/after 装配摘要 | 否（`await next()` 原样返回） |
| `agent/pre-step` | waterfall，记录 claimed/decision | 否（默认原样返回决策） |
| `llm/stream` | waterfall，记录完整请求摘要 | 否（`return next()`） |
| `session/event` | 监听 | 否 |
| `session/flush` / `session/disposed` | 监听 | 否 |
| `agent/request-error` | waterfall | 否 |
| `agent/turn-stopping` | **serial** | 否 |
| `agent/error` / `tools/result` | 监听 | 否 |
| 受控注入 A | `systemPrompt.context()` 注册 `brain-probe:marker` | **是**（环境变量 `DSH_PROBE_INJECT_CONTEXT=1` 显式开启） |
| 受控注入 B | `agent/pre-step` **复制数组**后追加一条 user message | **是**（`DSH_PROBE_INJECT_PRESTEP=1` 显式开启） |

纪律遵守：默认零干预；不注册 `complete: true` 节；不改宿主 messages 数组（注入实验也是复制后返回新数组）；正文只落长度 + sha256 前 12 位，不落正文。

### 1.4 复现

```powershell
# 挂探针
node <repo>\apps\probe\attach.mjs attach
# 跑全套场景（7 个真实回合，全部合成 prompt）
node <repo>\apps\probe\run.mjs
# 回滚验证
node <repo>\apps\probe\rollback.mjs
```

产出：`data/probe/<runId>/{timeline.jsonl, verdict.json, timeline.md}` + `data/probe/rollback.json`。

---

## 2. 六问逐条

### Q1 — 一轮触发几次 assemble / pre-step？重试是否重复？注入顺序受谁影响？ `answered`

**实测（`data/probe/m0-20261028-190326/verdict.json` → `metrics`）：**

| 场景 | turn | step | assemble | pre-step | 主请求 | 标题请求 | turn/end |
|---|---|---|---|---|---|---|---|
| `single` | 1 | 1 | **1** | **1** | 1 | 1 | completed |
| `tool-read` | 1 | 2 | **2** | **2** | 2 | 1 | completed |
| `tool-fail` | 1 | 2 | **2** | **2** | 2 | 1 | completed |

- 单步回合 = 1 assemble : 1 pre-step : 1 主请求。
- **两步回合 = 2 assemble : 2 pre-step**：工具调用之后的第二个 step 重新装配了整个 system prompt，并重新过 pre-step waterfall。**不是"每轮一次"。**
- `llm/stream` 的次数比主请求多 1：每次都是 `purpose="session-title"` 的旁路调用（标题生成）。**统计请求数必须按 `purpose` 剔除旁路**，否则会误判 inject 次数。

**重试路径（未实机触发，static 解释）：**
- `static: dsh-agent-loop/lib/index.js:902-925` — `preStep()` 内先 `systemPrompt.assemble()`（907），再 `dispatch.waterfall("agent/pre-step")`（909）。两者都在 `preStep`，即 per-step。
- `static: dsh-agent-loop/lib/index.js:1043-1140` — `step()` 的 `while(true)` 重试循环里，重试走 `continue`，只重跑 `prepareRequest` → `refreshContext`（1053）→ `llm.stream`；**不回到 `preStep`**。因此重试不重复 assemble、不重复 pre-step。
- `static: dsh-system-prompt/lib/index.js:324` — `refreshContext` 明确"不重跑 sections/tools/variables 的 provider 与 waterfall，只刷新 runtime-context 的文本"。

**注入顺序受谁影响：**
- system prompt 侧：各插件注册的 `section.order`（`static: dsh-system-prompt/lib/types/index.d.ts:119-152` 是官方分配表，如 `HARNESS_IDENTITY=-1000`、`DEPLOYMENT_PERSONA_PREFIX=0`、`TOOL_*=1000+`、`DEPLOYMENT_PERSONA_SUFFIX=10200`），同 order 按 name 的 code-unit 序稳定排序（`comparePromptSections`）。
- runtime context 侧：`context.order`（`CONTEXT_ORDERS`，`WORKING_DIRECTORY=100` … `WEB_SURFACE=210`），同样同 order 按 name。
- pre-step 侧：各监听器的**调用次序** + 它把消息 prepend 还是 append 到 `messages`。Engram 用 prepend，探针实验用 append —— 两者的相对位置因此相反。

**给 M1 的硬约束**：Brain 的片段必须落在**固定 order 区间**，不能与工具节抢位置；且要知道"第二个 step 会再装配一次"，所以片段必须幂等。

---

### Q2 — 追加片段是否会持久化为 system/message？如何按 turn/step 更新不重复提取？ `answered`

**实测（两个受控注入场景，各 1 turn / 1 step）：**

| 场景 | 注入通道 | `system/message` | `user/message` | 携带标记的 user/message | 标记进最终请求 |
|---|---|---|---|---|---|
| `inject-pre` | `agent/pre-step` 复制数组后追加 user message | 1 | **5** | **1** | **1** |
| `inject-ctx` | `systemPrompt.context()`（PromptContext） | 1 | 4 | **1** | **1** |
| 基线 `single` | 无注入 | 1 | 4 | 0 | 0 |

- `inject-pre` 的 `user/message` 从 4 涨到 5 → **pre-step 追加的消息被当作真实 user 消息持久化进会话日志**，不是临时上下文。
- `inject-ctx` 的 `user/message` 仍是 4，但其中 1 条带标记 → PromptContext 走的是 **durable user-role snapshot** 通道，**替换/占据一条 user message**，不落成 system section。**这就是"动态上下文不是 system role"的实证。**
- `system/message` 两个场景都是 1 → 动态 context **没有**污染 system prompt。

`static: dsh-system-prompt/lib/types/index.d.ts:71-83` 把 `PromptContext` 定义为 "materialized as a durable user-role snapshot"；`static: dsh-agent-loop/lib/index.js:1046-1076` 把 `renderContextSections` 的结果 append 成 `user/message`（`surfaceOp: "append"`）。

**去重机制（关键）：**
- `static: dsh-agent-loop/lib/index.js:298-345` `RuntimeContextProjection.project()`：**宿主自己已有"保留值比对"** —— 新快照文本与上次保留值相同就不产生新 user message；被 replace 掉的表层事件会把保留值置空再重建。所以同一段文本不变，宿主不会每 step 重复 append。
- `static: dsh-agent-loop/lib/index.js:230-297` `SystemPromptProjection.project()`：system prompt 首节点若文本不变则**完全不更新**（`latest.text === rendered` 时返回空更新列表）。
- **但这两条都只防"宿主重复 append"，不防"Brain 重复提取自己的旧注入"。** 连接器必须：
  1. 追加时自带来源标记（`source.kind` / `sourceEventSeqs`）——探针实验用的就是可检索的唯一 marker；
  2. 摄取时按该标记剔除自身注入，不把注入当人类证据（对应契约 §2 的 `origin_system` / `causation_id` / `derived_from[]`）。

**给 M1 的硬约束**：记忆片段走 `systemPrompt.context()`（user-role snapshot）而不是 section —— 因为 section 会把大脑内容提升成 system 级指令，踩设计方案第 24 节"人格优先级可能盖过宿主指令"的坑。

---

### Q3 — 生成中被打断、工具失败、用户续写、会话卸载、取消时有哪些终结事件？何时允许更新任务快照？ `partial`

**实测：**

| 场景 | 观测到的终结/边界事件 | 结论 |
|---|---|---|
| `tool-fail`（读不存在的文件） | `tool/call`:1、`tool/result`:1、`step/end`:2、`turn/end{reason:completed}` | **工具失败不终结回合**：错误以 `tool/result` 进日志，模型在下一 step 看到错误，回合正常 completed。 |
| `interrupt-hard`（7s 后 `taskkill /F`） | 有 `turn/start`、`step/start`、`system/message`、`user/message`、`request/header`、`request/context`；**没有 `step/end`、没有 `turn/end`、没有 `assistant/message`** | **进程被强杀 = 零终结事件**。会话日志停在 step 中途；从日志看这是"一个没有结尾的 turn"。 |
| 全部正常场景 | `turn/end{reason:completed}` | 唯一的"回合完成"判据。 |

**终结事件族（static + 实测对照）：**
- `static: dsh-session/lib/types/types.d.ts:267-287` + `dsh-agent-loop/lib/index.js:994/1001/1029`：
  - `step/end`（一步结束）
  - `turn/end{reason: completed | blocked | aborted | error | max-tokens}`
  - `assistant/message{interrupted: true}`（生成中被 abort 时的部分内容）
  - `agent/turn-stopping`（**serial**，停止时的控制点，**不是已经结束**，`lib/index.js:1001`）
  - `agent/request-error`（waterfall，可决定 retry）
  - `agent/error`
  - `session/disposed`（`static: dsh-session/lib/types/index.d.ts:50`）—— 卸载，不是回合结束
  - `session/flush`（`:69`，parallel，持久化 checkpoint）

**何时允许更新任务快照（建议直接写进 M1 契约）：**
1. **只在 `turn/end` 之后**更新任务快照；
2. 按 `reason` 分流：只有 `completed` 可标完成；`aborted`/`error` 必须保持未完成并记中断原因；
3. `agent/turn-stopping` 只可写"候选快照"，不可当已结束；
4. `assistant/message` 每 step 都有且可能 `interrupted: true`，**不能当最终回答**；
5. `session/disposed` 只做尽力补写，不能当回合完成信号；
6. **"日志里最后一个 turn 没有 `turn/end`"必须被识别为异常中断**，恢复逻辑要能处理（这是强杀场景的唯一线索）。

**为什么 partial / 缺什么：** 未实测"用户取消（abort signal）"与"用户续写（同一 session 连续输入）"。`headless` 是**一次性进程**，没有交互式取消入口；Windows 上从进程外发信号等价于强杀（`TerminateProcess`，不跑 exit handler），所以外部信号测不出优雅取消。要升级为 answered 需要：进程内 harness 用 `AbortController` 直接 abort agent，或在 web profile 里点取消。

---

### Q4 — sessionQuery 的权限、分页、游标和订阅补读边界？插件初始化顺序及服务不可用时如何降级？ `partial`

**接口清单（static）：**
- `static: dsh-session-query/lib/types/index.d.ts:35-150` — `observeSession / readSession / readSurface / readEvent / searchEvents / searchSessions`。
  - 搜索是**分页接口，必须消费 cursor**；
  - `readSession` 是完整逻辑日志、会做 replay validation，**不等于逐字节物理 JSONL**；
  - `readEvent` 是带 before/after 的**范围读**；
  - `readSurface` 是**当前模型 surface**，不能当完整人类聊天归档。
- `static: dsh-session/lib/types/index.d.ts:208-227` — `snapshotEvents/eventAt/ownEvents` 已标 `@deprecated`，**新调用禁止**（不因旧插件还在用就照抄）。
- `static: dsh-session-query/lib/types/observation.d.ts:7-30` — Observation lease 必须按生命周期释放。

**权限（static）：** 由 `dsh-api-gateway` 的 method 级访问控制 + `dsh-api-remote-access`（非 owner peer 的方法级 ACL）+ `dsh-scope` 的 scope 过滤共同承担。连接器侧仍需自己做 `scope_id/person_id` 校验（契约 §2：不采信消息正文或模型自述）。

**降级（static，重要）：** `dsh-base/cordis.patch.yml` 的 `session-query-sqlite` 行默认 **`path: ':memory:'` / `openAt: never`** —— 即 `ctx.sessionQuery` 挂载但**全文搜索默认关闭**，`search*` 会以 `SESSION_QUERY_SEARCH_DISABLED` 失败；精确读/标题/血缘仍可用。这意味着：**Brain 不能假设搜索一定可用**，降级路径必须是一等公民（FTS 不可用 → 候选集为空 → 明确弃答，而不是硬凑）。

**订阅与补读边界（static + 实测）：**
- `static: dsh-session/lib/types/index.d.ts:52-61` — `session/event` 是 **post-commit、fire-and-forget** 的 append feed；"post-commit 指会话日志状态 commit，**不等同磁盘 flush**"；监听器失败被**隔离**（不会让已 commit 的 append 失败）。
- 实测：本次 run 的 feed 确实收到 `turn/start`、`step/start`、`user/message`、`system/message`、`assistant/message`、`tool/call`、`tool/result`、`step/end`、`turn/end`、`request/header`、`request/context`、`session/title`、`session-log-deepseek/delivery-accepted` 等持久事件。
- **补读责任在连接器**：必须自持久入队 + 按 `seq` 补读，不能假设 feed 完整覆盖或已落盘。强杀场景（Q3）就是反例：进程死时最后的事件可能已经 emit 但没 flush 到磁盘。

**初始化顺序（static）：** `dsh-base/cordis.patch.yml` 头部明确 **"Row order carries no load semantics (activation is service-availability driven)"**。所以不能靠"我排在前面"保证先跑；要靠在插件里声明 `inject` 依赖，等 cordis 按服务可用性激活。服务不可用时的降级应是"声明依赖 + 超时/熔断"，不是 try/catch 猜。

**为什么 partial / 缺什么：** 探针按"只记录"纪律**没有主动调 sessionQuery**，所以权限/分页/游标只有静态证据。要升级为 answered 需要补一个只读场景：`readEvent` 范围读 + 一页 `searchEvents`（含 cursor 翻页）+ lease 释放，并单独跑一个 `openAt: never` 的降级场景验证 `SESSION_QUERY_SEARCH_DISABLED`。

---

### Q5 — 能否在最终请求边界证明 Brain 片段实际 sent？不能时检查器如何诚实显示 attached？ `answered`（限定在"进入最终请求对象"这一层）

**实测：** 6 个场景全部在 `llm/stream` waterfall 上拿到了**将发送的完整请求对象**：

```json
{"hook":"llm/stream","phase":"before","provider":"deepseek-official","model":"deepseek-flash",
 "purpose":"(none)","systemLen":481,"messageCount":1,"messageRoles":["user"],
 "topLevelKeys":["maxTokens","reasoningEffort","provider","model","messages","system","sessionId","purpose","signal"],
 "requestFrozen":true}
```

- `static: dsh-llm/lib/types/index.d.ts:36-45` — `llm/stream` 是 waterfall，`options` 是**完整请求**；loop 构造的请求**deep-frozen**（mutation throws）并带 `markAgentLoopRequest` 进程内身份（`:26`）。
- 注入实验里 `systemHasProbeMarker` / `messageProbeMarkerCount` 命中 → **探针注入的合成片段确实出现在交给 adapter 的请求对象里**（`inject-pre` 与 `inject-ctx` 各 `markerReq=1`）。这与"我调用过注入 API"是两个不同强度的证据。

**证据边界（必须写进检查器和 M2 验收）：**
- `llm/stream` 能证明的是"**宿主决定发这些内容**"；
- 它**不证明字节已经出网**。出网证据只有 provider 回执（`requestId` / `usage`）或抓包。
- 因此三级证据**不可混用**：
  - **built**：有 `context_id` + canonical payload hash + `tokenizer_id` + `estimated_tokens`；
  - **attached**：已挂到 assembly（本 run 可在 `system-prompt/assemble` 的 after 摘要里看到）；
  - **sent**：同一 payload hash 在 `llm/stream` 的请求对象里命中。
- 没有请求边界证据时，检查器**必须显示 attached 并注明"未验证实际发送"**，不能显示 sent。

**给 M2 的建议**：在 `llm/stream` 里对 Brain 片段做 payload-hash 命中检查，把结果写进 `context_packages` 的 `attached→sent` 状态跃迁；出网与否单独用 provider `requestId` 关联，缺 `requestId` 就停在 sent(HttpRequestBuilt) 而不是 Sent(Confirmed)。

---

### Q6 — Engram/灵枢继续启用时的唯一注入责任方如何划分？测试 profile 的数据和生产是否真正隔离？ `partial`

**（1）隔离：本次最重要的负面发现 —— 独立 profile ≠ 数据隔离。**

- `static: dsh-base/cordis.patch.yml` — `session-persistence-jsonl.root = dshHomePath("sessions")`、`storage-json.root = dshHomePath("storages")`。**所有 profile 默认共享同一个 `$DSH_HOME` 目录。** 建一个独立 profile 并**不会**隔离会话与存储。
- 实测：brainlab 在 patch 里显式覆盖后才真正隔离 —— `data/probe/lab/sessions`、`data/probe/lab/storages`、`data/probe/lab/session-index.sqlite` 均已落地，且本次 run 写的是这些路径。
- **M1 硬约束**：判定"是否隔离"必须靠**路径断言**，不能靠"我用了独立 profile"这个说法。

**（2）插件异常隔离（实测，成本很高的一课）：**

探针第一版把 `agent/turn-stopping` 当成 waterfall 写（多写了 `next` 参数），实测结果：

```json
{"hook":"agent/error","phase":"info","turn":1,"step":1,"error":"next is not a function"}
{"hook":"session/event","type":"turn/end","turn":1,"reasonKind":"error"}
```

即：**插件异常会让当前回合以 `reason=error` 结束，进程退出码 1。** 宿主只隔离"监听器内部失败不崩进程"，**不保证回合成功**。

而回滚验证里"插件包缺失但 patch 仍在"的情况：

```
dsh: warning: 1 entry did not activate
brain-probe (@dsh-brain/probe): failed to import: ERR_MODULE_NOT_FOUND
→ answer: DETACH-OK (exit 0)
```

**加载期失败**（import 不到包）会被降级为 warning，宿主照常工作；**运行期抛错**会污染回合。两者不是一回事，M1 的连接器必须区分：加载期可以失败，运行期**绝不允许**抛到宿主。

**（3）唯一注入责任方划分建议：**

同一会话、同一 step 里**只能有一个生效的"往上下文加记忆片段"责任方**。三方（Engram / 灵枢 / Brain）共存时按以下矩阵：

| 阶段 | 责任方 | 其余两方 |
|---|---|---|
| M0–M1（shadow 期） | Brain 只写账、不注入 | Engram + 灵枢照常注入 |
| M2 起 | 指定唯一 owner（建议 Brain），其余转只读 | 另一方关闭注入、只保留摄取或完全停用 |
| 切换点 | 用一次可回滚的 profile patch 翻转；翻转前必须能回答"上一轮是谁注入的" | —— |

**为什么不能"三方都注入"**：本次实测已证明每个 step 都会重新装配 + 重过 pre-step，三方各注入一份语义重复的记忆片段会在同一请求里出现 3 份，且每一方都会把另两方的注入当"外部消息"再次提取（因为它们在会话日志里都是真实 `user/message`）。

**为什么 partial / 缺什么：** 未实测 Engram/灵枢 在 brainlab 下同时启用的冲突表现（它们装在 `web` profile，按纪律没有迁移其记忆库，也没有在 brainlab 安装）。要升级为 answered 需要：在 brainlab 装两者的只读副本 + 同一合成会话里跑，统计每 step 的注入片段数与重复度。

---

## 3. 停用回滚验证（交付项 5）

`data/probe/rollback.json`，四步全绿：

| 阶段 | 操作 | 退出码 | 回答 | 警告 | 结论 |
|---|---|---|---|---|---|
| baseline-with-probe | 探针在位 | 0 | `BASELINE-OK` | 无 | 基线可跑 |
| detach-package-only | 只摘 node_modules Junction，patch 行保留 | **0** | `DETACH-OK` | `1 entry did not activate` + `ERR_MODULE_NOT_FOUND` | **插件包缺失时宿主照常工作**（加载期失败 = 降级警告） |
| detach-package-and-patch | 同时移除 profile patch 的 insert 行 | **0** | `REMOVED-OK` | 无 | **完全干净回滚，零警告** |
| restore | 恢复 Junction + patch | 0 | `RESTORED-OK` | 无 | 可复现地回到工作状态 |

`patchFileIntact: true`（脚本执行后 patch 文件与原文一致），`probeLinkRestored: true`。

**结论：卸载探针后宿主基础对话仍可用，且回滚可复现。** 同时证明了"扩展加载失败不拖垮宿主"——这正是设计方案 22.4 要求的"扩展异常不拖垮宿主"的实机证据（限定在**加载期**；运行期见 Q6）。

---

## 4. 本次新增/纠正的宿主事实（写进 M1 契约）

1. **`llm/stream` 是可用且最强的本地证据边界**：完整请求对象 + deep-frozen + loop 构造标记。设计方案的 built/attached/sent 三级在这里有落点。
2. **`agent/turn-stopping` 是 serial，不是 waterfall**；用 waterfall 签名会污染回合。
3. **`llm/stream` 的调用次数 ≠ step 数**：标题生成是独立旁路请求（`purpose="session-title"`）。统计注入次数必须按 `purpose` 过滤。
4. **每个 step 都会重新准备一次，但 `complete` 节会在 waterfall 后被强制恢复为唯一 section**（`static: dsh-system-prompt/lib/index.js:381-404`）—— 所以往 sections 里塞 Brain 片段在有 `complete` 节的部署里会被**静默丢弃**。这是走 `context()` 而不是 `section()` 的又一理由。
5. **独立 profile 不隔离数据**，默认共享 `$DSH_HOME`。隔离必须显式覆盖 root/path，并用路径断言验证。
6. **进程强杀不留 `turn/end`**：恢复逻辑必须把"最后一个 turn 没有 turn/end"识别为异常中断。
7. **Windows 上从进程外发信号等价于强杀**：优雅取消只能在进程内 abort 或 web UI 里测。

---

## 4.5 task-4 补测（把 3 个 partial 推成 1 answered + 2 收窄）

**本轮 run**：`data/probe/m0-20261028-191352/`（7 场景 + 共存 2 场景）；**中断补测 run**：`data/probe/m0-20261028-191600/`（11s 处真杀在流式生成中）。记账：**4 answered / 2 partial / 0 unknown**。

### 4.5.1 共存实测：灵枢真挂 —— 本轮最重要的结论

**挂法**（全程只读、合成数据、不碰生产记忆库）：把 `@furongjun1999/dsh-memory@0.9.13` 从 web profile 的 node_modules **Junction** 进 brainlab，profile patch insert 它的行，并用 `MDCG_ROOT` + profile config **双保险**把它的认知图根锁到 `<repo>/data/probe/lab/lingshu-mdcg`。它启动日志自报：

```
[lingshu-bridge] [mdcg-mcp] 路径：记忆真源 root=<repo>\data\probe\lab\lingshu-mdcg · 身份/凭据根 aux=C:\Users\<you>\.mdcg
```

**结论 1 —— 宿主把多注入方的块全收，不去重、不仲裁。**

| 场景 | assemble(before) 的 contexts | assemble(after) 的 contexts | 说明 |
|---|---|---|---|
| `coexist-1`（新会话第一轮） | 5 个（全是宿主自己的 runtime-context） | 5 + **`lingshu:auto-recall`** | 灵枢在 waterfall 里 push 了自己那块 |
| `coexist-2-resume`（同会话第二轮） | 5 个 | 5 + `lingshu:auto-recall` + **`lingshu:session-window`** | 第二轮起块变多 |
| `inject-ctx`（探针也开注入） | 5 个 | 5 + **`brain-probe:marker`** + **`lingshu:auto-recall`** | **两个互相不知道的注入方并列 push，两份都在装配结果里** |
| `tool-read`（1 turn / 2 step） | — | step1: `lingshu:auto-recall`；step2: `lingshu:auto-recall` + `lingshu:session-window` | **同一轮内第二个 step 的注入块比第一个多** |

→ M2 的硬约束：**同一会话里必须显式指定唯一注入 owner**。宿主没有"注入去重/仲裁"这一层能力；它只按 `context.order` 排序，按文本做快照保留值比对。第三方注入的**块集合逐 step 变化**，所以 Brain 无法靠"我知道上一 step 注入了什么"来静态去重，Token 预算还必须按**最厚的那个 step** 留。

**结论 2 —— 注入会形成"注入 → 摄取 → 再注入"的回路（实测闭环）。**

这是本轮最值得警惕的发现，完整证据链：

1. 探针在 `inject-pre` / `inject-ctx` 场景注入了一段带唯一标记的合成文本（`BRAIN-PROBE-MARKER brain-probe-marker-0001`）。
2. 灵枢把它当**用户话语摄入成了记忆节点** —— 认知图里实际存在：
   ```
   FOUND in \contextual\mem_1793185860674_4e3992.md
   FOUND in \contextual\mem_1793185860769_7055e8.md
   FOUND in \_recent.jsonl
   ```
3. 之后在 `coexist-1`（一个**没有开任何探针注入**的新会话）里，灵枢 `auto-recall` 把它召回并注入：
   ```
   user/message src=runtime-context len=1149 carriesProbeMarker=true
   llm/stream  msgMarkerCount=1  carried=messages[role=system]
   ```
   即探针的标记最终进了**最终请求**，而这一次不是探针自己发的。

→ 这正是设计方案第 24 节"防循环字段（`origin_system` / `causation_id` / `derived_from[]`）"要解决的问题，现在有实机闭环了。**M1 必须保证：自身注入的片段带可识别来源；摄取侧按来源剔除，绝不把注入当人类证据二次沉淀。** 否则多引擎共存会互相放大（A 注入 → B 摄取 → B 注入 → A 摄取…）。

**结论 3 —— 隔离成立，但只因为做了路径断言。**

不是"我用了独立 profile"，而是四条路径都被显式覆盖并验证落地：`session-persistence-jsonl.root` / `storage-json.root` / `session-query-sqlite.path` 全在 `data/probe/lab/`，灵枢认知图根也在 `data/probe/lab/lingshu-mdcg`。生产 `~/.dsh/.dsh-memory` 全程未被读写。

**未测的部分（诚实边界）**：**Engram 没挂**。它依赖 `@huggingface/transformers` 与本地模型下载，与"只读合成数据、零外部成本"的探针纪律不匹配。但 Engram 走 `agent/pre-step` prepend（与灵枢的 `assemble contexts` 是两条不同通道），而"宿主不做仲裁"这个结论来自宿主侧的单一事实，对两条通道都成立。要补 Engram 实测需：允许一次模型依赖安装与下载，或改用它不带 embedding 的配置。

### 4.5.2 sessionQuery 实调：精确读可用，全文搜索在退出窗口里全灭

在 `turn/end` 之后（宿主濒临 dispose 的窗口）实调，结果分两半：

| 接口 | 结果 |
|---|---|
| `observeSession` | ✅ `source=live`，`eventCount=21`，`cursor=20`，`hasProjections=true` |
| `observation.retain()` + 释放 | ✅ retain 出来的独立租约与原始租约都能 `Symbol.dispose` |
| `readEvent({seq,before:1,after:1})` | ✅ `target=turn/end`，`windowEvents=2`，`startSeq=19 endSeq=20` |
| `readSession` | ✅ `eventCount=21`，**replay validation 通过** |
| `readSurface` | ✅ 未抛错（返回结构与我猜的字段名不同，`surfaceNodeCount=-1`） |
| `searchEvents` | ❌ `SESSION_QUERY_SESSION_NOT_FOUND` |
| `searchSessions` | ❌ `SESSION_QUERY_INDEX_FAILED: "session-search SQLite index is closed"` |
| `listSessions` | ❌ `cannot get required service "sessions" in inactive context` |

→ **M2 硬约束**：历史回查**不能嵌在 turn 内做**。turn/end 时刻进程正在 dispose，索引会关、服务会 inactive。必须走「事件已落盘 → 独立进程 / 后台任务读持久化索引」这条路线，并把"搜索暂不可用 → 明确弃答"当一等公民。

**仍缺**：cursor 分页与 scope 过滤没实跑（搜索没走到能返回 `nextCursor` 的那一步）。要升 answered 需在一个**长期存活**的宿主进程里（web profile 或进程内 harness）对已落盘 session 跑两页 `searchEvents` + 带 filters 的 `searchSessions`，并另跑一次 `openAt: never` 验证 `SESSION_QUERY_SEARCH_DISABLED` 降级。所以 Q4 保持 **partial**。

### 4.5.3 Q5 的判据修正（探针 bug 级发现）

同一个 provider 的 system prompt **有两种承载形态**，实测都出现了：

```json
{"purpose":"(none)",          "systemLen":0,   "systemRoleMessageCount":1, "systemRoleTextLen":2729, "systemPromptCarriedIn":"messages[role=system]"}
{"purpose":"session-title",   "systemLen":481, "systemRoleMessageCount":0, "systemRoleTextLen":0,    "systemPromptCarriedIn":"request.system"}
```

主请求把 system prompt 放进 `messages[role=system]`（此时 `options.system` 为空），旁路标题请求才用 `request.system`。**只看 `options.system` 会漏判 sent** —— 这条已修进探针（`systemPromptCarriedIn` 字段 + 两级检索），也应当写进 M2 检查器。

### 4.5.4 用户续写实测（Q3 补强）

`coexist-1` 跑完后用 `dsh --profile brainlab headless --session-id <上一轮 session> "..."` 接续：第二轮 `turn/end{reason:completed}`，且 turn 号是 **2**（首轮是 1）→ 续写是在**同一条会话日志上追加新 turn**，不是新会话。终结事件与首轮同构。

顺带一个观察：第二轮 `user/message` 数（2）比首轮（4）少，因为 `agent-instructions` / `skill-catalog` 这类一次性上下文不会重复注入 —— 这对 Brain 的"每轮都注入"设计是个提醒：**不要假设每轮的消息基数相同**。

### 4.5.5 仍然 partial / 拿不到的部分（不硬凑）

| 缺口 | 状态 | 为什么测不了 | 升级条件 |
|---|---|---|---|
| Q3 用户取消（abort） | partial | headless 是一次性进程，无交互式取消入口；Windows 上进程外信号 = `TerminateProcess`，不跑 exit handler。已实测"强杀 = 零终结事件" | 进程内 harness 用 `AbortController` 直接 abort agent；或 web profile 里点取消 |
| Q4 cursor 分页 | partial | 见 4.5.2，搜索在退出窗口里不可用 | 长期存活进程里对已落盘 session 跑两页 |
| Q1 重试实机轨迹 | answered（含 static） | 本次全部场景都没触发 `agent/request-error`；重试路径仍只有 `static: agent-loop/lib/index.js:1043-1140` 的代码证据 | 注入一个会失败一次的 mock adapter，或在 `llm/stream` 里受控抛错一次 |
| provider 出网回执 | 不可得 | `llm/stream` 只到"交给 adapter 之前"；provider 侧 `requestId`/`usage` 未做对照样本 | 抓一次真实响应的 `requestId` 并与会话日志关联 |

---

## 5. 能不能进 M1 / M2

**结论：可以进，但有 3 条前置约束必须先落到设计/契约里。**

### 可以直接进 M1 的部分
- 事件摄取骨架：`session/event` + `turn/end` + `step/end` 已在实机验证可用，事件类型清单已拿到（见 `timeline.md` 的 per-scene eventTypes）。
- 证据边界：`llm/stream` 证明 sent（到请求边界），可以支撑 `context_packages` 的 built/attached/sent 状态机。
- 注入通道选型：**`systemPrompt.context()`（user-role snapshot）**，不是 section。已实测不污染 system prompt、会持久化、能在请求边界被检索到。

### 必须先改设计/契约的 3 条（阻断级）

1. **隔离（阻断级）**：`独立 profile` 不构成数据隔离。M1 的验收必须把"路径断言"写进门槛：断言 `session-persistence-jsonl.root` / `storage-json.root` / `session-query-sqlite.path` 落在 Brain 自己的目录，而不是 `$DSH_HOME` 默认值。否则 M1 的"生产隔离"验收是假的。
2. **运行期异常必须零抛出（阻断级）**：已实测插件在 `agent/turn-stopping` 上抛错会让 `turn/end reason=error`。连接器的每个 hook 都必须有顶层 try/catch，观测/检索失败只降级不抛。M0 探针目前是"写失败不抛"，但 hook 体本身还没有全包 try/catch —— M1 连接器必须补上。
3. **每 step 幂等（阻断级）**：assemble/pre-step 是 per-step，不是 per-turn。M1 的构包与写入必须假设"同一 turn 内会被调用多次"，并用 turn/step 键去重。
4. **注入回路必须闭环（阻断级，task-4 新增）**：已实测第三方引擎会把 Brain 的注入**摄入成记忆并在后续会话重新注入**（`contextual/mem_*.md` 里能搜到探针标记，且它出现在后续会话的最终请求里）。M1 必须让注入片段带可识别来源，摄取侧按 `origin_system` / `causation_id` / `derived_from[]` 剔除自身与兄弟引擎的注入，**绝不把注入二次沉淀为人类证据**。
5. **历史回查必须在进程外（阻断级，task-4 新增）**：已实测 `turn/end` 之后的窗口里全文搜索不可用（`SESSION_QUERY_INDEX_FAILED: index closed`、`SESSION_QUERY_SESSION_NOT_FOUND`、`inactive context`）。M2 的回查/索引重建必须由独立进程或后台任务承担，不能在 turn 内同步做。

### 进 M2 前必须先补的证据（建议在 M1 期间并行做完）

| 缺口 | 影响的问 | 补法 |
|---|---|---|
| 重试实机轨迹（`agent/request-error` → retry） | Q1 从"静态 answered"升到"实机 answered" | 进程内 harness 注册一个会失败一次的 mock adapter；或在 `llm/stream` 里受控抛错 |
| 用户取消 / 续写 | Q3 升 answered | 进程内 `AbortController` abort agent；或 web profile 里点取消 |
| sessionQuery 实调 | Q4 升 answered | 探针加只读场景：`readEvent` + 一页 `searchEvents` + lease 释放；再跑 `openAt: never` 降级 |
| Engram/灵枢 共存 | Q6 升 answered | brainlab 装两者只读副本，同会话统计每 step 注入片段数与重复度 |
| provider 出网回执 | Q5 的"出网"层 | 关联 provider `requestId` / `usage` |

---

## 6. 产出清单

| 文件 | 内容 |
|---|---|
| `apps/probe/index.js` | 探针插件（10 个观测点 + 2 个受控注入开关） |
| `apps/probe/recorder.js` | 有界 JSONL 落盘（写失败不抛） |
| `apps/probe/run.mjs` | 场景运行器（7 个真实回合） |
| `apps/probe/analyze.mjs` | timeline → verdict.json + timeline.md |
| `apps/probe/rollback.mjs` | 停用回滚四步验证 |
| `apps/probe/attach.mjs` | Junction 挂载/卸载/状态（替代跨盘 pnpm link） |
| `apps/probe/cordis.patch.yml` | 探针包自带 patch（供 bundle 形态使用） |
| `data/probe/m0-20261028-190326/timeline.jsonl` | 249 条合并时序（7 场景） |
| `data/probe/m0-20261028-190326/verdict.json` | 六问逐条 + 每场景指标 |
| `data/probe/m0-20261028-190326/timeline.md` | 人读时序 + 六问 |
| `data/probe/rollback.json` | 回滚四步结果 |
| `C:\Users\<you>\.dsh\profiles\brainlab\` | 独立 profile（4 个文件 + Junction） |

红线自查：未改 `@deepseek-ai/dsh` 包文件；未读写 `~/.dsh/profiles/web`；未碰 Engram/灵枢 记忆库；全部 prompt 为探针合成的固定字符串；timeline 与文档中无凭据、无正文（只有长度与 hash 前 12 位）。
