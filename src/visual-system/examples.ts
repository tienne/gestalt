import { renderDiagramSample, renderWidgetSample } from './product-examples.js';
import * as A from './render-combo.js';
import * as R from './render.js';
import { ACCENT_PRESETS, BACKGROUND_PRESETS, resolveColorTheme } from './color.js';

/**
 * 카탈로그 ID별 예제. 값은 전부 Gestalt 예시 데이터다. 외부 자료의 이미지나 수치를 옮기지 않아서
 * 문서는 예제마다 "Gestalt 예시"를 단다.
 */

export interface Example {
  catalogId: string;
  title: string;
  /** 어떤 렌더러가 그렸는지. product는 제품 코드 그대로다 */
  renderer: 'visual-system' | 'video-digest' | 'lens';
  html: string;
  /** 예제 사용법. 어떤 데이터를 넣으면 이 그림이 나오는가 */
  usage: string;
}

const GS: R.Source = { label: 'Gestalt 예시 데이터' };
const ex = (
  catalogId: string,
  title: string,
  html: string,
  usage: string,
  renderer: Example['renderer'] = 'visual-system',
): Example => ({
  catalogId,
  title,
  html,
  usage,
  renderer,
});

const DIAGRAM_FOR: Record<string, string> = {
  flow: 'flow',
  cycle: 'cycle',
  'compare-columns': 'compare',
  tree: 'tree',
  timeline: 'timeline',
  quadrant: 'matrix',
  causal: 'causal',
  'before-after': 'beforeAfter',
  hub: 'hub',
  'stat-card': 'stat',
  'choice-grid': 'pickGrid',
};

const WIDGET_FOR: Record<string, string> = {
  'bar-transition': 'toggleBars',
  heatmap: 'heatmap',
  'step-slider': 'stepSlider',
  'before-after': 'beforeAfter',
  'lane-graph': 'laneGraph',
  calendar: 'calendar',
  stepper: 'stepper',
  'analogy-map': 'analogyMap',
  'state-machine': 'stateMachine',
  sequence: 'sequence',
  swimlane: 'swimlane',
};

const trend: R.TrendData = {
  title: 'Execute 세대별 점수',
  x: ['1세대', '2세대', '3세대', '4세대', '5세대'],
  series: [
    { name: '평가 점수', points: [0.62, 0.71, 0.78, 0.84, 0.88] },
    { name: '목표 정렬도', points: [0.55, 0.6, 0.7, 0.76, 0.8] },
  ],
  unit: '',
  min: 0.5,
  max: 1,
  source: GS,
};

/** 배경마다 대비 기준까지 보정된 역할 수와 보정 없이 원색을 그대로 쓰는 테마 수. 예제 값이 실제 해석 결과와 같다 */
function adjustmentStats() {
  return BACKGROUND_PRESETS.map((b) => {
    let roles = 0;
    let clean = 0;
    for (const a of ACCENT_PRESETS) {
      const n = resolveColorTheme({ background: b.id, accent: a.id }).adjustments.filter(
        (x) => x.seed !== x.value,
      ).length;
      roles += n;
      if (!n) clean++;
    }
    return { label: b.name, roles, clean };
  });
}

