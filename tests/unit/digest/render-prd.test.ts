import { describe, expect, it } from 'vitest';
import { lintPrdView } from '../../../src/digest/lint-prd.js';
import { parsePrdView, type PrdView } from '../../../src/digest/prd-schema.js';
import { PRD_HTML_MARKER } from '../../../src/digest/prd-store.js';
import { PRD_VIEWER_JS } from '../../../src/digest/prd-viewer-js.js';
import { renderPrdHtml } from '../../../src/digest/render-prd.js';
import { inlineMd } from '../../../src/digest/render-prd-blocks.js';
import { THEME_BOOT_JS } from '../../../src/digest/viewer-js.js';
import { collectPrdGaps } from '../../../src/digest/lint-prd-gaps.js';
import { sampleSource, sampleView, sampleViewWithStage3 } from './prd-fixture.js';

type Json = Record<string, any>;

function render(v: Json = sampleView(), withGaps = false): string {
  const r = parsePrdView(v);
  if (!r.ok) throw new Error(r.issues.join('\n'));
  const view: PrdView = r.value;
  const source = sampleSource();
  return renderPrdHtml(view, {
    sourceSha256: source.sha256,
    coverage: lintPrdView(view, source).coverage,
    ...(withGaps ? { gaps: collectPrdGaps(view) } : {}),
  });
}

describe('renderPrdHtml', () => {
  it('첫 줄에 표시 주석을 넣고 블록 종류마다 카드 클래스를 단다', () => {
    const html = render();
    expect(html.startsWith(PRD_HTML_MARKER)).toBe(true);
    for (const kind of ['claim', 'requirement', 'metric', 'decision', 'question']) {
      expect(html).toContain(`blk blk-${kind}`);
    }
    expect(html).toContain('id="b-r1"');
    expect(html).toContain('data-aud="dev design"');
    expect(html).toContain('href="#b-m1">M1</a>');
    expect(html).toContain('<span class="src" title="원문 줄">L19-21</span>');
    expect(html).toContain('<s>협업 필터링</s>');
  });

  it('summary 블록에 요약 배지를 단다', () => {
    const v = sampleView() as Json;
    v.sections[0].blocks[0].summary = true;
    expect(render(v)).toContain('<span class="badge sum">요약</span>');
    expect(render()).not.toContain('<span class="badge sum">');
  });

  it('비어 있는 지표 칸은 빈 칸으로 두고 값을 지어내지 않는다', () => {
    const v = sampleView() as Json;
    delete v.sections[2].blocks[0].baseline;
    const html = render(v);
    expect(html).toContain('<div class="cell empty"><span>베이스라인</span></div>');
    expect(html).toContain('재추출 필요');
  });

  it('같은 입력은 바이트까지 같은 출력을 낸다', () => {
    expect(render()).toBe(render());
  });

  it('외부 주소를 불러오지 않는다', () => {
    const html = render();
    expect(html).not.toMatch(/<(link|img|script)[^>]+(src|href)=["']?https?:/);
  });

  it('모든 글 칸의 스크립트와 javascript 링크를 무력화한다', () => {
    const bad = '<script>alert(1)</script>"><img src=x onerror=alert(1)>[x](javascript:alert(1))';
    const v = sampleViewWithStage3() as Json;
    v.meta.title = bad;
    v.meta.source = bad;
    v.meta.rows[0].key = bad;
    v.meta.rows[0].value = bad;
    v.sections[0].title = bad;
    v.omitted[0].reason = bad;
    const walk = (o: Json) => {
      for (const [k, val] of Object.entries(o)) {
        if (
          [
            'id',
            'kind',
            'status',
            'phase',
            'role',
            'metricId',
            'metrics',
            'audience',
            'origin',
            'tone',
          ].includes(k)
        )
          continue;
        if (typeof val === 'string') o[k] = bad;
        else if (Array.isArray(val))
          val.forEach((x, i) => (typeof x === 'string' ? (val[i] = bad) : walk(x)));
        else if (val && typeof val === 'object') walk(val);
      }
    };
    v.sections.forEach((s: Json) => s.blocks.forEach(walk));
    const html = render(v);
    const scripts = html.match(/<script>[\s\S]*?<\/script>/g) ?? [];
    expect(scripts).toEqual([
      `<script>${THEME_BOOT_JS}</script>`,
      `<script>${PRD_VIEWER_JS}</script>`,
    ]);
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(/href="javascript:/i);
  });

  it('3단계 블록을 종류별 카드로 그린다', () => {
    const html = render(sampleViewWithStage3());
    for (const kind of [
      'compare',
      'scope',
      'quote',
      'flow',
      'stateMatrix',
      'timeline',
      'glossary',
      'callout',
    ]) {
      expect(html).toContain(`blk blk-${kind}`);
    }
    expect(html).toContain('origin-virtual');
    expect(html).toContain('가상 화법');
    expect(html).toContain('tone-warn');
    expect(html).toContain('<ol class="flow">');
    expect(html).toContain('<dl class="gl">');
    // 원문에 빈 칸이던 셀은 빈 칸으로 둔다
    expect(html).toMatch(/<th scope="row">M2<\/th><td class="empty"><\/td><td>8%<\/td>/);
  });

  it('gaps를 주면 코드별로 묶은 빈칸 패널을 본문 앞에 그린다', () => {
    const html = render(sampleView(), true);
    expect(html).toContain('<section class="sec gaps" id="gaps">');
    expect(html).toContain('href="#gaps"');
    expect(html).toContain('베이스라인에 숫자가 없는 지표');
    expect(html.indexOf('id="gaps"')).toBeLessThan(html.indexOf('id="s-problem"'));
    expect(render(sampleView())).not.toContain('id="gaps"');
  });
});

describe('inlineMd', () => {
  it('링크 주소 안의 백틱을 code 태그로 바꾸지 않는다', () => {
    expect(inlineMd('[x](https://a.example/`b`c)')).toBe(
      '<a href="https://a.example/`b`c" rel="noopener noreferrer" target="_blank">x</a>',
    );
  });

  it('링크 밖 코드와 굵게, 링크 글자 안 서식은 그대로 바꾼다', () => {
    expect(inlineMd('`k` **b** [`c` 문서](https://a.example)')).toBe(
      '<code>k</code> <strong>b</strong> <a href="https://a.example" rel="noopener noreferrer" target="_blank"><code>c</code> 문서</a>',
    );
  });

  it('입력에 섞인 자리표시 글자는 링크 자리표시로 읽히지 않는다', () => {
    expect(inlineMd('\uE0000\uE000 [x](https://a.example)')).toBe(
      '0 <a href="https://a.example" rel="noopener noreferrer" target="_blank">x</a>',
    );
  });
});
