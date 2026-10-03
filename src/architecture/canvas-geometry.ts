import type { LayoutNode, LayoutPoint, LayoutResult } from './layout.js';

/** 캔버스 좌표 = 레이아웃 좌표 + 이 여백. 위쪽은 레인 제목이 앉는 자리다 */
export const CANVAS_PAD_X = 32;
export const CANVAS_PAD_TOP = 60;
export const CANVAS_PAD_BOTTOM = 40;
/** 레인 띠의 위아래 여백 */
export const LANE_INSET_Y = 12;

const PORT_INSET = 14;
const PORT_STEP = 9;
// elk 경로에서 레이어 하나를 가로지르는 수평 구간만 경유점으로 쓴다. 레이어 사이 틈에서 꺾이는 짧은 구간은 버린다
const MIN_VIA_LENGTH = 40;
const VIA_CLEARANCE = 24;
const VIA_MARGIN = 8;
const LOOP_REACH = 36;
const LOOP_DROP = 28;
const STACK_BOW_MAX = 30;

export interface RouteInput {
  id: string;
  from: string;
  to: string;
  /** 선 굵기(px). 화살촉 크기를 여기에 맞춘다 */
  width: number;
  /** 도착 카드가 왼쪽 열에 있는 엣지. 출발 카드 왼쪽에서 도착 카드 오른쪽으로 곧게 잇고 화살촉이 왼쪽을 본다 */
  backward?: boolean;
}

export interface RoutedEdge {
  id: string;
  d: string;
  tip: string;
  mid: LayoutPoint;
  reverse: boolean;
}

export interface RoutedCanvas {
  width: number;
  height: number;
  edges: Map<string, RoutedEdge>;
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  cy: number;
}

function toBox(n: LayoutNode): Box {
  const left = n.x + CANVAS_PAD_X;
  const top = n.y + CANVAS_PAD_TOP;
  return { left, right: left + n.width, top, bottom: top + n.height, cy: top + n.height / 2 };
}

/** 한 카드에 붙는 선이 여럿이면 세로로 나눠 앉힌다. 맞은편 카드가 위에 있을수록 위쪽 자리다 */
function assignPorts(
  edges: readonly RouteInput[],
  boxes: Map<string, Box>,
  side: 'out' | 'in',
): Map<string, number> {
  const groups = new Map<string, RouteInput[]>();
  for (const e of edges) {
    const key = side === 'out' ? e.from : e.to;
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }
  const ports = new Map<string, number>();
  for (const [nodeId, list] of groups) {
    const box = boxes.get(nodeId)!;
    const other = (e: RouteInput): Box => boxes.get(side === 'out' ? e.to : e.from)!;
    list.sort(
      (a, b) => other(a).cy - other(b).cy || other(a).left - other(b).left || cmp(a.id, b.id),
    );
    const n = list.length;
    const usable = box.bottom - box.top - PORT_INSET * 2;
    const step = n > 1 ? Math.min(PORT_STEP, usable / (n - 1)) : 0;
    list.forEach((e, i) => ports.set(e.id, r2(box.cy + (i - (n - 1) / 2) * step)));
  }
  return ports;
}

function curve(p: LayoutPoint, q: LayoutPoint): string {
  const dx = Math.max(16, (q.x - p.x) / 2);
  return `C${r2(p.x + dx)} ${r2(p.y)} ${r2(q.x - dx)} ${r2(q.y)} ${r2(q.x)} ${r2(q.y)}`;
}

function bezierMid(p: LayoutPoint, q: LayoutPoint): LayoutPoint {
  // 수평 접선 3차 베지어의 t=0.5 지점은 두 끝점의 한가운데다
  return { x: r2((p.x + q.x) / 2), y: r2((p.y + q.y) / 2) };
}

interface Via {
  x1: number;
  x2: number;
  y: number;
}

