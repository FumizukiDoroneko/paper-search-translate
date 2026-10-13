# 实测记录：从"找一篇顶刊半导体材料论文"到双栏可编辑译文

这不是教程，而是一次真实跑通的完整记录：命令、真实输出、以及过程中发现并修掉的问题。按下面的命令可以复现。

## 0. 输入

- 研究方向：半导体材料学（advanced materials）
- 目标期刊：Nano Letters、ACS Nano
- 交付形态：先要中英逐段对照，随后追加"不修改排版的可编辑译文"

## 1. 圈定候选论文

```bash
node scripts/sciverse_search.mjs \
  --topic "semiconductor materials growth band structure carrier transport device applications" \
  --venue "Nano Letters" --year-from 2022 --limit 8 --pool 40
```

对 ACS Nano 跑同一条命令后，两刊合计得到 16 篇候选。真实输出节选（Nano Letters）：

```
2. Observation of Topological Flat Bands in the Kagome Semiconductor Nb3Cl8.
   Nano Letters · 2022 · 被引 132 · DOI 10.1021/acs.nanolett.2c00778
3. First-Principles Prediction of Carrier Mobility in Semiconductor Nanowires
   Nano Letters · 2025 · 被引 0 · DOI 10.1021/acs.nanolett.5c05429
...
提示：34 篇候选未获得语义命中（其中 23 篇无全文 doc_id），已按原顺序排在末尾；
这些条目的先后不代表相关度。
```

这一轮暴露了两件事，后来都写进了 SKILL.md：

- **先试按被引排序时，返回的是"该刊最高被引"，与主题无关**：实测出现 CO₂ 还原单原子催化剂、辐射制冷织物、光动力治疗、柔性传感器。相关性只能靠语义排序，被引数只用来看影响力。
- **"搜到"不等于"能翻译"**：ACS Nano 那 8 篇候选里有 5 篇没有全文（无 `doc_id`），拿不到原文。要交付译文就得加 `--fulltext-only`。

选中：Nb₃Cl₈ 的 kagome 拓扑平带（Nano Letters 2022，被引 132）——理论（紧束缚模型能带分析）与实验（ARPES + 光吸收）兼备，是篇扎实的 Letter。

## 2. 取回全文

```bash
node scripts/sciverse_content.mjs \
  --doc-id c2b02db0853189d42b6f0878eba96ddd21bbe6e5ae4f41d2acf6ceb3a2fb677a \
  --out source-nb3cl8.md
```

```
已写入 source-nb3cl8.md
doc_id=c2b02db0853189d42b6f0878eba96ddd21bbe6e5ae4f41d2acf6ceb3a2fb677a
窗口数=2 字符数=26796 是否到底=true
```

抽出来的 Markdown 混着期刊页眉页脚（`pubs.acs.org/NanoLett`、`Nano Lett. XXX, XXX, XXX-XXX`、`© XXXX American Chemical Society`）和按版位插入的图片占位符 `![](dt=...jpg)`，顺序经常与正文不对应，翻译前要先剔除。

## 3. 翻译

逐段对照，格式如下（摘要首句，示例引用）：

> **EN.** The destructive interference of wavefunctions in a kagome lattice can give rise to topological flat bands (TFBs) with a highly degenerate state of electrons.
>
> **中文.** kagome 晶格中波函数的相消干涉可以产生拓扑平带（topological flat bands, TFBs），其中电子态高度简并。

覆盖范围：标题与作者、摘要、关键词、引言、结果与讨论、总结、Methods、支持信息、作者信息、致谢，另附 60 余条术语表。

校对方式：把原件拆成 64 个段落块逐条比对（已剔除版面噪声），除一处孤立的作者单位片段无法对位外全部覆盖，无法对位的那处如实标注。

## 4. 原排版可编辑译文（DOCX）

- **原文**：ACS 版本在付费墙后（直接请求返回 403）。这篇是绿色 OA，免费版是 arXiv 2111.01583v2，本身即 7 页双栏 LaTeX 排版，作者单位表与参考文献表齐全，正好补上 `/content` 缺失的部分。
- **版面解析**：`pdfplumber` 量出页型 Letter（612×792 pt）、正文 x 范围 54–553（0.75 in 边距）、双栏以 x≈306 分界。
- **图片**：共 4 张，取 `page.images` 的 bbox，再用 `pdftoppm -r 300` 渲染整页并按 bbox 裁切。
- **参考文献**：PDF 抽取有 LaTeX 字距粘连（`P.;etal.Flatbandsand…`），改由 `scripts/build_references.py` 按 DOI 从 Crossref 重建 41 条。
- **生成**：`python-docx` 加连续分节写 `w:cols` 实现双栏；通栏图用单栏节包住图与图注；图与图注用 `keep_with_next` 加 `keep_together` 绑成整体。
- **校验**：`render_docx.py` 渲染出 7 页（与原稿页数一致），逐页看 PNG。

发现并修掉的缺陷——这套修法已固化在 `references/layout-docx.md`：

| 缺陷 | 修法 |
| --- | --- |
| 图 1 的图注被拆到下一页 | 图片段落 `keep_with_next` 加图注 `keep_together` |
| "支持信息"段被长 URL 撑出大间距 | 该段改左对齐 |
| "作者贡献"取错段落（拿到了"声明"） | 按内容子串匹配选取，不按索引 |
| "方法"标题被居中，与其他章节不一致 | 改左对齐加粗 |
| 第 2 页底部约两成空白 | 把晶体表征前两段提到通栏图块之前（分栏不可回填） |

参考文献重建脚本在实测中抓到两个 bug：Crossref 标题里的 MathML 标记会原样漏出；更隐蔽的是标签之间的空白把化学式拆成 `Fe 3 Sn 2`，在材料学文献里这是硬伤。改成先吃掉标签间空白再剥标签后，输出 `Fe3Sn2`、`Nb3Cl8`。

修正版重跑时用 `render_and_diff.py` 比对前后渲染，结果只有参考文献所在的两页变化：

```
[summary] changed_pages=[6, 7]
```

## 5. 这次实测反哺回 skill 的判断

1. 被引排序不能当相关性用：候选池（`--pool`）与展示条数（`--limit`）解耦，定序交给语义排序。
2. "搜到"不等于"能翻译"：用 `--fulltext-only` 只留有全文的候选。
3. 候选集合内无可用片段时 API 返回 `400 EMPTY_RESULT`：降级为结构化顺序，不当故障处理。
4. 用户要"原文"先判版权：绿色 OA 就交付预印本，出版商 403 不绕过。
5. `/content` 可能缺参考文献表与作者单位：用预印本补齐；对不上的片段如实标注，不猜也不静默丢弃。

## 6. 版权说明

本仓库不包含该论文的原文 PDF、完整译文或图件，论文与译文都受版权保护。上面只引用了摘要中的一句作为格式示例，并标注了 DOI。要复现就用本文的命令自己跑一遍，原文、译文与所有中间产物都留在本地。
