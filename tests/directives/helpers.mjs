// @ts-check
/**
 * 系统 5 测试的公共工具。
 *
 * 纪律（照 tests/m7 的模板）：
 * - 全部在 `mkdtemp` 下的临时主账里跑，**绝不碰 `data/brain.db`**；
 * - 期望值手算写死，不拿实现算出来的数当答案；
 * - 时钟可推进：租约 / 超时 / 过期这类断言必须确定性，不能靠 sleep 碰运气。
 *
 * 性能上的一个做法：迁移只在本进程跑一次，落成模板库，之后每个测试 `copyFileSync`
 * 一份。40+ 个测试因此各开一个干净库，但不用各跑一遍 13 个迁移。
 */

import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClock } from '../../packages/core/src/index.js';
import { openBrain } from '../../packages/memory/src/index.js';
import { createDirectives } from '../../packages/directives/src/index.js';

export { assert };

/** 仓库内 migrations 目录。 */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

/** 默认 scope（与主账 / workspace 的 MVP 绑定一致）。 */
export const SCOPE = 'owner-default';

/** 模板库路径（懒建，一个进程只建一次）。 */
let templatePath = null;

/**
 * 建一次迁移完成的模板库，然后到处复制。
 * @returns {string}
 */
function ensureTemplate() {
  if (templatePath !== null) return templatePath;
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m8-template-'));
  const dbPath = path.join(dir, 'brain.db');
  const brain = openBrain({
    dbPath,
    migrationsDir: MIGRATIONS_DIR,
    clock: createClock({ timeZone: 'Asia/Shanghai', now: () => new Date('2026-10-30T00:00:00.000Z') }),
  });
  try {
    // WAL 落到主文件：这样只复制一个 .db 文件就是完整库。
    brain.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch {
    /* 早退：不影响正确性（顶多让每个测试多跑一次迁移的慢路径） */
  }
  brain.db.close();
  process.on('exit', () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟释放 */
    }
  });
  templatePath = dbPath;
  return templatePath;
}

/**
 * 可推进的固定时钟。
 * @param {string} [startIso]
 */
export function fixedClock(startIso = '2026-10-30T08:00:00.000Z') {
  let current = Date.parse(startIso);
  const clock = createClock({ timeZone: 'Asia/Shanghai', now: () => new Date(current) });
  return {
    clock,
    advance(ms = 1000) {
      current += ms;
      return new Date(current).toISOString();
    },
    set(iso) {
      current = Date.parse(iso);
    },
    nowIso: () => new Date(current).toISOString(),
    nowMs: () => current,
  };
}

/**
 * 打开一个临时主账（跑完全部迁移），测试结束自动关闭并删目录。
 * @param {import('node:test').TestContext} t
 * @param {{ startIso?: string }} [opts]
 */
export function createBrain(t, opts = {}) {
  const template = ensureTemplate();
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-brain-m8-'));
  const dbPath = path.join(dir, 'brain.db');
  copyFileSync(template, dbPath);
  const fc = fixedClock(opts.startIso);
  const brain = openBrain({ dbPath, migrationsDir: MIGRATIONS_DIR, clock: fc.clock });
  let closed = false;
  t.after(async () => {
    if (!closed) {
      closed = true;
      try {
        await brain.close();
      } catch {
        /* 已关闭：不掩盖测试失败 */
      }
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟释放不影响断言 */
    }
  });
  return { brain, dir, dbPath, fc };
}

/**
 * 假工作空间：只实现系统 5 真正会调的那几个读口 + 候选列表。
 *
 * 刻意**不实现** `assertAllowed`：系统 5 用自己的闸门逻辑（`isPaused` / `isEnabled` /
 * `getSwitch`），这样"暂停优先"的顺序由本模块自己负责，不靠别人的实现细节。
 *
 * @param {{
 *   switches?: Record<string, string>,
 *   candidates?: Array<Record<string, any>>,
 *   scopeId?: string,
 *   failPublish?: boolean,
 * }} [opts]
 */
export function createFakeWorkspace(opts = {}) {
  /** @type {Map<string, string>} */
  const switches = new Map(
    Object.entries({
      'autonomy.enabled': '0',
      'autonomy.max_level': 'L1',
      paused: '0',
      ...(opts.switches ?? {}),
    }),
  );
  /** @type {Array<Record<string, any>>} */
  const published = [];
  /** @type {Array<Record<string, any>>} */
  const candidates = opts.candidates ?? [];
  const readCalls = { isPaused: 0, isEnabled: 0, getSwitch: 0, listCandidates: 0 };

  /** @param {unknown} value */
  const toBool = (value) => value !== undefined && value !== null && ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());

  return {
    scopeId: opts.scopeId ?? SCOPE,
    readOnly: false,
    published,
    readCalls,
    getSwitch(name) {
      readCalls.getSwitch += 1;
      return switches.has(String(name)) ? String(switches.get(String(name))) : null;
    },
    isEnabled(name) {
      readCalls.isEnabled += 1;
      const raw = switches.get(String(name));
      return raw === undefined ? false : toBool(raw);
    },
    isPaused() {
      readCalls.isPaused += 1;
      return toBool(switches.get('paused'));
    },
    setSwitch(name, value) {
      switches.set(String(name), String(value));
    },
    listCandidates(query = {}) {
      readCalls.listCandidates += 1;
      return candidates.filter(
        (item) =>
          (query.kind === undefined || item.kind === query.kind) &&
          (query.status === undefined || item.status === query.status) &&
          (query.limit === undefined || true),
      );
    },
    publish(event) {
      if (opts.failPublish === true) throw new Error('publish 故意失败');
      published.push(event);
      return { id: `wse_${published.length}`, at: '2026-10-30T08:00:00.000Z' };
    },
    /** 测试便捷：直接改开关。 */
    set(name, value) {
      switches.set(String(name), String(value));
    },
    get(name) {
      return switches.get(String(name)) ?? null;
    },
  };
}