/** 카드가 서는 x 구간을 합친 목록. 레이어 열 하나가 구간 하나다 */
function columnsOf(boxes: Iterable<Box>): Array<{ left: number; right: number }> {
  const spans = [...boxes]
    .map((b) => ({ left: b.left, right: b.right }))
    .sort((a, b) => a.left - b.left);
  const out: Array<{ left: number; right: number }> = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.left <= last.right) last.right = Math.max(last.right, s.right);
    else out.push({ ...s });
  }
  return out;
}

/**
 * elk가 더미 노드 자리로 낸 수평 구간을 경유점으로 뽑는다. 사이 레인의 카드를 피해 가는 길이다.
 * 구간은 지나는 카드 열 폭으로 줄인다. elk는 레이어 사이 틈 아무 데서나 꺾는데, 그대로 두면 곡선이 좁은 틈에서 급하게 꺾인다
 */
function viasOf(
  points: readonly LayoutPoint[],
  columns: ReadonlyArray<{ left: number; right: number }>,
  minX: number,
  maxX: number,
): Via[] {
  const vias: Via[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (Math.abs(a.y - b.y) > 0.5) continue;
    const lo = Math.max(Math.min(a.x, b.x) + CANVAS_PAD_X, minX);
    const hi = Math.min(Math.max(a.x, b.x) + CANVAS_PAD_X, maxX);
    const crossed = columns.filter((c) => c.right > lo && c.left < hi);
    if (crossed.length === 0) continue;
    const x1 = Math.max(lo, crossed[0]!.left - VIA_MARGIN);
    const x2 = Math.min(hi, crossed[crossed.length - 1]!.right + VIA_MARGIN);
    if (x2 - x1 < MIN_VIA_LENGTH) continue;
    vias.push({ x1, x2, y: a.y + CANVAS_PAD_TOP });
  }
  vias.sort((a, b) => a.x1 - b.x1);
  const out: Via[] = [];
  for (const v of vias) {
    const prev = out[out.length - 1];
    if (prev && v.x1 < prev.x2) continue;
    out.push(v);
  }
  return out;
}

function tipPath(x: number, y: number, len: number, half: number): string {
  return `M${r2(x)} ${r2(y)}L${r2(x - len)} ${r2(y - half)}L${r2(x - len)} ${r2(y + half)}Z`;
}

function tipPathLeft(x: number, y: number, len: number, half: number): string {
  return `M${r2(x)} ${r2(y)}L${r2(x + len)} ${r2(y - half)}L${r2(x + len)} ${r2(y + half)}Z`;
}

/**
 * 출발 카드 오른쪽 가운데에서 도착 카드 왼쪽 가운데로 가는 곡선을 낸다.
 * 레인을 건너뛰는 선은 elk가 비워 둔 자리를 경유하고 왼쪽으로 돌아가는 선은 두 카드 아래로 감아 돈다.
 * 입력만 보고 계산하므로 같은 입력이면 같은 경로가 나온다.
 */
