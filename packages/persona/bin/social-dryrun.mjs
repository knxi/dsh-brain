#!/usr/bin/env node
// @ts-check
/**
 * `social-dryrun` —— 「如果我开着主动社交，它今天本来会说什么」。
 *
 * 这是主人**唯一能直接感觉到**系统 4 的入口，所以它必须：
 * 1. **只读**：以 `readOnly` 打开主账，不跑迁移、不写任何业务行；
 * 2. **不依赖开关**：`social.enabled=0`（默认）时照样能跑——它算的就是「如果开着」；
 * 3. **不真发**：整条路径走 `social.preview()`，连 `social_sends` 都不碰；
 * 4. **老实交代**：哪些候选被硬闸挡住、为什么挡住、哪些来源根本没做，全部打出来。
 *
 * 用法：
 * ```bash
 * node packages/persona/bin/social-dryrun.mjs                       # 生产库，当前时刻
 * node packages/persona/bin/social-dryrun.mjs --now 2026-10-30T22:00:00+08:00
 * node packages/persona/bin/social-dryrun.mjs --person owner --json
 * node packages/persona/bin/social-dryrun.mjs --signals ./signals.json
 * ```
 *
 * `--signals` 用来喂「现成依据」（宿主抓到的真实发现），JSON 形如：
 * `{ "discovery": [{ "topic":"t1", "text":"刚跑完全量测试", "evidence":["evt_1"], "ageHours":0 }] }`
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');

/** 参数解析（够用即止，不引第三方依赖）。 */
function parseArgs(argv) {
  /** @type {Record<string, any>} */
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === 'json' || key === 'help' || key === 'verbose') {
      args[key] = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    index += 1;
  }
  return args;
}

const HELP = `🦊 主动社交 dry-run —— 只看不写、只看不发

用法：
  node packages/persona/bin/social-dryrun.mjs [选项]

选项：
  --db <path>       主账路径（默认 data/brain.db）
  --person <id>     看谁的主动社交（默认 owner）
  --scope <id>      连接器绑定的 scope（默认 owner-default）
  --now <iso>       用指定时刻预演（默认现在），例：--now 2026-10-30T22:00:00+08:00
  --signals <path>  喂一份「现成依据」的 JSON（可选）
  --limit <n>       最多列出几条候选（默认 10）
  --json            输出原始 JSON（给程序/控制台用）
  --help            看这段

说明：
  这个命令**只读**。它不写 social_candidates、不写 social_sends、不真发任何消息，
  也不受 social.enabled / social.allow_external / paused 影响——它算的就是「如果开着」。
`;

/**
 * @param {number} value
 * @returns {string}
 */
function scoreFormula(breakdown) {
  const components = breakdown?.components ?? {};
  const parts = [
    ['相关性', components.relevance],
    ['实际帮助', components.actualHelp],
    ['关系适配', components.relationshipFit],
    ['新鲜度', components.freshness],
    ['打扰成本', components.interruptionCost],
    ['重复度', components.repetitionPenalty],
    ['忙碌/负面', components.busyPenalty],
    ['压力资源', components.resourcePressure],
  ].filter(([, value]) => Number(value) !== 0);
  return parts.map(([label, value]) => `${label} ${Number(value) > 0 ? '+' : ''}${Number(value)}`).join(' → ');
}

/**
 * @param {any} candidate
 * @param {number} index
 * @returns {string[]}
 */
