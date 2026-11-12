import { describe, expect, it } from 'vitest';
import {
  computeInfraLayout,
  INFRA_MAX_COLS,
  INFRA_NODE_H,
  INFRA_NODE_W,
  INFRA_TILE,
  infraScope,
  type InfraBox,
  type InfraEdgeInput,
  type InfraLayout,
  type InfraTile,
} from '../../../src/architecture/infra-layout.js';
import type { ArchitectureIr, ArchitectureNode } from '../../../src/architecture/index.js';
import { edge, node } from '../../fixtures/architecture-categories/common.js';
import { awsIr, azureIr, gcpIr } from '../../fixtures/architecture-infra/vendors.js';

function layoutOf(
  ir: ArchitectureIr,
  order?: { nodes?: ArchitectureNode[]; edges?: ArchitectureIr['edges'] },
): InfraLayout {
  const nodes = order?.nodes ?? ir.nodes;
  const edges: InfraEdgeInput[] = (order?.edges ?? ir.edges).map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    kind: e.kind,
    lineStyle: e.lineStyle,
  }));
  return computeInfraLayout({ nodes, nodeIds: ir.nodes.map((n) => n.id), edges });
}

const box = (l: InfraLayout, id: string): InfraBox => {
  const b = l.boxes.find((x) => x.id === id || x.nodeId === id);
  if (!b) throw new Error(`박스 ${id}가 없다: ${l.boxes.map((x) => x.id).join(', ')}`);
  return b;
};
const tile = (l: InfraLayout, id: string): InfraTile => {
  const t = l.tiles.find((x) => x.id === id);
  if (!t) throw new Error(`타일 ${id}가 없다`);
  return t;
};

type Rect = { x: number; y: number; width: number; height: number };
const tileRect = (t: InfraTile): Rect => ({
  x: t.x,
  y: t.y,
  width: INFRA_NODE_W,
  height: INFRA_NODE_H,
});
const contains = (outer: Rect, inner: Rect): boolean =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width &&
  inner.y + inner.height <= outer.y + outer.height;
const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** M, H, V만 쓰는 경로를 선분으로 푼다 */
function segments(d: string): Array<[number, number, number, number]> {
  const out: Array<[number, number, number, number]> = [];
  let x = 0;
  let y = 0;
  for (const m of d.matchAll(/([MHV])\s*(-?\d+(?:\.\d+)?)(?:\s+(-?\d+(?:\.\d+)?))?/g)) {
    const a = Number(m[2]);
    if (m[1] === 'M') {
      x = a;
      y = Number(m[3]);
    } else if (m[1] === 'H') {
      out.push([x, y, a, y]);
      x = a;
    } else {
      out.push([x, y, x, a]);
      y = a;
    }
  }
  return out;
}
const crossesInterior = (seg: [number, number, number, number], r: Rect): boolean => {
  const [x1, y1, x2, y2] = seg;
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  return minX < r.x + r.width && maxX > r.x && minY < r.y + r.height && maxY > r.y;
};

