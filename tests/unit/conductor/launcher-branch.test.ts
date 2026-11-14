import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  branchPrefixFor,
  GitWorktreeLauncher,
  issueBranchName,
  OrcaLauncher,
  pickFreeBranch,
  prUrlOf,
  worktreeReferences,
  type CommandOptions,
  type CommandResult,
  type CommandRunner,
  type RemoteHeadsCache,
} from '../../../src/conductor/launcher.js';
import type { IssueType, Order } from '../../../src/conductor/types.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(() => {
  cleanupStateDirs();
  vi.unstubAllEnvs();
});

interface FakeGit {
  /** 로컬에 있는 브랜치 */
  local?: string[];
  /** origin에 있는 브랜치 */
  remote?: string[];
  /** ls-remote가 원격을 못 읽는다 */
  remoteDown?: boolean;
  /** git worktree list --porcelain 출력 */
  worktrees?: string;
  /** reference add가 실패한다 */
  referenceFails?: boolean;
  /** worker-start 응답 */
  workerStart?: CommandResult;
  /** worktree create가 돌려줄 브랜치. null이면 응답에 브랜치가 없다 */
  createdBranch?: string | null;
  /** origin 원격이 없다 */
  noOrigin?: boolean;
  /** for-each-ref가 실패한다 */
  localFails?: boolean;
  /** git branch --show-current 출력. 경로별로 다르면 경로를 키로 준다 */
  currentBranch?: string | Record<string, string>;
  /** git config --get core.sshCommand 값 */
  sshCommand?: string;
  /** gitDir별 git common dir. 없으면 rev-parse가 실패한다 */
  commonDir?: Record<string, string>;
  /** git symbolic-ref refs/remotes/origin/HEAD 값. 없으면 실패한다 */
  originHead?: string;
  /** 오르카 워크트리 이름별 경로. 없으면 /wt/<이름> */
  paths?: Record<string, string>;
}

const ok = (stdout = ''): CommandResult => ({ code: 0, stdout, stderr: '' });

/** 오르카와 git을 실제로 부르지 않고 명령별로 정해 둔 답을 준다 */
function fake(opts: FakeGit = {}) {
  const calls: { cmd: string; args: string[]; opts?: CommandOptions }[] = [];
  const runner: CommandRunner = async (cmd, args, o) => {
    calls.push({ cmd, args, ...(o ? { opts: o } : {}) });
    if (cmd === 'git') {
      const sub = args[2];
      const last = args.at(-1)!.replace('refs/heads/', '');
      if (sub === 'rev-parse' && args.includes('--git-common-dir')) {
        const dir = opts.commonDir?.[args[1]!];
        return dir ? ok(`${dir}\n`) : { code: 128, stdout: '', stderr: 'fatal' };
      }
      if (sub === 'symbolic-ref')
        return opts.originHead ? ok(`${opts.originHead}\n`) : { code: 128, stdout: '', stderr: '' };
      if (sub === 'rev-parse')
        return { code: opts.local?.includes(last) ? 0 : 1, stdout: '', stderr: '' };
      if (sub === 'for-each-ref') {
        if (opts.localFails)
          return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
        // 패턴은 앞부분만 맞춘다. 정확한 비교는 런처가 한다
        const prefix = args[4]!.replace('refs/heads/', '');
        const hits = (opts.local ?? []).filter((b) => b.startsWith(prefix));
        return ok(hits.map((b) => `refs/heads/${b}`).join('\n'));
      }
      if (sub === 'remote') return ok(opts.noOrigin ? '' : 'origin\n');
      if (sub === 'ls-remote') {
        if (opts.remoteDown) return { code: 128, stdout: '', stderr: 'Could not read from remote' };
        return ok((opts.remote ?? []).map((b) => `abc\trefs/heads/${b}`).join('\n'));
      }
      if (sub === 'branch' && args[3] === '--show-current') {
        const cur = opts.currentBranch;
        return ok(`${(typeof cur === 'string' ? cur : cur?.[args[1]!]) ?? ''}\n`);
      }
      if (sub === 'config')
        return opts.sshCommand ? ok(`${opts.sshCommand}\n`) : { code: 1, stdout: '', stderr: '' };
      if (sub === 'worktree' && args[3] === 'list') return ok(opts.worktrees ?? '');
      return ok();
    }
    const head = args.slice(0, 2).join(' ');
    if (head === 'repo show')
      return ok(JSON.stringify({ ok: true, result: { repo: { path: '/repos/app' } } }));
    if (head === 'worktree show') {
      const sel = args[args.indexOf('--worktree') + 1]!;
      const name = sel.startsWith('name:') ? sel.slice('name:'.length) : undefined;
      const path = name ? (opts.paths?.[name] ?? `/wt/${name}`) : undefined;
      return ok(JSON.stringify({ ok: true, result: { worktree: { repoId: 'r1', path } } }));
    }
    if (head === 'worktree create') {
      const name = args[args.indexOf('--name') + 1]!;
      const branch =
        opts.createdBranch === null
          ? undefined
          : (opts.createdBranch ?? args[args.indexOf('--branch') + 1] ?? `tienne/${name}`);
      return ok(
        JSON.stringify({
          ok: true,
          result: {
            worktree: {
              id: `r1::/wt/${name}`,
              path: `/wt/${name}`,
              ...(branch ? { branch: `refs/heads/${branch}` } : {}),
            },
          },
        }),
      );
    }
    if (head === 'reference add')
      return opts.referenceFails
        ? { code: 1, stdout: '', stderr: 'jira site not connected' }
        : ok('{"ok":true}');
    if (head === 'orchestration worker-start')
      return opts.workerStart ?? ok('{"dispatchId":"ctx_1"}');
    return ok('{"ok":true}');
  };
  const orcaCalls = (verb: string) =>
    calls.filter((c) => c.cmd === 'orca' && c.args.slice(0, 2).join(' ') === verb);
  const gitCalls = () => calls.filter((c) => c.cmd === 'git').map((c) => c.args);
  return { calls, runner, orcaCalls, gitCalls };
}

function orcaLauncher(runner: CommandRunner, repoPaths?: Record<string, string>) {
  return new OrcaLauncher({
    orcaCommand: 'orca',
    promptDir: tempStateDir(),
    runner,
    ...(repoPaths ? { repoPaths } : {}),
  });
}

