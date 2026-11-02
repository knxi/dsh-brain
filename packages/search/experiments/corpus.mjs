// @ts-check
/**
 * 检索能力实测用的合成语料（不碰任何生产数据）。
 *
 * 语料口味按用户的真实工作语境配：广告设计与建筑工程资料——尺寸、材质、图号、
 * 报价、英文工具名、代码标识符。每类查询都标了 gold（文档 id），gold 标注是否合理
 * 由 eval-recall.mjs 用 LIKE 基线自检（LIKE 命中不了说明标注写错了）。
 */

/**
 * @typedef {Object} Doc
 * @property {string} id
 * @property {string} content
 * @property {string} [sourceType]
 * @property {string} [sourceRef] 来源引用：用于"来源丢失 / 来源冲突"实验
 * @property {string} [sourceHash] 来源内容指纹：用于冲突判定
 */

/** @type {Doc[]} */
export const DOCS = [
  // ---------- 广告设计 ----------
  { id: 'm01', content: '客户要 A3 竖版海报，主色沿用上一稿的深墨绿，出血留 3mm。', sourceType: 'owner_words', sourceRef: 'evt-001', sourceHash: 'h01' },
  { id: 'm02', content: '门店灯箱用 3M 贴膜，喷绘精度 1440dpi，覆膜选哑光。', sourceType: 'owner_words', sourceRef: 'evt-002', sourceHash: 'h02' },
  { id: 'm03', content: '这个季度的 618 主 KV 换成暖橘色调，标题字用思源黑体 Heavy。', sourceType: 'observation', sourceRef: 'evt-003', sourceHash: 'h03' },
  { id: 'm04', content: '名片报价：250g 铜版纸双面印，500 张报价 180 元，覆哑膜加 40。', sourceType: 'owner_words', sourceRef: 'evt-004', sourceHash: 'h04' },
  { id: 'm05', content: '画册内页用 128g 哑粉纸，封面 250g 铜版纸加覆膜，骑马钉装。', sourceType: 'owner_words', sourceRef: 'evt-005', sourceHash: 'h05' },
  { id: 'm06', content: '甲方要求 logo 尺寸不小于 20mm，安全距离留一个字母 x 高度。', sourceType: 'owner_words', sourceRef: 'evt-006', sourceHash: 'h06' },
  { id: 'm07', content: '展架用 X 展架 80×180cm，底座加配重防止商场风大吹倒。', sourceType: 'observation', sourceRef: 'evt-007', sourceHash: 'h07' },
  { id: 'm08', content: '广告喷绘布选 550 灯箱布，户外防晒要加 UV 涂层。', sourceType: 'owner_words', sourceRef: 'evt-008', sourceHash: 'h08' },
  { id: 'm09', content: '这套 VI 的辅助图形改成参数化网格，网格间距 8pt。', sourceType: 'owner_words', sourceRef: 'evt-009', sourceHash: 'h09' },
  { id: 'm10', content: '客户嫌红色太艳，调成 CMYK 里的 M100 Y100 K10。', sourceType: 'owner_words', sourceRef: 'evt-010', sourceHash: 'h10' },
  { id: 'm11', content: '包装盒用 350g 白卡纸，裱 E 瓦楞，开模费另算。', sourceType: 'owner_words', sourceRef: 'evt-011', sourceHash: 'h11' },
  { id: 'm12', content: '视频封面尺寸 1080×1440，抖音竖版，安全区避开底部 250px。', sourceType: 'observation', sourceRef: 'evt-012', sourceHash: 'h12' },
  { id: 'm13', content: '上一版海报的字体版权没清，换成开源的思源宋体。', sourceType: 'owner_words', sourceRef: 'evt-013', sourceHash: 'h13' },
  { id: 'm14', content: '报价单里的印刷费按 P 数算，8P 以内可以不覆膜。', sourceType: 'owner_words', sourceRef: 'evt-014', sourceHash: 'h14' },
  { id: 'm15', content: '客户 logo 文件只有 JPEG，让我重绘矢量的。', sourceType: 'owner_words', sourceRef: 'evt-015', sourceHash: 'h15' },
  { id: 'm16', content: '铜版纸反光严重，室内展板建议换哑粉。', sourceType: 'owner_words', sourceRef: 'evt-016', sourceHash: 'h16' },
  { id: 'm17', content: '亚克力字厚度用 8mm，背发光用 12V 灯条。', sourceType: 'owner_words', sourceRef: 'evt-017', sourceHash: 'h17' },
  { id: 'm18', content: '淘宝详情页宽度 750px，首屏主图 800×800。', sourceType: 'owner_words', sourceRef: 'evt-018', sourceHash: 'h18' },
  { id: 'm19', content: '名片上的二维码最小 15×15mm，否则扫不出来。', sourceType: 'owner_words', sourceRef: 'evt-019', sourceHash: 'h19' },
  { id: 'm20', content: '户外高炮画面尺寸 6m×18m，喷绘分段拼接，接缝避开人脸。', sourceType: 'owner_words', sourceRef: 'evt-020', sourceHash: 'h20' },

  // ---------- 建筑工程资料 ----------
  { id: 'm21', content: '建施-03 图里首层平面标高是 0.000，层高 3.6m。', sourceType: 'owner_words', sourceRef: 'evt-021', sourceHash: 'h21' },
  { id: 'm22', content: '结施-12 说明梁截面 300×600，混凝土 C30。', sourceType: 'owner_words', sourceRef: 'evt-022', sourceHash: 'h22' },
  { id: 'm23', content: '这套施工图的图号规则是 建施/结施/水施/电施 加两位序号。', sourceType: 'owner_words', sourceRef: 'evt-023', sourceHash: 'h23' },
  { id: 'm24', content: '图纸 JS-2026-017 是消防疏散平面，需要审图盖章。', sourceType: 'owner_words', sourceRef: 'evt-024', sourceHash: 'h24' },
  { id: 'm25', content: '墙面做法：20mm 水泥砂浆找平，刮腻子两遍，乳胶漆一底两面。', sourceType: 'owner_words', sourceRef: 'evt-025', sourceHash: 'h25' },
  { id: 'm26', content: '场地围墙高度 2.4m，用 240 厚 MU10 烧结砖。', sourceType: 'owner_words', sourceRef: 'evt-026', sourceHash: 'h26' },
  { id: 'm27', content: '屋面防水用 SBS 卷材 4mm 厚，上翻 250mm。', sourceType: 'owner_words', sourceRef: 'evt-027', sourceHash: 'h27' },
  { id: 'm28', content: '门窗表里 C1 窗洞 1200mm×1500mm，窗台高 900mm。', sourceType: 'owner_words', sourceRef: 'evt-028', sourceHash: 'h28' },
  { id: 'm29', content: '门窗表编号用 门窗-01 到 门窗-24 排序。', sourceType: 'owner_words', sourceRef: 'evt-029', sourceHash: 'h29' },
  { id: 'm30', content: '钢筋保护层厚度：板 15mm，梁 25mm，柱 30mm。', sourceType: 'owner_words', sourceRef: 'evt-030', sourceHash: 'h30' },
  { id: 'm31', content: '混凝土浇筑前要做坍落度试验，控制在 160±30mm。', sourceType: 'owner_words', sourceRef: 'evt-031', sourceHash: 'h31' },
  { id: 'm32', content: '脚手架立杆间距 1.2m，步距 1.8m，连墙件两步三跨。', sourceType: 'owner_words', sourceRef: 'evt-032', sourceHash: 'h32' },
  { id: 'm33', content: '资料归档按分部工程分卷，地基与基础、主体结构、装饰装修。', sourceType: 'owner_words', sourceRef: 'evt-033', sourceHash: 'h33' },
  { id: 'm34', content: '隐蔽工程验收记录要有监理签字和影像资料。', sourceType: 'owner_words', sourceRef: 'evt-034', sourceHash: 'h34' },
  { id: 'm35', content: '这套预算的混凝土量按 2400×600 梁截面反算过一遍。', sourceType: 'owner_words', sourceRef: 'evt-035', sourceHash: 'h35' },
  { id: 'm36', content: '施工日志每天记天气、人数、机械台班和完成部位。', sourceType: 'owner_words', sourceRef: 'evt-036', sourceHash: 'h36' },
  { id: 'm37', content: '甲方要求所有变更走设计变更单，编号 变更-2026-XX。', sourceType: 'owner_words', sourceRef: 'evt-037', sourceHash: 'h37' },
  { id: 'm38', content: '图纸会审记录要汇总成 会审-01，附问题清单。', sourceType: 'owner_words', sourceRef: 'evt-038', sourceHash: 'h38' },
  { id: 'm39', content: '现场实测层高 3.55m，与图纸 3.6m 差 5cm，要报设计确认。', sourceType: 'owner_words', sourceRef: 'evt-039', sourceHash: 'h39' },
  { id: 'm40', content: '竣工验收前要出 竣工图，图号加 -JG 后缀。', sourceType: 'owner_words', sourceRef: 'evt-040', sourceHash: 'h40' },

  // ---------- 技术 / 工具 ----------
  { id: 'm41', content: '用 readSurface 读取画布像素前要先等重绘完成。', sourceType: 'owner_words', sourceRef: 'evt-041', sourceHash: 'h41' },
  { id: 'm42', content: 'deletion_epoch 每次删除都要加一，旧 worker 写回前必须比对。', sourceType: 'owner_words', sourceRef: 'evt-042', sourceHash: 'h42' },
  { id: 'm43', content: 'FTS5 的 trigram 分词器对三字以上中文才有效，两字要另想办法。', sourceType: 'owner_words', sourceRef: 'evt-043', sourceHash: 'h43' },
  { id: 'm44', content: '这个项目的构建脚本用 pnpm run build:web，别用 npm。', sourceType: 'owner_words', sourceRef: 'evt-044', sourceHash: 'h44' },
  { id: 'm45', content: '备份脚本在 E:\\ds-h\\tools\\backup\\backup-dsh.ps1。', sourceType: 'owner_words', sourceRef: 'evt-045', sourceHash: 'h45' },
  { id: 'm46', content: 'RRF 融合的常数一般取 60。', sourceType: 'owner_words', sourceRef: 'evt-046', sourceHash: 'h46' },
  { id: 'm47', content: '色卡编号 PANTONE 186C 是客户指定的品牌红。', sourceType: 'owner_words', sourceRef: 'evt-047', sourceHash: 'h47' },
  { id: 'm48', content: '这批物料尺寸统一按 1200mm×2400mm 的板材排版。', sourceType: 'owner_words', sourceRef: 'evt-048', sourceHash: 'h48' },
  { id: 'm49', content: '报价口径：设计费按张算，制作费按平方米算。', sourceType: 'owner_words', sourceRef: 'evt-049', sourceHash: 'h49' },
  { id: 'm50', content: '小狐狸习惯先把清单列出来再动手，容易漏的步骤单独标记。', sourceType: 'owner_words', sourceRef: 'evt-050', sourceHash: 'h50' },
  { id: 'm51', content: '大肥鱼是客户那边对接设计的，喜欢深色系。', sourceType: 'owner_words', sourceRef: 'evt-051', sourceHash: 'h51' },
  { id: 'm52', content: '主人说报价单要注明含税，别只写单价。', sourceType: 'owner_words', sourceRef: 'evt-052', sourceHash: 'h52' },
  { id: 'm53', content: '老张负责现场资料，验收记录找他签。', sourceType: 'owner_words', sourceRef: 'evt-053', sourceHash: 'h53' },
  // 中英无空格粘连（真实输入常态：改稿时手快，中文和英文/代码之间不加空格）
  { id: 'm54', content: '导出的图要检查dpi，别又被印刷厂打回。', sourceType: 'owner_words', sourceRef: 'evt-054', sourceHash: 'h54' },
  { id: 'm55', content: '调用deletion_epoch前先读runId，别写死。', sourceType: 'owner_words', sourceRef: 'evt-055', sourceHash: 'h55' },
];

