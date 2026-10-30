# M2 记忆层实现笔记（memory2）

> 交付：记忆门面 + 三套 FTS 集成 + 四种检索不足 + 删除屏障 + asOf 时点回看。
> 对应任务：`task-5`（M2-A）。接口契约见 `docs/M2-INTERFACES.md` §1。
> 实测环境：Node v24.19.0 / `node:sqlite` / SQLite 3.53.3 / 纯 ESM + JSDoc / `node --test`。

---

## 0. 验收结果

| 命令 | 结果 |
|---|---|
| `node --test "tests/m2/memory/*.test.mjs"` | **103 pass / 0 fail** |
| `node --test "tests/contract/*.test.mjs"` | **72 pass / 0 fail**（基线 70，净增 2，无 skip） |
| `node --test "tests/search/*.test.mjs"` | **29 pass / 0 fail**（基线 25，净增 4：段间 AND 回归，见 §8） |

---

## 1. 交付物

### 1.1 新增源码（`packages/memory/src/`）

| 文件 | 内容 |
|---|---|
| `memories.js` | `memories` 门面：create / update(CAS) / supersede / get(asOf) / list / search / reindexAll |
| `sources.js` | `sources` 门面：link / forMemory / verify |
| `snapshots.js` | `snapshots` 门面：save(CAS) / load |
| `summaries.js` | `summaries` 门面：create / get |
| `search-bridge.js` | memory → search 的桥：构造 `SearchIndex`、探索引可用性、route→matchedBy 映射 |
| `memory-util.js` | 参数校验、时间规范化、行映射、`CasConflictError` |

### 1.2 修改

- `packages/memory/src/index.js`：`openBrain()` 返回值新增 `memories` / `sources` / `snapshots` / `summaries` / `searchBridge`；导出新模块。
- `packages/memory/src/migrator.js`：迁移文件名正则允许下划线（见 §4 坑 1）。
- `packages/memory/package.json`：加 `@dsh-brain/search` 依赖与子路径 exports。
- `migrations/0002_m2_memory.sql` + `0002_m2_memory.down.sql`：新增（见 §2）。

### 1.3 测试（`tests/m2/memory/`）

| 文件 | 覆盖 |
|---|---|
| `helpers.mjs` | 临时主账、固定时钟、合成语料（8 条，含尺寸/材质/图号/报价/英文标识符） |
| `facade.test.mjs` | 写读一致性、CAS 冲突、内容改动重建索引、supersede 链、list 键集分页与 scope 隔离 |
| `search-recall.test.mjs` | 中文两字/单字/短句、`1.2m`/`2400×600`/`90×54mm`、图号、代码标识符、不做数字等价推断、hits 结构、limit、空查询、secret 默认排除、scope 隔离 |
| `search-diagnostics.test.mjs` | 五种 status 逐一定位（ok / no_related / insufficient_evidence / source_missing / source_conflict）+ 优先级 + minCoverage 可调 |
| `search-index-wiring.test.mjs` | **索引通电金丝雀**：三张索引表 count 与 memories 行数逐一相等、两路单独调用可用、char/trigram 两套文本分工、reindexAll |
| `asof.test.mjs` | 半开区间边界、SQL 侧过滤、supersede 前后时点回看、时区偏移规范化、非法 asOf、倒挂窗口 |
| `deletion.test.mjs` | 删除后立即不可检索、**索引残留仍捞不出**、epoch 高于脏 status、幂等、派生摘要抑制、asOf 不漏删、只删目标 |
| `sources.test.mjs` | link/forMemory/verify 四种 reason、幂等、独立来源计数、防循环三条规则 |
| `snapshots-summaries.test.mjs` | 快照版本/CAS/分槽/删除、摘要 layer 映射/来源留痕/校验 |
| `schema-sync.test.mjs` | 0002 内联 DDL 与 search 包导出**逐表逐列逐索引逐 DDL 文本**一致、权重、新增列、schemaVersion |

---

