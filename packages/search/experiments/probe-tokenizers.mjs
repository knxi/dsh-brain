// @ts-check
/**
 * 实验 1：本机 node:sqlite 的 FTS5 / tokenizer 能力实测。
 *
 * 目的：不靠文档、不靠推测，直接在本机 SQLite 构建上测出：
 *   1. FTS5 是否编译进来；
 *   2. trigram / unicode61 / porter / ascii / remove_diacritics / case_sensitive 能否建成；
 *   3. 每个 tokenizer 对中文、尺寸、图号、代码标识符真实切出什么 token（用 fts5vocab 直读，
 *      不是猜测）；
 *   4. MATCH 用原始输入 vs 转义 phrase 的差异（决定查询构造方式）；
 *   5. trigram 的短查询边界（单字 / 两字 / 三字）。
 *
 * 运行：cd E:\ds-h\dsh-brain && node packages/search/experiments/probe-tokenizers.mjs
 * 产物：experiments/results/tokenizers.json（stdout 同时打印人读版本）
 *
 * 只用 :memory: 合成数据，不碰任何生产文件。
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, 'results');

/** 探针文本：每条只压一个风险点。 */
const PROBES = [
  { key: 'zh_sentence', text: '用readSurface读取画布像素前要先等重绘完成' },
  { key: 'drawing_no', text: '建施-03图里首层平面标高是0.000，层高3.6m' },
  { key: 'size_units', text: '1200mm×2400mm的板材，喷绘精度1440dpi' },
  { key: 'code_ident', text: 'deletion_epoch与pnpm run build:web' },
  { key: 'mixed_cn_en', text: 'FTS5的trigram分词器对三字以上中文才有效' },
  { key: 'accent', text: 'Café résumé 色卡，PANTONE 186C' },
];

/** 待测 tokenizer 规格。键名短、唯一，用于建表。 */
const TOKENIZER_SPECS = [
  { key: 'unicode61', spec: 'unicode61' },
  { key: 'trigram', spec: 'trigram' },
  { key: 'porter', spec: 'porter' },
  { key: 'ascii', spec: 'ascii' },
  { key: 'unicode61_rd0', spec: 'unicode61 remove_diacritics 0' },
  { key: 'unicode61_rd2', spec: 'unicode61 remove_diacritics 2' },
  { key: 'porter_unicode61', spec: 'porter unicode61' },
  { key: 'trigram_cs', spec: 'trigram case_sensitive 1' },
  { key: 'unicode61_no_sep', spec: "unicode61 separators ' '", note: '只把空格当分隔符' },
];

/** MATCH 查询要测的点：原始输入 vs 转义 phrase。 */
const MATCH_QUERIES = [
  { q: '铜版', kind: 'zh_twochar' },
  { q: '铜', kind: 'zh_single' },
  { q: '建施-03', kind: 'drawing_no' },
  { q: 'JS-2026-017', kind: 'drawing_no' },
  { q: '1200mm', kind: 'size_unit' },
  { q: '2400×600', kind: 'size_unit' },
  { q: '1.2m', kind: 'size_unit' },
  { q: 'readSurface', kind: 'code_ident' },
  { q: 'deletion_epoch', kind: 'code_ident' },
  { q: 'build:web', kind: 'code_ident' },
  { q: 'M100', kind: 'code_ident' },
];

/** 短查询边界测试的文本与长度序列。 */
const SHORT_QUERY_CASES = ['铜', '铜版', '铜版纸', '铜版纸反', 'readSurface', 'read', 'R', 'r'];

/** FTS5 查询字符串必须转义：整串当一个 phrase。 */
function toFtsPhrase(raw) {
  return '"' + String(raw).replaceAll('"', '""') + '"';
}

