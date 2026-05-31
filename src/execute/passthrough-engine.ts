import type {
  Spec,
  ExecuteSession,
  PlanningStepResult,
  TaskExecutionResult,
  EvaluationResult,
  StructuralResult,
  FixTask,
  SpecPatch,
  RoleMatch,
  RolePerspective,
  RoleConsensus,
} from '../core/types.js';
import { ExecuteError } from '../core/errors.js';
import { type Result } from '../core/result.js';
import { EventStore } from '../events/store.js';
import { ExecuteSessionManager } from './session.js';
import type { AgentRegistry } from '../agent/registry.js';
import type { RoleAgentRegistry } from '../agent/role-agent-registry.js';
import type { LateralResult } from '../resilience/types.js';
import { PlanningOrchestrator } from './orchestrators/planning.js';
import { ExecutionOrchestrator } from './orchestrators/execution.js';
import { EvaluationOrchestrator } from './orchestrators/evaluation.js';
import { EvolutionOrchestrator } from './orchestrators/evolution.js';
import type {
  PassthroughStartResult,
  PassthroughPlanStepResult,
  PassthroughPlanCompleteResult,
  PassthroughExecutionStartResult,
  PassthroughTaskSubmitResult,
  PassthroughRoleMatchResult,
  PassthroughRoleConsensusResult,
  PassthroughEvaluateResult,
  PassthroughEvolveFixResult,
  PassthroughEvolvePatchResult,
  PassthroughReExecuteResult,
  TaskExecutionContext,
} from './orchestrators/types.js';

// Re-export all context/result types so existing importers
// (MCP handlers, benchmarks, tests) keep using this module's path unchanged.
export type {
  ExecuteContext,
  PassthroughStartResult,
  PassthroughPlanStepResult,
  PassthroughPlanCompleteResult,
  TaskExecutionContext,
  PassthroughRoleMatchResult,
  PassthroughRoleConsensusResult,
  PassthroughExecutionStartResult,
  DriftRetrospectiveContext,
  PassthroughTaskSubmitResult,
  StructuralEvaluateContext,
  ContextualEvaluateContext,
  PassthroughEvaluateResult,
  StructuralFixContext,
  ContextualEvolveContext,
  ReExecutionContext,
  PassthroughEvolveFixResult,
  PassthroughEvolvePatchResult,
  PassthroughReExecuteResult,
} from './orchestrators/types.js';

// ─── Engine (thin facade) ──────────────────────────────────────

export class PassthroughExecuteEngine {
  private sessionManager: ExecuteSessionManager;
  private planningOrch: PlanningOrchestrator;
  private executionOrch: ExecutionOrchestrator;
  private evaluationOrch: EvaluationOrchestrator;
  private evolutionOrch: EvolutionOrchestrator;

  constructor(
    eventStore: EventStore,
    agentRegistry?: AgentRegistry,
    roleAgentRegistry?: RoleAgentRegistry,
  ) {
    this.sessionManager = new ExecuteSessionManager(eventStore);
    this.sessionManager.loadFromStore();

    this.planningOrch = new PlanningOrchestrator(
      this.sessionManager,
      eventStore,
      agentRegistry,
      roleAgentRegistry,
    );
    this.executionOrch = new ExecutionOrchestrator(
      this.sessionManager,
      eventStore,
      agentRegistry,
      roleAgentRegistry,
    );
    this.evaluationOrch = new EvaluationOrchestrator(
      this.sessionManager,
      eventStore,
      agentRegistry,
      roleAgentRegistry,
    );
    this.evolutionOrch = new EvolutionOrchestrator(
      this.sessionManager,
      eventStore,
      agentRegistry,
      roleAgentRegistry,
    );
  }

  getSessionManager(): ExecuteSessionManager {
    return this.sessionManager;
  }

  // ─── Planning ────────────────────────────────────────────────

  start(
    spec: Spec,
    opts: { codeGraphRepoRoot?: string } = {},
  ): Result<PassthroughStartResult, ExecuteError> {
    return this.planningOrch.start(spec, opts);
  }

