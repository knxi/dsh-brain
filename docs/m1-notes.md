# M1 数据主账：实现说明与实测记录

> 对应任务：task-2（M1 数据主账 / 事件信封 / 单主账事务 / outbox / 幂等摄取 / 删除屏障 / 备份骨架）
> 实现位置：`packages/core`（`@dsh-brain/core`）、`packages/memory`（`@dsh-brain/memory`）、`migrations/`
> 契约依据：`docs/CONTRACTS.md`；母本《DSH外置大脑-可执行设计方案-v1.2》21.2 / 21.3 / 21.7 / 22.1 / 22.2
> 本文件只写**实测**结论与**实现选择**；不是设计文档，也不替代契约。

## 1. 环境与验证结论

| 项 | 值 |
|---|---|
| Node | v24.19.0 |
| SQLite（`node:sqlite` 内置） | 3.53.3 |
| 驱动 | `node:sqlite`（`DatabaseSync` / `StatementSync` / 顶层 `backup()`），**零原生编译依赖** |
| 语言 | 纯 ESM JavaScript + JSDoc，无构建链 |
| 迁移文件 | `migrations/0001_init.sql`（+ `0001_init.down.sql` 演练用） |
| 必需表 | CONTRACTS 第 4 节的 16 张全部建出，另加内部表 `brain_meta` |
| 契约测试 | `node --test tests/contract` → **70 / 70 通过**，约 20.8s（本机） |

```powershell
cd <repo>
node --test tests/contract                       # 目录入口（见 §6 的 Node 24 说明）
node --test "tests/contract/*.test.mjs"          # 等价的 glob 入口
pnpm install --ignore-scripts                    # 建立 @dsh-brain/core 的 workspace 链接（无第三方依赖）
```

## 2. 实际采用的 PRAGMA（回读值，不是"设置值"）

代码：`packages/memory/src/db.js` 的 `DEFAULT_PRAGMAS` / `applyPragmas` / `readPragmas`。
测试证据：`tests/contract/pragmas.test.mjs`（逐项断言回读值）。

| PRAGMA | 采用值 | 读回 | 说明 |
|---|---|---|---|
| `journal_mode` | `WAL` | `'wal'` | 文件库切换成功并写入文件头，重开保持；`:memory:` 只能返回 `'memory'`（`requireWal` 对内存库自动放行） |
| `synchronous` | `FULL` | `2` | WAL 下每次提交 fsync WAL。选 FULL 而不是 NORMAL，是为了满足「已 ACK 的主账记录进程崩溃后不丢」（设计 21.8）；代价是每条提交一次 fsync |
| `busy_timeout` | `5000` | `5000` | **node:sqlite 默认是 0**（一撞写锁立刻 SQLITE_BUSY），必须显式设置。实测另一连接持写锁时，`busy_timeout=120` 的连接在约 120–220ms 后报 `SQLITE_BUSY`(5) |
| `foreign_keys` | `ON` | `1` | node:sqlite 默认已开；仍显式设置，避免换驱动/降级时静默变化。实测孤儿 `memory_versions` 写入报 787 |
| `temp_store` | `MEMORY` | `2` | 临时表与排序走内存 |
| `wal_autocheckpoint` | `1000` | `1000` | SQLite 默认值；显式写下来便于之后调 |

部署清单里应照抄这张表；改 `DEFAULT_PRAGMAS` 必须同步改这里并重跑 `pragmas.test.mjs`。

## 3. `node:sqlite` 的实测边界行为（会影响 M2/M3）

这几条不是文档承诺，是本机实测结果，写代码时已按它们处理：

1. **布尔值不能绑定**：`stmt.run(..., true)` 抛 `TypeError: Provided value cannot be bound to SQLite parameter N`。
   因此所有布尔列一律 INTEGER 0/1，全项目只保留一个绑定入口 `toBindable()`（`write-queue.js`）负责把
   boolean → 0/1、`undefined` → NULL、`Date` → ISO 字符串，并拒绝 NaN/Infinity。

2. **磁盘满（SQLITE_FULL，errcode 13）会让 SQLite 自动回滚整个事务**：错误抛出时 `db.isTransaction === false`，
   此时再执行 `ROLLBACK` 会抛 `cannot rollback - no transaction is active`。
   所以回滚必须走 `safeRollback()`（先看 `isTransaction`），否则会用一个"回滚失败"顶掉真正的磁盘满错误，
   让上层误判故障类型。`disk-full.test.mjs` 专门覆盖该路径。

