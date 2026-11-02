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
  /** 글 자료의 문단 자리. 있으면 sec 대신 data-unit을 달아 누르면 원문 창이 그 문단을 연다 */
  unit?: (c: Cite) => { index: number; label: string };
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
    const sec = linkAttrs(p.node, opts);
    const cls = [`mm-node`, `mm-d${Math.min(p.depth, 3)}`, sec ? 'mm-cite' : '']
      .filter(Boolean)
      .join(' ');
    nodes.push(
      `<g class="${cls}"${sec}><title>${escapeXml(p.node.label)}</title><rect x="${x}" y="${p.y - BOX_H / 2}" width="${p.w}" height="${BOX_H}" rx="6"/><text x="${x + PAD_X}" y="${p.y}" dominant-baseline="central">${escapeXml(p.label)}</text></g>`,
    );
  };
  draw(tree);
  const label = escapeXml(ariaLabel ?? root.label);
  const role = svgRole(nodes.join(''));
  return `<svg class="dg-svg mm-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="${role}" aria-label="${label}"><g class="mm-edges">${edges.join('')}</g>${nodes.join('')}</svg>`;
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
  note = '',
): string {
  const link = linkAttrs(m.node, opts, note);
  const cls = ['dg-node', extra, link ? 'dg-cite' : ''].filter(Boolean).join(' ');
  // 누르는 노드가 아니어도 상태는 소리로 알린다. 그림 전체가 img일 때 안쪽 aria-label은 무시되므로 호출한 쪽이 그림 aria에도 싣는다
  const sec =
    link || !note ? link : ` role="img" aria-label="${escapeXml(`${m.node.label}, ${note}`)}"`;
  const r = (n: number) => Math.round(n * 10) / 10;
  return `<g class="${cls}"${sec}><title>${escapeXml(m.node.label)}</title><rect x="${r(x)}" y="${r(cy - BOX_H / 2)}" width="${w}" height="${BOX_H}" rx="6"/><text x="${r(x + PAD_X)}" y="${r(cy)}" dominant-baseline="central">${escapeXml(m.text)}</text></g>`;
}

// 노드는 a가 아니라서 키보드와 스크린리더가 링크로 읽게 역할과 탭 순서를 직접 단다.
// 글 자료는 시각이 다 0이라 시각 대신 문단 자리를 달아야 눌렀을 때 갈 곳이 있다
function linkAttrs(node: { label: string; cite?: Cite }, opts: SvgOptions, note = ''): string {
  if (!node.cite) return '';
  const link = ' role="link" tabindex="0"';
  const tail = note ? `, ${note}` : '';
  if (opts.unit) {
    const u = opts.unit(node.cite);
    return ` data-unit="${u.index}"${link} aria-label="${escapeXml(`${node.label}, 원문 ${u.label} 열기${tail}`)}"`;
  }
  if (!opts.sec) return '';
  const sec = opts.sec(node.cite);
  const s = Math.max(0, Math.floor(sec));
  const at = `${Math.floor(s / 60)}분 ${s % 60}초`;
  return ` data-sec="${Math.max(0, sec)}"${link} aria-label="${escapeXml(`${node.label}, ${at}로 이동${tail}`)}"`;
}

