import type {
  Spec,
  TaskExecutionResult,
  DriftScore,
  DriftDimension,
  AtomicTask,
} from '../core/types.js';
import { DRIFT_WEIGHTS } from '../core/constants.js';

/**
 * Drift Detection — 태스크 실행 결과가 원래 Spec에서 얼마나 벗어났는지 측정.
 *
 * 3차원 가중합:
 *   Goal Drift (Jaccard, 50%) — 태스크 output이 Spec goal의 핵심 키워드와 얼마나 일치하는지
 *   Constraint Drift (violations×0.1, 30%) — 태스크 output이 constraint 위반 가능성
 *   Ontology Drift (Jaccard, 20%) — 태스크가 ontology entity/relation을 참조하는지
 */
export function measureDrift(
  spec: Spec,
  _task: AtomicTask,
  taskResult: TaskExecutionResult,
  driftThreshold: number,
): DriftScore {
  const goalDimension = measureGoalDrift(spec, taskResult);
  const constraintDimension = measureConstraintDrift(spec, taskResult);
  const ontologyDimension = measureOntologyDrift(spec, taskResult);

  const dimensions: DriftDimension[] = [goalDimension, constraintDimension, ontologyDimension];

  const overall =
    goalDimension.score * DRIFT_WEIGHTS.goal +
    constraintDimension.score * DRIFT_WEIGHTS.constraint +
    ontologyDimension.score * DRIFT_WEIGHTS.ontology;

  return {
    taskId: taskResult.taskId,
    overall: Math.round(overall * 1000) / 1000,
    dimensions,
    thresholdExceeded: overall > driftThreshold,
  };
}

/**
 * Goal Drift: 1 - Jaccard(goalTokens, outputTokens)
 * 높은 값 = 더 많은 drift
 */
function measureGoalDrift(spec: Spec, result: TaskExecutionResult): DriftDimension {
  const goalTokens = tokenize(spec.goal);
  const outputTokens = tokenize(result.output);

  const jaccard = jaccardSimilarity(goalTokens, outputTokens);
  const score = 1 - jaccard;

  return {
    name: 'goal',
    score: Math.round(score * 1000) / 1000,
    detail: `Goal-output Jaccard similarity: ${jaccard.toFixed(3)}`,
  };
}

/**
 * Constraint Drift: violations × 0.1 (capped at 1.0)
 * 각 constraint의 키워드가 output에 전혀 없으면 violation 가능성으로 간주
 */
function measureConstraintDrift(spec: Spec, result: TaskExecutionResult): DriftDimension {
  if (spec.constraints.length === 0) {
    return { name: 'constraint', score: 0, detail: 'No constraints defined' };
  }

  const outputTokens = tokenize(result.output);
  let violations = 0;

  for (const constraint of spec.constraints) {
    const constraintTokens = tokenize(constraint);
    const overlap = jaccardSimilarity(constraintTokens, outputTokens);
    if (overlap < 0.1) {
      violations++;
    }
  }

  const score = Math.min(violations * 0.1, 1.0);
  return {
    name: 'constraint',
    score: Math.round(score * 1000) / 1000,
    detail: `${violations}/${spec.constraints.length} constraints with low output overlap`,
  };
}

/**
 * Ontology Drift: 1 - Jaccard(ontologyTerms, outputTokens)
 * 태스크가 ontology에 정의된 entity/relation 용어를 얼마나 참조하는지
 */
function measureOntologyDrift(spec: Spec, result: TaskExecutionResult): DriftDimension {
  const ontologyTerms = new Set<string>();
  for (const entity of spec.ontologySchema.entities) {
    ontologyTerms.add(entity.name.toLowerCase());
    for (const attr of entity.attributes) {
      ontologyTerms.add(attr.toLowerCase());
    }
  }
  for (const rel of spec.ontologySchema.relations) {
    ontologyTerms.add(rel.type.toLowerCase());
  }

  if (ontologyTerms.size === 0) {
    return { name: 'ontology', score: 0, detail: 'No ontology terms defined' };
  }

  const outputTokens = tokenize(result.output);
  const jaccard = jaccardSimilarity(ontologyTerms, outputTokens);
  const score = 1 - jaccard;

  return {
    name: 'ontology',
    score: Math.round(score * 1000) / 1000,
    detail: `Ontology-output Jaccard similarity: ${jaccard.toFixed(3)}`,
  };
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
