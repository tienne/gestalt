import { describe, expect, it } from 'vitest';
import {
  beforeAfterSvg,
  causalSvg,
  cycleSvg,
  flowSvg,
  hubSvg,
  pickGridSvg,
  pickGridColumns,
  statSvg,
  DIGEST_SCHEMA_VERSION,
  lintDigest,
  lintErrors,
  matrixSvg,
  parseDigest,
  timelineSvg,
  type Diagram,
  type Digest,
  type Extension,
} from '../../../src/digest/index.js';
import { renderDigestHtml } from '../../../src/digest/render-html.js';
import { WHEN_MAX } from '../../../src/digest/svg.js';
import { renderDigestMarkdown, renderExtensionMarkdown } from '../../../src/digest/render-md.js';
import { sampleDigest, sampleTranscript } from './fixture.js';

const sec = (c: { key: number }) => c.key * 5;

// 첫 대섹션은 0~5번 문장이다
const withDiagram = (diagram: Diagram): Digest => {
  const d = sampleDigest();
  d.reports[0]!.sections[0]!.diagram = diagram;
  return d;
};

const timeline: Diagram = {
  kind: 'timeline',
  caption: '출시 흐름',
  events: [
    { when: '2019년', label: '첫 공개', cite: { key: 1, from: 1, to: 1 } },
    { when: '2023년', label: 'AI 도입' },
    { when: '올해', label: 'Code Layers', cite: { key: 4, from: 4, to: 4 } },
  ],
};
const matrix: Diagram = {
  kind: 'matrix',
  x: { low: '적은 노력', high: '큰 노력' },
  y: { low: '작은 효과', high: '큰 효과' },
  cells: [
    [{ label: '빠른 승리', cite: { key: 2, from: 2, to: 2 } }],
    [{ label: '큰 과제' }],
    [],
    [{ label: '피할 일' }, { label: '미룰 일' }],
  ],
};
const causal: Diagram = {
  kind: 'causal',
  inputs: [{ label: '코드 중심' }, { label: '느린 핸드오프', cite: { key: 3, from: 3, to: 3 } }],
  center: { label: '디자인 지연' },
  outputs: [{ label: '출시 늦음' }],
};
const beforeAfter: Diagram = {
  kind: 'beforeAfter',
  before: { title: '예전', items: [{ label: '정적 목업' }] },
  after: {
    items: [{ label: '실제 코드', cite: { key: 5, from: 5, to: 5 } }, { label: '바로 편집' }],
  },
};

describe('새 도식 네 종류', () => {
  it('스키마 버전은 허브와 핵심 수치, 격자 고르기 도식까지 더한 1.7.0이다', () => {
    expect(DIGEST_SCHEMA_VERSION).toBe('1.7.0');
  });

  it('스키마와 lint를 통과한다', () => {
    for (const diagram of [timeline, matrix, causal, beforeAfter]) {
      const digest = withDiagram(diagram);
      const parsed = parseDigest(JSON.parse(JSON.stringify(digest)));
      expect(parsed.ok).toBe(true);
      expect(lintErrors(lintDigest(digest, sampleTranscript()))).toEqual([]);
    }
  });

  it('인과도는 inputs와 outputs를 비워 보내도 읽힌다', () => {
    const raw = JSON.parse(JSON.stringify(withDiagram(causal)));
    raw.reports[0].sections[0].diagram = {
      kind: 'causal',
      center: { label: 'x' },
      outputs: [{ label: 'y' }],
    };
    const parsed = parseDigest(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.reports[0]!.sections[0]!.diagram).toMatchObject({ inputs: [] });
  });

  it('모양이 틀리면 스키마가 거절한다', () => {
    const bad: unknown[] = [
      { kind: 'timeline', events: [{ when: '1', label: 'a' }] },
      { kind: 'timeline', events: [{ label: 'a' }, { label: 'b' }] },
      { ...matrix, cells: [[], [], []] },
      { ...matrix, cells: [[], [], [], Array.from({ length: 5 }, () => ({ label: 'n' }))] },
      {
        kind: 'causal',
        inputs: Array.from({ length: 7 }, () => ({ label: 'n' })),
        center: { label: 'c' },
      },
      { kind: 'beforeAfter', before: { items: [] }, after: { items: [{ label: 'a' }] } },
    ];
    for (const diagram of bad) {
      const raw = JSON.parse(JSON.stringify(sampleDigest()));
      raw.reports[0].sections[0].diagram = diagram;
      expect(parseDigest(raw).ok).toBe(false);
    }
  });

  it('원인도 결과도 없는 인과도와 네 칸이 다 빈 매트릭스는 lint가 막는다', () => {
    const c = withDiagram({ kind: 'causal', inputs: [], center: { label: '현상' }, outputs: [] });
    expect(lintDigest(c, sampleTranscript()).find((i) => i.code === 'DIAGRAM_EMPTY')).toMatchObject(
      {
        severity: 'error',
        path: 'reports.0.sections.0.diagram',
      },
    );
    const m = withDiagram({ ...matrix, cells: [[], [], [], []] } as Diagram);
    expect(lintDigest(m, sampleTranscript()).find((i) => i.code === 'DIAGRAM_EMPTY')).toMatchObject(
      {
        path: 'reports.0.sections.0.diagram.cells',
      },
    );
  });

  it('노드 출처가 대섹션 밖이면 종류마다 그 자리를 짚는다', () => {
    const out = { key: 8, from: 8, to: 8 };
    const cases: [Diagram, string][] = [
      [
        {
          ...timeline,
          events: [timeline.events[0]!, { when: 'x', label: 'y', cite: out }],
        } as Diagram,
        'events.1.cite',
      ],
      [
        { ...matrix, cells: [[], [], [{ label: 'a', cite: out }], []] } as Diagram,
        'cells.2.0.cite',
      ],
      [{ ...causal, center: { label: 'c', cite: out } } as Diagram, 'center.cite'],
      [
        { ...beforeAfter, before: { items: [{ label: 'b', cite: out }] } } as Diagram,
        'before.items.0.cite',
      ],
    ];
    for (const [diagram, path] of cases) {
      const paths = lintDigest(withDiagram(diagram), sampleTranscript())
        .filter((i) => i.code === 'DIAGRAM_CITE_OUT_OF_SECTION')
        .map((i) => i.path);
      expect(paths).toEqual([`reports.0.sections.0.diagram.${path}`]);
    }
  });

  it('시점과 축 이름, 전후 제목에도 마커를 받지 않는다', () => {
    const cases: [Diagram, string][] = [
      [
        { ...timeline, events: [{ when: '**1**', label: 'a' }, timeline.events[1]!] } as Diagram,
        'events.0.when',
      ],
      [{ ...matrix, x: { low: '{{kw:a|A}}', high: 'b' } } as Diagram, 'x.low'],
      [
        { ...beforeAfter, after: { title: '**후**', items: [{ label: 'a' }] } } as Diagram,
        'after.title',
      ],
    ];
    for (const [diagram, path] of cases) {
      const paths = lintDigest(withDiagram(diagram), sampleTranscript())
        .filter((i) => i.code === 'TITLE_MARKER')
        .map((i) => i.path);
      expect(paths).toEqual([`reports.0.sections.0.diagram.${path}`]);
    }
  });
});

