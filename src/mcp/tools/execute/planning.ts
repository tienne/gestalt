import { real } from '../../../conductor/parent-worktree.js';
import { githubRepositoryName } from '../../../harness-review/related-repos.js';
import { isDeepStrictEqual } from 'node:util';
import type { PassthroughExecuteEngine } from '../../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../../schemas.js';
import type { ExecuteSession, PlanningStepResult, NextActionGuide } from '../../../core/types.js';
import type { IHostAdapter } from '../../host-adapter.js';
import { formatError, stripContextPrompts } from './utils.js';
import { sanitizeSurfaceContext, getStageLabel } from '../../../gestalt/surface-labels.js';
import { specSchema } from '../../../spec/schema.js';
import { validateFinalizedSession } from '../../../conductor/prepared-plan.js';
import { PlanningRewoundError } from '../../../execute/orchestrators/planning.js';

export function handleStart(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _adapter: IHostAdapter,
): string {
  const verbose = input.verbose !== false;

  if (!input.spec) return formatError('spec is required for start action');

  const result = engine.start(input.spec as Parameters<typeof engine.start>[0], {
    codeGraphRepoRoot: input.codeGraphRepoRoot,
    conductorPlan: input.action === 'prepare_conductor',
  });
  if (!result.ok) return formatError(result.error.message);

  const { session, executeContext } = result.value;
  const startGuide: NextActionGuide = {
    nextAction: 'plan_step',
    nextActionParams: { sessionId: session.sessionId },
    hint: `executeContext.planningPrompt를 사용해 첫 단계(${getStageLabel(executeContext.currentPrinciple)})를 수행하세요.`,
  };
  const sanitizedStartContext = sanitizeSurfaceContext(
    executeContext as unknown as Record<string, unknown>,
  );
  return JSON.stringify(
    {
      status: 'started',
      sessionId: session.sessionId,
      specId: session.specId,
      executeContext: verbose ? sanitizedStartContext : stripContextPrompts(sanitizedStartContext),
      message: `Execute session started. Use the executeContext.planningPrompt with executeContext.systemPrompt to generate the first planning step (${getStageLabel(executeContext.currentPrinciple, 'en')}).`,
      ...startGuide,
    },
    null,
    2,
  );
}

export function handlePrepareConductor(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  adapter: IHostAdapter,
): string {
  try {
    if ((input.spec && (input.sessionId || input.planId)) || (input.sessionId && input.planId))
      return formatError('Select one of spec, sessionId or planId');
    const root = real(input.codeGraphRepoRoot ?? input.cwd ?? process.cwd());
    const target = githubRepositoryName(root);
    const belongsToTarget = (candidate: ExecuteSession) =>
      candidate.targetRepository?.name === target &&
      candidate.targetRepository &&
      githubRepositoryName(candidate.targetRepository.root) === target;
    let session: ExecuteSession | undefined;
    if (input.sessionId) {
      session = engine.getSession(input.sessionId);
    } else {
      const spec = input.spec ? specSchema.parse(input.spec) : undefined;
      if (!spec && !input.planId) return formatError('spec, sessionId or planId is required');
      const matches = engine
        .getSessionManager()
        .listPersisted()
        .filter(
          (candidate) =>
            !candidate.assignedWorktree &&
            (input.planId
              ? candidate.executionPlan?.planId === input.planId
              : candidate.specId === spec?.metadata.specId &&
                (candidate.status === 'planning' || candidate.status === 'plan_complete') &&
                belongsToTarget(candidate)),
        );
      const ready = input.planId
        ? matches
        : matches.filter((candidate) => {
            try {
              return Boolean(validateFinalizedSession(candidate));
            } catch {
              return false;
            }
          });
      const candidates = ready.length
        ? ready
        : matches.filter((candidate) => candidate.status === 'planning');
      if (candidates.length > 1)
        return formatError('실행 세션이 여러 개예요. 세션이나 계획 ID를 골라 주세요');
      session = candidates[0];
      if (session && spec && !isDeepStrictEqual(specSchema.parse(session.spec), spec))
        return formatError('저장된 실행 세션의 Spec 내용이 선택한 Spec과 달라요');
      if (!session && spec) {
        if (!target) return formatError('현재 작업 위치의 대상 레포를 확인할 수 없어요');
        return handleStart(engine, { ...input, codeGraphRepoRoot: root, spec }, adapter);
      }
    }
    if (!session) return formatError('지정한 실행 계획을 찾지 못했어요');
    if (
      session.assignedWorktree ||
      (session.status !== 'planning' && session.status !== 'plan_complete')
    )
      return formatError('구현을 시작하기 전의 원본 실행 세션을 골라 주세요');
    engine.getSessionManager().selectConductorPlan(session.sessionId, root, target);
    if (session.status === 'plan_complete' && session.executionPlan)
      return formatConductorReady(session);
    const executeContext = engine.resumePlanning(session);
    const context = executeContext
      ? sanitizeSurfaceContext(executeContext as unknown as Record<string, unknown>)
      : undefined;
    return JSON.stringify({
      status: 'planning',
      sessionId: session.sessionId,
      specId: session.specId,
      stepsCompleted: session.planningSteps.length,
      executeContext: input.verbose === false ? stripContextPrompts(context) : context,
      nextAction: context ? 'plan_step' : 'plan_complete',
      nextActionParams: { sessionId: session.sessionId },
    });
  } catch (error) {
    return formatError(error instanceof Error ? error.message : String(error));
  }
}

