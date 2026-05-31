import type {
  Spec,
  ExecuteSession,
  ExecutionPlan,
  PlanningStepResult,
  ClassifiedAC,
  AtomicTask,
  TaskExecutionResult,
  EvaluationResult,
  StructuralCommand,
  StructuralResult,
  EvaluateStage,
  DriftScore,
  TerminationReason,
  RoleGuidance,
} from '../../core/types.js';
import type { LateralContext, EscalationContext } from '../../resilience/types.js';
import type { MatchContext } from '../../agent/role-match-engine.js';
import type { PerspectivePrompt } from '../../agent/role-prompt-generator.js';
import type { SynthesisContext } from '../../agent/role-consensus-engine.js';

// ─── Types ──────────────────────────────────────────────────────

export interface ExecuteContext {
  systemPrompt: string;
  planningPrompt: string;
  currentPrinciple: string;
  principleStrategy: string;
  phase: 'planning';
  stepNumber: number;
  totalSteps: number;
  spec: Spec;
  previousSteps: PlanningStepResult[];
}

export interface PassthroughStartResult {
  session: ExecuteSession;
  executeContext: ExecuteContext;
}

export interface PassthroughPlanStepResult {
  session: ExecuteSession;
  executeContext?: ExecuteContext;
  isLastStep: boolean;
}

export interface PassthroughPlanCompleteResult {
  session: ExecuteSession;
  executionPlan: ExecutionPlan;
}

export interface TaskExecutionContext {
  systemPrompt: string;
  taskPrompt: string;
  phase: 'executing';
  currentTask: AtomicTask;
  similarityStrategy: string;
  pendingTasks: AtomicTask[];
  completedTaskIds: string[];
  roleGuidance?: RoleGuidance;
  suggestedFiles?: string[];
}

// ─── Role Agent System Types ─────────────────────────────────────

export interface PassthroughRoleMatchResult {
  session: ExecuteSession;
  matchContext?: MatchContext;
  perspectivePrompts?: PerspectivePrompt[];
}

export interface PassthroughRoleConsensusResult {
  session: ExecuteSession;
  synthesisContext?: SynthesisContext;
  roleGuidance?: RoleGuidance;
}

export interface PassthroughExecutionStartResult {
  session: ExecuteSession;
  taskContext: TaskExecutionContext | null; // null if no executable tasks
  allTasksCompleted: boolean;
}

export interface DriftRetrospectiveContext {
  systemPrompt: string;
  retrospectivePrompt: string;
  driftScore: DriftScore;
}

export interface PassthroughTaskSubmitResult {
  session: ExecuteSession;
  taskContext: TaskExecutionContext | null;
  allTasksCompleted: boolean;
  driftScore?: DriftScore;
  retrospectiveContext?: DriftRetrospectiveContext;
}

export interface StructuralEvaluateContext {
  phase: 'evaluating';
  stage: 'structural';
  commands: StructuralCommand[];
  message: string;
}

export interface ContextualEvaluateContext {
  systemPrompt: string;
  evaluatePrompt: string;
  phase: 'evaluating';
  stage: 'contextual';
  spec: Spec;
  taskResults: TaskExecutionResult[];
  classifiedACs: ClassifiedAC[];
  structuralResult: StructuralResult;
}

export interface PassthroughEvaluateResult {
  session: ExecuteSession;
  stage: EvaluateStage;
  structuralContext?: StructuralEvaluateContext;
  contextualContext?: ContextualEvaluateContext;
  evaluationResult?: EvaluationResult;
  shortCircuited?: boolean;
}

// ─── Evolution Loop Types ────────────────────────────────────────

export interface StructuralFixContext {
  systemPrompt: string;
  fixPrompt: string;
  phase: 'evolving';
  stage: 'fix';
  failedCommands: StructuralResult['commands'];
}

export interface ContextualEvolveContext {
  systemPrompt: string;
  evolvePrompt: string;
  phase: 'evolving';
  stage: 'evolve';
  evaluationResult: EvaluationResult;
  evolutionHistory: ExecuteSession['evolutionHistory'];
}

export interface ReExecutionContext {
  systemPrompt: string;
  taskPrompt: string;
  phase: 'evolving';
  stage: 're_execute';
  currentTask: AtomicTask;
  impactedTaskIds: string[];
  patchSummary: string;
}

export interface PassthroughEvolveFixResult {
  session: ExecuteSession;
  fixContext?: StructuralFixContext;
  evolveContext?: ContextualEvolveContext;
  lateralContext?: LateralContext;
  humanEscalation?: EscalationContext;
  terminated?: boolean;
  terminationReason?: TerminationReason;
}

export interface PassthroughEvolvePatchResult {
  session: ExecuteSession;
  reExecuteContext?: ReExecutionContext;
  impactedTaskIds: string[];
  terminated?: boolean;
  terminationReason?: TerminationReason;
}

export interface PassthroughReExecuteResult {
  session: ExecuteSession;
  reExecuteContext?: ReExecutionContext;
  allTasksCompleted: boolean;
}
