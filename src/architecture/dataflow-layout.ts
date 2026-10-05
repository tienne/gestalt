import { measureNode, textUnits } from './layout.js';
import {
  chipTextOverride,
  displayKindOf,
  type ArchitectureNode,
  type ArchitectureProjection,
} from './types.js';

// dataflow는 데이터가 왼쪽에서 오른쪽으로 옮겨 간다. 열은 출발점에서 몇 번 건너왔는지다
const MIN_GAP = 96;
const LABEL_PAD = 40;
const LABEL_CHAR = 7;
const ROW_GAP = 28;
const PARALLEL = 18;
const BACK_DROP = 44;
const BACK_STEP = 18;
const SELF_DROP = 34;
const SELF_SPAN = 32;
const ARROW = 8;
const TAIL = 24;

export interface DataflowCard {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DataflowEdge {
  id: string;
  /** SVG path d */
  d: string;
  /** 화살촉 세 점. 끝점, 왼쪽 날개, 오른쪽 날개 */
  tip: [string, string, string];
  labelX: number;
  labelY: number;
}

export interface DataflowLayout {
  width: number;
  height: number;
  cards: DataflowCard[];
  edges: DataflowEdge[];
}

type Pt = [number, number];

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function pt(p: Pt): string {
  return `${round2(p[0])} ${round2(p[1])}`;
}

/** x가 한 방향으로만 늘어나는 3차 베지어에서 주어진 x의 y. 이분법이라 같은 입력이면 같은 값이다 */
function bezierYAt(p0: Pt, c1: Pt, c2: Pt, p3: Pt, x: number): number {
  const at = (t: number, i: 0 | 1): number => {
    const u = 1 - t;
    return u * u * u * p0[i] + 3 * u * u * t * c1[i] + 3 * u * t * t * c2[i] + t * t * t * p3[i];
  };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid, 0) < x) lo = mid;
    else hi = mid;
  }
  return at((lo + hi) / 2, 1);
}

/** 끝 접선 방향으로 화살촉을 세운다. 뒤로 가는 선은 아래에서 올라와 닿으므로 방향을 계산으로 구한다 */
function tipOf(from: Pt, to: Pt): [string, string, string] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = to[0] - ux * ARROW;
  const by = to[1] - uy * ARROW;
  const wing = (s: number): string =>
    `${round2(bx - uy * (ARROW / 2) * s)},${round2(by + ux * (ARROW / 2) * s)}`;
  return [`${round2(to[0])},${round2(to[1])}`, wing(1), wing(-1)];
}

/**
 * 그릴 메시지만 받아 좌표를 정한다. 같은 입력이면 같은 좌표가 나온다.
 * 열은 되돌아가는 선을 뺀 뒤 가장 긴 경로로 정한다. 같은 열 안 순서는 participants, 없으면 처음 나온 순서다
 */
