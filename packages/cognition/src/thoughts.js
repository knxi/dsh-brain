// @ts-check
/**
 * `thoughts` —— 想法生命周期：可演化的判断 / 未完成的思考 / 不在场时的目标。
 *
 * ── 为什么要有这个模块（2026-10-31）──
 *
 * 原来的 `reflections` 产出的是模板填空：
 *
 *   "事件里出现未完成的约定表述（event:evt_02c92eb0…，2026-10-31），之后没有找到完成记录。"
 *
 * 三条内容一模一样，只换了 event id，confidence 全是固定的 0.45 / 0.5。
 * 那不是想法，是日志匹配结果——它回答不了「我怎么看这件事」，更回答不了
 * 「我三天前是这么看的，现在改了主意，因为……」。
 *
 * 本模块补的就是这一层。三张表各管一件事：
 *
 *   thoughts     判断的**版本链**。同一 topic 多次判断构成一条链，新版本记
 *                「从什么改到什么、为什么改」。这是「改主意」唯一的载体。
 *   open_threads 想了一半的思考。带 progress / next_step，让下一次自己能接着想，
 *                而不是每轮从头开始。
 *   intents      不在场时也在推进的目标。带 next_action，唤醒时第一个该看的东西。
 *
 * ── 三条纪律 ──
 *
 * 1. **不调模型**。本模块全靠规则驱动：演化检测走文本相似度，不开 LLM 请求。
 *    项目红线「Brain 自身不发 LLM 请求」继续守住。也就是说，这里能做的是
 *    「把变化记下来」，不是「让它自己想」——这个区别不许在文档里含糊过去。
 * 2. **正文必须是可读的话**。`content` / `question` / `goal` 一律不许塞
 *    `evt_xxx` 这种 id 了事——那正是旧 reflections 的病根。
 * 3. **想法的变化留痕，不覆盖**。新判断写新版本，旧版本永远在。查询侧自己取最新。
 */

import { BrainError } from '@dsh-brain/core';
import {
  createReader,
  requireText,
  resolveScopeId,
  stringifyJson,
  parseStringArray,
} from './internal.js';

/** 想法状态：还在想 / 想清楚了 / 不追了 */
export const THOUGHT_STATES = Object.freeze(['open', 'settled', 'dropped']);
/** 未完成思考的状态：等着继续 / 暂时搁置 / 想完了 */
export const THREAD_STATES = Object.freeze(['open', 'parked', 'closed']);
/** 目标状态：推进中 / 达成 / 放弃 */
export const INTENT_STATES = Object.freeze(['active', 'done', 'abandoned']);

/**
 * 「判断变了没有」的相似度阈值。
 *
 * 为什么是 0.72：低于这个数，两段话的字符 bigram 重合已经不足七成，
 * 通常意味着换了说法或换了结论；高于它，多数是同一件事的措辞微调
 * （补个时间、加个限定），不该记成新版本——否则版本链会被同义反复淹没，
 * 而「改主意」这个信号也就废了。
 */
export const EVOLUTION_THRESHOLD = 0.72;

/**
 * 两段文本的字符 bigram Jaccard 相似度（0..1）。
 *
 * 为什么不用编辑距离：中文字符串的编辑距离对长短变化极敏感，
 * 一句话补个尾巴分数就掉一半。bigram 集合重叠对「换说法」「换结论」更稳。
 * 为什么不用向量：那要引入模型或词典，本项目不引这类依赖。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function textSimilarity(a, b) {
  const norm = (/** @type {string} */ s) => String(s ?? '').replace(/[\s\p{P}]/gu, '');
  const x = norm(a);
  const y = norm(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  /** @param {string} s @returns {Set<string>} */
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
    return set;
  };
  const gx = grams(x);
  const gy = grams(y);
  let inter = 0;
  for (const g of gx) if (gy.has(g)) inter += 1;
  const union = gx.size + gy.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * @param {{
 *   db: any,
 *   queue: any,
 *   clock: any,
 *   bindings?: { scope_id?: string, person_id?: string } | null,
 * }} options
 */
