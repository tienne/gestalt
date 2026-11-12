import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  remoteMatches,
  resolveParentWorktree,
  worktreeField,
  type SyncExec,
} from '../../../src/conductor/parent-worktree.js';
import {
  GitWorktreeLauncher,
  OrcaLauncher,
  type CommandRunner,
} from '../../../src/conductor/launcher.js';
import { intakeOrder, isRefName, parseQueueBody } from '../../../src/conductor/intake.js';
import { ConductorStore } from '../../../src/conductor/store.js';
import { cleanupStateDirs, order, tempStateDir, worker } from './fixtures.js';

afterEach(cleanupStateDirs);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** origin이 owner/name을 가리키는 레포 하나와 그 워크트리 하나를 만든다 */
function repoWithWorktree(remote: string) {
  const root = resolve(tempStateDir());
  const main = join(root, 'main');
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'remote', 'add', 'origin', remote);
  git(
    main,
    '-c',
    'user.email=t@t',
    '-c',
    'user.name=t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'i',
  );
  const wt = join(root, 'feat');
  git(main, 'worktree', 'add', '-q', '-b', 'feat', wt);
  return { main: realpathSync(main), wt: realpathSync(wt) };
}

describe('부모 워크트리 확인', () => {
  it('origin이 주문 레포와 맞는 워크트리 경로는 루트 절대 경로로 풀린다', () => {
    const { wt } = repoWithWorktree('git@github.com:acme/app.git');
    const sub = join(wt, 'src');
    mkdirSync(sub);
    expect(resolveParentWorktree(sub, 'acme/app', { repoPaths: {} })).toBe(wt);
    expect(resolveParentWorktree(`path:${wt}`, 'acme/app', { repoPaths: {} })).toBe(wt);
  });

  it('origin이 다른 레포면 거절한다', () => {
    const { wt } = repoWithWorktree('https://github.com/acme/other');
    expect(() => resolveParentWorktree(wt, 'acme/app', { repoPaths: {} })).toThrow(/origin/);
  });

  it('없는 경로나 git이 아닌 디렉토리는 거절한다', () => {
    const dir = resolve(tempStateDir());
    expect(() => resolveParentWorktree(join(dir, 'nope'), 'acme/app', { repoPaths: {} })).toThrow(
      /경로가 없어요/,
    );
  });

  it('repoPaths에 레포가 있으면 git 공용 디렉토리로 같은 레포인지 본다', () => {
    const a = repoWithWorktree('git@github.com:acme/app.git');
    const b = repoWithWorktree('git@github.com:acme/app.git');
    expect(resolveParentWorktree(a.wt, 'acme/app', { repoPaths: { 'acme/app': a.main } })).toBe(
      a.wt,
    );
    // origin은 같아도 다른 체크아웃의 워크트리면 런처가 고를 레포와 어긋난다
    expect(() =>
      resolveParentWorktree(b.wt, 'acme/app', { repoPaths: { 'acme/app': a.main } }),
    ).toThrow(/워크트리가 아니에요/);
  });

  it('오르카 선택자는 worktree show로 경로를 받아 같은 확인을 거친다', () => {
    const { wt } = repoWithWorktree('git@github.com:acme/app.git');
    const seen: string[][] = [];
    const exec: SyncExec = (cmd, args) => {
      if (cmd === 'orca') {
        seen.push(args);
        return JSON.stringify({ ok: true, result: { worktree: { path: wt } } });
      }
      return execFileSync(cmd, args, { encoding: 'utf8' });
    };
    expect(
      resolveParentWorktree('branch:feat', 'acme/app', {
        repoPaths: {},
        orcaCommand: 'orca',
        exec,
      }),
    ).toBe(wt);
    expect(seen[0]).toEqual(['worktree', 'show', '--worktree', 'branch:feat', '--json']);
    expect(() => resolveParentWorktree('branch:feat', 'acme/app', { repoPaths: {} })).toThrow(
      /오르카가 없어/,
    );
  });

  it('origin 주소 꼴을 가리지 않고 owner/name을 맞춘다', () => {
    expect(remoteMatches('git@github.com:Acme/App.git', 'acme/app')).toBe(true);
    expect(remoteMatches('https://github.com/acme/app/', 'acme/app')).toBe(true);
    expect(remoteMatches('https://github.com/acme/app-web.git', 'acme/app')).toBe(false);
  });

  it('오르카 응답이 실패면 칸을 못 읽은 것으로 본다', () => {
    expect(worktreeField('{"ok":false,"error":{}}', 'path')).toBeUndefined();
    expect(worktreeField('not json', 'path')).toBeUndefined();
  });
});

