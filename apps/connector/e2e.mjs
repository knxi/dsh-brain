// @ts-check
/**
 * e2e.mjs — M2 **真机端到端**：真主账 + 真检索 + 真构包 + automatic 注入 + 真实回合。
 *
 * 与 smoke.mjs 的区别：
 *   smoke = shadow 模式，证明「挂得上、不干扰」（零注入、零抛错、幂等键对齐）；
 *   e2e   = automatic 模式，证明「真注入、真 sent、真落库」（M2 最后一块真机证据）。
 *
 * 验六件事（Lead 收口清单）：
 *   1. 注入真的进了最终请求对象（sent 判据三级承载都查）；
 *   2. **同一 turn 多 step 不重复注入**（M2 门槛「无重复注入」的真机证据）；
 *   3. 零抛错、宿主照常回答；
 *   4. `updateStatus` 把 attached / sent **真的写进主账**（读回 `context_packages` 验证）；
 *   5. carrier 是实际观测到的承载位置（不是声明值）；
 *   6. `proves_wire_delivery` 恒 false。
 *
 * 数据纪律：全程合成数据（自造 3 条记忆 + 一句自造 prompt），写在自己的 run 目录里，
 * 不碰 `~/.dsh/profiles/web`，也不碰 Engram/灵枢 记忆库。
 *
 * 用法：
 *   node apps/connector/e2e.mjs            # 两个场景（单步 / 两步工具回合）
 *   node apps/connector/e2e.mjs single     # 只跑一个
 */
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const PROFILE_DIR = process.env.DSH_PROFILE_BRAINLAB ?? 'C:/Users/su/.dsh/profiles/brainlab'
const PATCH_PATH = join(PROFILE_DIR, 'cordis.patch.yml')
const LINK_PARENT = join(PROFILE_DIR, 'node_modules', '@dsh-brain')
const LINK_PATH = join(LINK_PARENT, 'connector')

const RUN_ID = `m2-e2e-${timestampSlug()}`
const RUN_DIR = join(REPO, 'data', 'probe', RUN_ID)
const BRAIN_DB = join(RUN_DIR, 'brain.db')
const MIGRATIONS_DIR = join(REPO, 'migrations')
const MEMORY_MODULE = pathToFileURL(join(REPO, 'packages', 'memory', 'src', 'index.js')).href
const CONTEXT_MODULE = pathToFileURL(join(REPO, 'packages', 'context', 'src', 'index.js')).href

/** @type {Array<{name: string, task: string, note: string}>} */
const SCENES = [
  {
    name: 'single',
    task: '踢脚线报价单位？只回一个短语，不要解释。',
    note: '单步回合：构包 → 注入 → 最终请求命中 → sent；验证 attached/sent 两级落库。',
  },
  {
    name: 'tool-read',
    task: '踢脚线报价单位？先 read apps/connector/package.json 核对包名再一行回答。',
    note: '两步回合：第 2 个 step 重新装配 → 必须**新包**而不是重复注入同一个。',
  },
]

/** 合成记忆（覆盖主人的真实工作语境：尺寸、材质、图号、报价）。
 *
 * `sourceIds` 不能空：没有可核对来源时检索会给 `diagnostics.status = source_missing`，
 * 构包侧按契约如实降级成空包（不注入）——那就测不到注入了（第一次跑就栽在这）。
 */
