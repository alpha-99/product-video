# -*- coding: utf-8 -*-
"""把用户故事与产品设计 Markdown 转为带封面/目录/页码的 HTML（复用 PRD 版式）。"""
import html
import re

BASE = r"D:/py_workspace/product-video/output/productvideo-docs"
MD = BASE + "/stage1/technical_design_detailed.md"
OUT = BASE + "/stage2/formatted-technical-design-detailed.html"

CSS = r"""
:root {
  --typography-fontFamily-heading: "Microsoft YaHei", "微软雅黑", sans-serif;
  --typography-fontFamily-body: "SimSun", "宋体", serif;
  --typography-fontFamily-mono: "Consolas", monospace;
  --typography-fontSize-h1: 22pt;
  --typography-fontSize-h2: 16pt;
  --typography-fontSize-h3: 13pt;
  --typography-fontSize-h4: 12pt;
  --typography-fontSize-body: 12pt;
  --typography-fontSize-small: 10.5pt;
  --typography-lineHeight-body: 1.6;
  --typography-lineHeight-heading: 1.3;
  --typography-fontWeight-bold: 700;
  --typography-fontWeight-normal: 400;
  --layout-margin: 2.5cm;
  --layout-contentWidth: 15.6cm;
  --fs-h1: var(--typography-fontSize-h1);
  --fs-h2: var(--typography-fontSize-h2);
  --fs-h3: var(--typography-fontSize-h3);
  --fs-h4: var(--typography-fontSize-h4);
  --fs-body: var(--typography-fontSize-body);
  --fs-small: var(--typography-fontSize-small);
  --fs-cover-title: 30pt;
  --ff-heading: var(--typography-fontFamily-heading);
  --ff-body: var(--typography-fontFamily-body);
  --ff-mono: var(--typography-fontFamily-mono);
  --lh-body: var(--typography-lineHeight-body);
  --lh-heading: var(--typography-lineHeight-heading);
  --fw-bold: var(--typography-fontWeight-bold);
  --fw-normal: var(--typography-fontWeight-normal);
  --color-primary: #1565C0;
  --color-on-primary: #FFFFFF;
  --color-text: #212121;
  --color-muted: #616161;
  --color-border: #D5DBE1;
  --color-bg: #F5F7FA;
  --color-callout-bg: #EEF4FB;
  --color-code-bg: #F2F4F7;
  --spacing-paragraph: 0.75em;
  --spacing-section: 1.6em;
  --spacing-block: 1em;
  --margin-page: var(--layout-margin);
  --page-content-width: var(--layout-contentWidth);
}
@page { margin: var(--margin-page); @bottom-center { content: counter(page); } }
@page cover { @bottom-center { content: none; } }
section[role="cover"] { page: cover; }
body {
  font-family: var(--ff-body);
  font-size: var(--fs-body);
  color: var(--color-text);
  line-height: var(--lh-body);
  max-width: var(--page-content-width);
  margin-left: auto;
  margin-right: auto;
}
p { font-family: var(--ff-body); font-size: var(--fs-body); color: var(--color-text); line-height: var(--lh-body); text-indent: 2em; text-align: justify; margin: 0 0 var(--spacing-paragraph) 0; }
h1 { font-family: var(--ff-heading); font-size: var(--fs-h1); color: var(--color-primary); font-weight: var(--fw-bold); line-height: var(--lh-heading); margin: var(--spacing-section) 0 var(--spacing-block) 0; }
h2 { font-family: var(--ff-heading); font-size: var(--fs-h2); color: var(--color-primary); font-weight: var(--fw-bold); line-height: var(--lh-heading); margin: var(--spacing-section) 0 var(--spacing-block) 0; }
h3 { font-family: var(--ff-heading); font-size: var(--fs-h3); color: var(--color-text); font-weight: var(--fw-bold); line-height: var(--lh-heading); margin: var(--spacing-block) 0 0.5em 0; }
h4 { font-family: var(--ff-heading); font-size: var(--fs-h4); color: var(--color-primary); font-weight: var(--fw-bold); line-height: var(--lh-heading); margin: var(--spacing-block) 0 0.4em 0; }
strong { font-weight: var(--fw-bold); }
ul, ol { font-family: var(--ff-body); font-size: var(--fs-body); line-height: var(--lh-body); margin: 0 0 var(--spacing-paragraph) 0; padding-left: 2em; }
li { font-family: var(--ff-body); font-size: var(--fs-body); line-height: var(--lh-body); margin-bottom: 0.3em; }
table { width: 100%; border-collapse: collapse; margin: var(--spacing-block) 0; font-family: var(--ff-body); font-size: var(--fs-small); }
caption { font-family: var(--ff-heading); font-size: var(--fs-small); color: var(--color-muted); text-align: left; margin-bottom: 0.4em; }
th { background: var(--color-primary); color: var(--color-on-primary); font-weight: var(--fw-bold); text-align: left; padding: 6px 8px; border: 1px solid var(--color-border); }
td { padding: 6px 8px; border: 1px solid var(--color-border); vertical-align: top; }
code { font-family: var(--ff-mono); font-size: var(--fs-small); background: var(--color-code-bg); }
pre { font-family: var(--ff-mono); font-size: var(--fs-small); background: var(--color-code-bg); border: 1px solid var(--color-border); padding: 10px; margin: var(--spacing-block) 0; line-height: 1.4; white-space: pre-wrap; }
pre code { font-family: var(--ff-mono); font-size: var(--fs-small); background: transparent; }
.toc-title { font-family: var(--ff-heading); font-size: var(--fs-h1); color: var(--color-primary); font-weight: var(--fw-bold); text-align: center; text-indent: 0; margin-bottom: var(--spacing-section); }
.toc-list, .toc-list ol, .toc-list ul { list-style: none; padding-left: 0; }
.toc-list li { margin-bottom: 0.45em; }
.toc-list a { color: var(--color-text); text-decoration: none; }
.cover-title { font-family: var(--ff-heading); font-size: var(--fs-cover-title); color: var(--color-primary); font-weight: var(--fw-bold); text-align: center; text-indent: 0; line-height: 1.35; margin: 2.5cm 0 0.8cm 0; }
.cover-subtitle { font-family: var(--ff-heading); font-size: var(--fs-h2); color: var(--color-muted); text-align: center; text-indent: 0; margin-bottom: 1.5cm; }
.cover-meta { font-family: var(--ff-body); font-size: var(--fs-body); color: var(--color-muted); text-align: center; text-indent: 0; margin-bottom: 0.6em; }
.callout { border-left: 4px solid var(--color-primary); background: var(--color-callout-bg); padding: 8px 12px; text-indent: 0; margin: var(--spacing-block) 0; }
"""


