#!/usr/bin/env node
// Locate candidate papers for a research topic within a target venue, via Sciverse.
//
// Two-stage recipe:
//   1. meta-search   -> structured candidate set (venue / year / impact / OA), carries DOI + OA link
//   2. agentic-search -> semantic ranking *inside* that doc_id set (--semantic), so hits can never
//                        drift outside the chosen venue
//
// Usage:
//   node sciverse_search.mjs --topic "<question>" --venue "<journal>" [options]
//
//   --topic <str>          required, natural-language research topic
//   --venue <str>          required, normalized venue name, e.g. "Nature Electronics"
//   --venue-match <eq|contains>   how to match the venue name (default: contains)
//   --year-from <int>      publication_published_year >= N
//   --impact <top1|top10>  filter citation_normalized_percentile.is_in_top_{1,10}_percent
//   --oa                   open access only
//   --limit <int>          candidates to return (default 10, max 100)
//   --pool <int>           stage-1 candidate pool that stage 2 ranks over (default: 5x limit, capped at 100)
//                          a pool barely larger than --limit leaves semantic ranking nothing to choose from
//   --no-semantic          skip stage 2 semantic ranking (on by default)
//   --sort-by <field>      structured sort, e.g. citation_count (validated against the live catalog)
//   --sort-order <asc|desc>  sort direction (default desc)
//   --fulltext-only        keep only candidates whose full text is retrievable (has doc_id)
//   --json                 emit raw JSON instead of a table
//   --token <str>          override token resolution

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.SCIVERSE_API_BASE || "https://api.sciverse.space";

const META_FIELDS = [
  "title",
  "doi",
  "doc_id",
  "unique_id",
  "publication_published_year",
  "publication_published_date",
  "publication_venue_name_unified",
  "citation_count",
  "influential_citation_count",
  "access_is_oa",
  "access_oa_url",
  "language",
];

const VENUE_FIELD = "publication_venue_name_unified";
const YEAR_FIELD = "publication_published_year";
const DOC_ID_FIELD = "doc_id";
const OA_FIELD = "access_is_oa";
const IMPACT_FIELD = {
  top1: "citation_normalized_percentile.is_in_top_1_percent",
  top10: "citation_normalized_percentile.is_in_top_10_percent",
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

function resolveToken(explicit) {
  if (typeof explicit === "string") return explicit;
  if (process.env.SCIVERSE_API_TOKEN) return process.env.SCIVERSE_API_TOKEN.trim();
  const cfg = path.join(os.homedir(), ".codex", "config.toml");
  try {
    const text = fs.readFileSync(cfg, "utf8");
    const block = text.match(/\[mcp_servers\.sciverse\.env\][\s\S]*?(?=\n\[|$)/);
    const m = block && block[0].match(/SCIVERSE_API_TOKEN\s*=\s*["']([^"']+)["']/);
    if (m) return m[1];
  } catch {
    /* fall through */
  }
  return null;
}

async function call(endpoint, { method = "POST", body, token, params } = {}) {
  const url = new URL(BASE + endpoint);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      continue;
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    if (res.status === 429 || res.status >= 502) {
      lastError = new Error(`${endpoint} -> HTTP ${res.status}`);
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      continue;
    }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text.slice(0, 300);
      const code = json?.error?.code || "";
      throw new Error(`${endpoint} -> HTTP ${res.status} ${code}: ${msg}`);
    }
    return json;
  }
  throw new Error(`${endpoint} -> failed after 3 attempts: ${lastError?.message || "unknown"}`);
}

// Field names must come from the live catalog, never be hardcoded silently.
async function loadCatalog(token) {
  const cat = await call("/meta-catalog", { method: "GET", token });
  const fields = cat.fields || [];
  if (fields.length === 0) throw new Error("/meta-catalog returned no fields");
  return {
    names: new Set(fields.map((f) => f.name).filter(Boolean)),
    sortable: new Set(fields.filter((f) => f.sortable).map((f) => f.name).filter(Boolean)),
  };
}

