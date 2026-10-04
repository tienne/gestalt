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
  'infra/serving.ts': [
    '// acme-shop 웹 서빙 스택. 계정 ID는 지어낸 값이다',
    "const PROD_ACCOUNT = '000000000000';",
    "const DEV_ACCOUNT = '111111111111';",
    "const prodStack = new Stack(app, 'ShopProd', { env: { account: PROD_ACCOUNT } });",
    "const devStack = new Stack(app, 'ShopDev', { env: { account: DEV_ACCOUNT } });",
    "export const prodBucket = new Bucket(prodStack, 'Web', { bucketName: 'acme-shop-prod-web' });",
    "export const prodCdn = new Distribution(prodStack, 'Cdn', {",
    '  defaultBehavior: { origin: new S3Origin(prodBucket) },',
    "  domainNames: ['shop.example.com'],",
    '});',
    "export const devBucket = new Bucket(devStack, 'Web', { bucketName: 'acme-shop-dev-web' });",
    "export const devCdn = new Distribution(prodStack, 'DevCdn', {",
    '  defaultBehavior: { origin: new S3Origin(devBucket) },',
    '});',
    '',
  ].join('\n'),
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

  describe('서빙 인프라와 live 근거', () => {
    const AWS = JSON.parse(
      readFileSync(resolve('tests/fixtures/architecture-aws/responses.json'), 'utf-8'),
    ) as Record<string, unknown>;
    const OBSERVED_AT = '2026-01-02T03:04:05Z';
    const serving = 'infra/serving.ts';

    /** 세션 역할: 읽기 전용 명령을 돌린 기록. 응답 원문은 근거에 싣지 않는다 */
    const live = (command: string, location: string): Evidence => {
      expect(AWS[command]).toBeDefined();
      return { type: 'live', location, command, observedAt: OBSERVED_AT, visibility: 'private' };
    };
    const account = (profile: string): string =>
      (AWS[`aws sts get-caller-identity --profile ${profile}`] as { Account: string }).Account;
    const distributions = (): { Id: string; Aliases: { Items: string[] } }[] =>
      (
        AWS['aws cloudfront list-distributions --profile acme-prod'] as {
          DistributionList: { Items: { Id: string; Aliases: { Items: string[] } }[] };
        }
      ).DistributionList.Items;
    const distLabel = (alias: string): string =>
      distributions().find((d) => d.Aliases.Items.includes(alias))!.Id;
    const LIST_DIST = 'aws cloudfront list-distributions --profile acme-prod';

    function infraNodes(): ArchitectureNode[] {
      const infra = (
        id: string,
        kind: ArchitectureNode['kind'],
        label: string,
        evidence: Evidence[],
        extra: Partial<ArchitectureNode>,
      ): ArchitectureNode => ({ ...node(id, kind, label, 'web', evidence), ...extra });
      return [
        infra(
          'acct-prod',
          'cloud_account',
          account('acme-prod'),
          [live('aws sts get-caller-identity --profile acme-prod', 'aws:sts')],
          {},
        ),
        infra(
          'acct-dev',
          'cloud_account',
          account('acme-dev'),
          [live('aws sts get-caller-identity --profile acme-dev', 'aws:sts')],
          {},
        ),
        infra(
          'b-prod',
          'bucket',
          'acme-shop-prod-web',
          [code('web', serving, "bucketName: 'acme-shop-prod-web'")],
          {
            environment: 'prod',
            account: 'acct-prod',
          },
        ),
        infra(
          'b-dev',
          'bucket',
          'acme-shop-dev-web',
          [code('web', serving, "bucketName: 'acme-shop-dev-web'")],
          {
            environment: 'dev',
            account: 'acct-dev',
          },
        ),
        infra(
          'cdn-prod',
          'cdn',
          distLabel('shop.example.com'),
          [
            code('web', serving, "new Distribution(prodStack, 'Cdn'"),
            live(LIST_DIST, 'aws:cloudfront'),
          ],
          { environment: 'prod', account: 'acct-prod' },
        ),
        infra(
          'cdn-dev',
          'cdn',
          distLabel('shop.dev.example.com'),
          [code('web', serving, "new Distribution(prodStack, 'DevCdn'")],
          { environment: 'dev', account: 'acct-prod' },
        ),
        infra(
          'd-prod',
          'domain',
          'shop.example.com',
          [code('web', serving, "domainNames: ['shop.example.com']")],
          {
            environment: 'prod',
          },
        ),
        infra('d-dev', 'domain', 'shop.dev.example.com', [live(LIST_DIST, 'aws:cloudfront')], {
          environment: 'dev',
        }),
      ];
    }

    function infraEdges(): ArchitectureEdge[] {
      return [
        edge('o-prod', 'cdn-prod', 'b-prod', 'origin', [
          code('web', serving, 'origin: new S3Origin(prodBucket)'),
        ]),
        // 코드도 있고 조회도 했다. 실선이다
        edge('o-dev', 'cdn-dev', 'b-dev', 'origin', [
          code('web', serving, 'origin: new S3Origin(devBucket)'),
          live(LIST_DIST, 'aws:cloudfront'),
        ]),
        edge('rs-prod', 'd-prod', 'cdn-prod', 'resolves_to', [
          code('web', serving, "domainNames: ['shop.example.com']"),
        ]),
        // dev 도메인은 코드에 없고 조회로만 확인했다. 점선이다
        edge('rs-dev', 'd-dev', 'cdn-dev', 'resolves_to', [live(LIST_DIST, 'aws:cloudfront')]),
      ];
    }

    function buildServing(): ArchitectureIr {
      const ir = buildDrilldown();
      return {
        ...ir,
        nodes: [
          ...ir.nodes.map((n) =>
            n.id === 'svc-shop' ? { ...n, platforms: ['web' as const, 'android' as const] } : n,
          ),
          ...infraNodes(),
        ],
        edges: [
          ...ir.edges,
          ...infraEdges(),
          edge('sv-prod', 'b-prod', 'svc-shop', 'serves', [
            code('web', '.github/workflows/deploy.yml', 'name: deploy-web'),
          ]),
          edge('sv-dev', 'b-dev', 'svc-shop', 'serves', [
            live('aws s3api list-buckets --profile acme-dev', 'aws:s3'),
          ]),
        ],
      };
    }

    /** 서비스에 안 붙는 인프라(에셋 버킷)는 배포 경로의 인프라 레인에만 선다 */
    function buildDeployInfra(): ArchitectureIr {
      const ir = buildDeployPath();
      return {
        ...ir,
        nodes: [
          ...ir.nodes,
          ...infraNodes(),
          node('b-assets', 'bucket', 'acme-assets-prod', 'web', [
            live(LIST_DIST, 'aws:cloudfront'),
          ]),
          {
            ...node('cdn-assets', 'cdn', distLabel('assets.example.com'), 'web', [
              live(LIST_DIST, 'aws:cloudfront'),
            ]),
            environment: 'prod',
          },
        ],
        edges: [
          ...ir.edges,
          ...infraEdges(),
          edge('dep-prod', 'art-dist', 'b-prod', 'deploys_to', [
            code('web', '.github/workflows/deploy.yml', 'name: deploy-web'),
          ]),
          edge('o-assets', 'cdn-assets', 'b-assets', 'origin', [live(LIST_DIST, 'aws:cloudfront')]),
        ],
      };
    }

    function sectionOf(html: string, levelId: string): string {
      const start = html.indexOf(`data-level-id="${levelId}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      return html.slice(start, html.indexOf('</section>', start));
    }

    function laneTitles(section: string): string[] {
      return [...section.matchAll(/<div class="lane-title"[^>]*>([^<]+)</g)].map((m) => m[1]!);
    }

    it('서비스 레벨이 도메인부터 서버까지 레인을 잇고 전체 화면 카드에 플랫폼과 prod 도메인을 싣는다', async () => {
      const out = await render(buildServing());
      expect(out.ok).toBe(true);
      const html = readFileSync(out.htmlPath, 'utf-8');
      expect(laneTitles(sectionOf(html, 'service:svc-shop'))).toEqual([
        '도메인',
        'CDN',
        '버킷',
        '기능 영역',
        '게이트웨이',
        '서버',
      ]);
      const root = sectionOf(html, 'root');
      const card = root.slice(root.indexOf('data-node-id="svc-shop"'));
      expect(card).toContain('aria-label="정적 웹 (버킷과 CDN)"');
      expect(card).toContain('<span class="tc dom">shop.example.com</span>');
      // android는 근거가 없어서 칩 대신 질문으로 간다
      expect(card.slice(0, card.indexOf('</div>'))).not.toContain('Android 앱');
      expect(html).toContain('Android 앱으로 배포한다는 근거를 못 찾았어요');
    });

    it('live만 있는 연결은 점선, 코드와 함께면 실선이고 계정을 넘는 선은 색이 다르다', async () => {
      const out = await render(buildServing());
      const section = sectionOf(readFileSync(out.htmlPath, 'utf-8'), 'service:svc-shop');
      const linkOf = (from: string, to: string): string => {
        const at = section.indexOf(`data-from="${from}" data-to="${to}"`);
        expect(at).toBeGreaterThanOrEqual(0);
        return section.slice(
          section.lastIndexOf('<g class="link', at),
          section.indexOf('</g>', at),
        );
      };
      expect(linkOf('d-dev', 'cdn-dev')).toContain('stroke-dasharray');
      expect(linkOf('cdn-dev', 'b-dev')).not.toContain('stroke-dasharray');
      expect(linkOf('cdn-dev', 'b-dev')).toContain('x-account');
      expect(linkOf('cdn-prod', 'b-prod')).not.toContain('x-account');
    });

    it('공유본에서 계정 ID, 배포 ID, 조회 명령을 가리고 다시 그려도 같은 바이트다', async () => {
      const out = await render(buildServing());
      const privateHtml = readFileSync(out.htmlPath, 'utf-8');
      const shared = readFileSync(out.sharedHtmlPath, 'utf-8');
      expect(privateHtml).toContain(LIST_DIST);
      for (const secret of [
        account('acme-prod'),
        account('acme-dev'),
        distLabel('shop.example.com'),
        LIST_DIST,
      ]) {
        expect(shared).not.toContain(secret);
      }
      expect(shared).toContain(OBSERVED_AT);
      const again = await render(buildServing());
      expect(readFileSync(again.htmlPath, 'utf-8')).toBe(privateHtml);
      expect(readFileSync(again.sharedHtmlPath, 'utf-8')).toBe(shared);
    });

    it('배포 경로에 버킷, CDN, 도메인 레인이 붙고 서비스에 안 붙는 인프라도 선다', async () => {
      const ir = buildDeployInfra();
      const out = await render(ir);
      expect(out.ok).toBe(true);
      const html = readFileSync(out.htmlPath, 'utf-8');
      const titles = laneTitles(html);
      expect(titles.slice(titles.indexOf('버킷'))).toEqual([
        '버킷',
        'CDN',
        '도메인',
        '클라우드 계정',
      ]);
      expect(edgeIdsInSvg(html)).toEqual(ir.edges.map((e) => e.id).sort());
      expect(html).toContain('data-node-id="b-assets"');
      expect(pathOfEdge(html, 'o-assets')).toContain('stroke-dasharray');
    });

    it('읽기 전용이 아닌 명령을 근거로 쓰면 render를 거부한다', async () => {
      const ir = buildServing();
      ir.nodes = ir.nodes.map((n) =>
        n.id === 'cdn-prod'
          ? {
              ...n,
              evidence: [
                {
                  ...live(LIST_DIST, 'aws:cloudfront'),
                  command: 'aws s3 rm s3://acme-shop-prod-web --recursive',
                },
              ],
            }
          : n,
      );
      const out = await render(ir);
      expect(out.ok).toBe(false);
      expect(out.errors).toEqual([expect.objectContaining({ code: 'LIVE_COMMAND_NOT_READ_ONLY' })]);
    });
  });
});
