import type { ExecuteSession, TaskExecutionResult, FixTask, SpecPatch } from '../../core/types.js';
import {
  ExecuteError,
  ExecuteSessionNotFoundError,
  TaskExecutionError,
} from '../../core/errors.js';
import { type Result, ok, err } from '../../core/result.js';
import { EventStore } from '../../events/store.js';
import { EventType } from '../../events/types.js';
import { ExecuteSessionManager } from '../session.js';
import {
  EXECUTE_EXECUTION_SYSTEM_PROMPT,
  EVOLVE_STRUCTURAL_FIX_SYSTEM_PROMPT,
  EVOLVE_CONTEXTUAL_SYSTEM_PROMPT,
  buildStructuralFixPrompt,
  buildContextualEvolvePrompt,
  buildReExecutionPrompt,
} from '../prompts.js';
import { DRIFT_THRESHOLD } from '../../core/constants.js';
import { validateSpecPatch } from '../spec-patch-validator.js';
import { applySpecPatch } from '../spec-patch-applier.js';
import { identifyImpactedTasks } from '../impact-identifier.js';
import { checkTermination } from '../termination-detector.js';
import type { AgentRegistry } from '../../agent/registry.js';
import { mergeSystemPrompt } from '../../agent/prompt-resolver.js';
import { classifyStagnation } from '../../resilience/stagnation-detector.js';
import {
  suggestPersona,
  buildLateralContext,
  buildEscalationContext,
} from '../../resilience/lateral.js';
import type { LateralResult, LateralPersonaName } from '../../resilience/types.js';
import type { RoleAgentRegistry } from '../../agent/role-agent-registry.js';
import type {
  ReExecutionContext,
  PassthroughEvolveFixResult,
  PassthroughEvolvePatchResult,
  PassthroughReExecuteResult,
} from './types.js';

export class EvolutionOrchestrator {
  constructor(
    private sessionManager: ExecuteSessionManager,
    private eventStore: EventStore,
    private agentRegistry?: AgentRegistry,
    _roleAgentRegistry?: RoleAgentRegistry,
  ) {}

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
            systemPrompt: mergeSystemPrompt(
              EVOLVE_STRUCTURAL_FIX_SYSTEM_PROMPT,
              this.agentRegistry,
              'evaluate',
            ),
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
      return err(
        new ExecuteError(`Failed structural fix: ${e instanceof Error ? e.message : String(e)}`),
      );
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
        // Success → terminate normally
        if (termination.reason === 'success') {
          this.sessionManager.terminate(sessionId, 'success');
          return ok({
            session: this.sessionManager.get(sessionId),
            terminated: true,
            terminationReason: 'success',
          });
        }

        // Non-success → lateral thinking
        const pattern = classifyStagnation({
          evolutionHistory: session.evolutionHistory,
          currentScore: session.evaluationResult!.overallScore,
          termination,
        });

        const persona = suggestPersona(
          pattern,
          session.lateralTriedPersonas as LateralPersonaName[],
        );

        if (persona) {
          this.sessionManager.startLateral(sessionId, persona, pattern);
          const lateralCtx = buildLateralContext(
            persona,
            pattern,
            session.spec,
            session.evaluationResult!,
            session.evolutionHistory,
            session.lateralAttempts + 1,
          );
          return ok({
            session: this.sessionManager.get(sessionId),
            lateralContext: lateralCtx,
          });
        }

        // All personas exhausted → human escalation
        this.sessionManager.terminate(sessionId, 'human_escalation');
        this.eventStore.append('execute', sessionId, EventType.EVOLVE_HUMAN_ESCALATION, {
          triedPersonas: session.lateralTriedPersonas,
          bestScore: Math.max(
            ...session.evolutionHistory.map((g) => g.evaluationScore),
            session.evaluationResult!.overallScore,
          ),
        });

