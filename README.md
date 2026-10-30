# dsh-brain

DSH 的外置大脑：把记忆落到本地 SQLite，让模型在十万字历史之后仍能找回早期约定、接续没做完的活，并且说得清「这次用了哪些记忆」。

> 有效上下文扩展，不是上下文窗口扩展——不靠塞长历史，靠检索。

🧪 **Beta，接口会变**，别拿去当生产记忆系统。只在 Windows + Node 22/24 + SQLite(WAL) 上实测过。

## 能干什么

- **三个显式工具**：`brain_search` 查 / `brain_remember` 记 / `brain_forget` 忘
- **中文检索真能用**：char-space 主路 + trigram 补充 + RRF 融合，hit@10 100%（默认分词只有 50%）
- **实体与关系**：按实体查「关于 X 定过什么」，矛盾并列保留、不替你选边
- **可治理**：独立删除账本、全量备份、隔离恢复（恢复演练 24/24）
- **看得见**：五个本地页面——列表、心海（3D 记忆海）、使用情况、矛盾核验、实体

## 跑起来

```powershell
node --test "tests/**/*.test.mjs"   # 全量 576 项
node apps/brain-tools/smoke.mjs     # 工具冒烟 25 项（临时库，不碰生产）
node tools/run-eval.mjs             # 检索质量评测 120 例
```

页面挂在 DSH 自己的 webServer 上，同源同端口，不用另起服务：`/dsh-brain`。

**接入方式**：已接在 `~/.dsh/profiles/web`，模式 explicit——只挂显式工具，不自动注入。
要关就注释 `web/cordis.patch.yml` 末尾 5 行 `- insert:`，然后重启。

## 文档

设计、契约、各阶段报告都在 [docs/](docs/)，建议从 [CONTRACTS.md](docs/CONTRACTS.md) 开始。
原来那版很长的 README 存档在 [docs/README-full.md](docs/README-full.md)。

## 红线

不改已安装的 dsh 包、不动生产 profile、不迁 Engram/灵枢 现有库、不写凭据进日志、
不碰真实私密历史、不引原生编译依赖（sqlite3 / better-sqlite3）。