3. **语句级约束错误（UNIQUE 1555、FK 787、CHECK 275）不会销毁事务**：事务仍然可用，可以继续执行或提交。
   因此 ingest 先按唯一键 SELECT 判重，把约束冲突当兜底而不是主路径。

4. **错误对象形状**：`{ code: 'ERR_SQLITE_ERROR', errcode, errstr, message }`。
   关键 errcode：`13` 磁盘满、`5/6` busy/locked、`11/26` corrupt/notadb、`8` 只读、`3` 权限、`10` IO、`1555` 唯一、`787` 外键、`275` CHECK。
   映射表在 `core/src/errors.js` 的 `StorageError.classify()`；`retriable` 只对 busy/locked 为 true。

5. **`backup()` 是 `node:sqlite` 的顶层函数**：`await backup(db, path)`。它会覆盖已存在的目标文件（实测），
   所以「失败不覆盖上一份有效备份」不能靠它，必须自己先写 `.tmp` → 校验 → 原子 rename 落位（本项目已验证 Windows 上 `renameSync` 覆盖同名文件成功）。

6. **备份出的快照文件 `journal_mode` 仍是 `wal`**（文件头继承）。只读打开没问题，但恢复拷贝时要知道它带 `-wal`/`-shm` 语义。

7. **`readOnly: true` 打开 WAL 库可读**；只读连接不能执行 `journal_mode` 切换类 PRAGMA，只能设连接级的 `busy_timeout`/`foreign_keys`。

8. **同进程两个连接**：未提交事务对另一连接不可见（WAL 隔离）；跨连接写锁冲突由 `busy_timeout` 生效。

9. **`db.isTransaction` 属性实测可用**（不在 `node:sqlite` 文档的公开 API 列表里，但 3.53.3 上行为稳定）。
   如果未来 Node 升级移除它，`safeRollback` 需要退回"吞掉 ROLLBACK 错误"的写法。

10. **`UPDATE/DELETE ... LIMIT` 不可用**（标准构建没有 `SQLITE_ENABLE_UPDATE_DELETE_LIMIT`），
    认领类操作一律两步：先 `SELECT ... LIMIT` 拿 id，再 `UPDATE ... WHERE id IN (...)`。

## 4. 实现选择（与契约描述可能存在差异的地方）

1. **`source_seq` 必填非负整数**。契约 21.2 要求「每会话按宿主序号归并；时钟时间不作为唯一排序依据」，
   没有序号就无法可靠排序与判缺口。连接器必须在首次入队时分配（与「宿主无稳定 ID 时生成 event_id」同理），重试复用。
   若宿主事件真的没有序号，应在 connector 侧按会话递增分配，而不是让主账存 NULL。

2. **信封扩展字段 `payload_text`**（契约示例里没有）。它是「受控短期片段」，默认 NULL，单条上限 256KB
   （`DEFAULT_MAX_PAYLOAD_BYTES`），删除事件时立即置 NULL。`payload_ref='inline:<event_id>'`、
   `payload_hash` 缺省时由它算出。长期正文应走 blob 存储（M2/M3），不在信封里放大字段。

3. **`event_id` 默认由唯一键确定性派生**（`deriveEventId`，`evt_` + 32 hex）。宿主给了 `event_id` 就用宿主的。
   幂等的权威依据始终是唯一键 `(source_system, scope_id, source_event_id)`，**不是正文哈希**。

4. **冲突判定用 `content_fingerprint`**，参与字段：
   `session_id / source_seq / event_type / origin_system / payload_ref / payload_hash`。
   不参与：`received_at`（重试会刷新）、`occurred_at`（可能被重打时间戳）。
   注意：重放必须复用 `source_seq`；序号都变了说明是另一条事件，按冲突报错。

5. **`scope_id` / `person_id` / `source_system` 一律取连接器绑定**。`normalizeEnvelope` 会覆盖输入里的同名字段，
   并把被覆盖的字段名记录到 `meta.binding_override_fields` 供审计。默认绑定 `dsh` / `owner-default` / `owner`
   只用于单用户本地模式，生产连接器必须显式传自己的 bindings。

