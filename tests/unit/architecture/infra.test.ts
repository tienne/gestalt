import { describe, expect, it } from 'vitest';
import { routeCanvas } from '../../../src/architecture/canvas-geometry.js';
import {
  computeDrilldown,
  mergeWithPrevious,
  parseArchitectureIr,
  redactForSharing,
  renderArchitectureHtml,
  renderDrilldownHtml,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type DrillLevel,
  type Evidence,
  type ValidatedIr,
} from '../../../src/architecture/index.js';
import {
  compareEnvironment,
  computeLayout,
  environmentRank,
  pinToColumnTop,
  type LayoutResult,
} from '../../../src/architecture/layout.js';
import { datastoreEngine } from '../../../src/architecture/html-theme.js';
import { computeServiceFacts } from '../../../src/architecture/service-facts.js';

// 서빙 인프라(도메인 → CDN → 버킷 → 서비스)와 live 근거. 계정 ID와 도메인은 전부 가짜다
const PROD_ACCOUNT = '000000000000';
const DEV_ACCOUNT = '111111111111';
const DIST_ID = 'EFAKEDIST0001';

const codeEv: Evidence = { type: 'code', location: 'web:infra/serving.ts:3', visibility: 'public' };
const liveEv = (command: string, location = 'aws:cloudfront'): Evidence => ({
  type: 'live',
  location,
  command,
  observedAt: '2026-01-02T03:04:05Z',
  visibility: 'private',
});
const LIST_DIST = 'aws cloudfront list-distributions --profile acme-prod';

function node(
  id: string,
  kind: ArchitectureNode['kind'],
  extra: Partial<ArchitectureNode> = {},
): ArchitectureNode {
  return { id, kind, label: id, repo: 'web', evidence: [codeEv], ...extra };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: ArchitectureEdge['kind'],
  evidence: Evidence[] = [codeEv],
): ArchitectureEdge {
  const lineStyle = evidence.some((e) => e.type === 'code' || e.type === 'spec')
    ? 'solid'
    : 'dashed';
  return { id, from, to, kind, evidence, lineStyle };
}

function fixture(): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'web', name: 'acme-web', root: '/srv/acme-web' }],
    nodes: [
      node('svc-shop', 'service', { platforms: ['web', 'android', 'ios'] }),
      node('svc-admin', 'service'),
      node('f-orders', 'feature', { parent: 'svc-shop' }),
      node('s-orders', 'screen', { parent: 'f-orders' }),
      node('gw', 'gateway'),
      node('ep-orders', 'endpoint'),
      node('m-orders', 'app_module'),
      node('acct-prod', 'cloud_account', {
        label: PROD_ACCOUNT,
        evidence: [liveEv('aws sts get-caller-identity --profile acme-prod', 'aws:sts')],
      }),
      node('acct-dev', 'cloud_account', { label: DEV_ACCOUNT }),
      node('b-dev', 'bucket', { environment: 'dev', account: 'acct-dev' }),
      node('b-prod', 'bucket', { environment: 'prod', account: 'acct-prod' }),
      node('b-stage', 'bucket', { environment: 'stage', account: 'acct-prod' }),
      node('cdn-dev', 'cdn', { environment: 'dev', account: 'acct-prod', label: DIST_ID }),
      node('cdn-prod', 'cdn', { environment: 'prod', account: 'acct-prod' }),
      node('cdn-stage', 'cdn', { environment: 'stage', account: 'acct-prod' }),
      node('d-dev', 'domain', { label: 'shop.dev.example.com', environment: 'dev' }),
      node('d-prod', 'domain', { label: 'shop.example.com', environment: 'prod' }),
      node('d-stage', 'domain', { label: 'shop.stage.example.com', environment: 'stage' }),
    ],
    edges: [
      edge('c1', 's-orders', 'ep-orders', 'calls'),
      edge('r1', 'gw', 'ep-orders', 'routes'),
      edge('h1', 'ep-orders', 'm-orders', 'handles'),
      edge('sv-dev', 'b-dev', 'svc-shop', 'serves'),
      edge('sv-prod', 'b-prod', 'svc-shop', 'serves'),
      edge('sv-stage', 'b-stage', 'svc-shop', 'serves', [liveEv(LIST_DIST)]),
      edge('o-dev', 'cdn-dev', 'b-dev', 'origin', [codeEv, liveEv(LIST_DIST)]),
      edge('o-prod', 'cdn-prod', 'b-prod', 'origin'),
      edge('o-stage', 'cdn-stage', 'b-stage', 'origin'),
      edge('rs-dev', 'd-dev', 'cdn-dev', 'resolves_to', [liveEv(LIST_DIST)]),
      edge('rs-prod', 'd-prod', 'cdn-prod', 'resolves_to'),
      edge('rs-stage', 'd-stage', 'cdn-stage', 'resolves_to'),
    ],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

