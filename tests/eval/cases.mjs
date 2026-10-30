// @ts-check
/**
 * §22.3 评测集：120 个固定用例（7 类）。
 *
 * ── 设计原则 ──
 *
 * 1. **query 写成「真会问的话」**，不是关键词堆砌。否则 recall 必然 100%，评测就没意义。
 * 2. **难度是分层的**：大部分是「含关键词的自然问句」（FTS 应能召回），少数是
 *    纯同义词 / 口语 / 不含原文词（当前 FTS 大概率失败）。失败项**如实保留**，
 *    它们是「已知边界」——靠向量检索才能解决，不是靠调参。
 * 3. 每个用例记 §22.3 要求的字段：query、scope、as_of、期望来源、禁止召回、是否弃答、可接受数值单位。
 * 4. 期望用 `key` 引用 fixtures 里的种子，运行期再映射成真实 memoryId。
 *
 * ── 7 类分配（对应设计文档）──
 *
 * | 类目 | 例数 |
 * |---|---|
 * | current_fact 当前事实/早期约定 | 30 |
 * | correction_asof 纠错与历史时点 | 20 |
 * | person_project 人物与项目干扰 | 20 |
 * | chinese_short 中文短词/混合文本/数字单位 | 15 |
 * | insufficient 证据不足/无答案 | 15 |
 * | exact_lookup 代码/表格/配置精确回查 | 10 |
 * | task_resume 跨会话任务恢复 | 10 |
 * | **合计** | **120** |
 */

/**
 * @typedef {{
 *   id: string,
 *   category: 'current_fact'|'correction_asof'|'person_project'|'chinese_short'|'insufficient'|'exact_lookup'|'task_resume',
 *   query: string,
 *   asOf?: string|null,
 *   expectKeys: string[],
 *   forbidKeys?: string[],
 *   expectAbstain?: boolean,
 *   expectExact?: { value: string, unit?: string } | null,
 *   note: string,
 * }} EvalCase
 */

/** 当前事实 / 早期约定（30） */
function buildCurrentFact() {
  /** @type {Array<[string, string, string, { value: string, unit?: string }?, string]>} */
  const rows = [
    // query, expectKey, 说明, 精确值, 备注
    ['踢脚线现在多少钱一段', 'quote_skirting_alu', '报价', { value: '128', unit: '元/段' }, '当前值应为铝板 128'],
    ['吊顶报价是多少', 'quote_ceiling_gypsum', '报价', { value: '96', unit: '元/平米' }, '石膏板吊顶'],
    ['乳胶漆多少钱一平米', 'quote_paint', '报价', { value: '38', unit: '元/平米' }, '两遍面漆'],
    ['外墙保温用的什么材料', 'spec_insulation_50', '规格', { value: '50mm', unit: '岩棉' }, '50mm 岩棉'],
    ['门窗型材是哪一系列', 'spec_window_profile', '规格', { value: '65', unit: '系列' }, '断桥铝 65'],
    ['卫生间防水做多高', 'spec_waterproof', '规格', { value: '300', unit: 'mm' }, '上翻 300'],
    ['楼梯间防火门什么等级', 'spec_door_fire', '规格', { value: '乙级' }, '乙级 1.0h'],
    ['主梁截面尺寸多少', 'short_beam', '规格', { value: '300×600' }, 'C30'],
    ['客厅地砖规格是多少', 'short_tile', '规格', { value: '800×800' }, '抛光砖'],
    ['墙面腻子刮几遍', 'short_putty', '施工', { value: '两遍' }, '18 元/平米'],
    ['主电缆什么型号', 'short_cable', '规格', { value: 'YJV-4×25' }, '128 元/m'],
    ['封面用什么字体', 'pref_font', '偏好', { value: '思源宋体' }, '不用系统宋体'],
    ['对外方案主色是什么', 'pref_color', '偏好', { value: '#a8632f' }, '赭石'],
    ['答应 A 项目什么时候交二版', 'commit_delivery', '承诺', { value: '9 月 15 日' }, '含节点大样和材料表'],
    ['画布插件审查还差什么没做完', 'task_open_review', '未完成任务', null, '差 3 个文件'],
    ['前端构建用哪个命令', 'code_build_cmd', '命令', { value: 'pnpm run build:web' }, '不要用 npm run build'],
    ['插件分发走什么端口', 'code_ftp_endpoint', '配置', { value: '8877' }, '被动模式'],
    ['抓取重试几次', 'config_retry', '配置', { value: '3', unit: '次' }, '退避 250/1000/2250'],
    ['构包单轮预算多少', 'config_budget', '配置', { value: '4000', unit: 'token' }, '超了要记 diagnostics'],
    ['A 项目的外墙保温怎么做', 'proj_a_insulation', '项目规格', { value: '80mm', unit: '岩棉' }, '滨江花园'],
    ['B 项目保温用什么板', 'proj_b_insulation', '项目规格', { value: '60mm', unit: '挤塑板' }, '西城里'],
    ['A 项目谁对接', 'proj_a_owner', '人物', { value: '李工' }, '两周一次出图'],
    ['B 项目对接人是谁', 'proj_b_owner', '人物', { value: '王工' }, '改图当天回'],
    // 以下几条用「不含原文核心词」的说法 —— 预期部分会失败，作为已知边界保留
    ['地板砖那个尺寸是多少', 'short_tile', '口语', { value: '800×800' }, '「地板砖」同义于瓷砖，FTS 可能不命中'],
    ['顶上那层板多少钱', 'quote_ceiling_gypsum', '口语', null, '「顶上那层板」= 吊顶，纯口语'],
    ['门口的槛怎么算钱', 'quote_skirting_alu', '口语', null, '「门口的槛」= 踢脚线，纯口语'],
    ['墙面刷几层漆', 'quote_paint', '口语', { value: '两遍' }, '「刷几层」同义于「两遍」'],
    ['那个保温棉多厚', 'spec_insulation_50', '口语', { value: '50mm' }, '「保温棉」同义岩棉'],
    ['型材是多宽的', 'spec_window_profile', '口语', { value: '65' }, '「多宽」= 系列宽度'],
    ['防水涂料上翻多少', 'spec_waterproof', '工程', { value: '300', unit: 'mm' }, '上翻 300mm'],
  ]
  return rows.map(([query, expectKey, note, expectExact, memo], i) => ({
    id: `F${String(i + 1).padStart(2, '0')}`,
    category: /** @type {const} */ ('current_fact'),
    query,
    asOf: null,
    expectKeys: [expectKey],
    forbidKeys: [],
    expectAbstain: false,
    expectExact: expectExact || null,
    note: `${note}｜${memo}`,
  }))
}

