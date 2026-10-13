# Sciverse 接口要点

基线地址 `https://api.sciverse.space`，统一 `Authorization: Bearer <token>`，Token 与点石 DianShi 共用。
Token 解析顺序：`SCIVERSE_API_TOKEN` 环境变量 → `~/.codex/config.toml` 里 `[mcp_servers.sciverse.env]` 的 `SCIVERSE_API_TOKEN`。

公开文档站：`https://sciverse.space/docs`（`llms.txt` 面向模型，接口无 hash 页如 `/docs/sciverse/api/meta-search`）。

## 端点

| 端点 | 方法 | 用途 | 关键参数 |
|---|---|---|---|
| `/meta-search` | POST | 结构化元数据检索，不返回正文 | `collection`(papers/authors/sources)、`query`、`filters[]`、`sort[]`、`fields[]`、`page`、`page_size`、`cursor` |
| `/agentic-search` | POST | 自然语言语义检索，返回可引用片段 | `query`(≤4096)、`top_k`(1–100)、`sub_queries`(0–4)、`filters{}` |
| `/meta-catalog` | GET | 字段/算子/枚举自描述 | `include_sample_values`、`collection` |
| `/meta-paper-relations` | POST | 引用/被引/相关工作分页 | `unique_id`、`relation`(CITATIONS/REFERENCES/RELATED_WORKS)、`page`、`page_size` |
| `/content` | GET | 按 `doc_id` 读原文切片 | `doc_id`、`offset`、`limit`（默认 700，仅传 `offset` 时生效） |
| `/resource` | GET | 拉图表/附件二进制 | `file_name`（相对路径，不得含 `\`、`..`，不得以 `/` 开头） |

## meta-search 请求体

`FilterItem = { field, operator?, value }`，operator 默认 `EQ`，可选
`FILTER_OP_EQ / NE / GT / GTE / LT / LTE / IN / NIN / CONTAINS / MATCH / MATCH_PHRASE`。
`SortItem = { field, order }`，order 默认 `SORT_ORDER_DESC`。可排序字段：`publication_published_year`、`publication_published_date`、`reference_count`、`citation_count`、`influential_citation_count`、`fwci`。

`query` 与 `sort` 可以共用：传 `sort` 时按字段硬排，`query` 退化为命中过滤。深翻页超过 `page * page_size = 10000` 用 `cursor`。

常用字段（务必以 `/meta-catalog` 运行期结果为准）：
`title`、`abstract`、`doi`、`doc_id`、`unique_id`、`language`、`author`、`type`、`keywords`、
`publication_published_year`、`publication_published_date`、`publication_venue_name_unified`、`publication_venue_type`、`publication_venue_issn`、`publication_publisher`、
`citation_count`、`influential_citation_count`、`fwci`、`reference_count`、
`citation_normalized_percentile` 及其子字段 `is_in_top_1_percent` / `is_in_top_10_percent`、
`access_is_oa`、`access_oa_status`、`access_oa_url`、`topics.domain.id` / `topics.subfield.id` / `topics.field.id`。

## agentic-search 的 filters（与 meta-search 结构不同）

是对象而非数组，字段间 AND、同字段数组值 OR。除 `doc_id` 外都是软过滤：元数据缺失的片段不会被排除。

```json
{
  "lang": "en",
  "publication_venue_name_unified": "Nature Electronics",
  "publication_published_year": {"gte": 2020},
  "citation_count": {"gte": 100},
  "topics": {"logic": "and", "dimensions": {"primary_topic_domain": "Physical Sciences"}},
  "doc_id": ["<sha256>", "<sha256>"]
}
```

可用字段：`lang`、`title`、`author`、`publication_venue_name_unified`、`publication_venue_type`、`publication_published_date`、`publication_published_year`、`citation_count`、`influential_citation_count`、`topics.logic`、`topics.dimensions.primary_topic`、`topics.dimensions.primary_topic_domain`、`doc_id`。

年份/日期/被引支持标量、`{gte,lte}`、`[min,max]` 三种写法。`doc_id` 是硬约束（命中绝不越出集合），去重后上限 1000，超限报 400 `SCOPE_TOO_LARGE`；显式传空数组返回空 hits。

## 推荐的检索配方

先 `meta-search` 用期刊/年份/影响力圈出候选（拿 `doc_id`、DOI、OA 链接），再把 `doc_id` 集合交给 `agentic-search` 配合自然语言问题做集合内语义排序。这样既满足"必须在目标期刊内"，又能按研究问题排序，而不是靠语义检索碰运气。

## 错误码

| 状态 | code | 处置 |
|---|---|---|
| 400 | `INVALID_REQUEST` / `INVALID_ARGUMENT` / `INVALID_FILTERS` | 核对 filters 结构（两个端点结构不同）与字段名；`query`+`sort` 同传需注意退化语义 |
| 401 | `UNAUTHORIZED` / `TOKEN_INVALID` | 不要重试，提示用户重建 Token |
| 403 | `PERMISSION_DENIED` | 字段或资源无权限，换字段或换 Token |
| 404 | `NOT_FOUND` | 不要重试，重新定位 `doc_id` |
| 429 | `RATE_LIMITED` | 默认 30 次/分钟；指数退避，最多 3 次 |
| 502/503/504 | `UPSTREAM_UNAVAILABLE` / `UPSTREAM_TIMEOUT` | 指数退避，最多 3 次 |

## 写答案时的硬约束

每条引用给 `doc_id` 或 DOI，最好附 `chunk_id`；只给标题不算可回溯。
两个检索端点都没命中时就说明"未检索到匹配资料"，不要用模型先验补全。
时间口径以 `publication_published_year` 为准，语言口径以 `lang` 为准。