// svc-admin을 SSR 서버가 서빙한다. CDN 없이 도메인이 서버를 바로 가리킨다
function withSsr(ir: ArchitectureIr = fixture()): ArchitectureIr {
  return {
    ...ir,
    nodes: [
      ...ir.nodes,
      node('dt-admin', 'deploy_target', { environment: 'prod', account: 'acct-prod' }),
      node('d-admin', 'domain', { label: 'admin.example.com', environment: 'prod' }),
    ],
    edges: [
      ...ir.edges,
      edge('sv-admin', 'dt-admin', 'svc-admin', 'serves'),
      edge('rs-admin', 'd-admin', 'dt-admin', 'resolves_to'),
    ],
  };
}

function validated(ir: ArchitectureIr = fixture()): ValidatedIr {
  const result = validateArchitectureIr(ir, { checkFiles: false });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function errorsOf(ir: ArchitectureIr): string[] {
  const result = validateArchitectureIr(ir, { checkFiles: false });
  return result.ok ? [] : result.errors.map((e) => e.code);
}

function withNode(
  ir: ArchitectureIr,
  id: string,
  patch: Partial<ArchitectureNode>,
): ArchitectureIr {
  return { ...ir, nodes: ir.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n)) };
}

describe('IR 스키마 — live 근거와 인프라 필드', () => {
  it('fixture가 스키마를 통과한다', () => {
    expect(parseArchitectureIr(fixture()).ok).toBe(true);
  });

  it('live 근거는 command와 observedAt이 있어야 한다', () => {
    const ir = withNode(fixture(), 'cdn-prod', {
      evidence: [{ type: 'live', location: 'aws:cloudfront', visibility: 'private' }],
    });
    const parsed = parseArchitectureIr(ir);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.issues.join('\n')).toContain('command');
      expect(parsed.error.issues.join('\n')).toContain('observedAt');
    }
  });

  it('observedAt은 ISO 시각이어야 하고 live가 아닌 근거에는 command를 못 쓴다', () => {
    const bad = withNode(fixture(), 'cdn-prod', {
      evidence: [{ ...liveEv(LIST_DIST), observedAt: '어제' }],
    });
    expect(parseArchitectureIr(bad).ok).toBe(false);
    const codeWithCommand = withNode(fixture(), 'cdn-prod', {
      evidence: [{ ...codeEv, command: LIST_DIST }],
    });
    expect(parseArchitectureIr(codeWithCommand).ok).toBe(false);
  });

  it('platforms는 service에만, environment는 인프라와 deploy_target에만, account는 cloud_account 밖에만 쓴다', () => {
    expect(parseArchitectureIr(withNode(fixture(), 'gw', { platforms: ['web'] })).ok).toBe(false);
    expect(parseArchitectureIr(withNode(fixture(), 's-orders', { environment: 'prod' })).ok).toBe(
      false,
    );
    expect(parseArchitectureIr(withNode(fixture(), 'acct-dev', { account: 'acct-prod' })).ok).toBe(
      false,
    );
    expect(
      parseArchitectureIr(withNode(fixture(), 'svc-shop', { platforms: ['web', 'web'] })).ok,
    ).toBe(false);
  });

  it('engine은 datastore에만 쓴다', () => {
    const ir = fixture();
    ir.nodes.push(node('db', 'datastore', { engine: 'mysql' }));
    expect(parseArchitectureIr(ir).ok).toBe(true);
    expect(parseArchitectureIr(withNode(fixture(), 'gw', { engine: 'mysql' })).ok).toBe(false);
  });
});

