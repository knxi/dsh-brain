# 主动社交 3 类来源落地（task-7）

> 责任人：social-sources · 日期：2026-10-31 凌晨
> 写作用域：`packages/persona/src/social.js`、`apps/brain-tools/persona-page.js`、
> `tests/m8/social/`（新建）、`docs/audit/fix-社交来源.md`
> 未触碰 `apps/brain-tools/index.js`（Lead 独占）。生产库只读：dry-run 在**副本**上跑，原库零写入（`size`/`mtime` 前后一致，脚本自检输出 `sourceDbUnchanged: true`）。

---

## 一、结论（先行）

| 来源 | 结论 | 一行理由 |
|---|---|---|
| `shared_memory`（共同记忆） | **已实现** | 依据真实存在：`memories` 里按**事件时间** `COALESCE(valid_from, created_at)` 算年龄 ≥ 7 天、`importance ≥ 0.6`、`recall_count = 0`、正文带数字/路径/书名号或挂着实体；生产库 dry-run 产出 1 条（score 80，evidence = 真实 memory id）。 |
| `verification`（求证） | **已实现** | 依据真实存在：`source_type = 'observation'` 且（`confidence < 0.85` 或一条出处都找不到）；生产库 dry-run 产出 1 条（score 78，引用 observation 原文 + 真实置信度）。 |
| `curiosity`（好奇） | **保持 `not_implemented`，但写清缺什么** | 生产库 `reflections` **0 行**（kind 枚举里也没有 `curiosity`），实体侧 76 个单条实体里 41 个 `tool`/29 个 `other`，大量是自动抽取的代码标识符（`task-7`/`search_fts_char`/`proves_wire_delivery`）。拿这些当话题就是拿关键词冒充好奇。 |

> 另外：**四类原有来源（schedule / unfinished_care / commitment / discovery）一行未改**，只在其后追加了新的生成块；`tests/persona/social.test.mjs` 里那 28 条原有断言全绿（改动见第五节）。

---

## 二、判据（这才是「依据」，不是文案）

### 2.1 时间轴：`valid_from` 才是事件时间，不是 `created_at`

这是本次最关键的一处判据修正（Lead 指出，已独立复核）。

| 列 | 范围（生产库 226 条） | 含义 |
|---|---|---|
| `created_at` | 2026-10-28 ~ 2026-10-30 | **导入那一刻**（从 Engram 迁进来的 205 条全落在这个窗口） |
| `valid_from` | 2026-10-15 ~ 2026-10-28，21 条为空 | **真实发生时间** |

用 `created_at` 判年龄，会把这 205 条历史全算成「两天前刚聊过」，于是「共同记忆」永远空转——那正是「字段选错」冒充「数据不够」的典型样子。心海（`/dsh-brain/sea`）的时间轴踩过同一个坑，也是改用 `validFrom` 的。

```js
export const MEMORY_EVENT_TIME_SQL = 'COALESCE(valid_from, created_at)';
```

### 2.2 `shared_memory` 五道筛

按事件时间实测的分布（只读 SQL，生产库）：

| 事件年龄门槛 | 满足 `importance ≥ 0.6` + `recall_count = 0` + `semantic/episode` |
|---|---|
| ≥ 3 天 | 43 条 |
| ≥ 7 天 | **42 条** |
| ≥ 14 天 | 3 条 |

门槛取 **7 天**（方案 §7.5 原口径是 14 天）：当前库的事件时间跨度只有 13 天，14 天窗口只剩 3 条、几乎永不触发；7 天窗口 42 条，既覆盖真实数据又没丢掉「别复读刚聊过的话」的本意。**等库龄满 30 天回到 14 天**，`social.js` 里留了 TODO。这是判据与数据现实对齐，不是为了让 dry-run 好看而放宽——复核方式就是上表。

细分判据：

1. **时间轴**：`COALESCE(valid_from, created_at)`，解析不出的脏数据直接跳过；
2. **年龄**：≥ 7 天（`SHARED_MEMORY_MIN_AGE_DAYS`）；
3. **没被用过**：`recall_count = 0`——一直记着、一直没机会提，才是这一类该补的话；已经被检索翻出来过的，对方刚在上面聊过；
4. **重要性**：`importance ≥ 0.6`（`SHARED_MEMORY_MIN_IMPORTANCE`），且 `type ∈ {semantic, episode}`（`profile`/`skill`/`boundary` 是稳定事实，没有「回顾」的语义）；
5. **具体锚点**：正文含数字、或 `《》`/`「」`、或路径，或挂着至少一个实体（`memory_entities`）。没有锚点的句子回顾起来只剩空话——这是「编造共同记忆」的入口。
   - 实测：42 条里有 33 条挂实体、27 条正文含数字，锚点不是稀有事件。
