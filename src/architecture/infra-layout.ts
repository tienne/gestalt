import { resolveInfraPlacement } from './infra-placement.js';
import type {
  ArchitectureNode,
  CloudProvider,
  EdgeKind,
  LineStyle,
  NodeKind,
  SubnetExposure,
} from './types.js';
import { BOX_ICONS, iconKey, vendorIconKey } from './vendor-icons.js';

// 좌표 규칙은 stack-diagram geometry.md를 따른다. 노드는 타일 60x60과 그 아래 글자를 합친 132x100 상자다
export const INFRA_NODE_W = 132;
export const INFRA_NODE_H = 100;
export const INFRA_TILE = 60;
const NODE_HALF = INFRA_NODE_W / 2;
const TILE_HALF = INFRA_TILE / 2;
/** 박스 위쪽 라벨 띠. 첫 타일 상단이 박스 상단에서 이만큼 내려온다 */
export const INFRA_BOX_HEAD = 60;
/** 박스 좌우와 아래 안쪽 여백. 노드 상자에서 이만큼 바깥에 테두리가 선다 */
export const INFRA_BOX_INSET = 24;
export const INFRA_COL_PITCH = 160;
export const INFRA_ROW_PITCH = 150;
export const INFRA_MAX_COLS = 4;
/** 같은 박스 안에서 나란히 선 타일 묶음과 자식 박스 사이 */
export const INFRA_ITEM_GAP = 40;
export const INFRA_CANVAS_PAD = 40;
// 빈 박스도 라벨이 들어갈 만큼은 선다
const EMPTY_INNER_W = INFRA_NODE_W;
const EMPTY_INNER_H = 40;
// 선 끝과 타일 사이 틈. 화살촉이 이 틈을 메운다
const PORT_GAP = 4;
// 꺾임 하나를 이 길이만큼 돌아가는 것으로 친다. 짧지만 지그재그인 길보다 한 번 꺾는 길을 고르게 한다
const BEND_COST = 40;
// 노드 상자 바깥으로 지나가는 세로 통로. 글자 상자(±66)에 장애물 여유 4를 더하고 그만큼 더 띄운다
const SIDE_CORRIDOR = NODE_HALF + 12;
// 타일 아래 글자 상자 밑과 다음 행 사이 빈 띠
const BELOW_BAND = INFRA_NODE_H + 25;
const ABOVE_BAND = 20;

export interface InfraEdgeInput {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  lineStyle: LineStyle;
}

export interface InfraBox {
  /** 노드 박스면 노드 id, 리전처럼 IR에 없는 박스면 `region:<벤더>:<계정>:<리전>` 꼴 */
  id: string;
  vendor: CloudProvider;
  /** 벤더 클래스와 박스 종류. `aws cloud`, `aws vpc`, `gcp region`처럼 렌더러가 그대로 class에 붙인다 */
  cls: string;
  /** 박스가 IR 노드(cloud_account, network, subnet)일 때만. 라벨을 누르면 그 노드 서랍이 열린다 */
  nodeId?: string;
  label: string;
  iconKey?: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InfraTile {
  id: string;
  /** 132x100 노드 상자의 왼쪽 위 */
  x: number;
  y: number;
  cx: number;
  vendor?: CloudProvider;
  iconKey?: string;
}

export interface InfraEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  lineStyle: LineStyle;
  /** M, H, V만 쓰는 직각 경로 */
  d: string;
  /** 가장 긴 구간 옆. 가로면 선 위 가운데, 세로면 선 오른쪽 */
  labelAt: { x: number; y: number; anchor: 'middle' | 'start' };
  /** 양 끝이 다 AWS 박스 안이다. AWS 그림 규칙(한 색, 열린 화살촉)을 따른다 */
  aws: boolean;
}

export interface InfraLayout {
  width: number;
  height: number;
  /** 바깥 박스가 먼저 온다. 렌더러가 이 순서로 쌓으면 안쪽 박스가 위에 그려진다 */
  boxes: InfraBox[];
  tiles: InfraTile[];
  edges: InfraEdge[];
  /** 타일과 박스가 쓰는 공식 아이콘 키. 정렬돼 있고 겹치지 않는다 */
  iconKeys: string[];
}

/** 박스 안 자리를 정할 때 쓰는 범위. global은 리전 밖, regional은 리전 안이다 */
export type InfraScope = 'global' | 'regional';

const GLOBAL_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['domain', 'cdn']);

