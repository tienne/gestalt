import { randomUUID } from 'node:crypto';
import type {
  ExecuteSession,
  ExecutionPlan,
  PlanningStepResult,
  Seed,
} from '../core/types.js';
import { ExecuteSessionNotFoundError } from '../core/errors.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';

export class ExecuteSessionManager {
  private sessions = new Map<string, ExecuteSession>();

  constructor(private eventStore: EventStore) {}

  create(seed: Seed): ExecuteSession {
    const session: ExecuteSession = {
      sessionId: randomUUID(),
      seedId: seed.metadata.seedId,
      seed,
      status: 'planning',
      currentStep: 1,
      planningSteps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(session.sessionId, session);

    this.eventStore.append('execute', session.sessionId, EventType.EXECUTE_SESSION_STARTED, {
      seedId: seed.metadata.seedId,
      goal: seed.goal,
      acCount: seed.acceptanceCriteria.length,
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
