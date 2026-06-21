import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  Spec,
  AtomicTask,
  TaskExecutionResult,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
} from '../../../src/core/types.js';

// codeGraphEngine 싱글톤 mock — passthrough-engine.ts가 import하는 경로와 동일해야 함
vi.mock('../../../src/code-graph/index.js', () => ({
  codeGraphEngine: {
    dbExists: vi.fn().mockReturnValue(false),
    searchByKeywords: vi.fn().mockReturnValue([]),
    blastRadius: vi.fn().mockReturnValue({ impactedFiles: [] }),
    build: vi.fn(),
    close: vi.fn(),
  },
}));

import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { buildTaskExecutionPrompt } from '../../../src/execute/prompts.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function createTestSpec(): Spec {
  return {
    version: '1.0.0',
    goal: 'Build a user authentication system',
    constraints: ['Must use JWT'],
    acceptanceCriteria: [
      'Users can register with email/password',
      'Users can login and receive JWT',
    ],
    ontologySchema: {
      entities: [{ name: 'User', description: 'System user', attributes: ['email', 'password'] }],
      relations: [],
    },
    gestaltAnalysis: [],
    metadata: {
      specId: randomUUID(),
      interviewSessionId: randomUUID(),
      resolutionScore: 0.85,
      generatedAt: new Date().toISOString(),
    },
  };
}

function createFigureGroundResult(): FigureGroundResult {
  return {
    principle: 'figure_ground',
    classifiedACs: [
      {
        acIndex: 0,
        acText: 'Users can register with email/password',
        classification: 'figure',
        priority: 'critical',
        reasoning: 'Core',
      },
      {
        acIndex: 1,
        acText: 'Users can login and receive JWT',
        classification: 'figure',
        priority: 'critical',
        reasoning: 'Core',
      },
    ],
  };
}

function createClosureResult(): ClosureResult {
  return {
    principle: 'closure',
    atomicTasks: [
      {
        taskId: 'task-0',
        title: 'Rename legacy file',
        description: 'rename old auth file for cleanup',
        sourceAC: [0],
        isImplicit: true,
        estimatedComplexity: 'low',
        dependsOn: [],
      },
      {
        taskId: 'task-1',
        title: 'Register endpoint',
        description: 'create POST /register handler',
        sourceAC: [0],
        isImplicit: false,
        estimatedComplexity: 'medium',
        dependsOn: ['task-0'],
      },
      {
        taskId: 'task-2',
        title: 'Design security architecture',
        description: 'design the JWT security architecture',
        sourceAC: [1],
        isImplicit: false,
        estimatedComplexity: 'high',
        dependsOn: ['task-0'],
      },
    ],
  };
}

function createProximityResult(): ProximityResult {
  return {
    principle: 'proximity',
    taskGroups: [
      {
        groupId: 'group-0',
        name: 'Auth',
        domain: 'authentication',
        taskIds: ['task-0', 'task-1', 'task-2'],
        reasoning: 'All auth',
      },
    ],
  };
}

function createContinuityResult(): ContinuityResult {
  return {
    principle: 'continuity',
    dagValidation: {
      isValid: true,
      hasCycles: false,
      hasConflicts: false,
      topologicalOrder: ['task-0', 'task-1', 'task-2'],
      criticalPath: ['task-0', 'task-1', 'task-2'],
    },
  };
}

function completePlanningPhase(engine: PassthroughExecuteEngine, spec: Spec): string {
  const startResult = engine.start(spec);
  if (!startResult.ok) throw new Error('start failed');
  const { sessionId } = startResult.value.session;
  engine.planStep(sessionId, createFigureGroundResult());
  engine.planStep(sessionId, createClosureResult());
  engine.planStep(sessionId, createProximityResult());
  engine.planStep(sessionId, createContinuityResult());
  return sessionId;
}

// ─── planComplete: model 힌트 자동 할당 ───────────────────────────────────────

describe('planComplete — model 힌트 자동 할당', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/model-hint-int-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
    vi.clearAllMocks();
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch {
      /* ignore */
    }
  });

  it('ExecutionPlan의 모든 atomicTask에 model이 채워진다 (undefined 없음)', () => {
    const sessionId = completePlanningPhase(engine, createTestSpec());
    const result = engine.planComplete(sessionId);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const { atomicTasks } = result.value.executionPlan;
      expect(atomicTasks.length).toBe(3);
      for (const t of atomicTasks) {
        expect(t.model).toBeDefined();
      }
    }
  });

  it('복잡도·키워드에 맞는 model이 할당된다', () => {
    const sessionId = completePlanningPhase(engine, createTestSpec());
    const result = engine.planComplete(sessionId);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const tasks = result.value.executionPlan.atomicTasks;
      const byId = (id: string) => tasks.find((t) => t.taskId === id)!;

      // task-0: rename + low → haiku
      expect(byId('task-0').model).toBe('haiku');
      // task-1: medium 일반 구현 → sonnet
      expect(byId('task-1').model).toBe('sonnet');
      // task-2: design/security 키워드 + high → opus
      expect(byId('task-2').model).toBe('opus');
    }
  });
});

// ─── buildTaskExecutionPrompt: model 힌트 섹션 ────────────────────────────────

describe('buildTaskExecutionPrompt — model 힌트 섹션', () => {
  const spec = createTestSpec();
  const completed: TaskExecutionResult[] = [];

  function makeTask(model: AtomicTask['model']): AtomicTask {
    return {
      taskId: 'task-X',
      title: 'Do something',
      description: 'a task',
      sourceAC: [0],
      isImplicit: false,
      estimatedComplexity: 'medium',
      dependsOn: [],
      ...(model ? { model } : {}),
    };
  }

  it('model 힌트가 있으면 해당 model + Agent tool 안내가 포함된다', () => {
    const prompt = buildTaskExecutionPrompt(makeTask('opus'), spec, completed, []);
    expect(prompt).toContain('model: "opus"');
    expect(prompt).toContain('Agent tool');
  });

  it('model 힌트가 haiku면 model: "haiku"가 포함된다', () => {
    const prompt = buildTaskExecutionPrompt(makeTask('haiku'), spec, completed, []);
    expect(prompt).toContain('model: "haiku"');
    expect(prompt).toContain('Agent tool');
  });

  it('model 힌트가 없으면 현재 세션 직접 실행 안내가 포함된다', () => {
    const prompt = buildTaskExecutionPrompt(makeTask(undefined), spec, completed, []);
    expect(prompt).toContain('directly');
    expect(prompt).not.toContain('Agent tool');
  });

  it('model 섹션은 항상 "Model hint" 라벨을 포함한다', () => {
    expect(buildTaskExecutionPrompt(makeTask('sonnet'), spec, completed, [])).toContain(
      'Model hint',
    );
    expect(buildTaskExecutionPrompt(makeTask(undefined), spec, completed, [])).toContain(
      'Model hint',
    );
  });
});
