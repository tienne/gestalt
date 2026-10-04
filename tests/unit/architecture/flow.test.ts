import { describe, expect, it } from 'vitest';
import {
  computeDrilldown,
  computeFlowLayout,
  mergeArchitectureIrs,
  mergeWithPrevious,
  parseArchitectureIr,
  renderDrilldownHtml,
  validateArchitectureIr,
  type ArchitectureFlow,
  type ArchitectureIr,
  type ArchitectureNode,
  type Evidence,
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
});

describe('흐름 구간', () => {
  const layoutOf = (ir: ArchitectureIr) => {
    const v = validated(ir);
    return computeFlowLayout(v.ir.flows![0]!, v.drawableStepIds, v.drawableTransitionIds);
  };

  it('정상 흐름은 상태 값마다 구간을 나누고 옆 흐름은 맨 끝 구간에 모은다', () => {
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

  it('옆 흐름 단계는 전부 옆 흐름 구간 안에 선다', () => {
    const layout = layoutOf(fixture());
    const side = layout.stages.find((s) => s.side)!;
    for (const step of layout.steps.filter((s) => s.path === 'side')) {
      expect(step.x).toBeGreaterThanOrEqual(side.x);
    }
    for (const step of layout.steps.filter((s) => s.path === 'main')) {
      expect(step.x + step.width).toBeLessThanOrEqual(side.x);
    }
  });

  it('정상 흐름에 상태 값이 없으면 구간을 안 만든다', () => {
    const flow = queueFlow();
    for (const step of flow.steps) delete step.state;
    const layout = layoutOf(fixture(flow));
    expect(layout.stages).toEqual([]);
  });
});

describe('흐름 레벨 렌더', () => {
  async function render(ir: ArchitectureIr, audience: 'private' | 'shared' = 'private') {
    const v = validated(ir);
    const drill = await computeDrilldown(v);
    return { drill, html: renderDrilldownHtml(v, drill, { audience }) };
  }

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
});
