import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FLOW_STEP_OUTCOMES,
  mergeWithPrevious,
  parseArchitectureIr,
  validateArchitectureIr,
  type ArchitectureFlow,
  type ArchitectureIr,
  type FlowStep,
  type FlowTransition,
} from '../../../src/architecture/index.js';
import { deriveLifecycle } from '../../../src/architecture/lifecycle-layout.js';
import { flowIr, harnessIr, webIr } from '../../fixtures/architecture-legacy/irs.js';
import { renderBoth } from '../../fixtures/architecture-legacy/render.js';

type Projection = NonNullable<ArchitectureIr['projections']>[number];

const LIFE: Projection = {
  id: 'queue-life',
  shape: 'lifecycle',
  title: '줄서기 상태',
  question: '줄서기 항목은 어떤 상태를 거치나요?',
  messages: [],
  flow: 'queue',
};

function step(id: string, extra: Partial<FlowStep> = {}): FlowStep {
  return { id, actor: 'a', label: `라벨 ${id}`, evidence: [], ...extra };
}

function tr(
  id: string,
  from: string,
  to: string,
  path: 'main' | 'side',
  extra: Partial<FlowTransition> = {},
): FlowTransition {
  return { id, from, to, path, evidence: [], lineStyle: 'solid', ...extra };
}

function derive(steps: FlowStep[], transitions: FlowTransition[]) {
  const flow: ArchitectureFlow = { id: 'f', title: 'f', actors: [], steps, transitions };
  return deriveLifecycle(
    flow,
    new Set(steps.map((s) => s.id)),
    new Set(transitions.map((t) => t.id)),
  );
}

describe('lifecycle 띠 판정 규칙', () => {
  const model = derive(
    [
      step('a', { state: 'A' }),
      step('b', { state: 'B' }),
      step('fail', { state: 'FAIL', terminal: true, outcome: 'fail' }),
      step('done', { state: 'DONE', terminal: true, outcome: 'done' }),
      step('bare', { state: 'BARE', terminal: true }),
      step('wait', { state: 'WAIT' }),
      step('sideEnd', { state: 'SIDE_END', terminal: true }),
    ],
    [
      tr('t1', 'a', 'b', 'main'),
      tr('t2', 'b', 'fail', 'main'),
      tr('t3', 'b', 'done', 'main'),
      tr('t4', 'b', 'bare', 'main'),
      tr('t5', 'b', 'wait', 'side'),
      tr('t6', 'wait', 'sideEnd', 'side'),
    ],
  );
  const band = (s: string) => model.states.find((x) => x.state === s)!.band;

  it('main 비종결은 진행 단계다', () => {
    expect([band('A'), band('B')]).toEqual(['rail', 'rail']);
  });
  it('side 비종결은 대기와 복구다', () => {
    expect(band('WAIT')).toBe('recovery');
  });
  it('main 종결은 outcome이 없거나 done이면 진행 단계 끝에 남는다', () => {
    expect(band('DONE')).toBe('rail');
    expect(band('BARE')).toBe('rail');
  });
  it('나머지 종결(main fail, side 종결)은 끝 상태다', () => {
    expect(band('FAIL')).toBe('terminal');
    expect(band('SIDE_END')).toBe('terminal');
  });
});

