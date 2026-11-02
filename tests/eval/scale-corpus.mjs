// @ts-check
/**
 * §18.1「长上下文测试」的规模版语料生成器。
 *
 * ── 设计文档 §18.1 要求什么 ──
 *
 * 1. 构造**十万字以上、多会话**历史，在**早期**放入人物称呼、项目参数和承诺，**后期**分别询问
 * 2. 检查是否返回正确内容、正确来源和有效版本
 * 3. 检查上下文是否只包含相关片段，而不是整段历史
 * 4. 修改早期参数后，确认旧参数不再被当作当前事实
 * 5. 对代码、表格和配置执行精确回查
 * 6. 服务重启后从任务快照继续（**第 6 条当前不适用**：task_snapshots 为空，未实现）
 *
 * ── 这份语料怎么造 ──
 *
 * 不是随机堆字——随机文本测不出「找得回」。结构是：
 *   - **早期层**（前 60 条，时间最早）：核心约定（项目、报价、图号、承诺、称呼）
 *   - **干扰层**（中间 700+ 条）：结构高度相似但值不同的其它项目记录
 *   - **晚期层**（最后 40 条）：与早期约定无关的杂项
 *
 * 关键：干扰层与早期层**同域、同句式、只差数字和图号**。这样「找得回」靠的是真的能区分，
 * 不是靠唯一词碰巧命中。
 *
 * ── 为什么用合成数据 ──
 *
 * §22.3 明写「原始数据合成，不使用真实隐私」。这里的项目名、报价、图号全是编的。
 */

/** 早期约定的唯一标识（查询就围绕这些） */
export const ANCHOR = Object.freeze({
  project: '沁园里三期',
  owner: '周工',
  quoteKey: '锚定报价',
  quoteValue: 268,
  quoteUnit: '元/平米',
  drawing: '建施-900',
  // 材料必须带一个干扰层造不出来的后缀，否则会撞车：
  // 干扰生成器的材料是 `${10+((i*3)%80)}mm` + 岩棉/挤塑板/聚氨酯/玻璃棉，
  // 当 i 让厚度恰好等于 30 且材料是岩棉时，会生成跟锚定值一模一样的「30mm 岩棉」——
  // 那样 X07 查询就分不清哪条是锚定的，测的变成运气而不是检索能力（第一版就撞了）。
  material: '30mm 岩棉板（A 级）',
  promise: '11 月 20 日前交消防专篇',
  code: 'npm run ship:prod',
  port: '9901',
})

/**
 * 生成一条记忆的正文。所有数字都由种子决定，可复现。
 * @param {number} i
 */
function noiseMemory(i) {
  // 干扰层：结构跟锚定条目一模一样，只有项目名/数值/图号不同
  const project = `沁园里${['一期', '二期', '四期', '五期', '六期'][i % 5]}`
  const owner = ['赵工', '钱工', '孙工', '李工', '吴工', '郑工', '王工'][i % 7]
  const quote = 100 + ((i * 37) % 300)
  const drawing = `建施-${100 + (i % 700)}`
  const material = `${10 + ((i * 3) % 80)}mm ${['岩棉', '挤塑板', '聚氨酯', '玻璃棉'][i % 4]}`
  return {
    summary: `${project} 外墙报价：${material}，${quote} 元/平米`,
    content: `${project} 外墙保温报价按 ${quote} 元/平米计，材料为 ${material}，对接人 ${owner}，图号 ${drawing}。`,
    type: 'semantic',
    importance: 0.5,
  }
}

/**
 * 生成完整语料。
 * @param {{ noiseCount?: number }} [opts]
 * @returns {{ early: any[], noise: any[], late: any[], total: number, totalChars: number }}
 */
