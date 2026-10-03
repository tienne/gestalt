// 워커 없는 번들판을 쓴다. 기본 진입점은 web-worker 패키지를 찾다가 MCP stdio 서버에서 경고를 찍을 수 있다
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkExtendedEdge, ElkNode, LayoutOptions } from 'elkjs/lib/elk.bundled.js';
import { NODE_KIND_SHORT, PLATFORM_CHIP_TEXT } from './kind-text.js';
import type { ArchitectureIr, EdgeKind, NodeKind, Platform } from './types.js';
import { ENVIRONMENT_ORDER } from './types.js';

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
  /** elk 배치 뒤 자리를 옮긴 노드. 이 노드에 붙은 elk 경로는 경유점으로 쓰지 않는다 */
  movedNodeIds?: string[];
  /** 제품 영역. 두 제품을 합친 그림을 띠로 나눠 쌓았을 때만 있다 */
  regions?: LayoutRegions;
}

/** 노드 좌표와 같은 기준의 사각형 */
export interface LayoutRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutRegion extends LayoutRect {
  id: string;
  name: string;
}

export interface LayoutRegions {
  /** 그룹 순서 그대로다. 첫째는 위, 둘째는 아래 */
  groups: LayoutRegion[];
  /** 두 영역이 겹치는 띠. 같이 쓰는 노드가 없으면 없다 */
  shared?: LayoutRect;
  /** 노드 id → 띠. 0은 첫째 전용, 1은 같이 씀, 2는 둘째 전용이다. 포커스 화면이 이걸로 다시 쌓는다 */
  bandOf: Record<string, 0 | 1 | 2>;
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
  'domain',
  'cdn',
  'bucket',
  'cloud_account',
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
  // 클러스터는 테이블과 같은 rank라 같은 레인에 둔다
  datastore: 'db_table',
  workflow: 'workflow',
  build: 'build',
  artifact: 'artifact',
  deploy_target: 'deploy_target',
  domain: 'domain',
  cdn: 'cdn',
  bucket: 'bucket',
  cloud_account: 'cloud_account',
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
// order를 받은 노드만 그 순서대로 레이어 안에 세운다. 나머지는 elk가 교차를 줄이는 자리에 둔다
const ORDERED_GRAPH_OPTIONS: LayoutOptions = {
  ...GRAPH_OPTIONS,
  'elk.layered.crossingMinimization.semiInteractive': 'true',
};

// 두 뷰의 kind가 겹치지 않아 표 하나로 둘 다 덮는다. 뷰①은 service→feature→screen→gateway→endpoint→module→클라이언트→테이블, 뷰②는 workflow→build→artifact→배포처 순서로 왼쪽부터 놓인다.
// 인프라는 배포 경로에서 산출물이 떨어지는 버킷부터 CDN, 도메인 순으로 오른쪽에 붙는다. 요청 방향(도메인→CDN→버킷)과 반대라 그 선은 거꾸로 그린다
export const PARTITION_RANK: Record<NodeKind, number> = {
  service: 0,
  feature: 0,
  screen: 0,
  gateway: 1,
  endpoint: 2,
  app_module: 3,
  external_service: 4,
  db_table: 5,
  datastore: 5,
  workflow: 0,
  build: 1,
  artifact: 2,
  deploy_target: 3,
  bucket: 4,
  cdn: 5,
  domain: 6,
  cloud_account: 7,
};

/** 평면 그림에서 레인 순서가 화살표 반대라 오른쪽에서 왼쪽으로 그리는 엣지 */
export const FLAT_BACKWARD_EDGE_KINDS: ReadonlySet<EdgeKind> = new Set<EdgeKind>([
  'origin',
  'resolves_to',
]);

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
  kind?: NodeKind;
  /** 같은 레이어 안에서 위에서부터 설 순서. 준 노드끼리만 지켜진다 */
  order?: number;
  /** 첫 줄 이름 뒤 플랫폼 칩 */
  platforms?: readonly Platform[];
  /** 둘째 줄 글자. 없으면 displayName이 있을 때 label이 둘째 줄이다 */
  secondLine?: string;
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

/** 이름 뒤 플랫폼 칩들이 첫 줄에서 차지하는 폭(px) */
export function platformChipsWidth(platforms: readonly Platform[] | undefined): number {
  let w = 0;
  for (const p of platforms ?? []) {
    w += PLATFORM_CHIP_FIXED_WIDTH + textUnits(PLATFORM_CHIP_TEXT[p]) * PLATFORM_CHIP_CHAR_WIDTH;
  }
  return w;
}

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

export interface MeasureExtras {
  platforms?: readonly Platform[];
  secondLine?: string;
}

/**
 * 첫 줄은 종류 칩과 이름(과 플랫폼 칩), 둘째 줄은 secondLine이 있으면 그것, 없고 표시 이름이 있으면 기술 이름이다.
 * 폭은 두 줄 중 긴 쪽을 따른다
 */
export function measureNode(
  label: string,
  displayName?: string,
  displayNameInferred?: boolean,
  kind?: NodeKind,
  extras: MeasureExtras = {},
): { width: number; height: number } {
  const chip = chipWidth(kind) + platformChipsWidth(extras.platforms);
  const name = displayName ?? label;
  const first =
    chip +
    (textUnits(name) +
      (displayName !== undefined && displayNameInferred ? INFERRED_BADGE_UNITS : 0)) *
      NARROW_CHAR_WIDTH;
  const second = extras.secondLine ?? (displayName !== undefined ? label : undefined);
  const inner =
    second === undefined ? first : Math.max(first, textUnits(second) * NARROW_CHAR_WIDTH);
  const raw = Math.ceil(NODE_TEXT_LEFT + NODE_TEXT_RIGHT + inner);
  return {
    width: Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, raw)),
    height: second !== undefined ? NODE_HEIGHT_TWO_LINES : NODE_HEIGHT,
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
      ...(n.environment !== undefined ? { order: environmentRank(n.environment) } : {}),
    }));
  const edges = ir.edges
    .filter((e) => drawableEdgeIds.has(e.id))
    .map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      ...(FLAT_BACKWARD_EDGE_KINDS.has(e.kind) ? { backward: true } : {}),
    }));
  const laid = await computeGraphLayout(nodes, edges);
  return stackBands(laid, bandGroupsOf(ir));
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

  const ordered = nodes.some((n) => n.order !== undefined);
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: ordered ? ORDERED_GRAPH_OPTIONS : GRAPH_OPTIONS,
    children: nodes.map((n) => ({
      id: n.id,
      ...measureNode(n.label, n.displayName, n.displayNameInferred, n.kind, {
        ...(n.platforms !== undefined ? { platforms: n.platforms } : {}),
        ...(n.secondLine !== undefined ? { secondLine: n.secondLine } : {}),
      }),
      // 레이어 안 카드를 왼쪽에 맞춰야 레인이 들쭉날쭉한 열이 아니라 한 줄로 읽힌다
      layoutOptions: {
        'elk.partitioning.partition': String(n.rank),
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

/** 띠로 나눌 제품 하나. members는 그 제품 분석에서 온 노드 id다 */
export interface BandGroup {
  id: string;
  name: string;
  members: ReadonlySet<string>;
}

export function bandGroupsOf(ir: ArchitectureIr): BandGroup[] {
  return (ir.groups ?? []).map((g) => ({ id: g.id, name: g.name, members: new Set(g.members) }));
}

// 영역 테두리와 카드 사이 여백, 영역 이름이 들어갈 줄 높이. 포커스 화면 스크립트도 같은 값을 쓴다
export const REGION_PAD_X = 10;
export const REGION_PAD_Y = 14;
export const REGION_LABEL_H = 26;
const BAND_GAP = REGION_PAD_Y * 2 + REGION_LABEL_H;

/**
 * 두 제품을 합친 그림을 위(첫째 전용), 가운데(같이 씀), 아래(둘째 전용) 띠로 다시 쌓는다.
 * 열(x)은 elk가 정한 그대로 두고 띠 안에서는 elk의 위아래 순서를 지킨다. 띠 높이는 모든 열에서 같게 맞춰야 영역 박스가 한 장으로 그려진다.
 * 두 제품 다 이 레이아웃에 자기만 쓰는 노드가 있을 때만 쌓는다. 한쪽 전용이 비면 그 영역이 공용 띠와 거의 같아 나눠 보일 게 없다
 */
export function stackBands(layout: LayoutResult, groups: readonly BandGroup[]): LayoutResult {
  if (groups.length !== 2 || layout.nodes.length === 0) return layout;
  const [first, second] = groups as [BandGroup, BandGroup];
  const bandOf = (id: string): 0 | 1 | 2 => {
    const inFirst = first.members.has(id);
    const inSecond = second.members.has(id);
    if (inFirst && !inSecond) return 0;
    if (inSecond && !inFirst) return 2;
    return 1;
  };
  const counts = [0, 0, 0];
  for (const n of layout.nodes) counts[bandOf(n.id)]! += 1;
  if (counts[0] === 0 || counts[2] === 0) return layout;

  const columns = new Map<number, LayoutNode[]>();
  for (const n of layout.nodes) columns.set(n.x, [...(columns.get(n.x) ?? []), n]);
  const bandHeight = [0, 0, 0];
  for (const col of columns.values()) {
    for (const band of [0, 1, 2] as const) {
      const inBand = col.filter((n) => bandOf(n.id) === band);
      if (inBand.length === 0) continue;
      const h = inBand.reduce((sum, n) => sum + n.height, 0) + PIN_GAP * (inBand.length - 1);
      bandHeight[band] = Math.max(bandHeight[band]!, h);
    }
  }

  const top = Math.min(...layout.nodes.map((n) => n.y));
  const bottomMargin = layout.height - Math.max(...layout.nodes.map((n) => n.y + n.height));
  const bandTop: Array<number | undefined> = [undefined, undefined, undefined];
  let cursor = top + REGION_PAD_Y + REGION_LABEL_H;
  for (const band of [0, 1, 2] as const) {
    if (counts[band] === 0) continue;
    bandTop[band] = cursor;
    cursor += bandHeight[band]! + BAND_GAP;
  }
  const contentBottom = cursor - BAND_GAP;

  const placed = new Map<string, number>();
  for (const col of columns.values()) {
    for (const band of [0, 1, 2] as const) {
      let y = bandTop[band];
      if (y === undefined) continue;
      const inBand = col
        .filter((n) => bandOf(n.id) === band)
        .sort((a, b) => a.y - b.y || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      for (const n of inBand) {
        placed.set(n.id, round2(y));
        y += n.height + PIN_GAP;
      }
    }
  }
  const nodes = layout.nodes.map((n) => ({ ...n, y: placed.get(n.id) ?? n.y }));
  const moved = nodes.filter((n, i) => n.y !== layout.nodes[i]!.y).map((n) => n.id);

  // 양 끝 띠(0, 2)는 비어 있지 않으니 영역마다 노드가 하나 이상 있다
  const span = (bands: readonly (0 | 1 | 2)[]): LayoutRect => {
    const members = nodes.filter((n) => bands.includes(bandOf(n.id)));
    const used = bands.filter((b) => bandTop[b] !== undefined);
    const left = Math.min(...members.map((n) => n.x)) - REGION_PAD_X;
    const right = Math.max(...members.map((n) => n.x + n.width)) + REGION_PAD_X;
    const y0 = bandTop[used[0]!]! - REGION_PAD_Y;
    const last = used[used.length - 1]!;
    const y1 = bandTop[last]! + bandHeight[last]! + REGION_PAD_Y;
    return { x: round2(left), y: round2(y0), width: round2(right - left), height: round2(y1 - y0) };
  };
  const upper = span([0, 1]);
  const lower = span([1, 2]);
  // 위 영역 이름은 박스 안 위쪽에, 아래 영역 이름은 박스 안 아래쪽에 단다. 둘이 같은 띠에서 시작해도 안 부딪힌다
  upper.y = round2(upper.y - REGION_LABEL_H);
  upper.height = round2(upper.height + REGION_LABEL_H);
  lower.height = round2(lower.height + REGION_LABEL_H);
  const sharedTop = Math.max(upper.y, lower.y);
  const sharedBottom = Math.min(upper.y + upper.height, lower.y + lower.height);
  const sharedLeft = Math.max(upper.x, lower.x);
  const sharedRight = Math.min(upper.x + upper.width, lower.x + lower.width);
  const shared =
    counts[1]! > 0 && sharedBottom > sharedTop && sharedRight > sharedLeft
      ? {
          x: round2(sharedLeft),
          y: round2(sharedTop),
          width: round2(sharedRight - sharedLeft),
          height: round2(sharedBottom - sharedTop),
        }
      : undefined;

  return {
    ...layout,
    height: round2(contentBottom + REGION_PAD_Y + REGION_LABEL_H + bottomMargin),
    nodes,
    edges: layout.edges.map((e) => ({ ...e })),
    movedNodeIds: [...new Set([...(layout.movedNodeIds ?? []), ...moved])].sort(),
    regions: {
      groups: [
        { id: first.id, name: first.name, ...upper },
        { id: second.id, name: second.name, ...lower },
      ],
      ...(shared !== undefined ? { shared } : {}),
      bandOf: Object.fromEntries(
        nodes.map((n) => [n.id, bandOf(n.id)]).sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
      ),
    },
  };
}
