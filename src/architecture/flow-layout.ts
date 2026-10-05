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
  /** 조건 글자와 행위자 이름을 놓을 자리. 둘 다 없으면 없다 */
  labelAt?: LayoutPoint;
  /** 왼쪽 열로 돌아가는 전이. 되돌리기처럼 상태가 앞 단계로 돌아가는 자리다 */
  back: boolean;
}

/** 열 여러 개를 묶는 구간. 정상 흐름은 상태 값마다 하나다. 옆 흐름 구간은 정상 흐름 마지막 열 너머에 하나, 열 머리와 상태가 다른 옆 흐름 카드가 갈라져 나온 구간 뒤에 하나씩 선다 */
export interface FlowStage {
  label: string;
  x: number;
  width: number;
  side: boolean;
}

export interface FlowLayout {
  width: number;
  height: number;
  lanes: FlowLane[];
  /** 정상 흐름 단계에 상태 값이 하나도 없으면 빈 배열이다 */
  stages: FlowStage[];
  steps: FlowStepBox[];
  transitions: FlowTransitionRoute[];
}

export interface FlowLevel {
  /** `flow:<흐름 id>` */
  id: string;
  flowId: string;
  /** 없으면 전체 바로 아래 독립 흐름이다 */
  service?: string;
  title: string;
  /** 서비스 레벨 밑에 선다. 흐름은 한 서비스에 딸린 그림이라서다. 독립 흐름은 전체 바로 밑이다 */
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
export const FLOW_STAGE_HEAD = 34;
export const FLOW_SIDE_STAGE_LABEL = '옆 흐름';

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
): { column: Map<string, number>; back: Set<string>; topo: string[] } {
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
  return { column, back, topo };
}

/**
 * 구간이 있을 때의 열. 정상 흐름 단계는 상태 값으로 구간을 정하고 상태가 없는 단계는 앞 단계 구간을 따른다. 알림 발송처럼 상태를 안 바꾸는 단계가 그렇다.
 * 구간은 앞 구간의 마지막 열 다음에서 시작한다. 옆 흐름 단계는 갈라져 나온 단계 옆에 서고 정상 흐름 너머로 나간 것만 맨 끝 구간을 받는다.
 * 옆 흐름 카드의 상태가 선 자리 열 머리와 다르면 그 카드가 갈라져 나온 구간 바로 뒤에 옆 흐름 구간을 끼운다
 */
