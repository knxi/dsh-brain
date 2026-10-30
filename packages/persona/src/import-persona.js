// @ts-check
/**
 * `import-persona` —— 人格文件解析与导入（系统 4 上半 · 1）。
 *
 * ── 这个模块只做三件事 ──
 *
 * 1. **解析**：把 markdown 人格文件（`~/.dsh/AGENTS.md` 那种「`## 一、我是谁` +
 *    列表 / 表格」结构）拆成九个字段。
 * 2. **认「没解析到」**：解析不到的字段进 `needsReview` 列表（返回给调用方），
 *    **不猜**。猜出来的「价值观」比空的更危险——它会被当成主人的立场去说话。
 * 3. **导入**：建 `persona_profiles` + 首版 `persona_versions(status='draft')`，
 *    并算 `source_hash`（内容 sha256），供「文件没改就不用重新导入」判断。
 *
 * ── 为什么只读、绝不回写 ──
 *
 * 主人的人格文件是主人手写的（方案 §7.7：「导入」不是「夺权」）。
 * 本模块**只读文件**，所有结构化结果一律落库（`persona_profiles` / `persona_versions`）。
 * 想改人格，主人去改文件；想改注入内容，改激活版本。两条路不许混。
 *
 * ── 九个字段与章节的对应关系（显式写死，不做语义相似度猜）──
 *
 * | 字段 | 主要来源（标题关键词） |
 * |---|---|
 * | identity | 我是谁 / 身份 / 自我介绍 |
 * | values | 想成为 / 价值 / 原则 / 追求 |
 * | boundaries | 底线 / 边界 / 守的 / 红线 |
 * | tone | 性格 / 语气 / 表达 / 情绪 / 风格 |
 * | address | **全文件**扫描「称呼」条目（称呼往往写在「关于主人」里） |
 * | relationshipDefaults | 关于主人 / 关系 / 相处 / 对用户 |
 * | taboos | 底线章节 + **全文件**强否定句（不许/禁止/绝不/别把…） |
 * | examples | **全文件**表格行 + 代码块（「状态 → 文字上的样子」这种对照） |
 * | longTermDirectives | 自检 / 怎么干活 / 连续性 / 检查自己 / 长期 / 守则 |
 *
 * 章节标题先剥掉编号前缀（`一、`、`1.1 `、`（一）`）再匹配关键词；
 * `###` 子标题若自身匹配不到角色，**继承最近的上级章节角色**（不继承到「猜」的程度）。
 * 完全匹配不到角色的章节记进 `ignoredSections`（诚实列出，不假装解析过）。
 */

import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { BrainError } from './core.js';
import {
  DEFAULT_PERSONA_NAME,
  estimateTokens,
  hashOf,
  newId,
  optionalString,
  requireEnum,
  requireString,
  resolveScopeId,

} from './util.js';

/** 九个人格字段（顺序即渲染优先级顺序的基础部分）。 */
export const PERSONA_FIELDS = Object.freeze([
  'identity',
  'values',
  'boundaries',
  'tone',
  'address',
  'relationshipDefaults',
  'taboos',
  'examples',
  'longTermDirectives',
]);

/** 导入来源类型（0008 的 CHECK）。 */
export const SOURCE_TYPES = Object.freeze(['agents_md', 'markdown', 'json', 'yaml', 'manual']);

/**
 * 章节角色规则。**顺序即优先级**（多条命中时按这个顺序排进 roles，
 * 内容按角色分别提取，不再二选一——「七、关于主人」同时喂 address 与
 * relationshipDefaults 是正确行为，不是歧义）。
 */
const ROLE_RULES = Object.freeze([
  { role: 'identity', patterns: [/我是谁/, /身份/, /自我介绍/, /角色定位/, /^名字/, /我是谁/] },
  { role: 'values', patterns: [/想成为/, /价值/, /原则/, /追求/, /在乎/, /信念/] },
  { role: 'boundaries', patterns: [/底线/, /边界/, /守的/, /红线/, /不可越界/] },
  { role: 'tone', patterns: [/性格/, /语气/, /表达/, /风格/, /情绪/, /说话/, /口吻/, /个性/] },
  { role: 'address', patterns: [/称呼/, /叫法/, /称谓/, /怎么叫/] },
  { role: 'relationshipDefaults', patterns: [/关于主人/, /关于用户/, /关系/, /相处/, /对用户/, /对象/] },
  { role: 'taboos', patterns: [/禁忌/, /雷区/, /忌讳/] },
  { role: 'examples', patterns: [/示例/, /例子/, /样例/, /举例/, /对照/] },
  {
    role: 'longTermDirectives',
    patterns: [/自检/, /检查自己/, /长期/, /守则/, /指令/, /怎么干活/, /干活/, /连续性/, /规矩/, /每次/],
  },
]);

