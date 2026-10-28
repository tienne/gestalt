import { describe, expect, it } from 'vitest';
import type { Widget } from '../../../src/digest/lens-widget-schema.js';
import { lintDigest, lintErrors } from '../../../src/digest/lint.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { extractProse } from '../../../src/digest/prose.js';
import { parseDigest } from '../../../src/digest/schema.js';
import { lensDigest, lensReport, lensSource, lensTranscript } from './fixture.js';

const toggle = (): Widget => ({
  id: 'nmi-csp',
  class: 'A',
  kind: 'toggleBars',
  title: '표 4 NMI, CSP를 켜고 끄기',
  cite: { key: 3, from: 3, to: 3 },
  toggle: { off: 'CSP 끔', on: 'CSP 켬' },
  items: [
    {
      label: '노드 50개',
      off: { value: 0.3236, src: { table: 'table-4', row: 1, col: 1 } },
      on: { value: 0.2862, src: { table: 'table-4', row: 2, col: 1 } },
    },
  ],
});

const toy = (): Widget => ({
  id: 'toy',
  class: 'B',
  kind: 'stepSlider',
  title: '노이즈를 걷어내는 과정',
  cite: { key: 1, from: 1, to: 1 },
  steps: [
    {
      label: '처음',
      nodes: [
        { id: 'a', label: '가' },
        { id: 'b', label: '나' },
      ],
      edges: [{ from: 'a', to: 'b', strength: 'weak' }],
    },
    {
      label: '끝',
      nodes: [
        { id: 'a', label: '가' },
        { id: 'b', label: '나' },
      ],
      edges: [{ from: 'a', to: 'b', strength: 'strong' }],
    },
  ],
});

const recon = (steps = 3, differences = ['노드를 다섯 개로 줄였다.']): Widget => ({
  id: 'fig1',
  class: 'C',
  kind: 'stepSlider',
  title: '단계별 간선 점수',
  cite: { key: 8, from: 8, to: 8 },
  figure: 'figure-1',
  differences,
  steps: Array.from({ length: steps }, (_, k) => ({
    label: `Step ${k * 5}`,
    nodes: [
      { id: 'a', label: 'Tea' },
      { id: 'b', label: 'Daidzein' },
    ],
    edges: k === 0 ? [{ from: 'a', to: 'b', strength: 'weak' as const }] : [],
  })),
});

function withWidgets(...widgets: Widget[]) {
  const r = lensReport();
  r.sections[1]!.subsections[0]!.widgets = widgets.filter((w) => w.class !== 'C');
  r.sections[1]!.subsections[1]!.widgets = widgets.filter((w) => w.class === 'C');
  return r;
}

const codes = (r = lensReport(), source = lensSource()) =>
  lintErrors(lintDigest(lensDigest(r), lensTranscript(), { source })).map((i) => i.code);

