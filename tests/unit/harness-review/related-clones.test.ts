import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  prepareRelatedClones,
  pruneWorktreeClones,
  worktreeCloneRoot,
} from '../../../src/harness-review/related-clones.js';
import { LocalCloneBackend } from '../../../src/harness-review/search-backend.js';
import type { GhRunner } from '../../../src/review-loop/fetch.js';
import { cleanupFakeRepos, createFakeRepo, type FakeRepo } from '../../helpers/fake-repo.js';

const roots: string[] = [];

function tempDir(prefix: string): string {
  const dir = resolve('.gestalt-test', `${prefix}-${randomUUID()}`);
  roots.push(dir);
  return dir;
}

afterEach(() => {
  cleanupFakeRepos();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
}

/** gh repo clone을 upstream 레포의 file:// 클론으로 바꾼다. 네트워크를 안 탄다 */
function cloningGh(upstreams: Record<string, FakeRepo>, calls: string[][]): GhRunner {
  return (args) => {
    calls.push([...args]);
    if (args[0] === 'repo' && args[1] === 'clone') {
      const upstream = upstreams[args[2]!];
      if (!upstream) throw Object.assign(new Error('x'), { stderr: 'GraphQL: Could not resolve' });
      const extra = args.slice(args.indexOf('--') + 1);
      execFileSync('git', ['clone', '-q', ...extra, `file://${upstream.root}`, args[3]!], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return '';
    }
    throw new Error(`예상 밖 gh 호출: ${args.join(' ')}`);
  };
}

describe('prepareRelatedClones', () => {
  it('관리 클론이 없으면 기본 브랜치만 얕게 받고 다음엔 받지 않고 fetch만 한다', async () => {
    const upstream = createFakeRepo({ name: 'acme-app', files: { 'a.md': 'TOKEN v1\n' } });
    const cloneRoot = tempDir('clones');
    const calls: string[][] = [];
    const gh = cloningGh({ 'acme/acme-app': upstream }, calls);

    const first = prepareRelatedClones({ targets: [{ repo: 'acme/acme-app' }], cloneRoot, gh });
    const dir = join(cloneRoot, 'acme', 'acme-app');
    expect(first.failed).toEqual([]);
    expect(first.sources).toEqual([
      { repo: 'acme/acme-app', dir, ref: gitIn(dir, 'rev-parse', 'origin/main').trim() },
    ]);
    expect(calls).toHaveLength(1);
    const [cloneArgs] = calls;
    expect(cloneArgs!.slice(0, 3)).toEqual(['repo', 'clone', 'acme/acme-app']);
    expect(cloneArgs!.slice(4)).toEqual(['--', '--depth', '1', '--single-branch']);
    // 같은 자리에 바로 받지 않고 옆 임시 자리에 받아 옮긴다
    expect(cloneArgs![3]).toMatch(/\/acme\/\.clone-tmp-acme-app-/);
    expect(readdirSync(join(cloneRoot, 'acme'))).toEqual(['acme-app']);
    expect(gitIn(dir, 'rev-parse', '--is-shallow-repository').trim()).toBe('true');

    upstream.commit('v2', { 'a.md': 'TOKEN v2\n' });
    const second = prepareRelatedClones({ targets: [{ repo: 'acme/acme-app' }], cloneRoot, gh });
    expect(calls).toHaveLength(1);
    expect(second.limitations).toEqual([]);

    const hits = await new LocalCloneBackend(second.sources).search('TOKEN', ['acme/acme-app']);
    expect(hits.hits.map((h) => h.text)).toEqual(['TOKEN v2']);
  });

  it('사람이 준 클론을 먼저 쓰고 워킹트리가 아니라 fetch한 origin 기본 브랜치를 읽는다', async () => {
    const upstream = createFakeRepo({ name: 'kb', files: { 'doc.md': 'TOKEN upstream-v1\n' } });
    const userDir = tempDir('user-clone');
    execFileSync('git', ['clone', '-q', `file://${upstream.root}`, userDir], { stdio: 'ignore' });
    // 사람이 작업 중인 변경은 결과에 섞이면 안 된다
    writeFileSync(join(userDir, 'doc.md'), 'TOKEN local-edit\n');
    upstream.commit('v2', { 'doc.md': 'TOKEN upstream-v2\n' });

    const calls: string[][] = [];
    const prepared = prepareRelatedClones({
      targets: [{ repo: 'acme/kb', userDir }],
      cloneRoot: tempDir('clones'),
      gh: cloningGh({}, calls),
    });

    expect(calls).toEqual([]);
    expect(prepared.sources).toEqual([
      {
        repo: 'acme/kb',
        dir: resolve(userDir),
        ref: gitIn(userDir, 'rev-parse', 'origin/main').trim(),
      },
    ]);
    // 사람이 준 클론은 이력을 잘라 얕게 만들지 않는다
    expect(gitIn(userDir, 'rev-parse', '--is-shallow-repository').trim()).toBe('false');
    const r = await new LocalCloneBackend(prepared.sources).search('TOKEN', ['acme/kb']);
    expect(r.hits.map((h) => h.text)).toEqual(['TOKEN upstream-v2']);
  });

  it('fetch가 실패하면 있는 ref로 돌고 며칠 전 기준인지 남긴다', () => {
    const upstream = createFakeRepo({ name: 'kb', files: { 'doc.md': 'x\n' } });
    const userDir = tempDir('user-clone');
    execFileSync('git', ['clone', '-q', `file://${upstream.root}`, userDir], { stdio: 'ignore' });
    gitIn(userDir, 'remote', 'set-url', 'origin', join(userDir, 'no-such-remote'));
    const commitAt = Number(gitIn(userDir, 'log', '-1', '--format=%ct', 'origin/main').trim());

    const prepared = prepareRelatedClones({
      targets: [{ repo: 'acme/kb', userDir }],
      gh: cloningGh({}, []),
      now: new Date(commitAt * 1000 + 3 * 24 * 60 * 60 * 1000 + 1000),
    });

    expect(prepared.failed).toEqual([]);
    expect(prepared.sources).toHaveLength(1);
    expect(prepared.limitations).toEqual([
      expect.stringMatching(/^acme\/kb: fetch가 실패해 origin\/main를 3일 전 커밋 기준으로 봤다/),
    ]);
  });

  it('클론을 못 받으면 failed와 limitations에 남기고 예외를 던지지 않는다', () => {
    const cloneRoot = tempDir('clones');
    const prepared = prepareRelatedClones({
      targets: [{ repo: 'acme/secret' }, { repo: '../escape' }],
      cloneRoot,
      gh: cloningGh({}, []),
    });

    expect(prepared.sources).toEqual([]);
    expect(prepared.failed.map((f) => f.repo)).toEqual(['acme/secret', '../escape']);
    expect(prepared.limitations[0]).toMatch(
      /^acme\/secret: 로컬 클론을 못 얻어 GitHub 검색으로 넘겼다/,
    );
    expect(existsSync(join(cloneRoot, '..', 'escape'))).toBe(false);
  });

  it('--repo-dir 경로가 없으면 그 레포만 실패로 돌린다', () => {
    const prepared = prepareRelatedClones({
      targets: [{ repo: 'acme/kb', userDir: tempDir('missing') }],
      gh: cloningGh({}, []),
    });
    expect(prepared.failed).toEqual([
      expect.objectContaining({ repo: 'acme/kb', reason: expect.stringContaining('--repo-dir') }),
    ]);
  });

  it('ref를 커밋으로 고정해 검색 도중 다른 수집이 fetch해도 같은 커밋을 본다', async () => {
    const upstream = createFakeRepo({ name: 'kb', files: { 'doc.md': 'TOKEN v1\n' } });
    const cloneRoot = tempDir('clones');
    const gh = cloningGh({ 'acme/kb': upstream }, []);
    const prepared = prepareRelatedClones({ targets: [{ repo: 'acme/kb' }], cloneRoot, gh });

    upstream.commit('v2', { 'doc.md': 'TOKEN v2\n' });
    // 다른 워크트리의 수집이 같은 클론을 fetch해 ref를 옮긴다
    prepareRelatedClones({ targets: [{ repo: 'acme/kb' }], cloneRoot, gh });

    const r = await new LocalCloneBackend(prepared.sources).search('TOKEN', ['acme/kb']);
    expect(r.hits.map((h) => h.text)).toEqual(['TOKEN v1']);
  });

  it('다른 수집이 먼저 클론을 옮겨 놓았으면 그 클론을 쓰고 임시 자리를 치운다', () => {
    const upstream = createFakeRepo({ name: 'kb', files: { 'doc.md': 'x\n' } });
    const cloneRoot = tempDir('clones');
    const finalDir = join(cloneRoot, 'acme', 'kb');
    const inner = cloningGh({ 'acme/kb': upstream }, []);
    const racingGh: GhRunner = (args) => {
      // 이 수집이 받는 사이 다른 수집이 받기를 끝내고 자리를 차지한다
      execFileSync('git', ['clone', '-q', `file://${upstream.root}`, finalDir], {
        stdio: 'ignore',
      });
      return inner(args);
    };

    const prepared = prepareRelatedClones({
      targets: [{ repo: 'acme/kb' }],
      cloneRoot,
      gh: racingGh,
    });

    expect(prepared.failed).toEqual([]);
    expect(prepared.sources.map((x) => x.dir)).toEqual([finalDir]);
    expect(readdirSync(join(cloneRoot, 'acme'))).toEqual(['kb']);
  });

  it('한 시간 넘게 남은 임시 클론만 치운다', () => {
    const upstream = createFakeRepo({ name: 'kb', files: { 'doc.md': 'x\n' } });
    const cloneRoot = tempDir('clones');
    const parent = join(cloneRoot, 'acme');
    const stale = join(parent, '.clone-tmp-kb-old');
    const live = join(parent, '.clone-tmp-kb-live');
    mkdirSync(stale, { recursive: true });
    mkdirSync(live, { recursive: true });
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);

    prepareRelatedClones({
      targets: [{ repo: 'acme/kb' }],
      cloneRoot,
      gh: cloningGh({ 'acme/kb': upstream }, []),
    });

    expect(existsSync(stale)).toBe(false);
    expect(existsSync(live)).toBe(true);
  });

  describe('fetch 잠금', () => {
    const LOCK_ERR = Object.assign(new Error('git fetch'), {
      // 실제 git이 내는 꼴 그대로. 원인은 첫 줄에만 있다
      stderr: [
        "fatal: Unable to create '/x/.git/shallow.lock': File exists.",
        '',
        'Another git process seems to be running in this repository.',
        'remove the file manually to continue.',
      ].join('\n'),
    });

    function setup() {
      const upstream = createFakeRepo({ name: 'kb', files: { 'doc.md': 'x\n' } });
      const userDir = tempDir('user-clone');
      execFileSync('git', ['clone', '-q', `file://${upstream.root}`, userDir], {
        stdio: 'ignore',
      });
      return userDir;
    }

    function lockingGit(locks: number) {
      let left = locks;
      return (dir: string, args: readonly string[]) => {
        if (args[0] === 'fetch' && left-- > 0) throw LOCK_ERR;
        return gitIn(dir, ...args);
      };
    }

    it('잠금이 풀리면 다시 fetch하고 limitations에 남기지 않는다', () => {
      const userDir = setup();
      const waits: number[] = [];
      const prepared = prepareRelatedClones({
        targets: [{ repo: 'acme/kb', userDir }],
        gh: cloningGh({}, []),
        git: lockingGit(1),
        wait: (ms) => waits.push(ms),
      });
      expect(waits).toEqual([1_000]);
      expect(prepared.limitations).toEqual([]);
      expect(prepared.sources).toHaveLength(1);
    });

    it('재시도를 다 써도 잠금 파일이 남아 있으면 있는 ref로 돌고 다른 수집 때문이라고 남긴다', () => {
      const userDir = setup();
      const waits: number[] = [];
      const prepared = prepareRelatedClones({
        targets: [{ repo: 'acme/kb', userDir }],
        gh: cloningGh({}, []),
        git: lockingGit(99),
        wait: (ms) => waits.push(ms),
      });
      expect(waits).toEqual([1_000, 2_000, 4_000]);
      expect(prepared.sources).toHaveLength(1);
      expect(prepared.limitations).toEqual([
        expect.stringMatching(
          /^acme\/kb: 다른 수집이 같은 클론을 받는 중이라 fetch를 못 해 .*\(fatal: Unable to create '\/x\/\.git\/shallow\.lock'/,
        ),
      ]);
    });

    it('잠금이 아닌 실패는 다시 시도하지 않는다', () => {
      const userDir = setup();
      gitIn(userDir, 'remote', 'set-url', 'origin', join(userDir, 'no-such-remote'));
      const waits: number[] = [];
      prepareRelatedClones({
        targets: [{ repo: 'acme/kb', userDir }],
        gh: cloningGh({}, []),
        wait: (ms) => waits.push(ms),
      });
      expect(waits).toEqual([]);
    });
  });
});

describe('워크트리별 클론 루트', () => {
  it('같은 이름의 워크트리라도 경로가 다르면 루트가 갈리고 같은 경로면 같다', () => {
    const base = tempDir('clones');
    const a = tempDir('wt');
    const b = join(tempDir('other'), basename(a));
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });

    const ra = worktreeCloneRoot(base, a);
    expect(worktreeCloneRoot(base, a)).toBe(ra);
    expect(worktreeCloneRoot(base, b)).not.toBe(ra);
    expect(basename(ra)).toMatch(new RegExp(`^${basename(a)}-[0-9a-f]{8}$`));
  });

  function threeRoots() {
    const base = tempDir('clones');
    const mk = () => {
      const wt = tempDir('wt');
      mkdirSync(wt, { recursive: true });
      return { wt, root: worktreeCloneRoot(base, wt) };
    };
    const alive = mk();
    const gone = mk();
    const idle = mk();
    rmSync(gone.wt, { recursive: true });
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(idle.root, '.worktree'), old, old);
    const unknown = join(base, 'someone-else');
    mkdirSync(unknown);
    return { base, alive, gone, idle, unknown };
  }

  it('워크트리가 사라졌거나 7일 넘게 안 쓴 루트를 치우고 표시 없는 디렉토리는 그대로 둔다', () => {
    const { base, alive, gone, idle, unknown } = threeRoots();

    const pruned = pruneWorktreeClones(base);

    expect(pruned.map((p) => [p.root, p.reason]).sort()).toEqual(
      [
        [gone.root, 'worktreeGone'],
        [idle.root, 'idle'],
      ].sort(),
    );
    expect(existsSync(alive.root)).toBe(true);
    expect(existsSync(unknown)).toBe(true);
  });

  it('다시 쓰면 쓴 시각이 갱신돼 오래 안 쓴 루트에서 빠진다', () => {
    const { base, idle } = threeRoots();
    worktreeCloneRoot(base, idle.wt);
    expect(pruneWorktreeClones(base).map((p) => p.reason)).toEqual(['worktreeGone']);
  });

  it('all이면 표시 없는 디렉토리까지 전부 지운다', () => {
    const { base } = threeRoots();
    expect(pruneWorktreeClones(base, { all: true })).toHaveLength(4);
    expect(readdirSync(base)).toEqual([]);
  });
});
