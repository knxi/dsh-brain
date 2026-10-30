# @dsh-brain/server —— 本地 API + 只读控制台

`node:http` 原生实现，无框架；控制台是原生 HTML + `fetch`，无构建。
契约依据：`docs/M2-INTERFACES.md` §4、`docs/M3-INTERFACES.md` §6、`docs/CONTRACTS.md` §6、§7、§10.4、§10.9、§12。

```powershell
# 看效果（合成数据，写到临时库，不动主账）
node apps/server/bin/seed-demo.mjs --db $env:TEMP\demo.db
node apps/server/index.mjs --db $env:TEMP\demo.db --port 0 --allow-backup

# 想看隔离横幅
node apps/server/index.mjs --db $env:TEMP\demo.db --port 0 --isolation-reason "恢复实例未通过校验"

# 日常
node apps/server/index.mjs          # 默认 data/brain.db + 127.0.0.1:7420
node apps/server/index.mjs --read-only
```

启动信息只打印地址、凭据**文件**路径、主账与降级项。凭据本身不打印、不进日志。

## 凭据与准入

| 项 | 做法 | 为什么 |
|---|---|---|
| 绑定 | 只 `127.0.0.1`，**没有**改成 `0.0.0.0` 的开关 | 本机服务，暴露面越小越好 |
| 凭据 | 启动时 `randomBytes(32)`（base64url，43 字符），写 `data/server/console-token.txt`（0600），重启复用 | 不可预测；不落进命令行/shell 历史 |
| 传递 | 只认 `Authorization: Bearer` / `X-Brain-Token`；**不接受** `?token=` | URL 会进浏览器历史、Referer、代理日志 |
| 页面取凭据 | 服务端注入 `<meta name="brain-token">`，前端读它放请求头 | 凭据不进 URL；CSP 保持 `script-src 'self'` |
| Host | 只接受 `127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`，**页面请求也查** | 挡 DNS rebinding（否则攻击者页面能同源读走 meta 里的凭据） |
| Origin/Referer | 带就必须在允许列表；`null`（file:// / sandbox iframe）直接拒 | 挡浏览器里的其它网页 |
| 失败限流 | 同源 60s 内 12 次认证失败 → 429 + `Retry-After` | 本机暴力猜凭据也不该免费 |
| 静态资源 | **只有三份文件**的白名单（`/`、`/assets/app.js`、`/assets/styles.css`），不做任意路径映射 | 路径穿越无从谈起 |
| 日志 | 只记 method + pathname + 状态码 + 耗时 + 字节；不记 query（检索词是私事）、不记 Authorization、不记请求体 | 红线：凭据不进日志 |

## API

```
GET    /api/ping            免凭据探活（只回 {ok,service}）
GET    /api/health          库状态 / PRAGMA / 降级 / 隔离 / 能力矩阵（都要凭据）
GET    /api/memories        ?scopeId&personId&layer&type&status&limit&cursor
GET    /api/memories/:id    ?asOf=  时点回看
GET    /api/search          ?q=&scopeId=&limit=&asOf=&minCoverage=
GET    /api/contexts        ?sessionId&turnId&limit&cursor
GET    /api/context/:id     构包 + 三级证据 + 预算 + 被丢掉的段
POST   /api/memories        owner 显式写入 → 201
DELETE /api/memories/:id    写墓碑 → 202（受理 ≠ 已清干净）

# M3
GET    /api/deletions?status=pending|completed|all  待清理任务与进度
GET    /api/deletions/:memoryId                     四层报告
GET    /api/backups                                 列表 + 校验状态 + 当前删除水位
POST   /api/backups                                 触发备份（需 --allow-backup）
GET    /api/backups/:dir/verify                     复校
POST   /api/restore/plan                            只读预演（blockers / warnings / steps）
POST   /api/restore/execute                         默认 dry-run；真执行需三重闸门
```

分页：`limit` 默认 50、**硬上限 200**，超过会被夹住并在 `limitNote` 里说明；
游标是 keyset（`created_at, id`）的不透明 base64url，非法游标一律 400。

## 三级证据（built / attached / sent）

`sent` 的判据是「payload hash 命中最终请求对象」，且必须查 `options.system` 与
`options.messages[role=system]` **两级承载**（契约 10.9）。

载体、sent 明细、预算、检索质量由 `0003_m2_context_evidence.sql` 加的四列承载：

