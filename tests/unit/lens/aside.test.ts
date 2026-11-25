import { describe, expect, it } from 'vitest';
import { lintDigest, lintErrors, type DigestIssue } from '../../../src/digest/lint.js';
import { extractProse } from '../../../src/digest/prose.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { parseDigest, primerSchema, type Report } from '../../../src/digest/schema.js';
import { sampleDigest, sampleTranscript } from '../digest/fixture.js';
import { lensDigest, lensReport, lensSource } from './fixture.js';
import { deployTranscript, parcel } from './deploy-fixture.js';

/** 쉬운 리포트에 비유 불릿, 예시 불릿, 먼저 보기를 하나씩 단다 */
function easyReport(): Report {
  const r = lensReport();
  r.options.difficulty = 'easy';
  r.sections[1]!.subsections[0]!.bullets.push({
    text: 'CSP는 **재료 궁합표에 덧붙인 메모**라고 생각하면 쉬워요.',
    cite: { key: 3, from: 3, to: 3 },
    aside: 'analogy',
  });
  r.sections[1]!.subsections[1]!.bullets.push({
    text: '재료 2개를 처음 섞어 보는 소스를 떠올려 보면 쉬워요.',
    cite: { key: 5, from: 5, to: 6 },
    aside: 'example',
  });
  r.lead.primer = {
    analogy: parcel(),
    rules: [
      {
        text: '노드 50개에서는 CSP를 끈 쪽이 **0.3236**으로 더 높다',
        cite: { table: 'table-4', row: 1, col: 1 },
      },
      { text: '새 조합은 **맛으로 확인하지 않았다**', cite: { key: 5, from: 5, to: 5 } },
    ],
  };
  return r;
}

const issues = (r: Report): DigestIssue[] =>
  lintDigest(lensDigest(r), deployTranscript(), { source: lensSource() }).filter(
    (i) => i.code !== 'SECTION_GAP',
  );
const codes = (r: Report) => lintErrors(issues(r)).map((i) => i.code);

describe('설명 장치 lint', () => {
  it('쉬운 리포트의 비유, 예시 불릿과 먼저 보기는 통과한다', () => {
    const r = easyReport();
    expect(parseDigest(lensDigest(r)).ok).toBe(true);
    expect(codes(r)).toEqual([]);
  });

  it('보통 리포트에는 설명 장치를 못 쓴다', () => {
    const r = easyReport();
    r.options.difficulty = 'normal';
    const errs = lintErrors(issues(r)).filter((i) => i.code === 'ASIDE_ON_NORMAL');
    expect(errs.map((i) => i.path)).toEqual([
      'reports.0.sections.1.subsections.0.bullets.1.aside',
      'reports.0.sections.1.subsections.1.bullets.1.aside',
      'reports.0.lead.primer',
    ]);
  });

  it('비유에는 숫자를, 예시에는 지표 말을 못 쓴다', () => {
    const r = easyReport();
    r.sections[1]!.subsections[0]!.bullets[1]!.text = '메모 3장을 덧붙인 궁합표예요.';
    r.sections[1]!.subsections[1]!.bullets[1]!.text = '재료가 2개면 정확도가 떨어질 수 있어요.';
    const c = codes(r);
    expect(c).toContain('ASIDE_HAS_NUMBER');
    expect(c).toContain('ASIDE_METRIC_LABEL');
  });

  it('예시 숫자는 원문과 대조하지 않는다', () => {
    const r = easyReport();
    r.sections[1]!.subsections[1]!.bullets[1]!.text =
      '재료 7개를 한꺼번에 섞는 소스를 떠올려 봐요.';
    expect(codes(r)).toEqual([]);
  });

  it('설명 장치 불릿에는 의심 표시를 못 단다', () => {
    const r = easyReport();
    const bullets = r.sections[1]!.subsections[0]!.bullets;
    bullets[1]!.doubt = bullets[0]!.doubt;
    expect(codes(r)).toContain('ASIDE_HAS_DOUBT');
  });

  it('소섹션 1단 불릿의 절반을 넘으면 경고한다', () => {
    const r = easyReport();
    expect(issues(r).some((i) => i.code === 'ASIDE_TOO_MANY')).toBe(false);
    r.sections[1]!.subsections[0]!.bullets.push({
      text: '궁합표를 냉장고 지도라고 생각해도 좋아요.',
      cite: { key: 3, from: 3, to: 3 },
      aside: 'analogy',
    });
    const warn = issues(r).find((i) => i.code === 'ASIDE_TOO_MANY');
    expect(warn?.severity).toBe('warning');
    expect(warn?.path).toBe('reports.0.sections.1.subsections.0.bullets');
  });

  it('먼저 보기 규칙 줄은 출처 칸과 숫자를 대조한다', () => {
    const wrong = easyReport();
    wrong.lead.primer!.rules[0]!.text = '노드 50개에서는 CSP를 끈 쪽이 0.3300으로 더 높다';
    expect(codes(wrong)).toContain('PRIMER_NUMBER_UNKNOWN');
    const cell = easyReport();
    cell.lead.primer!.rules[0]!.cite = { table: 'table-4', row: 9, col: 1 };
    expect(codes(cell)).toContain('CELL_REF_OUT_OF_RANGE');
  });

  it('먼저 보기 비유 표도 비유 표 규칙을 받는다', () => {
    const r = easyReport();
    r.lead.primer!.analogy!.breaks = [];
    r.lead.primer!.analogy!.rows[0]!.analog = 'main 장부';
    const errs = lintErrors(issues(r));
    expect(errs.map((i) => i.code)).toEqual(
      expect.arrayContaining(['ANALOGY_BREAKS_EMPTY', 'B_BORROWS_NAME']),
    );
    expect(errs.every((i) => i.path.startsWith('reports.0.lead.primer.analogy'))).toBe(true);
  });

  it('먼저 보기 규칙은 2~4줄이다', () => {
    const rule = { text: '한 줄', cite: { key: 1, from: 1, to: 1 } };
    expect(primerSchema.safeParse({ rules: [rule] }).success).toBe(false);
    expect(primerSchema.safeParse({ rules: [rule, rule] }).success).toBe(true);
    expect(primerSchema.safeParse({ rules: Array(5).fill(rule) }).success).toBe(false);
  });

  it('영상 리포트에는 설명 장치와 먼저 보기를 못 쓴다', () => {
    const d = sampleDigest();
    const report = d.reports[0]!;
    report.sections[0]!.subsections[0]!.bullets[0]!.aside = 'analogy';
    report.lead.primer = easyReport().lead.primer;
    const paths = lintErrors(lintDigest(d, sampleTranscript()))
      .filter((i) => i.code === 'LENS_FIELD_ON_VIDEO')
      .map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        'reports.0.lead.primer',
        'reports.0.sections.0.subsections.0.bullets.0.aside',
      ]),
    );
  });
});

