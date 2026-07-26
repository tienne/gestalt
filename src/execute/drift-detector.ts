import type {
  Spec,
  TaskExecutionResult,
  DriftScore,
  DriftDimension,
  AtomicTask,
} from '../core/types.js';
import type { EmbeddingProvider } from '../code-graph/embedding-provider.js';
import { DRIFT_WEIGHTS } from '../core/constants.js';
import { log } from '../core/log.js';

/**
 * Drift Detection — 태스크 실행 결과가 원래 Spec에서 얼마나 벗어났는지 측정.
 *
 * 3차원 가중합:
 *   Goal Drift (임베딩 코사인 유사도, 50%) — 태스크 output이 Spec goal과 의미적으로 얼마나 정렬되는지
 *   Constraint Drift (violations×0.1, 30%) — 태스크 output이 constraint 위반 가능성
 *   Ontology Drift (Jaccard, 20%) — 태스크가 ontology entity/relation을 참조하는지
 *
 * Goal Drift는 원래 문장 단위 Jaccard 유사도(단어 집합 교집합/합집합)를 썼으나, 문장 간
 * Jaccard는 공유 단어 수에 좌우되어 구조적으로 낮게 나오는 경향이 있다 — 목표와 의미적으로
 * 잘 정렬된 산출물조차 거의 항상 임계값을 넘기는 문제가 있었다. 로컬 임베딩(Xenova/all-MiniLM-L6-v2)
 * 기반 코사인 유사도로 교체해 의미적 정렬을 측정한다(임베딩 로딩 실패 시 Jaccard로 폴백).
 */
export async function measureDrift(
  spec: Spec,
  _task: AtomicTask,
  taskResult: TaskExecutionResult,
  driftThreshold: number,
): Promise<DriftScore> {
  const goalDimension = await measureGoalDrift(spec, taskResult);
  const constraintDimension = measureConstraintDrift(spec, taskResult);
  const ontologyDimension = measureOntologyDrift(spec, taskResult);

  const dimensions: DriftDimension[] = [goalDimension, constraintDimension, ontologyDimension];

  const overall =
    goalDimension.score * DRIFT_WEIGHTS.goal +
    constraintDimension.score * DRIFT_WEIGHTS.constraint +
    ontologyDimension.score * DRIFT_WEIGHTS.ontology;

  const roundedOverall = Math.round(overall * 1000) / 1000;

  let status: 'OK' | 'WARNING' | 'CRITICAL';
  if (roundedOverall < driftThreshold * 0.5) {
    status = 'OK';
  } else if (roundedOverall < driftThreshold) {
    status = 'WARNING';
  } else {
    status = 'CRITICAL';
  }

  const hint =
    status === 'OK'
      ? ''
      : '스펙과의 편차가 감지되었습니다. evolve_patch로 스펙을 수정하거나 계속 진행하세요.';

  return {
    taskId: taskResult.taskId,
    overall: roundedOverall,
    dimensions,
    thresholdExceeded: overall > driftThreshold,
    status,
    threshold: driftThreshold,
    hint,
  };
}

/**
 * Goal Drift: 1 - cosine(embed(goal), embed(output))
 * 높은 값 = 더 많은 drift. 임베딩 로딩/추론이 실패하면 Jaccard 기반으로 폴백한다.
 */
async function measureGoalDrift(spec: Spec, result: TaskExecutionResult): Promise<DriftDimension> {
  try {
    const provider = await getEmbeddingProvider();
    const [goalVector, outputVector] = await provider.embed([spec.goal, result.output]);
    if (!goalVector || !outputVector) throw new Error('embedding provider returned no vectors');

    const similarity = cosineSimilarity(goalVector, outputVector);
    const score = Math.min(1, Math.max(0, 1 - similarity));

    return {
      name: 'goal',
      score: Math.round(score * 1000) / 1000,
      detail: `Goal-output embedding cosine similarity: ${similarity.toFixed(3)}`,
    };
  } catch (e) {
    log(
      `Goal drift: embedding similarity failed, falling back to Jaccard — ${e instanceof Error ? e.message : String(e)}`,
    );
    return measureGoalDriftJaccardFallback(spec, result);
  }
}

function measureGoalDriftJaccardFallback(spec: Spec, result: TaskExecutionResult): DriftDimension {
  const goalTokens = tokenize(spec.goal);
  const outputTokens = tokenize(result.output);

  const jaccard = jaccardSimilarity(goalTokens, outputTokens);
  const score = 1 - jaccard;

  return {
    name: 'goal',
    score: Math.round(score * 1000) / 1000,
    detail: `Goal-output Jaccard similarity (embedding fallback): ${jaccard.toFixed(3)}`,
  };
}

// ─── Embedding provider (lazy singleton) ──────────────────────────

let embeddingProviderPromise: Promise<EmbeddingProvider> | null = null;

/**
 * LocalEmbeddingProvider를 lazy-load하고 프로세스 내에서 재사용한다.
 * 최초 호출 시 모델 로딩 비용이 있으므로 이후 호출은 캐시된 인스턴스를 공유한다.
 */
function getEmbeddingProvider(): Promise<EmbeddingProvider> {
  if (!embeddingProviderPromise) {
    embeddingProviderPromise = import('../code-graph/providers/local-embedding.js').then(
      (m) => new m.LocalEmbeddingProvider(),
    );
  }
  return embeddingProviderPromise;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
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
