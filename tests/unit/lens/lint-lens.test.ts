import { describe, expect, it } from 'vitest';
import { lintDigest, lintErrors } from '../../../src/digest/lint.js';
import { numbersIn } from '../../../src/digest/lint-lens.js';
import { parseDigest } from '../../../src/digest/schema.js';
import { lensDigest, lensReport, lensSource, lensTranscript } from './fixture.js';
import { sampleDigest, sampleTranscript } from '../digest/fixture.js';

const codes = (r = lensReport(), source = lensSource()) =>
  lintErrors(lintDigest(lensDigest(r), lensTranscript(), { source })).map((i) => i.code);

describe('읽기 렌즈 lint', () => {
  it('유효한 논문 리포트는 오류가 없다', () => {
    expect(parseDigest(lensDigest()).ok).toBe(true);
    expect(codes()).toEqual([]);
  });

  it('글 자료는 frameSec 없이 통과하고 영상은 frameSec이 빠지면 막는다', () => {
    const d = sampleDigest();
    delete d.reports[0]!.sections[0]!.subsections[0]!.frameSec;
    const errs = lintErrors(lintDigest(d, sampleTranscript())).map((i) => i.code);
    expect(errs).toContain('FRAME_SEC_MISSING');
  });

  it('한눈에 보기 칸이 빠지면 GLANCE_MISSING', () => {
    const r = lensReport();
    r.lead.glance = r.lead.glance!.filter((g) => g.kind !== 'limit');
    expect(codes(r)).toContain('GLANCE_MISSING');
  });

  it('한계 단락이 없거나 근거가 없으면 막는다', () => {
    const r = lensReport();
    r.limits = [];
    expect(codes(r)).toContain('LIMITS_MISSING');
    r.limits = [{ text: '근거 없는 한계', evidence: [] }];
    expect(codes(r)).toContain('LIMIT_NO_SOURCE');
  });

  it('의심 표시에 근거 칸 숫자가 없으면 DOUBT_NOT_NUMERIC', () => {
    const r = lensReport();
    r.sections[1]!.subsections[0]!.bullets[0]!.doubt!.note = 'CSP 효과가 설정마다 다르다.';
    expect(codes(r)).toContain('DOUBT_NOT_NUMERIC');
  });

  it('의심 표시에 근거에 없는 숫자를 쓰면 DOUBT_NUMBER_UNKNOWN', () => {
    const r = lensReport();
    // 0.0374는 두 칸의 차이를 계산한 값이라 원문에 없다
    r.sections[1]!.subsections[0]!.bullets[0]!.doubt!.note =
      '노드 50개에서 0.3236이 0.2862로 0.0374 떨어진다.';
    expect(codes(r)).toContain('DOUBT_NUMBER_UNKNOWN');
  });

  it('줄 이름의 숫자(노드 50개)와 표 번호는 근거로 친다', () => {
    const r = lensReport();
    r.sections[1]!.subsections[0]!.bullets[0]!.doubt!.note =
      '표 4에서 노드 50개는 CSP를 켜면 0.3236에서 0.2862로 떨어진다.';
    expect(codes(r)).toEqual([]);
  });

  it('없는 표나 칸, 그림을 가리키면 막는다', () => {
    const r = lensReport();
    r.sections[1]!.subsections[0]!.bullets[0]!.doubt!.evidence = [
      { table: 'table-9', row: 1, col: 1 },
      { table: 'table-4', row: 9, col: 1 },
    ];
    r.sections[1]!.subsections[0]!.tables = [{ ref: 'table-7' }];
    r.sections[1]!.subsections[1]!.figures = [{ ref: 'figure-3' }];
    const c = codes(r);
    expect(c).toContain('TABLE_REF_UNKNOWN');
    expect(c).toContain('CELL_REF_OUT_OF_RANGE');
    expect(c).toContain('FIGURE_REF_UNKNOWN');
  });

  it('source.json이 없으면 표 칸 근거를 하나도 받지 않는다', () => {
    const errs = lintErrors(lintDigest(lensDigest(), lensTranscript(), { source: null }));
    expect(errs.map((i) => i.code)).toContain('TABLE_REF_UNKNOWN');
  });

  it('의심과 한계의 문단 근거도 원문 범위를 넘으면 막는다', () => {
    const r = lensReport();
    r.limits = [{ text: '범위 밖', evidence: [{ cite: { key: 40, from: 40, to: 40 } }] }];
    expect(codes(r)).toContain('CITE_OUT_OF_RANGE');
  });

  it('글 자료에 시각 구간을 주면 RANGE_NOT_SUPPORTED', () => {
    const r = lensReport();
    r.options.range = [0, 10];
    expect(codes(r)).toContain('RANGE_NOT_SUPPORTED');
  });

  it('numbersIn은 천 단위 쉼표를 지우고 이름에 붙은 숫자는 세지 않는다', () => {
    expect(numbersIn('표 4의 6,653개와 0.2862, CSP2와 v3')).toEqual([4, 6653, 0.2862]);
    expect(numbersIn('제3자가 확인하지 않았다')).toEqual([]);
  });
});