/** 노드를 매단 곳이 없을 때 벤더 박스 안 어디에 둘지. GCP는 이 값과 상관없이 VPC 밖에 둔다 */
export function infraScope(kind: NodeKind): InfraScope {
  return GLOBAL_KINDS.has(kind) ? 'global' : 'regional';
}

const BOX_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['cloud_account', 'network', 'subnet']);
const ANCHOR_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>(['network', 'subnet', 'cluster']);
const TILE_ORDER: readonly NodeKind[] = [
  'domain',
  'cdn',
  'firewall',
  'cluster',
  'workload',
  'deploy_target',
  'datastore',
  'bucket',
  'cloud_account',
  'network',
  'subnet',
];
const VENDOR_ORDER: readonly CloudProvider[] = ['aws', 'gcp', 'azure'];
const DEFAULT_CLOUD_LABEL: Record<CloudProvider, string> = {
  aws: 'AWS Cloud',
  gcp: 'Google Cloud',
  azure: 'Azure',
};
const VNET_CLASS: Record<CloudProvider, string> = { aws: 'vpc', gcp: 'vpc', azure: 'vnet' };

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface BoxSpec {
  id: string;
  vendor: CloudProvider;
  cls: string;
  nodeId?: string;
  label: string;
  iconKey?: string;
}

interface Container {
  box?: BoxSpec;
  /** 형제 박스 사이 정렬 키 */
  order: string;
  tiles: string[];
  children: Container[];
}

function newContainer(order: string, box?: BoxSpec): Container {
  return { ...(box !== undefined ? { box } : {}), order, tiles: [], children: [] };
}

/** 라벨 글자 폭 어림. 한글은 12px 글자 하나가 거의 정사각형이다 */
function labelWidth(box: BoxSpec): number {
  let text = 0;
  for (const ch of box.label) text += ch.charCodeAt(0) > 0x2e80 ? 12 : 7.2;
  // 라벨 아이콘은 AWS가 30px, GCP와 Azure가 20px이고 글자와 8px 띄운다
  const icon = box.iconKey === undefined ? 0 : box.vendor === 'aws' ? 38 : 28;
  return Math.ceil(12 + icon + text + 12);
}

/**
 * 인프라 레벨 좌표. 벤더마다 박스를 겹겹이 두르고(AWS Cloud > Region > VPC > subnet, Google Cloud > VPC > region > subnet,
 * Azure > region > VNet > subnet) 그 안에 타일을 격자로 세운 뒤 선을 직각으로 잇는다. elk 없이 동기로 끝나고 같은 입력이면 같은 좌표다
 */
