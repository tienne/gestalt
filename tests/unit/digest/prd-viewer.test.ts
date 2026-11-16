import { afterEach, describe, expect, it } from 'vitest';
import { Window } from 'happy-dom';
import { lintPrdView } from '../../../src/digest/lint-prd.js';
import { collectPrdGaps } from '../../../src/digest/lint-prd-gaps.js';
import { parsePrdView, type PrdView } from '../../../src/digest/prd-schema.js';
import { PRD_VIEWER_JS } from '../../../src/digest/prd-viewer-js.js';
import { renderPrdHtml, type RenderPrdOptions } from '../../../src/digest/render-prd.js';
import { sampleSource, sampleV2, sampleView } from './prd-fixture.js';

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((w) => w.happyDOM.close()));
});
function open(view: PrdView, hash = '', options: Partial<RenderPrdOptions> = {}) {
  const source = sampleSource();
  const html = renderPrdHtml(view, {
    sourceSha256: source.sha256,
    coverage: lintPrdView(view, source).coverage,
    gaps: collectPrdGaps(view),
    ...options,
  });
  const window = new Window({
    url: `https://rental.example/prd${hash}`,
    settings: {
      enableJavaScriptEvaluation: true,
      suppressInsecureJavaScriptEnvironmentWarning: true,
    },
  });
  windows.push(window);
  window.document.write(html.replace(/<script>[\s\S]*?<\/script>/g, ''));
  window.eval(PRD_VIEWER_JS);
  const query = (selector: string) => {
    const el = window.document.querySelector<HTMLElement>(selector);
    if (!el) throw new Error(`요소 누락: ${selector}`);
    return el;
  };
  const click = async (selector: string) => {
    query(selector).click();
    await window.happyDOM.waitUntilComplete();
  };
  return { window, query, click };
}
function legacy() {
  const parsed = parsePrdView(sampleView());
  if (!parsed.ok) throw new Error(parsed.issues.join('\n'));
  return parsed.value;
}