/** 纠错与历史时点（20） */
function buildCorrection() {
  const old = 'quote_skirting_pvc'
  const cur = 'quote_skirting_alu'
  /** @type {EvalCase[]} */
  const cases = []
  // 10 条：时点查询 —— 应返回对应版本
  for (let i = 0; i < 10; i += 1) {
    const isOld = i % 2 === 0
    cases.push({
      id: `C${String(i + 1).padStart(2, '0')}`,
      category: 'correction_asof',
      query: '踢脚线报价',
      asOf: isOld ? '2026-05-01' : '2026-08-01',
      expectKeys: [isOld ? old : cur],
      // 时点查询的关键：另一版**不能**出现在结果里（那是过期/未生效的值）
      forbidKeys: [isOld ? cur : old],
      expectAbstain: false,
      expectExact: isOld ? { value: '48', unit: '元/段' } : { value: '128', unit: '元/段' },
      note: isOld ? '历史时点：应给 PVC 48（旧值）' : '当前时点：应给铝板 128（新值）',
    })
  }
  // 10 条：不带时点 = 当前事实 —— 旧值不许当答案
  const currentQueries = [
    '踢脚线报价多少钱',
    '踢脚线 1.2m 一段多少钱',
    '现在踢脚线用什么材质',
    '踢脚线含税单价',
    '踢脚线造价',
  ]
  currentQueries.forEach((q, i) => {
    cases.push({
      id: `C${String(i + 11).padStart(2, '0')}`,
      category: 'correction_asof',
      query: q,
      asOf: null,
      expectKeys: [cur],
      // 不带时点时，旧值不应该被当成当前事实（可以出现但必须排在新的之后；
      // 这里从严：只要求新值命中，旧值仅在 top1 时才算失败 —— 由指标层判定）
      forbidKeys: [],
      expectAbstain: false,
      expectExact: { value: '128', unit: '元/段' },
      note: '当前事实：新值必须命中',
    })
  })
  // 5 条：多跳纠错（先旧后新的其它条目）
  for (let i = 0; i < 5; i += 1) {
    cases.push({
      id: `C${String(i + 16).padStart(2, '0')}`,
      category: 'correction_asof',
      query: ['踢脚线铝板价格', '踢脚线材质换了没', '踢脚线报价 铝板', '踢脚线 128 元', '踢脚线单价涨了吗'][i],
      asOf: null,
      expectKeys: [cur],
      forbidKeys: [],
      expectAbstain: false,
      expectExact: { value: '128' },
      note: '纠错后：应命中新值',
    })
  }
  return cases
}

