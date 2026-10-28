import { describe, expect, it } from 'vitest';
import type { Widget } from '../../../src/digest/lens-widget-schema.js';
import { lintDigest, lintErrors } from '../../../src/digest/lint.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { renderDigestMarkdown } from '../../../src/digest/render-md.js';
import { extractProse } from '../../../src/digest/prose.js';
import { parseDigest } from '../../../src/digest/schema.js';
import type { LensSource } from '../../../src/digest/lens-source.js';
import { lensDigest, lensReport, lensSource, lensTranscript } from './fixture.js';
import { sampleDigest, sampleTranscript } from '../digest/fixture.js';

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

const heat = (): Widget => ({
  id: 'nmi-heat',
  class: 'A',
  kind: 'heatmap',
  title: '표 4 NMI',
  cite: { key: 3, from: 3, to: 3 },
  x: { labels: ['NMI Mean', 'NMI Std'] },
  y: { labels: ['CSP 노드 50개'] },
  cells: [
    [
      { value: 0.2862, src: { table: 'table-4', row: 2, col: 1 } },
      { value: 0.0152, src: { table: 'table-4', row: 2, col: 2 } },
    ],
  ],
});

const pair = (cls: Widget['class'], value?: number): Widget => ({
  id: 'pair',
  class: cls,
  kind: 'beforeAfter',
  title: 'CSP 전과 후',
  cite: { key: 3, from: 3, to: 3 },
  before: {
    title: 'CSP 끔',
    items: [
      {
        label: '노드 50개',
        ...(value === undefined
          ? {}
          : { value: { value, src: { table: 'table-4', row: 1, col: 1 } } }),
      },
    ],
  },
  after: { title: 'CSP 켬', items: [{ label: '노드 50개' }] },
});

/** 음수 칸이 든 표를 더한 원문. 부호 있는 값을 그리는지 본다 */
function signedSource(): LensSource {
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
  return source;
}

