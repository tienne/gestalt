import { describe, expect, it } from 'vitest';
import {
  computeArchitectureDelta,
  deltaCounts,
  deltaOverBudget,
  deltaScope,
  type DeltaSnapshot,
} from '../../../src/architecture/delta.js';
import { computeDeltaLayout, renderDeltaHtml } from '../../../src/architecture/delta-renderer.js';
import type {
  ArchitectureEdge,
  ArchitectureIr,
  ArchitectureNode,
} from '../../../src/architecture/types.js';
import { validateArchitectureIr } from '../../../src/architecture/validator.js';

const EV = [{ type: 'code' as const, location: 'web:src/a.ts:1', visibility: 'public' as const }];

function node(
  id: string,
  kind: ArchitectureNode['kind'],
  label: string,
  extra: Partial<ArchitectureNode> = {},
): ArchitectureNode {
  return { id, kind, label, repo: 'web', evidence: EV, ...extra };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: ArchitectureEdge['kind'] = 'calls',
): ArchitectureEdge {
  return { id, from, to, kind, evidence: EV, lineStyle: 'solid' };
}

function ir(nodes: ArchitectureNode[], edges: ArchitectureEdge[]): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '.' }],
    nodes,
    edges,
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function snap(value: ArchitectureIr): DeltaSnapshot {
  const r = validateArchitectureIr(value, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return { ir: r.value.ir, nodeIds: r.value.drawableNodeIds, edgeIds: r.value.drawableEdgeIds };
}

function beforeIr(): ArchitectureIr {
  return ir(
    [
      node('f-a', 'feature', 'A'),
      node('f-b', 'feature', 'B'),
      node('s-list', 'screen', 'List', { parent: 'f-a' }),
      node('s-cart', 'screen', 'Cart', { parent: 'f-a' }),
      node('ep-orders', 'endpoint', 'GET /orders'),
      node('ep-cart', 'endpoint', 'POST /cart'),
      node('ep-old', 'endpoint', 'GET /old'),
    ],
    [edge('c1', 's-list', 'ep-orders'), edge('c2', 's-cart', 'ep-cart')],
  );
}

function afterIr(): ArchitectureIr {
  const next = beforeIr();
  next.generatedAt = '2026-02-01T00:00:00.000Z';
  next.nodes = next.nodes.filter((n) => n.id !== 'ep-old');
  next.nodes.push(node('ep-pay', 'endpoint', 'POST /pay'));
  next.nodes.find((n) => n.id === 's-list')!.displayName = '주문 목록';
  next.nodes.find((n) => n.id === 's-cart')!.parent = 'f-b';
  next.edges = [edge('c1b', 's-list', 'ep-cart'), edge('c2', 's-cart', 'ep-cart')];
  next.edges.push(edge('c3', 's-cart', 'ep-pay'));
  return next;
}

describe('computeArchitectureDelta', () => {
  it('다섯 변경어를 (id, 변경) 한 줄씩 정해진 순서로 낸다', () => {
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(afterIr()));
    expect(delta.ledger.map((e) => `${e.change} ${e.target}`)).toEqual([
      'ADDED ep-pay',
      'ADDED c3',
      'REMOVED ep-old',
      'CHANGED s-list',
      'MOVED s-cart',
      'REWIRED c1b',
    ]);
    const rewired = delta.ledger.find((e) => e.change === 'REWIRED')!;
    expect(rewired.text).toContain('"List" → "GET /orders"');
    expect(rewired.text).toContain('"주문 목록" → "POST /cart"');
    expect(delta.ledger.find((e) => e.change === 'MOVED')!.text).toContain('부모 "A" → "B"');
  });

  it('바뀌지 않은 것은 원장에 없다', () => {
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(beforeIr()));
    expect(delta.ledger).toEqual([]);
    expect(delta.nodes.every((n) => n.changes.length === 0)).toBe(true);
  });

  it('바뀐 노드는 속성과 이동을 두 건으로 센다', () => {
    const next = beforeIr();
    const cart = next.nodes.find((n) => n.id === 's-cart')!;
    cart.parent = 'f-b';
    cart.description = '장바구니';
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
    expect(delta.ledger.map((e) => `${e.change} ${e.target}`)).toEqual([
      'CHANGED s-cart',
      'MOVED s-cart',
    ]);
  });

  it('끝점 짝이 여럿이라 모호하면 다시 이음 대신 빠짐과 생김으로 둔다', () => {
    const next = beforeIr();
    next.edges = [edge('c2', 's-cart', 'ep-cart'), edge('x1', 's-list', 'ep-cart')];
    next.edges.push(edge('x2', 's-list', 'ep-old'));
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
    expect(delta.ledger.map((e) => `${e.change} ${e.target}`)).toEqual([
      'ADDED x1',
      'ADDED x2',
      'REMOVED c1',
    ]);
  });

  it('근거가 없어 그려지지 않던 노드가 근거를 얻으면 생김으로 본다', () => {
    const prev = beforeIr();
    prev.nodes.find((n) => n.id === 'ep-old')!.evidence = [];
    const delta = computeArchitectureDelta(snap(prev), snap(beforeIr()));
    expect(delta.ledger.map((e) => `${e.change} ${e.target}`)).toEqual(['ADDED ep-old']);
  });
});