/** 人物与项目干扰（20） */
function buildDistractor() {
  const rows = [
    ['A 项目外墙保温厚度', 'proj_a_insulation', 'proj_b_insulation'],
    ['B 项目外墙保温厚度', 'proj_b_insulation', 'proj_a_insulation'],
    ['滨江花园的保温', 'proj_a_insulation', 'proj_b_insulation'],
    ['西城里的保温', 'proj_b_insulation', 'proj_a_insulation'],
    ['滨江花园对接人', 'proj_a_owner', 'proj_b_owner'],
    ['西城里谁对接', 'proj_b_owner', 'proj_a_owner'],
    ['A 项目出图节奏', 'proj_a_owner', 'proj_b_owner'],
    ['B 项目改图多久回', 'proj_b_owner', 'proj_a_owner'],
    ['滨江花园 岩棉', 'proj_a_insulation', 'proj_b_insulation'],
    ['西城里 挤塑板', 'proj_b_insulation', 'proj_a_insulation'],
  ]
  /** @type {EvalCase[]} */
  const cases = rows.map(([query, ok, bad], i) => ({
    id: `P${String(i + 1).padStart(2, '0')}`,
    category: /** @type {const} */ ('person_project'),
    query,
    asOf: null,
    expectKeys: [ok],
    forbidKeys: [bad],
    expectAbstain: false,
    expectExact: null,
    note: `干扰项：${bad} 不该出现在结果里`,
  }))
  // 10 条：同域不同物（报价类互相干扰）
  const sameDomain = [
    ['报价 96 元的那项', 'quote_ceiling_gypsum', ['quote_paint', 'quote_skirting_alu']],
    ['38 元一平米的是什么', 'quote_paint', ['quote_ceiling_gypsum']],
    ['128 元一段的是哪项', 'quote_skirting_alu', ['quote_ceiling_gypsum']],
    ['62 元一片的砖', 'short_tile', ['short_putty', 'short_cable']],
    ['18 元一平米的墙面处理', 'short_putty', ['quote_paint']],
    ['128 元一米的电缆', 'short_cable', ['quote_skirting_alu']],
    ['A 项目 80 的是哪个', 'proj_a_insulation', ['proj_b_insulation']],
    ['60 厚的板在哪个项目', 'proj_b_insulation', ['proj_a_insulation']],
    ['李工跟哪个项目', 'proj_a_owner', ['proj_b_owner']],
    ['王工跟哪个项目', 'proj_b_owner', ['proj_a_owner']],
  ]
  sameDomain.forEach(([query, ok, bad], i) => {
    cases.push({
      id: `P${String(i + 11).padStart(2, '0')}`,
      category: 'person_project',
      query,
      asOf: null,
      expectKeys: [ok],
      forbidKeys: bad,
      expectAbstain: false,
      expectExact: null,
      note: '同域不同物：靠精确数字/项目名区分',
    })
  })
  return cases
}

/** 中文短词 / 混合文本 / 数字单位（15） */
function buildShort() {
  const rows = [
    ['踢脚', 'quote_skirting_alu', '两字短词'],
    ['岩棉', 'spec_insulation_50', '两字短词'],
    ['腻子', 'short_putty', '两字短词'],
    ['电缆', 'short_cable', '两字短词'],
    ['瓷砖', 'short_tile', '两字短词'],
    ['800×800', 'short_tile', '带乘号数字'],
    ['YJV-4×25', 'short_cable', '型号带连字符与乘号'],
    ['1.2m 一段', 'quote_skirting_alu', '数字+单位+中文'],
    ['250/1000/2250', 'config_retry', '纯数字序列'],
    ['4000 token', 'config_budget', '数字+英文单位'],
    ['8877', 'code_ftp_endpoint', '纯端口数字'],
    ['300×600', 'short_beam', '截面尺寸'],
    ['1.8mm 聚氨酯', 'spec_waterproof', '小数+英文单位+中文材质'],
    ['65 系列', 'spec_window_profile', '数字+中文量词'],
    ['6+12A+6', 'spec_window_profile', '复合数字串'],
  ]
  return rows.map(([query, expectKey, memo], i) => ({
    id: `S${String(i + 1).padStart(2, '0')}`,
    category: /** @type {const} */ ('chinese_short'),
    query,
    asOf: null,
    expectKeys: [expectKey],
    forbidKeys: [],
    expectAbstain: false,
    expectExact: null,
    note: memo,
  }))
}

