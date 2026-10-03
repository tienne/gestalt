import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchEndpoints } from '../../src/architecture/endpoint-match.js';
import type {
  ArchitectureEdge,
  ArchitectureIr,
  ArchitectureNode,
  ArchitectureView,
  Evidence,
  UnresolvedQuestion,
} from '../../src/architecture/types.js';
import { handleArchitecturePassthrough } from '../../src/mcp/tools/architecture-passthrough.js';

// 세션이 FE와 BE 레포를 읽고 IR을 만든 뒤 render까지 가는 흐름을 가짜 레포 두 개로 재현한다

const WEB_FILES: Record<string, string> = {
  'src/pages/orders/[id].tsx': [
    "import { useParams } from 'react-router-dom';",
    '',
    'const API_BASE = import.meta.env.API_BASE;',
    '',
    'export default function OrderDetailPage() {',
    '  const { id } = useParams();',
    '  const load = () => fetch(`${API_BASE}/api/v1/orders/${id}`);',
    '  return <button onClick={load}>주문 보기</button>;',
    '}',
    '',
  ].join('\n'),
  'src/pages/cart.tsx': [
    'const API_BASE = import.meta.env.API_BASE;',
    '',
    'export default function CartPage() {',
    '  const add = (sku: string) =>',
    "    fetch(`${API_BASE}/api/v1/cart/items`, { method: 'POST', body: JSON.stringify({ sku }) });",
    "  return <button onClick={() => add('widget')}>담기</button>;",
    '}',
    '',
  ].join('\n'),
  'src/app.tsx': [
    "import { BrowserRouter, Route, Routes } from 'react-router-dom';",
    '',
    'export function AcmeShopApp() {',
    '  return (',
    '    <BrowserRouter>',
    '      <Routes>',
    '        {/* orders 기능영역 */}',
    '        <Route path="/orders/:id" element={<OrderDetailPage />} />',
    '        {/* cart 기능영역 */}',
    '        <Route path="/cart" element={<CartPage />} />',
    '      </Routes>',
    '    </BrowserRouter>',
    '  );',
    '}',
    '',
  ].join('\n'),
  'src/pages/cart-link.tsx': [
    "import { Link } from 'react-router-dom';",
    '',
    'export const ToOrder = ({ id }: { id: string }) => <Link to={`/orders/${id}`}>주문</Link>;',
    '',
  ].join('\n'),
  '.env.example': 'API_BASE=https://api.acme.test\n',
  '.github/workflows/deploy.yml': [
    'name: deploy-web',
    'on:',
    '  push:',
    '    branches: [main]',
    'jobs:',
    '  build:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: pnpm build',
    '      - uses: actions/upload-artifact@v4',
    '        with:',
    '          name: dist',
    '          path: dist',
    '  publish:',
    '    needs: build',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: aws s3 sync dist s3://acme-web-cdn',
    '',
  ].join('\n'),
};

const API_FILES: Record<string, string> = {
  'gateway/routes.yaml': [
    'routes:',
    '  - id: orders',
    '    path: /api/v1/orders/**',
    '    uri: http://acme-api:8080',
    '  - id: cart',
    '    path: /api/v1/cart/**',
    '    uri: http://acme-api:8080',
    '',
  ].join('\n'),
  'src/orders/orders.controller.ts': [
    "import { Controller, Get, Param } from '@nestjs/common';",
    "import { OrdersService } from './orders.service';",
    '',
    "@Controller('api/v1/orders')",
    'export class OrdersController {',
    '  constructor(private readonly orders: OrdersService) {}',
    '',
    "  @Get(':orderId')",
    "  find(@Param('orderId') orderId: string) {",
    '    return this.orders.find(orderId);',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/cart/cart.controller.ts': [
    "import { Body, Controller, Post } from '@nestjs/common';",
    '',
    "@Controller('api/v1/cart')",
    'export class CartController {',
    "  @Post('items')",
    '  add(@Body() body: { sku: string }) {',
    '    return { added: body.sku };',
    '  }',
    '}',
    '',
  ].join('\n'),
  'src/orders/orders.service.ts': [
    "import { Injectable } from '@nestjs/common';",
    '',
    '@Injectable()',
    'export class OrdersService {',
    '  async find(orderId: string) {',
    "    const row = await this.db.query('SELECT * FROM orders WHERE id = $1', [orderId]);",
    "    await fetch('https://payment-gateway.acme.test/v1/payments/' + row.paymentId);",
    '    return row;',
    '  }',
    '}',
    '',
  ].join('\n'),
  Dockerfile: [
    'FROM node:22-alpine',
    'WORKDIR /app',
    'COPY . .',
    'RUN pnpm install && pnpm build',
    'CMD ["node", "dist/main.js"]',
    '',
  ].join('\n'),
  '.github/workflows/build.yml': [
    'name: build-api',
    'on:',
    '  push:',
    "    tags: ['v*']",
    'jobs:',
    '  image:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '      - run: docker build -t registry.acme.test/acme-api:${{ github.ref_name }} .',
    '      - run: docker push registry.acme.test/acme-api:${{ github.ref_name }}',
    '      - run: kubectl --context acme-prod set image deploy/acme-api api=registry.acme.test/acme-api:${{ github.ref_name }}',
    '',
  ].join('\n'),
};

