import { diagramFigure, diagramParts, type BlockHtmlContext } from '../digest/render-blocks.js';
import { diagramSchema, type Diagram } from '../digest/diagram-schema.js';
import type { LensHtmlContext } from '../digest/render-lens.js';
import { widgetHtml } from '../digest/render-widgets.js';
import { widgetSchema, type Widget } from '../digest/lens-widget-schema.js';
import type { Transcript } from '../digest/schema.js';
import { ACCENT_PRESETS, BACKGROUND_PRESETS, resolveColorTheme } from './color.js';
import { esc } from './render.js';

/**
 * 제품 렌더러로 그린 예제. Video Digest 도식 11종은 render-blocks.ts의 diagramParts를,
 * Lens 위젯 11종은 render-widgets.ts의 widgetHtml을 그대로 부른다. 문서 사이트에서 보는 그림이 제품과 같은 코드에서 나온다.
 * 예제 값은 스키마로 한 번 통과시켜 제품이 받지 않는 모양이 문서에 실리지 않게 한다.
 */

const blockCtx: BlockHtmlContext = {
  escape: esc,
  cite: () => '',
  time: () => '',
  sec: () => 0,
};

const C = { key: 0, from: 0, to: 0 };

const lensCtx: LensHtmlContext = {
  escape: esc,
  inline: esc,
  cite: () => '<a class="cite" href="#">¶1</a>',
  loc: (i: number) => `<span class="loc">¶${i}</span>`,
  source: null,
  transcript: { segments: [] } as unknown as Transcript,
};

export const DIAGRAM_SAMPLES: Record<string, Diagram> = Object.fromEntries(
  (
    [
      {
        kind: 'flow',
        caption: 'Execute 한 회차',
        steps: [
          { label: '인터뷰' },
          { label: '스펙' },
          { label: '계획' },
          { label: '실행' },
          { label: '평가' },
        ],
      },
      {
        kind: 'cycle',
        caption: '개선 루프',
        steps: [{ label: '실행' }, { label: '평가' }, { label: '진화' }, { label: '재실행' }],
      },
      {
        kind: 'compare',
        caption: 'Passthrough와 직접 호출',
        columns: [
          {
            title: 'Passthrough',
            items: [{ label: '세션 모델이 실행' }, { label: 'API 키 불필요' }],
          },
          { title: '직접 호출', items: [{ label: '서버가 모델 호출' }, { label: 'API 키 필요' }] },
        ],
      },
      {
        kind: 'tree',
        caption: '플러그인 자산',
        root: {
          label: 'plugin/',
          children: [
            { label: 'skills', children: [{ label: 'lens' }, { label: 'video-digest' }] },
            { label: 'role-agents', children: [{ label: 'presentation-designer' }] },
          ],
        },
      },
      {
        kind: 'timeline',
        caption: '릴리스 흐름',
        events: [
          { when: '월', label: '브랜치 생성' },
          { when: '화', label: 'gate 통과' },
          { when: '수', label: '태그 푸시' },
          { when: '목', label: 'npm 배포' },
        ],
      },
      {
        kind: 'matrix',
        caption: '작업 분류',
        x: { low: '영향 작음', high: '영향 큼' },
        y: { low: '쉬움', high: '어려움' },
        cells: [
          [{ label: '보류' }],
          [{ label: '계획 수립' }],
          [{ label: '바로 처리' }],
          [{ label: '우선 처리' }],
        ],
      },
      {
        kind: 'causal',
        caption: '리뷰 라운드가 늘어나는 이유',
        inputs: [{ label: '제안 미검증' }, { label: 'PR 크기' }],
        center: { label: '리뷰 라운드 증가' },
        outputs: [{ label: '머지 지연' }],
      },
      {
        kind: 'beforeAfter',
        caption: '테마 선택',
        before: { title: '전', items: [{ label: '자동, 밝게, 어둡게' }] },
        after: { title: '후', items: [{ label: '배경 6개' }, { label: '강조색 34개' }] },
      },
      {
        kind: 'hub',
        caption: 'Execute 엔진',
        center: { label: 'Execute' },
        satellites: [
          { label: 'Planning' },
          { label: 'Evaluate', focus: true },
          { label: 'Evolve' },
          { label: 'Code Review' },
        ],
      },
      {
        kind: 'stat',
        caption: '대비 검사',
        value: '9,792건',
        label: '204개 테마의 역할별 대비 검사, 실패 0',
      },
      {
        kind: 'pickGrid',
        caption: '1차 적용 제품',
        cells: [
          { label: 'Presentation', picked: true },
          { label: 'Lens', picked: true },
          { label: 'Video Digest', picked: true },
          { label: 'PRD View' },
          { label: 'Local PR' },
          { label: 'Peer' },
        ],
      },
    ] as const
  ).map((d) => [d.kind, diagramSchema.parse(d)]),
);

