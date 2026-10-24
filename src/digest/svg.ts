import type { Cite } from './schema.js';

/**
 * 확장 리포트와 대섹션 도식의 SVG를 그린다. 요약 층은 구조만 넘기고 좌표와 마크업은 여기서 정한다.
 * 모델이 쓴 SVG를 그대로 실으면 스크립트나 외부 링크가 섞여 들어올 수 있어서 원문은 받지 않는다.
 * 색은 CSS 변수를 쓰는 클래스로만 칠해 다크 모드를 따라간다
 */

export interface TreeNode {
  label: string;
  cite?: Cite;
  children?: TreeNode[];
}

export interface SvgOptions {
  /** cite.key 문장의 시작 시각. 있으면 노드에 data-sec을 달아 누르면 영상이 그 자리로 간다 */
  sec?: (c: Cite) => number;
}

const FONT = 13;
const ROOT_FONT = 14;
const PAD_X = 10;
const BOX_H = 26;
const ROW = 34;
const GAP = 36;
const MARGIN = 12;
/** 라벨이 이보다 넓으면 말줄임하고 전체는 title 툴팁으로 보인다 */
const LABEL_MAX = 168;

export const escapeXml = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// 폰트를 재지 않고 글자 폭을 근사한다. 한글과 한자, 전각은 1em이고 나머지는 그보다 좁다
const WIDE = /[ᄀ-ᇿ⺀-鿿가-힯豈-﫿＀-￯]/u;
function charWidth(ch: string): number {
  if (WIDE.test(ch)) return 1;
  if (ch === ' ') return 0.3;
  if (/[A-Z0-9]/.test(ch)) return 0.62;
  return 0.55;
}

export function textWidth(text: string, fontSize = FONT): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w * fontSize;
}

/** maxPx 안에 들어오게 자른다. 잘랐으면 끝에 말줄임표를 붙인다 */
export function fitLabel(
  text: string,
  maxPx = LABEL_MAX,
  fontSize = FONT,
): { text: string; cut: boolean } {
  if (textWidth(text, fontSize) <= maxPx) return { text, cut: false };
  const ell = textWidth('…', fontSize);
  let w = 0;
  let out = '';
  for (const ch of text) {
    const cw = charWidth(ch) * fontSize;
    if (w + cw + ell > maxPx) break;
    out += ch;
    w += cw;
  }
  return { text: `${out.trimEnd()}…`, cut: true };
}

interface Placed {
  node: TreeNode;
  depth: number;
  y: number;
  label: string;
  cut: boolean;
  w: number;
  children: Placed[];
}

/**
 * 왼쪽에서 오른쪽으로 펼친 트리. 잎마다 한 줄을 주고 부모는 첫 자식과 마지막 자식의 가운데에 둔다
 */
export function treeSvg(root: TreeNode, opts: SvgOptions = {}, ariaLabel?: string): string {
  let row = 0;
  const colW: number[] = [];
  const place = (node: TreeNode, depth: number): Placed => {
    const size = depth === 0 ? ROOT_FONT : FONT;
    const fit = fitLabel(node.label, LABEL_MAX, size);
    const w = Math.ceil(textWidth(fit.text, size)) + PAD_X * 2;
    colW[depth] = Math.max(colW[depth] ?? 0, w);
    const kids = (node.children ?? []).map((c) => place(c, depth + 1));
    let y: number;
    if (kids.length === 0) {
      y = MARGIN + row * ROW + ROW / 2;
      row += 1;
    } else {
      y = (kids[0]!.y + kids[kids.length - 1]!.y) / 2;
    }
    return { node, depth, y, label: fit.text, cut: fit.cut, w, children: kids };
  };
  const tree = place(root, 0);
  const colX: number[] = [];
  for (let d = 0; d < colW.length; d++) {
    colX[d] = d === 0 ? MARGIN : colX[d - 1]! + colW[d - 1]! + GAP;
  }
  const last = colW.length - 1;
  const width = Math.ceil(colX[last]! + colW[last]! + MARGIN);
  const height = Math.ceil(row * ROW + MARGIN * 2);

  const edges: string[] = [];
  const nodes: string[] = [];
  const draw = (p: Placed) => {
    const x = colX[p.depth]!;
    for (const c of p.children) {
      const x1 = x + p.w;
      const x2 = colX[c.depth]!;
      const mid = (x1 + x2) / 2;
      edges.push(`<path d="M${x1} ${p.y}C${mid} ${p.y} ${mid} ${c.y} ${x2} ${c.y}"/>`);
      draw(c);
    }
    const cls = [`mm-node`, `mm-d${Math.min(p.depth, 3)}`, p.node.cite && opts.sec ? 'mm-cite' : '']
      .filter(Boolean)
      .join(' ');
    const sec = p.node.cite && opts.sec ? ` data-sec="${Math.max(0, opts.sec(p.node.cite))}"` : '';
    nodes.push(
      `<g class="${cls}"${sec}><title>${escapeXml(p.node.label)}</title><rect x="${x}" y="${p.y - BOX_H / 2}" width="${p.w}" height="${BOX_H}" rx="6"/><text x="${x + PAD_X}" y="${p.y}" dominant-baseline="central">${escapeXml(p.label)}</text></g>`,
    );
  };
  draw(tree);
  const label = escapeXml(ariaLabel ?? root.label);
  return `<svg class="dg-svg mm-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${label}"><g class="mm-edges">${edges.join('')}</g>${nodes.join('')}</svg>`;
}