## 2. 迁移 `0002_m2_memory.sql`

- `memories` 新增 `origin_system` / `producer` / `derived_from` / `causation_id`（防循环，CONTRACTS §10.6）
- `task_snapshots` 新增 `goal` / `done_steps` / `pending_steps`
- `summaries` 新增 `layer`
- 三套检索索引：`search_fts_char`（unicode61 + char-space）、`search_fts_trigram`（trigram + 原文）、`search_ngram`（自维护倒排 + `doc_id` 索引）
- `.down.sql` 对称回滚（先删索引再删列）

**幂等**：`CREATE ... IF NOT EXISTS` 天然幂等；`ALTER TABLE ... ADD COLUMN` 在 SQLite 没有 IF NOT EXISTS，幂等由 migrator 账本 + 单事务原子性保证（失败整体回滚，重试从干净状态开始）。这是照实写的实现边界，不是"假装幂等"。

---

## 3. `memories.search()` 实际签名与返回结构（其余三条线照这个联调）

```js
// 同步返回（写操作才是 Promise）
const result = brain.memories.search({
  query,              // unknown，任意输入；空/纯标点 → no_related
  scopeId,            // 必填（缺省取 openBrain 的 bindings.scope_id，再缺省 'owner-default'）
  personId,           // 可选；给了就要求相等
  asOf,               // 可选 ISO/Date/ms；带时区偏移会被规范化成 UTC
  limit = 10,         // 1..50
  includeExpired = false,
  includeSecret = false,   // 默认排除 privacy='secret'
  weights,            // 默认 { fts_char: 1, fts_trigram: 0.6, ngram: 0 }
  minCoverage,        // 默认 0.34
})

// 返回
{
  hits: [{
    memoryId, version, score,
    matchedBy: ('char'|'trigram'|'ngram'|'like')[],   // 空数组不会出现
    sourceRefs: [{ id, sourceKind, sourceSystem, sourceEventId, eventId, locator, contentHash }],
    evidenceKind: 'owner_words'|'observation'|'inference'|'web'|'tool'|'summary',
    validFrom, validUntil,                          // ISO 或 null
    layer, type,
    summary,          // 有就原样，没有就从 content 截 40 字符 + '…'（SUMMARY_FALLBACK_CHARS）
    contentHash,      // 'sha256:…'
  }],
  diagnostics: {
    status: 'ok'|'no_related'|'insufficient_evidence'|'source_missing'|'source_conflict',
    queryWasEscaped: boolean,   // true = 原样进 MATCH 会抛（含 " * ( ) : ^ . - / \ 之一）
    degraded: 'fts_unavailable'|'index_missing'|null,
    notes: string[],            // 人话解释：为什么是这个 status、被什么过滤掉多少条
    candidateCount: number,
    bestCoverage: number|null,
    routes: Record<string, { count, ok, reason? }>,  // count = 本次查询该路的候选数，不是索引行数
    primaryLaneHit: boolean,  // 额外字段：本轮是否有主路（char/trigram）命中，含分段补偿
  },
}
```

**给 context2 的两条约定**：
1. `status !== 'ok'` 时 **`hits` 仍可能非空**（`source_missing` / `insufficient_evidence`）。要不要注入看 `status`，不要看 `hits.length === 0`。
2. 判定顺序固定：`no_related`（hits 空）→ `source_conflict` → `source_missing` → `insufficient_evidence` → `ok`。

**写操作是 Promise**：`memories.create/update/supersede/reindexAll`、`sources.link`、`snapshots.save`、`summaries.create` 全部 `await`。读（`get/list/search`、`sources.forMemory/verify`、`snapshots.load`、`summaries.get`）同步。

**CAS 冲突**：抛 `CasConflictError`（`code = 'EVENT_CONFLICT'`，`details.cas === true`，带 `expectedVersion` / `actualVersion` / `id|taskId`）。看 `details.cas` 才准，不要只看 `code`（那是和事件幂等冲突共用的）。

---

