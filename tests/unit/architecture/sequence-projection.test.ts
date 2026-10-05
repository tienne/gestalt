import { describe, expect, it } from 'vitest';
import {
  mergeWithPrevious,
  parseArchitectureIr,
  validateArchitectureIr,
  type ArchitectureIr,
} from '../../../src/architecture/index.js';
import { code } from '../../fixtures/architecture-categories/common.js';
import {
  orderDataflowIr,
  paymentCompareIr,
} from '../../fixtures/architecture-categories/projection-shapes.js';
import {
  checkoutSequenceIr,
  orderIntakeSequenceIr,
} from '../../fixtures/architecture-categories/sequence.js';
import { renderBoth, sha256 } from '../../fixtures/architecture-legacy/render.js';
import { SEQ_KEYS } from '../../../src/architecture/html-client.js';

function errorCodes(ir: ArchitectureIr): string[] {
  const r = validateArchitectureIr(ir, { checkFiles: false });
  return r.ok ? [] : r.errors.map((e) => e.code);
}

function checkout(): NonNullable<ArchitectureIr['projections']>[number] {
  return checkoutSequenceIr().projections![0]!;
}

describe('질문별 sequence 투영', () => {
  it('스키마를 통과하고 근거 없는 메시지만 질문으로 돌린다', () => {
    const ir = checkoutSequenceIr();
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(true);
    const r = validateArchitectureIr(ir, { checkFiles: false });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect([...(r.value.drawableMessageIds ?? [])].sort()).toEqual([
      'm1',
      'm2',
      'm3',
      'm4',
      'm5',
      'm6',
    ]);
    expect(r.value.autoUnresolved.map((q) => q.id)).toContain('auto:message:m7');
    expect(r.value.autoUnresolved.find((q) => q.id === 'auto:message:m7')?.subject).toEqual({
      messageId: 'm7',
    });
  });

  it('엣지 근거를 물려받은 메시지는 실선, 문서 근거만 있으면 점선이다', () => {
    const r = validateArchitectureIr(checkoutSequenceIr(), { checkFiles: false });
    if (!r.ok) throw new Error(JSON.stringify(r.errors));
    const style = new Map(
      r.value.ir.projections![0]!.messages.map((m) => [m.id, m.lineStyle] as const),
    );
    expect(style.get('m1')).toBe('solid');
    expect(style.get('m2')).toBe('dashed');
  });

  it.each<[string, (ir: ArchitectureIr) => void]>([
    ['PROJECTION_NODE_NOT_FOUND', (ir) => (ir.projections![0]!.messages[0]!.to = 'ghost')],
    ['PROJECTION_EDGE_NOT_FOUND', (ir) => (ir.projections![0]!.messages[0]!.edge = 'e-ghost')],
    ['PROJECTION_EDGE_MISMATCH', (ir) => (ir.projections![0]!.messages[0]!.edge = 'e-api-pg')],
    ['PROJECTION_BLOCK_NOT_FOUND', (ir) => (ir.projections![0]!.messages[0]!.block = 'b-ghost')],
    [
      'PROJECTION_BLOCK_SPLIT',
      (ir) => {
        const ms = ir.projections![0]!.messages;
        ms.push({ ...ms[5]!, id: 'm8' });
      },
    ],
    [
      'SOLID_MESSAGE_WITHOUT_EVIDENCE',
      (ir) => (ir.projections![0]!.messages[1]!.lineStyle = 'solid'),
    ],
    ['DUPLICATE_MESSAGE_ID', (ir) => (ir.projections![0]!.messages[1]!.id = 'm1')],
    ['DUPLICATE_PROJECTION_ID', (ir) => ir.projections!.push({ ...checkout() })],
  ])('%s를 거부한다', (expected, mutate) => {
    const ir = checkoutSequenceIr();
    mutate(ir);
    expect(errorCodes(ir)).toContain(expected);
  });

  it('투영 레벨과 메시지를 그리고 전체에는 구성 요소 카드를 세운다', async () => {
    const html = (await renderBoth(checkoutSequenceIr())).private;
    expect(html).toContain('data-level-id="view:checkout"');
    expect(html).toContain('href="#/level/view%3Acheckout"');
    expect(html).toContain('data-message-id="m1"');
    expect(html).toContain('data-message-id="m6"');
    expect(html).not.toContain('data-message-id="m7"');
    expect(html).toContain('id="views-btn"');
    expect(html).toContain('data-node-id="ledger"');
  });

  it('전체 지도 위 카드 줄에 그림마다 카드를 깔고 그린 메시지만 단계로 센다', async () => {
    const html = (await renderBoth(checkoutSequenceIr())).private;
    const root = html.slice(html.indexOf('data-level-id="root"'), html.indexOf('</section>'));
    expect(root).toContain('margin-top:136px');
    expect(root).toContain('질문별 그림 <span class="n">1</span>');
    expect(root).toContain('<a class="view-card" href="#/level/view%3Acheckout"');
    expect(root).toContain('<span class="vc-shape">순서도</span>');
    expect(root).toContain('단계 6, 참여 4');
  });

  it('레포가 여럿이면 머리 카드 둘째 줄에 레포를, MCP 도구는 서버 이름을 적는다', async () => {
    const ir = checkoutSequenceIr();
    ir.packs = ['generic', 'web-product'];
    ir.repos.push({ id: 'pay', name: 'acme-pay' });
    ir.nodes.find((n) => n.id === 'api')!.repo = 'pay';
    Object.assign(ir.nodes.find((n) => n.id === 'pg')!, { kind: 'endpoint', mcpServer: 'acme-pg' });
    const html = (await renderBoth(ir)).private;
    const view = html.slice(html.indexOf('data-level-id="view:checkout"'));
    expect(view).toContain('<span class="tc">acme-pay</span>');
    expect(view).toContain('<span class="tc">acme-app</span>');
    expect(view).toContain('<span class="tc">acme-pg MCP</span>');

    const single = (await renderBoth(checkoutSequenceIr())).private;
    expect(single).not.toContain('<span class="tc">acme-app</span>');
  });

  it('순서도 머리 카드 뒤에 위에 붙여 둘 띠를 깔고 그 스크립트를 싣는다', async () => {
    const html = (await renderBoth(checkoutSequenceIr())).private;
    const view = html.slice(html.indexOf('data-level-id="view:checkout"'));
    expect(view).toMatch(
      /<div class="seq-sticky" style="top:\d+px;width:[\d.]+px;height:\d+px"><\/div>/,
    );
    expect(html).toContain('function stickHeads()');

    const ir = checkoutSequenceIr();
    delete ir.projections;
    expect((await renderBoth(ir)).private).not.toContain('stickHeads');
  });

  it('투영이 없으면 카드 줄을 싣지 않는다', async () => {
    const ir = checkoutSequenceIr();
    delete ir.projections;
    const html = (await renderBoth(ir)).private;
    expect(html).not.toContain('view-strip');
    expect(html).not.toContain('margin-top:136px');
  });

  it('같은 입력이면 같은 HTML이 나온다', async () => {
    const a = await renderBoth(checkoutSequenceIr());
    const b = await renderBoth(checkoutSequenceIr());
    expect(a.private).toBe(b.private);
    expect(a.shared).toBe(b.shared);
  });

  it('shared 사본은 메시지 글자의 계정 ID를 가린다', async () => {
    const ir = checkoutSequenceIr();
    ir.projections![0]!.messages[2]!.label = '승인 요청 123456789012';
    const html = await renderBoth(ir);
    expect(html.private).toContain('123456789012');
    expect(html.shared).not.toContain('123456789012');
  });

  it('지난 실행과 합치면 투영이 바뀐 노드와 엣지 id를 따라간다', () => {
    const prev = checkoutSequenceIr();
    prev.nodes = prev.nodes.map((n) => (n.id === 'api' ? { ...n, id: 'order-api' } : n));
    prev.edges = prev.edges.map((e) =>
      e.id === 'e-app-api'
        ? { ...e, id: 'e-old', to: 'order-api' }
        : { ...e, from: e.from === 'api' ? 'order-api' : e.from },
    );
    const merged = mergeWithPrevious(prev, checkoutSequenceIr());
    const p = merged.projections![0]!;
    expect(p.participants).toContain('order-api');
    expect(p.messages[0]).toMatchObject({ from: 'app', to: 'order-api', edge: 'e-old' });
    expect(validateArchitectureIr(merged, { checkFiles: false }).ok).toBe(true);
  });

  it('투영 메시지 근거도 문서 묶음 레포를 code로 가리키지 못한다', () => {
    const ir = checkoutSequenceIr();
    ir.repos.push({ id: 'wiki', name: 'acme-wiki' });
    ir.projections![0]!.messages[1]!.evidence = [code('wiki:src/pay.ts:1')];
    expect(errorCodes(ir)).toContain('CODE_EVIDENCE_IN_DOC_REPO');
  });
});

