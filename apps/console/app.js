// @ts-check
/**
 * 只读检查器前端：原生 ESM，无框架，无构建。
 *
 * 纪律：
 * - 凭据从 `<meta name="brain-token">` 读（服务端注入），**不进 URL**；
 * - 所有数据用 `textContent` 落地，绝不 `innerHTML` 拼数据（主账内容不是可信 HTML）；
 * - 不写内联 style（CSP `style-src 'self'`）——动态量走属性选择器与 `<progress>`；
 * - 本地不缓存：任何「看起来是缓存」的东西都重新取，检查器宁可慢也不能显示旧事实。
 */

// ---------------------------------------------------------------------------
// 基础
// ---------------------------------------------------------------------------

const metaEl = document.querySelector('meta[name="brain-token"]');
const TOKEN = metaEl ? String(metaEl.getAttribute('content') ?? '') : '';

/**
 * 创建元素。`attrs` 里 `text` 走 textContent，`class` 走 className，其余走 setAttribute。
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {Array<Node|string|null|undefined>} [children]
 * @returns {HTMLElement}
 */
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else if (key === 'class') node.className = String(value);
    else if (key === 'html') throw new Error('不允许 innerHTML（数据必须走 textContent）');
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/** @param {string} sel @param {ParentNode} [root] */
function $(sel, root = document) {
  const node = root.querySelector(sel);
  if (node === null) throw new Error(`缺少 DOM 节点: ${sel}`);
  return node;
}

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** ISO → 本地时间（带秒时去掉，够用且不吵）。 */
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/** ISO → 只到日期。 */
function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

/** @param {number|null} n */
function fmtBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** @param {number} v */
function fmtScore(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—';
}

function shortHash(hash, len = 10) {
  if (typeof hash !== 'string' || hash.length === 0) return '—';
  const bare = hash.replace(/^sha256:/, '');
  return bare.slice(0, len);
}

/** 截断长标识（producer 之类），保留原值到 title 里。 */
function trim(value, max = 26) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, query?: Record<string, unknown> }} [options]
 */
async function api(path, options = {}) {
  const url = new URL(path, location.origin);
  for (const [k, v] of Object.entries(options.query ?? {})) {
    if (v === null || v === undefined || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  /** @type {Record<string,string>} */
  const headers = { Authorization: `Bearer ${TOKEN}` };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    cache: 'no-store',
  });
  const text = await res.text();
  /** @type {any} */
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = /** @type {Error & {status?: number, code?: string}} */ (
      new Error(json?.error?.message ?? `HTTP ${res.status}`)
    );
    err.status = res.status;
    err.code = json?.error?.code;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------------------
// 连接状态
// ---------------------------------------------------------------------------

const connEl = $('#conn');
const connTextEl = $('#conn-text');

/** 上一次的连接状态。用来防止「后来的成功把已有的故障状态盖掉」。 */
let connState = 'pending';

/**
 * @param {'pending'|'ok'|'warn'|'down'} state
 * @param {string} text
 * @param {{ force?: boolean }} [opts] force=true 时才允许 ok 覆盖 down（健康检查恢复时用）
 */
function setConn(state, text, opts = {}) {
  // 已经报过故障就别急着显示「已连接」——一次成功的检索不代表整条链路好了。
  if (opts.force !== true && connState === 'down' && state !== 'down') return;
  connState = state;
  connEl.setAttribute('data-state', state);
  connTextEl.textContent = text;
}

/** @param {unknown} err */
function describeError(err) {
  const e = /** @type {Error & {status?: number, code?: string}} */ (err);
  if (e?.status === 401) return '凭据无效或已轮换 —— 重启服务后刷新本页（凭据不写进 URL，无法手工补）';
  if (e?.status === 403) return '被准入闸门拒绝（Host / Origin 不在允许列表）';
  if (e?.status === 503) return '服务暂时不可用（存储繁忙或写入队列已关闭）';
  return e?.message ?? String(err);
}

/**
 * 把异常变成面板里的一个错误块（不静默、不吞）。
 * @param {HTMLElement} host
 * @param {unknown} err
 * @param {string} what
 */
function renderError(host, err, what) {
  host.replaceChildren(
    el('div', { class: 'empty empty--tall' }, [
      el('span', { class: 'empty__mark', text: '!' }),
      el('p', { text: `${what}失败` }),
      el('p', { class: 'empty__hint', text: describeError(err) }),
    ]),
  );
  setConn('down', '连不上');
}

// ---------------------------------------------------------------------------
// 视图切换
// ---------------------------------------------------------------------------

const VIEWS = ['memories', 'context', 'search', 'deletions', 'backups', 'health'];
const loaded = new Set();

/**
 * @param {string} view
 */
function showView(view) {
  const target = VIEWS.includes(view) ? view : 'memories';
  for (const name of VIEWS) {
    const section = /** @type {HTMLElement} */ ($(`#view-${name}`));
    section.hidden = name !== target;
  }
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.setAttribute('aria-selected', btn.getAttribute('data-view') === target ? 'true' : 'false');
  }
  if (location.hash !== `#${target}`) history.replaceState(null, '', `#${target}`);
  if (!loaded.has(target)) {
    loaded.add(target);
    if (target === 'memories') loadMemories();
    if (target === 'context') loadContexts();
    if (target === 'deletions') loadDeletions();
    if (target === 'backups') loadBackups();
    if (target === 'health') loadHealth();
  }
}

for (const btn of document.querySelectorAll('#tabs button')) {
  btn.addEventListener('click', () => showView(String(btn.getAttribute('data-view'))));
}
window.addEventListener('hashchange', () => showView(location.hash.slice(1)));

// ---------------------------------------------------------------------------
// 1. 记忆
// ---------------------------------------------------------------------------

const memRows = $('#mem-rows');
const memDetail = $('#mem-detail');
const memCount = $('#mem-count');
const memPager = $('#mem-pager');
const memPrev = $('#mem-prev');
const memNext = $('#mem-next');
const memPagerNote = $('#mem-pager-note');

const memState = {
  /** @type {any[]} */ items: [],
  /** @type {string[]} */ cursorStack: [],
  nextCursor: /** @type {string|null} */ (null),
  selected: /** @type {string|null} */ (null),
  keyword: '',
};

function currentFilters() {
  return {
    layer: /** @type {HTMLSelectElement} */ ($('#f-layer')).value,
    type: /** @type {HTMLSelectElement} */ ($('#f-type')).value,
    status: /** @type {HTMLSelectElement} */ ($('#f-status')).value,
  };
}

/**
 * @param {{ cursor?: string|null, pushStack?: boolean }} [options]
 */
async function loadMemories(options = {}) {
  const filters = currentFilters();
  try {
    const data = await api('/api/memories', {
      query: { ...filters, limit: 50, cursor: options.cursor ?? null },
    });
    memState.items = data.items ?? [];
    memState.nextCursor = data.nextCursor ?? null;
    if (options.pushStack === true) {
      // 用「上一页的游标」当栈：返回时用栈顶重新取，不猜 offset。
      const prev = options.cursor ?? null;
      if (prev !== null) memState.cursorStack.push(prev);
    }
    memCount.textContent = `${data.items.length} / ${data.total ?? '?'} 条`;
    renderMemRows();
    renderMemPager();
    if (memState.items.length > 0 && memState.selected === null) {
      selectMemory(memState.items[0].id);
    }
  } catch (err) {
    renderError(memRows, err, '读取记忆');
  }
}

function renderMemRows() {
  const keyword = memState.keyword.trim().toLowerCase();
  const items = keyword.length === 0
    ? memState.items
    : memState.items.filter((m) => `${m.summary ?? ''} ${m.content ?? ''}`.toLowerCase().includes(keyword));

  if (items.length === 0) {
    memRows.replaceChildren(
      el('tr', {}, [
        el('td', { colspan: '6', class: 'empty', text: keyword ? '当前页没有匹配这条关键词的记忆' : '没有记忆（或过滤条件太窄）' }),
      ]),
    );
    return;
  }

  memRows.replaceChildren(
    ...items.map((m) => {
      const tr = el('tr', { 'data-id': m.id }, [
        el('td', {}, [el('div', { class: 'cell-summary', text: m.summary || m.content || '(无摘要)' })]),
        el('td', {}, [
          el('div', { class: 'cell-kind' }, [
            el('b', { text: m.type }),
            el('span', { text: m.layer }),
          ]),
        ]),
        el('td', {}, [sourceBadges(m)]),
        el('td', {}, [el('span', { class: 'num', text: `v${m.version}` })]),
        el('td', { class: 'cell-valid' }, [validityCell(m)]),
        el('td', {}, [confidenceCell(m)]),
      ]);
      tr.addEventListener('click', () => selectMemory(m.id));
      if (m.id === memState.selected) tr.setAttribute('aria-selected', 'true');
      return tr;
    }),
  );
}

/** @param {any} m */
function validityCell(m) {
  const from = m.validFrom ? fmtDate(m.validFrom) : null;
  const until = m.validUntil ? fmtDate(m.validUntil) : null;
  if (from === null && until === null) return el('span', { class: 'num', text: '长期' });
  const frag = document.createDocumentFragment();
  frag.append(el('div', { class: 'num', text: from ?? '…' }));
  frag.append(
    el('div', { class: 'num', text: until === null ? '至今' : `至 ${until}` }),
  );
  return frag;
}

