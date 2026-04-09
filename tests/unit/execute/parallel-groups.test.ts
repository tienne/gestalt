import { describe, it, expect } from 'vitest';
import { computeParallelGroups } from '../../../src/execute/parallel-groups.js';
import type { AtomicTask } from '../../../src/core/types.js';

function makeTask(taskId: string, dependsOn: string[] = []): AtomicTask {
  return {
    taskId,
    title: taskId,
    description: '',
    sourceAC: [],
    isImplicit: false,
    estimatedComplexity: 'low',
    dependsOn,
  };
}

describe('computeParallelGroups', () => {
  it('returns empty array for empty tasks', () => {
    expect(computeParallelGroups([], [])).toEqual([]);
  });

  it('puts independent tasks in the same layer', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    const order = ['a', 'b', 'c'];
    const groups = computeParallelGroups(tasks, order);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toContain('a');
    expect(groups[0]).toContain('b');
    expect(groups[0]).toContain('c');
  });

  it('separates dependent tasks into different layers', () => {
    const tasks = [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['b'])];
    const order = ['a', 'b', 'c'];
    const groups = computeParallelGroups(tasks, order);

    expect(groups).toHaveLength(3);
    expect(groups[0]).toContain('a');
    expect(groups[1]).toContain('b');
    expect(groups[2]).toContain('c');
  });

  it('groups tasks at the same dependency level together', () => {
    const tasks = [
      makeTask('a'),
      makeTask('b'),
      makeTask('c', ['a']),
      makeTask('d', ['b']),
      makeTask('e', ['c', 'd']),
    ];
    const order = ['a', 'b', 'c', 'd', 'e'];
    const groups = computeParallelGroups(tasks, order);

    expect(groups).toHaveLength(3);
    // Layer 0: a, b (no deps)
    expect(groups[0]).toContain('a');
    expect(groups[0]).toContain('b');
    // Layer 1: c, d (depend on layer 0)
    expect(groups[1]).toContain('c');
    expect(groups[1]).toContain('d');
    // Layer 2: e (depends on layer 1)
    expect(groups[2]).toContain('e');
  });

  it('ignores self-referencing dependencies', () => {
    const tasks = [makeTask('a', ['a']), makeTask('b')];
    const order = ['a', 'b'];
    const groups = computeParallelGroups(tasks, order);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toContain('a');
    expect(groups[0]).toContain('b');
  });
});
