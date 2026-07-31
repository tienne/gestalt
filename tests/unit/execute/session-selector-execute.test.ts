import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { PassthroughReviewEngine } from '../../../src/review/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { handleExecutePassthrough } from '../../../src/mcp/tools/execute-passthrough.js';
import { handleReviewPassthrough } from '../../../src/mcp/tools/review-passthrough.js';
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
 * `active`/`latest` 셀렉터가 execute·review 핸들러 경로에서 실제로 해석되는지 검증한다.
 * 순수 함수 테스트(tests/unit/mcp/session-selector.test.ts)로는
 * `resolveExecuteSessionInput` 배선이 빠져도 통과하므로 핸들러를 직접 호출한다.
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

// 다이아몬드: task-0 → {task-1, task-2} → task-3
const diamondTasks: AtomicTask[] = [
  makeTask('task-0', [], 0),
  makeTask('task-1', ['task-0'], 1),
  makeTask('task-2', ['task-0'], 2),
  makeTask('task-3', ['task-1', 'task-2'], 3),
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

function createTestSpec(goal: string): Spec {
  return {
    version: '1.0',
    goal,
    constraints: ['TypeScript'],
    acceptanceCriteria: ['AC0', 'AC1', 'AC2', 'AC3'],
    ontologySchema: {
      entities: [{ name: 'Task', description: 'A task', attributes: ['taskId'] }],
      relations: [{ from: 'Task', to: 'Task', type: 'depends_on' }],
    },
    gestaltAnalysis: [{ principle: 'closure' as const, finding: 'Selector', confidence: 0.9 }],
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

interface StatusResponse {
  session?: { sessionId: string; createdAt: string; updatedAt: string; status: string };
  sessions?: Array<{ sessionId: string }>;
  error?: string;
}

interface ReviewStartResponse {
  status?: string;
  executeSessionId?: string | null;
  reviewSessionId?: string;
  error?: string;
}

function writeActiveSessionFile(cwd: string, sessionId: string, specId: string): void {
  const dir = join(cwd, '.gestalt');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'active-session.json'),
    JSON.stringify({ sessionId, specId, updatedAt: new Date().toISOString() }),
    'utf-8',
  );
}

describe('execute 경로 셀렉터 해석 (handleExecutePassthrough)', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;
  let cwd: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/selector-execute-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
    cwd = mkdtempSync(join(tmpdir(), `gestalt-exec-selector-${randomUUID()}-`));
    // Date만 고정한다 — 타이머를 가짜로 바꾸면 async 핸들러 await가 막힌다.
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  /** 플래닝 4단계를 마치고 실행을 시작한 세션을 만든다 */
  function startSession(goal: string, tasks: AtomicTask[] = diamondTasks): string {
    const spec = createTestSpec(goal);
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

  function status(input: Partial<ExecuteInput>): Promise<string> {
    return handleExecutePassthrough(
      engine,
      { action: 'status', ...input } as ExecuteInput,
      'claude-code',
    );
  }

  /**
   * 세션 2개를 만들되 updatedAt 순서를 생성 순서와 반대로 만든다.
   * older가 먼저 생성됐지만 나중에 갱신되어 latest의 정답이다 —
   * createdAt이나 목록 순서를 쓰면 newer를 골라 실패한다.
   */
  async function twoSessionsWithMixedTimestamps(): Promise<{
    latestUpdated: string;
    latestCreated: string;
  }> {
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const older = startSession('older session');

    vi.setSystemTime(new Date('2026-02-01T00:00:00.000Z'));
    const newer = startSession('newer session');

    // older를 마지막으로 갱신 → updatedAt 최신은 older
    vi.setSystemTime(new Date('2026-03-01T00:00:00.000Z'));
    await engine.submitTaskResult(older, {
      taskId: 'task-0',
      status: 'completed',
      output: 'task-0 done',
      artifacts: [],
    });

    return { latestUpdated: older, latestCreated: newer };
  }

  it('latest가 updatedAt 최신 세션으로 해석된다 (createdAt 최신이 아님)', async () => {
    const { latestUpdated, latestCreated } = await twoSessionsWithMixedTimestamps();

    const parsed = JSON.parse(await status({ sessionId: 'latest' })) as StatusResponse;

    expect(parsed.error).toBeUndefined();
    expect(parsed.session).toBeDefined();
    expect(parsed.session!.sessionId).toBe(latestUpdated);
    expect(parsed.session!.sessionId).not.toBe(latestCreated);
  });

  it('해석된 세션은 실제로 updatedAt이 가장 최근이다', async () => {
    await twoSessionsWithMixedTimestamps();

    const parsed = JSON.parse(await status({ sessionId: 'latest' })) as StatusResponse;
    const all = engine.listSessions();
    const maxUpdatedAt = all.map((s) => s.updatedAt).sort((a, b) => b.localeCompare(a))[0]!;

    expect(parsed.session!.updatedAt).toBe(maxUpdatedAt);
    // createdAt 최신은 다른 세션이라는 전제가 유지되는지 확인
    const maxCreatedAt = all.map((s) => s.createdAt).sort((a, b) => b.localeCompare(a))[0]!;
    expect(parsed.session!.createdAt).not.toBe(maxCreatedAt);
  });

  it('Latest 대소문자·공백도 execute 경로에서 해석된다', async () => {
    const { latestUpdated } = await twoSessionsWithMixedTimestamps();

    for (const selector of ['LATEST', ' Latest ']) {
      const parsed = JSON.parse(await status({ sessionId: selector })) as StatusResponse;
      expect(parsed.session!.sessionId).toBe(latestUpdated);
    }
  });

  it('latest는 resume 액션에서도 해석된다', async () => {
    const { latestUpdated } = await twoSessionsWithMixedTimestamps();

    const parsed = JSON.parse(
      await handleExecutePassthrough(
        engine,
        { action: 'resume', sessionId: 'latest' } as ExecuteInput,
        'claude-code',
      ),
    ) as { status?: string; error?: string };

    // sessionId가 해석되지 않았다면 "Session not found: latest"로 실패한다
    expect(parsed.error).toBeUndefined();
    expect(parsed.status).toBe('resume_context');
    expect(latestUpdated).toBeTruthy();
  });

  it('실행 세션이 없으면 latest는 ges_execute 안내 에러를 반환한다', async () => {
    const parsed = JSON.parse(await status({ sessionId: 'latest' })) as StatusResponse;

    expect(parsed.session).toBeUndefined();
    expect(parsed.error).toContain('ges_execute');
    expect(parsed.error).toContain('action=start');
  });

  it('active가 .gestalt/active-session.json의 세션으로 해석된다', async () => {
    const target = startSession('active target');
    startSession('other session');
    writeActiveSessionFile(cwd, target, 'spec-active');

    const parsed = JSON.parse(await status({ sessionId: 'active', cwd })) as StatusResponse;

    expect(parsed.error).toBeUndefined();
    expect(parsed.session!.sessionId).toBe(target);
  });

  it('active는 latest와 다른 세션을 고른다 — 파일을 실제로 읽는다', async () => {
    const { latestUpdated, latestCreated } = await twoSessionsWithMixedTimestamps();
    writeActiveSessionFile(cwd, latestCreated, 'spec-active');

    const fromActive = JSON.parse(await status({ sessionId: 'active', cwd })) as StatusResponse;
    const fromLatest = JSON.parse(await status({ sessionId: 'latest', cwd })) as StatusResponse;

    expect(fromActive.session!.sessionId).toBe(latestCreated);
    expect(fromLatest.session!.sessionId).toBe(latestUpdated);
    expect(fromActive.session!.sessionId).not.toBe(fromLatest.session!.sessionId);
  });

  it('ACTIVE 대소문자도 execute 경로에서 해석된다', async () => {
    const target = startSession('active target');
    writeActiveSessionFile(cwd, target, 'spec-active');

    const parsed = JSON.parse(await status({ sessionId: 'ACTIVE', cwd })) as StatusResponse;

    expect(parsed.session!.sessionId).toBe(target);
  });

  it('active인데 파일이 없으면 다음 행동을 담은 에러 JSON', async () => {
    startSession('some session');

    const parsed = JSON.parse(await status({ sessionId: 'active', cwd })) as StatusResponse;

    expect(parsed.session).toBeUndefined();
    expect(parsed.error).toContain('활성 실행 세션이 없습니다');
    expect(parsed.error).toContain('ges_execute');
    expect(parsed.error).toContain('action=start');
    expect(parsed.error).toContain('UUID');
  });

  it('active인데 파일 JSON이 깨져 있어도 안내 에러로 떨어진다', async () => {
    startSession('some session');
    mkdirSync(join(cwd, '.gestalt'), { recursive: true });
    writeFileSync(join(cwd, '.gestalt', 'active-session.json'), '{broken', 'utf-8');

    const parsed = JSON.parse(await status({ sessionId: 'active', cwd })) as StatusResponse;

    expect(parsed.error).toContain('활성 실행 세션이 없습니다');
  });

  it('UUID를 넘기면 기존과 동일하게 동작한다 (회귀)', async () => {
    const sessionId = startSession('uuid target');

    const parsed = JSON.parse(await status({ sessionId })) as StatusResponse;

    expect(parsed.error).toBeUndefined();
    expect(parsed.session!.sessionId).toBe(sessionId);
    expect(parsed.session!.status).toBe('executing');
  });

  it('없는 UUID는 셀렉터로 삼키지 않고 기존 not found 에러를 낸다 (회귀)', async () => {
    startSession('some session');
    const missing = randomUUID();

    const parsed = JSON.parse(await status({ sessionId: missing })) as StatusResponse;

    expect(parsed.error).toContain(missing);
    expect(parsed.error).not.toContain('ges_execute action=start');
  });

  it('sessionId를 안 주면 셀렉터 해석 없이 목록 모드로 동작한다 (회귀)', async () => {
    const a = startSession('a');
    const b = startSession('b');

    const parsed = JSON.parse(await status({})) as StatusResponse;

    expect(parsed.error).toBeUndefined();
    expect(parsed.sessions!.map((s) => s.sessionId).sort()).toEqual([a, b].sort());
  });
});

describe('review 경로 셀렉터 해석 (handleReviewPassthrough)', () => {
  let store: EventStore;
  let executeEngine: PassthroughExecuteEngine;
  let reviewEngine: PassthroughReviewEngine;
  let dbPath: string;
  let cwd: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/selector-review-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    executeEngine = new PassthroughExecuteEngine(store);
    reviewEngine = new PassthroughReviewEngine(store);
    cwd = mkdtempSync(join(tmpdir(), `gestalt-review-selector-${randomUUID()}-`));
  });

  afterEach(() => {
    store.close();
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(dbPath + suffix)) rmSync(dbPath + suffix);
    }
    if (existsSync(cwd)) rmSync(cwd, { recursive: true, force: true });
  });

  async function startExecuteSession(goal: string): Promise<string> {
    const spec = createTestSpec(goal);
    const startResult = executeEngine.start(spec);
    if (!startResult.ok) throw new Error('start failed');
    const { sessionId } = startResult.value.session;

    const groups = makeGroups(diamondTasks);
    executeEngine.planStep(sessionId, figureGround(spec));
    executeEngine.planStep(sessionId, { principle: 'closure', atomicTasks: diamondTasks });
    executeEngine.planStep(sessionId, { principle: 'proximity', taskGroups: groups });
    executeEngine.planStep(sessionId, {
      principle: 'continuity',
      dagValidation: validateDAG(diamondTasks, groups),
    });
    executeEngine.planComplete(sessionId);
    executeEngine.startExecution(sessionId);
    await executeEngine.submitTaskResult(sessionId, {
      taskId: 'task-0',
      status: 'completed',
      output: 'Created src/auth/login.ts',
      artifacts: ['src/auth/login.ts'],
    });
    return sessionId;
  }

  it('review_start의 sessionId=latest가 실행 세션 UUID로 해석된다', async () => {
    const sessionId = await startExecuteSession('review target');

    const parsed = JSON.parse(
      handleReviewPassthrough(reviewEngine, executeEngine, undefined, {
        action: 'review_start',
        sessionId: 'latest',
      } as ExecuteInput),
    ) as ReviewStartResponse;

    // 해석 실패 시 executeEngine.getSession('latest')가 던져 error가 온다
    expect(parsed.error).toBeUndefined();
    expect(parsed.status).toBe('review_started');
    expect(parsed.executeSessionId).toBe(sessionId);
  });

  it('review_start의 sessionId=active가 파일의 세션으로 해석된다', async () => {
    const sessionId = await startExecuteSession('review target');
    writeActiveSessionFile(cwd, sessionId, 'spec-active');

    const parsed = JSON.parse(
      handleReviewPassthrough(reviewEngine, executeEngine, undefined, {
        action: 'review_start',
        sessionId: 'active',
        cwd,
      } as ExecuteInput),
    ) as ReviewStartResponse;

    expect(parsed.error).toBeUndefined();
    expect(parsed.executeSessionId).toBe(sessionId);
  });

  it('review_start의 active에 파일이 없으면 다음 행동을 담은 에러', async () => {
    await startExecuteSession('review target');

    const parsed = JSON.parse(
      handleReviewPassthrough(reviewEngine, executeEngine, undefined, {
        action: 'review_start',
        sessionId: 'active',
        cwd,
      } as ExecuteInput),
    ) as ReviewStartResponse;

    expect(parsed.status).toBeUndefined();
    expect(parsed.error).toContain('활성 실행 세션이 없습니다');
    expect(parsed.error).toContain('ges_execute');
  });

  it('review_start에 UUID를 넘기면 기존과 동일하게 동작한다 (회귀)', async () => {
    const sessionId = await startExecuteSession('review target');

    const parsed = JSON.parse(
      handleReviewPassthrough(reviewEngine, executeEngine, undefined, {
        action: 'review_start',
        sessionId,
      } as ExecuteInput),
    ) as ReviewStartResponse;

    expect(parsed.error).toBeUndefined();
    expect(parsed.executeSessionId).toBe(sessionId);
  });
});
