// 좌표 규칙은 stack-diagram geometry.md를 따른다. 노드는 타일 60x60과 그 아래 글자를 합친 132x100 상자다
export const INFRA_NODE_W = 132;
export const INFRA_NODE_H = 100;
export const INFRA_TILE = 60;
const NODE_HALF = INFRA_NODE_W / 2;
const TILE_HALF = INFRA_TILE / 2;
// 선 끝과 타일 사이 틈. 화살촉이 이 틈을 메운다
const PORT_GAP = 4;
// 꺾임 하나를 이 길이만큼 돌아가는 것으로 친다. 짧지만 지그재그인 길보다 한 번 꺾는 길을 고르게 한다
const BEND_COST = 40;
// 노드 상자 바깥으로 지나가는 세로 통로. 글자 상자(±66)에 장애물 여유 4를 더하고 그만큼 더 띄운다
const SIDE_CORRIDOR = NODE_HALF + 12;
// 타일 아래 글자 상자 밑과 다음 행 사이 빈 띠
const BELOW_BAND = INFRA_NODE_H + 25;
const ABOVE_BAND = 20;
// 선 글자 상자 어림. 글자가 두세 자라 폭을 고정한다
const EDGE_LABEL_HALF_W = 18;
const LABEL_SHIFT = 20;

export interface Pt {
  x: number;
  y: number;
}
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** 라우터가 보는 타일 자리. x, y는 132x100 노드 상자의 왼쪽 위, cx는 가운데 */
export interface RouteTile {
  x: number;
  y: number;
  cx: number;
}

export interface LabelSpot {
  x: number;
  y: number;
  anchor: 'middle' | 'start';
}

interface Port {
  p: Pt;
  /** 타일에서 바깥으로 나가는 방향(0 오른쪽, 1 아래, 2 왼쪽, 3 위). 들어올 때는 그 반대로 들어온다 */
  out: number;
}

function portsOf(t: RouteTile): Port[] {
  const midY = t.y + TILE_HALF;
  return [
    { p: { x: t.cx + TILE_HALF + PORT_GAP, y: midY }, out: 0 },
    { p: { x: t.cx, y: t.y + INFRA_NODE_H + PORT_GAP }, out: 1 },
    { p: { x: t.cx - TILE_HALF - PORT_GAP, y: midY }, out: 2 },
    { p: { x: t.cx, y: t.y - PORT_GAP }, out: 3 },
  ];
}

/** 타일과 그 아래 글자 상자. 선이 안쪽을 지나면 안 되고 테두리에 닿는 건 괜찮다 */
export function obstaclesOf(t: RouteTile): Rect[] {
  return [
    {
      x1: t.cx - TILE_HALF - PORT_GAP,
      y1: t.y - PORT_GAP,
      x2: t.cx + TILE_HALF + PORT_GAP,
      y2: t.y + INFRA_TILE + PORT_GAP,
    },
    {
      x1: t.cx - NODE_HALF - PORT_GAP,
      y1: t.y + INFRA_TILE,
      x2: t.cx + NODE_HALF + PORT_GAP,
      y2: t.y + INFRA_NODE_H + PORT_GAP,
    },
  ];
}

