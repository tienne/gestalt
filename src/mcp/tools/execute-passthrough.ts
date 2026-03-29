import type { PassthroughExecuteEngine } from '../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../schemas.js';
import type { PlanningStepResult, SubTask, ResumeContext } from '../../core/types.js';
import { ProjectMemoryStore } from '../../memory/project-memory-store.js';
import { AuditEngine } from '../../execute/audit-engine.js';
import { gestaltNotify } from '../../utils/notifier.js';
import { randomUUID } from 'node:crypto';
import {
  writeGestaltRule,
  updateGestaltRule,
  deleteGestaltRule,
  writeActiveSession,
  deleteActiveSession,
} from '../../execute/rule-writer.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function handleExecutePassthrough(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
): string {
  switch (input.action) {
    case 'start': {
      if (!input.spec) return formatError('spec is required for start action');

      const result = engine.start(input.spec as Parameters<typeof engine.start>[0]);
      if (!result.ok) return formatError(result.error.message);

      const { session, executeContext } = result.value;
      return JSON.stringify({
        status: 'started',
        sessionId: session.sessionId,
        specId: session.specId,
        executeContext,
        message: `Execute session started. Use the executeContext.planningPrompt with executeContext.systemPrompt to generate the Figure-Ground classification.`,
      }, null, 2);
    }

    case 'plan_step': {
      if (!input.sessionId) return formatError('sessionId is required for plan_step action');
      if (!input.stepResult) return formatError('stepResult is required for plan_step action');

      const stepResult = buildStepResult(input.stepResult);
      if (!stepResult) return formatError('Invalid stepResult: missing required fields for the given principle');

      const result = engine.planStep(input.sessionId, stepResult);
      if (!result.ok) return formatError(result.error.message);

      const { session, executeContext, isLastStep } = result.value;

      if (isLastStep) {
        return JSON.stringify({
          status: 'planning_complete',
          sessionId: session.sessionId,
          stepsCompleted: session.planningSteps.length,
          isLastStep: true,
          message: 'All planning steps completed. Call plan_complete to assemble the execution plan.',
        }, null, 2);
      }

      return JSON.stringify({
        status: 'planning',
        sessionId: session.sessionId,
        stepsCompleted: session.planningSteps.length,
        isLastStep: false,
        executeContext,
        message: `Step ${session.planningSteps.length}/${4} complete. Use the executeContext.planningPrompt to generate the next step.`,
      }, null, 2);
    }

    case 'plan_complete': {
      if (!input.sessionId) return formatError('sessionId is required for plan_complete action');

      const result = engine.planComplete(input.sessionId);
      if (!result.ok) return formatError(result.error.message);

      const { executionPlan } = result.value;
      const planSummary = {
        totalTasks: executionPlan.atomicTasks.length,
        groupCount: executionPlan.taskGroups.length,
        criticalPathLength: executionPlan.dagValidation.criticalPath.length,
        parallelGroupCount: executionPlan.parallelGroups?.length ?? 0,
      };
      return JSON.stringify({
        status: 'plan_complete',
        sessionId: result.value.session.sessionId,
        planSummary,
        executionPlan: {
          planId: executionPlan.planId,
          specId: executionPlan.specId,
          totalTasks: executionPlan.atomicTasks.length,
          totalGroups: executionPlan.taskGroups.length,
          dagValid: executionPlan.dagValidation.isValid,
          criticalPathLength: executionPlan.dagValidation.criticalPath.length,
          classifiedACs: executionPlan.classifiedACs,
          atomicTasks: executionPlan.atomicTasks,
          taskGroups: executionPlan.taskGroups,
          dagValidation: executionPlan.dagValidation,
          parallelGroups: executionPlan.parallelGroups,
        },
        nextStep: 'Call execute_start to begin task execution. Tasks will run in topological order — critical path has ' + planSummary.criticalPathLength + ' tasks.',
        message: 'Execution plan assembled and validated. Call execute_start to begin task execution.',
      }, null, 2);
    }

    case 'execute_start': {
      if (!input.sessionId) return formatError('sessionId is required for execute_start action');

      const result = engine.startExecution(input.sessionId);
      if (!result.ok) return formatError(result.error.message);

      const { session, taskContext, allTasksCompleted } = result.value;

      if (allTasksCompleted) {
        return JSON.stringify({
          status: 'all_tasks_completed',
          sessionId: session.sessionId,
          message: 'All tasks already completed. Call evaluate to verify acceptance criteria.',
        }, null, 2);
      }

      if (input.cwd) {
        try {
          const currentTask = taskContext ? { taskId: taskContext.currentTask.taskId, title: taskContext.currentTask.title } : null;
          writeGestaltRule(input.cwd, { goal: session.spec.goal, constraints: session.spec.constraints }, currentTask);
          writeActiveSession(input.cwd, session.sessionId, session.specId);
        } catch {
          // Rule file creation failure should not block execution
        }
      }

      return JSON.stringify({
        status: 'executing',
        sessionId: session.sessionId,
        taskContext,
        message: `Execution started. Use taskContext.taskPrompt with taskContext.systemPrompt to implement the task, then submit with execute_task.`,
      }, null, 2);
    }

    case 'execute_task': {
      if (!input.sessionId) return formatError('sessionId is required for execute_task action');
      if (!input.taskResult) return formatError('taskResult is required for execute_task action');

      const result = engine.submitTaskResult(input.sessionId, input.taskResult);
      if (!result.ok) return formatError(result.error.message);

      const { session, taskContext, allTasksCompleted, driftScore, retrospectiveContext } = result.value;

      if (allTasksCompleted) {
        gestaltNotify({
          event: 'tasks_completed',
          message: `모든 태스크 완료 (${session.taskResults.length}개) — evaluate를 호출하세요`,
        });
        return JSON.stringify({
          status: 'all_tasks_completed',
          sessionId: session.sessionId,
          completedTasks: session.taskResults.length,
          ...(driftScore ? { driftScore } : {}),
          ...(retrospectiveContext ? { retrospectiveContext } : {}),
          message: 'All tasks completed. Call evaluate to verify acceptance criteria.',
        }, null, 2);
      }

      if (input.cwd && taskContext) {
        try {
          updateGestaltRule(input.cwd, { goal: session.spec.goal, constraints: session.spec.constraints }, { taskId: taskContext.currentTask.taskId, title: taskContext.currentTask.title });
        } catch {
          // Rule file update failure should not block execution
        }
      }

      const compressionAvailable = session.taskResults.length > 5;

      return JSON.stringify({
        status: 'executing',
        sessionId: session.sessionId,
        completedTasks: session.taskResults.length,
        taskContext,
        ...(compressionAvailable ? { compressionAvailable: true } : {}),
        ...(driftScore ? { driftScore } : {}),
        ...(retrospectiveContext ? { retrospectiveContext } : {}),
        message: `Task "${input.taskResult.taskId}" recorded.${driftScore?.thresholdExceeded ? ' WARNING: Drift threshold exceeded! Review retrospectiveContext.' : ''}${compressionAvailable ? ' TIP: Context is getting long — consider calling compress to summarize completed work.' : ''} Use taskContext.taskPrompt to implement the next task.`,
      }, null, 2);
    }

    case 'evaluate': {
      if (!input.sessionId) return formatError('sessionId is required for evaluate action');

      // Call 3: Submit contextual evaluation result
      if (input.evaluationResult) {
        const result = engine.submitEvaluation(input.sessionId, input.evaluationResult);
        if (!result.ok) return formatError(result.error.message);

        const { evaluationResult } = result.value;
        const completedSession = result.value.session;

        // Update project memory on execution completion
        try {
          const memoryStore = new ProjectMemoryStore();
          const completedTasks = completedSession.taskResults
            .filter((t) => t.status === 'completed')
            .map((t) => t.taskId);
          const failedTasks = completedSession.taskResults
            .filter((t) => t.status === 'failed')
            .map((t) => t.taskId);
          const score = evaluationResult?.overallScore ?? 0;
          const goalAlign = evaluationResult?.goalAlignment ?? 0;
          memoryStore.addExecution({
            executeSessionId: completedSession.sessionId,
            specId: completedSession.specId,
            completedTasks,
            failedTasks,
            resultSummary: `Score: ${score.toFixed(2)}, goalAlignment: ${goalAlign.toFixed(2)}`,
            completedAt: new Date().toISOString(),
          });
        } catch {
          // Memory update failure should not block the response
        }

        if (input.cwd) {
          try {
            deleteGestaltRule(input.cwd);
            deleteActiveSession(input.cwd);
          } catch {
            // Cleanup failure should not block the response
          }
        }

        const score = evaluationResult!.overallScore;
        const alignment = evaluationResult!.goalAlignment;
        const success = score >= 0.85 && alignment >= 0.80;
        gestaltNotify({
          event: success ? 'evaluation_success' : 'evaluation_failed',
          message: success
            ? `평가 성공 ✓ score: ${score.toFixed(2)}, alignment: ${alignment.toFixed(2)}`
            : `평가 미달 score: ${score.toFixed(2)}, alignment: ${alignment.toFixed(2)} — Evolve 진입`,
        });
        return JSON.stringify({
          status: 'completed',
          sessionId: completedSession.sessionId,
          stage: 'complete',
          evaluationResult,
          message: `Evaluation complete. Overall score: ${score.toFixed(2)}, goal alignment: ${alignment.toFixed(2)}. Session is now completed.`,
        }, null, 2);
      }

      // Call 2: Submit structural results
      if (input.structuralResult) {
        const result = engine.submitStructuralResult(input.sessionId, input.structuralResult);
        if (!result.ok) return formatError(result.error.message);

        const { stage, shortCircuited, contextualContext, evaluationResult } = result.value;

        if (shortCircuited) {
          gestaltNotify({
            event: 'structural_failed',
            message: 'Structural 검사 실패 — lint/build/test를 확인하세요',
          });
          return JSON.stringify({
            status: 'completed',
            sessionId: result.value.session.sessionId,
            stage: 'complete',
            shortCircuited: true,
            evaluationResult,
            message: 'Structural checks failed. Evaluation short-circuited. Fix structural issues and retry.',
          }, null, 2);
        }

        return JSON.stringify({
          status: 'evaluating',
          sessionId: result.value.session.sessionId,
          stage,
          contextualContext,
          message: 'Structural checks passed. Use contextualContext.evaluatePrompt with contextualContext.systemPrompt to generate the contextual evaluation.',
        }, null, 2);
      }

      // Call 1: Start evaluation → return structural commands
      const result = engine.startEvaluation(input.sessionId);
      if (!result.ok) return formatError(result.error.message);

      return JSON.stringify({
        status: 'evaluating',
        sessionId: result.value.session.sessionId,
        stage: 'structural',
        structuralContext: result.value.structuralContext,
        message: 'Run structural checks (lint, build, test) and submit results with structuralResult.',
      }, null, 2);
    }

    case 'status': {
      return handleStatus(engine, input.sessionId, input.cwd);
    }

    // ─── Execution Continuity Actions ─────────────────────────

    case 'resume': {
      if (!input.sessionId) return formatError('sessionId is required for resume action');

      try {
        const session = engine.getSession(input.sessionId);
        if (session.status !== 'executing' && session.status !== 'planning') {
          return formatError(`Session status is "${session.status}". Resume is only available for in-progress sessions.`);
        }
        if (!session.executionPlan) {
          return formatError('No execution plan found. Complete planning first.');
        }

        const completedSet = new Set(session.completedTaskIds);
        const remaining = session.executionPlan.dagValidation.topologicalOrder.filter(
          (id) => !completedSet.has(id),
        );
        const nextTaskId = remaining[0] ?? null;
        const totalTasks = session.executionPlan.atomicTasks.length;
        const progressPercent = totalTasks > 0
          ? Math.round((session.completedTaskIds.length / totalTasks) * 100)
          : 0;

        const resumeContext: ResumeContext = {
          completedTaskIds: session.completedTaskIds,
          nextTaskId,
          totalTasks,
          progressPercent,
        };

        return JSON.stringify({
          status: 'resume_context',
          sessionId: session.sessionId,
          resumeContext,
          message: nextTaskId
            ? `Resuming from task "${nextTaskId}". ${session.completedTaskIds.length}/${totalTasks} tasks completed (${progressPercent}%). Use execute_task to continue.`
            : 'All tasks completed. Call evaluate to verify acceptance criteria.',
        }, null, 2);
      } catch (e) {
        return formatError(e instanceof Error ? e.message : String(e));
      }
    }

    // ─── Audit Actions ─────────────────────────────────────────

    case 'audit': {
      if (!input.sessionId) return formatError('sessionId is required for audit action');

      try {
        const session = engine.getSession(input.sessionId);
        const auditEngine = new AuditEngine();

        // Call 2: Submit audit result
        if (input.auditResult) {
          const auditResult = auditEngine.buildAuditResult(input.auditResult);
          engine.getSessionManager().setAuditResult(session.sessionId, auditResult);

          return JSON.stringify({
            status: 'audit_complete',
            sessionId: session.sessionId,
            auditResult,
            summary: {
              total: session.spec.acceptanceCriteria.length,
              implemented: auditResult.implementedACs.length,
              partial: auditResult.partialACs.length,
              missing: auditResult.missingACs.length,
            },
            message: `Audit complete. ${auditResult.missingACs.length} ACs missing, ${auditResult.partialACs.length} partial. Review gapAnalysis for next steps.`,
          }, null, 2);
        }

        // Call 1: Return audit context
        const codebaseSnapshot = input.codebaseSnapshot ?? '(no snapshot provided — analyze based on spec ACs only)';
        const auditContext = auditEngine.buildAuditContext(session.spec, codebaseSnapshot);

        return JSON.stringify({
          status: 'auditing',
          sessionId: session.sessionId,
          auditContext,
          message: 'Use auditContext.systemPrompt + auditContext.auditPrompt to analyze the codebase, then submit auditResult.',
        }, null, 2);
      } catch (e) {
        return formatError(e instanceof Error ? e.message : String(e));
      }
    }

    // ─── Sub-task Spawning Actions ─────────────────────────────

    case 'spawn': {
      if (!input.sessionId) return formatError('sessionId is required for spawn action');
      if (!input.parentTaskId) return formatError('parentTaskId is required for spawn action');
      if (!input.subTasks || input.subTasks.length === 0) return formatError('subTasks is required for spawn action');

      try {
        const session = engine.getSession(input.sessionId);
        const parentTask = session.executionPlan?.atomicTasks.find((t) => t.taskId === input.parentTaskId);
        const inheritedContext = parentTask
          ? `Parent task: "${parentTask.title}"\n${parentTask.description}`
          : `Parent task ID: ${input.parentTaskId}`;

        const spawnedTasks: SubTask[] = input.subTasks.map((st) => ({
          taskId: `spawned-${randomUUID().slice(0, 8)}`,
          parentTaskId: input.parentTaskId!,
          title: st.title,
          description: st.description,
          inheritedContext,
          dependsOn: st.dependsOn ?? [],
          status: 'pending' as const,
          createdAt: new Date().toISOString(),
        }));

        engine.getSessionManager().addSubTasks(session.sessionId, spawnedTasks);

        return JSON.stringify({
          status: 'spawned',
          sessionId: session.sessionId,
          parentTaskId: input.parentTaskId,
          spawnedTasks: spawnedTasks.map((t) => ({
            taskId: t.taskId,
            title: t.title,
            dependsOn: t.dependsOn,
          })),
          message: `${spawnedTasks.length} sub-tasks spawned from "${input.parentTaskId}". Submit results with execute_task using each sub-task's taskId.`,
        }, null, 2);
      } catch (e) {
        return formatError(e instanceof Error ? e.message : String(e));
      }
    }

    // ─── Evolution Loop Actions ───────────────────────────────

    case 'evolve_fix': {
      if (!input.sessionId) return formatError('sessionId is required for evolve_fix action');

      const fixResult = engine.startStructuralFix(input.sessionId, input.fixTasks);
      if (!fixResult.ok) return formatError(fixResult.error.message);

      const { fixContext } = fixResult.value;

      if (fixContext) {
        return JSON.stringify({
          status: 'evolving',
          sessionId: fixResult.value.session.sessionId,
          stage: 'fix',
          fixContext,
          message: 'Structural failures detected. Use fixContext to generate fix tasks, then re-submit with fixTasks.',
        }, null, 2);
      }

      return JSON.stringify({
        status: 'fix_applied',
        sessionId: fixResult.value.session.sessionId,
        message: 'Fix tasks recorded. Call evaluate to re-run structural checks.',
      }, null, 2);
    }

    case 'evolve': {
      if (!input.sessionId) return formatError('sessionId is required for evolve action');

      const evolveResult = engine.startContextualEvolve(input.sessionId, input.terminateReason);
      if (!evolveResult.ok) return formatError(evolveResult.error.message);

      if (evolveResult.value.lateralContext) {
        return JSON.stringify({
          status: 'lateral_thinking',
          sessionId: evolveResult.value.session.sessionId,
          lateralContext: evolveResult.value.lateralContext,
          message: `Stagnation detected. Lateral thinking activated: ${evolveResult.value.lateralContext.persona} persona (attempt ${evolveResult.value.lateralContext.attemptNumber}/4). Use lateralContext to generate a lateral SpecPatch, then submit with evolve_lateral_result.`,
        }, null, 2);
      }

      if (evolveResult.value.humanEscalation) {
        if (input.cwd) {
          try { deleteGestaltRule(input.cwd); deleteActiveSession(input.cwd); } catch { /* ignore */ }
        }
        gestaltNotify({
          event: 'human_escalation',
          message: '⚠️ Human Escalation — 모든 Lateral Thinking 소진, 수동 개입이 필요해요',
        });
        return JSON.stringify({
          status: 'human_escalation',
          sessionId: evolveResult.value.session.sessionId,
          terminationReason: 'human_escalation',
          escalationContext: evolveResult.value.humanEscalation,
          evolutionHistory: evolveResult.value.session.evolutionHistory.map((g) => ({
            generation: g.generation,
            score: g.evaluationScore,
            goalAlignment: g.goalAlignment,
            fieldsChanged: g.delta.fieldsChanged,
          })),
          message: 'All lateral thinking personas exhausted. Human intervention required.',
        }, null, 2);
      }

      if (evolveResult.value.terminated) {
        if (input.cwd) {
          try { deleteGestaltRule(input.cwd); deleteActiveSession(input.cwd); } catch { /* ignore */ }
        }
        gestaltNotify({
          event: 'terminated',
          message: `세션 종료: ${evolveResult.value.terminationReason ?? 'unknown'}`,
        });
        return JSON.stringify({
          status: 'terminated',
          sessionId: evolveResult.value.session.sessionId,
          terminationReason: evolveResult.value.terminationReason,
          evolutionHistory: evolveResult.value.session.evolutionHistory.map((g) => ({
            generation: g.generation,
            score: g.evaluationScore,
            goalAlignment: g.goalAlignment,
            fieldsChanged: g.delta.fieldsChanged,
          })),
          message: `Evolution terminated: ${evolveResult.value.terminationReason}.`,
        }, null, 2);
      }

      return JSON.stringify({
        status: 'evolving',
        sessionId: evolveResult.value.session.sessionId,
        stage: 'evolve',
        evolveContext: evolveResult.value.evolveContext,
        message: 'Use evolveContext to generate a Spec patch, then submit with evolve_patch.',
      }, null, 2);
    }

    case 'evolve_patch': {
      if (!input.sessionId) return formatError('sessionId is required for evolve_patch action');
      if (!input.specPatch) return formatError('specPatch is required for evolve_patch action');

      const patchResult = engine.submitSpecPatch(input.sessionId, input.specPatch);
      if (!patchResult.ok) return formatError(patchResult.error.message);

      const { impactedTaskIds, reExecuteContext } = patchResult.value;

      if (input.cwd) {
        try {
          const patchedSession = patchResult.value.session;
          updateGestaltRule(input.cwd, { goal: patchedSession.spec.goal, constraints: patchedSession.spec.constraints }, null);
        } catch {
          // Rule file update failure should not block execution
        }
      }

      if (impactedTaskIds.length === 0) {
        return JSON.stringify({
          status: 'patch_applied',
          sessionId: patchResult.value.session.sessionId,
          impactedTaskIds: [],
          message: 'Spec patched. No tasks need re-execution. Call evaluate to re-assess.',
        }, null, 2);
      }

      return JSON.stringify({
        status: 're_executing',
        sessionId: patchResult.value.session.sessionId,
        impactedTaskIds,
        reExecuteContext,
        message: `Spec patched. ${impactedTaskIds.length} tasks need re-execution. Use reExecuteContext to implement the task.`,
      }, null, 2);
    }

    case 'evolve_re_execute': {
      if (!input.sessionId) return formatError('sessionId is required for evolve_re_execute action');
      if (!input.reExecuteTaskResult) return formatError('reExecuteTaskResult is required for evolve_re_execute action');

      const reExecResult = engine.submitReExecuteTaskResult(input.sessionId, input.reExecuteTaskResult);
      if (!reExecResult.ok) return formatError(reExecResult.error.message);

      const { reExecuteContext: nextContext, allTasksCompleted } = reExecResult.value;

      if (allTasksCompleted) {
        return JSON.stringify({
          status: 're_execute_complete',
          sessionId: reExecResult.value.session.sessionId,
          message: 'All impacted tasks re-executed. Call evaluate to re-assess.',
        }, null, 2);
      }

      return JSON.stringify({
        status: 're_executing',
        sessionId: reExecResult.value.session.sessionId,
        reExecuteContext: nextContext,
        message: 'Task recorded. Use reExecuteContext to implement the next re-execution task.',
      }, null, 2);
    }

    // ─── Role Agent System Actions ────────────────────────────

    case 'role_match': {
      if (!input.sessionId) return formatError('sessionId is required for role_match action');

      const rmResult = engine.roleMatch(input.sessionId, input.matchResult);
      if (!rmResult.ok) return formatError(rmResult.error.message);

      const { matchContext, perspectivePrompts } = rmResult.value;

      if (matchContext) {
        return JSON.stringify({
          status: 'role_matching',
          sessionId: rmResult.value.session.sessionId,
          matchContext,
          message: 'Use matchContext.systemPrompt + matchContext.matchingPrompt to determine which role agents match this task. Submit matchResult with role_match.',
        }, null, 2);
      }

      return JSON.stringify({
        status: 'role_matched',
        sessionId: rmResult.value.session.sessionId,
        perspectivePrompts: perspectivePrompts ?? [],
        matchCount: perspectivePrompts?.length ?? 0,
        message: perspectivePrompts?.length
          ? `${perspectivePrompts.length} agents matched. Use each perspectivePrompt for parallel LLM calls, then submit perspectives with role_consensus.`
          : 'No agents matched. Proceed directly to execute_task.',
      }, null, 2);
    }

    case 'role_consensus': {
      if (!input.sessionId) return formatError('sessionId is required for role_consensus action');

      const rcResult = engine.roleConsensus(
        input.sessionId,
        input.perspectives,
        input.consensus,
      );
      if (!rcResult.ok) return formatError(rcResult.error.message);

      const { synthesisContext, roleGuidance } = rcResult.value;

      if (synthesisContext) {
        return JSON.stringify({
          status: 'synthesizing',
          sessionId: rcResult.value.session.sessionId,
          synthesisContext,
          message: 'Use synthesisContext.systemPrompt + synthesisContext.synthesisPrompt to synthesize consensus. Submit consensus with role_consensus.',
        }, null, 2);
      }

      return JSON.stringify({
        status: 'consensus_complete',
        sessionId: rcResult.value.session.sessionId,
        roleGuidance,
        message: 'Role consensus stored. Use roleGuidance to inform task implementation, then submit with execute_task.',
      }, null, 2);
    }

    // ─── Lateral Thinking Actions ──────────────────────────────

    case 'evolve_lateral': {
      if (!input.sessionId) return formatError('sessionId is required for evolve_lateral action');

      const lateralResult = engine.startLateralEvolve(input.sessionId);
      if (!lateralResult.ok) return formatError(lateralResult.error.message);

      if (lateralResult.value.terminated) {
        if (input.cwd) {
          try { deleteGestaltRule(input.cwd); deleteActiveSession(input.cwd); } catch { /* ignore */ }
        }
        return JSON.stringify({
          status: lateralResult.value.terminationReason === 'human_escalation' ? 'human_escalation' : 'terminated',
          sessionId: lateralResult.value.session.sessionId,
          terminationReason: lateralResult.value.terminationReason,
          ...(lateralResult.value.humanEscalation ? { escalationContext: lateralResult.value.humanEscalation } : {}),
          message: lateralResult.value.terminationReason === 'human_escalation'
            ? 'All lateral thinking personas exhausted. Human intervention required.'
            : `Evolution terminated: ${lateralResult.value.terminationReason}.`,
        }, null, 2);
      }

      if (lateralResult.value.lateralContext) {
        return JSON.stringify({
          status: 'lateral_thinking',
          sessionId: lateralResult.value.session.sessionId,
          lateralContext: lateralResult.value.lateralContext,
          message: `Lateral thinking: ${lateralResult.value.lateralContext.persona} persona (attempt ${lateralResult.value.lateralContext.attemptNumber}/4). Use lateralContext to generate a lateral SpecPatch, then submit with evolve_lateral_result.`,
        }, null, 2);
      }

      return formatError('Unexpected state in evolve_lateral');
    }

    case 'evolve_lateral_result': {
      if (!input.sessionId) return formatError('sessionId is required for evolve_lateral_result action');
      if (!input.lateralResult) return formatError('lateralResult is required for evolve_lateral_result action');

      const lrResult = engine.submitLateralResult(input.sessionId, input.lateralResult);
      if (!lrResult.ok) return formatError(lrResult.error.message);

      const { impactedTaskIds, reExecuteContext: lrReExecCtx } = lrResult.value;

      if (impactedTaskIds.length === 0) {
        return JSON.stringify({
          status: 'lateral_patch_applied',
          sessionId: lrResult.value.session.sessionId,
          impactedTaskIds: [],
          message: 'Lateral spec patch applied. No tasks need re-execution. Call evaluate to re-assess.',
        }, null, 2);
      }

      return JSON.stringify({
        status: 're_executing',
        sessionId: lrResult.value.session.sessionId,
        impactedTaskIds,
        reExecuteContext: lrReExecCtx,
        message: `Lateral spec patch applied. ${impactedTaskIds.length} tasks need re-execution. Use reExecuteContext to implement the task.`,
      }, null, 2);
    }

    default:
      return formatError(`Unknown action: ${input.action}`);
  }
}

