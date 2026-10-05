import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  encodeClaudeProjectDir,
  findClaudeProjectMemoryDirs,
  listWorktreePaths,
  normalizeRemoteUrl,
} from '../../../src/utils/claude-projects.js';
import { cleanupFakeRepos, createFakeRepo } from '../../helpers/fake-repo.js';

const tmpRoots: string[] = [];

function makeProjectsRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'claude-projects-'));
  tmpRoots.push(dir);
  return dir;
}

function seedMemory(projectsRoot: string, absPath: string): string {
  const mem = join(projectsRoot, encodeClaudeProjectDir(absPath), 'memory');
  mkdirSync(mem, { recursive: true });
  return mem;
}

afterEach(() => {
  cleanupFakeRepos();
  for (const d of tmpRoots.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('encodeClaudeProjectDir', () => {
  it('영숫자와 하이픈 밖 문자를 전부 하이픈으로 바꾼다', () => {
    expect(encodeClaudeProjectDir('/a/b.c')).toBe('-a-b-c');
    expect(encodeClaudeProjectDir('/a/b_c d')).toBe('-a-b-c-d');
  });
});

describe('normalizeRemoteUrl', () => {
  it('scp, https, ssh 형식이 같은 키로 모인다', () => {
    const keys = [
      'git@GitHub.com:acme/widget.git',
      'https://github.com/acme/widget.git',
      'ssh://git@github.com/acme/widget',
      'https://github.com/acme/widget/',
      'ssh://git@github.com:22/acme/widget.git',
    ].map(normalizeRemoteUrl);
    expect(new Set(keys)).toEqual(new Set(['github.com/acme/widget']));
  });
});

describe('findClaudeProjectMemoryDirs', () => {
  it('같은 remote의 본 레포와 워크트리 메모리만 묶는다', () => {
    const remote = 'git@github.com:acme/widget.git';
    const main = createFakeRepo({ name: 'widget', remote });
    const other = createFakeRepo({ name: 'gadget', remote: 'git@github.com:acme/gadget.git' });
    // 워크트리는 고유 디렉토리 아래 둔다. 공용 상위에 두면 재실행 때 경로가 겹쳐 worktree add가 실패한다.
    const wtBase = mkdtempSync(join(main.root, '..', 'wt-'));
    tmpRoots.push(wtBase);
    const wt1 = join(wtBase, 'wt-one');
    const wt2 = join(wtBase, 'wt.two');
    main.git('worktree', 'add', '-q', '-b', 'one', wt1);
    main.git('worktree', 'add', '-q', '-b', 'two', wt2);

    expect(listWorktreePaths(main.root).length).toBe(3);

    const projectsRoot = makeProjectsRoot();
    const m0 = seedMemory(projectsRoot, main.root);
    const m1 = seedMemory(projectsRoot, wt1);
    const m2 = seedMemory(projectsRoot, wt2);
    seedMemory(projectsRoot, other.root);

    const res = findClaudeProjectMemoryDirs({ repoRoot: main.root, projectsRoot });
    expect(res.remoteKey).toBe('github.com/acme/widget');
    expect(res.memoryDirs).toEqual([m0, m1, m2].sort());
    expect(res.matchedPaths.length).toBe(3);
  });

  it('워크트리 목록에 없는 같은 remote 클론도 복원해서 묶는다', () => {
    const remote = 'git@github.com:acme/widget.git';
    const main = createFakeRepo({ name: 'widget', remote });
    const clone = createFakeRepo({
      name: 'widget-clone',
      remote: 'https://github.com/acme/widget.git',
    });
    const projectsRoot = makeProjectsRoot();
    const m0 = seedMemory(projectsRoot, main.root);
    const m1 = seedMemory(projectsRoot, clone.root);

    const res = findClaudeProjectMemoryDirs({ repoRoot: main.root, projectsRoot });
    expect(res.memoryDirs).toEqual([m0, m1].sort());
  });

  it('remote가 없으면 remoteKey null에 1차 결과만 돌려준다', () => {
    const main = createFakeRepo({ name: 'solo', remote: false });
    const other = createFakeRepo({ name: 'solo-2', remote: false });
    const projectsRoot = makeProjectsRoot();
    const m0 = seedMemory(projectsRoot, main.root);
    seedMemory(projectsRoot, other.root);

    const res = findClaudeProjectMemoryDirs({ repoRoot: main.root, projectsRoot });
    expect(res.remoteKey).toBeNull();
    expect(res.memoryDirs).toEqual([m0]);
  });

  it('extraRoots와 주입한 execGit을 쓴다', () => {
    const projectsRoot = makeProjectsRoot();
    const fakeRoot = join(tmpdir(), 'nowhere-repo');
    const extra = join(tmpdir(), 'nowhere-extra');
    const m = seedMemory(projectsRoot, extra);
    const res = findClaudeProjectMemoryDirs({
      repoRoot: fakeRoot,
      projectsRoot,
      extraRoots: [extra],
      execGit: () => {
        throw new Error('no git');
      },
    });
    expect(res.remoteKey).toBeNull();
    expect(res.memoryDirs).toEqual([m]);
  });
});
