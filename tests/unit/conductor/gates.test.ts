import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyNeed,
  handleNeed,
  openOrReuse,
  resolveGate,
} from '../../../src/conductor/gates.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import { NEED_KINDS, type OrderScope } from '../../../src/conductor/types.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

describe('classifyNeed', () => {
  it('사람에게 올리는 자리는 넷이고 나머지는 bypass다', () => {
    const gated = (scope: OrderScope) =>
      NEED_KINDS.filter(
        (n) => classifyNeed(order({ scope }), n, 'ship-draft').kind === 'gate',
      ).sort();
    expect(gated('approval')).toEqual([
      'merge-approval',
      'other',
      'review-manual-switch',
      'slack-post',
    ]);
    expect(gated('merge-through')).toEqual(['other', 'review-manual-switch', 'slack-post']);
    expect(gated('interview-first')).toEqual([
      'interview-answer',
      'merge-approval',
      'other',
      'review-manual-switch',
      'slack-post',
    ]);
  });

  it('simple-approval은 ship 체인 주문이 ship 단계 값을 실었을 때만 bypass다', () => {
    const ship = order({ skillChain: ['solve', 'ship'] });
    for (const step of ['ship-draft', 'ship-plan', 'ship-ready'] as const)
      expect(classifyNeed(ship, 'simple-approval', step)).toEqual({ kind: 'bypass' });
    expect(classifyNeed(ship, 'simple-approval')).toEqual({ kind: 'gate', type: 'no-procedure' });
    expect(classifyNeed(order({ skillChain: ['solve'] }), 'simple-approval', 'ship-draft')).toEqual(
      { kind: 'gate', type: 'no-procedure' },
    );
    expect(classifyNeed(undefined, 'simple-approval', 'ship-draft').kind).toBe('gate');
  });
});

describe('레포 스킬 체인의 승인', () => {
  it('ship이 없는 레포 스킬 체인의 simple-approval은 단계 값이 붙어도 사람에게 간다', () => {
    for (const scope of ['approval', 'merge-through'] as const) {
      const release = order({ skillChain: ['repo:release'], scope });
      expect(classifyNeed(release, 'simple-approval')).toEqual({
        kind: 'gate',
        type: 'no-procedure',
      });
      expect(classifyNeed(release, 'simple-approval', 'ship-ready')).toEqual({
        kind: 'gate',
        type: 'no-procedure',
      });
    }
    // ship이 같이 있어도 단계 값 없이 올린 릴리즈 승인은 사람에게 간다
    expect(
      classifyNeed(order({ skillChain: ['repo:release', 'ship'] }), 'simple-approval'),
    ).toEqual({ kind: 'gate', type: 'no-procedure' });
  });

  it('bypass 절차가 있어도 태그 푸시 승인을 게이트로 올리고 기록을 남기지 않는다', async () => {
    const s = ConductorStore.open(tempStateDir());
    s.addOrder(
      order({
        id: 'ord-1',
        scope: 'merge-through',
        status: 'running',
        workerId: 'wrk-1',
        skillChain: ['repo:release'],
      }),
    );
    s.startWorker(worker('ord-1', { id: 'wrk-1' }));
    let called = false;
    const out = await handleNeed(
      s,
      { orderId: 'ord-1', need: 'simple-approval', detail: 'v1.2.0 태그 푸시', step: 'ship-draft' },
      {
        'simple-approval': async () => {
          called = true;
          return '워커에 승인을 전했어요';
        },
      },
    );
    expect(out.kind === 'gate' && out.gate.type).toBe('no-procedure');
    expect(out.kind === 'gate' && out.gate.reason).toContain('v1.2.0 태그 푸시');
    expect(called).toBe(false);
    expect(s.snapshot.bypasses).toEqual([]);
  });
});

