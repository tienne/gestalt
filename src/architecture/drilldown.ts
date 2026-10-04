import {
  assignStages,
  computeGraphLayout,
  environmentRank,
  laneOfNode,
  PARTITION_RANK,
  pinToColumnTop,
  stackTree,
  type TreeStack,
  alignColumnsTo,
  sinkToColumnBottom,
  stackBands,
  bandGroupsOf,
  stackFrames,
  frameRects,
  type FrameGroup,
  type LaneId,
  type LayoutResult,
} from './layout.js';
import { computeFlowLevels, type FlowLevel } from './flow-layout.js';
import { indexMicroApps, orderedApps, type MicroAppIndex } from './micro-app.js';
import { computeServiceFacts } from './service-facts.js';
import type { ArchitectureEdge, ArchitectureNode, EdgeKind, LineStyle, NodeKind } from './types.js';
import { chipTextOverride, displayKindOf } from './types.js';
import type { ValidatedIr } from './validator.js';

export type DrillLevelKind = 'root' | 'service' | 'app' | 'server' | 'feature';

/**
 * 레벨에 그리는 선. 세부 엣지를 그대로 옮긴 것이면 count가 1이고 kind가 원래 엣지 kind다.
 * contains는 서비스 카드에서 그 안 기능 영역으로 가는 포함 선이고 IR 엣지가 아니라 parent에서 나온다
 */
export interface DrillEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind | 'bundle' | 'contains';
  count: number;
  memberEdgeIds: string[];
  lineStyle: LineStyle;
}

export interface DrillLevel {
  /** `root`, `service:<id>`, `app:<id>`, `server:<id>`, `feature:<id>` */
  id: string;
  kind: DrillLevelKind;
  focusId?: string;
  title: string;
  /** root부터 이 레벨까지의 레벨 id. 빵부스러기가 이 순서로 그린다 */
  trail: string[];
  nodeIds: string[];
  edges: DrillEdge[];
  layout: LayoutResult;
}

export interface Drilldown {
  /** root가 맨 앞이고 나머지는 id 순이다 */
  levels: DrillLevel[];
  /** 노드 id → 그 노드를 눌러 들어갈 레벨 id */
  enter: Record<string, string>;
  /** 도메인 흐름 레벨. 노드 그래프가 아니라 행위자 줄 격자라 levels와 따로 싣는다 */
  flows: FlowLevel[];
}

export const ROOT_LEVEL_ID = 'root';

// 클라이언트가 받는 쪽 모듈은 보내는 모듈보다 오른쪽에 서야 화살표가 거꾸로 꺾이지 않는다.
// 사슬 단수만큼 더해 가므로 테이블 순위와 겹치지 않게 넉넉히 띄운다
const RECEIVER_RANK = 10;
const TABLE_RANK_AFTER_RECEIVERS = 100;
// 전체 레벨에서 서버를 거쳐서만 닿는 게이트웨이와 모듈. 같은 레인 안에서도 게이트웨이가 왼쪽에 선다
const EXTERNAL_GATEWAY_RANK = PARTITION_RANK.app_module + 1;
const EXTERNAL_MODULE_RANK = PARTITION_RANK.app_module + 2;
// 저장소는 외부 서비스 레인 오른쪽 끝에 선다. 외부 서버도 같은 저장소를 쓰므로 그보다 뒤여야 선이 거꾸로 안 간다
const DATASTORE_ROOT_RANK = EXTERNAL_MODULE_RANK + 1;

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function byId<T extends { id: string }>(a: T, b: T): number {
  return compareStr(a.id, b.id);
}

interface Graph {
  nodeById: Map<string, ArchitectureNode>;
  edgeById: Map<string, ArchitectureEdge>;
  edges: ArchitectureEdge[];
  parentOf: Map<string, string>;
}

function buildGraph(validated: ValidatedIr): Graph {
  const { ir, drawableNodeIds, drawableEdgeIds } = validated;
  const nodes = ir.nodes.filter((n) => drawableNodeIds.has(n.id));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const edges = ir.edges.filter((e) => drawableEdgeIds.has(e.id)).sort(byId);
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  // 부모가 그려지지 않으면 자식은 부모 없는 노드로 친다. 안 그린 노드 아래로 들어가는 길을 만들지 않기 위해서다
  const parentOf = new Map<string, string>();
  for (const n of nodes) {
    if (n.parent !== undefined && nodeById.has(n.parent)) parentOf.set(n.id, n.parent);
  }
  return { nodeById, edgeById, edges, parentOf };
}

function kindOf(g: Graph, id: string): string | undefined {
  return g.nodeById.get(id)?.kind;
}

/** 가장 가까운 micro_app이나 service 조상. 화면과 기능 영역이 어느 레벨 칸에 서는지 이걸로 정한다 */
function ownerOf(g: Graph, id: string): string | undefined {
  let cursor = g.parentOf.get(id);
  const seen = new Set<string>([id]);
  while (cursor !== undefined && !seen.has(cursor)) {
    const kind = kindOf(g, cursor);
    if (kind === 'micro_app' || kind === 'service') return cursor;
    seen.add(cursor);
    cursor = g.parentOf.get(cursor);
  }
  return undefined;
}

function featureOf(g: Graph, screenId: string): string | undefined {
  const parent = g.parentOf.get(screenId);
  return parent !== undefined && kindOf(g, parent) === 'feature' ? parent : undefined;
}

/** 서비스나 앱 레벨에서 화면이 속하는 칸. feature 없이 서비스나 앱에 바로 달린 화면은 자기 자신이 칸이다 */
function unitOf(g: Graph, screenId: string): string | undefined {
  const feature = featureOf(g, screenId);
  if (feature !== undefined) return feature;
  const parentKind = kindOf(g, g.parentOf.get(screenId) ?? '');
  return parentKind === 'service' || parentKind === 'micro_app' ? screenId : undefined;
}

function edgesOf(g: Graph, kind: EdgeKind, fromKind: string, toKind: string): ArchitectureEdge[] {
  return g.edges.filter(
    (e) => e.kind === kind && kindOf(g, e.from) === fromKind && kindOf(g, e.to) === toKind,
  );
}

/** 화면 자리에 서는 카드. 하네스의 스킬은 사용자가 고르는 입구라 웹의 화면과 같은 자리에 둔다 */
function isSurface(g: Graph, id: string): boolean {
  const kind = kindOf(g, id);
  return kind === 'screen' || kind === 'skill';
}

