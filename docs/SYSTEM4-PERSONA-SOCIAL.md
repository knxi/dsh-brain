# 系统 4：人格与主动社交（`packages/persona`）

> 2026-10-30 落地。对应迁移 `migrations/0008` 第四/五部分，契约 `docs/SYSTEM-3456-CONTRACT.md`。
> 这份文档只讲**为什么这么设计、明确不做什么、怎么关掉**，不复述代码。

## 0. 一句话

系统 4 做三件事：**把主人手写的人格文件读成结构化的版本**、**给每个用户独立的关系与策略**、
**让主动开口这件事走完「候选 → 评分 → 仲裁 → 发送」四道关（默认一道都不真发）**。

它**不**做的事：不改人格文件、不自己决定什么时候发消息、不编造「我查到了」。

## 1. 六个子模块与数据流

```
   ~/.dsh/AGENTS.md （只读）
        │ import-persona.parsePersonaMarkdown
        ▼
   persona_profiles + persona_versions（五层）── activate/rollback ──→ renderForContext()
        │                                                               （精简注入文本）
        │
   person_models（每人独立）＋ relationship_states（四维）＋ proactive_policies（每人的社交策略）
        │                              ▲ relationship_events（每次变化的依据）
        ▼
   social_candidates ── score() ──→ scored ── arbitrate() ──→ awaiting_approval ── send() ──→ social_sends
                                                                                   └─ dry_run（默认）
        │
   response_decisions（每条输入的回/延/拒/沉默都留痕）
```

## 2. 九个人格字段与五层（为什么这么分）

`import-persona.js` 把 markdown 拆成九个字段：`identity / values / boundaries / tone / address /
relationshipDefaults / taboos / examples / longTermDirectives`。**章节 → 字段的规则是显式写死的
关键词表**，不做语义相似度猜测。猜出来的「价值观」比空的更危险：它会被当成主人的立场去说话。
所以解析不到的字段进 `needsReview`，**留在返回里等人确认**，不落假数据。

进库时按「谁能改」分五层：

| 层 | 内容 | 谁能改 | 为什么 |
|---|---|---|---|
| `locked` | 身份 / 边界 / 禁忌 | **没有人** | 这三样是底线，自动合并等于自己给自己改底线 |
| `base` | 价值观 / 语气 / 称呼 / 关系默认 / 例子 / 长期指令 | 新版本（人工或重新导入） | 会随经历演进 |
| `learned` | 从相处里学到的倾向 | 将来的学习管线（本轮留空） | 导入时假装「学到了」是撒谎 |
| `userOverride` | 主人显式指定 | 主人（控制台） | 覆盖层要能压过 base |
| `transient` | 单次上下文临时覆盖 | 调用方 | 不进历史版本 |

## 3. 五个必须解释的设计选择

**① 人格只读，绝不回写。** 方案 §7.7 说「导入」不是「夺权」。想改人格去改文件，想控制注入去切版本；
两条路分开，出问题时永远能回答「现在注入的是哪一版、它来自哪份文件」（`source_hash` = 内容 sha256，
文件没改就不重新导入）。测试里钉了「导入后文件内容与 mtime 都不变」。

**② 冲突永远不自动消解身份与边界。** `detectConflicts` 收到 `autoResolve: ['identity', ...]` 也会
无视它（`NEVER_AUTO_RESOLVED` 硬判），永远写 `unresolved`。`contradiction` 同理：两边都可能是真的，
自动选边等于替主人下结论。只有 `style` / `preference` 在显式要求时可以 `keep_new`。

**③ 只允许一个 active。** 门面里「旧 active → superseded，新 → active」在同一事务；schema 的
`ux_persona_versions_active`（部分唯一索引）兜底。绕过门面直插第二个 active 会炸——测试钉了这条。

**④ 关系四维不合并，且变化有幅度与冷却。** 熟悉/信任/亲密/好感分别存：一个人可以「很熟但不信任」，
合并成一个数字就把「能不能托付」和「能不能开玩笑」抹成同一件事。变化两道闸：

- 单次每维 ≤ **0.08**（`MAX_STEP_DELTA`）——一句「谢谢」不能把信任顶到 1.0；
- 同 `kind` 10 分钟内每维累计 ≤ **0.12**（`COOLDOWN_WINDOW_MS` / `COOLDOWN_CAP`）——防重复调用刷关系。

每次实际变化必写 `relationship_events`（记**实际生效**的增量），没有依据的数字就是来路不明的浮点数。
新用户从 **0.1** 起步，**不继承任何人的值**。

**⑤ 主动社交默认一条都不发。** 这是本模块最要紧的一条，见下一节。

## 4. 主动社交的四道关与三道闸

