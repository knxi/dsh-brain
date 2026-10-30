// @ts-check
/**
 * 把 fixtures 的合成种子灌进临时库，返回 key → memoryId 的映射。
 *
 * 为什么用临时库：§22.3 要求「原始数据合成，不使用真实隐私」。
 * 这个种子库与生产 `data/brain.db` 完全隔离，跑完即删。
 */

import { openBrain } from '../../packages/memory/src/index.js'
import { EVAL_PERSON, EVAL_SCOPE, MEMORIES } from './fixtures.mjs'

/**
 * @param {{ dbPath: string, migrationsDir: string }} opts
 * @returns {Promise<{ brain: any, keyToId: Map<string, string>, close: () => Promise<void> }>}
 */
export async function seedBrain(opts) {
  const brain = openBrain({
    dbPath: opts.dbPath,
    migrationsDir: opts.migrationsDir,
    bindings: { scope_id: EVAL_SCOPE, person_id: EVAL_PERSON },
  })

  /** @type {Map<string, string>} */
  const keyToId = new Map()

  for (const m of MEMORIES) {
    const created = await brain.memories.create({
      scopeId: EVAL_SCOPE,
      personId: EVAL_PERSON,
      layer: m.layer,
      type: m.type,
      content: m.content,
      summary: m.summary,
      // 合成种子是「二手来料但带出处」，用 summary 而不是 owner_words：
      // 契约禁止 originSystem=brain 的内容标成 owner_words（那是让系统自己造的东西
      // 冒充主人原话，CONTRACTS §10.6 的注入闭环事故就是这么来的）。
      // 这条护栏挡了我两次，说明它是对的。
      sourceType: m.sourceType || 'summary',
      sourceIds: [],
      confidence: 0.9,
      importance: m.importance,
      privacy: 'private',
      // originSystem 只接受 brain / dsh / engram / lingshu（见 memory-util 的枚举校验）。
      // 评测种子是本系统自己造的合成数据，所以是 brain；
      // 「这是评测数据」这件事靠 producer 区分，不去改枚举。
      originSystem: 'brain',
      producer: 'tests/eval/seed',
      ...(m.validFrom ? { validFrom: m.validFrom } : {}),
      ...(m.validUntil ? { validUntil: m.validUntil } : {}),
    })
    keyToId.set(m.key, created.id)

    // 每条都要有来源，否则 §22.3 的「来源可追溯率 100%」永远不可能达标——
    // 而那是**评测基础设施**该保证的，不该让被测系统背锅。
    await brain.sources.link(created.id, {
      sourceKind: 'tool_call',
      sourceSystem: 'eval',
      sourceEventId: `eval:${m.key}`,
      locator: `tests/eval/fixtures#${m.key}`,
    })
  }

  return {
    brain,
    keyToId,
    close: async () => {
      try {
        await brain.close()
      } catch {
        /* 关不掉不影响结论 */
      }
    },
  }
}
