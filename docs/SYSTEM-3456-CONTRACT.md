# 系统 3/4/5/6 并行施工契约

> 2026-10-30 立。这份文档是**并行施工的唯一裁决依据**：谁的目录、什么接口、怎么验收、什么不许碰。
> 地基迁移 `migrations/0008_m8_workspace_persona_directives.sql` 已落地并实测（升级/回滚/幂等全过）。

## 0. 一句话目标

把方案 v1.2 的 3/4/5/6 四套系统做成**能跑、能看、能停、能回滚**的最小闭环：
不是把方案抄成代码，而是让主人能感觉到「它在工作，而且不会失控」。

## 1. 目录所有权（硬边界，越界即返工）

| 目录 / 文件 | 所有者 | 说明 |
|---|---|---|
| `packages/workspace/**` | **lead** | 全局工作空间、候选仲裁、开关、注意力。别人的代码只能调它的 API |
| `packages/cognition/**` | **cognition-builder** | 显著性、反思、技能校准、免疫、看门狗 |
| `packages/persona/**` | **persona-builder** | 人格导入/版本/冲突、关系模型、社交候选与仲裁 |
| `packages/directives/**` | **directives-builder** | 指令对象、状态机、队列、预算、权限、停止 |
| `tests/workspace/**` | lead | 测试跟模块走，放对应目录 |
| `tests/cognition/**` | cognition-builder | |
| `tests/persona/**` | persona-builder | |
| `tests/directives/**` | directives-builder | |
| `apps/brain-tools/**` | **lead / console-integrator（最后统一接线）** | 任何人不得提前改 |
| `migrations/**` | **lead** | 只有 lead 能加迁移；需要新表先提需求 |
| `packages/memory/src/index.js` | **lead** | 门面组装点，多人改必冲突 |
| `docs/**` | 各自加自己的文档，文件名带系统前缀 | |

**禁止**：`packages/search`、`packages/context`、`apps/connector`、`apps/server` 这四个目录由 lead 在最后的集成波次统一改。builder 如需改动点，**写在交付说明里**，不要动手。

## 2. 全局工作空间 API（workspace 包，lead 提供，builder 直接调）

builder 的代码**必须通过依赖注入**拿到 workspace，不要自己 `import` 后直接建实例：

```js
// 工厂签名统一：createXxx({ db, queue, clock, alert, workspace, bindings })
export function createCognition({ db, queue, clock, alert, workspace }) { ... }
```

workspace 提供的方法（**这是契约，实现的签名以此为准**）：

```js
// 发布一条工作空间事件（append-only）。返回 { id, at }。
workspace.publish({
  channel,        // sense|attention|memory|affect|action|result|error|resource
  sourceModule,   // 模块名，如 'dmn'（默认模式网络）、'cerebellum'（技能校准）
  kind,           // 具体类型，如 'reflection.completed'
  subjectType,    // 可空：memory|entity|person|session|task|directive|candidate|skill|system
  subjectId,      // 可空
  payload,        // 任意 JSON 可序列化对象（不要塞正文超过 2KB）
  salience,       // 0..1，可空（0 表示「没评估」不等于「不重要」）
  dedupeKey,      // 可空；同一 scope 内相同 key 只落一条
})

// 提一个候选（执行控制器会仲裁）。返回 { id }。
workspace.propose({
  kind,           // memory_write|reflection|proactive|directive|maintenance|skill_update|quarantine
  originModule,
  title,          // 一句话，人看得懂
  payload,
  score,          // 0..100
  scoreBreakdown, // 必填对象：凭什么给这个分
  priority,       // 0..100，默认 50
  evidence,       // 数组，必填：来源 id。空数组的候选不得执行
  notBefore,      // 可空 ISO
  expiresAt,      // 可空 ISO
  idempotencyKey, // 强烈建议给：防重复候选
})

// 读候选队列（执行控制器用；builder 只读不抢）
workspace.listCandidates({ kind, status, limit })

// 开关（全局停止/暂停/自主等级）
workspace.getSwitch('autonomy.enabled')        // -> '0' | '1' | 其它字符串
workspace.isEnabled('autonomy.enabled')        // -> boolean，'1'/'true' 才算开
workspace.setSwitch(name, value, { by, reason })
workspace.isPaused()                           // paused='1' 时所有自主模块必须停手

// 注意力焦点
workspace.getFocus()
workspace.acquireFocus({ kind, ref, label, priority, margin, ttlMs, source, reason })
                                               // -> { ok, focus, preempted }
workspace.releaseFocus({ expectRef })
```