6. **去重与冷却**：`topic = shared_memory:<memoryId>`，30 天内已在 `social_candidates` 出现过就不再产；同一来源**每天最多 1 条**（读当天 `social_candidates`，不另造配额表）。

文本模板（`10月15日定下的事我还记着：「<记忆里的真实片段 40 字>」——还照这个来吗？`）：

- 片段来自 `summary`/`content` 原文，摘要为空就跳过（宁可不产，也不拼一句没出处的话）；
- 日期由事件时间按 `Asia/Shanghai` 渲染（`monthDayOf`）；
- `evidence` 只放真实 `memory.id`，不放正文。

### 2.3 `verification` 两个进池条件

| 条件 | 依据 | 生产库实测 |
|---|---|---|
| `source_type = 'observation'` 且 `confidence < 0.85` | 本系统把「读文档/看代码学到的结论」标成 `observation`，它天生就该被对一次账 | 8 条，`confidence` 全为 0.80，全部命中 |
| `source_type = 'observation'` 且一条出处都找不到（`source_refs` 计数为 0） | 找不到出处的结论更该核 | 0 条（225 行 `source_refs` 覆盖了它们），分支保留以防数据退化 |

**为什么不收 `owner_words`**：那是主人亲口说的，不需要我去求证；也不收 `inference`（系统推的，问了也白问）。`source_refs` 表缺失时自动退回「不带出处计数」的查询，不抛错。

文本：`这条我记的是「<原文片段>」，置信度只有 0.80——现在还准吗？`（找得到出处但没出处时改写成「却一条出处都翻不到」）。同样有 30 天 topic 冷却与「每类每天 1 条」。

### 2.4 `curiosity`：为什么不做，以及缺什么

实测（只读）：

| 数据源 | 实测 | 能不能支撑「好奇」 |
|---|---|---|
| `reflections` 表 | **0 行**；schema 的 `kind` 枚举里也**没有** `curiosity`，只有 `knowledge_gap`/`pattern`/`diary`… | ✗ 没有一条「我想追问」的反思产出 |
| `entities`（单条记忆实体） | 117 个实体里 76 个只挂 1 条记忆；kind 分布 `tool 41` / `other 29` / `concept 28` / `project 18` / `person 1` | ✗ 名字大多是抽取器抓出来的代码标识符（`task-7`、`search_fts_char`、`proves_wire_delivery`、`契约 10.2`），拿它去问「这个是什么」就是拿关键词冒充话题 |
| `recall_count` | `status='active'` 的 226 条里 218 条为 0 | △ 只能说明「没被检索过」，不能说明「值得追问」 |

所以这一类**保持 `not_implemented`**，但不再只写一个词——`SOCIAL_SOURCE_STATE.curiosity.missing` 里写清了缺什么，页面直接渲染它：

> 缺「未展开话题」的机器可读来源：reflections 表 kind 枚举里没有 curiosity/knowledge_gap 的实际产出（生产库 reflections 0 行），实体侧 76 个单条实体里大部分是自动抽取的代码标识符（task-7 / search_fts_char / proves_wire_delivery），拿它们当话题就是拿关键词冒充好奇。等反思引擎真产出 knowledge_gap、或实体抽取能标出「值得追问」，这一类才做得成。

**打开这一类的两个前置条件**（照这个顺序做就行）：
1. 反思引擎（`reflections`）真的产出 `knowledge_gap` 且 `status ∈ {candidate, promoted}`；
2. 实体抽取能标注「这个实体只是一句话带过、值得追问」，而不是只给名字。

---

## 三、实现落点

### 3.1 `packages/persona/src/social.js`

| 位置 | 改动 |
|---|---|
| 常量区 | 新增 `SHARED_MEMORY_MIN_AGE_DAYS=7`（带 14 天 TODO）、`SHARED_MEMORY_MIN_IMPORTANCE`、`SHARED_MEMORY_TOPIC_COOLDOWN_DAYS`、`MEMORY_EVENT_TIME_SQL`、`VERIFICATION_MAX_CONFIDENCE` |
| 常量区 | 新增 `SOCIAL_SOURCE_STATE`（七类的实现状态 + 依据来自哪张表 + 没实现缺什么）；`SOCIAL_SOURCES_IMPLEMENTED` / `SOCIAL_SOURCES_PENDING` 由它推导——**不再手写第二份清单** |
| 纯函数 | 新增 `concreteAnchorOf(text, entityCount)`（锚点判定，可单测） |
| `collectDrafts` | 新增 **5) shared_memory**、**6) verification** 两个生成块；新加 `topicSeenWithin()`（30 天话题冷却）与 `sourceAskedToday()`（每类每天 1 条）两个内部 helper |
| `collectDrafts` | 「未实现的来源」循环从 `PENDING_SOCIAL_SOURCES` 改用 `SOCIAL_SOURCES_PENDING`，且 reason 带上缺什么（`{source, reason, detail}`） |
| `generate` / `preview` | `pendingSources` / `implementedSources` 改用动态推导值，并新增 `sourceStates`（页面读它，不再读静态快照） |

