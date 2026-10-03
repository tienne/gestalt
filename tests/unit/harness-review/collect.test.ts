import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectReferenceCandidates,
  parseRepoDirs,
  type CollectResult,
} from '../../../src/harness-review/collect.js';
import {
  GithubCodeSearchAdapter,
  orgWildcard,
} from '../../../src/harness-review/github-code-search.js';
import type { GhRunner } from '../../../src/review-loop/fetch.js';
import {
  buildIsolatedOrg,
  buildNoRemoteRepo,
  buildReceiveOnlyOrg,
} from '../../fixtures/harness-repos/scenarios.js';
import { cleanupFakeRepos } from '../../helpers/fake-repo.js';

const offlineGh: GhRunner = () => {
  throw new Error('테스트에서는 gh를 부르지 않는다');
};

const CROSS_REPO_KINDS = ['forwardRef', 'backwardRef', 'knowledgeDoc'] as const;

function crossRepoCount(r: CollectResult): number {
  return CROSS_REPO_KINDS.reduce((n, k) => n + r.counts[k], 0);
}

afterEach(() => cleanupFakeRepos());

describe('collectReferenceCandidates — e2e (로컬 clone 백엔드)', () => {
  it('참조를 주지도 받지도 않는 레포는 레포 간 후보가 0건이다', async () => {
    const s = buildIsolatedOrg();
    const lonely = s.org.repos[s.isolated]!;
    const result = await collectReferenceCandidates({
      repoRoot: lonely.root,
      base: s.change.baseSha,
      head: s.change.headSha,
      backend: 'local',
      repoDirs: Object.values(s.org.repos).map((r) => r.root),
      gh: offlineGh,
    });

    expect(result.repo).toBe('acme/lonely-kit');
    expect(result.searchedRepos).toEqual(['acme/acme-app']);
    expect(crossRepoCount(result)).toBe(0);
    // 레포 안 검출기도 걸 게 없는 변경이라 리뷰어에게 넘길 후보가 아예 없다
    expect(Object.values(result.counts).every((n) => n === 0)).toBe(true);
    expect(result.noGitHubRemote).toBe(false);
    expect(result.lookupBlocked).toEqual([]);
    expect(result.referenceCheckSkipped).toBe(false);
    expect(Object.values(result.detectors).every((d) => d.status === 'ok')).toBe(true);
  });

  it('받기만 하는 레포에서 이름을 바꾸면 역방향 후보만 나오고 순방향은 0건이다', async () => {
    const s = buildReceiveOnlyOrg();
    const receiver = s.org.repos[s.receiver]!;
    const result = await collectReferenceCandidates({
      repoRoot: receiver.root,
      base: s.rename.baseSha,
      head: s.rename.headSha,
      backend: 'local',
      repoDirs: [s.org.repos[s.caller.repo]!.root],
      gh: offlineGh,
    });

    expect(result.relatedRepos).toEqual([]);
    expect(result.counts.forwardRef).toBe(0);
    expect(result.counts.backwardRef).toBeGreaterThan(0);
    expect(result.candidates.backwardRef).toContainEqual(
      expect.objectContaining({
        kind: 'backwardRef',
        targetRepo: 'acme/acme-app',
        targetPath: s.caller.file,
        matchedText: s.rename.oldName,
      }),
    );
    expect(result.referenceCheckSkipped).toBe(false);
  });

  it('GitHub 원격이 없으면 참조 검사를 리뷰 불가로 표시하고 레포 안 검출기는 그대로 돈다', async () => {
    const s = buildNoRemoteRepo();
    const result = await collectReferenceCandidates({
      repoRoot: s.repo.root,
      base: s.change.baseSha,
      head: s.change.headSha,
      backend: 'github',
      gh: offlineGh,
    });

    expect(result.noGitHubRemote).toBe(true);
    expect(result.org).toBeNull();
    expect(result.referenceCheckSkipped).toBe(true);
    expect(result.detectors.backwardSearch.status).toBe('skipped');
    expect(result.detectors.selfContamination.status).toBe('ok');
    expect(result.detectors.copyDrift.status).toBe('ok');
    expect(result.detectors.forwardSearch.status).toBe('ok');
  });

  it('없는 커밋을 주면 해당 검출기만 skipped로 적고 예외를 던지지 않는다', async () => {
    const s = buildIsolatedOrg();
    const lonely = s.org.repos[s.isolated]!;
    const result = await collectReferenceCandidates({
      repoRoot: lonely.root,
      base: 'deadbeef',
      head: s.change.headSha,
      backend: 'local',
      gh: offlineGh,
    });

    expect(result.detectors.relatedRepos.status).toBe('ok');
    expect(result.detectors.copyDrift.status).toBe('skipped');
    expect(result.detectors.identifiers.status).toBe('skipped');
    expect(result.detectors.backwardSearch).toEqual({
      status: 'skipped',
      reason: '식별자를 뽑지 못했다',
    });
    expect(result.referenceCheckSkipped).toBe(true);
    expect(result.limitations.some((l) => l.startsWith('copyDrift 검출기를 건너뛰었다'))).toBe(
      true,
    );
  });

  it('GitHub 백엔드가 막히면 조회 막힘으로 올리고 PR을 막지 않는다', async () => {
    const s = buildReceiveOnlyOrg();
    const receiver = s.org.repos[s.receiver]!;
    const calls: string[][] = [];
    const gh: GhRunner = (args) => {
      calls.push([...args]);
      if (args[0] === 'search') {
        throw Object.assign(new Error('gh failed'), { stderr: 'API rate limit exceeded' });
      }
      throw new Error('not found');
    };
    const result = await collectReferenceCandidates({
      repoRoot: receiver.root,
      base: s.rename.baseSha,
      head: s.rename.headSha,
      backend: 'github',
      gh,
    });

    expect(result.backendUsed).toBe('githubSearch');
    expect(result.searchedRepos).toEqual([orgWildcard('acme')]);
    expect(result.lookupBlocked).toEqual([
      expect.objectContaining({ source: 'backwardSearch', reason: 'rateLimited' }),
    ]);
    expect(result.referenceCheckSkipped).toBe(true);
    expect(result.counts.backwardRef).toBe(0);
    // 한 번 막힌 뒤로는 검색을 다시 부르지 않는다
    expect(calls.filter((c) => c[0] === 'search')).toHaveLength(1);
  });
});