export function buildScaleCorpus(opts = {}) {
  const noiseCount = opts.noiseCount ?? 720

  // ── 早期层：核心约定（这些是「晚期要问」的答案）────────────────
  /** @type {any[]} */
  const early = [
    {
      key: 'anchor_project',
      summary: `项目：${ANCHOR.project}，对接人 ${ANCHOR.owner}`,
      content: `${ANCHOR.project} 是当前主项目，甲方对接人是${ANCHOR.owner}，出图节奏每两周一次，所有图号前缀沿用本项目编号。`,
      type: 'profile', importance: 0.95,
    },
    {
      key: 'anchor_quote',
      summary: `${ANCHOR.quoteKey}：${ANCHOR.quoteValue} ${ANCHOR.quoteUnit}`,
      content: `${ANCHOR.project} 外墙保温${ANCHOR.quoteKey}定为 ${ANCHOR.quoteValue} ${ANCHOR.quoteUnit}，材料 ${ANCHOR.material}，图号 ${ANCHOR.drawing}。这个价格是含税含辅料的包干价。`,
      type: 'semantic', importance: 0.95,
    },
    {
      key: 'anchor_promise',
      summary: `承诺：${ANCHOR.promise}`,
      content: `答应${ANCHOR.owner}：${ANCHOR.promise}，需要包含计算书和材料表两部分。`,
      type: 'commitment', importance: 0.95,
    },
    {
      key: 'anchor_code',
      summary: `发布命令：${ANCHOR.code}`,
      content: `${ANCHOR.project} 的出包发布用 ${ANCHOR.code}，不要用 npm run build，那个只出调试包。`,
      type: 'skill', importance: 0.9,
    },
    {
      key: 'anchor_port',
      summary: `分发端口：${ANCHOR.port}`,
      content: `${ANCHOR.project} 的图纸分发走 FTP 端口 ${ANCHOR.port}，被动模式。`,
      type: 'semantic', importance: 0.85,
    },
  ]

  // ── 干扰层 ──────────────────────────────��─────────────────────
  /** @type {any[]} */
  const noise = []
  for (let i = 0; i < noiseCount; i += 1) {
    noise.push({ key: `noise_${i}`, ...noiseMemory(i) })
  }

  // ── 晚期层：与早期约定无关的杂项 ────────────────────────────
  /** @type {any[]} */
  const late = Array.from({ length: 40 }, (_, i) => ({
    key: `late_${i}`,
    summary: `杂项 ${i + 1}：无关话题记录`,
    content: `这是第 ${i + 1} 条与主项目无关的记录，内容涉及日常杂事编号 ${1000 + i}，用于把历史拉长并检验干扰。`,
    type: 'episode', importance: 0.3,
  }))

  const all = [...early, ...noise, ...late]
  const totalChars = all.reduce((n, m) => n + String(m.content).length + String(m.summary).length, 0)

  return { early, noise, late, total: all.length, totalChars }
}

/**
 * §18.1 的查询集：全部指向**早期层**的约定，晚期提问。
 * 每条都带期望锚点 key，以及「不许召回」的干扰特征。
 * @returns {Array<{ id: string, query: string, expectKeys: string[], forbidPattern?: string, note: string }>}
 */
export function buildScaleQueries() {
  return [
    { id: 'X01', query: '主项目是哪个 对接人是谁', expectKeys: ['anchor_project'], note: '人物称呼 + 项目' },
    { id: 'X02', query: `${ANCHOR.project} 对接人`, expectKeys: ['anchor_project', 'anchor_quote'], note: '项目名精确' },
    { id: 'X03', query: '外墙保温包干价多少', expectKeys: ['anchor_quote'], forbidPattern: '元/平米', note: '报价（干扰层也有元/平米，靠项目+图号区分）' },
    { id: 'X04', query: `${ANCHOR.quoteKey}`, expectKeys: ['anchor_quote'], note: '锚定词精确回查' },
    { id: 'X05', query: `${ANCHOR.quoteValue} 元/平米`, expectKeys: ['anchor_quote'], note: '精确数值回查' },
    { id: 'X06', query: `${ANCHOR.drawing}`, expectKeys: ['anchor_quote'], note: '图号精确回查' },
    { id: 'X07', query: `${ANCHOR.material}`, expectKeys: ['anchor_quote'], note: '材料精确回查' },
    { id: 'X08', query: '答应什么时候交消防专篇', expectKeys: ['anchor_promise'], note: '承诺' },
    { id: 'X09', query: '消防专篇要包含什么', expectKeys: ['anchor_promise'], note: '承诺细节' },
    { id: 'X10', query: '出包发布用哪个命令', expectKeys: ['anchor_code'], note: '配置精确回查' },
    { id: 'X11', query: `${ANCHOR.code}`, expectKeys: ['anchor_code'], note: '命令原文' },
    { id: 'X12', query: '图纸分发走什么端口', expectKeys: ['anchor_port'], note: '配置' },
    { id: 'X13', query: `${ANCHOR.port}`, expectKeys: ['anchor_port'], note: '端口精确' },
    { id: 'X14', query: `${ANCHOR.owner} 负责哪个项目`, expectKeys: ['anchor_project'], note: '人物反查' },
    { id: 'X15', query: '出图节奏是多久一次', expectKeys: ['anchor_project'], note: '项目细节' },
    { id: 'X16', query: '外墙保温材料是什么', expectKeys: ['anchor_quote'], note: '材料' },
    { id: 'X17', query: '包干价含不含辅料', expectKeys: ['anchor_quote'], note: '报价口径' },
    { id: 'X18', query: '计算书和材料表哪来的', expectKeys: ['anchor_promise'], note: '承诺分解' },
    { id: 'X19', query: '发布不要用哪个命令', expectKeys: ['anchor_code'], note: '反向表述（不许用 build）' },
    { id: 'X20', query: 'FTP 被动模式那个端口', expectKeys: ['anchor_port'], note: '配置组合' },
  ]
}