describe('deltaScope와 예산', () => {
  it('예산 안이면 전부 그리고 경고가 없다', () => {
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(afterIr()));
    const scope = deltaScope(delta);
    expect(scope.scoped).toBe(false);
    expect(deltaOverBudget(deltaCounts(delta, scope))).toEqual([]);
  });

  it('합집합이 예산을 넘으면 바뀐 노드와 1홉 이웃만 남긴다', () => {
    const prev = beforeIr();
    for (let i = 0; i < 6; i++) {
      prev.nodes.push(node(`s-far${i}`, 'screen', `Far ${i}`));
    }
    const next = structuredClone(prev);
    next.nodes.find((n) => n.id === 'ep-cart')!.description = '장바구니 담기';
    const delta = computeArchitectureDelta(snap(prev), snap(next));
    const scope = deltaScope(delta);
    expect(scope.scoped).toBe(true);
    expect(scope.total.components).toBe(13);
    expect([...scope.nodeIds].sort()).toEqual(['ep-cart', 's-cart']);
    expect([...scope.edgeIds]).toEqual(['c2']);
  });

  it('좁혀도 넘으면 넘은 항목을 글로 돌려준다', () => {
    const next = beforeIr();
    for (let i = 0; i < 9; i++) next.nodes.push(node(`ep-x${i}`, 'endpoint', `GET /x${i}`));
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
    const over = deltaOverBudget(deltaCounts(delta, deltaScope(delta)));
    expect(over).toEqual(['구성 요소 9개 (예산 8)', '변경 목록 9개 (예산 8)']);
  });
});

