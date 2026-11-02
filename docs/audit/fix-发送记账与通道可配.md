# 「发出去了却报失败」修复 + 通道可配（2026-10-31）

## 一、Bug：QQ 已经收到，页面却说「没发出去」

### 现象

主人点「批准并发送」→ 手机 QQ **收到了消息**，页面红色提示：

```
没发出去：发送社交候选失败：persona.social.send 失败：constraint failed
```

### 根因（两个错叠在一起）

1. **channel 值违反 CHECK 约束**。`migrations/0008` 里：

   ```sql
   channel TEXT NOT NULL DEFAULT 'console' CHECK (channel IN ('console', 'im', 'other'))
   ```

   我上一轮把 `social.send(id, { channel: 'qq' })` 传了进去 → 写 `social_sends` 时撞约束。

2. **发送与记账的顺序让错误语义反了**。门面里是「先调通道、再写记录」：

   ```
   await channelHook(...)   ← 消息已经发出去了
   await recordSend(...)    ← 这里抛 constraint failed
   ```

   `recordSend` 在 try 块里，异常冒泡到 `catch` → 被当成**通道失败** → 返回 `sent:false`。
   于是「发了但没记账」被报成「没发出去」。**数据说谎比报错更糟。**

### 修法

1. **不再传 `channel: 'qq'`**：让门面按模式给默认值（`dry_run → console`、`approved → im`）；
   渠道细分（qq / 微信 / 飞书…）放进 `receipt_json`，不进 `channel` 列。
2. **门面层把记账和发送解耦**（`packages/persona/src/social.js`）：
   - 通道成功后，`recordSend` 单独 `try/catch`；
   - 记账失败时仍返回 `sent: true`，并带 `recorded: false` + `recordError` + `reason: 'sent_but_record_failed'`；
   - 通道明确失败时，写失败记录也可能抛，同样包住（结论已经是"没发出去"）。
3. **三种结论分开显示**（页面 + 接口 note）：

   | 情况 | 页面 |
   |---|---|
   | dry_run | 试发记录已写入（没有真的发出去） |
   | 已发 + 记账成功 | 已通过 QQ 单聊发出 |
   | **已发但记账失败** | 消息**已经发出去了**（别重复发），但记录没落库：<原因> |
   | 没发出去 | 没发出去：<原因> |

## 二、通道可配（不再写死一个 QQ）

### 存储

`data/persona/channel.json`：

```json
{ "botId": "qq_7987…", "targetId": "tgt_dcca…", "channel": "qq", "label": "我的 QQ 单聊" }
```

- 存文件不存库：这是**运行参数**不是业务事实，改完立刻生效、不需要迁移；
- `outboundChannel` **每次发送现读**配置 → 换通道不用重启；
- 文件不存在时回落到默认（当前 QQ 单聊）。

### 接口

| 路由 | 作用 |
|---|---|
| `GET /api/persona/channels` | 返回当前配置；能拿到 `dshIm` 服务时附带可用 bots / targets |
| `POST /api/persona/channel` | 保存 `{ botId, targetId, channel?, label? }`（同源保护，缺字段 400） |

### 页面

`/dsh-brain/persona` 新增「投递通道」区块：**Bot ID / Target ID / 备注名** + 保存（两步确认）。
页面加载时自动 fetch 当前配置填进去——服务端渲染拿不到它（它不在人格门面里）。

> 拿得到 `dshIm` 服务时提示里会列出可用目标；拿不到就提示去「设置 → IM机器人 → 对应账号 →
> 投递设置」复制。两种都能用，不假装支持自动发现。

## 三、验证

| 项 | 结果 |
|---|---|
| `node --check` 两个改动文件 | 过 |
| 渲染产物 | 通道区块有 3 个字段（botId/targetId/label）+ 保存按钮 + 初始化脚本 + fetch 路径；策略表单与 6 个开关都在 |
| 页面内联脚本编译 | OK |
| 全量测试 | **1007 / 1007 全绿，0 fail** |
| 工具层冒烟 | **41 / 41** |

**诚实说明**：「记账失败但已发出」这条路径**没有单测覆盖**——门面的 `recordSend` 是内部函数，
没有注入点可以稳定制造写库失败。目前靠代码审查（`recordSend` 被独立 try/catch 包住，
失败时只置 `recorded:false`，不改变 `sent:true`）。要真测，得在临时库上 DROP 掉
`social_sends` 表再发一次——这次没做，记在这里。

## 四、重启一次

`social.js`（门面）与 `index.js`（路由）是插件进程内代码，**重启后生效**。
`channel.json` 是数据，改完即时生效。
