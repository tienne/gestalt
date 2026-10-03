// 워커 없는 번들판을 쓴다. 기본 진입점은 web-worker 패키지를 찾다가 MCP stdio 서버에서 경고를 찍을 수 있다
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode, LayoutOptions } from 'elkjs/lib/elk.bundled.js';
import { NODE_KIND_SHORT } from './kind-text.js';
import type { ArchitectureIr, NodeKind } from './types.js';

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

/** 레인 한 칸. 같은 레인 노드들의 좌우 끝에 여백을 붙인 범위다 */
export interface LayoutLane {
  id: LaneId;
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
}

/**
 * 화면에 세로 띠로 그리는 칸. 레벨마다 같은 kind도 다른 레인에 설 수 있어서 kind와 따로 둔다.
 * unit은 서비스 레벨의 기능 영역 칸, external은 서버를 거쳐서만 닿는 칸이다
 */
export const LANE_IDS = [
  'service',
  'unit',
  'screen',
  'gateway',
  'endpoint',
  'app_module',
  'external_service',
  'external',
  'db_table',
  'workflow',
  'build',
  'artifact',
  'deploy_target',
] as const;
export type LaneId = (typeof LANE_IDS)[number];

/** 평면 그림의 레인. rank가 같은 kind는 같은 레인에 둬야 띠가 겹치지 않는다 */
export const KIND_LANE: Record<NodeKind, LaneId> = {
  service: 'screen',
  feature: 'screen',
  screen: 'screen',
  gateway: 'gateway',
  endpoint: 'endpoint',
  app_module: 'app_module',
  external_service: 'external_service',
  db_table: 'db_table',
  workflow: 'workflow',
  build: 'build',
  artifact: 'artifact',
  deploy_target: 'deploy_target',
};

const LANE_PADDING_X = 20;

// 화면끼리, 기능 영역끼리 잇는 화면 이동은 요청 흐름이 아니다. elk에 넘기면 같은 레인 안에서 열을 여러 개로 벌려 그림이 옆으로 늘어난다
const STACKED_LANES: ReadonlySet<LaneId> = new Set<LaneId>(['service', 'unit', 'screen']);

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

// 두 뷰의 kind가 겹치지 않아 표 하나로 둘 다 덮는다. 뷰①은 service→feature→screen→gateway→endpoint→module→클라이언트→테이블, 뷰②는 workflow→build→artifact→배포처 순서로 왼쪽부터 놓인다
export const PARTITION_RANK: Record<NodeKind, number> = {
  service: 0,
  feature: 0,
  screen: 0,
  gateway: 1,
  endpoint: 2,
  app_module: 3,
  external_service: 4,
  db_table: 5,
  workflow: 0,
  build: 1,
  artifact: 2,
  deploy_target: 3,
};

/** 레이아웃 입력 노드. rank가 작을수록 왼쪽 열에 선다 */
export interface GraphLayoutNode {
  id: string;
  label: string;
  displayName?: string;
  displayNameInferred?: boolean;
  rank: number;
  lane: LaneId;
  kind?: NodeKind;
}

export interface GraphLayoutEdge {
  id: string;
  from: string;
  to: string;
}

const NODE_HEIGHT = 48;
// 표시 이름과 기술 이름을 두 줄로 쌓는 카드. 글자 수와 무관하게 고정해야 좌표가 입력에만 묶인다
export const NODE_HEIGHT_TWO_LINES = 60;
/** "추정" 배지가 첫 줄에서 차지하는 폭. 앞 여백과 알약 테두리, 한글 두 자 */
export const INFERRED_BADGE_UNITS = 5;
/** 카드 왼쪽 색 띠와 안쪽 여백. 종류 칩은 이 뒤에서 시작한다 */
export const NODE_TEXT_LEFT = 12;
/** 글자 뒤 여백. 들어갈 레벨 표시(›)가 오른쪽 아래에 앉을 자리를 포함한다 */
export const NODE_TEXT_RIGHT = 20;
// 종류 칩: 아이콘과 좌우 여백, 칩 뒤 틈이 고정 폭이고 글자는 칩 글꼴(10.5px) 기준으로 잰다
const CHIP_FIXED_WIDTH = 33;
const CHIP_CHAR_WIDTH = 6.5;

