import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createExecuteFixture,
  figureGround,
  planningSteps,
  linearTasks,
  makeTask,
  type ExecuteFixture,
} from '../../helpers/execute-fixture.js';

/**
 * plan_step, plan_complete를 핸들러 입구(handleExecutePassthrough)에서 부른다.
 * 엔진 테스트가 못 보는 부분, 즉 stepResult 재조립과 응답 모양, nextAction 안내를 본다.
 */

interface PlanStepResponse {
  error?: string;
  status?: string;
  stepsCompleted?: number;
  isLastStep?: boolean;
  executeContext?: Record<string, unknown>;
  nextAction?: string;
  nextActionParams?: { sessionId: string };
}

interface PlanCompleteResponse {
  error?: string;
  status?: string;
  planSummary?: {
    totalTasks: number;
    groupCount: number;
    criticalPathLength: number;
    parallelGroupCount: number;
  };
  executionPlan?: {
    totalTasks: number;
    dagValid: boolean;
    atomicTasks: Array<{ taskId: string; model?: string }>;
    dagValidation: { topologicalOrder: string[] };
    parallelGroups?: string[][];
  };
  nextAction?: string;
}

describe('ges_execute plan_step 핸들러', () => {
  let fx: ExecuteFixture;

  beforeEach(() => {
    fx = createExecuteFixture('handlers-planning');
  });
  afterEach(() => fx.close());

  it('sessionId가 없으면 에러를 돌려준다', async () => {
    const res = await fx.call<PlanStepResponse>({
      action: 'plan_step',
      stepResult: figureGround(fx.startedSession().spec),
    });
    expect(res.error).toContain('sessionId is required');
  });

  it('stepResult가 없으면 에러를 돌려준다', async () => {
    const { sessionId } = fx.startedSession();
    const res = await fx.call<PlanStepResponse>({ action: 'plan_step', sessionId });
    expect(res.error).toContain('stepResult is required');
  });

  it.each(['figure_ground', 'closure', 'proximity', 'continuity'] as const)(
    '%s 원리의 결과 필드가 빠지면 엔진까지 안 가고 막는다',
    async (principle) => {
      const { sessionId } = fx.startedSession();
      const res = await fx.call<PlanStepResponse>({
        action: 'plan_step',
        sessionId,
        stepResult: { principle },
      });
      expect(res.error).toContain('Invalid stepResult');
      expect(fx.engine.getSession(sessionId).planningSteps).toHaveLength(0);
    },
  );

  it('중간 단계면 planning 상태와 다음 단계 컨텍스트를 돌려준다', async () => {
    const { sessionId, spec } = fx.startedSession();
    const res = await fx.call<PlanStepResponse>({
      action: 'plan_step',
      sessionId,
      stepResult: figureGround(spec),
    });

    expect(res.status).toBe('planning');
    expect(res.stepsCompleted).toBe(1);
    expect(res.isLastStep).toBe(false);
    expect(res.nextAction).toBe('plan_step');
    expect(res.nextActionParams?.sessionId).toBe(sessionId);
    expect(res.executeContext?.planningPrompt).toEqual(expect.any(String));
  });

  it('verbose=false면 프롬프트 필드를 걷어낸다', async () => {
    const { sessionId, spec } = fx.startedSession();
    const res = await fx.call<PlanStepResponse>({
      action: 'plan_step',
      sessionId,
      verbose: false,
      stepResult: figureGround(spec),
    });

    expect(res.executeContext).toBeDefined();
    expect(res.executeContext).not.toHaveProperty('planningPrompt');
    expect(res.executeContext).not.toHaveProperty('systemPrompt');
  });

  it('executeContext의 원리 필드는 단계 라벨로 바뀌어 나간다', async () => {
    const { sessionId, spec } = fx.startedSession();
    const res = await fx.call<PlanStepResponse>({
      action: 'plan_step',
      sessionId,
      stepResult: figureGround(spec),
    });

    expect(res.executeContext).not.toHaveProperty('currentPrinciple');
    expect(res.executeContext).not.toHaveProperty('principleStrategy');
    expect(res.executeContext?.currentStage).toEqual(expect.any(String));
  });

  it('네 번째 단계를 내면 planning_complete와 plan_complete 안내를 돌려준다', async () => {
    const { sessionId, spec } = fx.startedSession();
    const steps = planningSteps(spec);
    let res: PlanStepResponse = {};
    for (const step of steps) {
      res = await fx.call<PlanStepResponse>({ action: 'plan_step', sessionId, stepResult: step });
    }

    expect(res.status).toBe('planning_complete');
    expect(res.isLastStep).toBe(true);
    expect(res.stepsCompleted).toBe(4);
    expect(res.nextAction).toBe('plan_complete');
    expect(res).not.toHaveProperty('executeContext');
  });

  it('순서가 어긋난 단계는 엔진 에러 메시지를 그대로 돌려준다', async () => {
    const { sessionId, spec } = fx.startedSession();
    const [, closure] = planningSteps(spec);
    const res = await fx.call<PlanStepResponse>({
      action: 'plan_step',
      sessionId,
      stepResult: closure,
    });
    expect(res.error).toContain('Expected principle "figure_ground"');
  });
});

