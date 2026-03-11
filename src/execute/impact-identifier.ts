import type { AtomicTask, DriftScore, SpecDelta } from '../core/types.js';

/**
 * Drift-based Impact Task Identifier
 *
 * Spec 패치 후 어떤 태스크를 재실행해야 하는지 식별한다.
 * 두 가지 기준으로 impacted task를 선별:
 *
 * 1. Drift-based: 기존 실행 시 drift threshold를 초과한 태스크
 * 2. Delta-based: 패치된 필드(AC, constraint 등)와 직접 연관된 태스크
 */
export function identifyImpactedTasks(
  atomicTasks: AtomicTask[],
  driftHistory: DriftScore[],
  delta: SpecDelta,
  driftThreshold: number,
): string[] {
  const impactedSet = new Set<string>();

  // 1. Drift-exceeded tasks: 기존 실행에서 이미 drift가 높았던 태스크
  for (const drift of driftHistory) {
    if (drift.thresholdExceeded || drift.overall > driftThreshold * 0.8) {
      impactedSet.add(drift.taskId);
    }
  }

  // 2. Delta-based: AC가 변경되었으면 해당 AC를 sourceAC로 가진 태스크 재실행
  if (delta.fieldsChanged.includes('acceptanceCriteria')) {
    for (const task of atomicTasks) {
      // AC가 변경되었으므로 AC-linked 태스크는 재실행 대상
      if (task.sourceAC.length > 0) {
        impactedSet.add(task.taskId);
      }
    }
  }

  // 3. Ontology 변경 시 implicit 태스크 (ontology 기반 추론 태스크) 재실행
  if (
    delta.fieldsChanged.includes('ontologySchema.entities') ||
    delta.fieldsChanged.includes('ontologySchema.relations')
  ) {
    for (const task of atomicTasks) {
      if (task.isImplicit) {
        impactedSet.add(task.taskId);
      }
    }
  }

  // impacted task + 그에 의존하는 downstream 태스크도 포함
  const withDependents = expandDependents(impactedSet, atomicTasks);

  return Array.from(withDependents);
}

/**
 * impacted 태스크에 의존하는 downstream 태스크를 재귀적으로 확장한다.
 */
function expandDependents(impacted: Set<string>, tasks: AtomicTask[]): Set<string> {
  const result = new Set(impacted);
  let changed = true;

  while (changed) {
    changed = false;
    for (const task of tasks) {
      if (result.has(task.taskId)) continue;
      // 이 태스크의 dependency 중 하나라도 impacted면 이 태스크도 impacted
      if (task.dependsOn.some((dep) => result.has(dep))) {
        result.add(task.taskId);
        changed = true;
      }
    }
  }

  return result;
}
