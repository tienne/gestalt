import { describe, expect, it } from 'vitest';
import {
  parseArchitectureIr,
  validateArchitectureIr,
  type ArchitectureFlow,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import {
  computeLifecycleLayout,
  deriveLifecycle,
  lifecycleCounts,
  lifecycleOverBudget,
} from '../../../src/architecture/lifecycle-layout.js';
import { flowIr } from '../../fixtures/architecture-legacy/irs.js';
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

/** 레거시 줄서기 흐름에 끝 상태와 복구 상태를 더 달아 세 띠가 다 서게 한다 */
function lifecycleIr(projections: Projection[] = [LIFE]): ArchitectureIr {
  const ir = flowIr();
  const flow = ir.flows![0]!;
  const ev = flow.steps[0]!.evidence;
  flow.stateLabels = { ...flow.stateLabels, CANCELED: '취소됨', NOSHOW: '노쇼', EXPIRED: '만료' };
  for (const s of flow.steps) {
    if (s.id === 'st-cancel') Object.assign(s, { state: 'CANCELED', outcome: 'cancel' });
    if (s.id === 'st-noshow') Object.assign(s, { state: 'NOSHOW' });
    if (s.id === 'st-seat') Object.assign(s, { outcome: 'done' });
  }
  flow.steps.push({
    id: 'st-expire',
    actor: 'sys',
    label: '만료 처리',
    state: 'EXPIRED',
    terminal: true,
    outcome: 'fail',
    evidence: ev,
  });
  flow.transitions.push({
    id: 't-8',
    from: 'st-noshow',
    to: 'st-expire',
    path: 'side',
    label: '30분 지남',
    evidence: ev,
    lineStyle: 'solid',
  });
  return { ...ir, projections };
}

function errorCodes(ir: ArchitectureIr): string[] {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  return r.ok ? [] : r.errors.map((e) => e.code);
}

function modelOf(ir: ArchitectureIr) {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  const flow = r.value.ir.flows!.find((f) => f.id === 'queue')!;
  return deriveLifecycle(flow, r.value.drawableStepIds, r.value.drawableTransitionIds);
}

describe('lifecycle 스키마와 검증', () => {
  it('outcome은 끝 단계에만 달 수 있다', () => {
    const ir = lifecycleIr();
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(true);
    const bad = lifecycleIr();
    Object.assign(bad.flows![0]!.steps.find((s) => s.id === 'st-call')!, { outcome: 'done' });
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(bad))).ok).toBe(false);
  });

  it('flow를 안 적거나 다른 모양에 적으면 모양 필드 에러다', () => {
    const { flow: _drop, ...noFlow } = LIFE;
    expect(errorCodes(lifecycleIr([noFlow]))).toContain('PROJECTION_SHAPE_FIELD');
    const seq: Projection = {
      id: 'seq',
      shape: 'sequence',
      title: '순서',
      question: '?',
      messages: [],
      flow: 'queue',
    };
    expect(errorCodes(lifecycleIr([seq]))).toContain('PROJECTION_SHAPE_FIELD');
  });

  it('없는 흐름을 가리키면 PROJECTION_FLOW_NOT_FOUND, 상태가 없으면 PROJECTION_EMPTY다', () => {
    expect(errorCodes(lifecycleIr([{ ...LIFE, flow: 'nope' }]))).toContain(
      'PROJECTION_FLOW_NOT_FOUND',
    );
    const ir = lifecycleIr();
    for (const s of ir.flows![0]!.steps) delete s.state;
    expect(errorCodes(ir)).toContain('PROJECTION_EMPTY');
  });
});