/** 종류 칩이 첫 줄에서 차지하는 폭(px) */
export function chipWidth(kind: NodeKind | undefined): number {
  return kind === undefined
    ? 0
    : CHIP_FIXED_WIDTH + textUnits(NODE_KIND_SHORT[kind]) * CHIP_CHAR_WIDTH;
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

/**
 * 첫 줄은 종류 칩과 이름, 표시 이름이 있으면 둘째 줄에 기술 이름을 쌓는다. 폭은 두 줄 중 긴 쪽을 따른다
 */
export function measureNode(
  label: string,
  displayName?: string,
  displayNameInferred?: boolean,
  kind?: NodeKind,
): { width: number; height: number } {
  const chip = chipWidth(kind);
  let inner: number;
  if (displayName === undefined) {
    inner = chip + textUnits(label) * NARROW_CHAR_WIDTH;
  } else {
    const first = textUnits(displayName) + (displayNameInferred ? INFERRED_BADGE_UNITS : 0);
    inner = Math.max(chip + first * NARROW_CHAR_WIDTH, textUnits(label) * NARROW_CHAR_WIDTH);
  }
  const raw = Math.ceil(NODE_TEXT_LEFT + NODE_TEXT_RIGHT + inner);
  return {
    width: Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, raw)),
    height: displayName !== undefined ? NODE_HEIGHT_TWO_LINES : NODE_HEIGHT,
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// localeCompare는 실행 환경 로캘에 따라 순서가 달라질 수 있어 코드 유닛 비교로 고정한다
function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export async function computeLayout(
  ir: ArchitectureIr,
  drawableNodeIds: ReadonlySet<string>,
  drawableEdgeIds: ReadonlySet<string>,
): Promise<LayoutResult> {
  const nodes = ir.nodes
    .filter((n) => drawableNodeIds.has(n.id))
    .map((n) => ({
      id: n.id,
      label: n.label,
      ...(n.displayName !== undefined ? { displayName: n.displayName } : {}),
      ...(n.displayNameInferred ? { displayNameInferred: true } : {}),
      rank: PARTITION_RANK[n.kind],
      lane: KIND_LANE[n.kind],
      kind: n.kind,
    }));
  const edges = ir.edges.filter((e) => drawableEdgeIds.has(e.id));
  return computeGraphLayout(nodes, edges);
}

/**
 * IR과 무관한 노드와 엣지 목록으로 elkjs 좌표를 낸다. 드릴다운 레벨의 묶음 엣지처럼 IR에 없는 엣지도 받는다.
 * 같은 입력이면 같은 좌표가 나오게 입력과 출력을 id 순으로 정렬한다.
 */
export async function computeGraphLayout(
  nodeList: readonly GraphLayoutNode[],
  edgeList: readonly GraphLayoutEdge[],
): Promise<LayoutResult> {
  const nodes = [...nodeList].sort(byId);
  const laneOf = new Map(nodes.map((n) => [n.id, n.lane]));
  // 끝점이 하나라도 빠진 엣지를 넘기면 ELK가 예외를 던진다
  const edges = edgeList
    .filter((e) => laneOf.has(e.from) && laneOf.has(e.to))
    .filter(
      (e) => !(laneOf.get(e.from) === laneOf.get(e.to) && STACKED_LANES.has(laneOf.get(e.from)!)),
    )
    .sort(byId);

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: GRAPH_OPTIONS,
    children: nodes.map((n) => ({
      id: n.id,
      ...measureNode(n.label, n.displayName, n.displayNameInferred, n.kind),
      // 레이어 안 카드를 왼쪽에 맞춰야 레인이 들쭉날쭉한 열이 아니라 한 줄로 읽힌다
      layoutOptions: { 'elk.partitioning.partition': String(n.rank), 'elk.alignment': 'LEFT' },
    })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.from], targets: [e.to] })),
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
    lanes: computeLanes(nodes, outNodes),
  };
}

// 레인 경계를 서버에서 박아야 브라우저 글꼴이나 창 크기와 무관하게 같은 그림이 나온다
function computeLanes(
  input: readonly GraphLayoutNode[],
  placed: readonly LayoutNode[],
): LayoutLane[] {
  const laneOf = new Map(input.map((n) => [n.id, n.lane]));
  const spans = new Map<LaneId, { left: number; right: number; count: number }>();
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
      x: round2(s.left - LANE_PADDING_X),
      width: round2(s.right - s.left + LANE_PADDING_X * 2),
      count: s.count,
    }))
    .sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