/** m7은 근거가 없어 안 그려진다. 둘째 구간은 그래서 m4에서 m6까지만 카드에 나온다 */
function withPhases(): ArchitectureIr {
  const ir = checkoutSequenceIr();
  ir.projections![0]!.phases = [
    { id: 'p-ask', label: '승인 요청', from: 'm1', to: 'm3' },
    { id: 'p-result', label: '결과 받기', from: 'm4', to: 'm7' },
  ];
  return ir;
}

function phasesOf(
  ir: ArchitectureIr,
): NonNullable<NonNullable<ArchitectureIr['projections']>[number]['phases']> {
  return ir.projections![0]!.phases!;
}

/** 순서도 레벨 섹션 하나. 형제 섹션은 뺀다 */
function sequenceSection(html: string, levelId = 'view:checkout'): string {
  const start = html.lastIndexOf('<section', html.indexOf(`data-level-id="${levelId}"`));
  return html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
}

function altSection(html: string, mode: 'cards' | 'walk'): string {
  const start = html.indexOf(`<section class="level view-level seq-alt seq-${mode}"`);
  if (start < 0) return '';
  return html.slice(start, html.indexOf('</section>', start) + '</section>'.length);
}

function count(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('sequence 투영의 구간', () => {
  it('빈틈없이 순서대로 나눈 phases는 스키마와 검증을 통과한다', () => {
    const ir = withPhases();
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(true);
    const r = validateArchitectureIr(ir, { checkFiles: false });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.ir.projections![0]!.phases!.map((ph) => ph.id)).toEqual(['p-ask', 'p-result']);
  });

  it('구간이 하나여도 메시지 전부를 덮으면 통과한다', () => {
    const ir = checkoutSequenceIr();
    ir.projections![0]!.phases = [{ id: 'all', label: '전부', from: 'm1', to: 'm7' }];
    expect(errorCodes(ir)).toEqual([]);
  });

  it('빈 phases 배열은 스키마가 거부한다', () => {
    const ir = checkoutSequenceIr();
    ir.projections![0]!.phases = [];
    expect(parseArchitectureIr(JSON.parse(JSON.stringify(ir))).ok).toBe(false);
  });

  it.each<[string, (ir: ArchitectureIr) => void]>([
    ['PROJECTION_PHASE_OVERLAP', (ir) => (phasesOf(ir)[1]!.from = 'm3')],
    ['PROJECTION_PHASE_GAP', (ir) => (phasesOf(ir)[1]!.from = 'm5')],
    ['PROJECTION_PHASE_GAP', (ir) => (phasesOf(ir)[0]!.from = 'm2')],
    ['PROJECTION_PHASE_GAP', (ir) => (phasesOf(ir)[1]!.to = 'm6')],
    ['PROJECTION_PHASE_MESSAGE_NOT_FOUND', (ir) => (phasesOf(ir)[1]!.to = 'm-ghost')],
    ['PROJECTION_PHASE_MESSAGE_NOT_FOUND', (ir) => (phasesOf(ir)[0]!.from = 'm-ghost')],
    [
      'PROJECTION_PHASE_REVERSED',
      (ir) => Object.assign(phasesOf(ir)[0]!, { from: 'm3', to: 'm1' }),
    ],
    ['DUPLICATE_PHASE_ID', (ir) => (phasesOf(ir)[1]!.id = 'p-ask')],
  ])('%s를 거부한다', (expected, mutate) => {
    const ir = withPhases();
    mutate(ir);
    expect(errorCodes(ir)).toContain(expected);
  });

  it('오류에는 투영과 구간 id가 실린다', () => {
    const ir = withPhases();
    phasesOf(ir)[1]!.from = 'm3';
    const r = validateArchitectureIr(ir, { checkFiles: false });
    if (r.ok) throw new Error('통과하면 안 된다');
    expect(r.errors.find((e) => e.code === 'PROJECTION_PHASE_OVERLAP')).toMatchObject({
      projectionId: 'checkout',
      phaseId: 'p-result',
    });
  });

  it('없는 id를 가리킨 구간은 순서 검사에서 건너뛰고 다른 구간을 마지막 구간으로 몰지 않는다', () => {
    const ir = withPhases();
    phasesOf(ir)[1]!.to = 'm-ghost';
    const r = validateArchitectureIr(ir, { checkFiles: false });
    if (r.ok) throw new Error('통과하면 안 된다');
    expect(r.errors.map((e) => [e.code, e.phaseId])).toContainEqual([
      'PROJECTION_PHASE_MESSAGE_NOT_FOUND',
      'p-result',
    ]);
    expect(r.errors.map((e) => e.code)).not.toContain('PROJECTION_PHASE_OVERLAP');
    // p-ask는 마지막 구간이 아니다. 잘못 적은 건 p-result 하나라 p-ask에 오류를 다시 걸면 안 된다
    expect(r.errors.filter((e) => e.phaseId === 'p-ask')).toEqual([]);
  });

  it('dataflow와 compare 투영에 phases가 있으면 모양 오용으로 거부한다', () => {
    const flow = orderDataflowIr();
    const fp = flow.projections![0]!;
    fp.phases = [
      { id: 'all', label: '전부', from: fp.messages[0]!.id, to: fp.messages.at(-1)!.id },
    ];
    expect(errorCodes(flow)).toContain('PROJECTION_SHAPE_FIELD');

    const cmp = paymentCompareIr();
    cmp.projections![0]!.phases = [{ id: 'all', label: '전부', from: 'x', to: 'y' }];
    expect(errorCodes(cmp)).toContain('PROJECTION_SHAPE_FIELD');
  });
});

