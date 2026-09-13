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

/** 요청 리뷰어를 한 번에 받는 수. 쿼리와 넘침 검사가 같은 값을 봐야 한다 */
export const REVIEWER_PAGE = 50;

const QUERY = `
query($owner:String!, $repo:String!, $pr:Int!, $cursor:String) {
  repository(owner:$owner, name:$repo) {
    pullRequest(number:$pr) {
      state
      headRefOid
      reviewRequests(first:${REVIEWER_PAGE}) {
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
 * 판정에 쓸 원자료를 이 함수 하나가 모은다. 페이지를 도는 건 스레드뿐이라 합치는 건
 * 여기서 끝난다. 부르는 쪽은 스레드를 온전히 받거나 아무것도 못 받는다.
 *
 * `reviewRequests` 도 connection 이지만 커서를 안 돈다. GitHub 가 PR 당 요청 리뷰어를
 * 50보다 훨씬 아래로 제한해 한 페이지에 다 들어온다. 그 전제가 깨지면 아래에서 던진다 —
 * 목록이 잘리면 `rerequested` 가 거짓으로 읽혀, 작성자가 다시 봐달라고 눌러도 재리뷰를
 * 안 돈다.
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
    if (pr.reviewRequests.nodes.length >= REVIEWER_PAGE) {
      throw new Error('요청 리뷰어가 한 페이지를 채웠다 — 목록이 잘렸을 수 있어 판정하지 않는다');
    }
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
