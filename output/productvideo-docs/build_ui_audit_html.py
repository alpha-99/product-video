# -*- coding: utf-8 -*-
"""把 UI 审核报告 Markdown 转为单文件 HTML（可在浏览器预览 / 打印为 PDF）。

版式沿用 ProductVideo AI 设计系统：暖纸底、深墨绿、香槟金、衬线展示字体。
不依赖任何远程字体或 CDN，离线可直接打开。
"""
import html
import re
from pathlib import Path

ROOT = Path("D:/py_workspace/product-video")
MD = ROOT / "docs/ui/ProductVideo_AI_UI审核报告_V1.0.md"
OUT = ROOT / "docs/ui/ProductVideo_AI_UI审核报告_V1.0.html"

CSS = r"""
:root{
  --paper:#f9f6f2; --paper-2:#f1ece6; --surface:#ffffff;
  --ink:#2a1f17; --ink-2:#574e47; --ink-3:#6d655e;
  --line:#e5ded4; --line-strong:#d3c9bc;
  --brand:#315e42; --brand-deep:#1f3e2b; --brand-soft:#e7f0e9;
  --gold:#b8894a; --gold-soft:#f7ecd9;
  --red:#a8392f; --red-soft:#f8e7e4;
  --green:#2f7042; --green-soft:#e6f3e9;
  --blue:#3e6f96; --blue-soft:#e8f1f8;
  --ff-display:"Fraunces","Songti SC","STSong",Georgia,serif;
  --ff-sans:"Plus Jakarta Sans","PingFang SC","Microsoft YaHei",system-ui,sans-serif;
  --ff-mono:"Cascadia Mono",Consolas,"Courier New",monospace;
}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--ff-sans);font-size:14px;line-height:1.75;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
.wrap{max-width:1180px;margin:0 auto;padding:0 32px}

/* ---------- cover ---------- */
.cover{background:var(--brand-deep);color:#f6f1e8;padding:52px 0 46px;position:relative;overflow:hidden}
.cover::after{content:"";position:absolute;right:-90px;top:-120px;width:380px;height:380px;border:1px solid rgba(200,170,120,.28);border-radius:50%;pointer-events:none}
.cover::before{content:"";position:absolute;right:-30px;top:-60px;width:260px;height:260px;border:1px solid rgba(200,170,120,.18);border-radius:50%;pointer-events:none}
.cover .wrap{position:relative;z-index:1}
.brandrow{display:flex;align-items:center;gap:12px;margin-bottom:34px}
.brandmark{width:36px;height:36px;border:1px solid var(--gold);border-radius:9px;display:grid;place-items:center;font-family:var(--ff-display);font-style:italic;font-size:15px;color:var(--gold)}
.brandname{font-family:var(--ff-display);font-size:17px;letter-spacing:.02em}
.brandname small{display:block;font-family:var(--ff-sans);font-size:10px;letter-spacing:.16em;text-transform:uppercase;opacity:.6;margin-top:2px}
.eyebrow{font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--gold);margin:0 0 14px}
.cover h1{font-family:var(--ff-display);font-size:40px;font-weight:600;line-height:1.2;margin:0 0 12px;letter-spacing:-.01em}
.cover .sub{font-size:15px;opacity:.78;margin:0 0 28px;max-width:720px;line-height:1.8}
.verdict{display:inline-flex;align-items:center;gap:10px;background:rgba(214,110,90,.16);border:1px solid rgba(226,145,125,.55);color:#ffd9cf;padding:8px 16px;border-radius:99px;font-size:13px;font-weight:700;margin-bottom:30px}
.verdict i{width:8px;height:8px;border-radius:50%;background:#e8917d;display:block}
.metrics{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;max-width:860px}
.metric{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:14px 16px}
.metric b{display:block;font-family:var(--ff-display);font-size:26px;font-weight:600;line-height:1.1;color:#f6f1e8}
.metric span{font-size:11px;letter-spacing:.06em;opacity:.65}
.metric.crit b{color:#ffb9a8}
.metric.good b{color:#c9e2ce}

/* ---------- layout ---------- */
.layout{display:grid;grid-template-columns:226px 1fr;gap:48px;padding:40px 0 80px;align-items:start}
.toc{position:sticky;top:24px;border-left:2px solid var(--line-strong);padding-left:18px}
.toc .toc-h{font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--ink-3);margin-bottom:12px}
.toc ol{list-style:none;margin:0;padding:0;counter-reset:toc}
.toc li{margin:0 0 7px;font-size:12.5px;color:var(--ink-2);line-height:1.5}
.toc li a:hover{color:var(--brand);text-decoration:underline;text-underline-offset:3px}
.toc .toc-foot{margin-top:22px;padding-top:14px;border-top:1px solid var(--line);font-size:11px;color:var(--ink-3);line-height:1.6}
main{min-width:0}

/* ---------- typography ---------- */
h2{font-family:var(--ff-display);font-size:25px;font-weight:600;line-height:1.3;margin:52px 0 18px;padding-bottom:12px;border-bottom:1px solid var(--line-strong);scroll-margin-top:20px}
h2:first-child{margin-top:0}
h3{font-size:16px;font-weight:700;margin:32px 0 12px;color:var(--brand-deep);scroll-margin-top:20px}
h3::before{content:"";display:inline-block;width:5px;height:5px;background:var(--gold);border-radius:50%;vertical-align:middle;margin-right:9px}
h4.issue-head{font-size:15px;font-weight:700;margin:28px 0 10px;padding:11px 15px;background:var(--red-soft);border-left:3px solid var(--red);border-radius:0 8px 8px 0;color:#7d2c24}
p{margin:0 0 12px;color:var(--ink-2)}
p strong,li strong{color:var(--ink)}
blockquote{margin:0 0 20px;padding:16px 20px;background:var(--gold-soft);border-left:3px solid var(--gold);border-radius:0 10px 10px 0}
blockquote p{margin:0 0 6px;color:#6b4f2c}
blockquote p:last-child{margin-bottom:0}
blockquote p:first-child{font-size:15px;font-weight:700;color:#7a3b2c}
ul,ol{margin:0 0 16px;padding-left:22px}
li{margin:0 0 6px;color:var(--ink-2)}
code{font-family:var(--ff-mono);font-size:12px;background:var(--paper-2);border:1px solid var(--line);border-radius:4px;padding:1px 5px;color:var(--brand-deep)}
hr{border:0;border-top:1px solid var(--line);margin:28px 0}

/* ---------- table ---------- */
.tablewrap{overflow-x:auto;margin:0 0 20px;border:1px solid var(--line);border-radius:10px;background:var(--surface)}
table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:560px}
caption{text-align:left;font-size:11px;color:var(--ink-3);padding:8px 12px;background:var(--paper-2)}
th{background:var(--brand);color:#fff;font-weight:600;text-align:left;padding:10px 12px;border-bottom:1px solid var(--brand-deep);white-space:nowrap;font-size:12px}
td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top;color:var(--ink-2);line-height:1.6}
tbody tr:last-child td{border-bottom:0}
tbody tr:nth-child(even){background:#fcfaf7}
td:first-child{color:var(--ink);font-weight:600}
.sev-p0{color:var(--red)!important;font-weight:700}
.sev-p1{color:#a2671f!important;font-weight:700}
.sev-p2{color:var(--blue)!important;font-weight:700}
.sev-ok{color:var(--green)!important;font-weight:700}
.sev-c{color:#6b5b8f!important;font-weight:700}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;font-size:11px;font-weight:700;letter-spacing:.02em}
.pill-fail{background:var(--red-soft);color:var(--red)}
.pill-pass{background:var(--green-soft);color:var(--green)}

/* ---------- checklist ---------- */
ul.checklist{list-style:none;padding-left:0}
ul.checklist li{position:relative;padding-left:26px;margin-bottom:9px}
ul.checklist li::before{content:"";position:absolute;left:0;top:5px;width:14px;height:14px;border:1.5px solid var(--line-strong);border-radius:3px;background:var(--surface)}

footer{background:var(--paper-2);border-top:1px solid var(--line);padding:26px 0;font-size:12px;color:var(--ink-3)}
footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}

@media (max-width:900px){
  .layout{grid-template-columns:1fr;gap:24px}
  .toc{position:static;border-left:0;border-bottom:1px solid var(--line-strong);padding:0 0 18px}
  .toc ol{columns:2}
  .metrics{grid-template-columns:repeat(2,1fr)}
  .cover h1{font-size:30px}
  .wrap{padding:0 20px}
}
@media print{
  @page{size:A4;margin:16mm 14mm}
  body{background:#fff;font-size:10.5pt}
  .cover{padding:20mm 0 14mm;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  .cover h1{font-size:26pt}
  .cover::before,.cover::after{display:none}
  .metrics{grid-template-columns:repeat(5,1fr)}
  .toc,footer{display:none}
  .layout{display:block;padding:10mm 0 0}
  h2{font-size:16pt;margin:14mm 0 5mm;break-after:avoid}
  h3,h4{break-after:avoid}
  .tablewrap{overflow:visible;break-inside:avoid}
  table{font-size:8.5pt;min-width:0}
  th,td{padding:4pt 6pt}
  th{-webkit-print-color-adjust:exact;print-color-adjust:exact}
  tr{break-inside:avoid}
  p,li{orphans:3;widows:3}
}
"""


