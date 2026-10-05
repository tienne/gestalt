import type {
  ArchitectureEdge,
  ArchitectureFlow,
  ArchitectureIr,
  ArchitectureNode,
  Evidence,
} from '../../../src/architecture/index.js';

// 팩을 나누기 전부터 있던 그림 다섯 가지. 모든 이름은 가공이다.
// 이 IR들의 HTML 해시는 html-hashes.json에 있다. 팩 구조 이전 커밋의 렌더러로 뽑았다.

const code = (location: string): Evidence => ({ type: 'code', location, visibility: 'public' });
const doc = (location: string): Evidence => ({ type: 'doc', location, visibility: 'public' });
const live = (command: string, location = 'aws:cloudfront'): Evidence => ({
  type: 'live',
  location,
  visibility: 'private',
  command,
  observedAt: '2026-01-01T00:00:00.000Z',
});
const LIST_DIST = 'aws cloudfront list-distributions --profile acme-prod';

function node(
  id: string,
  kind: ArchitectureNode['kind'],
  extra: Partial<ArchitectureNode> = {},
): ArchitectureNode {
  return { id, kind, label: id, repo: 'web', evidence: [code(`web:src/${id}.ts:1`)], ...extra };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: ArchitectureEdge['kind'],
  evidence: Evidence[] = [code(`web:src/${id}.ts:2`)],
  extra: Partial<ArchitectureEdge> = {},
): ArchitectureEdge {
  const lineStyle = evidence.some((e) => e.type === 'code' || e.type === 'spec')
    ? 'solid'
    : 'dashed';
  return { id, from, to, kind, evidence, lineStyle, ...extra };
}

const base = (generatedAt: string): Omit<ArchitectureIr, 'nodes' | 'edges'> => ({
  schemaVersion: '1.0.0',
  view: 'screen-chain',
  repos: [{ id: 'web', name: 'acme-web', root: '/srv/acme-web' }],
  unresolved: [],
  sourcesUsed: [],
  generatedAt,
});

/** 서비스 구조: 드릴다운, 서빙 인프라, 플랫폼, 마이크로 프론트엔드, 저장소, private 근거 */
export function webIr(): ArchitectureIr {
  return {
    ...base('2026-01-01T00:00:00.000Z'),
    nodes: [
      node('svc-shop', 'service', {
        platforms: ['web', 'android', 'ios'],
        platformEvidence: {
          android: [code('web:android/build.gradle:1')],
          ios: [code('web:ios/Podfile:1')],
        },
      }),
      node('svc-admin', 'service'),
      node('mfa-host', 'micro_app', { parent: 'svc-admin' }),
      node('mfa-orders', 'micro_app', { parent: 'svc-admin' }),
      node('f-orders', 'feature', { parent: 'svc-shop' }),
      node('f-cart', 'feature', { parent: 'svc-shop' }),
      node('s-list', 'screen', { parent: 'f-orders', displayName: '주문 목록' }),
      node('s-detail', 'screen', { parent: 'f-orders' }),
      node('s-cart', 'screen', { parent: 'f-cart' }),
      node('s-admin', 'screen', { parent: 'mfa-orders' }),
      node('gw', 'gateway'),
      node('ep-orders', 'endpoint', { label: 'GET /orders' }),
      node('ep-cart', 'endpoint', { label: 'POST /cart' }),
      node('ep-admin', 'endpoint', { label: 'GET /admin/orders' }),
      node('m-orders', 'app_module'),
      node('m-cart', 'app_module'),
      node('x-pay', 'external_service'),
      node('ds-main', 'datastore', { engine: 'mysql', environment: 'prod' }),
      node('t-orders', 'db_table', {
        parent: 'ds-main',
        evidence: [
          code('web:src/t-orders.ts:1'),
          { type: 'doc', location: 'https://wiki.acme.test/db', visibility: 'private' },
        ],
      }),
      node('acct-prod', 'cloud_account', {
        label: '000000000000',
        evidence: [live('aws sts get-caller-identity --profile acme-prod', 'aws:sts')],
      }),
      node('b-prod', 'bucket', { environment: 'prod', account: 'acct-prod' }),
      node('b-dev', 'bucket', { environment: 'dev', account: 'acct-prod' }),
      node('cdn-prod', 'cdn', { environment: 'prod', account: 'acct-prod' }),
      node('d-prod', 'domain', { label: 'shop.example.com', environment: 'prod' }),
    ],
    edges: [
      edge('c1', 's-list', 'ep-orders', 'calls'),
      edge('c2', 's-detail', 'ep-orders', 'calls'),
      edge('c3', 's-cart', 'ep-cart', 'calls'),
      edge('c4', 's-admin', 'ep-admin', 'calls'),
      edge('l1', 'mfa-host', 'mfa-orders', 'loads'),
      edge('r1', 'gw', 'ep-orders', 'routes'),
      edge('r2', 'gw', 'ep-cart', 'routes'),
      edge('h1', 'ep-orders', 'm-orders', 'handles'),
      edge('h2', 'ep-cart', 'm-cart', 'handles'),
      edge('h3', 'ep-admin', 'm-orders', 'handles'),
      edge('u1', 'm-cart', 'x-pay', 'uses'),
      edge('k1', 'x-pay', 'm-orders', 'calls', [doc('https://docs.acme.test/pay')]),
      edge('rw1', 'm-orders', 't-orders', 'reads_writes'),
      edge('n1', 's-cart', 's-list', 'navigates'),
      edge('sv-prod', 'b-prod', 'svc-shop', 'serves'),
      edge('sv-dev', 'b-dev', 'svc-shop', 'serves', [live(LIST_DIST)]),
      edge('o-prod', 'cdn-prod', 'b-prod', 'origin'),
      edge('rs-prod', 'd-prod', 'cdn-prod', 'resolves_to'),
    ],
    unresolved: [{ id: 'q1', subject: { nodeId: 'x-pay' }, question: '결제 대행사가 둘인가요?' }],
  };
}

