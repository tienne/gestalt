/**
 * idleChange 문턱의 경계를 고정한다.
 *
 * 자연어 픽스처로는 changeRate를 정확한 값에 맞출 수 없다. 부동소수점 오차 때문에
 * 문턱과 같은 값을 만들어도 미세하게 크거나 작게 뜬다. 그래서 changeRate 자체를
 * 모킹해 정확한 값을 주입한다. 모킹이 파일 전체에 걸리므로 이 파일만 따로 둔다.
 */
import { describe, it, expect, vi } from 'vitest';

const rate = vi.hoisted(() => ({ value: 0 }));

vi.mock('../../../src/humanize/change-rate.js', () => ({
  changeRate: () => rate.value,
}));

const { runCheck, THRESHOLD } = await import('../../../src/humanize/check.js');

// A-1 하나가 끝까지 남아 제거율이 0이다. 그 자리에서 변경률만 문턱을 넘나든다
const before = '이 문제에 대해 정리한다.';
const after = '이 문제에 대해 정리한다.';

const verdictAt = (value: number) => {
  rate.value = value;
  return runCheck(before, after).axes.find((a) => a.axis === 'residual-s1')?.verdict;
};

describe('idleChange 경계', () => {
  it('문턱보다 작으면 윤문을 안 한 것이다', () => {
    expect(verdictAt(THRESHOLD.idleChange - 0.001)).toBe('abort');
  });

  it('문턱과 같으면 문턱 아래가 아니다', () => {
    // 부등호가 < 이므로 같은 값은 idle 이 아니다. <= 로 뒤집으면 이 단언이 죽는다
    expect(verdictAt(THRESHOLD.idleChange)).toBe('warn');
  });

  it('문턱을 넘으면 판정 범위 밖으로 넘긴다', () => {
    expect(verdictAt(THRESHOLD.idleChange + 0.001)).toBe('warn');
  });
});
