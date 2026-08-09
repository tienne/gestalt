import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { countS1ByFile, verifyRuleRefs } from '../../../scripts/verify-rule-refs.js';

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

describe('S1 어투 베이스라인', () => {
  const issues = verifyRuleRefs();

  it('에이전트 문서에 S1 패턴이 기준보다 늘지 않았다', () => {
    const errors = issues.filter((i) => i.message.includes('S1 어투 패턴'));
    expect(errors.map((e) => `${e.file} — ${e.message}`)).toEqual([]);
  });

  it('기준에 잠긴 문서만 S1을 남기고 있다', () => {
    const baseline = JSON.parse(
      readFileSync(new URL('../../../scripts/humanize-baseline.json', import.meta.url), 'utf-8'),
    ) as Record<string, number>;
    for (const [file, count] of countS1ByFile()) {
      expect(`${file}: ${count}`).toBe(`${file}: ${baseline[file] ?? 0}`);
    }
  });
});