function uniqSorted(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

/**
 * 성긴 격자 위 A*. 상태는 (점, 들어온 방향)이고 꺾을 때마다 BEND_COST를 더한다.
 * 휴리스틱은 도착 포트 점까지의 맨해튼 거리 최솟값이라 실제 비용을 넘지 않는다
 */
export function makeRouter(
  tiles: readonly RouteTile[],
  width: number,
  height: number,
  /** 캔버스 가장자리에서 이만큼 안쪽에 바깥 통로를 낸다 */
  margin: number,
): { route: (a: RouteTile, b: RouteTile) => Pt[] } {
  const cxs = uniqSorted(tiles.map((t) => t.cx));
  const xs = uniqSorted([
    margin,
    width - margin,
    ...tiles.flatMap((t) => [
      t.cx,
      t.cx - TILE_HALF - PORT_GAP,
      t.cx + TILE_HALF + PORT_GAP,
      t.cx - SIDE_CORRIDOR,
      t.cx + SIDE_CORRIDOR,
    ]),
    ...cxs.slice(1).map((x, i) => (x + cxs[i]!) / 2),
  ]);
  const ys = uniqSorted([
    margin,
    height - margin,
    ...tiles.flatMap((t) => [
      t.y - PORT_GAP,
      t.y - ABOVE_BAND,
      t.y + TILE_HALF,
      t.y + INFRA_NODE_H + PORT_GAP,
      t.y + BELOW_BAND,
    ]),
  ]);
  const nx = xs.length;
  const ny = ys.length;
  const xi = new Map(xs.map((x, i) => [x, i]));
  const yi = new Map(ys.map((y, i) => [y, i]));
  const rects = tiles.flatMap(obstaclesOf);
  const crossesH = (y: number, x1: number, x2: number): boolean =>
    rects.some((r) => r.y1 < y && y < r.y2 && Math.max(x1, r.x1) < Math.min(x2, r.x2));
  const crossesV = (x: number, y1: number, y2: number): boolean =>
    rects.some((r) => r.x1 < x && x < r.x2 && Math.max(y1, r.y1) < Math.min(y2, r.y2));
  // 오른쪽(i→i+1)과 아래(j→j+1) 구간만 저장한다. 반대 방향은 같은 구간이다
  const blockedRight = new Uint8Array(nx * ny);
  const blockedDown = new Uint8Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const k = j * nx + i;
      if (i + 1 < nx && crossesH(ys[j]!, xs[i]!, xs[i + 1]!)) blockedRight[k] = 1;
      if (j + 1 < ny && crossesV(xs[i]!, ys[j]!, ys[j + 1]!)) blockedDown[k] = 1;
    }
  }
  const step = (k: number, d: number): number => {
    const i = k % nx;
    const j = (k - i) / nx;
    if (d === 0) return i + 1 < nx && blockedRight[k] === 0 ? k + 1 : -1;
    if (d === 2) return i > 0 && blockedRight[k - 1] === 0 ? k - 1 : -1;
    if (d === 1) return j + 1 < ny && blockedDown[k] === 0 ? k + nx : -1;
    return j > 0 && blockedDown[k - nx] === 0 ? k - nx : -1;
  };
  const pointOf = (k: number): Pt => ({ x: xs[k % nx]!, y: ys[Math.floor(k / nx)]! });
  const keyOf = (p: Pt): number => yi.get(p.y)! * nx + xi.get(p.x)!;

  // 선이 수백 개여도 큰 배열을 선마다 새로 만들지 않도록 한 번만 잡고 route마다 되돌린다
  const states = nx * ny * 4;
  const dist = new Float64Array(states);
  const prev = new Int32Array(states);
  const start = new Uint8Array(states);
  const goal = new Uint8Array(states);

  const route = (a: RouteTile, b: RouteTile): Pt[] => {
    dist.fill(Infinity);
    prev.fill(-1);
    start.fill(0);
    goal.fill(0);
    const heap = new MinHeap();
    const targets = portsOf(b).map((port) => port.p);
    const h = (k: number): number => {
      const p = pointOf(k);
      let best = Infinity;
      for (const t of targets) best = Math.min(best, Math.abs(t.x - p.x) + Math.abs(t.y - p.y));
      return best;
    };
    for (const port of portsOf(a)) {
      const k = keyOf(port.p);
      const s = k * 4 + port.out;
      dist[s] = 0;
      start[s] = 1;
      heap.push(h(k), s);
    }
    for (const port of portsOf(b)) goal[keyOf(port.p) * 4 + ((port.out + 2) % 4)] = 1;
    let found = -1;
    while (heap.size > 0) {
      const [f, s] = heap.pop();
      const k = s >> 2;
      // 힙에는 g + h가 들어 있다. g는 dist에서 읽고 더 싼 길이 이미 나온 낡은 항목만 거른다
      const g = dist[s]!;
      if (f > g + h(k)) continue;
      if (goal[s] === 1) {
        found = s;
        break;
      }
      const d = s & 3;
      for (let nd = 0; nd < 4; nd++) {
        if (nd === (d + 2) % 4) continue;
        // 포트에서는 타일 바깥쪽으로만 나간다
        if (start[s] === 1 && nd !== d) continue;
        const q = step(k, nd);
        if (q < 0) continue;
        const p0 = pointOf(k);
        const p1 = pointOf(q);
        const next = g + Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y) + (nd === d ? 0 : BEND_COST);
        const t = q * 4 + nd;
        if (next < dist[t]!) {
          dist[t] = next;
          prev[t] = s;
          heap.push(next + h(q), t);
        }
      }
    }
    if (found < 0) return fallbackRoute(a, b);
    const pts: Pt[] = [];
    for (let s = found; s >= 0; s = prev[s]!) pts.push(pointOf(s >> 2));
    return pts.reverse();
  };
  return { route };
}

