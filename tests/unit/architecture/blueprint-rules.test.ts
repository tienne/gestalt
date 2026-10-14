import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ArchitectureStore,
  mergeWithPrevious,
  parseArchitectureIr,
  validateArchitectureIr,
  type ArchitectureIr,
  type ProjectionSlice,
} from '../../../src/architecture/index.js';
import {
  deriveBlueprint,
  type BlueprintModel,
} from '../../../src/architecture/blueprint-layout.js';
import { architectureInputSchema } from '../../../src/mcp/schemas.js';
import { handleArchitecturePassthrough } from '../../../src/mcp/tools/architecture-passthrough.js';
import { flowIr, harnessIr, webIr } from '../../fixtures/architecture-legacy/irs.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

type Projection = NonNullable<ArchitectureIr['projections']>[number];

const BP: Projection = {
  id: 'queue-bp',
  shape: 'blueprint',
  title: '줄서기 블루프린트',
  question: '손님이 줄을 서는 동안 뒤에서는 무엇이 일하나요?',
  messages: [],
  flow: 'queue',
};

function withBp(ir: ArchitectureIr = flowIr()): ArchitectureIr {
  return { ...ir, projections: [BP] };
}

function codes(ir: ArchitectureIr): string[] {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  return r.ok ? [] : r.errors.map((e) => e.code);
}

function modelOf(ir: ArchitectureIr): BlueprintModel {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const v = r.value;
  return deriveBlueprint(v.ir.flows!.find((f) => f.id === 'queue')!, {
    nodes: v.ir.nodes,
    edges: v.ir.edges,
    drawableNodeIds: v.drawableNodeIds,
    drawableEdgeIds: v.drawableEdgeIds,
    drawableStepIds: v.drawableStepIds,
    drawableTransitionIds: v.drawableTransitionIds,
  });
}

const ids = (items: { id: string }[]): string[] => items.map((it) => it.id);

describe('blueprint 검증 규칙', () => {
  it('blueprint가 없는 기존 IR은 그대로 통과하고 blueprint 경고도 없다', () => {
    for (const make of [flowIr, webIr, harnessIr]) {
      const r = validateArchitectureIr(make(), { checkFiles: false });
      expect(r.ok).toBe(true);
      if (r.ok)
        expect(r.value.warnings.filter((w) => w.code === 'BLUEPRINT_OVER_BUDGET')).toEqual([]);
    }
  });

  it('messages가 비어있지 않으면 모양 오용이다', () => {
    const p: Projection = {
      ...BP,
      messages: [
        {
          id: 'm1',
          from: 's-list',
          to: 'ep-orders',
          label: '호출',
          order: 1,
          evidence: [],
          lineStyle: 'dashed',
        },
      ],
    };
    expect(codes({ ...flowIr(), projections: [p] })).toContain('PROJECTION_SHAPE_FIELD');
  });

  it('blocks, phases, sides가 있어도 모양 오용이다', () => {
    expect(codes({ ...flowIr(), projections: [{ ...BP, blocks: [] }] })).toContain(
      'PROJECTION_SHAPE_FIELD',
    );
    expect(codes({ ...flowIr(), projections: [{ ...BP, phases: [] }] })).toContain(
      'PROJECTION_SHAPE_FIELD',
    );
    expect(codes({ ...flowIr(), projections: [{ ...BP, sides: [] }] })).toContain(
      'PROJECTION_SHAPE_FIELD',
    );
  });

  it('다른 모양이 flow를 가리키면 오용이고 flows가 없는 IR에서 blueprint는 흐름을 못 찾는다', () => {
    expect(codes({ ...flowIr(), projections: [{ ...BP, shape: 'sequence' }] })).toContain(
      'PROJECTION_SHAPE_FIELD',
    );
    const noFlows = webIr();
    expect(codes({ ...noFlows, projections: [BP] })).toContain('PROJECTION_FLOW_NOT_FOUND');
  });

  it('갈림길 말고 단계가 없는 흐름은 PROJECTION_EMPTY다', () => {
    const ir = withBp();
    const flow = ir.flows![0]!;
    flow.steps = flow.steps
      .filter((s) => s.id === 'st-register')
      .map((s) => ({ ...s, kind: 'decision' as const }));
    flow.transitions = [];
    expect(codes(ir)).toContain('PROJECTION_EMPTY');
  });

  it('JSON으로 저장했다 다시 읽어도 파싱된다', () => {
    const r = parseArchitectureIr(JSON.parse(JSON.stringify(withBp())));
    expect(r.ok).toBe(true);
  });
});

