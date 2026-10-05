import { describe, expect, it } from 'vitest';
import type { ArchitectureIr, ProjectionMessage } from '../../../src/architecture/index.js';
import {
  autoSequencePhases,
  computePhaseBoard,
  computeWalkLayout,
  resolveSequencePhases,
  sequenceCallDepths,
  walkPath,
  type SequencePhase,
} from '../../../src/architecture/sequence-views.js';
import {
  checkoutSequenceIr,
  orderIntakeSequenceIr,
} from '../../fixtures/architecture-categories/sequence.js';

type Projection = NonNullable<ArchitectureIr['projections']>[number];

function intake(): { ir: ArchitectureIr; p: Projection } {
  const ir = orderIntakeSequenceIr();
  return { ir, p: ir.projections![0]! };
}

/** 렌더러 nodeName과 같은 규칙. displayName이 있으면 그걸, 없으면 label을 쓴다 */
function nameOfIr(ir: ArchitectureIr): (id: string) => string {
  return (id) => {
    const n = ir.nodes.find((x) => x.id === id);
    return n ? (n.displayName ?? n.label) : id;
  };
}

function allDrawn(p: Projection): Set<string> {
  return new Set(p.messages.map((m) => m.id));
}

/** 시험용 짧은 메시지 */
function msg(
  id: string,
  from: string,
  to: string,
  extra: Partial<ProjectionMessage> = {},
): ProjectionMessage {
  return { id, from, to, label: id, evidence: [], lineStyle: 'solid', ...extra };
}

describe('구간 자동 분할', () => {
  it('맨 위 참여자가 지금 구간에서 처음 부르는 대상마다 새 구간을 연다', () => {
    const { ir, p } = intake();
    const phases = autoSequencePhases(p.messages, 'user', nameOfIr(ir));
    expect(phases.map((ph) => ph.messageIds)).toEqual([
      ['s1', 's2', 's3', 's4', 's5', 's6'],
      ['s7', 's8', 's9', 's10'],
      ['s11'],
    ]);
  });

  it('구간 이름은 그 구간을 연 메시지가 부른 대상의 displayName, 없으면 label이다', () => {
    const { ir, p } = intake();
    const phases = autoSequencePhases(p.messages, 'user', nameOfIr(ir));
    expect(phases.map((ph) => ph.label)).toEqual(['gw', '주문 서버', 'auth']);
  });

  it('지금 구간에서 이미 만난 대상을 다시 부르면 지금 구간에 붙는다', () => {
    const phases = autoSequencePhases(
      [msg('a', 'r', 'x'), msg('b', 'x', 'y'), msg('c', 'r', 'y'), msg('d', 'r', 'x')],
      'r',
      (id) => id,
    );
    expect(phases.map((ph) => ph.messageIds)).toEqual([['a', 'b', 'c', 'd']]);
  });

  it('앞 구간에서 만났어도 지금 구간에서 처음 부르면 새 구간을 연다', () => {
    const phases = autoSequencePhases(
      [msg('a', 'r', 'x'), msg('b', 'r', 'y'), msg('c', 'r', 'x')],
      'r',
      (id) => id,
    );
    expect(phases.map((ph) => ph.messageIds)).toEqual([['a'], ['b'], ['c']]);
    expect(phases.map((ph) => ph.label)).toEqual(['x', 'y', 'x']);
  });

  it('자기 호출과 응답은 새 대상이어도 구간을 안 연다', () => {
    const phases = autoSequencePhases(
      [msg('a', 'r', 'x'), msg('b', 'r', 'r'), msg('c', 'r', 'y', { reply: true })],
      'r',
      (id) => id,
    );
    expect(phases).toEqual([{ label: 'x', messageIds: ['a', 'b', 'c'] }]);
  });

  it('맨 위가 아닌 참여자가 새 대상을 불러도 구간을 안 연다', () => {
    const phases = autoSequencePhases(
      [msg('a', 'r', 'x'), msg('b', 'x', 'y'), msg('c', 'y', 'z')],
      'r',
      (id) => id,
    );
    expect(phases.map((ph) => ph.messageIds)).toEqual([['a', 'b', 'c']]);
  });

  it('묶음 한가운데에서는 자르지 않고 묶음이 바뀌는 자리에서는 자른다', () => {
    const same = autoSequencePhases(
      [msg('a', 'r', 'x', { block: 'k' }), msg('b', 'r', 'y', { block: 'k' })],
      'r',
      (id) => id,
    );
    expect(same.map((ph) => ph.messageIds)).toEqual([['a', 'b']]);

    const other = autoSequencePhases(
      [msg('a', 'r', 'x', { block: 'k' }), msg('b', 'r', 'y', { block: 'j' })],
      'r',
      (id) => id,
    );
    expect(other.map((ph) => ph.messageIds)).toEqual([['a'], ['b']]);
  });

  it('첫 메시지는 자기 호출이어도 구간을 연다', () => {
    const phases = autoSequencePhases([msg('a', 'r', 'r'), msg('b', 'r', 'x')], 'r', (id) => id);
    expect(phases).toEqual([
      { label: 'r', messageIds: ['a'] },
      { label: 'x', messageIds: ['b'] },
    ]);
  });

  it('메시지가 없으면 구간도 없다', () => {
    expect(autoSequencePhases([], 'r', (id) => id)).toEqual([]);
  });
});

