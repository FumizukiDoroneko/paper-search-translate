# 原排版可编辑译文（DOCX）

用户要"不修改排版的可编辑译文"时按本文执行：产出一份结构与原稿对齐的 DOCX，正文是译文、全部为真文本。

## 1. 先拿到原稿 PDF

版权路径见 `SKILL.md` 第 2 步。绿色 OA 时免费版是预印本，这已经够用：预印本自带论文的 LaTeX 版式、完整的作者单位表，以及 `/content` 常常缺失的参考文献表。

## 2. 解析原稿版面

用 `pdfplumber`，不要靠肉眼估计：

```python
import pdfplumber
with pdfplumber.open(pdf) as doc:
    pg = doc.pages[2]
    print(len(doc.pages), pg.width, pg.height)      # 页数、纸型
    words = pg.extract_words()
    print(min(w["x0"] for w in words), max(w["x1"] for w in words))  # 页边距
    print([[round(i["x0"]), round(i["x1"]), round(i["top"]), round(i["bottom"])]
           for i in pg.images])                     # 图的位置与尺寸
```

双栏正文的读取顺序要按栏切开再抽，否则左右栏会逐行交织成乱文：

```python
left  = pg.crop((0,   0, W/2, H)).extract_text()
right = pg.crop((W/2, 0, W,   H)).extract_text()
```

通栏的图注（`figure*`）横跨两栏，按整页展平同样会碎掉。正确做法是按坐标带裁切图注区域——从图 bbox 的 `bottom` 往下取一小段，例如 `pg.crop((0, 278, W, 396)).extract_text()`。

## 3. 抽图

按图 bbox 在 300 dpi 下裁切，比只导出嵌入位图更可靠（矢量与位图都能保住，分辨率也统一）：

```bash
pdftoppm -r 300 -png -f 3 -l 5 paper.pdf work/pm/pg      # bundled poppler
```

```python
S = 300 / 72.0                        # PDF 点 -> 300dpi 像素
img.crop((int(x0*S), int(top*S), int(x1*S), int(bottom*S))).save("fig1.png")
```

## 4. 重建参考文献

PDF 抽出的文献表有 LaTeX 字距造成的粘连（`P.;etal.Flatbandsand…`），不要直接放进交付件。用 `scripts/build_references.py --doi <DOI> --out references.txt`：它从 Crossref 取该文的 `reference` 数组（只有 DOI），再逐个取元数据并格式化成干净条目。文献保持英文不译。

## 5. 生成 DOCX

关键点（`python-docx`）：

- 页面：Letter（8.5×11 in），四边 0.75 in 边距，与原稿一致。
- 双栏：写 `sectPr/w:cols`，`w:num="2"`、`w:space="600"`（≈0.42 in，对应原稿栏间距）；切换栏数用**连续分节** `doc.add_section(WD_SECTION.CONTINUOUS)`。
- 通栏图：插入一个单栏连续节，放图 + 图注，再切回双栏节。这是 LaTeX `figure*` 在 Word 里的等价写法。
- 图与图注要绑成整体：图片段落 `keep_with_next=True`，图注段落 `keep_together=True`。否则图注会被拆到下一页（实测发生过）。
- 字体：中文 宋体、西文 Times New Roman，`w:rFonts` 的 `ascii`/`hAnsi`/`eastAsia` 三个都要设；正文 10pt、行距约 1.18、首行缩进 20pt（≈2 字符）。
- 章节标题左对齐加粗，不要居中——原稿如此。
- 内容取材按**内容匹配**而不是按解析顺序取索引：从译文 markdown 里按位置取段落取错过（把"声明"当成了"作者贡献"）。

### 分页陷阱（最容易踩）

通栏图块整体推页后，它**前面那一节无法回填**，页面底部会留下大片空白——Word 不会把上一节的文字拉过来填满。

实测有效的处理：把紧随图块之后的 1–2 段正文提到图块之前，让前一节填满页面。这一步把第 2 页底部空白从约三成压到约两成，同时图正好落到下一页页首，与原稿页码位置一致。

不要为了消空白去改图的尺寸或位置——那比留白更偏离原稿。

## 6. 校验

走 `documents` skill 的渲染校验：`render_docx.py <docx> --output_dir <dir>`（可选 `--emit_pdf`），然后**逐页**看 PNG。

页数与原稿一致是有效的忠实度信号（实测 7 页对 7 页）。逐页检查这些高发缺陷：

| 缺陷 | 修法 |
|---|---|
| 图注被拆到下一页 | 图段落 `keep_with_next`，图注 `keep_together` |
| 含长 URL 的段落两端对齐，首行被撑成大间距 | 该段改左对齐 |
| 作者贡献/声明等取错段落 | 按内容子串匹配选取，不按索引 |
| 标题居中、与其余章节不一致 | 改为左对齐加粗 |
| 正文结束处大片留白 | 把后文段落提到通栏图块之前 |

环境依赖：Windows 上 `render_docx.py` 要求 PATH 里有 `soffice.exe`（本机用 `winget install --id TheDocumentFoundation.LibreOffice -e` 装的），并需要 bundled poppler 的 bin 目录在 PATH 上供 `pdf2image` 使用。

## 7. 交付说明要写清的偏差

排版镜像做不到 LaTeX 级精确，交付时如实说明，不要声称"完全一致"：

- 图的浮动位置是**结构等价**而非像素一致：Word 是流式排版，没有 LaTeX 的浮动算法，只能让每张图落在最接近其首次引用的位置。
- 若存在页面底部留白，说明成因（分栏不可回填）与为压缩它所做的处理。
- 说明译文正文的取材版本（正式版全文）与原稿 PDF 版本（预印本）的关系。

若用户要求逐像素不变，改做另一条路：以原 PDF 每页为底图、把译文按原文文字块位置覆盖上去，生成带可选中文本层的译文 PDF。它版式完全一致，但文字只能在 PDF 编辑器里改，不如 DOCX 便于编辑。
