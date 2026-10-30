# @dsh-brain/connector — M2 连接器

> DSH 外置大脑的 cordis 插件：挂真实装配点，只注入带来源标记的上下文，
> 并证明它到没到最终请求。依据 `docs/M2-INTERFACES.md` §3 + `docs/CONTRACTS.md` §10。

## 一句话

**只算不注入是默认状态。** `shadow` 模式下它挂满五个钩子、算清每一步该注入什么、
把证据写进队列，但**一个字节都不改宿主的装配结果**。要真注入得显式切 `explicit` / `automatic`。

## 挂载

```yaml
# 你的 profile cordis.patch.yml
- insert:
    - id: brain-connector
      name: '@dsh-brain/connector'
      config:
        mode: shadow
        dir: '<repo>/data/events'
```

包内自带 `cordis.patch.yml`，支持 `dsh.bundle.patch` 形态安装。

## 五个钩子

| 钩子 | 分发模式 | 我们做什么 | 关键纪律 |
|---|---|---|---|
| `system-prompt/assemble` | waterfall | `await next()` 后**复制** assembly，把 Brain 片段当 `PromptContext` 追加到 `contexts` | 不改宿主数组；不注册 `complete:true`；`interpolate:false` |
| `agent/pre-step` | waterfall | `await next()`，decision 带 messages 时复制后追加（备用通道） | `kind:'reject'` 原样透传；保留 decision 其它字段 |
| `llm/stream` | waterfall | **只观测**：抓最终请求对象做 sent 判据 | `next()` 返回 AsyncIterable，绝不 await 包装 |
| `session/event` | emit 监听 | 摄取到有界持久队列（按 `sessionId#seq` 幂等） | 写失败不抛；正文有上限 |
| `agent/turn-stopping` | **serial** | 回合收尾控制点，只记候选快照 | **没有 next**；不是 waterfall；不当「已结束」 |

## 实测出来的形状差异（M2 期间踩到的，写代码前必看）

前六条来自宿主源码 + 本机实测，第七、八条是本连接器自己验证的。

1. **`agent/turn-stopping` 是 serial，不是 waterfall。** 多写一个 `next` 参数并 `await next()`
   会让那一轮 `turn/end reason=error` + 进程退出码 1（M0 事故原样复现过）。
2. **`agent` 是运行时字段，类型声明里没有。** 宿主的 `assembleContextFor(agent, signal)`
   返回 `{agent, scope: agent, signal}`；`agentEvents` 的 `fused` 又把 `agent` 注进每个
   agent 事件 payload。**这是拿 `sessionId` 的唯一途径**（`agent.session.id`），
   所以一律「有就读、没有就失败关闭」，并在缺键时不注入。
3. **`agent.phase.step` 在 assemble 阶段是「上一个 step」。** `phase.step = step` 发生在
   `preStep()` 返回之后；`turn()` 里 `phase.turn` 则在 `preStep` 之前赋值。
   所以 assemble 里当前 step = `phase.step + 1`，pre-step 里必须用 `payload.step`。
   冒烟实证：3 个 step 的 assemble 与 pre-step **解析出完全相同的幂等键**。
4. **`llm/stream` 的 `next()` 返回 `AsyncIterable<StreamChunk>`，不是 Promise。**
   任何 `await next()` 之后再包一层的写法都会把流变成 Promise，直接破坏宿主。
5. **cordis waterfall 是同步组合、不 await 展开。** `next()` 返回下游 listener 的原始返回值
   （可能是 Promise），最外层由宿主 await。所以 listener 自己 async 是可以的，但不要
   指望中间层拿到已解包的值。
6. **`contexts` 文本会被插值，遇到未注册变量直接抛。**
   `static: dsh-system-prompt/lib/index.js` 的 `interpolate()` 对 `{{name}}` 做严格校验，
   未知变量名抛错。注入的是记忆正文，可能含 `{{...}}` 甚至模板代码 ——
   所以 `PromptContext` 必须带 **`interpolate: false`**。
7. **`refreshContext` 会保留 waterfall 追加的 contexts。** 源码注释明确：
   「Contexts added only by the assembly waterfall retain their accepted values.」
   所以追加是安全的；但注意 `assemble()` 末尾在 runtime-context 被抑制时只保留
   `required` contexts —— 我们的块不是 required，会被**静默剔除**（不报错）。
