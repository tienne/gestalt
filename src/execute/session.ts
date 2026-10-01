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
  RoleMatch,
  RoleConsensus,
  SubTask,
  AuditResult,
  StructuralCommand,
  WorkingTreeBaseline,
} from '../core/types.js';
import { ExecuteSessionNotFoundError } from '../core/errors.js';
import { DEFAULT_SESSION_TTL_MS } from '../core/constants.js';
import { logger } from '../core/logger.js';
import type { IEventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { ExecuteSessionRepository, buildShortCircuitEvaluation } from './repository.js';
import { computeReadyTaskIds } from './parallel-groups.js';
import { redactSecrets } from '../mcp/input-guard.js';

// evolve_fix 프롬프트가 출력 끝 500자를 쓰므로 그보다 넉넉히 끝을 남긴다
const EVENT_OUTPUT_TAIL = 2000;

/**
 * 구조 평가 결과를 이벤트에 싣는 꼴로 바꾼다. 원장은 지워지지 않으므로 빌드 로그 원문을
 * 남기지 않는다. 토큰은 원문 전체에서 가린 뒤 자른다 — 잘린 조각에서는 패턴이 안 걸린다.
 * 메모리의 세션은 원문을 그대로 둔다.
 */
function toEventStructuralResult(
  result: StructuralResult | undefined,
): StructuralResult | undefined {
  if (!result) return undefined;
  return {
    ...result,
    commands: result.commands.map((c) => {
      const output = redactSecrets(c.output);
      return {
        ...c,
        command: redactSecrets(c.command),
        output:
          output.length <= EVENT_OUTPUT_TAIL
            ? output
            : `…(앞 ${output.length - EVENT_OUTPUT_TAIL}자 생략)\n${output.slice(-EVENT_OUTPUT_TAIL)}`,
      };
    }),
  };
}

/**
 * 실행 세션의 인메모리 캐시. 기준은 이벤트 스토어다.
 *
 * 같은 DB를 여러 MCP 프로세스(dispatch 워커 등)가 함께 쓴다. 그래서 캐시가 담은
 * 세션마다 그때까지 반영한 이벤트 수를 들고 있다가, get()에서 스토어의 수와 다르면
 * 다시 재구성한다. 모든 변경 메서드가 get()부터 부르므로 쓰기도 최신 상태 위에서 한다.
 */
export class ExecuteSessionManager {
  private sessions = new Map<string, ExecuteSession>();
  private eventCounts = new Map<string, number>();
  private repo: ExecuteSessionRepository;

  constructor(private eventStore: IEventStore) {
    this.repo = new ExecuteSessionRepository(eventStore);
  }

  /**
   * EventStore에서 기존 세션을 복원하여 메모리 Map에 로드한다.
   * 서버 시작 시 한 번 호출.
   */
  loadFromStore(): void {
    for (const id of this.repo.list()) this.reload(id);
  }

  private reload(sessionId: string): ExecuteSession | null {
    const loaded = this.repo.load(sessionId);
    if (!loaded) return null;
    this.sessions.set(sessionId, loaded.session);
    this.eventCounts.set(sessionId, loaded.eventCount);
    return loaded.session;
  }

  private record(sessionId: string, eventType: EventType, payload: Record<string, unknown>): void {
    this.eventStore.append('execute', sessionId, eventType, payload);
    this.eventCounts.set(sessionId, (this.eventCounts.get(sessionId) ?? 0) + 1);
  }

  create(spec: Spec, opts: { codeGraphRepoRoot?: string } = {}): ExecuteSession {
    const session: ExecuteSession = {
      sessionId: randomUUID(),
      specId: spec.metadata.specId,
      spec,
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
      codeGraphRepoRoot: opts.codeGraphRepoRoot,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(session.sessionId, session);

    this.record(session.sessionId, EventType.EXECUTE_SESSION_STARTED, {
      specId: spec.metadata.specId,
      goal: spec.goal,
      acCount: spec.acceptanceCriteria.length,
      spec,
      codeGraphRepoRoot: opts.codeGraphRepoRoot,
    });

    logger.info('execute.started', {
      module: 'execute',
      sessionId: session.sessionId,
      specId: spec.metadata.specId,
      acCount: spec.acceptanceCriteria.length,
    });

    return session;
  }

  /**
   * updatedAt(마지막 활동) 기준으로 ttlMs를 초과한 인메모리 세션을 제거한다.
   * SQLite 이벤트 원장은 보존되므로 지운 세션도 get()이 다시 재구성한다.
   * @returns 제거된 세션 수
   */
  cleanup(ttlMs = DEFAULT_SESSION_TTL_MS): number {
    const now = Date.now();
    let removed = 0;
    for (const [id, session] of this.sessions) {
      if (now - new Date(session.updatedAt).getTime() > ttlMs) {
        this.sessions.delete(id);
        this.eventCounts.delete(id);
        removed++;
      }
    }
    return removed;
  }

  get(sessionId: string): ExecuteSession {
    const cached = this.sessions.get(sessionId);
    if (
      cached &&
      this.eventCounts.get(sessionId) === this.eventStore.countByAggregate('execute', sessionId)
    ) {
      return cached;
    }
    const session = this.reload(sessionId);
    if (!session) throw new ExecuteSessionNotFoundError(sessionId);
    return session;
  }

  addPlanningStep(sessionId: string, stepResult: PlanningStepResult): void {
    const session = this.get(sessionId);
    session.planningSteps.push(stepResult);
    session.currentStep = session.planningSteps.length + 1;
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EXECUTE_PLANNING_STEP_COMPLETED, {
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

    this.record(sessionId, EventType.EXECUTE_PLAN_COMPLETED, {
      planId: plan.planId,
      taskCount: plan.atomicTasks.length,
      groupCount: plan.taskGroups.length,
      executionPlan: plan,
    });
  }

  startExecution(sessionId: string, workingTreeBaseline?: WorkingTreeBaseline): void {
    const session = this.get(sessionId);
    session.status = 'executing';
    session.workingTreeBaseline = workingTreeBaseline;
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EXECUTE_EXECUTION_STARTED, {
      planId: session.executionPlan?.planId,
      taskCount: session.executionPlan?.atomicTasks.length,
      workingTreeBaseline,
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
    // Track completed task IDs for resume support
    if (
      taskResult.status === 'completed' &&
      !session.completedTaskIds.includes(taskResult.taskId)
    ) {
      session.completedTaskIds.push(taskResult.taskId);
    }
    // nextTaskId를 nextTaskIds[0]에서 파생시켜 둘의 불일치를 구조적으로 차단한다
    const plan = session.executionPlan;
    if (plan) {
      session.nextTaskIds = computeReadyTaskIds(
        plan.atomicTasks,
        plan.dagValidation.topologicalOrder,
        session.completedTaskIds,
      );
      session.nextTaskId = session.nextTaskIds[0] ?? null;
    }
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EXECUTE_TASK_COMPLETED, {
      taskId: taskResult.taskId,
      status: taskResult.status,
      output: taskResult.output,
      artifacts: taskResult.artifacts,
      ...(taskResult.noCodeChange ? { noCodeChange: true } : {}),
    });

    logger.info('execute.task_completed', {
      module: 'execute',
      sessionId,
      taskId: taskResult.taskId,
      status: taskResult.status,
    });
  }

  startStructuralEvaluation(sessionId: string, commands: StructuralCommand[]): void {
    const session = this.get(sessionId);
    session.evaluateStage = 'structural';
    session.structuralCommands = commands;
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EVALUATE_STRUCTURAL_STARTED, {
      taskResultCount: session.taskResults.length,
      commands,
    });
  }

  completeStructuralStage(sessionId: string, structuralResult: StructuralResult): void {
    const session = this.get(sessionId);
    session.structuralResult = structuralResult;
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EVALUATE_STRUCTURAL_COMPLETED, {
      allPassed: structuralResult.allPassed,
      // 축약 commands는 structuralResult를 모르는 이전 버전이 이 원장을 읽을 때 쓴다
      commands: structuralResult.commands.map((c) => ({ name: c.name, exitCode: c.exitCode })),
      structuralResult: toEventStructuralResult(structuralResult),
    });
  }

  startContextualEvaluation(sessionId: string): void {
    const session = this.get(sessionId);
    session.evaluateStage = 'contextual';
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EVALUATE_CONTEXTUAL_STARTED, {
      structuralPassed: session.structuralResult?.allPassed ?? false,
    });
  }

  shortCircuitEvaluation(sessionId: string, reason: string): void {
    const session = this.get(sessionId);
    session.evaluateStage = 'complete';
    session.status = 'completed';
    session.evaluationResult = buildShortCircuitEvaluation(session.spec, reason);
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EVALUATE_SHORT_CIRCUITED, {
      reason,
      structuralResult: toEventStructuralResult(session.structuralResult),
      evaluationResult: session.evaluationResult,
    });

    this.record(sessionId, EventType.EXECUTE_SESSION_COMPLETED, {
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

    this.record(sessionId, EventType.EXECUTE_EVALUATION_COMPLETED, {
      overallScore: evaluationResult.overallScore,
      goalAlignment: evaluationResult.goalAlignment,
      satisfiedCount: evaluationResult.verifications.filter((v) => v.satisfied).length,
      totalCount: evaluationResult.verifications.length,
      evaluationResult,
    });

    this.record(sessionId, EventType.EXECUTE_SESSION_COMPLETED, {
      overallScore: evaluationResult.overallScore,
    });

    logger.info('execute.completed', {
      module: 'execute',
      sessionId,
      overallScore: evaluationResult.overallScore,
      goalAlignment: evaluationResult.goalAlignment,
    });
  }

  addDriftScore(sessionId: string, driftScore: DriftScore): void {
    const session = this.get(sessionId);
    session.driftHistory.push(driftScore);
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EXECUTE_DRIFT_MEASURED, {
      taskId: driftScore.taskId,
      overall: driftScore.overall,
      thresholdExceeded: driftScore.thresholdExceeded,
      dimensions: driftScore.dimensions,
      driftScore,
    });
  }

  // ─── Evolution Loop Methods ─────────────────────────────────

  startStructuralFix(sessionId: string): void {
    const session = this.get(sessionId);
    session.evolveStage = 'fix';
    session.status = 'executing';
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EVOLVE_STRUCTURAL_FIX_STARTED, {
      generation: session.currentGeneration,
      structuralResult: toEventStructuralResult(session.structuralResult),
    });
  }

  completeStructuralFix(sessionId: string, fixTasks: FixTask[]): void {
    const session = this.get(sessionId);
    const generation = session.currentGeneration;

    // Reset evaluation state so the session re-enters structural/contextual re-evaluation
    session.evaluateStage = undefined;
    session.structuralResult = undefined;
    session.evaluationResult = undefined;
    session.status = 'executing';
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EVOLVE_STRUCTURAL_FIX_COMPLETED, {
      generation,
      fixCount: fixTasks.length,
      fixTasks,
      // replay 시 정확히 복원하기 위해 리셋된 상태값을 명시적으로 기록 (undefined는 JSON에서 유실되므로 null 사용)
      resetState: {
        evaluateStage: null,
        structuralResult: null,
        evaluationResult: null,
        status: 'executing' as const,
      },
    });
  }

  patchSpec(sessionId: string, patch: SpecPatch, newSpec: Spec, delta: SpecDelta): void {
    const session = this.get(sessionId);
    session.currentGeneration++;
    session.spec = newSpec;
    session.evolveStage = 'patch';
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EVOLVE_SPEC_PATCHED, {
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

    this.record(sessionId, EventType.EVOLVE_RE_EXECUTION_STARTED, {
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

    this.record(sessionId, EventType.EVOLVE_TASK_COMPLETED, {
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

  // ─── Role Agent Methods ────────────────────────────────────

  setRoleMatches(sessionId: string, taskId: string, matches: RoleMatch[]): void {
    const session = this.get(sessionId);
    if (!session.roleMatches) session.roleMatches = [];
    session.roleMatches = matches;
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.ROLE_MATCH_COMPLETED, {
      taskId,
      matchCount: matches.length,
      agents: matches.map((m) => m.agentName),
      matches,
    });
  }

  setRoleConsensus(sessionId: string, taskId: string, consensus: RoleConsensus): void {
    const session = this.get(sessionId);
    session.roleConsensus = consensus;
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.ROLE_CONSENSUS_COMPLETED, {
      taskId,
      participatingAgents: consensus.perspectives.map((p) => p.agentName),
      conflictCount: consensus.conflictResolutions.length,
      consensus,
    });
  }

  clearRoleState(sessionId: string): void {
    const session = this.get(sessionId);
    session.roleMatches = undefined;
    session.roleConsensus = undefined;
    session.updatedAt = new Date().toISOString();
    this.record(sessionId, EventType.ROLE_STATE_CLEARED, {});
  }

  // ─── Sub-task Methods ───────────────────────────────────────

  addSubTasks(sessionId: string, subTasks: SubTask[]): void {
    const session = this.get(sessionId);
    session.subTasks.push(...subTasks);
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EXECUTE_TASK_COMPLETED, {
      type: 'sub_tasks_spawned',
      parentTaskId: subTasks[0]?.parentTaskId,
      count: subTasks.length,
      taskIds: subTasks.map((t) => t.taskId),
      subTasks,
    });
  }

  setAuditResult(sessionId: string, auditResult: AuditResult): void {
    const session = this.get(sessionId);
    session.auditResult = auditResult;
    session.updatedAt = new Date().toISOString();
    this.record(sessionId, EventType.EXECUTE_AUDIT_COMPLETED, { auditResult });
  }

  // ─── Lateral Thinking Methods ───────────────────────────────

  startLateral(sessionId: string, persona: string, pattern: string): void {
    const session = this.get(sessionId);
    session.evolveStage = 'lateral';
    session.status = 'executing';
    session.lateralCurrentPersona = persona;
    session.lateralCurrentPattern = pattern;
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EVOLVE_LATERAL_STARTED, {
      generation: session.currentGeneration,
      persona,
      pattern,
      attemptNumber: session.lateralAttempts + 1,
    });
  }

  completeLateral(sessionId: string, persona: string, description: string): void {
    const session = this.get(sessionId);
    session.lateralTriedPersonas.push(persona);
    session.lateralAttempts++;
    session.lateralCurrentPersona = undefined;
    session.lateralCurrentPattern = undefined;
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EVOLVE_LATERAL_COMPLETED, {
      generation: session.currentGeneration,
      persona,
      description,
      attemptNumber: session.lateralAttempts,
    });
  }

  terminate(sessionId: string, reason: TerminationReason): void {
    const session = this.get(sessionId);
    session.terminationReason = reason;
    session.status = reason === 'success' ? 'completed' : 'failed';
    session.evolveStage = undefined;
    session.updatedAt = new Date().toISOString();

    this.record(sessionId, EventType.EVOLVE_TERMINATED, {
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

    this.record(sessionId, EventType.EXECUTE_SESSION_FAILED, {
      reason,
    });

    logger.warn('execute.failed', {
      module: 'execute',
      sessionId,
      reason,
    });
  }

  list(): ExecuteSession[] {
    return Array.from(this.sessions.values()).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
}
