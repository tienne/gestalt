import type { PassthroughExecuteEngine } from '../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../schemas.js';
import type { PlanningStepResult } from '../../core/types.js';

export function handleExecutePassthrough(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
): string {
  switch (input.action) {
    case 'start': {
      if (!input.spec) return formatError('spec is required for start action');

      const result = engine.start(input.spec as Parameters<typeof engine.start>[0]);
      if (!result.ok) return formatError(result.error.message);

      const { session, executeContext } = result.value;
      return JSON.stringify({
        status: 'started',
        sessionId: session.sessionId,
        specId: session.specId,
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
          specId: executionPlan.specId,
          totalTasks: executionPlan.atomicTasks.length,
          totalGroups: executionPlan.taskGroups.length,
          dagValid: executionPlan.dagValidation.isValid,
          criticalPathLength: executionPlan.dagValidation.criticalPath.length,
          classifiedACs: executionPlan.classifiedACs,
          atomicTasks: executionPlan.atomicTasks,
          taskGroups: executionPlan.taskGroups,
          dagValidation: executionPlan.dagValidation,
        },
        message: 'Execution plan assembled and validated. Call execute_start to begin task execution.',
      }, null, 2);
    }

    case 'execute_start': {
      if (!input.sessionId) return formatError('sessionId is required for execute_start action');

      const result = engine.startExecution(input.sessionId);
      if (!result.ok) return formatError(result.error.message);

      const { session, taskContext, allTasksCompleted } = result.value;

      if (allTasksCompleted) {
        return JSON.stringify({
          status: 'all_tasks_completed',
          sessionId: session.sessionId,
          message: 'All tasks already completed. Call evaluate to verify acceptance criteria.',
        }, null, 2);
      }

      return JSON.stringify({
        status: 'executing',
        sessionId: session.sessionId,
        taskContext,
        message: `Execution started. Use taskContext.taskPrompt with taskContext.systemPrompt to implement the task, then submit with execute_task.`,
      }, null, 2);
    }

    case 'execute_task': {
      if (!input.sessionId) return formatError('sessionId is required for execute_task action');
      if (!input.taskResult) return formatError('taskResult is required for execute_task action');

      const result = engine.submitTaskResult(input.sessionId, input.taskResult);
      if (!result.ok) return formatError(result.error.message);

      const { session, taskContext, allTasksCompleted, driftScore, retrospectiveContext } = result.value;

      if (allTasksCompleted) {
        return JSON.stringify({
          status: 'all_tasks_completed',
          sessionId: session.sessionId,
          completedTasks: session.taskResults.length,
          ...(driftScore ? { driftScore } : {}),
          ...(retrospectiveContext ? { retrospectiveContext } : {}),
          message: 'All tasks completed. Call evaluate to verify acceptance criteria.',
        }, null, 2);
      }

      return JSON.stringify({
        status: 'executing',
        sessionId: session.sessionId,
        completedTasks: session.taskResults.length,
        taskContext,
        ...(driftScore ? { driftScore } : {}),
        ...(retrospectiveContext ? { retrospectiveContext } : {}),
        message: `Task "${input.taskResult.taskId}" recorded.${driftScore?.thresholdExceeded ? ' WARNING: Drift threshold exceeded! Review retrospectiveContext.' : ''} Use taskContext.taskPrompt to implement the next task.`,
      }, null, 2);
    }

    case 'evaluate': {
      if (!input.sessionId) return formatError('sessionId is required for evaluate action');

      // Call 3: Submit contextual evaluation result
      if (input.evaluationResult) {
        const result = engine.submitEvaluation(input.sessionId, input.evaluationResult);
        if (!result.ok) return formatError(result.error.message);

        const { evaluationResult } = result.value;
        return JSON.stringify({
          status: 'completed',
          sessionId: result.value.session.sessionId,
          stage: 'complete',
          evaluationResult,
          message: `Evaluation complete. Overall score: ${evaluationResult!.overallScore.toFixed(2)}, goal alignment: ${evaluationResult!.goalAlignment.toFixed(2)}. Session is now completed.`,
        }, null, 2);
      }

      // Call 2: Submit structural results
      if (input.structuralResult) {
        const result = engine.submitStructuralResult(input.sessionId, input.structuralResult);
        if (!result.ok) return formatError(result.error.message);

        const { stage, shortCircuited, contextualContext, evaluationResult } = result.value;

        if (shortCircuited) {
          return JSON.stringify({
            status: 'completed',
            sessionId: result.value.session.sessionId,
            stage: 'complete',
            shortCircuited: true,
            evaluationResult,
            message: 'Structural checks failed. Evaluation short-circuited. Fix structural issues and retry.',
          }, null, 2);
        }

        return JSON.stringify({
          status: 'evaluating',
          sessionId: result.value.session.sessionId,
          stage,
          contextualContext,
          message: 'Structural checks passed. Use contextualContext.evaluatePrompt with contextualContext.systemPrompt to generate the contextual evaluation.',
        }, null, 2);
      }

      // Call 1: Start evaluation → return structural commands
      const result = engine.startEvaluation(input.sessionId);
      if (!result.ok) return formatError(result.error.message);

      return JSON.stringify({
        status: 'evaluating',
        sessionId: result.value.session.sessionId,
        stage: 'structural',
        structuralContext: result.value.structuralContext,
        message: 'Run structural checks (lint, build, test) and submit results with structuralResult.',
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
          specId: session.specId,
          status: session.status,
          currentStep: session.currentStep,
          stepsCompleted: session.planningSteps.length,
          hasPlan: !!session.executionPlan,
          taskResults: session.taskResults.length,
          evaluateStage: session.evaluateStage ?? null,
          hasEvaluation: !!session.evaluationResult,
          driftAlerts: session.driftHistory.filter((d) => d.thresholdExceeded).length,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      }, null, 2);
    }

    const sessions = engine.listSessions();
    return JSON.stringify({
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        specId: s.specId,
        status: s.status,
        stepsCompleted: s.planningSteps.length,
        hasPlan: !!s.executionPlan,
        taskResults: s.taskResults.length,
        hasEvaluation: !!s.evaluationResult,
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
