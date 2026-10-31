# 修复总账（2026-10-30 深夜 → 31 日凌晨）

> 对应审计：`00-总报告.md` + `A-packages.md` / `B-apps.md` / `C-data.md`
> 原则：**能验的就验，不能验的写清楚**；不改主人的真实记忆内容，不动已安装的 dsh 包。

---

## 一、核心修复（Lead 亲手改）

### 1. 「模型不优先用外置大脑」——根因与修法

**根因（三条，按影响排序）**

| # | 根因 | 证据 |
|---|---|---|
| 1 | **没有任何运行时提示**。灵枢每轮都把对话记忆注入上下文，外置大脑一条都不注入 → 模型天然不知道它存在 | 7 天 13 次检索里 11 次集中在「讨论外置大脑自己」的会话；本次审计对话我从头到尾没调过一次 `brain_search` |
| 2 | 工具描述**自我劝退**：「不要拿它替代正常工作——只在真的需要跨会话记忆时查」 | `index.js` 的 `brain_search.description` 原文 |
| 3 | 没有自动注入（connector 未上生产，刻意的） | profile 只挂了 `brain-tools` |

**修法**

- `apps/brain-tools/index.js`：
  - 新增 **记忆提示注入**：挂 `system-prompt/assemble` waterfall，每轮（按 `session#turn` 去重）追加一条 `{name:'brain:hint'}` PromptContext。内容是**静态提示**（不含检索结果、不含记忆正文）：库里有几条、什么情况该查、查到证据不足要如实说。`interpolate: false`（防 `{{}}` 被宿主插值抛错），复制后追加（不改宿主数组），失败静默。
  - 改写 `brain_search.description`：去掉「不要拿它替代正常工作」。

### 1b. 判据设计（2026-10-30 深夜修正：弃用「前史」）

第一版描述写的是「碰到指向前史的话，第一动作就是查这里」——**这是口号换口号**。
「前史」是关于对话历史的**外部标签**，模型没法判定（上下文里没有这个标记），执行时仍然靠猜。
改成**模型能自己回答的问题**（自省式，不是外部标签）：

| # | 判据 | 为什么模型答得了 |
|---|---|---|
| ① | 这轮要用的具体东西（编号 / 尺寸 / 口径 / 决定 / 偏好 / 进度）在当前上下文里找不到吗？ | 这是关于「我的上下文缺什么」的自省，模型每轮都在做 |
| ② | 主人用了回溯或指代词（之前 / 上次 / 继续 / 那个 / 还按 / 老规矩 / 像上次 / 我们定过）吗？ | 字面匹配，确定性最高 |
| ③ | 要下「已经做过 / 改过 / 定过」的判断，而证据不在眼前吗？ | 关于证据是否在场的判断 |

另加两条压决策成本：

- **反信号**：主人当场说全了、能靠当前上下文或直接观察答出来、纯闲聊 → 不查（防「逢话必查」把工具用成噪音）。
- **价格锚**：不确定就查一次——一次调用 20~80ms，零命中也会如实回「没有」，比编一个答案便宜。

**边界（诚实）**：这套判据不能保证 100%。② 是确定性最高的；① 覆盖「主人没提任何指代词、但任务缺参数」那一类（也是最容易被漏的），但它依赖模型对自身上下文的准确自评。真要更强只剩自动注入（connector 每轮塞相关片段），那是另一个风险等级，本次没动。

- 成本约 120 token/轮；可用 `config.hintInjection:false` 或 `BRAIN_HINT_INJECT=off` 关掉。

### 2. 自动提取：零触发根因 + 注入隔离（两处硬 bug）

| 问题 | 根因 | 修法 |
|---|---|---|
| 自动提取一次都没产出，连日志文件都不建 | 宿主 `user/message` 的 data **没有 turn 字段**（只有 turn/start、turn/end、assistant/message 带 turn）→ 缓存成 `{turn:null}` → turn/end 拿数字 filter 筛 0 条 → 静默返回 | 新增 `latestTurn` Map：turn/start、turn/end 时记录 `sessionId → turn`；`user/message` 改用这个 turn |
| 修好 turn 会立刻灌垃圾（实测注入块命中 91/144） | `user/message` 里绝大多数不是主人打的字 | **白名单**：只缓存 `source.kind === 'user'`（实测 74 条里 36 条是 user，其余是 runtime-context / skill-catalog / agent-instructions / agent-message / subagent-settled / model-selection / user-approval） |
| 「没跑到」和「跑了没命中」在数据上长得一样 | 只有 quota/disabled 才落 sidecar 记录 | 判定过一律落 record：新增 `status:'no_candidate'` |
| 缓存 4 格装不下一个回合 | 一个 turn 有 6+ 条 user/message | `MAX_MESSAGES_PER_SESSION` 4 → 12 |

冒烟实测（临时库）：注入块被挡、主人手打那句被提取成 `remember-verb`、写库 `source_type=observation`、sidecar 不落原文。

### 3. 删除闭环：`brain_forget` 的 job 从来没人消费

- 根因：**全仓没有任何地方调 `deletionWorker.runOnce()`**（只有恢复流程用过），删除只排队不执行 → 删掉的记忆一直留在 FTS 里能搜到。
- 修法：`index.js` 挂低频 drain —— 启动 15 秒后跑一次、之后每 5 分钟一次，`maxJobs:200`，定时器全部 `unref()`，失败静默，可用 `config.deletionDrain:false` 关掉。
- 存量已在本次清完（见第二节 A）：被删记忆在生产检索里 **0/5 命中**。