describe('lifecycle 도출', () => {
  it('상태를 세 띠로 나누고 정상 완료는 진행 단계 끝에 둔다', () => {
    const model = modelOf(lifecycleIr());
    expect(Object.fromEntries(model.states.map((s) => [s.state, s.band]))).toEqual({
      WAITING: 'rail',
      CALL: 'rail',
      SITTING: 'rail',
      NOSHOW: 'recovery',
      CANCELED: 'terminal',
      EXPIRED: 'terminal',
    });
    // 끝 상태는 진행 순서 뒤로 모인다
    expect(model.states.slice(-3).every((s) => s.terminal)).toBe(true);
    expect(model.states.find((s) => s.state === 'CANCELED')!.outcome).toBe('cancel');
  });

  it('상태 없는 단계를 건너 전이를 잇고 글자가 없으면 도착 단계 이름을 빌린다', () => {
    const model = modelOf(lifecycleIr());
    const pair = (from: string, to: string) =>
      model.transitions.find((t) => t.from === from && t.to === to)!;
    // st-notify를 건너 t-1, t-2가 한 선이 된다
    expect(pair('WAITING', 'CALL')).toMatchObject({
      label: '호출',
      borrowed: true,
      transitions: ['t-1', 't-2'],
    });
    // 노쇼에서 되돌리기와 알림을 지나 호출로 돌아가는 고리
    expect(pair('NOSHOW', 'CALL')).toMatchObject({ label: '30분 안', borrowed: false });
    expect(pair('CALL', 'NOSHOW').lineStyle).toBe('dashed');
    const keys = model.transitions.map((t) => `${t.from}>${t.to}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('배치는 띠 순서대로 쌓이고 카드끼리 안 겹친다', () => {
    const model = modelOf(lifecycleIr());
    const layout = computeLifecycleLayout(model);
    expect(layout.routes).toHaveLength(model.transitions.length);
    expect(layout.bands.map((b) => b.band)).toEqual(['rail', 'recovery', 'terminal']);
    for (const [i, a] of layout.boxes.entries()) {
      for (const b of layout.boxes.slice(i + 1)) {
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.height <= b.y ||
          b.y + b.height <= a.y;
        expect(apart, `${a.state} / ${b.state}`).toBe(true);
      }
      expect(a.x + a.width).toBeLessThanOrEqual(layout.width);
    }
  });
});

describe('lifecycle 예산 경고', () => {
  it('진행 단계가 다섯을 넘으면 경고만 내고 그림은 그린다', () => {
    const ir = lifecycleIr();
    const flow: ArchitectureFlow = ir.flows![0]!;
    const ev = flow.steps[0]!.evidence;
    flow.steps = Array.from({ length: 7 }, (_, i) => ({
      id: `s${i}`,
      actor: 'guest',
      label: `단계 ${i}`,
      state: `S${i}`,
      evidence: ev,
      ...(i === 6 ? { terminal: true } : {}),
    }));
    flow.transitions = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      from: `s${i}`,
      to: `s${i + 1}`,
      path: 'main' as const,
      evidence: ev,
      lineStyle: 'solid' as const,
    }));
    const r = validateArchitectureIr(ir, { checkFiles: false });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    expect(r.value.drawableProjectionIds?.has('queue-life')).toBe(true);
    const w = (r.value.warnings ?? []).find((x) => x.code === 'LIFECYCLE_OVER_BUDGET');
    expect(w).toMatchObject({ subjectId: 'queue-life', counts: { phases: 7 } });
  });

  it('예산 안이면 넘은 항목이 없다', () => {
    const model = modelOf(lifecycleIr());
    expect(lifecycleOverBudget(lifecycleCounts(model))).toEqual([]);
  });
});

describe('lifecycle 렌더', () => {
  it('상태 흐름 레벨에 띠와 결과 배지를 그리고 공유본도 좌표가 같다', async () => {
    const html = await renderBoth(lifecycleIr());
    expect(html.private).toContain('class="lc-band lc-recovery"');
    expect(html.private).toContain('o-cancel');
    expect(html.private).toContain('상태 6, 전이');
    const at = (s: string) =>
      [...s.matchAll(/lc-state[^"]*"[^>]*style="(left:[^"]+)"/g)].map((m) => m[1]);
    expect(at(html.shared)).toEqual(at(html.private));
    expect(at(html.private)).toHaveLength(6);
  });

  it('상태 값에 계정 ID가 있어도 공유본에 원문이 없고 렌더가 끝난다', async () => {
    const ACCOUNT = '123456789012';
    const ir = lifecycleIr();
    const flow = ir.flows![0]!;
    const { CANCELED: _c, EXPIRED: _e, ...labels } = flow.stateLabels!;
    flow.stateLabels = { ...labels, [`CANCELED_${ACCOUNT}`]: '취소됨' };
    for (const s of flow.steps) {
      if (s.state === 'CANCELED') s.state = `CANCELED_${ACCOUNT}`;
      if (s.state === 'EXPIRED') s.state = `EXPIRED_${ACCOUNT}`;
    }
    const html = await renderBoth(ir);
    expect(html.private).toContain(ACCOUNT);
    expect(html.shared).not.toContain(ACCOUNT);
    expect(html.shared).toContain('lc-state');
  });

  it('lifecycle 그림이 없으면 상태 흐름 CSS를 싣지 않는다', async () => {
    const html = await renderBoth(flowIr());
    expect(html.private).not.toContain('.lc-band');
  });
});
