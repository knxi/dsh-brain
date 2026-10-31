> **存档**：这是 README 的完整版（原样保留）。精简版在仓库根 [README.md](../README.md)；文中相对链接按仓库根目录理解。

# dsh-brain — DSH 外置大脑

> [!WARNING]
> **🧪 项目状态：测试中（Beta，未定稿）。**
> 这是一个还在开发与实测中的个人项目，**不要**直接拿去当生产记忆系统用。
> - 数据安全：默认**不**对外发送任何消息，自主执行默认关闭，所有危险动作需要显式开开关；
> - 接口会变：门面 API、表结构、页面都可能在下一版调整，**没有**向后兼容承诺；
> - 只在 Windows + Node 22/24 + SQLite(WAL) 上实测过，别的平台没验；
> - 已知缺口清单见 [docs/M8-SYSTEMS-3456.md](docs/M8-SYSTEMS-3456.md) 第 6 节，那是诚实清单不是免责声明。
>
> 如果只是想看懂它怎么设计的，直接读 `docs/` 下的文档；想跑起来，先看「快速开始」并**只用自己的备份库试**。

> 依据《DSH 外置大脑可执行设计方案 v1.2》落地实现。
> 目标：让 DSH 在十万字以上历史之后，仍能找回早期约定、接续未完成任务、区分当前与过期记忆，并且说得清「这次用了哪些记忆」。
>
> **这不是给模型加窗口，是让模型不再依赖完整历史输入。** 有效上下文扩展，不是上下文窗口扩展。

## 现在到哪一步了

| 阶段 | 内容 | 状态 |
|---|---|---|
| M0 | 接入探针：独立 profile 验证 DSH 真实装配点 | ✅ **4 answered / 2 partial / 0 unknown** |
| M1 | 数据主账：事件信封、单主账事务、outbox、幂等摄取 | ✅ **72 契约测试** |
| — | 中文检索能力实测（FTS5/trigram 能不能用） | ✅ **29 单测** |
| M2 | 检索闭环：中文 FTS、精确回查、最小快照、增量构包、检查器 | ✅ **真机端到端跑通** |
| **M3** | 治理恢复：独立删除账本、清理 worker、纠错链、全量备份、隔离恢复 | ✅ **真实恢复演练通过** |
| **M4** | 受控试用：explicit 模式接入生产，只挂显式工具 | ✅ **已接入** |
| **M4.5** | 观察期数据：使用统计（每次检索留痕 + 使用情况页） | ✅ **已接入（生产已生效）** |
| **M6** | 实体与关系：entities / memory_entities / memory_edges + 按实体检索 + 冲突可见 | ✅ **核心可用（待重启生效）** |

## M4：已接入生产 profile

2026-10-28 接入 `~/.dsh/profiles/web`，模式 **explicit**（显式工具），**不挂自动注入**。

| 项 | 值 |
|---|---|
| 插件 | `@dsh-brain/brain-tools`（`apps/brain-tools/`） |
| 工具 | `brain_search` 查 / `brain_remember` 记 / `brain_forget` 忘 |
| 库 | `<repo>\data\brain.db` |
| 模块解析 | `web/node_modules/@dsh-brain/brain-tools` junction |
| 配置 | `web/cordis.patch.yml` 末尾 5 行 insert |
| 改动前备份 | `web/_pre-m4-20261028-205035/` |

**为什么不挂 connector 的 automatic 注入**：注入路径在 brainlab 里真机跑通过（M2 端到端 8/8 sent），
但生产环境里的插件组合、会话形态、真实语料都没验过。先让模型主动查，看它查得准不准，
再决定要不要开自动注入。

**怎么关掉**：注释 `web/cordis.patch.yml` 末尾那段 `- insert:` 的 5 行，重启。
**怎么恢复原状**：把 `_pre-m4-20261028-205035/` 里的 `package.json` / `cordis.patch.yml` / `pnpm-lock.yaml` 拷回去。

冒烟：`node apps/brain-tools/smoke.mjs` → **25/25**，用临时库，不碰生产。

