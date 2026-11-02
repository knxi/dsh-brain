// @ts-check
/**
 * rollback.mjs — 停用回滚验证（M0 交付项 5）。
 *
 * 分三步证明"卸载探针后宿主基础对话仍可用"，并区分两种失效形态：
 *   A. 只摘掉插件包（node_modules Junction），保留 profile patch 行
 *      → 期望：宿主照常回答问题，只是加载器 warn "entry did not activate"。
 *         这就是"扩展缺失不拖垮宿主"的直接证据。
 *   B. 同时移除 profile patch 里的 insert 行
 *      → 期望：完全干净回滚，零警告。
 *   C. 恢复挂载，确认可复现地回到工作状态。
 *
 * 用法：node apps/probe/rollback.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const REPO = 'E:/ds-h/dsh-brain'
const PROFILE_DIR = 'C:/Users/su/.dsh/profiles/brainlab'
const PATCH_FILE = `${PROFILE_DIR}/cordis.patch.yml`
const OUT = `${REPO}/data/probe/rollback`

/** 探针行在 patch 里的起始标记（和上面一行注释一起算作可移除区块）。 */
const PROBE_BLOCK_START = '# 探针：只记录不干预'
const PROBE_BLOCK_END_MARKER = "injectPreStep: !!js \"process.env.DSH_PROBE_INJECT_PRESTEP === '1'\""

const patchOriginal = readFileSync(PATCH_FILE, 'utf8')

/**
 * 跑一次 headless 并返回结果。
 * @param {string} label
 * @param {string} task
 */
function runHeadless(label, task) {
  const result = spawnSync('dsh', ['--profile', 'brainlab', 'headless', task], {
    cwd: REPO,
    encoding: 'utf8',
    shell: true,
    timeout: 120000,
    env: { ...process.env, DSH_TELEMETRY_DISABLED: '1' },
  })
  const stdout = `${result.stdout ?? ''}`.trim()
  const stderr = `${result.stderr ?? ''}`.trim()
  const combined = `${stdout}\n${stderr}`
  const activatedFailures = combined
    .split('\n')
    .filter((line) => line.includes('did not activate') || line.includes('failed to import'))
  const answer = stdout.split('\n').filter((line) => line.trim().length > 0).slice(-1)[0] ?? ''
  return {
    label,
    exit: result.status,
    answer,
    warningLines: activatedFailures,
    ok: result.status === 0 && answer.length > 0,
    rawTail: combined.split('\n').filter((line) => line.trim().length > 0).slice(-4),
  }
}

/**
 * 从 patch 里移除探针 insert 区块。
 * @param {string} text
 */
function stripProbeBlock(text) {
  const start = text.indexOf(PROBE_BLOCK_START)
  const end = text.indexOf(PROBE_BLOCK_END_MARKER)
  if (start < 0 || end < 0) return text
  return text.slice(0, start).trimEnd() + '\n'
}

/** @param {string} action */
function attach(action) {
  const result = spawnSync('node', [`${REPO}/apps/probe/attach.mjs`, action], { cwd: REPO, encoding: 'utf8' })
  return { action, exit: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() }
}

/** @type {any[]} */
const steps = []

// 基线：探针在位时能跑通
steps.push({ phase: 'baseline-with-probe', ...runHeadless('baseline', 'Reply with exactly: BASELINE-OK') })

// A：只摘掉插件包，patch 行还在
steps.push({ phase: 'detach-package-only', attach: attach('detach'), ...runHeadless('detach-only', 'Reply with exactly: DETACH-OK') })

// B：同时移除 patch 里的 insert 行
writeFileSync(PATCH_FILE, stripProbeBlock(patchOriginal), 'utf8')
steps.push({ phase: 'detach-package-and-patch', ...runHeadless('fully-removed', 'Reply with exactly: REMOVED-OK') })

// C：恢复
writeFileSync(PATCH_FILE, patchOriginal, 'utf8')
steps.push({ phase: 'restore', attach: attach('attach'), ...runHeadless('restored', 'Reply with exactly: RESTORED-OK') })

const report = {
  createdAt: new Date().toISOString(),
  profile: PROFILE_DIR,
  patchFileIntact: readFileSync(PATCH_FILE, 'utf8') === patchOriginal,
  probeLinkRestored: existsSync(`${PROFILE_DIR}/node_modules/@dsh-brain/probe/index.js`),
  verdict: {
    baselineWorks: steps.find((step) => step.phase === 'baseline-with-probe')?.ok === true,
    hostStillWorksWhenPluginMissing: steps.find((step) => step.phase === 'detach-package-only')?.ok === true,
    cleanRollbackWorks: steps.find((step) => step.phase === 'detach-package-and-patch')?.ok === true,
    restorable: steps.find((step) => step.phase === 'restore')?.ok === true,
  },
  steps,
}

writeFileSync(`${OUT}.json`, JSON.stringify(report, null, 2), 'utf8')
console.log(JSON.stringify(report.verdict, null, 2))
for (const step of steps) {
  console.log(`[rollback] ${step.phase}: exit=${step.exit} ok=${step.ok} answer=${JSON.stringify(step.answer)} warnings=${JSON.stringify(step.warningLines)}`)
}
console.log(`[rollback] report: ${OUT}.json`)
