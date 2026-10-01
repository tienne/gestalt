import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ExecuteSessionManager } from '../../../src/execute/session.js';
import { EventStore } from '../../../src/events/store.js';
import { ExecuteSessionNotFoundError } from '../../../src/core/errors.js';
import type { Spec, TaskExecutionResult } from '../../../src/core/types.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const spec = (): Spec => ({
  version: '1.0',
  goal: 'goal',
  constraints: [],
  acceptanceCriteria: ['AC0', 'AC1'],
  ontologySchema: { entities: [], relations: [] },
  gestaltAnalysis: [],
  metadata: {
    specId: `spec-${randomUUID()}`,
    interviewSessionId: `interview-${randomUUID()}`,
    resolutionScore: 0.9,
    generatedAt: new Date().toISOString(),
  },
});

const done = (taskId: string): TaskExecutionResult => ({
  taskId,
  status: 'completed',
  output: 'ok',
  artifacts: [],
});

// MCP 프로세스 둘이 같은 DB를 쓰는 상황을 연결 두 개로 흉내 낸다
describe('ExecuteSessionManager — 같은 DB를 쓰는 두 인스턴스', () => {
  let dbPath: string;
  let storeA: EventStore;
  let storeB: EventStore;
  let a: ExecuteSessionManager;
  let b: ExecuteSessionManager;

  beforeEach(() => {
    dbPath = `.gestalt-test/execute-cross-${randomUUID()}.db`;
    storeA = new EventStore(dbPath);
    storeB = new EventStore(dbPath);
    a = new ExecuteSessionManager(storeA);
    b = new ExecuteSessionManager(storeB);
    a.loadFromStore();
    b.loadFromStore();
  });

  afterEach(() => {
    storeA.close();
    storeB.close();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (existsSync(p)) rmSync(p);
    }
  });

  it('다른 인스턴스가 기동 뒤에 만든 세션을 찾는다', () => {
    const created = a.create(spec());

    expect(b.get(created.sessionId).specId).toBe(created.specId);
  });

  it('없는 세션은 여전히 NotFound다', () => {
    expect(() => b.get('missing')).toThrow(ExecuteSessionNotFoundError);
  });

  it('다른 인스턴스가 덧붙인 태스크 결과를 쓰기 전에 반영한다', () => {
    const { sessionId } = a.create(spec());
    a.startExecution(sessionId);
    b.get(sessionId); // b 캐시에 결과 0개 상태로 올라간다

    a.addTaskResult(sessionId, done('task-a'));
    b.addTaskResult(sessionId, done('task-b'));

    // 낡은 캐시 위에 썼다면 b에는 task-a가 없다
    expect(b.get(sessionId).completedTaskIds).toEqual(['task-a', 'task-b']);
    expect(a.get(sessionId).completedTaskIds).toEqual(['task-a', 'task-b']);
  });

  it('TTL로 캐시에서 지운 세션도 get()이 다시 찾는다', () => {
    const { sessionId } = a.create(spec());
    expect(a.cleanup(-1)).toBe(1);

    expect(a.get(sessionId).sessionId).toBe(sessionId);
  });

  it('auditResult와 역할 상태 초기화가 재시작 뒤에도 남는다', () => {
    const { sessionId } = a.create(spec());
    const auditResult = {
      implementedACs: [0],
      partialACs: [],
      missingACs: [1],
      gapAnalysis: 'AC1 빠짐',
      auditedAt: new Date().toISOString(),
    };
    a.setRoleMatches(sessionId, 'task-0', [
      { agentName: 'architect', domain: ['infra'], relevanceScore: 0.9, reasoning: 'r' },
    ]);
    a.setAuditResult(sessionId, auditResult);
    a.clearRoleState(sessionId);

    const restarted = new ExecuteSessionManager(storeB);
    restarted.loadFromStore();
    const session = restarted.get(sessionId);
    expect(session.auditResult).toEqual(auditResult);
    expect(session.roleMatches).toBeUndefined();
  });

  it('다른 인스턴스 이벤트로 다시 재구성해도 역할 매칭과 하위 태스크가 남는다', () => {
    const { sessionId } = a.create(spec());
    const matches = [
      { agentName: 'architect', domain: ['infra'], relevanceScore: 0.9, reasoning: 'r' },
    ];
    const consensus = {
      consensus: 'c',
      conflictResolutions: [],
      perspectives: [{ agentName: 'architect', perspective: 'p', confidence: 0.8 }],
    };
    const subTask = {
      taskId: 'task-0-sub-1',
      parentTaskId: 'task-0',
      title: 't',
      description: 'd',
      inheritedContext: '',
      dependsOn: [],
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    };
    a.setRoleMatches(sessionId, 'task-0', matches);
    a.setRoleConsensus(sessionId, 'task-0', consensus);
    a.addSubTasks(sessionId, [subTask]);

    // b가 이벤트를 덧붙여 a의 캐시를 낡게 만든다 → a는 스토어에서 다시 재구성한다
    b.addTaskResult(sessionId, done('task-x'));
    const session = a.get(sessionId);

    expect(session.roleMatches).toEqual(matches);
    expect(session.roleConsensus).toEqual(consensus);
    expect(session.subTasks).toEqual([subTask]);
    expect(session.taskResults.map((r) => r.taskId)).toEqual(['task-x']);
  });
});