describe('설명 장치 렌더', () => {
  const opts = { source: lensSource() };

  it('비유, 예시 배지를 렌더러가 붙이고 바탕을 바꾼다', () => {
    const html = renderDigestHtml(lensDigest(easyReport()), deployTranscript(), opts).html;
    expect(html).toContain(
      '<li class="aside aside-analogy"><span class="aside-badge">비유</span> ',
    );
    expect(html).toContain(
      '<li class="aside aside-example"><span class="aside-badge">예시</span> ',
    );
  });

  it('먼저 보기는 한눈에 보기 바로 아래에 규칙 줄과 비유 표를 둔다', () => {
    const html = renderDigestHtml(lensDigest(easyReport()), deployTranscript(), opts).html;
    const glance = html.indexOf('<section class="glance"');
    const primer = html.indexOf('<section class="primer" aria-label="먼저 보기">');
    expect(glance).toBeGreaterThan(-1);
    expect(primer).toBeGreaterThan(glance);
    const block = html.slice(primer, html.indexOf('</section>', primer));
    expect(block).toContain('data-cell="table-4:1:1"');
    expect(html.slice(primer)).toContain('<span class="w-badge w-badge-analogy">');
  });

  it('마크다운에도 배지와 먼저 보기를 낸다', () => {
    const md = renderDigestMarkdown(lensDigest(easyReport()), deployTranscript(), opts);
    expect(md).toContain('- *(비유)* CSP는');
    expect(md).toContain('- *(예시)* 재료 2개를');
    expect(md).toContain('**먼저 보기**');
    expect(md).toContain('(표 4 2행 2열: 0.3236)');
    expect(md).toContain('비유가 안 맞는 곳:');
  });

  it('윤문은 먼저 보기 규칙 줄과 비유 표 글자를 받는다', () => {
    const paths = extractProse(lensDigest(easyReport())).map((p) => p.path);
    expect(paths).toContain('reports.0.lead.primer.rules.0.text');
    expect(paths.some((p) => p.startsWith('reports.0.lead.primer.analogy.rows.'))).toBe(true);
  });
});