describe('검증기 — 선 모양과 live 규칙', () => {
  it('code 근거가 함께 있으면 실선, live만 있으면 점선이다', () => {
    const v = validated();
    const style = (id: string) => v.ir.edges.find((e) => e.id === id)!.lineStyle;
    expect(style('o-dev')).toBe('solid');
    expect(style('rs-dev')).toBe('dashed');
    expect(style('sv-stage')).toBe('dashed');
  });

  it('live 근거만 있는 엣지를 실선으로 내면 거부한다', () => {
    const ir = fixture();
    ir.edges = ir.edges.map((e) => (e.id === 'rs-dev' ? { ...e, lineStyle: 'solid' } : e));
    const result = validateArchitectureIr(ir, { checkFiles: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'SOLID_EDGE_WITHOUT_EVIDENCE',
        edgeId: 'rs-dev',
      });
      expect(result.errors[0]!.message).toContain('live');
    }
  });

  it('private live 근거에 응답 원문을 넣으면 거부한다', () => {
    const ir = withNode(fixture(), 'cdn-prod', {
      evidence: [{ ...liveEv(LIST_DIST), excerpt: '{"DistributionList": {}}' }],
    });
    const result = validateArchitectureIr(ir, { checkFiles: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0]).toMatchObject({
        code: 'PRIVATE_EXCERPT_PRESENT',
        nodeId: 'cdn-prod',
      });
      expect(result.errors[0]!.message).toContain('live');
    }
  });

  it('읽기 전용이 아닌 명령을 live 근거로 쓰면 거부한다', () => {
    const ir = withNode(fixture(), 'cdn-prod', {
      evidence: [liveEv('aws cloudfront create-invalidation --distribution-id X')],
    });
    expect(errorsOf(ir)).toEqual(['LIVE_COMMAND_NOT_READ_ONLY']);
  });

  it('account는 있는 cloud_account 노드를 가리켜야 한다', () => {
    expect(errorsOf(withNode(fixture(), 'b-dev', { account: 'acct-none' }))).toEqual([
      'ACCOUNT_NOT_FOUND',
    ]);
    expect(errorsOf(withNode(fixture(), 'b-dev', { account: 'gw' }))).toEqual([
      'INVALID_ACCOUNT_KIND',
    ]);
  });

  it('id에 계정 ID나 CDN 배포 ID가 들어 있으면 거부한다', () => {
    const ir = fixture();
    ir.nodes.push(node(`b-${PROD_ACCOUNT}-logs`, 'bucket'), node(`cdn:${DIST_ID}`, 'cdn'));
    // 같은 꼴이라도 cdn이 아니면 배포 ID로 보지 않는다
    ir.nodes.push(node(`gw-${DIST_ID}`, 'gateway'));
    ir.edges.push(edge(`e-${DEV_ACCOUNT}`, 'gw', 'ep-orders', 'routes'));
    const result = validateArchitectureIr(ir, { checkFiles: false });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((e) => e.nodeId ?? e.edgeId)).toEqual([
        `b-${PROD_ACCOUNT}-logs`,
        `cdn:${DIST_ID}`,
        `e-${DEV_ACCOUNT}`,
      ]);
      expect(new Set(result.errors.map((e) => e.code))).toEqual(new Set(['CLOUD_ID_IN_ID']));
    }
  });

  it('근거 없는 android와 ios는 플랫폼마다 미해결 질문이 되고 버킷이 서빙하는 web은 묻지 않는다', () => {
    const v = validated();
    const questions = v.autoUnresolved.filter((q) => q.id.startsWith('auto:platform:'));
    expect(questions.map((q) => q.id)).toEqual([
      'auto:platform:svc-shop:android',
      'auto:platform:svc-shop:ios',
    ]);
    expect(questions[0]!.question).toContain('Android 앱');
  });

  it('SSR 서버가 서빙하는 web도 묻지 않는다', () => {
    const v = validated(withNode(withSsr(), 'svc-admin', { platforms: ['web'] }));
    expect(v.autoUnresolved.map((q) => q.id)).not.toContain('auto:platform:svc-admin:web');
  });

  it('platformEvidence가 있으면 묻지 않고 그 근거도 검증한다', () => {
    const ir = withNode(fixture(), 'svc-shop', {
      platforms: ['android'],
      platformEvidence: { android: [{ ...codeEv, visibility: 'private', excerpt: 'x' }] },
    });
    expect(errorsOf(ir)).toEqual(['PRIVATE_EXCERPT_PRESENT']);
    const ok = withNode(fixture(), 'svc-shop', {
      platforms: ['android'],
      platformEvidence: { android: [codeEv] },
    });
    expect(validated(ok).autoUnresolved.some((q) => q.id.startsWith('auto:platform:'))).toBe(false);
  });
});