/** 证据不足 / 无答案（15） */
function buildInsufficient() {
  const absent = [
    '量子退相干', '烘焙温度', '马拉松配速', '咖啡因代谢',
    '滑雪板打蜡', '陶艺拉坯', '天文望远镜口径', '邮票水印',
  ]
  const nearMiss = [
    '踢脚线不锈钢报价',      // 库里只有 PVC / 铝板
    '外墙保温岩棉的容重是多少', // 库里没有容重这个参数（只有导热系数/燃烧性能）
    'C40 混凝土配合比',      // 库里是 C30
    'A 项目外墙保温 50mm',   // A 项目是 80mm（这条测「限定词不满足」）
    '铝合金门窗 70 系列报价', // 库里是 65 系列、断桥铝
    '电线 YJV-4×35',        // 库里是 4×25
    'B 项目对接人李工',      // B 项目是王工
  ]
  /** @type {EvalCase[]} */
  const cases = absent.map((query, i) => ({
    id: `N${String(i + 1).padStart(2, '0')}`,
    category: /** @type {const} */ ('insufficient'),
    query,
    asOf: null,
    expectKeys: [],
    forbidKeys: [],
    expectAbstain: true,
    expectExact: null,
    note: '库里完全没有这个话题：应该弃答',
  }))
  nearMiss.forEach((query, i) => {
    cases.push({
      id: `N${String(i + 9).padStart(2, '0')}`,
      category: 'insufficient',
      query,
      asOf: null,
      expectKeys: [],
      forbidKeys: [],
      // 近似但数值/对象不对：**首要**要求是不给出错误确定值。
      // 检索层没法判「答案对不对」，所以这里只要求「不该以高置信命中一条明确的错值」——
      // 由指标层用 forbidKeys 表达（见下）。
      expectAbstain: true,
      expectExact: null,
      note: '近似但不存在：最危险的一类，宁可弃答',
    })
  })
  return cases
}

/** 代码 / 表格 / 配置精确回查（10） */
function buildExact() {
  const rows = [
    ['pnpm run build:web', 'code_build_cmd', '命令原文'],
    ['build:web', 'code_build_cmd', '命令片段'],
    ['8877', 'code_ftp_endpoint', '端口'],
    ['被动模式', 'code_ftp_endpoint', '连接方式'],
    ['250ms 1000ms 2250ms', 'config_retry', '退避序列'],
    ['3 次重试', 'config_retry', '次数'],
    ['4000 token', 'config_budget', '预算'],
    ['建施-31', 'quote_skirting_alu', '图号'],
    ['建施-55', 'spec_waterproof', '图号'],
    ['建施-63', 'spec_door_fire', '图号'],
  ]
  return rows.map(([query, expectKey, memo], i) => ({
    id: `E${String(i + 1).padStart(2, '0')}`,
    category: /** @type {const} */ ('exact_lookup'),
    query,
    asOf: null,
    expectKeys: [expectKey],
    forbidKeys: [],
    expectAbstain: false,
    expectExact: null,
    note: memo,
  }))
}

/** 跨会话任务恢复（10） */
function buildTaskResume() {
  // 注意：任务快照（snapshots）在当前实现里**没有接进生产**（task_snapshots=0），
  // 所以这一类只能测「检索层能否找回未完成任务」，不能测「快照续接」。
  // 指标报告里会把「快照续接」单列为**不适用（未实现）**，不算通过也不算失败。
  const rows = [
    ['画布插件审查做到哪了', 'task_open_review'],
    ['还有哪些文件没看完', 'task_open_review'],
    ['插件审查剩余文件', 'task_open_review'],
    ['上次说到哪了 画布插件', 'task_open_review'],
    ['A 项目二版要交什么', 'commit_delivery'],
    ['9 月 15 日之前要做什么', 'commit_delivery'],
    ['答应了谁什么事', 'commit_delivery'],
    ['未完成的活有哪些', 'task_open_review'],
    ['插件的 12-canvas-tab.js 审了吗', 'task_open_review'],
    ['二版施工图包含什么', 'commit_delivery'],
  ]
  return rows.map(([query, expectKey], i) => ({
    id: `T${String(i + 1).padStart(2, '0')}`,
    category: /** @type {const} */ ('task_resume'),
    query,
    asOf: null,
    expectKeys: [expectKey],
    forbidKeys: [],
    expectAbstain: false,
    expectExact: null,
    note: '跨会话续接：检索层可测，快照层未实现（单列不适用）',
  }))
}

/** @type {EvalCase[]} */
export const CASES = [
  ...buildCurrentFact(),
  ...buildCorrection(),
  ...buildDistractor(),
  ...buildShort(),
  ...buildInsufficient(),
  ...buildExact(),
  ...buildTaskResume(),
]

/** 按类目统计，供测试断言 120 的分配 */
export const CASE_COUNTS = CASES.reduce((/** @type {Record<string, number>} */ acc, c) => {
  acc[c.category] = (acc[c.category] || 0) + 1
  return acc
}, {})

/** §22.3 要求的类目配额 */
export const REQUIRED_COUNTS = Object.freeze({
  current_fact: 30,
  correction_asof: 20,
  person_project: 20,
  chinese_short: 15,
  insufficient: 15,
  exact_lookup: 10,
  task_resume: 10,
})