/** 强否定标记：命中即进 `taboos` 候选（全局扫描，去重）。 */
const TABOO_MARKERS = /(不许|禁止|严禁|不准|不得|绝不能|绝不|不要|别把|别让|别再|别每|别硬|不主动|不能)/;

/**
 * 全局禁忌句的取材门槛。
 *
 * 「强否定词」在人格文件里到处都是（「绝不靠猜」「不主动灌长文」是**做事标准**，
 * 不是禁忌）。禁忌的形态是**短、直接**：所以只收两类行——行很短（<=80 字），
 * 或否定词出现在前 24 字内。剩下的宁可归到别的字段，也不让 taboos 变垃圾桶。
 */
const TABOO_LINE_MAX = 80;
const TABOO_EARLY_INDEX = 24;
/** 成长记录/日期条目：是历史，不是长期指令。 */
const DATED_RECORD_RE = /^\d{4}-\d{2}-\d{2}\s*[：:]/;

/** 识别「`**键**：值`」这种条目（列表项或单独一行）。 */
const KEY_VALUE_RE = /^\s*(?:[-*+]|\d+[.)])?\s*\*\*([^*]{1,30})\*\*\s*[：:]\s*(.+)$/;

/** 章节标题编号前缀：`一、`、`（一）`、`1.`、`1.1`、`八之一、`。 */
const HEADING_NUMBER_PREFIX_RE = /^(?:第?[一二三四五六七八九十百零〇]+(?:之[一二三四五六七八九十]+)?[、.．]|[（(][一二三四五六七八九十百零〇]+[)）]|\d+(?:\.\d+)*[.、．)]?)\s*/;

/**
 * 解析 markdown 人格文本 → 九个字段 + 待人工确认清单。
 *
 * 纯函数：不碰 IO、不碰 DB、不依赖当前时间——所以可以拿任意文件反复跑对拍。
 *
 * @param {string} markdown 人格文件全文
 * @param {{ requireFields?: readonly string[] }} [options]
 * @returns {{
 *   fields: Record<string, any>,
 *   needsReview: Array<{ field: string, reason: string, detail: string }>,
 *   sections: Array<{ title: string, level: number, roles: string[] }>,
 *   ignoredSections: string[],
 *   stats: { lines: number, headings: number, bullets: number, tables: number, codeBlocks: number },
 * }}
 */
