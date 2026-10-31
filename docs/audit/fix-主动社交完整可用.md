# 主动社交：从「不能用」到「完整可用」（2026-10-31 凌晨）

> 起因：主人看 `/dsh-brain/persona` 页面，问「这里为什么不能使用，功能要完整可用，不要管什么权限」。

## 0. 一句话

**页面空不是权限卡的，是四层缺口叠在一起**：开关关着（已开）、没有任何人在生成候选（已接驱动器）、
人格档案和关系数据是空的（已从真实数据补上）、三类来源没实现（已做两类，第三类缺数据如实标出）。
真发到 QQ/IM 是**第五层**，那是对外动作，等你点头。

---

## 1. 四层缺口逐条对照

| 层 | 页面症状 | 真实原因 | 现在 |
|---|---|---|---|
| 权限 | 「当前被拒绝: social_disabled」 | 我上一轮把开关退回默认 | **已全开**：`paused=0` / `autonomy=L3` / `social=1` / `allow_external=1` / `reflection=1` |
| 驱动器 | 「没有一条本来会发的候选」 | **没有任何东西调 `social.generate()`**（packages 里除 write-queue 外零定时器） | **已接**：启动 30s 后一次、之后每 30 分钟生成候选（只生成不发） |
| 数据 | 「没有激活人格版本 / 关系四维全 0.1 / 作息不够」 | `persona_*` / `relationship_events` 都是空表 | **已补**：人格 v1 激活、141 段真实互动、四维 0.946/0.664/0.523/0.805 |
| 代码 | 「共同记忆 / 求证 / 好奇：not_implemented」 | 三类来源硬编码跳过 | **已做 2 类**（共同记忆、求证），第 3 类（好奇）缺数据、如实标注 |
| 通道 | 「外发能力 无（只含 dry_run）」 | `openBrain` 没传 `outboundChannel` | **已接本机 console 通道**（落 `data/logs/social-outbox.jsonl`，不发第三方） |

---

## 2. 现在真正能跑通的动作

### 看「它本来会说什么」
```powershell
cd E:\ds-h\dsh-brain
node packages/persona/bin/social-dryrun.mjs     # 只读预演，不写库、不发
```
实测输出（00:55 跑的）：
- `shared_memory` **80 分**：「10月15日定下的事我还记着：dsh-grsai-canvas 画布插件当前任务是全面审查并优化代码…还照这个来吗？」
- `verification` **79 分**：「这条我记的是『外置大脑的目标：补齐能力后卸载 Engram 与灵枢』，置信度只有 0.80——现在还准吗？」
- 两条都**卡在 `night_hours`**（0–6 点是硬闸）→ 分数过了 55 门槛，白天会进 `scored`。**这是闸门在工作，不是故障。**
- 实现的来源：schedule / unfinished_care / commitment / discovery / **shared_memory** / **verification**
- 缺数据：curiosity（原因写到了具体字段：`reflections` 0 行、kind 枚举无 curiosity）

### 在页面上批准
`/dsh-brain/persona` → 候选卡 → 「试发（不真发）」/「批准并发送」：
- 试发 = `mode:'dry_run'`，只记一条 `social_sends`，不真发
- 批准 = `mode:'approved'`：先过 `arbitrate()`（静默时段/每日上限/策略闸），再投递到**本机 console 通道**，落 `data/logs/social-outbox.jsonl`；被拒会照实显示原因
- 页面上的「来源实现 6 / 7」是数据驱动的，不再写死

### 关系与人格已经是真的
| 项 | 值 |
|---|---|
| 人格档案 | 1 个（小狐狸），来源 `~/.dsh/AGENTS.md`，五层解析、2464 tokens |
| 激活版本 | v1（`pver_8f99e7bdac23dfe641bd5a6f`） |
| 关系四维 | 熟悉 0.946 / 信任 0.664 / 亲密 0.523 / 好感 0.805 |
| 关系事件 | 141 段（2026-08-14 → 10-31，近 14 天 90 段） |

关系事件全部来自**真实会话**：333 条 `source.kind==='user'` 里剔掉 56 条子代理派活 prompt，剩 277 条真开口，按 10 分钟合并成 141 段，走 `applyEvent()` 门面写入（幂等、无裸 INSERT）。

---

## 3. 需要重启才生效的部分

代码改动（驱动器、console 通道、`/api/persona/social/send`、两类新来源、页面按钮）都在插件进程里，
**当前 3080 跑的还是旧代码**。重启后：
- stderr 应出现 `[brain-tools] 主动社交驱动器已挂载`
- `/api/persona` 的 `social.available` 应为 true、`sourceStates` 显示 6/7
- 30 秒后驱动器跑第一次生成

---

## 4. 第五层：真发（等你点头）

现在接的是**本机 console 通道**：能走完整链路（仲裁 → 记录 → 回执 → 失败原因），但不触达任何第三方。
要真发到 QQ / IM / 邮件，需要再写一个 `channelHook`。细节见 [通道调研.md](通道调研.md)。

**风险**：发出去收不回，只能靠「人审批 + 每日上限 + 静默时段」兜。这个不点头我不动。

---

## 5. 验证

| 项 | 结果 |
|---|---|
| 全量测试 | **1007 pass / 0 fail**（989 + 新增 18 条社交来源测试） |
| 工具层冒烟 | **41 / 41** |
| 人格/关系 API | profiles 1 / versions 1 / activeVersion 非空 / relationship 四维已变 |
| schedule 跳过原因 | `insufficient_history` → `already_interacted_today`（作息已能估） |
| 生产库 memories | 226 → 226，未动 |
| 备份 | `data/backups/manual-before-persona-data-20261031-003706.db`（在线 backup + integrity 校验） |
| 回滚 | 见 `fix-人格与关系数据.md` §8 |

## 6. 仍然没做 / 做不了

1. **curiosity 来源**：缺机器可读数据（反思引擎未产出 knowledge_gap、实体多是代码标识符）。不硬做——拿关键词冒充好奇就是编造。
2. **`unfinished_care` / `commitment` / `discovery` 目前无证据**：近 14 天确实没有身体/情绪线索、没有未完成承诺、近 6 小时没有真实结果事件。这是数据真相，不是 bug。
3. **真发通道**：见第四节，等你点头。
4. **端到端点击**：页面按钮只做了渲染层 + 接口契约比对，真实 HTTP 往返要等重启后实点一次。
5. 关系四维偏高（熟悉 0.946）是因为把 77 天的真实互动一次性回填了；如果觉得涨太快，调节 `relationship.js` 的增量系数后重跑导入即可（幂等）。
