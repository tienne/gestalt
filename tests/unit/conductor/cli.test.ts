import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  conductorCheckpointSaveCommand,
  conductorContextPathCommand,
  conductorDeployReportCommand,
  conductorGateListCommand,
  conductorGateResolveCommand,
  conductorOrderAddCommand,
  conductorOrderRemoveCommand,
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