| 列 | 用途 | 检查器怎么用 |
|---|---|---|
| `budget_json` | `{ brainAllowance, used, dropped[] }` | 预算区 + 被丢掉的段与理由（**M2 验收项「必有预算说明」靠它**） |
| `carrier` | `system` \| `messages[role=system]` | 证据卡显示「载体已记录：具体是哪一级」 |
| `sent_evidence_json` | `{ evidenceLevel, provesWireDelivery, observedHashLocations[] }` | sent 判据的明细 |
| `evidence_strength` | `primary` \| `ngram_fallback` \| `unknown` | 弱证据徽章 |

**列不在就一直显示「未记录」**——上一版就是漏接了这几列，把「有预算」显示成「没记录」，
所以现在有专门的测试钉住（`tests/m3/ui/context-budget.test.mjs`）。

sent 也只证「宿主决定发这些内容」，不证字节出网——这句话直接写在证据卡的边界说明里。

## 检索诊断的四种「没搜到」

`ok` / `no_related` / `insufficient_evidence` / `source_missing` / `source_conflict`
由 memory 层判定（`memories.search`），本服务只做集成与展示。额外的诚实降级：

- 门面不存在 → 垫片，且 `implementation: 'shim'`；
- **索引与主账不一致**（memories 有数据但索引表是空的）→ 不走「no_related」，
  而是退回 LIKE 兜底并标 `degraded: 'index_stale'`。**「索引坏了」绝不能显示成「库里没有」。**

## 数据访问分工

- 写 / 检索 / 删除 / 恢复 → `openBrain()` 的门面（领域逻辑不重写）；
- 列表 / 详情 / 四层展示口径 → 本服务的只读 SELECT（前端要什么形状不该反向污染领域模型）。

## 测试

```powershell
node --test "tests/m2/server/*.test.mjs"   # M2：API/安全/分页/控制台（66）
node --test "tests/m3/ui/*.test.mjs"       # M3：删除四层/备份/恢复/隔离（47）
```

全部跑在 `mkdtemp` 临时主账 + 临时备份目录上，语料是合成数据（尺寸 / 材质 / 图号 / 报价 / 英文标识符），
不引用任何真实私密历史。

---

# M3 追加：删除状态 · 备份中心 · 隔离

## 四层删除报告（`layers`）

| 层 | key | 什么时候完成 | 拿不到时怎么写 |
|---|---|---|---|
| 1 | `shielded` | 写 tombstone 那一刻，必然完成 | — |
| 2 | `onlineCleanup` | 清理任务全 done 才有完成时间 | `not_started` → `at: null`（**没清 ≠ 清完了**） |
| 3 | `backupExpiry` | 删除**之前**创建的备份全部过期 | 没有这种备份 → `no_risky_backup` + `at: null` |
| 4 | `external` | 永远「需要人工」 | 无登记表时默认全部 `verified/handled = false` |

第 3 层用本地精确算法（只看删除发生前的备份，逐份给到期时间），
门面的笼统值只在本地算不出来时兜底。第 4 层把「我们管不到」直接写出来：
离线导出、云同步副本、宿主 session 历史、其它插件的库。

门面（del3）提供官方报告时以它为准，另加 `claims`（物理擦除 / 备份过期 / 外部撤回三个独立断言）
与 `notes`（清理链技术说明，和「需要人记住的前提」分层展示）。

## 恢复的三重闸门

只有**同时**满足才真执行，缺一个都只是预演：

1. 请求体 `dryRun === false`（不传就是 `true`）；
2. `confirm === "RESTORE"`（精确串，大小写敏感）；
3. 服务以 `--allow-restore` 启动（或 `BRAIN_ALLOW_RESTORE=1`）。

预演回 200，真执行回 202；门面缺失回 **501 `NOT_AVAILABLE`**（不是 500，界面才能说「尚未接入」）。

## 隔离（`promoted=false`）

判据按可信度排序，任一成立即隔离：

1. 运维显式 `--isolation-reason`；
2. `data/server/restore-state.json` 里 `promoted: false`（或文件读不出来）；
3. 由备份恢复（`--restored-from`）且账本不可用 / corrupt / **从来没有过记录**。

隔离时：

- `/api/health` 的 `isolation.active = true`、`ok = false`，页面顶部出现红色横幅；
- **写操作被 403 `ISOLATED_INSTANCE` 挡住**（横幅是看得见，闸门是拦得住）；
- 只读诊断照常；`/api/restore/*` 与 `POST /api/backups` 放行（那是唯一的修复路径）。

## 能力矩阵

`--allow-backup` / `--allow-restore` **默认都关**。误触备份只是占空间，误触恢复是把库覆盖掉。
`GET /api/health` 的 `capabilities` 同时报「开了什么」和「哪些门面已接入」。
