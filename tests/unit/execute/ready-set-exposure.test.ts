import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { handleExecutePassthrough } from '../../../src/mcp/tools/execute-passthrough.js';
import { validateDAG } from '../../../src/execute/dag-validator.js';
import type { ExecuteInput } from '../../../src/mcp/schemas.js';
import type {
  Spec,
  AtomicTask,
  TaskGroup,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
} from '../../../src/core/types.js';

/**
 * ready set(nextTaskIds)이 MCP 응답으로 실제 노출되는지 검증한다.
 * 대상 4곳: execute_task / resume / status(단건) / status(목록).
 */

const PARALLEL_HINT_FRAGMENT = '착수 가능한 태스크';

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

// 다이아몬드: task-0 → {task-1, task-2} → task-3 (task-0 완료 시 ready 2개)
const diamondTasks: AtomicTask[] = [
  makeTask('task-0', [], 0),
  makeTask('task-1', ['task-0'], 1),
  makeTask('task-2', ['task-0'], 2),
  makeTask('task-3', ['task-1', 'task-2'], 3),
];

// 선형 체인: task-0 → task-1 → task-2 (ready는 항상 1개)
const linearTasks: AtomicTask[] = [
  makeTask('task-0', [], 0),
  makeTask('task-1', ['task-0'], 1),
  makeTask('task-2', ['task-1'], 2),
];

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

interface ExecuteTaskResponse {
  status: string;
  nextTaskIds?: string[];
  message?: string;
}

interface ResumeResponse {
  status: string;
  resumeContext?: { nextTaskId: string | null; nextTaskIds: string[] };
  message?: string;
}

interface StatusResponse {
  session?: { resumeContext?: { nextTaskId: string | null; nextTaskIds: string[] } };
  sessions?: Array<{
    sessionId: string;
    resumeContext?: { nextTaskId: string | null; nextTaskIds: string[] };
  }>;
}

describe('ready set(nextTaskIds) MCP 노출', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/ready-set-exposure-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
  });

  /** 플래닝 4단계를 마치고 실행을 시작한 세션을 만든다 */
  function startSession(tasks: AtomicTask[]): string {
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
    engine.startExecution(sessionId);
    return sessionId;
  }

  function submitTask(sessionId: string, taskId: string): Promise<string> {
    return handleExecutePassthrough(
      engine,
      {
        action: 'execute_task',
        sessionId,
        taskResult: { taskId, status: 'completed', output: `${taskId} done`, artifacts: [] },
      } as ExecuteInput,
      'claude-code',
    );
  }

  describe('execute_task', () => {
    it('응답에 nextTaskIds가 노출되고 병렬 가능 상황에서 2개 이상이다', async () => {
      const sessionId = startSession(diamondTasks);

      const parsed = JSON.parse(await submitTask(sessionId, 'task-0')) as ExecuteTaskResponse;

      expect(parsed).toHaveProperty('nextTaskIds');
      expect(parsed.nextTaskIds!.length).toBeGreaterThanOrEqual(2);
      expect(parsed.nextTaskIds).toEqual(['task-1', 'task-2']);
    });

    it('ready가 2개 이상이면 message에 동시 진행 가능 문구가 붙는다', async () => {
      const sessionId = startSession(diamondTasks);

      const parsed = JSON.parse(await submitTask(sessionId, 'task-0')) as ExecuteTaskResponse;

      expect(parsed.message).toContain(PARALLEL_HINT_FRAGMENT);
      expect(parsed.message).toContain('task-1, task-2');
    });

    it('ready가 1개면 message에 문구가 붙지 않는다 (경계)', async () => {
      const sessionId = startSession(linearTasks);

      const parsed = JSON.parse(await submitTask(sessionId, 'task-0')) as ExecuteTaskResponse;

      expect(parsed.nextTaskIds).toEqual(['task-1']);
      expect(parsed.message).not.toContain(PARALLEL_HINT_FRAGMENT);
    });
  });

  describe('resume', () => {
    it('resumeContext에 nextTaskIds가 있고 nextTaskId와 정합한다', async () => {
      const sessionId = startSession(diamondTasks);
      await submitTask(sessionId, 'task-0');

      const result = await handleExecutePassthrough(
        engine,
        { action: 'resume', sessionId } as ExecuteInput,
        'claude-code',
      );
      const parsed = JSON.parse(result) as ResumeResponse;

      expect(parsed.status).toBe('resume_context');
      expect(parsed.resumeContext).toBeDefined();
      expect(parsed.resumeContext!.nextTaskIds).toEqual(['task-1', 'task-2']);
      expect(parsed.resumeContext!.nextTaskId).toBe(parsed.resumeContext!.nextTaskIds[0]);
      expect(parsed.message).toContain(PARALLEL_HINT_FRAGMENT);
    });

    it('ready가 1개면 resume message에 문구가 붙지 않는다 (경계)', async () => {
      const sessionId = startSession(linearTasks);
      await submitTask(sessionId, 'task-0');

      const result = await handleExecutePassthrough(
        engine,
        { action: 'resume', sessionId } as ExecuteInput,
        'claude-code',
      );
      const parsed = JSON.parse(result) as ResumeResponse;

      expect(parsed.resumeContext!.nextTaskIds).toEqual(['task-1']);
      expect(parsed.message).not.toContain(PARALLEL_HINT_FRAGMENT);
    });
  });

  describe('status', () => {
    it('단건 status의 resumeContext에 nextTaskIds가 노출된다', async () => {
      const sessionId = startSession(diamondTasks);
      await submitTask(sessionId, 'task-0');

      const result = await handleExecutePassthrough(
        engine,
        { action: 'status', sessionId } as ExecuteInput,
        'claude-code',
      );
      const parsed = JSON.parse(result) as StatusResponse;

      const resumeContext = parsed.session!.resumeContext!;
      expect(resumeContext.nextTaskIds).toEqual(['task-1', 'task-2']);
      expect(resumeContext.nextTaskId).toBe('task-1');
    });

    it('목록 status의 resumeContext에 세션 필드 nextTaskIds가 노출된다', async () => {
      const sessionId = startSession(diamondTasks);
      await submitTask(sessionId, 'task-0');

      const result = await handleExecutePassthrough(
        engine,
        { action: 'status' } as ExecuteInput,
        'claude-code',
      );
      const parsed = JSON.parse(result) as StatusResponse;

      const entry = parsed.sessions!.find((s) => s.sessionId === sessionId)!;
      expect(entry.resumeContext).toBeDefined();
      expect(entry.resumeContext!.nextTaskIds).toEqual(['task-1', 'task-2']);
      expect(entry.resumeContext!.nextTaskId).toBe('task-1');
    });

    it('단건 status와 목록 status의 ready set이 서로 일치한다', async () => {
      const sessionId = startSession(diamondTasks);
      await submitTask(sessionId, 'task-0');

      const single = JSON.parse(
        await handleExecutePassthrough(
          engine,
          { action: 'status', sessionId } as ExecuteInput,
          'claude-code',
        ),
      ) as StatusResponse;
      const list = JSON.parse(
        await handleExecutePassthrough(engine, { action: 'status' } as ExecuteInput, 'claude-code'),
      ) as StatusResponse;

      const fromSingle = single.session!.resumeContext!;
      const fromList = list.sessions!.find((s) => s.sessionId === sessionId)!.resumeContext!;

      expect(fromList.nextTaskIds).toEqual(fromSingle.nextTaskIds);
      expect(fromList.nextTaskId).toEqual(fromSingle.nextTaskId);
    });
  });
});
