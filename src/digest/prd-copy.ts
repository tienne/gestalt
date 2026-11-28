import type { PrdGap } from './lint-prd-gaps.js';
import type { Audience, BlockKind, BlockOf, PrdBlock, RequirementSlot } from './prd-schema.js';

export const SLOT_NAMES: Record<RequirementSlot, string> = {
  precondition: '선행조건',
  trigger: '트리거',
  behavior: '동작',
  result: '결과',
  exception: '예외',
  display: '표시',
  permission: '권한',
  businessRule: '비즈니스 규칙',
  data: '데이터',
};

const FIELD_NAMES: Record<string, string> = {
  text: '본문',
  title: '제목',
  detail: '설명',
  why: '이유',
  boundary: '경계',
  priority: '중요도',
  acceptance: '수용 기준',
  name: '지표 이름',
  denominator: '분모',
  baseline: '현재 기준값',
  target: '목표',
  measure: '측정 방법',
  decided: '결정',
  rejected: '버린 안',
  response: '대응',
  item: '질문',
  owner: '담당',
  due: '기한',
  labels: '비교 대상',
  rows: '표의 행',
  cols: '표의 열',
  cells: '표 내용',
  out: '범위 밖',
  by: '인용 출처',
  steps: '단계',
  items: '일정',
  terms: '용어',
};

function fieldLabel(field: string | undefined): string {
  const [root, slot] = field?.split('.') ?? [];
  if (root === 'slots') return SLOT_NAMES[slot as RequirementSlot] ?? '개발 준비';
  return FIELD_NAMES[root ?? ''] ?? '내용';
}

/** 링크와 빈칸 질문에 블록 ID 대신 원문 제목이나 내용을 쓴다. */
export function prdBlockTitle(block: PrdBlock): string {
  if ('title' in block) return block.title;
  if ('name' in block) return block.name;
  if ('item' in block) return block.item;
  if ('decided' in block) return block.decided;
  if ('text' in block) return block.text;
  if (block.kind === 'compare') return block.labels.join(' / ');
  if (block.kind === 'scope') return block.out.join(', ');
  if (block.kind === 'flow') return block.steps.join(' → ');
  if (block.kind === 'timeline') return block.items.map((i) => i.what).join(', ');
  if (block.kind === 'glossary') return block.terms.map((t) => t.term).join(', ');
  return block.rows.join(', ');
}

/** 빈칸 인터뷰가 화면 없이도 질문을 가져갈 수 있도록 진단 코드에서 문장을 만든다 */
export function prdGapQuestion(
  gap: Omit<PrdGap, 'question'>,
  blocks: ReadonlyMap<string, PrdBlock>,
): string {
  const names = gap.blockIds
    .map((id) => blocks.get(id))
    .filter((b): b is PrdBlock => Boolean(b))
    .map(prdBlockTitle);
  const name = names.slice(0, 3).join(', ') + (names.length > 3 ? ` 외 ${names.length - 3}개` : '');
  const label = `"${name}"`;
  switch (gap.code) {
    case 'ACCEPTANCE_MISSING':
      return `${label}의 완료 기준은 무엇인가요?`;
    case 'SLOTS_INCOMPLETE':
      return `${label}의 ${gap.missingSlots?.map((key) => SLOT_NAMES[key]).join(', ')} 칸에는 어떤 내용이 필요한가요?`;
    case 'BASELINE_NO_NUMBER':
      return `${label}의 현재 기준값은 얼마인가요?`;
    case 'TARGET_UNDECIDED':
      return `${label}의 목표는 얼마인가요?`;
    case 'DUE_NOT_DATE':
      return `${label}의 결정 기한은 언제인가요?`;
    case 'TBD_PLACEHOLDER':
      return `${label}의 ${fieldLabel(gap.field)} 칸에는 어떤 내용을 채우면 되나요?`;
    case 'METRIC_UNLINKED':
      return `${label}의 변화는 어떤 요구사항과 연결되나요?`;
    case 'REQUIREMENT_UNLINKED':
      return `${label}의 성과는 어떤 지표로 판단하나요?`;
    case 'QUOTE_VIRTUAL':
      return `${label}의 근거가 되는 실제 사용자 목소리가 있나요?`;
    case 'DECISION_UNCONFIRMED':
      return `${label}의 결정은 확정됐나요?`;
    case 'OPEN_CLAIMS':
      return `${label}의 내용을 확정하려면 무엇을 확인해야 하나요?`;
  }
}