const PRIVATE_DOC_URL = 'https://wiki.acme.test/deploy';
const GENERATED_AT = '2026-01-01T00:00:00.000Z';

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** 세션이 grep으로 줄을 찾는 것처럼 파일 내용에서 needle이 처음 나오는 줄 번호를 계산한다 */
function lineOf(root: string, rel: string, needle: string): number {
  const content = readFileSync(join(root, rel), 'utf-8');
  const at = content.indexOf(needle);
  if (at < 0) throw new Error(`${rel}에 "${needle}"가 없다`);
  return content.slice(0, at).split('\n').length;
}

function svgOf(html: string): string {
  const start = html.indexOf('<svg class="links" id="canvas"');
  const end = html.indexOf('</svg>', start);
  expect(start).toBeGreaterThanOrEqual(0);
  return html.slice(start, end);
}

function edgeIdsInSvg(html: string): string[] {
  return [...svgOf(html).matchAll(/data-edge-id="([^"]+)"/g)].map((m) => m[1]!).sort();
}

function pathOfEdge(html: string, edgeId: string): string {
  const svg = svgOf(html);
  const at = svg.indexOf(`data-edge-id="${edgeId}"`);
  expect(at).toBeGreaterThanOrEqual(0);
  const start = svg.lastIndexOf('<path', at);
  return svg.slice(start, svg.indexOf('>', at) + 1);
}