export function computeInfraLayout(input: {
  /** IR 노드 전부. provider와 region 상속은 레벨 밖 노드(다른 환경 계정 등)까지 거슬러 본다 */
  nodes: readonly ArchitectureNode[];
  nodeIds: readonly string[];
  edges: readonly InfraEdgeInput[];
}): InfraLayout {
  const all = new Map(input.nodes.map((n) => [n.id, n]));
  const ids = [...new Set(input.nodeIds)].filter((id) => all.has(id)).sort(compareStr);
  const inLevel = new Set(ids);
  const node = (id: string): ArchitectureNode => all.get(id)!;
  const placement = resolveInfraPlacement(input.nodes);
  const vendorOf = (id: string): CloudProvider | undefined => placement.provider.get(id);
  const regionOf = (id: string): string | undefined => placement.region.get(id);

  // 매단 곳. 같은 벤더의 network, subnet, cluster만 친다. 벤더가 엇갈리면 경고로 이미 알렸으니 매달지 않는다
  const anchorOf = (id: string): string | undefined => {
    const n = node(id);
    for (const a of [n.placedIn, n.parent]) {
      if (a === undefined || a === id || !inLevel.has(a)) continue;
      if (!ANCHOR_KINDS.has(node(a).kind)) continue;
      if (vendorOf(a) !== vendorOf(id)) continue;
      return a;
    }
    return undefined;
  };

  const accountMemo = new Map<string, string | undefined>();
  const accountOf = (id: string, seen: Set<string>): string | undefined => {
    if (accountMemo.has(id)) return accountMemo.get(id);
    if (seen.has(id)) return undefined;
    seen.add(id);
    const n = node(id);
    let acct: string | undefined;
    if (n.kind === 'cloud_account') acct = id;
    else if (n.account !== undefined && all.get(n.account)?.kind === 'cloud_account')
      acct = n.account;
    else if (n.parent !== undefined && all.get(n.parent)?.kind === 'cloud_account') acct = n.parent;
    else {
      const up = [n.placedIn, n.parent].find((x) => x !== undefined && inLevel.has(x));
      acct = up !== undefined ? accountOf(up, seen) : undefined;
    }
    accountMemo.set(id, acct);
    return acct;
  };
  // 계정을 안 적은 노드는 그 벤더 계정이 하나뿐이면 거기 넣는다. 그래야 계정 박스 옆에 이름 없는 벤더 박스가 따로 서지 않는다
  const soleAccount = new Map<CloudProvider, string | undefined>();
  for (const id of [...inLevel].sort()) {
    const v = node(id).kind === 'cloud_account' ? vendorOf(id) : undefined;
    if (v !== undefined) soleAccount.set(v, soleAccount.has(v) ? undefined : id);
  }
  const acctOf = (id: string): string => {
    const own = accountOf(id, new Set());
    if (own !== undefined) return own;
    const v = vendorOf(id);
    return (v !== undefined ? soleAccount.get(v) : undefined) ?? '';
  };

  // 박스로 그리는 노드. 벤더가 없으면 박스 없이 타일로 선다
  const isBox = (id: string): boolean => BOX_KINDS.has(node(id).kind) && vendorOf(id) !== undefined;

  const loose = newContainer('');
  const clouds = new Map<string, Container>();
  const regions = new Map<string, Container>();
  const boxOfNode = new Map<string, Container>();
  const tileHome = new Map<string, Container>();

  const cloudOf = (vendor: CloudProvider, acct: string): Container => {
    const key = `${vendor}|${acct}`;
    let c = clouds.get(key);
    if (c !== undefined) return c;
    const a =
      acct !== '' && inLevel.has(acct) && vendorOf(acct) === vendor ? node(acct) : undefined;
    c = newContainer(`${VENDOR_ORDER.indexOf(vendor)}|${acct}`, {
      id: a?.id ?? `cloud:${vendor}:${acct}`,
      vendor,
      cls: `${vendor} cloud`,
      ...(a !== undefined ? { nodeId: a.id } : {}),
      label: a?.displayName ?? a?.label ?? DEFAULT_CLOUD_LABEL[vendor],
      iconKey: iconKey(vendor, BOX_ICONS[vendor].cloud),
    });
    clouds.set(key, c);
    return c;
  };

  const regionIn = (
    parent: Container,
    vendor: CloudProvider,
    scope: string,
    region: string,
  ): Container => {
    const key = `${scope}|${region}`;
    let c = regions.get(key);
    if (c !== undefined) return c;
    c = newContainer(`r|${region}`, {
      id: `region:${scope}:${region}`,
      vendor,
      cls: `${vendor} region`,
      label: region,
      ...(vendor === 'aws' ? { iconKey: iconKey('aws', BOX_ICONS.aws.region) } : {}),
    });
    regions.set(key, c);
    parent.children.push(c);
    return c;
  };

  /** 리전이 있으면 리전 박스, 없으면 벤더 박스. GCP는 리전 박스가 VPC 안에만 있어서 벤더 박스를 돌려준다 */
  const regionalHome = (
    vendor: CloudProvider,
    acct: string,
    region: string | undefined,
  ): Container => {
    const cloud = cloudOf(vendor, acct);
    if (vendor === 'gcp' || region === undefined) return cloud;
    return regionIn(cloud, vendor, `${vendor}:${acct}`, region);
  };

  const boxMemo = new Set<string>();
  const ensureBox = (id: string): Container => {
    const made = boxOfNode.get(id);
    if (made !== undefined) return made;
    // 순환이면 벤더 박스에 바로 둔다. parent 순환은 검증기가 따로 막는다
    if (boxMemo.has(id)) return cloudOf(vendorOf(id)!, acctOf(id));
    boxMemo.add(id);
    const n = node(id);
    const vendor = vendorOf(id)!;
    const acct = acctOf(id);
    if (n.kind === 'cloud_account') {
      const c = cloudOf(vendor, acct);
      boxOfNode.set(id, c);
      return c;
    }
    const label = n.displayName ?? n.label;
    let parent: Container;
    let box: BoxSpec;
    let order: string;
    if (n.kind === 'network') {
      parent = vendor === 'gcp' ? cloudOf(vendor, acct) : regionalHome(vendor, acct, regionOf(id));
      box = {
        id,
        vendor,
        cls: `${vendor} ${VNET_CLASS[vendor]}`,
        nodeId: id,
        label,
        ...(vendorIconKey(vendor, n) !== undefined ? { iconKey: vendorIconKey(vendor, n)! } : {}),
      };
      order = `n|${id}`;
    } else {
      const net = anchorOf(id);
      const netBox = net !== undefined && isBox(net) ? ensureBox(net) : undefined;
      const region = regionOf(id);
      parent =
        netBox !== undefined
          ? vendor === 'gcp' && region !== undefined
            ? regionIn(netBox, vendor, net!, region)
            : netBox
          : regionalHome(vendor, acct, region);
      const exposure: SubnetExposure | undefined = n.exposure;
      const awsCls = exposure ?? 'subnet';
      const icon =
        vendor === 'aws'
          ? exposure !== undefined
            ? iconKey('aws', BOX_ICONS.aws[exposure])
            : undefined
          : vendorIconKey(vendor, n);
      box = {
        id,
        vendor,
        cls: vendor === 'aws' ? `aws ${awsCls}` : `${vendor} subnet`,
        nodeId: id,
        label,
        ...(icon !== undefined ? { iconKey: icon } : {}),
      };
      const rank = exposure === 'public' ? 0 : exposure === 'private' ? 1 : 2;
      order = `s|${rank}|${id}`;
    }
    const c = newContainer(order, box);
    parent.children.push(c);
    boxOfNode.set(id, c);
    return c;
  };

  const homeMemo = new Set<string>();
  const homeOf = (id: string): Container => {
    const placed = tileHome.get(id);
    if (placed !== undefined) return placed;
    const vendor = vendorOf(id);
    if (vendor === undefined) return loose;
    if (homeMemo.has(id)) return cloudOf(vendor, acctOf(id));
    homeMemo.add(id);
    const anchor = anchorOf(id);
    const n = node(id);
    let home: Container;
    if (anchor !== undefined && isBox(anchor)) home = ensureBox(anchor);
    else if (anchor !== undefined) home = homeOf(anchor);
    else if (vendor === 'gcp' || infraScope(n.kind) === 'global')
      home = cloudOf(vendor, acctOf(id));
    else home = regionalHome(vendor, acctOf(id), regionOf(id));
    tileHome.set(id, home);
    return home;
  };

  for (const id of ids) {
    if (isBox(id)) ensureBox(id);
  }
  const tileIds = ids.filter((id) => !isBox(id));
  for (const id of tileIds) homeOf(id).tiles.push(id);

  const tileRank = (id: string): number => {
    const r = TILE_ORDER.indexOf(node(id).kind);
    return r < 0 ? TILE_ORDER.length : r;
  };
  const sortTree = (c: Container): void => {
    c.tiles.sort((a, b) => tileRank(a) - tileRank(b) || compareStr(a, b));
    c.children.sort((a, b) => compareStr(a.order, b.order));
    for (const ch of c.children) sortTree(ch);
  };
  const top: Container[] = [
    ...(loose.tiles.length > 0 ? [loose] : []),
    ...[...clouds.values()].sort((a, b) => compareStr(a.order, b.order)),
  ];
  for (const c of top) sortTree(c);

  // ── 크기 재기와 자리 잡기 ──
  const tileBlock = (n: number): { w: number; h: number; cols: number } => {
    const cols = Math.min(INFRA_MAX_COLS, n);
    const rows = Math.ceil(n / cols);
    return {
      w: (cols - 1) * INFRA_COL_PITCH + INFRA_NODE_W,
      h: rows * INFRA_ROW_PITCH - INFRA_BOX_INSET,
      cols,
    };
  };
  const sizes = new Map<Container, { w: number; h: number }>();
  const contentSize = (c: Container): { w: number; h: number } => {
    const items: { w: number; h: number }[] = [];
    if (c.tiles.length > 0) items.push(tileBlock(c.tiles.length));
    for (const ch of c.children) items.push(measure(ch));
    if (items.length === 0) return { w: EMPTY_INNER_W, h: EMPTY_INNER_H };
    return {
      w: items.reduce((s, it) => s + it.w, 0) + (items.length - 1) * INFRA_ITEM_GAP,
      h: Math.max(...items.map((it) => it.h)),
    };
  };
  const measure = (c: Container): { w: number; h: number } => {
    const known = sizes.get(c);
    if (known !== undefined) return known;
    const inner = contentSize(c);
    const size =
      c.box === undefined
        ? inner
        : {
            w: Math.max(inner.w + 2 * INFRA_BOX_INSET, labelWidth(c.box)),
            h: INFRA_BOX_HEAD + inner.h + INFRA_BOX_INSET,
          };
    sizes.set(c, size);
    return size;
  };

  const boxes: InfraBox[] = [];
  const tiles: InfraTile[] = [];
  const tileAt = new Map<string, InfraTile>();
  const placeContent = (c: Container, x: number, y: number): void => {
    let cursor = x;
    if (c.tiles.length > 0) {
      const block = tileBlock(c.tiles.length);
      c.tiles.forEach((id, i) => {
        const col = i % block.cols;
        const row = Math.floor(i / block.cols);
        const left = cursor + col * INFRA_COL_PITCH;
        const t: InfraTile = {
          id,
          x: left,
          y: y + row * INFRA_ROW_PITCH,
          cx: left + NODE_HALF,
          ...(vendorOf(id) !== undefined ? { vendor: vendorOf(id)! } : {}),
        };
        tiles.push(t);
        tileAt.set(id, t);
      });
      cursor += block.w + INFRA_ITEM_GAP;
    }
    for (const ch of c.children) {
      place(ch, cursor, y);
      cursor += measure(ch).w + INFRA_ITEM_GAP;
    }
  };
  const place = (c: Container, x: number, y: number): void => {
    if (c.box === undefined) {
      placeContent(c, x, y);
      return;
    }
    const size = measure(c);
    boxes.push({ ...c.box, x, y, width: size.w, height: size.h });
    placeContent(c, x + INFRA_BOX_INSET, y + INFRA_BOX_HEAD);
  };

  let cursor = INFRA_CANVAS_PAD;
  let maxH = 0;
  for (const c of top) {
    place(c, cursor, INFRA_CANVAS_PAD);
    const s = measure(c);
    cursor += s.w + INFRA_ITEM_GAP;
    maxH = Math.max(maxH, s.h);
  }
  const width = top.length > 0 ? cursor - INFRA_ITEM_GAP + INFRA_CANVAS_PAD : 2 * INFRA_CANVAS_PAD;
  const height = maxH + 2 * INFRA_CANVAS_PAD;

  // 아이콘. AWS 워크로드는 따로 그릴 아이콘이 없어 매단 클러스터 아이콘을 따른다
  for (const t of tiles) {
    if (t.vendor === undefined) continue;
    const own = vendorIconKey(t.vendor, node(t.id));
    const anchor = anchorOf(t.id);
    const inherited =
      own === undefined && node(t.id).kind === 'workload' && anchor !== undefined
        ? vendorIconKey(t.vendor, node(anchor))
        : undefined;
    const key = own ?? inherited;
    if (key !== undefined) t.iconKey = key;
  }

  const drawn = input.edges
    .filter((e) => e.from !== e.to && tileAt.has(e.from) && tileAt.has(e.to))
    .sort((a, b) => compareStr(a.id, b.id));
  const router = drawn.length > 0 ? makeRouter([...tileAt.values()], width, height) : undefined;
  // 선 글자가 박스 라벨이나 타일을 덮지 않게 비켜 놓는다
  const avoid = [...boxes.map(boxLabelRect), ...tiles.flatMap(obstaclesOf)];
  const edges: InfraEdge[] = drawn.map((e) => {
    const a = tileAt.get(e.from)!;
    const b = tileAt.get(e.to)!;
    const pts = router!.route(a, b);
    return {
      id: e.id,
      from: e.from,
      to: e.to,
      kind: e.kind,
      lineStyle: e.lineStyle,
      d: pathOf(pts),
      labelAt: labelSpot(pts, avoid),
      aws: a.vendor === 'aws' && b.vendor === 'aws',
    };
  });

  const iconKeys = [
    ...new Set(
      [...boxes.map((b) => b.iconKey), ...tiles.map((t) => t.iconKey)].filter(
        (k): k is string => k !== undefined,
      ),
    ),
  ].sort(compareStr);
  return { width, height, boxes, tiles, edges, iconKeys };
}