export interface DiagramNode {
  label: string;
  cite?: Cite;
}

interface Measured {
  node: DiagramNode;
  text: string;
  w: number;
}

// 대섹션 도식은 너비를 맞춘 상자가 읽기 편해서 같은 줄의 상자 폭을 가장 넓은 것에 맞춘다
const measure = (node: DiagramNode, size = FONT): Measured => {
  const fit = fitLabel(node.label, LABEL_MAX, size);
  return { node, text: fit.text, w: Math.ceil(textWidth(fit.text, size)) + PAD_X * 2 };
};

const ARROW = 30;
const ARROW_V = 22;
/** 단계가 이보다 많으면 세로로 쌓는다. 가로로 늘어놓으면 좁은 화면에서 옆으로 한참 밀어야 해서다 */
const FLOW_ROW_MAX = 4;

function nodeSvg(
  m: Measured,
  x: number,
  cy: number,
  w: number,
  opts: SvgOptions,
  extra = '',
): string {
  const cite = m.node.cite && opts.sec;
  const cls = ['dg-node', extra, cite ? 'dg-cite' : ''].filter(Boolean).join(' ');
  const sec = cite ? ` data-sec="${Math.max(0, opts.sec!(m.node.cite!))}"` : '';
  const r = (n: number) => Math.round(n * 10) / 10;
  return `<g class="${cls}"${sec}><title>${escapeXml(m.node.label)}</title><rect x="${r(x)}" y="${r(cy - BOX_H / 2)}" width="${w}" height="${BOX_H}" rx="6"/><text x="${r(x + PAD_X)}" y="${r(cy)}" dominant-baseline="central">${escapeXml(m.text)}</text></g>`;
}

/** 끝점 (x, y)에서 angle 방향을 향하는 화살촉 */
function arrowHead(x: number, y: number, angle: number): string {
  const len = 7;
  const half = 4;
  const bx = x - len * Math.cos(angle);
  const by = y - len * Math.sin(angle);
  const px = -Math.sin(angle) * half;
  const py = Math.cos(angle) * half;
  const f = (n: number) => Math.round(n * 10) / 10;
  return `<path class="dg-arrow" d="M${f(x)} ${f(y)}L${f(bx + px)} ${f(by + py)}L${f(bx - px)} ${f(by - py)}Z"/>`;
}

const wrapSvg = (kind: string, width: number, height: number, body: string, aria: string) =>
  `<svg class="dg-svg dg-${kind}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeXml(aria)}">${body}</svg>`;

