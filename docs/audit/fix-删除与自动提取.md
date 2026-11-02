# 修复报告：`brain_forget` 删除闭环 + 自动提取零触发诊断

- 任务：`task-6`
- 负责人：`fix-deletion`
- 时间：2026-10-30 23:4x–23:5x（Asia/Shanghai）
- 目标库：`E:\ds-h\dsh-brain\data\brain.db`（SQLite WAL，schema `0008`，被 3080 的 `dsh web` 进程 PID 37764 持有，启动于 22:25:43）
- 纪律：除「清 pending deletion job」这一必要动作外，**未做任何其它库写**；未重启服务；未改任何源码。

---

## 0. 结论先行

| 项 | 结果 |
|---|---|
| **A. 删除闭环** | ✅ **已闭环**。5 个 `deletion_jobs` 全 `done`，tombstone → `verified`，被删记忆的正文/摘要/`content_hash` 已清空，**FTS 三表已清**（`char` 1 行 / `trigram` 1 行 / `ngram` 215 term 全部消失）。`PRAGMA integrity_check = ok`，其它 225 条记忆状态零变化。 |
| **A. 遗留** | ⚠️ `outbox` 那条 `purge_tombstone` **仍 pending**。原因不是没跑，而是**全仓没有它的消费者**（代码缺陷）。按纪律**没有硬改库**，见 §3 缺陷 D1。 |
| **B. 自动提取** | ❌ **「根本没跑到」**（精确说：handler 跑到了，但**第一个判定点就因 turn 关联失败而静默返回**，永远到不了 `record()`）。这不是「规则不命中」，也不是「写盘失败」——两者都已被实验排除，见 §4。 |
| **B. 更坏的发现** | 🔴 就算把 turn 修好，**主人的真实语料仍然 0 命中**（23 条手打消息 → 0 条候选），而**注入块会立刻灌进 90 条「不得执行」垃圾记忆**。见 §4.4。 |

---

## 1. A 部分：删除闭环

### 1.1 修复前现状（只读探针实测）

被删的是 **`mem_68ae658e254f8187b54b3946`**（2026-10-28 20:52 写入的「外置大脑以 explicit 模式接入生产 profile web」那条，删除原因：「写入时未关联来源，检索会误报来源已丢失；删掉后按修好的代码重记」）。

| 位置 | 修复前状态 |
|---|---|
| `memories` | `status='deleted'`，但 `content` **288 字符仍在**、`summary` 仍在、`content_hash` 仍在、`deletion_epoch=1` |
| `memory_versions` | 1 行，`content` 288 字符**仍在** |
| `deletion_tombstones` | `tmb_a09437bce7d2b5a5735095fc`，`status='pending'`，`deletion_epoch=1`，`ledger_synced_at` 已写（账本同步成功） |
| `deletion_jobs` | **5 条全 `pending`，`attempts=0`**：`purge_text` / `scrub_index` / `drop_context_packages` / `purge_exports` / `purge_blobs` |
| `outbox` | 1 条 `kind='purge_tombstone'`，`status='pending'`，`attempts=0`，`deletion_epoch=**0**`（payload 里却是 1） |
| `search_fts_char` | **命中 1 行**（`rowid=1`，`doc_id=mem_68ae658e...`），body 是完整正文 |
| `search_fts_trigram` | **命中 1 行**（`rowid=1`） |
| `search_ngram` | **215 个 term** 仍指向该 `doc_id` |
| `memories` 分布 | 218 active / 1 deleted / 7 superseded（共 226） |

根因（现状层面）：`brain_forget` 只做了「打墓碑 + 排 job + 立即屏蔽（改 status）」，**清理 worker 从未被任何调用方跑过**。

### 1.2 备份（写库前）

不裸拷 WAL 状态的 db 文件，用 SQLite 在线 backup API（`node:sqlite` 的 `backup()`，即 `packages/memory/src/backup.js` 里 `runBackup` 的同一个实现），源库以 `readOnly` 打开——**备份过程不写生产库一行**；校验复用官方只读门面 `inspectSnapshotFile`。

