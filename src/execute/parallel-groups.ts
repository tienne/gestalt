import type { AtomicTask } from '../core/types.js';

/**
 * DAG 위상 정렬 기반으로 병렬 실행 가능한 태스크 그룹을 계산한다.
 * 동일 레이어의 태스크들은 의존성이 없어 동시에 실행 가능하다.
 *
 * @returns string[][] — 각 배열이 동시 실행 가능한 태스크 ID 목록
 */
export function computeParallelGroups(tasks: AtomicTask[], topologicalOrder: string[]): string[][] {
  if (tasks.length === 0) return [];

  const taskIds = new Set(tasks.map((t) => t.taskId));
  const depMap = new Map<string, Set<string>>();

  for (const task of tasks) {
    const validDeps = new Set(task.dependsOn.filter((d) => taskIds.has(d) && d !== task.taskId));
    depMap.set(task.taskId, validDeps);
  }

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
