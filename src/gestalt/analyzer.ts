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
  goalClarity: number;
  constraintClarity: number;
  successCriteria: number;
  priorityClarity: number;
  contextClarity?: number;
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