describe('collectReferenceCandidates — github 백엔드와 관련 레포 클론', () => {
  const cloneRoots: string[] = [];
  afterEach(() => {
    for (const r of cloneRoots.splice(0)) rmSync(r, { recursive: true, force: true });
  });

  function setup(opts: { remaining: number; resetInSec: number; cloneFails?: boolean }) {
    const s = buildReceiveOnlyOrg();
    const caller = s.org.repos[s.caller.repo]!;
    const cloneRoot = resolve('.gestalt-test', `clones-${randomUUID()}`);
    cloneRoots.push(cloneRoot);
    const searches: string[] = [];
    const clones: string[] = [];
    const gh: GhRunner = (args) => {
      if (args[0] === 'api' && args[1] === 'rate_limit') {
        const reset = Math.floor(Date.now() / 1000) + opts.resetInSec;
        return JSON.stringify({
          resources: { code_search: { limit: 10, remaining: opts.remaining, reset } },
        });
      }
      if (args[0] === 'search') {
        searches.push(args[2]!);
        return '[]';
      }
      if (args[0] === 'repo' && args[1] === 'view') return 'main\n';
      if (args[0] === 'repo' && args[1] === 'clone') {
        clones.push(args[2]!);
        if (opts.cloneFails) throw Object.assign(new Error('x'), { stderr: 'HTTP 404' });
        execFileSync('git', ['clone', '-q', '--depth', '1', `file://${caller.root}`, args[3]!], {
          stdio: 'ignore',
        });
        return '';
      }
      throw new Error('not found');
    };
    const run = (repoRoot = s.org.repos[s.receiver]!.root) =>
      collectReferenceCandidates({
        repoRoot,
        base: s.rename.baseSha,
        head: s.rename.headSha,
        backend: 'github',
        extraRepos: ['acme/acme-app'],
        cloneRoot,
        gh,
        sleep: async () => {},
      });
    return { s, run, searches, clones, cloneRoot };
  }

  it('워크트리마다 클론을 따로 받고 서로의 클론을 안 쓴다', async () => {
    const { s, run, clones, cloneRoot } = setup({ remaining: 10, resetInSec: 60 });
    const main = s.org.repos[s.receiver]!.root;
    const other = resolve('.gestalt-test', `wt-${randomUUID()}`);
    cloneRoots.push(other);
    execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '--detach', other], {
      stdio: 'ignore',
    });

    const a = await run(main);
    const b = await run(other);

    expect(clones).toEqual(['acme/acme-app', 'acme/acme-app']);
    const roots = readdirSync(cloneRoot).sort();
    expect(roots).toHaveLength(2);
    for (const root of roots) {
      expect(existsSync(join(cloneRoot, root, 'acme', 'acme-app', '.git'))).toBe(true);
    }
    expect(a.limitations.join('\n')).not.toMatch(/fetch/);
    expect(b.limitations.join('\n')).not.toMatch(/fetch/);

    // 워크트리를 지우면 다음 수집이 그 클론을 치운다
    execFileSync('git', ['-C', main, 'worktree', 'remove', '--force', other], { stdio: 'ignore' });
    await run(main);
    expect(readdirSync(cloneRoot)).toHaveLength(1);
  });

  it('관련 레포는 클론에서 찾고 GitHub에는 조직 와일드카드 질의만 보낸다', async () => {
    const { s, run, searches, clones } = setup({ remaining: 10, resetInSec: 60 });
    const result = await run();

    expect(clones).toEqual(['acme/acme-app']);
    expect(result.searchedRepos).toEqual(['acme/acme-app', orgWildcard('acme')]);
    expect(result.candidates.backwardRef).toContainEqual(
      expect.objectContaining({ targetRepo: 'acme/acme-app', targetPath: s.caller.file }),
    );
    // 로컬에서 찾은 참조는 줄 번호가 있다. GitHub 결과(줄 0)가 아니라는 뜻이다
    expect(result.candidates.backwardRef.every((c) => c.sourceLine > 0)).toBe(true);
    const cov = result.backwardSearchCoverage!;
    expect(searches).toHaveLength(cov.orgWide!.planned);
    expect(cov.byBackend.localClone!.searched).toBe(cov.planned);
    expect(result.lookupBlocked).toEqual([]);
    expect(result.referenceCheckSkipped).toBe(false);
  });

  it('한도 때문에 조직 와일드카드만 못 봤으면 막힘이 아니라 범위로 남긴다', async () => {
    const { run, searches } = setup({ remaining: 0, resetInSec: 600 });
    const result = await run();

    expect(searches).toEqual([]);
    expect(result.lookupBlocked).toEqual([]);
    expect(result.skippedRepos).toEqual([]);
    expect(result.referenceCheckSkipped).toBe(false);
    expect(result.backwardSearchCoverage!.orgWide!.searched).toBe(0);
    expect(result.limitations).toContainEqual(
      expect.stringMatching(/^조직 전체 검색은 질의 0\/\d+개만 봤다\. 관련 레포는 전부 찾았다/),
    );
  });

  it('클론을 못 받은 관련 레포가 한도에 걸리면 지금처럼 조회 막힘으로 올린다', async () => {
    const { run } = setup({ remaining: 0, resetInSec: 600, cloneFails: true });
    const result = await run();

    expect(result.limitations).toContainEqual(
      expect.stringMatching(/^acme\/acme-app: 로컬 클론을 못 얻어 GitHub 검색으로 넘겼다/),
    );
    expect(result.lookupBlocked).toEqual([
      expect.objectContaining({ source: 'backwardSearch', reason: 'rateLimited' }),
    ]);
    expect(result.referenceCheckSkipped).toBe(true);
  });
});

