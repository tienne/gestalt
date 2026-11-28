/**
 * 공통 모션 여섯 종류. 모션은 데이터에 명시된 상태를 바꾸는 수단이라 상태마다 무엇을 남기고 무엇을 움직이는지 정한다.
 * 모션 축소(prefers-reduced-motion)나 정지 출력(인쇄, PDF)에서는 최종 상태를 바로 그린다.
 */

export type MotionId =
  | 'motion-enter'
  | 'motion-reveal'
  | 'motion-emphasis'
  | 'motion-data'
  | 'motion-navigate'
  | 'motion-live';

export interface MotionSpec {
  id: MotionId;
  name: string;
  /** 언제 시작하는가 */
  trigger: string;
  start: string;
  end: string;
  /** 상태가 바뀌어도 자리를 지키는 것. 축, 레이블, 배치 */
  keep: string[];
  /** 움직이는 대상 */
  moving: string[];
  /** 움직임을 줄였을 때 보이는 것과 남는 조작 */
  reduced: string;
  /** 반복, 되감기, 이벤트 추가를 어떻게 다루는가 */
  replay: string;
  /** 지속 시간과 이징. CSS 변수 이름과 값 */
  timing: { duration: string; easing: string; stagger?: string };
  /** 기존 제품에서 같은 일을 하는 자리 */
  existing: string[];
}