describe('새 도식 SVG', () => {
  it('타임라인은 넷까지 가로로, 그보다 많으면 세로로 놓는다', () => {
    const events = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ when: `${i}단계`, label: `일 ${i}` }));
    const wide = timelineSvg(events(4));
    const tall = timelineSvg(events(6));
    const size = (svg: string) =>
      svg
        .match(/width="(\d+)" height="(\d+)"/)!
        .slice(1)
        .map(Number);
    const [w4, h4] = size(wide);
    const [w6, h6] = size(tall);
    expect(w4!).toBeGreaterThan(h4!);
    expect(h6!).toBeGreaterThan(w6!);
    expect(wide.match(/class="dg-dot"/g)).toHaveLength(4);
    expect(tall).toContain('>5단계<');
  });

  it('긴 시점 글자는 WHEN_MAX 폭에서 말줄임으로 자르고 원문은 title에 남긴다', () => {
    const events = (n: number, when: string) =>
      Array.from({ length: n }, (_, i) => ({ when, label: `일 ${i}` }));
    const width = (svg: string) => Number(svg.match(/width="(\d+)"/)![1]!);
    const long = '가'.repeat(60);
    for (const n of [3, 6]) {
      const svg = timelineSvg(events(n, long));
      const whens = [
        ...svg.matchAll(/<g class="dg-when"><title>([^<]*)<\/title><text[^>]*>([^<]*)<\/text>/g),
      ];
      expect(whens).toHaveLength(n);
      for (const m of whens) {
        expect(m[1]).toBe(long);
        expect(m[2]!.endsWith('…')).toBe(true);
      }
      // 자른 뒤 폭은 원문 길이와 상관없이 WHEN_MAX에서 멈춘다
      expect(width(timelineSvg(events(n, '가'.repeat(200))))).toBe(width(svg));
      expect(width(svg) - width(timelineSvg(events(n, '가')))).toBeLessThanOrEqual(
        WHEN_MAX * (n <= 4 ? n : 1),
      );
    }
  });

  it('출처가 있는 노드에만 data-sec을 달고 글자를 이스케이프한다', () => {
    const svg = timelineSvg(
      [
        { when: '<b>', label: 'a&b', cite: { key: 2, from: 2, to: 2 } },
        { when: '2', label: 'c' },
      ],
      { sec },
    );
    expect(svg).toContain('data-sec="10"');
    expect(svg.match(/data-sec=/g)).toHaveLength(1);
    expect(svg).toContain('&lt;b&gt;');
    expect(svg).toContain('a&amp;b');
    expect(svg).not.toContain('<b>');
  });

  it('매트릭스는 네 칸과 축 이름 넷을 그린다', () => {
    if (matrix.kind !== 'matrix') throw new Error('matrix');
    const svg = matrixSvg(matrix.x, matrix.y, matrix.cells, { sec });
    expect(svg.match(/class="dg-cell"/g)).toHaveLength(4);
    expect(svg.match(/class="dg-axis"/g)).toHaveLength(4);
    expect(svg).toContain('>큰 효과<');
    expect(svg).toContain('role="group"');
  });

  it('인과도는 원인과 결과마다 화살표를 하나씩 긋고 한쪽이 비어도 그린다', () => {
    if (causal.kind !== 'causal') throw new Error('causal');
    const svg = causalSvg(causal.inputs, causal.center, causal.outputs);
    expect(svg.match(/class="dg-arrow"/g)).toHaveLength(3);
    expect(svg).toContain('dg-node dg-head');
    const right = causalSvg([], causal.center, causal.outputs);
    expect(right.match(/class="dg-arrow"/g)).toHaveLength(1);
    expect(right).toContain('role="img"');
  });

  it('전후 비교는 두 칸 사이에 화살표 하나를 긋고 제목이 없으면 전, 후를 쓴다', () => {
    const svg = beforeAfterSvg({ items: [{ label: 'a' }] }, { items: [{ label: 'b' }] });
    expect(svg.match(/class="dg-arrow"/g)).toHaveLength(1);
    expect(svg).toContain('>전<');
    expect(svg).toContain('>후<');
    expect(svg).toContain('class="dg-svg dg-before-after"');
  });
});

