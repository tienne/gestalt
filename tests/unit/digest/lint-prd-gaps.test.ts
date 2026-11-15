import { describe, expect, it } from 'vitest';
import { collectPrdGaps, isDateLike, type PrdGapCode } from '../../../src/digest/lint-prd-gaps.js';
import { lintPrdView, prdLintErrors } from '../../../src/digest/lint-prd.js';
import { parsePrdView, type PrdView } from '../../../src/digest/prd-schema.js';
import { sampleSource, sampleView, sampleViewWithStage3 } from './prd-fixture.js';

type Json = Record<string, any>;

function parse(v: Json): PrdView {
  const r = parsePrdView(v);
  if (!r.ok) throw new Error(r.issues.join('\n'));
  return r.value;
}

const codes = (v: Json) => collectPrdGaps(parse(v)).map((g) => g.code);

/** 빈칸이 하나도 없게 고친 샘플 */
function cleanView(): Json {
  const v = sampleView() as Json;
  v.sections[0].blocks[1].status = 'confirmed';
  v.sections[1].blocks[1].metrics = ['M2'];
  v.sections[2].blocks[1].baseline = '5%';
  return v;
}

describe('collectPrdGaps', () => {
  it('빈칸이 없는 뷰에서는 아무것도 내지 않는다', () => {
    expect(codes(cleanView())).toEqual([]);
  });

  it('1단계 샘플 뷰에서 베이스라인, 연결 없는 요구사항, 미정 주장을 잡는다', () => {
    const gaps = collectPrdGaps(parse(sampleView()));
    expect(gaps.map((g) => [g.code, g.blockIds])).toEqual([
      ['BASELINE_NO_NUMBER', ['m2']],
      ['REQUIREMENT_UNLINKED', ['r2']],
      ['OPEN_CLAIMS', ['c2']],
    ]);
  });

  it.each<[PrdGapCode, (v: Json) => void]>([
    ['BASELINE_NO_NUMBER', (v) => delete v.sections[2].blocks[0].baseline],
    ['DUE_NOT_DATE', (v) => (v.sections[4].blocks[0].due = '다음 스프린트')],
    ['DUE_NOT_DATE', (v) => delete v.sections[4].blocks[0].due],
    [
      'METRIC_UNLINKED',
      (v) => {
        v.sections[1].blocks[0].metrics = ['M1'];
        v.sections[1].blocks[1].metrics = ['M1'];
      },
    ],
    ['REQUIREMENT_UNLINKED', (v) => delete v.sections[1].blocks[0].metrics],
    ['DECISION_UNCONFIRMED', (v) => (v.sections[3].blocks[0].decided = '같은 장르로 하자는 제안')],
    ['OPEN_CLAIMS', (v) => (v.sections[0].blocks[0].status = 'open')],
  ])('%s를 잡는다', (code, mutate) => {
    const v = cleanView();
    mutate(v);
    expect(codes(v)).toContain(code);
  });

  it('중첩 필드에 남은 TBD 자리표시를 필드 경로와 함께 잡는다', () => {
    const v = cleanView();
    v.sections[3].blocks[0].rejected[0].reason = '{{TBD: 이유}}';
    const gap = collectPrdGaps(parse(v)).find((g) => g.code === 'TBD_PLACEHOLDER')!;
    expect(gap.blockIds).toEqual(['d1']);
    expect(gap.field).toBe('rejected.0.reason');
  });

  it('미정 주장은 여러 개여도 한 건으로 묶는다', () => {
    const v = sampleView() as Json;
    v.sections[0].blocks[0].status = 'open';
    const open = collectPrdGaps(parse(v)).filter((g) => g.code === 'OPEN_CLAIMS');
    expect(open).toHaveLength(1);
    expect(open[0]!.blockIds).toEqual(['c1', 'c2']);
  });

  it('가상 화법 인용을 잡는다', () => {
    expect(codes(sampleViewWithStage3())).toContain('QUOTE_VIRTUAL');
  });

  it('날짜 꼴 네 가지를 날짜로 본다', () => {
    for (const s of ['2026-3-10', '3/10', '3월 10일', 'D-7']) expect(isDateLike(s)).toBe(true);
    expect(isDateLike('다음 주')).toBe(false);
  });
});

describe('3단계 블록', () => {
  it('8개 블록을 담은 뷰도 lint 오류 없이 통과한다', () => {
    const view = parse(sampleViewWithStage3());
    expect(prdLintErrors(lintPrdView(view, sampleSource()).issues)).toEqual([]);
  });

  it('stateMatrix 셀 모양이 rows, cols와 다르면 거절한다', () => {
    const v = sampleViewWithStage3();
    v.sections[5].blocks[4].cells = [['22%']];
    const r = parsePrdView(v);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join('\n')).toContain('cells');
  });

  it('flow는 단계 두 개 이상, quote origin은 enum만 받는다', () => {
    const a = sampleViewWithStage3();
    a.sections[5].blocks[3].steps = ['하나'];
    expect(parsePrdView(a).ok).toBe(false);
    const b = sampleViewWithStage3();
    b.sections[5].blocks[2].origin = 'made-up';
    expect(parsePrdView(b).ok).toBe(false);
  });
});