describe('computeInfraLayout 벤더별 박스 트리', () => {
  it('AWS는 Cloud > Region > VPC > public/private subnet 순으로 겹겹이 두른다', () => {
    const l = layoutOf(awsIr());
    expect(l.boxes.map((b) => b.cls)).toEqual([
      'aws cloud',
      'aws region',
      'aws vpc',
      'aws public',
      'aws private',
    ]);
    const cloud = box(l, 'acct');
    const region = box(l, 'region:aws:acct:ap-northeast-2');
    const vpc = box(l, 'vpc');
    expect(cloud.label).toBe('acme-prod');
    expect(region.label).toBe('ap-northeast-2');
    expect(contains(cloud, region)).toBe(true);
    expect(contains(region, vpc)).toBe(true);
    expect(contains(vpc, box(l, 'sn-pub'))).toBe(true);
    expect(contains(vpc, box(l, 'sn-prv'))).toBe(true);
    expect(overlaps(box(l, 'sn-pub'), box(l, 'sn-prv'))).toBe(false);
  });

  it('AWS에서 domain과 cdn은 Cloud 안 Region 밖, bucket은 Region 안 VPC 밖에 선다', () => {
    const l = layoutOf(awsIr());
    const cloud = box(l, 'acct');
    const region = box(l, 'region:aws:acct:ap-northeast-2');
    const vpc = box(l, 'vpc');
    for (const id of ['dns', 'cdn']) {
      const r = tileRect(tile(l, id));
      expect(contains(cloud, r), `${id}는 Cloud 안`).toBe(true);
      expect(overlaps(region, r), `${id}는 Region 밖`).toBe(false);
    }
    const bucket = tileRect(tile(l, 'assets'));
    expect(contains(region, bucket)).toBe(true);
    expect(overlaps(vpc, bucket)).toBe(false);
  });

  it('placedIn으로 매단 타일은 그 서브넷 박스 안에 선다', () => {
    const l = layoutOf(awsIr());
    expect(contains(box(l, 'sn-pub'), tileRect(tile(l, 'lb')))).toBe(true);
    expect(contains(box(l, 'sn-prv'), tileRect(tile(l, 'api')))).toBe(true);
    expect(contains(box(l, 'sn-prv'), tileRect(tile(l, 'db')))).toBe(true);
    expect(overlaps(box(l, 'sn-pub'), tileRect(tile(l, 'db')))).toBe(false);
  });

  it('exposure를 안 적은 AWS 서브넷은 public/private으로 추정하지 않고 중립 박스로 그린다', () => {
    const ir = awsIr();
    ir.nodes = ir.nodes.map(({ exposure: _e, ...n }) => n);
    const l = layoutOf(ir);
    const subnet = box(l, 'sn-pub');
    expect(subnet.cls).toBe('aws subnet');
    expect(l.boxes.some((b) => b.cls === 'aws public' || b.cls === 'aws private')).toBe(false);
  });

  it('GCP는 Google Cloud > VPC > region > subnet이고 글로벌과 서버리스는 VPC 밖에 선다', () => {
    const l = layoutOf(gcpIr());
    expect(l.boxes.map((b) => b.cls)).toEqual(['gcp cloud', 'gcp vpc', 'gcp region', 'gcp subnet']);
    const cloud = l.boxes[0]!;
    expect(cloud.label).toBe('Google Cloud');
    const vpc = box(l, 'vpc');
    const region = l.boxes.find((b) => b.cls === 'gcp region')!;
    expect(region.label).toBe('asia-northeast3');
    expect(contains(cloud, vpc)).toBe(true);
    expect(contains(vpc, region)).toBe(true);
    expect(contains(region, box(l, 'sn'))).toBe(true);
    expect(contains(box(l, 'sn'), tileRect(tile(l, 'svc')))).toBe(true);
    for (const id of ['run', 'store', 'dns']) {
      const r = tileRect(tile(l, id));
      expect(contains(cloud, r), `${id}는 Cloud 안`).toBe(true);
      expect(overlaps(vpc, r), `${id}는 VPC 밖`).toBe(false);
    }
  });

  it('Azure는 Azure > region > VNet > subnet이고 Front Door와 domain은 region 밖에 선다', () => {
    const l = layoutOf(azureIr());
    expect(l.boxes.map((b) => b.cls)).toEqual([
      'azure cloud',
      'azure region',
      'azure vnet',
      'azure subnet',
    ]);
    const cloud = l.boxes[0]!;
    const region = l.boxes[1]!;
    expect(region.label).toBe('koreacentral');
    expect(contains(cloud, region)).toBe(true);
    expect(contains(region, box(l, 'vnet'))).toBe(true);
    expect(contains(box(l, 'vnet'), box(l, 'sn'))).toBe(true);
    expect(contains(box(l, 'sn'), tileRect(tile(l, 'app')))).toBe(true);
    for (const id of ['fd', 'dns']) {
      const r = tileRect(tile(l, id));
      expect(contains(cloud, r), `${id}는 Cloud 안`).toBe(true);
      expect(overlaps(region, r), `${id}는 region 밖`).toBe(false);
    }
  });

  it('provider가 없는 노드는 박스 없이 타일 격자로만 선다', () => {
    const ir = awsIr();
    const plain = [
      node('x-db', 'datastore', { engine: 'mysql' }),
      node('x-bucket', 'bucket'),
      node('x-dns', 'domain'),
    ];
    const l = layoutOf({ ...ir, nodes: plain, edges: [edge('e', 'x-dns', 'x-db', 'connects')] });
    expect(l.boxes).toEqual([]);
    expect(l.tiles.map((t) => t.id).sort()).toEqual(['x-bucket', 'x-db', 'x-dns']);
    expect(l.tiles.every((t) => t.vendor === undefined)).toBe(true);
    expect(overlaps(tileRect(tile(l, 'x-db')), tileRect(tile(l, 'x-bucket')))).toBe(false);
  });

  it('벤더가 섞이면 벤더마다 Cloud 박스를 따로 세우고 provider 없는 타일은 박스 밖이다', () => {
    const a = awsIr();
    const g = gcpIr();
    const prefixed = (n: ArchitectureNode): ArchitectureNode => ({
      ...n,
      id: `g-${n.id}`,
      ...(n.parent !== undefined ? { parent: `g-${n.parent}` } : {}),
      ...(n.placedIn !== undefined ? { placedIn: `g-${n.placedIn}` } : {}),
    });
    const loose = node('loose', 'datastore', { engine: 'redis' });
    const nodes = [...a.nodes, ...g.nodes.map(prefixed), loose];
    const l = layoutOf({ ...a, nodes, edges: [] });
    const clouds = l.boxes.filter((b) => b.cls.endsWith(' cloud'));
    expect(clouds.map((b) => b.vendor).sort()).toEqual(['aws', 'gcp']);
    expect(overlaps(clouds[0]!, clouds[1]!)).toBe(false);
    for (const c of clouds) expect(overlaps(c, tileRect(tile(l, 'loose')))).toBe(false);
  });

  it('계정이 여럿이면 계정마다 벤더 박스를 세우고 라벨은 displayName을 우선한다', () => {
    const nodes = [
      node('acct-a', 'cloud_account', {
        label: '111111111111',
        displayName: 'acme-a',
        provider: 'aws',
      }),
      node('acct-b', 'cloud_account', { label: 'acme-b-label', provider: 'aws' }),
      node('db-a', 'datastore', { account: 'acct-a', engine: 'mysql', region: 'us-east-1' }),
      node('db-b', 'datastore', { account: 'acct-b', engine: 'mysql', region: 'us-east-1' }),
    ];
    const l = layoutOf({ ...awsIr(), nodes, edges: [] });
    const clouds = l.boxes.filter((b) => b.cls === 'aws cloud');
    expect(clouds.map((b) => b.label).sort()).toEqual(['acme-a', 'acme-b-label']);
    expect(overlaps(clouds[0]!, clouds[1]!)).toBe(false);
  });

  it('박스 노드(cloud_account, network, subnet)는 타일로 세우지 않고 박스에 data-node-id용 nodeId를 단다', () => {
    const l = layoutOf(awsIr());
    expect(l.tiles.map((t) => t.id)).not.toContain('acct');
    expect(l.tiles.map((t) => t.id)).not.toContain('vpc');
    expect(l.tiles.map((t) => t.id)).not.toContain('sn-pub');
    expect(l.boxes.filter((b) => b.nodeId !== undefined).map((b) => b.nodeId)).toEqual(
      expect.arrayContaining(['acct', 'vpc', 'sn-pub', 'sn-prv']),
    );
    expect(box(l, 'region:aws:acct:ap-northeast-2').nodeId).toBeUndefined();
  });

  it('한 박스 안 타일은 한 행에 INFRA_MAX_COLS개까지고 넘치면 줄바꿈한다', () => {
    const many = Array.from({ length: INFRA_MAX_COLS + 2 }, (_, i) =>
      node(`w${i}`, 'deploy_target', { placedIn: 'sn', engine: 'lambda' }),
    );
    const nodes = [
      node('vpc', 'network', { provider: 'aws', region: 'us-east-1' }),
      node('sn', 'subnet', { parent: 'vpc', exposure: 'private' }),
      ...many,
    ];
    const l = layoutOf({ ...awsIr(), nodes, edges: [] });
    const ts = many.map((n) => tile(l, n.id));
    expect(new Set(ts.map((t) => t.x)).size).toBe(INFRA_MAX_COLS);
    expect(new Set(ts.map((t) => t.y)).size).toBe(2);
    expect(ts.every((t) => contains(box(l, 'sn'), tileRect(t)))).toBe(true);
    for (let i = 0; i < ts.length; i++) {
      for (let j = i + 1; j < ts.length; j++) {
        expect(overlaps(tileRect(ts[i]!), tileRect(ts[j]!))).toBe(false);
      }
    }
  });
});

