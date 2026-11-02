// @ts-check
/**
 * 权限矩阵 —— 系统 5 的底线。**先写这个，它决定其它一切能不能发生。**
 *
 * ## 一句话
 *
 * 这个模块唯一能执行的东西，是 `ACTION_TABLE` 里的六个内置动作（内部 hook）。
 * 除它之外的任何动作名——包括 `shell` / `exec` / `write_file` / `http_request` /
 * `send_message`——一律 `{ allowed: false, reason: 'action_not_in_whitelist' }`。
 *
 * ## 为什么刻意不做「任意命令执行」
 *
 * 因为一旦存在一条能把字符串变成子进程 / 文件写入 / 网络请求的路，那么
 * 「权限等级」就只是一个提示（prompt），而不是边界（boundary）：
 *
 * 1. **等级只能约束「谁被允许」，约束不了「允许之后干了什么」。**
 *    一个 L2 的动作如果可以是任意命令，那 L2 就等于 L3 等于 root。
 * 2. **可回滚是白名单的前提。** 本表里每个动作都写了 `rollback`：误做之后
 *    怎么回到原样。任意命令写不了这句话——它可能删掉别的东西。
 * 3. **审计才有意义。** 白名单动作的入参是本模块自己组装的（没有外部字符串
 *    拼进命令），审计里记的动作名就能唯一确定发生了什么。
 * 4. **模型会被说服，代码不会。** 提示注入能说服一个模型去调 `shell`，
 *    说服不了一条 `Object.hasOwn(ACTION_TABLE, name)` 判断。
 *
 * 所以「白名单外动作 = 不存在」不是功能缺失，是本系统的**安全定义**。
 * 要加动作，必须改这份代码 + 补测试 + 在 docs 里写清可回滚性，不能配置出来。
 *
 * ## 反扩权（第二条守门）
 *
 * `assertNoEscalation({ parent, child })` 保证子指令不能通过"生个孩子"拿到
 * 父指令没有的权限：等级不高于父、三项预算不超过父、动作集合不超出父集合。
 * 违规**抛错**而不是自动下调——自动下调会让越界意图静默通过。
 */

import { DirectivesArgumentError, PermissionEscalationError, assertArgument } from './errors.js';

/** 等级从低到高。数组顺序就是比较顺序（不靠字符串比较，'L10' 也不会排错）。 */
export const LEVEL_ORDER = Object.freeze(['L0', 'L1', 'L2', 'L3']);

/**
 * 四个等级。
 *
 * 关键设计：**等级提升不增加可用动作**。L3 并不是"更强的 L2"——它把同一批
 * 动作的有效期/次数放宽，动作集合与 L2 完全一致（见 ACTION_TABLE 中最高只到 L2）。
 * 这样"升到 L3"永远不会变成"能做更多危险的事"。
 */
export const LEVELS = Object.freeze({
  L0: Object.freeze({
    level: 'L0',
    rank: 0,
    label: '只回复',
    allows: Object.freeze(['reply']),
    canExecuteAnyBuiltin: false,
    why: '只允许产出回复文本。回复是唯一没有外部副作用的输出：不落业务表、不动文件、不发消息。本级没有可执行的内置动作，所以 L0 指令进调度器会被立刻停下（这是刻意的，不是漏洞）。',
  }),
  L1: Object.freeze({
    level: 'L1',
    rank: 1,
    label: '只读检索 + 内部记忆维护',
    allows: Object.freeze(['read_search', 'memory_maintenance', 'index_rebuild', 'alert_sweep', 'backup_verify']),
    canExecuteAnyBuiltin: true,
    why: '只碰"大脑自己的索引与体检"：读、重建索引、归并告警、校验备份。全部只读或可重算，最坏结果是检索短暂变差，重跑一次就恢复。',
  }),
  L2: Object.freeze({
    level: 'L2',
    rank: 2,
    label: '白名单可逆本地任务',
    allows: Object.freeze(['reflection_run', 'skill_rebuild']),
    canExecuteAnyBuiltin: true,
    why: '在本机跑一次会**产生新推断数据**的作业（反思候选、技能置信度）。它们写的是候选与统计，不是事实与正文，而且可以整批丢弃，所以是"可逆"的本地任务。',
  }),
  L3: Object.freeze({
    level: 'L3',
    rank: 3,
    label: '已授权长期指令',
    allows: Object.freeze([]),
    canExecuteAnyBuiltin: true,
    why: '只放宽"有效期与重复次数"，**不新增任何动作**（allows 特意为空）。否则 L3 就等于一张空白支票。',
  }),
});

