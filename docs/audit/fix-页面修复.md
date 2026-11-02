# 页面级修复（task-4）

> 责任人：fix-pages · 日期：2026-10-30
> 写作用域：`apps/brain-tools/usage-page.js`、`apps/console/index.html`、必要时 `apps/console/app.js`
> 未触碰 `apps/brain-tools/index.js`（Lead 独占）。未重启服务、未写库、未跑会写 `data/brain.db` 的脚本。

---

## 一、改动清单

| # | 文件 | 行号（改后） | 改动 |
|---|---|---|---|
| 1 | `apps/brain-tools/usage-page.js` | 27–30 | 新增 `usageApi` 常量：接口地址在服务端拼好再插进页面脚本 |
| 1 | `apps/brain-tools/usage-page.js` | 324 | `fetch('/dsh-brain/api/usage?days=${days}', …)` → `fetch('${usageApi}', …)` |
| 2 | `apps/brain-tools/usage-page.js` | 285–290 | `renderNever` 覆盖率文案改口径：两个数各自标注 |
| 3 | `apps/console/index.html` | 17 | 副标题 `M3 · 只读检查器` → `记忆治理面板 · 可读可写（写操作需 token）` |
| 3 | `apps/console/index.html` | 403 | 面板标题 `治理能力（M3）` → `治理能力` |

### 1. usage 页天数参数（`usage-page.js:27–30, 324`）

**改前**
```js
const days = Number(windowDays) > 0 ? Number(windowDays) : 7
return `<!DOCTYPE html>
…
  fetch('/dsh-brain/api/usage?days=${days}', { credentials: 'same-origin' })
```

**改后**
```js
const days = Number(windowDays) > 0 ? Number(windowDays) : 7
// 天数窗口是**服务端**变量：接口地址在这里拼好，页面脚本只负责把字符串搬进去。
// 不写成「单引号里放 ${days}」——那虽然也能被外层模板串插值成数字，但读起来像坏掉的
// 模板串（审计就把它读成了 bug），靠隐式行为兜底不如显式拼一次。
const usageApi = '/dsh-brain/api/usage?days=' + days
…
  fetch('${usageApi}', { credentials: 'same-origin' })
```

> ⚠️ **审计判断需要更正**：这一处**不是运行时 bug**。整段页面是 `renderUsagePage` 返回的
> 外层模板字符串，单引号只是页面脚本里的字符串字面量——`${days}` 仍会被**外层**模板串
> 插值。实测渲染（windowDays=14）输出：
>
> ```
> fetch('/dsh-brain/api/usage?days=14', { credentials: 'same-origin' })
> ```
>
> 天数参数一直是生效的。真实问题只是**可读性陷阱**：看着像坏模板串，读代码/审计时容易误判。
> 所以本次不是「修一个坏的运行时」，而是把隐式插值改成显式服务端拼接，行为不变、读起来不再可疑。
> 若按审计原意「改成反引号模板串」，得到的会是外层先插值、内层反引号再当普通字符串跑，
> 与现状等价但多一层无意义语法，故未采用。

### 2. 覆盖率文案自相矛盾（`usage-page.js:285–290`）

**改前**
```js
    if (!cov){ return }
    txt('cov-n', '　' + cov.neverHit + ' / ' + cov.totalMemories + ' 条，覆盖率 ' + pct(cov.touchedRate))
```
渲染结果：`178 / 218 条，覆盖率 18.3%` —— 178/218 实为 81.6%，与 18.3% 互相打脸。

**改后**
```js
    if (!cov){ return }
    // 两个数口径不同，必须各自标注：neverHit 是「从没被查到过的条数」，touchedRate 是「覆盖率」。
    // 并排写成「178 / 218 条，覆盖率 18.3%」会被读成 178/218=18.3%，而 178/218 实际是 81.6%
    // ——两个正确的数放在一起互相打脸。总数为 0 时不给分母，显示 '–' 而不是 NaN。
    var neverShare = (cov.neverHit != null && cov.totalMemories > 0)
      ? (cov.neverHit / cov.totalMemories) : null
    txt('cov-n', '　从没被查到过 ' + cov.neverHit + ' 条（占 ' + pct(neverShare) + '）· 覆盖率 ' + pct(cov.touchedRate))
