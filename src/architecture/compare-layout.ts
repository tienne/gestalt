import { measureNode, textUnits } from './layout.js';
import {
  chipTextOverride,
  displayKindOf,
  type ArchitectureNode,
  type ArchitectureProjection,
} from './types.js';

// compare는 세 열로 선다. 왼쪽 묶음에만, 둘 다, 오른쪽 묶음에만. 가운데가 겹치는 것이라 눈이 먼저 간다
const HEAD = 56;
const ROW_GAP = 20;
const COL_GAP = 56;
const COL_MIN = 180;
const COL_PAD = 20;
const HEAD_CHAR = 8;
const EMPTY_ROW = 40;
const TAIL = 24;

export type CompareColumnKey = 'left' | 'both' | 'right';

export interface CompareColumn {
  key: CompareColumnKey;
  title: string;
  count: number;
  x: number;
  width: number;
  height: number;
}

export interface CompareCard {
  id: string;
  column: CompareColumnKey;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CompareLayout {
  width: number;
  height: number;
  columns: CompareColumn[];
  cards: CompareCard[];
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** 그려지는 노드만 받아 세 열에 나눠 세운다. 열 안 순서는 묶음에 적은 순서다 */
export function computeCompareLayout(
  projection: ArchitectureProjection,
  drawable: ReadonlySet<string>,
  nodeById: ReadonlyMap<string, ArchitectureNode>,
): CompareLayout {
  const [left, right] = projection.sides!;
  const keep = (ids: readonly string[]): string[] => [
    ...new Set(ids.filter((id) => drawable.has(id) && nodeById.has(id))),
  ];
  const leftIds = keep(left!.nodes);
  const rightIds = keep(right!.nodes);
  const inRight = new Set(rightIds);
  const inLeft = new Set(leftIds);
  const groups: { key: CompareColumnKey; title: string; ids: string[] }[] = [
    { key: 'left', title: `${left!.label}에만`, ids: leftIds.filter((id) => !inRight.has(id)) },
    { key: 'both', title: '둘 다', ids: leftIds.filter((id) => inRight.has(id)) },
    { key: 'right', title: `${right!.label}에만`, ids: rightIds.filter((id) => !inLeft.has(id)) },
  ];

  const sizeOf = (id: string): { width: number; height: number } => {
    const n = nodeById.get(id)!;
    const chip = chipTextOverride(n);
    return measureNode(n.label, n.displayName, n.displayNameInferred, displayKindOf(n), {
      ...(chip !== undefined ? { chip } : {}),
      ...(n.description !== undefined ? { description: n.description } : {}),
    });
  };
  const columns: CompareColumn[] = [];
  const cards: CompareCard[] = [];
  let x = 0;
  let tallest = 0;
  for (const g of groups) {
    const sizes = g.ids.map(sizeOf);
    const width = Math.max(
      COL_MIN,
      (textUnits(g.title) + 4) * HEAD_CHAR,
      ...sizes.map((s) => s.width + COL_PAD * 2),
    );
    let y = HEAD;
    g.ids.forEach((id, i) => {
      const s = sizes[i]!;
      cards.push({
        id,
        column: g.key,
        x: round2(x + (width - s.width) / 2),
        y,
        width: s.width,
        height: s.height,
      });
      y += s.height + ROW_GAP;
    });
    const height = g.ids.length > 0 ? y - ROW_GAP + COL_PAD : HEAD + EMPTY_ROW;
    tallest = Math.max(tallest, height);
    columns.push({ key: g.key, title: g.title, count: g.ids.length, x: round2(x), width, height });
    x += width + COL_GAP;
  }
  // 열 배경은 가장 긴 열에 맞춰 같은 높이로 그린다. 짧은 열이 비어 보이는 게 곧 차이다
  for (const c of columns) c.height = round2(tallest);
  return {
    width: round2(x - COL_GAP),
    height: round2(tallest + TAIL),
    columns,
    cards,
  };
}