/** 默认最高等级：契约 §6，只读 + 内部记忆维护。改这里等于改默认安全姿态，需要主人明确同意。 */
export const DEFAULT_MAX_LEVEL = 'L1';

/**
 * 内置动作白名单 —— 这是本系统**唯一**能执行的动作集合。
 *
 * 每条都写清楚四件事：
 * - `minLevel`：为什么是这个等级（一句）；
 * - `hook`：注入的函数名。**没有注入 = 不执行**（`hook_missing`，绝不假装成功）；
 * - `reversible`：误做之后怎么回退（本表全部 `true`，不可逆的动作不许进这张表）；
 * - `writes`：它到底会写哪些表（审计用，也方便事后核对）。
 */
export const ACTION_TABLE = Object.freeze({
  memory_maintenance: Object.freeze({
    name: 'memory_maintenance',
    minLevel: 'L1',
    hook: 'memoryMaintenance',
    reversible: true,
    rollback: '重跑索引重建即可回到一致状态（整理只改派生字段，不动正文）',
    writes: Object.freeze(['memories 的摘要/元数据派生字段', '检索索引']),
    why: '整理既有记忆的索引与摘要，不新增、不删除记忆正文；误做最多让检索短暂变差，重算就回来。所以 L1。',
  }),
  index_rebuild: Object.freeze({
    name: 'index_rebuild',
    minLevel: 'L1',
    hook: 'indexRebuild',
    reversible: true,
    rollback: '再跑一次重建（输出完全由记忆正文决定，幂等）',
    writes: Object.freeze(['search_fts_char', 'search_fts_trigram', 'search_ngram']),
    why: '从记忆正文重建检索索引：输出完全由输入决定、可反复重跑、不产生任何新事实。所以 L1。',
  }),
  alert_sweep: Object.freeze({
    name: 'alert_sweep',
    minLevel: 'L1',
    hook: 'alertSweep',
    reversible: true,
    rollback: '告警是只增的观测数据，归并不删行（只改 status）；不需要回退',
    writes: Object.freeze(['health_alerts（按去重口径归并）']),
    why: '只读扫描健康告警并按去重口径归并，不碰任何业务数据。所以 L1。',
  }),
  backup_verify: Object.freeze({
    name: 'backup_verify',
    minLevel: 'L1',
    hook: 'backupVerify',
    reversible: true,
    rollback: '校验是只读的，没有可回退的副作用',
    writes: Object.freeze([]),
    why: '校验最近备份能否打开、关键表是否齐全：纯只读。能在 L1 是因为它唯一的效果是"知道有没有问题"。',
  }),
  reflection_run: Object.freeze({
    name: 'reflection_run',
    minLevel: 'L2',
    hook: 'reflectionRun',
    reversible: true,
    rollback: '产出落在 reflections(status=candidate)，可整体 dismissed；不会写进 memories',
    writes: Object.freeze(['reflection_runs', 'reflections（status=candidate）']),
    why: '会产出新的推断数据（反思候选）。推断不算事实、可整批丢弃，但它比"重算索引"更靠前一步，所以放 L2。',
  }),
  skill_rebuild: Object.freeze({
    name: 'skill_rebuild',
    minLevel: 'L2',
    hook: 'skillRebuild',
    reversible: true,
    rollback: '按历史执行结果重算即可复现（是重算，不是改写步骤内容）',
    writes: Object.freeze(['skill_stats', 'skill_lessons']),
    why: '按真实执行结果重算技能置信度：改的是统计结论而不是动作步骤，可从历史复现。所以 L2。',
  }),
});