describe('handleNeed', () => {
  function storeWithRunning(scope: OrderScope = 'approval') {
    const s = ConductorStore.open(tempStateDir());
    s.addOrder(order({ id: 'ord-1', scope, status: 'running', workerId: 'wrk-1' }));
    s.startWorker(worker('ord-1', { id: 'wrk-1' }));
    return s;
  }

  it('정리는 bypass로 처리하고 사후 보고용 기록을 남긴다', async () => {
    const s = storeWithRunning();
    const out = await handleNeed(
      s,
      { orderId: 'ord-1', need: 'cleanup', detail: '워크트리 삭제' },
      { cleanup: async () => '워크트리를 지웠어요' },
    );
    expect(out.kind).toBe('bypass');
    expect(s.snapshot.bypasses).toEqual([
      expect.objectContaining({ orderId: 'ord-1', need: 'cleanup', action: '워크트리를 지웠어요' }),
    ]);
    expect(s.openGates()).toEqual([]);
  });

  it('ship 단계 승인을 넘기면 bypass 기록에 단계 값을 남긴다', async () => {
    const s = ConductorStore.open(tempStateDir());
    s.addOrder(
      order({ id: 'ord-1', status: 'running', workerId: 'wrk-1', skillChain: ['solve', 'ship'] }),
    );
    s.startWorker(worker('ord-1', { id: 'wrk-1' }));
    const out = await handleNeed(
      s,
      {
        orderId: 'ord-1',
        need: 'simple-approval',
        detail: 'ship ⓐ draft PR 올리기',
        step: 'ship-draft',
      },
      { 'simple-approval': async () => '워커에 승인을 전했어요' },
    );
    expect(out.kind).toBe('bypass');
    expect(s.snapshot.bypasses).toEqual([
      expect.objectContaining({ need: 'simple-approval', step: 'ship-draft' }),
    ]);
  });

  it('절차가 없거나 실패하면 no-procedure 게이트로 올린다', async () => {
    const s = storeWithRunning();
    const none = await handleNeed(
      s,
      { orderId: 'ord-1', need: 'auth', detail: 'gh 토큰 만료' },
      {},
    );
    expect(none.kind === 'gate' && none.gate.type).toBe('no-procedure');
    const s2 = storeWithRunning();
    const failed = await handleNeed(
      s2,
      { orderId: 'ord-1', need: 'auth', detail: 'gh 토큰 만료' },
      {
        auth: async () => {
          throw new Error('브라우저 로그인 필요');
        },
      },
    );
    expect(failed.kind === 'gate' && failed.gate.reason).toMatch(/브라우저 로그인 필요/);
    expect(s2.order('ord-1')?.status).toBe('waiting-gate');
  });

  it('같은 요청이 여러 번 와도 게이트는 하나만 연다', async () => {
    const s = storeWithRunning();
    const a = await handleNeed(
      s,
      { orderId: 'ord-1', need: 'merge-approval', detail: 'PR #1' },
      {},
    );
    const b = await handleNeed(
      s,
      { orderId: 'ord-1', need: 'merge-approval', detail: 'PR #1' },
      {},
    );
    expect(a.kind === 'gate' && b.kind === 'gate' && b.reused && a.gate.id === b.gate.id).toBe(
      true,
    );
    expect(s.openGates()).toHaveLength(1);
  });

  it('게이트를 닫으면 주문이 다시 움직인다', async () => {
    const s = storeWithRunning();
    const out = await handleNeed(
      s,
      { orderId: 'ord-1', need: 'merge-approval', detail: 'PR #1' },
      {},
    );
    if (out.kind !== 'gate') throw new Error('게이트가 열려야 한다');
    resolveGate(s, out.gate.id, 'approved');
    expect(s.order('ord-1')?.status).toBe('running');
  });

  it('열린 게이트를 다시 쓸 때 사유와 참조를 최신 값으로 바꾼다', () => {
    const s = ConductorStore.open(tempStateDir());
    s.addOrder(order({ id: 'ord-1', status: 'running' }));
    const first = openOrReuse(s, {
      orderId: 'ord-1',
      type: 'no-procedure',
      reason: '계정을 못 맞췄어요',
    });
    const again = openOrReuse(s, {
      orderId: 'ord-1',
      type: 'no-procedure',
      reason: '워커를 못 띄웠어요',
      refs: ['log.txt'],
    });
    expect(again).toMatchObject({ reused: true, gate: { id: first.gate.id } });
    expect(s.snapshot.gates[first.gate.id]).toMatchObject({
      reason: '워커를 못 띄웠어요',
      refs: ['log.txt'],
    });
    expect(ConductorStore.open(s.dir).snapshot.gates[first.gate.id]!.reason).toBe(
      '워커를 못 띄웠어요',
    );
  });

  it('이미 머지된 주문의 게이트는 승인하면 merged로, 거절하면 escalated로 둔다', () => {
    const s = ConductorStore.open(tempStateDir());
    for (const id of ['ord-ok', 'ord-no']) {
      s.addOrder(order({ id, status: 'merged', mergedAt: '2026-11-01T00:00:00.000Z' }));
      s.updateOrder(id, { status: 'escalated' });
    }
    const gate = (id: string) =>
      openOrReuse(s, { orderId: id, type: 'no-procedure', reason: '배포 실패' }).gate.id;
    expect(s.order('ord-ok')!.status).toBe('escalated');
    resolveGate(s, gate('ord-ok'), 'approved');
    resolveGate(s, gate('ord-no'), 'rejected');
    expect(s.order('ord-ok')!.status).toBe('merged');
    expect(s.order('ord-no')!.status).toBe('escalated');
  });
});
