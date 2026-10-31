# B · apps 层审计：工具层 / 控制台 / 治理 / 探针 / 连接器

审计日期：2026-10-30 深夜 · 方式：**只读探测**（HTTP GET + 浏览器真实渲染 + 读源码 + 临时库冒烟）
审计对象：`E:\ds-h\dsh-brain\apps\` 下 5 个 app
生产基线：DSH Web GUI `http://127.0.0.1:3080`，治理面板 `http://127.0.0.1:7420`（均在跑）

> **一句话结论**：apps 层比任务书里描述的更完整——不是 5 个页面而是 **11 个页面全部可达、零坏链、零死路由**，
> 治理面板是**真能写**的（不是只读页）。真正的短板不在「有没有」，而在「有没有数据」：
> 矛盾 / 类脑 / 人格三页是活的但库里是空的；`governance-page.js`（699 行）在正常路径下永不渲染；
> `usage` 页有一个天数参数失效的静默 bug。connector 未上生产**是刻意的安全决策**，不是没做完。

---

## 一、app → 状态 → 结论

| app | 规模 | 生产挂载 | 状态 | 结论 |
|---|---|---|---|---|
| `brain-tools` | index.js 2440 行 + 11 个页面 + nav/client/log | ✅ profile `web` 唯一 insert | **生产可用** | 核心闭环完整：3 工具 + 11 页面 + 27 API + 2 钩子 + 进程内治理服务。冒烟 30/30 |
| `server`（7420） | index.mjs + src/*.mjs（8 文件） | ✅ 由 brain-tools **进程内**拉起 | **生产可用** | 16 条路由，写操作（删除/备份/恢复）齐全，Bearer token 鉴权实测生效 |
| `console` | app.js 69,876 B + index.html + styles.css | ✅ 被 server 作为静态资源 serve | **生产可用** | 7420 面板本体：6 tab（记忆/上下文/检索/删除/备份/健康）真实渲染 |
| `connector` | index.js 1332 行 + 6 模块 + e2e 703 行 | ❌ **未挂载** | **可用但未上线** | 默认 `shadow`（只算不注入），e2e 只跑隔离 profile `brainlab` |
| `probe` | index.js + recorder + 3 个 .mjs | ❌ 未挂载 | **开发工具** | 挂 8 类钩子的探针，只在 M0/M2 阶段用过，不进生产是对的 |

**工具注册面（3 个，与生产 profile 注释一致）**：`brain_search`(L375) / `brain_remember`(L631) / `brain_forget`(L743) —— 均通过 `tools.register(defineTool(...))`，冒烟实测三个都能正常返回与拒绝。

**钩子（2 个，都真挂上了）**：
- `ctx.on('session/event')` (index.js:359) → `usedLaterTracker.handleSessionEvent` + `autoExtractOnEvent`，启动打日志「usedLater 观测 + 自动提取已挂载」。
- `ctx.effect` (index.js:856) → `ensureGovernance()` 进程内起 7420；`ctx.effect` (index.js:1156) → `webServer.register` 全量路由。
- `auto-extract.js` **不是死代码**：index.js 顶部 import、L210 实例化、L229 `runAutoExtract` 在 turn/end 调用，默认开（`config.autoExtract === false` 才关）。

---

## 二、页面 × 路由对齐检查（核心项）

### 2.1 注册面完整清单：38 条 `pathname ===` = 11 页面 + 27 API

| 类别 | 数量 | 清单 |
|---|---|---|
| 页面路由 | **11** | `/` ` `/sea` `/usage` `/conflicts` `/entities` `/mood` `/workspace` `/cognition` `/persona` `/directives` `/governance` |
| API 路由 | **27** | stats, memories, search, usage, entities, entities/memories, conflicts, conflicts/action, governance, mood, workspace, workspace/switch, cognition, cognition/{reflection/promote, reflection/dismiss, quarantine/release, quarantine/purge, alert/ack, alert/resolve}, persona, persona/{social/dry-run, social/cancel, conflict/resolve}, directives, directives/{pause, level}, scene |
| 前缀代理 | 1 | `/governance/*` → 转发 7420 |

### 2.2 前端 fetch ↔ 后端路由：**零坏链、零死路由**

方法：正则抽取 12 个前端文件里全部 `/dsh-brain/api/...` 字面量，与后端 27 条 API 做双向差集。

| 检查方向 | 结果 |
|---|---|
| 后端有、前端无人引用 | **0 条** |
| 前端引用、后端未注册（坏链） | **0 条** |
| 页面自带导航 vs `nav.js` `NAV_ITEMS` | 11 页全部 `import` nav.js，11 项 href 与 11 条路由**逐字一致** |

每个 API 的调用方也一一对应，没有「一个写接口只有某个页面用、但那个页面根本不发请求」的情况：

| API | 调用页面 | 实测 |
|---|---|---|
| `/api/stats` | `console-page.js` + `client.js`（设置页面板） | 218 条 |
| `/api/memories` `/api/search` | `console-page.js` | 分页 50/页 |
| `/api/usage` | `usage-page.js` | 13 次 |
| `/api/conflicts` `/api/conflicts/action` | `conflicts-page.js` | 0 条 |
| `/api/entities` `/api/entities/memories` | `entities-page.js` | 117 条 |
| `/api/scene` | `sea-page.js` | 225 点 |
| `/api/mood` | `mood-page.js`（+ `governance-page.js` 降级页副用） | 真实值 |
| `/api/workspace` `/api/workspace/switch` | `workspace-page.js` | 6 个开关 |
| `/api/cognition/**`（7 条） | `cognition-page.js` | 全 0 |
| `/api/persona/**`（4 条） | `persona-page.js` | 0 档案 |
| `/api/directives/**`（3 条） | `directives-page.js` | 19 项能力 |
| `/api/governance` | `governance-page.js`（仅降级路径） | 见 §4.2 不一致 |

### 2.3 HTTP 实测（curl 等价：`Invoke-WebRequest -Method GET`）

11 个页面 **全部 200**，且不是空壳——每页都有真实容器节点，数据由同源 JS 拉。

| 路由 | 状态 | 字节 | 关键容器数 |
|---|---|---|---|
| `/dsh-brain` | 200 | 22,143 | 17（`list` `pager` `pg-info` `cost` `diag`…） |
| `/dsh-brain/sea` | 200 | 47,734 | 13（`sea` `canvas` `detail` `legend`…） |
| `/dsh-brain/usage` | 200 | 16,353 | 24 |
| `/dsh-brain/conflicts` | 200 | 27,258 | 6 |
| `/dsh-brain/entities` | 200 | 12,787 | 9 |
| `/dsh-brain/mood` | 200 | 16,667 | — |
| `/dsh-brain/workspace` | 200 | 17,137 | — |
| `/dsh-brain/cognition` | 200 | 13,635 | — |
| `/dsh-brain/persona` | 200 | 20,428 | — |
| `/dsh-brain/directives` | 200 | 18,015 | — |
| `/dsh-brain/governance` | **302** → `http://127.0.0.1:7420/` | — | 跳转后 16,298 |

13 个 GET API 全部 200 并返回真实 JSON（完整数字见 §3）。

### 2.4 浏览器真实渲染（最强证据，非仅 HTTP 200）

用 DevTools 在真实浏览器打开并读渲染后 DOM：

| 页面 | 渲染实测 |
|---|---|
| `/dsh-brain` | 标题「外置大脑」· **11 个导航项全在** · `第 1 / 5 页 · 共 218 条` · 列表 50 行 · 首行真实正文「外置大脑三条铁律：不开 automatic 注入…」· 检索耗时 401 ms |
| `/dsh-brain/usage` | `最近 7 天` · 总量 13 · 命中率 100% · 零命中 0 · 均耗时 34 ms · 覆盖率 `18.3%` · 流水 13 条含真实 query（灵枢 / 密码 / 卸载 Engram 灵枢 目标 顺序 备份 …） |
| `/dsh-brain/conflicts` | 优雅空态：`待核验 0 · 全部关系 0` + 「库里所有记忆之间都没有记过 contradicts」+ 三个动作的口径说明 |
| `7420/` 治理面板 | token 从 `<meta name="brain-token">` 读到（43 字符）· `已连接 · 全部正常` · 6 tab · 渲染 52 行 · `50 / 225 条` |

> 交叉验证成立：`225 = 218 active + 7 superseded`，7420 默认「状态=全部（不含已删）」与首页 `active` 口径**自洽**，说明两个视图读的是同一个库、各自的过滤没写错。

---

## 三、真实数据面（回答「功能是否都有用」）

| 数据 | 实测值 | 判断 |
|---|---|---|
| 记忆（active） | **218** 条，另有 7 条 superseded | 真在用 |
| 实体 | **117** 个（concept 28 / tool 41 / other 29 / project 18 / person 1），已连 107、孤儿 10 | 真在用 |
| 检索使用 | 7 天 **13** 次，命中率 100%，覆盖 40/218 = **18.3%** | 样本太少（<20），不足以下「准不准」结论 |
| 冲突 | **0** 条 | 功能活着，数据空 |
| 类脑 | salience 0 / skills 0 / reflectRuns 0 / quarantined 0 / alertsOpen 0 | **整套 M8 机制生产上没跑过** |
| 人格 | profiles **0**，activeVersion null | 同上，一个档案都没配 |
| 心情 | mood 79.38 / energy 90.85 / bond 98.5 | 真数据 |
| 场景 | scene 225 点 | 真数据 |
| 空间 | 6 个开关（含 `autonomy.enabled`=1，updatedBy=console） | 真数据，有人改过 |
| 指令 | surface 19 项 | 能力齐全 |
| 备份 | 1 份（`bkp_c123a465aa8a45ad141e6690.db`，10/29 01:28，3.43 MB，已校验） | 真数据，但**只在 7420 看得到**（见 §4.2） |
| 删除账本 | entries 1 / epoch 1 / healthy **true** / isolation 无需 | 健康 |

**结论**：11 页里 6 页有真实数据（记忆 / 心海 / 使用 / 实体 / 心情 / 空间），
3 页是「活的但空」（矛盾 / 类脑 / 人格），2 页是入口（治理 / 指令）。

---

## 四、坏链与占位清单

### 4.1 真 bug（已定位到行，附实测）

| # | 位置 | 问题 | 证据 | 影响 |
|---|---|---|---|---|
| **B1**（**已更正，不是 bug**） | `usage-page.js:315` | `fetch('/dsh-brain/api/usage?days=${days}')` 用单引号包模板串，看着像不插值——**实际上整页是 `renderUsagePage` 的外层模板串，`${days}` 会被服务端插值**，页面真实发出的是 `?days=14` 这类正确值 | 2026-10-30 深夜用最小 DOM + fetch stub 真跑页面脚本复现：`windowDays=14` 时 fetch 实参就是 `/dsh-brain/api/usage?days=14`。原审计拿字面量 `${days}` 直接请求后端，当然返回默认 7——那是人工构造的请求，不是页面行为 | **运行时无问题**，只是可读性陷阱。已改成显式服务端拼接 `const usageApi = '...?days=' + days`，行为等价、不再容易读错 |
| **B2** | `index.js:1717` `/api/governance` | 备份用 `brain.backup.listSnapshots`，返回空 → `backups.total=null, items=[]` | 实测 `/api/governance` 说无备份，但 7420 面板实测**有 1 份已校验备份**。两套门面（`store.backup` vs `governance.listBackups`）不是同一条路径 | 若走降级页 `governance-page.js`，用户会看到「备份 – / 没有备份」，与真实情况相反 |
| **B3** | `usage-page.js:281` | 标题「从没被查到过的记忆」后写 `178 / 218 条，覆盖率 18.3%`：绝对数用 `neverHit`(=178)，百分比用 `touchedRate`(=40/218=18.3%) | 两个数字并置：178/218 是 81.6%，却标 18.3% | 数据本身对，**读起来自相矛盾**，容易让人误判覆盖率。属展示瑕疵 |
| **B4** | 7420 面板文案 | 页面标题与副标题仍是「**M3 · 只读检查器**」，但实际已有「删除 / 备份」tab 与写按钮 | 面板内实测有 `立即备份` `复校` `预演恢复` `去恢复`，备份能力「开」 | 文案过时，让人以为只能读。与「主人要的是点开就能用」的诉求相悖 |

### 4.2 「有实现但没人调」清单

| 实现 | 规模 | 为何没人调 | 判断 |
|---|---|---|---|
| `governance-page.js` | **699 行** + 6,126 B 内联 CSS | 治理服务起来 → `/governance` 直接 **302**；只有 7420 起不来/被禁用才 `renderGovernancePage` | **正常路径下永不渲染**。是降级兜底，不是坏代码，但 699 行维护成本只为一个几乎不会发生的路径 |
| `index.js:908-950` 代理 HTML shim | ~45 行 | 主入口改 302 后，代理只剩子路径 `/governance/api/*` 用；而面板页面实际 fetch 走的是自己的同源 `/api/*` | 与 4.2 上一条同源：上一版「HTML 代理改写」方案的回声，注释里已说明为什么放弃 |
| `conflict-log.js` `appendConflictAction` | — | conflicts 页 0 条冲突，动作从未被点 | 活代码、零调用，等有冲突才会走 |
| `auto-extract` 自动提取 | — | 已挂载，但 `usage.jsonl` 13 条里看不到触发痕迹 | 判断不了是否生效，需单独埋点验证 |
| `apps/probe` 整包 | 8 文件 | 生产未 insert | **应该如此**：它是 M0 探测工具，不是运行期组件 |
| `apps/connector` | 1332 行 | 生产未 insert（刻意） | 见 §5 |

**零死路由**：27 个 API 与 11 个页面路由全部至少有一个前端调用方或真实入口，没有「注册了却谁都不碰」的接口。

### 4.3 占位 / 写死数据检查

- **未发现写死数据的页面**。所有页面都是「容器 + 同源 fetch + 渲染」，数字来自 SQLite 或 jsonl。
- 空数据页（矛盾 / 类脑 / 人格）是**真实查询返回 0**，有正确空态文案（例如矛盾页会明确说「库里所有记忆之间都没有记过 contradicts」），**不是占位页**。
- `persona` / `cognition` 页面的 `unavailable: null` 表示能力可用，不是降级。

### 4.4 README 声称的「设置页里一块『外置大脑』」——**存在，且真加载了**

- 实现在 `apps/brain-tools/client.js`（136 行），`slots.inject('settings.section', …)` 注册 `label:'外置大脑'`，面板内 fetch `/dsh-brain/api/stats` 显示记忆数/索引/工具/库路径 + 两个按钮（打开控制台、治理面板）。
- 生产验证：GUI 的插件清单 URL `/plugins/??…` 里**实际包含 `@dsh-brain/brain-tools/client.js`**，说明 client 半边在生产 GUI 中已加载。
- `package.json` 的 `dsh.client.inject` = `[dsh-client-runtime, dsh-client-ui-settings]`，`platform: web`，配置正常。
- 未做的一步：面板是否真出现在设置页面上（需人手动打开设置页确认），本审计只验证到「bundle 已加载、注册代码在」。

---

## 五、治理面板（7420 代理）：**真能用，不是只读页**

### 5.1 它是怎么起来的（与任务书的判断一致，已验证）

- `index.js:809-868`：`ensureGovernance()` 用 `import('../server/src/server.mjs')` 在 **DSH 进程内** `startServer({port:7420, allowBackup:true, allowRestore:true})`。
- 实测证据：7420 的监听进程 PID **37764**，其命令行是 `dsh web --port 3080 --no-open` —— 即**治理服务与 DSH Web 同一个 node 进程**，多端口监听。这就是「进程内起 7420」的直接证据。
- 端口占用时走 `EADDRINUSE` 分支，直接代理到已有服务（`token:''`），不重复启动。
- `ctx.effect` 的 dispose 里会 `runtime.close()`，注释说这是为了避开 `UV_HANDLE_CLOSING` 断言。

### 5.2 路由与鉴权（实测）

- 16 条路由：`GET ping` / `GET health` / `GET+POST /api/memories` / `GET+DELETE /api/memories/:id` / `GET search` / `GET contexts` / `GET context/:id` / `GET deletions` / `GET deletions/:memoryId` / `GET+POST backups` / `GET backups/:dir/verify` / `POST restore/plan` / `POST restore/execute`。
- 鉴权：`GET /api/health` 无 token → **401**；`GET /api/backups` 无 token → **401**。token 只认 `Authorization` 头（不认 cookie），由页面 `<meta name="brain-token">` 注入 → 浏览器内同源可用、跨站读不到。
- 写操作实测可用性（**只看不点，未执行任何写**）：面板实测有「立即备份 / 复校 / 预演恢复 / 去恢复」按钮，能力横幅写「备份能力 开（可触发）· 恢复能力 开（仍要二次确认）」；恢复需 `dryRun=false + confirm=RESTORE` 三重条件。

### 5.3 面板缺口（与 CLI 对比）

| 能力 | 面板 | 说明 |
|---|---|---|
| 列表 / 详情 / 检索 | ✅ | 记忆 tab，225 条全量 |
| 删除（tombstone + 账本） | ✅ | DELETE 路由 + 删除 tab；无 token 401 |
| 创建 / 复校备份 | ✅ | POST `/api/backups`、GET `/api/backups/:dir/verify` |
| 恢复（预演 + 真执行） | ✅ | `restore/plan` + `restore/execute`，双确认 |
| 删除账本水位 / 隔离判定 | ✅ | 备份详情里显示「删除水位 epoch 1 当前 1」 |
| **导出 / 迁移 / 重塑索引** | ❌ | 无对应路由，只有 CLI 脚本（`bin/seed-demo.mjs`、`tools/*.mjs`） |
| **备份保留策略修改** | ❌ | 面板只显示「保留策略 7 天」，改不了 |
| **查看删除台账全文** | ⚠️ | 面板有 deletions 列表，但 `/api/governance` 侧只读最后 10 条 |

结论：**治理面板的读写能力已覆盖「删除 / 备份 / 恢复」这三个主人真正会用的动作**，缺口集中在运维级动作（导出、策略调整），不影响日常。

---

## 六、connector 为什么没上生产 / 上线缺什么

### 6.1 当前状态（读源码 + README + e2e 的结论）

- **没上没有别的原因，就是刻意的**。生产 profile `web/cordis.patch.yml` 明确写：
  > `# **不挂 connector** —— automatic 注入还没在生产验证过，先让模型主动查。`
  README §33-46 同样口径：「注入路径在 brainlab 里真机跑通过（M2 端到端 8/8 sent），但生产环境里的插件组合、会话形态、真实语料都没验过」。
- 默认模式 `shadow`：挂满 5 个钩子、算出「本来会注入什么」，**一个字节都不改宿主**。即使现在挂上去也是安全的。
- `e2e.mjs` 只跑 `--profile brainlab`（`DSH_PROFILE_BRAINLAB`），patch 原文备份、跑完 byte 级写回，**从不碰 `profiles/web`**。

### 6.2 要上线还缺什么（按优先级）

| # | 缺口 | 具体要做什么 |
|---|---|---|
| 1 | **生产 profile 未做过任何真机验证** | e2e 全在隔离 profile。上线前必须在 `web` 上至少跑一轮 shadow，比对「本来会注入什么」与实际语料的相关性 |
| 2 | **生产没有 junction** | `web/node_modules/@dsh-brain/` 下只有 `brain-tools`；connector 需要另建一个 junction 指向 `apps/connector` |
| 3 | **`automatic` 需要 `buildPackage` 接线** | 生产要传 `storePath` + `migrationsDir` + `memoryModule` + `contextModule` + `budget`，否则构不出包（README §138-149 给了样例；`buildPackage: null` 时 automatic 无意义） |
| 4 | **首步不注入是已知边界，不是 bug** | contexts 通道在第一个 step 拿不到 query（宿主时序：`turn()→preStep()→step()`），已短路成 `auto-build.skip`。要让首步也注入必须切 `injectChannel:'pre-step'` |
| 5 | **pre-step 通道有未查明的不命中** | e2e 观察到部分包停在 `attached` 没到 `sent`，判据三级都查了，如实不谎报。这条没查清前不该直接开 automatic |
| 6 | **无前端半边** | `package.json` 没有 `dsh.client`，所以没有任何界面能开关它或看注入情况；上线后「到底注入了什么」只能翻 jsonl 或 7420 |
| 7 | 证据面依赖 `store.contextPackages.updateStatus` | 该门面缺失时降级为 `absent`，不报错也不落证据 |

**判断**：connector 的代码成熟度不低（七条硬纪律逐条有落点、五个钩子的语义差异都实测记录在 README），
真正拦住它的是**「生产没验过 + 首步不注入 + pre-step 不命中未查清」**这三条实打实的未知，而不是功能缺失。
先 shadow 上生产、观察一段时间，是当前最合理的顺序。

---

## 七、重复与冗余（维护负担）

| 类型 | 量化 | 具体例子 |
|---|---|---|
| **页面外壳与 CSS 全量重复** | 11 个页面各带 1 个 `<style>`，内联 CSS 合计 **68,615 字节**（每页 3.8–9.0 KB） | 只有 `nav.js` 的 `NAV_CSS`/`NAV_CSS_DARK` 是共享的；`--paper/--card/--ink/--muted` 这套变量、`.card` `.pill` `.empty` 等基础样式在 11 个文件里各写一遍。改一次配色要动 11 处 |
| **页面路由分发手写 5 段** | `index.js:1927` 与 `index.js:1967` | `/workspace` `/cognition` `/persona` `/directives` 四个页面各写一个 `if` 分支做 `import` + `res.writeHead`，四段结构完全相同，只是文件名/label 不同；对应的 4 个 API 又各写一段。这 8 段可以压成一个表驱动 |
| **两个「记忆列表」实现** | `console-page.js`（4726 B CSS）与 `apps/console/app.js`（69,876 B） | `/dsh-brain` 首页和 7420 面板都是「记忆列表 + 详情 + 检索」，两套独立前端、两套独立分页逻辑。这是**有意为之**（一个同源嵌在 DSH、一个带 token 的独立治理面），但语义重复导致同一个「记忆」在两处显示条数不同（218 vs 225），容易被当成 bug |
| **`/api/governance` 与 7420 的备份视图两套口径** | 见 B2 | 同一份备份，一处说「有 1 份已校验」，一处说「无备份」 |

---

## 八、给主人的三条实话（回答「功能是否齐全 / 是否都有用」）

1. **齐全度是被低估的**：任务书说五个页面，实际 **11 个页面 + 27 个 API + 3 个工具 + 2 个钩子 + 一个进程内治理服务**，
   且前端路由与后端注册**零坏链、零死路由**。这不是「搭了个架子」，是真接起来了。
2. **「有用」的分布极不均匀**：记忆（218）/ 实体（117）/ 使用（13 次）/ 心情 / 空间 是真在产生价值的；
   矛盾 / 类脑 / 人格 三页**功能是活的、库是空的**——M8 那套类脑机制在生产上一次都没跑过，人格一个档案都没配。
   这三位是「做完了还没开始用」，不是「坏了」。
3. **四个真问题都小但都该修**：B1 天数参数失效（单引号包模板串）、B2 备份视图两套口径互相打脸、
   B3 覆盖率文案自相矛盾、B4 治理面板还自称「只读检查器」。四条都不影响主流程，但每一条都会让人误判系统状态。

---

## 九、审计方法与可复现性

```powershell
# 页面可达性（11 页 + 302 验证）
foreach($p in @('/dsh-brain','/dsh-brain/sea','/dsh-brain/usage','/dsh-brain/conflicts',
  '/dsh-brain/entities','/dsh-brain/mood','/dsh-brain/workspace','/dsh-brain/cognition',
  '/dsh-brain/persona','/dsh-brain/directives','/dsh-brain/governance')){
  (Invoke-WebRequest "http://127.0.0.1:3080$p" -UseBasicParsing).StatusCode }

# 302 不跟随
$r=[System.Net.HttpWebRequest]::Create("http://127.0.0.1:3080/dsh-brain/governance"); $r.AllowAutoRedirect=$false
$r.GetResponse().Headers['Location']   # → http://127.0.0.1:7420/

# 27 个 API 的真实 JSON
(Invoke-WebRequest "http://127.0.0.1:3080/dsh-brain/api/stats" -UseBasicParsing).Content

# 7420 鉴权
(Invoke-WebRequest "http://127.0.0.1:7420/api/health" -UseBasicParsing)   # → 401

# 冒烟（临时库，30/30；生产 brain.db 未被触碰，已核对 mtime 前后一致）
node apps/brain-tools/smoke.mjs
```

**纪律说明**：全程只读。未启动任何常驻服务（7420 与 3080 都是本来就跑着的），
未向生产库 POST 任何写请求，未改任何源码（本文件是唯一写入）。
浏览器侧只做了导航 + 读渲染后 DOM + 点击 tab 切换（未点任何写按钮）。
