import { afterEach, describe, expect, it } from 'vitest';
import type { TickReport } from '../../../src/conductor/engine.js';
import {
  attentionReasons,
  claimWaitOwner,
  readSeen,
  waitForAttention,
  writeSeen,
  type WaitTickOutcome,
} from '../../../src/conductor/wait.js';
import { cleanupStateDirs, tempStateDir } from './fixtures.js';

afterEach(() => cleanupStateDirs());

function report(over: Partial<TickReport> = {}): TickReport {
  return {
    at: '2026-11-15T00:00:00Z',
    created: [],
    launched: [],
    escalated: [],
    hostActions: [],
    slackPosted: [],
    jira: [],
    errors: [],
    warnings: [],
    rateLimited: [],
    humanOwned: [],
    idleTicks: 0,
    counts: {
      queued: 0,
      running: 0,
      waitingGate: 0,
      activeWorkers: 0,
      openGates: 0,
      unansweredThreads: 0,
    },
    ...over,
  };
}

const idle = (): WaitTickOutcome => ({ report: report(), handoffClose: [] });

function fakeClock() {
  let t = 0;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    sleeps,
  };
}

describe('attentionReasons', () => {
  it('할 일 없는 tick은 이유가 없다', () => {
    expect(attentionReasons(idle())).toEqual([]);
  });

  it('게이트, 호스트 할 일, 사람 담당 변화, 인계, 탭 닫기 결과를 이유로 본다', () => {
    const o: WaitTickOutcome = {
      report: report({
        escalated: ['gate-1'],
        hostActions: [{ kind: 'deliver' } as never],
        humanOwned: [{ orderId: 'ord-1', to: 'merged' } as never],
      }),
      handoff: { sessionId: 's', compactions: 1, thresholdPercent: 70, due: true },
      handoffClose: [{ sessionId: 'old', state: 'closed', detail: '닫음' }],
    };
    expect(attentionReasons(o)).toEqual([
      'hostActions',
      'escalated',
      'humanOwned',
      'handoff',
      'handoffClose',
    ]);
  });

  it('건너뛴 tick의 잠금 오류와 한도 대기는 이유로 안 친다', () => {
    const skipped = {
      report: report({ skipped: true, errors: ['다른 tick이 돌고 있어'] }),
      handoffClose: [],
    };
    expect(attentionReasons(skipped)).toEqual([]);
    const limited = {
      report: report({ rateLimited: [{ orderId: 'o', workerId: 'w', since: 'x' }] }),
      handoffClose: [],
    };
    expect(attentionReasons(limited)).toEqual([]);
  });

  it('접수하다 연 게이트처럼 escalated에 안 실린 게이트는 열린 수가 늘었는지로 본다', () => {
    const o = (n: number) => ({
      report: report({ counts: { ...report().counts, openGates: n } }),
      handoffClose: [],
    });
    expect(attentionReasons(o(2), new Set(), 1)).toEqual(['gatesOpened']);
    expect(attentionReasons(o(1), new Set(), 1)).toEqual([]);
    expect(attentionReasons(o(2))).toEqual([]);
  });

  it('이미 보여 준 오류와 경고는 다시 이유가 되지 않는다', () => {
    const o = {
      report: report({ errors: ['같은 오류'], warnings: ['같은 경고'] }),
      handoffClose: [],
    };
    expect(attentionReasons(o, new Set(['같은 오류', '같은 경고']))).toEqual([]);
    expect(attentionReasons(o, new Set(['같은 오류']))).toEqual(['warnings']);
  });
});

describe('waitForAttention', () => {
  it('할 일 없는 tick은 넘기고 게이트가 열린 tick에서 끝난다', async () => {
    const clock = fakeClock();
    const gate = { report: report({ escalated: ['gate-9'] }), handoffClose: [] };
    const ticks = [idle(), idle(), gate];
    const r = await waitForAttention(
      { runTick: async () => ticks.shift()!, ...clock, stillOwner: () => true },
      { maxWaitMs: 3_600_000, intervalMs: 60_000 },
    );
    expect(r.reason).toBe('attention');
    expect(r.reasons).toEqual(['escalated']);
    expect(r.ticks).toBe(3);
    expect(r.last?.report.escalated).toEqual(['gate-9']);
    expect(clock.sleeps).toEqual([60_000, 60_000]);
  });

  it('상한 시간이 지나면 할 일이 없어도 끝나고 마지막 잠은 남은 시간만큼만 잔다', async () => {
    const clock = fakeClock();
    const r = await waitForAttention(
      { runTick: async () => idle(), ...clock, stillOwner: () => true },
      { maxWaitMs: 150_000, intervalMs: 60_000 },
    );
    expect(r.reason).toBe('timeout');
    expect(r.ticks).toBe(4);
    expect(r.elapsedMs).toBe(150_000);
    expect(clock.sleeps).toEqual([60_000, 60_000, 30_000]);
  });

  it('다른 wait가 이어받으면 tick을 더 돌리지 않고 끝난다', async () => {
    const clock = fakeClock();
    let owner = true;
    let ran = 0;
    const r = await waitForAttention(
      {
        runTick: async () => {
          ran++;
          owner = false;
          return idle();
        },
        ...clock,
        stillOwner: () => owner,
      },
      { maxWaitMs: 3_600_000, intervalMs: 60_000 },
    );
    expect(r.reason).toBe('superseded');
    expect(ran).toBe(1);
  });
});

describe('wait 소유 표식과 본 목록', () => {
  it('나중에 뜬 wait가 표식을 가져가고 앞선 wait는 풀 때 남의 표식을 안 지운다', () => {
    const dir = tempStateDir();
    const first = claimWaitOwner(dir);
    expect(first.stillOwner()).toBe(true);
    const second = claimWaitOwner(dir);
    expect(first.stillOwner()).toBe(false);
    first.release();
    expect(second.stillOwner()).toBe(true);
    second.release();
    expect(second.stillOwner()).toBe(false);
  });

  it('보여 준 오류를 쌓아 두고 다음 wait가 읽는다', () => {
    const dir = tempStateDir();
    expect(readSeen(dir).size).toBe(0);
    writeSeen(dir, new Set(), ['오류 A']);
    writeSeen(dir, readSeen(dir), ['오류 A', '경고 B']);
    expect([...readSeen(dir)]).toEqual(['오류 A', '경고 B']);
  });
});