export function renderDiagramSample(kind: string): string {
  const d = DIAGRAM_SAMPLES[kind];
  if (!d) return '';
  const parts = diagramParts(d, `${d.caption ?? kind} 도식`, blockCtx);
  return diagramFigure(parts.svg, parts.outline, d.caption ? esc(d.caption) : undefined);
}

const v = (value: number) => ({ value });

const HEAT_BG = BACKGROUND_PRESETS.filter((b) =>
  ['charcoal', 'graphite', 'paper', 'white'].includes(b.id),
);
const adjusted = (bg: string, role: string): number =>
  ACCENT_PRESETS.filter((a) => {
    const adj = resolveColorTheme({ background: bg, accent: a.id }).adjustments.find(
      (x) => x.role === role,
    );
    return adj && adj.seed !== adj.value;
  }).length;

export const WIDGET_SAMPLES: Record<string, Widget> = Object.fromEntries(
  [
    {
      id: 'tb',
      class: 'A',
      title: '테스트 시간(초)',
      cite: C,
      kind: 'toggleBars',
      toggle: { off: '캐시 끔', on: '캐시 켬' },
      items: [
        { label: 'unit', off: v(212), on: v(96) },
        { label: 'plugin', off: v(88), on: v(41) },
        { label: 'lens', off: v(64), on: v(30) },
      ],
    },
    {
      id: 'hm',
      class: 'A',
      title: '배경별 대비 보정이 들어간 강조색 수',
      cite: C,
      kind: 'heatmap',
      x: { title: '역할', labels: ['강조 글자', '강조 채움'] },
      y: { title: '배경', labels: HEAT_BG.map((b) => b.name) },
      cells: HEAT_BG.map((b) => [
        v(adjusted(b.id, 'accent-text')),
        v(adjusted(b.id, 'accent-fill')),
      ]),
      better: 'low',
    },
    {
      id: 'ss',
      class: 'B',
      title: '공통 시스템 적용 차수',
      cite: C,
      kind: 'stepSlider',
      steps: [
        {
          label: '1차',
          nodes: [
            { id: 'sys', label: '공통 시스템' },
            { id: 'pr', label: 'Presentation' },
            { id: 'ln', label: 'Lens' },
          ],
          edges: [
            { from: 'sys', to: 'pr', strength: 'strong' },
            { from: 'sys', to: 'ln', strength: 'strong' },
          ],
        },
        {
          label: '2차',
          nodes: [
            { id: 'sys', label: '공통 시스템' },
            { id: 'prd', label: 'PRD View' },
            { id: 'arc', label: 'Architecture' },
          ],
          edges: [
            { from: 'sys', to: 'prd', strength: 'strong' },
            { from: 'sys', to: 'arc', strength: 'weak' },
          ],
        },
        {
          label: '3차',
          nodes: [
            { id: 'sys', label: '공통 시스템' },
            { id: 'cd', label: 'Conductor' },
            { id: 'orca', label: 'Orca 플러그인' },
          ],
          edges: [
            { from: 'sys', to: 'cd', strength: 'strong' },
            { from: 'sys', to: 'orca', strength: 'weak' },
          ],
        },
      ],
    },
    {
      id: 'ba',
      class: 'B',
      title: '테마 선택 전후',
      cite: C,
      kind: 'beforeAfter',
      before: { title: '전', items: [{ label: '자동, 밝게, 어둡게' }] },
      after: { title: '후', items: [{ label: '배경 6개' }, { label: '강조색 34개' }] },
    },
    {
      id: 'lg',
      class: 'D',
      title: '브랜치 흐름',
      cite: C,
      kind: 'laneGraph',
      lanes: [
        { id: 'main', label: 'main' },
        { id: 'rel', label: 'release' },
      ],
      nodes: [
        { id: 'm1', lane: 'main', label: 'v0.1' },
        { id: 'r1', lane: 'rel', label: '분기', parents: ['m1'] },
        { id: 'r2', lane: 'rel', label: 'QA 수정', parents: ['r1'] },
        { id: 'm2', lane: 'main', label: 'v0.2', parents: ['m1', 'r2'] },
      ],
    },
    {
      id: 'cal',
      class: 'D',
      title: '정기 배포 주간',
      cite: C,
      kind: 'calendar',
      columns: ['수', '목', '금', '월', '화'],
      tracks: [
        { id: 'qa', label: 'QA' },
        { id: 'dep', label: '배포' },
      ],
      spans: [
        { track: 'qa', from: 1, to: 3, label: 'alpha와 beta QA' },
        { track: 'dep', at: 4, label: '운영 배포', marker: 'release' },
      ],
    },
    {
      id: 'st',
      class: 'D',
      title: 'gate 순서',
      cite: C,
      kind: 'stepper',
      items: [
        { id: 'tc', label: 'typecheck' },
        { id: 'lint', label: 'lint' },
        { id: 'build', label: 'build' },
        { id: 'test', label: 'test' },
      ],
    },
    {
      id: 'am',
      class: 'D',
      title: '테마 해석 비유',
      cite: C,
      kind: 'analogyMap',
      domain: '인쇄',
      rows: [
        { term: '배경', termCite: C, analog: '종이 색' },
        { term: '강조색', termCite: C, analog: '별색 잉크' },
        { term: '대비 보정', termCite: C, analog: '잉크 농도 조절' },
      ],
      breaks: ['화면은 빛을 내므로 종이와 달리 어두운 배경이 기본일 수 있다'],
    },
    {
      id: 'sm',
      class: 'D',
      title: '로컬 PR 상태',
      cite: C,
      kind: 'stateMachine',
      states: [
        { id: 'open', label: '열림', initial: true },
        { id: 'rev', label: '리뷰 중' },
        { id: 'merged', label: '머지됨', final: true },
      ],
      transitions: [
        { id: 't1', from: 'open', to: 'rev', label: '리뷰 요청' },
        { id: 't2', from: 'rev', to: 'open', label: '변경 요청' },
        { id: 't3', from: 'rev', to: 'merged', label: '승인' },
      ],
    },
    {
      id: 'sq',
      class: 'D',
      title: 'Passthrough 호출 순서',
      cite: C,
      kind: 'sequence',
      actors: [
        { id: 'cc', label: 'Claude Code' },
        { id: 'mcp', label: 'MCP 서버' },
      ],
      messages: [
        { id: 'a', from: 'cc', to: 'mcp', label: 'execute_start' },
        { id: 'b', from: 'mcp', to: 'cc', label: '계획', reply: true },
        { id: 'c', from: 'cc', to: 'mcp', label: 'execute_task' },
      ],
    },
    {
      id: 'sw',
      class: 'D',
      title: '주문 처리',
      cite: C,
      kind: 'swimlane',
      lanes: [
        { id: 'cd', label: '컨덕터' },
        { id: 'wk', label: '워커' },
      ],
      activities: [
        { id: 'a1', lane: 'cd', col: 0, label: '배정' },
        { id: 'a2', lane: 'wk', col: 1, label: '구현' },
        { id: 'a3', lane: 'cd', col: 2, label: '머지' },
      ],
      arrows: [
        { from: 'a1', to: 'a2' },
        { from: 'a2', to: 'a3' },
      ],
    },
  ].map((w) => [w.kind, widgetSchema.parse(w)]),
);

export function renderWidgetSample(kind: string): string {
  const w = WIDGET_SAMPLES[kind];
  return w ? widgetHtml(w, lensCtx) : '';
}