链路（方案 §7.5）：候选生成 → `score()` → `arbitrate()`（策略闸）→ `send()`（默认 dry_run）。
**不允许模型临时起意直接发送**——每个候选必须先落表、带 `evidence_json`（只有 id）、带
`score_breakdown_json`（凭什么给这个分）。

**评分公式**（`50 + 相关性 + 实际帮助 + 来源质量 + 关系适配 + 新鲜度 − 打扰成本 − 重复度 − 忙碌/负面反馈 − 压力资源`，
夹到 0–100，门槛 55，移植自 `plugins/dsh-fox-mood/core.js` 的 `shouldReachOut`）：

| 硬闸（不给加权留口子） | 理由 |
|---|---|
| 本地 0–6 点 | 深夜不吵人 |
| 距上次**真发**不足 30 分钟 | 刚找过不重复烦 |
| 精力 < 25 | 自己都困了，别去表达 |
| 心情 < 30 | 心情差容易说错话 |
| 没有 evidence | 编造的关心比不关心更糟 |
| **弱 care 信号**（`source_quality`） | 「加班/汇报/会议」这类没有「后来怎么样了」，不配占一次开口 |
| 开关 / 该用户策略关闭 | 见下 |

命中任一 → `status='rejected'` 且 `reason` 记闸名（分数仍然算出来，方便事后解释）。

### 4.1 `unfinished_care` 为什么单独有一道质量闸（真踩过的坑）

这个来源最容易产出垃圾候选。第一版它在生产库上生成了三条：

> 「上次你提到『是本项目的 Team Lead，需向其汇报』，后来怎么样了？」
> 「上次你提到『备份体检踩到两个坑并已修复』，后来怎么样了？」
> 「上次你提到『要结果不要流程汇报』，后来怎么样了？」

三条都是稳定事实 / 已收尾项目状态 / 沟通偏好，全都不是「有后续状态的事」。
`「上次你提到 X，后来怎么样了？」` 只对**身体、情绪、正在处理的具体安排**成立；
拿去问项目事实读起来非常傻，问第三次就让人烦——而这是主人打开 dry-run 的第一屏。

修法是**在生成源头就只认真正 care 的事**，外加一道硬闸（`packages/persona/src/care.js`）：

1. **记忆类型只认 `episode` / `commitment`**：`profile` / `semantic` / `boundary` / `relationship`
   是稳定事实，没有「后来怎么样了」；
2. **关键词白名单收窄**到身体、情绪、有时点的具体安排（见 `CARE_STRONG_KEYWORDS`，
   每个词为什么算 care 都写在注释里）。刻意不收「累」「烦」「疼」单字，也不收
   「汇报」「体检」「项目」「安排」「计划」这类会命中稳定事实的泛词；
3. **已收尾语义直接不问**：正文含「已修复/已完成/搞定了/解决了」等（`CARE_COMPLETED_MARKERS`）
   ——对方早就收尾的事，问等于没读；
4. **强/弱分级**：弱信号（只剩「加班/开会/汇报/体检/安排/计划」）照常生成候选但被
   `source_quality` 硬闸挡掉。弱信号不靠「调低权重」处理——那只是让它更不容易过门槛，
   垃圾还是会造出来；现在是**直接不过门槛**。

结果是生产库上 dry-run 从「三条错候选」变成「零条 + 逐来源说明为什么没有」。

**策略闸**（`proactive_policies`，每个用户独立）：`enabled` / `quiet_hours` / `daily_cap` /
`cooldown_minutes` / `topic_cooldowns` / `max_pending`。过了才 `scored → awaiting_approval`。

**默认值刻意保守**：`daily_cap=2`、`cooldown_minutes=180`、`max_pending=1`、`channels=["console"]`。
宁可少说一句，也不做那个烦人的东西。

## 5. 三个开关怎么关掉一切（默认就是关的）

| 开关 | 默认 | 关掉后的行为 |
|---|---|---|
| `social.enabled` | `0` | 候选**不落表**、状态不推进、`social_sends` 一条都不写；`preview` 仍能只读预演 |
| `social.allow_external` | `0` | 不真发；`send({mode:'approved'})` 直接返回 `external_disabled`，连记录都不写 |
| `paused` | `0` | 优先级最高：即使 `social.enabled=1` 也零写入 |

实现细节：本模块自己读一遍三个开关，**同时**调 `workspace.assertAllowed({ module:'social' })`，
两边口径漂移时**取严不取宽**（任一边说不行就是不行）。**没注入 workspace = 全部视为关闭**。

`dry_run` 也要过这道门：「没真发出去」不等于「可以不受开关约束」。

## 6. 明确不做的事（写在这里，免得以为漏了）

