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

  it('source.json 형식이 틀렸으면 ingest 대신 형식을 고치라고 안내한다', () => {
    const messages = (sourceProblem?: 'missing' | 'invalid') =>
      lintErrors(lintDigest(lensDigest(), lensTranscript(), { source: null, sourceProblem }))
        .filter((i) => i.code === 'TABLE_REF_UNKNOWN' || i.code === 'FIGURE_REF_UNKNOWN')
        .map((i) => i.message);
    expect(messages().length).toBeGreaterThan(0);
    expect(messages().every((m) => m.startsWith('source.json이 없어'))).toBe(true);
    expect(messages('invalid').length).toBeGreaterThan(0);
    expect(messages('invalid').every((m) => m.startsWith('source.json 형식이 틀려서'))).toBe(true);
  });

  it('카드와 근거를 같이 단 한계 줄도 근거 칸 숫자와 대조한다', () => {
    const r = lensReport();
    // 0.0002는 두 칸의 차이를 계산한 값이다. 카드 id가 있어도 근거 칸을 달았으니 막는다
    r.limits = [
      {
        text: '두 조합 점수 차이는 0.0002다.',
        evidence: [{ table: 'table-6', row: 1, col: 2 }],
        card: 'c1',
      },
    ];
    expect(codes(r)).toContain('LIMIT_NUMBER_UNKNOWN');
    // 카드만 단 줄은 바깥 자료 숫자를 옮길 수 있어 대조하지 않는다
    r.limits = [{ text: '후속 연구는 0.42를 보고했다.', evidence: [], card: 'c1' }];
    expect(codes(r)).not.toContain('LIMIT_NUMBER_UNKNOWN');
  });

  it('근거 칸이 음수여도 note에 그 숫자를 적으면 의심 표시를 받는다', () => {
    const source = lensSource();
    source.tables.push({
      id: 'table-5',
      number: '5',
      caption: 'Table 5: CSP gain.',
      rows: [
        ['Setting', 'Gain'],
        ['50 nodes', '-0.0374'],
        ['200 nodes', '0.0174'],
      ],
      grid: 'ok',
      unit: 4,
    });
    const r = lensReport();
    r.sections[1]!.subsections[0]!.bullets[0]!.doubt = {
      note: '표 5에서 노드 50개는 CSP 이득이 −0.0374다.',
      evidence: [{ table: 'table-5', row: 1, col: 1 }],
    };
    expect(codes(r, source)).toEqual([]);
  });

  it('영상 리포트에 렌즈 칸을 넣으면 LENS_FIELD_ON_VIDEO', () => {
    const d = sampleDigest();
    const lens = lensReport();
    const report = d.reports[0]!;
    report.lead.glance = lens.lead.glance;
    report.limits = lens.limits;
    const sub = report.sections[0]!.subsections[0]!;
    sub.bullets[0]!.children![0]!.doubt = lens.sections[1]!.subsections[0]!.bullets[0]!.doubt;
    sub.tables = [{ ref: 'table-4' }];
    const errs = lintErrors(lintDigest(d, sampleTranscript())).filter(
      (i) => i.code === 'LENS_FIELD_ON_VIDEO',
    );
    expect(errs.map((i) => i.path)).toEqual([
      'reports.0.lead.glance',
      'reports.0.limits',
      'reports.0.sections.0.subsections.0.tables',
      'reports.0.sections.0.subsections.0.bullets.0.children.0.doubt',
    ]);
    // 렌즈 칸이 없는 영상 리포트는 이 코드가 안 나온다
    expect(
      lintDigest(sampleDigest(), sampleTranscript()).some((i) => i.code === 'LENS_FIELD_ON_VIDEO'),
    ).toBe(false);
  });

  it('numbersIn은 천 단위 쉼표를 지우고 이름에 붙은 숫자는 세지 않는다', () => {
    expect(numbersIn('표 4의 6,653개와 0.2862, CSP2와 v3')).toEqual([4, 6653, 0.2862]);
    expect(numbersIn('제3자가 확인하지 않았다')).toEqual([]);
  });
});
