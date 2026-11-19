import { describe, expect, it } from 'vitest';
import {
  computeDrilldown,
  drillLevelOwners,
  INFRA_LEVEL_ID,
  mergeArchitectureIrs,
  shouldDrillDown,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type DrillLevel,
  type Evidence,
  type ValidatedIr,
} from '../../../src/architecture/index.js';
import { LEGACY_IRS, renderBoth } from '../../fixtures/architecture-legacy/render.js';
import { harnessIr, partnerIr, webIr } from '../../fixtures/architecture-legacy/irs.js';
import { infraIr } from '../../fixtures/architecture-categories/infra.js';
import { awsIr } from '../../fixtures/architecture-infra/vendors.js';

const codeEv: Evidence = { type: 'code', location: 'web:src/a.ts:1', visibility: 'public' };
const docEv: Evidence = { type: 'doc', location: 'https://docs.acme.test/a', visibility: 'public' };

function node(
  id: string,
  kind: ArchitectureNode['kind'],
  parent?: string,
  evidence: Evidence[] = [codeEv],
): ArchitectureNode {
  return { id, kind, label: id, repo: 'web', evidence, ...(parent ? { parent } : {}) };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: ArchitectureEdge['kind'],
  evidence: Evidence[] = [codeEv],
): ArchitectureEdge {
  const lineStyle = evidence.some((e) => e.type === 'code') ? 'solid' : 'dashed';
  return { id, from, to, kind, evidence, lineStyle };
}

