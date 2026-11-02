# 在另一台电脑上装起外置大脑

> 2026-11-02 写。原因：主人换了台电脑照 README 装，结果**只有治理面板能打开，别的全打不开**。
> 那不是操作问题 —— 这套东西原来只有一半是可移植的。这份文档和 `tools/install.mjs`
> 就是为了把这件事补上。装完自检通过再交付，别靠猜。

---

## 先认清一件事：这是两个进程

| | 治理面板 | 其他一切 |
|---|---|---|
| 跑在哪 | 独立 node 进程（`node apps/server/index.mjs --port 7420`） | **DSH 宿主进程内部**（插件） |
| 依赖 | 只要源码在那儿 + Node | 必须被 profile 的 node_modules 解析到，并被 cordis 激活 |
| 能不能自己开 | 能，`node apps/server/index.mjs` 就行 | 不能，宿主不认就是 404 |

所以「治理面板能打开」**不代表装好了**。它只证明源码在、Node 能跑。
真正的判据只有一个：**浏览器打开 `http://127.0.0.1:3080/dsh-brain` 能看到记忆列表**。

---

## 三步

### 0. 前置

- **Node >= 22.13**（要用内置 `node:sqlite`；低版本直接起不来）
- **DSH 已经装好、并且启动过至少一次**（`~/.dsh` 或 `%USERPROFILE%\.dsh` 里要有 `profiles/`）
  - 没启动过 → profile 不存在，安装器没地方挂

### 1. 把仓库放上去

```powershell
git clone <这个仓库> D:\dsh-brain      # 放哪都行，别放 C:\Program Files（要写权限）
cd D:\dsh-brain
```

路径可以任意 —— 插件现在自己从文件位置推导库、日志、迁移的路径（见 `apps/brain-tools/brain-home.js`），
不再写死盘符。要强制指定就设环境变量 `DSH_BRAIN_HOME` 指向仓库根。

### 2. 跑安装器

```powershell
node tools/install.mjs
```

它会做六件事，全部幂等（可以反复跑）：

1. 按每个包 `package.json` 声明的依赖，建 workspace 包之间的 junction（**不需要 pnpm、不需要联网**）
2. 把 `apps/brain-tools` 挂进 profile 的 `node_modules`
3. 找到宿主的 `@deepseek-ai/dsh-tools`（插件靠它拿 `defineTool`），给插件链上
4. 往 profile 的 `cordis.patch.yml` 追加 `- insert:` 条目
5. 建 `data/` 目录并跑迁移建库（库已存在则一律不动）
6. 自检：路径推导 / 库能打开 / **插件入口能 import**

常用参数：

```powershell
node tools/install.mjs --dry-run              # 只看计划，不动磁盘
node tools/install.mjs --profile desktop      # 装进指定 profile（默认自动找 web）
node tools/install.mjs --dsh-home "D:\my\.dsh"  # DSH home 不在默认位置时
node tools/install.mjs --pin-paths            # 在 patch 里钉死库路径（默认不钉，让插件自己推）
```

看到 `✓ 全部就绪` 才算过。有 `[FAIL]` 就把那一条解决掉再重跑，它不会替你删任何东西。

### 3. 重启 DSH

```powershell
dsh --profile web --port 3080
# 桌面版：直接退出重开
```

然后：

1. 打开 `http://127.0.0.1:3080/dsh-brain` —— 有记忆列表 = 插件活了
2. 在会话里说一句「查一下外置大脑里关于 X 的记录」—— 模型应该调用 `brain_search`
3. 想看全部 11 个页面：`/dsh-brain`、`/dsh-brain/sea`、`/dsh-brain/usage`、`/dsh-brain/persona`……

---

## 把老数据搬过去（可选）

新机器会建一个**空库**。要带走原来的记忆：

```powershell
# 在旧机器上先停 DSH（让 WAL 落盘），然后
# data/brain.db 一个文件就够了（-shm / -wal 是运行时副产物，不用拷）
```

把 `data/brain.db` 放到新机器仓库的 `data/brain.db`，再跑 `node tools/install.mjs`
（它会看到库已存在，跳过迁移，只校验能不能打开）。

第一次启动后 WAL 会被合并，属正常。

---

## 出问题怎么办

| 现象 | 原因 | 处理 |
|---|---|---|
| 安装器说「找不到 `@deepseek-ai/dsh-tools`」 | DSH 没装，或 home 指错了 | `npm i -g @deepseek-ai/dsh` 一次；或用 `--dsh-home` 指对 |
| 装完 `/dsh-brain` 还是 404 | DSH 没重启，或装到了另一个 profile | 重跑安装器看它报的是哪个 profile 目录；确认 `dsh --profile <那个>` 启动 |
| 页面上记忆数是 0 | 库是新建的（正常），或路径推导到了别处 | 安装器自检里会打印「库：绝对路径」，对一下 |
| `brain_search` 查不到东西但页面有记忆 | 两个不同的库 | 同上，看打印的库路径 |
| 日志里 `[brain-tools] 找不到 dsh-brain 仓库根` | 插件被拷到了仓库外面 | 设 `DSH_BRAIN_HOME`，或把 `apps/brain-tools` 放回仓库里 |
| `node:sqlite` 报错 | Node 太旧 | 升到 22.13+ |

---

## 给未来的自己（维护者）

- **别再往代码里写绝对路径**。所有默认落点都在 `apps/brain-tools/brain-home.js` 一个地方推导。
- **改完别只验 import**。`node --test` 全绿 + 安装器自检过，都不等于宿主认它。
  最低验收线是：隔离 home 起一次真宿主，看到 `/dsh-brain` 返回 200。（2026-10-28 栽过一次：
  替身环境 import 成功、宿主整层静默丢弃，人已经去重启了才发现。）
- 安装器全程不依赖 pnpm。别为了省事加回 `pnpm install` —— 那会在换机器时引入一堆
  registry、网络、版本漂移的问题，而 workspace 包全在本地，直接建链接就够了。
