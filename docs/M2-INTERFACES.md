# M2 INTERFACES — 检索闭环的四条线接口

> 本文件是 M2 的**并行开发契约**。四条线同时开工，靠这里对齐。
> 冲突时优先级：`CONTRACTS.md` > 本文件。本文件只定签名，不定实现。
> 定稿日期：2026-10-28 · 对应设计方案 22.2 的 M2 门槛。

## 0. 四条线

| 线 | 负责 | 写入范围 |
|---|---|---|
| **memory2** | 记忆层 API、FTS 集成、检索 | `packages/memory/src/**`、`migrations/0002_*.sql`、`tests/m2/memory/**` |
| **context2** | 构包、预算、三级证据状态、canonical hash | `packages/context/**`、`tests/m2/context/**` |
| **connector2** | cordis 连接插件 | `apps/connector/**`、`tests/m2/connector/**` |
| **console2** | 本地 HTTP API + 只读控制台 | `apps/server/**`、`apps/console/**`、`tests/m2/server/**` |

memory2 是地基，其余三条按下面的签名写，**可以先用 mock 并行**，不必等 memory2 完成。

---

## 1. memory 记忆层 API（memory2 实现）

入口：`packages/memory/src/index.js` 继续导出 `openBrain()`，M2 新增一个 `memories` / `sources` / `snapshots` / `summaries` 门面。

### 1.1 写入

```js
/** @typedef {Object} MemoryDraft */
{
  scopeId: string,            // 必填，来自连接器绑定，不采信正文
  personId: string,           // MVP 固定 'owner'，但校验必须在
  layer: 'fragment'|'long'|'permanent',
  type: 'profile'|'episode'|'semantic'|'commitment'|'skill'|'self'|'relationship'|'boundary',
  content: string,            // 原文，不改
  summary: string,            // 用于注入的短摘要
  sourceType: 'owner_words'|'observation'|'inference'|'web'|'tool'|'summary',
  sourceIds: string[],
  confidence: number,         // 0..1；inference 必须 < 1
  importance: number,         // 0..1
  privacy: 'public'|'private'|'secret',
  validFrom?: string|null,    // ISO；过期事实靠它 + validUntil 表达，不删
  validUntil?: string|null,
  pinned?: boolean,
  // 防循环（契约 10.6，必填）
  originSystem: 'brain'|'dsh'|'engram'|'lingshu',
  producer: string,
  derivedFrom?: string[],
  causationId?: string|null,
}

memories.create(draft) -> { id, version, createdAt }
memories.update(id, patch, { expectedVersion }) -> { id, version }   // CAS；版本不符抛 CONFLICT
memories.supersede(oldId, newId) -> void                            // 旧标 superseded，链保留
memories.get(id, { asOf } = {}) -> Memory | null                    // asOf 时点回看
memories.list({ scopeId, personId, status, layer, type, limit, cursor }) -> { items, nextCursor }
```

### 1.2 检索（M2 核心）

```js
memories.search({ query, scopeId, personId, asOf, limit = 10, includeExpired = false })
  -> SearchResult

/** @typedef {Object} SearchResult */
{
  hits: [{
    memoryId, version, score: number,
    matchedBy: ('char'|'trigram'|'ngram'|'like')[],
    sourceRefs: SourceRef[],
    evidenceKind: 'owner_words'|'observation'|'inference'|'web'|'tool'|'summary',
    validFrom, validUntil,
    layer, type,
    summary, contentHash,
  }],
  diagnostics: {
    status: 'ok'|'no_related'|'insufficient_evidence'|'source_missing'|'source_conflict',
    queryWasEscaped: boolean,
    degraded: ('fts_unavailable'|'index_missing'|null),
    notes: string[],
  },
}
```

**硬要求**：
- 用户输入**绝不直进 `MATCH`**，统一走 `buildTrigramMatch()` / `buildFtsMatch()` 转 phrase（实测四种输入直进必抛）。
- 中文检索本体就是 `@dsh-brain/search` 的三路融合（char 1 : trigram 0.6 : ngram 0）。**不重写**，只集成。
- `diagnostics.status` 必须能区分四种"检索不足"（契约 §7）。
- 删除屏障：任何命中都要过 `deletion_tombstones` + `deletion_epoch`（契约 §8）。删了索引没删原文的内容**不许捞出**。

