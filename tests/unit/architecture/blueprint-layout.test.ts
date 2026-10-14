import { describe, expect, it } from 'vitest';
import {
  parseArchitectureIr,
  validateArchitectureIr,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import {
  BLUEPRINT_CARDS_PER_CELL,
  computeBlueprintLayout,
  deriveBlueprint,
  type BlueprintModel,
} from '../../../src/architecture/blueprint-layout.js';
import { flowIr } from '../../fixtures/architecture-legacy/irs.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';
import { refundApprovalIr } from '../../fixtures/architecture-categories/process.js';

type Projection = NonNullable<ArchitectureIr['projections']>[number];

const BP: Projection = {
  id: 'queue-bp',
  shape: 'blueprint',
  title: '줄서기 블루프린트',
  question: '손님이 줄을 서는 동안 뒤에서는 무엇이 일하나요?',
  messages: [],
  flow: 'queue',
};

/** 레거시 줄서기 흐름에 화면 refs와 갈림길, 같은 열에 서는 단계를 더한다 */
function blueprintIr(projections: Projection[] = [BP]): ArchitectureIr {
  const ir = flowIr();
  const flow = ir.flows![0]!;
  const ev = flow.steps[0]!.evidence;
  for (const s of flow.steps) {
    if (s.id === 'st-call') s.refs = ['s-detail'];
    if (s.id === 'st-seat') s.refs = ['s-cart'];
  }
  flow.steps.push(
    { id: 'st-check', actor: 'staff', label: '자리 있나', kind: 'decision', evidence: ev },
    { id: 'st-sms', actor: 'sys', label: '문자 발송', evidence: ev },
  );
  const t3 = flow.transitions.find((t) => t.id === 't-3')!;
  t3.to = 'st-check';
  flow.transitions.push(
    { id: 't-9', from: 'st-check', to: 'st-seat', path: 'main', evidence: ev, lineStyle: 'solid' },
    {
      id: 't-10',
      from: 'st-register',
      to: 'st-sms',
      path: 'main',
      evidence: ev,
      lineStyle: 'solid',
    },
  );
  return { ...ir, projections };
}

function validated(ir: ArchitectureIr) {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}

function modelOf(ir: ArchitectureIr): BlueprintModel {
  const v = validated(ir);
  const flow = v.ir.flows!.find((f) => f.id === 'queue')!;
  return deriveBlueprint(flow, {
    nodes: v.ir.nodes,
    edges: v.ir.edges,
    drawableNodeIds: v.drawableNodeIds,
    drawableEdgeIds: v.drawableEdgeIds,
    drawableStepIds: v.drawableStepIds,
    drawableTransitionIds: v.drawableTransitionIds,
  });
}

const ids = (items: { id: string }[]): string[] => items.map((it) => it.id);

/** 단계가 n개 한 줄로 이어진 독립 흐름 */
function linearIr(n: number): ArchitectureIr {
  const ir = refundApprovalIr();
  const flow = ir.flows![0]!;
  const ev = flow.steps[0]!.evidence;
  flow.steps = Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    actor: 'customer',
    label: `단계 ${i}`,
    evidence: ev,
    ...(i === n - 1 ? { terminal: true } : {}),
  }));
  flow.transitions = Array.from({ length: n - 1 }, (_, i) => ({
    id: `t${i}`,
    from: `s${i}`,
    to: `s${i + 1}`,
    path: 'main' as const,
    evidence: ev,
    lineStyle: 'dashed' as const,
  }));
  return { ...ir, projections: [{ ...BP, id: 'refund-bp', flow: 'refund' }] };
}

describe('blueprint 스키마와 검증', () => {
  it('blueprint 모양과 flow를 받는다', () => {
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(blueprintIr()))).ok).toBe(true);
    expect(validateArchitectureIr(blueprintIr(), { checkFiles: false }).ok).toBe(true);
  });

  it('messages나 participants가 있거나 flow가 없으면 모양 오용이다', () => {
    const codes = (p: Projection): string[] => {
      const r = validateArchitectureIr(blueprintIr([p]), { checkFiles: false });
      return r.ok ? [] : r.errors.map((e) => e.code);
    };
    expect(codes({ ...BP, participants: ['s-list'] })).toContain('PROJECTION_SHAPE_FIELD');
    const { flow: _drop, ...noFlow } = BP;
    expect(codes(noFlow)).toContain('PROJECTION_SHAPE_FIELD');
    expect(codes({ ...BP, flow: 'nope' })).toContain('PROJECTION_FLOW_NOT_FOUND');
  });
});