function stagedColumns(
  steps: readonly FlowStep[],
  edges: readonly { id: string; from: string; to: string; path: FlowPath }[],
  isMain: (id: string) => boolean,
  base: { column: Map<string, number>; back: Set<string>; topo: string[] },
):
  | {
      column: Map<string, number>;
      stages: { label: string; first: number; last: number; side: boolean }[];
    }
  | undefined {
  const stepOf = new Map(steps.map((s) => [s.id, s]));
  const preds = new Map<string, { from: string; main: boolean }[]>();
  for (const e of edges) {
    if (base.back.has(e.id)) continue;
    preds.set(e.to, [...(preds.get(e.to) ?? []), { from: e.from, main: e.path === 'main' }]);
  }
  const mainTopo = base.topo.filter((id) => isMain(id));
  if (!mainTopo.some((id) => stepOf.get(id)?.state !== undefined)) return undefined;

  // 구간 순서는 그 상태를 처음 가진 단계의 열 순서다
  const firstCol = new Map<string, number>();
  for (const id of mainTopo) {
    const state = stepOf.get(id)!.state;
    if (state === undefined) continue;
    const col = base.column.get(id)!;
    if (!firstCol.has(state) || col < firstCol.get(state)!) firstCol.set(state, col);
  }
  const keys = [...firstCol.keys()].sort((a, b) => firstCol.get(a)! - firstCol.get(b)!);
  const rank = new Map(keys.map((k, i) => [k, i]));
  const stageOf = new Map<string, number>();
  for (const id of mainTopo) {
    const state = stepOf.get(id)!.state;
    if (state !== undefined) {
      stageOf.set(id, rank.get(state)!);
      continue;
    }
    const inherited = (preds.get(id) ?? [])
      .filter((p) => p.main && stageOf.has(p.from))
      .map((p) => stageOf.get(p.from)!);
    stageOf.set(id, inherited.length > 0 ? Math.max(...inherited) : 0);
  }

  const mainCol = new Map<string, number>();
  const mainStages: { label: string; first: number; last: number }[] = [];
  let start = 0;
  for (let k = 0; k < keys.length; k += 1) {
    let last = start;
    for (const id of mainTopo) {
      if (stageOf.get(id) !== k) continue;
      let col = start;
      for (const p of preds.get(id) ?? []) {
        if (!p.main || (stageOf.get(p.from) ?? 0) > k || !mainCol.has(p.from)) continue;
        col = Math.max(col, mainCol.get(p.from)! + 1);
      }
      mainCol.set(id, col);
      last = Math.max(last, col);
    }
    mainStages.push({ label: keys[k]!, first: start, last });
    start = last + 1;
  }

  // 옆 흐름 단계는 원래 갈라져 나온 단계 바로 다음 열에 선다. 맨 끝에 모으면 옆으로 빠지는 선이 그림을 가로질러 길어져서다.
  // 다만 그 열 머리의 상태 값과 카드의 상태 값이 다르면 머리가 카드 상태를 잘못 알려준다. 그런 카드가 하나라도 갈라져 나온 구간은 바로 뒤에 옆 흐름 열을 따로 받는다
  const sideIds = base.topo.filter((id) => !isMain(id));
  const stageAtCol = (col: number): number => mainStages.findIndex((g) => col <= g.last);
  const nextTo = (id: string, col: ReadonlyMap<string, number>, fallback: number): number => {
    let at: number | undefined;
    for (const p of preds.get(id) ?? []) {
      if (col.has(p.from)) at = Math.max(at ?? -Infinity, col.get(p.from)! + 1);
    }
    return at ?? fallback;
  };
  const origin = new Map<string, { stage: number; depth: number }>();
  const plain = new Map(mainCol);
  const own = new Set<number>();
  for (const id of sideIds) {
    let at: { stage: number; depth: number } | undefined;
    for (const p of preds.get(id) ?? []) {
      const from = origin.get(p.from);
      const cand = mainCol.has(p.from)
        ? { stage: stageAtCol(mainCol.get(p.from)!), depth: 1 }
        : from !== undefined
          ? { stage: from.stage, depth: from.depth + 1 }
          : undefined;
      if (cand === undefined) continue;
      if (
        at === undefined ||
        cand.stage > at.stage ||
        (cand.stage === at.stage && cand.depth > at.depth)
      ) {
        at = cand;
      }
    }
    const o = at ?? { stage: mainStages.length - 1, depth: 1 };
    origin.set(id, o);
    const col = nextTo(id, plain, start);
    plain.set(id, col);
    const state = stepOf.get(id)!.state;
    if (state !== undefined && col < start && mainStages[stageAtCol(col)]!.label !== state) {
      own.add(o.stage);
    }
  }
  const sideWidth = mainStages.map((_, k) =>
    own.has(k)
      ? Math.max(...[...origin.values()].filter((v) => v.stage === k).map((v) => v.depth))
      : 0,
  );

  const column = new Map<string, number>();
  const stages: { label: string; first: number; last: number; side: boolean }[] = [];
  const shift: number[] = [];
  const sideFirst: number[] = [];
  let pushed = 0;
  mainStages.forEach((g, k) => {
    shift.push(pushed);
    stages.push({ label: g.label, first: g.first + pushed, last: g.last + pushed, side: false });
    sideFirst.push(g.last + pushed + 1);
    if (sideWidth[k]! > 0) {
      const first = sideFirst[k]!;
      stages.push({
        label: FLOW_SIDE_STAGE_LABEL,
        first,
        last: first + sideWidth[k]! - 1,
        side: true,
      });
      pushed += sideWidth[k]!;
    }
  });
  for (const [id, col] of mainCol) column.set(id, col + shift[stageAtCol(col)]!);
  const end = start + pushed;
  let sideLast = -1;
  for (const id of sideIds) {
    const o = origin.get(id)!;
    const col = own.has(o.stage) ? sideFirst[o.stage]! + o.depth - 1 : nextTo(id, column, end);
    column.set(id, col);
    if (col >= end) sideLast = Math.max(sideLast, col);
  }
  // 정상 흐름 마지막 열 너머로 나간 옆 흐름 단계는 맨 끝 구간을 받는다
  if (sideLast >= end) {
    stages.push({ label: FLOW_SIDE_STAGE_LABEL, first: end, last: sideLast, side: true });
  }
  return { column, stages };
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

/**
 * 되돌아가는 전이의 가까운 길. 두 카드 중 위쪽 카드의 바로 위 빈 줄이나 아래쪽 카드의 바로 아래 빈 줄로 건너간다.
 * 그 줄은 카드가 안 서는 여백이라 다른 카드를 안 뚫는다. 다른 선과 겹치면 몇 px씩 비켜 보고 그래도 안 되면 undefined를 돌려 맨 아래 길로 보낸다
 */
function nearBackRoute(
  a: FlowStepBox,
  b: FlowStepBox,
  from: string,
  boxes: readonly FlowStepBox[],
  placed: readonly Segment[],
): LayoutPoint[] | undefined {
  const over = Math.min(a.y, b.y) - ROW_GAP / 2;
  const under = Math.max(a.y + a.height, b.y + b.height) + ROW_GAP / 2;
  // 옆 흐름 선이 카드 0.28과 0.72, 0.14와 0.86 자리로 드나드니 그 사이 자리를 먼저 본다
  const ratios = [0.5, 0.4, 0.6, 0.34, 0.66];
  for (let k = 0; k < 3; k += 1) {
    const shift = k * BACK_LANE_GAP * 0.6;
    for (const [gy, side] of [
      [over - shift, 'top'],
      [under + shift, 'bottom'],
    ] as const) {
      const fromEdge = side === 'top' ? a.y : a.y + a.height;
      const toEdge = side === 'top' ? b.y : b.y + b.height;
      for (const rs of ratios) {
        for (const rt of ratios) {
          const sx = a.x + a.width * rs;
          const tx = b.x + b.width * rt;
          const points = [
            { x: sx, y: fromEdge },
            { x: sx, y: gy },
            { x: tx, y: gy },
            { x: tx, y: toEdge },
          ];
          if (!collides(points, from, [a, b], boxes, placed)) return points;
        }
      }
    }
  }
  return undefined;
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
  const base = columnsOf(steps, transitions, (id) => pathOf(id) === 'main');
  const { back } = base;
  const staged = stagedColumns(steps, transitions, (id) => pathOf(id) === 'main', base);
  const column = staged?.column ?? base.column;
  const top = staged !== undefined ? FLOW_STAGE_HEAD : 0;

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
  let y = top;
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

  // 되돌아가는 선은 두 카드 바로 위나 아래 빈 줄로 건넌다. 그 줄이 막히면 그림 맨 아래 여백으로 돌린다
  let backCount = 0;
  const placed: Segment[] = [];
  const routes: FlowTransitionRoute[] = transitions.map((t) => {
    const a = boxOf.get(t.from)!;
    const b = boxOf.get(t.to)!;
    const isBack = back.has(t.id) || b.column <= a.column;
    let points: LayoutPoint[];
    if (isBack) {
      const near = nearBackRoute(a, b, t.from, boxes, placed);
      if (near !== undefined) {
        points = near;
      } else {
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
      }
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
      ...(t.label !== undefined || t.actors !== undefined ? { labelAt: mid } : {}),
      back: isBack,
    };
  });

  const width = FLOW_HEAD_WIDTH + columns * (FLOW_STEP_WIDTH + COLUMN_GAP) + PAD_RIGHT;
  const stages: FlowStage[] = (staged?.stages ?? []).map((st) => ({
    label: st.label,
    x: round2(FLOW_HEAD_WIDTH + st.first * (FLOW_STEP_WIDTH + COLUMN_GAP)),
    width: round2((st.last - st.first + 1) * (FLOW_STEP_WIDTH + COLUMN_GAP)),
    side: st.side,
  }));
  return {
    width: round2(width),
    height: round2(height + (backCount > 0 ? BACK_LANE_GAP * (backCount + 1) : 0)),
    lanes,
    stages,
    steps: boxes,
    transitions: routes,
  };
}

/**
 * 그릴 흐름 레벨. 서비스가 그려지지 않는 흐름은 들어갈 자리가 없어서 뺀다.
 * service가 없는 흐름은 전체 바로 아래 독립 레벨이다. 정렬은 흐름 id 순이다
 */
export function computeFlowLevels(validated: ValidatedIr): FlowLevel[] {
  const flows = [...(validated.ir.flows ?? [])].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return flows
    .filter((f) => f.service === undefined || validated.drawableNodeIds.has(f.service))
    .map((f) => ({
      id: `${FLOW_LEVEL_PREFIX}${f.id}`,
      flowId: f.id,
      ...(f.service !== undefined ? { service: f.service } : {}),
      title: f.title,
      trail: [
        'root',
        ...(f.service !== undefined ? [`service:${f.service}`] : []),
        `${FLOW_LEVEL_PREFIX}${f.id}`,
      ],
      flow: f,
      layout: computeFlowLayout(f, validated.drawableStepIds, validated.drawableTransitionIds),
    }));
}