/**
 * 记录所有 hook 调用的动作表。
 *
 * @param {Record<string, (ctx: any, calls: Array<any>) => any>} [impls]
 */
export function recordingHooks(impls = {}) {
  /** @type {Array<{ hook: string, ctx: any }>} */
  const calls = [];
  const hookKeys = ['memoryMaintenance', 'indexRebuild', 'alertSweep', 'backupVerify', 'reflectionRun', 'skillRebuild'];
  /** @type {Record<string, Function>} */
  const hooks = {};
  for (const key of hookKeys) {
    hooks[key] = async (ctx) => {
      calls.push({ hook: key, ctx });
      const impl = impls[key];
      return impl === undefined ? { ok: true, summary: `${key} 完成` } : impl(ctx, calls);
    };
  }
  return { hooks, calls };
}

/**
 * 组装一个系统 5 实例（默认已经接好假工作空间 + 记录型 hooks）。
 *
 * @param {import('node:test').TestContext} t
 * @param {{
 *   startIso?: string,
 *   workspace?: any,
 *   workspaceOptions?: Parameters<typeof createFakeWorkspace>[0],
 *   hooks?: Record<string, Function>,
 *   hookImpls?: Record<string, Function>,
 *   scopeId?: string,
 *   leaseMs?: number,
 *   alert?: (info: any) => void,
 * }} [opts]
 */
export function createSystem(t, opts = {}) {
  const { brain, fc, dir, dbPath } = createBrain(t, { startIso: opts.startIso });
  const workspace = opts.workspace ?? createFakeWorkspace(opts.workspaceOptions);
  const recorded = recordingHooks(opts.hookImpls);
  const hooks = opts.hooks ?? recorded.hooks;
  const alerts = [];
  const alert =
    opts.alert ??
    ((info) => {
      alerts.push(info);
    });
  const scopeId = opts.scopeId ?? SCOPE;
  const system = buildSystem({ brain, fc, workspace, hooks, scopeId, leaseMs: opts.leaseMs, alert });
  return { brain, fc, dir, dbPath, workspace, system, calls: recorded.calls, alerts };
}

/**
 * 在已有 brain 上再建一个实例（同一 db / queue / clock，不同 hooks / workspace）。
 * 双 owner 抢租约的测试需要它。
 *
 * @param {{
 *   brain: any,
 *   fc: any,
 *   workspace?: any,
 *   hooks?: Record<string, Function>,
 *   scopeId?: string,
 *   leaseMs?: number,
 *   alert?: (info: any) => void,
 * }} params
 */
export function buildSystem(params) {
  const scopeId = params.scopeId ?? SCOPE;
  // 注意 `Object.hasOwn`：`workspace: null` 是**有意义的输入**（= 不注入 workpace，
  // 用来测"没有工作空间就失败关"），不能被 `??` 当成"没传"而补一个假的。
  const workspace = Object.hasOwn(params, 'workspace') ? params.workspace : createFakeWorkspace();
  return createDirectives({
    db: params.brain.db,
    queue: params.brain.queue,
    clock: params.fc.clock,
    workspace,
    bindings: { scope_id: scopeId },
    hooks: params.hooks ?? {},
    leaseMs: params.leaseMs,
    alert: params.alert ?? (() => {}),
  });
}

/**
 * 统计某表行数。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 */
export function countRows(db, table) {
  const row = /** @type {{ n?: number }} */ (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get());
  return Number(row?.n ?? 0);
}

/**
 * 某审计动作的条数。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} action
 */
export function countAudit(db, action) {
  const row = /** @type {{ n?: number }} */ (
    db.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE action = ?').get(action)
  );
  return Number(row?.n ?? 0);
}

/**
 * 白盒：直接读数据库行（绕过门面，测"表里的真实状态"）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} table
 * @param {string} where
 * @param {any[]} [params]
 */
export function readRows(db, table, where = '1 = 1', params = []) {
  return /** @type {Array<Record<string, any>>} */ (db.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...params));
}

/**
 * 白盒：直接写数据库行（模拟"有人手工改坏了库"或"进程崩了"）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} sql
 * @param {any[]} [params]
 */
export function execRaw(db, sql, params = []) {
  return db.prepare(sql).run(...params);
}

/**
 * 等条件成立（用于"另一个 owner 正在跑"这类并发断言）。
 * @param {() => boolean} predicate
 * @param {{ timeoutMs?: number, label?: string }} [opts]
 */
export async function waitUntil(predicate, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 2000;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`waitUntil 超时：${opts.label ?? '条件始终不成立'}`);
}

/**
 * 一个"可以卡住"的钩子：给双 owner 测试用。
 * @returns {{ hook: (ctx: any) => Promise<any>, release: () => void, entered: Promise<void> }}
 */
export function createGateHook() {
  /** @type {() => void} */
  let release = () => {};
  /** @type {() => void} */
  let signalEntered = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const entered = new Promise((resolve) => {
    signalEntered = () => resolve(undefined);
  });
  return {
    async hook() {
      signalEntered();
      await gate;
      return { ok: true, summary: '门开了' };
    },
    release: () => release(),
    entered,
  };
}