```

渲染结果：
- 正常数据（178 / 218 / 0.183）：`　从没被查到过 178 条（占 81.7%）· 覆盖率 18.3%`
- 空库（0 / 0 / null）：`　从没被查到过 0 条（占 –）· 覆盖率 –`（无 `NaN%`）

数字来源未改：占比用同文件既有的 `pct()`（`Math.round(v*1000)/10`）计算，178/218=81.65% →
四舍五入 81.7%（与审计示例的截断写法 81.6% 属同一数值的两种取舍，这里与既有 `pct()` 口径一致）。

### 3. 7420 面板过时文案（`apps/console/index.html:17, 403`）

**改前 → 改后**
- L17：`<p>M3 · 只读检查器</p>` → `<p>记忆治理面板 · 可读可写（写操作需 token）</p>`
- L403：`<h3 class="panel__title">治理能力（M3）</h3>` → `<h3 class="panel__title">治理能力</h3>`

面板实际能力（删除 / 备份 / 恢复 tab 与写按钮）与「治理能力（M3）」里的阶段标记已不再需要
对外露；改后如实说明「可读可写，写操作需 token」。

**grep 全量核对「只读检查器 / M3」（`.html` 与 `.js` 中用户可见文案）后，有意保留的：**

| 位置 | 内容 | 保留理由 |
|---|---|---|
| `index.html:7` | `<title>外置大脑 · 检查器</title>` | 不含「只读」，是「检查器」这个产品定位，不属于过时表述 |
| `index.html:54` | `这个实例不能上线，只能只读检修` | 隔离实例的**真实状态**描述，不是面板自我定位 |
| `index.html:398` | `<dt>只读</dt>` + `#h-readonly` | 主账文件的 `readOnly` 真实字段名，不能改 |
| `app.js:3` | 文件头注释「只读检查器前端」 | 内部注释，用户不可见；且不属 bug（见下） |
| `styles.css:2` | 文件头注释「外置大脑 · 只读检查器」 | 同上；`styles.css` 不在本任务写作用域 |
| `apps/server/package.json:6` | description「只读检查器后端 + …」 | 内部元数据，且已自带「受控写入/删除」说明 |

`app.js` 中无 masthead 副标题的动态赋值（grep `masthead|subtitle|document.title` 无命中），
故本任务未改 `app.js`。若 Lead 希望连注释一起统一，只需改 `app.js:3`、`styles.css:2` 两行注释，
对运行无影响。

---

## 二、验证

### 1. 语法

```powershell
cd E:\ds-h\dsh-brain
node --check apps\brain-tools\usage-page.js     # exit=0
```

内联 `<script>` 是页面脚本，`node --check` 只校验外层 ESM，另用 `new Function()` 编译内联脚本：

```
inline script : 语法 OK (7854 chars)
```

### 2. 真实渲染 + 真跑内联脚本

用最小 DOM stub + fetch stub 加载 `renderUsagePage()` 的真实输出并执行其内联脚本：

```
API line      : fetch('/dsh-brain/api/usage?days=14', { credentials: 'same-origin' })
  days=14     : true
fetch 实参    : /dsh-brain/api/usage?days=14
cov-n 文案    : "　从没被查到过 178 条（占 81.7%）· 覆盖率 18.3%"
cov-n 空库    : "　从没被查到过 0 条（占 –）· 覆盖率 –"
```

### 3. 既有测试（不写库，仅渲染 + DOM stub）

```powershell
node --test "tests/m4/usage/used-later.test.mjs"
# tests 11 / pass 11 / fail 0，exit=0
```

### 4. 残留检查（grep）

- `usage-page.js` 中 `'…${…'` 形态：仅剩 `fetch('${usageApi}', …)`（服务端注入，已注释说明；
  项目内其余 87 处命中的 `${}` 都在反引号模板串里，非此类）。
- `index.html` 中 `只读检查器` / `M3 ·` / `治理能力（M3）`：**无命中**。

---

## 三、未做 / 交给 Lead 的

1. `apps/brain-tools/index.js` 未动（Lead 独占）。
2. 7420 面板重载后需**刷新页面**才看到新文案；未重启任何服务。
3. 审计 `docs/audit/B-apps.md` 里 B3/B4 的「症状描述」建议同步更正：B3 的「178/218 条 + 覆盖率
   18.3%」属实（已修），但若提到 `${days}` 不插值，那是**误判**——加反引号前它已经能插值。