## 4. 新踩的坑（都已修，写下来防复发）

1. **migrator 的文件名正则不允许下划线，导致 `0002_m2_memory.sql` 被静默跳过。**
   原正则 `^(\d{4,})_([a-z0-9][a-z0-9-]*)\.sql$` 不匹配 `m2_memory`。症状极隐蔽：`applyMigrations()` 返回 `applied: ['0001']`、不报错、不告警，迁移"加了个寂寞"。已放宽为 `[a-z0-9_-]*`，并加单测断言「带下划线的文件名必须被识别」。

2. **scope 过滤写在 JS 分支里 → 跨 scope 泄漏。**
   第一版只在「行没查到时」判断 `scope_id`，结果「查到了行」的候选完全没过 scope 校验，`search({scopeId:'owner-other'})` 能拿到别的 scope 的记忆。已把 scope 放进 `fetchRecallRows` 的 WHERE。这条是被 `scopeId 隔离` 单测抓到的。

3. **`contentHash()` 只接受 string/Buffer，不接受数组。**
   `ref_id` 想用结构哈希时直接传数组会崩。要用 `structureHash()`（canonical JSON 后哈希）。

4. **FTS5 虚表会生成影子表，破坏"表清单精确相等"的断言。**
   `search_fts_char` 会自动带出 `_data` / `_idx` / `_content` / `_docsize` / `_config` 五张表。契约测试的表清单断言必须显式放行这些影子表（正则），否则加索引就红。

5. **`ALTER TABLE ADD COLUMN` 没有 `IF NOT EXISTS`。**
   SQLite 不支持，所以迁移文件的"幂等"只能靠 migrator 账本 + 单事务原子性。已在 0002 头部写清，不用假的"幂等"措辞掩盖。

6. **`SearchIndex.sourceBackRefs()` 的跨记忆 ref 冲突规则对 memory 表不适用。**
   它把「同一 ref 挂到多个记忆」也算 `source_conflict`。但一个事件里说两件事是常态，两条记忆共享同一来源不该叫冲突，用它会天天误报。`memories.search()` 自己判来源（`judgeSources`），只保留两条真语义：同一记忆多指纹 = 冲突；无来源 / 来源事件已删 = 丢失。

7. **`derivedFrom` 里放原始事件 id 是正常用法，差点被一刀切误杀。**
   第一版规则是「`derivedFrom` 非空 + `sourceType=owner_words` → 拒绝」，把"这条记忆来自那个事件"也拒了。已改成只拦两种情况：`originSystem='brain'`（Brain 自己的产出）、`derivedFrom` 含 `ctx_*`（ContextPackage 注入载体）。

8. **`summary` 为 null 会让构包侧成片丢命中。**
   context2 把 `summary === null` 的命中当 `empty_summary` 丢掉（判断正确），但检索层不兜底就等于白检索。已在 `memories.search()` 里用 content 前 40 字符（按码点，中文不切半）兜底。

9. **「三张索引表 doc 数」必须由测试看着，不能靠"能搜到"判断。**
   char-space 主路如果没通电，ngram 兜底照样能让检索"看起来正常"，而中文召回会从 hit@10 100% 静默掉到 49.9%。已加 `search-index-wiring.test.mjs` 逐表 count 断言。

10. **多词长查询的「段间 AND」会让主路静默退化成弱路。**
    `buildFtsMatch('展板尺寸 铝板报价')` → `"展 板 尺 寸" "铝 板 报 价"`，要求同一文档里两个短语都连续相邻出现，实际几乎不可能 → char 路 0 候选，最后由权重 0 的 ngram 兜底。这时 status 还可能是 `ok`（bestCoverage 过线），**看起来正常，实际是最差的一条路**。详见 §6.5 与补偿实现。

---

## 5. 为什么改了契约测试（lead 要求留账）

### 5.1 `tests/contract/migrations.test.mjs`

