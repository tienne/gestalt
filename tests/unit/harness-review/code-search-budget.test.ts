import { afterEach, describe, expect, it } from 'vitest';
import { backwardSearch } from '../../../src/harness-review/backward-search.js';
import {
  GithubCodeSearchAdapter,
  orgWildcard,
} from '../../../src/harness-review/github-code-search.js';
import { HybridSearchBackend } from '../../../src/harness-review/hybrid-search.js';
import {
  LocalCloneBackend,
  type CodeSearchBackend,
  type SearchOptions,
  type SearchResult,
} from '../../../src/harness-review/search-backend.js';
import type { Identifier } from '../../../src/harness-review/types.js';
import type { GhRunner } from '../../../src/review-loop/fetch.js';
import { cleanupFakeRepos, createFakeRepo } from '../../helpers/fake-repo.js';

afterEach(cleanupFakeRepos);

const NOW = Date.UTC(2026, 9, 2, 0, 0, 0);

function rateLimitJson(remaining: number, resetInSec: number, limit = 10): string {
  return JSON.stringify({
    resources: {
      code_search: { limit, remaining, reset: Math.floor(NOW / 1000) + resetInSec },
    },
  });
}

/** rate_limit 응답을 차례로 돌려주고 search 질의를 기록하는 가짜 gh */
function fakeGh(windows: string[], queries: string[], hits = '[]'): GhRunner {
  return (args) => {
    if (args[0] === 'api' && args[1] === 'rate_limit') {
      const next = windows.shift();
      if (next === undefined) throw new Error('rate_limit을 더 부르면 안 된다');
      return next;
    }
    if (args[0] === 'search') {
      queries.push(args[2]!);
      return hits;
    }
    throw new Error(`예상 밖 gh 호출: ${args.join(' ')}`);
  };
}

