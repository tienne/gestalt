import type { SpecPatch, Spec } from '../core/types.js';

export interface PatchValidationError {
  field: string;
  message: string;
}

export interface PatchValidationResult {
  valid: boolean;
  errors: PatchValidationError[];
}

/**
 * Spec Patch Validator — 패치 범위 제약을 검증한다.
 *
 * 허용 범위 (L1~L3):
 *   L1: acceptanceCriteria — 자유 수정 (추가/변경/삭제)
 *   L2: constraints — 자유 수정
 *   L3: ontologySchema — 선택적 (추가/변경만, entity/relation 삭제 불가)
 *   L4: goal — 변경 금지
 */
export function validateSpecPatch(patch: SpecPatch, currentSpec: Spec): PatchValidationResult {
  const errors: PatchValidationError[] = [];

  // goal 변경 시도 감지 (SpecPatch 타입에 goal이 없으므로 런타임 체크)
  if ('goal' in (patch as Record<string, unknown>)) {
    errors.push({
      field: 'goal',
      message: 'Goal modification is forbidden (L4). The goal must remain unchanged.',
    });
  }

  // L1: acceptanceCriteria — 자유 수정, 단 비어있으면 안 됨
  if (patch.acceptanceCriteria !== undefined) {
    if (patch.acceptanceCriteria.length === 0) {
      errors.push({
        field: 'acceptanceCriteria',
        message: 'acceptanceCriteria cannot be empty.',
      });
    }
  }

  // L3: ontologySchema — 삭제 불가 검증
  if (patch.ontologySchema) {
    if (patch.ontologySchema.entities) {
      const currentNames = new Set(currentSpec.ontologySchema.entities.map((e) => e.name));
      const patchNames = new Set(patch.ontologySchema.entities.map((e) => e.name));
      for (const name of currentNames) {
        if (!patchNames.has(name)) {
          errors.push({
            field: 'ontologySchema.entities',
            message: `Entity "${name}" cannot be deleted. L3 allows add/modify only.`,
          });
        }
      }
    }

    if (patch.ontologySchema.relations) {
      const currentRelKeys = new Set(
        currentSpec.ontologySchema.relations.map((r) => `${r.from}->${r.to}:${r.type}`),
      );
      const patchRelKeys = new Set(
        patch.ontologySchema.relations.map((r) => `${r.from}->${r.to}:${r.type}`),
      );
      for (const key of currentRelKeys) {
        if (!patchRelKeys.has(key)) {
          errors.push({
            field: 'ontologySchema.relations',
            message: `Relation "${key}" cannot be deleted. L3 allows add/modify only.`,
          });
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
