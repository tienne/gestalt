import type { LayoutPoint } from './layout.js';
import type { ArchitectureFlow, FlowActor, FlowPath, FlowStep } from './types.js';
import type { ValidatedIr } from './validator.js';

export const FLOW_LEVEL_PREFIX = 'flow:';

/** 행위자 가로줄 하나. 머리 칸에 행위자 이름이 서고 오른쪽으로 단계가 이어진다 */
export interface FlowLane {
  actor: FlowActor;
  y: number;
  height: number;
}

export interface FlowStepBox {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
  /** 정상 흐름 줄이면 0, 옆으로 빠진 단계면 1부터 */
  row: number;
  /** 정상 흐름 전이에 한 번도 안 닿는 단계면 side다 */
  path: FlowPath;
}

export interface FlowTransitionRoute {
  id: string;
  from: string;
  to: string;
  path: FlowPath;
  points: LayoutPoint[];
  /** 화살촉 꼭짓점 셋 */
  tip: LayoutPoint[];
  /** 조건 글자를 놓을 자리. label이 없으면 없다 */
  labelAt?: LayoutPoint;
  /** 왼쪽 열로 돌아가는 전이. 되돌리기처럼 상태가 앞 단계로 돌아가는 자리다 */
  back: boolean;
}

export interface FlowLayout {
  width: number;
  height: number;
  lanes: FlowLane[];
  steps: FlowStepBox[];
  transitions: FlowTransitionRoute[];
}

export interface FlowLevel {
  /** `flow:<흐름 id>` */
  id: string;
  flowId: string;
  service: string;
  title: string;
  /** 서비스 레벨 밑에 선다. 흐름은 한 서비스에 딸린 그림이라서다 */
  trail: string[];
  flow: ArchitectureFlow;
  layout: FlowLayout;
}

export const FLOW_HEAD_WIDTH = 132;
export const FLOW_STEP_WIDTH = 176;
export const FLOW_STEP_HEIGHT = 64;
const COLUMN_GAP = 56;
const ROW_GAP = 22;
const LANE_PAD_Y = 18;
const PAD_RIGHT = 32;
const BACK_LANE_GAP = 10;
const TIP_LENGTH = 8;
const TIP_HALF = 4.5;

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 열은 전이를 따라 가장 긴 경로로 정한다. 되돌아가는 전이는 DFS에서 스택 위의 단계로 가는 선으로 보고 열 계산에서 뺀다.
 * DFS 시작 순서는 IR에 적힌 단계 순서다. 작성자가 이야기 순서로 적은 걸 그대로 따라야 정상 흐름이 왼쪽에서부터 읽힌다.
 * 정상 흐름 단계의 열은 정상 흐름 전이로만 정한다. 옆 흐름이 길게 이어지다 정상 흐름으로 돌아오면 그 뒤 정상 단계가 전부 오른쪽으로 밀려서다
 */
function columnsOf(
  steps: readonly FlowStep[],
  edges: readonly { id: string; from: string; to: string; path: FlowPath }[],
  isMain: (id: string) => boolean,
): { column: Map<string, number>; back: Set<string> } {
  const out = new Map<string, { id: string; to: string }[]>();
  const indeg = new Map<string, number>(steps.map((s) => [s.id, 0]));
  for (const e of edges) {
    const list = out.get(e.from) ?? [];
    list.push({ id: e.id, to: e.to });
    out.set(e.from, list);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const back = new Set<string>();
  const state = new Map<string, 'open' | 'done'>();
  const order: string[] = [];
  const visit = (id: string): void => {
    state.set(id, 'open');
    for (const e of out.get(id) ?? []) {
      const s = state.get(e.to);
      if (s === 'open') back.add(e.id);
      else if (s === undefined) visit(e.to);
    }
    state.set(id, 'done');
    order.push(id);
  };
  // 들어오는 선이 없는 단계부터 돈다. 고리만 있는 단계는 그다음에 적힌 순서로 돈다
  for (const s of steps) if ((indeg.get(s.id) ?? 0) === 0 && !state.has(s.id)) visit(s.id);
  for (const s of steps) if (!state.has(s.id)) visit(s.id);
  const column = new Map<string, number>(steps.map((s) => [s.id, 0]));
  const pathOf = new Map(edges.map((e) => [e.id, e.path]));
  const topo = order.reverse();
  for (const id of topo) {
    for (const e of out.get(id) ?? []) {
      if (back.has(e.id) || pathOf.get(e.id) !== 'main') continue;
      column.set(e.to, Math.max(column.get(e.to)!, column.get(id)! + 1));
    }
  }
  for (const id of topo) {
    for (const e of out.get(id) ?? []) {
      if (back.has(e.id) || isMain(e.to)) continue;
      column.set(e.to, Math.max(column.get(e.to)!, column.get(id)! + 1));
    }
  }
  return { column, back };
}

function tipAt(end: LayoutPoint, from: LayoutPoint): LayoutPoint[] {
  const dx = end.x - from.x;
  const dy = end.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const bx = end.x - ux * TIP_LENGTH;
  const by = end.y - uy * TIP_LENGTH;
  return [
    { x: round2(end.x), y: round2(end.y) },
    { x: round2(bx - uy * TIP_HALF), y: round2(by + ux * TIP_HALF) },
    { x: round2(bx + uy * TIP_HALF), y: round2(by - ux * TIP_HALF) },
  ];
}

interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  from: string;
}