export const MOTION_TOKENS = {
  '--gestalt-motion-fast': '160ms',
  '--gestalt-motion-base': '280ms',
  '--gestalt-motion-slow': '800ms',
  '--gestalt-motion-stagger': '80ms',
  '--gestalt-ease-enter': 'cubic-bezier(0.16, 1, 0.3, 1)',
  '--gestalt-ease-move': 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

export const MOTIONS: MotionSpec[] = [
  {
    id: 'motion-enter',
    name: '진입',
    trigger: '장표가 현재 장이 되거나 카드가 화면에 35% 이상 들어올 때 한 번',
    start: '요소가 아래로 12px 내려가 투명한 상태',
    end: '요소가 제자리에 완전히 보이는 상태',
    keep: ['장표 머리와 꼬리', '읽는 순서(--i 차례)'],
    moving: ['제목', '본문 블록', '도식 노드'],
    reduced: '처음부터 최종 상태로 그린다. 순서는 문서 순서로 읽힌다',
    replay: '다시 재생 버튼이 시작 상태로 되돌렸다가 같은 차례로 다시 띄운다',
    timing: {
      duration: '--gestalt-motion-base',
      easing: '--gestalt-ease-enter',
      stagger: '--gestalt-motion-stagger',
    },
    existing: ['Presentation data-anim, data-delay', 'Digest .armed/.play 카드 진입'],
  },
  {
    id: 'motion-reveal',
    name: '순차 공개',
    trigger: '클릭, 다음 버튼, 오른쪽 화살표, 단계 슬라이더',
    start: '전체 틀(축, 격자, 노드 자리)은 보이고 공개할 항목은 흐리거나 숨긴 상태',
    end: '모든 항목이 보이고 마지막 항목이 강조된 상태',
    keep: ['축과 눈금', '격자 윤곽', '노드 배치', '이미 공개한 항목'],
    moving: ['다음 차례 항목', '연결선과 도착점(한 단위로 함께)'],
    reduced:
      '단계 버튼과 위치 표시(단계 n / N)는 그대로 남고 항목은 전환 없이 바로 바뀐다. 정지 출력은 최종 단계다',
    replay: '이전 버튼과 왼쪽 화살표로 되감는다. 처음 단계에서 이전은 aria-disabled가 된다',
    timing: { duration: '--gestalt-motion-base', easing: '--gestalt-ease-enter' },
    existing: [
      'Lens 단계 버튼과 정수 슬라이더',
      'Presentation 클릭 공개(fragment)',
      '분기 공개 조합(combo-branch-reveal)',
    ],
  },
  {
    id: 'motion-emphasis',
    name: '강조',
    trigger: '설명 차례가 바뀌거나 사용자가 항목에 초점을 둘 때',
    start: '모든 항목이 같은 무게로 보이는 상태',
    end: '강조 대상만 강조 채움과 라벨을 갖고 나머지는 보조 글자색으로 낮아진 상태',
    keep: ['막대와 셀의 위치', '값 라벨', '범례'],
    moving: ['강조 색', '테두리', '음영 구간'],
    reduced: '색과 테두리가 바로 바뀌고 강조 대상 이름이 라벨로 함께 붙는다',
    replay: '강조 대상을 다시 고르면 이전 강조가 풀린다',
    timing: { duration: '--gestalt-motion-fast', easing: '--gestalt-ease-move' },
    existing: [
      'Architecture 이웃 강조',
      'Digest 허브 focus, 격자 picked',
      '축과 구간 음영 조합(combo-axis-band)',
    ],
  },
  {
    id: 'motion-data',
    name: '데이터 전환',
    trigger: '조건 토글, 카운트업 시작, 판단 갱신',
    start: '이전 값(또는 0)과 그 값의 라벨',
    end: '새 값과 그 값의 라벨, 출처',
    keep: ['축 눈금과 분모', '항목 순서', '단위 표기'],
    moving: ['막대 길이', '호 길이', '숫자'],
    reduced: '최종 값을 바로 쓴다. 카운트업 없이 분자와 분모가 처음부터 보인다',
    replay: '토글을 다시 누르면 이전 값으로 돌아간다. 원문 측정값만 쓰고 사이 값은 만들지 않는다',
    timing: { duration: '--gestalt-motion-slow', easing: '--gestalt-ease-move' },
    existing: [
      'Lens 막대 전환(toggleBars)',
      'Execute Evolution 추세선',
      '도넛과 숫자 동기화 조합(combo-donut-sync)',
    ],
  },
  {
    id: 'motion-navigate',
    name: '탐색',
    trigger: '목차, 지도 칸, 검색 결과를 고르거나 확대와 이동을 할 때',
    start: '전체 지도와 이전 위치',
    end: '같은 지도에서 현재 위치만 테두리와 라벨로 표시된 상태',
    keep: ['지도 배치', '범례', '키보드 초점'],
    moving: ['현재 위치 표시', '화면 이동'],
    reduced: '스크롤과 이동이 즉시 일어나고 현재 위치는 aria-current로 알린다',
    replay: '뒤로 가기나 이전 위치 버튼이 이전 상태를 복원한다',
    timing: { duration: '--gestalt-motion-base', easing: '--gestalt-ease-move' },
    existing: [
      'Architecture, Code Graph 확대와 이동',
      'Digest 목차와 시간 링크',
      '챕터 지도 조합(combo-chapter-map)',
    ],
  },
  {
    id: 'motion-live',
    name: '실시간 갱신',
    trigger: '새 이벤트가 들어올 때',
    start: '기존 이벤트 목록과 읽던 위치, 선택',
    end: '새 이벤트가 끝에 붙고 읽던 위치와 선택은 그대로인 상태',
    keep: ['읽던 스크롤 위치', '선택한 항목', '이벤트 순서'],
    moving: ['새 행의 짧은 하이라이트'],
    reduced: '하이라이트 없이 행만 붙고 새 항목 수를 라이브 영역에 알린다',
    replay: '이벤트는 시간순으로만 쌓인다. 되감기는 하지 않고 필터로 좁힌다',
    timing: { duration: '--gestalt-motion-slow', easing: '--gestalt-ease-move' },
    existing: ['Peer 도구 호출과 메시지', 'Conductor 작업 회차 타임라인'],
  },
];

export const motionById = (id: string): MotionSpec | undefined => MOTIONS.find((m) => m.id === id);