function fixture(): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '/srv/acme-web' }],
    nodes: [
      node('svc-web', 'service'),
      node('svc-admin', 'service'),
      node('f-orders', 'feature', 'svc-web'),
      node('f-cart', 'feature', 'svc-web'),
      node('s-list', 'screen', 'f-orders'),
      node('s-detail', 'screen', 'f-orders'),
      node('s-cart', 'screen', 'f-cart'),
      node('s-admin', 'screen', 'svc-admin'),
      node('gw', 'gateway'),
      node('ep-orders', 'endpoint'),
      node('ep-cart', 'endpoint'),
      node('ep-admin', 'endpoint'),
      node('m-orders', 'app_module'),
      node('m-cart', 'app_module'),
      node('m-admin', 'app_module'),
      node('x-pay', 'external_service'),
      node('t-orders', 'db_table'),
    ],
    edges: [
      edge('c1', 's-list', 'ep-orders', 'calls'),
      edge('c2', 's-detail', 'ep-orders', 'calls'),
      edge('c3', 's-cart', 'ep-cart', 'calls'),
      edge('c4', 's-admin', 'ep-admin', 'calls'),
      edge('r1', 'gw', 'ep-orders', 'routes'),
      edge('r2', 'gw', 'ep-cart', 'routes'),
      edge('h1', 'ep-orders', 'm-orders', 'handles'),
      edge('h2', 'ep-cart', 'm-cart', 'handles'),
      edge('h3', 'ep-admin', 'm-admin', 'handles'),
      edge('u1', 'm-cart', 'x-pay', 'uses'),
      edge('k1', 'x-pay', 'm-orders', 'calls', [docEv]),
      edge('rw1', 'm-orders', 't-orders', 'reads_writes'),
      edge('n1', 's-cart', 's-list', 'navigates'),
      edge('n2', 's-list', 's-detail', 'navigates'),
    ],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function validated(ir: ArchitectureIr): ValidatedIr {
  const result = validateArchitectureIr(ir, { checkFiles: false });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function level(levels: DrillLevel[], id: string): DrillLevel {
  const found = levels.find((l) => l.id === id);
  if (!found) throw new Error(`no level ${id}`);
  return found;
}

const summarize = (l: DrillLevel) =>
  l.edges.map((e) => [e.from, e.to, e.count, e.memberEdgeIds.join(',')]);

/** 바깥 카드와 거기 걸린 선을 뺀 레벨. 레벨 안 구성만 볼 때 쓴다 */
function inner(l: DrillLevel): DrillLevel {
  const out = new Set([...(l.outside?.from ?? []), ...(l.outside?.to ?? [])]);
  return {
    ...l,
    nodeIds: l.nodeIds.filter((id) => !out.has(id)),
    edges: l.edges.filter((e) => !out.has(e.from) && !out.has(e.to)),
  };
}

describe('shouldDrillDown', () => {
  it('그려지는 service 노드가 있을 때만 참이다', () => {
    expect(shouldDrillDown(validated(fixture()))).toBe(true);
    const ir = fixture();
    ir.nodes = ir.nodes.map((n) => (n.kind === 'service' ? { ...n, evidence: [] } : n));
    expect(shouldDrillDown(validated(ir))).toBe(false);
  });
});

describe('computeDrilldown', () => {
  it('root는 service, gateway, app_module만 두고 네 가지 묶음 엣지를 만든다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const root = levels[0]!;
    expect(root.id).toBe('root');
    expect(root.nodeIds).toEqual(['gw', 'm-admin', 'm-cart', 'm-orders', 'svc-admin', 'svc-web']);
    expect(summarize(root)).toEqual([
      ['gw', 'm-cart', 1, 'h2,r2'],
      ['gw', 'm-orders', 1, 'h1,r1'],
      ['m-cart', 'm-orders', 1, 'k1,u1'],
      ['svc-admin', 'm-admin', 1, 'c4,h3'],
      ['svc-web', 'gw', 3, 'c1,c2,c3,r1,r2'],
    ]);
    expect(root.edges.every((e) => e.kind === 'bundle')).toBe(true);
    // 코드로 확인된 고리가 하나라도 있으면 실선이다. 문서 근거뿐인 고리 수는 따로 단다
    const mixed = root.edges.find((e) => e.from === 'm-cart')!;
    expect([mixed.lineStyle, mixed.inferred]).toEqual(['solid', 1]);
    const pure = root.edges.find((e) => e.from === 'svc-web')!;
    expect([pure.lineStyle, pure.inferred]).toEqual(['solid', undefined]);
    expect(root.layout.nodes.map((n) => n.id)).toEqual(root.nodeIds);
  });

  it('묶음 안이 전부 문서 근거일 때만 점선이다', async () => {
    const ir = fixture();
    ir.edges = ir.edges.map((e) =>
      e.id === 'u1' ? { ...e, evidence: [docEv], lineStyle: 'dashed' } : e,
    );
    const { levels } = await computeDrilldown(validated(ir));
    const bundle = levels[0]!.edges.find((e) => e.from === 'm-cart')!;
    expect([bundle.lineStyle, bundle.inferred]).toEqual(['dashed', undefined]);
  });

  it('섞인 묶음은 배지 테두리를 점선으로 그리고 이름에 문서 근거 수를 단다', async () => {
    const html = (await renderBoth(fixture())).private;
    expect(html).toContain('m-cart → m-orders 1개 (문서 근거만 있는 연결 1개 포함)</title>');
    expect(html).toContain('rx="9" stroke-dasharray="3 2"/>');
    expect(html).toContain("' (문서 근거만 있는 연결 ' + e.inferred");
  });

  it('레벨 목록과 들어갈 곳을 id 순으로 낸다', async () => {
    const { levels, enter } = await computeDrilldown(validated(fixture()));
    expect(levels.map((l) => l.id)).toEqual([
      'root',
      'feature:f-cart',
      'feature:f-orders',
      'server:gw',
      'server:m-admin',
      'server:m-cart',
      'server:m-orders',
      'service:svc-admin',
      'service:svc-web',
    ]);
    expect(enter).toEqual({
      'f-cart': 'feature:f-cart',
      'f-orders': 'feature:f-orders',
      gw: 'server:gw',
      'm-admin': 'server:m-admin',
      'm-cart': 'server:m-cart',
      'm-orders': 'server:m-orders',
      'svc-admin': 'service:svc-admin',
      'svc-web': 'service:svc-web',
    });
  });

  it('service 레벨은 서비스 → 기능 영역 → 화면을 포함 선으로 잇고 호출은 화면에서 바로 묶는다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const web = inner(level(levels, 'service:svc-web'));
    expect(web.trail).toEqual(['root', 'service:svc-web']);
    expect(web.nodeIds).toEqual([
      'f-cart',
      'f-orders',
      'gw',
      'm-cart',
      'm-orders',
      's-cart',
      's-detail',
      's-list',
      'svc-web',
    ]);
    expect(summarize(web)).toEqual([
      ['gw', 'm-cart', 1, 'h2,r2'],
      ['gw', 'm-orders', 1, 'h1,r1'],
      ['s-cart', 'gw', 1, 'c3,r2'],
      ['s-detail', 'gw', 1, 'c2,r1'],
      ['s-list', 'gw', 1, 'c1,r1'],
      ['f-cart', 's-cart', 1, ''],
      ['f-orders', 's-detail', 1, ''],
      ['f-orders', 's-list', 1, ''],
      ['svc-web', 'f-cart', 1, ''],
      ['svc-web', 'f-orders', 1, ''],
    ]);
    // 화면 사이 이동은 기능 영역 레벨에서 본다. 화면 열 안에서 휘는 선이 쌓이면 위계가 안 읽혀서다
    expect(web.edges.some((e) => e.kind === 'navigates')).toBe(false);
    // feature 없이 서비스에 바로 달린 화면은 기능 영역 열을 건너 서비스에서 바로 이어진다
    const admin = inner(level(levels, 'service:svc-admin'));
    expect(summarize(admin)).toEqual([
      ['s-admin', 'm-admin', 1, 'c4,h3'],
      ['svc-admin', 's-admin', 1, ''],
    ]);
  });

  it('server 레벨은 모듈의 엔드포인트, 테이블, 클라이언트와 그 클라이언트가 부르는 모듈을 그린다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const orders = inner(level(levels, 'server:m-orders'));
    expect(orders.nodeIds).toEqual(['ep-orders', 'm-orders', 't-orders']);
    expect(orders.edges.map((e) => e.id)).toEqual(['h1', 'rw1']);
    const cart = inner(level(levels, 'server:m-cart'));
    expect(cart.nodeIds).toEqual(['ep-cart', 'm-cart', 'm-orders', 'x-pay']);
    expect(cart.edges.map((e) => [e.id, e.kind, e.count])).toEqual([
      ['h2', 'handles', 1],
      ['k1', 'calls', 1],
      ['u1', 'uses', 1],
    ]);
    // 받는 모듈은 클라이언트보다 오른쪽에 선다
    const x = (id: string) => cart.layout.nodes.find((n) => n.id === id)!.x;
    expect(x('m-orders')).toBeGreaterThan(x('x-pay'));
    expect(inner(level(levels, 'server:gw')).edges.map((e) => e.id)).toEqual(['r1', 'r2']);
  });

  it('레벨마다 레인 구성이 다르다. 서비스는 서비스, 기능 영역, 화면 열, 서버는 테이블을 맨 오른쪽에 둔다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const lanes = (id: string) => level(levels, id).layout.lanes.map((l) => l.id);
    // m-orders는 클라이언트로도 닿지만 게이트웨이에서도 닿아 서버 레인에 남는다
    expect(lanes('root')).toEqual(['service', 'gateway', 'app_module']);
    expect(lanes('service:svc-web')).toEqual([
      'outside_from',
      'service',
      'unit',
      'screen',
      'gateway',
      'app_module',
      'outside_to',
    ]);
    expect(lanes('feature:f-orders')).toEqual(['screen', 'gateway', 'endpoint', 'app_module']);
    expect(lanes('server:m-orders')).toEqual([
      'outside_from',
      'endpoint',
      'app_module',
      'db_table',
    ]);
    expect(lanes('server:m-cart')).toEqual([
      'outside_from',
      'endpoint',
      'app_module',
      'external_service',
      'external',
      'outside_to',
    ]);
  });

  it('feature 레벨은 화면과 그 호출 경로를 세부 엣지 그대로 그린다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const orders = level(levels, 'feature:f-orders');
    expect(orders.trail).toEqual(['root', 'service:svc-web', 'feature:f-orders']);
    expect(orders.nodeIds).toEqual(['ep-orders', 'gw', 'm-orders', 's-detail', 's-list']);
    expect(orders.edges.map((e) => e.id)).toEqual(['c1', 'c2', 'h1', 'n2', 'r1']);
  });

  it('부모가 그려지지 않으면 자식은 부모 없는 노드로 친다', async () => {
    const ir = fixture();
    ir.nodes = ir.nodes.map((n) => (n.id === 'f-cart' ? { ...n, evidence: [] } : n));
    const { levels } = await computeDrilldown(validated(ir));
    expect(levels.some((l) => l.id === 'feature:f-cart')).toBe(false);
    // s-cart가 서비스에 닿지 않으니 c3는 root 묶음에서 빠진다
    const root = levels[0]!;
    expect(root.edges.find((e) => e.from === 'svc-web')!.memberEdgeIds).toEqual(['c1', 'c2', 'r1']);
  });

  it('입력 순서가 달라도 같은 결과를 낸다', async () => {
    const a = await computeDrilldown(validated(fixture()));
    const shuffled = fixture();
    shuffled.nodes.reverse();
    shuffled.edges.reverse();
    const b = await computeDrilldown(validated(shuffled));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe('computeDrilldown 게이트웨이 사슬', () => {
  // 화면 → 앞 게이트웨이 → 뒤 게이트웨이 → 엔드포인트 → 모듈, 그리고 모듈 → 클라이언트 → 게이트웨이 → 모듈
  function chainFixture(): ArchitectureIr {
    return {
      ...fixture(),
      nodes: [
        node('svc', 'service'),
        node('feat', 'feature', 'svc'),
        node('scr', 'screen', 'feat'),
        node('gw-front', 'gateway'),
        node('gw-back', 'gateway'),
        node('gw-int', 'gateway'),
        node('ep', 'endpoint'),
        node('m-a', 'app_module'),
        node('m-b', 'app_module'),
        node('cli', 'external_service'),
      ],
      edges: [
        edge('c1', 'scr', 'ep', 'calls'),
        edge('hop', 'gw-front', 'gw-back', 'routes'),
        edge('r-ep', 'gw-back', 'ep', 'routes'),
        edge('h1', 'ep', 'm-a', 'handles'),
        edge('u1', 'm-a', 'cli', 'uses'),
        edge('k1', 'cli', 'gw-int', 'calls'),
        edge('r-mod', 'gw-int', 'm-b', 'routes'),
      ],
    };
  }

  it('root에서 서비스는 맨 앞 게이트웨이로 들어가고 사슬은 단마다 묶인다', async () => {
    const { levels } = await computeDrilldown(validated(chainFixture()));
    expect(summarize(levels[0]!)).toEqual([
      ['gw-back', 'm-a', 1, 'h1,r-ep'],
      ['gw-front', 'gw-back', 1, 'hop'],
      ['gw-int', 'm-b', 1, 'r-mod'],
      ['m-a', 'gw-int', 1, 'k1,u1'],
      ['svc', 'gw-front', 1, 'c1,hop,r-ep'],
    ]);
  });

  it('service와 feature 레벨도 사슬을 그대로 따른다', async () => {
    const { levels } = await computeDrilldown(validated(chainFixture()));
    expect(summarize(inner(level(levels, 'service:svc')))).toEqual([
      ['gw-back', 'm-a', 1, 'h1,r-ep'],
      ['gw-front', 'gw-back', 1, 'hop'],
      ['scr', 'gw-front', 1, 'c1,hop,r-ep'],
      ['feat', 'scr', 1, ''],
      ['svc', 'feat', 1, ''],
    ]);
    expect(level(levels, 'feature:feat').edges.map((e) => e.id)).toEqual([
      'c1',
      'h1',
      'hop',
      'r-ep',
    ]);
  });

  it('root에서 서버를 거쳐서만 닿는 게이트웨이와 모듈은 외부 서비스 레인에 서고 게이트웨이가 왼쪽이다', async () => {
    const { levels } = await computeDrilldown(validated(chainFixture()));
    const root = levels[0]!;
    expect(root.layout.lanes.map((l) => [l.id, l.count])).toEqual([
      ['service', 1],
      ['gateway', 2],
      ['app_module', 1],
      ['external', 2],
    ]);
    const x = (id: string) => root.layout.nodes.find((n) => n.id === id)!.x;
    expect(x('gw-int')).toBeGreaterThan(x('m-a'));
    expect(x('m-b')).toBeGreaterThan(x('gw-int'));
  });

  it('server 레벨은 클라이언트 → 게이트웨이 → 받는 모듈을 오른쪽으로 펼친다', async () => {
    const { levels } = await computeDrilldown(validated(chainFixture()));
    const a = inner(level(levels, 'server:m-a'));
    expect(a.nodeIds).toEqual(['cli', 'ep', 'gw-int', 'm-a', 'm-b']);
    expect(a.edges.map((e) => e.id)).toEqual(['h1', 'k1', 'r-mod', 'u1']);
    const x = (id: string) => a.layout.nodes.find((n) => n.id === id)!.x;
    expect(x('gw-int')).toBeGreaterThan(x('cli'));
    expect(x('m-b')).toBeGreaterThan(x('gw-int'));
    expect(inner(level(levels, 'server:gw-front')).edges.map((e) => e.id)).toEqual(['hop']);
  });
});

describe('computeDrilldown 전체보기의 prod 기준과 저장소', () => {
  function storeFixture(): ArchitectureIr {
    const ir = fixture();
    const store = (id: string, environment: string): ArchitectureNode => ({
      ...node(id, 'datastore'),
      environment,
    });
    return {
      ...ir,
      nodes: [
        ...ir.nodes.map((n) => (n.id === 't-orders' ? { ...n, parent: 'ds-main' } : n)),
        store('ds-main', 'prod'),
        store('ds-cache', 'prod'),
        store('ds-dev', 'dev'),
      ],
      edges: [
        ...ir.edges,
        edge('rw2', 'm-cart', 'ds-cache', 'reads_writes'),
        edge('rw3', 'm-cart', 'ds-dev', 'reads_writes'),
      ],
    };
  }

  it('root에 prod 저장소를 올리고 테이블에 걸린 선은 그 테이블의 클러스터로 묶는다', async () => {
    const { levels } = await computeDrilldown(validated(storeFixture()));
    const root = levels[0]!;
    expect(root.nodeIds).toContain('ds-main');
    expect(root.nodeIds).toContain('ds-cache');
    expect(root.nodeIds).not.toContain('ds-dev');
    expect(root.nodeIds).not.toContain('t-orders');
    expect(summarize(root).filter(([, to]) => String(to).startsWith('ds-'))).toEqual([
      ['m-cart', 'ds-cache', 1, 'rw2'],
      ['m-orders', 'ds-main', 1, 'rw1'],
    ]);
  });

  it('server 레벨은 환경과 상관없이 저장소를 다 그린다', async () => {
    const { levels } = await computeDrilldown(validated(storeFixture()));
    expect(level(levels, 'server:m-cart').nodeIds).toEqual(
      expect.arrayContaining(['ds-cache', 'ds-dev']),
    );
  });

  it('제품 그룹이 둘이면 root에 제품 띠를 싣는다', async () => {
    const ir = fixture();
    ir.groups = [
      { id: 'g1', name: '고객', members: ['svc-web', 'gw', 'm-orders', 'm-cart'] },
      { id: 'g2', name: '운영', members: ['svc-admin', 'm-admin', 'm-orders'] },
    ];
    const root = (await computeDrilldown(validated(ir))).levels[0]!;
    expect(root.layout.regions!.groups.map((g) => g.name)).toEqual(['고객', '운영']);
    expect(root.layout.regions!.bandOf['m-orders']).toBe(0);
    expect(root.layout.regions!.productsOf['m-orders']).toEqual([0, 1]);
    expect(root.layout.regions!.bands[0]!.band).toBe(0);
  });
});

describe('computeDrilldown 설명 줄이 있는 카드', () => {
  const DESC = '이 카드가 무엇인지 설명하는 한 줄이에요. 길어지면 말줄임으로 잘려요.';

  function describeAll(ir: ArchitectureIr): ArchitectureIr {
    return { ...ir, nodes: ir.nodes.map((n) => ({ ...n, description: DESC })) };
  }

  async function levelsOf(ir: ArchitectureIr): Promise<DrillLevel[]> {
    const r = validateArchitectureIr(ir, { checkFiles: false });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return (await computeDrilldown(r.value)).levels;
  }

  function overlaps(levels: DrillLevel[]): string[] {
    const found: string[] = [];
    for (const lv of levels) {
      const nodes = lv.layout.nodes;
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]!;
          const b = nodes[j]!;
          const x = a.x < b.x + b.width && b.x < a.x + a.width;
          const y = a.y < b.y + b.height && b.y < a.y + a.height;
          if (x && y) found.push(`${lv.id}: ${a.id} x ${b.id}`);
        }
      }
    }
    return found;
  }

  it.each([
    ['web', webIr],
    ['harness', harnessIr],
    [
      'merged',
      () => {
        const r = mergeArchitectureIrs([webIr(), partnerIr()], { groupNames: ['상점', '파트너'] });
        if (!r.ok) throw new Error(JSON.stringify(r.errors));
        return r.ir;
      },
    ],
  ])('%s 그림은 모든 카드에 설명이 있어도 어느 레벨에서도 카드가 안 겹친다', async (_n, build) => {
    const levels = await levelsOf(describeAll(build()));
    expect(levels.length).toBeGreaterThan(1);
    expect(overlaps(levels)).toEqual([]);
  });

  it('설명이 있는 카드는 없는 때보다 정확히 19 높다', async () => {
    const plain = await levelsOf(webIr());
    const described = await levelsOf(describeAll(webIr()));
    let compared = 0;
    for (const lv of plain) {
      const other = described.find((d) => d.id === lv.id)!;
      for (const n of lv.layout.nodes) {
        const m = other.layout.nodes.find((x) => x.id === n.id);
        if (m === undefined) continue;
        expect(m.height).toBe(n.height + 19);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(0);
  });
});

describe('drillLevelOwners', () => {
  const withInfraOnlyDeploy = (): ArchitectureIr => {
    const ir = LEGACY_IRS.deploy!();
    ir.nodes = ir.nodes.map((n) =>
      n.id === 'dt-api' ? { ...n, provider: 'aws' as const, region: 'ap-northeast-2' } : n,
    );
    return ir;
  };
  const cases: Array<[string, () => ArchitectureIr]> = [
    ['fixture', fixture],
    ['partner', partnerIr],
    ...Object.entries(LEGACY_IRS),
    ['infra tree', infraIr],
    ['aws', awsIr],
    ['인프라 때문에만 드릴다운', withInfraOnlyDeploy],
  ];

  it.each(cases)(
    '%s: computeDrilldown의 레벨 id와 kind를 infra만 빼고 같은 순서로 낸다',
    async (_, build) => {
      const v = validated(build());
      const owners = drillLevelOwners(v);
      const { levels } = await computeDrilldown(v);
      expect(owners.map((o) => [o.levelId, o.kind])).toEqual(
        levels.filter((l) => l.id !== INFRA_LEVEL_ID).map((l) => [l.id, l.kind]),
      );
    },
  );

  it('픽스처들이 레벨 종류 여섯을 하나씩은 만든다', () => {
    const kinds = new Set(
      cases.flatMap(([, build]) => drillLevelOwners(validated(build())).map((o) => o.kind)),
    );
    expect([...kinds].sort()).toEqual(['app', 'feature', 'group', 'root', 'server', 'service']);
  });

  it('root는 주인이 없고 나머지는 레벨을 여는 노드 id를 주인으로 둔다', () => {
    for (const [, build] of cases) {
      const v = validated(build());
      for (const o of drillLevelOwners(v)) {
        if (o.kind === 'root') {
          expect(o.ownerId).toBeUndefined();
          continue;
        }
        expect(o.levelId).toBe(`${o.kind}:${o.ownerId!}`);
        expect(v.drawableNodeIds.has(o.ownerId!)).toBe(true);
      }
    }
  });
});

describe('computeDrilldown 레벨 요약', () => {
  const summaryOf = (levels: DrillLevel[]) =>
    Object.fromEntries(levels.filter((l) => 'summary' in l).map((l) => [l.id, l.summary]));

  it('root는 IR의 summary, 나머지는 레벨을 여는 노드의 summary를 싣고 공백뿐이면 칸이 없다', async () => {
    const ir = fixture();
    ir.summary = '주문과 장바구니를 다루는 웹';
    const summaries: Record<string, string> = {
      'svc-web': '고객용 웹 서비스',
      'svc-admin': '   ',
      'f-orders': '주문 목록과 상세',
      gw: '모든 API가 지나는 게이트웨이',
      's-list': '레벨을 안 여는 노드',
    };
    ir.nodes = ir.nodes.map((n) =>
      summaries[n.id] !== undefined ? { ...n, summary: summaries[n.id]! } : n,
    );
    const { levels } = await computeDrilldown(validated(ir));
    expect(summaryOf(levels)).toEqual({
      root: '주문과 장바구니를 다루는 웹',
      'service:svc-web': '고객용 웹 서비스',
      'feature:f-orders': '주문 목록과 상세',
      'server:gw': '모든 API가 지나는 게이트웨이',
    });
  });

  it('summary를 안 적으면 어느 레벨에도 칸이 없다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    expect(summaryOf(levels)).toEqual({});
  });

  it('인프라 레벨 때문에만 드릴다운이 된 평면 root도 IR의 summary를 싣고 infra 레벨은 비운다', async () => {
    const ir = LEGACY_IRS.deploy!();
    ir.summary = '배포 사슬';
    ir.nodes = ir.nodes.map((n) =>
      n.id === 'dt-api'
        ? { ...n, provider: 'aws' as const, region: 'ap-northeast-2', summary: '레벨 없음' }
        : n,
    );
    const { levels } = await computeDrilldown(validated(ir));
    expect(levels.map((l) => l.id)).toEqual(['root', 'infra']);
    expect(summaryOf(levels)).toEqual({ root: '배포 사슬' });
  });
});