/** 可被调度器执行的动作名（= 白名单全集）。顺序即建议执行顺序。 */
export const EXECUTABLE_ACTION_NAMES = Object.freeze(Object.keys(ACTION_TABLE));

/**
 * 动作名 → 危险类别。**只用于把拒绝理由说得更清楚，不参与放行判断**：
 * 不在白名单的动作无论属于哪一类，结果都是 `action_not_in_whitelist`。
 */
const HAZARD_TABLE = Object.freeze({
  arbitrary_command_execution: Object.freeze([
    'shell', 'exec', 'spawn', 'command', 'run_command', 'run', 'bash', 'sh', 'powershell', 'cmd',
    'system', 'terminal', 'script', 'eval', 'node', 'python', 'code_interpreter',
  ]),
  filesystem_write: Object.freeze([
    'write_file', 'file_write', 'append_file', 'delete_file', 'file_delete', 'remove', 'unlink',
    'rm', 'mv', 'move', 'copy', 'fs_write', 'mkdir', 'chmod', 'truncate',
  ]),
  network_egress: Object.freeze([
    'http_request', 'fetch', 'curl', 'wget', 'upload', 'browser', 'navigate', 'web_fetch', 'scrape',
  ]),
  external_message: Object.freeze([
    'send_message', 'send_mail', 'email', 'social_send', 'im_send', 'post', 'publish', 'notify',
  ]),
  install_or_privilege: Object.freeze([
    'install', 'pnpm_install', 'npm_install', 'pip_install', 'sudo', 'set_switch', 'edit_config',
    'write_config', 'autonomy_enable', 'grant_permission',
  ]),
});

/**
 * 动作名的危险归类。
 * @param {string} action
 * @returns {{ hazard: string, known: boolean }}
 */
export function classifyAction(action) {
  const needle = String(action ?? '').trim().toLowerCase();
  for (const [hazard, names] of Object.entries(HAZARD_TABLE)) {
    if (names.includes(needle)) return { hazard, known: true };
  }
  return { hazard: 'unclassified', known: false };
}

/**
 * 等级的整数序（用于比较）。
 * @param {unknown} level
 * @returns {number} 未知等级返回 -1（比较时天然最低，不会意外通过）
 */
export function levelRank(level) {
  const index = LEVEL_ORDER.indexOf(String(level ?? '').toUpperCase());
  return index;
}

/**
 * 两级取低：`minLevel('L2','L1') === 'L1'`。任一未知 → 返回 L0（失败关）。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {string}
 */
export function minLevel(a, b) {
  const ra = levelRank(a);
  const rb = levelRank(b);
  if (ra < 0 || rb < 0) return 'L0';
  return ra <= rb ? LEVEL_ORDER[ra] : LEVEL_ORDER[rb];
}

/**
 * 开关给出的最高等级与指令自报等级的**有效等级**：取低。
 *
 * 注意两者的语义不对称：`maxLevel` 是"主人允许到哪一级"（全局开关，随时可收紧），
 * `requested` 是"这条指令自称需要哪一级"（创建时写死）。有效等级永远是两者更低的那个，
 * 所以把 `autonomy.max_level` 从 L3 调到 L1，所有 L2/L3 指令立刻跑不动——不需要改指令本身。
 *
 * @param {unknown} requested
 * @param {unknown} maxLevel
 * @returns {string}
 */
export function effectiveLevel(requested, maxLevel) {
  return minLevel(requested, maxLevel);
}