def inline(text):
    s = html.escape(text, quote=False)
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return s


def is_table_sep(line):
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", c) for c in cells)


def parse_table(lines, start):
    rows = []
    i = start
    while i < len(lines) and lines[i].lstrip().startswith("|"):
        rows.append(lines[i])
        i += 1
    if len(rows) < 2 or not is_table_sep(rows[1]):
        return None, start
    head = [inline(c.strip()) for c in rows[0].strip().strip("|").split("|")]
    body = []
    for row in rows[2:]:
        cells = [inline(c.strip()) for c in row.strip().strip("|").split("|")]
        if len(cells) < len(head):
            cells += [""] * (len(head) - len(cells))
        body.append(cells[: len(head)])
    thead = "<thead><tr>" + "".join("<th>" + c + "</th>" for c in head) + "</tr></thead>"
    tbody = "<tbody>" + "".join(
        "<tr>" + "".join("<td>" + c + "</td>" for c in row) + "</tr>" for row in body
    ) + "</tbody>"
    return "<table>" + thead + tbody + "</table>", i


def main():
    with open(MD, encoding="utf-8") as f:
        lines = f.read().replace("\r", "").split("\n")
    out, toc = [], []
    i, h2count = 0, 0
    while i < len(lines):
        line = lines[i].rstrip()
        stripped = line.strip()
        if not stripped:
            i += 1
            continue
        if stripped.startswith("```"):
            lang = stripped[3:].strip() or "text"
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            code = html.escape("\n".join(buf), quote=False)
            out.append('<pre><code class="language-' + lang + '">' + code + "</code></pre>")
            continue
        if stripped.startswith("|") and i + 1 < len(lines) and is_table_sep(lines[i + 1]):
            table, i = parse_table(lines, i)
            if table:
                out.append(table)
            continue
        if stripped.startswith("#### "):
            out.append("<h4>" + inline(stripped[5:]) + "</h4>")
        elif stripped.startswith("### "):
            out.append("<h3>" + inline(stripped[4:]) + "</h3>")
        elif stripped.startswith("## "):
            h2count += 1
            title = stripped[3:]
            toc.append((h2count, title))
            out.append('<h2 id="s' + str(h2count) + '">' + inline(title) + "</h2>")
        elif stripped.startswith("# "):
            pass  # 封面已有主标题，正文跳过 H1
        elif stripped == "---":
            pass  # 分隔线不输出
        else:
            out.append("<p>" + inline(stripped) + "</p>")
        i += 1

    toc_html = "".join(
        '<li><a href="#s' + str(n) + '">' + html.escape(t) + "</a></li>" for n, t in toc
    )
    page = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="docx-page-size" content="A4">
<title>ProductVideo AI 技术架构与实施方案</title>
<style>%s</style>
</head>
<body>
<section role="cover">
  <p class="cover-title">ProductVideo AI</p>
  <p class="cover-subtitle">技术架构与实施方案</p>
  <p class="cover-meta">技术细节 · 落地性 · 可扩展性</p>
  <p class="cover-meta">面向研发落地与运维实施的终版技术方案</p>
  <p class="cover-meta">高级开发工程师 · 2026-11-25</p>
</section>
<section role="cover">
<nav class="doc-toc" aria-label="文档目录">
  <p class="toc-title">目录</p>
  <ol class="toc-list">%s</ol>
</nav>
</section>
<section role="body" data-page-restart="1">
%s
</section>
</body>
</html>
""" % (CSS, toc_html, "\n".join(out))
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(page)
    print("written", OUT, "chars", len(page), "sections", h2count)


if __name__ == "__main__":
    main()
