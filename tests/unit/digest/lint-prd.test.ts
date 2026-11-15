import { describe, expect, it } from 'vitest';
import { lintPrdView } from '../../../src/digest/lint-prd.js';
import { parsePrdView, type PrdView } from '../../../src/digest/prd-schema.js';
import { sourceFromText } from '../../../src/digest/prd-source.js';
import { sampleSource, sampleView } from './prd-fixture.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function parse(v: Json): PrdView {
  const r = parsePrdView(v);
  if (!r.ok) throw new Error(r.issues.join('\n'));
  return r.value;
}
function lint(patch: (v: Json) => void = () => {}) {
  const v = sampleView() as Json;
  patch(v);
  return lintPrdView(parse(v), sampleSource());
}
const codes = (patch?: (v: Json) => void) => lint(patch).issues.map((i) => i.code);

describe('lintPrdView', () => {
  it('샘플 뷰는 오류와 경고가 없고 빠진 줄도 없다', () => {
    const r = lint();
    expect(r.issues).toEqual([]);
    expect(r.coverage).toMatchObject({ contentLines: 14, omittedLines: 1, uncoveredLines: 0 });
  });

  it('id와 metricId 중복, 없는 지표 참조를 오류로 잡는다', () => {
    expect(codes((v) => (v.sections[0].blocks[1].id = 'c1'))).toContain('DUPLICATE_ID');
    expect(codes((v) => (v.sections[1].id = 'problem'))).toContain('DUPLICATE_ID');
    expect(codes((v) => (v.sections[2].blocks[1].metricId = 'M1'))).toContain(
      'DUPLICATE_METRIC_ID',
    );
    expect(codes((v) => (v.sections[1].blocks[0].metrics = ['M9']))).toContain('UNKNOWN_METRIC');
  });

  it('원문 줄 수 밖 src와 빈 줄만 가리키는 src를 오류로 잡는다', () => {
    expect(codes((v) => (v.sections[0].blocks[0].src = [[14, 99]]))).toContain('SRC_OUT_OF_RANGE');
    expect(codes((v) => (v.omitted[0].src = [[50, 50]]))).toContain('SRC_OUT_OF_RANGE');
    expect(codes((v) => (v.sections[0].blocks[0].src = [[11, 13]]))).toContain('SRC_ON_BLANK');
  });

  it('원문에 없는 글과 숫자를 경고한다', () => {
    const issues = lint((v) => {
      v.sections[0].blocks[0].text = '결제 수단을 하나 더 늘리면 매출이 오른다';
      v.sections[2].blocks[0].target = '35%';
    }).issues;
    expect(issues.map((i) => i.code)).toEqual(
      expect.arrayContaining(['TEXT_NOT_IN_SOURCE', 'NUMBER_NOT_IN_SOURCE']),
    );
    expect(issues.find((i) => i.code === 'NUMBER_NOT_IN_SOURCE')?.blockId).toBe('m1');
  });

  it('summary 블록은 글자 대조를 건너뛰고 숫자 대조는 한다', () => {
    const patch = (text: string) => (v: Json) => {
      v.sections[0].blocks[0].text = text;
      v.sections[0].blocks[0].summary = true;
    };
    expect(codes(patch('다음 책을 못 고르면 회원이 떠난다(40%)'))).toEqual([]);
    expect(codes(patch('다음 책을 못 고르면 회원 절반(50%)이 떠난다'))).toEqual([
      'NUMBER_NOT_IN_SOURCE',
    ]);
  });

  it('metricId가 범위에 없거나 섹션 제목이 헤딩에 없거나 원문이 바뀌면 경고한다', () => {
    expect(codes((v) => (v.sections[2].blocks[1].src = [[30, 30]]))).toEqual([]);
    expect(codes((v) => (v.sections[2].blocks[1].metricId = 'K2'))).toEqual([
      'UNKNOWN_METRIC',
      'METRIC_ID_NOT_IN_SOURCE',
    ]);
    expect(codes((v) => (v.sections[0].title = '배송 정책'))).toEqual([
      'SECTION_TITLE_NOT_IN_SOURCE',
    ]);
    expect(codes((v) => (v.meta.sourceSha256 = '0'.repeat(64)))).toEqual(['SOURCE_STALE']);
  });

  it('너무 넓은 src와 문서 대부분을 덮는 src를 경고한다', () => {
    const lines = Array.from({ length: 40 }, (_, k) => `요구 문장 번호 ${k + 1}`);
    const source = sourceFromText('x.md', ['# 요구', ...lines].join('\n'));
    const view = parse({
      ...sampleView(),
      meta: { title: 't', source: 'x.md' },
      sections: [
        {
          id: 's',
          title: '요구',
          blocks: [{ id: 'p', kind: 'prose', src: [[2, 41]], text: '요구 문장 번호 1' }],
        },
      ],
      omitted: [],
    });
    const c = lintPrdView(view, source).issues.map((i) => i.code);
    expect(c).toEqual(expect.arrayContaining(['SRC_TOO_WIDE', 'SRC_COVERS_MOST']));
  });

  describe('coverage', () => {
    // 내용 줄 10줄짜리 원문. 앞에서 n줄을 블록이 덮는다
    const ten = sourceFromText(
      'x.md',
      ['# 섹션', ...Array.from({ length: 10 }, (_, k) => `원문 줄 ${k + 1}`)].join('\n'),
    );
    const viewCovering = (n: number, omitted: Json[] = []) =>
      parse({
        ...sampleView(),
        meta: { title: 't', source: 'x.md' },
        sections: [
          {
            id: 's',
            title: '섹션',
            blocks: [
              { id: 'p', kind: 'prose', src: [[2, 1 + n]], text: '원문 줄 1', summary: true },
            ],
          },
        ],
        omitted,
      });
    const covCodes = (n: number, omitted?: Json[]) =>
      lintPrdView(viewCovering(n, omitted), ten).issues.map((i) => i.code);

    it('정확히 10%와 30%에서는 안 붙고 넘을 때 붙는다', () => {
      expect(covCodes(9)).toEqual([]);
      expect(covCodes(8)).toEqual(['COVERAGE_GAP']);
      expect(covCodes(7)).toEqual(['COVERAGE_GAP']);
      expect(covCodes(6)).toEqual(['COVERAGE_LOW']);
    });

    it('omitted 구간은 빠진 줄에서 제외하고 너무 많으면 경고한다', () => {
      expect(covCodes(6, [{ src: [[8, 11]], reason: '이력' }])).toEqual(['OMITTED_TOO_MUCH']);
      expect(covCodes(8, [{ src: [[10, 11]], reason: '이력' }])).toEqual([]);
    });

    it('이어진 빠진 줄은 사이의 빈 줄과 헤딩을 건너뛰어 한 구간으로 묶는다', () => {
      const src = sourceFromText(
        'x.md',
        ['# a', '덮인 줄', '빠진 줄 1', '', '## b', '빠진 줄 2'].join('\n'),
      );
      const view = parse({
        ...sampleView(),
        meta: { title: 't', source: 'x.md' },
        sections: [
          {
            id: 's',
            title: 'a',
            blocks: [{ id: 'p', kind: 'prose', src: [[2, 2]], text: '덮인 줄' }],
          },
        ],
        omitted: [],
      });
      const r = lintPrdView(view, src);
      expect(r.coverage.ranges).toEqual([{ from: 3, to: 6, preview: '빠진 줄 1' }]);
      expect(r.coverage.uncoveredLines).toBe(2);
    });

    it('내용 줄이 없으면 비율은 0이다', () => {
      const empty = sourceFromText('x.md', '# 제목\n\n## 둘\n');
      const view = parse({
        ...sampleView(),
        meta: { title: 't', source: 'x.md' },
        sections: [
          {
            id: 's',
            title: '제목',
            blocks: [{ id: 'p', kind: 'prose', src: [[1, 1]], text: '제목' }],
          },
        ],
        omitted: [],
      });
      const r = lintPrdView(view, empty);
      expect(r.coverage.uncoveredRatio).toBe(0);
      expect(r.issues.map((i) => i.code)).toEqual(['SRC_ON_BLANK']);
    });
  });
});
