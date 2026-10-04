import { describe, expect, it } from 'vitest';
import {
  computeDrilldown,
  displayKindOf,
  mergeArchitectureIrs,
  parseArchitectureIr,
  renderDrilldownHtml,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureFlow,
  type ArchitectureIr,
  type ArchitectureNode,
  type DrillLevel,
  type Evidence,
  type ValidatedIr,
} from '../../../src/architecture/index.js';
import { matchMcpTools, splitClientToolName } from '../../../src/architecture/mcp-tool-match.js';

// 가짜 하네스 레포 acme-harness: 클라이언트 둘, 스킬 셋, MCP 도구 둘, 에이전트 하나
const at = (location: string): Evidence[] => [
  { type: 'code', location: `acme:${location}`, visibility: 'public' },
];

function node(
  id: string,
  kind: ArchitectureNode['kind'],
  where: string,
  extra: Partial<ArchitectureNode> = {},
): ArchitectureNode {
  return { id, kind, label: id, repo: 'acme', evidence: at(where), ...extra };
}

function edge(
  id: string,
  from: string,
  to: string,
  kind: ArchitectureEdge['kind'],
  where: string,
  extra: Partial<ArchitectureEdge> = {},
): ArchitectureEdge {
  return { id, from, to, kind, evidence: at(where), lineStyle: 'solid', ...extra };
}

function pipelineFlow(): ArchitectureFlow {
  const ev = at('skills/build/SKILL.md:5');
  return {
    id: 'pipeline',
    service: 'svc',
    title: '계획에서 리뷰까지',
    actors: [
      { id: 'user', label: '사용자', kind: 'person' },
      { id: 'model', label: '세션 모델', kind: 'agent' },
      { id: 'server', label: 'MCP 서버', kind: 'system' },
      { id: 'reviewer', label: '리뷰 에이전트', kind: 'agent' },
    ],
    steps: [
      { id: 'ask', actor: 'user', label: '빌드 요청', refs: ['skill:build'], evidence: ev },
      { id: 'plan', actor: 'model', label: '계획 세우기', refs: ['skill:plan'], evidence: ev },
      { id: 'save', actor: 'server', label: '세션 저장', refs: ['tool:plan'], evidence: ev },
      {
        id: 'review',
        actor: 'reviewer',
        label: '리뷰',
        refs: ['agent:reviewer'],
        terminal: true,
        evidence: ev,
      },
    ],
    transitions: [
      { id: 't1', from: 'ask', to: 'plan', path: 'main', evidence: ev, lineStyle: 'solid' },
      { id: 't2', from: 'plan', to: 'save', path: 'main', evidence: ev, lineStyle: 'solid' },
      { id: 't3', from: 'save', to: 'review', path: 'main', evidence: ev, lineStyle: 'solid' },
    ],
  };
}