/** 막힌 길이 없게 격자를 짰지만 혹시 갇히면 오른쪽 포트끼리 계단으로 잇는다 */
export function fallbackRoute(a: RouteTile, b: RouteTile): Pt[] {
  const from = portsOf(a)[0]!.p;
  const to = portsOf(b)[2]!.p;
  const midX = (from.x + to.x) / 2;
  return [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to];
}

/** 같은 방향으로 이어지는 점을 접는다 */
function compress(pts: readonly Pt[]): Pt[] {
  const out: Pt[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last !== undefined && last.x === p.x && last.y === p.y) continue;
    const before = out[out.length - 2];
    if (
      last !== undefined &&
      before !== undefined &&
      ((before.x === last.x && last.x === p.x) || (before.y === last.y && last.y === p.y))
    ) {
      out[out.length - 1] = p;
      continue;
    }
    out.push(p);
  }
  return out;
}

function num(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

export function pathOf(raw: readonly Pt[]): string {
  const pts = compress(raw);
  const first = pts[0]!;
  let d = `M${num(first.x)} ${num(first.y)}`;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[i - 1]!;
    d += p.y === q.y ? ` H${num(p.x)}` : ` V${num(p.y)}`;
  }
  return d;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;

/** 가장 긴 구간 옆. 가로면 선 위 가운데, 세로면 선 오른쪽 */
export function labelSpot(raw: readonly Pt[], avoid: readonly Rect[]): LabelSpot {
  const pts = compress(raw);
  let best = 0;
  let bestLen = -1;
  for (let i = 1; i < pts.length; i++) {
    const len = Math.abs(pts[i]!.x - pts[i - 1]!.x) + Math.abs(pts[i]!.y - pts[i - 1]!.y);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  const p = pts[best]!;
  const q = pts[best - 1] ?? p;
  const horizontal = p.y === q.y;
  const lo = horizontal ? Math.min(p.x, q.x) : Math.min(p.y, q.y);
  const hi = horizontal ? Math.max(p.x, q.x) : Math.max(p.y, q.y);
  const mid = (lo + hi) / 2;
  const boxAt = (t: number): Rect =>
    horizontal
      ? { x1: t - EDGE_LABEL_HALF_W, y1: p.y - 20, x2: t + EDGE_LABEL_HALF_W, y2: p.y - 4 }
      : { x1: p.x + 8, y1: t - 8, x2: p.x + 8 + 2 * EDGE_LABEL_HALF_W, y2: t + 8 };
  // 가운데부터 양쪽으로 번갈아 옮겨 본다. 어디든 걸리면 가운데에 둔다
  let at = mid;
  for (let k = 0; mid - k * LABEL_SHIFT >= lo + EDGE_LABEL_HALF_W; k++) {
    const hit = [mid + k * LABEL_SHIFT, mid - k * LABEL_SHIFT].find(
      (t) => t <= hi - EDGE_LABEL_HALF_W && !avoid.some((r) => overlaps(r, boxAt(t))),
    );
    if (hit !== undefined) {
      at = hit;
      break;
    }
  }
  if (horizontal) return { x: at, y: p.y - 8, anchor: 'middle' };
  return { x: p.x + 10, y: at + 4, anchor: 'start' };
}

/** 비용이 같으면 상태 번호가 작은 쪽이 먼저 나온다. 경로가 실행마다 같도록 */
class MinHeap {
  private costs: number[] = [];
  private items: number[] = [];
  get size(): number {
    return this.items.length;
  }
  private less(i: number, j: number): boolean {
    const a = this.costs[i]!;
    const b = this.costs[j]!;
    return a < b || (a === b && this.items[i]! < this.items[j]!);
  }
  private swap(i: number, j: number): void {
    [this.costs[i], this.costs[j]] = [this.costs[j]!, this.costs[i]!];
    [this.items[i], this.items[j]] = [this.items[j]!, this.items[i]!];
  }
  push(cost: number, item: number): void {
    this.costs.push(cost);
    this.items.push(item);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.costs[0]!, this.items[0]!];
    const lastCost = this.costs.pop()!;
    const lastItem = this.items.pop()!;
    if (this.items.length > 0) {
      this.costs[0] = lastCost;
      this.items[0] = lastItem;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.less(l, m)) m = l;
        if (r < this.items.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}