function renderCandidate(candidate, index) {
  const lines = [];
  const score = Number(candidate.score ?? 0);
  lines.push(`${index}. [${candidate.source} · ${score} 分] ${candidate.text}`);
  if (candidate.topic) lines.push(`   话题：${candidate.topic}`);
  lines.push(`   依据：${(candidate.evidence ?? []).map((id) => `id:${id}`).join(', ') || '（没有依据——这类不该被发出去）'}`);
  if (candidate.scoreBreakdown?.components) {
    lines.push(`   为什么：50 + ${scoreFormula(candidate.scoreBreakdown)}（门槛 ${candidate.scoreBreakdown.threshold ?? 55}）`);
  }
  if (candidate.blockedBy) lines.push(`   被挡：${candidate.blockedBy}`);
  if (candidate.persisted && candidate.status) lines.push(`   现状：已落表（status=${candidate.status}）`);
  return lines;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return 0;
  }
  const dbPath = path.resolve(String(args.db ?? path.join(ROOT, 'data/brain.db')));
  const personId = String(args.person ?? 'owner');
  const scopeId = String(args.scope ?? 'owner-default');
  const limit = Number(args.limit ?? 10);

  const { existsSync } = await import('node:fs');
  if (!existsSync(dbPath)) {
    console.error(`✖ 主账不存在：${dbPath}`);
    console.error('  先跑一次 migrations（node packages/memory/bin/migrate.mjs），或用 --db 指到正确位置。');
    return 2;
  }

  const { openBrain } = await import('../../memory/src/index.js');
  const { createWorkspace } = await import('../../workspace/src/index.js');
  const { createPersona } = await import('../src/index.js');

  /** 只读打开：不跑迁移、不建写队列（写操作会一律失败，但本命令不写）。 */
  const brain = openBrain({ dbPath, readOnly: true });
  try {
    // 0008 之前的库没有 person_models：先给一句人话，而不是抛一句原始 SQL 错误。
    const hasPersonaTables = (() => {
      try {
        return Boolean(
          brain.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'person_models'").get(),
        );
      } catch {
        return false;
      }
    })();
    if (!hasPersonaTables) {
      console.error(`✖ 这个主账还没跑到 0008（缺 person_models / social_candidates 等表）：${dbPath}`);
      console.error(`  当前 schema 版本：${brain.schemaVersion ?? '未知（不是主账？）'}`);
      console.error(`  先跑迁移：node packages/memory/bin/migrate.mjs --db "${dbPath}"`);
      console.error('  然后冷启动一个人物模型（persona.persons.ensurePerson）再回来看 dry-run。');
      return 2;
    }

    const workspace = createWorkspace({ db: brain.db, queue: null, clock: brain.clock, bindings: { scope_id: scopeId } });
    const persona = createPersona({
      db: brain.db,
      queue: brain.queue,
      clock: brain.clock,
      workspace,
      bindings: { scope_id: scopeId, person_id: personId },
    });

    /** @type {Record<string, any[]> | undefined} */
    let signals;
    if (args.signals) {
      const signalsPath = path.resolve(String(args.signals));
      signals = JSON.parse(readFileSync(signalsPath, 'utf8'));
    }

    /** @type {any} */
    let preview;
    try {
      preview = persona.social.preview({ personId, now: args.now ?? undefined, signals, limit });
    } catch (err) {
      if (err && /** @type {any} */ (err).code === 'NOT_FOUND') {
        console.error(`✖ 这个库里还没有「${personId}」的人物模型（scope=${scopeId}）`);
        console.error('  冷启动是显式动作，dry-run 不会替你建：');
        console.error('    const persona = createPersona({ db, queue, clock, workspace, bindings });');
        console.error(`    await persona.persons.ensurePerson({ personId: '${personId}', displayName: '主人' });`);
        return 2;
      }
      throw err;
    }

    if (args.json) {
      console.log(JSON.stringify(preview, null, 2));
      return 0;
    }

    const switches = preview.switches;
    const lines = [];
    lines.push('🦊 主动社交 dry-run —— 只预演，不落库，不发消息');
    lines.push(
      `时间：${preview.at.local}（本地） · 时区 Asia/Shanghai · person=${personId} · scope=${scopeId}`,
    );
    lines.push(
      `开关：social.enabled=${switches.socialEnabled ? 1 : 0} · social.allow_external=${switches.allowExternal ? 1 : 0} · paused=${switches.paused ? 1 : 0}` +
        (switches.wouldBlockRealSend ? '  → 现在一条都不会真发（这正是 dry-run 的意义）' : '  → 策略上允许外发（仍不会真发）'),
    );
    if (preview.selfState) {
      lines.push(
        `我的状态：心情 ${Math.round(preview.selfState.mood)} · 精力 ${Math.round(preview.selfState.energy)} · 压力 ${Number(preview.selfState.stress).toFixed(2)}` +
          (preview.selfState.known ? '' : '（fox_state 还没有记录，按中性值估）'),
      );
    }
    if (preview.relationship) {
      const rel = preview.relationship;
      lines.push(
        `关系：熟悉 ${rel.familiarity.toFixed(2)} · 信任 ${rel.trust.toFixed(2)} · 亲密 ${rel.intimacy.toFixed(2)} · 好感 ${rel.rapport.toFixed(2)}`,
      );
    }
    lines.push(
      `今天：已真发 ${preview.counts.approvedToday} 条（上限 ${preview.policy?.dailyCap ?? '?'}） · 待批准 ${preview.counts.pending} 条（上限 ${preview.policy?.maxPending ?? '?'}）`,
    );
    lines.push('');

    if (preview.wouldSay.length === 0) {
      lines.push('如果现在开着主动社交，它今天不会开口。');
    } else {
      lines.push(`如果现在开着主动社交，它今天本来会说的（${preview.wouldSay.length} 条）：`);
      preview.wouldSay.forEach((candidate, index) => {
        lines.push(...renderCandidate(candidate, index + 1));
      });
    }
    lines.push('');

    // 弱 care 信号折叠成一行：这类候选正文往往是项目日志，摊在第一屏只会让人困惑，
    // 但「为什么没问」必须能解释（source_quality 硬闸）。
    const weakCare = preview.fresh.filter((candidate) => candidate.blockedBy === 'source_quality');
    if (weakCare.length > 0) {
      lines.push(
        `另有 ${weakCare.length} 条弱 care 信号（加班/开会/汇报这类没有「后来怎么样了」的事）已被丢弃：source_quality 硬闸`,
      );
      lines.push('');
    }
    const blocked = preview.fresh.filter((candidate) => !candidate.wouldSend && candidate.blockedBy !== 'source_quality');
    if (blocked.length > 0) {
      lines.push(`被挡下的（${blocked.length} 条）：`);
      for (const candidate of blocked) {
        lines.push(`- [${candidate.source} · ${candidate.score} 分] ${candidate.text}`);
        lines.push(`  挡在：${candidate.blockedBy ?? '未过门槛'}`);
      }
      lines.push('');
    }

    if (preview.persistedToday.length > 0) {
      lines.push(`今天已经落表的候选（${preview.persistedToday.length} 条）：`);
      for (const candidate of preview.persistedToday) {
        lines.push(`- [${candidate.status} · ${candidate.score} 分] ${candidate.text}`);
      }
      lines.push('');
    }

    if (preview.sendsToday.length > 0) {
      lines.push(`今天已有的发送记录（${preview.sendsToday.length} 条，按 mode 区分）：`);
      for (const send of preview.sendsToday) {
        lines.push(`- ${send.mode}${send.ok ? '' : '（失败）'} · ${send.at} · ${send.text}`);
      }
      lines.push('');
    }

    if (preview.skipped.length > 0) {
      lines.push('这次没生成候选的来源：');
      for (const skip of preview.skipped) {
        lines.push(`- ${skip.source}：${skip.reason}`);
      }
      lines.push('');
    }
    lines.push(`本轮实现的来源：${preview.implementedSources.join(' / ')}`);
    // 语气对齐 2026-10-31 的现状：剩下的来源不是「不想做」，而是**缺数据**——
    // 具体缺什么在 `sourceStates.<source>.missing` 里，别用「没依据所以不做」一句带过。
    const pendingDetail = (preview.pendingSources ?? [])
      .map((source) => {
        const missing = preview.sourceStates?.[source]?.missing;
        return missing ? `${source}（缺：${missing}）` : source;
      })
      .join(' / ');
    lines.push(`还缺数据、暂时不产出的来源：${pendingDetail || '（无）'}`);
    lines.push('');
    lines.push(preview.note);

    console.log(lines.join('\n'));
    return 0;
  } finally {
    try {
      await brain.close();
    } catch {
      /* 只读实例关闭失败不影响结果 */
    }
  }
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error('✖ dry-run 失败：', err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