function fixture(): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'acme', name: 'acme-harness', root: '/repos/acme-harness' }],
    nodes: [
      node('client:claude', 'client', '.claude-plugin/plugin.json:1'),
      node('client:codex', 'client', 'plugin/.codex-plugin/plugin.json:1'),
      node('svc', 'service', 'package.json:2'),
      // 스킬 묶음은 코드 줄이 없어 문서 근거로 단다. md를 code로 받는 건 스킬과 에이전트 카드뿐이다
      node('feat:pipeline', 'feature', '', {
        parent: 'svc',
        evidence: [{ type: 'doc', location: 'acme:skills/README.md', visibility: 'public' }],
      }),
      node('skill:plan', 'skill', 'skills/plan/SKILL.md:1', { parent: 'feat:pipeline' }),
      node('skill:build', 'skill', 'skills/build/SKILL.md:1', { parent: 'feat:pipeline' }),
      node('skill:review', 'skill', 'skills/review/SKILL.md:1', { parent: 'feat:pipeline' }),
      node('agent:reviewer', 'agent', 'agents/reviewer/AGENT.md:1'),
      node('tool:plan', 'endpoint', 'src/server.ts:10', {
        protocol: 'mcp',
        mcpServer: 'acme',
        actions: ['start', 'respond'],
      }),
      node('tool:review', 'endpoint', 'src/server.ts:20', {
        protocol: 'mcp',
        mcpServer: 'acme',
        actions: ['run', 'submit'],
      }),
      node('mod:plan-handler', 'app_module', 'src/tools/plan.ts:1'),
      node('mod:review-handler', 'app_module', 'src/tools/review.ts:1'),
      node('mod:engine', 'app_module', 'src/engine/index.ts:1'),
      node('store:events', 'datastore', 'src/events/store.ts:1', {
        evidence: [
          ...at('src/events/store.ts:1'),
          { type: 'doc', location: 'https://wiki.acme.test/secret', visibility: 'private' },
        ],
      }),
    ],
    edges: [
      edge('e:load-claude', 'client:claude', 'svc', 'loads', '.claude-plugin/plugin.json:1'),
      edge('e:load-codex', 'client:codex', 'svc', 'loads', 'plugin/.codex-plugin/plugin.json:1'),
      edge('e:plan-calls', 'skill:plan', 'tool:plan', 'calls', 'skills/plan/SKILL.md:12', {
        actions: ['start', 'respond'],
      }),
      edge('e:build-invokes', 'skill:build', 'skill:plan', 'invokes', 'skills/build/SKILL.md:8'),
      edge(
        'e:review-spawns',
        'skill:review',
        'agent:reviewer',
        'spawns',
        'skills/review/SKILL.md:9',
      ),
      edge('e:review-calls', 'skill:review', 'tool:review', 'calls', 'skills/review/SKILL.md:4', {
        actions: ['run'],
      }),
      edge(
        'e:agent-calls',
        'agent:reviewer',
        'tool:review',
        'calls',
        'agents/reviewer/AGENT.md:7',
        {
          actions: ['submit'],
        },
      ),
      edge('e:plan-handles', 'tool:plan', 'mod:plan-handler', 'handles', 'src/server.ts:11'),
      edge('e:review-handles', 'tool:review', 'mod:review-handler', 'handles', 'src/server.ts:21'),
      edge('e:plan-uses', 'mod:plan-handler', 'mod:engine', 'uses', 'src/tools/plan.ts:3'),
      edge('e:review-uses', 'mod:review-handler', 'mod:engine', 'uses', 'src/tools/review.ts:3'),
      edge('e:engine-store', 'mod:engine', 'store:events', 'reads_writes', 'src/engine/index.ts:9'),
    ],
    unresolved: [],
    sourcesUsed: [
      { via: 'repo', identifier: 'acme', readOnly: true, probeHit: true, visibility: 'public' },
    ],
    flows: [pipelineFlow()],
    generatedAt: '2026-10-04T00:00:00.000Z',
  };
}

function validated(ir: ArchitectureIr): ValidatedIr {
  const result = validateArchitectureIr(ir, { checkFiles: false });
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function errorCodes(ir: ArchitectureIr): string[] {
  const result = validateArchitectureIr(ir, { checkFiles: false });
  return result.ok ? [] : result.errors.map((e) => e.code);
}

/** 카드가 선 레인. 레이아웃 결과에는 레인 id가 카드에 안 붙어 x 범위로 찾는다 */
function laneOf(lv: DrillLevel, id: string): string | undefined {
  const n = lv.layout.nodes.find((x) => x.id === id)!;
  return lv.layout.lanes.find((l) => n.x >= l.x && n.x < l.x + l.width)?.id;
}

function level(levels: DrillLevel[], id: string): DrillLevel {
  const found = levels.find((l) => l.id === id);
  if (!found) throw new Error(`no level ${id}`);
  return found;
}

// 스킬 없이 도구만 내놓는 MCP 서버 레포. 클라이언트가 도구를 바로 부른다
function pureMcpServer(): ArchitectureIr {
  const tool = (id: string, line: number) =>
    node(id, 'endpoint', `src/index.ts:${line}`, {
      protocol: 'mcp',
      mcpServer: 'memory',
      parent: 'svc:memory',
    });
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [{ id: 'acme', name: 'acme-mcp', root: '/repo' }],
    nodes: [
      node('client:desktop', 'client', 'mcp.json:1'),
      node('svc:memory', 'service', 'package.json:2'),
      tool('tool:create', 10),
      tool('tool:read', 20),
      node('mod:memory', 'app_module', 'src/index.ts:1'),
    ],
    edges: [
      edge('e:loads', 'client:desktop', 'svc:memory', 'loads', 'mcp.json:3'),
      edge('e:create-handles', 'tool:create', 'mod:memory', 'handles', 'src/index.ts:11'),
      edge('e:read-handles', 'tool:read', 'mod:memory', 'handles', 'src/index.ts:21'),
    ],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-10-04T00:00:00.000Z',
  };
}

