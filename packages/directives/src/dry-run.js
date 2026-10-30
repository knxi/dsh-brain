// @ts-check
/**
 * dry-run：**只看不做**的一份预演报告。
 *
 * 主人最常问的两个问题是：
 * 1. 「现在要不要开自主？」——需要看到**排队里有什么、会被怎么执行**；
 * 2. 「它会不会乱来？」——需要看到**哪一步会被权限拦住**。
 *
 * 这个文件就是把这两件事打印出来，并且保证三个"不"：
 * - **不写库**：注入的 queue 是一个"写入即抛错"的拒绝器，任何一步想写都会当场炸；
 * - **不改开关**：只读 `brain_switches`，绝不调 `setSwitch`；
 * - **不执行动作**：只调 `scheduler.plan()`（只读）与 `autonomy.previewCandidates()`（只读）。
 *
 * 命令行：
 * ```
 * node packages/directives/src/dry-run.js                     # 读 data/brain.db
 * node packages/directives/src/dry-run.js --db <path> --scope owner-default --limit 10
 * node packages/directives/src/dry-run.js --json              # 机器可读
 * node packages/directives/src/dry-run.js --hooks memoryMaintenance,indexRebuild
 * ```
 *
 * `--hooks` 是"假装这些 hook 已接线"，用来回答"如果接线了，哪一步就通了"。
 */

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createDirectives } from './index.js';
import { createSimpleTxApi } from './util.js';
import { DEFAULT_MAX_LEVEL } from './permissions.js';

/** 布尔开关的真值集合（与 workspace 包同口径：不确定就是不允许）。 */
const TRUE_VALUES = Object.freeze(['1', 'true', 'on', 'yes']);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function toBool(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return TRUE_VALUES.includes(String(value).trim().toLowerCase());
}

/**
 * 造一个**只读**的 workspace 适配器（只在 dry-run 里用）。
 *
 * 生产必须用 lead 的 `packages/workspace`；这里另做一个只读版的原因很具体：
 * dry-run 要能在「工作空间包没装 / 服务没起」的情况下跑起来，否则主人想看一眼
 * 队列就得先起一套完整依赖。
 *
 * @param {{ db: import('node:sqlite').DatabaseSync, scopeId?: string, candidates?: Array<Record<string, any>> }} options
 */
export function createReadOnlyWorkspace(options) {
  const db = options.db;
  const scopeId = options.scopeId ?? 'owner-default';
  const reader = createSimpleTxApi(db);
  const injectedCandidates = options.candidates ?? null;

  /** @param {string} name */
  function getSwitch(name) {
    try {
      const row = reader.get('SELECT value FROM brain_switches WHERE name = ?', [String(name)]);
      return row === undefined ? null : String(row.value);
    } catch {
      return null;
    }
  }

  return {
    scopeId,
    readOnly: true,
    getSwitch,
    isEnabled: (/** @type {string} */ name) => {
      const raw = getSwitch(name);
      return raw === null ? false : toBool(raw);
    },
    isPaused: () => {
      const raw = getSwitch('paused');
      return raw === null ? false : toBool(raw);
    },
    /** 只读候选列表（读 ws_candidates，不改状态）。 */
    listCandidates: (/** @type {{ kind?: string, status?: string, limit?: number }} */ query = {}) => {
      if (Array.isArray(injectedCandidates)) {
        return injectedCandidates.filter(
          (item) =>
            (query.kind === undefined || item.kind === query.kind) &&
            (query.status === undefined || item.status === query.status),
        );
      }
      try {
        const where = ['scope_id = ?'];
        const args = [scopeId];
        if (query.kind !== undefined) {
          where.push('kind = ?');
          args.push(String(query.kind));
        }
        if (query.status !== undefined) {
          where.push('status = ?');
          args.push(String(query.status));
        }
        const limit = Math.max(1, Math.min(100, Number(query.limit) || 20));
        args.push(limit);
        const rows = reader.all(
          `SELECT * FROM ws_candidates WHERE ${where.join(' AND ')}
            ORDER BY priority DESC, score DESC, created_at ASC LIMIT ?`,
          args,
        );
        return rows.map((row) => {
          /** @type {Record<string, any>} */
          let payload = {};
          try {
            payload = JSON.parse(String(row.payload_json ?? '{}')) ?? {};
          } catch {
            payload = {};
          }
          return {
            id: String(row.id),
            scopeId: String(row.scope_id),
            kind: String(row.kind),
            originModule: String(row.origin_module),
            title: String(row.title),
            payload,
            score: Number(row.score ?? 0),
            priority: Number(row.priority ?? 0),
            status: String(row.status),
            reason: row.reason === null || row.reason === undefined ? null : String(row.reason),
            expiresAt: row.expires_at === null || row.expires_at === undefined ? null : String(row.expires_at),
          };
        });
      } catch {
        // 表不存在（迁移没跑）→ 没有候选。dry-run 不该因此崩掉。
        return [];
      }
    },
    /** dry-run 不发事件（发了就是写）。 */
    publish: () => null,
    getFocus: () => null,
  };
}

