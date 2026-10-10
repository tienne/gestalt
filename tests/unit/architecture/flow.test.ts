import { describe, expect, it } from 'vitest';
import { textUnits } from '../../../src/architecture/layout.js';
import {
  computeDrilldown,
  computeFlowLayout,
  FLOW_ACTOR_BAND,
  FLOW_DECISION_HEIGHT,
  FLOW_HEAD_WIDTH,
  FLOW_STAGE_HEAD,
  FLOW_STEP_HEIGHT,
  FLOW_STEP_WIDTH,
  mergeArchitectureIrs,
  mergeWithPrevious,
  parseArchitectureIr,
  renderDrilldownHtml,
  validateArchitectureIr,
  type ArchitectureFlow,
  type ArchitectureIr,
  type ArchitectureNode,
  type Evidence,
  type FlowStep,
  type FlowTransition,
  type ValidatedIr,
} from '../../../src/architecture/index.js';

// 가짜 매장 줄서기 서비스. 손님이 줄을 서고 직원이 부르고 시스템이 알림을 보낸다.
// 노쇼는 기획서에만 있어서 점선이다. 되돌리기는 앞 단계로 돌아가는 선이다.

const code = (location: string): Evidence => ({ type: 'code', location, visibility: 'public' });
const doc = (location: string): Evidence => ({ type: 'doc', location, visibility: 'public' });

function node(id: string, kind: ArchitectureNode['kind'], parent?: string): ArchitectureNode {
  return {
    id,
    kind,
    label: id,
    repo: 'web',
    evidence: [code(`web:src/${id}.ts:1`)],
    ...(parent ? { parent } : {}),
  };
}

function queueFlow(): ArchitectureFlow {
  return {
    id: 'queue',
    service: 'svc-shop',
    title: '줄서기',
    actors: [
      { id: 'guest', label: '손님', kind: 'person' },
      { id: 'staff', label: '직원', kind: 'person' },
      { id: 'sys', label: '자동 발송', kind: 'system' },
    ],
    steps: [
      {
        id: 'st-register',
        actor: 'guest',
        label: '줄 등록',
        state: 'WAITING',
        refs: ['s-queue', 'ep-register'],
        evidence: [code('web:src/register.ts:10')],
      },
      {
        id: 'st-notify',
        actor: 'sys',
        label: '등록 알림',
        evidence: [code('web:src/notify.ts:3')],
      },
      {
        id: 'st-call',
        actor: 'staff',
        label: '호출',
        state: 'CALL',
        evidence: [code('web:src/call.ts:1')],
      },
      {
        id: 'st-seat',
        actor: 'staff',
        label: '입장',
        state: 'SITTING',
        evidence: [code('web:src/seat.ts:1')],
      },
      {
        id: 'st-cancel',
        actor: 'guest',
        label: '직접 취소',
        evidence: [code('web:src/cancel.ts:1')],
      },
      {
        id: 'st-noshow',
        actor: 'sys',
        label: '노쇼 처리',
        evidence: [doc('https://docs.acme.test/queue#noshow')],
      },
      { id: 'st-undo', actor: 'staff', label: '되돌리기', evidence: [code('web:src/undo.ts:1')] },
    ],
    transitions: [
      {
        id: 't-1',
        from: 'st-register',
        to: 'st-notify',
        path: 'main',
        evidence: [code('web:src/register.ts:20')],
        lineStyle: 'solid',
      },
      {
        id: 't-2',
        from: 'st-notify',
        to: 'st-call',
        path: 'main',
        evidence: [code('web:src/call.ts:5')],
        lineStyle: 'solid',
      },
      {
        id: 't-3',
        from: 'st-call',
        to: 'st-seat',
        path: 'main',
        label: '착석',
        evidence: [code('web:src/seat.ts:5')],
        lineStyle: 'solid',
      },
      {
        id: 't-4',
        from: 'st-notify',
        to: 'st-cancel',
        path: 'side',
        evidence: [code('web:src/cancel.ts:5')],
        lineStyle: 'solid',
      },
      {
        id: 't-5',
        from: 'st-call',
        to: 'st-noshow',
        path: 'side',
        label: 'N분 경과',
        evidence: [doc('https://docs.acme.test/queue#noshow')],
        lineStyle: 'dashed',
      },
      {
        id: 't-6',
        from: 'st-noshow',
        to: 'st-undo',
        path: 'side',
        evidence: [code('web:src/undo.ts:5')],
        lineStyle: 'solid',
      },
      {
        id: 't-7',
        from: 'st-undo',
        to: 'st-notify',
        path: 'side',
        label: '30분 안',
        evidence: [code('web:src/undo.ts:9')],
        lineStyle: 'solid',
      },
    ],
  };
}

// 주문 변경 화면 흐름 시안을 본뜬 모양. 손님 혼자 화면을 넘기고 선 글자는 누른 버튼 이름이다.
// "품절 상품 포함?"에서 길이 갈리고 품절 시트 둘에서는 나가는 선이 없다.
// "조리 시작"은 매장이 상태를 바꿔서 뜨는 화면이라 들어오는 선이 없다
function orderChangeFlow(): ArchitectureFlow {
  const step = (id: string, label: string, extra: Partial<FlowStep> = {}): FlowStep => ({
    id,
    actor: 'guest',
    label,
    evidence: [code(`web:src/order/${id}.ts:1`)],
    ...extra,
  });
  const go = (
    id: string,
    from: string,
    to: string,
    path: 'main' | 'side',
    extra: Partial<FlowTransition> = {},
  ): FlowTransition => ({
    id,
    from,
    to,
    path,
    evidence: [code(`web:src/order/${id}.ts:1`)],
    lineStyle: 'solid',
    ...extra,
  });
  return {
    id: 'order-change',
    service: 'svc-shop',
    title: '주문 변경',
    actors: [{ id: 'guest', label: '손님', kind: 'person' }],
    stateLabels: { BEFORE_COOK: '조리 전 변경', COOKING: '조리 시작 후' },
    steps: [
      step('oc-detail', '주문 상세', { state: 'BEFORE_COOK', refs: ['s-queue'] }),
      step('oc-change', '주문 변경'),
      step('oc-menu', '메뉴 추가'),
      step('oc-check', '품절 상품 포함?', { kind: 'decision' }),
      step('oc-partial', '일부 품절 시트'),
      step('oc-all', '전부 품절 시트'),
      step('oc-pay', '추가 결제'),
      step('oc-done', '변경 완료', { terminal: true }),
      step('oc-cook', '조리 시작', { state: 'COOKING' }),
      step('oc-receipt', '영수증', { terminal: true }),
    ],
    transitions: [
      go('oc-t1', 'oc-detail', 'oc-change', 'main', { trigger: '주문 변경하기' }),
      go('oc-t2', 'oc-change', 'oc-menu', 'main', { trigger: '메뉴 추가하기' }),
      go('oc-t3', 'oc-menu', 'oc-check', 'main', { trigger: '담기' }),
      go('oc-t4', 'oc-check', 'oc-partial', 'side', { condition: '예, 일부 품절' }),
      go('oc-t5', 'oc-check', 'oc-all', 'side', { condition: '예, 전부 품절' }),
      go('oc-t6', 'oc-check', 'oc-pay', 'main', { condition: '아니오' }),
      go('oc-t7', 'oc-pay', 'oc-done', 'main', { trigger: '결제하기' }),
      go('oc-t8', 'oc-cook', 'oc-receipt', 'main', { trigger: '영수증 보기' }),
    ],
  };
}

