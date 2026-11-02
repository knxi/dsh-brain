// @ts-check
/**
 * 本机 SQLite / FTS5 能力回归测试。
 *
 * 为什么要测：中文检索方案完全押在「trigram 可用但两字查不了、unicode61 需要
 * char-space」这两条实测事实上。Node 或 SQLite 升级后这些行为可能变，
 * 没有回归测试就只能靠人记得。这里把实测结论钉成断言。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

test('FTS5 编译在本机可用', () => {
  const db = new DatabaseSync(':memory:');
  const used = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS x").get().x;
  assert.equal(Number(used), 1, '本机 SQLite 没有编译 FTS5');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(body)');
  db.prepare('INSERT INTO t(body) VALUES (?)').run('测试');
  assert.equal(db.prepare('SELECT count(*) AS c FROM t').get().c, 1);
  db.close();
});

test('trigram tokenizer 可以建成', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram')");
  db.prepare('INSERT INTO t(body) VALUES (?)').run('铜版纸反光严重');
  assert.equal(db.prepare('SELECT count(*) AS c FROM t WHERE t MATCH ?').get('"铜版纸"').c, 1);
  db.close();
});

test('trigram 对 2 字符和 1 字符查询静默 0 命中（不报错）', () => {
  const db = new DatabaseSync(':memory:');
  db.exec("CREATE VIRTUAL TABLE t USING fts5(body, tokenize='trigram')");
  db.prepare('INSERT INTO t(body) VALUES (?)').run('铜版纸反光严重，建议换哑粉。');
  const two = db.prepare('SELECT count(*) AS c FROM t WHERE t MATCH ?').get('"铜版"').c;
  const one = db.prepare('SELECT count(*) AS c FROM t WHERE t MATCH ?').get('"铜"').c;
  assert.equal(two, 0, 'trigram 两字查询不再静默 0 命中，方案假设需要重新评估');
  assert.equal(one, 0, 'trigram 单字查询不再静默 0 命中，方案假设需要重新评估');
  db.close();
});

test('unicode61 把无空格中文句子连同相邻数字当成一个 token', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(body)');
  db.prepare('INSERT INTO t(body) VALUES (?)').run('首层平面标高是0.000，层高3.6m');
  db.exec('CREATE VIRTUAL TABLE v USING fts5vocab(t, row)');
  const terms = db.prepare('SELECT term FROM v ORDER BY term').all().map((r) => r.term);
  // 实测定论：中文与数字之间没有分隔符时粘成一个 token
  assert.ok(
    terms.some((t) => t.includes('首层平面标高是')),
    `期望出现整段中文 token，实际 terms=${JSON.stringify(terms)}`,
  );
  // 因此按词检索一定失败——这是 char-space 兜底存在的理由
  assert.equal(db.prepare('SELECT count(*) AS c FROM t WHERE t MATCH ?').get('"平面标高"').c, 0);
  db.close();
});

test('原始输入直接当 MATCH 参数会报语法错误（必须转义 phrase）', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE VIRTUAL TABLE t USING fts5(body)');
  db.prepare('INSERT INTO t(body) VALUES (?)').run('建施-03 图里标高 0.000');
  assert.throws(() => db.prepare('SELECT * FROM t WHERE t MATCH ?').all('建施-03'), /no such column|syntax error/i);
  assert.throws(() => db.prepare('SELECT * FROM t WHERE t MATCH ?').all('1.2m'), /syntax error/i);
  db.close();
});
