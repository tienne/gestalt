import type { AtomicTask, TaskGroup, DAGValidation } from '../core/types.js';

/**
 * Validates the dependency DAG using Kahn's algorithm for topological sort,
 * checks for group conflicts, and computes the critical path.
 */
export function validateDAG(tasks: AtomicTask[], groups: TaskGroup[]): DAGValidation {
  if (tasks.length === 0) {
    return {
      isValid: true,
      hasCycles: false,
      hasConflicts: false,
      topologicalOrder: [],
      criticalPath: [],
    };
  }

  const taskIds = new Set(tasks.map((t) => t.taskId));
  const cycleDetails: string[] = [];
  const conflictDetails: string[] = [];

  // Check for invalid dependency references
  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!taskIds.has(dep)) {
        conflictDetails.push(`Task "${task.taskId}" depends on non-existent task "${dep}"`);
      }
      if (dep === task.taskId) {
        cycleDetails.push(`Task "${task.taskId}" depends on itself`);
      }
    }
  }

  // Check group conflicts: duplicate task in multiple groups
  const taskToGroup = new Map<string, string>();
  for (const group of groups) {
    for (const tid of group.taskIds) {
      if (!taskIds.has(tid)) {
        conflictDetails.push(`Group "${group.groupId}" references non-existent task "${tid}"`);
        continue;
      }
      const existing = taskToGroup.get(tid);
      if (existing) {
        conflictDetails.push(`Task "${tid}" belongs to multiple groups: "${existing}" and "${group.groupId}"`);
      }
      taskToGroup.set(tid, group.groupId);
    }
  }

  // Check all tasks are in a group
  for (const tid of taskIds) {
    if (!taskToGroup.has(tid)) {
      conflictDetails.push(`Task "${tid}" is not assigned to any group`);
    }
  }

  // Kahn's algorithm for topological sort + cycle detection
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();

  for (const task of tasks) {
    adj.set(task.taskId, []);
    inDegree.set(task.taskId, 0);
  }

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (taskIds.has(dep) && dep !== task.taskId) {
        adj.get(dep)!.push(task.taskId);
        inDegree.set(task.taskId, (inDegree.get(task.taskId) ?? 0) + 1);
      }
    }
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) queue.push(id);
  }

  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    topologicalOrder.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  const hasCycles = topologicalOrder.length !== tasks.length;
  if (hasCycles) {
    const remainingNodes = tasks
      .filter((t) => !topologicalOrder.includes(t.taskId))
      .map((t) => t.taskId);
    cycleDetails.push(`Cycle detected involving tasks: ${remainingNodes.join(' → ')}`);
  }

  // Compute critical path (longest path in DAG) — skip if any cycles detected
  const anyCycles = hasCycles || cycleDetails.length > 0;
  const criticalPath = anyCycles ? [] : computeCriticalPath(tasks, topologicalOrder);

  const hasConflicts = conflictDetails.length > 0;
  const isValid = !hasCycles && !hasConflicts && cycleDetails.length === 0;

  return {
    isValid,
    hasCycles: hasCycles || cycleDetails.length > 0,
    ...(cycleDetails.length > 0 ? { cycleDetails } : {}),
    hasConflicts,
    ...(conflictDetails.length > 0 ? { conflictDetails } : {}),
    topologicalOrder: anyCycles ? [] : topologicalOrder,
    criticalPath,
  };
}

function computeCriticalPath(tasks: AtomicTask[], topologicalOrder: string[]): string[] {
  const taskMap = new Map(tasks.map((t) => [t.taskId, t]));
  const dist = new Map<string, number>();
  const predecessor = new Map<string, string | null>();

  for (const id of topologicalOrder) {
    dist.set(id, 0);
    predecessor.set(id, null);
  }

  for (const id of topologicalOrder) {
    const task = taskMap.get(id)!;
    const currentDist = dist.get(id)!;
    // Look at tasks that depend on this one (skip self-references)
    for (const otherTask of tasks) {
      if (otherTask.taskId !== id && otherTask.dependsOn.includes(id)) {
        const newDist = currentDist + 1;
        if (newDist > (dist.get(otherTask.taskId) ?? 0)) {
          dist.set(otherTask.taskId, newDist);
          predecessor.set(otherTask.taskId, id);
        }
      }
    }
  }

  // Find the task with the longest distance
  let maxDist = 0;
  let endNode = topologicalOrder[0] ?? '';
  for (const [id, d] of dist.entries()) {
    if (d >= maxDist) {
      maxDist = d;
      endNode = id;
    }
  }

  // Trace back from endNode
  const path: string[] = [];
  let current: string | null = endNode;
  while (current !== null) {
    path.unshift(current);
    current = predecessor.get(current) ?? null;
  }

  return path;
}
