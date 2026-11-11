import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deliverGateDecision,
  inboxDirOf,
  tick,
  writeReport,
  type EngineDeps,
} from '../../../src/master/engine.js';
import { resolveGate } from '../../../src/master/gates.js';
import type { DeploySignal, JiraClient } from '../../../src/master/jira.js';
import type { HostAction, Launcher, LaunchSpec } from '../../../src/master/launcher.js';
import type { MasterConfig } from '../../../src/master/scheduler.js';
import { MasterStore } from '../../../src/master/store.js';
import type { Worker, WorkerKind } from '../../../src/master/types.js';
import { cleanupStateDirs, clockedStore, order } from './fixtures.js';

afterEach(cleanupStateDirs);

const config: MasterConfig = {
  maxConcurrentWorkers: 2,
  pollIntervalSec: 60,
  maxResumeAttempts: 3,
  staleAfterSec: 900,
  defaultScope: 'approval',
  resultMaxChars: 2000,
  accounts: {},
  repoPaths: {},
};

function fakeLauncher(kind: WorkerKind) {
  const started: LaunchSpec[] = [];
  const sent: { workerId: string; message: string }[] = [];
  const released: string[] = [];
  const launcher: Launcher = {
    kind,
    start: async (spec) => {
      started.push(spec);
      return { handle: spec.previousHandle ?? `h-${spec.worker.id}` };
    },
    send: async (w: Worker, message: string): Promise<HostAction | undefined> => {
      sent.push({ workerId: w.id, message });
      return undefined;
    },
    release: async (w) => {
      released.push(w.id);
    },
  };
  return { launcher, started, sent, released };
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

function deps(over: Partial<EngineDeps> = {}) {
  const git = fakeLauncher('git-worktree');
  const base: EngineDeps = {
    config,
    launchers: { 'git-worktree': git.launcher },
    orcaAvailable: false,
    env: {},
    ...over,
  };
  return { deps: base, git };
}

function report(store: MasterStore, d: EngineDeps, raw: Record<string, unknown>) {
  writeReport(
    inboxDirOf(store, d),
    { summary: '진행 중이에요', refs: [], ...raw },
    config.resultMaxChars,
  );
}

describe('마스터 tick', () => {
  it('동시 상한을 넘는 주문은 큐에 남았다가 자리가 나면 뜬다', async () => {
    const { store } = clockedStore();
    for (let i = 0; i < 3; i++) store.addOrder(order({ id: `ord-${i}` }));
    const { deps: d, git } = deps();

    const first = await tick(store, d, { force: true });
    expect(first.launched.map((l) => l.orderId)).toEqual(['ord-0', 'ord-1']);
    expect(first.counts).toMatchObject({ queued: 1, running: 2, activeWorkers: 2 });

    report(store, d, { workerId: store.order('ord-0')!.workerId!, status: 'done', merged: true });
    const second = await tick(store, d, { force: true });
    expect(second.launched.map((l) => l.orderId)).toEqual(['ord-2']);
    expect(store.order('ord-0')!.status).toBe('done');
    expect(git.released).toEqual([store.order('ord-0')!.workerId]);
    expect(store.worker(store.order('ord-0')!.workerId!)!.status).toBe('released');
  });

  it('주문 범위대로 머지 승인을 넘기거나 사람에게 올린다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-auto', scope: 'merge-through' }));
    store.addOrder(order({ id: 'ord-ask', scope: 'approval' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });

    for (const id of ['ord-auto', 'ord-ask']) {
      report(store, d, {
        workerId: store.order(id)!.workerId!,
        status: 'needs',
        need: { kind: 'merge-approval', detail: '머지해도 될까요' },
      });
    }
    const r = await tick(store, d, { force: true });
    expect(r.errors).toEqual([]);
    expect(git.sent.map((s) => s.workerId)).toEqual([store.order('ord-auto')!.workerId]);
    expect(git.sent[0]!.message).toContain('이어서 진행하세요');

    const gates = store.openGates('ord-ask');
    expect(gates.map((g) => g.type)).toEqual(['merge']);
    expect(store.order('ord-ask')!.status).toBe('waiting-gate');

    const closed = resolveGate(store, gates[0]!.id, 'approved');
    await deliverGateDecision(store, closed, d);
    expect(git.sent.at(-1)!.workerId).toBe(store.order('ord-ask')!.workerId);
  });

  it('사람 확인 자리가 아닌 요청은 기본 절차로 넘기고 절차가 없을 때만 올린다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-app', repo: 'acme/app' }));
    store.addOrder(order({ id: 'ord-etc', repo: 'acme/etc' }));
    const switched: string[] = [];
    const { deps: d, git } = deps({
      config: { ...config, accounts: { 'acme/app': 'work' } },
      accounts: {
        current: async () => 'work',
        switchTo: async (repo, a) => void switched.push(`${repo}:${a}`),
      },
    });
    await tick(store, d, { force: true });

    const ask = (id: string, kind: string) =>
      report(store, d, {
        workerId: store.order(id)!.workerId!,
        status: 'needs',
        need: { kind, detail: '부탁해요' },
      });
    ask('ord-app', 'simple-approval');
    await tick(store, d, { force: true });
    ask('ord-app', 'account-switch');
    ask('ord-etc', 'auth');
    await tick(store, d, { force: true });

    expect(git.sent.map((s) => s.workerId)).toEqual([
      store.order('ord-app')!.workerId,
      store.order('ord-app')!.workerId,
    ]);
    expect(switched).toEqual(['acme/app:work']);
    expect(store.openGates('ord-app')).toEqual([]);
    expect(store.openGates('ord-etc').map((g) => g.type)).toEqual(['no-procedure']);
  });

  it('소식이 끊긴 워커는 체크포인트부터 같은 손잡이로 다시 띄운다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const first = store.order('ord-1')!.workerId!;

    advance(16 * 60 * 1000);
    const r = await tick(store, d, { force: true });
    expect(store.worker(first)!.status).toBe('stopped');
    expect(r.launched).toEqual([expect.objectContaining({ orderId: 'ord-1', resumed: true })]);
    expect(git.started.at(-1)!.previousHandle).toBe(`h-${first}`);
    expect(git.started.at(-1)!.prompt).toContain('남은 체인');

    // 앞 워커가 늦게 보낸 결과는 주문을 건드리지 않는다
    report(store, d, { workerId: first, status: 'done', merged: true });
    const late = await tick(store, d, { force: true });
    expect(late.errors.join()).toContain('앞 워커');
    expect(store.order('ord-1')!.status).toBe('running');
  });

  it('지라 주문은 단계마다 옮기고 배포가 성공해야 In-QA로 끝낸다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-bug', issueKey: 'APP-1', issueType: 'bug' }));
    const jira = fakeJira();
    let deploy: DeploySignal = { status: 'pending' };
    const { deps: d } = deps({ jira: jira.client, deploy: { status: async () => deploy } });

    await tick(store, d, { force: true });
    const wid = store.order('ord-bug')!.workerId!;
    report(store, d, { workerId: wid, status: 'progress', prRef: 'acme/app#5' });
    await tick(store, d, { force: true });
    report(store, d, { workerId: wid, status: 'done', merged: true });
    await tick(store, d, { force: true });
    expect(store.order('ord-bug')!.status).toBe('merged');

    deploy = { status: 'success', ref: 'deploy-7' };
    await tick(store, d, { force: true });
    expect(store.order('ord-bug')!.status).toBe('done');
    expect(jira.moves.map((m) => m.to)).toEqual(['TODO', 'In Progress', 'PR', 'In-QA']);
  });

  it('배포가 실패하면 그 주문만 사람에게 올린다', async () => {
    const { store } = clockedStore();
    store.addOrder(
      order({ id: 'ord-bug', issueKey: 'APP-2', issueType: 'task', status: 'merged' }),
    );
    const { deps: d } = deps({
      deploy: { status: async () => ({ status: 'failed', ref: 'run-9' }) },
    });
    const r = await tick(store, d, { force: true });
    expect(store.order('ord-bug')!.status).toBe('escalated');
    expect(store.snapshot.gates[r.escalated[0]!]!.refs).toEqual(['run-9']);
  });

  it('워커가 하위 워커를 원하면 마스터가 새 주문으로 받는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d } = deps();
    await tick(store, d, { force: true });
    report(store, d, {
      workerId: store.order('ord-1')!.workerId!,
      status: 'progress',
      spawnRequest: { title: '마이그레이션 분리', detail: '스키마 변경만 따로 PR로' },
    });
    const r = await tick(store, d, { force: true });
    expect(r.created).toHaveLength(1);
    expect(r.launched.map((l) => l.orderId)).toEqual(r.created);
  });

  it('런처가 없거나 실패하면 그 주문만 올리고 나머지는 띄운다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-orca', workerKind: 'subagent' }));
    store.addOrder(order({ id: 'ord-git' }));
    const { deps: d } = deps();
    const r = await tick(store, d, { force: true });
    expect(r.launched.map((l) => l.orderId)).toEqual(['ord-git']);
    expect(r.escalated).toHaveLength(1);
    expect(store.snapshot.gates[r.escalated[0]!]!.reason).toContain('subagent');
  });

  it('간격 안의 tick과 겹친 tick은 건너뛴다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    expect((await tick(store, d)).skipped).toBeUndefined();
    expect((await tick(store, d)).skipped).toBe(true);

    writeFileSync(join(dir, 'tick.lock'), '');
    const locked = await tick(store, d, { force: true });
    expect(locked.skipped).toBe(true);
    expect(locked.errors[0]).toContain('다른 tick');
  });

  it('워커 안에서는 tick을 거절한다', async () => {
    const { store } = clockedStore();
    const { deps: d } = deps({ env: { GESTALT_MASTER_WORKER_ID: 'wrk-1' } });
    await expect(tick(store, d, { force: true })).rejects.toThrow();
  });
});