export function parsePersonaMarkdown(markdown, options = {}) {
  if (typeof markdown !== 'string') {
    throw new BrainError('INVALID_ARGUMENT', 'parsePersonaMarkdown 需要 markdown 文本');
  }
  const text = markdown.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');

  // ── 第一步：切章节 ──
  /** @type {Array<{ level: number, title: string, rawTitle: string, lines: string[], roles: string[] }>} */
  const sections = [{ level: 0, title: '(前言)', rawTitle: '(前言)', lines: [], roles: [] }];
  let fenceOpen = false;
  let codeBlocks = 0;
  let tables = 0;
  let bullets = 0;
  let headings = 0;

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (/^\s*```/.test(line)) {
      if (!fenceOpen) codeBlocks += 1;
      fenceOpen = !fenceOpen;
      sections[sections.length - 1].lines.push(line);
      continue;
    }
    if (fenceOpen) {
      sections[sections.length - 1].lines.push(line);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      headings += 1;
      sections.push({
        level: heading[1].length,
        title: heading[2].trim(),
        rawTitle: heading[2].trim(),
        lines: [],
        roles: [],
      });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) tables += 1;
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) bullets += 1;
    sections[sections.length - 1].lines.push(line);
  }

  // ── 第二步：给章节贴角色（标题关键词） ──
  sections[0].roles = [];
  /** @type {string[]} */
  let parentRoles = [];
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    if (section.level === 0) continue;
    const bareTitle = section.title.replace(HEADING_NUMBER_PREFIX_RE, '').trim();
    /** @type {string[]} */
    const own = [];
    for (const rule of ROLE_RULES) {
      if (rule.patterns.some((re) => re.test(section.title) || re.test(bareTitle))) own.push(rule.role);
    }
    if (own.length > 0) {
      section.roles = own;
    } else if (section.level >= 3 && parentRoles.length > 0) {
      // 子标题自身没关键词时继承上级角色：`### 1.1 名字` 挂在 `## 一、我是谁` 下面仍算 identity。
      section.roles = parentRoles.slice();
    }
    if (section.level <= 2) parentRoles = section.roles;
  }

  // ── 第三步：按角色收内容 ──
  /** @type {Record<string, any>} */
  const fields = {
    identity: { name: null, role: null, selfDescription: null, notes: [] },
    values: [],
    boundaries: [],
    tone: { personality: [], expression: [], notes: [] },
    address: { term: null, avoid: null, notes: [] },
    relationshipDefaults: { stance: null, notes: [] },
    taboos: [],
    examples: [],
    longTermDirectives: [],
  };
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Set<string>} */
  const exampleKeys = new Set();

  /**
   * 去重推入字符串列表（同一字段内不做重复条目：人格文件里「别把自己弄丢」这类
   * 句子会出现在多处，重复进注入文本只浪费预算）。
   * @param {string[]} list
   * @param {string} value
   * @param {string} key
   */
  const pushUnique = (list, value, key) => {
    const id = `${key}|${value}`;
    if (value.length === 0 || seen.has(id)) return;
    seen.add(id);
    list.push(value);
  };

  /**
   * @param {string | null} state
   * @param {string} value
   * @param {string} kind
   */
  const pushExample = (state, value, kind) => {
    const id = `${kind}|${state ?? ''}|${value}`;
    if (value.length === 0 || exampleKeys.has(id)) return;
    exampleKeys.add(id);
    fields.examples.push({ kind, lang: null, state, text: value });
  };

  for (const section of sections) {
    const roleSet = new Set(section.roles);
    let fence = false;
    /** @type {string[]} */
    let fenceLines = [];
    let fenceLang = '';

    for (let i = 0; i < section.lines.length; i += 1) {
      const raw = section.lines[i];
      if (/^\s*```/.test(raw)) {
        if (!fence) {
          fence = true;
          fenceLang = raw.replace(/^\s*```/, '').trim();
          fenceLines = [];
        } else {
          fence = false;
          const code = fenceLines.join('\n');
          if (code.trim().length > 0) pushExample(null, code, 'code');
        }
        continue;
      }
      if (fence) {
        fenceLines.push(raw);
        continue;
      }

      // 表格：`| a | b |`（跳过表头分隔行）。表格行是「状态 → 文字上的样子」这类对照，
      // 全局都收进 examples —— 这是 examples 唯一可靠的机器可读来源。
      if (/^\s*\|.*\|\s*$/.test(raw)) {
        if (/^\s*\|[\s:|-]+\|\s*$/.test(raw)) continue;
        const cells = raw.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
        if (cells.length >= 2) {
          const state = stripInline(cells[0]);
          const text = stripInline(cells.slice(1).join(' / '));
          if (state.length > 0 && text.length > 0 && !/^(真实状态|状态|场景)$/.test(state)) {
            pushExample(state, text, 'table');
          }
        }
        continue;
      }

      const cleaned = raw.trim();
      if (cleaned.length === 0) continue;
      if (/^>\s?/.test(cleaned)) continue; // 引述块是说明，不是人格条目
      if (/^[-*_]{3,}$/.test(cleaned)) continue; // 分隔线
      if (/^_.*_$/.test(cleaned)) continue; // 结尾斜体说明

      const isBullet = /^\s*(?:[-*+]|\d+[.)])\s+/.test(raw);
      const itemText = cleanItem(raw);
      if (itemText.length === 0) continue;

      // identity
      if (roleSet.has('identity')) {
        const kv = KEY_VALUE_RE.exec(raw);
        if (kv) {
          const key = kv[1].trim();
          const value = stripInline(kv[2]);
          if (/^(名字|名称|name)$/i.test(key)) fields.identity.name = fields.identity.name ?? value;
          else if (/^(身份|角色|role)$/i.test(key)) fields.identity.role = fields.identity.role ?? value;
          else if (/^(底色|定位|本质|self)$/i.test(key)) fields.identity.selfDescription = fields.identity.selfDescription ?? value;
          else pushUnique(fields.identity.notes, `${key}：${value}`, 'identity');
        } else if (isBullet) {
          pushUnique(fields.identity.notes, itemText, 'identity');
        } else if (fields.identity.selfDescription === null) {
          // 第一章的第一段自由正文就是「我是谁」的自述；后续段落进 notes。
          fields.identity.selfDescription = itemText;
        } else {
          pushUnique(fields.identity.notes, itemText, 'identity');
        }
      }

      // values / boundaries / taboos(章节) / longTermDirectives
      if (roleSet.has('values') && (isBullet || /^\*\*/.test(cleaned))) {
        pushUnique(fields.values, itemText, 'values');
      }
      if (roleSet.has('boundaries') && (isBullet || /^\*\*/.test(cleaned))) {
        pushUnique(fields.boundaries, itemText, 'boundaries');
      }
      if (roleSet.has('taboos')) pushUnique(fields.taboos, itemText, 'taboos');
      if (roleSet.has('longTermDirectives') && isBullet && !DATED_RECORD_RE.test(itemText)) {
        pushUnique(fields.longTermDirectives, itemText, 'directives');
      }

      // tone：按章节标题细分到 personality / expression / notes
      if (roleSet.has('tone') && (isBullet || /^\*\*/.test(cleaned))) {
        const bucket = toneBucketOf(section.title);
        pushUnique(fields.tone[bucket], itemText, `tone.${bucket}`);
      }

      // relationshipDefaults
      if (roleSet.has('relationshipDefaults') && (isBullet || /^\*\*/.test(cleaned))) {
        pushUnique(fields.relationshipDefaults.notes, itemText, 'rel');
      }

      // examples（章节里显式的「示例：」行）
      if (roleSet.has('examples') && itemText.length > 0) {
        pushExample(null, itemText, 'text');
      }

      // taboos：全局强否定句（不受章节限制，去重后进候选）。
      // 取材门槛见 TABOO_LINE_MAX / TABOO_EARLY_INDEX：短句或否定词靠前的才收。
      const tabooAt = TABOO_MARKERS.exec(cleaned);
      if (tabooAt && !roleSet.has('taboos') && (itemText.length <= TABOO_LINE_MAX || tabooAt.index <= TABOO_EARLY_INDEX)) {
        pushUnique(fields.taboos, itemText, 'taboos');
      }

      // address：全局扫描（称呼经常写在「关于主人」里）
      if (/(称呼|叫法|称谓|怎么叫)/.test(cleaned)) {
        extractAddress(itemText, fields.address);
      }
    }
  }

  // ── 第四步：补齐可推导但不猜的东西 ──
  // 称呼兜底：从任何一行里找 `叫「X」`（包括身份章节的「叫「主人」」）。
  if (fields.address.term === null) {
    for (const raw of lines) {
      const match = /叫\s*[「“"]([^」”"]{1,12})[」”"]/.exec(raw);
      if (match) {
        fields.address.term = match[1];
        fields.address.notes.push(`从原文提取：${stripInline(raw)}`);
        break;
      }
    }
  }
  // 关系默认定位：不推导（猜一个「平等搭档」很容易，但那不是主人的原话）——
  // 只从原文里找显式的「身份」条目。
  if (fields.identity.role && /搭档|伙伴|朋友|伴侣|同事/.test(fields.identity.role)) {
    fields.relationshipDefaults.stance = fields.identity.role;
  }

  // ── 第五步：待人工确认（解析不到就列出来，不猜） ──
  /** @type {Array<{ field: string, reason: string, detail: string }>} */
  const needsReview = [];
  const requireFields = options.requireFields ?? PERSONA_FIELDS;
  for (const field of requireFields) {
    if (!fieldHasContent(fields, field)) {
      needsReview.push({
        field,
        reason: 'not_found',
        detail: `没有可从标题/条目判定的「${field}」内容（不猜：宁可留空，也不要编一条出来）`,
      });
    }
  }
  // 章节覆盖情况：有内容但没匹配到任何角色的章节如实列出（供主人补规则或改标题）。
  // H1 是文档标题，不算「没识别的章节」。
  const ignoredSections = sections
    .filter(
      (section) =>
        section.level >= 2 && section.roles.length === 0 && section.lines.some((line) => line.trim().length > 0),
    )
    .map((section) => section.rawTitle);

  return {
    fields,
    needsReview,
    sections: sections.filter((section) => section.level > 0).map((section) => ({ title: section.rawTitle, level: section.level, roles: section.roles })),
    ignoredSections,
    stats: { lines: lines.length, headings, bullets, tables, codeBlocks },
  };
}