describe('순서도 보기 전환', () => {
  it('보기 단추 셋과 형제 섹션 둘을 싣고 첫 보기는 순서도다', async () => {
    const html = (await renderBoth(withPhases())).private;
    expect(html).toContain('id="seq-bar"');
    expect(html).toContain(
      '<button type="button" class="btn" data-seq-mode="seq" aria-pressed="true">순서도</button>',
    );
    expect(html).toContain(
      '<button type="button" class="btn" data-seq-mode="cards" aria-pressed="false">단계별 카드</button>',
    );
    expect(html).toContain(
      '<button type="button" class="btn" data-seq-mode="walk" aria-pressed="false">따라가기</button>',
    );
    const cards = altSection(html, 'cards');
    const walk = altSection(html, 'walk');
    expect(cards).toContain('data-seq-of="view:checkout" data-seq-mode="cards"');
    expect(walk).toContain('data-seq-of="view:checkout" data-seq-mode="walk"');
    // 형제 섹션은 레벨 목록에 안 잡히고 처음엔 숨어 있다
    for (const s of [cards, walk]) {
      expect(s).not.toContain('data-level-id');
      expect(s.slice(0, s.indexOf('>'))).toContain(' hidden');
    }
    expect(count(html, 'data-level-id="view:checkout"')).toBe(1);
    // 형제 섹션은 순서도 섹션 바로 뒤에 붙는다
    const seq = sequenceSection(html);
    expect(html.indexOf(cards)).toBe(html.indexOf(seq) + seq.length + 1);
  });

  it('단계 목록은 그린 메시지만 구간별로 싣는다', async () => {
    const html = (await renderBoth(withPhases())).private;
    const navStart = html.indexOf('<nav id="seq-steps"');
    const nav = html.slice(navStart, html.indexOf('</nav>', navStart));
    expect(nav).toContain('<ol class="ss-list" data-seq-of="view:checkout" hidden>');
    expect(count(nav, '<li class="ss-phase">')).toBe(2);
    expect(nav).toContain('<h4>승인 요청</h4>');
    expect(nav).toContain('<h4>결과 받기</h4>');
    expect(count(nav, '<button type="button" data-n=')).toBe(6);
    expect(nav).not.toContain('결과 화면 주소');
    expect(nav).toContain('data-n="4" data-phase="결과 받기"');
  });

  it('단계별 카드는 구간마다 한 장이고 카드 사이에 화살표를 둔다', async () => {
    const cards = altSection((await renderBoth(withPhases())).private, 'cards');
    expect(count(cards, '<div class="seq-phase"')).toBe(2);
    expect(cards).toContain('aria-label="1. 승인 요청"');
    expect(cards).toContain('aria-label="2. 결과 받기"');
    expect(cards).toContain('메시지 3개, 참여자 3명');
    expect(count(cards, '<span class="sp-arrow" aria-hidden="true"')).toBe(1);
    expect(cards).toContain('<g class="seq-block b-alt">');
    expect(cards).not.toContain('data-message-id="m7"');
  });

  it('phases가 없으면 자동 구간으로 카드를 만든다', async () => {
    const html = (await renderBoth(orderIntakeSequenceIr())).private;
    const cards = altSection(html, 'cards');
    expect(count(cards, '<div class="seq-phase"')).toBe(3);
    expect(cards).toContain('aria-label="1. gw"');
    expect(cards).toContain('aria-label="2. 주문 서버"');
    expect(cards).toContain('aria-label="3. auth"');
  });

  it('따라가기는 메시지마다 단계 선을 두고 메시지 edge가 가리킨 엣지만 회색 선으로 긋는다', async () => {
    const walk = altSection((await renderBoth(orderIntakeSequenceIr())).private, 'walk');
    expect(count(walk, '<path class="w-step"')).toBe(11);
    expect(count(walk, '<path class="w-edge"')).toBe(5);
    expect(walk).toContain('marker-end="url(#walk-tip-intake)"');
    expect(count(walk, 'class="w-band"')).toBe(2);
    for (const id of ['user', 'gw', 'auth', 'order', 'db', 'pay']) {
      expect(walk).toContain(`data-node-id="${id}"`);
    }
  });

  it('따라가기 카드와 단계 선이 같은 좌표계에 놓인다', async () => {
    const walk = altSection((await renderBoth(orderIntakeSequenceIr())).private, 'walk');
    const translate = /<g transform="translate\(([\d.]+) ([\d.]+)\)">/.exec(walk);
    expect(translate).not.toBeNull();
    const [dx, dy] = [Number(translate![1]), Number(translate![2])];
    const card = (id: string) => {
      const m = new RegExp(
        `data-node-id="${id}"[^>]*style="left:([\\d.]+)px;top:([\\d.]+)px;width:([\\d.]+)px;height:([\\d.]+)px"`,
      ).exec(walk);
      expect(m, id).not.toBeNull();
      return { x: Number(m![1]), y: Number(m![2]), w: Number(m![3]), h: Number(m![4]) };
    };
    const step = (messageId: string) => {
      const m = new RegExp(
        `data-message-id="${messageId}" d="M([\\d.]+) ([\\d.]+)C[^"]*?([\\d.]+) ([\\d.]+)"`,
      ).exec(walk);
      expect(m, messageId).not.toBeNull();
      return { x1: Number(m![1]), y1: Number(m![2]), x2: Number(m![3]), y2: Number(m![4]) };
    };
    // s1은 손님(user)에서 게이트웨이(gw)로 앞으로 가는 선이다. 손님 카드 오른쪽 변에서 나와 게이트웨이 왼쪽 변으로 든다
    const user = card('user');
    const gw = card('gw');
    const s1 = step('s1');
    expect(s1.x1 + dx).toBeCloseTo(user.x + user.w, 2);
    expect(s1.y1 + dy).toBeCloseTo(user.y + user.h / 2, 2);
    expect(s1.x2 + dx).toBeCloseTo(gw.x, 2);
    expect(s1.y2 + dy).toBeCloseTo(gw.y + gw.h / 2, 2);
  });
});