**改前**（把「只有 0001」写死）：
- `applied` 必须 `deepEqual ['0001']`；`currentVersion === '0001'`
- 表清单必须**精确等于** 16 张必需表 + `brain_meta`
- `loadMigrations` 版本必须 `['0001']`；`listMigrations().length === 1`
- `rollbackLastMigration` 断言回滚的是 `'0001'`，且主表全消失

**改后**（断言的是真契约，不是字面量）：
- **版本动态推导**：`expectedVersions = loadMigrations(dir).map(version)`；断言「首次执行把磁盘上的迁移全部按序应用」「`currentVersion === 最后一版`」。目的从"版本号等于某个数"变成"迁移器报的版本和磁盘上的一致"——漏跑、多跑、顺序错都会红。
- **表清单不放松**：必需表仍逐个 `assert.ok(tables.includes(...))`；新增表走显式白名单 `EXTRA_TABLES`（`brain_meta` + 三张检索表）；FTS5 影子表用正则 `FTS_SHADOW_RE` 显式放行；**白名单外的表仍然报错**。管控强度不降。
- **回滚测试保留并加强**：断言「回滚最后一版 → `currentVersion` 前移到上一版 → 该版对象消失（0002 时断言 `search_fts_char` 与 `origin_system` 列消失、主表仍在）→ 记录 `direction='down'` 留痕 → 再 apply 能重建」。另加一条「连续回滚到底，再回滚报 `MIGRATION_ERROR`」的护栏测试。
- 新增「迁移文件名允许下划线」回归测试（坑 1）。
- 用例数：7 → 10（净增 3，无 skip）。

### 5.2 `tests/contract/backup.test.mjs`

**改前**：`assert.equal(snapshot.checklist.schema_version, '0001')`
**改后**：`assert.equal(snapshot.checklist.schema_version, ctx.brain.schemaVersion)`

理由：这条要断言的是「备份清单记录的版本 == 备份时库的版本」，不是某个具体版本号。写死 `'0001'` 会在每次 schema 演进时红，测不到任何东西。

**合同总数**：70 → 72 pass / 0 fail（净增 2，无 skip）。

---

## 6. 已知限制（诚实清单）

1. **检索是精确字符级**：`铜板` 不会命中 `铜版`（同音/错别字/繁简不在覆盖内，见 search 报告 §5）。
2. **不做数字等价推断**：`1200mm` 不会命中 `1.2m`（CONTRACTS §7 保留原始参数，等价换算要有转换依据，不在检索层做）。单测已按这个语义钉住。
3. **`source_conflict` 判定口径**：只认「同一记忆挂了两条内容指纹不同的来源」。来源之间跨记忆的关联复杂度未做建模。
4. **`asOf` 只过滤有效期，不重建历史状态**：`asOf` 能告诉你"当时那条记忆有效"，但不回放"当时它的 version 是几"。需要版本级回放时用 `memory_versions` 表。
5. **`memories.list()` 未传 status 时返回「除 deleted 外全部」**（管理视角，给检查器用）；`search()` 默认只要 `active`。两者口径不同是有意的，别混用。
6. **`snapshots` 是最小版**：只做版本 + CAS + 分槽，不做租约（lease）续期与 fencing 校验（0001 的列留着了）。
7. **多段长查询靠集成层补偿，不是 search 包原生能力**：段间 AND 是 `buildFtsMatch` 的既有语义，`memories.search()` 在「原查询主路 0 命中」时才按段重查 + RRF 合并（见 §4 坑 10）。代价是这类查询最多跑 6 次（`MAX_SEGMENTS`），单次查询成本上升；换来的是主路能命中而不是全靠 ngram 弱路。
8. **分段补偿不做跨段加权**：各段按 `fts_char` 权重 1 等权融合，不区分「主谓段更重要」这类语言学权重（当前语料下没有依据，不乱加）。

---

## 6.5 多段查询的语义边界与补偿（context2 联调暴露）

实测 `buildFtsMatch()` 的真实输出，不是推测：