- 备份文件：`data/backups/manual-before-deletion-fix-20261030-234905.db`（4,399,104 bytes）
- `sha256:74eb3cd28c430bf3eaa69ebd3a8a23e053c25d56e35fd27b91a1bc35d0f34762`
- 校验：`integrity_check=ok`、`schema_version=0008`、`deletion_epoch=1`、**17 张必需表逐表计数与源库完全一致（0 项 DIFF）**
- 备份中固化的「修复前状态」：`memories.content_len=288`、`tombstone.status=pending`、5 个 job 全 pending、`fts_char` 命中 1 行 —— **对照组成立**
- 脚本：`E:\ds-h\tmp\backup-before-deletion-fix.mjs`（仓库外，未污染工作区）

### 1.3 dry-run（在备份副本上，先验证再碰生产）

把备份复制到 `E:\ds-h\tmp\dryrun-deletion.db`，用**生产代码的 `createDeletionWorker().runOnce()`** 跑 **2 轮**：

- 第 1 轮：`processed=5, failed=0, skipped=0, backfilled=0`，5 个 job 全 `done`；`scrub_index` 明细 `{char:1, trigram:1, ngram:215}`；tombstone → `verified`
- 第 2 轮：`processed=0` —— **幂等确认**，不会重复清理、不会重复计 attempts
- 结论：worker 只处理 `status IN ('pending','failed')` 的 job，每步前重查屏障，行为符合设计。

执行入口选择说明：**用 `packages/memory/src/deletion-worker.js` 的 M3 `runOnce()`**，不是 `deletion.js` 的 `runPurgeWorker()`。后者（M1）不区分 job kind，会把 `scrub_index`/`purge_exports` 等错当 `purge_text` 执行后标 done（假闭环），其自身文件头也写明「M1 的 worker 只认 purge_text（其余 kind 会显式 failed/dead）」。

### 1.4 生产执行（一次，1 轮）

```
node E:\ds-h\tmp\drain-deletion.mjs "E:\ds-h\dsh-brain\data\brain.db" --apply --rounds=1
```
连接参数 `busy_timeout=15000`（避免与 3080 进程写冲突），无 `SQLITE_BUSY`。

逐 job 实测产出：

| job | 结果 | 明细 |
|---|---|---|
| `purge_text` | ✅ done | `rowsTouched=2`（`memories` 正文+摘要+hash 清空；`memory_versions` 正文清空；`source_refs` 本为 0） |
| `scrub_index` | ✅ done | `search_fts_char: 1` / `search_fts_trigram: 1` / `search_ngram: 215`，`missing: []` |
| `drop_context_packages` | ✅ done | `packages: 0`（本库 `context_packages` 本就 0 行） |
| `purge_exports` | ✅ done | `filesScanned: 0`（`data/exports` 无文件） |
| `purge_blobs` | ✅ done | `released: sha256:fa2686ba…`、`stillReferenced: []`、`physicalFilesRemoved: 0`、`physicalRemovalDeferred: true`（按设计只摘引用不物理删） |

### 1.5 验收（实测，9/9 PASS）

用**生产检索的同款路径**验证，不是「表里查了没行」：照抄 `packages/search/src/index.mjs:200/221` 的 FTS5 语句，查询串用 search 包自己的 `buildFtsMatch()` / `buildTrigramMatch()` 构造（不手搓 MATCH）。同一批 5 条 query 分别在**修复前备份副本**与**生产库**上跑：

| query | 修复前（副本） | 修复后（生产库） |
|---|---|---|
| `外置大脑 explicit 模式接入生产` | char 5 条、trigram 4 条，**含被删记忆** | char 4 条、trigram 3 条，**不含** |
| `pre-m4-20261028-205035` | char 2、trigram 2，**含** | char 1、trigram 1，**不含** |
| `只挂 brain_search / brain_remember / brain_forget 三个工具` | trigram 2，**含** | trigram 1，**不含** |
| `cordis.patch.yml 末尾 brain-tools` | char 2、trigram 3，**含** | char 1、trigram 2，**不含** |
| `205035` | char 2、trigram 2，**含** | char 1、trigram 1，**不含** |
| **命中被删记忆的 query 数** | **5 / 5** | **0 / 5** |
| `search_ngram` 里该 doc_id 的 term 数 | **215** | **0** |

其余验收项：

| 检查 | 结果 |
|---|---|
| `deletion_jobs` 无 pending/running/failed | ✅ `n=0`（5 条全 done，`attempts=1`） |
| `memories.status='deleted'` 且正文已清 | ✅ `content IS NULL`、`summary IS NULL`、`content_hash IS NULL` |
| `memory_versions` 正文已清 | ✅ 1/1 为 NULL |
| 墓碑状态 | ✅ `status='verified'`，`deletion_epoch=1` |
| 其它记忆未受影响 | ✅ 仍是 218 active / 7 superseded / 1 deleted |
| `PRAGMA integrity_check` | ✅ `ok` |
| `deletionStatus()` 分层报告 | ✅ `workerState='done'`、`progress {total:5, done:5, failed:0}`、`ledgerSynced=true`；`claims.physicallyErased=false`（如实，不做物理擦除承诺） |

