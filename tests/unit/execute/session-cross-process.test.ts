import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ExecuteSessionManager } from '../../../src/execute/session.js';
import { EventStore } from '../../../src/events/store.js';
import { ExecuteSessionRepository } from '../../../src/execute/repository.js';
import { ExecuteSessionNotFoundError } from '../../../src/core/errors.js';
import { EventType } from '../../../src/events/types.js';
import type {
  DriftScore,
  ExecuteSession,
  HumanGate,
  ExecutionPlan,
  Spec,
  TaskExecutionResult,
} from '../../../src/core/types.js';
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

const plan = (specId: string): ExecutionPlan => ({
  planId: `plan-${randomUUID()}`,
  specId,
  classifiedACs: [],
  atomicTasks: [
    {
      taskId: 'task-0',
      title: 't0',
      description: 'd0',
      sourceAC: [0],
      isImplicit: false,
      estimatedComplexity: 'low',
      dependsOn: [],
    },
  ],
  taskGroups: [],
  dagValidation: {
    isValid: true,
    hasCycles: false,
    hasConflicts: false,
    topologicalOrder: ['task-0'],
    criticalPath: ['task-0'],
  },
  parallelGroups: [['task-0']],
  createdAt: new Date().toISOString(),
});

const drift = (taskId: string): DriftScore => ({
  taskId,
  overall: 0.7,
  dimensions: [{ name: 'goal', score: 0.7, detail: 'd' }],
  thresholdExceeded: true,
  status: 'CRITICAL',
  threshold: 0.6,
  hint: '스펙과의 편차가 감지되었습니다. evolve_patch로 스펙을 수정하거나 계속 진행하세요.',
});

const gate = (): HumanGate => ({
  gateId: `gate-${randomUUID()}`,
  question: 'q',
  options: [
    { id: 'patch_spec', label: 'p', nextAction: 'evolve_patch' },
    { id: 'abort', label: 'a', nextAction: null },
  ],
  context: { triedPersonas: ['multistability'], bestScore: 0.5, unresolved: [] },
  status: 'open',
  openedAt: new Date().toISOString(),
});

