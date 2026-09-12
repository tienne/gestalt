import { execFileSync } from 'node:child_process';
import type { ReviewThread } from './threads.js';

/** `gh` 호출을 밖에서 갈아끼우려고 둔 자리. 테스트가 실제 네트워크를 안 탄다 */
export interface GhRunner {
  (args: readonly string[]): string;
}

export const runGh: GhRunner = (args) =>
  execFileSync('gh', [...args], { encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });

export interface PrSnapshot {
  prState: string;
  headRefOid: string;
  threads: ReviewThread[];
  requestedReviewers: string[];
}

/** 페이지가 늘어도 끝나도록 두는 상한. 스레드 50개씩이라 5000개까지 본다 */
export const PAGE_LIMIT = 100;

const QUERY = `
query($owner:String!, $repo:String!, $pr:Int!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      state
      headRefOid
      reviewRequests(first:50) {
        nodes { requestedReviewer { ... on User { login } } }
      }
      reviewThreads(first:50, after:$cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          opener: comments(first:1) { nodes { author { login } } }
          latest: comments(last:1) { nodes { author { login } } }
        }
      }
    }
  }
}`;

/**
 * PR 상태와 내가 볼 스레드를 한 번에 받는다.
 *
 * 판정에 쓰는 수가 전부 이 한 호출에서 나온다. 문서가 이걸 셸로 적던 때는 조회와
 * 집계가 다른 Bash 호출로 갈려 그 사이를 파일로 이어야 했다. 스냅샷이 이번 조회의
 * 것인지 가리는 표식과 신선도 검사가 따라붙었다. 한 프로세스 안에서 조회하고 세면
 * 그 중간 상태가 아예 없다.
 *
 * 부분 성공을 걸러낸다. GitHub 는 HTTP 200에 `data` 를 채우고도 `errors` 를 함께
 * 실어 `reviewThreads` 만 `null` 로 주는 응답을 낸다. 그걸 통과시키면 스레드 0 개가
 * 조회 성공으로 읽혀 승인이 나간다.
 */
export function fetchPrSnapshot(
  opts: { owner: string; repo: string; prNumber: number },
  gh: GhRunner = runGh,
): PrSnapshot {
  const threads: ReviewThread[] = [];
  let cursor: string | null = null;
  let prState: string;
  let headRefOid: string;
  let requestedReviewers: string[];

  for (let page = 0; page < PAGE_LIMIT; page++) {
    // 문자열은 `-f` 로 넘긴다. `-F` 는 값이 특수 문자로 시작하면 파일을 읽거나 현재
    // 레포 값으로 치환하는 매직이 있다. 거기 문자열을 태우면 값 모양에 기대는 안전이 된다
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${QUERY}`,
      '-f',
      `owner=${opts.owner}`,
      '-f',
      `repo=${opts.repo}`,
      '-F',
      `pr=${opts.prNumber}`,
    ];
    if (cursor) args.push('-f', `cursor=${cursor}`);

    const parsed = JSON.parse(gh(args)) as {
      errors?: Array<{ message?: string }>;
      data?: { repository?: { pullRequest?: RawPullRequest | null } | null };
    };

    const pr = parsed.data?.repository?.pullRequest;
    if (parsed.errors?.length || !pr || !pr.reviewThreads) {
      const first = parsed.errors?.[0]?.message ?? 'reviewThreads 가 null';
      throw new Error(`조회 응답에 오류: ${first}`);
    }

    prState = pr.state;
    headRefOid = pr.headRefOid;
    requestedReviewers = pr.reviewRequests.nodes
      .map((n) => n.requestedReviewer?.login)
      .filter((l): l is string => typeof l === 'string');

    threads.push(...pr.reviewThreads.nodes);

    if (!pr.reviewThreads.pageInfo.hasNextPage) {
      return { prState, headRefOid, threads, requestedReviewers };
    }
    cursor = pr.reviewThreads.pageInfo.endCursor;
  }

  throw new Error('스레드 페이지가 상한을 넘었다 — 판정하지 않는다');
}

interface RawPullRequest {
  state: string;
  headRefOid: string;
  reviewRequests: { nodes: Array<{ requestedReviewer: { login?: string } | null }> };
  reviewThreads: {
    pageInfo: { hasNextPage: boolean; endCursor: string };
    nodes: ReviewThread[];
  } | null;
}