验证脚本：`E:\ds-h\tmp\verify-deletion-fix.mjs`（输出「全部通过」）。

**诚实边界**（与 `deletionStatus` 的 notes 一致）：在线清理完成 ≠ 旧备份到期 ≠ 外部副本已核实 ≠ 物理介质已擦除。按保留策略旧备份最晚到期时间为 `2026-11-04T17:28:41.588Z`。

---

## 2. A 部分遗留：`outbox` 那条 `purge_tombstone` 为什么不动

它现在仍是 `status='pending', attempts=0`。

**原因：全仓找不到它的消费者。** `purge_tombstone` 只有**入队点**，没有任何出队/处理逻辑：

- `packages/memory/src/deletion.js:365-375` —— `enqueueOutbox(... kind:'purge_tombstone' ...)`（唯一入队点）
- `packages/memory/src/outbox.js:137` —— `createOutbox()` 只提供 `claim/complete/fail/recoverStale/retryDead` 这类**通用**原语，没有 `purge_tombstone` 的业务分支
- `packages/memory/src/consumers.js` —— 只处理 `project_event` / `summarize_session` 之类，**无 purge_tombstone 分支**
- `packages/memory/src/index.js:106` —— 只是构造了 `outbox` 门面，**没有任何循环去消费它**
- 全仓 `grep purge_tombstone`：只有 `outbox.js` 的注释、`deletion.js:368` 的入队、以及审计文档里提到它 pending

`deletion-worker.js` 的 `completeJob()` 在五步全绿时把 tombstone 标 `verified`，**但从不回写 outbox**（`deletion-worker.js:637-683`）。

**所以「跑 worker」永远不会让它变 done。** 它要么等一个不存在的主机去处理，要么被人工补标。

**我为什么不擅自 `complete()` 它**：`purge_tombstone` 的语义（"purge 墓碑"）全仓无定义；如果它本意是**物理清除墓碑行**，而我用 `complete()` 标 done，就是在库里记一条**假状态**——将来没人能分辨「purge 真做了」还是「被手动标了」。按「宁可不动也不能改坏」的纪律，把它作为缺陷上报，由 Lead 决定（见 §5 D1）。

附带缺陷：这行的 `deletion_epoch=0`，而 payload/job 都是 `1` —— `enqueueOutbox()` 的 INSERT 语句（`outbox.js:63-83`）**根本没写 `deletion_epoch` 列**，落的是 DDL 默认值 0。

---

## 3. 缺陷清单（A 侧，供 Lead 统一处理）

| # | 位置 | 缺陷 | 影响 | 建议 |
|---|---|---|---|---|
| **D1** | `deletion.js:368` + `outbox.js` + `consumers.js` | `purge_tombstone` **无消费者**，永远 pending | `/dsh-brain` 页面 outbox 计数永久非零；「删除闭环」永远差一步 | 三选一：(a) 在 `deletion-worker.completeJob()` 五步全绿时同步 `complete` 对应 outbox；(b) 写真正的消费者并定义语义；(c) 明确它是遗留项，加注释 + 页面不显示 |
| **D2** | `outbox.js:63-83` | `enqueueOutbox` INSERT 未写 `deletion_epoch` 列 | 该行 `deletion_epoch=0`，与 payload 的 1 不一致；按 epoch 筛 outbox 的逻辑会漏 | INSERT 补该列 |
| **D3** | `deletion.js:518` `runPurgeWorker` | M1 老 worker 不按 `kind` 分发，把 `scrub_index` 等当 `purge_text` 跑完就标 done | 若有人误用它会得到**假闭环**（job 全 done 但 FTS 仍残留） | 要么删掉这个入口，要么让它对非 `purge_text` 的 kind 显式 `failed`（文件头注释是这么写的，代码没做到） |
| **D4** | 全局 | **没有任何定时/启动钩子跑 deletion worker**（`index.js` grep `createDeletionWorker` / `runOnce` 无命中，只有 `restore.js:875` 用过） | 这次 10-28 的删除卡了两天就是这么来的：每次删除都只排队，没人消费 | 在插件加载时挂一个低频 drain，或至少提供一个 CLI/路由入口 |