def inline(text):
    s = html.escape(text, quote=False)
    s = s.replace("**FAIL**", '<span class="pill pill-fail">FAIL</span>')
    s = s.replace("**PASS**", '<span class="pill pill-pass">PASS</span>')
    s = s.replace("**不通过**", '<span class="pill pill-fail">不通过</span>')
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    return s


def is_table_sep(line):
    cells = [c.strip() for c in line.strip().strip("|").split("|")]
    return bool(cells) and all(re.fullmatch(r":?-{3,}:?", c) for c in cells)


def cell_class(text):
    plain = re.sub(r"\*\*|`", "", text).strip()
    if re.match(r"^P0-", plain):
        return ' class="sev-p0"'
    if re.match(r"^P1-", plain):
        return ' class="sev-p1"'
    if re.match(r"^P2-", plain):
        return ' class="sev-p2"'
    if re.match(r"^OK-", plain):
        return ' class="sev-ok"'
    if re.match(r"^C-\d", plain) or re.match(r"^[ARH]-\d", plain):
        return ' class="sev-c"'
    return ""


def parse_table(lines, start):
    rows = []
    i = start
    while i < len(lines) and lines[i].lstrip().startswith("|"):
        rows.append(lines[i])
        i += 1
    if len(rows) < 2 or not is_table_sep(rows[1]):
        return None, start
    head = [c.strip() for c in rows[0].strip().strip("|").split("|")]
    thead = "<thead><tr>" + "".join("<th>" + inline(c) + "</th>" for c in head) + "</tr></thead>"
    body = []
    for row in rows[2:]:
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        if len(cells) < len(head):
            cells += [""] * (len(head) - len(cells))
        body.append(cells[:len(head)])
    tbody = "<tbody>" + "".join(
        "<tr>" + "".join("<td" + cell_class(c) + ">" + inline(c) + "</td>" for c in r) + "</tr>"
        for r in body
    ) + "</tbody>"
    return '<div class="tablewrap"><table>' + thead + tbody + "</table></div>", i


