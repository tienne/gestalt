import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ownersOf, parseCodeowners } from '../../../src/architecture/codeowners.js';
import { linkDocs, screenRouteOf } from '../../../src/architecture/doc-link.js';
import type { FileFacts } from '../../../src/architecture/doc-link.js';
import { buildKnowledgeIr } from '../../../src/architecture/doc-scan.js';
import type { ScannedDoc } from '../../../src/architecture/doc-scan.js';
import type { ArchitectureIr } from '../../../src/architecture/index.js';
import { validateArchitectureIr } from '../../../src/architecture/validator.js';
import { handleArchitecturePassthrough } from '../../../src/mcp/tools/architecture-passthrough.js';
import { base, code, node } from '../../fixtures/architecture-categories/common.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

// 가짜 웹 레포 acme-web, API 레포 acme-api와 지식 레포 acme-kb, 디자인 레포 acme-design

function techIr(): ArchitectureIr {
  const screen = (route: string, name: string, line: number) =>
    node(`scr:web:${route}`, 'screen', {
      label: `[web] ${route} · ${name}`,
      repo: 'fe',
      evidence: [code(`fe:apps/web/src/routes.tsx:${line}`)],
    });
  return {
    ...base(),
    repos: [
      { id: 'fe', name: 'acme-web', root: '/srv/acme-web' },
      { id: 'be', name: 'acme-api', root: '/srv/acme-api' },
    ],
    nodes: [
      node('svc:web', 'service', { repo: 'fe', evidence: [code('fe:apps/web/src/main.tsx:1')] }),
      screen('/cart', 'CartPage', 10),
      screen('/pay/:id', 'PayPage', 12),
      screen('/me', 'MyPage', 14),
      node('mod:orders', 'app_module', {
        repo: 'be',
        evidence: [code('be:orders/src/main/App.java:3')],
      }),
      node('ep:GET /api/orders/{}', 'endpoint', {
        label: 'GET /api/orders/{}',
        repo: 'be',
        evidence: [code('be:orders/src/main/OrderController.java:20')],
      }),
    ],
    edges: [],
  };
}

const empty = { sections: [], evidenceMix: {}, routes: [], screens: [], mdLinks: [] };

const STATUS: ScannedDoc = {
  ...empty,
  repoId: 'kb',
  path: 'domains/orders/status.md',
  title: '주문 상태',
  updatedAt: '2026-01-01',
  gaps: [
    { kind: 'gap', text: '취소 사유', owner: 'kim', line: 9 },
    { kind: 'unverified', text: '환불 한도', line: 10 },
  ],
  codeRefs: [
    { repo: 'acme-api', path: 'orders/src/main/OrderController.java', pinned: 'branch', line: 3 },
    { repo: 'acme-api', path: 'orders/src/main/util/Money.java', pinned: 'none', line: 4 },
    { repo: 'acme-gone', path: 'x.ts', pinned: 'commit', line: 7 },
  ],
  apiRefs: [
    { method: 'GET', path: '/api/orders/{orderId}', line: 5 },
    { method: 'DELETE', path: '/api/orders/{id}', line: 6 },
  ],
};

const MISC: ScannedDoc = { ...empty, repoId: 'kb', path: 'misc.md', gaps: [], codeRefs: [] };

const SCREENS: ScannedDoc = {
  ...empty,
  repoId: 'design',
  path: 'products/store/screens.md',
  gaps: [],
  codeRefs: [],
  screens: [
    { name: '장바구니', line: 5, route: '/cart' },
    { name: '결제', line: 6, route: '/pay/[orderId]' },
    { name: '사라진 화면', line: 7, route: '/gone' },
  ],
};

const FACTS: Record<string, { exists: boolean; committedAt?: string }> = {
  'acme-api:orders/src/main/OrderController.java': { exists: true, committedAt: '2026-03-01' },
  'acme-api:orders/src/main/util/Money.java': { exists: false },
};
const fileFacts: FileFacts = (repo, path) => FACTS[`${repo}:${path}`];

const OWNERS: Record<string, string> = {
  'acme-web': '/apps/web/src/routes.tsx @acme/routes',
  'acme-api': '* @acme/backend',
  'acme-kb': 'domains/ @acme/orders-kb',
};
const ownersOfRepo = (repo: string, path: string) =>
  OWNERS[repo] === undefined ? undefined : ownersOf(parseCodeowners(OWNERS[repo]!), path);

