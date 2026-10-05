import { describe, expect, it } from 'vitest';
import {
  mergeArchitectureIrs,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type Evidence,
} from '../../../src/architecture/index.js';

// 가짜 제품 둘. shop은 고객 웹, admin은 운영 웹이고 둘 다 같은 게이트웨이와 API 서버를 거친다.
// 두 분석은 같은 레포를 서로 다른 별칭과 다른 remote 표기로 적었다.

function code(location: string): Evidence {
  return { type: 'code', location, visibility: 'public' };
}

function node(
  id: string,
  kind: ArchitectureNode['kind'],
  label: string,
  repo: string,
  overrides: Partial<ArchitectureNode> = {},
): ArchitectureNode {
  return { id, kind, label, repo, evidence: [code(`${repo}:src/x.ts:1`)], ...overrides };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: ArchitectureEdge['kind'],
  evidence: Evidence[],
): ArchitectureEdge {
  return { id, from, to, kind, evidence, lineStyle: evidence.length > 0 ? 'solid' : 'dashed' };
}

function makeIr(overrides: Partial<ArchitectureIr>): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [],
    nodes: [],
    edges: [],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function shopIr(): ArchitectureIr {
  return makeIr({
    repos: [
      {
        id: 'web',
        name: 'acme-shop-web',
        root: '/c/acme-shop-web',
        remote: 'git@github.com:acme/acme-shop-web.git',
      },
      {
        id: 'gw',
        name: 'acme-gateway',
        root: '/c/acme-gateway',
        remote: 'git@github.com:acme/acme-gateway.git',
      },
      {
        id: 'api',
        name: 'acme-api',
        root: '/c/acme-api',
        remote: 'git@github.com:acme/acme-api.git',
      },
    ],
    nodes: [
      node('svc:main', 'service', 'acme-shop', 'web', { displayName: '고객 웹' }),
      node('scr:orders', 'screen', '/orders', 'web', { parent: 'svc:main' }),
      node('gw:edge', 'gateway', 'acme-gateway', 'gw', { displayName: '공용 게이트웨이' }),
      node('ep:orders', 'endpoint', 'GET /v1/orders', 'api'),
      node('mod:api', 'app_module', 'acme-api', 'api', { displayName: '주문 API' }),
    ],
    edges: [
      edge('e1', 'scr:orders', 'ep:orders', 'calls', [code('web:src/orders.ts:3')]),
      edge('e2', 'gw:edge', 'ep:orders', 'routes', [code('gw:routes.yml:4')]),
      edge('e3', 'ep:orders', 'mod:api', 'handles', [code('api:src/OrderController.kt:10')]),
    ],
    sourcesUsed: [
      {
        via: 'repo',
        identifier: 'CLAUDE.md',
        readOnly: true,
        probeHit: true,
        visibility: 'public',
      },
      {
        via: 'mcp',
        identifier: 'kb_search',
        readOnly: true,
        probeHit: false,
        visibility: 'public',
      },
    ],
  });
}

function adminIr(): ArchitectureIr {
  return makeIr({
    generatedAt: '2026-10-02T00:00:00.000Z',
    repos: [
      {
        id: 'admin',
        name: 'acme-admin-web',
        root: '/c/acme-admin-web',
        remote: 'https://github.com/acme/acme-admin-web',
      },
      {
        id: 'gateway',
        name: 'acme-gateway',
        root: '/c/gw2',
        remote: 'https://github.com/acme/acme-gateway.git',
      },
      {
        id: 'server',
        name: 'acme-api',
        root: '/c/api2',
        remote: 'ssh://git@github.com/acme/acme-api.git',
      },
    ],
    nodes: [
      // 고객 웹과 id가 부딪힌다. 다른 서비스라 결정적으로 다시 매겨져야 한다
      node('svc:main', 'service', 'acme-admin', 'admin', { displayName: '운영 웹' }),
      node('scr:refunds', 'screen', '/refunds', 'admin', { parent: 'svc:main' }),
      node('gw:shared', 'gateway', 'Acme-Gateway', 'gateway', { displayName: '공용 게이트웨이' }),
      node('ep:refund', 'endpoint', 'POST /v1/refunds', 'server'),
      node('mod:server', 'app_module', 'acme-api', 'server', { displayName: '주문 API' }),
    ],
    edges: [
      edge('e1', 'scr:refunds', 'ep:refund', 'calls', [code('admin:src/refunds.ts:7')]),
      edge('e2', 'gw:shared', 'ep:refund', 'routes', [code('gateway:routes.yml:9')]),
      edge('e3', 'ep:refund', 'mod:server', 'handles', [code('server:src/RefundController.kt:5')]),
    ],
    sourcesUsed: [
      {
        via: 'mcp',
        identifier: 'kb_search',
        readOnly: true,
        probeHit: true,
        visibility: 'private',
      },
    ],
  });
}

