import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorArchiveAction,
  conductorArchiveCommand,
  conductorArchivePruneCommand,
  conductorCheckpointSaveCommand,
  conductorContextPathCommand,
  conductorDeployReportCommand,
  conductorGateListCommand,
  conductorGateResolveCommand,
  conductorHandoffCommand,
  conductorOrderAddCommand,
  conductorOrderRemoveCommand,
  conductorOrderShowCommand,
  conductorQueueAddCommand,
  conductorSlackDeliveryCommand,
  conductorSlackDraftCommand,
  conductorSlackPostedCommand,
  conductorStatusCommand,
  conductorTickCommand,
  conductorWaitCommand,
  conductorWorkerReportCommand,
} from '../../../src/cli/commands/conductor.js';
import { ConductorStore, EVENTS_FILE } from '../../../src/conductor/store.js';
import { hostSlackClient } from '../../../src/conductor/adapters.js';
import { publishApprovedSlack } from '../../../src/conductor/slack.js';
import { orderHasPendingSlack } from '../../../src/conductor/slack-state.js';
import type { HostAction } from '../../../src/conductor/launcher.js';
import { registerSession } from '../../../src/conductor/handoff.js';
import { touchSessionTick } from '../../../src/conductor/session-owner.js';
import { claimWaitOwner } from '../../../src/conductor/wait.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

