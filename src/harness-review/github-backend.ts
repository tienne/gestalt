import { execFileSync } from 'node:child_process';
import { runGh, type GhRunner } from '../review-loop/fetch.js';
import type { SearchBackend } from './types.js';

export const BLOCK_REASONS = [
  'notLoggedIn',
  'noPermission',
  'rateLimited',
  'noGitHubRemote',
] as const;

export type BlockReason = (typeof BLOCK_REASONS)[number];

export interface GithubSearchHit {
  repo: string;
  path: string;
  fragments: string[];
}

export type GithubSearchOutcome =
  | { status: 'ok'; hits: GithubSearchHit[]; limitations: string[] }
  | { status: 'blocked'; reason: BlockReason; detail: string; limitations: string[] };

export interface GithubSearchOptions {
  /** 검색 범위. null이면 GitHub 원격이 없는 레포라 조회 자체를 하지 않는다 */
  owner: string | null;
  limit?: number;
}

export interface GitRunner {
  (args: readonly string[]): string;
}

export const GH_SEARCH_LIMITATIONS: readonly string[] = [
  '기본 브랜치만 검색한다. 열린 PR이나 다른 브랜치의 변경은 안 보인다',
  '푸시 직후 인덱싱이 늦을 수 있다. 방금 바뀐 파일은 결과에 없을 수 있다',
  '아카이브된 레포와 포크는 인덱싱되지 않는다',
];

export const GH_SEARCH_MAX_LIMIT = 100;

/**
 * gh 실패 출력에서 막힘 종류를 가른다. 판정 못 하면 null이라 부르는 쪽이 일반 오류로 다룬다.
 * 속도 제한을 권한 없음보다 먼저 본다 — 둘 다 403이라 메시지로만 갈린다.
 */
export function classifyGhFailure(text: string): BlockReason | null {
  const t = text.toLowerCase();
  if (/rate limit|secondary rate|abuse detection|retry-after/.test(t)) return 'rateLimited';
  if (
    /gh auth login|not logged in|not logged into|authentication required|no oauth token|http 401|bad credentials/.test(
      t,
    )
  ) {
    return 'notLoggedIn';
  }
  if (
    /http 404|not found|http 403|resource not accessible|forbidden|saml|must have push access|requires authentication/.test(
      t,
    )
  ) {
    return 'noPermission';
  }
  return null;
}

function failureText(e: unknown): string {
  if (typeof e !== 'object' || e === null) return String(e);
  const { stderr, stdout, message } = e as {
    stderr?: unknown;
    stdout?: unknown;
    message?: unknown;
  };
  return [stderr, stdout, message]
    .filter((v) => v !== undefined && v !== null)
    .map(String)
    .join('\n');
}

const defaultGit: GitRunner = (args) =>
  execFileSync('git', [...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });

/** origin이 github.com을 가리키면 owner를, 아니면 null을 돌려준다 */
export function resolveGithubOwner(repoRoot: string, git: GitRunner = defaultGit): string | null {
  let url: string;
  try {
    url = git(['-C', repoRoot, 'remote', 'get-url', 'origin']).trim();
  } catch {
    return null;
  }
  const m = /github\.com[:/]([^/\s]+)\/[^/\s]+?(?:\.git)?$/.exec(url);
  return m ? m[1]! : null;
}

interface RawCodeHit {
  path?: string;
  repository?: { nameWithOwner?: string };
  textMatches?: Array<{ fragment?: string }>;
}

export interface GithubSearchBackend extends SearchBackend {
  kind: 'githubSearch';
  search(query: string, opts: GithubSearchOptions): GithubSearchOutcome;
}

export function createGithubSearchBackend(gh: GhRunner = runGh): GithubSearchBackend {
  const backend: GithubSearchBackend = {
    kind: 'githubSearch',
    capabilities: {
      defaultBranchOnly: true,
      indexingDelay: true,
      indexesArchivedAndForks: false,
      limitations: GH_SEARCH_LIMITATIONS,
    },
    rateLimitState: {},
    search(query, opts) {
      const limitations = [...GH_SEARCH_LIMITATIONS];
      if (opts.owner === null) {
        return {
          status: 'blocked',
          reason: 'noGitHubRemote',
          detail: 'GitHub 원격이 없다',
          limitations,
        };
      }
      const limit = Math.min(opts.limit ?? 30, GH_SEARCH_MAX_LIMIT);
      const args = [
        'search',
        'code',
        query,
        '--owner',
        opts.owner,
        '--json',
        'path,repository,textMatches',
        '--limit',
        String(limit),
      ];

      let raw: string;
      try {
        raw = gh(args);
      } catch (e) {
        const detail = failureText(e);
        const reason = classifyGhFailure(detail);
        if (reason === 'rateLimited')
          backend.rateLimitState = { blockedAt: new Date().toISOString() };
        if (reason === null) {
          // 원인을 못 가른 실패도 죽이지 않고 막힘으로 올려 사용자에게 묻는다
          return { status: 'blocked', reason: 'noPermission', detail, limitations };
        }
        return { status: 'blocked', reason, detail, limitations };
      }

      let parsed: RawCodeHit[];
      try {
        const json: unknown = JSON.parse(raw);
        if (!Array.isArray(json)) throw new Error('배열이 아니다');
        parsed = json as RawCodeHit[];
      } catch (e) {
        return {
          status: 'blocked',
          reason: 'noPermission',
          detail: `응답 파싱 실패: ${failureText(e)}`,
          limitations,
        };
      }

      const hits = parsed.flatMap((h): GithubSearchHit[] =>
        h.path && h.repository?.nameWithOwner
          ? [
              {
                repo: h.repository.nameWithOwner,
                path: h.path,
                fragments: (h.textMatches ?? []).flatMap((t) => (t.fragment ? [t.fragment] : [])),
              },
            ]
          : [],
      );
      return { status: 'ok', hits, limitations };
    },
  };
  return backend;
}