function formatConductorReady(session: ExecuteSession): string {
  if (!session.conductorPlan || !session.targetRepository)
    throw new Error(
      '계획의 기준 레포가 기록되지 않았어요. 현재 레포에서 Spec으로 계획을 다시 준비해 주세요',
    );
  const plan = validateFinalizedSession(session);
  return JSON.stringify({
    status: 'ready_for_conductor',
    sessionId: session.sessionId,
    specId: plan.specId,
    planId: plan.planId,
  });
}

export function handlePlanStep(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _adapter: IHostAdapter,
): string {
  const verbose = input.verbose !== false;

  if (!input.sessionId) return formatError('sessionId is required for plan_step action');
  if (!input.stepResult) return formatError('stepResult is required for plan_step action');

  const stepResult = buildStepResult(input.stepResult);
  if (!stepResult)
    return formatError('Invalid stepResult: missing required fields for the given principle');

  const result = engine.planStep(input.sessionId, stepResult);
  if (!result.ok) {
    if (result.error instanceof PlanningRewoundError) {
      return formatRewound(input.sessionId, result.error, verbose);
    }
    return formatError(result.error.message);
  }

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
        message: 'All planning steps completed. Call plan_complete to assemble the execution plan.',
        ...planStepLastGuide,
      },
      null,
      2,
    );
  }

  const currentStage = getStageLabel(executeContext?.currentPrinciple ?? 'next');
  const planStepGuide: NextActionGuide = {
    nextAction: 'plan_step',
    nextActionParams: { sessionId: session.sessionId },
    hint: `다음 단계: ${currentStage}. executeContext.planningPrompt를 사용하세요.`,
  };
  const sanitizedStepContext = sanitizeSurfaceContext(
    executeContext as unknown as Record<string, unknown>,
  );
  return JSON.stringify(
    {
      status: 'planning',
      sessionId: session.sessionId,
      stepsCompleted: session.planningSteps.length,
      isLastStep: false,
      executeContext: verbose ? sanitizedStepContext : stripContextPrompts(sanitizedStepContext),
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
  _adapter: IHostAdapter,
): string {
  if (!input.sessionId) return formatError('sessionId is required for plan_complete action');
  const verbose = input.verbose !== false;

  if (input.conductor) {
    try {
      engine
        .getSessionManager()
        .selectConductorPlan(input.sessionId, input.codeGraphRepoRoot ?? input.cwd);
    } catch (error) {
      return JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        sessionId: input.sessionId,
        nextStep: '현재 레포의 origin을 확인한 뒤 Spec으로 계획을 다시 준비해 주세요',
      });
    }
  }

  const result = engine.planComplete(input.sessionId);
  if (!result.ok) {
    if (result.error instanceof PlanningRewoundError) {
      return formatRewound(input.sessionId, result.error, verbose);
    }
    return formatError(result.error.message);
  }

  if (input.conductor) {
    try {
      return formatConductorReady(result.value.session);
    } catch (error) {
      return formatError(error instanceof Error ? error.message : String(error));
    }
  }

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

// error 필드를 함께 실어 이 응답을 성공으로 읽고 다음 단계로 넘어가는 호출자를 막는다
function formatRewound(sessionId: string, error: PlanningRewoundError, verbose: boolean): string {
  const { dagValidation, executeContext } = error;
  const stage = getStageLabel(executeContext.currentPrinciple);
  const guide: NextActionGuide = {
    nextAction: 'plan_step',
    nextActionParams: { sessionId },
    hint: `의존 관계 DAG가 유효하지 않아 ${stage} 단계로 되감았습니다. cycleDetails와 conflictDetails를 보고 dependsOn을 고친 뒤 ${stage}부터 다시 제출하세요.`,
  };
  const sanitizedContext = sanitizeSurfaceContext(
    executeContext as unknown as Record<string, unknown>,
  );
  return JSON.stringify(
    {
      error: error.message,
      status: 'plan_rewound',
      sessionId,
      rewoundToStep: executeContext.stepNumber,
      hasCycles: dagValidation.hasCycles,
      cycleDetails: dagValidation.cycleDetails ?? [],
      conflictDetails: dagValidation.conflictDetails ?? [],
      executeContext: verbose ? sanitizedContext : stripContextPrompts(sanitizedContext),
      ...guide,
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