let out: string[] = [];
let err: string[] = [];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((v: unknown) => void out.push(String(v)));
  vi.spyOn(console, 'error').mockImplementation((v: unknown) => void err.push(String(v)));
  vi.spyOn(process, 'exit').mockImplementation(((code: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanupStateDirs();
});

const last = () => JSON.parse(out.at(-1)!) as Record<string, unknown>;

describe('gestalt conductor', () => {
  it('주문을 받고 같은 출처는 한 번만 받으며 상태를 짧게 보여준다', () => {
    const stateDir = tempStateDir();
    const add = {
      stateDir,
      json: true,
      repo: 'acme/app',
      title: '배너 고치기',
      source: 'jira',
      sourceRef: 'jira:APP-1',
    };
    conductorOrderAddCommand({
      ...add,
      issueKey: 'APP-1',
      issueType: 'bug',
      scope: 'merge-through',
    });
    expect(last()['created']).toBe(true);
    conductorOrderAddCommand(add);
    expect(last()['created']).toBe(false);

    conductorStatusCommand({ stateDir, json: true });
    expect(last()['orders']).toEqual([
      expect.objectContaining({ status: 'queued', scope: 'merge-through', issue: 'APP-1' }),
    ]);
  });

  it('배포 주문은 대상 주문 id를 받아 order show와 status에 싣고 틀린 대상은 거절한다', () => {
    const stateDir = tempStateDir();
    conductorOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: 'a' });
    const a = (last()['order'] as { id: string }).id;
    conductorOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: 'b' });
    const b = (last()['order'] as { id: string }).id;

    conductorOrderAddCommand({
      stateDir,
      json: true,
      repo: 'acme/app',
      title: 'dev 배포',
      deploys: [`${a},${b}`],
    });
    const deployId = (last()['order'] as { id: string }).id;
    conductorOrderShowCommand(deployId, { stateDir, json: true });
    expect((last()['order'] as { deploys: string[] }).deploys).toEqual([a, b]);
    conductorStatusCommand({ stateDir, json: true });
    expect(last()['orders']).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: deployId, deploys: [a, b] })]),
    );

    expect(() =>
      conductorOrderAddCommand({
        stateDir,
        repo: 'acme/web',
        title: 'web 배포',
        deploys: [a],
      }),
    ).toThrow('exit 1');
    expect(err.join('\n')).toContain('acme/app 주문이라 acme/web 배포에 못 넣어요');
  });

  it('bypass로 넘긴 일을 주문별로 보여주고 --all이면 끝난 주문도 싣는다', () => {
    const stateDir = tempStateDir();
    conductorOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: '배너 고치기' });
    const orderId = (last()['order'] as { id: string }).id;
    const store = ConductorStore.open(stateDir);
    const record = {
      orderId,
      need: 'cleanup' as const,
      action: '워크트리를 지웠어요',
      at: '2026-01-01T00:00:00.000Z',
    };
    store.append({ type: 'bypass', at: record.at, record });
    store.append({
      type: 'bypass',
      at: record.at,
      record: { need: 'account-switch', action: 'work 계정으로 바꿨어요', at: record.at },
    });
    store.updateOrder(orderId, { status: 'done' });

    conductorStatusCommand({ stateDir, json: true });
    expect(last()['orders']).toEqual([]);
    expect(last()['unassignedBypasses']).toEqual([
      expect.objectContaining({ need: 'account-switch' }),
    ]);

    conductorStatusCommand({ stateDir, json: true, all: true });
    expect(last()['orders']).toEqual([
      expect.objectContaining({
        id: orderId,
        status: 'done',
        bypasses: [{ need: 'cleanup', action: '워크트리를 지웠어요', at: record.at }],
      }),
    ]);

    conductorStatusCommand({ stateDir, all: true });
    expect(out.join('\n')).toContain(
      '  bypass 2026-01-01T00:00:00.000Z  cleanup  워크트리를 지웠어요',
    );
  });

  it('status JSON은 배포 신호를 기다리는 merged 주문에만 awaitingDeploy를 켠다', () => {
    const stateDir = tempStateDir();
    const add = (title: string) => {
      conductorOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title });
      return (last()['order'] as { id: string }).id;
    };
    const bug = add('버그');
    const subTask = add('하위 작업');
    const deployed = add('배포 끝난 버그');
    const running = add('진행 중인 버그');
    const store = ConductorStore.open(stateDir);
    store.updateOrder(bug, { status: 'merged', issueKey: 'APP-1', issueType: 'sub-bug' });
    store.updateOrder(subTask, { status: 'merged', issueKey: 'APP-2', issueType: 'sub-task' });
    store.updateOrder(deployed, {
      status: 'merged',
      issueKey: 'APP-3',
      issueType: 'bug',
      deployedAt: '2026-01-01T00:00:00.000Z',
    });
    store.updateOrder(running, { status: 'running', issueKey: 'APP-4', issueType: 'bug' });

    conductorStatusCommand({ stateDir, json: true });
    const flags = Object.fromEntries(
      (last()['orders'] as Record<string, unknown>[]).map((o) => [o['id'], o['awaitingDeploy']]),
    );
    expect(flags).toEqual({ [bug]: true, [subTask]: false, [deployed]: false, [running]: false });
  });

  it('status JSON에 저장소 경로와 워커 워크트리를 찾을 값을 싣는다', () => {
    const stateDir = tempStateDir();
    conductorOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: '배너 고치기' });
    const orcaOrder = (last()['order'] as { id: string }).id;
    conductorOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: '버튼 고치기' });
    const subOrder = (last()['order'] as { id: string }).id;
    const store = ConductorStore.open(stateDir);
    const ow = worker(orcaOrder, { kind: 'orca-worktree', attempt: 2, handle: 'ctx_1' });
    store.startWorker(ow);
    store.updateOrder(orcaOrder, { status: 'running', workerId: ow.id });
    const sw = worker(subOrder);
    store.startWorker(sw);
    store.updateOrder(subOrder, { status: 'running', workerId: sw.id });

    conductorStatusCommand({ stateDir, json: true });
    const status = last();
    expect(status['stateDir']).toBe(resolve(stateDir));
    const orders = status['orders'] as Record<string, unknown>[];
    expect(orders.find((o) => o['id'] === orcaOrder)).toMatchObject({
      worker: ow.id,
      workerKind: 'orca-worktree',
      workerStatus: 'running',
      workerHandle: 'ctx_1',
      worktreeName: `${orcaOrder}-2`,
      updatedAt: expect.any(String),
    });
    const sub = orders.find((o) => o['id'] === subOrder)!;
    expect(sub).toMatchObject({ workerKind: 'subagent' });
    expect(sub).not.toHaveProperty('worktreeName');
    expect(sub).not.toHaveProperty('parentOrderId');
  });

  it('status JSON에 하위 주문과 부모 워크트리, 기준 브랜치를 싣는다', () => {
    const stateDir = tempStateDir();
    conductorOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: '표 고치기' });
    const parent = (last()['order'] as { id: string }).id;
    conductorOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: '타입 정리' });
    const child = (last()['order'] as { id: string }).id;
    const store = ConductorStore.open(stateDir);
    store.updateOrder(parent, { parentWorktree: '/w/feat', baseBranch: 'feat/table' });
    store.updateOrder(child, { parentOrderId: parent });

    conductorStatusCommand({ stateDir, json: true });
    const orders = last()['orders'] as Record<string, unknown>[];
    expect(orders.find((o) => o['id'] === parent)).toMatchObject({
      parentWorktree: '/w/feat',
      baseBranch: 'feat/table',
    });
    expect(orders.find((o) => o['id'] === parent)).not.toHaveProperty('parentOrderId');
    expect(orders.find((o) => o['id'] === child)).toMatchObject({ parentOrderId: parent });
  });

  it('status JSON에 스킬 체인과 체크포인트, 워커 대기, 최근 이벤트를 싣는다', () => {
    const stateDir = tempStateDir();
    const store = ConductorStore.open(stateDir);
    const o = order({ skillChain: ['interview', 'spec', 'ship', 'merge'], status: 'running' });
    store.addOrder(o);
    const w = worker(o.id, {
      kind: 'orca-worktree',
      account: 'work',
      rateLimitedAt: '2026-11-01T01:00:00.000Z',
      rateLimitResetsAt: '2026-11-01T05:00:00.000Z',
      waiting: { reason: 'CI 대기', since: '2026-11-01T00:30:00.000Z' },
    });
    store.startWorker(w);
    store.updateOrder(o.id, { workerId: w.id });
    store.saveCheckpoint({
      orderId: o.id,
      workerId: w.id,
      skill: 'ship',
      phase: 'copilot',
      round: 2,
      next: 'Copilot 코멘트 3개 반영',
      completedSkills: ['interview', 'spec'],
      shipDir: '/tmp/ship',
      refs: ['/tmp/plan.md'],
      savedAt: '2026-11-01T00:20:00.000Z',
    });
    store.append({
      type: 'report-applied',
      at: '2026-11-01T00:30:00.000Z',
      name: 'r1.json',
      report: {
        workerId: w.id,
        status: 'waiting',
        summary: '기다려요',
        refs: [],
        wait: { reason: 'CI 대기' },
      },
    });
    store.append({
      type: 'bypass',
      at: '2026-11-01T00:31:00.000Z',
      record: {
        orderId: o.id,
        need: 'cleanup',
        action: '로컬 리뷰 생략',
        at: '2026-11-01T00:31:00.000Z',
      },
    });
    store.openGate({
      id: 'gate-1',
      orderId: o.id,
      type: 'merge',
      status: 'open',
      reason: '<b>머지</b> 승인',
      refs: [],
      openedAt: '2026-11-01T00:32:00.000Z',
    });

    conductorStatusCommand({ stateDir, json: true });
    const status = last();
    const row = (status['orders'] as Record<string, unknown>[])[0]!;
    expect(row).toMatchObject({
      skillChain: ['interview', 'spec', 'ship', 'merge'],
      checkpoint: {
        skill: 'ship',
        phase: 'copilot',
        round: 2,
        next: 'Copilot 코멘트 3개 반영',
        completedSkills: ['interview', 'spec'],
      },
      waiting: { reason: 'CI 대기', since: '2026-11-01T00:30:00.000Z' },
      account: 'work',
      rateLimitedAt: '2026-11-01T01:00:00.000Z',
      rateLimitResetsAt: '2026-11-01T05:00:00.000Z',
    });
    expect(row['checkpoint']).not.toHaveProperty('refs');
    expect(row['checkpoint']).not.toHaveProperty('shipDir');
    expect(status['recentEvents']).toEqual([
      { at: expect.any(String), type: 'checkpoint', orderId: o.id, summary: 'ship → copilot r2' },
      { at: '2026-11-01T00:30:00.000Z', type: 'waiting', orderId: o.id, summary: 'CI 대기' },
      {
        at: '2026-11-01T00:31:00.000Z',
        type: 'bypass',
        orderId: o.id,
        summary: 'cleanup · 로컬 리뷰 생략',
      },
      {
        at: expect.any(String),
        type: 'gate-opened',
        orderId: o.id,
        summary: 'merge · <b>머지</b> 승인',
      },
    ]);
    expect(status['conductor']).toMatchObject({
      maxWorkers: expect.any(Number),
      pollIntervalSec: expect.any(Number),
      activeWorkers: 1,
      queuedOrders: 0,
      prWatchRepos: expect.any(Array),
      disconnectedWorkers: 0,
    });
    expect(status['conductor']).not.toHaveProperty('compactions');
    expect(status['conductor']).not.toHaveProperty('session');
  });

  it('대기 이벤트는 기한을 문장에 굳히지 않고 주문의 waiting.until과 같은 ISO로 싣는다', () => {
    const stateDir = tempStateDir();
    const store = ConductorStore.open(stateDir);
    const o = order({ status: 'running' });
    store.addOrder(o);
    const until = '2026-11-01T02:10:00.000Z';
    const w = worker(o.id, {
      waiting: { reason: 'CI 대기', since: '2026-11-01T01:51:00.000Z', until },
    });
    store.startWorker(w);
    store.updateOrder(o.id, { workerId: w.id });
    store.append({
      type: 'report-applied',
      at: '2026-11-01T01:51:00.000Z',
      name: 'r1.json',
      report: {
        workerId: w.id,
        status: 'waiting',
        summary: '기다려요',
        refs: [],
        wait: { reason: 'CI 대기', until },
      },
    });

    conductorStatusCommand({ stateDir, json: true });
    const status = last();
    const row = (status['orders'] as Record<string, unknown>[])[0]!;
    const [event] = status['recentEvents'] as Record<string, unknown>[];
    expect(event).toEqual({
      at: '2026-11-01T01:51:00.000Z',
      type: 'waiting',
      orderId: o.id,
      summary: 'CI 대기',
      until,
    });
    expect(event!['until']).toBe((row['waiting'] as { until: string }).until);
    expect(event!['summary']).not.toMatch(/\d\d:\d\d/);
  });

  it('status JSON은 끊긴 워커와 살아 있는 컨덕터 세션의 컴팩트 횟수를 싣고 지운 주문의 이벤트는 뺀다', () => {
    const stateDir = tempStateDir();
    const store = ConductorStore.open(stateDir);
    const o = order({ status: 'running' });
    store.addOrder(o);
    const w = worker(o.id, { status: 'stopped', stopReason: 'disconnected' });
    store.startWorker(w);
    store.updateOrder(o.id, { workerId: w.id });
    const gone = order({ status: 'done' });
    store.addOrder(gone);
    store.append({
      type: 'bypass',
      at: '2026-11-01T00:31:00.000Z',
      record: {
        orderId: gone.id,
        need: 'cleanup',
        action: '지운 주문',
        at: '2026-11-01T00:31:00.000Z',
      },
    });
    store.removeOrder(gone.id);
    const sid = 'session-abc';
    registerSession(stateDir, sid, '/w', new Date());
    touchSessionTick(stateDir, sid, new Date());
    writeFileSync(join(stateDir, 'sessions', sid, 'compactions'), '1\n');

    conductorStatusCommand({ stateDir, json: true });
    const status = last();
    expect(status['conductor']).toMatchObject({
      disconnectedWorkers: 1,
      compactions: 1,
      session: { id: sid, cwd: '/w' },
    });
    expect(status['recentEvents']).toEqual([]);
  });

  it('잘못된 값은 stderr와 exit 1로 끝낸다', () => {
    const stateDir = tempStateDir();
    expect(() =>
      conductorOrderAddCommand({ stateDir, repo: 'acme/app', title: 'x', scope: 'yolo' }),
    ).toThrow('exit 1');
    expect(err[0]).toContain('--scope');
    expect(() =>
      conductorDeployReportCommand({ stateDir, order: 'ord-none', status: 'success' }),
    ).toThrow('exit 1');
  });

  it('워커는 체크포인트와 결과를 남기고 원문 섞인 결과는 거절된다', () => {
    const stateDir = tempStateDir();
    conductorOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: 'x' });
    const orderId = (last()['order'] as { id: string }).id;
    const store = ConductorStore.open(stateDir);
    const w = worker(orderId);
    store.startWorker(w);
    store.updateOrder(orderId, { status: 'running', workerId: w.id });

    conductorCheckpointSaveCommand({
      stateDir,
      json: true,
      worker: w.id,
      skill: 'solve',
      next: '스펙 확인',
      done: '',
    });
    expect(last()).toMatchObject({ skill: 'solve', next: '스펙 확인' });

    conductorWorkerReportCommand({
      stateDir,
      json: true,
      worker: w.id,
      status: 'progress',
      summary: '진행 중',
      ref: ['a.md'],
    });
    expect(String(last()['queued'])).toMatch(/\.json$/);
    expect(() =>
      conductorWorkerReportCommand({
        stateDir,
        worker: w.id,
        status: 'done',
        summary: '```\nlog\n```',
      }),
    ).toThrow('exit 1');
  });

  it('워커 세션은 다른 워커 이름으로 보고나 체크포인트를 남기지 못한다', () => {
    const stateDir = tempStateDir();
    conductorOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: 'x' });
    const orderId = (last()['order'] as { id: string }).id;
    const store = ConductorStore.open(stateDir);
    const w = worker(orderId);
    store.startWorker(w);
    store.updateOrder(orderId, { status: 'running', workerId: w.id });

    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', 'wrk-other');
    try {
      expect(() =>
        conductorWorkerReportCommand({ stateDir, worker: w.id, status: 'progress', summary: 'x' }),
      ).toThrow('exit 1');
      expect(err.at(-1)).toContain('wrk-other');
      expect(() =>
        conductorCheckpointSaveCommand({ stateDir, worker: w.id, skill: 'solve', next: 'x' }),
      ).toThrow('exit 1');
      expect(ConductorStore.open(stateDir).snapshot.checkpoints[orderId]).toBeUndefined();

      vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', w.id);
      conductorCheckpointSaveCommand({
        stateDir,
        json: true,
        worker: w.id,
        skill: 'solve',
        next: 'x',
      });
      expect(last()).toMatchObject({ skill: 'solve' });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('끝난 주문만 지우고 못 지운 주문은 이유와 함께 돌려준다', async () => {
    const stateDir = tempStateDir();
    const add = (title: string, sourceRef: string) => {
      conductorOrderAddCommand({
        stateDir,
        json: true,
        repo: 'acme/app',
        title,
        source: 'jira',
        sourceRef,
      });
      return (last()['order'] as { id: string }).id;
    };
    const done = add('끝난 일', 'jira:APP-1');
    const queued = add('남은 일', 'jira:APP-2');
    const store = ConductorStore.open(stateDir);
    store.updateOrder(done, { status: 'done' });

    await conductorOrderRemoveCommand([done, queued, done], { stateDir, json: true });
    expect(last()).toEqual({
      removed: [done],
      skipped: [{ id: queued, reason: expect.stringContaining('끝난 주문만') }],
    });

    conductorStatusCommand({ stateDir, json: true, all: true });
    expect((last()['orders'] as { id: string }[]).map((o) => o.id)).toEqual([queued]);

    conductorOrderAddCommand({
      stateDir,
      json: true,
      repo: 'acme/app',
      title: '끝난 일',
      source: 'jira',
      sourceRef: 'jira:APP-1',
    });
    expect(last()).toMatchObject({ created: false, removedAt: expect.any(String) });

    out = [];
    err = [];
    await expect(conductorOrderRemoveCommand([queued], { stateDir })).rejects.toThrow('exit 1');
    // 전부 못 지우면 이유는 stderr로 한 번만 나간다
    expect(out).toEqual([]);
    expect(err.join('\n').match(/끝난 주문만/g)).toHaveLength(1);

    store.reload();
    store.updateOrder(queued, { status: 'done' });
    writeFileSync(join(stateDir, 'tick.lock'), `${process.pid}:${Date.now()}:${hostname()}:x`);
    await expect(conductorOrderRemoveCommand([queued], { stateDir })).rejects.toThrow('exit 1');
    expect(err.join('\n')).toContain('tick이 도는 중');
    expect(ConductorStore.open(stateDir).order(queued)).toBeDefined();
  });

  it('지운 주문의 refs 사본도 지우고 refs가 저장소 밖 심링크면 경고만 낸다', async () => {
    const stateDir = tempStateDir();
    const add = (title: string) => {
      conductorOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title });
      return (last()['order'] as { id: string }).id;
    };
    const first = add('첫 일');
    const second = add('둘째 일');
    const store = ConductorStore.open(stateDir);
    store.updateOrder(first, { status: 'done' });
    store.updateOrder(second, { status: 'done' });
    mkdirSync(join(stateDir, 'refs', first), { recursive: true });
    writeFileSync(join(stateDir, 'refs', first, 'a.md'), 'x');

    await conductorOrderRemoveCommand([first], { stateDir, json: true });
    expect(last()).toEqual({ removed: [first], skipped: [] });
    expect(existsSync(join(stateDir, 'refs', first))).toBe(false);

    const outside = resolve(tempStateDir());
    mkdirSync(join(outside, second));
    rmSync(join(stateDir, 'refs'), { recursive: true });
    symlinkSync(outside, join(stateDir, 'refs'));
    await conductorOrderRemoveCommand([second], { stateDir, json: true });
    expect(last()).toEqual({
      removed: [second],
      skipped: [],
      warnings: [expect.stringContaining('디렉토리가 아니라')],
    });
    expect(existsSync(join(outside, second))).toBe(true);
  });

  it('슬랙 초안은 게이트로 올라가고 resolve로 닫힌다', async () => {
    const stateDir = tempStateDir();
    const textFile = join(stateDir, 'draft.txt');
    writeFileSync(textFile, '배포 끝났어요~');
    conductorSlackDraftCommand({ stateDir, json: true, channel: 'C123', textFile });
    const gateId = String(last()['gateId']);

    conductorGateListCommand({ stateDir, json: true });
    expect(JSON.parse(out.at(-1)!)).toEqual([
      expect.objectContaining({ id: gateId, type: 'slack-post' }),
    ]);

    await conductorGateResolveCommand(gateId, { stateDir, json: true, approve: true });
    expect((last()['gate'] as { decision: string }).decision).toBe('approved');
    await expect(conductorGateResolveCommand(gateId, { stateDir, approve: true })).rejects.toThrow(
      'exit 1',
    );
    expect(err.at(-1)).toContain('이미 종료된');
  });

  it('중단 뒤 Slack 인계를 찾고 같은 작업의 게시 결과만 한 번 기록한다', async () => {
    const stateDir = tempStateDir();
    const textFile = join(stateDir, 'draft.txt');
    const store = ConductorStore.open(stateDir);
    store.addOrder(order({ id: 'ord-slack', status: 'done' }));
    writeFileSync(textFile, '게시할 본문');
    conductorSlackDraftCommand({
      stateDir,
      json: true,
      order: 'ord-slack',
      channel: 'C123',
      textFile,
    });
    const gateId = String(last()['gateId']);
    await conductorGateResolveCommand(gateId, { stateDir, approve: true });
    const actions: HostAction[] = [];
    const client = hostSlackClient(actions);
    store.reload();
    await publishApprovedSlack(store, client);
    const action = actions[0];
    if (action?.type !== 'slack-post') throw new Error('Slack 인계가 없어요');
    expect(action).toMatchObject({ gateId, orderId: 'ord-slack', channel: 'C123' });

    const restarted = ConductorStore.open(stateDir);
    expect((await publishApprovedSlack(restarted, client)).posted).toEqual([]);
    expect(actions).toHaveLength(1);
    await conductorSlackDeliveryCommand(gateId, { stateDir });
    expect(last()).toEqual({
      gateId,
      orderId: 'ord-slack',
      channel: 'C123',
      text: '게시할 본문',
      deliveryId: action.deliveryId,
      metadata: action.metadata,
      pendingReason: expect.stringContaining('증빙을 기다리고'),
    });
    const resultFile = join(stateDir, 'result.json');
    const opts = { stateDir, json: true, resultFile };
    const response = {
      ok: true,
      channel: 'C123',
      ts: '12345.000001',
      message: { ts: '12345.000001', metadata: action.metadata },
    };
    const confirm = (id: string, result: unknown) => {
      writeFileSync(resultFile, JSON.stringify(result));
      return conductorSlackPostedCommand(id, opts);
    };
    expect(last()['metadata']).toEqual(action.metadata);
    await expect(
      confirm(gateId, {
        ...response,
        message: {
          ...response.message,
          metadata: { ...action.metadata, event_payload: { delivery_id: 'different' } },
        },
      }),
    ).rejects.toThrow('exit 1');
    expect(err.at(-1)).toContain('식별자가 달라');
    await expect(
      confirm(gateId, 'https://example.slack.com/archives/C999/p12345000001'),
    ).rejects.toThrow('exit 1');
    await expect(confirm(gateId, { ...response, channel: 'C999' })).rejects.toThrow('exit 1');
    expect(err.at(-1)).toContain('채널이나 스레드가');
    await expect(confirm(gateId, { ...response, message: { ts: response.ts } })).rejects.toThrow(
      'exit 1',
    );
    expect(orderHasPendingSlack(ConductorStore.open(stateDir).snapshot, 'ord-slack')).toBe(true);
    expect(ConductorStore.open(stateDir).snapshot.slackPosted[gateId]).toBe('host');
    await confirm(gateId, response);
    expect(last()).toMatchObject({ gateId, recorded: true, ref: response.ts });
    await confirm(gateId, response);
    expect(last()).toMatchObject({ gateId, recorded: false });

    store.reload();
    expect(store.snapshot.slackPosted[gateId]).toBe(response.ts);
    expect(orderHasPendingSlack(store.snapshot, 'ord-slack')).toBe(false);
    store.removeOrder('ord-slack');
    store.addOrder(order({ id: 'ord-new-slack', status: 'done' }));
    writeFileSync(textFile, '다음 주문의 본문');
    conductorSlackDraftCommand({
      stateDir,
      json: true,
      order: 'ord-new-slack',
      channel: 'C123',
      textFile,
    });
    const nextGateId = String(last()['gateId']);
    await conductorGateResolveCommand(nextGateId, { stateDir, approve: true });
    store.reload();
    await publishApprovedSlack(store, client);
    const next = actions[1];
    if (next?.type !== 'slack-post') throw new Error('다음 Slack 인계가 없어요');
    await expect(confirm(nextGateId, response)).rejects.toThrow('exit 1');
    expect(err.at(-1)).toContain('식별자가 달라');
    await expect(
      confirm(nextGateId, {
        ...response,
        message: { ...response.message, metadata: next.metadata },
      }),
    ).rejects.toThrow('exit 1');
    expect(err.at(-1)).toContain('다른 Slack 게시 작업');
    appendFileSync(
      join(stateDir, EVENTS_FILE),
      JSON.stringify({
        type: 'slack-publication-confirmed',
        at: store.timestamp(),
        gateId: nextGateId,
        evidence: { deliveryId: next.deliveryId, channel: response.channel, ts: response.ts },
      }) + '\n',
    );
    const replayed = ConductorStore.open(stateDir);
    expect(replayed.snapshot.slackMessageClaims['C123:12345.000001']).toMatchObject({ gateId });
    expect(replayed.snapshot.slackPosted[nextGateId]).toBe('host');
    expect(orderHasPendingSlack(replayed.snapshot, 'ord-new-slack')).toBe(true);
    const receipts = readFileSync(join(stateDir, EVENTS_FILE), 'utf8').match(
      new RegExp(`"gateId":"${gateId}","evidence"`, 'g'),
    );
    expect(receipts).toHaveLength(1);
  });

  it('주문의 --pr과 --skills, --issue-key는 꼴이 틀리면 받지 않는다', () => {
    const stateDir = tempStateDir();
    const add = { stateDir, json: true, repo: 'acme/app', title: 'x' };
    expect(() => conductorOrderAddCommand({ ...add, pr: 'acme/app#1; rm -rf' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('--pr');
    expect(() => conductorOrderAddCommand({ ...add, skills: 'solve,nope' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('nope');
    expect(() => conductorOrderAddCommand({ ...add, issueKey: 'app-1' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('--issue-key');
    expect(() =>
      conductorOrderAddCommand({ ...add, parentWorktree: resolve(stateDir, 'no-such-worktree') }),
    ).toThrow('exit 1');
    expect(err.at(-1)).toContain('부모 워크트리');
    expect(() => conductorOrderAddCommand({ ...add, baseBranch: '--upload-pack=x' })).toThrow(
      'exit 1',
    );
    expect(err.at(-1)).toContain('기준 브랜치');
    expect(ConductorStore.open(stateDir).orders()).toEqual([]);

    conductorOrderAddCommand({
      ...add,
      pr: 'https://github.com/acme/app/pull/12',
      skills: 'review',
    });
    expect(last()['order']).toMatchObject({ prRef: 'acme/app#12', skillChain: ['review'] });
  });

  it('--skills는 repoPaths의 레포에 있는 repo:<이름> 스킬만 받는다', () => {
    const home = mkdtempSync(join(tmpdir(), 'gestalt-conductor-home-'));
    const repoDir = join(home, 'app');
    mkdirSync(join(repoDir, '.claude', 'skills', 'release'), { recursive: true });
    writeFileSync(join(repoDir, '.claude', 'skills', 'release', 'SKILL.md'), '# release\n');
    mkdirSync(join(home, '.gestalt'), { recursive: true });
    writeFileSync(
      join(home, '.gestalt', 'conductor.json'),
      JSON.stringify({ repoPaths: { 'acme/app': repoDir } }),
    );
    vi.stubEnv('GESTALT_HOME', home);
    try {
      const stateDir = tempStateDir();
      const add = { stateDir, json: true, repo: 'acme/app', title: '릴리즈' };
      conductorOrderAddCommand({ ...add, skills: 'repo:release' });
      expect(last()['order']).toMatchObject({ skillChain: ['repo:release'] });

      expect(() => conductorOrderAddCommand({ ...add, skills: 'repo:deploy' })).toThrow('exit 1');
      expect(err.at(-1)).toContain('repo:deploy 스킬이 없어요');
      expect(() => conductorOrderAddCommand({ ...add, skills: 'repo:../app' })).toThrow('exit 1');
      expect(err.at(-1)).toContain('레포 스킬 이름은');
      expect(() =>
        conductorOrderAddCommand({ ...add, repo: 'acme/web', skills: 'repo:release' }),
      ).toThrow('exit 1');
      expect(err.at(-1)).toContain('repoPaths');
      expect(() => conductorOrderAddCommand({ ...add, skills: 'release' })).toThrow('exit 1');
      expect(err.at(-1)).toContain('repo:<이름>');
      expect(ConductorStore.open(stateDir).orders()).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('워커 환경이나 워커 워크트리 안에서는 컨덕터 전용 명령을 거절한다', () => {
    // cwd를 바꿔 끼우므로 상대 경로가 그 cwd 기준으로 풀리지 않게 절대 경로로 둔다
    const stateDir = resolve(tempStateDir());
    const add = { stateDir, json: true, repo: 'acme/app', title: 'x' };
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', 'wrk-1');
    try {
      expect(() => conductorOrderAddCommand(add)).toThrow('exit 1');
    } finally {
      vi.unstubAllEnvs();
    }

    conductorOrderAddCommand(add);
    const orderId = (last()['order'] as { id: string }).id;
    const wt = join(stateDir, 'wt', orderId);
    mkdirSync(wt, { recursive: true });
    ConductorStore.open(stateDir).startWorker(
      worker(orderId, { id: 'wrk-g', kind: 'git-worktree', handle: wt }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(wt);
    expect(() => conductorOrderAddCommand({ ...add, title: 'y' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('wrk-g');
  });

  it('긴 주문 설명은 파일로 받아 자르지 않고 공통 맥락 경로는 상태 저장소 아래로 알려 준다', () => {
    const stateDir = tempStateDir();
    const descriptionFile = join(stateDir, 'desc.md');
    const long = Array.from({ length: 500 }, (_, i) => `- 결정 ${i}: "인용"과 \`백틱\``).join('\n');
    writeFileSync(descriptionFile, `${long}\n`);
    conductorOrderAddCommand({
      stateDir,
      json: true,
      repo: 'acme/app',
      title: 't',
      descriptionFile,
    });
    expect((last()['order'] as { description: string }).description).toBe(long);
    expect(() =>
      conductorOrderAddCommand({
        stateDir,
        repo: 'acme/app',
        title: 't',
        description: 'a',
        descriptionFile,
      }),
    ).toThrow('exit 1');

    conductorContextPathCommand({ stateDir, json: true, repo: 'acme/app' });
    expect(last()).toEqual({
      repo: 'acme/app',
      path: join(resolve(stateDir), 'context', 'acme', 'app.md'),
      exists: false,
    });
    expect(existsSync(join(stateDir, 'context', 'acme'))).toBe(true);
    expect(() => conductorContextPathCommand({ stateDir, repo: '../x' })).toThrow('exit 1');

    mkdirSync(join(stateDir, 'context', 'acme', 'dir.md'));
    conductorContextPathCommand({ stateDir, json: true, repo: 'acme/dir' });
    expect(last()['exists']).toBe(false);
  });

  it('설명 파일이 비었거나 64KB를 넘거나 일반 파일이 아니면 주문을 안 받는다', () => {
    const stateDir = tempStateDir();
    const add = (descriptionFile: string) => () =>
      conductorOrderAddCommand({ stateDir, repo: 'acme/app', title: 't', descriptionFile });
    const empty = join(stateDir, 'empty.md');
    writeFileSync(empty, '  \n');
    expect(add(empty)).toThrow('exit 1');
    expect(err.join('\n')).toContain('비어 있어요');

    const big = join(stateDir, 'big.md');
    writeFileSync(big, 'a'.repeat(64 * 1024 + 1));
    expect(add(big)).toThrow('exit 1');
    expect(err.join('\n')).toContain('64KB를 넘어요');

    expect(add(stateDir)).toThrow('exit 1');
    expect(err.join('\n')).toContain('일반 파일이 아니에요');
    expect(add(join(stateDir, 'none.md'))).toThrow('exit 1');
    expect(err.join('\n')).toContain('찾을 수 없어요');
  });

  it('queue add는 파일로 넣고 워커 세션이나 JSON이 아닌 본문은 거절한다', () => {
    const stateDir = tempStateDir();
    const bodyFile = join(stateDir, 'body.json');
    writeFileSync(bodyFile, JSON.stringify({ repo: 'acme/app', title: '배너 교체' }));
    conductorQueueAddCommand({ stateDir, json: true, bodyFile, id: 'm1' });
    expect(last()).toEqual({ id: 'm1', sourceRef: 'queue:m1' });
    expect(readdirSync(join(stateDir, 'queue'))).toEqual(['m1.json']);

    writeFileSync(bodyFile, '{"repo": ');
    expect(() => conductorQueueAddCommand({ stateDir, bodyFile })).toThrow('exit 1');
    expect(err.at(-1)).toContain('JSON이 아니에요');

    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', 'wrk-1');
    try {
      expect(() => conductorQueueAddCommand({ stateDir, bodyFile, id: 'm2' })).toThrow('exit 1');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(existsSync(join(stateDir, 'queue', 'm2.json'))).toBe(false);
  });

  it('tick은 큐를 읽어 꼴이 틀린 본문은 게이트로 올리고 못 읽는 파일은 오류로 알린다', async () => {
    const stateDir = tempStateDir();
    const dir = join(stateDir, 'queue');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'no-title.json'), JSON.stringify({ repo: 'acme/app' }));
    writeFileSync(join(dir, 'broken.json'), '{"repo"');

    await conductorTickCommand({ stateDir, json: true, force: true, queue: false });
    expect(readdirSync(dir).sort()).toEqual(['broken.json', 'no-title.json']);

    await conductorTickCommand({ stateDir, json: true, force: true });
    const report = last() as { counts: { openGates: number }; errors: string[] };
    expect(report.counts.openGates).toBe(1);
    expect(report.errors.some((e) => e.includes('broken.json'))).toBe(true);
    expect(readdirSync(dir)).toEqual(['failed']);
  });

  it('wait는 할 일 없는 tick엔 아무것도 출력하지 않다가 게이트가 열린 tick에서 그 게이트를 내고 끝난다', async () => {
    const stateDir = tempStateDir();
    const queueDir = join(stateDir, 'queue');
    let sleeps = 0;
    const outDuringIdle: number[] = [];
    await conductorWaitCommand(
      { stateDir, json: true, maxWaitSec: 1500, prWatch: false },
      {
        sleep: async () => {
          if (sleeps > 5) throw new Error('게이트가 열렸는데 wait가 안 끝났어요');
          outDuringIdle.push(out.length);
          // 두 번 할 일 없이 돈 뒤에 꼴이 틀린 주문이 들어온다
          if (++sleeps === 2) {
            mkdirSync(queueDir, { recursive: true });
            writeFileSync(join(queueDir, 'no-title.json'), JSON.stringify({ repo: 'acme/app' }));
          }
        },
      },
    );
    expect(outDuringIdle).toEqual([0, 0]);
    const r = last() as {
      reason: string;
      reasons: string[];
      ticks: number;
      tick: { counts: { openGates: number } };
    };
    expect(r.reason).toBe('attention');
    expect(r.reasons).toEqual(['gatesOpened']);
    expect(r.ticks).toBe(3);
    expect(r.tick.counts.openGates).toBe(1);
    expect(existsSync(join(stateDir, 'wait-last.json'))).toBe(true);
    // 표식은 끝날 때 지우지 않고 다음 wait가 덮어쓴다
    expect(existsSync(join(stateDir, 'wait.owner'))).toBe(true);
  });

  it('wait는 상한 시간이 지나면 할 일이 없어도 한 줄만 내고 끝난다', async () => {
    const stateDir = tempStateDir();
    let t = 0;
    await conductorWaitCommand(
      { stateDir, maxWaitSec: 120, prWatch: false },
      { now: () => t, sleep: async (ms) => void (t += ms) },
    );
    expect(out).toEqual(['할 일 없이 2분 지나 끝났어요(tick 3번). 다시 띄워 주세요']);
  });

  it('wait는 상한으로 끝나면 보고서 파일을 안 쓰고 JSON에도 경로를 안 싣는다', async () => {
    const stateDir = tempStateDir();
    let t = 0;
    await conductorWaitCommand(
      { stateDir, json: true, maxWaitSec: 60, prWatch: false },
      { now: () => t, sleep: async (ms) => void (t += ms) },
    );
    const r = last() as Record<string, unknown>;
    expect(r.reason).toBe('timeout');
    expect(r).not.toHaveProperty('reportFile');
    expect(r).not.toHaveProperty('tick');
    expect(existsSync(join(stateDir, 'wait-last.json'))).toBe(false);
  });

  it('wait는 사람이 읽는 출력에서 끝난 이유와 tick 결과를 내고 길면 파일 경로만 낸다', async () => {
    const stateDir = tempStateDir();
    const queueDir = join(stateDir, 'queue');
    mkdirSync(queueDir, { recursive: true });
    writeFileSync(join(queueDir, 'broken.json'), '{"repo"');
    await conductorWaitCommand({ stateDir, maxWaitSec: 60, prWatch: false });
    expect(out[0]).toMatch(/^할 일이 생겨 끝났어요: errors/);
    expect(out.some((l) => l.includes('broken.json'))).toBe(true);

    // 못 읽는 파일 이름이 오류 문장마다 실려 결과가 6000자를 넘는다
    out.length = 0;
    for (let i = 0; i < 40; i++)
      writeFileSync(join(queueDir, `${'x'.repeat(200)}-${i}.json`), '{"repo"');
    await conductorWaitCommand({ stateDir, maxWaitSec: 60, prWatch: false });
    expect(out.at(-1)).toMatch(/^결과가 길어 파일로 뒀어요: .*wait-last\.json$/);
    expect(existsSync(join(stateDir, 'wait-last.json'))).toBe(true);
  });

  it('wait는 다른 wait가 이어받으면 앞선 보고서와 본 목록을 건드리지 않고 끝난다', async () => {
    const stateDir = tempStateDir();
    const reportFile = join(stateDir, 'wait-last.json');
    writeFileSync(reportFile, '{"이어받은 wait":"보고서"}');
    let sleeps = 0;
    await conductorWaitCommand(
      { stateDir, json: true, maxWaitSec: 1500, queue: false, prWatch: false },
      {
        sleep: async () => {
          if (++sleeps > 1) throw new Error('표식을 뺏겼는데 tick을 더 돌렸어요');
          // 시작할 때 표식을 덮어쓰므로 도는 중에 바꿔야 이어받은 상황이 된다
          writeFileSync(join(stateDir, 'wait.owner'), 'other:token');
        },
      },
    );
    const r = last();
    expect(r.reason).toBe('superseded');
    expect(r).not.toHaveProperty('reportFile');
    expect(r).not.toHaveProperty('tick');
    expect(readFileSync(reportFile, 'utf-8')).toBe('{"이어받은 wait":"보고서"}');
    expect(existsSync(join(stateDir, 'wait-seen.json'))).toBe(false);
  });

  it('tick 도중 소유권이 바뀌면 새 wait만 결과를 한 번 받는다', async () => {
    const stateDir = tempStateDir();
    const queueDir = join(stateDir, 'queue');
    mkdirSync(queueDir);
    writeFileSync(join(queueDir, 'no-title.json'), JSON.stringify({ repo: 'acme/app' }));
    const store = ConductorStore.open(stateDir);
    store.addOrder(
      order({ id: 'ord-success', status: 'merged', issueKey: 'APP-7', issueType: 'bug' }),
    );
    store.addOrder(
      order({
        id: 'ord-expired',
        status: 'merged',
        issueKey: 'APP-8',
        issueType: 'bug',
        mergedAt: '2000-01-01T00:00:00Z',
      }),
    );
    conductorDeployReportCommand({ stateDir, order: 'ord-success', status: 'success' });
    const reportFile = join(stateDir, 'wait-last.json');
    writeFileSync(reportFile, '{"앞선":"보고서"}');
    const flushSnapshot = ConductorStore.prototype.flushSnapshot;
    vi.spyOn(ConductorStore.prototype, 'flushSnapshot').mockImplementationOnce(function (
      this: ConductorStore,
    ) {
      claimWaitOwner(stateDir, randomUUID());
      flushSnapshot.call(this);
    });

    await conductorWaitCommand({ stateDir, json: true, maxWaitSec: 60, prWatch: false });

    expect(ConductorStore.open(stateDir).openGates()).toHaveLength(1);
    expect(last()).toMatchObject({ reason: 'superseded', ticks: 1 });
    expect(last()).not.toHaveProperty('reportFile');
    expect(readFileSync(reportFile, 'utf-8')).toBe('{"앞선":"보고서"}');
    expect(existsSync(join(stateDir, 'wait-seen.json'))).toBe(false);
    const carryDir = join(stateDir, 'wait-carry');
    expect(readdirSync(carryDir)).toHaveLength(1);
    const seenFile = join(stateDir, 'wait-seen.json');
    writeFileSync(seenFile, JSON.stringify(['전에 본 경고']));

    await conductorWaitCommand({ stateDir, json: true, maxWaitSec: 1, prWatch: false });
    expect(last()).toMatchObject({
      reason: 'attention',
      reasons: ['hostActions', 'gatesOpened', 'warnings'],
      ticks: 0,
      tick: {
        counts: { openGates: 1 },
        hostActions: [{ type: 'jira-transition', issueKey: 'APP-7', to: 'In-QA' }],
        warnings: [expect.stringContaining('ord-expired')],
      },
    });
    expect(readdirSync(carryDir)).toEqual([]);
    expect(JSON.parse(readFileSync(seenFile, 'utf-8'))).toEqual([
      '전에 본 경고',
      expect.stringContaining('ord-expired'),
    ]);

    const idle = { json: true, stateDir, maxWaitSec: 1, prWatch: false };
    let clock = 0;
    await conductorWaitCommand(idle, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(last()).toMatchObject({ reason: 'timeout' });
    expect(last()).not.toHaveProperty('tick');
  });

  it('큰 넘김 결과의 경로는 다음 wait가 공용 보고서를 갱신해도 바뀌지 않는다', async () => {
    const stateDir = tempStateDir();
    const queueDir = join(stateDir, 'queue');
    mkdirSync(queueDir);
    for (let i = 0; i < 40; i++)
      writeFileSync(join(queueDir, `${'x'.repeat(200)}-${i}.json`), '{"repo"');
    const flushSnapshot = ConductorStore.prototype.flushSnapshot;
    vi.spyOn(ConductorStore.prototype, 'flushSnapshot').mockImplementationOnce(function (
      this: ConductorStore,
    ) {
      claimWaitOwner(stateDir, randomUUID());
      flushSnapshot.call(this);
    });
    const opts = { stateDir, json: true, maxWaitSec: 1, prWatch: false };
    await conductorWaitCommand(opts);
    expect(last()).toMatchObject({ reason: 'superseded' });
    await conductorWaitCommand(opts);
    expect(last()).toMatchObject({ reason: 'attention', ticks: 0 });
    expect(last()).not.toHaveProperty('tick');
    const carriedFile = last().reportFile as string;
    const carriedReport = readFileSync(carriedFile, 'utf-8');

    writeFileSync(join(queueDir, 'new.json'), '{"repo"');
    await conductorWaitCommand(opts);
    expect(last()).toMatchObject({ reason: 'attention', ticks: 1 });
    expect(last().reportFile).toBe(resolve(stateDir, 'wait-last.json'));
    expect(readFileSync(last().reportFile as string, 'utf-8')).not.toBe(carriedReport);
    expect(readFileSync(carriedFile, 'utf-8')).toBe(carriedReport);
  });

  it('wait가 도는 사이 인계하면 다음 tick에서 거절해 끝난다', async () => {
    const stateDir = tempStateDir();
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', randomUUID());
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', '');
    const notesFile = join(stateDir, 'notes.md');
    writeFileSync(notesFile, '- 대화에서 정한 규칙');
    let sleeps = 0;
    try {
      await expect(
        conductorWaitCommand(
          { stateDir, json: true, maxWaitSec: 1500, queue: false, prWatch: false },
          {
            sleep: async () => {
              if (++sleeps > 1) throw new Error('인계했는데 tick을 더 돌렸어요');
              await conductorHandoffCommand({ stateDir, json: true, notesFile, launch: false });
            },
          },
        ),
      ).rejects.toThrow('exit 1');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(sleeps).toBe(1);
    expect(err.at(-1)).toContain('인계했어요');
  });

  it('wait는 상한을 넘는 --max-wait-sec을 거절한다', async () => {
    const stateDir = tempStateDir();
    await expect(conductorWaitCommand({ stateDir, maxWaitSec: 1501 })).rejects.toThrow('exit 1');
    expect(err.at(-1)).toContain('1~1500');
  });

  it('wait는 워커 워크트리 안이면 거절한다', async () => {
    const stateDir = tempStateDir();
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', 'wrk-1');
    try {
      await expect(conductorWaitCommand({ stateDir, maxWaitSec: 60 })).rejects.toThrow('exit 1');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('tick은 prWatchRepos에 있는데 repoPaths에 없는 레포를 오류로 알리고 --no-pr-watch면 조용하다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gestalt-conductor-home-'));
    mkdirSync(join(home, '.gestalt'), { recursive: true });
    writeFileSync(
      join(home, '.gestalt', 'conductor.json'),
      JSON.stringify({ prWatchRepos: ['acme/app'], repoPaths: {} }),
    );
    vi.stubEnv('GESTALT_HOME', home);
    try {
      const stateDir = tempStateDir();
      await conductorTickCommand({ stateDir, json: true, force: true, queue: false });
      const report = last() as { errors: string[] };
      expect(report.errors.some((e) => e.startsWith('acme/app:') && e.includes('repoPaths'))).toBe(
        true,
      );

      await conductorTickCommand({
        stateDir,
        json: true,
        force: true,
        queue: false,
        prWatch: false,
      });
      expect((last() as { errors: string[] }).errors).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('감시 간격 안이라 건너뛴 tick은 경로 누락 오류를 건너뛴 이유로 보여 주지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gestalt-conductor-home-'));
    mkdirSync(join(home, '.gestalt'), { recursive: true });
    writeFileSync(
      join(home, '.gestalt', 'conductor.json'),
      JSON.stringify({ prWatchRepos: ['acme/app'], repoPaths: {} }),
    );
    vi.stubEnv('GESTALT_HOME', home);
    try {
      const stateDir = tempStateDir();
      await conductorTickCommand({ stateDir, json: true, force: true, queue: false });
      await conductorTickCommand({ stateDir, queue: false });
      expect(out.at(-1)).toBe('건너뛰었어요 (감시 간격 안)');
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('prWatchRepos가 비어 있으면 repoPaths에 레포가 있어도 gh를 부르지 않는다', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gestalt-conductor-home-'));
    const bin = join(home, 'bin');
    const calls = join(home, 'gh-calls');
    mkdirSync(join(home, '.gestalt'), { recursive: true });
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho "$@" >> '${calls}'\necho '[]'\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    const conf = join(home, '.gestalt', 'conductor.json');
    vi.stubEnv('GESTALT_HOME', home);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    try {
      writeFileSync(conf, JSON.stringify({ repoPaths: { 'acme/app': home } }));
      await conductorTickCommand({
        stateDir: tempStateDir(),
        json: true,
        force: true,
        queue: false,
      });
      expect(existsSync(calls)).toBe(false);

      // 같은 가짜 gh가 감시를 켜면 실제로 불리는지 함께 봐야 위 단언이 빈 통과가 아니다
      writeFileSync(
        conf,
        JSON.stringify({ prWatchRepos: ['acme/app'], repoPaths: { 'acme/app': home } }),
      );
      await conductorTickCommand({
        stateDir: tempStateDir(),
        json: true,
        force: true,
        queue: false,
      });
      expect(existsSync(calls)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('주문 상세와 에이전트', () => {
  it('주문의 agent를 이벤트로 보존하고 허용 꼴이 아니면 거절한다', () => {
    const stateDir = tempStateDir();
    conductorOrderAddCommand({
      stateDir,
      repo: 'acme/app',
      title: '고치기',
      agent: 'custom:v2',
      json: true,
    });
    expect(ConductorStore.open(stateDir).orders()[0]!.agent).toBe('custom:v2');
    for (const agent of ['', ' ', 'codex agent', 'codex\n', '--keep-open', '-x', 'a'.repeat(65)]) {
      expect(() =>
        conductorOrderAddCommand({ stateDir, repo: 'acme/app', title: '고치기', agent }),
      ).toThrow('exit 1');
    }
  });

  it('끝난 주문의 워커, 결과, gate와 bypass를 텍스트와 JSON으로 읽는다', () => {
    const stateDir = tempStateDir();
    conductorOrderAddCommand({
      stateDir,
      repo: 'acme/app',
      title: '고치기',
      description: '상세 주문',
      agent: 'codex',
      json: true,
    });
    const store = ConductorStore.open(stateDir);
    const o = store.orders()[0]!;
    const w = worker(o.id, { kind: 'orca-worktree', agent: 'codex', status: 'finished' });
    store.startWorker(w);
    store.updateOrder(o.id, { workerId: w.id, status: 'done', prRef: 'acme/app#123' });
    const at = store.timestamp();
    const summary = '완료 결과 '.repeat(30);
    store.append({
      type: 'report-applied',
      at,
      name: 'result.json',
      report: {
        workerId: w.id,
        status: 'done',
        summary,
        refs: ['reports/final.md'],
        skill: 'ship',
        refCopies: [
          { ref: '/tmp/out/final.md', path: `refs/${o.id}/0a1b2c3d-final.md`, truncated: true },
          { ref: '/tmp/out/big.log', skipped: 'report-limit', size: 2_000_000 },
        ],
      },
    });
    store.openGate({
      id: 'gate-1',
      orderId: o.id,
      type: 'merge',
      status: 'resolved',
      reason: '머지 확인',
      refs: [],
      openedAt: at,
      decision: 'approved',
    });
    store.append({
      type: 'bypass',
      at,
      record: { orderId: o.id, need: 'cleanup', action: '정리 완료', at },
    });
    conductorOrderShowCommand(o.id, { stateDir, json: true });
    expect(last()).toMatchObject({
      order: { description: '상세 주문' },
      workers: [{ agent: 'codex' }],
      reports: [{ summary }],
      refs: ['reports/final.md'],
      gates: [{ id: 'gate-1' }],
      bypasses: [{ action: '정리 완료' }],
      stateDir: resolve(stateDir),
    });
    out = [];
    conductorOrderShowCommand(o.id, { stateDir });
    const text = out.join('\n');
    for (const part of [
      '상세 주문',
      'codex',
      'orca-worktree',
      summary,
      'reports/final.md',
      'acme/app#123',
      'gate-1',
      '정리 완료',
      'solve → ship',
      `사본: /tmp/out/final.md → refs/${o.id}/0a1b2c3d-final.md (앞부분만)`,
      '사본: /tmp/out/big.log → 건너뜀(report-limit)',
    ])
      expect(text).toContain(part);
    out = [];
    conductorStatusCommand({ stateDir, all: true });
    expect(out.find((line) => line.startsWith(o.id))).toContain('완료 결과');
    expect(out.find((line) => line.startsWith(o.id))).not.toContain(summary);
  });

  it('보고의 제어 문자는 공백으로 바꾸고 여러 줄 요약은 들여써 전문을 찍는다', () => {
    const stateDir = tempStateDir();
    conductorOrderAddCommand({ stateDir, repo: 'acme/app', title: '고치기', json: true });
    const store = ConductorStore.open(stateDir);
    const o = store.orders()[0]!;
    const w = worker(o.id, { status: 'finished' });
    store.startWorker(w);
    store.updateOrder(o.id, { workerId: w.id, status: 'done' });
    const long = '긴 요약 '.repeat(60);
    store.append({
      type: 'report-applied',
      at: store.timestamp(),
      name: 'result.json',
      report: {
        workerId: w.id,
        status: 'needs',
        summary: `첫 줄\u001b[2J\n상태: done\r덮어쓰기\u2028${long}`,
        refs: ['reports/\u001b]8;;x\u0007a.md'],
        need: { kind: 'cleanup', detail: '정리\n워커:' },
      },
    });
    out = [];
    conductorOrderShowCommand(o.id, { stateDir });
    const text = out.join('\n');
    const controls = [...text].filter((ch) => {
      const c = ch.codePointAt(0)!;
      return ch !== '\n' && (c < 0x20 || (c >= 0x7f && c < 0xa0) || c === 0x2028 || c === 0x2029);
    });
    expect(controls).toEqual([]);
    expect(text).toContain(`첫 줄 [2J\n    상태: done 덮어쓰기 ${long}`);
    expect(text).toContain('정리\n    워커:');
    expect(text).toContain('reports/ ]8;;x a.md');
    // 이어지는 줄이 항목 머리처럼 줄 맨 앞에 오지 않는다
    expect(text.split('\n').filter((l) => l.startsWith('상태:') || l.startsWith('워커:'))).toEqual([
      '워커:',
    ]);
  });

  it('보고 본문 없는 옛 로그는 빈 이력으로 읽고 없는 주문은 거절한다', () => {
    const stateDir = tempStateDir();
    conductorOrderAddCommand({ stateDir, repo: 'acme/app', title: '옛 주문', json: true });
    const store = ConductorStore.open(stateDir);
    const o = store.orders()[0]!;
    store.append({ type: 'report-applied', at: store.timestamp(), name: 'old.json' });
    conductorOrderShowCommand(o.id, { stateDir, json: true });
    expect(last()['reports']).toEqual([]);
    expect(() => conductorOrderShowCommand('ord-missing', { stateDir })).toThrow('exit 1');
  });

  it.each(['', ' ', '-1', '1.5', 'abc'])(
    'archive는 --older-than %j를 거절하고 아무것도 안 옮긴다',
    async (olderThan) => {
      const stateDir = tempStateDir();
      const store = ConductorStore.open(stateDir, { now: () => new Date('2000-01-01T00:00:00Z') });
      store.addOrder(order({ id: 'ord-done' }));
      store.updateOrder('ord-done', { status: 'done' });

      await expect(conductorArchiveCommand({ stateDir, olderThan })).rejects.toThrow('exit 1');

      expect(err.join('\n')).toContain('--older-than은 0 이상의 정수');
      expect(existsSync(join(stateDir, 'base.json'))).toBe(false);
      expect(existsSync(join(stateDir, 'archive'))).toBe(false);
      expect(ConductorStore.open(stateDir).order('ord-done')).toBeDefined();
    },
  );

  it('archive는 --before를 거절하고 archive prune은 --before가 있어야 한다', async () => {
    const stateDir = tempStateDir();
    await expect(conductorArchiveCommand({ stateDir, before: '2000-01' })).rejects.toThrow(
      'exit 1',
    );
    expect(err.join('\n')).toContain('--before는 archive prune에서만');
    expect(() => conductorArchivePruneCommand({ stateDir })).toThrow('exit 1');
    expect(err.join('\n')).toContain('--before <YYYY-MM>이 필요해요');
    expect(() =>
      conductorArchivePruneCommand({ stateDir, before: '2000-01', olderThan: '3' }),
    ).toThrow('exit 1');
  });

  it('archive는 모르는 동작을 다른 오류처럼 exit 1로 끝낸다', async () => {
    const stateDir = tempStateDir();

    await expect(conductorArchiveAction('purge', { stateDir })).rejects.toThrow('exit 1');

    expect(err.join('\n')).toContain('모르는 동작이에요: purge');
    expect(existsSync(join(stateDir, 'archive'))).toBe(false);
  });

  it('archive prune은 앞선 달의 보관소를 지운다', () => {
    const stateDir = tempStateDir();
    mkdirSync(join(stateDir, 'archive', '2000-01', 'ord-a'), { recursive: true });
    mkdirSync(join(stateDir, 'archive', '2000-03'), { recursive: true });

    conductorArchivePruneCommand({ stateDir, before: '2000-02', json: true });

    expect(last()).toMatchObject({ status: 'pruned', months: ['2000-01'] });
    expect(readdirSync(join(stateDir, 'archive'))).toEqual(['2000-03']);
  });
});

describe('컨덕터 세션은 하나만', () => {
  const tickAs = async (
    stateDir: string,
    sessionId: string,
    extra: { takeOver?: boolean } = {},
  ) => {
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', sessionId);
    vi.stubEnv('GESTALT_CONDUCTOR_WORKER_ID', '');
    try {
      await conductorTickCommand({
        stateDir,
        json: true,
        force: true,
        queue: false,
        prWatch: false,
        ...extra,
      });
    } finally {
      vi.unstubAllEnvs();
    }
  };

  it('다른 세션이 최근에 tick을 돌렸으면 새 세션은 등록하지 않고 거절한다', async () => {
    const stateDir = tempStateDir();
    const a = randomUUID();
    const b = randomUUID();
    await tickAs(stateDir, a);
    await expect(tickAs(stateDir, b)).rejects.toThrow('exit 1');
    expect(err.at(-1)).toContain('다른 컨덕터 세션이 돌고 있어요');
    expect(err.at(-1)).toContain(a);
    expect(existsSync(join(stateDir, 'sessions', b, 'session.json'))).toBe(false);
    // 원래 세션은 계속 돈다
    await tickAs(stateDir, a);
  });

  it('세션 id가 없는 wait는 살아 있는 컨덕터의 소유 표식을 가져가지 못한다', async () => {
    const stateDir = tempStateDir();
    const sessionId = randomUUID();
    await tickAs(stateDir, sessionId);
    const owner = claimWaitOwner(stateDir, sessionId);
    expect(JSON.parse(readFileSync(join(stateDir, 'wait.owner'), 'utf-8'))).toMatchObject({
      sessionId,
    });
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', undefined);
    try {
      await expect(
        conductorWaitCommand({ stateDir, takeOver: true, maxWaitSec: 1, prWatch: false }),
      ).rejects.toThrow('exit 1');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(err.at(-1)).toContain(sessionId);
    expect(owner.stillOwner()).toBe(true);
  });

  it('--take-over로 넘겨받으면 원래 세션의 tick을 거절한다', async () => {
    const stateDir = tempStateDir();
    const a = randomUUID();
    const b = randomUUID();
    await tickAs(stateDir, a);
    await tickAs(stateDir, b, { takeOver: true });
    expect(err.some((l) => l.includes(`${a}를 넘겨받았어요`))).toBe(true);
    await expect(tickAs(stateDir, a)).rejects.toThrow('exit 1');
    expect(err.at(-1)).toContain('넘겨받았어요');
    // 되찾을 때도 --take-over
    await tickAs(stateDir, a, { takeOver: true });
    await expect(tickAs(stateDir, b)).rejects.toThrow('exit 1');
  });

  it('인계한 세션은 막지 않아 인계받은 새 세션이 첫 tick에 등록된다', async () => {
    const stateDir = tempStateDir();
    const a = randomUUID();
    const b = randomUUID();
    await tickAs(stateDir, a);
    const notesFile = join(stateDir, 'notes.md');
    writeFileSync(notesFile, '- 대화에서 정한 규칙');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', a);
    try {
      await conductorHandoffCommand({ stateDir, json: true, notesFile, launch: false });
    } finally {
      vi.unstubAllEnvs();
    }
    await tickAs(stateDir, b);
    expect(existsSync(join(stateDir, 'sessions', b, 'session.json'))).toBe(true);
    expect(existsSync(join(stateDir, 'sessions', a, 'superseded.json'))).toBe(false);
  });

  it('원래 세션의 tick이 기한보다 오래됐으면 새 세션이 등록하고 원래 세션을 넘겨받는다', async () => {
    const stateDir = tempStateDir();
    const a = randomUUID();
    const b = randomUUID();
    await tickAs(stateDir, a);
    // 기본 staleAfterSec 1800초의 두 배보다 오래
    writeFileSync(
      join(stateDir, 'sessions', a, 'last-tick'),
      new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    );
    await tickAs(stateDir, b);
    await expect(tickAs(stateDir, a)).rejects.toThrow('exit 1');
    expect(err.at(-1)).toContain('넘겨받았어요');
  });
});
