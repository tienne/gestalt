import { describe, expect, it } from 'vitest';
import { lintPrdView } from '../../../src/digest/lint-prd.js';
import { parsePrdView, type PrdView } from '../../../src/digest/prd-schema.js';
import { PRD_HTML_MARKER } from '../../../src/digest/prd-store.js';
import { PRD_VIEWER_JS } from '../../../src/digest/prd-viewer-js.js';
import { renderPrdHtml } from '../../../src/digest/render-prd.js';
import { THEME_BOOT_JS } from '../../../src/digest/viewer-js.js';
import { sampleSource, sampleView } from './prd-fixture.js';

type Json = Record<string, any>;

function render(v: Json = sampleView()): string {
  const r = parsePrdView(v);
  if (!r.ok) throw new Error(r.issues.join('\n'));
  const view: PrdView = r.value;
  const source = sampleSource();
  return renderPrdHtml(view, {
    sourceSha256: source.sha256,
    coverage: lintPrdView(view, source).coverage,
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
    const v = sampleView() as Json;
    v.meta.title = bad;
    v.meta.source = bad;
    v.meta.rows[0].key = bad;
    v.meta.rows[0].value = bad;
    v.sections[0].title = bad;
    v.omitted[0].reason = bad;
    const walk = (o: Json) => {
      for (const [k, val] of Object.entries(o)) {
        if (
          ['id', 'kind', 'status', 'phase', 'role', 'metricId', 'metrics', 'audience'].includes(k)
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
});