/**
 * 判定一个动作在给定等级 / 给定动作声明下能不能执行。
 *
 * 判定顺序（顺序本身就是纪律）：
 * 1. 等级合法？否则 `invalid_level`
 * 2. 动作名合法？否则 `invalid_action`
 * 3. **在白名单里吗？否则 `action_not_in_whitelist`**（任意命令在这里被挡）
 * 4. 指令声明了这个动作吗？否则 `action_not_declared_by_directive`
 * 5. 等级够吗？否则 `level_too_low`
 *
 * @param {{
 *   level?: unknown,
 *   action?: unknown,
 *   allowedTools?: unknown,
 * }} input
 * @returns {{ allowed: boolean, reason: string, action?: string, level?: string, required?: string, hazard?: string }}
 */
export function canExecute(input = {}) {
  const level = typeof input.level === 'string' ? input.level.toUpperCase() : '';
  const action = typeof input.action === 'string' ? input.action.trim() : '';

  if (levelRank(level) < 0) {
    return { allowed: false, reason: 'invalid_level', level: String(input.level ?? '') };
  }
  if (action.length === 0) {
    return { allowed: false, reason: 'invalid_action', level };
  }
  // 白名单判定必须在"指令声明"之前：一个指令把自己的动作写成 `shell`，
  // 也不能因为"它确实声明了"而拿到更细的理由（比如 action_not_declared）。
  const entry = /** @type {Record<string, any> | undefined} */ (ACTION_TABLE[action]);
  if (entry === undefined) {
    return { allowed: false, reason: 'action_not_in_whitelist', action, level, hazard: classifyAction(action).hazard };
  }
  if (input.allowedTools !== undefined && input.allowedTools !== null) {
    if (!Array.isArray(input.allowedTools)) {
      return { allowed: false, reason: 'invalid_allowed_tools', action, level };
    }
    if (!input.allowedTools.map(String).includes(action)) {
      return { allowed: false, reason: 'action_not_declared_by_directive', action, level };
    }
  }
  if (levelRank(level) < levelRank(entry.minLevel)) {
    return { allowed: false, reason: 'level_too_low', action, level, required: entry.minLevel };
  }
  return { allowed: true, reason: 'ok', action, level, required: entry.minLevel };
}

/**
 * 校验一条指令声明的动作集合。
 *
 * 两条硬约束：
 * 1. 每个动作都必须在白名单里（否则连"声明"都不允许——声明了就会有人去实现它）；
 * 2. 每个动作的最低等级都必须 ≤ 指令自报的 `permissionScope`
 *    （否则会出现"L1 指令声明了一个 L2 动作"这种自相矛盾，执行期才炸太晚了）。
 *
 * 注意：`allowedTools` 在本系统里的用途是**指令的动作白名单**（迁移 0008 的列名是
 * `allowed_tools_json`，字段名已固定、不能加列）。也就是说"允许这个指令用的能力"
 * 与"允许这个指令做的动作"在这套系统里是同一个集合——这正好让权限收口只有一处。
 *
 * @param {unknown} allowedTools
 * @param {{ level: string }} opts
 * @returns {string[]} 去重后的动作名（保持声明顺序 = 执行顺序）
 */
