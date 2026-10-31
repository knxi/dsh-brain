# 系统 3/4/5/6 落地总览（M8）

> 2026-10-30 深夜完工。这篇是**给主人看的说明书**，不是设计文档。
> 设计依据：`DSH外置大脑-可执行设计方案-v1.2.md` 第 3/4/5/6 系统 + 第 7/8/11 章。
> 施工契约：`docs/SYSTEM-3456-CONTRACT.md`。各包内部设计见 `docs/SYSTEM3-COGNITION.md` / `SYSTEM4-PERSONA-SOCIAL.md` / `SYSTEM5-DIRECTIVES.md`。

## 0. 一句话结论

四套系统**都已经在磁盘上、在生产库里、在测试覆盖里**，但**默认全部关闭**。
这不是没做完，是刻意的：自主行为、主动社交、外发消息这三件事，第一次必须由你亲手打开。

## 1. 现在有什么

| 系统 | 落地物 | 位置 | 状态 |
|---|---|---|---|
| **3 类脑协同** | 全局工作空间（事件总线/候选仲裁/注意力/开关）+ 五个类脑模块（显著性/反思/技能/免疫/看门狗） | `packages/workspace/` `packages/cognition/` | 24 + 75 条测试 |
| **4 人格与主动社交** | 人格导入/分层/版本/冲突 + 每用户关系四维 + 主动社交候选→评分→仲裁→dry-run + 回复五态 | `packages/persona/` | 68 条测试 |
| **5 自主指令** | 指令对象/状态机/队列/预算/权限 L0-L3/停止条件/调度器/内置动作白名单 | `packages/directives/` | 116 条测试 |
| **6 治理可视化** | 4 个新控制台页面 + 16 个 API（含写操作同源保护） | `apps/brain-tools/*-page.js` | 51 项页面自测 |
| 数据地基 | 26 张表（含 35 个索引） | `migrations/0008_*.sql` | 升级/回滚/幂等实测通过 |

## 2. 怎么用（照抄就能跑）

### 看「它本来会说什么」—— 最直观的一条

```bash
cd <repo>
node packages/persona/bin/social-dryrun.mjs
```

只读预演，**不写库、不发消息**。输出会告诉你：如果现在开着主动社交，它今天本来会说什么、每条的依据和打分拆解、以及哪些来源这次没生成（并说清原因）。

### 看状态 / 改开关

```bash
node tools/check-m8.mjs                 # 0008 结构体检（只读，可指向生产库）
node tools/verify-m8-ui.mjs             # 四个页面的渲染自测
node -e "..."                           # 开关请走控制台页面，别手改库
```

浏览器打开 `http://127.0.0.1:3080/dsh-brain/workspace`（重启 DSH 后生效）。

### 四个新页面

| 页面 | 看什么 |
|---|---|
| `/dsh-brain/workspace` | 六开关（点两下才生效）+ 当前注意力焦点 + 候选队列 + 事件流 |
| `/dsh-brain/cognition` | **告警中心在首屏** + 五格统计 + 反思候选 + 免疫隔离区 |
| `/dsh-brain/persona` | **主动社交候选（可点 dry-run）** + 人格版本/分层/冲突 + 关系四维 + 回复五态 |
| `/dsh-brain/directives` | **首屏是能力边界**（能做什么/绝不能做什么）+ 开关 + 队列 + 运行流水 |

## 3. 开关（唯一的闸门）

全部存在 `brain_switches` 表，默认值如下——**六个键里五个是关的**：

| 开关 | 默认 | 含义 | 怎么开 |
|---|---|---|---|
| `paused` | `0` | 全局暂停，压过一切 | 控制台一键 |
| `autonomy.enabled` | `0` | 自主指令是否允许启动 | 控制台 |
| `autonomy.max_level` | `L1` | 最高权限等级（L0 只回复 / L1 只读+内部维护 / L2 白名单可逆 / L3 已授权长期） | 控制台 |
| `social.enabled` | `0` | 主动社交是否允许生成与排队 | 控制台 |
| `social.allow_external` | `0` | 是否允许**真外发**（默认只进控制台） | 控制台 + 还要注入通道 |
| `reflection.enabled` | `0` | 空闲反思是否允许跑 | 控制台 |

> **现状更新（2026-10-30）**：上表是**默认值**（六个键默认五个关）；但生产库 **2026-10-30 22:16 曾被 console 手动打开到 5/6**
> （`autonomy.enabled=1`、`autonomy.max_level=L3`、`social.enabled=1`、`social.allow_external=1`、`reflection.enabled=1`，`paused=0`）。
> **开关当前状态以 `brain_switches` 表为准，不要拿本节默认值当现状。**

**开关为 0 时，模块必须做到零副作用**（不写业务表、不发事件、不排队）。这条有测试钉住，不是口头承诺。

## 4. 每条防线的具体位置

- **外发**：`social_sends.delivery_mode` 只有 `dry_run` / `approved` 两种；`approved` 还需要 `allow_external=1` **且**注入了真实通道钩子。没钩子时返回 `{queued:false, reason:'no_channel_configured'}` 并留一条 `ok=0` 记录——**尝试过但没发出去，不谎称成功**。
- **自主执行**：`directives/src/permissions.js` 的动作白名单只有 6 个内置动作（记忆维护/索引重建/反思/技能重建/告警巡检/备份校验）。**没有 shell、没有任意命令执行**，这是设计而不是遗漏。
- **反扩权**：子指令的 `permission_scope` / 预算不得超过父指令，违规抛 `PermissionEscalationError`。
- **重启安全**：指令带租约 + 心跳；进程死掉后遗留 `running` 的 run 会被回收成 `timeout`，不会重复执行。
- **人格**：`~/.dsh/AGENTS.md` 只读解析，结果落库；人格写入只能走「建版本 → 激活」，身份/边界类冲突**默认不自动消解**。

