import type { Spec, SpecPatch, SpecDelta } from '../core/types.js';

/**
 * Spec Patch Applier — 검증 완료된 패치를 현재 Spec에 머지한다.
 *
 * 반환: { newSpec, delta }
 *   - newSpec: 패치 적용된 새 Spec (원본 불변)
 *   - delta: 변경 필드 목록 + Jaccard similarity
 */
export function applySpecPatch(
  currentSpec: Spec,
  patch: SpecPatch,
  generation: number,
): { newSpec: Spec; delta: SpecDelta } {
  const fieldsChanged: string[] = [];
  const newSpec: Spec = structuredClone(currentSpec);

  // L1: acceptanceCriteria
  if (patch.acceptanceCriteria) {
    newSpec.acceptanceCriteria = patch.acceptanceCriteria;
    fieldsChanged.push('acceptanceCriteria');
  }

  // L2: constraints
  if (patch.constraints) {
    newSpec.constraints = patch.constraints;
    fieldsChanged.push('constraints');
  }

  // L3: ontologySchema (add/modify only, validated upstream)
  if (patch.ontologySchema) {
    if (patch.ontologySchema.entities) {
      newSpec.ontologySchema.entities = patch.ontologySchema.entities;
      fieldsChanged.push('ontologySchema.entities');
    }
    if (patch.ontologySchema.relations) {
      newSpec.ontologySchema.relations = patch.ontologySchema.relations;
      fieldsChanged.push('ontologySchema.relations');
    }
  }

  // Update metadata generation timestamp
  newSpec.metadata = {
    ...newSpec.metadata,
    generatedAt: new Date().toISOString(),
  };

  const similarity = computeSpecSimilarity(currentSpec, newSpec);

  return {
    newSpec,
    delta: {
      fieldsChanged,
      similarity,
      generation,
    },
  };
}

/**
 * Jaccard similarity between two Specs (token-level comparison of serialized content).
 */
function computeSpecSimilarity(a: Spec, b: Spec): number {
  const tokensA = tokenize(serializeComparable(a));
  const tokensB = tokenize(serializeComparable(b));

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }

  const union = tokensA.size + tokensB.size - intersection;
  return union === 0 ? 1 : Math.round((intersection / union) * 1000) / 1000;
}

/**
 * Serialize comparable fields (exclude metadata/timestamps).
 */
function serializeComparable(spec: Spec): string {
  return JSON.stringify({
    goal: spec.goal,
    constraints: spec.constraints,
    acceptanceCriteria: spec.acceptanceCriteria,
    ontologySchema: spec.ontologySchema,
  });
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
