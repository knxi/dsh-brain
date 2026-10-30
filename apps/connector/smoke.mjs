// @ts-check
/**
 * smoke.mjs — 把连接器以 **shadow** 模式挂进 brainlab profile，跑真实回合做冒烟。
 *
 * 验四件事：
 *   1. 五个钩子在真实装配点上都被触发（次数与 step 的关系对得上 M0 实测）；
 *   2. 运行期零抛出（队列里 hook_error 必须为 0，回合不能被 reason=error 终结）；
 *   3. 零注入（shadow 只算不注入：assembly.contexts 数量不得被改动）；
 *   4. 同一 step 的 assemble 与 pre-step 必须解析出**同一个幂等键**（真机验证
 *      `phase.step` 是「上一个 step」这一推导）。
 *
 * 纪律：
 *   - 只挂 brainlab，全程不读写 `~/.dsh/profiles/web`；
 *   - patch 文件按**原文**备份，跑完 byte 级写回；
 *   - 会话/存储仍走 brainlab 已重定向的 `data/probe/lab/`；
 *   - 产物落 `data/probe/<runId>/`。
 *
 * 用法：
 *   node apps/connector/smoke.mjs            # 两个场景（单步 / 两步工具回合）
 *   node apps/connector/smoke.mjs single     # 只跑指定场景
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const REPO = 'E:/ds-h/dsh-brain'
const PROFILE_DIR = process.env.DSH_PROFILE_BRAINLAB ?? 'C:/Users/su/.dsh/profiles/brainlab'
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')
const LINK_PARENT = join(PROFILE_DIR, 'node_modules', '@dsh-brain')
const LINK_PATH = join(LINK_PARENT, 'connector')
const CONNECTOR_DIR = join(REPO, 'apps', 'connector')

const RUN_ID = `m2-connector-${timestampSlug()}`
const RUN_DIR = join(REPO, 'data', 'probe', RUN_ID)
const EVENTS_DIR = join(RUN_DIR, 'events')

/** patch 里追加的块（只在冒烟期间存在） */
const PATCH_BLOCK = `
# ⚠️ M2 connector 冒烟块（由 apps/connector/smoke.mjs 临时写入，跑完自动删除）
- insert:
    - id: brain-connector
      name: '@dsh-brain/connector'
      config:
        mode: shadow
        dir: !!js "process.env.DSH_BRAIN_CONNECTOR_DIR ?? 'E:/ds-h/dsh-brain/data/events'"
`

/** @type {Array<{name: string, task: string, note: string, sessionId?: string}>} */
const SCENES = [
  {
    name: 'single',
    task: 'Reply with exactly: M2-CONNECTOR-OK',
    note: '单步回合：证明 1 turn / 1 step → 1 assemble + 1 pre-step + 1 主请求 + 1 标题旁路。',
  },
  {
    name: 'tool-read',
    task: 'Read the file E:/ds-h/dsh-brain/apps/connector/package.json with the read tool, then answer with only its "name" field value.',
    note: '两步回合：证明第 2 个 step 会重新 assemble / pre-step，且幂等键是新的。',
  },
]

