import { describe, it, expect } from 'vitest';
import {
  computeParallelGroups,
  computeReadyTaskIds,
  buildDepMap,
} from '../../../src/execute/parallel-groups.js';
import { validateDAG } from '../../../src/execute/dag-validator.js';
import type { AtomicTask, TaskGroup } from '../../../src/core/types.js';

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

function makeGroup(taskIds: string[]): TaskGroup {
  return {
    groupId: 'group-0',
    name: 'All',
    domain: 'test',
    taskIds,
    reasoning: 'single group',
  };
}

/** 공유 함수 도입 전 session.ts:164-169의 nextTaskId 계산 방식 (하위호환 기준선) */
function legacyNextTaskId(topologicalOrder: string[], completedTaskIds: string[]): string | null {
  const completedSet = new Set(completedTaskIds);
  return topologicalOrder.find((id) => !completedSet.has(id)) ?? null;
}

/** 완료 상태의 모든 조합을 만들어 불변식을 전수 검증하기 위한 멱집합 */
function powerSet(items: string[]): string[][] {
  return items.reduce<string[][]>(
    (acc, item) => [...acc, ...acc.map((sub) => [...sub, item])],
    [[]],
  );
}

describe('buildDepMap', () => {
  it('필터링: 존재하지 않는 taskId와 자기참조를 제거한다', () => {
    const tasks = [makeTask('a', ['a', 'ghost']), makeTask('b', ['a', 'ghost'])];
    const depMap = buildDepMap(tasks);

    expect([...depMap.get('a')!]).toEqual([]);
    expect([...depMap.get('b')!]).toEqual(['a']);
  });
});

describe('computeReadyTaskIds', () => {
  it('빈 입력이면 빈 배열을 반환한다', () => {
    expect(computeReadyTaskIds([], [], [])).toEqual([]);
  });

  it('의존성이 충족된 태스크만 ready로 낸다', () => {
    const tasks = [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['a'])];
    const order = ['a', 'b', 'c'];

    expect(computeReadyTaskIds(tasks, order, [])).toEqual(['a']);
    expect(computeReadyTaskIds(tasks, order, ['a'])).toEqual(['b', 'c']);
    expect(computeReadyTaskIds(tasks, order, ['a', 'b'])).toEqual(['c']);
    expect(computeReadyTaskIds(tasks, order, ['a', 'b', 'c'])).toEqual([]);
  });

  it('선형 체인에서는 ready가 항상 1개다', () => {
    const tasks = [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['b'])];
    const order = ['a', 'b', 'c'];

    expect(computeReadyTaskIds(tasks, order, [])).toEqual(['a']);
    expect(computeReadyTaskIds(tasks, order, ['a'])).toEqual(['b']);
    expect(computeReadyTaskIds(tasks, order, ['a', 'b'])).toEqual(['c']);
  });

  it('병렬 가능한 DAG에서는 ready가 2개 이상이다', () => {
    // 다이아몬드: a → {b, c} → d
    const tasks = [
      makeTask('a'),
      makeTask('b', ['a']),
      makeTask('c', ['a']),
      makeTask('d', ['b', 'c']),
    ];
    const order = ['a', 'b', 'c', 'd'];

    const ready = computeReadyTaskIds(tasks, order, ['a']);
    expect(ready.length).toBeGreaterThanOrEqual(2);
    expect(ready).toEqual(['b', 'c']);

    // b만 끝나면 d는 c 미완료로 막히고 c만 남는다
    expect(computeReadyTaskIds(tasks, order, ['a', 'b'])).toEqual(['c']);
    expect(computeReadyTaskIds(tasks, order, ['a', 'b', 'c'])).toEqual(['d']);
  });

  it('독립 태스크만 있으면 전부 ready다', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    expect(computeReadyTaskIds(tasks, ['a', 'b', 'c'], [])).toEqual(['a', 'b', 'c']);
  });

  it('topologicalOrder 순서를 보존하며 반복 호출에도 결정적이다', () => {
    const tasks = [makeTask('a'), makeTask('b'), makeTask('c')];
    // 순서가 다른 두 topologicalOrder를 주면 출력도 그 순서를 그대로 따른다
    expect(computeReadyTaskIds(tasks, ['c', 'a', 'b'], [])).toEqual(['c', 'a', 'b']);
    expect(computeReadyTaskIds(tasks, ['b', 'c', 'a'], [])).toEqual(['b', 'c', 'a']);

    const order = ['c', 'a', 'b'];
    const first = computeReadyTaskIds(tasks, order, []);
    for (let i = 0; i < 5; i++) {
      expect(computeReadyTaskIds(tasks, order, [])).toEqual(first);
    }
  });

  it('존재하지 않는 dep은 무시하고 ready로 낸다', () => {
    const tasks = [makeTask('a', ['ghost'])];
    expect(computeReadyTaskIds(tasks, ['a'], [])).toEqual(['a']);
  });

  it('자기참조만 있는 태스크는 의존성 없는 것으로 보고 ready로 낸다', () => {
    const tasks = [makeTask('a', ['a']), makeTask('b')];
    expect(computeReadyTaskIds(tasks, ['a', 'b'], [])).toEqual(['a', 'b']);
  });

  it('topologicalOrder가 빈 배열이면 무한루프 없이 즉시 []를 반환한다', () => {
    const tasks = [makeTask('a', ['b']), makeTask('b', ['a'])];
    expect(computeReadyTaskIds(tasks, [], [])).toEqual([]);
    expect(computeReadyTaskIds(tasks, [], ['a'])).toEqual([]);
  });

  it('validateDAG를 통과시킨 실제 순환 플랜에서도 []를 반환하고 종료한다', () => {
    // a → b → c → a 순환. validateDAG가 topologicalOrder를 []로 비워준다
    const tasks = [makeTask('a', ['c']), makeTask('b', ['a']), makeTask('c', ['b'])];
    const dag = validateDAG(tasks, [makeGroup(['a', 'b', 'c'])]);

    expect(dag.hasCycles).toBe(true);
    expect(dag.topologicalOrder).toEqual([]);
    expect(computeReadyTaskIds(tasks, dag.topologicalOrder, [])).toEqual([]);
  });

  it('validateDAG를 통과시킨 자기참조 플랜에서도 []를 반환하고 종료한다', () => {
    const tasks = [makeTask('a', ['a']), makeTask('b')];
    const dag = validateDAG(tasks, [makeGroup(['a', 'b'])]);

    expect(dag.hasCycles).toBe(true);
    expect(dag.topologicalOrder).toEqual([]);
    expect(computeReadyTaskIds(tasks, dag.topologicalOrder, [])).toEqual([]);
  });
});

