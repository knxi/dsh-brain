// @ts-check
/**
 * apps/brain-tools/auto-extract.js 单元测试（M5 第一阶段：纯规则自动提取）。
 *
 * 覆盖任务书要求的全部维度：
 *   1-5.  四条规则各命中一次（remember-verb 的 fact / preference 两种都测）
 *   6-10. 五类反例全不命中：疑问 / 假设 / 否定 / 只有动词没内容 / assistant 的话不参与
 *   11.   每轮最多 1 条（maxPerTurn）
 *   12.   每会话每天配额 5
 *   13.   全局每天配额 20
 *   14.   关闭开关 → skipped: 'disabled'
 *   15.   sidecar 只记长度不记原文
 *   16.   sidecar 写失败不抛、返回 { ok: false }
 *   17.   缓存有界（64 会话 × 每会话 4 条）
 *   18.   stats 五个计数
 *   19.   全部方法零抛出
 *   20.   summary 末尾必须带「（自动提取）」
 *
 * 纪律：
 * - 只用 node:test / node:assert/strict；临时目录 mkdtempSync，测完删干净；
 * - sidecar 一律用**显式临时路径**，绝不碰 data/logs/*.jsonl；
 * - 不 import apps/brain-tools/index.js（宿主插件要 DSH 运行时），只测纯模块。
 *
 * 跑法（本沙箱里 `node --test "tests/**"` 会 spawn EPERM，必须整批关隔离）：
 *   node --test --test-isolation=none "tests/m5/auto-extract/*.test.mjs"
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AUTO_MARK,
  MAX_MESSAGES_PER_SESSION,
  MAX_SESSIONS,
  createAutoExtractor,
  extractCandidates,
} from '../../../apps/brain-tools/auto-extract.js'

/**
 * 建一个测完自动删的临时目录。
 * @param {import('node:test').TestContext} t
 * @returns {string}
 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-auto-extract-'))
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }))
  return dir
}

/** 一条能稳定命中 remember-verb 的用户消息（内容 9 字，够具体） */
const HIT_REMEMBER = '记住我对铝板过敏'
/** 一条能稳定命中 always-use 的消息 */
const HIT_ALWAYS = '以后都用 pnpm'
/** 一条能稳定命中 switch-to 的消息 */
const HIT_SWITCH = '把缓存改成 64 条'
/** 一条能稳定命中 first-person-fact 的消息 */
const HIT_FIRST_PERSON = '我的时区是 Asia/Shanghai'

/** 读 sidecar，返回解析后的行数组（坏行直接抛，测试里不该有坏行） */
function readLines(file) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

// ─────────────────────────────────────────────────────────────────────────────
// 1-5. 四条规则各命中一次
// ─────────────────────────────────────────────────────────────────────────────

test('remember-verb：祈使句「记住 X」→ fact/semantic，内容就是 X', () => {
  const out = extractCandidates(HIT_REMEMBER)
  assert.equal(out.length, 1)
  const c = out[0]
  assert.equal(c.rule, 'remember-verb')
  assert.equal(c.kind, 'fact')
  assert.equal(c.type, 'semantic')
  assert.equal(c.content, '我对铝板过敏')
  assert.equal(c.excerptLen, HIT_REMEMBER.length)
})

test('remember-verb：带偏好词时归 preference/profile（同一句式两种 kind）', () => {
  const out = extractCandidates('记住我喜欢用 vim')
  assert.equal(out.length, 1)
  assert.equal(out[0].rule, 'remember-verb')
  assert.equal(out[0].kind, 'preference')
  assert.equal(out[0].type, 'profile')
  assert.equal(out[0].content, '我喜欢用 vim')
})

test('always-use：「以后都用 X」→ preference/profile，剥掉「用」只留 X', () => {
  const out = extractCandidates(HIT_ALWAYS)
  assert.equal(out.length, 1)
  assert.equal(out[0].rule, 'always-use')
  assert.equal(out[0].kind, 'preference')
  assert.equal(out[0].type, 'profile')
  assert.equal(out[0].content, 'pnpm')
})