function fixture(flow: ArchitectureFlow = queueFlow()): ArchitectureIr {
  return {
    schemaVersion: '1.0.0',
    view: 'screen-chain',
    repos: [
      {
        id: 'web',
        name: 'acme-web',
        root: '/srv/acme-web',
        remote: 'git@github.com:acme/acme-web.git',
      },
    ],
    nodes: [
      node('svc-shop', 'service'),
      node('f-queue', 'feature', 'svc-shop'),
      node('s-queue', 'screen', 'f-queue'),
      node('ep-register', 'endpoint'),
      node('m-queue', 'app_module'),
    ],
    edges: [
      {
        id: 'e-1',
        from: 's-queue',
        to: 'ep-register',
        kind: 'calls',
        evidence: [code('web:src/api.ts:1')],
        lineStyle: 'solid',
      },
      {
        id: 'e-2',
        from: 'ep-register',
        to: 'm-queue',
        kind: 'handles',
        evidence: [code('web:src/api.ts:2')],
        lineStyle: 'solid',
      },
    ],
    unresolved: [],
    sourcesUsed: [],
    generatedAt: '2026-10-01T00:00:00.000Z',
    flows: [flow],
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

describe('흐름 스키마', () => {
  it('flows가 있는 IR을 읽는다', () => {
    const parsed = parseArchitectureIr(fixture());
    expect(parsed.ok).toBe(true);
  });

  it('path는 main이나 side만 받는다', () => {
    const bad = fixture();
    (bad.flows![0]!.transitions[0] as { path: string }).path = 'detour';
    expect(parseArchitectureIr(bad).ok).toBe(false);
  });

  it('행위자 없는 흐름은 거부한다', () => {
    const bad = fixture({ ...queueFlow(), actors: [] });
    expect(parseArchitectureIr(bad).ok).toBe(false);
  });

  it('갈림길 종류와 누른 것, 조건을 읽고 parse 뒤에도 남긴다', () => {
    const parsed = parseArchitectureIr(fixture(orderChangeFlow()));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // zod가 strip 모드라 스키마에서 빠진 필드는 에러 없이 사라진다. 값이 남았는지 직접 본다
    const flow = parsed.value.flows![0]!;
    expect(flow.steps.find((s) => s.id === 'oc-check')!.kind).toBe('decision');
    expect(flow.transitions.find((t) => t.id === 'oc-t1')!.trigger).toBe('주문 변경하기');
    expect(flow.transitions.find((t) => t.id === 'oc-t6')!.condition).toBe('아니오');
  });

  it('모르는 단계 종류는 거부한다', () => {
    const f = orderChangeFlow();
    (f.steps[3] as { kind: string }).kind = 'diamond';
    expect(parseArchitectureIr(fixture(f)).ok).toBe(false);
  });

  it('갈림길에 끝 표시를 달면 terminal 자리를 짚어 거부한다', () => {
    const f = orderChangeFlow();
    f.steps[3] = { ...f.steps[3]!, terminal: true };
    const parsed = parseArchitectureIr(fixture(f));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain('flows.0.steps.3.terminal');
    // 갈림길이 아니면 끝 표시는 그대로 받는다
    const plain = orderChangeFlow();
    plain.steps[3] = { ...plain.steps[3]!, kind: 'step', terminal: true };
    expect(parseArchitectureIr(fixture(plain)).ok).toBe(true);
  });

  it('누른 것과 조건은 빈 글자를 받지 않는다', () => {
    const f = orderChangeFlow();
    f.transitions[0] = { ...f.transitions[0]!, trigger: '' };
    expect(parseArchitectureIr(fixture(f)).ok).toBe(false);
    const g = orderChangeFlow();
    g.transitions[5] = { ...g.transitions[5]!, condition: '' };
    expect(parseArchitectureIr(fixture(g)).ok).toBe(false);
  });

  it('새 필드가 없는 예전 흐름은 그대로 통과하고 필드가 덧붙지 않는다', () => {
    const parsed = parseArchitectureIr(fixture());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const flow = parsed.value.flows![0]!;
    expect(flow.steps.every((s) => !('kind' in s))).toBe(true);
    expect(flow.transitions.every((t) => !('trigger' in t) && !('condition' in t))).toBe(true);
  });
});

describe('흐름 검증', () => {
  it('정상 픽스처는 단계와 전이를 전부 그린다', () => {
    const v = validated(fixture());
    expect(v.drawableStepIds.size).toBe(7);
    expect(v.drawableTransitionIds.size).toBe(7);
  });

  it('service가 service 노드가 아니면 거부한다', () => {
    expect(errorsOf(fixture({ ...queueFlow(), service: 'f-queue' }))).toContain(
      'FLOW_SERVICE_NOT_FOUND',
    );
    expect(errorsOf(fixture({ ...queueFlow(), service: 'nope' }))).toContain(
      'FLOW_SERVICE_NOT_FOUND',
    );
  });

  it('없는 행위자와 없는 단계를 가리키면 거부한다', () => {
    const f = queueFlow();
    f.steps[0] = { ...f.steps[0]!, actor: 'robot' };
    f.transitions[0] = { ...f.transitions[0]!, to: 'st-ghost' };
    const codes = errorsOf(fixture(f));
    expect(codes).toContain('FLOW_ACTOR_NOT_FOUND');
    expect(codes).toContain('FLOW_STEP_NOT_FOUND');
  });

  it('전이 actors가 없는 행위자를 가리키면 거부한다', () => {
    const f = queueFlow();
    f.transitions[0] = { ...f.transitions[0]!, actors: ['guest', 'robot'] };
    expect(errorsOf(fixture(f))).toContain('FLOW_ACTOR_NOT_FOUND');
  });

  it('refs는 있는 화면이나 API, 기능, 앱만 가리킨다', () => {
    const missing = queueFlow();
    missing.steps[0] = { ...missing.steps[0]!, refs: ['s-ghost'] };
    expect(errorsOf(fixture(missing))).toContain('FLOW_REF_NOT_FOUND');
    const wrongKind = queueFlow();
    wrongKind.steps[0] = { ...wrongKind.steps[0]!, refs: ['m-queue'] };
    expect(errorsOf(fixture(wrongKind))).toContain('INVALID_FLOW_REF_KIND');
  });

  it('기획서만 있는 전이를 실선으로 적으면 거부한다', () => {
    const f = queueFlow();
    f.transitions[4] = { ...f.transitions[4]!, lineStyle: 'solid' };
    expect(errorsOf(fixture(f))).toContain('SOLID_TRANSITION_WITHOUT_EVIDENCE');
  });

  it('흐름 사이에서 단계 id가 겹치면 거부한다', () => {
    const ir = fixture();
    ir.flows!.push({ ...queueFlow(), id: 'queue-2' });
    expect(errorsOf(ir)).toContain('DUPLICATE_FLOW_ID');
  });

  it('근거 없는 단계와 전이는 빼고 질문으로 돌린다', () => {
    const f = queueFlow();
    f.steps[6] = { ...f.steps[6]!, evidence: [] };
    f.transitions[1] = { ...f.transitions[1]!, evidence: [], lineStyle: 'dashed' };
    const v = validated(fixture(f));
    expect(v.drawableStepIds.has('st-undo')).toBe(false);
    // 끝 단계가 빠진 전이도 같이 빠진다
    expect(v.drawableTransitionIds.has('t-6')).toBe(false);
    expect(v.drawableTransitionIds.has('t-2')).toBe(false);
    const ids = v.autoUnresolved.map((q) => q.id);
    expect(ids).toContain('auto:step:st-undo');
    expect(ids).toContain('auto:transition:t-2');
  });

  it('사람이 두 단계 사이를 잇기만 하는 단계는 전이로 적을지 묻는다', () => {
    const ir = fixture();
    // 세션이 단 다른 질문이 있어도 이 질문은 따로 선다
    ir.unresolved.push({ id: 'q-undo', subject: { stepId: 'st-undo' }, question: '몇 분까지?' });
    const ids = validated(ir).autoUnresolved.map((q) => q.id);
    expect(ids).toContain('auto:as-transition:st-undo');
    // 상태가 남고 앞으로 나아가는 단계는 진짜 단계다
    expect(ids).not.toContain('auto:as-transition:st-seat');
  });

  it('상태가 있어도 앞 단계로 되돌아가면 묻고 들어온 단계로 바로 돌아가면 안 묻는다', () => {
    const f = queueFlow();
    f.steps[6] = { ...f.steps[6]!, state: 'UNDO' };
    expect(validated(fixture(f)).autoUnresolved.map((q) => q.id)).toContain(
      'auto:as-transition:st-undo',
    );
    const asTransition = queueFlow();
    asTransition.steps = asTransition.steps.filter((s) => s.id !== 'st-undo');
    asTransition.transitions = asTransition.transitions.filter((t) => t.id !== 't-6');
    asTransition.transitions.find((t) => t.id === 't-7')!.from = 'st-noshow';
    asTransition.transitions.find((t) => t.id === 't-5')!.from = 'st-notify';
    asTransition.steps.find((s) => s.id === 'st-noshow')!.actor = 'staff';
    asTransition.transitions.find((t) => t.id === 't-7')!.to = 'st-notify';
    const ids = validated(fixture(asTransition)).autoUnresolved.map((q) => q.id);
    expect(ids.filter((id) => id.startsWith('auto:as-transition'))).toEqual([]);
  });

  it('나가는 전이가 없는데 끝 단계 표시가 없으면 어디로 가는지 묻는다', () => {
    const deadEnds = (f: ArchitectureFlow): string[] =>
      validated(fixture(f))
        .autoUnresolved.map((q) => q.id)
        .filter((id) => id.startsWith('auto:dead-end'));
    expect(deadEnds(queueFlow())).toEqual(['auto:dead-end:st-seat', 'auto:dead-end:st-cancel']);
    const f = queueFlow();
    f.steps.find((s) => s.id === 'st-seat')!.terminal = true;
    expect(deadEnds(f)).toEqual(['auto:dead-end:st-cancel']);
  });

  it('선 모양은 근거로 다시 정한다', () => {
    const f = queueFlow();
    // 코드 근거가 있는데 점선으로 적은 전이는 실선으로 바로잡는다
    f.transitions[0] = { ...f.transitions[0]!, lineStyle: 'dashed' };
    const v = validated(fixture(f));
    const t = v.ir.flows![0]!.transitions;
    expect(t.find((x) => x.id === 't-1')!.lineStyle).toBe('solid');
    expect(t.find((x) => x.id === 't-5')!.lineStyle).toBe('dashed');
  });

  const autoIds = (f: ArchitectureFlow): string[] =>
    validated(fixture(f)).autoUnresolved.map((q) => q.id);

  it('주문 변경 시안은 나가는 선 없는 품절 시트 둘만 묻는다', () => {
    const ids = autoIds(orderChangeFlow());
    expect(ids).toEqual(['auto:dead-end:oc-partial', 'auto:dead-end:oc-all']);
    // 들어오는 선이 없는 "조리 시작"은 정당한 시작점이라 묻지 않는다
    expect(ids.some((id) => id.endsWith(':oc-cook'))).toBe(false);
  });

  it('들어오는 선도 나가는 선도 없는 단계는 끝 단계가 아니면 예전처럼 어디로 가는지 묻는다', () => {
    const f = orderChangeFlow();
    f.steps = f.steps.filter((s) => s.id !== 'oc-receipt');
    f.transitions = f.transitions.filter((t) => t.id !== 'oc-t8');
    expect(autoIds(f)).toContain('auto:dead-end:oc-cook');
  });

  it('갈림길에서 나가는 길이 하나뿐이면 다른 조건의 행선지를 묻는다', () => {
    const f = orderChangeFlow();
    f.steps = f.steps.filter((s) => s.id !== 'oc-partial' && s.id !== 'oc-all');
    f.transitions = f.transitions.filter((t) => t.id !== 'oc-t4' && t.id !== 'oc-t5');
    const v = validated(fixture(f));
    const q = v.autoUnresolved.find((x) => x.id === 'auto:branch:oc-check');
    expect(q).toBeDefined();
    expect(q!.subject).toEqual({ stepId: 'oc-check' });
    expect(q!.question).toBe(
      '"품절 상품 포함?"에서 갈리는 길이 하나뿐이에요. 다른 조건일 때는 어디로 가나요?',
    );
    // 길이 둘 이상이면 묻지 않는다
    expect(autoIds(orderChangeFlow()).some((id) => id.startsWith('auto:branch'))).toBe(false);
  });

  it('나가는 길이 없는 갈림길은 branch가 아니라 dead-end가 묻는다', () => {
    const f = orderChangeFlow();
    f.steps = f.steps.filter((s) => !['oc-partial', 'oc-all', 'oc-pay', 'oc-done'].includes(s.id));
    f.transitions = f.transitions.filter((t) => t.from !== 'oc-check' && t.id !== 'oc-t7');
    const ids = autoIds(f);
    expect(ids).toContain('auto:dead-end:oc-check');
    expect(ids.some((id) => id.startsWith('auto:branch'))).toBe(false);
  });

  it('근거 없는 갈림길은 일반 단계처럼 빼고 갈림길 질문을 안 만든다', () => {
    const f = orderChangeFlow();
    f.steps[3] = { ...f.steps[3]!, evidence: [] };
    f.steps = f.steps.filter((s) => s.id !== 'oc-partial' && s.id !== 'oc-all');
    f.transitions = f.transitions.filter((t) => t.id !== 'oc-t4' && t.id !== 'oc-t5');
    // 그려지는 갈림길이었다면 branch와 condition 질문이 둘 다 뜨는 모양이다
    delete f.transitions.find((t) => t.id === 'oc-t6')!.condition;
    const v = validated(fixture(f));
    expect(v.drawableStepIds.has('oc-check')).toBe(false);
    const ids = v.autoUnresolved.map((q) => q.id);
    expect(ids).toContain('auto:step:oc-check');
    expect(ids.some((id) => id.startsWith('auto:branch') || id.startsWith('auto:condition'))).toBe(
      false,
    );
  });

  it('갈림길에서 나가는 근거 있는 길에 조건이 없으면 어떤 조건인지 묻는다', () => {
    const f = orderChangeFlow();
    const t4 = f.transitions.find((t) => t.id === 'oc-t4')!;
    delete t4.condition;
    const v = validated(fixture(f));
    const q = v.autoUnresolved.find((x) => x.id === 'auto:condition:oc-t4');
    expect(q).toBeDefined();
    expect(q!.subject).toEqual({ transitionId: 'oc-t4' });
    expect(q!.question).toBe(
      '"품절 상품 포함?"에서 "일부 품절 시트"로 가는 길은 어떤 조건일 때인가요?',
    );
    // 조건이 있는 길과 갈림길이 아닌 단계에서 나가는 길은 묻지 않는다
    const ids = v.autoUnresolved.map((x) => x.id);
    expect(ids.filter((id) => id.startsWith('auto:condition'))).toEqual(['auto:condition:oc-t4']);
  });

  it('예전 label에 조건을 적은 갈림길 길은 묻지 않는다', () => {
    const f = orderChangeFlow();
    const t4 = f.transitions.find((t) => t.id === 'oc-t4')!;
    delete t4.condition;
    t4.label = '일부 품절';
    expect(autoIds(f).some((id) => id.startsWith('auto:condition'))).toBe(false);
  });

  it('근거 없는 갈림길 길은 transition 질문만 받고 condition 질문은 안 받는다', () => {
    const f = orderChangeFlow();
    const t5 = f.transitions.find((t) => t.id === 'oc-t5')!;
    delete t5.condition;
    t5.evidence = [];
    t5.lineStyle = 'dashed';
    const ids = autoIds(f);
    expect(ids).toContain('auto:transition:oc-t5');
    expect(ids).not.toContain('auto:condition:oc-t5');
  });

  it('갈림길은 두 단계 사이를 잇기만 해도 전이로 적을지 묻지 않는다', () => {
    // 갈림길에 들고 나는 길이 하나씩이고 나간 곳에 다른 길도 들어오는 모양. 일반 단계면 묻는 자리다
    const shape = (kind: 'step' | 'decision'): ArchitectureFlow => {
      const f = orderChangeFlow();
      f.steps = f.steps.filter((s) => s.id !== 'oc-partial' && s.id !== 'oc-all');
      f.steps[3] = { ...f.steps[3]!, kind };
      f.transitions = f.transitions.filter((t) => t.id !== 'oc-t4' && t.id !== 'oc-t5');
      f.transitions.push({
        id: 'oc-direct',
        from: 'oc-menu',
        to: 'oc-pay',
        path: 'main',
        trigger: '바로 결제',
        evidence: [code('web:src/order/direct.ts:1')],
        lineStyle: 'solid',
      });
      return f;
    };
    expect(autoIds(shape('step'))).toContain('auto:as-transition:oc-check');
    expect(autoIds(shape('decision'))).not.toContain('auto:as-transition:oc-check');
  });
});

describe('흐름 배치', () => {
  const layoutOf = (ir: ArchitectureIr) => {
    const v = validated(ir);
    return computeFlowLayout(v.ir.flows![0]!, v.drawableStepIds, v.drawableTransitionIds);
  };

  it('정상 흐름은 왼쪽에서 오른쪽으로 한 열씩 나아간다', () => {
    const layout = layoutOf(fixture());
    const col = (id: string) => layout.steps.find((s) => s.id === id)!.column;
    expect([col('st-register'), col('st-notify'), col('st-call'), col('st-seat')]).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it('단계는 자기 행위자 줄 안에 선다', () => {
    const layout = layoutOf(fixture());
    const lane = (actor: string) => layout.lanes.find((l) => l.actor.id === actor)!;
    for (const [step, actor] of [
      ['st-register', 'guest'],
      ['st-notify', 'sys'],
      ['st-call', 'staff'],
    ] as const) {
      const box = layout.steps.find((s) => s.id === step)!;
      const l = lane(actor);
      expect(box.y).toBeGreaterThanOrEqual(l.y);
      expect(box.y + box.height).toBeLessThanOrEqual(l.y + l.height);
    }
  });

  it('옆 흐름 단계는 side로 표시하고 정상 흐름 줄 아래로 내린다', () => {
    const layout = layoutOf(fixture());
    const cancel = layout.steps.find((s) => s.id === 'st-cancel')!;
    expect(cancel.path).toBe('side');
    expect(cancel.row).toBeGreaterThanOrEqual(1);
    expect(layout.steps.find((s) => s.id === 'st-register')!.path).toBe('main');
  });

  it('앞 단계로 돌아가는 전이는 back으로 표시한다', () => {
    const layout = layoutOf(fixture());
    expect(layout.transitions.find((t) => t.id === 't-7')!.back).toBe(true);
    expect(layout.transitions.find((t) => t.id === 't-1')!.back).toBe(false);
    expect(layout.height).toBeGreaterThan(layout.lanes.reduce((n, l) => n + l.height, 0));
  });

  // 되돌리기를 단계 대신 전이로 적은 모양. 새 상태가 없고 앞 상태로 돌아가기만 해서다
  function undoAsTransition(): ArchitectureFlow {
    const f = queueFlow();
    f.steps = f.steps.filter((s) => s.id !== 'st-undo');
    f.transitions = f.transitions.filter((t) => t.id !== 't-6' && t.id !== 't-7');
    f.transitions.push({
      id: 't-undo',
      from: 'st-noshow',
      to: 'st-call',
      path: 'side',
      label: '되돌리기',
      actors: ['guest', 'staff'],
      evidence: [code('web:src/undo.ts:9')],
      lineStyle: 'solid',
    });
    return f;
  }

  it('되돌아가는 선은 막히지 않으면 그림 맨 아래로 안 내려가고 두 카드 가까이에서 건넌다', () => {
    const layout = layoutOf(fixture(undoAsTransition()));
    const undo = layout.transitions.find((t) => t.id === 't-undo')!;
    expect(undo.back).toBe(true);
    const lanesBottom = layout.lanes.reduce((n, l) => Math.max(n, l.y + l.height), 0);
    expect(Math.max(...undo.points.map((p) => p.y))).toBeLessThan(lanesBottom);
    expect(layout.height).toBe(lanesBottom);
    expect(undo.labelAt).toBeDefined();
  });

  it('같은 입력이면 같은 좌표가 나온다', () => {
    expect(JSON.stringify(layoutOf(fixture()))).toBe(JSON.stringify(layoutOf(fixture())));
  });

  // 실제 서비스처럼 등록 경로가 여럿이고 옆 흐름이 길게 이어지다 정상 흐름으로 돌아오는 모양
  function branchyFlow(): ArchitectureFlow {
    const f = queueFlow();
    const step = (id: string, actor: string) => ({
      id,
      actor,
      label: id,
      evidence: [code(`web:src/${id}.ts:1`)],
    });
    const side = (id: string, from: string, to: string) => ({
      id,
      from,
      to,
      path: 'side' as const,
      evidence: [code(`web:src/${id}.ts:1`)],
      lineStyle: 'solid' as const,
    });
    f.steps.push(
      step('st-walkin', 'guest'),
      step('st-hold-1', 'guest'),
      step('st-hold-2', 'staff'),
      step('st-hold-3', 'sys'),
    );
    f.transitions.push(
      { ...side('t-w', 'st-walkin', 'st-notify'), path: 'main' },
      side('t-h1', 'st-register', 'st-hold-1'),
      side('t-h2', 'st-hold-1', 'st-hold-2'),
      side('t-h3', 'st-hold-2', 'st-hold-3'),
      side('t-h4', 'st-hold-3', 'st-seat'),
    );
    return f;
  }

  it('옆 흐름이 길게 이어져 정상 단계로 돌아와도 정상 흐름 열은 안 밀린다', () => {
    const layout = layoutOf(fixture(branchyFlow()));
    const col = (id: string) => layout.steps.find((s) => s.id === id)!.column;
    expect([col('st-register'), col('st-notify'), col('st-call'), col('st-seat')]).toEqual([
      0, 1, 2, 3,
    ]);
    expect(col('st-hold-1')).toBeGreaterThan(col('st-register'));
  });

  it('옆 흐름 선은 양 끝이 아닌 카드를 뚫고 지나가지 않는다', () => {
    const layout = layoutOf(fixture(branchyFlow()));
    const crosses = (
      p: { x: number; y: number },
      q: { x: number; y: number },
      b: { x: number; y: number; width: number; height: number },
    ) => {
      const [x1, x2] = [Math.min(p.x, q.x), Math.max(p.x, q.x)];
      const [y1, y2] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
      return x1 < b.x + b.width && x2 > b.x && y1 < b.y + b.height && y2 > b.y;
    };
    for (const r of layout.transitions.filter((t) => t.path === 'side' && !t.back)) {
      const others = layout.steps.filter((s) => s.id !== r.from && s.id !== r.to);
      for (let i = 1; i < r.points.length; i += 1) {
        for (const b of others) {
          expect(crosses(r.points[i - 1]!, r.points[i]!, b), `${r.id} → ${b.id}`).toBe(false);
        }
      }
    }
  });

  const boxIn = (layout: ReturnType<typeof layoutOf>, id: string) =>
    layout.steps.find((s) => s.id === id)!;
  const routeIn = (layout: ReturnType<typeof layoutOf>, id: string) =>
    layout.transitions.find((t) => t.id === id)!;

  it('갈림길은 카드보다 8px 높은 마름모로 4px 위에 서서 가운데 y가 이웃 카드와 같다', () => {
    const layout = layoutOf(fixture(orderChangeFlow()));
    const check = boxIn(layout, 'oc-check');
    const menu = boxIn(layout, 'oc-menu');
    expect(check.shape).toBe('diamond');
    expect(check.height).toBe(FLOW_DECISION_HEIGHT);
    expect(check.width).toBe(FLOW_STEP_WIDTH);
    expect(check.y).toBe(menu.y - (FLOW_DECISION_HEIGHT - FLOW_STEP_HEIGHT) / 2);
    expect(check.y + check.height / 2).toBe(menu.y + menu.height / 2);
    // 일반 단계에는 shape 칸이 아예 없다
    expect('shape' in menu).toBe(false);
  });

  it('갈림길에서 다른 줄로 가는 길은 아래 꼭짓점에서 나가고 글자를 꼭짓점 옆에 붙인다', () => {
    const layout = layoutOf(fixture(orderChangeFlow()));
    const check = boxIn(layout, 'oc-check');
    const partial = routeIn(layout, 'oc-t4');
    expect(partial.points[0]).toEqual({ x: check.x + 88, y: check.y + check.height });
    expect(partial.points[1]!.x).toBe(check.x + 88);
    expect(partial.labelAnchor).toBe('start');
    // 렌더러가 y에서 5를 빼기 전 값이다. 아래로 나가면 꼭짓점 밑에 선다
    expect(partial.labelAt).toEqual({ x: check.x + 88 + 6, y: check.y + check.height + 19 });
  });

  it('같은 갈림길에서 나간 선끼리는 글자 자리가 겹치지 않는다', () => {
    const layout = layoutOf(fixture(orderChangeFlow()));
    const check = boxIn(layout, 'oc-check');
    const partial = routeIn(layout, 'oc-t4');
    const all = routeIn(layout, 'oc-t5');
    // 둘 다 아래 꼭짓점에서 나간다. 그래서 글자가 같은 자리를 받으면 포개진다
    expect(all.points[0]).toEqual(partial.points[0]);
    expect(all.labelAnchor).toBe('start');
    expect(all.labelAt).toEqual({ x: check.x + 88 + 6, y: check.y + check.height + 19 + 14 });
    const spots = layout.transitions
      .filter((t) => t.from === 'oc-check')
      .map((t) => JSON.stringify(t.labelAt));
    expect(spots).toHaveLength(3);
    expect(new Set(spots).size).toBe(spots.length);
  });

  it('갈림길에서 같은 줄로 가는 길은 오른쪽 꼭짓점에서 곧게 나간다', () => {
    const layout = layoutOf(fixture(orderChangeFlow()));
    const check = boxIn(layout, 'oc-check');
    const pay = boxIn(layout, 'oc-pay');
    const no = routeIn(layout, 'oc-t6');
    const cy = check.y + check.height / 2;
    expect(no.points).toEqual([
      { x: check.x + check.width, y: cy },
      { x: pay.x, y: cy },
    ]);
    expect(no.labelAnchor).toBe('start');
    expect(no.labelAt).toEqual({ x: check.x + check.width + 6, y: cy });
    // 갈림길이 아닌 단계에서 나가는 선 글자는 가운데 정렬 그대로다
    expect('labelAnchor' in routeIn(layout, 'oc-t1')).toBe(false);
  });

  it('누른 것이나 조건이 있는 흐름만 선 글자 폭에 맞춰 열 사이를 넓힌다', () => {
    const layout = layoutOf(fixture(orderChangeFlow()));
    const texts = orderChangeFlow().transitions.map((t) =>
      [t.condition, t.trigger].filter((x) => x !== undefined).join(' '),
    );
    const gap = Math.min(168, Math.max(56, Math.max(...texts.map(textUnits)) * 6 + 20));
    expect(gap).toBeGreaterThan(56);
    const x = (id: string) => boxIn(layout, id).x;
    expect(x('oc-change') - x('oc-detail')).toBe(FLOW_STEP_WIDTH + gap);
    expect(x('oc-detail')).toBe(
      gap / 2 + boxIn(layout, 'oc-detail').column * (FLOW_STEP_WIDTH + gap),
    );

    // 같은 흐름을 예전 label로 적으면 간격은 56 그대로다
    const plain = orderChangeFlow();
    plain.transitions = plain.transitions.map(({ trigger, condition, ...t }) => ({
      ...t,
      label: (trigger ?? condition)!,
    }));
    const old = layoutOf(fixture(plain));
    expect(boxIn(old, 'oc-change').x - boxIn(old, 'oc-detail').x).toBe(FLOW_STEP_WIDTH + 56);
  });

  it('긴 버튼 이름이어도 열 사이는 168을 안 넘는다', () => {
    const f = orderChangeFlow();
    f.transitions[0] = {
      ...f.transitions[0]!,
      trigger: '주문 내역에서 변경할 메뉴를 고르고 저장하기',
    };
    const layout = layoutOf(fixture(f));
    expect(boxIn(layout, 'oc-change').x - boxIn(layout, 'oc-detail').x).toBe(FLOW_STEP_WIDTH + 168);
  });

  it('새 필드가 없는 예전 흐름은 좌표가 예전 공식 그대로다', () => {
    const layout = layoutOf(fixture());
    expect(layout.headWidth).toBe(FLOW_HEAD_WIDTH);
    expect(layout.stageTop).toBe(0);
    for (const b of layout.steps) {
      expect(b.x).toBe(FLOW_HEAD_WIDTH + 56 / 2 + b.column * (FLOW_STEP_WIDTH + 56));
      expect(b.height).toBe(FLOW_STEP_HEIGHT);
    }
    expect(layout.transitions.every((t) => !('labelAnchor' in t))).toBe(true);
  });

  it('행위자가 한 명이면 머리 칸 없이 그림 맨 위에 행위자 띠를 둔다', () => {
    const layout = layoutOf(fixture(orderChangeFlow()));
    expect(layout.headWidth).toBe(0);
    expect(layout.stageTop).toBe(FLOW_ACTOR_BAND);
    expect(layout.lanes).toHaveLength(1);
  });

  it('주문 변경 시안도 같은 입력이면 같은 좌표가 나온다', () => {
    expect(JSON.stringify(layoutOf(fixture(orderChangeFlow())))).toBe(
      JSON.stringify(layoutOf(fixture(orderChangeFlow()))),
    );
  });
});

describe('흐름 구간', () => {
  const layoutOf = (ir: ArchitectureIr) => {
    const v = validated(ir);
    return computeFlowLayout(v.ir.flows![0]!, v.drawableStepIds, v.drawableTransitionIds);
  };

  it('정상 흐름은 상태 값마다 구간을 나누고 그 너머로 나간 옆 흐름은 맨 끝 구간을 받는다', () => {
    const layout = layoutOf(fixture());
    expect(layout.stages.map((s) => s.label)).toEqual(['WAITING', 'CALL', 'SITTING', '옆 흐름']);
    expect(layout.stages.map((s) => s.side)).toEqual([false, false, false, true]);
  });

  it('상태가 없는 단계는 앞 단계의 구간에 붙는다', () => {
    const layout = layoutOf(fixture());
    const waiting = layout.stages[0]!;
    const notify = layout.steps.find((s) => s.id === 'st-notify')!;
    expect(notify.x).toBeGreaterThanOrEqual(waiting.x);
    expect(notify.x + notify.width).toBeLessThanOrEqual(waiting.x + waiting.width);
  });

  it('옆 흐름 단계는 맨 끝에 모이지 않고 갈라져 나온 단계 바로 다음 열에 선다', () => {
    const layout = layoutOf(fixture());
    const col = (id: string) => layout.steps.find((s) => s.id === id)!.column;
    expect(col('st-cancel')).toBe(col('st-notify') + 1);
    expect(col('st-noshow')).toBe(col('st-call') + 1);
    const side = layout.stages.find((s) => s.side)!;
    const cancel = layout.steps.find((s) => s.id === 'st-cancel')!;
    expect(cancel.x + cancel.width).toBeLessThanOrEqual(side.x);
  });

  it('옆 흐름 카드 상태가 선 자리 열 머리와 다르면 갈라져 나온 구간 뒤에 옆 흐름 구간을 끼운다', () => {
    const flow = queueFlow();
    flow.steps.find((s) => s.id === 'st-noshow')!.state = 'NOSHOW';
    const layout = layoutOf(fixture(flow));
    const stage = (id: string) => {
      const b = layout.steps.find((s) => s.id === id)!;
      return layout.stages.find((g) => b.x >= g.x && b.x + b.width <= g.x + g.width)!;
    };
    expect(layout.stages.map((g) => g.label)).toEqual(['WAITING', 'CALL', '옆 흐름', 'SITTING']);
    expect(stage('st-noshow').side).toBe(true);
    expect(stage('st-seat').label).toBe('SITTING');
    // 상태 없는 옆 흐름 카드는 원래처럼 갈라져 나온 단계 바로 다음 열에 선다
    expect(stage('st-cancel').label).toBe('CALL');
  });

  it('정상 흐름에 상태 값이 없으면 구간을 안 만든다', () => {
    const flow = queueFlow();
    for (const step of flow.steps) delete step.state;
    const layout = layoutOf(fixture(flow));
    expect(layout.stages).toEqual([]);
  });

  it('행위자가 한 명이면 구간 머리를 행위자 띠 아래에 두고 첫 줄을 그 아래에서 시작한다', () => {
    const layout = layoutOf(fixture(orderChangeFlow()));
    expect(layout.stageTop).toBe(FLOW_ACTOR_BAND);
    expect(layout.stages.map((s) => s.label)).toEqual(['BEFORE_COOK', 'COOKING']);
    expect(layout.lanes[0]!.y).toBe(FLOW_ACTOR_BAND + FLOW_STAGE_HEAD);
  });

  it('들어오는 선 없는 단계가 첫 단계와 같은 열을 받아도 구간은 steps에 적힌 순서를 따른다', () => {
    const layout = layoutOf(fixture(orderChangeFlow()));
    const col = (id: string) => layout.steps.find((s) => s.id === id)!.column;
    expect(layout.stages.map((s) => s.label)).toEqual(['BEFORE_COOK', 'COOKING']);
    expect(layout.stages[0]!.x).toBeLessThan(layout.stages[1]!.x);
    // 주문 변경 흐름이 맨 앞 열부터 서고 "조리 시작"은 그 뒤 구간으로 간다
    expect(col('oc-detail')).toBe(0);
    expect(col('oc-cook')).toBeGreaterThan(col('oc-done'));
  });

  it('행위자가 한 명이어도 구간이 없으면 띠만큼만 내려간다', () => {
    const flow = orderChangeFlow();
    for (const step of flow.steps) delete step.state;
    const layout = layoutOf(fixture(flow));
    expect(layout.stages).toEqual([]);
    expect(layout.lanes[0]!.y).toBe(FLOW_ACTOR_BAND);
  });
});

describe('흐름 레벨 렌더', () => {
  async function render(ir: ArchitectureIr, audience: 'private' | 'shared' = 'private') {
    const v = validated(ir);
    const drill = await computeDrilldown(v);
    return { drill, html: renderDrilldownHtml(v, drill, { audience }) };
  }

  it('끝 단계 카드에 끝 표시를 달고 읽어주는 글에도 넣는다', async () => {
    const f = queueFlow();
    f.steps.find((s) => s.id === 'st-seat')!.terminal = true;
    const { html } = await render(fixture(f));
    const card = (id: string): string =>
      html.match(new RegExp(`data-node-id="${id}"[^]*?</div>`))![0];
    expect(card('st-seat')).toContain('<span class="end" title="흐름 끝">끝</span>');
    expect(card('st-seat')).toMatch(/aria-label="입장, [^"]*, 흐름 끝"/);
    expect(card('st-cancel')).not.toContain('class="end"');
  });

  it('서비스 아래에 흐름 레벨을 만든다', async () => {
    const { drill } = await render(fixture());
    expect(drill.flows.map((l) => l.id)).toEqual(['flow:queue']);
    expect(drill.flows[0]!.trail).toEqual(['root', 'service:svc-shop', 'flow:queue']);
  });

  it('흐름 섹션과 전이, 흐름 단추를 그린다', async () => {
    const { html } = await render(fixture());
    expect(html).toContain('data-level-id="flow:queue"');
    expect(html).toContain('data-transition-id="t-5"');
    expect(html).toContain('id="flow-btn"');
    expect(html).toContain('class="node flow-step p-side doc-only" data-node-id="st-noshow"');
    expect(html).toMatch(/data-transition-id="t-5"[^>]*>.*?stroke-dasharray/);
    expect(html).toContain('class="fstage"');
    expect(html).toContain('class="fstage side"');
  });

  it('상태 이름이 있으면 구간 머리와 단계 칩에 상태 값 대신 그 이름을 찍는다', async () => {
    const flow = queueFlow();
    flow.stateLabels = { WAITING: '대기', CALL: '호출' };
    const { html } = await render(fixture(flow));
    expect(html).toContain('<div class="fstage named"');
    expect(html).toMatch(/class="fstage named"[^>]*title="대기"><span>대기<\/span>/);
    expect(html).toContain('<span class="st named" title="WAITING">대기</span>');
    expect(html).toMatch(/aria-label="[^"]*상태 호출/);
    // 이름이 없는 상태는 상태 값 그대로다
    expect(html).toContain('<span class="st" title="SITTING">SITTING</span>');
  });

  it('되돌아가는 전이는 둥근 선에 표시를 달고 일으키는 행위자 이름을 선 글자 옆에 붙인다', async () => {
    const flow = queueFlow();
    flow.steps = flow.steps.filter((s) => s.id !== 'st-undo');
    flow.transitions = flow.transitions.filter((t) => t.id !== 't-6' && t.id !== 't-7');
    flow.transitions.push({
      id: 't-undo',
      from: 'st-noshow',
      to: 'st-call',
      path: 'side',
      label: '되돌리기',
      actors: ['guest', 'staff'],
      evidence: [code('web:src/undo.ts:9')],
      lineStyle: 'solid',
    });
    const { html } = await render(fixture(flow));
    const g = html.match(
      /<g class="link flow-t p-side back"[^>]*data-transition-id="t-undo".*?<\/g>/,
    )![0];
    expect(g).toContain('aria-label="옆 흐름, 앞 단계로 되돌아감: ');
    expect(g).toContain('누가 손님, 직원');
    expect(g).toMatch(/<path class="edge" d="[^"]* Q/);
    expect(g).toContain(
      '<tspan class="t-back">↩ </tspan>되돌리기<tspan class="t-who"> · 손님, 직원</tspan>',
    );
  });

  it('공유본은 상태 이름도 계정 ID를 가린다', async () => {
    const flow = queueFlow();
    flow.stateLabels = { WAITING: '대기 123456789012' };
    const { html } = await render(fixture(flow), 'shared');
    expect(html).not.toContain('123456789012');
  });

  it('전체보기 서비스 카드에 흐름 배지를 달고 그 폭만큼 카드를 넓힌다', async () => {
    const { html, drill } = await render(fixture());
    const root = drill.levels.find((l) => l.id === 'root')!;
    expect(html).toMatch(/data-node-id="svc-shop"[^>]*aria-label="[^"]*사용자 흐름 1개"/);
    expect(html).toMatch(/data-node-id="svc-shop".*?<span class="flow-badge"[^>]*>.*?흐름<\/span>/);

    const ir = fixture();
    delete ir.flows;
    const plain = await render(ir);
    const width = (d: typeof drill, id: string) =>
      d.levels.find((l) => l.id === 'root')!.layout.nodes.find((n) => n.id === id)!.width;
    expect(width(drill, 'svc-shop')).toBeGreaterThan(width(plain.drill, 'svc-shop'));
    expect(plain.html).not.toContain('class="flow-badge"');
    expect(root.nodeIds).toContain('svc-shop');
  });

  it('흐름이 없으면 흐름 단추를 안 단다', async () => {
    const ir = fixture();
    delete ir.flows;
    const { html, drill } = await render(ir);
    expect(drill.flows).toEqual([]);
    expect(html).not.toContain('id="flow-btn"');
    expect(html).not.toContain('id="flow-pop"');
  });

  it('단계 질문은 그 단계 카드로 데려간다', async () => {
    const ir = fixture();
    ir.unresolved.push({
      id: 'q-1',
      subject: { stepId: 'st-noshow' },
      question: '노쇼 기준이 몇 분인가요?',
    });
    ir.unresolved.push({
      id: 'q-2',
      subject: { transitionId: 't-7' },
      question: '되돌리기 제한이 30분인가요?',
    });
    const { html } = await render(ir);
    expect(html).toMatch(/class="q" data-node-id="st-noshow"/);
    expect(html).toMatch(/class="q" data-node-id="st-undo"/);
    expect(html).toMatch(/data-node-id="st-noshow"[^>]*>.*?class="qb"/);
  });

  it('단계와 전이 패널이 쓰도록 질문 문장을 흐름 데이터에 싣는다', async () => {
    const ir = fixture();
    ir.unresolved.push({
      id: 'q-2',
      subject: { transitionId: 't-7' },
      question: '되돌리기 제한이 30분인가요?',
    });
    ir.unresolved.push({
      id: 'q-1',
      subject: { stepId: 'st-noshow' },
      question: '노쇼 기준이 몇 분인가요?',
    });
    const { html } = await render(ir);
    const block = html.slice(html.indexOf('<script id="ir"'));
    const data = JSON.parse(block.slice(block.indexOf('>') + 1, block.indexOf('</script>'))) as {
      flows: {
        steps: { id: string; questions?: string[] }[];
        transitions: { id: string; questions?: string[] }[];
      }[];
    };
    const flow = data.flows[0]!;
    expect(flow.transitions.find((t) => t.id === 't-7')!.questions).toEqual([
      '되돌리기 제한이 30분인가요?',
    ]);
    expect(flow.steps.find((st) => st.id === 'st-noshow')!.questions).toEqual([
      '노쇼 기준이 몇 분인가요?',
    ]);
    expect(flow.transitions.find((t) => t.id === 't-1')!.questions).toBeUndefined();
  });

  it('같은 입력이면 같은 바이트가 나온다', async () => {
    const a = await render(fixture());
    const b = await render(fixture());
    expect(a.html).toBe(b.html);
  });

  it('공유본은 단계 글자의 계정 ID와 private 출처를 가린다', async () => {
    const f = queueFlow();
    f.steps[5] = {
      ...f.steps[5]!,
      label: '노쇼 123456789012',
      evidence: [{ ...doc('https://wiki.acme.test/private/noshow'), visibility: 'private' }],
    };
    const priv = await render(fixture(f), 'private');
    expect(priv.html).toContain('https://wiki.acme.test/private/noshow');
    const { html } = await render(fixture(f), 'shared');
    expect(html).not.toContain('123456789012');
    expect(html).not.toContain('wiki.acme.test/private');
  });

  it('private 출처에 발췌를 실으면 거부한다', () => {
    const f = queueFlow();
    f.steps[0] = {
      ...f.steps[0]!,
      evidence: [{ ...code('web:src/register.ts:10'), visibility: 'private', excerpt: 'body' }],
    };
    expect(errorsOf(fixture(f))).toContain('PRIVATE_EXCERPT_PRESENT');
  });

  const linkOf = (html: string, id: string): string =>
    html.match(new RegExp(`<g class="link flow-t[^"]*"[^>]*data-transition-id="${id}".*?</g>`))![0];
  const cardOf = (html: string, id: string): string =>
    html.match(new RegExp(`<div class="node flow-step[^"]*" data-node-id="${id}"[^>]*>`))![0];
  // 조건부로 붙는 CSS와 클라이언트 조각을 알아보는 표지
  const BRANCH_CSS_MARK = '.flow-step.decision .dshape polygon';
  const BRANCH_CLIENT_MARK = "'나뉘는 길 '";

  it('갈림길은 마름모 카드로 그리고 읽어주는 글에 갈림길이라고 넣는다', async () => {
    const { html } = await render(fixture(orderChangeFlow()));
    const card = cardOf(html, 'oc-check');
    expect(card).toContain('class="node flow-step p-main decision"');
    expect(card).toContain('aria-label="품절 상품 포함?, 갈림길, 손님"');
    expect(card).toContain('height:72px');
    expect(html).toContain(
      '<svg class="dshape" viewBox="0 0 176 72" preserveAspectRatio="none" aria-hidden="true">' +
        '<polygon points="88,1 175,36 88,71 1,36"/></svg>',
    );
    expect(cardOf(html, 'oc-menu')).not.toContain('decision');
    expect(html).toContain('<span class="swatch-decision"></span>마름모');
  });

  it('선에는 누른 것을 찍고 조건은 t-cond로 앞에 붙인다', async () => {
    const f = orderChangeFlow();
    f.transitions[6] = {
      ...f.transitions[6]!,
      condition: '추가 금액 있음',
      label: '결제 모듈 메모',
    };
    const { html } = await render(fixture(f));
    const t1 = linkOf(html, 'oc-t1');
    expect(t1).toContain('aria-label="정상 흐름: 주문 상세 → 주문 변경 (누른 것 주문 변경하기)"');
    expect(t1).toMatch(/<text class="t-label" x="[^"]+" y="[^"]+">주문 변경하기<\/text>/);
    const t6 = linkOf(html, 'oc-t6');
    expect(t6).toContain('(조건 아니오)');
    expect(t6).toMatch(
      /<text class="t-label at-start" [^>]*><tspan class="t-cond">아니오<\/tspan><\/text>/,
    );
    // 조건과 누른 것이 둘 다 있으면 조건 다음에 누른 것. label은 선에 안 찍고 서랍 메모로 간다
    const t7 = linkOf(html, 'oc-t7');
    expect(t7).toContain('(조건 추가 금액 있음, 누른 것 결제하기)');
    expect(t7).toContain('<tspan class="t-cond">추가 금액 있음 </tspan>결제하기</text>');
    expect(t7).not.toContain('결제 모듈 메모');
    const block = html.slice(html.indexOf('<script id="ir"'));
    const data = JSON.parse(block.slice(block.indexOf('>') + 1, block.indexOf('</script>'))) as {
      flows: {
        transitions: { id: string; label?: string; trigger?: string; condition?: string }[];
      }[];
    };
    const t = data.flows[0]!.transitions.find((x) => x.id === 'oc-t7')!;
    expect(t).toMatchObject({
      trigger: '결제하기',
      condition: '추가 금액 있음',
      label: '결제 모듈 메모',
    });
  });

  it('누른 것에 행위자도 있으면 이름을 뒤에 붙인다', async () => {
    const f = orderChangeFlow();
    f.transitions[0] = { ...f.transitions[0]!, actors: ['guest'] };
    const { html } = await render(fixture(f));
    expect(linkOf(html, 'oc-t1')).toContain('주문 변경하기<tspan class="t-who"> · 손님</tspan>');
  });

  it('행위자가 한 명이면 머리 칸 대신 맨 위 칩을 세우고 섹션 이름에 행위자를 넣는다', async () => {
    const { html } = await render(fixture(orderChangeFlow()));
    const section = html.match(/<section class="level flow-level"[^>]*>/)![0];
    expect(section).toContain('aria-label="주문 변경, 행위자 손님"');
    expect(html).toContain('<div class="flane-actor a-person" style="left:28px;top:24px">');
    expect(html).not.toContain('class="flane-title');
    // 구간 머리는 행위자 띠 아래에 선다
    expect(html).toMatch(/class="fstage named" style="left:[^;]+;top:52px;/);
  });

  it('행위자가 여럿이면 예전처럼 줄마다 머리 칸을 그린다', async () => {
    const { html } = await render(fixture());
    expect(html).toContain('class="flane-title a-person"');
    expect(html).not.toContain('class="flane-actor');
  });

  it('갈림길이나 누른 것, 조건이 없는 흐름 그림에는 새 CSS와 클라이언트 조각을 싣지 않는다', async () => {
    const { html } = await render(fixture());
    expect(html).not.toContain(BRANCH_CSS_MARK);
    expect(html).not.toContain('.flane-actor {');
    expect(html).not.toContain(BRANCH_CLIENT_MARK);
    expect(html).not.toContain('swatch-decision');
    expect(html).not.toContain('class="dshape"');
  });

  it('갈림길이 있으면 CSS와 클라이언트 조각을 함께 싣는다', async () => {
    const { html } = await render(fixture(orderChangeFlow()));
    expect(html).toContain(BRANCH_CSS_MARK);
    expect(html).toContain(BRANCH_CLIENT_MARK);
  });

  it('누른 것만 있고 갈림길이 없어도 클라이언트 조각을 싣고 범례 마름모 줄은 뺀다', async () => {
    const f = queueFlow();
    f.transitions[0] = { ...f.transitions[0]!, trigger: '줄 서기' };
    const { html } = await render(fixture(f));
    expect(html).toContain(BRANCH_CLIENT_MARK);
    expect(html).toContain(BRANCH_CSS_MARK);
    expect(html).not.toContain('swatch-decision"></span>');
  });

  it('행위자 한 명짜리 흐름은 CSS만 싣고 클라이언트 조각은 안 싣는다', async () => {
    const f = queueFlow();
    f.actors = [f.actors[0]!];
    for (const s of f.steps) s.actor = 'guest';
    const { html } = await render(fixture(f));
    expect(html).toContain('.flane-actor {');
    expect(html).not.toContain(BRANCH_CLIENT_MARK);
  });

  it('공유본은 누른 것과 조건의 계정 ID를 가린다', async () => {
    const f = orderChangeFlow();
    f.transitions[0] = { ...f.transitions[0]!, trigger: '계정 123456789012 변경' };
    f.transitions[5] = { ...f.transitions[5]!, condition: '210987654321 아님' };
    const priv = await render(fixture(f), 'private');
    expect(priv.html).toContain('123456789012');
    expect(priv.html).toContain('210987654321');
    const { html } = await render(fixture(f), 'shared');
    expect(html).not.toContain('123456789012');
    expect(html).not.toContain('210987654321');
  });

  it('주문 변경 시안도 같은 입력이면 같은 바이트가 나온다', async () => {
    const a = await render(fixture(orderChangeFlow()));
    const b = await render(fixture(orderChangeFlow()));
    expect(a.html).toBe(b.html);
  });
});

describe('흐름 병합', () => {
  it('이전 실행과 합쳐도 흐름이 남는다', () => {
    const prev = fixture();
    const next = fixture();
    const merged = mergeWithPrevious(prev, next);
    expect(merged.flows?.map((f) => f.id)).toEqual(['queue']);
    expect(validateArchitectureIr(merged, { checkFiles: false }).ok).toBe(true);
  });

  it('분석 둘을 합치면 흐름을 나란히 두고 겹치는 id를 바꾼다', () => {
    const a = fixture();
    const b = fixture();
    b.repos = [
      {
        id: 'web2',
        name: 'acme-admin',
        root: '/srv/acme-admin',
        remote: 'git@github.com:acme/acme-admin.git',
      },
    ];
    b.nodes = b.nodes.map((n) => ({
      ...n,
      repo: 'web2',
      evidence: n.evidence.map((e) => ({ ...e, location: e.location.replace(/^web:/, 'web2:') })),
    }));
    b.edges = b.edges.map((e) => ({
      ...e,
      evidence: e.evidence.map((ev) => ({
        ...ev,
        location: ev.location.replace(/^web:/, 'web2:'),
      })),
    }));
    const result = mergeArchitectureIrs([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flows = result.ir.flows!;
    expect(flows).toHaveLength(2);
    expect(new Set(flows.map((f) => f.id)).size).toBe(2);
    const stepIds = flows.flatMap((f) => f.steps.map((s) => s.id));
    expect(new Set(stepIds).size).toBe(stepIds.length);
    expect(validateArchitectureIr(result.ir, { checkFiles: false }).ok).toBe(true);
  });

  const branchFields = (flow: ArchitectureFlow) => ({
    kinds: flow.steps.filter((s) => s.kind !== undefined).map((s) => s.kind),
    triggers: flow.transitions.map((t) => t.trigger ?? null),
    conditions: flow.transitions.map((t) => t.condition ?? null),
  });

  it('이전 실행과 합쳐도 갈림길과 누른 것, 조건이 남는다', () => {
    const merged = mergeWithPrevious(fixture(orderChangeFlow()), fixture(orderChangeFlow()));
    expect(branchFields(merged.flows![0]!)).toEqual(branchFields(orderChangeFlow()));
    expect(validateArchitectureIr(merged, { checkFiles: false }).ok).toBe(true);
  });

  it('분석 둘을 합쳐도 갈림길과 누른 것, 조건이 id만 바뀌고 남는다', () => {
    const a = fixture(orderChangeFlow());
    const b = fixture(orderChangeFlow());
    b.repos = [
      {
        id: 'web2',
        name: 'acme-admin',
        root: '/srv/acme-admin',
        remote: 'git@github.com:acme/acme-admin.git',
      },
    ];
    b.nodes = b.nodes.map((n) => ({
      ...n,
      repo: 'web2',
      evidence: n.evidence.map((e) => ({ ...e, location: e.location.replace(/^web:/, 'web2:') })),
    }));
    b.edges = b.edges.map((e) => ({
      ...e,
      evidence: e.evidence.map((ev) => ({
        ...ev,
        location: ev.location.replace(/^web:/, 'web2:'),
      })),
    }));
    const result = mergeArchitectureIrs([a, b]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const flows = result.ir.flows!;
    expect(flows).toHaveLength(2);
    for (const flow of flows) {
      expect(branchFields(flow)).toEqual(branchFields(orderChangeFlow()));
    }
    const v = validated(result.ir);
    expect(v.autoUnresolved.some((q) => q.id.startsWith('auto:branch'))).toBe(false);
  });
});