describe('lifecycle 도출 엣지 케이스', () => {
  it('state가 하나도 없으면 상태도 전이도 비어 있다', () => {
    const m = derive([step('a'), step('b')], [tr('t1', 'a', 'b', 'main')]);
    expect(m).toEqual({ states: [], transitions: [] });
  });

  it('같은 state의 두 단계는 한 상태로 합치고 앞으로 가는 전이는 자기 고리를 안 만든다', () => {
    const m = derive(
      [step('a1', { state: 'A' }), step('a2', { state: 'A' }), step('b', { state: 'B' })],
      [tr('t1', 'a1', 'a2', 'main'), tr('t2', 'a2', 'b', 'main')],
    );
    expect(m.states.filter((s) => s.state === 'A')).toHaveLength(1);
    expect(m.states.find((s) => s.state === 'A')!.steps).toEqual(['a1', 'a2']);
    expect(m.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['A>B']);
  });

  it('같은 상태로 되돌아오는 전이는 고리로 남는다', () => {
    const m = derive(
      [step('a1', { state: 'A' }), step('a2', { state: 'A' }), step('b', { state: 'B' })],
      [
        tr('t1', 'a1', 'a2', 'main'),
        tr('t2', 'a2', 'b', 'main'),
        tr('t3', 'b', 'a1', 'side', { label: '재시도' }),
      ],
    );
    expect(m.transitions.map((t) => `${t.from}>${t.to}`)).toEqual(['A>B', 'B>A']);
  });

  it('자기 자신으로 가는 전이(self-loop)는 유지한다', () => {
    const m = derive(
      [step('a', { state: 'A' }), step('b', { state: 'B' })],
      [tr('t1', 'a', 'b', 'main'), tr('t2', 'b', 'b', 'side', { label: '재시도' })],
    );
    expect(m.transitions.find((t) => t.from === 'B' && t.to === 'B')).toMatchObject({
      label: '재시도',
    });
  });

  it('같은 (from, to) 전이는 한 선으로 합치고 라벨과 id를 모은다', () => {
    const m = derive(
      [step('a', { state: 'A' }), step('b', { state: 'B' })],
      [
        tr('t1', 'a', 'b', 'main', { label: '승인' }),
        tr('t2', 'a', 'b', 'side', { label: '자동', lineStyle: 'dashed' }),
        tr('t3', 'a', 'b', 'main', { label: '승인' }),
      ],
    );
    expect(m.transitions).toHaveLength(1);
    expect(m.transitions[0]).toMatchObject({
      label: '승인, 자동',
      transitions: ['t1', 't2', 't3'],
      path: 'main',
      lineStyle: 'solid',
    });
  });

  it('state 없는 단계가 연달아 이어져도 전이를 하나로 잇는다', () => {
    const m = derive(
      [step('a', { state: 'A' }), step('x'), step('y'), step('b', { state: 'B', label: '도착' })],
      [tr('t1', 'a', 'x', 'main'), tr('t2', 'x', 'y', 'main'), tr('t3', 'y', 'b', 'main')],
    );
    expect(m.transitions).toHaveLength(1);
    expect(m.transitions[0]).toMatchObject({
      from: 'A',
      to: 'B',
      label: '도착',
      borrowed: true,
      transitions: ['t1', 't2', 't3'],
    });
  });

  it('state 없는 단계끼리 도는 순환이 있어도 끝난다', () => {
    const m = derive(
      [step('a', { state: 'A' }), step('x'), step('y')],
      [tr('t1', 'a', 'x', 'main'), tr('t2', 'x', 'y', 'main'), tr('t3', 'y', 'x', 'side')],
    );
    expect(m.transitions).toEqual([]);
  });
});

describe('outcome 검증과 JSON schema 패리티', () => {
  it('끝 단계가 아닌 step에 outcome이 있으면 파싱이 실패한다', () => {
    const ir = flowIr();
    const s = ir.flows![0]!.steps[0]!;
    delete s.terminal;
    Object.assign(s, { outcome: 'cancel' });
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(false);
  });

  it('정의 밖 outcome 값은 파싱이 실패한다', () => {
    const ir = flowIr();
    const end = ir.flows![0]!.steps.find((s) => s.terminal === true)!;
    Object.assign(end, { outcome: 'pending' });
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(false);
  });

  it('JSON schema의 outcome enum과 terminal 의존이 zod와 같다', () => {
    const schema = JSON.parse(
      readFileSync(resolve('schemas/architecture-ir.schema.json'), 'utf-8'),
    ) as {
      definitions: {
        flowStep: {
          properties: { outcome: { enum: string[] } };
          dependencies: { outcome: { properties: { terminal: { const: boolean } } } };
        };
        projection: { properties: { flow?: { type: string } } };
      };
    };
    const step = schema.definitions.flowStep;
    expect(new Set(step.properties.outcome.enum)).toEqual(new Set(FLOW_STEP_OUTCOMES));
    expect(step.dependencies.outcome.properties.terminal.const).toBe(true);
    expect(schema.definitions.projection.properties.flow?.type).toBe('string');
  });
});