describe('computeDrilldown 레벨 밖 맥락', () => {
  // svc-shop 화면이 ep-order를 부르고 m-order가 받는다. 레벨 밖에는 다른 서비스 화면, 다른 서버, 테이블이 걸려 있다
  function contextFixture(): ArchitectureIr {
    return {
      ...fixture(),
      nodes: [
        node('svc-shop', 'service'),
        node('svc-help', 'service'),
        node('f-order', 'feature', 'svc-shop'),
        node('s-order', 'screen', 'f-order'),
        node('s-help', 'screen', 'svc-help'),
        node('s-faq', 'screen', 'svc-help'),
        node('ep-order', 'endpoint'),
        node('ep-stock', 'endpoint'),
        node('m-order', 'app_module'),
        node('m-stock', 'app_module'),
        node('m-audit', 'app_module'),
        node('t-order', 'db_table'),
      ],
      edges: [
        edge('c-order', 's-order', 'ep-order', 'calls'),
        edge('c-help', 's-help', 'ep-order', 'calls'),
        edge('h-order', 'ep-order', 'm-order', 'handles'),
        edge('h-audit', 'ep-order', 'm-audit', 'handles'),
        edge('h-stock', 'ep-stock', 'm-stock', 'handles'),
        edge('k-stock', 'm-order', 'ep-stock', 'calls'),
        edge('rw-order', 'm-order', 't-order', 'reads_writes'),
        edge('n-in', 's-help', 's-order', 'navigates'),
        edge('n-out', 's-order', 's-faq', 'navigates'),
      ],
    };
  }

  const laneOf = (l: DrillLevel, id: string): string | undefined =>
    l.layout.lanes.find((lane) => {
      const box = l.layout.nodes.find((n) => n.id === id)!;
      return box.x >= lane.x && box.x + box.width <= lane.x + lane.width;
    })?.id;

  it('service 레벨에 밖에서 들어오는 카드를 왼쪽, 밖으로 나가는 카드를 오른쪽에 세운다', async () => {
    const { levels } = await computeDrilldown(validated(contextFixture()));
    const shop = level(levels, 'service:svc-shop');
    expect(shop.outside).toEqual({
      from: ['s-help'],
      to: ['ep-stock', 's-faq', 't-order'],
      hiddenFrom: 0,
      hiddenTo: 0,
    });
    for (const id of ['s-help', 'ep-stock', 's-faq', 't-order']) expect(shop.nodeIds).toContain(id);
    // 묶음이 이미 품은 c-order와 h-order는 바깥 선으로 다시 긋지 않는다
    expect(
      shop.edges.filter((e) => e.kind !== 'bundle' && e.kind !== 'contains').map((e) => e.id),
    ).toEqual(['k-stock', 'n-in', 'n-out', 'rw-order']);
    expect(laneOf(shop, 's-help')).toBe('outside_from');
    for (const id of shop.outside!.to) expect(laneOf(shop, id)).toBe('outside_to');
    const x = (id: string) => shop.layout.nodes.find((n) => n.id === id)!;
    const inside = inner(shop).nodeIds.map(x);
    const left = Math.min(...inside.map((n) => n.x));
    const right = Math.max(...inside.map((n) => n.x + n.width));
    expect(x('s-help').x + x('s-help').width).toBeLessThanOrEqual(left);
    for (const id of shop.outside!.to) expect(x(id).x).toBeGreaterThanOrEqual(right);
  });

  it('server 레벨에 부르는 화면과 레벨 밖 받는 쪽을 싣고 레벨 주인은 바깥으로 치지 않는다', async () => {
    const { levels } = await computeDrilldown(validated(contextFixture()));
    const order = level(levels, 'server:m-order');
    expect(order.outside).toEqual({
      from: ['s-help', 's-order'],
      to: ['ep-stock', 'm-audit'],
      hiddenFrom: 0,
      hiddenTo: 0,
    });
    expect(order.edges.map((e) => e.id)).toEqual([
      'c-help',
      'c-order',
      'h-audit',
      'h-order',
      'k-stock',
      'rw-order',
    ]);
    for (const id of order.outside!.from) expect(laneOf(order, id)).toBe('outside_from');
    for (const id of order.outside!.to) expect(laneOf(order, id)).toBe('outside_to');
    // 바깥 카드도 들어갈 레벨이 있으면 그대로 들어간다
    const { enter } = await computeDrilldown(validated(contextFixture()));
    expect(enter['m-audit']).toBe('server:m-audit');
    // 레벨 밖 카드가 없는 레벨에는 칸을 안 붙인다
    const audit = level(levels, 'server:m-stock');
    expect(audit.outside).toEqual({ from: ['m-order'], to: [], hiddenFrom: 0, hiddenTo: 0 });
    const help = level(levels, 'service:svc-help');
    expect(help.outside?.from ?? []).not.toContain('svc-help');
  });

  it('레벨 밖 카드가 없으면 outside 칸이 없다', async () => {
    const ir = contextFixture();
    ir.nodes = ir.nodes.filter((n) => ['svc-shop', 'f-order', 's-order'].includes(n.id));
    ir.edges = [];
    const { levels } = await computeDrilldown(validated(ir));
    expect('outside' in level(levels, 'service:svc-shop')).toBe(false);
  });

  it('같은 카드가 부르기도 하고 불리기도 하면 호출하는 쪽에만 세운다', async () => {
    const ir = contextFixture();
    ir.edges.push(edge('k-back', 'm-order', 'ep-order', 'calls'));
    ir.edges = ir.edges.filter((e) => e.id !== 'h-audit');
    ir.edges.push(edge('k-audit-in', 'm-audit', 'ep-order', 'calls'));
    ir.edges.push(edge('k-audit-out', 'm-order', 'm-audit', 'calls'));
    const { levels } = await computeDrilldown(validated(ir));
    const order = level(levels, 'server:m-order');
    expect(order.outside!.from).toContain('m-audit');
    expect(order.outside!.to).not.toContain('m-audit');
    expect(order.edges.map((e) => e.id)).toEqual(
      expect.arrayContaining(['k-audit-in', 'k-audit-out']),
    );
  });

  it('구간이 있는 IR에서도 바깥 카드는 구간 레인이 아니라 바깥 레인에 선다', async () => {
    const ir: ArchitectureIr = {
      ...contextFixture(),
      stages: [
        { id: 'front', label: '화면', kinds: ['service', 'feature', 'screen'] },
        { id: 'back', label: '서버', kinds: ['endpoint', 'app_module', 'db_table'] },
      ],
    };
    const { levels } = await computeDrilldown(validated(ir));
    for (const id of ['service:svc-shop', 'server:m-order']) {
      const l = level(levels, id);
      const lanes = l.layout.lanes.map((lane) => lane.id);
      expect(lanes[0]).toBe('outside_from');
      expect(lanes[lanes.length - 1]).toBe('outside_to');
      expect(lanes.filter((lane) => lane.startsWith('stage:')).length).toBeGreaterThan(0);
      for (const o of [...l.outside!.from, ...l.outside!.to])
        expect(laneOf(l, o)).toMatch(/^outside_(from|to)$/);
    }
  });

  it('한쪽 바깥 카드는 OUTSIDE_CONTEXT_MAX장까지 연결 수와 id 순으로 세우고 넘친 수를 싣는다', async () => {
    const ir = contextFixture();
    const callers = Array.from({ length: 11 }, (_, i) => `s-x${String(i).padStart(2, '0')}`);
    ir.nodes.push(...callers.map((id) => node(id, 'screen', 'svc-help')));
    ir.edges.push(...callers.map((id) => edge(`c-${id}`, id, 'ep-order', 'calls')));
    // 연결이 둘인 카드가 id 순을 앞질러 맨 앞에 선다
    ir.edges.push(edge('c-s-x10-again', 's-x10', 'ep-order', 'calls'));
    const { levels } = await computeDrilldown(validated(ir));
    const order = level(levels, 'server:m-order');
    expect(order.outside!.from).toEqual([
      's-x10',
      's-help',
      's-order',
      's-x00',
      's-x01',
      's-x02',
      's-x03',
      's-x04',
    ]);
    expect(order.outside!.hiddenFrom).toBe(13 - 8);
    expect(order.nodeIds).not.toContain('s-x05');
    expect(order.edges.some((e) => e.from === 's-x05')).toBe(false);
    // 한 열에 4장씩이라 8장이 두 열로 선다
    const xs = new Set(
      order.outside!.from.map((id) => order.layout.nodes.find((n) => n.id === id)!.x),
    );
    expect(xs.size).toBe(2);
  });
});
