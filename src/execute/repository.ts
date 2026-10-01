import type { IEventStore } from '../events/store.js';
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
  EvaluateStage,
  ExecuteStatus,
  AuditResult,
  RoleMatch,
  RoleConsensus,
  SubTask,
} from '../core/types.js';
import { EventType } from '../events/types.js';
import { computeReadyTaskIds } from './parallel-groups.js';
import { classifyDrift } from './drift-detector.js';
import { DRIFT_THRESHOLD } from '../core/constants.js';

/** 구조 평가가 실패해 맥락 평가를 건너뛸 때의 평가 결과. 라이브와 replay가 같이 쓴다. */
export function buildShortCircuitEvaluation(spec: Spec, reason: string): EvaluationResult {
  return {
    verifications: spec.acceptanceCriteria.map((_, i) => ({
      acIndex: i,
      satisfied: false,
      evidence: 'Short-circuited due to structural failure',
      gaps: [reason],
    })),
    overallScore: 0,
    goalAlignment: 0,
    recommendations: ['Fix structural issues before contextual evaluation'],
  };
}

/**
 * ExecuteSessionRepository — Event Replay 기반 ExecuteSession 재구성.
 * 도메인 전용 Repository: aggregate_type='execute' 이벤트만 처리.
 */
export class ExecuteSessionRepository {
  constructor(private eventStore: IEventStore) {}

  /**
   * 이벤트를 fold하여 ExecuteSession 상태를 완전히 복원한다.
   */
  reconstruct(sessionId: string): ExecuteSession | null {
    return this.load(sessionId)?.session ?? null;
  }

  /**
   * 재구성한 세션과 그때 읽은 이벤트 수를 함께 돌려준다.
   * 매니저는 이 수를 스토어의 현재 수와 비교해 다른 프로세스가 덧붙였는지 본다.
   */
  load(sessionId: string): { session: ExecuteSession; eventCount: number } | null {
    const events = this.eventStore.replay('execute', sessionId);
    if (events.length === 0) return null;

    return { session: this.foldEvents(sessionId, events), eventCount: events.length };
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
      codeGraphRepoRoot?: string;
    };

    const session: ExecuteSession = {
      sessionId,
      specId: startPayload.specId ?? '',
      spec: startPayload.spec ?? this.buildMinimalSpec(startPayload),
      status: 'planning',
      currentStep: 1,
      planningSteps: [],
      taskResults: [],
      completedTaskIds: [],
      nextTaskId: null,
      nextTaskIds: [],
      subTasks: [],
      driftHistory: [],
      evolutionHistory: [],
      currentGeneration: 0,
      lateralTriedPersonas: [],
      lateralAttempts: 0,
      codeGraphRepoRoot: startPayload.codeGraphRepoRoot,
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
        // addSubTasks()가 같은 이벤트 타입을 빌려 쓴다. 태스크 결과로 fold하면 taskId 없는 결과가 생긴다
        if (payload.type === 'sub_tasks_spawned') {
          const subTasks = payload.subTasks as SubTask[] | undefined;
          if (subTasks) session.subTasks.push(...subTasks);
          break;
        }
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
        // completedTaskIds는 session.ts의 addTaskResult()와 동일한 기준(status === 'completed')으로 채운다
        if (
          taskResult.status === 'completed' &&
          !session.completedTaskIds.includes(taskResult.taskId)
        ) {
          session.completedTaskIds.push(taskResult.taskId);
        }
        // nextTaskIds/nextTaskId도 addTaskResult()와 같은 공유 함수로 복원한다.
        // 이전에는 초기값 null에서 갱신되지 않아 재시작 후 라이브 세션과 값이 어긋났다.
        const plan = session.executionPlan;
        if (plan) {
          session.nextTaskIds = computeReadyTaskIds(
            plan.atomicTasks,
            plan.dagValidation.topologicalOrder,
            session.completedTaskIds,
          );
          session.nextTaskId = session.nextTaskIds[0] ?? null;
        }
        break;
      }

      case EventType.EVALUATE_STRUCTURAL_STARTED:
        session.evaluateStage = 'structural';
        break;

