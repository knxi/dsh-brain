// @ts-check
/** 检索文本规范化、切分、查询构造、LIKE 转义的单元测试。 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  buildFtsMatch,
  buildTrigramMatch,
  coverageOf,
  ngramTerms,
  querySegments,
  segmentTokens,
  toSearchableText,
} from '../../packages/search/src/index.mjs';
import { toLikePattern } from '../../packages/search/src/index.mjs';

test('char-space：中文逐字切分，ASCII 词保持完整，数字与字母边界切开', () => {
  assert.equal(toSearchableText('用readSurface读取'), '用 readsurface 读 取');
  assert.equal(toSearchableText('建施-03图里标高'), '建 施 -03 图 里 标 高');
  assert.equal(toSearchableText('1440dpi'), '1440 dpi');
  assert.equal(toSearchableText('250g'), '250 g');
  assert.equal(toSearchableText('deletion_epoch'), 'deletion_epoch');
});

test('规范化不改坏尺寸/编号/代码标识符', () => {
  for (const s of ['1.2m', '1200mm', '2400×600', '建施-03', 'JS-2026-017', 'readSurface', 'deletion_epoch', 'M100']) {
    const normalized = toSearchableText(s).replaceAll(' ', '');
    assert.ok(normalized.includes(s.toLowerCase().replaceAll(' ', '')), `${s} 规范化后被改坏：${normalized}`);
  }
});

test('两字与单字查询都切成可 phrase 的 token', () => {
  assert.deepEqual(segmentTokens('铜版'), ['铜', '版']);
  assert.deepEqual(segmentTokens('铜'), ['铜']);
});

test('buildFtsMatch 默认自适应：短查询 phrase，长查询 OR', () => {
  const short = buildFtsMatch('铜版');
  assert.equal(short.ok, true);
  assert.equal(short.query, '"铜 版"');

  const long = buildFtsMatch('上次那个铜版纸名片的报价是多少');
  assert.equal(long.ok, true);
  assert.ok(long.query.includes(' OR '), `长查询应降级为 OR，实际 ${long.query}`);
  assert.ok(long.query.startsWith('('), 'OR 组必须加括号，否则和相邻段的隐式 AND 结合顺序会错');
});

test('buildFtsMatch 把危险字符包进引号（注入不抛错）', () => {
  for (const raw of ['建施-03', 'JS-2026-017', '1.2m', 'build:web', 'a*', 'x OR y', '"(', '100%', '--', "'"]) {
    const r = buildFtsMatch(raw);
    if (!r.ok) continue; // 纯符号没有 token 是允许的
    // 每个 token 必须独立被双引号包住；不允许裸的 - : . * ( OR 出现在引号外
    const outside = r.query.replace(/"[^"]*"/g, '');
    assert.equal(outside.includes(':'), false, `${raw} 的 : 漏到引号外：${r.query}`);
    assert.equal(outside.includes('-'), false, `${raw} 的 - 漏到引号外：${r.query}`);
    assert.equal(outside.includes('.'), false, `${raw} 的 . 漏到引号外：${r.query}`);
  }
});

test('空查询与纯标点返回 ok=false', () => {
  for (const raw of ['', '   ', '，。！', '"']) {
    const r = buildFtsMatch(raw);
    assert.equal(r.ok, false, `${JSON.stringify(raw)} 不该产出查询`);
  }
});

test('querySegments 按空白与中文标点分段，保留段内符号', () => {
  assert.deepEqual(querySegments('铜版 报价'), ['铜版', '报价']);
  assert.deepEqual(querySegments('建施-03，层高'), ['建施-03', '层高']);
  assert.deepEqual(querySegments('build:web'), ['build:web']);
});

test('LIKE 模式转义 % 与 _，防止用户输入当通配符', () => {
  assert.equal(toLikePattern('100%'), '%100\\%%');
  assert.equal(toLikePattern('a_b'), '%a\\_b%');
  assert.equal(toLikePattern('铜版'), '%铜版%');
});

test('ngramTerms 产出单字 + bigram + ASCII token', () => {
  const t = ngramTerms('铜版纸');
  assert.equal(t.has('铜'), true);
  assert.equal(t.has('铜版'), true);
  assert.equal(t.get('铜版'), 2, 'bigram 权重应高于单字');
  assert.equal(ngramTerms('readSurface').has('readsurface'), true);
});

test('coverageOf 计算查询权重覆盖率', () => {
  const q = ngramTerms('铜版');
  assert.equal(coverageOf(q, new Set(['铜', '版', '铜版'])), 1);
  assert.equal(coverageOf(q, new Set(['铜'])), 0.25);
  assert.equal(coverageOf(q, new Set(['铝'])), 0);
});

// ---------------------------------------------------------------------------
// 段间连接符必须是显式 AND（M2 集成期发现的 FTS5 语法错，回归测试）
//
// 背景：`buildFtsMatch` 原先用空格连接各段（空格＝隐式 AND）。纯 phrase 段之间
// 这么写合法，但**括号组后面直接跟 phrase 就是 FTS5 语法错**：
//   ("展" OR "板") "尺"                  -> fts5: syntax error near ""尺""
//   ("展" OR "板") AND "尺"              -> ok，命中 1
// 触发条件 = 多段查询里前一段 token 数 > maxPhraseTokens（走 OR 分支）、后面还有段。
// 真实输入 `展板成品尺寸 铝板厚度` 正好命中，会把调用方的整条检索拖进降级。
//
// 三组断言：① 底层 FTS5 语法事实；② 生成串的形态；③ 生成串真的能被执行。
// 任何一条被"简化"掉，都会让这类输入重新崩。
// ---------------------------------------------------------------------------

test('FTS5 语法事实：括号组后跟 phrase 必须显式 AND，空格会报 syntax error', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize = 'unicode61')");
    db.prepare('INSERT INTO t(body) VALUES (?)').run('展 板 成 品 尺 寸');

    assert.throws(
      () => db.prepare('SELECT count(*) AS n FROM t WHERE t MATCH ?').get('("展" OR "板") "尺"'),
      /syntax error/,
      '这是 FTS5 的语法事实：括号组后不能用空格接 phrase',
    );
    const ok = /** @type {{ n: number }} */ (
      db.prepare('SELECT count(*) AS n FROM t WHERE t MATCH ?').get('("展" OR "板") AND "尺"')
    );
    assert.equal(Number(ok.n), 1, '显式 AND 后同一查询必须可执行');
  } finally {
    db.close();
  }
});