function requireField(names, field, why) {
  if (!names.has(field)) {
    throw new Error(`字段 ${field} 不在当前 /meta-catalog 中（${why}）。先用 /meta-catalog 核对可用字段名。`);
  }
}

function unit(index, hit) {
  const title = hit.title || "(无标题)";
  const venue = hit.publication_venue_name_unified || "?";
  const year = hit.publication_published_year || "?";
  const cites = hit.citation_count ?? "?";
  const doi = hit.doi || "(无 DOI)";
  const lines = [
    `${index}. ${title}`,
    `   ${venue} · ${year} · 被引 ${cites} · DOI ${doi}`,
    `   doc_id=${hit.doc_id || "(无全文 doc_id)"}${hit.unique_id ? `  unique_id=${hit.unique_id}` : ""}`,
  ];
  if (hit.access_oa_url) lines.push(`   OA: ${hit.access_oa_url}`);
  if (hit.relevance !== undefined) lines.push(`   相关度 ${Number(hit.relevance).toFixed(3)}`);
  if (hit.chunk_preview) lines.push(`   片段: ${hit.chunk_preview}`);
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const topic = typeof args.topic === "string" ? args.topic : null;
  const venue = typeof args.venue === "string" ? args.venue : null;

  if (!topic) {
    console.error("缺少 --topic（研究方向/问题）");
    console.error("用法: node sciverse_search.mjs --topic \"<topic>\" --venue \"<journal>\" [--year-from 2022] [--impact top10] [--oa] [--limit 10] [--semantic] [--json]");
    process.exit(2);
  }

  const limit = Math.min(Math.max(parseInt(args.limit ?? "10", 10) || 10, 1), 100);
  const pool = Math.min(Math.max(parseInt(args.pool ?? String(limit * 5), 10) || limit * 5, limit), 100);
  const token = resolveToken(args.token);
  if (!token) {
    console.error("未找到 Sciverse token：设 SCIVERSE_API_TOKEN，或用 --token，或确认 ~/.codex/config.toml 中的 [mcp_servers.sciverse.env]。");
    process.exit(2);
  }

  const { names, sortable } = await loadCatalog(token);
  if (venue) requireField(names, VENUE_FIELD, "按期刊过滤所需");
  if (args["year-from"]) requireField(names, YEAR_FIELD, "按年份过滤所需");
  if (args["sort-by"]) {
    const sortField = String(args["sort-by"]);
    if (!sortable.has(sortField)) {
      throw new Error(
        `字段 ${sortField} 在当前 /meta-catalog 中不可排序。可排序字段示例：${[...sortable].slice(0, 25).join(", ")}`,
      );
    }
  }
  if (args.impact) {
    const impactField = IMPACT_FIELD[String(args.impact)];
    if (!impactField) throw new Error("--impact 只接受 top1 或 top10");
    requireField(names, impactField, "按影响力过滤所需");
  }
  if (args.oa) requireField(names, OA_FIELD, "开放获取过滤所需");

  const filters = [];
  if (venue) {
    filters.push({
      field: VENUE_FIELD,
      operator: args["venue-match"] === "eq" ? "FILTER_OP_EQ" : "FILTER_OP_CONTAINS",
      value: venue,
    });
  }
  if (args["year-from"]) {
    filters.push({ field: YEAR_FIELD, operator: "FILTER_OP_GTE", value: Number(args["year-from"]) });
  }
  if (args.impact) {
    filters.push({ field: IMPACT_FIELD[String(args.impact)], operator: "FILTER_OP_EQ", value: true });
  }
  if (args.oa) filters.push({ field: OA_FIELD, operator: "FILTER_OP_EQ", value: true });

  const stage1 = await call("/meta-search", {
    token,
    body: {
      collection: "papers",
      query: topic,
      filters,
      fields: META_FIELDS.filter((f) => names.has(f)),
      page: 1,
      page_size: pool,
      ...(args["sort-by"]
        ? {
            sort: [
              {
                field: String(args["sort-by"]),
                order: args["sort-order"] === "asc" ? "SORT_ORDER_ASC" : "SORT_ORDER_DESC",
              },
            ],
          }
        : {}),
    },
  });

  let candidates = (stage1.results || []).map((r) => ({ ...r }));
  if (args["fulltext-only"]) {
    const before = candidates.length;
    candidates = candidates.filter((c) => c.doc_id);
    if (before !== candidates.length) {
      process.stderr.write(`提示：--fulltext-only 过滤掉 ${before - candidates.length} 篇无全文 doc_id 的候选。\n`);
    }
  }
  if (candidates.length === 0) {
    if (args.json) {
      console.log(JSON.stringify({ stage: "meta-search", topic, venue, filters, candidates: [] }, null, 2));
    } else {
      console.log(`没有候选：topic=${topic} venue=${venue || "(未限定)"}。放宽年份/影响力/全文限制，或换期刊后重试。`);
    }
    return;
  }

  const useSemantic = args.semantic !== false && !args["no-semantic"];
  if (useSemantic) {
    requireField(names, DOC_ID_FIELD, "集合内语义检索所需");
    const docIds = [...new Set(candidates.map((c) => c.doc_id).filter(Boolean))].slice(0, 1000);
    if (docIds.length > 0) {
      // Ask for a wider semantic pool than the requested page so most candidates receive a score.
      const topK = Math.min(100, Math.max(pool, 20));
      let stage2 = null;
      try {
        stage2 = await call("/agentic-search", {
          token,
          body: { query: topic, top_k: topK, filters: { doc_id: docIds } },
        });
      } catch (err) {
        // An empty scope result is a legitimate outcome, not a failure: fall back to stage-1 order.
        if (/EMPTY_RESULT/.test(err.message)) {
          process.stderr.write(
            "提示：候选集合内没有可用语义命中（EMPTY_RESULT），已退回结构化检索顺序。\n",
          );
        } else {
          throw err;
        }
      }
      const scoreByDoc = new Map();
      for (const hit of stage2?.hits || []) {
        if (!hit.doc_id) continue;
        if (!scoreByDoc.has(hit.doc_id) || hit.score > scoreByDoc.get(hit.doc_id).relevance) {
          scoreByDoc.set(hit.doc_id, {
            relevance: hit.score,
            chunk_preview: (hit.chunk || "").replace(/\s+/g, " ").slice(0, 160),
          });
        }
      }
      const scored = [];
      const unscored = [];
      for (const c of candidates) {
        const hit = c.doc_id ? scoreByDoc.get(c.doc_id) : null;
        if (hit) scored.push({ ...c, ...hit });
        else unscored.push(c);
      }
      scored.sort((a, b) => b.relevance - a.relevance);
      // Candidates that got no semantic hit break the ranking contract, so list them last.
      candidates = [...scored, ...unscored];
      if (unscored.length > 0) {
        const noDocId = unscored.filter((c) => !c.doc_id).length;
        process.stderr.write(
          `提示：${unscored.length} 篇候选未获得语义命中（其中 ${noDocId} 篇无全文 doc_id），已按原顺序排在末尾；` +
            `这些条目的先后不代表相关度。\n`,
        );
      }
    }
  }

  if (args.json) {
    console.log(JSON.stringify({ topic, venue, filters, pool, candidates: candidates.slice(0, limit) }, null, 2));
    return;
  }

  candidates = candidates.slice(0, limit);

  const header = [
    `topic: ${topic}`,
    `venue: ${venue || "(未限定)"}${args["year-from"] ? ` · 年份 >= ${args["year-from"]}` : ""}${args.impact ? ` · ${args.impact}` : ""}${args.oa ? " · OA" : ""}`,
    `${candidates.length} 篇候选`,
    "",
  ].join("\n");
  console.log(header);
  candidates.forEach((c, i) => {
    console.log(unit(i + 1, c));
    console.log("");
  });
  console.log("下一步：把 doc_id 交给 /content 读原文，或用 access_oa_url 下 PDF 后交给 read-paper 解析。");
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
