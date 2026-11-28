import { describe, expect, it } from 'vitest';
import { lintPrdView } from '../../../src/digest/lint-prd.js';
import { collectPrdGaps } from '../../../src/digest/lint-prd-gaps.js';
import { lintPrdProse } from '../../../src/digest/lint-prd-prose.js';
import { parsePrdView } from '../../../src/digest/prd-schema.js';
import { PRD_CSS } from '../../../src/digest/prd-css.js';
import { renderPrdHtml } from '../../../src/digest/render-prd.js';
import { inlineLabel, inlineMd } from '../../../src/digest/render-prd-blocks.js';
import { sampleV2, sampleView } from './prd-fixture.js';

function render() {
  const { view, source } = sampleV2();
  const lint = lintPrdView(view, source);
  return renderPrdHtml(view, {
    sourceSha256: source.sha256,
    coverage: lint.coverage,
    gaps: collectPrdGaps(view),
    prose: lintPrdProse(view, source),
    issues: lint.issues,
  });
}

describe('탭형 PRD 렌더', () => {
  it('다섯 탭과 대응 패널, 검수 배지 하나를 제공하고 테마는 자동으로 연다', () => {
    const html = render();
    for (const id of ['prd', 'spec', 'metrics', 'decisions', 'review']) {
      expect(html).toContain(`id="tab-${id}" aria-controls="panel-${id}"`);
      expect(html).toContain(`data-panel="${id}" role="tabpanel" aria-labelledby="tab-${id}"`);
    }
    expect(html.match(/class="badge review-count"/g)).toHaveLength(1);
    expect(html).toContain('<html lang="ko">');
    expect(html).toContain('data-source-toggle aria-pressed="false"');
    expect(html).toContain('<details class="theme-pop"><summary>');
    expect(html).toContain('id="theme-bg"');
    expect(html).toContain('value="100" aria-label="원문 반영"');
  });

  it('parent 트리, 9칸, 수용 기준, 질문 링크와 단계 필터를 그린다', () => {
    const html = render();
    expect(html).toMatch(/data-req-node="group"[\s\S]*?<ul><li data-req-node="r1"/);
    expect(html.match(/class="slot filled"/g)).toHaveLength(9);
    expect(html).toContain('id="slot-r1-data"');
    expect(html).not.toContain('data-feature-card="group"');
    expect(html).not.toContain('id="slot-group-data"');
    expect(html).toContain('<input type="checkbox">');
    expect(html).toContain('href="#d-q1"');
    expect(html).toContain('data-phase-filter="mvp"');
    expect(html).toContain('data-phase-filter="later"');
    expect(html).toContain('data-req-step="-1"');
    expect(html).toContain('data-req-step="1"');
    expect(html).toContain('value="9"');
    expect(html).toContain('disabled title="그래프 보기는 준비 중이에요"');
  });

  it('지표를 역할별로 묶고 연결된 기능 제목을 표시한다', () => {
    const parsed = parsePrdView(sampleView());
    if (!parsed.ok) throw new Error('fixture');
    const view = parsed.value;
    const section = view.sections[2]!;
    const metric = section.blocks.find((b) => b.kind === 'metric')!;
    if (metric.kind !== 'metric') throw new Error('metric');
    section.blocks.push({ ...metric, id: 'm3', metricId: 'M3', role: 'guardrail' });
    section.blocks.push({ ...metric, id: 'm4', metricId: 'M4', role: undefined });
    const { source } = sampleV2();
    const html = renderPrdHtml(view, {
      sourceSha256: source.sha256,
      coverage: lintPrdView(view, source).coverage,
    });
    const metrics = html.slice(
      html.indexOf('id="panel-metrics"'),
      html.indexOf('id="panel-decisions"'),
    );
    for (const role of ['primary', 'secondary', 'guardrail', 'other'])
      expect(metrics).toContain(`id="metrics-${role}"`);
    expect(metrics).toContain('href="#f-r1">반납 직후 추천 카드</a>');
    expect(metrics).toContain('움직이는 요구사항');
    expect(PRD_CSS).not.toContain('\n.tbl tbody th{white-space:nowrap}');
  });

  it('1.0 문서는 섹션별로 묶고 빈칸은 질문과 점선으로 드러낸다', () => {
    const raw = { ...sampleView(), schemaVersion: '1.0.0' };
    const parsed = parsePrdView(raw);
    if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
    const { source } = sampleV2();
    const html = renderPrdHtml(parsed.value, {
      sourceSha256: source.sha256,
      coverage: lintPrdView(parsed.value, source).coverage,
      gaps: collectPrdGaps(parsed.value),
    });
    const spec = html.slice(html.indexOf('id="panel-spec"'), html.indexOf('id="panel-metrics"'));
    expect(spec).toContain('class="req-group"><p class="grp">요구사항');
    expect(spec).toContain('class="slot"');
    expect(spec).toContain('완료 기준은 무엇인가요?');
    expect(spec).toContain('원문에 없음');
    expect(spec).not.toContain('예:');
    expect(PRD_CSS).toMatch(/\.slot\{border:1px dashed/);
  });

  it('메타 새 필드, 위험 대응, 지표 역할과 검수 네 묶음을 보존한다', () => {
    const html = render();
    const { view } = sampleV2();
    for (const value of [...(view.meta.roles ?? []), ...(view.meta.platforms ?? [])])
      expect(html).toContain(value.text);
    for (const title of ['막힘', '채워야 함', '참고', '문장'])
      expect(html).toContain(`<h2>${title}</h2>`);
    expect(html).toContain('id="panel-metrics"');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('검증 보고서 렌더 회귀', () => {
  it('P1 링크 안에 링크를 중첩하지 않고 굵게와 코드를 해석한다', () => {
    expect(inlineLabel('**대여** `조건` [정책](https://example.com)')).toBe(
      '<strong>대여</strong> <code>조건</code> <span title="https://example.com">정책</span>',
    );
  });
  it('P4 상대 경로는 글자와 title만 남기며 위험한 스킴을 링크로 만들지 않는다', () => {
    expect(inlineMd('[**정책**](./rental/policy.md)')).toBe(
      '<span title="./rental/policy.md"><strong>정책</strong></span>',
    );
    expect(inlineMd('[대여](javascript:alert)')).not.toContain('href=');
  });
  it('P7 줄바꿈을 보존하고 P13 경계와 P14 행 머리글 너비를 유지한다', () => {
    expect(inlineMd('반납 완료\n다음 책 추천')).toBe('반납 완료<br>다음 책 추천');
    expect(render()).toContain('<span>경계</span>');
    expect(PRD_CSS).toContain('.tbl tbody th{white-space:nowrap}');
  });
  it('P5 검수 링크에는 블록 ID 대신 제목을 표시한다', () => {
    const { view, source } = sampleV2();
    const r = view.sections[0]!.blocks[1]!;
    if (r.kind !== 'requirement') throw new Error('requirement');
    delete r.acceptance;
    const html = renderPrdHtml(view, {
      sourceSha256: source.sha256,
      coverage: lintPrdView(view, source).coverage,
      gaps: collectPrdGaps(view),
    });
    const review = html.slice(html.indexOf('id="panel-review"'));
    expect(review).toContain('href="#f-r1">대여 신청</a>');
    expect(review).not.toContain('href="#f-r1">r1</a>');
  });
});
