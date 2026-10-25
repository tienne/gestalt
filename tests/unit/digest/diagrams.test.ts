import { describe, expect, it } from 'vitest';
import {
  beforeAfterSvg,
  causalSvg,
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
  it('스키마 버전은 1.4.0이다', () => {
    expect(DIGEST_SCHEMA_VERSION).toBe('1.4.0');
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
