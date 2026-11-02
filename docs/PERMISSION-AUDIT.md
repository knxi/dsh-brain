# 权限门控审查报告（2026-11-02）

> 起因：主人要求把审批规则改成「L3 全自主 / L2 中低风险自主、高风险找他 / L1 全找他」。
> 审查方式：三路并行只读盘点（directives 执行路径 / 反思与删除 / 社交外发）+ 主线交叉验证。
> 本文件只记录**现状与缺口**，不含任何改动承诺；改动另开批次。

---

## 0. 一句话结论

**主人的规则是「按风险决定谁批」，系统实现的是「等级当天花板，够就放行」——两个不同的模型。**

`canExecute`（permissions.js:271-274）只判「当前等级 ≥ 动作最低等级」。生产库
`autonomy.max_level = L3`，所以 **L1、L2 的动作全部自动放行**，没有任何一处会因为
「这是 L1 动作所以要问主人」而停下来。

---

## 1. 等级体系覆盖到哪里

### 1.1 只有 7 个内置动作受等级控制

`ACTION_TABLE`（permissions.js:94-149）：

| 动作 | minLevel | 实际做什么 | 生产接线 | 可回滚 |
|---|---|---|---|---|
| `memory_maintenance` | L1 | `memories.reindexAll()`，改派生字段 | ✅ | 是 |
| `index_rebuild` | L1 | **只 `ensureSchema()` 建表，不填数据** | ✅ | 是 |
| `alert_sweep` | L1 | `brainstem.checkOnce()`，归并告警 | ✅ | 是 |
| `backup_verify` | L1 | 校验最近一份备份，纯只读 | ✅ | 是 |
| `reflection_run` | L2 | `reflect.runOnce()`，只出候选 | ✅ | 是 |
| `skill_rebuild` | L2 | 重算技能置信度 | ❌ **未接线，永远 hook_missing** | 是 |

### 1.2 L3 在包内等于 L2

- `LEVELS.L3.allows = []`（permissions.js:76），全表最高 minLevel 是 L2。
- 测试钉死了这个语义：`tests/directives/permissions.test.mjs:102-111`「L3 不新增任何动作」。
- `permissions.js:78` 声称 L3「只放宽有效期与重复次数」——**代码里没实现**：
  有效期只看 `validUntil`（scheduler.js:581-583），重试上限定死 `MAX_RETRIES_LIMIT=10`
  （directives.js:60），都不读等级。
- **真正吃 L3 的只有一件事**：反思自动晋升（`index.js:1278`
  `if (LEVELS.indexOf(rawLevel) < 3) return`）。

### 1.3 内部候选转指令：硬上限 L1，改不掉

`autonomy.js:27` `INTERNAL_MAX_LEVEL = 'L1'` 是 `const`，无配置入口；候选请求 L3 也只记
一条 notes 后压到 L1（:134-139），转出状态固定 `awaiting_approval`（:267-272）。

---

## 2. 同一件事，权限判定写了四套

| 实现 | 位置 | 管什么 | 读不到时默认 |
|---|---|---|---|
| `canExecute` + scheduler 闸门 | permissions.js:247、scheduler.js:114-144 | 自主指令 | **L1** |
| `resolveReflectionPermission` | index.js:195-224 | 反思工具 | **L0** |
| `assertAllowed` | switches.js:105-126 | 模块开关 | — |
| 内联等级判断 | index.js:1276-1278 | 反思自动晋升 | — |

规则一样，代码是手抄四份，**改一处不影响另外三处**。默认姿态还不一致（L1 vs L0）。

---

## 3. 全部受控操作清单

### 3.1 有等级门的（只有自主指令这一条线）

见 §1.1。执行路径：创建期 permissions.js:319 → 认领期 directives.js:766 →
执行期 scheduler.js:610。

### 3.2 没有等级门、靠别的闸的

| 操作 | 实际门控 | 可逆 |
|---|---|---|
| 反思 `run` | L2 + `reflection.enabled` | 是 |
| 反思 `dismiss` | L1 ≤0.45 / L2 任意 / L0 全拒 | **否**（终态） |
| 反思 `promote` | **L3** | 部分（promoted 不可退） |
| 反思自动晋升 | L3 + `auto_promote` + 未暂停，**无人点** | 同上 |
| **HTTP 反思 promote/dismiss** | **无等级、不查暂停，仅 CSRF**（index.js:4023-4044） | — |
| 删除记忆（`brain_forget`） | **无等级、无确认词** | **否** |
| 生命周期自动真删 | 每 6h ≤20 条，无确认 | **否** |
| 备份恢复 | `confirm='RESTORE'` + `--allow-restore` + dryRun=false | 文件层可逆 |
| 社交真发 | `allow_external` + 候选状态 + 通道钩子 | **否**（发出去收不回） |
| 改社交策略/通道/自动发送 | 页面点两下，**零审计** | 是（可改回） |
| 改 7 个开关 | 页面点两下，**写审计** | 是 |
| `actions.run` | **无等级、无暂停、无审计**（actions.js:88-133） | — |

