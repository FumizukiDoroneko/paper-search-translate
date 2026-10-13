---
name: paper-search-translate
description: 按研究方向与期刊定位论文、取回全文并交付译文。当用户给出研究方向/主题加期刊名（或说“找一篇顶刊的 XX 论文并翻译”）时使用；交付形态含中英逐段对照，以及“不修改排版的可编辑译文”。用户已提供 PDF 只要翻译、或只要检索不要译文时，用单一环节即可，不必启用本 skill 的完整流程。
---

# 论文检索与翻译

给定研究方向与目标期刊，产出可回溯的候选论文清单，并交付译文。

## 前置依赖（运行前先确认）

检索与解析能力依赖两个外部 API，缺任一项对应环节就跑不动：

| 依赖 | 用途 | 必需性 | 获取方式 | 免费额度 |
| --- | --- | --- | --- | --- |
| `SCIVERSE_API_TOKEN` | 全部检索与全文读取（`/meta-search`、`/agentic-search`、`/content`） | **必需** | 在 https://sciverse.opendatalab.com/tokens 创建，前缀 `sci_` | 基础试用额度；默认限频 30 次/分钟 |
| MinerU API Key | 仅第 3 步的 PDF→Markdown 解析（走 `read-paper` skill 的云端接口） | 走 Sciverse 全文时不需要 | 在 https://mineru.net/apiManage 创建，写入 `~/.codex/skills/read-paper/config.json` 的 `apiKey` | 每账号每天 1000 页最高优先级解析 |
| Crossref API | 第 5 步重建参考文献表（`scripts/build_references.py`） | 可选 | 公开接口，无需 key，脚本自动带 `mailto` 进入 polite pool | 无限制 |

`SCIVERSE_API_TOKEN` 的解析顺序：环境变量 → `~/.codex/config.toml` 的 `[mcp_servers.sciverse.env]`。**不要把 token 写进脚本或提交进仓库**，用环境变量或本地配置注入。

运行环境：Node 18+（两个 `.mjs` 脚本）、Python 3.9+（`build_references.py` 与自建 DOCX 脚本）、`pdfplumber` + `Pillow`（解析原稿版面与裁图）；DOCX 的页面级校验另需 LibreOffice 与 poppler。token 缺失时脚本直接报错退出——不要靠猜字段或改脚本绕过鉴权。

## 开工前需要的信息

- 研究方向或具体问题（必填）
- 目标期刊，或期刊集合（如 `Nature Electronics`、`Nature 系`、`Advanced Materials`）（必填）
- 可选约束：年份下限、是否只看开放获取、影响力要求（同年份被引前 1% / 前 10%）

译文形态默认**中英对照**（术语核对方便）；用户明确要纯中文全文、或要“不改排版的可编辑译文”就照做，不要反复确认。只问缺失且会改变结果的信息，其余用合理默认推进。

## 流程

### 1. 圈定候选论文

优先用 `scripts/sciverse_search.mjs`。它实现了两步配方：先用 `meta-search` 按期刊/年份/影响力圈定候选（结构化、自带 DOI 与 OA 链接），再用 `agentic-search` 在候选 `doc_id` 集合内做语义排序——后者是硬约束，命中不会越出所选期刊范围。

```bash
node <this-skill>/scripts/sciverse_search.mjs \
  --topic "GaN power device thermal management" \
  --venue "Nature Electronics" \
  --year-from 2022 --impact top10 --limit 10
```

第二步语义排序默认开启（`--no-semantic` 可关闭），`--json` 输出机器可读结果。排序只覆盖有全文 `doc_id` 的候选，无全文的会排在末尾并给出提示。

候选池和展示条数是两件事：`--limit` 是最终给几篇，`--pool` 是语义排序在多大的池子里挑（默认 5 倍 limit，上限 100）。池子只比 limit 大一点时语义排序没有素材可挑，结果会退化成结构化检索的原始顺序。

三条实测出来的判断：

- **按被引排序不能单独用来找相关论文。** `--sort-by citation_count` 给的是"该刊最高被引"，与主题无关——实测在 Nano Letters / ACS Nano 上返回过 CO₂ 还原催化剂、辐射制冷织物、光动力治疗、柔性传感器。相关性只能靠语义排序，被引数只用于判断影响力。`--sort-by` 的字段会按 `/meta-catalog` 的 `sortable` 标记校验。
- **"搜到"不等于"能翻译"。** 大量候选没有全文（无 `doc_id`），拿不到原文。要交付译文时加 `--fulltext-only`，否则会在翻译阶段才发现没材料。
- 语义排序返回 `400 EMPTY_RESULT` 是正常结果（候选集合内没有可用片段），不是故障：退回结构化顺序并提示即可，不要当报错终止（脚本已内置这个退化）。

若当前会话已加载 Sciverse MCP 工具（`search_papers` / `semantic_search` / `list_catalog` / `read_content` / `get_resource` / `list_paper_relations`），优先用工具；脚本是 MCP 不可用时的等价路径。

拿到候选后列 3–5 篇给用户选（标题、期刊、年份、被引、DOI）。用户说"你定"就自行选定，并说明选择理由。

候选明显偏离主题时（例如窄主题叠加 `--impact` 后冒出一堆无关的量子器件论文），说明该期刊在这个主题加这个约束下本来就没有合适的文章。这时换期刊、放宽年份或影响力条件，或者如实告诉用户"没找到"，不要靠语义排序硬凑出一篇。

字段名一律运行期从 `/meta-catalog` 取，不要硬编码——脚本已内置这一步校验。接口形状、filters 结构、错误码见 [references/sciverse-api.md](references/sciverse-api.md)。