describe('구간 풀기', () => {
  it('IR에 phases가 없으면 자동으로 자르고 auto-N id를 붙인다', () => {
    const { ir, p } = intake();
    const phases = resolveSequencePhases(p, allDrawn(p), p.participants!, nameOfIr(ir));
    expect(phases.map((ph) => [ph.id, ph.auto, ph.label])).toEqual([
      ['auto-1', true, 'gw'],
      ['auto-2', true, '주문 서버'],
      ['auto-3', true, 'auth'],
    ]);
  });

  it('참여자는 순서도 머리 순서를 따른다', () => {
    const { ir, p } = intake();
    const order = ['pay', 'db', 'order', 'auth', 'gw', 'user'];
    const phases = resolveSequencePhases(p, allDrawn(p), order, nameOfIr(ir));
    // order[0]이 자동 분할의 기준이라 pay가 맨 위가 되고 pay는 아무도 안 부른다
    expect(phases).toHaveLength(1);
    expect(phases[0]!.participants).toEqual(order);
  });

  it('IR phases가 있으면 그걸 먼저 쓴다', () => {
    const { ir, p } = intake();
    p.phases = [
      { id: 'login', label: '로그인', from: 's1', to: 's4' },
      { id: 'order', label: '주문', from: 's5', to: 's11' },
    ];
    const phases = resolveSequencePhases(p, allDrawn(p), p.participants!, nameOfIr(ir));
    expect(phases).toEqual([
      {
        id: 'login',
        label: '로그인',
        auto: false,
        messageIds: ['s1', 's2', 's3', 's4'],
        participants: ['user', 'gw', 'auth'],
      },
      {
        id: 'order',
        label: '주문',
        auto: false,
        messageIds: ['s5', 's6', 's7', 's8', 's9', 's10', 's11'],
        participants: ['user', 'gw', 'auth', 'order', 'db', 'pay'],
      },
    ]);
  });

  it('그리지 않은 메시지는 빼고 다 빠져 빈 구간은 버린다', () => {
    const { ir, p } = intake();
    p.phases = [
      { id: 'login', label: '로그인', from: 's1', to: 's4' },
      { id: 'cart', label: '장바구니', from: 's5', to: 's5' },
      { id: 'order', label: '주문', from: 's6', to: 's11' },
    ];
    const drawn = allDrawn(p);
    drawn.delete('s5');
    drawn.delete('s2');
    const phases = resolveSequencePhases(p, drawn, p.participants!, nameOfIr(ir));
    expect(phases.map((ph) => ph.id)).toEqual(['login', 'order']);
    expect(phases[0]!.messageIds).toEqual(['s1', 's3', 's4']);
    expect(phases.flatMap((ph) => ph.messageIds)).not.toContain('s5');
  });

  it('IR phases가 그린 메시지를 다 덮지 못하면 자동 분할로 떨어진다', () => {
    const { ir, p } = intake();
    p.phases = [{ id: 'login', label: '로그인', from: 's1', to: 's4' }];
    const phases = resolveSequencePhases(p, allDrawn(p), p.participants!, nameOfIr(ir));
    expect(phases.every((ph) => ph.auto)).toBe(true);
    expect(phases.flatMap((ph) => ph.messageIds)).toHaveLength(11);
  });

  it('자동 분할도 그린 메시지만으로 자른다', () => {
    const { ir, p } = intake();
    // s7~s10이 빠지면 s11의 auth는 첫 구간에서 이미 만난 대상이라 첫 구간에 붙는다
    const drawn = allDrawn(p);
    for (const id of ['s7', 's8', 's9', 's10']) drawn.delete(id);
    const phases = resolveSequencePhases(p, drawn, p.participants!, nameOfIr(ir));
    expect(phases.map((ph) => ph.messageIds)).toEqual([
      ['s1', 's2', 's3', 's4', 's5', 's6', 's11'],
    ]);

    // s1~s6이 빠지면 주문 서버 구간에서 시작하고 s11이 새 구간을 연다
    const later = allDrawn(p);
    for (const id of ['s1', 's2', 's3', 's4', 's5', 's6']) later.delete(id);
    const rest = resolveSequencePhases(p, later, p.participants!, nameOfIr(ir));
    expect(rest.map((ph) => [ph.id, ph.messageIds])).toEqual([
      ['auto-1', ['s7', 's8', 's9', 's10']],
      ['auto-2', ['s11']],
    ]);
  });
});