describe('blueprint 행 배정', () => {
  it('system과 agent 단계는 백스테이지다', () => {
    const ir = withBp();
    const flow = ir.flows![0]!;
    flow.actors = flow.actors.map((a) => (a.id === 'sys' ? { ...a, kind: 'agent' as const } : a));
    expect(ids(modelOf(ir).columns[1]!.cells.backstage)).toEqual(['st-notify']);
  });

  it('actors에서 먼저 나온 person이 고객이다', () => {
    const ir = withBp();
    const flow = ir.flows![0]!;
    flow.actors = [flow.actors[1]!, flow.actors[0]!, flow.actors[2]!];
    const m = modelOf(ir);
    expect(m.customer).toBe('staff');
    // 호출 단계는 이제 고객 행동이고 손님의 등록 단계는 프론트스테이지로 내려간다
    expect(ids(m.columns[2]!.cells.customer)).toEqual(['st-call']);
    expect(ids(m.columns[0]!.cells.frontstage)).toContain('st-register');
    expect(ids(m.columns[0]!.cells.customer)).toEqual([]);
  });

  it('person이 없으면 고객 행동 층이 비고 모든 단계가 백스테이지로 간다', () => {
    const ir = withBp();
    const flow = ir.flows![0]!;
    flow.actors = flow.actors.map((a) => ({ ...a, kind: 'system' as const }));
    const m = modelOf(ir);
    expect(m.customer).toBeUndefined();
    for (const c of m.columns) {
      expect(c.cells.customer).toEqual([]);
      expect(c.cells.frontstage.filter((it) => it.type === 'step')).toEqual([]);
    }
    expect(ids(m.columns[0]!.cells.backstage)).toContain('st-register');
  });

  it('갈림길은 어느 층에도 서지 않는다', () => {
    const ir = withBp();
    const flow = ir.flows![0]!;
    flow.steps.find((s) => s.id === 'st-notify')!.kind = 'decision';
    const m = modelOf(ir);
    const placed = m.columns.flatMap((c) => Object.values(c.cells).flatMap((cell) => ids(cell)));
    expect(placed).not.toContain('st-notify');
  });
});

describe('blueprint 문서 근거 구분', () => {
  it('근거가 문서뿐인 단계 카드는 점선 표시와 안내 글자가 붙고 코드 근거 카드는 아니다', async () => {
    const ir = withBp();
    const reg = ir.flows![0]!.steps.find((s) => s.id === 'st-register')!;
    reg.evidence = [
      { type: 'doc', location: 'https://docs.acme.test/queue', visibility: 'public' },
    ];
    const { private: html } = await renderBoth(ir);
    const card = (id: string): string =>
      html.match(new RegExp(`<div class="[^"]*bp-card[^"]*" data-node-id="${id}"[^>]*>`))![0];
    expect(card('st-register')).toContain('doc-only');
    expect(card('st-register')).toContain('문서로만 확인');
    expect(card('st-call')).not.toContain('doc-only');
  });

  it('문서 단계가 가리킨 노드 카드도 점선이지만 코드 단계와 같은 칸에서 겹치면 실선이다', () => {
    const ir = withBp();
    const flow = ir.flows![0]!;
    const reg = flow.steps.find((s) => s.id === 'st-register')!;
    reg.evidence = [{ type: 'doc', location: 'https://docs.acme.test/q', visibility: 'public' }];
    reg.refs = ['s-cart'];
    const before = modelOf(ir).columns[0]!.cells.frontstage.find((it) => it.id === 's-cart');
    expect(before?.docOnly).toBe(true);
    // 같은 열에 코드 근거 단계가 같은 화면을 가리키면 실선 길이 생긴다
    flow.steps.push({
      id: 'st-reg2',
      actor: 'guest',
      label: '줄 등록 확인',
      evidence: flow.steps.find((s) => s.id === 'st-call')!.evidence,
      refs: ['s-cart'],
    });
    flow.transitions.push({
      id: 't-x',
      from: 'st-reg2',
      to: 'st-notify',
      path: 'main',
      evidence: flow.transitions[0]!.evidence,
      lineStyle: 'solid',
    });
    const after = modelOf(ir).columns[0]!.cells.frontstage.find((it) => it.id === 's-cart');
    expect(after?.docOnly).toBe(false);
  });
});