### 2. 取回全文

按以下优先级尝试，失败就下移并如实说明拿到了什么：

1. Sciverse `read_content`：按 `doc_id` 用 `offset`/`limit` 分段续读，返回的本身就是 Markdown（标题、作者、日期、正文都在），可直接用于翻译，无需下载 PDF。图注里的图片是相对路径，用 `get_resource` 取二进制。

   取全文用 `scripts/sciverse_content.mjs --doc-id <sha256> --out <file.md>`，它按 20000 字符窗口分页、自动续读到 `more=false`，省去手写分页（默认限频 30 次/分钟，窗口越小越容易撞限）。

   注意：抽出的 Markdown 夹杂期刊页眉页脚（`pubs.acs.org/...`、`Nano Lett. XXX, XXX, XXX-XXX`、`© XXXX American Chemical Society`、`Received:`/`Revised:` 之类）和按版位插入的图片占位符 `![](dt=...jpg)`，顺序常常与正文不对应。翻译前先剔除这些噪声、把图片占位符按图号归位；图注正文本身通常保留在文中。
2. 元数据里的 `access_oa_url` 直接下 PDF。
3. `agent-browser` 打开出版商或 OA 页面下载（本机已配 `--no-sandbox`；启动失败时先 `agent-browser close --all` 清掉残留会话）。

付费墙下只拿到摘要和片段时，明确告诉用户这是摘要范围的内容，不要用摘要冒充全文。

用户要"原文"时先判版权状态，不要尝试绕过付费墙：`meta-search` 的 `access_oa_status` 为 `green` 表示免费版本是预印本（`access_oa_url` 通常指向 arXiv），出版商 PDF 直接请求会 403。这时交付预印本，并说明它是作者稿、本身也是论文的 LaTeX 双栏排版、内容与正式版一致。

`/content` 抽出的全文可能是残缺的：实测出现过参考文献只剩章节标题、条目列表整体缺失，以及孤立的作者单位片段（所属作者名没抽到、无法对位）。用预印本 PDF 补齐这些缺口；对不上的片段如实标注，不要猜归属、也不要静默丢弃。

### 3. PDF 转结构化文本

用 `read-paper` skill（MinerU 云端解析，双栏、公式、表格表现最好）。额度 1000 页/天，单文件 ≤200MB 且 ≤200 页。

本地 `pdfplumber` 只在 MinerU 不可用时兜底：双栏会串行、公式会糊，译文质量明显下降，用了要说明。

### 4. 翻译

逐段对照：**每段原文后紧跟该段译文**，段落严格一一对应，便于核对。覆盖摘要、正文、图注、方法；参考文献条目保留原文不译。

保持不变的内容：公式、变量、单位、数字、图表编号（`Fig. 1` / `Table 2`）、引用标记（`[12]`）、DOI、化学式与材料命名（如 `AlGaN/GaN`、`SiC`）。

术语处理：首次出现给中英对照（如 热边界电阻 thermal boundary resistance (TBR)），之后统一用中文或保留缩写，全文一致；遵循半导体材料领域惯例（bandgap 带隙、doping 掺杂、heterostructure 异质结、epitaxy 外延）。

忠实优先于流畅：不补全原文没有的结论，不把 `may` / `suggest` 这类不确定性写成确定语气。

### 5. 交付

默认产出 Markdown（中英逐段对照），文件写入当前会话的 outputs 目录。两种升级形态按用户要求选：

- **原排版可编辑译文**：用户要"不改排版的可编辑译文"时，产出一份 DOCX，结构与原稿对齐（纸型、页边距、单栏标题/摘要块 + 双栏正文、图表位置、章节与参考文献顺序）。整条工程链路——双栏分节、通栏图、分页陷阱、参考文献重建、渲染校验——见 [references/layout-docx.md](references/layout-docx.md)；参考文献重建用 `scripts/build_references.py`。
- **纯中文全译**：去掉原文层，篇幅约减半。

交付时附来源留痕：期刊、年份、DOI、`doc_id`、原文版本（正式版还是预印本），以及解析消耗的页数/额度。DOCX 交付前必须走 `documents` skill 的渲染校验，逐页看一眼 PNG 再交。

## 本机实测的坑

- Sciverse token 实际是 `sci_` 前缀，官方文档写的是 `sv-`。不要因前缀不符就判定 token 无效，先打一次 `/meta-catalog`。
- Sciverse 不生成答案、不写综述、不翻译，只提供证据。译文必须由模型产出，且引用必须带 `doc_id` 或 DOI。
- 默认限频 30 次/分钟；429 最多指数退避重试 3 次。
- `meta-search` 深翻页超过 `page * page_size = 10000` 时改用 `cursor`；`agentic-search` 的 `doc_id` 集合上限 1000，超限报 400 `SCOPE_TOO_LARGE`。
- 本机 GitHub 不通（raw 拉取超时），arXiv、Crossref、`api.sciverse.space` 都可达。Sciverse 资料以 `sciverse.space` 文档站和其 `llms.txt` 为准。
- `documents` skill 的页面级校验在 Windows 上要求 PATH 里有 `soffice.exe`。本机原先没有，用 `winget install --id TheDocumentFoundation.LibreOffice -e` 装上即可；渲染还依赖 bundled poppler 的 bin 目录在 PATH 上（`pdf2image` 需要）。
- `skill-creator` 的 `quick_validate.py` 在本机要跑在系统 Python 上（内置运行时缺 PyYAML），并且必须带 `PYTHONUTF8=1`，否则中文内容会撞 GBK 解码报错。