1. **不做真 IM 通道。** `send({mode:'approved'})` 只调注入的 `channel` 钩子；没注入就返回
   `{ queued:false, reason:'no_channel_configured' }` 并留一条 `ok=0` 的 approved 记录（尝试过但没发出去）。
   `social.allow_external=1` **不会**凭空产生一个通道。
2. **三类候选来源没做**：`shared_memory` / `verification` / `curiosity`。它们没有可靠的机器可读依据，
   硬做只能编。`generate()` 会在 `skipped` 里如实列出 `not_implemented`。
3. **不自动外发、不自动处理冲突、不自动激活版本。** 三件事都要人。
4. **不伪造「已读」或对方态度。** `response_decisions` 只记「我这边打算怎么回、为什么」。
5. **不写 `~/.dsh/AGENTS.md`。**
6. **不读 memories 正文之外的隐私内容**：候选 `evidence` 只放 id；`text` 是要发出去的内容（可以存）。

## 7. 保护类输入禁止沉默

`formal_task / correction / forget / permission / stop / commitment` 六类输入一旦被判成 `silent`，
等于「主人说了话，系统装没听见」。所以：

- 默认行为：**强制改 `reply`**，`reason_category='protected_input_forced_reply'`，`forced:true`，
  `notes.originalDecision='silent'`（原始判定留痕，方便查「谁想沉默」）；
- `decide({ strict:true })` 或工厂 `strictProtected:true`：直接抛 `PROTECTED_SILENT_FORBIDDEN`；
- 调用方显式传 `decision:'silent'` 也一样处理：**不存在绕过路径**；
- `inferProtectedKind` 会从 `context.flags` / `context.text` 里嗅保护类——**只用于收紧**，
  嗅不到不会让任何东西变宽松。

## 8. 怎么验证（三个入口）

```bash
# ① 「如果我开着主动社交，它今天本来会说什么」——只读，可安全指向生产库
node packages/persona/bin/social-dryrun.mjs

# ② 指定时刻/指定人
node packages/persona/bin/social-dryrun.mjs --now 2026-10-30T22:00:00+08:00 --person owner
node packages/persona/bin/social-dryrun.mjs --json        # 给控制台/程序用

# ③ 单文件跑测试（受限沙箱里 node --test 会 spawn EPERM）
node tests/persona/import-persona.test.mjs
node tests/persona/persona-versions.test.mjs
node tests/persona/relationship.test.mjs
node tests/persona/social.test.mjs
node tests/persona/response.test.mjs
```

## 9. 接线点（lead 需要动的地方）

1. `packages/memory/src/index.js`：`const persona = createPersona({ db, queue, clock, alert, workspace, bindings: facadeBindings })`，
   然后 `return { ..., persona }`（或 `persona: persona.entry`，按你的门面风格）。
2. 控制台（`apps/brain-tools`）：`persona.social.preview(...)` 是给「今天本来会说什么」页面的唯一入口；
   `persona.profiles.importFromFile` + `persona.versions.activate` 是「导入并生效」两步；
   `persona.response.listDecisions({ days })` 是决策流水。
3. 真发通道（将来）：`createPersona({ channel: async ({ channel, text, candidate }) => ({ ok, externalId }) })`。
   **没接之前，真发一律返回 `no_channel_configured`。**
4. 宿主想喂「现成依据」时：`social.generate({ signals: { discovery: [{ topic, text, evidence, ageHours }] } })`。

## 10. 已知缺口

- `needsReview` 只在导入返回里列出，**没有落库**（要持久化得加一张表，迁移归 lead）；
  控制台可以用 `persona.profiles.inspectFile` + `importer.previewFile` 现场重算。
- `schedule` 候选的「作息」是从 `relationship_events` 的近 40 条本地小时分布估的（25%–75% 分位），
  不是主人显式配置；数据少于 5 条就不猜。
- `unfinished_care` 仍然是**关键词启发式**，不是理解：它只认 `episode`/`commitment` 里
  身体/情绪/有时点的具体安排（白名单见 `src/care.js`），并排除「已修复/搞定了」这类收尾语义。
  代价是「长期健康状态」这类 `semantic` 记忆不会被关心到——这是刻意选的方向：
  **宁可少问一句，也不要问一句傻的**。真正的语义判断要等模型，不在本模块职责内。
- 弱 care 信号（`加班/开会/汇报/…`）会生成候选但被 `source_quality` 挡掉，dry-run 里折叠成一行计数；
  它们不占每日上限（没真发过），但会以 `rejected` 落表（开关开着时），便于事后核对判据。
- 候选 `text` 目前是模板草稿（本项目没有内嵌模型）；真实措辞应由宿主模型在发送前改写。
- `send(approved)` 先调通道钩子再落库：钩子成功但落库失败时，消息已发出而账没记上（会 `alert`）。
  这是「先发后记」的固有代价，与「先记后发」（可能重复发）二选一，这里选了前者。
