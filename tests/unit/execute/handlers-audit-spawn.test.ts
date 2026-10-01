import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createExecuteFixture, type ExecuteFixture } from '../../helpers/execute-fixture.js';

interface AuditResponse {
  error?: string;
  status?: string;
  sessionId?: string;
  auditContext?: { systemPrompt: string; auditPrompt: string };
  auditResult?: { implementedACs: number[]; auditedAt: string };
  summary?: { total: number; implemented: number; partial: number; missing: number };
}

interface SpawnResponse {
  error?: string;
  status?: string;
  parentTaskId?: string;
  spawnedTasks?: Array<{ taskId: string; title: string; dependsOn: string[] }>;
}

describe('ges_execute audit 핸들러', () => {
  let fx: ExecuteFixture;

  beforeEach(() => {
    fx = createExecuteFixture('handlers-audit');
  });
  afterEach(() => fx.close());

  it('sessionId가 없으면 에러를 돌려준다', async () => {
    const res = await fx.call<AuditResponse>({ action: 'audit' });
    expect(res.error).toContain('sessionId is required');
  });

  it('없는 세션이면 에러를 돌려준다', async () => {
    const res = await fx.call<AuditResponse>({
      action: 'audit',
      sessionId: '00000000-0000-0000-0000-000000000000',
    });
    expect(res.error).toEqual(expect.any(String));
  });

  it('1차 호출은 스펙 AC와 스냅샷을 담은 auditContext를 돌려준다', async () => {
    const { sessionId, spec } = fx.startedSession();
    const res = await fx.call<AuditResponse>({
      action: 'audit',
      sessionId,
      codebaseSnapshot: 'src/index.ts: export const x = 1;',
    });

    expect(res.status).toBe('auditing');
    expect(res.auditContext?.auditPrompt).toContain(spec.goal);
    expect(res.auditContext?.auditPrompt).toContain('AC[2]: AC2');
    expect(res.auditContext?.auditPrompt).toContain('export const x = 1;');
  });

  it('스냅샷이 없으면 AC만 보고 판단하라는 안내 문구가 들어간다', async () => {
    const { sessionId } = fx.startedSession();
    const res = await fx.call<AuditResponse>({ action: 'audit', sessionId });

    expect(res.auditContext?.auditPrompt).toContain('no snapshot provided');
  });

  it('2차 호출은 결과를 세션에 저장하고 스펙 AC 수 기준으로 요약한다', async () => {
    const { sessionId } = fx.startedSession();
    const res = await fx.call<AuditResponse>({
      action: 'audit',
      sessionId,
      auditResult: {
        implementedACs: [0],
        partialACs: [1],
        missingACs: [2],
        gapAnalysis: 'AC2 missing',
      },
    });

    expect(res.status).toBe('audit_complete');
    expect(res.summary).toEqual({ total: 3, implemented: 1, partial: 1, missing: 1 });
    expect(res.auditResult?.auditedAt).toEqual(expect.any(String));

    const stored = fx.engine.getSession(sessionId).auditResult;
    expect(stored?.missingACs).toEqual([2]);
    expect(stored?.gapAnalysis).toBe('AC2 missing');
  });
});

describe('ges_execute spawn 핸들러', () => {
  let fx: ExecuteFixture;

  beforeEach(() => {
    fx = createExecuteFixture('handlers-spawn');
  });
  afterEach(() => fx.close());

  const subTasks = [
    { title: 'Sub A', description: 'first half', dependsOn: [] },
    { title: 'Sub B', description: 'second half', dependsOn: ['task-0'] },
  ];

  it.each([
    [{}, 'sessionId is required'],
    [{ sessionId: 'x' }, 'parentTaskId is required'],
    [{ sessionId: 'x', parentTaskId: 'task-1' }, 'subTasks is required'],
    [{ sessionId: 'x', parentTaskId: 'task-1', subTasks: [] }, 'subTasks is required'],
  ])('필수 입력이 빠지면 막는다 (%o)', async (input, message) => {
    const res = await fx.call<SpawnResponse>({ action: 'spawn', ...input });
    expect(res.error).toContain(message);
  });

  it('하위 태스크마다 새 id를 붙여 돌려주고 세션에 쌓는다', async () => {
    const { sessionId } = fx.executingSession();
    const res = await fx.call<SpawnResponse>({
      action: 'spawn',
      sessionId,
      parentTaskId: 'task-1',
      subTasks,
    });

    expect(res.status).toBe('spawned');
    expect(res.parentTaskId).toBe('task-1');
    expect(res.spawnedTasks).toHaveLength(2);
    const ids = res.spawnedTasks!.map((t) => t.taskId);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) expect(id).toMatch(/^spawned-[0-9a-f]{8}$/);
    expect(res.spawnedTasks![1]!.dependsOn).toEqual(['task-0']);

    const stored = fx.engine.getSession(sessionId).subTasks;
    expect(stored.map((t) => t.taskId)).toEqual(ids);
    expect(stored.every((t) => t.parentTaskId === 'task-1' && t.status === 'pending')).toBe(true);
  });

  it('부모 태스크의 제목과 설명을 inheritedContext로 물려준다', async () => {
    const { sessionId } = fx.executingSession();
    await fx.call({ action: 'spawn', sessionId, parentTaskId: 'task-1', subTasks });

    const [first] = fx.engine.getSession(sessionId).subTasks;
    expect(first!.inheritedContext).toContain('Task task-1');
    expect(first!.inheritedContext).toContain('Implement task-1');
  });

  it('계획에 없는 부모 id면 id만 적어 물려준다', async () => {
    const { sessionId } = fx.executingSession();
    const res = await fx.call<SpawnResponse>({
      action: 'spawn',
      sessionId,
      parentTaskId: 'task-404',
      subTasks,
    });

    expect(res.status).toBe('spawned');
    const [first] = fx.engine.getSession(sessionId).subTasks;
    expect(first!.inheritedContext).toBe('Parent task ID: task-404');
  });

  it('spawn 후에도 기존 태스크 진행 상태는 그대로다', async () => {
    const { sessionId } = fx.executingSession();
    const before = fx.engine.getSession(sessionId);
    const completedBefore = [...before.completedTaskIds];
    const resultsBefore = before.taskResults.length;

    await fx.call({ action: 'spawn', sessionId, parentTaskId: 'task-1', subTasks });

    const after = fx.engine.getSession(sessionId);
    expect(after.completedTaskIds).toEqual(completedBefore);
    expect(after.taskResults).toHaveLength(resultsBefore);
  });
});
