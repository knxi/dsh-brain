# MIGRATION — 从 Engram / 灵枢迁入外置大脑

> 2026-10-29 首次执行。这份文档记的是**方法 + 判断依据 + 结果**，不是操作手册。
> 工具在 `tools/`：`survey-memory-sources.mjs`（普查）、`import-engram.mjs`（导入）、`verify-import.mjs`（验收）。

## 0. 为什么要迁移

主人的机器上同时跑着三套记忆系统：Engram（`@kenz1117/dsh-engram`）、灵枢（`@furongjun1999/dsh-memory`，记忆宫殿 MDCG）、以及新建的外置大脑。
外置大脑是 explicit 模式（只有显式工具，不自动注入），所以**在它自己学会自动提取之前，不能卸掉前两个**——否则会从「自动记得」退化成「想不起来就查不到」。

迁移是卸掉旧系统的**硬前置**。但迁移不是无脑全搬。

## 1. 普查结论（关键，推翻了直觉）

| 数据源 | 存量 | 实际可迁 | 判断 |
|---|---|---|---|
| **灵枢 MDCG** | 33 个节点 | **2 条** | 基本没价值 |
| **Engram** | 208 行（nodes + facts） | **205 条** | 真正的宝库 |

**灵枢为什么没价值**：33 个节点全是 `layer=contextual` / `role=user` —— 它存的是**对话原文**，不是提炼后的记忆。证据数全 0，高重要度（≥0.5）只有 5 条，其中 2 条还是 2026-10-29 凌晨的对话。
它的价值在**自动注入机制**，不在数据。所以**不迁灵枢**：把对话碎片灌进来只会稀释检索质量。

**Engram 为什么有价值**：`nodes` 表存的是提炼过的记忆（`content` + `kind` + `importance` + `confidence` + `source_session_id`），`facts` 表是实体事实链（`content` + `valid_at` + `invalid_at` + `replaced_by`）。这才是「记忆」的形状。

## 2. 迁移映射

| Engram | 外置大脑 | 说明 |
|---|---|---|
| `nodes.content` / `facts.content` | `memories.content` | 纯文本，不过度清洗 |
| `nodes.kind` | `memories.type` | episode→episode / decision→semantic / fact→semantic / preference→profile / skill→skill / commitment→commitment |
| `nodes.importance` | `memories.importance` | 原样，夹到 [0.1, 1] |
| `nodes.confidence` | `memories.confidence` | 原样，夹到 [0.3, 1]（二手来料，不该给满分） |
| `nodes.source_session_id` | `sources.link(sourceEventId)` | 保留来源 |
| — | `memories.sourceType = 'summary'` | **刻意不用 owner_words**：迁来的是二手来料，不能冒充主人原话 |
| — | `memories.originSystem = 'engram'` | 契约 10.6 的防循环字段。系统靠它认出「这不是本系统的独立证据」 |
| `nodes.embedding`（2048 维） | **不迁** | 我们的检索是 char-space FTS，两套向量不通，迁过来是死重 |
| `entities` / `edges` / `node_entities` | **不迁** | 没有 content 可检索；关系边等外置大脑能表达关系时再补 |

## 3. 三条硬纪律

1. **凭据必须脱敏，且在预演阶段就脱，不是真写时才偷偷改。**
   Engram 里确实存着 FTP 明文密码（`密码=xxxx`）。契约明令：密钥/凭据不写入普通记忆正文。
   工具用三组正则（`密码|password|pwd`、`token|api_key|secret`、`ftp://user:pass@`）在收集阶段就替换成 `[凭据已移除]`，预演报告里能看到命中数。
   首次执行：**4 条命中**，全部脱敏后入库。
   > 附带发现：Engram 自己其实也做脱敏（有条记忆写着「密码不落记忆库，engram 入库自动脱敏为 [REDACTED:password]」）。我们的脱敏是第二道保险。

2. **幂等。** 用 `content` 的 sha256 前 16 位做指纹去重，跨库同内容只留一份；导入前再和库里已有内容比对一次。重复跑不会灌重复。

3. **失败不中断。** 逐条 try/catch，最后汇总；一条坏数据不该让整次迁移停摆。

## 4. 首次执行结果

```
收集 208 行 → 太短跳过 1 → 脱敏 4 → 跨库重复 2 → 导入 205，失败 0
```

验收（`node tools/verify-import.mjs`）：

```
记忆总数 217（12 手工 + 205 迁入）
来源引用 217（每条都有出处）
类型分布 semantic 169 / skill 19 / profile 16 / episode 13
凭据残留 干净
检索     mumu.bio ✓  Cloudflare ✓  反向代理 ✓  外置大脑 ✓
星海     200 点 / 4 簇
```

## 5. 还没做的

- **灵枢没迁**（判断见 §1）。如果以后发现灵枢里有值得留的，单独挑。
- **entities 没迁**：Engram 有 105 个实体（人物/项目/工具/概念）。外置大脑目前没有实体表，等做关系图时再补。
- **edges 没迁**：Engram 有 `contradicts` 这类关系边。外置大脑的 `memories.supersedes` 只能表达取代，表达不了矛盾，也等后续。
- **反向迁移工具**没有：迁进来就回不去了（Engram 那边数据没动，仍可用）。

## 6. 现在能不能卸 Engram / 灵枢

**还不能。** 迁移只解决了「数据搬过来」，还差两件：

1. **自动提取** —— 外置大脑现在只有显式工具，主人不说「记住」它就不记。灵枢和 Engram 是自动摄取。卸了等于**停止记录新东西**。
2. **观察期** —— 迁进来的 205 条要实际用几轮，确认检索准不准。迁过来不等于用得好。

顺序建议：先并行跑 → 观察一周 → 先关一个（Engram 或灵枢）→ 再关另一个。
卸载前必须完整备份：`E:\ds-h\tools\backup\backup-dsh.ps1`。
