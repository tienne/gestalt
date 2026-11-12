import { afterEach, describe, expect, it } from 'vitest';
import {
  deliverGateDecision,
  inboxDirOf,
  tick,
  writeReport,
  type EngineDeps,
} from '../../../src/conductor/engine.js';
import { resolveGate } from '../../../src/conductor/gates.js';
import { intakeOrder, type JiraTicket, type QueueMessage } from '../../../src/conductor/intake.js';
import type { DeploySignal } from '../../../src/conductor/jira.js';
import type { AccountSwitcher, Launcher, LaunchSpec } from '../../../src/conductor/launcher.js';
import type { WatchedPr } from '../../../src/conductor/pr-watch.js';
import { saveSkillCheckpoint, type ShipReader } from '../../../src/conductor/resume.js';
import type { ConductorConfig } from '../../../src/conductor/scheduler.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import type { Worker, WorkerKind } from '../../../src/conductor/types.js';
import type { ShipCheckpoint } from '../../../src/ship/checkpoint.js';
import { cleanupStateDirs, clockedStore, order } from './fixtures.js';

/**
 * 스펙의 수용 장면을 가짜 어댑터로 끝까지 돌린다.
 * 지라, 슬랙, 원격 PR, 오르카는 전부 테스트 더블이고 실환경 호출은 없다.
 */

afterEach(cleanupStateDirs);

const base: ConductorConfig = {
  maxConcurrentWorkers: 10,
  pollIntervalSec: 60,
  maxResumeAttempts: 3,
  staleAfterSec: 900,
  defaultScope: 'approval',
  resultMaxChars: 2000,
  accounts: {},
  repoPaths: {},
};

interface Fake {
  launcher: Launcher;
  started: LaunchSpec[];
  sent: { workerId: string; message: string }[];
  released: string[];
}

function fake(kind: WorkerKind): Fake {
  const f: Fake = { started: [], sent: [], released: [], launcher: undefined as never };
  f.launcher = {
    kind,
    start: async (spec) => {
      f.started.push(spec);
      return { handle: spec.previousHandle ?? `${kind}:${spec.worker.id}` };
    },
    send: async (w: Worker, message: string) => {
      f.sent.push({ workerId: w.id, message });
      return undefined;
    },
    release: async (w) => {
      f.released.push(w.id);
    },
  };
  return f;
}

function harness(over: Partial<EngineDeps> = {}, config: Partial<ConductorConfig> = {}) {
  const c = clockedStore();
  const orca = fake('orca-worktree');
  const git = fake('git-worktree');
  const sub = fake('subagent');
  const jiraMoves: string[] = [];
  const deps: EngineDeps = {
    config: { ...base, ...config },
    launchers: {
      'orca-worktree': orca.launcher,
      'git-worktree': git.launcher,
      subagent: sub.launcher,
    },
    orcaAvailable: true,
    env: {},
    jira: { transition: async (key, to) => void jiraMoves.push(`${key}:${to}`) },
    ...over,
  };
  const run = () => tick(c.store, deps, { force: true });
  const report = (workerId: string, raw: Record<string, unknown>) =>
    writeReport(
      inboxDirOf(c.store, deps),
      { workerId, summary: '요약', refs: [], ...raw },
      base.resultMaxChars,
    );
  const workerOf = (orderId: string) => c.store.order(orderId)!.workerId!;
  return { ...c, deps, orca, git, sub, jiraMoves, run, report, workerOf };
}