/** 엔드포인트를 부르는 선. 화면과 스킬, 에이전트가 부른다 */
function screenCalls(g: Graph): ArchitectureEdge[] {
  return g.edges.filter(
    (e) =>
      e.kind === 'calls' &&
      kindOf(g, e.to) === 'endpoint' &&
      (isSurface(g, e.from) || kindOf(g, e.from) === 'agent'),
  );
}

/**
 * 에이전트를 띄운 스킬까지 spawns를 거슬러 올라간다. 에이전트는 소유자가 없어서 묶을 때 띄운 스킬의 소유자를 빌린다.
 * 아무도 안 띄운 에이전트나 화면, 스킬은 자기 자신을 낸다
 */
function callerRoots(g: Graph, id: string): Array<{ id: string; via: string[] }> {
  if (kindOf(g, id) !== 'agent') return [{ id, via: [] }];
  const out: Array<{ id: string; via: string[] }> = [];
  const seen = new Set<string>([id]);
  const queue: Array<{ id: string; via: string[] }> = [{ id, via: [] }];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const ups = g.edges.filter((e) => e.kind === 'spawns' && e.to === at.id);
    if (ups.length === 0 && at.id !== id) out.push(at);
    for (const e of ups) {
      const via = [e.id, ...at.via];
      if (kindOf(g, e.from) === 'skill') out.push({ id: e.from, via });
      else if (!seen.has(e.from)) {
        seen.add(e.from);
        queue.push({ id: e.from, via });
      }
    }
  }
  return out.length > 0 ? out : [{ id, via: [] }];
}

/** 띄운 쪽에서 spawns를 따라 내려가 닿는 에이전트와 그 선 */
function spawnedFrom(g: Graph, starts: Iterable<string>): ArchitectureEdge[] {
  const out: ArchitectureEdge[] = [];
  const seen = new Set<string>(starts);
  const queue = [...seen];
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const e of g.edges.filter((x) => x.kind === 'spawns' && x.from === at)) {
      out.push(e);
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return out;
}

function routesInto(g: Graph, endpointId: string): ArchitectureEdge[] {
  return g.edges.filter(
    (e) => e.kind === 'routes' && e.to === endpointId && kindOf(g, e.from) === 'gateway',
  );
}

function handlersOf(g: Graph, endpointId: string): ArchitectureEdge[] {
  return g.edges.filter(
    (e) => e.kind === 'handles' && e.from === endpointId && kindOf(g, e.to) === 'app_module',
  );
}

function gatewayHops(g: Graph): ArchitectureEdge[] {
  return edgesOf(g, 'routes', 'gateway', 'gateway');
}

interface GatewayChain {
  /** 사슬 맨 앞 게이트웨이. 들어오는 gateway → gateway routes가 없다 */
  head: string;
  /** 맨 앞에서 시작 게이트웨이까지 거친 gateway → gateway routes */
  hops: ArchitectureEdge[];
}

/** 게이트웨이에서 gateway → gateway routes를 거꾸로 따라 올라가 맨 앞 게이트웨이까지의 사슬을 모두 낸다 */
function chainsUp(g: Graph, gatewayId: string): GatewayChain[] {
  const out: GatewayChain[] = [];
  const hops = gatewayHops(g);
  const walk = (at: string, path: ArchitectureEdge[], seen: Set<string>): void => {
    const incoming = hops.filter((e) => e.to === at && !seen.has(e.from));
    if (incoming.length === 0) {
      out.push({ head: at, hops: path });
      return;
    }
    for (const e of incoming) walk(e.from, [...path, e], new Set([...seen, e.from]));
  };
  walk(gatewayId, [], new Set([gatewayId]));
  return out;
}

function ids(edges: ArchitectureEdge[]): string[] {
  return edges.map((e) => e.id);
}

class Bundler {
  private readonly bundles = new Map<
    string,
    { from: string; to: string; keys: Set<string>; members: Set<string> }
  >();

  /** key는 묶음 안에서 건수로 셀 단위다. 같은 key가 여러 번 들어와도 한 건이다 */
  add(from: string, to: string, key: string, members: string[]): void {
    if (from === to) return;
    const id = `bundle:${from}->${to}`;
    let b = this.bundles.get(id);
    if (!b) {
      b = { from, to, keys: new Set(), members: new Set() };
      this.bundles.set(id, b);
    }
    b.keys.add(key);
    for (const m of members) b.members.add(m);
  }

  toEdges(g: Graph): DrillEdge[] {
    return [...this.bundles.entries()]
      .map(([id, b]) => {
        const memberEdgeIds = [...b.members].sort(compareStr);
        // 한 고리라도 문서나 사용자 근거뿐이면 그 묶음 전체가 확인되지 않은 연결이다
        const dashed = memberEdgeIds.some((m) => g.edgeById.get(m)?.lineStyle === 'dashed');
        return {
          id,
          from: b.from,
          to: b.to,
          kind: 'bundle' as const,
          count: b.keys.size,
          memberEdgeIds,
          lineStyle: dashed ? ('dashed' as const) : ('solid' as const),
        };
      })
      .sort(byId);
  }
}

function asDetail(edge: ArchitectureEdge): DrillEdge {
  return {
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    count: 1,
    memberEdgeIds: [edge.id],
    lineStyle: edge.lineStyle,
  };
}

/**
 * 화면 호출을 소유자 단위로 묶는다. 게이트웨이를 거치면 소유자 → 게이트웨이, 아니면 소유자 → 모듈이다.
 * withGatewayHops면 거친 게이트웨이 → 모듈 묶음도 이 호출들로만 만든다.
 */
/**
 * 화면 호출을 소유자 단위로 묶는다. 게이트웨이를 거치면 소유자 → 사슬 맨 앞 게이트웨이, 아니면 소유자 → 모듈이다.
 * withGatewayHops면 사슬 안 게이트웨이끼리와 맨 뒤 게이트웨이 → 모듈 묶음도 이 호출들로만 만든다.
 */
function bundleCalls(
  g: Graph,
  b: Bundler,
  calls: ArchitectureEdge[],
  ownerOf: (screenId: string) => string | undefined,
  withGatewayHops: boolean,
  liftAgents = true,
): void {
  for (const call of calls) {
    const roots = liftAgents ? callerRoots(g, call.from) : [{ id: call.from, via: [] }];
    for (const root of roots) {
      const owner = ownerOf(root.id);
      if (owner === undefined) continue;
      bundleCall(g, b, call, owner, root.via, withGatewayHops);
    }
  }
}

