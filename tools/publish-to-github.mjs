// @ts-check
/**
 * tools/publish-to-github.mjs —— 把仓库推到 GitHub（**不需要本机装 git**）。
 *
 * ── 为什么不用 git ──
 *
 * 这台机器上没装 git，`winget install Git.Git` 又因为连不上 github.com 的下载地址
 * 失败了（0x80072efd）。但 `api.github.com` 是通的——所以直接用 GitHub 的
 * **Git Data API**：把每个文件传成 blob → 组装 tree → 建 commit → 移动 ref。
 * 效果和 `git push` 一样，只是少一个本地 git。
 *
 * ── 安全设计（这个脚本会触碰主人的账号，所以每一步都可预检） ──
 *
 * 1. **默认 dry-run**：只打印「会创建哪个仓库、会推哪些文件、总共多少字节」，
 *    不碰网络写操作。加 `--apply` 才真推。
 * 2. **默认私有仓库**：`private: true`。要公开必须再加 `--public`（双开关）。
 * 3. **禁止上传 data/**：扫文件时按白名单前缀走，data 目录与任何 *.db 一律不读。
 * 4. token 只从环境变量 `GITHUB_TOKEN` 或 `--token=` 取，**不写进任何文件**。
 *
 * 用法：
 *   $env:GITHUB_TOKEN = 'ghp_xxx'
 *   node tools/publish-to-github.mjs                      # 预演
 *   node tools/publish-to-github.mjs --apply              # 真推（私有）
 *   node tools/publish-to-github.mjs --apply --public     # 真推（公开，慎用）
 *   node tools/publish-to-github.mjs --apply --repo=dsh-brain --desc="..."
 */

import { readFileSync, statSync, globSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const API = 'https://api.github.com'

/**
 * 允许上传的顶层前缀（白名单，不是黑名单）。
 *
 * 用白名单而不是 `.gitignore` 解析，理由是这条脚本可能在任何时候跑，
 * 而「不该上传的东西」一旦漏一个就收不回来。白名单只放代码与文档。
 */
const ALLOW_PREFIXES = ['apps/', 'packages/', 'tests/', 'migrations/', 'docs/', 'tools/']
const ALLOW_ROOT_FILES = ['README.md', 'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', '.gitignore']

/** 哪怕在白名单目录里，这些也不传（双保险）。 */
const DENY_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)data\//,
  /\.db$/i, /\.db-wal$/i, /\.db-shm$/i, /\.sqlite\d*$/i,
  /\.log$/i,
  /(^|\/)\.env(\..*)?$/,
  /\.(pem|key|p12|pfx)$/i,
]

function arg(name, fallback = null) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  if (hit === `--${name}`) return true
  return hit.slice(name.length + 3)
}

/**
 * 收集要上传的文件。只读元信息 + 内容，不改任何东西。
 * @returns {Array<{ rel: string, abs: string, size: number }>}
 */
function collectFiles() {
  const out = []
  const push = (rel) => {
    const normalized = rel.split(path.sep).join('/')
    if (DENY_PATTERNS.some((re) => re.test(normalized))) return
    const abs = path.join(ROOT, normalized)
    let st
    try {
      st = statSync(abs)
    } catch {
      return
    }
    if (!st.isFile()) return
    out.push({ rel: normalized, abs, size: st.size })
  }

  for (const file of ALLOW_ROOT_FILES) push(file)
  for (const prefix of ALLOW_PREFIXES) {
    let hits = []
    try {
      hits = globSync(`${prefix}**/*.*`, { cwd: ROOT })
    } catch {
      continue
    }
    for (const rel of hits) push(String(rel))
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel))
}

/** 5xx / 网络抖动都值得重试；4xx 是我们的错，重试没用。 */
const RETRIABLE_STATUS = new Set([500, 502, 503, 504, 408, 429])
const MAX_ATTEMPTS = 4

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 调 GitHub API。
 *
 * **带重试**：这条链路在国内网络 + 代理下会偶发 502（实测在组装 tree 时撞过），
 * 而 502 是「服务端临时抽风」不是「请求写错了」。所以对 5xx/网络错误做指数退避重试
 * （1s → 2s → 4s），4xx 一次都不重试（重试 401/422 只是把错误延迟三倍）。
 */
