import { afterEach, describe, expect, it } from 'vitest';
import {
  decisionMessage,
  inboxDirOf,
  tick,
  writeReport,
  type EngineDeps,
} from '../../../src/conductor/engine.js';
import { openOrReuse } from '../../../src/conductor/gates.js';
import type { JiraClient } from '../../../src/conductor/jira.js';
import type { HostAction, Launcher } from '../../../src/conductor/launcher.js';
import {
  cancelOrder,
  confirmHumanMerge,
  takeOver,
  type PrState,
  type PrStateSource,
} from '../../../src/conductor/ownership.js';
import { pollPrs, type PrWatchSource, type WatchedPr } from '../../../src/conductor/pr-watch.js';
import { detectStale } from '../../../src/conductor/resume.js';
import type { ConductorConfig } from '../../../src/conductor/scheduler.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import type { Gate, Worker, WorkerKind } from '../../../src/conductor/types.js';
import { cleanupStateDirs, clockedStore, order, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const config: ConductorConfig = {
  maxConcurrentWorkers: 2,
  pollIntervalSec: 60,
  maxResumeAttempts: 3,
  staleAfterSec: 900,
  rateLimitEscalateAfterSec: 21600,
  defaultScope: 'approval',
  resultMaxChars: 2000,
  accounts: {},
  repoPaths: {},
  defaultAgent: 'claude',
  repoAgents: {},
  humanOwnedPollSec: 900,
  humanOwnedParkAfterSec: 86400,
};

function fakeLauncher(kind: WorkerKind) {
  const sent: { workerId: string; message: string }[] = [];
  const released: string[] = [];
  const launcher: Launcher = {
    kind,
    start: async (spec) => ({ handle: `h-${spec.worker.id}` }),
    send: async (w: Worker, message: string): Promise<HostAction | undefined> => {
      sent.push({ workerId: w.id, message });
      return undefined;
    },
    release: async (w) => {
      released.push(w.id);
    },
  };
  return { launcher, sent, released };
}

function fakePrState(initial: PrState) {
  const calls: string[] = [];
  let current = initial;
  const source: PrStateSource = {
    state: async (ref) => {
      calls.push(ref);
      return current;
    },
  };
  return {
    source,
    calls,
    set(next: PrState) {
      current = next;
    },
  };
}

function fakeJira() {
  const moves: { key: string; to: string }[] = [];
  const client: JiraClient = {
    transition: async (key, to) => {
      moves.push({ key, to });
    },
  };
  return { client, moves };
}

function engineDeps(over: Partial<EngineDeps> = {}): EngineDeps {
  return {
    config,
    launchers: { 'git-worktree': fakeLauncher('git-worktree').launcher },
    orcaAvailable: false,
    env: {},
    ...over,
  };
}

function gate(over: Partial<Gate>): Gate {
  return {
    id: 'gate-1',
    type: 'merge',
    status: 'resolved',
    reason: '머지 승인',
    refs: [],
    openedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  };
}

/** 머지 확인 자리에 멈춘 주문과 살아 있는 워커를 만든다 */
function waitingMerge(kind: WorkerKind = 'orca-worktree') {
  const c = clockedStore();
  c.store.addOrder(
    order({ id: 'ord-1', scope: 'approval', status: 'running', prRef: 'acme/app#7' }),
  );
  const w = worker('ord-1', { id: 'wrk-1', kind });
  c.store.startWorker(w);
  c.store.updateOrder('ord-1', { workerId: 'wrk-1' });
  const { gate: g } = openOrReuse(c.store, {
    orderId: 'ord-1',
    type: 'merge',
    reason: '머지 승인 대기',
  });
  return { ...c, gateId: g.id };
}

describe('확인 자리 답 전달', () => {
  it('승인에 답이 있으면 답을 싣고 고정 문구보다 먼저 따르게 한다', () => {
    const text = decisionMessage(gate({ decision: 'approved', answer: '스쿼시로 머지' }));
    expect(text).toContain('사람의 답: "스쿼시로 머지"');
    expect(text).toContain('답을 먼저 따르세요');
    expect(text.indexOf('사람의 답')).toBeLessThan(text.indexOf('기본 지시'));
  });

  it('승인만 오면 머지하고 보고하라고만 한다', () => {
    const text = decisionMessage(gate({ decision: 'approved' }));
    expect(text).toBe('머지 승인됐어요. 기본 지시: 머지하고 결과를 보고하세요');
  });

  it('거절에 답이 있으면 답대로 처리하고 done으로 끝내게 한다', () => {
    const text = decisionMessage(gate({ decision: 'rejected', answer: '머지는 내가 할게' }));
    expect(text).toContain('사람의 답: "머지는 내가 할게"');
    expect(text).toContain('답대로 처리한 뒤 --status done');
    expect(text).toContain('머지하지 말고');
  });

  it('거절만 오면 기다리지 말고 done으로 끝내게 한다', () => {
    const text = decisionMessage(gate({ decision: 'rejected' }));
    expect(text).toContain('--status done');
    expect(text).toContain('기다리지 마세요');
    expect(text).not.toContain('사람의 답');
  });
});

describe('사람이 넘겨받기', () => {
  it('살아 있는 워커에 종료를 전하고 오르카 터미널을 거둔 뒤 human-owned로 둔다', async () => {
    const { store, gateId } = waitingMerge();
    const orca = fakeLauncher('orca-worktree');
    const r = await takeOver(
      store,
      'ord-1',
      { 'orca-worktree': orca.launcher },
      {
        gateId,
        answer: '머지는 내가 할게',
      },
    );

    expect(orca.sent).toHaveLength(1);
    expect(orca.sent[0]!.message).toContain('넘겨받았어요');
    expect(orca.released).toEqual(['wrk-1']);
    expect(store.worker('wrk-1')!.status).toBe('released');
    expect(store.order('ord-1')!.status).toBe('human-owned');
    expect(store.order('ord-1')!.humanOwnedAt).toBeDefined();
    expect(r.closedGates.map((g) => g.id)).toEqual([gateId]);
    expect(store.snapshot.gates[gateId]).toMatchObject({
      status: 'resolved',
      decision: 'taken-over',
      answer: '머지는 내가 할게',
    });
    expect(r.warnings).toEqual([]);
  });

  it('git 워크트리 워커는 release를 부르지 않아 워크트리를 남긴다', async () => {
    const { store } = waitingMerge('git-worktree');
    const git = fakeLauncher('git-worktree');
    await takeOver(store, 'ord-1', { 'git-worktree': git.launcher });
    expect(git.sent).toHaveLength(1);
    expect(git.released).toEqual([]);
    expect(store.worker('wrk-1')!.status).toBe('released');
  });

  it('워커가 없는 주문도 넘겨받고 PR이 없으면 경고한다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'queued' }));
    const r = await takeOver(store, 'ord-1', {});
    expect(store.order('ord-1')!.status).toBe('human-owned');
    expect(r.warnings).toHaveLength(1);
  });

  it('끝난 주문은 넘겨받지 못한다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'done' }));
    await expect(takeOver(store, 'ord-1', {})).rejects.toThrow('넘겨받을 수 없어요');
  });

  it('넘겨받은 주문의 워커는 끊김 판정과 늦게 온 보고에서 빠진다', async () => {
    const { store, advance, now } = waitingMerge();
    store.updateOrder('ord-1', { status: 'human-owned', humanOwnedAt: store.timestamp() });
    advance(DAY);
    const stale = await detectStale(store, { now: now(), staleAfterMs: 15 * MIN });
    expect(stale.stopped).toEqual([]);

    const d = engineDeps();
    writeReport(
      inboxDirOf(store, d),
      { workerId: 'wrk-1', status: 'done', merged: true, summary: '머지했어요', refs: [] },
      config.resultMaxChars,
    );
    await tick(store, d, { force: true });
    expect(store.order('ord-1')!.status).not.toBe('done');
    expect(store.order('ord-1')!.mergedAt).toBeUndefined();
  });

  it('human-owned 주문에 게이트가 새로 열려도 waiting-gate로 바꾸지 않는다', () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'human-owned' }));
    openOrReuse(store, { orderId: 'ord-1', type: 'no-procedure', reason: '정리 실패' });
    expect(store.order('ord-1')!.status).toBe('human-owned');
  });
});