describe('장면 1: 레포 둘, 범위 셋, 세 경로로 받은 주문', () => {
  it('말과 지라와 외부 큐로 받은 주문을 계정 맞춰 띄우고 범위대로 사람 확인을 가른다', async () => {
    const switched: string[] = [];
    const accounts: AccountSwitcher = {
      current: async () => 'personal',
      switchTo: async (repo, account) => void switched.push(`${repo}:${account}`),
    };
    const tickets: JiraTicket[] = [
      {
        key: 'BILL-1',
        summary: '결제 버그',
        issueType: 'Bug',
        repo: 'acme/billing',
        scope: 'approval',
      },
    ];
    const queued: QueueMessage[] = [
      { id: 'q1', body: { repo: 'acme/app', title: '로그 정리', scope: 'interview-first' } },
    ];
    const acked: string[] = [];
    let deploy: DeploySignal = { status: 'pending' };
    const h = harness(
      {
        jiraSource: { fetchAssigned: async () => tickets },
        queue: { receive: async () => queued.splice(0), ack: async (id) => void acked.push(id) },
        accounts,
        deploy: { status: async () => deploy },
      },
      { accounts: { 'acme/billing': 'work' } },
    );
    const spoken = intakeOrder(
      h.store,
      { source: 'spoken', repo: 'acme/app', title: '배너 문구', scope: 'merge-through' },
      { defaultScope: 'approval' },
    ).order;

    const first = await h.run();
    expect(first.created).toHaveLength(2);
    expect(first.launched).toHaveLength(3);
    expect(new Set(first.launched.map((l) => l.kind))).toEqual(new Set(['orca-worktree']));
    expect(acked).toEqual(['q1']);
    expect(switched).toEqual(['acme/billing:work']);

    const bill = h.store.orders().find((o) => o.issueKey === 'BILL-1')!;
    const logs = h.store.orders().find((o) => o.title === '로그 정리')!;
    expect([spoken.scope, bill.scope, logs.scope]).toEqual([
      'merge-through',
      'approval',
      'interview-first',
    ]);

    h.report(h.workerOf(spoken.id), {
      status: 'needs',
      need: { kind: 'merge-approval', detail: '머지할까요' },
    });
    h.report(h.workerOf(bill.id), {
      status: 'needs',
      need: { kind: 'merge-approval', detail: '머지할까요' },
    });
    h.report(h.workerOf(logs.id), {
      status: 'needs',
      need: { kind: 'interview-answer', detail: '로그 보존 기간은요?' },
    });
    await h.run();

    expect(h.orca.sent.map((s) => s.workerId)).toEqual([h.workerOf(spoken.id)]);
    expect(
      h.store
        .openGates()
        .map((g) => g.type)
        .sort(),
    ).toEqual(['interview', 'merge']);

    const interview = h.store.openGates(logs.id)[0]!;
    await deliverGateDecision(
      h.store,
      resolveGate(h.store, interview.id, 'approved', '30일'),
      h.deps,
    );
    expect(h.orca.sent.at(-1)).toEqual({
      workerId: h.workerOf(logs.id),
      message: '인터뷰 답: 30일',
    });

    const merge = h.store.openGates(bill.id)[0]!;
    await deliverGateDecision(h.store, resolveGate(h.store, merge.id, 'approved'), h.deps);
    h.report(h.workerOf(bill.id), {
      status: 'progress',
      skill: 'ship',
      summary: 'draft PR 생성',
      prRef: 'acme/billing#7',
    });
    h.report(h.workerOf(bill.id), { status: 'done', merged: true });
    await h.run();
    expect(h.store.order(bill.id)!.status).toBe('merged');

    deploy = { status: 'success' };
    await h.run();
    expect(h.store.order(bill.id)!.status).toBe('done');
    expect(h.jiraMoves).toEqual(['BILL-1:TODO', 'BILL-1:In Progress', 'BILL-1:PR', 'BILL-1:In-QA']);
  });
});

describe('장면 2: 끊긴 워커를 체크포인트부터 다시 띄우기', () => {
  const shipAt =
    (phase: ShipCheckpoint['phase'], round: number): ShipReader =>
    () => ({
      status: 'match',
      checkpoint: { phase, round } as ShipCheckpoint,
      observed: {} as never,
      mismatches: [],
    });

  it('ship 체크포인트의 단계와 라운드로 이어 가고 상한을 넘으면 원인과 체크포인트를 붙여 올린다', async () => {
    const readShip = shipAt('3', 2);
    const h = harness({ readShip, orcaAvailable: false });
    h.store.addOrder(order({ id: 'ord-ship', skillChain: ['solve', 'ship'] }));
    await h.run();
    const first = h.workerOf('ord-ship');

    saveSkillCheckpoint(
      h.store,
      { workerId: first, skill: 'solve', next: '스펙 확정', completedSkills: ['solve'] },
      readShip,
    );
    saveSkillCheckpoint(
      h.store,
      { workerId: first, skill: 'ship', next: '라운드 2 반영', shipDir: '.ship' },
      readShip,
    );
    h.report(first, { status: 'stopped', stopReason: 'rate-limit' });
    const resumed = await h.run();

    expect(resumed.launched).toEqual([
      expect.objectContaining({ orderId: 'ord-ship', resumed: true, kind: 'git-worktree' }),
    ]);
    const spec = h.git.started.at(-1)!;
    expect(spec.previousHandle).toBe(`git-worktree:${first}`);
    expect(spec.prompt).toContain('끝낸 스킬: solve');
    expect(spec.prompt).toContain('남은 체인: ship');
    expect(spec.prompt).toContain('돌던 스킬: ship (단계 3)');
    expect(spec.prompt).toContain('라운드: 2');

    for (let i = 0; i < 3; i++) {
      h.report(h.workerOf('ord-ship'), { status: 'stopped', stopReason: 'account-changed' });
      await h.run();
    }
    expect(h.git.started).toHaveLength(4);
    expect(h.store.order('ord-ship')!.status).toBe('escalated');
    const gate = h.store.openGates('ord-ship')[0]!;
    expect(gate.reason).toContain('재개 불가');
    expect(gate.reason).toContain('account-changed');
    expect(gate.refs.join(' ')).toContain('ship');
  });
});