/** @param {any} m */
function confidenceCell(m) {
  const v = typeof m.confidence === 'number' ? m.confidence : 0;
  const tier = v >= 0.8 ? 'high' : v < 0.5 ? 'low' : 'mid';
  const progress = /** @type {HTMLProgressElement} */ (el('progress', { max: '1', value: String(v) }));
  return el('div', { class: 'conf', 'data-tier': tier }, [
    progress,
    el('span', { class: 'conf__v', text: v.toFixed(2) }),
  ]);
}

/** 来源三档：已核对 / 无法验证 / 丢失。三档必须分开显示，不能折成一个数字。 */
function sourceBadges(m) {
  const stats = m.sourceStats ?? { total: 0, verified: 0, unverifiable: 0, missing: 0 };
  const wrap = el('div', { class: 'src-badges' });
  if (stats.total === 0) {
    wrap.append(el('span', { class: 'src-badge', 'data-tier': 'none', text: '无来源' }));
    return wrap;
  }
  if (stats.verified > 0) {
    wrap.append(el('span', { class: 'src-badge', 'data-tier': 'verified', text: `${stats.verified} ✓` }));
  }
  if (stats.unverifiable > 0) {
    wrap.append(el('span', { class: 'src-badge', 'data-tier': 'unverifiable', text: `${stats.unverifiable} ?` }));
  }
  if (stats.missing > 0) {
    wrap.append(el('span', { class: 'src-badge', 'data-tier': 'missing', text: `${stats.missing} ✕` }));
  }
  return wrap;
}

function renderMemPager() {
  memPager.hidden = false;
  memPrev.disabled = memState.cursorStack.length === 0;
  memNext.disabled = memState.nextCursor === null;
  memPagerNote.textContent = memState.cursorStack.length === 0 ? '第 1 页' : `第 ${memState.cursorStack.length + 1} 页`;
}

memNext.addEventListener('click', () => {
  if (memState.nextCursor === null) return;
  loadMemories({ cursor: memState.nextCursor, pushStack: true });
});
memPrev.addEventListener('click', () => {
  memState.cursorStack.pop();
  const cursor = memState.cursorStack.length === 0 ? null : memState.cursorStack[memState.cursorStack.length - 1];
  // 回退时不再压栈：直接按栈顶游标取
  const saved = [...memState.cursorStack];
  loadMemories({ cursor, pushStack: false }).then(() => {
    memState.cursorStack = saved;
    renderMemPager();
  });
});

$('#mem-filters').addEventListener('submit', (event) => {
  event.preventDefault();
  memState.cursorStack = [];
  memState.selected = null;
  loadMemories();
});
$('#f-q').addEventListener('input', (event) => {
  memState.keyword = /** @type {HTMLInputElement} */ (event.target).value;
  renderMemRows();
});
for (const id of ['#f-layer', '#f-type', '#f-status']) {
  $(id).addEventListener('change', () => {
    memState.cursorStack = [];
    memState.selected = null;
    loadMemories();
  });
}

/**
 * @param {string} id
 */
async function selectMemory(id) {
  memState.selected = id;
  for (const tr of memRows.querySelectorAll('tr')) {
    if (tr.getAttribute('data-id') === id) tr.setAttribute('aria-selected', 'true');
    else tr.removeAttribute('aria-selected');
  }
  memDetail.replaceChildren(el('div', { class: 'empty', text: '读取详情…' }));
  try {
    const data = await api(`/api/memories/${encodeURIComponent(id)}`);
    renderMemoryDetail(data.memory);
  } catch (err) {
    renderError(memDetail, err, '读取记忆详情');
  }
}

/** @param {any} m */
function renderMemoryDetail(m) {
  const head = el('div', { class: 'detail-head' }, [
    el('div', { class: 'detail-head__row' }, [
      el('span', { class: 'chip', 'data-tone': m.status === 'active' ? 'green' : 'muted', text: m.status }),
      el('span', { class: 'chip', text: m.type }),
      el('span', { class: 'chip', text: m.layer }),
      el('span', { class: 'chip', text: `v${m.version}` }),
      m.tombstoned ? el('span', { class: 'chip', 'data-tone': 'brick', text: '已屏蔽' }) : null,
    ]),
    el('h3', { text: m.summary || '(无摘要)' }),
    el('p', { class: 'detail-head__id', text: m.id }),
  ]);

  if (m.tombstoned) {
    head.append(
      el('p', {
        class: 'notice',
        text: '这条记忆已被删除墓碑屏蔽：检索不到，正文也只是「还没被 worker 清掉」。它不能再作为证据。',
      }),
    );
  }

  const body = el('div', { class: 'detail-body' });

  // 正文
  if (typeof m.content === 'string' && m.content.length > 0) {
    body.append(
      el('section', {}, [
        el('h4', { class: 'sec-title', text: '正文' }),
        el('p', { class: 'cell-summary', text: m.content }),
      ]),
    );
  }

  // 关键字段
  body.append(
    el('section', {}, [
      el('h4', { class: 'sec-title', text: '元数据' }),
      el('dl', { class: 'kv' }, [
        el('dt', { text: '来源类型' }),
        el('dd', {}, [el('span', { class: 'chip', text: m.sourceType })]),
        el('dt', { text: '置信度 / 重要度' }),
        el('dd', {}, [el('span', { class: 'num', text: `${Number(m.confidence).toFixed(2)} / ${Number(m.importance).toFixed(2)}` })]),
        el('dt', { text: '有效期' }),
        el('dd', {}, [
          el('span', {
            class: 'num',
            text: `${m.validFrom ? fmtDate(m.validFrom) : '…'} → ${m.validUntil ? fmtDate(m.validUntil) : '至今'}`,
          }),
        ]),
        el('dt', { text: '隐私' }),
        el('dd', {}, [el('span', { class: 'chip', text: m.privacy })]),
        el('dt', { text: '创建 / 更新' }),
        el('dd', {}, [el('span', { class: 'num', text: `${fmtTime(m.createdAt)} / ${fmtTime(m.updatedAt)}` })]),
        el('dt', { text: '被召回' }),
        el('dd', {}, [el('span', { class: 'num', text: `${m.recallCount} 次 · 提及 ${m.mentionCount} 次` })]),
        el('dt', { text: 'content hash' }),
        el('dd', {}, [el('span', { class: 'num', text: shortHash(m.contentHash) })]),
      ]),
    ]),
  );

  // 来源（最要紧：三态分开）
  body.append(
    el('section', {}, [
      el('h4', { class: 'sec-title', text: `来源 · ${m.sources.length} 条` }),
      m.sources.length === 0
        ? el('p', {
            class: 'notice',
            text: '没有任何来源引用。这类记忆不能当作证据使用，只能当线索。',
          })
        : el(
            'div',
            { class: 'seglist' },
            m.sources.map((ref) => {
              const ok = ref.verification?.ok;
              const mark = ok === true ? '✓' : ok === null ? '?' : '✕';
              const verdict = ok === true ? '已核对' : ok === null ? `无法验证（${ref.verification?.reason ?? '外部资源'}）` : `失败（${ref.verification?.reason}）`;
              return el('div', { class: 'seg__ref', 'data-ok': String(ok) }, [
                el('span', { class: 'mark', text: mark }),
                el('span', { text: ref.kind }),
                el('em', { text: ref.eventId ? `event ${shortHash(ref.eventId, 12)}` : ref.locator ? String(ref.locator) : '无定位' }),
                el('span', { text: verdict }),
              ]);
            }),
          ),
    ]),
  );

  // 版本历史
  if (Array.isArray(m.versions) && m.versions.length > 0) {
    body.append(
      el('section', {}, [
        el('h4', { class: 'sec-title', text: '版本历史' }),
        el(
          'div',
          { class: 'seglist' },
          m.versions.map((v) =>
            el('div', { class: 'seg' }, [
              el('div', { class: 'seg__top' }, [
                el('span', { class: 'chip', text: `v${v.version}` }),
                el('span', { class: 'chip', 'data-tone': v.status === 'active' ? 'green' : 'muted', text: v.status }),
                el('span', { class: 'chip', text: trim(v.changedBy), title: v.changedBy }),
              ]),
              el('div', { class: 'seg__meta' }, [
                el('span', { text: fmtTime(v.createdAt) }),
                v.changeReason ? el('span', { text: v.changeReason }) : null,
                el('span', { text: shortHash(v.contentHash) }),
              ]),
            ]),
          ),
        ),
      ]),
    );
  }

  // 取代链
  if (Array.isArray(m.supersedeChain) && m.supersedeChain.length > 0) {
    body.append(
      el('section', {}, [
        el('h4', { class: 'sec-title', text: '取代链' }),
        el(
          'div',
          { class: 'drop-list' },
          m.supersedeChain.map((link) =>
            el('div', { class: 'drop-item' }, [
              el('code', { text: `${link.relation} → ${link.id}` }),
              el('span', { text: link.summary ?? '' }),
            ]),
          ),
        ),
      ]),
    );
  }

  // 时点回看
  if (m.asOf) {
    body.append(
      el('section', {}, [
        el('h4', { class: 'sec-title', text: `时点回看 · ${fmtDate(m.asOf.at)}` }),
        el('p', {
          class: m.asOf.inEffect ? 'ceiling-note' : 'caveat',
          text: m.asOf.note,
        }),
      ]),
    );
  }

  memDetail.replaceChildren(head, body);
}