export function createThoughts(options) {
  const { db, queue, clock } = options;
  const bindings = options.bindings ?? null;
  const reader = createReader(db);
  const defaultPersonId = 'owner';

  /** @param {any} input */
  const resolvePerson = (input) => String(
    input?.personId ?? bindings?.person_id ?? defaultPersonId,
  );

  // ── 想法：版本链 ────────────────────────────────────────────────

  /**
   * 记一条判断。同 topic 已有判断时自动 version+1，并把「从什么改到什么、
   * 为什么改」写进新版本；相似度不低于阈值则视为没变，不记新版本。
   *
   * @param {{
   *   topic: string,
   *   content: string,
   *   confidence?: number,
   *   state?: 'open' | 'settled' | 'dropped',
   *   reason?: string | null,
   *   evidence?: string[],
   *   scopeId?: string,
   *   personId?: string,
   * }} input
   * @returns {Promise<{
   *   recorded: boolean,
   *   changed: boolean,
   *   version: number,
   *   id: string | null,
   *   previousVersion: number | null,
   *   similarity: number | null,
   *   previousContent: string | null,
   * }>}
   */
  async function recordThought(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const personId = resolvePerson(input);
    const topic = requireText(input.topic, 'topic', { maxLength: 200 });
    const content = requireText(input.content, 'content', { maxLength: 4000 });
    const state = input.state === undefined || input.state === null ? 'open' : String(input.state);
    if (!THOUGHT_STATES.includes(state)) {
      throw new BrainError('INVALID_ARGUMENT', `state 必须是 ${THOUGHT_STATES.join(' / ')}`);
    }
    const confidence = input.confidence === undefined || input.confidence === null
      ? 0.5
      : Math.min(1, Math.max(0, Number(input.confidence)));
    const evidence = Array.isArray(input.evidence) ? input.evidence.map(String) : [];

    // 事务外先读上一版：相似度判断要在进写队列之前算完（纯计算，不占事务）
    const prev = reader.get(
      `SELECT id, version, content FROM thoughts
        WHERE scope_id = ? AND topic = ?
        ORDER BY version DESC LIMIT 1`,
      [scopeId, topic],
    );

    const similarity = prev === undefined ? null : textSimilarity(String(prev.content), content);
    // 没变：不记新版本。返回 recorded=false 让调用方知道「这次没有新判断」
    if (similarity !== null && similarity >= EVOLUTION_THRESHOLD) {
      return {
        recorded: false,
        changed: false,
        version: Number(prev.version),
        id: null,
        previousVersion: Number(prev.version),
        similarity,
        previousContent: String(prev.content),
      };
    }

    const stamp = clock.stamp();
    const nextVersion = prev === undefined ? 1 : Number(prev.version) + 1;
    const id = `thg_${stamp.epoch_ms.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const reason = prev === undefined
      ? (input.reason === undefined || input.reason === null ? '初次判断' : String(input.reason))
      : (input.reason === undefined || input.reason === null
        // 没给理由时，用相似度如实描述变化幅度——不编造动机
        ? `判断变了（与上一版相似度 ${similarity.toFixed(2)}）`
        : String(input.reason));

    await queue.write(
      (/** @type {any} */ tx) => {
        tx.run(
          `INSERT INTO thoughts (
             id, scope_id, person_id, topic, content, state, confidence,
             version, parent_id, reason, evidence_json,
             created_at, created_at_local, updated_at, updated_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            id, scopeId, personId, topic, content, state, confidence,
            nextVersion, prev === undefined ? null : String(prev.id), reason,
            stringifyJson(evidence, 'evidence'),
            stamp.utc, stamp.local, stamp.utc, stamp.local,
          ],
        );
      },
      { label: 'cognition.thought.record' },
    );

    return {
      recorded: true,
      changed: prev !== undefined,
      version: nextVersion,
      id,
      previousVersion: prev === undefined ? null : Number(prev.version),
      similarity,
      previousContent: prev === undefined ? null : String(prev.content),
    };
  }

  /**
   * 取某 topic 的版本链（旧→新），用于回答「这个想法怎么变的」。
   * @param {{ topic: string, scopeId?: string, limit?: number }} input
   */
  function thoughtHistory(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const topic = requireText(input.topic, 'topic', { maxLength: 200 });
    const limit = Math.min(50, Math.max(1, Number(input.limit ?? 10)));
    const rows = reader.all(
      `SELECT id, version, content, state, confidence, reason, created_at_local
         FROM thoughts WHERE scope_id = ? AND topic = ?
        ORDER BY version DESC LIMIT ?`,
      [scopeId, topic, limit],
    );
    return rows.reverse().map((/** @type {any} */ r) => ({
      id: String(r.id),
      version: Number(r.version),
      content: String(r.content),
      state: String(r.state),
      confidence: Number(r.confidence),
      reason: r.reason == null ? null : String(r.reason),
      at: String(r.created_at_local),
    }));
  }

  /**
   * 当前还在想的想法（每个 topic 只取最新版）。
   * @param {{ scopeId?: string, limit?: number }} [input]
   */
  function openThoughts(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const limit = Math.min(100, Math.max(1, Number(input.limit ?? 20)));
    const rows = reader.all(
      `SELECT t.id, t.topic, t.content, t.version, t.confidence, t.updated_at_local
         FROM thoughts t
         JOIN (
           SELECT topic, MAX(version) AS v FROM thoughts
            WHERE scope_id = ? AND state = 'open' GROUP BY topic
         ) m ON m.topic = t.topic AND m.v = t.version
        WHERE t.scope_id = ?
        ORDER BY t.updated_at DESC LIMIT ?`,
      [scopeId, scopeId, limit],
    );
    return rows.map((/** @type {any} */ r) => ({
      id: String(r.id),
      topic: String(r.topic),
      content: String(r.content),
      version: Number(r.version),
      confidence: Number(r.confidence),
      at: String(r.updated_at_local),
    }));
  }

  // ── 未完成的思考 ────────────────────────────────────────────────

  /**
   * 开一个「想了一半」的思考。同一个 question 重复开不会新增（幂等）：
   * 已存在则把 touches+1 并刷新 last_touched_at。
   *
   * @param {{
   *   question: string,
   *   progress?: string | null,
   *   nextStep?: string | null,
   *   scopeId?: string,
   *   personId?: string,
   * }} input
   */
  async function openThread(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const personId = resolvePerson(input);
    const question = requireText(input.question, 'question', { maxLength: 500 });
    const progress = input.progress === undefined || input.progress === null ? null : String(input.progress).slice(0, 2000);
    const nextStep = input.nextStep === undefined || input.nextStep === null ? null : String(input.nextStep).slice(0, 2000);
    const stamp = clock.stamp();
    const id = `thr_${stamp.epoch_ms.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    return queue.write(
      (/** @type {any} */ tx) => {
        const existing = tx.get(
          'SELECT id, touches FROM open_threads WHERE scope_id = ? AND question = ?',
          [scopeId, question],
        );
        if (existing !== undefined) {
          tx.run(
            `UPDATE open_threads
                SET touches = touches + 1, last_touched_at = ?, progress = COALESCE(?, progress),
                    next_step = COALESCE(?, next_step), updated_at = ?, updated_at_local = ?
              WHERE id = ?`,
            [stamp.utc, progress, nextStep, stamp.utc, stamp.local, String(existing.id)],
          );
          return { id: String(existing.id), created: false, touches: Number(existing.touches) + 1 };
        }
        tx.run(
          `INSERT INTO open_threads (
             id, scope_id, person_id, question, progress, next_step, status, touches,
             last_touched_at, created_at, created_at_local, updated_at, updated_at_local
           ) VALUES (?, ?, ?, ?, ?, ?, 'open', 1, ?, ?, ?, ?, ?)`,
          [id, scopeId, personId, question, progress, nextStep,
            stamp.utc, stamp.utc, stamp.local, stamp.utc, stamp.local],
        );
        return { id, created: true, touches: 1 };
      },
      { label: 'cognition.thread.open' },
    );
  }

  /**
   * 推进一个未完成的思考。status 可改（继续 / 搁置 / 关闭）。
   * @param {{ id: string, progress?: string | null, nextStep?: string | null, status?: string, scopeId?: string }} input
   */
  async function touchThread(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const id = requireText(input.id, 'id', { maxLength: 120 });
    const status = input.status === undefined || input.status === null ? null : String(input.status);
    if (status !== null && !THREAD_STATES.includes(status)) {
      throw new BrainError('INVALID_ARGUMENT', `status 必须是 ${THREAD_STATES.join(' / ')}`);
    }
    const stamp = clock.stamp();
    return queue.write(
      (/** @type {any} */ tx) => {
        const row = tx.get('SELECT id FROM open_threads WHERE id = ? AND scope_id = ?', [id, scopeId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `思考线程不存在：${id}`);
        tx.run(
          `UPDATE open_threads
              SET touches = touches + 1, last_touched_at = ?,
                  progress = COALESCE(?, progress), next_step = COALESCE(?, next_step),
                  status = COALESCE(?, status),
                  updated_at = ?, updated_at_local = ?
            WHERE id = ?`,
          [stamp.utc,
            input.progress === undefined || input.progress === null ? null : String(input.progress).slice(0, 2000),
            input.nextStep === undefined || input.nextStep === null ? null : String(input.nextStep).slice(0, 2000),
            status, stamp.utc, stamp.local, id],
        );
        return { id, touched: true, status: status ?? 'unchanged' };
      },
      { label: 'cognition.thread.touch' },
    );
  }

  /**
   * 待续的思考（open 状态，按最近�动过排序）。
   * @param {{ scopeId?: string, limit?: number }} [input]
   */
  function pendingThreads(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const limit = Math.min(50, Math.max(1, Number(input.limit ?? 10)));
    return reader.all(
      `SELECT id, question, progress, next_step, touches, last_touched_at, updated_at_local
         FROM open_threads WHERE scope_id = ? AND status = 'open'
        ORDER BY last_touched_at DESC LIMIT ?`,
      [scopeId, limit],
    ).map((/** @type {any} */ r) => ({
      id: String(r.id),
      question: String(r.question),
      progress: r.progress == null ? null : String(r.progress),
      nextStep: r.next_step == null ? null : String(r.next_step),
      touches: Number(r.touches),
      at: String(r.updated_at_local),
    }));
  }

  // ── 目标 ────────────────────────────────────────────────────────

  /**
   * 建一个不在场时也在推进的目标。同一 goal 幂等（已存在则返回已有 id）。
   * @param {{ goal: string, why?: string | null, nextAction?: string | null, scopeId?: string, personId?: string }} input
   */
  async function createIntent(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const personId = resolvePerson(input);
    const goal = requireText(input.goal, 'goal', { maxLength: 500 });
    const why = input.why === undefined || input.why === null ? null : String(input.why).slice(0, 2000);
    const nextAction = input.nextAction === undefined || input.nextAction === null ? null : String(input.nextAction).slice(0, 2000);
    const stamp = clock.stamp();
    const id = `itn_${stamp.epoch_ms.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    return queue.write(
      (/** @type {any} */ tx) => {
        const existing = tx.get(
          'SELECT id FROM intents WHERE scope_id = ? AND goal = ?', [scopeId, goal],
        );
        if (existing !== undefined) return { id: String(existing.id), created: false };
        tx.run(
          `INSERT INTO intents (
             id, scope_id, person_id, goal, why, progress, next_action, status,
             last_acted_at, created_at, created_at_local, updated_at, updated_at_local
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'active', NULL, ?, ?, ?, ?)`,
          [id, scopeId, personId, goal, why, nextAction, stamp.utc, stamp.local, stamp.utc, stamp.local],
        );
        return { id, created: true };
      },
      { label: 'cognition.intent.create' },
    );
  }

  /**
   * 推进目标：改 progress / nextAction / status，并刷新 last_acted_at。
   * @param {{ id: string, progress?: string | null, nextAction?: string | null, status?: string, scopeId?: string }} input
   */
  async function advanceIntent(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const id = requireText(input.id, 'id', { maxLength: 120 });
    const status = input.status === undefined || input.status === null ? null : String(input.status);
    if (status !== null && !INTENT_STATES.includes(status)) {
      throw new BrainError('INVALID_ARGUMENT', `status 必须是 ${INTENT_STATES.join(' / ')}`);
    }
    const stamp = clock.stamp();
    return queue.write(
      (/** @type {any} */ tx) => {
        const row = tx.get('SELECT id FROM intents WHERE id = ? AND scope_id = ?', [id, scopeId]);
        if (row === undefined) throw new BrainError('NOT_FOUND', `目标不存在：${id}`);
        tx.run(
          `UPDATE intents
              SET progress = COALESCE(?, progress), next_action = COALESCE(?, next_action),
                  status = COALESCE(?, status), last_acted_at = ?,
                  updated_at = ?, updated_at_local = ?
            WHERE id = ?`,
          [input.progress === undefined || input.progress === null ? null : String(input.progress).slice(0, 2000),
            input.nextAction === undefined || input.nextAction === null ? null : String(input.nextAction).slice(0, 2000),
            status, stamp.utc, stamp.utc, stamp.local, id],
        );
        return { id, advanced: true, status: status ?? 'unchanged' };
      },
      { label: 'cognition.intent.advance' },
    );
  }

  /**
   * 推进中的目标。
   * @param {{ scopeId?: string, limit?: number }} [input]
   */
  function activeIntents(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const limit = Math.min(50, Math.max(1, Number(input.limit ?? 10)));
    return reader.all(
      `SELECT id, goal, why, progress, next_action, last_acted_at, updated_at_local
         FROM intents WHERE scope_id = ? AND status = 'active'
        ORDER BY updated_at DESC LIMIT ?`,
      [scopeId, limit],
    ).map((/** @type {any} */ r) => ({
      id: String(r.id),
      goal: String(r.goal),
      why: r.why == null ? null : String(r.why),
      progress: r.progress == null ? null : String(r.progress),
      nextAction: r.next_action == null ? null : String(r.next_action),
      lastActedAt: r.last_acted_at == null ? null : String(r.last_acted_at),
      at: String(r.updated_at_local),
    }));
  }

  // ── 注入用渲染 ──────────────────────────────────────────────────

  /**
   * 把「我正在想什么」渲染成可以直接塞进 system prompt 的一段文本。
   *
   * 为什么单独做一个渲染函数：注入方不该知道三张表的字段名，
   * 而且这段文本的措辞本身就是产品的一部分——它是「此刻的我」的全部来源。
   *
   * @param {{ scopeId?: string, maxThoughts?: number, maxThreads?: number, maxIntents?: number }} [input]
   * @returns {{ text: string, counts: { thoughts: number, threads: number, intents: number } }}
   */
  function renderForContext(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const thoughts = openThoughts({ scopeId, limit: input.maxThoughts ?? 3 });
    const threads = pendingThreads({ scopeId, limit: input.maxThreads ?? 3 });
    const intents = activeIntents({ scopeId, limit: input.maxIntents ?? 2 });
    const lines = [];

    if (threads.length > 0) {
      lines.push('【手上没想完的】');
      for (const t of threads) {
        const next = t.nextStep ? ` → 下次接着：${t.nextStep}` : '';
        lines.push(`· ${t.question}${t.progress ? `（想到：${t.progress}）` : ''}${next}`);
      }
    }
    if (thoughts.length > 0) {
      lines.push('【我正在这么看】');
      for (const t of thoughts) {
        const v = t.version > 1 ? `（第 ${t.version} 版）` : '';
        lines.push(`· ${t.topic}：${t.content}${v}`);
      }
    }
    if (intents.length > 0) {
      lines.push('【在推进的事】');
      for (const i of intents) {
        lines.push(`· ${i.goal}${i.nextAction ? ` → 下一步：${i.nextAction}` : ''}`);
      }
    }

    return {
      text: lines.join('\n'),
      counts: { thoughts: thoughts.length, threads: threads.length, intents: intents.length },
    };
  }

  /** 计数（面板用）。 */
  function stats(input = /** @type {any} */ ({})) {
    const scopeId = resolveScopeId(input.scopeId, bindings);
    const one = (/** @type {string} */ sql) => Number(reader.get(sql, [scopeId])?.n ?? 0);
    return {
      thoughtsOpen: one("SELECT COUNT(*) AS n FROM thoughts WHERE scope_id = ? AND state = 'open'"),
      thoughtsTotal: one('SELECT COUNT(*) AS n FROM thoughts WHERE scope_id = ?'),
      threadsOpen: one("SELECT COUNT(*) AS n FROM open_threads WHERE scope_id = ? AND status = 'open'"),
      intentsActive: one("SELECT COUNT(*) AS n FROM intents WHERE scope_id = ? AND status = 'active'"),
    };
  }

  return {
    recordThought,
    thoughtHistory,
    openThoughts,
    openThread,
    touchThread,
    pendingThreads,
    createIntent,
    advanceIntent,
    activeIntents,
    renderForContext,
    stats,
  };
}