/**
 * 하위호환 고정: nextTaskId를 nextTaskIds[0]에서 파생시켜도 기존 계산 결과와 항상 같아야 한다.
 * 깨지면 MCP로 관측되는 nextTaskId 동작이 바뀐 것이므로 가장 중요한 회귀 테스트다.
 */
describe('computeReadyTaskIds 불변식: readyIds[0] ?? null === 기존 nextTaskId', () => {
  const shapes: Array<{ name: string; tasks: AtomicTask[] }> = [
    {
      name: '선형 체인 (a→b→c)',
      tasks: [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['b'])],
    },
    {
      name: '병렬 (독립 3개)',
      tasks: [makeTask('a'), makeTask('b'), makeTask('c')],
    },
    {
      name: '다이아몬드 (a→{b,c}→d)',
      tasks: [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['a']), makeTask('d', ['b', 'c'])],
    },
    {
      name: '팬아웃 후 합류 (a,b 독립 → c(a), d(b) → e(c,d))',
      tasks: [
        makeTask('a'),
        makeTask('b'),
        makeTask('c', ['a']),
        makeTask('d', ['b']),
        makeTask('e', ['c', 'd']),
      ],
    },
    {
      name: '단일 태스크',
      tasks: [makeTask('a')],
    },
  ];

  for (const { name, tasks } of shapes) {
    it(`${name}: 모든 완료 조합에서 기존 방식과 동일한 값을 낸다`, () => {
      const taskIds = tasks.map((t) => t.taskId);
      const dag = validateDAG(tasks, [makeGroup(taskIds)]);
      expect(dag.topologicalOrder).toHaveLength(tasks.length);

      for (const completed of powerSet(taskIds)) {
        const derived = computeReadyTaskIds(tasks, dag.topologicalOrder, completed)[0] ?? null;
        expect(derived).toBe(legacyNextTaskId(dag.topologicalOrder, completed));
      }
    });
  }

  it('순환 플랜에서도 양쪽 모두 null이다', () => {
    const tasks = [makeTask('a', ['b']), makeTask('b', ['a'])];
    const dag = validateDAG(tasks, [makeGroup(['a', 'b'])]);

    expect(computeReadyTaskIds(tasks, dag.topologicalOrder, [])[0] ?? null).toBeNull();
    expect(legacyNextTaskId(dag.topologicalOrder, [])).toBeNull();
  });
});