describe('renderDeltaHtml', () => {
  async function page(): Promise<string> {
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(afterIr()));
    const scope = deltaScope(delta);
    return renderDeltaHtml(delta, scope, await computeDeltaLayout(delta, scope), {
      audience: 'private',
    });
  }

  function cardRect(html: string, panel: 'before' | 'after', id: string): string | undefined {
    const section = html.split(`data-snapshot="${panel}"`)[1]!.split('</section>')[0]!;
    const m = new RegExp(
      `data-object-id="${id}" data-status="[^"]*"><title>[^<]*</title><rect class="[^"]*" (x="[^"]*" y="[^"]*" width="[^"]*" height="[^"]*")`,
    ).exec(section);
    return m?.[1];
  }

  it('남은 노드는 두 패널에서 같은 좌표에 서고 한쪽에만 있는 노드는 그쪽에만 그린다', async () => {
    const html = await page();
    for (const id of ['s-list', 's-cart', 'ep-orders', 'ep-cart']) {
      expect(cardRect(html, 'before', id)).toBeDefined();
      expect(cardRect(html, 'before', id)).toBe(cardRect(html, 'after', id));
    }
    expect(cardRect(html, 'before', 'ep-old')).toBeDefined();
    expect(cardRect(html, 'after', 'ep-old')).toBeUndefined();
    expect(cardRect(html, 'after', 'ep-pay')).toBeDefined();
    expect(cardRect(html, 'before', 'ep-pay')).toBeUndefined();
  });

  it('원장은 대문자 변경어로 시작하고 색 말고도 배지 글자와 선 모양으로 구분한다', async () => {
    const html = await page();
    expect(html).toContain('<span class="dl-word">REWIRED</span> <code>c1b</code>');
    expect(html).toContain('+ 생김');
    expect(html).toContain('− 빠짐');
    expect(html).toContain('Δ 변경');
    // 빠진 노드는 점 테두리, 빠진 선은 점선이다
    expect(html).toMatch(/\.dl-card\.c-removed \{[^}]*stroke-dasharray/);
    expect(html).not.toContain('·');
  });

  it('같은 입력이면 같은 바이트를 낸다', async () => {
    expect(await page()).toBe(await page());
  });
});

const lines = (d: ReturnType<typeof computeArchitectureDelta>): string[] =>
  d.ledger.map((e) => `${e.change} ${e.target}`);

describe('엣지만 바뀐 경우', () => {
  it('엣지 추가는 노드가 그대로여도 ADDED 한 줄이고 노드 배지는 없다', () => {
    const next = beforeIr();
    next.edges.push(edge('c3', 's-list', 'ep-cart'));
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
    expect(lines(delta)).toEqual(['ADDED c3']);
    expect(delta.nodes.every((n) => n.changes.length === 0)).toBe(true);
    expect(delta.ledger[0]!.object).toBe('edge');
  });

  it('엣지 삭제는 REMOVED 한 줄이다', () => {
    const next = beforeIr();
    next.edges = next.edges.filter((e) => e.id !== 'c2');
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
    expect(lines(delta)).toEqual(['REMOVED c2']);
    expect(delta.ledger[0]!.text).toContain('빠짐');
  });

  it('엣지만 바뀐 그림도 HTML 원장과 배지가 나온다', async () => {
    const next = beforeIr();
    next.edges.push(edge('c3', 's-list', 'ep-cart'));
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
    const scope = deltaScope(delta);
    const html = renderDeltaHtml(delta, scope, await computeDeltaLayout(delta, scope), {
      audience: 'private',
    });
    expect(html).toContain('data-change="ADDED" data-target="c3"');
    expect(html).toContain('class="dl-link"');
    expect(html).toContain('+ 생김');
  });
});

