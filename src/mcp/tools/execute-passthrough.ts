import type { PassthroughExecuteEngine } from '../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../schemas.js';
import type { PlanningStepResult } from '../../core/types.js';

export function handleExecutePassthrough(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
): string {
  switch (input.action) {
    case 'start': {
      if (!input.seed) return formatError('seed is required for start action');

      const result = engine.start(input.seed as Parameters<typeof engine.start>[0]);
      if (!result.ok) return formatError(result.error.message);

      const { session, executeContext } = result.value;
      return JSON.stringify({
        status: 'started',
        sessionId: session.sessionId,
        seedId: session.seedId,
        executeContext,
        message: `Execute session started. Use the executeContext.planningPrompt with executeContext.systemPrompt to generate the Figure-Ground classification.`,
      }, null, 2);
    }

    case 'plan_step': {
      if (!input.sessionId) return formatError('sessionId is required for plan_step action');
      if (!input.stepResult) return formatError('stepResult is required for plan_step action');

      const stepResult = buildStepResult(input.stepResult);
      if (!stepResult) return formatError('Invalid stepResult: missing required fields for the given principle');

      const result = engine.planStep(input.sessionId, stepResult);
      if (!result.ok) return formatError(result.error.message);

      const { session, executeContext, isLastStep } = result.value;

      if (isLastStep) {
        return JSON.stringify({
          status: 'planning_complete',
          sessionId: session.sessionId,
          stepsCompleted: session.planningSteps.length,
          isLastStep: true,
          message: 'All planning steps completed. Call plan_complete to assemble the execution plan.',
        }, null, 2);
      }

      return JSON.stringify({
        status: 'planning',
        sessionId: session.sessionId,
        stepsCompleted: session.planningSteps.length,
        isLastStep: false,
        executeContext,
        message: `Step ${session.planningSteps.length}/${4} complete. Use the executeContext.planningPrompt to generate the next step.`,
      }, null, 2);
    }

    case 'plan_complete': {
      if (!input.sessionId) return formatError('sessionId is required for plan_complete action');

      const result = engine.planComplete(input.sessionId);
      if (!result.ok) return formatError(result.error.message);

      const { executionPlan } = result.value;
      return JSON.stringify({
        status: 'plan_complete',
        sessionId: result.value.session.sessionId,
        executionPlan: {
          planId: executionPlan.planId,
          seedId: executionPlan.seedId,
          totalTasks: executionPlan.atomicTasks.length,
          totalGroups: executionPlan.taskGroups.length,
          dagValid: executionPlan.dagValidation.isValid,
          criticalPathLength: executionPlan.dagValidation.criticalPath.length,
          classifiedACs: executionPlan.classifiedACs,
          atomicTasks: executionPlan.atomicTasks,
          taskGroups: executionPlan.taskGroups,
          dagValidation: executionPlan.dagValidation,
        },
        message: 'Execution plan assembled and validated.',
      }, null, 2);
    }

    case 'status': {
      return handleStatus(engine, input.sessionId);
    }
  }
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

function handleStatus(engine: PassthroughExecuteEngine, sessionId?: string): string {
  try {
    if (sessionId) {
      const session = engine.getSession(sessionId);
      return JSON.stringify({
        session: {
          sessionId: session.sessionId,
          seedId: session.seedId,
          status: session.status,
          currentStep: session.currentStep,
          stepsCompleted: session.planningSteps.length,
          hasPlan: !!session.executionPlan,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      }, null, 2);
    }

    const sessions = engine.listSessions();
    return JSON.stringify({
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        seedId: s.seedId,
        status: s.status,
        stepsCompleted: s.planningSteps.length,
        hasPlan: !!s.executionPlan,
        createdAt: s.createdAt,
      })),
      total: sessions.length,
    }, null, 2);
  } catch (e) {
    return formatError(e instanceof Error ? e.message : String(e));
  }
}

function formatError(message: string): string {
  return JSON.stringify({ error: message }, null, 2);
}
