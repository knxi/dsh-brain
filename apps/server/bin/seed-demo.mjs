#!/usr/bin/env node
// @ts-check
/**
 * 演示数据播种：给控制台一份**合成**语料，方便看四块检查器长什么样。
 *
 * 纪律：
 * - 全部是合成数据，覆盖主人的工作语境（尺寸 / 材质 / 图号 / 报价 / 英文标识符），
 *   **不引用任何真实私密历史**（CONTRACTS §12 第 5 条）；
 * - 写入一律走 `memories.create` 门面（这样检索索引是同步维护的，和真实写入路径一致）；
 * - 不动 `data/brain.db`：必须显式给 `--db`，否则拒绝执行。
 *
 * 用法：
 *   node apps/server/bin/seed-demo.mjs --db data/demo.db
 *   node apps/server/index.mjs --db data/demo.db --port 0
 */

import path from 'node:path';
import { parseArgs, REPO_ROOT } from '../src/config.mjs';
import { openStore } from '../src/store.mjs';
import { createLogger } from '../src/log.mjs';

/** 合成语料。id 由门面生成，这里只给字段。 */
const DEMO = [
  {
    content: '客厅吊顶标高处 1.2m，走 9.5mm 纸面石膏板叠级，灯槽净宽 1200mm，收口用 2400×600 成品线条。',
    summary: '客厅吊顶标高 1.2m，石膏板叠级，灯槽 1200mm',
    layer: 'long',
    type: 'semantic',
    confidence: 0.9,
    importance: 0.8,
  },
  {
    content: '图纸 建施-03 的窗台高度是 900mm，石材板 2400×600 铺贴时按缝对齐，不许现场随意裁。',
    summary: '建施-03 窗台 900mm，石材 2400×600 对缝',
    layer: 'long',
    type: 'semantic',
    confidence: 0.75,
    importance: 0.7,
  },
  {
    content: '轻钢龙骨隔墙用 75 系，双面双层 9.5mm 纸面石膏板，含人工报价 128 元/㎡，不含腻子乳胶漆。',
    summary: '轻钢龙骨 75 系隔墙 128 元/㎡',
    layer: 'fragment',
    type: 'episode',
    confidence: 0.85,
    importance: 0.65,
  },
  {
    content: '卫生间墙面砖规格 400×800，横贴，上一版记成 300×600 是错的。',
    summary: '卫生间墙面砖 400×800 横贴',
    layer: 'long',
    type: 'semantic',
    confidence: 0.8,
    importance: 0.55,
  },
  {
    content: '样板间过道垭口宽度 1500mm，门槛石用深灰花岗岩，收边打硅酮胶。',
    summary: '样板间垭口 1500mm，深灰花岗岩门槛石',
    layer: 'long',
    type: 'semantic',
    confidence: 0.85,
    importance: 0.6,
  },
  {
    content: '客户说下周一要出全套施工图，现在还不确定，先记一笔。',
    summary: '客户说下周一要出全套施工图（未证实）',
    layer: 'fragment',
    type: 'episode',
    sourceType: 'inference',
    confidence: 0.45,
    importance: 0.4,
  },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true) {
    process.stdout.write('用法：node apps/server/bin/seed-demo.mjs --db <主账路径>\n');
    return;
  }
  if (typeof args.dbPath !== 'string' || args.dbPath.length === 0) {
    process.stderr.write('必须显式指定 --db（不会往 data/brain.db 里灌演示数据）\n');
    process.exitCode = 2;
    return;
  }
  if (path.resolve(args.dbPath) === path.resolve(REPO_ROOT, 'data', 'brain.db')) {
    process.stderr.write('拒绝向 data/brain.db 灌演示数据：那是主账。请指定别的路径。\n');
    process.exitCode = 2;
    return;
  }

  const logger = createLogger({ level: 'warn' });
  const backupDir = path.join(path.dirname(path.resolve(args.dbPath)), 'backups');
  const store = openStore({ dbPath: args.dbPath, backupDir, logger });
  try {
    const created = [];
    for (const draft of DEMO) {
      const memory = await store.createMemory({
        ...draft,
        sourceType: draft.sourceType ?? 'owner_words',
        privacy: 'private',
      });
      created.push(memory.id);
    }

    // 一条带「证据不够」气质的记忆：故意不给来源，检查器会把它标成来源缺失。
    const noSource = await store.createMemory({
      content: '报价单 v3 合计 184320 元（这条故意没有来源，用来演示「来源丢失」）',
      summary: '报价单 v3 合计 184320 元',
      layer: 'fragment',
      type: 'semantic',
      sourceType: 'tool',
      confidence: 0.7,
      importance: 0.5,
    });

    process.stdout.write(
      [
        '',
        `  已写入 ${created.length + 1} 条合成记忆 → ${args.dbPath}`,
        `  其中 1 条无来源：${noSource.id}`,
        '',
      ].join('\n'),
    );

    // ---- 来源事件与来源引用
    // 演示数据要能展示「来源已核对」这一档，否则检查器里全是「无来源」，看不出区别。
    // events 是原始事件（唯一事实来源），source_refs 指向它；这里用直接 SQL 造，
    // 真实运行由连接器 + 记忆层写入。
    const db = store.db;
    const now = new Date().toISOString();
    const insertEvent = db.prepare(
      `INSERT OR REPLACE INTO events (
         event_id, schema_version, source_system, source_event_id, scope_id, person_id,
         session_id, turn_id, step_id, source_seq, event_type, origin_system,
         payload_ref, payload_hash, privacy, occurred_at, occurred_at_local,
         received_at, received_at_local, time_zone, content_fingerprint,
         created_at, created_at_local
       ) VALUES (?, 1, 'dsh', ?, 'owner-default', 'owner',
                 'demo-session-a', 'turn-1', 'step-1', ?, 'user/message', 'human',
                 ?, ?, 'private', ?, ?, ?, ?, 'Asia/Shanghai', ?,
                 ?, ?)`,
    );
    const insertRef = db.prepare(
      `INSERT OR REPLACE INTO source_refs (
         ref_id, memory_id, source_kind, event_id, source_system, source_event_id,
         locator, content_hash, independent_source_key, created_at, created_at_local
       ) VALUES (?, ?, 'event', ?, 'dsh', ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < 5; i += 1) {
      const memoryId = created[i];
      if (memoryId === undefined) continue;
      const eventId = `evt_demo_${String(i).padStart(2, '0')}`;
      const payloadHash = `sha256:demo-payload-${i}`;
      insertEvent.run(
        eventId,
        `host-demo-${i}`,
        i + 1,
        `inline:${eventId}`,
        payloadHash,
        now,
        now,
        now,
        now,
        `fp-demo-${i}`,
        now,
        now,
      );
      insertRef.run(
        `ref_demo_${String(i).padStart(2, '0')}`,
        memoryId,
        eventId,
        `host-demo-${i}`,
        `inline:${eventId}`,
        payloadHash,
        `dsh:${eventId}`,
        now,
        now,
      );
    }

    // ---- 演示用构包
    // 真实运行里 context_packages 由 `@dsh-brain/context` 写入，本脚本不代劳；
    // 这里造几行是为了让检查器能把三级证据阶梯、预算明细、被丢掉的段都展示出来，
    // 并且**故意覆盖几种状态**，方便一眼看出「built ≠ attached ≠ sent」。
    //
    // 0003 迁移加的五个列（budget_json / carrier / sent_evidence_json /
    // evidence_strength / segments_json）在这里都要写：不写的话检查器只能显示
    // 「未记录」，那看着像能力缺失，其实是数据没给。
    const insert = db.prepare(
      `INSERT OR REPLACE INTO context_packages (
         context_id, scope_id, person_id, session_id, turn_id, policy_version,
         tokenizer_id, estimated_tokens, memory_versions, deletion_epoch, payload_hash,
         status, built_at, built_at_local, attached_at, attached_at_local,
         sent_at, sent_at_local, created_at, created_at_local,
         budget_json, carrier, sent_evidence_json, evidence_strength, segments_json
       ) VALUES (?, 'owner-default', 'owner', ?, ?, 'm2.0', ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, ?, ?, ?, ?)`,
    );
    const seg = (id) => JSON.stringify([{ memoryId: id, version: 1 }]);
    /** 演示构包的时间戳：让列表顺序稳定，也顺带演示「越新越靠前」。 */
    const at = (agoSeconds) => new Date(Date.now() - agoSeconds * 1000);
    const localOf = (date) =>
      `${new Date(date).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace(' ', 'T')}+08:00`;
    const budget = (allowance, used, dropped) =>
      JSON.stringify({ brainAllowance: allowance, used, dropped });
    const rows = [
      {
        id: 'demo-ctx-built',
        session: 'demo-session-a',
        turn: 'turn-1',
        tokens: 620,
        segs: seg(created[0]),
        status: 'built',
        attached: null,
        sent: null,
        ago: 1800,
        budget: budget(2048, 620, [
          { memoryId: created[5], reason: '低相关（得分 0.09 < 阈值 0.34）' },
          { memoryId: created[2], reason: '超出 brainCap：按相关度从低到高丢弃' },
        ]),
        carrier: null,
        sentEvidence: null,
        strength: 'primary',
        segmentsJson: JSON.stringify([
          { memoryId: created[0], version: 1, layer: 'long', type: 'semantic', summary: '客厅吊顶标高 1.2m，石膏板叠级，灯槽 1200mm' },
        ]),
      },
      {
        id: 'demo-ctx-attached',
        session: 'demo-session-a',
        turn: 'turn-2',
        tokens: 480,
        segs: seg(created[1]),
        status: 'attached',
        attached: true,
        sent: null,
        ago: 1200,
        budget: budget(2048, 480, []),
        carrier: 'system',
        sentEvidence: null,
        strength: 'primary',
        segmentsJson: JSON.stringify([
          { memoryId: created[1], version: 1, layer: 'long', type: 'semantic', summary: '建施-03 窗台 900mm，石材 2400×600 对缝' },
        ]),
      },
      {
        id: 'demo-ctx-sent',
        session: 'demo-session-b',
        turn: 'turn-3',
        tokens: 910,
        segs: seg(created[2]),
        status: 'sent',
        attached: true,
        sent: true,
        ago: 420,
        budget: budget(2048, 910, [
          { memoryId: created[1], reason: '隐私级别 private，按当前会话策略不注入' },
        ]),
        carrier: 'messages[role=system]',
        sentEvidence: JSON.stringify({
          evidenceLevel: 'request_object_hit',
          provesWireDelivery: false,
          observedHashLocations: ['messages[2]'],
        }),
        strength: 'ngram_fallback',
        segmentsJson: JSON.stringify([
          { memoryId: created[2], version: 1, layer: 'fragment', type: 'episode', summary: '轻钢龙骨 75 系隔墙 128 元/㎡' },
        ]),
      },
    ];
    for (const row of rows) {
      const builtAt = at(row.ago);
      const stamp = builtAt.toISOString();
      insert.run(
        row.id,
        row.session,
        row.turn,
        'estimate:chars/2.5',
        row.tokens,
        row.segs,
        `sha256:demo-${row.id}`,
        row.status,
        stamp,
        localOf(builtAt),
        row.attached ? stamp : null,
        row.attached ? localOf(builtAt) : null,
        row.sent ? stamp : null,
        row.sent ? localOf(builtAt) : null,
        stamp,
        localOf(builtAt),
        row.budget,
        row.carrier,
        row.sentEvidence,
        row.strength,
        row.segmentsJson,
      );
    }
    // 第四行：带完整快照（segments + injectedText + budget + dropped），
    // 用来验证「有明细就显示明细、没明细就如实说没记录」这一对行为。
    const snapshotAt = at(60);
    insert.run(
      'demo-ctx-snapshot',
      'demo-session-b',
      'turn-4',
      'estimate:chars/2.5',
      900,
      JSON.stringify({
        segments: [{ memoryId: created[0], version: 1, summary: '客厅吊顶标高 1.2m，石膏板叠级，灯槽 1200mm' }],
        injectedText: '<!-- brain:demo-ctx-snapshot -->\n- 客厅吊顶标高 1.2m，石膏板叠级，灯槽 1200mm',
        budget: {
          brainAllowance: 2048,
          used: 900,
          dropped: [{ memoryId: created[5], reason: '低相关（得分 0.11 < 阈值 0.34）' }],
        },
      }),
      'sha256:demo-ctx-snapshot',
      'built',
      snapshotAt.toISOString(),
      localOf(snapshotAt),
      null,
      null,
      null,
      null,
      snapshotAt.toISOString(),
      localOf(snapshotAt),
      // 这一行同时写「正列」（budget_json）与「老快照」（memory_versions），
      // 用来证明检查器两种来源都认、且优先取列。
      budget(2048, 900, [{ memoryId: created[5], reason: '低相关（得分 0.11 < 阈值 0.34）' }]),
      'messages[role=system]',
      null,
      'primary',
      JSON.stringify([
        { memoryId: created[0], version: 1, layer: 'long', type: 'semantic', summary: '客厅吊顶标高 1.2m，石膏板叠级，灯槽 1200mm' },
      ]),
    );

    process.stdout.write(
      [
        `  已写入 4 个演示构包（built / attached / sent / 带预算快照）`,
        '    · 预算、载体、sent 明细、检索质量都写进了 0003 的正列（budget_json 等）',
        '    · demo-ctx-sent 故意标了 ngram_fallback，用来看「弱证据」徽章长什么样',
        '',
        '  注意：这些全是演示用的合成数据，不是真实记忆；构包行也是模拟的，',
        '  真实运行时由 context 层写入。',
        '',
      ].join('\n'),
    );

    // ---- M3：删除四层 + 备份中心 -----------------------------------------
    //
    // 顺序有意为之：**先建备份，再删内容**。这样第 3 层才有「含这条内容的旧备份」可算；
    // 反过来（先删后备份）永远算不出风险，也就演示不出这一层。
    const brain = store.brain;
    /** @type {string[]} */
    const backupIds = [];
    if (typeof brain.backup?.createSnapshot === 'function') {
      for (const label of ['早于删除的那一份', '删除之后的那一份']) {
        try {
          const snap = await brain.backup.createSnapshot({ kind: 'manual' });
          backupIds.push(String(snap?.backup_id ?? ''));
        } catch (err) {
          process.stdout.write(`  （备份跳过：${err instanceof Error ? err.message : String(err)}）\n`);
          break;
        }
        // 让两份备份的时间错开，便于看出「哪份早于删除」
        void label;
      }
      // 把备份时间挪到「几天前」，并把 retention_until 写实，第 3 层才有到期时间可算
      const shift = (/** @type {number} */ days, /** @type {number} */ keep) => {
        const created = new Date(Date.now() - days * 86400_000);
        const until = new Date(created.getTime() + keep * 86400_000);
        return { created: created.toISOString(), until: until.toISOString() };
      };
      backupIds.forEach((backupId, index) => {
        if (!backupId) return;
        const when = shift(index === 0 ? 9 : 5, 7);
        brain.db
          .prepare('UPDATE backups SET created_at = ?, created_at_local = ?, retention_until = ? WHERE backup_id = ?')
          .run(when.created, localOf(new Date(when.created)), when.until, backupId);
      });
    }

    // 三条删除，分别覆盖「清理已完成 / 还没开始 / 有一步失败」
    /** @type {Array<{ memoryId: string, agoDays: number, jobs: Array<{ status: string, kind?: string, lastError?: string }> }>} */
    const deletionPlan = [
      { memoryId: created[3], agoDays: 4, jobs: [{ status: 'done' }, { status: 'done', kind: 'scrub_index' }] },
      { memoryId: created[4], agoDays: 2, jobs: [] },
      {
        memoryId: created[5],
        agoDays: 1,
        jobs: [{ status: 'done' }, { status: 'failed', kind: 'purge_blobs', lastError: 'EBUSY: 文件被另一个进程占用' }],
      },
    ];
    /** @type {string[]} */
    const deletedIds = [];
    for (const plan of deletionPlan) {
      if (typeof plan.memoryId !== 'string') continue;
      try {
        const result = await brain.deletion.requestDeletion({
          target_kind: 'memory',
          target_id: plan.memoryId,
          scope_id: 'owner-default',
          reason: '演示：主人要求删掉这条记忆',
        });
        deletedIds.push(`${plan.memoryId} → ${String(result.tombstone_id)}`);

        // 把时间改到「几天前」，并重写清理任务状态（真实 worker 不会在这个脚本里跑）
        const requestedAt = new Date(Date.now() - plan.agoDays * 86400_000);
        brain.db
          .prepare(
            'UPDATE deletion_tombstones SET requested_at = ?, requested_at_local = ?, status = ? WHERE tombstone_id = ?',
          )
          .run(
            requestedAt.toISOString(),
            localOf(requestedAt),
            plan.jobs.length === 0 ? 'pending' : plan.jobs.every((j) => j.status === 'done') ? 'purged' : 'pending',
            String(result.tombstone_id),
          );
        brain.db.prepare('DELETE FROM deletion_jobs WHERE tombstone_id = ?').run(String(result.tombstone_id));
        let index = 0;
        for (const job of plan.jobs) {
          index += 1;
          const finished = job.status === 'done' ? new Date(requestedAt.getTime() + 3000).toISOString() : null;
          brain.db
            .prepare(
              `INSERT INTO deletion_jobs (
                 job_id, tombstone_id, target_kind, target_id, scope_id, kind,
                 status, attempts, max_attempts, last_error, deletion_epoch,
                 created_at, created_at_local, started_at, started_at_local, finished_at, finished_at_local
               ) VALUES (?, ?, 'memory', ?, 'owner-default', ?, ?, 1, 5, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              `job_demo_${index}_${Date.now()}_${index}`,
              String(result.tombstone_id),
              plan.memoryId,
              job.kind ?? 'purge_text',
              job.status,
              job.lastError ?? null,
              Number(result.deletion_epoch),
              requestedAt.toISOString(),
              localOf(requestedAt),
              requestedAt.toISOString(),
              localOf(requestedAt),
              finished,
              finished === null ? null : localOf(new Date(finished)),
            );
        }
      } catch (err) {
        process.stdout.write(`  （删除演示跳过一条：${err instanceof Error ? err.message : String(err)}）\n`);
      }
    }

    // 删除屏障会把「删除时已存在」的 built/attached 包保守标成 discarded——那是**正确行为**
    // （旧包可能含被删内容）。但演示要同时看到 built / attached / sent 三种阶梯，
    // 所以这里把三个包的状态改回原值，等价于「它们是这次删除之后才建的」。
    brain.db
      .prepare(
        "UPDATE context_packages SET status = 'built', attached_at = NULL, sent_at = NULL WHERE context_id = 'demo-ctx-built'",
      )
      .run();
    brain.db
      .prepare(
        "UPDATE context_packages SET status = 'attached', sent_at = NULL WHERE context_id = 'demo-ctx-attached'",
      )
      .run();
    brain.db
      .prepare("UPDATE context_packages SET status = 'built' WHERE context_id = 'demo-ctx-snapshot'")
      .run();

    process.stdout.write(
      [
        `  备份 ${backupIds.filter(Boolean).length} 份 → ${backupDir}`,
        `  删除 ${deletedIds.length} 条（覆盖已清理 / 未开始 / 有失败三种状态）`,
        '',
        '  下一步：',
        `    node apps/server/index.mjs --db ${args.dbPath} --port 0 --allow-backup`,
        '    # 想看隔离横幅：再加 --isolation-reason "演示：恢复实例未通过校验"',
        '',
      ].join('\n'),
    );
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  process.stderr.write(`播种失败：${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