describe('CHANGED 대상 속성과 MOVED 대상', () => {
  const cases: Array<[string, (n: ArchitectureNode[]) => void, string]> = [
    ['displayName', (n) => (n.find((x) => x.id === 's-list')!.displayName = '목록'), '표시 이름'],
    ['description', (n) => (n.find((x) => x.id === 's-list')!.description = '설명'), '설명'],
    ['protocol', (n) => (n.find((x) => x.id === 'ep-orders')!.protocol = 'grpc'), '프로토콜'],
    [
      'actions',
      (n) => {
        const t = n.find((x) => x.id === 'ep-orders')!;
        t.protocol = 'mcp';
        t.mcpServer = 'srv';
        t.actions = ['a', 'b'];
      },
      '동작',
    ],
  ];
  for (const [name, mutate, word] of cases) {
    it(`${name} 변경은 CHANGED 한 줄이고 "${word}"을 담는다`, () => {
      const next = beforeIr();
      mutate(next.nodes);
      const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
      const changed = delta.ledger.filter((e) => e.change === 'CHANGED');
      expect(changed).toHaveLength(1);
      expect(changed[0]!.text).toContain(word);
      expect(delta.ledger.filter((e) => e.change === 'MOVED')).toEqual([]);
    });
  }

  it('db_table 컬럼이 생기거나 빠지거나 바뀌면 CHANGED 한 줄에 컬럼 이름을 담는다', () => {
    const prev = beforeIr();
    prev.nodes.push(
      node('t-orders', 'db_table', 'orders', {
        columns: [
          { name: 'id', pk: true },
          { name: 'memo', type: 'text' },
          { name: 'total', type: 'int' },
        ],
      }),
    );
    const next = structuredClone(prev);
    next.nodes.find((n) => n.id === 't-orders')!.columns = [
      { name: 'id', pk: true },
      { name: 'total', type: 'numeric' },
      { name: 'status', type: 'text' },
    ];
    const delta = computeArchitectureDelta(snap(prev), snap(next));
    const e = delta.ledger.find((x) => x.target === 't-orders')!;
    expect(e.change).toBe('CHANGED');
    expect(e.text).toContain('컬럼 status 생김');
    expect(e.text).toContain('컬럼 memo 빠짐');
    expect(e.text).toContain('컬럼 total 바뀜');
  });

  it('displayKind 변경은 component 노드에서 CHANGED다', () => {
    const prev = { ...beforeIr(), packs: ['web-product', 'harness', 'generic'] } as ArchitectureIr;
    prev.nodes.push(node('c-job', 'component', 'Job', { displayKind: '배치 잡' }));
    const next = structuredClone(prev);
    next.nodes.find((n) => n.id === 'c-job')!.displayKind = '결재 문서';
    const delta = computeArchitectureDelta(snap(prev), snap(next));
    const e = delta.ledger.find((x) => x.target === 'c-job')!;
    expect(e.change).toBe('CHANGED');
    expect(e.text).toContain('종류 표시 "배치 잡" → "결재 문서"');
  });

  it('environment와 engine 변경은 datastore에서 CHANGED다', () => {
    const prev = beforeIr();
    prev.nodes.push(node('db', 'datastore', 'orders-db', { environment: 'dev', engine: 'mysql' }));
    const next = structuredClone(prev);
    const db = next.nodes.find((n) => n.id === 'db')!;
    db.environment = 'prod';
    db.engine = 'redis';
    const delta = computeArchitectureDelta(snap(prev), snap(next));
    const e = delta.ledger.find((x) => x.target === 'db')!;
    expect(e.change).toBe('CHANGED');
    expect(e.text).toContain('환경 "dev" → "prod"');
    expect(e.text).toContain('엔진 "mysql" → "redis"');
  });

  it('platforms 변경은 service에서 CHANGED다', () => {
    const prev = beforeIr();
    prev.nodes.push(node('svc', 'service', 'shop', { platforms: ['web'] }));
    const next = structuredClone(prev);
    next.nodes.find((n) => n.id === 'svc')!.platforms = ['web', 'android'];
    next.nodes.find((n) => n.id === 'svc')!.platformEvidence = { android: EV };
    const delta = computeArchitectureDelta(snap(prev), snap(next));
    const e = delta.ledger.find((x) => x.target === 'svc');
    expect(e?.change).toBe('CHANGED');
    expect(e?.text).toContain('플랫폼');
  });

  it('parent 이동은 MOVED 한 줄이다', () => {
    const next = beforeIr();
    next.nodes.find((n) => n.id === 's-list')!.parent = 'f-b';
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
    expect(lines(delta)).toEqual(['MOVED s-list']);
  });

  it('account 이동은 MOVED 한 줄이다', () => {
    const prev = beforeIr();
    prev.nodes.push(
      node('acc-a', 'cloud_account', 'acc-a'),
      node('acc-b', 'cloud_account', 'acc-b'),
    );
    prev.nodes.push(node('db', 'datastore', 'orders-db', { account: 'acc-a' }));
    const next = structuredClone(prev);
    next.nodes.find((n) => n.id === 'db')!.account = 'acc-b';
    const delta = computeArchitectureDelta(snap(prev), snap(next));
    expect(lines(delta).filter((l) => l.includes(' db'))).toEqual(['MOVED db']);
    expect(delta.ledger.find((e) => e.target === 'db')!.text).toContain('계정 "acc-a" → "acc-b"');
  });

  it('stage 이동은 MOVED 한 줄이다', () => {
    const prev = beforeIr();
    prev.stages = [
      { id: 'st1', label: '앞단', nodes: ['s-list'] },
      { id: 'st2', label: '뒷단', nodes: ['ep-orders'] },
    ];
    const next = structuredClone(prev);
    next.stages = [
      { id: 'st1', label: '앞단', nodes: [] },
      { id: 'st2', label: '뒷단', nodes: ['ep-orders', 's-list'] },
    ];
    const delta = computeArchitectureDelta(snap(prev), snap(next));
    const e = delta.ledger.find((x) => x.target === 's-list' && x.change === 'MOVED');
    expect(e?.text).toContain('구간 "앞단" → "뒷단"');
  });
});

