import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { handleExecutePassthrough } from '../../../src/mcp/tools/execute-passthrough.js';
import { validateDAG } from '../../../src/execute/dag-validator.js';
import { BASELINE_EVENT_DIRTY_LIMIT } from '../../../src/core/constants.js';
import type { ExecuteInput } from '../../../src/mcp/schemas.js';
import type {
  Spec,
  AtomicTask,
  TaskGroup,
  TaskExecutionResult,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
} from '../../../src/core/types.js';

/**
 * execute_task의 completed 보고를 git 작업 트리와 대조하는 경로.
 * 실행 시작 시점이 기준이다. 대조에 실패하면 결과를 기록하지 않고 재확인을 요구한다.
 */

function makeTask(taskId: string, dependsOn: string[], acIndex: number): AtomicTask {
  return {
    taskId,
    title: `Task ${taskId}`,
    description: `Implement ${taskId}`,
    sourceAC: [acIndex],
    isImplicit: false,
    estimatedComplexity: 'low',
    dependsOn,
  };
}

function makeGroups(tasks: AtomicTask[]): TaskGroup[] {
  return [
    {
      groupId: 'group-0',
      name: 'All',
      domain: 'core',
      taskIds: tasks.map((t) => t.taskId),
      reasoning: 'single group',
    },
  ];
}

function createTestSpec(): Spec {
  return {
    version: '1.0',
    goal: 'Expose the ready task set',
    constraints: ['TypeScript'],
    acceptanceCriteria: ['AC0', 'AC1', 'AC2', 'AC3'],
    ontologySchema: {
      entities: [{ name: 'Task', description: 'A task', attributes: ['taskId'] }],
      relations: [{ from: 'Task', to: 'Task', type: 'depends_on' }],
    },
    gestaltAnalysis: [{ principle: 'closure' as const, finding: 'Ready set', confidence: 0.9 }],
    metadata: {
      specId: `spec-${randomUUID()}`,
      interviewSessionId: `interview-${randomUUID()}`,
      resolutionScore: 0.85,
      generatedAt: new Date().toISOString(),
    },
  };
}

function figureGround(spec: Spec): FigureGroundResult {
  return {
    principle: 'figure_ground',
    classifiedACs: spec.acceptanceCriteria.map((acText, acIndex) => ({
      acIndex,
      acText,
      classification: 'figure' as const,
      priority: 'high' as const,
      reasoning: 'Core',
    })),
  };
}

const tasks: AtomicTask[] = [makeTask('task-0', [], 0), makeTask('task-1', ['task-0'], 1)];

interface TaskResponse {
  status: string;
  recorded?: boolean;
  serverError?: boolean;
  problems?: Array<{ path: string; status: string }>;
  artifactCheck?: string;
  message?: string;
  nextAction?: string;
  completedTasks?: number;
}

interface StartResponse {
  status: string;
  artifactCheck?: { repoRoot: string; baseline: string; error?: string };
}

