import { describe, it, expect } from 'vitest';
import { validateDAG } from '../../../src/execute/dag-validator.js';
import type { AtomicTask, TaskGroup } from '../../../src/core/types.js';

function task(id: string, dependsOn: string[] = []): AtomicTask {
  return {
    taskId: id,
    title: `Task ${id}`,
    description: `Description for ${id}`,
    sourceAC: [0],
    isImplicit: false,
    estimatedComplexity: 'medium',
    dependsOn,
  };
}

function group(id: string, taskIds: string[]): TaskGroup {
  return {
    groupId: id,
    name: `Group ${id}`,
    domain: 'test',
    taskIds,
    reasoning: 'test',
  };
}

describe('validateDAG', () => {
  it('validates an empty DAG', () => {
    const result = validateDAG([], []);
    expect(result.isValid).toBe(true);
    expect(result.hasCycles).toBe(false);
    expect(result.hasConflicts).toBe(false);
    expect(result.topologicalOrder).toEqual([]);
    expect(result.criticalPath).toEqual([]);
  });

  it('validates a simple valid DAG', () => {
    const tasks = [
      task('t-0'),
      task('t-1', ['t-0']),
      task('t-2', ['t-0']),
      task('t-3', ['t-1', 't-2']),
    ];
    const groups = [
      group('g-0', ['t-0', 't-1']),
      group('g-1', ['t-2', 't-3']),
    ];

    const result = validateDAG(tasks, groups);
    expect(result.isValid).toBe(true);
    expect(result.hasCycles).toBe(false);
    expect(result.hasConflicts).toBe(false);
    expect(result.topologicalOrder).toHaveLength(4);
    expect(result.topologicalOrder.indexOf('t-0')).toBeLessThan(result.topologicalOrder.indexOf('t-1'));
    expect(result.topologicalOrder.indexOf('t-0')).toBeLessThan(result.topologicalOrder.indexOf('t-2'));
    expect(result.topologicalOrder.indexOf('t-1')).toBeLessThan(result.topologicalOrder.indexOf('t-3'));
  });

  it('detects cycles', () => {
    const tasks = [
      task('t-0', ['t-2']),
      task('t-1', ['t-0']),
      task('t-2', ['t-1']),
    ];
    const groups = [group('g-0', ['t-0', 't-1', 't-2'])];

    const result = validateDAG(tasks, groups);
    expect(result.isValid).toBe(false);
    expect(result.hasCycles).toBe(true);
    expect(result.cycleDetails).toBeDefined();
    expect(result.topologicalOrder).toEqual([]);
  });

  it('detects self-referencing task', () => {
    const tasks = [task('t-0', ['t-0'])];
    const groups = [group('g-0', ['t-0'])];

    const result = validateDAG(tasks, groups);
    expect(result.isValid).toBe(false);
    expect(result.hasCycles).toBe(true);
    expect(result.cycleDetails).toBeDefined();
    expect(result.cycleDetails!.some((d) => d.includes('t-0'))).toBe(true);
  });

  it('detects task in multiple groups', () => {
    const tasks = [task('t-0'), task('t-1')];
    const groups = [
      group('g-0', ['t-0', 't-1']),
      group('g-1', ['t-1']),
    ];

    const result = validateDAG(tasks, groups);
    expect(result.isValid).toBe(false);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflictDetails!.some((d) => d.includes('t-1'))).toBe(true);
  });

  it('detects unassigned tasks', () => {
    const tasks = [task('t-0'), task('t-1')];
    const groups = [group('g-0', ['t-0'])];

    const result = validateDAG(tasks, groups);
    expect(result.isValid).toBe(false);
    expect(result.hasConflicts).toBe(true);
    expect(result.conflictDetails!.some((d) => d.includes('t-1'))).toBe(true);
  });

  it('detects group referencing non-existent task', () => {
    const tasks = [task('t-0')];
    const groups = [group('g-0', ['t-0', 't-999'])];

    const result = validateDAG(tasks, groups);
    expect(result.isValid).toBe(false);
    expect(result.hasConflicts).toBe(true);
  });

  it('detects dependency on non-existent task', () => {
    const tasks = [task('t-0', ['t-999'])];
    const groups = [group('g-0', ['t-0'])];

    const result = validateDAG(tasks, groups);
    expect(result.isValid).toBe(false);
    expect(result.hasConflicts).toBe(true);
  });

  it('computes critical path correctly', () => {
    // t-0 → t-1 → t-3 (length 3)
    // t-0 → t-2 (length 2)
    const tasks = [
      task('t-0'),
      task('t-1', ['t-0']),
      task('t-2', ['t-0']),
      task('t-3', ['t-1']),
    ];
    const groups = [
      group('g-0', ['t-0', 't-1']),
      group('g-1', ['t-2', 't-3']),
    ];

    const result = validateDAG(tasks, groups);
    expect(result.isValid).toBe(true);
    expect(result.criticalPath).toEqual(['t-0', 't-1', 't-3']);
  });

  it('handles single task', () => {
    const tasks = [task('t-0')];
    const groups = [group('g-0', ['t-0'])];

    const result = validateDAG(tasks, groups);
    expect(result.isValid).toBe(true);
    expect(result.topologicalOrder).toEqual(['t-0']);
    expect(result.criticalPath).toEqual(['t-0']);
  });
});