/**
 * 造一个"写入即抛错"的队列：它是 dry-run 零写入的**执行级保证**。
 *
 * @param {() => void} onWrite
 */
function createRefusingQueue(onWrite) {
  return {
    /** @type {<T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T>} */
    write: () => {
      onWrite();
      return Promise.reject(new Error('dry-run 禁止写入：所有写操作都必须等到真正开启自主之后'));
    },
  };
}

/**
 * 生成 dry-run 报告（纯只读）。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   clock: { stamp: () => { utc: string, local: string } },
 *   bindings?: { scope_id?: string },
 *   workspace?: Record<string, any> | null,
 *   hooks?: Record<string, Function> | null,
 *   hookSource?: 'injected' | 'cli-flags' | 'none',
 *   limit?: number,
 *   now?: any,
 * }} options
 * @returns {Record<string, any>}
 */
export function buildDryRunReport(options) {
  const { db, clock } = options;
  const bindings = { scope_id: options.bindings?.scope_id ?? 'owner-default', person_id: 'owner' };
  const workspace = options.workspace ?? createReadOnlyWorkspace({ db, scopeId: bindings.scope_id });
  /** @type {string[]} */
  const writeAttempts = [];
  const queue = createRefusingQueue(() => {
    writeAttempts.push(new Error('write attempted').stack ?? 'write');
  });

  const system = createDirectives({
    db,
    queue,
    clock,
    workspace,
    bindings,
    hooks: options.hooks ?? {},
  });

  const planned = system.scheduler.plan({ limit: options.limit ?? 10, now: options.now });
  const candidates = system.autonomy.previewCandidates({ limit: options.limit ?? 10 });

  /**
   * 开关原值（只读）。为什么要单独读一遍：闸门是**短路**的（暂停就先返回），
   * 所以 `gate.maxLevel` 在闸门拦下时是 null；而主人想看的是"开关此刻到底是什么值"。
   * @param {string} name
   */
  const readSwitch = (name) => {
    try {
      return typeof workspace.getSwitch === 'function' ? workspace.getSwitch(name) : null;
    } catch {
      return null;
    }
  };

  return {
    kind: 'directives.dry_run',
    at: planned.at,
    scopeId: bindings.scope_id,
    /** 写入尝试次数。恒为 0 才有意义——它不是"应该为 0"，是每次写都会被拒绝器抓住。 */
    writeAttempts: writeAttempts.length,
    gate: planned.gate,
    /** 三个关键开关的原值（null = 键不存在）。 */
    switches: {
      autonomyEnabled: readSwitch('autonomy.enabled'),
      maxLevel: readSwitch('autonomy.max_level'),
      paused: readSwitch('paused'),
    },
    counters: planned.counters,
    candidates,
    items: planned.items,
    rejected: planned.rejected,
    staleRuns: planned.staleRuns,
    hooks: planned.hooks,
    /**
     * hook 状态是从哪儿来的：
     * - `injected`：调用方传了真的 hooks（生产控制台走这条，可信）
     * - `cli-flags`：CLI 的 `--hooks` 声明（假设这些已接线）
     * - `none`：CLI 没声明——**本工具不知道宿主接没接**，所以显示"未接线"只是
     *   "我这个进程里没有 hook"，不等于宿主没接。
     */
    hookSource: options.hookSource ?? 'injected',
    leaseMs: planned.leaseMs,
    verdict: buildVerdict(planned, candidates),
  };
}

/**
 * 一句话结论：现在开自主，会发生什么。
 * @param {Record<string, any>} planned
 * @param {Record<string, any>} candidates
 */
