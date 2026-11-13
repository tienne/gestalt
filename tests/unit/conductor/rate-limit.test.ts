import { afterEach, describe, expect, it } from 'vitest';
import { tick, type EngineDeps } from '../../../src/conductor/engine.js';
import { resolveGate } from '../../../src/conductor/gates.js';
import {
  OrcaLauncher,
  type CommandRunner,
  type Launcher,
  type ReleaseOptions,
} from '../../../src/conductor/launcher.js';
import {
  detectStale,
  prepareResumes,
  saveSkillCheckpoint,
  type ProbeWorker,
  type WorkerProbe,
} from '../../../src/conductor/resume.js';
import type { ConductorConfig } from '../../../src/conductor/scheduler.js';
import {
  isUsageLimitText,
  usageLimitIn,
  usageLimitInText,
} from '../../../src/conductor/usage-limit.js';
import type { Worker, WorkerKind } from '../../../src/conductor/types.js';
import { cleanupStateDirs, clockedStore, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

const STALE_MS = 300_000;

// 2026-11-13 리밋에 걸린 오르카 워커의 마지막 시스템 메시지 꼴
const LIMIT_MESSAGE = {
  role: 'system',
  text: 'Claude hit its session limit.',
  blocks: [
    {
      type: 'notice',
      failure: {
        kind: 'usageLimitReached',
        detail: { text: "You've hit your 5-hour limit · resets 9:40am (Asia/Seoul)" },
        usageLimit: { window: 'session', resetsAt: Date.parse('2026-11-13T00:40:00Z') },
      },
    },
  ],
};

describe('한도 표시 판별', () => {
  it.each([
    "You've hit your 5-hour limit · resets 9:40am",
    'Claude hit its session limit.',
    'Claude usage limit reached. Your limit will reset at 3pm.',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}',
    'Weekly limit reached',
  ])('한도 문구로 본다: %s', (text) => {
    expect(isUsageLimitText(text)).toBe(true);
  });

  it.each([
    'limit 파라미터를 500으로 올렸어요',
    'rateLimitEscalateAfterSec 기본값을 정했어요',
    'staleAfterSec limit을 넘으면 끊김으로 본다',
  ])('평소 출력은 한도로 안 본다: %s', (text) => {
    expect(isUsageLimitText(text)).toBe(false);
  });

  it('오르카 failure 표식에서 안내 문구와 풀리는 시각을 꺼낸다', () => {
    const hit = usageLimitIn([{ role: 'assistant', text: '작업 중' }, LIMIT_MESSAGE]);
    expect(hit).toEqual({
      text: "You've hit your 5-hour limit · resets 9:40am (Asia/Seoul)",
      resetsAt: '2026-11-13T00:40:00.000Z',
    });
  });

  it('도구 호출 블록에 한도 문구가 있어도 한도로 안 본다', () => {
    const toolOnly = {
      role: 'assistant',
      blocks: [{ type: 'tool_use', input: { command: "grep 'usage limit' src" } }],
    };
    expect(usageLimitIn([toolOnly])).toBeUndefined();
    const said = { role: 'assistant', blocks: [{ type: 'text', text: 'Weekly limit reached' }] };
    expect(usageLimitIn([toolOnly, said])?.text).toBe('Weekly limit reached');
  });

  it('터미널 출력은 끝부분만 본다', () => {
    const old = `Weekly limit reached\n${'x'.repeat(3000)}`;
    expect(usageLimitInText(old)).toBeUndefined();
    expect(usageLimitInText(`${old}\n5-hour limit reached ∙ resets 3am`)?.text).toMatch(/5-hour/);
  });
});

function staleOrca(over: Partial<Worker> = {}) {
  const c = clockedStore();
  c.store.addOrder(order({ id: 'ord-1', status: 'running', workerId: 'wrk-1' }));
  c.store.startWorker(
    worker('ord-1', {
      id: 'wrk-1',
      kind: 'orca-worktree',
      handle: 'ctx_1',
      lastSeenAt: c.now().toISOString(),
      ...over,
    }),
  );
  c.advance(STALE_MS + 1);
  return c;
}

const probeAs =
  (p: WorkerProbe): ProbeWorker =>
  async () =>
    p;