describe('ges_execute plan_complete 핸들러', () => {
  let fx: ExecuteFixture;

  beforeEach(() => {
    fx = createExecuteFixture('handlers-plan-complete');
  });
  afterEach(() => fx.close());

  async function runAllSteps(tasks = linearTasks): Promise<string> {
    const { sessionId, spec } = fx.startedSession();
    for (const step of planningSteps(spec, tasks)) {
      await fx.call({ action: 'plan_step', sessionId, stepResult: step });
    }
    return sessionId;
  }

  it('sessionId가 없으면 에러를 돌려준다', async () => {
    const res = await fx.call<PlanCompleteResponse>({ action: 'plan_complete' });
    expect(res.error).toContain('sessionId is required');
  });

  it('플래닝이 덜 끝났으면 에러를 돌려준다', async () => {
    const { sessionId, spec } = fx.startedSession();
    await fx.call({ action: 'plan_step', sessionId, stepResult: figureGround(spec) });

    const res = await fx.call<PlanCompleteResponse>({ action: 'plan_complete', sessionId });
    expect(res.error).toContain('1/4');
  });

  it('planSummary와 executionPlan 숫자가 서로 맞고 execute_start를 안내한다', async () => {
    const sessionId = await runAllSteps();
    const res = await fx.call<PlanCompleteResponse>({ action: 'plan_complete', sessionId });

    expect(res.status).toBe('plan_complete');
    expect(res.planSummary).toEqual({
      totalTasks: 3,
      groupCount: 1,
      criticalPathLength: res.executionPlan!.dagValidation.topologicalOrder.length,
      parallelGroupCount: expect.any(Number),
    });
    expect(res.executionPlan?.totalTasks).toBe(3);
    expect(res.executionPlan?.dagValid).toBe(true);
    expect(res.nextAction).toBe('execute_start');
  });

  it('응답의 atomicTasks에는 서버가 붙인 model 힌트가 들어 있다', async () => {
    const sessionId = await runAllSteps();
    const res = await fx.call<PlanCompleteResponse>({ action: 'plan_complete', sessionId });

    expect(res.executionPlan!.atomicTasks).toHaveLength(3);
    for (const task of res.executionPlan!.atomicTasks) {
      expect(task.model).toEqual(expect.any(String));
    }
  });

  it('완료 후 세션이 plan_complete로 넘어가 plan_step을 더 받지 않는다', async () => {
    const sessionId = await runAllSteps();
    await fx.call({ action: 'plan_complete', sessionId });
    expect(fx.engine.getSession(sessionId).status).toBe('plan_complete');

    const res = await fx.call<PlanStepResponse>({
      action: 'plan_step',
      sessionId,
      stepResult: figureGround(fx.engine.getSession(sessionId).spec),
    });
    expect(res.error).toContain('not in planning state');
  });

  it('같은 선행 태스크를 기다리는 태스크끼리 한 병렬 그룹으로 묶인다', async () => {
    const diamond = [
      makeTask('task-0', [], 0),
      makeTask('task-1', ['task-0'], 1),
      makeTask('task-2', ['task-0'], 2),
    ];
    const { sessionId, spec } = fx.startedSession();
    for (const step of planningSteps(spec, diamond)) {
      await fx.call({ action: 'plan_step', sessionId, stepResult: step });
    }
    const res = await fx.call<PlanCompleteResponse>({ action: 'plan_complete', sessionId });

    expect(res.executionPlan?.parallelGroups).toEqual([['task-0'], ['task-1', 'task-2']]);
    expect(res.planSummary?.parallelGroupCount).toBe(2);
  });
});
