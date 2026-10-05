// 워커 없는 번들판을 쓴다. 기본 진입점은 web-worker 패키지를 찾다가 MCP stdio 서버에서 경고를 찍을 수 있다
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode, LayoutOptions } from 'elkjs/lib/elk.bundled.js';
import { flowBadgeText, LANE_TITLES, NODE_KIND_SHORT, platformChipText } from './kind-text.js';
import type {
  ArchitectureIr,
  ArchitectureNode,
  DisplayKind,
  EdgeKind,
  NodeKind,
  Platform,
  WebHosting,
} from './types.js';
import { ALL_PACKS_VOCABULARY, type PackLaneId } from './packs/index.js';
import {
  chipTextOverride,
  displayKindOf,
  EDGE_KINDS,
  ENVIRONMENT_ORDER,
  hasCardDescription,
} from './types.js';

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutPoint {
  x: number;
  y: number;
}

export interface LayoutEdge {
  id: string;
  points: LayoutPoint[];
}

/** 레인 한 칸. 같은 레인 노드들의 좌우 끝에 여백을 붙인 범위다. 구간이 있으면 레인 하나가 구간 하나다 */
export interface LayoutLane {
  /** 종류 레인이면 LaneId, 구간이면 `stage:<순번>` */
  id: string;
  title: string;
  x: number;
  width: number;
  count: number;
}

export interface LayoutResult {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** 왼쪽부터 x 순. 노드가 없는 레인은 아예 없다 */
  lanes: LayoutLane[];
  /** elk 배치 뒤 자리를 옮긴 노드. 이 노드에 붙은 elk 경로는 경유점으로 쓰지 않는다 */
  movedNodeIds?: string[];
  /** 제품 띠. 여러 제품을 합친 그림을 띠로 나눠 쌓았을 때만 있다 */
  regions?: LayoutRegions;
  /** 머리 카드와 그 아래 멤버 카드를 두르는 테두리. 마이크로 프론트엔드 서비스를 앱 묶음으로 보일 때만 있다 */
  frames?: LayoutFrame[];
}

/** 노드 좌표와 같은 기준의 사각형 */
export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutFrame extends LayoutRect {
  /** 머리 카드 id */
  id: string;
}

/** 가로 띠 한 줄. y는 띠 머리(구분선과 이름이 들어가는 줄)부터다 */
export interface LayoutBand {
  /** 0은 같이 쓰는 띠, i+1은 groups[i] 전용 띠 */
  band: number;
  y: number;
  height: number;
}

export interface LayoutRegions {
  /** 그룹 순서 그대로다. 제품 색도 이 순서로 정한다 */
  groups: Array<{ id: string; name: string }>;
  /** 위에서부터. 카드가 없는 띠는 없다 */
  bands: LayoutBand[];
  /** 노드 id → 띠 번호. 포커스 화면이 이걸로 다시 쌓는다 */
  bandOf: Record<string, number>;
  /** 둘 이상의 제품이 같이 쓰는 노드 id → 쓰는 제품 번호. 바로 이어진 전용 카드가 많은 제품부터다. 카드 위 제품 브릭이 이 순서로 그린다 */
  productsOf: Record<string, number[]>;
}

/**
 * 화면에 세로 띠로 그리는 칸. 레벨마다 같은 kind도 다른 레인에 설 수 있어서 kind와 따로 둔다.
 * unit은 서비스 레벨의 기능 영역 칸, external은 서버를 거쳐서만 닿는 칸이다
 */
export const LANE_IDS = Object.keys(ALL_PACKS_VOCABULARY.lanes) as PackLaneId[];
export type LaneId = PackLaneId;

/** 평면 그림의 레인. rank가 같은 kind는 같은 레인에 둬야 띠가 겹치지 않는다 */
export const KIND_LANE = Object.fromEntries(
  Object.entries(ALL_PACKS_VOCABULARY.nodeKinds).map(([k, d]) => [k, d.lane]),
) as Record<NodeKind, LaneId>;

/** 노드가 기본으로 서는 레인. MCP 도구는 endpoint와 같은 열이지만 레인 이름이 달라야 API로 안 읽힌다 */
export function laneOfNode(node: Pick<ArchitectureNode, 'kind' | 'protocol'>): LaneId {
  return displayKindOf(node) === 'mcp_tool' ? 'tool' : KIND_LANE[node.kind];
}

const LANE_PADDING_X = 20;

// 화면끼리, 기능 영역끼리 잇는 화면 이동은 요청 흐름이 아니다. elk에 넘기면 같은 레인 안에서 열을 여러 개로 벌려 그림이 옆으로 늘어난다
const STACKED_LANES: ReadonlySet<LaneId> = new Set<LaneId>(
  LANE_IDS.filter((l) => ALL_PACKS_VOCABULARY.lanes[l]!.stacked === true),
);