describe('공유본 가리기', () => {
  it('live 근거는 public이어도 명령과 위치를 지우고 조회 시각만 남긴다', () => {
    const ir = withNode(fixture(), 'cdn-prod', {
      evidence: [{ ...liveEv(LIST_DIST), visibility: 'public', excerpt: 'Id: X' }],
    });
    const shared = redactForSharing(ir);
    expect(shared.nodes.find((n) => n.id === 'cdn-prod')!.evidence).toEqual([
      { type: 'live', visibility: 'public', observedAt: '2026-01-02T03:04:05Z' },
    ]);
    // 입력은 그대로다
    expect(ir.nodes.find((n) => n.id === 'cdn-prod')!.evidence[0]!.command).toBe(LIST_DIST);
  });

  it('노드 이름의 계정 ID와 cdn 이름의 배포 ID, 플랫폼 근거의 private 위치를 가린다', () => {
    const ir = withNode(fixture(), 'svc-shop', {
      platformEvidence: {
        ios: [{ type: 'doc', location: 'https://wiki.example.com/ios', visibility: 'private' }],
      },
    });
    const shared = redactForSharing(ir);
    const byId = new Map(shared.nodes.map((n) => [n.id, n]));
    expect(byId.get('acct-prod')!.label).toBe('[계정 ID]');
    expect(byId.get('cdn-dev')!.label).toBe('[배포 ID]');
    expect(byId.get('svc-shop')!.platformEvidence).toEqual({
      ios: [{ type: 'doc', visibility: 'private' }],
    });
    expect(JSON.stringify(shared)).not.toContain(PROD_ACCOUNT);
    expect(JSON.stringify(shared)).not.toContain(DIST_ID);
  });
});

describe('서비스 사실', () => {
  it('플랫폼은 웹, AOS, iOS 순서이고 근거 있는 것만 든다', () => {
    const v = validated(
      withNode(fixture(), 'svc-shop', {
        platforms: ['ios', 'android'],
        platformEvidence: { ios: [codeEv] },
      }),
    );
    const facts = computeServiceFacts(v.ir.nodes, v.ir.edges);
    expect(facts.get('svc-shop')!.platforms).toEqual(['web', 'ios']);
    expect(facts.get('svc-admin')!.platforms).toEqual([]);
  });

  it('도메인은 prod, stage, qa, dev 순서이고 prod 도메인을 따로 낸다', () => {
    const v = validated();
    const f = computeServiceFacts(v.ir.nodes, v.ir.edges).get('svc-shop')!;
    expect(f.domains.map((d) => d.environment)).toEqual(['prod', 'stage', 'dev']);
    expect(f.prodDomain).toBe('shop.example.com');
    expect(f.servingBuckets).toEqual(['b-dev', 'b-prod', 'b-stage']);
  });

  it('버킷이 서빙하면 정적, 배포 대상이 서빙하면 SSR이고 도메인은 서버에서 바로 찾는다', () => {
    const v = validated(withSsr());
    const facts = computeServiceFacts(v.ir.nodes, v.ir.edges);
    expect(facts.get('svc-shop')!.webHosting).toBe('static');
    const admin = facts.get('svc-admin')!;
    expect(admin.webHosting).toBe('ssr');
    expect(admin.platforms).toEqual(['web']);
    expect(admin.servingTargets).toEqual(['dt-admin']);
    expect(admin.prodDomain).toBe('admin.example.com');
  });

  it('서빙 방식은 prod 서빙 노드로 정하고 prod에 버킷과 서버가 둘 다 있으면 SSR이다', () => {
    const ir = withSsr();
    const stageSsr: ArchitectureIr = {
      ...ir,
      nodes: [...ir.nodes, node('dt-shop-stage', 'deploy_target', { environment: 'stage' })],
      edges: [...ir.edges, edge('sv-shop-stage', 'dt-shop-stage', 'svc-shop', 'serves')],
    };
    let v = validated(stageSsr);
    expect(computeServiceFacts(v.ir.nodes, v.ir.edges).get('svc-shop')!.webHosting).toBe('static');
    const prodBoth: ArchitectureIr = {
      ...ir,
      edges: [...ir.edges, edge('sv-shop-ssr', 'dt-admin', 'svc-shop', 'serves')],
    };
    v = validated(prodBoth);
    expect(computeServiceFacts(v.ir.nodes, v.ir.edges).get('svc-shop')!.webHosting).toBe('ssr');
  });

  it('환경 순위는 정한 순서, 그 밖의 환경, 환경 없음 순이다', () => {
    expect(['dev', undefined, 'alpha', 'qa', 'prod', 'stage'].sort(compareEnvironment)).toEqual([
      'prod',
      'stage',
      'qa',
      'dev',
      'alpha',
      undefined,
    ]);
    expect(environmentRank('prod')).toBeLessThan(environmentRank('zeta'));
  });
});