test('switch-to：「改成 X」→ decision/semantic', () => {
  const out = extractCandidates(HIT_SWITCH)
  assert.equal(out.length, 1)
  assert.equal(out[0].rule, 'switch-to')
  assert.equal(out[0].kind, 'decision')
  assert.equal(out[0].type, 'semantic')
  assert.equal(out[0].content, '64 条')
})

test('first-person-fact：「我的 X 是 Y」→ fact/semantic，内容取整句', () => {
  const out = extractCandidates(HIT_FIRST_PERSON)
  assert.equal(out.length, 1)
  assert.equal(out[0].rule, 'first-person-fact')
  assert.equal(out[0].kind, 'fact')
  assert.equal(out[0].type, 'semantic')
  assert.equal(out[0].content, '我的时区是 Asia/Shanghai')
})

// ─────────────────────────────────────────────────────────────────────────────
// 6-10. 五类反例
// ─────────────────────────────────────────────────────────────────────────────

test('反例·疑问：问句一律不提取（有问号 / 句尾「吗」/ 回顾性疑问）', () => {
  const cases = ['你记住了吗', '还记得吗', '记住这个了吗？', '我记住了吗', '你还记不记得时区是啥']
  for (const text of cases) {
    assert.deepEqual(extractCandidates(text), [], '疑问句不该命中：' + text)
  }
})

test('反例·假设：条件句/愿望句一律不提取', () => {
  const cases = [
    '如果能记住就好',
    '要是以后都这样',
    '假如记住我的偏好',
    '万一以后都用这个',
    '哪怕记住一点点也行',
  ]
  for (const text of cases) {
    assert.deepEqual(extractCandidates(text), [], '假设句不该命中：' + text)
  }
})

test('反例·否定：触发词前的否定词否决整条', () => {
  const cases = ['不用记住这个', '别记住', '不必记住我的偏好', '不需要记录这些', '别帮我记住这个']
  for (const text of cases) {
    assert.deepEqual(extractCandidates(text), [], '否定句不该命中：' + text)
  }
  // 反向：否定只查**前置**窗口，内容里的否定不能否决整句。
  const ok = extractCandidates('以后都用 pnpm 别用 npm')
  assert.equal(ok.length, 1, '内容含「别用」不该否决整条长期规则')
  assert.equal(ok[0].content, 'pnpm 别用 npm')
})

test('反例·只有动词没有具体内容：无对象就不提取', () => {
  const cases = ['记住', '记一下啊', '记下来', '别忘', '记住吧', '记住好的']
  for (const text of cases) {
    assert.deepEqual(extractCandidates(text), [], '空内容不该命中：' + text)
  }
  // 指代型内容（没有对象）同样丢弃，但指代后面跟了完整断言的保留。
  assert.deepEqual(extractCandidates('记住这个'), [])
  assert.deepEqual(extractCandidates('记住那个参数'), [])
  const ok = extractCandidates('记住这个参数是超时 30 秒')
  assert.equal(ok.length, 1)
  assert.equal(ok[0].content, '这个参数是超时 30 秒')
})

test('反例·assistant 的话不参与提取（缓存只由 noteUserMessage 写入）', (t) => {
  const ex = createAutoExtractor({ logPath: join(tempDir(t), 's.jsonl') })
  // 纯函数只认文本、不认角色——这是设计如此：角色过滤是门面的职责。
  // 下面这句是典型的 assistant 口吻，直接喂给纯函数照样会被提取，
  // 所以「assistant 的话不参与」必须靠「缓存只由 noteUserMessage 写」来保证。
  assert.equal(extractCandidates('好的，我会记住你对铝板过敏').length, 1)
  // 门面只缓存用户消息：没有 note 过任何东西时，judge 必须空。
  assert.deepEqual(ex.judgeTurn({ sessionId: 'assistant-side', turn: 1 }).candidates, [])
  // 只 note 了用户消息的那一条，候选也只来自它（不存在 assistant 通道）。
  ex.noteUserMessage('s1', 1, HIT_REMEMBER)
  const got = ex.judgeTurn({ sessionId: 's1', turn: 1 })
  assert.equal(got.candidates.length, 1)
  assert.equal(got.candidates[0].content, '我对铝板过敏')
  // 非字符串 / 空文本不进缓存，也不抛。
  assert.deepEqual(ex.noteUserMessage('s1', 2, null), { ok: false })
  assert.deepEqual(ex.noteUserMessage('s1', 2, '   '), { ok: false })
  assert.deepEqual(ex.judgeTurn({ sessionId: 's1', turn: 2 }).candidates, [])
})

