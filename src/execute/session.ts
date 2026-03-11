import { randomUUID } from 'node:crypto';
import type {
  ExecuteSession,
  ExecutionPlan,
  PlanningStepResult,
  Seed,
  TaskExecutionResult,
  EvaluationResult,
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

  create(seed: Seed): ExecuteSession {
    const session: ExecuteSession = {
      sessionId: randomUUID(),
      seedId: seed.metadata.seedId,
      seed,
      status: 'planning',
      currentStep: 1,
      planningSteps: [],
      taskResults: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(session.sessionId, session);

    this.eventStore.append('execute', session.sessionId, EventType.EXECUTE_SESSION_STARTED, {
      seedId: seed.metadata.seedId,
      goal: seed.goal,
      acCount: seed.acceptanceCriteria.length,
      seed,
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

  completeEvaluation(sessionId: string, evaluationResult: EvaluationResult): void {
    const session = this.get(sessionId);
    session.evaluationResult = evaluationResult;
    session.status = 'completed';
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_EVALUATION_COMPLETED, {
      overallScore: evaluationResult.overallScore,
      satisfiedCount: evaluationResult.verifications.filter((v) => v.satisfied).length,
      totalCount: evaluationResult.verifications.length,
      evaluationResult,
    });

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_SESSION_COMPLETED, {
      overallScore: evaluationResult.overallScore,
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