8. **兄弟引擎的注入 `source.kind` 可能是 `'user'`。** M0 探针就是这么写的，很脏。
   所以摄取侧**不能只靠结构判据**，文本指纹那一层不可省。

## 七条硬纪律的落点

| # | 纪律 | 代码位置 |
|---|---|---|
| 1 | 运行期零抛出 | 每个 hook 顶层 try/catch（`handle*` 内部）；`next()` 的错误**原样透传**；最外层 `guard` 只兜漏网错误 |
| 2 | 按 step 幂等 | `state.js#resolveStepKey` + `StepLedger`；不完整键直接失败关闭 |
| 3 | 注入带来源 | `origin.js#formatOriginTag`，注入文本第一行；摄取侧 `classifyUserFrame` |
| 4 | 不注册 `complete:true` | 只用 waterfall，不调用 `systemPrompt.section()` |
| 5 | 不改宿主数组 | 一律 `{...source, contexts: [...原, 新]}` |
| 6 | sent 查两级承载 | `probe-sent.js#checkSent`：`request.system` / `messages[role=system]` / `messages[other]` |
| 7 | 请求计数剔除旁路 | `isMainRequest()` 按 `purpose` 剔 `session-title` |

## 四种模式

| 模式 | 行为 |
|---|---|
| `off` | 一个 hook 都不注册 |
| `shadow`（默认） | 挂满钩子、算出「本来会注入什么」（`estimatedTokens` 等指标），**绝不改宿主对象**；有 `buildPackage` 也会调（灰度对比用，代价是每 step 多一次构包） |
| `explicit` | 只注入别人 `runtime.supply(pkg, {sessionId, turn, step})` 递进来的包（一次性消费） |
| `automatic` | 用配置的 `buildPackage()` 自动构包；带 800ms 超时，超时即弃答 |

## 队列

`data/events/dsh-events.jsonl`（+ 轮转分片）。三道上限：内存缓冲行数、单分片字节、分片数。
写失败不抛，只降级并计数；不可序列化的记录计 `dropped`。
每条信封按 `CONTRACTS.md` §2：`source_system / source_event_id / scope_id / person_id /
session_id / turn_id / step_id / source_seq / occurred_at / origin_system / payload_hash /
payload_text / privacy`，另有连接器自己的 `ingest_class`
（`human / self_injected / sibling_injected / context_snapshot / tool-output / not-a-message`）。
**消费端必须按 `ingest_class` 过滤，只有 `human` 进人类证据通道**（契约 10.6 的闭环就靠这条）。

## 证据链

```
built    ← context2 的 build()（本插件不构包）
attached ← 本插件把包挂进 assembly/decision（队列记 context_attached）
sent     ← llm/stream 里按 canonicalHash / contextId 在请求对象中命中（队列记 context_sent）
```

`context_sent` 记录里固定写 `evidence_level: 'sent:request-object'` 和
`proves_wire_delivery: false` —— 这层证据只到「宿主决定发这些内容」，**不证明字节出网**（契约 10.4）。

### attached / sent 两级落库（`evidence.js`）

只有连接器在回合边界拿得到 `(turn, step)` 与最终请求对象，所以这两级归它推进：

```js
store.contextPackages.updateStatus(contextId, {
  status: 'attached' | 'sent',
  carrier,                                   // 实际观测到的承载位置
  evidence: { evidence_level, proves_wire_delivery: false, observed_hash_locations, ... }
})
```

四条实现纪律：

1. **可选注入**：`store.contextPackages.updateStatus` 不在 / 不是函数 → 跳过（`facade` 报
   `absent` / `no_update_status`），不报错。
2. **绝不影响宿主**：落库是旁路（fire-and-forget，`runtime.flushEvidence()` 只给测试/冒烟等）。
   任何失败只回 `{ status: 'failed', reason }` 并记日志，**不许向上抛**（契约 10.2）。
3. **`proves_wire_delivery` 恒 `false`**：请求对象里找得到 ≠ 字节出网。
4. **carrier 用实测值**：`probe-sent` 的三级命中位置 → 真实承载，绝不填声明值。