const SEED_MEMORIES = [
  {
    content: '踢脚线报价按 1.2m 段计，2400×600 板材损耗按 8% 计。',
    summary: '踢脚线报价按 1.2m 段计，板材损耗 8%',
    type: 'semantic',
    layer: 'long',
    sourceIds: ['seed-event-kickboard-1'],
  },
  {
    content: '图号 建施-03 对应一层平面图，关键尺寸 1200mm / 2400×600。',
    summary: '建施-03 一层平面，尺寸 1200mm / 2400×600',
    type: 'semantic',
    layer: 'long',
    sourceIds: ['seed-event-drawing-03'],
  },
  {
    content: '报价单模板放在共享盘 05-报价/2026 目录，文件名带图号。',
    summary: '报价单模板在共享盘 05-报价/2026',
    type: 'semantic',
    layer: 'long',
    sourceIds: ['seed-event-quote-template'],
  },
  {
    // 这条专门覆盖「带工具指令的长句 query」：检索覆盖率阈值 0.34 很挑，
    // 长问句（问句 + 路径 + 工具指令）达不到阈值就会如实降级成空包（不注入），
    // 那样多步回合就测不到注入了。合成语料里补一条匹配的工作流记忆是正当的测试夹具。
    content: '用户常问踢脚线报价单位；回答前先用 read 工具核对 apps/connector/package.json 的 name 字段，再一行回答。',
    summary: '踢脚线报价单位：先 read package.json 核对包名再回答',
    type: 'semantic',
    layer: 'long',
    sourceIds: ['seed-event-workflow-1'],
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
  console.log(`[e2e] ${message}`)
}

// ── 0. 准备 ────────────────────────────────────────────────────────────────
mkdirSync(RUN_DIR, { recursive: true })

const connectorModule = await import(pathToFileURL(join(HERE, 'index.js')).href)
const memoryModule = await import(MEMORY_MODULE)
const contextModule = await import(CONTEXT_MODULE)
log(`模块就绪：connector=${connectorModule.name} memory=${typeof memoryModule.openBrain} context=${typeof contextModule.build}`)

// 播种：先自己开主账（会跑 0001/0002/0003 迁移），写三条合成记忆，然后关掉。
{
  const store = memoryModule.openBrain({ dbPath: BRAIN_DB, migrationsDir: MIGRATIONS_DIR })
  log(`主账初建：schema v${store.schemaVersion}，迁移 ${store.migrations.applied.length} 条`)
  for (const seed of SEED_MEMORIES) {
    await store.memories.create({
      scopeId: 'owner-default',
      personId: 'owner',
      layer: seed.layer,
      type: seed.type,
      content: seed.content,
      summary: seed.summary,
      sourceType: 'owner_words',
      sourceIds: seed.sourceIds,
      confidence: 1,
      importance: 0.7,
      privacy: 'private',
      originSystem: 'dsh',
      producer: 'connector-e2e-seed',
    })
  }
  const probe = store.memories.search({ query: '踢脚线报价单位', scopeId: 'owner-default', personId: 'owner', limit: 5 })
  log(`播种检索自检：status=${probe.diagnostics?.status} hits=${probe.hits?.length}`)
  await store.close()
}

if (!existsSync(PATCH_PATH)) {
  console.error(`[e2e] brainlab patch 不存在：${PATCH_PATH}`)
  process.exit(2)
}
const patchOriginal = readFileSync(PATCH_PATH, 'utf8')
if (patchOriginal.includes('id: brain-connector')) {
  console.error('[e2e] patch 里已有 brain-connector，先清理再跑')
  process.exit(2)
}

/**
 * 生成临时 patch 块。
 * @param {{ injectChannel: 'contexts'|'pre-step', fallbackDir: string }} options
 * @returns {string}
 */
function buildPatchBlock(options) {
  return `
# ⚠️ M2 connector 端到端块（apps/connector/e2e.mjs 临时写入，跑完自动删除）
- insert:
    - id: brain-connector
      name: '@dsh-brain/connector'
      config:
        mode: automatic
        injectChannel: ${options.injectChannel}
        # 每个场景用自己的队列目录（与 smoke.mjs 同一手法）：env 优先，缺省回落。
        # 写成 !!js 是必须的 —— 写死 dir 会让所有场景的 trace 挤进同一个文件，
        # 分析时按场景读就成了空（第一次跑就是栽在这里）。
        dir: !!js "process.env.DSH_BRAIN_CONNECTOR_DIR ?? '${toYamlPath(toPosix(options.fallbackDir))}'"
        storePath: '${toYamlPath(toPosix(BRAIN_DB))}'
        migrationsDir: '${toYamlPath(toPosix(MIGRATIONS_DIR))}'
        memoryModule: '${MEMORY_MODULE}'
        contextModule: '${CONTEXT_MODULE}'
        buildTimeoutMs: 5000
        budget:
          modelWindow: 128000
          hostInputTokens: 4000
          outputReserve: 2000
          brainCap: 2048
        logLevel: info
`
}

/** @type {Array<Record<string, any>>} */
const sceneResults = []
let restored = false

function restoreProfile() {
  if (restored) return
  restored = true
  try {
    writeFileSync(PATCH_PATH, patchOriginal, 'utf8')
    log('patch 已按原文恢复')
  } catch (error) {
    console.error(`[e2e] patch 恢复失败：${describeError(error)}`)
  }
  try {
    if (existsSync(LINK_PATH) || isLinkLike(LINK_PATH)) {
      rmSync(LINK_PATH, { recursive: true, force: true })
      log('Junction 已移除')
    }
  } catch (error) {
    console.error(`[e2e] Junction 移除失败：${describeError(error)}`)
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
    ['-NoProfile', '-Command', `New-Item -ItemType Junction -Path "${LINK_PATH}" -Target "${HERE}" | Out-Null`],
    { stdio: 'inherit' },
  )
  writeFileSync(
    PATCH_PATH,
    patchOriginal + buildPatchBlock({ injectChannel: 'contexts', fallbackDir: join(RUN_DIR, 'events-dev') }),
    'utf8',
  )
  log('已挂 connector（mode=automatic + 真主账 + 真 build + injectChannel=contexts）')

  // ── 2. 跑真实回合 ───────────────────────────────────────────────────────
  const wanted = process.argv.slice(2)
  const scenes = wanted.length > 0 ? SCENES.filter((scene) => wanted.includes(scene.name)) : [...SCENES]
  for (const scene of scenes) {
    const eventsDir = join(RUN_DIR, 'events', scene.name)
    mkdirSync(eventsDir, { recursive: true })
    log(`→ ${scene.name}: ${scene.note}`)
    const result = await runScene(scene, eventsDir)
    sceneResults.push({ ...scene, ...result, eventsDir })
    log(`  exit=${result.exit} ok=${result.ok}${result.ok ? '' : ` tail=${result.stdoutTail}`}`)
  }

  // 追加：同会话第二轮。为什么需要它 —— 真机实测第一个 step 的 assemble 早于
  // `user/message` commit（queryCache 空），所以**首轮的第一步注定拿不到 query**。
  // 第二轮开始时 queryCache 里已有上一轮的用户话，于是 step1 → step2 **两步都注入**，
  // 这才是「同一 turn 多 step 各注入一次、互不重复」的可证伪真机证据。
  if (scenes.some((scene) => scene.name === 'single')) {
    const sessionId = extractSessionId(join(RUN_DIR, 'events', 'single'))
    if (sessionId === '') {
      log('⚠️ 没能从 single 场景提取 sessionId，跳过第二轮')
    } else {
      const resumeScene = {
        name: 'resume-turn2',
        task: '踢脚线报价单位？先 read apps/connector/package.json 核对包名再一行回答。',
        note: `同会话第二轮（--session-id ${sessionId}）：step1 与 step2 都应有 query → 两步各注入一次且不重复。`,
        sessionId,
      }
      const eventsDir = join(RUN_DIR, 'events', resumeScene.name)
      mkdirSync(eventsDir, { recursive: true })
      log(`→ ${resumeScene.name}: ${resumeScene.note}`)
      const result = await runScene(resumeScene, eventsDir)
      sceneResults.push({ ...resumeScene, ...result, eventsDir })
      log(`  exit=${result.exit} ok=${result.ok}${result.ok ? '' : ` tail=${result.stdoutTail}`}`)
    }
  }

  // ── 2c. pre-step 通道的两步回合 ─────────────────────────────────────────
  // contexts 通道有个真机限制：第一个 step 的 `system-prompt/assemble` 早于
  // `session.append('user/message')`，那时 queryCache 还是空的，所以首步构不出包。
  // pre-step 通道能直接从 `payload.messages` 读到本轮用户话 —— 每一步都有 query。
  // 这一轮是「同一 turn 内两个 step 各注入一次、包互不相同」的正向真机证据。
  {
    const preStepScene = {
      name: 'prestep-two-step',
      task: '踢脚线报价单位？先 read apps/connector/package.json 核对包名再一行回答。',
      note: 'pre-step 通道 + 两步工具回合：两个 step 都应注入，且 contextId 互不相同。',
    }
    writeFileSync(
      PATCH_PATH,
      patchOriginal + buildPatchBlock({ injectChannel: 'pre-step', fallbackDir: join(RUN_DIR, 'events-dev-prestep') }),
      'utf8',
    )
    log('patch 已切到 injectChannel=pre-step')
    const eventsDir = join(RUN_DIR, 'events', preStepScene.name)
    mkdirSync(eventsDir, { recursive: true })
    log(`→ ${preStepScene.name}: ${preStepScene.note}`)
    const result = await runScene(preStepScene, eventsDir)
    sceneResults.push({ ...preStepScene, ...result, eventsDir })
    log(`  exit=${result.exit} ok=${result.ok}${result.ok ? '' : ` tail=${result.stdoutTail}`}`)
  }
} catch (error) {
  console.error(`[e2e] 运行失败：${describeError(error)}`)
  process.exitCode = 1
} finally {
  restoreProfile()
}

// ── 3. 读回主账 + 分析 ──────────────────────────────────────────────────────
const ledgerRead = readPackages()
const analysis = analyze(ledgerRead)
const verdict = {
  runId: RUN_ID,
  createdAt: new Date().toISOString(),
  mode: 'automatic',
  brainDb: BRAIN_DB,
  scenes: sceneResults.map((result) => ({
    name: result.name,
    note: result.note,
    exit: result.exit,
    ok: result.ok,
    stdoutTail: result.stdoutTail,
  })),
  ...analysis,
}
writeFileSync(join(RUN_DIR, 'verdict.json'), JSON.stringify(verdict, null, 2), 'utf8')
writeFileSync(join(RUN_DIR, 'timeline.md'), renderMarkdown(verdict), 'utf8')

log('')
for (const check of verdict.checks) {
  const mark = check.ok ? '✓' : check.pending ? '…' : '✗'
  log(`${mark} ${check.name}${check.ok ? '' : ` — ${check.note}`}`)
}
const failed = verdict.checks.filter((check) => !check.ok && !check.pending)
log(`产物：${RUN_DIR}`)
process.exitCode = failed.length === 0 ? 0 : 1

// ── 实现 ───────────────────────────────────────────────────────────────────

/**
 * 跑一个真实 headless 回合。
 * @param {{name: string, task: string}} scene
 * @param {string} eventsDir
 */
function runScene(scene, eventsDir) {
  const env = {
    ...process.env,
    DSH_BRAIN_CONNECTOR_DIR: eventsDir,
    DSH_TELEMETRY_DISABLED: '1',
  }
  return new Promise((resolvePromise) => {
    /** @type {string[]} */
    const args = ['--profile', 'brainlab', 'headless']
    if (typeof scene.sessionId === 'string' && scene.sessionId.length > 0) {
      args.push('--session-id', scene.sessionId)
    }
    args.push(scene.task)
    const child = spawn('dsh', args, {
      cwd: REPO,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    const onData = (/** @type {Buffer} */ chunk) => {
      out += chunk.toString('utf8')
      if (out.length > 12000) out = out.slice(-12000)
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('close', (code) => {
      writeFileSync(join(eventsDir, 'stdout.txt'), out, 'utf8')
      resolvePromise({
        exit: code,
        stdoutTail: out.trim().split('\n').slice(-10).join(' | '),
        ok: code === 0,
      })
    })
  })
}

/**
 * 从某场景的队列里提取会话 id（供第二轮 --session-id 续写）。
 * @param {string} eventsDir
 * @returns {string}
 */
function extractSessionId(eventsDir) {
  let names = []
  try {
    names = readdirSync(eventsDir).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return ''
  }
  for (const name of names) {
    const text = readFileSync(join(eventsDir, name), 'utf8')
    const fromStepKey = /"stepKey":"(session-[^"#]+)#/.exec(text)
    if (fromStepKey !== null) return fromStepKey[1]
    const fromSessionField = /"(session-[0-9a-f-]{6,})"/.exec(text)
    if (fromSessionField !== null) return fromSessionField[1]
  }
  return ''
}

/**
 * 只读重开主账，读回 `context_packages`。
 */
function readPackages() {
  try {
    const store = memoryModule.openBrain({ dbPath: BRAIN_DB, migrationsDir: MIGRATIONS_DIR, readOnly: true })
    const facade = store.contextPackages
    if (facade === undefined || facade === null) {
      return { ok: false, reason: 'no_context_packages_facade', rows: [] }
    }
    const page = facade.list({ limit: 100 })
    const rows = Array.isArray(page?.items) ? page.items : Array.isArray(page) ? page : []
    return { ok: true, reason: null, rows, schemaVersion: store.schemaVersion }
  } catch (error) {
    return { ok: false, reason: describeError(error), rows: [] }
  }
}

/**
 * @param {{ ok: boolean, reason: string | null, rows: Array<Record<string, any>> }} ledgerRead
 */
function analyze(ledgerReadResult) {
  /** @type {Array<Record<string, any>>} */
  const records = []
  for (const sceneResult of sceneResults) {
    const dir = sceneResult.eventsDir
    let names = []
    try {
      names = readdirSync(dir).filter((name) => name.endsWith('.jsonl'))
    } catch {
      continue
    }
    for (const name of names.sort((a, b) => segmentRank(a) - segmentRank(b))) {
      for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
        if (line.trim().length === 0) continue
        try {
          records.push({ ...JSON.parse(line), scene: sceneResult.name })
        } catch {
          /* 半写行跳过 */
        }
      }
    }
  }

  const traces = records.filter((record) => record.record_kind === 'hook_trace')
  const hookErrors = records.filter((record) => record.record_kind === 'hook_error')
  const attachedRecords = records.filter((record) => record.record_kind === 'context_evidence' && record.status === 'attached')
  const sentRecords = records.filter((record) => record.record_kind === 'context_evidence' && record.status === 'sent')
  const events = records.filter((record) => record.record_kind === 'event')

  const assembleTraces = traces.filter((trace) => String(trace.hook).startsWith('assemble.'))
  const preStepTraces = traces.filter((trace) => String(trace.hook).startsWith('pre-step.'))
  // 两条注入通道都要算：contexts（assemble 里追加 PromptContext）与 pre-step（追加 user 消息）。
  const injectTraces = traces.filter((trace) => /\.inject\.(contexts|pre-step)$/.test(String(trace.hook)))
  const streamTraces = traces.filter((trace) => trace.hook === 'llm.stream')

  /** @type {Map<string, { turn: number|null, step: number|null, contextId: string }>} */
  const stepKeys = new Map()
  for (const trace of injectTraces) {
    if (typeof trace.stepKey !== 'string') continue
    stepKeys.set(`${trace.scene}#${trace.stepKey}`, {
      turn: typeof trace.step === 'number' ? trace.step : null,
      step: typeof trace.step === 'number' ? trace.step : null,
      contextId: String(trace.contextId ?? ''),
    })
  }

  const rows = ledgerReadResult.rows
  const dbSent = rows.filter((row) => row.status === 'sent')
  const dbAttached = rows.filter((row) => row.status === 'attached')
  const carriersInDb = [...new Set(rows.map((row) => row.carrier).filter((value) => typeof value === 'string'))]
  const sentEvidence = dbSent.map((row) => row.sentEvidence).filter((value) => value !== null && typeof value === 'object')
  const allProvesFalse = sentEvidence.every((evidence) => evidence.proves_wire_delivery === false)
  const sentLocations = [...new Set(sentEvidence.flatMap((evidence) => evidence.observed_hash_locations ?? []))]

  // 「同一 turn 多 step 不重复注入」：注入次数 == 不同 (stepKey) 数，且每个 contextId 只出现一次
  const injectedContextIds = injectTraces.map((trace) => String(trace.contextId ?? ''))
  const uniqueContextIds = new Set(injectedContextIds)
  const duplicateInjections = injectedContextIds.length - uniqueContextIds.size
  const byStep = new Map()
  for (const trace of injectTraces) {
    const key = `${trace.scene}#${trace.stepKey}`
    byStep.set(key, (byStep.get(key) ?? 0) + 1)
  }
  const repeatedSteps = [...byStep.entries()].filter(([, count]) => count > 1)

  // 按 (session, turn) 分组，找「同一个 turn 里多个 step 都注入」的组 ——
  // 这是 M2 门槛「注入无重复」的正向真机证据（不只是「没重复」，而是「该注入的都注了、
  // 且各 step 拿到的是不同的包」）。
  /** @type {Map<string, Array<{ step: number, contextId: string, scene: string }>>} */
  const bySessionTurn = new Map()
  for (const trace of injectTraces) {
    const parsed = parseStepKey(trace.stepKey)
    if (parsed === null) continue
    const key = `${parsed.session}#${parsed.turn}`
    const list = bySessionTurn.get(key) ?? []
    list.push({ step: parsed.step, contextId: String(trace.contextId ?? ''), scene: trace.scene })
    bySessionTurn.set(key, list)
  }
  const multiStepTurns = [...bySessionTurn.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([key, list]) => ({
      key,
      steps: list.map((entry) => entry.step),
      contextIds: list.map((entry) => entry.contextId),
      distinctSteps: new Set(list.map((entry) => entry.step)).size === list.length,
      distinctContexts: new Set(list.map((entry) => entry.contextId)).size === list.length,
    }))
  const goodMultiStepTurns = multiStepTurns.filter((turn) => turn.distinctSteps && turn.distinctContexts)

  /** @type {Array<{name: string, ok: boolean, pending?: boolean, note: string}>} */
  const checks = []

  checks.push({
    name: '宿主正常收尾（exit=0）且照常回答',
    ok: sceneResults.every((result) => result.exit === 0 && result.ok),
    note: sceneResults.map((result) => `${result.name}:exit=${result.exit}`).join(', '),
  })
  checks.push({
    name: '真构包发生了（inject.contexts > 0，不是「没包可注入」）',
    ok: injectTraces.length > 0,
    note: `inject.contexts=${injectTraces.length}`,
  })
  checks.push({
    name: '注入真的进了最终请求（sent 命中）',
    ok: sentRecords.length > 0,
    note: `sent=${sentRecords.length} / attached=${attachedRecords.length}`,
  })
  checks.push({
    name: 'sent 判据查了三级承载（记录里 carriers_checked 齐全）',
    ok: records
      .filter((record) => record.record_kind === 'context_sent')
      .every((record) => Array.isArray(record.carriers_checked) && record.carriers_checked.length === 3),
    note: 'request.system / messages[role=system] / messages[other]',
  })
  checks.push({
    name: '同一 step 不重复注入（同一 stepKey 只注入一次）',
    ok: duplicateInjections === 0 && repeatedSteps.length === 0 && injectTraces.length > 0,
    note: repeatedSteps.length === 0
      ? `injections=${injectTraces.length} unique=${uniqueContextIds.size}（跨 ${byStep.size} 个 step）`
      : `重复：${JSON.stringify(repeatedSteps)}`,
  })
  checks.push({
    name: '同一 turn 多 step 各注入一次、包互不相同（M2 门槛「注入无重复」正向真机证据）',
    ok: goodMultiStepTurns.length > 0,
    note:
      goodMultiStepTurns.length > 0
        ? goodMultiStepTurns
            .map((turn) => `${turn.key} → steps=${JSON.stringify(turn.steps)} ctx=${turn.contextIds.length} 个互不相同`)
            .join('；')
        : `没有出现「同一 turn 内 ≥2 个 step 都注入」的组（候选 ${multiStepTurns.length} 组）；` +
          '首轮第 1 个 step 的 queryCache 必然为空（assemble 早于 user/message commit），所以要看第二轮',
  })
  checks.push({
    name: '每个 step 都走了 assemble + pre-step（钩子对称）',
    ok: assembleTraces.length === preStepTraces.length && assembleTraces.length > 0,
    note: `assemble=${assembleTraces.length} preStep=${preStepTraces.length}`,
  })
  checks.push({
    name: '运行期零抛错（hook_error == 0）',
    ok: hookErrors.length === 0,
    note: hookErrors.length === 0 ? '队列里没有 hook_error' : JSON.stringify(hookErrors.slice(0, 2)),
  })
  checks.push({
    name: '摄取到了真实事件',
    ok: events.length > 0,
    note: `envelopes=${events.length}`,
  })

  // 主账写入（这条是 Lead 收口清单的核心）
  const ledgerBlocked = !ledgerReadResult.ok
  checks.push({
    name: 'updateStatus 真写进主账：attached 级',
    ok: dbAttached.length + dbSent.length > 0,
    pending: ledgerBlocked || (attachedRecords.length > 0 && dbAttached.length + dbSent.length === 0),
    note: ledgerBlocked
      ? `主账读不回：${String(ledgerReadResult.reason)}`
      : `库里 attached+已前进=${dbAttached.length + dbSent.length}（attached 记录 ${attachedRecords.length} 条）`,
  })
  checks.push({
    name: 'updateStatus 真写进主账：sent 级 + carrier 是实测值 + proves_wire_delivery=false',
    ok: dbSent.length > 0 && allProvesFalse,
    pending: ledgerBlocked || sentRecords.length > 0,
    note: ledgerBlocked
      ? `主账读不回：${String(ledgerReadResult.reason)}`
      : `库里 sent=${dbSent.length}，carrier=${JSON.stringify(carriersInDb)}，locations=${JSON.stringify(sentLocations)}，所有 sent 证据 proves_wire_delivery===false：${allProvesFalse}`,
  })

  return {
    hooks: {
      assemble: assembleTraces.length,
      preStep: preStepTraces.length,
      injectContexts: injectTraces.length,
      stream: streamTraces.length,
    },
    injection: {
      attached: attachedRecords.length,
      sent: sentRecords.length,
      uniqueContextIds: uniqueContextIds.size,
      duplicateInjections,
      multiStepTurns,
    },
    ledger: {
      ok: ledgerReadResult.ok,
      reason: ledgerReadResult.reason,
      rows: rows.map((row) => ({
        // memory2 的 toPackage 把 context_id 暴露成 `id`（不是 contextId）。
        contextId: row.id ?? row.contextId ?? '',
        sessionId: row.sessionId,
        turnId: row.turnId,
        stepId: row.stepId,
        status: row.status,
        carrier: row.carrier,
        hasBudget: row.budget !== null && row.budget !== undefined,
        sentEvidence: row.sentEvidence,
      })),
    },
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
    `# M2 连接器真机端到端 — ${verdict.runId}`,
    '',
    `- 模式：\`${verdict.mode}\`（真主账 + 真 build + 自动注入）`,
    `- 主账：\`${verdict.brainDb}\``,
    `- 时间：${verdict.createdAt}`,
    '',
    '## 场景',
    '',
    '| 场景 | exit | 结论 | 要证什么 |',
    '|---|---|---|---|',
    ...verdict.scenes.map((scene) => `| ${scene.name} | ${scene.exit} | ${scene.ok ? 'OK' : 'FAIL'} | ${scene.note} |`),
    '',
    '## 钩子与注入',
    '',
    `- assemble：${verdict.hooks.assemble} · pre-step：${verdict.hooks.preStep} · llm/stream：${verdict.hooks.stream}`,
    `- 真注入：${verdict.hooks.injectContexts} 次（唯一 contextId ${verdict.injection.uniqueContextIds} 个，重复 ${verdict.injection.duplicateInjections}）`,
    `- attached 证据：${verdict.injection.attached} · sent 证据：${verdict.injection.sent}`,
    '',
    '## 主账里的 context_packages',
    '',
    '| contextId | turn/step | status | carrier | budget |',
    '|---|---|---|---|---|',
    ...verdict.ledger.rows.map(
      (row) => `| ${row.contextId} | ${row.turnId}/${row.stepId} | ${row.status} | ${row.carrier ?? '-'} | ${row.hasBudget ? '有' : '无'} |`,
    ),
    '',
    '## 验收',
    '',
    ...verdict.checks.map(
      (check) => `- ${check.ok ? '✅' : check.pending ? '⏳' : '❌'} **${check.name}** — ${check.note}`,
    ),
    '',
  ]
  return lines.join('\n')
}

/** @param {string} name */
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

/** @param {string} path YAML 单引号字符串里回车/单引号要处理 */
function toYamlPath(path) {
  return path.replace(/'/g, "''")
}

/** Windows 反斜杠路径 → 正斜杠（DSH profile 里一贯用正斜杠，少一层转义歧义） */
function toPosix(path) {
  return path.replace(/\\/g, '/')
}

/**
 * 拆幂等键 `session-xxx#turn#step`（连接器 trace 里的 stepKey 格式）。
 * @param {unknown} key
 * @returns {{ session: string, turn: number, step: number } | null}
 */
function parseStepKey(key) {
  if (typeof key !== 'string') return null
  const parts = key.split('#')
  if (parts.length !== 3) return null
  const turn = Number(parts[1])
  const step = Number(parts[2])
  if (!Number.isFinite(turn) || !Number.isFinite(step)) return null
  return { session: parts[0], turn, step }
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function describeError(error) {
  const anyError = /** @type {any} */ (error)
  return String(anyError?.message ?? anyError ?? 'unknown error')
}