/**
 * @typedef {Object} QueryCase
 * @property {string} id
 * @property {string} q
 * @property {'zh_sentence'|'zh_twochar'|'zh_single'|'zh_long'|'nickname'|'english_tool'|'size_unit'|'drawing_no'|'code_ident'} category
 * @property {string[]} gold
 * @property {string} [note]
 */

/** @type {QueryCase[]} */
export const QUERIES = [
  // 无空格中文短语（3-8 字）
  { id: 'q01', q: '喷绘精度', category: 'zh_sentence', gold: ['m02'] },
  { id: 'q02', q: '骑马钉装', category: 'zh_sentence', gold: ['m05'] },
  { id: 'q03', q: '安全距离', category: 'zh_sentence', gold: ['m06'] },
  { id: 'q04', q: '辅助图形', category: 'zh_sentence', gold: ['m09'] },
  { id: 'q05', q: '隐蔽工程', category: 'zh_sentence', gold: ['m34'] },
  { id: 'q06', q: '混凝土浇筑', category: 'zh_sentence', gold: ['m31'] },
  { id: 'q07', q: '脚手架立杆间距', category: 'zh_sentence', gold: ['m32'] },
  { id: 'q08', q: '设计变更单', category: 'zh_sentence', gold: ['m37'] },

  // 两字中文
  { id: 'q09', q: '铜版', category: 'zh_twochar', gold: ['m04', 'm05', 'm16'] },
  { id: 'q10', q: '报价', category: 'zh_twochar', gold: ['m04', 'm14', 'm49', 'm52'] },
  { id: 'q11', q: '图号', category: 'zh_twochar', gold: ['m23', 'm40'] },
  { id: 'q12', q: '门窗', category: 'zh_twochar', gold: ['m28', 'm29'] },
  { id: 'q13', q: '喷绘', category: 'zh_twochar', gold: ['m02', 'm20'] },
  { id: 'q14', q: '覆膜', category: 'zh_twochar', gold: ['m02', 'm05', 'm14'] },
  { id: 'q15', q: '层高', category: 'zh_twochar', gold: ['m21', 'm39'] },
  { id: 'q16', q: '防水', category: 'zh_twochar', gold: ['m27'] },

  // 单字中文
  { id: 'q17', q: '铜', category: 'zh_single', gold: ['m04', 'm05', 'm16'] },
  { id: 'q18', q: '梁', category: 'zh_single', gold: ['m22', 'm30', 'm35'] },
  { id: 'q19', q: '砖', category: 'zh_single', gold: ['m26'] },
  { id: 'q20', q: '膜', category: 'zh_single', gold: ['m02', 'm05', 'm14'] },
  { id: 'q21', q: '瓦', category: 'zh_single', gold: ['m11'] },

  // 昵称 / 称呼
  { id: 'q22', q: '小狐狸', category: 'nickname', gold: ['m50'] },
  { id: 'q23', q: '大肥鱼', category: 'nickname', gold: ['m51'] },
  { id: 'q24', q: '主人', category: 'nickname', gold: ['m52'] },
  { id: 'q25', q: '老张', category: 'nickname', gold: ['m53'] },

  // 英文工具名
  { id: 'q26', q: 'readSurface', category: 'english_tool', gold: ['m41'] },
  { id: 'q27', q: 'deletion_epoch', category: 'english_tool', gold: ['m42'] },  { id: 'q28', q: 'pnpm', category: 'english_tool', gold: ['m44'] },
  { id: 'q29', q: 'PANTONE', category: 'english_tool', gold: ['m47'] },
  { id: 'q30', q: 'FTS5', category: 'english_tool', gold: ['m43'] },
  { id: 'q31', q: 'RRF', category: 'english_tool', gold: ['m46'] },

  // 尺寸单位
  { id: 'q32', q: '1.2m', category: 'size_unit', gold: ['m32'] },
  { id: 'q33', q: '1200mm', category: 'size_unit', gold: ['m28', 'm48'] },
  { id: 'q34', q: '2400×600', category: 'size_unit', gold: ['m35'] },
  { id: 'q35', q: '1440dpi', category: 'size_unit', gold: ['m02'] },
  { id: 'q36', q: '3.6m', category: 'size_unit', gold: ['m21', 'm39'] },
  { id: 'q37', q: '250mm', category: 'size_unit', gold: ['m27'] },

  // 图号 / 编号
  { id: 'q38', q: '建施-03', category: 'drawing_no', gold: ['m21'] },
  { id: 'q39', q: 'JS-2026-017', category: 'drawing_no', gold: ['m24'] },
  { id: 'q40', q: '结施-12', category: 'drawing_no', gold: ['m22'] },
  { id: 'q41', q: '门窗-01', category: 'drawing_no', gold: ['m29'] },
  { id: 'q42', q: '变更-2026-XX', category: 'drawing_no', gold: ['m37'] },

  // 代码标识符
  { id: 'q43', q: 'build:web', category: 'code_ident', gold: ['m44'] },
  { id: 'q44', q: 'backup-dsh.ps1', category: 'code_ident', gold: ['m45'] },
  { id: 'q45', q: 'M100', category: 'code_ident', gold: ['m10'] },
  { id: 'q46', q: 'MU10', category: 'code_ident', gold: ['m26'] },
  { id: 'q47', q: 'dpi', category: 'english_tool', gold: ['m02', 'm54'], note: '中英无空格粘连：m54 里是「检查dpi」' },

  // 口语长查询（真实使用里最常见：带虚词、不带空格）
  { id: 'q48', q: '上次那个铜版纸名片的报价是多少', category: 'zh_long', gold: ['m04'] },
  { id: 'q49', q: '脚手架立杆间距到底留多少', category: 'zh_long', gold: ['m32'] },
  { id: 'q50', q: '屋面防水卷材用什么规格', category: 'zh_long', gold: ['m27'] },
  { id: 'q51', q: '门窗表里那个窗洞尺寸', category: 'zh_long', gold: ['m28'] },
  { id: 'q52', q: '名片二维码最小做多大', category: 'zh_long', gold: ['m19'] },
  { id: 'q53', q: '618主KV换成暖橘色调', category: 'zh_long', gold: ['m03'] },
  { id: 'q54', q: 'runId', category: 'code_ident', gold: ['m55'], note: '中英无空格粘连：m55 里是「调用deletion_epoch前先读runId」' },
];