function bundleCall(
  g: Graph,
  b: Bundler,
  call: ArchitectureEdge,
  owner: string,
  via: string[],
  withGatewayHops: boolean,
): void {
  const routes = routesInto(g, call.to);
  const handlers = handlersOf(g, call.to);
  if (routes.length === 0) {
    for (const h of handlers) b.add(owner, h.to, call.id, [...via, call.id, h.id]);
    return;
  }
  for (const r of routes) {
    for (const chain of chainsUp(g, r.from)) {
      b.add(owner, chain.head, call.id, [...via, call.id, r.id, ...ids(chain.hops)]);
      if (!withGatewayHops) continue;
      for (const hop of chain.hops) b.add(hop.from, hop.to, hop.id, [hop.id]);
    }
    if (!withGatewayHops) continue;
    for (const h of handlers) b.add(r.from, h.to, h.id, [r.id, h.id]);
  }
}

/** 게이트웨이가 넘기는 곳을 묶는다. 사슬 안 다음 게이트웨이, 엔드포인트를 받는 모듈, 펼치지 않은 모듈 셋이다 */
function bundleGatewayRoutes(g: Graph, b: Bundler): void {
  for (const hop of gatewayHops(g)) b.add(hop.from, hop.to, hop.id, [hop.id]);
  for (const r of edgesOf(g, 'routes', 'gateway', 'endpoint')) {
    for (const h of handlersOf(g, r.to)) b.add(r.from, h.to, h.id, [r.id, h.id]);
  }
  for (const r of edgesOf(g, 'routes', 'gateway', 'app_module')) b.add(r.from, r.to, r.id, [r.id]);
}

function bundleModuleToModule(g: Graph, b: Bundler): void {
  for (const use of edgesOf(g, 'uses', 'app_module', 'external_service')) {
    for (const call of g.edges.filter((e) => e.kind === 'calls' && e.from === use.to)) {
      const targetKind = kindOf(g, call.to);
      if (targetKind === 'app_module') {
        b.add(use.from, call.to, call.id, [use.id, call.id]);
      } else if (targetKind === 'endpoint') {
        for (const h of handlersOf(g, call.to)) {
          b.add(use.from, h.to, call.id, [use.id, call.id, h.id]);
        }
      } else if (targetKind === 'gateway') {
        // 게이트웨이 뒤쪽 사슬은 bundleGatewayRoutes가 따로 묶는다
        b.add(use.from, call.to, call.id, [use.id, call.id]);
      }
    }
  }
}

/** 클라이언트가 부른 게이트웨이에서 routes를 앞으로 따라간다. 받는 쪽 노드마다 단계 수를 같이 낸다 */
function routesDown(
  g: Graph,
  gatewayId: string,
): { edges: ArchitectureEdge[]; depth: Map<string, number> } {
  const edges: ArchitectureEdge[] = [];
  const depth = new Map<string, number>([[gatewayId, 0]]);
  const queue = [gatewayId];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const d = depth.get(at)!;
    for (const r of g.edges.filter((e) => e.kind === 'routes' && e.from === at)) {
      edges.push(r);
      const targetKind = kindOf(g, r.to);
      if (!depth.has(r.to)) depth.set(r.to, d + 1);
      if (targetKind === 'gateway' && depth.get(r.to) === d + 1) queue.push(r.to);
      if (targetKind === 'endpoint') {
        for (const h of handlersOf(g, r.to)) {
          edges.push(h);
          if (!depth.has(h.to)) depth.set(h.to, d + 2);
        }
      }
    }
  }
  return { edges, depth };
}

interface LevelDraft {
  id: string;
  kind: DrillLevelKind;
  focusId?: string;
  title: string;
  trail: string[];
  nodeIds: Set<string>;
  edges: DrillEdge[];
  rankOverride?: Map<string, number>;
  laneOverride?: Map<string, LaneId>;
  /** 이 레벨에서 kind별 기본 레인. 없으면 평면 그림과 같은 레인을 쓴다 */
  laneOfKind?: Partial<Record<ArchitectureNode['kind'], LaneId>>;
  /** 배치 뒤 제 열 맨 위로 올릴 노드 */
  pinTop?: string;
  /** 위아래 자리를 나무 순서로 다시 잡을 노드. 자식 순서는 elk가 정한 높이를 따르되 이 함수가 넘긴 순서 키가 먼저다 */
  tree?: { root: string; children: Map<string, string[]>; sortKey: Map<string, number> };
  /** pinTop 카드와 같은 높이로 맞출 열의 노드. 그 열이 전부 이 노드일 때만 옮긴다 */
  alignToPin?: string[];
  /** 배치 뒤 제 열 맨 아래로 내릴 노드. 이 순서대로 쌓는다 */
  sinkBottom?: string[];
  /** 레이어 안 위아래 순서. 환경 순서보다 먼저 본다 */
  orderOverride?: Map<string, number>;
  /** 테두리로 묶을 카드 */
  frames?: FrameGroup[];
}

/**
 * 서비스에서 출발해 게이트웨이를 거쳐 닿는 노드. 서버에서 나가는 선은 따라가지 않는다.
 * 다만 inProcess 선은 한 프로세스 안에서 핸들러가 엔진을 부르는 것이라 외부로 치지 않고 따라간다
 */
function frontReach(
  g: Graph,
  edges: DrillEdge[],
  inProcess: ReadonlySet<string> = new Set(),
): Set<string> {
  const front = new Set(
    [...g.nodeById.values()].filter((n) => n.kind === 'service').map((n) => n.id),
  );
  // 스킬이 안 부르고 세션이 바로 부르는 도구의 핸들러는 서비스에서 안 닿는다. 그 핸들러가 부르는 엔진도 같은 프로세스라 출발점에 넣는다
  for (const e of edges) if (inProcess.has(e.id)) front.add(e.from);
  const queue = [...front];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const kind = kindOf(g, at);
    const open = kind === 'service' || kind === 'gateway';
    for (const e of edges) {
      if (e.from !== at || front.has(e.to)) continue;
      if (!open && !inProcess.has(e.id)) continue;
      front.add(e.to);
      queue.push(e.to);
    }
  }
  return front;
}

