# 系统 5：自主指令与运行控制（`packages/directives`）

> 一句话：**把"我想做点什么"变成一个有人批过、有预算、有租约、随时能停、停了能查的指令对象。**
>
> 这份文档回答四件事：为什么这么设计、**这个调度器能做什么、绝不能做什么**、怎么关掉、怎么验证。
> 不逐条复述代码（代码里每个文件头都有"为什么"）。

---

## 1. 全链位置

```
反思/默认模式网络（系统 3）  主人手建 / 控制台
        │  workspace.propose({kind:'directive'})      │ create()
        ▼                                             ▼
   ┌───────────────────────────────────────────────────────┐
   │  autonomy.drainCandidates()     directives.create()   │  ← 都只写 status='proposed'
   └───────────────────────┬───────────────────────────────┘
                           ▼  必须有人批（approve）
                     awaiting_approval → queued
                           ▼  runOnce()（宿主定时调用）
   ┌───────────────────────────────────────────────────────┐
   │ 闸门 → 回收 → 认领（租约）→ 逐动作执行 → 收尾（审计） │
   │  每个动作都只能来自内置白名单，且必须注入 hook        │
   └───────────────────────┬───────────────────────────────┘
                           ▼
        directive_runs / directive_steps / audit_logs / ws_events
```

---

## 2. 为什么这么设计（五条不商量的决定）

### 2.1 不做"任意命令执行"，一个都不做

**白名单外的一切动作结果都是 `{allowed:false, reason:'action_not_in_whitelist'}`**，包括
`shell` / `exec` / `write_file` / `delete_file` / `http_request` / `send_message` / `install`。

理由不是"还没做"，而是三条：**等级只能约束"谁被允许"，约束不了"允许之后干了什么"**；
**可回滚是白名单的前提**（表里每个动作都写了 rollback，任意命令写不出这句话）；
**审计只有在动作名能唯一确定行为时才有意义**。

要加动作必须改 `permissions.js` 的 `ACTION_TABLE` + 补测试 + 写清可回滚性，**不能配置出来**。

### 2.2 等级提升不增加动作

- L3 的 `allows` 是**空数组**：它只放宽"有效期与次数"，动作集合与 L2 完全一致。
- 白名单里没有任何 `minLevel: 'L3'` 的动作（有测试钉住）。
- 有效等级 = `min(指令自报 permission_scope, autonomy.max_level)`。
  把开关从 L3 调到 L1，所有 L2/L3 指令**立刻跑不动**，不需要改指令本身。

### 2.3 反扩权：子指令不能"生个孩子"拿到父指令没有的权限

`assertNoEscalation({parent, child})` 逐项检查：等级不高于父、三项预算不超父、
动作集合不超父集合。违规**抛 `PermissionEscalationError`**（不自动下调——自动下调会让越界意图静默通过）。
父没声明某维度、子却声明了，也拒（失败关）。

### 2.4 停止条件只能加严，不能放松

`stop_conditions_json` 是列，但**下面五条无论 JSON 写什么都生效**（`MANDATORY_STOP_CONDITIONS`）：
`owner_interrupted` / `missing_required_permission` / `budget_exhausted` / `time_exhausted` / `valid_until_passed`。
否则"把预算停止条件删掉"就等于"无限跑"。

### 2.5 重启安全用租约，不用"重启后清理一下"

- 认领时写 `lease_until = now + leaseMs`（默认 60s，下限 1s / 上限 24h）；
- 每写一步都续租；租约内**第二个 owner 抢不到**（状态 CAS + 租约双保险）；
- 回收只收 `status='running' AND lease_until <= now` 的 run，标 `timeout`，
  指令回 `queued`（还有重试额度）或 `blocked`（额度用尽）；
- 每次写库前复检 `lease_owner = 我 AND lease_until > now`，不满足就**放弃写入**——
  宁可少一条流水，也不许两个 owner 同时写同一条 run。

---

## 3. 权威安全边界：**能做什么 / 绝不能做什么**

### 能做的（穷举）