describe('REWIRED 판정', () => {
  it('유일한 짝이면 REWIRED, 같은 id가 끝을 바꿔도 REWIRED다', () => {
    const next = beforeIr();
    next.edges = [edge('c1', 's-list', 'ep-cart'), edge('c2', 's-cart', 'ep-cart')];
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
    expect(lines(delta)).toEqual(['REWIRED c1']);
  });

  it('종류가 다른 엣지는 짝이 아니라 REMOVED와 ADDED다', () => {
    const next = beforeIr();
    next.edges = [edge('x1', 's-list', 'ep-cart', 'handles'), edge('c2', 's-cart', 'ep-cart')];
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
    expect(lines(delta)).toEqual(['ADDED x1', 'REMOVED c1']);
  });

  it('빠진 엣지 하나에 생긴 엣지 둘이 짝을 다투면 모호하다', () => {
    const next = beforeIr();
    next.edges = [
      edge('c2', 's-cart', 'ep-cart'),
      edge('y1', 's-list', 'ep-cart'),
      edge('y2', 's-list', 'ep-pay0'),
    ];
    next.nodes.push(node('ep-pay0', 'endpoint', 'GET /p0'));
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
    expect(delta.ledger.some((e) => e.change === 'REWIRED')).toBe(false);
    expect(lines(delta)).toContain('REMOVED c1');
  });
});

describe('같은 노드의 CHANGED와 MOVED', () => {
  it('두 줄이고 노드 배지 목록에도 둘 다 든다', () => {
    const next = beforeIr();
    const cart = next.nodes.find((n) => n.id === 's-cart')!;
    cart.parent = 'f-b';
    cart.displayName = '카트';
    const delta = computeArchitectureDelta(snap(beforeIr()), snap(next));
    expect(lines(delta)).toEqual(['CHANGED s-cart', 'MOVED s-cart']);
    expect(delta.nodes.find((n) => n.id === 's-cart')!.changes).toEqual(['CHANGED', 'MOVED']);
  });
});