// git을 여러 번 띄우므로 부하가 걸린 머신에서는 기본 5초를 넘긴다
describe('execute_task 완료 보고 대조', { timeout: 30_000 }, () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;
  let repo: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/artifact-verify-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);

    repo = mkdtempSync(join(tmpdir(), 'gestalt-exec-verify-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'app.ts'), 'export const v = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
    rmSync(repo, { recursive: true, force: true });
  });

  function planSession(): string {
    const spec = createTestSpec();
    const startResult = engine.start(spec);
    if (!startResult.ok) throw new Error('start failed');
    const { sessionId } = startResult.value.session;

    const groups = makeGroups(tasks);
    const closure: ClosureResult = { principle: 'closure', atomicTasks: tasks };
    const proximity: ProximityResult = { principle: 'proximity', taskGroups: groups };
    const continuity: ContinuityResult = {
      principle: 'continuity',
      dagValidation: validateDAG(tasks, groups),
    };
    engine.planStep(sessionId, figureGround(spec));
    engine.planStep(sessionId, closure);
    engine.planStep(sessionId, proximity);
    engine.planStep(sessionId, continuity);
    engine.planComplete(sessionId);
    return sessionId;
  }

  async function startRaw(cwd = repo): Promise<{ sessionId: string; res: StartResponse }> {
    const sessionId = planSession();
    const raw = await handleExecutePassthrough(
      engine,
      { action: 'execute_start', sessionId, cwd } as ExecuteInput,
      'claude-code',
    );
    return { sessionId, res: JSON.parse(raw) as StartResponse };
  }

  async function startInRepo(cwd = repo): Promise<string> {
    return (await startRaw(cwd)).sessionId;
  }

  async function submit(
    sessionId: string,
    taskResult: Partial<TaskExecutionResult> & { taskId: string },
  ): Promise<TaskResponse> {
    const raw = await handleExecutePassthrough(
      engine,
      {
        action: 'execute_task',
        sessionId,
        taskResult: { status: 'completed', output: 'done', artifacts: [], ...taskResult },
      } as ExecuteInput,
      'claude-code',
    );
    return JSON.parse(raw) as TaskResponse;
  }

  it('보고한 파일이 실제로 바뀌었으면 기록하고 다음 태스크로 넘어간다', async () => {
    const sessionId = await startInRepo();
    writeFileSync(join(repo, 'app.ts'), 'export const v = 2;\n');

    const res = await submit(sessionId, { taskId: 'task-0', artifacts: ['app.ts'] });

    expect(res.status).toBe('executing');
    expect(res.artifactCheck).toBe('verified');
    expect(engine.getSession(sessionId).completedTaskIds).toEqual(['task-0']);
  });

  it('보고한 파일이 그대로면 기록하지 않고 재확인을 요구한다', async () => {
    const sessionId = await startInRepo();

    const res = await submit(sessionId, { taskId: 'task-0', artifacts: ['app.ts', 'ghost.ts'] });

    expect(res.status).toBe('verification_failed');
    expect(res.recorded).toBe(false);
    expect(res.nextAction).toBe('execute_task');
    expect(res.problems).toEqual([
      expect.objectContaining({ path: 'app.ts', status: 'unchanged' }),
      expect.objectContaining({ path: 'ghost.ts', status: 'missing' }),
    ]);
    const session = engine.getSession(sessionId);
    expect(session.completedTaskIds).toEqual([]);
    expect(session.taskResults).toEqual([]);
  });

  it('거절된 뒤 실제로 고치고 다시 내면 통과한다', async () => {
    const sessionId = await startInRepo();
    expect((await submit(sessionId, { taskId: 'task-0', artifacts: ['app.ts'] })).status).toBe(
      'verification_failed',
    );

    writeFileSync(join(repo, 'app.ts'), 'export const v = 3;\n');
    const res = await submit(sessionId, { taskId: 'task-0', artifacts: ['app.ts'] });

    expect(res.status).toBe('executing');
    expect(engine.getSession(sessionId).completedTaskIds).toEqual(['task-0']);
  });

  it('artifacts가 비어 있고 noCodeChange 선언도 없으면 막는다', async () => {
    const sessionId = await startInRepo();

    const res = await submit(sessionId, { taskId: 'task-0' });

    expect(res.status).toBe('verification_failed');
    expect(res.message).toContain('noCodeChange');
    expect(engine.getSession(sessionId).completedTaskIds).toEqual([]);
  });

  it('noCodeChange를 선언한 태스크는 파일 변경 없이 통과하고 재시작 뒤에도 남는다', async () => {
    const sessionId = await startInRepo();

    const res = await submit(sessionId, { taskId: 'task-0', noCodeChange: true });

    expect(res.status).toBe('executing');
    expect(res.artifactCheck).toBe('no_code_change');

    const restored = new PassthroughExecuteEngine(store);
    restored.getSessionManager().loadFromStore();
    const session = restored.getSession(sessionId);
    expect(session.taskResults[0]!.noCodeChange).toBe(true);
    expect(session.workingTreeBaseline?.head).toMatch(/^[0-9a-f]{40}$/);
  });

  it('noCodeChange를 선언해도 artifacts가 있으면 대조한다', async () => {
    const sessionId = await startInRepo();

    const res = await submit(sessionId, {
      taskId: 'task-0',
      artifacts: ['app.ts'],
      noCodeChange: true,
    });

    expect(res.status).toBe('verification_failed');
  });

  it('failed 보고는 대조하지 않는다', async () => {
    const sessionId = await startInRepo();

    const res = await submit(sessionId, { taskId: 'task-0', status: 'failed' });

    expect(res.status).toBe('executing');
    expect(res.artifactCheck).toBeUndefined();
  });

  it('git 레포가 아닌 곳에서 시작하면 대조 없이 통과시키고 그 사실을 드러낸다', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'gestalt-exec-plain-'));
    try {
      const sessionId = await startInRepo(plain);

      const res = await submit(sessionId, { taskId: 'task-0' });

      expect(res.status).toBe('executing');
      expect(res.artifactCheck).toBe('no_baseline');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('재시작 뒤 resume된 세션도 시작 시점 기준으로 대조한다', async () => {
    const sessionId = await startInRepo();

    const restored = new PassthroughExecuteEngine(store);
    restored.getSessionManager().loadFromStore();
    const raw = await handleExecutePassthrough(
      restored,
      {
        action: 'execute_task',
        sessionId,
        taskResult: {
          taskId: 'task-0',
          status: 'completed',
          output: 'done',
          artifacts: ['app.ts'],
        },
      } as ExecuteInput,
      'claude-code',
    );

    expect((JSON.parse(raw) as TaskResponse).status).toBe('verification_failed');
  });

  it('execute_start 응답에 대조 기준 루트와 기준 트리를 잡았는지 싣는다', async () => {
    const { res } = await startRaw();
    expect(res.artifactCheck).toEqual({ repoRoot: repo, baseline: 'captured' });

    const plain = mkdtempSync(join(tmpdir(), 'gestalt-exec-plain-'));
    try {
      const { res: plainRes } = await startRaw(plain);
      expect(plainRes.artifactCheck?.baseline).toBe('no_baseline');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('git 호출이 실패하면 서버 쪽 실패라고 알리고 기록하지 않는다', async () => {
    const sessionId = await startInRepo();
    writeFileSync(join(repo, 'app.ts'), 'export const v = 2;\n');
    rmSync(join(repo, '.git'), { recursive: true, force: true });

    const res = await submit(sessionId, { taskId: 'task-0', artifacts: ['app.ts'] });

    expect(res.status).toBe('verification_failed');
    expect(res.serverError).toBe(true);
    expect(res.message).toContain('failed');
    expect(engine.getSession(sessionId).completedTaskIds).toEqual([]);
  });

  it('dirty 파일이 상한을 넘으면 이벤트에 해시를 안 남기고 재시작 뒤에는 그 사유로 통과시킨다', async () => {
    mkdirSync(join(repo, 'gen'));
    for (let i = 0; i <= BASELINE_EVENT_DIRTY_LIMIT; i++) {
      writeFileSync(join(repo, 'gen', `f${i}.txt`), `${i}\n`);
    }
    const sessionId = await startInRepo();

    // 같은 프로세스에서는 메모리의 기준 트리로 그대로 대조한다
    expect((await submit(sessionId, { taskId: 'task-0', artifacts: ['app.ts'] })).status).toBe(
      'verification_failed',
    );

    const restored = new PassthroughExecuteEngine(store);
    restored.getSessionManager().loadFromStore();
    const raw = await handleExecutePassthrough(
      restored,
      {
        action: 'execute_task',
        sessionId,
        taskResult: { taskId: 'task-0', status: 'completed', output: 'done', artifacts: [] },
      } as ExecuteInput,
      'claude-code',
    );
    const res = JSON.parse(raw) as TaskResponse;
    expect(res.status).toBe('executing');
    expect(res.artifactCheck).toBe('baseline_truncated');
  });
});
