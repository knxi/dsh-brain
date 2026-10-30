// @ts-check
/**
 * canonicalHash：稳定、可复现、顺序敏感、可复核。
 *
 * 契约：`canonicalHash = sha256(canonicalize({segments, injectedText, policyVersion}))`。
 * 纪律：
 * - 同输入永远同哈希（复用 core 的 canonicalize，键序无关）；
 * - **段序不同就是不同**——段序本身是内容（检查器按注入顺序复述），不在这里偷偷重排；
 * - 篡改任何一段或一句注入文本，复核必须失败。
 */

import test from 'node:test';
import { assert, buildOnce } from './helpers.mjs';
import {
  HASH_PLACEHOLDER,
  computeCanonicalHash,
  hashableInjectedText,
  verifyCanonicalHash,
} from '../../../packages/context/src/index.js';

/**
 * 一段完整的注入段（字段集合与 build 的规范化结果一致）。
 * @param {Record<string, unknown>} [overrides]
 */
function segment(overrides = {}) {
  return {
    memoryId: 'mem_a',
    version: 2,
    layer: 'long',
    type: 'semantic',
    summary: '展板 1.2m 按 1200mm 出图',
    contentHash: 'sha256:aaaa',
    sourceRefs: [{ id: 'src_1', sourceSystem: 'dsh', sourceEventId: 'host-1', locator: 'events/1', contentHash: 'sha256:aaaa' }],
    evidenceKind: 'owner_words',
    validFrom: '2026-10-01T00:00:00.000Z',
    validUntil: null,
    score: 0.9,
    ...overrides,
  };
}

const TEXT = '<!-- brain-context:begin -->\n段落\n<!-- brain-context:end -->';

test('同输入同哈希：重复计算完全一致', () => {
  const first = computeCanonicalHash({ segments: [segment()], injectedText: TEXT, policyVersion: 'm2.0' });
  const second = computeCanonicalHash({ segments: [segment()], injectedText: TEXT, policyVersion: 'm2.0' });
  assert.equal(first, second);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
});

test('键序无关：对象字段顺序不同但内容等价 → 同哈希（复用 core canonicalize）', () => {
  const a = computeCanonicalHash({
    segments: [{ memoryId: 'mem_a', version: 2 }],
    injectedText: TEXT,
    policyVersion: 'm2.0',
  });
  const b = computeCanonicalHash({
    segments: [{ version: 2, memoryId: 'mem_a' }],
    injectedText: TEXT,
    policyVersion: 'm2.0',
  });
  assert.equal(a, b);
});

test('段序不同 → 哈希不同（顺序是内容的一部分，不偷偷重排）', () => {
  const one = segment({ memoryId: 'mem_1', summary: '第一段' });
  const two = segment({ memoryId: 'mem_2', summary: '第二段' });
  const forward = computeCanonicalHash({ segments: [one, two], injectedText: TEXT, policyVersion: 'm2.0' });
  const backward = computeCanonicalHash({ segments: [two, one], injectedText: TEXT, policyVersion: 'm2.0' });
  assert.notEqual(forward, backward);
});

test('内容/文本/策略版本任一变化 → 哈希不同', () => {
  const base = computeCanonicalHash({ segments: [segment()], injectedText: TEXT, policyVersion: 'm2.0' });
  assert.notEqual(
    base,
    computeCanonicalHash({ segments: [segment({ summary: '换个说法' })], injectedText: TEXT, policyVersion: 'm2.0' }),
  );
  assert.notEqual(
    base,
    computeCanonicalHash({ segments: [segment()], injectedText: `${TEXT}\n多一行`, policyVersion: 'm2.0' }),
  );
  assert.notEqual(base, computeCanonicalHash({ segments: [segment()], injectedText: TEXT, policyVersion: 'm2.1' }));
  assert.notEqual(
    base,
    computeCanonicalHash({ segments: [segment({ version: 3 })], injectedText: TEXT, policyVersion: 'm2.0' }),
  );
});

test('build 出来的包可复核：verifyCanonicalHash 通过，篡改即失败', async () => {
  const pkg = await buildOnce();
  assert.equal(verifyCanonicalHash(pkg), true);

  // 注入文本里回填了自身哈希——sent 判据要靠它能在请求对象里被搜到
  assert.ok(pkg.injectedText.includes(pkg.canonicalHash), '注入文本必须携带 canonicalHash');
  assert.ok(pkg.injectedText.includes('canonical_hash='));
  assert.ok(!pkg.injectedText.includes(HASH_PLACEHOLDER), '占位符必须已经回填');

  // 篡改段摘要
  const tamperedSummary = structuredClone(pkg);
  tamperedSummary.segments[0].summary = '被改过的摘要';
  assert.equal(verifyCanonicalHash(tamperedSummary), false);

  // 篡改注入文本
  const tamperedText = structuredClone(pkg);
  tamperedText.injectedText = `${tamperedText.injectedText}\n偷偷加一句`;
  assert.equal(verifyCanonicalHash(tamperedText), false);

  // 篡改策略版本
  const tamperedPolicy = structuredClone(pkg);
  tamperedPolicy.policyVersion = 'm9.9';
  assert.equal(verifyCanonicalHash(tamperedPolicy), false);

  // 段数变化
  const tamperedSegments = structuredClone(pkg);
  tamperedSegments.segments.pop();
  assert.equal(verifyCanonicalHash(tamperedSegments), false);

  // 还原成占位符版能复算出同一个哈希（自引用回填是可验证的）
  assert.equal(
    computeCanonicalHash({
      segments: pkg.segments,
      injectedText: hashableInjectedText(pkg.injectedText, pkg.canonicalHash),
      policyVersion: pkg.policyVersion,
    }),
    pkg.canonicalHash,
  );
});

test('非法入参：宁可抛错也不返回一个假的哈希', () => {
  const invalid = [
    () => computeCanonicalHash({ segments: /** @type {any} */ (null), injectedText: TEXT, policyVersion: 'm2.0' }),
    () => computeCanonicalHash({ segments: [], injectedText: /** @type {any} */ (1), policyVersion: 'm2.0' }),
    () => computeCanonicalHash({ segments: [], injectedText: TEXT, policyVersion: '' }),
  ];
  for (const run of invalid) {
    assert.throws(run, (/** @type {any} */ err) => err.code === 'INVALID_ARGUMENT');
  }
});