function segmentsOf(points: readonly LayoutPoint[], from: string): Segment[] {
  const out: Segment[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i - 1]!;
    const q = points[i]!;
    out.push({ x1: p.x, y1: p.y, x2: q.x, y2: q.y, from });
  }
  return out;
}

function overlaps(a1: number, a2: number, b1: number, b2: number): boolean {
  return Math.min(a1, a2) < Math.max(b1, b2) && Math.min(b1, b2) < Math.max(a1, a2);
}

/** 선이 다른 카드를 뚫거나, 출발 단계가 다른 선과 같은 줄을 겹쳐 쓰면 true다. 같은 단계에서 갈라지는 선끼리는 겹쳐도 한 줄기로 읽힌다 */
function collides(
  points: readonly LayoutPoint[],
  from: string,
  skip: readonly FlowStepBox[],
  boxes: readonly FlowStepBox[],
  placed: readonly Segment[],
): boolean {
  for (const s of segmentsOf(points, from)) {
    for (const box of boxes) {
      if (skip.includes(box)) continue;
      const inX =
        overlaps(s.x1, s.x2, box.x, box.x + box.width) ||
        (s.x1 === s.x2 && s.x1 > box.x && s.x1 < box.x + box.width);
      const inY =
        overlaps(s.y1, s.y2, box.y, box.y + box.height) ||
        (s.y1 === s.y2 && s.y1 > box.y && s.y1 < box.y + box.height);
      if (inX && inY) return true;
    }
    for (const p of placed) {
      if (p.from === from) continue;
      const vertical = s.x1 === s.x2 && p.x1 === p.x2 && Math.abs(s.x1 - p.x1) < 1;
      const horizontal = s.y1 === s.y2 && p.y1 === p.y2 && Math.abs(s.y1 - p.y1) < 1;
      if (vertical && overlaps(s.y1, s.y2, p.y1, p.y2)) return true;
      if (horizontal && overlaps(s.x1, s.x2, p.x1, p.x2)) return true;
    }
  }
  return false;
}

/**
 * 줄이 다른 옆 흐름 전이의 경로. 먼저 카드 위나 아래에서 바로 꺾어 나가는 길을 본다. 오른쪽 변으로 나가면 정상 흐름 선과 같은 꺾임 자리를 겹쳐 쓴다.
 * 그 길이 다른 카드를 뚫거나 다른 단계의 선과 겹치면 카드 사이 빈 줄로 나가 도착 열 앞의 빈 칸에서 내려가는 길을 고른다
 */