describe('새 도식 렌더', () => {
  it('HTML은 그림과 목록 보기를 같이 싣는다', () => {
    const html = (d: Diagram) => renderDigestHtml(withDiagram(d), sampleTranscript()).html;
    expect(html(timeline)).toContain('<svg class="dg-svg dg-timeline"');
    expect(html(timeline)).toMatch(
      /<summary>목록으로 보기<\/summary><ol><li><b>2019년<\/b> 첫 공개/,
    );
    expect(html(matrix)).toMatch(/<li>적은 노력, 큰 효과[^<]*<ul><li>빠른 승리/);
    expect(html(causal)).toMatch(/<li>원인<ul>.*<li>현상: 디자인 지연<\/li><li>결과<ul>/);
    expect(html(beforeAfter)).toMatch(/<li>예전<ul><li>정적 목업<\/li><\/ul><\/li><li>후<ul>/);
  });

  it('마크다운은 타임라인을 번호 목록, 매트릭스를 표, 인과도와 전후 비교를 목록으로 옮긴다', () => {
    const md = (d: Diagram) => renderDigestMarkdown(withDiagram(d), sampleTranscript());
    expect(md(timeline)).toContain('*타임라인: 출시 흐름*');
    expect(md(timeline)).toMatch(/^1\. \*\*2019년\*\* 첫 공개 \[00:05\]/m);
    const m = md(matrix);
    expect(m).toContain('| | 적은 노력 | 큰 노력 |');
    expect(m).toMatch(/^\| 큰 효과 \| 빠른 승리 \[00:10\]\([^)]+\) \| 큰 과제 \|$/m);
    expect(m).toMatch(/^\| 작은 효과 \| {3}\| 피할 일, 미룰 일 \|$/m);
    expect(md(causal)).toMatch(
      /^- 원인\n {2}- 코드 중심\n {2}- 느린 핸드오프 \[00:15\]\([^)]+\)\n- 현상: 디자인 지연\n- 결과\n {2}- 출시 늦음$/m,
    );
    expect(md(beforeAfter)).toMatch(/^- 예전\n {2}- 정적 목업\n- 후\n {2}- 실제 코드 \[00:25\]/m);
  });

  it('매트릭스 칸 글자의 |는 표를 깨지 않게 이스케이프한다', () => {
    const d = withDiagram({ ...matrix, cells: [[{ label: 'a|b' }], [], [], []] } as Diagram);
    expect(renderDigestMarkdown(d, sampleTranscript())).toContain('a\\|b');
  });
});

describe('figure 블록', () => {
  const figureExt = (diagram: Diagram = timeline): Extension => ({
    template: 'visual',
    title: '그림 해설',
    lang: 'ko',
    blocks: [
      { type: 'text', text: '개념 둘을 순서대로 놓았다.' },
      {
        type: 'figure',
        title: '출시 흐름',
        diagram,
        explanation: '공개 뒤 **AI**를 들였다.',
        // 대섹션 범위에 묶이지 않는다. 마지막 문장도 받는다
        cite: { key: 11, from: 10, to: 11 },
      },
    ],
  });
  const withExt = (ext: Extension): Digest => ({ ...sampleDigest(), extensions: [ext] });

  it('스키마와 lint를 통과하고 출처는 스크립트 안이면 된다', () => {
    const digest = withExt(figureExt());
    expect(parseDigest(JSON.parse(JSON.stringify(digest))).ok).toBe(true);
    expect(lintErrors(lintDigest(digest, sampleTranscript()))).toEqual([]);
  });

  it('cite가 없으면 스키마가 거절한다', () => {
    const ext = figureExt();
    const raw = JSON.parse(JSON.stringify(withExt(ext))) as {
      extensions: { blocks: Record<string, unknown>[] }[];
    };
    delete raw.extensions[0]!.blocks[1]!.cite;
    expect(parseDigest(raw).ok).toBe(false);
  });

  it('도식 모양과 출처, 라벨 마커를 블록 경로로 짚는다', () => {
    const empty = figureExt({
      kind: 'causal',
      inputs: [],
      center: { label: '**현상**' },
      outputs: [],
    });
    const block = empty.blocks[1]!;
    if (block.type !== 'figure') throw new Error('figure 블록이어야 한다');
    block.cite = { key: 20, from: 20, to: 20 };
    const issues = lintDigest(withExt(empty), sampleTranscript());
    const at = (code: string) => issues.filter((i) => i.code === code).map((i) => i.path);
    expect(at('DIAGRAM_EMPTY')).toEqual(['extensions.0.blocks.1.diagram']);
    expect(at('TITLE_MARKER')).toEqual(['extensions.0.blocks.1.diagram.center.label']);
    expect(issues.some((i) => i.path.startsWith('extensions.0.blocks.1.cite'))).toBe(true);
  });

  it('HTML은 제목과 그림 카드 아래 설명을 붙이고 크게 보기와 목록 보기를 단다', () => {
    const { html } = renderDigestHtml(withExt(figureExt()), sampleTranscript());
    expect(html).toMatch(
      /<article class="fig-card"><h3>출시 흐름<\/h3><figure class="diagram">.*data-zoom.*<details class="dg-outline">.*<\/figure><p class="fig-exp">공개 뒤 <strong>AI<\/strong>/s,
    );
    expect(html).toContain('출시 흐름 타임라인');
  });

  it('마크다운은 제목, 그림을 바꾼 목록, 설명 순서로 낸다', () => {
    const md = renderExtensionMarkdown(figureExt(), sampleTranscript());
    const title = md.indexOf('### 출시 흐름');
    const list = md.search(/^1\. \*\*2019년\*\* 첫 공개/m);
    const exp = md.indexOf('공개 뒤 **AI**를 들였다.');
    expect(title).toBeGreaterThanOrEqual(0);
    expect(list).toBeGreaterThan(title);
    expect(exp).toBeGreaterThan(list);
  });
});