describe('computeInfraLayout 선', () => {
  it.each([
    ['aws', awsIr],
    ['gcp', gcpIr],
    ['azure', azureIr],
  ])('%s 선은 M, H, V로만 이뤄지고 어떤 노드 상자도 관통하지 않는다', (_name, build) => {
    const l = layoutOf(build());
    expect(l.edges.length).toBeGreaterThan(0);
    for (const e of l.edges) {
      expect(e.d).toMatch(/^M[\d.\s-]+(?:[HV][\d.-]+\s?)+$/);
      for (const seg of segments(e.d)) {
        for (const t of l.tiles) {
          // 선은 자기 끝점 타일의 옆면에서 나오므로 끝점은 아이콘 타일(60x60)만, 나머지는 글자까지 든 상자 전체를 피한다
          const own = t.id === e.from || t.id === e.to;
          const r: Rect = own
            ? { x: t.cx - INFRA_TILE / 2, y: t.y, width: INFRA_TILE, height: INFRA_TILE }
            : tileRect(t);
          expect(crossesInterior(seg, r), `${e.id}가 ${t.id}를 지난다: ${e.d}`).toBe(false);
        }
      }
    }
  });

  it('사이에 낀 타일을 돌아서 잇는다', () => {
    const nodes = [
      node('vpc', 'network', { provider: 'aws', region: 'us-east-1' }),
      node('sn', 'subnet', { parent: 'vpc', exposure: 'private' }),
      ...['a', 'b', 'c'].map((id) => node(id, 'deploy_target', { placedIn: 'sn', engine: 'ec2' })),
    ];
    const l = layoutOf({ ...awsIr(), nodes, edges: [edge('e-ac', 'a', 'c', 'connects')] });
    expect(tile(l, 'a').y).toBe(tile(l, 'b').y);
    expect(tile(l, 'b').y).toBe(tile(l, 'c').y);
    const e = l.edges.find((x) => x.id === 'e-ac')!;
    const b = tileRect(tile(l, 'b'));
    for (const seg of segments(e.d)) expect(crossesInterior(seg, b)).toBe(false);
    expect(segments(e.d).length).toBeGreaterThan(1);
  });

  it('선 글자 자리는 선 가까이에 있고 가로면 가운데, 세로면 시작 정렬이다', () => {
    const l = layoutOf(awsIr());
    for (const e of l.edges) {
      expect(['middle', 'start']).toContain(e.labelAt.anchor);
      expect(Number.isFinite(e.labelAt.x) && Number.isFinite(e.labelAt.y)).toBe(true);
    }
  });

  it('박스 노드에 닿는 선과 자기 자신으로 가는 선은 그리지 않는다', () => {
    const ir = awsIr();
    const extra = [
      edge('e-box', 'vpc', 'lb', 'connects'),
      edge('e-box2', 'api', 'sn-prv', 'connects'),
      edge('e-self', 'api', 'api', 'connects'),
    ];
    const l = layoutOf({ ...ir, edges: [...ir.edges, ...extra] });
    const ids = l.edges.map((e) => e.id);
    expect(ids).not.toContain('e-box');
    expect(ids).not.toContain('e-box2');
    expect(ids).not.toContain('e-self');
    expect(ids).toContain('e-lb-api');
  });

  it('양 끝이 AWS 박스 안인 선만 aws 표시를 단다', () => {
    const l = layoutOf(awsIr());
    expect(l.edges.find((e) => e.id === 'e-lb-api')!.aws).toBe(true);
    const mixed = layoutOf({
      ...awsIr(),
      nodes: [...awsIr().nodes, node('loose', 'datastore', { engine: 'redis' })],
      edges: [edge('e-x', 'api', 'loose', 'connects')],
    });
    expect(mixed.edges.find((e) => e.id === 'e-x')!.aws).toBe(false);
  });
});

