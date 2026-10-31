#!/usr/bin/env node
// ============================================================================
//  把 dsh-brain 推到 GitHub（走 REST Git Data API）
//
//  为什么不用 git push：这台机器直连 github.com 的 443 会被重置
//  （schannel 报 SEC_E_NO_CREDENTIALS，换 OpenSSL 后端则 Recv failure），
//  而 api.github.com 能通，所以走 REST。
//
//  用法（PowerShell）：
//      $env:GH_TOKEN = (Get-Content E:\ds-h\.secrets\gh-token.txt -Raw).Trim()
//      node tools/push-to-github.mjs --dry-run        # 先看会上传什么，不推
//      node tools/push-to-github.mjs -m "feat: ..."   # 真推
//
//  ⚠️ 排除规则**硬编码在这里，不读 .gitignore**。这个仓库是 public，
//     `data/brain.db` 里是主人的真实记忆（生活 / 工作 / 关系），
//     一个字节都不能出去。宁可多排，不可漏排；判断不了的一律排除。
// ============================================================================
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = process.cwd();
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error('[x] 先设置环境变量 GH_TOKEN（fine-grained PAT，需要 Contents 读写权限）');
  process.exit(1);
}

const OWNER = process.env.GH_OWNER || 'knxi';
const REPO = process.env.GH_REPO || 'dsh-brain';
const API = `https://api.github.com/repos/${OWNER}/${REPO}`;
const BRANCH = process.env.GH_BRANCH || 'main';
const H = {
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': 'dsh-brain-push',
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
};

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const msgIdx = argv.findIndex((a) => a === '-m' || a === '--message');
let MESSAGE = msgIdx >= 0 ? argv[msgIdx + 1] : '';
if (!MESSAGE) MESSAGE = `chore: sync ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;

// ---- 排除规则（硬编码，理由见文件头）-------------------------------------
/** 整目录不传。`data` 排第一：记忆库 / 日志 / 备份 / 通道配置全在里面。 */
const DENY_DIRS = new Set([
  '.git', '.pnpm', 'node_modules',
  'data', 'tmp', '_tmp', '.secrets', '.secret', '.obsidian', 'coverage', '_gh', '_dl',
]);
/** 路径片段命中就排除（截图里可能渲染过真实记忆正文）。 */
const DENY_PATH_PARTS = ['/screenshots/'];
/** 扩展名 / 文件名黑名单。 */
const DENY_FILE = [
  /\.db$/i, /\.db-wal$/i, /\.db-shm$/i, /\.sqlite3?$/i, /\.sqlite-/i,
  /\.log$/i, /\.pem$/i, /\.key$/i, /\.p12$/i, /\.pfx$/i,
];
/** 例外：允许上传（哪怕是上面命中的形状）。 */
const ALLOW_FILE = [/^\.env\.example$/i];

const denied = [];
function isDenied(relPath, name) {
  if (ALLOW_FILE.some((re) => re.test(relPath))) return false;
  if (DENY_FILE.some((re) => re.test(name))) return true;
  if (DENY_PATH_PARTS.some((part) => relPath.includes(part))) return true;
  return false;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (entry.isDirectory()) {
      if (DENY_DIRS.has(entry.name)) {
        denied.push({ rel: rel + '/', why: '目录不传' });
        continue;
      }
      walk(abs, out);
    } else if (entry.isFile()) {
      if (isDenied(rel, entry.name)) {
        denied.push({ rel, why: '文件规则命中' });
        continue;
      }
      out.push({ abs, rel });
    }
  }
  return out;
}

/** git blob sha1 = sha1("blob <len>\0" + content) */
function blobSha(buf) {
  const h = createHash('sha1');
  h.update(`blob ${buf.length}\0`);
  h.update(buf);
  return h.digest('hex');
}

async function api(path, method = 'GET', body) {
  for (let i = 1; i <= 4; i += 1) {
    try {
      const r = await fetch(API + path, {
        method,
        headers: H,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const txt = await r.text();
      if (r.status >= 500 && i < 4) { await new Promise((z) => setTimeout(z, 900 * i)); continue; }
      let json = null;
      try { json = txt ? JSON.parse(txt) : null; } catch { /* 非 JSON */ }
      return { status: r.status, json, text: txt };
    } catch (e) {
      if (i === 4) throw e;
      await new Promise((z) => setTimeout(z, 900 * i));
    }
  }
}

// ---- 0. 先扫本地（dry-run 也要这份清单）----------------------------------
const files = walk(ROOT);
const totalBytes = files.reduce((sum, f) => sum + statSync(f.abs).size, 0);
console.log(`[i] 本地候选 ${files.length} 个文件，合计 ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
console.log(`[i] 按规则排除 ${denied.length} 项`);
for (const d of denied.slice(0, 12)) console.log(`    - ${d.rel}  (${d.why})`);
if (denied.length > 12) console.log(`    … 还有 ${denied.length - 12} 项`);

