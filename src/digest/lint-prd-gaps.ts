import { allBlocks, type PrdBlock, type PrdView } from './prd-schema.js';
import { verbatimFields } from './prd-match.js';
import { deriveReqMetric } from './render-prd-views.js';

/**
 * PRD 자체에 비어 있는 칸. lint 경고와 달리 세션이 고칠 일이 아니라 원문 작성자에게 알릴 일이다.
 * 그래서 validate의 warnings에 섞지 않고 gaps로 따로 내고 화면 패널에만 띄운다
 */

export const PRD_GAP_CODES = [
  'BASELINE_NO_NUMBER',
  'DUE_NOT_DATE',
  'TBD_PLACEHOLDER',
  'METRIC_UNLINKED',
  'REQUIREMENT_UNLINKED',
  'QUOTE_VIRTUAL',
  'DECISION_UNCONFIRMED',
  'OPEN_CLAIMS',
] as const;
export type PrdGapCode = (typeof PRD_GAP_CODES)[number];

export interface PrdGap {
  code: PrdGapCode;
  message: string;
  /** 걸린 블록. OPEN_CLAIMS는 여러 블록을 한 건으로 묶는다 */
  blockIds: string[];
  /** 블록 안 필드 경로. TBD_PLACEHOLDER에만 있다 */
  field?: string;
}

export const GAP_TITLE: Record<PrdGapCode, string> = {
  BASELINE_NO_NUMBER: '베이스라인에 숫자가 없는 지표',
  DUE_NOT_DATE: '기한이 날짜가 아닌 질문',
  TBD_PLACEHOLDER: '채우지 않은 TBD 자리',
  METRIC_UNLINKED: '어느 요구사항에도 안 걸린 지표',
  REQUIREMENT_UNLINKED: '연결된 지표가 없는 요구사항',
  QUOTE_VIRTUAL: '가상 화법 인용',
  DECISION_UNCONFIRMED: '아직 제안 단계인 결정',
  OPEN_CLAIMS: '상태가 미정인 주장',
};

const TBD = /\{\{\s*TBD[^}]*\}\}/i;
const DATE_LIKE = [/\d{4}-\d{1,2}-\d{1,2}/, /\d{1,2}\/\d{1,2}/, /\d{1,2}월\s*\d{1,2}일/, /D-\d+/];
const UNCONFIRMED = /제안|확인 필요/;

export const isDateLike = (s: string) => DATE_LIKE.some((re) => re.test(s));

function decisionText(b: Extract<PrdBlock, { kind: 'decision' }>): string {
  return [b.decided, b.why ?? ''].join('\n');
}

export function collectPrdGaps(view: PrdView): PrdGap[] {
  const gaps: PrdGap[] = [];
  const openClaims: string[] = [];
  for (const { block } of allBlocks(view)) {
    for (const f of verbatimFields(block)) {
      if (TBD.test(f.text)) {
        gaps.push({
          code: 'TBD_PLACEHOLDER',
          message: `${block.id}.${f.field}에 TBD 자리표시가 남아 있다`,
          blockIds: [block.id],
          field: f.field,
        });
      }
    }
    switch (block.kind) {
      case 'metric':
        if (!block.baseline || !/\d/.test(block.baseline)) {
          gaps.push({
            code: 'BASELINE_NO_NUMBER',
            message: `${block.metricId} 베이스라인이 ${block.baseline ? `"${block.baseline}"` : '비어 있다'}`,
            blockIds: [block.id],
          });
        }
        break;
      case 'question':
        if (!block.due || !isDateLike(block.due)) {
          gaps.push({
            code: 'DUE_NOT_DATE',
            message: block.due ? `기한 "${block.due}"가 날짜 꼴이 아니다` : '기한이 없다',
            blockIds: [block.id],
          });
        }
        break;
      case 'quote':
        if (block.origin === 'virtual') {
          gaps.push({
            code: 'QUOTE_VIRTUAL',
            message: '실제 유저 목소리가 아니라 지어낸 화법이다',
            blockIds: [block.id],
          });
        }
        break;
      case 'decision':
        if (UNCONFIRMED.test(decisionText(block))) {
          gaps.push({
            code: 'DECISION_UNCONFIRMED',
            message: '결정 글에 "제안"이나 "확인 필요"가 있다',
            blockIds: [block.id],
          });
        }
        break;
      case 'claim':
        if (block.status === 'open') openClaims.push(block.id);
        break;
    }
  }
  const matrix = deriveReqMetric(view);
  if (matrix) {
    for (const m of matrix.metrics) {
      if (matrix.unlinkedMetrics.includes(m.metricId)) {
        gaps.push({
          code: 'METRIC_UNLINKED',
          message: `${m.metricId}를 쓰는 요구사항이 없다`,
          blockIds: [m.id],
        });
      }
    }
    for (const id of matrix.unlinkedRequirements) {
      gaps.push({
        code: 'REQUIREMENT_UNLINKED',
        message: '연결된 지표가 없다',
        blockIds: [id],
      });
    }
  }
  if (openClaims.length) {
    gaps.push({
      code: 'OPEN_CLAIMS',
      message: `상태가 미정인 주장 ${openClaims.length}개`,
      blockIds: openClaims,
    });
  }
  // 코드 순서로 묶어 둬야 패널과 응답이 같은 순서로 읽힌다
  return gaps.sort((a, b) => PRD_GAP_CODES.indexOf(a.code) - PRD_GAP_CODES.indexOf(b.code));
}