function queueFlow(): ArchitectureFlow {
  const step = (
    id: string,
    actor: string,
    label: string,
    extra: Partial<ArchitectureFlow['steps'][number]> = {},
  ) => ({ id, actor, label, evidence: [code(`web:src/${id}.ts:1`)], ...extra });
  const tr = (
    id: string,
    from: string,
    to: string,
    path: 'main' | 'side',
    extra: Partial<ArchitectureFlow['transitions'][number]> = {},
  ) => ({
    id,
    from,
    to,
    path,
    evidence: [code(`web:src/${id}.ts:5`)],
    lineStyle: 'solid' as const,
    ...extra,
  });
  return {
    id: 'queue',
    service: 'svc-shop',
    title: '줄서기',
    stateLabels: { WAITING: '대기', CALL: '호출됨' },
    actors: [
      { id: 'guest', label: '손님', kind: 'person' },
      { id: 'staff', label: '직원', kind: 'person' },
      { id: 'sys', label: '자동 발송', kind: 'system' },
    ],
    steps: [
      step('st-register', 'guest', '줄 등록', { state: 'WAITING', refs: ['s-list', 'ep-orders'] }),
      step('st-notify', 'sys', '등록 알림'),
      step('st-call', 'staff', '호출', { state: 'CALL' }),
      step('st-seat', 'staff', '입장', { state: 'SITTING', terminal: true }),
      step('st-cancel', 'guest', '직접 취소', { terminal: true }),
      step('st-noshow', 'sys', '노쇼 처리', { evidence: [doc('https://docs.acme.test/queue')] }),
      step('st-undo', 'staff', '되돌리기'),
    ],
    transitions: [
      tr('t-1', 'st-register', 'st-notify', 'main'),
      tr('t-2', 'st-notify', 'st-call', 'main'),
      tr('t-3', 'st-call', 'st-seat', 'main', { label: '착석' }),
      tr('t-4', 'st-notify', 'st-cancel', 'side'),
      tr('t-5', 'st-call', 'st-noshow', 'side', {
        label: 'N분 경과',
        evidence: [doc('https://docs.acme.test/queue')],
        lineStyle: 'dashed',
      }),
      tr('t-6', 'st-noshow', 'st-undo', 'side'),
      tr('t-7', 'st-undo', 'st-notify', 'side', { label: '30분 안', actors: ['staff', 'guest'] }),
    ],
  };
}

/** 서비스 흐름: 행위자 줄, 단계, 전이, 기술 그림 구간 */
export function flowIr(): ArchitectureIr {
  return {
    ...webIr(),
    flows: [queueFlow()],
    stages: [
      { id: 'app', label: '앱', kinds: ['service', 'micro_app', 'feature', 'screen'] },
      {
        id: 'api',
        label: 'API 서버',
        nodes: ['gw', 'ep-orders', 'ep-cart', 'ep-admin', 'm-orders', 'm-cart'],
      },
      { id: 'db', label: 'DB', kinds: ['datastore', 'db_table'] },
    ],
  };
}

