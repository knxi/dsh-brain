// @ts-check
/**
 * 三级证据状态机：`built → attached → sent`。
 *
 * 纪律（CONTRACTS §6 / §10.4 / §10.9，M2-INTERFACES §2）：
 * - **出生只能是 built**。任何人手工把 status 改成 sent 都不会被本模块认可（校验入口在每次迁移）。
 * - **禁止跳级**：built 不能直接 sent。没有「宿主已把这段挂上去」的证据，就不是 attached。
 * - **禁止回退**：sent 之后不许再变 attached；attached 之后不许换承载位置。
 * - **重复调用幂等**（CONTRACTS 10.1：assemble / pre-step 每个 step 都会跑一次）：
 *   同 carrier + 同 turn/step 的第二次 markAttached 不报错、不改首次时间戳；
 *   同 carrier 的第二次 markSent 同理。这是幂等，不是回退。
 * - **不改入参**：返回新对象。宿主/检查器拿到的旧包引用不该被偷偷改状态。
 * - **sent 的两级承载**（CONTRACTS 10.9）：`system` 与 `messages[role=system]`
 *   都是合法 carrier；给了 `observedIn`（最终请求对象）时必须真在里面找到本包哈希。
 *
 * sent 的证据强度分两档，检查器必须分开显示：
 * - `observed`：调用方把 `llm/stream` 抓到的最终请求对象传进来，哈希两级都查过 → 最强证据。
 * - `declared`：只声明了 carrier，没有请求边界证据 → **弱证据**，不许当成 observed 展示。
 */

import { BrainError } from '@dsh-brain/core';
import { SENT_CARRIERS, findCanonicalHashInRequest } from './render.js';

/** 三级状态常量。 */
export const PACKAGE_STATUS = Object.freeze(
  /** @type {const} */ ({ BUILT: 'built', ATTACHED: 'attached', SENT: 'sent' }),
);

/** 合法的状态迁移（只允许前进一格）。 */
const ALLOWED_TRANSITIONS = Object.freeze(
  /** @type {const} */ ({ built: 'attached', attached: 'sent' }),
);

/** sent 的两种证据强度。 */
export const SENT_EVIDENCE_KIND = Object.freeze(
  /** @type {const} */ ({ OBSERVED: 'observed', DECLARED: 'declared' }),
);

/**
 * @param {unknown} carrier
 * @returns {string}
 */
function assertCarrier(carrier) {
  if (typeof carrier !== 'string' || !SENT_CARRIERS.includes(carrier)) {
    throw new BrainError('INVALID_ARGUMENT', `carrier 必须是 ${SENT_CARRIERS.join(' 或 ')} 之一，收到 ${String(carrier)}`, {
      details: { field: 'carrier', received: carrier, allowed: [...SENT_CARRIERS] },
    });
  }
  return carrier;
}

/**
 * 校验包对象基本形状（不是完整 schema 校验，够状态机用）。
 *
 * @param {unknown} pkg
 * @returns {import('./types.js').ContextPackage}
 */
function assertPackage(pkg) {
  if (!pkg || typeof pkg !== 'object') {
    throw new BrainError('INVALID_ARGUMENT', '需要一个 ContextPackage 对象', { details: { field: 'pkg' } });
  }
  const candidate = /** @type {Record<string, unknown>} */ (pkg);
  const status = candidate.status;
  if (status !== 'built' && status !== 'attached' && status !== 'sent') {
    throw new BrainError('INVALID_ARGUMENT', `包状态非法：${String(status)}（只接受 built/attached/sent）`, {
      details: { field: 'status', received: status },
    });
  }
  if (typeof candidate.canonicalHash !== 'string' || candidate.canonicalHash.length === 0) {
    throw new BrainError('INVALID_ARGUMENT', '包缺少 canonicalHash，无法建立证据链', {
      details: { field: 'canonicalHash' },
    });
  }
  if (!candidate.evidence || typeof candidate.evidence !== 'object') {
    throw new BrainError('INVALID_ARGUMENT', '包缺少 evidence 字段（必须来自 build()）', { details: { field: 'evidence' } });
  }
  return /** @type {import('./types.js').ContextPackage} */ (pkg);
}

/**
 * @param {unknown} at
 * @returns {string} ISO UTC
 */
function timestampOf(at) {
  if (at === undefined || at === null) return new Date().toISOString();
  if (typeof at === 'string' && at.length === 0) {
    throw new BrainError('INVALID_ARGUMENT', 'at 不能是空字符串', { details: { field: 'at' } });
  }
  const date = at instanceof Date ? at : new Date(/** @type {string|number} */ (at));
  if (Number.isNaN(date.getTime())) {
    throw new BrainError('INVALID_ARGUMENT', 'at 不是合法时间', { details: { field: 'at', received: typeof at } });
  }
  return date.toISOString();
}

/**
 * @param {import('./types.js').ContextPackage} pkg
 * @returns {import('./types.js').ContextPackage} 深拷贝（纯数据）
 */
function clonePackage(pkg) {
  return structuredClone(pkg);
}

/**
 * built → attached。
 *
 * `carrier` 必须是宿主真实承载位置之一（CONTRACTS 10.9 的两种形态）。
 * `turn` / `step` 用来和宿主的 (session, turn, step) 对齐，assemble 拿不到时传 null。
 *
 * @param {import('./types.js').ContextPackage} pkg
 * @param {{ carrier: string, turn?: string|number|null, step?: string|number|null, at?: string|number|Date }} input
 * @returns {import('./types.js').ContextPackage} 新包（status = 'attached'）
 */
