import { afterEach, describe, expect, it } from 'vitest';
import { classifyNeed, handleNeed, resolveGate } from '../../../src/master/gates.js';
import { MasterStore } from '../../../src/master/store.js';
import { NEED_KINDS, type OrderScope } from '../../../src/master/types.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

describe('classifyNeed', () => {
  it('사람에게 올리는 자리는 넷이고 나머지는 bypass다', () => {
    const gated = (scope: OrderScope) =>
      NEED_KINDS.filter((n) => classifyNeed(order({ scope }), n).kind === 'gate').sort();
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
});

describe('handleNeed', () => {
  function storeWithRunning(scope: OrderScope = 'approval') {
    const s = MasterStore.open(tempStateDir());
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
});
