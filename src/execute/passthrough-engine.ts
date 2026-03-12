import { randomUUID } from 'node:crypto';
import type {
  Spec,
  ExecuteSession,
  ExecutionPlan,
  PlanningStepResult,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
  ClassifiedAC,
  AtomicTask,
  TaskExecutionResult,
  EvaluationResult,
  StructuralCommand,
  StructuralResult,
  EvaluateStage,
  DriftScore,
  FixTask,
  SpecPatch,
  TerminationReason,
} from '../core/types.js';
import {
  ExecuteError,
  ExecuteSessionNotFoundError,
  InvalidPlanningStepError,
  TaskExecutionError,
  EvaluationError,
} from '../core/errors.js';
import { type Result, ok, err } from '../core/result.js';
import {
  PLANNING_PRINCIPLE_SEQUENCE,
  PLANNING_TOTAL_STEPS,
  PLANNING_PRINCIPLE_STRATEGIES,
  MAX_ATOMIC_TASKS,
  MAX_TASK_GROUPS,
} from '../core/constants.js';
import { EventStore } from '../events/store.js';
import { EventType } from '../events/types.js';
import { EXECUTION_PRINCIPLE_STRATEGY } from '../core/constants.js';
import { GestaltPrinciple } from '../core/types.js';
import { ExecuteSessionManager } from './session.js';
import {
  EXECUTE_SYSTEM_PROMPT,
  EXECUTE_EXECUTION_SYSTEM_PROMPT,
  EXECUTE_EVALUATION_SYSTEM_PROMPT,
  EVOLVE_STRUCTURAL_FIX_SYSTEM_PROMPT,
  EVOLVE_CONTEXTUAL_SYSTEM_PROMPT,
  buildPlanningStepPrompt,
  buildTaskExecutionPrompt,
  buildContextualEvaluationPrompt,
  buildDriftRetrospectivePrompt,
  buildStructuralFixPrompt,
  buildContextualEvolvePrompt,
  buildReExecutionPrompt,
} from './prompts.js';
import { validateDAG } from './dag-validator.js';
import { measureDrift } from './drift-detector.js';
import { DRIFT_THRESHOLD } from '../core/constants.js';
import { validateSpecPatch } from './spec-patch-validator.js';
import { applySpecPatch } from './spec-patch-applier.js';
import { identifyImpactedTasks } from './impact-identifier.js';
import { checkTermination } from './termination-detector.js';
import type { AgentRegistry } from '../agent/registry.js';
import { mergeSystemPrompt } from '../agent/prompt-resolver.js';

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

// ─── Engine ─────────────────────────────────────────────────────

export class PassthroughExecuteEngine {
  private sessionManager: ExecuteSessionManager;
  private agentRegistry?: AgentRegistry;

  constructor(private eventStore: EventStore, agentRegistry?: AgentRegistry) {
    this.sessionManager = new ExecuteSessionManager(eventStore);
    this.sessionManager.loadFromStore();
    this.agentRegistry = agentRegistry;
  }