describe('순서도 보기 UI를 싣는 조건', () => {
  async function assertNoSeqUi(ir: ArchitectureIr): Promise<void> {
    const html = await renderBoth(ir);
    for (const h of [html.private, html.shared]) {
      expect(h).not.toContain('id="seq-bar"');
      expect(h).not.toContain('id="seq-steps"');
      expect(h).not.toContain('seq-alt');
      expect(h).not.toContain('@keyframes seq-run');
      expect(h).not.toContain('function applySeqMode');
    }
  }

  it('투영이 없으면 순서도 보기 UI와 CSS, 코드를 싣지 않는다', async () => {
    const ir = checkoutSequenceIr();
    delete ir.projections;
    await assertNoSeqUi(ir);
  });

  it('dataflow 투영만 있으면 순서도 보기 UI를 싣지 않는다', async () => {
    await assertNoSeqUi(orderDataflowIr());
  });

  it('sequence 투영이 있으면 CSS와 코드를 함께 싣는다', async () => {
    const html = (await renderBoth(checkoutSequenceIr())).private;
    expect(html).toContain('@keyframes seq-run');
    expect(html).toContain('function applySeqMode');
    expect(html).toContain('id="seq-bar"');
  });
});

describe('따라가기 화살표 키', () => {
  interface Fake {
    hidden?: boolean;
    contains: (n: unknown) => boolean;
  }
  type Handler = (...args: unknown[]) => string | undefined;
  // 브라우저에 싣는 바로 그 조각을 돌린다. 둘러싼 keydown 처리기에서 받는 이름은 인자로 넘긴다
  const handler = new Function(
    'e',
    't',
    'doc',
    'seqBase',
    'seqMode',
    'seqBar',
    'seqSteps',
    'seqAlt',
    'seqStop',
    'showStep',
    'seqN',
    `${SEQ_KEYS}    return 'pass';`,
  ) as Handler;

  const body = { name: 'body' };
  const stepButton = { name: 'step' };
  const walkCard = { name: 'walk-card' };
  const elsewhere = { name: 'search' };
  const box = (inside: unknown[], hidden = false): Fake => ({
    hidden,
    contains: (n) => inside.includes(n),
  });

  function press(
    key: string,
    opts: { target?: unknown; mode?: string; barHidden?: boolean } = {},
  ): { result: string | undefined; prevented: boolean; stopped: boolean; shown: number[] } {
    let prevented = false;
    let stopped = false;
    const shown: number[] = [];
    const walk = box([walkCard]);
    const result = handler(
      { key, preventDefault: () => (prevented = true) },
      opts.target ?? body,
      { body },
      { id: 'level' },
      opts.mode ?? 'walk',
      box([], opts.barHidden),
      box([stepButton]),
      (mode: string) => (mode === 'walk' ? walk : null),
      () => (stopped = true),
      (n: number) => shown.push(n),
      3,
    );
    return { result, prevented, stopped, shown };
  }

  it('따라가기에서 포커스가 없으면 →와 ←로 한 단계씩 옮긴다', () => {
    const right = press('ArrowRight');
    expect(right).toEqual({ result: undefined, prevented: true, stopped: true, shown: [4] });
    expect(press('ArrowLeft').shown).toEqual([2]);
  });

  it('단계 목록이나 따라가기 지도 안에 포커스가 있어도 옮긴다', () => {
    expect(press('ArrowRight', { target: stepButton }).shown).toEqual([4]);
    expect(press('ArrowRight', { target: walkCard }).shown).toEqual([4]);
  });

  it('따라가기가 아니면 기본 동작을 막지 않는다', () => {
    for (const mode of ['seq', 'cards']) {
      const r = press('ArrowRight', { mode });
      expect(r).toEqual({ result: 'pass', prevented: false, stopped: false, shown: [] });
    }
  });

  it('보기 바가 숨어 있으면 기본 동작을 막지 않는다', () => {
    const r = press('ArrowLeft', { barHidden: true });
    expect(r.result).toBe('pass');
    expect(r.prevented).toBe(false);
  });

  it('포커스가 다른 자리에 있으면 기본 동작을 막지 않는다', () => {
    const r = press('ArrowRight', { target: elsewhere });
    expect(r.result).toBe('pass');
    expect(r.prevented).toBe(false);
  });
});