| 输入 | 生成的 MATCH | 效果 |
|---|---|---|
| `铜版纸名片`（无空格） | `("铜" OR "版" OR "纸" OR "名" OR "片")` | 单段、5 token > 4 → **OR**，召回高 |
| `铜版纸 名片`（有空格） | `"铜 版 纸" "名 片"` | 两段 phrase + **段间隐式 AND** |
| `展板尺寸 铝板报价` | `"展 板 尺 寸" "铝 板 报 价"` | 要求同一文档里两个 4 字短语都连续相邻 → **char 路 0 候选** |

**反直觉的地方**：用户加空格本意是「分开找」，结果反而更严格。而主人真实工作语境里最常见的就是多词查询（「展板尺寸 铝板报价」「这版方案层高改成多少」），恰好落在最差的一类。

原设计的分歧点：search 包 adaptive 模式只按「**段内** token 数」决定 phrase / OR，**段间永远是 AND**，缺一层「段间 OR」。

补偿（在 `memories.search()` 里，不改 search 包）：

1. 只在「原查询 char 与 trigram 路都为 0 命中」且「段数 > 1」时触发；
2. **按段分头检索**，每段仍走 search 包的完整三路融合（不重写任何一路）；
3. 只采纳「该段自己也是主路命中」的结果，不把弱路抬成主路；
4. 用 search 包导出的 `rrfFuse` 合并（`fts_char` 权重 1）；
5. 段数上限 `MAX_SEGMENTS = 6`。

效果（实测）：

```
"展板尺寸 铝板报价"    -> hits=2  primaryLaneHit=true   routes.segmented={count:2, segments:2}
"展板尺寸 铝板报价 含税" -> hits=2  primaryLaneHit=true   routes.segmented={count:2, segments:3}
"展板"                -> routes.segmented 不存在（路径完全不变）
"铜版纸 名片"          -> routes.segmented 不存在（主路已命中）
"量子纠缠 退相干 玻色子" -> hits=0  no_related（不放宽证据判定）
```

同时补了**弱证据可见化**：`diagnostics.primaryLaneHit`（额外字段，只增不改）+ `notes` 人话说明。当主路 0 命中、结果全靠 ngram 兜底时，上层能看到「这是弱证据」，而不是拿到一个 status=ok 就以为是好结果。

回归测试：`search-recall.test.mjs` 的「多段长查询」一组 6 条（补偿生效、三段、单段不触发、无空格长查询不触发、不放宽证据判定、不抬弱路）。

---

## 7. 复现

```powershell
cd <repo>

# M2 记忆层
node --test "tests/m2/memory/*.test.mjs"

# 契约（不许回归）
node --test "tests/contract/*.test.mjs"

# 单看索引通电（最危险的那类静默降级）
node --test tests/m2/memory/search-index-wiring.test.mjs
```

---

## 8. 收口期补充（M2 集成后挖出的三件事）

### 8.1 `buildFtsMatch` 段间连接符的 FTS5 语法错（已修根因）

**现象**：`buildFtsMatch('展板成品尺寸 铝板厚度')` 生成

```
("展" OR "板" OR "成" OR "品" OR "尺" OR "寸") "铝 板 厚 度"
```

执行直接抛 `fts5: syntax error near ""铝 板 厚 度""`。

**根因**：FTS5 **不接受「括号组后面直接跟 phrase」**（空格＝隐式 AND）。纯 phrase 之间用空格合法，所以早期的多段测试（`展板尺寸 铝板报价`）没暴露。触发条件 = 多段查询里**前一段 token 数 > maxPhraseTokens（走 OR）、后面还有段**。

在纯 `:memory:` 虚表上钉过的语法事实（排除项目代码干扰）：

| 查询串 | 结果 |
|---|---|
| `("展" OR "板") "尺"` | ❌ syntax error |
| `("展" OR "板") AND "尺"` | ✅ hits 1 |
| `("展" OR "板" OR "成") "铝 板 厚 度"` | ❌ syntax error |
| `("展" OR "板" OR "成") AND "铝 板 厚 度"` | ✅ hits 2 |
| `"展 板" "铝 板"`（纯 phrase） | ✅ hits 1 |

