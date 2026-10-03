/**
 * GitHub 코드 검색을 역방향 검색 인터페이스(CodeSearchBackend)에 맞춘다.
 *
 * github-backend.ts는 조직 단위 질의 하나를 돌리고 막힘을 결과 값으로 알린다. 역방향 검색은
 * 식별자와 레포 목록을 주고 hits와 skipped를 받는 꼴이라 둘을 이어 줄 자리가 필요하다.
 * 조회가 한 번 막히면 뒤 질의는 gh를 부르지 않고 전부 skipped로 돌려준다. 속도 제한에 걸린 채
 * 같은 호출을 수십 번 반복하면 제한이 풀리는 시점만 늦어진다.
 *
 * 코드 검색은 분당 10회다. 403을 맞고 나서 멈추면 그 뒤 1분이 통째로 막히므로 시작할 때
 * `gh api rate_limit`(한도에서 안 빠진다)으로 남은 횟수를 읽고 그만큼만 보낸다. 다 쓰면 남은 질의가
 * 다음 창 하나로 끝나고 1분 안에 풀릴 때만 한 번 기다린다. 그보다 길게 기다리면 리뷰가 멈춘다.
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
  type BackendCounts,
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
  /** 테스트에서 실제로 자지 않게 바꾼다 */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RateLimitWindow {
  limit: number;
  remaining: number;
  /** 한도가 다시 차는 시각 (epoch ms) */
  resetAt: number;
}

/** rate_limit을 못 읽었을 때 가정하는 코드 검색 한도. 로그인한 사용자의 분당 한도다 */
export const DEFAULT_CODE_SEARCH_LIMIT = 10;
const WINDOW_MS = 60_000;
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;
// reset 시각은 초 단위라 딱 맞춰 깨면 아직 안 풀려 있을 수 있다
const RESET_SLACK_MS = 1_000;

export function readCodeSearchWindow(gh: GhRunner): RateLimitWindow | null {
  try {
    const json = JSON.parse(gh(['api', 'rate_limit'])) as {
      resources?: { code_search?: { limit?: unknown; remaining?: unknown; reset?: unknown } };
    };
    const w = json.resources?.code_search;
    if (
      typeof w?.limit !== 'number' ||
      typeof w.remaining !== 'number' ||
      typeof w.reset !== 'number'
    ) {
      return null;
    }
    return { limit: w.limit, remaining: w.remaining, resetAt: w.reset * 1000 };
  } catch {
    return null;
  }
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** GitHub 결과에는 줄 번호가 없다. 이 값이면 줄을 모른다는 뜻이다 */
export const UNKNOWN_LINE = 0;

/**
 * repos에 이 값을 넣으면 목록 밖 레포의 결과도 남긴다. 받기만 하는 레포는 관련 레포 목록이
 * 비어 있어서 조직 전체를 찾지 않으면 자기를 부르는 레포를 영영 못 찾는다
 */
export function orgWildcard(owner: string): string {
  return `${owner}/*`;
}

export function isOrgWildcard(repo: string): boolean {
  return repo.endsWith('/*');
}

function quoteQuery(identifier: string): string {
  return `"${identifier.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildQuery(identifier: string, opts: SearchOptions): string {
  return opts.requireAlso
    ? `${quoteQuery(identifier)} ${quoteQuery(opts.requireAlso)}`
    : quoteQuery(identifier);
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
  private readonly gh: GhRunner | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private window: RateLimitWindow | null = null;
  private waited = false;
  private planned: number | null = null;
  private searched = 0;
  private skippedQueries = 0;

  constructor(opts: GithubCodeSearchOptions) {
    this.backend = opts.backend ?? createGithubSearchBackend(opts.gh);
    this.owner = opts.owner;
    this.selfRepo = opts.selfRepo?.toLowerCase();
    this.capabilities = { ...this.backend.capabilities, orgWide: true, lineNumbers: false };
    this.gh = opts.gh;
    this.sleep = opts.sleep ?? realSleep;
    this.now = opts.now ?? Date.now;
  }

  plan(queryRepos: string[][]): void {
    this.planned = queryRepos.filter((r) => r.length > 0).length;
  }

  counts(): Partial<Record<'githubSearch', BackendCounts>> {
    return { githubSearch: { searched: this.searched, skipped: this.skippedQueries } };
  }

  private readWindow(): RateLimitWindow {
    const read = this.gh ? readCodeSearchWindow(this.gh) : null;
    return (
      read ?? {
        limit: DEFAULT_CODE_SEARCH_LIMIT,
        remaining: DEFAULT_CODE_SEARCH_LIMIT,
        resetAt: this.now() + WINDOW_MS,
      }
    );
  }

  /** 이번 질의를 보내도 되면 true. 안 되면 blocked를 채운다 */
  private async takeBudget(): Promise<boolean> {
    // 원격이 없으면 백엔드가 gh를 안 부르고 바로 막는다. 한도를 읽을 일도 없다
    if (this.owner === null) return true;
    this.window ??= this.readWindow();
    if (this.window.remaining > 0) return true;

    // plan을 안 불렀으면 남은 질의 수를 몰라 기다려도 끝난다는 보장이 없다
    const left = this.planned === null ? Infinity : this.planned - this.searched;
    const resetIn = Math.max(0, this.window.resetAt - this.now());
    if (!this.waited && left <= this.window.limit && resetIn <= MAX_RATE_LIMIT_WAIT_MS) {
      this.waited = true;
      await this.sleep(resetIn + RESET_SLACK_MS);
      this.window = this.readWindow();
      if (this.window.remaining > 0) return true;
    }

    const total = this.planned === null ? '' : `/${this.planned}`;
    this.blocked = {
      reason: 'rateLimited',
      detail: `코드 검색 한도(${this.window.limit}회)를 다 써서 질의 ${this.searched}${total}개를 보내고 멈췄다. 한도가 다시 차는 시각: ${new Date(this.window.resetAt).toISOString()}`,
    };
    return false;
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

    if (!this.blocked && (await this.takeBudget())) {
      if (this.window) this.window.remaining--;
      const outcome = this.backend.search(buildQuery(identifier, opts), {
        owner: this.owner,
        limit: GH_SEARCH_MAX_LIMIT,
      });
      if (outcome.status === 'blocked') {
        this.blocked = { reason: outcome.reason, detail: outcome.detail };
      } else {
        this.searched++;
        result.hits = this.filterHits(outcome.hits, identifier, repos, opts);
        return result;
      }
    }

    this.skippedQueries++;
    const reason = `GitHub 조회 막힘 (${this.blocked!.reason})`;
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