describe('기존 순서도 섹션의 바이트 유지', () => {
  // phases와 보기 전환이 없던 렌더러로 checkoutSequenceIr()를 그린 순서도 섹션의 sha256이다. 다시 뽑을 때는 9b98179의 렌더러를 쓴다.
  // 형제 섹션은 뒤에 붙을 뿐 순서도 섹션 자체는 한 바이트도 안 바뀌어야 한다
  const BEFORE = '1695982449f22f5927cbe33dafead04c44177a49134e5f91b036bb7edf8a227c';

  it('phases 없는 순서도 섹션은 보기 전환 전과 바이트까지 같다', async () => {
    const html = await renderBoth(checkoutSequenceIr());
    expect(sha256(sequenceSection(html.private))).toBe(BEFORE);
    expect(sha256(sequenceSection(html.shared))).toBe(BEFORE);
  });

  it('phases를 적어도 순서도 섹션은 그대로다', async () => {
    const a = await renderBoth(checkoutSequenceIr());
    const b = await renderBoth(withPhases());
    expect(sequenceSection(b.private)).toBe(sequenceSection(a.private));
  });
});

describe('shared 사본의 구간 이름', () => {
  it('구간 이름의 계정 ID를 가린다', async () => {
    const ir = withPhases();
    phasesOf(ir)[0]!.label = '승인 요청 123456789012';
    const html = await renderBoth(ir);
    expect(html.private).toContain('승인 요청 123456789012');
    expect(html.shared).not.toContain('123456789012');
  });
});
