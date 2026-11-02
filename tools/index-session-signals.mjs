// @ts-check
/**
 * tools/index-session-signals.mjs —— 重建「会话信号索引」（care / commitment）。
 *
 * 用途：社交门面的 `unfinished_care` / `commitment` 两类先查记忆库；查不到时，
 * 用这份索引兜底——它扫真实会话，只留两类可被机器识别、且**带会话坐标**的信号：
 *   - care：主人提过身体/情绪/具体安排，之后没再收尾的
 *   - commitment：主人明确交代、还没看到完成迹象的
 *
 * 索引里每一条都能回溯到 `sessionId@毫秒时间戳`，没有坐标的一条都不会被产出。
 *
 * 用法：
 *   node tools/index-session-signals.mjs             # 重建并写缓存
 *   node tools/index-session-signals.mjs --dry-run   # 只统计，不写文件
 *   node tools/index-session-signals.mjs --sessions <dir> --cache <file>
 *
 * 插件里的驱动器每 30 分钟会自动重建一次；这个脚本用于手动核对/排查。
 */
import { buildSignalIndex, refreshSignalIndex, DEFAULT_CACHE_PATH, DEFAULT_SESSIONS_ROOT } from '../packages/persona/src/session-signal-index.js'

function parseArgs(argv) {
  const args = { dryRun: false, sessionsRoot: DEFAULT_SESSIONS_ROOT, cachePath: DEFAULT_CACHE_PATH }
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i]
    if (item === '--dry-run') args.dryRun = true
    else if (item === '--sessions') { args.sessionsRoot = argv[i + 1]; i += 1 }
    else if (item === '--cache') { args.cachePath = argv[i + 1]; i += 1 }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))
const startedAt = Date.now()

if (args.dryRun) {
  const index = buildSignalIndex({ sessionsRoot: args.sessionsRoot })
  console.log('=== 会话信号索引（dry-run，未写文件）===')
  console.log(`耗时 ${Date.now() - startedAt}ms`)
  console.log(`覆盖：会话 ${index.coverage.sessions} 个 / 主人消息 ${index.coverage.userMessages} 条 / 跳过子代理 ${index.coverage.skippedSubagent} 个`)
  console.log(`care ${index.signals.care.length} 条 / commitment ${index.signals.commitment.length} 条`)
  for (const item of index.signals.care.slice(0, 5)) {
    console.log(`  [care ${item.quality}] ${item.text}`)
    console.log(`        证据：${item.evidence.join(', ')}`)
  }
  for (const item of index.signals.commitment.slice(0, 5)) {
    console.log(`  [commitment] ${item.text}`)
    console.log(`        证据：${item.evidence.join(', ')}`)
  }
} else {
  const result = await refreshSignalIndex({ sessionsRoot: args.sessionsRoot, cachePath: args.cachePath })
  if (!result.ok) {
    console.error(`重建失败：${result.error}`)
    process.exitCode = 1
  } else {
    const index = result.index
    console.log(`已写入 ${args.cachePath}`)
    console.log(`耗时 ${Date.now() - startedAt}ms`)
    console.log(`覆盖：会话 ${index.coverage.sessions} 个 / 主人消息 ${index.coverage.userMessages} 条`)
    console.log(`care ${index.signals.care.length} 条 / commitment ${index.signals.commitment.length} 条`)
  }
}