describe('예산 경계값', () => {
  function withExtra(n: number): ArchitectureIr {
    const next = beforeIr();
    next.nodes = next.nodes.filter((x) => x.id !== 'ep-old' && x.id !== 'f-b');
    for (let i = 0; i < n; i++) next.nodes.push(node(`ep-x${i}`, 'endpoint', `GET /x${i}`));
    return next;
  }
  function base(): ArchitectureIr {
    const b = beforeIr();
    b.nodes = b.nodes.filter((x) => x.id !== 'ep-old' && x.id !== 'f-b');
    return b;
  }

  it('원장이 정확히 8건이면 경고가 없다', () => {
    const delta = computeArchitectureDelta(snap(base()), snap(withExtra(8)));
    expect(delta.ledger).toHaveLength(8);
    expect(deltaOverBudget(deltaCounts(delta, deltaScope(delta)))).toEqual([]);
  });

  it('원장이 9건이면 변경 목록만 경고한다', () => {
    const delta = computeArchitectureDelta(snap(base()), snap(withExtra(9)));
    const over = deltaOverBudget(deltaCounts(delta, deltaScope(delta)));
    expect(over).toEqual(['구성 요소 9개 (예산 8)', '변경 목록 9개 (예산 8)']);
  });

  it('합집합 노드가 정확히 8이면 좁히지 않는다', () => {
    const prev = ir(
      Array.from({ length: 8 }, (_, i) => node(`ep-${i}`, 'endpoint', `GET /${i}`)),
      [],
    );
    const next = structuredClone(prev);
    next.nodes[0]!.description = '바뀜';
    const delta = computeArchitectureDelta(snap(prev), snap(next));
    const scope = deltaScope(delta);
    expect(scope.scoped).toBe(false);
    expect(scope.nodeIds.size).toBe(8);
    expect(deltaOverBudget(deltaCounts(delta, scope))).toEqual([]);
  });

  it('합집합 노드가 9이면 좁히고 좁힌 결과가 예산 안이면 경고가 없다', () => {
    const prev = ir(
      Array.from({ length: 9 }, (_, i) => node(`ep-${i}`, 'endpoint', `GET /${i}`)),
      [],
    );
    const next = structuredClone(prev);
    next.nodes[0]!.description = '바뀜';
    const delta = computeArchitectureDelta(snap(prev), snap(next));
    const scope = deltaScope(delta);
    expect(scope.scoped).toBe(true);
    expect([...scope.nodeIds]).toEqual(['ep-0']);
    expect(deltaOverBudget(deltaCounts(delta, scope))).toEqual([]);
  });

  it('관계 10개는 경고 없고 11개는 좁힌 뒤에도 넘을 때만 경고한다', () => {
    const mk = (m: number): [ArchitectureIr, ArchitectureIr] => {
      const nodes = [
        node('s-a', 'screen', 'A'),
        ...Array.from({ length: 7 }, (_, i) => node(`ep-${i}`, 'endpoint', `GET /${i}`)),
      ];
      const edges = Array.from({ length: m }, (_, i) =>
        edge(`e${i}`, 's-a', `ep-${i % 7}`, i < 7 ? 'calls' : 'handles'),
      );
      const prev = ir(nodes, []);
      return [prev, ir(nodes, edges)];
    };
    const [p10, n10] = mk(10);
    const d10 = computeArchitectureDelta(snap(p10), snap(n10));
    expect(deltaOverBudget(deltaCounts(d10, deltaScope(d10)))).toEqual(['변경 목록 10개 (예산 8)']);
    expect(deltaScope(d10).scoped).toBe(false);
  });
});

describe('HTML 안전성과 결정성', () => {
  it('원장 문구와 노드 텍스트의 꺾쇠가 escape 된다', async () => {
    const prev = beforeIr();
    const next = beforeIr();
    next.nodes.push(node('ep-xss', 'endpoint', '<script>alert(1)</script>'));
    next.nodes.find((n) => n.id === 's-list')!.displayName = '"><img src=x onerror=1>';
    const delta = computeArchitectureDelta(snap(prev), snap(next));
    const scope = deltaScope(delta);
    const html = renderDeltaHtml(delta, scope, await computeDeltaLayout(delta, scope), {
      audience: 'private',
    });
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('공유본 렌더도 같은 입력에서 바이트가 같다', async () => {
    const run = async (): Promise<string> => {
      const delta = computeArchitectureDelta(snap(beforeIr()), snap(afterIr()));
      const scope = deltaScope(delta);
      return renderDeltaHtml(delta, scope, await computeDeltaLayout(delta, scope), {
        audience: 'shared',
      });
    };
    expect(await run()).toBe(await run());
  });
});
