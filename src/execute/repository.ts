import type { EventStore } from '../events/store.js';
import type {
  DomainEvent,
  ExecuteSession,
  Seed,
  PlanningStepResult,
  ExecutionPlan,
  TaskExecutionResult,
  EvaluationResult,
} from '../core/types.js';
import { EventType } from '../events/types.js';

/**
 * ExecuteSessionRepository — Event Replay 기반 ExecuteSession 재구성.
 * 도메인 전용 Repository: aggregate_type='execute' 이벤트만 처리.
 */
export class ExecuteSessionRepository {
  constructor(private eventStore: EventStore) {}

  /**
   * 이벤트를 fold하여 ExecuteSession 상태를 완전히 복원한다.
   */
  reconstruct(sessionId: string): ExecuteSession | null {
    const events = this.eventStore.replay('execute', sessionId);
    if (events.length === 0) return null;

    return this.foldEvents(sessionId, events);
  }

  /**
   * 모든 Execute 세션 ID 목록을 반환한다.
   */
  list(): string[] {
    return this.eventStore.listAggregates('execute');
  }

  /**
   * 모든 Execute 세션을 재구성하여 반환한다.
   */
  reconstructAll(): ExecuteSession[] {
    const ids = this.list();
    const sessions: ExecuteSession[] = [];
    for (const id of ids) {
      const session = this.reconstruct(id);
      if (session) sessions.push(session);
    }
    return sessions;
  }

  private foldEvents(sessionId: string, events: DomainEvent[]): ExecuteSession {
    const firstEvent = events[0]!;
    const startPayload = firstEvent.payload as {
      seedId: string;
      goal: string;
      seed?: Seed;
    };

    const session: ExecuteSession = {
      sessionId,
      seedId: startPayload.seedId ?? '',
      seed: startPayload.seed ?? this.buildMinimalSeed(startPayload),
      status: 'planning',
      currentStep: 1,
      planningSteps: [],
      taskResults: [],
      createdAt: firstEvent.timestamp,
      updatedAt: firstEvent.timestamp,
    };

    for (const event of events) {
      this.applyEvent(session, event);
    }

    return session;
  }

  private applyEvent(session: ExecuteSession, event: DomainEvent): void {
    session.updatedAt = event.timestamp;
    const payload = event.payload as Record<string, unknown>;

    switch (event.eventType) {
      case EventType.EXECUTE_SESSION_STARTED:
        // 이미 초기 상태에서 처리됨
        break;

      case EventType.EXECUTE_PLANNING_STEP_COMPLETED: {
        const stepResult = payload.stepResult as PlanningStepResult | undefined;
        if (stepResult) {
          session.planningSteps.push(stepResult);
          session.currentStep = session.planningSteps.length + 1;
        }
        break;
      }

      case EventType.EXECUTE_PLAN_COMPLETED: {
        const executionPlan = payload.executionPlan as ExecutionPlan | undefined;
        if (executionPlan) {
          session.executionPlan = executionPlan;
        }
        session.status = 'plan_complete';
        break;
      }

      case EventType.EXECUTE_EXECUTION_STARTED:
        session.status = 'executing';
        break;

      case EventType.EXECUTE_TASK_COMPLETED: {
        const taskResult: TaskExecutionResult = {
          taskId: payload.taskId as string,
          status: payload.status as TaskExecutionResult['status'],
          output: (payload.output as string) ?? '',
          artifacts: (payload.artifacts as string[]) ?? [],
        };
        // Replace if retry, otherwise push
        const existingIdx = session.taskResults.findIndex((r) => r.taskId === taskResult.taskId);
        if (existingIdx >= 0) {
          session.taskResults[existingIdx] = taskResult;
        } else {
          session.taskResults.push(taskResult);
        }
        break;
      }

      case EventType.EXECUTE_EVALUATION_COMPLETED: {
        const evaluationResult = payload.evaluationResult as EvaluationResult | undefined;
        if (evaluationResult) {
          session.evaluationResult = evaluationResult;
        }
        break;
      }

      case EventType.EXECUTE_SESSION_COMPLETED:
        session.status = 'completed';
        break;

      case EventType.EXECUTE_SESSION_FAILED:
        session.status = 'failed';
        break;

      // EXECUTE_PLAN_VALIDATED — 검증 메타데이터, 세션 상태에 직접 영향 없음
      default:
        break;
    }
  }

  /**
   * 이전 payload 형식(seed 전체 없음)을 위한 최소 Seed 생성.
   * 재구성은 되지만 일부 데이터가 불완전할 수 있음.
   */
  private buildMinimalSeed(startPayload: { seedId: string; goal: string }): Seed {
    return {
      version: '1.0',
      goal: startPayload.goal ?? '',
      constraints: [],
      acceptanceCriteria: [],
      ontologySchema: { entities: [], relations: [] },
      gestaltAnalysis: [],
      metadata: {
        seedId: startPayload.seedId ?? '',
        interviewSessionId: '',
        ambiguityScore: 0,
        generatedAt: '',
      },
    };
  }
}