// ---------------------------------------------------------------------------
// 2. 上下文检查器
// ---------------------------------------------------------------------------

const ctxList = $('#ctx-list');
const ctxDetail = $('#ctx-detail');

const ctxState = { /** @type {any[]} */ items: [], selected: /** @type {string|null} */ (null) };

const LEVEL_TONE = /** @type {Record<string,string>} */ ({ built: 'slate', attached: 'amber', sent: 'green' });

const CEILING_SENTENCE = {
  built: '本次只证到 built —— 包建好了，宿主还没接收，更没有请求边界的证据。所以不能说「已注入模型」。',
  attached: '本次到 attached —— 宿主已经接收了这个包，但仍无请求边界证据，还不能说「发出去了」。',
  sent: '本次到 sent —— 最终请求对象里命中了这个 payload。这只证到「宿主决定把这些内容发出去」，不等于字节出网。',
  none: '这个包已失效，不能再当作注入证据。',
};

async function loadContexts() {
  try {
    const data = await api('/api/contexts', {
      query: { sessionId: /** @type {HTMLInputElement} */ ($('#ctx-session')).value.trim(), limit: 50 },
    });
    ctxState.items = data.items ?? [];
    renderContextList();
    if (ctxState.items.length === 0) {
      ctxDetail.replaceChildren(
        el('div', { class: 'empty empty--tall' }, [
          el('span', { class: 'empty__mark', text: '◫' }),
          el('p', { text: '还没有构包记录' }),
          el('p', { class: 'empty__hint', text: '构包由 context 层写入 context_packages；这一块只读不造。' }),
        ]),
      );
    } else if (ctxState.selected === null) {
      selectContext(ctxState.items[0].contextId);
    }
    // 连接状态统一由 loadHealth 负责：一次成功的列表请求不代表整条链路都健康。
  } catch (err) {
    renderError(ctxList, err, '读取构包列表');
  }
}

function renderContextList() {
  if (ctxState.items.length === 0) {
    ctxList.replaceChildren(el('li', { class: 'empty', text: '没有构包' }));
    return;
  }
  ctxList.replaceChildren(
    ...ctxState.items.map((item) => {
      const tone = item.status === 'discarded' || item.status === 'expired' ? 'brick' : LEVEL_TONE[item.status] ?? 'muted';
      const li = el('li', { class: 'pkg', 'data-id': item.contextId }, [
        el('div', { class: 'pkg__row' }, [
          el('span', { class: 'dot', 'data-tone': tone }),
          el('span', { class: 'pkg__id', text: item.contextId }),
        ]),
        el('div', { class: 'pkg__meta' }, [
          el('span', { text: item.status }),
          el('span', { text: `${item.segmentCount} 段` }),
          el('span', { text: `${item.estimatedTokens ?? '?'} tk` }),
        ]),
        el('div', { class: 'pkg__meta' }, [el('span', { text: fmtTime(item.builtAt) })]),
      ]);
      li.addEventListener('click', () => selectContext(item.contextId));
      if (item.contextId === ctxState.selected) li.setAttribute('aria-selected', 'true');
      return li;
    }),
  );
}

/** @param {string} id */
async function selectContext(id) {
  ctxState.selected = id;
  for (const li of ctxList.querySelectorAll('.pkg')) {
    if (li.getAttribute('data-id') === id) li.setAttribute('aria-selected', 'true');
    else li.removeAttribute('aria-selected');
  }
  ctxDetail.replaceChildren(el('div', { class: 'empty', text: '读取构包…' }));
  try {
    const data = await api(`/api/context/${encodeURIComponent(id)}`);
    renderContextDetail(data);
  } catch (err) {
    renderError(ctxDetail, err, '读取构包详情');
  }
}

/** @param {any} data */
function renderContextDetail(data) {
  const pkg = data.package ?? {};
  const evidence = data.evidence ?? { ceiling: 'none', steps: [], caveats: [] };
  const ceiling = evidence.ceiling ?? 'none';

  const head = el('div', { class: 'detail-head' }, [
    el('div', { class: 'detail-head__row' }, [
      el('span', { class: 'chip', 'data-tone': LEVEL_TONE[ceiling] ?? 'brick', text: `证据上限：${ceiling}` }),
      el('span', { class: 'chip', text: `policy ${pkg.policyVersion ?? '—'}` }),
      el('span', { class: 'chip', text: `epoch ${pkg.deletionEpoch ?? 0}` }),
      // 弱证据徽章：命中来自兜底路径时要一眼看见
      evidence.evidenceStrength && evidence.evidenceStrength !== 'primary'
        ? el('span', { class: 'chip', 'data-tone': 'brick', text: `弱证据 ${evidence.evidenceStrength}` })
        : null,
    ]),
    el('h3', { text: `构包 ${pkg.contextId ?? ''}` }),
    el('p', { class: 'detail-head__id', text: `payload ${shortHash(pkg.payloadHash, 24)}` }),
  ]);

  const body = el('div', { class: 'detail-body' });

  // ---- 三级阶梯
  body.append(
    el('section', {}, [
      el('h4', { class: 'sec-title', text: '证据阶梯' }),
      el(
        'div',
        { class: 'ladder' },
        ['built', 'attached', 'sent'].map((level) => {
          const step = (evidence.steps ?? []).find((s) => s.level === level) ?? { proven: false, basis: '未记录' };
          return el('div', { class: 'step', 'data-level': level, 'data-proven': String(step.proven === true) }, [
            el('span', { class: 'step__name', text: level }),
            el('span', { class: 'step__state', text: step.proven ? '已证实' : '无证据' }),
            el('span', { class: 'step__time', text: step.proven ? fmtTime(step.at) : '—' }),
            el('span', { class: 'step__basis', text: step.basis ?? '' }),
          ]);
        }),
      ),
      el('p', { class: 'ceiling-note', 'data-level': ceiling, text: CEILING_SENTENCE[ceiling] ?? CEILING_SENTENCE.none }),
    ]),
  );

  // ---- 元数据
  body.append(
    el('section', {}, [
      el('h4', { class: 'sec-title', text: '元数据' }),
      el('dl', { class: 'kv' }, [
        el('dt', { text: '会话 / 回合' }),
        el('dd', {}, [el('span', { class: 'num', text: `${pkg.sessionId ?? '—'} / ${pkg.turnId ?? '—'}` })]),
        el('dt', { text: 'Token' }),
        el('dd', {}, [
          el('span', { class: 'num', text: `${pkg.estimatedTokens ?? '—'}` }),
          el('span', { class: 'chip', text: pkg.tokenizerId ?? 'tokenizer 未知' }),
        ]),
        el('dt', { text: '段数' }),
        el('dd', {}, [el('span', { class: 'num', text: String(pkg.segmentCount ?? 0) })]),
        el('dt', { text: '构建时间' }),
        el('dd', {}, [el('span', { class: 'num', text: fmtTime(pkg.builtAt) })]),
        el('dt', { text: '载体' }),
        el('dd', {}, [
          // 0003 的 carrier 列记录的是「实际观测到的承载位置」，有就显示具体是哪一级
          evidence.carrierLabel
            ? el('span', { class: 'chip', 'data-tone': 'green', text: evidence.carrierLabel })
            : el('span', { class: 'chip', 'data-tone': 'muted', text: '未记录' }),
        ]),
      ]),
      el('p', { class: 'caveat caveat--info', text: evidence.carrierNote ?? '' }),
    ]),
  );

  // ---- 预算
  const budget = data.budget ?? { recorded: false };
  body.append(
    el('section', {}, [
      el('h4', { class: 'sec-title', text: 'Token 预算' }),
      budget.recorded
        ? el('dl', { class: 'kv' }, [
            el('dt', { text: '额度' }),
            el('dd', {}, [el('span', { class: 'num', text: String(budget.allowance ?? '—') })]),
            el('dt', { text: '已用' }),
            el('dd', {}, [
              el('span', { class: 'num', text: String(budget.used ?? '—') }),
              el('span', { class: 'chip', text: `共 ${pkg.estimatedTokens ?? '?'} tk` }),
            ]),
            el('dt', { text: '来源' }),
            el('dd', {}, [el('span', { text: budget.source ?? '—' })]),
          ])
        : el('p', { class: 'notice', text: budget.note ?? '本次构包未记录预算明细。' }),
      budget.recorded && Array.isArray(budget.dropped) && budget.dropped.length > 0
        ? el('div', {}, [
            el('h4', { class: 'sec-title', text: `被丢掉的段 · ${budget.dropped.length}` }),
            el(
              'div',
              { class: 'drop-list' },
              budget.dropped.map((drop) =>
                el('div', { class: 'drop-item' }, [
                  el('code', {
                    text: drop.summary
                      ? drop.summary
                      : `${String(drop.memoryId ?? '?')}${drop.stillExists === false ? '（已不在主账）' : ''}`,
                  }),
                  el('span', { text: String(drop.reason ?? '未给理由') }),
                ]),
              ),
            ),
          ])
        : null,
    ]),
  );

  // ---- 注入了什么
  const segments = Array.isArray(data.segments) ? data.segments : [];
  body.append(
    el('section', {}, [
      el('h4', { class: 'sec-title', text: `注入的段 · ${segments.length}` }),
      segments.length === 0
        ? el('p', { class: 'notice', text: '这个包没有段。可能是检索不足时的如实降级（空段 + 说明），也可能只是还没装内容。' })
        : el(
            'div',
            { class: 'seglist' },
            segments.map((seg) => {
              const missing = seg.missing === true;
              const refs = Array.isArray(seg.sourceRefs) ? seg.sourceRefs : [];
              return el('div', { class: missing ? 'seg seg--missing' : 'seg' }, [
                el('div', { class: 'seg__top' }, [
                  el('div', { class: 'seg__sum', text: seg.summary ?? (missing ? '（这一段已无法核对）' : '(无摘要)') }),
                  seg.layer ? el('span', { class: 'chip', text: String(seg.layer) }) : null,
                  seg.type ? el('span', { class: 'chip', text: String(seg.type) }) : null,
                ]),
                el('div', { class: 'seg__meta' }, [
                  el('span', { text: String(seg.memoryId ?? '') }),
                  el('span', { text: `v${seg.version ?? '?'}` }),
                  el('span', { text: shortHash(seg.contentHash) }),
                  seg.evidenceKind ? el('span', { text: seg.evidenceKind }) : null,
                  seg.deleted ? el('span', { text: '⚠ 已删除' }) : null,
                ]),
                seg.note ? el('p', { class: 'notice', text: seg.note }) : null,
                refs.length > 0
                  ? el(
                      'div',
                      { class: 'seg__refs' },
                      refs.map((ref) => {
                        const ok = ref.verification?.ok;
                        const mark = ok === true ? '✓' : ok === null ? '?' : '✕';
                        return el('div', { class: 'seg__ref', 'data-ok': String(ok) }, [
                          el('span', { class: 'mark', text: mark }),
                          el('span', { text: ref.kind }),
                          el('span', { text: ref.eventId ? `event ${shortHash(ref.eventId, 12)}` : '无 event' }),
                          ok === true ? null : el('em', { text: ref.verification?.reason ?? '' }),
                        ]);
                      }),
                    )
                  : el('div', { class: 'seg__refs' }, [
                      el('div', { class: 'seg__ref', 'data-ok': 'false' }, [
                        el('span', { class: 'mark', text: '✕' }),
                        el('em', { text: '这一段落进包里时没有带来源引用' }),
                      ]),
                    ]),
              ]);
            }),
          ),
    ]),
  );

  // ---- 注入文本原文
  if (typeof data.package?.injectedText === 'string' && data.package.injectedText.length > 0) {
    body.append(
      el('section', {}, [
        el('h4', { class: 'sec-title', text: '注入文本' }),
        el('p', { class: 'notice', text: data.package.injectedText }),
      ]),
    );
  }

  // ---- 断言边界说明
  const caveats = Array.isArray(evidence.caveats) ? evidence.caveats : [];
  if (caveats.length > 0) {
    body.append(
      el('section', {}, [
        el('h4', { class: 'sec-title', text: '边界说明' }),
        el('div', { class: 'caveats' }, caveats.map((c) => el('p', { class: 'caveat', text: String(c) }))),
      ]),
    );
  }

  ctxDetail.replaceChildren(head, body);
}