export function markAttached(pkg, input) {
  const target = assertPackage(pkg);
  if (!input || typeof input !== 'object') {
    throw new BrainError('INVALID_ARGUMENT', 'markAttached 需要 { carrier, turn?, step? }', { details: { field: 'input' } });
  }
  const carrier = assertCarrier(input.carrier);
  const turn = input.turn ?? null;
  const step = input.step ?? null;

  const attached = target.evidence.attached;
  if (target.status === 'sent') {
    throw new BrainError('INVALID_ARGUMENT', '状态回退被拒绝：已 sent 的包不能再标 attached', {
      details: { from: 'sent', to: 'attached', rule: 'no_regression' },
    });
  }
  if (target.status === 'attached') {
    const sameCarrier = attached !== null && attached.carrier === carrier;
    const samePosition = sameCarrier && attached.turn === turn && attached.step === step;
    if (samePosition) {
      // 幂等：同一 step 的重放（CONTRACTS 10.1），保留首次时间戳，不算新证据。
      return clonePackage(target);
    }
    throw new BrainError('INVALID_ARGUMENT', '已 attached 的包不允许换承载位置或换 step（视为回退/篡改）', {
      details: {
        from: 'attached',
        to: 'attached',
        rule: 'carrier_locked',
        previous: attached === null ? null : { carrier: attached.carrier, turn: attached.turn, step: attached.step },
        incoming: { carrier, turn, step },
      },
    });
  }

  const next = clonePackage(target);
  next.status = 'attached';
  next.carrier = carrier;
  next.evidence.attached = { at: timestampOf(input.at), carrier, turn, step };
  return next;
}

/**
 * attached → sent。
 *
 * 给了 `observedIn`（`llm/stream` 抓到的最终请求对象）时，必须在本包哈希命中的承载位置里
 * 包含声明的 carrier，否则拒绝——**没有请求边界证据时不许声称 sent**（CONTRACTS §6）。
 *
 * @param {import('./types.js').ContextPackage} pkg
 * @param {{ carrier: string, observedIn?: unknown, at?: string|number|Date }} input
 * @returns {import('./types.js').ContextPackage} 新包（status = 'sent'）
 */
export function markSent(pkg, input) {
  const target = assertPackage(pkg);
  if (!input || typeof input !== 'object') {
    throw new BrainError('INVALID_ARGUMENT', 'markSent 需要 { carrier, observedIn? }', { details: { field: 'input' } });
  }
  const carrier = assertCarrier(input.carrier);
  const observedIn = input.observedIn ?? null;

  if (target.status === 'built') {
    throw new BrainError('INVALID_ARGUMENT', '跳级被拒绝：built 不能直接标 sent（必须先 attached）', {
      details: { from: 'built', to: 'sent', rule: 'no_skip' },
    });
  }
  if (target.status === 'sent') {
    const sent = target.evidence.sent;
    if (sent !== null && sent.carrier === carrier) {
      // 同一个 step 的重复观测（model 重试不重跑 waterfall，但连接器可能多记一次）。
      return clonePackage(target);
    }
    throw new BrainError('INVALID_ARGUMENT', '已 sent 的包不允许换承载位置（视为篡改）', {
      details: {
        from: 'sent',
        to: 'sent',
        rule: 'carrier_locked',
        previous: sent === null ? null : sent.carrier,
        incoming: carrier,
      },
    });
  }

  /** @type {{ found: boolean, carriers: string[] }} */
  let observed = { found: false, carriers: [] };
  let evidenceKind = SENT_EVIDENCE_KIND.DECLARED;
  if (observedIn !== null) {
    observed = findCanonicalHashInRequest(observedIn, target.canonicalHash);
    if (!observed.found) {
      throw new BrainError(
        'INVALID_ARGUMENT',
        '请求边界证据不足：最终请求对象的两级承载里都找不到本包 canonicalHash，拒绝标 sent',
        {
          details: {
            rule: 'sent_requires_request_evidence',
            canonicalHash: target.canonicalHash,
            checkedCarriers: [...SENT_CARRIERS],
            observedCarriers: [],
          },
        },
      );
    }
    if (!observed.carriers.includes(carrier)) {
      throw new BrainError('INVALID_ARGUMENT', `请求边界证据与声明承载不一致：证据只支持 ${observed.carriers.join('、')}`, {
        details: {
          rule: 'sent_carrier_mismatch',
          declared: carrier,
          observedCarriers: observed.carriers,
        },
      });
    }
    evidenceKind = SENT_EVIDENCE_KIND.OBSERVED;
  }

  const next = clonePackage(target);
  next.status = 'sent';
  next.carrier = carrier;
  next.evidence.sent = {
    at: timestampOf(input.at),
    carrier,
    evidenceKind,
    matchedCarriers: evidenceKind === SENT_EVIDENCE_KIND.OBSERVED ? [...observed.carriers] : [],
  };
  return next;
}

/**
 * 状态机的唯一权威判断：这个包能往哪走。
 *
 * 给检查器/服务端用，避免各处自己写 if。
 *
 * @param {string} status
 * @returns {{ canAttach: boolean, canSend: boolean, next: string|null }}
 */
export function nextTransition(status) {
  const next = /** @type {Record<string, string|undefined>} */ (ALLOWED_TRANSITIONS)[status] ?? null;
  return {
    canAttach: status === 'built',
    canSend: status === 'attached',
    next,
  };
}