describe('인터랙티브 그림 lint', () => {
  it('원문 칸과 맞는 A, 지표 없는 B, 장면 수 안의 C는 통과한다', () => {
    const r = withWidgets(toggle(), toy(), recon());
    expect(parseDigest(lensDigest(r)).ok).toBe(true);
    expect(codes(r)).toEqual([]);
  });

  it('A 토글 막대의 숫자 하나를 틀리게 넣으면 막는다', () => {
    const w = toggle();
    if (w.kind === 'toggleBars') w.items[0]!.on.value = 0.2962;
    expect(codes(withWidgets(w))).toContain('WIDGET_VALUE_MISMATCH');
  });

  it('A 값에 출처가 없으면 막는다', () => {
    const w = toggle();
    if (w.kind === 'toggleBars') delete w.items[0]!.on.src;
    expect(codes(withWidgets(w))).toContain('WIDGET_VALUE_NO_SOURCE');
  });

  it('A 라벨에 원문에 없는 지표를 쓰면 막는다', () => {
    const w = toggle();
    w.title = '표 4 정확도 비교';
    expect(codes(withWidgets(w))).toContain('WIDGET_METRIC_UNKNOWN');
  });

  it('B에 결과 지표 라벨이나 %를 넣으면 막는다', () => {
    const w = toy();
    if (w.kind === 'stepSlider') w.steps[1]!.label = '일치도 14.2%';
    expect(codes(withWidgets(w))).toContain('B_METRIC_LABEL');
  });

  it('B가 값이나 원문 이름, 그림 번호를 쓰면 막는다', () => {
    const named = toy();
    if (named.kind === 'stepSlider') named.steps[0]!.nodes[0]!.label = 'Soy Sauce';
    expect(codes(withWidgets(named))).toContain('B_BORROWS_NAME');
    const titled = toy();
    titled.title = 'Figure 1 다시 보기';
    expect(codes(withWidgets(titled))).toContain('B_FIGURE_TITLE');
    const data: Widget = {
      id: 'b2',
      class: 'B',
      kind: 'beforeAfter',
      title: '전과 후',
      cite: { key: 1, from: 1, to: 1 },
      before: { title: '전', items: [{ label: '가', value: { value: 1 } }] },
      after: { title: '후', items: [{ label: '나' }] },
    };
    expect(codes(withWidgets(data))).toContain('B_HAS_DATA');
  });

  it('B에 A 전용 종류를 쓰면 막는다', () => {
    const w = toggle();
    w.class = 'B';
    expect(codes(withWidgets(w))).toContain('WIDGET_KIND_CLASS');
  });

  it('C의 differences가 비면 막는다', () => {
    expect(codes(withWidgets(recon(3, [])))).toContain('C_DIFFERENCES_EMPTY');
    expect(codes(withWidgets(recon(3, ['  '])))).toContain('C_DIFFERENCES_EMPTY');
  });

  it('C 슬라이더가 원문 장면 수를 넘으면 막고 장면 수를 모르면 먼저 적게 한다', () => {
    expect(codes(withWidgets(recon(4)))).toContain('C_STEPS_EXCEED_PANELS');
    const source = lensSource();
    delete source.figures[0]!.panels;
    expect(codes(withWidgets(recon(3)), source)).toContain('C_PANELS_UNKNOWN');
  });

  it('C에 원문 그림 id가 없으면 막는다', () => {
    const w = recon();
    delete w.figure;
    expect(codes(withWidgets(w))).toContain('C_FIGURE_MISSING');
  });

  it('슬라이더 간선이 없는 노드를 가리키면 막는다', () => {
    const w = toy();
    if (w.kind === 'stepSlider') w.steps[0]!.edges = [{ from: 'a', to: 'z', strength: 'weak' }];
    expect(codes(withWidgets(w))).toContain('WIDGET_EDGE_UNKNOWN');
  });
});

describe('인터랙티브 그림 렌더', () => {
  const html = () =>
    renderDigestHtml(lensDigest(withWidgets(toggle(), toy(), recon())), lensTranscript(), {
      source: lensSource(),
    }).html;

  it('구분마다 렌더러가 배지를 붙인다', () => {
    const out = html();
    expect(out).toContain('<span class="w-badge w-badge-A">원문 표 데이터</span>');
    expect(out).toContain('<span class="w-badge w-badge-B">설명용, 원문 데이터 아님</span>');
    expect(out).toContain('<span class="w-badge w-badge-C">AI가 이해한 대로 다시 그림</span>');
  });

  it('토글 막대는 두 상태를 미리 그리고 값은 원문 칸 글자 그대로다', () => {
    const out = html();
    expect(out).toMatch(
      /data-w-state="off">[^]*?0\.3236[^]*?data-w-state="on" hidden>[^]*?0\.2862/,
    );
    expect(out).toContain('data-cell="table-4:2:1"');
  });

  it('C는 원문 크롭과 나란히 두고 다른 점을 펼쳐 둔다', () => {
    const out = html();
    expect(out).toMatch(
      /class="w-pair"><figure class="w-original"><img src="figures\/figure-1\.png"/,
    );
    expect(out).toContain('원문 그림과 다른 점');
  });

  it('슬라이더는 정수 칸만 고르고 칸마다 미리 그린 상태가 있다', () => {
    const out = html();
    expect(out).toContain('type="range" min="0" max="2" step="1"');
    expect(out).toMatch(/data-w-state="2" hidden>/);
  });

  it('마크다운은 막대를 표로, 슬라이더를 단계 목록으로 낸다', () => {
    const md = renderDigestMarkdown(lensDigest(withWidgets(toggle(), recon())), lensTranscript(), {
      source: lensSource(),
    });
    expect(md).toContain('| 노드 50개 | 0.3236 | 0.2862 |');
    expect(md).toContain('*(AI가 이해한 대로 다시 그림)*');
    expect(md).toContain('- 노드를 다섯 개로 줄였다.');
  });

  it('그림 글자는 윤문에서 라벨로 묶이고 다른 점은 본문으로 나온다', () => {
    const items = extractProse(lensDigest(withWidgets(toggle(), recon())));
    const label = items.find((i) => i.path.endsWith('widgets.0.toggle.on'));
    expect(label).toMatchObject({ kind: 'label', text: 'CSP 켬' });
    // 그림 제목은 목차에 안 나가서 라벨로 다듬는다
    expect(items.find((i) => i.path.endsWith('widgets.0.title'))).toMatchObject({ kind: 'label' });
    expect(items.some((i) => i.path.endsWith('differences.0') && !i.kind)).toBe(true);
  });
});