验收：`node --test "tests/**/*.test.mjs"` → **989 / 989 全绿**（0 skipped；2026-10-30 实测，约 5 分 42 秒；
含 M4.5 使用统计 14 条、M6 实体 20 条、M8 四系统 292 条、§22.3 评测 2 条）

**§22.3 质量评测（MVP 发布门槛）**：`node tools/run-eval.mjs` → 120 个固定用例、7 类配额、五项门槛。
当前 **Recall@10 99.0% · 精确值 100% · 旧值误用 0 · 来源可追溯 100% · 无答案误答 0/15**，
报告见 [docs/EVAL-REPORT.md](docs/EVAL-REPORT.md)。这一项还逼出了一个真改进：
`DEFAULT_MIN_COVERAGE` 从 0.34 提到 0.75（只砍误答、Recall 不变）。

## M4.5：使用统计（观察期数据）

**为什么先做这个**：M4 之后能不能卸掉灵枢 / Engram，卡在一个问题上——「检索到底准不准」。
没有数据就只能靠感觉，而感觉不是证据。所以先让每一次检索留痕。

### 记什么

每次 `brain_search`（模型主动查）和 `/api/search`（控制台人工查）都追加一行到
`data/logs/usage.jsonl`：

| 字段 | 记的是 |
|---|---|
| `channel` | `tool`（模型）/ `console`（人工）—— 两个通道分开算，混在一起就看不出「模型会不会用」 |
| `query` / `limit` / `asOf` | 查了什么、要几条、按哪个时点 |
| `hitCount` / `hitIds` | 命中几条、命中哪几条（只记 id，不记正文） |
| `status` / `primaryLaneHit` / `degraded` | 诊断结论、走没走主路、降级原因 |
| `durationMs` | 耗时 |
| `sessionId` | 哪个会话（来自 `exec.agent.session.id`；工具参数里没有这个字段） |

**不记**：命中正文（隐私 + 体积）、「是否被后续回答用上」（工具层看不到，见下）。

### 看什么

| 入口 | 内容 |
|---|---|
| `/dsh-brain/usage` | 使用情况页：概览、每日趋势、诊断分布、最常查的词、零命中查询、从没被查到过的记忆、最近流水 |
| `/dsh-brain/api/usage?days=N` | 同一份数据的 JSON |
| 列表页首屏 | 「近 7 天检索 N 次 / 命中率」 |
| `node tools/verify-usage.mjs` | 命令行只读报告（读真库，含覆盖率） |

### 两条口径（都是踩出来的）

1. **失败检索不算「零命中」**。零命中榜是用来找语料缺口的；把空 query、超时、库坏混进去，
   榜上会全是故障，真缺口被盖掉。所以命中 / 零命中只统计 `ok !== false` 的记录，
   `hitRate` 分母是「跑完的检索数」，另给 `callHitRate` 作含失败的保守口径。
2. **缺字段不能当 0**。`Number(null) === 0`：`durationMs: null` 写盘读回会被当成 0ms
   混进 p50/p95——统计照样出数，数字是假的。所有数值字段走 `toNumber()`，缺了就保持 `null`。

### 还差什么（诚实清单）

- **「命中是否真的被用上」没记**。工具层看不到后续回答，字段留了 `usedLater: null` + 原因说明，
  等 `turn/end` 钩子再补。**不拿代理指标充数。**
- 观察期才刚开始，7 天窗口里样本还很少，**先别据此下任何结论**。

| 套件 | 用例 |
|---|---|
| contract（M1 主账） | 72 |
| search（检索） | 29 |
| m2/memory（记忆层） | 103 |
| m2/context（构包） | 66 |
| m2/connector（连接器） | 82 |
| m2/server（服务/检查器） | 66 |
| m3/deletion（删除线） | 33 |
| m3/backup（备份恢复） | 34 |
| m3/ui（治理界面） | 55 |
| m4/usage（使用统计） | 14 |
| m6/entities（实体与关系） | 19 |