/** 서버에서 나가는 선으로만 닿는 노드. 서비스 쪽에서 닿는 노드는 뺀다 */
function externalReach(g: Graph, edges: DrillEdge[], front: Set<string>): Set<string> {
  const ext = new Set<string>();
  const queue: string[] = [];
  for (const e of edges) {
    if (kindOf(g, e.from) !== 'app_module' || front.has(e.to) || ext.has(e.to)) continue;
    ext.add(e.to);
    queue.push(e.to);
  }
  while (queue.length > 0) {
    const at = queue.shift()!;
    for (const e of edges) {
      if (e.from !== at || front.has(e.to) || ext.has(e.to)) continue;
      ext.add(e.to);
      queue.push(e.to);
    }
  }
  return ext;
}

const ROOT_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'client',
  'service',
  'micro_app',
  'gateway',
  'app_module',
  'datastore',
]);

/** 환경이 prod이거나 비어 있는 노드. 환경을 모르는 노드는 prod 쪽으로 친다 */
function isProdOrUnknown(n: ArchitectureNode): boolean {
  return n.environment === undefined || n.environment === 'prod';
}

/** prod가 아닌 노드와 거기 걸린 엣지를 뺀 그래프. 전체보기는 이걸로 묶어 dev 경로가 묶음 선 건수에 안 섞이게 한다 */
function prodGraph(g: Graph): Graph {
  const nodeById = new Map([...g.nodeById].filter(([, n]) => isProdOrUnknown(n)));
  const edges = g.edges.filter((e) => nodeById.has(e.from) && nodeById.has(e.to));
  const edgeById = new Map(edges.map((e) => [e.id, e]));
  const parentOf = new Map([...g.parentOf].filter(([c, p]) => nodeById.has(c) && nodeById.has(p)));
  return { nodeById, edgeById, edges, parentOf };
}

/** 서버가 읽고 쓰는 저장소. 테이블에 걸린 선은 그 테이블이 속한 저장소로 올려 묶는다 */
/** 핸들러 모듈이 같은 프로세스의 엔진 모듈을 쓰는 선. 하네스 MCP 서버에서 도구 핸들러가 엔진을 부르는 자리다 */
function moduleUses(g: Graph): ArchitectureEdge[] {
  return edgesOf(g, 'uses', 'app_module', 'app_module');
}

/**
 * 아무도 calls로 부르지 않는 MCP 도구를 parent 서비스에서 핸들러로 잇는다. 스킬 없는 MCP 서버 레포는 클라이언트가 도구를 바로 불러
 * 서비스에서 서버로 가는 선이 하나도 안 생기기 때문이다. 스킬이 부르는 도구는 그 호출로 이미 묶이니 건수가 두 번 세지지 않게 뺀다
 */
function bundleDirectTools(g: Graph, b: Bundler): void {
  const called = new Set(g.edges.filter((e) => e.kind === 'calls').map((e) => e.to));
  for (const n of g.nodeById.values()) {
    if (n.kind !== 'endpoint' || n.protocol !== 'mcp' || called.has(n.id)) continue;
    const owner = g.parentOf.get(n.id);
    if (owner === undefined || kindOf(g, owner) !== 'service') continue;
    for (const h of handlersOf(g, n.id)) b.add(owner, h.to, n.id, [h.id]);
  }
}

function bundleDatastores(g: Graph, b: Bundler): void {
  for (const e of g.edges) {
    if (e.kind !== 'reads_writes' || kindOf(g, e.from) !== 'app_module') continue;
    const toKind = kindOf(g, e.to);
    const store =
      toKind === 'datastore' ? e.to : toKind === 'db_table' ? g.parentOf.get(e.to) : undefined;
    if (store === undefined || kindOf(g, store) !== 'datastore') continue;
    b.add(e.from, store, e.id, [e.id]);
  }
}

function rootLevel(full: Graph, apps: MicroAppIndex): LevelDraft {
  const g = prodGraph(full);
  const nodeIds = new Set(
    [...g.nodeById.values()].filter((n) => ROOT_KINDS.has(n.kind)).map((n) => n.id),
  );
  const b = new Bundler();
  bundleCalls(g, b, screenCalls(g), (s) => ownerOf(g, s), false);
  bundleGatewayRoutes(g, b);
  bundleModuleToModule(g, b);
  bundleDirectTools(g, b);
  const inProcessUses = new Set<string>();
  for (const u of moduleUses(g)) {
    b.add(u.from, u.to, u.id, [u.id]);
    inProcessUses.add(`bundle:${u.from}->${u.to}`);
  }
  bundleDatastores(g, b);
  // 클라이언트가 플러그인을 싣는 선은 테두리를 넘는 일이 없어 그대로 그린다
  const clientLoads = g.edges
    .filter((e) => e.kind === 'loads' && kindOf(g, e.from) === 'client' && nodeIds.has(e.to))
    .map(asDetail);
  // 같은 서비스 안 로드는 테두리가 이미 말해준다. 테두리를 넘는 로드(여러 호스트가 같이 쓰는 리모트)만 선으로 남긴다
  const crossing = apps.loads
    .filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to))
    .filter((e) => g.parentOf.get(e.from) !== g.parentOf.get(e.to))
    .map(asDetail);
  const edges = [...b.toEdges(g), ...crossing, ...clientLoads].sort(byId);
  const frames = [...apps.appsOf.keys()]
    .filter((svc) => nodeIds.has(svc))
    .sort(compareStr)
    .map((svc) => ({ head: svc, members: orderedApps(apps, svc).filter((a) => nodeIds.has(a)) }));
  const ext = externalReach(g, edges, frontReach(g, edges, inProcessUses));
  const rankOverride = new Map<string, number>();
  const laneOverride = new Map<string, LaneId>();
  for (const id of ext) {
    const kind = kindOf(g, id);
    if (kind === 'datastore') {
      rankOverride.set(id, DATASTORE_ROOT_RANK);
      continue;
    }
    if (kind !== 'gateway' && kind !== 'app_module') continue;
    rankOverride.set(id, kind === 'gateway' ? EXTERNAL_GATEWAY_RANK : EXTERNAL_MODULE_RANK);
    laneOverride.set(id, 'external');
  }
  return {
    id: ROOT_LEVEL_ID,
    kind: 'root',
    title: '전체',
    trail: [ROOT_LEVEL_ID],
    nodeIds,
    edges,
    rankOverride,
    laneOverride,
    laneOfKind: { service: 'service', micro_app: 'service' },
    ...(frames.length > 0 ? { frames } : {}),
  };
}

