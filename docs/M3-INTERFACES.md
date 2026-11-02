# M3 INTERFACES — 治理与恢复的接口契约

> 本文件是 M3 的并行开发契约。三条线同时开工，靠这里对齐。
> 冲突时优先级：`CONTRACTS.md` > 本文件。
> 定稿日期：2026-10-28 · 对应设计方案 21.7 / 21.8 / 22.2 的 M3 门槛。

## 0. 三条线与 M3 门槛

| 线 | 负责 | 写入范围 |
|---|---|---|
| **del3** | 独立删除账本、删除 worker、派生数据清理、纠错链、删除状态报告 | `packages/memory/src/deletion*.js`、`correction.js`、`tests/m3/deletion/**` |
| **backup3** | 全量备份增强、恢复编排、真实恢复演练 | `packages/memory/src/backup.js`、`restore.js`、`tests/m3/backup/**` |
| **ui3** | 删除状态报告 + 备份中心界面的服务端与页面 | `apps/server/**`、`apps/console/**`、`tests/m3/ui/**` |

**M3 门槛（设计方案 22.2）**：并发删除 / 旧备份恢复**不复活**；**真实恢复演练通过**。

---

## 1. 独立删除账本（del3）

**为什么必须有**：只从旧备份里读 tombstone，永远不知道"比这个备份更新的删除"。账本必须在活跃 DB **之外**。

### 1.1 存储形态

- 位置：`data/deletion-ledger/`（**活跃 DB 之外**，可配置到别的盘/离线介质）
- 形态：append-only JSONL + **每行 hash 链**（`prev_hash` → `entry_hash`）+ 尾部 checksum 文件
- **绝不存被删正文**。只存元数据：tombstone id、memory id、epoch、时间、scope、原因、执行者。
- 可追加不可改写；检测到链断裂或 checksum 不符 → `CORRUPT`，**恢复实例必须保持隔离**。

### 1.2 接口

```js
// packages/memory/src/deletion-ledger.js
createDeletionLedger({ dir }) -> DeletionLedger

ledger.append({ tombstoneId, memoryId, epoch, requestedAt, scopeId, reason, actor })
  -> { seq, entryHash, watermark }

ledger.watermark() -> { epoch, lastSeq, updatedAt }

ledger.read({ sinceSeq = 0, limit = 100 }) -> { entries, nextSeq }

ledger.verify() -> { ok, entryCount, lastSeq, corruptAt? }

/** 恢复工具的强制输入。不通过 → 不许上线。 */
ledger.checkForRestore({ backupEpoch, backupCreatedAt })
  -> { ok, blockers: [], warnings: [] }
  // blockers 例：'LEDGER_MISSING'、'LEDGER_CORRUPT'、'LEDGER_STALE_BEHIND_BACKUP'
  //   —— 账本水位低于备份的 epoch，说明备份之后发生过删除而账本没记，危险
  // warnings 例：'LEDGER_NOT_EXTERNAL'（和 DB 在同一块盘，整机损坏会一起没）
```

### 1.3 与 DB 的同步

删除事务里**同步追加账本**（在 DB 事务提交之前或同一临界区内），保证"DB 认为删了"和"账本记了"不脱节。
账本追加失败 → **删除请求必须失败**（不能虚报删除成功）。这条比"删除性能"重要。

---

## 2. 删除 worker 与派生数据清理（del3）

### 2.1 删除的全链

```
1. 写 tombstone（DB 内）
2. 增 deletion_epoch
3. 同步追加独立账本          ← 失败则整个删除请求失败
4. 目标与全部派生物立即不可检索（摘要、上下文包、导出标记）
5. 返回 202 + 本次删除的 jobId
6. 异步 worker：正文清除 → FTS 三表 → context_packages → 导出 → blob 引用
7. 每步都重查屏障（epoch 变了就放弃，不许把内容写回）
8. 暴露进度与失败
```

### 2.2 接口

```js
// packages/memory/src/deletion-worker.js
deletionQueue.enqueue({ memoryId, epoch, reason, actor }) -> { jobId }

deletionWorker.runOnce({ maxJobs = 10 }) -> {
  processed, failed, skipped,
  jobs: [{ jobId, memoryId, step, ok, error? }]
}

/** UI 要的分层报告，不许合成一个"已删除" */
deletionStatus(memoryId) -> {
  shieldedAt,          // 立即屏蔽时间（写 tombstone 那一刻）
  workerDoneAt,        // 在线清理完成时间（可能 null = 还没跑或失败）
  backupExpiryAt,      // 旧备份最晚到期时间（按备份保留策略算）
  externalCopies: [{ kind, verified }],        // 离线/外部副本，未核实就 verified=false
  hostCopies: [{ system: 'dsh'|'engram'|'lingshu', handled: boolean }],  // 其它源记录未处理
  progress: { total, done, failed },
  ledgerSynced: boolean,       // 独立账本是否已记
}
```

### 2.3 硬要求

1. **每步重查屏障**。删除前启动、删除后完成的 worker 不许把内容写回（契约 §8）。
2. **派生依赖要能立即屏蔽**，不能只"排队重建"仍对外可读。受影响的摘要立刻标不可读。
3. **不许过度承诺**：MVP 的日备不等于"7 天内物理删净"。到期按绝对时间检查；物理残留清理/加密擦除是单独能力，UI 里如实写。
4. 请求已经发到模型或外部服务的内容**无法追溯撤回**，只能停止后续使用并报告。

---

## 3. 纠错与遗忘的区分（del3）

```js
memories.supersede(oldId, newId, { reason, effectiveAt }) -> { oldVersion, newVersion }
```

