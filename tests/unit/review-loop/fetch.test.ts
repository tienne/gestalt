import { describe, expect, it } from 'vitest';
import { fetchPrSnapshot, PAGE_LIMIT, type GhRunner } from '../../../src/review-loop/fetch.js';

const page = (o: {
  threads?: unknown[];
  hasNext?: boolean;
  cursor?: string;
  state?: string;
  reviewers?: Array<Record<string, unknown> | null>;
}) =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          state: o.state ?? 'OPEN',
          headRefOid: 'abc123',
          reviewRequests: { nodes: o.reviewers ?? [] },
          reviewThreads: {
            pageInfo: { hasNextPage: o.hasNext ?? false, endCursor: o.cursor ?? '' },
            nodes: o.threads ?? [],
          },
        },
      },
    },
  });

const stub = (pages: string[]): GhRunner => {
  let i = 0;
  return () => pages[Math.min(i++, pages.length - 1)]!;
};

describe('PR 상태와 스레드를 받는다', () => {
  const opts = { owner: 'o', repo: 'r', prNumber: 1 };

  it('한 페이지면 그대로 돌려준다', () => {
    const snap = fetchPrSnapshot(opts, stub([page({ threads: [{ a: 1 }] })]));
    expect(snap.threads).toHaveLength(1);
    expect(snap.prState).toBe('OPEN');
    expect(snap.headRefOid).toBe('abc123');
  });

  it('여러 페이지를 이어 붙인다', () => {
    const snap = fetchPrSnapshot(
      opts,
      stub([
        page({ threads: [{ a: 1 }], hasNext: true, cursor: 'c1' }),
        page({ threads: [{ a: 2 }, { a: 3 }] }),
      ]),
    );
    expect(snap.threads).toHaveLength(3);
  });

  /**
   * GitHub 는 HTTP 200 에 data 를 채우고도 errors 를 함께 실어 reviewThreads 만 null 로
   * 주는 응답을 낸다. 그걸 통과시키면 스레드 0 개가 조회 성공으로 읽혀 승인이 나간다.
   */
  it('errors가 실려 오면 멈춘다', () => {
    const partial = JSON.stringify({
      errors: [{ message: 'rate limited' }],
      data: {
        repository: {
          pullRequest: {
            state: 'OPEN',
            headRefOid: 'x',
            reviewRequests: { nodes: [] },
            reviewThreads: null,
          },
        },
      },
    });
    expect(() => fetchPrSnapshot(opts, stub([partial]))).toThrow(/rate limited/);
  });

  it('스레드는 정상인데 errors만 실려 와도 멈춘다', () => {
    // 부분 성공의 진짜 꼴이다. data 가 그럴듯하게 차 있어 errors 를 안 보면 통과한다
    const partial = page({ threads: [{ a: 1 }] });
    const withErrors = JSON.stringify({
      errors: [{ message: 'Something went wrong' }],
      ...(JSON.parse(partial) as Record<string, unknown>),
    });
    expect(() => fetchPrSnapshot(opts, stub([withErrors]))).toThrow(/Something went wrong/);
  });

  it('reviewThreads가 null이면 멈춘다', () => {
    const nulled = JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            state: 'OPEN',
            headRefOid: 'x',
            reviewRequests: { nodes: [] },
            reviewThreads: null,
          },
        },
      },
    });
    expect(() => fetchPrSnapshot(opts, stub([nulled]))).toThrow(/reviewThreads 가 null/);
  });

  it('pullRequest가 없으면 멈춘다', () => {
    const empty = JSON.stringify({ data: { repository: { pullRequest: null } } });
    expect(() => fetchPrSnapshot(opts, stub([empty]))).toThrow(/조회 응답에 오류/);
  });

  it('페이지가 끝없이 이어지면 정해진 횟수만 부르고 멈춘다', () => {
    const forever = page({ threads: [{ a: 1 }], hasNext: true, cursor: 'c' });
    let calls = 0;
    const counting: GhRunner = () => {
      calls++;
      return forever;
    };
    expect(() => fetchPrSnapshot(opts, counting)).toThrow(/상한을 넘었다/);
    // 상한이 풀리면 여기서 영원히 돈다. 횟수를 단언해야 그 회귀가 잡힌다
    expect(calls).toBe(PAGE_LIMIT);
    // 상수를 import 해 비교하므로 값을 키우면 이 단언도 같이 커진다. 사실상 상한이
    // 없는 값으로 바뀌는 것만은 여기서 막는다
    expect(PAGE_LIMIT).toBeLessThanOrEqual(1000);
  });

  it('리뷰어 목록에 login 없는 팀이 섞여도 사람만 추린다', () => {
    const snap = fetchPrSnapshot(
      opts,
      stub([
        page({
          reviewers: [
            { requestedReviewer: {} },
            { requestedReviewer: { login: 'me' } },
            { requestedReviewer: null },
          ],
        }),
      ]),
    );
    expect(snap.requestedReviewers).toEqual(['me']);
  });
});