describe('호출 깊이', () => {
  it('맨 위 참여자에서 가장 짧은 홉 수를 잰다', () => {
    const { p } = intake();
    const depths = sequenceCallDepths(p.messages, 'user');
    expect(Object.fromEntries(depths)).toEqual({
      user: 0,
      gw: 1,
      // gw를 거치면 2지만 s11에서 user가 바로 부른다
      auth: 1,
      order: 1,
      pay: 1,
      db: 2,
    });
  });

  it('응답과 자기 호출은 길로 안 치고 못 닿는 참여자는 0이다', () => {
    const depths = sequenceCallDepths(
      [
        msg('a', 'r', 'x'),
        msg('b', 'x', 'y', { reply: true }),
        msg('c', 'x', 'x'),
        msg('d', 'q', 'w'),
        msg('e', 'w', 'v'),
      ],
      'r',
    );
    expect(Object.fromEntries(depths)).toEqual({ r: 0, x: 1, y: 0, q: 0, w: 0, v: 0 });
  });

  it('맨 위가 없거나 메시지에 안 나오면 모두 0이다', () => {
    const ms = [msg('a', 'r', 'x'), msg('b', 'x', 'y')];
    expect([...sequenceCallDepths(ms, undefined).values()]).toEqual([0, 0, 0]);
    expect([...sequenceCallDepths(ms, 'ghost').values()]).toEqual([0, 0, 0]);
  });
});

