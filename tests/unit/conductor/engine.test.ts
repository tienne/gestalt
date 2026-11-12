import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  deliverGateDecision,
  FAILED_REPORTS_DIR,
  inboxDirOf,
  MAX_SPAWN_PER_ORDER,
  resolveWorkerAgent,
  tick,
  UNRECORDED_REPORTS_DIR,
  writeReport,
  type EngineDeps,
} from '../../../src/conductor/engine.js';
import { resolveGate } from '../../../src/conductor/gates.js';
import type { DeploySignal, JiraClient } from '../../../src/conductor/jira.js';
import { repoContextPath } from '../../../src/conductor/context.js';
import {
  SubagentLauncher,
  type HostAction,
  type Launcher,
  type LaunchSpec,
  type ReleaseOptions,
} from '../../../src/conductor/launcher.js';
import type { ConductorConfig } from '../../../src/conductor/scheduler.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import type { Worker, WorkerKind } from '../../../src/conductor/types.js';
import { cleanupStateDirs, clockedStore, order, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

const config: ConductorConfig = {
  maxConcurrentWorkers: 2,
  pollIntervalSec: 60,
  maxResumeAttempts: 3,
  staleAfterSec: 900,
  defaultScope: 'approval',
  resultMaxChars: 2000,
  accounts: {},
  repoPaths: {},
  defaultAgent: 'claude',
  repoAgents: {},
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

function report(store: ConductorStore, d: EngineDeps, raw: Record<string, unknown>) {
  writeReport(
    inboxDirOf(store, d),
    { summary: '진행 중이에요', refs: [], ...raw },
    config.resultMaxChars,
  );
}

describe('컨덕터 tick', () => {
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

  it('런처가 남긴 경고를 tick 보고에 싣는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-0', parentWorktree: '/w/feat' }));
    const { deps: d, git } = deps();
    git.launcher.start = async (spec) => ({
      handle: `h-${spec.worker.id}`,
      warnings: ['부모 워크트리를 무시했어요'],
    });
    const r = await tick(store, d, { force: true });
    expect(r.warnings).toEqual(['부모 워크트리를 무시했어요']);
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

  it('주문 설명과 레포 공통 맥락 경로가 prompts/의 워커 지시 파일에 들어간다', async () => {
    const { store } = clockedStore();
    const description = ['## 배경', '긴 대화에서 나온 요구사항', '- 참고: docs/a.md'].join('\n');
    store.addOrder(order({ id: 'ord-ctx', description, skillChain: ['review'] }));
    store.addOrder(order({ id: 'ord-none', repo: 'acme/other', skillChain: ['review'] }));
    const contextFile = repoContextPath(resolve(store.dir), 'acme/app');
    mkdirSync(join(store.dir, 'context', 'acme'), { recursive: true });
    writeFileSync(contextFile, '배포는 태그 푸시로 한다\n');
    const sub = new SubagentLauncher({ promptDir: join(store.dir, 'prompts') });
    const { deps: d } = deps({ launchers: { subagent: sub } });

    const r = await tick(store, d, { force: true });
    const files = r.hostActions.flatMap((a) => (a.type === 'spawn-subagent' ? [a] : []));
    const promptOf = (orderId: string) => {
      const a = files.find((f) => f.workerId === store.order(orderId)!.workerId)!;
      expect(a.promptFile.startsWith(join(store.dir, 'prompts'))).toBe(true);
      return readFileSync(a.promptFile, 'utf-8');
    };
    const withContext = promptOf('ord-ctx');
    expect(withContext).toContain(description);
    expect(withContext).toContain(`- 레포 공통 맥락: ${contextFile}`);
    expect(promptOf('ord-none')).not.toContain('레포 공통 맥락');
  });

  it('소식이 끊긴 워커는 체크포인트부터 같은 워커 식별자로 다시 띄운다', async () => {
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

  it('지라 담당 티켓이 페이지 상한에 닿으면 tick 결과에 남긴다', async () => {
    const { store } = clockedStore();
    const { deps: d } = deps({
      jiraSource: { fetchAssigned: async () => ({ tickets: [], truncated: true }) },
    });
    const r = await tick(store, d, { force: true });
    expect(r.errors.some((e) => e.includes('페이지 상한'))).toBe(true);
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

  it('워커가 하위 워커를 원하면 컨덕터가 새 주문으로 받는다', async () => {
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

  it('merge-through 주문의 하위 주문은 approval로 낮추고 주문당 상한을 넘으면 워커에 거절을 알린다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', scope: 'merge-through' }));
    const { deps: d, git } = deps({ config: { ...config, maxConcurrentWorkers: 1 } });
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    for (let i = 0; i <= MAX_SPAWN_PER_ORDER; i++) {
      report(store, d, {
        workerId: wid,
        status: 'progress',
        spawnRequest: { title: `하위 ${i}`, detail: '따로 PR로' },
      });
    }
    const r = await tick(store, d, { force: true });
    expect(r.created).toHaveLength(MAX_SPAWN_PER_ORDER);
    expect(r.created.map((id) => store.order(id)!.scope)).toEqual(
      Array(MAX_SPAWN_PER_ORDER).fill('approval'),
    );
    expect(r.created.map((id) => store.order(id)!.parentOrderId)).toEqual(
      Array(MAX_SPAWN_PER_ORDER).fill('ord-1'),
    );
    expect(r.escalated).toEqual([]);
    expect(r.errors.join()).toContain('거절');
    expect(git.sent.filter((m) => m.workerId === wid).at(-1)?.message).toContain(
      '하위 주문을 만들지 않았어요',
    );
  });

  it('하위 주문의 워커는 하위 주문을 더 만들지 못한다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-child', parentOrderId: 'ord-1' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const wid = store.order('ord-child')!.workerId!;
    report(store, d, {
      workerId: wid,
      status: 'progress',
      spawnRequest: { title: '손자', detail: 'x' },
    });
    const r = await tick(store, d, { force: true });
    expect(r.created).toEqual([]);
    expect(git.sent.at(-1)?.message).toContain('하위 주문을 만들지 않았어요');
  });

  // root는 권한과 무관하게 지울 수 있어 지우기 실패를 흉내낼 수 없다
  it.skipIf(process.getuid?.() === 0)(
    '한 번 적용한 보고 파일은 지우지 못해 남아 있어도 다시 적용하지 않고 지운 뒤에는 기록에서 뺀다',
    async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-1' }));
      const { deps: d, git } = deps();
      await tick(store, d, { force: true });
      const wid = store.order('ord-1')!.workerId!;
      report(store, d, {
        workerId: wid,
        status: 'needs',
        need: { kind: 'simple-approval', detail: '부탁해요' },
        spawnRequest: { title: '하위', detail: 'x' },
      });
      const inbox = inboxDirOf(store, d);
      const name = readdirSync(inbox).find((f) => f.endsWith('.json'))!;

      chmodSync(inbox, 0o555);
      try {
        const first = await tick(store, d, { force: true });
        expect(first.errors.some((e) => e.includes('못 지웠어요'))).toBe(true);
        expect(store.snapshot.appliedReports[name]).toBeDefined();
        const orders = store.orders().length;
        const sent = git.sent.length;

        await tick(store, d, { force: true });
        expect(store.orders()).toHaveLength(orders);
        expect(git.sent).toHaveLength(sent);
        expect(store.snapshot.appliedReports[name]).toBeDefined();
      } finally {
        chmodSync(inbox, 0o755);
      }

      const orders = store.orders().length;
      const r = await tick(store, d, { force: true });
      expect(r.errors).toEqual([]);
      expect(store.orders()).toHaveLength(orders);
      expect(existsSync(join(inbox, name))).toBe(false);
      expect(store.snapshot.appliedReports[name]).toBeUndefined();
      // 다시 연 저장소도 이벤트를 다시 읽어 같은 기록을 얻는다
      expect(ConductorStore.open(store.dir).snapshot.appliedReports[name]).toBeUndefined();
    },
  );

  it('need가 없는 needs 보고는 적용하지 않고 원문을 failed로 옮긴다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const inbox = inboxDirOf(store, d);
    // writeReport는 need 없는 needs를 받지 않아 파일을 직접 쓴다
    mkdirSync(inbox, { recursive: true });
    writeFileSync(
      join(inbox, 'manual.json'),
      JSON.stringify({
        workerId: store.order('ord-1')!.workerId,
        status: 'needs',
        summary: '부탁해요',
        refs: [],
      }),
    );
    const r = await tick(store, d, { force: true });
    expect(r.errors.some((e) => e.includes('manual.json'))).toBe(true);
    expect(git.sent).toEqual([]);
    expect(store.snapshot.appliedReports['manual.json']).toBeUndefined();
    expect(existsSync(join(inbox, 'failed', 'manual.json'))).toBe(true);
  });

  it('같은 tick에 온 워커 보고의 PR은 PR 감시가 새 주문으로 받지 않는다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', repo: 'acme/app' }));
    const prSource = {
      authored: async () => [
        {
          repo: 'acme/app',
          title: '배너',
          headSha: 'b',
          ref: 'acme/app#5',
          latestOtherCommentId: 'c1',
        },
      ],
      reviewing: async () => [],
    };
    const { deps: d } = deps();
    await tick(store, d, { force: true });
    report(store, d, {
      workerId: store.order('ord-1')!.workerId!,
      status: 'progress',
      prRef: 'acme/app#5',
    });
    const r = await tick(store, { ...d, prSource }, { force: true });
    expect(r.created).toEqual([]);
    expect(store.orders()).toHaveLength(1);
    expect(store.order('ord-1')!.prRef).toBe('acme/app#5');
  });

  describe('머지된 주문의 오르카 워크트리 정리', () => {
    function orcaRelease(fail?: (w: Worker) => boolean) {
      const calls: { id: string; opts?: ReleaseOptions }[] = [];
      const launcher: Launcher = {
        kind: 'orca-worktree',
        start: async (spec) => ({ handle: `h-${spec.worker.id}` }),
        send: async () => undefined,
        release: async (w, opts) => {
          if (fail?.(w)) throw new Error('커밋 안 한 변경이 있어요');
          calls.push({ id: w.id, ...(opts ? { opts } : {}) });
        },
      };
      return { launcher, calls };
    }

    function addWorker(store: ConductorStore, over: Partial<Worker>) {
      store.startWorker({
        ...worker(over.orderId ?? 'ord-1'),
        kind: 'orca-worktree',
        handle: 'ctx',
        ...over,
      });
    }

    it('옵션을 켜면 머지된 주문의 모든 회차 워크트리를 지우고 부모 워크트리를 넘긴다', async () => {
      const { store } = clockedStore();
      store.addOrder(
        order({
          id: 'ord-1',
          status: 'done',
          mergedAt: '2026-01-01T00:00:00.000Z',
          parentWorktree: '/ws/feat',
          workerId: 'wrk-2',
        }),
      );
      addWorker(store, { id: 'wrk-1', attempt: 1, status: 'stopped', stopReason: 'disconnected' });
      addWorker(store, { id: 'wrk-2', attempt: 2, status: 'finished' });
      const orca = orcaRelease();
      const { deps: d } = deps({
        config: { ...config, removeMergedOrcaWorktrees: true },
        launchers: { 'orca-worktree': orca.launcher },
      });
      await tick(store, d, { force: true });
      expect(orca.calls.map((c) => c.id).sort()).toEqual(['wrk-1', 'wrk-2']);
      for (const c of orca.calls)
        expect(c.opts).toEqual({ removeWorktree: true, parentWorktree: '/ws/feat' });
      expect(store.worker('wrk-1')!.status).toBe('released');
      expect(store.worker('wrk-2')!.status).toBe('released');
    });

    it('옵션이 꺼져 있으면 지금처럼 터미널만 거두고 멈춘 앞 회차는 그대로 둔다', async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-1', status: 'done', mergedAt: '2026-01-01T00:00:00.000Z' }));
      addWorker(store, { id: 'wrk-1', attempt: 1, status: 'stopped' });
      addWorker(store, { id: 'wrk-2', attempt: 2, status: 'finished' });
      const orca = orcaRelease();
      const { deps: d } = deps({ launchers: { 'orca-worktree': orca.launcher } });
      await tick(store, d, { force: true });
      expect(orca.calls).toEqual([{ id: 'wrk-2', opts: {} }]);
      expect(store.worker('wrk-1')!.status).toBe('stopped');
    });

    it('머지 안 된 주문은 옵션을 켜도 워크트리를 남긴다', async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-1', status: 'failed' }));
      store.addOrder(order({ id: 'ord-2', status: 'cancelled' }));
      addWorker(store, { id: 'wrk-1', orderId: 'ord-1', status: 'failed' });
      addWorker(store, { id: 'wrk-2', orderId: 'ord-2', status: 'stopped' });
      const orca = orcaRelease();
      const { deps: d } = deps({
        config: { ...config, removeMergedOrcaWorktrees: true },
        launchers: { 'orca-worktree': orca.launcher },
      });
      await tick(store, d, { force: true });
      expect(orca.calls).toEqual([{ id: 'wrk-1', opts: {} }]);
      expect(store.worker('wrk-2')!.status).toBe('stopped');
    });

    it('같은 레포의 워크트리 삭제는 차례로, 다른 레포끼리는 함께 돌린다', async () => {
      const { store } = clockedStore();
      const merged = '2026-01-01T00:00:00.000Z';
      store.addOrder(order({ id: 'ord-a', repo: 'acme/a', status: 'done', mergedAt: merged }));
      store.addOrder(order({ id: 'ord-b', repo: 'acme/b', status: 'done', mergedAt: merged }));
      addWorker(store, { id: 'wrk-a1', orderId: 'ord-a', attempt: 1, status: 'stopped' });
      addWorker(store, { id: 'wrk-a2', orderId: 'ord-a', attempt: 2, status: 'finished' });
      addWorker(store, { id: 'wrk-b1', orderId: 'ord-b', attempt: 1, status: 'finished' });
      const active = new Map<string, number>();
      const peak = new Map<string, number>();
      let overall = 0;
      let overallPeak = 0;
      const launcher: Launcher = {
        kind: 'orca-worktree',
        start: async (spec) => ({ handle: `h-${spec.worker.id}` }),
        send: async () => undefined,
        release: async (w) => {
          const repo = store.order(w.orderId)!.repo;
          active.set(repo, (active.get(repo) ?? 0) + 1);
          peak.set(repo, Math.max(peak.get(repo) ?? 0, active.get(repo)!));
          overallPeak = Math.max(overallPeak, ++overall);
          await new Promise((r) => setTimeout(r, 5));
          active.set(repo, active.get(repo)! - 1);
          overall--;
        },
      };
      const { deps: d } = deps({
        config: { ...config, removeMergedOrcaWorktrees: true },
        launchers: { 'orca-worktree': launcher },
      });
      await tick(store, d, { force: true });
      expect(peak.get('acme/a')).toBe(1);
      expect(overallPeak).toBe(2);
      for (const id of ['wrk-a1', 'wrk-a2', 'wrk-b1'])
        expect(store.worker(id)!.status).toBe('released');
    });

    it('지우기가 실패하면 정리 실패 게이트를 타고 승인되면 released로 둔다', async () => {
      const { store } = clockedStore();
      store.addOrder(order({ id: 'ord-1', status: 'done', mergedAt: '2026-01-01T00:00:00.000Z' }));
      addWorker(store, { id: 'wrk-1', status: 'finished' });
      let dirty = true;
      const orca = orcaRelease(() => dirty);
      const { deps: d } = deps({
        config: { ...config, removeMergedOrcaWorktrees: true },
        launchers: { 'orca-worktree': orca.launcher },
      });
      const r = await tick(store, d, { force: true });
      expect(r.escalated).toHaveLength(1);
      const gate = store.snapshot.gates[r.escalated[0]!]!;
      expect(gate.payload).toMatchObject({ kind: 'cleanup-failed', workerId: 'wrk-1' });
      expect(gate.reason).toContain('커밋 안 한 변경');
      expect(store.worker('wrk-1')!.status).toBe('finished');

      // 게이트가 열린 동안은 다시 지우지 않는다
      dirty = false;
      await tick(store, d, { force: true });
      expect(orca.calls).toEqual([]);
      resolveGate(store, gate.id, 'rejected');
      await tick(store, d, { force: true });
      expect(orca.calls.map((c) => c.id)).toEqual(['wrk-1']);
      expect(store.worker('wrk-1')!.status).toBe('released');
    });
  });

  it('워커 정리가 실패하면 주문에 안 묶인 게이트를 열고 주문은 그대로 정산한다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-1', status: 'merged', mergedAt: '2026-01-01T00:00:00.000Z' }));
    store.startWorker({
      id: 'wrk-1',
      orderId: 'ord-1',
      kind: 'git-worktree',
      spawnedBy: 'conductor',
      attempt: 1,
      status: 'finished',
      startedAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    });
    const { deps: d, git } = deps();
    git.launcher.release = async () => {
      throw new Error('워크트리가 잠겨 있어요');
    };
    const r = await tick(store, d, { force: true });
    expect(r.escalated).toHaveLength(1);
    const gate = store.snapshot.gates[r.escalated[0]!]!;
    expect(gate.orderId).toBeUndefined();
    expect(gate.payload).toMatchObject({ kind: 'cleanup-failed', workerId: 'wrk-1' });
    expect(store.order('ord-1')!.status).toBe('done');

    // 게이트가 열려 있는 동안은 다시 시도하지 않고 승인되면 정리된 것으로 본다
    const again = await tick(store, d, { force: true });
    expect(again.escalated).toEqual([]);
    resolveGate(store, gate.id, 'approved');
    await tick(store, d, { force: true });
    expect(store.worker('wrk-1')!.status).toBe('released');
  });

  it('적용하다 실패한 결과는 지우지 않고 failed로 옮겨 원문을 남긴다', async () => {
    const { store } = clockedStore();
    const { deps: d } = deps();
    report(store, d, { workerId: 'wrk-ghost', status: 'done' });
    const r = await tick(store, d, { force: true });
    expect(r.errors.join()).toContain('모르는 워커');
    const inbox = inboxDirOf(store, d);
    expect(readdirSync(inbox).filter((f) => f.endsWith('.json'))).toEqual([]);
    expect(readdirSync(join(inbox, FAILED_REPORTS_DIR))).toHaveLength(1);
  });

  it('한 주문의 정산이 던져도 뒤의 머지된 주문은 끝낸다', async () => {
    const { store } = clockedStore();
    store.addOrder(order({ id: 'ord-a', issueKey: 'APP-1', issueType: 'bug', status: 'merged' }));
    store.addOrder(order({ id: 'ord-b', issueKey: 'APP-2', issueType: 'bug', status: 'merged' }));
    const { deps: d } = deps({
      deploy: {
        status: async (o) => {
          if (o.id === 'ord-a') throw new Error('배포 결과 파일이 깨졌어요');
          return { status: 'success' };
        },
      },
    });
    const r = await tick(store, d, { force: true });
    expect(r.errors.join()).toContain('ord-a 정산 실패');
    expect(store.order('ord-a')!.status).toBe('merged');
    expect(store.order('ord-b')!.status).toBe('done');
  });

  it('배포 실패 게이트를 승인하면 체인을 다시 돌리지 않고 정산을 다시 한다', async () => {
    const { store } = clockedStore();
    store.addOrder(
      order({
        id: 'ord-bug',
        issueKey: 'APP-3',
        issueType: 'bug',
        status: 'merged',
        mergedAt: '2026-11-01T00:00:00.000Z',
      }),
    );
    let deploy: DeploySignal = { status: 'failed' };
    const { deps: d, git } = deps({ deploy: { status: async () => deploy } });
    const r = await tick(store, d, { force: true });
    expect(store.order('ord-bug')!.status).toBe('escalated');

    resolveGate(store, r.escalated[0]!, 'approved');
    expect(store.order('ord-bug')!.status).toBe('merged');
    deploy = { status: 'success' };
    await tick(store, d, { force: true });
    expect(store.order('ord-bug')!.status).toBe('done');
    expect(git.started).toEqual([]);
  });

  it('사람 확인을 오래 기다린 워커도 끊긴 것으로 보지 않고 승인을 그 워커에 전한다', async () => {
    const { store, advance } = clockedStore();
    store.addOrder(order({ id: 'ord-1', scope: 'approval' }));
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    const wid = store.order('ord-1')!.workerId!;
    report(store, d, {
      workerId: wid,
      status: 'needs',
      need: { kind: 'merge-approval', detail: '머지해도 될까요' },
    });
    await tick(store, d, { force: true });
    expect(store.order('ord-1')!.status).toBe('waiting-gate');

    advance(60 * 60 * 1000);
    await tick(store, d, { force: true });
    expect(store.worker(wid)!.status).toBe('running');

    const closed = resolveGate(store, store.openGates('ord-1')[0]!.id, 'approved');
    await deliverGateDecision(store, closed, d);
    expect(store.order('ord-1')!.status).toBe('running');
    expect(git.sent.at(-1)!.workerId).toBe(wid);

    // 승인 직후 tick이 기다린 시간을 끊김으로 세지 않는다
    await tick(store, d, { force: true });
    expect(store.worker(wid)!.status).toBe('running');
    expect(git.started).toHaveLength(1);
  });

  const lockOf = (pid: number, startedAt: number) => `${pid}:${startedAt}:${hostname()}:x`;

  it('살아 있는 프로세스의 잠금은 한 시간이 지나도 걷어내지 않는다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    writeFileSync(lock, lockOf(process.pid, Date.now() - 60 * 60 * 1000));
    const r = await tick(store, d, { force: true });
    expect(r.skipped).toBe(true);
    expect(r.errors[0]).toContain(`pid ${process.pid}`);
    expect(existsSync(lock)).toBe(true);
  });

  it('살아 있는 프로세스의 잠금이라도 6시간이 지나면 걷어낸다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    writeFileSync(join(dir, 'tick.lock'), lockOf(process.pid, Date.now() - 7 * 60 * 60 * 1000));
    const r = await tick(store, d, { force: true });
    expect(r.skipped).toBeUndefined();
  });

  it('죽은 프로세스의 잠금은 걷어내고 돌며 끝나면 자기 잠금만 푼다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    writeFileSync(lock, lockOf(2147483646, Date.now()));
    const r = await tick(store, d, { force: true });
    expect(r.skipped).toBeUndefined();
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dir).filter((f) => f.includes('tick.lock'))).toEqual([]);
  });

  it('못 읽는 옛 꼴 잠금은 10분이 지나야 걷어낸다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    writeFileSync(lock, `${process.pid}:other`);
    expect((await tick(store, d, { force: true })).skipped).toBe(true);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lock, old, old);
    expect((await tick(store, d, { force: true })).skipped).toBeUndefined();
  });

  it('다른 호스트의 잠금은 pid를 안 보고 6시간 상한만 본다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    writeFileSync(lock, `2147483646:${Date.now() - 60 * 60 * 1000}:other-host:x`);
    expect((await tick(store, d, { force: true })).skipped).toBe(true);
    writeFileSync(lock, `2147483646:${Date.now() - 7 * 60 * 60 * 1000}:other-host:x`);
    expect((await tick(store, d, { force: true })).skipped).toBeUndefined();
  });

  it("호스트 이름에 ':'가 있어도 잠금을 읽어 옛 꼴로 걷지 않는다", async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    writeFileSync(lock, `2147483646:${Date.now()}:fe80::1:x`);
    const old = new Date(Date.now() - 11 * 60 * 1000);
    utimesSync(lock, old, old);
    const r = await tick(store, d, { force: true });
    expect(r.skipped).toBe(true);
    expect(r.errors[0]).toContain('pid 2147483646');
  });

  it('다른 프로세스가 걷는 중이면 건너뛰고 걷다 죽은 steal은 치운 뒤 다음 tick이 잡는다', async () => {
    const { store, dir } = clockedStore();
    const { deps: d } = deps();
    const lock = join(dir, 'tick.lock');
    const steal = `${lock}.steal`;
    writeFileSync(lock, lockOf(2147483646, Date.now()));

    writeFileSync(steal, lockOf(process.pid, Date.now()));
    expect((await tick(store, d, { force: true })).skipped).toBe(true);
    expect(existsSync(steal)).toBe(true);

    writeFileSync(steal, lockOf(2147483646, Date.now()));
    expect((await tick(store, d, { force: true })).skipped).toBe(true);
    expect(existsSync(steal)).toBe(false);
    expect((await tick(store, d, { force: true })).skipped).toBeUndefined();
    expect(readdirSync(dir).filter((f) => f.includes('tick.lock'))).toEqual([]);
  });

  // 줄이 끝내 안 비는 경로라 RELEASE_RETRIES x RELEASE_RETRY_MS(약 1초)를 실제로 다 기다린다.
  // 재시도 값을 옵션으로 열면 0을 넘겨 steal 줄을 건너뛰는 길이 생겨서 열지 않았다
  it('잠금을 풀 때 steal 줄에 서고 줄이 안 비어도 끝내 자기 잠금은 지운다', async () => {
    const { store, dir } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const lock = join(dir, 'tick.lock');
    const steal = `${lock}.steal`;
    const other = lockOf(process.pid, Date.now());
    const { deps: base, git } = deps();
    // tick이 도는 사이에 다른 프로세스가 걷는 중인 것처럼 steal을 만든다
    const d: EngineDeps = {
      ...base,
      launchers: {
        'git-worktree': {
          ...git.launcher,
          start: async (spec) => {
            writeFileSync(steal, other);
            return git.launcher.start(spec);
          },
        },
      },
    };
    const r = await tick(store, d, { force: true });
    expect(r.skipped).toBeUndefined();
    expect(existsSync(lock)).toBe(false);
    expect(readFileSync(steal, 'utf-8')).toBe(other);
  });

  it('잠금을 풀 때 걷다 죽은 steal을 치우고 그 줄에 서서 푼다', async () => {
    const { store, dir } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const lock = join(dir, 'tick.lock');
    const steal = `${lock}.steal`;
    const { deps: base, git } = deps();
    const d: EngineDeps = {
      ...base,
      launchers: {
        'git-worktree': {
          ...git.launcher,
          start: async (spec) => {
            writeFileSync(steal, lockOf(2147483646, Date.now()));
            return git.launcher.start(spec);
          },
        },
      },
    };
    expect((await tick(store, d, { force: true })).skipped).toBeUndefined();
    expect(readdirSync(dir).filter((f) => f.includes('tick.lock'))).toEqual([]);
  });

  it('같은 저장소를 연 두 컨덕터가 차례로 tick해도 같은 주문을 두 번 띄우지 않는다', async () => {
    const { store, dir, now } = clockedStore();
    store.addOrder(order({ id: 'ord-1' }));
    const other = ConductorStore.open(dir, { now });
    const { deps: d, git } = deps();
    await tick(store, d, { force: true });
    await tick(other, d, { force: true });
    expect(git.started).toHaveLength(1);
    expect(other.order('ord-1')!.workerId).toBe(store.order('ord-1')!.workerId);
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
    const { deps: d } = deps({ env: { GESTALT_CONDUCTOR_WORKER_ID: 'wrk-1' } });
    await expect(tick(store, d, { force: true })).rejects.toThrow();
  });
});

