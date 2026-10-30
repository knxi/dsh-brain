// @ts-check
/**
 * 服务配置：参数解析、路径解析、凭据生成。
 *
 * 安全纪律（CONTRACTS 第 12 节红线 + 第 4.1 节）：
 * - 凭据**绝不**能通过 URL / 命令行 / 环境变量以外的公开渠道传来传去；
 * - 命令行**不接受** `--token <明文>`（会进 shell 历史与进程列表），只接受 `--token-file`；
 * - 环境变量 `BRAIN_API_TOKEN` 仅供测试进程注入，不是日常用法；
 * - 默认启动即生成 32 字节不可预测凭据，写入权限 0600 的本机文件。
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根（`apps/server/src` → 上三级）。 */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 只绑回环地址。不是配置项——改成 0.0.0.0 的事这里不提供开关。 */
export const BIND_HOST = '127.0.0.1';

/** 控制台默认端口。端口不是安全边界（凭据才是），固定端口只是为了书签稳定。 */
export const DEFAULT_PORT = 7420;

/** 分页硬上限。任何请求都不能取超过这个数（防止一次拉穿主账）。 */
export const MAX_LIMIT = 200;

/** 分页默认条数。 */
export const DEFAULT_LIMIT = 50;

/** 请求体上限（手动写记忆不需要大 payload）。 */
export const MAX_BODY_BYTES = 64 * 1024;

/** 服务版本（与根 package.json 的 0.1.0 区分：这是 M2 可视化线）。 */
export const SERVER_VERSION = '0.2.0-m2';

/** 生成的凭据熵（字节）。base64url 编码后 43 字符。 */
export const TOKEN_BYTES = 32;

/** 生成不可预测凭据。`randomBytes` 是 CSPRNG，不是 Math.random。 */
export function generateToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

/**
 * 凭据强度检查：至少 32 字符，且不是明显占位符。
 * 允许测试注入固定值，但把弱凭据挡在启动路径外。
 * @param {string} token
 */
export function assertTokenShape(token) {
  if (typeof token !== 'string' || token.trim().length === 0) {
    throw new Error('凭据为空');
  }
  const value = token.trim();
  if (value.length < 32) {
    throw new Error(`凭据太短（${value.length} < 32），拒绝启动`);
  }
  if (/^(test|dev|changeme|password|token|secret)[-_]/i.test(value)) {
    throw new Error('凭据看起来是占位符，拒绝启动');
  }
  return value;
}

/**
 * @typedef {Object} ServerConfig
 * @property {string} dbPath 主账路径
 * @property {number} port 端口（0 = 系统分配）
 * @property {string} host 绑定地址（恒为 127.0.0.1）
 * @property {string} tokenFile 凭据落盘路径
 * @property {string} [token] 已解析的凭据（缺省时启动阶段生成）
 * @property {boolean} readOnlyDb 是否只读打开主账
 * @property {string} consoleDir 控制台静态目录
 * @property {string} logLevel
 * @property {string} backupDir 备份落地目录（M3）
 * @property {boolean} allowBackup 是否允许 POST /api/backups
 * @property {boolean} allowRestore 是否允许 POST /api/restore/execute 真执行
 * @property {number} hostPort 宿主 dsh web 的端口（/dsh-brain/* 反向代理目标，默认 3080）
 * @property {string} [restoredFrom] 本实例由哪个备份目录恢复而来
 * @property {string} [isolationReason] 显式声明的隔离原因（运维手工置位）
 * @property {string} stateDir 服务自身的运行状态目录（隔离标志、token）
 * @property {number} backupKeepDays 备份保留天数（算「旧备份最晚到期时间」用）
 */

/**
 * 解析命令行。
 *
 * @param {string[]} argv `process.argv.slice(2)`
 * @returns {Partial<ServerConfig> & { help?: boolean }}
 */