$('#ctx-reload').addEventListener('click', () => {
  ctxState.selected = null;
  loadContexts();
});
$('#ctx-session').addEventListener('keydown', (event) => {
  if (/** @type {KeyboardEvent} */ (event).key === 'Enter') {
    event.preventDefault();
    ctxState.selected = null;
    loadContexts();
  }
});

// ---------------------------------------------------------------------------
// 3. 检索诊断
// ---------------------------------------------------------------------------

const DIAG_TITLES = {
  ok: '命中且可核对',
  no_related: '确实没有相关记忆',
  insufficient_evidence: '有命中，但证据不够',
  source_missing: '命中了，但来源已丢失',
  source_conflict: '同一来源互相矛盾',
};

const DIAG_MARKS = { ok: '●', no_related: '○', insufficient_evidence: '△', source_missing: '✕', source_conflict: '⇄' };

const verdictEl = $('#search-verdict');
const verdictTitle = $('#verdict-title');
const verdictSub = $('#verdict-sub');
const verdictCode = $('#verdict-code');
const diagKv = $('#diag-kv');
const diagNotes = $('#diag-notes');
const hitRows = $('#hit-rows');

$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  runSearch();
});

async function runSearch() {
  const q = /** @type {HTMLInputElement} */ ($('#s-q')).value.trim();
  if (q.length === 0) {
    verdictTitle.textContent = '先输入点什么';
    return;
  }
  hitRows.replaceChildren(el('tr', {}, [el('td', { colspan: '3', class: 'empty', text: '检索中…' })]));
  try {
    const data = await api('/api/search', { query: { q } });
    renderSearch(data);
  } catch (err) {
    renderError(hitRows, err, '检索');
  }
}

/** @param {any} data */
function renderSearch(data) {
  const status = data.diagnostics?.status ?? 'no_related';
  const notes = data.diagnostics?.notes ?? [];

  verdictEl.hidden = false;
  verdictEl.setAttribute('data-status', status);
  verdictTitle.textContent = `${DIAG_MARKS[status] ?? '·'} ${DIAG_TITLES[status] ?? status}`;
  verdictSub.textContent = notes[0] ?? '';
  verdictCode.textContent = status;

  for (const card of document.querySelectorAll('.diag')) {
    if (card.getAttribute('data-status') === status) card.setAttribute('data-active', 'true');
    else card.removeAttribute('data-active');
  }

  diagKv.replaceChildren(
    el('dt', { text: 'query' }),
    el('dd', { class: 'num', text: `「${data.query ?? ''}」` }),
    el('dt', { text: '命中' }),
    el('dd', {}, [el('span', { class: 'num', text: `${(data.hits ?? []).length} 条` })]),
    el('dt', { text: '转义' }),
    el('dd', {}, [
      el('span', {
        class: 'num',
        text: data.diagnostics?.queryWasEscaped
          ? '已转义（不直进 MATCH）'
          : '短语转换后进索引',
      }),
    ]),
    el('dt', { text: '降级' }),
    el('dd', {}, [
      data.diagnostics?.degraded
        ? el('span', { class: 'chip', 'data-tone': 'amber', text: String(data.diagnostics.degraded) })
        : el('span', { class: 'chip', 'data-tone': 'green', text: '无' }),
    ]),
    el('dt', { text: '实现' }),
    el('dd', {}, [el('span', { class: 'chip', text: String(data.implementation ?? '—') })]),
  );

  diagNotes.replaceChildren(
    ...notes.map((note) => el('li', { text: String(note) })),
    el('li', { class: 'empty', text: data.statusLegend ? `状态含义：${data.statusLegend[status] ?? ''}` : '' }),
  );

  const hits = Array.isArray(data.hits) ? data.hits : [];
  if (hits.length === 0) {
    hitRows.replaceChildren(el('tr', {}, [el('td', { colspan: '3', class: 'empty', text: '没有命中' })]));
    return;
  }
  hitRows.replaceChildren(
    ...hits.map((hit) => {
      const tr = el('tr', {}, [
        el('td', {}, [el('div', { class: 'cell-summary', text: hit.summary ?? '(无摘要)' })]),
        el('td', {}, [
          el('div', { class: 'cell-kind' }, [
            el('b', { text: String(hit.evidenceKind ?? '—') }),
            el('span', { text: `${hit.layer ?? ''} · ${(hit.matchedBy ?? []).join('+')}` }),
          ]),
        ]),
        el('td', {}, [el('span', { class: 'num', text: fmtScore(Number(hit.score)) })]),
      ]);
      tr.addEventListener('click', () => {
        const id = String(hit.memoryId ?? '');
        if (id.length > 0) {
          showView('memories');
          selectMemory(id);
        }
      });
      return tr;
    }),
  );
}

// ---------------------------------------------------------------------------
// 4. 健康
// ---------------------------------------------------------------------------

async function loadHealth() {
  try {
    const data = await api('/api/health');
    window.__brainSchema = data.db?.schemaVersion;
    window.__brainHealth = data;
    renderIsolationBanner(data.isolation);
    renderHealth(data);
    const isolated = data.isolation?.active === true;
    const warn = (data.degraded ?? []).filter((d) => d.severity !== 'info');
    setConn(
      isolated ? 'down' : data.ok ? (warn.length > 0 ? 'warn' : 'ok') : 'down',
      isolated
        ? '隔离实例 · 只读检修'
        : data.ok
          ? warn.length > 0 ? `已连接 · ${warn.length} 项降级` : '已连接 · 全部正常'
          : '已连接 · 有故障',
      // 健康探测是「权威状态来源」：它说恢复了，才允许把红色改成绿色。
      { force: true },
    );
  } catch (err) {
    setConn('down', '连不上');
    renderError($('#health-degraded'), err, '读取健康状态');
  }
}

/**
 * 隔离横幅。`promoted=false` 时必须出现——这是安全要求，不是可选装饰。
 *
 * @param {any} isolation
 */
