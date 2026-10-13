#!/usr/bin/env python3
"""Validate this skill package. Standard library only, so CI needs no installs.

Checks, in order:
  1. SKILL.md exists and carries YAML frontmatter with `name` and `description`
  2. `name` matches the folder name and the lower-case/hyphen convention
  3. no unfinished scaffold placeholders survive in SKILL.md or references/
  4. every local markdown link resolves (remote links are not fetched)
  5. every .mjs file parses (`node --check`) and every .py file compiles

Repo-only files (README.md, LICENSE, examples/, .github/) are deliberately not
required to be referenced from SKILL.md.
"""

import py_compile
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
# Scaffold markers only. Bare "XXX" is deliberately excluded: journal page furniture
# such as "Nano Lett. XXX, XXX, XXX-XXX" is legitimate content in this skill.
PLACEHOLDERS = ("[TODO", "TODO:", "FIXME:")
# Skip image syntax and elided example targets, which are content, not links.
LINK_RE = re.compile(r"(?<![!])\[[^\]]*\]\(([^)\s]+)\)")


def parse_frontmatter(text):
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end == -1:
        return None
    fields = {}
    for line in text[3:end].splitlines():
        if not line.strip() or line.lstrip().startswith("#") or ":" not in line:
            continue
        key, value = line.split(":", 1)
        fields[key.strip()] = value.strip().strip("\"'")
    return fields


def check_frontmatter(root, text, errors):
    front = parse_frontmatter(text)
    if not front:
        errors.append("SKILL.md 缺少 YAML frontmatter")
        return
    name = front.get("name", "")
    description = front.get("description", "")
    if not name:
        errors.append("frontmatter 缺少 name")
    if name and not NAME_RE.match(name):
        errors.append(f"name 不符合小写字母/数字/连字符规范: {name}")
    if name and name != root.name:
        errors.append(f"name ({name}) 与目录名 ({root.name}) 不一致")
    if not description:
        errors.append("frontmatter 缺少 description")
    if len(description) > 1024:
        errors.append(f"description 过长: {len(description)} 字符")


def check_placeholders(root, errors):
    targets = [root / "SKILL.md"]
    refs = root / "references"
    if refs.is_dir():
        targets += sorted(refs.glob("*.md"))
    for path in targets:
        body = path.read_text(encoding="utf-8")
        for token in PLACEHOLDERS:
            if token in body:
                errors.append(f"{path.relative_to(root)} 残留脚手架占位符: {token}")
                break


def check_links(root, text, errors):
    for target in LINK_RE.findall(text):
        if target.startswith(("http://", "https://", "mailto:", "#")):
            continue
        clean = target.split("#", 1)[0]
        if "..." in clean:
            continue
        if clean and not (root / clean).exists():
            errors.append(f"SKILL.md 中的本地链接无法解析: {target}")


def check_scripts(root, errors, warnings):
    scripts = root / "scripts"
    if not scripts.is_dir():
        return
    node = shutil.which("node")
    for script in sorted(scripts.glob("*.mjs")):
        if not node:
            warnings.append(f"跳过 {script.name} 的语法检查（未找到 node）")
            continue
        proc = subprocess.run([node, "--check", str(script)], capture_output=True, text=True)
        if proc.returncode != 0:
            first = (proc.stderr.strip().splitlines() or ["未知错误"])[0]
            errors.append(f"{script.name} 语法错误: {first}")
    for script in sorted(scripts.glob("*.py")):
        cfile = Path(tempfile.gettempdir()) / (script.stem + ".pyc")
        try:
            py_compile.compile(str(script), doraise=True, cfile=str(cfile))
        except Exception as exc:  # noqa: BLE001 - surfaced to the caller
            errors.append(f"{script.name} 编译失败: {exc}")


def main():
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    errors, warnings = [], []

    skill_md = root / "SKILL.md"
    if not skill_md.exists():
        print("FAIL: 缺少 SKILL.md")
        return 1
    text = skill_md.read_text(encoding="utf-8")

    check_frontmatter(root, text, errors)
    check_placeholders(root, errors)
    check_links(root, text, errors)
    check_scripts(root, errors, warnings)

    for item in warnings:
        print("WARN:", item)
    for item in errors:
        print("FAIL:", item)
    if errors:
        print(f"\n{len(errors)} 项未通过")
        return 1
    print(f"OK: {root.name} 校验通过（frontmatter、占位符、本地链接、脚本语法）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