describe('하네스 IR 스키마와 검증', () => {
  it('클라이언트, 스킬, 에이전트, MCP 도구가 든 IR을 받는다', () => {
    expect(parseArchitectureIr(fixture()).ok).toBe(true);
    expect(errorCodes(fixture())).toEqual([]);
  });

  it('MCP 도구는 IR에서 endpoint로 남고 보여줄 때만 mcp_tool이다', () => {
    const ir = fixture();
    const tool = ir.nodes.find((n) => n.id === 'tool:plan')!;
    expect(tool.kind).toBe('endpoint');
    expect(displayKindOf(tool)).toBe('mcp_tool');
    expect(displayKindOf(ir.nodes.find((n) => n.id === 'skill:plan')!)).toBe('skill');
  });

  it('protocol은 endpoint에만, mcpServer와 actions는 mcp 도구에만 단다', () => {
    const onSkill = fixture() as unknown as { nodes: Record<string, unknown>[] };
    onSkill.nodes.find((n) => n['id'] === 'skill:plan')!['protocol'] = 'mcp';
    expect(parseArchitectureIr(onSkill).ok).toBe(false);

    const onHttp = fixture() as unknown as { nodes: Record<string, unknown>[] };
    const tool = onHttp.nodes.find((n) => n['id'] === 'tool:plan')!;
    tool['protocol'] = 'http';
    expect(parseArchitectureIr(onHttp).ok).toBe(false);
  });

  it('서비스를 parent로 두는 건 MCP 도구만 받는다', () => {
    const mcp = fixture();
    mcp.nodes.find((n) => n.id === 'tool:plan')!.parent = 'svc';
    expect(errorCodes(mcp)).not.toContain('INVALID_PARENT_KIND');

    const http = fixture();
    http.nodes.push(node('api:health', 'endpoint', 'src/server.ts:40', { parent: 'svc' }));
    expect(errorCodes(http)).toContain('INVALID_PARENT_KIND');

    const underFeature = fixture();
    underFeature.nodes.find((n) => n.id === 'tool:plan')!.parent = 'feat:pipeline';
    expect(errorCodes(underFeature)).toContain('INVALID_PARENT_KIND');
  });

  it('도구에 없는 action으로 부르면 거부한다', () => {
    const ir = fixture();
    ir.edges.find((e) => e.id === 'e:agent-calls')!.actions = ['delete'];
    expect(errorCodes(ir)).toContain('UNKNOWN_MCP_ACTION');
  });

  it('스킬이 엔드포인트 아닌 곳을 calls로 부르거나 화면이 에이전트를 띄우면 거부한다', () => {
    const toModule = fixture();
    toModule.edges.push(
      edge('e:bad-call', 'skill:plan', 'mod:engine', 'calls', 'skills/plan/SKILL.md:20'),
    );
    expect(errorCodes(toModule)).toContain('INVALID_HARNESS_EDGE_ENDS');

    const fromTool = fixture();
    fromTool.edges.push(
      edge('e:bad-spawn', 'tool:plan', 'agent:reviewer', 'spawns', 'src/server.ts:30'),
    );
    expect(errorCodes(fromTool)).toContain('INVALID_HARNESS_EDGE_ENDS');
  });

  it('하네스 IR에서는 스킬과 에이전트 밖의 md 줄을 code 근거로 받지 않는다', () => {
    const ir = fixture();
    ir.nodes.find((n) => n.id === 'mod:engine')!.evidence = at('docs/engine.md:3');
    expect(errorCodes(ir)).toContain('MD_CODE_EVIDENCE');
  });

  it('하네스 카드가 없는 IR은 md code 근거를 예전처럼 받는다', () => {
    const ir: ArchitectureIr = {
      ...fixture(),
      nodes: [node('svc', 'service', 'README.md:1'), node('mod:engine', 'app_module', 'a.ts:1')],
      edges: [],
      flows: [],
    };
    expect(errorCodes(ir)).toEqual([]);
  });
});