/** 语料与查询集的类别清单（报告与脚本共用，防漏测）。 */
export const CATEGORIES = [
  'zh_sentence',
  'zh_twochar',
  'zh_single',
  'zh_long',
  'nickname',
  'english_tool',
  'size_unit',
  'drawing_no',
  'code_ident',
];

/** 自检：查询集覆盖所有类别、gold 都能在语料里找到、类别拼写合法。 */
export function validateCorpus() {
  const ids = new Set(DOCS.map((d) => d.id));
  const problems = [];
  const docById = new Map(DOCS.map((d) => [d.id, d]));
  for (const q of QUERIES) {
    if (!CATEGORIES.includes(q.category)) problems.push(`${q.id} 类别非法: ${q.category}`);
    if (!q.gold.length) problems.push(`${q.id} 无 gold`);
    for (const g of q.gold) {
      if (!ids.has(g)) problems.push(`${q.id} gold 不存在: ${g}`);
    }
    // gold 标注合理性：查询与至少一条 gold 原文必须共享一个 >=2 字（单字查询放宽到 1 字）的连续子串。
    // 长口语查询不要求整串出现，只要求共享核心词。
    const minLen = [...q.q].length <= 1 ? 1 : 2;
    const chars = [...q.q];
    const grads = new Set();
    for (let len = chars.length; len >= minLen; len -= 1) {
      for (let i = 0; i + len <= chars.length; i += 1) grads.add(chars.slice(i, i + len).join(''));
    }
    const matchedGold = q.gold.filter((g) => {
      const c = docById.get(g)?.content ?? '';
      return [...grads].some((sub) => c.includes(sub));
    });
    if (!matchedGold.length) problems.push(`${q.id} 没有任何 gold 与查询「${q.q}」共享子串，标注可能错了`);
  }
  for (const c of CATEGORIES) {
    if (!QUERIES.some((q) => q.category === c)) problems.push(`类别 ${c} 没有查询用例`);
  }
  return problems;
}
