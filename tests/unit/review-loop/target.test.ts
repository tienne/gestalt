import { describe, expect, it } from 'vitest';
import { parsePrNumber } from '../../../src/review-loop/target.js';

describe('대상에서 PR 번호를 뽑는다', () => {
  it.each([
    ['18', 18],
    ['#18', 18],
    ['  42  ', 42],
    ['https://github.com/owner/repo/pull/456', 456],
    ['https://github.com/owner/repo/pull/456/files', 456],
    ['https://github.com/owner/repo/pull/456#discussion_r1', 456],
  ])('%s → %i', (target, expected) => {
    expect(parsePrNumber(target)).toBe(expected);
  });

  /**
   * 이 값은 상태 디렉토리 이름과 `gh` 인자가 된다. 셸로 적던 때는 대상 문자열을
   * 작은따옴표 안에 합성해서, 따옴표가 섞인 값이 정수 검증에 닿기도 전에 명령으로
   * 실행됐다. 여기서는 문자열이 셸에 안 가지만 경로를 벗어나는 값도 함께 막는다.
   */
  it.each([
    "123'; touch /tmp/pwned; t='456",
    '../../../etc',
    '18abc',
    '',
    '  ',
    '#',
    '-5',
    '0',
    'https://github.com/o/r/pull/abc',
    '1e3',
  ])('%j 는 거부한다', (target) => {
    expect(() => parsePrNumber(target)).toThrow(/PR 번호로 못 읽었습니다/);
  });
});