  planStep(
    sessionId: string,
    stepResult: PlanningStepResult,
  ): Result<PassthroughPlanStepResult, ExecuteError> {
    return this.planningOrch.planStep(sessionId, stepResult);
  }

  planComplete(sessionId: string): Result<PassthroughPlanCompleteResult, ExecuteError> {
    return this.planningOrch.planComplete(sessionId);
  }

  // ─── Execution ───────────────────────────────────────────────

  startExecution(sessionId: string): Result<PassthroughExecutionStartResult, ExecuteError> {
    return this.executionOrch.startExecution(sessionId);
  }

  submitTaskResult(
    sessionId: string,
    taskResult: TaskExecutionResult,
    driftThreshold?: number,
  ): Result<PassthroughTaskSubmitResult, ExecuteError> {
    return this.executionOrch.submitTaskResult(sessionId, taskResult, driftThreshold);
  }

  roleMatch(
    sessionId: string,
    matchResult?: RoleMatch[],
  ): Result<PassthroughRoleMatchResult, ExecuteError> {
    return this.executionOrch.roleMatch(sessionId, matchResult);
  }

  roleConsensus(
    sessionId: string,
    perspectives?: RolePerspective[],
    consensus?: RoleConsensus,
  ): Result<PassthroughRoleConsensusResult, ExecuteError> {
    return this.executionOrch.roleConsensus(sessionId, perspectives, consensus);
  }

  hydrateSuggestedFiles(
    context: TaskExecutionContext,
    repoRoot: string,
  ): Promise<TaskExecutionContext> {
    return this.executionOrch.hydrateSuggestedFiles(context, repoRoot);
  }

  // ─── Evaluation ──────────────────────────────────────────────

  startEvaluation(sessionId: string): Result<PassthroughEvaluateResult, ExecuteError> {
    return this.evaluationOrch.startEvaluation(sessionId);
  }

  submitStructuralResult(
    sessionId: string,
    structuralResult: StructuralResult,
  ): Result<PassthroughEvaluateResult, ExecuteError> {
    return this.evaluationOrch.submitStructuralResult(sessionId, structuralResult);
  }

  submitEvaluation(
    sessionId: string,
    evaluationResult: EvaluationResult,
  ): Result<PassthroughEvaluateResult, ExecuteError> {
    return this.evaluationOrch.submitEvaluation(sessionId, evaluationResult);
  }

  // ─── Session accessors ───────────────────────────────────────

  getSession(sessionId: string): ExecuteSession {
    return this.sessionManager.get(sessionId);
  }

  listSessions(): ExecuteSession[] {
    return this.sessionManager.list();
  }

  // ─── Evolution ───────────────────────────────────────────────

  startStructuralFix(
    sessionId: string,
    fixTasks?: FixTask[],
  ): Result<PassthroughEvolveFixResult, ExecuteError> {
    return this.evolutionOrch.startStructuralFix(sessionId, fixTasks);
  }

  startContextualEvolve(
    sessionId: string,
    terminateReason?: 'caller',
  ): Result<PassthroughEvolveFixResult, ExecuteError> {
    return this.evolutionOrch.startContextualEvolve(sessionId, terminateReason);
  }

  submitSpecPatch(
    sessionId: string,
    patch: SpecPatch,
  ): Result<PassthroughEvolvePatchResult, ExecuteError> {
    return this.evolutionOrch.submitSpecPatch(sessionId, patch);
  }

  submitReExecuteTaskResult(
    sessionId: string,
    taskResult: TaskExecutionResult,
  ): Result<PassthroughReExecuteResult, ExecuteError> {
    return this.evolutionOrch.submitReExecuteTaskResult(sessionId, taskResult);
  }

  startLateralEvolve(sessionId: string): Result<PassthroughEvolveFixResult, ExecuteError> {
    return this.evolutionOrch.startLateralEvolve(sessionId);
  }

  submitLateralResult(
    sessionId: string,
    lateralResult: LateralResult,
  ): Result<PassthroughEvolvePatchResult, ExecuteError> {
    return this.evolutionOrch.submitLateralResult(sessionId, lateralResult);
  }
}