      case EventType.EVALUATE_STRUCTURAL_COMPLETED: {
        const structuralResult = payload as unknown as {
          allPassed: boolean;
          commands: Array<{ name: string; exitCode: number }>;
        };
        const fullResult = payload.structuralResult as StructuralResult | undefined;
        if (fullResult) {
          session.structuralResult = fullResult;
        } else if (structuralResult) {
          // 전체 결과를 싣기 전에 쌓인 이벤트는 이름과 종료 코드만 있어 최소 복원한다
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
        // 이전 이벤트에는 evaluationResult가 없어 라이브와 같은 함수로 다시 만든다
        session.evaluationResult =
          (payload.evaluationResult as EvaluationResult | undefined) ??
          buildShortCircuitEvaluation(session.spec, (payload.reason as string | undefined) ?? '');
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
        const full = payload.driftScore as DriftScore | undefined;
        if (full) {
          session.driftHistory.push(full);
          break;
        }
        // driftScore를 통째로 싣기 전의 이벤트에는 status, threshold, hint가 없다
        const legacy = payload as unknown as Omit<DriftScore, 'status' | 'threshold' | 'hint'>;
        if (legacy?.taskId) {
          // 그때 쓴 임계값은 안 남아 기본값으로 근사한다. 넘었는지는 기록된 값을 따른다
          const approx = classifyDrift(
            legacy.thresholdExceeded ? DRIFT_THRESHOLD : legacy.overall,
            DRIFT_THRESHOLD,
          );
          const recorded =
            !legacy.thresholdExceeded && approx.status === 'CRITICAL'
              ? { ...approx, status: 'WARNING' as const }
              : approx;
          session.driftHistory.push({
            taskId: legacy.taskId,
            overall: legacy.overall,
            dimensions: legacy.dimensions,
            thresholdExceeded: legacy.thresholdExceeded,
            threshold: DRIFT_THRESHOLD,
            ...recorded,
          });
        }
        break;
      }

      // ─── Evolution Loop ─────────────────────────────────────

      case EventType.EVOLVE_STRUCTURAL_FIX_STARTED:
        session.evolveStage = 'fix';
        session.status = 'executing';
        break;

      case EventType.EVOLVE_STRUCTURAL_FIX_COMPLETED: {
        // completeStructuralFix()가 evaluateStage/structuralResult/evaluationResult/status를
        // 리셋한 결과를 resetState로 기록해두었으므로 그대로 복원한다 (null → undefined)
        const resetState = payload.resetState as
          | {
              evaluateStage: EvaluateStage | null;
              structuralResult: StructuralResult | null;
              evaluationResult: EvaluationResult | null;
              status: ExecuteStatus;
            }
          | undefined;
        if (resetState) {
          session.evaluateStage = resetState.evaluateStage ?? undefined;
          session.structuralResult = resetState.structuralResult ?? undefined;
          session.evaluationResult = resetState.evaluationResult ?? undefined;
          session.status = resetState.status;
        }
        break;
      }

      case EventType.EVOLVE_SPEC_PATCHED: {
        const patchedSpec = payload.spec as Spec | undefined;
        const delta = payload.delta as SpecDelta | undefined;
        const generation = payload.generation as number | undefined;

        // 라이브는 패치를 적용하기 전에 recordEvolutionGeneration()으로 직전 세대를 남긴다.
        // 그 호출은 이벤트가 없으므로 같은 스냅샷을 여기서 패치 적용 전에 만든다
        if (delta && generation !== undefined) {
          session.evolutionHistory.push({
            generation: session.currentGeneration,
            spec: session.spec,
            evaluationScore: session.evaluationResult?.overallScore ?? 0,
            goalAlignment: session.evaluationResult?.goalAlignment ?? 0,
            delta,
          });
        }

        if (patchedSpec) {
          session.spec = patchedSpec;
        }
        if (generation !== undefined) {
          session.currentGeneration = generation;
        }
        session.evolveStage = 'patch';
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

      case EventType.EXECUTE_AUDIT_COMPLETED:
        session.auditResult = payload.auditResult as AuditResult;
        break;

      // ─── Role Agent ────────────────────────────────────────────

      // matches, consensus를 싣기 전의 이벤트로는 역할 상태를 복원하지 못한다.
      // 값이 있을 때만 반영해서 그 구간의 세션은 역할 상태가 빈 채로 재구성된다
      case EventType.ROLE_MATCH_COMPLETED: {
        const matches = payload.matches as RoleMatch[] | undefined;
        if (matches) session.roleMatches = matches;
        break;
      }

      case EventType.ROLE_CONSENSUS_COMPLETED: {
        const consensus = payload.consensus as RoleConsensus | undefined;
        if (consensus) session.roleConsensus = consensus;
        break;
      }

      case EventType.ROLE_STATE_CLEARED:
        session.roleMatches = undefined;
        session.roleConsensus = undefined;
        break;

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
        resolutionScore: 0,
        generatedAt: '',
      },
    };
  }
}
