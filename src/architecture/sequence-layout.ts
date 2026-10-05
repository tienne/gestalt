import { measureNode, textUnits } from './layout.js';
import {
  chipTextOverride,
  displayKindOf,
  type ArchitectureNode,
  type ArchitectureProjection,
  type SequenceBlockKind,
} from './types.js';

// sequence는 열과 줄이 곧 의미라 elkjs를 안 쓴다. 열은 참여자, 줄은 메시지 순서다
const HEAD_GAP = 60;
const LABEL_PAD = 48;
const LABEL_CHAR = 7;
const FIRST_ROW = 40;
const ROW = 44;
const SELF_ROW = 60;
const SELF_W = 36;
const BLOCK_HEAD = 30;
const BLOCK_TAIL = 14;
const BRANCH_GAP = 24;
const BLOCK_SIDE = 64;
const TAIL = 32;

export interface SequenceHead {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SequenceMessageBox {
  id: string;
  /** 번호. 그린 메시지만 1부터 센다 */
  n: number;
  y: number;
  x1: number;
  x2: number;
  self: boolean;
}

export interface SequenceBlockBox {
  id: string;
  kind: SequenceBlockKind;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  branches: { y: number; label: string }[];
}

export interface SequenceLayout {
  width: number;
  height: number;
  heads: SequenceHead[];
  lifelines: { id: string; x: number; y1: number; y2: number }[];
  messages: SequenceMessageBox[];
  blocks: SequenceBlockBox[];
}

function labelWidth(text: string): number {
  return textUnits(text) * LABEL_CHAR;
}

/**
 * 그릴 메시지만 받아 좌표를 정한다. 같은 입력이면 같은 좌표가 나온다.
 * 참여자는 participants 순서, 없으면 메시지에 처음 나온 순서다. 그려지지 않는 노드는 뺀다.
 * whereOf가 돌려준 글자는 머리 카드 둘째 줄에 들어가므로 카드 크기에 넣어 잰다
 */
export function computeSequenceLayout(
  projection: ArchitectureProjection,
  drawn: ReadonlySet<string>,
  nodeById: ReadonlyMap<string, ArchitectureNode>,
  whereOf: (id: string) => string | undefined = () => undefined,
): SequenceLayout {
  const messages = projection.messages.filter((m) => drawn.has(m.id));
  const order: string[] = [];
  const add = (id: string): void => {
    if (!order.includes(id) && nodeById.has(id)) order.push(id);
  };
  const used = new Set(messages.flatMap((m) => [m.from, m.to]));
  for (const id of projection.participants ?? []) if (used.has(id)) add(id);
  for (const m of messages) {
    add(m.from);
    add(m.to);
  }

  const sizes = order.map((id) => {
    const n = nodeById.get(id)!;
    const chip = chipTextOverride(n);
    const where = whereOf(id);
    return measureNode(n.label, n.displayName, n.displayNameInferred, displayKindOf(n), {
      ...(chip !== undefined ? { chip } : {}),
      ...(where !== undefined ? { secondLine: where } : {}),
    });
  });
  const col = new Map(order.map((id, i) => [id, i]));
  // 이웃한 두 열 사이 거리는 두 카드 반폭 합과 그 사이만 잇는 메시지 글자 폭 중 큰 쪽이다
  const gaps = order.slice(1).map((_, i) => {
    const base = (sizes[i]!.width + sizes[i + 1]!.width) / 2 + HEAD_GAP;
    const label = messages
      .filter((m) => {
        const a = col.get(m.from)!;
        const b = col.get(m.to)!;
        return Math.min(a, b) === i && Math.max(a, b) === i + 1;
      })
      .reduce((w, m) => Math.max(w, labelWidth(`${messages.indexOf(m) + 1}. ${m.label}`)), 0);
    return Math.max(base, label + LABEL_PAD);
  });
  const centers: number[] = [];
  order.forEach((_, i) => {
    centers.push(i === 0 ? sizes[0]!.width / 2 : centers[i - 1]! + gaps[i - 1]!);
  });
  const headHeight = sizes.reduce((h, s) => Math.max(h, s.height), 0);
  const heads = order.map((id, i) => ({
    id,
    x: round2(centers[i]! - sizes[i]!.width / 2),
    y: 0,
    width: sizes[i]!.width,
    height: sizes[i]!.height,
  }));

  const blockById = new Map((projection.blocks ?? []).map((b) => [b.id, b]));
  const out: SequenceMessageBox[] = [];
  const blocks: SequenceBlockBox[] = [];
  let y = headHeight + FIRST_ROW;
  let open: SequenceBlockBox | undefined;
  let openBranch: string | undefined;
  let span: [number, number] = [0, 0];
  const closeBlock = (): void => {
    if (!open) return;
    y += BLOCK_TAIL;
    open.x = round2(span[0] - BLOCK_SIDE);
    open.width = round2(span[1] - span[0] + BLOCK_SIDE * 2);
    open.height = round2(y - open.y);
    blocks.push(open);
    open = undefined;
    y += BLOCK_TAIL;
  };
  messages.forEach((m, i) => {
    const x1 = centers[col.get(m.from)!]!;
    const x2 = centers[col.get(m.to)!]!;
    const self = m.from === m.to;
    if (open && open.id !== m.block) closeBlock();
    if (!open && m.block !== undefined) {
      const b = blockById.get(m.block)!;
      open = { id: b.id, kind: b.kind, label: b.label, x: 0, y, width: 0, height: 0, branches: [] };
      openBranch = m.branch;
      span = [Math.min(x1, x2), Math.max(x1, x2)];
      y += BLOCK_HEAD;
    } else if (open && m.branch !== openBranch) {
      y += BRANCH_GAP / 2;
      open.branches.push({ y, label: m.branch ?? '' });
      y += BRANCH_GAP;
      openBranch = m.branch;
    }
    if (open) {
      span = [Math.min(span[0], x1, x2), Math.max(span[1], x1, x2 + (self ? SELF_W : 0))];
    }
    y += self ? SELF_ROW / 2 : ROW / 2;
    out.push({ id: m.id, n: i + 1, y: round2(y), x1, x2, self });
    y += self ? SELF_ROW / 2 : ROW / 2;
  });
  closeBlock();

  const last = order.length - 1;
  const right = Math.max(
    last >= 0 ? centers[last]! + sizes[last]!.width / 2 : 0,
    ...blocks.map((b) => b.x + b.width),
    ...out.filter((m) => m.self).map((m) => m.x1 + SELF_W + LABEL_PAD),
  );
  const left = Math.min(0, ...blocks.map((b) => b.x));
  const shift = -left;
  const height = round2(y + TAIL);
  return {
    width: round2(right + shift),
    height,
    heads: heads.map((h) => ({ ...h, x: round2(h.x + shift) })),
    lifelines: order.map((id, i) => ({
      id,
      x: round2(centers[i]! + shift),
      y1: sizes[i]!.height,
      y2: round2(y),
    })),
    messages: out.map((m) => ({ ...m, x1: round2(m.x1 + shift), x2: round2(m.x2 + shift) })),
    blocks: blocks.map((b) => ({ ...b, x: round2(b.x + shift) })),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