def main():
    lines = MD.read_text(encoding="utf-8").replace("\r", "").split("\n")
    out, toc = [], []
    i, h2count = 0, 0
    while i < len(lines):
        stripped = lines[i].strip()
        if not stripped:
            i += 1
            continue
        # 代码块
        if stripped.startswith("```"):
            i += 1
            buf = []
            while i < len(lines) and not lines[i].strip().startswith("```"):
                buf.append(lines[i])
                i += 1
            i += 1
            out.append("<pre><code>" + html.escape("\n".join(buf), quote=False) + "</code></pre>")
            continue
        # 表格
        if stripped.startswith("|") and i + 1 < len(lines) and is_table_sep(lines[i + 1]):
            table, i = parse_table(lines, i)
            if table:
                out.append(table)
            continue
        # 引用块（合并连续行）
        if stripped.startswith("> "):
            buf = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                buf.append(lines[i].strip().lstrip(">").strip())
                i += 1
            out.append("<blockquote>" + "".join("<p>" + inline(b) + "</p>" for b in buf if b) + "</blockquote>")
            continue
        # 清单
        if re.match(r"^- \[[ xX]\] ", stripped):
            buf = []
            while i < len(lines) and re.match(r"^- \[[ xX]\] ", lines[i].strip()):
                buf.append(re.sub(r"^- \[[ xX]\] ", "", lines[i].strip()))
                i += 1
            out.append('<ul class="checklist">' + "".join("<li>" + inline(b) + "</li>" for b in buf) + "</ul>")
            continue
        # 无序 / 有序列表
        m = re.match(r"^(\d+)\. |^- ", stripped)
        if m:
            ordered = bool(m.group(1))
            buf = []
            while i < len(lines):
                cur = lines[i].strip()
                if ordered and re.match(r"^\d+\. ", cur):
                    buf.append(re.sub(r"^\d+\. ", "", cur))
                elif not ordered and cur.startswith("- ") and not re.match(r"^- \[[ xX]\]", cur):
                    buf.append(cur[2:])
                else:
                    break
                i += 1
            tag = "ol" if ordered else "ul"
            out.append("<" + tag + ">" + "".join("<li>" + inline(b) + "</li>" for b in buf) + "</" + tag + ">")
            continue
        # 标题
        if stripped.startswith("#### "):
            out.append('<h4 class="issue-head">' + inline(stripped[5:]) + "</h4>")
        elif stripped.startswith("### "):
            out.append("<h3>" + inline(stripped[4:]) + "</h3>")
        elif stripped.startswith("## "):
            h2count += 1
            title = stripped[3:]
            toc.append((h2count, title))
            out.append('<h2 id="s' + str(h2count) + '">' + inline(title) + "</h2>")
        elif stripped.startswith("# "):
            pass  # 封面已有主标题
        elif stripped == "---":
            out.append("<hr>")
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
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ProductVideo AI · UI 一致性审核报告 V1.0</title>
<style>%s</style>
</head>
<body>
<header class="cover">
  <div class="wrap">
    <div class="brandrow">
      <div class="brandmark">PV</div>
      <div class="brandname">ProductVideo AI<small>UI Design System · Audit</small></div>
    </div>
    <p class="eyebrow">Design QA Report / V1.0</p>
    <h1>UI 一致性审核报告</h1>
    <p class="sub">以《UI 设计方案》第 05 章硬性条款、11 张设计稿与用户故事文档为基准，对阶段八落地的前端实现做逐项验收核对。</p>
    <div class="verdict"><i></i>审核结论：不通过 · 暂不签设计验收</div>
    <div class="metrics">
      <div class="metric crit"><b>4</b><span>P0 阻断项</span></div>
      <div class="metric"><b>6</b><span>P1 主要差距</span></div>
      <div class="metric"><b>8</b><span>P2 体验问题</span></div>
      <div class="metric"><b>6</b><span>基准冲突</span></div>
      <div class="metric good"><b>92</b><span>视觉还原度</span></div>
    </div>
  </div>
</header>
<div class="wrap layout">
  <nav class="toc" aria-label="报告目录">
    <div class="toc-h">Contents / 目录</div>
    <ol>%s</ol>
    <div class="toc-foot">审核日期 2026-11-26<br>静态审核 · 未启动服务<br>基准为当日工作区快照</div>
  </nav>
  <main>%s</main>
</div>
<footer><div class="wrap">
  <span>ProductVideo AI · UI 一致性审核报告 V1.0 · UI Designer</span>
  <span>基准：UI 设计方案 / 设计稿 PNG / 用户故事与产品设计说明</span>
</div></footer>
</body>
</html>
""" % (CSS, toc_html, "\n".join(out))
    OUT.write_text(page, encoding="utf-8")
    print("written:", OUT)
    print("chars:", len(page), "sections:", h2count)


if __name__ == "__main__":
    main()