describe('오르카 워커 끊김 감지', () => {
  it('한도 표시가 보이면 rate-limit으로 남기고 재개하지 않는다', async () => {
    const c = staleOrca();
    const out = await detectStale(c.store, {
      now: c.now(),
      staleAfterMs: STALE_MS,
      probe: probeAs({
        state: 'rate-limit',
        text: '5-hour limit',
        resetsAt: '2026-11-01T05:00:00Z',
      }),
    });
    expect(out.stopped).toEqual([]);
    expect(out.rateLimited.map((w) => w.id)).toEqual(['wrk-1']);
    expect(c.store.worker('wrk-1')).toMatchObject({
      status: 'stopped',
      stopReason: 'rate-limit',
      rateLimitResetsAt: '2026-11-01T05:00:00Z',
    });
    expect(prepareResumes(c.store, { maxResumeAttempts: 3 })).toEqual([]);
    expect(c.store.order('ord-1')?.status).toBe('running');
  });

  it('출력 중인 터미널은 소식이 끊겨도 그대로 둔다', async () => {
    const c = staleOrca();
    const out = await detectStale(c.store, {
      now: c.now(),
      staleAfterMs: STALE_MS,
      probe: probeAs({ state: 'working' }),
    });
    expect(out).toMatchObject({ stopped: [], rateLimited: [], warnings: [] });
    expect(c.store.worker('wrk-1')?.status).toBe('running');
  });

  it.each(['gone', 'idle'] as const)('터미널이 %s면 끊김으로 보고 재개한다', async (state) => {
    const c = staleOrca();
    const out = await detectStale(c.store, {
      now: c.now(),
      staleAfterMs: STALE_MS,
      probe: probeAs({ state }),
    });
    expect(out.stopped.map((w) => w.id)).toEqual(['wrk-1']);
    expect(c.store.worker('wrk-1')?.stopReason).toBe('disconnected');
    expect(prepareResumes(c.store, { maxResumeAttempts: 3 }).map((d) => d.kind)).toEqual([
      'resume',
    ]);
  });

  it('확인이 실패하면 지금처럼 끊김으로 보고 경고를 남긴다', async () => {
    const c = staleOrca();
    const out = await detectStale(c.store, {
      now: c.now(),
      staleAfterMs: STALE_MS,
      probe: async () => {
        throw new Error('orca 응답 없음');
      },
    });
    expect(out.stopped.map((w) => w.id)).toEqual(['wrk-1']);
    expect(out.warnings).toEqual([expect.stringMatching(/wrk-1.*orca 응답 없음/)]);
  });

  it('git 워크트리 워커는 터미널을 안 본다', async () => {
    const c = staleOrca({ kind: 'git-worktree', handle: '/wt/ord-1' });
    let called = 0;
    const out = await detectStale(c.store, {
      now: c.now(),
      staleAfterMs: STALE_MS,
      probe: async () => {
        called++;
        return { state: 'working' };
      },
    });
    expect(called).toBe(0);
    expect(out.stopped.map((w) => w.id)).toEqual(['wrk-1']);
  });

  it('리밋에 걸린 워커가 체크포인트를 남기면 running으로 돌아온다', async () => {
    const c = staleOrca();
    await detectStale(c.store, {
      now: c.now(),
      staleAfterMs: STALE_MS,
      probe: probeAs({ state: 'rate-limit', text: 'limit reached' }),
    });
    saveSkillCheckpoint(c.store, { workerId: 'wrk-1', skill: 'solve', next: '테스트' });
    const w = c.store.worker('wrk-1')!;
    expect(w.status).toBe('running');
    expect(w.stopReason).toBeUndefined();
    expect(w.rateLimitedAt).toBeUndefined();
  });

  it('리밋 뒤 터미널이 사라지면 그때 끊김으로 바꿔 재개한다', async () => {
    const c = staleOrca();
    await detectStale(c.store, {
      now: c.now(),
      staleAfterMs: STALE_MS,
      probe: probeAs({ state: 'rate-limit', text: 'limit reached' }),
    });
    c.advance(60_000);
    const out = await detectStale(c.store, {
      now: c.now(),
      staleAfterMs: STALE_MS,
      probe: probeAs({ state: 'gone' }),
    });
    expect(out.stopped.map((w) => w.id)).toEqual(['wrk-1']);
    expect(c.store.worker('wrk-1')?.stopReason).toBe('disconnected');
  });

  it('리밋이 상한보다 오래 가면 게이트를 한 번 연다', async () => {
    const c = staleOrca();
    const opts = (probe: ProbeWorker) => ({
      now: c.now(),
      staleAfterMs: STALE_MS,
      probe,
      rateLimitEscalateAfterMs: 3_600_000,
    });
    await detectStale(c.store, opts(probeAs({ state: 'rate-limit', text: 'limit reached' })));
    c.advance(1_800_000);
    expect((await detectStale(c.store, opts(probeAs({ state: 'idle' })))).escalated).toEqual([]);
    c.advance(1_800_000);
    const out = await detectStale(c.store, opts(probeAs({ state: 'idle' })));
    expect(out.escalated).toHaveLength(1);
    expect(out.escalated[0]?.reason).toMatch(/1시간째/);
    expect(c.store.order('ord-1')?.status).toBe('waiting-gate');
    expect(c.store.openGates('ord-1')).toHaveLength(1);

    resolveGate(c.store, out.escalated[0]!.id, 'approved');
    expect(c.store.order('ord-1')?.status).toBe('queued');
  });
});

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
};