export function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  const known = new Set([
    'db', 'port', 'token-file', 'read-only', 'log-level', 'help',
    // M3：备份 / 恢复 / 隔离
    'backup-dir', 'allow-backup', 'allow-restore', 'restored-from', 'isolation-reason',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    if (!raw.startsWith('--')) throw new Error(`无法识别的参数：${raw}`);
    const eq = raw.indexOf('=');
    const name = (eq === -1 ? raw.slice(2) : raw.slice(2, eq)).trim();
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);
    if (!known.has(name)) {
      if (name === 'token') {
        throw new Error('不接受 --token（凭据会进 shell 历史与进程列表）；请用 --token-file 或让服务自动生成');
      }
      throw new Error(`未知参数：--${name}`);
    }
    if (name === 'help' || name === 'read-only' || name === 'allow-backup' || name === 'allow-restore') {
      out[name] = inlineValue === undefined ? true : inlineValue !== 'false';
      continue;
    }
    const value = inlineValue ?? argv[++i];
    if (value === undefined) throw new Error(`参数 --${name} 缺少值`);
    out[name] = value;
  }

  /** @type {Partial<ServerConfig> & { help?: boolean }} */
  const config = {};
  if (out.help === true) config.help = true;
  if (typeof out.db === 'string') config.dbPath = path.resolve(REPO_ROOT, out.db);
  if (typeof out.port === 'string') {
    const port = Number(out.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`--port 非法：${out.port}`);
    }
    config.port = port;
  }
  if (typeof out['token-file'] === 'string') config.tokenFile = path.resolve(REPO_ROOT, out['token-file']);
  if (typeof out['read-only'] === 'boolean') config.readOnlyDb = out['read-only'];
  if (typeof out['log-level'] === 'string') config.logLevel = out['log-level'];
  if (typeof out['backup-dir'] === 'string') config.backupDir = path.resolve(REPO_ROOT, out['backup-dir']);
  if (typeof out['allow-backup'] === 'boolean') config.allowBackup = out['allow-backup'];
  if (typeof out['allow-restore'] === 'boolean') config.allowRestore = out['allow-restore'];
  if (typeof out['restored-from'] === 'string') config.restoredFrom = path.resolve(REPO_ROOT, out['restored-from']);
  if (typeof out['isolation-reason'] === 'string') config.isolationReason = out['isolation-reason'];
  return config;
}

/**
 * 合并默认值。**不读 `--token`，不接受 URL 里的凭据。**
 *
 * @param {Partial<ServerConfig> & { help?: boolean }} [overrides]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {ServerConfig & { help?: boolean }}
 */
export function resolveConfig(overrides = {}, env = process.env) {
  const stateDir = overrides.stateDir ?? path.join(REPO_ROOT, 'data', 'server');
  const tokenFile = overrides.tokenFile ?? path.join(stateDir, 'console-token.txt');
  /** @type {ServerConfig} */
  const config = {
    dbPath: overrides.dbPath ?? path.join(REPO_ROOT, 'data', 'brain.db'),
    port: overrides.port ?? DEFAULT_PORT,
    host: BIND_HOST,
    tokenFile,
    readOnlyDb: overrides.readOnlyDb ?? false,
    consoleDir: overrides.consoleDir ?? path.join(REPO_ROOT, 'apps', 'console'),
    logLevel: overrides.logLevel ?? 'info',
    backupDir: overrides.backupDir ?? path.join(REPO_ROOT, 'data', 'backups'),
    // M3：写能力默认全关。备份要显式开，恢复真执行要另外再开——误触的代价不是重输，是主人的库。
    allowBackup: overrides.allowBackup ?? false,
    allowRestore: overrides.allowRestore ?? false,
    stateDir,
    backupKeepDays: overrides.backupKeepDays ?? 7,
    // 宿主 dsh web 的端口（2026-10-30）：治理面板要反向代理宿主的 /dsh-brain/*，
    // 这样「治理 + 记忆/心海/使用/矛盾/实体/心情」都收在 7420 一个端口上。
    // 拿不到宿主就是 502，不猜、不静默换源。
    hostPort: overrides.hostPort ?? (Number(env.BRAIN_HOST_PORT) || 3080),
  };
  if (overrides.restoredFrom !== undefined) config.restoredFrom = overrides.restoredFrom;
  if (overrides.isolationReason !== undefined) config.isolationReason = overrides.isolationReason;
  if (env.BRAIN_ALLOW_BACKUP === '1') config.allowBackup = true;
  if (env.BRAIN_ALLOW_RESTORE === '1') config.allowRestore = true;

  const explicit = overrides.token ?? env.BRAIN_API_TOKEN;
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    config.token = assertTokenShape(explicit);
    return config;
  }

  // 0. 已存在的凭据文件：复用（重启后书签里的页面不用重新加载也能用同一凭据）。
  try {
    const existing = readFileSync(tokenFile, 'utf8').trim();
    if (existing.length >= 32 && !/^(test|dev|changeme|password|token|secret)[-_]/i.test(existing)) {
      config.token = existing;
      return config;
    }
  } catch {
    /* 文件不存在：继续生成 */
  }

  const token = generateToken();
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  // mode 0600：仅本机当前用户可读。Windows 上 mode 部分生效，仍显著优于默认继承权限。
  writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 });
  config.token = token;
  return config;
}