function buildVerdict(planned, candidates) {
  if (!planned.gate.ok) {
    return {
      wouldRun: false,
      reason: planned.gate.reason,
      sentence: `现在开不了工：${gateSentence(planned.gate.reason)}`,
    };
  }
  const runnable = planned.items.filter((/** @type {any} */ item) => item.wouldRun === true);
  if (runnable.length === 0) {
    return {
      wouldRun: false,
      reason: planned.items.length === 0 ? 'nothing_queued' : 'all_blocked',
      sentence:
        planned.items.length === 0
          ? `开关都开着，但队列里没有可执行的指令（queued=${planned.queued}）`
          : `队列里有 ${planned.items.length} 条可执行指令，但每一条都会被挡住（见下方"会怎么被执行"）`,
    };
  }
  return {
    wouldRun: true,
    reason: 'ready',
    sentence: `开关都开着，队列里第一条会跑：${runnable[0].title}（先跑 ${runnable[0].executionPlan.filter((/** @type {any} */ s) => s.willRun).length} 个动作）`,
    candidateCount: candidates.convertible?.length ?? 0,
  };
}

/**
 * @param {string} reason
 * @returns {string}
 */
function gateSentence(reason) {
  switch (reason) {
    case 'global_paused':
      return '全局暂停（paused=1）';
    case 'autonomy_disabled':
      return '自主总开关没开（autonomy.enabled=0）。这是默认值';
    case 'max_level_too_low':
      return 'autonomy.max_level=L0：L0 只允许回复，没有任何可执行动作';
    case 'max_level_invalid':
      return 'autonomy.max_level 是个不认识的等级字符串（失败关，拒绝放行）';
    case 'workspace_missing':
      return '没有工作空间（拿不到开关），失败关拒绝放行';
    default:
      return reason;
  }
}

/**
 * 把报告渲染成主人看得懂的文本。
 * @param {Record<string, any>} report
 * @returns {string}
 */