function run(withOwners = false) {
  const scanned = [STATUS, MISC, SCREENS];
  const knowledge = buildKnowledgeIr(
    [
      { repoId: 'kb', name: 'acme-kb', path: '.' },
      { repoId: 'design', name: 'acme-design', path: '.' },
    ],
    { docs: scanned, skipped: [] },
    '2026-04-01T00:00:00.000Z',
  );
  return linkDocs(techIr(), knowledge, scanned, {
    fileFacts,
    screenIndexPrefixes: ['design/products/store/'],
    ...(withOwners ? { ownersOf: ownersOfRepo } : {}),
    generatedAt: '2026-04-01T00:00:00.000Z',
  });
}

describe('screenRouteOf', () => {
  it('화면 label에서 라우트만 뽑는다', () => {
    expect(screenRouteOf({ label: '[web] /pay/:id · PayPage' })).toBe('/pay/:id');
    expect(screenRouteOf({ label: 'PayPage' })).toBeUndefined();
  });
});

describe('linkDocs', () => {
  it('파일이 같으면 그 노드에, 아니면 패키지 루트가 같은 모듈에, 화면은 라우트로 잇는다', () => {
    const { ir } = run();
    const describes = ir.edges.filter((e) => e.kind === 'describes');
    expect(describes.map((e) => `${e.from} -> ${e.to} (${e.docLink?.via})`)).toEqual([
      'doc:kb/domains/orders/status.md -> ep:GET /api/orders/{} (code-ref)',
      'doc:kb/domains/orders/status.md -> mod:orders (code-ref)',
      'scr:design/products/store/screens.md#결제 -> scr:web:/pay/:id (screen-route)',
      'scr:design/products/store/screens.md#장바구니 -> scr:web:/cart (screen-route)',
    ]);
    expect(describes.every((e) => e.lineStyle === 'dashed')).toBe(true);
    expect(describes[0]!.docLink!.refs.map((r) => `${r.target}:${r.verified}`)).toEqual([
      'GET /api/orders/{}:true',
      'be:orders/src/main/OrderController.java:true',
    ]);
    expect(ir.nodes.some((n) => n.id === 'doc:kb/misc.md')).toBe(false);
    expect(
      ir.nodes.find((n) => n.id === 'doc:kb/domains/orders/status.md')?.parent,
    ).toBeUndefined();
  });

  it('폴더를 가리킨 근거는 그 아래 패키지 루트의 모듈에 잇는다', () => {
    const apps: ScannedDoc = {
      ...MISC,
      path: 'apps.md',
      codeRefs: [{ repo: 'acme-web', path: 'apps', pinned: 'none', line: 1 }],
    };
    const knowledge = buildKnowledgeIr(
      [{ repoId: 'kb', name: 'acme-kb', path: '.' }],
      { docs: [apps], skipped: [] },
      '2026-04-01T00:00:00.000Z',
    );
    const { ir } = linkDocs(techIr(), knowledge, [apps], { generatedAt: '2026-04-01' });
    expect(ir.edges.filter((e) => e.kind === 'describes').map((e) => e.to)).toEqual(['svc:web']);
  });

  it('생략할 수 있는 끝 파라미터와 색인에 박아 적은 값도 같은 화면으로 잇는다', () => {
    const tech = techIr();
    const screen = (route: string) =>
      node(`scr:web:${route}`, 'screen', {
        label: `[web] ${route} · Page`,
        repo: 'fe',
        evidence: [code('fe:apps/web/src/routes.tsx:20')],
      });
    tech.nodes.push(screen('/list/:tab?'), screen('/info/:type'));
    const index: ScannedDoc = {
      ...SCREENS,
      screens: [
        { name: '목록', line: 5, route: '/list' },
        { name: '정보', line: 6, route: '/info/NAVER' },
      ],
    };
    const knowledge = buildKnowledgeIr(
      [{ repoId: 'design', name: 'acme-design', path: '.' }],
      { docs: [index], skipped: [] },
      '2026-04-01T00:00:00.000Z',
    );
    const { ir, signals } = linkDocs(tech, knowledge, [index], {
      screenIndexPrefixes: ['design/products/store/'],
      generatedAt: '2026-04-01',
    });
    expect(
      ir.edges
        .filter((e) => e.kind === 'describes')
        .map((e) => e.to)
        .sort(),
    ).toEqual(['scr:web:/info/:type', 'scr:web:/list/:tab?']);
    expect(signals.screensOnlyInIndex).toEqual([]);
    expect(signals.screensOnlyInCode).toEqual(['scr:web:/cart', 'scr:web:/me', 'scr:web:/pay/:id']);
  });

  it('링크 상태와 낡음, 어긋난 API, 화면 짝 없음, 덮인 비율을 센다', () => {
    const { signals, docInfo } = run();
    expect(signals.links).toEqual({ total: 3, broken: 1, branchOnly: 1, pinned: 1, unchecked: 1 });
    expect(docInfo.get('doc:kb/domains/orders/status.md')?.staleSince).toBe('2026-03-01');
    expect(signals.stale).toEqual([
      { doc: 'doc:kb/domains/orders/status.md', updatedAt: '2026-01-01', newestRef: '2026-03-01' },
    ]);
    expect(signals.apiMismatches).toEqual([
      { doc: 'doc:kb/domains/orders/status.md', api: 'DELETE /api/orders/{}', line: 6 },
    ]);
    expect(signals.screensOnlyInCode).toEqual(['scr:web:/me']);
    expect(signals.screensOnlyInIndex).toEqual([
      'scr:design/products/store/screens.md#사라진 화면',
    ]);
    expect(signals.coverage).toEqual({
      service: { total: 1, covered: 0 },
      app_module: { total: 1, covered: 1 },
      screen: { total: 3, covered: 2 },
    });
    expect(signals.gapsByOwner).toEqual({ kim: 1, '(담당 없음)': 1 });
  });

  it('구멍과 어긋난 API는 이어진 기술 노드에 질문으로 달고 검증을 통과하며 문서 카드는 안 그린다', () => {
    const { ir } = run();
    expect(ir.view).toBe('knowledge-link');
    expect(ir.unresolved.map((q) => `${q.id} @ ${q.subject.nodeId}`)).toEqual([
      'doc-api:doc:kb/domains/orders/status.md:DELETE /api/orders/{} @ ep:GET /api/orders/{}',
      'doc-gap:doc:kb/domains/orders/status.md @ ep:GET /api/orders/{}',
    ]);
    const v = validateArchitectureIr(ir, { checkFiles: false });
    if (!v.ok) expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.value.drawableNodeIds.has('doc:kb/domains/orders/status.md')).toBe(false);
    expect(v.value.drawableNodeIds.has('mod:orders')).toBe(true);
    expect([...v.value.drawableEdgeIds].some((id) => id.startsWith('desc:'))).toBe(false);
  });
});

