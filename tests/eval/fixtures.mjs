// @ts-check
/**
 * §22.3 评测集的合成种子数据。
 *
 * ── 为什么是合成数据 ──
 *
 * 设计文档 §22.3 明写「原始数据合成，不使用真实隐私」。
 * 这里所有报价、图号、版本号、路径都是编的，只保证**结构真实**：
 * 有旧值/新值、有时间窗、有同名干扰、有精确参数、有不存在的提问。
 *
 * ── 为什么每条记忆都带 key ──
 *
 * 用例要按 key 引用「期望召回/禁止召回」的条目。用 key 而不是 id，
 * 是因为 id 由库在写入时生成，用例定义必须与运行时的 id 解耦。
 *
 * ── 语料结构（对应 §22.3 的 7 类）──
 *
 * 1. 报价/尺寸类：有 v1 旧值 + v2 新值，用来测「当前事实 vs 早期约定」和「纠错/历史时点」
 * 2. 图号/材质类：精确字符串，测「精确回查」
 * 3. 同名干扰：两个项目都有「外墙保温」，测「人物与项目干扰」
 * 4. 短词：1-2 字查询（踢脚、岩棉），测中文短词
 * 5. 库里没有的：测「证据不足/无答案」
 * 6. 跨会话任务：测「任务续接」（注：当前快照未实现，这条会如实记为不适用）
 */

/** 评测库的 scope（与生产隔离，用临时库） */
export const EVAL_SCOPE = 'eval-scope'
export const EVAL_PERSON = 'eval-owner'

/**
 * 种子记忆。
 * `asOfUntil` 用来造「旧值已过期」的版本链：v1 有 validUntil，v2 没有。
 * @typedef {{
 *   key: string, layer: string, type: string, importance: number,
 *   summary: string, content: string,
 *   validFrom?: string|null, validUntil?: string|null,
 *   sourceType?: string,
 * }} SeedMemory
 */

