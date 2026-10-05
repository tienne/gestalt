import { describe, expect, it } from 'vitest';
import {
  computeDrilldown,
  mergeArchitectureIrs,
  mergeWithPrevious,
  parseArchitectureIr,
  renderArchitectureHtml,
  validateArchitectureIr,
  type ArchitectureEdge,
  type ArchitectureIr,
  type ArchitectureNode,
  type ArchitectureStage,
  type ValidatedIr,
} from '../../../src/architecture/index.js';
import { assignStages, computeLayout, UNSTAGED_LABEL } from '../../../src/architecture/layout.js';

// 가짜 줄서기 앱. 앱 화면이 줄서기 서버를 부른다. 줄서기 서버는 알림 서버를 부르고 둘 다 DB를 쓴다.
// 서버 둘은 종류가 같아 종류별 레인으로는 한 열에 겹친다. 구간을 나누면 왼쪽에서 오른쪽으로 갈라 선다

function node(id: string, kind: ArchitectureNode['kind'], repo: string): ArchitectureNode {
  return {
    id,
    kind,
    label: id,
    repo,
    evidence: [{ type: 'code', location: `${repo}:src/${id}.ts:1`, visibility: 'public' }],
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
    evidence: [{ type: 'code', location: `api:src/${id}.ts:1`, visibility: 'public' }],
    lineStyle: 'solid',
  };
}

const STAGES: ArchitectureStage[] = [
  { id: 'app', label: '앱', kinds: ['screen'] },
  { id: 'queue', label: '줄서기 서버', kinds: ['endpoint', 'app_module'], repos: ['api'] },
  { id: 'notify', label: '알림 서버', kinds: ['endpoint', 'app_module'], repos: ['notify'] },
  { id: 'db', label: 'DB', kinds: ['db_table'] },
];

function fixture(stages: ArchitectureStage[] | null = STAGES): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [
      { id: 'app', name: 'acme-app', root: '/srv/acme-app' },
      { id: 'api', name: 'acme-api', root: '/srv/acme-api' },
      { id: 'notify', name: 'acme-notify', root: '/srv/acme-notify' },
    ],
    nodes: [
      node('s-queue', 'screen', 'app'),
      node('ep-register', 'endpoint', 'api'),
      node('m-queue', 'app_module', 'api'),
      node('ep-send', 'endpoint', 'notify'),
      node('m-notify', 'app_module', 'notify'),
      node('t-waiting', 'db_table', 'api'),
    ],
    edges: [
      edge('e-1', 's-queue', 'ep-register', 'calls'),
      edge('e-2', 'ep-register', 'm-queue', 'handles'),
      edge('e-3', 'm-queue', 'ep-send', 'calls'),
      edge('e-4', 'ep-send', 'm-notify', 'handles'),
      edge('e-5', 'm-queue', 't-waiting', 'reads_writes'),
      edge('e-6', 'm-notify', 't-waiting', 'reads_writes'),
    ],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-10-01T00:00:00.000Z',
    ...(stages !== null ? { stages } : {}),
  };
}