describe('하네스 드릴다운', () => {
  it('전체보기는 클라이언트, 플러그인, 핸들러와 엔진, 저장소를 세우고 엔진을 외부로 치지 않는다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const root = level(levels, 'root');
    expect(root.nodeIds).toEqual([
      'client:claude',
      'client:codex',
      'mod:engine',
      'mod:plan-handler',
      'mod:review-handler',
      'store:events',
      'svc',
    ]);
    const pairs = root.edges.map((e) => `${e.from}->${e.to}`);
    expect(pairs).toEqual(
      expect.arrayContaining([
        'client:claude->svc',
        'client:codex->svc',
        'svc->mod:plan-handler',
        'svc->mod:review-handler',
        'mod:plan-handler->mod:engine',
        'mod:engine->store:events',
      ]),
    );
    // 에이전트가 부른 도구도 띄운 스킬의 서비스로 올라와 묶이고 띄운 선이 묶음 안에 남는다
    const review = root.edges.find((e) => e.id === 'bundle:svc->mod:review-handler')!;
    expect(review.memberEdgeIds).toEqual(
      expect.arrayContaining(['e:agent-calls', 'e:review-spawns', 'e:review-calls']),
    );
    expect(laneOf(root, 'mod:engine')).toBe('app_module');
    expect(laneOf(root, 'client:claude')).toBe('client');
  });

  it('스킬이 안 부르는 도구의 핸들러가 쓰는 엔진도 외부 레인으로 보내지 않는다', async () => {
    const ir = fixture();
    ir.nodes.push(
      node('tool:sync', 'endpoint', 'src/server.ts:30', { protocol: 'mcp', mcpServer: 'acme' }),
      node('mod:sync-handler', 'app_module', 'src/tools/sync.ts:1'),
      node('mod:sync-engine', 'app_module', 'src/sync/index.ts:1'),
    );
    ir.edges.push(
      edge('e:sync-handles', 'tool:sync', 'mod:sync-handler', 'handles', 'src/server.ts:31'),
      edge('e:sync-uses', 'mod:sync-handler', 'mod:sync-engine', 'uses', 'src/tools/sync.ts:2'),
    );
    const root = level((await computeDrilldown(validated(ir))).levels, 'root');
    expect(laneOf(root, 'mod:sync-engine')).toBe('app_module');
  });

  it('스킬 없이 세션이 바로 부르는 도구는 parent 서비스에서 핸들러로 잇는다', async () => {
    const ir = pureMcpServer();
    const root = level((await computeDrilldown(validated(ir))).levels, 'root');
    const bundle = root.edges.find((e) => e.id === 'bundle:svc:memory->mod:memory')!;
    expect(bundle.count).toBe(2);
    expect(bundle.memberEdgeIds).toEqual(['e:create-handles', 'e:read-handles']);
    expect(laneOf(root, 'mod:memory')).toBe('app_module');
  });

  it('스킬이 부르는 도구는 parent가 있어도 서비스 묶음 건수를 늘리지 않는다', async () => {
    const before = level((await computeDrilldown(validated(fixture()))).levels, 'root');
    const ir = fixture();
    ir.nodes.find((n) => n.id === 'tool:plan')!.parent = 'svc';
    const after = level((await computeDrilldown(validated(ir))).levels, 'root');
    const count = (l: DrillLevel) => l.edges.find((e) => e.id === 'bundle:svc->mod:plan-handler')!;
    expect(count(after).count).toBe(count(before).count);
    expect(count(after).memberEdgeIds).toEqual(count(before).memberEdgeIds);
  });

  it('서비스 레벨은 스킬과 에이전트, 도구를 열로 나누고 띄우기와 스킬 호출 선을 그린다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const svc = level(levels, 'service:svc');
    expect(svc.nodeIds).toEqual(
      expect.arrayContaining(['skill:plan', 'skill:build', 'agent:reviewer', 'tool:review']),
    );
    const ids = svc.edges.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining(['e:review-spawns', 'e:build-invokes']));
    expect(laneOf(svc, 'tool:review')).toBe('tool');
    expect(laneOf(svc, 'agent:reviewer')).toBe('agent');
    const x = (id: string): number => svc.layout.nodes.find((n) => n.id === id)!.x;
    expect(x('skill:review')).toBeLessThan(x('agent:reviewer'));
    expect(x('agent:reviewer')).toBeLessThan(x('tool:review'));
  });

  it('기능 영역 레벨은 에이전트가 부른 도구와 그 핸들러까지 따라간다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const feat = level(levels, 'feature:feat:pipeline');
    const ids = feat.edges.map((e) => e.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'e:agent-calls',
        'e:review-spawns',
        'e:build-invokes',
        'e:review-handles',
      ]),
    );
  });

  it('엔진 서버 레벨은 부르는 핸들러와 쓰는 저장소를 보여준다', async () => {
    const { levels } = await computeDrilldown(validated(fixture()));
    const engine = level(levels, 'server:mod:engine');
    expect(engine.nodeIds).toEqual(
      expect.arrayContaining(['mod:plan-handler', 'mod:review-handler', 'store:events']),
    );
    expect(laneOf(engine, 'mod:plan-handler')).toBe('app_module');
  });

  it('전체보기에서 나가는 선 없는 핸들러도 엔진 열이 아니라 핸들러 열에 선다', async () => {
    // elk는 같은 열 묶음 안에서 나가는 선 없는 카드를 뒤쪽 층으로 민다. 엔진이 저장소로 이어지는 모양에서 드러난다
    const tool = (id: string, line: number) =>
      node(id, 'endpoint', `src/server.ts:${line}`, {
        protocol: 'mcp',
        mcpServer: 'acme',
        parent: 'svc',
      });
    const ir: ArchitectureIr = {
      ...pureMcpServer(),
      nodes: [
        node('svc', 'service', 'package.json:2'),
        tool('tool:sync', 10),
        tool('tool:review', 20),
        node('mod:sync-handler', 'app_module', 'src/tools/sync.ts:1'),
        node('mod:review-handler', 'app_module', 'src/tools/review.ts:1'),
        node('mod:memory', 'app_module', 'src/memory/index.ts:1'),
        node('mod:pr', 'app_module', 'src/pr/index.ts:1'),
        node('mod:graph', 'app_module', 'src/graph/index.ts:1'),
        node('store:memory', 'datastore', 'src/memory/index.ts:5'),
        node('store:reviews', 'datastore', 'src/pr/index.ts:5'),
        node('store:graph', 'datastore', 'src/graph/index.ts:5'),
      ],
      edges: [
        edge('e:sync-h', 'tool:sync', 'mod:sync-handler', 'handles', 'src/server.ts:11'),
        edge('e:review-h', 'tool:review', 'mod:review-handler', 'handles', 'src/server.ts:21'),
        edge('e:u-mem', 'mod:review-handler', 'mod:memory', 'uses', 'src/tools/review.ts:2'),
        edge('e:u-pr', 'mod:review-handler', 'mod:pr', 'uses', 'src/tools/review.ts:3'),
        edge('e:rw-mem', 'mod:memory', 'store:memory', 'reads_writes', 'src/memory/index.ts:6'),
        edge('e:rw-pr', 'mod:pr', 'store:reviews', 'reads_writes', 'src/pr/index.ts:6'),
        edge('e:rw-graph', 'mod:graph', 'store:graph', 'reads_writes', 'src/graph/index.ts:6'),
      ],
    };
    const root = level((await computeDrilldown(validated(ir))).levels, 'root');
    const x = (id: string) => root.layout.nodes.find((n) => n.id === id)!.x;
    expect(x('mod:sync-handler')).toBe(x('mod:review-handler'));
    expect(x('mod:memory')).toBeGreaterThan(x('mod:review-handler'));
  });

  it('흐름 레벨에서 에이전트 행위자 줄을 그리고 단계가 스킬과 도구 카드를 가리킨다', async () => {
    const v = validated(fixture());
    const drill = await computeDrilldown(v);
    expect(drill.flows.map((f) => f.id)).toEqual(['flow:pipeline']);
    const html = renderDrilldownHtml(v, drill, { audience: 'private' });
    expect(html).toContain('리뷰 에이전트');
    expect(html).toContain('href="#i-agent"');
  });

  it('HTML은 MCP 도구 칩을 달고 같은 입력이면 같은 바이트를 내며 공유본은 private 근거를 가린다', async () => {
    const v = validated(fixture());
    const drill = await computeDrilldown(v);
    const a = renderDrilldownHtml(v, drill, { audience: 'private' });
    const b = renderDrilldownHtml(v, await computeDrilldown(validated(fixture())), {
      audience: 'private',
    });
    expect(a).toBe(b);
    expect(a).toContain('MCP 도구');
    expect(a).toContain('k-mcp_tool');
    expect(a).toContain('wiki.acme.test/secret');
    const shared = renderDrilldownHtml(v, drill, { audience: 'shared' });
    expect(shared).not.toContain('wiki.acme.test/secret');
  });

  it('그림 제목은 화면이 없으면 스킬이나 MCP 도구 기준으로 고른다', async () => {
    const title = async (ir: ArchitectureIr) => {
      const v = validated(ir);
      const html = renderDrilldownHtml(v, await computeDrilldown(v), { audience: 'private' });
      return /<title>([^<]*)<\/title>/.exec(html)![1];
    };
    expect(await title(fixture())).toContain('스킬별 호출 흐름');
    expect(await title(pureMcpServer())).toContain('MCP 도구 호출 흐름');
  });
});

