import {
  computeGraphLayout,
  environmentRank,
  KIND_LANE,
  PARTITION_RANK,
  pinToColumnTop,
  type LaneId,
  type LayoutResult,
} from './layout.js';
import { computeServiceFacts } from './service-facts.js';
import type { ArchitectureEdge, ArchitectureNode, EdgeKind, LineStyle, NodeKind } from './types.js';
import type { ValidatedIr } from './validator.js';

export type DrillLevelKind = 'root' | 'service' | 'server' | 'feature';

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
  /** `root`, `service:<id>`, `server:<id>`, `feature:<id>` */
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
}

export const ROOT_LEVEL_ID = 'root';

// 클라이언트가 받는 쪽 모듈은 보내는 모듈보다 오른쪽에 서야 화살표가 거꾸로 꺾이지 않는다.
// 사슬 단수만큼 더해 가므로 테이블 순위와 겹치지 않게 넉넉히 띄운다
const RECEIVER_RANK = 10;
const TABLE_RANK_AFTER_RECEIVERS = 100;
// 전체 레벨에서 서버를 거쳐서만 닿는 게이트웨이와 모듈. 같은 레인 안에서도 게이트웨이가 왼쪽에 선다
const EXTERNAL_GATEWAY_RANK = PARTITION_RANK.app_module + 1;
const EXTERNAL_MODULE_RANK = PARTITION_RANK.app_module + 2;

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

function serviceOf(g: Graph, id: string): string | undefined {
  let cursor: string | undefined = id;
  const seen = new Set<string>();
  while (cursor !== undefined && !seen.has(cursor)) {
    if (kindOf(g, cursor) === 'service') return cursor;
    seen.add(cursor);
    cursor = g.parentOf.get(cursor);
  }
  return undefined;
}

function featureOf(g: Graph, screenId: string): string | undefined {
  const parent = g.parentOf.get(screenId);
  return parent !== undefined && kindOf(g, parent) === 'feature' ? parent : undefined;
}

/** 서비스 레벨에서 화면이 속하는 칸. feature 없이 서비스에 바로 달린 화면은 자기 자신이 칸이다 */
function unitOf(g: Graph, screenId: string): string | undefined {
  const feature = featureOf(g, screenId);
  if (feature !== undefined) return feature;
  const parent = g.parentOf.get(screenId);
  return parent !== undefined && kindOf(g, parent) === 'service' ? screenId : undefined;
}

function edgesOf(g: Graph, kind: EdgeKind, fromKind: string, toKind: string): ArchitectureEdge[] {
  return g.edges.filter(
    (e) => e.kind === kind && kindOf(g, e.from) === fromKind && kindOf(g, e.to) === toKind,
  );
}