**M2 真机端到端已跑通**（`data/probe/m2-e2e-20261028-200648/`）：`dsh` 真实回合 + 真 `openBrain()`
+ 真 `build()` + `automatic` 模式，4 个场景 11 项检查全绿 —— assemble 11 / 真注入 8 /
**attached 8 / sent 8** / 重复注入 0。

**M3 真实恢复演练通过**（`node packages/memory/src/restore-drill.mjs`）：24/24 项，exit 0。
真实起库、真写记忆、真删、真备份、真恢复、真比对。结论原话：
> 删了的东西恢复后仍然没有：备份之后删除的记忆，在旧备份恢复后保持不可读（未复活）；
> 三条隔离路径（账本缺失 / 损坏 / 水位陈旧）均 `promoted=false`。

**M2 学到的一条要紧时序**：第一条 `assemble` 早于 `user/message` commit，所以 `contexts` 通道
在首步拿不到 query。想让首个 step 也注入，只能走 `injectChannel: 'pre-step'`。

约束已固化进 [docs/CONTRACTS.md](docs/CONTRACTS.md) 第 10 节（M0 实测 11 条）与第 11 节（M1 实测 6 条），
各阶段交接见 [docs/M2-INTERFACES.md](docs/M2-INTERFACES.md) / [docs/M3-INTERFACES.md](docs/M3-INTERFACES.md)。

## M6：实体与关系（补 Engram 没迁的那部分）

**补什么**：Engram 有 `entities` / `node_entities` / `edges`，我们原来只有全文检索。两个真缺口：

1. **「这个实体说过什么」拼不出来** —— 全文检索只能按词命中，要回答「关于 dsh-im 我们都定过什么」，
   得先知道哪些记忆挂在它名下。
2. **矛盾表达不了** —— `memories.supersedes` 是单向链式取代（新的顶替旧的），
   而 `contradicts` 是**双向并列冲突**：两条都还活着，需要人工核验。
   把它们塞进 supersedes 等于擅自判定谁对——那是替主人做决定。

### 三张新表（`migrations/0006`）

| 表 | 内容 | 幂等键 |
|---|---|---|
| `entities` | 实体：person / project / tool / concept / other，带别名与重要度 | `(scope_id, name)` |
| `memory_entities` | 记忆 ↔ 实体（多对多） | `(memory_id, entity_id)` |
| `memory_edges` | 记忆 ↔ 记忆：supersedes / contradicts / supports / refines | `(from, to, kind)` |

### 四条纪律

1. **只写不猜**：`upsert` 只按名字精确合并，**不做相似度自动缝合**——「Remotion」和
   「Remotion 视频」是不是同一个要人来判断，**错合并比不合并难恢复**。
2. **不掩盖冲突**：`contradicts` 是事实不是错误，门面不做任何自动选边。
3. **删除口径跟随主账**：所有查询 join `memories` 过滤 `status='deleted'`。
   `ON DELETE CASCADE` 只对真删生效，本系统是软删除，挡不住——所以必须在查询侧守。
4. **合并规则**：`kind` 不降级（`tool` 不被 `other` 打回）、`aliases` 取并集、
   `importance` 取较大值、`source_system/source_ref` 只补空不覆盖（保留首次出处）。

### 怎么用

`brain_search` 多了 `entity` 参数：

| 调用 | 结果 |
|---|---|
| `brain_search({ entity: '灵枢' })` | 列出灵枢名下的全部记忆 |
| `brain_search({ query: '版本', entity: '灵枢' })` | 检索后在结果里筛出属于灵枢的那些 |
| 实体名对不上 / 有多解 | **不猜**，返回候选让你换更准的名字重查 |

命中也带上了它挂的实体（形如 `实体 灵枢/DSH`），回答「这是关于谁的」时不用再查一次。