> 为什么没改 `util.js` 的 `IMPLEMENTED_SOCIAL_SOURCES` / `PENDING_SOCIAL_SOURCES`：写作用域不含它，
> 且那两个常量是「本轮实现了什么」的历史快照。新的真相源是 `SOCIAL_SOURCE_STATE`，
> `social.js` 返回值已全部改用它；旧常量仅为兼容老调用方保留（并在返回对象里注明）。

### 3.2 新增测试 `tests/m8/social/`（2 个文件）

- `helpers.mjs`：临时主账 + 真 workspace + persona 门面；`insertMemoryRow` 能按需写
  `type / source_type / confidence / importance / valid_from / recall_count`（这些正是本次判据的输入，
  默认值刻意「不满足任何一类」，逼用例显式声明）；
- `sources.test.mjs`：18 条用例，覆盖
  - `shared_memory`：有依据产、太新不产、无锚点不产、实体当锚点、30 天 topic 冷却、每类每天 1 条、
    类型/重要性门槛、**valid_from 时间轴**（2 天前导入 / 20 天前发生 → 必须产，日期必须渲染成 10 月 10 日）、
    `recall_count > 0` 不回顾；
  - `verification`：observation 低置信度产、`owner_words` 不进池、有出处高置信不产、无出处也核；
  - `curiosity`：**塞了 `knowledge_gap` 反思也一条都不许产**，且 reason/detail 必须说清缺什么；
  - 来源状态自洽、锚点纯函数、原有四类不被带跑、`persist:false` 零落表、`persist:true` 用真实 id。

### 3.3 `apps/brain-tools/persona-page.js`

1. **「三类来源还没实现」写死文案删掉**，改成由数据生成：`来源实现 6 / 7` + 已实现来源 chip（hover 显示依据来自哪张表）+ `好奇：仍缺依据` chip（hover 显示缺什么），下方一行完整说明。**页面里没有任何一个写死的实现数量**。
2. **每个候选卡加两个按钮**：
   - 「试发（不真发）」→ `POST /dsh-brain/api/persona/social/send { id, mode:'dry_run' }`；
   - 「批准并发送」→ 两步确认：第一次点只把**后果**写在卡片上（会过哪些闸、会写哪条记录、落到哪个文件、不发往第三方），**3 秒不点自动退回**；第二次点才 `mode:'approved'`。
   - 只给**已落表**（有候选 id）的卡片按钮；预演候选（没 id）显示「这条是预演（没落表），拿到候选 id 之后才能试发 / 批准发送」——给它按钮只会点出一句报错。
3. **发送结果贴在卡片里**（不用顶部那块）：成功 / 被闸门拒的 `result.reason` / 服务端 `note` / `sendId` 四样照实写；服务端 `ok:false` 一律渲染成「没发出去：<原因>」，**不假装成功**。
4. `skipped` 的 chip 只放摘要，完整原因（例如 curiosity 那一段）挂 `title`，不撑版面。

渲染实测（生产库副本 + `persist:true` 落 2 条候选后走真实 `collectPersonaView` + `renderPersonaPage`）：

```json
{ "sourceStatusLine": true, "implementedCount": ["6", "7"], "pendingChip": true,
  "pendingExplain": true, "sendDryButton": true, "sendApprovedButton": true,
  "sendOutBox": true, "noStaleCopy": true, "noFalseSuccess": true,
  "sendEndpoint": true, "armTimeout3s": true, "candidateText": true }
```

预演候选（无 id）走另一条分支实测：`hint: true`、`noButtonsOnFresh: true`、`detailInTitle: true`、`statusCount: ["6","7"]`。

> 备注：本次**只在渲染层验证**了按钮与结果区。真实 HTTP 往返（`/api/persona/social/send`）由 Lead 在
> `index.js` 里接线，端到端点击没有在本机浏览器里实跑——这一条如实记在这里，不算已验证。

---

## 四、生产库 dry-run 实测

严格只读：把 `data/brain.db` 复制到临时目录，在**副本**上 `openBrain` + `generate({persist:false})`；
原库 `size`/`mtime` 前后一致（脚本自检 `sourceDbUnchanged: true`）。

- 库规模：`memories 226` / `entities 117` / `memory_entities 197` / `reflections 0` / `social_candidates 0`
- 开关：`paused=0`、`social.enabled=1`、`social.allow_external=1`、`denied=null`
- 本地时间：`2026-10-31 00:43`

