import { describe, expect, it } from 'vitest';
import {
  computeDrilldown,
  mergeArchitectureIrs,
  renderDrilldownHtml,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type DrillLevel,
  type Drilldown,
  type Evidence,
  type ValidatedIr,
} from '../../../src/architecture/index.js';

// 마이크로 프론트엔드 콘솔. 호스트 shell이 coupon, review, display 리모트를 불러오고 앱마다 버킷과 CDN, 도메인이 따로 있다.
// 이름과 계정은 전부 가짜다
const ACCOUNT = '000000000000';
const REMOTES = ['coupon', 'review', 'display'] as const;
const APPS = ['shell', ...REMOTES] as const;

const codeEv = (location: string): Evidence => ({ type: 'code', location, visibility: 'public' });

function node(
  id: string,
  kind: ArchitectureNode['kind'],
  extra: Partial<ArchitectureNode> = {},
): ArchitectureNode {
  return {
    id,
    kind,
    label: id,
    repo: 'console',
    evidence: [codeEv('console:apps/shell/src/index.ts:1')],
    ...extra,
  };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: ArchitectureEdge['kind'],
  location = 'console:infra/serving.ts:3',
): ArchitectureEdge {
  return { id, from, to, kind, evidence: [codeEv(location)], lineStyle: 'solid' };
}

function servingChain(
  app: string,
  env: 'prod' | 'dev',
): {
  nodes: ArchitectureNode[];
  edges: ArchitectureEdge[];
} {
  const host = app === 'shell' ? 'console' : `${app}.console`;
  const domain = env === 'prod' ? `${host}.acme.test` : `${host}.dev.acme.test`;
  return {
    nodes: [
      node(`b-${app}-${env}`, 'bucket', { environment: env, account: 'acct-prod' }),
      node(`cdn-${app}-${env}`, 'cdn', { environment: env, account: 'acct-prod' }),
      node(`d-${app}-${env}`, 'domain', { label: domain, environment: env }),
    ],
    edges: [
      edge(`sv-${app}-${env}`, `b-${app}-${env}`, `app-${app}`, 'serves'),
      edge(`o-${app}-${env}`, `cdn-${app}-${env}`, `b-${app}-${env}`, 'origin'),
      edge(`rs-${app}-${env}`, `d-${app}-${env}`, `cdn-${app}-${env}`, 'resolves_to'),
    ],
  };
}

function fixture(): ArchitectureIr {
  const chains = [...APPS.map((a) => servingChain(a, 'prod')), servingChain('shell', 'dev')];
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'console', name: 'acme-console', root: '/srv/acme-console' }],
    nodes: [
      node('svc-console', 'service', { displayName: 'Acme 콘솔' }),
      ...APPS.map((a) => node(`app-${a}`, 'micro_app', { label: a, parent: 'svc-console' })),
      ...APPS.flatMap((a) => [
        node(`f-${a}`, 'feature', { parent: `app-${a}` }),
        node(`s-${a}`, 'screen', { parent: `f-${a}` }),
      ]),
      node('acct-prod', 'cloud_account', { label: ACCOUNT }),
      node('gw', 'gateway'),
      node('ep-coupon', 'endpoint'),
      node('m-coupon', 'app_module'),
      ...chains.flatMap((c) => c.nodes),
    ],
    edges: [
      edge('c-coupon', 's-coupon', 'ep-coupon', 'calls'),
      edge('r-coupon', 'gw', 'ep-coupon', 'routes'),
      edge('h-coupon', 'ep-coupon', 'm-coupon', 'handles'),
      ...REMOTES.map((r) =>
        edge(
          `ld-${r}`,
          'app-shell',
          `app-${r}`,
          'loads',
          'console:apps/shell/module-federation.config.js:8',
        ),
      ),
      ...chains.flatMap((c) => c.edges),
    ],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function validated(ir: ArchitectureIr = fixture()): ValidatedIr {
  const result = validateArchitectureIr(ir, { checkFiles: false });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function level(d: Drilldown, id: string): DrillLevel {
  const found = d.levels.find((l) => l.id === id);
  if (!found) throw new Error(`level ${id} not found`);
  return found;
}

describe('micro_app 검증', () => {
  it('호스트가 하나면 진입 앱 질문 없이 통과한다', () => {
    const v = validated();
    expect(v.autoUnresolved.map((q) => q.id)).not.toContain('auto:entry:svc-console');
  });

  it('앱이 달린 서비스를 serves로 가리키면 거부한다', () => {
    const ir = fixture();
    ir.edges.push(edge('sv-bad', 'b-shell-prod', 'svc-console', 'serves'));
    const result = validateArchitectureIr(ir, { checkFiles: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.code)).toContain('SERVES_SERVICE_WITH_APPS');
  });

  it('loads 양 끝이 micro_app이 아니면 거부한다', () => {
    const ir = fixture();
    ir.edges.push(edge('ld-bad', 's-shell', 'app-coupon', 'loads'));
    const result = validateArchitectureIr(ir, { checkFiles: false });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.find((e) => e.edgeId === 'ld-bad')?.code).toBe('INVALID_LOADS_ENDS');
  });

  it('호스트로 보이는 앱이 여럿이면 진입 앱을 묻는다', () => {
    const ir = fixture();
    ir.edges = ir.edges.filter((e) => e.id !== 'ld-coupon');
    const v = validated(ir);
    const q = v.autoUnresolved.find((x) => x.id === 'auto:entry:svc-console');
    expect(q?.question).toContain('"shell"');
    expect(q?.question).toContain('"coupon"');
  });

  it('리모트 버킷만 서빙해도 서비스에 웹 플랫폼 질문을 만들지 않는다', () => {
    const v = validated();
    expect(v.autoUnresolved.some((q) => q.subject?.nodeId === 'svc-console')).toBe(false);
  });
});