控制台：列表页首屏多了「实体」计数；**有矛盾时首页直接红条提示**
「有 N 条记忆互相矛盾，正在并列保留（没有替你选边）」，红条可点进
`/dsh-brain/conflicts`——那里把冲突两端**全文并排**摆出来（带实体、时间、可复制 ID），
因为判断「是详略不同还是真冲突」靠的是读原文，不是看相似度。
新接口：`/api/entities`、`/api/entities/memories?id=`、`/api/conflicts`（含两端全文与实体）。

### 迁移

`node tools/import-engram-entities.mjs`（默认预演）/ `--apply`（真写）。
Engram 的 `node_id` → 我们的 `memory_id` 靠 `source_refs.source_event_id` 反解
（形如 `engram:<库>:node:<id>`），映射不上的**跳过并计数，绝不编造 id**。

## 已经能用的东西

`/dsh-brain` 有五个视图，都挂在 DSH 自己的 webServer 上（同源同端口，**不用另起服务**）：

| 路径 | 内容 |
|---|---|
| `/dsh-brain` | 列表视图：搜索、记忆列表、来源/版本/有效期、实体计数、冲突红条 |
| `/dsh-brain/sea` | **心海**：3D 记忆海，四种地图模式 + 筛选 + 上下文面板 |
| `/dsh-brain/usage` | **使用情况**：检索留痕的聚合视图（M4.5） |
| `/dsh-brain/conflicts` | **矛盾核验**：冲突两端并排看全文，只读不判定（M6） |
| `/dsh-brain/entities` | **实体**：117 个实体按类型分组、孤儿、点开看名下记忆（M6） |

设置页里也有一块「外置大脑」，一个按钮直接打开。

### 心海：两种设计血统

