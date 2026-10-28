/**
 * 웹 글 본문을 문단으로 뽑는 파이썬 스크립트. trafilatura로 광고와 메뉴를 걷어내고 XML로 받아(정밀 모드는 소제목을 버려서 기본 모드를 쓴다)
 * 제목(head), 문단(p, quote, code), 목록(list), 표(table)를 순서대로 문단 단위로 낸다.
 * 표는 칸 글자를 그대로 table-<n>으로 두고 그 자리에 캡션 문단을 하나 둔다.
 * 결과 JSON은 stdout 마지막 줄 하나다. 백틱과 달러 중괄호가 없어야 String.raw 안에 그대로 실린다
 */
export const WEB_EXTRACT_PY = String.raw`import json, sys
import xml.etree.ElementTree as ET

import trafilatura

html_path, url = sys.argv[1], sys.argv[2]
with open(html_path, "rb") as f:
    raw = f.read()
html = raw.decode("utf-8", errors="replace")
meta = trafilatura.extract_metadata(html, default_url=url)
xml = trafilatura.extract(html, url=url, output_format="xml", include_tables=True, include_comments=False, include_links=False, include_images=False)
units, tables = [], []
if xml:
    root = ET.fromstring(xml)
    body = root.find("main")
    if body is None:
        body = root
    def text_of(el):
        return " ".join("".join(el.itertext()).split())
    for el in body:
        tag = el.tag
        if tag == "head":
            t = text_of(el)
            if t:
                units.append({"role": "heading", "text": t})
        elif tag in ("p", "quote", "code"):
            t = text_of(el)
            if t:
                units.append({"role": "para", "text": t})
        elif tag == "list":
            items = [text_of(i) for i in el.findall("item")]
            items = [i for i in items if i]
            if items:
                units.append({"role": "para", "text": " / ".join(items)})
        elif tag == "table":
            rows = []
            for row in el.findall("row"):
                cells = [text_of(c) for c in row.findall("cell")]
                if any(cells):
                    rows.append(cells)
            if rows:
                width = max(len(r) for r in rows)
                rows = [r + [""] * (width - len(r)) for r in rows]
                n = len(tables) + 1
                tid = f"table-{n}"
                caption = f"Table {n}: " + " | ".join(rows[0])[:120]
                tables.append({"id": tid, "number": str(n), "caption": caption, "rows": rows, "grid": "ok" if width >= 2 else "loose", "unit": len(units)})
                units.append({"role": "caption", "ref": tid, "text": caption})
        else:
            t = text_of(el)
            if t:
                units.append({"role": "para", "text": t})
for i, u in enumerate(units):
    u["i"] = i
out = {
    "title": (meta.title if meta and meta.title else "") or "",
    "author": (meta.author if meta and meta.author else "") or "",
    "date": (meta.date if meta and meta.date else "") or "",
    "site": (meta.sitename if meta and meta.sitename else "") or "",
    "lang": (meta.language if meta and getattr(meta, "language", None) else "") or "",
    "units": units,
    "tables": tables,
}
sys.stdout.write("\n" + json.dumps(out) + "\n")
`;
