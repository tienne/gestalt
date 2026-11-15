import { describe, expect, it } from 'vitest';
import { matchesSource, normalizeForMatch } from '../../../src/digest/prd-match.js';

const m = (text: string, source: string) =>
  matchesSource(normalizeForMatch(text), normalizeForMatch(source));

describe('원문 대조', () => {
  it('마크다운 기호와 공백, 구두점을 무시한다', () => {
    expect(m('반납 직후 추천 카드', '**반납 직후  추천 카드**: 보여 준다.')).toBe(true);
    expect(m('링크 글자', '[링크 글자](https://example.com)')).toBe(true);
  });

  it('조사 한 글자 차이는 통과시킨다', () => {
    expect(m('회원 취향을 반영하지 않는다', '회원 취향이 반영하지 않는다')).toBe(true);
  });

  it('완전히 다른 문장은 거절한다', () => {
    expect(m('결제 수단을 하나 더 늘린다', '반납 직후 추천 카드를 보여 준다')).toBe(false);
  });

  it('4자 미만 글은 대조하지 않는다', () => {
    expect(m('MVP', '전혀 다른 원문')).toBe(true);
  });
});
