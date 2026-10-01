import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EventStore } from '../../../src/events/store.js';
import { EventType } from '../../../src/events/types.js';
import { ExecuteSessionManager } from '../../../src/execute/session.js';
import { PlanningOrchestrator } from '../../../src/execute/orchestrators/planning.js';
import { ExecuteSessionNotFoundError, InvalidPlanningStepError } from '../../../src/core/errors.js';
import { MAX_ATOMIC_TASKS, MAX_TASK_GROUPS } from '../../../src/core/constants.js';
import type { AtomicTask, PlanningStepResult, Spec, TaskGroup } from '../../../src/core/types.js';
import {
  figureGround,
  linearTasks,
  makeSpec,
  makeTask,
  planningSteps,
  singleGroup,
} from '../../helpers/execute-fixture.js';

/**
 * PlanningOrchestrator를 엔진 파사드 없이 직접 부른다.
 * 단계별 검증 분기와 plan 조립 규칙(서버 DAG 우선, model 힌트, 이벤트 기록)을 본다.
 */
describe('PlanningOrchestrator', () => {
  let dbPath: string;
  let store: EventStore;
  let sessions: ExecuteSessionManager;
  let orch: PlanningOrchestrator;

  beforeEach(() => {
    dbPath = `.gestalt-test/planning-orch-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    sessions = new ExecuteSessionManager(store);
    orch = new PlanningOrchestrator(sessions, store);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  function start(spec: Spec = makeSpec()): string {
    const r = orch.start(spec);
    if (!r.ok) throw r.error;
    return r.value.session.sessionId;
  }

  function submit(sessionId: string, steps: readonly PlanningStepResult[]): void {
    for (const step of steps) {
      const r = orch.planStep(sessionId, step);
      if (!r.ok) throw r.error;
    }
  }

  /** figure_ground까지 마친 세션에 closure를 낸다 */
  function closureError(tasks: AtomicTask[], spec = makeSpec()): string | undefined {
    const id = start(spec);
    submit(id, [figureGround(spec)]);
    const r = orch.planStep(id, { principle: 'closure', atomicTasks: tasks });
    return r.ok ? undefined : r.error.message;
  }

  /** closure까지 마친 세션에 proximity를 낸다 */
  function proximityError(groups: TaskGroup[], tasks = linearTasks): string | undefined {
    const spec = makeSpec();
    const id = start(spec);
    submit(id, [figureGround(spec), { principle: 'closure', atomicTasks: tasks }]);
    const r = orch.planStep(id, { principle: 'proximity', taskGroups: groups });
    return r.ok ? undefined : r.error.message;
  }

  describe('start', () => {
    it('planning 상태 세션과 1단계 컨텍스트를 만든다', () => {
      const spec = makeSpec();
      const r = orch.start(spec, { codeGraphRepoRoot: '/repo' });
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.value.session.status).toBe('planning');
      expect(r.value.session.codeGraphRepoRoot).toBe('/repo');
      expect(r.value.executeContext).toMatchObject({
        currentPrinciple: 'figure_ground',
        stepNumber: 1,
        totalSteps: 4,
        phase: 'planning',
        previousSteps: [],
      });
      expect(r.value.executeContext.planningPrompt).toContain(spec.goal);
    });
  });

  describe('planStep — 공통', () => {
    it('없는 세션이면 ExecuteSessionNotFoundError를 그대로 돌려준다', () => {
      const r = orch.planStep('missing', figureGround(makeSpec()));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBeInstanceOf(ExecuteSessionNotFoundError);
    });

    it('순서를 건너뛴 원리는 InvalidPlanningStepError로 막는다', () => {
      const spec = makeSpec();
      const id = start(spec);
      const r = orch.planStep(id, { principle: 'proximity', taskGroups: singleGroup(linearTasks) });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBeInstanceOf(InvalidPlanningStepError);
      expect(r.error.message).toContain('step 1');
    });

    it('planning이 아닌 세션은 단계를 받지 않는다', () => {
      const spec = makeSpec();
      const id = start(spec);
      submit(id, planningSteps(spec));
      orch.planComplete(id);

      const r = orch.planStep(id, figureGround(spec));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toContain('not in planning state');
    });

    it('중간 단계는 다음 원리 컨텍스트에 앞 단계 결과를 실어 돌려준다', () => {
      const spec = makeSpec();
      const id = start(spec);
      const r = orch.planStep(id, figureGround(spec));
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      expect(r.value.isLastStep).toBe(false);
      expect(r.value.executeContext?.currentPrinciple).toBe('closure');
      expect(r.value.executeContext?.stepNumber).toBe(2);
      expect(r.value.executeContext?.previousSteps).toHaveLength(1);
    });

    it('네 번째 단계는 isLastStep만 돌려주고 컨텍스트는 없다', () => {
      const spec = makeSpec();
      const id = start(spec);
      const [fg, closure, proximity, continuity] = planningSteps(spec);
      submit(id, [fg, closure, proximity]);

      const r = orch.planStep(id, continuity);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.isLastStep).toBe(true);
      expect(r.value.executeContext).toBeUndefined();
    });

    it('검증에 걸린 단계는 세션에 쌓이지 않는다', () => {
      const spec = makeSpec();
      const id = start(spec);
      orch.planStep(id, { principle: 'figure_ground', classifiedACs: [] });
      expect(sessions.get(id).planningSteps).toHaveLength(0);
    });
  });

  describe('planStep — figure_ground 검증', () => {
    it.each([
      ['비어 있음', [], 'must not be empty'],
      ['AC 하나 누락', [0, 1], 'AC index 2 is not classified'],
      ['범위 밖 index', [0, 1, 2, 3], 'AC index 3 is out of range (0-2)'],
    ])('%s', (_label, indices, message) => {
      const spec = makeSpec();
      const id = start(spec);
      const classifiedACs = indices.map((acIndex) => ({
        acIndex,
        acText: `AC${acIndex}`,
        classification: 'figure' as const,
        priority: 'high' as const,
        reasoning: 'r',
      }));
      const r = orch.planStep(id, { principle: 'figure_ground', classifiedACs });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toContain(message);
    });
  });

  describe('planStep — closure 검증', () => {
    it('비어 있으면 막는다', () => {
      expect(closureError([])).toContain('must not be empty');
    });

    it('상한을 넘으면 막는다', () => {
      const many = Array.from({ length: MAX_ATOMIC_TASKS + 1 }, (_, i) =>
        makeTask(`task-${i}`, [], 0),
      );
      expect(closureError(many)).toContain(`max ${MAX_ATOMIC_TASKS}`);
    });

    it('taskId가 겹치면 막는다', () => {
      expect(closureError([makeTask('task-0', [], 0), makeTask('task-0', [], 1)])).toContain(
        'Duplicate taskId: task-0',
      );
    });

    it('분류되지 않은 AC를 가리키면 막는다', () => {
      expect(closureError([makeTask('task-0', [], 9)])).toContain('invalid AC index 9');
    });

    it('implicit 태스크는 AC 참조를 따지지 않는다', () => {
      const implicit = { ...makeTask('task-0', [], 9), isImplicit: true };
      expect(closureError([implicit])).toBeUndefined();
    });

    it('없는 태스크에 의존하면 막는다', () => {
      expect(closureError([makeTask('task-0', ['task-9'], 0)])).toContain(
        'depends on non-existent task "task-9"',
      );
    });
  });

  describe('planStep — proximity 검증', () => {
    const group = (groupId: string, taskIds: string[]): TaskGroup => ({
      groupId,
      name: groupId,
      domain: 'core',
      taskIds,
      reasoning: 'r',
    });

    it('비어 있으면 막는다', () => {
      expect(proximityError([])).toContain('must not be empty');
    });

    it('상한을 넘으면 막는다', () => {
      const groups = Array.from({ length: MAX_TASK_GROUPS + 1 }, (_, i) => group(`g-${i}`, []));
      expect(proximityError(groups)).toContain(`max ${MAX_TASK_GROUPS}`);
    });

    it('groupId가 겹치면 막는다', () => {
      expect(proximityError([group('g', ['task-0']), group('g', ['task-1', 'task-2'])])).toContain(
        'Duplicate groupId: g',
      );
    });

    it('closure에 없는 태스크를 넣으면 막는다', () => {
      expect(proximityError([group('g', ['task-0', 'task-1', 'task-2', 'task-x'])])).toContain(
        'invalid task "task-x"',
      );
    });

    it('한 태스크를 두 그룹에 넣으면 막는다', () => {
      expect(
        proximityError([group('a', ['task-0', 'task-1']), group('b', ['task-1', 'task-2'])]),
      ).toContain('"task-1" is assigned to multiple groups');
    });

    it('어느 그룹에도 없는 태스크가 있으면 막는다', () => {
      expect(proximityError([group('a', ['task-0', 'task-1'])])).toContain(
        '"task-2" is not assigned to any group',
      );
    });
  });

  describe('planStep — continuity 교차 검증', () => {
    const cyclic = [makeTask('task-0', ['task-1'], 0), makeTask('task-1', ['task-0'], 1)];

    function submitUpToContinuity(tasks: AtomicTask[]): { id: string; spec: Spec } {
      const spec = makeSpec(['AC0', 'AC1']);
      const id = start(spec);
      submit(id, [
        figureGround(spec),
        { principle: 'closure', atomicTasks: tasks },
        { principle: 'proximity', taskGroups: singleGroup(tasks) },
      ]);
      return { id, spec };
    }

    it('호출자는 유효하다는데 서버가 순환을 찾으면 막는다', () => {
      const { id } = submitUpToContinuity(cyclic);
      const r = orch.planStep(id, {
        principle: 'continuity',
        dagValidation: {
          isValid: true,
          hasCycles: false,
          hasConflicts: false,
          topologicalOrder: ['task-0', 'task-1'],
          criticalPath: ['task-0', 'task-1'],
        },
      });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toContain('Server-side DAG validation disagrees');
    });

    it('호출자가 틀린 위상 순서를 내도 서버 판정이 유효하면 받는다', () => {
      const { id } = submitUpToContinuity([makeTask('task-0', [], 0), makeTask('task-1', [], 1)]);
      const r = orch.planStep(id, {
        principle: 'continuity',
        dagValidation: {
          isValid: true,
          hasCycles: false,
          hasConflicts: false,
          topologicalOrder: ['task-1'],
          criticalPath: [],
        },
      });
      expect(r.ok).toBe(true);
    });
  });

  describe('planComplete', () => {
    it('단계가 모자라면 진행 수를 담아 막는다', () => {
      const spec = makeSpec();
      const id = start(spec);
      submit(id, [figureGround(spec)]);

      const r = orch.planComplete(id);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error.message).toContain('1/4');
    });

    it('없는 세션이면 ExecuteSessionNotFoundError를 그대로 돌려준다', () => {
      const r = orch.planComplete('missing');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBeInstanceOf(ExecuteSessionNotFoundError);
    });

    it('호출자의 위상 순서 대신 서버가 다시 계산한 DAG로 계획을 짠다', () => {
      const spec = makeSpec();
      const id = start(spec);
      const [fg, closure, proximity] = planningSteps(spec);
      submit(id, [
        fg,
        closure,
        proximity,
        {
          principle: 'continuity',
          dagValidation: {
            isValid: true,
            hasCycles: false,
            hasConflicts: false,
            topologicalOrder: ['task-2', 'task-1', 'task-0'],
            criticalPath: [],
          },
        },
      ]);

      const r = orch.planComplete(id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.value.executionPlan.dagValidation.topologicalOrder).toEqual([
        'task-0',
        'task-1',
        'task-2',
      ]);
      expect(r.value.executionPlan.parallelGroups).toEqual([['task-0'], ['task-1'], ['task-2']]);
    });

    it('model이 비어 있는 태스크만 힌트를 채우고 호출자가 준 값은 둔다', () => {
      const spec = makeSpec();
      const tasks = [
        { ...makeTask('task-0', [], 0), model: 'opus' as const },
        makeTask('task-1', ['task-0'], 1),
        makeTask('task-2', ['task-1'], 2),
      ];
      const id = start(spec);
      submit(id, planningSteps(spec, tasks));

      const r = orch.planComplete(id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const [first, second] = r.value.executionPlan.atomicTasks;
      expect(first!.model).toBe('opus');
      expect(second!.model).toEqual(expect.any(String));
    });

    it('계획을 세션에 넣고 plan_complete로 넘기며 검증 이벤트를 남긴다', () => {
      const spec = makeSpec();
      const id = start(spec);
      submit(id, planningSteps(spec));

      const r = orch.planComplete(id);
      expect(r.ok).toBe(true);
      if (!r.ok) return;

      const session = sessions.get(id);
      expect(session.status).toBe('plan_complete');
      expect(session.executionPlan?.planId).toBe(r.value.executionPlan.planId);
      expect(r.value.executionPlan.specId).toBe(spec.metadata.specId);
      expect(r.value.executionPlan.classifiedACs).toHaveLength(3);

      const validated = store
        .replay('execute', id)
        .filter((e) => e.eventType === EventType.EXECUTE_PLAN_VALIDATED);
      expect(validated).toHaveLength(1);
      expect(validated[0]!.payload).toEqual({ callerValid: true, serverValid: true });
    });
  });
});
