import { describe, expect, it } from 'vitest';
import { lintPrdView } from '../../../src/digest/lint-prd.js';
import { parsePrdView, type PrdView } from '../../../src/digest/prd-schema.js';
import { renderPrdHtml } from '../../../src/digest/render-prd.js';
import {
  deriveDecisions,
  deriveReqMetric,
  deriveUnresolved,
  renderOverview,
  usedAudiences,
} from '../../../src/digest/render-prd-views.js';
import { sampleSource, sampleView } from './prd-fixture.js';

type Json = Record<string, any>;

function parse(v: Json = sampleView()): PrdView {
  const r = parsePrdView(v);
  if (!r.ok) throw new Error(r.issues.join('\n'));
  return r.value;
}

function render(view: PrdView): string {
  const source = sampleSource();
  return renderPrdHtml(view, {
    sourceSha256: source.sha256,
    coverage: lintPrdView(view, source).coverage,
  });
}

/** 섹션 하나에 블록만 바꿔 끼운 뷰 */
function withBlocks(blocks: Json[]): PrdView {
  const v = sampleView() as Json;
  v.sections = [{ id: 'only', title: '문제', blocks }];
  return parse(v);
}

describe('교차 뷰 수집', () => {
  it('미확정은 question 전부와 status가 open인 claim만 모은다', () => {
    const items = deriveUnresolved(parse());
    expect(items.map((i) => i.block.id)).toEqual(['c2', 'q1']);
    expect(items[0]!.sectionTitle).toBe('문제');
  });

  it('결정은 decision 블록을 섹션 제목과 함께 모은다', () => {
    const items = deriveDecisions(parse());
    expect(items.map((i) => [i.block.id, i.sectionTitle])).toEqual([['d1', '결정 기록']]);
  });

  it('요구사항과 지표 연결에서 한쪽에만 있는 것을 따로 낸다', () => {
    const m = deriveReqMetric(parse())!;
    expect([...m.links.get('r1')!]).toEqual(['M1', 'M2']);
    expect(m.unlinkedRequirements).toEqual(['r2']);
    expect(m.unlinkedMetrics).toEqual([]);
  });

  it('요구사항이 참조하지 않은 지표를 연결 없음으로 잡는다', () => {
    const v = sampleView() as Json;
    v.sections[1].blocks[0].metrics = ['M1'];
    expect(deriveReqMetric(parse(v))!.unlinkedMetrics).toEqual(['M2']);
  });

  it('요구사항이나 지표 중 하나라도 없으면 연결 표를 만들지 않는다', () => {
    const view = withBlocks([
      {
        id: 'c1',
        kind: 'claim',
        src: [[14, 14]],
        text: '반납 직후 다음 책을 못 고른 회원',
        status: 'confirmed',
      },
    ]);
    expect(deriveReqMetric(view)).toBeNull();
  });
});

describe('모아 보기 렌더', () => {
  it('모을 블록이 없으면 섹션과 목차 항목을 둘 다 생략한다', () => {
    const view = withBlocks([
      {
        id: 'c1',
        kind: 'claim',
        src: [[14, 14]],
        text: '반납 직후 다음 책을 못 고른 회원',
        status: 'confirmed',
      },
    ]);
    expect(renderOverview(view)).toEqual({ html: '', toc: [] });
    const html = render(view);
    expect(html).not.toContain('id="s-overview"');
    expect(html).not.toContain('모아 보기');
  });

  it('미확정, 연결 표, 결정을 펼친 details로 그리고 원래 카드로 링크한다', () => {
    const html = render(parse());
    expect(html).toContain('id="s-overview"');
    for (const id of ['x-unresolved', 'x-req-metric', 'x-decisions']) {
      expect(html).toContain(`<details open id="${id}">`);
      expect(html).toContain(`href="#${id}"`);
    }
    expect(html).toContain('href="#b-q1"');
    expect(html).toContain('href="#b-d1"');
    expect(html).toContain('연결 지표 없음');
    // 모아 보기는 본문 섹션보다 앞에 온다
    expect(html.indexOf('id="s-overview"')).toBeLessThan(html.indexOf('id="s-problem"'));
  });

  it('모아 보기에 옮겨 담는 글도 escape한다', () => {
    const v = sampleView() as Json;
    v.sections[4].blocks[0].item = '<img src=x onerror=alert(1)>';
    v.sections[4].blocks[0].owner = '"><script>';
    const html = render(parse(v));
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('"><script>');
  });
});

describe('대상별 필터', () => {
  it('쓰인 audience만 AUDIENCES 순서로 버튼을 낸다', () => {
    const view = parse();
    expect(usedAudiences(view)).toEqual(['pm', 'dev', 'design']);
    const html = render(view);
    expect(html).toContain('data-aud-filter=""');
    for (const a of ['pm', 'dev', 'design']) expect(html).toContain(`data-aud-filter="${a}"`);
    expect(html).not.toContain('data-aud-filter="qa"');
    expect(html).toMatch(/<noscript><style>[^<]*\.aud-filter/);
  });

  it('audience가 한 종류 이하면 필터 버튼을 내지 않는다', () => {
    const v = sampleView() as Json;
    v.sections[1].blocks[0].audience = ['pm'];
    expect(render(parse(v))).not.toContain('data-aud-filter="');
  });
});