describe('허브와 핵심 수치 도식', () => {
  const hub: Diagram = {
    kind: 'hub',
    caption: '코드 레이어',
    center: { label: '디자인 시스템' },
    satellites: [
      { label: '토큰', cite: { key: 1, from: 1, to: 1 } },
      { label: '컴포넌트', focus: true },
      { label: '문서' },
    ],
  };
  const stat: Diagram = {
    kind: 'stat',
    caption: '규모',
    value: '5천만 명',
    label: '월간 가입자',
    cite: { key: 2, from: 2, to: 2 },
  };
  const issuesOf = (d: Digest, code: string) =>
    lintDigest(d, sampleTranscript()).filter((i) => i.code === code);
  const figureDigest = (diagram: Diagram): Digest => ({
    ...sampleDigest(),
    extensions: [
      {
        template: 'visual',
        title: '그림 해설',
        lang: 'ko',
        blocks: [
          {
            type: 'figure',
            title: '제목',
            diagram,
            explanation: '설명',
            cite: { key: 1, from: 1, to: 1 },
          },
        ],
      },
    ],
  });
  const raw = (diagram: unknown) => {
    const r = JSON.parse(JSON.stringify(sampleDigest()));
    r.reports[0].sections[0].diagram = diagram;
    return r;
  };

  describe('스키마', () => {
    it('위성 2~8개 허브와 stat은 통과한다', () => {
      for (const n of [2, 8]) {
        const satellites = Array.from({ length: n }, (_, i) => ({ label: `s${i}` }));
        expect(parseDigest(raw({ ...hub, satellites })).ok).toBe(true);
      }
      expect(parseDigest(raw(hub)).ok).toBe(true);
      expect(parseDigest(raw(stat)).ok).toBe(true);
    });

    it('위성이 2개 미만이거나 8개를 넘으면 거절한다', () => {
      for (const n of [0, 1, 9]) {
        const satellites = Array.from({ length: n }, (_, i) => ({ label: `s${i}` }));
        expect(parseDigest(raw({ ...hub, satellites })).ok).toBe(false);
      }
    });

    it('focus는 불리언만 받는다', () => {
      const satellites = [{ label: 'a', focus: 'yes' }, { label: 'b' }];
      expect(parseDigest(raw({ ...hub, satellites })).ok).toBe(false);
      expect(
        parseDigest(raw({ ...hub, satellites: [{ label: 'a', focus: false }, { label: 'b' }] })).ok,
      ).toBe(true);
    });

    it('stat의 value는 텍스트이고 label은 필수이며 cite는 선택이다', () => {
      expect(parseDigest(raw({ ...stat, value: 50000000 })).ok).toBe(false);
      const { label: _l, ...noLabel } = stat as Extract<Diagram, { kind: 'stat' }>;
      expect(parseDigest(raw(noLabel)).ok).toBe(false);
      const { cite: _c, ...noCite } = stat as Extract<Diagram, { kind: 'stat' }>;
      expect(parseDigest(raw(noCite)).ok).toBe(true);
    });
  });

  describe('lint', () => {
    it('정상 허브와 stat은 에러가 없다', () => {
      expect(lintErrors(lintDigest(withDiagram(hub), sampleTranscript()))).toEqual([]);
      expect(lintErrors(lintDigest(withDiagram(stat), sampleTranscript()))).toEqual([]);
    });

    it('DIAGRAM_FOCUS_MULTI는 focus가 둘 이상이면 두 번째 위성을 에러로 짚는다', () => {
      const multi: Diagram = {
        ...hub,
        satellites: [{ label: 'a', focus: true }, { label: 'b' }, { label: 'c', focus: true }],
      } as Diagram;
      const found = issuesOf(withDiagram(multi), 'DIAGRAM_FOCUS_MULTI');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        severity: 'error',
        path: 'reports.0.sections.0.diagram.satellites.2.focus',
      });
      expect(issuesOf(withDiagram(hub), 'DIAGRAM_FOCUS_MULTI')).toEqual([]);
    });

    it('DIAGRAM_FOCUS_MULTI는 figure 블록에서도 걸린다', () => {
      const multi = {
        ...hub,
        satellites: [
          { label: 'a', focus: true },
          { label: 'b', focus: true },
        ],
      } as Diagram;
      const found = issuesOf(figureDigest(multi), 'DIAGRAM_FOCUS_MULTI');
      expect(found.map((i) => i.path)).toEqual([
        'extensions.0.blocks.0.diagram.satellites.1.focus',
      ]);
      expect(found[0]!.severity).toBe('error');
    });

    it('DIAGRAM_STAT_LONG은 value가 12자를 넘을 때만 경고한다', () => {
      const at12 = { ...stat, value: '가'.repeat(12) } as Diagram;
      const at13 = { ...stat, value: '가'.repeat(13) } as Diagram;
      expect(issuesOf(withDiagram(at12), 'DIAGRAM_STAT_LONG')).toEqual([]);
      const found = issuesOf(withDiagram(at13), 'DIAGRAM_STAT_LONG');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        severity: 'warning',
        path: 'reports.0.sections.0.diagram.value',
      });
      const fig = issuesOf(figureDigest(at13), 'DIAGRAM_STAT_LONG');
      expect(fig.map((i) => i.path)).toEqual(['extensions.0.blocks.0.diagram.value']);
    });

    it('DIAGRAM_STAT_NO_CITE는 cite가 없을 때 경고한다', () => {
      const noCite = { ...stat, cite: undefined } as Diagram;
      const found = issuesOf(withDiagram(noCite), 'DIAGRAM_STAT_NO_CITE');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        severity: 'warning',
        path: 'reports.0.sections.0.diagram',
      });
      expect(issuesOf(withDiagram(stat), 'DIAGRAM_STAT_NO_CITE')).toEqual([]);
      expect(issuesOf(figureDigest(noCite), 'DIAGRAM_STAT_NO_CITE').map((i) => i.path)).toEqual([
        'extensions.0.blocks.0.diagram',
      ]);
    });

    it('stat value에도 마커를 받지 않고 경로는 value다', () => {
      const d = withDiagram({ ...stat, value: '**5천만**' } as Diagram);
      expect(issuesOf(d, 'TITLE_MARKER').map((i) => i.path)).toEqual([
        'reports.0.sections.0.diagram.value',
      ]);
    });

    it('출처가 대섹션 밖이면 허브 위성과 stat cite 자리를 짚는다', () => {
      const out = { key: 8, from: 8, to: 8 };
      const h = withDiagram({
        ...hub,
        satellites: [{ label: 'a', cite: out }, { label: 'b' }],
      } as Diagram);
      expect(issuesOf(h, 'DIAGRAM_CITE_OUT_OF_SECTION').map((i) => i.path)).toEqual([
        'reports.0.sections.0.diagram.satellites.0.cite',
      ]);
      const s = withDiagram({ ...stat, cite: out } as Diagram);
      expect(issuesOf(s, 'DIAGRAM_CITE_OUT_OF_SECTION').map((i) => i.path)).toEqual([
        'reports.0.sections.0.diagram.cite',
      ]);
    });
  });

  describe('SVG', () => {
    const opts = { sec };
    const hubSvgOf = (n: number, o = opts) =>
      hubSvg(
        { label: '중심' },
        Array.from({ length: n }, (_, i) => ({ label: `위성${i}` })),
        o,
      );

    it('hub는 nodeSvg를 거쳐 data-sec과 role=link를 단다', () => {
      const svg = hubSvg(
        { label: '중심', cite: { key: 1, from: 1, to: 1 } },
        [{ label: 'a', cite: { key: 2, from: 2, to: 2 } }, { label: 'b' }],
        opts,
      );
      expect(svg).toContain('data-sec="5"');
      expect(svg).toContain('data-sec="10"');
      expect(svg).toMatch(/<g class="dg-node[^"]*" data-sec="10" role="link" tabindex="0"/);
    });

    it('hub는 글 자료에서 data-unit을 단다', () => {
      const svg = hubSvg(
        { label: '중심' },
        [{ label: 'a', cite: { key: 2, from: 2, to: 2 } }, { label: 'b' }],
        { unit: (c) => ({ index: c.key, label: 'p.1' }) },
      );
      expect(svg).toContain('data-unit="2"');
      expect(svg).not.toContain('data-sec=');
      expect(svg).toContain('role="link"');
    });

    it('stat은 label의 cite로 data-sec, data-unit, role=link를 단다', () => {
      const label = { label: '가입자', cite: { key: 1, from: 1, to: 1 } };
      const video = statSvg('5천만 명', label, opts);
      expect(video).toContain('data-sec="5"');
      expect(video).toContain('role="link"');
      const text = statSvg('5천만 명', label, { unit: (c) => ({ index: c.key, label: 'p.1' }) });
      expect(text).toContain('data-unit="1"');
      expect(text).not.toContain('data-sec=');
      expect(text).toContain('role="link"');
    });

    it('stat은 value를 글자 그대로 싣고 cite 없으면 링크를 안 단다', () => {
      const svg = statSvg('5천만 명', { label: '가입자' }, opts);
      expect(svg).toContain('>5천만 명<');
      expect(svg).not.toContain('role="link"');
      expect(svg).not.toContain('data-sec');
    });

    it('장식 요소에만 aria-hidden이 붙고 노드에는 안 붙는다', () => {
      const h = hubSvgOf(3);
      expect(h).toMatch(/<path d="[^"]+" aria-hidden="true"/);
      for (const m of h.matchAll(/<g class="dg-node[^>]*>/g)) {
        expect(m[0]).not.toContain('aria-hidden');
      }
      const s = statSvg('99%', { label: '정확도' }, opts);
      expect(s).toContain('<g class="dg-spark" aria-hidden="true"');
      for (const m of s.matchAll(/<g class="dg-(node|stat-value)[^>]*>/g)) {
        expect(m[0]).not.toContain('aria-hidden');
      }
    });

    it('focus 위성에만 dg-focus가 붙는다', () => {
      const svg = hubSvg(
        { label: '중심' },
        [{ label: 'a', focus: true }, { label: 'b' }, { label: 'c' }],
        opts,
      );
      expect(svg.match(/dg-focus/g)).toHaveLength(1);
      expect(hubSvgOf(3)).not.toContain('dg-focus');
    });

    it('등장 번호는 그린 순서대로 노드와 선이 번호를 하나씩 쓴다', () => {
      const svg = flowSvg([{ label: '가' }, { label: '나' }], opts);
      expect(svg).toContain('<g class="dg-step" style="--i:0"><g class="dg-node');
      expect(svg).toContain('class="dg-line" pathLength="1" style="--i:1"');
      expect(svg).toContain('<g class="dg-step" style="--i:2"><g class="dg-node');
    });

    it('등장 번호가 16개까지는 간격을 그대로 두고 17개부터 --dg-step을 줄인다', () => {
      const steps = (svg: string) => new Set(svg.match(/--i:\d+/g)).size;
      const cyc = cycleSvg(
        Array.from({ length: 8 }, (_, i) => ({ label: `c${i}` })),
        opts,
      );
      expect(steps(cyc)).toBe(16);
      expect(cyc).not.toContain('--dg-step');
      const big = hubSvgOf(8);
      expect(steps(big)).toBe(17);
      expect(big).toMatch(/<svg [^>]*style="--dg-step:\d+ms"/);
      expect(hubSvgOf(7)).not.toContain('--dg-step');
      const ms = Number(/--dg-step:(\d+)ms/.exec(big)![1]);
      expect(ms).toBeLessThan(280);
    });

    it('hub 상자는 위성 2, 3, 5, 8개에서 겹치지 않는다', () => {
      for (const n of [2, 3, 5, 8]) {
        const svg = hubSvgOf(n);
        const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
        const boxes = [
          ...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/g),
        ].map((m) => ({ x: +m[1]!, y: +m[2]!, w: +m[3]!, h: +m[4]! }));
        expect(boxes).toHaveLength(n + 1);
        for (const b of boxes) {
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.y).toBeGreaterThanOrEqual(0);
          expect(b.x + b.w).toBeLessThanOrEqual(+vb[1]!);
          expect(b.y + b.h).toBeLessThanOrEqual(+vb[2]!);
        }
        for (const [i, a] of boxes.entries()) {
          for (const b of boxes.slice(i + 1)) {
            const apart =
              a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
            expect(apart).toBe(true);
          }
        }
      }
    });
  });

  describe('렌더', () => {
    it('대섹션 HTML에 허브와 핵심 수치 도식을 그리고 라벨을 단다', () => {
      const h = renderDigestHtml(withDiagram(hub), sampleTranscript()).html;
      expect(h).toContain('dg-hub');
      expect(h).toContain('허브');
      const s = renderDigestHtml(withDiagram(stat), sampleTranscript()).html;
      expect(s).toContain('dg-stat');
      expect(s).toContain('핵심 수치');
      expect(s).toContain('5천만 명');
    });

    it('figure 블록에서도 그린다', () => {
      const { html } = renderDigestHtml(
        { ...sampleDigest(), extensions: [figureExt(hub)] },
        sampleTranscript(),
      );
      expect(html).toContain('dg-hub');
    });

    it('마크다운은 hub를 중심 아래 위성 목록으로, stat을 굵은 값과 label 한 줄로 낸다', () => {
      const h = renderDigestMarkdown(withDiagram(hub), sampleTranscript());
      expect(h).toContain('디자인 시스템');
      expect(h).toMatch(/^\s*[-*\d.]+\s+\*?\*?토큰/m);
      expect(h).toMatch(/컴포넌트 \(핵심\)/);
      const s = renderDigestMarkdown(withDiagram(stat), sampleTranscript());
      expect(s).toMatch(/\*\*5천만 명\*\* 월간 가입자/);
    });

    it('stat과 hub 글자는 mdInline을 거쳐 |와 줄바꿈이 마크다운을 깨지 않는다', () => {
      const s = renderDigestMarkdown(
        withDiagram({ ...stat, value: '3|4배', label: '속도\n향상' } as Diagram),
        sampleTranscript(),
      );
      expect(s).toContain('**3\\|4배** 속도 향상');
      const h = renderDigestMarkdown(
        withDiagram({ ...hub, center: { label: '중심|축' } } as Diagram),
        sampleTranscript(),
      );
      expect(h).toContain('중심\\|축');
    });

    it('stat HTML 목록 보기는 value를 굵게 쓴다', () => {
      const { html } = renderDigestHtml(withDiagram(stat), sampleTranscript());
      expect(html).toMatch(/<p><b>5천만 명<\/b> 월간 가입자/);
    });
  });
});