// role="img"면 안쪽 노드가 보조기기에 안 보인다. 누를 노드가 있을 때만 group으로 연다
const svgRole = (body: string) => (/ data-(sec|unit)="/.test(body) ? 'group' : 'img');

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

/** 뷰어가 노드를 띄우는 간격. render-html.ts CSS의 --dg-step 기본값과 맞춘다 */
const STEP_SEC = 0.28;
/** 등장 번호가 이보다 많으면 간격을 줄인다. 노드가 스무 개 넘는 비교표는 0.28초씩이면 다 뜨기까지 8초 가까이 기다린다 */
const STEP_MAX = 16;

const SEQ_TAG =
  /<g class="dg-(?:node|stat-value)\b[^>]*>.*?<\/g>|<path d="[^"]*"[^>]*\/>|<(?:path|circle|rect|g) class="dg-(arrow|dot|cell|spark)"[^>]*>/gs;

const withAttrs = (tag: string, attrs: string) => tag.replace(/(\/?)>$/, `${attrs}$1>`);

/**
 * 그린 순서대로 등장 번호(--i)를 단다. 뷰어 CSS가 이 번호로 animation-delay를 정한다.
 * 노드는 바깥 g로 감싸 번호를 단다. 노드 여는 태그의 클래스와 속성 순서를 그대로 대조하는 테스트가 있어서다.
 * 선은 dg-line 클래스와 pathLength="1"을 달아 길이와 상관없이 같은 시간에 그려지게 한다.
 * 선택자는 path[pathLength] 속성이 아니라 클래스로 건다. 크롬이 SVG 대소문자 속성 선택자를 조상 클래스가 바뀔 때 다시 계산하지 않아 선이 안 그려졌다.
 * 화살촉은 바로 앞 선과, 점과 칸, 장식은 바로 뒤 노드와 같은 번호를 받아 따로 차례를 기다리지 않는다
 */
function sequence(body: string): { body: string; steps: number } {
  let next = 0;
  let line = 0;
  const out = body.replace(SEQ_TAG, (tag: string, deco?: string) => {
    if (tag.startsWith('<g class="dg-node') || tag.startsWith('<g class="dg-stat-value')) {
      return `<g class="dg-step" style="--i:${next++}">${tag}</g>`;
    }
    if (deco === undefined) {
      line = next++;
      return withAttrs(tag, ` class="dg-line" pathLength="1" style="--i:${line}"`);
    }
    return withAttrs(tag, ` style="--i:${deco === 'arrow' ? line : next}"`);
  });
  return { body: out, steps: next };
}

/** vars는 뷰어 CSS가 읽는 사용자 정의 속성이다. 등장 간격 조절과 같은 style 속성에 합쳐 싣는다 */
const wrapSvg = (
  kind: string,
  width: number,
  height: number,
  body: string,
  aria: string,
  vars: string[] = [],
) => {
  const seq = sequence(body);
  const pace =
    seq.steps > STEP_MAX
      ? [`--dg-step:${Math.round(((STEP_SEC * STEP_MAX) / seq.steps) * 1000)}ms`]
      : [];
  const style = [...pace, ...vars].join(';');
  return `<svg class="dg-svg dg-${kind}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="${svgRole(body)}" aria-label="${escapeXml(aria)}"${style ? ` style="${style}"` : ''}>${seq.body}</svg>`;
};

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
  // 상자 다음에 그 상자에서 나가는 호를 둬야 뷰어가 상자를 띄운 뒤 호를 그린다
  const body = nodes.map((node, i) => node + edges[i]!).join('');
  return wrapSvg('cycle', width, height, body, ariaLabel);
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

/** 상자 없는 글자. 잘렸으면 전체를 title 툴팁으로 단다 */
function plainText(
  text: string,
  x: number,
  y: number,
  cls: string,
  anchor: 'start' | 'middle' | 'end',
  maxPx = LABEL_MAX,
): string {
  const fit = fitLabel(text, maxPx);
  const r = (n: number) => Math.round(n * 10) / 10;
  const tip = fit.cut ? `<title>${escapeXml(text)}</title>` : '';
  return `<g class="${cls}">${tip}<text x="${r(x)}" y="${r(y)}" text-anchor="${anchor}" dominant-baseline="central">${escapeXml(fit.text)}</text></g>`;
}

const plainWidth = (text: string, maxPx = LABEL_MAX) =>
  Math.ceil(textWidth(fitLabel(text, maxPx).text));

/** 화살촉까지 그린 직선 */
function arrowLine(x1: number, y1: number, x2: number, y2: number): string {
  const f = (n: number) => Math.round(n * 10) / 10;
  return `<path d="M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}"/>${arrowHead(x2, y2, Math.atan2(y2 - y1, x2 - x1))}`;
}

export interface TimelineEvent extends DiagramNode {
  when: string;
}

/** 시점 글자는 WHEN_MAX(px) 폭까지 그리고 넘으면 말줄임으로 자른다. 줄 위 글자가 이웃 칸으로 넘어가면 어느 점의 시점인지 안 읽힌다 */
export const WHEN_MAX = 120;

/**
 * 타임라인. 넷까지는 가로 줄 위에 시점, 아래에 상자를 두고 그보다 많으면 세로 줄 오른쪽에 시점과 상자를 둔다.
 * 줄 끝 화살촉이 시간 방향이다
 */
export function timelineSvg(
  events: TimelineEvent[],
  opts: SvgOptions = {},
  ariaLabel = '타임라인',
): string {
  const ms = events.map((e) => measure(e));
  const parts: string[] = [];
  if (ms.length <= FLOW_ROW_MAX) {
    const w = Math.max(...ms.map((m) => m.w), ...events.map((e) => plainWidth(e.when, WHEN_MAX)));
    const COL_GAP = 20;
    const whenY = MARGIN + 8;
    const lineY = whenY + 18;
    const boxCy = lineY + 14 + BOX_H / 2;
    const cx = (i: number) => MARGIN + i * (w + COL_GAP) + w / 2;
    const last = cx(ms.length - 1);
    parts.push(`<path d="M${MARGIN} ${lineY}H${last + w / 2 - 2}"/>`);
    parts.push(arrowHead(last + w / 2, lineY, 0));
    ms.forEach((m, i) => {
      const x = cx(i);
      parts.push(plainText(events[i]!.when, x, whenY, 'dg-when', 'middle', WHEN_MAX));
      parts.push(`<circle class="dg-dot" cx="${x}" cy="${lineY}" r="4"/>`);
      parts.push(nodeSvg(m, x - w / 2, boxCy, w, opts));
    });
    const width = MARGIN * 2 + ms.length * w + (ms.length - 1) * COL_GAP;
    return wrapSvg('timeline', width, boxCy + BOX_H / 2 + MARGIN, parts.join(''), ariaLabel);
  }
  const lineX = MARGIN + 4;
  const whenX = lineX + 14;
  const whenW = Math.max(...events.map((e) => plainWidth(e.when, WHEN_MAX)));
  const boxX = whenX + whenW + 12;
  const w = Math.max(...ms.map((m) => m.w));
  const STEP = BOX_H + 12;
  const cy = (i: number) => MARGIN + BOX_H / 2 + i * STEP;
  const lastY = cy(ms.length - 1);
  parts.push(`<path d="M${lineX} ${MARGIN}V${lastY + BOX_H / 2 - 2}"/>`);
  parts.push(arrowHead(lineX, lastY + BOX_H / 2, Math.PI / 2));
  ms.forEach((m, i) => {
    const y = cy(i);
    parts.push(`<circle class="dg-dot" cx="${lineX}" cy="${y}" r="4"/>`);
    parts.push(plainText(events[i]!.when, whenX, y, 'dg-when', 'start', WHEN_MAX));
    parts.push(nodeSvg(m, boxX, y, w, opts));
  });
  return wrapSvg(
    'timeline',
    boxX + w + MARGIN,
    lastY + BOX_H / 2 + MARGIN,
    parts.join(''),
    ariaLabel,
  );
}

export interface MatrixAxis {
  low: string;
  high: string;
}

/**
 * 2×2 매트릭스. cells는 왼쪽 위, 오른쪽 위, 왼쪽 아래, 오른쪽 아래 순서다.
 * 세로축은 아래에서 위로, 가로축은 왼쪽에서 오른쪽으로 커진다
 */
export function matrixSvg(
  x: MatrixAxis,
  y: MatrixAxis,
  cells: DiagramNode[][],
  opts: SvgOptions = {},
  ariaLabel = '매트릭스',
): string {
  const CELL_PAD = 8;
  const CELL_GAP = 6;
  const AXIS_MAX = 120;
  const ms = cells.map((c) => c.map((n) => measure(n)));
  const cw = Math.max(120, ...ms.flat().map((m) => m.w + CELL_PAD * 2));
  const rows = Math.max(1, ...ms.map((c) => c.length));
  const ch = rows * ROW + CELL_PAD * 2 - (ROW - BOX_H);
  const yW = Math.max(plainWidth(y.low, AXIS_MAX), plainWidth(y.high, AXIS_MAX));
  const gridX = MARGIN + yW + 18;
  const gridY = MARGIN + 8;
  const gridR = gridX + cw * 2 + CELL_GAP;
  const gridB = gridY + ch * 2 + CELL_GAP;
  const parts: string[] = [];
  parts.push(arrowLine(gridX - 8, gridB, gridX - 8, gridY - 6));
  parts.push(arrowLine(gridX, gridB + 8, gridR + 6, gridB + 8));
  ms.forEach((cell, c) => {
    const cx = gridX + (c % 2) * (cw + CELL_GAP);
    const cy = gridY + Math.floor(c / 2) * (ch + CELL_GAP);
    parts.push(`<rect class="dg-cell" x="${cx}" y="${cy}" width="${cw}" height="${ch}" rx="8"/>`);
    cell.forEach((m, k) => {
      parts.push(
        nodeSvg(m, cx + CELL_PAD, cy + CELL_PAD + BOX_H / 2 + k * ROW, cw - CELL_PAD * 2, opts),
      );
    });
  });
  parts.push(plainText(y.high, gridX - 16, gridY + ch / 2, 'dg-axis', 'end', AXIS_MAX));
  parts.push(plainText(y.low, gridX - 16, gridY + ch * 1.5 + CELL_GAP, 'dg-axis', 'end', AXIS_MAX));
  const labelY = gridB + 24;
  parts.push(plainText(x.low, gridX + cw / 2, labelY, 'dg-axis', 'middle', AXIS_MAX));
  parts.push(plainText(x.high, gridX + cw * 1.5 + CELL_GAP, labelY, 'dg-axis', 'middle', AXIS_MAX));
  const width = Math.ceil(Math.max(gridR + 6, gridX + cw * 1.5 + CELL_GAP + AXIS_MAX / 2) + MARGIN);
  return wrapSvg('matrix', width, labelY + 8 + MARGIN, parts.join(''), ariaLabel);
}

/**
 * 원인과 결과. 왼쪽 원인들이 가운데 현상으로 모이고 오른쪽 결과로 퍼진다.
 * 아무 노드나 잇는 그래프는 받지 않는다. 자동 배치가 어렵고 선이 엉켜서다
 */
export function causalSvg(
  inputs: DiagramNode[],
  center: DiagramNode,
  outputs: DiagramNode[],
  opts: SvgOptions = {},
  ariaLabel = '인과도',
): string {
  const GAP_C = 56;
  const ins = inputs.map((n) => measure(n));
  const outs = outputs.map((n) => measure(n));
  const mid = measure(center, ROOT_FONT);
  const rows = Math.max(1, ins.length, outs.length);
  const height = MARGIN * 2 + rows * ROW - (ROW - BOX_H);
  const cy = height / 2;
  const colY = (k: number, n: number) => cy + (k - (n - 1) / 2) * ROW;
  const wi = ins.length ? Math.max(...ins.map((m) => m.w)) : 0;
  const wo = outs.length ? Math.max(...outs.map((m) => m.w)) : 0;
  const xc = MARGIN + (ins.length ? wi + GAP_C : 0);
  const xo = xc + mid.w + GAP_C;
  // 뷰어가 그린 순서대로 띄우므로 원인, 모이는 선, 현상, 퍼지는 선, 결과 순으로 둔다
  const parts: string[] = [];
  ins.forEach((m, k) => {
    const y = colY(k, ins.length);
    parts.push(nodeSvg(m, MARGIN, y, wi, opts));
    parts.push(arrowLine(MARGIN + wi + 3, y, xc - 4, cy + (y - cy) * 0.25));
  });
  parts.push(nodeSvg(mid, xc, cy, mid.w, opts, 'dg-head'));
  outs.forEach((m, k) => {
    const y = colY(k, outs.length);
    parts.push(arrowLine(xc + mid.w + 3, cy + (y - cy) * 0.25, xo - 4, y));
    parts.push(nodeSvg(m, xo, y, wo, opts));
  });
  const width = (outs.length ? xo + wo : xc + mid.w) + MARGIN;
  return wrapSvg('causal', Math.ceil(width), Math.ceil(height), parts.join(''), ariaLabel);
}

export interface BeforeAfterSide {
  title?: string;
  items: DiagramNode[];
}

/** 전후 비교. compare와 달리 두 칸 사이에 화살표를 그려 무엇이 바뀌었는지를 보인다 */
export function beforeAfterSvg(
  before: BeforeAfterSide,
  after: BeforeAfterSide,
  opts: SvgOptions = {},
  ariaLabel = '전후 비교',
): string {
  const GAP_A = 48;
  const col = (side: BeforeAfterSide, fallback: string) => {
    const head = measure({ label: side.title ?? fallback }, ROOT_FONT);
    const items = side.items.map((n) => measure(n));
    return { head, items, w: Math.max(head.w, ...items.map((m) => m.w)) };
  };
  const a = col(before, '전');
  const b = col(after, '후');
  const rows = Math.max(a.items.length, b.items.length);
  const parts: string[] = [];
  const draw = (c: ReturnType<typeof col>, x: number) => {
    parts.push(nodeSvg(c.head, x, MARGIN + BOX_H / 2, c.w, {}, 'dg-head'));
    c.items.forEach((m, k) =>
      parts.push(nodeSvg(m, x, MARGIN + (k + 1) * ROW + BOX_H / 2, c.w, opts)),
    );
  };
  const xb = MARGIN + a.w + GAP_A;
  const ay = MARGIN + BOX_H / 2 + (rows * ROW) / 2;
  draw(a, MARGIN);
  parts.push(arrowLine(MARGIN + a.w + 8, ay, xb - 8, ay));
  draw(b, xb);
  const height = MARGIN * 2 + rows * ROW + BOX_H;
  return wrapSvg('before-after', xb + b.w + MARGIN, height, parts.join(''), ariaLabel);
}

export interface HubSatellite extends DiagramNode {
  focus?: boolean;
}

/**
 * 허브. 가운데 중심 상자에서 위성 상자로 선이 퍼진다. causal은 세로 한 줄이라 위성이 많으면 그림이 길어져서 따로 둔다.
 * 위성은 12시부터 시계 방향으로 타원 위에 놓고 서로와 중심에 겹치지 않을 때까지 반지름을 키운다
 */
export function hubSvg(
  center: DiagramNode,
  satellites: HubSatellite[],
  opts: SvgOptions = {},
  ariaLabel = '허브',
): string {
  const mid = measure(center, ROOT_FONT);
  const ms = satellites.map((s) => measure(s));
  const n = ms.length;
  const angle = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  // 상자가 가로로 길어서 타원도 가로로 늘린다
  const KX = 1.6;
  // 중심과 위성 사이 선이 이보다 짧으면 둘이 이어진 게 안 보인다
  const LINE_GAP = 22;
  const hub: Rect = { x: -mid.w / 2, y: -BOX_H / 2, w: mid.w, h: BOX_H };
  const layout = (r: number): Rect[] =>
    ms.map((m, i) => ({
      x: KX * r * Math.cos(angle(i)) - m.w / 2,
      y: r * Math.sin(angle(i)) - BOX_H / 2,
      w: m.w,
      h: BOX_H,
    }));
  let r = 40;
  let rects = layout(r);
  while (
    rects.some(
      (a, i) => overlaps(a, hub, LINE_GAP) || rects.some((b, j) => j > i && overlaps(a, b, 12)),
    )
  ) {
    r += 6;
    rects = layout(r);
  }
  const corners = [hub, ...rects].flatMap((b) => [
    { x: b.x, y: b.y },
    { x: b.x + b.w, y: b.y + b.h },
  ]);
  const dx = MARGIN - Math.min(...corners.map((p) => p.x));
  const dy = MARGIN - Math.min(...corners.map((p) => p.y));
  const f = (v: number) => Math.round(v * 10) / 10;
  // 중심에서 위성 가운데로 가는 직선 가운데 두 상자 밖에 놓이는 구간만 그린다
  const spoke = (to: Rect): string => {
    const tx = to.x + to.w / 2;
    const ty = to.y + to.h / 2;
    const STEPS = 48;
    const pts: { x: number; y: number }[] = [];
    for (let k = 0; k <= STEPS; k++) {
      const p = { x: (tx * k) / STEPS, y: (ty * k) / STEPS };
      if (!inside(hub, p.x, p.y, 4) && !inside(to, p.x, p.y, 4)) pts.push(p);
    }
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    return `<path d="M${f(a.x + dx)} ${f(a.y + dy)}L${f(b.x + dx)} ${f(b.y + dy)}" aria-hidden="true"/>`;
  };
  const parts = [nodeSvg(mid, hub.x + dx, dy, mid.w, opts, 'dg-head')];
  ms.forEach((m, i) => {
    const b = rects[i]!;
    parts.push(spoke(b));
    parts.push(
      nodeSvg(m, b.x + dx, b.y + dy + BOX_H / 2, m.w, opts, satellites[i]!.focus ? 'dg-focus' : ''),
    );
  });
  const width = Math.ceil(Math.max(...corners.map((p) => p.x)) + dx + MARGIN);
  const height = Math.ceil(Math.max(...corners.map((p) => p.y)) + dy + MARGIN);
  return wrapSvg('hub', width, height, parts.join(''), ariaLabel);
}

const STAT_FONT = 40;
/** 큰 숫자가 이보다 넓으면 말줄임한다. lint가 길이를 먼저 경고한다 */
const STAT_MAX = 360;
/** 숫자 왼쪽에 흩뿌리는 장식 점. 오른쪽은 거울로 뒤집어 쓴다. [숫자 끝에서 떨어진 거리, 세로 위치, 반지름] */
const SPARKS: readonly (readonly [number, number, number])[] = [
  [10, -12, 2.6],
  [20, 3, 1.8],
  [9, 14, 2.2],
];
const SPARK_W = 26;

/**
 * 핵심 수치. 큰 숫자 하나와 그 아래 설명 상자다. value는 받은 글자를 그대로 그린다.
 * 출처는 설명 상자에 달아 다른 도식 노드처럼 누르면 그 자리로 간다
 */
export function statSvg(
  value: string,
  label: DiagramNode,
  opts: SvgOptions = {},
  ariaLabel = '핵심 수치',
): string {
  const fit = fitLabel(value, STAT_MAX, STAT_FONT);
  const vw = Math.ceil(textWidth(fit.text, STAT_FONT));
  const lab = measure(label);
  const width = MARGIN * 2 + Math.max(vw + SPARK_W * 2, lab.w);
  const cx = width / 2;
  const valueY = MARGIN + STAT_FONT / 2 + 4;
  const labelCy = valueY + STAT_FONT / 2 + 12 + BOX_H / 2;
  const f = (v: number) => Math.round(v * 10) / 10;
  const sparks = SPARKS.flatMap(([gap, y, r]) => [
    `<circle cx="${f(cx - vw / 2 - gap)}" cy="${f(valueY + y)}" r="${r}"/>`,
    `<circle cx="${f(cx + vw / 2 + gap)}" cy="${f(valueY - y)}" r="${r}"/>`,
  ]).join('');
  const tip = fit.cut ? `<title>${escapeXml(value)}</title>` : '';
  const parts = [
    `<g class="dg-spark" aria-hidden="true">${sparks}</g>`,
    `<g class="dg-stat-value">${tip}<text x="${f(cx)}" y="${f(valueY)}" text-anchor="middle" dominant-baseline="central">${escapeXml(fit.text)}</text></g>`,
    nodeSvg(lab, cx - lab.w / 2, labelCy, lab.w, opts, 'dg-stat-label'),
  ];
  const height = Math.ceil(labelCy + BOX_H / 2 + MARGIN);
  return wrapSvg('stat', Math.ceil(width), height, parts.join(''), ariaLabel);
}

export interface PickCell extends DiagramNode {
  picked?: boolean;
}

/** 칸 수로 열 수를 정한다. 모델은 열을 모른다. 칸이 적으면 정사각에 가깝게 놓고 많아도 네 열을 넘기지 않아 옆으로 길어지지 않는다 */
export function pickGridColumns(n: number): number {
  if (n <= 4) return 2;
  if (n <= 6) return 3;
  if (n <= 8) return 4;
  if (n === 9) return 3;
  return 4;
}

const PICK_GAP_X = 14;
const PICK_GAP_Y = 14;
/** 선택 표식(체크)이 들어갈 칸 오른쪽 여백 */
const PICK_CHECK_W = 16;
const PICK_LABEL = '선택됨';
const SCAN_W = 3;
const SCAN_PAD = 6;

/**
 * 격자에서 일부만 고르는 그림. 모든 칸을 같은 크기로 놓고 picked 칸은 굵은 테두리와 체크로 강조하고 나머지는 흐리게 한다.
 * 색만으로 가르지 않으려고 체크 표식과 aria-label의 "선택됨"을 더한다.
 * 스캔 줄은 장식이다. 뷰어가 칸이 다 뜬 뒤 왼쪽에서 오른쪽으로 한 번 훑게 한다. 그 시점은 칸 수(--n)로 계산한다
 */
export function pickGridSvg(
  cells: PickCell[],
  opts: SvgOptions = {},
  ariaLabel = '격자 고르기',
): string {
  const ms = cells.map((c) => measure(c));
  const cols = pickGridColumns(cells.length);
  const rows = Math.ceil(cells.length / cols);
  const cw = Math.max(...ms.map((m) => m.w)) + PICK_CHECK_W;
  const f = (v: number) => Math.round(v * 10) / 10;
  const parts = ms.map((m, i) => {
    const x = MARGIN + (i % cols) * (cw + PICK_GAP_X);
    const cy = MARGIN + BOX_H / 2 + Math.floor(i / cols) * (BOX_H + PICK_GAP_Y);
    if (!cells[i]!.picked) return nodeSvg(m, x, cy, cw, opts, 'dg-dim');
    const kx = x + cw - PICK_CHECK_W + 2;
    const check = `<path class="dg-check" d="M${f(kx)} ${f(cy)}L${f(kx + 4)} ${f(cy + 4)}L${f(kx + 11)} ${f(cy - 4)}" aria-hidden="true"/>`;
    return nodeSvg(m, x, cy, cw, opts, 'dg-picked', PICK_LABEL).replace(/<\/g>$/, `${check}</g>`);
  });
  const gridW = cols * cw + (cols - 1) * PICK_GAP_X;
  const gridH = rows * BOX_H + (rows - 1) * PICK_GAP_Y;
  parts.push(
    `<rect class="dg-scan" x="${MARGIN - SCAN_PAD}" y="${MARGIN - SCAN_PAD}" width="${SCAN_W}" height="${gridH + SCAN_PAD * 2}" rx="1.5" style="--w:${gridW + SCAN_PAD * 2 - SCAN_W}px" aria-hidden="true"/>`,
  );
  const width = Math.ceil(gridW + MARGIN * 2);
  const height = Math.ceil(gridH + MARGIN * 2);
  return wrapSvg('pick-grid', width, height, parts.join(''), ariaLabel, [`--n:${cells.length}`]);
}