function buildStepResult(raw: NonNullable<ExecuteInput['stepResult']>): PlanningStepResult | null {
  switch (raw.principle) {
    case 'figure_ground':
      if (!raw.classifiedACs) return null;
      return { principle: 'figure_ground', classifiedACs: raw.classifiedACs };
    case 'closure':
      if (!raw.atomicTasks) return null;
      return { principle: 'closure', atomicTasks: raw.atomicTasks };
    case 'proximity':
      if (!raw.taskGroups) return null;
      return { principle: 'proximity', taskGroups: raw.taskGroups };
    case 'continuity':
      if (!raw.dagValidation) return null;
      return { principle: 'continuity', dagValidation: raw.dagValidation };
    default:
      return null;
  }
}

function handleStatus(engine: PassthroughExecuteEngine, sessionId?: string, cwd?: string): string {
  try {
    if (sessionId) {
      const session = engine.getSession(sessionId);

      // Build resumeContext for in-progress sessions
      let resumeContext: ResumeContext | undefined;
      if (session.status === 'executing' && session.executionPlan) {
        const completedSet = new Set(session.completedTaskIds);
        const totalTasks = session.executionPlan.atomicTasks.length;
        const nextTaskId = session.executionPlan.dagValidation.topologicalOrder.find(
          (id) => !completedSet.has(id),
        ) ?? null;
        resumeContext = {
          completedTaskIds: session.completedTaskIds,
          nextTaskId,
          totalTasks,
          progressPercent: totalTasks > 0
            ? Math.round((session.completedTaskIds.length / totalTasks) * 100)
            : 0,
        };
      }

      return JSON.stringify({
        session: {
          sessionId: session.sessionId,
          specId: session.specId,
          status: session.status,
          currentStep: session.currentStep,
          stepsCompleted: session.planningSteps.length,
          hasPlan: !!session.executionPlan,
          taskResults: session.taskResults.length,
          evaluateStage: session.evaluateStage ?? null,
          hasEvaluation: !!session.evaluationResult,
          driftAlerts: session.driftHistory.filter((d) => d.thresholdExceeded).length,
          evolveStage: session.evolveStage ?? null,
          currentGeneration: session.currentGeneration,
          evolutionCount: session.evolutionHistory.length,
          terminationReason: session.terminationReason ?? null,
          ...(resumeContext ? { resumeContext } : {}),
          ...(session.auditResult ? { hasAuditResult: true } : {}),
          subTaskCount: session.subTasks.length,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      }, null, 2);
    }

    const sessions = engine.listSessions();

    let resumeHint: { sessionId: string; specId: string } | undefined;
    if (cwd) {
      try {
        const activeSessionPath = join(cwd, '.gestalt', 'active-session.json');
        if (existsSync(activeSessionPath)) {
          resumeHint = JSON.parse(readFileSync(activeSessionPath, 'utf-8'));
        }
      } catch {
        // ignore
      }
    }

    return JSON.stringify({
      sessions: sessions.map((s) => ({
        sessionId: s.sessionId,
        specId: s.specId,
        status: s.status,
        stepsCompleted: s.planningSteps.length,
        hasPlan: !!s.executionPlan,
        taskResults: s.taskResults.length,
        hasEvaluation: !!s.evaluationResult,
        ...(s.status === 'executing' ? {
          resumeContext: {
            completedTaskIds: s.completedTaskIds,
            nextTaskId: s.nextTaskId,
            totalTasks: s.executionPlan?.atomicTasks.length ?? 0,
            progressPercent: s.executionPlan
              ? Math.round((s.completedTaskIds.length / s.executionPlan.atomicTasks.length) * 100)
              : 0,
          },
        } : {}),
        createdAt: s.createdAt,
      })),
      total: sessions.length,
      ...(resumeHint ? { resumeHint } : {}),
    }, null, 2);
  } catch (e) {
    return formatError(e instanceof Error ? e.message : String(e));
  }
}

function formatError(message: string): string {
  return JSON.stringify({ error: message }, null, 2);
}