#### carrier 词表比契约多一个值

契约（CONTRACTS 10.9 / M2-INTERFACES §2）的 carrier 是 `system` / `messages[role=system]`
两级 —— 那是 **system prompt** 的两种承载。但 M0 实测（`M0-probe-report.md` §2 Q2）：
Brain 的两个注入通道（`assembly.contexts` → durable user-role snapshot；`agent/pre-step` 追加）
**都落在 user 角色消息**里。所以这里定义第三值 `messages[user]`，并已与 memory2 的
`contextPackages.CARRIERS` 对齐。不写第三值就会把 user 消息里的注入谎报成 system 承载。

### 主账与构包怎么接上

`config.storePath` + `config.memoryModule` + `config.contextModule` 三个可选键就能让连接器
自己 `openBrain()` 并调 `context.build()`（惰性、失败只 warning）：

```yaml
config:
  mode: automatic
  storePath: 'E:/.../brain.db'
  migrationsDir: '<repo>/migrations'
  memoryModule: 'file:///<repo>/packages/memory/src/index.js'
  contextModule: 'file:///<repo>/packages/context/src/index.js'
  budget: { modelWindow: 128000, hostInputTokens: 4000, outputReserve: 2000, brainCap: 2048 }
```

## 真机时序的两个坑（e2e 实测）

1. **第一个 step 的 `assemble` 早于 `user/message` commit**（宿主 `turn()` → `preStep()` → `step()`）。
   所以 contexts 通道在**首步拿不到 query**，构出来必然是不相关空包 —— 已加短路：query 为空不构包、
   只记 `auto-build.skip`。想让首个 step 也注入，就得走 **`injectChannel: 'pre-step'`**
   （它的 `payload.messages` 里已经带上了本轮 claim 到的消息）。
2. **检索阈值很挑**：覆盖率 < 0.34 会判 `insufficient_evidence`，构包侧如实降级成空包（不注入）。
   这是正确行为（契约 §7「不拿相似结果硬凑」），但做 e2e 语料时要注意问句长度。

## 测试、冒烟与端到端

```powershell
# 单元测试（假宿主：waterfall / serial / emit 语义 + 真实 payload 形状）
node --test "tests/m2/connector/*.test.mjs"

# 冒烟（shadow，证明「挂得上、不干扰」）：零注入、零抛错、幂等键对齐
node apps/connector/smoke.mjs

# 真机端到端（automatic + 真主账 + 真 build + 真实回合）
node apps/connector/e2e.mjs
```

`e2e.mjs` 验十一项：真构包、注入进最终请求（三级承载）、**同一 turn 多 step 各注入一次且包互不相同**、
零抛错、宿主照常回答、`updateStatus` 真写进主账（attached/sent 两级 + carrier 实测值 +
`proves_wire_delivery=false`）。它跑四个场景：单步 / 两步工具回合 / 同会话第二轮 /
pre-step 通道两步回合（最后一个专门用来拿「多 step 都注入」的正向证据）。

两个脚本都只碰 `~/.dsh/profiles/brainlab`，patch 按**原文**备份、跑完 byte 级写回；
不读写 `~/.dsh/profiles/web`，会话仍走 brainlab 已重定向的 `data/probe/lab/`。

## 已知边界

- 拿不到 `(sessionId, turn, step)` 时**不注入**（宁可不重复注入也不猜），只记 `skippedIncompleteKey`。
- 同一 step 只占一条注入通道（`injectChannel`），从设计上排除「assemble + pre-step 双注入」。
- contexts 通道**首步无 query**（见上文时序坑 1）→ 首步不注入是预期行为，不是故障。
- e2e 里观察到：pre-step 通道注入的包有部分在 `llm/stream` 里**未命中**（停在 attached 而没有
  谎报 sent）。判据本身是三级都查的，未命中就如实停在 attached；具体是宿主把 pre-step 追加的
  消息在请求视图里替换/裁剪，还是时序问题，留待 M3 用会话日志复读确认。
- 队列是 at-least-once 语义：进程被强杀时尾部可能丢（与 M0 观察一致），消费端必须幂等。
- 出网证据不在这里：要 `provider requestId` / `usage` 才算 Sent(Confirmed)。
