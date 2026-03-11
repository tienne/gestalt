import { randomUUID } from 'node:crypto';
import type {
  ExecuteSession,
  ExecutionPlan,
  PlanningStepResult,
  Spec,
  TaskExecutionResult,
  EvaluationResult,
  StructuralResult,
  DriftScore,
  SpecPatch,
  SpecDelta,
  FixTask,
  EvolutionGeneration,
  TerminationReason,
} from '../core/types.js';
import { ExecuteSessionNotFoundError } from '../core/errors.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { ExecuteSessionRepository } from './repository.js';

export class ExecuteSessionManager {
  private sessions = new Map<string, ExecuteSession>();

  constructor(private eventStore: EventStore) {}

  /**
   * EventStore에서 기존 세션을 복원하여 메모리 Map에 로드한다.
   * 서버 시작 시 한 번 호출.
   */
  loadFromStore(): void {
    const repo = new ExecuteSessionRepository(this.eventStore);
    const restored = repo.reconstructAll();
    for (const session of restored) {
      this.sessions.set(session.sessionId, session);
    }
  }

  create(spec: Spec): ExecuteSession {
    const session: ExecuteSession = {
      sessionId: randomUUID(),
      specId: spec.metadata.specId,
      spec,
      status: 'planning',
      currentStep: 1,
      planningSteps: [],
      taskResults: [],
      driftHistory: [],
      evolutionHistory: [],
      currentGeneration: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(session.sessionId, session);

    this.eventStore.append('execute', session.sessionId, EventType.EXECUTE_SESSION_STARTED, {
      specId: spec.metadata.specId,
      goal: spec.goal,
      acCount: spec.acceptanceCriteria.length,
      spec,
    });

    return session;
  }

  get(sessionId: string): ExecuteSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new ExecuteSessionNotFoundError(sessionId);
    return session;
  }

