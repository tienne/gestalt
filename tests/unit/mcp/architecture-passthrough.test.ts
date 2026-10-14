import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  ArchitectureEdge,
  ArchitectureIr,
  ArchitectureNode,
} from '../../../src/architecture/types.js';
import { architectureInputSchema } from '../../../src/mcp/schemas.js';
import { handleArchitecturePassthrough } from '../../../src/mcp/tools/architecture-passthrough.js';

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

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const input = architectureInputSchema.parse({ repoRoot, ...args });
  return (await handleArchitecturePassthrough(input, process.cwd(), {
    homeDir,
    projectsRoot: join(homeDir, '.claude', 'projects'),
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