function columnOrder(layout: LayoutResult, ids: string[]): string[] {
  return layout.nodes
    .filter((n) => ids.includes(n.id))
    .sort((a, b) => a.y - b.y)
    .map((n) => n.id);
}

function serviceLevel(levels: DrillLevel[]): DrillLevel {
  return levels.find((l) => l.id === 'service:svc-shop')!;
}

describe('서비스 레벨 인프라 레인', () => {
  it('레인이 도메인, CDN, 버킷, 서비스, 기능 영역, 화면, 게이트웨이, 서버 순으로 선다', async () => {
    const level = serviceLevel((await computeDrilldown(validated())).levels);
    expect(level.layout.lanes.map((l) => l.id)).toEqual([
      'domain',
      'cdn',
      'bucket',
      'service',
      'unit',
      'screen',
      'gateway',
      'app_module',
    ]);
  });

  it('SSR 서버가 서빙하면 도메인, 배포 대상 레인이 앞에 선다', async () => {
    const levels = (await computeDrilldown(validated(withSsr()))).levels;
    const level = levels.find((l) => l.id === 'service:svc-admin')!;
    expect(level.layout.lanes.map((l) => l.id).slice(0, 2)).toEqual(['domain', 'deploy_target']);
    expect(level.layout.nodes.map((n) => n.id)).toEqual(
      expect.arrayContaining(['d-admin', 'dt-admin', 'svc-admin']),
    );
  });

  it('서비스 카드가 버킷 다음 열에서 버킷과 같은 높이에 서고 기능 영역으로 포함 선을 낸다', async () => {
    const level = serviceLevel((await computeDrilldown(validated())).levels);
    const box = (id: string) => level.layout.nodes.find((n) => n.id === id)!;
    expect(box('svc-shop').x).toBeGreaterThan(box('b-prod').x);
    expect(box('svc-shop').x).toBeLessThan(box('f-orders').x);
    expect(box('svc-shop').y).toBe(box('b-prod').y);
    expect(level.edges.find((e) => e.kind === 'contains' && e.from === 'svc-shop')).toMatchObject({
      from: 'svc-shop',
      to: 'f-orders',
      memberEdgeIds: [],
    });
  });

  it('환경이 prod, stage, dev 순서로 위에서부터 선다', async () => {
    const level = serviceLevel((await computeDrilldown(validated())).levels);
    expect(columnOrder(level.layout, ['d-dev', 'd-prod', 'd-stage'])).toEqual([
      'd-prod',
      'd-stage',
      'd-dev',
    ]);
    expect(columnOrder(level.layout, ['b-dev', 'b-prod', 'b-stage'])).toEqual([
      'b-prod',
      'b-stage',
      'b-dev',
    ]);
  });

  it('서빙 인프라가 없는 서비스도 서비스 카드에서 위계를 시작한다', async () => {
    const levels = (await computeDrilldown(validated())).levels;
    const admin = levels.find((l) => l.id === 'service:svc-admin')!;
    expect(admin.nodeIds).toContain('svc-admin');
    expect(admin.layout.lanes[0]!.id).toBe('service');
  });

  it('포함 선 덕에 도메인에서 출발한 포커스가 서버까지 닿는다', async () => {
    const level = serviceLevel((await computeDrilldown(validated())).levels);
    const out = new Map<string, string[]>();
    for (const e of level.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
    const seen = new Set(['d-prod']);
    const queue = ['d-prod'];
    while (queue.length > 0) {
      for (const n of out.get(queue.shift()!) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    expect(seen.has('m-orders')).toBe(true);
    expect(seen.has('d-dev')).toBe(false);
  });
});

describe('평면 그림 인프라 레인', () => {
  function deployIr(): ArchitectureIr {
    const ir = fixture();
    return {
      ...ir,
      view: 'deploy-path',
      nodes: ir.nodes.filter((n) => ['bucket', 'cdn', 'domain', 'cloud_account'].includes(n.kind)),
      edges: ir.edges.filter((e) => e.kind === 'origin' || e.kind === 'resolves_to'),
    };
  }

  it('버킷, CDN, 도메인 순으로 오른쪽에 서고 요청 방향 선은 오른쪽에서 왼쪽으로 그린다', async () => {
    const v = validated(deployIr());
    const layout = await computeLayout(v.ir, v.drawableNodeIds, v.drawableEdgeIds);
    const laneIds = layout.lanes.map((l) => l.id);
    expect(laneIds.indexOf('bucket')).toBeLessThan(laneIds.indexOf('cdn'));
    expect(laneIds.indexOf('cdn')).toBeLessThan(laneIds.indexOf('domain'));
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    const box = (id: string) => layout.nodes.find((n) => n.id === id)!;
    // 화살촉이 도착 카드(버킷) 오른쪽 끝에 붙는다
    const tip =
      /class="link e-origin[^"]*" data-from="cdn-prod" data-to="b-prod">.*?<path class="tip" d="M([\d.]+) /.exec(
        html,
      );
    expect(tip).not.toBeNull();
    expect(Number(tip![1])).toBeCloseTo(box('b-prod').x + box('b-prod').width + 32, 1);
  });

  it('같은 레인 안에서 환경 순서를 지킨다', async () => {
    const v = validated(deployIr());
    const layout = await computeLayout(v.ir, v.drawableNodeIds, v.drawableEdgeIds);
    expect(columnOrder(layout, ['cdn-dev', 'cdn-prod', 'cdn-stage'])).toEqual([
      'cdn-prod',
      'cdn-stage',
      'cdn-dev',
    ]);
  });

  it('계정을 넘는 선만 x-account로 그리고 범례에 싣는다', async () => {
    const v = validated(deployIr());
    const layout = await computeLayout(v.ir, v.drawableNodeIds, v.drawableEdgeIds);
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    const crossing = [
      ...html.matchAll(/<g class="link e-[a-z_]+ x-account" data-from="([^"]+)"/g),
    ].map((m) => m[1]);
    // cdn-dev(prod 계정) → b-dev(dev 계정)만 넘는다. 도메인은 계정이 없어 넘는다고 하지 않는다
    expect(crossing).toEqual(['cdn-dev']);
    expect(html).toContain('색 선: 클라우드 계정을 넘는 연결');
  });
});

describe('pinToColumnTop', () => {
  it('열 맨 위로 올리고 위에 있던 카드를 그만큼 내리며 옮긴 노드를 적는다', () => {
    const layout: LayoutResult = {
      width: 200,
      height: 200,
      nodes: [
        { id: 'a', x: 0, y: 0, width: 100, height: 48 },
        { id: 'b', x: 0, y: 72, width: 100, height: 60 },
        { id: 'c', x: 150, y: 0, width: 50, height: 48 },
      ],
      edges: [],
      lanes: [],
    };
    const pinned = pinToColumnTop(layout, 'b');
    expect(pinned.nodes.map((n) => [n.id, n.y])).toEqual([
      ['a', 84],
      ['b', 0],
      ['c', 0],
    ]);
    expect(pinned.movedNodeIds).toEqual(['a', 'b']);
    expect(pinToColumnTop(layout, 'a')).toBe(layout);
  });
});

describe('routeCanvas backward', () => {
  it('출발 카드 왼쪽에서 도착 카드 오른쪽으로 잇고 화살촉이 왼쪽을 본다', () => {
    const layout: LayoutResult = {
      width: 400,
      height: 100,
      nodes: [
        { id: 'left', x: 0, y: 0, width: 100, height: 48 },
        { id: 'right', x: 250, y: 0, width: 100, height: 48 },
      ],
      edges: [],
      lanes: [],
    };
    const r = routeCanvas(layout, [
      { id: 'e', from: 'right', to: 'left', width: 2, backward: true },
    ]).edges.get('e')!;
    expect(r.d.startsWith('M282 ')).toBe(true);
    expect(r.tip.startsWith('M132 ')).toBe(true);
  });
});

describe('렌더 — 서비스 카드와 결정성', () => {
  it('전체 화면 서비스 카드에 플랫폼 칩과 prod 도메인을 싣고 앱 칩은 브랜드 색 로고를 쓴다', async () => {
    const v = validated(
      withNode(fixture(), 'svc-shop', {
        platforms: ['ios', 'android'],
        platformEvidence: { android: [codeEv], ios: [codeEv] },
      }),
    );
    const html = renderDrilldownHtml(v, await computeDrilldown(v), { audience: 'private' });
    const root = html.slice(html.indexOf('data-level-id="root"'), html.indexOf('</section>'));
    const card = root.slice(root.indexOf('data-node-id="svc-shop"'));
    const labels = [...card.matchAll(/class="pf pf-[a-z]+" role="img" aria-label="([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(labels.slice(0, 3)).toEqual(['웹', 'Android 앱', 'iOS 앱']);
    expect(card).toContain('>웹</span>');
    expect(card).toContain('<span class="tc dom">shop.example.com</span>');
    // 칩은 이름 줄이 아니라 도메인 줄에 붙어 이름이 칩 몫만큼 잘리지 않는다
    const nameLine = card.slice(
      card.indexOf('<span class="nm">'),
      card.indexOf('<span class="l2">'),
    );
    expect(nameLine).not.toContain('class="pf');
    expect(card).toContain(
      '<span class="l2"><span class="tc dom">shop.example.com</span><span class="pf pf-',
    );
    expect(card).toContain(
      '<svg class="brand b-android" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#p-android"/>',
    );
    expect(card).toContain(
      '<svg class="brand b-ios" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#p-ios"/>',
    );
    expect(card).toContain(
      '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#p-web"/>',
    );
  });

  it('SSR 서비스 카드는 웹(SSR) 칩을 단다', async () => {
    const v = validated(withSsr());
    const html = renderDrilldownHtml(v, await computeDrilldown(v), { audience: 'private' });
    const root = html.slice(html.indexOf('data-level-id="root"'), html.indexOf('</section>'));
    const card = root.slice(root.indexOf('data-node-id="svc-admin"'));
    expect(card).toContain('aria-label="SSR 웹 (서버 렌더)"');
    expect(card).toContain('웹(SSR)</span>');
  });

  it('공유본에는 계정 ID, 배포 ID, 조회 명령이 없고 개인본에는 명령이 있다', async () => {
    const v = validated();
    const drill = await computeDrilldown(v);
    const privateHtml = renderDrilldownHtml(v, drill, { audience: 'private' });
    const shared = renderDrilldownHtml(v, drill, { audience: 'shared' });
    expect(privateHtml).toContain(LIST_DIST);
    for (const secret of [PROD_ACCOUNT, DEV_ACCOUNT, DIST_ID, LIST_DIST]) {
      expect(shared).not.toContain(secret);
    }
    expect(shared).toContain('2026-01-02T03:04:05Z');
  });

  it('같은 입력이면 같은 바이트가 나온다', async () => {
    const a = validated();
    const b = validated({ ...fixture(), nodes: [...fixture().nodes].reverse() });
    const htmlA = renderDrilldownHtml(a, await computeDrilldown(a), { audience: 'shared' });
    const htmlB = renderDrilldownHtml(b, await computeDrilldown(b), { audience: 'shared' });
    expect(htmlB).toBe(htmlA);
  });
});

describe('이전 실행 병합', () => {
  it('account 참조도 물려받은 id로 바꾸고 클라우드 식별자가 든 옛 id는 물려받지 않는다', () => {
    const prev = fixture();
    prev.nodes = prev.nodes.map((n) => {
      if (n.id === 'acct-prod') return { ...n, id: 'acct-main' };
      if (n.id === 'cdn-dev') return { ...n, id: `cdn:${DIST_ID}` };
      return n;
    });
    const merged = mergeWithPrevious(prev, fixture());
    const byId = new Map(merged.nodes.map((n) => [n.id, n]));
    expect(byId.has('acct-main')).toBe(true);
    expect(byId.get('b-prod')!.account).toBe('acct-main');
    expect(byId.has('cdn-dev')).toBe(true);
    expect(byId.has(`cdn:${DIST_ID}`)).toBe(false);
  });
});

describe('렌더 — 환경 고르기', () => {
  it('환경 버튼을 prod, stage, dev 순으로 달고 처음엔 prod만 켠다', async () => {
    const v = validated();
    const html = renderDrilldownHtml(v, await computeDrilldown(v), { audience: 'private' });
    const picker = html.slice(
      html.indexOf('id="env-picker"'),
      html.indexOf('</div>', html.indexOf('id="env-picker"')),
    );
    const buttons = [...picker.matchAll(/data-env="([^"]+)" aria-pressed="(true|false)"/g)].map(
      (m) => [m[1], m[2]],
    );
    expect(buttons).toEqual([
      ['prod', 'true'],
      ['stage', 'false'],
      ['dev', 'false'],
    ]);
  });

  it('환경이 있는 카드에만 환경을 싣는다. 브라우저가 이걸 보고 숨긴다', async () => {
    const v = validated();
    const html = renderDrilldownHtml(v, await computeDrilldown(v), { audience: 'private' });
    const level = html.slice(html.indexOf('data-level-id="service:svc-shop"'));
    const section = level.slice(0, level.indexOf('</section>'));
    expect(section).toMatch(/data-node-id="d-dev" data-env="dev"/);
    expect(section).toMatch(/data-node-id="b-prod" data-env="prod"/);
    expect(section).not.toMatch(/data-node-id="svc-shop"[^>]*data-env=/);
  });

  it('환경이 하나뿐이면 고를 게 없어서 버튼을 안 단다', async () => {
    const ir = fixture();
    const off = new Set(
      ir.nodes
        .filter((n) => n.environment !== undefined && n.environment !== 'prod')
        .map((n) => n.id),
    );
    const v = validated({
      ...ir,
      nodes: ir.nodes.filter((n) => !off.has(n.id)),
      edges: ir.edges.filter((e) => !off.has(e.from) && !off.has(e.to)),
    });
    const html = renderDrilldownHtml(v, await computeDrilldown(v), { audience: 'private' });
    expect(html).not.toContain('id="env-picker"');
  });
});

describe('렌더 — 데이터 저장소 엔진 로고', () => {
  const engineOf = (extra: Partial<ArchitectureNode>) =>
    datastoreEngine(node('db', 'datastore', extra));

  it('engine이 없으면 label에서 엔진을 찾고 관리형 서비스 이름이 앞에 붙어도 잡는다', () => {
    expect(engineOf({ label: 'aurora-mysql:orders-prod' })).toBe('mysql');
    expect(engineOf({ label: 'redis:session-cache' })).toBe('redis');
    expect(engineOf({ label: 'docdb:catalog' })).toBe('documentdb');
    expect(engineOf({ label: 'elasticsearch:search' })).toBe('elasticsearch');
    expect(engineOf({ label: 'mariadb-legacy' })).toBe('mariadb');
    expect(engineOf({ label: 'orders-store' })).toBeUndefined();
  });

  it('engine이 있으면 label보다 먼저 보고 datastore가 아니면 엔진이 없다', () => {
    expect(engineOf({ label: 'redis-like-queue', engine: 'PostgreSQL' })).toBe('postgresql');
    expect(datastoreEngine(node('ep', 'endpoint', { label: 'mysql' }))).toBeUndefined();
  });

  it('아는 엔진은 종류 칩에 브랜드 색 로고를 달고 모르는 엔진은 원통 아이콘을 그대로 쓴다', async () => {
    const ir = fixture();
    ir.nodes.push(
      node('db-orders', 'datastore', { label: 'aurora-mysql:orders' }),
      node('db-misc', 'datastore', { label: 'orders-store' }),
    );
    ir.edges.push(
      edge('rw1', 'm-orders', 'db-orders', 'reads_writes'),
      edge('rw2', 'm-orders', 'db-misc', 'reads_writes'),
    );
    const v = validated(ir);
    const html = renderArchitectureHtml(
      v,
      await computeLayout(v.ir, v.drawableNodeIds, v.drawableEdgeIds),
      { audience: 'private' },
    );
    const card = (id: string) =>
      html.slice(html.indexOf(`data-node-id="${id}"`)).split('</div>')[0]!;
    expect(card('db-orders')).toContain(
      '<svg class="brand b-mysql" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><use href="#e-mysql"/>',
    );
    expect(card('db-misc')).toContain('<use href="#i-datastore"/>');
    expect(html).toContain('<symbol id="e-redis" viewBox="0 0 24 24"><g fill="currentColor">');
    // 어두운 화면에서 검정 애플 로고가 묻히지 않게 흰색으로 바꾼다
    expect(html).toContain('.b-ios{--brand:#000000;--brand-on-white:#000000;}');
    expect(html).toContain(':root[data-theme="dark"] .b-ios{--brand:#ffffff;}');
  });
});
