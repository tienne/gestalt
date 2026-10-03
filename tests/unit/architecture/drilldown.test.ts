import { describe, expect, it } from 'vitest';
import {
  computeDrilldown,
  shouldDrillDown,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type DrillLevel,
  type Evidence,
  type ValidatedIr,
} from '../../../src/architecture/index.js';

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
    // 문서 근거뿐인 고리가 끼면 묶음도 점선이다
    expect(root.edges.find((e) => e.from === 'm-cart')!.lineStyle).toBe('dashed');
    expect(root.edges.find((e) => e.from === 'svc-web')!.lineStyle).toBe('solid');
    expect(root.layout.nodes.map((n) => n.id)).toEqual(root.nodeIds);
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

  it('service 레벨은 feature 단위로 묶고 화면 이동도 feature 사이 묶음으로 만든다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const web = level(levels, 'service:svc-web');
    expect(web.trail).toEqual(['root', 'service:svc-web']);
    expect(web.nodeIds).toEqual(['f-cart', 'f-orders', 'gw', 'm-cart', 'm-orders']);
    expect(summarize(web)).toEqual([
      ['f-cart', 'f-orders', 1, 'n1'],
      ['f-cart', 'gw', 1, 'c3,r2'],
      ['f-orders', 'gw', 2, 'c1,c2,r1'],
      ['gw', 'm-cart', 1, 'h2,r2'],
      ['gw', 'm-orders', 1, 'h1,r1'],
    ]);
    // feature 없이 서비스에 바로 달린 화면은 그 화면이 칸이 된다
    const admin = level(levels, 'service:svc-admin');
    expect(summarize(admin)).toEqual([['s-admin', 'm-admin', 1, 'c4,h3']]);
  });

  it('server 레벨은 모듈의 엔드포인트, 테이블, 클라이언트와 그 클라이언트가 부르는 모듈을 그린다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const orders = level(levels, 'server:m-orders');
    expect(orders.nodeIds).toEqual(['ep-orders', 'm-orders', 't-orders']);
    expect(orders.edges.map((e) => e.id)).toEqual(['h1', 'rw1']);
    const cart = level(levels, 'server:m-cart');
    expect(cart.nodeIds).toEqual(['ep-cart', 'm-cart', 'm-orders', 'x-pay']);
    expect(cart.edges.map((e) => [e.id, e.kind, e.count])).toEqual([
      ['h2', 'handles', 1],
      ['k1', 'calls', 1],
      ['u1', 'uses', 1],
    ]);
    // 받는 모듈은 클라이언트보다 오른쪽에 선다
    const x = (id: string) => cart.layout.nodes.find((n) => n.id === id)!.x;
    expect(x('m-orders')).toBeGreaterThan(x('x-pay'));
    expect(level(levels, 'server:gw').edges.map((e) => e.id)).toEqual(['r1', 'r2']);
  });

  it('레벨마다 레인 구성이 다르다. 서비스는 기능 영역 칸, 서버는 테이블을 맨 오른쪽에 둔다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const lanes = (id: string) => level(levels, id).layout.lanes.map((l) => l.id);
    // m-orders는 클라이언트로도 닿지만 게이트웨이에서도 닿아 서버 레인에 남는다
    expect(lanes('root')).toEqual(['service', 'gateway', 'app_module']);
    expect(lanes('service:svc-web')).toEqual(['unit', 'gateway', 'app_module']);
    expect(lanes('feature:f-orders')).toEqual(['screen', 'gateway', 'endpoint', 'app_module']);
    expect(lanes('server:m-orders')).toEqual(['endpoint', 'app_module', 'db_table']);
    expect(lanes('server:m-cart')).toEqual([
      'endpoint',
      'app_module',
      'external_service',
      'external',
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
    expect(summarize(level(levels, 'service:svc'))).toEqual([
      ['feat', 'gw-front', 1, 'c1,hop,r-ep'],
      ['gw-back', 'm-a', 1, 'h1,r-ep'],
      ['gw-front', 'gw-back', 1, 'hop'],
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
    const a = level(levels, 'server:m-a');
    expect(a.nodeIds).toEqual(['cli', 'ep', 'gw-int', 'm-a', 'm-b']);
    expect(a.edges.map((e) => e.id)).toEqual(['h1', 'k1', 'r-mod', 'u1']);
    const x = (id: string) => a.layout.nodes.find((n) => n.id === id)!.x;
    expect(x('gw-int')).toBeGreaterThan(x('cli'));
    expect(x('m-b')).toBeGreaterThan(x('gw-int'));
    expect(level(levels, 'server:gw-front').edges.map((e) => e.id)).toEqual(['hop']);
  });
});
