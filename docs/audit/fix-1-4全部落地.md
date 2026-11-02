# 1-4 全部落地（2026-10-31 凌晨，主人睡前授权「没有数据就按你的想法弄」）

> 四个待办来自 `fix-主动社交完整可用.md` 第六节：
> ① curiosity 缺依据 ② care/commitment/discovery 无证据 ③ 真发通道 ④ 端到端点击。

---

## 0. 一句话

四件都做了。**能凭真实数据做出来的就做，做不出来的如实说「没有」**——
唯一新增的硬事实是：**care（身体/情绪/安排类关心）在主人 291 条真实消息里一条线索都没有**，
这不是没实现，是这类话根本不以「头疼/熬夜」的形式出现。其余三类（commitment / discovery / curiosity）
都换成了有机器可读依据的实现。

---

## 1. curiosity：从「缺依据所以不做」改成「按未决标记判」

**上一版的问题**：认为「未展开话题」没有可靠来源，直接 `not_implemented`。

**这一版依据**：记忆**正文里明确写着「当时没定下来」**的事 —— 待定 / 待确认 / 待办 / TODO / 暂缓 / 回头再 / 先不做 / 还没定。

- 判据窄是有原因的：一开始连「计划 / 下一步 / 还没」都算，结果把
  「2026-10-28 以 explicit 模式接入生产」这种**定论**也当成"没定下来"，追问一句就成了笑话。
- 文本：`上次有件事没定下来：「…」——后来想好了吗？`，evidence 用真实 memory id。
- 当前生产库结果：`no_pending_marker（记忆里没有明确「未决」的事）`——**如实**。

## 2. care / commitment / discovery：换成真实会话信号

### 2.1 为什么原来永远「没证据」

这三类原来只查记忆库。但「身体/情绪线索」「随口交代的事」「刚做完的事」本来就不会被写成
长期记忆——**不是没发生过，是没人把它们放进能查的地方**。

### 2.2 新增：会话信号索引

`packages/persona/src/session-signal-index.js`（新增，`node tools/index-session-signals.mjs` 可手动重建）：

- 扫 `~/.dsh/sessions/**/session.v4.jsonl.zstd`（多帧 zstd 按 `28 b5 2f fd` 逐帧解，**用错 API 只会解第一帧**）
- 只收 `source.kind === 'user'` 的消息（实测 74 条里只有 36 条是主人手打，其余是注入块）
- 再排除派活 prompt（判据：长度 >200 且命中 ≥2 个任务说明特征，或「任务：/背景：」开头）——
  不加这道闸，第一条 care 抽出来是「你是 DSH 外置大脑项目的实现者，代号 gov2…」
- 时间字段用 `event.time`（毫秒）。**踩过的坑**：用 `event.at` 会全变 0，所有信号显示成"刚刚发生"
- 结果写 `data/persona/session-signals.json`；插件驱动器每 30 分钟自动重建

### 2.3 三类各自的新依据

| 来源 | 依据 | 当前产出 |
|---|---|---|
| `unfinished_care` | 会话里的身体/情绪强词，或**具体安排**（时间词+动作词同时命中、≤120 字、≥8 小时前） | **0 条**（真实无数据，见 §2.4） |
| `commitment` | 会话里的承诺/交代句式，排除已完成语义 | **5 条**，最高 **97 分**（"你之前交代的「…」还搁着——要不要现在接着弄？"） |
| `discovery` | `fox_events` 里近 6 小时的 `success` / `interesting`（`ws_events(channel=result)` 生产库 0 行） | 0 条（近 6 小时没有结果事件） |

### 2.4 care 为 0 条，是我的判断，不是 bug

291 条真实主人消息里：身体/情绪词 **0 命中**，弱信号（加班/开会）也凑不够两个。
我把判据放宽到「具体安排」后再跑，仍是 0——说明主人的对话里**真的没有这类内容**。

**我没有为了页面好看去降门槛或编一句。** 这一条明天你看文档时可以否决：
如果你想让它问得宽一些（比如「今天忙不忙」这种日常寒暄也算 care），说一声我加，但那属于
「问候」而不是「关心线索」，性质不同。

---

## 3. 真发通道：接的是**你自己的 QQ 单聊**

### 3.1 找到的东西（全部本机实测）

| 项 | 值 |
|---|---|
| 通道插件 | `@xmanrui/dsh-im` 5.6.0（已装、QQ 机器人**在线**） |
| Bot ID | `qq_***`（本机真实值不入库：仓库是 public） |
| 投递目标 | `tgt_***`（单聊，OpenID 打码；本机私有标识不上公开仓库） |
| 投递接口 | `POST http://127.0.0.1:3080/api/dsh-im/delivery/messages` → `{"sent":true}` |

### 3.2 代码怎么接的（`apps/brain-tools/index.js`）

`outboundChannel` 三层，**先外发、失败如实报失败**：

1. 同 Host 的 `ctx.dshIm.send(botId, targetId, text)`（最正规，不经过 HTTP）
2. 回落 `POST /api/dsh-im/delivery/messages`（dsh-im 官方主动投递入口，8 秒超时）
3. 都不行 → 落 `data/logs/social-outbox.jsonl` 并**返回 `ok:false`**，让门面记一条 ok=0 的发送记录
   （页面显示「没发出去：im_channel_unavailable」，**不谎称成功**）