describe('architecture e2e — 가짜 FE와 BE 레포에서 뷰 두 개 렌더', () => {
  let base: string;
  let webRoot: string;
  let apiRoot: string;

  const code = (repo: 'web' | 'api', rel: string, needle: string): Evidence => ({
    type: 'code',
    location: `${repo}:${rel}:${lineOf(repo === 'web' ? webRoot : apiRoot, rel, needle)}`,
    visibility: 'public',
  });

  const node = (
    id: string,
    kind: ArchitectureNode['kind'],
    label: string,
    repo: string,
    evidence: Evidence[],
  ): ArchitectureNode => ({ id, kind, label, repo, evidence });

  const edge = (
    id: string,
    from: string,
    to: string,
    kind: ArchitectureEdge['kind'],
    evidence: Evidence[],
  ): ArchitectureEdge => ({
    id,
    from,
    to,
    kind,
    evidence,
    lineStyle: evidence.some((e) => e.type === 'code' || e.type === 'spec') ? 'solid' : 'dashed',
  });

  const irOf = (
    view: ArchitectureView,
    nodes: ArchitectureNode[],
    edges: ArchitectureEdge[],
    unresolved: UnresolvedQuestion[] = [],
  ): ArchitectureIr => ({
    schemaVersion: '1.0.0',
    view,
    repos: [
      { id: 'web', name: 'acme-web', root: 'acme-web' },
      { id: 'api', name: 'acme-api', root: 'acme-api' },
    ],
    nodes,
    edges,
    unresolved,
    sourcesUsed: [
      { via: 'repo', identifier: 'acme-web', readOnly: true, probeHit: true, visibility: 'public' },
      { via: 'repo', identifier: 'acme-api', readOnly: true, probeHit: true, visibility: 'public' },
      {
        via: 'mcp',
        identifier: 'wiki_get_page',
        readOnly: true,
        probeHit: true,
        visibility: 'private',
      },
    ],
    generatedAt: GENERATED_AT,
  });

  /** 세션 역할: FE 호출과 BE 라우트를 뽑아 matchEndpoints로 잇고 뷰① IR을 만든다 */
  function buildScreenChain(): {
    ir: ArchitectureIr;
    matches: ReturnType<typeof matchEndpoints>;
  } {
    const apiBase = readFileSync(join(webRoot, '.env.example'), 'utf-8')
      .split('\n')
      .find((l) => l.startsWith('API_BASE='))!
      .slice('API_BASE='.length);

    const matches = matchEndpoints({
      feCalls: [
        { id: 'call:orders', method: 'GET', path: `${apiBase}/api/v1/orders/\${id}` },
        { id: 'call:cart', method: 'post', path: `${apiBase}/api/v1/cart/items` },
      ],
      beRoutes: [
        { id: 'ep-order', method: 'GET', path: '/api/v1/orders/:orderId', repo: 'api' },
        { id: 'ep-cart', method: 'POST', path: '/api/v1/cart/items', repo: 'api' },
      ],
    });

    const screenOfCall: Record<string, string> = {
      'call:orders': 'scr-order',
      'call:cart': 'scr-cart',
    };
    const callEvidence: Record<string, Evidence> = {
      'call:orders': code('web', 'src/pages/orders/[id].tsx', 'fetch(`${API_BASE}/api/v1/orders/'),
      'call:cart': code('web', 'src/pages/cart.tsx', 'fetch(`${API_BASE}/api/v1/cart/items`'),
    };
    const callEdges = matches.matches.map((m) =>
      edge(
        `calls-${screenOfCall[m.feCallId]!}-${m.beRouteId}`,
        screenOfCall[m.feCallId]!,
        m.beRouteId,
        'calls',
        [callEvidence[m.feCallId]!],
      ),
    );

    const ordersCtl = 'src/orders/orders.controller.ts';
    const cartCtl = 'src/cart/cart.controller.ts';
    const ordersSvc = 'src/orders/orders.service.ts';

    const nodes = [
      node('scr-order', 'screen', 'OrderDetailPage', 'web', [
        code('web', 'src/pages/orders/[id].tsx', 'export default function OrderDetailPage'),
      ]),
      node('scr-cart', 'screen', 'CartPage', 'web', [
        code('web', 'src/pages/cart.tsx', 'export default function CartPage'),
      ]),
      node('ep-order', 'endpoint', 'GET /api/v1/orders/{orderId}', 'api', [
        code('api', ordersCtl, "@Get(':orderId')"),
      ]),
      node('ep-cart', 'endpoint', 'POST /api/v1/cart/items', 'api', [
        code('api', cartCtl, "@Post('items')"),
      ]),
      node('mod-orders', 'app_module', 'OrdersService', 'api', [
        code('api', ordersSvc, 'export class OrdersService'),
      ]),
      node('mod-cart', 'app_module', 'CartController', 'api', [
        code('api', cartCtl, 'export class CartController'),
      ]),
      node('ext-payment', 'external_service', 'payment-gateway', 'api', [
        code('api', ordersSvc, 'payment-gateway.acme.test'),
      ]),
      node('db-orders', 'db_table', 'orders', 'api', [code('api', ordersSvc, 'FROM orders')]),
    ];
    const edges = [
      ...callEdges,
      edge('handles-order', 'ep-order', 'mod-orders', 'handles', [
        code('api', ordersCtl, 'return this.orders.find(orderId)'),
      ]),
      edge('handles-cart', 'ep-cart', 'mod-cart', 'handles', [code('api', cartCtl, 'add(@Body()')]),
      edge('uses-payment', 'mod-orders', 'ext-payment', 'uses', [
        code('api', ordersSvc, "await fetch('https://payment-gateway"),
      ]),
      edge('rw-orders', 'mod-orders', 'db-orders', 'reads_writes', [
        code('api', ordersSvc, 'SELECT * FROM orders'),
      ]),
      // 세션이 근거를 못 찾은 연결. 점선에 근거 0개면 그리지 않고 미해결로 돌아가야 한다
      edge('uses-cart-payment', 'mod-cart', 'ext-payment', 'uses', []),
    ];
    return { ir: irOf('screen-chain', nodes, edges), matches };
  }

  function buildDeployPath(): ArchitectureIr {
    const webWf = '.github/workflows/deploy.yml';
    const apiWf = '.github/workflows/build.yml';
    const nodes = [
      node('wf-web', 'workflow', 'deploy-web', 'web', [code('web', webWf, 'name: deploy-web')]),
      node('wf-api', 'workflow', 'build-api', 'api', [code('api', apiWf, 'name: build-api')]),
      node('build-web', 'build', 'pnpm build', 'web', [code('web', webWf, 'run: pnpm build')]),
      node('build-api', 'build', 'docker build', 'api', [code('api', apiWf, 'docker build')]),
      node('art-dist', 'artifact', 'dist', 'web', [code('web', webWf, 'name: dist')]),
      node('art-image', 'artifact', 'acme-api image', 'api', [code('api', apiWf, 'docker push')]),
      node('dt-cdn', 'deploy_target', 'acme-web-cdn', 'web', [
        code('web', webWf, 's3://acme-web-cdn'),
      ]),
      node('dt-k8s', 'deploy_target', 'acme-prod cluster', 'api', [
        code('api', apiWf, 'kubectl --context acme-prod'),
      ]),
    ];
    const edges = [
      edge('trg-web', 'wf-web', 'build-web', 'triggers', [code('web', webWf, 'branches: [main]')]),
      edge('trg-api', 'wf-api', 'build-api', 'triggers', [code('api', apiWf, "tags: ['v*']")]),
      edge('prod-dist', 'build-web', 'art-dist', 'produces', [
        code('web', webWf, 'uses: actions/upload-artifact'),
      ]),
      edge('prod-image', 'build-api', 'art-image', 'produces', [
        code('api', 'Dockerfile', 'RUN pnpm install && pnpm build'),
      ]),
      // 업로드 대상은 사내 위키에만 적혀 있다는 설정. doc 근거뿐이라 점선이어야 한다
      edge('dep-cdn', 'art-dist', 'dt-cdn', 'deploys_to', [
        { type: 'doc', location: PRIVATE_DOC_URL, visibility: 'private' },
      ]),
      edge('dep-k8s', 'art-image', 'dt-k8s', 'deploys_to', [code('api', apiWf, 'set image')]),
    ];
    return irOf('deploy-path', nodes, edges);
  }

  const render = async (ir: ArchitectureIr) =>
    (await handleArchitecturePassthrough({ action: 'render', repoRoot: base, ir })) as {
      ok: boolean;
      errors?: unknown[];
      irPath: string;
      htmlPath: string;
      sharedHtmlPath: string;
      stats: { nodes: number; edges: number; drawnEdges: number; droppedEdges: number };
    };

  beforeEach(() => {
    base = resolve(`.gestalt-test/arch-e2e-${randomUUID()}`);
    webRoot = join(base, 'acme-web');
    apiRoot = join(base, 'acme-api');
    writeFiles(webRoot, WEB_FILES);
    writeFiles(apiRoot, API_FILES);
  });

  afterEach(() => {
    if (existsSync(base)) rmSync(base, { recursive: true, force: true });
  });

  it('줄 번호는 하드코딩이 아니라 fixture 파일 내용에서 나온다', () => {
    const ev = code('api', 'src/orders/orders.controller.ts', "@Get(':orderId')");
    const line = Number(ev.location.split(':').pop());
    const lines = readFileSync(join(apiRoot, 'src/orders/orders.controller.ts'), 'utf-8').split(
      '\n',
    );
    expect(lines[line - 1]).toContain("@Get(':orderId')");
  });

  describe('뷰① screen-chain', () => {
    it('matchEndpoints가 FE 호출 두 개를 BE 라우트 두 개에 잇는다', () => {
      const { matches } = buildScreenChain();
      expect(matches.unmatched).toEqual([]);
      expect(matches.matches.map((m) => [m.feCallId, m.beRouteId])).toEqual([
        ['call:cart', 'ep-cart'],
        ['call:orders', 'ep-order'],
      ]);
    });

    it('validate가 근거 뺀 엣지를 그리기 대상에서 빼고 autoUnresolved로 돌린다', async () => {
      const { ir } = buildScreenChain();
      const result = (await handleArchitecturePassthrough({
        action: 'validate',
        repoRoot: base,
        ir,
      })) as {
        ok: boolean;
        autoUnresolved: UnresolvedQuestion[];
        drawable: { nodeIds: string[]; edgeIds: string[] };
      };
      expect(result.ok).toBe(true);
      expect(result.drawable.nodeIds).toHaveLength(8);
      expect(result.drawable.edgeIds).not.toContain('uses-cart-payment');
      expect(result.drawable.edgeIds).toHaveLength(6);
      expect(result.autoUnresolved.map((q) => q.subject.edgeId)).toEqual(['uses-cart-payment']);
    });

    it('render 결과에 노드 라벨이 전부 있고 엣지 수가 맞으며 근거 뺀 엣지는 SVG에 없다', async () => {
      const { ir } = buildScreenChain();
      const out = await render(ir);
      expect(out.ok).toBe(true);
      expect(out.stats).toMatchObject({ nodes: 8, edges: 7, drawnEdges: 6, droppedEdges: 1 });

      const html = readFileSync(out.htmlPath, 'utf-8');
      for (const n of ir.nodes) expect(html).toContain(n.label);
      const svgEdges = edgeIdsInSvg(html);
      expect(svgEdges).toHaveLength(6);
      expect(svgEdges).not.toContain('uses-cart-payment');

      const saved = JSON.parse(readFileSync(out.irPath, 'utf-8')) as ArchitectureIr;
      expect(saved.unresolved.map((q) => q.subject.edgeId)).toContain('uses-cart-payment');
    });

    it('같은 IR을 다시 render하면 HTML이 바이트 단위로 같다', async () => {
      const { ir } = buildScreenChain();
      const first = await render(ir);
      const htmlA = readFileSync(first.htmlPath);
      const sharedA = readFileSync(first.sharedHtmlPath);
      const second = await render(ir);
      expect(Buffer.compare(htmlA, readFileSync(second.htmlPath))).toBe(0);
      expect(Buffer.compare(sharedA, readFileSync(second.sharedHtmlPath))).toBe(0);
    });

    it('재실행에서 노드 id가 바뀌어 들어와도 이전 id를 물려받는다', async () => {
      const { ir } = buildScreenChain();
      await render(ir);

      const rename = (id: string) => `new-${id}`;
      const renamed: ArchitectureIr = {
        ...ir,
        nodes: ir.nodes.map((n) => ({ ...n, id: rename(n.id) })),
        edges: ir.edges.map((e) => ({ ...e, from: rename(e.from), to: rename(e.to) })),
      };
      const out = await render(renamed);
      expect(out.ok).toBe(true);
      const saved = JSON.parse(readFileSync(out.irPath, 'utf-8')) as ArchitectureIr;
      expect(saved.nodes.map((n) => n.id).sort()).toEqual(ir.nodes.map((n) => n.id).sort());
      const nodeIds = new Set(saved.nodes.map((n) => n.id));
      for (const e of saved.edges) {
        expect(nodeIds.has(e.from)).toBe(true);
        expect(nodeIds.has(e.to)).toBe(true);
      }
    });
  });

  describe('뷰① screen-chain 드릴다운', () => {
    /** 세션 역할: 앱 진입점에서 서비스와 기능영역을, 게이트웨이 설정에서 라우트를 찾아 IR에 더한다 */
    function buildDrilldown(): ArchitectureIr {
      const { ir } = buildScreenChain();
      const app = 'src/app.tsx';
      const gw = 'gateway/routes.yaml';
      const parentOf: Record<string, string> = {
        'scr-order': 'feat-orders',
        'scr-cart': 'feat-cart',
      };
      const nodes = [
        ...ir.nodes.map((n) => (parentOf[n.id] ? { ...n, parent: parentOf[n.id] } : n)),
        node('svc-shop', 'service', 'Acme Shop', 'web', [
          code('web', app, 'export function AcmeShopApp'),
          { type: 'doc', location: PRIVATE_DOC_URL, visibility: 'private' },
        ]),
        {
          ...node('feat-orders', 'feature', '주문', 'web', [code('web', app, 'orders 기능영역')]),
          parent: 'svc-shop',
        },
        {
          ...node('feat-cart', 'feature', '장바구니', 'web', [code('web', app, 'cart 기능영역')]),
          parent: 'svc-shop',
        },
        node('gw-edge', 'gateway', 'edge-gateway', 'api', [code('api', gw, 'routes:')]),
      ];
      const edges = [
        ...ir.edges,
        edge('routes-order', 'gw-edge', 'ep-order', 'routes', [
          code('api', gw, 'path: /api/v1/orders/**'),
        ]),
        edge('routes-cart', 'gw-edge', 'ep-cart', 'routes', [
          code('api', gw, 'path: /api/v1/cart/**'),
        ]),
        edge('nav-cart-order', 'scr-cart', 'scr-order', 'navigates', [
          code('web', 'src/pages/cart-link.tsx', '<Link to='),
        ]),
      ];
      return { ...ir, nodes, edges };
    }

    it('service가 그려지면 레벨별 SVG를 한 파일에 담고 levels 요약을 낸다', async () => {
      const out = (await render(buildDrilldown())) as Awaited<ReturnType<typeof render>> & {
        levels: { id: string; title: string; nodes: number; edges: number }[];
      };
      expect(out.ok).toBe(true);
      expect(out.levels.map((l) => l.id)).toEqual([
        'root',
        'feature:feat-cart',
        'feature:feat-orders',
        'server:gw-edge',
        'server:mod-cart',
        'server:mod-orders',
        'service:svc-shop',
      ]);
      // root: 서비스 → 게이트웨이 하나, 게이트웨이 → 모듈 둘
      expect(out.levels[0]).toEqual({ id: 'root', title: '전체', nodes: 4, edges: 3 });
      expect(out.levels.find((l) => l.id === 'service:svc-shop')).toMatchObject({
        nodes: 5,
        edges: 5,
      });
      expect(out.levels.find((l) => l.id === 'server:mod-orders')).toMatchObject({
        nodes: 4,
        edges: 3,
      });

      const html = readFileSync(out.htmlPath, 'utf-8');
      for (const l of out.levels) expect(html).toContain(`data-level-id="${l.id}"`);
      expect(html).toContain(PRIVATE_DOC_URL);
      const shared = readFileSync(out.sharedHtmlPath, 'utf-8');
      expect(shared).not.toContain(PRIVATE_DOC_URL);
      expect(shared).not.toContain(base);

      const again = await render(buildDrilldown());
      expect(readFileSync(again.htmlPath, 'utf-8')).toBe(html);
      expect(readFileSync(again.sharedHtmlPath, 'utf-8')).toBe(shared);
    });

    it('parent 포함 규칙을 어기면 render를 거부한다', async () => {
      const ir = buildDrilldown();
      ir.nodes = ir.nodes.map((n) => (n.id === 'ep-order' ? { ...n, parent: 'svc-shop' } : n));
      const out = await render(ir);
      expect(out.ok).toBe(false);
      expect(out.errors).toEqual([expect.objectContaining({ code: 'INVALID_PARENT_KIND' })]);
    });
  });

  describe('뷰② deploy-path', () => {
    it('render 결과에 노드 라벨이 전부 있고 엣지 여섯 개가 다 그려진다', async () => {
      const ir = buildDeployPath();
      const out = await render(ir);
      expect(out.ok).toBe(true);
      expect(out.stats).toMatchObject({ nodes: 8, edges: 6, drawnEdges: 6, droppedEdges: 0 });

      const html = readFileSync(out.htmlPath, 'utf-8');
      for (const n of ir.nodes) expect(html).toContain(n.label);
      expect(edgeIdsInSvg(html)).toEqual(ir.edges.map((e) => e.id).sort());
    });

    it('doc 근거만 있는 엣지는 점선이고 code 근거 엣지는 실선이다', async () => {
      const out = await render(buildDeployPath());
      const html = readFileSync(out.htmlPath, 'utf-8');
      expect(pathOfEdge(html, 'dep-cdn')).toContain('stroke-dasharray');
      expect(pathOfEdge(html, 'dep-k8s')).not.toContain('stroke-dasharray');
    });

    it('shared HTML에는 private 근거 위치가 없고 private HTML에는 있다', async () => {
      const out = await render(buildDeployPath());
      const privateHtml = readFileSync(out.htmlPath, 'utf-8');
      const sharedHtml = readFileSync(out.sharedHtmlPath, 'utf-8');
      expect(privateHtml).toContain(PRIVATE_DOC_URL);
      expect(sharedHtml).not.toContain(PRIVATE_DOC_URL);
      // public code 근거는 공유본에도 남는다
      expect(sharedHtml).toContain('web:.github/workflows/deploy.yml:');
    });

    it('같은 IR을 다시 render하면 HTML이 바이트 단위로 같다', async () => {
      const ir = buildDeployPath();
      const first = await render(ir);
      const htmlA = readFileSync(first.htmlPath);
      const second = await render(ir);
      expect(Buffer.compare(htmlA, readFileSync(second.htmlPath))).toBe(0);
    });
  });
});