### 4. 写入/遗忘补埋点（口径分开）

- `usage-log.js`：`channel` 增加 `write`，新增 `op` 字段（remember 的 kind / forget）。
- 关键口径修正：**写入成功 ≠ 命中一次**。`summarizeUsage` 里命中/零命中/耗时/主路降级/覆盖率只对检索类（非 `write`）统计，新增 `byOp` 与 `retrievalCount`；命中率分母改用 `retrievalOkCount`。
- `index.js`：`brain_remember` / `brain_forget` 在 `finally` 里写 usage（不靠每个 return 手动补）。

### 5. 备份视图两套口径（B2）

- `/api/governance` 原来用 `brain.backup.listSnapshots`（读的是另一套门面，返回空），而 7420 面板明明列着已校验备份。
- 改成直接读 M1 的 `backups` 表 + `statSync` 判文件存在，与治理服务同源。

---

## 二、分支修复（teammate，全部已验证）

**A. 删除闭环执行（fix-deletion）**
- 备份先行：`data/backups/manual-before-deletion-fix-20261030-234905.db`（SQLite 在线 backup，非裸拷 WAL）
- 先在备份副本 dry-run 两轮（第 2 轮 `processed=0` 验幂等），再动生产库
- 结果：5 个 job 全 done、墓碑 verified、正文/摘要/hash 清空、其它 225 条零变化；FTS 命中从 5/5 → **0/5**

**B. 页面 bug（fix-pages）**
- `usage-page.js`：天数参数改成显式服务端拼接（**审计原判 B1 是误判**——外层模板串本来就会插值，只消除可疑写法）；覆盖率文案拆成「从没被查到过 N 条（占 X%）· 覆盖率 Y%」，空库不产 NaN
- `apps/console/index.html`：7420 面板「M3 · 只读检查器」→「记忆治理面板 · 可读可写（写操作需 token）」

**C. 测试与文档（fix-tests-docs）**
- `tests/contract/backup.test.mjs`：硬编码 `'3.53.3'` → 读运行时 `sqlite_version()` 断言（跨 node 版本都成立）
- `packages/memory/package.json`：补 `@dsh-brain/{cognition,directives,persona}` 三个 `workspace:*`
- README / README-full / ROADMAP / M8 / CONTRACTS：视图数、测试数、记忆数、关联数、开关现状对齐实测

**D. 数据状态（Lead 执行）**
- M8 五个开关退回默认：`autonomy.enabled=0` / `autonomy.max_level=L1` / `social.enabled=0` / `social.allow_external=0` / `reflection.enabled=0`（`paused=0` 不动）——无驱动器时开着只会造成「页面全活、数据全空」的假动作态。走控制台接口改的，库里有审计。

---

## 三、验证

| 项 | 结果 |
|---|---|
| `node apps/brain-tools/smoke.mjs` | **41 / 41 全绿**（新增 10 项：提示注入 5 + 自动提取 5） |
| `node --test "tests/**/*.test.mjs"` | **989 / 989 全绿，0 fail / 0 skipped，exit 0**（约 5 分 42 秒） |
| `tests/m4/usage` | 25 / 25 |
| `tests/contract/backup.test.mjs` | 8 / 8 |
| M8 开关复核 | 5 个全 0 / L1（API 回读确认） |
| 生产库 | 只读打开核对，未改任何记忆内容（删除 job 清理除外，那本来就是要清的） |

---

## 四、明确没做 / 留给主人定

1. **`outbox` 那条 `purge_tombstone` 仍 pending**：全仓**没有它的消费者**（只有入队点）。「purge 墓碑」语义未定义，标 done 会留假状态，所以没动。三选一：① 写消费者；② 五步全绿时同步 complete；③ 认定遗留、页面别显示。附带：这行 `deletion_epoch=0`（payload 是 1），因为 `enqueueOutbox` 的 INSERT 没写该列。
2. **`governance-page.js`（699 行）正常路径永不渲染**：保留作降级兜底，未删。
3. **11 页内联 CSS 68 KB 重复**：重构收益低、回归面大，这次没动。
4. **connector 仍未上生产**：默认 shadow、生产零验证，ROADMAP 的结论没变——先 shadow 观察再开 automatic。
5. **需要重启 DSH 才生效**：工具描述、埋点、提示注入、删除 drain、页面文案都是进程内模块改动，当前 3080 进程加载的还是旧代码。

---

## 五、重启后怎么确认真的生效

```powershell
# 1. 三个工具的描述变了 + 记忆提示注入挂载日志
#    重启后看 stderr：
#      [brain-tools] 记忆提示注入已挂载（turn 级、静态文本、不含记忆正文）
#      [brain-tools] 删除队列清理已挂载（启动 15s 后一次，之后每 5 分钟）

# 2. 写入/遗忘有埋点了（新记录 channel=write）
Get-Content E:\ds-h\dsh-brain\data\logs\usage.jsonl -Tail 5

# 3. 自动提取开始留痕（正常的话每回合一行 no_candidate，命中才有 created）
Get-Content E:\ds-h\dsh-brain\data\logs\auto-extract.jsonl -Tail 5

# 4. 提示注入真的进了请求：问一句「上次那个参数是多少」，
#    看模型有没有第一动作就 brain_search（usage.jsonl 里应出现 channel=tool 的新记录）
```