function tryCall(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** 直读 FTS5 索引里实际存在的 token（fts5vocab），不是推测分词结果。 */
function vocabOf(db, ftsTable) {
  const vtab = `vocab_${ftsTable}`;
  db.exec(`CREATE VIRTUAL TABLE ${vtab} USING fts5vocab(${ftsTable}, row)`);
  return db.prepare(`SELECT term, doc, cnt FROM ${vtab} ORDER BY term`).all();
}

function main() {
  mkdirSync(RESULTS, { recursive: true });
  const out = {
    generated_at: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    sqlite: {},
    fts5: {},
    tokenizers: [],
    vocab: {},
    match_matrix: [],
    short_query: [],
    notes: [],
  };

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA journal_mode=WAL');

  // ---------- A. 环境 ----------
  const ver = db.prepare('SELECT sqlite_version() AS v, sqlite_source_id() AS sid').get();
  out.sqlite.version = ver.v;
  out.sqlite.source_id = ver.sid;

  const compileOpts = db.prepare('SELECT * FROM pragma_compile_options').all().map((r) => r.compile_options);
  out.sqlite.compile_options_fts5 = compileOpts.filter((o) => /FTS5|FTS|ICU|JSON/i.test(o));
  out.sqlite.compile_option_count = compileOpts.length;
  out.sqlite.fts5_compileoption_used = db.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS x").get().x;

  // ---------- B. FTS5 基础可用性 ----------
  out.fts5.basic_create = tryCall(() => {
    db.exec("CREATE VIRTUAL TABLE fts_basic USING fts5(content)");
    db.prepare('INSERT INTO fts_basic(content) VALUES (?)').run('铜版纸反光严重');
    const n = db.prepare('SELECT count(*) AS c FROM fts_basic').get().c;
    const hit = db.prepare('SELECT count(*) AS c FROM fts_basic WHERE fts_basic MATCH ?').get('铜版纸').c;
    return { rows: n, match_whole_token_hits: hit };
  });

  // ---------- C. 各 tokenizer 建表 + 切 token ----------
  for (const { key, spec, note } of TOKENIZER_SPECS) {
    const table = `fts_${key}`;
    const entry = { key, spec, note: note ?? null, table, create: null, vocab: null, error: null };
    const created = tryCall(() => db.exec(`CREATE VIRTUAL TABLE ${table} USING fts5(content, tokenize="${spec}")`));
    if (!created.ok) {
      entry.create = 'failed';
      entry.error = created.error;
    } else {
      entry.create = 'ok';
      const ins = db.prepare(`INSERT INTO ${table}(content) VALUES (?)`);
      for (const p of PROBES) ins.run(p.text);
      const v = tryCall(() => vocabOf(db, table));
      if (v.ok) {
        entry.vocab = v.value.map((r) => ({ term: r.term, doc: r.doc, cnt: r.cnt }));
      } else {
        entry.error = `vocab 读取失败: ${v.error}`;
      }
    }
    out.tokenizers.push(entry);
  }

  // 每个探针文本在每个 tokenizer 下切出多少 token——一眼看出中文是否被整段吞掉
  out.vocab = Object.fromEntries(
    out.tokenizers.map((t) => [
      t.key,
      {
        create: t.create,
        term_count: t.vocab ? t.vocab.length : null,
        terms: t.vocab ? t.vocab.map((x) => x.term) : null,
      },
    ]),
  );

  // ---------- D. MATCH 查询：原始输入 vs 转义 phrase ----------
  // 用最可能的两个中文 tokenizer 做对照：unicode61 与 trigram
  for (const tk of ['unicode61', 'trigram']) {
    const table = `fts_${tk}`;
    const exists = out.tokenizers.find((t) => t.key === tk)?.create === 'ok';
    if (!exists) {
      out.notes.push(`跳过 ${tk} 的 MATCH 矩阵：该 tokenizer 未建成`);
      continue;
    }
    // 重建数据：清空后灌入语料（语料在 eval 脚本里，这里只用小探针集，保持本脚本独立）
    db.exec(`DELETE FROM ${table}`);
    const ins = db.prepare(`INSERT INTO ${table}(content) VALUES (?)`);
    for (const p of PROBES) ins.run(p.text);

    for (const { q, kind } of MATCH_QUERIES) {
      const raw = tryCall(() =>
        db.prepare(`SELECT rowid, content FROM ${table} WHERE ${table} MATCH ?`).all(q),
      );
      const phrase = tryCall(() =>
        db.prepare(`SELECT rowid, content FROM ${table} WHERE ${table} MATCH ?`).all(toFtsPhrase(q)),
      );
      out.match_matrix.push({
        tokenizer: tk,
        query: q,
        kind,
        raw_ok: raw.ok,
        raw_hits: raw.ok ? raw.value.length : null,
        raw_error: raw.ok ? null : raw.error,
        phrase_ok: phrase.ok,
        phrase_hits: phrase.ok ? phrase.value.length : null,
        phrase_error: phrase.ok ? null : phrase.error,
      });
    }
  }

  // ---------- E. trigram 短查询边界 ----------
  const trigramOk = out.tokenizers.find((t) => t.key === 'trigram')?.create === 'ok';
  const shortTable = trigramOk ? 'fts_trigram' : 'fts_unicode61';
  if (trigramOk) {
    db.exec('DELETE FROM fts_trigram');
    db.prepare('INSERT INTO fts_trigram(content) VALUES (?)').run('铜版纸反光严重，建议换哑粉。');
    for (const q of SHORT_QUERY_CASES) {
      const raw = tryCall(() =>
        db.prepare('SELECT rowid FROM fts_trigram WHERE fts_trigram MATCH ?').all(q),
      );
      out.short_query.push({
        query: q,
        chars: [...q].length,
        tokenizer: 'trigram',
        raw_ok: raw.ok,
        raw_hits: raw.ok ? raw.value.length : null,
        raw_error: raw.ok ? null : raw.error,
      });
    }
  } else {
    out.notes.push('trigram 不可用，跳过短查询边界测试');
  }
  out.short_query_table = shortTable;

  // ---------- F. 结论性判断（脚本自己算，不交给报告作者猜） ----------
  out.verdict = {
    fts5_available: out.fts5.basic_create.ok === true,
    trigram_available: out.tokenizers.find((t) => t.key === 'trigram')?.create === 'ok',
    ascii_available: out.tokenizers.find((t) => t.key === 'ascii')?.create === 'ok',
    porter_available: out.tokenizers.find((t) => t.key === 'porter')?.create === 'ok',
    unicode61_works_for_cjk_word_search:
      (out.match_matrix.find((m) => m.tokenizer === 'unicode61' && m.query === '铜版')?.raw_hits ?? 0) > 0,
    trigram_min_query_chars: out.short_query
      .filter((s) => !s.raw_ok)
      .map((s) => s.chars)
      .sort((a, b) => a - b)[0] ?? null,
  };

  db.close();

  const jsonPath = join(RESULTS, 'tokenizers.json');
  writeFileSync(jsonPath, JSON.stringify(out, null, 2) + '\n', 'utf8');

  printHuman(out, jsonPath);
  return out;
}

function padCell(s, width) {
  // 按字符数对齐（中文宽度差异不追求像素级，报告是给人读的）
  const str = String(s ?? '');
  const chars = [...str].length;
  return str + ' '.repeat(Math.max(0, width - chars));
}

function printHuman(out, jsonPath) {
  const P = (s = '') => console.log(s);
  P(`# 本机 node:sqlite / FTS5 能力实测`);
  P();
  P(`- node: ${out.node}  (${out.platform})`);
  P(`- SQLite: ${out.sqlite.version}`);
  P(`- source id: ${out.sqlite.source_id}`);
  P(`- sqlite_compileoption_used('ENABLE_FTS5') = ${out.sqlite.fts5_compileoption_used}`);
  P(`- 相关编译选项: ${out.sqlite.compile_options_fts5.join(', ') || '(无)'}`);
  P();
  P(`## FTS5 基础建表`);
  P(`create ok=${out.fts5.basic_create.ok}  ${JSON.stringify(out.fts5.basic_create.ok ? out.fts5.basic_create.value : out.fts5.basic_create.error)}`);
  P();
  P(`## tokenizer 建表结果`);
  P('| tokenizer | spec | 建表 | term 数 | 错误 |');
  P('|---|---|---|---:|---|');
  for (const t of out.tokenizers) {
    P(`| ${t.key} | \`${t.spec}\` | ${t.create} | ${t.vocab ? t.vocab.length : '-'} | ${t.error ?? ''} |`);
  }
  P();
  P(`## 各 tokenizer 对探针文本切出的 token（fts5vocab 直读）`);
  for (const t of out.tokenizers) {
    if (!t.vocab) continue;
    P();
    P(`### ${t.key} (\`${t.spec}\`) — ${t.vocab.length} 个 term`);
    P('```');
    P(t.vocab.map((r) => r.term).join(' | '));
    P('```');
  }
  P();
  P(`## MATCH 查询矩阵（原始输入 vs 转义 phrase）`);
  P('| tokenizer | 查询 | 类型 | raw ok | raw 命中 | raw 错误 | phrase ok | phrase 命中 |');
  P('|---|---|---|---|---|---|---|---|');
  for (const m of out.match_matrix) {
    P(
      `| ${m.tokenizer} | \`${m.query}\` | ${m.kind} | ${m.raw_ok} | ${m.raw_hits ?? '-'} | ${m.raw_error ?? ''} | ${m.phrase_ok} | ${m.phrase_hits ?? '-'} |`,
    );
  }
  P();
  P(`## trigram 短查询边界`);
  P('| 查询 | 字符数 | raw ok | 命中 | 错误 |');
  P('|---|---:|---|---|---|');
  for (const s of out.short_query) {
    P(`| \`${s.query}\` | ${s.chars} | ${s.raw_ok} | ${s.raw_hits ?? '-'} | ${s.raw_error ?? ''} |`);
  }
  P();
  P(`## 脚本判定`);
  for (const [k, v] of Object.entries(out.verdict)) P(`- ${k} = ${JSON.stringify(v)}`);
  P();
  P(`原始数据: ${jsonPath}`);
}

main();