describe('장면 3: 오르카가 없는 환경', () => {
  it('워크트리가 필요한 주문은 git 워크트리로, 읽기 전용은 서브에이전트로 띄운다', async () => {
    const h = harness({ orcaAvailable: false });
    h.store.addOrder(order({ id: 'ord-orca', workerKind: 'orca-worktree' }));
    h.store.addOrder(order({ id: 'ord-default' }));
    h.store.addOrder(order({ id: 'ord-read', skillChain: ['review'] }));
    const r = await h.run();
    expect(Object.fromEntries(r.launched.map((l) => [l.orderId, l.kind]))).toEqual({
      'ord-orca': 'git-worktree',
      'ord-default': 'git-worktree',
      'ord-read': 'subagent',
    });
    expect(h.orca.started).toEqual([]);
  });
});

describe('장면 4: PR 두 방향', () => {
  it('내 PR 코멘트는 답글 주문, 리뷰한 PR은 재리뷰 주문, 답만 오면 사람 확인 뒤 재리뷰한다', async () => {
    const authored: WatchedPr[] = [
      {
        ref: 'acme/app#1',
        repo: 'acme/app',
        title: '배너',
        headSha: 'a',
        latestOtherCommentId: 'c1',
        unansweredThreads: 2,
      },
    ];
    const reviewing: WatchedPr[] = [
      {
        ref: 'acme/app#2',
        repo: 'acme/app',
        title: '검색',
        headSha: 'new',
        reviewedHeadSha: 'old',
      },
      {
        ref: 'acme/app#3',
        repo: 'acme/app',
        title: '목록',
        headSha: 'b',
        reviewedHeadSha: 'b',
        repliesSinceReview: 1,
      },
    ];
    const h = harness({
      prSource: { authored: async () => authored, reviewing: async () => reviewing },
    });

    const first = await h.run();
    const chains = first.created.map((id) => [
      h.store.order(id)!.prRef,
      h.store.order(id)!.skillChain.join(),
    ]);
    expect(chains).toEqual([
      ['acme/app#1', 'review-reply'],
      ['acme/app#2', 'review-loop'],
    ]);
    expect(first.counts.unansweredThreads).toBe(2);
    const gate = h.store.openGates().find((g) => g.type === 'review-manual-switch')!;
    expect(gate.refs).toEqual(['acme/app#3']);

    resolveGate(h.store, gate.id, 'approved');
    const next = await h.run();
    expect(next.created.map((id) => h.store.order(id)!.prRef)).toEqual(['acme/app#3']);
    expect(next.launched.map((l) => l.orderId)).toEqual(next.created);
  });
});

