// @ts-check
/**
 * brain-home.test.mjs —— 路径推导的边界回归（2026-11-02）。
 *
 * 为什么单独有这个：`brain-home.js` 是「换机能不能装起来」的总开关，
 * 但它出错时**不报错**——库静默落到别处、旧记忆全部查不到，看起来像「什么都没发生」。
 * 这两种情况都是实测踩到的，写成测试锁住：
 *   1. `DSH_BRAIN_HOME` 指到 data/ 这类子目录（只判 existsSync 时会被照收，库落到 data\data\）
 *   2. `SESSION_SIGNAL_INDEX_URL` 与 `BRAIN_HOME` 两套口径（兜底时指向不存在的文件）
 *
 * 注意：环境变量在每个用例里改了之后，必须用不同的 `?v=` 重新 import——
 * ESM 模块是单例，不清缓存的话读到的还是第一次的环境。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
/** dsh-brain 仓库根（tests/apps/ → 上两级） */
const REPO = resolve(HERE, '..', '..')
const MODULE = join(REPO, 'apps', 'brain-tools', 'brain-home.js')

/** 用独立 query 重新加载模块（绕开 ESM 单例缓存，好让每次读到当前 env） */
let seq = 0
async function freshLoad() {
  seq += 1
  return import(pathToFileURL(MODULE).href + '?case=' + seq)
}

test('正常布局：从插件位置向上找到仓库根', async () => {
  delete process.env.DSH_BRAIN_HOME
  const m = await freshLoad()
  assert.equal(m.BRAIN_HOME, REPO)
  assert.equal(m.BRAIN_HOME_SOURCE, 'walk-up:package.json')
  assert.equal(m.DEFAULT_STORE_PATH, join(REPO, 'data', 'brain.db'))
  assert.equal(m.BRAIN_MIGRATIONS, join(REPO, 'migrations'))
})

test('DSH_BRAIN_HOME 指到仓库根：采信它', async () => {
  process.env.DSH_BRAIN_HOME = REPO
  const m = await freshLoad()
  assert.equal(m.BRAIN_HOME, REPO)
  assert.equal(m.BRAIN_HOME_SOURCE, 'env:DSH_BRAIN_HOME')
  delete process.env.DSH_BRAIN_HOME
})

test('DSH_BRAIN_HOME 指到 data 子目录：必须忽略并回退，不能把库建到 data/data', async () => {
  process.env.DSH_BRAIN_HOME = join(REPO, 'data')
  const m = await freshLoad()
  // 关键：回退到正常推导，而不是采信那个子目录
  assert.equal(m.BRAIN_HOME, REPO)
  assert.equal(m.BRAIN_HOME_SOURCE, 'walk-up:package.json')
  assert.equal(m.DEFAULT_STORE_PATH, join(REPO, 'data', 'brain.db'))
  assert.ok(!m.DEFAULT_STORE_PATH.includes(join('data', 'data')), '库路径不该出现 data/data')
  delete process.env.DSH_BRAIN_HOME
})

test('DSH_BRAIN_HOME 指向不存在的目录：忽略并回退', async () => {
  process.env.DSH_BRAIN_HOME = join(REPO, '__definitely_not_here__')
  const m = await freshLoad()
  assert.equal(m.BRAIN_HOME, REPO)
  assert.equal(m.BRAIN_HOME_SOURCE, 'walk-up:package.json')
  delete process.env.DSH_BRAIN_HOME
})

test('DSH_BRAIN_HOME 是相对路径：必须规范化成绝对路径（否则库随 cwd 漂移）', async () => {
  // `DSH_BRAIN_HOME=.` / `./dsh-brain` 是换机脚本里最自然的写法。
  // 之前直接存相对串，导致 BRAIN_HOME / storePath 全依赖宿主进程 cwd——
  // 换个 cwd 起动就是另一个空库，而 SOURCE 还显示 env:...（2026-11-02 实测）。
  process.env.DSH_BRAIN_HOME = '.'
  const m = await freshLoad()
  assert.ok(isAbsolute(m.BRAIN_HOME), `BRAIN_HOME 必须绝对：${m.BRAIN_HOME}`)
  assert.ok(isAbsolute(m.DEFAULT_STORE_PATH), `storePath 必须绝对：${m.DEFAULT_STORE_PATH}`)
  assert.ok(!m.BRAIN_HOME.includes('.' + sep + '.') , '不该留下 . 段')
  delete process.env.DSH_BRAIN_HOME
})

test('一切推导结果都是绝对路径（含 fallback）', async () => {
  delete process.env.DSH_BRAIN_HOME
  const m = await freshLoad()
  assert.ok(isAbsolute(m.BRAIN_HOME))
  // 即使走 fallback（~/.dsh-brain），也必须是绝对路径
  assert.ok(isAbsolute(resolve(m.BRAIN_HOME)), 'fallback 也应是绝对路径')
})

test('会话信号索引 URL 与 BRAIN_HOME 同口径，且指向真实文件', async () => {
  delete process.env.DSH_BRAIN_HOME
  const m = await freshLoad()
  assert.ok(m.SESSION_SIGNAL_INDEX_URL, 'URL 不该是 null（正常布局下模块一定在）')
  assert.ok(m.SESSION_SIGNAL_INDEX_URL.startsWith('file://'), '必须是 file URL，不能是裸 Windows 路径')
  const abs = fileURLToPath(m.SESSION_SIGNAL_INDEX_URL)
  assert.ok(existsSync(abs), `指向的文件应存在：${abs}`)
  // 口径一致性：它必须在 BRAIN_HOME 底下，而不是从 import.meta.url 另算一套
  assert.ok(abs.startsWith(m.BRAIN_HOME), `${abs} 应在 ${m.BRAIN_HOME} 之下`)
})

test('各默认落点都在 BRAIN_HOME 之下（不逃出仓库）', async () => {
  delete process.env.DSH_BRAIN_HOME
  const m = await freshLoad()
  for (const key of [
    'DEFAULT_STORE_PATH',
    'DEFAULT_USAGE_LOG_PATH',
    'DEFAULT_SOCIAL_OUTBOX_PATH',
    'DEFAULT_AUTO_EXTRACT_LOG_PATH',
    'DEFAULT_CONFLICT_LOG_PATH',
    'DEFAULT_USED_LATER_LOG_PATH',
    'DEFAULT_CHANNEL_CONFIG_PATH',
    'DEFAULT_SOCIAL_AUTO_PATH',
    'DEFAULT_SESSION_SIGNAL_PATH',
  ]) {
    const v = m[key]
    assert.equal(typeof v, 'string', `${key} 应是字符串`)
    assert.ok(v.startsWith(m.BRAIN_HOME), `${key}=${v} 跑出 BRAIN_HOME=${m.BRAIN_HOME}`)
  }
})