/** 소유자 레벨에 더 얹을 것. 앱 아래 앱 카드를 달 때 쓴다 */
interface OwnerLevelExtra {
  /** 소유자 카드에서 나가 기능 영역 레인 맨 아래에 서는 앱 카드 선. loads나 contains다 */
  children?: DrillEdge[];
}

/**
 * 진입 앱을 못 정한 마이크로 프론트엔드 서비스 레벨. 앱 카드를 늘어놓고 하나씩 들어가게 한다.
 * 어느 앱이 위계 맨 위인지 모르니 treeLevel처럼 한 나무로 세우지 못한다
 */
function ownerLevel(
  g: Graph,
  owner: ArchitectureNode,
  kind: 'service' | 'app',
  trail: string[],
  extra: OwnerLevelExtra = {},
): LevelDraft {
  const id = trail[trail.length - 1]!;
  const children = extra.children ?? [];
  const nodeIds = new Set<string>();
  for (const n of g.nodeById.values()) {
    if (n.kind === 'feature' && g.parentOf.get(n.id) === owner.id) nodeIds.add(n.id);
    if (isSurface(g, n.id) && g.parentOf.get(n.id) === owner.id) nodeIds.add(n.id);
  }
  const b = new Bundler();
  const mine = (screenId: string): boolean => {
    const unit = unitOf(g, screenId);
    return unit !== undefined && ownerOf(g, unit) === owner.id;
  };
  const calls = screenCalls(g).filter((c) => mine(c.from));
  bundleCalls(g, b, calls, (s) => unitOf(g, s), true);
  for (const nav of edgesOf(g, 'navigates', 'screen', 'screen')) {
    if (!mine(nav.from) || !mine(nav.to)) continue;
    const from = unitOf(g, nav.from);
    const to = unitOf(g, nav.to);
    if (from !== undefined && to !== undefined) b.add(from, to, nav.id, [nav.id]);
  }
  const edges = b.toEdges(g);
  for (const e of edges) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }
  const infra = infraChainOf(g, owner.id);
  const base: LevelDraft = {
    id,
    kind,
    focusId: owner.id,
    title: owner.displayName ?? owner.label,
    trail,
    nodeIds,
    edges,
    laneOfKind: { feature: 'unit', screen: 'unit', skill: 'unit' },
  };
  if (infra.length === 0 && children.length === 0) return base;

  // 서빙 인프라가 붙으면 도메인부터 서버까지 한 줄로 읽히게 소유자 카드를 기능 영역 레인 맨 위에 세우고
  // 포함 선으로 기능 영역에 잇는다. 포커스가 이 선을 타고 도메인에서 서버까지 이어진다
  const units = [...nodeIds].filter((n) => g.parentOf.get(n) === owner.id).sort(compareStr);
  const contains: DrillEdge[] = units.map((u) => ({
    id: `contains:${owner.id}->${u}`,
    from: owner.id,
    to: u,
    kind: 'contains',
    count: 1,
    memberEdgeIds: [],
    lineStyle: 'solid',
  }));
  const rankOverride = new Map<string, number>();
  for (const n of nodeIds)
    rankOverride.set(n, PARTITION_RANK[kindOf(g, n) as NodeKind] + INFRA_RANK_SHIFT);
  rankOverride.set(owner.id, PARTITION_RANK.service + INFRA_RANK_SHIFT);
  nodeIds.add(owner.id);
  // 앱 카드는 기능 영역과 같은 열에 세운다. 소유자 아래 한 단계라는 점이 기능 영역과 같아서다
  for (const c of children) {
    nodeIds.add(c.to);
    rankOverride.set(c.to, PARTITION_RANK.feature + INFRA_RANK_SHIFT);
  }
  for (const e of infra) {
    for (const n of [e.from, e.to]) {
      nodeIds.add(n);
      const r = SERVICE_INFRA_RANK[kindOf(g, n) as NodeKind];
      if (r !== undefined) rankOverride.set(n, r);
    }
  }
  return {
    ...base,
    edges: [...edges, ...contains, ...children, ...dedupe(infra).map(asDetail)].sort(byId),
    rankOverride,
    laneOfKind: {
      feature: 'unit',
      screen: 'unit',
      skill: 'unit',
      service: 'unit',
      micro_app: 'unit',
    },
    pinTop: owner.id,
    alignToPin: dedupe(infra)
      .flatMap((e) => [e.from, e.to])
      .filter((n) => n !== owner.id),
    ...(children.length > 0 ? { sinkBottom: children.map((c) => c.to) } : {}),
  };
}

// 나무 레벨의 열 순서. 서빙 사슬(0~2) 뒤로 소유자, 불러온 앱, 기능 영역, 화면을 한 열씩 세우고 게이트웨이부터는 그 뒤로 민다
const TREE_RANK = { owner: 3, loaded: 4, feature: 5, screen: 6 } as const;
const TREE_RANK_SHIFT = TREE_RANK.screen;

interface TreeLevelSpec {
  id: string;
  kind: DrillLevelKind;
  title: string;
  trail: string[];
  /** 맨 왼쪽 위계 카드. 진입 앱, 리모트 앱, 앱이 없는 서비스 자신이다 */
  root: ArchitectureNode;
  rootLane: LaneId;
  /** root에서 나가는 loads. 불러온 앱은 리모트 열에 선다 */
  loads: ArchitectureEdge[];
}

/**
 * 소유자 하나를 펼친 레벨. 소유자 → 불러온 앱 → 기능 영역 → 화면을 열로 나눠 위계가 왼쪽에서 오른쪽으로 읽히게 하고
 * 앞에는 소유자 서빙 사슬, 뒤에는 화면이 부르는 게이트웨이와 서버를 잇는다.
 * 마이크로 프론트엔드든 아니든 같은 열 구성이라야 서비스끼리 오가며 봐도 자리 감각이 안 바뀐다
 */
