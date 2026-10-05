import { describe, expect, it } from 'vitest';
import {
  computeDrilldown,
  renderArchitectureHtml,
  renderDrilldownHtml,
  stableStringify,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type Evidence,
  type ValidatedIr,
} from '../../../src/architecture/index.js';
import { computeLayout, type LayoutResult } from '../../../src/architecture/layout.js';

const codeEv: Evidence = { type: 'code', location: 'web:src/home.tsx:3', visibility: 'public' };
const docEv: Evidence = {
  type: 'doc',
  location: 'https://docs.acme.test/home',
  visibility: 'public',
  updatedAt: '2026-01-02',
  excerpt: 'PUBLIC-EXCERPT',
};
const privateEv: Evidence = {
  type: 'doc',
  location: 'https://wiki.acme.internal/secret-page',
  visibility: 'private',
};

function node(id: string, label = id, evidence: Evidence[] = [codeEv]): ArchitectureNode {
  return { id, kind: id === 'api' ? 'endpoint' : 'screen', label, repo: 'web', evidence };
}

function edge(id: string, from: string, to: string, evidence: Evidence[]): ArchitectureEdge {
  return { id, from, to, kind: 'calls', evidence, lineStyle: 'dashed' };
}

function makeIr(): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '/srv/acme-web' }],
    nodes: [
      node('home', 'Home <b>bold</b>', [codeEv, privateEv]),
      node('api'),
      node('detail', 'Detail', [docEv]),
      node('orphan', 'Orphan', []),
    ],
    edges: [
      edge('e-code', 'home', 'api', [codeEv]),
      edge('e-doc', 'home', 'detail', [docEv]),
      edge('e-orphan', 'home', 'orphan', [codeEv]),
    ],
    unresolved: [
      { id: 'q1', subject: { nodeId: 'api' }, question: 'Who owns it?' },
      { id: 'q2', subject: { nodeId: 'home' }, question: 'Answered', answer: 'team-a' },
    ],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

async function prepare(ir: ArchitectureIr): Promise<{ v: ValidatedIr; layout: LayoutResult }> {
  const result = validateArchitectureIr(ir, { checkFiles: false });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  const v = result.value;
  const layout = await computeLayout(v.ir, v.drawableNodeIds, v.drawableEdgeIds);
  return { v, layout };
}

function reorderKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reorderKeys) as T;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).reverse();
    return Object.fromEntries(entries.map(([k, v]) => [k, reorderKeys(v)])) as T;
  }
  return value;
}

function edgeTag(html: string, id: string): string {
  const m = html.match(new RegExp(`<path class="edge[^"]*" data-edge-id="${id}"[^>]*>`));
  if (!m) throw new Error(`edge ${id} not found`);
  return m[0];
}

