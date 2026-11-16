import type { PrdGap } from './lint-prd-gaps.js';
import type { PrdBlock, RequirementSlot } from './prd-schema.js';

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

function title(block: PrdBlock): string {
  switch (block.kind) {
    case 'requirement':
      return block.title;
    case 'metric':
      return block.name;
    case 'question':
      return block.item;
    case 'decision':
      return block.decided;
    case 'claim':
    case 'quote':
    case 'prose':
    case 'callout':
    case 'risk':
      return block.text;
    default:
      return block.id;
  }
}

/** 빈칸 인터뷰가 화면 없이도 질문을 가져갈 수 있도록 진단 코드에서 문장을 만든다 */
export function prdGapQuestion(
  gap: Omit<PrdGap, 'question'>,
  blocks: ReadonlyMap<string, PrdBlock>,
): string {
  const names = gap.blockIds
    .map((id) => blocks.get(id))
    .filter((b): b is PrdBlock => Boolean(b))
    .map(title);
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
      return `${label}의 ${gap.field ?? '미정'} 칸에는 어떤 내용을 채우면 되나요?`;
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