const GRAPH_OPTIONS: LayoutOptions = {
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.randomSeed': '1',
  'elk.partitioning.activate': 'true',
  // 레인 띠 사이 틈과 곡선이 꺾일 자리를 함께 잡는 간격이다
  'elk.layered.spacing.nodeNodeBetweenLayers': '96',
  'elk.spacing.nodeNode': '24',
  // 기본값(true)이면 연결 요소마다 따로 배치해 붙이므로 partition 순위가 요소 사이에서 안 지켜진다. 끝점이 비어 고립된 노드도 제 열에 서야 한다
  'elk.separateConnectedComponents': 'false',
};
// order를 받은 노드만 그 순서대로 레이어 안에 세운다. 나머지는 elk가 교차를 줄이는 자리에 둔다
const ORDERED_GRAPH_OPTIONS: LayoutOptions = {
  ...GRAPH_OPTIONS,
  'elk.layered.crossingMinimization.semiInteractive': 'true',
};

// 열 순위는 팩의 nodeKinds.rank에 있다
export const PARTITION_RANK = Object.fromEntries(
  Object.entries(ALL_PACKS_VOCABULARY.nodeKinds).map(([k, d]) => [k, d.rank]),
) as Record<NodeKind, number>;

/** 평면 그림에서 레인 순서가 화살표 반대라 오른쪽에서 왼쪽으로 그리는 엣지 */
export const FLAT_BACKWARD_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>(
  EDGE_KINDS.filter((k) => ALL_PACKS_VOCABULARY.edgeKinds[k]!.backward === true),
);

/** 환경 정렬 순위. 정한 환경이 앞이고 그 밖의 환경, 환경 없음 순이다 */
export function environmentRank(env: string | undefined): number {
  if (env === undefined) return ENVIRONMENT_ORDER.length + 1;
  const i = (ENVIRONMENT_ORDER as readonly string[]).indexOf(env);
  return i === -1 ? ENVIRONMENT_ORDER.length : i;
}

/** 환경 순서로 비교하고 같은 순위면 환경 이름, 그다음 tie로 가른다 */
export function compareEnvironment(
  a: string | undefined,
  b: string | undefined,
  tie: number = 0,
): number {
  const r = environmentRank(a) - environmentRank(b);
  if (r !== 0) return r;
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : tie;
}

/** 레이아웃 입력 노드. rank가 작을수록 왼쪽 열에 선다 */
export interface GraphLayoutNode {
  id: string;
  label: string;
  displayName?: string;
  displayNameInferred?: boolean;
  rank: number;
  lane: LaneId;
  /** 구간 순번. 구간이 있는 그림에서는 rank보다 앞서 열 순서를 정한다 */
  stage?: number;
  kind?: DisplayKind;
  /** 칩에 kind 표 대신 찍을 글자. component의 displayKind다 */
  chip?: string;
  /** 같은 레이어 안에서 위에서부터 설 순서. 준 노드끼리만 지켜진다 */
  order?: number;
  /** 둘째 줄 끝 플랫폼 칩 */
  platforms?: readonly Platform[];
  /** 웹 칩 글자를 정하는 서빙 방식 */
  webHosting?: WebHosting;
  /** 둘째 줄 글자. 없으면 displayName이 있을 때 label이 둘째 줄이다 */
  secondLine?: string;
  /** 이 서비스에 달린 흐름 수. 첫 줄 끝에 흐름 배지가 붙는다 */
  flows?: number;
  /** 이름 아래 설명 줄. 비거나 공백뿐이면 줄을 안 만든다 */
  description?: string;
}

export interface GraphLayoutEdge {
  id: string;
  from: string;
  to: string;
  /** 레인 순서가 화살표 반대인 엣지. elk에는 뒤집어 넘겨 왼쪽에서 오른쪽으로 놓이게 한다 */
  backward?: boolean;
}

const NODE_HEIGHT = 48;
// 표시 이름과 기술 이름을 두 줄로 쌓는 카드. 글자 수와 무관하게 고정해야 좌표가 입력에만 묶인다
export const NODE_HEIGHT_TWO_LINES = 60;
/** 이름 아래 설명 줄이 더하는 높이. 11px 글꼴의 16px 줄에 행 간격 2px다 */
export const NODE_DESC_LINE = 18;
// 설명 줄은 11px 글꼴 기준으로 잰다. 긴 설명이 카드를 끝없이 넓히지 않게 안쪽 폭은 상한까지만 늘리고 나머지는 말줄임으로 자른다
const DESC_CHAR_WIDTH = 5.5;
const DESC_MAX_INNER = 200;
/** "추정" 배지가 첫 줄에서 차지하는 폭. 앞 여백과 알약 테두리, 한글 두 자 */
export const INFERRED_BADGE_UNITS = 5;
/** 카드 왼쪽 색 띠와 안쪽 여백. 종류 칩은 이 뒤에서 시작한다 */
export const NODE_TEXT_LEFT = 12;
/** 글자 뒤 여백. 들어갈 레벨 표시(›)가 오른쪽 아래에 앉을 자리를 포함한다 */
export const NODE_TEXT_RIGHT = 20;
// 종류 칩: 아이콘과 좌우 여백, 칩 뒤 틈이 고정 폭이고 글자는 칩 글꼴(10.5px) 기준으로 잰다
const CHIP_FIXED_WIDTH = 33;
const CHIP_CHAR_WIDTH = 6.5;
// 플랫폼 칩: 앞 여백, 테두리와 좌우 안쪽 여백, 아이콘과 글자 사이가 고정 폭이고 글자는 10px 글꼴 기준이다
const PLATFORM_CHIP_FIXED_WIDTH = 4 + 2 + 8 + 11 + 3;
const PLATFORM_CHIP_CHAR_WIDTH = 6;
// 흐름 배지: 앞 여백, 좌우 안쪽 여백, 아이콘과 글자 사이가 고정 폭이고 글자는 10.5px 글꼴 기준이다
const FLOW_BADGE_FIXED_WIDTH = 6 + 12 + 12 + 3;
const FLOW_BADGE_CHAR_WIDTH = 6.5;