export function renderDryRunReport(report) {
  /** @type {string[]} */
  const lines = [];
  const pad = (/** @type {string} */ text, /** @type {number} */ width) => {
    // 中文宽度按 2 算，简单对齐（不引第三方库）
    const visual = [...text].reduce((sum, char) => sum + (char.codePointAt(0) > 0xff ? 2 : 1), 0);
    return text + ' '.repeat(Math.max(0, width - visual));
  };

  lines.push('');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('  自主指令 dry-run（预演）—— 只看不做，一行都没写');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push(`  scope         ${report.scopeId}`);
  lines.push(`  时间点        ${report.at}`);
  lines.push(`  写入尝试次数  ${report.writeAttempts}  （写队列是拒绝器；不为 0 说明有 bug）`);
  lines.push('');

  // ── 1. 闸门 ──
  const gate = report.gate;
  const switches = report.switches ?? {};
  /** 布尔开关的人话（原值 null = 键不存在 → 按关处理）。 */
  const boolText = (/** @type {unknown} */ value) => {
    if (value === null || value === undefined) return '键不存在（按关处理）';
    return ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase()) ? `开（'${String(value)}'）` : `关（'${String(value)}'）`;
  };
  lines.push('── ① 全局闸门 ─────────────────────────────────────────────');
  lines.push(`  全局暂停      ${boolText(switches.paused)}`);
  lines.push(`  autonomy.enabled  ${boolText(switches.autonomyEnabled)}`);
  lines.push(
    `  autonomy.max_level ${switches.maxLevel ?? '（键不存在，按默认 L1）'}${gate.maxLevel === null || gate.maxLevel === undefined ? '' : `（闸门生效值 ${gate.maxLevel}）`}`,
  );
  lines.push(`  闸门结论      ${gate.ok ? '放行' : `拦下：${gate.reason}（${gateSentence(gate.reason)}）`}`);
  lines.push('');

  // ── 2. 队列 ──
  lines.push('── ② 指令队列（queued）────────────────────────────────────');
  const counters = report.counters ?? {};
  const statusOrder = ['proposed', 'awaiting_approval', 'queued', 'running', 'paused', 'blocked', 'completed', 'failed', 'cancelled'];
  lines.push(
    '  ' +
      statusOrder
        .map((status) => `${status}=${Number(counters[status] ?? 0)}`)
        .join('  '),
  );
  if (report.items.length === 0) {
    lines.push('  （没有满足条件的 queued 指令）');
  } else {
    report.items.forEach((/** @type {any} */ item, /** @type {number} */ index) => {
      lines.push('');
      lines.push(
        `  [${index + 1}] ${item.title}`,
      );
      lines.push(
        `      id=${item.id}  优先级=${item.priority}  等级=${item.permissionScope}（有效 ${item.effectiveLevel}）  ` +
          `预算=${item.budgets.step}步/${item.budgets.timeSeconds}秒/${item.budgets.token}tok  剩余=${item.remaining.steps}步/${item.remaining.tokens}tok`,
      );
      lines.push(`      ${item.wouldRun ? '会执行' : `不会执行 → ${item.blockers.join(' / ')}`}`);
      lines.push('      执行顺序：');
      lines.push(`        1. plan   记录本轮计划（不扣预算）`);
      for (const step of item.executionPlan) {
        const verdict = step.willRun ? '通过' : `拦下（${step.blockedReason}）`;
        lines.push(`        ${step.seq}. tool   ${pad(step.action, 22)} ${verdict}`);
      }
      lines.push(`        ${item.executionPlan.length + 2}. stop   写停止原因 + 迁移状态 + 审计`);
    });
  }
  if (report.rejected.length > 0) {
    lines.push('');
    lines.push('  被排除的 queued（有资格但过不了判定）：');
    for (const entry of report.rejected) {
      lines.push(`    - ${entry.title} → ${entry.reason}${entry.detail === null || entry.detail === undefined ? '' : `（${JSON.stringify(entry.detail)}）`}`);
    }
  }
  lines.push('');

  // ── 3. 候选 ──
  lines.push('── ③ 内部候选（会转成指令的）──────────────────────────────');
  const candidates = report.candidates ?? {};
  if (candidates.ok !== true) {
    lines.push(`  读不到候选：${candidates.reason}`);
  } else if ((candidates.convertible ?? []).length === 0) {
    lines.push('  （没有可转的 directive 候选）');
  } else {
    for (const entry of candidates.convertible) {
      lines.push(`  - ${entry.title}`);
      lines.push(
        `    候选 ${entry.candidateId} → 指令等级 ${entry.permissionScope}，转出后状态 ${entry.statusAfterDrain}（**必须人批**）`,
      );
      lines.push(`    动作 ${entry.allowedTools.length > 0 ? entry.allowedTools.join(', ') : '（无：转出来也跑不动）'}`);
      if (entry.droppedTools.length > 0) lines.push(`    丢弃的动作（超 L1）${entry.droppedTools.join(', ')}`);
      for (const note of entry.notes) lines.push(`    注：${note}`);
    }
  }
  lines.push('');

  // ── 4. 僵尸 run ──
  lines.push('── ④ 需要回收的僵尸 run（租约已过期）──────────────────────');
  if (report.staleRuns.length === 0) {
    lines.push('  （没有。说明没有进程在 running 中途死掉）');
  } else {
    for (const run of report.staleRuns) {
      lines.push(
        `  - run ${run.runId}（指令 ${run.directiveId}，第 ${run.attempt} 次，旧 owner=${run.leaseOwner}）→ 会被标 timeout，指令回 queued 或 blocked`,
      );
    }
  }
  lines.push('');

  // ── 5. hook 接线 ──
  lines.push('── ⑤ 动作接线状态 ─────────────────────────────────────────');
  if (report.hookSource === 'none') {
    lines.push('  注意：本工具不知道宿主实际接没接 hook（下面写的是"这个进程里有没有"）。');
    lines.push('        想把某几个当成已接线再看一遍，加参数：--hooks memoryMaintenance,indexRebuild');
  } else if (report.hookSource === 'cli-flags') {
    lines.push('  注意：下面按 --hooks 的声明当作已接线（这是假设，不是实测）。');
  }
  for (const hook of report.hooks) {
    const mark = hook.available ? '✔ 已接线' : '✖ 未接线（执行会停在 hook_missing）';
    lines.push(`  ${pad(hook.name, 20)} ${hook.level}  ${mark}`);
  }
  lines.push('');

  // ── 6. 结论 ──
  lines.push('── ⑥ 结论 ─────────────────────────────────────────────────');
  lines.push(`  ${report.verdict.sentence}`);
  lines.push('');
  lines.push('  这份报告没有写任何一行：不建指令、不改开关、不写流水、不发事件。');
  lines.push('  真开自主需要主人显式执行：');
  lines.push("    UPDATE brain_switches SET value='1' WHERE name='autonomy.enabled';   -- 或走 workspace.setSwitch");
  lines.push('  建议顺序：先看这份报告 → 确认队列里没有你不认识的指令 → 再开开关。');
  lines.push('══════════════════════════════════════════════════════════════');
  lines.push('');
  return lines.join('\n');
}

/**
 * CLI 主体（供 `node packages/directives/src/dry-run.js` 与测试调用）。
 *
 * @param {string[]} argv
 * @param {{ out?: (text: string) => void, err?: (text: string) => void, db?: import('node:sqlite').DatabaseSync | null, clock?: any }} [io]
 * @returns {{ exitCode: number, report: Record<string, any> | null, text: string }}
 */
