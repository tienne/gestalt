import { describe, expect, it } from 'vitest';
import { countPending, type ReviewThread } from '../../../src/review-loop/threads.js';

const ME = 'reviewer';

const thread = (
  logins: Array<string | null>,
  o: { isResolved?: boolean; isOutdated?: boolean } = {},
): ReviewThread => ({
  isResolved: o.isResolved ?? false,
  isOutdated: o.isOutdated ?? false,
  comments: {
    nodes: logins.map((login) => ({ author: login === null ? null : { login } })),
  },
});

describe('미대응 스레드를 센다', () => {
  it('내가 열고 아직 답이 없는 것만 센다', () => {
    expect(countPending([thread([ME])], ME)).toBe(1);
  });

  it('닫힌 스레드는 빼고 센다', () => {
    expect(countPending([thread([ME], { isResolved: true })], ME)).toBe(0);
  });

  it('코드가 바뀌어 outdated가 된 스레드는 대응으로 본다', () => {
    expect(countPending([thread([ME], { isOutdated: true })], ME)).toBe(0);
  });

  it('작성자가 답을 달았으면 대응으로 본다', () => {
    expect(countPending([thread([ME, 'author'])], ME)).toBe(0);
  });

  it('답 뒤에 내가 또 달면 다시 미대응이다', () => {
    expect(countPending([thread([ME, 'author', ME])], ME)).toBe(1);
  });

  it('남이 연 스레드는 이 루프가 셀 자리가 아니다', () => {
    expect(countPending([thread(['other'])], ME)).toBe(0);
    // 내가 마지막에 답을 달아 둔 남의 스레드. 개설자를 안 가리면 이게 내 미대응으로
    // 잡혀 승인이 남의 스레드 때문에 막힌다
    expect(countPending([thread(['other', ME])], ME)).toBe(0);
    expect(countPending([thread(['other', ME, 'other', ME])], ME)).toBe(0);
  });

  /**
   * 이 수가 0 이어야 승인이 나가므로 셀 수 없는 상태를 0 으로 답하면 안 된다.
   * 셸 스크립트로 적던 때는 로그인이 비면 어떤 스레드와도 안 맞아 0 과 종료 코드 0 이
   * 함께 나왔다. 그 값이 승인 게이트를 그대로 통과했다.
   */
  it('로그인이 비면 0을 내지 않고 멈춘다', () => {
    expect(() => countPending([thread([ME]), thread([ME])], '')).toThrow(/로그인이 비었다/);
    expect(() => countPending([], '   ')).toThrow(/로그인이 비었다/);
  });

  it('삭제된 계정이라 author가 null이어도 죽지 않는다', () => {
    expect(countPending([thread([null]), thread([ME, null])], ME)).toBe(0);
  });

  it('코멘트가 하나도 없는 스레드를 미대응으로 세지 않는다', () => {
    expect(countPending([thread([])], ME)).toBe(0);
  });

  it('스레드가 없으면 0이다 — 첫 리뷰가 늘 그렇다', () => {
    expect(countPending([], ME)).toBe(0);
  });
});
