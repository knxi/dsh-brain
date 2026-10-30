#!/usr/bin/env node
// @ts-check
/**
 * CLI 入口：`node apps/server/index.mjs`（或 `pnpm serve`）。
 *
 * 启动行为：
 * - 只绑 127.0.0.1；
 * - 未提供凭据时，**生成**一个 32 字节 CSPRNG 凭据并写入 0600 文件；
 * - stdout 只打印地址与凭据文件路径，**不打印凭据本身**（红线：凭据不进日志）。
 */

import { parseArgs, resolveConfig, DEFAULT_PORT, REPO_ROOT } from './src/config.mjs';
import { startServer } from './src/server.mjs';

const HELP = `DSH 外置大脑 —— 本地服务与控制台

用法：
  node apps/server/index.mjs [选项]

选项：
  --db <path>          主账路径（默认 data/brain.db）
  --port <n>           端口（默认 ${DEFAULT_PORT}；0 = 由系统分配）
  --token-file <path>  凭据文件（默认 data/server/console-token.txt）
  --read-only          只读打开主账（拒绝 POST / DELETE）
  --log-level <level>  debug | info | warn | error | silent
  --help               显示本帮助

安全：
  * 只监听 127.0.0.1，不提供改成 0.0.0.0 的开关
  * 不接受 --token（凭据会进 shell 历史与进程列表）
  * 凭据只走 Authorization: Bearer 头，不接受 URL 里的 ?token=
  * 凭据不打印、不进日志；页面通过 <meta> 拿到它

未说明时，服务自己生成不可预测凭据并写入 --token-file。
`;

async function main() {
  /** @type {ReturnType<typeof parseArgs>} */
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`参数错误：${/** @type {Error} */ (err).message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }

  if (args.help === true) {
    process.stdout.write(HELP);
    return;
  }

  const config = resolveConfig(args);
  const running = await startServer(config);
  const tokenFile = config.tokenFile.startsWith(REPO_ROOT)
    ? config.tokenFile.slice(REPO_ROOT.length)
    : config.tokenFile;

  const health = running.store.health();
  const degraded = health.degraded.map((d) => d.code);

  process.stdout.write(
    [
      '',
      '  🧠  DSH 外置大脑 · 本地控制台',
      '',
      `     地址      ${running.url}`,
      `     凭据文件  ${tokenFile}（0600，仅本机可读）`,
      `     主账      ${health.db.fileName}  schema v${health.db.schemaVersion}`,
      `     写入      ${health.store.writer}`,
      `     检索      ${health.store.search}`,
      health.degraded.length > 0 ? `     降级      ${degraded.join(', ')}` : '     降级      无',
      '',
      '     页面里已经内嵌凭据，直接打开地址即可；凭据不写进 URL。',
      '',
    ].join('\n'),
  );

  /** 优雅退出：先停止接受连接，再排空写队列。 */
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      process.stdout.write('\n  正在停止…\n');
      running
        .close()
        .then(() => process.exit(0))
        .catch((err) => {
          process.stderr.write(`停止时出错：${/** @type {Error} */ (err).message}\n`);
          process.exit(1);
        });
    });
  }
}

main().catch((err) => {
  process.stderr.write(`启动失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