### 3.3 七个开关（不是六个）

`autonomy.enabled` / `autonomy.max_level` / `social.enabled` / `social.allow_external` /
`reflection.enabled` / `reflection.auto_promote` / `paused`（switches.js:25-36）。

---

## 4. 缺陷清单

### P0

**P0-1 页面点两下就能绕过全部等级**
`index.js:4023-4044` 的 `/api/cognition/reflection/promote|dismiss` 直接调
`reflect.promote/dismiss`，既不过 `resolveReflectionPermission`、也不查 `paused`。
L0 状态下，控制台点两下按钮（4 秒内确认）就能写长期记忆——那是 L3 才有的能力。
前端两步确认只挡误触，不挡权限。

**P0-2 真发到微信时不复核策略**
`send()` 只判 `canExternal` + 候选状态（social.js:1613-1626）。
`quiet_hours` / `daily_cap` / `cooldown` 只在 `arbitrate`（:1539）和 `preview`（:1869）判。
后果：12:00 仲裁通过的候选，22:00 点「批准并发送」不会被安静时段拦下。

### P1

**P1-1 删除记忆是全项目最松的不可逆操作**
`brain_forget`（index.js:2435-2512）无等级、无确认词；底层 deletion.js:226-244 只校验字段。
比恢复备份松得多，却有生命周期 cron 每 6h 自动真删一批（index.js:1588-1653）。

**P1-2 过期候选永不清理**
`social.expire()`（social.js:1816-1835）**只有测试调用，生产没有调用者**。
死候选永久占 `max_pending` 名额 → 管道会停摆（2026-11-02 实际发生过：
一条中午问候卡住名额，之后所有新候选被判 `rejected/max_pending`）。

**P1-3 最危险的配置改动零审计**
改 `social-auto`（是否自动真发）、`channel`（发给谁）只写文件（index.js:4264/4291），
不写 `audit_logs`；而改普通开关反而写了（switches.js:159-171）。
另：`approvedBy` 参数从未落库（只有 JSDoc 和传参），事后查不到「谁批的」。

**P1-4 `actions.run` 是无门执行入口**
actions.js:88-133 只判白名单与 hook 存在，不查等级/暂停/开关/预算，不写审计，
且公开导出（index.js:180）。生产目前只从 scheduler.js:696 调（此前已过闸），
属纪律问题而非外部漏洞，但违反「权限收口只有一处」。

### P2

- **文档承诺未实现**：`reversible`/`rollback` 只是元数据，全仓无回滚执行器
  （只有 describe/list 展示）；`index_rebuild` 声称重建三张 FTS 表，实际只建表；
  `skill_rebuild` 未接线；`LEVELS.allows` 不参与判定，且 L1 里的 `read_search`
  不在 ACTION_TABLE（面板会显示一个执行不了的能力）。
- **指令永远批不了**：3080 路由没有 approve 入口，而内部生成的指令一律
  `awaiting_approval`（autonomy.js:266-269）。
- **页面文案与实现不符**：按钮说明写「不会发往任何第三方账号」（persona-page.js:1744），
  实际 approved 模式经 dsh-im 真发微信。
- **3080 控制台无认证**（index.js:2927-2929 注释自认），只有 CSRF 防护；
  真正带鉴权的是 7420 治理服务。

---

## 5. 建议的分档（待主人拍板）

分界线：**不可逆的、或会流到外面的，找主人批；其余自主。**

| 谁批 | 包含 |
|---|---|
| **自主** | 只读检索、整理记忆派生字段、重建索引、归并告警、校验备份、跑反思出候选、取消社交候选、改冷却/上限类阈值 |
| **找主人批** | 删记忆、恢复备份、真发到微信、晋升反思写记忆、改通道配置、改 7 个安全开关 |

实现方式（若采纳）：把「谁批」做成独立字段与等级解耦，等级只保留「上限」语义；
四处判定合并为一处；每处写操作前统一过 `requireApproval`。

---

## 6. 审查过程中被推翻的两个判断

留在这里，免得以后又犯：

1. **「自动晋升一条都没跑过」——错。** 只看代码白名单（当前只升 `contradiction`），
   没查库里的痕迹。实际跑了 3 条 `pattern`：`auto_promote` 11:17:02 打开，
   11:34:56 一次性写入三条 `producer='dmn'` 的记忆，内容是
   「「semantic」类的记忆在 5 天里出现了 182 次」这类统计自指的废话。
   之后代码才收窄到只升 `contradiction`。**这 3 条仍在库里参与检索。**
