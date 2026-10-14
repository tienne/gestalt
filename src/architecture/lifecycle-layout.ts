import { columnsOf, stepPathOf } from './flow-layout.js';
import { textUnits, type LayoutPoint } from './layout.js';
import type {
  ArchitectureFlow,
  FlowPath,
  FlowStep,
  FlowStepOutcome,
  FlowTransition,
  LineStyle,
} from './types.js';

export type LifecycleBand = 'rail' | 'recovery' | 'terminal';

export const LIFECYCLE_BAND_TEXT: Record<LifecycleBand, string> = {
  rail: '진행 단계',
  recovery: '대기와 복구',
  terminal: '끝 상태',
};

export interface LifecycleState {
  /** 단계의 state 값 그대로. 같은 값을 단 단계 여럿은 상태 하나로 합친다 */
  state: string;
  band: LifecycleBand;
  terminal: boolean;
  /** terminal 상태만. 비우면 끝은 났는데 어떻게 끝났는지 적지 않은 것이다 */
  outcome?: FlowStepOutcome;
  /** 이 상태를 단 단계 id. 흐름에 적힌 순서다 */
  steps: string[];
  /** 카드를 누르면 열리는 단계. steps의 첫째다 */
  rep: string;
  /** 모든 단계가 문서로만 확인됐으면 true. 카드 테두리를 점선으로 그린다 */
  docOnly: boolean;
}

export interface LifecycleTransition {
  /** 대표 전이 id. 선을 누르면 이 전이 서랍이 열린다 */
  id: string;
  from: string;
  to: string;
  /** 선 위 글자. 상태 없는 단계를 지나며 모은 조건과 누른 것이다 */
  label: string;
  /** 전이에 글자가 하나도 없어 도착 단계 이름을 빌려 쓴 경우 */
  borrowed: boolean;
  /** 합친 원래 전이 id */
  transitions: string[];
  path: FlowPath;
  lineStyle: LineStyle;
}

export interface LifecycleModel {
  states: LifecycleState[];
  transitions: LifecycleTransition[];
}

export interface LifecycleCounts {
  phases: number;
  recovery: number;
  terminal: number;
  states: number;
  transitions: number;
}

/** 상태 흐름 한 장의 예산. 넘으면 그리긴 하되 경고로 흐름을 나누라고 알린다 */
export const LIFECYCLE_BUDGET: LifecycleCounts = {
  phases: 5,
  recovery: 2,
  terminal: 2,
  states: 9,
  transitions: 10,
};

const COUNT_TEXT: Record<keyof LifecycleCounts, string> = {
  phases: '진행 단계',
  recovery: '대기와 복구',
  terminal: '끝 상태',
  states: '전체 상태',
  transitions: '전이',
};

function transitionText(t: FlowTransition): string {
  if (t.trigger !== undefined || t.condition !== undefined) {
    return [t.condition, t.trigger].filter((x) => x !== undefined).join(' ');
  }
  return t.label ?? '';
}

/**
 * 흐름에서 상태와 상태 사이 전이를 뽑는다. state가 없는 단계는 건너뛰고 그 앞뒤 전이를 이어 붙인다.
 * 알림 발송처럼 상태를 안 바꾸는 단계가 상태 흐름에 끼면 대상이 거치는 상태가 아니라 일의 순서가 된다
 */
