import { GestaltPrinciple, type ResolutionDimension } from '../core/types.js';

interface PrincipleSelectionContext {
  roundNumber: number;
  dimensions: ResolutionDimension[];
  hasContradictions: boolean;
}

/**
 * Selects the next Gestalt principle to focus on during an interview.
 *
 * Algorithm:
 * - Continuity always overrides if contradictions are detected
 * - Early rounds (1-3): Closure-first (goal definition)
 * - Mid rounds (4-8): Proximity + Similarity (structuring)
 * - Late rounds (9+): Figure-Ground (prioritization)
 * - Dynamic: lowest clarity dimension gets priority
 */
export function selectNextPrinciple(context: PrincipleSelectionContext): GestaltPrinciple {
  const { roundNumber, dimensions, hasContradictions } = context;

  // Continuity always overrides when contradictions exist
  if (hasContradictions) {
    return GestaltPrinciple.CONTINUITY;
  }

  // If we have clarity data, target the weakest dimension
  if (dimensions.length > 0) {
    const weakest = findWeakestDimension(dimensions);
    if (weakest && weakest.clarity < 0.5) {
      return weakest.gestaltPrinciple;
    }
  }

  // Phase-based defaults
  if (roundNumber <= 3) {
    return GestaltPrinciple.CLOSURE;
  }
  if (roundNumber <= 8) {
    return roundNumber % 2 === 0
      ? GestaltPrinciple.PROXIMITY
      : GestaltPrinciple.SIMILARITY;
  }
  return GestaltPrinciple.FIGURE_GROUND;
}

function findWeakestDimension(
  dimensions: ResolutionDimension[],
): ResolutionDimension | null {
  if (dimensions.length === 0) return null;

  let weakest = dimensions[0]!;
  for (const dim of dimensions) {
    // Weight-adjusted: lower clarity in high-weight dimension is more critical
    const currentImpact = (1 - dim.clarity) * dim.weight;
    const weakestImpact = (1 - weakest.clarity) * weakest.weight;
    if (currentImpact > weakestImpact) {
      weakest = dim;
    }
  }
  return weakest;
}

export function getPrinciplePhaseLabel(roundNumber: number): string {
  if (roundNumber <= 3) return 'early (goal definition)';
  if (roundNumber <= 8) return 'mid (structuring)';
  return 'late (prioritization)';
}

export function getAllPrinciples(): GestaltPrinciple[] {
  return [
    GestaltPrinciple.CLOSURE,
    GestaltPrinciple.PROXIMITY,
    GestaltPrinciple.SIMILARITY,
    GestaltPrinciple.FIGURE_GROUND,
    GestaltPrinciple.CONTINUITY,
  ];
}
