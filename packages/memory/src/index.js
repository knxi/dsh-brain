// @ts-check
/**
 * `@dsh-brain/memory` —— 单 SQLite 主账的唯一写入方（CONTRACTS 第 1 节）。
 *
 * 别的包不许自己建表、也不许拿连接直接写；一律走这里暴露的服务。
 * 读也尽量走这里（检索包只接受这里给的连接，但只能读）。
 */

import { createClock } from '@dsh-brain/core';
import { DEFAULT_PRAGMAS, closeDatabase, integrityCheck, isMemoryPath, openDatabase, readPragmas } from './db.js';
import { applyMigrations, defaultMigrationsDir, getCurrentVersion, listMigrations, rollbackLastMigration } from './migrator.js';
import { createWriteQueue, runInTransaction, safeRollback, toBindable } from './write-queue.js';
import { DEFAULT_PERSON_ID, DEFAULT_SCOPE_ID, DEFAULT_SOURCE_SYSTEM, PROJECT_EVENT_WORK_KIND, createMainLedger, } from './ledger.js';
import { createOutbox } from './outbox.js';
import { createConsumers } from './consumers.js';
import { createDeletionBarrier } from './deletion.js';
import { createDeletionLedger, defaultDeletionLedgerDir } from './deletion-ledger.js';
import { createDeletionWorker } from './deletion-worker.js';
import { createBackupService } from './backup.js';
import { META_KEYS, readDeletionEpoch, readMeta, readMetaInt } from './meta.js';
import { createMemories } from './memories.js';
import { createSearchBridge } from './search-bridge.js';
import { createSnapshots } from './snapshots.js';
import { createSources } from './sources.js';
import { createSummaries } from './summaries.js';
import { createContextPackages } from './context-packages.js';
import { createEntities, createMemoryEdges } from './entities.js';
import { createMood } from './mood.js';
import { createWorkspace } from '@dsh-brain/workspace';
import { createCognition } from '@dsh-brain/cognition';
import { createPersona } from '@dsh-brain/persona';
import { createDirectives } from '@dsh-brain/directives';

/** @typedef {import('./write-queue.js').TxApi} TxApi */

/**
 * @typedef {Object} OpenBrainOptions
 * @property {string} dbPath 主账路径（`data/brain.db`）
 * @property {string} [migrationsDir] 默认 `<repo>/migrations`
 * @property {string} [backupDir] 配置后启用备份服务
 * @property {string} [deletionLedgerDir] 独立删除账本目录；默认 `<dbPath 所在目录>/deletion-ledger/`
 * @property {string|null} [exportsDir] 导出落点（清理 worker 用）；默认 `<dbPath 所在目录>/exports/`
 * @property {string|null} [blobsDir] blob 落点（清理 worker 用）；默认 `<dbPath 所在目录>/blobs/`
 * @property {number} [backupRetentionDays] 旧备份保留天数（算「最晚到期时间」用），默认 7
 * @property {boolean} [readOnly] 只读打开（不跑迁移、不建队列写）
 * @property {Partial<typeof DEFAULT_PRAGMAS>} [pragmas]
 * @property {boolean} [requireWal]
 * @property {string} [timeZone] 默认 Asia/Shanghai
 * @property {{ source_system: string, scope_id: string, person_id: string }} [bindings]
 * @property {number} [maxPayloadBytes]
 * @property {(info: { kind: string, message: string, detail?: Record<string, unknown> }) => void} [alert]
 * @property {(info: { label: string, durationMs: number }) => void} [onSlowWrite]
 * @property {number} [slowWriteMs]
 * @property {ReturnType<typeof createClock>} [clock]
 * @property {((input: { channel: string, text: string, candidate: any }) => Promise<any>) | null} [outboundChannel]
 *   主动社交的真实外发通道。**默认不传** —— 不传时主动消息只进控制台（dry_run），永不外发。
 * @property {Record<string, Function> | null} [directiveHooks]
 *   自主指令的内置动作接线（memory_maintenance / reflection_run / index_rebuild …）。
 *   不传时动作返回 `{ ok:false, reason:'hook_missing' }`，不假装成功。
 */

/**
 * 打开主账（打开 → 迁移 → 队列 → 各服务）。
 *
 * 只读模式不跑迁移、也不写 meta；适合检查器。
 *
 * @param {OpenBrainOptions} options
 */
