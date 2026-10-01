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
  DAGValidation,
} from '../../core/types.js';
import { GestaltPrinciple } from '../../core/types.js';
import {
  ExecuteError,
  ExecuteSessionNotFoundError,
  InvalidPlanningStepError,
} from '../../core/errors.js';
import { type Result, ok, err } from '../../core/result.js';
import {
  PLANNING_PRINCIPLE_SEQUENCE,
  PLANNING_TOTAL_STEPS,
  PLANNING_PRINCIPLE_STRATEGIES,
  MAX_ATOMIC_TASKS,
  MAX_TASK_GROUPS,
} from '../../core/constants.js';
import { EventStore } from '../../events/store.js';
import { EventType } from '../../events/types.js';
import { ExecuteSessionManager } from '../session.js';
import { EXECUTE_SYSTEM_PROMPT, buildPlanningStepPrompt } from '../prompts.js';
import { validateDAG } from '../dag-validator.js';
import { computeParallelGroups } from '../parallel-groups.js';
import { assignModelHints } from '../model-hint.js';
import type { AgentRegistry } from '../../agent/registry.js';
import { mergeSystemPrompt } from '../../agent/prompt-resolver.js';
import type { RoleAgentRegistry } from '../../agent/role-agent-registry.js';
import type {
  ExecuteContext,
  PassthroughStartResult,
  PassthroughPlanStepResult,
  PassthroughPlanCompleteResult,
} from './types.js';

/**
 * DAG가 무효라서 플래닝을 closure 이전으로 되감았다는 신호.
 * 순환은 closure의 dependsOn에서 생기므로 continuity만 다시 내서는 못 고친다.
 * executeContext는 다시 할 closure 단계의 프롬프트다.
 */
export class PlanningRewoundError extends InvalidPlanningStepError {
  constructor(
    message: string,
    public readonly dagValidation: DAGValidation,
    public readonly executeContext: ExecuteContext,
  ) {
    super(message);
    this.name = 'PlanningRewoundError';
  }
}

const REWIND_PRINCIPLE = GestaltPrinciple.CLOSURE;

function findClosureStep(session: ExecuteSession): ClosureResult | undefined {
  return session.planningSteps.find((s) => s.principle === 'closure') as ClosureResult | undefined;
}

function findProximityStep(session: ExecuteSession): ProximityResult | undefined {
  return session.planningSteps.find((s) => s.principle === 'proximity') as
    | ProximityResult
    | undefined;
}

export class PlanningOrchestrator {
  constructor(
    private sessionManager: ExecuteSessionManager,
    private eventStore: EventStore,
    private agentRegistry?: AgentRegistry,
    _roleAgentRegistry?: RoleAgentRegistry,
  ) {}

  start(
    spec: Spec,
    opts: { codeGraphRepoRoot?: string } = {},
  ): Result<PassthroughStartResult, ExecuteError> {
    try {
      const session = this.sessionManager.create(spec, {
        codeGraphRepoRoot: opts.codeGraphRepoRoot,
      });

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

      if (stepResult.principle === 'continuity') {
        const serverDAG = this.resolveServerDAG(session);
        if (!serverDAG) {
          return err(
            new InvalidPlanningStepError(
              'Closure and Proximity steps must be completed before Continuity',
            ),
          );
        }
        if (!stepResult.dagValidation.isValid || !serverDAG.isValid) {
          return err(this.rewindToClosure(session, stepResult.dagValidation, serverDAG));
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

  planComplete(sessionId: string): Result<PassthroughPlanCompleteResult, ExecuteError> {
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
      const closureStep = findClosureStep(session);
      const proximityStep = findProximityStep(session);
      const continuityStep = session.planningSteps.find((s) => s.principle === 'continuity') as
        | ContinuityResult
        | undefined;

      const serverDAG = this.resolveServerDAG(session);
      if (!fgStep || !closureStep || !proximityStep || !continuityStep || !serverDAG) {
        return err(new ExecuteError('Missing planning step results'));
      }

      this.eventStore.append('execute', sessionId, EventType.EXECUTE_PLAN_VALIDATED, {
        callerValid: continuityStep.dagValidation.isValid,
        serverValid: serverDAG.isValid,
      });

      // 저장된 continuity가 검증 없이 들어온 무효 DAG일 수 있다
      if (!continuityStep.dagValidation.isValid || !serverDAG.isValid) {
        return err(this.rewindToClosure(session, continuityStep.dagValidation, serverDAG));
      }

      // Auto-assign per-task model hints for Passthrough sub-agent spawning
      const atomicTasks = assignModelHints(closureStep.atomicTasks);

      const parallelGroups = computeParallelGroups(atomicTasks, serverDAG.topologicalOrder);

      const plan: ExecutionPlan = {
        planId: randomUUID(),
        specId: session.specId,
        classifiedACs: fgStep.classifiedACs,
        atomicTasks,
        taskGroups: proximityStep.taskGroups,
        dagValidation: serverDAG,
        parallelGroups,
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
        new ExecuteError(`Failed to complete plan: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
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

  private resolveServerDAG(session: ExecuteSession): DAGValidation | null {
    const closureStep = findClosureStep(session);
    const proximityStep = findProximityStep(session);
    if (!closureStep || !proximityStep) return null;
    return validateDAG(closureStep.atomicTasks, proximityStep.taskGroups);
  }

  /**
   * closure부터 다시 하도록 planningSteps를 figure_ground까지만 남긴다.
   * 호출자와 서버 중 한쪽이라도 무효라고 하면 되감는다. 서버가 못 찾은 문제는 호출자 보고에서 가져온다.
   */
  private rewindToClosure(
    session: ExecuteSession,
    callerDAG: DAGValidation,
    serverDAG: DAGValidation,
  ): PlanningRewoundError {
    const dagValidation = serverDAG.isValid ? callerDAG : serverDAG;
    const keepSteps = PLANNING_PRINCIPLE_SEQUENCE.indexOf(REWIND_PRINCIPLE);
    const issues = [
      ...(dagValidation.cycleDetails ?? []),
      ...(dagValidation.conflictDetails ?? []),
    ];

    this.sessionManager.rewindPlanning(session.sessionId, keepSteps, {
      toPrinciple: REWIND_PRINCIPLE,
      reason: serverDAG.isValid ? 'caller_reported_invalid' : 'server_detected_invalid',
      dagValidation,
    });

    const rewound = this.sessionManager.get(session.sessionId);
    const executeContext = this.buildExecuteContext(
      rewound.spec,
      keepSteps + 1,
      rewound.planningSteps,
    );

    return new PlanningRewoundError(
      `Dependency DAG is invalid (${issues.join('; ') || 'reported invalid without details'}). ` +
        `Planning was rewound to the ${REWIND_PRINCIPLE} step — fix the dependsOn relations and resubmit ${REWIND_PRINCIPLE}, proximity, and continuity.`,
      dagValidation,
      executeContext,
    );
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