/** @type {SeedMemory[]} */
export const MEMORIES = [
  // ── 1. 报价：旧值 + 新值（纠错 / 历史时点）──────────────────────
  {
    key: 'quote_skirting_pvc',
    layer: 'long', type: 'semantic', importance: 0.75,
    summary: '踢脚线报价 v1：PVC，48 元/段',
    content: '踢脚线报价按 1.2m 一段计，PVC 材质，含税单价 48 元/段，图号 建施-31。',
    validFrom: '2026-03-01T00:00:00.000Z', validUntil: '2026-06-30T23:59:59.000Z',
  },
  {
    key: 'quote_skirting_alu',
    layer: 'long', type: 'semantic', importance: 0.85,
    summary: '踢脚线报价 v2：铝板，128 元/段',
    content: '踢脚线报价按 1.2m 一段计，铝板材质，含税单价 128 元/段，图号 建施-31。',
    validFrom: '2026-07-01T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'quote_ceiling_gypsum',
    layer: 'long', type: 'semantic', importance: 0.7,
    summary: '吊顶报价：石膏板，96 元/平米',
    content: '石膏板吊顶报价 96 元/平米（含龙骨与辅料），图号 建施-42。',
    validFrom: '2026-05-10T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'quote_paint',
    layer: 'long', type: 'semantic', importance: 0.65,
    summary: '乳胶漆：38 元/平米，两遍',
    content: '内墙乳胶漆 38 元/平米，工艺为两遍面漆一遍底漆，图号 建施-44。',
    validFrom: '2026-06-20T00:00:00.000Z', validUntil: null,
  },

  // ── 2. 精确参数 / 图号 / 材质（精确回查）──────────────────────
  {
    key: 'spec_insulation_50',
    layer: 'long', type: 'semantic', importance: 0.8,
    summary: '外墙保温：50mm 岩棉，导热 0.040',
    content: '外墙保温用 50mm 岩棉板，导热系数 0.040 W/(m·K)，燃烧性能 A 级，图号 建施-11。',
    validFrom: '2026-04-12T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'spec_window_profile',
    layer: 'long', type: 'semantic', importance: 0.7,
    summary: '门窗型材：断桥铝 65 系列',
    content: '门窗采用断桥铝合金 65 系列型材，玻璃 6+12A+6 中空，图号 建施-21。',
    validFrom: '2026-04-15T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'spec_waterproof',
    layer: 'long', type: 'semantic', importance: 0.72,
    summary: '卫生间防水：1.8mm 聚氨酯，上翻 300',
    content: '卫生间地面防水采用 1.8mm 聚氨酯涂膜，墙面防水上翻 300mm，图号 建施-55。',
    validFrom: '2026-05-02T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'spec_door_fire',
    layer: 'long', type: 'semantic', importance: 0.68,
    summary: '防火门：乙级，耐火 1.0h',
    content: '楼梯间防火门为乙级钢质防火门，耐火极限 1.0h，图号 建施-63。',
    validFrom: '2026-05-18T00:00:00.000Z', validUntil: null,
  },

  // ── 3. 代码 / 配置 / 表格（精确回查）──────────────────────────
  {
    key: 'code_build_cmd',
    layer: 'long', type: 'skill', importance: 0.7,
    summary: '构建命令：pnpm run build:web',
    content: '前端构建用 pnpm run build:web，产物在 dist/web；不要用 npm run build，会走错脚本。',
    validFrom: '2026-06-01T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'code_ftp_endpoint',
    layer: 'long', type: 'semantic', importance: 0.75,
    summary: '插件分发：FTP 端口 8877，被动模式',
    content: '画布插件走 FTP 分发，端口 8877，被动模式，根目录 /grsai/，账号见凭据库。',
    validFrom: '2026-06-05T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'config_retry',
    layer: 'long', type: 'semantic', importance: 0.6,
    summary: '重试策略：最多 3 次，退避 250/1000/2250ms',
    content: '抓取重试策略最多 3 次，退避间隔 250ms / 1000ms / 2250ms，只对撞锁重试，业务错误直抛。',
    validFrom: '2026-06-10T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'config_budget',
    layer: 'long', type: 'semantic', importance: 0.6,
    summary: '预算：单轮最多 4000 token',
    content: '构包单轮预算上限 4000 token，超了就截断并记录 diagnostics，不许悄悄丢来源。',
    validFrom: '2026-06-11T00:00:00.000Z', validUntil: null,
  },

  // ── 4. 同名干扰：A 项目与 B 项目都有「外墙保温」────────────────
  {
    key: 'proj_a_insulation',
    layer: 'long', type: 'semantic', importance: 0.7,
    summary: 'A 项目外墙保温：80mm 岩棉',
    content: 'A 项目（滨江花园）外墙保温用 80mm 岩棉，图号 建施-A11。',
    validFrom: '2026-05-20T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'proj_b_insulation',
    layer: 'long', type: 'semantic', importance: 0.7,
    summary: 'B 项目外墙保温：60mm 挤塑板',
    content: 'B 项目（西城里）外墙保温用 60mm 挤塑板 XPS，图号 建施-B11。',
    validFrom: '2026-05-21T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'proj_a_owner',
    layer: 'long', type: 'profile', importance: 0.65,
    summary: 'A 项目对接人：李工',
    content: 'A 项目（滨江花园）对接人是李工，出图节奏每两周一次。',
    validFrom: '2026-05-19T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'proj_b_owner',
    layer: 'long', type: 'profile', importance: 0.65,
    summary: 'B 项目对接人：王工',
    content: 'B 项目（西城里）对接人是王工，改图一般当天回。',
    validFrom: '2026-05-22T00:00:00.000Z', validUntil: null,
  },

  // ── 5. 偏好 / 承诺（当前事实类）────────────────────────────────
  {
    key: 'pref_font',
    layer: 'long', type: 'profile', importance: 0.8,
    summary: '封面字体：思源宋体，不用宋体',
    content: '所有方案封面用思源宋体 SemiBold，不要用系统宋体，字重不够。',
    validFrom: '2026-04-01T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'pref_color',
    layer: 'long', type: 'profile', importance: 0.75,
    summary: '主色：赭石 #a8632f',
    content: '对外方案主色统一用赭石 #a8632f，辅助色 #f3e6d8，不要用纯黑。',
    validFrom: '2026-04-02T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'commit_delivery',
    layer: 'long', type: 'commitment', importance: 0.9,
    summary: '承诺：9 月 15 日前交 A 项目二版',
    content: '答应 A 项目 9 月 15 日前交第二版施工图，含节点大样和材料表。',
    validFrom: '2026-08-20T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'task_open_review',
    layer: 'long', type: 'episode', importance: 0.7,
    summary: '未完成：画布插件待审 3 个死代码文件',
    content: '画布插件审查还差 3 个文件没看完：12-canvas-tab.js、06-utils.js、build-client.mjs。',
    validFrom: '2026-08-28T00:00:00.000Z', validUntil: null,
  },

  // ── 6. 中文短词 / 数字单位（短词类）────────────────────────────
  {
    key: 'short_tile',
    layer: 'long', type: 'semantic', importance: 0.6,
    summary: '瓷砖：800×800 抛光，62 元/片',
    content: '客厅地砖用 800×800 抛光砖，62 元/片，留缝 2mm。',
    validFrom: '2026-06-15T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'short_putty',
    layer: 'long', type: 'semantic', importance: 0.55,
    summary: '腻子：两遍，18 元/平米',
    content: '墙面腻子刮两遍，18 元/平米，基层处理另计。',
    validFrom: '2026-06-16T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'short_cable',
    layer: 'long', type: 'semantic', importance: 0.58,
    summary: '电缆：YJV-4×25，128 元/m',
    content: '主电缆用 YJV-4×25 铜芯，128 元/米，桥架另算。',
    validFrom: '2026-06-18T00:00:00.000Z', validUntil: null,
  },
  {
    key: 'short_beam',
    layer: 'long', type: 'semantic', importance: 0.6,
    summary: '梁截面：300×600，C30',
    content: '主梁截面 300×600，混凝土 C30，保护层 25mm。',
    validFrom: '2026-06-19T00:00:00.000Z', validUntil: null,
  },
]

/**
 * 干扰项：库里**没有**的东西，用于「证据不足 / 无答案」类。
 * 这些词只要在种子语料里不出现，就不该被召回。
 */
export const ABSENT_TOPICS = [
  '量子退相干',
  '烘焙温度',
  '马拉松配速',
  '咖啡因代谢',
  '滑雪板打蜡',
  '陶艺拉坯',
  '天文望远镜口径',
  '邮票水印',
]

/**
 * 注意：这些词在种子语料里**有同形但不该命中的邻居**，用来测「不许硬凑」。
 * 例如问「踢脚线报价」时，`quote_paint`（乳胶漆）是同域但不同物，不该被当成答案。
 */
export const DISTRACTOR_PAIRS = [
  { query: '踢脚线报价', expectKey: 'quote_skirting_alu', forbidKeys: ['quote_paint', 'quote_ceiling_gypsum'] },
  { query: '吊顶报价', expectKey: 'quote_ceiling_gypsum', forbidKeys: ['quote_paint'] },
  { query: '外墙保温岩棉', expectKey: 'spec_insulation_50', forbidKeys: ['proj_b_insulation'] },
]