1. 存一条指令对象：标题、理由、触发、优先级、前置条件、动作白名单、等级、三项预算、重试上限、失效时间、停止条件、幂等键。
2. 状态机：11 条合法边（见下方），每次转移写一条 `audit_logs(action='directive.transition')`。
3. 挑"现在可以跑"的指令：`queued` + 未过期 + 前置条件满足 + 等级够，按 `priority DESC, created_at ASC`。
4. 执行**六个内置动作**中的、指令声明过的、等级够的那些：
   `memory_maintenance` / `index_rebuild` / `alert_sweep` / `backup_verify`（L1）、
   `reflection_run` / `skill_rebuild`（L2）。
   每个动作只做一件事：**调用宿主注入的 hook**。
5. 记账：`directive_steps`（plan / tool / error / stop 四类摘要）、步数与 token 用量、耗时、停止原因。
6. 回收：僵尸 run 标 timeout、过期指令作废成 `cancelled`。
7. 把内部候选转成指令：**等级硬上限 L1、动作只留 L1、状态 `awaiting_approval`（必须人批）**。
8. 预演：`plan()` / `autonomy.previewCandidates()` / `dry-run.js` —— 只读，**零写入**。

### 绝不能做的（穷举）

| 绝不做 | 由什么保证 |
|---|---|
| 执行任意命令 / 脚本 / 子进程 | 包里没有 `child_process`；动作名不在白名单 → `action_not_in_whitelist` |
| 写文件 / 删文件 | 包里没有 `fs.write*` / `unlink`；`dry-run.js` 只 `existsSync` |
| 发网络请求 / 外发消息 | 包里没有 `fetch` / `http`；没有 `send_message` 类动作 |
| 动态 `import()` / `eval` / `new Function` | 无此调用（grep 可验） |
| 调外部工具 / 插件 / MCP | 动作执行器只认 `hooks` 里注入的六个函数名 |
| 在 hook 缺失时假装成功 | 返回 `{ok:false, reason:'hook_missing'}` + 告警 + 指令进 `blocked` |
| 暂停 / 自主关闭时动手 | 闸门在**任何写入之前**；暂停期间连回收、连审计都不写 |
| 自己批准自己 / 自己提高等级 / 自己放宽预算 | 内部指令硬上限 L1 且必须人批；守卫在 `create()` 与 `permissions.js` |
| 越过 scope | 所有 SQL 带 `scope_id`；跨 scope 一律 `NOT_FOUND`（不区分"不存在"和"不是你的"） |
| 悄悄改状态 | 每次迁移一定写审计；非法迁移抛错（含"原地转自己"） |
| 复活已完成的指令 | 终态出边为空；重做必须新建指令（新幂等键） |
| 无限重试 | `max_retries`（≤10）+ 步数/token/时间三项预算，任一超即停 |

### 状态机（16 条边，写死在 `state-machine.js`）

```
proposed          → awaiting_approval | queued | cancelled
awaiting_approval → queued | blocked | cancelled
queued            → running | cancelled | paused
running           → paused | blocked | completed | failed | cancelled
paused            → queued | cancelled
blocked           → queued | awaiting_approval | cancelled
completed / failed / cancelled → （终态，无出边）
```

**没有 `running → queued`**：重试必须先经过 `blocked`（两条审计），这样每一次"再试一次"都看得见。

### 停止语义

| 停止原因 | run 终态 | 指令去向 | 可重试 |
|---|---|---|---|
| `goal_completed` | completed | completed | — |
| `owner_interrupted`（暂停 / 自主关闭） | cancelled | **paused** | — |
| `missing_required_permission` | blocked | blocked | — |
| `budget_exhausted` / `time_exhausted` | blocked / timeout | blocked | — |
| `valid_until_passed` | failed | failed（过期指令在 `runOnce` 开头作废成 `cancelled`） | — |
| `hook_missing` | blocked | blocked | — |
| `action_failed` | failed | queued（额度内）→ failed（额度用尽） | ✔ |
| `step_cap_reached` | cancelled | queued | ✔ |
| `lease_expired`（回收） | timeout | queued（额度内）→ blocked（用尽） | ✔ |

