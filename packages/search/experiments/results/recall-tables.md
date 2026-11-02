## 召回对比（合成语料，55 条文档 / 54 个查询 / 9 类）

| 引擎 | hit@10 | recall@10 | P@10 | MRR | 平均返回条数 |
|---|---:|---:|---:|---:|---:|
| fts_unicode61_raw | 50.0% | 46.9% | 50.0% | 0.500 | 0.5 |
| fts_char_phrase | 90.7% | 90.7% | 88.7% | 0.889 | 1.3 |
| fts_char_and | 90.7% | 90.7% | 88.3% | 0.889 | 1.4 |
| fts_char_or | 100.0% | 100.0% | 46.9% | 0.981 | 4.9 |
| fts_char_adaptive | 100.0% | 100.0% | 83.6% | 0.981 | 2.7 |
| fts_trigram | 61.1% | 61.1% | 60.2% | 0.602 | 0.7 |
| ngram | 100.0% | 100.0% | 49.9% | 1.000 | 4.6 |
| like | 88.9% | 88.9% | 86.9% | 0.889 | 1.3 |
| fused | 100.0% | 100.0% | 83.6% | 0.981 | 2.7 |

## 按查询类别的 hit@10

| 类别 | 查询数 | fts_unicode61_raw | fts_char_phrase | fts_char_and | fts_char_or | fts_char_adaptive | fts_trigram | ngram | like | fused |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| zh_sentence | 8 | 37.5% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| zh_twochar | 8 | 25.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 100.0% | 100.0% | 100.0% |
| zh_single | 5 | 20.0% | 100.0% | 100.0% | 100.0% | 100.0% | 0.0% | 100.0% | 100.0% | 100.0% |
| zh_long | 6 | 0.0% | 16.7% | 16.7% | 100.0% | 100.0% | 0.0% | 100.0% | 0.0% | 100.0% |
| nickname | 4 | 0.0% | 100.0% | 100.0% | 100.0% | 100.0% | 50.0% | 100.0% | 100.0% | 100.0% |
| english_tool | 7 | 85.7% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| size_unit | 6 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| drawing_no | 5 | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |
| code_ident | 5 | 80.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% | 100.0% |

## 融合权重扫描（同一套语料，只改 RRF 权重）

| 权重方案 | char | trigram | ngram | hit@10 | recall@10 | P@10 | MRR |
|---|---:|---:|---:|---:|---:|---:|---:|
| char_only | 1 | 0 | 0 | 100.0% | 100.0% | 83.6% | 0.981 |
| char+trigram | 1 | 0.6 | 0 | 100.0% | 100.0% | 83.6% | 0.981 |
| char+trigram+ngram0.2 | 1 | 0.6 | 0.2 | 100.0% | 100.0% | 49.9% | 0.981 |
| char+trigram+ngram0.4 | 1 | 0.6 | 0.4 | 100.0% | 100.0% | 49.9% | 0.981 |
| char+trigram+ngram0.6 | 1 | 0.6 | 0.6 | 100.0% | 100.0% | 49.9% | 0.981 |
| char+trigram+ngram1.0 | 1 | 0.6 | 1 | 100.0% | 100.0% | 49.9% | 0.991 |

## 漏检明细（hit@10 = 0 的查询）

- **fts_unicode61_raw**（27）: q03(zh_sentence)「安全距离」、q04(zh_sentence)「辅助图形」、q05(zh_sentence)「隐蔽工程」、q06(zh_sentence)「混凝土浇筑」、q08(zh_sentence)「设计变更单」、q09(zh_twochar)「铜版」、q10(zh_twochar)「报价」、q11(zh_twochar)「图号」、q13(zh_twochar)「喷绘」、q14(zh_twochar)「覆膜」、q16(zh_twochar)「防水」、q17(zh_single)「铜」、q19(zh_single)「砖」、q20(zh_single)「膜」、q21(zh_single)「瓦」、q22(nickname)「小狐狸」、q23(nickname)「大肥鱼」、q24(nickname)「主人」、q25(nickname)「老张」、q47(english_tool)「dpi」、q48(zh_long)「上次那个铜版纸名片的报价是多少」、q49(zh_long)「脚手架立杆间距到底留多少」、q50(zh_long)「屋面防水卷材用什么规格」、q51(zh_long)「门窗表里那个窗洞尺寸」、q52(zh_long)「名片二维码最小做多大」、q53(zh_long)「618主KV换成暖橘色调」、q54(code_ident)「runId」
- **fts_char_phrase**（5）: q48(zh_long)「上次那个铜版纸名片的报价是多少」、q49(zh_long)「脚手架立杆间距到底留多少」、q50(zh_long)「屋面防水卷材用什么规格」、q51(zh_long)「门窗表里那个窗洞尺寸」、q52(zh_long)「名片二维码最小做多大」
- **fts_char_and**（5）: q48(zh_long)「上次那个铜版纸名片的报价是多少」、q49(zh_long)「脚手架立杆间距到底留多少」、q50(zh_long)「屋面防水卷材用什么规格」、q51(zh_long)「门窗表里那个窗洞尺寸」、q52(zh_long)「名片二维码最小做多大」
- **fts_char_or**（0）: 无
- **fts_char_adaptive**（0）: 无
- **fts_trigram**（21）: q09(zh_twochar)「铜版」、q10(zh_twochar)「报价」、q11(zh_twochar)「图号」、q12(zh_twochar)「门窗」、q13(zh_twochar)「喷绘」、q14(zh_twochar)「覆膜」、q15(zh_twochar)「层高」、q16(zh_twochar)「防水」、q17(zh_single)「铜」、q18(zh_single)「梁」、q19(zh_single)「砖」、q20(zh_single)「膜」、q21(zh_single)「瓦」、q24(nickname)「主人」、q25(nickname)「老张」、q48(zh_long)「上次那个铜版纸名片的报价是多少」、q49(zh_long)「脚手架立杆间距到底留多少」、q50(zh_long)「屋面防水卷材用什么规格」、q51(zh_long)「门窗表里那个窗洞尺寸」、q52(zh_long)「名片二维码最小做多大」、q53(zh_long)「618主KV换成暖橘色调」
- **ngram**（0）: 无
- **like**（6）: q48(zh_long)「上次那个铜版纸名片的报价是多少」、q49(zh_long)「脚手架立杆间距到底留多少」、q50(zh_long)「屋面防水卷材用什么规格」、q51(zh_long)「门窗表里那个窗洞尺寸」、q52(zh_long)「名片二维码最小做多大」、q53(zh_long)「618主KV换成暖橘色调」
- **fused**（0）: 无

## 四种「检索不足」状态验证（独立小库，构造明确）

| 期望状态 | 实际状态 | 查询 | 判定理由 |
|---|---|---|---|
| no_relevant | ✅ no_relevant | `量子纠缠退相干` | 三路索引与 LIKE 兜底都没有候选 |
| insufficient_evidence | ✅ insufficient_evidence | `铜版报价脚手架量子纠缠` | 最佳候选覆盖度 0.23 < 阈值 0.34，不当作确定答案 |
| source_missing | ✅ source_missing | `铜版` | 候选来源丢失：s1: 无 source_refs 记录 |
| source_conflict | ✅ source_conflict | `报价` | 候选来源互相冲突：s2: 同一记忆有 2 个不同来源内容指纹 |
| ok | ✅ ok | `哑粉` | ok |
