import {
  GestaltPrinciple,
  type ResolutionScore,
  type ResolutionDimension,
  type ProjectType,
} from '../core/types.js';
import {
  GREENFIELD_WEIGHTS,
  BROWNFIELD_WEIGHTS,
  RESOLUTION_THRESHOLD,
  CONTINUITY_PENALTY_MIN,
  CONTINUITY_PENALTY_MAX,
} from '../core/constants.js';

interface RawClarityScores {
  /** 목표 명확도: 프로젝트의 목표가 얼마나 완전하게 정의되었는가 (Closure) */
  goalClarity: number;
  /** 제약사항 명확도: 제약사항이 얼마나 잘 구조화되고 그룹핑되었는가 (Proximity) */
  constraintClarity: number;
  /** 성공 기준 명확도: 성공 기준의 패턴이 일관적이고 측정 가능한가 (Similarity) */
  successCriteria: number;
  /** 우선순위 명확도: MVP와 후순위가 명확히 분리되었는가 (Figure-Ground) */
  priorityClarity: number;
  /** 맥락 명확도: 기존 시스템과의 일관성에 모순이 없는가 (Continuity, Brownfield 전용) */
  contextClarity?: number;
  /** 인터뷰 중 감지된 모순 목록 */
  contradictions: string[];
}

export function computeResolutionScore(
  raw: RawClarityScores,
  projectType: ProjectType,
): ResolutionScore {
  const weights = projectType === 'greenfield' ? GREENFIELD_WEIGHTS : BROWNFIELD_WEIGHTS;

  const dimensions: ResolutionDimension[] = [
    {
      name: 'goalClarity',
      clarity: clamp(raw.goalClarity),
      weight: weights[GestaltPrinciple.CLOSURE],
      gestaltPrinciple: GestaltPrinciple.CLOSURE,
      label: '목표 명확성',
      improvementHint: '프로젝트의 최종 목표와 기대 결과물을 구체적으로 서술해 주세요.',
    },
    {
      name: 'constraintClarity',
      clarity: clamp(raw.constraintClarity),
      weight: weights[GestaltPrinciple.PROXIMITY],
      gestaltPrinciple: GestaltPrinciple.PROXIMITY,
      label: '제약사항 명확성',
      improvementHint: '기술 스택, 예산, 기한, 팀 규모 등 구체적인 제약 조건을 명시해 주세요.',
    },
    {
      name: 'successCriteria',
      clarity: clamp(raw.successCriteria),
      weight: weights[GestaltPrinciple.SIMILARITY],
      gestaltPrinciple: GestaltPrinciple.SIMILARITY,
      label: '성공 기준 명확성',
      improvementHint: '측정 가능한 성공 지표(KPI, 수치 목표 등)를 추가해 주세요.',
    },
    {
      name: 'priorityClarity',
      clarity: clamp(raw.priorityClarity),
      weight: weights[GestaltPrinciple.FIGURE_GROUND],
      gestaltPrinciple: GestaltPrinciple.FIGURE_GROUND,
      label: '우선순위 명확성',
      improvementHint: 'MVP 필수 기능과 추후 개선 사항을 명확히 구분해 주세요.',
    },
  ];

  if (projectType === 'brownfield' && raw.contextClarity !== undefined) {
    dimensions.push({
      name: 'contextClarity',
      clarity: clamp(raw.contextClarity),
      weight: weights[GestaltPrinciple.CONTINUITY],
      gestaltPrinciple: GestaltPrinciple.CONTINUITY,
      label: '맥락 일관성',
      improvementHint:
        '기존 시스템과의 연계 방식, 마이그레이션 전략, 호환성 요구사항을 구체적으로 설명해 주세요.',
    });
  }

  const weightedSum = dimensions.reduce((sum, d) => sum + d.clarity * d.weight, 0);

  const continuityPenalty = computeContinuityPenalty(raw.contradictions);

  const overall = clamp(weightedSum - continuityPenalty);

  return {
    overall,
    dimensions,
    isReady: overall >= RESOLUTION_THRESHOLD,
  };
}

function computeContinuityPenalty(contradictions: string[]): number {
  if (contradictions.length === 0) return 0;
  const penalty =
    CONTINUITY_PENALTY_MIN +
    (CONTINUITY_PENALTY_MAX - CONTINUITY_PENALTY_MIN) * Math.min(contradictions.length / 3, 1);
  return penalty;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