function renderIsolationBanner(isolation) {
  const banner = $('#isolation-banner');
  const active = isolation?.active === true;
  banner.hidden = !active;
  banner.setAttribute('data-active', String(active));
  if (!active) return;

  const reasons = Array.isArray(isolation?.reasons) ? isolation.reasons : [];
  $('#isolation-why').textContent = reasons.length > 0
    ? '这个实例由备份恢复而来但没通过校验，或独立删除账本不可用——它证明不了「已经删掉的东西不会复活」，所以不许对外提供正常服务。'
    : '检测到隔离状态。';
  $('#isolation-source').textContent = String(isolation?.source ?? 'unknown');
  $('#isolation-reasons').replaceChildren(
    ...reasons.map((r) =>
      el('li', { text: `${String(r.code)} · ${String(r.detail ?? '')}` }),
    ),
  );
  // 横幅出现时把页面顶部撑开，避免内容被挡住（纯类切换，不写内联样式）
  document.body.setAttribute('data-isolated', 'true');
}

/** @param {any} data */
function renderHealth(data) {
  $('#h-schema').textContent = String(data.db?.schemaVersion ?? '—');
  $('#h-size').textContent = fmtBytes(data.db?.sizeBytes);
  const journal = String(data.db?.pragmas?.journal_mode ?? '—');
  const journalEl = $('#h-journal');
  journalEl.textContent = journal;
  journalEl.setAttribute('data-tone', journal === 'wal' ? 'green' : 'amber');
  const integrity = String(data.db?.quickCheck ?? '—');
  const integrityEl = $('#h-integrity');
  integrityEl.textContent = integrity === 'ok' ? 'ok' : integrity;
  integrityEl.setAttribute('data-tone', integrity === 'ok' ? 'green' : 'brick');
  $('#h-writer').textContent = String(data.store?.writer ?? '—');
  $('#h-search-path').textContent = String(data.store?.search ?? '—');
  $('#h-file').textContent = String(data.db?.fileName ?? data.db?.path ?? '—');
  $('#h-version').textContent = String(data.version ?? '—');
  $('#h-readonly').textContent = data.db?.readOnly ? '是' : '否';
  $('#foot-ver').textContent = String(data.version ?? '—');

  // ---- M3 治理区
  const isolation = data.isolation ?? {};
  const isoEl = $('#h-isolation');
  isoEl.textContent = isolation.active === true
    ? `隔离（${String(isolation.source ?? '未知来源')}）`
    : '正常（可服务）';
  isoEl.setAttribute('data-tone', isolation.active === true ? 'brick' : 'green');

  const caps = data.capabilities ?? {};
  const onOff = (v) => (v === true ? '开' : '关');
  $('#h-caps').textContent = `${onOff(caps.write)} / ${onOff(caps.backup)} / ${onOff(caps.restore)}`;
  $('#h-caps').setAttribute(
    'data-tone',
    caps.restore === true ? 'amber' : caps.backup === true ? 'amber' : 'green',
  );

  const facades = caps.facades ?? {};
  $('#h-ledger').textContent = facades.deletionLedger === true ? '已接入' : '未接入（无法核实删除是否入账）';
  $('#h-ledger').setAttribute('data-tone', facades.deletionLedger === true ? 'green' : 'amber');
  $('#h-backup-dir').textContent = String(data.governance?.backupDir ?? '—');
  $('#h-facades').textContent = [
    `门面：删除账本 ${facades.deletionLedger === true ? '✓' : '✗'}`,
    `删除 worker ${facades.deletionWorker === true ? '✓' : '✗'}`,
    `分层报告 ${facades.deletionStatus === true ? '✓' : '✗（本地兜底）'}`,
    `恢复编排 ${facades.restore === true ? '✓' : '✗（本地预演）'}`,
    `备份增强 ${facades.backupOps === true ? '✓' : '✗（用 M1）'}`,
  ].join(' · ');

  const list = $('#health-degraded');
  const degraded = Array.isArray(data.degraded) ? data.degraded : [];
  if (degraded.length === 0) {
    list.replaceChildren(
      el('li', { class: 'empty' }, [
        el('span', {}, [el('strong', { text: '没有任何降级。' })]),
        el('div', { text: '检索索引、写入路径、PRAGMA 都按契约在跑。' }),
      ]),
    );
    return;
  }
  list.replaceChildren(
    ...degraded.map((d) =>
      el('li', { class: 'deg', 'data-severity': String(d.severity) }, [
        el('span', { class: 'deg__code', text: String(d.code) }),
        el('span', { class: 'deg__detail', text: String(d.detail) }),
      ]),
    ),
  );
}

// ---------------------------------------------------------------------------
// 5. 删除状态（四层报告）
// ---------------------------------------------------------------------------

const delList = $('#del-list');
const delDetail = $('#del-detail');

const delState = { /** @type {any[]} */ items: [], selected: /** @type {string|null} */ (null) };

/** 每层「现在是哪一步」。四层用不同的视觉，不许压成一个「已删除」。 */
function layerVisualState(layer) {
  const status = String(layer?.status ?? '');
  if (layer?.key === 'shielded') return 'done';
  if (layer?.key === 'external') return 'unknown'; // 我们永远核实不了外部副本
  if (layer?.key === 'backupExpiry') {
    if (status === 'computed') return layer.done === true ? 'done' : 'active';
    if (status === 'no_risky_backup') return 'unknown';
    return 'unknown';
  }
  if (status === 'done') return 'done';
  if (status === 'running') return 'active';
  if (status === 'failed' || status === 'partial') return 'blocked';
  if (status === 'not_started' || status === 'pending') return 'pending';
  return 'unknown';
}

const LAYER_STATE_TEXT = {
  done: '已完成',
  active: '计时中',
  pending: '还没开始',
  blocked: '需要处理',
  unknown: '无法核实',
};

const LAYER_STATUS_TEXT = {
  done: '已完成',
  not_started: '还没开始',
  pending: '排队中',
  running: '进行中',
  failed: '失败',
  partial: '部分失败',
  computed: '已算出',
  no_risky_backup: '没有这样的旧备份',
  unknown: '未知',
};

/** @param {string|null} iso */
function daysUntil(iso) {
  const d = parseIso(iso);
  if (d === null) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400_000);
}

