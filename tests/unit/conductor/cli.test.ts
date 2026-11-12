import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorCheckpointSaveCommand,
  conductorContextPathCommand,
  conductorDeployReportCommand,
  conductorGateListCommand,
  conductorGateResolveCommand,
  conductorOrderAddCommand,
  conductorQueueAddCommand,
  conductorSlackDraftCommand,
  conductorStatusCommand,
  conductorTickCommand,
  conductorWorkerReportCommand,
} from '../../../src/cli/commands/conductor.js';
import { ConductorStore } from '../../../src/conductor/store.js';
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

  it('슬랙 초안은 게이트로 올라가고 resolve로 닫힌다', async () => {
    const stateDir = tempStateDir();
    const textFile = join(stateDir, 'draft.txt');
    writeFileSync(textFile, '배포 끝났어요~');
    conductorSlackDraftCommand({ stateDir, json: true, channel: '#release', textFile });
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

  it('주문의 --pr과 --skills, --issue-key는 꼴이 틀리면 받지 않는다', () => {
    const stateDir = tempStateDir();
    const add = { stateDir, json: true, repo: 'acme/app', title: 'x' };
    expect(() => conductorOrderAddCommand({ ...add, pr: 'acme/app#1; rm -rf' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('--pr');
    expect(() => conductorOrderAddCommand({ ...add, skills: 'solve,nope' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('nope');
    expect(() => conductorOrderAddCommand({ ...add, issueKey: 'app-1' })).toThrow('exit 1');
    expect(err.at(-1)).toContain('--issue-key');
    expect(ConductorStore.open(stateDir).orders()).toEqual([]);

    conductorOrderAddCommand({
      ...add,
      pr: 'https://github.com/acme/app/pull/12',
      skills: 'review',
    });
    expect(last()['order']).toMatchObject({ prRef: 'acme/app#12', skillChain: ['review'] });
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
});