function merged(irs: ArchitectureIr[], prefixCandidates?: string[]) {
  const result = mergeArchitectureIrs(irs, { prefixCandidates });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result;
}

const byLabel = (ir: ArchitectureIr, kind: string, label: string) =>
  ir.nodes.filter((n) => n.kind === kind && n.label.toLowerCase() === label.toLowerCase());

describe('mergeArchitectureIrs — 겹치는 게이트웨이와 서버', () => {
  it('remote가 같은 레포는 별칭이 달라도 하나로 묶는다', () => {
    const { ir } = merged([shopIr(), adminIr()]);
    expect(ir.repos.map((r) => r.name).sort()).toEqual([
      'acme-admin-web',
      'acme-api',
      'acme-gateway',
      'acme-shop-web',
    ]);
  });

  it('같은 게이트웨이와 서버는 노드 하나로 합치고 근거는 합집합으로 남긴다', () => {
    const { ir, report } = merged([shopIr(), adminIr()]);
    const gateways = byLabel(ir, 'gateway', 'acme-gateway');
    const modules = byLabel(ir, 'app_module', 'acme-api');
    expect(gateways).toHaveLength(1);
    expect(modules).toHaveLength(1);
    expect(gateways[0]!.displayName).toBe('공용 게이트웨이');

    const gwRepo = gateways[0]!.repo;
    expect(gateways[0]!.evidence.map((e) => e.location).sort()).toEqual([`${gwRepo}:src/x.ts:1`]);
    const routes = ir.edges.filter((e) => e.kind === 'routes');
    expect(routes.every((e) => e.from === gateways[0]!.id)).toBe(true);
    // code 근거 위치의 레포 별칭도 합친 레포 id로 바뀐다
    expect(routes.flatMap((e) => e.evidence.map((ev) => ev.location)).sort()).toEqual([
      `${gwRepo}:routes.yml:4`,
      `${gwRepo}:routes.yml:9`,
    ]);

    expect(report.islands).toBe(1);
    expect(report.sharedNodes.map((n) => n.kind).sort()).toEqual(['app_module', 'gateway']);
    expect(report.sharedNodes.every((n) => n.inputs.join() === '0,1')).toBe(true);
  });

  it('id가 부딪힌 서로 다른 노드는 다시 매기고 parent도 따라간다', () => {
    const { ir } = merged([shopIr(), adminIr()]);
    const services = ir.nodes.filter((n) => n.kind === 'service');
    expect(services.map((s) => s.id).sort()).toEqual(['svc:main', 'svc:main-2']);
    const refunds = byLabel(ir, 'screen', '/refunds')[0]!;
    const admin = services.find((s) => s.label === 'acme-admin')!;
    const shop = services.find((s) => s.label === 'acme-shop')!;
    expect(refunds.parent).toBe(admin.id);
    expect(byLabel(ir, 'screen', '/orders')[0]!.parent).toBe(shop.id);
  });

  it('합친 결과가 검증을 통과하고 끊긴 엣지가 없다', () => {
    const { ir } = merged([shopIr(), adminIr()]);
    const result = validateArchitectureIr(ir, { checkFiles: false });
    expect(result.ok).toBe(true);
  });

  it('맥락 소스는 한쪽이라도 private이면 private로 남긴다', () => {
    const { ir } = merged([shopIr(), adminIr()]);
    const kb = ir.sourcesUsed.filter((s) => s.identifier === 'kb_search');
    expect(kb).toEqual([
      {
        via: 'mcp',
        identifier: 'kb_search',
        readOnly: true,
        probeHit: true,
        visibility: 'private',
      },
    ]);
    expect(ir.generatedAt).toBe('2026-10-02T00:00:00.000Z');
  });
});