/**
 * 把章节标题归到 tone 的哪个桶。
 * 判不出来就进 `notes`（不强行归类，`personality` 和 `expression` 混用会让注入文本自相矛盾）。
 * @param {string} title
 * @returns {'personality' | 'expression' | 'notes'}
 */
function toneBucketOf(title) {
  if (/性格|脾气|个性/.test(title)) return 'personality';
  if (/表达|措辞|语气|说话|口吻/.test(title)) return 'expression';
  return 'notes';
}

/**
 * 从一行里抽称呼：「叫「主人」，不用「你」」→ `{term:'主人', avoid:'你'}`。
 * @param {string} line
 * @param {{ term: string | null, avoid: string | null, notes: string[] }} address
 */
function extractAddress(line, address) {
  const termMatch = /叫\s*[「“"]([^」”"]{1,12})[」”"]/.exec(line);
  if (termMatch && !address.term) address.term = termMatch[1];
  const avoidMatch = /(?:不用|别叫|不要叫|别喊)\s*[「“"]([^」”"]{1,12})[」”"]/.exec(line);
  if (avoidMatch && !address.avoid) address.avoid = avoidMatch[1];
  const note = stripInline(line);
  if (note.length > 0 && !address.notes.includes(note)) address.notes.push(note);
}


/**
 * 列表项/编号项清洗：去标记、去行内 markdown、压空白。
 * @param {string} raw
 * @returns {string}
 */