// 安全检查：任何一个可能含私人数据的东西漏进来就中止
const DANGER = files.filter((f) => /(^|\/)data\//.test(f.rel) || /\.db(-wal|-shm)?$/i.test(f.rel));
if (DANGER.length > 0) {
  console.error('[x] 中止：候选清单里出现了数据文件，排除规则有洞：');
  for (const d of DANGER.slice(0, 10)) console.error('    ' + d.rel);
  process.exit(2);
}
console.log('[ok] 数据文件检查：0 个 db / 0 个 data/ 下的文件');

if (DRY) {
  console.log('\n[dry-run] 将要上传的前 30 个：');
  for (const f of files.slice(0, 30)) {
    console.log(`    ${f.rel}  (${(statSync(f.abs).size / 1024).toFixed(1)} KB)`);
  }
  if (files.length > 30) console.log(`    … 还有 ${files.length - 30} 个`);
  console.log('\n[dry-run] 没有上传任何东西。去掉 --dry-run 才真推。');
  process.exit(0);
}

// ---- 1. 远端现状 ---------------------------------------------------------
const br = await api(`/branches/${BRANCH}`);
let parentSha = null;
let baseTree = null;
const remote = new Map();

if (br.status === 200) {
  parentSha = br.json.commit.sha;
  baseTree = br.json.commit.commit.tree.sha;
  const tr = await api(`/git/trees/${BRANCH}?recursive=1`);
  if (tr.status === 200) {
    for (const e of tr.json.tree) if (e.type === 'blob') remote.set(e.path, e.sha);
  }
  console.log(`[i] 远端 HEAD ${parentSha.slice(0, 8)} · 已有 ${remote.size} 个文件`);
} else if (br.status === 404) {
  console.log('[i] 空仓库，先建初始提交');
  const readme = join(ROOT, 'README.md');
  const put = await api('/contents/README.md', 'PUT', {
    message: 'chore: init repository',
    content: readFileSync(readme).toString('base64'),
  });
  if (put.status !== 201 && put.status !== 200) {
    console.error('[x] 初始提交失败', put.status, put.text.slice(0, 300));
    process.exit(1);
  }
  parentSha = put.json.commit.sha;
  baseTree = put.json.commit.tree.sha;
  remote.clear();
} else {
  console.error('[x] 读分支失败', br.status, br.text.slice(0, 300));
  process.exit(1);
}

// ---- 2. 算变化 -----------------------------------------------------------
const changed = [];
for (const f of files) {
  const buf = readFileSync(f.abs);
  const sha = blobSha(buf);
  if (remote.get(f.rel) !== sha) changed.push({ ...f, buf, sha });
}
console.log(`[i] 需上传 ${changed.length} 个`);

if (!changed.length) {
  console.log('[ok] 没有变化，无需提交');
  process.exit(0);
}

// ---- 3. 上传 blob（并发 6）-----------------------------------------------
const tree = [];
const queue = [...changed];
let done = 0;
async function worker() {
  while (queue.length) {
    const f = queue.shift();
    const r = await api('/git/blobs', 'POST', { content: f.buf.toString('base64'), encoding: 'base64' });
    if (r.status !== 201) {
      console.error('[x] blob 失败', f.rel, r.status, r.text.slice(0, 200));
      process.exit(1);
    }
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha: r.json.sha });
    done += 1;
    if (done % 40 === 0) console.log(`    ${done}/${changed.length}`);
  }
}
await Promise.all(Array.from({ length: 6 }, worker));

// ---- 4. tree → commit → 移动分支 -----------------------------------------
const t = await api('/git/trees', 'POST', { base_tree: baseTree, tree });
if (t.status !== 201) { console.error('[x] tree 失败', t.status, t.text.slice(0, 300)); process.exit(1); }

const c = await api('/git/commits', 'POST', { message: MESSAGE, tree: t.json.sha, parents: [parentSha] });
if (c.status !== 201) { console.error('[x] commit 失败', c.status, c.text.slice(0, 300)); process.exit(1); }

const ref = await api(`/git/refs/heads/${BRANCH}`, 'PATCH', { sha: c.json.sha, force: true });
if (ref.status !== 200) { console.error('[x] 更新分支失败', ref.status, ref.text.slice(0, 300)); process.exit(1); }

console.log(`[ok] 已推送 ${changed.length} 个文件 → https://github.com/${OWNER}/${REPO}`);
console.log(`     commit ${c.json.sha.slice(0, 8)} · ${MESSAGE.split('\n')[0]}`);