/** @param {string|null} iso */
function parseIso(iso) {
  if (typeof iso !== 'string' || iso.length === 0) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** @param {string} iso */
function fmtDay(iso) {
  const d = parseIso(iso);
  if (d === null) return '—';
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

async function loadDeletions() {
  const scope = /** @type {HTMLSelectElement} */ ($('#del-scope')).value;
  try {
    const data = await api('/api/deletions', { query: { status: scope, limit: 50 } });
    delState.items = data.items ?? [];
    renderDeletionList(data);
    if (delState.selected === null && delState.items.length > 0) {
      selectDeletion(delState.items[0].memoryId);
    }
  } catch (err) {
    renderError(delList, err, '读取删除记录');
  }
}

/** @param {any} data */
function renderDeletionList(data) {
  if (data.available === false) {
    delList.replaceChildren(
      el('li', { class: 'empty' }, [
        el('span', {}, [el('strong', { text: '删除账本读不出来。' })]),
        el('div', { text: String(data.reason ?? '') }),
      ]),
    );
    return;
  }
  if (delState.items.length === 0) {
    delList.replaceChildren(
      el('li', { class: 'empty' }, [
        el('span', { class: 'empty__mark', text: '○' }),
        el('p', { text: '这个范围内没有删除记录' }),
        el('p', { class: 'empty__hint', text: '删除一条记忆之后，它会出现在这里，并且四层的状态会分开显示。' }),
      ]),
    );
    return;
  }

  const nodes = delState.items.map((item) => {
    const tone =
      item.status === 'done' ? 'green' : item.status === 'failed' ? 'brick' : item.status === 'not_started' ? 'muted' : 'amber';
    const li = el('li', { class: 'dele', 'data-id': item.memoryId }, [
      el('div', { class: 'dele__row' }, [
        el('span', { class: 'dot', 'data-tone': tone }),
        el('span', { class: 'dele__id', text: item.memoryId }),
      ]),
      el('div', { class: 'dele__reason', text: item.reason }),
      el('div', { class: 'dele__meta' }, [
        el('span', { text: `epoch ${item.epoch}` }),
        el('span', { text: `${item.progress.done}/${item.progress.total} 清理` }),
        el('span', { text: fmtTime(item.requestedAt) }),
      ]),
    ]);
    li.addEventListener('click', () => selectDeletion(item.memoryId));
    if (item.memoryId === delState.selected) li.setAttribute('aria-selected', 'true');
    return li;
  });

  const note = typeof data.note === 'string' && data.note.length > 0 ? data.note : '—';
  $('#del-note').textContent = note;

  delList.replaceChildren(...nodes);
}

/** @param {string} memoryId */
async function selectDeletion(memoryId) {
  delState.selected = memoryId;
  for (const li of delList.querySelectorAll('.dele')) {
    if (li.getAttribute('data-id') === memoryId) li.setAttribute('aria-selected', 'true');
    else li.removeAttribute('aria-selected');
  }
  delDetail.replaceChildren(el('div', { class: 'empty', text: '读取删除状态…' }));
  try {
    const report = await api(`/api/deletions/${encodeURIComponent(memoryId)}`);
    renderDeletionDetail(report);
  } catch (err) {
    renderError(delDetail, err, '读取删除状态');
  }
}

/** @param {any} report */
function renderDeletionDetail(report) {
  if (report.deleted !== true) {
    delDetail.replaceChildren(
      el('div', { class: 'empty empty--tall' }, [
        el('span', { class: 'empty__mark', text: '○' }),
        el('p', { text: '这条记忆没有删除墓碑' }),
        el('p', { class: 'empty__hint', text: String(report.note ?? '') }),
      ]),
    );
    return;
  }

  const head = el('div', { class: 'detail-head' }, [
    el('div', { class: 'detail-head__row' }, [
      el('span', { class: 'chip', 'data-tone': 'brick', text: '已删除' }),
      el('span', { class: 'chip', text: `epoch ${report.epoch}` }),
      report.ledgerSynced === true
        ? el('span', { class: 'chip', 'data-tone': 'green', text: '账本已记' })
        : report.ledgerSynced === false
          ? el('span', { class: 'chip', 'data-tone': 'brick', text: '账本未记' })
          : el('span', { class: 'chip', 'data-tone': 'muted', text: '账本未核实' }),
    ]),
    el('h3', { text: report.memoryId }),
    el('p', { class: 'detail-head__id', text: `${report.reason} · ${report.requestedBy} · ${report.tombstoneId}` }),
  ]);

  const body = el('div', { class: 'detail-body' });

  // 一句话结论 + 必带的前提（只放真正要人记住的那几条）
  body.append(
    el('section', {}, [
      el('p', { class: 'notice', text: String(report.summary ?? '') }),
      el(
        'div',
        { class: 'caveats' },
        (Array.isArray(report.caveats) ? report.caveats : []).map((c) =>
          el('p', { class: 'caveat caveat--info', text: String(c) }),
        ),
      ),
    ]),
  );

  // ---- 四层（顺序固定，不许合并）
  const layers = report.layers ?? {};
  const ordered = ['shielded', 'onlineCleanup', 'backupExpiry', 'external']
    .map((key) => layers[key])
    .filter(Boolean);

  body.append(
    el('section', {}, [
      el('h4', { class: 'sec-title', text: '四层状态' }),
      el(
        'div',
        { class: 'layers' },
        ordered.map((layer) => {
          const state = layerVisualState(layer);
          /** @type {Array<Node|string|null>} */
          const card = [
            el('div', { class: 'layer__head' }, [
              el('span', { class: 'layer__title', text: String(layer.title ?? layer.key) }),
              el('span', {
                class: 'chip',
                'data-tone':
                  state === 'done' ? 'green' : state === 'active' ? 'amber' : state === 'blocked' ? 'brick' : 'muted',
                text: LAYER_STATE_TEXT[state] ?? state,
              }),
              el('span', { class: 'layer__when', text: layerWhenText(layer) }),
            ]),
            el('p', { class: 'layer__basis', text: String(layer.basis ?? '') }),
          ];

          // 第 2 层：任务进度
          if (layer.key === 'onlineCleanup' && layer.jobs) {
            const total = Number(layer.jobs.total ?? 0);
            const done = Number(layer.jobs.done ?? 0);
            const extra = el('div', { class: 'layer__jobs' });
            if (total > 0) {
              extra.append(
                el('progress', { max: String(total), value: String(done) }),
                el('span', { text: `${done}/${total} 完成` }),
              );
              if (Number(layer.jobs.failed ?? 0) > 0) {
                extra.append(el('span', { text: `· ${layer.jobs.failed} 失败` }));
              }
              if (Number(layer.jobs.dead ?? 0) > 0) {
                extra.append(el('span', { text: `· ${layer.jobs.dead} 放弃` }));
              }
            } else {
              extra.append(el('span', { text: '没有清理任务被创建' }));
            }
            card.push(el('div', { class: 'layer__extra' }, [extra]));
            if (Array.isArray(layer.errors) && layer.errors.length > 0) {
              card.push(
                el('div', { class: 'layer__extra' }, [
                  el(
                    'div',
                    { class: 'caveats' },
                    layer.errors.slice(0, 3).map((e) => el('p', { class: 'caveat', text: String(e) })),
                  ),
                ]),
              );
            }
          }

          // 第 3 层：哪些旧备份还有风险
          if (layer.key === 'backupExpiry' && Array.isArray(layer.riskyBackups) && layer.riskyBackups.length > 0) {
            card.push(
              el('div', { class: 'layer__extra' }, [
                el(
                  'div',
                  { class: 'risklist' },
                  layer.riskyBackups.slice(0, 6).map((b) =>
                    el('div', { class: 'riskitem' }, [
                      el('span', { text: String(b.backupId) }),
                      el('span', { text: `${fmtDay(b.createdAt)} → ${fmtDay(b.expiresAt)}` }),
                    ]),
                  ),
                ),
              ]),
            );
          }

          // 第 4 层：外部副本 + 其它插件源
          if (layer.key === 'external') {
            card.push(
              el('div', { class: 'layer__extra' }, [
                el('div', { class: 'copysplit' }, [
                  el('div', {}, [
                    el('h5', { text: `外部副本 · ${layer.unverifiedCount ?? 0} 未核实` }),
                    el(
                      'div',
                      { class: 'copylist' },
                      (layer.externalCopies ?? []).map((c) =>
                        el('div', { class: 'copyitem', 'data-handled': String(c.verified === true) }, [
                          el('span', { class: 'copyitem__mark', text: c.verified === true ? '✓' : '✕' }),
                          el('span', {}, [
                            el('b', { text: String(c.kind) }),
                            ' ',
                            el('em', { text: String(c.note ?? '') }),
                          ]),
                        ]),
                      ),
                    ),
                  ]),
                  el('div', {}, [
                    el('h5', { text: `其它源记录 · ${layer.unhandledCount ?? 0} 未处理` }),
                    el(
                      'div',
                      { class: 'copylist' },
                      (layer.hostCopies ?? []).map((c) =>
                        el('div', { class: 'copyitem', 'data-handled': String(c.handled === true) }, [
                          el('span', { class: 'copyitem__mark', text: c.handled === true ? '✓' : '✕' }),
                          el('span', {}, [
                            el('b', { text: String(c.system) }),
                            ' ',
                            el('em', { text: String(c.note ?? '') }),
                          ]),
                        ]),
                      ),
                    ),
                  ]),
                ]),
              ]),
            );
          }

          return el('div', { class: 'layer', 'data-state': state, 'data-key': String(layer.key) }, [
            el('span', { class: 'layer__no', text: String(layer.index ?? '') }),
            el('div', { class: 'layer__card' }, card),
          ]);
        }),
      ),
    ]),
  );

  // 清理链的技术细节：放最后、字号小，不跟四层抢注意力。
  if (Array.isArray(report.notes) && report.notes.length > 0) {
    body.append(
      el('section', {}, [
        el('h4', { class: 'sec-title', text: `清理链细节 · ${report.notes.length}` }),
        el(
          'ul',
          { class: 'notes' },
          report.notes.map((n) => el('li', { text: String(n) })),
        ),
      ]),
    );
  }

  // 账本核对
  body.append(
    el('section', {}, [
      el('h4', { class: 'sec-title', text: '独立删除账本' }),
      el('p', {
        class: report.ledgerSynced === false ? 'caveat' : 'notice',
        text: String(report.ledgerDetail ?? '—'),
      }),
    ]),
  );

  delDetail.replaceChildren(head, body);
}

/** @param {any} layer */
function layerWhenText(layer) {
  if (layer.key === 'external') return '需要人工';
  if (layer.key === 'backupExpiry') {
    if (typeof layer.at !== 'string') return '无到期项';
    const days = daysUntil(layer.at);
    if (days === null) return fmtDay(layer.at);
    return days > 0 ? `${fmtDay(layer.at)}（还有 ${days} 天）` : `${fmtDay(layer.at)}（已过期）`;
  }
  if (typeof layer.at === 'string') return fmtTime(layer.at);
  return LAYER_STATUS_TEXT[String(layer.status ?? '')] ?? '—';
}

$('#del-reload').addEventListener('click', () => {
  delState.selected = null;
  loadDeletions();
});
$('#del-scope').addEventListener('change', () => {
  delState.selected = null;
  loadDeletions();
});

// ---------------------------------------------------------------------------
// 6. 备份中心
// ---------------------------------------------------------------------------

const backupRows = $('#backup-rows');
const backupDetail = $('#backup-detail');

const backupState = {
  /** @type {any[]} */ items: [],
  selected: /** @type {string|null} */ (null),
  currentEpoch: /** @type {number|null} */ (null),
  /** @type {any} */ meta: null,
};

async function loadBackups() {
  try {
    // 能力矩阵与隔离判定都在 health 里；直接打开 #backups 时它可能还没回来。
    if (!window.__brainHealth) {
      try {
        window.__brainHealth = await api('/api/health');
      } catch {
        /* 拿不到就按「能力关」展示，宁可保守 */
      }
    }
    const data = await api('/api/backups');
    backupState.items = data.items ?? [];
    backupState.currentEpoch =
      typeof data.currentDeletionEpoch === 'number' ? data.currentDeletionEpoch : null;
    backupState.meta = data;
    renderBackupCapbar(data);
    renderBackupRows(data);
    if (backupState.items.length === 0) {
      backupDetail.replaceChildren(
        el('div', { class: 'empty empty--tall' }, [
          el('span', { class: 'empty__mark', text: '◫' }),
          el('p', { text: '还没有任何备份' }),
          el('p', { class: 'empty__hint', text: '没有备份就没有回退点——但也没有「旧备份让内容复活」的风险。' }),
        ]),
      );
    } else if (backupState.selected === null) {
      selectBackup(backupState.items[0].backupId);
    }
  } catch (err) {
    renderError(backupRows, err, '读取备份列表');
  }
}

/** @param {any} data */
function renderBackupCapbar(data) {
  // 能力以 /api/backups 自己报的为准（这是同一份配置的直接来源）；
  // window.__brainHealth 只是兜底，避免它与健康探测的加载顺序打架。
  const caps = window.__brainHealth?.capabilities ?? {};
  const canBackup = data.capability?.backup === true || caps.backup === true;
  const canRestore = caps.restore === true;

  const backupEl = $('#cap-backup');
  backupEl.textContent = canBackup ? '开（可触发）' : '关（默认关闭）';
  backupEl.setAttribute('data-tone', canBackup ? 'green' : 'amber');

  const restoreEl = $('#cap-restore');
  restoreEl.textContent = canRestore ? '开（仍要二次确认）' : '关（只能预演）';
  restoreEl.setAttribute('data-tone', canRestore ? 'amber' : 'green');

  $('#cap-dir').textContent = String(data.dir ?? '—');
  $('#cap-keep').textContent = `${data.keepDays ?? '?'} 天`;

  const btn = /** @type {HTMLButtonElement} */ ($('#backup-create'));
  btn.disabled = !canBackup;
  btn.textContent = canBackup ? '立即备份' : '备份能力未开';
}

/** @param {any} data */
function renderBackupRows(data) {
  if (data.available === false) {
    backupRows.replaceChildren(
      el('tr', {}, [el('td', { colspan: '6', class: 'empty', text: String(data.reason ?? '备份表读不出来') })]),
    );
    return;
  }
  if (backupState.items.length === 0) {
    backupRows.replaceChildren(
      el('tr', {}, [el('td', { colspan: '6', class: 'empty', text: '没有备份记录' })]),
    );
    return;
  }

  backupRows.replaceChildren(
    ...backupState.items.map((b) => {
      const tr = el('tr', { 'data-id': b.backupId }, [
        el('td', {}, [
          el('div', { class: 'cell-when' }, [el('span', { text: fmtTime(b.createdAt) })]),
        ]),
        el('td', {}, [el('span', { class: 'chip', text: String(b.kind) })]),
        el('td', {}, [el('span', { class: 'num', text: b.schemaVersion ?? '—' })]),
        el('td', {}, [el('span', { class: 'num', text: b.watermark === null ? '—' : String(b.watermark) })]),
        el('td', {}, [el('span', { class: 'num', text: fmtBytes(b.byteSize ?? b.sizeActual) })]),
        el('td', {}, [integrityChip(b)]),
      ]);
      tr.addEventListener('click', () => selectBackup(b.backupId));
      if (b.backupId === backupState.selected) tr.setAttribute('aria-selected', 'true');
      return tr;
    }),
  );
}

/** @param {any} b */
function integrityChip(b) {
  const integrity = String(b.integrity ?? 'unverified');
  const map = {
    ok: { tone: 'green', text: '已校验' },
    missing_file: { tone: 'brick', text: '文件缺失' },
    failed: { tone: 'brick', text: '失败' },
    unverified: { tone: 'muted', text: '未校验' },
  };
  const hit = map[integrity] ?? map.unverified;
  return el('span', { class: 'chip', 'data-tone': hit.tone, text: hit.text });
}

/** @param {string} backupId */
async function selectBackup(backupId) {
  backupState.selected = backupId;
  for (const tr of backupRows.querySelectorAll('tr')) {
    if (tr.getAttribute('data-id') === backupId) tr.setAttribute('aria-selected', 'true');
    else tr.removeAttribute('aria-selected');
  }
  const backup = backupState.items.find((b) => b.backupId === backupId);
  if (backup === undefined) return;
  backupDetail.replaceChildren(el('div', { class: 'empty', text: '读取…' }));
  renderBackupDetail(backup);
}

/** @param {any} b */
function renderBackupDetail(b) {
  const head = el('div', { class: 'detail-head' }, [
    el('div', { class: 'detail-head__row' }, [
      el('span', { class: 'chip', text: String(b.kind) }),
      integrityChip(b),
      b.exists === false ? el('span', { class: 'chip', 'data-tone': 'brick', text: '文件不在盘上' }) : null,
    ]),
    el('h3', { text: b.fileName ?? b.backupId }),
    el('p', { class: 'detail-head__id', text: `${b.backupId} · ${fmtTime(b.createdAt)}` }),
  ]);

  const body = el('div', { class: 'detail-body' });

  // 复活风险：备份的删除水位低于当前 → 恢复它会让之后的删除复活
  const currentEpoch = backupState.currentEpoch;
  const backupEpoch = typeof b.deletionEpoch === 'number' ? b.deletionEpoch : null;
  if (currentEpoch !== null && backupEpoch !== null && backupEpoch < currentEpoch) {
    body.append(
      el('p', {
        class: 'caveat',
        text: `恢复到这一份会让内容复活：它的删除水位是 epoch ${backupEpoch}，而当前库已经到 ${currentEpoch}——中间删掉的东西会跟着备份一起回来。必须靠独立删除账本重放这些删除才能抵消。`,
      }),
    );
  }

  body.append(
    el('section', {}, [
      el('h4', { class: 'sec-title', text: '备份信息' }),
      el('dl', { class: 'kv' }, [
        el('dt', { text: '时间' }),
        el('dd', {}, [el('span', { class: 'num', text: fmtTime(b.createdAt) })]),
        el('dt', { text: '大小' }),
        el('dd', {}, [
          el('span', { class: 'num', text: fmtBytes(b.byteSize) }),
          b.sizeActual !== null && b.byteSize !== null && b.sizeActual !== b.byteSize
            ? el('span', { class: 'chip', 'data-tone': 'brick', text: `实际 ${fmtBytes(b.sizeActual)}` })
            : null,
        ]),
        el('dt', { text: 'schema' }),
        el('dd', {}, [el('span', { class: 'num', text: b.schemaVersion ?? '—' })]),
        el('dt', { text: 'watermark' }),
        el('dd', {}, [el('span', { class: 'num', text: b.watermark === null ? '—' : String(b.watermark) })]),
        el('dt', { text: '删除水位' }),
        el('dd', {}, [
          el('span', { class: 'num', text: backupEpoch === null ? '—' : `epoch ${backupEpoch}` }),
          currentEpoch === null ? null : el('span', { class: 'chip', text: `当前 ${currentEpoch}` }),
        ]),
        el('dt', { text: '保留至' }),
        el('dd', {}, [el('span', { class: 'num', text: b.retentionUntil === null ? '—' : fmtDay(b.retentionUntil) })]),
        el('dt', { text: 'sha256' }),
        el('dd', {}, [el('span', { class: 'num', text: shortHash(b.sha256, 24) })]),
        el('dt', { text: '路径' }),
        el('dd', {}, [el('span', { class: 'num', text: b.path ?? '—' })]),
      ]),
      b.error === null || b.error === undefined
        ? null
        : el('p', { class: 'caveat', text: `上次失败：${String(b.error)}` }),
    ]),
  );

  // 复校
  const verifyBox = el('div', { class: 'restorebox', 'data-tone': b.integrity === 'ok' ? 'ok' : 'blocked' }, [
    el('p', { class: 'layer__basis', text: '备份校验不通过就禁止恢复（契约 §5.1 第 1 步）。' }),
  ]);
  const verifyBtn = el('button', { class: 'btn', type: 'button' }, ['复校']);
  const verifyOut = el('div', { class: 'steps' });
  verifyBtn.addEventListener('click', async () => {
    verifyBtn.disabled = true;
    verifyOut.replaceChildren(el('p', { class: 'layer__basis', text: '校验中…' }));
    try {
      const verdict = await api(`/api/backups/${encodeURIComponent(b.fileName ?? b.backupId)}/verify`);
      verifyOut.replaceChildren(
        el('div', { class: 'steprow', 'data-status': verdict.ok === true ? 'ok' : 'blocked' }, [
          el('span', { class: 'steprow__mark', text: verdict.ok === true ? '✓' : '✕' }),
          el('span', { text: verdict.ok === true ? '校验通过' : `校验未通过：${(verdict.problems ?? []).join('; ') || '原因未给出'}` }),
        ]),
        el('div', { class: 'steprow', 'data-status': 'ok' }, [
          el('span', { class: 'steprow__mark', text: '·' }),
          el('span', { text: `实现：${String(verdict.implementation ?? '—')}` }),
        ]),
      );
    } catch (err) {
      verifyOut.replaceChildren(
        el('div', { class: 'steprow', 'data-status': 'blocked' }, [
          el('span', { class: 'steprow__mark', text: '✕' }),
          el('span', { text: describeError(err) }),
        ]),
      );
    } finally {
      verifyBtn.disabled = false;
    }
  });
  verifyBox.append(el('div', { class: 'layer__extra' }, [verifyBtn]), verifyOut);
  body.append(el('section', {}, [el('h4', { class: 'sec-title', text: '完整性' }), verifyBox]));

  // 恢复：预演优先，真执行要三重闸门
  const restoreBox = el('div', { class: 'restorebox', 'data-tone': 'blocked' }, [
    el('p', {
      class: 'layer__basis',
      text: '恢复默认只预演。真执行必须：dryRun=false + confirm=RESTORE + 服务以 --allow-restore 启动。',
    }),
  ]);
  const planOut = el('div', { class: 'steps' });
  const planBtn = el('button', { class: 'btn', type: 'button' }, ['预演恢复']);
  planBtn.addEventListener('click', async () => {
    planBtn.disabled = true;
    planOut.replaceChildren(el('p', { class: 'layer__basis', text: '预演中…' }));
    try {
      const plan = await api('/api/restore/plan', {
        method: 'POST',
        body: { backupDir: b.fileName ?? b.backupId },
      });
      planOut.replaceChildren(...renderRestorePlan(plan, b));
      await refreshIsolationBanner();
    } catch (err) {
      planOut.replaceChildren(
        el('div', { class: 'steprow', 'data-status': 'blocked' }, [
          el('span', { class: 'steprow__mark', text: '✕' }),
          el('span', { text: describeError(err) }),
        ]),
      );
    } finally {
      planBtn.disabled = false;
    }
  });
  restoreBox.append(el('div', { class: 'layer__extra' }, [planBtn]), planOut);
  body.append(el('section', {}, [el('h4', { class: 'sec-title', text: '恢复' }), restoreBox]));

  backupDetail.replaceChildren(head, body);
}

/**
 * 渲染恢复预演结果 + 真执行闸门。
 * @param {any} plan
 * @param {any} backup
 * @returns {Node[]}
 */
function renderRestorePlan(plan, backup) {
  const nodes = [];

  const blockers = Array.isArray(plan.blockers) ? plan.blockers : [];
  const warnings = Array.isArray(plan.warnings) ? plan.warnings : [];
  const isolationRequired = plan.isolationRequired === true || blockers.length > 0;

  nodes.push(
    el('div', { class: 'steprow', 'data-status': isolationRequired ? 'blocked' : 'ok' }, [
      el('span', { class: 'steprow__mark', text: isolationRequired ? '✕' : '✓' }),
      el('span', {}, [
        el('strong', { text: isolationRequired ? '不能正常上架：只能隔离检修' : '可以正常上架' }),
        el('small', { text: `（${String(plan.implementation ?? '—')}）` }),
        typeof plan.deletionsAfterBackup === 'number' && plan.deletionsAfterBackup > 0
          ? el('span', {
              class: 'chip',
              'data-tone': 'amber',
              text: `要先重放 ${plan.deletionsAfterBackup} 条删除`,
            })
          : null,
      ]),
    ]),
  );

  for (const b of blockers) {
    nodes.push(
      el('div', { class: 'steprow', 'data-status': 'blocked' }, [
        el('span', { class: 'steprow__mark', text: '✕' }),
        el('span', { text: String(b) }),
      ]),
    );
  }
  for (const w of warnings) {
    nodes.push(
      el('div', { class: 'steprow', 'data-status': 'unknown' }, [
        el('span', { class: 'steprow__mark', text: '!' }),
        el('span', { text: String(w) }),
      ]),
    );
  }
  for (const step of Array.isArray(plan.steps) ? plan.steps : []) {
    nodes.push(
      el('div', { class: 'steprow', 'data-status': String(step.status ?? 'planned') }, [
        el('span', { class: 'steprow__mark', text: step.status === 'ok' ? '✓' : step.status === 'blocked' ? '✕' : String(step.step ?? '·') }),
        el('span', {}, [
          el('span', { text: String(step.title ?? '') }),
          step.detail ? el('small', { text: ` · ${String(step.detail)}` }) : null,
        ]),
      ]),
    );
  }

  // 真执行区：只有服务开了恢复能力才允许输入
  const restoreCap = window.__brainHealth?.capabilities?.restore === true;
  const confirmInput = /** @type {HTMLInputElement} */ (
    el('input', {
      type: 'text',
      placeholder: restoreCap ? '输入 RESTORE 确认' : '恢复能力未开启',
      autocomplete: 'off',
      disabled: !restoreCap,
    })
  );
  const execBtn = /** @type {HTMLButtonElement} */ (
    el('button', { class: 'btn btn--danger', type: 'button', disabled: true }, ['真执行恢复'])
  );
  confirmInput.addEventListener('input', () => {
    execBtn.disabled = !(restoreCap && confirmInput.value.trim() === 'RESTORE');
  });
  const execOut = el('div', { class: 'steps' });
  execBtn.addEventListener('click', async () => {
    execBtn.disabled = true;
    execOut.replaceChildren(el('p', { class: 'layer__basis', text: '执行中…' }));
    try {
      const result = await api('/api/restore/execute', {
        method: 'POST',
        body: {
          backupDir: backup.fileName ?? backup.backupId,
          dryRun: false,
          confirm: 'RESTORE',
        },
      });
      const nodes = [
        el('div', { class: 'steprow', 'data-status': result.promoted === true ? 'ok' : 'isolated' }, [
          el('span', { class: 'steprow__mark', text: result.promoted === true ? '✓' : '!' }),
          el('span', { text: String(result.note ?? '') }),
        ]),
      ];
      // 重放回显：「旧备份不许让已删内容复活」这条门槛到底过没过，就在这一行
      if (typeof result.replayNote === 'string' && result.replayNote.length > 0) {
        const replayState =
          result.replay === null
            ? 'unknown'
            : result.replay.ok === true
              ? 'ok'
              : 'blocked';
        nodes.push(
          el('div', { class: 'steprow', 'data-status': replayState }, [
            el('span', {
              class: 'steprow__mark',
              text: replayState === 'ok' ? '✓' : replayState === 'blocked' ? '✕' : '!',
            }),
            el('span', { text: String(result.replayNote) }),
          ]),
        );
      }
      if (typeof result.reason === 'string' && result.reason.length > 0) {
        nodes.push(
          el('div', { class: 'steprow', 'data-status': 'unknown' }, [
            el('span', { class: 'steprow__mark', text: '·' }),
            el('span', { text: `上架判定原因：${result.reason}` }),
          ]),
        );
      }
      execOut.replaceChildren(...nodes);
      await refreshIsolationBanner();
      loadBackups();
    } catch (err) {
      execOut.replaceChildren(
        el('div', { class: 'steprow', 'data-status': 'blocked' }, [
          el('span', { class: 'steprow__mark', text: '✕' }),
          el('span', { text: describeError(err) }),
        ]),
      );
      execBtn.disabled = false;
    }
  });

  nodes.push(
    el('div', { class: 'confirmrow' }, [
      el('label', { text: '确认' }),
      confirmInput,
      execBtn,
    ]),
    execOut,
  );

  if (!restoreCap) {
    nodes.push(
      el('p', { class: 'layer__basis', text: '当前服务没有开恢复能力：可以预演，但执行会被拒绝（403 CAPABILITY_REQUIRED）。' }),
    );
  }
  return nodes;
}

/** 重新拉一次健康，让隔离横幅反映最新状态。 */
async function refreshIsolationBanner() {
  try {
    const data = await api('/api/health');
    window.__brainHealth = data;
    renderIsolationBanner(data.isolation);
  } catch {
    /* 横幅刷新失败不影响主流程 */
  }
}

$('#backup-reload').addEventListener('click', () => loadBackups());
$('#backup-create').addEventListener('click', async () => {
  const btn = /** @type {HTMLButtonElement} */ ($('#backup-create'));
  btn.disabled = true;
  btn.textContent = '备份中…';
  try {
    const result = await api('/api/backups', { method: 'POST', body: {} });
    btn.textContent = '已创建';
    loadBackups();
    if (result?.note) window.alert?.(String(result.note));
  } catch (err) {
    btn.textContent = describeError(err);
  } finally {
    setTimeout(() => {
      btn.disabled = window.__brainHealth?.capabilities?.backup !== true;
      btn.textContent = window.__brainHealth?.capabilities?.backup === true ? '立即备份' : '备份能力未开';
    }, 2400);
  }
});

$('#isolation-go').addEventListener('click', () => showView('backups'));

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

if (TOKEN.length === 0) {
  setConn('down', '没有凭据');
  document.querySelector('.stage')?.replaceChildren(
    el('div', { class: 'panel' }, [
      el('div', { class: 'empty empty--tall' }, [
        el('span', { class: 'empty__mark', text: '!' }),
        el('p', { text: '页面里没有凭据' }),
        el('p', {
          class: 'empty__hint',
          text: '请通过服务地址打开本页（http://127.0.0.1:<port>/）。直接双击打开 index.html 读不到注入的凭据。',
        }),
      ]),
    ]),
  );
} else {
  const initial = location.hash.slice(1);
  const first = VIEWS.includes(initial) ? initial : 'memories';
  // 只调 showView：它内部有 `loaded` 判断，负责触发该视图的首次加载。
  // （之前在这里先 loaded.add(first) 再 showView，导致直接打开 #context 时永远停在「读取中」。）
  showView(first);
  // 健康状态每 30 秒刷一次：检查器可以闲着，但显示的必须是当下的状态。
  setInterval(loadHealth, 30_000);
  loadHealth();
}

// 便于排障时在控制台里看当前时区（不影响功能）
document.documentElement.setAttribute('data-tz', TZ);