/** 하네스: 클라이언트, 스킬, 에이전트, MCP 도구, 흐름 */
export function harnessIr(): ArchitectureIr {
  const at = (location: string): Evidence[] => [code(`acme:${location}`)];
  const n = (
    id: string,
    kind: ArchitectureNode['kind'],
    where: string,
    extra: Partial<ArchitectureNode> = {},
  ): ArchitectureNode => ({ id, kind, label: id, repo: 'acme', evidence: at(where), ...extra });
  const e = (
    id: string,
    from: string,
    to: string,
    kind: ArchitectureEdge['kind'],
    where: string,
    extra: Partial<ArchitectureEdge> = {},
  ): ArchitectureEdge => ({
    id,
    from,
    to,
    kind,
    evidence: at(where),
    lineStyle: 'solid',
    ...extra,
  });
  const ev = at('skills/build/SKILL.md:5');
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'acme', name: 'acme-harness', root: '/repos/acme-harness' }],
    nodes: [
      n('client:claude', 'client', '.claude-plugin/plugin.json:1'),
      n('client:codex', 'client', 'plugin/.codex-plugin/plugin.json:1'),
      n('svc', 'service', 'package.json:2'),
      n('feat:pipeline', 'feature', '', {
        parent: 'svc',
        evidence: [{ type: 'doc', location: 'acme:skills/README.md', visibility: 'public' }],
      }),
      n('skill:plan', 'skill', 'skills/plan/SKILL.md:1', { parent: 'feat:pipeline' }),
      n('skill:build', 'skill', 'skills/build/SKILL.md:1', { parent: 'feat:pipeline' }),
      n('skill:review', 'skill', 'skills/review/SKILL.md:1', { parent: 'feat:pipeline' }),
      n('agent:reviewer', 'agent', 'agents/reviewer/AGENT.md:1'),
      n('tool:plan', 'endpoint', 'src/server.ts:10', {
        protocol: 'mcp',
        mcpServer: 'acme',
        actions: ['start', 'respond'],
      }),
      n('tool:review', 'endpoint', 'src/server.ts:20', {
        protocol: 'mcp',
        mcpServer: 'acme',
        actions: ['run', 'submit'],
      }),
      n('tool:stats', 'endpoint', 'src/server.ts:30', {
        protocol: 'mcp',
        mcpServer: 'acme',
        parent: 'svc',
      }),
      n('mod:plan-handler', 'app_module', 'src/tools/plan.ts:1'),
      n('mod:review-handler', 'app_module', 'src/tools/review.ts:1'),
      n('mod:stats-handler', 'app_module', 'src/tools/stats.ts:1'),
      n('mod:engine', 'app_module', 'src/engine/index.ts:1'),
      n('store:events', 'datastore', 'src/events/store.ts:1'),
    ],
    edges: [
      e('e:load-claude', 'client:claude', 'svc', 'loads', '.claude-plugin/plugin.json:1'),
      e('e:load-codex', 'client:codex', 'svc', 'loads', 'plugin/.codex-plugin/plugin.json:1'),
      e('e:plan-calls', 'skill:plan', 'tool:plan', 'calls', 'skills/plan/SKILL.md:12', {
        actions: ['start', 'respond'],
      }),
      e('e:build-invokes', 'skill:build', 'skill:plan', 'invokes', 'skills/build/SKILL.md:8'),
      e('e:review-spawns', 'skill:review', 'agent:reviewer', 'spawns', 'skills/review/SKILL.md:9'),
      e('e:review-calls', 'skill:review', 'tool:review', 'calls', 'skills/review/SKILL.md:4', {
        actions: ['run'],
      }),
      e('e:agent-calls', 'agent:reviewer', 'tool:review', 'calls', 'agents/reviewer/AGENT.md:7', {
        actions: ['submit'],
      }),
      e('e:plan-handles', 'tool:plan', 'mod:plan-handler', 'handles', 'src/server.ts:11'),
      e('e:review-handles', 'tool:review', 'mod:review-handler', 'handles', 'src/server.ts:21'),
      e('e:stats-handles', 'tool:stats', 'mod:stats-handler', 'handles', 'src/server.ts:31'),
      e('e:plan-uses', 'mod:plan-handler', 'mod:engine', 'uses', 'src/tools/plan.ts:3'),
      e('e:review-uses', 'mod:review-handler', 'mod:engine', 'uses', 'src/tools/review.ts:3'),
      e('e:engine-store', 'mod:engine', 'store:events', 'reads_writes', 'src/engine/index.ts:9'),
    ],
    unresolved: [],
    sourcesUsed: [
      { via: 'repo', identifier: 'acme', readOnly: true, probeHit: true, visibility: 'public' },
    ],
    flows: [
      {
        id: 'pipeline',
        service: 'svc',
        title: '계획에서 리뷰까지',
        actors: [
          { id: 'user', label: '사용자', kind: 'person' },
          { id: 'model', label: '세션 모델', kind: 'agent' },
          { id: 'server', label: 'MCP 서버', kind: 'system' },
        ],
        steps: [
          { id: 'ask', actor: 'user', label: '빌드 요청', refs: ['skill:build'], evidence: ev },
          { id: 'plan', actor: 'model', label: '계획 세우기', refs: ['skill:plan'], evidence: ev },
          {
            id: 'save',
            actor: 'server',
            label: '세션 저장',
            refs: ['tool:plan'],
            terminal: true,
            evidence: ev,
          },
        ],
        transitions: [
          { id: 't1', from: 'ask', to: 'plan', path: 'main', evidence: ev, lineStyle: 'solid' },
          { id: 't2', from: 'plan', to: 'save', path: 'main', evidence: ev, lineStyle: 'solid' },
        ],
      },
    ],
    generatedAt: '2026-10-04T00:00:00.000Z',
  };
}