describe('renderArchitectureHtml', () => {
  it('같은 입력을 두 번 그리면 바이트가 같다', async () => {
    const { v, layout } = await prepare(makeIr());
    const a = renderArchitectureHtml(v, layout, { audience: 'private' });
    const b = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  it('노드 순서와 키 순서가 달라도 같은 바이트가 나온다', async () => {
    const base = await prepare(makeIr());
    const shuffled = makeIr();
    shuffled.nodes.reverse();
    shuffled.edges.reverse();
    shuffled.unresolved.reverse();
    const other = await prepare(reorderKeys(shuffled));
    const reversedLayout: LayoutResult = {
      ...other.layout,
      nodes: [...other.layout.nodes].reverse(),
      edges: [...other.layout.edges].reverse(),
    };
    const a = renderArchitectureHtml(base.v, base.layout, { audience: 'private' });
    const b = renderArchitectureHtml(other.v, reversedLayout, { audience: 'private' });
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0);
  });

  it('외부 스크립트를 싣지 않는다', async () => {
    const { v, layout } = await prepare(makeIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(html).not.toMatch(/<script[^>]*\ssrc=/);
    expect(html).not.toMatch(/<link[^>]*stylesheet/);
  });

  it('doc 근거 엣지는 점선이고 code 근거 엣지는 실선이다', async () => {
    const { v, layout } = await prepare(makeIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(edgeTag(html, 'e-doc')).toContain('stroke-dasharray="6 4"');
    expect(edgeTag(html, 'e-code')).not.toContain('stroke-dasharray');
  });

  it('drawable 밖 노드와 엣지는 그리지도 싣지도 않는다', async () => {
    const { v, layout } = await prepare(makeIr());
    expect(v.drawableEdgeIds.has('e-orphan')).toBe(false);
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(html).not.toContain('data-edge-id="e-orphan"');
    expect(html).not.toContain('data-node-id="orphan"');
    expect(html).not.toContain('"id":"e-orphan"');
  });

  it('shared는 private 근거의 location을 빼고 public 근거는 남긴다', async () => {
    const { v, layout } = await prepare(makeIr());
    const shared = renderArchitectureHtml(v, layout, { audience: 'shared' });
    expect(shared).not.toContain('wiki.acme.internal');
    expect(shared).toContain('PUBLIC-EXCERPT');
    expect(shared).toContain('"type":"doc","visibility":"private"}');
    expect(shared).toContain('web:src/home.tsx:3');
    expect(shared).toContain('https://docs.acme.test/home');
    expect(shared).not.toContain('/srv/acme-web');

    const priv = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(priv).toContain('wiki.acme.internal');
  });

  it('라벨의 HTML을 이스케이프한다', async () => {
    const { v, layout } = await prepare(makeIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(html).toContain('Home &lt;b&gt;bold&lt;/b&gt;');
    expect(html).not.toContain('<b>bold</b>');
  });

  it('IR 문자열 안의 </script>를 끊지 않게 바꾼다', async () => {
    const ir = makeIr();
    ir.nodes[1] = { ...node('api'), description: '</script><script>alert(1)</script>' };
    const { v, layout } = await prepare(ir);
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    const dataBlock = html.slice(html.indexOf('<script id="ir"'));
    const end = dataBlock.indexOf('</script>');
    const json = dataBlock.slice(dataBlock.indexOf('>') + 1, end);
    expect(json).toContain('<\\/script>');
    expect(JSON.parse(json).nodes.find((n: { id: string }) => n.id === 'api').description).toBe(
      '</script><script>alert(1)</script>',
    );
  });

  it('위쪽 바의 질문 수와 질문 팝오버가 답 없는 것과 자동 질문을 합쳐 보여준다', async () => {
    const { v, layout } = await prepare(makeIr());
    const expected = 1 + v.autoUnresolved.length;
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(html).toContain(`<span class="n warn">${expected}</span>`);
    expect(html).toContain(`<h3>확인할 질문 ${expected}개</h3>`);
    // 질문을 누르면 대상 카드로 간다
    expect(html).toMatch(/<button type="button" class="q" data-node-id="api">/);
    expect(html).toContain('Who owns it?');
    expect(html).not.toContain('Answered');
    expect(html).toContain('2026-01-01T00:00:00.000Z');
  });

  it('다크와 라이트 테마를 둘 다 정의하고 범례를 싣는다', async () => {
    const { v, layout } = await prepare(makeIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(html).toContain('prefers-color-scheme: dark');
    expect(html).toContain('실선: 코드나 스펙으로 확인한 연결');
    expect(html).toContain('점선: 문서나 사람 말, 실제 조회로만 확인한 연결');
    expect(html).toContain('class="swatch k-endpoint"');
    // 토글은 html의 data-theme로 덮고 저장 실패에도 동작해야 한다
    expect(html).toContain(':root[data-theme="dark"]');
    expect(html).toContain(':root:not([data-theme="light"])');
    expect(html).toMatch(/try \{\s*var t = localStorage\.getItem/);
  });

  it('레인 띠와 제목을 서버 좌표로 박고 kind별 아이콘을 sprite로 싣는다', async () => {
    const { v, layout } = await prepare(makeIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(layout.lanes.map((l) => l.id)).toEqual(['screen', 'endpoint']);
    expect(html.match(/<rect class="lane" /g)).toHaveLength(2);
    expect(html).toMatch(
      /<div class="lane-title" data-lane-id="screen" role="button" tabindex="0" aria-label="화면 레인, 카드 2개" style="left:[\d.]+px;top:22px;width:[\d.]+px">화면<span class="n">2<\/span><\/div>/,
    );
    expect(html).toContain('<symbol id="i-endpoint"');
    expect(html).toContain('<use href="#i-screen"/>');
    // 외부 글꼴이나 이모지 아이콘에 기대지 않는다
    expect(html).not.toMatch(/@import|@font-face|fonts\.googleapis/);
  });

  it('종류를 색만이 아니라 아이콘과 짧은 이름 칩으로도 보여준다', async () => {
    const { v, layout } = await prepare(makeIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(html).toContain(
      '<span class="kc"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#i-endpoint"/></svg>API</span>',
    );
    expect(html).toContain('<use href="#i-screen"/></svg>화면</span>');
  });

  it('선은 출발 카드 오른쪽에서 도착 카드 왼쪽으로 가는 베지어다', async () => {
    const { v, layout } = await prepare(makeIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(edgeTag(html, 'e-code')).toMatch(/ d="M[\d.]+ [\d.]+C/);
    expect(html).toMatch(
      /<g class="link e-calls" data-from="home" data-to="api" data-link-id="[^"]+" tabindex="0" role="button"/,
    );
  });

  it('URL 근거만 링크로 열고 나머지 스킴은 텍스트로 둔다', async () => {
    const { v, layout } = await prepare(makeIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(html).toContain('/^https?:\\/\\//i');
    expect(html).toContain("a.rel = 'noopener noreferrer'");
    expect(html).not.toContain('innerHTML');
  });
});

describe('renderArchitectureHtml 표시 이름', () => {
  function namedIr(): ArchitectureIr {
    const ir = makeIr();
    ir.nodes = ir.nodes.map((n) => {
      if (n.id === 'detail') return { ...n, displayName: '상세 화면' };
      if (n.id === 'api') return { ...n, displayName: '목록 조회', displayNameInferred: true };
      return n;
    });
    return ir;
  }

  function nodeTag(html: string, id: string): string {
    const m = html.match(new RegExp(`<div class="node[^"]*" data-node-id="${id}"[\\s\\S]*?</div>`));
    if (!m) throw new Error(`node ${id} not found`);
    return m[0];
  }

  it('표시 이름이 있으면 첫 줄에 표시 이름, 둘째 줄에 label을 그린다', async () => {
    const { v, layout } = await prepare(namedIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    const tag = nodeTag(html, 'detail');
    expect(tag).toContain(
      '<span class="nm"><span class="t">상세 화면</span></span><span class="tc">Detail</span>',
    );
    expect(tag).not.toContain('class="guess"');
  });

  it('표시 이름이 없으면 지금처럼 label 한 줄이다', async () => {
    const { v, layout } = await prepare(namedIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    const tag = nodeTag(html, 'home');
    expect(tag).not.toContain('class="tc"');
    expect(tag).toContain('<span class="t">Home &lt;b&gt;bold&lt;/b&gt;</span></span></div>');
  });

  it('추정 이름은 첫 줄 뒤에 배지를 붙이고 패널에 사유를 적는다', async () => {
    const { v, layout } = await prepare(namedIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(nodeTag(html, 'api')).toContain(
      '<span class="t">목록 조회</span><span class="guess">추정</span>',
    );
    expect(nodeTag(html, 'api')).toContain('aria-label="목록 조회, API, 추정 이름"');
    expect(html).toContain('문서에 정해진 이름이 없어서 설명 문장을 보고 붙인 이름이에요');
    expect(html).toContain('function nameOf(n) { return n.displayName || n.label; }');
  });

  it('두 줄 박스는 고정 높이이고 한 줄 박스보다 높다', async () => {
    const { layout } = await prepare(namedIr());
    const box = (id: string) => layout.nodes.find((n) => n.id === id)!;
    expect(box('detail').height).toBe(60);
    expect(box('api').height).toBe(60);
    expect(box('home').height).toBe(48);
  });

  it('shared에도 표시 이름은 남는다', async () => {
    const { v, layout } = await prepare(namedIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'shared' });
    expect(html).toContain('상세 화면');
    expect(html).toContain('"displayNameInferred":true');
    expect(html).not.toContain(privateEv.location);
  });

  it('표시 이름이 있어도 같은 입력이면 같은 바이트다', async () => {
    const a = await prepare(namedIr());
    const shuffled = namedIr();
    shuffled.nodes.reverse();
    const b = await prepare(reorderKeys(shuffled));
    expect(renderArchitectureHtml(b.v, b.layout, { audience: 'private' })).toBe(
      renderArchitectureHtml(a.v, a.layout, { audience: 'private' }),
    );
  });
});

describe('stableStringify', () => {
  it('키 순서와 무관하게 같은 문자열을 낸다', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe(
      stableStringify({ a: { d: [1, { x: 1, y: 2 }] }, b: 1 }),
    );
  });
});

describe('renderDrilldownHtml', () => {
  function drillIr(): ArchitectureIr {
    const n = (
      id: string,
      kind: ArchitectureNode['kind'],
      parent?: string,
      evidence: Evidence[] = [codeEv],
    ): ArchitectureNode => ({
      id,
      kind,
      label: id,
      repo: 'web',
      evidence,
      ...(parent ? { parent } : {}),
    });
    const e = (
      id: string,
      from: string,
      to: string,
      kind: ArchitectureEdge['kind'],
    ): ArchitectureEdge => ({
      id,
      from,
      to,
      kind,
      evidence: [codeEv],
      lineStyle: 'solid',
    });
    return {
      ...makeIr(),
      nodes: [
        n('shop', 'service', undefined, [codeEv, privateEv]),
        n('orders', 'feature', 'shop'),
        n('list', 'screen', 'orders'),
        n('edge-gw', 'gateway'),
        n('ep', 'endpoint'),
        n('mod', 'app_module'),
      ],
      edges: [
        e('c1', 'list', 'ep', 'calls'),
        e('r1', 'edge-gw', 'ep', 'routes'),
        e('h1', 'ep', 'mod', 'handles'),
      ],
      unresolved: [],
    };
  }

  async function render(ir: ArchitectureIr, audience: 'private' | 'shared'): Promise<string> {
    const result = validateArchitectureIr(ir, { checkFiles: false });
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    return renderDrilldownHtml(result.value, await computeDrilldown(result.value), { audience });
  }

  it('레벨마다 SVG를 미리 그려 넣고 root만 보인다', async () => {
    const html = await render(drillIr(), 'private');
    for (const id of ['root', 'service:shop', 'feature:orders', 'server:edge-gw', 'server:mod']) {
      expect(html).toContain(`data-level-id="${id}"`);
    }
    expect(html).toMatch(
      /<section class="level" data-level-id="root" aria-label="전체" data-w="[\d.]+" data-h="[\d.]+" style="[^"]+"><svg class="links" id="canvas-0"/,
    );
    expect(html).toMatch(/data-level-id="service:shop" aria-label="shop"[^>]* hidden>/);
    expect(html).toContain('data-bundle-id="bundle:shop-&gt;edge-gw"');
    // 묶음 선은 건수를 알약으로 싣고 들어갈 레벨이 있는 카드에는 › 표시가 붙는다
    expect(html).toMatch(
      /<g class="pill" transform="translate\([\d.]+,[\d.]+\)"><rect [^>]+\/><text>1<\/text><\/g>/,
    );
    expect(html).toMatch(
      /data-node-id="shop" [^>]*>[\s\S]*?<span class="go" aria-hidden="true">›<\/span><\/div>/,
    );
    expect(html).toContain('id="crumbs"');
    expect(html).toContain('id="pair"');
    expect(html).not.toMatch(/<script[^>]+src=/);
  });

  it('화면 이동을 주소 해시에 싣고 해시가 바뀌면 그 화면으로 돌아간다', async () => {
    const html = await render(drillIr(), 'private');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    // 테마를 먼저 거는 head 스크립트와 본문 스크립트 둘이다
    expect(scripts).toHaveLength(2);
    // 템플릿 문자열 안에서 이스케이프가 빠지면 브라우저에서만 문법 오류가 난다
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
    const main = scripts[1]!;
    expect(main).toContain("window.addEventListener('hashchange', route)");
    expect(main).toContain("'#/level/'");
    expect(main).toContain("'#/pair/'");
    expect(main).toContain("'#/bundle/'");
    // 포커스도 해시에 실어야 뒤로가기가 포커스 전 화면으로 돌아간다
    expect(main).toContain("'#/focus/'");
    expect(html).toContain(
      '<section id="focus" class="level focus-view" aria-live="polite" hidden></section>',
    );
    expect(main).toContain('/^https?:\\/\\//i');
  });

  it('같은 입력이면 같은 바이트가 나온다', async () => {
    const shuffled = drillIr();
    shuffled.nodes.reverse();
    shuffled.edges.reverse();
    expect(await render(shuffled, 'private')).toBe(await render(drillIr(), 'private'));
    expect(await render(drillIr(), 'shared')).toBe(await render(drillIr(), 'shared'));
  });

  it('shared에는 private 근거 위치와 로컬 경로가 없다', async () => {
    const priv = await render(drillIr(), 'private');
    const shared = await render(drillIr(), 'shared');
    expect(priv).toContain(privateEv.location);
    expect(shared).not.toContain(privateEv.location);
    expect(priv).not.toContain('/srv/acme-web');
    expect(shared).not.toContain('/srv/acme-web');
  });

  it('레벨 제목과 빵부스러기, 묶음 이름에 표시 이름을 쓴다', async () => {
    const ir = drillIr();
    ir.nodes = ir.nodes.map((n) => {
      if (n.id === 'shop') return { ...n, displayName: '쇼핑' };
      if (n.id === 'orders') return { ...n, displayName: '주문 관리', displayNameInferred: true };
      return n;
    });
    const html = await render(ir, 'private');
    expect(html).toMatch(/data-level-id="service:shop" aria-label="쇼핑"[^>]* hidden>/);
    expect(html).toMatch(/data-level-id="feature:orders" aria-label="주문 관리"[^>]* hidden>/);
    // 빵부스러기는 레벨 title을 trail 순서로 이어 그린다
    expect(html).toContain(
      '"id":"feature:orders","kind":"feature","title":"주문 관리","trail":["root","service:shop","feature:orders"]',
    );
    expect(html).toContain('"id":"service:shop","kind":"service","title":"쇼핑"');
    expect(html).toContain('aria-label="쇼핑 → edge-gw');
    expect(html).toContain('<span class="t">주문 관리</span><span class="guess">추정</span>');
    expect(html).toContain('return { label: levels[t].title, level: t };');
    expect(html).toContain('function label(id) { return nodes[id] ? nameOf(nodes[id]) : id; }');
    expect(await render(ir, 'private')).toBe(html);
  });
});

describe('renderArchitectureHtml — 제품 띠', () => {
  it('그룹이 둘 이상이면 띠마다 구분선과 이름을 달고 카드에 띠 번호를 단다', async () => {
    const ir = makeIr();
    ir.groups = [
      { id: 'g1', name: '쇼핑', members: ['home', 'api', 'orphan'] },
      { id: 'g2', name: '운영', members: ['api', 'detail'] },
    ];
    const { v, layout } = await prepare(ir);
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(html).toContain('class="band-line"');
    expect(html).toContain('>같이 쓰는 카드</div>');
    expect(html).toContain('<i class="sw p-1"></i>운영 전용</div>');
    expect(html).toMatch(/data-node-id="api" data-band="0" data-products="0 1"/);
    expect(html).toMatch(/data-node-id="detail" data-band="2"/);
    expect(html).toContain('data-regions="[&quot;쇼핑&quot;,&quot;운영&quot;]"');
  });

  it('같이 쓰는 카드 위에 제품 브릭을 꽂고 폭을 넘치면 +N 버튼에 넘긴다', async () => {
    const ir = makeIr();
    const names = ['웨이팅', '파트너센터', 'POS', '예약', '쿠폰', '리뷰'];
    ir.groups = names.map((name, i) => ({
      id: `g${i}`,
      name,
      members: i === 0 ? ['api', 'home'] : i === 1 ? ['api', 'detail'] : ['api'],
    }));
    const { v, layout } = await prepare(ir);
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    const card = html.slice(html.indexOf('data-node-id="api"'));
    const bricks = card.slice(
      card.indexOf('<span class="pbricks"'),
      card.indexOf('</span></div>') + 7,
    );
    expect(card.slice(0, card.indexOf('>'))).toContain('data-products="0 1 2 3 4 5"');
    expect(bricks).toContain('<span class="pb p-0">웨이팅</span>');
    const shown = bricks.match(/class="pb p-\d"/g)!.length;
    expect(shown).toBeLessThan(names.length);
    expect(bricks).toContain(`>+${names.length - shown}</button>`);
    expect(bricks).toContain('aria-label="같이 쓰는 제품 6개 모두 보기"');
    expect(html).toMatch(/class="node k-[a-z_]+ shared/);
  });

  it('그룹이 없으면 띠를 안 그린다', async () => {
    const { v, layout } = await prepare(makeIr());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(html).not.toContain('class="band-line"');
    expect(html).not.toMatch(/data-band="\d/);
    expect(html).not.toContain('class="pbricks"');
  });
});

describe('카드 설명 줄과 클릭 대상 속성', () => {
  const XSS = '<img src=x onerror=alert(1)>설명 & "따옴표"';

  async function renderWithDescriptions(
    descriptions: Record<string, string | undefined>,
  ): Promise<{ html: string; layout: LayoutResult }> {
    const ir = makeIr();
    for (const n of ir.nodes) {
      const d = descriptions[n.id];
      if (d !== undefined) n.description = d;
    }
    const { v, layout } = await prepare(ir);
    return { html: renderArchitectureHtml(v, layout, { audience: 'private' }), layout };
  }

  function cardTag(html: string, id: string): string {
    const m = html.match(new RegExp(`<div class="node[^"]*" data-node-id="${id}"[^>]*>`));
    if (!m) throw new Error(`card ${id} not found`);
    return m[0];
  }

  function cardBlock(html: string, id: string): string {
    const start = html.indexOf(`data-node-id="${id}"`);
    const end = html.indexOf('</div>', start);
    return html.slice(start, end);
  }

  it('description을 .ds 줄에 escape해서 싣고 날 태그는 안 남는다', async () => {
    const { html } = await renderWithDescriptions({ home: XSS });
    expect(cardBlock(html, 'home')).toContain(
      '<span class="ds">&lt;img src=x onerror=alert(1)&gt;설명 &amp; &quot;따옴표&quot;</span>',
    );
    // 페이로드 JSON은 스크립트 안의 데이터라 마크업으로 해석되지 않는다. 스크립트 밖에 날 태그가 없으면 된다
    const markup = html.replace(/<script[\s\S]*?<\/script>/g, '');
    expect(markup).not.toContain('<img');
  });

  it('툴팁(title)에 설명 전체가 들어간다', async () => {
    const long = '주문 목록을 한 번에 불러오는 조회예요. 페이지 수와 정렬을 쿼리로 받아요.';
    const { html } = await renderWithDescriptions({ api: long });
    expect(cardTag(html, 'api')).toMatch(/title="[^"]*페이지 수와 정렬을 쿼리로 받아요\./);
  });

  it('description이 없거나 공백뿐인 카드에는 .ds가 없다', async () => {
    const { html } = await renderWithDescriptions({ home: '짧은 설명이에요.', detail: '   ' });
    expect(cardBlock(html, 'home')).toContain('class="ds"');
    expect(cardBlock(html, 'api')).not.toContain('class="ds"');
    expect(cardBlock(html, 'detail')).not.toContain('class="ds"');
    expect(cardTag(html, 'detail')).not.toContain('\n   ');
  });

  it('카드 style의 height는 layout이 낸 높이와 같고 설명이 있으면 18 더 높다', async () => {
    const plain = await renderWithDescriptions({});
    const withDesc = await renderWithDescriptions({ home: '짧은 설명이에요.' });
    const heightOf = (html: string, id: string): number =>
      Number(cardTag(html, id).match(/height:([\d.]+)px/)![1]);
    const layoutH = (l: LayoutResult, id: string): number =>
      l.nodes.find((n) => n.id === id)!.height;
    expect(heightOf(withDesc.html, 'home')).toBe(layoutH(withDesc.layout, 'home'));
    expect(heightOf(withDesc.html, 'home')).toBe(heightOf(plain.html, 'home') + 18);
    expect(heightOf(withDesc.html, 'api')).toBe(heightOf(plain.html, 'api'));
  });

  it('일반 엣지 g에 data-link-id, role, tabindex, aria-label이 있다', async () => {
    const { html } = await renderWithDescriptions({});
    const g = html.match(/<g class="link e-calls[^>]*data-link-id="e-code"[^>]*>/);
    expect(g).not.toBeNull();
    expect(g![0]).toContain('role="button"');
    expect(g![0]).toContain('tabindex="0"');
    expect(g![0]).toMatch(/aria-label="[^"]+"/);
    // 안쪽 path의 data-edge-id 계약은 그대로다
    expect(edgeTag(html, 'e-code')).toContain('data-edge-id="e-code"');
  });

  it('묶음 엣지에는 data-link-id가 없고 data-bundle-id만 있다', async () => {
    const { webIr } = await import('../../fixtures/architecture-legacy/irs.js');
    const { renderBoth } = await import('../../fixtures/architecture-legacy/render.js');
    const html = (await renderBoth(webIr())).private;
    const bundles = html.match(/<g class="link bundle[^>]*>/g) ?? [];
    expect(bundles.length).toBeGreaterThan(0);
    for (const b of bundles) {
      expect(b).toContain('data-bundle-id=');
      expect(b).not.toContain('data-link-id');
    }
    const normals = html.match(/<g class="link e-[^>]*>/g) ?? [];
    expect(normals.length).toBeGreaterThan(0);
    for (const g of normals) expect(g).toContain('data-link-id=');
  });

  it('레인 제목에 data-lane-id, role, tabindex, aria-label이 있다', async () => {
    const { html } = await renderWithDescriptions({});
    const titles = html.match(/<div class="lane-title"[^>]*>/g) ?? [];
    expect(titles.length).toBeGreaterThan(0);
    for (const t of titles) {
      expect(t).toMatch(/data-lane-id="[^"]+"/);
      expect(t).toContain('role="button"');
      expect(t).toContain('tabindex="0"');
      expect(t).toMatch(/aria-label="[^"]+ 레인, 카드 \d+개"/);
    }
  });

  it('쓰는 팩의 about만 스크립트에 싣고 안 쓰는 팩 문장은 뺀다', async () => {
    const { orderDataflowIr } =
      await import('../../fixtures/architecture-categories/projection-shapes.js');
    const { renderBoth } = await import('../../fixtures/architecture-legacy/render.js');
    const generic = (await renderBoth(orderDataflowIr())).private;
    expect(generic).toContain('맞는 종류가 없어 범용으로 그린 구성 요소예요.');
    // harness, web-product, data 팩 문장은 generic 그림에 실리지 않는다
    expect(generic).not.toContain('AI가 MCP 서버에 보내는 명령이에요');
    expect(generic).not.toContain('서버가 테이블이나 저장소를 읽고 쓰는 연결이에요');
    expect(generic).not.toContain('데이터가 처음 생기는 원천이 서는 칸이에요');

    const { harnessIr } = await import('../../fixtures/architecture-legacy/irs.js');
    const harness = (await renderBoth(harnessIr())).private;
    expect(harness).toContain('AI가 MCP 서버에 보내는 명령이에요');
    expect(harness).not.toContain('데이터가 처음 생기는 원천이 서는 칸이에요');
  });

  it('클라이언트 스크립트에 서랍 함수와 문구 조각이 실린다', async () => {
    const { html } = await renderWithDescriptions({});
    for (const piece of [
      'renderEdgePanel',
      'renderLanePanel',
      '들어오는 연결',
      '나가는 연결',
      '이 종류는',
    ]) {
      expect(html).toContain(piece);
    }
  });
});
