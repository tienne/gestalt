import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorCheckpointSaveCommand,
  conductorDeployReportCommand,
  conductorGateListCommand,
  conductorGateResolveCommand,
  conductorOrderAddCommand,
  conductorOrderShowCommand,
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
});
