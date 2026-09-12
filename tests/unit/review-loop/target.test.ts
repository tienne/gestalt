import { describe, expect, it } from 'vitest';
import { parsePrNumber, parseTarget } from '../../../src/review-loop/target.js';

describe('대상에서 PR 번호를 뽑는다', () => {
  it.each([
    ['18', 18],
    ['#18', 18],
    ['  42  ', 42],
    ['https://github.com/owner/repo/pull/456', 456],
    ['https://github.com/owner/repo/pull/456/files', 456],
    ['https://github.com/owner/repo/pull/456#discussion_r1', 456],
    ['https://github.com/owner/repo/pull/456?w=1', 456],
  ])('%s → %i', (target, expected) => {
    expect(parsePrNumber(target)).toBe(expected);
  });

  /**
   * 이 값은 상태 디렉토리 이름과 `gh` 인자가 된다. 셸로 적던 때는 대상 문자열을
   * 작은따옴표 안에 합성해서, 따옴표가 섞인 값이 정수 검증에 닿기 전에 명령으로
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
    '1e3',
    // 자릿수가 많으면 Number 가 지수 표기로 뭉개 정수 검사를 통과한다
    '99999999999999999999',
    'https://github.com/o/r/pull/abc',
    // 번호 뒤에 글자가 붙은 꼴. 꼬리 제약이 풀리면 12로 조용히 읽힌다
    'https://github.com/o/r/pull/12abc',
    'https://github.com/o/r/pull/12x/files',
  ])('%j 는 거부한다', (target) => {
    expect(() => parsePrNumber(target)).toThrow();
  });
});

describe('URL 이면 레포까지 읽는다', () => {
  /**
   * 번호만 뽑고 레포를 버리면 남의 레포 PR 을 가리켜도 조회는 현재 레포의 같은 번호를
   * 본다. 그 수로 승인이 나간다 — 실제로 cli/cli#1 요청이 로컬 레포 #1의 수로 답했다.
   */
  it('owner 와 repo 를 함께 돌려준다', () => {
    expect(parseTarget('https://github.com/cli/cli/pull/1')).toEqual({
      prNumber: 1,
      owner: 'cli',
      repo: 'cli',
    });
  });

  it('점이 든 레포 이름도 받는다', () => {
    expect(parseTarget('https://github.com/o/my.repo-name/pull/7')).toEqual({
      prNumber: 7,
      owner: 'o',
      repo: 'my.repo-name',
    });
  });

  it('번호로만 주면 레포가 안 붙는다 — 현재 레포를 쓴다는 뜻이다', () => {
    expect(parseTarget('18')).toEqual({ prNumber: 18 });
    expect(parseTarget('#18')).toEqual({ prNumber: 18 });
  });

  it('github.com 이 아닌 주소는 거부한다', () => {
    // 아무 도메인의 /pull/ 경로가 번호로 읽히면 조회 대상이 조용히 바뀐다
    expect(() => parseTarget('https://evil.example.com/x/pull/7')).toThrow(/github\.com/);
    expect(() => parseTarget('https://github.com.evil.io/o/r/pull/7')).toThrow(/github\.com/);
  });

  it('레포 자리가 비었으면 거부한다', () => {
    expect(() => parseTarget('https://github.com//r/pull/7')).toThrow();
    expect(() => parseTarget('https://github.com/pull/7')).toThrow();
  });
});