describe('micro_app 드릴다운', () => {
  it('전체보기는 서비스 카드 아래 호스트부터 앱 카드를 이어 쌓고 테두리를 두른다', async () => {
    const root = level(await computeDrilldown(validated()), 'root');
    const frame = root.layout.frames?.find((f) => f.id === 'svc-console');
    expect(frame).toBeDefined();
    const box = (id: string) => root.layout.nodes.find((n) => n.id === id)!;
    const stack = ['svc-console', 'app-shell', ...[...REMOTES].sort().map((r) => `app-${r}`)];
    for (const [i, id] of stack.entries()) {
      const b = box(id);
      expect(b.x).toBe(box('svc-console').x);
      expect(b.x).toBeGreaterThan(frame!.x);
      expect(b.y + b.height).toBeLessThan(frame!.y + frame!.height);
      if (i > 0) expect(b.y).toBeGreaterThan(box(stack[i - 1]!).y);
    }
  });

  it('전체보기 화면 호출 묶음은 서비스가 아니라 화면 코드가 있는 앱에서 나간다', async () => {
    const root = level(await computeDrilldown(validated()), 'root');
    expect(root.edges.map((e) => e.id)).toContain('bundle:app-coupon->gw');
    expect(root.edges.some((e) => e.from === 'svc-console')).toBe(false);
    // 같은 서비스 안 로드는 테두리가 말해준다
    expect(root.edges.some((e) => e.kind === 'loads')).toBe(false);
  });

  it('앱 카드를 누르면 앱 레벨로, 서비스 카드를 누르면 서비스 레벨로 들어간다', async () => {
    const d = await computeDrilldown(validated());
    expect(d.enter['svc-console']).toBe('service:svc-console');
    expect(d.enter['app-coupon']).toBe('app:app-coupon');
    expect(d.enter['f-coupon']).toBe('feature:f-coupon');
  });

  it('서비스 레벨은 앱마다 prod 서빙 사슬을 따로 세우고 사슬은 자기 앱으로 이어진다', async () => {
    const svc = level(await computeDrilldown(validated()), 'service:svc-console');
    for (const a of APPS) {
      for (const id of [`app-${a}`, `b-${a}-prod`, `cdn-${a}-prod`, `d-${a}-prod`]) {
        expect(svc.nodeIds).toContain(id);
      }
    }
    expect(svc.nodeIds).not.toContain('b-shell-dev');
    const serves = svc.edges.filter((e) => e.kind === 'serves');
    expect(serves).toHaveLength(APPS.length);
    for (const e of serves) expect(e.to).toBe(`app-${e.from.split('-')[1]}`);
  });

  it('런타임 로드 선은 호스트에서 리모트 prod 도메인으로 가고 그 리모트 사슬만 담는다', async () => {
    const svc = level(await computeDrilldown(validated()), 'service:svc-console');
    const runtime = svc.edges.filter((e) => e.runtime);
    expect(runtime.map((e) => e.id).sort()).toEqual(REMOTES.map((r) => `runtime:ld-${r}`).sort());
    const coupon = runtime.find((e) => e.id === 'runtime:ld-coupon')!;
    expect(coupon).toMatchObject({ from: 'app-shell', to: 'd-coupon-prod', kind: 'loads' });
    expect(coupon.memberEdgeIds).toEqual([
      'ld-coupon',
      'o-coupon-prod',
      'rs-coupon-prod',
      'sv-coupon-prod',
    ]);
  });

  it('서비스 레벨은 호스트 줄과 리모트 줄을 띠로 나눈다', async () => {
    const svc = level(await computeDrilldown(validated()), 'service:svc-console');
    const regions = svc.layout.regions!;
    expect(regions.groups.map((g) => g.name)).toEqual([
      '호스트 (사용자 진입)',
      '리모트 (호스트가 런타임에 불러옴)',
    ]);
    expect(regions.bandOf['d-shell-prod']).toBe(0);
    expect(regions.bandOf['app-shell']).toBe(0);
    for (const r of REMOTES) expect(regions.bandOf[`b-${r}-prod`]).toBe(2);
  });

  it('앱 레벨은 그 앱의 기능 영역과 모든 환경 서빙 사슬만 보인다', async () => {
    const d = await computeDrilldown(validated());
    const coupon = level(d, 'app:app-coupon');
    expect(coupon.trail).toEqual(['root', 'service:svc-console', 'app:app-coupon']);
    expect(coupon.nodeIds).toEqual(
      expect.arrayContaining(['app-coupon', 'f-coupon', 'gw', 'b-coupon-prod']),
    );
    expect(coupon.nodeIds).not.toContain('f-shell');
    expect(coupon.nodeIds).not.toContain('b-shell-prod');
    expect(level(d, 'app:app-shell').nodeIds).toContain('b-shell-dev');
    expect(level(d, 'feature:f-coupon').trail).toEqual([
      'root',
      'service:svc-console',
      'app:app-coupon',
      'feature:f-coupon',
    ]);
  });

  it('리모트 사슬이 없으면 런타임 선 대신 앱 사이 로드 선을 그린다', async () => {
    const ir = fixture();
    ir.edges = ir.edges.filter((e) => e.id !== 'rs-review-prod');
    const svc = level(await computeDrilldown(validated(ir)), 'service:svc-console');
    expect(svc.edges.find((e) => e.id === 'ld-review')).toMatchObject({
      from: 'app-shell',
      to: 'app-review',
      kind: 'loads',
    });
  });
});