describe('blueprint 렌더', () => {
  it('칸을 넘친 카드는 "+N" 글자로 나온다', async () => {
    const ir = withBp();
    ir.flows![0]!.steps.find((s) => s.id === 'st-register')!.refs = [
      's-list',
      's-detail',
      's-cart',
      's-admin',
    ];
    const { private: html } = await renderBoth(ir);
    expect(html).toMatch(/class="bp-more"[^>]*>\+1</);
  });

  it('두 번 그려도 바이트가 같다', async () => {
    const a = await renderBoth(withBp());
    const b = await renderBoth(withBp());
    expect(b.private).toBe(a.private);
    expect(b.shared).toBe(a.shared);
  });

  it('단계 이름과 노드 이름의 마크업은 이스케이프된다', async () => {
    const ir = withBp();
    const flow = ir.flows![0]!;
    flow.steps.find((s) => s.id === 'st-register')!.label = '<script>alert(1)</script>';
    ir.nodes.find((n) => n.id === 's-list')!.label = '<script>alert(2)</script>';
    const { private: priv, shared } = await renderBoth(ir);
    for (const html of [priv, shared]) {
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('<script>alert(2)</script>');
      expect(html).toContain('&lt;script&gt;alert(1)');
    }
  });
});

describe('blueprint 공유본 마스킹', () => {
  const ACCOUNT = '123456789012';
  const SECRET = 'web:src/secret-notes.ts:1';

  it('흐름 글자와 노드 글자의 계정 ID와 private 근거 위치가 공유본에 없다', async () => {
    const ir = withBp();
    const flow = ir.flows![0]!;
    flow.steps.find((s) => s.id === 'st-register')!.label = `계정 ${ACCOUNT} 등록`;
    flow.stateLabels = { ...flow.stateLabels, CALL: `호출 ${ACCOUNT}` };
    const screen = ir.nodes.find((n) => n.id === 's-list')!;
    screen.description = `계정 ${ACCOUNT}에서 돈다`;
    screen.evidence.push({ type: 'code', location: SECRET, visibility: 'private' });
    const { private: priv, shared } = await renderBoth(ir);
    expect(priv).toContain(ACCOUNT);
    expect(shared).not.toContain(ACCOUNT);
    expect(shared).not.toContain(SECRET);
    expect(shared).toContain('[계정 ID]');
  });

  it('상태 값 자체에 계정 ID가 있어도 공유본에 원문이 없고 렌더가 끝난다', async () => {
    const ir = withBp();
    const flow = ir.flows![0]!;
    for (const s of flow.steps) {
      if (s.state === 'SITTING') s.state = `SIT_${ACCOUNT}`;
      if (s.state === 'CALL') s.state = `CALL_${ACCOUNT}`;
    }
    flow.stateLabels = { WAITING: '대기', [`CALL_${ACCOUNT}`]: '호출됨' };
    const { private: priv, shared } = await renderBoth(ir);
    expect(priv).toContain(ACCOUNT);
    expect(shared).not.toContain(ACCOUNT);
    expect(shared).toContain('bp-');
  });
});