**影响链**（真实 `openBrain()` 实测）：主查询崩 → `memories.search` 落进 `degraded='fts_unavailable'` → 只剩 ngram 弱路（P@10 49.9%）→ **status 仍是 ok**。看起来正常，实际是最差的一条路；而且它正好把分段补偿的触发条件（原为 `degraded === null`）挡在门外。

**修复**（两处，口径统一，`packages/search` 改动经 lead 授权）：
- `tokenize.mjs` `buildFtsMatch`：`parts.join(' ')` → `parts.join(' AND ')`；
- `index.mjs` `buildTrigramMatch`：同样改（它的 parts 全是纯 phrase，本来合法，但两处口径必须一致，否则哪天 trigram 加 OR 分支会重演）。

语义等价（空格本来就是隐式 AND），已验证 `AND` 形态与空格形态命中数一致。

**回归测试**（钉在 search 包自己的测试里，因为 bug 在 search 包）：`tests/search/tokenize.test.mjs` 新增 4 条 —— ① 底层 FTS5 语法事实；② `buildFtsMatch` 段间形态；③ `buildTrigramMatch` 口径；④ 六种危险输入（OR段+phrase、三段混合、长口语段+短段、图号+尺寸、代码标识符、六短段）生成的串**真的能被 FTS5 执行**。
另有 `tests/m2/memory/search-recall.test.mjs` 一条端到端闸门：断言 `degraded === null`、`primaryLaneHit === true`、`routes.fts_char.count > 0`、且 notes 里不再出现 `FTS5 查询失败`。

### 8.2 `primaryLaneHit=false` 的两种语义必须分开说

原来两种情况都落到 `false`，上层看不出区别：
- **(a) 主路正常但 0 命中**（长词被段间 AND 卡死）；
- **(b) 主路查询本身崩了**（FTS5 语法错），只能走 n-gram。

现在 notes 分开陈述，并且 `routes.segmented.recoveredFrom` 记录补偿是从哪种状态救回来的。分段补偿的触发条件同时从 `degraded === null` 放宽到 `degraded !== 'index_missing'` —— 主路崩了正是最该救的时候；`index_missing` 跳过（索引表都没有，段级检索也查不到）。补偿成功时 `degraded` 清回 `null`（最终检索能力没降级），但「原查询崩过」这个事实保留在 notes 里，不掩盖。

### 8.3 `0003_m2_context_evidence.sql`：构包的证据链列（为什么加）

**缺口**：0001 建 `context_packages` 时只有状态与时间戳，**没有地方放预算明细和 sent 判据**。后果是实的：
- `budget.brainAllowance` / `budget.dropped[]`（哪些段被丢、为什么）无处落地 → 控制台只能显示「本次未记录预算明细」，踩 M2 验收项「必有预算说明」；
- 契约 §10.9 要求 sent 判据查两级承载，但**结论落在哪一列没规定** → 检查器把 carrier 显示成「未记录」，证据链断一环。

**加了 8 列**（`attached_at` / `sent_at` 0001 已有，不重复加）：

| 列 | 含义 | 为什么必须单独存在 |
|---|---|---|
| `budget_json` | 整个 budget 对象（allowance / used / dropped[] / formula / estimated / tokenizerId / hostInputSource / notes） | 控制台要展示「被丢的段与理由」；`estimated` + `tokenizerId` 是「这是估算值」的唯一凭据，缺了就会把估算当精确 |
| `carrier` | `system` / `messages[role=system]` / `messages[user]` | 证据链上的**实际观测位置**，不是「服务端以为发了」 |
| `sent_evidence_json` | `evidence_level` / `proves_wire_delivery` / `observed_hash_locations[]` 等 | 「请求对象里找到了」≠「字节出网」，这个字段就是那句话的落地 |
| `evidence_strength` | `primary` / `ngram_fallback` / `unknown` | 单列出来供控制台做徽章与筛选（不塞进 JSON 才查得动） |
| `segments_json` | 逐段 `{ memoryId, version, layer, type, summary, contentHash, sourceRefs, ... }` | 检查器靠它还原「注入了什么」 |
| `diagnostics_json` | `{ status, reasons[], evidenceStrength, segmentedFallback }` | 「为什么降级」要能显示 |
| `injected_text_hash` | 注入文本的 sha256 | 见下方取舍 |
| `step_id` | 装配幂等键的第三段（契约 §10.1） | 0001 只有 turn_id，缺 step 就定位不到「同一轮第几个 step 的包」 |

