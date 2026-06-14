import type { PassthroughExecuteEngine } from '../../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../../schemas.js';
import type { NextActionGuide, ProgressInfo } from '../../../core/types.js';
import { gestaltNotify } from '../../../utils/notifier.js';
import {
  writeGestaltRule,
  updateGestaltRule,
  writeActiveSession,
  type ClientType,
} from '../../../execute/rule-writer.js';
import { formatError, applyTaskContextFilters, slimRetrospectiveContext } from './utils.js';

export async function handleExecuteStart(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  client: ClientType,
): Promise<string> {
  const verbose = input.verbose !== false;

  if (!input.sessionId) return formatError('sessionId is required for execute_start action');

  const result = engine.startExecution(input.sessionId);
  if (!result.ok) return formatError(result.error.message);

  const { session, allTasksCompleted } = result.value;
  let { taskContext } = result.value;

  if (allTasksCompleted) {
    const execStartDoneGuide: NextActionGuide = {
      nextAction: 'evaluate',
      nextActionParams: { sessionId: session.sessionId },
      hint: '모든 태스크 완료. evaluate를 호출하세요.',
    };
    return JSON.stringify(
      {
        status: 'all_tasks_completed',
        sessionId: session.sessionId,
        message: 'All tasks already completed. Call evaluate to verify acceptance criteria.',
        ...execStartDoneGuide,
      },
      null,
      2,
    );
  }

  // Hybrid search로 suggestedFiles 업그레이드 (codeGraphRepoRoot 있을 때)
  if (taskContext && session.codeGraphRepoRoot) {
    taskContext = await engine.hydrateSuggestedFiles(taskContext, session.codeGraphRepoRoot);
  }

  if (input.cwd) {
    try {
      const currentTask = taskContext
        ? { taskId: taskContext.currentTask.taskId, title: taskContext.currentTask.title }
        : null;
      writeGestaltRule(
        input.cwd,
        { goal: session.spec.goal, constraints: session.spec.constraints },
        currentTask,
        client,
      );
      writeActiveSession(input.cwd, session.sessionId, session.specId);
    } catch {
      // Rule file creation failure should not block execution
    }
  }

  const execStartGuide: NextActionGuide = {
    nextAction: 'execute_task',
    nextActionParams: { sessionId: session.sessionId },
    hint: `첫 번째 태스크: ${taskContext?.currentTask.title ?? ''}. taskContext.taskPrompt를 사용해 구현하세요.`,
  };
  return JSON.stringify(
    {
      status: 'executing',
      sessionId: session.sessionId,
      taskContext: taskContext
        ? applyTaskContextFilters(taskContext as unknown as Record<string, unknown>, verbose)
        : taskContext,
      message: `Execution started. Use taskContext.taskPrompt to implement the task, then submit with execute_task.`,
      ...execStartGuide,
    },
    null,
    2,
  );
}

export async function handleExecuteTask(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  client: ClientType,
): Promise<string> {
  const verbose = input.verbose !== false;

  if (!input.sessionId) return formatError('sessionId is required for execute_task action');
  if (!input.taskResult) return formatError('taskResult is required for execute_task action');

  const result = engine.submitTaskResult(input.sessionId, input.taskResult);
  if (!result.ok) return formatError(result.error.message);

  const { session, allTasksCompleted, driftScore, retrospectiveContext } = result.value;
  let { taskContext } = result.value;

  if (allTasksCompleted) {
    gestaltNotify({
      event: 'tasks_completed',
      message: `모든 태스크 완료 (${session.taskResults.length}개) — evaluate를 호출하세요`,
    });
    const execTaskDoneGuide: NextActionGuide = {
      nextAction: 'evaluate',
      nextActionParams: { sessionId: session.sessionId },
      hint: '모든 태스크 완료. evaluate를 호출하세요.',
    };
    const doneTotal = session.executionPlan?.atomicTasks.length ?? 0;
    const doneCompleted = session.taskResults.length;
    const doneProgress: ProgressInfo = {
      completed: doneCompleted,
      total: doneTotal,
      percent: doneTotal > 0 ? Math.round((doneCompleted / doneTotal) * 100) : 0,
    };
    return JSON.stringify(
      {
        status: 'all_tasks_completed',
        sessionId: session.sessionId,
        completedTasks: session.taskResults.length,
        progress: doneProgress,
        ...(driftScore ? { driftScore } : {}),
        ...(retrospectiveContext
          ? {
              retrospectiveContext: slimRetrospectiveContext(
                retrospectiveContext as unknown as Record<string, unknown>,
              ),
            }
          : {}),
        message: 'All tasks completed. Call evaluate to verify acceptance criteria.',
        ...execTaskDoneGuide,
      },
      null,
      2,
    );
  }

  // Hybrid search로 suggestedFiles 업그레이드
  if (taskContext && session.codeGraphRepoRoot) {
    taskContext = await engine.hydrateSuggestedFiles(taskContext, session.codeGraphRepoRoot);
  }

  if (input.cwd && taskContext) {
    try {
      updateGestaltRule(
        input.cwd,
        { goal: session.spec.goal, constraints: session.spec.constraints },
        { taskId: taskContext.currentTask.taskId, title: taskContext.currentTask.title },
        client,
      );
    } catch {
      // Rule file update failure should not block execution
    }
  }

  const compressionAvailable = session.taskResults.length > 5;

  const execTaskNextId = taskContext?.currentTask.taskId ?? '';
  const execTaskGuide: NextActionGuide = {
    nextAction: 'execute_task',
    nextActionParams: { sessionId: session.sessionId },
    hint: `다음 태스크: ${execTaskNextId}. 계속 실행하세요.`,
  };
  const execTotal = session.executionPlan?.atomicTasks.length ?? 0;
  const execCompleted = session.taskResults.length;
  const execProgress: ProgressInfo = {
    completed: execCompleted,
    total: execTotal,
    percent: execTotal > 0 ? Math.round((execCompleted / execTotal) * 100) : 0,
  };
  return JSON.stringify(
    {
      status: 'executing',
      sessionId: session.sessionId,
      completedTasks: session.taskResults.length,
      progress: execProgress,
      taskContext: taskContext
        ? applyTaskContextFilters(taskContext as unknown as Record<string, unknown>, verbose)
        : taskContext,
      ...(compressionAvailable ? { compressionAvailable: true } : {}),
      ...(driftScore ? { driftScore } : {}),
      ...(retrospectiveContext
        ? {
            retrospectiveContext: slimRetrospectiveContext(
              retrospectiveContext as unknown as Record<string, unknown>,
            ),
          }
        : {}),
      message: `Task "${input.taskResult.taskId}" recorded.${driftScore?.thresholdExceeded ? ' WARNING: Drift threshold exceeded! Review retrospectiveContext.' : ''}${compressionAvailable ? ' TIP: Context is getting long — consider calling compress to summarize completed work.' : ''} Use taskContext.taskPrompt to implement the next task.`,
      ...execTaskGuide,
    },
    null,
    2,
  );
}