function orcaLauncher(releaseError?: Error) {
  const calls: string[] = [];
  const launcher: Launcher = {
    kind: 'orca-worktree' as WorkerKind,
    start: async (spec) => {
      calls.push(`start:${spec.worker.id}`);
      return { handle: `ctx-${spec.worker.id}` };
    },
    send: async () => undefined,
    release: async (w: Worker, opts?: ReleaseOptions) => {
      calls.push(`release:${w.id}:${opts?.requireClosed ? 'closed' : 'any'}`);
      if (releaseError) throw releaseError;
    },
  };
  return { launcher, calls };
}

function stoppedOrcaOrder() {
  const c = clockedStore();
  c.store.addOrder(order({ id: 'ord-1', status: 'running', workerId: 'wrk-1' }));
  c.store.startWorker(
    worker('ord-1', {
      id: 'wrk-1',
      kind: 'orca-worktree',
      handle: 'ctx_1',
      status: 'stopped',
      stopReason: 'disconnected',
      lastSeenAt: c.now().toISOString(),
    }),
  );
  return c;
}

describe('오르카 워커 재개', () => {
  it('새 워커를 띄우기 전에 앞 워커 터미널부터 거둔다', async () => {
    const c = stoppedOrcaOrder();
    const orca = orcaLauncher();
    const d: EngineDeps = {
      config,
      launchers: { 'orca-worktree': orca.launcher },
      orcaAvailable: true,
      env: {},
    };
    const r = await tick(c.store, d, { now: c.now(), force: true });
    expect(r.launched).toHaveLength(1);
    expect(orca.calls[0]).toBe('release:wrk-1:closed');
    expect(orca.calls[1]).toMatch(/^start:/);
  });

  it('앞 터미널을 못 거두면 새 워커를 안 띄우고 사람에게 올린다', async () => {
    const c = stoppedOrcaOrder();
    const orca = orcaLauncher(new Error('retained'));
    const d: EngineDeps = {
      config,
      launchers: { 'orca-worktree': orca.launcher },
      orcaAvailable: true,
      env: {},
    };
    const r = await tick(c.store, d, { now: c.now(), force: true });
    expect(r.launched).toEqual([]);
    expect(orca.calls).toEqual(['release:wrk-1:closed']);
    expect(c.store.order('ord-1')?.status).toBe('escalated');
    expect(r.escalated).toHaveLength(1);
    expect(c.store.openGates('ord-1')[0]?.reason).toMatch(/앞 워커 터미널을 못 거뒀어요: retained/);
  });

  it('리밋에 걸린 워커는 tick 보고에 보인다', async () => {
    const c = staleOrca();
    c.advance(config.staleAfterSec * 1000);
    const orca = orcaLauncher();
    const d: EngineDeps = {
      config,
      launchers: {
        'orca-worktree': {
          ...orca.launcher,
          probe: async () => ({ state: 'rate-limit', text: 'limit reached' }),
        },
      },
      orcaAvailable: true,
      env: {},
    };
    const r = await tick(c.store, d, { now: c.now(), force: true });
    expect(r.launched).toEqual([]);
    expect(orca.calls).toEqual([]);
    expect(r.rateLimited).toEqual([
      expect.objectContaining({ orderId: 'ord-1', workerId: 'wrk-1' }),
    ]);
  });
});