/** 흐름 배지가 첫 줄에서 차지하는 폭(px) */
export function flowBadgeWidth(count: number | undefined): number {
  return count === undefined || count === 0
    ? 0
    : FLOW_BADGE_FIXED_WIDTH + textUnits(flowBadgeText(count)) * FLOW_BADGE_CHAR_WIDTH;
}

/** 플랫폼 칩들이 둘째 줄에서 차지하는 폭(px) */
export function platformChipsWidth(
  platforms: readonly Platform[] | undefined,
  webHosting?: WebHosting,
): number {
  let w = 0;
  for (const p of platforms ?? []) {
    w +=
      PLATFORM_CHIP_FIXED_WIDTH +
      textUnits(platformChipText(p, webHosting)) * PLATFORM_CHIP_CHAR_WIDTH;
  }
  return w;
}

/** 종류 칩이 첫 줄에서 차지하는 폭(px) */
export function chipWidth(kind: DisplayKind | undefined, chip?: string): number {
  return kind === undefined
    ? 0
    : CHIP_FIXED_WIDTH + textUnits(chip ?? NODE_KIND_SHORT[kind]) * CHIP_CHAR_WIDTH;
}
export const NARROW_CHAR_WIDTH = 8;
const MIN_NODE_WIDTH = 120;
const MAX_NODE_WIDTH = 320;

// 한글 같은 전각 문자는 라틴 문자 두 칸을 먹는다. 실제 폰트 측정 대신 글자 수로 재야 서버 결과가 환경에 안 흔들린다
function charUnits(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x2e80 ? 2 : 1;
}

export function textUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += charUnits(ch);
  return units;
}

export interface MeasureExtras {
  chip?: string;
  platforms?: readonly Platform[];
  webHosting?: WebHosting;
  secondLine?: string;
  flows?: number;
  description?: string;
}

/**
 * 첫 줄은 종류 칩과 이름, 둘째 줄은 secondLine이 있으면 그것, 없고 표시 이름이 있으면 기술 이름이다.
 * 플랫폼 칩은 둘째 줄 끝에 붙는다. 첫 줄에 두면 칩 몫만큼 이름이 먼저 잘린다.
 * 폭은 두 줄 중 긴 쪽을 따른다
 */
export function measureNode(
  label: string,
  displayName?: string,
  displayNameInferred?: boolean,
  kind?: DisplayKind,
  extras: MeasureExtras = {},
): { width: number; height: number } {
  const name = displayName ?? label;
  const first =
    chipWidth(kind, extras.chip) +
    (textUnits(name) +
      (displayName !== undefined && displayNameInferred ? INFERRED_BADGE_UNITS : 0)) *
      NARROW_CHAR_WIDTH +
    flowBadgeWidth(extras.flows);
  const second = extras.secondLine ?? (displayName !== undefined ? label : undefined);
  const chips = platformChipsWidth(extras.platforms, extras.webHosting);
  const twoLines = second !== undefined || chips > 0;
  const inner = twoLines
    ? Math.max(first, textUnits(second ?? '') * NARROW_CHAR_WIDTH + chips)
    : first;
  const desc = hasCardDescription(extras.description);
  const descInner = desc
    ? Math.min(DESC_MAX_INNER, textUnits(extras.description!) * DESC_CHAR_WIDTH)
    : 0;
  const raw = Math.ceil(NODE_TEXT_LEFT + NODE_TEXT_RIGHT + Math.max(inner, descInner));
  return {
    width: Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, raw)),
    height: (twoLines ? NODE_HEIGHT_TWO_LINES : NODE_HEIGHT) + (desc ? NODE_DESC_LINE : 0),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// localeCompare는 실행 환경 로캘에 따라 순서가 달라질 수 있어 코드 유닛 비교로 고정한다
function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// 레벨마다 덧대는 rank 보정은 다 합쳐도 이보다 작다. 구간 순번에 곱해 앞자리로 두면 구간 안에서는 원래 순서가 그대로 남는다
const STAGE_RANK_STRIDE = 100;
/** 어느 구간에도 안 맞은 노드를 모으는 맨 끝 구간 이름 */
export const UNSTAGED_LABEL = '그 밖';

export interface StageAssignment {
  /** 노드 id → 구간 순번 */
  indexOf: Map<string, number>;
  /** 순번 순 구간 이름. 안 맞은 노드가 있으면 끝에 UNSTAGED_LABEL이 붙는다 */
  labels: string[];
  unstaged: number;
}

