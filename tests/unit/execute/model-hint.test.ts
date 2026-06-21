import { describe, it, expect } from 'vitest';
import type { AtomicTask, TaskModel } from '../../../src/core/types.js';
import { resolveTaskModel, assignModelHints } from '../../../src/execute/model-hint.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<AtomicTask> = {}): AtomicTask {
  return {
    taskId: 'task-0',
    title: 'Implement endpoint',
    description: 'Build the feature',
    sourceAC: [0],
    isImplicit: false,
    estimatedComplexity: 'medium',
    dependsOn: [],
    ...overrides,
  };
}

// ─── resolveTaskModel ────────────────────────────────────────────────────────

describe('resolveTaskModel', () => {
  describe('haiku (trivial + low complexity)', () => {
    it('rename 키워드 + low → haiku', () => {
      const task = makeTask({
        title: 'Rename file',
        description: 'rename user.ts to account.ts',
        estimatedComplexity: 'low',
      });
      expect(resolveTaskModel(task)).toBe<TaskModel>('haiku');
    });

    it('format 키워드 + low → haiku', () => {
      const task = makeTask({
        title: 'Format code',
        description: 'run prettier formatting',
        estimatedComplexity: 'low',
      });
      expect(resolveTaskModel(task)).toBe('haiku');
    });

    it('한글 trivial 키워드(오타) + low → haiku', () => {
      const task = makeTask({
        title: '오타 수정',
        description: '주석의 오타를 고친다',
        estimatedComplexity: 'low',
      });
      expect(resolveTaskModel(task)).toBe('haiku');
    });

    it('키워드 없는 low complexity → haiku (분기 3)', () => {
      const task = makeTask({
        title: 'Add constant',
        description: 'add a single constant value',
        estimatedComplexity: 'low',
      });
      expect(resolveTaskModel(task)).toBe('haiku');
    });
  });

  describe('opus (complex 키워드 또는 high complexity)', () => {
    it('design 키워드 + medium → opus (키워드 우선)', () => {
      const task = makeTask({
        title: 'Design API schema',
        description: 'design the public API surface',
        estimatedComplexity: 'medium',
      });
      expect(resolveTaskModel(task)).toBe('opus');
    });

    it('한글 complex 키워드(설계) + medium → opus', () => {
      const task = makeTask({
        title: '아키텍처 설계',
        description: '전체 시스템을 설계한다',
        estimatedComplexity: 'medium',
      });
      expect(resolveTaskModel(task)).toBe('opus');
    });

    it('high complexity → opus (키워드 무관)', () => {
      const task = makeTask({
        title: 'Build endpoint',
        description: 'just a normal implementation',
        estimatedComplexity: 'high',
      });
      expect(resolveTaskModel(task)).toBe('opus');
    });

    it('trivial 키워드 + high complexity → opus (low이 아니므로 haiku 분기 미적용)', () => {
      const task = makeTask({
        title: 'Rename across modules',
        description: 'rename a symbol used everywhere',
        estimatedComplexity: 'high',
      });
      expect(resolveTaskModel(task)).toBe('opus');
    });
  });

  describe('sonnet (일반 구현 = medium, 키워드 없음)', () => {
    it('medium + 키워드 없음 → sonnet', () => {
      const task = makeTask({
        title: 'Register endpoint',
        description: 'create POST /register handler',
        estimatedComplexity: 'medium',
      });
      expect(resolveTaskModel(task)).toBe('sonnet');
    });
  });

  describe('edge cases', () => {
    it('대소문자 무관 매칭 (DESIGN 대문자) → opus', () => {
      const task = makeTask({
        title: 'DESIGN the module',
        description: 'ARCHITECT a solution',
        estimatedComplexity: 'medium',
      });
      expect(resolveTaskModel(task)).toBe('opus');
    });

    it('trivial 키워드 + medium complexity는 haiku가 아님 → sonnet', () => {
      // trivial 분기는 low일 때만 적용된다 (complex 키워드는 없어야 함)
      const task = makeTask({
        title: 'Rename variable',
        description: 'rename a local variable',
        estimatedComplexity: 'medium',
      });
      expect(resolveTaskModel(task)).toBe('sonnet');
    });

    it('complex + trivial 키워드 동시 존재 → opus 우선 (trivial은 low 게이트)', () => {
      const task = makeTask({
        title: 'Refactor and rename',
        description: 'refactor module while renaming files',
        estimatedComplexity: 'medium',
      });
      // 'refactor'(complex) 매칭 → opus. trivial은 low complexity 게이트 때문에 미적용.
      expect(resolveTaskModel(task)).toBe('opus');
    });
  });
});

// ─── assignModelHints ────────────────────────────────────────────────────────

describe('assignModelHints', () => {
  it('model 없는 task에 힌트를 채운다', () => {
    const tasks = [
      makeTask({ taskId: 'task-0', estimatedComplexity: 'high' }),
      makeTask({ taskId: 'task-1', estimatedComplexity: 'medium' }),
      makeTask({
        taskId: 'task-2',
        title: 'Rename',
        description: 'rename file',
        estimatedComplexity: 'low',
      }),
    ];

    const result = assignModelHints(tasks);

    expect(result[0]!.model).toBe('opus');
    expect(result[1]!.model).toBe('sonnet');
    expect(result[2]!.model).toBe('haiku');
  });

  it('모든 task에 model이 채워진다 (undefined 없음)', () => {
    const tasks = [
      makeTask({ taskId: 'task-0', estimatedComplexity: 'low' }),
      makeTask({ taskId: 'task-1', estimatedComplexity: 'medium' }),
      makeTask({ taskId: 'task-2', estimatedComplexity: 'high' }),
    ];

    const result = assignModelHints(tasks);

    for (const t of result) {
      expect(t.model).toBeDefined();
    }
  });

  it('이미 model이 지정된 task는 덮어쓰지 않는다 (caller 의도 존중)', () => {
    const tasks = [
      // high complexity → 보통 opus지만, caller가 haiku로 명시
      makeTask({ taskId: 'task-0', estimatedComplexity: 'high', model: 'haiku' }),
      makeTask({ taskId: 'task-1', estimatedComplexity: 'medium' }),
    ];

    const result = assignModelHints(tasks);

    expect(result[0]!.model).toBe('haiku'); // 보존
    expect(result[1]!.model).toBe('sonnet'); // 새로 할당
  });

  it('빈 배열은 빈 배열을 반환한다', () => {
    expect(assignModelHints([])).toEqual([]);
  });

  it('원본 task 객체를 변형(mutate)하지 않는다', () => {
    const original = makeTask({ taskId: 'task-0', estimatedComplexity: 'high' });
    const result = assignModelHints([original]);

    expect(original.model).toBeUndefined(); // 원본 불변
    expect(result[0]!.model).toBe('opus'); // 새 객체에만 반영
    expect(result[0]).not.toBe(original);
  });

  it('이미 지정된 task는 동일 참조를 유지한다 (불필요한 복제 없음)', () => {
    const preset = makeTask({ taskId: 'task-0', model: 'sonnet' });
    const result = assignModelHints([preset]);
    expect(result[0]).toBe(preset);
  });
});