describe('blueprint 도출', () => {
  it('정상 흐름 단계를 열로 묶고 갈림길과 옆 흐름은 뺀다', () => {
    const m = modelOf(blueprintIr());
    expect(m.columns.map((c) => c.steps)).toEqual([
      ['st-register'],
      ['st-notify', 'st-sms'],
      ['st-call'],
      ['st-seat'],
    ]);
    const all = m.columns.flatMap((c) => c.steps);
    expect(all).not.toContain('st-check');
    expect(all).not.toContain('st-cancel');
  });

  it('첫 person이 고객이고 다른 사람은 프론트스테이지, 시스템은 백스테이지다', () => {
    const m = modelOf(blueprintIr());
    expect(m.customer).toBe('guest');
    const [c0, c1, c2] = m.columns;
    expect(ids(c0!.cells.customer)).toEqual(['st-register']);
    expect(ids(c1!.cells.backstage)).toEqual(['st-notify', 'st-sms']);
    expect(ids(c2!.cells.frontstage)).toEqual(['st-call', 's-detail']);
  });

  it('화면에서 API, 처리 모듈을 거쳐 저장소와 외부 서비스까지 근거 있는 엣지로만 채운다', () => {
    const m = modelOf(blueprintIr());
    const [c0, c1, c2, c3] = m.columns;
    expect(ids(c0!.cells.frontstage)).toEqual(['s-list']);
    expect(ids(c0!.cells.backstage)).toEqual(['ep-orders']);
    expect(ids(c0!.cells.support)).toEqual(['t-orders']);
    expect(ids(c2!.cells.backstage)).toEqual(['ep-orders']);
    expect(ids(c3!.cells.backstage)).toEqual(['ep-cart']);
    expect(ids(c3!.cells.support)).toEqual(['x-pay']);
    // 근거가 없으면 비운다. 지어내지 않는다
    expect(c1!.cells.customer).toEqual([]);
    expect(c1!.cells.support).toEqual([]);
  });

  it('근거 없는 엣지는 따라가지 않는다', () => {
    const ir = blueprintIr();
    for (const id of ['c2', 'h1']) {
      const e = ir.edges.find((x) => x.id === id)!;
      e.evidence = [];
      e.lineStyle = 'dashed';
    }
    const m = modelOf(ir);
    // s-detail → ep-orders 호출이 근거를 잃어 호출 열 백스테이지에는 API가 없다
    expect(ids(m.columns[2]!.cells.backstage)).toEqual([]);
    // ep-orders → m-orders 처리가 근거를 잃어 테이블까지 못 간다
    expect(ids(m.columns[0]!.cells.backstage)).toEqual(['ep-orders']);
    expect(m.columns[0]!.cells.support).toEqual([]);
    expect(m.edges).not.toContain('c2');
    expect(m.edges).not.toContain('h1');
  });

  it('칸에 넘치는 카드는 접는다', () => {
    const ir = blueprintIr();
    ir.flows![0]!.steps.find((s) => s.id === 'st-register')!.refs = [
      's-list',
      's-detail',
      's-cart',
      's-admin',
    ];
    const layout = computeBlueprintLayout(modelOf(ir));
    const cell = layout.cells.find((c) => c.row === 'frontstage' && c.column === 0)!;
    expect(cell.cards).toHaveLength(BLUEPRINT_CARDS_PER_CELL);
    expect(ids(cell.hidden)).toEqual(['s-admin']);
    expect(cell.moreAt).toBeDefined();
  });
});

describe('blueprint 예산', () => {
  it('6열까지는 경고가 없고 넘으면 BLUEPRINT_OVER_BUDGET을 싣되 그리기는 한다', () => {
    const six = validated(linearIr(6));
    expect(six.warnings.filter((w) => w.code === 'BLUEPRINT_OVER_BUDGET')).toEqual([]);
    const seven = validated(linearIr(7));
    const w = seven.warnings.find((x) => x.code === 'BLUEPRINT_OVER_BUDGET');
    expect(w).toMatchObject({ subjectId: 'refund-bp', counts: { stages: 7 } });
    expect(seven.drawableProjectionIds?.has('refund-bp')).toBe(true);
  });
});

describe('blueprint 렌더', () => {
  it('층 이름과 가시선 라벨을 글자로 적고 빈 칸에 —를 찍는다', async () => {
    const { private: html } = await renderBoth(blueprintIr());
    for (const t of ['고객 행동', '프론트스테이지', '가시선', '백스테이지', '지원']) {
      expect(html).toContain(t);
    }
    expect(html).toContain('data-role="visibility"');
    expect(html).toMatch(/class="bp-empty" data-bp-row="customer" data-bp-col="1"[^>]*>—</);
    // 연결선은 긋지 않는다
    const section = html.slice(html.indexOf('data-level-id="view:queue-bp"'));
    const svg = section.slice(0, section.indexOf('</svg>'));
    expect(svg).not.toMatch(/<g class="link[ "]/);
  });

  it('공유본도 같은 좌표에 카드를 놓는다', async () => {
    const { private: priv, shared } = await renderBoth(blueprintIr());
    const boxes = (html: string): string[] =>
      [...html.matchAll(/data-bp-row="[a-z]+" data-bp-col="\d+"[^>]*style="([^"]+)"/g)].map(
        (m) => m[1]!,
      );
    expect(boxes(priv).length).toBeGreaterThan(0);
    expect(boxes(shared)).toEqual(boxes(priv));
  });

  it('blueprint가 없으면 스타일을 싣지 않는다', async () => {
    const { private: html } = await renderBoth(flowIr());
    expect(html).not.toContain('.bp-row');
  });
});