function scripted(replies: Record<string, unknown[]>): {
  runner: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const runner: CommandRunner = async (_cmd, args) => {
    calls.push(args);
    const queue = replies[args[1]!] ?? [];
    const next = queue.shift();
    return { code: 0, stdout: JSON.stringify({ ok: true, result: next ?? {} }), stderr: '' };
  };
  return { runner, calls };
}

describe('오르카 런처 터미널 확인', () => {
  const w = () => worker('ord-1', { id: 'wrk-1', kind: 'orca-worktree', handle: 'ctx_1' });

  it('출력 중이면 worker-read를 안 부르고 working으로 본다', async () => {
    const { runner, calls } = scripted({
      'worker-show': [{ liveness: 'live', activity: 'working', terminalState: 'retained' }],
    });
    const l = new OrcaLauncher({ orcaCommand: 'orca', promptDir: tempStateDir(), runner });
    expect(await l.probe(w())).toEqual({ state: 'working' });
    expect(calls.map((a) => a[1])).toEqual(['worker-show']);
  });

  it('끝 메시지의 한도 표식을 찾을 때까지 쪽을 넘긴다', async () => {
    const { runner, calls } = scripted({
      'worker-show': [{ liveness: 'live', activity: 'idle', terminalState: 'retained' }],
      'worker-read': [
        { transcript: { messages: [{ role: 'user', text: 'go' }], nextCursor: 'c2' } },
        { transcript: { messages: [LIMIT_MESSAGE], nextCursor: 'c3' } },
        { transcript: { messages: [] } },
      ],
    });
    const l = new OrcaLauncher({ orcaCommand: 'orca', promptDir: tempStateDir(), runner });
    const probed = await l.probe(w());
    expect(probed).toMatchObject({ state: 'rate-limit', resetsAt: '2026-11-13T00:40:00.000Z' });
    expect(calls.filter((a) => a[1] === 'worker-read').map((a) => a.at(-1))).toEqual([
      '500',
      'c2',
      'c3',
    ]);
  });

  it('프로세스가 끝났으면 gone, liveness를 모르면 확인 실패로 던진다', async () => {
    const gone = scripted({ 'worker-show': [{ liveness: 'exited' }] });
    const l1 = new OrcaLauncher({
      orcaCommand: 'orca',
      promptDir: tempStateDir(),
      runner: gone.runner,
    });
    expect(await l1.probe(w())).toEqual({ state: 'gone' });

    const unknown = scripted({ 'worker-show': [{ liveness: 'unverifiable' }] });
    const l2 = new OrcaLauncher({
      orcaCommand: 'orca',
      promptDir: tempStateDir(),
      runner: unknown.runner,
    });
    await expect(l2.probe(w())).rejects.toThrow(/liveness/);
  });

  it('살아 있는 터미널이 retained로 남으면 거두기 실패로 던진다', async () => {
    const { runner } = scripted({
      'worker-release': [{ state: 'retained' }],
      'worker-show': [{ liveness: 'live' }],
    });
    const l = new OrcaLauncher({ orcaCommand: 'orca', promptDir: tempStateDir(), runner });
    await expect(l.release(w(), { requireClosed: true })).rejects.toThrow(/worker-stop/);
  });

  it('released나 끝난 프로세스면 거두기를 받아들인다', async () => {
    const released = scripted({ 'worker-release': [{ state: 'released' }] });
    const l1 = new OrcaLauncher({
      orcaCommand: 'orca',
      promptDir: tempStateDir(),
      runner: released.runner,
    });
    await l1.release(w(), { requireClosed: true });
    expect(released.calls.map((a) => a[1])).toEqual(['worker-release']);

    const exited = scripted({
      'worker-release': [{ state: 'retained' }],
      'worker-show': [{ liveness: 'gone' }],
    });
    const l2 = new OrcaLauncher({
      orcaCommand: 'orca',
      promptDir: tempStateDir(),
      runner: exited.runner,
    });
    await l2.release(w(), { requireClosed: true });
  });
});
