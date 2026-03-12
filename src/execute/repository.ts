import type { EventStore } from '../events/store.js';
import type {
  DomainEvent,
  ExecuteSession,
  Spec,
  PlanningStepResult,
  ExecutionPlan,
  TaskExecutionResult,
  EvaluationResult,
  StructuralResult,
  DriftScore,
  SpecDelta,
  TerminationReason,
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
      specId: string;
      goal: string;
      spec?: Spec;
    };

    const session: ExecuteSession = {
      sessionId,
      specId: startPayload.specId ?? '',
      spec: startPayload.spec ?? this.buildMinimalSpec(startPayload),
      status: 'planning',
      currentStep: 1,
      planningSteps: [],
      taskResults: [],
      driftHistory: [],
      evolutionHistory: [],
      currentGeneration: 0,
      lateralTriedPersonas: [],
      lateralAttempts: 0,
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

      case EventType.EVALUATE_STRUCTURAL_STARTED:
        session.evaluateStage = 'structural';
        break;

      case EventType.EVALUATE_STRUCTURAL_COMPLETED: {
        const structuralResult = payload as unknown as { allPassed: boolean; commands: Array<{ name: string; exitCode: number }> };
        // 전체 StructuralResult는 이벤트에 포함되지 않을 수 있으므로 최소 복원
        if (structuralResult) {
          session.structuralResult = session.structuralResult ?? {
            commands: (structuralResult.commands ?? []).map((c) => ({
              name: c.name,
              command: '',
              exitCode: c.exitCode,
              output: '',
            })),
            allPassed: structuralResult.allPassed ?? false,
          };
        }
        break;
      }

      case EventType.EVALUATE_CONTEXTUAL_STARTED:
        session.evaluateStage = 'contextual';
        break;

      case EventType.EVALUATE_CONTEXTUAL_COMPLETED:
        break;

      case EventType.EVALUATE_SHORT_CIRCUITED: {
        session.evaluateStage = 'complete';
        const shortCircuitResult = payload.structuralResult as StructuralResult | undefined;
        if (shortCircuitResult) {
          session.structuralResult = shortCircuitResult;
        }
        break;
      }

      case EventType.EXECUTE_EVALUATION_COMPLETED: {
        const evaluationResult = payload.evaluationResult as EvaluationResult | undefined;
        if (evaluationResult) {
          session.evaluationResult = evaluationResult;
          session.evaluateStage = 'complete';
        }
        break;
      }

      case EventType.EXECUTE_SESSION_COMPLETED:
        session.status = 'completed';
        break;

      case EventType.EXECUTE_SESSION_FAILED:
        session.status = 'failed';
        break;

      case EventType.EXECUTE_DRIFT_MEASURED: {
        const driftScore = payload as unknown as DriftScore;
        if (driftScore?.taskId) {
          session.driftHistory.push(driftScore);
        }
        break;
      }

      // ─── Evolution Loop ─────────────────────────────────────

      case EventType.EVOLVE_STRUCTURAL_FIX_STARTED:
        session.evolveStage = 'fix';
        session.status = 'executing';
        break;

      case EventType.EVOLVE_STRUCTURAL_FIX_COMPLETED:
        // Fix tasks recorded in event, no direct session state change beyond stage
        break;

      case EventType.EVOLVE_SPEC_PATCHED: {
        const patchedSpec = payload.spec as Spec | undefined;
        const delta = payload.delta as SpecDelta | undefined;
        const generation = payload.generation as number | undefined;
        if (patchedSpec) {
          session.spec = patchedSpec;
        }
        if (generation !== undefined) {
          session.currentGeneration = generation;
        }
        session.evolveStage = 'patch';

        // Record generation snapshot
        if (delta && generation !== undefined) {
          session.evolutionHistory.push({
            generation: generation,
            spec: session.spec,
            evaluationScore: session.evaluationResult?.overallScore ?? 0,
            goalAlignment: session.evaluationResult?.goalAlignment ?? 0,
            delta,
          });
        }
        break;
      }

      case EventType.EVOLVE_RE_EXECUTION_STARTED: {
        session.evolveStage = 're_executing';
        session.status = 'executing';
        const reExecTaskIds = payload.taskIds as string[] | undefined;
        if (reExecTaskIds) {
          session.taskResults = session.taskResults.filter(
            (r) => !reExecTaskIds.includes(r.taskId),
          );
        }
        break;
      }

      case EventType.EVOLVE_TASK_COMPLETED: {
        const evolveTaskResult: TaskExecutionResult = {
          taskId: payload.taskId as string,
          status: payload.status as TaskExecutionResult['status'],
          output: (payload.output as string) ?? '',
          artifacts: (payload.artifacts as string[]) ?? [],
        };
        const evolveExistingIdx = session.taskResults.findIndex(
          (r) => r.taskId === evolveTaskResult.taskId,
        );
        if (evolveExistingIdx >= 0) {
          session.taskResults[evolveExistingIdx] = evolveTaskResult;
        } else {
          session.taskResults.push(evolveTaskResult);
        }
        break;
      }

      case EventType.EVOLVE_TERMINATED: {
        const terminationReason = payload.reason as TerminationReason | undefined;
        if (terminationReason) {
          session.terminationReason = terminationReason;
          session.status = terminationReason === 'success' ? 'completed' : 'failed';
          session.evolveStage = undefined;
        }
        break;
      }

      // ─── Lateral Thinking ──────────────────────────────────────

      case EventType.EVOLVE_LATERAL_STARTED:
        session.evolveStage = 'lateral';
        session.status = 'executing';
        session.lateralCurrentPersona = payload.persona as string;
        session.lateralCurrentPattern = payload.pattern as string;
        break;

      case EventType.EVOLVE_LATERAL_COMPLETED: {
        const lateralPersona = payload.persona as string;
        if (lateralPersona) {
          session.lateralTriedPersonas.push(lateralPersona);
          session.lateralAttempts++;
        }
        session.lateralCurrentPersona = undefined;
        session.lateralCurrentPattern = undefined;
        break;
      }

      case EventType.EVOLVE_HUMAN_ESCALATION:
        session.terminationReason = 'human_escalation';
        session.status = 'failed';
        session.evolveStage = undefined;
        break;

      // EXECUTE_PLAN_VALIDATED 등 — 세션 상태에 직접 영향 없음
      default:
        break;
    }
  }

  /**
   * 이전 payload 형식(spec 전체 없음)을 위한 최소 Spec 생성.
   * 재구성은 되지만 일부 데이터가 불완전할 수 있음.
   */
  private buildMinimalSpec(startPayload: { specId: string; goal: string }): Spec {
    return {
      version: '1.0',
      goal: startPayload.goal ?? '',
      constraints: [],
      acceptanceCriteria: [],
      ontologySchema: { entities: [], relations: [] },
      gestaltAnalysis: [],
      metadata: {
        specId: startPayload.specId ?? '',
        interviewSessionId: '',
        ambiguityScore: 0,
        generatedAt: '',
      },
    };
  }
}