function cleanItem(raw) {
  return stripInline(
    raw
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\s+/, '')
      .trim(),
  );
}

/**
 * 行内 markdown 清洗：粗体/斜体/行内代码/链接 → 纯文本。
 * **保留「」引号**：称呼、禁忌里的原话引号是语义的一部分。
 * @param {string} value
 * @returns {string}
 */
function stripInline(value) {
  return String(value)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * 字段是否有内容（needsReview 的判定口径）。
 * @param {Record<string, any>} fields
 * @param {string} field
 * @returns {boolean}
 */
export function fieldHasContent(fields, field) {
  const value = fields?.[field];
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    for (const entry of Object.values(value)) {
      if (Array.isArray(entry) ? entry.length > 0 : entry !== null && entry !== undefined && String(entry).trim() !== '') return true;
    }
    return false;
  }
  return String(value).trim().length > 0;
}

/**
 * 九字段 → 五层。
 *
 * 分层立场（决定了冲突能不能被自动消解）：
 * - `locked`：**身份 + 边界 + 禁忌**。这三样是主人手写的底线，任何自动合并都不许改。
 * - `base`：价值观 / 语气 / 称呼 / 关系默认 / 例子 / 长期指令（可以随版本演进）。
 * - `learned` / `userOverride` / `transient`：导入时**一律留空**。
 *   导入不该假装「学到了什么」，也不该替主人写覆盖层。
 * @param {Record<string, any>} fields
 * @returns {Record<string, Record<string, any>>}
 */
export function layersFromFields(fields) {
  return {
    locked: {
      identity: fields.identity,
      boundaries: fields.boundaries,
      taboos: fields.taboos,
    },
    base: {
      values: fields.values,
      tone: fields.tone,
      address: fields.address,
      relationshipDefaults: fields.relationshipDefaults,
      examples: fields.examples,
      longTermDirectives: fields.longTermDirectives,
    },
    learned: {},
    userOverride: {},
    transient: {},
  };
}

/**
 * 读人格文件（只读）。
 * @param {string} filePath
 * @returns {{ filePath: string, text: string, sourceHash: string, bytes: number, mtime: string }}
 */