function validated(ir: ArchitectureIr): ValidatedIr {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

function errorsOf(ir: ArchitectureIr): string[] {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  return r.ok ? [] : r.errors.map((e) => e.code);
}

async function layoutOf(ir: ArchitectureIr) {
  const v = validated(ir);
  return { v, layout: await computeLayout(v.ir, v.drawableNodeIds, v.drawableEdgeIds) };
}

describe('기술 그림 구간 스키마와 검증', () => {
  it('stages가 있는 IR을 읽는다', () => {
    expect(parseArchitectureIr(fixture()).ok).toBe(true);
  });

  it('구간 kinds에 없는 종류를 쓰면 거부한다', () => {
    const ir = fixture([{ id: 'x', label: 'x', kinds: ['server' as never] }]);
    expect(parseArchitectureIr(ir).ok).toBe(false);
  });

  it('구간 id가 겹치거나 없는 노드를 올리면 거부한다', () => {
    expect(
      errorsOf(
        fixture([
          { id: 'a', label: 'a', nodes: ['nope'] },
          { id: 'a', label: 'b' },
        ]),
      ),
    ).toEqual(expect.arrayContaining(['DUPLICATE_STAGE_ID', 'STAGE_NODE_NOT_FOUND']));
  });

  it('한 노드를 두 구간에 이름으로 올리면 거부한다', () => {
    expect(
      errorsOf(
        fixture([
          { id: 'a', label: 'a', nodes: ['m-queue'] },
          { id: 'b', label: 'b', nodes: ['m-queue'] },
        ]),
      ),
    ).toContain('STAGE_NODE_TWICE');
  });
});

describe('구간 정하기', () => {
  it('kinds와 repos가 둘 다 맞는 첫 구간에 넣는다', () => {
    const staged = assignStages(fixture())!;
    const at = (id: string) => staged.indexOf.get(id);
    expect([
      at('s-queue'),
      at('ep-register'),
      at('m-queue'),
      at('ep-send'),
      at('m-notify'),
      at('t-waiting'),
    ]).toEqual([0, 1, 1, 2, 2, 3]);
    expect(staged.labels).toEqual(['앱', '줄서기 서버', '알림 서버', 'DB']);
  });

  it('이름으로 올린 구간이 종류 규칙보다 먼저다', () => {
    const stages = [...STAGES];
    stages[3] = { ...stages[3]!, nodes: ['m-notify'] };
    expect(assignStages(fixture(stages))!.indexOf.get('m-notify')).toBe(3);
  });

  it('어느 구간에도 안 맞으면 맨 끝 구간에 모은다', () => {
    const staged = assignStages(fixture(STAGES.slice(0, 3)))!;
    expect(staged.indexOf.get('t-waiting')).toBe(3);
    expect(staged.labels.at(-1)).toBe(UNSTAGED_LABEL);
    expect(staged.unstaged).toBe(1);
  });

  it('구간이 없으면 정하지 않는다', () => {
    expect(assignStages(fixture(null))).toBeUndefined();
  });
});

describe('구간 배치', () => {
  it('레인 하나가 구간 하나고 제목은 구간 이름이다', async () => {
    const { layout } = await layoutOf(fixture());
    expect(layout.lanes.map((l) => l.title)).toEqual(['앱', '줄서기 서버', '알림 서버', 'DB']);
  });

  it('종류가 같은 서버 둘도 구간 순서대로 왼쪽에서 오른쪽으로 선다', async () => {
    const { layout } = await layoutOf(fixture());
    const x = (id: string) => layout.nodes.find((n) => n.id === id)!.x;
    expect(x('m-queue')).toBeLessThan(x('ep-send'));
    expect(x('m-notify')).toBeLessThan(x('t-waiting'));
  });

  it('구간 레인은 서로 겹치지 않는다', async () => {
    const { layout } = await layoutOf(fixture());
    for (const [a, b] of layout.lanes.slice(1).map((l, i) => [layout.lanes[i]!, l] as const)) {
      expect(a.x + a.width).toBeLessThanOrEqual(b.x);
    }
  });

  it('구간이 없으면 종류별 레인 제목을 쓴다', async () => {
    const { layout } = await layoutOf(fixture(null));
    expect(layout.lanes.map((l) => l.title)).toContain('서버');
    expect(layout.lanes.some((l) => l.id.startsWith('stage:'))).toBe(false);
  });

  it('평면 그림 레인 제목에 구간 이름을 그린다', async () => {
    const { v, layout } = await layoutOf(fixture());
    const html = renderArchitectureHtml(v, layout, { audience: 'private' });
    expect(html).toMatch(/class="lane-title"[^>]*>알림 서버</);
  });

  it('드릴다운 레벨에서도 구간 레인을 쓴다', async () => {
    const drill = await computeDrilldown(validated(fixture()));
    const titles = drill.levels.flatMap((l) => l.layout.lanes.map((x) => x.title));
    expect(titles).toContain('줄서기 서버');
    expect(titles).not.toContain('서버');
  });
});

describe('구간 병합', () => {
  it('이전 실행과 합쳐도 구간이 남는다', () => {
    const merged = mergeWithPrevious(fixture(), fixture());
    expect(merged.stages?.map((s) => s.id)).toEqual(['app', 'queue', 'notify', 'db']);
  });

  it('분석 둘을 합치면 같은 id 구간은 하나로 묶는다', () => {
    const a = fixture([{ id: 'db', label: 'DB', kinds: ['db_table'], repos: ['api'] }]);
    const b = fixture([
      { id: 'app', label: '앱', kinds: ['screen'] },
      { id: 'db', label: 'DB', kinds: ['datastore'] },
    ]);
    const r = mergeArchitectureIrs([a, b]);
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const stages = r.ir.stages!;
    expect(stages.map((s) => s.id)).toEqual(['db', 'app']);
    expect(stages[0]!.kinds).toEqual(['db_table', 'datastore']);
    expect(stages[0]!.repos).toBeUndefined();
  });
});