describe('blueprint 저장과 이월', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = resolve('.gestalt-test', `blueprint-store-${randomUUID()}`);
    mkdirSync(repoRoot, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(repoRoot)) rmSync(repoRoot, { recursive: true, force: true });
  });

  it('그림 파일에 흐름과 칸을 채운 노드와 따라간 엣지를 함께 싣는다', () => {
    const paths = new ArchitectureStore(repoRoot).saveViews(withBp());
    const slice = JSON.parse(readFileSync(paths[0]!, 'utf-8')) as ProjectionSlice;
    expect(slice.flow?.id).toBe('queue');
    const nodeIds = slice.nodes.map((n) => n.id);
    // 화면에서 API, 처리 모듈을 거쳐 테이블까지 간 길
    expect(nodeIds).toEqual(
      expect.arrayContaining(['s-list', 'ep-orders', 'm-orders', 't-orders']),
    );
    expect(slice.edges.length).toBeGreaterThan(0);
    const edgeEnds = slice.edges.flatMap((e) => [e.from, e.to]);
    for (const id of edgeEnds) expect(nodeIds).toContain(id);
  });

  it('다음 실행 IR에 blueprint가 없어도 흐름이 있으면 이월한다', () => {
    const merged = mergeWithPrevious(withBp(), flowIr());
    expect(merged.projections?.map((p) => p.id)).toEqual(['queue-bp']);
  });

  it('가리킨 흐름이 사라지면 버린다', () => {
    const next = flowIr();
    next.flows = next.flows!.map((f) => ({ ...f, id: 'queue-v2' }));
    expect(mergeWithPrevious(withBp(), next).projections ?? []).toEqual([]);
    const none = flowIr();
    delete none.flows;
    expect(mergeWithPrevious(withBp(), none).projections ?? []).toEqual([]);
  });

  it('같은 id의 흐름에 갈림길만 남으면 버린다', () => {
    const next = flowIr();
    next.flows = next.flows!.map((f) => ({
      ...f,
      steps: f.steps.map((st) => ({ ...st, kind: 'decision' as const })),
    }));
    expect(mergeWithPrevious(withBp(), next).projections ?? []).toEqual([]);
  });
});

describe('ges_architecture blueprint 경고', () => {
  let tmpRoot: string;
  let repoRoot: string;
  let homeDir: string;

  beforeEach(() => {
    tmpRoot = resolve('.gestalt-test', `blueprint-pt-${randomUUID()}`);
    repoRoot = join(tmpRoot, 'acme-web');
    homeDir = join(tmpRoot, 'home');
    mkdirSync(join(repoRoot, 'src'), { recursive: true });
    mkdirSync(join(homeDir, '.claude', 'projects'), { recursive: true });
    writeFileSync(join(repoRoot, 'src/home.tsx'), 'a\nb\n');
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function ir(stages: number): ArchitectureIr {
    const ev = [
      { type: 'code' as const, location: 'web:src/home.tsx:1', visibility: 'public' as const },
    ];
    return {
      schemaVersion: '1.0.0',
      view: 'screen-chain',
      repos: [{ id: 'web', name: 'acme-web', root: '.' }],
      nodes: [{ id: 'n-home', kind: 'screen', label: 'Home', repo: 'web', evidence: ev }],
      edges: [],
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
      flows: [
        {
          id: 'queue',
          title: '줄서기',
          actors: [{ id: 'guest', label: '손님', kind: 'person' }],
          steps: Array.from({ length: stages }, (_, i) => ({
            id: `s${i}`,
            actor: 'guest',
            label: `단계 ${i}`,
            evidence: ev,
            ...(i === 0 ? { refs: ['n-home'] } : {}),
          })),
          transitions: Array.from({ length: stages - 1 }, (_, i) => ({
            id: `t${i}`,
            from: `s${i}`,
            to: `s${i + 1}`,
            path: 'main' as const,
            evidence: ev,
            lineStyle: 'solid' as const,
          })),
        },
      ],
      projections: [BP],
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

  type W = { code: string; subjectId?: string; counts: Record<string, number> };
  const budget = (r: Record<string, unknown>): W[] =>
    ((r['warnings'] as W[] | undefined) ?? []).filter((w) => w.code === 'BLUEPRINT_OVER_BUDGET');

  it('7단계는 validate와 render 응답 warnings에 같은 counts로 실린다', async () => {
    const validated = await call({ action: 'validate', ir: ir(7) });
    expect(validated['ok']).toBe(true);
    const rendered = await call({ action: 'render', ir: ir(7) });
    expect(rendered['ok']).toBe(true);
    expect(budget(validated)).toHaveLength(1);
    expect(budget(rendered)).toEqual(budget(validated));
    expect(budget(rendered)[0]).toMatchObject({ subjectId: 'queue-bp', counts: { stages: 7 } });
    // 경고여도 그림은 그린다
    expect(existsSync(rendered['htmlPath'] as string)).toBe(true);
  });

  it('6단계는 두 응답 모두 경고가 없다', async () => {
    expect(budget(await call({ action: 'validate', ir: ir(6) }))).toEqual([]);
    expect(budget(await call({ action: 'render', ir: ir(6) }))).toEqual([]);
  });
});
