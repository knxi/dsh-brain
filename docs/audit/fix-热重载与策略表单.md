# 页面热重载 + 策略表单（2026-10-31）

## 一、页面模块热重载

### 动机

页面是 ESM 模块，`import './persona-page.js'` 之后进模块缓存——**改完文件不重启就一直是旧版本**。
这两天每次调样式/文案都要重启整个 DSH（5 秒 + 断掉当前会话），摩擦太大。

### 做法

`apps/brain-tools/index.js` 新增 `loadPageModule(fileName)`：

1. 读文件 **mtime** 当版本号；
2. `import(fileUrl + '?v=<mtime>')` —— ESM 的缓存键是**解析后的完整 URL**，
   带不同 query 就是不同模块实例，所以改完文件下一次请求自动用新版；
3. 同文件的旧版本从 Map 里清掉，缓存不会无限增长；
4. 读不到 mtime 时退化成普通 `import`（行为与以前一致，不会因此报错）。

迁移范围：
- 5 个静态 import（console / sea / usage / conflicts / entities-page）→ 运行时热加载
- 10 处 `await import('./xxx-page.js')`（governance / mood / workspace / cognition / persona / directives）→ 统一走 `loadPageModule`

### 边界（诚实说明）

| 能热重载 | **不能**（改了照样要重启） |
|---|---|
| 11 个页面渲染模块 | 依赖池（`@dsh-brain/memory` 等） |
| 页面的内联 JS/CSS 模板 | 工具注册（`brain_search` 等） |
| — | `session/event`、`system-prompt/assemble` 等钩子 |
| — | 插件顶层常量（`DEFAULT_STORE` 这类） |

原因：热重载只换「渲染函数」，不换「插件已注册到宿主的东西」。这是刻意的边界，
不是没做完——随便重载钩子会让宿主持有一份旧引用，比重启更难查。

### 怎么证明它真的生效（重启后）

```powershell
# 1) 改一行页面文案
(Get-Content E:\ds-h\dsh-brain\apps\brain-tools\persona-page.js -Raw) -replace '人格与主动社交', '人格与主动社交（热重载测试）' | Set-Content E:\ds-h\dsh-brain\apps\brain-tools\persona-page.js

# 2) 刷新 /dsh-brain/persona —— 标题应该立刻变，不用重启
# 3) 改回来，再刷新
```

## 二、策略表单

页面上原来只有一行只读文字：`策略 enabled: true; dailyCap: 2; cooldownMinutes: 180; maxPending: 1; quietHours: []`。
现在换成可编辑表单（`persona-page.js` 的 `policyEditor()`）：

| 字段 | 范围 | 含义 |
|---|---|---|
| 每日上限 | 0–100 | 一天最多真发几条（0 = 一条都不发） |
| 冷却（分钟） | 0–10080 | 两条之间至少隔多久 |
| 待批准上限 | 0–100 | 队列里最多攒几条 |
| 免打扰时段 | `HH:mm-HH:mm, ...` | 留空 = 不设免打扰 |

新接口 `POST /api/persona/policy`（同源保护 + 两步确认），范围校验在接口层。

### 踩到的一个坑（重要）

第一次实现是直接 `Number(body.dailyCap)` 交给门面。实测 `dailyCap=999` **没报错**——
门面的 `clampInt` 是**静默夹取**：999 被悄悄改成 100，接口却返回 `ok:true`。
页面会显示「已保存」，但值不是用户填的。**这是"看起来成功、实际没照做"，比报错更糟。**

改成接口层显式校验（`intField`）：非整数或越界 → 400 + 说清范围和收到的值。
已把测试时被夹成 100 的 `dailyCap` **还原为 2**。

## 三、验证

| 项 | 结果 |
|---|---|
| `node --check` 两个改动文件 | 过 |
| 渲染产物 | 策略表单 4 字段（dailyCap / cooldownMinutes / maxPending / quietHours）＋ 保存按钮 ＋ CSS 都在；开关按钮仍 6 个 |
| 页面内联脚本编译 | OK |
| 门面策略改写 | `dailyCap` 2→3→2、`quietHours` 字符串解析成两段再清空 —— 全部生效，`policyVersion` 逐次 +1 |
| 越界拒绝 | 改成接口层校验后，999 会返回 400（不再静默夹成 100） |
| 工具层冒烟 | **41 / 41** |
| 全量测试 | **1007 / 1007 全绿，0 fail** |

## 四、还要重启一次

热重载的**装载器本身**在 `index.js` 里，所以这次必须重启一次（之后页面改动就不用再重启了）。