## 5. 怎么回滚

```bash
# 1) 回滚代码（git）
cd <repo> && git status && git checkout -- .   # 或在 git 里 revert 本轮提交

# 2) 回滚迁移（会丢掉这四套系统的数据，但那本来就是空的）
node packages/memory/bin/migrate.mjs --rollback

# 3) 用备份彻底回到迁移前
node tools/backup-before-migration.mjs --verify-only --db "data\backups\pre-migrate-20261030130830\brain.db"
# 停服务 → 把上面那个 brain.db 覆盖回 data\brain.db → 删掉 brain.db-wal / brain.db-shm → 启动
```

迁移前的备份在 `data/backups/pre-migrate-<时间戳>/`（本次是 `pre-migrate-20261030130830`，218 条记忆 / 117 实体 / schema 0007）。

## 6. 已知缺口（诚实清单，按要紧程度排）

1. ~~主动社交的 `unfinished_care` 判据太宽~~ —— **已修（2026-10-30 深夜）**。首次真跑时它把项目事实记忆当成"上次你提到…后来怎么样了"来追问；现在收窄到身体/情绪/具体安排类线索、并排除 `profile`/`semantic` 与"已修复/已完成"语义。修完在生产库实测输出：
   ```
   如果现在开着主动社交，它今天不会开口。
   unfinished_care：no_care_evidence（近 14 天没有身体/情绪/具体安排类线索）
   ```
   —— 宁可说"今天不开口"，也不硬凑三条。
2. **只做了 4 类社交来源**（schedule / unfinished_care / commitment / discovery）。`shared_memory` / `verification` / `curiosity` 刻意没做——没有可靠机器可读依据，硬做就是编造，`generate()` 会如实列 `not_implemented`。
3. **真发通道没实现**：只留了 hook。要真发得注入 `channel`（IM 侧接线是下一步）。
4. **自主执行的动作全是内置白名单，且六个动作目前全部未接线**（生产 `hooks=null`）。真实表现已实测：哪怕误开 `autonomy.enabled=1`，第一条指令也会停在 `hook_missing` → `blocked`，并在 `directive_steps` / `audit_logs` 留痕，**不会假装跑成功**。
5. **`schedule` 的作息估计**依赖近 40 条 `relationship_events`，少于 5 条就不猜（当前就是"不知道作息"）。
6. **人格 `needsReview` 只返回不落库**（要持久化得再加一张表）。
7. **控制台写操作成功后整页刷新**（状态一定真，但长页面会跳回顶部）。
8. **`directives` 页的运行记录是直查 SQL**（门面没暴露 `listRuns`，口径可能漂）。
9. **`reflections` 表没有 UNIQUE 约束**（0008 就是这样），同证据去重靠事务内查重 + 单写队列串行。将来多进程跑反思前要加指纹唯一索引。
10. **`health_alerts` 的去重是进程级**（`ux_health_alerts_open_code` 只按 code），多 scope 会共用一条 open 行；MVP 单用户不出现。
11. **`m3/backup/drill.test.mjs` 在受限沙箱里恒红**（它要 spawn 子进程）。权限放开的环境下已实测通过。

## 7. 本轮顺手修掉的两个架构级问题

这两个不是功能，是**地雷**，值得单独记：

### 7.1 跨包错误身份分裂（会让错误码静默丢失）

`@dsh-brain/*` 用目录 junction 解析，Node 不会 realpath，于是**每个包加载一份独立的 `core`**：
`packages/cognition` 抛的 `BrainError` 在 `packages/memory` 里 `instanceof` 为 false →
`write-queue.wrapWriteError` 把它包成 `StorageError` → **`NOT_FOUND` / `INVALID_ARGUMENT` 全变成 `STORAGE_ERROR`**，看起来像数据库坏了。

修法：`BrainError` 加 `Symbol.for('@dsh-brain/error')` 品牌，`isBrainError()` 改成「instanceof 优先 + brand 兜底」，**不按 name/code 猜**（猜会误判第三方错误）。
实测：两个 junction 各加载一份 core 时，跨实例认亲成功。

### 7.2 架构测试从「看名字」升级成「看闸门」

`tests/m2/server/forged-command-no-side-effect.test.mjs` 原先用名字黑名单扫 `openBrain` 的键，
`persona` 一出现就红。但系统 4 是明确需求，继续按名字挡等于用一条过时断言否定合法功能。

升级为：名字黑名单只保留真正危险的动作词（registerTool / grant / elevate / escalate / setRole），
另加一条测试钉住「人格写入面必须带闸门」——写方法存在、授权动作不存在、权限等级可读、审计可查。
**保护变强了，不是被绕过。**

## 8. 验证入口汇总

```bash
node tools/check-m8.mjs --expect 0008          # 结构体检（生产库可跑）
node tools/verify-m8-ui.mjs                    # 四页渲染自测（临时库）
node packages/persona/bin/social-dryrun.mjs    # 主动社交预演（只读生产库）
node tools/init-person.mjs --dry-run           # 冷启动人物模型（幂等）
node --experimental-test-isolation=none --test "tests/**/*.test.mjs"   # 全量测试
```

> 跑测试必须加 `--experimental-test-isolation=none`：默认隔离模式要为每个文件 spawn 子进程，本机受限环境会 `EPERM`。