export function deriveLifecycle(
  flow: ArchitectureFlow,
  drawableSteps: ReadonlySet<string>,
  drawableTransitions: ReadonlySet<string>,
): LifecycleModel {
  const steps = flow.steps.filter((s) => drawableSteps.has(s.id));
  const stepById = new Map(steps.map((s) => [s.id, s]));
  const transitions = flow.transitions.filter(
    (t) => drawableTransitions.has(t.id) && stepById.has(t.from) && stepById.has(t.to),
  );
  const pathOf = stepPathOf(transitions);
  const { column, back } = columnsOf(steps, transitions, (id) => pathOf(id) === 'main');
  const out = new Map<string, FlowTransition[]>();
  for (const t of transitions) out.set(t.from, [...(out.get(t.from) ?? []), t]);

  const grouped = new Map<string, FlowStep[]>();
  for (const s of steps) {
    if (s.state === undefined) continue;
    grouped.set(s.state, [...(grouped.get(s.state) ?? []), s]);
  }
  const declared = [...grouped.keys()];

  const merged = new Map<string, LifecycleTransition>();
  for (const src of steps) {
    if (src.state === undefined) continue;
    const seen = new Set<string>([src.id]);
    const record = (from: string, dest: FlowStep, chain: FlowTransition[]): void => {
      const texts = chain.map(transitionText).filter((x) => x !== '');
      const label = texts.length > 0 ? texts.join(', ') : dest.label;
      const solid = chain.every((t) => t.lineStyle === 'solid');
      const main = chain.every((t) => t.path === 'main');
      const lead = chain.find((t) => transitionText(t) !== '') ?? chain[chain.length - 1]!;
      const key = `${from}\u0000${dest.state!}`;
      const prev = merged.get(key);
      if (prev === undefined) {
        merged.set(key, {
          id: lead.id,
          from,
          to: dest.state!,
          label,
          borrowed: texts.length === 0,
          transitions: chain.map((t) => t.id),
          path: main ? 'main' : 'side',
          lineStyle: solid ? 'solid' : 'dashed',
        });
        return;
      }
      const labels = prev.borrowed ? [] : prev.label.split(', ');
      if (texts.length > 0) {
        for (const x of texts) if (!labels.includes(x)) labels.push(x);
      }
      merged.set(key, {
        ...prev,
        label: labels.length > 0 ? labels.join(', ') : prev.label,
        borrowed: labels.length === 0,
        transitions: [...new Set([...prev.transitions, ...chain.map((t) => t.id)])],
        path: prev.path === 'main' || main ? 'main' : 'side',
        lineStyle: prev.lineStyle === 'solid' || solid ? 'solid' : 'dashed',
      });
    };
    const walk = (at: string, chain: FlowTransition[]): void => {
      for (const t of out.get(at) ?? []) {
        const next = [...chain, t];
        const dest = stepById.get(t.to)!;
        if (dest.state === undefined) {
          if (seen.has(dest.id)) continue;
          seen.add(dest.id);
          walk(dest.id, next);
          continue;
        }
        // 같은 상태 안에서 앞으로만 간 건 상태가 안 바뀐 것이다. 되돌아와 다시 들어간 것만 고리로 남긴다
        if (dest.state === src.state && dest.id !== src.id && !next.some((x) => back.has(x.id))) {
          continue;
        }
        record(src.state!, dest, next);
      }
    };
    walk(src.id, []);
  }

  const states: LifecycleState[] = declared.map((state) => {
    const list = grouped.get(state)!;
    const end = list.find((s) => s.terminal === true);
    const main = list.some((s) => pathOf(s.id) === 'main');
    const outcome = end?.outcome;
    const band: LifecycleBand =
      end !== undefined
        ? main && (outcome === undefined || outcome === 'done')
          ? 'rail'
          : 'terminal'
        : main
          ? 'rail'
          : 'recovery';
    return {
      state,
      band,
      terminal: end !== undefined,
      ...(outcome !== undefined ? { outcome } : {}),
      steps: list.map((s) => s.id),
      rep: list[0]!.id,
      docOnly: list.every((s) =>
        s.evidence.every((ev) => ev.type !== 'code' && ev.type !== 'spec'),
      ),
    };
  });
  // 진행 줄은 흐름의 열 순서를 따르고 정상 완료는 그 끝에 선다
  const colOf = (s: LifecycleState): number => Math.min(...s.steps.map((id) => column.get(id)!));
  const rank = new Map(declared.map((s, i) => [s, i]));
  states.sort(
    (a, b) =>
      Number(a.terminal) - Number(b.terminal) ||
      colOf(a) - colOf(b) ||
      rank.get(a.state)! - rank.get(b.state)!,
  );
  const order = new Map(states.map((s, i) => [s.state, i]));
  const lifecycleTransitions = [...merged.values()].sort(
    (a, b) =>
      order.get(a.from)! - order.get(b.from)! ||
      order.get(a.to)! - order.get(b.to)! ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return { states, transitions: lifecycleTransitions };
}

// 띠 단위로 센다. 정상 완료는 진행 단계 띠 끝에 서므로 끝 상태 예산이 아니라 진행 단계 예산을 쓴다
export function lifecycleCounts(model: LifecycleModel): LifecycleCounts {
  return {
    phases: model.states.filter((s) => s.band === 'rail').length,
    recovery: model.states.filter((s) => s.band === 'recovery').length,
    terminal: model.states.filter((s) => s.band === 'terminal').length,
    states: model.states.length,
    transitions: model.transitions.length,
  };
}

/** 예산을 넘은 항목을 사람이 읽는 글로. 안 넘었으면 빈 배열이다 */
export function lifecycleOverBudget(counts: LifecycleCounts): string[] {
  return (Object.keys(LIFECYCLE_BUDGET) as (keyof LifecycleCounts)[])
    .filter((k) => counts[k] > LIFECYCLE_BUDGET[k])
    .map((k) => `${COUNT_TEXT[k]} ${counts[k]}개 (예산 ${LIFECYCLE_BUDGET[k]})`);
}

// 끝 상태 카드는 결과 배지, 상태 코드, 단계 이름을 한 줄에 싣는다. 168이면 영문 코드가 잘린다
export const LIFECYCLE_BOX_W = 196;
export const LIFECYCLE_BOX_H = 60;
const PAD_X = 24;
const BAND_HEAD = 34;
const BAND_PAD_BOTTOM = 20;
const BAND_GAP_MIN = 40;
const TRACK = 22;
const LANE = 22;
const COL_GAP_MIN = 72;
const COL_GAP_MAX = 240;
const LOWER_GAP = 40;
const LABEL_UNIT = 6;
const TIP_LENGTH = 8;
const TIP_HALF = 4.5;

export interface LifecycleBox {
  state: string;
  band: LifecycleBand;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LifecycleBandRect {
  band: LifecycleBand;
  y: number;
  height: number;
  count: number;
}

export interface LifecycleRoute {
  id: string;
  from: string;
  to: string;
  points: LayoutPoint[];
  tip: LayoutPoint[];
  labelAt: LayoutPoint;
  labelAnchor: 'middle' | 'start';
  /** 앞 상태나 같은 상태로 다시 들어가는 선. 재시도와 되돌리기가 어디로 들어가는지 글자 앞에 표시한다 */
  back: boolean;
}

export interface LifecycleLayout {
  width: number;
  height: number;
  bands: LifecycleBandRect[];
  boxes: LifecycleBox[];
  /** model.transitions와 같은 순서다. 원래 전이 하나가 여러 상태 전이에 걸쳐 쓰이면 대표 id가 겹칠 수 있어 순서로 맞춘다 */
  routes: LifecycleRoute[];
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function labelWidth(text: string): number {
  return textUnits(text) * LABEL_UNIT;
}

/** 구간 여럿을 겹치지 않게 줄에 나눠 담는다. 짧은 구간부터 아래 줄을 차지해 긴 구간이 바깥을 감싼다 */
function assignTracks(spans: { key: string; lo: number; hi: number }[]): Map<string, number> {
  const rows: { lo: number; hi: number }[][] = [];
  const out = new Map<string, number>();
  const sorted = [...spans].sort(
    (a, b) => a.hi - a.lo - (b.hi - b.lo) || a.lo - b.lo || (a.key < b.key ? -1 : 1),
  );
  for (const s of sorted) {
    let row = rows.findIndex((r) => r.every((o) => s.hi + 8 < o.lo || s.lo - 8 > o.hi));
    if (row === -1) {
      rows.push([]);
      row = rows.length - 1;
    }
    rows[row]!.push(s);
    out.set(s.key, row);
  }
  return out;
}

function tipOf(points: LayoutPoint[]): { points: LayoutPoint[]; tip: LayoutPoint[] } {
  const q = points[points.length - 1]!;
  const p = points[points.length - 2]!;
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const dx = (q.x - p.x) / len;
  const dy = (q.y - p.y) / len;
  const base = { x: q.x - dx * TIP_LENGTH, y: q.y - dy * TIP_LENGTH };
  const tip = [
    { x: round2(q.x), y: round2(q.y) },
    { x: round2(base.x - dy * TIP_HALF), y: round2(base.y + dx * TIP_HALF) },
    { x: round2(base.x + dy * TIP_HALF), y: round2(base.y - dx * TIP_HALF) },
  ];
  const line = [...points.slice(0, -1), { x: round2(base.x), y: round2(base.y) }];
  return { points: line.map((pt) => ({ x: round2(pt.x), y: round2(pt.y) })), tip };
}

/**
 * 상태 흐름 좌표. 진행 단계 줄, 대기와 복구 띠, 끝 상태 띠를 위에서부터 쌓는다. elkjs 없이 격자로 놓는다.
 * 아래 두 띠의 상자는 가로 자리를 서로 나눠 쓴다. 진행 줄에서 끝 상태로 내려가는 선이 대기 띠 상자를 뚫지 않게 하려고다
 */
export function computeLifecycleLayout(model: LifecycleModel): LifecycleLayout {
  const W = LIFECYCLE_BOX_W;
  const H = LIFECYCLE_BOX_H;
  const byState = new Map(model.states.map((s) => [s.state, s]));
  const rail = model.states.filter((s) => s.band === 'rail');
  const lower = model.states.filter((s) => s.band !== 'rail');
  const bandsUsed = (['rail', 'recovery', 'terminal'] as const).filter((b) =>
    model.states.some((s) => s.band === b),
  );
  const bandIndex = new Map(bandsUsed.map((b, i) => [b, i]));

  // 진행 줄 이웃끼리 가는 선은 사이에 글자가 앉으니 그 폭만큼 벌린다
  const x = new Map<string, number>();
  let cx = PAD_X;
  rail.forEach((s, i) => {
    if (i > 0) {
      const prev = rail[i - 1]!;
      const between = model.transitions.filter(
        (t) =>
          (t.from === prev.state && t.to === s.state) ||
          (t.from === s.state && t.to === prev.state),
      );
      const need = Math.max(0, ...between.map((t) => labelWidth(t.label) + 24));
      cx += Math.min(COL_GAP_MAX, Math.max(COL_GAP_MIN, need));
    }
    x.set(s.state, cx);
    cx += W;
  });
  const railRight = cx;

  // 아래 띠 상자는 처음 들어오는 상태 바로 오른쪽 아래를 노린다. 자리가 차 있으면 오른쪽으로 민다
  const taken: { lo: number; hi: number }[] = [];
  const fit = (want: number): number => {
    let at = Math.max(PAD_X, want);
    for (;;) {
      const clash = taken.find((o) => at < o.hi + LOWER_GAP && at + W + LOWER_GAP > o.lo);
      if (clash === undefined) return at;
      at = clash.hi + LOWER_GAP;
    }
  };
  for (const band of ['recovery', 'terminal'] as const) {
    const pending = lower.filter((s) => s.band === band);
    const wantOf = (s: LifecycleState): number => {
      const from = model.transitions
        .filter((t) => t.to === s.state && t.from !== s.state && x.has(t.from))
        .map((t) => x.get(t.from)!);
      return from.length > 0 ? Math.min(...from) + W / 2 + 12 : railRight;
    };
    // 아직 자리가 없는 상태에서만 들어오는 상자는 앞 상자가 놓인 뒤에 다시 잰다
    const placed = new Set<string>();
    while (placed.size < pending.length) {
      const ready = pending.filter((s) => !placed.has(s.state));
      const known = ready.filter((s) =>
        model.transitions.some((t) => t.to === s.state && t.from !== s.state && x.has(t.from)),
      );
      const next = (known.length > 0 ? known : ready).sort(
        (a, b) => wantOf(a) - wantOf(b) || model.states.indexOf(a) - model.states.indexOf(b),
      )[0]!;
      const at = fit(wantOf(next));
      x.set(next.state, at);
      taken.push({ lo: at, hi: at + W });
      placed.add(next.state);
    }
  }

  const route = model.transitions.map((t) => ({
    t,
    a: byState.get(t.from)!,
    b: byState.get(t.to)!,
  }));
  type Kind = 'self' | 'next' | 'arc' | 'down' | 'up';
  const bandOrder = (s: LifecycleState): string[] =>
    model.states
      .filter((o) => o.band === s.band)
      .sort((p, q) => x.get(p.state)! - x.get(q.state)!)
      .map((o) => o.state);
  const kindOf = (a: LifecycleState, b: LifecycleState): Kind => {
    if (a.state === b.state) return 'self';
    const ia = bandIndex.get(a.band)!;
    const ib = bandIndex.get(b.band)!;
    if (ia < ib) return 'down';
    if (ia > ib) return 'up';
    const row = bandOrder(a);
    return row.indexOf(b.state) === row.indexOf(a.state) + 1 ? 'next' : 'arc';
  };
  const kinds = route.map((r) => kindOf(r.a, r.b));

  // 상자 위아래 변에 선 끝을 고르게 나눠 꽂는다. 다른 끝이 왼쪽인 선이 왼쪽 자리를 받아 서로 덜 엇갈린다
  const ports = new Map<string, { key: string; other: number }[]>();
  const addPort = (state: string, side: 'top' | 'bottom', key: string, other: number): void => {
    const k = `${state}\u0000${side}`;
    ports.set(k, [...(ports.get(k) ?? []), { key, other }]);
  };
  route.forEach((r, i) => {
    const xa = x.get(r.a.state)!;
    const xb = x.get(r.b.state)!;
    const k = kinds[i]!;
    if (k === 'self') {
      addPort(r.a.state, 'top', `${i}:out`, xa + W);
      addPort(r.a.state, 'top', `${i}:in`, xa - 1);
    } else if (k === 'arc') {
      addPort(r.a.state, 'top', `${i}:out`, xb);
      addPort(r.b.state, 'top', `${i}:in`, xa);
    } else if (k === 'down') {
      addPort(r.a.state, 'bottom', `${i}:out`, xb);
      addPort(r.b.state, 'top', `${i}:in`, xa);
    } else if (k === 'up') {
      addPort(r.a.state, 'top', `${i}:out`, xb);
      addPort(r.b.state, 'bottom', `${i}:in`, xa);
    }
  });
  const portX = new Map<string, number>();
  for (const [k, list] of ports) {
    const state = k.split('\u0000')[0]!;
    const left = x.get(state)!;
    const sorted = [...list].sort((p, q) => p.other - q.other || (p.key < q.key ? -1 : 1));
    sorted.forEach((p, j) => portX.set(p.key, round2(left + (W * (j + 1)) / (sorted.length + 1))));
  }

  // 같은 띠 위로 넘어가는 선의 줄, 띠 사이 틈의 줄
  const laneOf = assignTracks(
    route.flatMap((r, i) =>
      kinds[i] === 'self' || kinds[i] === 'arc'
        ? [
            {
              key: `${r.a.band}\u0000${i}`,
              lo: Math.min(portX.get(`${i}:out`)!, portX.get(`${i}:in`)!),
              hi: Math.max(portX.get(`${i}:out`)!, portX.get(`${i}:in`)!),
            },
          ]
        : [],
    ),
  );
  const lanesPerBand = new Map<LifecycleBand, number>();
  route.forEach((r, i) => {
    const lane = laneOf.get(`${r.a.band}\u0000${i}`);
    if (lane === undefined) return;
    lanesPerBand.set(r.a.band, Math.max(lanesPerBand.get(r.a.band) ?? 0, lane + 1));
  });
  // 틈 g는 띠 g와 g+1 사이다. 내려가는 선은 출발 띠 바로 아래 틈, 올라가는 선은 출발 띠 바로 위 틈을 쓴다
  const gapOf = (i: number): number => {
    const r = route[i]!;
    const ia = bandIndex.get(r.a.band)!;
    return kinds[i] === 'down' ? ia : ia - 1;
  };
  const trackSpans = new Map<number, { key: string; lo: number; hi: number }[]>();
  route.forEach((_, i) => {
    if (kinds[i] !== 'down' && kinds[i] !== 'up') return;
    const g = gapOf(i);
    const a = portX.get(`${i}:out`)!;
    const b = portX.get(`${i}:in`)!;
    trackSpans.set(g, [
      ...(trackSpans.get(g) ?? []),
      { key: String(i), lo: Math.min(a, b), hi: Math.max(a, b) },
    ]);
  });
  const trackOf = new Map<number, number>();
  const tracksInGap = new Map<number, number>();
  for (const [g, spans] of trackSpans) {
    const assigned = assignTracks(spans);
    for (const [key, row] of assigned) trackOf.set(Number(key), row);
    tracksInGap.set(g, Math.max(...assigned.values()) + 1);
  }

  // 띠를 위에서부터 쌓는다
  const bands: LifecycleBandRect[] = [];
  const boxTop = new Map<LifecycleBand, number>();
  const gapTop: number[] = [];
  let y = 0;
  bandsUsed.forEach((band, i) => {
    const lanes = lanesPerBand.get(band) ?? 0;
    const top = y;
    const boxesAt = top + BAND_HEAD + (lanes > 0 ? lanes * LANE + 10 : 0);
    boxTop.set(band, boxesAt);
    const height = boxesAt + H + BAND_PAD_BOTTOM - top;
    bands.push({
      band,
      y: top,
      height,
      count: model.states.filter((s) => s.band === band).length,
    });
    y = top + height;
    if (i < bandsUsed.length - 1) {
      gapTop.push(y);
      y += Math.max(BAND_GAP_MIN, (tracksInGap.get(i) ?? 0) * TRACK + 18);
    }
  });
  const height = y;

  const boxes: LifecycleBox[] = model.states.map((s) => ({
    state: s.state,
    band: s.band,
    x: round2(x.get(s.state)!),
    y: round2(boxTop.get(s.band)!),
    width: W,
    height: H,
  }));
  const boxOf = new Map(boxes.map((b) => [b.state, b]));

  const routes: LifecycleRoute[] = route.map((r, i) => {
    const A = boxOf.get(r.a.state)!;
    const B = boxOf.get(r.b.state)!;
    const k = kinds[i]!;
    const po = portX.get(`${i}:out`) ?? 0;
    const pi = portX.get(`${i}:in`) ?? 0;
    let pts: LayoutPoint[];
    let labelAt: LayoutPoint;
    let labelAnchor: 'middle' | 'start' = 'middle';
    let back = false;
    if (k === 'next') {
      const cy = A.y + H / 2;
      pts = [
        { x: A.x + W, y: cy },
        { x: B.x, y: cy },
      ];
      labelAt = { x: (A.x + W + B.x) / 2, y: cy - 6 };
    } else if (k === 'self' || k === 'arc') {
      const lane = laneOf.get(`${r.a.band}\u0000${i}`)!;
      const ly = A.y - 14 - lane * LANE;
      pts = [
        { x: po, y: A.y },
        { x: po, y: ly },
        { x: pi, y: ly },
        { x: pi, y: B.y },
      ];
      labelAt = { x: (po + pi) / 2, y: ly - 5 };
      back = k === 'self' || B.x < A.x;
    } else {
      const g = gapOf(i);
      const ty = gapTop[g]! + 14 + trackOf.get(i)! * TRACK;
      const fromY = k === 'down' ? A.y + H : A.y;
      const toY = k === 'down' ? B.y : B.y + H;
      pts = [
        { x: po, y: fromY },
        { x: po, y: ty },
        { x: pi, y: ty },
        { x: pi, y: toY },
      ];
      back = k === 'up';
      const run = Math.abs(pi - po);
      if (run >= Math.min(labelWidth(r.t.label) + 16, 120)) {
        labelAt = { x: (po + pi) / 2, y: ty - 5 };
      } else {
        // 가로로 지나는 길이 짧으면 글자를 도착 쪽 세로선 옆에 붙인다
        labelAt = { x: pi + 6, y: (ty + toY) / 2 + 4 };
        labelAnchor = 'start';
      }
    }
    const { points, tip } = tipOf(
      pts.filter((p, j) => j === 0 || p.x !== pts[j - 1]!.x || p.y !== pts[j - 1]!.y),
    );
    return {
      id: r.t.id,
      from: r.a.rep,
      to: r.b.rep,
      points,
      tip,
      labelAt: { x: round2(labelAt.x), y: round2(labelAt.y) },
      labelAnchor,
      back,
    };
  });

  const right = Math.max(
    railRight,
    ...boxes.map((b) => b.x + b.width),
    ...routes.map((r, i) =>
      r.labelAnchor === 'start'
        ? r.labelAt.x + labelWidth(model.transitions[i]!.label)
        : r.labelAt.x + labelWidth(model.transitions[i]!.label) / 2,
    ),
  );
  return { width: round2(right + PAD_X), height: round2(height), bands, boxes, routes };
}