### 1.3 来源

```js
sources.link(memoryId, { sourceSystem, sourceEventId, locator, contentHash }) -> { id }
sources.forMemory(memoryId) -> SourceRef[]
sources.verify(ref) -> { ok: boolean, reason?: 'source_missing'|'hash_mismatch'|'locator_invalid' }
```

### 1.4 任务快照（最小版）

```js
snapshots.save({ scopeId, sessionId, turnId, goal, doneSteps, pendingSteps,
                 artifactHashes, sourceEventWatermark, pendingEffects, version }) -> { id, version }
snapshots.load({ scopeId, sessionId, turnId }) -> Snapshot | null
```
CAS 写入；冲突重读，不让慢任务覆盖较新的用户纠错（契约 §21.3）。

### 1.5 摘要

```js
summaries.create({ scopeId, layer, text, sourceEventIds, sourceWatermark }) -> { id }
```

### 1.6 迁移

`migrations/0002_m2_memory.sql` —— 记忆层新增列/表 + **调用 `@dsh-brain/search` 的 `createSearchSchemaStatements()` 产出建表**（search 只导出 SQL，不自己建表，见契约 §1）。
迁移必须幂等、有 `checksum` 保护、可回滚留痕（沿用 M1 `migrator.js` 的机制）。

---

## 2. context 构包 API（context2 实现）

```js
// packages/context/src/index.js
build({
  store,            // openBrain() 的返回
  query,
  scopeId, personId, sessionId, turnId, stepId,
  budget: { modelWindow, hostInputTokens, outputReserve, brainCap },
  policyVersion = 'm2.0',
}) -> ContextPackage
```

```js
/** @typedef {Object} ContextPackage */
{
  contextId: string,
  builtAt: string,
  policyVersion: string,
  scopeId, personId, sessionId, turnId, stepId,

  segments: [{
    memoryId, version, layer, type,
    summary, contentHash,
    sourceRefs, evidenceKind,
    validFrom, validUntil,
  }],
  injectedText: string,          // 实际要挂给宿主的文本，带来源标记
  estimatedTokens: number,
  tokenizerId: string,           // 拿不到真 tokenizer 时写 'estimate:chars/2.5' 之类，不许假装精确
  canonicalHash: string,         // sha256(canonicalize({segments, injectedText, policyVersion}))
  budget: { brainAllowance, used, dropped: [{ memoryId, reason }] },
  diagnostics: { status, reasons: string[] },
  status: 'built',               // 只能是 built 出生
}
```

预算公式（**必须逐字照抄**，契约 §6）：

```
safetyMargin   = max(modelWindow * 0.05, 1024)
brainAllowance = max(0, min(brainCap ?? 2048, modelWindow - hostInputTokens - outputReserve - safetyMargin))
```

拿不到 `hostInputTokens` 时：固定小额上限 + 标"估算"，**不伪造精确 Token**。

三级状态：

```js
markAttached(pkg, { carrier, turn, step }) -> ContextPackage   // built → attached
markSent(pkg, { carrier }) -> ContextPackage                   // attached → sent
// carrier ∈ 'system' | 'messages[role=system]'（契约 10.9：两级承载都要能表达）
```

**纪律**：
- 任何时刻不许从 built 直接跳 sent。
- 超限先丢低相关段，丢的都记进 `budget.dropped` 并给理由。
- 检索 `diagnostics.status !== 'ok'` 时，构包要**如实降级**（返回空段 + 说明是"证据不够"还是"没有相关记忆"），不许拿相似结果硬凑（契约 §7）。

---

## 3. connector 插件（connector2 实现）

包名 `@dsh-brain/connector`，cordis 插件（`export const name` / `inject` / `apply`）。

### 3.1 钩子

| 钩子 | 模式 | 用途 |
|---|---|---|
| `system-prompt/assemble` | waterfall | `await next()` 后**复制** assembly，把 Brain 片段作为 `PromptContext` 追加 |
| `agent/pre-step` | waterfall | `await next()`，若 decision 带 messages 则复制后追加 |
| `llm/stream` | waterfall | **只观测**，抓最终请求对象做 sent 判据 |
| `session/event` | emit 监听 | 摄取到有界持久队列 |
| `agent/turn-stopping` | **serial**（不是 waterfall！） | 回合收尾钩子 |

