import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCanSpawn,
  buildWorkerPrompt,
  chooseWorkerKind,
  detectOrca,
  ensureAccount,
  GitWorktreeLauncher,
  NestedSpawnRefused,
  OrcaLauncher,
  parseDispatchId,
  SubagentLauncher,
  type CommandRunner,
} from '../../../src/master/launcher.js';
import { RESUME_MARKER } from '../../../src/master/metrics.js';
import { MasterStore } from '../../../src/master/store.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

function recorder(stdout = '{"dispatchId":"ctx_1"}') {
  const calls: { cmd: string; args: string[] }[] = [];
  const runner: CommandRunner = async (cmd, args) => {
    calls.push({ cmd, args });
    return { code: 0, stdout, stderr: '' };
  };
  return { calls, runner };
}

describe('워커 종류 고르기', () => {
  it('오르카가 있으면 오르카, 없으면 git 워크트리, 읽기 전용이면 서브에이전트', () => {
    expect(chooseWorkerKind(order(), { orcaAvailable: true })).toBe('orca-worktree');
    expect(chooseWorkerKind(order(), { orcaAvailable: false })).toBe('git-worktree');
    expect(chooseWorkerKind(order({ skillChain: ['review'] }), { orcaAvailable: true })).toBe(
      'subagent',
    );
    expect(chooseWorkerKind(order({ workerKind: 'orca-worktree' }), { orcaAvailable: false })).toBe(
      'git-worktree',
    );
  });

  it('오르카 감지는 실행하지 않고 환경 변수와 PATH만 본다', () => {
    const dir = tempStateDir();
    writeFileSync(join(dir, 'orca'), '');
    expect(detectOrca({ PATH: dir })).toBe(join(dir, 'orca'));
    expect(detectOrca({ PATH: '/nonexistent' })).toBeUndefined();
  });
});

describe('하위 워커 막기', () => {
  it('워커 환경에서는 띄우기를 거절한다', () => {
    expect(() => assertCanSpawn({ GESTALT_MASTER_WORKER_ID: 'wrk-1' })).toThrow(NestedSpawnRefused);
    expect(() => assertCanSpawn({})).not.toThrow();
  });
});

describe('워커 지시서', () => {
  it('워커 id 줄을 담고 재개 지시서는 표식으로 시작하며 참조만 싣는다', () => {
    const o = order({ id: 'ord-1', description: '긴 본문'.repeat(10) });
    const w = worker('ord-1', { id: 'wrk-2', attempt: 2 });
    expect(buildWorkerPrompt(o, w)).toContain('GESTALT_MASTER_WORKER_ID=wrk-2');
    const resumed = buildWorkerPrompt(o, w, {
      reason: 'rate-limit',
      checkpoint: {
        orderId: 'ord-1',
        workerId: 'wrk-1',
        skill: 'ship',
        phase: '2',
        round: 2,
        next: '로컬 리뷰 3라운드',
        completedSkills: ['solve'],
        refs: ['.ship/review-2.md'],
        savedAt: '',
      },
    });
    expect(resumed.startsWith(RESUME_MARKER)).toBe(true);
    expect(resumed).toContain('.ship/review-2.md');
    expect(resumed).not.toContain('긴 본문');
  });
});

describe('런처', () => {
  it('오르카 런처는 독립 워크트리로 worker-start를 부르고 dispatch id를 손잡이로 쓴다', async () => {
    const { calls, runner } = recorder();
    const l = new OrcaLauncher({ orcaCommand: 'orca', promptDir: tempStateDir(), runner });
    const o = order({ id: 'ord-1' });
    const r = await l.start({ order: o, worker: worker('ord-1', { id: 'wrk-1' }), prompt: 'p' });
    expect(r.handle).toBe('ctx_1');
    expect(calls[0]?.args.slice(0, 2)).toEqual(['orchestration', 'worker-start']);
    expect(calls[0]?.args).toContain('new-top-level');
    expect(calls[0]?.args).toContain('name:app');
    await l.send(worker('ord-1', { handle: 'ctx_1' }), '머지 승인됨');
    expect(calls[1]?.args).toContain('dispatch:ctx_1');
  });

  it('git 런처는 워크트리를 만들고 세션 열기를 호스트에 맡긴다', async () => {
    const { calls, runner } = recorder('');
    const root = tempStateDir();
    const l = new GitWorktreeLauncher({
      worktreeRoot: join(root, 'wt'),
      promptDir: join(root, 'prompts'),
      repoPaths: { 'acme/app': '/repos/app' },
      runner,
    });
    const r = await l.start({
      order: order({ id: 'ord-1' }),
      worker: worker('ord-1', { id: 'wrk-1' }),
      prompt: 'p',
    });
    expect(calls[0]?.args).toEqual([
      '-C',
      '/repos/app',
      'worktree',
      'add',
      '-b',
      'master/ord-1',
      join(root, 'wt', 'ord-1'),
    ]);
    expect(r.hostAction?.type).toBe('open-session');

    const prev = join(root, 'existing');
    mkdirSync(prev);
    await l.start({
      order: order({ id: 'ord-1' }),
      worker: worker('ord-1', { id: 'wrk-2' }),
      prompt: 'p',
      previousHandle: prev,
    });
    expect(calls).toHaveLength(1);
  });

  it('서브에이전트 런처는 지시서 파일만 쓰고 호스트에 띄우기를 맡긴다', async () => {
    const dir = tempStateDir();
    const r = await new SubagentLauncher({ promptDir: dir }).start({
      order: order({ id: 'ord-1' }),
      worker: worker('ord-1', { id: 'wrk-1' }),
      prompt: '지시서',
    });
    expect(r.hostAction).toEqual({
      type: 'spawn-subagent',
      workerId: 'wrk-1',
      promptFile: join(dir, 'wrk-1.md'),
    });
    expect(readFileSync(join(dir, 'wrk-1.md'), 'utf-8')).toBe('지시서');
  });

  it('dispatch id는 응답 몇 군데를 본다', () => {
    expect(parseDispatchId('{"dispatch":{"id":"ctx_9"}}')).toBe('ctx_9');
    expect(() => parseDispatchId('{}')).toThrow(/dispatch id/);
  });
});

describe('계정 맞추기', () => {
  it('다르면 bypass로 바꾸고 실패하면 게이트를 연다', async () => {
    const s = MasterStore.open(tempStateDir());
    const o = order({ id: 'ord-1', repo: 'acme/web' });
    s.addOrder(o);
    const switched: string[] = [];
    const ok = await ensureAccount(
      s,
      o,
      { 'acme/web': 'team' },
      {
        current: async () => 'personal',
        switchTo: async (_r, a) => {
          switched.push(a);
        },
      },
    );
    expect(ok).toEqual({ ok: true, account: 'team' });
    expect(switched).toEqual(['team']);
    expect(s.snapshot.bypasses[0]?.need).toBe('account-switch');

    const bad = await ensureAccount(
      s,
      o,
      { 'acme/web': 'team' },
      {
        current: async () => 'personal',
        switchTo: async () => {
          throw new Error('키체인 잠김');
        },
      },
    );
    expect(bad.ok).toBe(false);
    expect(s.openGates('ord-1')[0]?.type).toBe('no-procedure');
    expect(
      await ensureAccount(s, order({ repo: 'acme/other' }), { 'acme/web': 'team' }, undefined),
    ).toEqual({ ok: true });
  });
});