const gain = (cls: 'A' | 'C'): Widget => ({
  id: `gain-${cls.toLowerCase()}`,
  class: cls,
  kind: 'toggleBars',
  title: '표 5 CSP 이득',
  cite: { key: 3, from: 3, to: 3 },
  ...(cls === 'C' ? { figure: 'figure-1', differences: ['두 줄만 남겼다.'] } : {}),
  toggle: { off: '노드 50개', on: '노드 200개' },
  items: [
    {
      label: 'CSP 이득',
      off: { value: -0.0374, src: { table: 'table-5', row: 1, col: 1 } },
      on: { value: 0.0174, src: { table: 'table-5', row: 2, col: 1 } },
    },
  ],
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

  it('문단 출처 값이 그 문단에 없으면 막는다', () => {
    const w = toggle();
    if (w.kind === 'toggleBars')
      w.items[0]!.on = { value: 0.341, src: { cite: { key: 3, from: 3, to: 3 } } };
    expect(codes(withWidgets(w))).not.toContain('WIDGET_VALUE_MISMATCH');
    if (w.kind === 'toggleBars')
      w.items[0]!.on = { value: 0.3411, src: { cite: { key: 3, from: 3, to: 3 } } };
    expect(codes(withWidgets(w))).toContain('WIDGET_VALUE_MISMATCH');
  });

  it('heatmap과 beforeAfter 값도 원문 칸과 대조한다', () => {
    expect(codes(withWidgets(heat()))).toEqual([]);
    const h = heat();
    if (h.kind === 'heatmap') h.cells[0]![1]!.value = 0.0153;
    expect(codes(withWidgets(h))).toContain('WIDGET_VALUE_MISMATCH');
    expect(codes(withWidgets(pair('A', 0.3236)))).toEqual([]);
    expect(codes(withWidgets(pair('A', 0.3237)))).toContain('WIDGET_VALUE_MISMATCH');
  });

  it('값이 하나도 없는 A는 A_NO_VALUES', () => {
    expect(codes(withWidgets(pair('A')))).toContain('A_NO_VALUES');
  });

  it('heatmap 축 라벨의 지표 말도 원문과 대조한다', () => {
    const h = heat();
    if (h.kind === 'heatmap') h.y.title = '정확도';
    expect(codes(withWidgets(h))).toContain('WIDGET_METRIC_UNKNOWN');
  });

  it('라벨 하나에 든 지표 말을 전부 본다', () => {
    const w = toggle();
    // NMI는 원문에 있고 정답률은 없다. 첫 매치만 보면 정답률이 빠진다
    w.title = '표 4 NMI와 정답률';
    expect(codes(withWidgets(w))).toContain('WIDGET_METRIC_UNKNOWN');
  });

  it('지표 별칭은 영숫자 경계로 대조하고 한국어 지표도 찾는다', () => {
    const w = toggle();
    w.title = '표 4 정확도';
    const withText = (text: string) => {
      const t = lensTranscript();
      t.segments[8]!.text = text;
      return lintErrors(lintDigest(lensDigest(withWidgets(w)), t, { source: lensSource() })).map(
        (i) => i.code,
      );
    };
    expect(withText('Reported inaccuracy stays high.')).toContain('WIDGET_METRIC_UNKNOWN');
    expect(withText('Accuracy stays high.')).not.toContain('WIDGET_METRIC_UNKNOWN');
    expect(withText('정확도는 그대로다.')).not.toContain('WIDGET_METRIC_UNKNOWN');
  });

  it('B 라벨에 숫자가 있으면 B_HAS_NUMBER', () => {
    const step = toy();
    if (step.kind === 'stepSlider') step.steps[0]!.label = '1단계';
    expect(codes(withWidgets(step))).toContain('B_HAS_NUMBER');
    const note = toy();
    if (note.kind === 'stepSlider') note.steps[1]!.note = '간선이 3개 남는다.';
    expect(codes(withWidgets(note))).toContain('B_HAS_NUMBER');
    const caption = toy();
    caption.caption = '노이즈를 2번 걷어낸다.';
    expect(codes(withWidgets(caption))).toContain('B_HAS_NUMBER');
    const side = pair('B');
    if (side.kind === 'beforeAfter') side.after.title = '50번 뒤';
    expect(codes(withWidgets(side))).toContain('B_HAS_NUMBER');
  });

  it('B는 정답률과 F-score 같은 지표 말도 못 쓴다', () => {
    for (const word of ['정답률', 'F-score', 'F1-score']) {
      const w = toy();
      if (w.kind === 'stepSlider') w.steps[1]!.label = `${word} 오름`;
      expect(codes(withWidgets(w))).toContain('B_METRIC_LABEL');
    }
  });

  it('B는 원문 본문 칸 이름을 라벨 안에 넣어도 막고 머리줄 일반어는 통째로 같을 때만 막는다', () => {
    const inside = toy();
    if (inside.kind === 'stepSlider') inside.steps[0]!.nodes[0]!.label = 'Soy Sauce 같은 재료';
    expect(codes(withWidgets(inside))).toContain('B_BORROWS_NAME');
    const header = toy();
    if (header.kind === 'stepSlider') header.steps[0]!.nodes[0]!.label = 'Model 구조';
    expect(codes(withWidgets(header))).not.toContain('B_BORROWS_NAME');
    if (header.kind === 'stepSlider') header.steps[0]!.nodes[0]!.label = 'Model';
    expect(codes(withWidgets(header))).toContain('B_BORROWS_NAME');
  });

  it('class를 바꿔 B 그림을 A나 C로 꾸미면 그 구분의 검사에 걸린다', () => {
    const asA = toy();
    asA.class = 'A';
    expect(codes(withWidgets(asA))).toContain('WIDGET_KIND_CLASS');
    expect(codes(withWidgets(pair('A')))).toContain('A_NO_VALUES');
    const asC = pair('C');
    const c = codes(withWidgets(asC));
    expect(c).toContain('C_FIGURE_MISSING');
    expect(c).toContain('C_DIFFERENCES_EMPTY');
  });

  it('부호 있는 원문 칸을 그대로 옮긴 A와 C 막대는 통과한다', () => {
    expect(codes(withWidgets(gain('A'), gain('C')), signedSource())).toEqual([]);
  });

  it('영상 리포트에 그림을 넣으면 대조 없이 배지가 붙지 않게 막는다', () => {
    const d = sampleDigest();
    d.reports[0]!.sections[0]!.subsections[0]!.widgets = [toggle()];
    const errs = lintErrors(lintDigest(d, sampleTranscript()));
    expect(errs.map((i) => i.code)).toContain('LENS_FIELD_ON_VIDEO');
    expect(errs.find((i) => i.code === 'LENS_FIELD_ON_VIDEO')?.path).toBe(
      'reports.0.sections.0.subsections.0.widgets',
    );
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

  it('배지는 class로만 정해지고 모델이 넣은 배지 칸은 스키마가 버린다', () => {
    const r = withWidgets({ ...toy(), badge: '원문 표 데이터' } as Widget);
    const parsed = parseDigest(lensDigest(r));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const w = parsed.value.reports[0]!.sections[1]!.subsections[0]!.widgets![0]!;
    expect('badge' in w).toBe(false);
    const out = renderDigestHtml(parsed.value, lensTranscript(), { source: lensSource() }).html;
    expect(out).toContain('<span class="w-badge w-badge-B">설명용, 원문 데이터 아님</span>');
    expect(out).not.toContain('<span class="w-badge w-badge-A">');
  });

  it('렌더러는 값을 만들지 않는다. 값 글자는 원문 칸 글자뿐이다', () => {
    const out = renderDigestHtml(lensDigest(withWidgets(toggle(), heat())), lensTranscript(), {
      source: lensSource(),
    }).html;
    // 그림 몸통만 잘라 본다. 리포트 다른 자리의 원문 표도 data-cell을 쓴다
    const widgets = [...out.matchAll(/<figure class="widget[^]*?<\/figure>/g)]
      .map((m) => m[0])
      .join('');
    const shown = [
      ...widgets.matchAll(/<(?:span class="wb-val"|td)[^>]*data-cell[^>]*>([^<]*)</g),
    ].map((m) => m[1]!);
    expect(new Set(shown)).toEqual(new Set(['0.3236', '0.2862', '0.0152']));
  });

  it('음수 막대는 부호를 보이고 A와 C에 같이 적용된다', () => {
    const out = renderDigestHtml(lensDigest(withWidgets(gain('A'), gain('C'))), lensTranscript(), {
      source: signedSource(),
    }).html;
    for (const id of ['w-gain-a', 'w-gain-c']) {
      const body = out.slice(out.indexOf(`id="${id}"`));
      const off = body.slice(body.indexOf('data-w-state="off"'), body.indexOf('data-w-state="on"'));
      expect(off).toContain(
        '<span class="wb-track wb-neg"><span class="wb-sign" aria-hidden="true">−</span>',
      );
      // 값 글자는 원문 칸 그대로다
      expect(off).toContain('>-0.0374</span>');
      const on = body.slice(body.indexOf('data-w-state="on"'), body.indexOf('</figure>'));
      expect(on).not.toContain('wb-neg');
    }
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
