import type { MotionId } from './motion.js';

/**
 * 시각화 카탈로그. 모든 요소가 안정적인 ID를 갖고 문서 사이트, 제품 렌더러, 이행표가 같은 ID로 서로를 찾는다.
 * ID는 저장값이라 이름을 바꿔도 그대로 둔다. 조합(combo-*)은 기본 요소 위에 상태 순서를 얹은 사용 패턴이라 따로 표시한다.
 */

export const CATEGORIES = [
  { id: 'chart-number', name: '차트·수치' },
  { id: 'compare-ratio', name: '비교·비율' },
  { id: 'flow-structure', name: '흐름·관계·구조' },
  { id: 'time-event', name: '시간·이벤트' },
  { id: 'state-matrix', name: '상태·매트릭스' },
  { id: 'evidence-change', name: '근거·변경' },
  { id: 'slide-composition', name: '장표 구성·시각적 서술' },
  { id: 'motion-interaction', name: '모션·전환·조작' },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]['id'];

/** 요소가 받는 데이터 필드. 문서의 데이터, 표기 칸이 이 이름을 그대로 보여준다 */
export type DataField =
  | 'title'
  | 'value'
  | 'unit'
  | 'denominator'
  | 'axis'
  | 'series'
  | 'label'
  | 'time'
  | 'duration'
  | 'relation'
  | 'node'
  | 'group'
  | 'state'
  | 'source'
  | 'quote'
  | 'before'
  | 'after'
  | 'step'
  | 'focus'
  | 'image';

export interface CatalogOrigin {
  product: string;
  file: string;
  /** 그 제품 안에서 부르는 이름(도식 kind, 위젯 kind, 템플릿 장 역할) */
  name?: string;
}

export interface CatalogItem {
  id: string;
  category: CategoryId;
  name: string;
  purpose: string;
  data: DataField[];
  /** 표기 규칙. 단위, 분모, 범례처럼 정지본에서도 꼭 보여야 하는 것 */
  notation: string[];
  states: string[];
  operations: string[];
  motions: MotionId[];
  colorRoles: string[];
  origins: CatalogOrigin[];
  /** 조합이면 기반 요소 ID */
  basedOn?: string[];
  combo?: boolean;
}

const DIGEST_DIAGRAM = (name: string): CatalogOrigin => ({
  product: 'Video Digest',
  file: 'src/digest/svg.ts',
  name,
});
const LENS_WIDGET = (name: string): CatalogOrigin => ({
  product: 'Lens',
  file: 'src/digest/render-widgets.ts',
  name,
});
const SLIDE = (name: string): CatalogOrigin => ({
  product: 'Presentation',
  file: 'plugin/role-agents/presentation-designer/templates/*.html',
  name,
});
const PRD = (name: string): CatalogOrigin => ({
  product: 'PRD View',
  file: 'src/digest/render-prd-views.ts',
  name,
});

const SERIES = ['series-1', 'series-2', 'series-3', 'series-4', 'series-5', 'series-6'];
const BASE = ['text', 'text-muted', 'border', 'surface'];
const STATUS = [
  'success-fill',
  'warning-fill',
  'danger-fill',
  'info-fill',
  'success-text',
  'warning-text',
  'danger-text',
  'info-text',
];

type Draft = Omit<
  CatalogItem,
  'notation' | 'states' | 'operations' | 'motions' | 'colorRoles' | 'origins'
> &
  Partial<
    Pick<CatalogItem, 'notation' | 'states' | 'operations' | 'motions' | 'colorRoles' | 'origins'>
  >;

const item = (d: Draft): CatalogItem => ({
  notation: [],
  states: ['정지'],
  operations: [],
  motions: [],
  colorRoles: BASE,
  origins: [],
  ...d,
});

const combo = (
  id: string,
  category: CategoryId,
  name: string,
  purpose: string,
  data: DataField[],
  basedOn: string[],
  extra: Partial<CatalogItem>,
): CatalogItem => item({ id, category, name, purpose, data, basedOn, combo: true, ...extra });