describe('MCP 도구 매칭', () => {
  const serverTools = [
    { id: 'tool:plan', server: 'acme', tool: 'acme_plan', actions: ['start', 'respond'] },
    { id: 'tool:review', server: 'acme', tool: 'acme_review' },
    { id: 'tool:other-review', server: 'other', tool: 'acme_review' },
  ];

  it('클라이언트 접두를 걷고 서버 이름은 플러그인 접두까지 받아준다', () => {
    expect(splitClientToolName('mcp__plugin_acme_acme__acme_plan')).toEqual({
      server: 'plugin_acme_acme',
      tool: 'acme_plan',
    });
    expect(splitClientToolName('acme_plan')).toEqual({ tool: 'acme_plan' });
  });

  it('이름이 정확히 같아야 잇고 못 이은 이유를 나눠 돌려준다', () => {
    const result = matchMcpTools({
      serverTools,
      skillToolCalls: [
        { id: 'c1', tool: 'mcp__plugin_acme_acme__acme_plan', action: 'start' },
        { id: 'c2', tool: 'acme_plan', action: 'delete' },
        { id: 'c3', tool: 'acme_review' },
        { id: 'c4', server: 'acme', tool: 'acme_review', action: 'anything' },
        { id: 'c5', tool: 'acme_pla' },
      ],
    });
    expect(result.matches).toEqual([
      { callId: 'c1', toolId: 'tool:plan', action: 'start' },
      { callId: 'c4', toolId: 'tool:review', action: 'anything' },
    ]);
    expect(result.unmatched).toEqual([
      { callId: 'c2', reason: 'unknown_action', candidates: ['tool:plan'] },
      { callId: 'c3', reason: 'multiple_tools', candidates: ['tool:other-review', 'tool:review'] },
      { callId: 'c5', reason: 'no_tool', candidates: [] },
    ]);
  });
});

describe('하네스 IR 합치기', () => {
  it('같은 도구를 두 분석이 다른 action으로 찾으면 합집합으로 합친다', () => {
    const a = fixture();
    const b = fixture();
    b.repos = [{ ...b.repos[0]! }];
    b.nodes.find((n) => n.id === 'tool:plan')!.actions = ['start', 'complete'];
    b.edges.find((e) => e.id === 'e:plan-calls')!.actions = ['complete'];
    const merged = mergeArchitectureIrs([a, b]);
    if (!merged.ok) throw new Error(JSON.stringify(merged.errors));
    const tool = merged.ir.nodes.find((n) => n.label === 'tool:plan')!;
    expect(tool.actions).toEqual(['complete', 'respond', 'start']);
    const call = merged.ir.edges.find((e) => e.kind === 'calls' && e.to === tool.id)!;
    expect(call.actions).toEqual(['complete', 'respond', 'start']);
    expect(errorCodes(merged.ir)).toEqual([]);
  });
});