describe('human-owned 주문의 PR 지켜보기', () => {
  function humanOwned(extra: Parameters<typeof order>[0] = {}) {
    const c = clockedStore();
    c.store.addOrder(
      order({
        id: 'ord-1',
        status: 'human-owned',
        prRef: 'acme/app#7',
        humanOwnedAt: '2026-11-01T00:00:00.000Z',
        ...extra,
      }),
    );
    return c;
  }

  it('MERGED면 merged로 넘기고 지라를 옮긴 뒤 정산으로 끝낸다', async () => {
    const { store } = humanOwned({ issueKey: 'APP-1', issueType: 'sub-task' });
    const pr = fakePrState({ state: 'MERGED', mergedAt: '2026-11-01T00:05:00Z' });
    const jira = fakeJira();
    const r = await tick(store, engineDeps({ prState: pr.source, jira: jira.client }), {
      force: true,
    });
    expect(r.humanOwned).toEqual([{ orderId: 'ord-1', to: 'merged', prRef: 'acme/app#7' }]);
    expect(store.order('ord-1')!.mergedAt).toBe('2026-11-01T00:05:00Z');
    expect(jira.moves).toEqual([{ key: 'APP-1', to: 'Done' }]);
    expect(store.order('ord-1')!.status).toBe('done');
  });

  it('머지 없이 CLOSED면 cancelled로 넘긴다', async () => {
    const { store } = humanOwned();
    const pr = fakePrState({ state: 'CLOSED' });
    const r = await tick(store, engineDeps({ prState: pr.source }), { force: true });
    expect(r.humanOwned).toEqual([{ orderId: 'ord-1', to: 'cancelled', prRef: 'acme/app#7' }]);
    expect(store.order('ord-1')!.status).toBe('cancelled');
  });

  it('OPEN이면 바꾸지 않고 간격 안에서는 gh를 다시 부르지 않는다', async () => {
    const { store, advance } = humanOwned();
    const pr = fakePrState({ state: 'OPEN' });
    const d = engineDeps({ prState: pr.source });

    const first = await tick(store, d, { force: true });
    expect(first.humanOwned).toEqual([]);
    expect(pr.calls).toHaveLength(1);

    advance(5 * MIN);
    await tick(store, d, { force: true });
    expect(pr.calls).toHaveLength(1);

    advance(10 * MIN);
    await tick(store, d, { force: true });
    expect(pr.calls).toHaveLength(2);
    expect(store.order('ord-1')!.status).toBe('human-owned');
  });

  it('넘겨받은 지 하루가 지나도 그대로면 parked로 내리고 더 안 본다', async () => {
    const { store, advance } = humanOwned();
    const pr = fakePrState({ state: 'OPEN' });
    const d = engineDeps({ prState: pr.source });
    advance(DAY);
    const r = await tick(store, d, { force: true });
    expect(r.humanOwned).toEqual([{ orderId: 'ord-1', to: 'parked', prRef: 'acme/app#7' }]);
    expect(store.order('ord-1')!.status).toBe('parked');

    const calls = pr.calls.length;
    advance(DAY);
    const again = await tick(store, d, { force: true });
    expect(again.humanOwned).toEqual([]);
    expect(pr.calls).toHaveLength(calls);
  });

  it('gh가 실패하면 오류만 남기고 상태는 그대로 둔다', async () => {
    const { store } = humanOwned();
    const source: PrStateSource = {
      state: async () => {
        throw new Error('gh 인증 만료');
      },
    };
    const r = await tick(store, engineDeps({ prState: source }), { force: true });
    expect(r.errors.some((e) => e.includes('gh 인증 만료'))).toBe(true);
    expect(store.order('ord-1')!.status).toBe('human-owned');
  });

  it('넘겨받은 주문은 슬롯을 차지하지 않는다', async () => {
    const { store } = humanOwned();
    store.addOrder(order({ id: 'ord-2' }));
    store.addOrder(order({ id: 'ord-3' }));
    const pr = fakePrState({ state: 'OPEN' });
    const r = await tick(store, engineDeps({ prState: pr.source }), { force: true });
    expect(r.launched.map((l) => l.orderId).sort()).toEqual(['ord-2', 'ord-3']);
  });
});