describe('mergeArchitectureIrs — 레포를 넘는 연결', () => {
  // FE 분석은 BE 레포를 못 열어 핸들러 없는 엔드포인트만 남겼다. BE 분석은 라우트와 모듈을 찾았다
  function feOnly(): ArchitectureIr {
    return makeIr({
      repos: [
        {
          id: 'web',
          name: 'acme-shop-web',
          root: '/c/web',
          remote: 'git@github.com:acme/acme-shop-web.git',
        },
      ],
      nodes: [
        node('scr:order', 'screen', '/orders/:id', 'web'),
        node('ep:fe-order', 'endpoint', 'GET /api/v1/orders/{}', 'web', {
          evidence: [code('web:src/api/orders.ts:12')],
        }),
      ],
      edges: [edge('c1', 'scr:order', 'ep:fe-order', 'calls', [code('web:src/pages/order.tsx:4')])],
    });
  }
  function beOnly(): ArchitectureIr {
    return makeIr({
      repos: [
        { id: 'api', name: 'acme-api', root: '/c/api', remote: 'git@github.com:acme/acme-api.git' },
      ],
      nodes: [
        node('ep:order', 'endpoint', 'GET /v1/orders/{orderId}', 'api'),
        node('mod:api', 'app_module', 'acme-api', 'api'),
      ],
      edges: [
        edge('h1', 'ep:order', 'mod:api', 'handles', [code('api:src/OrderController.kt:22')]),
      ],
    });
  }

  it('FE 엔드포인트를 다른 분석의 핸들러에 method와 정규화한 경로로 잇는다', () => {
    const { ir, report } = merged([feOnly(), beOnly()], ['/api']);
    expect(report.crossRepoEdges).toHaveLength(1);
    const cross = ir.edges.find((e) => e.id === report.crossRepoEdges[0])!;
    expect(cross).toMatchObject({
      from: 'ep:fe-order',
      to: 'mod:api',
      kind: 'handles',
      lineStyle: 'solid',
    });
    // FE 경로 줄과 BE 라우트 줄을 둘 다 근거로 단다
    expect(cross.evidence.map((e) => e.location).sort()).toEqual([
      'api:src/OrderController.kt:22',
      'web:src/api/orders.ts:12',
    ]);
    expect(report.islands).toBe(1);
  });

  it('prefix 후보가 없어 경로가 안 맞으면 잇지 않는다', () => {
    const { report } = merged([feOnly(), beOnly()]);
    expect(report.crossRepoEdges).toEqual([]);
    expect(report.islands).toBe(2);
  });

  it('후보 핸들러가 여럿이면 긋지 않고 미해결 질문으로 남긴다', () => {
    const be2 = makeIr({
      repos: [
        {
          id: 'legacy',
          name: 'acme-legacy',
          root: '/c/legacy',
          remote: 'git@github.com:acme/acme-legacy.git',
        },
      ],
      nodes: [
        node('ep:legacy-order', 'endpoint', 'GET /v1/orders/{id}', 'legacy'),
        node('mod:legacy', 'app_module', 'acme-legacy', 'legacy'),
      ],
      edges: [edge('h1', 'ep:legacy-order', 'mod:legacy', 'handles', [code('legacy:src/a.kt:1')])],
    });
    const { ir, report } = merged([feOnly(), beOnly(), be2], ['/api']);
    expect(report.crossRepoEdges).toEqual([]);
    const q = ir.unresolved.find((u) => u.subject.nodeId === 'ep:fe-order')!;
    expect(q.question).toContain('여럿');
    expect(report.conflictQuestions).toContain(q.id);
  });
});

describe('mergeArchitectureIrs — 겹치는 것이 없는 두 분석', () => {
  function lone(name: string): ArchitectureIr {
    return makeIr({
      repos: [{ id: 'r', name, root: `/c/${name}`, remote: `git@github.com:acme/${name}.git` }],
      nodes: [
        node('svc', 'service', name, 'r'),
        node('feat', 'feature', `${name}-home`, 'r', { parent: 'svc' }),
        node('scr', 'screen', '/', 'r', { parent: 'feat' }),
        node('ep', 'endpoint', `GET /${name}`, 'r'),
        node('mod', 'app_module', `${name}-api`, 'r'),
      ],
      edges: [
        edge('a', 'scr', 'ep', 'calls', [code('r:src/a.ts:1')]),
        edge('b', 'ep', 'mod', 'handles', [code('r:src/b.ts:1')]),
      ],
      unresolved: [
        { id: 'q1', subject: { nodeId: 'mod' }, question: '이 모듈은 어디에 배포되나요?' },
      ],
    });
  }

  it('섬 두 개로 나란히 두고 레포 별칭과 id를 겹치지 않게 다시 매긴다', () => {
    const { ir, report } = merged([lone('acme-blog'), lone('acme-docs')]);
    expect(report.islands).toBe(2);
    expect(report.sharedNodes).toEqual([]);
    expect(ir.nodes).toHaveLength(10);
    expect(new Set(ir.nodes.map((n) => n.id)).size).toBe(10);
    expect(ir.repos.map((r) => r.id).sort()).toEqual(['r', 'r-2']);
    // 다시 매긴 레포 별칭이 근거 위치에도 반영돼야 다른 레포 파일을 가리키지 않는다
    const r2Edges = ir.edges.filter((e) => e.evidence.some((ev) => ev.location.startsWith('r-2:')));
    expect(r2Edges).toHaveLength(2);
    expect(ir.unresolved.map((q) => q.id).sort()).toEqual(['q1', 'q1-2']);
    expect(new Set(ir.unresolved.map((q) => q.subject.nodeId)).size).toBe(2);
    expect(validateArchitectureIr(ir, { checkFiles: false }).ok).toBe(true);
  });
});

