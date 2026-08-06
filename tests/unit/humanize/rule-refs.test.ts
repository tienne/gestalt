import { describe, it, expect } from 'vitest';
import { verifyRuleRefs } from '../../../scripts/verify-rule-refs.js';

describe('룰 참조 정합', () => {
  const issues = verifyRuleRefs();

  it('룰북에 없는 ID를 인용하는 에이전트 문서가 없다', () => {
    const errors = issues.filter((i) => i.level === 'error' && i.message.includes('없는 ID 인용'));
    expect(errors.map((e) => `${e.file} — ${e.message}`)).toEqual([]);
  });

  it('S1 선언과 자체검증 목록이 어긋나지 않는다', () => {
    const errors = issues.filter((i) => i.level === 'error' && i.message.includes('자체검증'));
    expect(errors.map((e) => `${e.file} — ${e.message}`)).toEqual([]);
  });

  it('룰 문서가 자기가 금지한 표현을 본문에 쓰지 않는다', () => {
    const errors = issues.filter((i) => i.level === 'error' && i.message.includes('금지 표현'));
    expect(errors.map((e) => `${e.file} — ${e.message}`)).toEqual([]);
  });

  it('오류가 하나도 없다', () => {
    const errors = issues.filter((i) => i.level === 'error');
    expect(errors.map((e) => `${e.file} — ${e.message}`)).toEqual([]);
  });
});