| 维度 | 纠错（supersede） | 遗忘（delete） |
|---|---|---|
| 当前查询 | 不再使用旧值 | 不可读 |
| 历史查询（asOf） | **可显式回看旧值** | **任何查询均不可读**，历史模式不能绕过 |
| 链 | 保留 `supersedes` 链 | tombstone 元数据保留在独立账本 |

**必须测**：`asOf` 在纠错前后的两个时点分别返回旧值/新值；删除后 `asOf` 也读不到。

---

## 4. 全量备份增强（backup3）

### 4.1 要求（设计方案 21.8）

- **每日独立全量**（不是增量链——增量留到链验证后再开放）
- 一致性数据库快照，记录 `watermark`
- blob **内容寻址**且写入不可变；备份清单记录每个必需附件 hash
- **备份读者完成前禁止 GC 删除被引用 blob**
- 原子落位：`.tmp` → 校验 → `renameSync`（`backup()` 会覆盖已存在文件，契约 §11.4）
- 校验失败**禁止切换恢复**

### 4.2 接口

```js
// packages/memory/src/backup.js（增强现有）
createBackup({ db, blobsDir, outDir, label }) -> {
  dir, createdAt, schemaVersion, watermark, ledgerEpoch,
  tables: [{ name, rows }],
  blobs: [{ hash, size, refCount }],
  manifestHash, verified: boolean,
}

verifyBackup(dir) -> { ok, problems: [], manifestHash, schemaVersion, watermark }

pruneBackups({ outDir, keep = 7, now }) -> { removed: [], kept: [] }
  // 到期按**绝对时间**判断，不是"保留 7 个就一定删干净"
```

---

## 5. 恢复编排（backup3）

```js
// packages/memory/src/restore.js
planRestore({ backupDir, ledger, hostCopies }) -> {
  ok, blockers: [], warnings: [],
  backup: { createdAt, schemaVersion, watermark, ledgerEpoch, tables },
  ledgerCheck: { ok, backupEpoch, ledgerEpoch, stale: boolean, reason? },
  isolationRequired: boolean,     // 账本不可用/陈旧/corrupt → true
  steps: [],                      // 计划执行的可读步骤
}

executeRestore(plan, { targetDir }) -> {
  restoredAt, promoted: boolean, reason,
  rebuilt: { derived: ['fts', 'ngram', ...], ok },
  warnings: [],
}
```

### 5.1 恢复顺序（不许乱）

```
1. 校验备份完整性（verifyBackup）—— 失败直接拒绝，不许"先恢复再说"
2. 读独立删除账本 —— 缺失 / corrupt / 陈旧 → isolationRequired = true
3. 导入主表（先主表）
4. **强制合并账本**：把备份之后所有删除的 tombstone 重新应用
5. 重建派生数据（FTS 三表、ngram、摘要索引）
6. 判定：isolationRequired 或 blockers 非空 → **隔离上架（promoted=false）**，只能只读检修
7. 全部通过 → promoted=true
```

### 5.2 硬要求

1. **隔离实例不能上线**。`promoted=false` 时必须明确拒绝提供正常服务，只允许只读诊断。
2. **旧备份不许让已删内容复活**。这是 M3 的门槛，必须有专门用例。
3. 恢复错了要能退：恢复前把当前状态另存 `_pre-restore-<时间戳>`。
4. 真实演练：不是模拟，是**真起一个库、真删、真备份、真恢复、真比对**。

---

## 6. UI：删除状态与备份中心（ui3）

### 6.1 服务端新增

```
GET  /api/deletions/:memoryId          -> deletionStatus（分层报告）
GET  /api/deletions?status=pending     -> 待清理任务与进度
GET  /api/backups                      -> 备份列表 + 校验状态
POST /api/backups                      -> 触发一次备份（需 capability）
GET  /api/backups/:dir/verify          -> 复校
POST /api/restore/plan                 -> 只读预演，返回 blockers/warnings
POST /api/restore/execute              -> 执行（**必须二次确认参数**，且默认 dry-run）
```

### 6.2 页面

- **删除状态**必须分四层显示，不许合成一个"已删除"：
  1. 立即屏蔽时间
  2. 在线清理完成时间
  3. 旧备份最晚到期时间
  4. **离线/外部副本未核实** + **宿主/其它插件源记录未处理**
- 隔离恢复警告要显眼：`promoted=false` 时页面顶部必须有明确横幅。
- 备份中心显示：时间、版本、watermark、校验结果、大小。

视觉沿用 M2 控制台（原生 HTML + fetch、纸感浅色、单一赭石强调、等宽数字）。**好看是要求。**

---

## 7. 验收

- [ ] 并发删除 + 旧备份恢复**不复活**（专门用例）
- [ ] 独立账本缺失 / corrupt / 陈旧 → 恢复实例 `promoted=false` 且拒绝上线
- [ ] 纠错保留链、`asOf` 能回看旧值；删除后 `asOf` 也读不到
- [ ] 删除 worker 每步重查屏障，旧 worker 完成不写回
- [ ] 备份原子落位、校验失败禁止恢复
- [ ] **真实恢复演练通过**（真库、真删、真备、真恢复、真比对）
- [ ] `node --test "tests/**/*.test.mjs"` 全绿，M2 的 418 条不回归
- [ ] UI 四层删除报告 + 隔离横幅

## 8. 合成数据纪律

全部合成语料，覆盖主人真实语境（尺寸 / 材质 / 图号 / 报价 / 英文标识符）。**不碰真实私密历史。**