---

## 4. B 部分：自动提取零触发诊断

### 4.1 三选一结论

> **「根本没跑到」** —— 精确地说：**事件 handler 跑到了，但提取链路在第一个判定点（turn 匹配）就静默返回，永远到不了 `record()`。**

排除了另外两种：

- ❌ **不是「规则不命中」**：`extractCandidates()` 在注入块上命中率极高（见 §4.4），在构造样本上也能命中（`记住以后都用 pnpm` → `remember-verb / "以后都用 pnpm"`）。如果是规则不命中，`record()` 至少会落 `skipped_quota` / `skipped_disabled`，或者根本不落——但**真正的判别证据是下面第 5 条：candidates 空且 skipped=null 时 index.js 直接 return，一行都不落**。
- ❌ **不是「写盘失败」**：`record()` 从头到尾**没被调用过**（`auto-extract.jsonl` 文件不存在本身就是证据：`record()` 里 `ensureDir()+appendFile` 只要有 status 就会建文件；而 `status` 有默认值 `'unknown'`，不会因缺字段跳过写盘）。

### 4.2 证据链（逐条实测）

**(1) `session/event` 钩子确实挂上了 —— 反证法成立**
`index.js:363-367` 在**同一个 `ctx.on('session/event', …)` 回调**里依次调 `usedLaterTracker.handleSessionEvent()` 与 `autoExtractOnEvent()`。`data/logs/used-later.jsonl` 有 27 行真实记录（最后一条 `2026-10-30T11:55:03.659Z`, `sessionId=session-0aefdb13-…`, `turn=13`）⇒ **该回调一定被执行过** ⇒ `autoExtractOnEvent` 一定也被调用过。

**(2) `turn/end` 到达了，且 `reason.kind === 'completed'` —— 这道闸不是断点**
解压真实会话 `~/.dsh/sessions/--E-ds-h--/session-0aefdb13-40f5-4b11-88ba-1f76812e5520/session.v4.jsonl.zstd`（1,978 帧 / 3,337 行）实测：

```
turn/end 数: 14 | reason.kind 分布: [["completed",12],["aborted",1],["interrupted",1]]
turn/end 样例: turn=1 reason={"kind":"completed"}
```

⇒ `index.js:348` 的 `String(reasonKind) !== 'completed'` 判断对绝大多数回合**是通过的**。宿主类型定义也确认 `completed` 是合法变体（`@deepseek-ai/dsh-session/lib/types/types.d.ts:166-209` 的 `TurnEndReasonMap`）。

**(3) 真正的断点：`user/message` 事件的 data 里没有 `turn` 字段**

实测同一条 `user/message` 事件：

```
data 顶层键: content, source, role, id
data.turn = undefined  (typeof undefined)
data.role = "user"
```

对照宿主类型（`SessionEventMap`）：
- `'user/message': UserMessage;` ← **没有 turn**
- `'assistant/message': { turn: number; step: number; message: … }` ← 有 turn
- `'turn/end': { turn: number; reason: TurnEndReason; }` ← 有 turn

于是整条链路是这样的：

| 步 | 位置 | 行为 |
|---|---|---|
| ① | `index.js:334` | `turn = typeof data.turn === 'number' ? … : null` → **`turn = null`** |
| ② | `index.js:342` | `noteUserMessage(sessionId, **null**, text)` ⇒ 缓存条目 `{ turn: null, text }`（`auto-extract.js:530` `item.turn = turnKey(null) = null`） |
| ③ | `index.js:349` | `runAutoExtract(sessionId, **13**)`（turn/end 的 `data.turn` 是数字） |
| ④ | `auto-extract.js:581` | `matched = list.filter(it => it.turn === wantTurn)`，`wantTurn="13"` vs 全部 `it.turn=null` ⇒ **`matched.length === 0`** |
| ⑤ | `auto-extract.js:582` | `return { candidates: [], skipped: **null** }` （**静默，不报任何原因**） |
| ⑥ | `index.js:240-249` | `candidates.length === 0`；`skipped` 既不是 `'quota'` 也不是 `'disabled'` ⇒ **直接 `return`**，**不调 `record()`** ⇒ `auto-extract.jsonl` 永不被创建，库里永远 0 条 `producer='brain-tools:auto-extract'` |

