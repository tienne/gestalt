import { describe, expect, it } from 'vitest';
import { lintResearch, parseResearch, isSafeRelativePath } from '../../../src/research/index.js';
import { sampleResearch } from './fixture.js';

function parseOk(input: unknown) {
  const r = parseResearch(input);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe('parseResearch', () => {
  it('최소 샘플을 받아 기본값을 채운다', () => {
    const r = parseOk(sampleResearch());
    expect(r.schemaVersion).toBe('1.0.0');
    expect(r.premise.symbolLegend).toContain('◎');
  });

  it('목표 지표가 없으면 거절한다', () => {
    const input = sampleResearch();
    (input.premise as { goalMetric: string }).goalMetric = '';
    const r = parseResearch(input);
    expect(r.ok).toBe(false);
  });

  it('없는 제품을 가리키는 화면과 캡처를 거절한다', () => {
    const input = sampleResearch();
    input.screenMap![0]!.productId = 'zzz';
    const r = parseResearch(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('없는 제품: zzz');
  });

  it('보류 판단에 holdUntil이 없으면 거절한다', () => {
    const input = sampleResearch();
    delete input.judgment![1]!.holdUntil;
    const r = parseResearch(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain('holdUntil');
  });

  it('제외 판단은 holdUntil 없이 받는다', () => {
    const input = sampleResearch();
    input.judgment!.push({
      area: '선물 분기',
      conclusion: '이번 과제 범위에서 뺀다',
      confidence: 'out',
      rationale: '구매 단계를 하나 늘린다',
    });
    expect(parseResearch(input).ok).toBe(true);
  });

  it('기준 행 칸에 기호가 없으면, 부담 행 칸에 기호가 있으면 거절한다', () => {
    const noSymbol = sampleResearch();
    delete noSymbol.comparison![0]!.cells[0]!.symbol;
    expect(parseResearch(noSymbol).ok).toBe(false);

    const withSymbol = sampleResearch();
    withSymbol.comparison![1]!.cells[0]!.symbol = '○';
    expect(parseResearch(withSymbol).ok).toBe(false);
  });

  it('겹치는 id와 없는 레퍼런스를 거절한다', () => {
    const dup = sampleResearch();
    dup.productCandidates![1]!.id = 'a';
    expect(parseResearch(dup).ok).toBe(false);

    const missing = sampleResearch();
    missing.reasons![0]!.referenceId = 'nope';
    expect(parseResearch(missing).ok).toBe(false);
  });

  it('캡처 경로는 폴더 안 상대 경로와 이미지 확장자만 받는다', () => {
    for (const path of [
      '/etc/passwd.png',
      '../x.png',
      'a/../b.png',
      'C:\\x.png',
      'captures/a.txt',
    ]) {
      const input = sampleResearch();
      input.captures![0]!.path = path;
      expect(parseResearch(input).ok, path).toBe(false);
    }
    expect(isSafeRelativePath('captures/a.png')).toBe(true);
  });

  it('slug는 경로로 쓸 수 있는 꼴만 받는다', () => {
    const input = sampleResearch();
    input.meta.slug = '../escape';
    expect(parseResearch(input).ok).toBe(false);
  });
});

describe('lintResearch', () => {
  it('깨끗한 샘플은 경고가 없다', () => {
    expect(lintResearch(parseOk(sampleResearch()))).toEqual([]);
  });

  it('효과 문장에 (해석)이 빠지면 경고한다', () => {
    const input = sampleResearch();
    input.reasons![0]!.business = '인기 상품을 먼저 보여줘서 구매 전환이 늘어난다';
    const w = lintResearch(parseOk(input));
    expect(w.some((x) => x.path === 'reasons.0.business')).toBe(true);
  });

  it('회사 발언 표기가 있으면 통과한다', () => {
    const input = sampleResearch();
    input.reasons![0]!.business = '구매 전환을 높이려고 순위를 둔다 (회사 컨퍼런스 발표 14:32)';
    const w = lintResearch(parseOk(input));
    expect(w.some((x) => x.path === 'reasons.0.business')).toBe(false);
  });

  it('레퍼런스가 3~5개가 아니면 경고한다', () => {
    const input = sampleResearch();
    input.references = input.references!.slice(0, 2);
    input.comparison = [];
    input.mockups = [];
    input.reasons = [];
    input.wowPain = { userViewpoint: '', bizViewpoint: '', items: [], findings: [] };
    input.adoptions = [];
    const w = lintResearch(parseOk(input));
    expect(w.some((x) => x.path === 'references')).toBe(true);
  });

  it('조합 확인 전 캡처와 pii unchecked와 빈 열린 질문을 경고한다', () => {
    const input = sampleResearch();
    delete input.plan!.confirmedAt;
    input.captures![0]!.pii = 'unchecked';
    delete input.openQuestions;
    const paths = lintResearch(parseOk(input)).map((x) => x.path);
    expect(paths).toContain('plan.confirmedAt');
    expect(paths).toContain('captures.0.pii');
    expect(paths).toContain('openQuestions');
  });

  it('와우 페인 칸의 불릿이 2개가 아니면 경고한다', () => {
    const input = sampleResearch();
    input.wowPain!.items![0]!.userWow = ['하나뿐이에요'];
    const w = lintResearch(parseOk(input));
    expect(w.some((x) => x.path === 'wowPain.items.0.userWow')).toBe(true);
  });
});
