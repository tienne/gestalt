/**
 * GitHub 코드 검색을 역방향 검색 인터페이스(CodeSearchBackend)에 맞춘다.
 *
 * github-backend.ts는 조직 단위 질의 하나를 돌리고 막힘을 결과 값으로 알린다. 역방향 검색은
 * 식별자와 레포 목록을 주고 hits와 skipped를 받는 꼴이라 둘을 이어 줄 자리가 필요하다.
 * 조회가 한 번 막히면 뒤 질의는 gh를 부르지 않고 전부 skipped로 돌려준다. 속도 제한에 걸린 채
 * 같은 호출을 수십 번 반복하면 제한이 풀리는 시점만 늦어진다.
 */
import type { GhRunner } from '../review-loop/fetch.js';
import {
  createGithubSearchBackend,
  GH_SEARCH_LIMITATIONS,
  GH_SEARCH_MAX_LIMIT,
  type BlockReason,
  type GithubSearchBackend,
  type GithubSearchHit,
} from './github-backend.js';
import {
  DEFAULT_MAX_HITS_PER_REPO,
  MAX_HIT_TEXT_LENGTH,
  type CodeSearchBackend,
  type SearchHit,
  type SearchOptions,
  type SearchResult,
} from './search-backend.js';

export interface GithubLookupBlocked {
  reason: BlockReason;
  detail: string;
}

export interface GithubCodeSearchOptions {
  /** 검색할 조직. null이면 GitHub 원격이 없는 레포라 첫 질의에서 바로 막힌다 */
  owner: string | null;
  /** 리뷰 중인 레포(owner/name). 조직 전체 검색에 섞여 나와도 버린다 */
  selfRepo?: string;
  /** 테스트에서 가짜 gh로 바꾼다. backend를 주면 쓰지 않는다 */
  gh?: GhRunner;
  backend?: GithubSearchBackend;
}

/** GitHub 결과에는 줄 번호가 없다. 이 값이면 줄을 모른다는 뜻이다 */
export const UNKNOWN_LINE = 0;

/**
 * repos에 이 값을 넣으면 목록 밖 레포의 결과도 남긴다. 받기만 하는 레포는 관련 레포 목록이
 * 비어 있어서 조직 전체를 찾지 않으면 자기를 부르는 레포를 영영 못 찾는다
 */
export function orgWildcard(owner: string): string {
  return `${owner}/*`;
}

function quoteQuery(identifier: string): string {
  return `"${identifier.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function hitsFromGithub(hit: GithubSearchHit, identifier: string): SearchHit[] {
  const lines = hit.fragments.flatMap((f) => f.split('\n')).map((l) => l.trimEnd());
  const matched = [...new Set(lines.filter((l) => l.includes(identifier)))];
  // 조각에 식별자가 안 보여도 GitHub이 파일을 돌려줬다면 매치는 있다. 줄만 모를 뿐이다
  const texts = matched.length > 0 ? matched : [lines.find((l) => l.trim() !== '') ?? ''];
  return texts.map((text) => ({
    repo: hit.repo,
    path: hit.path,
    line: UNKNOWN_LINE,
    text: text.slice(0, MAX_HIT_TEXT_LENGTH),
  }));
}

export class GithubCodeSearchAdapter implements CodeSearchBackend {
  readonly kind = 'githubSearch' as const;
  readonly capabilities: Record<string, unknown>;
  /** 첫 막힘. 채워지면 이후 search는 gh를 부르지 않는다 */
  blocked: GithubLookupBlocked | null = null;
  readonly limitations: string[] = [...GH_SEARCH_LIMITATIONS, 'GitHub 결과에는 줄 번호가 없다'];

  private readonly backend: GithubSearchBackend;
  private readonly owner: string | null;
  private readonly selfRepo: string | undefined;

  constructor(opts: GithubCodeSearchOptions) {
    this.backend = opts.backend ?? createGithubSearchBackend(opts.gh);
    this.owner = opts.owner;
    this.selfRepo = opts.selfRepo?.toLowerCase();
    this.capabilities = { ...this.backend.capabilities, orgWide: true, lineNumbers: false };
  }

  get rateLimitState(): Record<string, unknown> | undefined {
    return this.backend.rateLimitState;
  }

  async search(
    identifier: string,
    repos: string[],
    opts: SearchOptions = {},
  ): Promise<SearchResult> {
    const result: SearchResult = { hits: [], skipped: [] };
    if (identifier === '' || repos.length === 0) return result;

    if (!this.blocked) {
      const outcome = this.backend.search(quoteQuery(identifier), {
        owner: this.owner,
        limit: GH_SEARCH_MAX_LIMIT,
      });
      if (outcome.status === 'blocked') {
        this.blocked = { reason: outcome.reason, detail: outcome.detail };
      } else {
        result.hits = this.filterHits(outcome.hits, identifier, repos, opts);
        return result;
      }
    }

    const reason = `GitHub 조회 막힘 (${this.blocked.reason})`;
    result.skipped = repos.map((repo) => ({ repo, reason }));
    return result;
  }

  private filterHits(
    hits: GithubSearchHit[],
    identifier: string,
    repos: string[],
    opts: SearchOptions,
  ): SearchHit[] {
    const wanted = new Set(repos.map((r) => r.toLowerCase()));
    const orgWide = this.owner !== null && wanted.has(orgWildcard(this.owner).toLowerCase());
    const max = opts.maxHitsPerRepo ?? DEFAULT_MAX_HITS_PER_REPO;
    const perRepo = new Map<string, number>();
    const seen = new Set<string>();
    const out: SearchHit[] = [];

    for (const hit of hits) {
      const repo = hit.repo.toLowerCase();
      if (repo === this.selfRepo) continue;
      if (!orgWide && !wanted.has(repo)) continue;
      for (const h of hitsFromGithub(hit, identifier)) {
        const key = `${h.repo}\u0000${h.path}\u0000${h.text}`;
        if (seen.has(key)) continue;
        const count = perRepo.get(repo) ?? 0;
        if (count >= max) break;
        seen.add(key);
        perRepo.set(repo, count + 1);
        out.push(h);
      }
    }
    return out;
  }
}