| 来源 | 借了什么 |
|---|---|
| [3d-memory-sea](https://github.com/asdfd3/3d-memory-sea)（**MIT**） | 三维投影、斐波那契球面布簇、深度排序遮挡、Canvas 2D 渲染 |
| **Stellaris（群星）** 的 UI 骨架 | 地图模式切换、左侧常驻边栏、右侧上下文面板、顶部状态条、底部上下文工具栏、hover 即时反馈 |

**只借交互模式，没有使用任何游戏资源或代码。** 纯 Canvas 2D、无 WebGL、无第三方依赖。

四种**地图模式**（同一份数据换维度着色，这是群星最有代表性的设计）：

| 模式 | 着色逻辑 | 用途 |
|---|---|---|
| 类型 | 事实青 / 偏好蓝 / 约定橙 / 经历蓝紫 / 方法紫 | 看知识结构 |
| 重要度 | 冷灰 → 暖金渐变 | 扫出「哪些更该被记住」 |
| 时间 | 靛蓝 → 青绿，横轴按 `validFrom` 排成时间河 | 看记忆的时间分布 |
| 来源 | 手记（暖黄）vs 迁入（蓝） | 分清哪些是自己的、哪些是搬来的 |

左侧边栏筛类型/来源/搜关键词，其余细节靠 hover 浮出。

### 点星即聚焦

**单击一颗星 → 自动聚焦**：只保留它和它的 1 跳邻居，其余隐藏；镜头自动拉近并对准它。
邻居多就退远一点（≤3 个 520 / ≤8 个 700 / ≤20 个 900 / 更多 1100），不会挤到屏幕外。

退出方式三个：点空白、按 `Esc`、底部「回到全部」。

| 动作 | 结果 |
|---|---|
| 单击星点 | 进入聚焦：218 → 它 + 邻居（实测 3 个），dist 1250 → 520，panX/panY 对准 |
| 点空白 / Esc / 回到全部 | 退出聚焦：恢复全量，相机归位 |

右侧面板同时给出 ID、版本、重要度、有效期、邻居数、引用数；底部工具栏有「复制 ID」「去列表里搜」。

### 动效（不硬的关键）

原来所有变化都是**瞬移**——相机直接赋值、点瞬间消失。现在全部走指数缓动：

| 项 | 做法 | 时间常数 |
|---|---|---|
| 相机距离 / 平移 | `smooth()` 每帧向 `camTarget` 逼近 | 320ms |
| 相机旋转 | 同上，转得快一点（距离越长越慢） | 220ms |
| 点的显隐 | 每个点带 `alpha`，朝目标值渐变，**不过滤数组** | 240ms |
| 点击反馈 | `pulse` 从 1 衰减，半径最多放大 55% | 280ms |

实测缓动曲线（点星后的相机距离）：

```
1250 → 1087 → 1005 → 894 → 823 → 766 → 731 → 691
```

前 55ms 走了近 30%，之后越来越慢——指数衰减，不是线性。

实测点的淡出（非邻居）：

```
0.875 → 0.616 → 0.469 → 0.332 → 0.234 → 0.177 → 0.134
```

**拖拽和滚轮是例外**：直接操纵必须即时响应，所以同时改 `cam` 和 `camTarget`，否则松手会被插值拉回去。

**尊重 `prefers-reduced-motion`**：系统关了动效就退化成瞬时（WCAG 2.3.3）。

> 时间轴读 `validFrom` 而不是 `createdAt`：迁移进来的 205 条 `createdAt` 全是导入那一刻，
> 原始时间存在 `validFrom` 里。只读 `createdAt` 的话时间河会挤成一个点。

截图：[类型模式](data/preview/sea-type.png) · [时间模式](data/preview/sea-time.png) · [聚焦态](data/preview/sea-focus.png)

### 已从 Engram 迁入 205 条

| 项 | 值 |
|---|---|
| 迁移工具 | `tools/survey-memory-sources.mjs` / `import-engram.mjs` / `verify-import.mjs` |
| 结果 | 收集 208 → 去重 2 → 脱敏 4 → **导入 205，失败 0** |
| 现在总量 | **226 条记忆（218 active / 7 superseded / 1 deleted）、225 条来源引用**（1 条无来源，见 `docs/audit/C-data.md`） |
| 类型分布 | semantic 169 / skill 19 / profile 16 / episode 13 |

**灵枢没迁**：它那 33 个节点全是对话原文（`layer=contextual` / `role=user`），价值在自动注入机制不在数据。
**凭据已脱敏**：Engram 里有 FTP 明文密码，导入前按契约替换成 `[凭据已移除]`（4 条命中）。

方法与判断依据见 [docs/MIGRATION.md](docs/MIGRATION.md)。
**迁完 ≠ 能卸**：还差「自动提取」和「观察期」，详见该文档第 6 节。

## 三条已经踩实、会改设计的实测事实

1. **`assemble` / `pre-step` 是每 step 一次，不是每轮一次。** 两步回合 = 2 次装配。构包与写入必须按 `(session, turn, step)` 幂等。
2. **独立 profile ≠ 数据隔离。** `dsh-base` 默认所有 profile 共享 `$DSH_HOME/sessions`。隔离验收必须写成路径断言。
3. **注入会形成闭环。** 实测抓到「探针注入的标记被灵枢摄入成记忆节点 → 跨会话自动召回 → 再次进最终请求」。所有注入必须带来源，摄取侧按来源剔除。

中文检索实测结论：FTS5 与 trigram 都可用，但 **默认 `unicode61` 会把整句中文当一个 token**，中文按词检索失效。
落地路线是 **char-space 检索副本主路 + trigram 补充 + ngram 只做诊断 + LIKE 最后兜底 + RRF 融合** →
hit@10 100% / P@10 83.6%（纯默认分词只有 50.0%）。

## 目录

```
dsh-brain/
├─ apps/
│  ├─ probe/       # M0 接入探针（只记录不干预）
│  ├─ connector/   # DSH 连接插件（cordis）
│  ├─ brain-tools/ # 生产在跑：三个显式工具 + 11 个页面 + 27 个 API + 记忆提示注入
│  ├─ server/      # 治理服务（7420，DSH 进程内起）：删除 / 备份 / 恢复
│  └─ console/     # 7420 治理面板前端（可读可写，写操作需 token；不再只是只读检查器）
├─ packages/
│  ├─ core/        # 事件信封、ID、时钟、错误类型
│  ├─ memory/      # 主账：schema、迁移、事务、outbox、删除屏障、备份/恢复、心情
│  ├─ search/      # 中文检索：FTS5、n-gram 兜底、RRF 融合
│  ├─ context/     # 检索→构包→Token 预算（**未接生产**：connector 未上线）
│  ├─ workspace/   # 全局工作空间：开关/事件/焦点/候选（M8，**无驱动器**）
│  ├─ cognition/   # 类脑：显著性/反思/技能/免疫/看门狗（M8，**无驱动器**）
│  ├─ persona/     # 人格/关系/主动社交/回复五态（M8，**无驱动器 + 无外发通道**）
│  ├─ directives/  # 自主指令：状态机/队列/预算/L0-L3（M8，**hooks 全 null**）
│  └─ （无独立 backup 包：快照 / 校验 / 隔离恢复在 `memory/src/backup.js` 与 `memory/src/restore.js`）
├─ migrations/     # SQL 迁移
├─ data/           # brain.db / events / blobs / exports / backups / logs / probe
├─ tests/          # contract / search / m2 / m3 / m4
└─ docs/           # CONTRACTS.md 及各阶段报告
```

## 关键工程决策

1. **纯 ESM JavaScript + JSDoc**，无构建链。现有 DSH 插件生态（engram / 灵枢 / fox-mood）全是 ESM JS，探针改动即刻生效。
2. **`node:sqlite`**（Node 24 内置）。免依赖、免原生编译。实测 `DatabaseSync` / `StatementSync` / `Session` / `backup` 均可用。
3. **单一 SQLite 主账**。JSONL 是带水位的异步导出，不是第二主账。
4. **不打补丁**。不改已安装的 `@deepseek-ai/dsh` 包；用 cordis 插件挂真实接口（`agent/pre-step`、`system-prompt/assemble`、`session/event`）。
5. **三级证据边界** built / attached / sent。没有最终请求证据时，只说 attached，不许说 sent。

详见 [docs/CONTRACTS.md](docs/CONTRACTS.md)。

## 怎么跑

```powershell
cd <repo>

node --test tests/contract      # M1 主账契约测试
node --test tests/search        # 检索实验测试
node apps/probe/run.mjs         # M0 探针（产出 data/probe/<runId>/）

# 工具层与控制台的验收（都用临时库，不碰生产 data/brain.db）
node apps/brain-tools/smoke.mjs  # 三个工具真跑一遍 → 25 项
node tools/verify-routes.mjs     # 起真 server、发真请求，验控制台路由与 API → 57 项
node tools/verify-pages.mjs      # 页面运行时冒烟：五个页面的内联脚本真跑一遍 → 25 项
node tools/verify-usage.mjs      # 使用统计真库只读报告（含覆盖率）
node tools/import-engram-entities.mjs  # 从 Engram 迁实体/关联/冲突边（默认预演，--apply 真写）

# 独立测试 profile（不碰生产 profile web）
dsh --profile brainlab --dump-config
```

探针与主账都**不接生产对话**，只用合成数据。

## 红线

1. 不改已安装的 `@deepseek-ai/dsh` 包文件。
2. 不动生产 profile `~/.dsh/profiles/web`。
3. 不迁移、不改写 Engram / 灵枢 的现有记忆库。
4. 不把凭据写进 URL、日志或导出文档。
5. 不碰真实私密历史——M0/M1 全部用合成数据。
6. 不引原生编译依赖（sqlite3 / better-sqlite3）。

## 验收思路

不看"平均分"，看具体反例。隐私隔离与权限测试通过率必须 100%——一次泄露即阻断发布。
检索指标拆开看：Recall@10、注入 precision、来源可追溯率、当前/历史版本正确率、精确值正确率、弃答率与误答率、任务续接正确率。

**明确不在 MVP**：自动永久记忆晋升、现有人格重写、生产记忆库迁移、多用户运营、主动社交、神经云大图、梦境、独立自主执行。