describe('LIFECYCLE_OVER_BUDGET 경고 경계', () => {
  function chainIr(count: number, withProjection: boolean): ArchitectureIr {
    const ir = flowIr();
    const flow = ir.flows![0]!;
    const ev = flow.steps[0]!.evidence;
    flow.steps = Array.from({ length: count }, (_, i) => ({
      id: `s${i}`,
      actor: flow.actors[0]!.id,
      label: `단계 ${i}`,
      state: `S${i}`,
      evidence: ev,
      ...(i === count - 1 ? { terminal: true } : {}),
    }));
    flow.transitions = Array.from({ length: count - 1 }, (_, i) => ({
      id: `c${i}`,
      from: `s${i}`,
      to: `s${i + 1}`,
      path: 'main' as const,
      evidence: ev,
      lineStyle: 'solid' as const,
    }));
    return withProjection ? { ...ir, projections: [LIFE] } : ir;
  }
  const codes = (ir: ArchitectureIr): string[] => {
    const r = validateArchitectureIr(ir, { checkFiles: false });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    return (r.value.warnings ?? []).map((w) => w.code);
  };

  it('진행 단계가 예산(5)과 같으면 경고가 없다', () => {
    expect(codes(chainIr(5, true))).not.toContain('LIFECYCLE_OVER_BUDGET');
  });

  it('예산을 하나 넘으면 경고가 하나 나온다', () => {
    expect(codes(chainIr(6, true)).filter((c) => c === 'LIFECYCLE_OVER_BUDGET')).toHaveLength(1);
  });

  it('lifecycle 그림이 없으면 경고 배열은 기존 코드만 담는다', () => {
    for (const ir of [chainIr(8, false), webIr(), flowIr(), harnessIr()]) {
      expect(codes(ir).every((c) => c === 'NODE_DESCRIPTION_MISSING')).toBe(true);
    }
  });
});

describe('lifecycle 이월 (store)', () => {
  function withLife(): ArchitectureIr {
    return { ...flowIr(), projections: [LIFE] };
  }

  it('가리킨 흐름이 다음 IR에도 있으면 그림을 이어 싣는다', () => {
    const next = flowIr();
    const merged = mergeWithPrevious(withLife(), next);
    expect(merged.projections?.map((p) => p.id)).toEqual(['queue-life']);
  });

  it('가리킨 흐름이 다음 IR flows에 없으면 그림을 폐기한다', () => {
    const next = flowIr();
    next.flows = next.flows!.map((f) => ({ ...f, id: 'queue-v2' }));
    const merged = mergeWithPrevious(withLife(), next);
    expect(merged.projections ?? []).toEqual([]);
  });

  it('다음 IR에 flows가 아예 없어도 폐기한다', () => {
    const next = flowIr();
    delete next.flows;
    const merged = mergeWithPrevious(withLife(), next);
    expect(merged.projections ?? []).toEqual([]);
  });

  it('같은 id의 흐름이 state를 단 단계 없이 다시 오면 폐기한다', () => {
    const next = flowIr();
    next.flows = next.flows!.map((f) => ({
      ...f,
      steps: f.steps.map(({ state: _state, ...st }) => st),
    }));
    const merged = mergeWithPrevious(withLife(), next);
    expect(merged.projections ?? []).toEqual([]);
  });
});

describe('lifecycle 공유본 마스킹', () => {
  const ACCOUNT = '123456789012';

  it('상태 이름과 전이 라벨의 계정 ID가 공유본에서 가려진다', async () => {
    const ir = flowIr();
    const flow = ir.flows![0]!;
    flow.stateLabels = { ...flow.stateLabels, WAITING: `대기 ${ACCOUNT}` };
    for (const t of flow.transitions) {
      if (t.id === 't-3') t.label = `계정 ${ACCOUNT} 승인`;
    }
    const html = await renderBoth({ ...ir, projections: [LIFE] });
    expect(html.private).toContain(ACCOUNT);
    expect(html.shared).not.toContain(ACCOUNT);
    expect(html.shared).toContain('[계정 ID]');
  });
});