6. **新增内部表 `brain_meta`**（16 张必需表之外）。存 `deletion_epoch`（全局单调删除纪元）、
   `last_snapshot_id`、`db_generation`。删除纪元的原子 +1 在 `BEGIN IMMEDIATE` 事务里做 UPSERT。
   必需表数量不变，`migrations.test.mjs` 会断言"不允许出现未登记的表"。

7. **时间双存**：所有时间列都有 `*_at`（UTC ISO，毫秒精度，`Z`）与 `*_at_local`（本地 ISO，带 `±hh:mm`）。
   默认时区 `Asia/Shanghai`，时钟可注入。`events` 另存 `time_zone` 列；其它表靠 local 列自带偏移。
   注意 `sessions.last_source_seq` 用 `MAX(旧值, 新值)` 推进，乱序到达不倒退。

8. **回滚记录保留而不删除**：`schema_migrations` 回滚时把 `direction` 置 `down`（`schema_migrations` 表本身不被
   `0001_init.down.sql` 删除），再次 apply 时把同一行改回 `up`。这样"回滚"这件事本身可审计。
   历史迁移文件的 checksum 变了直接报 `MIGRATION_CHECKSUM_MISMATCH`，不允许悄悄改历史迁移。

9. **消费水位语义**：`consumer_offsets` 主键 `(consumer, scope_id, session_id)`，`last_source_seq` 是
   「**连续**已处理水位」（初值 0，会话内 seq 从 1 开始）。缺口未补齐时消费停在缺口前，返回
   `blocked_by_gap` + `expected_seq` 并告警；跳过缺口必须显式 `repairGap(reason)`，写 `audit_logs`
   （`action='consumer.gap_repaired'`）。handler 成功后才推进水位；handler 成功但水位提交失败 → 会再次交付，
   所以 handler 必须幂等（不承诺跨进程 exactly-once）。

10. **ACK 语义**：`queue.write()` 的 Promise 在 `COMMIT` 成功后 resolve；`ingestEvent` 返回的
    `{ status: 'accepted'|'duplicate', persisted: true }` 是唯一的"已记住"依据。任何错误都不带 `persisted` 字段，
    上层不得在 catch 分支显示"已记住"。`ack_at` 取 COMMIT 之后的时间。

11. **删除屏障有两个检查，不要混用**：
    - `assertEpochFresh(workerEpoch)`：给派生/写回类任务（摘要、提取、导入、恢复）。全局 epoch 前进即保守放弃。
    - `checkTargetBarrier(job)`：给清理类 job。按"该目标 + 该目标的 epoch"判断，别的目标发生删除不会误伤本 job。
    这条区别是被测出来的：如果清理 job 也用全局 epoch，先删 A 再删 B 会让 A 的 job 永远失败。

12. **删除路径的 M1 子集**：已实现 tombstone、epoch、即时不可检索、`memories/memory_versions/events.payload_text/
    summaries` 正文清除、`source_refs` 删除、`context_packages` 保守失效、审计、屏障重查。
    **未实现**（M3 才有对应派生物）：FTS/向量索引清理、导出文件清理、blob 引用清理、活跃 DB 之外的独立删除账本。
    `deletion_jobs` 里未实现的 kind 会显式记 failed/dead，不会被当成功；`ledger_synced_at` 恒为 NULL，
    恢复流程必须把它当限制报告。

13. **备份的 M1 子集**：一致性快照（在线 `backup()` + 先排空本进程写队列）、逐表计数与 `integrity_check` 校验清单、
    文件 sha256、原子 rename 落位、失败不覆盖旧备份、`verifySnapshot` 重算哈希与清单、`restoreSnapshot` 恢复到隔离
    路径并报告限制。**未实现**：进程级恢复编排（停摄取/排他锁/切换/健康检查）、独立删除账本合并、blob 哈希清单。
    恢复实例 `safe_to_promote` 恒为 false，并带 `DELETE_LEDGER_NOT_EXTERNAL` 警告；快照 epoch 落后时另有
    `STALE_DELETION_LEDGER` 警告 —— 这两个警告不是占位，是如实声明能力边界。

14. **审计脱敏**：`audit_logs.detail` 只放 ID / 哈希 / 原因 / 计数，不放正文。冲突审计会记录两个 payload hash，
    但不记录内容。outbox 失败告警同样只带工作项 ID 与截断错误消息。