function screenCalls(g: Graph): ArchitectureEdge[] {
  return edgesOf(g, 'calls', 'screen', 'endpoint');
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
): void {
  for (const call of calls) {
    const owner = ownerOf(call.from);
    if (owner === undefined) continue;
    const routes = routesInto(g, call.to);
    const handlers = handlersOf(g, call.to);
    if (routes.length === 0) {
      for (const h of handlers) b.add(owner, h.to, call.id, [call.id, h.id]);
      continue;
    }
    for (const r of routes) {
      for (const chain of chainsUp(g, r.from)) {
        b.add(owner, chain.head, call.id, [call.id, r.id, ...ids(chain.hops)]);
        if (!withGatewayHops) continue;
        for (const hop of chain.hops) b.add(hop.from, hop.to, hop.id, [hop.id]);
      }
      if (!withGatewayHops) continue;
      for (const h of handlers) b.add(r.from, h.to, h.id, [r.id, h.id]);
    }
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
}

/** 서비스에서 출발해 게이트웨이를 거쳐 닿는 노드. 서버에서 나가는 선은 따라가지 않는다 */
function frontReach(g: Graph, edges: DrillEdge[]): Set<string> {
  const front = new Set(
    [...g.nodeById.values()].filter((n) => n.kind === 'service').map((n) => n.id),
  );
  const queue = [...front];
  while (queue.length > 0) {
    const at = queue.shift()!;
    const kind = kindOf(g, at);
    if (kind !== 'service' && kind !== 'gateway') continue;
    for (const e of edges) {
      if (e.from !== at || front.has(e.to)) continue;
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

function rootLevel(g: Graph): LevelDraft {
  const nodeIds = new Set(
    [...g.nodeById.values()]
      .filter((n) => n.kind === 'service' || n.kind === 'gateway' || n.kind === 'app_module')
      .map((n) => n.id),
  );
  const b = new Bundler();
  bundleCalls(g, b, screenCalls(g), (s) => serviceOf(g, s), false);
  bundleGatewayRoutes(g, b);
  bundleModuleToModule(g, b);
  const edges = b.toEdges(g);
  const ext = externalReach(g, edges, frontReach(g, edges));
  const rankOverride = new Map<string, number>();
  const laneOverride = new Map<string, LaneId>();
  for (const id of ext) {
    const kind = kindOf(g, id);
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
    laneOfKind: { service: 'service' },
  };
}

function serviceLevel(g: Graph, service: ArchitectureNode): LevelDraft {
  const id = `service:${service.id}`;
  const nodeIds = new Set<string>();
  for (const n of g.nodeById.values()) {
    if (n.kind === 'feature' && g.parentOf.get(n.id) === service.id) nodeIds.add(n.id);
    if (n.kind === 'screen' && g.parentOf.get(n.id) === service.id) nodeIds.add(n.id);
  }
  const b = new Bundler();
  const calls = screenCalls(g).filter((c) => serviceOf(g, c.from) === service.id);
  bundleCalls(g, b, calls, (s) => unitOf(g, s), true);
  for (const nav of edgesOf(g, 'navigates', 'screen', 'screen')) {
    if (serviceOf(g, nav.from) !== service.id || serviceOf(g, nav.to) !== service.id) continue;
    const from = unitOf(g, nav.from);
    const to = unitOf(g, nav.to);
    if (from !== undefined && to !== undefined) b.add(from, to, nav.id, [nav.id]);
  }
  const edges = b.toEdges(g);
  for (const e of edges) {
    nodeIds.add(e.from);
    nodeIds.add(e.to);
  }
  const infra = infraChainOf(g, service.id);
  const base: LevelDraft = {
    id,
    kind: 'service',
    focusId: service.id,
    title: service.displayName ?? service.label,
    trail: [ROOT_LEVEL_ID, id],
    nodeIds,
    edges,
    laneOfKind: { feature: 'unit', screen: 'unit' },
  };
  if (infra.length === 0) return base;

  // 서빙 인프라가 붙으면 도메인부터 서버까지 한 줄로 읽히게 서비스 카드를 기능 영역 레인 맨 위에 세우고
  // 포함 선으로 기능 영역에 잇는다. 포커스가 이 선을 타고 도메인에서 서버까지 이어진다
  const units = [...nodeIds].filter((n) => g.parentOf.get(n) === service.id).sort(compareStr);
  const contains: DrillEdge[] = units.map((u) => ({
    id: `contains:${service.id}->${u}`,
    from: service.id,
    to: u,
    kind: 'contains',
    count: 1,
    memberEdgeIds: [],
    lineStyle: 'solid',
  }));
  const rankOverride = new Map<string, number>();
  for (const n of nodeIds)
    rankOverride.set(n, PARTITION_RANK[kindOf(g, n) as NodeKind] + INFRA_RANK_SHIFT);
  rankOverride.set(service.id, PARTITION_RANK.service + INFRA_RANK_SHIFT);
  nodeIds.add(service.id);
  for (const e of infra) {
    for (const n of [e.from, e.to]) {
      nodeIds.add(n);
      const r = SERVICE_INFRA_RANK[kindOf(g, n) as NodeKind];
      if (r !== undefined) rankOverride.set(n, r);
    }
  }
  return {
    ...base,
    edges: [...edges, ...contains, ...dedupe(infra).map(asDetail)].sort(byId),
    rankOverride,
    laneOfKind: { feature: 'unit', screen: 'unit', service: 'unit' },
    pinTop: service.id,
  };
}

// 서비스 레벨 왼쪽 인프라 레인. 요청이 들어오는 순서(도메인 → CDN → 버킷)대로 놓고 나머지는 그 뒤로 민다
const SERVICE_INFRA_RANK: Partial<Record<NodeKind, number>> = { domain: 0, cdn: 1, bucket: 2 };
const INFRA_RANK_SHIFT = 3;

/** 서비스를 서빙하는 버킷에서 CDN, 도메인까지 거슬러 올라간 엣지 */
function infraChainOf(g: Graph, serviceId: string): ArchitectureEdge[] {
  const into = (kind: EdgeKind, to: string, fromKind: NodeKind): ArchitectureEdge[] =>
    g.edges.filter((e) => e.kind === kind && e.to === to && kindOf(g, e.from) === fromKind);
  const serves = into('serves', serviceId, 'bucket');
  const origins = serves.flatMap((s) => into('origin', s.from, 'cdn'));
  const resolves = origins.flatMap((o) => into('resolves_to', o.from, 'domain'));
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
        (e) => e.kind === 'reads_writes' && e.from === server.id && kindOf(g, e.to) === 'db_table',
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
  // 테이블은 받는 쪽 모듈들 뒤 맨 오른쪽 레인에 모은다
  for (const id of nodeIds) {
    if (kindOf(g, id) === 'db_table') rankOverride.set(id, TABLE_RANK_AFTER_RECEIVERS);
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

function featureLevel(g: Graph, feature: ArchitectureNode, serviceId: string): LevelDraft {
  const id = `feature:${feature.id}`;
  const screens = new Set(
    [...g.nodeById.values()]
      .filter((n) => n.kind === 'screen' && featureOf(g, n.id) === feature.id)
      .map((n) => n.id),
  );
  const picked: ArchitectureEdge[] = [];
  for (const call of screenCalls(g).filter((c) => screens.has(c.from))) {
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
    trail: [ROOT_LEVEL_ID, `service:${serviceId}`, id],
    nodeIds,
    edges: dedupe(picked).map(asDetail),
  };
}

function dedupe(edges: ArchitectureEdge[]): ArchitectureEdge[] {
  const seen = new Map<string, ArchitectureEdge>();
  for (const e of edges) seen.set(e.id, e);
  return [...seen.values()].sort(byId);
}

/** service 노드가 하나라도 그려지면 드릴다운으로 그린다 */
export function shouldDrillDown(validated: ValidatedIr): boolean {
  return validated.ir.nodes.some(
    (n) => n.kind === 'service' && validated.drawableNodeIds.has(n.id),
  );
}

/**
 * 검증된 IR에서 드릴다운 레벨과 묶음 엣지를 계산하고 레벨마다 elkjs 좌표를 미리 낸다.
 * 정렬은 전부 id 기준이라 같은 입력이면 같은 결과가 나온다.
 */
export async function computeDrilldown(validated: ValidatedIr): Promise<Drilldown> {
  const g = buildGraph(validated);
  const facts = computeServiceFacts([...g.nodeById.values()], g.edges);
  const sorted = [...g.nodeById.values()].sort(byId);
  const drafts: LevelDraft[] = [rootLevel(g)];
  const enter: Record<string, string> = {};

  for (const n of sorted) {
    if (n.kind === 'service') {
      const level = serviceLevel(g, n);
      drafts.push(level);
      enter[n.id] = level.id;
    } else if (n.kind === 'gateway' || n.kind === 'app_module') {
      const level = serverLevel(g, n);
      drafts.push(level);
      enter[n.id] = level.id;
    } else if (n.kind === 'feature') {
      const service = g.parentOf.get(n.id);
      if (service === undefined) continue;
      const level = featureLevel(g, n, service);
      drafts.push(level);
      enter[n.id] = level.id;
    }
  }

  const [root, ...rest] = drafts;
  const ordered = [root!, ...rest.sort(byId)];
  const levels: DrillLevel[] = [];
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
        lane: d.laneOverride?.get(id) ?? d.laneOfKind?.[node.kind] ?? KIND_LANE[node.kind],
        kind: node.kind,
        ...(node.environment !== undefined ? { order: environmentRank(node.environment) } : {}),
        ...(f !== undefined && f.platforms.length > 0 ? { platforms: f.platforms } : {}),
        ...(f?.prodDomain !== undefined ? { secondLine: f.prodDomain } : {}),
      };
    });
    const laid = await computeGraphLayout(layoutNodes, d.edges);
    const layout = d.pinTop !== undefined ? pinToColumnTop(laid, d.pinTop) : laid;
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
  return { levels, enter };
}