function build(): Example[] {
  const stats = adjustmentStats();
  const clean = stats.reduce((t, s) => t + s.clean, 0);
  const total = BACKGROUND_PRESETS.length * ACCENT_PRESETS.length;
  const roleMax = Math.ceil(Math.max(...stats.map((s) => s.roles)) / 10) * 10;
  const out: Example[] = [];
  for (const [cid, kind] of Object.entries(DIAGRAM_FOR)) {
    out.push(
      ex(
        cid,
        `Video Digest ${kind} 도식`,
        renderDiagramSample(kind),
        `ges_digest의 diagram 블록 { kind: '${kind}' }`,
        'video-digest',
      ),
    );
  }
  for (const [cid, kind] of Object.entries(WIDGET_FOR)) {
    out.push(
      ex(
        cid,
        `Lens ${kind} 위젯`,
        renderWidgetSample(kind),
        `Lens 리포트의 widget { kind: '${kind}' }`,
        'lens',
      ),
    );
  }
  out.push(
    ex(
      'stat-card',
      '대비 검사 건수',
      R.statCard({
        value: '9,792',
        unit: '건',
        label: '204개 테마의 역할별 대비 검사',
        source: GS,
      }),
      'statCard({ value, unit, label, source })',
    ),
    ex(
      'big-number',
      '테마 조합 수',
      R.bigNumber({
        value: '204',
        unit: '개',
        label: '배경 6개 × 강조색 34개',
        context: '어느 조합에서도 글자 4.5:1, 도형 3:1을 넘긴다',
        source: GS,
      }),
      'bigNumber({ value, unit, label, context, source })',
    ),
    ex(
      'bar-horizontal',
      '배경별 보정 역할 수',
      R.barHorizontal({
        title: '배경별로 대비 보정이 들어간 역할 수',
        items: stats.map((s) => ({ label: s.label, value: s.roles })),
        unit: '개',
        max: roleMax,
        focus: ['화이트'],
        source: { label: 'resolveColorTheme 해석 결과' },
      }),
      'barHorizontal({ items, unit, max, focus })',
    ),
    ex(
      'bar-vertical',
      '월별 머지 PR',
      R.barVertical({
        title: '월별 머지 PR 수(예시 값)',
        items: [
          { label: '8월', value: 21 },
          { label: '9월', value: 27 },
          { label: '10월', value: 34 },
          { label: '11월', value: 38 },
        ],
        unit: '개',
        max: 40,
        reveal: true,
        source: GS,
      }),
      'barVertical({ items, unit, max, reveal })',
    ),
    ex(
      'trend-line',
      'Execute 세대별 점수',
      R.trendLine({ ...trend, endLabels: true }),
      'trendLine({ x, series, unit, min, max, endLabels })',
    ),
    ex(
      'donut',
      '통과한 대비 검사 비율',
      R.donut({ value: 9792, denominator: 9792, unit: '%', label: '통과한 검사', source: GS }),
      'donut({ value, denominator, unit, label })',
    ),
    ex(
      'comparison-cards',
      '렌더 방식 비교',
      R.comparisonCards(
        [
          {
            title: 'SVG 렌더',
            rows: [
              { k: '정지본', v: '그대로 보인다' },
              { k: '크기', v: '작다' },
            ],
          },
          {
            title: 'Chart.js',
            rows: [
              { k: '정지본', v: '스크립트 필요' },
              { k: '크기', v: 'CDN 의존' },
            ],
            tone: 'accent',
          },
        ],
        GS,
      ),
      'comparisonCards(cards, source)',
    ),
    ex(
      'dot-grid',
      '100개 중 통과',
      R.dotGrid({ value: 72, denominator: 100, label: '리뷰 1회에 통과한 PR', source: GS }),
      'dotGrid({ value, denominator, label })',
    ),
    ex(
      'layer-stack',
      '하네스 층',
      R.layerStack({
        layers: [
          { name: '스킬', value: '42개' },
          { name: '에이전트', value: '28개' },
          { name: 'MCP 도구', value: '18개' },
          { name: '엔진', value: 'TypeScript' },
        ],
        source: GS,
      }),
      'layerStack({ layers })',
    ),
    ex(
      'balance-scale',
      '외부 호스팅 판단',
      R.balanceScale({
        left: { title: '로컬 정적 파일', items: ['배포 결정 불필요', '오프라인 열람'] },
        right: { title: '외부 호스팅', items: ['링크 공유'] },
        verdict: '1차는 로컬 정적 파일로 둔다',
        source: GS,
      }),
      'balanceScale({ left, right, verdict })',
    ),
    ex(
      'node-graph',
      '모듈 의존 그래프',
      R.nodeGraph({
        title: 'visual-system 모듈',
        groups: ['데이터', '렌더', '문서'],
        nodes: [
          { id: 'c', label: 'color', group: 0, x: 90, y: 60 },
          { id: 'cat', label: 'catalog', group: 0, x: 90, y: 190 },
          { id: 'r', label: 'render', group: 1, x: 280, y: 125 },
          { id: 'ex', label: 'examples', group: 1, x: 420, y: 60 },
          { id: 'd', label: 'docs', group: 2, x: 470, y: 200 },
        ],
        edges: [
          { from: 'c', to: 'r' },
          { from: 'cat', to: 'd' },
          { from: 'r', to: 'ex' },
          { from: 'ex', to: 'd', dashed: true, label: '예제' },
        ],
        focus: ['r'],
        source: GS,
      }),
      'nodeGraph({ nodes, edges, groups, focus })',
    ),
    ex(
      'event-log',
      '컨덕터 이벤트',
      R.eventLog(
        [
          { time: '10:02:11', source: 'worker', status: 'info', text: 'task-3 시작' },
          { time: '10:05:40', source: 'gate', status: 'success', text: 'typecheck 통과' },
          { time: '10:06:02', source: 'gate', status: 'danger', text: 'lint 실패 2건' },
        ],
        {
          live: [{ time: '10:07:15', source: 'worker', status: 'warning', text: '재시도 1회' }],
          source: GS,
        },
      ),
      'eventLog(events, { live })',
    ),
    ex(
      'duration-bar',
      'gate 구간 시간',
      R.durationBar({
        total: 300,
        unit: '초',
        segments: [
          { label: 'typecheck', plan: 40, actual: 45 },
          { label: 'lint', plan: 30, actual: 28 },
          { label: 'build', plan: 50, actual: 52 },
          { label: 'test', plan: 180, actual: 175 },
        ],
        source: GS,
      }),
      'durationBar({ total, unit, segments })',
    ),
    ex(
      'status-badge',
      '업무 상태 배지',
      R.frame(
        'status-badge',
        `<p class="vs-badges">${R.statusBadge('success', '통과')} ${R.statusBadge('warning', '확인 대기')} ${R.statusBadge('danger', '실패')} ${R.statusBadge('info', '진행 중')}</p>`,
        { source: GS },
      ),
      "statusBadge('success', '통과')",
    ),
    ex(
      'status-matrix',
      '제품별 적용 상태',
      R.statusMatrix({
        cols: ['색', '시각화', '모션'],
        rows: [
          { label: 'Presentation', cells: ['success', 'success', 'warning'] },
          { label: 'Lens', cells: ['success', 'info', null] },
          { label: 'Peer', cells: ['info', null, null] },
        ],
        source: GS,
      }),
      'statusMatrix({ cols, rows })',
    ),
    ex(
      'source-cite',
      '문장 출처',
      R.sourceCite({
        text: '모든 테마에서 강조 글자는 4.5:1을 넘는다.',
        cites: [{ label: 'contrast.ts:18' }, { label: '¶3' }],
      }),
      'sourceCite({ text, cites })',
    ),
    ex(
      'quote-card',
      '원문 인용',
      R.quoteCard({ quote: '전체는 부분의 합보다 크다.', who: '게슈탈트 심리학', source: GS }),
      'quoteCard({ quote, who, source })',
    ),
    ex(
      'line-highlight',
      '읽을 줄 강조',
      R.lineHighlight({
        lines: [
          '배경은 6개 중 하나를 고른다.',
          '강조색은 34개 중 하나를 고른다.',
          '둘은 서로의 선택을 바꾸지 않는다.',
          '해석기가 대비를 맞춘다.',
        ],
        focus: [2, 3],
        source: GS,
      }),
      'lineHighlight({ lines, focus })',
    ),
    ex(
      'diff',
      '테마 저장값 변경',
      R.diffView(
        [
          { kind: 'same', text: 'background: charcoal' },
          { kind: 'removed', text: 'theme: dark' },
          { kind: 'added', text: 'accent: orange-red' },
          { kind: 'changed', text: 'storageKey: gestalt-theme' },
        ],
        GS,
      ),
      'diffView(rows)',
    ),
  );
  const slides: R.SlideData[] = [
    {
      kind: 'slide-cover',
      title: 'Gestalt 컬러 시스템',
      sub: '내부 공유',
      items: ['FE팀', '2026-11'],
    },
    { kind: 'slide-chapter', value: '02', title: '테마 해석' },
    {
      kind: 'slide-statement',
      title: '배경과 강조색은 따로 고른다',
      sub: '한쪽을 바꿔도 다른 쪽은 그대로다',
    },
    { kind: 'slide-number', value: '204', unit: '개', title: '배경 6 × 강조색 34', source: GS },
    {
      kind: 'slide-compare',
      title: '전과 후',
      left: { title: '전', items: ['밝게와 어둡게', '제품마다 다른 색'] },
      right: { title: '후', items: ['배경 6개', '강조색 34개', '역할별 대비 보정'] },
    },
    { kind: 'slide-quote', quote: '전체는 부분의 합보다 크다', who: '게슈탈트 심리학' },
    { kind: 'slide-list', title: '1차 적용 제품', items: ['Presentation', 'Lens', 'Video Digest'] },
    {
      kind: 'slide-process',
      title: '적용 순서',
      items: ['공통 시스템', '문서 사이트', '제품 전환', '통합 검증'],
    },
    {
      kind: 'slide-bar-chart',
      title: '배경별 보정 역할 수',
      bars: stats
        .filter((s) => ['화이트', '페이퍼', '차콜'].includes(s.label))
        .map((s) => ({ label: s.label, value: s.roles })),
      unit: '개',
      source: { label: 'resolveColorTheme 해석 결과' },
    },
    { kind: 'slide-image', title: '문서 사이트', sub: '문서 사이트 첫 화면 캡처 자리' },
    {
      kind: 'slide-qa',
      title: '자주 묻는 질문',
      items: [
        '강조색을 바꾸면 상태색도 바뀌나요?',
        '아니요. 상태색은 강조색과 따로 정해져요.',
        '정지본에서도 읽히나요?',
        '마지막 단계를 기본으로 그려요.',
      ],
    },
  ];
  for (const s of slides)
    out.push(
      ex(
        s.kind,
        `장표 ${s.kind.replace('slide-', '')}`,
        R.slide({ ...s, page: '3 / 12' }),
        `slide({ kind: '${s.kind}', ... })`,
      ),
    );

  out.push(
    ex(
      'combo-donut-sync',
      '통과율 카운트업',
      A.donutSync({
        value: clean,
        denominator: total,
        unit: '%',
        label: '보정 없이 원색 그대로 쓰는 테마',
        source: { label: 'resolveColorTheme 해석 결과' },
      }),
      'donutSync({ value, denominator, unit, label })',
    ),
    ex(
      'combo-dot-grid',
      '분모 먼저 보이기',
      A.dotGridDenominator({
        value: 34,
        denominator: 100,
        label: '강조색 프리셋 비율 예시',
        source: GS,
      }),
      'dotGridDenominator({ value, denominator, label })',
    ),
    ex(
      'combo-axis-band',
      '세대 구간 강조',
      A.axisBand({
        ...trend,
        bands: [
          { from: 0, to: 1, label: '초기' },
          { from: 1, to: 3, label: '개선' },
          { from: 3, to: 4, label: '수렴' },
        ],
      }),
      'axisBand({ ...trend, bands })',
    ),
    ex('combo-trend-label', '선 끝 라벨', A.trendEndLabel(trend), 'trendEndLabel(trend)'),
    ex(
      'combo-formula',
      '대비 검사 수 계산',
      A.formula({
        terms: [
          { label: '테마', value: '204' },
          { label: '테마당 검사', value: '48', assumption: '역할과 표면 조합' },
        ],
        op: '×',
        result: { label: '전체 검사', value: '9,792' },
        source: GS,
      }),
      'formula({ terms, op, result })',
    ),
    ex(
      'combo-duration-deviation',
      'gate 구간 편차',
      A.durationDeviation({
        total: 300,
        unit: '초',
        segments: [
          { label: 'typecheck', plan: 40, actual: 45 },
          { label: 'lint', plan: 30, actual: 28 },
          { label: 'build', plan: 50, actual: 52 },
          { label: 'test', plan: 180, actual: 175 },
        ],
        source: GS,
      }),
      'durationDeviation({ total, unit, segments })',
    ),
    ex(
      'combo-waveform',
      '발표 음성 구간',
      A.waveform({
        samples: Array.from(
          { length: 48 },
          (_, i) => 0.2 + 0.7 * Math.abs(Math.sin(i * 0.7) * Math.cos(i * 0.13)),
        ),
        segments: [
          { from: 0, to: 14, time: '0:00', line: '오늘은 컬러 시스템 얘기를 할게요.' },
          { from: 14, to: 30, time: '0:12', line: '배경과 강조색을 따로 고릅니다.' },
          { from: 30, to: 48, time: '0:27', line: '대비는 해석기가 맞춥니다.' },
        ],
        source: GS,
      }),
      'waveform({ samples, segments })',
    ),
    ex(
      'combo-chapter-map',
      '문서 구성 지도',
      A.chapterMap({
        chapters: [
          { n: '01', title: '컬러' },
          { n: '02', title: '시각화' },
          { n: '03', title: '모션' },
          { n: '04', title: '이행표' },
        ],
        source: GS,
      }),
      'chapterMap({ chapters })',
    ),
    ex(
      'combo-capture-zoom',
      '설정 한 줄 확대',
      A.captureZoom({
        lines: ['"theme": {', '  "background": "charcoal",', '  "accent": "orange-red"', '}'],
        focus: 2,
        source: GS,
      }),
      'captureZoom({ lines, focus })',
    ),
    ex(
      'combo-judgment-revision',
      '호스팅 판단 수정',
      A.judgmentRevision({
        first: '문서 사이트는 외부에 호스팅한다',
        evidence: '패키지와 배포 결정이 아직 미정이다',
        revised: '1차는 레포 안 정적 파일로 만든다',
        source: GS,
      }),
      'judgmentRevision({ first, evidence, revised })',
    ),
    ex(
      'combo-fixed-reveal',
      '적용 칸 채우기',
      A.fixedReveal({
        title: '1차 적용 결과',
        slots: [
          { label: 'Presentation', value: '템플릿 10종' },
          { label: 'Lens', value: '위젯 11종' },
          { label: 'Video Digest', value: '도식 11종' },
        ],
        source: GS,
      }),
      'fixedReveal({ title, slots })',
    ),
    ex(
      'combo-branch-reveal',
      '리뷰 결과 분기',
      A.branchReveal({
        root: '로컬 리뷰',
        branches: [
          { label: '통과', result: '머지' },
          { label: '변경 요청', result: '수정 후 재요청' },
          { label: '보류', result: '사람 확인' },
        ],
        source: GS,
      }),
      'branchReveal({ root, branches })',
    ),
    ex(
      'combo-converge',
      '입력 수렴',
      A.converge({ inputs: ['인터뷰', '레포 조사', '사용자 피드백'], result: '스펙', source: GS }),
      'converge({ inputs, result })',
    ),
    ex(
      'combo-cycle-human',
      '사람 승인 지점',
      A.cycleHuman({ steps: ['계획', '실행', '평가', '승인'], human: 3, source: GS }),
      'cycleHuman({ steps, human })',
    ),
    ex(
      'combo-matrix-reveal',
      '적용 상태 차례로',
      A.matrixReveal({
        cols: ['색', '시각화'],
        rows: [
          { label: 'Presentation', cells: ['success', 'success'] },
          { label: 'Lens', cells: ['success', 'warning'] },
        ],
        source: GS,
      }),
      'matrixReveal({ cols, rows })',
    ),
  );
  out.push(
    ex(
      'motion-enter',
      '장표 진입',
      R.slide({
        kind: 'slide-statement',
        title: '배경과 강조색은 따로 고른다',
        sub: '진입 모션 예시',
      }),
      '장 진입 시 data-vs-enter가 차례로 올라온다',
    ),
    ex(
      'motion-reveal',
      '막대 순차 공개',
      R.barVertical(
        {
          title: '월별 머지 PR 수(예시 값)',
          items: [
            { label: '8월', value: 21 },
            { label: '9월', value: 27 },
            { label: '10월', value: 34 },
            { label: '11월', value: 38 },
          ],
          unit: '개',
          max: 40,
          reveal: true,
          source: GS,
        },
        'motion-reveal',
      ),
      'data-at 차례로 공개',
    ),
    ex(
      'motion-emphasis',
      '막대 재강조',
      R.barHorizontal(
        {
          items: stats.map((s) => ({ label: s.label, value: s.roles })),
          unit: '개',
          max: roleMax,
          focus: ['화이트', '차콜', '잉크'],
          source: { label: 'resolveColorTheme 해석 결과' },
        },
        'motion-emphasis',
      ),
      'data-focus-at 차례로 강조',
    ),
    ex('motion-data', '값 전환', renderWidgetSample('toggleBars'), 'Lens 막대 전환 토글', 'lens'),
    ex(
      'motion-navigate',
      '현재 층 이동',
      R.layerStack(
        {
          layers: [
            { name: '스킬', value: '사용자 진입점' },
            { name: '에이전트', value: '역할별 작성' },
            { name: 'MCP 도구', value: '상태 저장' },
            { name: '엔진', value: 'TypeScript' },
          ],
          navigate: true,
          source: GS,
        },
        'motion-navigate',
      ),
      'data-focus-at으로 현재 위치 표시',
    ),
    ex(
      'motion-live',
      '이벤트 추가',
      R.eventLog(
        [
          { time: '10:02:11', source: 'worker', status: 'info', text: 'task-3 시작' },
          { time: '10:05:40', source: 'gate', status: 'success', text: 'typecheck 통과' },
        ],
        {
          live: [
            { time: '10:06:02', source: 'gate', status: 'danger', text: 'lint 실패 2건' },
            { time: '10:07:15', source: 'worker', status: 'warning', text: '재시도 1회' },
          ],
          source: GS,
        },
      ),
      '새 이벤트 받기 버튼이 행을 끝에 붙인다',
    ),
  );
  return out;
}

let cache: Example[] | null = null;
export function examples(): Example[] {
  cache ??= build();
  return cache;
}

export const examplesFor = (catalogId: string): Example[] =>
  examples().filter((e) => e.catalogId === catalogId);