test('buildFtsMatch 段间一律显式 AND（括号组后不许跟空格 + phrase）', () => {
  const plan = buildFtsMatch('展板成品尺寸 铝板厚度');
  assert.equal(plan.ok, true);
  assert.equal(plan.segments, 2);
  // 一段走 OR（6 token > 4）、一段走 phrase → 连接处必须是 `) AND "`
  assert.ok(plan.query.includes(') AND "'), `段间必须显式 AND，实际：${plan.query}`);
  // 不许出现「括号组后直接空格接引号」的形态
  assert.equal(/\)\s+"/.test(plan.query), false, `括号组后不许用空格接 phrase：${plan.query}`);

  // 纯 phrase 段之间也要 AND（口径统一，别只修 OR 那一支）
  assert.equal(buildFtsMatch('铜版纸 名片').query, '"铜 版 纸" AND "名 片"');
});

test('buildTrigramMatch 段间同样用显式 AND（与 buildFtsMatch 口径一致）', () => {
  // 两段都 ≥3 字符才会都进 trigram（<3 是静默 0 命中，见 §3.4）
  assert.equal(buildTrigramMatch('建施-03 首层层高').query, '"建施-03" AND "首层层高"');
  // 短段被跳过时不留下悬空的连接符
  assert.equal(buildTrigramMatch('建施-03 层高').query, '"建施-03"');
});

test('多段 / OR+phrase 混合查询生成串能被真实 FTS5 执行（不许抛语法错）', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize = 'unicode61')");
    const insert = db.prepare('INSERT INTO t(body) VALUES (?)');
    insert.run(toSearchableText('展板成品尺寸 1200×2400mm 5mm PVC 板'));
    insert.run(toSearchableText('铝板厚度 3mm，报价 380 元一平米含税'));
    insert.run(toSearchableText('建施-03 图里首层平面标高 0.00，层高 3.6m'));
    insert.run(toSearchableText('调用 readSurface 读取画布像素前先等重绘完成'));

    /** @type {string[]} */
    const dangerous = [
      '展板成品尺寸 铝板厚度', // OR 段 + phrase 段（原 bug 触发点）
      '展板成品尺寸 铝板厚度 含税', // 三段混合
      '上次那个铜版纸名片的报价是多少 含税', // 长口语段 + 短段
      '建施-03 首层标高 1.2m', // 图号 + 尺寸 + 中文
      'build:web 与 deletion_epoch 的关系', // 代码标识符 + 中文
      '展板 铝板 报价 尺寸 厚度 材质', // 六短段
    ];
    for (const raw of dangerous) {
      const plan = buildFtsMatch(raw);
      if (!plan.ok) continue; // 纯符号无 token 是允许的
      try {
        db.prepare('SELECT count(*) AS n FROM t WHERE t MATCH ?').get(plan.query);
      } catch (err) {
        assert.fail(`查询串被 FTS5 拒绝（${raw}）：${plan.query}\n${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    db.close();
  }
});

