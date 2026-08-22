import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * 웹 UI 하나가 여러 레포를 보여주려면 어떤 레포가 있는지 알아야 한다.
 *
 * 이 목록은 `~/.gestalt/repos.json`에 있다. 테스트가 진짜 홈을 건드리면 안 된다.
 * homedir을 임시 자리로 돌려놓고 돈다.
 */

let fakeHome: string;
const savedHome = process.env['GESTALT_HOME'];

const registry = await import('../../../src/local-pr/registry.js');

function run(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), `gestalt-registry-${randomUUID().slice(0, 8)}-`));
  run(repo, ['init', '-q']);
  run(repo, ['config', 'user.email', 't@e.st']);
  run(repo, ['config', 'user.name', 'test']);
  writeFileSync(join(repo, 'a.txt'), 'x\n');
  run(repo, ['add', '-A']);
  run(repo, ['commit', '-q', '-m', 'init']);
  return repo;
}

describe('레포 레지스트리', () => {
  const repos: string[] = [];

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), `gestalt-home-${randomUUID().slice(0, 8)}-`));
    process.env['GESTALT_HOME'] = fakeHome;
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env['GESTALT_HOME'];
    else process.env['GESTALT_HOME'] = savedHome;
    rmSync(fakeHome, { recursive: true, force: true });
    for (const r of repos.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  it('등록한 레포가 목록에 뜬다', () => {
    const repo = makeRepo();
    repos.push(repo);

    registry.registerRepo(repo);

    expect(registry.listRepos().map((r) => r.key)).toEqual([registry.repoKey(repo)]);
  });

  it('같은 레포를 두 번 등록해도 한 줄이다', () => {
    const repo = makeRepo();
    repos.push(repo);

    registry.registerRepo(repo);
    registry.registerRepo(repo);

    expect(registry.listRepos()).toHaveLength(1);
  });

  it('워크트리에서 등록해도 본체와 같은 키다', () => {
    const repo = makeRepo();
    repos.push(repo);
    const wt = join(tmpdir(), `gestalt-wt-${randomUUID().slice(0, 8)}`);
    run(repo, ['worktree', 'add', '--detach', '-q', wt, 'HEAD']);

    try {
      // 워크트리 여럿이 저장소 하나를 공유하므로 목록에서도 한 줄이어야 한다
      expect(registry.repoKey(wt)).toBe(registry.repoKey(repo));

      registry.registerRepo(repo);
      registry.registerRepo(wt);

      expect(registry.listRepos()).toHaveLength(1);
    } finally {
      run(repo, ['worktree', 'remove', '--force', wt]);
    }
  });

  it('사라진 레포는 목록에서 뺀다', () => {
    const repo = makeRepo();
    registry.registerRepo(repo);
    rmSync(repo, { recursive: true, force: true });

    expect(registry.listRepos()).toHaveLength(0);
  });

  it('목록 파일이 깨져도 빈 목록으로 시작한다', () => {
    const repo = makeRepo();
    repos.push(repo);
    registry.registerRepo(repo);
    writeFileSync(join(fakeHome, '.gestalt', 'repos.json'), '{{{ 깨진 JSON', 'utf-8');

    // 손상된 목록 때문에 서버가 아예 안 뜨는 게 더 나쁘다
    expect(() => registry.listRepos()).not.toThrow();
    expect(registry.listRepos()).toHaveLength(0);
  });
});