function sideRoute(
  a: FlowStepBox,
  b: FlowStepBox,
  from: string,
  boxes: readonly FlowStepBox[],
  placed: readonly Segment[],
): LayoutPoint[] {
  const down = b.y > a.y;
  const ty = b.y + b.height / 2;
  const sy = down ? a.y + a.height : a.y;
  const candidates: LayoutPoint[][] = [];
  // 내려가는 선과 올라가는 선이 같은 세로줄을 쓰지 않게 나가는 자리를 나눈다
  for (const ratio of down ? [0.72, 0.86] : [0.28, 0.14]) {
    const sx = a.x + a.width * ratio;
    candidates.push([
      { x: sx, y: sy },
      { x: sx, y: ty },
      { x: b.x, y: ty },
    ]);
  }
  const gapY = down ? sy + ROW_GAP / 2 : sy - ROW_GAP / 2;
  for (let k = 0; k < 4; k += 1) {
    const cx = b.x - 10 - k * 6;
    if (cx <= a.x + a.width) break;
    const sx = a.x + a.width * (down ? 0.72 : 0.28);
    candidates.push([
      { x: sx, y: sy },
      { x: sx, y: gapY },
      { x: cx, y: gapY },
      { x: cx, y: ty },
      { x: b.x, y: ty },
    ]);
  }
  return candidates.find((c) => !collides(c, from, [a, b], boxes, placed)) ?? candidates[0]!;
}

/** 꺾인 선의 글자 자리. 가장 긴 세로 구간 가운데에 둔다 */
function longestVerticalMid(points: readonly LayoutPoint[]): LayoutPoint {
  let best = { x: points[0]!.x, y: points[0]!.y, len: -1 };
  for (let i = 1; i < points.length; i += 1) {
    const p = points[i - 1]!;
    const q = points[i]!;
    const len = Math.abs(q.y - p.y);
    if (p.x === q.x && len > best.len) best = { x: p.x, y: (p.y + q.y) / 2, len };
  }
  return { x: round2(best.x), y: round2(best.y) };
}

/**
 * 흐름 하나의 좌표. elkjs를 안 쓰고 격자로 놓는다. 행위자 줄과 단계 열이 곧 읽는 순서라 자동 배치가 오히려 그 순서를 흐트러뜨린다.
 * 같은 입력이면 같은 좌표가 나온다
 */
