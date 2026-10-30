// @ts-check
/**
 * 三级证据状态机：`built → attached → sent`。
 *
 * 硬约束（CONTRACTS §6 / §10.1 / §10.4 / §10.9）：
 * - built 出生；禁止跳级；禁止回退；
 * - 重复调用幂等（每 step 都会跑 assemble / pre-step），但幂等**不改变首次证据**；
 * - sent 的 carrier 两级（`system` / `messages[role=system]`）都要能表达；
 * - 给了最终请求对象时，哈希必须真在里面，否则拒绝声称 sent。
 */

import test from 'node:test';
import { assert, buildOnce } from './helpers.mjs';
import {
  PACKAGE_STATUS,
  SENT_EVIDENCE_KIND,
  markAttached,
  markSent,
  nextTransition,
} from '../../../packages/context/src/index.js';

const AT1 = '2026-10-28T10:00:01.000Z';
const AT2 = '2026-10-28T10:00:09.000Z';

test('出生状态只能是 built', async () => {
  const pkg = await buildOnce();
  assert.equal(pkg.status, PACKAGE_STATUS.BUILT);
  assert.equal(pkg.evidence.attached, null);
  assert.equal(pkg.evidence.sent, null);
  assert.equal(pkg.carrier, null);
});

test('禁止跳级：built 不能直接 sent', async () => {
  const pkg = await buildOnce();
  assert.throws(
    () => markSent(pkg, { carrier: 'system' }),
    (/** @type {any} */ err) => err.code === 'INVALID_ARGUMENT' && err.details.rule === 'no_skip',
  );
  // 拒绝之后包还是干净的
  assert.equal(pkg.status, 'built');
  assert.equal(pkg.evidence.sent, null);
});

test('built → attached → sent：正常三级链，证据逐级落盘', async () => {
  const pkg = await buildOnce();
  const attached = markAttached(pkg, {
    carrier: 'messages[role=system]',
    turn: 'turn-1',
    step: 'step-1',
    at: AT1,
  });
  assert.equal(attached.status, 'attached');
  assert.equal(attached.carrier, 'messages[role=system]');
  assert.deepEqual(attached.evidence.attached, {
    at: AT1,
    carrier: 'messages[role=system]',
    turn: 'turn-1',
    step: 'step-1',
  });
  assert.equal(attached.evidence.sent, null);

  const sent = markSent(attached, { carrier: 'messages[role=system]', at: AT2 });
  assert.equal(sent.status, 'sent');
  assert.deepEqual(sent.evidence.sent, {
    at: AT2,
    carrier: 'messages[role=system]',
    evidenceKind: SENT_EVIDENCE_KIND.DECLARED,
    matchedCarriers: [],
  });
  // 前一级证据不能被抹掉
  assert.deepEqual(sent.evidence.attached, attached.evidence.attached);
  // canonicalHash 不随状态迁移变化（哈希只覆盖内容）
  assert.equal(sent.canonicalHash, pkg.canonicalHash);
});

test('不改入参：每一步都返回新对象，旧包冻结在原状态', async () => {
  const pkg = await buildOnce();
  const attached = markAttached(pkg, { carrier: 'system', at: AT1 });
  const sent = markSent(attached, { carrier: 'system', at: AT2 });

  assert.equal(pkg.status, 'built');
  assert.equal(pkg.evidence.attached, null);
  assert.equal(attached.status, 'attached');
  assert.equal(attached.evidence.sent, null);
  assert.equal(sent.status, 'sent');

  assert.notEqual(attached, pkg);
  assert.notEqual(sent, attached);
  // 深拷贝：改新包不影响旧包
  sent.evidence.attached.carrier = 'system';
  assert.equal(attached.evidence.attached.carrier, 'system');
});

test('幂等：同一 step 重复 markAttached 不报错，且保留首次证据', async () => {
  const pkg = await buildOnce();
  const first = markAttached(pkg, { carrier: 'messages[role=system]', turn: 'turn-1', step: 'step-1', at: AT1 });
  const replay = markAttached(first, {
    carrier: 'messages[role=system]',
    turn: 'turn-1',
    step: 'step-1',
    at: AT2,
  });
  assert.equal(replay.status, 'attached');
  assert.equal(replay.evidence.attached.at, AT1, '重放不许刷新技术时间戳');
  assert.equal(replay.canonicalHash, first.canonicalHash);
  assert.notEqual(replay, first, '仍然返回新对象，不改入参');
});

test('幂等：同一 carrier 重复 markSent 不报错', async () => {
  const pkg = await buildOnce();
  const attached = markAttached(pkg, { carrier: 'system', at: AT1 });
  const first = markSent(attached, { carrier: 'system', at: AT1 });
  const replay = markSent(first, { carrier: 'system', at: AT2 });
  assert.equal(replay.status, 'sent');
  assert.equal(replay.evidence.sent.at, AT1);
  assert.deepEqual(replay.evidence, first.evidence);
});

test('禁止回退：sent 之后不能变回 attached', async () => {
  const pkg = await buildOnce();
  const sent = markSent(markAttached(pkg, { carrier: 'system' }), { carrier: 'system' });
  assert.throws(
    () => markAttached(sent, { carrier: 'system' }),
    (/** @type {any} */ err) => err.code === 'INVALID_ARGUMENT' && err.details.rule === 'no_regression',
  );
});

test('承载位置锁定：attached 后不许换 carrier / 换 step', async () => {
  const pkg = await buildOnce();
  const attached = markAttached(pkg, { carrier: 'system', turn: 'turn-1', step: 'step-1' });
  assert.throws(
    () => markAttached(attached, { carrier: 'messages[role=system]', turn: 'turn-1', step: 'step-1' }),
    (/** @type {any} */ err) => err.details.rule === 'carrier_locked',
  );
  assert.throws(
    () => markAttached(attached, { carrier: 'system', turn: 'turn-2', step: 'step-1' }),
    (/** @type {any} */ err) => err.details.rule === 'carrier_locked',
  );
});