describe('order mark-merged', () => {
  it('parked 주문은 gh가 MERGED일 때만 merged로 넘긴다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'parked', prRef: 'acme/app#7' }));
    const pr = fakePrState({ state: 'MERGED', mergedAt: '2026-11-02T00:00:00Z' });
    const done = await confirmHumanMerge(store, 'ord-1', pr.source);
    expect(done.status).toBe('merged');
    expect(done.mergedAt).toBe('2026-11-02T00:00:00Z');
  });

  it('OPEN이면 거절하고 상태를 그대로 둔다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'parked', prRef: 'acme/app#7' }));
    const pr = fakePrState({ state: 'OPEN' });
    await expect(confirmHumanMerge(store, 'ord-1', pr.source)).rejects.toThrow('OPEN');
    expect(store.order('ord-1')!.status).toBe('parked');
  });

  it('human-owned나 parked가 아니면 받지 않는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'running', prRef: 'acme/app#7' }));
    const pr = fakePrState({ state: 'MERGED' });
    await expect(confirmHumanMerge(store, 'ord-1', pr.source)).rejects.toThrow('parked');
    expect(pr.calls).toEqual([]);
  });
});

describe('order cancel', () => {
  it('살아 있는 워커에 멈추라고 전하고 거둔 뒤 열린 게이트도 닫는다', async () => {
    const { store, gateId } = waitingMerge();
    const orca = fakeLauncher('orca-worktree');
    const r = await cancelOrder(
      store,
      'ord-1',
      { 'orca-worktree': orca.launcher },
      '요구사항 바뀜',
    );
    expect(orca.sent[0]!.message).toContain('취소');
    expect(orca.released).toEqual(['wrk-1']);
    expect(store.worker('wrk-1')!.status).toBe('released');
    expect(store.order('ord-1')).toMatchObject({
      status: 'cancelled',
      cancelReason: '요구사항 바뀜',
    });
    expect(r.closedGates.map((g) => g.id)).toEqual([gateId]);
    expect(store.openGates('ord-1')).toEqual([]);
  });

  it('워커가 없는 주문은 상태만 바꾼다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'queued' }));
    const r = await cancelOrder(store, 'ord-1', {});
    expect(store.order('ord-1')!.status).toBe('cancelled');
    expect(r.hostActions).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  it('거두기가 실패하면 finished로 두고 다음 정리에 넘긴다', async () => {
    const { store } = waitingMerge();
    const orca = fakeLauncher('orca-worktree');
    orca.launcher.release = async () => {
      throw new Error('터미널이 없어요');
    };
    const r = await cancelOrder(store, 'ord-1', { 'orca-worktree': orca.launcher });
    expect(store.worker('wrk-1')!.status).toBe('finished');
    expect(r.errors[0]).toContain('터미널이 없어요');
    expect(store.order('ord-1')!.status).toBe('cancelled');
  });

  it('머지된 주문은 취소하지 않는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'merged' }));
    await expect(cancelOrder(store, 'ord-1', {})).rejects.toThrow('취소할 수 없어요');
  });
});

