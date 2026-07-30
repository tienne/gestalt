import type { AtomicTask } from '../core/types.js';

/**
 * 태스크별 유효 의존성 맵을 만든다.
 * 존재하지 않는 taskId와 자기참조를 제거하므로, 이 맵을 쓰는 계산은
 * 순환의 한 형태인 자기참조로 인해 진행이 막히지 않는다.
 */
export function buildDepMap(tasks: AtomicTask[]): Map<string, Set<string>> {
  const taskIds = new Set(tasks.map((t) => t.taskId));
  const depMap = new Map<string, Set<string>>();

  for (const task of tasks) {
    const validDeps = new Set(task.dependsOn.filter((d) => taskIds.has(d) && d !== task.taskId));
    depMap.set(task.taskId, validDeps);
  }

  return depMap;
}

/**
 * 현재 완료 상태에서 즉시 착수 가능한 태스크 집합.
 * topologicalOrder 순서를 보존해 결정적으로 반환한다.
 *
 * 순환·자기참조가 있으면 dag-validator가 topologicalOrder를 []로 주므로 자연히 []를 반환한다.
 * 그래서 순회 기준은 반드시 topologicalOrder여야 한다 — tasks를 돌면 이 방어가 무력해진다.
 *
 * 판정은 completedTaskIds(status === 'completed')만 기준으로 한다. failed를 resolved로 보지 않는
 * 이유는 두 가지다. (1) 실패 태스크는 동일 taskId로 결과를 교체하는 재시도가 가능하므로 "지금
 * 착수 가능한 것"에 남아 있는 편이 의미에 맞다. (2) 실패한 토대 위의 후속 태스크를 ready로
 * 내보내면 깨진 상태에서 병렬 착수를 권하는 셈이 된다. skipped를 resolved로 보지 않는 것은
 * 기존 nextTaskId의 한계를 그대로 유지하기 위한 것이며, 별건으로 다룬다.
 *
 * 불변식: `computeReadyTaskIds(...)[0] ?? null` === 기존 nextTaskId 계산 결과
 * (topologicalOrder의 첫 미완료 항목). topological order에서 첫 미완료 항목의 모든 의존성은
 * 그보다 앞에 오므로 이미 완료 상태이고, 따라서 항상 ready 집합의 첫 원소다.
 */
export function computeReadyTaskIds(
  tasks: AtomicTask[],
  topologicalOrder: string[],
  completedTaskIds: string[],
): string[] {
  if (tasks.length === 0) return [];

  const depMap = buildDepMap(tasks);
  const completedSet = new Set(completedTaskIds);
  const ready: string[] = [];

  for (const id of topologicalOrder) {
    if (completedSet.has(id)) continue;
    const deps = depMap.get(id);
    if (!deps || [...deps].every((d) => completedSet.has(d))) {
      ready.push(id);
    }
  }

  return ready;
}

/**
 * DAG 위상 정렬 기반으로 병렬 실행 가능한 태스크 그룹을 계산한다.
 * 동일 레이어의 태스크들은 의존성이 없어 동시에 실행 가능하다.
 *
 * @returns string[][] — 각 배열이 동시 실행 가능한 태스크 ID 목록
 */
export function computeParallelGroups(tasks: AtomicTask[], topologicalOrder: string[]): string[][] {
  if (tasks.length === 0) return [];

  const depMap = buildDepMap(tasks);

  // Assign each task a layer number = max(layer of deps) + 1
  const layer = new Map<string, number>();
  for (const id of topologicalOrder) {
    const deps = depMap.get(id) ?? new Set();
    if (deps.size === 0) {
      layer.set(id, 0);
    } else {
      const maxDepLayer = Math.max(...[...deps].map((d) => layer.get(d) ?? 0));
      layer.set(id, maxDepLayer + 1);
    }
  }

  // Group by layer
  const groups: Map<number, string[]> = new Map();
  for (const [id, l] of layer.entries()) {
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l)!.push(id);
  }

  // Sort layers and return as array of arrays
  const sortedLayers = [...groups.entries()].sort(([a], [b]) => a - b);
  return sortedLayers.map(([, ids]) => ids);
}