**调用纪律**：
1. `publish` 不抛错（内部降级为无操作并计一次失败），但返回 `null` 时 builder 不得继续假装写成功。
2. 所有会改变外部世界状态的动作（外发消息、写文件、跑工具）**必须先过 `isPaused()` 与对应开关**。
3. 不许 builder 自己 `INSERT INTO ws_events`——走 API，否则消费水位与去重会错。

## 3. 数据表（0008 已建，字段以迁移文件为准）

| 系统 | 表 |
|---|---|
| 3 | `ws_events` `ws_consumers` `ws_candidates` `attention_focus` `memory_salience` `affect_observations` `reflection_runs` `reflections` `skill_stats` `skill_lessons` `immune_quarantine` `health_alerts` |
| 4 | `persona_profiles` `persona_versions` `persona_conflicts` `person_models` `relationship_states` `relationship_events` `proactive_policies` `social_candidates` `social_sends` `response_decisions` |
| 5 | `directives` `directive_runs` `directive_steps` `brain_switches`（通过 workspace API 读写） |

**表口径铁律**（违反即返工）：
- 时间列一律 `TEXT` ISO + 对应 `*_local`；需要毫秒算术的锚点列（`lease_until`/`heartbeat_at`/`at_ms`）用 REAL 毫秒。
- 幂等靠 `UNIQUE`，不要「先查后写」。
- 软删除/状态机用 `status` 列，**不真删行**；查询侧必须自己过滤 status。
- 跨 scope 一律收口：所有查询必须带 `scope_id` 条件（`brain_switches` 除外，它没有 scope）。
- 不存正文：`evidence_json` 里只放 id/路径/摘要，不放大段原文（隐私 + 体积）。

## 4. 测试规范

- 位置 `tests/<系统>/*.test.mjs`，`node --test "tests/**/*.test.mjs"` 能跑。
- **必须用临时库**：`mkdtemp` + `openBrain({ dbPath: <tmp>/brain.db, migrationsDir })`，绝不碰 `data/brain.db`。
- 每个模块至少覆盖：①正常路径；②幂等/重复调用；③关闭开关后的行为（必须什么都不做）；④跨 scope 不泄漏。
- 测试名写中文或英文都行，但要能当"验收清单"读——一条测试名就是一句需求。
- 现有 642 条测试不许变红。跑全量确认：`node --test "tests/**/*.test.mjs"`。

## 5. 每个模块的交付清单（缺一项不算完成）

1. `packages/<name>/src/*.js`：纯逻辑 + 存储访问，工厂函数 `createXxx({db,queue,clock,alert,workspace,bindings})`。
2. `packages/<name>/package.json`：`{"name":"@dsh-brain/<name>","type":"module","main":"./src/index.js"}`。
3. `tests/<name>/*.test.mjs`：全绿。
4. `docs/<系统>-<模块>.md`：**为什么这么设计、明确不做什么、怎么关掉**（300 行以内，不要复述代码）。
5. 交付说明（回报给 lead 的文本）：①公开 API 清单 ②接线点（需要 lead 在哪加几行）③已知缺口 ④如何 dry-run 验证。

## 6. 默认安全姿态（不许商量）

| 开关 | 默认 | 含义 |
|---|---|---|
| `autonomy.enabled` | `0` | 自主指令不启动 |
| `autonomy.max_level` | `L1` | 只读 + 内部记忆维护 |
| `social.enabled` | `0` | 不主动开口 |
| `social.allow_external` | `0` | 只进控制台，**不真外发** |
| `reflection.enabled` | `0` | 不做空闲反思 |
| `paused` | `0` | 全局未暂停 |

**任何模块在开关为 0 时，必须做到"零副作用"**：不写业务表、不发事件、不排队。这条要有测试钉住。

## 7. 分波次

- **W1（已完成）**：0008 迁移 + 体检脚本 `tools/check-m8.mjs`。
- **W2（并行）**：three builders 各写自己的包 + 测试；lead 写 `packages/workspace`。
- **W3（集成）**：lead 改 `packages/memory/src/index.js` 组装；console-integrator 改 `apps/brain-tools` 加页面/API（唯一改这个目录的人）。
- **W4（验收）**：全量测试 + 真机冒烟 + 生产备份后重启验证 + 文档收口。

## 8. 已知边界（写在这里，免得有人以为漏了）

- 不碰 MySQL/向量/多机——单机 SQLite，保持 M1~M7 的架构。
- 不做真正的"微调人格"：人格仍是 `~/.dsh/AGENTS.md`，Brain 只解析、缓存、注入精简版。
- 不做无限制自主循环：指令必须有 step_budget 与 stop_conditions，超预算即停。
- 不主动外发任何消息：`social.allow_external=0` 时只写 `social_sends(delivery_mode='dry_run')`。