export function openBrain(options) {
  if (!options || typeof options.dbPath !== 'string') {
    throw new TypeError('openBrain 需要 dbPath');
  }
  const clock = options.clock ?? createClock({ timeZone: options.timeZone });
  const opened = openDatabase({
    path: options.dbPath,
    readOnly: options.readOnly,
    pragmas: options.pragmas,
    requireWal: options.requireWal,
  });
  const db = opened.db;
  const alert = options.alert ?? (() => {});

  /** @type {ReturnType<typeof applyMigrations>} */
  let migrations;
  if (options.readOnly === true) {
    // 只读实例不建表：直接读当前版本（没有迁移表说明这不是主账）。
    migrations = { applied: [], skipped: [], currentVersion: getCurrentVersion(db) };
  } else {
    migrations = applyMigrations(db, { dir: options.migrationsDir, clock });
  }

  const queue = createWriteQueue({
    db,
    slowWriteMs: options.slowWriteMs,
    onSlowWrite: options.onSlowWrite,
  });

  const ledger = createMainLedger({
    db,
    queue,
    clock,
    bindings: options.bindings,
    maxPayloadBytes: options.maxPayloadBytes,
    alert,
  });
  const outbox = createOutbox({ db, queue, clock, alert });
  const consumers = createConsumers({ db, queue, clock, alert });
  // M3 独立删除账本（M3-INTERFACES §1）：**默认就接线**，落点跟着主账目录走
  // （生产是 data/deletion-ledger/，测试指到 mkdtemp 里）。目录不可写时构造不抛，
  // 只降级为 available=false —— 大脑照常起来，但删除请求会明确失败（不许虚报删除成功）。
  const deletionLedger = createDeletionLedger({
    dir: options.deletionLedgerDir ?? defaultDeletionLedgerDir({ dbPath: options.dbPath }),
    clock,
    alert,
    readOnly: options.readOnly === true,
  });
  const deletion = createDeletionBarrier({ db, queue, clock, alert, ledger: deletionLedger });
  // M3 删除清理 worker（五步）与分层状态报告：只构造不自动跑（谁跑由宿主/CLI 决定）。
  const deletionWorker = createDeletionWorker({
    db,
    queue,
    clock,
    barrier: deletion,
    ledger: deletionLedger,
    dbPath: options.dbPath,
    exportsDir: options.exportsDir,
    blobsDir: options.blobsDir,
    backupRetentionDays: options.backupRetentionDays,
    alert,
  });
  const backup = options.backupDir
    ? createBackupService({ db, dbPath: options.dbPath, queue, clock, backupDir: options.backupDir, alert })
    : null;

  // M2 记忆层门面（M2-INTERFACES §1）。检索桥接是懒构造的：只读实例不开检索也不该
  // 因为索引表缺失而抛错（缺表时 search 会报 degraded: 'index_missing'）。
  const searchBridge = createSearchBridge({ db });
  // 绑定：OpenBrainOptions.bindings 缺省时回落到契约的 MVP 固定值
  // （CONTRACTS §2：scope_id/person_id 来自已认证连接器绑定，MVP 固定 owner）。
  // 校验代码仍然存在：draft 显式传的 scopeId/personId 一律过类型校验。
  const facadeBindings = {
    scope_id: options.bindings?.scope_id ?? DEFAULT_SCOPE_ID,
    person_id: options.bindings?.person_id ?? DEFAULT_PERSON_ID,
  };
  const facadeOptions = { db, queue, clock, alert, bindings: facadeBindings };
  const memories = createMemories({ ...facadeOptions, bridge: searchBridge });
  const sources = createSources(facadeOptions);
  const snapshots = createSnapshots(facadeOptions);
  const summaries = createSummaries(facadeOptions);
  const contextPackages = createContextPackages(facadeOptions);
  // M6 实体与关系：跟记忆层共用同一套 bindings，写也走同一个写队列——
  // 不允许另开写路径（CONTRACTS §1 单写方）。
  const entities = createEntities(facadeOptions);
  const memoryEdges = createMemoryEdges(facadeOptions);
  // M7.2 情感状态：与记忆层共用同一个 db / 写队列，但**刻意不吃 bindings**——
  // 这两张表不做 scope 收口（理由见 mood.js 文件头与 CONTRACTS §19）。
  const mood = createMood(facadeOptions);

  // M8 全局工作空间（系统 3 的通信面）：事件总线 / 候选仲裁 / 注意力 / 全局开关。
  // 它与 memories 共用同一个 db 与**同一个写队列**——「单写方」契约不允许另开写路径。
  // now 与 clock 对齐：事件有 at（ISO，走 clock.stamp）与 at_ms（毫秒，走 now）两列，
  // 如果 now 用真实时间而 clock 被测试固定住，两列会指向两个时刻，排序就乱了。
  const nowMs = () => {
    const value = clock.now?.();
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number') return value;
    return Date.now();
  };
  const workspace = createWorkspace({
    db,
    queue,
    clock,
    alert,
    bindings: facadeBindings,
    now: nowMs,
  });

  // M8 系统 3：类脑协同（显著性 / 空闲反思 / 技能校准 / 免疫隔离 / 健康告警）。
  // workspace 必须注入——它是唯一的开关闸门；模块自己 new 一个的话，开关就不再唯一。
  // memories 注入是为了「反思晋升」能走记忆门面（拿到三套索引与 source_refs）；
  // 不传也能跑，只是晋升后要 reindexAll() 才可检索。
  const cognition = createCognition({
    db,
    queue,
    clock,
    alert,
    workspace,
    bindings: facadeBindings,
    dbPath: options.dbPath,
    backupsDir: options.backupDir ?? null,
    memories,
  });

  // M8 系统 4：人格与主动社交。
  // `outboundChannel` 是**真实外发通道**，默认 null —— 意味着主动消息只会
  // 以 dry_run 进控制台，永远不会真发出去。这是刻意的最保守默认：
  // 「能主动说话」这件事必须先由主人显式配通道才会发生。
  const persona = createPersona({
    db,
    queue,
    clock,
    alert,
    workspace,
    bindings: facadeBindings,
    channel: typeof options.outboundChannel === 'function' ? options.outboundChannel : null,
  });

  // M8 系统 5：自主指令。
  // `directiveHooks` 是内置动作的接线（memory_maintenance / reflection_run 等）。
  // 不传时动作一律返回 `{ ok:false, reason:'hook_missing' }`，**绝不假装成功**。
  const directives = createDirectives({
    db,
    queue,
    clock,
    alert,
    workspace,
    bindings: facadeBindings,
    hooks: options.directiveHooks ?? null,
  });

  return {
    db,
    dbPath: opened.path,
    readOnly: opened.readOnly,
    clock,
    pragmas: opened.pragmas,
    schemaVersion: getCurrentVersion(db),
    migrations,
    queue,
    ledger,
    outbox,
    consumers,
    deletion,
    /** M3：独立删除账本（append/watermark/read/verify/checkForRestore）。 */
    deletionLedger,
    /** M3：删除清理 worker（runOnce/deletionStatus/listPending/ensureQueued）。 */
    deletionWorker,
    backup,
    /** M2：记忆条目（create/update/supersede/get/list/search/reindexAll）。 */
    memories,
    /** M2：记忆 → 原始来源（link/forMemory/verify）。 */
    sources,
    /** M2：任务快照（save/load，CAS）。 */
    snapshots,
    /** M2：层级摘要（create/get）。 */
    summaries,
    /** M2：构包三级证据链与预算明细（save/updateStatus/get/list）。 */
    contextPackages,
    /** M6：实体（upsert/updateKind/get/list/resolve/linkMemory/unlinkMemory/forMemory/memoriesFor/stats）。 */
    entities,
    /** M6：记忆间关系（link/forMemory/list/conflicts/remove/stats）。 */
    memoryEdges,
    /** M7.2：情感状态（getState/saveState/appendEvent/listEvents/pruneEvents/stats）。**不做 scope 过滤**。 */
    mood,
    /**
     * M8：全局工作空间（publish/propose/claim/complete/getFocus/acquireFocus/
     * isEnabled/isPaused/assertAllowed/setSwitch/listSwitches…）。
     * 系统 3 的模块之间只通过它通信；任何自主行为执行前必须过它的开关。
     */
    workspace,
    /**
     * M8 系统 3：类脑协同（salience / reflect / skill / immune / brainstem + stats()）。
     * 反思等自主模块受 `reflection.enabled` 与 `paused` 两个开关约束，关闭时零副作用。
     */
    cognition,
    /**
     * M8 系统 4：人格与主动社交（profiles / versions / persons / relationships /
     * social / response / gate()）。默认 `social.enabled='0'`、`allow_external='0'`：
     * 只出 dry_run 候选，不发消息。
     */
    persona,
    /**
     * M8 系统 5：自主指令（store / scheduler / autonomy / permissions / 状态机）。
     * 默认 `autonomy.enabled='0'` + `max_level='L1'`：不取任何指令，零动作。
     */
    directives,
    /** 内存毫秒时钟（与 clock 对齐；各模块共用，避免两套时间）。 */
    nowMs,
    /** M2：检索桥接（probe/ensureSchema），给检查器与测试用。 */
    searchBridge,
    /** 关闭：排空写队列后关闭句柄（之后 write 一律 QUEUE_CLOSED）。 */
    async close(opts = {}) {
      await queue.close(opts);
    },
    /** 一致性检查。 */
    integrityCheck: () => integrityCheck(db),
    /** 当前界面的 PRAGMA 实际值。 */
    readPragmas: () => readPragmas(db),
  };
}

