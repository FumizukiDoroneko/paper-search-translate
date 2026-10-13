#!/usr/bin/env node
// Fetch a paper's full text as Markdown from Sciverse by doc_id, paging /content.
//
// Usage:
//   node sciverse_content.mjs --doc-id <sha256> [--out <file.md>] [--max-chars <N>] [--token <str>]
//
// /content returns Unicode code-point slices: pass offset to activate limit. A 20000-char window
// keeps request counts low, which matters under the 30 req/min default rate limit.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.SCIVERSE_API_BASE || "https://api.sciverse.space";
const WINDOW = 20000;

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const docId = typeof args["doc-id"] === "string" ? args["doc-id"] : null;
  if (!docId) {
    console.error("缺少 --doc-id（来自 sciverse_search.mjs 的 doc_id）");
    process.exit(2);
  }
  const token = resolveToken(args.token);
  if (!token) {
    console.error("未找到 Sciverse token：设 SCIVERSE_API_TOKEN，或用 --token。");
    process.exit(2);
  }
  const maxChars = args["max-chars"] ? Number(args["max-chars"]) : Infinity;

  let offset = 0;
  let more = true;
  const parts = [];
  let chunks = 0;
  while (more && offset < maxChars) {
    const url = new URL(BASE + "/content");
    url.searchParams.set("doc_id", docId);
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(WINDOW));
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status !== 429 && res.status < 502) break;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      console.error(`ERROR: /content -> HTTP ${res.status} ${body?.error?.code || ""}: ${body?.error?.message || ""}`);
      process.exit(1);
    }
    if (typeof body.text !== "string" || body.text.length === 0) break;
    parts.push(body.text);
    chunks++;
    more = body.more === true;
    const next = Number(body.next_offset);
    offset = Number.isFinite(next) && next > offset ? next : offset + body.text.length;
  }

  const full = parts.join("");
  if (args.out) {
    fs.writeFileSync(args.out, full, "utf8");
    console.log(`已写入 ${args.out}`);
  }
  console.log(`doc_id=${docId}`);
  console.log(`窗口数=${chunks} 字符数=${full.length} 是否到底=${!more}`);
  if (!args.out && args.print) console.log(full);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