export function routeCanvas(layout: LayoutResult, inputs: readonly RouteInput[]): RoutedCanvas {
  const boxes = new Map(layout.nodes.map((n) => [n.id, toBox(n)]));
  const elkPoints = new Map(layout.edges.map((e) => [e.id, e.points]));
  const moved = new Set(layout.movedNodeIds ?? []);
  const edges = [...inputs]
    .filter((e) => e.from !== e.to && boxes.has(e.from) && boxes.has(e.to))
    .sort((a, b) => cmp(a.id, b.id));
  const columns = columnsOf(boxes.values());
  const stacked = (e: RouteInput): boolean => {
    const a = boxes.get(e.from)!;
    const b = boxes.get(e.to)!;
    return b.left < a.right && b.right > a.left;
  };
  const outPorts = assignPorts(
    edges.filter((e) => !stacked(e)),
    boxes,
    'out',
  );
  const inPorts = assignPorts(edges, boxes, 'in');

  let maxY = layout.height + CANVAS_PAD_TOP + CANVAS_PAD_BOTTOM;
  const routed = new Map<string, RoutedEdge>();
  for (const e of edges) {
    const src = boxes.get(e.from)!;
    const dst = boxes.get(e.to)!;
    const half = r2(3.5 + e.width * 0.45);
    const len = r2(7 + e.width * 0.5);
    const start = { x: src.right, y: outPorts.get(e.id)! };
    const tipX = dst.left;
    const end = { x: tipX - len + 1, y: inPorts.get(e.id)! };
    const reverse = dst.left < src.right + 8;
    let d: string;
    let mid: LayoutPoint;
    if (e.backward && dst.right + 8 <= src.left) {
      const from = { x: src.left, y: outPorts.get(e.id)! };
      const tipAt = dst.right;
      const to = { x: tipAt + len - 1, y: inPorts.get(e.id)! };
      const dx = Math.max(16, (from.x - to.x) / 2);
      d =
        `M${r2(from.x)} ${r2(from.y)}` +
        `C${r2(from.x - dx)} ${r2(from.y)} ${r2(to.x + dx)} ${r2(to.y)} ${r2(to.x)} ${r2(to.y)}`;
      mid = bezierMid(from, to);
      routed.set(e.id, {
        id: e.id,
        d,
        tip: tipPathLeft(tipAt, to.y, len, half),
        mid,
        reverse: true,
      });
      continue;
    }
    if (stacked(e)) {
      // 같은 열 카드끼리는 왼쪽 바깥으로 활처럼 휘어 잇는다. 오른쪽은 다음 레인으로 가는 선 자리다
      const from = { x: src.left, y: src.cy };
      const bow = Math.min(STACK_BOW_MAX, 18 + Math.abs(end.y - from.y) * 0.2);
      const outX = Math.min(from.x, end.x) - bow;
      d =
        `M${r2(from.x)} ${r2(from.y)}` +
        `C${r2(outX)} ${r2(from.y)} ${r2(outX)} ${r2(end.y)} ${r2(end.x)} ${r2(end.y)}`;
      mid = { x: r2(outX + bow * 0.25), y: r2((from.y + end.y) / 2) };
    } else if (reverse) {
      const drop = Math.max(src.bottom, dst.bottom) + LOOP_DROP;
      maxY = Math.max(maxY, drop + CANVAS_PAD_BOTTOM);
      const back = end.x - LOOP_REACH;
      d =
        `M${r2(start.x)} ${r2(start.y)}` +
        `C${r2(start.x + LOOP_REACH)} ${r2(start.y)} ${r2(start.x + LOOP_REACH)} ${r2(drop)} ${r2(start.x)} ${r2(drop)}` +
        `L${r2(end.x)} ${r2(drop)}` +
        `C${r2(back)} ${r2(drop)} ${r2(back)} ${r2(end.y)} ${r2(end.x)} ${r2(end.y)}`;
      mid = { x: r2((start.x + end.x) / 2), y: r2(drop) };
    } else {
      const stale = moved.has(e.from) || moved.has(e.to);
      const vias = viasOf(
        stale ? [] : (elkPoints.get(e.id) ?? []),
        columns,
        start.x + VIA_CLEARANCE,
        end.x - VIA_CLEARANCE,
      );
      const parts = [`M${r2(start.x)} ${r2(start.y)}`];
      let at: LayoutPoint = start;
      for (const v of vias) {
        parts.push(curve(at, { x: v.x1, y: v.y }), `L${r2(v.x2)} ${r2(v.y)}`);
        at = { x: v.x2, y: v.y };
      }
      parts.push(curve(at, end));
      d = parts.join('');
      const middle = vias[Math.floor(vias.length / 2)];
      mid = middle
        ? { x: r2((middle.x1 + middle.x2) / 2), y: r2(middle.y) }
        : bezierMid(start, end);
    }
    routed.set(e.id, { id: e.id, d, tip: tipPath(tipX, end.y, len, half), mid, reverse });
  }
  return {
    width: r2(layout.width + CANVAS_PAD_X * 2),
    height: r2(maxY),
    edges: routed,
  };
}