export function assertAllowedTools(allowedTools, opts) {
  const level = String(opts.level);
  if (allowedTools === undefined || allowedTools === null) return [];
  assertArgument(Array.isArray(allowedTools), 'allowedTools 必须是数组', {
    reason: 'invalid_allowed_tools',
    field: 'allowedTools',
  });
  /** @type {string[]} */
  const out = [];
  for (const raw of allowedTools) {
    assertArgument(typeof raw === 'string' && raw.trim().length > 0, 'allowedTools 的每一项都必须是非空字符串', {
      reason: 'invalid_allowed_tools',
      field: 'allowedTools',
    });
    const name = raw.trim();
    const entry = /** @type {Record<string, any> | undefined} */ (ACTION_TABLE[name]);
    if (entry === undefined) {
      // 这一条就是"任意命令执行被拒"的创建侧：`shell` / `write_file` … 到不了数据库。
      throw new DirectivesArgumentError(`动作「${name}」不在内置白名单里，拒绝创建指令`, {
        reason: 'action_not_in_whitelist',
        field: 'allowedTools',
        action: name,
        hazard: classifyAction(name).hazard,
        whitelist: [...EXECUTABLE_ACTION_NAMES],
      });
    }
    if (levelRank(level) < levelRank(entry.minLevel)) {
      throw new DirectivesArgumentError(
        `动作「${name}」需要 ${entry.minLevel}，但指令声明的是 ${level}：拒绝自带越级动作的指令`,
        {
          reason: 'action_requires_higher_level',
          field: 'allowedTools',
          action: name,
          required: entry.minLevel,
          scope: level,
        },
      );
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * 把父/子两边的权限描述归一成可比较的形状。
 *
 * 同时吃 camelCase（API 入参）与 snake_case（数据库行）：调度器拿数据库行做父、
 * 拿 API 入参做子，两边名字不一样，归一化只放这一处。
 *
 * @param {Record<string, any> | null | undefined} spec
 * @returns {{ permissionScope: string | null, stepBudget: number | null, timeBudgetSeconds: number | null, tokenBudget: number | null, allowedTools: string[] | null }}
 */
export function normalizeScopeSpec(spec) {
  if (spec === null || spec === undefined) {
    return { permissionScope: null, stepBudget: null, timeBudgetSeconds: null, tokenBudget: null, allowedTools: null };
  }
  /** @param {...unknown} values */
  const pick = (...values) => values.find((value) => value !== undefined && value !== null);
  /** @param {unknown} value */
  const asNumber = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  };
  // 三种叫法都要认：API 入参（camelCase）、纯函数调用（snake_case）、
  // 数据库行（迁移里的列名是 `allowed_tools_json`）。
  const rawTools = pick(spec.allowedTools, spec.allowed_tools, spec.allowed_tools_json);
  let tools = null;
  if (rawTools !== null && rawTools !== undefined) {
    if (Array.isArray(rawTools)) {
      tools = rawTools.map((item) => String(item));
    } else if (typeof rawTools === 'string') {
      // 数据库列是 JSON 文本。坏 JSON 当"没声明动作"（失败关），不抛——
      // 反扩权检查读的是历史数据，一条坏行不该让整次校验 500。
      try {
        const parsed = JSON.parse(rawTools === '' ? '[]' : rawTools);
        tools = Array.isArray(parsed) ? parsed.map((item) => String(item)) : null;
      } catch {
        tools = null;
      }
    }
  }
  const scopeRaw = pick(spec.permissionScope, spec.permission_scope);
  return {
    permissionScope: scopeRaw === undefined || scopeRaw === null ? null : String(scopeRaw).toUpperCase(),
    stepBudget: asNumber(pick(spec.stepBudget, spec.step_budget)),
    timeBudgetSeconds: asNumber(pick(spec.timeBudgetSeconds, spec.time_budget_seconds)),
    tokenBudget: asNumber(pick(spec.tokenBudget, spec.token_budget)),
    allowedTools: tools,
  };
}

/**
 * 反扩权：子指令的权限范围 / 预算 / 动作集合都不得超出父指令。
 *
 * 四个维度逐项检查，任一超出即抛 `PermissionEscalationError`（带 `kind` 指明是哪一维）。
 *
 * **失败关的细节**：某一维度只在"父声明了"时才比较。生产路径上父永远是数据库行，
 * 三项预算都有值（schema 有默认值），所以生产上四维全都查；纯函数调用可以只传关心的
 * 那一维，不会被"没传"误判成"无上限"。
 *
 * @param {{ parent?: Record<string, any> | null, child?: Record<string, any> | null }} input
 * @returns {{ ok: true, checks: string[] }}
 */
export function assertNoEscalation(input = {}) {
  const parent = input.parent ?? null;
  const child = input.child ?? null;
  /** @type {string[]} */
  const checks = [];
  // 没有父 = 根指令。根指令的权限来自主人的创建动作本身（人批过），不需要反扩权。
  if (parent === null || parent === undefined) return { ok: true, checks: ['root'] };
  const p = normalizeScopeSpec(parent);
  const c = normalizeScopeSpec(child);
  checks.push('scope', 'budgets', 'tools');

  if (p.permissionScope !== null && c.permissionScope !== null) {
    if (levelRank(c.permissionScope) > levelRank(p.permissionScope)) {
      throw new PermissionEscalationError(
        `子指令权限等级 ${c.permissionScope} 高于父指令 ${p.permissionScope}：拒绝扩权`,
        { kind: 'permission_scope', field: 'permissionScope', parent: p.permissionScope, child: c.permissionScope },
      );
    }
  } else if (p.permissionScope === null && c.permissionScope !== null && levelRank(c.permissionScope) > 0) {
    // 父没写等级 → 不能证明子没扩权。失败关：除了 L0 一律拒。
    throw new PermissionEscalationError('父指令没有声明权限等级，无法证明子指令没有扩权：拒绝', {
      kind: 'permission_scope',
      field: 'permissionScope',
      parent: null,
      child: c.permissionScope,
    });
  }

  /** @type {Array<[ 'step_budget' | 'time_budget' | 'token_budget', string, number | null, number | null ]>} */
  const budgetPairs = [
    ['step_budget', 'stepBudget', p.stepBudget, c.stepBudget],
    ['time_budget', 'timeBudgetSeconds', p.timeBudgetSeconds, c.timeBudgetSeconds],
    ['token_budget', 'tokenBudget', p.tokenBudget, c.tokenBudget],
  ];
  for (const [kind, field, parentValue, childValue] of budgetPairs) {
    if (parentValue === null || childValue === null) continue;
    if (childValue > parentValue) {
      throw new PermissionEscalationError(
        `子指令的 ${field}（${childValue}）超过父指令（${parentValue}）：拒绝扩权`,
        { kind, field, parent: parentValue, child: childValue },
      );
    }
  }

  if (p.allowedTools !== null && c.allowedTools !== null) {
    const extra = c.allowedTools.filter((tool) => !p.allowedTools.includes(tool));
    if (extra.length > 0) {
      throw new PermissionEscalationError(
        `子指令声明了父指令没有的动作：${extra.join(', ')}`,
        { kind: 'allowed_tools', field: 'allowedTools', parent: p.allowedTools, child: c.allowedTools, extraTools: extra },
      );
    }
  } else if (p.allowedTools === null && c.allowedTools !== null && c.allowedTools.length > 0) {
    throw new PermissionEscalationError('父指令没有声明任何动作，子指令却声明了动作：拒绝扩权', {
      kind: 'allowed_tools',
      field: 'allowedTools',
      parent: null,
      child: c.allowedTools,
      extraTools: c.allowedTools,
    });
  }

  return { ok: true, checks };
}

/**
 * 给 UI / dry-run 用的权限矩阵快照（纯数据，不含函数）。
 * @returns {{ levels: Array<Record<string, unknown>>, actions: Array<Record<string, unknown>>, maxLevelDefault: string }}
 */
export function describePermissionMatrix() {
  return {
    maxLevelDefault: DEFAULT_MAX_LEVEL,
    levels: LEVEL_ORDER.map((level) => ({
      level,
      rank: LEVELS[level].rank,
      label: LEVELS[level].label,
      allows: [...LEVELS[level].allows],
      why: LEVELS[level].why,
    })),
    actions: EXECUTABLE_ACTION_NAMES.map((name) => ({
      name,
      minLevel: ACTION_TABLE[name].minLevel,
      hook: ACTION_TABLE[name].hook,
      reversible: ACTION_TABLE[name].reversible,
      rollback: ACTION_TABLE[name].rollback,
      why: ACTION_TABLE[name].why,
    })),
  };
}
