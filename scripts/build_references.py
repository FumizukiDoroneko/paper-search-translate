#!/usr/bin/env python
"""Rebuild a clean reference list for a paper, from Crossref.

Why this exists: text extracted from a two-column LaTeX PDF loses the spaces that
LaTeX kerning hides, so reference lists come out glued together
(``P.;etal.Flatbandsand...``). Crossref records a paper's references as DOIs, and
each DOI resolves to properly formed metadata, so the list can be rebuilt cleanly.

Usage:
  python build_references.py --doi 10.1021/acs.nanolett.2c00778 --out references.txt

Requires only the standard library. Adds ``mailto`` to Crossref requests so the
requests land in the polite pool.
"""

import argparse
import concurrent.futures as futures
import html
import json
import re
import sys
import urllib.parse
import urllib.request

API = "https://api.crossref.org/works/"
MAX_AUTHORS = 12


def clean_text(value):
    """Crossref titles can embed MathML/HTML (e.g. kagome formulas); strip it."""
    # Kill whitespace *between* tags first, so a formula split across nodes
    # (Fe | 3 | Sn | 2) stays glued: Fe3Sn2 rather than Fe 3 Sn 2.
    text = re.sub(r">\s+<", "><", str(value or ""))
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    return re.sub(r"\s{2,}", " ", text).strip()


def get_json(url, mailto):
    req = urllib.request.Request(
        url + ("&" if "?" in url else "?") + urllib.parse.urlencode({"mailto": mailto}),
        headers={"User-Agent": f"paper-search-translate/1.0 (mailto:{mailto})"},
    )
    with urllib.request.urlopen(req, timeout=45) as fh:
        return json.load(fh)


def format_entry(msg):
    authors = msg.get("author") or []
    names = "; ".join(
        (a.get("family", "") + (", " + a["given"] if a.get("given") else "")).strip(", ")
        for a in authors[:MAX_AUTHORS]
    )
    if len(authors) > MAX_AUTHORS:
        names += "; et al."
    title = clean_text((msg.get("title") or [""])[0])
    journal = clean_text((msg.get("short-container-title") or msg.get("container-title") or [""])[0])
    year = ((msg.get("published-print") or msg.get("published") or {}).get("date-parts") or [[None]])[0][0]
    parts = [f"{names} {title}.".strip()]
    tail = ", ".join(str(x) for x in (journal, year, msg.get("volume", ""), msg.get("page", "")) if x)
    if tail:
        parts.append(tail + ".")
    return re.sub(r"\s{2,}", " ", " ".join(parts)).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--doi", required=True, help="DOI of the paper whose references should be rebuilt")
    ap.add_argument("--out", help="write the numbered list here")
    ap.add_argument("--mailto", default="codex@example.com")
    args = ap.parse_args()

    try:
        record = get_json(API + urllib.parse.quote(args.doi), args.mailto)["message"]
    except Exception as exc:  # noqa: BLE001 - surfaced verbatim to the caller
        print(f"ERROR: 取不到 {args.doi} 的记录：{exc}", file=sys.stderr)
        return 1

    refs = record.get("reference") or []
    if not refs:
        print("ERROR: 该记录没有参考文献表（Crossref 未收录此刊的 reference）。", file=sys.stderr)
        return 1

    dois = {i: r.get("DOI") for i, r in enumerate(refs, 1)}
    resolved = {}
    with futures.ThreadPoolExecutor(max_workers=6) as pool:
        jobs = {pool.submit(get_json, API + urllib.parse.quote(d), args.mailto): i
                for i, d in dois.items() if d}
        for job in futures.as_completed(jobs):
            idx = jobs[job]
            try:
                resolved[idx] = format_entry(job.result()["message"])
            except Exception:  # noqa: BLE001 - keep a traceable placeholder instead
                resolved[idx] = None

    lines, missing = [], []
    for idx in sorted(dois):
        text = resolved.get(idx)
        if text:
            lines.append(f"[{idx}] {text}")
        else:
            doi = dois[idx] or "（无 DOI）"
            lines.append(f"[{idx}] （Crossref 未返回元数据，待补全）{doi}")
            missing.append(idx)

    out = "\n".join(lines)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(out)
        print(f"已写入 {args.out}")
    else:
        print(out)
    print(f"条目数={len(lines)} 待补全={missing or '无'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