/** 단계 흐름. 넷까지는 가로로, 그보다 많으면 세로로 잇는다 */
export function flowSvg(steps: DiagramNode[], opts: SvgOptions = {}, ariaLabel = '흐름도'): string {
  const ms = steps.map((s) => measure(s));
  const w = Math.max(...ms.map((m) => m.w));
  const parts: string[] = [];
  if (ms.length <= FLOW_ROW_MAX) {
    const cy = MARGIN + BOX_H / 2;
    ms.forEach((m, i) => {
      const x = MARGIN + i * (w + ARROW);
      parts.push(nodeSvg(m, x, cy, w, opts));
      if (i < ms.length - 1) {
        const x1 = x + w + 4;
        const x2 = x + w + ARROW - 4;
        parts.push(`<path d="M${x1} ${cy}H${x2}"/>`, arrowHead(x2, cy, 0));
      }
    });
    const width = MARGIN * 2 + ms.length * w + (ms.length - 1) * ARROW;
    return wrapSvg('flow', width, MARGIN * 2 + BOX_H, parts.join(''), ariaLabel);
  }
  const cx = MARGIN + w / 2;
  ms.forEach((m, i) => {
    const top = MARGIN + i * (BOX_H + ARROW_V);
    parts.push(nodeSvg(m, MARGIN, top + BOX_H / 2, w, opts));
    if (i < ms.length - 1) {
      const y1 = top + BOX_H + 3;
      const y2 = top + BOX_H + ARROW_V - 3;
      parts.push(`<path d="M${cx} ${y1}V${y2}"/>`, arrowHead(cx, y2, Math.PI / 2));
    }
  });
  const height = MARGIN * 2 + ms.length * BOX_H + (ms.length - 1) * ARROW_V;
  return wrapSvg('flow', MARGIN * 2 + w, height, parts.join(''), ariaLabel);
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const inside = (r: Rect, x: number, y: number, pad: number) =>
  x > r.x - pad && x < r.x + r.w + pad && y > r.y - pad && y < r.y + r.h + pad;

const overlaps = (a: Rect, b: Rect, gap: number) =>
  a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;

/**
 * 순환. 상자를 타원 위에 12시부터 시계 방향으로 놓고 이웃끼리 타원 호로 잇는다.
 * 상자 폭이 제각각이라 반지름은 공식으로 못 정하고 겹치지 않으면서 사이 호가 보일 때까지 키운다
 */
export function cycleSvg(
  steps: DiagramNode[],
  opts: SvgOptions = {},
  ariaLabel = '순환도',
): string {
  const ms = steps.map((s) => measure(s));
  const n = ms.length;
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  // 상자가 가로로 길어서 타원도 가로로 늘린다
  const KX = 1.6;
  // 이웃 상자 사이로 보이는 호가 이보다 짧으면 화살촉만 남아 방향이 안 읽힌다
  const MIN_ARC = 24;
  const layout = (r: number) => {
    const rects: Rect[] = ms.map((m, i) => ({
      x: KX * r * Math.cos(angle(i)) - m.w / 2,
      y: r * Math.sin(angle(i)) - BOX_H / 2,
      w: m.w,
      h: BOX_H,
    }));
    const point = (t: number) => ({ x: KX * r * Math.cos(t), y: r * Math.sin(t) });
    const arcs: { x: number; y: number }[][] = [];
    for (let i = 0; i < n; i++) {
      const from = rects[i]!;
      const to = rects[(i + 1) % n]!;
      const t0 = angle(i);
      const t1 = t0 + (2 * Math.PI) / n;
      const pts: { x: number; y: number }[] = [];
      const STEPS = 48;
      for (let k = 0; k <= STEPS; k++) {
        const p = point(t0 + ((t1 - t0) * k) / STEPS);
        if (!inside(from, p.x, p.y, 5) && !inside(to, p.x, p.y, 5)) pts.push(p);
      }
      arcs.push(pts);
    }
    return { rects, arcs };
  };
  const arcLength = (pts: { x: number; y: number }[]) =>
    pts.reduce(
      (sum, p, k) => (k === 0 ? 0 : sum + Math.hypot(p.x - pts[k - 1]!.x, p.y - pts[k - 1]!.y)),
      0,
    );
  let r = 50;
  let { rects, arcs } = layout(r);
  for (;;) {
    const clash = rects.some((a, i) => rects.some((b, j) => j > i && overlaps(a, b, 18)));
    if (!clash && arcs.every((pts) => arcLength(pts) >= MIN_ARC)) break;
    r += 6;
    ({ rects, arcs } = layout(r));
  }
  const all = [
    ...rects.flatMap((b) => [
      { x: b.x, y: b.y },
      { x: b.x + b.w, y: b.y + b.h },
    ]),
    ...arcs.flat(),
  ];
  const minX = Math.min(...all.map((p) => p.x));
  const minY = Math.min(...all.map((p) => p.y));
  const dx = MARGIN - minX;
  const dy = MARGIN - minY;
  const f = (v: number) => Math.round(v * 10) / 10;
  const edges = arcs.map((pts) => {
    const last = pts[pts.length - 1]!;
    const prev = pts[pts.length - 2]!;
    const d = pts.map((p, k) => `${k === 0 ? 'M' : 'L'}${f(p.x + dx)} ${f(p.y + dy)}`).join('');
    const head = arrowHead(last.x + dx, last.y + dy, Math.atan2(last.y - prev.y, last.x - prev.x));
    return `<path d="${d}"/>${head}`;
  });
  const nodes = ms.map((m, i) => {
    const b = rects[i]!;
    return nodeSvg(m, b.x + dx, b.y + dy + BOX_H / 2, m.w, opts);
  });
  const width = Math.ceil(Math.max(...all.map((p) => p.x)) + dx + MARGIN);
  const height = Math.ceil(Math.max(...all.map((p) => p.y)) + dy + MARGIN);
  return wrapSvg('cycle', width, height, edges.join('') + nodes.join(''), ariaLabel);
}

export interface CompareColumn {
  title: string;
  items: DiagramNode[];
}

/** 비교. 열마다 머리 상자 아래로 항목을 쌓는다 */
export function compareSvg(
  columns: CompareColumn[],
  opts: SvgOptions = {},
  ariaLabel = '비교표',
): string {
  const COL_GAP = 16;
  const parts: string[] = [];
  let x = MARGIN;
  let rows = 0;
  for (const col of columns) {
    const head = measure({ label: col.title }, ROOT_FONT);
    const items = col.items.map((it) => measure(it));
    const w = Math.max(head.w, ...items.map((m) => m.w));
    parts.push(nodeSvg(head, x, MARGIN + BOX_H / 2, w, {}, 'dg-head'));
    items.forEach((m, k) => parts.push(nodeSvg(m, x, MARGIN + (k + 1) * ROW + BOX_H / 2, w, opts)));
    rows = Math.max(rows, items.length);
    x += w + COL_GAP;
  }
  const width = Math.ceil(x - COL_GAP + MARGIN);
  const height = MARGIN * 2 + rows * ROW + BOX_H;
  return wrapSvg('compare', width, height, parts.join(''), ariaLabel);
}
