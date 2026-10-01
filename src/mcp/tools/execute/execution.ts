import type { PassthroughExecuteEngine } from '../../../execute/passthrough-engine.js';
import type { ExecuteInput } from '../../schemas.js';
import type {
  ArtifactCheckStatus,
  ArtifactVerification,
  NextActionGuide,
  ProgressInfo,
} from '../../../core/types.js';
import { gestaltNotify } from '../../../utils/notifier.js';
import { log } from '../../../core/log.js';
import { COMPRESSION_HINT_TASK_COUNT } from '../../../core/constants.js';
import { writeActiveSession, formatRuleContent } from '../../../execute/rule-writer.js';
import type { IHostAdapter } from '../../host-adapter.js';
import {
  formatError,
  applyTaskContextFilters,
  slimRetrospectiveContext,
  parallelHint,
} from './utils.js';

export async function handleExecuteStart(
  engine: PassthroughExecuteEngine,
  input: ExecuteInput,
  adapter: IHostAdapter,
): Promise<string> {
  const verbose = input.verbose !== false;

  if (!input.sessionId) return formatError('sessionId is required for execute_start action');

  // 완료 보고를 대조할 작업 트리. 서버는 호스트 프로젝트 디렉토리에서 뜨므로 cwd가 없으면 그 자리를 쓴다
  const result = engine.startExecution(input.sessionId, { repoRoot: input.cwd ?? process.cwd() });
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
      const content = formatRuleContent(
        { goal: session.spec.goal, constraints: session.spec.constraints },
        currentTask,
      );
      await adapter.writeActiveContext(content);
      writeActiveSession(input.cwd, session.sessionId, session.specId);
    } catch (e) {
      // 규칙 파일을 못 써도 실행은 이어간다
      log('execute_start: failed to write active context:', e);
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
  adapter: IHostAdapter,
): Promise<string> {
  const verbose = input.verbose !== false;

  if (!input.sessionId) return formatError('sessionId is required for execute_task action');
  if (!input.taskResult) return formatError('taskResult is required for execute_task action');

  const result = await engine.submitTaskResult(input.sessionId, input.taskResult);
  if (!result.ok) return formatError(result.error.message);

  const { session, allTasksCompleted, driftScore, retrospectiveContext, verification } =
    result.value;
  let { taskContext } = result.value;

  if (verification && !verification.verified) {
    return formatVerificationFailure(session.sessionId, input.taskResult.taskId, verification);
  }

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
        ...(verification ? { artifactCheck: verification.skipped ?? 'verified' } : {}),
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
      const content = formatRuleContent(
        { goal: session.spec.goal, constraints: session.spec.constraints },
        { taskId: taskContext.currentTask.taskId, title: taskContext.currentTask.title },
      );
      await adapter.writeActiveContext(content);
    } catch (e) {
      // 규칙 파일을 못 써도 실행은 이어간다
      log('execute_task: failed to update active context:', e);
    }
  }

  const compressionAvailable = session.taskResults.length > COMPRESSION_HINT_TASK_COUNT;

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
      // 착수 가능 후보 집합. taskContext.currentTask는 엔진이 고른 "다음 하나"로 의미가 다르다
      nextTaskIds: session.nextTaskIds,
      taskContext: taskContext
        ? applyTaskContextFilters(taskContext as unknown as Record<string, unknown>, verbose)
        : taskContext,
      ...(compressionAvailable ? { compressionAvailable: true } : {}),
      ...(verification ? { artifactCheck: verification.skipped ?? 'verified' } : {}),
      ...(driftScore ? { driftScore } : {}),
      ...(retrospectiveContext
        ? {
            retrospectiveContext: slimRetrospectiveContext(
              retrospectiveContext as unknown as Record<string, unknown>,
            ),
          }
        : {}),
      message: `Task "${input.taskResult.taskId}" recorded.${driftScore?.thresholdExceeded ? ' WARNING: Drift threshold exceeded! Review retrospectiveContext.' : ''}${compressionAvailable ? ' TIP: Context is getting long — consider calling compress to summarize completed work.' : ''} Use taskContext.taskPrompt to implement the next task.${parallelHint(session.nextTaskIds)}`,
      ...execTaskGuide,
    },
    null,
    2,
  );
}

const VERIFICATION_STATUS_HINT: Record<ArtifactCheckStatus, string> = {
  changed: '',
  missing: '파일이 없고 실행 시작 때도 없었습니다',
  unchanged: '실행 시작 뒤로 내용이 그대로입니다',
  outside_repo: '작업 트리 밖 경로라 확인할 수 없습니다',
  ignored: 'gitignore에 걸린 경로라 확인할 수 없습니다. 소스 파일을 적어주세요',
  directory: '디렉토리입니다. 바꾼 파일을 하나씩 적어주세요',
};

function formatVerificationFailure(
  sessionId: string,
  taskId: string,
  verification: ArtifactVerification,
): string {
  const problems = verification.files
    .filter((f) => f.status !== 'changed')
    .map((f) => ({ ...f, hint: VERIFICATION_STATUS_HINT[f.status] }));

  let message: string;
  if (verification.missingArtifacts) {
    message =
      'completed로 보고했지만 artifacts가 비어 있습니다. 바꾼 파일을 artifacts에 적거나, 파일을 바꾸지 않는 태스크(조사, 판단)라면 noCodeChange: true로 다시 제출하세요.';
  } else if (verification.error) {
    message = `작업 트리를 확인하지 못했습니다 (${verification.error}). 파일 상태를 직접 확인한 뒤 다시 제출하세요.`;
  } else {
    message =
      '보고한 artifacts 중 실행 시작 뒤로 바뀌지 않은 파일이 있습니다. 실제로 수정했는지 확인하고, 수정을 마쳤거나 목록을 바로잡은 뒤 다시 제출하세요. 끝내지 못했다면 status를 failed로 제출하세요.';
  }

  const guide: NextActionGuide = {
    nextAction: 'execute_task',
    nextActionParams: { sessionId },
    hint: `태스크 ${taskId} 결과를 기록하지 않았습니다. 작업 트리를 확인하고 다시 제출하세요.`,
  };
  return JSON.stringify(
    {
      status: 'verification_failed',
      sessionId,
      taskId,
      recorded: false,
      ...(problems.length > 0 ? { problems } : {}),
      message,
      ...guide,
    },
    null,
    2,
  );
}