describe('mergeArchitectureIrs — 충돌', () => {
  function withGateway(
    displayName: string,
    extra: Partial<ArchitectureNode> = {},
    parentLabel = 'acme-a',
  ) {
    return makeIr({
      repos: [
        {
          id: 'g',
          name: 'acme-gateway',
          root: '/c/g',
          remote: 'git@github.com:acme/acme-gateway.git',
        },
      ],
      nodes: [
        node('svc', 'service', parentLabel, 'g'),
        node('feat:settings', 'feature', 'settings', 'g', { parent: 'svc' }),
        node('gw', 'gateway', 'acme-gateway', 'g', { displayName, ...extra }),
      ],
    });
  }

  it('표시 이름이 갈리면 어느 쪽도 고르지 않고 질문으로 돌린다', () => {
    const { ir, report } = merged([withGateway('공용 게이트웨이'), withGateway('외부 게이트웨이')]);
    const gw = byLabel(ir, 'gateway', 'acme-gateway')[0]!;
    expect(gw.displayName).toBeUndefined();
    const q = ir.unresolved.find((u) => u.id === `merge:displayName:${gw.id}`)!;
    expect(q.question).toContain('"공용 게이트웨이"');
    expect(q.question).toContain('"외부 게이트웨이"');
    expect(report.conflictQuestions).toContain(q.id);
  });

  it('user 근거가 있는 쪽 표시 이름은 그대로 둔다', () => {
    const userSide = withGateway('외부 게이트웨이', {
      evidence: [code('g:src/x.ts:1'), { type: 'user', location: 'q7', visibility: 'private' }],
    });
    const { ir, report } = merged([withGateway('공용 게이트웨이'), userSide]);
    expect(byLabel(ir, 'gateway', 'acme-gateway')[0]!.displayName).toBe('외부 게이트웨이');
    expect(report.conflictQuestions).toEqual([]);
  });

  it('parent가 갈리면 parent를 비우고 이름을 담아 묻는다', () => {
    const { ir } = merged([
      withGateway('공용 게이트웨이', {}, 'acme-a'),
      withGateway('공용 게이트웨이', {}, 'acme-b'),
    ]);
    const feature = byLabel(ir, 'feature', 'settings')[0]!;
    expect(feature.parent).toBeUndefined();
    const q = ir.unresolved.find((u) => u.id === `merge:parent:${feature.id}`)!;
    expect(q.question).toContain('"acme-a"');
    expect(q.question).toContain('"acme-b"');
    expect(validateArchitectureIr(ir, { checkFiles: false }).ok).toBe(true);
  });
});