describe('GithubCodeSearchAdapter', () => {
  const searchJson = JSON.stringify([
    {
      path: 'plugin/skills/release/SKILL.md',
      repository: { nameWithOwner: 'acme/acme-app' },
      textMatches: [{ fragment: '앞 줄\n출시 전에 widget-audit 스킬을 먼저 돌린다.' }],
    },
    {
      path: 'plugin/skills/widget-audit/SKILL.md',
      repository: { nameWithOwner: 'acme/widget-kit' },
      textMatches: [{ fragment: 'name: widget-audit' }],
    },
    {
      path: 'docs/a.md',
      repository: { nameWithOwner: 'acme/other' },
      textMatches: [],
    },
  ]);

  it('조직 전체 검색에서 자기 레포를 빼고 식별자가 든 줄만 hit로 만든다', async () => {
    const queries: string[] = [];
    const adapter = new GithubCodeSearchAdapter({
      owner: 'acme',
      selfRepo: 'acme/widget-kit',
      gh: (args) => {
        if (args[0] === 'search') queries.push(args[2]!);
        return searchJson;
      },
    });
    const r = await adapter.search('widget-audit', [orgWildcard('acme')]);

    expect(queries).toEqual(['"widget-audit"']);
    expect(r.skipped).toEqual([]);
    expect(r.hits).toEqual([
      {
        repo: 'acme/acme-app',
        path: 'plugin/skills/release/SKILL.md',
        line: 0,
        text: '출시 전에 widget-audit 스킬을 먼저 돌린다.',
      },
      { repo: 'acme/other', path: 'docs/a.md', line: 0, text: '' },
    ]);
  });

  it('와일드카드가 없으면 목록 안 레포의 결과만 남긴다', async () => {
    const adapter = new GithubCodeSearchAdapter({ owner: 'acme', gh: () => searchJson });
    const r = await adapter.search('widget-audit', ['acme/other']);
    expect(r.hits.map((h) => h.repo)).toEqual(['acme/other']);
  });

  it('막히면 blocked를 채우고 모든 레포를 skipped로 돌려준다', async () => {
    const adapter = new GithubCodeSearchAdapter({
      owner: 'acme',
      gh: () => {
        throw Object.assign(new Error('x'), {
          stderr: 'To get started with GitHub CLI, please run: gh auth login',
        });
      },
    });
    const r = await adapter.search('widget-audit', ['acme/a', 'acme/b']);
    expect(adapter.blocked?.reason).toBe('notLoggedIn');
    expect(r.hits).toEqual([]);
    expect(r.skipped.map((s) => s.repo)).toEqual(['acme/a', 'acme/b']);
  });

  it('원격이 없으면 gh를 부르지 않고 noGitHubRemote로 막힌다', async () => {
    let called = false;
    const adapter = new GithubCodeSearchAdapter({
      owner: null,
      gh: () => {
        called = true;
        return '[]';
      },
    });
    await adapter.search('widget-audit', ['acme/a']);
    expect(called).toBe(false);
    expect(adapter.blocked?.reason).toBe('noGitHubRemote');
  });
});