**(4) 复现实验（铁证）**
`E:\ds-h\tmp\repro-autoextract.mjs`，用**真实的 `createAutoExtractor`**：

```
场景 A（现状：noteUserMessage turn=null，judgeTurn turn=13）
  extractCandidates 单独跑命中数: 2
  judgeTurn 结果: {"candidates":[],"skipped":null}      ← 一行都不落

场景 B（假设 turn 能对上：两边都传 13）
  judgeTurn 结果: [{"rule":"remember-verb","content":"以后都用 pnpm"}]
```

⇒ **规则是好的，写盘是好的，唯一致命的是 turn 对不上。**

**(5) 进程是否加载了这段代码 —— 排除了「代码根本没进进程」这一层**

- profile 里 `~/.dsh/profiles/web/node_modules/@dsh-brain/brain-tools` 是 **Junction 软链** → `E:\ds-h\dsh-brain\apps\brain-tools`（不是拷贝副本），所以进程加载的就是磁盘版文件。
- 3080 进程启动 `2026-10-30 22:25:43`；`auto-extract.js` mtime `2026-10-30 19:59:47` **早于启动**。
- `/dsh-brain/api/usage?days=1` 在 3080 上 **HTTP 200**，插件活着。
- `index.js` 现在的 mtime `23:48:33` **晚于启动**（Lead/他人刚改过），所以当前进程跑的是 22:25 那版；但 22:25 那版必然已 import `auto-extract.js`（后者 19:59 就落地了）。
- ⚠️ **诚实说明**：无法从外部 100% 证明 22:25 那版 `index.js` 含挂载段（无 stderr 日志文件、无 git 仓库、`[外置大脑 · 运行时提示]` 注入在其后 13 个 completed turn 里 0 出现——但该注入走 `system-prompt/assemble` 的 contexts 通道，未必物化成 `user/message`，**不能据此否定加载**）。**不过这层不影响结论**：即使加载了，也必然零触发——§4.2(3) 的 turn 不匹配是充分条件。

### 4.3 真实语料命中率（决定性补充）

对当前进程生命期（22:25:43 之后被写过的 10 个会话）实测：

```
completed turn/end 总数 : 13 | 非 completed: 3
user/message 主人手打   : 23 条
user/message 注入块     : 144 条
```

用 `extractCandidates` 逐条跑：

| 类别 | 条数 | 命中 | 命中规则分布 |
|---|---|---|---|
| **主人手打** | 23 | **0** | {}（空） |
| **注入块**（system-reminder / `Current runtime context` / `<engram_profile>` / Team message / Background subagent） | 144 | **91** | `always-use: 90`、`switch-to: 1` |

⇒ 就算把 turn 修好，**主人这 23 条真实消息一条都提取不出来**（这批全是干活对话：`继续推进`、`治理面板不要输入命令打开`、`你把dsh软件杀死了`、`写到交接文档 之前的那些都可以开工了`……没有一条带「记住/以后都/改成/我的X是Y」句式）。

### 4.4 🔴 更严重：修好 turn 会立刻灌进垃圾记忆

注入块命中 91 条，其中 **90 条是同一个内容**：

```
HIT always-use "不得执行"  <=  "Current runtime context. This snapshot supersedes earlier ..."
```

原因是 `[外置大脑 · 运行时提示]` 之外的那些注入块（`autoExtractOnEvent` 里 `isOurHint` 只挡 `'[外置大脑 · 运行时提示]'`，`index.js:341`）会**以 user/message 形态回灌**，而它们内部含「不得执行」这类指令文本，正好命中 `always-use` 规则的 `一律` 触发词。

**这直接违反 CONTRACTS §18.6 的同源纪律**：把注入的运行时指令当成「主人定下的长期规则」写进 `type='profile'` 的记忆。`brain_search` 以后会把这些当成主人的偏好召回。

次生问题：`MAX_MESSAGES_PER_SESSION = 4`（`auto-extract.js:49`），而实测每 turn 平均 6+ 条 `user/message`（144 注入 + 23 手打 / 13 turn ≈ 12.8 条/turn），**注入块会把主人的话挤出缓存**。

### 4.5 处置建议（未改 `index.js`，交 Lead 决策）

按优先级：