describe('computeInfraLayout 결정성', () => {
  it.each([
    ['aws', awsIr],
    ['gcp', gcpIr],
    ['azure', azureIr],
  ])('%s는 같은 입력이면 같은 좌표다', (_name, build) => {
    expect(JSON.stringify(layoutOf(build()))).toBe(JSON.stringify(layoutOf(build())));
  });

  it('노드와 엣지를 입력한 순서가 달라도 같은 좌표다', () => {
    const ir = awsIr();
    const shuffled = layoutOf(ir, {
      nodes: [...ir.nodes].reverse(),
      edges: [...ir.edges].reverse(),
    });
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(layoutOf(ir)));
  });

  it('iconKeys는 정렬돼 있고 겹치지 않는다', () => {
    const l = layoutOf(awsIr());
    expect(l.iconKeys).toEqual([...new Set(l.iconKeys)].sort());
    expect(l.iconKeys).toContain('aws:CloudFront');
    expect(l.iconKeys).toContain('aws:Lambda');
  });

  it('캔버스 크기는 모든 박스와 타일을 담는다', () => {
    for (const build of [awsIr, gcpIr, azureIr]) {
      const l = layoutOf(build());
      for (const b of l.boxes) {
        expect(b.x + b.width).toBeLessThanOrEqual(l.width);
        expect(b.y + b.height).toBeLessThanOrEqual(l.height);
      }
      for (const t of l.tiles) {
        expect(t.x + INFRA_NODE_W).toBeLessThanOrEqual(l.width);
        expect(t.y + INFRA_NODE_H).toBeLessThanOrEqual(l.height);
      }
    }
  });
});

describe('infraScope', () => {
  it('domain과 cdn만 global이고 나머지는 regional이다', () => {
    expect(infraScope('domain')).toBe('global');
    expect(infraScope('cdn')).toBe('global');
    for (const k of [
      'bucket',
      'datastore',
      'deploy_target',
      'cluster',
      'workload',
      'firewall',
    ] as const) {
      expect(infraScope(k)).toBe('regional');
    }
  });
});