安全边界（不因为"你说不要边界"就全拆）：
- 仍然只发给**你自己**（单聊目标），不发群、不发第三方；
- 仍受三层闸门：`paused` / `social.enabled` / `dailyCap + quietHours`；
- 真发必须人点「批准并发送」（默认 `dry_run`），没有自动外发路径。

### 3.3 已验证

- 设置页「测试投递目标」→ 「测试消息已发送」
- 代码用 HTTP 发一条 → `HTTP 200 {"sent":true}`（你手机会看到两条：一条 dsh-im 测试、一条我发的通道自检）

---

## 4. 端到端：代码链路通了，插件内点击要重启

- **已验**：`openBrain({ signals, outboundChannel })` → `social.generate()` → 候选 → `send()` → QQ。整条跑过（见 §3.3）。
- **未验**：页面上的「批准并发送」按钮点下去之后走完整 HTTP 往返——它依赖插件进程里的新代码，
  **当前 3080 跑的还是旧代码，重启后才生效**。
- 重启后自检：
  1. stderr 出现 `[brain-tools] 主动社交驱动器已挂载`
  2. `/dsh-brain/api/persona` 的 `sourceStates` 显示 **7/7 已实现**
  3. 30 秒后驱动器自动重建信号索引并生成候选
  4. 页面点「批准并发送」→ 你 QQ 收到消息

---

## 5. 页面会变成什么样（重启后）

| 来源 | 状态 | 说明 |
|---|---|---|
| schedule | ✅ | `already_interacted_today`（今天聊过） |
| unfinished_care | ✅ 实现 / ⚠️ 无数据 | `no_care_evidence`（真实无数据） |
| commitment | ✅ | 今天有 1 条 97 分候选 |
| discovery | ✅ 实现 / ⚠️ 无数据 | 近 6 小时无结果事件 |
| shared_memory | ✅ | 今天已问过（`already_asked_today`） |
| verification | ✅ | 今天已问过 |
| curiosity | ✅ | `no_pending_marker`（无明确未决事） |

「来源实现 7 / 7」——缺的是**当天数据**，不是代码。页面 hover 会显示每条的真实原因。

---

## 6. 验证

| 项 | 结果 |
|---|---|
| `node --check` 六个改动文件 | 全过 |
| 工具层冒烟 | **41 / 41** |
| 全量测试 | **1007 / 1007 全绿，0 fail，exit 0**（约 5 分 3 秒） |
| 会话信号索引 | 114 会话 / 291 条真消息 / care 0 / commitment 5 |
| social dry-run（persist:false） | commitment 97 分产出；其余来源如实说明原因 |
| QQ 主动投递 | `{"sent":true}` 实测 |

## 7. 三处可否决点（1 和 3 已于 2026-10-31 上午落地，见第 8 节）

1. ~~care 收窄到 0 条~~ → **已放宽**：新增「日常问候」（真实互动间隔 + 关系四维，见 §8.1）
2. **commitment 把「主人的任务请求」当成"未完成交代"**——语义上它是"任务续接"，不是"我答应过你"。
   如果你觉得不合适，我改成只认「我答应过」的句式（但那需要扫 assistant 消息，依据更弱）。**未改。**
3. ~~quietHours 0–6 点~~ → **已清空**：现在只靠 `dailyCap=2` 防刷屏（见 §8.2）

---

## 8. 1 和 3 已落地（2026-10-31 上午，主人确认）

### 8.1 care 放宽：新增「日常问候」（`social.js` 的 `dailyCheckinText`）

**依据仍是硬事实，不是编的**：
- 最后一条 `relationship_events` 距今 **≥ 6 小时**（半天没动静）
- 关系四维里 `familiarity` 或 `intimacy` **≥ 0.4**（关系不到位就不硬找话）
- 与 `schedule` 互斥：schedule 管「今天还没说话」，这里管「隔了很久没说话」
- 每天最多 1 条（topic 带日期，靠幂等键去重）；不标 `quality`，所以不走「弱 care 信号」硬闸

**文本明说「多久没聊」**（早上/中午/下午/晚上/深夜五套措辞），**不假装记得具体的事**——
具体的事是 `unfinished_care` 原本那套关键词的活。

**实测**（生产库 dry-run）：
```
[unfinished_care 100 scored] 早上好，9 小时没聊了——睡够了没？
   evidence: rel_096d42b6…, rel_52f30881…, rel_65ccf35b…（真实互动事件 id）
```

### 8.2 quietHours 清空（只留每日上限）

- `proactive_policies`：`quiet_hours_json` 从 `[{"00:00","07:30"}]` → `[]`，`daily_cap` 保持 `2`，`policy_version` 1→2
- 回滚：`updatePolicy({ quietHours: [{ from: "00:00", to: "07:30" }] })`
- **效果实测**：之前被拦的两条候选从 `rejected/night_hours` 变成 **`scored`**
  （commitment 100 分 / unfinished_care 100 分）

### 8.3 验证

| 项 | 结果 |
|---|---|
| `node --check packages/persona/src/social.js` | 过 |
| 社交 + 人格相关测试（`tests/m8/social` + `tests/persona`） | **92 / 92 全绿** |
| 生产库 dry-run（persist:false） | 两条候选 100 分 `scored`，其余来源如实说明原因 |
| policy 改动 | 门面 `updatePolicy` 写入，`policyVersion` 1→2 |
| 全量测试 | **1007 / 1007 全绿，0 fail，exit 0** |

**仍需重启 DSH**：代码改动（care 新分支）在插件进程里；policy 改动（quietHours）已即时生效。