### 每类产出

| 来源 | 产出 | topic | evidence | score | status / reason |
|---|---|---|---|---|---|
| `shared_memory` | 1 | `shared_memory:mem_5c62e8d733f95b86c437a96f` | `["mem_5c62e8d733f95b86c437a96f"]` | 80 | `rejected / night_hours` |
| `verification` | 1 | `verification:mem_9cd543c3ce7c9cdf7ef1479d` | `["mem_9cd543c3ce7c9cdf7ef1479d"]` | 78 | `rejected / night_hours` |

产出文本（原文照抄）：

```
[shared_memory] 10月15日定下的事我还记着：「dsh-grsai-canvas 画布插件的当前任务是：全面审查并优化代码（找…」——还照这个来吗？
[verification]  这条我记的是「外置大脑的目标：补齐能力后卸载 Engram 与灵枢」，置信度只有 0.80——现在还准吗？
```

`status=rejected / night_hours` **不是新来源的问题**：dry-run 跑在本地 00:43，命中既有硬闸「0–6 点不打扰」（`NIGHT_START_HOUR=0`, `NIGHT_END_HOUR=6`）。两条的分数 80 / 78 都已过门槛（55），白天重跑会进入 `scored`。

### 每类跳过原因（原文）

| 来源 | reason |
|---|---|
| `curiosity` | `not_implemented（缺「未展开话题」的机器可读来源：reflections 表 kind 枚举里没有 curiosity/knowledge_gap 的实际产出（生产库 reflections 0 行），实体侧 76 个单条实体里大部分是自动抽取的代码标识符…）` |
| `schedule` | `outside_active_hours（当前 00:43 不在 12–19 点作息内）` |
| `unfinished_care` | `no_care_evidence（近 14 天没有身体/情绪/具体安排类线索）` |
| `commitment` | `no_open_commitment（没有未完成的承诺）` |
| `discovery` | `no_recent_result（近 6 小时没有真实结果事件）` |

`implementedSources`（6）：`schedule, unfinished_care, commitment, discovery, shared_memory, verification`；
`pendingSources`（1）：`curiosity`。

---

## 五、测试

```
node --test "tests/**/*.test.mjs"               → 1007 pass / 0 fail（原有 989 + 本次新增 18）
node --test "tests/m8/social/*.test.mjs"        → 18 pass / 0 fail
node --test tests/persona/social.test.mjs       → 28 pass / 0 fail
```

### 唯一一处需要改动的既有测试（Lead 已授权）

`tests/persona/social.test.mjs` 原来把「三类都没做」写死成断言：

```js
for (const pending of ['shared_memory', 'verification', 'curiosity']) {
  assert.match(generated.skipped.find((i) => i.source === pending).reason, /not_implemented/);
}
```

实现之后这句必然红（`shared_memory` 的 reason 是 `no_shared_memory_evidence（…）`）。已按 Lead 授权的口径改成
「**每一类都要有说法**」：实现了的两类必须给具体理由且**不许**再报 `not_implemented`；`curiosity` 仍必须如实说「没做」。
同一用例里「candidates 恰好四类来源」那句断言**没红也不需要改**——fixture 里三类新来源都不满足条件，行为面没被污染。

---

## 六、残余与已知边界（如实记录）

1. **`util.js` 的两个静态常量仍是旧值**：`IMPLEMENTED_SOCIAL_SOURCES` 还写着四类、`PENDING_SOCIAL_SOURCES` 还写着三类。写作用域不含该文件，`social.js` 的返回值已全部改用 `SOCIAL_SOURCE_STATE`。`packages/persona/src/index.js:233` 的 `sources: { implemented, pending, all }` 仍直接 re-export 旧常量——**那一处会显示过期状态**，需要后续在 `util.js` / `index.js` 里同步（不在本次范围）。
2. **端到端点击未实跑**：页面按钮的 HTTP 往返依赖 Lead 的 `/api/persona/social/send`，本次只做了渲染层验证与接口契约比对（路径 / `{id, mode}` / `X-Brain-Action: 1` / 返回 `{ok, mode, result, note}`）。
3. **`shared_memory` 的 7 天门槛是临时值**：库龄满 30 天后回到 14 天（`social.js` 里 TODO + 理由）。复核方法：跑第二节那张分布表。
4. **`verification` 的「无出处」分支当前 0 命中**：生产库 225 行 `source_refs` 覆盖了 8 条 observation。分支保留，但它在真实数据上**尚未被触发过**——只被测试覆盖。
5. **`curiosity` 是数据侧缺口，不是代码侧 TODO**：见 2.4 的两个前置条件。