2. **「删除记忆有等级门」——错。** 它无等级无确认词，是系统里最松的不可逆操作。

教训：判断「有没有发生过」要去查事实表，不能只看代码现在怎么写。

---

## 7. 处置记录（2026-11-02 主人决定）

主人三句话的答复：**「1.修复 2.自主 3删除」**——P0 修、晋升反思算自主、废话记忆删掉。

### 7.1 已修

**P0-1 HTTP 反思接口补权限门**（`apps/brain-tools/index.js`，promote/dismiss 路由）

原路由直接调门面，既不看等级也不看暂停。现在补三步，全部复用工具层同一份
`resolveReflectionPermission`，不另抄规则：

1. 工作空间门面未接线 → `501 FACADE_UNAVAILABLE`（判不了就不放行）
2. `paused=1` → `409 GLOBAL_PAUSED`（暂停期间零写入）
3. 等级不够 → `403 LEVEL_TOO_LOW`（promote 需 L3；dismiss 需 L1，L1 只能否 ≤0.45 的弱候选）

dismiss 需要置信度判定，所以先按 id 读候选；读不到按 `null` 走最严路径。

**P0-2 真发前复核策略**（`packages/persona/src/social.js` send 的 approved 分支）

在「候选状态合法」之后、通道检查之前，按**此刻**重查一遍：

- `expires_at` 已过 → `reason: 'expired'`，不发
- `policy_enabled` / `quiet_hours` / `daily_cap` / `cooldown` / `topic_cooldown`
  任一不过 → `reason: <闸门码>`，不发

**刻意不复核 `max_pending`**：它问的是「队排多长」，跟能不能发这一条无关；
而且这条候选自己还在待批队列里，复核它等于自己挡自己。

配套测试两条（`tests/persona/social.test.mjs`）：
「仲裁过关后进了安静时段一律不发」「候选已过期就不发」。

#### ⚠️ 生效方式（踩过一次，记下来）

`apps/brain-tools/index.js` 是插件的**主模块**，进程启动时 import 一次，之后改文件**不会**重新加载。

这跟页面模块不一样：`loadPageModule` 按 mtime 缓存，改 `cognition-page.js` / `sea-page.js`
这类文件会立刻生效、刷页面就行；但 `index.js`、`packages/**` 下的模块改了**必须重启 DSH**。

2026-11-02 实测踩到：改完 index.js 之后运行中的服务（pid 39356，启动于 19:31，早于改动时间 21:23）
仍是旧代码。临时把 `max_level` 降到 L1 打 promote 接口，返回 `ok: true` 并真的晋升了一条，
说明新加的权限门根本没进去。副作用已清理（误晋升的 `mem_2ab4ab6f…` 已删除，epoch 5）。

**教训：改主模块后不能拿线上接口验证，除非先重启。** 要么重启再验，要么只在测试进程里验。

### 7.2 已确认维持现状

**「晋升反思写记忆」= 自主**。当前实现已经是这样：`max_level=L3` +
`reflection.auto_promote=1`，每 6 小时自动晋升，只升 `contradiction`、每轮 ≤3 条。
本次不改。

### 7.3 已执行

删除 3 条自动晋升写入的统计自指废话记忆（`producer='dmn'`）：
`mem_050abf2f…` / `mem_c7f48a30…` / `mem_d90cfaf6…`。
删除账本 epoch 2 / 3 / 4，正文与索引异步清理，旧备份副本等备份到期。

### 7.4 仍未修（下次开工从这里接）

| 级别 | 项 | 现状 |
|---|---|---|
| P1 | 删除记忆无等级、无确认词，还有 6h 自动真删 cron | 未动 |
| P1 | `social.expire()` 无生产调用者，过期候选永久占 `max_pending` | 未动（本次靠人工取消解开） |
| P1 | 改 `social-auto` / `channel` 零审计；`approvedBy` 不落库 | 未动 |
| P2 | `actions.run` 不设门 | 未动 |
| P2 | 文档承诺未实现（L3 放宽期限 / `reversible` 执行器 / `index_rebuild` 重建三表 / `skill_rebuild` 未接线 / `LEVELS.allows` 不参与判定） | 未动 |
| P2 | 页面文案「不会发往任何第三方账号」与实现不符 | 未动 |
| P2 | 「按风险决定谁批」的整体改造（等级与审批人解耦、四套判定合一） | 未动，等主人点头 |

> 注意：本次只修了 P0 两个洞，**「按风险分层审批」这件事本身还没做**。
> 现在仍是「等级当天花板」的老语义，L3 下 L1/L2 动作照样自动放行。

