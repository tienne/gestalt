import { describe, expect, it } from 'vitest';
import {
  computeGraphLayout,
  computeLayout,
  measureNode,
  NODE_DESC_LINE,
  stackBands,
  BAND_HEAD,
  type LayoutResult,
} from '../../../src/architecture/layout.js';
import { computeCompareLayout } from '../../../src/architecture/compare-layout.js';
import { computeDataflowLayout } from '../../../src/architecture/dataflow-layout.js';
import { computeSequenceLayout } from '../../../src/architecture/sequence-layout.js';
import { checkoutSequenceIr } from '../../fixtures/architecture-categories/sequence.js';
import {
  orderDataflowIr,
  paymentCompareIr,
} from '../../fixtures/architecture-categories/projection-shapes.js';
import {
  ARCHITECTURE_IR_SCHEMA_VERSION,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type NodeKind,
} from '../../../src/architecture/types.js';

function node(id: string, kind: NodeKind, label = id): ArchitectureNode {
  return { id, kind, label, repo: 'acme-web', evidence: [] };
}

function edge(id: string, from: string, to: string): ArchitectureEdge {
  return { id, from, to, kind: 'calls', evidence: [], lineStyle: 'solid' };
}

function screenChainIr(): ArchitectureIr {
  return {
    schemaVersion: ARCHITECTURE_IR_SCHEMA_VERSION,
    view: 'screen-chain',
    repos: [{ id: 'acme-web', name: 'acme-web', root: '.' }],
    nodes: [
      node('screen-home', 'screen', '홈 화면'),
      node('screen-cart', 'screen', 'Cart'),
      node('ep-get-items', 'endpoint', 'GET /items'),
      node('ep-post-order', 'endpoint', 'POST /orders'),
      node('mod-order', 'app_module', 'OrderService'),
      node('ext-pay', 'external_service', 'Acme Pay'),
      node('tbl-orders', 'db_table', 'orders'),
    ],
    edges: [
      edge('e1', 'screen-home', 'ep-get-items'),
      edge('e2', 'screen-cart', 'ep-post-order'),
      edge('e3', 'ep-post-order', 'mod-order'),
      edge('e4', 'mod-order', 'ext-pay'),
      edge('e5', 'mod-order', 'tbl-orders'),
    ],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function allIds(ir: ArchitectureIr) {
  return {
    nodes: new Set(ir.nodes.map((n) => n.id)),
    edges: new Set(ir.edges.map((e) => e.id)),
  };
}

describe('measureNode', () => {
  it('같은 라벨이면 같은 크기를 낸다', () => {
    expect(measureNode('OrderService')).toEqual(measureNode('OrderService'));
  });

  it('전각 문자는 라틴 문자보다 넓게 잡고 최소, 최대 폭을 지킨다', () => {
    expect(measureNode('가나다라마바사아자차').width).toBeGreaterThan(
      measureNode('abcdefghij').width,
    );
    expect(measureNode('').width).toBe(120);
    expect(measureNode('x'.repeat(500)).width).toBe(320);
  });

  it('종류 칩 폭을 첫 줄에 더한다', () => {
    expect(measureNode('GET /orders', undefined, undefined, 'db_table').width).toBeGreaterThan(
      measureNode('GET /orders').width,
    );
    expect(measureNode('GET /orders', undefined, undefined, 'feature').width).toBeGreaterThan(
      measureNode('GET /orders', undefined, undefined, 'db_table').width,
    );
  });

  it('표시 이름이 있으면 고정 높이 두 줄 박스로 재고 폭은 긴 줄을 따른다', () => {
    const one = measureNode('GET /orders');
    const two = measureNode('GET /orders', '주문 목록을 한 번에 불러오는 조회');
    expect(one.height).toBe(48);
    expect(two.height).toBe(60);
    expect(measureNode('GET /orders', '짧음').height).toBe(60);
    expect(two.width).toBeGreaterThan(one.width);
    // 추정 배지 폭도 첫 줄에 더한다
    expect(measureNode('a', '가나다라마바사아자', true).width).toBeGreaterThan(
      measureNode('a', '가나다라마바사아자').width,
    );
  });

  it('플랫폼 칩은 둘째 줄에 재서 첫 줄 이름 폭을 줄이지 않는다', () => {
    const platforms = ['web', 'android', 'ios'] as const;
    // 칩만 있어도 두 줄 박스가 된다
    expect(measureNode('svc', undefined, undefined, 'service', { platforms }).height).toBe(60);
    // 둘째 줄이 짧으면 칩이 붙어도 폭은 첫 줄을 따른다
    const name = '가나다라마바사아자차카타';
    expect(
      measureNode('svc', name, false, 'service', { platforms, secondLine: 'a.io' }).width,
    ).toBe(measureNode('svc', name, false, 'service', { secondLine: 'a.io' }).width);
  });
});

describe('computeLayout', () => {
  it('같은 IR을 두 번 계산하면 결과가 같다', async () => {
    const ir = screenChainIr();
    const { nodes, edges } = allIds(ir);
    const a = await computeLayout(ir, nodes, edges);
    const b = await computeLayout(ir, nodes, edges);
    expect(a).toEqual(b);
  });

  it('노드와 엣지 순서를 섞어도 결과가 같다', async () => {
    const ir = screenChainIr();
    const shuffled: ArchitectureIr = {
      ...ir,
      nodes: [...ir.nodes].reverse(),
      edges: [ir.edges[3]!, ir.edges[0]!, ir.edges[4]!, ir.edges[2]!, ir.edges[1]!],
    };
    const { nodes, edges } = allIds(ir);
    expect(await computeLayout(shuffled, nodes, edges)).toEqual(
      await computeLayout(ir, nodes, edges),
    );
  });

  it('kind 순위가 낮은 노드가 왼쪽에 놓인다', async () => {
    const ir = screenChainIr();
    const { nodes, edges } = allIds(ir);
    const result = await computeLayout(ir, nodes, edges);
    const x = (id: string) => result.nodes.find((n) => n.id === id)!.x;
    expect(x('screen-home')).toBeLessThan(x('ep-get-items'));
    expect(x('screen-cart')).toBeLessThan(x('ep-post-order'));
    expect(x('ep-post-order')).toBeLessThan(x('mod-order'));
    expect(x('mod-order')).toBeLessThan(x('ext-pay'));
    expect(x('mod-order')).toBeLessThan(x('tbl-orders'));
  });

  it('간선 없이 떨어진 노드도 partition 순위대로 놓인다', async () => {
    const ir: ArchitectureIr = {
      ...screenChainIr(),
      view: 'deploy-path',
      nodes: [
        node('target', 'deploy_target'),
        node('wf', 'workflow'),
        node('img', 'artifact'),
        node('bld', 'build'),
      ],
      edges: [],
    };
    const { nodes, edges } = allIds(ir);
    const result = await computeLayout(ir, nodes, edges);
    const x = (id: string) => result.nodes.find((n) => n.id === id)!.x;
    expect(x('wf')).toBeLessThan(x('bld'));
    expect(x('bld')).toBeLessThan(x('img'));
    expect(x('img')).toBeLessThan(x('target'));
  });

  it('drawable 밖의 노드와 엣지는 결과에 없다', async () => {
    const ir = screenChainIr();
    const drawableNodes = new Set(['screen-cart', 'ep-post-order', 'mod-order']);
    // e4는 drawable 집합에 있지만 끝점 ext-pay가 빠져 있어 함께 빠져야 한다
    const drawableEdges = new Set(['e2', 'e3', 'e4']);
    const result = await computeLayout(ir, drawableNodes, drawableEdges);
    expect(result.nodes.map((n) => n.id)).toEqual(['ep-post-order', 'mod-order', 'screen-cart']);
    expect(result.edges.map((e) => e.id)).toEqual(['e2', 'e3']);
  });

  it('레인은 kind 순서대로 왼쪽부터 서고 클라이언트와 테이블은 따로 선다', async () => {
    const ir = screenChainIr();
    const { nodes, edges } = allIds(ir);
    const result = await computeLayout(ir, nodes, edges);
    expect(result.lanes.map((l) => [l.id, l.count])).toEqual([
      ['screen', 2],
      ['endpoint', 2],
      ['app_module', 1],
      ['external_service', 1],
      ['db_table', 1],
    ]);
    for (let i = 1; i < result.lanes.length; i++) {
      const prev = result.lanes[i - 1]!;
      expect(result.lanes[i]!.x).toBeGreaterThan(prev.x + prev.width);
    }
    // 레인은 제 노드를 전부 감싼다
    const screenLane = result.lanes[0]!;
    for (const id of ['screen-home', 'screen-cart']) {
      const n = result.nodes.find((x) => x.id === id)!;
      expect(n.x).toBeGreaterThan(screenLane.x);
      expect(n.x + n.width).toBeLessThan(screenLane.x + screenLane.width);
    }
  });

  it('화면끼리 잇는 선은 화면 레인을 여러 열로 벌리지 않고 같은 열 카드는 폭이 같다', async () => {
    const ir = screenChainIr();
    ir.edges.push({ ...edge('nav', 'screen-home', 'screen-cart'), kind: 'navigates' });
    const { nodes, edges } = allIds(ir);
    const result = await computeLayout(ir, nodes, edges);
    const box = (id: string) => result.nodes.find((n) => n.id === id)!;
    expect(box('screen-home').x).toBe(box('screen-cart').x);
    expect(box('screen-home').width).toBe(box('screen-cart').width);
    expect(result.edges.map((e) => e.id)).not.toContain('nav');
  });

  it('엣지 points는 시작점과 끝점을 담고 좌표는 소수 둘째 자리까지다', async () => {
    const ir = screenChainIr();
    const { nodes, edges } = allIds(ir);
    const result = await computeLayout(ir, nodes, edges);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    for (const e of result.edges) {
      expect(e.points.length).toBeGreaterThanOrEqual(2);
      for (const p of e.points) {
        expect(Math.round(p.x * 100) / 100).toBe(p.x);
        expect(Math.round(p.y * 100) / 100).toBe(p.y);
      }
    }
  });
});

describe('stackBands', () => {
  // elk가 낸 두 열. 제품 전용 카드와 같이 쓰는 카드가 열마다 섞여 있다
  const laid = (): LayoutResult => ({
    width: 600,
    height: 300,
    nodes: [
      { id: 'a1', x: 0, y: 12, width: 200, height: 48 },
      { id: 'b1', x: 0, y: 84, width: 200, height: 48 },
      { id: 's2', x: 300, y: 12, width: 200, height: 48 },
      { id: 'a2', x: 300, y: 84, width: 200, height: 48 },
      { id: 's3', x: 300, y: 156, width: 200, height: 48 },
      { id: 'c1', x: 300, y: 228, width: 200, height: 48 },
    ],
    edges: [
      {
        id: 'e1',
        points: [
          { x: 200, y: 36 },
          { x: 300, y: 36 },
        ],
      },
    ],
    lanes: [],
  });
  const groups = [
    { id: 'g1', name: '쇼핑', members: new Set(['a1', 'a2', 's2', 's3']) },
    { id: 'g2', name: '운영', members: new Set(['b1', 's2', 's3']) },
    { id: 'g3', name: '정산', members: new Set(['c1', 's3']) },
  ];
  const yOf = (l: LayoutResult, id: string) => l.nodes.find((n) => n.id === id)!.y;

  it('열은 그대로 두고 같이 쓰는 띠, 그룹 순서대로 제품 전용 띠를 쌓는다', () => {
    const out = stackBands(laid(), groups);
    expect(out.nodes.map((n) => n.x)).toEqual(laid().nodes.map((n) => n.x));
    // 띠 높이는 열끼리 맞춘다. 같은 띠 카드는 열이 달라도 같은 높이에서 시작한다
    expect(yOf(out, 'a1')).toBe(yOf(out, 'a2'));
    expect(yOf(out, 's3')).toBeLessThan(yOf(out, 'a2'));
    expect(yOf(out, 'a2')).toBeLessThan(yOf(out, 'b1'));
    expect(yOf(out, 'b1')).toBeLessThan(yOf(out, 'c1'));
    expect(out.regions!.bandOf).toEqual({ a1: 1, a2: 1, b1: 2, c1: 3, s2: 0, s3: 0 });
    expect(out.regions!.groups.map((g) => g.id)).toEqual(['g1', 'g2', 'g3']);
  });

  it('같이 쓰는 띠 안에서는 쓰는 제품이 많은 카드가 위로 간다', () => {
    const out = stackBands(laid(), groups);
    expect(yOf(out, 's3')).toBeLessThan(yOf(out, 's2'));
    expect(out.regions!.productsOf).toEqual({ s2: [0, 1], s3: [0, 1, 2] });
  });

  it('같이 쓰는 카드의 제품은 바로 이어진 그 제품 전용 카드가 많은 순이고 같으면 그룹 순서다', () => {
    const links = [
      { from: 'c1', to: 's3' },
      { from: 's3', to: 'c1' },
      { from: 'b1', to: 's3' },
      // 같이 쓰는 카드끼리 이은 선은 어느 제품 몫도 아니다
      { from: 's2', to: 's3' },
      { from: 'b1', to: 's2' },
    ];
    const out = stackBands(laid(), groups, links);
    expect(out.regions!.productsOf).toEqual({ s2: [1, 0], s3: [2, 1, 0] });
  });

  it('띠는 위에서부터 이어 붙고 카드는 자기 띠 머리 아래에 들어간다', () => {
    const { regions, nodes, height } = stackBands(laid(), groups);
    const bands = regions!.bands;
    expect(bands.map((b) => b.band)).toEqual([0, 1, 2, 3]);
    for (let i = 1; i < bands.length; i++) {
      expect(bands[i]!.y).toBe(bands[i - 1]!.y + bands[i - 1]!.height);
    }
    for (const n of nodes) {
      const band = bands.find((b) => b.band === regions!.bandOf[n.id])!;
      expect(n.y).toBeGreaterThanOrEqual(band.y + BAND_HEAD);
      expect(n.y + n.height).toBeLessThanOrEqual(band.y + band.height);
    }
    const last = bands[bands.length - 1]!;
    expect(last.y + last.height).toBeLessThanOrEqual(height);
  });

  it('카드가 있는 띠가 하나뿐이거나 그룹이 하나면 그대로 돌려준다', () => {
    const base = laid();
    const everyone = new Set(base.nodes.map((n) => n.id));
    const allShared = [
      { ...groups[0]!, members: everyone },
      { ...groups[1]!, members: everyone },
    ];
    expect(stackBands(base, allShared)).toBe(base);
    expect(stackBands(base, [groups[0]!])).toBe(base);
  });

  it('같은 입력이면 같은 결과를 낸다', () => {
    expect(JSON.stringify(stackBands(laid(), groups))).toBe(
      JSON.stringify(stackBands(laid(), groups)),
    );
  });
});

describe('카드 설명 줄 높이', () => {
  const DESC = '주문 목록을 한 번에 불러오는 조회예요.';

  it('설명이 있으면 한 줄 카드는 66, 두 줄 카드는 78이다', () => {
    expect(NODE_DESC_LINE).toBe(18);
    expect(
      measureNode('GET /orders', undefined, undefined, undefined, { description: DESC }).height,
    ).toBe(66);
    expect(
      measureNode('GET /orders', '주문 목록', undefined, undefined, { description: DESC }).height,
    ).toBe(78);
  });

  it('설명이 없거나 비었거나 공백뿐이면 높이도 폭도 그대로다', () => {
    const base = measureNode('GET /orders');
    for (const description of [undefined, '', '   ', '\n\t ']) {
      expect(measureNode('GET /orders', undefined, undefined, undefined, { description })).toEqual(
        base,
      );
    }
  });

  it('긴 설명은 폭을 안쪽 200px 상한까지만 넓힌다', () => {
    const short = measureNode('a', undefined, undefined, undefined, { description: '짧음' });
    const long = measureNode('a', undefined, undefined, undefined, {
      description: '가'.repeat(60),
    });
    const huge = measureNode('a', undefined, undefined, undefined, {
      description: '가'.repeat(600),
    });
    expect(long.width).toBeGreaterThan(short.width);
    // 앞 여백 12 + 뒤 여백 20 + 안쪽 200
    expect(long.width).toBe(232);
    expect(huge.width).toBe(long.width);
  });

  it('이름이 설명보다 길면 폭은 이름을 따른다', () => {
    const name = 'x'.repeat(60);
    expect(measureNode(name, undefined, undefined, undefined, { description: '짧음' }).width).toBe(
      measureNode(name).width,
    );
  });

  it('computeGraphLayout이 설명을 받아 카드 높이에 반영한다', async () => {
    const result = await computeGraphLayout(
      [
        { id: 'a', label: 'A', rank: 0, lane: 'screen', description: DESC },
        { id: 'b', label: 'B', rank: 1, lane: 'screen', description: '   ' },
        { id: 'c', label: 'C', rank: 2, lane: 'screen' },
      ],
      [],
    );
    const h = (id: string): number => result.nodes.find((n) => n.id === id)!.height;
    expect(h('a')).toBe(66);
    expect(h('b')).toBe(48);
    expect(h('c')).toBe(48);
  });

  it('computeLayout이 IR 노드의 description을 높이에 반영한다', async () => {
    const ir = screenChainIr();
    ir.nodes[0] = { ...ir.nodes[0]!, description: DESC };
    const { nodes, edges } = allIds(ir);
    const result = await computeLayout(ir, nodes, edges);
    expect(result.nodes.find((n) => n.id === 'screen-home')!.height).toBe(66);
    expect(result.nodes.find((n) => n.id === 'screen-cart')!.height).toBe(48);
  });
});

describe('질문별 그림 세 모양의 설명 줄 높이', () => {
  const DESC = '이 노드가 무엇인지 한 줄로 적어요.';

  it('compare 카드가 설명만큼 높아진다', () => {
    const ir = paymentCompareIr();
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    const drawable = new Set(ir.nodes.map((n) => n.id));
    const before = computeCompareLayout(ir.projections![0]!, drawable, byId);
    byId.set('pg', { ...byId.get('pg')!, description: DESC });
    const after = computeCompareLayout(ir.projections![0]!, drawable, byId);
    const h = (l: typeof before, id: string): number => l.cards.find((c) => c.id === id)!.height;
    expect(h(after, 'pg')).toBe(h(before, 'pg') + NODE_DESC_LINE);
    expect(h(after, 'ledger')).toBe(h(before, 'ledger'));
    expect(after.height).toBeGreaterThan(before.height);
  });

  it('dataflow 카드가 설명만큼 높아진다', () => {
    const ir = orderDataflowIr();
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    const drawn = new Set(['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7']);
    const before = computeDataflowLayout(ir.projections![0]!, drawn, byId);
    byId.set('api', { ...byId.get('api')!, description: DESC });
    const after = computeDataflowLayout(ir.projections![0]!, drawn, byId);
    const h = (l: typeof before, id: string): number => l.cards.find((c) => c.id === id)!.height;
    expect(h(after, 'api')).toBe(h(before, 'api') + NODE_DESC_LINE);
    expect(h(after, 'db')).toBe(h(before, 'db'));
  });

  it('sequence 머리 카드가 설명만큼 높아진다', () => {
    const ir = checkoutSequenceIr();
    const p = ir.projections![0]!;
    const byId = new Map(ir.nodes.map((n) => [n.id, n]));
    const drawn = new Set(p.messages.map((m) => m.id));
    const before = computeSequenceLayout(p, drawn, byId);
    const target = before.heads[0]!.id;
    byId.set(target, { ...byId.get(target)!, description: DESC });
    const after = computeSequenceLayout(p, drawn, byId);
    const h = (l: typeof before, id: string): number => l.heads.find((c) => c.id === id)!.height;
    expect(h(after, target)).toBe(h(before, target) + NODE_DESC_LINE);
    expect(h(after, before.heads[1]!.id)).toBe(h(before, before.heads[1]!.id));
  });
});
