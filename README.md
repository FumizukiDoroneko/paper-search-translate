# paper-search-translate

一个 Codex Skill。给定**研究方向 + 目标期刊**，自动定位候选论文、取回全文、产出译文（中英逐段对照，或"不修改排版的可编辑译文"）。

English: a Codex skill that finds papers by research topic + venue, retrieves the full text, and delivers a Chinese translation (bilingual, or layout-preserving editable DOCX). Backed by Sciverse (retrieval), MinerU (PDF parsing fallback) and Crossref (reference rebuild).

## 前置依赖：两个 API 必须自己申请

**本仓库不自带任何 API 凭证，也不做代理中转。** 检索与解析依赖下面两个外部服务，缺哪一项，对应环节就直接失败：

| 依赖 | 用途 | 必需性 | 怎么获取 | 免费额度 |
| --- | --- | --- | --- | --- |
| `SCIVERSE_API_TOKEN` | 全部检索与全文读取：`/meta-search`、`/agentic-search`、`/content` | **必需** | 在 https://sciverse.opendatalab.com/tokens 创建，前缀 `sci_`；创建后**只显示一次**，当场复制 | 基础试用额度；默认限频 30 次/分钟 |
| MinerU API Key | 仅 PDF→Markdown 解析那一步（走 `read-paper` skill 的云端接口） | 走 Sciverse 全文时**不需要** | 在 https://mineru.net/apiManage 创建，写入 `~/.codex/skills/read-paper/config.json` 的 `apiKey` 字段 | 每账号每天 1000 页最高优先级解析 |
| Crossref API | 重建参考文献表 | 可选 | 公开接口，无需 key；脚本自动带 `mailto` 进入 polite pool | 无限制 |

配置 `SCIVERSE_API_TOKEN` 的两种方式（脚本按此顺序解析）：

```bash
# 1) 环境变量（推荐）
export SCIVERSE_API_TOKEN=sci_xxxxxxxx          # Windows PowerShell: $env:SCIVERSE_API_TOKEN="sci_xxxxxxxx"
```

```toml
# 2) 或写进 Codex 本地配置 ~/.codex/config.toml，脚本会自动读取
[mcp_servers.sciverse.env]
SCIVERSE_API_TOKEN = "sci_xxxxxxxx"
```

> **安全提醒**：不要把 token 提交进任何仓库。本仓库不含凭证，`.gitignore` 也已排除生成物与缓存。token 缺失时脚本会直接报错退出——这是刻意的，不要靠改脚本绕过鉴权。

## 安装

```bash
git clone https://github.com/<你的账号>/paper-search-translate.git ~/.codex/skills/paper-search-translate
```

Windows 下的目标路径是 `C:\Users\<你>\.codex\skills\paper-search-translate`。装好后在 Codex 里用自然语言触发即可（例如"找一篇半导体材料方向、Nano Letters 的论文并翻译"），也可以显式写 `$paper-search-translate`。

## 其他运行环境

- Node 18+：两个 `.mjs` 脚本只用内置 `fetch`，无 npm 依赖
- Python 3.9+：`scripts/build_references.py` 只用标准库
- Python 包：`pdfplumber`、`Pillow`（解析原稿版面、裁图）
- 可选：LibreOffice + poppler——只在交付"原排版 DOCX"时需要，用于页面级渲染校验
- 可选：Sciverse MCP server（见下），装了以后 agent 优先用原生工具

## 可选：接入 Sciverse MCP server

```bash
npm install -g sciverse-mcp-server
codex mcp add sciverse --env SCIVERSE_API_TOKEN=sci_xxxxxxxx -- sciverse-mcp
```

之后 `search_papers`、`semantic_search`、`list_catalog`、`read_content`、`get_resource`、`list_paper_relations` 会作为原生工具出现，SKILL.md 里已写明优先使用工具、脚本作为等价路径。

## 仓库结构

```
paper-search-translate/
├── SKILL.md                      # skill 入口：前置依赖、五步流程、实测坑
├── README.md                     # 本文件
├── agents/openai.yaml            # Codex UI 元数据
├── references/
│   ├── sciverse-api.md           # Sciverse 端点、filters 结构、错误码、检索配方
│   └── layout-docx.md            # "原排版可编辑译文"的完整工程链路
└── scripts/
    ├── sciverse_search.mjs       # 两步检索：结构化圈定 -> 候选集合内语义排序
    ├── sciverse_content.mjs      # 按 doc_id 分页取全文 Markdown
    └── build_references.py       # 按 DOI 从 Crossref 重建干净的参考文献表
```

## 脚本用法

```bash
# 1) 圈定候选论文（--pool 控制语义排序的候选池，--fulltext-only 只要拿得到全文的）
node scripts/sciverse_search.mjs --topic "semiconductor materials carrier transport" \
  --venue "Nano Letters" --year-from 2022 --pool 40 --fulltext-only --limit 8

# 2) 取全文（20000 字符窗口自动续读到结尾）
node scripts/sciverse_content.mjs --doc-id <sha256> --out paper.md

# 3) 重建参考文献表
python scripts/build_references.py --doi 10.1021/acs.nanolett.2c00778 --out references.txt
```

## 已知限制

- Sciverse 默认限频 30 次/分钟，429 时脚本指数退避最多重试 3 次；`agentic-search` 的 `doc_id` 集合上限 1000；`meta-search` 深翻页超过 `page * page_size = 10000` 需改用 `cursor`。
- 付费墙论文拿不到出版商 PDF（通常返回 403）。绿色 OA 时免费版是预印本，skill 会交付预印本并说明来源，不会尝试绕过付费墙。
- "原排版可编辑译文"在 Word 里是**结构等价**而非像素一致：图片浮动位置只能落在最接近其首次引用的位置；通栏图推页后页面底部可能留白（成因与处理见 `references/layout-docx.md`）。
- 译文由模型产出。Sciverse 本身不翻译、不生成答案、不写综述，只提供证据。