/** @returns {string} */
function timestampSlug() {
  const now = new Date()
  const pad = (/** @type {number} */ value) => String(value).padStart(2, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** @param {string} message */
function log(message) {
  console.log(`[smoke] ${message}`)
}

// ── 0. 前置检查 ────────────────────────────────────────────────────────────
mkdirSync(RUN_DIR, { recursive: true })
mkdirSync(EVENTS_DIR, { recursive: true })

const module = await import(new URL('./index.js', import.meta.url).href)
if (module.name !== 'brain-connector' || typeof module.apply !== 'function') {
  console.error('[smoke] 连接器模块形状不对，中止')
  process.exit(2)
}
log(`连接器模块 OK：name=${module.name} inject=${JSON.stringify(module.inject)}`)

if (!existsSync(PATCH_PATH)) {
  console.error(`[smoke] brainlab patch 不存在：${PATCH_PATH}`)
  process.exit(2)
}

const patchOriginal = readFileSync(PATCH_PATH, 'utf8')
if (patchOriginal.includes('id: brain-connector')) {
  console.error('[smoke] brainlab patch 里已经有 brain-connector（上次冒烟没恢复？），先清理再跑')
  process.exit(2)
}

/** @type {{name: string, task: string, note: string, exit: number|null, killed: boolean, stdoutTail: string, ok: boolean, eventsDir: string}[]} */
const results = []
let restored = false

/** 把 patch 与 Junction 恢复到冒烟前原状 */
function restoreProfile() {
  if (restored) return
  restored = true
  try {
    writeFileSync(PATCH_PATH, patchOriginal, 'utf8')
    log('patch 已按原文恢复')
  } catch (error) {
    console.error(`[smoke] patch 恢复失败（需要人工检查）：${describeError(error)}`)
  }
  try {
    if (existsSync(LINK_PATH) || isLinkLike(LINK_PATH)) {
      rmSync(LINK_PATH, { recursive: true, force: true })
      log('Junction 已移除')
    }
  } catch (error) {
    console.error(`[smoke] Junction 移除失败（需要人工检查）：${describeError(error)}`)
  }
}

process.on('SIGINT', () => {
  restoreProfile()
  process.exit(130)
})
process.on('exit', () => restoreProfile())

try {
  // ── 1. 挂载 ─────────────────────────────────────────────────────────────
  mkdirSync(LINK_PARENT, { recursive: true })
  if (existsSync(LINK_PATH) || isLinkLike(LINK_PATH)) rmSync(LINK_PATH, { recursive: true, force: true })
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-Command', `New-Item -ItemType Junction -Path "${LINK_PATH}" -Target "${CONNECTOR_DIR}" | Out-Null`],
    { stdio: 'inherit' },
  )
  log(`Junction: ${LINK_PATH} -> ${CONNECTOR_DIR}`)
  if (!existsSync(join(LINK_PATH, 'index.js'))) throw new Error('Junction 建立后读不到 index.js')

  writeFileSync(PATCH_PATH, patchOriginal + PATCH_BLOCK, 'utf8')
  log('patch 已追加 brain-connector（mode=shadow）')

  // ── 2. 跑真实回合 ───────────────────────────────────────────────────────
  const wanted = process.argv.slice(2)
  const scenes = wanted.length > 0 ? SCENES.filter((scene) => wanted.includes(scene.name)) : SCENES

  for (const scene of scenes) {
    const sceneEvents = join(EVENTS_DIR, scene.name)
    mkdirSync(sceneEvents, { recursive: true })
    log(`→ ${scene.name}: ${scene.note}`)
    const result = await runScene(scene, sceneEvents)
    results.push({ ...scene, ...result, eventsDir: sceneEvents })
    log(`  exit=${result.exit} killed=${result.killed} ok=${result.ok}${result.ok ? '' : ` tail=${result.stdoutTail}`}`)
  }

  // ── 3. 分析 ─────────────────────────────────────────────────────────────
  const analysis = analyze()
  const verdict = {
    runId: RUN_ID,
    createdAt: new Date().toISOString(),
    profile: PROFILE_DIR,
    mode: 'shadow',
    scenes: results.map((result) => ({
      name: result.name,
      note: result.note,
      exit: result.exit,
      killed: result.killed,
      ok: result.ok,
      stdoutTail: result.stdoutTail,
    })),
    ...analysis,
  }
  writeFileSync(join(RUN_DIR, 'verdict.json'), JSON.stringify(verdict, null, 2), 'utf8')
  writeFileSync(join(RUN_DIR, 'timeline.md'), renderMarkdown(verdict), 'utf8')

  log('')
  for (const check of verdict.checks) log(`${check.ok ? '✓' : '✗'} ${check.name}${check.ok ? '' : ` — ${check.note}`}`)
  const failed = verdict.checks.filter((check) => !check.ok)
  log(`产物：${RUN_DIR}`)
  process.exitCode = failed.length === 0 ? 0 : 1
} catch (error) {
  console.error(`[smoke] 失败：${describeError(error)}`)
  process.exitCode = 1
} finally {
  restoreProfile()
}

/**
 * 跑一个场景：一个真实 headless 回合。
 * @param {{name: string, task: string, sessionId?: string}} scene
 * @param {string} eventsDir
 * @returns {Promise<{exit: number|null, killed: boolean, stdoutTail: string, ok: boolean}>}
 */
function runScene(scene, eventsDir) {
  const env = {
    ...process.env,
    DSH_BRAIN_CONNECTOR_DIR: eventsDir,
    DSH_TELEMETRY_DISABLED: '1',
  }
  /** @type {string[]} */
  const args = ['--profile', 'brainlab', 'headless']
  if (scene.sessionId) args.push('--session-id', scene.sessionId)
  args.push(scene.task)

  return new Promise((resolve) => {
    const child = spawn('dsh', args, { cwd: REPO, env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    const onData = (/** @type {Buffer} */ chunk) => {
      out += chunk.toString('utf8')
      if (out.length > 6000) out = out.slice(-6000)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('close', (code) => {
      writeFileSync(join(eventsDir, 'stdout.txt'), out, 'utf8')
      resolve({
        exit: code,
        killed: false,
        stdoutTail: out.trim().split('\n').slice(-8).join(' | '),
        ok: code === 0,
      })
    })
  })
}

/**
 * 从冒烟产出的队列里统计钩子触发与注入情况。
 */
function analyze() {
  /** @type {Array<Record<string, any>>} */
  const records = []
  for (const sceneDir of readdirSync(EVENTS_DIR)) {
    const dir = join(EVENTS_DIR, sceneDir)
    let names = []
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    // 老 → 新：dsh-events.N.jsonl 先，dsh-events.jsonl 后
    const ordered = names.sort((a, b) => segmentRank(a) - segmentRank(b))
    for (const name of ordered) {
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (line.trim().length === 0) continue
        try {
          records.push({ ...JSON.parse(line), scene: sceneDir })
        } catch {
          /* 半写行跳过 */
        }
      }
    }
  }

  const traces = records.filter((record) => record.record_kind === 'hook_trace')
  const hookErrors = records.filter((record) => record.record_kind === 'hook_error')
  const attached = records.filter((record) => record.record_kind === 'context_attached')
  const sent = records.filter((record) => record.record_kind === 'context_sent')
  const events = records.filter((record) => record.record_kind === 'event')

  /** @type {Map<string, {scene: string, stepKey: string, assemble: number, preStep: number, stream: number}>} */
  const stepKeys = new Map()
  const bump = (/** @type {Record<string, any>} */ trace, /** @type {'assemble'|'preStep'|'stream'} */ field) => {
    const key = `${trace.scene}#${trace.stepKey ?? trace.sessionId ?? 'n/a'}`
    if (!stepKeys.has(key)) {
      stepKeys.set(key, { scene: trace.scene, stepKey: String(trace.stepKey ?? ''), assemble: 0, preStep: 0, stream: 0 })
    }
    const entry = stepKeys.get(key)
    if (entry !== undefined) entry[field] += 1
  }
  for (const trace of traces) {
    const hook = String(trace.hook ?? '')
    if (hook.startsWith('assemble.')) bump(trace, 'assemble')
    else if (hook.startsWith('pre-step.')) bump(trace, 'preStep')
  }

  const assembleTraces = traces.filter((trace) => String(trace.hook).startsWith('assemble.'))
  const preStepTraces = traces.filter((trace) => String(trace.hook).startsWith('pre-step.'))
  const streamTraces = traces.filter((trace) => trace.hook === 'llm.stream')
  const eventTraces = traces.filter((trace) => trace.hook === 'event.ingested')
  const turnStoppingTraces = traces.filter((trace) => trace.hook === 'turn-stopping')

  const mainRequests = streamTraces.filter((trace) => trace.counted === 'main').length
  const bypassRequests = streamTraces.filter((trace) => trace.counted === 'bypass').length

  // 同一 step 的 assemble 与 pre-step 必须解析出同一个键
  const assembleKeys = new Set(assembleTraces.map((trace) => `${trace.scene}#${trace.stepKey}`))
  const preStepKeys = new Set(preStepTraces.map((trace) => `${trace.scene}#${trace.stepKey}`))
  const keyMismatch = [...assembleKeys].filter((key) => !preStepKeys.has(key))
  const duplicateKeys = [...assembleKeys].filter((key) => {
    return assembleTraces.filter((trace) => `${trace.scene}#${trace.stepKey}` === key).length > 1
  })

  /** @type {Array<{name: string, ok: boolean, note: string}>} */
  const checks = []

  checks.push({
    name: '所有场景宿主正常收尾（exit=0）',
    ok: results.every((result) => result.exit === 0),
    note: results.map((result) => `${result.name}:exit=${result.exit}`).join(', '),
  })
  checks.push({
    name: '运行期零抛错（hook_error == 0）',
    ok: hookErrors.length === 0,
    note: hookErrors.length === 0 ? '队列里没有 hook_error 记录' : JSON.stringify(hookErrors.slice(0, 3)),
  })
  checks.push({
    name: '回合没有被 reason=error 终结',
    ok: !records.some((record) => record.event_type === 'turn/end' && record.meta?.reason_kind === 'error'),
    note: 'turn/end reason 全为正常值',
  })
  checks.push({
    name: 'shadow 模式零注入（context_attached == 0）',
    ok: attached.length === 0,
    note: `attached=${attached.length}`,
  })
  checks.push({
    name: 'assemble 次数 == pre-step 次数 == step 数',
    ok: assembleTraces.length === preStepTraces.length && assembleTraces.length > 0,
    note: `assemble=${assembleTraces.length} preStep=${preStepTraces.length}`,
  })
  checks.push({
    name: '同一 step 的 assemble 与 pre-step 解析出同一个幂等键',
    ok: keyMismatch.length === 0 && assembleTraces.length > 0,
    note: keyMismatch.length === 0 ? `键全部对齐：${[...assembleKeys].join(' ')}` : `未对齐：${keyMismatch.join(', ')}`,
  })
  checks.push({
    name: '同一 step 没有被重复装配（幂等键无重复）',
    ok: duplicateKeys.length === 0,
    note: duplicateKeys.length === 0 ? '每个 (session,turn,step) 只出现一次' : duplicateKeys.join(', '),
  })
  checks.push({
    name: 'llm/stream 请求计数按 purpose 剔除了标题旁路',
    ok: mainRequests > 0 && bypassRequests > 0 && mainRequests < streamTraces.length + 1,
    note: `main=${mainRequests} bypass=${bypassRequests} total=${streamTraces.length}`,
  })
  checks.push({
    name: 'session/event 摄取到了真实事件',
    ok: eventTraces.length > 0,
    note: `eventTraces=${eventTraces.length} envelopes=${events.length}`,
  })
  checks.push({
    name: 'agent/turn-stopping（serial）被触发且未抛错',
    ok: turnStoppingTraces.length > 0,
    note: `turnStopping=${turnStoppingTraces.length}`,
  })

  return {
    hooks: {
      assemble: assembleTraces.length,
      preStep: preStepTraces.length,
      stream: streamTraces.length,
      sessionEvent: eventTraces.length,
      turnStopping: turnStoppingTraces.length,
    },
    requests: { main: mainRequests, bypass: bypassRequests },
    injection: { attached: attached.length, sent: sent.length },
    events: {
      total: events.length,
      human: events.filter((record) => record.ingest_class === 'human').length,
      selfInjected: events.filter((record) => record.ingest_class === 'self_injected').length,
      siblingInjected: events.filter((record) => record.ingest_class === 'sibling_injected').length,
      contextSnapshot: events.filter((record) => record.ingest_class === 'context_snapshot').length,
    },
    stepKeys: [...stepKeys.values()],
    hookErrors,
    checks,
  }
}

/**
 * @param {ReturnType<typeof analyze>} verdict
 * @returns {string}
 */
function renderMarkdown(verdict) {
  const lines = [
    `# M2 connector 冒烟 — ${verdict.runId}`,
    '',
    `- profile：\`${verdict.profile}\``,
    `- 模式：\`${verdict.mode}\`（只算不注入）`,
    `- 时间：${verdict.createdAt}`,
    '',
    '## 场景',
    '',
    '| 场景 | exit | 结论 | 要证什么 |',
    '|---|---|---|---|',
    ...verdict.scenes.map((scene) => `| ${scene.name} | ${scene.exit} | ${scene.ok ? 'OK' : 'FAIL'} | ${scene.note} |`),
    '',
    '## 钩子触发',
    '',
    '| 钩子 | 次数 |',
    '|---|---|',
    `| system-prompt/assemble | ${verdict.hooks.assemble} |`,
    `| agent/pre-step | ${verdict.hooks.preStep} |`,
    `| llm/stream | ${verdict.hooks.stream}（主 ${verdict.requests.main} / 旁路 ${verdict.requests.bypass}） |`,
    `| session/event | ${verdict.hooks.sessionEvent} |`,
    `| agent/turn-stopping（serial） | ${verdict.hooks.turnStopping} |`,
    '',
    '## 注入',
    '',
    `- context_attached：${verdict.injection.attached}`,
    `- context_sent：${verdict.injection.sent}`,
    `- 摄取信封：${verdict.events.total}（human ${verdict.events.human} / self ${verdict.events.selfInjected} / sibling ${verdict.events.siblingInjected} / snapshot ${verdict.events.contextSnapshot}）`,
    '',
    '## 幂等键',
    '',
    '| 场景 | 键 | assemble | pre-step |',
    '|---|---|---|---|',
    ...verdict.stepKeys.map((entry) => `| ${entry.scene} | \`${entry.stepKey}\` | ${entry.assemble} | ${entry.preStep} |`),
    '',
    '## 验收',
    '',
    ...verdict.checks.map((check) => `- ${check.ok ? '✅' : '❌'} **${check.name}** — ${check.note}`),
    '',
  ]
  return lines.join('\n')
}

/**
 * @param {string} name
 * @returns {number}
 */
function segmentRank(name) {
  const match = /^dsh-events\.(\d+)\.jsonl$/.exec(name)
  if (match === null) return 0
  return -Number(match[1])
}

/** @param {string} path */
function isLinkLike(path) {
  try {
    return lstatSync(path).isSymbolicLink() || lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  const anyError = /** @type {any} */ (error)
  return String(anyError?.message ?? anyError ?? 'unknown error')
}