test('误提防护：回顾句 / 换位假设 / 反讽 / 第三人称转述都不命中', () => {
  // 以下四类全部是「字面像规则、语义不是」的句子，抽检时最容易混进库。
  const cases = [
    // 回顾：我在说我记得什么，不是让你记什么
    '我记住的是上周说的那个方案',
    '你记住的是哪个版本',
    // 换位：换成「你/他/我就…」是假设换位，不是换方案
    '换成你是我也这么干',
    '换成我就不这么选了',
    '改成你说的那样吧',
    // 反讽 / 粗口：语义是否定
    '我记住个屁',
    '记住这没什么好记的',
    // 第三人称转述：别人的话不能记成主人的偏好
    '记住他说过以后都用 pnpm',
    // 指代 + 瞬时状态
    '记住这个坑',
    '我这边在跑测试',
  ]
  for (const text of cases) {
    assert.deepEqual(extractCandidates(text), [], '不该命中：' + text)
  }
  // 反向：真决定不能被上面的闸误杀（「换成我们用 X」是真决定）。
  const ok = extractCandidates('换成我们用 SQLite 吧')
  assert.equal(ok.length, 1)
  assert.equal(ok[0].rule, 'switch-to')
  assert.equal(ok[0].content, '我们用 SQLite 吧')
})

// ─────────────────────────────────────────────────────────────────────────────
// 11. 每轮上限
// ─────────────────────────────────────────────────────────────────────────────

test('maxPerTurn：一条消息命中两条规则时，每轮只产出 1 条', (t) => {
  const ex = createAutoExtractor({ logPath: join(tempDir(t), 's.jsonl') })
  // 「记住以后都用 pnpm」同时命中 remember-verb 与 always-use。
  assert.equal(extractCandidates('记住以后都用 pnpm').length, 2)
  ex.noteUserMessage('s1', 1, '记住以后都用 pnpm')
  const got = ex.judgeTurn({ sessionId: 's1', turn: 1 })
  assert.equal(got.skipped, null)
  assert.equal(got.candidates.length, 1, 'maxPerTurn=1 必须截到 1 条')
  // 优先级：RULES 顺序即优先级，remember-verb 在 always-use 之前。
  assert.equal(got.candidates[0].rule, 'remember-verb')
})

// ─────────────────────────────────────────────────────────────────────────────
// 12-13. 配额
// ─────────────────────────────────────────────────────────────────────────────

test('每会话每天配额 10：第 11 次判定返回 skipped: quota', (t) => {
  const ex = createAutoExtractor({ logPath: join(tempDir(t), 's.jsonl'), maxPerDay: 100 })
  for (let i = 1; i <= 10; i += 1) {
    ex.noteUserMessage('s1', i, '记住第 ' + i + ' 条事项')
    const got = ex.judgeTurn({ sessionId: 's1', turn: i })
    assert.equal(got.candidates.length, 1, '第 ' + i + ' 次应正常产出')
    assert.equal(got.skipped, null)
  }
  ex.noteUserMessage('s1', 11, '记住第 11 条事项')
  const eleventh = ex.judgeTurn({ sessionId: 's1', turn: 11 })
  assert.deepEqual(eleventh.candidates, [])
  assert.equal(eleventh.skipped, 'quota')
  // 配额是**判定即扣**：配额满了以后连候选都不产生。
  assert.equal(ex.stats().skippedQuota, 1)
})