describe('CODEOWNERS 소유', () => {
  it('근거 파일과 문서 경로로 담당을 달고 기본 담당만 걸린 자리와 담당 없는 자리를 센다', () => {
    const { ir, signals } = run(true);
    expect(signals.ownership?.tech).toEqual({ total: 5, owned: 4, catchAllOnly: 1 });
    expect(signals.ownership?.unownedTech).toEqual(['svc:web']);
    expect(ir.nodes.find((n) => n.id === 'scr:web:/cart')?.owners).toEqual(['@acme/routes']);
    expect(ir.nodes.find((n) => n.id === 'doc:kb/domains/orders/status.md')?.owners).toEqual([
      '@acme/orders-kb',
    ]);
    // 문서에 담당을 적은 구멍은 그 사람에게, 안 적은 구멍은 문서 담당에게 센다
    expect(signals.gapsByOwner).toEqual({ kim: 1, '@acme/orders-kb': 1 });
  });

  it('ownersOf가 없으면 소유 신호를 안 싣는다', () => {
    expect(run().signals.ownership).toBeUndefined();
  });

  it('담당 없음 배지는 담당이 실린 private에만 단다', async () => {
    const { private: html, shared } = await renderBoth(run(true).ir);
    expect(html).toContain('>담당 없음</span>');
    expect(shared).not.toContain('>담당 없음</span>');
    expect(shared).not.toContain('@acme/routes');
  });
});

