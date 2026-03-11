import {
  GestaltPrinciple,
  type AmbiguityScore,
  type AmbiguityDimension,
  type ProjectType,
} from '../core/types.js';
import {
  GREENFIELD_WEIGHTS,
  BROWNFIELD_WEIGHTS,
  AMBIGUITY_THRESHOLD,
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

export function computeAmbiguityScore(
  raw: RawClarityScores,
  projectType: ProjectType,
): AmbiguityScore {
  const weights =
    projectType === 'greenfield' ? GREENFIELD_WEIGHTS : BROWNFIELD_WEIGHTS;

  const dimensions: AmbiguityDimension[] = [
    {
      name: 'goalClarity',
      clarity: clamp(raw.goalClarity),
      weight: weights[GestaltPrinciple.CLOSURE],
      gestaltPrinciple: GestaltPrinciple.CLOSURE,
    },
    {
      name: 'constraintClarity',
      clarity: clamp(raw.constraintClarity),
      weight: weights[GestaltPrinciple.PROXIMITY],
      gestaltPrinciple: GestaltPrinciple.PROXIMITY,
    },
    {
      name: 'successCriteria',
      clarity: clamp(raw.successCriteria),
      weight: weights[GestaltPrinciple.SIMILARITY],
      gestaltPrinciple: GestaltPrinciple.SIMILARITY,
    },
    {
      name: 'priorityClarity',
      clarity: clamp(raw.priorityClarity),
      weight: weights[GestaltPrinciple.FIGURE_GROUND],
      gestaltPrinciple: GestaltPrinciple.FIGURE_GROUND,
    },
  ];

  if (projectType === 'brownfield' && raw.contextClarity !== undefined) {
    dimensions.push({
      name: 'contextClarity',
      clarity: clamp(raw.contextClarity),
      weight: weights[GestaltPrinciple.CONTINUITY],
      gestaltPrinciple: GestaltPrinciple.CONTINUITY,
    });
  }

  const weightedSum = dimensions.reduce(
    (sum, d) => sum + d.clarity * d.weight,
    0,
  );

  const continuityPenalty = computeContinuityPenalty(raw.contradictions);

  const overall = clamp(1.0 - weightedSum + continuityPenalty);

  return {
    overall,
    dimensions,
    isReady: overall <= AMBIGUITY_THRESHOLD,
  };
}

function computeContinuityPenalty(contradictions: string[]): number {
  if (contradictions.length === 0) return 0;
  const penalty =
    CONTINUITY_PENALTY_MIN +
    (CONTINUITY_PENALTY_MAX - CONTINUITY_PENALTY_MIN) *
      Math.min(contradictions.length / 3, 1);
  return penalty;
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}