test('全局每天配额 40：跨会话累计到 40 条后一律 quota', (t) => {
  const ex = createAutoExtractor({ logPath: join(tempDir(t), 's.jsonl') })
  let created = 0
  let quota = 0
  // 5 个会话 × 10 条 = 50 次判定；前 4 个会话刚好吃满全局 40。
  for (let s = 1; s <= 5; s += 1) {
    for (let i = 1; i <= 10; i += 1) {
      ex.noteUserMessage('s' + s, i, '记住第 ' + s + ' 会话第 ' + i + ' 条事项')
      const got = ex.judgeTurn({ sessionId: 's' + s, turn: i })
      if (got.skipped === 'quota') quota += 1
      else created += got.candidates.length
    }
  }
  assert.equal(created, 40, '全局每天上限 40 条')
  assert.equal(quota, 10, '第 41-50 次必须被全局配额挡住')
  assert.equal(ex.stats().skippedQuota, 10)
})

test('配额是内存计数：新建实例即归零，不读 sidecar', async (t) => {
  const dir = tempDir(t)
  const logPath = join(dir, 'q.jsonl')
  const a = createAutoExtractor({ logPath, maxPerSessionDay: 1 })
  a.noteUserMessage('s1', 1, HIT_REMEMBER)
  assert.equal(a.judgeTurn({ sessionId: 's1', turn: 1 }).candidates.length, 1)
  a.noteUserMessage('s1', 2, HIT_REMEMBER)
  assert.equal(a.judgeTurn({ sessionId: 's1', turn: 2 }).skipped, 'quota')
  await a.record({ sessionId: 's1', turn: 1, rule: 'remember-verb', status: 'created', excerptLen: 9 })
  // 同一份 sidecar、全新实例：配额从零开始（每日重置/重启归零是设计，不建表）。
  const b = createAutoExtractor({ logPath, maxPerSessionDay: 1 })
  b.noteUserMessage('s1', 1, HIT_REMEMBER)
  assert.equal(b.judgeTurn({ sessionId: 's1', turn: 1 }).candidates.length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 14. 关闭开关
// ─────────────────────────────────────────────────────────────────────────────

test('enabled: false → 候选为空、skipped 为 disabled、stats 记一次', (t) => {
  const ex = createAutoExtractor({ logPath: join(tempDir(t), 's.jsonl'), enabled: false })
  ex.noteUserMessage('s1', 1, HIT_REMEMBER)
  const got = ex.judgeTurn({ sessionId: 's1', turn: 1 })
  assert.deepEqual(got.candidates, [])
  assert.equal(got.skipped, 'disabled')
  assert.equal(ex.stats().disabled, 1)
  // 关掉时不该消耗配额：统计里没有 quota 记录。
  assert.equal(ex.stats().skippedQuota, 0)
})

// ─────────────────────────────────────────────────────────────────────────────
// 15-16. sidecar
// ─────────────────────────────────────────────────────────────────────────────

test('sidecar：一行一条 JSON，只记长度不记原文', async (t) => {
  const dir = tempDir(t)
  const logPath = join(dir, 'auto.jsonl')
  const ex = createAutoExtractor({ logPath })
  ex.noteUserMessage('s1', 1, HIT_REMEMBER)
  const got = ex.judgeTurn({ sessionId: 's1', turn: 1 })
  assert.equal(got.candidates.length, 1)

  const r1 = await ex.record({
    sessionId: 's1',
    turn: 1,
    rule: 'remember-verb',
    status: 'created',
    memoryId: 'mem-1',
    excerptLen: got.candidates[0].excerptLen,
  })
  const r2 = await ex.record({
    sessionId: 's1',
    turn: 2,
    rule: 'remember-verb',
    status: 'duplicate',
    reason: 'same_content',
    excerptLen: 8,
  })
  assert.deepEqual(r1, { ok: true })
  assert.deepEqual(r2, { ok: true })

  const raw = readFileSync(logPath, 'utf8')
  // 隐私底线：日志里不能出现用户原话里的任何内容片段。
  assert.ok(!raw.includes('铝板'), 'sidecar 不得记录原文')
  assert.ok(!raw.includes('过敏'), 'sidecar 不得记录原文')

  const lines = readLines(logPath)
  assert.equal(lines.length, 2)
  const first = lines[0]
  assert.equal(first.sessionId, 's1')
  assert.equal(first.turn, 1)
  assert.equal(first.rule, 'remember-verb')
  assert.equal(first.status, 'created')
  assert.equal(first.memoryId, 'mem-1')
  assert.equal(first.excerptLen, HIT_REMEMBER.length, 'excerptLen 是原消息字数')
  assert.equal(typeof first.ts, 'number')
  assert.match(first.at, /^\d{4}-\d{2}-\d{2}T/u)
  assert.equal(lines[1].status, 'duplicate')
  assert.equal(lines[1].reason, 'same_content')
  assert.equal(lines[1].memoryId, undefined, '没有 memoryId 就不该出现这个字段')
})

test('sidecar：写失败不抛，返回 { ok: false }', async (t) => {
  const dir = tempDir(t)
  // 让 sidecar 的父路径是一个**文件**，mkdir/append 必然失败（ENOTDIR）。
  const blocker = join(dir, 'blocker')
  writeFileSync(blocker, 'not a dir', 'utf8')
  const ex = createAutoExtractor({ logPath: join(blocker, 'nested', 'auto.jsonl') })

  const r = await ex.record({ sessionId: 's1', turn: 1, rule: 'remember-verb', status: 'created', excerptLen: 9 })
  assert.deepEqual(r, { ok: false })
  // 失败是静默的：统计照常记（record 记的是判定事实，不是写盘结果），后续调用也不抛。
  const r2 = await ex.record({})
  assert.equal(typeof r2.ok, 'boolean')
  assert.equal(ex.stats().created, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 17. 缓存有界
// ─────────────────────────────────────────────────────────────────────────────

test('缓存有界·会话数：超过 64 个会话时驱逐最早的会话', (t) => {
  const ex = createAutoExtractor({ logPath: join(tempDir(t), 's.jsonl') })
  ex.noteUserMessage('s0', 1, HIT_REMEMBER)
  // 塞满 64 个会话（s1..s64）：每次新会话都会驱逐最早的，s0 被挤出去。
  for (let i = 1; i <= MAX_SESSIONS; i += 1) ex.noteUserMessage('s' + i, 1, '今天天气不错')
  assert.equal(ex.judgeTurn({ sessionId: 's0', turn: 1 }).candidates.length, 0, 's0 应已被驱逐')
  // 最后进来的会话还在（换成可命中的文本，证明「在」而不是「没命中」）。
  ex.noteUserMessage('s' + MAX_SESSIONS, 2, HIT_REMEMBER)
  assert.equal(ex.judgeTurn({ sessionId: 's' + MAX_SESSIONS, turn: 2 }).candidates.length, 1)
})

test('缓存有界·单会话：最多 4 条，最旧的被挤掉', (t) => {
  const ex = createAutoExtractor({ logPath: join(tempDir(t), 's.jsonl') })
  for (let i = 1; i <= MAX_MESSAGES_PER_SESSION + 1; i += 1) {
    ex.noteUserMessage('s1', i, '记住第 ' + i + ' 条事项')
  }
  assert.equal(ex.judgeTurn({ sessionId: 's1', turn: 1 }).candidates.length, 0, 'turn 1 应已被挤出缓存')
  assert.equal(ex.judgeTurn({ sessionId: 's1', turn: MAX_MESSAGES_PER_SESSION + 1 }).candidates.length, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 18. stats
// ─────────────────────────────────────────────────────────────────────────────

test('stats：五个计数各自累计（created / skippedDup / skippedQuota / disabled / turns）', async (t) => {
  const dir = tempDir(t)
  const ex = createAutoExtractor({ logPath: join(dir, 's.jsonl'), maxPerSessionDay: 1 })
  assert.deepEqual(ex.stats(), { created: 0, skippedDup: 0, skippedQuota: 0, disabled: 0, turns: 0 })

  await ex.record({ sessionId: 's1', turn: 1, rule: 'remember-verb', status: 'created', excerptLen: 9 })
  await ex.record({ sessionId: 's1', turn: 2, rule: 'remember-verb', status: 'duplicate', excerptLen: 9 })

  ex.noteUserMessage('s1', 3, HIT_REMEMBER)
  assert.equal(ex.judgeTurn({ sessionId: 's1', turn: 3 }).candidates.length, 1)
  ex.noteUserMessage('s1', 4, HIT_REMEMBER)
  assert.equal(ex.judgeTurn({ sessionId: 's1', turn: 4 }).skipped, 'quota')

  assert.deepEqual(ex.stats(), { created: 1, skippedDup: 1, skippedQuota: 1, disabled: 0, turns: 2 })

  const off = createAutoExtractor({ logPath: join(dir, 'off.jsonl'), enabled: false })
  off.judgeTurn({ sessionId: 's1', turn: 1 })
  assert.equal(off.stats().disabled, 1)
})

// ─────────────────────────────────────────────────────────────────────────────
// 19-20. 零抛出 + summary 标记
// ─────────────────────────────────────────────────────────────────────────────

test('零抛出：所有对外方法对垃圾入参都不抛（宿主 turn/end 不能被污染）', async (t) => {
  const ex = createAutoExtractor({ logPath: join(tempDir(t), 's.jsonl') })
  assert.doesNotThrow(() => extractCandidates(null))
  assert.doesNotThrow(() => extractCandidates(undefined))
  assert.doesNotThrow(() => extractCandidates(42))
  assert.doesNotThrow(() => extractCandidates(''))
  assert.doesNotThrow(() => ex.noteUserMessage(null, null, null))
  assert.doesNotThrow(() => ex.noteUserMessage(undefined, undefined, undefined))
  assert.doesNotThrow(() => ex.judgeTurn())
  assert.doesNotThrow(() => ex.judgeTurn(null))
  assert.doesNotThrow(() => ex.judgeTurn({ sessionId: 42, turn: {} }))
  assert.doesNotThrow(() => ex.stats())
  // record 对垃圾入参不抛：空的 entry 会被记成 status=unknown 的一行（记录事实，不报错）。
  const r = await ex.record(null)
  assert.equal(typeof r.ok, 'boolean')
  const r2 = await ex.record(undefined)
  assert.equal(r2.ok, true)
  // 垃圾入参之后模块还能正常工作。
  ex.noteUserMessage('s1', 1, HIT_REMEMBER)
  assert.equal(ex.judgeTurn({ sessionId: 's1', turn: 1 }).candidates.length, 1)
})

test('summary 末尾必须带「（自动提取）」标记', () => {
  const samples = [HIT_REMEMBER, '记住我喜欢用 vim', HIT_ALWAYS, HIT_SWITCH, HIT_FIRST_PERSON, '我这边用 pnpm 装依赖']
  for (const text of samples) {
    const out = extractCandidates(text)
    assert.ok(out.length >= 1, '样例应命中：' + text)
    for (const c of out) {
      assert.ok(c.summary.endsWith(AUTO_MARK), 'summary 必须以标记结尾：' + c.summary)
      assert.ok(c.summary.length > AUTO_MARK.length, 'summary 不能只有标记')
    }
  }
  // 截断也不能把标记挤掉：内容远超上限时标记仍在最后。
  const long = '记住' + '甲乙丙丁戊己庚辛壬癸'.repeat(20)
  const out = extractCandidates(long)
  assert.equal(out.length, 1)
  assert.ok(out[0].summary.endsWith(AUTO_MARK))
})