/** 노드마다 구간을 정한다. 이름으로 올린 구간이 먼저다. 그다음은 kinds와 repos가 맞는 첫 구간이다 */
export function assignStages(ir: ArchitectureIr): StageAssignment | undefined {
  const stages = ir.stages ?? [];
  if (stages.length === 0) return undefined;
  const named = new Map<string, number>();
  stages.forEach((st, i) => {
    for (const id of st.nodes ?? []) if (!named.has(id)) named.set(id, i);
  });
  const indexOf = new Map<string, number>();
  let unstaged = 0;
  for (const n of ir.nodes) {
    const byName = named.get(n.id);
    const byRule = stages.findIndex(
      (st) =>
        st.kinds !== undefined &&
        st.kinds.includes(n.kind) &&
        (st.repos === undefined || st.repos.includes(n.repo)),
    );
    const index = byName ?? (byRule >= 0 ? byRule : stages.length);
    if (index === stages.length) unstaged += 1;
    indexOf.set(n.id, index);
  }
  const labels = stages.map((st) => st.label);
  if (unstaged > 0) labels.push(UNSTAGED_LABEL);
  return { indexOf, labels, unstaged };
}

export async function computeLayout(
  ir: ArchitectureIr,
  drawableNodeIds: ReadonlySet<string>,
  drawableEdgeIds: ReadonlySet<string>,
): Promise<LayoutResult> {
  const staged = assignStages(ir);
  const nodes = ir.nodes
    .filter((n) => drawableNodeIds.has(n.id))
    .map((n) => ({
      id: n.id,
      label: n.label,
      ...(n.displayName !== undefined ? { displayName: n.displayName } : {}),
      ...(n.displayNameInferred ? { displayNameInferred: true } : {}),
      rank: PARTITION_RANK[n.kind],
      lane: laneOfNode(n),
      ...(staged !== undefined ? { stage: staged.indexOf.get(n.id)! } : {}),
      kind: displayKindOf(n),
      ...(chipTextOverride(n) !== undefined ? { chip: chipTextOverride(n)! } : {}),
      ...(n.environment !== undefined ? { order: environmentRank(n.environment) } : {}),
      ...(n.description !== undefined ? { description: n.description } : {}),
    }));
  const edges = ir.edges
    .filter((e) => drawableEdgeIds.has(e.id))
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      ...(FLAT_BACKWARD_EDGE_KINDS.has(e.kind) ? { backward: true } : {}),
    }));
  const laid = await computeGraphLayout(nodes, edges, staged?.labels);
  return stackBands(laid, bandGroupsOf(ir), ir.edges);
}

/**
 * IR과 무관한 노드와 엣지 목록으로 elkjs 좌표를 낸다. 드릴다운 레벨의 묶음 엣지처럼 IR에 없는 엣지도 받는다.
 * 같은 입력이면 같은 좌표가 나오게 입력과 출력을 id 순으로 정렬한다.
 */
export async function computeGraphLayout(
  nodeList: readonly GraphLayoutNode[],
  edgeList: readonly GraphLayoutEdge[],
  stageLabels?: readonly string[],
): Promise<LayoutResult> {
  const nodes = [...nodeList].sort(byId);
  const rankOf = (n: GraphLayoutNode): number =>
    stageLabels !== undefined && n.stage !== undefined
      ? n.stage * STAGE_RANK_STRIDE + n.rank
      : n.rank;
  const laneOf = new Map(nodes.map((n) => [n.id, n.lane]));
  // 끝점이 하나라도 빠진 엣지를 넘기면 ELK가 예외를 던진다
  const edges = edgeList
    .filter((e) => laneOf.has(e.from) && laneOf.has(e.to))
    .filter(
      (e) => !(laneOf.get(e.from) === laneOf.get(e.to) && STACKED_LANES.has(laneOf.get(e.from)!)),
    )
    .sort(byId);

  const ordered = nodes.some((n) => n.order !== undefined);
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: ordered ? ORDERED_GRAPH_OPTIONS : GRAPH_OPTIONS,
    children: nodes.map((n) => ({
      id: n.id,
      ...measureNode(n.label, n.displayName, n.displayNameInferred, n.kind, {
        ...(n.chip !== undefined ? { chip: n.chip } : {}),
        ...(n.platforms !== undefined ? { platforms: n.platforms } : {}),
        ...(n.webHosting !== undefined ? { webHosting: n.webHosting } : {}),
        ...(n.secondLine !== undefined ? { secondLine: n.secondLine } : {}),
        ...(n.flows !== undefined ? { flows: n.flows } : {}),
        ...(n.description !== undefined ? { description: n.description } : {}),
      }),
      // 레이어 안 카드를 왼쪽에 맞춰야 레인이 들쭉날쭉한 열이 아니라 한 줄로 읽힌다
      layoutOptions: {
        'elk.partitioning.partition': String(rankOf(n)),
        'elk.alignment': 'LEFT',
        ...(n.order !== undefined ? { 'elk.position': `(0,${n.order})` } : {}),
      },
    })),
    edges: edges.map((e) =>
      e.backward
        ? { id: e.id, sources: [e.to], targets: [e.from] }
        : { id: e.id, sources: [e.from], targets: [e.to] },
    ),
  };
  const laid = await new ELK().layout(graph);

  const outNodes: LayoutNode[] = (laid.children ?? [])
    .map((c) => ({
      id: c.id,
      x: round2(c.x ?? 0),
      y: round2(c.y ?? 0),
      width: round2(c.width ?? 0),
      height: round2(c.height ?? 0),
    }))
    .sort(byId);
  // 한 레이어(같은 x) 카드는 폭을 가장 넓은 카드에 맞춘다. 레이어 폭이 원래 그 값이라 옆 레이어와 겹치지 않는다
  const columnWidth = new Map<number, number>();
  for (const n of outNodes) columnWidth.set(n.x, Math.max(columnWidth.get(n.x) ?? 0, n.width));
  for (const n of outNodes) n.width = columnWidth.get(n.x)!;

  const outEdges: LayoutEdge[] = ((laid.edges ?? []) as ElkExtendedEdge[])
    .map((e) => ({
      id: e.id,
      points: (e.sections ?? []).flatMap((s) =>
        [s.startPoint, ...(s.bendPoints ?? []), s.endPoint].map((p) => ({
          x: round2(p.x),
          y: round2(p.y),
        })),
      ),
    }))
    .sort(byId);

  return {
    width: round2(laid.width ?? 0),
    height: round2(laid.height ?? 0),
    nodes: outNodes,
    edges: outEdges,
    lanes: computeLanes(nodes, outNodes, stageLabels),
  };
}