describe('parseRepoDirs', () => {
  it('owner/name=경로 꼴은 표기를 그대로 쓰고 원격이 없는 경로는 조직과 디렉토리 이름으로 채운다', () => {
    const s = buildNoRemoteRepo();
    const dirs = parseRepoDirs(['acme/app=./some/dir', s.repo.root, s.repo.root], 'acme');
    expect(dirs).toEqual([
      { repo: 'acme/app', dir: resolve('./some/dir') },
      { repo: `acme/${s.repo.root.split('/').pop()!}`, dir: s.repo.root },
    ]);
  });
});

describe('gestalt harness-refs collect CLI', () => {
  it('--json이면 stdout에 JSON 한 줄만 낸다', () => {
    const s = buildIsolatedOrg();
    const lonely = s.org.repos[s.isolated]!;
    const bin = resolve('bin/gestalt.ts');
    const r = spawnSync(
      resolve('node_modules/.bin/tsx'),
      [
        bin,
        'harness-refs',
        'collect',
        '--base',
        s.change.baseSha,
        '--head',
        s.change.headSha,
        '--backend',
        'local',
        '--repo-dir',
        s.org.repos['acme-app']!.root,
        '--json',
      ],
      {
        cwd: lonely.root,
        encoding: 'utf-8',
        env: { ...process.env, GESTALT_NO_UPDATE_CHECK: '1' },
      },
    );

    expect(r.status).toBe(0);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as CollectResult;
    expect(parsed.repo).toBe('acme/lonely-kit');
    expect(crossRepoCount(parsed)).toBe(0);
  }, 30_000);

  it('--backend가 잘못되면 1로 끝난다', () => {
    const r = spawnSync(
      resolve('node_modules/.bin/tsx'),
      [
        resolve('bin/gestalt.ts'),
        'harness-refs',
        'collect',
        '--base',
        'a',
        '--head',
        'b',
        '--backend',
        'svn',
      ],
      { encoding: 'utf-8', env: { ...process.env, GESTALT_NO_UPDATE_CHECK: '1' } },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toBe('');
  }, 30_000);
});