export function computeDataflowLayout(
  projection: ArchitectureProjection,
  drawn: ReadonlySet<string>,
  nodeById: ReadonlyMap<string, ArchitectureNode>,
): DataflowLayout {
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

  // 되돌아가는 선 찾기. 순서대로 깊이 우선으로 돌며 스택 위 노드로 가는 선을 뒤로 가는 선으로 본다
  const out = new Map<string, string[]>(order.map((id) => [id, []]));
  for (const m of messages) {
    if (m.from !== m.to && !out.get(m.from)!.includes(m.to)) out.get(m.from)!.push(m.to);
  }
  const back = new Set<string>();
  const state = new Map<string, 'open' | 'done'>();
  const visit = (id: string): void => {
    state.set(id, 'open');
    for (const to of out.get(id)!) {
      const s = state.get(to);
      if (s === 'open') back.add(`${id}\u0000${to}`);
      else if (s === undefined) visit(to);
    }
    state.set(id, 'done');
  };
  for (const id of order) if (!state.has(id)) visit(id);

  const rank = new Map(order.map((id) => [id, 0]));
  // 앞으로 가는 선만 남기면 순환이 없다. 노드 수만큼 돌면 가장 긴 경로가 정해진다
  for (let pass = 0; pass < order.length; pass++) {
    let changed = false;
    for (const id of order) {
      for (const to of out.get(id)!) {
        if (back.has(`${id}\u0000${to}`)) continue;
        const r = rank.get(id)! + 1;
        if (r > rank.get(to)!) {
          rank.set(to, r);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const sizes = new Map(
    order.map((id) => {
      const n = nodeById.get(id)!;
      const chip = chipTextOverride(n);
      return [
        id,
        measureNode(n.label, n.displayName, n.displayNameInferred, displayKindOf(n), {
          ...(chip !== undefined ? { chip } : {}),
          ...(n.description !== undefined ? { description: n.description } : {}),
        }),
      ] as const;
    }),
  );
  const maxRank = Math.max(0, ...rank.values());
  const columns: string[][] = Array.from({ length: maxRank + 1 }, () => []);
  for (const id of order) columns[rank.get(id)!]!.push(id);

  const colWidth = columns.map((ids) => Math.max(0, ...ids.map((id) => sizes.get(id)!.width)));
  // 열을 건너뛰는 선도 라벨은 출발 열 바로 뒤 틈에 앉으므로 그 틈 너비에 같이 센다
  const gapAfter = columns.slice(0, -1).map((_, r) => {
    const label = messages
      .filter((m) => rank.get(m.from) === r && rank.get(m.to)! > r)
      .reduce((w, m) => Math.max(w, textUnits(m.label) * LABEL_CHAR), 0);
    return Math.max(MIN_GAP, label + LABEL_PAD);
  });
  const colX: number[] = [];
  columns.forEach((_, r) => {
    colX.push(r === 0 ? 0 : colX[r - 1]! + colWidth[r - 1]! + gapAfter[r - 1]!);
  });
  const colHeight = columns.map(
    (ids) =>
      ids.reduce((h, id) => h + sizes.get(id)!.height, 0) + Math.max(0, ids.length - 1) * ROW_GAP,
  );
  const tallest = Math.max(0, ...colHeight);
  const box = new Map<string, DataflowCard>();
  columns.forEach((ids, r) => {
    let y = (tallest - colHeight[r]!) / 2;
    for (const id of ids) {
      const s = sizes.get(id)!;
      box.set(id, {
        id,
        x: round2(colX[r]! + (colWidth[r]! - s.width) / 2),
        y: round2(y),
        width: s.width,
        height: s.height,
      });
      y += s.height + ROW_GAP;
    }
  });

  // 같은 두 노드 사이 선이 여럿이면 끝점을 위아래로 벌린다
  const pairCount = new Map<string, number>();
  const pairSeen = new Map<string, number>();
  for (const m of messages) {
    const k = `${m.from}\u0000${m.to}`;
    pairCount.set(k, (pairCount.get(k) ?? 0) + 1);
  }
  let bottom = tallest;
  const right = Math.max(0, ...[...box.values()].map((b) => b.x + b.width));
  let backLane = 0;
  const edges: DataflowEdge[] = messages.map((m) => {
    const k = `${m.from}\u0000${m.to}`;
    const nth = pairSeen.get(k) ?? 0;
    pairSeen.set(k, nth + 1);
    const shift = (nth - (pairCount.get(k)! - 1) / 2) * PARALLEL;
    const a = box.get(m.from)!;
    const b = box.get(m.to)!;
    if (m.from === m.to) {
      // 열 사이 틈은 옆 선 라벨 자리라서 자기 자신으로 가는 선은 카드 오른쪽 아래로 돈다
      const x = a.x + a.width - 12 + shift;
      const y = a.y + a.height;
      const p0: Pt = [x - SELF_SPAN, y];
      const c1: Pt = [x - SELF_SPAN - 6, y + SELF_DROP];
      const c2: Pt = [x + 6, y + SELF_DROP];
      const p3: Pt = [x, y];
      bottom = Math.max(bottom, y + SELF_DROP + 16);
      return {
        id: m.id,
        d: `M${pt(p0)}C${pt(c1)} ${pt(c2)} ${pt(p3)}`,
        tip: tipOf(c2, p3),
        labelX: round2(x - SELF_SPAN / 2),
        labelY: round2(y + SELF_DROP + 10),
      };
    }
    if (rank.get(m.to)! > rank.get(m.from)!) {
      const p0: Pt = [a.x + a.width, a.y + a.height / 2 + shift];
      const p3: Pt = [b.x, b.y + b.height / 2 + shift];
      const c = Math.max(40, (p3[0] - p0[0]) / 2);
      const c1: Pt = [p0[0] + c, p0[1]];
      const c2: Pt = [p3[0] - c, p3[1]];
      const from = rank.get(m.from)!;
      // 가운데 열 카드 위에 라벨이 앉지 않게, 열을 건너뛰는 선은 출발 열 바로 뒤 틈에서 선 위에 단다
      const labelX =
        rank.get(m.to)! - from > 1
          ? colX[from]! + colWidth[from]! + gapAfter[from]! / 2
          : (p0[0] + p3[0]) / 2;
      return {
        id: m.id,
        d: `M${pt(p0)}C${pt(c1)} ${pt(c2)} ${pt(p3)}`,
        tip: tipOf(c2, p3),
        labelX: round2(labelX),
        labelY: round2(bezierYAt(p0, c1, c2, p3, labelX) - 5),
      };
    }
    // 되돌아가거나 같은 열로 가는 선은 카드 아래로 돌아 들어간다. 겹치지 않게 한 줄씩 더 내려간다
    const p0: Pt = [a.x + a.width / 2 + shift, a.y + a.height];
    const p3: Pt = [b.x + b.width / 2 + shift, b.y + b.height];
    const depth = Math.max(p0[1], p3[1]) + BACK_DROP + backLane * BACK_STEP;
    backLane += 1;
    const c1: Pt = [p0[0], depth];
    const c2: Pt = [p3[0], depth];
    const midY = (p0[1] + 6 * depth + p3[1]) / 8;
    bottom = Math.max(bottom, midY + 16);
    return {
      id: m.id,
      d: `M${pt(p0)}C${pt(c1)} ${pt(c2)} ${pt(p3)}`,
      tip: tipOf(c2, p3),
      labelX: round2((p0[0] + p3[0]) / 2),
      labelY: round2(midY - 6),
    };
  });

  return {
    width: round2(right),
    height: round2(bottom + TAIL),
    cards: order.map((id) => box.get(id)!),
    edges,
  };
}
