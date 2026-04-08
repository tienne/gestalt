import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PassthroughExecuteEngine } from '../../../src/execute/passthrough-engine.js';
import { EventStore } from '../../../src/events/store.js';
import { measureDrift } from '../../../src/execute/drift-detector.js';
import { isOk } from '../../../src/core/result.js';
import { existsSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type {
  Spec,
  FigureGroundResult,
  ClosureResult,
  ProximityResult,
  ContinuityResult,
  TaskExecutionResult,
  AtomicTask,
} from '../../../src/core/types.js';

function createTestSpec(): Spec {
  return {
    version: '1.0.0',
    goal: 'Build a user authentication system with JWT tokens',
    constraints: ['Must use JWT', 'Must support OAuth2'],
    acceptanceCriteria: [
      'Users can register with email and password',
      'Users can login and receive JWT token',
    ],
    ontologySchema: {
      entities: [
        { name: 'User', description: 'System user', attributes: ['email', 'password', 'role'] },
        { name: 'Token', description: 'JWT token', attributes: ['accessToken', 'refreshToken'] },
      ],
      relations: [
        { from: 'User', to: 'Token', type: 'has_many' },
      ],
    },
    gestaltAnalysis: [
      { principle: 'closure' as const, finding: 'Auth needs token refresh', confidence: 0.9 },
    ],
    metadata: {
      specId: randomUUID(),
      interviewSessionId: randomUUID(),
      resolutionScore: 0.85,
      generatedAt: new Date().toISOString(),
    },
  };
}

const dummyTask: AtomicTask = {
  taskId: 'task-0',
  title: 'Setup user model',
  description: 'Create User entity with email and password',
  sourceAC: [0],
  isImplicit: false,
  estimatedComplexity: 'low',
  dependsOn: [],
};

describe('Drift Detector (measureDrift)', () => {
  it('returns lower drift for output aligned with spec than for unrelated output', () => {
    const spec = createTestSpec();
    const alignedResult: TaskExecutionResult = {
      taskId: 'task-0',
      status: 'completed',
      output: 'Created User authentication system with JWT tokens, email and password registration',
      artifacts: ['src/user.ts'],
    };
    const unrelatedResult: TaskExecutionResult = {
      taskId: 'task-0',
      status: 'completed',
      output: 'Implemented weather forecast dashboard with chart visualizations and map integration',
      artifacts: ['src/weather.ts'],
    };

    const alignedDrift = measureDrift(spec, dummyTask, alignedResult, 0.3);
    const unrelatedDrift = measureDrift(spec, dummyTask, unrelatedResult, 0.3);

    expect(alignedDrift.taskId).toBe('task-0');
    expect(alignedDrift.overall).toBeLessThan(unrelatedDrift.overall);
    expect(alignedDrift.dimensions).toHaveLength(3);
    expect(alignedDrift.dimensions.map((d) => d.name)).toEqual(['goal', 'constraint', 'ontology']);
  });

  it('returns high drift for output unrelated to spec', () => {
    const spec = createTestSpec();
    const result: TaskExecutionResult = {
      taskId: 'task-0',
      status: 'completed',
      output: 'Implemented weather forecast dashboard with chart visualizations and map integration',
      artifacts: ['src/weather.ts'],
    };

    const drift = measureDrift(spec, dummyTask, result, 0.3);
    expect(drift.overall).toBeGreaterThan(0.3);
    expect(drift.thresholdExceeded).toBe(true);
  });

  it('handles empty constraints gracefully', () => {
    const spec = { ...createTestSpec(), constraints: [] };
    const result: TaskExecutionResult = {
      taskId: 'task-0',
      status: 'completed',
      output: 'Some output',
      artifacts: [],
    };

    const drift = measureDrift(spec, dummyTask, result, 0.3);
    const constraintDim = drift.dimensions.find((d) => d.name === 'constraint')!;
    expect(constraintDim.score).toBe(0);
    expect(constraintDim.detail).toContain('No constraints');
  });

  it('handles empty ontology gracefully', () => {
    const spec = {
      ...createTestSpec(),
      ontologySchema: { entities: [], relations: [] },
    };
    const result: TaskExecutionResult = {
      taskId: 'task-0',
      status: 'completed',
      output: 'Some output',
      artifacts: [],
    };

    const drift = measureDrift(spec, dummyTask, result, 0.3);
    const ontologyDim = drift.dimensions.find((d) => d.name === 'ontology')!;
    expect(ontologyDim.score).toBe(0);
    expect(ontologyDim.detail).toContain('No ontology');
  });

  it('respects configurable threshold', () => {
    const spec = createTestSpec();
    const result: TaskExecutionResult = {
      taskId: 'task-0',
      status: 'completed',
      output: 'Implemented user login with authentication',
      artifacts: [],
    };

    const driftLow = measureDrift(spec, dummyTask, result, 0.1);
    const driftHigh = measureDrift(spec, dummyTask, result, 0.9);

    // Same score, different threshold crossing
    expect(driftLow.overall).toBe(driftHigh.overall);
    // With low threshold, more likely to exceed
    expect(driftLow.thresholdExceeded).not.toBe(false); // may or may not exceed based on content
    expect(driftHigh.thresholdExceeded).toBe(false); // very high threshold, unlikely to exceed
  });
});

describe('Drift Detection in Engine', () => {
  let store: EventStore;
  let engine: PassthroughExecuteEngine;
  let dbPath: string;

  beforeEach(() => {
    dbPath = `.gestalt-test/drift-engine-${randomUUID()}.db`;
    store = new EventStore(dbPath);
    engine = new PassthroughExecuteEngine(store);
  });

  afterEach(() => {
    store.close();
    try {
      if (existsSync(dbPath)) rmSync(dbPath);
      if (existsSync(dbPath + '-wal')) rmSync(dbPath + '-wal');
      if (existsSync(dbPath + '-shm')) rmSync(dbPath + '-shm');
    } catch { /* ignore */ }
  });

  function setupExecutingSession(): string {
    const spec = createTestSpec();
    const startResult = engine.start(spec);
    if (!startResult.ok) throw new Error('start failed');
    const sessionId = startResult.value.session.sessionId;

    const fg: FigureGroundResult = {
      principle: 'figure_ground',
      classifiedACs: [
        { acIndex: 0, acText: spec.acceptanceCriteria[0]!, classification: 'figure', priority: 'critical', reasoning: 'Core' },
        { acIndex: 1, acText: spec.acceptanceCriteria[1]!, classification: 'figure', priority: 'high', reasoning: 'Core' },
      ],
    };
    const closure: ClosureResult = {
      principle: 'closure',
      atomicTasks: [
        { taskId: 'task-0', title: 'User model', description: 'Create User entity', sourceAC: [0], isImplicit: false, estimatedComplexity: 'low', dependsOn: [] },
        { taskId: 'task-1', title: 'Login endpoint', description: 'POST /login JWT', sourceAC: [1], isImplicit: false, estimatedComplexity: 'medium', dependsOn: ['task-0'] },
      ],
    };
    const proximity: ProximityResult = {
      principle: 'proximity',
      taskGroups: [
        { groupId: 'group-0', name: 'Auth', domain: 'auth', taskIds: ['task-0', 'task-1'], reasoning: 'Auth tasks' },
      ],
    };
    const continuity: ContinuityResult = {
      principle: 'continuity',
      dagValidation: {
        isValid: true, hasCycles: false, hasConflicts: false,
        topologicalOrder: ['task-0', 'task-1'],
        criticalPath: ['task-0', 'task-1'],
      },
    };

    engine.planStep(sessionId, fg);
    engine.planStep(sessionId, closure);
    engine.planStep(sessionId, proximity);
    engine.planStep(sessionId, continuity);
    engine.planComplete(sessionId);
    engine.startExecution(sessionId);

    return sessionId;
  }

  it('includes driftScore in submitTaskResult response', () => {
    const sessionId = setupExecutingSession();

    const result = engine.submitTaskResult(sessionId, {
      taskId: 'task-0',
      status: 'completed',
      output: 'Created User authentication model with email password JWT tokens',
      artifacts: ['src/user.ts'],
    });

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value.driftScore).toBeDefined();
      expect(result.value.driftScore!.taskId).toBe('task-0');
      expect(result.value.driftScore!.dimensions).toHaveLength(3);
    }
  });

  it('records drift history on session', () => {
    const sessionId = setupExecutingSession();

    engine.submitTaskResult(sessionId, {
      taskId: 'task-0',
      status: 'completed',
      output: 'Created user authentication with JWT',
      artifacts: [],
    });

    const session = engine.getSession(sessionId);
    expect(session.driftHistory).toHaveLength(1);
    expect(session.driftHistory[0]!.taskId).toBe('task-0');
  });

  it('does not measure drift for failed tasks', () => {
    const sessionId = setupExecutingSession();

    const result = engine.submitTaskResult(sessionId, {
      taskId: 'task-0',
      status: 'failed',
      output: 'Build error',
      artifacts: [],
    });

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value.driftScore).toBeUndefined();
    }

    const session = engine.getSession(sessionId);
    expect(session.driftHistory).toHaveLength(0);
  });

  it('returns retrospectiveContext when drift exceeds threshold', () => {
    const sessionId = setupExecutingSession();

    // Submit a task with highly drifted output (unrelated to spec)
    const result = engine.submitTaskResult(
      sessionId,
      {
        taskId: 'task-0',
        status: 'completed',
        output: 'Implemented weather forecast dashboard with chart visualizations and map integration using React and D3',
        artifacts: ['src/weather.ts'],
      },
      0.05, // Very low threshold to force drift detection
    );

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value.driftScore).toBeDefined();
      expect(result.value.driftScore!.thresholdExceeded).toBe(true);
      expect(result.value.retrospectiveContext).toBeDefined();
      expect(result.value.retrospectiveContext!.retrospectivePrompt).toContain('Drift Retrospective');
      expect(result.value.retrospectiveContext!.driftScore).toBeDefined();
    }
  });

  it('does not return retrospectiveContext when drift is within threshold', () => {
    const sessionId = setupExecutingSession();

    const result = engine.submitTaskResult(
      sessionId,
      {
        taskId: 'task-0',
        status: 'completed',
        output: 'Created User authentication system with JWT tokens email password role',
        artifacts: ['src/user.ts'],
      },
      0.99, // Very high threshold — no drift alert
    );

    expect(isOk(result)).toBe(true);
    if (result.ok) {
      expect(result.value.driftScore).toBeDefined();
      expect(result.value.driftScore!.thresholdExceeded).toBe(false);
      expect(result.value.retrospectiveContext).toBeUndefined();
    }
  });
});
