/**
 * PDF에서 문단과 표, 그림을 좌표와 함께 뽑는 파이썬 스크립트. pdfplumber를 쓴다(pypdfium2로 쪽 그림을 그린다).
 *
 * - 문단: 단을 나눠 읽고 줄 간격과 들여쓰기로 끊는다. 단이나 쪽을 넘는 문단은 사각형을 여럿 단다.
 *   아래첨자 줄은 버리고 수식 조각은 앞 문단에 붙인다.
 * - 표: "Table N:" 캡션과 같은 단에서 가장 가까운 가로줄 묶음(booktabs)을 표 자리로 잡는다.
 *   모든 줄에서 비어 있는 세로 띠를 칸 경계로 본다. 칸이 하나뿐이거나 빈칸이 30%를 넘으면 grid를 loose로 적는다.
 * - 그림: "Figure N:" 캡션 위나 아래의 비트맵을 묶어 자르고 벡터 그림은 캡션 위 빈자리를 자른다.
 *
 * 결과 JSON은 stdout 마지막 줄 하나로 낸다. 쪽 그림과 크롭은 두 번째 인자 폴더의 pages/, figures/, tables/에 쓴다.
 * 백틱과 달러 중괄호가 없어야 String.raw 안에 그대로 실린다
 */
export const PDF_EXTRACT_PY = String.raw`import json, os, re, statistics, sys

import pdfplumber

pdf_path, out_dir = sys.argv[1], sys.argv[2]
PAGE_SCALE = 2.0
CROP_SCALE = 3.0
CAPTION = re.compile(r"^(Table|Figure|Fig\.)\s*(\d+)\s*[:.]", re.I)
NUM = re.compile(r"^[-+]?\d")


def cluster_lines(words, tol=2.0, gap=15.0):
    words = sorted(words, key=lambda w: (round(w["top"] / tol), w["x0"]))
    rows = []
    for w in sorted(words, key=lambda w: w["top"]):
        for r in rows:
            if abs(r["top"] - w["top"]) <= tol:
                r["words"].append(w)
                break
        else:
            rows.append({"top": w["top"], "words": [w]})
    segs = []
    for r in rows:
        ws = sorted(r["words"], key=lambda w: w["x0"])
        cur = [ws[0]]
        for w in ws[1:]:
            if w["x0"] - cur[-1]["x1"] > gap:
                segs.append(cur)
                cur = [w]
            else:
                cur.append(w)
        segs.append(cur)
    out = []
    for ws in segs:
        out.append(
            {
                "x0": min(w["x0"] for w in ws),
                "x1": max(w["x1"] for w in ws),
                "top": min(w["top"] for w in ws),
                "bottom": max(w["bottom"] for w in ws),
                "size": statistics.median(w["size"] for w in ws),
                "bold": sum(1 for w in ws if re.search(r"Bold|Medi|Semibold", w["fontname"])) > len(ws) / 2,
                "text": " ".join(w["text"] for w in ws),
            }
        )
    return out


def inside(line, box, pad=2):
    x0, top, x1, bottom = box
    return line["x0"] >= x0 - pad and line["x1"] <= x1 + pad and line["top"] >= top - pad and line["bottom"] <= bottom + pad


def overlap_x(a0, a1, b0, b1):
    return max(0.0, min(a1, b1) - max(a0, b0))


def table_regions(page, captions):
    """Booktabs 표는 가로줄 묶음으로 자리를 잡는다. 캡션과 같은 단에서 가장 가까운 묶음이다"""
    rules = sorted(
        [l for l in page.lines if abs(l["top"] - l["bottom"]) < 1.5 and l["x1"] - l["x0"] > 40],
        key=lambda l: l["top"],
    )
    groups = []
    for l in rules:
        for g in groups:
            if overlap_x(g["x0"], g["x1"], l["x0"], l["x1"]) > 0.8 * (l["x1"] - l["x0"]) and l["top"] - g["bottom"] < 90:
                g["bottom"] = max(g["bottom"], l["top"])
                g["n"] += 1
                g["ys"].append((l["top"], l["x1"] - l["x0"]))
                break
        else:
            groups.append({"x0": l["x0"], "x1": l["x1"], "top": l["top"], "bottom": l["top"], "n": 1, "ys": [(l["top"], l["x1"] - l["x0"])]})
    groups = [g for g in groups if g["n"] >= 2]
    found = []
    used = set()
    for cap in captions:
        best, best_d = None, 1e9
        for gi, g in enumerate(groups):
            if gi in used or overlap_x(g["x0"], g["x1"], cap["x0"], cap["x1"]) <= 0:
                continue
            d = g["top"] - cap["bottom"] if g["top"] >= cap["top"] else cap["top"] - g["bottom"]
            if 0 <= d < best_d and d < 120:
                best, best_d = gi, d
        if best is not None:
            used.add(best)
            g = groups[best]
            # 머리줄 경계는 표 폭 전체를 긋는 줄만 본다. 여러 열을 묶는 짧은 줄(cmidrule)은 머리줄 안쪽이다
            full = sorted(y for y, w in g["ys"] if w >= 0.9 * (g["x1"] - g["x0"]))
            found.append((cap, (g["x0"] - 2, g["top"] - 1, g["x1"] + 2, g["bottom"] + 1), full))
    return found


def build_table(page, box, ys):
    words = page.crop(box).extract_words(x_tolerance=1.5, extra_attrs=["size", "fontname"])
    if not words:
        return None
    rows = []
    for w in sorted(words, key=lambda w: (w["top"] + w["bottom"]) / 2):
        mid = (w["top"] + w["bottom"]) / 2
        for r in rows:
            if abs(r["mid"] - mid) <= 3.5:
                r["words"].append(w)
                break
        else:
            rows.append({"mid": mid, "words": [w]})
    rows.sort(key=lambda r: r["mid"])
    # booktabs는 윗줄과 가운데 줄 사이가 머리줄이다. 머리줄이 여러 줄이면 칸끼리 이어 한 줄로 합친다
    head_n = sum(1 for r in rows if r["mid"] < ys[1]) if len(ys) >= 3 else 0
    body_words = [w for r in rows[head_n:] for w in r["words"]] or words
    # 본문 줄에서 비어 있는 세로 띠가 칸 경계다. 여러 칸에 걸친 머리줄 글자가 경계를 지우지 않게 머리줄은 빼고 본다
    x0 = min(w["x0"] for w in body_words)
    x1 = max(w["x1"] for w in body_words)
    step = 0.5
    n = int((x1 - x0) / step) + 1
    covered = [False] * n
    for w in body_words:
        for k in range(int((w["x0"] - x0) / step), min(n, int((w["x1"] - x0) / step) + 1)):
            covered[k] = True
    bounds = []
    k = 0
    while k < n:
        if not covered[k]:
            j = k
            while j < n and not covered[j]:
                j += 1
            if (j - k) * step >= 4.0:
                bounds.append(x0 + (k + j) / 2 * step)
            k = j
        else:
            k += 1
    # 머리줄 글자가 본문 폭 밖으로 나가도 양 끝 칸에 들어가게 바깥 경계는 열어 둔다
    edges = [float("-inf")] + bounds + [float("inf")]
    # 본문 칸마다 글자가 실제로 차지한 폭. 머리줄 낱말이 어느 칸 글자 위에 있는지 볼 때 쓴다
    extents = {}
    for w in body_words:
        cx = (w["x0"] + w["x1"]) / 2
        c = next(c for c in range(len(edges) - 1) if edges[c] <= cx < edges[c + 1])
        lo, hi = extents.get(c, (w["x0"], w["x1"]))
        extents[c] = (min(lo, w["x0"]), max(hi, w["x1"]))
    grid = []
    for ri, r in enumerate(rows):
        cells = [[] for _ in range(len(edges) - 1)]
        ws = sorted(r["words"], key=lambda w: w["x0"])
        # 머리줄 낱말이 칸 경계에 걸치면 본문 칸의 실제 폭과 겹치는 칸으로 보낸다. 두 칸 사이 빈 띠 안이면
        # 더 가까운 옆 낱말의 칸을 따른다("Train Size"의 Size). 머리 글자가 본문 칸보다 넓어도 제 칸에 남는다
        def anchor(k):
            w = ws[k]
            mid = (w["x0"] + w["x1"]) / 2
            if ri >= head_n or not any(w["x0"] < b < w["x1"] for b in bounds):
                return mid
            hits = sorted(c for c, (a, b) in extents.items() if min(w["x1"], b) - max(w["x0"], a) > 0)
            # 여러 칸에 걸친 머리 글자("BLEU")는 묶는 칸들 가운데 첫 칸에 둔다
            if hits:
                lo, hi = extents[hits[0]]
                return (max(lo, w["x0"]) + min(hi, w["x1"])) / 2
            left = ws[k - 1] if k > 0 else None
            right = ws[k + 1] if k + 1 < len(ws) else None
            gl = w["x0"] - left["x1"] if left else float("inf")
            gr = right["x0"] - w["x1"] if right else float("inf")
            near = left if gl <= gr else right
            return (near["x0"] + near["x1"]) / 2 if near else mid
        placed = [(anchor(k), w["text"]) for k, w in enumerate(ws)]
        for cx, text in placed:
            for c in range(len(edges) - 1):
                if edges[c] <= cx < edges[c + 1]:
                    cells[c].append(text)
                    break
        grid.append([re.sub(r"(?<=\d) ?\. ?(?=\d)", ".", " ".join(c)) for c in cells])
    if head_n > 1:
        head = [" ".join(grid[r][c] for r in range(head_n) if grid[r][c]) for c in range(len(edges) - 1)]
        grid = [head] + grid[head_n:]
    return grid


def figure_region(page, cap, text_lines):
    imgs = [im for im in page.images if overlap_x(im["x0"], im["x1"], cap["x0"], cap["x1"]) > 0 or cap["x1"] - cap["x0"] > page.width * 0.6]
    above = [im for im in imgs if im["bottom"] <= cap["top"] + 4 and cap["top"] - im["bottom"] < 80]
    if above:
        near = max(im["bottom"] for im in above)
        group = [im for im in above if near - im["bottom"] < 20]
        return (min(i["x0"] for i in group), min(i["top"] for i in group), max(i["x1"] for i in group), max(i["bottom"] for i in group))
    below = [im for im in imgs if im["top"] >= cap["bottom"] - 4 and im["top"] - cap["bottom"] < 80]
    if below:
        near = min(im["top"] for im in below)
        group = [im for im in below if im["top"] - near < 20]
        return (min(i["x0"] for i in group), min(i["top"] for i in group), max(i["x1"] for i in group), max(i["bottom"] for i in group))
    # 벡터 그림은 캡션 위로 같은 단의 본문이 끝나는 자리까지를 잡는다
    col = [l for l in text_lines if overlap_x(l["x0"], l["x1"], cap["x0"], cap["x1"]) > 0 and l["bottom"] < cap["top"] - 2]
    top = max([l["bottom"] for l in col if cap["top"] - l["bottom"] > 30] or [page.bbox[1] + 50])
    if cap["top"] - top < 30:
        return None
    return (cap["x0"], top + 2, cap["x1"], cap["top"] - 2)


ENDS = re.compile(r"[.?!:]['\")\]]?$")


def join_text(lines):
    text = ""
    for l in lines:
        t = l["text"].strip()
        if not text:
            text = t
        elif re.search(r"[A-Za-z]-$", text) and re.match(r"^[a-z]", t):
            text = text[:-1] + t
        else:
            text += " " + t
    return text


def main():
    os.makedirs(os.path.join(out_dir, "pages"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "figures"), exist_ok=True)
    os.makedirs(os.path.join(out_dir, "tables"), exist_ok=True)
    pdf = pdfplumber.open(pdf_path)
    pages, units, tables, figures = [], [], [], []
    body_sizes = []
    page_lines = []
    for page in pdf.pages:
        words = page.extract_words(x_tolerance=1.5, extra_attrs=["size", "fontname"])
        lines = cluster_lines(words)
        page_lines.append(lines)
        body_sizes += [round(l["size"], 1) for l in lines]
    body = statistics.mode(body_sizes) if body_sizes else 10.0

    pending = None  # 단이나 쪽을 넘어 이어지는 문단
    for pi, page in enumerate(pdf.pages):
        pno = pi + 1
        W, H = page.width, page.height
        mid = W / 2
        lines = [l for l in page_lines[pi] if not (l["top"] > H - 70 and re.fullmatch(r"\d{1,4}", l["text"].strip()))]
        captions = [l for l in lines if CAPTION.match(l["text"])]
        # 캡션은 이어지는 줄까지 붙인다
        cap_blocks = []
        for c in captions:
            block = [c]
            for l in sorted(lines, key=lambda l: l["top"]):
                if l is c or l["top"] <= block[-1]["top"]:
                    continue
                if overlap_x(l["x0"], l["x1"], c["x0"], c["x1"]) > 0 and l["top"] - block[-1]["bottom"] < 4 and abs(l["size"] - c["size"]) < 0.3 and not CAPTION.match(l["text"]):
                    if abs(l["size"] - body) < 0.3:
                        break
                    block.append(l)
            cap_blocks.append(block)
        regions = []
        # 캡션 단위는 본문 뒤에 붙인다. 앞 쪽에서 넘어온 문단이 먼저 이어져야 읽는 순서가 맞다
        page_units = []
        tcaps = [b for b in cap_blocks if b[0]["text"].lower().startswith("table")]
        for cap, box, ys in table_regions(page, [{**b[0], "bottom": b[-1]["bottom"]} for b in tcaps]):
            m = CAPTION.match(cap["text"])
            block = next(b for b in tcaps if b[0]["top"] == cap["top"] and b[0]["x0"] == cap["x0"])
            grid = build_table(page, box, ys)
            if not grid:
                continue
            tid = f"table-{m.group(2)}"
            if any(t["id"] == tid for t in tables):
                continue
            cells = [c for r in grid for c in r]
            # 칸이 하나뿐이거나 빈칸이 많으면 칸 경계를 잘못 읽은 표다. 뷰어는 원문 크롭을 앞에 둔다
            loose = len(grid[0]) < 2 or sum(1 for c in cells if not c) > len(cells) * 0.3
            name = f"tables/{tid}.png"
            page.crop(box).to_image(resolution=72 * CROP_SCALE).original.save(os.path.join(out_dir, name))
            tables.append({"id": tid, "number": m.group(2), "caption": join_text(block), "page": pno, "bbox": [round(v, 1) for v in box], "rows": grid, "grid": "loose" if loose else "ok", "image": name})
            page_units.append({"page": pno, "role": "caption", "ref": tid, "text": join_text(block), "rects": [{"page": pno, "bbox": [round(min(l["x0"] for l in block), 1), round(block[0]["top"], 1), round(max(l["x1"] for l in block), 1), round(block[-1]["bottom"], 1)]}, {"page": pno, "bbox": [round(v, 1) for v in box]}]})
            regions.append(box)
            regions.append((min(l["x0"] for l in block), block[0]["top"], max(l["x1"] for l in block), block[-1]["bottom"]))
        for block in cap_blocks:
            m = CAPTION.match(block[0]["text"])
            if not m.group(1).lower().startswith("fig"):
                continue
            fid = f"figure-{m.group(2)}"
            if any(f["id"] == fid for f in figures):
                continue
            cap = {**block[0], "x1": max(l["x1"] for l in block), "bottom": block[-1]["bottom"]}
            box = figure_region(page, cap, [l for l in lines if l not in block])
            capbox = (min(l["x0"] for l in block), block[0]["top"], max(l["x1"] for l in block), block[-1]["bottom"])
            regions.append(capbox)
            fig = {"id": fid, "number": m.group(2), "caption": join_text(block), "page": pno}
            rects = [{"page": pno, "bbox": [round(v, 1) for v in capbox]}]
            if box:
                regions.append(box)
                fig["bbox"] = [round(v, 1) for v in box]
                rects.append({"page": pno, "bbox": fig["bbox"]})
                img = page.crop(box).to_image(resolution=72 * CROP_SCALE).original
                name = f"figures/{fid}.png"
                img.save(os.path.join(out_dir, name))
                fig["image"] = name
            figures.append(fig)
            page_units.append({"page": pno, "role": "caption", "ref": fid, "text": join_text(block), "rects": rects})
        # 쪽 그림
        pimg = page.to_image(resolution=72 * PAGE_SCALE).original.convert("RGB")
        pname = f"pages/p{pno}.jpg"
        pimg.save(os.path.join(out_dir, pname), quality=80)
        pages.append({"n": pno, "width": round(W, 1), "height": round(H, 1), "image": pname})

        body_lines = [l for l in lines if not any(inside(l, r) for r in regions)]
        crossing = sum(1 for l in body_lines if l["x0"] < mid - 8 and l["x1"] > mid + 8)
        two_col = crossing < len(body_lines) * 0.35
        def col(l):
            if not two_col:
                return 0
            if l["x1"] <= mid + 8:
                return 1
            if l["x0"] >= mid - 8:
                return 2
            return 0
        first_col_top = min([l["top"] for l in body_lines if col(l) > 0] or [H])
        head = sorted([l for l in body_lines if col(l) == 0 and l["top"] < first_col_top], key=lambda l: l["top"])
        tail = sorted([l for l in body_lines if col(l) == 0 and l["top"] >= first_col_top], key=lambda l: l["top"])
        streams = [head] + [sorted([l for l in body_lines if col(l) == c], key=lambda l: l["top"]) for c in (1, 2)] + [tail]
        for stream in streams:
            # 아래첨자나 위첨자 줄은 글자만 흩어 놓아서 문단을 끊지 않게 미리 버린다
            stream = [l for l in stream if not (l["size"] < body - 1.2 and len(l["text"]) < 15)]
            if not stream:
                continue
            gaps = [b["top"] - a["top"] for a, b in zip(stream, stream[1:]) if 8 < b["top"] - a["top"] < 30]
            step = statistics.median(gaps) if gaps else 13.0
            left = statistics.median(l["x0"] for l in stream)
            cur = []
            for l in stream:
                if not cur:
                    # 앞 단이나 앞 쪽에서 끝나지 않은 문단을 잇는다
                    at = next((k for k in range(len(units) - 1, -1, -1) if units[k] is pending), None)
                    if at is not None and abs(l["x0"] - left) < 3 and abs(l["size"] - body) < 0.6:
                        cur = [l]
                        # 이어 붙이기는 문단을 닫을 때 한다. 사이에 캡션이 끼어 있어도 원래 자리에 붙인다
                        l["_cont"] = at
                        pending = None
                        continue
                    cur = [l]
                    continue
                prev = cur[-1]
                new_para = (
                    l["top"] - prev["top"] > step * 1.4
                    or (l["x0"] - left > 4 and ENDS.search(prev["text"].strip()) is not None)
                    or (abs(l["size"] - prev["size"]) > 0.6 and min(len(l["text"]), len(prev["text"])) >= 15)
                    or (prev["size"] > body + 0.5)
                )
                if new_para:
                    close(cur, pno, units, body)
                    cur = [l]
                else:
                    cur.append(l)
            if cur:
                last = close(cur, pno, units, body)
                pending = last if last["role"] == "para" and not ENDS.search(last["text"]) else None
        units.extend(page_units)
    # 수식 조각은 앞 문단에 붙인다. 출처 단위가 문단이라 따로 두면 번호만 늘어난다
    merged = []
    for u in units:
        letters = sum(1 for ch in u["text"] if ch.isalpha())
        frag = u["role"] == "para" and (len(u["text"]) < 30 or letters < len(u["text"]) * 0.55)
        prev = merged[-1] if merged else None
        if frag and prev is not None and prev["role"] == "para" and prev["page"] == u["page"]:
            prev["text"] = prev["text"] + " " + u["text"]
            prev["rects"] = prev["rects"] + u["rects"]
            continue
        merged.append(u)
    units[:] = merged
    for i, u in enumerate(units):
        u["i"] = i
    for t in tables:
        t["unit"] = next(u["i"] for u in units if u.get("ref") == t["id"])
    for f in figures:
        f["unit"] = next(u["i"] for u in units if u.get("ref") == f["id"])
    meta = pdf.metadata or {}
    print(json.dumps({"title": meta.get("Title") or "", "pageCount": len(pdf.pages), "pages": pages, "units": units, "tables": tables, "figures": figures}))


def close(cur, pno, units, body):
    at = cur[0].pop("_cont", None)
    text = join_text(cur)
    rect = {"page": pno, "bbox": [round(min(l["x0"] for l in cur), 1), round(cur[0]["top"], 1), round(max(l["x1"] for l in cur), 1), round(cur[-1]["bottom"], 1)]}
    if at is not None:
        cont = units[at]
        units[at] = {**cont, "text": join_text([{"text": cont["text"]}, {"text": text}]), "rects": cont["rects"] + [rect]}
        return units[at]
    heading = len(cur) == 1 and (cur[0]["bold"] or cur[0]["size"] > body + 0.5) and len(text) < 90 and not ENDS.search(text)
    units.append({"page": pno, "role": "heading" if heading else "para", "text": text, "rects": [rect]})
    return units[-1]


main()
`;