async function gh(token, method, urlPath, body, attempt = 1) {
  let res
  try {
    res = await fetch(`${API}${urlPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dsh-brain-publisher',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (netErr) {
    // fetch 自己失败（DNS / 连接重置 / 代理挂掉）——这类也值得重试
    if (attempt < MAX_ATTEMPTS) {
      const wait = 1000 * 2 ** (attempt - 1)
      console.log(`  网络错误（${netErr instanceof Error ? netErr.message : String(netErr)}），${wait}ms 后重试 ${attempt + 1}/${MAX_ATTEMPTS}`)
      await sleep(wait)
      return gh(token, method, urlPath, body, attempt + 1)
    }
    throw netErr
  }

  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* 非 JSON 响应 */ }

  if (!res.ok) {
    if (RETRIABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      const wait = 1000 * 2 ** (attempt - 1)
      console.log(`  ${res.status} 临时错误，${wait}ms 后重试 ${attempt + 1}/${MAX_ATTEMPTS}（${method} ${urlPath}）`)
      await sleep(wait)
      return gh(token, method, urlPath, body, attempt + 1)
    }
    const message = json?.message ?? text?.slice(0, 300) ?? `HTTP ${res.status}`
    // 注意：这里**不能**写成
    //     const err = new Error(...)
    //     /** @type {any} */ (err).status = res.status
    // 因为上一行没有分号、下一行以 `(` 开头，ASI 不会插分号——
    // 会被解析成 `new Error(...)(err).status = ...`，`(err)` 撞上 const 的 TDZ，
    // 报 "Cannot access 'err' before initialization"（实测踩过，别改回去）。
    throw Object.assign(new Error(`${method} ${urlPath} → ${res.status}: ${message}`), {
      status: res.status,
      body: json,
    })
  }
  return json
}

async function main() {
  const apply = process.argv.includes('--apply')
  const isPublic = process.argv.includes('--public')
  const token = String(arg('token') ?? process.env.GITHUB_TOKEN ?? '').trim()
  const repoName = String(arg('repo') ?? 'dsh-brain')
  const description = String(arg('desc') ?? 'DSH 外置大脑（测试中 / Beta）—— 可检索、可整理、可遗忘、可备份、可观察的长期记忆与动态上下文层')

  const files = collectFiles()
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)

  console.log(`仓库名：${repoName}`)
  console.log(`可见性：${isPublic ? '公开 ⚠️' : '私有（默认）'}`)
  console.log(`文件数：${files.length}，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
  const byTop = {}
  for (const f of files) {
    const top = f.rel.includes('/') ? f.rel.split('/')[0] : '(根)'
    byTop[top] = (byTop[top] ?? 0) + 1
  }
  console.log('分布：' + Object.entries(byTop).map(([k, v]) => `${k}=${v}`).join(' '))

  // 硬闸：绝不允许出现 data/ 或数据库文件
  const leaked = files.filter((f) => /(^|\/)data\//.test(f.rel) || /\.(db|db-wal|db-shm|sqlite)$/i.test(f.rel))
  if (leaked.length) {
    console.error('\n❌ 拒绝执行：文件清单里出现了私人数据文件：')
    for (const f of leaked.slice(0, 10)) console.error(`   ${f.rel}`)
    return 2
  }

  if (!apply) {
    console.log('\n（预演）前 15 个文件：')
    for (const f of files.slice(0, 15)) console.log(`   ${f.rel}  ${f.size}B`)
    console.log('\n这是预演，什么都没推。加 --apply 真推；需要 GITHUB_TOKEN。')
    return 0
  }

  if (!token) {
    console.error('\n❌ 缺少 GitHub token。两种给法（二选一）：')
    console.error('   $env:GITHUB_TOKEN = "ghp_xxx"      然后重跑')
    console.error('   node tools/publish-to-github.mjs --apply --token=ghp_xxx')
    console.error('\n   token 权限只需要 repo（经典）或 Contents+Administration（细粒度）。')
    console.error('   这里读不到也不许猜——没有 token 就不动你的账号。')
    return 3
  }

  // ── 1. 我是谁 ──
  const me = await gh(token, 'GET', '/user')
  const owner = me.login
  console.log(`\n已认证：${owner}`)

  // ── 2. 仓库：有就用，没有就建（默认私有） ──
  let repo = null
  try {
    repo = await gh(token, 'GET', `/repos/${owner}/${repoName}`)
    console.log(`仓库已存在：${repo.html_url}（private=${repo.private}）`)
    if (isPublic && repo.private) {
      console.log('注意：仓库现在是私有的，你要公开请自己到设置里改——本脚本不代你改可见性。')
    }
  } catch (err) {
    if (/** @type {any} */ (err).status !== 404) throw err
    repo = await gh(token, 'POST', '/user/repos', {
      name: repoName,
      description,
      private: !isPublic,
      auto_init: false,
      has_issues: true,
      has_wiki: false,
    })
    console.log(`已创建${isPublic ? '公开' : '私有'}仓库：${repo.html_url}`)
  }
  const ownerName = repo.owner.login
  const branch = repo.default_branch || 'main'

  // ── 2.5 空仓库必须先造一个初始 commit ──
  // GitHub 的 Git Data API 在「仓库完全没有 commit」时会拒绝创建 blob：
  //   POST /git/blobs → 409 "Git Repository is empty"
  // （实测踩过：仓库建出来是空的，第一次推就撞这个。）
  // 所以先用 Contents API 放一个占位文件，产生 initial commit，后面才能正常走 tree/commit。
  let parentShas = []
  try {
    const ref = await gh(token, 'GET', `/repos/${ownerName}/${repoName}/git/ref/heads/${branch}`)
    parentShas = [ref.object.sha]
  } catch (refErr) {
    // 空仓库时 GitHub 返回的是 **409 Repository is empty**，不是 404（实测踩过两次）。
    // 两种都当「还没有初始 commit」处理。
    const status = /** @type {any} */ (refErr).status
    if (status !== 404 && status !== 409) throw refErr
    console.log('仓库是空的，先造一个初始 commit…')
    await gh(token, 'PUT', `/repos/${ownerName}/${repoName}/contents/.publish-placeholder`, {
      message: 'chore: 初始化仓库（占位提交，随首次发布被替换）',
      content: Buffer.from('这个文件只用于让 Git Data API 可用；首次发布会把它替换掉。\n').toString('base64'),
    })
    const ref = await gh(token, 'GET', `/repos/${ownerName}/${repoName}/git/ref/heads/${branch}`)
    parentShas = [ref.object.sha]
  }

  // ── 3. 逐文件上传 blob（并发 6，避免触发二级限流） ──
  console.log(`\n上传 ${files.length} 个文件…`)
  const treeEntries = []
  let done = 0
  const queue = [...files]
  async function worker() {
    for (;;) {
      const f = queue.shift()
      if (!f) return
      const content = readFileSync(f.abs).toString('base64')
      const blob = await gh(token, 'POST', `/repos/${ownerName}/${repoName}/git/blobs`, {
        content,
        encoding: 'base64',
      })
      treeEntries.push({ path: f.rel, mode: '100644', type: 'blob', sha: blob.sha })
      done += 1
      if (done % 50 === 0) console.log(`  …${done}/${files.length}`)
    }
  }
  await Promise.all(Array.from({ length: 6 }, () => worker()))

  // ── 4. tree → commit → 移 ref（分支不存在时创建） ──
  const tree = await gh(token, 'POST', `/repos/${ownerName}/${repoName}/git/trees`, {
    tree: treeEntries.sort((a, b) => a.path.localeCompare(b.path)),
  })
  const signature = createHash('sha256').update(JSON.stringify(treeEntries)).digest('hex').slice(0, 12)
  const commit = await gh(token, 'POST', `/repos/${ownerName}/${repoName}/git/commits`, {
    message: `chore: 首次发布 dsh-brain（测试中 / Beta）\n\n文件 ${files.length} 个，${(totalBytes / 1024).toFixed(0)} KB。\n树指纹 ${signature}。\n\n本版含系统 3/4/5/6 最小闭环；数据目录 data/ 未上传。`,
    tree: tree.sha,
    parents: parentShas,
  })

  // ref 一定已存在（上面 2.5 已经保证有初始 commit），直接快进
  await gh(token, 'PATCH', `/repos/${ownerName}/${repoName}/git/refs/heads/${branch}`, { sha: commit.sha, force: false })

  console.log(`\n✅ 完成：${repo.html_url}`)
  console.log(`   分支 ${branch}，commit ${commit.sha.slice(0, 10)}，${files.length} 个文件`)
  return 0
}

main().then(
  (code) => { process.exitCode = code },
  (err) => {
    console.error('\n❌ 发布失败：', err instanceof Error ? err.message : String(err))
    // 打印堆栈：这个脚本会在「推了一半」的时候失败，光有 message 没法定位到行。
    if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(0, 8).join('\n'))
    process.exitCode = 1
  },
)
