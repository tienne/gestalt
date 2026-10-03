/**
 * 레포마다 로컬 클론과 GitHub 코드 검색을 골라 쓰는 역방향 검색 백엔드.
 *
 * 클론이 있는 관련 레포는 git grep으로 한도 없이 찾는다. GitHub에는 클론으로 못 덮는 자리만 보낸다.
 * 조직 와일드카드(관련 레포 목록 밖에서 이 레포를 부르는 레포)와 클론을 못 받은 레포다.
 * GitHub 호출은 레포가 아니라 질의마다 하나라서, 호출 수가 주는 건 질의에 GitHub 몫이 아예 없을 때다.
 * 그래서 backwardSearch가 헤딩 질의에서는 와일드카드를 빼고 넘긴다.
 */
import { orgWildcard, type GithubCodeSearchAdapter } from './github-code-search.js';
import type {
  BackendCounts,
  CodeSearchBackend,
  LocalCloneBackend,
  SearchOptions,
  SearchResult,
} from './search-backend.js';
import type { SearchBackendKind } from './types.js';

export interface HybridSearchOptions {
  local: LocalCloneBackend;
  /** 로컬 클론을 얻은 레포 (owner/name) */
  localRepos: string[];
  github: GithubCodeSearchAdapter;
  owner: string;
}

export class HybridSearchBackend implements CodeSearchBackend {
  // refs.json의 backendUsed는 수집 모드를 적는다. 어느 쪽이 얼마나 찾았는지는 counts가 따로 싣는다
  readonly kind = 'githubSearch' as const;
  readonly capabilities: Record<string, unknown>;

  private readonly local: LocalCloneBackend;
  private readonly github: GithubCodeSearchAdapter;
  private readonly localRepos: Set<string>;
  private readonly wildcard: string;

  constructor(opts: HybridSearchOptions) {
    this.local = opts.local;
    this.github = opts.github;
    this.localRepos = new Set(opts.localRepos.map((r) => r.toLowerCase()));
    this.wildcard = orgWildcard(opts.owner).toLowerCase();
    this.capabilities = { ...opts.github.capabilities, hybrid: true };
  }

  get blocked() {
    return this.github.blocked;
  }

  private split(repos: string[]): { local: string[]; remote: string[] } {
    const local: string[] = [];
    const remote: string[] = [];
    for (const r of repos) (this.localRepos.has(r.toLowerCase()) ? local : remote).push(r);
    return { local, remote };
  }

  /** GitHub으로 갈 질의만 어댑터에 알린다. 로컬은 한도가 없다 */
  plan(queryRepos: string[][]): void {
    this.github.plan(queryRepos.map((repos) => this.split(repos).remote));
  }

  async search(identifier: string, repos: string[], opts?: SearchOptions): Promise<SearchResult> {
    const { local, remote } = this.split(repos);
    const result: SearchResult = { hits: [], skipped: [] };
    if (local.length > 0) {
      const r = await this.local.search(identifier, local, opts);
      result.hits.push(...r.hits);
      result.skipped.push(...r.skipped);
    }
    if (remote.length > 0) {
      const r = await this.github.search(identifier, remote, opts);
      // 와일드카드는 조직 전체를 돌려준다. 로컬이 맡은 레포는 줄 번호까지 있는 로컬 결과만 남긴다
      const orgWide = remote.some((x) => x.toLowerCase() === this.wildcard);
      result.hits.push(
        ...(orgWide ? r.hits.filter((h) => !this.localRepos.has(h.repo.toLowerCase())) : r.hits),
      );
      result.skipped.push(...r.skipped);
    }
    return result;
  }

  hasFile(repo: string, path: string): boolean | undefined {
    return this.localRepos.has(repo.toLowerCase()) ? this.local.hasFile(repo, path) : undefined;
  }

  counts(): Partial<Record<SearchBackendKind, BackendCounts>> {
    return { ...this.local.counts(), ...this.github.counts() };
  }
}