describe('micro_app 렌더', () => {
  async function render(ir: ArchitectureIr, audience: 'private' | 'shared'): Promise<string> {
    const v = validated(ir);
    return renderDrilldownHtml(v, await computeDrilldown(v), { audience });
  }

  it('테두리와 호스트 칩, 런타임 로드 선을 그린다', async () => {
    const html = await render(fixture(), 'private');
    expect(html).toContain('class="frame" data-frame-id="svc-console"');
    expect(html).toContain('data-frame="svc-console"');
    expect(html).toContain('class="link bundle runtime"');
    expect(html).toContain('"microHosts":["app-shell"]');
    expect(html).toMatch(/data-node-id="app-shell"[^>]*>.*?<span class="kc">.*?호스트<\/span>/);
    expect(html).toMatch(/data-node-id="app-coupon"[^>]*>.*?<span class="kc">.*?리모트<\/span>/);
  });

  it('같은 입력이면 같은 바이트가 나온다', async () => {
    expect(await render(fixture(), 'private')).toBe(await render(fixture(), 'private'));
  });

  it('공유본은 계정 ID를 싣지 않는다', async () => {
    expect(await render(fixture(), 'shared')).not.toContain(ACCOUNT);
  });

  it('micro_app이 없는 IR에는 테두리도 호스트 목록도 없다', async () => {
    const ir = fixture();
    const apps = new Set(ir.nodes.filter((n) => n.kind === 'micro_app').map((n) => n.id));
    ir.nodes = ir.nodes
      .filter((n) => !apps.has(n.id))
      .map((n) =>
        n.parent !== undefined && apps.has(n.parent) ? { ...n, parent: 'svc-console' } : n,
      );
    ir.edges = ir.edges
      .filter((e) => e.kind !== 'loads')
      .map((e) => (apps.has(e.to) ? { ...e, to: 'svc-console' } : e));
    const v = validated(ir);
    const d = await computeDrilldown(v);
    expect(d.levels.every((l) => l.layout.frames === undefined)).toBe(true);
    const html = renderDrilldownHtml(v, d, { audience: 'private' });
    expect(html).not.toContain('"microHosts":');
    expect(html).not.toContain('class="frame"');
  });
});

