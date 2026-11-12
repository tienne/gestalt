import { resolveInfraPlacement } from './infra-placement.js';
import type {
  ArchitectureNode,
  CloudProvider,
  EdgeKind,
  LineStyle,
  NodeKind,
  SubnetExposure,
} from './types.js';
import { BOX_ICONS, iconKey, vendorIconKey } from './vendor-icon-keys.js';
import {
  INFRA_NODE_W,
  labelSpot,
  makeRouter,
  obstaclesOf,
  pathOf,
  type LabelSpot,
  type Rect,
} from './infra-router.js';

export { INFRA_NODE_H, INFRA_NODE_W, INFRA_TILE } from './infra-router.js';

const NODE_HALF = INFRA_NODE_W / 2;
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

export interface InfraEdgeInput {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  lineStyle: LineStyle;
}

export interface InfraBox {
  /** 노드 박스면 노드 id, IR에 없는 박스면 `cloud:<벤더>:<계정>`이나 `region:<벤더>:<계정>:<리전>`, GCP 리전은 `region:<VPC id>:<리전>` 꼴 */
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
  /** 타일을 담은 가장 안쪽 박스의 InfraBox.id. 벤더가 없어 박스 밖에 선 타일이면 없다 */
  boxId?: string;
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
  labelAt: LabelSpot;
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

/**
 * placedIn이나 parent가 같은 벤더의 network, subnet, cluster를 가리키지 않는 노드를 벤더 박스 안 어디에 둘지.
 * GCP는 이 값과 상관없이 VPC 밖에 둔다
 */
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

/**
 * 박스 왼쪽 위 라벨이 왼쪽 테두리부터 차지하는 폭. 박스 폭과 선 글자 회피 영역이 같은 값을 써야 서로 어긋나지 않는다.
 * 글자 폭은 재지 않고 글자 수로 어림한다. 한글은 12px 글자 하나가 거의 정사각형이다
 */
function boxLabelExtent(box: Pick<BoxSpec, 'vendor' | 'label' | 'iconKey'>): number {
  let text = 0;
  for (const ch of box.label) text += ch.codePointAt(0)! >= 0x2e80 ? 12 : 7.2;
  // 라벨 아이콘은 AWS가 30px, GCP와 Azure가 20px이고 글자와 8px 띄운다
  const icon = box.iconKey === undefined ? 0 : box.vendor === 'aws' ? 38 : 28;
  return 12 + icon + text;
}

function labelWidth(box: BoxSpec): number {
  return Math.ceil(boxLabelExtent(box) + 12);
}

function boxLabelRect(b: InfraBox): Rect {
  return { x1: b.x, y1: b.y, x2: b.x + boxLabelExtent(b), y2: b.y + 34 };
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

  // 노드가 설 자리를 정하는 기준 노드. placedIn이나 parent가 같은 벤더의 network나 subnet을 가리키면 그 박스에 들어가고
  // cluster를 가리키면 그 클러스터와 같은 박스에 선다. 벤더가 엇갈리면 경고로 이미 알렸으니 따르지 않는다
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
      const icon = vendorIconKey(vendor, n);
      box = {
        id,
        vendor,
        cls: `${vendor} ${VNET_CLASS[vendor]}`,
        nodeId: id,
        label,
        ...(icon !== undefined ? { iconKey: icon } : {}),
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
          ...(c.box !== undefined ? { boxId: c.box.id } : {}),
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

  // 아이콘. AWS 워크로드는 따로 그릴 아이콘이 없어 placedIn이나 parent가 가리키는 노드(대개 클러스터)의 아이콘을 따른다
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
  const router =
    drawn.length > 0
      ? makeRouter([...tileAt.values()], width, height, INFRA_CANVAS_PAD / 2)
      : undefined;
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