function treeLevel(g: Graph, spec: TreeLevelSpec): LevelDraft {
  const { id, root: entry, loads } = spec;
  const remotes = new Set(loads.map((e) => e.to));
  const owners = new Set([entry.id, ...remotes]);
  const nodeIds = new Set<string>(owners);
  const rankOverride = new Map<string, number>([[entry.id, TREE_RANK.owner]]);
  const laneOverride = new Map<string, LaneId>([[entry.id, spec.rootLane]]);
  for (const r of remotes) {
    rankOverride.set(r, TREE_RANK.loaded);
    laneOverride.set(r, 'remote');
  }
  const tree: DrillEdge[] = [];
  const children = new Map<string, string[]>([[entry.id, [...remotes]]]);
  // 리모트 블록을 먼저 쌓고 호스트 자기 기능 영역, 호스트에 바로 단 화면 순으로 잇는다. 첫 줄이 호스트 → 리모트 → 기능 → 화면으로 읽힌다
  const sortKey = new Map<string, number>();
  for (const r of remotes) sortKey.set(r, 0);
  for (const n of [...g.nodeById.values()].sort(byId)) {
    if (n.kind !== 'feature' && !isSurface(g, n.id)) continue;
    const owner = ownerOf(g, n.id);
    const parent = g.parentOf.get(n.id);
    if (owner === undefined || !owners.has(owner) || parent === undefined) continue;
    nodeIds.add(n.id);
    rankOverride.set(n.id, n.kind === 'feature' ? TREE_RANK.feature : TREE_RANK.screen);
    children.set(parent, [...(children.get(parent) ?? []), n.id]);
    sortKey.set(n.id, n.kind === 'feature' ? 1 : 2);
    tree.push({
      id: `contains:${parent}->${n.id}`,
      from: parent,
      to: n.id,
      kind: 'contains',
      count: 1,
      memberEdgeIds: [],
      lineStyle: 'solid',
    });
  }
  // 스킬이 띄우는 에이전트는 스킬 바로 뒤 열에 세우고 띄운 선을 그대로 그린다
  const spawns = spawnedFrom(
    g,
    [...nodeIds].filter((n) => kindOf(g, n) === 'skill'),
  );
  for (const e of spawns) {
    if (nodeIds.has(e.to)) continue;
    nodeIds.add(e.to);
    rankOverride.set(e.to, PARTITION_RANK.agent + TREE_RANK_SHIFT);
  }
  const invokes = g.edges.filter(
    (e) => e.kind === 'invokes' && nodeIds.has(e.from) && nodeIds.has(e.to),
  );
  const b = new Bundler();
  const calls = screenCalls(g).filter((c) => nodeIds.has(c.from));
  // MCP 도구는 하네스 그림의 중심이라 묶어 접지 않고 카드로 세운다. 웹 API처럼 수백 개가 되는 일이 없다
  const toolCalls = calls.filter((c) => g.nodeById.get(c.to)?.protocol === 'mcp');
  const toolEdges = dedupe([...toolCalls, ...toolCalls.flatMap((c) => handlersOf(g, c.to))]);
  for (const e of toolEdges) {
    for (const n of [e.from, e.to]) {
      if (nodeIds.has(n)) continue;
      nodeIds.add(n);
      rankOverride.set(n, PARTITION_RANK[kindOf(g, n) as NodeKind] + TREE_RANK_SHIFT);
    }
  }
  bundleCalls(
    g,
    b,
    calls.filter((c) => !toolCalls.includes(c)),
    (s) => s,
    true,
    false,
  );
  const bundles = b.toEdges(g);
  for (const e of bundles) {
    for (const n of [e.from, e.to]) {
      if (nodeIds.has(n)) continue;
      nodeIds.add(n);
      rankOverride.set(n, PARTITION_RANK[kindOf(g, n) as NodeKind] + TREE_RANK_SHIFT);
    }
  }
  const infra = dedupe(infraChainOf(g, entry.id));
  for (const e of infra) {
    for (const n of [e.from, e.to]) {
      nodeIds.add(n);
      const r = SERVICE_INFRA_RANK[kindOf(g, n) as NodeKind];
      if (r !== undefined) rankOverride.set(n, r);
    }
  }
  return {
    id,
    kind: spec.kind,
    focusId: entry.id,
    title: spec.title,
    trail: spec.trail,
    nodeIds,
    edges: [
      ...bundles,
      ...tree,
      ...loads.map(asDetail),
      ...infra.map(asDetail),
      ...dedupe([...spawns, ...invokes, ...toolEdges]).map(asDetail),
    ].sort(byId),
    rankOverride,
    laneOverride,
    laneOfKind: { feature: 'unit', screen: 'screen' },
    pinTop: entry.id,
    tree: { root: entry.id, children, sortKey },
    alignToPin: infra.flatMap((e) => [e.from, e.to]).filter((n) => n !== entry.id),
  };
}

// 서비스 레벨 왼쪽 인프라 레인. 요청이 들어오는 순서(도메인 → CDN → 버킷이나 SSR 서버)대로 놓고 나머지는 그 뒤로 민다
const SERVICE_INFRA_RANK: Partial<Record<NodeKind, number>> = {
  domain: 0,
  cdn: 1,
  bucket: 2,
  deploy_target: 2,
};
const INFRA_RANK_SHIFT = 3;

/** 서비스를 서빙하는 버킷이나 SSR 서버에서 CDN, 도메인까지 거슬러 올라간 엣지 */
function infraChainOf(g: Graph, serviceId: string): ArchitectureEdge[] {
  const into = (kind: EdgeKind, to: string, fromKind: NodeKind): ArchitectureEdge[] =>
    g.edges.filter((e) => e.kind === kind && e.to === to && kindOf(g, e.from) === fromKind);
  const serves = [
    ...into('serves', serviceId, 'bucket'),
    ...into('serves', serviceId, 'deploy_target'),
  ];
  const origins = serves.flatMap((s) => into('origin', s.from, 'cdn'));
  const resolves = [
    ...origins,
    ...serves.filter((s) => kindOf(g, s.from) === 'deploy_target'),
  ].flatMap((o) => into('resolves_to', o.from, 'domain'));
  return [...serves, ...origins, ...resolves];
}