---

## 3.5 公开 API（`createDirectives({db,queue,clock,alert,workspace,bindings,hooks,leaseMs})`）

| 入口 | 说明 |
|---|---|
| `create(input)` | 建指令（幂等；`idempotencyKey` 必填；新指令一律 `proposed`） |
| `get(id)` / `list(query)` / `stats()` | 读（跨 scope 一律 null / 空） |
| `approve(id)` / `pause(id)` / `resume(id)` / `cancel(id)` | 状态操作（重复调用宽容，非法状态抛错） |
| `nextEligible({limit,now,maxLevel})` | 只读：现在能跑哪些、剩下的为什么不能跑 |
| `scheduler.runOnce({owner,maxSteps,now})` | 跑一轮（宿主唯一定时入口） |
| `scheduler.plan({limit,now})` | 只读预演（dry-run 引擎） |
| `scheduler.recoverStaleRuns({now})` | 回收租约过期的僵尸 run（别名 `reclaim` / `recoverOrphans`） |
| `scheduler.expireStaleDirectives({now})` | 把过期指令作废成 `cancelled` |
| `scheduler.heartbeat({runId,owner})` | 长任务续租 |
| `stateMachine.transition({id,to,reason,by})` / `history({id})` | 状态迁移 / 变更历史（读审计） |
| `actions.run({name,ctx})` / `actions.get(name)` / `actions.list()` | 六个内置动作（`get` 返回 `{name,level,run({ctx,directive,run})}`） |
| `autonomy.drainCandidates({limit})` / `previewCandidates({limit})` | 内部候选 → 指令（`preview` 零写入） |
| `permissions.*` | 纯函数：`canExecute` / `assertNoEscalation` / `effectiveLevel` / 静态矩阵 |
| `plan()` / `readGate()` / `describe()` | 预演 / 闸门读数 / 能力自述 |

---

## 4. 怎么关掉（三层，任一层都能停）

| 动作 | 效果 | 代价 |
|---|---|---|
| `workspace.setSwitch('paused', '1')` | **立即停手**：`runOnce` 返回 `{skipped:true, reason:'global_paused'}`，零写入；正在执行的指令在**下一个动作之前**停 | 可恢复（`paused→queued`） |
| `workspace.setSwitch('autonomy.enabled', '0')` | 同上，但只影响自主指令 | 可恢复 |
| `workspace.setSwitch('autonomy.max_level', 'L0')` | 所有需要动作的指令都跑不动（L0 只能回复） | 可恢复 |
| `directives.cancel(id)` | 该指令进终态 `cancelled`，不可复活 | 终态 |
| 不传 `hooks` | 所有动作 `hook_missing` → blocked | 上线前就该这样 |

默认姿态（迁移 0008 写死）：`autonomy.enabled='0'`、`autonomy.max_level='L1'`、`paused='0'`。
三者任一不满足就零动作——**这是默认值，不是建议**。

---

## 5. 接线（lead 要做的事）

```js
// packages/memory/src/index.js（只有 lead 能改）
import { createDirectives } from '../directives/src/index.js';   // 或包名 @dsh-brain/directives

const directives = createDirectives({
  db, queue, clock, alert,
  workspace,                 // lead 的 packages/workspace 实例
  bindings: { scope_id: 'owner-default', person_id: 'owner' },
  hooks: {                   // 六个都可选；不接的那个动作会 hook_missing（不会假成功）
    // 方法名已核对过 memory 包的公开面：
    memoryMaintenance: () => memories.reindexAll(),
    indexRebuild: () => searchBridge.ensureSchema(),
    backupVerify: async () => {
      const [latest] = backup?.listSnapshots({ limit: 1 }) ?? [];
      if (!latest) return { ok: false, reason: 'no_backup' };
      return backup.verifySnapshot({ backupId: latest.backupId });
    },
    // 下面三个等 cognition / brainstem 有对应实现再接；没接就是 hook_missing（会明确停下）
    // alertSweep:     () => brainstem.sweepAlerts(),
    // reflectionRun:  () => cognition.reflection.runOnce(),
    // skillRebuild:   () => cognition.skills.recalibrate(),
  },
});
```