describe('워커 에이전트와 보고 보존', () => {
  it.each([
    { agent: 'opencode', repoAgent: 'codex', defaultAgent: 'cursor', expected: 'opencode' },
    { agent: undefined, repoAgent: 'codex', defaultAgent: 'cursor', expected: 'codex' },
    { agent: undefined, repoAgent: undefined, defaultAgent: 'cursor', expected: 'cursor' },
    { agent: undefined, repoAgent: undefined, defaultAgent: 'claude', expected: 'claude' },
  ])('주문 > 레포 > 기본 > claude 우선순위: $expected', async (row) => {
    const { store, now } = clockedStore();
    store.addOrder(order({ agent: row.agent }));
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({
      config: {
        ...config,
        defaultAgent: row.defaultAgent,
        repoAgents: row.repoAgent ? { 'acme/app': row.repoAgent } : {},
      },
      orcaAvailable: true,
      launchers: { 'orca-worktree': orca.launcher },
    });
    await tick(store, d, { now: now(), force: true });
    expect(orca.started[0]!.worker.agent).toBe(row.expected);
    expect(ConductorStore.open(store.dir).workers()[0]!.agent).toBe(row.expected);
  });

  it('재개는 설정 변경 후에도 앞 워커의 에이전트를 유지한다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({
      config: { ...config, defaultAgent: 'codex' },
      orcaAvailable: true,
      launchers: { 'orca-worktree': orca.launcher },
    });
    await tick(store, d, { now: now(), force: true });
    const first = orca.started[0]!.worker;
    report(store, d, { workerId: first.id, status: 'stopped', stopReason: 'disconnected' });
    const reopened = ConductorStore.open(store.dir);
    await tick(
      reopened,
      { ...d, config: { ...config, defaultAgent: 'cursor' } },
      { now: now(), force: true },
    );
    expect(orca.started[1]!.worker.agent).toBe('codex');
  });

  it('재개는 레포 설정이 있어도 앞 워커의 에이전트를 유지한다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const prev = worker(o.id, { kind: 'orca-worktree', agent: 'cursor', status: 'stopped' });
    store.startWorker(prev);
    store.updateOrder(o.id, { workerId: prev.id, status: 'running' });
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({
      config: { ...config, repoAgents: { 'acme/app': 'codex' } },
      orcaAvailable: true,
      launchers: { 'orca-worktree': orca.launcher },
    });
    await tick(store, d, { now: now(), force: true });
    expect(orca.started[0]!.worker.agent).toBe('cursor');
  });

  it('주문에 에이전트가 있으면 재개도 주문 값을 쓴다', async () => {
    const { store, now } = clockedStore();
    const o = order({ agent: 'opencode' });
    store.addOrder(o);
    const prev = worker(o.id, { kind: 'orca-worktree', agent: 'cursor', status: 'stopped' });
    store.startWorker(prev);
    store.updateOrder(o.id, { workerId: prev.id, status: 'running' });
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({
      config: { ...config, repoAgents: { 'acme/app': 'codex' } },
      orcaAvailable: true,
      launchers: { 'orca-worktree': orca.launcher },
    });
    await tick(store, d, { now: now(), force: true });
    expect(orca.started[0]!.worker.agent).toBe('opencode');
  });

  it('중간에 git 워크트리로 돌았어도 마지막 오르카 워커의 에이전트로 재개한다', () => {
    const workers = [
      { kind: 'orca-worktree' as const, agent: 'codex' },
      { kind: 'git-worktree' as const },
    ];
    const cfg = { repoAgents: { 'acme/app': 'cursor' }, defaultAgent: 'claude' };
    expect(resolveWorkerAgent({ repo: 'acme/app' }, workers, cfg)).toBe('codex');
    expect(resolveWorkerAgent({ repo: 'acme/app' }, [], cfg)).toBe('cursor');
    expect(resolveWorkerAgent({ repo: 'acme/web' }, [], cfg)).toBe('claude');
    expect(
      resolveWorkerAgent({ repo: 'acme/app' }, [{ kind: 'orca-worktree' as const }], cfg),
    ).toBe('claude');
  });

  it('에이전트 기록 없는 옛 오르카 워커는 claude로 재개한다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const legacy = worker(o.id, { kind: 'orca-worktree', status: 'stopped' });
    store.startWorker(legacy);
    store.updateOrder(o.id, { workerId: legacy.id, status: 'running' });
    const orca = fakeLauncher('orca-worktree');
    const { deps: d } = deps({
      config: { ...config, defaultAgent: 'codex' },
      orcaAvailable: true,
      launchers: { 'orca-worktree': orca.launcher },
    });
    await tick(ConductorStore.open(store.dir), d, { now: now(), force: true });
    expect(orca.started[0]!.worker.agent).toBe('claude');
  });

  it('호스트가 띄우는 워커에는 에이전트를 붙이지 않는다', async () => {
    const { store, now } = clockedStore();
    store.addOrder(order({ agent: 'codex' }));
    const { deps: d, git } = deps();
    await tick(store, d, { now: now(), force: true });
    expect(git.started[0]!.worker.agent).toBeUndefined();
  });

  it('진행과 완료 보고의 모든 결과 필드를 inbox 삭제 뒤에도 복원한다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const { deps: d, git } = deps();
    await tick(store, d, { now: now(), force: true });
    const workerId = git.started[0]!.worker.id;
    const progress = {
      workerId,
      status: 'progress',
      summary: '검증 진행',
      refs: ['reports/check.md'],
      skill: 'ship',
      prRef: 'acme/app#123',
      merged: false,
      stopReason: 'unknown',
      need: { kind: 'cleanup', detail: '임시 파일 정리' },
    };
    // 하위 주문 요청은 주문으로 옮겨지므로 이력에는 안 남는다
    report(store, d, { ...progress, spawnRequest: { title: '하위', detail: 'x' } });
    await tick(store, d, { now: now(), force: true });
    report(store, d, {
      workerId,
      status: 'done',
      summary: '검증 완료',
      refs: ['reports/result.md'],
    });
    await tick(store, d, { now: now(), force: true });
    expect(readdirSync(inboxDirOf(store, d))).toEqual([]);
    const reopened = ConductorStore.open(store.dir);
    expect(reopened.snapshot.reports[o.id]).toEqual([
      { ...progress, at: now().toISOString() },
      {
        workerId,
        status: 'done',
        summary: '검증 완료',
        refs: ['reports/result.md'],
        at: now().toISOString(),
      },
    ]);
    expect(JSON.stringify(reopened.snapshot.reports)).not.toContain('spawnRequest');
  });

  it('적용 뒤 이력 기록만 실패한 보고는 다시 적용하지 않고 다음 tick에 기록만 남긴다', async () => {
    const { store, now } = clockedStore();
    const o = order();
    store.addOrder(o);
    const { deps: d, git } = deps();
    await tick(store, d, { now: now(), force: true });
    const workerId = git.started[0]!.worker.id;
    report(store, d, {
      workerId,
      status: 'needs',
      summary: '승인 부탁',
      need: { kind: 'simple-approval', detail: '부탁해요' },
      spawnRequest: { title: '하위', detail: 'x' },
    });
    const append = store.append.bind(store);
    store.append = (e) => {
      if (e.type === 'report-applied') throw new Error('디스크가 찼어요');
      append(e);
    };
    const first = await tick(store, d, { now: now(), force: true });
    expect(first.errors.some((e) => e.includes('이력 기록만 실패'))).toBe(true);
    const inbox = inboxDirOf(store, d);
    expect(readdirSync(join(inbox, UNRECORDED_REPORTS_DIR))).toHaveLength(1);
    expect(existsSync(join(inbox, FAILED_REPORTS_DIR))).toBe(false);
    const bypasses = store.snapshot.bypasses.length;
    const sent = git.sent.length;
    const orders = store.orders().length;
    expect(bypasses).toBe(1);

    store.append = append;
    const second = await tick(store, d, { now: now(), force: true });
    expect(second.errors).toEqual([]);
    expect(store.snapshot.bypasses).toHaveLength(bypasses);
    expect(git.sent).toHaveLength(sent);
    expect(store.orders()).toHaveLength(orders);
    expect(readdirSync(join(inbox, UNRECORDED_REPORTS_DIR))).toEqual([]);
    expect(ConductorStore.open(store.dir).snapshot.reports[o.id]).toMatchObject([
      { workerId, status: 'needs', summary: '승인 부탁' },
    ]);
  });
});
