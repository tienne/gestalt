import type { PassthroughExecuteEngine } from '../../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../../schemas.js';
import type { PlanningStepResult, NextActionGuide } from '../../../core/types.js';
import type { ClientType } from '../../../execute/rule-writer.js';
import { formatError, stripContextPrompts } from './utils.js';

export function handleStart(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _client: ClientType,
): string {
  const verbose = input.verbose !== false;

  if (!input.spec) return formatError('spec is required for start action');

  const result = engine.start(input.spec as Parameters<typeof engine.start>[0], {
    codeGraphRepoRoot: input.codeGraphRepoRoot,
  });
  if (!result.ok) return formatError(result.error.message);

  const { session, executeContext } = result.value;
  const startGuide: NextActionGuide = {
    nextAction: 'plan_step',
    nextActionParams: { sessionId: session.sessionId },
    hint: 'executeContext.planningPrompt를 사용해 figure_ground 분류를 수행하세요.',
  };
  return JSON.stringify(
    {
      status: 'started',
      sessionId: session.sessionId,
      specId: session.specId,
      executeContext: verbose
        ? executeContext
        : stripContextPrompts(executeContext as unknown as Record<string, unknown>),
      message: `Execute session started. Use the executeContext.planningPrompt with executeContext.systemPrompt to generate the Figure-Ground classification.`,
      ...startGuide,
    },
    null,
    2,
  );
}

export function handlePlanStep(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _client: ClientType,
): string {
  const verbose = input.verbose !== false;

  if (!input.sessionId) return formatError('sessionId is required for plan_step action');
  if (!input.stepResult) return formatError('stepResult is required for plan_step action');

  const stepResult = buildStepResult(input.stepResult);
  if (!stepResult)
    return formatError('Invalid stepResult: missing required fields for the given principle');

  const result = engine.planStep(input.sessionId, stepResult);
  if (!result.ok) return formatError(result.error.message);

  const { session, executeContext, isLastStep } = result.value;

  if (isLastStep) {
    const planStepLastGuide: NextActionGuide = {
      nextAction: 'plan_complete',
      nextActionParams: { sessionId: session.sessionId },
      hint: '4단계 Planning 완료. plan_complete를 호출하세요.',
    };
    return JSON.stringify(
      {
        status: 'planning_complete',
        sessionId: session.sessionId,
        stepsCompleted: session.planningSteps.length,
        isLastStep: true,
        message:
          'All planning steps completed. Call plan_complete to assemble the execution plan.',
        ...planStepLastGuide,
      },
      null,
      2,
    );
  }

  const currentPrinciple = executeContext?.currentPrinciple ?? 'next';
  const planStepGuide: NextActionGuide = {
    nextAction: 'plan_step',
    nextActionParams: { sessionId: session.sessionId },
    hint: `다음 단계: ${currentPrinciple}. executeContext.planningPrompt를 사용하세요.`,
  };
  return JSON.stringify(
    {
      status: 'planning',
      sessionId: session.sessionId,
      stepsCompleted: session.planningSteps.length,
      isLastStep: false,
      executeContext: verbose
        ? executeContext
        : stripContextPrompts(executeContext as unknown as Record<string, unknown>),
      message: `Step ${session.planningSteps.length}/${4} complete. Use the executeContext.planningPrompt to generate the next step.`,
      ...planStepGuide,
    },
    null,
    2,
  );
}

export function handlePlanComplete(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _client: ClientType,
): string {
  if (!input.sessionId) return formatError('sessionId is required for plan_complete action');

  const result = engine.planComplete(input.sessionId);
  if (!result.ok) return formatError(result.error.message);

  const { executionPlan } = result.value;
  const planSummary = {
    totalTasks: executionPlan.atomicTasks.length,
    groupCount: executionPlan.taskGroups.length,
    criticalPathLength: executionPlan.dagValidation.criticalPath.length,
    parallelGroupCount: executionPlan.parallelGroups?.length ?? 0,
  };
  const planCompleteGuide: NextActionGuide = {
    nextAction: 'execute_start',
    nextActionParams: { sessionId: result.value.session.sessionId },
    hint: '실행 계획이 준비됐습니다. execute_start를 호출하세요.',
  };
  return JSON.stringify(
    {
      status: 'plan_complete',
      sessionId: result.value.session.sessionId,
      planSummary,
      executionPlan: {
        planId: executionPlan.planId,
        specId: executionPlan.specId,
        totalTasks: executionPlan.atomicTasks.length,
        totalGroups: executionPlan.taskGroups.length,
        dagValid: executionPlan.dagValidation.isValid,
        criticalPathLength: executionPlan.dagValidation.criticalPath.length,
        classifiedACs: executionPlan.classifiedACs,
        atomicTasks: executionPlan.atomicTasks,
        taskGroups: executionPlan.taskGroups,
        dagValidation: executionPlan.dagValidation,
        parallelGroups: executionPlan.parallelGroups,
      },
      nextStep:
        'Call execute_start to begin task execution. Tasks will run in topological order — critical path has ' +
        planSummary.criticalPathLength +
        ' tasks.',
      message:
        'Execution plan assembled and validated. Call execute_start to begin task execution.',
      ...planCompleteGuide,
    },
    null,
    2,
  );
}

function buildStepResult(raw: NonNullable<ExecuteInput['stepResult']>): PlanningStepResult | null {
  switch (raw.principle) {
    case 'figure_ground':
      if (!raw.classifiedACs) return null;
      return { principle: 'figure_ground', classifiedACs: raw.classifiedACs };
    case 'closure':
      if (!raw.atomicTasks) return null;
      return { principle: 'closure', atomicTasks: raw.atomicTasks };
    case 'proximity':
      if (!raw.taskGroups) return null;
      return { principle: 'proximity', taskGroups: raw.taskGroups };
    case 'continuity':
      if (!raw.dagValidation) return null;
      return { principle: 'continuity', dagValidation: raw.dagValidation };
    default:
      return null;
  }
}