  addPlanningStep(sessionId: string, stepResult: PlanningStepResult): void {
    const session = this.get(sessionId);
    session.planningSteps.push(stepResult);
    session.currentStep = session.planningSteps.length + 1;
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_PLANNING_STEP_COMPLETED, {
      principle: stepResult.principle,
      stepNumber: session.planningSteps.length,
      stepResult,
    });
  }

  completePlan(sessionId: string, plan: ExecutionPlan): void {
    const session = this.get(sessionId);
    session.executionPlan = plan;
    session.status = 'plan_complete';
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_PLAN_COMPLETED, {
      planId: plan.planId,
      taskCount: plan.atomicTasks.length,
      groupCount: plan.taskGroups.length,
      executionPlan: plan,
    });
  }

  startExecution(sessionId: string): void {
    const session = this.get(sessionId);
    session.status = 'executing';
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_EXECUTION_STARTED, {
      planId: session.executionPlan?.planId,
      taskCount: session.executionPlan?.atomicTasks.length,
    });
  }

  addTaskResult(sessionId: string, taskResult: TaskExecutionResult): void {
    const session = this.get(sessionId);
    // Replace if already exists (retry case), otherwise push
    const existingIdx = session.taskResults.findIndex((r) => r.taskId === taskResult.taskId);
    if (existingIdx >= 0) {
      session.taskResults[existingIdx] = taskResult;
    } else {
      session.taskResults.push(taskResult);
    }
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_TASK_COMPLETED, {
      taskId: taskResult.taskId,
      status: taskResult.status,
      output: taskResult.output,
      artifacts: taskResult.artifacts,
    });
  }

  startStructuralEvaluation(sessionId: string): void {
    const session = this.get(sessionId);
    session.evaluateStage = 'structural';
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EVALUATE_STRUCTURAL_STARTED, {
      taskResultCount: session.taskResults.length,
    });
  }

  completeStructuralStage(sessionId: string, structuralResult: StructuralResult): void {
    const session = this.get(sessionId);
    session.structuralResult = structuralResult;
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EVALUATE_STRUCTURAL_COMPLETED, {
      allPassed: structuralResult.allPassed,
      commands: structuralResult.commands.map((c) => ({ name: c.name, exitCode: c.exitCode })),
    });
  }

  startContextualEvaluation(sessionId: string): void {
    const session = this.get(sessionId);
    session.evaluateStage = 'contextual';
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EVALUATE_CONTEXTUAL_STARTED, {
      structuralPassed: session.structuralResult?.allPassed ?? false,
    });
  }

  shortCircuitEvaluation(sessionId: string, reason: string): void {
    const session = this.get(sessionId);
    session.evaluateStage = 'complete';
    session.status = 'completed';
    session.evaluationResult = {
      verifications: session.spec.acceptanceCriteria.map((_, i) => ({
        acIndex: i,
        satisfied: false,
        evidence: 'Short-circuited due to structural failure',
        gaps: [reason],
      })),
      overallScore: 0,
      goalAlignment: 0,
      recommendations: ['Fix structural issues before contextual evaluation'],
    };
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EVALUATE_SHORT_CIRCUITED, {
      reason,
      structuralResult: session.structuralResult,
    });

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_SESSION_COMPLETED, {
      overallScore: 0,
      shortCircuited: true,
    });
  }

  completeEvaluation(sessionId: string, evaluationResult: EvaluationResult): void {
    const session = this.get(sessionId);
    session.evaluationResult = evaluationResult;
    session.evaluateStage = 'complete';
    session.status = 'completed';
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_EVALUATION_COMPLETED, {
      overallScore: evaluationResult.overallScore,
      goalAlignment: evaluationResult.goalAlignment,
      satisfiedCount: evaluationResult.verifications.filter((v) => v.satisfied).length,
      totalCount: evaluationResult.verifications.length,
      evaluationResult,
    });

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_SESSION_COMPLETED, {
      overallScore: evaluationResult.overallScore,
    });
  }

  addDriftScore(sessionId: string, driftScore: DriftScore): void {
    const session = this.get(sessionId);
    session.driftHistory.push(driftScore);
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_DRIFT_MEASURED, {
      taskId: driftScore.taskId,
      overall: driftScore.overall,
      thresholdExceeded: driftScore.thresholdExceeded,
      dimensions: driftScore.dimensions,
    });
  }

  // ─── Evolution Loop Methods ─────────────────────────────────

  startStructuralFix(sessionId: string): void {
    const session = this.get(sessionId);
    session.evolveStage = 'fix';
    session.status = 'executing';
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EVOLVE_STRUCTURAL_FIX_STARTED, {
      generation: session.currentGeneration,
      structuralResult: session.structuralResult,
    });
  }

  completeStructuralFix(sessionId: string, fixTasks: FixTask[]): void {
    const session = this.get(sessionId);
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EVOLVE_STRUCTURAL_FIX_COMPLETED, {
      generation: session.currentGeneration,
      fixCount: fixTasks.length,
      fixTasks,
    });
  }

  patchSpec(sessionId: string, patch: SpecPatch, newSpec: Spec, delta: SpecDelta): void {
    const session = this.get(sessionId);
    session.currentGeneration++;
    session.spec = newSpec;
    session.evolveStage = 'patch';
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EVOLVE_SPEC_PATCHED, {
      generation: session.currentGeneration,
      patch,
      spec: newSpec,
      delta,
    });
  }

  startReExecution(sessionId: string, taskIds: string[]): void {
    const session = this.get(sessionId);
    session.evolveStage = 're_executing';
    session.status = 'executing';
    // Clear results for tasks being re-executed
    session.taskResults = session.taskResults.filter((r) => !taskIds.includes(r.taskId));
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EVOLVE_RE_EXECUTION_STARTED, {
      generation: session.currentGeneration,
      taskIds,
    });
  }

  addEvolveTaskResult(sessionId: string, taskResult: TaskExecutionResult): void {
    const session = this.get(sessionId);
    const existingIdx = session.taskResults.findIndex((r) => r.taskId === taskResult.taskId);
    if (existingIdx >= 0) {
      session.taskResults[existingIdx] = taskResult;
    } else {
      session.taskResults.push(taskResult);
    }
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EVOLVE_TASK_COMPLETED, {
      generation: session.currentGeneration,
      taskId: taskResult.taskId,
      status: taskResult.status,
      output: taskResult.output,
      artifacts: taskResult.artifacts,
    });
  }

  recordEvolutionGeneration(sessionId: string, generation: EvolutionGeneration): void {
    const session = this.get(sessionId);
    session.evolutionHistory.push(generation);
    session.updatedAt = new Date().toISOString();
  }

  terminate(sessionId: string, reason: TerminationReason): void {
    const session = this.get(sessionId);
    session.terminationReason = reason;
    session.status = reason === 'success' ? 'completed' : 'failed';
    session.evolveStage = undefined;
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EVOLVE_TERMINATED, {
      reason,
      generation: session.currentGeneration,
      scoreHistory: session.evolutionHistory.map((g) => g.evaluationScore),
      evolutionHistory: session.evolutionHistory,
    });
  }

  fail(sessionId: string, reason: string): void {
    const session = this.get(sessionId);
    session.status = 'failed';
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_SESSION_FAILED, {
      reason,
    });
  }

  list(): ExecuteSession[] {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt),
    );
  }
}