export {
  DEFAULT_PRAGMAS,
  DEFAULT_PERSON_ID,
  DEFAULT_SCOPE_ID,
  DEFAULT_SOURCE_SYSTEM,
  PROJECT_EVENT_WORK_KIND,
  META_KEYS,
  applyMigrations,
  closeDatabase,
  createBackupService,
  createConsumers,
  createDeletionBarrier,
  createMainLedger,
  createOutbox,
  createWriteQueue,
  defaultMigrationsDir,
  getCurrentVersion,
  integrityCheck,
  isMemoryPath,
  listMigrations,
  openDatabase,
  readDeletionEpoch,
  readMeta,
  readMetaInt,
  readPragmas,
  rollbackLastMigration,
  runInTransaction,
  safeRollback,
  toBindable,
};

// ---- M2 记忆层（M2-INTERFACES §1）----
export { createMemories, DEFAULT_MIN_COVERAGE } from './memories.js';
// ---- M3 删除线（M3-INTERFACES §1/§2/§3）----
export {
  createDeletionLedger,
  defaultDeletionLedgerDir,
  GENESIS_HASH,
  LEDGER_FORMAT_VERSION,
  computeEntryHash,
  computeTailChecksum,
} from './deletion-ledger.js';
export { createDeletionWorker, DEFAULT_BACKUP_RETENTION_DAYS, DEFAULT_EXTERNAL_COPIES, DEFAULT_HOST_COPIES, PURGE_STEP_LABELS } from './deletion-worker.js';
export { createCorrections } from './correction.js';
export { M3_PURGE_JOBS, replayLedgerDeletions } from './deletion.js';
export { createSearchBridge, DEFAULT_SEARCH_WEIGHTS, expectedSearchSchema, searchNames } from './search-bridge.js';
export { createSnapshots, deriveTaskId } from './snapshots.js';
export { createSources, SOURCE_KINDS } from './sources.js';
export { createSummaries, layerToKind, SUMMARY_KINDS } from './summaries.js';
export {
  createContextPackages,
  transitionRule,
  CARRIERS,
  PACKAGE_STATUSES,
  EVIDENCE_STRENGTHS,
} from './context-packages.js';
export { CasConflictError } from './memory-util.js';