describe('따라가기 지도 좌표', () => {
  function walkOf(
    sizeOf: (id: string) => { width: number; height: number } = () => ({ width: 160, height: 40 }),
  ): {
    phases: SequencePhase[];
    walk: ReturnType<typeof computeWalkLayout>;
    p: Projection;
  } {
    const { ir, p } = intake();
    const phases = resolveSequencePhases(p, allDrawn(p), p.participants!, nameOfIr(ir));
    const depths = sequenceCallDepths(p.messages, 'user');
    const walk = computeWalkLayout(
      phases,
      p.messages,
      depths,
      sizeOf,
      new Map(ir.edges.map((e) => [e.id, e])),
      (id) => p.messages.findIndex((m) => m.id === id) + 1,
    );
    return { phases, walk, p };
  }

  const box = (walk: ReturnType<typeof computeWalkLayout>, id: string) =>
    walk.nodes.find((n) => n.id === id)!;

  it('열 x는 호출 깊이 순으로 커지고 같은 깊이는 같은 열에 선다', () => {
    const { walk } = walkOf();
    const user = box(walk, 'user');
    const gw = box(walk, 'gw');
    const db = box(walk, 'db');
    expect(user.x).toBeLessThan(gw.x);
    expect(gw.x).toBeLessThan(db.x);
    for (const id of ['auth', 'order', 'pay']) expect(box(walk, id).x).toBe(gw.x);
    expect(gw.x).toBeGreaterThanOrEqual(user.x + user.width);
  });

  it('열 폭은 그 열에서 가장 넓은 카드를 따른다', () => {
    const narrow = walkOf().walk;
    const wide = walkOf((id) => ({ width: id === 'pay' ? 300 : 160, height: 40 })).walk;
    expect(box(wide, 'db').x - box(wide, 'gw').x).toBe(
      box(narrow, 'db').x - box(narrow, 'gw').x + 140,
    );
    expect(box(wide, 'gw').x).toBe(box(narrow, 'gw').x);
  });

  it('띠는 참여자가 처음 나온 구간이고 새 참여자가 없는 구간은 띠가 없다', () => {
    const { walk } = walkOf();
    expect(walk.bands.map((b) => [b.phaseId, b.label])).toEqual([
      ['auto-1', 'gw'],
      ['auto-2', '주문 서버'],
    ]);
    // auth는 s11 구간에서도 나오지만 처음 나온 첫 구간 띠에 있다
    const first = ['user', 'gw', 'auth'].map((id) => box(walk, id));
    const second = ['order', 'db', 'pay'].map((id) => box(walk, id));
    const firstBottom = Math.max(...first.map((b) => b.y + b.height));
    for (const b of second) expect(b.y).toBeGreaterThan(firstBottom);
    expect(walk.bands[1]!.y).toBeGreaterThan(firstBottom);
    expect(walk.bands[1]!.y).toBeLessThan(Math.min(...second.map((b) => b.y)));
    expect(walk.nodes).toHaveLength(6);
  });

  it('회색 선은 메시지 edge가 가리킨 엣지만 한 번씩 긋는다', () => {
    const { walk } = walkOf();
    expect(walk.edges.map((e) => e.id)).toEqual([
      'e-user-gw',
      'e-gw-auth',
      'e-user-order',
      'e-order-db',
      'e-user-pay',
    ]);
    expect(walk.edges.map((e) => e.id)).not.toContain('e-gw-order');
  });

  it('양끝이 지도에 없는 엣지는 긋지 않는다', () => {
    const { ir, p } = intake();
    const phases = resolveSequencePhases(p, allDrawn(p), p.participants!, nameOfIr(ir));
    const walk = computeWalkLayout(
      phases,
      p.messages,
      sequenceCallDepths(p.messages, 'user'),
      () => ({ width: 160, height: 40 }),
      new Map([['e-user-gw', { from: 'user', to: 'ghost' }]]),
      () => 0,
    );
    expect(walk.edges).toEqual([]);
  });

  it('단계는 메시지마다 1부터 세고 구간과 자기 호출 고리를 함께 싣는다', () => {
    const { walk, p } = walkOf();
    expect(walk.steps).toHaveLength(p.messages.length);
    expect(walk.steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(walk.steps.map((s) => s.phaseId)).toEqual([
      ...Array<string>(6).fill('auto-1'),
      ...Array<string>(4).fill('auto-2'),
      'auto-3',
    ]);
    const self = walk.steps.find((s) => s.messageId === 's5')!;
    expect(self.self).toBe(true);
    const user = box(walk, 'user');
    expect(self.d).toBe(walkPath(user, user));
    expect(self.d.startsWith(`M${user.x + user.width - 30} ${user.y}C`)).toBe(true);
    expect(walk.steps.filter((s) => s.self).map((s) => s.messageId)).toEqual(['s5']);
  });

  it('단계 번호는 넘겨받은 순서도 번호를 그대로 쓴다', () => {
    const { ir, p } = intake();
    const phases = resolveSequencePhases(p, allDrawn(p), p.participants!, nameOfIr(ir));
    const walk = computeWalkLayout(
      phases,
      p.messages,
      sequenceCallDepths(p.messages, 'user'),
      () => ({ width: 160, height: 40 }),
      new Map(ir.edges.map((e) => [e.id, e])),
      (id) => (p.messages.findIndex((m) => m.id === id) + 1) * 10,
    );
    expect(walk.steps.map((s) => s.n)).toEqual(p.messages.map((_, i) => (i + 1) * 10));
  });

  it('지도 폭과 높이가 모든 카드와 자기 호출 고리를 품는다', () => {
    const { walk } = walkOf();
    for (const b of walk.nodes) {
      expect(b.x + b.width).toBeLessThan(walk.width);
      expect(b.y + b.height).toBeLessThanOrEqual(walk.height);
    }
  });

  it('같은 입력이면 같은 좌표가 나온다', () => {
    expect(walkOf().walk).toEqual(walkOf().walk);
  });
});

describe('따라가기 선 모양', () => {
  const a = { id: 'a', x: 0, y: 0, width: 100, height: 40 };
  const b = { id: 'b', x: 200, y: 100, width: 100, height: 40 };
  const c = { id: 'c', x: 0, y: 100, width: 100, height: 40 };

  it('앞으로 가는 선은 마주 보는 변을 잇는다', () => {
    expect(walkPath(a, b)).toBe('M100 20C150 20 150 120 200 120');
  });

  it('뒤로 가는 선은 왼쪽 변에서 나와 오른쪽 변으로 든다', () => {
    expect(walkPath(b, a)).toBe('M200 120C150 120 150 20 100 20');
  });

  it('같은 열은 오른쪽으로 불룩하게 휜다', () => {
    expect(walkPath(a, c)).toBe('M100 20C140 20 140 120 100 120');
  });
});

describe('단계별 카드 보드', () => {
  function boardOf(rowMax?: number) {
    const { ir, p } = intake();
    const phases = resolveSequencePhases(p, allDrawn(p), p.participants!, nameOfIr(ir));
    const numberOf = (id: string): number => Number(id.slice(1));
    return { phases, board: computePhaseBoard(phases, p, numberOf, rowMax) };
  }

  it('넓으면 카드를 한 줄에 놓고 카드 사이마다 화살표를 둔다', () => {
    const { board } = boardOf(4000);
    expect(board.cards.map((c) => c.index)).toEqual([1, 2, 3]);
    expect(board.cards.every((c) => c.y === 0)).toBe(true);
    expect(board.arrows).toHaveLength(2);
    for (let i = 1; i < board.cards.length; i++) {
      const prev = board.cards[i - 1]!;
      const cur = board.cards[i]!;
      expect(cur.x).toBeGreaterThan(prev.x + prev.width);
      const arrow = board.arrows[i - 1]!;
      expect(arrow.x).toBeGreaterThan(prev.x + prev.width);
      expect(arrow.x).toBeLessThan(cur.x);
    }
    const last = board.cards[2]!;
    expect(board.width).toBe(last.x + last.width);
  });

  it('줄 폭을 넘으면 다음 줄로 내리고 넘긴 카드 앞에도 화살표를 둔다', () => {
    const { board } = boardOf(1);
    expect(board.arrows).toHaveLength(2);
    const ys = board.cards.map((c) => c.y);
    expect(ys[0]).toBe(0);
    expect(ys[1]).toBeGreaterThan(board.cards[0]!.height);
    expect(ys[2]).toBeGreaterThan(ys[1]! + board.cards[1]!.height);
    // 다음 줄 카드는 줄 머리 화살표만큼 들여 놓는다
    for (const c of board.cards.slice(1)) expect(c.x).toBeGreaterThan(0);
    for (let i = 1; i < 3; i++) {
      const card = board.cards[i]!;
      expect(board.arrows[i - 1]!.x).toBeLessThan(card.x);
      expect(board.arrows[i - 1]!.y).toBeGreaterThan(card.y);
      expect(board.arrows[i - 1]!.y).toBeLessThan(card.y + card.height);
    }
    // 가장 넓은 카드가 줄 폭이 된다
    expect(board.width).toBeGreaterThanOrEqual(Math.max(...board.cards.map((c) => c.width)));
  });

  it('줄 폭이 기본 1280이면 둘이 첫 줄, 셋째가 다음 줄이다', () => {
    const { board } = boardOf();
    expect(board.cards.map((c) => c.y > 0)).toEqual([false, false, true]);
    expect(board.width).toBeLessThanOrEqual(1280);
  });

  it('카드 안 순서도는 그 구간 참여자만 열로 세운다', () => {
    const { board, phases } = boardOf();
    board.cards.forEach((card, i) => {
      expect(card.svg.heads.map((h) => h.id)).toEqual(phases[i]!.participants);
      expect(card.svg.messages.map((m) => m.id)).toEqual(phases[i]!.messageIds);
    });
    expect(board.cards[2]!.svg.heads.map((h) => h.id)).toEqual(['user', 'auth']);
  });

  it('묶음 상자는 그 묶음 메시지 줄을 덮고 묶음 밖 메시지는 덮지 않는다', () => {
    const { board } = boardOf();
    const card = board.cards[1]!;
    expect(card.svg.blocks).toHaveLength(1);
    const block = card.svg.blocks[0]!;
    expect(block).toMatchObject({ id: 'b-retry', kind: 'loop', label: '재시도' });
    const yOf = new Map(card.svg.messages.map((m) => [m.id, m.y]));
    for (const id of ['s7', 's8', 's9']) {
      expect(yOf.get(id)!).toBeGreaterThan(block.y);
      expect(yOf.get(id)!).toBeLessThan(block.y + block.height);
    }
    expect(yOf.get('s10')!).toBeGreaterThan(block.y + block.height);
    expect(block.x + block.width).toBeLessThanOrEqual(card.svg.width);
    expect(card.svg.y + card.svg.height).toBeLessThanOrEqual(card.height);
  });

  it('구간 경계가 묶음을 자르면 카드마다 묶음 조각을 따로 그린다', () => {
    const { ir, p } = intake();
    p.phases = [
      { id: 'a', label: '앞', from: 's1', to: 's8' },
      { id: 'b', label: '뒤', from: 's9', to: 's11' },
    ];
    const phases = resolveSequencePhases(p, allDrawn(p), p.participants!, nameOfIr(ir));
    const board = computePhaseBoard(phases, p, (id) => Number(id.slice(1)));
    const [first, second] = board.cards;
    expect(first!.svg.blocks.map((b) => b.id)).toEqual(['b-retry']);
    expect(second!.svg.blocks.map((b) => b.id)).toEqual(['b-retry']);
    const s9 = second!.svg.messages.find((m) => m.id === 's9')!;
    const s10 = second!.svg.messages.find((m) => m.id === 's10')!;
    const blk = second!.svg.blocks[0]!;
    expect(s9.y).toBeGreaterThan(blk.y);
    expect(s9.y).toBeLessThan(blk.y + blk.height);
    expect(s10.y).toBeGreaterThan(blk.y + blk.height);
  });

  it('alt 묶음은 경우가 바뀌는 자리에 나눔 줄을 긋는다', () => {
    const ir = checkoutSequenceIr();
    const p = ir.projections![0]!;
    const drawn = new Set(p.messages.map((m) => m.id).filter((id) => id !== 'm7'));
    const phases = resolveSequencePhases(p, drawn, p.participants!, nameOfIr(ir));
    expect(phases).toHaveLength(1);
    const card = computePhaseBoard(phases, p, (id) => Number(id.slice(1))).cards[0]!;
    const block = card.svg.blocks[0]!;
    expect(block.kind).toBe('alt');
    expect(block.branches.map((b) => b.label)).toEqual(['거절']);
    const yOf = new Map(card.svg.messages.map((m) => [m.id, m.y]));
    expect(block.branches[0]!.y).toBeGreaterThan(yOf.get('m5')!);
    expect(block.branches[0]!.y).toBeLessThan(yOf.get('m6')!);
  });

  it('자기 호출은 x1과 x2가 같고 번호는 numberOf를 따른다', () => {
    const { board } = boardOf();
    const s5 = board.cards[0]!.svg.messages.find((m) => m.id === 's5')!;
    expect(s5.self).toBe(true);
    expect(s5.x1).toBe(s5.x2);
    expect(s5.n).toBe(5);
  });

  it('같은 입력이면 같은 좌표가 나온다', () => {
    expect(boardOf().board).toEqual(boardOf().board);
  });
});