describe('워커 10개 동시', () => {
  it('상한 10을 넘는 주문은 큐에 남고 자리가 나는 만큼 띄운다', async () => {
    const h = harness();
    for (let i = 0; i < 12; i++)
      h.store.addOrder(
        order({
          id: `ord-${String(i).padStart(2, '0')}`,
          repo: i % 2 ? 'acme/app' : 'acme/billing',
        }),
      );
    const first = await h.run();
    expect(first.launched).toHaveLength(10);
    expect(first.counts).toMatchObject({ queued: 2, activeWorkers: 10 });

    for (const id of ['ord-00', 'ord-01', 'ord-02']) h.report(h.workerOf(id), { status: 'done' });
    const second = await h.run();
    expect(second.launched).toHaveLength(2);
    expect(second.counts).toMatchObject({ queued: 0, activeWorkers: 9 });
    expect(h.orca.released).toHaveLength(3);
  });

  it('10개가 도는 중에도 섞어 받은 주문이 범위대로 끝 자리까지 가고 넘친 주문은 자리가 나면 뜬다', async () => {
    let deploy: DeploySignal = { status: 'pending' };
    const queued: QueueMessage[] = [
      { id: 'q1', body: { repo: 'acme/app', title: '로그 정리', scope: 'interview-first' } },
    ];
    const h = harness({
      jiraSource: {
        fetchAssigned: async () => [
          { key: 'BILL-1', summary: '결제 버그', issueType: 'Bug', repo: 'acme/billing' },
        ],
      },
      queue: { receive: async () => queued.splice(0), ack: async () => {} },
      deploy: { status: async () => deploy },
    });
    for (let i = 0; i < 7; i++) h.store.addOrder(order({ id: `ord-bg-${i}` }));
    const spoken = intakeOrder(
      h.store,
      { source: 'spoken', repo: 'acme/app', title: '배너 문구', scope: 'merge-through' },
      { defaultScope: 'approval' },
    ).order;
    h.store.addOrder(order({ id: 'ord-late', createdAt: '2099-01-01T00:00:00.000Z' }));

    const first = await h.run();
    expect(first.counts).toMatchObject({ activeWorkers: 10, queued: 1 });
    const bill = h.store.orders().find((o) => o.issueKey === 'BILL-1')!;
    const logs = h.store.orders().find((o) => o.title === '로그 정리')!;
    const waiting = [spoken, bill, logs, h.store.order('ord-late')!].filter(
      (o) => !h.store.order(o.id)!.workerId,
    );
    expect(waiting).toHaveLength(1);

    // 배경 주문 하나를 끝내 자리를 만들면 기다리던 주문이 떠서 다시 10개가 돈다
    h.report(h.workerOf('ord-bg-0'), { status: 'done' });
    await h.run();
    for (const o of [spoken, bill, logs, h.store.order('ord-late')!])
      expect(h.store.order(o.id)!.workerId).toBeDefined();
    expect(h.store.activeWorkers()).toHaveLength(10);

    const ask = (id: string, kind: string, detail: string) =>
      h.report(h.workerOf(id), { status: 'needs', need: { kind, detail } });
    ask(spoken.id, 'merge-approval', '머지할까요');
    ask(bill.id, 'merge-approval', '머지할까요');
    ask(logs.id, 'interview-answer', '보존 기간은요?');
    await h.run();
    expect(
      h.store
        .openGates()
        .map((g) => `${g.orderId}:${g.type}`)
        .sort(),
    ).toEqual([`${bill.id}:merge`, `${logs.id}:interview`].sort());

    await deliverGateDecision(
      h.store,
      resolveGate(h.store, h.store.openGates(logs.id)[0]!.id, 'approved', '30일'),
      h.deps,
    );
    await deliverGateDecision(
      h.store,
      resolveGate(h.store, h.store.openGates(bill.id)[0]!.id, 'approved'),
      h.deps,
    );
    ask(logs.id, 'merge-approval', '머지할까요');
    await h.run();
    await deliverGateDecision(
      h.store,
      resolveGate(h.store, h.store.openGates(logs.id)[0]!.id, 'approved'),
      h.deps,
    );

    h.report(h.workerOf(spoken.id), { status: 'done', merged: true });
    h.report(h.workerOf(bill.id), {
      status: 'progress',
      skill: 'ship',
      summary: 'draft PR 생성',
      prRef: 'acme/billing#7',
    });
    h.report(h.workerOf(bill.id), { status: 'done', merged: true });
    h.report(h.workerOf(logs.id), { status: 'done', merged: true });
    await h.run();
    expect(h.store.order(spoken.id)!.status).toBe('done');
    expect(h.store.order(logs.id)!.status).toBe('done');
    expect(h.store.order(bill.id)!.status).toBe('merged');

    deploy = { status: 'success' };
    await h.run();
    expect(h.store.order(bill.id)!.status).toBe('done');
    expect(h.jiraMoves).toEqual(['BILL-1:TODO', 'BILL-1:In Progress', 'BILL-1:PR', 'BILL-1:In-QA']);
    expect(h.store.openGates()).toEqual([]);
  });
});

describe('저장소만으로 복원', () => {
  it('컨덕터 세션이 다시 떠도 로그를 재생해 같은 상태에서 이어 간다', async () => {
    const h = harness();
    h.store.addOrder(order({ id: 'ord-a', scope: 'approval' }));
    h.store.addOrder(order({ id: 'ord-b' }));
    await h.run();
    h.report(h.workerOf('ord-a'), {
      status: 'needs',
      need: { kind: 'merge-approval', detail: '머지할까요' },
    });
    await h.run();

    const reopened = ConductorStore.open(h.dir, { now: h.now });
    expect(reopened.snapshot).toEqual(h.store.snapshot);
    expect(reopened.order('ord-a')!.status).toBe('waiting-gate');
    expect(reopened.openGates('ord-a').map((g) => g.type)).toEqual(['merge']);

    // 간격 안이면 새 세션도 tick을 다시 돌지 않는다
    expect((await tick(reopened, h.deps)).skipped).toBe(true);
    h.report(h.workerOf('ord-b'), { status: 'done', merged: true });
    await tick(reopened, h.deps, { force: true });
    expect(reopened.order('ord-b')!.status).toBe('done');
  });
});