// ---- M6 实体与记忆关系 ----
export {
  createEntities,
  createMemoryEdges,
  DEFAULT_ENTITY_LIMIT,
  ENTITY_KINDS,
  MEMORY_EDGE_KINDS,
} from './entities.js';

// ---- M7.2 情感状态（心情 / 精力 / 亲密度；专用表，不进检索、不做 scope 过滤）----
export {
  createMood,
  DEFAULT_EVENT_KEEP,
  DEFAULT_EVENT_LIMIT,
  FOX_STATE_ID,
  MAX_EVENT_LIMIT,
  MAX_NOTE_LENGTH,
} from './mood.js';

// ---- M8 全局工作空间（系统 3/4/5 的通信面与仲裁层；独立包，只依赖 core）----
export {
  CANDIDATE_KINDS,
  CANDIDATE_STATUSES,
  FOCUS_KINDS,
  FOCUS_PRIORITY,
  KINDS_REQUIRING_EVIDENCE,
  KNOWN_SWITCHES,
  WS_CHANNELS,
  createAttention,
  createCandidateBoard,
  createEventBus,
  createSwitches,
  createWorkspace,
  toBool,
} from '@dsh-brain/workspace';

// ---- M8 系统 3/4/5 门面（各自独立包；memory 只负责在 openBrain 里组装）----
export { createCognition } from '@dsh-brain/cognition';
export { createPersona } from '@dsh-brain/persona';
export { createDirectives } from '@dsh-brain/directives';

// ---- M3 备份恢复线（M3-INTERFACES §4/§5；ui3 与运维脚本从这里或子路径取）----
export {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  DEFAULT_KEEP_FLOOR,
  DEFAULT_RETENTION_DAYS,
  blobHashOf,
  blobStoragePath,
  collectBackupReferencedBlobs,
  collectReferencedBlobs,
  createBackup,
  createBlobReaderGuard,
  inspectSnapshotFile,
  listBackups,
  listBlobFiles,
  parseBlobRef,
  planBlobGc,
  pruneBackups,
  readBlob,
  runBlobGc,
  verifyBackup,
  writeBlob,
} from './backup.js';
export {
  ISOLATION_CODES,
  RESTORE_STEP_SEQUENCE,
  createRestoreService,
  evaluateLedger,
  executeRestore,
  planRestore,
  readEntriesAfterEpoch,
  rebuildDerivedIndexes,
  replayLedgerIntoRestoredDb,
  verifyDeletionsEffective,
} from './restore.js';