export function computeFlowLayout(
  flow: ArchitectureFlow,
  drawableSteps: ReadonlySet<string>,
  drawableTransitions: ReadonlySet<string>,
): FlowLayout {
  const steps = flow.steps.filter((s) => drawableSteps.has(s.id));
  const transitions = flow.transitions.filter((t) => drawableTransitions.has(t.id));
  const onMain = new Set<string>();
  for (const t of transitions) {
    if (t.path !== 'main') continue;
    onMain.add(t.from);
    onMain.add(t.to);
  }
  // 전이가 하나도 안 닿는 단계는 정상 흐름 줄에 둔다. 옆 흐름으로 그리면 어디서 빠졌는지 묻게 된다
  const touched = new Set(transitions.flatMap((t) => [t.from, t.to]));
  const pathOf = (id: string): FlowPath => (onMain.has(id) || !touched.has(id) ? 'main' : 'side');
  const { column, back } = columnsOf(steps, transitions, (id) => pathOf(id) === 'main');

  // 행위자 줄 안에서 칸이 겹치면 아래 줄로 내린다. 정상 흐름 단계를 먼저 놓아야 옆 흐름이 그 아래로 간다
  const taken = new Set<string>();
  const rowOf = new Map<string, number>();
  const rowsOfActor = new Map<string, number>();
  const place = (s: FlowStep, start: number): void => {
    let row = start;
    while (taken.has(`${s.actor}\u0000${row}\u0000${column.get(s.id)!}`)) row += 1;
    taken.add(`${s.actor}\u0000${row}\u0000${column.get(s.id)!}`);
    rowOf.set(s.id, row);
    rowsOfActor.set(s.actor, Math.max(rowsOfActor.get(s.actor) ?? 1, row + 1));
  };
  for (const s of steps) if (pathOf(s.id) === 'main') place(s, 0);
  for (const s of steps) if (pathOf(s.id) === 'side') place(s, 1);

  const lanes: FlowLane[] = [];
  const laneY = new Map<string, number>();
  let y = 0;
  for (const actor of flow.actors) {
    const rows = rowsOfActor.get(actor.id) ?? 1;
    const height = LANE_PAD_Y * 2 + rows * FLOW_STEP_HEIGHT + (rows - 1) * ROW_GAP;
    lanes.push({ actor, y, height });
    laneY.set(actor.id, y);
    y += height;
  }
  const columns = Math.max(0, ...[...column.values()]) + 1;
  const boxes: FlowStepBox[] = steps.map((s) => {
    const col = column.get(s.id)!;
    const row = rowOf.get(s.id)!;
    return {
      id: s.id,
      x: FLOW_HEAD_WIDTH + COLUMN_GAP / 2 + col * (FLOW_STEP_WIDTH + COLUMN_GAP),
      y: laneY.get(s.actor)! + LANE_PAD_Y + row * (FLOW_STEP_HEIGHT + ROW_GAP),
      width: FLOW_STEP_WIDTH,
      height: FLOW_STEP_HEIGHT,
      column: col,
      row,
      path: pathOf(s.id),
    };
  });
  const boxOf = new Map(boxes.map((b) => [b.id, b]));
  const height = y;

  // 되돌아가는 선은 그림 맨 아래 여백으로 돌린다. 단계 사이를 가로지르면 정상 흐름 선과 엉킨다
  let backCount = 0;
  const placed: Segment[] = [];
  const routes: FlowTransitionRoute[] = transitions.map((t) => {
    const a = boxOf.get(t.from)!;
    const b = boxOf.get(t.to)!;
    const isBack = back.has(t.id) || b.column <= a.column;
    let points: LayoutPoint[];
    if (isBack) {
      backCount += 1;
      const floor = height + BACK_LANE_GAP * backCount;
      const sx = a.x + a.width / 2 + 10;
      const tx = b.x + b.width / 2 - 10;
      points = [
        { x: sx, y: a.y + a.height },
        { x: sx, y: floor },
        { x: tx, y: floor },
        { x: tx, y: b.y + b.height },
      ];
    } else if (t.path === 'side' && b.y !== a.y) {
      points = sideRoute(a, b, t.from, boxes, placed);
    } else {
      const sx = a.x + a.width;
      const sy = a.y + a.height / 2;
      const tx = b.x;
      const ty = b.y + b.height / 2;
      const mx = tx - COLUMN_GAP / 2;
      points =
        sy === ty
          ? [
              { x: sx, y: sy },
              { x: tx, y: ty },
            ]
          : [
              { x: sx, y: sy },
              { x: mx, y: sy },
              { x: mx, y: ty },
              { x: tx, y: ty },
            ];
    }
    points = points.map((p) => ({ x: round2(p.x), y: round2(p.y) }));
    placed.push(...segmentsOf(points, t.from));
    const last = points[points.length - 1]!;
    const prev = points[points.length - 2]!;
    const mid = isBack
      ? { x: round2((points[1]!.x + points[2]!.x) / 2), y: round2(points[1]!.y) }
      : points.length === 2
        ? { x: round2((prev.x + last.x) / 2), y: round2(last.y) }
        : longestVerticalMid(points);
    return {
      id: t.id,
      from: t.from,
      to: t.to,
      path: t.path,
      points,
      tip: tipAt(last, prev),
      ...(t.label !== undefined ? { labelAt: mid } : {}),
      back: isBack,
    };
  });

  const width = FLOW_HEAD_WIDTH + columns * (FLOW_STEP_WIDTH + COLUMN_GAP) + PAD_RIGHT;
  return {
    width: round2(width),
    height: round2(height + (backCount > 0 ? BACK_LANE_GAP * (backCount + 1) : 0)),
    lanes,
    steps: boxes,
    transitions: routes,
  };
}

/** 그릴 흐름 레벨. 서비스가 그려지지 않는 흐름은 들어갈 자리가 없어서 뺀다. 정렬은 흐름 id 순이다 */
export function computeFlowLevels(validated: ValidatedIr): FlowLevel[] {
  const flows = [...(validated.ir.flows ?? [])].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return flows
    .filter((f) => validated.drawableNodeIds.has(f.service))
    .map((f) => ({
      id: `${FLOW_LEVEL_PREFIX}${f.id}`,
      flowId: f.id,
      service: f.service,
      title: f.title,
      trail: ['root', `service:${f.service}`, `${FLOW_LEVEL_PREFIX}${f.id}`],
      flow: f,
      layout: computeFlowLayout(f, validated.drawableStepIds, validated.drawableTransitionIds),
    }));
}