function serverLevel(g: Graph, server: ArchitectureNode): LevelDraft {
  const id = `server:${server.id}`;
  const picked: ArchitectureEdge[] = [];
  const rankOverride = new Map<string, number>();
  if (server.kind === 'gateway') {
    picked.push(...g.edges.filter((e) => e.kind === 'routes' && e.from === server.id));
  } else {
    picked.push(
      ...g.edges.filter(
        (e) => e.kind === 'handles' && e.to === server.id && kindOf(g, e.from) === 'endpoint',
      ),
      ...g.edges.filter(
        (e) =>
          e.kind === 'reads_writes' &&
          e.from === server.id &&
          (kindOf(g, e.to) === 'db_table' || kindOf(g, e.to) === 'datastore'),
      ),
    );
    for (const use of g.edges.filter(
      (e) => e.kind === 'uses' && e.from === server.id && kindOf(g, e.to) === 'external_service',
    )) {
      picked.push(use);
      for (const call of g.edges.filter((e) => e.kind === 'calls' && e.from === use.to)) {
        const targetKind = kindOf(g, call.to);
        if (call.to === server.id) continue;
        if (targetKind === 'app_module') {
          picked.push(call);
          rankOverride.set(call.to, RECEIVER_RANK);
        } else if (targetKind === 'endpoint') {
          picked.push(call);
          rankOverride.set(call.to, RECEIVER_RANK);
          for (const h of handlersOf(g, call.to)) {
            if (h.to === server.id) continue;
            picked.push(h);
            rankOverride.set(h.to, RECEIVER_RANK + 1);
          }
        } else if (targetKind === 'gateway') {
          picked.push(call);
          const down = routesDown(g, call.to);
          for (const e of down.edges) if (e.to !== server.id) picked.push(e);
          for (const [nodeId, d] of down.depth) {
            if (nodeId !== server.id) rankOverride.set(nodeId, RECEIVER_RANK + d);
          }
        }
      }
    }
  }
  const nodeIds = new Set<string>([server.id]);
  for (const e of picked) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }
  const laneOverride = new Map<string, LaneId>();
  for (const id of rankOverride.keys()) laneOverride.set(id, 'external');
  // 같은 프로세스 안 모듈은 외부가 아니다. 부르는 핸들러는 엔드포인트 열에, 불리는 엔진은 받는 쪽 열에 둔다
  if (server.kind === 'app_module') {
    for (const u of moduleUses(g)) {
      if (u.from !== server.id && u.to !== server.id) continue;
      picked.push(u);
      const other = u.from === server.id ? u.to : u.from;
      nodeIds.add(other);
      rankOverride.set(other, u.from === server.id ? RECEIVER_RANK : PARTITION_RANK.endpoint);
      laneOverride.set(other, 'app_module');
    }
  }
  // 테이블은 받는 쪽 모듈들 뒤 맨 오른쪽 레인에 모은다
  for (const id of nodeIds) {
    const kind = kindOf(g, id);
    if (kind === 'db_table' || kind === 'datastore')
      rankOverride.set(id, TABLE_RANK_AFTER_RECEIVERS);
  }
  const edges = dedupe(picked).map(asDetail);
  return {
    id,
    kind: 'server',
    focusId: server.id,
    title: server.displayName ?? server.label,
    trail: [ROOT_LEVEL_ID, id],
    nodeIds,
    edges,
    rankOverride,
    laneOverride,
  };
}

function featureLevel(g: Graph, feature: ArchitectureNode, ownerTrail: string[]): LevelDraft {
  const id = `feature:${feature.id}`;
  const screens = new Set(
    [...g.nodeById.values()]
      .filter((n) => isSurface(g, n.id) && featureOf(g, n.id) === feature.id)
      .map((n) => n.id),
  );
  const picked: ArchitectureEdge[] = [];
  const spawns = spawnedFrom(g, screens);
  const callers = new Set([...screens, ...spawns.map((e) => e.to)]);
  picked.push(...spawns, ...g.edges.filter((e) => e.kind === 'invokes' && screens.has(e.from)));
  for (const call of screenCalls(g).filter((c) => callers.has(c.from))) {
    const routes = routesInto(g, call.to);
    picked.push(call, ...routes, ...handlersOf(g, call.to));
    for (const r of routes) {
      for (const chain of chainsUp(g, r.from)) picked.push(...chain.hops);
    }
  }
  picked.push(
    ...edgesOf(g, 'navigates', 'screen', 'screen').filter(
      (e) => screens.has(e.from) && screens.has(e.to),
    ),
  );
  const nodeIds = new Set(screens);
  for (const e of picked) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }
  return {
    id,
    kind: 'feature',
    focusId: feature.id,
    title: feature.displayName ?? feature.label,
    trail: [...ownerTrail, id],
    nodeIds,
    edges: dedupe(picked).map(asDetail),
  };
}

function dedupe(edges: ArchitectureEdge[]): ArchitectureEdge[] {
  const seen = new Map<string, ArchitectureEdge>();
  for (const e of edges) seen.set(e.id, e);
  return [...seen.values()].sort(byId);
}

/** 자식을 순서 키, elk가 정한 높이, id 순으로 줄 세운다. 같은 블록 안에서는 elk가 줄인 교차를 그대로 살린다 */
function treeOrder(
  layout: LayoutResult,
  tree: { root: string; children: Map<string, string[]>; sortKey: Map<string, number> },
): TreeStack {
  const yOf = new Map(layout.nodes.map((n) => [n.id, n.y]));
  const children = new Map<string, string[]>();
  for (const [parent, list] of tree.children) {
    children.set(
      parent,
      [...list].sort(
        (a, b) =>
          (tree.sortKey.get(a) ?? 0) - (tree.sortKey.get(b) ?? 0) ||
          (yOf.get(a) ?? 0) - (yOf.get(b) ?? 0) ||
          compareStr(a, b),
      ),
    );
  }
  return { root: tree.root, children };
}

/** service 노드가 하나라도 그려지면 드릴다운으로 그린다 */
export function shouldDrillDown(validated: ValidatedIr): boolean {
  return (
    validated.ir.nodes.some((n) => n.kind === 'service' && validated.drawableNodeIds.has(n.id)) ||
    // 독립 흐름은 레벨로만 그려지므로 서비스가 없어도 드릴다운 HTML이 필요하다
    (validated.ir.flows ?? []).some((f) => f.service === undefined)
  );
}

/**
 * 검증된 IR에서 드릴다운 레벨과 묶음 엣지를 계산하고 레벨마다 elkjs 좌표를 미리 낸다.
 * 정렬은 전부 id 기준이라 같은 입력이면 같은 결과가 나온다.
 */
/** 서비스 id → 그린 흐름 수. 카드 배지 폭과 글자가 같은 수를 써야 한다 */
export function flowCountByService(flows: readonly FlowLevel[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of flows) if (f.service !== undefined) out[f.service] = (out[f.service] ?? 0) + 1;
  return out;
}