test('承载位置锁定：sent 后不许换 carrier', async () => {
  const pkg = await buildOnce();
  const sent = markSent(markAttached(pkg, { carrier: 'system' }), { carrier: 'system' });
  assert.throws(
    () => markSent(sent, { carrier: 'messages[role=system]' }),
    (/** @type {any} */ err) => err.details.rule === 'carrier_locked',
  );
});

test('carrier 校验：只接受 system 与 messages[role=system]', async () => {
  const pkg = await buildOnce();
  for (const carrier of ['tools', 'assistant', '', 'SYSTEM', undefined]) {
    assert.throws(
      () => markAttached(pkg, { carrier: /** @type {any} */ (carrier) }),
      (/** @type {any} */ err) => err.code === 'INVALID_ARGUMENT' && err.details.field === 'carrier',
      `carrier=${String(carrier)} 应该被拒`,
    );
  }
  // 第二个合法 carrier 也能走完全程
  const attached = markAttached(pkg, { carrier: 'messages[role=system]' });
  assert.equal(attached.carrier, 'messages[role=system]');
});

test('请求边界证据（CONTRACTS 10.9）：两级承载都能证明 sent', async () => {
  const pkg = await buildOnce();
  const attached = markAttached(pkg, { carrier: 'system' });

  // 形态一：options.system
  const viaSystem = markSent(attached, {
    carrier: 'system',
    observedIn: { system: `前缀\n${pkg.injectedText}\n后缀`, messages: [{ role: 'user', content: '在吗' }] },
  });
  assert.equal(viaSystem.status, 'sent');
  assert.equal(viaSystem.evidence.sent.evidenceKind, SENT_EVIDENCE_KIND.OBSERVED);
  assert.deepEqual(viaSystem.evidence.sent.matchedCarriers, ['system']);

  // 形态二：messages[role=system]（M0 实测主请求是这一种，只查 options.system 会漏判）
  const attached2 = markAttached(pkg, { carrier: 'messages[role=system]' });
  const viaMessage = markSent(attached2, {
    carrier: 'messages[role=system]',
    observedIn: { system: '', messages: [{ role: 'system', content: pkg.injectedText }] },
  });
  assert.equal(viaMessage.status, 'sent');
  assert.deepEqual(viaMessage.evidence.sent.matchedCarriers, ['messages[role=system]']);
});

test('请求边界证据：内容承载是多段数组时也能认出来', async () => {
  const pkg = await buildOnce();
  const attached = markAttached(pkg, { carrier: 'messages[role=system]' });
  const sent = markSent(attached, {
    carrier: 'messages[role=system]',
    observedIn: {
      messages: [{ role: 'system', content: [{ type: 'text', text: pkg.injectedText }] }],
    },
  });
  assert.equal(sent.status, 'sent');
  assert.equal(sent.evidence.sent.evidenceKind, SENT_EVIDENCE_KIND.OBSERVED);
});

test('请求边界证据：两级都找不到哈希时拒绝声称 sent（CONTRACTS §6）', async () => {
  const pkg = await buildOnce();
  const attached = markAttached(pkg, { carrier: 'system' });
  assert.throws(
    () => markSent(attached, { carrier: 'system', observedIn: { system: '完全不相关', messages: [] } }),
    (/** @type {any} */ err) =>
      err.code === 'INVALID_ARGUMENT' && err.details.rule === 'sent_requires_request_evidence',
  );
  // 拒绝后状态没变
  assert.equal(attached.status, 'attached');
  assert.equal(attached.evidence.sent, null);
});

test('请求边界证据：证据只支持另一个承载位置时拒绝（声明与实测不一致）', async () => {
  const pkg = await buildOnce();
  const attached = markAttached(pkg, { carrier: 'system' });
  // 哈希只出现在 messages[role=system]，却声明 system
  assert.throws(
    () => markSent(attached, {
      carrier: 'system',
      observedIn: { system: '', messages: [{ role: 'system', content: pkg.injectedText }] },
    }),
    (/** @type {any} */ err) => err.details.rule === 'sent_carrier_mismatch',
  );
});

test('非法包直接拒绝：缺 canonicalHash / 缺 evidence / 状态乱写', async () => {
  assert.throws(() => markSent(/** @type {any} */ ({ status: 'built' }), { carrier: 'system' }), (/** @type {any} */ err) =>
    err.code === 'INVALID_ARGUMENT',
  );
  assert.throws(() => markAttached(/** @type {any} */ (null), { carrier: 'system' }), (/** @type {any} */ err) =>
    err.code === 'INVALID_ARGUMENT',
  );
  const pkg = await buildOnce();
  const broken = { ...pkg, status: 'delivered' };
  assert.throws(
    () => markSent(/** @type {any} */ (broken), { carrier: 'system' }),
    (/** @type {any} */ err) => err.code === 'INVALID_ARGUMENT' && err.details.field === 'status',
  );
  const noEvidence = { ...pkg, evidence: null };
  assert.throws(() => markAttached(/** @type {any} */ (noEvidence), { carrier: 'system' }), (/** @type {any} */ err) =>
    err.details.field === 'evidence',
  );
});

test('nextTransition：状态机只有一条前进路线', () => {
  assert.deepEqual(nextTransition('built'), { canAttach: true, canSend: false, next: 'attached' });
  assert.deepEqual(nextTransition('attached'), { canAttach: false, canSend: true, next: 'sent' });
  assert.deepEqual(nextTransition('sent'), { canAttach: false, canSend: false, next: null });
});
