import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ArchitectureEdge,
  ArchitectureIr,
  ArchitectureNode,
} from '../../../src/architecture/types.js';
import { architectureInputSchema } from '../../../src/mcp/schemas.js';
import type { MergeReport } from '../../../src/architecture/merge.js';
import { FAKE_PASSWORD, FAKE_TOKEN } from '../architecture/fake-secrets.js';
import {
  handleArchitecturePassthrough,
  stopArchitectureLiveServers,
  type ArchitectureHandlerOptions,
} from '../../../src/mcp/tools/architecture-passthrough.js';
import type { LiveSessionBridge } from '../../../src/architecture/live-session.js';
import {
  resolveRepoVisibility,
  type RepoVisibility,
} from '../../../src/architecture/repo-visibility.js';

let tmpRoot: string;
let repoRoot: string;
let homeDir: string;

const PRIVATE_LOCATION = 'web:src/internal-notes.ts:1';

beforeEach(() => {
  tmpRoot = resolve('.gestalt-test', `architecture-pt-${randomUUID()}`);
  repoRoot = join(tmpRoot, 'acme-web');
  homeDir = join(tmpRoot, 'home');
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  mkdirSync(join(homeDir, '.claude', 'projects'), { recursive: true });
  writeFileSync(join(repoRoot, 'src/home.tsx'), 'a\nb\nc\nd\n');
  writeFileSync(join(repoRoot, 'src/orders.ts'), 'a\nb\nc\n');
  writeFileSync(join(repoRoot, 'src/internal-notes.ts'), 'a\n');
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function node(
  id: string,
  kind: ArchitectureNode['kind'],
  label: string,
  line = 1,
): ArchitectureNode {
  return {
    id,
    kind,
    label,
    repo: 'web',
    evidence: [{ type: 'code', location: `web:src/home.tsx:${line}`, visibility: 'public' }],
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: ArchitectureEdge['kind'],
): ArchitectureEdge {
  return {
    id,
    from,
    to,
    kind,
    lineStyle: 'solid',
    evidence: [{ type: 'code', location: 'web:src/orders.ts:2', visibility: 'public' }],
  };
}

function makeIr(prefix = 'n'): ArchitectureIr {
  const screen = node(`${prefix}-home`, 'screen', 'Home');
  screen.evidence.push({
    type: 'code',
    location: PRIVATE_LOCATION,
    visibility: 'private',
  });
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    // 상대 root가 서버 cwd가 아니라 repoRoot 기준으로 풀리는지 함께 본다
    repos: [{ id: 'web', name: 'acme-web', root: '.' }],
    nodes: [
      screen,
      node(`${prefix}-orders-api`, 'endpoint', 'GET /orders', 2),
      node(`${prefix}-orders-module`, 'app_module', 'OrdersModule', 3),
    ],
    edges: [
      edge(`${prefix}-e1`, `${prefix}-home`, `${prefix}-orders-api`, 'calls'),
      edge(`${prefix}-e2`, `${prefix}-orders-api`, `${prefix}-orders-module`, 'handles'),
    ],
    unresolved: [],
    sourcesUsed: [
      {
        via: 'repo',
        identifier: 'CLAUDE.md',
        readOnly: true,
        probeHit: true,
        visibility: 'public',
      },
    ],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// 기본은 비공개로 판정해 gh와 네트워크를 타지 않는다. 공개 여부를 보는 테스트만 바꿔 넣는다
const PRIVATE_REPO = (): RepoVisibility => ({
  verdict: 'private',
  source: 'gh',
  visibility: 'PRIVATE',
});

async function call(
  args: Record<string, unknown>,
  opts: ArchitectureHandlerOptions = {},
): Promise<Record<string, unknown>> {
  const input = architectureInputSchema.parse({ repoRoot, ...args });
  return (await handleArchitecturePassthrough(input, process.cwd(), {
    homeDir,
    projectsRoot: join(homeDir, '.claude', 'projects'),
    resolveVisibility: PRIVATE_REPO,
    ...opts,
  })) as Record<string, unknown>;
}

describe('ges_architecture validate', () => {
  it('근거 없는 실선 엣지를 거부한다', async () => {
    const ir = makeIr();
    ir.edges[0]!.evidence = [];
    const result = await call({ action: 'validate', ir });
    expect(result['ok']).toBe(false);
    const codes = (result['errors'] as Array<{ code: string }>).map((e) => e.code);
    expect(codes).toContain('SOLID_EDGE_WITHOUT_EVIDENCE');
  });

  it('통과하면 그릴 대상과 자동 질문을 돌려준다', async () => {
    const ir = makeIr();
    ir.nodes.push({
      id: 'n-ghost',
      kind: 'external_service',
      label: 'Ghost',
      repo: 'web',
      evidence: [],
    });
    const result = await call({ action: 'validate', ir });
    expect(result['ok']).toBe(true);
    expect(result['drawable']).toEqual({
      nodeIds: ['n-home', 'n-orders-api', 'n-orders-module'],
      edgeIds: ['n-e1', 'n-e2'],
    });
    expect((result['autoUnresolved'] as unknown[]).length).toBe(1);
  });

  it('통과하면 render와 같은 stats를 싣고 문턱 안이면 signals를 안 싣는다', async () => {
    const result = await call({ action: 'validate', ir: makeIr() });
    expect(result['ok']).toBe(true);
    expect(result['stats']).toMatchObject({
      nodes: 3,
      edges: 2,
      drawnEdges: 2,
      screenToEndpointRatio: 1,
      endpointMatchRatio: 1,
    });
    expect(result).not.toHaveProperty('signals');
  });

  it('엔드포인트를 부르는 화면이 60%가 안 되면 SCREEN_ENDPOINT_RATIO_LOW를 싣는다', async () => {
    const ir = makeIr();
    ir.nodes.push(node('n-about', 'screen', 'About', 1), node('n-faq', 'screen', 'Faq', 1));
    const result = await call({ action: 'validate', ir });
    expect(result['ok']).toBe(true);
    const signals = result['signals'] as Array<Record<string, unknown>>;
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ code: 'SCREEN_ENDPOINT_RATIO_LOW', threshold: 0.6 });
    expect(signals[0]!['value']).toBeCloseTo(1 / 3);
    expect(typeof signals[0]!['hint']).toBe('string');
  });

  it('screen-chain이 아니면 화면 비율 신호를 안 싣는다', async () => {
    const ir = makeIr();
    ir.nodes.push(node('n-about', 'screen', 'About', 1), node('n-faq', 'screen', 'Faq', 1));
    const result = await call({ action: 'validate', ir: { ...ir, view: 'deploy-path' } });
    expect(result['ok']).toBe(true);
    expect(result).not.toHaveProperty('signals');
  });

  it('작성 품질 경고를 warnings로 돌려주고 막지 않는다', async () => {
    const ir = makeIr();
    ir.nodes[2]!.label = 'src/orders/orders.module.ts';
    const result = await call({ action: 'validate', ir });
    expect(result['ok']).toBe(true);
    const warnings = result['warnings'] as Array<{ code: string; nodeIds?: string[] }>;
    const pathlike = warnings.find((w) => w.code === 'NODE_TITLE_PATHLIKE');
    expect(pathlike?.nodeIds).toEqual(['n-orders-module']);
  });

  it('형식이 깨진 IR은 IR_PARSE_ERROR', async () => {
    const result = await call({ action: 'validate', ir: { view: 'screen-chain' } });
    expect(result['ok']).toBe(false);
    expect((result['errors'] as Array<{ code: string }>)[0]!.code).toBe('IR_PARSE_ERROR');
  });

  it('view와 ir.view가 다르면 거부한다', async () => {
    const result = await call({ action: 'validate', view: 'deploy-path', ir: makeIr() });
    expect((result['errors'] as Array<{ code: string }>)[0]!.code).toBe('VIEW_MISMATCH');
  });
});

describe('입력 IR의 오타 칸', () => {
  function typoIr(): Record<string, unknown> {
    const ir = makeIr() as unknown as { nodes: Array<Record<string, unknown>> };
    ir.nodes[0]!['discription'] = '오타 난 설명';
    return ir as unknown as Record<string, unknown>;
  }

  type ToolError = { code: string; path?: string; suggestion?: string };

  it.each(['validate', 'render'] as const)(
    '%s는 UNKNOWN_FIELD와 제안 하나로 거부한다',
    async (action) => {
      const result = await call({ action, ir: typoIr() });
      expect(result['ok']).toBe(false);
      const errors = result['errors'] as ToolError[];
      const unknown = errors.filter((e) => e.code === 'UNKNOWN_FIELD');
      expect(unknown).toHaveLength(1);
      expect(unknown[0]).toMatchObject({
        path: 'nodes[0].discription',
        suggestion: 'description',
      });
      expect(typeof unknown[0]!.suggestion).toBe('string');
    },
  );

  it('render가 거부하면 산출 파일을 쓰지 않는다', async () => {
    await call({ action: 'render', ir: typoIr() });
    expect(existsSync(join(repoRoot, '.gestalt', 'architecture', 'screen-chain.json'))).toBe(false);
  });

  it('비슷한 칸이 없으면 제안 없이 거부한다', async () => {
    const ir = makeIr() as unknown as Record<string, unknown>;
    ir['zzzzzzzz'] = 1;
    const result = await call({ action: 'validate', ir });
    const unknown = (result['errors'] as ToolError[]).find((e) => e.code === 'UNKNOWN_FIELD');
    expect(unknown?.path).toBe('zzzzzzzz');
    expect(unknown?.suggestion).toBeUndefined();
  });

  it('오타 칸이 없는 IR은 그대로 통과한다', async () => {
    const result = await call({ action: 'validate', ir: makeIr() });
    expect(result['ok']).toBe(true);
  });
});

describe('ges_architecture render', () => {
  it('두 번 그려도 HTML 바이트가 같다', async () => {
    const first = await call({ action: 'render', ir: makeIr() });
    const html1 = readFileSync(first['htmlPath'] as string);
    const shared1 = readFileSync(first['sharedHtmlPath'] as string);
    const second = await call({ action: 'render', ir: makeIr() });
    expect(readFileSync(second['htmlPath'] as string).equals(html1)).toBe(true);
    expect(readFileSync(second['sharedHtmlPath'] as string).equals(shared1)).toBe(true);
  });

  it('shared HTML에는 private 근거 위치가 없다', async () => {
    const result = await call({ action: 'render', ir: makeIr(), audience: 'shared' });
    expect(result['openPath']).toBe(result['sharedHtmlPath']);
    expect(readFileSync(result['htmlPath'] as string, 'utf-8')).toContain(PRIVATE_LOCATION);
    expect(readFileSync(result['sharedHtmlPath'] as string, 'utf-8')).not.toContain(
      PRIVATE_LOCATION,
    );
    // 응답에는 경로만 싣는다
    expect(JSON.stringify(result)).not.toContain('<!doctype html>');
  });

  it('평면 그림이면 levels를 싣지 않는다', async () => {
    const result = await call({ action: 'render', ir: makeIr() });
    expect(result).not.toHaveProperty('levels');
    expect(result).not.toHaveProperty('groups');
  });

  it('service 노드가 그려지면 드릴다운 HTML과 levels 요약을 낸다', async () => {
    const ir = makeIr();
    ir.nodes.push(node('n-svc', 'service', 'Acme Web'), node('n-feat', 'feature', 'Orders', 2));
    ir.nodes[0]!.parent = 'n-feat';
    ir.nodes[ir.nodes.length - 1]!.parent = 'n-svc';
    const result = await call({ action: 'render', ir });
    expect(result['ok']).toBe(true);
    const levels = result['levels'] as {
      id: string;
      title: string;
      nodes: number;
      edges: number;
    }[];
    expect(levels.map((l) => l.id)).toEqual([
      'root',
      'feature:n-feat',
      'server:n-orders-module',
      'service:n-svc',
    ]);
    expect(levels[0]).toEqual({ id: 'root', title: '전체', nodes: 2, edges: 1 });
    const page = readFileSync(result['htmlPath'] as string, 'utf-8');
    expect(page).toContain('data-level-id="service:n-svc"');
    expect(readFileSync(result['sharedHtmlPath'] as string, 'utf-8')).not.toContain(
      PRIVATE_LOCATION,
    );
  });

  it('parent가 nodes에 없으면 render를 거부한다', async () => {
    const ir = makeIr();
    ir.nodes[0]!.parent = 'n-missing';
    const result = await call({ action: 'render', ir });
    expect(result['ok']).toBe(false);
    expect((result['errors'] as Array<{ code: string }>)[0]!.code).toBe('PARENT_NOT_FOUND');
  });

  it('두 번째 render는 이전 노드 id를 물려받는다', async () => {
    await call({ action: 'render', ir: makeIr('n') });
    const result = await call({ action: 'render', ir: makeIr('m') });
    const saved = JSON.parse(readFileSync(result['irPath'] as string, 'utf-8')) as ArchitectureIr;
    expect(saved.nodes.map((n) => n.id).sort()).toEqual([
      'n-home',
      'n-orders-api',
      'n-orders-module',
    ]);
    expect(saved.edges.map((e) => [e.from, e.to])).toEqual([
      ['n-home', 'n-orders-api'],
      ['n-orders-api', 'n-orders-module'],
    ]);
  });

  it('stats를 그린 엣지 기준으로 센다', async () => {
    const ir = makeIr();
    ir.nodes.push({ id: 'n-ghost', kind: 'screen', label: 'Ghost', repo: 'web', evidence: [] });
    ir.edges.push({
      id: 'n-e3',
      from: 'n-ghost',
      to: 'n-orders-api',
      kind: 'calls',
      lineStyle: 'dashed',
      evidence: [],
    });
    const result = await call({ action: 'render', ir });
    expect(result['stats']).toEqual({
      nodes: 4,
      edges: 3,
      drawnEdges: 2,
      droppedEdges: 1,
      unresolvedOpen: 2,
      screenToEndpointRatio: 1,
      endpointMatchRatio: 1,
    });
    expect(result['sourcesUsed']).toEqual(ir.sourcesUsed);
  });

  it('검증에 실패하면 파일을 쓰지 않는다', async () => {
    const ir = makeIr();
    ir.edges[0]!.evidence = [];
    const result = await call({ action: 'render', ir });
    expect(result['ok']).toBe(false);
    expect(existsSync(join(repoRoot, '.gestalt', 'architecture'))).toBe(false);
  });
});

describe('ges_architecture description 경고', () => {
  function described(): ArchitectureIr {
    const ir = makeIr();
    for (const n of ir.nodes) n.description = `${n.label}가 무엇인지 적은 한 줄이에요.`;
    return ir;
  }

  it('validate는 description이 빈 노드를 warnings로 알리고 ok는 그대로 true다', async () => {
    const ir = makeIr();
    ir.nodes[0]!.description = '홈 화면이에요.';
    const result = await call({ action: 'validate', ir });
    expect(result['ok']).toBe(true);
    expect(result['warnings']).toEqual([
      expect.objectContaining({
        code: 'NODE_DESCRIPTION_MISSING',
        nodeIds: ['n-orders-api', 'n-orders-module'],
      }),
    ]);
  });

  it('render도 warnings를 싣고 HTML은 그대로 쓴다', async () => {
    const result = await call({ action: 'render', ir: makeIr() });
    expect(existsSync(result['htmlPath'] as string)).toBe(true);
    const warnings = result['warnings'] as Array<{ code: string; nodeIds: string[] }>;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.code).toBe('NODE_DESCRIPTION_MISSING');
    expect(warnings[0]!.nodeIds).toEqual(['n-home', 'n-orders-api', 'n-orders-module']);
  });

  it('모든 노드에 description이 있으면 validate와 render 응답에 warnings 키가 없다', async () => {
    const validated = await call({ action: 'validate', ir: described() });
    expect(validated['ok']).toBe(true);
    expect(validated).not.toHaveProperty('warnings');
    const rendered = await call({ action: 'render', ir: described() });
    expect(rendered).not.toHaveProperty('warnings');
  });

  it('경고는 저장한 IR 파일에 남지 않는다', async () => {
    const result = await call({ action: 'render', ir: makeIr() });
    const saved = readFileSync(result['irPath'] as string, 'utf-8');
    expect(saved).not.toContain('NODE_DESCRIPTION_MISSING');
  });
});

describe('ges_architecture status', () => {
  it('뷰마다 이전 실행 요약을 돌려준다', async () => {
    const before = await call({ action: 'status' });
    expect(before['views']).toEqual({
      'screen-chain': null,
      'deploy-path': null,
      knowledge: null,
      'knowledge-link': null,
    });

    await call({ action: 'render', ir: makeIr() });
    const after = await call({ action: 'status' });
    const views = after['views'] as Record<string, { nodeCount: number } | null>;
    expect(views['screen-chain']!.nodeCount).toBe(3);
    expect(views['deploy-path']).toBeNull();
  });
});

describe('ges_architecture start', () => {
  it('view가 없으면 거부한다', async () => {
    const result = await call({ action: 'start' });
    expect((result['errors'] as Array<{ code: string }>)[0]!.code).toBe('MISSING_INPUT');
  });

  it('맥락 후보와 규칙을 돌려주고 파일 본문은 싣지 않는다', async () => {
    writeFileSync(join(repoRoot, 'CLAUDE.md'), 'repo rules body');
    mkdirSync(join(homeDir, '.claude'), { recursive: true });
    writeFileSync(join(homeDir, '.claude', 'CLAUDE.md'), 'home rules body');

    const result = await call({ action: 'start', view: 'screen-chain' });
    expect(result['view']).toBe('screen-chain');
    expect(result['previous']).toBeNull();
    expect(result['previousSourcesUsed']).toEqual([]);
    expect(result['nextAction']).toBe('filter_tools');
    expect(existsSync(result['schemaPath'] as string)).toBe(true);
    expect(result['readOnlyRule']).toMatchObject({
      allow: expect.arrayContaining(['search']),
      deny: expect.arrayContaining(['delete']),
    });
    const candidates = result['contextCandidates'] as Array<Record<string, unknown>>;
    expect(candidates).toContainEqual({
      via: 'repo',
      identifier: join(repoRoot, 'CLAUDE.md'),
      exists: true,
      visibility: 'public',
    });
    expect(candidates).toContainEqual({
      via: 'global',
      identifier: join(homeDir, '.claude', 'CLAUDE.md'),
      exists: true,
      visibility: 'private',
    });
    const text = JSON.stringify(result);
    expect(text).not.toContain('repo rules body');
    expect(text).not.toContain('home rules body');
  });

  it('이전 실행이 있으면 요약과 출처를 싣는다', async () => {
    await call({ action: 'render', ir: makeIr() });
    const result = await call({ action: 'start', view: 'screen-chain' });
    expect(result['previous']).toMatchObject({ nodeCount: 3, edgeCount: 2 });
    expect(result['previous']).not.toHaveProperty('sourcesUsed');
    expect(result['previousSourcesUsed']).toEqual(makeIr().sourcesUsed);
  });
});

describe('ges_architecture filter_tools / match_endpoints', () => {
  it('filter_tools는 도구 이름을 셋으로 나눈다', async () => {
    const result = await call({
      action: 'filter_tools',
      toolNames: ['search_docs', 'create_issue', 'frobnicate'],
    });
    expect(result).toEqual({
      allowed: ['search_docs'],
      denied: ['create_issue'],
      ambiguous: ['frobnicate'],
    });
  });

  it('filter_tools에 toolNames가 없으면 거부한다', async () => {
    const result = await call({ action: 'filter_tools' });
    expect(result['ok']).toBe(false);
  });

  it('match_endpoints는 FE 호출과 BE 라우트를 잇는다', async () => {
    const result = await call({
      action: 'match_endpoints',
      feCalls: [{ id: 'fe1', method: 'GET', path: '/api/orders/${id}' }],
      beRoutes: [{ id: 'be1', method: 'GET', path: '/api/orders/{orderId}', repo: 'api' }],
    });
    expect(result['matches']).toEqual([{ feCallId: 'fe1', beRouteId: 'be1', viaPrefix: null }]);
    expect(result['unmatched']).toEqual([]);
    expect(result['learnedPrefixes']).toEqual([]);
    expect(result).not.toHaveProperty('suggestedNote');
  });

  it('match_endpoints는 beRoutes의 mountPrefix를 붙여 잇고 못 맞춘 호출에는 후보만 단다', async () => {
    const result = await call({
      action: 'match_endpoints',
      feCalls: [
        { id: 'fe1', method: 'GET', path: '/api/orders/${id}' },
        { id: 'fe2', method: 'GET', path: '/shop/orders/${id}/items' },
      ],
      beRoutes: [
        { id: 'be1', method: 'GET', path: '/orders/{orderId}', repo: 'api', mountPrefix: '/api' },
        { id: 'be2', method: 'GET', path: '/v2/orders/{orderId}/items', repo: 'api' },
      ],
    });
    expect(result['matches']).toEqual([
      { feCallId: 'fe1', beRouteId: 'be1', viaPrefix: '/api', matchedBy: 'mount_prefix' },
    ]);
    expect(result['unmatched']).toEqual([
      {
        feCallId: 'fe2',
        reason: 'no_route',
        candidates: [],
        suggested: [{ beRouteId: 'be2', score: 6, fePrefix: '/shop', routePrefix: '/v2' }],
      },
    ]);
    expect(result['suggestedNote']).toContain('1개');
  });

  it('match_endpoints는 nameRefs를 팩 matcher 규칙으로 잇는다', async () => {
    const result = await call({
      action: 'match_endpoints',
      nameRefs: {
        matcher: 'dataset-io',
        refs: [{ id: 'job-read', name: "ref('orders')" }],
        decls: [{ id: 'tbl-orders', name: 'mart.orders' }],
      },
    });
    expect(result['refs']).toEqual({
      matcher: 'dataset-io',
      matches: [{ refId: 'job-read', declId: 'tbl-orders' }],
      unmatched: [],
    });
  });

  it('match_endpoints에 beRoutes가 없으면 거부한다', async () => {
    const result = await call({ action: 'match_endpoints', feCalls: [] });
    expect(result['ok']).toBe(false);
  });
});

describe('ges_architecture merge', () => {
  function product(prefix: string, name: string): ArchitectureIr {
    const ir = makeIr(prefix);
    ir.repos = [{ id: 'web', name, root: '.', remote: `git@github.com:acme/${name}.git` }];
    ir.nodes.push(node(`${prefix}-svc`, 'service', name));
    ir.nodes[0]!.parent = `${prefix}-svc`;
    return ir;
  }

  it('파일로 받은 IR을 합쳐 쓴 뒤 그 파일을 render하면 서비스마다 드릴다운이 선다', async () => {
    const aPath = join(tmpRoot, 'a.json');
    const bPath = join(tmpRoot, 'b.json');
    writeFileSync(aPath, JSON.stringify(product('a', 'acme-shop')));
    writeFileSync(bPath, JSON.stringify(product('b', 'acme-admin')));

    const merged = await call({ action: 'merge', irPaths: [aPath, bPath], outPath: 'merged.json' });
    expect(merged['ok']).toBe(true);
    expect(merged['irPath']).toBe(join(repoRoot, 'merged.json'));
    expect(merged['ir']).toBeUndefined();
    expect(merged['report']).toMatchObject({ inputs: 2, islands: 2, sharedNodes: [] });

    const rendered = await call({ action: 'render', irPath: 'merged.json' });
    expect(rendered['ok']).toBe(true);
    const levelIds = (rendered['levels'] as { id: string }[]).map((l) => l.id);
    expect(levelIds).toEqual(expect.arrayContaining(['root', 'service:a-svc', 'service:b-svc']));
    // 두 IR의 private 근거가 다른 레포 별칭으로 다시 매겨져도 공유본에는 남지 않는다
    expect(readFileSync(rendered['sharedHtmlPath'] as string, 'utf-8')).not.toContain(
      'internal-notes',
    );
  });

  it('outPath가 없으면 합친 IR을 응답에 싣는다', async () => {
    const result = await call({ action: 'merge', irs: [product('a', 'acme-shop'), makeIr('b')] });
    expect(result['ok']).toBe(true);
    expect((result['ir'] as ArchitectureIr).nodes.length).toBe(7);
  });

  it('받는 핸들러를 못 찾은 FE 엔드포인트는 알림으로 싣고 mountPrefixes를 주면 잇는다', async () => {
    const fe = product('a', 'acme-shop');
    fe.nodes = fe.nodes.filter((n) => n.id !== 'a-orders-module');
    fe.edges = fe.edges.filter((e) => e.id !== 'a-e2');
    fe.nodes.find((n) => n.id === 'a-orders-api')!.label = 'GET /api/orders';
    const be = product('b', 'acme-api');

    const loose = await call({ action: 'merge', irs: [fe, be] });
    expect(loose['ok']).toBe(true);
    const report = loose['report'] as MergeReport;
    expect(report.crossRepoEdges).toEqual([]);
    expect(report.unlinkedEndpoints).toEqual([
      { nodeId: 'a-orders-api', label: 'GET /api/orders', repo: 'acme-shop' },
    ]);
    expect(loose['nextAction']).toContain('unlinkedEndpoints의 1개');

    const mounted = await call({
      action: 'merge',
      irs: [fe, be],
      mountPrefixes: { 'acme-api': '/api' },
    });
    const linked = mounted['report'] as MergeReport;
    expect(linked.crossRepoEdges).toHaveLength(1);
    expect(linked).not.toHaveProperty('unlinkedEndpoints');
    expect(mounted['nextAction']).not.toContain('unlinkedEndpoints');
  });

  it('입력 하나가 깨졌으면 몇 번째인지 알려준다', async () => {
    const result = await call({ action: 'merge', irs: [makeIr('a'), { view: 'screen-chain' }] });
    expect(result['ok']).toBe(false);
    const errors = result['errors'] as { code: string; message: string }[];
    expect(errors[0]!.code).toBe('IR_PARSE_ERROR');
    expect(errors[0]!.message).toContain('입력 1');
  });
});

describe('ges_architecture render의 구조 변경 그림', () => {
  it('처음 그리면 비교할 이전 그림이 없다고 알리고 delta 파일을 만들지 않는다', async () => {
    const result = await call({ action: 'render', ir: makeIr() });
    expect(result['delta']).toEqual({ status: 'no_previous', message: '비교할 이전 그림이 없다.' });
    const dir = join(repoRoot, '.gestalt', 'architecture');
    expect(existsSync(join(dir, 'screen-chain.delta.html'))).toBe(false);
  });

  it('구조가 같으면 unchanged이고 이전 delta 파일을 건드리지 않는다', async () => {
    await call({ action: 'render', ir: makeIr() });
    const changed = makeIr();
    changed.nodes.push(node('n-pay', 'endpoint', 'POST /pay', 2));
    const created = await call({ action: 'render', ir: changed });
    const deltaPath = (created['delta'] as { htmlPath: string }).htmlPath;
    const before = readFileSync(deltaPath);
    const again = await call({ action: 'render', ir: changed });
    expect((again['delta'] as { status: string }).status).toBe('unchanged');
    expect(again['delta']).not.toHaveProperty('htmlPath');
    expect(readFileSync(deltaPath).equals(before)).toBe(true);
  });

  it('바뀌면 created와 두 경로, 변경 건수를 싣고 메인 HTML 경로는 그대로다', async () => {
    await call({ action: 'render', ir: makeIr() });
    const next = makeIr();
    next.nodes.push(node('n-pay', 'endpoint', 'POST /pay', 2));
    next.edges.push(edge('n-e3', 'n-home', 'n-pay', 'calls'));
    next.nodes[2]!.description = '주문을 다루는 모듈이에요.';
    const result = await call({ action: 'render', ir: next });
    const delta = result['delta'] as {
      status: string;
      htmlPath: string;
      sharedHtmlPath: string;
      changes: Record<string, number>;
    };
    expect(delta.status).toBe('created');
    expect(delta.htmlPath.endsWith('screen-chain.delta.html')).toBe(true);
    expect(delta.sharedHtmlPath.endsWith('screen-chain.delta.shared.html')).toBe(true);
    expect(delta.changes).toEqual({ ADDED: 2, CHANGED: 1 });
    expect(result['htmlPath']).not.toBe(delta.htmlPath);
    const page = readFileSync(delta.htmlPath, 'utf-8');
    expect(page).toContain('data-change="ADDED" data-target="n-pay"');
    expect(page).toContain('data-change="CHANGED" data-target="n-orders-module"');
    // 예산 안이면 구조 변경 경고는 없다
    const codes = ((result['warnings'] as Array<{ code: string }> | undefined) ?? []).map(
      (w) => w.code,
    );
    expect(codes).not.toContain('DELTA_OVER_BUDGET');
  });

  it('공유본 delta에는 private 근거 위치와 계정 ID가 없다', async () => {
    const first = makeIr();
    first.nodes[2]!.description = '계정 123456789012에서 돈다';
    await call({ action: 'render', ir: first });
    const next = makeIr();
    next.nodes[2]!.description = '계정 210987654321에서 돈다';
    next.nodes.push(node('n-pay', 'endpoint', 'POST /pay', 2));
    const result = await call({ action: 'render', ir: next });
    const delta = result['delta'] as { htmlPath: string; sharedHtmlPath: string };
    expect(readFileSync(delta.htmlPath, 'utf-8')).toContain('210987654321');
    const shared = readFileSync(delta.sharedHtmlPath, 'utf-8');
    expect(shared).not.toContain('123456789012');
    expect(shared).not.toContain('210987654321');
    expect(shared).not.toContain(PRIVATE_LOCATION);
    // 가린 글자끼리는 같으므로 공유본 원장에는 설명 변경이 안 잡힌다
    expect(shared).not.toContain('data-change="CHANGED"');
  });

  it('예산을 넘으면 DELTA_OVER_BUDGET을 warnings에 싣고 그림은 그대로 쓴다', async () => {
    await call({ action: 'render', ir: makeIr() });
    const next = makeIr();
    for (let i = 0; i < 9; i++) {
      next.nodes.push(node(`n-x${i}`, 'endpoint', `GET /x${i}`, 2));
    }
    const result = await call({ action: 'render', ir: next });
    const delta = result['delta'] as { status: string; htmlPath: string };
    expect(delta.status).toBe('created');
    expect(existsSync(delta.htmlPath)).toBe(true);
    const warning = (result['warnings'] as Array<{ code: string; counts: Record<string, number> }>)
      .filter((w) => w.code === 'DELTA_OVER_BUDGET')
      .at(0);
    expect(warning?.counts['ledger']).toBe(9);
  });
  it('저장된 이전 IR이 지금 규칙으로 검증 안 되면 no_previous로 돌린다', async () => {
    await call({ action: 'render', ir: makeIr() });
    const irPath = join(repoRoot, '.gestalt', 'architecture', 'screen-chain.json');
    const stored = JSON.parse(readFileSync(irPath, 'utf-8')) as ArchitectureIr;
    stored.edges[0]!.evidence = [];
    writeFileSync(irPath, JSON.stringify(stored));
    const next = makeIr();
    next.nodes.push(node('n-pay', 'endpoint', 'POST /pay', 2));
    const result = await call({ action: 'render', ir: next });
    expect(result['ok']).toBe(true);
    expect((result['delta'] as { status: string }).status).toBe('no_previous');
    expect(existsSync(join(repoRoot, '.gestalt', 'architecture', 'screen-chain.delta.html'))).toBe(
      false,
    );
  });

  it('구조 변경 그림이 실패해도 render는 성공하고 delta는 failed다', async () => {
    await call({ action: 'render', ir: makeIr() });
    const dir = join(repoRoot, '.gestalt', 'architecture');
    // 비공개 delta 경로를 디렉토리로 막아 쓰기에서 던지게 한다
    mkdirSync(join(dir, 'screen-chain.delta.html', 'blocked'), { recursive: true });
    const next = makeIr();
    next.nodes.push(node('n-pay', 'endpoint', 'POST /pay', 2));
    const result = await call({ action: 'render', ir: next });
    expect(result['ok']).toBe(true);
    expect(existsSync(result['htmlPath'] as string)).toBe(true);
    const delta = result['delta'] as { status: string; message: string };
    expect(delta.status).toBe('failed');
    expect(delta.message).toContain('구조 변경 그림을 만들지 못했다');
    expect(existsSync(join(dir, 'screen-chain.delta.shared.html'))).toBe(false);
  });

  it('엣지만 추가해도 created이고 원장에 ADDED가 한 줄 든다', async () => {
    await call({ action: 'render', ir: makeIr() });
    const next = makeIr();
    next.edges.push(edge('n-e3', 'n-home', 'n-orders-module', 'calls'));
    const result = await call({ action: 'render', ir: next });
    const delta = result['delta'] as { status: string; htmlPath: string; changes: object };
    expect(delta.status).toBe('created');
    expect(delta.changes).toEqual({ ADDED: 1 });
    expect(readFileSync(delta.htmlPath, 'utf-8')).toContain('data-change="ADDED"');
  });

  it('꺾쇠가 든 label은 delta HTML에서 escape 된다', async () => {
    await call({ action: 'render', ir: makeIr() });
    const next = makeIr();
    next.nodes.push(node('n-xss', 'endpoint', '<script>alert(1)</script>', 2));
    const result = await call({ action: 'render', ir: next });
    const delta = result['delta'] as { htmlPath: string; sharedHtmlPath: string };
    for (const path of [delta.htmlPath, delta.sharedHtmlPath]) {
      const page = readFileSync(path, 'utf-8');
      expect(page).not.toContain('<script>alert');
      expect(page).toContain('&lt;script&gt;');
    }
  });

  it('공유본 delta 원장의 새 노드 이름에서 계정 ID가 가려지고 private 위치는 없다', async () => {
    await call({ action: 'render', ir: makeIr() });
    const next = makeIr();
    const added = node('n-secret', 'endpoint', 'GET /secret', 2);
    added.displayName = '결제 계정 123456789012';
    added.evidence.push({
      type: 'code',
      location: PRIVATE_LOCATION,
      visibility: 'private',
    });
    next.nodes.push(added);
    const result = await call({ action: 'render', ir: next });
    const delta = result['delta'] as { htmlPath: string; sharedHtmlPath: string };
    const shared = readFileSync(delta.sharedHtmlPath, 'utf-8');
    expect(shared).toContain('n-secret');
    expect(shared).not.toContain('123456789012');
    expect(readFileSync(delta.htmlPath, 'utf-8')).toContain('123456789012');
    expect(shared).not.toContain(PRIVATE_LOCATION);
    expect(shared).not.toContain('internal-notes');
  });

  it('같은 변경을 두 번 렌더하면 delta HTML 바이트가 같다', async () => {
    const run = async (): Promise<[Buffer, Buffer]> => {
      rmSync(join(repoRoot, '.gestalt'), { recursive: true, force: true });
      await call({ action: 'render', ir: makeIr() });
      const next = makeIr();
      next.nodes.push(node('n-pay', 'endpoint', 'POST /pay', 2));
      const r = await call({ action: 'render', ir: next });
      const d = r['delta'] as { htmlPath: string; sharedHtmlPath: string };
      return [readFileSync(d.htmlPath), readFileSync(d.sharedHtmlPath)];
    };
    const [a1, a2] = await run();
    const [b1, b2] = await run();
    expect(a1.equals(b1)).toBe(true);
    expect(a2.equals(b2)).toBe(true);
  });
});

describe('ges_architecture render의 비밀값 가림', () => {
  function filesUnder(dir: string): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name));
  }

  function secretIr(prefix = 'n'): ArchitectureIr {
    const ir = makeIr(prefix);
    // 코드 근거 excerpt는 실제 줄과 같아야 검증을 통과한다. 가림이 검증 뒤에 와야 이 대조가 안 깨진다
    ir.nodes[0]!.evidence[0] = {
      type: 'code',
      location: 'web:src/config.ts:1',
      visibility: 'public',
      excerpt: `const token = "${FAKE_TOKEN}";`,
    };
    ir.nodes[1]!.description = `postgres://app:${FAKE_PASSWORD}@db.local/app 로 붙는다`;
    return ir;
  }

  it('본인용, 저장 IR, views, 공유본, delta 두 벌과 응답 어디에도 원래 값이 없고 경고는 위치만 싣는다', async () => {
    writeFileSync(join(repoRoot, 'src/config.ts'), `const token = "${FAKE_TOKEN}";\n`);
    const first = await call({ action: 'render', ir: secretIr() });
    expect(first['ok']).toBe(true);
    // 예전 실행이 가림 없이 남긴 IR이 디스크에 있다고 치고 delta의 이전 쪽도 가려지는지 본다
    writeFileSync(first['irPath'] as string, JSON.stringify(secretIr(), null, 2));

    const next = secretIr();
    next.nodes.push(node('n-pay', 'endpoint', 'POST /pay', 2));
    next.edges.push(edge('n-e3', 'n-home', 'n-pay', 'calls'));
    const second = await call({ action: 'render', ir: next });
    expect(second['ok']).toBe(true);
    expect((second['delta'] as { status: string }).status).toBe('created');

    const files = filesUnder(join(repoRoot, '.gestalt', 'architecture'));
    const names = files.map((f) => f.slice(f.lastIndexOf('/') + 1));
    expect(names).toEqual(
      expect.arrayContaining([
        'screen-chain.html',
        'screen-chain.shared.html',
        'screen-chain.delta.html',
        'screen-chain.delta.shared.html',
      ]),
    );
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toContain(FAKE_TOKEN);
      expect(text, f).not.toContain(FAKE_PASSWORD);
    }
    const response = JSON.stringify(second);
    expect(response).not.toContain(FAKE_TOKEN);
    expect(response).not.toContain(FAKE_PASSWORD);

    const masked = (second['warnings'] as Array<Record<string, unknown>>).filter(
      (w) => w['code'] === 'SECRET_MASKED',
    );
    expect(masked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ nodeId: 'n-home', field: 'evidence[0].excerpt' }),
        expect.objectContaining({ nodeId: 'n-orders-api', field: 'description' }),
      ]),
    );
    // 같은 자리는 한 번만 싣는다
    const keys = masked.map((w) => `${String(w['nodeId'])}/${String(w['field'])}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('ges_architecture render의 커밋 정책', () => {
  const VIEW = 'screen-chain';
  const rel = (name: string) => join('.gestalt', 'architecture', name);

  function git(...args: string[]): string {
    return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  }

  function isIgnored(path: string): boolean {
    try {
      git('check-ignore', '-q', '--no-index', '--', path);
      return true;
    } catch {
      return false;
    }
  }

  const fixed = (r: RepoVisibility) => (): RepoVisibility => r;

  beforeEach(() => {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
  });

  it('공개 레포면 본인용 HTML과 IR은 무시하고 공유본은 커밋할 수 있게 둔다', async () => {
    const out = await call(
      { action: 'render', ir: makeIr() },
      { resolveVisibility: fixed({ verdict: 'public', source: 'gh', visibility: 'PUBLIC' }) },
    );
    expect(out['ok']).toBe(true);
    expect(out['visibility']).toEqual({ verdict: 'public', source: 'gh' });
    expect(out['ignoreFilePath']).toBe(join(repoRoot, rel('.gitignore')));
    expect(existsSync(out['ignoreFilePath'] as string)).toBe(true);
    expect(isIgnored(rel(`${VIEW}.html`))).toBe(true);
    expect(isIgnored(rel(`${VIEW}.json`))).toBe(true);
    expect(isIgnored(rel(`${VIEW}.shared.html`))).toBe(false);
  });

  it('비공개 레포면 아무것도 막지 않는다', async () => {
    const out = await call({ action: 'render', ir: makeIr() });
    expect(out['ok']).toBe(true);
    expect(out['visibility']).toEqual({ verdict: 'private', source: 'gh' });
    expect(out['ignoreFilePath']).toBeUndefined();
    expect(existsSync(join(repoRoot, rel('.gitignore')))).toBe(false);
    for (const f of [`${VIEW}.html`, `${VIEW}.json`, `${VIEW}.shared.html`]) {
      expect(isIgnored(rel(f)), f).toBe(false);
    }
  });

  it.each([
    [
      'gh 실패',
      'gh_failed',
      {
        readRemoteUrl: () => 'git@github.com:acme/web.git',
        ghRepoView: () => {
          throw new Error('gh: command not found');
        },
      },
    ],
    ['원격 없음', 'no_remote', { readRemoteUrl: () => null, ghRepoView: () => '' }],
    [
      'GitHub 밖 원격',
      'non_github_remote',
      { readRemoteUrl: () => 'https://gitlab.com/acme/web.git', ghRepoView: () => '' },
    ],
  ])('%s 이면 공개로 보고 같은 .gitignore를 쓴다', async (_name, reason, deps) => {
    const out = await call(
      { action: 'render', ir: makeIr() },
      { resolveVisibility: (root) => resolveRepoVisibility(root, deps) },
    );
    expect(out['ok']).toBe(true);
    expect(out['visibility']).toEqual({
      verdict: 'public',
      source: 'fallback',
      fallbackReason: reason,
    });
    expect(isIgnored(rel(`${VIEW}.html`))).toBe(true);
    expect(isIgnored(rel(`${VIEW}.shared.html`))).toBe(false);
  });

  it('이미 추적 중인 본인용 산출물이 있으면 경고 한 건만 내고 render는 끝까지 간다', async () => {
    await call({ action: 'render', ir: makeIr() });
    git('add', '-A');
    git('commit', '-q', '-m', 'private repo commit');

    const out = await call(
      { action: 'render', ir: makeIr() },
      { resolveVisibility: fixed({ verdict: 'public', source: 'gh', visibility: 'PUBLIC' }) },
    );
    expect(out['ok']).toBe(true);
    const tracked = ((out['warnings'] ?? []) as { code: string; paths?: string[] }[]).filter(
      (w) => w.code === 'IGNORED_FILE_TRACKED',
    );
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.paths).toContain(rel(`${VIEW}.html`));
    expect(tracked[0]!.paths).not.toContain(rel(`${VIEW}.shared.html`));
    expect(existsSync(out['htmlPath'] as string)).toBe(true);
    // 서버는 추적을 풀지 않는다
    expect(git('ls-files', '--', rel(`${VIEW}.html`)).trim()).toBe(rel(`${VIEW}.html`));
  });

  it('공개 여부 판정이 던져도 render는 성공한다', async () => {
    const out = await call(
      { action: 'render', ir: makeIr() },
      {
        resolveVisibility: () => {
          throw new Error('boom');
        },
      },
    );
    expect(out['ok']).toBe(true);
    expect(out['visibility']).toBeUndefined();
    expect(existsSync(out['htmlPath'] as string)).toBe(true);
  });
});

describe('ges_architecture render의 커밋 해시와 승계 보고', () => {
  function git(...args: string[]): string {
    return execFileSync('git', ['-C', repoRoot, '-c', 'core.hooksPath=/dev/null', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  }

  beforeEach(() => {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    git('add', 'src');
    git('commit', '-q', '-m', 'init');
  });

  function savedIr(result: Record<string, unknown>): ArchitectureIr {
    return JSON.parse(readFileSync(result['irPath'] as string, 'utf-8')) as ArchitectureIr;
  }

  it('저장 IR에만 지금 HEAD를 적고 HTML에는 넣지 않는다', async () => {
    const head = git('rev-parse', 'HEAD');
    const result = await call({ action: 'render', ir: makeIr() });
    expect(savedIr(result).repos[0]!.head).toBe(head);
    expect(readFileSync(result['htmlPath'] as string, 'utf-8')).not.toContain(head);
    expect(readFileSync(result['sharedHtmlPath'] as string, 'utf-8')).not.toContain(head);
  });

  it('입력에 적힌 옛 head는 지금 HEAD로 덮어쓴다', async () => {
    const ir = makeIr();
    ir.repos[0]!.head = 'abcdef0';
    const result = await call({ action: 'render', ir });
    expect(savedIr(result).repos[0]!.head).toBe(git('rev-parse', 'HEAD'));
  });

  it('description을 빼고 다시 그리면 이어받고 응답에 그 수를 싣는다', async () => {
    const first = makeIr();
    first.nodes[0]!.description = '첫 화면';
    const firstResult = await call({ action: 'render', ir: first });
    expect(firstResult['merge']).toBeUndefined();

    const second = await call({ action: 'render', ir: makeIr() });
    expect(second['merge']).toMatchObject({ descriptionCarried: 1 });
    expect(savedIr(second).nodes.find((n) => n.id === 'n-home')?.description).toBe('첫 화면');
  });

  it('summary와 note를 빼고 다시 그리면 이어받고 응답에 승계 수를 싣는다', async () => {
    const first = makeIr();
    first.summary = '주문 화면에서 서버까지 그린 그림이에요.';
    first.note = '결제 쪽은 빠져 있어요.';
    first.nodes[2]!.summary = '주문 요청을 받는 서버 모듈이에요.';
    await call({ action: 'render', ir: first });

    const second = await call({ action: 'render', ir: makeIr() });
    expect(second['merge']).toMatchObject({
      summaryCarried: 1,
      topLevelCarried: ['summary', 'note'],
    });
    const saved = savedIr(second);
    expect(saved.summary).toBe(first.summary);
    expect(saved.note).toBe(first.note);
    expect(saved.nodes.find((n) => n.id === 'n-orders-module')?.summary).toBe(
      '주문 요청을 받는 서버 모듈이에요.',
    );
  });

  it('summary를 안 쓰는 예전 IR을 다시 그리면 승계 키가 응답에 안 생긴다', async () => {
    const first = makeIr();
    first.nodes[0]!.description = '첫 화면';
    await call({ action: 'render', ir: first });
    const second = await call({ action: 'render', ir: makeIr() });
    expect(second['ok']).toBe(true);
    expect(second['merge']).not.toHaveProperty('summaryCarried');
    expect(second['merge']).not.toHaveProperty('topLevelCarried');
  });

  it('status는 저장 head와 지금 HEAD를 비교해 바뀐 근거 파일을 알려 준다', async () => {
    await call({ action: 'render', ir: makeIr() });
    const fresh = (await call({ action: 'status' }))['views'] as Record<
      string,
      { freshness: { status: string; staleEvidenceFiles: string[] } } | null
    >;
    expect(fresh['screen-chain']!.freshness).toMatchObject({
      status: 'fresh',
      staleEvidenceFiles: [],
    });

    writeFileSync(join(repoRoot, 'src/orders.ts'), 'a\nB\nc\n');
    git('commit', '-q', '-am', 'edit orders');
    const stale = (await call({ action: 'status' }))['views'] as typeof fresh;
    expect(stale['screen-chain']!.freshness).toMatchObject({
      status: 'stale',
      staleEvidenceFiles: ['web:src/orders.ts'],
    });
  });

  it('근거 파일이 git에서 옮겨졌으면 movedTo 후보를 붙인다', async () => {
    await call({ action: 'render', ir: makeIr() });
    git('mv', 'src/orders.ts', 'src/order-service.ts');
    git('commit', '-q', '-m', 'move orders');
    for (const action of ['validate', 'render'] as const) {
      const result = await call({ action, ir: makeIr() });
      expect(result['ok']).toBe(false);
      const errors = result['errors'] as Array<{ code: string; movedTo?: string[] }>;
      const notFound = errors.filter((e) => e.code === 'CODE_EVIDENCE_NOT_FOUND');
      expect(notFound.length).toBeGreaterThan(0);
      for (const e of notFound) expect(e.movedTo).toEqual(['web:src/order-service.ts:2']);
    }
  });

  it('지난 흐름의 근거 파일이 지워졌으면 render를 막지 않고 evidence_stale로 흐름만 버린다', async () => {
    writeFileSync(join(repoRoot, 'src/checkout.ts'), 'a\nb\nc\n');
    const first: ArchitectureIr = {
      ...makeIr(),
      flows: [
        {
          id: 'checkout',
          title: '결제',
          actors: [{ id: 'user', label: '사용자', kind: 'person' }],
          steps: [
            {
              id: 'checkout-s1',
              actor: 'user',
              label: '결제 시작',
              refs: ['n-home'],
              evidence: [{ type: 'code', location: 'web:src/checkout.ts:3', visibility: 'public' }],
            },
          ],
          transitions: [],
        },
      ],
    };
    expect((await call({ action: 'render', ir: first }))['ok']).toBe(true);
    rmSync(join(repoRoot, 'src/checkout.ts'));

    const result = await call({ action: 'render', ir: makeIr() });
    expect(result['ok']).toBe(true);
    expect(result['warnings']).toContainEqual(
      expect.objectContaining({
        code: 'FLOW_DROPPED',
        flowId: 'checkout',
        reason: 'evidence_stale',
      }),
    );
    expect(savedIr(result).flows ?? []).toEqual([]);

    // 파일 검사를 끈 render는 근거로 흐름을 버리지 않는다. 버리면 저장 IR에서 흐름을 영영 잃는다
    expect((await call({ action: 'render', ir: first, checkFiles: false }))['ok']).toBe(true);
    const unchecked = await call({ action: 'render', ir: makeIr(), checkFiles: false });
    expect(savedIr(unchecked).flows?.map((f) => f.id)).toEqual(['checkout']);
  });

  it('label과 id가 함께 바뀐 노드를 근거 파일로 잇고 relabeled로 알린다', async () => {
    const first = makeIr();
    first.nodes[2]!.description = '주문 모듈';
    await call({ action: 'render', ir: first });

    const next = makeIr();
    const mod = next.nodes[2]!;
    mod.id = 'n-order-domain';
    mod.label = 'OrderDomainModule';
    next.edges[1]!.to = 'n-order-domain';
    const result = await call({ action: 'render', ir: next });
    expect(result['ok']).toBe(true);
    const merge = result['merge'] as { relabeled?: Array<{ id: string; label: string }> };
    expect(merge.relabeled).toEqual([
      expect.objectContaining({ id: 'n-orders-module', label: 'OrderDomainModule' }),
    ]);
    const saved = savedIr(result).nodes.find((n) => n.id === 'n-orders-module');
    expect(saved?.label).toBe('OrderDomainModule');
    expect(saved?.description).toBe('주문 모듈');
  });
});

describe('ges_architecture serve', () => {
  // 실제 세션을 찾지 않고 소켓도 안 연다
  const sessionOn: LiveSessionBridge = {
    alive: () => true,
    send: () => Promise.resolve({ ok: true as const }),
  };
  const sessionOff: LiveSessionBridge = { ...sessionOn, alive: () => false };
  const live = (session: LiveSessionBridge): ArchitectureHandlerOptions => ({
    live: { port: 0, attempts: 1, deps: { session } },
  });

  afterEach(async () => {
    await stopArchitectureLiveServers();
  });

  it('render 전에는 liveUrl을 싣지 않고 serve 뒤 render는 liveUrl을 싣는다', async () => {
    const before = await call({ action: 'render', ir: makeIr() });
    expect(before).not.toHaveProperty('liveUrl');

    const served = await call({ action: 'serve', view: 'screen-chain' }, live(sessionOn));
    expect(served['ok']).toBe(true);
    const port = served['port'] as number;
    expect(served['url']).toBe(`http://127.0.0.1:${port}`);
    const liveUrl = served['liveUrl'] as string;
    expect(liveUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${port}/screen-chain\\.html\\?k=[A-Za-z0-9_-]{43}$`),
    );
    expect(served['liveUrls']).toEqual({ 'screen-chain': liveUrl });
    expect(served['session']).toBe(true);
    expect(served).not.toHaveProperty('warning');

    const after = await call({ action: 'render', ir: makeIr() });
    // 서버가 떠 있는 동안 키가 그대로라 render도 같은 주소를 돌려준다
    expect(after['liveUrl']).toBe(liveUrl);
  });

  it('다시 serve하면 같은 포트를 돌려준다', async () => {
    const first = await call({ action: 'serve' }, live(sessionOn));
    const second = await call({ action: 'serve' }, live(sessionOn));
    expect(second['port']).toBe(first['port']);
    expect(first['liveUrls']).toEqual({});
  });

  it('아직 안 그린 그림이면 안내를 싣고 세션이 없으면 경고를 싣는다', async () => {
    const served = await call({ action: 'serve', view: 'deploy-path' }, live(sessionOff));
    expect(served['ok']).toBe(true);
    expect(served['session']).toBe(false);
    expect(String(served['message'])).toContain('render');
    expect(String(served['warning'])).toContain('숨겨진다');
  });

  it('서버를 내리면 render가 liveUrl을 싣지 않는다', async () => {
    await call({ action: 'serve' }, live(sessionOn));
    await stopArchitectureLiveServers();
    const result = await call({ action: 'render', ir: makeIr() });
    expect(result).not.toHaveProperty('liveUrl');
  });
});