export const PRD_TABS = [
  ['prd', 'PRD', '▤'],
  ['spec', '기능명세서', '▦'],
  ['metrics', '지표', '◷'],
  ['decisions', '결정과 미확정', '◇'],
  ['review', '검수', '✓'],
] as const;

export const PRD_COPY = {
  summary: '요약',
  unresolved: '미확정',
  openClaim: '미정 주장',
  linked: '연결',
  unlinkedMetrics: '연결 지표 없음',
  unlinkedRequirements: '연결 요구사항 없음',
  rejected: '버린 안',
  requirementsMetrics: '요구사항과 지표',
  overview: '모아 보기',
  boundaryLabel: '경계',
  whyLabel: '가설',
  response: '대응',
  reason: '이유',
  all: '전체',
  directory: '디렉토리',
  cards: '카드',
  graph: '그래프',
  graphHint: '그래프 보기는 준비 중이에요',
  later: '이후',
  source: '원문 줄',
  theme: '테마',
  audience: '대상별 보기',
  toc: '목차',
  document: '문서 정보',
  roles: '읽는 사람',
  platforms: '플랫폼',
  requirements: '요구사항',
  features: '기능',
  metrics: '지표',
  gaps: '빈칸',
  coverage: '원문 반영',
  omitted: '일부러 옮기지 않은 구간',
  description: '설명',
  why: '기능의 근거',
  boundary: '범위와 경계',
  priority: '중요도',
  linkedMetrics: '연결 지표',
  acceptance: '수용 기준',
  questions: '걸린 미확정 질문',
  slots: '개발 준비',
  missing: '원문에 없음',
  ready: '걸린 미확정 질문 없음',
  ownerMissing: '담당을 정해 주세요',
  dueMissing: '기한을 정해 주세요',
  responseMissing: '대응을 정해 주세요',
  decision: '결정',
  confirmed: '확정',
  unconfirmed: '확인 필요',
  owner: '담당',
  due: '기한',
  previous: '이전',
  next: '다음',
  go: '해당 자리로',
  blockers: '막힘',
  needed: '채워야 함',
  reference: '참고',
  prose: '문장',
  empty: '이 보기에 해당하는 내용이 없어요',
  emptyReview: '이 묶음에 검수할 내용이 없어요',
  noSubject: '누가 하는 동작인지 적어 주세요',
  noBoundary: '기능의 경계를 적어 주세요',
  ambiguous: '동작 조건을 구체적으로 적어 주세요',
  noResponse: '위험에 어떻게 대응하나요?',
  longSentence: '긴 문장을 나눌 수 있는지 살펴봐 주세요',
  aiTell: '문장 표현을 살펴봐 주세요',
  primary: '핵심',
  secondary: '보조',
  guardrail: '가드레일',
  unclassified: '분류 없음',
  denominator: '분모',
  baseline: '기준값',
  target: '목표',
  measure: '측정 방법',
  movingRequirements: '움직이는 요구사항',
  linkedRequirements: '걸린 요구사항',
  coverageEmpty: '원문 내용 줄이 없어요',
  uncovered: '빠진 원문 줄',
  line: '원문',
  phase: '단계',
  id: 'ID',
} as const;

export const KIND_LABEL: Record<BlockKind, string> = {
  claim: '주장',
  risk: '리스크',
  requirement: '요구사항',
  metric: '지표',
  decision: '결정',
  question: '질문',
  prose: '본문',
  compare: '비교',
  scope: '안 하는 것',
  quote: '인용',
  flow: '흐름',
  stateMatrix: '상태 표',
  timeline: '일정',
  glossary: '용어',
  callout: '강조',
};

export const QUOTE_LABEL: Record<BlockOf<'quote'>['origin'], string> = {
  voc: '실제 VOC',
  virtual: '가상 화법',
  unknown: '출처 모름',
};
export const TONE_LABEL: Record<BlockOf<'callout'>['tone'], string> = {
  info: '참고',
  warn: '주의',
  danger: '위험',
};

export const CLAIM_LABEL: Record<BlockOf<'claim'>['status'], string> = {
  confirmed: '확정',
  assumed: '가정',
  open: '미정',
};
export const PHASE_LABEL: Record<NonNullable<BlockOf<'requirement'>['phase']>, string> = {
  mvp: 'MVP',
  later: '이후',
};
export const ROLE_LABEL: Record<NonNullable<BlockOf<'metric'>['role']>, string> = {
  primary: '주 지표',
  secondary: '보조 지표',
  guardrail: '가드레일',
};
export const AUDIENCE_LABEL: Record<Audience, string> = {
  pm: 'PM',
  dev: '개발',
  design: '디자인',
  qa: 'QA',
  data: '데이터',
};
