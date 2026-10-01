import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readActiveSession } from '../../../src/execute/rule-writer.js';
import type { IHostAdapter } from '../../../src/mcp/host-adapter.js';
import { handleExecutePassthrough } from '../../../src/mcp/tools/execute-passthrough.js';
import type { ExecuteInput } from '../../../src/mcp/schemas.js';
import {
  createExecuteFixture,
  RecordingAdapter,
  type ExecuteFixture,
} from '../../helpers/execute-fixture.js';

/**
 * execute_start 핸들러가 엔진 결과 위에 얹는 일을 본다.
 * cwd가 있을 때 룰 파일과 active-session을 쓰고 그게 실패해도 실행은 막지 않는다.
 */

interface ExecuteStartResponse {
  error?: string;
  status?: string;
  sessionId?: string;
  taskContext?: {
    currentTask: { taskId: string; title: string };
    pendingTasks?: Array<Record<string, unknown>>;
    taskPrompt?: string;
    systemPrompt?: string;
    similarityStrategy?: unknown;
    consistencyHint?: unknown;
  } | null;
  nextAction?: string;
  hint?: string;
}

describe('ges_execute execute_start 핸들러', () => {
  let fx: ExecuteFixture;
  let cwd: string;

  beforeEach(() => {
    fx = createExecuteFixture('handlers-execute-start');
    cwd = mkdtempSync(join(tmpdir(), 'gestalt-exec-start-'));
  });
  afterEach(() => {
    fx.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  it('sessionId가 없으면 에러를 돌려준다', async () => {
    const res = await fx.call<ExecuteStartResponse>({ action: 'execute_start' });
    expect(res.error).toContain('sessionId is required');
  });

  it('플래닝이 안 끝난 세션이면 엔진 에러를 그대로 돌려준다', async () => {
    const { sessionId } = fx.startedSession();
    const res = await fx.call<ExecuteStartResponse>({ action: 'execute_start', sessionId });
    expect(res.error).toEqual(expect.any(String));
  });

  it('첫 태스크 컨텍스트와 execute_task 안내를 돌려준다', async () => {
    const { sessionId } = fx.plannedSession();
    const res = await fx.call<ExecuteStartResponse>({ action: 'execute_start', sessionId });

    expect(res.status).toBe('executing');
    expect(res.taskContext?.currentTask.taskId).toBe('task-0');
    expect(res.nextAction).toBe('execute_task');
    expect(res.hint).toContain('Task task-0');
  });

  it('taskContext를 줄여서 내보낸다 (pendingTasks 필드 축소, similarityStrategy 치환)', async () => {
    const { sessionId } = fx.plannedSession();
    const res = await fx.call<ExecuteStartResponse>({ action: 'execute_start', sessionId });

    expect(res.taskContext).not.toHaveProperty('similarityStrategy');
    expect(res.taskContext?.consistencyHint).toBeDefined();
    for (const pending of res.taskContext?.pendingTasks ?? []) {
      expect(Object.keys(pending).sort()).toEqual(['dependsOn', 'taskId', 'title']);
    }
  });

  it('verbose=false면 taskPrompt와 systemPrompt를 걷어낸다', async () => {
    const { sessionId } = fx.plannedSession();
    const res = await fx.call<ExecuteStartResponse>({
      action: 'execute_start',
      sessionId,
      verbose: false,
    });

    expect(res.taskContext).not.toHaveProperty('taskPrompt');
    expect(res.taskContext).not.toHaveProperty('systemPrompt');
    expect(res.taskContext?.currentTask.taskId).toBe('task-0');
  });

  it('cwd가 없으면 룰 파일을 안 쓴다', async () => {
    const { sessionId } = fx.plannedSession();
    const adapter = new RecordingAdapter();
    await fx.call({ action: 'execute_start', sessionId }, adapter);

    expect(adapter.written).toHaveLength(0);
  });

  it('cwd가 있으면 목표와 현재 태스크가 담긴 룰을 쓰고 active-session을 남긴다', async () => {
    const { sessionId, spec } = fx.plannedSession();
    const adapter = new RecordingAdapter();
    await fx.call({ action: 'execute_start', sessionId, cwd }, adapter);

    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0]).toContain(spec.goal);
    expect(adapter.written[0]).toContain('task-0');

    const active = readActiveSession(cwd);
    expect(active?.sessionId).toBe(sessionId);
    expect(active?.specId).toBe(spec.metadata.specId);
  });

  it('client 문자열을 넘기면 cwd 기준 실제 어댑터로 .claude/rules 파일이 생긴다', async () => {
    const { sessionId, spec } = fx.plannedSession();
    await handleExecutePassthrough(
      fx.engine,
      { action: 'execute_start', sessionId, cwd } as ExecuteInput,
      'claude-code',
    );

    const rulePath = join(cwd, '.claude/rules/gestalt-active.md');
    expect(existsSync(rulePath)).toBe(true);
    expect(readFileSync(rulePath, 'utf-8')).toContain(spec.goal);
  });

  it('룰 파일 쓰기가 실패해도 실행은 그대로 시작된다', async () => {
    const { sessionId } = fx.plannedSession();
    const failing: IHostAdapter = {
      writeActiveContext: () => Promise.reject(new Error('disk full')),
      clearActiveContext: () => Promise.resolve(),
    };
    const res = await fx.call<ExecuteStartResponse>(
      { action: 'execute_start', sessionId, cwd },
      failing,
    );

    expect(res.status).toBe('executing');
    expect(fx.engine.getSession(sessionId).status).toBe('executing');
  });

  it('모든 태스크가 끝난 세션이면 evaluate로 안내한다', async () => {
    const { sessionId } = fx.plannedSession();
    const session = fx.engine.getSession(sessionId);
    session.taskResults = session.executionPlan!.atomicTasks.map((t) => ({
      taskId: t.taskId,
      status: 'skipped' as const,
      output: '',
      artifacts: [],
    }));

    const adapter = new RecordingAdapter();
    const res = await fx.call<ExecuteStartResponse>(
      { action: 'execute_start', sessionId, cwd },
      adapter,
    );

    expect(res.status).toBe('all_tasks_completed');
    expect(res.nextAction).toBe('evaluate');
    expect(adapter.written).toHaveLength(0);
  });
});