**刻意不落 `injectedText` 全文**：它含记忆正文，落库等于把私密内容再存一份，体积随预算线性涨。检查器要还原用 `segments_json` 的逐段 summary，要核对字节用 `payload_hash`（canonicalHash）。单测断言了全文不出现在任何列里。

**carrier 为什么有三项**（connector2 报的枚举缺口，已放开）：
- `system` → `options.system`（标题旁路实测形态）
- `messages[role=system]` → system prompt 物化进 messages（主请求实测形态）
- `messages[user]` → **Brain 的注入通道物化成 user 角色消息**（`systemPrompt.context()` / `assembly.contexts` / `agent/pre-step`，M0 探针 §2 Q2）

把「user 消息里的注入」记成 `messages[role=system]`，等于在检查器里显示一个从未发生的位置 —— 证据链就假了。词表外仍然拒绝（`messages[assistant]` 抛错），因为「随手编一个没观测到的位置」正是造假那条路。

### 8.4 `contextPackages` 门面接口（context2 / connector2 / console2 联调依据）

```js
// 写：幂等。同 contextId 只留第一条，不覆盖内容、不刷 built_at。
await store.contextPackages.save(pkg)          // -> { id, created: boolean, status: 'built' }
// 只能以 status='built' 出生；attached/sent 必须由观测证据推进，不能自称。
// 缺 canonicalHash 直接拒（sent 判据不能没有基底）。

// 状态推进：只允许 built → attached → sent
await store.contextPackages.updateStatus(contextId, { status, carrier?, evidence? })
// -> { id, status, previousStatus, idempotent }
// 被拒时 err.details.rule ∈ 'no_skip' | 'no_regression' | 'carrier_locked' | 'terminal'
// 同状态重复 mark 幂等（idempotent:true，不刷时间、不报错）
// carrier 一旦设定就锁定（同状态换也会被拒）
// 首次证据时间不刷：attached_at / sent_at 用 COALESCE 只写第一次
// evidence 按 key 合并进 sent_evidence_json：attached 阶段证据不会被 sent 覆盖
// 行不存在 → NOT_FOUND（不静默建行）

// 读
store.contextPackages.get(contextId)                              // -> Package | null
store.contextPackages.list({ sessionId, turnId, stepId, scopeId, status, limit, cursor })
// -> { items, nextCursor }，游标是 (built_at, context_id) 键集
```

### 8.5 与 `docs/search-capability-report.md` 的对账（lead 要求确认）

**结论：报告不需要更新。** 理由：
- 报告测的是「三路融合的**召回能力**」（hit@10 / recall / P@10 / MRR），用的是它自己的 eval 脚本直接调 `SearchIndex.search()`；
- 段间连接符从空格改成 `AND` **不改变任何命中结果**（语义等价），只把「本来会抛语法错的那类输入」变成可执行；
- 报告 §3.5 的口径里没有任何一项依赖 match 串的字面形态。

唯一需要读者注意的差异：报告描述的自适应规则是「≤4 phrase / >4 OR」，**没说段间用什么连接**。现在明确了是显式 `AND` —— 这属于实现细节，不改变能力结论。按 lead 要求，这个 bug 记在本文档，不写进 capability report（报告性质是「能力实测」，这次是「集成期发现的实现 bug」）。