// ── 직각 경로 ──

interface Pt {
  x: number;
  y: number;
}
interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

interface Port {
  p: Pt;
  /** 타일에서 바깥으로 나가는 방향(0 오른쪽, 1 아래, 2 왼쪽, 3 위). 들어올 때는 그 반대로 들어온다 */
  out: number;
}

function portsOf(t: InfraTile): Port[] {
  const midY = t.y + TILE_HALF;
  return [
    { p: { x: t.cx + TILE_HALF + PORT_GAP, y: midY }, out: 0 },
    { p: { x: t.cx, y: t.y + INFRA_NODE_H + PORT_GAP }, out: 1 },
    { p: { x: t.cx - TILE_HALF - PORT_GAP, y: midY }, out: 2 },
    { p: { x: t.cx, y: t.y - PORT_GAP }, out: 3 },
  ];
}

/** 타일과 그 아래 글자 상자. 선이 안쪽을 지나면 안 되고 테두리에 닿는 건 괜찮다 */
function obstaclesOf(t: InfraTile): Rect[] {
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

/** 성긴 격자 위 다익스트라. 상태는 (점, 들어온 방향)이고 꺾을 때마다 BEND_COST를 더한다 */
function makeRouter(
  tiles: readonly InfraTile[],
  width: number,
  height: number,
): { route: (a: InfraTile, b: InfraTile) => Pt[] } {
  const edgeX = INFRA_CANVAS_PAD / 2;
  const cxs = uniqSorted(tiles.map((t) => t.cx));
  const xs = uniqSorted([
    edgeX,
    width - edgeX,
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
    edgeX,
    height - edgeX,
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

  const route = (a: InfraTile, b: InfraTile): Pt[] => {
    const states = nx * ny * 4;
    const dist = new Float64Array(states).fill(Infinity);
    const prev = new Int32Array(states).fill(-1);
    const start = new Uint8Array(states);
    const goal = new Uint8Array(states);
    const heap = new MinHeap();
    for (const port of portsOf(a)) {
      const s = keyOf(port.p) * 4 + port.out;
      dist[s] = 0;
      start[s] = 1;
      heap.push(0, s);
    }
    for (const port of portsOf(b)) goal[keyOf(port.p) * 4 + ((port.out + 2) % 4)] = 1;
    let found = -1;
    while (heap.size > 0) {
      const [cost, s] = heap.pop();
      if (cost > dist[s]!) continue;
      if (goal[s] === 1) {
        found = s;
        break;
      }
      const k = s >> 2;
      const d = s & 3;
      for (let nd = 0; nd < 4; nd++) {
        if (nd === (d + 2) % 4) continue;
        // 포트에서는 타일 바깥쪽으로만 나간다
        if (start[s] === 1 && nd !== d) continue;
        const q = step(k, nd);
        if (q < 0) continue;
        const p0 = pointOf(k);
        const p1 = pointOf(q);
        const next =
          cost + Math.abs(p1.x - p0.x) + Math.abs(p1.y - p0.y) + (nd === d ? 0 : BEND_COST);
        const t = q * 4 + nd;
        if (next < dist[t]!) {
          dist[t] = next;
          prev[t] = s;
          heap.push(next, t);
        }
      }
    }
    if (found < 0) {
      // 막힌 길이 없게 격자를 짰지만 혹시 갇히면 오른쪽 포트끼리 계단으로 잇는다
      const from = portsOf(a)[0]!.p;
      const to = portsOf(b)[2]!.p;
      const midX = (from.x + to.x) / 2;
      return [from, { x: midX, y: from.y }, { x: midX, y: to.y }, to];
    }
    const pts: Pt[] = [];
    for (let s = found; s >= 0; s = prev[s]!) pts.push(pointOf(s >> 2));
    return pts.reverse();
  };
  return { route };
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

function pathOf(raw: readonly Pt[]): string {
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

/** 박스 왼쪽 위 라벨이 차지하는 자리. 글자 폭은 재지 않고 글자 수로 어림한다 */
function boxLabelRect(b: InfraBox): Rect {
  const text = [...b.label].reduce((w, ch) => w + (ch.codePointAt(0)! >= 0x2e80 ? 12 : 7.5), 0);
  return { x1: b.x, y1: b.y, x2: b.x + 12 + 38 + text, y2: b.y + 34 };
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x1 < b.x2 && b.x1 < a.x2 && a.y1 < b.y2 && b.y1 < a.y2;
// 선 글자 상자 어림. 글자가 두세 자라 폭을 고정한다
const EDGE_LABEL_HALF_W = 18;
const LABEL_SHIFT = 20;

function labelSpot(raw: readonly Pt[], avoid: readonly Rect[]): InfraEdge['labelAt'] {
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