function figureExt(diagram: Diagram): Extension {
  return {
    template: 'visual',
    title: '그림 해설',
    lang: 'ko',
    blocks: [
      {
        type: 'figure',
        title: '허브 그림',
        diagram,
        explanation: '설명',
        cite: { key: 1, from: 1, to: 1 },
      },
    ],
  };
}

describe('격자 고르기 도식', () => {
  const cell = (i: number, picked = false) => ({
    label: `후보${i}`,
    ...(picked ? { picked } : {}),
  });
  const cellsOf = (n: number, pickedAt: number[]) =>
    Array.from({ length: n }, (_, i) => cell(i, pickedAt.includes(i)));
  const grid: Diagram = {
    kind: 'pickGrid',
    caption: '고른 기능',
    cells: [
      { label: '검색', picked: true, cite: { key: 1, from: 1, to: 1 } },
      { label: '추천' },
      { label: '알림', picked: true },
      { label: '결제' },
      { label: '예약' },
      { label: '리뷰' },
    ],
  };
  const issuesOf = (d: Digest, code: string) =>
    lintDigest(d, sampleTranscript()).filter((i) => i.code === code);
  const raw = (diagram: unknown) => {
    const r = JSON.parse(JSON.stringify(sampleDigest()));
    r.reports[0].sections[0].diagram = diagram;
    return r;
  };
  const opts = { sec };

  describe('스키마', () => {
    it('칸 4~16개는 통과하고 3개와 17개는 거절한다', () => {
      for (const n of [4, 16]) {
        expect(parseDigest(raw({ ...grid, cells: cellsOf(n, [0]) })).ok).toBe(true);
      }
      for (const n of [0, 3, 17]) {
        expect(parseDigest(raw({ ...grid, cells: cellsOf(n, [0]) })).ok).toBe(false);
      }
      expect(parseDigest(raw(grid)).ok).toBe(true);
    });

    it('picked는 불리언만 받는다', () => {
      const cells = [{ label: 'a', picked: 'yes' }, ...cellsOf(3, [])];
      expect(parseDigest(raw({ ...grid, cells })).ok).toBe(false);
    });
  });

  describe('lint', () => {
    it('정상 격자는 에러도 경고도 없다', () => {
      const found = lintDigest(withDiagram(grid), sampleTranscript());
      expect(lintErrors(found)).toEqual([]);
      expect(found.filter((i) => i.code.startsWith('DIAGRAM_PICK'))).toEqual([]);
    });

    it('DIAGRAM_PICK_NONE은 picked가 하나도 없으면 에러다', () => {
      const none = { ...grid, cells: cellsOf(6, []) } as Diagram;
      const found = issuesOf(withDiagram(none), 'DIAGRAM_PICK_NONE');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        severity: 'error',
        path: 'reports.0.sections.0.diagram.cells',
      });
      const falsy = { ...grid, cells: cellsOf(4, []).map((c) => ({ ...c, picked: false })) };
      expect(issuesOf(withDiagram(falsy as Diagram), 'DIAGRAM_PICK_NONE')).toHaveLength(1);
    });

    it('DIAGRAM_PICK_ALL은 전부 picked면 에러다', () => {
      const all = { ...grid, cells: cellsOf(5, [0, 1, 2, 3, 4]) } as Diagram;
      const found = issuesOf(withDiagram(all), 'DIAGRAM_PICK_ALL');
      expect(found).toHaveLength(1);
      expect(found[0]!.severity).toBe('error');
      expect(issuesOf(withDiagram(all), 'DIAGRAM_PICK_MANY')).toEqual([]);
    });

    it('DIAGRAM_PICK_MANY는 절반을 넘을 때만 경고한다', () => {
      const half = { ...grid, cells: cellsOf(6, [0, 1, 2]) } as Diagram;
      expect(issuesOf(withDiagram(half), 'DIAGRAM_PICK_MANY')).toEqual([]);
      const over = { ...grid, cells: cellsOf(6, [0, 1, 2, 3]) } as Diagram;
      const found = issuesOf(withDiagram(over), 'DIAGRAM_PICK_MANY');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ severity: 'warning' });
      expect(lintErrors(lintDigest(withDiagram(over), sampleTranscript()))).toEqual([]);
    });

    it('figure 블록에서도 걸린다', () => {
      const none = { ...grid, cells: cellsOf(4, []) } as Diagram;
      const d: Digest = { ...sampleDigest(), extensions: [figureExt(none)] };
      expect(issuesOf(d, 'DIAGRAM_PICK_NONE').map((i) => i.path)).toEqual([
        'extensions.0.blocks.0.diagram.cells',
      ]);
    });

    it('출처가 대섹션 밖이면 칸 cite 자리를 짚는다', () => {
      const out = { key: 8, from: 8, to: 8 };
      const d = withDiagram({
        ...grid,
        cells: [{ label: 'a', picked: true, cite: out }, ...cellsOf(3, [])],
      } as Diagram);
      expect(issuesOf(d, 'DIAGRAM_CITE_OUT_OF_SECTION').map((i) => i.path)).toEqual([
        'reports.0.sections.0.diagram.cells.0.cite',
      ]);
    });
  });

  describe('SVG', () => {
    it('열 수는 칸 수로 정한다', () => {
      const cols = Object.fromEntries(
        Array.from({ length: 13 }, (_, i) => [i + 4, pickGridColumns(i + 4)]),
      );
      expect(cols).toEqual({
        4: 2,
        5: 3,
        6: 3,
        7: 4,
        8: 4,
        9: 3,
        10: 4,
        11: 4,
        12: 4,
        13: 4,
        14: 4,
        15: 4,
        16: 4,
      });
    });

    it('칸은 격자로 놓이고 같은 크기다', () => {
      const svg = pickGridSvg(cellsOf(6, [1]), opts);
      const boxes = [
        ...svg.matchAll(/<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="26"/g),
      ];
      expect(boxes).toHaveLength(6);
      expect(new Set(boxes.map((m) => m[3])).size).toBe(1);
      expect(new Set(boxes.map((m) => m[1])).size).toBe(3);
      expect(new Set(boxes.map((m) => m[2])).size).toBe(2);
    });

    it('picked 칸에 dg-picked와 체크, 선택됨 aria가 붙고 나머지는 dg-dim이다', () => {
      const svg = pickGridSvg(cellsOf(5, [1, 3]), opts);
      expect(svg.match(/dg-picked/g)).toHaveLength(2);
      expect(svg.match(/dg-dim/g)).toHaveLength(3);
      expect(svg.match(/class="dg-check"/g)).toHaveLength(2);
      expect(svg.match(/<path class="dg-check"[^>]*aria-hidden="true"/g)).toHaveLength(2);
      expect(svg).toContain('aria-label="후보1, 선택됨"');
      expect(svg).toContain('aria-label="후보3, 선택됨"');
      expect(svg).not.toContain('aria-label="후보0');
    });

    it('출처가 있는 picked 칸은 링크 aria-label에도 선택됨을 싣는다', () => {
      const svg = pickGridSvg(
        [{ label: '검색', picked: true, cite: { key: 1, from: 1, to: 1 } }, ...cellsOf(3, [])],
        opts,
      );
      expect(svg).toContain('aria-label="검색, 0분 5초로 이동, 선택됨"');
      expect(svg).toContain('role="link"');
      const text = pickGridSvg(
        [{ label: '검색', picked: true, cite: { key: 1, from: 1, to: 1 } }, ...cellsOf(3, [])],
        { unit: (c) => ({ index: c.key, label: 'p.1' }) },
      );
      expect(text).toContain('data-unit="1"');
      expect(text).toContain('원문 p.1 열기, 선택됨');
    });

    it('스캔 줄은 장식이라 aria-hidden이고 등장 번호를 안 받는다', () => {
      const svg = pickGridSvg(cellsOf(4, [0]), opts);
      const scan = /<rect class="dg-scan"[^>]*>/.exec(svg)![0];
      expect(scan).toContain('aria-hidden="true"');
      expect(scan).not.toContain('--i:');
      expect(scan).toMatch(/style="--w:[\d.]+px"/);
      expect(svg.match(/class="dg-scan"/g)).toHaveLength(1);
    });

    it('칸은 dg-step으로 감싸 그린 순서대로 --i를 달고 svg에 칸 수 --n을 단다', () => {
      const svg = pickGridSvg(cellsOf(6, [0]), opts);
      for (let i = 0; i < 6; i++) {
        expect(svg).toContain(`<g class="dg-step" style="--i:${i}"><g class="dg-node`);
      }
      expect(svg.match(/class="dg-step"/g)).toHaveLength(6);
      expect(svg).toMatch(/<svg [^>]*style="--n:6"/);
      expect(svg).not.toContain('--dg-step');
    });

    it('칸 16개는 간격을 줄이지 않고 --n 하나만 단다', () => {
      const svg = pickGridSvg(cellsOf(16, [0, 5]), opts);
      expect(svg).toMatch(/<svg [^>]*style="--n:16"/);
      expect(svg).not.toContain('--dg-step');
    });

    it('칸이 전부 viewBox 안에 든다', () => {
      for (const n of [4, 5, 9, 16]) {
        const svg = pickGridSvg(cellsOf(n, [0]), opts);
        const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
        for (const m of svg.matchAll(
          /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="26"/g,
        )) {
          expect(+m[1]! + +m[3]!).toBeLessThanOrEqual(+vb[1]!);
          expect(+m[2]! + 26).toBeLessThanOrEqual(+vb[2]!);
        }
      }
    });
  });

  describe('렌더', () => {
    it('대섹션 HTML에 격자를 그리고 라벨과 aria에 고른 칸을 싣는다', () => {
      const h = renderDigestHtml(withDiagram(grid), sampleTranscript()).html;
      expect(h).toContain('dg-pick-grid');
      expect(h).toContain('격자 고르기');
      expect(h).toContain('검색, 알림 선택됨');
    });

    it('목록 보기가 선택됨을 말로 알린다', () => {
      const { html } = renderDigestHtml(withDiagram(grid), sampleTranscript());
      expect(html).toMatch(/<li>검색 \(선택됨\)/);
      expect(html).toMatch(/<li>알림 \(선택됨\)<\/li>/);
      expect(html).toMatch(/<li>추천<\/li>/);
    });

    it('figure 블록에서도 그린다', () => {
      const { html } = renderDigestHtml(
        { ...sampleDigest(), extensions: [figureExt(grid)] },
        sampleTranscript(),
      );
      expect(html).toContain('dg-pick-grid');
    });

    it('마크다운은 칸 목록으로 내고 고른 칸에 선택됨을 쓴다', () => {
      const md = renderDigestMarkdown(withDiagram(grid), sampleTranscript());
      expect(md).toMatch(/- 검색 \(선택됨\)/);
      expect(md).toMatch(/- 알림 \(선택됨\)/);
      expect(md).toMatch(/- 추천(?! \(선택됨\))/);
    });

    it('칸 글자는 mdInline을 거쳐 |와 줄바꿈이 마크다운을 깨지 않는다', () => {
      const d = withDiagram({
        ...grid,
        cells: [{ label: 'a|b\n칸', picked: true }, ...cellsOf(3, [])],
      } as Diagram);
      expect(renderDigestMarkdown(d, sampleTranscript())).toContain('a\\|b 칸 (선택됨)');
    });

    it('도식이 부족하다는 경고가 고른 칸 구조를 안내한다', () => {
      const d = sampleDigest();
      for (const s of d.reports[0]!.sections) delete s.diagram;
      const found = lintDigest(d, sampleTranscript()).filter((i) => i.code === 'DIAGRAM_TOO_FEW');
      expect(found).toHaveLength(1);
      expect(found[0]!.message).toContain('여러 후보 중 고른 몇 개');
    });
  });
});