describe('지식과 아키텍처 그림 렌더', () => {
  it('문서는 카드가 아니라 기술 카드 배지와 서랍 목록으로 보이고 덮인 비율을 머리줄에 단다', async () => {
    const { private: html, shared } = await renderBoth(run().ir);
    expect(html).not.toContain('data-node-id="doc:kb/domains/orders/status.md"');
    expect(html).toContain('<span class="doc-badge cover" title="설명하는 문서 1개">문서 1</span>');
    expect(html).toContain('<span class="doc-badge stale"');
    expect(html).toContain('>문서 없음</span>');
    expect(html).toContain('문서 있음 3/5');
    expect(html).toContain('function renderCover(list, body)');
    // 공유본에도 문서 제목과 경로는 남고 구멍 설명은 빠진다
    expect(shared).toContain('domains/orders/status.md');
    expect(shared).not.toContain('취소 사유');
  });
});

describe('ges_architecture link_docs', () => {
  let tmpRoot: string;
  const put = (rel: string, text: string): void => {
    const p = join(tmpRoot, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };

  beforeEach(() => {
    tmpRoot = resolve('.gestalt-test', `doc-link-${randomUUID()}`);
    put(
      'acme-kb/orders.md',
      '# 주문\n\n> 최종 수정: 2026-01-01\n\n조회는 `GET /api/orders/{id}` [evidence: acme-api:orders/src/main/OrderController.java@main]\n' +
        '없는 파일 [evidence: acme-api:orders/src/main/Gone.java]\n',
    );
    put('acme-api/orders/src/main/OrderController.java', 'class OrderController {}\n');
    put('work/tech.json', JSON.stringify(techIr()));
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('scan_docs 뒤에 부르면 초안과 신호 파일을 쓰고 문서 지도의 링크 상태도 다시 센다', async () => {
    const work = join(tmpRoot, 'work');
    await handleArchitecturePassthrough(
      { action: 'scan_docs', docRoots: [{ repoId: 'kb', name: 'acme-kb', path: '../acme-kb' }] },
      work,
    );
    const r = (await handleArchitecturePassthrough(
      {
        action: 'link_docs',
        irPath: 'tech.json',
        codeRoots: { 'acme-api': '../acme-api' },
      },
      work,
    )) as { summary: Record<string, unknown>; draftPath: string; knowledgeDraftPath: string };
    expect(r.summary).toMatchObject({
      linkedDocs: 1,
      // 파일이 없어도 패키지 루트로는 모듈에 이어진다. 깨진 링크는 수로 따로 센다
      describes: 2,
      links: { total: 2, broken: 1, branchOnly: 1, pinned: 0, unchecked: 0 },
      apiMismatchCount: 0,
    });
    const link = JSON.parse(readFileSync(r.draftPath, 'utf8')) as ArchitectureIr;
    expect(validateArchitectureIr(link, { checkFiles: false }).ok).toBe(true);
    const kn = JSON.parse(readFileSync(r.knowledgeDraftPath, 'utf8')) as ArchitectureIr;
    expect(kn.nodes.find((n) => n.id === 'doc:kb/orders.md')?.doc?.links?.broken).toBe(1);
  });

  it('문서 레포와 코드 레포의 CODEOWNERS로 담당을 찾는다', async () => {
    put('acme-kb/.github/CODEOWNERS', '* @acme/kb\n');
    put('acme-api/CODEOWNERS', 'orders/ @acme/orders\n');
    const work = join(tmpRoot, 'work');
    await handleArchitecturePassthrough(
      { action: 'scan_docs', docRoots: [{ repoId: 'kb', name: 'acme-kb', path: '../acme-kb' }] },
      work,
    );
    const r = (await handleArchitecturePassthrough(
      { action: 'link_docs', irPath: 'tech.json', codeRoots: { 'acme-api': '../acme-api' } },
      work,
    )) as { summary: Record<string, unknown>; knowledgeDraftPath: string };
    expect(r.summary.ownership).toEqual({
      tech: { total: 5, owned: 1, catchAllOnly: 0 },
      docs: { total: 1, owned: 1, catchAllOnly: 1 },
    });
    const kn = JSON.parse(readFileSync(r.knowledgeDraftPath, 'utf8')) as ArchitectureIr;
    expect(kn.nodes.find((n) => n.id === 'doc:kb/orders.md')?.owners).toEqual(['@acme/kb']);
  });

  it('scan_docs 결과가 없으면 거부한다', async () => {
    const r = (await handleArchitecturePassthrough(
      { action: 'link_docs', irPath: 'tech.json' },
      join(tmpRoot, 'work'),
    )) as { errors: { code: string }[] };
    expect(r.errors[0]!.code).toBe('MISSING_INPUT');
  });
});
