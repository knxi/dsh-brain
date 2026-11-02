// @ts-check
/**
 * run.mjs — M0 探针运行器。
 *
 * 在独立 profile `brainlab` 上按场景跑真实的 `dsh headless` 回合，
 * 每场景一个探针输出目录，最后合并成一次 runId 的 timeline.jsonl / verdict.json / timeline.md。
 *
 * 用法：
 *   node apps/probe/run.mjs                # 跑全部场景
 *   node apps/probe/run.mjs single inject  # 只跑指定场景
 *
 * 合成数据纪律：所有 prompt 都是探针自造的一句话，不读写任何真实会话/记忆。
 */
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { analyzeRun } from './analyze.mjs'

const REPO = 'E:/ds-h/dsh-brain'
const PROBE_DATA = join(REPO, 'data', 'probe')
const PROFILE = 'brainlab'
const RUN_ID = `m0-${timestampSlug()}`
const RUN_DIR = join(PROBE_DATA, RUN_ID)

/** @returns {string} 20261028-190100 形式的 slug */
function timestampSlug() {
  const now = new Date()
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('')
}

/**
 * @typedef {Object} Scene
 * @property {string} name
 * @property {string} task 送给 headless 的一句话任务（合成）
 * @property {Record<string, string>} [env] 额外环境变量
 * @property {{killAfterMs: number, mode?: 'hard'|'graceful'}} [interrupt] 到点强杀，用于观测中断边界
 * @property {string} [sessionId] 续写同一会话（Q3 用户续写 + 共存第二轮）
 * @property {string} note 这个场景要证什么
 */

/** @type {Scene[]} */
const SCENES = [
  {
    name: 'single',
    task: 'Reply with exactly: PONG',
    note: '最小单步回合：证明一轮=1 次 assemble + 1 次 pre-step + 1 次 llm/stream。',
  },
  {
    name: 'tool-read',
    task: 'Read the file E:/ds-h/dsh-brain/apps/probe/package.json with the read tool, then answer with only its "name" field value.',
    note: '多步回合：一次工具调用之后的第二个 step 是否重新 assemble/pre-step。',
  },
  {
    name: 'tool-fail',
    task: 'Read the file E:/ds-h/dsh-brain/apps/probe/__definitely_missing__.json with the read tool, then answer in one short line what happened.',
    note: '工具失败边界：错误工具结果如何进入会话日志，step/turn 是否仍然正常收尾。',
  },
  {
    name: 'inject-pre',
    task: 'In one short line, quote any text in your context that contains the word BRAIN-PROBE-MARKER.',
    env: { DSH_PROBE_INJECT_PRESTEP: '1' },
    note: '受控注入实验 B：pre-step 复制数组追加 user message，验证是否持久化、是否重复进入后续 step、能否在请求边界看到。',
  },
  {
    name: 'inject-ctx',
    task: 'In one short line, quote any text in your context that contains the word BRAIN-PROBE-MARKER.',
    env: { DSH_PROBE_INJECT_CONTEXT: '1' },
    note: '受控注入实验 A：注册动态 user-role PromptContext，验证它被物化为 user/message 快照而不是 system section。',
  },
  {
    name: 'interrupt-hard',
    task: 'Write a 600-word essay about the history of counting, then list the numbers 1 to 100 one per line. Do not stop early.',
    interrupt: { killAfterMs: 11000, mode: 'hard' },
    note: '生成中被打断：从进程外强杀，观测宿主是否留下任何终结事件（也验证 Windows 上外部信号能否等价于"取消"）。11s：灵枢挂载后要先起 python 认知图进程（约 7s），留 4s 进到流式生成再杀。',
  },
  {
    name: 'coexist-1',
    task: 'Reply with exactly: COEXIST-1-OK',
    note: '共存实测第一轮：brainlab 已挂灵枢（认知图根重定向到 data/probe/lab/lingshu-mdcg）。观察 assemble 次数是否变化、contexts 里是否出现 lingshu:auto-recall / session-window、宿主是否照常收尾。',
  },
  {
    name: 'coexist-2-resume',
    task: 'Reply with exactly: COEXIST-2-OK. If your context contains any 灵枢 memory block, name it in one word.',
    note: '共存实测第二轮 + 用户续写：用 --session-id 接同一会话。验证（a）续写走的是同一条会话日志；（b）灵枢的 auto-recall / 本会话窗口在第二轮是否开始注入。',
  },
]

/**
 * 跑一个场景。
 * @param {Scene} scene
 * @returns {Promise<{scene: string, exit: number|null, killed: boolean, stdoutTail: string, dir: string, ok: boolean}>}
 */