  start(spec: Spec): Result<PassthroughStartResult, ExecuteError> {
    try {
      const session = this.sessionManager.create(spec);

      const executeContext = this.buildExecuteContext(spec, 1, []);

      return ok({ session, executeContext });
    } catch (e) {
      return err(
        new ExecuteError(
          `Failed to start execute session: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  planStep(
    sessionId: string,
    stepResult: PlanningStepResult,
  ): Result<PassthroughPlanStepResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'planning') {
        return err(new ExecuteError(`Session is not in planning state: ${session.status}`));
      }

      // Validate step order
      const expectedStep = session.planningSteps.length + 1;
      const expectedPrinciple = PLANNING_PRINCIPLE_SEQUENCE[expectedStep - 1];
      if (stepResult.principle !== expectedPrinciple) {
        return err(
          new InvalidPlanningStepError(
            `Expected principle "${expectedPrinciple}" for step ${expectedStep}, got "${stepResult.principle}"`,
          ),
        );
      }

      // Validate step result content
      const validationError = this.validateStepResult(session, stepResult);
      if (validationError) {
        return err(new InvalidPlanningStepError(validationError));
      }

      // For Continuity step: server-side cross-validation
      if (stepResult.principle === 'continuity') {
        const crossValidation = this.crossValidateDAG(session, stepResult);
        if (crossValidation) {
          return err(new InvalidPlanningStepError(crossValidation));
        }
      }

      this.sessionManager.addPlanningStep(sessionId, stepResult);

      const isLastStep = session.planningSteps.length >= PLANNING_TOTAL_STEPS;

      if (isLastStep) {
        return ok({
          session: this.sessionManager.get(sessionId),
          isLastStep: true,
        });
      }

      const nextStep = session.planningSteps.length + 1;
      const executeContext = this.buildExecuteContext(
        session.spec,
        nextStep,
        session.planningSteps,
      );

      return ok({
        session: this.sessionManager.get(sessionId),
        executeContext,
        isLastStep: false,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError || e instanceof InvalidPlanningStepError) {
        return err(e);
      }
      return err(
        new ExecuteError(
          `Failed to process planning step: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  planComplete(
    sessionId: string,
  ): Result<PassthroughPlanCompleteResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.planningSteps.length < PLANNING_TOTAL_STEPS) {
        return err(
          new ExecuteError(
            `Planning is not complete: ${session.planningSteps.length}/${PLANNING_TOTAL_STEPS} steps done`,
          ),
        );
      }

      // Assemble ExecutionPlan from all steps
      const fgStep = session.planningSteps.find((s) => s.principle === 'figure_ground') as
        | FigureGroundResult
        | undefined;
      const closureStep = session.planningSteps.find((s) => s.principle === 'closure') as
        | ClosureResult
        | undefined;
      const proximityStep = session.planningSteps.find((s) => s.principle === 'proximity') as
        | ProximityResult
        | undefined;
      const continuityStep = session.planningSteps.find((s) => s.principle === 'continuity') as
        | ContinuityResult
        | undefined;

      if (!fgStep || !closureStep || !proximityStep || !continuityStep) {
        return err(new ExecuteError('Missing planning step results'));
      }

      // Final DAG validation on server side
      const serverDAG = validateDAG(closureStep.atomicTasks, proximityStep.taskGroups);

      this.eventStore.append('execute', sessionId, EventType.EXECUTE_PLAN_VALIDATED, {
        callerValid: continuityStep.dagValidation.isValid,
        serverValid: serverDAG.isValid,
      });

      const plan: ExecutionPlan = {
        planId: randomUUID(),
        specId: session.specId,
        classifiedACs: fgStep.classifiedACs,
        atomicTasks: closureStep.atomicTasks,
        taskGroups: proximityStep.taskGroups,
        dagValidation: serverDAG,
        createdAt: new Date().toISOString(),
      };

      this.sessionManager.completePlan(sessionId, plan);

      return ok({
        session: this.sessionManager.get(sessionId),
        executionPlan: plan,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) {
        return err(e);
      }
      return err(
        new ExecuteError(
          `Failed to complete plan: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  // ─── Execution Phase ──────────────────────────────────────────

  startExecution(
    sessionId: string,
  ): Result<PassthroughExecutionStartResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'plan_complete') {
        return err(new TaskExecutionError(
          `Cannot start execution: session status is "${session.status}", expected "plan_complete"`,
        ));
      }

      if (!session.executionPlan) {
        return err(new TaskExecutionError('No execution plan found'));
      }

      this.sessionManager.startExecution(sessionId);

      const taskContext = this.buildNextTaskContext(
        this.sessionManager.get(sessionId),
      );

      return ok({
        session: this.sessionManager.get(sessionId),
        taskContext,
        allTasksCompleted: taskContext === null,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(new TaskExecutionError(
        `Failed to start execution: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }
  }

  submitTaskResult(
    sessionId: string,
    taskResult: TaskExecutionResult,
    driftThreshold?: number,
  ): Result<PassthroughTaskSubmitResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'executing') {
        return err(new TaskExecutionError(
          `Cannot submit task result: session status is "${session.status}", expected "executing"`,
        ));
      }

      if (!session.executionPlan) {
        return err(new TaskExecutionError('No execution plan found'));
      }

      // Validate taskId exists in plan
      const task = session.executionPlan.atomicTasks.find((t) => t.taskId === taskResult.taskId);
      if (!task) {
        return err(new TaskExecutionError(
          `Task "${taskResult.taskId}" not found in execution plan`,
        ));
      }

      this.sessionManager.addTaskResult(sessionId, taskResult);

      // Drift Detection (only for completed tasks)
      let driftScore: DriftScore | undefined;
      let retrospectiveContext: DriftRetrospectiveContext | undefined;

      if (taskResult.status === 'completed') {
        const threshold = driftThreshold ?? DRIFT_THRESHOLD;
        driftScore = measureDrift(session.spec, task, taskResult, threshold);
        this.sessionManager.addDriftScore(sessionId, driftScore);

        if (driftScore.thresholdExceeded) {
          this.eventStore.append('execute', sessionId, EventType.EXECUTE_DRIFT_RETROSPECTIVE, {
            taskId: taskResult.taskId,
            driftScore,
          });

          retrospectiveContext = {
            systemPrompt: mergeSystemPrompt(EXECUTE_EXECUTION_SYSTEM_PROMPT, this.agentRegistry, 'execute'),
            retrospectivePrompt: buildDriftRetrospectivePrompt(
              session.spec,
              task,
              taskResult,
              driftScore,
            ),
            driftScore,
          };
        }
      }

      const updatedSession = this.sessionManager.get(sessionId);
      const taskContext = this.buildNextTaskContext(updatedSession);
      const allTasksCompleted = taskContext === null;

      return ok({
        session: updatedSession,
        taskContext,
        allTasksCompleted,
        driftScore,
        retrospectiveContext,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(new TaskExecutionError(
        `Failed to submit task result: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }
  }

  // ─── Evaluate Phase (2-Stage Pipeline) ──────────────────────

  /**
   * Call 1: Start evaluation → returns structural commands to run.
   */
  startEvaluation(
    sessionId: string,
  ): Result<PassthroughEvaluateResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'executing') {
        return err(new EvaluationError(
          `Cannot start evaluation: session status is "${session.status}", expected "executing"`,
        ));
      }

      if (!session.executionPlan) {
        return err(new EvaluationError('No execution plan found'));
      }

      this.sessionManager.startStructuralEvaluation(sessionId);

      const commands: StructuralCommand[] = [
        { name: 'lint', command: 'npm run lint' },
        { name: 'build', command: 'npm run build' },
        { name: 'test', command: 'npm test' },
      ];

      return ok({
        session: this.sessionManager.get(sessionId),
        stage: 'structural',
        structuralContext: {
          phase: 'evaluating',
          stage: 'structural',
          commands,
          message: 'Run these structural checks and submit results. Adapt commands to your project (e.g., pnpm/yarn). All must pass to proceed to contextual evaluation.',
        },
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(new EvaluationError(
        `Failed to start evaluation: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }
  }

  /**
   * Call 2: Submit structural results → returns contextual context or short-circuits.
   */
  submitStructuralResult(
    sessionId: string,
    structuralResult: StructuralResult,
  ): Result<PassthroughEvaluateResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'executing' || session.evaluateStage !== 'structural') {
        return err(new EvaluationError(
          `Cannot submit structural result: expected stage "structural", got "${session.evaluateStage ?? 'none'}"`,
        ));
      }

      this.sessionManager.completeStructuralStage(sessionId, structuralResult);

      // Short-circuit if structural checks failed
      if (!structuralResult.allPassed) {
        const failedCommands = structuralResult.commands
          .filter((c) => c.exitCode !== 0)
          .map((c) => `${c.name} (exit ${c.exitCode})`)
          .join(', ');

        this.sessionManager.shortCircuitEvaluation(
          sessionId,
          `Structural checks failed: ${failedCommands}`,
        );

        return ok({
          session: this.sessionManager.get(sessionId),
          stage: 'complete',
          shortCircuited: true,
          evaluationResult: this.sessionManager.get(sessionId).evaluationResult,
        });
      }

      // Structural passed → advance to contextual stage
      this.sessionManager.startContextualEvaluation(sessionId);
      const updatedSession = this.sessionManager.get(sessionId);
      const contextualContext = this.buildContextualEvaluateContext(updatedSession);

      return ok({
        session: updatedSession,
        stage: 'contextual',
        contextualContext,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(new EvaluationError(
        `Failed to submit structural result: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }
  }

  /**
   * Call 3: Submit contextual evaluation result → completes session.
   */
  submitEvaluation(
    sessionId: string,
    evaluationResult: EvaluationResult,
  ): Result<PassthroughEvaluateResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (session.status !== 'executing' || session.evaluateStage !== 'contextual') {
        return err(new EvaluationError(
          `Cannot submit evaluation: expected stage "contextual", got "${session.evaluateStage ?? 'none'}"`,
        ));
      }

      // Validate evaluation covers all ACs
      const acCount = session.spec.acceptanceCriteria.length;
      const verifiedIndices = new Set(evaluationResult.verifications.map((v) => v.acIndex));
      for (let i = 0; i < acCount; i++) {
        if (!verifiedIndices.has(i)) {
          return err(new EvaluationError(`AC index ${i} is not verified`));
        }
      }

      // Validate score ranges
      if (evaluationResult.overallScore < 0 || evaluationResult.overallScore > 1) {
        return err(new EvaluationError(
          `overallScore must be between 0 and 1, got ${evaluationResult.overallScore}`,
        ));
      }
      if (evaluationResult.goalAlignment < 0 || evaluationResult.goalAlignment > 1) {
        return err(new EvaluationError(
          `goalAlignment must be between 0 and 1, got ${evaluationResult.goalAlignment}`,
        ));
      }

      this.sessionManager.completeEvaluation(sessionId, evaluationResult);

      return ok({
        session: this.sessionManager.get(sessionId),
        stage: 'complete',
        evaluationResult,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(new EvaluationError(
        `Failed to submit evaluation: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }
  }

  getSession(sessionId: string): ExecuteSession {
    return this.sessionManager.get(sessionId);
  }

  listSessions(): ExecuteSession[] {
    return this.sessionManager.list();
  }

  // ─── Evolution Loop ────────────────────────────────────────────

  /**
   * evolve_fix: Structural 실패 시 fix context를 반환하거나, fix 결과를 제출한다.
   * - fixTasks 없으면: fixContext 반환 (caller가 fix 생성)
   * - fixTasks 있으면: fix 기록 후 re-evaluate를 위한 상태 복원
   */
  startStructuralFix(
    sessionId: string,
    fixTasks?: FixTask[],
  ): Result<PassthroughEvolveFixResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      // Call 1: Return fix context (no fixTasks submitted)
      if (!fixTasks) {
        if (!session.structuralResult || session.structuralResult.allPassed) {
          return err(new ExecuteError('No structural failures to fix'));
        }

        this.sessionManager.startStructuralFix(sessionId);
        const failedCommands = session.structuralResult.commands.filter((c) => c.exitCode !== 0);

        return ok({
          session: this.sessionManager.get(sessionId),
          fixContext: {
            systemPrompt: mergeSystemPrompt(EVOLVE_STRUCTURAL_FIX_SYSTEM_PROMPT, this.agentRegistry, 'evaluate'),
            fixPrompt: buildStructuralFixPrompt(session.spec, failedCommands, session.taskResults),
            phase: 'evolving',
            stage: 'fix',
            failedCommands,
          },
        });
      }

      // Call 2: Submit fix results
      this.sessionManager.completeStructuralFix(sessionId, fixTasks);

      // Reset evaluation state for re-evaluate
      const updated = this.sessionManager.get(sessionId);
      updated.evaluateStage = undefined;
      updated.structuralResult = undefined;
      updated.evaluationResult = undefined;
      updated.status = 'executing';
      updated.updatedAt = new Date().toISOString();

      return ok({
        session: updated,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(new ExecuteError(
        `Failed structural fix: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }
  }

  /**
   * evolve: Contextual evolution 시작.
   * - evaluationResult에서 gap 분석 후 evolveContext 반환
   * - caller가 SpecPatch를 생성
   * - terminateReason='caller'이면 즉시 종료
   */
  startContextualEvolve(
    sessionId: string,
    terminateReason?: 'caller',
  ): Result<PassthroughEvolveFixResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      // Caller-initiated termination
      if (terminateReason === 'caller') {
        this.sessionManager.terminate(sessionId, 'caller');
        return ok({
          session: this.sessionManager.get(sessionId),
          terminated: true,
          terminationReason: 'caller',
        });
      }

      if (!session.evaluationResult) {
        return err(new ExecuteError('No evaluation result found. Run evaluate first.'));
      }

      // Check termination conditions
      const termination = checkTermination({
        evolutionHistory: session.evolutionHistory,
        currentScore: session.evaluationResult.overallScore,
        currentGoalAlignment: session.evaluationResult.goalAlignment,
        structuralFixCount: this.countStructuralFixes(session),
        contextualCount: session.evolutionHistory.length,
      });

      if (termination) {
        this.sessionManager.terminate(sessionId, termination.reason);
        return ok({
          session: this.sessionManager.get(sessionId),
          terminated: true,
          terminationReason: termination.reason,
        });
      }

      return ok({
        session,
        evolveContext: {
          systemPrompt: mergeSystemPrompt(EVOLVE_CONTEXTUAL_SYSTEM_PROMPT, this.agentRegistry, 'evaluate'),
          evolvePrompt: buildContextualEvolvePrompt(
            session.spec,
            session.evaluationResult,
            session.evolutionHistory,
          ),
          phase: 'evolving',
          stage: 'evolve',
          evaluationResult: session.evaluationResult,
          evolutionHistory: session.evolutionHistory,
        },
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(new ExecuteError(
        `Failed contextual evolve: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }
  }

  /**
   * evolve_patch: Spec 패치 제출 → 검증 → 적용 → impacted tasks 식별 → re-execute context 반환
   */
  submitSpecPatch(
    sessionId: string,
    patch: SpecPatch,
  ): Result<PassthroughEvolvePatchResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (!session.executionPlan) {
        return err(new ExecuteError('No execution plan found'));
      }

      // Validate patch
      const validation = validateSpecPatch(patch, session.spec);
      if (!validation.valid) {
        const msgs = validation.errors.map((e) => `${e.field}: ${e.message}`).join('; ');
        return err(new ExecuteError(`Invalid spec patch: ${msgs}`));
      }

      // Apply patch
      const generation = session.currentGeneration + 1;
      const { newSpec, delta } = applySpecPatch(session.spec, patch, generation);

      // Record generation snapshot BEFORE applying
      this.sessionManager.recordEvolutionGeneration(sessionId, {
        generation: session.currentGeneration,
        spec: session.spec,
        evaluationScore: session.evaluationResult?.overallScore ?? 0,
        goalAlignment: session.evaluationResult?.goalAlignment ?? 0,
        delta,
      });

      // Apply patch to session
      this.sessionManager.patchSpec(sessionId, patch, newSpec, delta);

      // Identify impacted tasks
      const driftThreshold = DRIFT_THRESHOLD;
      const impactedTaskIds = identifyImpactedTasks(
        session.executionPlan.atomicTasks,
        session.driftHistory,
        delta,
        driftThreshold,
      );

      if (impactedTaskIds.length === 0) {
        // No tasks need re-execution, just re-evaluate
        return ok({
          session: this.sessionManager.get(sessionId),
          impactedTaskIds: [],
        });
      }

      // Start re-execution
      this.sessionManager.startReExecution(sessionId, impactedTaskIds);

      const updatedSession = this.sessionManager.get(sessionId);
      const reExecuteContext = this.buildReExecuteContext(updatedSession, impactedTaskIds, delta);

      return ok({
        session: updatedSession,
        reExecuteContext: reExecuteContext ?? undefined,
        impactedTaskIds,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(new ExecuteError(
        `Failed to submit spec patch: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }
  }

  /**
   * evolve_re_execute: Re-execution 중 태스크 결과 제출
   */
  submitReExecuteTaskResult(
    sessionId: string,
    taskResult: TaskExecutionResult,
  ): Result<PassthroughReExecuteResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (!session.executionPlan) {
        return err(new ExecuteError('No execution plan found'));
      }

      // Validate task exists
      const task = session.executionPlan.atomicTasks.find((t) => t.taskId === taskResult.taskId);
      if (!task) {
        return err(new TaskExecutionError(
          `Task "${taskResult.taskId}" not found in execution plan`,
        ));
      }

      this.sessionManager.addEvolveTaskResult(sessionId, taskResult);

      const updatedSession = this.sessionManager.get(sessionId);
      const nextContext = this.buildNextReExecuteTaskContext(updatedSession);

      return ok({
        session: updatedSession,
        reExecuteContext: nextContext ?? undefined,
        allTasksCompleted: nextContext === null,
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(new TaskExecutionError(
        `Failed to submit re-execute task result: ${e instanceof Error ? e.message : String(e)}`,
      ));
    }
  }

  private countStructuralFixes(session: ExecuteSession): number {
    // Count from event history: how many EVOLVE_STRUCTURAL_FIX_STARTED events
    const events = this.eventStore.replay('execute', session.sessionId);
    return events.filter((e) => e.eventType === EventType.EVOLVE_STRUCTURAL_FIX_STARTED).length;
  }

  private buildReExecuteContext(
    session: ExecuteSession,
    impactedTaskIds: string[],
    delta: { fieldsChanged: string[] },
  ): ReExecutionContext | null {
    if (!session.executionPlan) return null;

    const plan = session.executionPlan;
    const completedIds = new Set(
      session.taskResults
        .filter((r) => r.status === 'completed' || r.status === 'skipped')
        .map((r) => r.taskId),
    );

    // Find first impacted task that's not yet completed
    const topoOrder = plan.dagValidation.topologicalOrder;
    for (const taskId of topoOrder) {
      if (!impactedTaskIds.includes(taskId)) continue;
      if (completedIds.has(taskId)) continue;

      const task = plan.atomicTasks.find((t) => t.taskId === taskId);
      if (!task) continue;

      const depsResolved = task.dependsOn.every((dep) => completedIds.has(dep));
      if (!depsResolved) continue;

      const patchSummary = `Fields changed: ${delta.fieldsChanged.join(', ')}`;
      return {
        systemPrompt: mergeSystemPrompt(EXECUTE_EXECUTION_SYSTEM_PROMPT, this.agentRegistry, 'execute'),
        taskPrompt: buildReExecutionPrompt(task, session.spec, session.taskResults, patchSummary),
        phase: 'evolving',
        stage: 're_execute',
        currentTask: task,
        impactedTaskIds,
        patchSummary,
      };
    }

    return null;
  }

  private buildNextReExecuteTaskContext(session: ExecuteSession): ReExecutionContext | null {
    if (!session.executionPlan) return null;

    // Find impacted tasks that are not yet completed
    const plan = session.executionPlan;
    const completedIds = new Set(
      session.taskResults
        .filter((r) => r.status === 'completed' || r.status === 'skipped')
        .map((r) => r.taskId),
    );

    const topoOrder = plan.dagValidation.topologicalOrder;
    for (const taskId of topoOrder) {
      if (completedIds.has(taskId)) continue;

      const task = plan.atomicTasks.find((t) => t.taskId === taskId);
      if (!task) continue;

      const depsResolved = task.dependsOn.every((dep) => completedIds.has(dep));
      if (!depsResolved) continue;

      const delta = session.evolutionHistory.length > 0
        ? session.evolutionHistory[session.evolutionHistory.length - 1]!.delta
        : { fieldsChanged: [] };

      const patchSummary = `Fields changed: ${delta.fieldsChanged.join(', ')}`;
      return {
        systemPrompt: mergeSystemPrompt(EXECUTE_EXECUTION_SYSTEM_PROMPT, this.agentRegistry, 'execute'),
        taskPrompt: buildReExecutionPrompt(task, session.spec, session.taskResults, patchSummary),
        phase: 'evolving',
        stage: 're_execute',
        currentTask: task,
        impactedTaskIds: [],
        patchSummary,
      };
    }

    return null;
  }

  // ─── Execution context builders ────────────────────────────────

  private buildNextTaskContext(session: ExecuteSession): TaskExecutionContext | null {
    if (!session.executionPlan) return null;

    const plan = session.executionPlan;
    const completedIds = new Set(
      session.taskResults
        .filter((r) => r.status === 'completed' || r.status === 'skipped')
        .map((r) => r.taskId),
    );
    const failedIds = new Set(
      session.taskResults.filter((r) => r.status === 'failed').map((r) => r.taskId),
    );

    // Find next executable task (all dependencies satisfied, not yet done)
    const topoOrder = plan.dagValidation.topologicalOrder;
    let nextTask: AtomicTask | null = null;

    for (const taskId of topoOrder) {
      if (completedIds.has(taskId) || failedIds.has(taskId)) continue;

      const task = plan.atomicTasks.find((t) => t.taskId === taskId);
      if (!task) continue;

      const depsResolved = task.dependsOn.every(
        (dep) => completedIds.has(dep) || failedIds.has(dep),
      );
      if (depsResolved) {
        nextTask = task;
        break;
      }
    }

    if (!nextTask) return null;

    // Find similar completed tasks (Similarity principle)
    const similarTasks = this.findSimilarTasks(nextTask, plan.atomicTasks, completedIds);

    const completedResults = session.taskResults.filter(
      (r) => r.status === 'completed',
    );

    const pendingTasks = plan.atomicTasks.filter(
      (t) => !completedIds.has(t.taskId) && !failedIds.has(t.taskId) && t.taskId !== nextTask!.taskId,
    );

    const taskPrompt = buildTaskExecutionPrompt(
      nextTask,
      session.spec,
      completedResults,
      similarTasks,
    );

    return {
      systemPrompt: mergeSystemPrompt(EXECUTE_EXECUTION_SYSTEM_PROMPT, this.agentRegistry, 'execute'),
      taskPrompt,
      phase: 'executing',
      currentTask: nextTask,
      similarityStrategy: EXECUTION_PRINCIPLE_STRATEGY[GestaltPrinciple.SIMILARITY]!,
      pendingTasks,
      completedTaskIds: Array.from(completedIds),
    };
  }

  private findSimilarTasks(
    target: AtomicTask,
    allTasks: AtomicTask[],
    completedIds: Set<string>,
  ): AtomicTask[] {
    return allTasks.filter((t) => {
      if (!completedIds.has(t.taskId)) return false;
      if (t.taskId === target.taskId) return false;

      // Same complexity or overlapping sourceAC = similar
      const sharedAC = t.sourceAC.some((ac) => target.sourceAC.includes(ac));
      const sameComplexity = t.estimatedComplexity === target.estimatedComplexity;
      return sharedAC || sameComplexity;
    });
  }

  private buildContextualEvaluateContext(session: ExecuteSession): ContextualEvaluateContext {
    const plan = session.executionPlan!;
    const evaluatePrompt = buildContextualEvaluationPrompt(
      session.spec,
      plan.classifiedACs,
      session.taskResults,
      session.structuralResult!,
    );

    return {
      systemPrompt: mergeSystemPrompt(EXECUTE_EVALUATION_SYSTEM_PROMPT, this.agentRegistry, 'evaluate'),
      evaluatePrompt,
      phase: 'evaluating',
      stage: 'contextual',
      spec: session.spec,
      taskResults: session.taskResults,
      classifiedACs: plan.classifiedACs,
      structuralResult: session.structuralResult!,
    };
  }

  // ─── Validation helpers ───────────────────────────────────────

  private validateStepResult(
    session: ExecuteSession,
    stepResult: PlanningStepResult,
  ): string | null {
    switch (stepResult.principle) {
      case 'figure_ground':
        return this.validateFigureGround(session.spec, stepResult);
      case 'closure':
        return this.validateClosure(session, stepResult);
      case 'proximity':
        return this.validateProximity(session, stepResult);
      case 'continuity':
        return null; // Cross-validated separately
      default:
        return `Unknown principle: ${(stepResult as PlanningStepResult).principle}`;
    }
  }

  private validateFigureGround(spec: Spec, result: FigureGroundResult): string | null {
    const { classifiedACs } = result;
    if (!classifiedACs || classifiedACs.length === 0) {
      return 'classifiedACs is required and must not be empty';
    }

    const acCount = spec.acceptanceCriteria.length;
    const indices = new Set(classifiedACs.map((ac) => ac.acIndex));

    // Check all ACs are classified
    for (let i = 0; i < acCount; i++) {
      if (!indices.has(i)) {
        return `AC index ${i} is not classified`;
      }
    }

    // Check for out-of-range indices
    for (const ac of classifiedACs) {
      if (ac.acIndex < 0 || ac.acIndex >= acCount) {
        return `AC index ${ac.acIndex} is out of range (0-${acCount - 1})`;
      }
    }

    return null;
  }

  private validateClosure(session: ExecuteSession, result: ClosureResult): string | null {
    const { atomicTasks } = result;
    if (!atomicTasks || atomicTasks.length === 0) {
      return 'atomicTasks is required and must not be empty';
    }

    if (atomicTasks.length > MAX_ATOMIC_TASKS) {
      return `Too many atomic tasks: ${atomicTasks.length} (max ${MAX_ATOMIC_TASKS})`;
    }

    // Check taskId uniqueness
    const taskIds = new Set<string>();
    for (const task of atomicTasks) {
      if (taskIds.has(task.taskId)) {
        return `Duplicate taskId: ${task.taskId}`;
      }
      taskIds.add(task.taskId);
    }

    // Check sourceAC references
    const fgStep = session.planningSteps.find((s) => s.principle === 'figure_ground') as
      | FigureGroundResult
      | undefined;
    if (fgStep) {
      const validIndices = new Set(fgStep.classifiedACs.map((ac) => ac.acIndex));
      for (const task of atomicTasks) {
        if (!task.isImplicit) {
          for (const acIdx of task.sourceAC) {
            if (!validIndices.has(acIdx)) {
              return `Task "${task.taskId}" references invalid AC index ${acIdx}`;
            }
          }
        }
      }
    }

    // Check dependsOn references
    for (const task of atomicTasks) {
      for (const dep of task.dependsOn) {
        if (!taskIds.has(dep)) {
          return `Task "${task.taskId}" depends on non-existent task "${dep}"`;
        }
      }
    }

    return null;
  }

  private validateProximity(session: ExecuteSession, result: ProximityResult): string | null {
    const { taskGroups } = result;
    if (!taskGroups || taskGroups.length === 0) {
      return 'taskGroups is required and must not be empty';
    }

    if (taskGroups.length > MAX_TASK_GROUPS) {
      return `Too many task groups: ${taskGroups.length} (max ${MAX_TASK_GROUPS})`;
    }

    // Get valid task IDs from Closure step
    const closureStep = session.planningSteps.find((s) => s.principle === 'closure') as
      | ClosureResult
      | undefined;
    if (!closureStep) {
      return 'Closure step must be completed before Proximity';
    }

    const validTaskIds = new Set(closureStep.atomicTasks.map((t) => t.taskId));
    const assignedTaskIds = new Set<string>();

    // Check groupId uniqueness
    const groupIds = new Set<string>();
    for (const group of taskGroups) {
      if (groupIds.has(group.groupId)) {
        return `Duplicate groupId: ${group.groupId}`;
      }
      groupIds.add(group.groupId);

      for (const tid of group.taskIds) {
        if (!validTaskIds.has(tid)) {
          return `Group "${group.groupId}" references invalid task "${tid}"`;
        }
        if (assignedTaskIds.has(tid)) {
          return `Task "${tid}" is assigned to multiple groups`;
        }
        assignedTaskIds.add(tid);
      }
    }

    // Check all tasks are grouped
    for (const tid of validTaskIds) {
      if (!assignedTaskIds.has(tid)) {
        return `Task "${tid}" is not assigned to any group`;
      }
    }

    return null;
  }

  private crossValidateDAG(
    session: ExecuteSession,
    continuityResult: ContinuityResult,
  ): string | null {
    const closureStep = session.planningSteps.find((s) => s.principle === 'closure') as
      | ClosureResult
      | undefined;
    const proximityStep = session.planningSteps.find((s) => s.principle === 'proximity') as
      | ProximityResult
      | undefined;

    if (!closureStep || !proximityStep) {
      return 'Closure and Proximity steps must be completed before Continuity';
    }

    const serverDAG = validateDAG(closureStep.atomicTasks, proximityStep.taskGroups);

    // If caller says valid but server finds issues, flag it
    if (continuityResult.dagValidation.isValid && !serverDAG.isValid) {
      const issues = [
        ...(serverDAG.cycleDetails ?? []),
        ...(serverDAG.conflictDetails ?? []),
      ].join('; ');
      return `Server-side DAG validation disagrees: ${issues}`;
    }

    return null;
  }

  // ─── Context builder ──────────────────────────────────────────

  private buildExecuteContext(
    spec: Spec,
    stepNumber: number,
    previousSteps: PlanningStepResult[],
  ): ExecuteContext {
    const principle = PLANNING_PRINCIPLE_SEQUENCE[stepNumber - 1]!;
    const planningPrompt = buildPlanningStepPrompt(spec, stepNumber, previousSteps);

    return {
      systemPrompt: mergeSystemPrompt(EXECUTE_SYSTEM_PROMPT, this.agentRegistry, 'execute'),
      planningPrompt,
      currentPrinciple: principle,
      principleStrategy: PLANNING_PRINCIPLE_STRATEGIES[principle]!,
      phase: 'planning',
      stepNumber,
      totalSteps: PLANNING_TOTAL_STEPS,
      spec,
      previousSteps,
    };
  }
}