function adapterWith(gh: GhRunner, sleeps: number[] = []): GithubCodeSearchAdapter {
  return new GithubCodeSearchAdapter({
    owner: 'acme',
    selfRepo: 'acme/design',
    gh,
    now: () => NOW,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
}

const WILD = [orgWildcard('acme')];

describe('GithubCodeSearchAdapter 한도 예산', () => {
  it('rate_limit의 남은 횟수만큼만 보내고 남은 질의가 한 창을 넘으면 기다리지 않고 멈춘다', async () => {
    const queries: string[] = [];
    const sleeps: number[] = [];
    const adapter = adapterWith(fakeGh([rateLimitJson(2, 30)], queries), sleeps);
    const repos = Array.from({ length: 30 }, () => WILD);
    adapter.plan(repos);

    for (let i = 0; i < 30; i++) await adapter.search(`term-${i}`, WILD);

    expect(queries).toHaveLength(2);
    expect(sleeps).toEqual([]);
    expect(adapter.blocked).toEqual({
      reason: 'rateLimited',
      detail: expect.stringContaining('질의 2/30개를 보내고 멈췄다'),
    });
    expect(adapter.counts()).toEqual({ githubSearch: { searched: 2, skipped: 28 } });
  });

  it('reset이 60초보다 멀면 남은 질의가 적어도 기다리지 않는다', async () => {
    const sleeps: number[] = [];
    const adapter = adapterWith(fakeGh([rateLimitJson(0, 120)], []), sleeps);
    adapter.plan([WILD]);
    const r = await adapter.search('x-term', WILD);
    expect(sleeps).toEqual([]);
    expect(r.skipped).toEqual([{ repo: 'acme/*', reason: 'GitHub 조회 막힘 (rateLimited)' }]);
  });

  it('조건이 맞으면 reset까지 한 번만 기다리고 창을 다시 읽어 이어 보낸다', async () => {
    const queries: string[] = [];
    const sleeps: number[] = [];
    const adapter = adapterWith(
      fakeGh([rateLimitJson(1, 20), rateLimitJson(10, 60)], queries),
      sleeps,
    );
    adapter.plan([WILD, WILD, WILD]);

    for (const term of ['n1', 'n2', 'n3']) await adapter.search(term, WILD);

    expect(sleeps).toEqual([21_000]);
    expect(queries).toEqual(['"n1"', '"n2"', '"n3"']);
    expect(adapter.blocked).toBeNull();
  });

  it('rate_limit을 못 읽으면 분당 10회로 보고 plan이 없으면 기다리지 않는다', async () => {
    const queries: string[] = [];
    const sleeps: number[] = [];
    const adapter = adapterWith(fakeGh([], queries), sleeps);
    for (let i = 0; i < 12; i++) await adapter.search(`term-${i}`, WILD);
    expect(queries).toHaveLength(10);
    expect(sleeps).toEqual([]);
    expect(adapter.blocked?.reason).toBe('rateLimited');
  });

  it('requireAlso가 있으면 두 구절을 AND 질의로 보낸다', async () => {
    const queries: string[] = [];
    const adapter = adapterWith(fakeGh([rateLimitJson(10, 60)], queries));
    await adapter.search('사용 방법', ['acme/kb'], { requireAlso: 'design' });
    expect(queries).toEqual(['"사용 방법" "design"']);
  });
});

describe('HybridSearchBackend', () => {
  it('클론이 있는 레포는 grep으로 찾고 GitHub에는 와일드카드만 보낸다', async () => {
    const kb = createFakeRepo({ name: 'kb', files: { 'skills/x/SKILL.md': 'use widget-audit\n' } });
    const queries: string[] = [];
    const githubHits = JSON.stringify([
      {
        path: 'skills/x/SKILL.md',
        repository: { nameWithOwner: 'acme/kb' },
        textMatches: [{ fragment: 'use widget-audit' }],
      },
      {
        path: 'docs/y.md',
        repository: { nameWithOwner: 'acme/elsewhere' },
        textMatches: [{ fragment: 'widget-audit 참고' }],
      },
    ]);
    const github = adapterWith(fakeGh([rateLimitJson(10, 60)], queries, githubHits));
    const hybrid = new HybridSearchBackend({
      local: new LocalCloneBackend([{ repo: 'acme/kb', dir: kb.root }]),
      localRepos: ['acme/kb'],
      github,
      owner: 'acme',
    });

    const scoped = await hybrid.search('widget-audit', ['acme/kb']);
    expect(queries).toEqual([]);
    expect(scoped.hits).toEqual([
      { repo: 'acme/kb', path: 'skills/x/SKILL.md', line: 1, text: 'use widget-audit' },
    ]);

    const wide = await hybrid.search('widget-audit', ['acme/kb', 'acme/*']);
    expect(queries).toEqual(['"widget-audit"']);
    // 로컬이 맡은 레포는 줄 번호가 있는 로컬 결과만 남는다
    expect(wide.hits.map((h) => `${h.repo}:${h.line}`)).toEqual(['acme/kb:1', 'acme/elsewhere:0']);
    expect(hybrid.counts()).toEqual({
      localClone: { searched: 2, skipped: 0 },
      githubSearch: { searched: 1, skipped: 0 },
    });
  });
});

interface Call {
  term: string;
  repos: string[];
  opts?: SearchOptions;
}

class RecordingBackend implements CodeSearchBackend {
  readonly kind = 'githubSearch' as const;
  readonly capabilities = {};
  calls: Call[] = [];
  planned: string[][] = [];
  plan(queryRepos: string[][]) {
    this.planned = queryRepos;
  }
  async search(term: string, repos: string[], opts?: SearchOptions): Promise<SearchResult> {
    this.calls.push({ term, repos, opts });
    return { hits: [], skipped: [] };
  }
}

function id(kind: Identifier['kind'], value: string): Identifier {
  return { kind, value, changeType: 'removed', extractedBy: 'pattern' };
}

describe('backwardSearch 질의 계획', () => {
  it('이름류를 먼저, 헤딩 원문을 맨 뒤에 보내고 헤딩 질의에서는 와일드카드를 뺀다', async () => {
    const backend = new RecordingBackend();
    const result = await backwardSearch({
      identifiers: [
        id('heading', '설치 방법'),
        id('path', '.claude/skills/shared/task-page.md'),
        id('skillName', 'task-page'),
      ],
      repos: ['acme/kb', 'acme/*'],
      backend,
      selfRepo: 'acme/design',
    });

    expect(backend.calls.map((c) => [c.term, c.repos, c.opts?.requireAlso])).toEqual([
      ['.claude/skills/shared/task-page.md', ['acme/kb', 'acme/*'], undefined],
      ['task-page', ['acme/kb', 'acme/*'], undefined],
      ['#설치-방법', ['acme/kb'], undefined],
      ['design', ['acme/kb', 'acme/*'], undefined],
      ['설치 방법', ['acme/kb'], 'design'],
    ]);
    expect(backend.planned).toEqual(backend.calls.map((c) => c.repos));
    expect(result.coverage).toEqual({
      planned: 5,
      searched: 5,
      byBackend: {},
      orgWide: { planned: 3, searched: 3 },
    });
  });

  it('와일드카드가 막히면 조직 전체 범위에 덜 본 만큼 남는다', async () => {
    const backend = new RecordingBackend();
    let n = 0;
    backend.search = async (term, repos) => {
      backend.calls.push({ term, repos });
      // 두 번째 질의부터 막힌 것처럼 와일드카드를 skipped로 돌려준다
      return n++ === 0
        ? { hits: [], skipped: [] }
        : {
            hits: [],
            skipped: repos
              .filter((r) => r.endsWith('/*'))
              .map((repo) => ({ repo, reason: '막힘' })),
          };
    };
    const result = await backwardSearch({
      identifiers: [id('path', 'a/long-path.md'), id('skillName', 'short')],
      repos: ['acme/kb', 'acme/*'],
      backend,
    });
    expect(result.coverage.orgWide).toEqual({ planned: 2, searched: 1 });
    expect(result.coverage.searched).toBe(1);
    expect(result.skipped).toEqual([{ repo: 'acme/*', reason: '막힘' }]);
  });
});