        const escalation = buildEscalationContext(
          session.lateralTriedPersonas as LateralPersonaName[],
          session.evaluationResult!,
          session.evolutionHistory,
        );
        return ok({
          session: this.sessionManager.get(sessionId),
          humanEscalation: escalation,
          terminated: true,
          terminationReason: 'human_escalation',
        });
      }

      return ok({
        session,
        evolveContext: {
          systemPrompt: mergeSystemPrompt(
            EVOLVE_CONTEXTUAL_SYSTEM_PROMPT,
            this.agentRegistry,
            'evaluate',
          ),
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
      return err(
        new ExecuteError(`Failed contextual evolve: ${e instanceof Error ? e.message : String(e)}`),
      );
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
      return err(
        new ExecuteError(
          `Failed to submit spec patch: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
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
        return err(
          new TaskExecutionError(`Task "${taskResult.taskId}" not found in execution plan`),
        );
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
      return err(
        new TaskExecutionError(
          `Failed to submit re-execute task result: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  }

  /**
   * evolve_lateral: 다음 lateral persona를 suggest하거나 human_escalation 반환.
   * evolve에서 자동 분기되지만, caller가 명시적으로 다음 persona를 요청할 때도 사용.
   */
  startLateralEvolve(sessionId: string): Result<PassthroughEvolveFixResult, ExecuteError> {
    try {
      const session = this.sessionManager.get(sessionId);

      if (!session.evaluationResult) {
        return err(new ExecuteError('No evaluation result found. Run evaluate first.'));
      }

      // Check termination again (might have succeeded after lateral re-execute)
      const termination = checkTermination({
        evolutionHistory: session.evolutionHistory,
        currentScore: session.evaluationResult.overallScore,
        currentGoalAlignment: session.evaluationResult.goalAlignment,
        structuralFixCount: this.countStructuralFixes(session),
        contextualCount: session.evolutionHistory.length,
      });

      if (termination?.reason === 'success') {
        this.sessionManager.terminate(sessionId, 'success');
        return ok({
          session: this.sessionManager.get(sessionId),
          terminated: true,
          terminationReason: 'success',
        });
      }

      // Classify stagnation for next persona suggestion
      const pattern = termination
        ? classifyStagnation({
            evolutionHistory: session.evolutionHistory,
            currentScore: session.evaluationResult.overallScore,
            termination,
          })
        : ('spinning' as const); // fallback if no termination yet

      const persona = suggestPersona(pattern, session.lateralTriedPersonas as LateralPersonaName[]);

      if (persona) {
        this.sessionManager.startLateral(sessionId, persona, pattern);
        const lateralCtx = buildLateralContext(
          persona,
          pattern,
          session.spec,
          session.evaluationResult,
          session.evolutionHistory,
          session.lateralAttempts + 1,
        );
        return ok({
          session: this.sessionManager.get(sessionId),
          lateralContext: lateralCtx,
        });
      }

      // All personas exhausted → human escalation
      this.sessionManager.terminate(sessionId, 'human_escalation');
      this.eventStore.append('execute', sessionId, EventType.EVOLVE_HUMAN_ESCALATION, {
        triedPersonas: session.lateralTriedPersonas,
        bestScore: Math.max(
          ...session.evolutionHistory.map((g) => g.evaluationScore),
          session.evaluationResult.overallScore,
        ),
      });

      const escalation = buildEscalationContext(
        session.lateralTriedPersonas as LateralPersonaName[],
        session.evaluationResult,
        session.evolutionHistory,
      );
      return ok({
        session: this.sessionManager.get(sessionId),
        humanEscalation: escalation,
        terminated: true,
        terminationReason: 'human_escalation',
      });
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(
        new ExecuteError(`Failed lateral evolve: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  /**
   * evolve_lateral_result: Lateral thinking 결과(specPatch) 제출.
   * completeLateral() 후 기존 submitSpecPatch() 위임.
   */
  submitLateralResult(
    sessionId: string,
    lateralResult: LateralResult,
  ): Result<PassthroughEvolvePatchResult, ExecuteError> {
    try {
      // Validate session exists
      this.sessionManager.get(sessionId);

      // Complete lateral phase
      this.sessionManager.completeLateral(
        sessionId,
        lateralResult.persona,
        lateralResult.description,
      );

      // Delegate to existing submitSpecPatch
      return this.submitSpecPatch(sessionId, lateralResult.specPatch);
    } catch (e) {
      if (e instanceof ExecuteSessionNotFoundError) return err(e);
      return err(
        new ExecuteError(
          `Failed to submit lateral result: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
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
        systemPrompt: mergeSystemPrompt(
          EXECUTE_EXECUTION_SYSTEM_PROMPT,
          this.agentRegistry,
          'execute',
        ),
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

      const delta =
        session.evolutionHistory.length > 0
          ? session.evolutionHistory[session.evolutionHistory.length - 1]!.delta
          : { fieldsChanged: [] };

      const patchSummary = `Fields changed: ${delta.fieldsChanged.join(', ')}`;
      return {
        systemPrompt: mergeSystemPrompt(
          EXECUTE_EXECUTION_SYSTEM_PROMPT,
          this.agentRegistry,
          'execute',
        ),
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
}