function jiraOrder(over: Partial<Order> = {}): Order {
  return order({ id: 'ord-1', issueKey: 'PROJ-1', issueType: 'story', ...over });
}

const flag = (args: string[], name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

describe('지라 주문 브랜치 이름', () => {
  it('bug와 sub-bug는 fix, 나머지와 이슈 타입이 없으면 feat다', () => {
    const cases: [IssueType | undefined, string][] = [
      ['bug', 'fix'],
      ['sub-bug', 'fix'],
      ['story', 'feat'],
      ['task', 'feat'],
      ['sub-task', 'feat'],
      ['other', 'feat'],
      [undefined, 'feat'],
    ];
    for (const [type, prefix] of cases) {
      expect(branchPrefixFor(type)).toBe(prefix);
      expect(issueBranchName({ issueKey: 'PROJ-1', ...(type ? { issueType: type } : {}) })).toBe(
        `${prefix}/PROJ-1`,
      );
    }
  });

  it('지라 키가 없거나 PR 브랜치에서 일하는 주문은 새 브랜치 이름을 안 짓는다', () => {
    expect(issueBranchName({})).toBeUndefined();
    expect(issueBranchName({ issueKey: 'PROJ-1', prRef: 'acme/app#3' })).toBeUndefined();
  });

  it('참조는 지라 키가 있을 때만 붙이고 PR이 있으면 PR 주소를 같이 붙인다', () => {
    expect(worktreeReferences({})).toEqual([]);
    expect(worktreeReferences({ prRef: 'acme/app#3' })).toEqual([]);
    expect(worktreeReferences({ issueKey: 'PROJ-1', prRef: 'acme/app#3' })).toEqual([
      'PROJ-1',
      'https://github.com/acme/app/pull/3',
    ]);
    expect(prUrlOf('PR 3')).toBeUndefined();
  });
});

describe('비어 있는 브랜치 고르기', () => {
  it('로컬이나 origin에 있으면 -2, -3을 붙인다', async () => {
    const local = fake({ local: ['feat/PROJ-1'] });
    expect((await pickFreeBranch(local.runner, '/repos/app', 'feat/PROJ-1')).branch).toBe(
      'feat/PROJ-1-2',
    );
    const both = fake({ local: ['feat/PROJ-1'], remote: ['feat/PROJ-1-2'] });
    expect((await pickFreeBranch(both.runner, '/repos/app', 'feat/PROJ-1')).branch).toBe(
      'feat/PROJ-1-3',
    );
    const free = fake();
    expect(await pickFreeBranch(free.runner, '/repos/app', 'feat/PROJ-1')).toEqual({
      branch: 'feat/PROJ-1',
      warnings: [],
    });
  });

  it('패턴에 같이 걸린 비슷한 이름은 겹치는 걸로 안 본다', async () => {
    const f = fake({ local: ['feat/PROJ-12', 'feat/PROJ-1-x'] });
    expect((await pickFreeBranch(f.runner, '/repos/app', 'feat/PROJ-1')).branch).toBe(
      'feat/PROJ-1',
    );
  });

  it('로컬과 origin을 한 번씩만 읽고 origin 결과는 캐시로 다시 쓴다', async () => {
    const f = fake({ local: ['feat/PROJ-1'], remote: ['feat/PROJ-1-2'] });
    const cache: RemoteHeadsCache = new Map();
    await pickFreeBranch(f.runner, '/repos/app', 'feat/PROJ-1', cache);
    await pickFreeBranch(f.runner, '/repos/app', 'feat/PROJ-2', cache);
    const subs = f.gitCalls().map((a) => a[2]);
    expect(subs.filter((x) => x === 'for-each-ref')).toHaveLength(2);
    expect(subs.filter((x) => x === 'ls-remote')).toHaveLength(1);
  });

  it('경로가 달라도 git common dir이 같으면 ls-remote를 한 번만 부른다', async () => {
    const f = fake({
      remote: ['feat/PROJ-1'],
      commonDir: { '/repos/app': '/repos/app/.git', '/wt/ord-2-1': '/repos/app/.git' },
    });
    const cache: RemoteHeadsCache = new Map();
    const a = await pickFreeBranch(f.runner, '/repos/app', 'feat/PROJ-1', cache);
    const b = await pickFreeBranch(f.runner, '/wt/ord-2-1', 'feat/PROJ-1', cache);
    await pickFreeBranch(f.runner, '/wt/ord-2-1', 'feat/PROJ-3', cache);
    expect([a.branch, b.branch]).toEqual(['feat/PROJ-1-2', 'feat/PROJ-1-2']);
    const subs = f.gitCalls().map((x) => x[2]);
    expect(subs.filter((x) => x === 'ls-remote')).toHaveLength(1);
    // 두 번째 경로부터는 별칭으로 찾아 rev-parse도 더 안 부른다
    expect(subs.filter((x) => x === 'rev-parse')).toHaveLength(2);
  });

  it('origin이 없는 레포는 ls-remote를 안 부르고 경고도 없다', async () => {
    const f = fake({ noOrigin: true });
    expect(await pickFreeBranch(f.runner, '/repos/app', 'feat/PROJ-1')).toEqual({
      branch: 'feat/PROJ-1',
      warnings: [],
    });
    expect(f.gitCalls().some((a) => a[2] === 'ls-remote')).toBe(false);
  });

  it('로컬 브랜치를 못 읽으면 없는 걸로 치지 않고 멈춘다', async () => {
    const f = fake({ localFails: true });
    await expect(pickFreeBranch(f.runner, '/repos/app', 'feat/PROJ-1')).rejects.toThrow(
      '로컬 브랜치를 못 읽었어요',
    );
  });

  it('-20까지 다 차 있으면 멈춘다', async () => {
    const local = ['feat/PROJ-1', ...Array.from({ length: 19 }, (_, i) => `feat/PROJ-1-${i + 2}`)];
    const f = fake({ local });
    await expect(pickFreeBranch(f.runner, '/repos/app', 'feat/PROJ-1')).rejects.toThrow(
      'feat/PROJ-1-20까지 브랜치가 다 있어요',
    );
  });

  it('origin을 못 읽으면 로컬만 보고 고른 뒤 경고를 남긴다', async () => {
    const f = fake({ remoteDown: true });
    const r = await pickFreeBranch(f.runner, '/repos/app', 'fix/PROJ-1');
    expect(r.branch).toBe('fix/PROJ-1');
    expect(r.warnings.join()).toContain('origin을 못 읽어');
  });

  it('origin을 못 읽은 결과도 캐시해 같은 tick에서 ls-remote를 다시 안 부른다', async () => {
    const f = fake({ remoteDown: true });
    const cache: RemoteHeadsCache = new Map();
    await pickFreeBranch(f.runner, '/repos/app', 'feat/PROJ-1', cache);
    const second = await pickFreeBranch(f.runner, '/repos/app', 'feat/PROJ-2', cache);
    expect(second.warnings.join()).toContain('origin을 못 읽어');
    expect(f.gitCalls().filter((a) => a[2] === 'ls-remote')).toHaveLength(1);
  });

  it('ssh 명령을 따로 정해 두지 않았으면 ls-remote에 BatchMode를 건다', async () => {
    vi.stubEnv('GIT_SSH_COMMAND', '');
    const plain = fake();
    await pickFreeBranch(plain.runner, '/repos/app', 'feat/PROJ-1');
    const env = plain.calls.find((c) => c.args[2] === 'ls-remote')?.opts?.env;
    expect(env?.['GIT_SSH_COMMAND']).toContain('BatchMode=yes');
    const custom = fake({ sshCommand: 'ssh -i ~/.ssh/work' });
    await pickFreeBranch(custom.runner, '/repos/app', 'feat/PROJ-1');
    const kept = custom.calls.find((c) => c.args[2] === 'ls-remote')?.opts?.env;
    expect(kept?.['GIT_SSH_COMMAND']).toBeUndefined();
  });
});

describe('오르카 런처의 지라 주문', () => {
  it('지라 키가 없으면 지금처럼 worker-start 한 번으로 띄운다', async () => {
    const f = fake();
    const r = await orcaLauncher(f.runner).start({
      order: order({ id: 'ord-1' }),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    expect(f.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'orchestration worker-start',
    ]);
    expect(r).toEqual({ handle: 'ctx_1' });
  });

  it('지라 키가 없는 주문의 재개는 앞 브랜치를 이어받지 않았다고 경고한다', async () => {
    const f = fake();
    const r = await orcaLauncher(f.runner).start({
      order: order({ id: 'ord-1' }),
      worker: worker('ord-1', { attempt: 2 }),
      prompt: 'p',
      previousBranch: 'tienne/ord-1-1',
    });
    expect(f.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'orchestration worker-start',
    ]);
    expect(r.warnings).toEqual([
      'ord-1: 지라 키가 없는 주문이라 앞 워커가 쓰던 브랜치 tienne/ord-1-1를 이어받지 않고 새 워크트리로 띄웠어요',
    ]);
  });

  it('최상위는 --branch와 --no-parent를 주고 워크트리를 만든 뒤 참조를 붙이고 워커를 붙인다', async () => {
    const f = fake();
    const r = await orcaLauncher(f.runner).start({
      order: jiraOrder({ issueType: 'bug' }),
      worker: worker('ord-1', { id: 'wrk-1', agent: 'codex' }),
      prompt: 'p',
    });
    // repoPaths가 없으면 오르카에 등록된 레포 경로에서 겹치는 브랜치를 본다
    expect(f.orcaCalls('repo show')[0]?.args).toContain('name:app');
    expect(f.gitCalls()[0]?.slice(0, 2)).toEqual(['-C', '/repos/app']);
    const create = f.orcaCalls('worktree create')[0]!.args;
    expect(flag(create, '--name')).toBe('ord-1-1');
    expect(flag(create, '--repo')).toBe('name:app');
    expect(flag(create, '--branch')).toBe('fix/PROJ-1');
    expect(flag(create, '--setup')).toBe('run');
    expect(create).toContain('--no-parent');
    expect(create).not.toContain('--reference');
    expect(f.orcaCalls('reference add').map((c) => c.args)).toEqual([
      ['reference', 'add', 'PROJ-1', '--worktree', 'id:r1::/wt/ord-1-1', '--json'],
    ]);
    const start = f.orcaCalls('orchestration worker-start')[0]!.args;
    expect(flag(start, '--worktree')).toBe('id:r1::/wt/ord-1-1');
    expect(flag(start, '--agent')).toBe('codex');
    for (const creation of ['--name', '--repo', '--display-name', '--setup', '--base-branch'])
      expect(start).not.toContain(creation);
    expect(r).toEqual({ handle: 'ctx_1', branch: 'fix/PROJ-1' });
  });

  it('바깥 출처의 기준 브랜치면 셋업을 건너뛰는 정책을 그대로 둔다', async () => {
    const f = fake();
    await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start({
      order: jiraOrder({ source: 'jira', baseBranch: 'develop' }),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    const create = f.orcaCalls('worktree create')[0]!.args;
    expect(flag(create, '--repo')).toBe('path:/repos/app');
    expect(flag(create, '--base-branch')).toBe('develop');
    expect(flag(create, '--setup')).toBe('skip');
    expect(f.orcaCalls('repo show')).toHaveLength(0);
  });

  it('처음 띄우는데 같은 브랜치가 있으면 숫자를 붙인 이름을 쓴다', async () => {
    const f = fake({ remote: ['feat/PROJ-1'] });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start({
      order: jiraOrder(),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    expect(flag(f.orcaCalls('worktree create')[0]!.args, '--branch')).toBe('feat/PROJ-1-2');
    expect(r.branch).toBe('feat/PROJ-1-2');
  });

  it('PR이 있는 주문은 새 브랜치를 안 만들고 지라 키와 PR 주소를 참조로 붙인다', async () => {
    const f = fake();
    await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start({
      order: jiraOrder({ prRef: 'acme/app#7' }),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    expect(f.orcaCalls('worktree create')[0]!.args).not.toContain('--branch');
    expect(f.calls.filter((c) => c.args[2] === 'ls-remote')).toHaveLength(0);
    expect(f.orcaCalls('reference add').map((c) => c.args[2])).toEqual([
      'PROJ-1',
      'https://github.com/acme/app/pull/7',
    ]);
  });

  it('참조를 못 붙여도 워커는 띄우고 경고 한 줄만 남긴다', async () => {
    const f = fake({ referenceFails: true });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start({
      order: jiraOrder(),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    expect(r.handle).toBe('ctx_1');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings![0]).toContain('ord-1: 워크트리에 참조 PROJ-1를 못 붙였어요');
  });

  it('하위 워크트리는 부모 아래 만들면서 브랜치를 주고 참조를 붙인다', async () => {
    const f = fake();
    const r = await orcaLauncher(f.runner).start({
      order: jiraOrder({ parentWorktree: '/wt/parent', baseBranch: 'feat-parent' }),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    // 겹치는 브랜치는 부모 워크트리에서 본다
    expect(f.gitCalls()[0]?.slice(0, 2)).toEqual(['-C', '/wt/parent']);
    const create = f.orcaCalls('worktree create')[0]!.args;
    expect(flag(create, '--parent-worktree')).toBe('path:/wt/parent');
    expect(flag(create, '--repo')).toBe('id:r1');
    expect(flag(create, '--base-branch')).toBe('feat-parent');
    expect(flag(create, '--branch')).toBe('feat/PROJ-1');
    expect(create).not.toContain('--no-parent');
    expect(f.orcaCalls('reference add')).toHaveLength(1);
    expect(r.branch).toBe('feat/PROJ-1');
  });

  it('워크트리를 만든 뒤 워커가 떴는지 모르면 워크트리를 남기고 지울 명령을 알린다', async () => {
    const f = fake({ workerStart: { code: 1, stdout: '', stderr: 'timeout' } });
    await expect(
      orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start({
        order: jiraOrder(),
        worker: worker('ord-1'),
        prompt: 'p',
      }),
    ).rejects.toThrow('orca worktree rm --worktree id:r1::/wt/ord-1-1 --delete-branch');
    expect(f.orcaCalls('worktree rm')).toHaveLength(0);
  });

  it('재개면 앞 브랜치에서 갈라 만든 뒤 앞 워크트리를 detach하고 그 브랜치로 바꾼다', async () => {
    const worktrees = [
      'worktree /repos/app',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /wt/ord-1-1',
      'HEAD bbb',
      'branch refs/heads/feat/PROJ-1',
      '',
      'worktree /wt/ord-1-2',
      'HEAD bbb',
      'branch refs/heads/tienne/ord-1-2',
      '',
    ].join('\n');
    const f = fake({ worktrees, createdBranch: 'tienne/ord-1-2' });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start({
      order: jiraOrder({ baseBranch: 'develop' }),
      worker: worker('ord-1', { attempt: 2 }),
      prompt: 'p',
      previousHandle: 'ctx_0',
      previousBranch: 'feat/PROJ-1',
      previousWorker: { orderId: 'ord-1', attempt: 1 },
    });
    const create = f.orcaCalls('worktree create')[0]!.args;
    expect(flag(create, '--base-branch')).toBe('feat/PROJ-1');
    expect(create).not.toContain('--branch');
    // 재개는 비어 있는 이름을 다시 고르지 않는다
    expect(f.calls.filter((c) => c.args[2] === 'ls-remote')).toHaveLength(0);
    expect(f.gitCalls()).toEqual([
      ['-C', '/repos/app', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      ['-C', '/wt/ord-1-2', 'worktree', 'list', '--porcelain'],
      ['-C', '/wt/ord-1-1', 'switch', '--detach'],
      ['-C', '/wt/ord-1-2', 'switch', 'feat/PROJ-1'],
      ['-C', '/wt/ord-1-2', 'branch', '-d', 'tienne/ord-1-2'],
    ]);
    expect(f.orcaCalls('reference add')).toHaveLength(1);
    expect(r.branch).toBe('feat/PROJ-1');
  });

  it('재개 워크트리는 기준 브랜치가 없어도 셋업을 건너뛴다', async () => {
    const f = fake({ createdBranch: 'tienne/ord-1-2' });
    await orcaLauncher(f.runner, { 'acme/app': '/repos/app' })
      .start({
        order: jiraOrder({ source: 'jira' }),
        worker: worker('ord-1', { attempt: 2 }),
        prompt: 'p',
        previousBranch: 'feat/PROJ-1',
      })
      .catch(() => undefined);
    const create = f.orcaCalls('worktree create')[0]!.args;
    expect(flag(create, '--setup')).toBe('skip');
  });

  it.each([
    ['레포 기본 브랜치', 'main', {}],
    ['기준 브랜치', 'develop', { baseBranch: 'develop' }],
  ])('기록된 앞 브랜치가 %s면 이어받지 않고 멈춘다', async (_label, previous, extra) => {
    const f = fake();
    await expect(
      orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start({
        order: jiraOrder(extra),
        worker: worker('ord-1', { attempt: 2 }),
        prompt: 'p',
        previousBranch: previous,
      }),
    ).rejects.toThrow(`앞 워커가 기록한 브랜치 ${previous}가 기준 브랜치나 레포 기본 브랜치라`);
    expect(f.orcaCalls('worktree create')).toHaveLength(0);
  });

  const notStarted = {
    code: 1,
    stdout: JSON.stringify({ ok: false, result: { status: 'failed', residualResources: [] } }),
    stderr: 'spawn failed',
  };

  it('재개 뒤 워커가 확실히 안 떴으면 워크트리만 지우고 detach한 앞 워크트리를 되돌린다', async () => {
    const f = fake({
      worktrees: held('/wt/ord-1-1'),
      workerStart: notStarted,
      createdBranch: 'tienne/ord-1-2',
    });
    await expect(
      orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start(resumeSpec()),
    ).rejects.toThrow('/wt/ord-1-1는 다시 feat/PROJ-1로 돌려 뒀어요');
    const rm = f.orcaCalls('worktree rm');
    expect(rm).toHaveLength(1);
    expect(rm[0]!.args).not.toContain('--delete-branch');
    expect(f.gitCalls().at(-1)).toEqual(['-C', '/wt/ord-1-1', 'switch', 'feat/PROJ-1']);
  });

  it('재개 뒤 워커가 떴는지 모르면 남은 워크트리 안내에 --delete-branch를 안 붙인다', async () => {
    const f = fake({
      worktrees: held('/wt/ord-1-1'),
      workerStart: { code: 1, stdout: '', stderr: 'timeout' },
      createdBranch: 'tienne/ord-1-2',
    });
    const err = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' })
      .start(resumeSpec())
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('`orca worktree rm --worktree id:r1::/wt/ord-1-2`');
    expect((err as Error).message).not.toContain('--delete-branch');
    expect(f.orcaCalls('worktree rm')).toHaveLength(0);
  });

  it('남은 워크트리를 못 지우면 rm 출력을 실패 사유에 붙인다', async () => {
    const f = fake({ workerStart: notStarted });
    const failing: CommandRunner = async (cmd, args, o) =>
      cmd === 'orca' && args[0] === 'worktree' && args[1] === 'rm'
        ? { code: 1, stdout: '', stderr: 'worktree is locked' }
        : f.runner(cmd, args, o);
    await expect(
      orcaLauncher(failing, { 'acme/app': '/repos/app' }).start({
        order: jiraOrder(),
        worker: worker('ord-1'),
        prompt: 'p',
      }),
    ).rejects.toThrow('워크트리를 못 지웠어요(worktree is locked)');
  });

  it('처음 띄운 워커가 확실히 안 떴으면 만든 브랜치까지 지운다', async () => {
    const f = fake({ workerStart: notStarted });
    await expect(
      orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start({
        order: jiraOrder(),
        worker: worker('ord-1'),
        prompt: 'p',
      }),
    ).rejects.toThrow('worker-start 실패');
    expect(f.orcaCalls('worktree rm')[0]!.args).toContain('--delete-branch');
  });

  const held = (holder: string) =>
    [
      `worktree ${holder}`,
      'HEAD bbb',
      'branch refs/heads/feat/PROJ-1',
      '',
      'worktree /wt/ord-1-2',
      'HEAD bbb',
      'branch refs/heads/tienne/ord-1-2',
      '',
    ].join('\n');
  const resumeSpec = (over: Partial<Parameters<OrcaLauncher['start']>[0]> = {}) => ({
    order: jiraOrder(),
    worker: worker('ord-1', { attempt: 2 }),
    prompt: 'p',
    previousBranch: 'feat/PROJ-1',
    previousWorker: { orderId: 'ord-1', attempt: 1 },
    ...over,
  });

  it('앞 브랜치를 앞 워커가 아닌 워크트리가 체크아웃하고 있으면 detach하지 않고 멈춘다', async () => {
    const f = fake({ worktrees: held('/repos/app'), createdBranch: 'tienne/ord-1-2' });
    const err = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' })
      .start(resumeSpec())
      .catch((e: Error) => e);
    expect((err as Error).message).toContain(
      '앞 워커가 아닌 워크트리(/repos/app)가 체크아웃하고 있어요',
    );
    // 새 워크트리는 아직 오르카 임시 브랜치를 쓰고 있어서 브랜치째 지워도 된다
    expect((err as Error).message).toContain(
      '`orca worktree rm --worktree id:r1::/wt/ord-1-2 --delete-branch`',
    );
    expect(f.gitCalls().some((a) => a.includes('--detach'))).toBe(false);
    expect(f.orcaCalls('orchestration worker-start')).toHaveLength(0);
    expect(f.orcaCalls('worktree rm')).toHaveLength(0);
  });

  it('임시 브랜치를 모르면 멈출 때 안내에 --delete-branch를 안 붙인다', async () => {
    const f = fake({ worktrees: held('/repos/app'), createdBranch: null });
    const err = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' })
      .start(resumeSpec())
      .catch((e: Error) => e);
    expect((err as Error).message).toContain('`orca worktree rm --worktree id:r1::/wt/ord-1-2`');
    expect((err as Error).message).not.toContain('--delete-branch');
  });

  it('앞 워커의 워크트리 경로를 못 읽으면 detach하지 않고 멈춘다', async () => {
    const f = fake({ worktrees: held('/wt/ord-1-1'), createdBranch: 'tienne/ord-1-2' });
    const failing: CommandRunner = async (cmd, args, o) =>
      cmd === 'orca' && args.join(' ').startsWith('worktree show --worktree name:ord-1-1')
        ? { code: 1, stdout: '', stderr: 'not found' }
        : f.runner(cmd, args, o);
    await expect(
      orcaLauncher(failing, { 'acme/app': '/repos/app' }).start(resumeSpec()),
    ).rejects.toThrow('앞 워커가 아닌 워크트리(/wt/ord-1-1)가 체크아웃하고 있어요');
    expect(f.gitCalls().some((a) => a.includes('--detach'))).toBe(false);
  });

  it('디렉토리만 지워진 앞 워크트리는 그 등록만 지우고 레포 전체를 prune하지 않는다', async () => {
    const worktrees = held('/wt/ord-1-1').replace(
      'branch refs/heads/feat/PROJ-1',
      'branch refs/heads/feat/PROJ-1\nprunable gitdir file points to non-existent location',
    );
    const f = fake({ worktrees, createdBranch: 'tienne/ord-1-2' });
    await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start(resumeSpec());
    expect(f.gitCalls()).toContainEqual([
      '-C',
      '/wt/ord-1-2',
      'worktree',
      'remove',
      '--force',
      '/wt/ord-1-1',
    ]);
    expect(f.gitCalls().some((a) => a.includes('prune') || a.includes('--detach'))).toBe(false);
  });

  it('prunable로 나와도 앞 워크트리 디렉토리가 남아 있으면 지우지 않고 멈춘다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launcher-prunable-'));
    try {
      const worktrees = held(dir).replace(
        'branch refs/heads/feat/PROJ-1',
        'branch refs/heads/feat/PROJ-1\nprunable gitdir file points to non-existent location',
      );
      const f = fake({ worktrees, createdBranch: 'tienne/ord-1-2', paths: { 'ord-1-1': dir } });
      const err = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' })
        .start(resumeSpec())
        .catch((e: Error) => e);
      expect((err as Error).message).toContain('디렉토리가 남아 있어 지우지 않았어요');
      expect(f.gitCalls().some((a) => a.includes('remove') || a.includes('--detach'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detach한 뒤 새 워크트리를 못 바꾸면 앞 워크트리를 다시 그 브랜치로 돌린다', async () => {
    const f = fake({ worktrees: held('/wt/ord-1-1'), createdBranch: 'tienne/ord-1-2' });
    const failing: CommandRunner = async (cmd, args, o) =>
      cmd === 'git' && args[1] === '/wt/ord-1-2' && args[2] === 'switch'
        ? { code: 1, stdout: '', stderr: 'fatal: would overwrite' }
        : f.runner(cmd, args, o);
    await expect(
      orcaLauncher(failing, { 'acme/app': '/repos/app' }).start(resumeSpec()),
    ).rejects.toThrow('/wt/ord-1-1는 다시 feat/PROJ-1로 돌려 뒀어요');
    expect(f.gitCalls()).toContainEqual(['-C', '/wt/ord-1-1', 'switch', 'feat/PROJ-1']);
  });

  it('앞 워크트리도 못 되돌리면 되돌릴 명령을 알린다', async () => {
    const f = fake({ worktrees: held('/wt/ord-1-1'), createdBranch: 'tienne/ord-1-2' });
    const failing: CommandRunner = async (cmd, args, o) =>
      cmd === 'git' && args[2] === 'switch' && args[3] !== '--detach'
        ? { code: 1, stdout: '', stderr: 'fatal: would overwrite' }
        : f.runner(cmd, args, o);
    await expect(
      orcaLauncher(failing, { 'acme/app': '/repos/app' }).start(resumeSpec()),
    ).rejects.toThrow(
      '/wt/ord-1-1가 detach된 채로 남았어요. `git -C /wt/ord-1-1 switch feat/PROJ-1`로 되돌려 주세요',
    );
  });

  it('임시 브랜치 이름을 못 읽으면 워커는 띄우고 확인할 자리를 경고한다', async () => {
    const f = fake({ worktrees: held('/wt/ord-1-1'), createdBranch: null });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start(resumeSpec());
    expect(r.branch).toBe('feat/PROJ-1');
    expect(r.warnings).toContain(
      'ord-1: 오르카가 만든 임시 브랜치를 못 읽어 지우지 못했어요. /wt/ord-1-2에서 git branch로 확인해 주세요',
    );
  });

  it('임시 브랜치를 못 지워도 워커는 띄우고 경고만 남긴다', async () => {
    const f = fake({ worktrees: held('/wt/ord-1-1'), createdBranch: 'tienne/ord-1-2' });
    const failing: CommandRunner = async (cmd, args, o) =>
      cmd === 'git' && args[2] === 'branch' && args[3] === '-d'
        ? { code: 1, stdout: '', stderr: 'error: not fully merged' }
        : f.runner(cmd, args, o);
    const r = await orcaLauncher(failing, { 'acme/app': '/repos/app' }).start(resumeSpec());
    expect(r.handle).toBe('ctx_1');
    expect(r.warnings?.join()).toContain('임시 브랜치 tienne/ord-1-2를 못 지웠어요');
  });

  it('브랜치 기록이 없는 옛 워커는 앞 워크트리가 체크아웃한 브랜치를 이어받는다', async () => {
    const f = fake({
      local: ['feat/PROJ-1'],
      createdBranch: 'tienne/ord-1-2',
      currentBranch: { '/wt/ord-1-1': 'tienne/ord-1-1' },
    });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start(
      resumeSpec({ previousBranch: undefined }),
    );
    expect(flag(f.orcaCalls('worktree create')[0]!.args, '--base-branch')).toBe('tienne/ord-1-1');
    expect(f.gitCalls()).toContainEqual(['-C', '/wt/ord-1-2', 'switch', 'tienne/ord-1-1']);
    expect(r.branch).toBe('tienne/ord-1-1');
    expect(r.warnings).toBeUndefined();
  });

  it('앞 워크트리 브랜치를 못 읽은 옛 워커는 남은 기본 이름 브랜치를 경고와 함께 이어받는다', async () => {
    const f = fake({ local: ['feat/PROJ-1'], createdBranch: 'tienne/ord-1-2' });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start(
      resumeSpec({ previousBranch: undefined }),
    );
    const create = f.orcaCalls('worktree create')[0]!.args;
    expect(flag(create, '--base-branch')).toBe('feat/PROJ-1');
    expect(create).not.toContain('--branch');
    expect(f.gitCalls()).toContainEqual(['-C', '/wt/ord-1-2', 'switch', 'feat/PROJ-1']);
    expect(r.branch).toBe('feat/PROJ-1');
    expect(r.warnings?.join()).toContain(
      '브랜치 기록이 없는 옛 워커라 기본 이름 feat/PROJ-1를 이어받았어요',
    );
  });

  it('앞 워크트리가 기준 브랜치에 있으면 그건 이어받지 않는다', async () => {
    const f = fake({
      createdBranch: 'tienne/ord-1-2',
      currentBranch: { '/wt/ord-1-1': 'develop' },
    });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start(
      resumeSpec({ previousBranch: undefined, order: jiraOrder({ baseBranch: 'develop' }) }),
    );
    expect(flag(f.orcaCalls('worktree create')[0]!.args, '--branch')).toBe('feat/PROJ-1');
    expect(r.branch).toBe('tienne/ord-1-2');
  });

  it('기준 브랜치가 없어도 앞 워크트리가 레포 기본 브랜치에 있으면 조용히 넘어간다', async () => {
    const f = fake({
      createdBranch: 'tienne/ord-1-2',
      currentBranch: { '/wt/ord-1-1': 'main' },
    });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start(
      resumeSpec({ previousBranch: undefined }),
    );
    expect(flag(f.orcaCalls('worktree create')[0]!.args, '--branch')).toBe('feat/PROJ-1');
    expect(r.warnings).toBeUndefined();
  });

  it('origin/HEAD가 가리키는 기본 브랜치도 이어받지 않는다', async () => {
    const f = fake({
      createdBranch: 'tienne/ord-1-2',
      currentBranch: { '/wt/ord-1-1': 'trunk' },
      originHead: 'origin/trunk',
    });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start(
      resumeSpec({ previousBranch: undefined }),
    );
    expect(flag(f.orcaCalls('worktree create')[0]!.args, '--branch')).toBe('feat/PROJ-1');
    expect(r.warnings).toBeUndefined();
  });

  it('앞 워크트리가 이 주문 몫이 아닌 브랜치에 있으면 이어받지 않고 경고한다', async () => {
    const f = fake({
      createdBranch: 'tienne/ord-1-2',
      currentBranch: { '/wt/ord-1-1': 'feat/OTHER-9' },
    });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start(
      resumeSpec({ previousBranch: undefined }),
    );
    expect(flag(f.orcaCalls('worktree create')[0]!.args, '--branch')).toBe('feat/PROJ-1');
    expect(r.warnings).toEqual([
      'ord-1: 앞 워크트리가 이 주문 몫이 아닌 브랜치 feat/OTHER-9에 있어 이어받지 않았어요',
    ]);
  });

  it('앞 워크트리가 기본 이름에 숫자를 붙인 브랜치에 있으면 이어받는다', async () => {
    const f = fake({
      local: ['feat/PROJ-1-2'],
      createdBranch: 'tienne/ord-1-2',
      currentBranch: { '/wt/ord-1-1': 'feat/PROJ-1-2' },
    });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start(
      resumeSpec({ previousBranch: undefined }),
    );
    expect(r.branch).toBe('feat/PROJ-1-2');
  });

  it('옛 워커 재개인데 기본 이름 브랜치가 없으면 비어 있는 이름을 새로 고른다', async () => {
    const f = fake();
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start(
      resumeSpec({ previousBranch: undefined }),
    );
    expect(flag(f.orcaCalls('worktree create')[0]!.args, '--branch')).toBe('feat/PROJ-1');
    expect(r.branch).toBe('feat/PROJ-1');
  });

  it('재개 때 앞 브랜치로 못 바꾸면 워커를 안 띄우고 남은 워크트리를 알린다', async () => {
    const f = fake();
    const failing: CommandRunner = async (cmd, args, o) =>
      cmd === 'git' && args.includes('switch')
        ? { code: 1, stdout: '', stderr: 'fatal: invalid reference' }
        : f.runner(cmd, args, o);
    await expect(
      orcaLauncher(failing, { 'acme/app': '/repos/app' }).start({
        order: jiraOrder(),
        worker: worker('ord-1', { attempt: 2 }),
        prompt: 'p',
        previousBranch: 'feat/PROJ-1',
      }),
    ).rejects.toThrow(/feat\/PROJ-1를 새 워크트리에 못 붙였어요.*orca worktree rm/);
    expect(f.orcaCalls('orchestration worker-start')).toHaveLength(0);
  });
});

describe('이름 꼴 확인', () => {
  it('지라 키 꼴이 아니면 참조를 안 붙인다', () => {
    expect(worktreeReferences({ issueKey: '-x', prRef: 'acme/app#3' })).toEqual([]);
  });

  it.each(['-x', 'a..b'])(
    '앞 브랜치가 %s면 git과 오르카를 하나도 안 부르고 멈춘다',
    async (bad) => {
      const f = fake();
      await expect(
        orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start({
          order: jiraOrder(),
          worker: worker('ord-1', { attempt: 2 }),
          prompt: 'p',
          previousBranch: bad,
        }),
      ).rejects.toThrow('브랜치 이름으로 쓸 수 없는 꼴이라 이어받지 못했어요');
      expect(f.calls).toHaveLength(0);
      const root = tempStateDir();
      const g = fake();
      await expect(
        new GitWorktreeLauncher({
          worktreeRoot: join(root, 'wt'),
          promptDir: join(root, 'prompts'),
          repoPaths: { 'acme/app': '/repos/app' },
          runner: g.runner,
        }).start({
          order: jiraOrder(),
          worker: worker('ord-1', { attempt: 2 }),
          prompt: 'p',
          previousBranch: bad,
        }),
      ).rejects.toThrow('브랜치 이름으로 쓸 수 없는 꼴이라 이어받지 못했어요');
      expect(g.calls).toHaveLength(0);
    },
  );

  it('create 응답에 브랜치가 없으면 계획한 이름 대신 실제 체크아웃을 기록한다', async () => {
    const f = fake({ createdBranch: null, currentBranch: 'feat/PROJ-1-2' });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start({
      order: jiraOrder(),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    expect(r.branch).toBe('feat/PROJ-1-2');
    expect(r.warnings).toBeUndefined();
  });

  it('create 응답에도 체크아웃에도 브랜치가 없으면 계획한 이름을 기록하고 경고한다', async () => {
    const f = fake({ createdBranch: null });
    const r = await orcaLauncher(f.runner, { 'acme/app': '/repos/app' }).start({
      order: jiraOrder(),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    expect(r.branch).toBe('feat/PROJ-1');
    expect(r.warnings).toEqual([
      'ord-1: 오르카가 실제 브랜치를 안 알려 줘 계획한 이름 feat/PROJ-1를 기록했어요',
    ]);
  });
});

describe('git 런처의 지라 주문', () => {
  function gitLauncher(runner: CommandRunner) {
    const root = tempStateDir();
    return {
      root,
      launcher: new GitWorktreeLauncher({
        worktreeRoot: join(root, 'wt'),
        promptDir: join(root, 'prompts'),
        repoPaths: { 'acme/app': '/repos/app' },
        runner,
      }),
    };
  }

  it('버그면 fix 브랜치를 -b로 만들고 겹치면 숫자를 붙인다', async () => {
    const f = fake({ local: ['fix/PROJ-1'] });
    const { root, launcher } = gitLauncher(f.runner);
    const r = await launcher.start({
      order: jiraOrder({ issueType: 'sub-bug' }),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    expect(f.gitCalls().at(-1)).toEqual([
      '-C',
      '/repos/app',
      'worktree',
      'add',
      '-b',
      'fix/PROJ-1-2',
      join(root, 'wt', 'ord-1'),
    ]);
    expect(r.branch).toBe('fix/PROJ-1-2');
  });

  it('재개 때 디렉토리가 사라졌으면 앞 브랜치를 그대로 붙인다', async () => {
    const f = fake({ local: ['feat/PROJ-1'] });
    const { root, launcher } = gitLauncher(f.runner);
    const gone = join(root, 'wt', 'ord-1');
    const r = await launcher.start({
      order: jiraOrder(),
      worker: worker('ord-1', { attempt: 2 }),
      prompt: 'p',
      previousHandle: gone,
      previousBranch: 'feat/PROJ-1',
    });
    expect(f.gitCalls().at(-1)).toEqual([
      '-C',
      '/repos/app',
      'worktree',
      'add',
      gone,
      'feat/PROJ-1',
    ]);
    expect(f.calls.filter((c) => c.args[2] === 'ls-remote')).toHaveLength(0);
    expect(r.branch).toBe('feat/PROJ-1');
  });

  it('앞 워크트리가 남아 있으면 그 워크트리가 체크아웃한 브랜치를 기록한다', async () => {
    const f = fake({ currentBranch: 'feat/PROJ-1' });
    const { root, launcher } = gitLauncher(f.runner);
    const prev = join(root, 'prev');
    mkdirSync(prev);
    const r = await launcher.start({
      order: jiraOrder(),
      worker: worker('ord-1', { attempt: 2 }),
      prompt: 'p',
      previousHandle: prev,
      previousBranch: 'feat/PROJ-1',
    });
    expect(f.gitCalls()).toEqual([
      ['-C', prev, 'branch', '--show-current'],
      ['-C', prev, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
    ]);
    expect(r).toMatchObject({ handle: prev, branch: 'feat/PROJ-1' });
  });

  it('남은 앞 워크트리가 기본 브랜치를 체크아웃하고 있으면 브랜치를 기록하지 않고 경고한다', async () => {
    const f = fake({ currentBranch: 'trunk', originHead: 'origin/trunk' });
    const { root, launcher } = gitLauncher(f.runner);
    const prev = join(root, 'prev');
    mkdirSync(prev);
    const r = await launcher.start({
      order: jiraOrder(),
      worker: worker('ord-1', { attempt: 2 }),
      prompt: 'p',
      previousHandle: prev,
    });
    expect(r.branch).toBeUndefined();
    expect(r.warnings).toEqual([
      `ord-1: ${prev}가 기준 브랜치나 기본 브랜치 trunk를 체크아웃하고 있어 워커 브랜치로 기록하지 않았어요`,
    ]);
  });

  it('기록된 앞 브랜치가 기준 브랜치면 git 워크트리를 만들지 않고 멈춘다', async () => {
    const f = fake({ local: ['develop'] });
    const { launcher } = gitLauncher(f.runner);
    await expect(
      launcher.start({
        order: jiraOrder({ baseBranch: 'develop' }),
        worker: worker('ord-1', { attempt: 2 }),
        prompt: 'p',
        previousBranch: 'develop',
      }),
    ).rejects.toThrow('기준 브랜치나 레포 기본 브랜치라 이어받지 않았어요');
    expect(f.gitCalls().some((a) => a[2] === 'worktree')).toBe(false);
  });

  it('남은 앞 워크트리가 detach 상태면 브랜치를 기록하지 않고 경고한다', async () => {
    const f = fake();
    const { root, launcher } = gitLauncher(f.runner);
    const prev = join(root, 'prev');
    mkdirSync(prev);
    const r = await launcher.start({
      order: jiraOrder(),
      worker: worker('ord-1', { attempt: 2 }),
      prompt: 'p',
      previousHandle: prev,
    });
    expect(r.branch).toBeUndefined();
    expect(r.warnings?.join()).toContain('detach 상태');
  });

  it('기록한 앞 브랜치가 로컬에 없으면 새로 갈라 띄우지 않고 멈춘다', async () => {
    const f = fake();
    const { launcher } = gitLauncher(f.runner);
    await expect(
      launcher.start({
        order: jiraOrder(),
        worker: worker('ord-1', { attempt: 2 }),
        prompt: 'p',
        previousBranch: 'feat/PROJ-1',
      }),
    ).rejects.toThrow('앞 워커가 쓰던 브랜치 feat/PROJ-1가 로컬에 없어 이어받지 못했어요');
    expect(f.gitCalls().some((a) => a[2] === 'worktree')).toBe(false);
  });

  it('브랜치 기록이 없는 옛 워커는 예전 이름 conductor/<주문 id>가 남아 있으면 그걸 이어받는다', async () => {
    const f = fake({ local: ['conductor/ord-1', 'feat/PROJ-1'] });
    const { root, launcher } = gitLauncher(f.runner);
    const r = await launcher.start({
      order: jiraOrder(),
      worker: worker('ord-1', { attempt: 2 }),
      prompt: 'p',
      previousWorker: { orderId: 'ord-1', attempt: 1 },
    });
    expect(f.gitCalls().at(-1)).toEqual([
      '-C',
      '/repos/app',
      'worktree',
      'add',
      join(root, 'wt', 'ord-1'),
      'conductor/ord-1',
    ]);
    expect(r.branch).toBe('conductor/ord-1');
    expect(r.warnings).toBeUndefined();
  });

  it('브랜치 기록이 없는 옛 워커를 재개하면 남은 기본 이름 브랜치를 경고와 함께 이어받는다', async () => {
    const f = fake({ local: ['feat/PROJ-1'] });
    const { root, launcher } = gitLauncher(f.runner);
    const r = await launcher.start({
      order: jiraOrder(),
      worker: worker('ord-1', { attempt: 2 }),
      prompt: 'p',
      previousWorker: { orderId: 'ord-1', attempt: 1 },
    });
    expect(f.gitCalls().at(-1)).toEqual([
      '-C',
      '/repos/app',
      'worktree',
      'add',
      join(root, 'wt', 'ord-1'),
      'feat/PROJ-1',
    ]);
    expect(r.branch).toBe('feat/PROJ-1');
    expect(r.warnings?.join()).toContain('기본 이름 feat/PROJ-1를 이어받았어요');
  });

  it('지라 키가 없으면 지금처럼 conductor/<주문 id>를 쓴다', async () => {
    const f = fake();
    const { launcher } = gitLauncher(f.runner);
    const r = await launcher.start({
      order: order({ id: 'ord-1' }),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    expect(f.gitCalls().at(-1)).toContain('conductor/ord-1');
    expect(f.calls.filter((c) => c.args[2] === 'ls-remote')).toHaveLength(0);
    expect(r.branch).toBe('conductor/ord-1');
  });
});