export function readPersonaFile(filePath) {
  const resolved = requireString(filePath, 'filePath');
  /** @type {{ text: string, hash: string, bytes: number, mtime: string }} */
  let read;
  try {
    const stat = statSync(resolved, { throwIfNoEntry: false });
    if (!stat || !stat.isFile()) {
      throw new BrainError('NOT_FOUND', `人格文件不存在或不是普通文件：${resolved}`);
    }
    const text = readFileSync(resolved, 'utf8');
    read = { text, hash: hashOf(text), bytes: Buffer.byteLength(text, 'utf8'), mtime: stat.mtime.toISOString() };
  } catch (err) {
    if (err instanceof BrainError) throw err;
    throw new BrainError('STORAGE_IO', `读取人格文件失败：${resolved}`, { cause: err });
  }
  return { filePath: resolved, text: read.text, sourceHash: read.hash, bytes: read.bytes, mtime: read.mtime };
}

/**
 * 从文件名/内容推断来源类型。
 * @param {string} filePath
 * @returns {'agents_md' | 'markdown' | 'json' | 'yaml'}
 */
export function inferSourceType(filePath) {
  const base = path.basename(filePath).toLowerCase();
  const ext = path.extname(base);
  if (base === 'agents.md' || base === 'agents.md.bak' || /^agents.*\.md$/.test(base)) return 'agents_md';
  if (ext === '.json') return 'json';
  if (ext === '.yaml' || ext === '.yml') return 'yaml';
  return 'markdown';
}

/**
 * 人格导入器。
 *
 * 依赖注入：`versions` 是 `createPersonaVersions(...)` 的返回值——
 * 首版版本统一走 `createVersion`（分层校验、diff、渲染、token 估算都只有一份实现）。
 *
 * @param {{
 *   db: import('node:sqlite').DatabaseSync,
 *   queue: { write: <T>(fn: (tx: any) => T, meta?: { label?: string }) => Promise<T> },
 *   clock: { stamp: () => { utc: string, local: string, epoch_ms?: number }, timeZone?: string },
 *   scopeId?: string,
 *   bindings?: { scope_id?: string },
 *   versions: { createVersion: (input: any) => Promise<any> },
 * }} options
 */
