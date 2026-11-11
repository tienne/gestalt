import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  masterCheckpointSaveCommand,
  masterDeployReportCommand,
  masterGateListCommand,
  masterGateResolveCommand,
  masterOrderAddCommand,
  masterSlackDraftCommand,
  masterStatusCommand,
  masterWorkerReportCommand,
} from '../../../src/cli/commands/master.js';
import { MasterStore } from '../../../src/master/store.js';
import { cleanupStateDirs, tempStateDir, worker } from './fixtures.js';

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

describe('gestalt master', () => {
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
    masterOrderAddCommand({ ...add, issueKey: 'APP-1', issueType: 'bug', scope: 'merge-through' });
    expect(last()['created']).toBe(true);
    masterOrderAddCommand(add);
    expect(last()['created']).toBe(false);

    masterStatusCommand({ stateDir, json: true });
    expect(last()['orders']).toEqual([
      expect.objectContaining({ status: 'queued', scope: 'merge-through', issue: 'APP-1' }),
    ]);
  });

  it('bypass로 넘긴 일을 주문별로 보여주고 --all이면 끝난 주문도 싣는다', () => {
    const stateDir = tempStateDir();
    masterOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: '배너 고치기' });
    const orderId = (last()['order'] as { id: string }).id;
    const store = MasterStore.open(stateDir);
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

    masterStatusCommand({ stateDir, json: true });
    expect(last()['orders']).toEqual([]);
    expect(last()['unassignedBypasses']).toEqual([
      expect.objectContaining({ need: 'account-switch' }),
    ]);

    masterStatusCommand({ stateDir, json: true, all: true });
    expect(last()['orders']).toEqual([
      expect.objectContaining({
        id: orderId,
        status: 'done',
        bypasses: [{ need: 'cleanup', action: '워크트리를 지웠어요', at: record.at }],
      }),
    ]);

    masterStatusCommand({ stateDir, all: true });
    expect(out.join('\n')).toContain(
      '  bypass 2026-01-01T00:00:00.000Z  cleanup  워크트리를 지웠어요',
    );
  });

  it('잘못된 값은 stderr와 exit 1로 끝낸다', () => {
    const stateDir = tempStateDir();
    expect(() =>
      masterOrderAddCommand({ stateDir, repo: 'acme/app', title: 'x', scope: 'yolo' }),
    ).toThrow('exit 1');
    expect(err[0]).toContain('--scope');
    expect(() =>
      masterDeployReportCommand({ stateDir, order: 'ord-none', status: 'success' }),
    ).toThrow('exit 1');
  });

  it('워커는 체크포인트와 결과를 남기고 원문 섞인 결과는 거절된다', () => {
    const stateDir = tempStateDir();
    masterOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: 'x' });
    const orderId = (last()['order'] as { id: string }).id;
    const store = MasterStore.open(stateDir);
    const w = worker(orderId);
    store.startWorker(w);
    store.updateOrder(orderId, { status: 'running', workerId: w.id });

    masterCheckpointSaveCommand({
      stateDir,
      json: true,
      worker: w.id,
      skill: 'solve',
      next: '스펙 확인',
      done: '',
    });
    expect(last()).toMatchObject({ skill: 'solve', next: '스펙 확인' });

    masterWorkerReportCommand({
      stateDir,
      json: true,
      worker: w.id,
      status: 'progress',
      summary: '진행 중',
      ref: ['a.md'],
    });
    expect(String(last()['queued'])).toMatch(/\.json$/);
    expect(() =>
      masterWorkerReportCommand({
        stateDir,
        worker: w.id,
        status: 'done',
        summary: '```\nlog\n```',
      }),
    ).toThrow('exit 1');
  });

  it('워커 세션은 다른 워커 이름으로 보고나 체크포인트를 남기지 못한다', () => {
    const stateDir = tempStateDir();
    masterOrderAddCommand({ stateDir, json: true, repo: 'acme/app', title: 'x' });
    const orderId = (last()['order'] as { id: string }).id;
    const store = MasterStore.open(stateDir);
    const w = worker(orderId);
    store.startWorker(w);
    store.updateOrder(orderId, { status: 'running', workerId: w.id });

    vi.stubEnv('GESTALT_MASTER_WORKER_ID', 'wrk-other');
    try {
      expect(() =>
        masterWorkerReportCommand({ stateDir, worker: w.id, status: 'progress', summary: 'x' }),
      ).toThrow('exit 1');
      expect(err.at(-1)).toContain('wrk-other');
      expect(() =>
        masterCheckpointSaveCommand({ stateDir, worker: w.id, skill: 'solve', next: 'x' }),
      ).toThrow('exit 1');
      expect(MasterStore.open(stateDir).snapshot.checkpoints[orderId]).toBeUndefined();

      vi.stubEnv('GESTALT_MASTER_WORKER_ID', w.id);
      masterCheckpointSaveCommand({
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

  it('슬랙 초안은 게이트로 올라가고 resolve로 닫힌다', async () => {
    const stateDir = tempStateDir();
    const textFile = join(stateDir, 'draft.txt');
    writeFileSync(textFile, '배포 끝났어요~');
    masterSlackDraftCommand({ stateDir, json: true, channel: '#release', textFile });
    const gateId = String(last()['gateId']);

    masterGateListCommand({ stateDir, json: true });
    expect(JSON.parse(out.at(-1)!)).toEqual([
      expect.objectContaining({ id: gateId, type: 'slack-post' }),
    ]);

    await masterGateResolveCommand(gateId, { stateDir, json: true, approve: true });
    expect((last()['gate'] as { decision: string }).decision).toBe('approved');
    await expect(masterGateResolveCommand(gateId, { stateDir, approve: true })).rejects.toThrow(
      'exit 1',
    );
    expect(err.at(-1)).toContain('이미 종료된');
  });

  it('주문의 --pr과 --skills, --issue-key는 꼴이 틀리면 받지 않는다', () => {
    const stateDir = tempStateDir();
    const add = { stateDir, json: true, repo: 'acme/app', title: 'x' };
    expect(() => masterOrderAddCommand({ ...add, pr: 'acme/app#1; rm -rf' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('--pr');
    expect(() => masterOrderAddCommand({ ...add, skills: 'solve,nope' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('nope');
    expect(() => masterOrderAddCommand({ ...add, issueKey: 'app-1' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('--issue-key');
    expect(MasterStore.open(stateDir).orders()).toEqual([]);

    masterOrderAddCommand({ ...add, pr: 'https://github.com/acme/app/pull/12', skills: 'review' });
    expect(last()['order']).toMatchObject({ prRef: 'acme/app#12', skillChain: ['review'] });
  });

  it('워커 환경이나 워커 워크트리 안에서는 마스터 전용 명령을 거절한다', () => {
    // cwd를 바꿔 끼우므로 상대 경로가 그 cwd 기준으로 풀리지 않게 절대 경로로 둔다
    const stateDir = resolve(tempStateDir());
    const add = { stateDir, json: true, repo: 'acme/app', title: 'x' };
    vi.stubEnv('GESTALT_MASTER_WORKER_ID', 'wrk-1');
    try {
      expect(() => masterOrderAddCommand(add)).toThrow('exit 1');
    } finally {
      vi.unstubAllEnvs();
    }

    masterOrderAddCommand(add);
    const orderId = (last()['order'] as { id: string }).id;
    const wt = join(stateDir, 'wt', orderId);
    mkdirSync(wt, { recursive: true });
    MasterStore.open(stateDir).startWorker(
      worker(orderId, { id: 'wrk-g', kind: 'git-worktree', handle: wt }),
    );
    vi.spyOn(process, 'cwd').mockReturnValue(wt);
    expect(() => masterOrderAddCommand({ ...add, title: 'y' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('wrk-g');
  });
});