export function runDryRunCli(argv, io = {}) {
  const out = io.out ?? ((text) => process.stdout.write(text));
  const err = io.err ?? ((text) => process.stderr.write(text));
  const args = Array.isArray(argv) ? argv.slice(2) : [];

  /** @type {Record<string, string | boolean>} */
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = true;
    }
  }

  const dbPath = typeof flags.db === 'string' ? flags.db : path.resolve('data', 'brain.db');
  if (!io.db && !existsSync(dbPath)) {
    err(`找不到主账：${dbPath}\n先跑一次迁移，或用 --db <path> 指定。\n`);
    return { exitCode: 2, report: null, text: '' };
  }

  let db = io.db ?? null;
  let borrowed = false;
  /** @type {string | null} */
  let openNote = null;
  if (db === null) {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      openNote = '只读连接（readOnly=true）';
    } catch (primaryErr) {
      try {
        db = new DatabaseSync(dbPath);
        borrowed = true;
        openNote =
          `只读打开失败（${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)}），` +
          '已改用普通连接；本工具不执行任何写语句（写队列是拒绝器）';
      } catch (err2) {
        err(`打不开主账：${dbPath}\n${err2 instanceof Error ? err2.message : String(err2)}\n`);
        return { exitCode: 2, report: null, text: '' };
      }
    }
  }

  const clock =
    io.clock ??
    (() => {
      const now = new Date();
      return {
        stamp: () => ({
          utc: now.toISOString(),
          local: formatLocal(now),
          time_zone: 'Asia/Shanghai',
          epoch_ms: now.getTime(),
        }),
        nowUtc: () => now.toISOString(),
        nowLocal: () => formatLocal(now),
        now: () => now,
      };
    })();

  // 迁移没跑时给一句人话，而不是让 SQL 报 "no such table" 甩一堆栈。
  try {
    const hasTable = db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'directives'").get();
    if (hasTable === undefined) {
      err(
        `这个主账还没有 0008 迁移（缺 directives 表）：${dbPath}\n` +
          '先跑一次迁移，再回来看这份预演：\n' +
          '  node packages/memory/bin/migrate.mjs\n',
      );
      return { exitCode: 3, report: null, text: '' };
    }
  } catch (probeErr) {
    err(`读不到库结构：${dbPath}\n${probeErr instanceof Error ? probeErr.message : String(probeErr)}\n`);
    return { exitCode: 2, report: null, text: '' };
  }

  try {
    const scopeId = typeof flags.scope === 'string' ? flags.scope : 'owner-default';
    const limit = typeof flags.limit === 'string' ? Number(flags.limit) : 10;
    /** @type {Record<string, Function>} */
    const hooks = {};
    const hookSource = typeof flags.hooks === 'string' ? 'cli-flags' : 'none';
    if (typeof flags.hooks === 'string') {
      for (const name of flags.hooks.split(',').map((item) => item.trim()).filter(Boolean)) {
        hooks[name] = async () => ({ ok: true, summary: `dry-run 假 hook：${name}` });
      }
    }
    const report = buildDryRunReport({
      db,
      clock,
      bindings: { scope_id: scopeId },
      workspace: createReadOnlyWorkspace({ db, scopeId }),
      hooks,
      hookSource,
      limit: Number.isFinite(limit) ? limit : 10,
    });

    if (flags.json === true) {
      const text = `${JSON.stringify(report, null, 2)}\n`;
      out(text);
      return { exitCode: 0, report, text };
    }
    const text = renderDryRunReport(report) + (openNote === null ? '' : `\n连接方式：${openNote}\n`);
    out(text);
    return { exitCode: 0, report, text };
  } finally {
    if (borrowed && db !== null && typeof db.close === 'function') {
      try {
        db.close();
      } catch {
        /* 关闭失败不影响已经打印出来的报告 */
      }
    }
  }
}

/**
 * Asia/Shanghai 的本地 ISO（不引 core 的 formatLocalIso：本包零依赖）。
 * @param {Date} date
 * @returns {string}
 */
function formatLocal(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const pad = (/** @type {number} */ value, /** @type {number} */ width = 2) => String(value).padStart(width, '0');
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${pad(shifted.getUTCFullYear(), 4)}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}` +
    `T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `.${pad(date.getUTCMilliseconds(), 3)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

// ── 直接执行时跑 CLI ──
const invokedPath = process.argv?.[1] === undefined ? '' : pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath !== '' && invokedPath === import.meta.url) {
  const result = runDryRunCli(process.argv, {});
  process.exitCode = result.exitCode;
}
