import type { PassthroughExecuteEngine } from '../../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../../schemas.js';
import type { SubTask, ResumeContext } from '../../../core/types.js';
import { AuditEngine } from '../../../execute/audit-engine.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ClientType } from '../../../execute/rule-writer.js';
import { formatError } from './utils.js';

export function handleStatusAction(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _client: ClientType,
): string {
  return handleStatus(engine, input.sessionId, input.cwd);
}

export function handleResume(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _client: ClientType,
): string {
  if (!input.sessionId) return formatError('sessionId is required for resume action');

  try {
    const session = engine.getSession(input.sessionId);
    if (session.status !== 'executing' && session.status !== 'planning') {
      return formatError(
        `Session status is "${session.status}". Resume is only available for in-progress sessions.`,
      );
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
    const progressPercent =
      totalTasks > 0 ? Math.round((session.completedTaskIds.length / totalTasks) * 100) : 0;

    const resumeContext: ResumeContext = {
      completedTaskIds: session.completedTaskIds,
      nextTaskId,
      totalTasks,
      progressPercent,
    };

    return JSON.stringify(
      {
        status: 'resume_context',
        sessionId: session.sessionId,
        resumeContext,
        message: nextTaskId
          ? `Resuming from task "${nextTaskId}". ${session.completedTaskIds.length}/${totalTasks} tasks completed (${progressPercent}%). Use execute_task to continue.`
          : 'All tasks completed. Call evaluate to verify acceptance criteria.',
      },
      null,
      2,
    );
  } catch (e) {
    return formatError(e instanceof Error ? e.message : String(e));
  }
}

export function handleAudit(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _client: ClientType,
): string {
  if (!input.sessionId) return formatError('sessionId is required for audit action');

  try {
    const session = engine.getSession(input.sessionId);
    const auditEngine = new AuditEngine();

    // Call 2: Submit audit result
    if (input.auditResult) {
      const auditResult = auditEngine.buildAuditResult(input.auditResult);
      engine.getSessionManager().setAuditResult(session.sessionId, auditResult);

      return JSON.stringify(
        {
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
        },
        null,
        2,
      );
    }

    // Call 1: Return audit context
    const codebaseSnapshot =
      input.codebaseSnapshot ?? '(no snapshot provided — analyze based on spec ACs only)';
    const auditContext = auditEngine.buildAuditContext(session.spec, codebaseSnapshot);

    return JSON.stringify(
      {
        status: 'auditing',
        sessionId: session.sessionId,
        auditContext,
        message:
          'Use auditContext.systemPrompt + auditContext.auditPrompt to analyze the codebase, then submit auditResult.',
      },
      null,
      2,
    );
  } catch (e) {
    return formatError(e instanceof Error ? e.message : String(e));
  }
}

export function handleSpawn(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  _client: ClientType,
): string {
  if (!input.sessionId) return formatError('sessionId is required for spawn action');
  if (!input.parentTaskId) return formatError('parentTaskId is required for spawn action');
  if (!input.subTasks || input.subTasks.length === 0)
    return formatError('subTasks is required for spawn action');

  try {
    const session = engine.getSession(input.sessionId);
    const parentTask = session.executionPlan?.atomicTasks.find(
      (t) => t.taskId === input.parentTaskId,
    );
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

    return JSON.stringify(
      {
        status: 'spawned',
        sessionId: session.sessionId,
        parentTaskId: input.parentTaskId,
        spawnedTasks: spawnedTasks.map((t) => ({
          taskId: t.taskId,
          title: t.title,
          dependsOn: t.dependsOn,
        })),
        message: `${spawnedTasks.length} sub-tasks spawned from "${input.parentTaskId}". Submit results with execute_task using each sub-task's taskId.`,
      },
      null,
      2,
    );
  } catch (e) {
    return formatError(e instanceof Error ? e.message : String(e));
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
        const nextTaskId =
          session.executionPlan.dagValidation.topologicalOrder.find(
            (id) => !completedSet.has(id),
          ) ?? null;
        resumeContext = {
          completedTaskIds: session.completedTaskIds,
          nextTaskId,
          totalTasks,
          progressPercent:
            totalTasks > 0 ? Math.round((session.completedTaskIds.length / totalTasks) * 100) : 0,
        };
      }

      return JSON.stringify(
        {
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
        },
        null,
        2,
      );
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

    return JSON.stringify(
      {
        sessions: sessions.map((s) => ({
          sessionId: s.sessionId,
          specId: s.specId,
          status: s.status,
          stepsCompleted: s.planningSteps.length,
          hasPlan: !!s.executionPlan,
          taskResults: s.taskResults.length,
          hasEvaluation: !!s.evaluationResult,
          ...(s.status === 'executing'
            ? {
                resumeContext: {
                  completedTaskIds: s.completedTaskIds,
                  nextTaskId: s.nextTaskId,
                  totalTasks: s.executionPlan?.atomicTasks.length ?? 0,
                  progressPercent: s.executionPlan
                    ? Math.round(
                        (s.completedTaskIds.length / s.executionPlan.atomicTasks.length) * 100,
                      )
                    : 0,
                },
              }
            : {}),
          createdAt: s.createdAt,
        })),
        total: sessions.length,
        ...(resumeHint ? { resumeHint } : {}),
      },
      null,
      2,
    );
  } catch (e) {
    return formatError(e instanceof Error ? e.message : String(e));
  }
}