async function runScene(scene) {
  const dir = join(RUN_DIR, 'scenes', scene.name)
  mkdirSync(dir, { recursive: true })
  /** @type {Record<string, string>} */
  const env = {
    ...process.env,
    DSH_PROBE_RUN_DIR: dir,
    DSH_TELEMETRY_DISABLED: '1',
    // 灵枢的认知图根：env 优先级高于 profile 配置，双保险锁定到仓库内空目录，
    // 绝不读写生产记忆库（~/.dsh/.dsh-memory）。
    MDCG_ROOT: 'E:/ds-h/dsh-brain/data/probe/lab/lingshu-mdcg',
    ...scene.env,
  }

  return new Promise((resolve) => {
    /** @type {string[]} */
    const args = ['--profile', PROFILE, 'headless']
    if (scene.sessionId) args.push('--session-id', scene.sessionId)
    args.push(scene.task)
    const child = spawn('dsh', args, {
      cwd: REPO,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let killed = false
    const onData = (/** @type {Buffer} */ chunk) => {
      out += chunk.toString('utf8')
      if (out.length > 4000) out = out.slice(-4000)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    if (scene.interrupt) {
      setTimeout(() => {
        killed = true
        if (scene.interrupt?.mode === 'hard') {
          spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
        } else {
          // SIGTERM：dsh 的 CLI 退出路径会 dispose root，能观察"优雅取消"的终结事件。
          child.kill('SIGTERM')
        }
      }, scene.interrupt.killAfterMs)
    }
    child.on('close', (code) => {
      resolve({
        scene: scene.name,
        exit: code,
        killed,
        stdoutTail: out.trim().split('\n').slice(-6).join(' | '),
        dir,
        ok: code === 0,
      })
    })
  })
}

/**
 * 合并各场景 timeline，给每条加上 scene 字段。
 * @param {Array<{scene: string, dir: string}>} runs
 */
function mergeTimelines(runs) {
  /** @type {string[]} */
  const merged = []
  for (const run of runs) {
    const file = join(run.dir, 'timeline.jsonl')
    if (!existsSync(file)) continue
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try {
        merged.push(JSON.stringify({ scene: run.scene, ...JSON.parse(line) }))
      } catch {
        /* 坏行直接跳过，不污染主 timeline */
      }
    }
  }
  writeFileSync(join(RUN_DIR, 'timeline.jsonl'), merged.join('\n') + (merged.length > 0 ? '\n' : ''), 'utf8')
  return merged.length
}

const wanted = process.argv.slice(2)
const scenes = wanted.length > 0 ? SCENES.filter((scene) => wanted.includes(scene.name)) : SCENES

mkdirSync(RUN_DIR, { recursive: true })
writeFileSync(
  join(RUN_DIR, 'run.json'),
  JSON.stringify(
    {
      runId: RUN_ID,
      createdAt: new Date().toISOString(),
      profile: PROFILE,
      sceneNames: scenes.map((scene) => scene.name),
      note: '全部 prompt 均为探针合成的固定字符串；会话写入 data/probe/lab/sessions（brainlab 专属）。',
    },
    null,
    2,
  ),
  'utf8',
)

console.log(`[run] runId=${RUN_ID}`)
console.log(`[run] scenes=${scenes.map((scene) => scene.name).join(', ')}`)

/** @type {Array<{scene: string, exit: number|null, killed: boolean, stdoutTail: string, dir: string, ok: boolean}>} */
const results = []
/** 上一轮 coexist-1 的会话 id，供 coexist-2-resume 续写 */
let lastSessionId = /** @type {string|undefined} */ (undefined)

/**
 * 从一个场景的 timeline 里提取本会话 id。
 * @param {string} dir
 * @returns {string|undefined}
 */
function extractSessionId(dir) {
  const file = join(dir, 'timeline.jsonl')
  if (!existsSync(file)) return undefined
  const text = readFileSync(file, 'utf8')
  const match = text.match(/"session":"(session-[0-9a-f-]+)"/)
  return match?.[1]
}

for (const scene of scenes) {
  const resolved = { ...scene }
  if (scene.name === 'coexist-2-resume') {
    if (lastSessionId === undefined) {
      console.log('[run]   skipped: 没有上一轮会话 id，无法续写')
      continue
    }
    resolved.sessionId = lastSessionId
  }
  console.log(`[run] → ${resolved.name}: ${resolved.note}${resolved.sessionId ? ` (session-id=${resolved.sessionId})` : ''}`)
  const result = await runScene(resolved)
  results.push(result)
  if (scene.name === 'coexist-1') lastSessionId = extractSessionId(result.dir)
  const lineCount = existsSync(join(result.dir, 'timeline.jsonl'))
    ? readFileSync(join(result.dir, 'timeline.jsonl'), 'utf8').split('\n').filter((line) => line.trim().length > 0).length
    : 0
  console.log(
    `[run]   exit=${result.exit} killed=${result.killed} timelineLines=${lineCount}${result.ok ? '' : ` tail=${result.stdoutTail}`}`,
  )
}

const total = mergeTimelines(results)
console.log(`[run] merged timeline lines: ${total}`)

writeFileSync(join(RUN_DIR, 'scenes.json'), JSON.stringify(results, null, 2), 'utf8')

const verdict = analyzeRun(RUN_DIR)
console.log(`[run] verdict: ${verdict.summary.answered} answered / ${verdict.summary.partial} partial / ${verdict.summary.unknown} unknown`)
console.log(`[run] 产出：${RUN_DIR}`)