export const CATALOG: CatalogItem[] = [
  // 차트, 수치
  item({
    id: 'stat-card',
    category: 'chart-number',
    name: '수치 카드',
    purpose: '핵심 숫자 하나와 그 숫자가 무엇을 재는지를 함께 보인다',
    data: ['value', 'unit', 'label', 'source'],
    notation: ['단위는 숫자 옆에 붙인다', '원문 정밀도를 바꾸지 않는다'],
    colorRoles: [...BASE, 'accent-text'],
    origins: [DIGEST_DIAGRAM('stat'), SLIDE('stat')],
    motions: ['motion-enter'],
  }),
  item({
    id: 'big-number',
    category: 'chart-number',
    name: '큰 숫자',
    purpose: '장표 한 장을 숫자 하나와 한 줄 맥락으로 채운다',
    data: ['value', 'unit', 'label', 'source'],
    notation: ['맥락 문장 한 줄', '출처는 하단'],
    colorRoles: [...BASE, 'accent-text'],
    origins: [SLIDE('number')],
    motions: ['motion-enter', 'motion-data'],
  }),
  item({
    id: 'bar-horizontal',
    category: 'chart-number',
    name: '가로 막대',
    purpose: '항목 이름이 긴 값을 같은 축에서 비교한다',
    data: ['label', 'value', 'unit', 'axis', 'focus', 'source'],
    notation: ['막대 끝에 값 라벨', '축은 0에서 시작', '강조 대상은 이름도 함께 굵게'],
    states: ['정지', '강조'],
    operations: ['강조 대상 바꾸기'],
    motions: ['motion-reveal', 'motion-emphasis'],
    colorRoles: [...BASE, 'accent-fill', 'text-muted'],
    origins: [SLIDE('bar-chart')],
  }),
  item({
    id: 'bar-vertical',
    category: 'chart-number',
    name: '세로 막대',
    purpose: '순서가 있는 범주나 짧은 기간의 값을 비교한다',
    data: ['label', 'value', 'unit', 'axis', 'source'],
    notation: ['막대 위 값 라벨', '축은 0에서 시작'],
    motions: ['motion-reveal'],
    colorRoles: [...BASE, 'accent-fill', 'series-2'],
    origins: [SLIDE('bar-chart')],
  }),
  item({
    id: 'trend-line',
    category: 'chart-number',
    name: '추세선',
    purpose: '시간이나 세대에 따른 값의 변화를 계열별로 보인다',
    data: ['series', 'time', 'value', 'unit', 'axis', 'source'],
    notation: ['계열마다 선 모양과 표식이 다르다', '선 끝에 직접 라벨', '축 범위를 적는다'],
    motions: ['motion-data'],
    colorRoles: [...BASE, ...SERIES],
    origins: [
      {
        product: 'Execute Evolution',
        file: 'src/graph-viz/evolution-html-generator.ts',
        name: 'Chart.js line',
      },
    ],
  }),
  item({
    id: 'donut',
    category: 'chart-number',
    name: '도넛',
    purpose: '전체에서 한 부분이 차지하는 비율을 보인다',
    data: ['value', 'denominator', 'unit', 'label', 'source'],
    notation: ['중앙에 비율 숫자', '분모를 같이 적는다'],
    motions: ['motion-data'],
    colorRoles: [...BASE, 'accent-fill'],
  }),
  item({
    id: 'bar-transition',
    category: 'chart-number',
    name: '막대 전환',
    purpose: '조건을 바꿨을 때 같은 항목의 값이 어떻게 달라지는지 보인다',
    data: ['label', 'value', 'unit', 'state', 'source'],
    notation: ['조건 이름이 버튼에 그대로', '두 조건 모두 원문 값'],
    states: ['조건 A', '조건 B'],
    operations: ['조건 토글'],
    motions: ['motion-data'],
    colorRoles: [...BASE, 'accent-fill', 'series-2'],
    origins: [LENS_WIDGET('toggleBars')],
  }),

  // 비교, 비율
  item({
    id: 'comparison-cards',
    category: 'compare-ratio',
    name: '비교 카드',
    purpose: '두세 대안의 이득과 비용을 나란히 놓는다',
    data: ['group', 'label', 'value', 'source'],
    notation: ['카드마다 같은 칸 순서'],
    colorRoles: [...BASE, 'accent-text'],
    origins: [{ product: 'Research HTML', file: 'src/research/render-html.ts', name: '비교표' }],
  }),
  item({
    id: 'compare-columns',
    category: 'compare-ratio',
    name: '양쪽 비교',
    purpose: '두 대상의 속성을 같은 줄에서 견준다',
    data: ['group', 'label', 'source'],
    notation: ['왼쪽과 오른쪽 제목 고정'],
    origins: [DIGEST_DIAGRAM('compare'), PRD('compare')],
    motions: ['motion-enter'],
  }),
  item({
    id: 'dot-grid',
    category: 'compare-ratio',
    name: '점 격자',
    purpose: '100칸처럼 분모를 먼저 보이고 해당 칸을 채운다',
    data: ['value', 'denominator', 'label', 'source'],
    notation: ['분모가 먼저 보인다', '채운 칸 수를 숫자로도 적는다'],
    motions: ['motion-reveal'],
    colorRoles: [...BASE, 'accent-fill'],
  }),
  item({
    id: 'heatmap',
    category: 'compare-ratio',
    name: '히트맵',
    purpose: '행과 열이 만나는 칸의 값 크기를 농도로 보인다',
    data: ['label', 'group', 'value', 'unit', 'source'],
    notation: ['칸마다 값 숫자', '농도 범례'],
    operations: ['칸 초점'],
    colorRoles: [...BASE, 'accent-fill', 'highlight'],
    origins: [LENS_WIDGET('heatmap')],
  }),
  item({
    id: 'layer-stack',
    category: 'compare-ratio',
    name: '층 구조',
    purpose: '층마다 범주와 대표 수치를 쌓아 위계를 보인다',
    data: ['group', 'label', 'value', 'focus'],
    notation: ['층 이름 왼쪽, 값 오른쪽'],
    states: ['정지', '현재 층'],
    operations: ['층 이동'],
    motions: ['motion-navigate'],
    colorRoles: [...BASE, 'accent-fill', 'highlight'],
  }),
  item({
    id: 'balance-scale',
    category: 'compare-ratio',
    name: '저울',
    purpose: '두 쪽 근거를 올려 판단이 어느 쪽으로 기우는지 보인다',
    data: ['group', 'label', 'value', 'step'],
    notation: ['양쪽 근거 목록이 같이 보인다'],
    states: ['기준 n개'],
    operations: ['기준 하나씩 올리기'],
    motions: ['motion-data'],
    colorRoles: [...BASE, 'accent-fill', 'series-2'],
  }),

  // 흐름, 관계, 구조
  item({
    id: 'flow',
    category: 'flow-structure',
    name: '흐름',
    purpose: '단계가 한 방향으로 이어지는 과정을 보인다',
    data: ['node', 'relation', 'label'],
    notation: ['화살표 방향', '단계 번호'],
    motions: ['motion-enter', 'motion-reveal'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [DIGEST_DIAGRAM('flow'), PRD('flow')],
  }),
  item({
    id: 'cycle',
    category: 'flow-structure',
    name: '순환',
    purpose: '끝이 처음으로 돌아오는 반복 과정을 보인다',
    data: ['node', 'relation'],
    notation: ['시작 지점 표시'],
    motions: ['motion-enter'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [DIGEST_DIAGRAM('cycle')],
  }),
  item({
    id: 'tree',
    category: 'flow-structure',
    name: '트리',
    purpose: '상위 개념에서 하위 항목으로 갈라지는 구조를 보인다',
    data: ['node', 'relation', 'group'],
    motions: ['motion-enter'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [DIGEST_DIAGRAM('tree')],
  }),
  item({
    id: 'causal',
    category: 'flow-structure',
    name: '인과',
    purpose: '원인과 결과의 연결을 근거와 함께 보인다',
    data: ['node', 'relation', 'source'],
    notation: ['관계 이름을 선 위에'],
    motions: ['motion-enter'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [DIGEST_DIAGRAM('causal')],
  }),
  item({
    id: 'hub',
    category: 'flow-structure',
    name: '허브',
    purpose: '중심 개념 하나에 주변 요소가 붙는 구조를 보인다',
    data: ['node', 'relation', 'focus'],
    states: ['정지', '초점'],
    motions: ['motion-enter', 'motion-emphasis'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [DIGEST_DIAGRAM('hub')],
  }),
  item({
    id: 'node-graph',
    category: 'flow-structure',
    name: '노드 그래프',
    purpose: '여러 종류의 노드와 관계를 범례와 함께 탐색한다',
    data: ['node', 'relation', 'group', 'source'],
    notation: ['노드 종류 범례', '관계 종류는 선 모양으로도 구분'],
    states: ['정지', '초점', '이웃 강조'],
    operations: ['검색', '초점', '확대와 이동'],
    motions: ['motion-emphasis', 'motion-navigate'],
    colorRoles: [...BASE, ...SERIES, 'focus'],
    origins: [
      { product: 'Architecture', file: 'src/architecture/html-renderer.ts' },
      { product: 'Code Graph', file: 'src/graph-viz/html-generator.ts' },
    ],
  }),
  item({
    id: 'state-machine',
    category: 'flow-structure',
    name: '상태 머신',
    purpose: '상태와 전이 조건을 보이고 현재 상태를 따라간다',
    data: ['state', 'relation', 'step'],
    states: ['상태 n'],
    operations: ['단계 이전과 다음'],
    motions: ['motion-reveal'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [LENS_WIDGET('stateMachine')],
  }),
  item({
    id: 'sequence',
    category: 'flow-structure',
    name: '시퀀스',
    purpose: '참여자 사이에 오가는 메시지 순서를 보인다',
    data: ['node', 'relation', 'step'],
    states: ['단계 n'],
    operations: ['단계 이전과 다음'],
    motions: ['motion-reveal'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [
      LENS_WIDGET('sequence'),
      { product: 'Architecture', file: 'src/architecture/sequence-views.ts' },
    ],
  }),
  item({
    id: 'swimlane',
    category: 'flow-structure',
    name: '스윔레인',
    purpose: '누가 어떤 단계를 맡는지 줄을 나눠 보인다',
    data: ['group', 'node', 'relation', 'step'],
    states: ['단계 n'],
    operations: ['단계 이전과 다음'],
    motions: ['motion-reveal'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [LENS_WIDGET('swimlane')],
  }),
  item({
    id: 'lane-graph',
    category: 'flow-structure',
    name: '레인 그래프',
    purpose: '여러 갈래가 나뉘고 합쳐지는 흐름을 줄 단위로 보인다',
    data: ['group', 'node', 'relation', 'step'],
    states: ['단계 n'],
    operations: ['단계 이전과 다음'],
    motions: ['motion-reveal'],
    colorRoles: [...BASE, ...SERIES.slice(0, 4)],
    origins: [LENS_WIDGET('laneGraph')],
  }),
  item({
    id: 'analogy-map',
    category: 'flow-structure',
    name: '비유 지도',
    purpose: '원래 개념과 비유를 짝지어 대응 관계를 보인다',
    data: ['node', 'relation', 'label'],
    notation: ['원문과 비유를 구분 표기'],
    operations: ['짝 초점'],
    colorRoles: [...BASE, 'accent-text', 'highlight'],
    origins: [LENS_WIDGET('analogyMap')],
  }),

  // 시간, 이벤트
  item({
    id: 'timeline',
    category: 'time-event',
    name: '타임라인',
    purpose: '사건을 시간 순서로 놓는다',
    data: ['time', 'label', 'source'],
    notation: ['시각 표기를 원문 그대로'],
    motions: ['motion-enter', 'motion-reveal'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [DIGEST_DIAGRAM('timeline'), PRD('timeline')],
  }),
  item({
    id: 'calendar',
    category: 'time-event',
    name: '달력',
    purpose: '날짜에 걸친 일정이나 사건을 칸으로 보인다',
    data: ['time', 'label', 'state'],
    operations: ['날짜 칸 초점'],
    colorRoles: [...BASE, 'accent-fill', 'highlight'],
    origins: [LENS_WIDGET('calendar')],
  }),
  item({
    id: 'stepper',
    category: 'time-event',
    name: '스테퍼',
    purpose: '순서가 있는 단계를 하나씩 넘기며 설명한다',
    data: ['step', 'label', 'source'],
    states: ['단계 n'],
    operations: ['단계 이전과 다음', '화살표 키'],
    motions: ['motion-reveal'],
    colorRoles: [...BASE, 'accent-fill', 'on-accent'],
    origins: [LENS_WIDGET('stepper')],
  }),
  item({
    id: 'step-slider',
    category: 'time-event',
    name: '단계 슬라이더',
    purpose: '정수 단계를 슬라이더로 골라 상태를 비교한다',
    data: ['step', 'value', 'label'],
    states: ['단계 n'],
    operations: ['슬라이더', '화살표 키'],
    motions: ['motion-reveal', 'motion-data'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [LENS_WIDGET('stepSlider')],
  }),
  item({
    id: 'event-log',
    category: 'time-event',
    name: '이벤트 로그',
    purpose: '실시간으로 쌓이는 사건을 시각, 출처, 상태와 함께 보인다',
    data: ['time', 'label', 'state', 'source'],
    notation: ['시각은 고정 폭 숫자', '소스 배지'],
    states: ['읽는 중', '새 항목 있음'],
    operations: ['접고 펴기', '필터'],
    motions: ['motion-live'],
    colorRoles: [...BASE, ...STATUS],
    origins: [
      { product: 'Peer', file: 'src/peer/viewer-html.ts' },
      { product: 'Conductor 결과', file: 'src/conductor-web/html.ts' },
    ],
  }),
  item({
    id: 'duration-bar',
    category: 'time-event',
    name: '기간 막대',
    purpose: '전체 시간 안에서 구간 길이를 비교한다',
    data: ['duration', 'label', 'unit'],
    notation: ['구간 길이 숫자', '전체 길이'],
    colorRoles: [...BASE, 'accent-fill', 'series-2'],
  }),

  // 상태, 매트릭스
  item({
    id: 'status-badge',
    category: 'state-matrix',
    name: '상태 배지',
    purpose: '업무 상태를 색, 기호, 라벨로 함께 보인다',
    data: ['state', 'label'],
    notation: ['색만으로 구분하지 않는다. 기호와 라벨이 같이 있다'],
    colorRoles: STATUS,
    origins: [
      { product: 'Conductor 결과', file: 'src/conductor-web/html.ts' },
      { product: 'Local PR', file: 'src/local-pr-web/html-generator.ts' },
    ],
  }),
  item({
    id: 'status-matrix',
    category: 'state-matrix',
    name: '상태 매트릭스',
    purpose: '행과 열이 만나는 칸마다 상태를 보인다',
    data: ['label', 'group', 'state'],
    notation: ['빈 값은 빈 칸이 아니라 "없음"으로'],
    operations: ['칸 초점'],
    colorRoles: [...BASE, ...STATUS],
    origins: [PRD('status matrix')],
  }),
  item({
    id: 'quadrant',
    category: 'state-matrix',
    name: '사분면',
    purpose: '두 기준으로 항목을 네 칸에 나눈다',
    data: ['axis', 'label', 'group'],
    notation: ['두 축 이름'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [DIGEST_DIAGRAM('matrix')],
    motions: ['motion-enter'],
  }),
  item({
    id: 'choice-grid',
    category: 'state-matrix',
    name: '선택 격자',
    purpose: '여러 선택지 중 고른 것을 표시한다',
    data: ['label', 'focus'],
    states: ['선택'],
    colorRoles: [...BASE, 'accent-fill', 'on-accent'],
    origins: [DIGEST_DIAGRAM('pickGrid')],
    motions: ['motion-emphasis'],
  }),

  // 근거, 변경
  item({
    id: 'source-cite',
    category: 'evidence-change',
    name: '출처 표시',
    purpose: '문장이나 값이 어디서 왔는지 원문 위치로 잇는다',
    data: ['source', 'time'],
    notation: ['위치(쪽, 타임코드)를 링크 텍스트로'],
    operations: ['출처 열기'],
    colorRoles: [...BASE, 'accent-text', 'focus'],
    origins: [
      { product: 'Video Digest', file: 'src/digest/render-blocks.ts', name: 'cite' },
      { product: 'Lens', file: 'src/digest/render-lens.ts', name: 'loc' },
    ],
  }),
  item({
    id: 'quote-card',
    category: 'evidence-change',
    name: '인용 카드',
    purpose: '원문 문장을 그대로 옮기고 출처를 붙인다',
    data: ['quote', 'source'],
    notation: ['원문 그대로', '재구성과 구분'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [
      { product: 'Lens', file: 'src/digest/render-lens.ts', name: 'quote' },
      SLIDE('quote'),
    ],
  }),
  item({
    id: 'line-highlight',
    category: 'evidence-change',
    name: '줄 강조',
    purpose: '긴 원문에서 읽을 줄만 강조하고 나머지는 남긴다',
    data: ['quote', 'focus', 'source'],
    states: ['강조 줄 n'],
    operations: ['강조 줄 이동'],
    motions: ['motion-emphasis'],
    colorRoles: [...BASE, 'highlight'],
  }),
  item({
    id: 'before-after',
    category: 'evidence-change',
    name: '전후 비교',
    purpose: '바뀌기 전과 후를 같은 틀에서 견준다',
    data: ['before', 'after', 'label', 'source'],
    notation: ['전과 후 라벨 고정'],
    states: ['전', '후'],
    operations: ['전후 토글'],
    motions: ['motion-data'],
    colorRoles: [...BASE, 'accent-fill'],
    origins: [DIGEST_DIAGRAM('beforeAfter'), LENS_WIDGET('beforeAfter')],
  }),
  item({
    id: 'diff',
    category: 'evidence-change',
    name: '변경 비교',
    purpose: '추가, 삭제, 변경을 줄 단위로 보인다',
    data: ['before', 'after', 'state'],
    notation: ['+ − ~ 기호가 색과 같이 붙는다'],
    colorRoles: [
      ...BASE,
      'diff-added-bg',
      'diff-removed-bg',
      'diff-changed-bg',
      'diff-added-text',
      'diff-removed-text',
      'diff-changed-text',
    ],
    origins: [
      { product: 'Local PR', file: 'src/local-pr-web/html-generator.ts' },
      { product: 'Architecture Delta', file: 'src/architecture/delta-renderer.ts' },
    ],
  }),

  // 장표 구성
  ...(
    [
      ['slide-cover', '표지', '제목, 부제, 발표자와 날짜', ['title', 'label']],
      ['slide-chapter', '챕터 구분', '큰 번호와 챕터 제목', ['title', 'step']],
      ['slide-statement', '결론 한 문장', '한 문장과 짧은 보조 설명', ['title', 'label']],
      ['slide-number', '숫자 장표', '큰 숫자와 맥락, 출처', ['value', 'unit', 'source']],
      ['slide-compare', '비교 장표', '두 쪽을 같은 칸 순서로', ['group', 'label']],
      ['slide-quote', '인용 장표', '인용문과 말한 사람, 출처', ['quote', 'source']],
      ['slide-list', '목록 장표', '항목을 하나씩 공개', ['label', 'step']],
      ['slide-process', '프로세스 장표', '번호 붙은 단계 흐름', ['step', 'label']],
      [
        'slide-bar-chart',
        '막대 차트 장표',
        '막대와 값 라벨, 출처',
        ['label', 'value', 'unit', 'source'],
      ],
      ['slide-image', '이미지 장표', '이미지와 캡션, 출처', ['image', 'source']],
      ['slide-qa', '문답 장표', '질문과 답을 차례로', ['label', 'step']],
    ] as const
  ).map(([id, name, purpose, data]) =>
    item({
      id,
      category: 'slide-composition',
      name,
      purpose,
      data: [...data],
      colorRoles: ['background', 'text', 'text-muted', 'accent-text', 'accent-fill', 'on-accent'],
      motions:
        id === 'slide-list' || id === 'slide-process' || id === 'slide-qa'
          ? ['motion-enter', 'motion-reveal']
          : ['motion-enter'],
      operations:
        id === 'slide-list' || id === 'slide-process' || id === 'slide-qa'
          ? ['클릭으로 다음 항목']
          : [],
      origins: [SLIDE(id.replace('slide-', ''))],
    }),
  ),

  // 모션
  ...(['enter', 'reveal', 'emphasis', 'data', 'navigate', 'live'] as const).map((m) =>
    item({
      id: `motion-${m}`,
      category: 'motion-interaction',
      name: {
        enter: '진입',
        reveal: '순차 공개',
        emphasis: '강조',
        data: '데이터 전환',
        navigate: '탐색',
        live: '실시간 갱신',
      }[m],
      purpose: '공통 모션 정의(motion.ts)를 그대로 보인다',
      data: ['step', 'state'],
      states: ['시작', '최종', '모션 축소'],
      operations: ['재생', '되감기'],
      motions: [`motion-${m}` as MotionId],
      colorRoles: [...BASE, 'accent-fill', 'highlight'],
    }),
  ),

  // 조합 — 수치와 시간
  combo(
    'combo-donut-sync',
    'chart-number',
    '도넛과 숫자 동기화',
    '호 길이와 중앙 숫자가 같은 값으로 함께 자란다',
    ['value', 'denominator', 'unit', 'source'],
    ['donut', 'stat-card'],
    {
      motions: ['motion-data'],
      states: ['0', '최종 값'],
      operations: ['재생'],
      colorRoles: [...BASE, 'accent-fill'],
    },
  ),
  combo(
    'combo-dot-grid',
    'compare-ratio',
    '분모 먼저 공개하는 100점 격자',
    '빈 100칸을 먼저 보이고 해당 칸을 채운다',
    ['value', 'denominator', 'source'],
    ['dot-grid'],
    {
      motions: ['motion-reveal'],
      states: ['분모', '채움'],
      operations: ['단계 이전과 다음'],
      colorRoles: [...BASE, 'accent-fill'],
    },
  ),
  combo(
    'combo-axis-band',
    'chart-number',
    '고정 축 구간 강조',
    '축과 곡선은 그대로 두고 구간 음영만 옮긴다',
    ['axis', 'value', 'label', 'focus'],
    ['trend-line'],
    {
      motions: ['motion-emphasis'],
      states: ['구간 n'],
      operations: ['구간 이동'],
      colorRoles: [...BASE, 'accent-fill', 'highlight'],
    },
  ),
  combo(
    'combo-trend-label',
    'chart-number',
    '추세선 끝 직접 라벨',
    '선 끝에 계열 이름과 마지막 값을 붙여 범례를 따로 보지 않게 한다',
    ['series', 'time', 'value', 'unit'],
    ['trend-line'],
    {
      motions: ['motion-reveal'],
      states: ['선', '선과 라벨'],
      operations: ['단계 이전과 다음'],
      colorRoles: [...BASE, ...SERIES.slice(0, 3)],
    },
  ),
  combo(
    'combo-formula',
    'chart-number',
    '산식, 가정, 결과 동시 표시',
    '계산식의 각 항과 가정을 결과와 한 화면에 둔다',
    ['value', 'unit', 'label', 'source'],
    ['stat-card', 'bar-horizontal'],
    { states: ['정지'], colorRoles: [...BASE, 'accent-text', 'accent-fill'] },
  ),
  combo(
    'combo-duration-deviation',
    'time-event',
    '전체 시간과 구간별 편차',
    '전체 길이와 계획 대비 구간 편차를 함께 보인다',
    ['duration', 'value', 'unit', 'label'],
    ['duration-bar'],
    { states: ['정지'], colorRoles: [...BASE, 'accent-fill', 'warning-fill', 'success-fill'] },
  ),
  combo(
    'combo-waveform',
    'time-event',
    '파형과 대사 동기화',
    '파형 위 현재 구간을 띄우고 그 구간 대사를 옆에 보인다',
    ['time', 'quote', 'focus'],
    ['line-highlight', 'timeline'],
    {
      motions: ['motion-emphasis'],
      states: ['구간 n'],
      operations: ['구간 이동'],
      colorRoles: [...BASE, 'accent-fill', 'highlight'],
    },
  ),

  // 조합 — 설명과 탐색
  combo(
    'combo-chapter-map',
    'slide-composition',
    '전체 지도와 현재 위치',
    '전체 챕터를 한 지도에 두고 지금 위치만 표시한다',
    ['step', 'label', 'focus'],
    ['slide-chapter', 'layer-stack'],
    {
      motions: ['motion-navigate'],
      states: ['현재 n'],
      operations: ['챕터 선택'],
      colorRoles: [...BASE, 'accent-fill', 'on-accent'],
    },
  ),
  combo(
    'combo-capture-zoom',
    'evidence-change',
    '원문 캡처 한 줄 확대',
    '원문 캡처는 그대로 두고 읽을 한 줄만 확대한다',
    ['quote', 'image', 'source', 'focus'],
    ['line-highlight', 'quote-card'],
    {
      motions: ['motion-emphasis'],
      states: ['전체', '확대'],
      operations: ['단계 이전과 다음'],
      colorRoles: [...BASE, 'highlight', 'accent-fill'],
    },
  ),
  combo(
    'combo-judgment-revision',
    'evidence-change',
    '최초 판단, 새 근거, 수정 판단',
    '처음 판단에 취소선을 긋고 새 근거와 바뀐 판단을 붙인다',
    ['before', 'after', 'source'],
    ['before-after', 'diff'],
    {
      motions: ['motion-data'],
      states: ['최초', '근거', '수정'],
      operations: ['단계 이전과 다음'],
      colorRoles: [...BASE, 'diff-removed-text', 'diff-added-text', 'accent-text'],
    },
  ),
  combo(
    'combo-fixed-reveal',
    'slide-composition',
    '고정 배치에서 변화만 공개',
    '배치는 그대로 두고 바뀐 칸만 차례로 채운다',
    ['step', 'label'],
    ['slide-list'],
    {
      motions: ['motion-reveal'],
      states: ['단계 n'],
      operations: ['단계 이전과 다음'],
      colorRoles: [...BASE, 'accent-fill'],
    },
  ),
  combo(
    'combo-branch-reveal',
    'flow-structure',
    '분기선과 도착점 동시 공개',
    '갈래 선과 그 끝 결과를 한 단위로 함께 보인다',
    ['node', 'relation', 'step'],
    ['flow', 'tree'],
    {
      motions: ['motion-reveal'],
      states: ['갈래 n'],
      operations: ['단계 이전과 다음'],
      colorRoles: [...BASE, 'accent-fill', 'series-2'],
    },
  ),
  combo(
    'combo-converge',
    'flow-structure',
    '여러 입력이 한 결과로 수렴',
    '입력 여럿이 한 결과로 모이는 흐름을 보인다',
    ['node', 'relation'],
    ['flow', 'hub'],
    {
      motions: ['motion-reveal'],
      states: ['입력', '결과'],
      operations: ['단계 이전과 다음'],
      colorRoles: [...BASE, 'accent-fill', 'series-2', 'series-3'],
    },
  ),
  combo(
    'combo-cycle-human',
    'flow-structure',
    '순환과 사람 개입 지점',
    '순환 경로에서 사람이 끼는 지점을 따로 표시한다',
    ['node', 'relation', 'focus'],
    ['cycle'],
    {
      motions: ['motion-reveal'],
      states: ['경로', '닫힘'],
      operations: ['단계 이전과 다음'],
      colorRoles: [...BASE, 'accent-fill', 'warning-text'],
    },
  ),
  combo(
    'combo-matrix-reveal',
    'state-matrix',
    '행과 열을 유지하는 셀 공개',
    '행과 열 머리는 처음부터 두고 셀만 차례로 채운다',
    ['label', 'group', 'state', 'step'],
    ['status-matrix'],
    {
      motions: ['motion-reveal'],
      states: ['셀 n'],
      operations: ['단계 이전과 다음'],
      colorRoles: [...BASE, ...STATUS],
    },
  ),
];

export const catalogById = (id: string): CatalogItem | undefined =>
  CATALOG.find((c) => c.id === id);