export function createPersonaImporter(options) {
  const { db, queue, clock } = options;
  const scopeId = resolveScopeId(options);
  const versions = options.versions;
  if (!versions || typeof versions.createVersion !== 'function') {
    throw new BrainError('INVALID_ARGUMENT', 'createPersonaImporter 需要注入 versions（createPersonaVersions 的返回值）');
  }

  /**
   * 导入一份人格文件。**只读文件、只写库**。
   *
   * 幂等口径：同一 `(scope_id, name)` 已存在且 `source_hash` 未变 → 直接返回
   * `{ created:false, unchanged:true, ... }`，**不新建版本**。
   * 这正是「文件改了才需要重新导入」的落地：哈希是判断依据，不是人眼比对 mtime。
   *
   * @param {{
   *   scopeId?: string,
   *   name?: string,
   *   filePath: string,
   *   sourceType?: string,
   *   changeReason?: string,
   * }} input
   * @returns {Promise<{
   *   created: boolean,
   *   unchanged: boolean,
   *   profileId: string,
   *   versionId: string | null,
   *   version: number | null,
   *   sourceHash: string,
   *   sourceType: string,
   *   needsReview: Array<{ field: string, reason: string, detail: string }>,
   *   ignoredSections: string[],
   *   stats: Record<string, number>,
   * }>}
   */
  async function importFromFile(input = /** @type {any} */ ({})) {
    if (input.scopeId !== undefined && input.scopeId !== null && String(input.scopeId) !== scopeId) {
      throw new BrainError('FORBIDDEN_SCOPE', `importFromFile 的 scopeId 与绑定不一致：${String(input.scopeId)} ≠ ${scopeId}`);
    }
    const file = readPersonaFile(requireString(input.filePath, 'filePath'));
    const sourceType = requireEnum(input.sourceType ?? inferSourceType(file.filePath), SOURCE_TYPES, 'sourceType', {
      fallback: 'markdown',
    });
    if (sourceType === 'json' || sourceType === 'yaml') {
      throw new BrainError(
        'INVALID_ARGUMENT',
        `sourceType=${sourceType} 的解析器本轮未实现（只支持 markdown 类人格文件）；请先用 markdown 或 manual 导入`,
      );
    }
    const name = requireString(input.name ?? DEFAULT_PERSONA_NAME, 'name').trim();
    const parsed = parsePersonaMarkdown(file.text);
    const layers = layersFromFields(parsed.fields);
    const stamp = clock.stamp();

    // ── 已存在同一份档案？哈希没变就不新建版本 ──
    const existingRow = /** @type {Record<string, any> | undefined} */ (
      db.prepare('SELECT * FROM persona_profiles WHERE scope_id = ? AND name = ?').get(scopeId, name)
    );
    if (existingRow && String(existingRow.source_hash ?? '') === file.sourceHash) {
      return {
        created: false,
        unchanged: true,
        profileId: String(existingRow.id),
        versionId: null,
        version: null,
        sourceHash: file.sourceHash,
        sourceType: String(existingRow.source_type),
        needsReview: parsed.needsReview,
        ignoredSections: parsed.ignoredSections,
        stats: parsed.stats,
      };
    }

    const profileId = existingRow ? String(existingRow.id) : newId('ppr');
    await queue.write(
      (tx) => {
        if (existingRow) {
          tx.run(
            `UPDATE persona_profiles
                SET source_type = ?, source_path = ?, source_hash = ?, updated_at = ?, updated_at_local = ?
              WHERE id = ? AND scope_id = ?`,
            [sourceType, file.filePath, file.sourceHash, stamp.utc, stamp.local, profileId, scopeId],
          );
        } else {
          tx.run(
            `INSERT INTO persona_profiles (
               id, scope_id, name, source_type, source_path, source_hash, is_default, status,
               created_at, created_at_local, updated_at, updated_at_local
             ) VALUES (?, ?, ?, ?, ?, ?, 0, 'draft', ?, ?, ?, ?)`,
            [profileId, scopeId, name, sourceType, file.filePath, file.sourceHash, stamp.utc, stamp.local, stamp.utc, stamp.local],
          );
        }
      },
      { label: 'persona.importFromFile.profile' },
    );

    const created = await versions.createVersion({
      profileId,
      layers,
      changeReason: input.changeReason ?? `import:${path.basename(file.filePath)}`,
      sourceHash: file.sourceHash,
      createdBy: 'import-persona',
    });

    return {
      created: !existingRow,
      unchanged: false,
      profileId,
      versionId: created.id,
      version: created.version,
      sourceHash: file.sourceHash,
      sourceType,
      needsReview: parsed.needsReview,
      ignoredSections: parsed.ignoredSections,
      stats: parsed.stats,
    };
  }

  /**
   * 只判定「文件是否需要重新导入」（不写库）。
   * 控制台/插件可以每次启动先问一句，哈希没变就跳过。
   * @param {{ name?: string, filePath: string, scopeId?: string }} input
   * @returns {{ filePath: string, sourceHash: string, changed: boolean, profileId: string | null }}
   */
  function inspectFile(input = /** @type {any} */ ({})) {
    if (input.scopeId !== undefined && input.scopeId !== null && String(input.scopeId) !== scopeId) {
      throw new BrainError('FORBIDDEN_SCOPE', `inspectFile 的 scopeId 与绑定不一致：${String(input.scopeId)}`);
    }
    const file = readPersonaFile(requireString(input.filePath, 'filePath'));
    const name = optionalString(input.name, 'name') ?? DEFAULT_PERSONA_NAME;
    const row = /** @type {Record<string, any> | undefined} */ (
      db.prepare('SELECT id, source_hash FROM persona_profiles WHERE scope_id = ? AND name = ?').get(scopeId, name)
    );
    return {
      filePath: file.filePath,
      sourceHash: file.sourceHash,
      changed: !row || String(row.source_hash ?? '') !== file.sourceHash,
      profileId: row ? String(row.id) : null,
    };
  }

  /**
   * 只解析不导入（控制台预览 / 测试对拍用）。
   * @param {{ filePath?: string, markdown?: string }} input
   */
  function previewFile(input = /** @type {any} */ ({})) {
    const markdown = input.markdown !== undefined
      ? requireString(input.markdown, 'markdown', { allowEmpty: true })
      : readPersonaFile(requireString(input.filePath, 'filePath')).text;
    const parsed = parsePersonaMarkdown(markdown);
    return { ...parsed, layers: layersFromFields(parsed.fields), tokenEstimate: estimateTokens(JSON.stringify(parsed.fields)) };
  }

  return { importFromFile, inspectFile, previewFile, parsePersonaMarkdown, layersFromFields };
}