// 시각은 라이브와 replay가 원래 다르다
const comparable = ({ createdAt: _c, updatedAt: _u, ...rest }: ExecuteSession) => rest;

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

  it('캐시가 최신이면 get()이 replay하지 않고 다른 인스턴스가 쓰면 한 번 replay한다', () => {
    const { sessionId } = a.create(spec());
    a.startExecution(sessionId);
    const replay = vi.spyOn(storeA, 'replay');

    a.get(sessionId);
    a.get(sessionId);
    expect(replay).not.toHaveBeenCalled();

    b.addTaskResult(sessionId, done('task-b'));
    a.get(sessionId);
    a.get(sessionId);
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it('단계마다 라이브 세션과 다른 연결의 replay 결과가 같다', () => {
    const s = spec();
    const { sessionId } = a.create(s);
    const replayed = () => new ExecuteSessionRepository(storeB).reconstruct(sessionId)!;
    const expectSame = () => expect(comparable(replayed())).toEqual(comparable(a.get(sessionId)));

    a.completePlan(sessionId, plan(s.metadata.specId));
    a.startExecution(sessionId);
    a.addTaskResult(sessionId, done('task-0'));
    a.addDriftScore(sessionId, drift('task-0'));
    expectSame();

    a.startStructuralEvaluation(sessionId);
    a.completeStructuralStage(sessionId, {
      commands: [{ name: 'test', command: 'pnpm test', exitCode: 1, output: 'FAIL' }],
      allPassed: false,
    });
    a.shortCircuitEvaluation(sessionId, 'test 실패');
    expectSame();

    a.startStructuralFix(sessionId);
    a.completeStructuralFix(sessionId, []);
    expectSame();

    // evolution.ts의 submitSpecPatch와 같은 순서로 부른다
    const live = a.get(sessionId);
    const newSpec = { ...live.spec, constraints: ['새 제약'] };
    const delta = { fieldsChanged: ['constraints'], similarity: 0.9, generation: 1 };
    a.recordEvolutionGeneration(sessionId, {
      generation: live.currentGeneration,
      spec: live.spec,
      evaluationScore: live.evaluationResult?.overallScore ?? 0,
      goalAlignment: live.evaluationResult?.goalAlignment ?? 0,
      delta,
    });
    a.patchSpec(sessionId, { constraints: ['새 제약'] }, newSpec, delta);
    a.startReExecution(sessionId, ['task-0']);
    a.addEvolveTaskResult(sessionId, done('task-0'));
    expectSame();
    expect(replayed().evolutionHistory[0]?.generation).toBe(0);

    a.terminate(sessionId, 'success');
    expectSame();
  });

  it('구조 평가 출력은 토큰을 가리고 끝부분만 이벤트에 남긴다', () => {
    const { sessionId } = a.create(spec());
    const token = `ghp_${'a'.repeat(36)}`;
    // 끝 2000자 경계가 토큰 한가운데를 지나게 둔다. 자른 뒤에 가리면 조각이 그대로 남는다
    const tail = '\nFAIL at the end';
    const output = `${'x'.repeat(5000)}${token}${'y'.repeat(2000 - 20 - tail.length)}${tail}`;
    a.completeStructuralStage(sessionId, {
      commands: [{ name: 'test', command: 'pnpm test', exitCode: 1, output }],
      allPassed: false,
    });

    expect(a.get(sessionId).structuralResult?.commands[0]?.output).toBe(output);
    const stored = new ExecuteSessionRepository(storeB).reconstruct(sessionId)!.structuralResult!
      .commands[0]!.output;
    expect(stored).not.toContain(token);
    expect(stored).not.toContain('a'.repeat(10));
    expect(stored.endsWith('FAIL at the end')).toBe(true);
    expect(stored.length).toBeLessThan(2100);
  });

  it('구형 payload로 쌓인 이벤트도 빠진 값을 채워 재구성한다', () => {
    const s = spec();
    const { sessionId } = a.create(s);
    storeA.append('execute', sessionId, EventType.EXECUTE_DRIFT_MEASURED, {
      taskId: 'task-0',
      overall: 0.4,
      thresholdExceeded: false,
      dimensions: [{ name: 'goal', score: 0.4, detail: 'd' }],
    });
    // 임계값을 낮춰 둔 세션이었다면 점수가 낮아도 넘었다고 기록돼 있다
    storeA.append('execute', sessionId, EventType.EXECUTE_DRIFT_MEASURED, {
      taskId: 'task-1',
      overall: 0.1,
      thresholdExceeded: true,
      dimensions: [{ name: 'goal', score: 0.1, detail: 'd' }],
    });
    storeA.append('execute', sessionId, EventType.EXECUTE_DRIFT_MEASURED, {
      taskId: 'task-2',
      overall: 0.8,
      thresholdExceeded: false,
      dimensions: [{ name: 'goal', score: 0.8, detail: 'd' }],
    });
    storeA.append('execute', sessionId, EventType.EVALUATE_STRUCTURAL_COMPLETED, {
      allPassed: false,
      commands: [{ name: 'test', exitCode: 1 }],
    });
    storeA.append('execute', sessionId, EventType.EVALUATE_SHORT_CIRCUITED, { reason: 'r' });
    storeA.append('execute', sessionId, EventType.ROLE_MATCH_COMPLETED, { taskId: 'task-0' });

    const session = b.get(sessionId);
    expect(session.driftHistory[0]).toMatchObject({ status: 'WARNING', threshold: 0.6 });
    expect(session.driftHistory[1]?.status).toBe('CRITICAL');
    expect(session.driftHistory[1]?.hint).not.toBe('');
    expect(session.driftHistory[2]?.status).toBe('WARNING');
    expect(session.structuralResult?.commands[0]).toMatchObject({ name: 'test', exitCode: 1 });
    expect(session.evaluationResult?.verifications).toHaveLength(s.acceptanceCriteria.length);
    expect(session.evaluationResult?.verifications[0]?.gaps).toEqual(['r']);
    expect(session.roleMatches).toBeUndefined();
  });

  it('spawn 뒤 같은 DB로 다시 띄워도 하위 태스크가 남고 가짜 태스크 결과가 안 생긴다', () => {
    const { sessionId } = a.create(spec());
    const subTasks = ['sub-1', 'sub-2'].map((id) => ({
      taskId: `task-0-${id}`,
      parentTaskId: 'task-0',
      title: id,
      description: 'd',
      inheritedContext: '',
      dependsOn: [],
      status: 'pending' as const,
      createdAt: new Date().toISOString(),
    }));
    a.addTaskResult(sessionId, done('task-0'));
    a.addSubTasks(sessionId, subTasks);

    const restarted = new ExecuteSessionManager(storeB);
    restarted.loadFromStore();
    const session = restarted.get(sessionId);
    expect(session.subTasks).toEqual(subTasks);
    expect(session.taskResults.map((r) => r.taskId)).toEqual(['task-0']);
  });

  it('subTasks를 안 싣던 이전 spawn 이벤트도 태스크 결과로 읽지 않는다', () => {
    const { sessionId } = a.create(spec());
    storeA.append('execute', sessionId, EventType.EXECUTE_TASK_COMPLETED, {
      type: 'sub_tasks_spawned',
      parentTaskId: 'task-0',
      count: 1,
      taskIds: ['task-0-sub-1'],
    });

    const session = b.get(sessionId);
    expect(session.taskResults).toEqual([]);
    expect(session.completedTaskIds).toEqual([]);
  });
  it('열린 사람 판단 게이트가 다른 인스턴스와 재시작 뒤에도 그대로 보인다', () => {
    const { sessionId } = a.create(spec());
    a.startExecution(sessionId);
    const opened = gate();
    a.openHumanGate(sessionId, opened, { triedPersonas: ['multistability'], bestScore: 0.5 });

    const seen = b.get(sessionId);
    expect(seen.status).toBe('awaiting_human');
    expect(seen.humanGates).toEqual([opened]);

    const restarted = new ExecuteSessionManager(storeB);
    restarted.loadFromStore();
    expect(comparable(restarted.get(sessionId))).toEqual(comparable(a.get(sessionId)));
  });

  it('다른 인스턴스가 해소한 게이트를 낡은 캐시 위에서 다시 열지 않는다', () => {
    const { sessionId } = a.create(spec());
    a.startExecution(sessionId);
    const opened = gate();
    a.openHumanGate(sessionId, opened, { triedPersonas: [], bestScore: 0.5 });
    a.get(sessionId); // a 캐시에 열린 게이트가 올라간다

    b.resolveHumanGate(
      sessionId,
      opened.gateId,
      { optionId: 'patch_spec', decision: 'd', rationale: 'r', resolvedAt: '' },
      true,
    );

    const session = a.get(sessionId);
    expect(session.status).toBe('executing');
    expect(session.humanGates[0]!.status).toBe('resolved');
    // 해소된 걸 알았으므로 새 게이트를 열 수 있다
    expect(() =>
      a.openHumanGate(sessionId, gate(), { triedPersonas: [], bestScore: 0.5 }),
    ).not.toThrow();
    expect(b.get(sessionId).humanGates.map((g) => g.status)).toEqual(['resolved', 'open']);
  });

  it('되감기와 완료 검증 실패 이벤트가 섞여도 재시작 뒤 게이트와 기준 트리가 함께 복원된다', () => {
    const { sessionId } = a.create(spec());
    a.rewindPlanning(sessionId, 0, { reason: 'cycle' });
    a.startExecution(sessionId, {
      repoRoot: '/repo',
      baseline: { repoRoot: '/repo', cwd: '/repo', head: 'abc', dirty: {}, capturedAt: 't' },
    });
    // 완료 검증 실패는 실행 오케스트레이터가 스토어에 직접 남긴다
    storeA.append('execute', sessionId, EventType.EXECUTE_TASK_VERIFICATION_FAILED, {
      taskId: 'task-0',
      files: [{ path: 'a.ts', status: 'unchanged' }],
    });
    a.addTaskResult(sessionId, done('task-0'));
    const opened = gate();
    a.openHumanGate(sessionId, opened, { triedPersonas: [], bestScore: 0.5 });

    const restarted = new ExecuteSessionManager(storeB);
    restarted.loadFromStore();
    const restored = restarted.get(sessionId);
    expect(comparable(restored)).toEqual(comparable(a.get(sessionId)));
    expect(restored.status).toBe('awaiting_human');
    expect(restored.workingTreeBaseline?.head).toBe('abc');
    expect(restored.completedTaskIds).toEqual(['task-0']);

    restarted.resolveHumanGate(
      sessionId,
      opened.gateId,
      { optionId: 'manual_task', decision: 'd', rationale: 'r', resolvedAt: '' },
      true,
    );
    const again = new ExecuteSessionManager(storeA);
    again.loadFromStore();
    const resumed = again.get(sessionId);
    expect(resumed.status).toBe('executing');
    expect(resumed.humanGates[0]!.status).toBe('resolved');
    expect(resumed.workingTreeBaseline?.head).toBe('abc');
  });

  it('게이트 이벤트도 캐시 이벤트 수에 잡혀 같은 인스턴스에서는 replay하지 않는다', () => {
    const { sessionId } = a.create(spec());
    a.startExecution(sessionId);
    const opened = gate();
    const replay = vi.spyOn(storeA, 'replay');

    a.openHumanGate(sessionId, opened, { triedPersonas: [], bestScore: 0.5 });
    a.resolveHumanGate(
      sessionId,
      opened.gateId,
      { optionId: 'abort', decision: 'd', rationale: 'r', resolvedAt: '' },
      false,
    );
    a.terminate(sessionId, 'human_escalation');
    a.get(sessionId);
    expect(replay).not.toHaveBeenCalled();
  });
});