1. **P0｜turn 关联**
   `user/message` 没有 `turn`。两条路，推荐第一条：
   - **① 不要用事件 turn 关联**：`index.js:342` 改成调 `noteUserMessage(sessionId, null, text)` 之外，`index.js:349` 改调 `runAutoExtract(sessionId)`——即 `judgeTurn({ sessionId })` 不传 turn，直接走 `auto-extract.js:581` 已有的 `wantTurn == null ? list.slice(-1)` 分支（取该会话最后一条消息）。**一行改动，语义正确**（"这一回合主人最后说了什么"）。
   - ② 自己在 `turn/start` 事件里维护 `sessionId → turn` 映射（多一处状态，多一处可能不同步）。
2. **P0｜可观测性**
   `index.js:240-249` 现在只有 `quota`/`disabled` 落 record。**所有**「判定过但没产出」的路径都要落，建议加 `status:'no_candidate'`（并在 `auto-extract.js` 的 `record()` 白名单里允许该值）。否则以后任何零触发都仍然无法从日志分辨。
3. **P0｜注入块隔离**（比 turn 更危险）
   `autoExtractOnEvent` 的 `user/message` 缓存条件是 `text.length > 0 && !isOurHint`，太宽。建议改成「只缓存真·主人输入」：排除 `^<system-reminder`、`^Current runtime context`、`^<engram_profile`、`^<engram_recall`、`^Team message`、`^Background subagent`、`sent a message:`、`^Evidence gate:`（本次审计实测这 8 类覆盖了全部 144 条注入）。**或者更稳**：让宿主侧区分「真人输入」与「注入快照」，cache 只吃前者。
4. **P1｜缓存容量**
   `MAX_MESSAGES_PER_SESSION=4` 在注入块场景下不够；修完 (3) 后可以维持不动，否则建议提到 ≥8。
5. **P2｜日志路径**
   `auto-extract.js:77` `DEFAULT_AUTO_EXTRACT_LOG` 是硬编码绝对路径 `E:/ds-h/dsh-brain/data/logs/auto-extract.jsonl`；`index.js:208` 已支持 `config.autoExtractLogPath` 覆盖，可接受，但建议与 `used-later` 同风格（由 config 兜底、默认值用相对 repo 根）。

---

## 5. 使用到的脚本（均在仓库外 `E:\ds-h\tmp\`，可复跑）

| 脚本 | 作用 | 写库？ |
|---|---|---|
| `backup-before-deletion-fix.mjs` | SQLite 在线 backup + `inspectSnapshotFile` 校验 + 修复前状态固化 | ❌ 只读源库 |
| `deletion-probe-readonly.mjs` / `deletion-probe2.mjs` / `deletion-probe3.mjs` | 现状只读探针（jobs / outbox / tombstones / FTS / versions / audit） | ❌ readOnly |
| `drain-deletion.mjs` | 删 worker `runOnce()` 驱动（支持 `--inspect` / `--apply --rounds=N`） | ✅ 唯一写库入口 |
| `verify-deletion-fix.mjs` | 前后对照验收（生产检索同款 FTS 路径） | ❌ readOnly |
| `probe-autoextract2.mjs` | 多帧 zstd 会话解码 → turn/end 形状 + 规则命中 | ❌ 只读 |
| `repro-autoextract.mjs` | turn 关联失败的决定性复现（真实 `createAutoExtractor`） | ❌ 临时 logPath |
| `probe-process-loaded.mjs` | 进程生命期内 completed turn/end 计数、注入块 vs 手打统计 | ❌ 只读 |

补充：DSH 的 `session.v4.jsonl.zstd` 是**一行一个 zstd frame**追加写的，`zlib.zstdDecompressSync()` 直接解只出第一帧（header）。需按 `28 b5 2f fd` magic 切帧逐段解压——`probe-autoextract2.mjs` 里有可复用实现。

---

## 6. 最终库状态快照（2026-10-30 23:56）

```
memories       : 218 active / 7 superseded / 1 deleted（共 226）
被删那条        : status=deleted, content IS NULL, summary IS NULL, content_hash IS NULL
memory_versions: 正文已清
deletion_jobs  : 5 条全 done, attempts=1, last_error=NULL
deletion_tombstones: 1 条 status=verified, deletion_epoch=1, ledger_synced_at 已写
outbox         : 1 条 purge_tombstone **仍 pending**（缺陷 D1，见 §2）
search_fts_char / trigram / ngram: 该 doc_id 零残留
PRAGMA integrity_check: ok
备份           : data/backups/manual-before-deletion-fix-20261030-234905.db
```