describe('기준 브랜치와 부모 워크트리 접수', () => {
  const config = { defaultScope: 'approval' as const };

  it('ref 이름 꼴만 받는다', () => {
    expect(isRefName('feat/BIZWAIT-6188')).toBe(true);
    expect(isRefName('origin/main')).toBe(true);
    for (const bad of ['-x', '--upload-pack=x', 'a..b', 'a/', 'a.lock', 'a b', 'a@{1}', ''])
      expect(isRefName(bad)).toBe(false);
  });

  it('주문에 부모와 기준 브랜치를 싣고 스냅샷을 다시 읽어도 남는다', () => {
    const dir = tempStateDir();
    const s = ConductorStore.open(dir);
    const { order: o } = intakeOrder(
      s,
      {
        source: 'spoken',
        repo: 'acme/app',
        title: '하위 작업',
        parentWorktree: '/w/feat',
        baseBranch: 'feat-1',
      },
      config,
    );
    expect(ConductorStore.open(dir).order(o.id)).toMatchObject({
      parentWorktree: '/w/feat',
      baseBranch: 'feat-1',
    });
    expect(() =>
      intakeOrder(s, { source: 'spoken', repo: 'acme/app', title: 'x', baseBranch: '-x' }, config),
    ).toThrow(/기준 브랜치/);
  });

  it('큐 메시지는 기준 브랜치만 받고 부모 워크트리는 거절한다', () => {
    expect(parseQueueBody({ repo: 'acme/app', title: 't', baseBranch: 'main' })).toMatchObject({
      baseBranch: 'main',
    });
    expect(parseQueueBody({ repo: 'acme/app', title: 't', baseBranch: '--x' })).toMatch(
      /baseBranch/,
    );
    expect(parseQueueBody({ repo: 'acme/app', title: 't', parentWorktree: '/w' })).toMatch(
      /parentWorktree/,
    );
  });
});

describe('런처가 부모와 기준 브랜치를 따른다', () => {
  const childId = 'repo-1::/w/ord-1-1';

  function orcaRunner(fail?: 'worker-start') {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      const key = args.slice(0, 2).join(' ');
      if (key === 'worktree show')
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, result: { worktree: { repoId: 'repo-1' } } }),
          stderr: '',
        };
      if (key === 'worktree create')
        return {
          code: 0,
          stdout: JSON.stringify({ ok: true, result: { worktree: { id: childId } } }),
          stderr: '',
        };
      if (key === 'orchestration worker-start' && fail === 'worker-start')
        return { code: 1, stdout: '', stderr: 'boom' };
      return { code: 0, stdout: '{"dispatchId":"ctx_9"}', stderr: '' };
    };
    return { calls, runner };
  }

  it('오르카 워커는 부모 아래 하위 워크트리를 먼저 만들고 그 워크트리로 띄운다', async () => {
    const { calls, runner } = orcaRunner();
    const l = new OrcaLauncher({ orcaCommand: 'orca', promptDir: tempStateDir(), runner });
    const o = order({ id: 'ord-1', parentWorktree: '/w/feat', baseBranch: 'feat' });
    const r = await l.start({ order: o, worker: worker('ord-1'), prompt: 'p' });
    expect(r.handle).toBe('ctx_9');
    expect(calls.map((c) => c.slice(0, 2).join(' '))).toEqual([
      'worktree show',
      'worktree create',
      'worktree set',
      'orchestration worker-start',
    ]);
    const create = calls[1]!;
    expect(create).toEqual(
      expect.arrayContaining(['--parent-worktree', 'path:/w/feat', '--base-branch', 'feat']),
    );
    expect(create[create.indexOf('--repo') + 1]).toBe('id:repo-1');
    expect(create[create.indexOf('--name') + 1]).toBe('ord-1-1');
    const start = calls[3]!;
    expect(start[start.indexOf('--worktree') + 1]).toBe(`id:${childId}`);
    // 기존 워크트리에는 생성 옵션을 못 넘긴다
    expect(start).not.toContain('--name');
    expect(start).not.toContain('--repo');
  });

  it('하위 워크트리를 만든 뒤 워커가 못 뜨면 워크트리를 지우고 실패를 올린다', async () => {
    const { calls, runner } = orcaRunner('worker-start');
    const l = new OrcaLauncher({ orcaCommand: 'orca', promptDir: tempStateDir(), runner });
    const o = order({ id: 'ord-1', parentWorktree: '/w/feat' });
    await expect(l.start({ order: o, worker: worker('ord-1'), prompt: 'p' })).rejects.toThrow(
      /boom/,
    );
    expect(calls.at(-1)).toEqual([
      'worktree',
      'rm',
      '--worktree',
      `id:${childId}`,
      '--delete-branch',
      '--json',
    ]);
  });

  it('부모 없이 기준 브랜치만 있으면 new-top-level에 --base-branch를 싣는다', async () => {
    const { calls, runner } = orcaRunner();
    const l = new OrcaLauncher({ orcaCommand: 'orca', promptDir: tempStateDir(), runner });
    await l.start({
      order: order({ id: 'ord-1', baseBranch: 'release/1' }),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(
      expect.arrayContaining(['new-top-level', '--base-branch', 'release/1']),
    );
  });

  it('git 워크트리 워커는 기준 브랜치에서 갈라지고 부모는 경고만 남긴다', async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_cmd, args) => {
      calls.push(args);
      return { code: args.includes('rev-parse') ? 1 : 0, stdout: '', stderr: '' };
    };
    const root = tempStateDir();
    const l = new GitWorktreeLauncher({
      worktreeRoot: join(root, 'wt'),
      promptDir: join(root, 'prompts'),
      repoPaths: { 'acme/app': '/repos/app' },
      runner,
    });
    const r = await l.start({
      order: order({ id: 'ord-1', parentWorktree: '/w/feat', baseBranch: 'feat' }),
      worker: worker('ord-1'),
      prompt: 'p',
    });
    expect(calls.at(-1)).toEqual([
      '-C',
      '/repos/app',
      'worktree',
      'add',
      '-b',
      'conductor/ord-1',
      join(root, 'wt', 'ord-1'),
      'feat',
    ]);
    expect(r.warnings?.[0]).toMatch(/부모 워크트리\(\/w\/feat\)를 무시/);
  });
});