**定时的那个调用由宿主决定（本包不起定时器）**：

```js
setInterval(async () => {
  const gate = directives.readGate();
  if (!gate.ok) return;                     // 先问一句，省一次认领
  await directives.scheduler.runOnce({ owner: 'host-poller' });
}, 60_000);
```

再补两处（可选但推荐）：

- 控制台列表：`directives.list({ includeTerminal: true })`、`directives.stats()`；
- 批准按钮：`directives.approve(id, { by: 'owner' })`。

---

## 6. 验证 / dry-run

```bash
# 主人最关心的那一屏：现在开自主会发生什么、哪一步会被权限拦下（只读，零写入）
node packages/directives/src/dry-run.js

# 指定库 / scope / 条数；--hooks 用来"假装某个 hook 已接线"
node packages/directives/src/dry-run.js --db data/brain.db --scope owner-default --limit 20
node packages/directives/src/dry-run.js --hooks memoryMaintenance,indexRebuild
node packages/directives/src/dry-run.js --json        # 机器可读（给控制台/测试用）
```

退出码：`0` 出报告 / `2` 打不开库 / `3` 这个库还没跑 0008 迁移（会提示先跑 `migrate.mjs`）。

报告六段：① 全局闸门 → ② 指令队列（每条的执行顺序与"在哪一步被拦"）→ ③ 内部候选 →
④ 需要回收的僵尸 run → ⑤ 动作接线状态 → ⑥ 结论。

**"零写入"是执行级保证**：dry-run 注入的写队列是拒绝器（写入即抛），报告里的
`writeAttempts` 必须为 0。测试 `dry-run.test.mjs` 钉住了这一点。

```bash
node --test "tests/directives/*.test.mjs"        # 117 条
node --test "tests/**/*.test.mjs"                 # 全量（987 条；全量由 lead 统一跑，builder 只单跑自己的目录）
```

---

## 6.5 一个必须知道的坑：写队列会改写错误类型

memory 的 `queue.write` 会把事务回调里抛出的**非 `BrainError`** 包成 `StorageError`
（`wrapWriteError`），原错误只留在 `err.cause`。本包刻意不依赖 core，所以
`util.js` 里有一层 `writeThrough(queue, fn, meta)`：捕获后若 `err.cause` 是本模块的错误就
重抛它。

**接线时如果要绕过工厂直接调 `queue.write`，请照抄这个包装**。否则
`PermissionEscalationError` / `InvalidTransitionError` 到上层会变成一条 `STORAGE_ERROR`
（读起来像"磁盘坏了"），排查方向就全错了。

---

## 7. 已知缺口（写在这里，免得有人以为漏了）

1. **计划进度不持久化**。`directive_steps` 有流水，但没有"第几个动作做完了"的游标。
   所以 `paused → queued` 恢复后，动作计划会**从头重放**。
   六个白名单动作都是幂等 / 可重算的，重放安全，但 `steps_used` 已扣的预算不退。
2. **不自动清理历史**。`directive_steps` / `audit_logs` 只增不减（归档策略属维护任务，未做）。
3. **单进程假设**。跨进程并发靠状态 CAS + 租约双保险，但没有做过真实多进程压测；
   MVP 是单进程单实例。
4. **`allowed_tools_json` 一名两用**。迁移已固定列名，本系统把它当"动作白名单"用
   （见 `directives.js` 文件头）。将来若真接外部工具，需要加一列而不是复用这一列。
5. **hook 是同步语义**。长任务应在 hook 内部调 `ctx.heartbeat()` 续租；超过租约未续，
   本轮会被判 `lease_expired` 并放弃写入（副作用已发生但流水会缺失）。
6. **`directives` 没有 update 通道**。除状态外不可改（改标题/预算请新建），
   这是刻意的：可变指令会让"审计里那条"和"现在这条"对不上。
7. **不做跨 scope 汇总视图**。所有查询单 scope；要给全局面板，请在控制台侧多实例聚合。