/** 배포 경로: 워크플로에서 빌드, 산출물, 배포 대상, 버킷, CDN, 도메인 */
export function deployIr(): ArchitectureIr {
  return {
    ...base('2026-01-02T00:00:00.000Z'),
    view: 'deploy-path',
    nodes: [
      node('wf-release', 'workflow'),
      node('b-web', 'build'),
      node('a-bundle', 'artifact'),
      node('a-image', 'artifact'),
      node('dt-api', 'deploy_target', { environment: 'prod' }),
      node('dt-api-dev', 'deploy_target', { environment: 'dev' }),
      node('bk-prod', 'bucket', { environment: 'prod' }),
      node('cdn-prod', 'cdn', { environment: 'prod' }),
      node('d-prod', 'domain', { label: 'shop.example.com', environment: 'prod' }),
    ],
    edges: [
      edge('t1', 'wf-release', 'b-web', 'triggers'),
      edge('bd1', 'b-web', 'a-bundle', 'produces'),
      edge('bd2', 'b-web', 'a-image', 'produces'),
      edge('dp1', 'a-bundle', 'bk-prod', 'deploys_to'),
      edge('dp2', 'a-image', 'dt-api', 'deploys_to'),
      edge('dp3', 'a-image', 'dt-api-dev', 'deploys_to', [doc('https://docs.acme.test/deploy')]),
      edge('o1', 'cdn-prod', 'bk-prod', 'origin'),
      edge('rs1', 'd-prod', 'cdn-prod', 'resolves_to'),
    ],
  };
}

/** 합친 그림의 두 번째 제품. webIr와 게이트웨이와 주문 서버를 같이 쓴다 */
export function partnerIr(): ArchitectureIr {
  return {
    ...base('2026-01-03T00:00:00.000Z'),
    repos: [
      { id: 'web', name: 'acme-web', root: '/srv/acme-web' },
      { id: 'partner', name: 'acme-partner', root: '/srv/acme-partner' },
    ],
    nodes: [
      node('svc-partner', 'service', { repo: 'partner' }),
      node('f-sales', 'feature', { parent: 'svc-partner', repo: 'partner' }),
      node('s-sales', 'screen', { parent: 'f-sales', repo: 'partner' }),
      node('gw', 'gateway'),
      node('ep-sales', 'endpoint', { label: 'GET /sales' }),
      node('ep-orders', 'endpoint', { label: 'GET /orders' }),
      node('m-orders', 'app_module'),
    ],
    edges: [
      edge('c1', 's-sales', 'ep-sales', 'calls'),
      edge('c2', 's-sales', 'ep-orders', 'calls'),
      edge('r1', 'gw', 'ep-sales', 'routes'),
      edge('r2', 'gw', 'ep-orders', 'routes'),
      edge('h1', 'ep-sales', 'm-orders', 'handles'),
      edge('h2', 'ep-orders', 'm-orders', 'handles'),
    ],
  };
}