### 3.2 纪律（全是踩过的坑，逐条硬要求）

1. **运行期零抛出**：每个 hook 顶层 `try/catch`，捕获后只记日志。实测抛错会让 `turn/end reason=error` + 退出码 1，污染用户回合（契约 10.2）。
2. **按 step 幂等**：`assemble` / `pre-step` 每 step 都会跑，同一 `(sessionId, turnId, stepId)` 重复调用不得重复注入（契约 10.1）。
3. **注入带来源**：注入文本必须带可识别标记（如 `<!-- brain:{contextId} -->`），摄取侧必须按 `originSystem` 剔除自身与兄弟引擎的注入，**绝不让注入内容二次沉淀成人类证据**（契约 10.6）。
4. **不注册 `complete: true`**：会绕过宿主规则。
5. **不改宿主传入数组**：复制后返回新对象。
6. **sent 判据查两级**：`options.system` 与 `options.messages[role=system]` 都要查（契约 10.9）。
7. **请求计数剔除旁路**：按 `purpose` 剔掉 `session-title`，否则注入次数会算错。
8. **历史回查不嵌 turn 内**：`sessionQuery` 全文搜索在 turn 内是关着的（契约 10.8），回查走独立进程/后台任务。

### 3.3 模式

`off | shadow | explicit | automatic`，**默认 `shadow`**：只算候选和指标，不额外注入。
`automatic` 必须单独 profile 通过"无重复注入"测试后才允许。

### 3.4 最小组件

`apps/connector/` 至少要有：`index.js`（插件）、`queue.js`（有界持久队列）、`inject.js`（组装 PromptContext）、`probe-sent.js`（llm/stream 抓请求）、`package.json`（`dsh.bundle.patch`）。

---

## 4. server + console（console2 实现）

### 4.1 HTTP API（仅 `127.0.0.1`，启动时生成不可预测凭据）

```
GET    /api/health                     -> { ok, version, db, degraded[] }
GET    /api/memories?scopeId&layer&type&status&limit&cursor
GET    /api/memories/:id?asOf=
GET    /api/search?q=&scopeId=&limit=
GET    /api/context/:contextId         -> { package, status: 'built'|'attached'|'sent', evidence }
GET    /api/contexts?sessionId&turnId  -> 本次/本轮的构包列表
POST   /api/memories                   -> 手动写一条（owner 显式指令）
DELETE /api/memories/:id               -> 写 tombstone，返回 202 + 清理进度
```

**安全**（契约 §21.6）：每安装生成凭据、限制 Host/Origin、参数全部绑定、分页有上限、不开放任意路径读。

### 4.2 console

只读页面，四块：
1. **记忆列表**：过滤 + 详情（来源、版本、有效期、置信度）。
2. **上下文检查器**：某次构包注入了什么、来源、Token 估算、被丢掉的段和理由、`built/attached/sent` 三级状态。
3. **检索诊断**：为什么没搜到（四种状态可视化）。
4. **健康**：降级状态。

技术：不引框架，原生 HTML + fetch。**好看是要求**——排版对齐、留白、色彩克制，别堆字段。

---

## 5. 验收（M2 门槛，来自设计方案 22.2）

全部满足才算 M2 过：

- [ ] 检索结果**必有来源**、**必有版本**、**必有预算说明**
- [ ] 检索不足时**不胡答**（四种 status 能区分并如实上报）
- [ ] **不干预宿主历史裁剪**（只追加片段，不改宿主 messages）
- [ ] 注入**无重复**（同一 turn 多 step 不重复注入同一记忆）
- [ ] `built → attached → sent` 三级证据链完整可查
- [ ] 删除后检索不到（屏障生效）
- [ ] 测试：`node --test "tests/**/*.test.mjs"` 全绿，且 M2 新增用例覆盖上述每一条

## 6. 合成数据纪律

M2 全部用合成语料。语料必须覆盖主人的真实工作语境：尺寸（`1.2m`/`1200mm`/`2400×600`）、材质、图号（`建施-03`）、报价、英文工具名与代码标识符。

**不碰真实私密历史。** 这是红线，M2 不例外。