// 레인 경계를 서버에서 박아야 브라우저 글꼴이나 창 크기와 무관하게 같은 그림이 나온다
function computeLanes(
  input: readonly GraphLayoutNode[],
  placed: readonly LayoutNode[],
  stageLabels?: readonly string[],
): LayoutLane[] {
  const titleOf = new Map<string, string>();
  const laneOf = new Map(
    input.map((n) => {
      if (stageLabels !== undefined && n.stage !== undefined) {
        const id = `stage:${n.stage}`;
        titleOf.set(id, stageLabels[n.stage] ?? UNSTAGED_LABEL);
        return [n.id, id];
      }
      titleOf.set(n.lane, LANE_TITLES[n.lane]);
      return [n.id, n.lane];
    }),
  );
  const spans = new Map<string, { left: number; right: number; count: number }>();
  for (const box of placed) {
    const lane = laneOf.get(box.id);
    if (lane === undefined) continue;
    const span = spans.get(lane);
    if (span) {
      span.left = Math.min(span.left, box.x);
      span.right = Math.max(span.right, box.x + box.width);
      span.count += 1;
    } else {
      spans.set(lane, { left: box.x, right: box.x + box.width, count: 1 });
    }
  }
  return [...spans.entries()]
    .map(([id, s]) => ({
      id,
      title: titleOf.get(id)!,
      x: round2(s.left - LANE_PADDING_X),
      width: round2(s.right - s.left + LANE_PADDING_X * 2),
      count: s.count,
    }))
    .sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const PIN_GAP = 24;

/**
 * 노드 하나를 제 열 맨 위로 올린다. 그 위에 있던 카드는 올린 카드 높이만큼 내려 원래 자리에 들어간다.
 * 자리가 바뀐 카드에 붙은 elk 경로는 버린다. 옛 좌표 기준이라 경유점으로 쓰면 엉뚱한 데서 꺾인다
 */
export function pinToColumnTop(layout: LayoutResult, nodeId: string): LayoutResult {
  const target = layout.nodes.find((n) => n.id === nodeId);
  if (!target) return layout;
  const above = layout.nodes.filter((n) => n.x === target.x && n.y < target.y);
  if (above.length === 0) return layout;
  const top = Math.min(...above.map((n) => n.y));
  const moved = new Set([nodeId, ...above.map((n) => n.id)]);
  const shift = target.height + PIN_GAP;
  const nodes = layout.nodes.map((n) => {
    if (n.id === nodeId) return { ...n, y: top };
    if (moved.has(n.id)) return { ...n, y: round2(n.y + shift) };
    return { ...n };
  });
  const bottom = Math.max(...nodes.map((n) => n.y + n.height));
  return {
    ...layout,
    height: round2(Math.max(layout.height, bottom)),
    nodes,
    edges: layout.edges.map((e) => ({ ...e })),
    movedNodeIds: [...moved].sort(),
  };
}

/** 열을 나눠 세운 나무. 열(x)은 elk가 정한 그대로 두고 위아래 자리만 나무 순서로 다시 잡는다 */
export interface TreeStack {
  root: string;
  /** 노드 id → 자식 id. 이 순서대로 위에서부터 쌓는다 */
  children: ReadonlyMap<string, readonly string[]>;
}

/**
 * 나무를 위에서부터 깊이 우선으로 쌓는다. 잎은 차례로 한 칸씩 내려가고 부모는 첫 자식과 같은 높이에 선다.
 * 형제 하위 나무끼리 세로 구간이 안 겹쳐서 어느 화면이 어느 앱 것인지 블록으로 읽힌다. elk는 교차만 줄여서 앱끼리 섞어 놓는다
 */
export function stackTree(layout: LayoutResult, tree: TreeStack): LayoutResult {
  const byId = new Map(layout.nodes.map((n) => [n.id, n]));
  if (!byId.has(tree.root)) return layout;
  const placed = new Map<string, number>();
  const top = byId.get(tree.root)!.y;
  let cursor = top;
  const visit = (id: string, seen: Set<string>): void => {
    const node = byId.get(id);
    if (!node || seen.has(id)) return;
    seen.add(id);
    const start = cursor;
    for (const c of tree.children.get(id) ?? []) visit(c, seen);
    placed.set(id, round2(start));
    cursor = Math.max(cursor, start + node.height + PIN_GAP);
  };
  visit(tree.root, new Set());
  const nodes = layout.nodes.map((n) => ({ ...n, y: placed.get(n.id) ?? n.y }));
  const moved = nodes.filter((n, i) => n.y !== layout.nodes[i]!.y).map((n) => n.id);
  const bottom = Math.max(...nodes.map((n) => n.y + n.height));
  return {
    ...layout,
    height: round2(Math.max(layout.height, bottom)),
    nodes,
    edges: layout.edges.map((e) => ({ ...e })),
    movedNodeIds: [...new Set([...(layout.movedNodeIds ?? []), ...moved])].sort(),
  };
}

/**
 * ids로만 이뤄진 열을 통째로 올리거나 내려 그 열 맨 위 카드가 기준 카드와 같은 높이에 서게 한다.
 * 맨 위로 올린 소유자 카드와 그 서빙 사슬이 한 줄로 읽혀야 하는데, elk는 사슬을 소유자의 원래 자리 옆에 두기 때문이다
 */
export function alignColumnsTo(
  layout: LayoutResult,
  anchorId: string,
  nodeIds: readonly string[],
): LayoutResult {
  const anchor = layout.nodes.find((n) => n.id === anchorId);
  if (!anchor) return layout;
  const members = new Set(nodeIds);
  const columns = new Map<number, LayoutNode[]>();
  for (const n of layout.nodes) columns.set(n.x, [...(columns.get(n.x) ?? []), n]);
  const shift = new Map<string, number>();
  for (const col of columns.values()) {
    if (col.some((n) => n.id === anchorId) || !col.every((n) => members.has(n.id))) continue;
    const dy = anchor.y - Math.min(...col.map((n) => n.y));
    if (dy !== 0) for (const n of col) shift.set(n.id, dy);
  }
  if (shift.size === 0) return layout;
  const nodes = layout.nodes.map((n) => ({ ...n, y: round2(n.y + (shift.get(n.id) ?? 0)) }));
  const bottom = Math.max(...nodes.map((n) => n.y + n.height));
  return {
    ...layout,
    height: round2(Math.max(layout.height, bottom)),
    nodes,
    edges: layout.edges.map((e) => ({ ...e })),
    movedNodeIds: [...new Set([...(layout.movedNodeIds ?? []), ...shift.keys()])].sort(),
  };
}

/**
 * 노드를 제 열 맨 아래로 내려 받은 순서대로 쌓는다. 그 열의 나머지 카드는 elk가 정한 위아래 순서대로 위에서부터 다시 잇는다.
 * 기능 영역과 같은 열에 서는 앱 카드가 기능 영역 사이에 끼면 어느 카드가 한 단계 아래 앱인지 안 읽혀서 쓴다
 */
export function sinkToColumnBottom(layout: LayoutResult, nodeIds: readonly string[]): LayoutResult {
  const sinkOrder = new Map(nodeIds.map((id, i) => [id, i]));
  const placed = new Map<string, number>();
  const columns = new Map<number, LayoutNode[]>();
  for (const n of layout.nodes) columns.set(n.x, [...(columns.get(n.x) ?? []), n]);
  for (const col of columns.values()) {
    if (!col.some((n) => sinkOrder.has(n.id))) continue;
    const byY = [...col].sort((a, b) => a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const stacked = [
      ...byY.filter((n) => !sinkOrder.has(n.id)),
      ...byY
        .filter((n) => sinkOrder.has(n.id))
        .sort((a, b) => sinkOrder.get(a.id)! - sinkOrder.get(b.id)!),
    ];
    let y = byY[0]!.y;
    for (const n of stacked) {
      placed.set(n.id, round2(y));
      y += n.height + PIN_GAP;
    }
  }
  if (placed.size === 0) return layout;
  const nodes = layout.nodes.map((n) => ({ ...n, y: placed.get(n.id) ?? n.y }));
  const moved = nodes.filter((n, i) => n.y !== layout.nodes[i]!.y).map((n) => n.id);
  const bottom = Math.max(...nodes.map((n) => n.y + n.height));
  return {
    ...layout,
    height: round2(Math.max(layout.height, bottom)),
    nodes,
    edges: layout.edges.map((e) => ({ ...e })),
    movedNodeIds: [...new Set([...(layout.movedNodeIds ?? []), ...moved])].sort(),
  };
}

/** 테두리로 묶을 카드. 머리 카드 바로 아래에 멤버를 순서대로 잇는다 */
export interface FrameGroup {
  head: string;
  members: readonly string[];
}

// 테두리와 카드 사이 여백. 카드 사이 간격(PIN_GAP)의 절반보다 작아야 이웃 카드와 테두리가 안 겹친다
export const FRAME_PAD = 8;

/**
 * 멤버 카드를 머리 카드 열로 옮겨 머리 바로 아래에 잇는다. 그 열의 나머지 카드는 elk가 정한 위아래 순서를 지키며 아래로 민다.
 * 멤버가 다른 열에 있었으면 그 열은 빈자리를 그대로 둔다. 다른 카드 자리를 건드리면 elk 경로가 더 많이 틀어진다
 */
export function stackFrames(layout: LayoutResult, frames: readonly FrameGroup[]): LayoutResult {
  const byNode = new Map(layout.nodes.map((n) => [n.id, n]));
  const live = frames
    .map((f) => ({ head: f.head, members: f.members.filter((m) => byNode.has(m)) }))
    .filter((f) => byNode.has(f.head) && f.members.length > 0);
  if (live.length === 0) return layout;
  const memberOf = new Set(live.flatMap((f) => f.members));
  const placed = new Map<string, { x: number; y: number; width: number }>();
  for (const x of [...new Set(live.map((f) => byNode.get(f.head)!.x))].sort((a, b) => a - b)) {
    const column = layout.nodes
      .filter((n) => n.x === x && !memberOf.has(n.id))
      .sort((a, b) => a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const order = column.flatMap((n) => [
      n,
      ...(live.find((f) => f.head === n.id)?.members.map((m) => byNode.get(m)!) ?? []),
    ]);
    const width = Math.max(...order.map((n) => n.width));
    let y = Math.min(...order.map((n) => n.y));
    for (const n of order) {
      placed.set(n.id, { x, y: round2(y), width });
      y += n.height + PIN_GAP;
    }
  }
  const nodes = layout.nodes.map((n) => ({ ...n, ...placed.get(n.id) }));
  const moved = nodes
    .filter((n, i) => n.y !== layout.nodes[i]!.y || n.x !== layout.nodes[i]!.x)
    .map((n) => n.id);
  const bottom = Math.max(...nodes.map((n) => n.y + n.height));
  return {
    ...layout,
    height: round2(Math.max(layout.height, bottom + FRAME_PAD)),
    nodes,
    edges: layout.edges.map((e) => ({ ...e })),
    movedNodeIds: [...new Set([...(layout.movedNodeIds ?? []), ...moved])].sort(),
  };
}

/** 쌓기가 다 끝난 좌표에서 테두리를 낸다. 띠로 다시 쌓으면 카드가 움직이므로 맨 마지막에 부른다 */
export function frameRects(layout: LayoutResult, frames: readonly FrameGroup[]): LayoutResult {
  const byNode = new Map(layout.nodes.map((n) => [n.id, n]));
  const rects: LayoutFrame[] = [];
  for (const f of [...frames].sort((a, b) => (a.head < b.head ? -1 : a.head > b.head ? 1 : 0))) {
    const boxes = [f.head, ...f.members].map((id) => byNode.get(id));
    if (boxes[0] === undefined || boxes.slice(1).every((b) => b === undefined)) continue;
    const present = boxes.filter((b): b is LayoutNode => b !== undefined);
    const left = Math.min(...present.map((n) => n.x)) - FRAME_PAD;
    const top = Math.min(...present.map((n) => n.y)) - FRAME_PAD;
    const right = Math.max(...present.map((n) => n.x + n.width)) + FRAME_PAD;
    const bottom = Math.max(...present.map((n) => n.y + n.height)) + FRAME_PAD;
    rects.push({
      id: f.head,
      x: round2(left),
      y: round2(top),
      width: round2(right - left),
      height: round2(bottom - top),
    });
  }
  return rects.length === 0 ? layout : { ...layout, frames: rects };
}

/** 띠로 나눌 제품 하나. members는 그 제품 분석에서 온 노드 id다 */
export interface BandGroup {
  id: string;
  name: string;
  members: ReadonlySet<string>;
}

export function bandGroupsOf(ir: ArchitectureIr): BandGroup[] {
  return (ir.groups ?? []).map((g) => ({ id: g.id, name: g.name, members: new Set(g.members) }));
}

function rankProductsByLinks(
  productsOf: Map<string, number[]>,
  groups: readonly BandGroup[],
  links: ReadonlyArray<{ from: string; to: string }>,
): void {
  const ownerOf = (id: string): number | undefined => {
    const owners = groups.flatMap((g, i) => (g.members.has(id) ? [i] : []));
    return owners.length === 1 ? owners[0] : undefined;
  };
  const weight = new Map<string, Map<number, number>>();
  const add = (shared: string, other: string): void => {
    if ((productsOf.get(shared)?.length ?? 0) < 2) return;
    const owner = ownerOf(other);
    if (owner === undefined) return;
    const w = weight.get(shared) ?? new Map<number, number>();
    w.set(owner, (w.get(owner) ?? 0) + 1);
    weight.set(shared, w);
  };
  for (const l of links) {
    add(l.from, l.to);
    add(l.to, l.from);
  }
  for (const [id, w] of weight) {
    productsOf.get(id)!.sort((a, b) => (w.get(b) ?? 0) - (w.get(a) ?? 0) || a - b);
  }
}

// 띠 머리 높이와 띠 끝 여백. 머리에는 구분선과 띠 이름, 그 아래 첫 카드의 제품 브릭이 들어간다. 포커스 화면 스크립트도 같은 값을 쓴다
export const BAND_HEAD = 40;
export const BAND_TAIL = 14;

/**
 * 여러 제품을 합친 그림을 가로 띠로 다시 쌓는다. 맨 위가 둘 이상의 제품이 같이 쓰는 띠이고 그 아래로 그룹 순서대로 제품마다 전용 띠가 이어진다.
 * 어느 그룹에도 없는 노드는 같이 쓰는 띠에 둔다. 한 제품 몫이라고 말할 근거가 없어서다.
 * 열(x)은 elk가 정한 그대로 둔다. 같이 쓰는 띠 안에서는 쓰는 제품이 많은 카드가 위로 가고 그 밖에는 elk의 위아래 순서를 지킨다.
 * 띠 높이는 모든 열에서 같게 맞춰야 구분선 한 줄로 띠가 갈린다. 카드가 있는 띠가 하나뿐이면 나눠 보일 게 없어 그대로 돌려준다.
 * 같이 쓰는 카드의 제품 순서는 그 카드와 바로 이어진 그 제품 전용 카드가 많은 순이다. 게이트웨이라면 그 제품 API로 가는 선이 많은 쪽이 앞에 온다. 같으면 그룹 순서다
 */
export function stackBands(
  layout: LayoutResult,
  groups: readonly BandGroup[],
  links: ReadonlyArray<{ from: string; to: string }> = [],
): LayoutResult {
  if (groups.length < 2 || layout.nodes.length === 0) return layout;
  const productsOf = new Map<string, number[]>();
  for (const n of layout.nodes) {
    productsOf.set(
      n.id,
      groups.flatMap((g, i) => (g.members.has(n.id) ? [i] : [])),
    );
  }
  rankProductsByLinks(productsOf, groups, links);
  const bandOf = (id: string): number => {
    const ps = productsOf.get(id)!;
    return ps.length === 1 ? ps[0]! + 1 : 0;
  };
  const bandCount = groups.length + 1;
  const counts = Array.from({ length: bandCount }, () => 0);
  for (const n of layout.nodes) counts[bandOf(n.id)]! += 1;
  if (counts.filter((c) => c > 0).length < 2) return layout;

  const columns = new Map<number, LayoutNode[]>();
  for (const n of layout.nodes) columns.set(n.x, [...(columns.get(n.x) ?? []), n]);
  const bandHeight = Array.from({ length: bandCount }, () => 0);
  for (const col of columns.values()) {
    for (let band = 0; band < bandCount; band++) {
      const inBand = col.filter((n) => bandOf(n.id) === band);
      if (inBand.length === 0) continue;
      const h = inBand.reduce((sum, n) => sum + n.height, 0) + PIN_GAP * (inBand.length - 1);
      bandHeight[band] = Math.max(bandHeight[band]!, h);
    }
  }

  const top = Math.min(...layout.nodes.map((n) => n.y));
  const bottomMargin = layout.height - Math.max(...layout.nodes.map((n) => n.y + n.height));
  const bands: LayoutBand[] = [];
  let cursor = top;
  for (let band = 0; band < bandCount; band++) {
    if (counts[band] === 0) continue;
    const height = BAND_HEAD + bandHeight[band]! + BAND_TAIL;
    bands.push({ band, y: round2(cursor), height: round2(height) });
    cursor += height;
  }
  const bandTop = new Map(bands.map((b) => [b.band, b.y + BAND_HEAD]));

  const share = (n: LayoutNode): number => productsOf.get(n.id)!.length;
  const placed = new Map<string, number>();
  for (const col of columns.values()) {
    for (const [band, start] of bandTop) {
      let y = start;
      const inBand = col
        .filter((n) => bandOf(n.id) === band)
        .sort(
          (a, b) =>
            (band === 0 ? share(b) - share(a) : 0) ||
            a.y - b.y ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
      for (const n of inBand) {
        placed.set(n.id, round2(y));
        y += n.height + PIN_GAP;
      }
    }
  }
  const nodes = layout.nodes.map((n) => ({ ...n, y: placed.get(n.id) ?? n.y }));
  const moved = nodes.filter((n, i) => n.y !== layout.nodes[i]!.y).map((n) => n.id);
  const sortedIds = nodes.map((n) => n.id).sort();

  return {
    ...layout,
    height: round2(cursor + bottomMargin),
    nodes,
    edges: layout.edges.map((e) => ({ ...e })),
    movedNodeIds: [...new Set([...(layout.movedNodeIds ?? []), ...moved])].sort(),
    regions: {
      groups: groups.map((g) => ({ id: g.id, name: g.name })),
      bands,
      bandOf: Object.fromEntries(sortedIds.map((id) => [id, bandOf(id)])),
      productsOf: Object.fromEntries(
        sortedIds
          .filter((id) => productsOf.get(id)!.length > 1)
          .map((id) => [id, productsOf.get(id)!]),
      ),
    },
  };
}
