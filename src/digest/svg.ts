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