describe('PRD 뷰어 조작', () => {
  it('P6 대상 필터로 카드가 모두 숨은 섹션과 목차를 함께 숨기고 복원한다', async () => {
    const view = legacy();
    view.sections[0]!.blocks.forEach((b) => {
      b.audience = ['dev'];
    });
    const { query, click } = open(view);
    await click('[data-aud-filter="design"]');
    expect(query('#s-problem').hidden).toBe(true);
    expect(query('[data-section-nav="s-problem"]').hidden).toBe(true);
    expect(query('#s-metrics').hidden).toBe(false);
    await click('[data-aud-filter=""]');
    expect(query('#s-problem').hidden).toBe(false);
    expect(query('[data-section-nav="s-problem"]').hidden).toBe(false);
  });

  it('지표의 대상 필터가 빈 역할 섹션과 목차 링크를 함께 숨긴다', async () => {
    const view = legacy();
    for (const block of view.sections[2]!.blocks)
      if (block.kind === 'metric' && block.role === 'secondary') block.audience = ['data'];
    const { query, click } = open(view, '#tab-metrics');
    await click('[data-aud-filter="dev"]');
    expect(query('#metrics-secondary').hidden).toBe(true);
    expect(query('[data-section-nav="metrics-secondary"]').hidden).toBe(true);
    expect(query('#metrics-primary').hidden).toBe(false);
    await click('[data-aud-filter=""]');
    expect(query('#metrics-secondary').hidden).toBe(false);
    expect(query('[data-section-nav="metrics-secondary"]').hidden).toBe(false);
  });

  it('기능 폴더에서 부모 요구사항 원문 카드로 이동한다', async () => {
    const { query, click } = open(sampleV2().view, '#tab-spec');
    expect(query('.req-folder').getAttribute('href')).toBe('#b-group');
    await click('.req-folder');
    expect(query('#panel-prd').hidden).toBe(false);
    expect(query('#b-group').textContent).toContain('도서 대여 기능');
  });

  it('빈칸 링크는 전체 검수 탭의 첫 화면을 연다', async () => {
    const { query, click } = open(sampleV2().view);
    query('#panel-review .content').scrollTop = 300;
    expect(query('.progress a').getAttribute('href')).toBe('#panel-review');
    await click('.progress a');
    expect(query('#panel-review').hidden).toBe(false);
    expect(query('#panel-review .content').scrollTop).toBe(0);
  });

  it('비차단 빠진 줄은 채워야 함에 두고 검수 배지는 표시 행 수를 센다', () => {
    const { window, query } = open(sampleV2().view, '#tab-review', {
      gaps: [],
      coverage: {
        contentLines: 10,
        coveredLines: 8,
        omittedLines: 0,
        uncoveredLines: 2,
        uncoveredRatio: 0.2,
        ranges: [{ from: 5, to: 6, preview: '회원은 책을 고른다.' }],
        truncated: false,
      },
      issues: [
        {
          path: 'coverage',
          code: 'COVERAGE_GAP',
          severity: 'warning',
          message: '원문 줄이 빠졌다.',
        },
        {
          path: 'sections.0',
          code: 'SRC_WIDE',
          severity: 'warning',
          message: '원문 범위가 넓다.',
          blockId: 'group',
        },
      ],
      prose: [
        {
          code: 'SENTENCE_LONG',
          severity: 'info',
          count: 7,
          samples: [
            { sentence: '회원은 대여할 책을 선택한다.', blockId: 'r1' },
            { sentence: '신청 뒤 대여 목록에 책 1권이 나타난다.', blockId: 'r1' },
          ],
        },
      ],
    });
    const rows = (id: string) => query(id).querySelectorAll('.gaprow').length;
    expect(rows('#review-0')).toBe(0);
    expect(rows('#review-1')).toBe(1);
    expect(rows('#review-2')).toBe(1);
    expect(rows('#review-3')).toBe(2);
    expect(query('.review-count').textContent).toBe('4');
    expect(query('#review-3 h3 .chip').textContent).toBe('7');
    expect(window.document.querySelectorAll('#panel-review .gaprow')).toHaveLength(4);
  });

  it('결정 칩의 확정 여부는 gaps의 진단 결과를 따른다', () => {
    const view = legacy();
    const decision = view.sections.flatMap((s) => s.blocks).find((b) => b.kind === 'decision')!;
    if (decision.kind !== 'decision') throw new Error('decision');
    decision.decided += ' 제안';
    const confirmed = open(view, '#tab-decisions', { gaps: [] });
    expect(confirmed.query('#d-d1 .metaline').textContent).toBe('확정');
    const unconfirmed = open(view, '#tab-decisions', { gaps: collectPrdGaps(view) });
    expect(unconfirmed.query('#d-d1 .metaline .chip.warn').textContent).toBe('확인 필요');
  });

  it('카드에서 상세로 이동하고 같은 링크를 다시 눌러도 상세를 연다', async () => {
    const { query, click } = open(sampleV2().view, '#tab-spec');
    await click('[data-spec-mode="cards"]');
    expect(query('.spec-cards').hidden).toBe(false);
    await click('[data-feature-card="r1"]');
    expect(query('.spec-directory').hidden).toBe(false);
    expect(query('#f-r1').hidden).toBe(false);
    await click('[data-spec-mode="cards"]');
    await click('[data-feature-card="r1"]');
    expect(query('.spec-directory').hidden).toBe(false);
    expect(query('#f-r1').hidden).toBe(false);
    expect(query('#f-r1').querySelectorAll('.slot.filled')).toHaveLength(9);
  });

  it('단계 필터의 빈 상태와 이전 다음 경계를 표시한다', async () => {
    const { query, click } = open(sampleV2().view, '#tab-spec');
    await click('[data-phase-filter="later"]');
    expect(query('.spec-empty').hidden).toBe(false);
    expect(query('[data-req-step="-1"]').hasAttribute('disabled')).toBe(true);
    expect(query('[data-req-step="1"]').hasAttribute('disabled')).toBe(true);
    await click('[data-spec-mode="cards"]');
    expect(query('.cards-empty').hidden).toBe(false);
    await click('[data-phase-filter=""]');
    await click('[data-spec-mode="directory"]');
    expect(query('#f-r1').hidden).toBe(false);
    expect(query('[data-req-step="1"]').hasAttribute('disabled')).toBe(true);
  });

  it('이전과 다음은 실제 기능 순서로 이동한다', async () => {
    const { window, query, click } = open(legacy(), '#tab-spec');
    await click('[data-req-step="1"]');
    expect(window.location.hash).toBe('#f-r2');
    expect(query('#f-r2').hidden).toBe(false);
    await click('[data-req-step="-1"]');
    expect(window.location.hash).toBe('#f-r1');
    expect(query('#f-r1').hidden).toBe(false);
  });

  it('검수의 숨은 대상 링크를 누르면 필터를 풀고 기능명세서 해당 기능을 연다', async () => {
    const view = legacy();
    view.sections[1]!.blocks.forEach((b) => {
      b.audience = ['dev'];
    });
    view.sections[0]!.blocks.forEach((b) => {
      b.audience = ['design'];
    });
    const { query, click } = open(view);
    await click('[data-aud-filter="design"]');
    await click('[role="tab"][data-go="review"]');
    await click('#review-1 a[href="#f-r1"]');
    expect(query('#panel-spec').hidden).toBe(false);
    expect(query('#f-r1').hidden).toBe(false);
    expect(query('#f-r1').classList.contains('aud-hide')).toBe(false);
  });

  it('원문 줄 토글과 테마, 탭 상태 저장 및 키보드 탐색을 지원한다', async () => {
    const { window, query, click } = open(sampleV2().view);
    await click('[data-source-toggle]');
    expect(window.document.documentElement.classList.contains('show-src')).toBe(true);
    await click('[data-theme-toggle]');
    expect(window.document.documentElement.dataset.theme).toBe('light');
    await click('[role="tab"][data-go="metrics"]');
    expect(window.localStorage.getItem('gestalt-prd-view:도서 대여:tab')).toBe('metrics');
    expect(window.localStorage.getItem('gestalt-prd-view:도서 대여:theme')).toBe('light');
    query('[role="tab"][data-go="metrics"]').dispatchEvent(
      new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    expect(query('#tab-decisions').getAttribute('aria-selected')).toBe('true');
    expect(query('#panel-decisions').hidden).toBe(false);
  });
});
