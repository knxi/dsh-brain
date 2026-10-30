// @ts-check
/**
 * M2 构包线测试的公共工具。
 *
 * **不碰真实记忆库**：检索一律注入 mock store。mock 的形状严格按
 * `docs/M2-INTERFACES.md` §1.2 的 `SearchResult` / `hits[]` 写，
 * 用来和 memory2 的真实返回对拍（真实联调由 Lead 收口）。
 */

import assert from 'node:assert/strict';
import { build } from '../../../packages/context/src/index.js';

export { assert };

/** 固定构建时刻（测试确定化）。 */
export const FIXED_NOW = '2026-10-28T10:00:00.000Z';

/** 默认的一整套身份参数。 */
export const IDENTITY = Object.freeze({
  scopeId: 'owner-default',
  personId: 'owner',
  sessionId: 'sess-m2-1',
  turnId: 'turn-1',
  stepId: 'step-1',
});

/** 宽裕预算：safetyMargin=1600、brainAllowance=min(2048, 25304)=2048。 */
export const ROOMY_BUDGET = Object.freeze({
  modelWindow: 32000,
  hostInputTokens: 1000,
  outputReserve: 4096,
});

/**
 * 造一条 `hits[]` 命中（M2-INTERFACES §1.2）。
 *
 * @param {Record<string, unknown>} [overrides]
 * @returns {Record<string, any>}
 */
export function makeHit(overrides = {}) {
  const memoryId = typeof overrides.memoryId === 'string' ? overrides.memoryId : 'mem_a';
  const score = typeof overrides.score === 'number' ? overrides.score : 0.9;
  return {
    memoryId,
    version: 2,
    score,
    matchedBy: ['char', 'trigram'],
    sourceRefs: [
      {
        id: `src_${memoryId}`,
        sourceSystem: 'dsh',
        sourceEventId: `host-${memoryId}`,
        locator: `events/${memoryId}`,
        contentHash: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      },
    ],
    evidenceKind: 'owner_words',
    validFrom: '2026-10-01T00:00:00.000Z',
    validUntil: null,
    layer: 'long',
    type: 'semantic',
    summary: '展板 1.2m 宽，按 1200mm 出图，图号 建施-03',
    contentHash: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
    ...overrides,
  };
}

/**
 * 造一个 `SearchResult`。
 *
 * `primaryLaneHit` / `segmented` 对应 memory2 的扩展诊断字段（真实实现从 M2 起提供）：
 * 不传就模拟「老实现 / 无该字段」，构包侧应当按 `unknown` 处理。
 *
 * @param {{
 *   hits?: unknown[],
 *   status?: string,
 *   notes?: string[],
 *   degraded?: string|null,
 *   primaryLaneHit?: boolean,
 *   segmented?: boolean,
 *   raw?: unknown,
 * }} [opts]
 * @returns {any}
 */
export function makeSearchResult(opts = {}) {
  if (opts.raw !== undefined) return opts.raw;
  /** @type {Record<string, any>} */
  const diagnostics = {
    status: opts.status ?? 'ok',
    queryWasEscaped: true,
    degraded: opts.degraded ?? null,
    notes: opts.notes ?? [],
  };
  if (opts.primaryLaneHit !== undefined) diagnostics.primaryLaneHit = opts.primaryLaneHit;
  if (opts.segmented === true) {
    diagnostics.routes = {
      fts_char: { count: 0, ok: true },
      fts_trigram: { count: 0, ok: true },
      ngram: { count: 2, ok: true },
      segmented: { count: 2, ok: true, segments: 2 },
    };
  }
  return {
    hits: opts.hits ?? [makeHit()],
    diagnostics,
  };
}

/**
 * mock store：形状 = `{ memories: { search(args) } }`。
 *
 * `result` 可以是固定返回，也可以是 `(args) => result`（可抛错，用来测检索炸掉）。
 * `facade` 可选：给了就挂成 `store.contextPackages`，用来测旁路落库。
 *
 * @param {unknown | ((args: Record<string, unknown>) => unknown)} result
 * @param {unknown} [facade]
 */
export function mockStore(result, facade) {
  /** @type {Record<string, unknown>[]} */
  const calls = [];
  /** @type {Record<string, any>} */
  const store = {
    calls,
    memories: {
      /**
       * @param {Record<string, unknown>} args
       * @returns {Promise<unknown>}
       */
      async search(args) {
        calls.push(args);
        if (typeof result === 'function') {
          return /** @type {(args: Record<string, unknown>) => unknown} */ (result)(args);
        }
        return result;
      },
    },
  };
  if (facade !== undefined) store.contextPackages = facade;
  return store;
}

/**
 * mock `context_packages` 门面（memory2 那侧的可选依赖）。
 *
 * @param {{ existing?: unknown, fail?: Error, withGet?: boolean }} [opts]
 *   `existing`：`get()` 的返回值（用来测幂等）；`fail`：`save()` 抛的错；
 *   `withGet=false`：只提供 save，测"没有 get 也能落库"。
 */
export function mockContextPackages(opts = {}) {
  /** @type {{ save: any[], get: any[] }} */
  const calls = { save: [], get: [] };
  /** @type {Record<string, any>} */
  const facade = {
    /**
     * @param {unknown} pkg
     * @returns {Promise<{ id: string }>}
     */
    async save(pkg) {
      calls.save.push(pkg);
      if (opts.fail) throw opts.fail;
      return { id: /** @type {any} */ (pkg).contextId };
    },
  };
  if (opts.withGet !== false) {
    /**
     * @param {string} contextId
     * @returns {Promise<unknown>}
     */
    facade.get = async (contextId) => {
      calls.get.push(contextId);
      return opts.existing ?? null;
    };
  }
  return { facade, calls };
}

/**
 * 建包一次的便捷入口（默认全部参数都合规，只覆盖关心的部分）。
 *
 * @param {Record<string, any>} [overrides]
 */
export async function buildOnce(overrides = {}) {
  const store = overrides.store ?? mockStore(makeSearchResult({ hits: [makeHit()] }));
  return build({
    store,
    query: '展板尺寸',
    ...IDENTITY,
    budget: ROOMY_BUDGET,
    now: () => FIXED_NOW,
    ...overrides,
  });
}

/**
 * 判断是不是带稳定错误码的 BrainError。
 *
 * @param {string} code
 */
export function hasCode(code) {
  return (/** @type {any} */ err) => {
    assert.ok(err instanceof Error, `期望抛 Error，实际 ${String(err)}`);
    assert.equal(/** @type {any} */ (err).code, code);
    return true;
  };
}

/** 生成 N 条摘要很长的命中（用来逼出预算裁剪）。 */
export function manyHits(count = 12, summaryRepeat = 60) {
  return Array.from({ length: count }, (_, index) =>
    makeHit({
      memoryId: `mem_${String(index).padStart(2, '0')}`,
      score: Math.round((1 - index / 100) * 1000) / 1000,
      summary: '1.2m 展板按 1200mm 出图，图号 建施-03，材质 铝板'.repeat(summaryRepeat),
    }),
  );
}