export async function computeDrilldown(validated: ValidatedIr): Promise<Drilldown> {
  const g = buildGraph(validated);
  const facts = computeServiceFacts([...g.nodeById.values()], g.edges);
  const sorted = [...g.nodeById.values()].sort(byId);
  const bands = bandGroupsOf(validated.ir);
  const apps = indexMicroApps(sorted, g.edges);
  const drafts: LevelDraft[] = [rootLevel(g, apps)];
  const enter: Record<string, string> = {};
  const entryApps = new Set(apps.entryOf.values());
  const trailOf = (ownerId: string): string[] | undefined => {
    const owner = g.nodeById.get(ownerId);
    if (owner?.kind === 'service') return [ROOT_LEVEL_ID, `service:${owner.id}`];
    if (owner?.kind !== 'micro_app') return undefined;
    const parent = g.parentOf.get(owner.id);
    // 진입 앱은 서비스 레벨이 곧 그 앱 레벨이다. 사용자가 서비스로 들어가면 처음 받는 게 이 앱이라서다
    if (entryApps.has(owner.id)) return [ROOT_LEVEL_ID, `service:${parent!}`];
    return [
      ROOT_LEVEL_ID,
      ...(parent !== undefined && kindOf(g, parent) === 'service' ? [`service:${parent}`] : []),
      `app:${owner.id}`,
    ];
  };

  const loadsFrom = (appId: string): ArchitectureEdge[] =>
    apps.loads.filter((e) => e.from === appId && e.to !== appId);
  // 진입 앱을 못 정한 서비스는 앱 카드를 서비스 아래에 포함 선으로 늘어놓고 하나씩 들어가게 한다
  const appCardsOf = (serviceId: string): DrillEdge[] =>
    orderedApps(apps, serviceId).map((a) => ({
      id: `contains:${serviceId}->${a}`,
      from: serviceId,
      to: a,
      kind: 'contains',
      count: 1,
      memberEdgeIds: [],
      lineStyle: 'solid',
    }));

  for (const n of sorted) {
    if (n.kind === 'service') {
      const entry = g.nodeById.get(apps.entryOf.get(n.id) ?? '');
      const trail = trailOf(n.id)!;
      const id = trail[trail.length - 1]!;
      const title = n.displayName ?? n.label;
      const level =
        entry !== undefined
          ? treeLevel(g, {
              id,
              kind: 'service',
              title,
              trail,
              root: entry,
              rootLane: 'host',
              loads: loadsFrom(entry.id),
            })
          : apps.appsOf.has(n.id)
            ? ownerLevel(g, n, 'service', trail, { children: appCardsOf(n.id) })
            : treeLevel(g, {
                id,
                kind: 'service',
                title,
                trail,
                root: n,
                rootLane: 'service',
                loads: [],
              });
      drafts.push(level);
      enter[n.id] = level.id;
      if (entry !== undefined) enter[entry.id] = level.id;
    } else if (n.kind === 'micro_app') {
      if (entryApps.has(n.id)) continue;
      const trail = trailOf(n.id)!;
      const level = treeLevel(g, {
        id: trail[trail.length - 1]!,
        kind: 'app',
        title: n.displayName ?? n.label,
        trail,
        root: n,
        rootLane: 'remote',
        loads: loadsFrom(n.id),
      });
      drafts.push(level);
      enter[n.id] = level.id;
    } else if (n.kind === 'gateway' || n.kind === 'app_module') {
      const level = serverLevel(g, n);
      drafts.push(level);
      enter[n.id] = level.id;
    } else if (n.kind === 'feature') {
      const ownerTrail = trailOf(g.parentOf.get(n.id) ?? '');
      if (ownerTrail === undefined) continue;
      const level = featureLevel(g, n, ownerTrail);
      drafts.push(level);
      enter[n.id] = level.id;
    }
  }

  const [root, ...rest] = drafts;
  const ordered = [root!, ...rest.sort(byId)];
  const levels: DrillLevel[] = [];
  const staged = assignStages(validated.ir);
  const flowLevels = computeFlowLevels(validated);
  const flowCount = flowCountByService(flowLevels);
  for (const d of ordered) {
    const nodeIds = [...d.nodeIds].filter((id) => g.nodeById.has(id)).sort(compareStr);
    const layoutNodes = nodeIds.map((id) => {
      const node = g.nodeById.get(id)!;
      const f = facts.get(id);
      return {
        id,
        label: node.label,
        ...(node.displayName !== undefined ? { displayName: node.displayName } : {}),
        ...(node.displayNameInferred ? { displayNameInferred: true } : {}),
        rank: d.rankOverride?.get(id) ?? PARTITION_RANK[node.kind],
        lane: d.laneOverride?.get(id) ?? d.laneOfKind?.[node.kind] ?? laneOfNode(node),
        ...(staged !== undefined ? { stage: staged.indexOf.get(id)! } : {}),
        kind: displayKindOf(node),
        ...(chipTextOverride(node) !== undefined ? { chip: chipTextOverride(node)! } : {}),
        ...(d.orderOverride?.has(id)
          ? { order: d.orderOverride.get(id)! }
          : node.environment !== undefined
            ? { order: environmentRank(node.environment) }
            : {}),
        ...(f !== undefined && f.platforms.length > 0 ? { platforms: f.platforms } : {}),
        ...(f?.webHosting !== undefined ? { webHosting: f.webHosting } : {}),
        ...(f?.prodDomain !== undefined ? { secondLine: f.prodDomain } : {}),
        ...(flowCount[id] !== undefined ? { flows: flowCount[id] } : {}),
      };
    });
    const laid = await computeGraphLayout(layoutNodes, d.edges, staged?.labels);
    const pinned = d.pinTop !== undefined ? pinToColumnTop(laid, d.pinTop) : laid;
    const treed = d.tree !== undefined ? stackTree(pinned, treeOrder(pinned, d.tree)) : pinned;
    const aligned =
      d.pinTop !== undefined && d.alignToPin !== undefined
        ? alignColumnsTo(treed, d.pinTop, d.alignToPin)
        : treed;
    const sunk = d.sinkBottom !== undefined ? sinkToColumnBottom(aligned, d.sinkBottom) : aligned;
    const framed = d.frames !== undefined ? stackFrames(sunk, d.frames) : sunk;
    const banded = stackBands(framed, bands, validated.ir.edges);
    const layout = d.frames !== undefined ? frameRects(banded, d.frames) : banded;
    levels.push({
      id: d.id,
      kind: d.kind,
      ...(d.focusId !== undefined ? { focusId: d.focusId } : {}),
      title: d.title,
      trail: d.trail,
      nodeIds,
      edges: d.edges,
      layout,
    });
  }
  return { levels, enter, flows: flowLevels };
}