describe('mergeArchitectureIrs — 결정성과 입력 검사', () => {
  it('넘긴 순서나 키 순서가 달라도 같은 바이트가 나온다', () => {
    const a = JSON.stringify(merged([shopIr(), adminIr()]).ir);
    const b = JSON.stringify(merged([adminIr(), shopIr()]).ir);
    const shuffled = JSON.parse(JSON.stringify(adminIr()), (_k, v: unknown) =>
      v !== null && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).reverse())
        : v,
    ) as ArchitectureIr;
    const c = JSON.stringify(merged([shuffled, shopIr()]).ir);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('입력을 바꾸지 않는다', () => {
    const shop = shopIr();
    const before = JSON.stringify(shop);
    merged([shop, adminIr()]);
    expect(JSON.stringify(shop)).toBe(before);
  });

  it('뷰가 다르거나 하나뿐이면 거부한다', () => {
    const deploy = makeIr({ view: 'deploy-path' });
    const mismatch = mergeArchitectureIrs([shopIr(), deploy]);
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) expect(mismatch.errors[0]!.code).toBe('MERGE_VIEW_MISMATCH');
    const single = mergeArchitectureIrs([shopIr()]);
    expect(single.ok).toBe(false);
    if (!single.ok) expect(single.errors[0]!.code).toBe('MERGE_TOO_FEW');
  });

  it('private 근거에 원문이 든 입력은 받지 않는다', () => {
    const leaky = shopIr();
    leaky.nodes[0]!.evidence.push({
      type: 'doc',
      location: 'kb:page-1',
      visibility: 'private',
      excerpt: '비공개 메모',
    });
    const result = mergeArchitectureIrs([leaky, adminIr()]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({ code: 'PRIVATE_EXCERPT_PRESENT', input: 0 });
    }
  });
});

describe('mergeArchitectureIrs — 제품 그룹', () => {
  function withStore(ir: ArchitectureIr, serverId: string): ArchitectureIr {
    return {
      ...ir,
      nodes: [
        ...ir.nodes,
        // 두 분석이 id는 달리 지었어도 저장소 kind, aws 레포, label이 같으면 한 노드다
        node(`ds:${serverId}-main`, 'datastore', 'aurora-mysql:acme-prod-main', 'aws', {
          environment: 'prod',
        }),
      ],
      edges: [
        ...ir.edges,
        edge('rw', serverId, `ds:${serverId}-main`, 'reads_writes', [code('api:src/db.yml:2')]),
      ],
    };
  }

  it('입력마다 그룹을 하나 남기고 두 분석에 다 있던 노드는 양쪽 그룹에 든다', () => {
    const { ir } = merged([shopIr(), adminIr()]);
    expect(ir.groups).toHaveLength(2);
    const [a, b] = ir.groups!;
    const both = a!.members.filter((m) => b!.members.includes(m));
    const gw = byLabel(ir, 'gateway', 'acme-gateway')[0]!;
    const api = byLabel(ir, 'app_module', 'acme-api')[0]!;
    expect(both.sort()).toEqual([gw.id, api.id].sort());
    expect(new Set([...a!.members, ...b!.members]).size).toBe(ir.nodes.length);
  });

  it('이름을 안 주면 서비스 표시 이름으로, 주면 넘긴 순서대로 짓는다', () => {
    expect(
      merged([shopIr(), adminIr()])
        .ir.groups!.map((g) => g.name)
        .sort(),
    ).toEqual(['고객 웹', '운영 웹']);
    const named = mergeArchitectureIrs([shopIr(), adminIr()], { groupNames: ['쇼핑', '운영'] });
    if (!named.ok) throw new Error('merge failed');
    const nameOf = (label: string) =>
      named.ir.groups!.find((g) => g.members.includes(byLabel(named.ir, 'service', label)[0]!.id))!
        .name;
    expect(nameOf('acme-shop')).toBe('쇼핑');
    expect(nameOf('acme-admin')).toBe('운영');
  });

  it('같은 저장소 클러스터는 id가 달라도 하나로 합쳐 공용이 된다', () => {
    const { ir } = merged([withStore(shopIr(), 'mod:api'), withStore(adminIr(), 'mod:server')]);
    const stores = ir.nodes.filter((n) => n.kind === 'datastore');
    expect(stores).toHaveLength(1);
    expect(ir.groups!.every((g) => g.members.includes(stores[0]!.id))).toBe(true);
    expect(validateArchitectureIr(ir, { checkFiles: false }).ok).toBe(true);
  });

  it('이미 합친 IR을 다시 합치면 그 안의 그룹을 물려받는다', () => {
    const first = merged([shopIr(), adminIr()]).ir;
    const third = makeIr({
      repos: [
        {
          id: 'ops',
          name: 'acme-ops-web',
          root: '/c/ops',
          remote: 'git@github.com:acme/acme-ops-web.git',
        },
      ],
      nodes: [node('svc:ops', 'service', 'acme-ops', 'ops', { displayName: '정산 웹' })],
    });
    const { ir } = merged([first, third]);
    expect(ir.groups!.map((g) => g.name).sort()).toEqual(['고객 웹', '운영 웹', '정산 웹']);
    expect(new Set(ir.groups!.map((g) => g.id)).size).toBe(3);
  });
});
