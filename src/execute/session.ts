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

    this.eventStore.append('execute', session.sessionId, EventType.EXECUTE_SESSION_STARTED, {
      specId: spec.metadata.specId,
      goal: spec.goal,
      acCount: spec.acceptanceCriteria.length,
      spec,
      codeGraphRepoRoot: opts.codeGraphRepoRoot,
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
    // Track completed task IDs for resume support
    if (taskResult.status === 'completed' && !session.completedTaskIds.includes(taskResult.taskId)) {
      session.completedTaskIds.push(taskResult.taskId);
    }
    // Update nextTaskId: first pending task in topological order not yet completed
    const plan = session.executionPlan;
    if (plan) {
      const completedSet = new Set(session.completedTaskIds);
      const next = plan.dagValidation.topologicalOrder.find((id) => !completedSet.has(id));
      session.nextTaskId = next ?? null;
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

  // ─── Role Agent Methods ────────────────────────────────────

  setRoleMatches(sessionId: string, taskId: string, matches: RoleMatch[]): void {
    const session = this.get(sessionId);
    if (!session.roleMatches) session.roleMatches = [];
    session.roleMatches = matches;
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.ROLE_MATCH_COMPLETED, {
      taskId,
      matchCount: matches.length,
      agents: matches.map((m) => m.agentName),
    });
  }

  setRoleConsensus(sessionId: string, taskId: string, consensus: RoleConsensus): void {
    const session = this.get(sessionId);
    session.roleConsensus = consensus;
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.ROLE_CONSENSUS_COMPLETED, {
      taskId,
      participatingAgents: consensus.perspectives.map((p) => p.agentName),
      conflictCount: consensus.conflictResolutions.length,
    });
  }

  clearRoleState(sessionId: string): void {
    const session = this.get(sessionId);
    session.roleMatches = undefined;
    session.roleConsensus = undefined;
    session.updatedAt = new Date().toISOString();
  }

  // ─── Sub-task Methods ───────────────────────────────────────

  addSubTasks(sessionId: string, subTasks: SubTask[]): void {
    const session = this.get(sessionId);
    session.subTasks.push(...subTasks);
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EXECUTE_TASK_COMPLETED, {
      type: 'sub_tasks_spawned',
      parentTaskId: subTasks[0]?.parentTaskId,
      count: subTasks.length,
      taskIds: subTasks.map((t) => t.taskId),
    });
  }

  setAuditResult(sessionId: string, auditResult: AuditResult): void {
    const session = this.get(sessionId);
    session.auditResult = auditResult;
    session.updatedAt = new Date().toISOString();
  }

  // ─── Lateral Thinking Methods ───────────────────────────────

  startLateral(sessionId: string, persona: string, pattern: string): void {
    const session = this.get(sessionId);
    session.evolveStage = 'lateral';
    session.status = 'executing';
    session.lateralCurrentPersona = persona;
    session.lateralCurrentPattern = pattern;
    session.updatedAt = new Date().toISOString();

    this.eventStore.append('execute', sessionId, EventType.EVOLVE_LATERAL_STARTED, {
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

    this.eventStore.append('execute', sessionId, EventType.EVOLVE_LATERAL_COMPLETED, {
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