describe('micro_app 합치기', () => {
  const hostRepo = {
    id: 'console',
    name: 'acme-console',
    root: '/srv/acme-console',
    remote: 'git@git.acme.test:acme/console.git',
  };
  const couponRepo = {
    id: 'coupon',
    name: 'acme-coupon',
    root: '/srv/acme-coupon',
    remote: 'git@git.acme.test:acme/coupon.git',
  };

  function hostIr(service: string, host: string, repo = hostRepo): ArchitectureIr {
    const n = (id: string, kind: ArchitectureNode['kind'], extra: Partial<ArchitectureNode> = {}) =>
      ({ ...node(id, kind, extra), repo: repo.id }) as ArchitectureNode;
    return {
      schemaVersion: '1.0.0',
      view: 'screen-chain',
      repos: [repo],
      nodes: [
        n(service, 'service'),
        n(`app-${host}`, 'micro_app', { label: host, parent: service }),
        n('app-coupon', 'micro_app', { label: 'coupon', parent: service }),
      ],
      edges: [
        edge(
          'ld',
          `app-${host}`,
          'app-coupon',
          'loads',
          `${repo.id}:module-federation.config.js:4`,
        ),
      ],
      unresolved: [],
      sourcesUsed: [],
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  function couponIr(): ArchitectureIr {
    const n = (id: string, kind: ArchitectureNode['kind'], extra: Partial<ArchitectureNode> = {}) =>
      ({
        ...node(id, kind, extra),
        repo: 'coupon',
        evidence: [codeEv('coupon:src/pages/list.tsx:1')],
      }) as ArchitectureNode;
    return {
      schemaVersion: '1.0.0',
      view: 'screen-chain',
      repos: [couponRepo],
      nodes: [
        n('mf-coupon', 'micro_app', { label: 'coupon' }),
        n('f-list', 'feature', { parent: 'mf-coupon' }),
        n('s-list', 'screen', { parent: 'f-list' }),
      ],
      edges: [],
      unresolved: [],
      sourcesUsed: [],
      generatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('리모트를 자기 레포에서 분석한 쪽과 합쳐 앱 하나로 만들고 레포는 리모트 레포를 쓴다', () => {
    const merged = mergeArchitectureIrs([hostIr('svc-console', 'shell'), couponIr()]);
    if (!merged.ok) throw new Error(JSON.stringify(merged.errors));
    const coupons = merged.ir.nodes.filter((n) => n.kind === 'micro_app' && n.label === 'coupon');
    expect(coupons).toHaveLength(1);
    const coupon = coupons[0]!;
    const repo = merged.ir.repos.find((r) => r.id === coupon.repo);
    expect(repo?.remote).toBe(couponRepo.remote);
    expect(coupon.parent).toBe('svc-console');
    expect(merged.ir.nodes.find((n) => n.label === 'f-list')?.parent).toBe(coupon.id);
  });

  it('호스트 둘이 같이 쓰는 리모트는 질문 없이 서비스에서 떼어 따로 세운다', async () => {
    const partnerRepo = {
      id: 'partner',
      name: 'acme-partner',
      root: '/srv/acme-partner',
      remote: 'git@git.acme.test:acme/partner.git',
    };
    const merged = mergeArchitectureIrs([
      hostIr('svc-console', 'shell'),
      hostIr('svc-partner', 'partner-shell', partnerRepo),
      couponIr(),
    ]);
    if (!merged.ok) throw new Error(JSON.stringify(merged.errors));
    const coupon = merged.ir.nodes.find((n) => n.kind === 'micro_app' && n.label === 'coupon')!;
    expect(coupon.parent).toBeUndefined();
    expect(merged.ir.unresolved.some((q) => q.id.startsWith('merge:parent'))).toBe(false);

    const root = level(await computeDrilldown(validated(merged.ir)), 'root');
    const loads = root.edges.filter((e) => e.kind === 'loads');
    expect(loads.map((e) => e.to)).toEqual([coupon.id, coupon.id]);
    expect(root.layout.frames?.map((f) => f.id).sort()).toEqual(['svc-console', 'svc-partner']);
  });
});