15. **不引第三方依赖**：`packages/core` 与 `packages/memory` 的 dependencies 只有 `@dsh-brain/core`（workspace）。
    测试全用 `node:test` + `node:assert`。

## 5. 文件责任边界

| 路径 | 内容 |
|---|---|
| `packages/core/src/errors.js` | 稳定错误码、SQLite 错误映射（不泄露正文） |
| `packages/core/src/clock.js` | UTC / 本地时区双存、严格 ISO 解析 |
| `packages/core/src/canonical.js` | 规范化 JSON 与内容哈希（键序无关） |
| `packages/core/src/ids.js` | 稳定 ID 派生、payload 哈希 |
| `packages/core/src/envelope.js` | 信封校验、绑定覆盖、内容指纹 |
| `packages/memory/src/db.js` | 打开 / PRAGMA / 完整性检查 |
| `packages/memory/src/migrator.js` | 迁移器（幂等、checksum、回滚留痕） |
| `packages/memory/src/write-queue.js` | 单写入队列、同步事务、错误规整、`toBindable` |
| `packages/memory/src/ledger.js` | 幂等摄取、会话投影、审计 |
| `packages/memory/src/outbox.js` | 事务内工作项、认领/完成/失败/崩溃恢复 |
| `packages/memory/src/consumers.js` | at-least-once 消费、缺口阻塞与显式修复 |
| `packages/memory/src/deletion.js` | tombstone、epoch、屏蔽、清理 worker、屏障重查 |
| `packages/memory/src/backup.js` | 一致性快照、校验清单、隔离恢复 |
| `packages/memory/src/meta.js` | `brain_meta` 读写（deletion_epoch 等） |
| `packages/memory/bin/migrate.mjs` | `pnpm migrate` CLI（`--status` / `--dry-run` / `--rollback`） |
| `migrations/0001_init.sql` | 16 张必需表 + `brain_meta` |
| `tests/contract/` | M1 门槛测试（70 个） |

## 6. Node 24 的测试运行器差异（影响验收命令）

实测 Node 24.19 的 `node --test <目录>` **不会递归搜索目录**，而是把目录当模块入口解析，
没有 `package.json`/`index.js` 时直接 `MODULE_NOT_FOUND` 失败。

处理方式：`tests/contract/` 下放 `package.json`（`main: ./run-all.mjs`）与其入口 `run-all.mjs`（静态 import 全部
`*.test.mjs`）。于是两种写法都成立：

```powershell
node --test tests/contract                     # 走目录入口
node --test "tests/contract/*.test.mjs"        # 走 glob（Node 22+）
```

新增测试文件时必须在 `tests/contract/run-all.mjs` 里补一行 import，否则目录入口不会跑到它。

> 同一个坑也影响根 `package.json` 的 `node --test tests/`：`tests/` 也不可解析。因此额外加了
> `tests/package.json`（`main` 指向 `./contract/run-all.mjs`），现在 `node --test tests/` 与
> `node --test tests/contract` 都是 **70/70**。这是测试基础设施的一行补丁，不改任何业务语义。

## 7. 明确未覆盖 / 留给后续阶段

- M2：FTS5/trigram 中文检索、n-gram 兜底、RRF、来源回查（`packages/search`）；`memories` 的写入 API（M1 只有表结构，
  测试用白盒 SQL 造数据）。
- M3：纠错（`superseded` 链的写入路径）、独立删除账本、全量备份/隔离恢复演练、导出 JSONL 与水位。
- 连接器（`apps/connector`）：真正的 `bindings` 注入、持久队列上限、无稳定 ID 时的 `event_id`/`source_seq` 生成与复用。
- 模型/网络请求一律不得进入写事务：`runInTransaction` 会检测回调返回 thenable 并抛 `WRITE_ASYNC_FORBIDDEN`。
  这条在 M2 构包/召回接入时要继续守。

## 8. 红线自查

- 没有迁移、改写 Engram / 灵枢 的任何记忆库；没有打开 `~/.dsh/profiles` 下的东西。
- 没有引入原生编译依赖；没有第三方 runtime 依赖。
- 没有把凭据写进代码、日志、审计或备份清单。
- 测试全部使用临时目录里的合成数据（`mkdtemp` + `rmSync`）。