describe('PR 감시 제외', () => {
  function pr(ref: string): WatchedPr {
    return {
      ref,
      repo: 'acme/app',
      title: '작업',
      headSha: 'abc',
      latestOtherCommentId: 'c-1',
    };
  }

  it('human-owned와 parked 주문의 PR로는 답글 주문을 만들지 않는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-h', status: 'human-owned', prRef: 'acme/app#1' }));
    store.addOrder(order({ id: 'ord-p', status: 'parked', prRef: 'acme/app#2' }));
    store.addOrder(order({ id: 'ord-d', status: 'done', prRef: 'acme/app#3' }));
    const source: PrWatchSource = {
      authored: async () => [pr('acme/app#1'), pr('acme/app#2'), pr('acme/app#3')],
      reviewing: async () => [],
    };
    const r = await pollPrs(store, source, { defaultScope: 'approval' });
    expect(r.created.map((o) => o.prRef)).toEqual(['acme/app#3']);
  });
});

describe('재생', () => {
  it('넘겨받기, 취소, 머지 확인을 거친 저장소를 다시 열어도 상태가 같다', async () => {
    const { store, dir, advance } = waitingMerge();
    const orca = fakeLauncher('orca-worktree');
    await takeOver(store, 'ord-1', { 'orca-worktree': orca.launcher });
    store.addOrder(order({ id: 'ord-2', status: 'running' }));
    await cancelOrder(store, 'ord-2', {}, '중복');
    advance(DAY);
    await tick(store, engineDeps({ prState: fakePrState({ state: 'OPEN' }).source }), {
      force: true,
    });
    expect(store.order('ord-1')!.status).toBe('parked');
    await confirmHumanMerge(store, 'ord-1', fakePrState({ state: 'MERGED' }).source);

    const reopened = ConductorStore.open(dir);
    expect(reopened.snapshot.orders).toEqual(store.snapshot.orders);
    expect(reopened.snapshot.workers).toEqual(store.snapshot.workers);
    expect(reopened.snapshot.gates).toEqual(store.snapshot.gates);
  });
});
